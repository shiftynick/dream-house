/** Opt-in, isolated real-model evaluation. Default invocation performs no I/O. */
import express from 'express';
import { startVerificationServer } from './verification-server.ts';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/app.ts';
import { ConnectionStore, resolveConnections } from '../server/connections.ts';
import { runAgent } from '../server/agent.ts';
import { VerificationBudget, capabilityCases } from './capability-verification.ts';

const cases = capabilityCases();
const selected = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) || 'all';
assert(selected === 'all' || cases.some((item) => item.name === selected), 'Unknown case.');
if (!process.argv.includes('--live')) {
  console.log(
    'Dry run. Synthetic cases: floor, shared-wall. Use --live --case=all to enable real paid model requests and local browser captures.',
  );
} else {
  // Read only connection configuration from the existing installation, never its project.
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const connections = new ConnectionStore(path.resolve(process.env.TERRAIN_DATA_DIR || '.data'));
  await connections.load();
  const config = resolveConnections(connections.get());
  assert(config.key, 'A configured gateway is required.');
  const budget = new VerificationBudget();
  const priorLedger = process.argv.find((arg) => arg.startsWith('--prior-ledger='))?.slice(15);
  if (priorLedger) {
    const contents = await readFile(path.resolve(priorLedger), 'utf8');
    assert(contents.length <= 20_000, 'Prior ledger is oversized.');
    budget.importLedger(JSON.parse(contents));
  }
  await mkdir('.data/verification', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.resolve('.data/verification/capabilities-'));
  const persistLedger = () =>
    writeFile(
      path.join(directory, 'ledger.json'),
      JSON.stringify(
        {
          model: config.model,
          priorLedger: priorLedger ? path.resolve(priorLedger) : undefined,
          limit: budget.limit,
          reservation: budget.reservation,
          maxCalls: budget.maxCalls,
          reportedCost: budget.total,
          calls: budget.entries,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  const { app, renders, store } = await createApplication({
    directory,
    env: { AI_GATEWAY_API_KEY: 'isolated-browser-no-cloud', AI_GATEWAY_MODEL: config.model },
    modelClient: {
      async complete() {
        throw new Error('Browser model requests are disabled in this evaluation.');
      },
    },
    audioFetcher: async () => {
      throw new Error('Audio requests are disabled in this evaluation.');
    },
  });
  const untouched = JSON.stringify(await store.read());
  let ready: (id: string) => void;
  const rendererReady = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const host = express();
  host.use((req, _res, next) => {
    if (
      req.path === '/api/render/jobs' &&
      typeof req.query.clientId === 'string' &&
      renders.available(req.query.clientId)
    )
      ready(req.query.clientId);
    next();
  });
  host.use(app);
  const server = await startVerificationServer(host);
  console.log(
    `Model: ${config.model}. Open http://127.0.0.1:${server.port} in a local browser within 120 seconds. Synthetic scenes only; browser AI/audio disabled.`,
  );
  console.log(
    'Budget: $5 reported-cost stop, $0.50 request reservation, at most 10 requests, no retries. Provider charges arrive after requests; this is not a guaranteed billing cap.',
  );
  let phase = 'renderer';
  let currentCase = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const clientId = await Promise.race([
      rendererReady,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Renderer did not connect; no model requests made.')),
          120_000,
        );
      }),
    ]);
    clearTimeout(timeout);
    await persistLedger();
    for (const test of cases.filter((item) => selected === 'all' || selected === item.name)) {
      console.log(`Running ${test.name} sequentially.`);
      currentCase = test.name;
      phase = 'agent';
      let captures = 0;
      const started = Date.now();
      const answer = await runAgent({
        key: config.key,
        model: config.model,
        scene: test.scene,
        messages: [{ id: randomUUID(), role: 'user', text: test.prompt }],
        context: { ...test.context, renderClientId: clientId, allowVisualReview: true },
        render: async (scene, request, signal) => {
          const capture = await renders.provider(clientId)(scene, request, signal);
          assert(++captures <= 3, 'Capture limit exceeded.');
          const match = /^data:image\/(jpeg|png);base64,(.+)$/.exec(capture.image);
          assert(match && capture.image.length <= 1_000_000, 'Invalid or oversized local image.');
          await writeFile(
            path.join(
              directory,
              `${test.name}-capture-${captures}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`,
            ),
            Buffer.from(match[2], 'base64'),
            { mode: 0o600 },
          );
          return capture;
        },
        signal: AbortSignal.timeout(240_000),
        maxCalls: Math.min(5, budget.maxCalls - budget.entries.length),
        maxRepairs: 1,
        beforeModelCall: async () => {
          budget.reserve(test.name);
          await persistLedger();
        },
        onUsage: async ({ cost }) => {
          budget.settle(cost);
          await persistLedger();
        },
      });
      const saveAnswer = async (objectivePassed: boolean) =>
        writeFile(
          path.join(directory, `${test.name}.json`),
          JSON.stringify(
            {
              case: test.name,
              model: config.model,
              elapsedMs: Date.now() - started,
              objectivePassed,
              scene: answer.scene,
              reply: answer.reply,
              assessment: answer.assessment,
              visualReview: answer.visualReview,
              preservationResults: answer.preservationResults,
              editScopeReview: answer.editScopeReview,
              usage: answer.usage,
              metrics: answer.metrics,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      await saveAnswer(false);
      phase = 'objective assertions';
      assert(answer.scene, 'Model did not return an edited design.');
      test.verify(answer.scene);
      assert.equal(
        answer.assessment?.requiresConfirmation,
        false,
        'Objective model checklist has unresolved requirements.',
      );
      assert(
        answer.assessment?.requirements.some((item) => item.results.length),
        'Expected typed objective assertions.',
      );
      assert.equal(answer.visualReview?.status, 'passed', 'Expected fresh model visual review.');
      assert(
        answer.visualReview?.captures.some(
          (capture) => capture.quality === 'live' && capture.view !== 'plan',
        ),
        'Expected actual live 3D renderer evidence.',
      );
      assert.equal(answer.editScopeReview?.preserved ?? true, true);
      assert(answer.preservationResults?.every((item) => item.passed));
      assert.equal(
        JSON.stringify(await store.read()),
        untouched,
        'Evaluation must never adopt or save generated geometry.',
      );
      await saveAnswer(true);
      console.log(`${test.name}: objective assertions and structured visual review passed.`);
      assert(
        budget.entries.every((item) => item.settled && item.cost !== null),
        'Unknown cost; abort remaining cases.',
      );
      assert(
        budget.total <= budget.limit,
        'Reported charge exceeded budget; no further requests allowed.',
      );
    }
    console.log(
      `Finished ${budget.entries.length} calls, reported $${budget.total.toFixed(4)}. Results: ${directory}. This small sample is not a statistical evaluation.`,
    );
  } catch (error) {
    const message =
      phase === 'objective assertions' && error instanceof assert.AssertionError
        ? error.message.split('\n')[0].slice(0, 240)
        : 'Stopped during renderer/model/budget work; upstream details omitted.';
    await writeFile(
      path.join(directory, 'failure.json'),
      JSON.stringify({ case: currentCase, phase, message }, null, 2),
      { mode: 0o600 },
    );
    await persistLedger();
    // Upstream errors may contain provider details; do not print them or model payloads.
    console.error(
      `Evaluation stopped (${currentCase || 'startup'}, ${phase}): ${message} Calls: ${budget.entries.length}; reported cost: $${budget.total.toFixed(4)}; inspect bounded ledger and completed case results in ${directory}. No retries.`,
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    await server.close();
  }
}
