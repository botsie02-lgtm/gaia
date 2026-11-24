import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld, stepWorld, snapshot } from '../.sim-test/world.js';
import { EventLedger } from '../.sim-test/history/events.js';

function fixture(options = {}, amount = 3) {
  const world = createWorld(42, options);
  const [agent, other] = world.agents;
  world.agents = [agent, other];
  const material = agent.id % 2 === 0 ? 'wood' : 'stone';
  const deposit = world.deposits.find(d => d.material === material);
  world.deposits = [deposit];
  agent.x = deposit.x;
  agent.y = deposit.y;
  agent.energy = 100;
  other.energy = 20;
  other.resting = true;
  deposit.amount = amount;
  return { world, agent, other, deposit, material };
}

test('harvesting and depletion record real quantities, logical ticks and stable IDs', () => {
  const { world, agent, deposit, material } = fixture({}, 2);
  const id = deposit.id;
  assert.equal(world.history.size, 0);
  stepWorld(world);
  assert.equal(deposit.amount, 1);
  assert.equal(agent.cargo[material], 1);
  assert.equal(world.history.query({ kind: 'resource.depleted' }).length, 0);
  stepWorld(world);
  assert.equal(world.deposits.length, 0);
  assert.deepEqual(world.history.query(), [
    { eventId: 1, tick: 1, kind: 'resource.harvested', actorId: agent.id, targetId: id,
      details: { material, amount: 1, remaining: 1, unit: 'prototype-unit' } },
    { eventId: 2, tick: 2, kind: 'resource.harvested', actorId: agent.id, targetId: id,
      details: { material, amount: 1, remaining: 0, unit: 'prototype-unit' } },
    { eventId: 3, tick: 2, kind: 'resource.depleted', actorId: agent.id, targetId: id,
      details: { material, remaining: 0, unit: 'prototype-unit' } },
  ]);
  stepWorld(world);
  assert.equal(world.history.query({ entityId: id }).length, 3);
  assert.equal(agent.skills.gathering.attempts, 2);
});

test('practice is independent and accrues only on successful harvest, not rest, movement or delivery', () => {
  const { world, agent, other, material } = fixture();
  assert.notEqual(agent.skills.gathering, other.skills.gathering);
  stepWorld(world);
  assert.equal(agent.skills.gathering.attempts, 1);
  assert.equal(agent.skills.gathering.successes, 1);
  assert.equal(agent.skills.gathering.experience, 2);
  assert.equal(agent.skills.gathering.proficiency, 2 / 102);
  assert.equal(other.skills.gathering.attempts, 0);
  agent.resting = true;
  stepWorld(world);
  agent.resting = false;
  agent.x = world.hub.x;
  agent.y = world.hub.y;
  stepWorld(world);
  assert.equal(agent.cargo[material], 0);
  assert.equal(world.inventory[material], 1);
  const delivery = world.history.query({ kind: 'stockpile.delivered' })[0];
  assert.deepEqual(delivery, { eventId: 2, tick: 3, kind: 'stockpile.delivered',
    actorId: agent.id, targetId: world.hub.id,
    details: { wood: material === 'wood' ? 1 : 0, stone: material === 'stone' ? 1 : 0, unit: 'prototype-unit' } });
  stepWorld(world);
  assert.equal(agent.skills.gathering.attempts, 1);
  assert.equal(other.skills.gathering.attempts, 0);
});

test('two agents competing for the last unit credit only the actual harvester', () => {
  const { world, agent, other, deposit, material } = fixture({}, 1);
  other.resting = false;
  other.energy = 100;
  other.x = deposit.x;
  other.y = deposit.y;
  // Make the second agent seek the same material without changing its ID.
  other.cargo[material] = 1;
  stepWorld(world);
  assert.equal(agent.skills.gathering.attempts, 1);
  assert.equal(other.skills.gathering.attempts, 0);
  assert.equal(world.history.query({ kind: 'resource.harvested' }).length, 1);
  assert.equal(world.history.query({ kind: 'resource.depleted' }).length, 1);
});

test('configured milestones fire once at each crossing, without unlocking expert skill', () => {
  const thresholds = [1, 2];
  const { world, agent } = fixture({ gatheringMilestones: thresholds });
  thresholds.push(3);
  for (let i = 0; i < 5; i++) stepWorld(world);
  const events = world.history.query({ kind: 'skill.milestone' });
  assert.deepEqual(events.map(e => [e.tick, e.actorId, e.details.attempts]), [[1, agent.id, 1], [2, agent.id, 2]]);
  assert.equal(events[1].details.proficiency, 4 / 104);
  assert.equal(agent.skills.gathering.attempts, 3);
  assert.ok(agent.skills.gathering.proficiency < 0.1);
  assert.throws(() => createWorld(42, { gatheringMilestones: [2, 1] }));
  assert.throws(() => createWorld(42, { eventCapacity: 0 }));
});

test('construction, fuel burn and automatic refueling record only committed transitions', () => {
  const world = createWorld(42);
  world.agents = [];
  world.inventory = { wood: 6, stone: 8 };
  stepWorld(world);
  const [hearth] = world.structures;
  assert.equal(world.inventory.wood, 2);
  assert.equal(world.inventory.stone, 0);
  assert.equal(hearth.fuel, 4);
  assert.deepEqual(world.history.query(), [{
    eventId: 1, tick: 1, kind: 'structure.built', targetId: hearth.id,
    details: { structure: 'hearth', stockpileId: world.hub.id, wood: 4, stone: 8, unit: 'prototype-unit' },
  }]);
  for (let i = 1; i < 90; i++) stepWorld(world);
  assert.equal(hearth.fuel, 3);
  assert.equal(world.inventory.wood, 0);
  const fuel = world.history.query({ entityId: hearth.id });
  assert.deepEqual(fuel.map(e => [e.tick, e.kind]), [
    [1, 'structure.built'], [30, 'hearth.fuel_consumed'], [60, 'hearth.fuel_consumed'],
    [90, 'hearth.fuel_consumed'], [90, 'hearth.refueled'],
  ]);
  assert.deepEqual(fuel[3].details, { material: 'wood', amount: 1, fuelRemaining: 1, unit: 'prototype-unit' });
  assert.deepEqual(fuel[4].details, { stockpileId: world.hub.id, material: 'wood', amount: 2, fuelRemaining: 3, unit: 'prototype-unit' });
  for (let i = 90; i < 210; i++) stepWorld(world);
  assert.equal(hearth.fuel, 0);
  assert.equal(world.history.query({ kind: 'hearth.fuel_consumed' }).length, 6);
  assert.equal(world.history.query({ kind: 'structure.built' }).length, 1);
});

test('retention is bounded; ledger JSON restores IDs and agent records survive snapshots', () => {
  const { world, agent } = fixture({ eventCapacity: 2, gatheringMilestones: [1, 2] });
  for (let i = 0; i < 3; i++) stepWorld(world);
  assert.equal(world.history.size, 2);
  const parsed = JSON.parse(snapshot(world));
  assert.deepEqual(parsed.history.events.map(e => e.eventId), [5, 6]);
  assert.equal(parsed.history.nextEventId, 7);
  assert.deepEqual(parsed.agents[0].skills.gathering, agent.skills.gathering);
  assert.deepEqual(parsed.gatheringSkillConfig.attemptMilestones, [1, 2]);
  const restored = EventLedger.fromSnapshot(parsed.history);
  assert.deepEqual(restored.snapshot(), world.history.snapshot());
  assert.equal(restored.append({ tick: world.tick + 1, kind: 'test' }).eventId, 7);
  assert.equal(world.history.snapshot().nextEventId, 7);
  assert.equal(createWorld(42).history.size, 0);
});

test('seeded runs reproduce complete snapshots, including history and skills after eviction', () => {
  const run = () => {
    const world = createWorld(12345, { eventCapacity: 32, gatheringMilestones: [2, 10] });
    for (let i = 0; i < 300; i++) stepWorld(world);
    return world;
  };
  const a = run(), b = run();
  assert.equal(snapshot(a), snapshot(b));
  assert.equal(a.history.size, 32);
  assert.ok(a.history.snapshot().nextEventId > 33);
  assert.equal(a.structures.length, 1);
  const total = a.agents.reduce((n, agent) => n + agent.skills.gathering.attempts, 0);
  assert.equal(total, a.stats.woodHarvested + a.stats.stoneHarvested);
  assert.notEqual(a.history, b.history);
});
