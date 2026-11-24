import test from 'node:test';
import assert from 'node:assert/strict';
import { observeAgent, DEFAULT_PERCEPTION_RANGE } from '../.sim-test/perception/index.js';
import { createWorld, stepWorld, snapshot } from '../.sim-test/world.js';

function fixture() {
  const world = createWorld(42);
  world.width = 7;
  world.height = 7;
  world.terrain = Array(49).fill('grass');
  world.tick = 12;
  const [a,b,c,d] = world.agents;
  Object.assign(a, { x: 3, y: 3, faction: 'settler' });
  Object.assign(b, { x: 5, y: 3, faction: 'neutral' });
  Object.assign(c, { x: 4, y: 5, faction: 'hostile' });
  Object.assign(d, { x: 3, y: 3, faction: 'hostile' });
  world.agents = [c,b,d,a];
  world.deposits = [
    { id: 302, kind: 'deposit', material: 'stone', amount: 2, x: 3, y: 1 },
    { id: 301, kind: 'deposit', material: 'wood', amount: 4, x: 4, y: 3 },
    { id: 303, kind: 'deposit', material: 'wood', amount: 5, x: 6, y: 3 },
  ];
  world.structures = [
    { id: 401, kind: 'structure', structure: 'hearth', x: 3, y: 4, fuel: 4, heat: 20, stoneUsed: 8 },
    { id: 402, kind: 'structure', structure: 'hearth', x: 0, y: 0, fuel: 3, heat: 10, stoneUsed: 8 },
  ];
  world.hub = { id: 501, x: 2, y: 3 };
  world.nextEntityId = 502;
  return { world, a, b, c, d };
}

const tile = (obs, x, y) => obs.terrain.find(t => t.x === x && t.y === y);
const ids = list => list.map(x => x.id);
const sorted = list => [...list].sort((a,b) => a-b);
const paint = (world, x, y, terrain) => { world.terrain[y * world.width + x] = terrain; };

test('inclusive Manhattan boundary, stable IDs, local hub, terrain and material IDs', () => {
  const { world, a, b, d } = fixture();
  const view = observeAgent(world, a.id, { range: 2 });
  assert.equal(view.tick, 12);
  assert.equal(view.observer.id, a.id);
  assert.equal(view.range, 2);
  assert.equal(view.terrain.length, 13);
  assert.ok(tile(view, 5, 3));
  assert.ok(tile(view, 4, 4));
  assert.equal(tile(view, 5, 4), undefined);
  assert.deepEqual(ids(view.agents), sorted([b.id,d.id]));
  assert.deepEqual(ids(view.deposits), [301,302]);
  assert.deepEqual(view.deposits.map(d => d.material), ['wood','stone']);
  assert.equal(view.deposits[0].amount, 4);
  assert.deepEqual(ids(view.structures), [401]);
  assert.deepEqual(view.hub, { id: 501, kind: 'hub', x: 2, y: 3 });
});

test('zero range includes shared tile but not self in nearby agents; edges clip', () => {
  const { world, a, d } = fixture();
  const zero = observeAgent(world, a.id, { range: 0 });
  assert.deepEqual(zero.terrain, [{ x: 3, y: 3, terrain: 'grass' }]);
  assert.deepEqual(ids(zero.agents), [d.id]);
  assert.equal(zero.hub, null);
  a.x = 0; a.y = 0;
  const edge = observeAgent(world, a.id, { range: 2 });
  assert.equal(edge.terrain.length, 6);
  assert.ok(edge.terrain.every(t => t.x >= 0 && t.y >= 0));
  assert.equal(observeAgent(world, a.id).range, DEFAULT_PERCEPTION_RANGE);
  assert.equal(observeAgent(world, a.id, { range: Number.MAX_SAFE_INTEGER }).terrain.length, 49);
});

test('opaque target visible but tiles and all object categories behind it are hidden', () => {
  const { world, a, b } = fixture();
  paint(world, 4, 3, 'water');
  world.structures[0].x = 5; world.structures[0].y = 3;
  world.hub.x = 5; world.hub.y = 3;
  const blocked = observeAgent(world, a.id, { range: 3, opaqueTerrain: ['water'] });
  assert.equal(tile(blocked, 4, 3).terrain, 'water');
  assert.equal(tile(blocked, 5, 3), undefined);
  assert.ok(!ids(blocked.agents).includes(b.id));
  assert.deepEqual(ids(blocked.deposits), [301,302]);
  assert.equal(blocked.structures.length, 0);
  assert.equal(blocked.hub, null);
  const clear = observeAgent(world, a.id, { range: 3 });
  assert.ok(ids(clear.agents).includes(b.id));
  assert.deepEqual(ids(clear.deposits), [301,302,303]);
  assert.deepEqual(ids(clear.structures), [401]);
  assert.equal(clear.hub.id, 501);
});

test('conservative diagonal corners and oblique rays; source is exempt', () => {
  const { world, a } = fixture();
  paint(world, 3, 3, 'water');
  paint(world, 4, 3, 'dirt');
  const options = { range: 5, opaqueTerrain: ['water','dirt'] };
  const view = observeAgent(world, a.id, options);
  assert.ok(tile(view, 3, 3));
  assert.ok(tile(view, 4, 3));
  assert.equal(tile(view, 4, 4), undefined);
  assert.equal(tile(view, 5, 4), undefined);
  assert.ok(tile(view, 2, 2));
  paint(world, 4, 3, 'grass');
  paint(world, 3, 4, 'dirt');
  assert.equal(tile(observeAgent(world, a.id, options), 4, 4), undefined);
  paint(world, 3, 4, 'grass');
  assert.ok(tile(observeAgent(world, a.id, options), 4, 4));
});

test('same API for all factions; observations depend on each observer, not global knowledge', () => {
  const { world, a, b, c } = fixture();
  const options = { range: 2 };
  const settler = observeAgent(world, a.id, options);
  const neutral = observeAgent(world, b.id, options);
  const hostile = observeAgent(world, c.id, options);
  assert.equal(settler.observer.faction, 'settler');
  assert.equal(neutral.observer.faction, 'neutral');
  assert.equal(hostile.observer.faction, 'hostile');
  assert.ok(ids(settler.agents).includes(b.id));
  assert.ok(ids(neutral.agents).includes(a.id));
  assert.ok(!ids(hostile.agents).includes(a.id));
  assert.notDeepEqual(settler.terrain, hostile.terrain);
  assert.notStrictEqual(settler.terrain, neutral.terrain);
});

test('snapshot deeply frozen, detached, and hides internal/global state', () => {
  const { world, a, b } = fixture();
  const before = snapshot(world);
  const view = observeAgent(world, a.id, { range: 3 });
  assert.equal(snapshot(world), before);
  const serialized = JSON.stringify(view);
  for (const node of [view, view.observer, view.hub, ...['terrain','agents','deposits','structures'].flatMap(k => [view[k], ...view[k]])]) {
    assert.ok(Object.isFrozen(node));
  }
  assert.throws(() => { view.observer.x = 0; }, TypeError);
  assert.throws(() => { view.deposits[0].amount = 0; }, TypeError);
  assert.throws(() => { view.agents.push({}); }, TypeError);
  for (const key of ['history','seed','randomState','inventory','skills','cargo','energy','heat','fuel','stats','nextEntityId']) {
    assert.ok(!serialized.includes('"' + key + '"'));
  }
  b.x = 0;
  world.deposits[1].amount = 0;
  paint(world, 3, 3, 'dirt');
  world.hub.x = 0;
  world.tick++;
  assert.equal(JSON.stringify(view), serialized);
  assert.notEqual(JSON.stringify(observeAgent(world, a.id, { range: 3 })), serialized);
});

test('invisible changes cannot leak through observation and entity ordering is canonical', () => {
  const { world, a, c } = fixture();
  const options = { range: 2 };
  const view = observeAgent(world, a.id, options);
  c.energy = 0;
  world.deposits[2].amount = 99;
  paint(world, 0, 0, 'water');
  world.inventory.wood = 100;
  world.agents.reverse(); world.deposits.reverse(); world.structures.reverse();
  assert.deepEqual(observeAgent(world, a.id, options), view);
});

test('identical seeded worlds and ticks produce identical observations without changing simulation', () => {
  const a = createWorld(12345);
  const b = createWorld(12345);
  const options = { range: 6, opaqueTerrain: ['water'] };
  for (let tick = 0; tick < 40; tick++) {
    for (const agent of a.agents) {
      const view = observeAgent(a, agent.id, options);
      assert.deepEqual(view, observeAgent(b, agent.id, options));
      assert.equal(view.tick, tick);
    }
    assert.equal(snapshot(a), snapshot(b));
    stepWorld(a); stepWorld(b);
  }
  assert.equal(snapshot(a), snapshot(b));
});

test('reject invalid observer, position, options, dimensions and tick', () => {
  const { world, a } = fixture();
  for (const range of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => observeAgent(world, a.id, { range }), RangeError);
  }
  for (const id of [0,-1,1.5,NaN,99999]) {
    assert.throws(() => observeAgent(world, id), RangeError);
  }
  assert.throws(() => observeAgent(world, a.id, { opaqueTerrain: ['lava'] }), RangeError);
  assert.throws(() => observeAgent({ ...world, width: 8 }, a.id), RangeError);
  assert.throws(() => observeAgent({ ...world, tick: -1 }, a.id), RangeError);
  a.x = -1;
  assert.throws(() => observeAgent(world, a.id), RangeError);
});
