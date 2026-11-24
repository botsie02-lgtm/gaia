import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld, nextStep, passable, stepWorld } from '../.sim-test/world.js';

const run = (seed, ticks) => {
  const world = createWorld(seed);
  for (let i = 0; i < ticks; i++) stepWorld(world);
  return world;
};

test('same seed and same number of steps yields the same world', () => {
  assert.deepEqual(run(42, 200), run(42, 200));
});

test('different seeds produce different worlds', () => {
  assert.notDeepEqual(createWorld(42).terrain, createWorld(43).terrain);
});

test('agents remain within walkable land', () => {
  const world = run(12345, 400);
  for (const agent of world.agents) assert.ok(passable(world, agent.x, agent.y));
});

test('resource values never become negative and agents stay within energy bounds', () => {
  const world = run(12345, 1200);
  for (const item of world.deposits) assert.ok(item.amount > 0);
  for (const material of ['wood', 'stone']) assert.ok(world.inventory[material] >= 0);
  for (const agent of world.agents) {
    assert.ok(agent.energy >= 0 && agent.energy <= 100);
    assert.ok(agent.cargo.wood >= 0 && agent.cargo.stone >= 0);
  }
  for (const hearth of world.structures) {
    assert.ok(hearth.fuel >= 0);
    assert.ok(hearth.heat >= 0);
  }
});

test('settlers eventually build one hearth from finite resources', () => {
  const world = run(12345, 1200);
  assert.equal(world.structures.length, 1);
  assert.equal(world.stats.hearthsBuilt, 1);
  assert.equal(world.structures[0].stoneUsed, 8);
});

test('pathfinding respects impassable water', () => {
  const world = createWorld(5);
  const next = nextStep(world, { x: world.hub.x, y: world.hub.y }, { x: world.hub.x + 4, y: world.hub.y });
  assert.ok(next);
  assert.ok(passable(world, next.x, next.y));
});
