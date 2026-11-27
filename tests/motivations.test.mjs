import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld } from '../.sim-test/world.js';
import { observeAgent } from '../.sim-test/perception/index.js';
import { decideAgent } from '../.sim-test/agents/index.js';
import { createBiologicalState, advanceBiology, DEFAULT_BIOLOGY, rankMotivations } from '../.sim-test/biology/index.js';
import { decideMotivatedAgent, createMotivationConfig, restoreGoalState, DEFAULT_MOTIVATIONS } from '../.sim-test/agents/motivations/index.js';

const biology = (needs = {}) => createBiologicalState({
  hunger: 0, thirst: 0, fatigue: 0, condition: 1, ...needs,
});
function fixture({ range = 2, deposit = true, memoryCapacity = 512 } = {}) {
  const world = createWorld(42, { agentMode: 'knowledge', perceptionRange: range, memoryCapacity });
  const agent = world.agents[0];
  world.agents = [agent];
  world.terrain.fill('grass');
  world.deposits = [];
  Object.assign(agent, { x: 10, y: 10, energy: 100, resting: false });
  Object.assign(world.hub, { x: 25, y: 25 });
  const d = { id: world.nextEntityId++, kind: 'deposit', material: 'wood', amount: 3, x: 10, y: 10 };
  if (deposit) world.deposits.push(d);
  const sample = (tick, state = biology(), previous = null) => {
    world.tick = tick;
    const observation = observeAgent(world, agent.id, { range });
    return { observation, memory: agent.memory.update(observation),
      own: { energy: agent.energy, resting: agent.resting, cargo: { ...agent.cargo } },
      biology: state, previous, policy: { width: world.width, height: world.height, cargoLimit: 3 } };
  };
  return { world, agent, d, sample };
}
const evaluation = (result, goal) => result.evaluations.find(e => e.goal === goal);
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-12, String(a) + ' != ' + b);

test('satisfied agent reuses ordinary gathering decision and separates cost from urgency', () => {
  const { sample, d } = fixture();
  const input = sample(1);
  const result = decideMotivatedAgent(input);
  assert.equal(result.desiredGoal, 'gather');
  assert.equal(result.selectedGoal, 'gather');
  assert.deepEqual(result.decision, decideAgent(input.observation, input.memory, input.own, input.policy));
  const gather = evaluation(result, 'gather');
  assert.equal(gather.opportunity, 'observed');
  assert.equal(gather.targetId, d.id);
  assert.equal(gather.feasibility, 'requestable');
  assert.equal(gather.urgency, DEFAULT_MOTIVATIONS.gatherUrgency);
  near(gather.estimatedActionCost, 0.03);
  near(gather.score, 0.22);
  assert.equal(result.evaluations.length, 5);
});

test('fatigue competes using rankMotivations and can request voluntary rest', () => {
  const { sample } = fixture();
  const input = sample(1, biology({ hunger: .25, thirst: .2, fatigue: .95 }));
  const result = decideMotivatedAgent(input);
  assert.equal(result.desiredGoal, 'rest');
  assert.equal(result.selectedGoal, 'rest');
  assert.equal(result.decision.action.kind, 'rest');
  assert.equal(evaluation(result, 'rest').urgency, rankMotivations(input.biology).find(m => m.kind === 'rest').urgency);
  const before = JSON.stringify(input.biology);
  const after = advanceBiology(input.biology, 3600, { kind: 'rest', status: 'succeeded' });
  assert.ok(after.fatigue < input.biology.fatigue);
  assert.ok(after.hunger > input.biology.hunger && after.thirst > input.biology.thirst);
  assert.equal(JSON.stringify(input.biology), before);
});

test('urgent thirst interrupts available work with generic search, never drinking', () => {
  const { world, sample } = fixture();
  world.terrain[10 * world.width + 11] = 'water';
  const input = sample(1, biology({ thirst: .95, hunger: .4 }));
  const result = decideMotivatedAgent(input);
  assert.equal(result.desiredGoal, 'obtain-water');
  assert.equal(result.selectedGoal, 'obtain-water');
  const e = evaluation(result, 'obtain-water');
  assert.equal(e.opportunity, 'unknown');
  assert.equal(e.feasibility, 'search-only');
  assert.equal(e.targetId, null);
  assert.match(result.decision.intention, /availability unknown/);
  assert.equal(result.decision.action.kind, 'move');
  assert.ok(input.observation.terrain.some(t => t.terrain === 'water'));
  assert.ok(input.observation.terrain.some(t => t.x === result.decision.action.to.x &&
    t.y === result.decision.action.to.y && t.terrain !== 'water'));
  near(e.score, .95 ** 2 - .04 - .10);
});

test('urgent hunger can win despite an observed wood deposit and cannot consume it', () => {
  const { sample } = fixture();
  const result = decideMotivatedAgent(sample(1, biology({ hunger: 1, thirst: .1 })));
  assert.equal(result.desiredGoal, 'obtain-food');
  assert.equal(result.selectedGoal, 'obtain-food');
  assert.equal(evaluation(result, 'obtain-food').opportunity, 'unknown');
  assert.equal(result.decision.action.kind, 'move');
  assert.equal(evaluation(result, 'obtain-food').targetId, null);
});

test('blocked desired water remains explicit while a feasible goal is selected', () => {
  const { sample } = fixture({ range: 0 });
  const result = decideMotivatedAgent(sample(1, biology({ thirst: 1 })));
  assert.equal(result.desiredGoal, 'obtain-water');
  assert.equal(result.selectedGoal, 'gather');
  const e = evaluation(result, 'obtain-water');
  assert.equal(e.opportunity, 'unknown');
  assert.equal(e.feasibility, 'blocked');
  assert.equal(e.estimatedActionCost, null);
  assert.equal(e.score, null);
  assert.equal(e.decision, null);
  assert.equal(result.decision.action.kind, 'harvest');
});

test('no feasible frontier and no work yields idle, not invented relief or a route', () => {
  const { sample } = fixture({ range: 0, deposit: false });
  const result = decideMotivatedAgent(sample(1, biology({ hunger: 1 })));
  assert.equal(result.desiredGoal, 'obtain-food');
  assert.equal(result.selectedGoal, null);
  assert.equal(result.decision.action.kind, 'idle');
  assert.equal(result.reason, 'no-positive-feasible');
  assert.equal(evaluation(result, 'explore').feasibility, 'blocked');
  assert.equal(result.nextState.goal, null);
});

test('ordinary exploration is a distinct goal when no resource target is reachable', () => {
  const { sample } = fixture({ deposit: false, memoryCapacity: 32 });
  const input = sample(1);
  const result = decideMotivatedAgent(input);
  assert.equal(result.desiredGoal, 'gather');
  assert.equal(result.selectedGoal, 'explore');
  assert.equal(evaluation(result, 'gather').opportunity, 'none-known');
  assert.equal(evaluation(result, 'explore').opportunity, 'frontier');
  assert.deepEqual(result.decision, decideAgent(input.observation, input.memory, input.own, input.policy));
});

test('stale remembered work is discounted and visible absence invalidates it', () => {
  const { world, agent, d, sample } = fixture({ range: 1 });
  d.x = 12;
  agent.x = 11;
  const fresh = decideMotivatedAgent(sample(1));
  assert.equal(evaluation(fresh, 'gather').opportunity, 'observed');
  agent.x = 10;
  const stale = decideMotivatedAgent(sample(2, biology(), fresh.nextState));
  assert.equal(evaluation(stale, 'gather').opportunity, 'remembered');
  assert.equal(evaluation(stale, 'gather').targetId, d.id);
  near(evaluation(fresh, 'gather').score - evaluation(stale, 'gather').score, .05);
  world.deposits = [];
  agent.x = 11;
  const absent = decideMotivatedAgent(sample(3, biology(), stale.nextState));
  assert.equal(evaluation(absent, 'gather').feasibility, 'blocked');
  assert.equal(evaluation(absent, 'gather').targetId, null);
  assert.equal(absent.selectedGoal, 'explore');
});

test('delivery remains ordinary resource work using only a known hub', () => {
  const { world, agent, sample } = fixture({ deposit: false });
  agent.cargo.wood = 3;
  Object.assign(world.hub, { x: 10, y: 10 });
  const result = decideMotivatedAgent(sample(1));
  assert.equal(result.selectedGoal, 'gather');
  assert.equal(result.decision.action.kind, 'deliver');
  assert.equal(evaluation(result, 'gather').targetId, world.hub.id);
});

test('legacy energy rest remains a hard constraint separate from biological desire', () => {
  const { agent, sample } = fixture();
  agent.energy = 12;
  const result = decideMotivatedAgent(sample(1, biology({ thirst: 1 })));
  assert.equal(result.desiredGoal, 'obtain-water');
  assert.equal(result.selectedGoal, 'rest');
  assert.equal(result.reason, 'legacy-rest');
  assert.equal(evaluation(result, 'gather').opportunity, 'not-evaluated');
  assert.equal(evaluation(result, 'explore').feasibility, 'blocked');
  assert.equal(result.decision.action.kind, 'rest');
});

test('equal biological urgency and utility uses fixed deterministic tie order', () => {
  const { sample } = fixture();
  const input = sample(1, biology({ thirst: .8, hunger: .8 }));
  input.biologyConfig = { ...DEFAULT_BIOLOGY, hunger: { ...DEFAULT_BIOLOGY.hunger, urgencyWeight: 1 } };
  const result = decideMotivatedAgent(input);
  assert.equal(evaluation(result, 'obtain-water').score, evaluation(result, 'obtain-food').score);
  assert.equal(result.desiredGoal, 'obtain-water');
  assert.equal(result.selectedGoal, 'obtain-water');
  assert.deepEqual(result, decideMotivatedAgent(input));
});

test('commitment suppresses small switches, expires, and urgent needs can interrupt', () => {
  const { sample } = fixture();
  const options = { maxCommitmentTicks: 3 };
  let result = decideMotivatedAgent(sample(1), options);
  assert.equal(result.selectedGoal, 'gather');
  const fatigue = biology({ fatigue: .62 });
  result = decideMotivatedAgent(sample(2, fatigue, result.nextState), options);
  assert.equal(result.desiredGoal, 'rest');
  assert.equal(result.selectedGoal, 'gather');
  assert.equal(result.reason, 'persist');
  assert.equal(result.nextState.sinceTick, 1);
  result = decideMotivatedAgent(sample(3, fatigue, result.nextState), options);
  assert.equal(result.selectedGoal, 'gather');
  result = decideMotivatedAgent(sample(4, fatigue, result.nextState), options);
  assert.equal(result.selectedGoal, 'rest');
  assert.equal(result.nextState.sinceTick, 4);
  result = decideMotivatedAgent(sample(5, biology({ thirst: 1, fatigue: .62 }), result.nextState), options);
  assert.equal(result.selectedGoal, 'obtain-water');
  assert.equal(result.nextState.sinceTick, 5);
});

test('commitment cannot keep a blocked or nonpositive goal', () => {
  const { sample } = fixture();
  let result = decideMotivatedAgent(sample(1, biology({ fatigue: 1 })));
  assert.equal(result.selectedGoal, 'rest');
  result = decideMotivatedAgent(sample(2, biology(), result.nextState), { switchMargin: 1 });
  assert.equal(result.selectedGoal, 'gather');
});

test('unseen changes cannot affect immediate motivated decisions', () => {
  const a = fixture(), b = fixture();
  b.world.deposits.push({ ...b.d, id: b.world.nextEntityId++, x: 40, y: 20, amount: 999 });
  b.world.inventory.wood = 300;
  b.world.hub.x = 40;
  const ai = a.sample(1, biology({ thirst: .9 }));
  const bi = b.sample(1, biology({ thirst: .9 }));
  assert.deepEqual(ai, bi);
  assert.deepEqual(decideMotivatedAgent(ai), decideMotivatedAgent(bi));
});

test('bounded state round-trips and deterministic replay does not mutate local inputs', () => {
  const { sample } = fixture();
  const input = sample(1, biology({ hunger: .9 }));
  const before = JSON.stringify(input);
  const first = decideMotivatedAgent(input);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.nextState) && Object.isFrozen(first.evaluations));
  const restored = restoreGoalState(JSON.parse(JSON.stringify(first.nextState)));
  assert.deepEqual(restored, first.nextState);
  assert.equal(Object.keys(restored).length, 5);
  const next = sample(2, biology({ hunger: .8, thirst: .75 }), restored);
  assert.deepEqual(decideMotivatedAgent(next), decideMotivatedAgent({ ...next, previous: first.nextState }));
});

test('invalid state, configuration, ownership, chronology and own inputs fail closed', () => {
  const { sample } = fixture();
  const input = sample(1);
  assert.throws(() => decideMotivatedAgent({ ...input, biology: { ...input.biology, hunger: NaN } }));
  assert.throws(() => decideMotivatedAgent({ ...input, memory: { ...input.memory, observerId: 999 } }));
  assert.throws(() => decideMotivatedAgent({ ...input, memory: { ...input.memory, lastObservationTick: 0 } }));
  assert.throws(() => decideMotivatedAgent({ ...input, own: { ...input.own, energy: -1 } }));
  assert.throws(() => decideMotivatedAgent({ ...input, own: { ...input.own, cargo: { wood: 4, stone: 0 } } }));
  assert.throws(() => decideMotivatedAgent({ ...input, policy: { ...input.policy, width: 0 } }));
  assert.throws(() => createMotivationConfig({ moveCost: Infinity }));
  assert.throws(() => createMotivationConfig({ switchMargin: -1 }));
  assert.throws(() => createMotivationConfig({ maxCommitmentTicks: 1025 }));
  const prior = decideMotivatedAgent(input).nextState;
  assert.throws(() => decideMotivatedAgent({ ...input, previous: prior }));
  assert.throws(() => decideMotivatedAgent({ ...sample(2), previous: { ...prior, observerId: 999 } }));
  assert.throws(() => restoreGoalState({ ...prior, goal: 'invent-food' }));
  assert.throws(() => restoreGoalState({ ...prior, sinceTick: 10 }));
  assert.throws(() => restoreGoalState({ ...prior, version: 2 }));
});
