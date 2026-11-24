import test from 'node:test';
import assert from 'node:assert/strict';
import { ABSOLUTE_ZERO_C, getMaterial, thermalEquilibriumC } from '../.sim-test/materials/index.js';
import { sensibleEnergyJ, stepThermalContact } from '../.sim-test/thermal/index.js';

const sample = (materialId, massKg, temperatureC, phase = getMaterial(materialId).phase) =>
  ({ materialId, massKg, temperatureC, phase });
const contact = (conductanceWPerK = 100, tickDurationSeconds = 1) =>
  ({ conductanceWPerK, tickDurationSeconds });
const capacity = s => s.massKg * getMaterial(s.materialId).specificHeatJPerKgK;
const total = (a, b) => sensibleEnergyJ(a) + sensibleEnergyJ(b);
function close(actual, expected, rel = 1e-12, abs = 1e-12) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(abs, rel * Math.abs(expected)),
    `${actual} != ${expected}`);
}
function conserved(a, b, result) {
  close(total(result.a, result.b), total(a, b));
  close(capacity(a) * (a.temperatureC - result.a.temperatureC), result.transferredEnergyJ, 1e-9, 1e-8);
  close(capacity(b) * (result.b.temperatureC - b.temperatureC), result.transferredEnergyJ, 1e-9, 1e-8);
}

test('one tick matches analytic constant-conductance solution and accounts for joules', () => {
  const a = sample('stone', 2, 90);
  const b = sample('water', 1, 20);
  const g = 45, dt = 2;
  const ca = capacity(a), cb = capacity(b);
  const q = (a.temperatureC - b.temperatureC) / (1 / ca + 1 / cb) *
    (1 - Math.exp(-g * dt * (1 / ca + 1 / cb)));
  const result = stepThermalContact(a, b, contact(g, dt));
  close(result.transferredEnergyJ, q);
  close(result.a.temperatureC, a.temperatureC - q / ca);
  close(result.b.temperatureC, b.temperatureC + q / cb);
  conserved(a, b, result);
  for (const [old, next] of [[a, result.a], [b, result.b]]) {
    assert.equal(next.massKg, old.massKg);
    assert.equal(next.materialId, old.materialId);
    assert.equal(next.phase, old.phase);
  }
});

test('signed energy reverses with sample order; mixed catalog materials exchange without mixing', () => {
  const a = sample('wood', 3, 20);
  const b = sample('charcoal', 0.5, 80);
  const forward = stepThermalContact(a, b, contact());
  const reverse = stepThermalContact(b, a, contact());
  assert.ok(forward.transferredEnergyJ < 0);
  assert.equal(forward.transferredEnergyJ, -reverse.transferredEnergyJ);
  assert.deepEqual(forward.a, reverse.b);
  assert.deepEqual(forward.b, reverse.a);
  conserved(a, b, forward);
});

test('repeated ticks approach the weighted equilibrium monotonically and conserve energy', () => {
  const a = sample('stone', 2, 95);
  const b = sample('water', 1, 15);
  const equilibrium = thermalEquilibriumC(a, b);
  let hot = a, cold = b;
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    const next = stepThermalContact(hot, cold, contact(100, 0.5));
    assert.ok(next.a.temperatureC <= hot.temperatureC && next.a.temperatureC >= equilibrium);
    assert.ok(next.b.temperatureC >= cold.temperatureC && next.b.temperatureC <= equilibrium);
    assert.ok(next.a.temperatureC >= next.b.temperatureC && next.transferredEnergyJ >= 0);
    conserved(hot, cold, next);
    sum += next.transferredEnergyJ;
    hot = next.a; cold = next.b;
  }
  close(hot.temperatureC, equilibrium, 1e-12);
  close(cold.temperatureC, equilibrium, 1e-12);
  close(total(hot, cold), total(a, b), 1e-12);
  close(sum, capacity(a) * (a.temperatureC - hot.temperatureC));
});

test('very large conductance or duration saturates at equilibrium without overshoot', () => {
  const a = sample('ash', 1, 95), b = sample('water', 1, 5);
  const equilibrium = thermalEquilibriumC(a, b);
  for (const config of [contact(1e12, 1), contact(1, 1e12), contact(Number.MAX_VALUE, Number.MAX_VALUE)]) {
    const next = stepThermalContact(a, b, config);
    close(next.a.temperatureC, equilibrium);
    close(next.b.temperatureC, equilibrium);
    assert.ok(next.a.temperatureC >= next.b.temperatureC);
    conserved(a, b, next);
  }
});

test('equal temperatures, zero conductance, zero duration and empty samples are no-ops', () => {
  const a = sample('wood', 1, 80);
  const b = sample('water', 1, 20);
  for (const [left, right, config] of [
    [a, {...b, temperatureC: 80}, contact()],
    [a, b, contact(0, 1)], [a, b, contact(100, 0)],
    [{...a, massKg: 0}, b, contact()], [a, {...b, massKg: 0}, contact()],
    [{...a, massKg: 0}, {...b, massKg: 0}, contact()],
  ]) {
    const result = stepThermalContact(left, right, config);
    assert.deepEqual(result, {a: left, b: right, transferredEnergyJ: 0});
    assert.notEqual(result.a, left);
    assert.notEqual(result.b, right);
  }
});

test('tick duration composes for constant conductance and controls heat exchange', () => {
  const a = sample('stone', 1, 85), b = sample('water', 1, 15);
  const whole = stepThermalContact(a, b, contact(100, 2));
  const half = stepThermalContact(a, b, contact(100, 1));
  const second = stepThermalContact(half.a, half.b, contact(100, 1));
  assert.ok(whole.transferredEnergyJ > half.transferredEnergyJ);
  close(whole.a.temperatureC, second.a.temperatureC);
  close(whole.b.temperatureC, second.b.temperatureC);
  close(whole.transferredEnergyJ, half.transferredEnergyJ + second.transferredEnergyJ);
});

test('small positive transfer is not lost to cancellation in the exponential', () => {
  const a = sample('water', 1, 80), b = sample('water', 1, 20);
  const result = stepThermalContact(a, b, contact(1e-8, 1));
  close(result.transferredEnergyJ, 6e-7, 1e-10, 1e-15);
  assert.ok(result.a.temperatureC < 80 && result.b.temperatureC > 20);
  conserved(a, b, result);
});

test('extreme mass ratios, small conductance and overflowing exposure remain bounded', () => {
  const a = sample('stone', 1e-12, 70), b = sample('water', 1e12, 20);
  const result = stepThermalContact(a, b, contact(Number.MAX_VALUE, 2));
  assert.ok(result.a.temperatureC >= result.b.temperatureC);
  close(result.a.temperatureC, 20);
  close(result.b.temperatureC, 20);
  close(result.transferredEnergyJ, capacity(a) * 50, 1e-12, 1e-20);
  close(total(result.a, result.b), total(a, b));
  // G*dt underflows, but dividing by a tiny reduced capacity recovers a finite rate.
  const c = sample('stone', 1e-300, 80), d = sample('stone', 1e-300, 20);
  const tiny = stepThermalContact(c, d, contact(1e-170, 1e-140));
  assert.ok(tiny.transferredEnergyJ > 0);
  assert.ok(tiny.a.temperatureC < c.temperatureC && tiny.b.temperatureC > d.temperatureC);
  close(total(tiny.a, tiny.b), total(c, d), 1e-12, 0);
});

test('absolute zero is an inclusive bound and negative Celsius temperatures are valid', () => {
  const a = sample('stone', 1, ABSOLUTE_ZERO_C);
  const b = sample('stone', 1, -100);
  assert.equal(sensibleEnergyJ(a), 0);
  const next = stepThermalContact(a, b, contact(100, 10));
  assert.ok(next.a.temperatureC >= ABSOLUTE_ZERO_C && next.a.temperatureC <= next.b.temperatureC);
  assert.ok(next.b.temperatureC <= b.temperatureC);
  conserved(a, b, next);
});

test('invalid samples and unsupported phases are rejected even on no-op ticks', () => {
  const a = sample('stone', 1, 50), b = sample('water', 1, 20);
  for (const patch of [
    {materialId: 'unknown'}, {phase: 'gas'}, {phase: 'solid'},
    {massKg: -1}, {massKg: NaN}, {massKg: Infinity}, {massKg: '1'},
    {temperatureC: ABSOLUTE_ZERO_C - 0.01}, {temperatureC: NaN},
    {temperatureC: Infinity}, {temperatureC: -Infinity}, {temperatureC: '20'},
  ]) {
    const invalid = {...b, ...patch};
    assert.throws(() => stepThermalContact(a, invalid, contact(0)), RangeError);
    assert.throws(() => stepThermalContact(invalid, a, contact(0)), RangeError);
    assert.throws(() => sensibleEnergyJ(invalid), RangeError);
  }
  assert.throws(() => stepThermalContact(null, b, contact()), TypeError);
});

test('invalid conductance, duration and unrepresentable energy are rejected', () => {
  const a = sample('stone', 1, 50), b = sample('water', 1, 20);
  for (const value of [-1, NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.throws(() => stepThermalContact(a, b, {...contact(), conductanceWPerK: value}), RangeError);
    assert.throws(() => stepThermalContact(a, b, {...contact(), tickDurationSeconds: value}), RangeError);
  }
  assert.throws(() => stepThermalContact(a, b, null), TypeError);
  assert.throws(() => stepThermalContact({...a, massKg: Number.MAX_VALUE}, b, contact()), RangeError);
  assert.throws(() => sensibleEnergyJ({...a, temperatureC: Number.MAX_VALUE}), RangeError);
  const huge = sample('stone', 1e303, 0);
  assert.throws(() => stepThermalContact(huge, huge, contact()), RangeError);
});

test('results are frozen, detached and reproducible across identical sequences', () => {
  const a = sample('charcoal', 1, 90), b = sample('water', 2, 10);
  const before = JSON.stringify([a, b]);
  const config = Object.freeze(contact(50, 0.2));
  const run = () => {
    let next = {a, b, transferredEnergyJ: 0};
    const trace = [];
    for (let i = 0; i < 100; i++) {
      next = stepThermalContact(next.a, next.b, config);
      trace.push(next);
    }
    return trace;
  };
  const first = run(), second = run();
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify([a, b]), before);
  const result = first[0];
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.a) && Object.isFrozen(result.b));
  assert.throws(() => { result.a.temperatureC = 0; }, TypeError);
  a.temperatureC = 1;
  assert.notEqual(result.a.temperatureC, a.temperatureC);
});
