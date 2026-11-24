import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THROWING_SKILL, createSkillRecord, applyPracticeOutcome,
  getReachedMilestones, getActionSuccessChance,
} from '../.sim-test/skills/index.js';

const config = THROWING_SKILL;
const outcome = success => ({ skillId: config.skillId, success });
const practice = (record, success, rules = config) =>
  applyPracticeOutcome(record, { skillId: rules.skillId, success }, rules);
function repeat(count, success, rules = config) {
  let record = createSkillRecord(rules);
  for (let i = 0; i < count; i++) record = practice(record, success, rules).record;
  return record;
}

test('new record is untrained; practice creates immutable independent state', () => {
  const start = createSkillRecord(config);
  assert.deepEqual(start, {
    skillId: 'throwing', attempts: 0, successes: 0, experience: 0, proficiency: 0,
  });
  const input = Object.freeze(outcome(true));
  const result = applyPracticeOutcome(start, input, config);
  assert.notEqual(result.record, start);
  assert.equal(start.attempts, 0);
  assert.equal(result.record.attempts, 1);
  assert.equal(result.record.successes, 1);
  assert.equal(result.record.experience, 2);
  assert.equal(result.record.proficiency, 2 / 402);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.record));
  assert.ok(Object.isFrozen(result.reachedMilestones));
  assert.throws(() => { result.record.attempts = 9; }, TypeError);
  assert.ok(Object.isFrozen(config.attemptMilestones));
});

test('successful repetition improves proficiency with diminishing returns', () => {
  const a = repeat(10, true);
  const b = repeat(20, true);
  const c = repeat(30, true);
  assert.equal(c.attempts, 30);
  assert.equal(c.successes, 30);
  assert.equal(c.experience, 60);
  assert.ok(a.proficiency > 0 && b.proficiency > a.proficiency);
  assert.ok(c.proficiency > b.proficiency);
  assert.ok(a.proficiency > b.proficiency - a.proficiency);
  assert.ok(b.proficiency - a.proficiency > c.proficiency - b.proficiency);
});

test('failed attempts can teach, but do not count as successes', () => {
  const misses = repeat(20, false);
  const hits = repeat(20, true);
  assert.equal(misses.attempts, 20);
  assert.equal(misses.successes, 0);
  assert.equal(misses.experience, 20);
  assert.ok(misses.proficiency > 0 && misses.proficiency < hits.proficiency);
  const mixed = practice(misses, true).record;
  assert.equal(mixed.successes, 1);
  assert.equal(mixed.experience, 22);
  const noFailureXp = { ...config, failureExperience: 0 };
  assert.equal(repeat(20, false, noFailureXp).proficiency, 0);
});

test('100 throwing attempts are a milestone, not an expert unlock', () => {
  const before = repeat(99, false);
  assert.deepEqual(getReachedMilestones(before, config), []);
  const at = practice(before, false);
  assert.deepEqual(at.reachedMilestones, [100]);
  assert.equal(at.record.proficiency, 0.2);
  assert.ok(at.record.proficiency - before.proficiency < 0.01);
  const after = practice(at.record, true);
  assert.deepEqual(after.reachedMilestones, []);
  assert.deepEqual(getReachedMilestones(after.record, config), [100]);
  assert.ok(repeat(100, true).proficiency < 0.5);
});

test('custom skill, milestones and growth scale are supported', () => {
  const rules = Object.freeze({
    ...config, skillId: 'gathering', halfProficiencyExperience: 6,
    attemptMilestones: Object.freeze([1, 3]),
  });
  const one = practice(createSkillRecord(rules), true, rules);
  assert.deepEqual(one.reachedMilestones, [1]);
  const two = practice(one.record, true, rules);
  assert.deepEqual(two.reachedMilestones, []);
  const three = practice(two.record, true, rules);
  assert.deepEqual(three.reachedMilestones, [3]);
  assert.equal(three.record.proficiency, 0.5);
  assert.deepEqual(getReachedMilestones(three.record, rules), [1, 3]);
  assert.deepEqual(rules.attemptMilestones, [1, 3]);
  const none = { ...rules, attemptMilestones: [] };
  assert.deepEqual(practice(createSkillRecord(none), true, none).reachedMilestones, []);
});

test('proficiency and action chance are bounded and independently tunable', () => {
  const start = createSkillRecord(config);
  const trained = repeat(10000, true);
  assert.ok(trained.proficiency > 0.9 && trained.proficiency < 1);
  assert.equal(getActionSuccessChance(start, config, 0.2, 0.5), 0.2);
  const chance = getActionSuccessChance(trained, config, 0.2, 0.5);
  assert.ok(chance > 0.2 && chance < 0.6);
  assert.equal(getActionSuccessChance(trained, config, 0.2, 0), 0.2);
  assert.equal(getActionSuccessChance(trained, config, 1, 1), 1);
  assert.equal(getActionSuccessChance(start, config, 0, 1), 0);
});

test('same ordered outcomes reproduce state and milestones across JSON snapshots', () => {
  const rules = { ...config, attemptMilestones: [2, 5, 100] };
  const simulate = roundTrip => {
    let record = createSkillRecord(rules);
    const milestones = [];
    for (let i = 0; i < 120; i++) {
      const result = practice(record, i % 3 === 0, rules);
      milestones.push(...result.reachedMilestones);
      record = roundTrip ? JSON.parse(JSON.stringify(result.record)) : result.record;
    }
    return { record, milestones };
  };
  assert.deepEqual(simulate(false), simulate(true));
  assert.deepEqual(simulate(false), simulate(false));
  assert.deepEqual(simulate(false).milestones, [2, 5, 100]);
});

test('invalid configurations are rejected', () => {
  for (const overrides of [
    { skillId: '' }, { skillId: ' throwing' }, { skillId: 7 },
    { failureExperience: -1 }, { successExperience: 0 },
    { successExperience: 0.5 }, { successExperience: Infinity },
    { successExperience: 1, failureExperience: 2 },
    { halfProficiencyExperience: 0 }, { halfProficiencyExperience: NaN },
    { halfProficiencyExperience: Number.MAX_SAFE_INTEGER + 1 },
    { attemptMilestones: [0] }, { attemptMilestones: [2, 1] },
    { attemptMilestones: [1, 1] }, { attemptMilestones: [1.5] },
    { attemptMilestones: [Infinity] }, { attemptMilestones: null },
  ]) assert.throws(() => createSkillRecord({ ...config, ...overrides }));
});

test('invalid records and mismatched or non-boolean outcomes are rejected', () => {
  const start = createSkillRecord(config);
  for (const overrides of [
    { skillId: 'other' }, { attempts: -1 }, { attempts: 1.5 },
    { attempts: Infinity }, { successes: 1 }, { successes: -1 },
    { experience: -1 }, { experience: 1 }, { proficiency: NaN },
    { proficiency: -0.1 }, { proficiency: 1.1 }, { proficiency: 0.1 },
    { attempts: 1, successes: 1, experience: 0 },
  ]) assert.throws(() => practice({ ...start, ...overrides }, true));
  for (const invalid of [
    { skillId: 'other', success: true }, { skillId: 'throwing', success: 1 },
    { skillId: 'throwing' }, null,
  ]) assert.throws(() => applyPracticeOutcome(start, invalid, config));
  for (const value of [-1, 1.1, NaN, Infinity, '0.2']) {
    assert.throws(() => getActionSuccessChance(start, config, value, 0.5));
    assert.throws(() => getActionSuccessChance(start, config, 0.5, value));
  }
});

test('attempt and experience overflow is rejected without corrupting state', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const noFailureXp = { ...config, failureExperience: 0 };
  const exhausted = { ...createSkillRecord(noFailureXp), attempts: max };
  assert.throws(() => practice(exhausted, false, noFailureXp), RangeError);
  const largeReward = { ...config, successExperience: max };
  const first = practice(createSkillRecord(largeReward), true, largeReward).record;
  assert.equal(first.experience, max);
  assert.throws(() => practice(first, true, largeReward), RangeError);
  assert.equal(first.attempts, 1);
});
