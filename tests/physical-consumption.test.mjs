import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalInventory } from '../.sim-test/inventory/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';
import { createBiologicalState } from '../.sim-test/biology/index.js';
import { PhysicalConsumption, bodyWaterOwnerId, CONSUMPTION_MASS_QUANTUM_KG as Q }
  from '../.sim-test/biology/consumption/index.js';

const SOURCE = 'hub:1', OTHER = 'deposit:4';
const water = (massKg, ownerId = SOURCE, temperatureC = 20) =>
  ({ materialId: 'water', phase: 'liquid', massKg, ownerId, temperatureC });
const wood = (massKg, ownerId = SOURCE) =>
  ({ materialId: 'wood', phase: 'solid', massKg, ownerId, temperatureC: 20 });
const registration = (agentId = 2, capacityKg = 2, thirstReliefPerKg = 0.5, thirst = 0.75) =>
  ({ agentId, config: { capacityKg, thirstReliefPerKg },
    physiology: createBiologicalState({ hunger: 0.3, thirst, fatigue: 0.4, condition: 0.8 }) });
const setup = (samples = [water(1)], bodies = [registration()], sources = [SOURCE]) => {
  const inventory = PhysicalInventory.initialize(samples);
  const consumption = PhysicalConsumption.initialize(inventory, sources, bodies);
  return { inventory, consumption };
};
const request = (inventory, overrides = {}) => ({
  kind: 'drink', materialId: 'water', phase: 'liquid', agentId: 2,
  sourceOwnerId: SOURCE, massKg: 0.25, sequence: 1,
  expectedInventoryRevision: inventory.revision, ...overrides,
});
const near = (a, b, tolerance = 1e-12) =>
  assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);
const save = ({ inventory, consumption }) =>
  JSON.stringify({ inventory: inventory.snapshot(), consumption: consumption.snapshot() });
function restore(saved) {
  const data = JSON.parse(saved);
  const inventory = PhysicalInventory.restore(data.inventory);
  const consumption = PhysicalConsumption.restore(inventory, data.consumption);
  return { inventory, consumption };
}
function rejectUnchanged(system, overrides, pattern) {
  const before = save(system);
  assert.throws(() => system.consumption.drink(request(system.inventory, overrides)), pattern);
  assert.equal(save(system), before);
}
function totals(inventory) {
  const masses = {};
  let sensible = 0;
  for (const sample of inventory.snapshot().samples) {
    masses[sample.materialId] = (masses[sample.materialId] ?? 0) + sample.massKg;
    sensible += sensibleEnergyJ(sample);
  }
  return { masses, sensible };
}

test('registered body starts empty without creating water; configuration and state are detached', () => {
  const initial = registration();
  const system = setup([], [initial]);
  const { inventory, consumption } = system;
  const body = consumption.getBody(2);
  assert.equal(body.reservoirOwnerId, 'body-water:2');
  assert.equal(body.lastSequence, 0);
  assert.equal(consumption.reservoirMassKg(2), 0);
  assert.deepEqual(inventory.snapshot().samples, []);
  initial.config.capacityKg = 99;
  assert.equal(body.config.capacityKg, 2);
  assert.ok(Object.isFrozen(body) && Object.isFrozen(body.config) && Object.isFrozen(body.physiology));
  assert.ok(Object.isFrozen(consumption.snapshot().bodies));
  assert.throws(() => PhysicalConsumption.initialize(inventory, [SOURCE], [initial]), /already exists/);
});

test('partial drinking commits exact kg and only thirst relief; preserves sample fields and energy', () => {
  const { inventory, consumption } = setup([water(1, SOURCE, 35), wood(2)]);
  const before = totals(inventory);
  const old = consumption.getBody(2);
  const receipt = consumption.drink(request(inventory));
  assert.equal(receipt.massKg, 0.25);
  assert.equal(receipt.mappedRelief, 0.125);
  assert.equal(receipt.thirstRelief, 0.125);
  assert.equal(receipt.reservoirMassKgAfter, 0.25);
  assert.equal(receipt.inventoryRevision, 1);
  assert.equal(receipt.sequence, 1);
  assert.equal(receipt.status, 'succeeded');
  assert.deepEqual(receipt.movements, [{ sourceSampleId: 1, transferredSampleId: 3, massKg: 0.25 }]);
  assert.deepEqual(inventory.get(1), { ...water(0.75, SOURCE, 35), sampleId: 1 });
  assert.deepEqual(inventory.get(3), { ...water(0.25, 'body-water:2', 35), sampleId: 3 });
  assert.deepEqual(inventory.get(2), { ...wood(2), sampleId: 2 });
  assert.deepEqual(receipt.physiology, { ...old.physiology, thirst: 0.625 });
  assert.equal(consumption.getBody(2).lastSequence, 1);
  assert.equal(consumption.getBody(2).physiology, receipt.physiology);
  assert.equal(old.physiology.thirst, 0.75);
  assert.equal(old.lastSequence, 0);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.movements) &&
    receipt.movements.every(Object.isFrozen));
  assert.deepEqual(totals(inventory).masses, before.masses);
  near(totals(inventory).sensible, before.sensible);
});

test('whole samples retain IDs and ordered multi-sample drink preserves separate temperatures', () => {
  const { inventory, consumption } = setup([wood(2), water(0.25, SOURCE, 10),
    water(0.75, SOURCE, 60), water(2, OTHER, 5)], [registration()], [SOURCE, OTHER]);
  const before = totals(inventory);
  const receipt = consumption.drink(request(inventory, { massKg: 0.5 }));
  assert.deepEqual(receipt.movements, [
    { sourceSampleId: 2, transferredSampleId: 2, massKg: 0.25 },
    { sourceSampleId: 3, transferredSampleId: 5, massKg: 0.25 },
  ]);
  assert.deepEqual(inventory.forOwner('body-water:2').map(s => [s.sampleId, s.massKg, s.temperatureC]),
    [[2, 0.25, 10], [5, 0.25, 60]]);
  assert.equal(inventory.get(3).massKg, 0.5);
  assert.equal(inventory.get(4).ownerId, OTHER);
  assert.equal(inventory.nextSampleId, 6);
  assert.equal(inventory.revision, 1);
  assert.deepEqual(totals(inventory).masses, before.masses);
  near(totals(inventory).sensible, before.sensible);
});

test('insufficient water never grants a partial drink, even with other material present', () => {
  const system = setup([water(0.25), wood(3), water(1, OTHER)], [registration()], [SOURCE, OTHER]);
  rejectUnchanged(system, { massKg: 0.5 }, /Insufficient liquid water/);
  rejectUnchanged(system, { sourceOwnerId: 'agent:999' }, /Unregistered source/);
  const receipt = system.consumption.drink(request(system.inventory));
  assert.equal(receipt.movements[0].transferredSampleId, 1);
  assert.equal(system.inventory.forOwner(SOURCE).length, 1);
  rejectUnchanged(system, { sequence: 2 }, /Insufficient liquid water/);
});

test('capacity derives from actual retained samples; exact fill allowed, overfill denied', () => {
  const system = setup([water(1), water(0.25, bodyWaterOwnerId(2), 15)], [registration(2, 0.5)]);
  assert.equal(system.consumption.reservoirMassKg(2), 0.25);
  rejectUnchanged(system, { massKg: 0.5 }, /capacity/);
  const result = system.consumption.drink(request(system.inventory));
  assert.equal(result.reservoirMassKgAfter, 0.5);
  rejectUnchanged(system, { sequence: 2, massKg: Q }, /capacity/);
  assert.equal(system.inventory.forOwner(SOURCE)[0].massKg, 0.75);
  const zero = setup([water(1)], [registration(2, 0)]);
  rejectUnchanged(zero, {}, /capacity/);
});

test('a real staged split failure rolls back earlier whole transfer, physiology and sequence', () => {
  const initial = PhysicalInventory.initialize([water(0.25), water(1)]);
  // Exhaust the allocation cursor: whole transfer stages, split creation fails.
  const inventory = PhysicalInventory.restore({ ...initial.snapshot(), nextSampleId: Number.MAX_SAFE_INTEGER });
  const consumption = PhysicalConsumption.initialize(inventory, [SOURCE], [registration()]);
  const system = { inventory, consumption };
  const before = save(system);
  assert.throws(() => consumption.drink(request(inventory, { massKg: 0.5 })), /Invalid inventory integer/);
  assert.equal(save(system), before);
  assert.equal(inventory.get(1).ownerId, SOURCE);
  assert.equal(consumption.getBody(2).lastSequence, 0);
  // A failed sequence can be retried; a whole sample needs no new ID.
  const receipt = consumption.drink(request(inventory, { massKg: 0.25 }));
  assert.equal(receipt.sequence, 1);
  assert.equal(inventory.get(1).ownerId, 'body-water:2');
});

test('receipt/request replay, stale revisions and out-of-order sequences cannot relieve thirst', () => {
  const system = setup([water(2)]);
  const { inventory, consumption } = system;
  const original = request(inventory);
  const receipt = consumption.drink(original);
  const before = save(system);
  assert.throws(() => consumption.drink(original), /sequence/);
  assert.throws(() => consumption.drink(receipt), /sequence/);
  rejectUnchanged(system, { sequence: 1 }, /sequence/);
  rejectUnchanged(system, { sequence: 3 }, /sequence/);
  rejectUnchanged(system, { sequence: 2, expectedInventoryRevision: 0 }, /Stale/);
  assert.equal(save(system), before);
  consumption.advanceIndividual(2, 3600, { kind: 'idle', status: 'succeeded' });
  rejectUnchanged(system, { sequence: 1 }, /sequence/);
  const second = consumption.drink(request(inventory, { sequence: 2 }));
  near(second.physiology.thirst, 0.58);
  assert.equal(second.sequence, 2);
});

test('restore preserves exactly-once cursor, canonical state and deterministic continuation', () => {
  const live = setup([water(2), water(1, OTHER)], [registration(3), registration(2)], [SOURCE, OTHER]);
  live.consumption.drink(request(live.inventory));
  const saved = save(live);
  const resumed = restore(saved);
  assert.equal(save(resumed), saved);
  rejectUnchanged(resumed, { sequence: 1 }, /sequence/);
  const proceed = ({ inventory, consumption }) => {
    consumption.advanceIndividual(2, 7200, { kind: 'idle', status: 'succeeded' });
    return [
      consumption.drink(request(inventory, { agentId: 3, sourceOwnerId: OTHER, massKg: 0.5 })),
      consumption.drink(request(inventory, { sequence: 2, massKg: 0.5 })),
    ];
  };
  assert.deepEqual(proceed(live), proceed(resumed));
  assert.equal(save(live), save(resumed));
  assert.deepEqual(resumed.consumption.snapshot().bodies.map(b => b.agentId), [2, 3]);
  assert.deepEqual(resumed.consumption.snapshot().sourceOwners, [OTHER, SOURCE]);
});

test('individuals maintain independent reservoir, relief mapping and sequence', () => {
  const system = setup([water(2)], [registration(2, 1, 0.5), registration(3, 1, 1)]);
  const { inventory, consumption } = system;
  const initialThree = consumption.getBody(3);
  consumption.drink(request(inventory));
  assert.equal(consumption.getBody(3), initialThree);
  assert.equal(consumption.reservoirMassKg(3), 0);
  const third = consumption.drink(request(inventory, { agentId: 3 }));
  assert.equal(third.sequence, 1);
  assert.equal(third.thirstRelief, 0.25);
  assert.equal(consumption.getBody(2).physiology.thirst, 0.625);
  assert.equal(consumption.getBody(3).physiology.thirst, 0.5);
  assert.equal(consumption.reservoirMassKg(2), 0.25);
  assert.equal(consumption.reservoirMassKg(3), 0.25);
  rejectUnchanged(system, { agentId: 999 }, /Unregistered body/);
});

test('drinking saturates abstract relief but retains all consumed mass; zero relief is permitted', () => {
  const system = setup([water(1)], [registration(2, 1, 4, 0.1), registration(3, 1, 0)]);
  const { inventory, consumption } = system;
  const receipt = consumption.drink(request(inventory, { massKg: 0.5 }));
  assert.equal(receipt.mappedRelief, 1);
  assert.equal(receipt.thirstRelief, 0.1);
  assert.equal(receipt.physiology.thirst, 0);
  assert.equal(consumption.reservoirMassKg(2), 0.5);
  const noRelief = consumption.drink(request(inventory, { agentId: 3, massKg: 0.5 }));
  assert.equal(noRelief.thirstRelief, 0);
  assert.equal(consumption.reservoirMassKg(3), 0.5);
  assert.equal(inventory.forOwner(SOURCE).length, 0);
});

test('feeding, incorrect phase/material and body-water withdrawal are not supported', () => {
  const system = setup([water(1), wood(1)]);
  for (const overrides of [
    { kind: 'feed', foodProfileId: 'wood' }, { materialId: 'wood' },
    { materialId: 'charcoal' }, { phase: 'solid' }, { phase: 'gas' },
  ]) rejectUnchanged(system, overrides, /Only liquid water/);
  rejectUnchanged(system, { sourceOwnerId: 'body-water:2' }, /Invalid source owner/);
  rejectUnchanged(system, { sourceOwnerId: 'hub:01' }, /Invalid source owner/);
});

test('invalid registrations, owners, configurations and occupied reservoirs are rejected', () => {
  for (const id of [0, -1, NaN, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => bodyWaterOwnerId(id));
  }
  for (const source of ['hub:0', 'hub:01', 'body-water:2', 'hub:9007199254740992', null]) {
    assert.throws(() => setup([], [registration()], [source]));
  }
  assert.throws(() => setup([], [registration()], [SOURCE, SOURCE]), /Duplicate source/);
  assert.throws(() => setup([], [registration(), registration()]), /Duplicate body/);
  for (const capacity of [-1, NaN, Infinity, 0.1, Number.MAX_VALUE, '2', null]) {
    assert.throws(() => setup([], [registration(2, capacity)]));
  }
  for (const rate of [-1, NaN, Infinity, '0.5', null, Number.MAX_VALUE]) {
    assert.throws(() => setup([], [registration(2, 2, rate)]));
  }
  assert.throws(() => setup([wood(1, 'body-water:2')]), /incompatible material/);
  assert.throws(() => setup([water(3, 'body-water:2')]), /exceeds capacity/);
  assert.throws(() => setup([water(0.1, 'body-water:2')]), /grid/);
  assert.throws(() => setup([], [{ ...registration(), physiology: { version: 1 } }]));
});

test('numerical limits reject malformed or off-grid requests, unsafe counters and underflow', () => {
  const system = setup();
  for (const massKg of [0, -1, NaN, Infinity, 0.1, Q / 2, '0.25', Number.MAX_VALUE]) {
    rejectUnchanged(system, { massKg });
  }
  for (const sequence of [0, -1, 1.5, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
    rejectUnchanged(system, { sequence });
  }
  for (const expectedInventoryRevision of [-1, NaN, 0.5, '0']) {
    rejectUnchanged(system, { expectedInventoryRevision });
  }
  const offGrid = setup([water(0.1)]);
  rejectUnchanged(offGrid, { massKg: Q }, /grid/);
  const tinyRate = setup([water(1)], [registration(2, 1, Number.MIN_VALUE)]);
  rejectUnchanged(tinyRate, { massKg: Q }, /Unrepresentable thirst relief/);
  const initial = PhysicalInventory.initialize([water(1)]);
  const inventory = PhysicalInventory.restore({ ...initial.snapshot(), revision: Number.MAX_SAFE_INTEGER });
  const consumption = PhysicalConsumption.initialize(inventory, [SOURCE], [registration()]);
  rejectUnchanged({ inventory, consumption }, {}, /next inventory revision/);
});

test('largest safe grid capacity cannot overflow or lose a positive quantum', () => {
  const cap = Number.MAX_SAFE_INTEGER * Q;
  const system = setup([water(cap - Q, 'body-water:2'), water(2 * Q)], [registration(2, cap, 0)]);
  assert.equal(system.consumption.reservoirMassKg(2), cap - Q);
  rejectUnchanged(system, { massKg: 2 * Q }, /capacity/);
  system.consumption.drink(request(system.inventory, { massKg: Q }));
  assert.equal(system.consumption.reservoirMassKg(2), cap);
  rejectUnchanged(system, { sequence: 2, massKg: Q }, /capacity/);
});

test('malformed or mismatched restoration cannot reset a live authority or invent a valid cursor', () => {
  const live = setup();
  live.consumption.drink(request(live.inventory));
  const data = JSON.parse(save(live));
  const check = (snapshot) =>
    assert.throws(() => PhysicalConsumption.restore(PhysicalInventory.restore(data.inventory), snapshot));
  check({ ...data.consumption, version: 2 });
  check({ ...data.consumption, inventoryRevision: 0 });
  check({ ...data.consumption, bodies: [{ ...data.consumption.bodies[0], lastSequence: -1 }] });
  check({ ...data.consumption, bodies: [{ ...data.consumption.bodies[0], lastSequence: 2 }] });
  check({ ...data.consumption, bodies: [{ ...data.consumption.bodies[0], reservoirOwnerId: 'body-water:3' }] });
  check({ ...data.consumption, bodies: [data.consumption.bodies[0],
    { ...data.consumption.bodies[0], agentId: 3, reservoirOwnerId: 'body-water:3' }] });
  assert.throws(() => PhysicalConsumption.restore(live.inventory, data.consumption), /already exists/);
});

test('external inventory revision changes invalidate old requests, no duplicate matter authority', () => {
  const system = setup([water(1), water(1, OTHER)], [registration()], [SOURCE, OTHER]);
  const { inventory, consumption } = system;
  const stale = request(inventory);
  inventory.transact(inventory.revision, [{ kind: 'transfer', sampleId: 2, fromOwnerId: OTHER, toOwnerId: SOURCE }]);
  const before = save(system);
  assert.throws(() => consumption.drink(stale), /Stale/);
  assert.equal(save(system), before);
  const receipt = consumption.drink(request(inventory));
  assert.equal(receipt.inventoryRevision, 2);
  assert.equal(receipt.sequence, 1);
});

test('extended deterministic alternating drink sequence conserves matter and sensible energy', () => {
  const scenario = () => {
    const system = setup([water(1, SOURCE, 12), water(1, OTHER, 42), wood(2)],
      [registration(2, 1), registration(3, 1)], [SOURCE, OTHER]);
    const { inventory, consumption } = system;
    const before = totals(inventory);
    for (let i = 1; i <= 32; i++) {
      for (const [agentId, sourceOwnerId] of [[2, SOURCE], [3, OTHER]]) {
        consumption.advanceIndividual(agentId, 1800, { kind: 'idle', status: 'succeeded' });
        consumption.drink(request(inventory, { agentId, sourceOwnerId, sequence: i, massKg: 1 / 32 }));
        assert.deepEqual(totals(inventory).masses, before.masses);
        near(totals(inventory).sensible, before.sensible);
      }
    }
    assert.equal(inventory.revision, 64);
    assert.equal(consumption.reservoirMassKg(2), 1);
    assert.equal(consumption.reservoirMassKg(3), 1);
    assert.equal(inventory.forOwner(SOURCE).length + inventory.forOwner(OTHER).length, 1); // wood only
    assert.equal(inventory.snapshot().samples.length, 65);
    return save(system);
  };
  assert.equal(scenario(), scenario());
});
