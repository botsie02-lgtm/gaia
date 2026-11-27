import type { Agent, Deposit, Hearth, Material, Position, Terrain, World } from './model.js';
import { initialRandomState, random } from './random.js';
import { EventLedger } from './history/events.js';
import { applyPracticeOutcome, createSkillRecord } from './skills/index.js';
import type { SkillConfig } from './skills/index.js';

import { AgentMemory, DEFAULT_MEMORY_CAPACITY } from './memory/index.js';
import { observeAgent, DEFAULT_PERCEPTION_RANGE } from './perception/index.js';
import { decideAgent } from './agents/index.js';
import type { AgentMode, AgentAction } from './agents/index.js';
import type { Inventory } from './model.js';
import type { ResourceMode } from './physical-world.js';
import { physicalConfig, initializePhysicalWorld, movePhysical, physicalDetails, bindHearth } from './physical-world.js';
import { resourceOwnerId } from './resource-actions/index.js';
import type { ResourceTransferReceipt } from './resource-actions/index.js';

export const WIDTH = 52;
export const HEIGHT = 34;
export const AGENT_COUNT = 14;
export const CARGO_LIMIT = 3;
export const HEARTH_COST: Readonly<Record<Material, number>> = { wood: 4, stone: 8 };

/** Illustrative tuning in prototype units; proficiency does not change action rates yet. */
export const GATHERING_SKILL: SkillConfig = Object.freeze({
  skillId: 'gathering',
  failureExperience: 1,
  successExperience: 2,
  halfProficiencyExperience: 100,
  attemptMilestones: Object.freeze([10, 50, 100]),
});

export interface WorldOptions {
  readonly resourceMode?: ResourceMode;
  readonly kgPerUnit?: Readonly<Inventory>;
  readonly initialTemperatureC?: Readonly<Inventory>;
  readonly agentMode?: AgentMode;
  readonly perceptionRange?: number;
  readonly memoryCapacity?: number;
  readonly eventCapacity?: number;
  readonly gatheringMilestones?: readonly number[];
}

export function indexOf(world: World, x: number, y: number): number {
  return y * world.width + x;
}

export function passable(world: World, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < world.width && y < world.height &&
    world.terrain[indexOf(world, x, y)] !== 'water';
}

export function createWorld(seed = 12345, options: WorldOptions = {}): World {
  const gatheringSkillConfig: SkillConfig = Object.freeze({
    ...GATHERING_SKILL,
    attemptMilestones: Object.freeze([...(options.gatheringMilestones ?? GATHERING_SKILL.attemptMilestones)]),
  });
  // Validate once before generating terrain; each agent gets its own record below.
  createSkillRecord(gatheringSkillConfig);
  const agentMode = options.agentMode ?? 'legacy';
  const perceptionRange = options.perceptionRange ?? DEFAULT_PERCEPTION_RANGE;
  const memoryCapacity = options.memoryCapacity ?? DEFAULT_MEMORY_CAPACITY;
  if (agentMode !== 'legacy' && agentMode !== 'knowledge') throw new RangeError('Unknown agent mode');
  if (!Number.isSafeInteger(perceptionRange) || perceptionRange < 0 ||
      !Number.isSafeInteger(memoryCapacity) || memoryCapacity < 1) throw new RangeError('Invalid knowledge configuration');
  const resourceMode = options.resourceMode ?? 'legacy';
  if (resourceMode !== 'legacy' && resourceMode !== 'physical') throw new RangeError('Unknown resource mode');
  const config = resourceMode === 'physical' ? physicalConfig(options.kgPerUnit, options.initialTemperatureC) : null;
  const width = WIDTH;
  const height = HEIGHT;
  const hub = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const world: World = {
    agentMode, perceptionRange, memoryCapacity,
    resourceMode, physicalConfig: config, physicalInventory: null,
    seed,
    randomState: initialRandomState(seed),
    tick: 0,
    nextEntityId: 1,
    width,
    height,
    terrain: [],
    hub: { ...hub, id: 0 },
    history: new EventLedger(options.eventCapacity),
    gatheringSkillConfig,
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
      memory: new AgentMemory(world.nextEntityId - 1, memoryCapacity),
      kind: 'agent',
      faction: 'settler',
      x: hub.x + (i % 5) - 2,
      y: hub.y + Math.floor(i / 5) - 1,
      energy: 65 + Math.floor(random(world) * 35),
      resting: false,
      cargo: { wood: 0, stone: 0 },
      skills: { gathering: createSkillRecord(gatheringSkillConfig) },
    };
    world.agents.push(agent);
  }
  // Allocate after agents so their existing IDs/parity (and decisions) stay unchanged.
  world.hub.id = world.nextEntityId++;
  if (resourceMode === 'physical') initializePhysicalWorld(world);
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

/** All modes share the same authoritative state changes and event publication. */
function restIfNeeded(agent: Agent): boolean {
  if (agent.energy <= 12) agent.resting = true;
  if (agent.resting) {
    agent.energy = Math.min(100, agent.energy + 5);
    if (agent.energy >= 70) agent.resting = false;
    return true;
  }
  return false;
}

function deliverCargo(world: World, agent: Agent): void {
  if (agent.x !== world.hub.x || agent.y !== world.hub.y || cargoCount(agent) <= 0) return;
    const delivered = { ...agent.cargo };
    let receipt: ResourceTransferReceipt | undefined;
    if (world.resourceMode === 'physical') {
      if (!world.agents.includes(agent) || !validPhysicalPosition(world, agent)) return;
      receipt = movePhysical(world, resourceOwnerId('agent', agent.id), resourceOwnerId('hub', world.hub.id), delivered);
      if (!receipt) return;
    } else {
      world.inventory.wood += delivered.wood;
      world.inventory.stone += delivered.stone;
      agent.cargo = { wood: 0, stone: 0 };
    }
    world.history.append({
      tick: world.tick, kind: 'stockpile.delivered', actorId: agent.id, targetId: world.hub.id,
      details: { wood: delivered.wood, stone: delivered.stone, unit: 'prototype-unit', ...physicalDetails(receipt) },
    });
    return;
}

function validPhysicalPosition(world: World, position: Position): boolean {
  return Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y) && passable(world, position.x, position.y);
}

function harvest(world: World, agent: Agent, deposit: Deposit): void {
  if (deposit.x !== agent.x || deposit.y !== agent.y || deposit.amount < 1 ||
      cargoCount(agent) >= CARGO_LIMIT) return;
  const material = deposit.material;
    let receipt: ResourceTransferReceipt | undefined;
    if (world.resourceMode === 'physical') {
      if (!world.agents.includes(agent) || !world.deposits.includes(deposit) ||
          !validPhysicalPosition(world, agent) || cargoCount(agent) + 1 > CARGO_LIMIT) return;
      receipt = movePhysical(world, resourceOwnerId('deposit', deposit.id), resourceOwnerId('agent', agent.id),
        { wood: material === 'wood' ? 1 : 0, stone: material === 'stone' ? 1 : 0 });
      if (!receipt) return;
    } else {
      deposit.amount -= 1;
      agent.cargo[material] += 1;
    }
    agent.energy = Math.max(0, agent.energy - 1);
    if (material === 'wood') world.stats.woodHarvested++;
    else world.stats.stoneHarvested++;
    world.history.append({
      tick: world.tick, kind: 'resource.harvested', actorId: agent.id, targetId: deposit.id,
      details: { material, amount: 1, remaining: deposit.amount, unit: 'prototype-unit', ...physicalDetails(receipt) },
    });
    if (deposit.amount === 0) {
      world.history.append({
        tick: world.tick, kind: 'resource.depleted', actorId: agent.id, targetId: deposit.id,
        details: { material, remaining: 0, unit: 'prototype-unit', ...physicalDetails(receipt) },
      });
    }
    const config = world.gatheringSkillConfig;
    const update = applyPracticeOutcome(agent.skills.gathering, {
      skillId: config.skillId, success: true,
    }, config);
    agent.skills.gathering = update.record;
    for (const attempts of update.reachedMilestones) {
      world.history.append({
        tick: world.tick, kind: 'skill.milestone', actorId: agent.id,
        details: { skillId: config.skillId, attempts, proficiency: update.record.proficiency },
      });
    }
    return;
}

/** Resolve only the requested local action; never substitute a hidden goal. */
export function executeAgentAction(world: World, agent: Agent, action: AgentAction): void {
  if (world.resourceMode === 'physical' && (!world.agents.includes(agent) || !validPhysicalPosition(world, agent))) return;
  if (restIfNeeded(agent)) return;
  switch (action.kind) {
    case 'move': {
      const { x, y } = action.to;
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
          Math.abs(x-agent.x) + Math.abs(y-agent.y) !== 1 || !passable(world,x,y)) return;
      agent.x = x;
      agent.y = y;
      agent.energy = Math.max(0, agent.energy - 1);
      return;
    }
    case 'harvest': {
      const deposit = world.deposits.find(d => d.id === action.targetId);
      if (deposit) harvest(world, agent, deposit);
      return;
    }
    case 'deliver':
      if (action.targetId === world.hub.id) deliverCargo(world, agent);
      return;
    case 'rest':
    case 'idle': return;
  }
}

/** Take every observation before any action; contested requests resolve by ID. */
function knowledgeTick(world: World): void {
  const agents = [...world.agents].sort((a,b) => a.id-b.id);
  for (const agent of agents) {
    const observation = observeAgent(world, agent.id, { range: world.perceptionRange });
    const memory = agent.memory.update(observation);
    agent.observation = observation;
    agent.decision = decideAgent(observation, memory,
      Object.freeze({ energy: agent.energy, resting: agent.resting, cargo: Object.freeze({ ...agent.cargo }) }),
      Object.freeze({ width: world.width, height: world.height, cargoLimit: CARGO_LIMIT }));
  }
  for (const agent of agents) if (agent.decision) executeAgentAction(world, agent, agent.decision.action);
}

function act(world: World, agent: Agent): void {
  if (world.resourceMode === 'physical' && !validPhysicalPosition(world, agent)) return;
  if (restIfNeeded(agent)) return;

  const carrying = cargoCount(agent);
  const atHub = agent.x === world.hub.x && agent.y === world.hub.y;
  if (atHub && carrying > 0) { deliverCargo(world, agent); return; }
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
  if (deposit.x === agent.x && deposit.y === agent.y) { harvest(world, agent, deposit); return; }
  goTo(world, agent, deposit);
}

function processHearth(world: World, hearth: Hearth): void {
  // Until balanced combustion exists, physical fuel and temperatures remain intact.
  if (world.resourceMode === 'physical') return;
  // 1 fuel unit burns per 30 ticks; heat rises on combustion and cools every tick.
  if (world.tick % 30 === 0 && hearth.fuel > 0) {
    hearth.fuel--;
    hearth.heat += 25;
    world.history.append({
      tick: world.tick, kind: 'hearth.fuel_consumed', targetId: hearth.id,
      details: { material: 'wood', amount: 1, fuelRemaining: hearth.fuel, unit: 'prototype-unit' },
    });
  }
  hearth.heat = Math.max(0, hearth.heat - 0.6);
  // An agent can replenish the hearth from the shared inventory.
  if (hearth.fuel < 2 && world.inventory.wood >= 2) {
    world.inventory.wood -= 2;
    hearth.fuel += 2;
    world.history.append({
      tick: world.tick, kind: 'hearth.refueled', targetId: hearth.id,
      details: { stockpileId: world.hub.id, material: 'wood', amount: 2, fuelRemaining: hearth.fuel, unit: 'prototype-unit' },
    });
  }
}

/** Fixed-step, deterministic simulation. No Date.now/Math.random/DOM access. */
export function stepWorld(world: World): void {
  world.tick++;
  if (world.agentMode === 'knowledge') knowledgeTick(world);
  else for (const agent of world.resourceMode === 'physical' ?
    [...world.agents].sort((a,b) => a.id-b.id) : world.agents) act(world, agent);

  if (world.structures.length === 0 &&
      world.inventory.wood >= HEARTH_COST.wood &&
      world.inventory.stone >= HEARTH_COST.stone) {
    const hearth: Hearth = {
      id: world.nextEntityId, kind: 'structure', structure: 'hearth',
      x: world.hub.x + 2, y: world.hub.y,
      stoneUsed: HEARTH_COST.stone,
      fuel: HEARTH_COST.wood,
      heat: 0,
    };
    let receipt: ResourceTransferReceipt | undefined;
    if (world.resourceMode === 'physical') {
      if (validPhysicalPosition(world, hearth) && validPhysicalPosition(world, world.hub) &&
          Number.isSafeInteger(hearth.id + 1) && hearth.id > 0 &&
          !world.deposits.some(d => d.x === hearth.x && d.y === hearth.y)) {
        receipt = movePhysical(world, resourceOwnerId('hub', world.hub.id),
          resourceOwnerId('structure', hearth.id), HEARTH_COST, true);
        if (receipt) bindHearth(world, hearth);
      }
    } else {
      world.inventory.wood -= HEARTH_COST.wood;
      world.inventory.stone -= HEARTH_COST.stone;
    }
    if (world.resourceMode === 'legacy' || receipt) {
      world.nextEntityId++;
      world.structures.push(hearth);
      world.stats.hearthsBuilt++;
      world.history.append({
        tick: world.tick, kind: 'structure.built', targetId: hearth.id,
        details: { structure: hearth.structure, stockpileId: world.hub.id,
          wood: HEARTH_COST.wood, stone: HEARTH_COST.stone, unit: 'prototype-unit', ...physicalDetails(receipt) },
      });
    }
  }
  for (const hearth of world.structures) processHearth(world, hearth);
  // Remove depleted deposits to avoid accumulating inactive objects.
  world.deposits = world.deposits.filter((deposit) => deposit.amount > 0);
}

export function snapshot(world: World): string {
  // For reproducibility and deterministic regression tests.
  return JSON.stringify({ ...world, physicalInventory: world.physicalInventory?.snapshot() ?? null });
}
