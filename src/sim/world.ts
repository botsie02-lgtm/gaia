import type { Agent, Deposit, Hearth, Material, Position, Terrain, World } from './model.js';
import { initialRandomState, random } from './random.js';

export const WIDTH = 52;
export const HEIGHT = 34;
export const AGENT_COUNT = 14;
export const CARGO_LIMIT = 3;
export const HEARTH_COST: Readonly<Record<Material, number>> = { wood: 4, stone: 8 };

export function indexOf(world: World, x: number, y: number): number {
  return y * world.width + x;
}

export function passable(world: World, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < world.width && y < world.height &&
    world.terrain[indexOf(world, x, y)] !== 'water';
}

export function createWorld(seed = 12345): World {
  const width = WIDTH;
  const height = HEIGHT;
  const hub = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const world: World = {
    seed,
    randomState: initialRandomState(seed),
    tick: 0,
    nextEntityId: 1,
    width,
    height,
    terrain: [],
    hub,
    inventory: { wood: 0, stone: 0 },
    agents: [],
    deposits: [],
    structures: [],
    stats: { woodHarvested: 0, stoneHarvested: 0, hearthsBuilt: 0 },
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = Math.abs(x - hub.x) + Math.abs(y - hub.y);
      const roll = random(world);
      const terrain: Terrain = distance < 7 ? 'grass' : roll < 0.055 ? 'water' : roll < 0.25 ? 'dirt' : 'grass';
      world.terrain.push(terrain);
    }
  }

  // Generate finite deposits. Reserve enough material to make a hearth.
  spawnDeposits(world, 'wood', 80, 3, 9);
  spawnDeposits(world, 'stone', 55, 2, 7);

  for (let i = 0; i < AGENT_COUNT; i++) {
    const agent: Agent = {
      id: world.nextEntityId++,
      kind: 'agent',
      faction: 'settler',
      x: hub.x + (i % 5) - 2,
      y: hub.y + Math.floor(i / 5) - 1,
      energy: 65 + Math.floor(random(world) * 35),
      resting: false,
      cargo: { wood: 0, stone: 0 },
    };
    world.agents.push(agent);
  }
  return world;
}

function spawnDeposits(world: World, material: Material, count: number, min: number, max: number): void {
  let made = 0;
  let tries = 0;
  while (made < count && tries < count * 40) {
    tries++;
    const x = 2 + Math.floor(random(world) * (world.width - 4));
    const y = 2 + Math.floor(random(world) * (world.height - 4));
    const distance = Math.abs(x - world.hub.x) + Math.abs(y - world.hub.y);
    if (distance < 5 || !passable(world, x, y)) continue;
    if (world.deposits.some((p) => p.x === x && p.y === y)) continue;
    const deposit: Deposit = {
      id: world.nextEntityId++, kind: 'deposit', material, x, y,
      amount: min + Math.floor(random(world) * (max - min + 1)),
    };
    world.deposits.push(deposit);
    made++;
  }
}

function cargoCount(agent: Agent): number {
  return agent.cargo.wood + agent.cargo.stone;
}

/** Return the first step on a shortest walkable route. No diagonal movement. */
export function nextStep(world: World, origin: Position, target: Position): Position | null {
  if (origin.x === target.x && origin.y === target.y) return null;
  if (!passable(world, target.x, target.y)) return null;
  const start = indexOf(world, origin.x, origin.y);
  const finish = indexOf(world, target.x, target.y);
  const parents = new Int32Array(world.width * world.height).fill(-1);
  const queue = new Int32Array(world.width * world.height);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  parents[start] = start;
  while (head < tail) {
    const current = queue[head++];
    if (current === undefined) break;
    if (current === finish) break;
    const x = current % world.width;
    const y = Math.floor(current / world.width);
    const neighbors: Position[] = [
      { x: x + 1, y }, { x, y: y + 1 }, { x: x - 1, y }, { x, y: y - 1 },
    ];
    for (const neighbor of neighbors) {
      if (!passable(world, neighbor.x, neighbor.y)) continue;
      const next = indexOf(world, neighbor.x, neighbor.y);
      if (parents[next] !== -1) continue;
      parents[next] = current;
      queue[tail++] = next;
    }
  }
  if (parents[finish] === -1) return null;
  let current = finish;
  while (parents[current] !== start) {
    const parent = parents[current];
    if (parent === undefined || parent === -1) return null;
    current = parent;
  }
  return { x: current % world.width, y: Math.floor(current / world.width) };
}

function goTo(world: World, agent: Agent, destination: Position): void {
  const step = nextStep(world, agent, destination);
  if (!step) return;
  agent.x = step.x;
  agent.y = step.y;
  agent.energy = Math.max(0, agent.energy - 1);
}

function chooseMaterial(world: World, agent: Agent): Material | null {
  if (cargoCount(agent) > 0) return agent.cargo.wood > 0 ? 'wood' : 'stone';
  const pendingWood = world.inventory.wood + world.agents.reduce((n, a) => n + a.cargo.wood, 0);
  const pendingStone = world.inventory.stone + world.agents.reduce((n, a) => n + a.cargo.stone, 0);
  const needsWood = world.structures.length === 0 && pendingWood < HEARTH_COST.wood;
  const needsStone = world.structures.length === 0 && pendingStone < HEARTH_COST.stone;
  if (needsWood && needsStone) return agent.id % 2 === 0 ? 'wood' : 'stone';
  if (needsWood) return 'wood';
  if (needsStone) return 'stone';
  // There is no fixed "win" state: the living world keeps collecting resources.
  return agent.id % 2 === 0 ? 'wood' : 'stone';
}

function nearestDeposit(world: World, agent: Agent, material: Material): Deposit | undefined {
  let nearest: Deposit | undefined;
  let nearestDistance = Infinity;
  for (const deposit of world.deposits) {
    if (deposit.material !== material || deposit.amount <= 0) continue;
    const distance = Math.abs(agent.x - deposit.x) + Math.abs(agent.y - deposit.y);
    if (distance < nearestDistance) {
      nearest = deposit;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function act(world: World, agent: Agent): void {
  if (agent.energy <= 12) agent.resting = true;
  if (agent.resting) {
    agent.energy = Math.min(100, agent.energy + 5);
    if (agent.energy >= 70) agent.resting = false;
    return;
  }

  const carrying = cargoCount(agent);
  const atHub = agent.x === world.hub.x && agent.y === world.hub.y;
  if (atHub && carrying > 0) {
    world.inventory.wood += agent.cargo.wood;
    world.inventory.stone += agent.cargo.stone;
    agent.cargo = { wood: 0, stone: 0 };
    return;
  }
  if (carrying >= CARGO_LIMIT) {
    goTo(world, agent, world.hub);
    return;
  }

  const material = chooseMaterial(world, agent);
  if (!material) return;
  const deposit = nearestDeposit(world, agent, material);
  if (!deposit) {
    if (carrying > 0) goTo(world, agent, world.hub);
    return;
  }
  if (deposit.x === agent.x && deposit.y === agent.y) {
    deposit.amount -= 1;
    agent.cargo[material] += 1;
    agent.energy = Math.max(0, agent.energy - 1);
    if (material === 'wood') world.stats.woodHarvested++;
    else world.stats.stoneHarvested++;
    return;
  }
  goTo(world, agent, deposit);
}

function processHearth(world: World, hearth: Hearth): void {
  // 1 fuel unit burns per 30 ticks; heat rises on combustion and cools every tick.
  if (world.tick % 30 === 0 && hearth.fuel > 0) {
    hearth.fuel--;
    hearth.heat += 25;
  }
  hearth.heat = Math.max(0, hearth.heat - 0.6);
  // An agent can replenish the hearth from the shared inventory.
  if (hearth.fuel < 2 && world.inventory.wood >= 2) {
    world.inventory.wood -= 2;
    hearth.fuel += 2;
  }
}

/** Fixed-step, deterministic simulation. No Date.now/Math.random/DOM access. */
export function stepWorld(world: World): void {
  world.tick++;
  for (const agent of world.agents) act(world, agent);

  if (world.structures.length === 0 &&
      world.inventory.wood >= HEARTH_COST.wood &&
      world.inventory.stone >= HEARTH_COST.stone) {
    world.inventory.wood -= HEARTH_COST.wood;
    world.inventory.stone -= HEARTH_COST.stone;
    world.structures.push({
      id: world.nextEntityId++, kind: 'structure', structure: 'hearth',
      x: world.hub.x + 2, y: world.hub.y,
      stoneUsed: HEARTH_COST.stone,
      fuel: HEARTH_COST.wood,
      heat: 0,
    });
    world.stats.hearthsBuilt++;
  }
  for (const hearth of world.structures) processHearth(world, hearth);
  // Remove depleted deposits to avoid accumulating inactive objects.
  world.deposits = world.deposits.filter((deposit) => deposit.amount > 0);
}

export function snapshot(world: World): string {
  // For reproducibility and deterministic regression tests.
  return JSON.stringify(world);
}
