import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalInventory } from '../.sim-test/inventory/index.js';
import { getMaterial } from '../.sim-test/materials/index.js';
import { sensibleEnergyJ, stepThermalContact } from '../.sim-test/thermal/index.js';

const sample = (materialId = 'wood', massKg = 4, temperatureC = 20, ownerId = 'entity:1') =>
  ({ materialId, massKg, temperatureC, ownerId, phase: getMaterial(materialId).phase });
const init = (...samples) => PhysicalInventory.initialize(samples);
const tx = (store, ...ops) => store.transact(store.revision, ops);
const transfer = (sampleId, fromOwnerId = 'entity:1', toOwnerId = 'container:2') =>
  ({ kind: 'transfer', sampleId, fromOwnerId, toOwnerId });
const split = (sampleId, massKg) => ({ kind: 'split', sampleId, massKg });
const combine = (a, b) => ({ kind: 'combine', a, b });
const heat = (a, b, conductanceWPerK = 100, tickDurationSeconds = 1) =>
  ({ kind: 'heat', a, b, contact: { conductanceWPerK, tickDurationSeconds } });
const total = store => store.snapshot().samples.reduce((s, x) => s + x.massKg, 0);
const energy = store => store.snapshot().samples.reduce((s, x) => s + sensibleEnergyJ(x), 0);
function close(a, b) {
  assert.ok(Number.isFinite(a) && Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)),
    a + ' != ' + b);
}
function fails(store, ...ops) {
  const before = store.snapshot();
  assert.throws(() => tx(store, ...ops));
  assert.deepEqual(store.snapshot(), before);
}

test('initialization assigns world-scoped IDs, immutable detached records and owner views', () => {
  const input = sample();
  const store = init(input, sample('stone', 2, 30, 'container:2'));
  input.massKg = 99;
  assert.equal(store.get(1).massKg, 4);
  assert.equal(store.get(2).ownerId, 'container:2');
  assert.deepEqual(store.forOwner('entity:1').map(s => s.sampleId), [1]);
  assert.deepEqual(store.forOwner('empty'), []);
  assert.ok(Object.isFrozen(store.get(1)) && Object.isFrozen(store.forOwner('entity:1')));
  assert.throws(() => { store.get(1).massKg = 0; }, TypeError);
  assert.equal(store.snapshot().nextSampleId, 3);
  assert.equal(store.revision, 0);
});

test('whole-sample transfer preserves identity, mass, energy and exclusive ownership', () => {
  const store = init(sample());
  const before = store.get(1);
  const receipt = tx(store, transfer(1));
  assert.deepEqual(store.get(1), { ...before, ownerId: 'container:2' });
  assert.equal(before.ownerId, 'entity:1');
  assert.deepEqual(store.forOwner('entity:1'), []);
  assert.deepEqual(store.forOwner('container:2'), [store.get(1)]);
  assert.equal(total(store), 4);
  assert.equal(energy(store), sensibleEnergyJ(before));
  assert.deepEqual(receipt, { revision: 1, createdIds: [], retiredIds: [], heat: [] });
  assert.equal(store.snapshot().nextSampleId, 2);
});

test('split retains parent ID, allocates child and preserves mass and energy', () => {
  const store = init(sample('water', 4.5, -10));
  const before = energy(store);
  const receipt = tx(store, split(1, 1.25));
  assert.deepEqual(receipt.createdIds, [2]);
  assert.equal(store.get(1).massKg, 3.25);
  assert.equal(store.get(2).massKg, 1.25);
  for (const s of store.forOwner('entity:1')) {
    assert.equal(s.temperatureC, -10);
    assert.equal(s.phase, 'liquid');
  }
  close(total(store), 4.5);
  close(energy(store), before);
});

test('combine uses weighted equilibrium, retires both input IDs and allocates a fresh ID', () => {
  const store = init(sample('wood', 2, 80), sample('wood', 6, 20));
  const before = energy(store);
  const receipt = tx(store, combine(1, 2));
  assert.deepEqual(receipt.createdIds, [3]);
  assert.deepEqual(receipt.retiredIds, [1, 2]);
  assert.equal(store.get(1), undefined);
  assert.equal(store.get(2), undefined);
  assert.equal(store.get(3).massKg, 8);
  close(store.get(3).temperatureC, 35);
  close(energy(store), before);
  fails(store, transfer(1));
  assert.deepEqual(tx(store, split(3, 1)).createdIds, [4]);
});

test('ordered batch supports split, transfer, combine and conserves across owners', () => {
  const store = init(sample('stone', 8, 50), sample('stone', 3, 10, 'container:2'));
  const before = energy(store);
  const receipt = tx(store, split(1, 2), transfer(3), combine(2, 3));
  assert.deepEqual(receipt.createdIds, [3, 4]);
  assert.deepEqual(receipt.retiredIds, [2, 3]);
  assert.equal(store.get(1).massKg, 6);
  assert.equal(store.get(4).ownerId, 'container:2');
  assert.equal(store.get(4).massKg, 5);
  close(total(store), 11);
  close(energy(store), before);
  assert.equal(store.revision, 1);
});

test('thermal contact delegates to existing solver and atomically commits both persistent samples', () => {
  const store = init(sample('stone', 2, 90), sample('water', 1, 20, 'container:2'));
  const a = store.get(1), b = store.get(2), before = energy(store);
  const op = heat(1, 2);
  const expected = stepThermalContact(a, b, op.contact);
  const receipt = tx(store, op);
  assert.deepEqual(store.get(1), { ...a, temperatureC: expected.a.temperatureC });
  assert.deepEqual(store.get(2), { ...b, temperatureC: expected.b.temperatureC });
  assert.deepEqual(receipt.heat, [{ a: 1, b: 2, transferredEnergyJ: expected.transferredEnergyJ }]);
  assert.ok(receipt.heat[0].transferredEnergyJ > 0);
  close(energy(store), before);
  assert.equal(total(store), 3);
  assert.equal(store.snapshot().nextSampleId, 3);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.heat) && Object.isFrozen(receipt.heat[0]));
});

test('reverse thermal transfer, zero conductance and repeated contacts preserve bounds', () => {
  const store = init(sample('water', 1, 20), sample('stone', 2, 90));
  const before = energy(store);
  assert.equal(tx(store, heat(1, 2, 0)).heat[0].transferredEnergyJ, 0);
  for (let i = 0; i < 200; i++) {
    const a = store.get(1).temperatureC, b = store.get(2).temperatureC;
    const receipt = tx(store, heat(1, 2));
    assert.ok(receipt.heat[0].transferredEnergyJ <= 0);
    assert.ok(store.get(1).temperatureC >= a);
    assert.ok(store.get(2).temperatureC <= b);
    assert.ok(store.get(1).temperatureC <= store.get(2).temperatureC);
  }
  close(energy(store), before);
});

test('invalid samples and unsupported phases cannot enter registry', () => {
  for (const patch of [
    { massKg: 0 }, { massKg: -1 }, { massKg: NaN }, { massKg: Infinity },
    { massKg: Number.MAX_VALUE }, { materialId: 'unknown' }, { phase: 'gas' },
    { temperatureC: -274 }, { temperatureC: Infinity }, { ownerId: '' }, { ownerId: 5 },
  ]) assert.throws(() => init({ ...sample(), ...patch }));
  assert.throws(() => init(null));
});

test('invalid operations cannot duplicate ownership, spend nonexistent IDs or create matter', () => {
  const store = init(sample(), sample('stone'), sample('wood', 1, 20, 'other'));
  for (const op of [
    transfer(1, 'wrong'), transfer(1, 'entity:1', ''), transfer(1, 'entity:1', 'entity:1'),
    transfer(99), split(1, 0), split(1, -1), split(1, 4), split(1, 5),
    split(1, NaN), split(1, Infinity), split(1, 1e-30), combine(1, 1), combine(1, 2),
    combine(1, 3), heat(1, 1), heat(1, 99), heat(1, 2, -1),
    { kind: 'create', sample: sample() }, { kind: 'retire', sampleId: 1 }, null,
  ]) fails(store, op);
  fails(store);
});

test('failure after staged allocation, heat and retirement rolls back every change', () => {
  const store = init(sample('wood', 4, 80), sample('wood', 3, 20));
  fails(store, split(1, 1), heat(1, 2), combine(2, 3), transfer(3));
  assert.equal(store.revision, 0);
  assert.equal(store.snapshot().nextSampleId, 3);
  assert.deepEqual(tx(store, split(1, 1)).createdIds, [3]);
  assert.throws(() => store.transact(0, [transfer(1)]), /Stale/);
  assert.equal(store.get(1).ownerId, 'entity:1');
});

test('legacy initialization uses explicit bridge calibration without default unit mass', () => {
  const calibration = [{ resourceId: 'log', materialId: 'wood', kgPerUnit: 2.5 }];
  const entries = [{ ownerId: 'entity:1', resourceId: 'log', units: 3, temperatureC: 25 }];
  const store = PhysicalInventory.initializeLegacy(entries, calibration);
  assert.equal(store.get(1).massKg, 7.5);
  assert.equal(store.get(1).materialId, 'wood');
  assert.equal(store.get(1).temperatureC, 25);
  assert.throws(() => PhysicalInventory.initializeLegacy(entries, []));
  assert.throws(() => PhysicalInventory.initializeLegacy(entries, [{ ...calibration[0], kgPerUnit: 0 }]));
  assert.throws(() => PhysicalInventory.initializeLegacy([{ ...entries[0], units: -1 }], calibration));
  assert.throws(() => PhysicalInventory.initializeLegacy([{ ...entries[0], units: 0 }], calibration));
});

test('JSON restoration preserves revision and allocation gaps; snapshot is frozen and detached', () => {
  const store = init(sample(), sample());
  tx(store, combine(1, 2), split(3, 1));
  const snapshot = store.snapshot();
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.samples));
  const parsed = JSON.parse(JSON.stringify(snapshot));
  const restored = PhysicalInventory.restore(parsed);
  assert.deepEqual(restored.snapshot(), snapshot);
  parsed.samples[0].massKg = 99;
  assert.notEqual(restored.get(3).massKg, 99);
  assert.deepEqual(tx(restored, split(3, 1)).createdIds, [5]);
  assert.equal(snapshot.nextSampleId, 5);
  assert.equal(store.get(3).massKg, 7);
});

test('restore rejects duplicate ownership, invalid allocation, version and sample data', () => {
  const s = init(sample()).snapshot();
  for (const invalid of [
    { ...s, version: 2 }, { ...s, revision: -1 }, { ...s, nextSampleId: 1 },
    { ...s, nextSampleId: Infinity }, { ...s, samples: [...s.samples, { ...s.samples[0], ownerId: 'other' }] },
    { ...s, samples: [{ ...s.samples[0], sampleId: 0 }] },
    { ...s, samples: [{ ...s.samples[0], massKg: -1 }] },
    { ...s, samples: [{ ...s.samples[0], phase: 'gas' }] },
  ]) assert.throws(() => PhysicalInventory.restore(invalid));
  const exhausted = PhysicalInventory.restore({ ...s, nextSampleId: Number.MAX_SAFE_INTEGER });
  fails(exhausted, split(1, 1));
  const revisionLimit = PhysicalInventory.restore({ ...s, revision: Number.MAX_SAFE_INTEGER });
  fails(revisionLimit, transfer(1));
});

test('numerically unresolved mass changes and pair energy overflow fail atomically', () => {
  const store = init(sample('wood', 1e16), sample('wood', 3));
  fails(store, split(1, 3));
  fails(store, combine(1, 2));
  const huge = init(sample('stone', 5e302, 0), sample('stone', 5e302, 0));
  fails(huge, heat(1, 2));
  fails(huge, combine(1, 2));
});

test('identical operation sequences and restored continuation are reproducible', () => {
  const run = () => {
    const store = init(sample('wood', 10, 80), sample('wood', 4, 20));
    tx(store, split(1, 2), transfer(3), heat(2, 3));
    const restored = PhysicalInventory.restore(JSON.parse(JSON.stringify(store.snapshot())));
    const ops = [transfer(3, 'container:2', 'entity:1'), combine(2, 3)];
    assert.deepEqual(tx(store, ...ops), tx(restored, ...ops));
    assert.deepEqual(store.snapshot(), restored.snapshot());
    return store.snapshot();
  };
  assert.deepEqual(run(), run());
});
