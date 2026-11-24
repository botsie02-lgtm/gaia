import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPhysicalBatch, createResourceConverter, stepPhysicalBatch, validatePhysicalRule,
} from '../.sim-test/physics/index.js';
import { getMaterial } from '../.sim-test/materials/index.js';
import { validateRule } from '../.sim-test/processes/index.js';

const water = (massKg = 1, temperatureC = 20) =>
  ({ materialId: 'water', phase: 'liquid', massKg, temperatureC });
const stone = { materialId: 'stone', phase: 'solid', massKg: 2, temperatureC: 20 };
const heat = {
  id: 'warm-liquid-water',
  inputs: [{ materialId: 'water', phase: 'liquid', massKg: 1 }],
  outputs: [water(1, 30)],
  minTemperatureC: 20, maxTemperatureC: 20, durationTicks: 2,
  energyPerTickJ: getMaterial('water').specificHeatJPerKgK * 1 * 10 / 2,
};

test('catalog rejects unsupported gas and unknown material even when engine accepts rule', () => {
  for (const rule of [
    { ...heat, outputs: [{ ...water(1, 100), phase: 'gas' }] },
    { ...heat, inputs: [{ ...heat.inputs[0], phase: 'gas' }] },
    { ...heat, outputs: [{ ...water(), materialId: 'steam' }] },
    { ...heat, inputs: [{ ...heat.inputs[0], materialId: 'toString' }] },
  ]) {
    assert.doesNotThrow(() => validateRule(rule));
    assert.throws(() => validatePhysicalRule(rule), /Unsupported material phase|Unknown material ID/);
  }
});

test('delegates generic rule validation and rejects unsupported chemical transmutation', () => {
  assert.throws(() => validatePhysicalRule({ ...heat, outputs: [water(0.9)] }), /unbalanced/);
  assert.throws(() => validatePhysicalRule({ ...heat, durationTicks: 0 }));
  assert.throws(() => validatePhysicalRule({ ...heat, energyPerTickJ: -1 }));
  assert.throws(() => validatePhysicalRule({
    ...heat, outputs: [{ ...water(), materialId: 'ash', phase: 'solid' }],
  }), /Unsupported material transformation/);
  assert.doesNotThrow(() => validatePhysicalRule({ ...heat, outputs: [water(0.25, 30), water(0.75, 30)] }));
});

test('constant-phase heating conserves mass and accounts for sensible heat and energy', () => {
  const initial = createPhysicalBatch(heat, [water(2), stone], 50000);
  const first = stepPhysicalBatch(initial);
  assert.equal(first.status, 'progressed');
  assert.equal(first.next.process.completedTicks, 1);
  assert.deepEqual(first.next.samples, initial.samples);
  assert.equal(first.next.availableEnergyJ, 29090);
  const second = stepPhysicalBatch(first.next);
  assert.equal(second.status, 'completed');
  assert.deepEqual(second.next.samples, [water(), stone, water(1, 30)]);
  const mass = samples => samples.reduce((sum, s) => sum + s.massKg, 0);
  assert.equal(mass(initial.samples), mass(second.next.samples));
  const debit = first.energyConsumedJ + second.energyConsumedJ;
  assert.equal(debit, 41820);
  assert.equal(initial.availableEnergyJ - second.next.availableEnergyJ, debit);
  assert.equal(debit, getMaterial('water').specificHeatJPerKgK * 10);
  const repeated = stepPhysicalBatch(second.next);
  assert.equal(repeated.energyConsumedJ, 0);
  assert.deepEqual(repeated.next, second.next);
});

test('pauses for temperature, input mass or energy without committing any debit', () => {
  for (const [samples, energy, reason] of [
    [[water(1, 19)], 50000, 'temperature'],
    [[water(0.5)], 50000, 'insufficient-input'],
    [[water()], 20909, 'insufficient-energy'],
  ]) {
    const initial = createPhysicalBatch(heat, samples, energy);
    const step = stepPhysicalBatch(initial);
    assert.equal(step.status, 'paused');
    assert.equal(step.pauseReason, reason);
    assert.equal(step.energyConsumedJ, 0);
    assert.deepEqual(step.next, initial);
  }
  const partial = stepPhysicalBatch(createPhysicalBatch(heat, [water()], 20910)).next;
  const paused = stepPhysicalBatch(partial);
  assert.equal(paused.pauseReason, 'insufficient-energy');
  assert.equal(paused.next.process.completedTicks, 1);
  assert.equal(paused.next.availableEnergyJ, 0);
});

test('snapshots are immutable, detached and deterministic after JSON round trip', () => {
  const editable = structuredClone(heat);
  const samples = [water()];
  const initial = createPhysicalBatch(editable, samples, 50000);
  editable.outputs[0].temperatureC = 99;
  samples[0].massKg = 9;
  assert.equal(initial.samples[0].massKg, 1);
  assert.equal(initial.process.rule.outputs[0].temperatureC, 30);
  const first = stepPhysicalBatch(initial);
  assert.deepEqual(first, stepPhysicalBatch(initial));
  assert.deepEqual(stepPhysicalBatch(first.next), stepPhysicalBatch(JSON.parse(JSON.stringify(first.next))));
  for (const item of [first, first.next, first.next.samples, first.next.samples[0],
    first.next.process, first.next.process.rule, first.next.process.rule.inputs[0]]) {
    assert.equal(Object.isFrozen(item), true);
  }
  assert.throws(() => { first.next.availableEnergyJ = 0; }, TypeError);
});

test('rejects invalid inventories, budgets, progress and unrepresentable energy debits', () => {
  for (const sample of [water(-1), water(Infinity), water(1, -274),
    { ...water(), phase: 'gas' }, { ...water(), materialId: 'unknown' }]) {
    assert.throws(() => createPhysicalBatch(heat, [sample], 50000));
  }
  for (const energy of [-1, NaN, Infinity]) {
    assert.throws(() => createPhysicalBatch(heat, [water()], energy));
  }
  const initial = createPhysicalBatch(heat, [water()], 50000);
  assert.throws(() => stepPhysicalBatch({ ...initial, samples: [{ ...water(), phase: 'gas' }] }));
  assert.throws(() => stepPhysicalBatch({ ...initial, process: { ...initial.process, completedTicks: 3 } }));
  assert.throws(() => stepPhysicalBatch(createPhysicalBatch(heat, [water()], Number.MAX_VALUE)), /resolution/);
});

test('legacy units require explicit per-resource calibration, including reverse mapping', () => {
  const config = [{ resourceId: 'logs', materialId: 'wood', kgPerUnit: 2.5 },
    { resourceId: 'rocks', materialId: 'stone', kgPerUnit: 0.25 }];
  const converter = createResourceConverter(config);
  config[0].kgPerUnit = 1;
  assert.deepEqual(converter.toSample('logs', 4, 20),
    { materialId: 'wood', phase: 'solid', massKg: 10, temperatureC: 20 });
  assert.equal(converter.toUnits('logs', converter.toSample('logs', 4, 20)), 4);
  assert.equal(converter.toSample('rocks', 4, 20).massKg, 1);
  assert.equal(converter.toSample('rocks', 0, 20).massKg, 0);
  assert.throws(() => converter.toSample('wood', 1, 20), /No mass calibration/);
  assert.throws(() => converter.toUnits('logs', stone), /mismatch/);
  assert.throws(() => converter.toUnits('rocks', { ...stone, phase: 'gas' }));
  for (const value of [-1, NaN, Infinity]) assert.throws(() => converter.toSample('logs', value, 20));
  assert.throws(() => converter.toSample('logs', 1, NaN));
  assert.throws(() => converter.toSample('logs', Number.MAX_VALUE, 20));
  assert.throws(() => converter.toSample('rocks', Number.MIN_VALUE, 20), /underflow/);
});

test('invalid calibration is rejected rather than defaulting to one kilogram', () => {
  const base = { resourceId: 'logs', materialId: 'wood', kgPerUnit: 2 };
  for (const patch of [{ kgPerUnit: 0 }, { kgPerUnit: -1 }, { kgPerUnit: NaN },
    { kgPerUnit: Infinity }, { materialId: 'unknown' }, { resourceId: ' ' }]) {
    assert.throws(() => createResourceConverter([{ ...base, ...patch }]));
  }
  assert.throws(() => createResourceConverter([base, base]));
  assert.throws(() => createResourceConverter([]).toSample('logs', 1, 20));
});
