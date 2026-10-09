import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AGENT_TOOLS, type AgentModel, type ModelMessage } from './agent.ts';
import { providerTools, providerToolDefinitions } from './agent-provider-tools.ts';

export type CodexCliOptions = {
  model: string;
  reasoningEffort: 'medium';
  binary?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};
const MAX_OUTPUT = 4_000_000;
const MAX_IMAGE_BYTES = 12_000_000;
export class CodexCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexCliError';
  }
}

/** Credentials remain owned by Codex. No provider/API-key environment is inherited. */
export function codexChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'HOME',
    'CODEX_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

function runBinary(
  binary: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    input?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    inspectEvents?: boolean;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new CodexCliError('Codex request cancelled.'));
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      size = 0,
      lineBuffer = '',
      failure: Error | undefined;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const fail = (message: string) => {
      if (!failure) failure = new CodexCliError(message);
      kill();
    };
    const timer = setTimeout(() => fail('Codex request timed out.'), options.timeoutMs);
    const abort = () => fail('Codex request cancelled.');
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    const inspectLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        // This exact startup diagnostic reports the host was disabled, not a
        // native tool invocation. Never permit other errors or native items.
        const disabledHostDiagnostic =
          event.type === 'item.completed' &&
          event.item?.type === 'error' &&
          event.item?.message ===
            'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
        const type = event.item?.type;
        if (type && !['agent_message', 'reasoning'].includes(type) && !disabledHostDiagnostic) {
          const kind = typeof type === 'string' && /^[a-z_]{1,50}$/.test(type) ? type : 'unknown';
          fail(
            kind === 'error'
              ? 'Codex reported a configuration or model error.'
              : `Codex attempted a disabled native capability (${kind}).`,
          );
        }
        if (event.type === 'turn.failed' || event.type === 'error')
          fail('Codex could not complete the design request. Check ChatGPT login and quota.');
      } catch {
        fail('Codex returned an invalid event stream.');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) return fail('Codex output exceeded the allowed size.');
      const text = chunk.toString('utf8');
      stdout += text;
      if (!options.inspectEvents) return;
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) inspectLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) fail('Codex output exceeded the allowed size.');
    });
    child.on('error', () => {
      failure = new CodexCliError('Codex CLI could not start. Check that Codex is installed.');
    });
    child.on('close', (code) => {
      if (options.inspectEvents) inspectLine(lineBuffer);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new CodexCliError('Codex CLI failed. Check ChatGPT login, model access and quota.'));
      else resolve(stdout);
    });
    child.stdin.end(options.input || '');
  });
}

export async function codexCliStatus(
  options: Pick<CodexCliOptions, 'binary' | 'env'> = {},
): Promise<{ connected: boolean; reason?: string }> {
  return loginStatusStderr(options);
}

function loginStatusStderr(
  options: Pick<CodexCliOptions, 'binary' | 'env'>,
): Promise<{ connected: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn(options.binary || 'codex', ['login', 'status'], {
      env: codexChildEnvironment(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        connected
          ? { connected }
          : { connected: false, reason: 'Sign in with ChatGPT using codex login.' },
      );
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 10_000);
    const capture = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 16_000) {
        child.kill('SIGKILL');
        finish(false);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', () => finish(false));
    child.on('close', (code) =>
      finish(code === 0 && /Logged in using ChatGPT/i.test(output) && !/API key/i.test(output)),
    );
  });
}

/** Project Zod draft-7 schemas to the provider's strict output subset.
 * Literal constraints become singleton enums. Homogeneous fixed tuples retain
 * their item type and exact cardinality. Runtime Zod still enforces every bound.
 */
export function strictOutputSchema(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CodexCliError('Codex received an unsupported structured output schema.');
  const supported = new Set([
    'type',
    'description',
    'enum',
    'anyOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minItems',
    'maxItems',
  ]);
  const result: any = {};
  for (const [key, child] of Object.entries(value)) {
    if (['$schema', 'default', 'additionalItems', 'const'].includes(key)) continue;
    if (key === 'oneOf' || key === 'anyOf') result.anyOf = (child as any[]).map(strictOutputSchema);
    else if (key === 'properties')
      result.properties = Object.fromEntries(
        Object.entries(child as any).map(([name, schema]) => [name, strictOutputSchema(schema)]),
      );
    else if (key === 'items') {
      if (Array.isArray(child)) {
        const items = child.map(strictOutputSchema);
        // Current camera XYZ tuples are homogeneous; do not silently widen a
        // future positional tuple with different semantic item constraints.
        if (
          !items.length ||
          items.some((item) => JSON.stringify(item) !== JSON.stringify(items[0])) ||
          value.additionalItems !== false
        )
          throw new CodexCliError('Codex received an unsupported positional tuple schema.');
        result.items = items[0];
        result.minItems = child.length;
        result.maxItems = child.length;
      } else result.items = strictOutputSchema(child);
    } else if (supported.has(key)) result[key] = child;
    else throw new CodexCliError('Codex received an unsupported structured output schema keyword.');
  }
  if (Object.hasOwn(value, 'const')) result.enum = [value.const];
  if (result.properties) {
    const required = new Set(value.required || []);
    for (const key of Object.keys(result.properties))
      if (!required.has(key))
        result.properties[key] = { anyOf: [result.properties[key], { type: 'null' }] };
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  return result;
}
function omitOptionalNulls(value: any, schema: any): any {
  if (Array.isArray(value))
    return value.map((child, index) =>
      omitOptionalNulls(child, Array.isArray(schema?.items) ? schema.items[index] : schema?.items),
    );
  if (!value || typeof value !== 'object') return value;
  const variants = schema?.anyOf || schema?.oneOf || [];
  const variant = variants.find(
    (candidate: any) =>
      candidate.properties &&
      Object.entries(candidate.properties).every(
        ([key, field]: [string, any]) => field.const === undefined || value[key] === field.const,
      ),
  );
  const active = variant || schema;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => child !== null || active?.required?.includes(key))
      .map(([key, child]) => [key, omitOptionalNulls(child, active?.properties?.[key])]),
  );
}

async function prepareMessages(messages: ModelMessage[], directory: string) {
  const images: string[] = [];
  const transcript = [];
  for (const message of messages) {
    const parts: any[] = [];
    if (Array.isArray(message.content))
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push(part);
          continue;
        }
        const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
          part.image_url.url,
        );
        if (!match || match[2].length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3))
          throw new CodexCliError('Codex requires a supported local PNG or JPEG image.');
        const bytes = Buffer.from(match[2], 'base64');
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if ((match[1] === 'png' && !png) || (match[1] !== 'png' && !jpeg))
          throw new CodexCliError('Codex image data is invalid.');
        const filename = `image-${images.length + 1}.${match[1] === 'png' ? 'png' : 'jpg'}`;
        const path = join(directory, filename);
        await writeFile(path, bytes, { mode: 0o600 });
        images.push(path);
        parts.push({ type: 'image_attachment', attachmentIndex: images.length, filename });
      }
    const content = Array.isArray(message.content) ? parts : message.content;
    transcript.push({ ...message, content });
  }
  return { images, transcript };
}

export function codexCliAgentModel(options: CodexCliOptions): AgentModel {
  if (options.model !== 'gpt-6.1-sol' || options.reasoningEffort !== 'medium')
    throw new CodexCliError('The Codex backend requires gpt-6.1-sol with medium reasoning.');
  const binary = options.binary || 'codex';
  const env = codexChildEnvironment(options.env);
  return {
    async complete(messages, signal, toolNames, criticObjectiveIds, builderPhase) {
      const directory = await mkdtemp(join(tmpdir(), 'terrain-codex-'));
      try {
        const tools = providerTools(AGENT_TOOLS, toolNames, criticObjectiveIds, builderPhase);
        if (!tools.length || (toolNames && tools.length !== new Set(toolNames).size))
          throw new CodexCliError('Codex received an unavailable architectural tool.');
        if (
          toolNames?.includes('submit_design_critique') &&
          (!criticObjectiveIds?.length ||
            criticObjectiveIds.length > 12 ||
            new Set(criticObjectiveIds).size !== criticObjectiveIds.length ||
            criticObjectiveIds.some((id) => typeof id !== 'string' || !id.length || id.length > 60))
        )
          throw new CodexCliError('Codex critic objective manifest is invalid.');
        const definitions = providerToolDefinitions(tools);
        const schema = strictOutputSchema({
          type: 'object',
          additionalProperties: false,
          properties: {
            calls: {
              type: 'array',
              minItems: 1,
              maxItems: 12,
              items: {
                anyOf: definitions.map((tool) => ({
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', enum: [tool.function.name] },
                    arguments: tool.function.parameters,
                  },
                  required: ['name', 'arguments'],
                })),
              },
            },
            content: { type: ['string', 'null'] },
          },
          required: ['calls', 'content'],
        });
        const schemaPath = join(directory, 'response-schema.json'),
          outputPath = join(directory, 'response.json'),
          catalogPath = join(directory, 'model-catalog.json');
        await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
        // Read bundled metadata only, never credentials or a remote model catalog.
        const rawCatalog = await runBinary(binary, ['debug', 'models', '--bundled'], {
          env,
          signal,
          timeoutMs: 10_000,
        });
        const catalog = JSON.parse(rawCatalog);
        const model = catalog.models?.find((item: any) => item.slug === options.model);
        if (!model)
          throw new CodexCliError('Installed Codex does not include the requested model metadata.');
        // Removes patch and shell tools at registration, independently of prompting.
        await writeFile(
          catalogPath,
          JSON.stringify({
            models: [
              {
                ...model,
                shell_type: 'disabled',
                apply_patch_tool_type: null,
                experimental_supported_tools: [],
                model_messages: null,
                base_instructions:
                  'You are the architectural response model. Follow the serialized system conversation and return only the required JSON response.',
              },
            ],
          }),
          { mode: 0o600 },
        );
        const prepared = await prepareMessages(messages, directory);
        const prompt = JSON.stringify({
          instruction:
            'Act only as the architectural model for this serialized conversation. Preserve message roles and tool history. Return the required JSON semantic calls; the application executes them. Null optional arguments mean omit that field. Attached images are ordered exactly by attachmentIndex in the conversation.',
          tools: definitions,
          conversation: prepared.transcript,
        });
        const args = [
          'exec',
          '--ignore-user-config',
          '--ignore-rules',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '-C',
          directory,
          '--model',
          options.model,
          '--json',
          '--color',
          'never',
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
        ];
        for (const [key, value] of Object.entries({
          forced_login_method: 'chatgpt',
          model_provider: 'openai',
          model_reasoning_effort: options.reasoningEffort,
          model_catalog_json: catalogPath,
          web_search: 'disabled',
          mcp_servers: {},
          project_doc_max_bytes: 0,
          'skills.include_instructions': false,
          'skills.bundled.enabled': false,
          shell_environment_policy: { inherit: 'none' },
          check_for_update_on_startup: false,
        }))
          args.push(
            '-c',
            `${key}=${key === 'shell_environment_policy' ? '{inherit="none"}' : typeof value === 'object' ? '{}' : JSON.stringify(value)}`,
          );
        for (const feature of [
          'shell_tool',
          'unified_exec',
          'code_mode',
          'code_mode_host',
          'apps',
          'plugins',
          'hooks',
          'browser_use',
          'browser_use_external',
          'computer_use',
          'in_app_browser',
          'multi_agent',
          'multi_agent_v2',
          'view_image',
          'image_generation',
          'memories',
          'skill_search',
          'skill_mcp_dependency_install',
          'goals',
          'sleep_tool',
          'tool_suggest',
          'daemon_auto_start',
        ])
          args.push('--disable', feature);
        for (const path of prepared.images) args.push('--image', path);
        args.push('-');
        const events = await runBinary(binary, args, {
          env,
          cwd: directory,
          input: prompt,
          signal,
          timeoutMs: options.timeoutMs || 300_000,
          inspectEvents: true,
        });
        if ((await stat(outputPath)).size > MAX_OUTPUT)
          throw new CodexCliError('Codex output exceeded the allowed size.');
        const body = z
          .object({
            calls: z
              .array(
                z
                  .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })
                  .strict(),
              )
              .min(1)
              .max(12),
            content: z.string().max(20_000).nullable(),
          })
          .strict()
          .parse(JSON.parse(await readFile(outputPath, 'utf8')));
        const calls = body.calls.map((call) => {
          const tool = tools.find((tool) => tool.name === call.name);
          if (!tool) throw new CodexCliError('Codex returned an unavailable architectural tool.');
          const originalSchema = definitions.find(
            (definition) => definition.function.name === call.name,
          )!.function.parameters;
          const args = tool.schema.parse(omitOptionalNulls(call.arguments, originalSchema));
          if (call.name === 'submit_design_critique') {
            const ids = (args as any).observations.map((item: any) => item.objectiveId);
            if (new Set(ids).size !== criticObjectiveIds?.length)
              throw new CodexCliError('Codex critique did not cover the immutable objectives.');
          }
          return {
            id: `codex-${randomUUID()}`,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(args) },
          };
        });
        const completed = events
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .reverse()
          .find((event: any) => event.type === 'turn.completed');
        if (!completed) throw new CodexCliError('Codex did not report a completed model turn.');
        const token = (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
        return {
          calls,
          content: body.content,
          truncated: false,
          usage: {
            inputTokens: token(completed.usage?.input_tokens),
            outputTokens: token(completed.usage?.output_tokens),
            cost: null,
          },
        };
      } catch (error) {
        if (error instanceof CodexCliError) throw error;
        throw new CodexCliError('Codex returned an invalid structured design response.');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
