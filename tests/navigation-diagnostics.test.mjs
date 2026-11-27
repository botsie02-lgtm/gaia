import assert from 'node:assert/strict';
import test from 'node:test';
import { runDiagnostics } from '../.sim-test/diagnostics/index.js';
import { createWorld, stepWorld, CARGO_LIMIT } from '../.sim-test/world.js';

// Independent replay counts full-cargo agent-ticks, which the existing harness
// does not report. The original diagnostic matrix remains untouched.
test('navigation comparison matrix reports resolved outcomes and cargo saturation', () => {
  for (const [seed, ticks] of [[42,200],[12345,200],[2026,200],[7,400]]) {
    for (const [perceptionRange, memoryCapacity] of [[2,32],[6,32],[6,512]]) {
      const config = { seed, ticks, agentMode: 'knowledge', perceptionRange, memoryCapacity };
      const r = runDiagnostics(config);
      const w = createWorld(seed, config);
      let fullTicks = 0;
      for (let t = 0; t < ticks; t++) {
        stepWorld(w);
        fullTicks += w.agents.filter(a => a.cargo.wood + a.cargo.stone === CARGO_LIMIT).length;
      }
      const fullFinal = w.agents.filter(a => a.cargo.wood + a.cargo.stone === CARGO_LIMIT).length;
      assert.deepEqual(w.agents.map(a => ({ ...a.cargo })), r.agents.map(a => a.cargo));
      assert.ok(r.memory.peakPerAgent <= memoryCapacity);
      console.log('GAIA_NAVIGATION ' + JSON.stringify({
        seed,ticks,range:perceptionRange,capacity:memoryCapacity,
        delivered:r.delivered.wood+r.delivered.stone,built:r.firstConstructionTick,
        moves:r.movement.distance,backtracks:r.movement.backtracks,
        visited:r.coverage.visitedTiles,observed:r.coverage.observedTiles,
        peak:r.memory.peakPerAgent,mean:r.memory.meanPerAgent,fullTicks,fullFinal
      }));
    }
  }
});
