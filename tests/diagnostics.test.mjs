import assert from 'node:assert/strict';
import test from 'node:test';
import { runDiagnostics, comparePolicies, baselineScenarios } from '../.sim-test/diagnostics/index.js';
import { createWorld, stepWorld } from '../.sim-test/world.js';

test('zero ticks have only spawn visits and no action or observation evidence', () => {
  const r = runDiagnostics({ seed: 42, ticks: 0, agentMode: 'knowledge', agentCount: 3 });
  assert.equal(r.coverage.visitedTiles, 3);
  assert.equal(r.coverage.observedTiles, 0);
  assert.equal(r.firstConstructionTick, null);
  assert.equal(r.memory.final, 0);
  assert.deepEqual(r.outcomes, { move: 0, harvest: 0, deliver: 0, rest: 0, idle: 0 });
});

test('reports match actual world stats, event deliveries and construction ticks', () => {
  for (const agentMode of ['legacy', 'knowledge']) {
    const config = { seed: 12345, ticks: 100, agentMode, eventCapacity: 10000 };
    const r = runDiagnostics(config);
    const w = createWorld(config.seed, config);
    for (let i = 0; i < config.ticks; i++) stepWorld(w);
    const delivery = w.history.query({ kind: 'stockpile.delivered' });
    assert.deepEqual(r.harvested, { wood: w.stats.woodHarvested, stone: w.stats.stoneHarvested });
    for (const m of ['wood', 'stone']) {
      assert.equal(r.delivered[m], delivery.reduce((s, e) => s + e.details[m], 0));
      assert.equal(r.harvested[m], r.delivered[m] + w.agents.reduce((s, a) => s + a.cargo[m], 0));
    }
    assert.equal(r.firstConstructionTick, w.history.query({ kind: 'structure.built' })[0]?.tick ?? null);
    assert.equal(r.gatheringExperience, w.agents.reduce((s, a) => s + a.skills.gathering.experience, 0));
    assert.equal(r.gatheringSuccesses, r.harvested.wood + r.harvested.stone);
    assert.equal(Object.values(r.outcomes).reduce((s, n) => s + n, 0), config.ticks * w.agents.length);
  }
});

test('ledger eviction does not affect any behavioural metric', () => {
  const a = runDiagnostics({ seed: 42, ticks: 80, eventCapacity: 1 });
  const b = runDiagnostics({ seed: 42, ticks: 80, eventCapacity: 10000 });
  assert.ok(a.gatheringSuccesses > 1);
  assert.deepEqual({ ...a, config: b.config }, b);
});

test('same config gives byte-identical JSON; policy comparison is independent', () => {
  const config = { seed: 42, ticks: 35, agentCount: 3, memoryCapacity: 32, perceptionRange: 2 };
  const a = comparePolicies(config);
  assert.equal(JSON.stringify(a), JSON.stringify(comparePolicies(config)));
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.equal(a.legacy.config.seed, a.knowledge.config.seed);
  assert.deepEqual(a.legacy, runDiagnostics(config));
});

test('zero range produces idle rather than invented movement or knowledge', () => {
  const r = runDiagnostics({ seed: 42, ticks: 50, agentMode: 'knowledge', perceptionRange: 0 });
  assert.equal(r.movement.distance, 0);
  assert.equal(r.outcomes.idle, 700);
  assert.equal(r.coverage.observedTiles, r.coverage.visitedTiles);
  assert.equal(r.gatheringExperience, 0);
  assert.equal(r.firstConstructionTick, null);
  assert.ok(r.agents.every(a => a.intentions.idle === 50 && a.movement.maxIdleRun === 50));
});

test('coverage and memory occupancy remain bounded by grid and configured capacity', () => {
  const r = runDiagnostics({ seed: 42, ticks: 100, agentMode: 'knowledge', memoryCapacity: 8, perceptionRange: 2 });
  for (const a of r.agents) {
    assert.ok(a.memory.peak <= 8);
    assert.ok(a.coverage.observedTiles <= r.gridTiles);
    assert.ok(a.coverage.visitedTiles <= r.gridTiles);
    assert.equal(Object.values(a.memory.retained).reduce((s,n) => s+n,0), a.memory.final);
    assert.ok(a.movement.backtracks <= a.movement.revisits);
    assert.ok(a.movement.revisits <= a.outcomes.move);
    assert.equal(Object.values(a.intentions).reduce((s,n) => s+n,0), 100);
  }
  assert.ok(r.coverage.observedTiles >= r.memory.peakPerAgent);
  assert.equal(r.agents.length, 14);
});

test('movement, idle, rest and cargo metrics match independent tick samples', () => {
  const config = { seed: 42, ticks: 130, agentMode: 'knowledge', agentCount: 2 };
  const r = runDiagnostics(config);
  const w = createWorld(config.seed, config); w.agents = w.agents.slice(0, 2);
  const paths = w.agents.map(a => [a.x + ':' + a.y]);
  const observed = new Set();
  for (let i = 0; i < config.ticks; i++) {
    stepWorld(w);
    w.agents.forEach((a, j) => {
      if (paths[j].at(-1) !== a.x + ':' + a.y) paths[j].push(a.x + ':' + a.y);
      for (const p of a.observation.terrain) observed.add(p.x + ':' + p.y);
    });
  }
  assert.equal(r.coverage.observedTiles, observed.size);
  paths.forEach((p, i) => {
    assert.equal(r.agents[i].movement.distance, p.length - 1);
    assert.equal(r.agents[i].movement.revisits, p.length - new Set(p).size);
    assert.equal(r.agents[i].movement.backtracks, p.filter((v,j) => j >= 2 && v === p[j-2]).length);
  });
});

test('invalid configs fail before running', () => {
  for (const bad of [{ seed: NaN }, { ticks: -1 }, { ticks: 0.5 }, { agentCount: 15 },
    { agentCount: 0 }, { agentMode: 'other' }, { perceptionRange: -1 }, { memoryCapacity: 0 }, { eventCapacity: 0 }]) {
    assert.throws(() => runDiagnostics({ seed: 1, ticks: 0, ...bad }));
  }
});

test('legacy does not pretend to have actual observation or intention evidence', () => {
  const r = runDiagnostics({ seed: 42, ticks: 20 });
  assert.equal(r.coverage.observedTiles, null);
  assert.ok(r.agents.every(a => a.intentions === null && a.evidence === null && a.memory.final === 0));
});

test('representative fixed matrix runs across seeds and publishes compact measured baselines', () => {
  for (const config of baselineScenarios()) {
    const r = runDiagnostics(config);
    const row = { seed: r.config.seed, mode: r.config.agentMode, range: r.config.perceptionRange,
      capacity: r.config.memoryCapacity, harvested: r.harvested, delivered: r.delivered,
      built: r.firstConstructionTick, xp: r.gatheringExperience, visited: r.coverage.visitedTiles,
      observed: r.coverage.observedTiles, moves: r.movement.distance, revisits: r.movement.revisits,
      backtracks: r.movement.backtracks, idle: r.outcomes.idle, memory: r.memory.peakPerAgent };
    console.log('GAIA_BASELINE ' + JSON.stringify(row));
    assert.equal(Object.values(r.outcomes).reduce((s,n) => s+n,0), r.config.ticks * r.config.agentCount);
  }
});
