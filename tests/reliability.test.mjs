import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics, runDiagnosticSession } from '../.sim-test/diagnostics/index.js';
import { createPhysicalAudit } from '../.sim-test/diagnostics/physical-audit.js';
import { createWorld, stepWorld } from '../.sim-test/world.js';
import { shortScenarios, printMeasurement } from '../scripts/benchmark-reliability.mjs';

function clean(r) {
  assert.ok(r.physical);
  assert.deepEqual(r.physical.failures, { mass: 0, energy: 0, owner: 0, projection: 0, index: 0, identity: 0, sample: 0, temperature: 0 });
  assert.equal(r.physical.checkedTicks, r.config.ticks + 1);
  assert.equal(r.physical.finalTotalMassKg, r.physical.initialTotalMassKg);
  assert.equal(r.physical.finalSamples - r.physical.initialSamples, r.physical.newSamples);
  assert.equal(r.physical.finalCursor, r.physical.finalSamples + 1);
}
test('physical and thermal modes audit each tick across seeds and configurations', () => {
  for (const c of shortScenarios) {
    const row = printMeasurement(c);
    clean(row);
    assert.ok(row.harvested > 0);
    assert.ok(row.physical.finalSamples >= row.physical.initialSamples);
    if (c.thermal) assert.ok(row.physical.maxTemperatureShiftC > 0);
    else assert.equal(row.physical.maxTemperatureShiftC, 0);
  }
});
test('complete snapshots and deterministic reports reproduce; thermal does not alter ownership or behaviour', () => {
  const c = { seed: 42, ticks: 100, agentCount: 5, agentMode: 'knowledge', resourceMode: 'physical', thermal: true };
  const a = runDiagnosticSession(c), b = runDiagnosticSession(c);
  assert.deepEqual(a, b);
  clean(a.report);
  const off = runDiagnosticSession({ ...c, thermal: false });
  clean(off.report);
  const { config: _ac, physical: _ap, ...ar } = a.report;
  const { config: _bc, physical: _bp, ...br } = off.report;
  assert.deepEqual(ar, br);
  const samples = s => JSON.parse(s).physicalInventory.samples.map(({ temperatureC, ...rest }) => rest);
  assert.deepEqual(samples(a.finalSnapshot), samples(off.finalSnapshot));
  assert.ok(a.report.physical.temperatureChangedExistingSamples > 0);
});
test('initial physical state, legacy compatibility and invalid modes', () => {
  const r = runDiagnostics({ seed: 42, ticks: 0, resourceMode: 'physical', agentCount: 1 });
  clean(r);
  assert.equal(r.physical.initialSamples, r.physical.finalSamples);
  assert.equal(r.fullCargo.ticks, 0);
  assert.equal(runDiagnostics({ seed: 42, ticks: 0 }).physical, null);
  assert.throws(() => runDiagnostics({ seed: 42, ticks: 0, thermal: true }));
  assert.throws(() => runDiagnostics({ seed: 42, ticks: 0, resourceMode: 'physical', thermal: { maxContactsPerTick: 0 } }));
  assert.throws(() => runDiagnostics({ seed: 42, ticks: 0, resourceMode: 'other' }));
});
test('audit identifies orphan ownership without mutating simulation state', () => {
  const w = createWorld(42, { resourceMode: 'physical' });
  const audit = createPhysicalAudit(w);
  w.deposits = w.deposits.slice(1); // deliberate fixture corruption
  w.tick++;
  const before = w.physicalInventory.snapshot();
  audit.sample(w);
  assert.ok(audit.report().failures.owner > 0);
  assert.equal(audit.report().firstFailureTick.owner, 1);
  assert.equal(audit.report().failures.mass, 0);
  assert.deepEqual(w.physicalInventory.snapshot(), before);
  assert.throws(() => audit.sample(w));
});
test('full cargo duration and exhausted-resource counters agree with independent tick samples', () => {
  const c = { seed: 42, ticks: 130, agentMode: 'knowledge', perceptionRange: 2, memoryCapacity: 32, resourceMode: 'physical', thermal: true };
  const r = runDiagnostics(c), w = createWorld(c.seed, c);
  let full = 0, max = 0;
  const streaks = w.agents.map(() => 0);
  for (let i = 0; i < c.ticks; i++) {
    stepWorld(w);
    w.agents.forEach((a,j) => {
      const f = a.cargo.wood + a.cargo.stone === 3;
      full += Number(f); streaks[j] = f ? streaks[j] + 1 : 0; max = Math.max(max, streaks[j]);
    });
  }
  assert.equal(r.fullCargo.ticks, full);
  assert.equal(r.fullCargo.maxRun, max);
  assert.equal(r.fullCargo.finalAgents, streaks.filter(x => x > 0).length);
  assert.equal(r.resources.remainingDepositCount, w.deposits.length);
  clean(r);
});
test('zero perception remains an explicitly measured nonproductive scenario', () => {
  const r = runDiagnostics({ seed: 42, ticks: 40, agentMode: 'knowledge', perceptionRange: 0, resourceMode: 'physical', thermal: true });
  clean(r);
  assert.equal(r.outcomes.idle, 40 * 14);
  assert.deepEqual(r.delivered, { wood: 0, stone: 0 });
  assert.equal(r.firstConstructionTick, null);
  assert.equal(r.physical.newSamples, 0);
});
