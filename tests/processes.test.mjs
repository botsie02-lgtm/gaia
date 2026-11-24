import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcess, stepProcess, validateRule } from '../.sim-test/processes/index.js';

// Illustrative rule, not a calibrated boiling/latent heat model.
const rule = {
  id: 'water-vapour',
  inputs: [{ materialId: 'water', massKg: 1, phase: 'liquid' }],
  outputs: [{ materialId: 'water', massKg: 1, phase: 'gas', temperatureC: 100 }],
  minTemperatureC: 100,
  maxTemperatureC: 120,
  durationTicks: 3,
  energyPerTickJ: 1000,
};
const water = (massKg = 1, temperatureC = 100) => ({
  materialId: 'water', phase: 'liquid', massKg, temperatureC,
});
const totalMass = samples => samples.reduce((sum, sample) => sum + sample.massKg, 0);

test('a phase change advances one tick at a time and conserves batch mass', () => {
  const samples = Object.freeze([Object.freeze(water(2))]);
  let state = createProcess(rule);
  for (let i = 1; i <= 3; i++) {
    const result = stepProcess(state, samples, 1000);
    assert.equal(result.state.completedTicks, i);
    assert.equal(result.energyConsumedJ, 1000);
    state = result.state;
    if (i < 3) {
      assert.equal(result.status, 'progressed');
      assert.deepEqual(result.samples, samples);
    } else {
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.samples, [water(), rule.outputs[0]]);
      assert.equal(totalMass(result.samples), totalMass(samples));
      assert.deepEqual(samples, [water(2)]);
      const repeated = stepProcess(state, result.samples, 1000);
      assert.equal(repeated.energyConsumedJ, 0);
      assert.deepEqual(repeated.samples, result.samples);
      assert.equal(repeated.status, 'completed');
    }
  }
});

test('temperature, mass and energy pauses spend nothing and retain partial progress', () => {
  const first = stepProcess(createProcess(rule), [water()], 1000);
  for (const [samples, energy, reason] of [
    [[water(1, 99)], 1000, 'temperature'],
    [[water(1, 121)], 1000, 'temperature'],
    [[water(0.9)], 1000, 'insufficient-input'],
    [[{ ...water(), phase: 'gas' }], 1000, 'insufficient-input'],
    [[water()], 999, 'insufficient-energy'],
  ]) {
    const result = stepProcess(first.state, samples, energy);
    assert.equal(result.status, 'paused');
    assert.equal(result.pauseReason, reason);
    assert.equal(result.energyConsumedJ, 0);
    assert.deepEqual(result.state, first.state);
    assert.deepEqual(result.samples, samples);
  }
  const second = stepProcess(first.state, [water()], 1000);
  assert.equal(second.state.completedTicks, 2);
  assert.equal(stepProcess(second.state, [water()], 1000).status, 'completed');
});

test('deterministic replay with pauses and split hot samples', () => {
  const run = () => {
    let state = createProcess(rule);
    return [999, 1000, 1000, 1000].map(energy => {
      const result = stepProcess(state, [water(0.5), water(0.5, 110), water(4, 20)], energy);
      state = result.state;
      return result;
    });
  };
  const results = run();
  assert.deepEqual(results, run());
  assert.deepEqual(results[3].samples, [water(4, 20), rule.outputs[0]]);
  assert.equal(results.reduce((sum, result) => sum + result.energyConsumedJ, 0), 3000);
});

test('a generic multi-input, multi-output batch retains unrelated samples', () => {
  const stone = { materialId: 'stone', massKg: 2, phase: 'solid', temperatureC: 20 };
  const mixture = { materialId: 'mixture', massKg: 2.5, phase: 'solid', temperatureC: 20 };
  const batch = {
    id: 'illustrative-mix', inputs: [water(), stone],
    outputs: [mixture, water(0.5)], durationTicks: 1, energyPerTickJ: 0,
  };
  const extra = water(0.25, 20);
  const result = stepProcess(createProcess(batch), [stone, water(), extra], 0);
  assert.deepEqual(result.samples, [extra, mixture, water(0.5)]);
  assert.equal(totalMass(result.samples), 3.25);
});

test('rule definitions are snapshotted independently of later edits', () => {
  const editable = structuredClone(rule);
  const state = createProcess(editable);
  editable.inputs[0].massKg = 10;
  editable.outputs[0].temperatureC = 50;
  editable.durationTicks = 1;
  assert.equal(state.rule.inputs[0].massKg, 1);
  assert.equal(state.rule.outputs[0].temperatureC, 100);
  assert.equal(state.rule.durationTicks, 3);
});

test('invalid rules reject missing or invalid fields and unbalanced masses', () => {
  for (const patch of [
    { id: '' }, { inputs: [] }, { outputs: [] },
    { inputs: [water(-1)] }, { inputs: [water(0)] }, { inputs: [water(NaN)] },
    { inputs: [water(Infinity)] }, { inputs: [{ ...water(), phase: 'plasma' }] },
    { inputs: [{ ...water(), materialId: '' }] },
    { inputs: [water(0.5), water(0.5)] },
    { outputs: [{ ...rule.outputs[0], massKg: 0.99 }] },
    { outputs: [{ ...rule.outputs[0], massKg: 1.01 }] },
    { outputs: [{ ...rule.outputs[0], massKg: -1 }] },
    { outputs: [{ ...rule.outputs[0], temperatureC: NaN }] },
    { minTemperatureC: -274 }, { maxTemperatureC: 90 },
    { minTemperatureC: Infinity }, { durationTicks: 0 }, { durationTicks: -1 },
    { durationTicks: 1.5 }, { durationTicks: Infinity },
    { energyPerTickJ: -1 }, { energyPerTickJ: NaN }, { energyPerTickJ: Infinity },
    { energyPerTickJ: Number.MAX_VALUE },
  ]) assert.throws(() => validateRule({ ...rule, ...patch }));
  assert.throws(() => validateRule({
    ...rule, inputs: [water(1e-20)], outputs: [{ ...rule.outputs[0], massKg: 2e-20 }],
  }));
  assert.doesNotThrow(() => validateRule({
    ...rule, inputs: [water(0.1 + 0.2)], outputs: [{ ...rule.outputs[0], massKg: 0.3 }],
  }));
});

test('invalid runtime inventory, energy and progress are rejected', () => {
  const state = createProcess(rule);
  for (const value of [water(-1), water(Infinity), water(1, -274), water(1, NaN),
    { ...water(), phase: 'plasma' }, { ...water(), materialId: '' }]) {
    assert.throws(() => stepProcess(state, [value], 1000));
  }
  for (const energy of [-1, NaN, Infinity]) assert.throws(() => stepProcess(state, [water()], energy));
  for (const completedTicks of [-1, 0.5, 4, NaN]) {
    assert.throws(() => stepProcess({ ...state, completedTicks }, [water()], 1000));
  }
});

test('insufficient hot mass cannot be made up by cold or wrong-phase samples', () => {
  const result = stepProcess(createProcess(rule), [water(0.5), water(0.5, 20),
    { ...water(100), phase: 'gas' }], 1000);
  assert.equal(result.pauseReason, 'temperature');
  assert.equal(result.state.completedTicks, 0);
  assert.equal(result.energyConsumedJ, 0);
});
