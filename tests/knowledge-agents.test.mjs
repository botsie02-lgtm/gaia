import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld, stepWorld, snapshot, executeAgentAction, CARGO_LIMIT, passable } from '../.sim-test/world.js';
import { decideAgent } from '../.sim-test/agents/index.js';
import { observeAgent } from '../.sim-test/perception/index.js';
import { AgentMemory } from '../.sim-test/memory/index.js';

function fixture(options = {}) {
  const world = createWorld(42, { agentMode: 'knowledge', perceptionRange: 2, ...options });
  const [agent, other] = world.agents;
  world.agents = [agent];
  world.terrain.fill('grass');
  world.deposits = [];
  Object.assign(agent, { x: 10, y: 10, energy: 100, resting: false });
  Object.assign(world.hub, { x: 20, y: 20 });
  return { world, agent, other };
}
function deposit(world, x, y, amount = 3, material = 'wood') {
  const d = { id: world.nextEntityId++, kind: 'deposit', x, y, amount, material };
  world.deposits.push(d);
  return d;
}
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) stepWorld(world); };

test('legacy is the headless default; knowledge configuration validates', () => {
  assert.equal(createWorld().agentMode, 'legacy');
  assert.throws(() => createWorld(1, { agentMode: 'unknown' }));
  assert.throws(() => createWorld(1, { memoryCapacity: 0 }));
  assert.throws(() => createWorld(1, { perceptionRange: -1 }));
});
test('knowledge runs reproduce full snapshots, including memory and decisions', () => {
  const a = createWorld(12345, { agentMode: 'knowledge' });
  const b = createWorld(12345, { agentMode: 'knowledge' });
  run(a, 100); run(b, 100);
  assert.equal(snapshot(a), snapshot(b));
  assert.ok(a.stats.woodHarvested > 0 && a.stats.stoneHarvested > 0);
  assert.ok(a.history.query({ kind: 'stockpile.delivered' }).length > 0);
  for (const agent of a.agents) {
    assert.equal(agent.memory.snapshot().lastObservationTick, 100);
    assert.ok(agent.memory.size <= agent.memory.capacity);
    assert.ok(passable(a, agent.x, agent.y));
    assert.ok(agent.energy >= 0 && agent.energy <= 100);
    assert.ok(agent.cargo.wood + agent.cargo.stone <= CARGO_LIMIT);
  }
});
test('exploration advances only on observed or remembered walkable terrain', () => {
  const { world, agent } = fixture();
  const start = { x: agent.x, y: agent.y };
  stepWorld(world);
  assert.match(agent.decision.intention, /Explore/);
  assert.equal(agent.decision.action.kind, 'move');
  assert.ok(agent.observation.terrain.some(t => t.x === agent.x && t.y === agent.y && t.terrain !== 'water'));
  assert.notDeepEqual({ x: agent.x, y: agent.y }, start);
  assert.equal(agent.observation.hub, null);
  assert.equal(agent.memory.query({ kind: 'hub' }).length, 0);
});
test('range zero does not treat adjacent unknown terrain as walkable', () => {
  const { world, agent } = fixture({ perceptionRange: 0 });
  stepWorld(world);
  assert.equal(agent.decision.action.kind, 'idle');
  assert.equal(agent.x, 10);
  assert.equal(agent.y, 10);
});
test('individual memories and faction-neutral perception are independent', () => {
  const { world, agent, other } = fixture({ memoryCapacity: 16 });
  const d = deposit(world, 10, 10);
  agent.faction = 'hostile';
  Object.assign(other, { x: 30, y: 20, energy: 100, faction: 'neutral' });
  world.agents.push(other);
  stepWorld(world);
  assert.notEqual(agent.memory, other.memory);
  assert.ok(agent.memory.query({ entityId: d.id }).length);
  assert.equal(other.memory.query({ entityId: d.id }).length, 0);
  assert.equal(agent.memory.snapshot().lastObservationTick, 1);
  assert.equal(other.memory.snapshot().lastObservationTick, 1);
  assert.ok(agent.memory.size <= 16 && other.memory.size <= 16);
  assert.equal(agent.skills.gathering.attempts, 1);
  assert.equal(other.skills.gathering.attempts, 0);
});
test('unseen resource and hidden inventory changes cannot alter immediate decision', () => {
  const a = fixture(), b = fixture();
  deposit(a.world, 40, 20, 1);
  deposit(b.world, 40, 20, 999);
  b.world.inventory.wood = 100;
  b.world.hub.x = 45;
  stepWorld(a.world); stepWorld(b.world);
  assert.deepEqual(a.agent.observation, b.agent.observation);
  assert.deepEqual(a.agent.memory.snapshot(), b.agent.memory.snapshot());
  assert.deepEqual(a.agent.decision, b.agent.decision);
});
test('stale deposits remain historical until revisited, then absence invalidates target', () => {
  const { world, agent } = fixture();
  const d = deposit(world, 12, 10);
  agent.resting = true;
  stepWorld(world);
  assert.equal(agent.memory.query({ entityId: d.id })[0].status, 'current');
  agent.x = 20;
  world.deposits = [];
  stepWorld(world);
  assert.equal(agent.memory.query({ entityId: d.id })[0].status, 'stale');
  agent.x = 12;
  agent.resting = false;
  stepWorld(world);
  assert.equal(agent.memory.query({ entityId: d.id })[0].status, 'absent');
  assert.notEqual(agent.decision.action.kind, 'harvest');
});
test('remembered reachable deposits can be selected beyond perception', () => {
  const { world, agent } = fixture({ perceptionRange: 1 });
  const d = deposit(world, 12, 10);
  agent.resting = true;
  agent.x = 11;
  stepWorld(world);
  agent.x = 10;
  agent.resting = false;
  stepWorld(world);
  assert.equal(agent.observation.deposits.length, 0);
  assert.equal(agent.memory.query({ entityId: d.id })[0].status, 'stale');
  assert.match(agent.decision.intention, new RegExp('#' + d.id + '$'));
  assert.equal(agent.x, 11);
});
test('contested last unit is resolved once, in stable ID order', () => {
  const { world, agent, other } = fixture();
  const d = deposit(world, 10, 10, 1);
  Object.assign(other, { x: 10, y: 10, energy: 100 });
  world.agents = [other, agent];
  stepWorld(world);
  assert.equal(agent.decision.action.kind, 'harvest');
  assert.equal(other.decision.action.kind, 'harvest');
  assert.equal(agent.skills.gathering.attempts, 1);
  assert.equal(other.skills.gathering.attempts, 0);
  assert.equal(d.amount, 0);
  assert.equal(world.history.query({ kind: 'resource.harvested' }).length, 1);
  stepWorld(world);
  assert.equal(other.memory.query({ entityId: d.id })[0].status, 'absent');
});
test('executor rejects illegal moves, distant harvests and wrong hub delivery', () => {
  const { world, agent } = fixture();
  const d = deposit(world, 12, 10);
  world.terrain[10 * world.width + 11] = 'water';
  agent.cargo.wood = 1;
  executeAgentAction(world, agent, { kind: 'move', to: { x: 11, y: 10 } });
  executeAgentAction(world, agent, { kind: 'move', to: { x: 12, y: 10 } });
  executeAgentAction(world, agent, { kind: 'harvest', targetId: d.id });
  executeAgentAction(world, agent, { kind: 'deliver', targetId: world.hub.id });
  assert.equal(agent.x, 10);
  assert.equal(agent.energy, 100);
  assert.equal(d.amount, 3);
  assert.equal(agent.cargo.wood, 1);
  assert.equal(world.history.size, 0);
});
test('hub is discovered, remembered and used for delivery without hidden coordinates', () => {
  const { world, agent } = fixture({ perceptionRange: 1 });
  world.hub.x = 10; world.hub.y = 10;
  const d = deposit(world, 12, 10, 3);
  agent.resting = true;
  stepWorld(world);
  assert.equal(agent.memory.query({ kind: 'hub' })[0].status, 'current');
  agent.x = 11;
  stepWorld(world);
  agent.x = 12;
  agent.resting = false;
  run(world, 3);
  assert.equal(agent.cargo.wood, 3);
  assert.equal(agent.observation.hub, null);
  assert.equal(agent.memory.query({ kind: 'hub' })[0].status, 'stale');
  run(world, 3);
  assert.equal(agent.cargo.wood, 0);
  assert.equal(world.inventory.wood, 3);
  assert.equal(d.amount, 0);
  assert.equal(world.history.query({ kind: 'stockpile.delivered' }).length, 1);
});
test('pure policy rejects another agent memory and does not mutate local evidence', () => {
  const { world, agent, other } = fixture();
  const observation = observeAgent(world, agent.id);
  const memory = agent.memory.update(observation);
  const config = { width: world.width, height: world.height, cargoLimit: CARGO_LIMIT };
  const own = { energy: agent.energy, resting: false, cargo: agent.cargo };
  const before = JSON.stringify({ observation, memory, own });
  decideAgent(observation, memory, own, config);
  assert.equal(JSON.stringify({ observation, memory, own }), before);
  assert.throws(() => decideAgent(observation, new AgentMemory(other.id).snapshot(), own, config));
});
test('knowledge mode conserves prototype resource units including hearth consumption', () => {
  const world = createWorld(12345, { agentMode: 'knowledge', eventCapacity: 10000 });
  const initial = Object.fromEntries(['wood','stone'].map(m => [m, world.deposits.filter(d => d.material === m).reduce((s,d) => s+d.amount,0)]));
  run(world, 250);
  for (const m of ['wood','stone']) {
    const remaining = world.deposits.filter(d => d.material === m).reduce((s,d) => s+d.amount,0);
    const cargo = world.agents.reduce((s,a) => s+a.cargo[m],0);
    const structures = world.structures.reduce((s,h) => s+(m === 'wood' ? h.fuel : h.stoneUsed),0);
    const burned = m === 'wood' ? world.history.query({ kind: 'hearth.fuel_consumed' }).length : 0;
    assert.equal(remaining + cargo + world.inventory[m] + structures + burned, initial[m]);
  }
  assert.equal(world.agents.reduce((s,a) => s+a.skills.gathering.attempts,0), world.stats.woodHarvested + world.stats.stoneHarvested);
});
