import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BIOLOGY, createBiologyConfig, createBiologicalState,
  restoreBiologicalState, advanceBiology, applyConsumptionOutcome, rankMotivations,
} from '../.sim-test/biology/index.js';

const idle = Object.freeze({ kind: 'idle', status: 'succeeded' });
const rest = Object.freeze({ kind: 'rest', status: 'succeeded' });
const work = Object.freeze({ kind: 'exertion', status: 'succeeded', intensity: 1 });
const hours = (state, n, activity = idle, config = DEFAULT_BIOLOGY) =>
  advanceBiology(state, n * 3600, activity, config);
const drink = relief => ({ kind: 'drink', status: 'succeeded', relief });
const feed = relief => ({ kind: 'feed', status: 'succeeded', relief });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `${actual} != ${expected}`);
function nearState(actual, expected) {
  for (const key of ['hunger', 'thirst', 'fatigue', 'condition']) near(actual[key], expected[key]);
}

test('fresh and restored state is detached, immutable and versioned', () => {
  const start = createBiologicalState();
  assert.deepEqual(start, { version: 1, hunger: 0, thirst: 0, fatigue: 0, condition: 1 });
  const raw = JSON.parse(JSON.stringify(start));
  const restored = restoreBiologicalState(raw);
  raw.hunger = 0.8;
  assert.deepEqual(restored, start);
  assert.notEqual(restored, start);
  assert.ok(Object.isFrozen(restored));
  assert.throws(() => { restored.thirst = 1; }, TypeError);
  const custom = { hunger: 0.4, thirst: 0.2, fatigue: 0.1, condition: 0.9 };
  const individual = createBiologicalState(custom);
  custom.fatigue = 1;
  assert.equal(individual.fatigue, 0.1);
  assert.equal(start.fatigue, 0);
});

test('needs progress with modeled seconds, including fractions and zero duration', () => {
  const start = createBiologicalState();
  nearState(hours(start, 2), { hunger: 0.08, thirst: 0.16, fatigue: 0.12, condition: 1 });
  nearState(advanceBiology(start, 1800, idle), {
    hunger: 0.02, thirst: 0.04, fatigue: 0.03, condition: 1,
  });
  assert.deepEqual(advanceBiology(start, 0, work), start);
  assert.equal(start.thirst, 0);
  assert.ok(Object.isFrozen(hours(start, 1)));
});

test('confirmed exertion scales with actual intensity; failed activity is awake baseline', () => {
  const start = createBiologicalState();
  near(hours(start, 2, work).fatigue, 0.36);
  near(hours(start, 2, { ...work, intensity: 0.5 }).fatigue, 0.24);
  assert.deepEqual(hours(start, 2, { ...work, intensity: 0 }), hours(start, 2));
  assert.deepEqual(hours(start, 2, { ...work, status: 'failed' }), hours(start, 2));
  assert.deepEqual(hours(start, 2, { ...rest, status: 'failed' }), hours(start, 2));
});

test('rest recovers fatigue only; hunger and thirst continue rising', () => {
  const start = createBiologicalState({ hunger: 0.2, thirst: 0.3, fatigue: 0.5, condition: 0.9 });
  nearState(hours(start, 2, rest), { hunger: 0.28, thirst: 0.46, fatigue: 0.1, condition: 0.9 });
  assert.equal(hours(start, 4, rest).fatigue, 0);
  assert.equal(hours(start, 4, rest).condition, 0.9);
  assert.deepEqual(hours(start, 2, { ...rest, status: 'failed' }), hours(start, 2));
});

test('feeding and drinking resolve separately, clamp relief, never heal condition', () => {
  const start = createBiologicalState({ hunger: 0.5, thirst: 0.6, fatigue: 0.4, condition: 0.7 });
  nearState(applyConsumptionOutcome(start, drink(0.25)), {
    hunger: 0.5, thirst: 0.35, fatigue: 0.4, condition: 0.7,
  });
  nearState(applyConsumptionOutcome(start, feed(0.8)), {
    hunger: 0, thirst: 0.6, fatigue: 0.4, condition: 0.7,
  });
  assert.deepEqual(applyConsumptionOutcome(start, drink(0)), start);
  assert.deepEqual(applyConsumptionOutcome(start, { kind: 'drink', status: 'failed', relief: 0 }), start);
  assert.deepEqual(applyConsumptionOutcome(start, { kind: 'feed', status: 'failed', relief: 0 }), start);
  assert.ok(Object.isFrozen(applyConsumptionOutcome(start, feed(0.1))));
});

test('competing motives change priority after a confirmed outcome; scores grow monotonically', () => {
  const state = createBiologicalState({ hunger: 0.8, thirst: 0.9, fatigue: 0.6, condition: 1 });
  const ranked = rankMotivations(state);
  assert.deepEqual(ranked.map(x => x.kind), ['drink', 'feed', 'rest']);
  near(ranked[0].urgency, 0.81);
  assert.deepEqual(rankMotivations(applyConsumptionOutcome(state, drink(0.8))).map(x => x.kind),
    ['feed', 'rest', 'drink']);
  const fatigue = hours(createBiologicalState(), 3, work);
  assert.ok(rankMotivations(fatigue).find(x => x.kind === 'rest').urgency > 0);
  assert.ok(Object.isFrozen(ranked) && ranked.every(Object.isFrozen));
});

test('motivation tie order and per-individual weights are deterministic', () => {
  assert.deepEqual(rankMotivations(createBiologicalState()).map(x => x.kind), ['drink', 'feed', 'rest']);
  const state = createBiologicalState({ hunger: 1, thirst: 1, fatigue: 1, condition: 1 });
  const config = { ...DEFAULT_BIOLOGY, hunger: { ...DEFAULT_BIOLOGY.hunger, urgencyWeight: 1 },
    fatigue: { ...DEFAULT_BIOLOGY.fatigue, urgencyWeight: 1 } };
  assert.deepEqual(rankMotivations(state, config).map(x => x.kind), ['drink', 'feed', 'rest']);
  const custom = { ...config, thirst: { ...config.thirst, urgencyWeight: 0 },
    hunger: { ...config.hunger, urgencyWeight: 0.5 } };
  assert.deepEqual(rankMotivations(state, custom).map(x => x.kind), ['rest', 'feed', 'drink']);
});

test('threshold damage integrates crossing and saturation rather than charging entire interval', () => {
  const start = createBiologicalState();
  near(hours(start, 8).condition, 1);
  near(hours(start, 12).condition, 0.927925);
  const config = { ...DEFAULT_BIOLOGY, hungerPerHour: 0, thirstPerHour: 0.5,
    awakeFatiguePerHour: 0, thirst: { threshold: 0.5, damagePerHour: 0.2, urgencyWeight: 1 } };
  // Thirst crosses .5 at 1h, saturates at 2h, remains saturated for 1h.
  near(hours(start, 3, idle, config).condition, 0.85);
});

test('rest crossing below the fatigue threshold still accounts for prior deprivation', () => {
  const config = { ...DEFAULT_BIOLOGY, hungerPerHour: 0, thirstPerHour: 0,
    restRecoveryPerHour: 0.5, fatigue: { threshold: 0.5, damagePerHour: 0.4, urgencyWeight: 1 } };
  const start = createBiologicalState({ hunger: 0, thirst: 0, fatigue: 1, condition: 1 });
  const next = hours(start, 3, rest, config);
  assert.equal(next.fatigue, 0);
  near(next.condition, 0.9);
});

test('constant activity subdivisions agree within floating point tolerance', () => {
  const initial = createBiologicalState({ hunger: 0.65, thirst: 0.6, fatigue: 0.95, condition: 1 });
  for (const activity of [idle, work, rest]) {
    let subdivided = initial;
    for (let i = 0; i < 48; i++) subdivided = hours(subdivided, 0.125, activity);
    nearState(subdivided, hours(initial, 6, activity));
  }
});

test('long deprivation saturates finite scores without automatic death or condition recovery', () => {
  const start = createBiologicalState();
  const next = hours(start, 48);
  assert.deepEqual(next, { version: 1, hunger: 1, thirst: 1, fatigue: 1, condition: 0 });
  assert.deepEqual(advanceBiology(start, Number.MAX_VALUE, work), next);
  const fed = applyConsumptionOutcome(applyConsumptionOutcome(next, feed(1)), drink(1));
  nearState(hours(fed, 5, rest), { hunger: 0.2, thirst: 0.4, fatigue: 0, condition: 0 });
  assert.equal(start.condition, 1);
});

test('configuration is validated, immutable and can disable selected consequences', () => {
  const input = { ...DEFAULT_BIOLOGY, hungerPerHour: 0, thirstPerHour: 0,
    awakeFatiguePerHour: 0, exertionFatiguePerHour: 0,
    hunger: { threshold: 0, damagePerHour: 0, urgencyWeight: 1 },
    thirst: { threshold: 0, damagePerHour: 0, urgencyWeight: 1 },
    fatigue: { threshold: 0, damagePerHour: 0, urgencyWeight: 1 } };
  const rules = createBiologyConfig(input);
  input.hunger.damagePerHour = 1;
  const initial = createBiologicalState({ hunger: 1, thirst: 1, fatigue: 1, condition: 1 });
  assert.deepEqual(hours(initial, 100, work, rules), initial);
  assert.ok(Object.isFrozen(rules) && Object.isFrozen(rules.hunger));
  assert.ok(Object.isFrozen(DEFAULT_BIOLOGY.thirst));
  for (const value of [-1, 1.1, NaN, Infinity, '0.1', null, undefined]) {
    assert.throws(() => createBiologyConfig({ ...DEFAULT_BIOLOGY, hungerPerHour: value }));
    assert.throws(() => createBiologyConfig({ ...DEFAULT_BIOLOGY,
      thirst: { ...DEFAULT_BIOLOGY.thirst, threshold: value } }));
  }
  assert.throws(() => createBiologyConfig({ ...DEFAULT_BIOLOGY, fatigue: null }));
  assert.throws(() => createBiologyConfig({ ...DEFAULT_BIOLOGY,
    hunger: { ...DEFAULT_BIOLOGY.hunger, damagePerHour: -1 } }));
  assert.throws(() => createBiologyConfig({ ...DEFAULT_BIOLOGY,
    thirst: { ...DEFAULT_BIOLOGY.thirst, urgencyWeight: 2 } }));
});

test('invalid states, durations and unresolved or malformed outcomes reject atomically', () => {
  const start = createBiologicalState();
  for (const invalid of [null, [], {}, { ...start, version: 2 }]) {
    assert.throws(() => restoreBiologicalState(invalid));
  }
  for (const value of [-0.01, 1.01, NaN, Infinity, '0', undefined]) {
    for (const field of ['hunger', 'thirst', 'fatigue', 'condition']) {
      assert.throws(() => restoreBiologicalState({ ...start, [field]: value }));
    }
    assert.throws(() => applyConsumptionOutcome(start, drink(value)));
    assert.throws(() => hours(start, 1, { ...work, intensity: value }));
  }
  for (const duration of [-1, NaN, Infinity, '3600', null]) {
    assert.throws(() => advanceBiology(start, duration, idle));
  }
  for (const activity of [null, { kind: 'rest' }, { ...rest, status: 'intended' },
    { ...rest, kind: 'teleport' }, { ...work, intensity: undefined }]) {
    assert.throws(() => hours(start, 1, activity));
  }
  for (const outcome of [null, { kind: 'drink', relief: 0.4 },
    { ...drink(0.4), status: 'intended' }, { ...drink(0.4), status: 'failed' },
    { ...drink(0.4), kind: 'rest' }]) {
    assert.throws(() => applyConsumptionOutcome(start, outcome));
  }
  assert.deepEqual(start, createBiologicalState());
});

test('reproducible work, rest and consumption lifecycle and JSON continuation', () => {
  function lifecycle(roundTrip) {
    const states = [createBiologicalState()];
    const save = state => {
      states.push(roundTrip ? restoreBiologicalState(JSON.parse(JSON.stringify(state))) : state);
      return states.at(-1);
    };
    const worked = save(hours(states[0], 4, work));
    const rested = save(hours(worked, 2, rest));
    const watered = save(applyConsumptionOutcome(rested, drink(0.4)));
    save(applyConsumptionOutcome(watered, feed(0.2)));
    return states;
  }
  const states = lifecycle(false);
  assert.deepEqual(states, lifecycle(true));
  assert.deepEqual(states, lifecycle(false));
  nearState(states[1], { hunger: 0.16, thirst: 0.32, fatigue: 0.72, condition: 1 });
  nearState(states[2], { hunger: 0.24, thirst: 0.48, fatigue: 0.32, condition: 1 });
  nearState(states[4], { hunger: 0.04, thirst: 0.08, fatigue: 0.32, condition: 1 });
  assert.equal(rankMotivations(states[1])[0].kind, 'rest');
  assert.equal(rankMotivations(states[2])[0].kind, 'drink');
  assert.equal(rankMotivations(states[4])[0].kind, 'rest');
});

test('independent individuals with different rates never mutate one another', () => {
  const a = createBiologicalState(), b = createBiologicalState();
  const rules = { ...DEFAULT_BIOLOGY, thirstPerHour: 0.02 };
  const first = hours(a, 3);
  const second = hours(b, 3, idle, rules);
  near(first.thirst, 0.24);
  near(second.thirst, 0.06);
  assert.deepEqual(a, b);
  assert.equal(a.thirst, 0);
});
