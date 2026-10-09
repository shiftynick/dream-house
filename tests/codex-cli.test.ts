import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  codexCliAgentModel,
  codexCliStatus,
  codexChildEnvironment,
  strictOutputSchema,
} from '../server/codex-cli.ts';
import { AGENT_TOOLS, type ModelMessage } from '../server/agent.ts';
import { providerTools, providerToolDefinitions } from '../server/agent-provider-tools.ts';

const disabledHostWarning = {
  type: 'item.completed',
  item: {
    type: 'error',
    message:
      'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.',
  },
};
async function mock(body: unknown, behavior = '') {
  const directory = await mkdtemp(join(tmpdir(), 'terrain-cli-test-'));
  const binary = join(directory, 'codex'),
    report = join(directory, 'report.json');
  await writeFile(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');
const a=process.argv.slice(2); const value=k=>a[a.indexOf(k)+1];
if(a[0]==='debug'){console.log(JSON.stringify({models:[{slug:'gpt-6.1-sol',shell_type:'unified_exec',apply_patch_tool_type:'freeform'}]}));process.exit(0)}
if(a[0]==='login'){console.error(${JSON.stringify(behavior === 'api' ? 'Logged in using API key SECRET' : 'Logged in using ChatGPT')});process.exit(0)}
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
const imagePaths=a.flatMap((v,i)=>v==='--image'?[a[i+1]]:[]);
const catalogArg=a.find(v=>v.startsWith('model_catalog_json='));
const catalog=JSON.parse(fs.readFileSync(JSON.parse(catalogArg.slice(catalogArg.indexOf('=')+1)),'utf8'));
fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({args:a,cwd:process.cwd(),prompt,env:process.env,schema:JSON.parse(fs.readFileSync(value('--output-schema'),'utf8')),images:imagePaths.map(p=>({path:p,base64:fs.readFileSync(p).toString('base64')})),catalog,pid:process.pid}));
${behavior === 'warning' ? `console.log(JSON.stringify(${JSON.stringify(disabledHostWarning)}));` : ''}
${behavior === 'hang' ? 'setInterval(()=>{},1000);' : behavior === 'failure' ? "console.error('SECRET_API_KEY raw private error');process.exit(1);" : behavior === 'native' ? "console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));setInterval(()=>{},1000);" : `fs.writeFileSync(value('--output-last-message'),${JSON.stringify(JSON.stringify(body))});console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:321,output_tokens:45}}));`}
${behavior.startsWith('trailing-') ? `process.stdout.write(${JSON.stringify(behavior === 'trailing-native' ? JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }) : behavior === 'trailing-error' ? JSON.stringify({ type: 'error', message: 'SECRET' }) : behavior === 'trailing-item-error' ? JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Unexpected private error' } }) : '{invalid')});` : ''}
});`,
    { mode: 0o700 },
  );
  const client = codexCliAgentModel({
    model: 'gpt-6.1-sol',
    reasoningEffort: 'medium',
    binary,
    timeoutMs: 1000,
    env: {
      ...process.env,
      OPENAI_API_KEY: 'SECRET_API_KEY',
      AI_GATEWAY_API_KEY: 'SECRET_GATEWAY',
      CODEX_PARENT_THREAD_ID: 'private-parent',
    },
  });
  return {
    directory,
    binary,
    report,
    client,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
const inspection = {
  calls: [{ name: 'inspect_design', arguments: { roomIds: null } }],
  content: null,
};
const messages: ModelMessage[] = [
  { role: 'system', content: 'Architectural instructions' },
  { role: 'user', content: 'Inspect this house' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'old', type: 'function', function: { name: 'inspect_design', arguments: '{}' } },
    ],
  },
  { role: 'tool', content: 'Prior result', tool_call_id: 'old' },
];

test('Codex subprocess retains roles/history, strict semantic schemas, isolation and subscription usage', async () => {
  const fixture = await mock(inspection);
  try {
    const result = await fixture.client.complete(messages, undefined, ['inspect_design']);
    assert.equal(result.calls[0].function.arguments, '{}');
    assert.deepEqual(result.usage, { inputTokens: 321, outputTokens: 45, cost: null });
    const report = JSON.parse(await readFile(fixture.report, 'utf8'));
    assert.deepEqual(JSON.parse(report.prompt).conversation, messages);
    assert.equal(report.env.OPENAI_API_KEY, undefined);
    assert.equal(report.env.AI_GATEWAY_API_KEY, undefined);
    assert.equal(report.env.CODEX_PARENT_THREAD_ID, undefined);
    assert.ok(report.args.includes('--ignore-user-config'));
    assert.ok(report.args.includes('--ignore-rules'));
    assert.ok(report.args.includes('--ephemeral'));
    assert.ok(report.args.includes('forced_login_method="chatgpt"'));
    assert.ok(report.args.includes('model_reasoning_effort="medium"'));
    assert.equal(report.catalog.models[0].shell_type, 'disabled');
    assert.equal(report.catalog.models[0].apply_patch_tool_type, null);
    assert.deepEqual(report.schema.properties.calls.items.anyOf[0].properties.arguments.required, [
      'roomIds',
    ]);
    assert.ok(!report.args.includes(report.prompt));
    assert.ok(report.cwd.startsWith(join(tmpdir(), 'terrain-codex-')));
    await assert.rejects(stat(report.cwd), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

test('Codex creates real ordered image attachments with provenance retained in transcript', async () => {
  const fixture = await mock(inspection);
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=';
  try {
    await fixture.client.complete(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'captureId: current-exterior' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
            { type: 'text', text: 'captureId: current-plan' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
          ],
        },
      ],
      undefined,
      ['inspect_design'],
    );
    const report = JSON.parse(await readFile(fixture.report, 'utf8'));
    assert.equal(report.images.length, 2);
    assert.notEqual(report.images[0].path, report.images[1].path);
    assert.equal(report.images[0].base64, png);
    assert.deepEqual(
      JSON.parse(report.prompt)
        .conversation[0].content.filter((part: any) => part.type === 'image_attachment')
        .map((part: any) => part.attachmentIndex),
      [1, 2],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('Codex rejects invalid arguments, unavailable tools and malformed JSON without exposing diagnostics', async () => {
  for (const [body, behavior] of [
    [{ calls: [{ name: 'inspect_design', arguments: { roomIds: 8 } }], content: null }, ''],
    [{ calls: [{ name: 'apply_operations', arguments: { operations: [] } }], content: null }, ''],
    [null, ''],
    [inspection, 'failure'],
  ] as const) {
    const fixture = await mock(body, behavior);
    try {
      await assert.rejects(
        fixture.client.complete(messages, undefined, ['inspect_design']),
        (error) => error instanceof Error && !error.message.includes('SECRET'),
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test('Codex native capability events fail closed and cancellation/timeout kills process and cleans workspace', async () => {
  for (const behavior of ['native', 'hang', 'cancel']) {
    const fixture = await mock(inspection, behavior === 'cancel' ? 'hang' : behavior);
    try {
      const abort = new AbortController();
      const pending = fixture.client.complete(messages, abort.signal, ['inspect_design']);
      if (behavior === 'cancel') setTimeout(() => abort.abort(), 150);
      await assert.rejects(pending, /disabled native|cancelled|timed out/);
      const report = JSON.parse(await readFile(fixture.report, 'utf8'));
      await assert.rejects(stat(report.cwd), /ENOENT/);
      assert.throws(() => process.kill(report.pid, 0));
    } finally {
      await fixture.cleanup();
    }
  }
});

test('Codex critic is constrained to the immutable manifest and rejects duplicate objective coverage', async () => {
  const args = {
    intentReview: {
      status: 'adequate',
      evidence: 'Requested intent covered',
      missingObjectives: [],
    },
    captureIds: ['current-exterior', 'current-plan'],
    observations: [
      { objectiveId: 'required-a', status: 'satisfactory', evidence: 'Visible' },
      { objectiveId: 'required-a', status: 'satisfactory', evidence: 'Visible' },
    ],
    limitations: [],
  };
  const fixture = await mock({
    calls: [{ name: 'submit_design_critique', arguments: args }],
    content: null,
  });
  try {
    await assert.rejects(
      fixture.client.complete(
        messages,
        undefined,
        ['submit_design_critique'],
        ['required-a', 'required-b'],
      ),
      /immutable objectives/,
    );
    const report = JSON.parse(await readFile(fixture.report, 'utf8'));
    const call = report.schema.properties.calls.items.anyOf[0];
    assert.deepEqual(call.properties.name.enum, ['submit_design_critique']);
    assert.deepEqual(
      call.properties.arguments.properties.observations.items.properties.objectiveId.enum,
      ['required-a', 'required-b'],
    );
    assert.equal(call.properties.arguments.properties.observations.minItems, 2);
    assert.equal(call.properties.arguments.properties.observations.maxItems, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('Shared provider phase schemas preserve clarification and canonical finalization', () => {
  const empty = providerTools(AGENT_TOOLS, ['finish_design'], undefined, 'empty-site')[0];
  assert.ok(
    empty.schema.safeParse({
      reply: 'Which site?',
      mode: 'question',
      questionReason: 'clarification',
    }).success,
  );
  assert.ok(
    !empty.schema.safeParse({ reply: 'Done', mode: 'apply', assessment: 'canonical' }).success,
  );
  const review = providerToolDefinitions(
    providerTools(AGENT_TOOLS, ['review_design', 'finish_design'], undefined, 'composition-review'),
  );
  assert.equal((review[0].function.parameters as any).properties.assessment.const, 'canonical');
  assert.equal((review[1].function.parameters as any).properties.assessment.const, 'canonical');
});

test('Codex login probe accepts ChatGPT and rejects API-key login; model and image errors fail locally', async () => {
  assert.deepEqual(
    codexChildEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'secret', AI_GATEWAY_API_KEY: 'secret' }),
    { PATH: '/bin' },
  );
  for (const behavior of ['', 'api']) {
    const fixture = await mock(inspection, behavior);
    try {
      assert.equal(
        (await codexCliStatus({ binary: fixture.binary })).connected,
        behavior !== 'api',
      );
      await assert.rejects(
        fixture.client.complete(
          [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://private/image.png' } }],
            },
          ],
          undefined,
          ['inspect_design'],
        ),
        /supported local PNG/,
      );
    } finally {
      await fixture.cleanup();
    }
  }
  assert.throws(
    () => codexCliAgentModel({ model: 'other', reasoningEffort: 'medium' }),
    /requires gpt-6.1-sol/,
  );
});

test('Codex permits only the exact disabled-host startup diagnostic before a valid completed turn', async () => {
  const fixture = await mock(inspection, 'warning');
  try {
    const result = await fixture.client.complete(messages, undefined, ['inspect_design']);
    assert.equal(result.calls[0].function.name, 'inspect_design');
    assert.equal(result.usage.cost, null);
  } finally {
    await fixture.cleanup();
  }
});

test('Codex inspects trailing JSONL without a final newline before accepting completed usage', async () => {
  for (const behavior of [
    'trailing-native',
    'trailing-error',
    'trailing-item-error',
    'trailing-malformed',
  ]) {
    const fixture = await mock(inspection, behavior);
    try {
      await assert.rejects(
        fixture.client.complete(messages, undefined, ['inspect_design']),
        /disabled native|could not complete|configuration or model error|invalid event stream/,
      );
      const report = JSON.parse(await readFile(fixture.report, 'utf8'));
      await assert.rejects(stat(report.cwd), /ENOENT/);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('Every builder phase and critic schema uses the strict provider subset with exact literals and camera tuples', () => {
  const allowed = new Set([
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
  const inspect = (schema: any) => {
    for (const key of Object.keys(schema))
      assert.ok(allowed.has(key), `unsupported provider keyword: ${key}`);
    if (schema.properties) {
      assert.deepEqual(schema.required, Object.keys(schema.properties));
      assert.equal(schema.additionalProperties, false);
      Object.values(schema.properties).forEach(inspect);
    }
    if (schema.items) {
      assert.ok(!Array.isArray(schema.items));
      inspect(schema.items);
    }
    if (schema.anyOf) schema.anyOf.forEach(inspect);
  };
  for (const phase of [undefined, 'empty-site', 'composition-review'] as const) {
    for (const definition of providerToolDefinitions(
      providerTools(AGENT_TOOLS, undefined, undefined, phase),
    ))
      inspect(strictOutputSchema(definition.function.parameters));
  }
  const critic = providerToolDefinitions(
    providerTools(AGENT_TOOLS, ['submit_design_critique'], ['required-a', 'required-b']),
  )[0];
  inspect(strictOutputSchema(critic.function.parameters));
  const finish = strictOutputSchema(
    providerToolDefinitions(
      providerTools(AGENT_TOOLS, ['finish_design'], undefined, 'empty-site'),
    )[0].function.parameters,
  );
  assert.deepEqual(finish.properties.mode.enum, ['question']);
  assert.deepEqual(finish.properties.questionReason.enum, ['clarification']);
  const render = strictOutputSchema(
    providerToolDefinitions(providerTools(AGENT_TOOLS, ['render_view']))[0].function.parameters,
  );
  const camera = render.properties.camera.anyOf[0];
  assert.deepEqual(camera.properties.position, {
    type: 'array',
    items: { type: 'number', minimum: -500, maximum: 500 },
    minItems: 3,
    maxItems: 3,
  });
  assert.throws(
    () => strictOutputSchema({ type: 'object', properties: {}, not: {} }),
    /unsupported structured output schema keyword/,
  );
});
