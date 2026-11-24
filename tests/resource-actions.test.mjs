import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalInventory } from '../.sim-test/inventory/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';
import { resourceOwnerId, migrateLegacyResources, transferResources,
  resourceMassKg, resourceUnits } from '../.sim-test/resource-actions/index.js';

const deposit = resourceOwnerId('deposit', 1);
const agent = resourceOwnerId('agent', 2);
const hub = resourceOwnerId('hub', 3);
const structure = resourceOwnerId('structure', 4);
const owners = [deposit, agent, hub, structure];
const calibration = [
  { resourceId: 'wood', materialId: 'wood', kgPerUnit: 2 },
  { resourceId: 'stone', materialId: 'stone', kgPerUnit: 3 },
];
const holding = (ownerId = deposit, resourceId = 'wood', units = 5, temperatureC = 20) =>
  ({ ownerId, resourceId, units, temperatureC });
const boot = (...holdings) => migrateLegacyResources(null, owners, holdings, calibration);
const sample = (massKg, temperatureC = 20, materialId = 'wood', ownerId = deposit) =>
  ({ ownerId, materialId, massKg, temperatureC, phase: 'solid' });
const move = (store, from, to, massKg, materialId = 'wood') =>
  transferResources(store, store.revision, owners, from, to, [{ materialId, massKg }]);
const mass = (store, owner, material = 'wood') => resourceMassKg(store, owners, owner, material);
const totals = store => {
  const result = {};
  for (const s of store.snapshot().samples) {
    const item = result[s.materialId] ??= { mass: 0, energy: 0 };
    item.mass += s.massKg;
    item.energy += sensibleEnergyJ(s);
  }
  return result;
};
function close(a, b) {
  assert.ok(Number.isFinite(a) && Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)),
    a + ' != ' + b);
}
function conserved(store, before) {
  const after = totals(store);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const id of Object.keys(before)) {
    close(after[id].mass, before[id].mass);
    close(after[id].energy, before[id].energy);
  }
}
function fails(store, action) {
  const before = store.snapshot();
  assert.throws(action);
  assert.deepEqual(store.snapshot(), before);
}

test('canonical owner namespaces and invalid world IDs', () => {
  assert.equal(resourceOwnerId('deposit', 1), 'deposit:1');
  assert.notEqual(resourceOwnerId('agent', 1), deposit);
  for (const id of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resourceOwnerId('agent', id));
  }
  assert.throws(() => resourceOwnerId('unknown', 1));
});

test('migration uses explicit masses and temperatures for every owner, omits zeros', () => {
  const entries = [holding(), holding(agent, 'wood', 0, 10),
    holding(hub, 'stone', 2, 70), holding(structure, 'wood', 1, -5)];
  const store = boot(...entries);
  assert.equal(store.revision, 0);
  assert.equal(store.snapshot().samples.length, 3);
  assert.equal(mass(store, deposit), 10);
  assert.equal(mass(store, agent), 0);
  assert.equal(mass(store, hub, 'stone'), 6);
  assert.equal(store.forOwner(hub)[0].temperatureC, 70);
  assert.equal(store.forOwner(structure)[0].temperatureC, -5);
  assert.deepEqual(store.snapshot(), boot(...entries.reverse()).snapshot());
  fails(store, () => migrateLegacyResources(store, owners, entries, calibration));
  fails(store, () => migrateLegacyResources(PhysicalInventory.restore(store.snapshot()), owners, entries, calibration));
});

test('migration rejects duplicate holdings, missing or ambiguous calibration and invalid empty holdings', () => {
  assert.throws(() => boot(holding(), holding()));
  assert.throws(() => boot(holding(deposit, 'unknown', 0)));
  assert.throws(() => boot(holding(deposit, 'wood', 0, -300)));
  assert.throws(() => boot(holding('agent:999')));
  assert.throws(() => boot(holding(deposit, 'wood', -1)));
  assert.throws(() => migrateLegacyResources(null, owners, [holding()], []));
  assert.throws(() => migrateLegacyResources(null, owners, [holding()], [
    ...calibration, { resourceId: 'logs', materialId: 'wood', kgPerUnit: 4 },
  ]));
  assert.throws(() => migrateLegacyResources(null, owners, [holding()], [
    { resourceId: 'wood', materialId: 'wood', kgPerUnit: 0 },
  ]));
  assert.throws(() => migrateLegacyResources(null, owners, [holding(deposit, 'wood', Number.MAX_VALUE)], calibration));
});

test('whole transfer retains identity, temperature and exclusive ownership', () => {
  const store = boot(holding());
  const before = store.get(1);
  const receipt = move(store, deposit, agent, 10);
  assert.deepEqual(store.get(1), { ...before, ownerId: agent });
  assert.equal(mass(store, deposit), 0);
  assert.deepEqual(receipt, { fromOwnerId: deposit, toOwnerId: agent, revision: 1,
    materials: [{ materialId: 'wood', massKg: 10,
      samples: [{ sourceSampleId: 1, transferredSampleId: 1, massKg: 10 }] }],
    createdSampleIds: [] });
  assert.ok(Object.isFrozen(receipt.materials[0].samples[0]));
  assert.ok(Object.isFrozen(receipt.materials) && Object.isFrozen(receipt));
});

test('partial transfer splits atomically with stable parent and new child IDs', () => {
  const store = boot(holding());
  const before = totals(store);
  const receipt = move(store, deposit, agent, 2.5);
  assert.deepEqual(receipt.createdSampleIds, [2]);
  assert.deepEqual(receipt.materials[0].samples, [
    { sourceSampleId: 1, transferredSampleId: 2, massKg: 2.5 },
  ]);
  assert.equal(store.get(1).massKg, 7.5);
  assert.equal(store.get(2).massKg, 2.5);
  assert.equal(store.get(2).temperatureC, 20);
  assert.equal(store.revision, 1);
  conserved(store, before);
});

test('multiple samples transfer in ID order without averaging different temperatures', () => {
  const store = PhysicalInventory.initialize([sample(2, 10), sample(3, 80),
    sample(8, 30, 'stone'), sample(5, 50)]);
  const before = totals(store);
  const receipt = move(store, deposit, agent, 4);
  assert.deepEqual(receipt.materials[0].samples, [
    { sourceSampleId: 1, transferredSampleId: 1, massKg: 2 },
    { sourceSampleId: 2, transferredSampleId: 5, massKg: 2 },
  ]);
  assert.deepEqual(store.forOwner(agent).map(s => s.temperatureC), [10, 80]);
  assert.equal(store.get(2).massKg, 1);
  assert.equal(store.get(3).massKg, 8);
  assert.equal(store.get(4).massKg, 5);
  conserved(store, before);
});

test('complete deposit to agent to hub to structure lifecycle conserves each material and energy', () => {
  const store = boot(holding(), holding(deposit, 'stone', 4, 45));
  const before = totals(store);
  move(store, deposit, agent, 8);
  move(store, deposit, agent, 12, 'stone');
  // Transportation does not change cargo owner or sample state.
  const cargo = store.forOwner(agent);
  assert.equal(mass(store, agent), 8);
  assert.deepEqual(store.forOwner(agent), cargo);
  transferResources(store, store.revision, owners, agent, hub, [
    { materialId: 'wood', massKg: 8 }, { materialId: 'stone', massKg: 12 },
  ]);
  assert.equal(mass(store, agent), 0);
  assert.equal(mass(store, agent, 'stone'), 0);
  const receipt = transferResources(store, store.revision, owners, hub, structure, [
    { materialId: 'wood', massKg: 8 }, { materialId: 'stone', massKg: 9 },
  ]);
  assert.deepEqual(receipt.materials.map(s => s.materialId), ['stone', 'wood']);
  assert.equal(store.revision, 4);
  assert.equal(mass(store, structure), 8);
  assert.equal(mass(store, structure, 'stone'), 9);
  assert.equal(mass(store, hub, 'stone'), 3);
  assert.equal(mass(store, deposit), 2);
  conserved(store, before);
});

test('derived units track inventory immediately and preserve fractional quantities', () => {
  const store = boot(holding());
  const units = owner => resourceUnits(store, owners, owner, 'wood', calibration);
  assert.equal(units(deposit), 5);
  move(store, deposit, agent, 1.5);
  assert.equal(units(agent), .75);
  assert.equal(units(deposit), 4.25);
  move(store, agent, hub, 1.5);
  assert.equal(units(agent), 0);
  assert.equal(units(hub), .75);
  assert.throws(() => resourceUnits(store, owners, hub, 'unknown', calibration));
});

test('insufficient and invalid requests leave samples, cursor and revision untouched', () => {
  const store = boot(holding());
  for (const quantity of [0, -1, NaN, Infinity, 11]) {
    fails(store, () => move(store, deposit, agent, quantity));
  }
  fails(store, () => move(store, deposit, agent, 1, 'unsupported'));
  fails(store, () => move(store, deposit, deposit, 1));
  fails(store, () => move(store, deposit, 'agent:999', 1));
  fails(store, () => move(store, deposit, 'agent:02', 1));
  fails(store, () => transferResources(store, 1, owners, deposit, agent, [{materialId:'wood', massKg:1}]));
  fails(store, () => transferResources(store, 0, owners, deposit, agent, []));
  fails(store, () => transferResources(store, 0, owners, deposit, agent,
    [{materialId:'wood', massKg:1}, {materialId:'wood', massKg:2}]));
  fails(store, () => transferResources(store, 0, [...owners, agent], deposit, agent,
    [{materialId:'wood', massKg:1}]));
});

test('multi-material shortage never commits the earlier planned material', () => {
  const store = boot(holding(), holding(deposit, 'stone', 2));
  fails(store, () => transferResources(store, 0, owners, deposit, agent, [
    { materialId: 'stone', massKg: 2 }, { materialId: 'wood', massKg: 100 },
  ]));
  assert.deepEqual(move(store, deposit, agent, 2, 'stone').createdSampleIds, [3]);
});

test('late unrepresentable split rolls back earlier staged split and transfer', () => {
  const store = PhysicalInventory.initialize([sample(10, 20, 'stone'), sample(1e16)]);
  fails(store, () => transferResources(store, 0, owners, deposit, agent, [
    { materialId: 'stone', massKg: 2 }, { materialId: 'wood', massKg: .25 },
  ]));
  assert.deepEqual(move(store, deposit, agent, 2, 'stone').createdSampleIds, [3]);
});

test('numeric boundaries reject lost mass and allow representable fractional transfers', () => {
  const store = PhysicalInventory.initialize([sample(1), sample(.125)]);
  const before = totals(store);
  move(store, deposit, agent, 1.0625);
  assert.equal(mass(store, agent), 1.0625);
  conserved(store, before);
  const extreme = PhysicalInventory.initialize([sample(1e16), sample(.25)]);
  assert.throws(() => mass(extreme, deposit));
  fails(extreme, () => move(extreme, deposit, agent, .25));
  const tiny = PhysicalInventory.initialize([sample(Number.MIN_VALUE)]);
  move(tiny, deposit, agent, Number.MIN_VALUE);
  assert.equal(mass(tiny, agent), Number.MIN_VALUE);
});

test('restored snapshots and reordered material requests produce identical receipts and IDs', () => {
  const store = boot(holding(), holding(deposit, 'stone', 4));
  move(store, deposit, agent, 2);
  const restored = PhysicalInventory.restore(JSON.parse(JSON.stringify(store.snapshot())));
  const quantities = [{ materialId: 'wood', massKg: 2 }, { materialId: 'stone', massKg: 3 }];
  const a = transferResources(store, 1, owners, deposit, hub, quantities);
  const b = transferResources(restored, 1, [...owners].reverse(), deposit, hub, [...quantities].reverse());
  assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
  assert.deepEqual(store.snapshot(), restored.snapshot());
  fails(store, () => transferResources(store, 1, owners, deposit, hub, quantities));
});
