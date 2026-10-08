import test from 'node:test';
import assert from 'node:assert/strict';
import { VerificationBudget, capabilityCases } from '../scripts/capability-verification.ts';
import { executeCommands } from '../shared/design.ts';

test('real evaluation budget halts unknown costs, outstanding requests, aggregate charges and call count', () => {
  const budget = new VerificationBudget(1, 0.5, 2);
  budget.reserve('floor');
  assert.throws(() => budget.reserve('floor'), /unknown/);
  budget.settle(0.6);
  assert.throws(() => budget.reserve('wall'), /exhausted/);
  const unknown = new VerificationBudget();
  unknown.reserve('floor');
  unknown.settle(null);
  assert.throws(() => unknown.reserve('wall'), /unknown/);
  const calls = new VerificationBudget(5, 0.5, 1);
  calls.reserve('floor');
  calls.settle(0);
  assert.throws(() => calls.reserve('wall'), /call limit/);
  assert.throws(() => new VerificationBudget(6));
});

test('synthetic floor objective allows only target material and catches accent changes', () => {
  const fixture = capabilityCases()[0];
  const result = executeCommands(fixture.scene, [
    { type: 'set_surface_material', roomId: 'kitchen', surface: 'floor', palette: 'chalk' },
  ]).scene;
  fixture.verify(result);
  result.rooms[0].surfacePalettes!.north = 'cedar';
  assert.throws(() => fixture.verify(result), /Only the kitchen floor/);
});

test('synthetic shared-wall objective preserves exact outside footprint and unrelated data', () => {
  const fixture = capabilityCases()[1];
  const result = executeCommands(fixture.scene, [
    { type: 'move_shared_wall', roomAId: 'kitchen', roomBId: 'dining', delta: 1 },
  ]).scene;
  fixture.verify(result);
  result.rooms[2].name = 'Changed study';
  assert.throws(() => fixture.verify(result), /unrelated data/);
});

test('prior ledger retains settled charges and leaves only remaining aggregate calls', () => {
  const calls = Array.from({ length: 6 }, () => ({ case: 'floor', cost: 0.05, settled: true }));
  const budget = new VerificationBudget();
  budget.importLedger({ limit: 5, reservation: 0.5, maxCalls: 10, reportedCost: 0.3, calls });
  assert.equal(budget.entries.length, 6);
  assert(Math.abs(budget.total - 0.3) < 1e-8);
  for (let index = 0; index < 4; index++) {
    budget.reserve('shared-wall');
    budget.settle(0.05);
  }
  assert.throws(() => budget.reserve('shared-wall'), /call limit/);
  for (const replacement of [
    { ...calls[0], cost: null },
    { ...calls[0], settled: false },
  ]) {
    assert.throws(() =>
      new VerificationBudget().importLedger({
        limit: 5,
        reservation: 0.5,
        maxCalls: 10,
        reportedCost: 0.3,
        calls: [replacement],
      }),
    );
  }
  assert.throws(
    () =>
      new VerificationBudget().importLedger({
        limit: 5,
        reservation: 0.5,
        maxCalls: 10,
        reportedCost: 0.5,
        calls,
      }),
    /total/,
  );
});
