import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentMemory, DEFAULT_MEMORY_CAPACITY } from '../.sim-test/memory/index.js';
import { observeAgent } from '../.sim-test/perception/index.js';
import { createWorld, stepWorld, snapshot } from '../.sim-test/world.js';

function fixture() {
  const world = {
    tick: 0, width: 9, height: 5, terrain: Array(45).fill('grass'),
    agents: [
      { id: 1, kind: 'agent', faction: 'settler', x: 1, y: 2 },
      { id: 2, kind: 'agent', faction: 'hostile', x: 3, y: 2 },
      { id: 3, kind: 'agent', faction: 'neutral', x: 8, y: 2 },
    ],
    deposits: [
      { id: 4, kind: 'deposit', material: 'wood', amount: 5, x: 3, y: 2 },
      { id: 5, kind: 'deposit', material: 'stone', amount: 6, x: 7, y: 2 },
    ],
    structures: [{ id: 6, kind: 'structure', structure: 'hearth', x: 2, y: 2 }],
    hub: { id: 7, x: 1, y: 2 },
  };
  const memory = new AgentMemory(1);
  const see = (range = 2, opaqueTerrain = []) =>
    memory.update(observeAgent(world, 1, { range, opaqueTerrain }));
  const get = id => memory.query({ entityId: id })[0];
  return { world, memory, see, get };
}

test('retains local terrain, deposits, agents, structures and hub using stable IDs', () => {
  const { memory, see, get } = fixture();
  assert.equal(memory.capacity, DEFAULT_MEMORY_CAPACITY);
  assert.equal(memory.snapshot().lastObservationTick, null);
  see();
  assert.deepEqual(get(4), { value: { kind: 'deposit', id: 4, x: 3, y: 2,
    material: 'wood', amount: 5 }, status: 'current', lastObservedTick: 0, lastCheckedTick: 0 });
  assert.equal(get(2).value.faction, 'hostile');
  assert.equal(get(6).value.structure, 'hearth');
  assert.equal(get(7).value.kind, 'hub');
  assert.equal(get(1), undefined);
  assert.equal(get(5), undefined);
  assert.equal(get(3), undefined);
  assert.equal(memory.query({ kind: 'terrain', x: 1, y: 2 })[0].value.terrain, 'grass');
  assert.deepEqual(memory.query({ material: 'wood', x: 3, y: 2 }), [get(4)]);
});

test('separate observers have independent memories and cannot ingest another agent’s view', () => {
  const { world, memory, see } = fixture();
  const other = new AgentMemory(3);
  see();
  other.update(observeAgent(world, 3, { range: 2 }));
  assert.deepEqual(memory.query({ kind: 'deposit' }).map(e => e.value.id), [4]);
  assert.deepEqual(other.query({ kind: 'deposit' }).map(e => e.value.id), [5]);
  world.tick++;
  const before = memory.snapshot();
  assert.throws(() => memory.update(observeAgent(world, 3)), RangeError);
  assert.deepEqual(memory.snapshot(), before);
  assert.equal(other.snapshot().lastObservationTick, 0);
});

test('out-of-range removal stays stale, visible former position proves only absence', () => {
  const { world, see, get } = fixture();
  see();
  world.tick++;
  world.agents[0].x = 0;
  world.deposits = world.deposits.filter(d => d.id !== 4);
  see(1);
  assert.equal(get(4).status, 'stale');
  assert.equal(get(4).value.amount, 5);
  assert.equal(get(4).lastCheckedTick, 0);
  world.tick++;
  world.agents[0].x = 1;
  see();
  assert.equal(get(4).status, 'absent');
  assert.equal(get(4).value.amount, 5); // historical, never fabricated zero
  assert.equal(get(4).lastObservedTick, 0);
  assert.equal(get(4).lastCheckedTick, 2);
  world.tick++;
  see(0);
  assert.equal(get(4).lastCheckedTick, 2);
  assert.equal(get(4).status, 'absent');
});

test('occlusion is not evidence of absence even inside the nominal range', () => {
  const { world, see, get } = fixture();
  see();
  world.tick++;
  world.terrain[2 * world.width + 2] = 'water';
  world.deposits.shift();
  see(3, ['water']);
  assert.equal(get(4).status, 'stale');
  assert.equal(get(4).lastCheckedTick, 0);
  world.tick++;
  world.terrain[2 * world.width + 2] = 'grass';
  see(3, ['water']);
  assert.equal(get(4).status, 'absent');
});

test('new positive observations replace quantities, terrain and last-known position', () => {
  const { world, memory, see, get } = fixture();
  see();
  world.tick++;
  world.deposits[0].amount = 0;
  world.agents[1].x = 2;
  world.terrain[2 * world.width + 3] = 'dirt';
  see();
  assert.equal(get(4).value.amount, 0);
  assert.equal(get(4).status, 'current');
  assert.equal(get(2).value.x, 2);
  assert.equal(get(2).lastObservedTick, 1);
  assert.equal(memory.query({ kind: 'terrain', x: 3, y: 2 })[0].value.terrain, 'dirt');
  world.tick++;
  world.agents[1].x = 8;
  world.structures = [];
  world.hub.x = 8;
  see();
  for (const id of [2,6,7]) assert.equal(get(id).status, 'absent');
  world.tick++;
  world.agents[1].x = 1;
  world.hub.x = 2;
  see();
  assert.equal(get(2).status, 'current');
  assert.equal(get(2).value.x, 1);
  assert.equal(get(7).value.x, 2);
});

test('capacity bounds all record kinds and tie-breaks independent of list order', () => {
  const { world } = fixture();
  const a = new AgentMemory(1, 3);
  const b = new AgentMemory(1, 3);
  const obs = observeAgent(world, 1, { range: 2 });
  a.update(obs);
  b.update({ ...obs, terrain: [...obs.terrain].reverse(), agents: [...obs.agents].reverse(),
    deposits: [...obs.deposits].reverse(), structures: [...obs.structures].reverse() });
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.size, 3);
  assert.deepEqual(a.query().map(e => e.value.id), [2,4,6]);
  world.tick++;
  world.agents[0].x = 8;
  a.update(observeAgent(world, 1, { range: 1 }));
  assert.equal(a.size, 3);
  assert.deepEqual(a.query().map(e => e.value.id), [3,5,undefined]);
  assert.equal(a.query({ entityId: 4 }).length, 0);
  const tileOnly = new AgentMemory(1, 1);
  world.agents[0].x = 0;
  tileOnly.update(observeAgent(world, 1, { range: 0 }));
  assert.equal(tileOnly.size, 1);
  assert.equal(tileOnly.query()[0].value.kind, 'terrain');
});

test('immutable snapshots and query results never alias mutable observation objects', () => {
  const { world, memory } = fixture();
  const obs = JSON.parse(JSON.stringify(observeAgent(world, 1, { range: 2 })));
  obs.deposits[0].secret = 'not observed by API';
  const snap = memory.update(obs);
  const serialized = JSON.stringify(snap);
  obs.deposits[0].amount = 999;
  obs.terrain[0].terrain = 'water';
  assert.equal(JSON.stringify(snap), serialized);
  assert.ok(!serialized.includes('secret'));
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.entries));
  for (const e of snap.entries) {
    assert.ok(Object.isFrozen(e));
    assert.ok(Object.isFrozen(e.value));
  }
  assert.throws(() => { memory.query().push({}); }, TypeError);
  assert.throws(() => { snap.entries[0].value.x = 99; }, TypeError);
  world.tick++;
  memory.update(observeAgent(world, 1, { range: 0 }));
  assert.equal(JSON.stringify(snap), serialized);
});

test('invalid inputs are rejected atomically including malformed local projections', () => {
  const { world, memory, see } = fixture();
  for (const capacity of [0,-1,1.2,NaN,Infinity]) {
    assert.throws(() => new AgentMemory(1, capacity), RangeError);
  }
  assert.throws(() => new AgentMemory(0), RangeError);
  see();
  const before = memory.snapshot();
  assert.throws(() => see(), RangeError);
  world.tick++;
  const obs = observeAgent(world, 1, { range: 2 });
  const malformed = [
    { ...obs, tick: -1 }, { ...obs, tick: Infinity }, { ...obs, range: -1 },
    { ...obs, terrain: [] }, { ...obs, terrain: [...obs.terrain, obs.terrain[0]] },
    { ...obs, terrain: [...obs.terrain, { x: 8, y: 4, terrain: 'grass' }] },
    { ...obs, deposits: [{ ...obs.deposits[0], amount: NaN }] },
    { ...obs, deposits: [{ ...obs.deposits[0], amount: -1 }] },
    { ...obs, deposits: [{ ...obs.deposits[0], material: 'gold' }] },
    { ...obs, deposits: [{ ...obs.deposits[0], x: 8 }] },
    { ...obs, deposits: [{ ...obs.deposits[0], id: 2 }] },
    { ...obs, agents: [obs.observer] }, { ...obs, hub: undefined },
    { ...obs, structures: [{ ...obs.structures[0], id: 4 }], deposits: [] },
  ];
  for (const bad of malformed) {
    assert.throws(() => memory.update(bad));
    assert.deepEqual(memory.snapshot(), before);
  }
  assert.throws(() => memory.query({ status: 'destroyed' }), RangeError);
  assert.throws(() => memory.query({ x: -1 }), RangeError);
  memory.update(obs);
  assert.equal(memory.snapshot().lastObservationTick, 1);
});

test('versioned JSON restoration preserves stale and absent evidence and continuation', () => {
  const { world, memory, see } = fixture();
  assert.deepEqual(AgentMemory.fromSnapshot(JSON.parse(JSON.stringify(memory))).snapshot(), memory.snapshot());
  see();
  world.tick++;
  world.deposits.shift();
  see();
  world.tick++;
  see(0);
  const parsed = JSON.parse(JSON.stringify(memory));
  const restored = AgentMemory.fromSnapshot(parsed);
  assert.deepEqual(restored.snapshot(), memory.snapshot());
  parsed.entries[0].value.x = 99;
  assert.deepEqual(restored.snapshot(), memory.snapshot());
  world.tick++;
  const obs = observeAgent(world, 1);
  assert.deepEqual(restored.update(obs), memory.update(obs));
});

test('reject invalid serialized snapshots', () => {
  const { memory, see } = fixture();
  see();
  const snap = memory.snapshot();
  for (const bad of [
    { ...snap, version: 2 }, { ...snap, capacity: 1 },
    { ...snap, lastObservationTick: null }, { ...snap, lastObservationTick: -1 },
    { ...snap, entries: [...snap.entries, snap.entries[0]] },
    { ...snap, entries: [{ ...snap.entries[0], lastCheckedTick: 1 }] },
    { ...snap, entries: [{ ...snap.entries[0], status: 'absent' }] },
  ]) assert.throws(() => AgentMemory.fromSnapshot(bad));
});

test('identical seeded worlds and observation sequences reproduce memory without altering world', () => {
  const a = createWorld(12345);
  const b = createWorld(12345);
  const ma = new AgentMemory(a.agents[0].id, 64);
  const mb = new AgentMemory(b.agents[0].id, 64);
  for (let tick = 0; tick < 50; tick++) {
    const before = snapshot(a);
    const opts = { range: 4, opaqueTerrain: ['water'] };
    ma.update(observeAgent(a, ma.observerId, opts));
    mb.update(observeAgent(b, mb.observerId, opts));
    assert.equal(JSON.stringify(ma), JSON.stringify(mb));
    assert.equal(snapshot(a), before);
    assert.ok(ma.size <= ma.capacity);
    stepWorld(a); stepWorld(b);
  }
  assert.equal(snapshot(a), snapshot(b));
});
