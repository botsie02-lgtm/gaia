import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSOLUTE_ZERO_C, MATERIALS, getMaterial, validateQuantity, validateSample,
  massToVolumeM3, volumeToMassKg, thermalEquilibriumC, combineSamples,
} from '../.sim-test/materials/index.js';

function sample(materialId, massKg, temperatureC, phase = getMaterial(materialId).phase) {
  return Object.freeze({ materialId, massKg, temperatureC, phase });
}

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `Expected ${actual} to be close to ${expected}`);
}

test('catalog contains stable IDs, positive SI properties and explicit data quality', () => {
  assert.deepEqual(Object.keys(MATERIALS).sort(), ['ash', 'charcoal', 'stone', 'water', 'wood']);
  assert.ok(Object.isFrozen(MATERIALS));
  for (const [id, material] of Object.entries(MATERIALS)) {
    assert.equal(material.id, id);
    assert.equal(getMaterial(id), material);
    assert.ok(Object.isFrozen(material));
    assert.ok(Number.isFinite(material.densityKgPerM3) && material.densityKgPerM3 > 0);
    assert.ok(Number.isFinite(material.specificHeatJPerKgK) && material.specificHeatJPerKgK > 0);
    assert.equal(material.dataQuality, id === 'water' ? 'reference' : 'approximation');
    assert.equal(material.phase, id === 'water' ? 'liquid' : 'solid');
    assert.equal(material.combustible, id === 'wood' || id === 'charcoal');
    assert.ok(material.dataNotes.length > 0);
  }
  assert.equal(MATERIALS.water.densityKgPerM3, 998.2);
  assert.equal(MATERIALS.water.specificHeatJPerKgK, 4182);
  assert.throws(() => { MATERIALS.wood.densityKgPerM3 = 1; }, TypeError);
});

test('unknown IDs including inherited object keys are rejected', () => {
  for (const id of ['iron', '', '__proto__', 'constructor', 'toString', null, undefined, 7]) {
    assert.throws(() => getMaterial(id), RangeError);
    assert.throws(() => massToVolumeM3(id, 1), RangeError);
    assert.throws(() => volumeToMassKg(id, 1), RangeError);
  }
});

test('mass and volume round-trip for every material', () => {
  for (const [id, material] of Object.entries(MATERIALS)) {
    assert.equal(massToVolumeM3(id, material.densityKgPerM3), 1);
    assert.equal(volumeToMassKg(id, 1), material.densityKgPerM3);
    for (const mass of [0, 0.001, 1, 17.3, 1000000]) {
      const volume = massToVolumeM3(id, mass, material.phase);
      close(volumeToMassKg(id, volume, material.phase), mass);
    }
    for (const volume of [0, 0.01, 2.3, 1000]) {
      close(massToVolumeM3(id, volumeToMassKg(id, volume)), volume);
    }
  }
  assert.equal(massToVolumeM3('wood', -0), 0);
  assert.equal(volumeToMassKg('water', -0), 0);
});

test('quantities reject negative, non-finite and non-number values', () => {
  for (const value of [-1, -Number.MIN_VALUE, NaN, Infinity, -Infinity, '1', null, undefined, true]) {
    assert.throws(() => validateQuantity(value), RangeError);
    assert.throws(() => massToVolumeM3('wood', value), RangeError);
    assert.throws(() => volumeToMassKg('wood', value), RangeError);
  }
  for (const value of [0, -0, Number.MIN_VALUE, 1, Number.MAX_VALUE]) {
    assert.doesNotThrow(() => validateQuantity(value));
  }
});

test('conversions reject unsupported phases and non-representable results', () => {
  for (const phase of ['gas', 'solid', 'plasma', null]) {
    assert.throws(() => massToVolumeM3('water', 1, phase), RangeError);
    assert.throws(() => volumeToMassKg('water', 1, phase), RangeError);
  }
  assert.throws(() => massToVolumeM3('wood', Number.MIN_VALUE), RangeError);
  assert.throws(() => volumeToMassKg('wood', Number.MAX_VALUE), RangeError);
});

test('samples validate material, phase, mass and temperature independently', () => {
  const valid = sample('water', 2, 20);
  assert.doesNotThrow(() => validateSample(valid));
  assert.doesNotThrow(() => validateSample(sample('stone', 0, ABSOLUTE_ZERO_C)));
  for (const patch of [
    { materialId: 'unknown' }, { materialId: '__proto__' },
    { phase: 'solid' }, { phase: 'gas' }, { phase: 'plasma' }, { phase: undefined },
    { massKg: -1 }, { massKg: NaN }, { massKg: Infinity }, { massKg: '2' },
    { temperatureC: ABSOLUTE_ZERO_C - 0.01 }, { temperatureC: NaN },
    { temperatureC: Infinity }, { temperatureC: -Infinity }, { temperatureC: '20' },
    { temperatureC: undefined },
  ]) {
    const invalid = { ...valid, ...patch };
    assert.throws(() => validateSample(invalid), RangeError);
    assert.throws(() => combineSamples(valid, invalid), RangeError);
    assert.throws(() => thermalEquilibriumC(invalid, valid), RangeError);
  }
  for (const invalid of [null, undefined, 1, 'sample']) {
    assert.throws(() => validateSample(invalid), TypeError);
  }
});

test('same-material combination conserves mass and sensible heat without mutation', () => {
  for (const id of Object.keys(MATERIALS)) {
    const a = sample(id, 2, 10);
    const b = sample(id, 6, 90);
    const before = JSON.stringify([a, b]);
    const result = combineSamples(a, b);
    assert.notEqual(result, a);
    assert.notEqual(result, b);
    assert.deepEqual(result, { materialId: id, phase: a.phase, massKg: 8, temperatureC: 70 });
    const c = getMaterial(id).specificHeatJPerKgK;
    close(result.massKg * c * result.temperatureC, a.massKg * c * a.temperatureC + b.massKg * c * b.temperatureC);
    assert.equal(JSON.stringify([a, b]), before);
  }
});

test('thermal contact between different materials is heat-capacity weighted', () => {
  const a = sample('stone', 2, 100);
  const b = sample('water', 1, 20);
  const ca = a.massKg * MATERIALS.stone.specificHeatJPerKgK;
  const cb = b.massKg * MATERIALS.water.specificHeatJPerKgK;
  const temperatureC = thermalEquilibriumC(a, b);
  close(temperatureC, (ca * 100 + cb * 20) / (ca + cb));
  close(ca * (100 - temperatureC), cb * (temperatureC - 20));
  assert.ok(temperatureC > 20 && temperatureC < 60);
  assert.throws(() => combineSamples(a, b), RangeError);
  assert.throws(() => combineSamples(sample('water', 0, 20), a), RangeError);
  assert.throws(() => combineSamples(b, sample('water', 1, 20, 'gas')), RangeError);
});

test('zero mass contributes no heat or mass; two empty samples have no equilibrium', () => {
  const empty = sample('wood', 0, 90);
  const full = sample('wood', 5, -10);
  assert.equal(thermalEquilibriumC(empty, full), -10);
  assert.equal(thermalEquilibriumC(full, empty), -10);
  assert.deepEqual(combineSamples(empty, full), full);
  assert.notEqual(combineSamples(empty, full), full);
  assert.throws(() => combineSamples(empty, empty), RangeError);
  assert.throws(() => thermalEquilibriumC(empty, sample('water', 0, 20)), RangeError);
});

test('equilibrium and combination are deterministic and symmetric', () => {
  const a = sample('stone', 0.75, -20);
  const b = sample('stone', 2.25, 60);
  const expected = combineSamples(a, b);
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(combineSamples(a, b), expected);
    assert.deepEqual(combineSamples(b, a), expected);
    assert.equal(thermalEquilibriumC(a, b), thermalEquilibriumC(b, a));
  }
  assert.equal(thermalEquilibriumC(a, sample('wood', 1, -20)), -20);
  assert.equal(thermalEquilibriumC(sample('wood', 1, ABSOLUTE_ZERO_C), sample('wood', 2, ABSOLUTE_ZERO_C)), ABSOLUTE_ZERO_C);
});

test('repeated combining preserves mass and sensible heat within floating-point tolerance', () => {
  const a = sample('wood', 0.1, -10);
  const b = sample('wood', 0.2, 20);
  const c = sample('wood', 0.3, 60);
  const result = combineSamples(combineSamples(a, b), c);
  const alternate = combineSamples(a, combineSamples(b, c));
  close(result.massKg, a.massKg + b.massKg + c.massKg);
  close(result.massKg * result.temperatureC, a.massKg * a.temperatureC + b.massKg * b.temperatureC + c.massKg * c.temperatureC);
  close(result.temperatureC, alternate.temperatureC);
});

test('numeric extremes do not silently produce infinite or lost mass', () => {
  assert.throws(() => combineSamples(sample('wood', Number.MAX_VALUE, 0), sample('wood', Number.MAX_VALUE, 0)), RangeError);
  assert.throws(() => combineSamples(sample('wood', 1, 0), sample('wood', Number.MIN_VALUE, 0)), RangeError);
  assert.throws(() => thermalEquilibriumC(sample('wood', Number.MAX_VALUE, 0), sample('stone', 1, 0)), RangeError);
  const large = Number.MAX_VALUE / MATERIALS.wood.specificHeatJPerKgK * 0.75;
  assert.equal(thermalEquilibriumC(sample('wood', large, 0), sample('wood', large, 100)), 50);
  const hot = thermalEquilibriumC(sample('wood', 1, Number.MAX_VALUE), sample('wood', 1, Number.MAX_VALUE / 2));
  assert.ok(Number.isFinite(hot) && hot >= Number.MAX_VALUE / 2 && hot <= Number.MAX_VALUE);
});
