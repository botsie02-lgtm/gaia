/** External observer of resolved prototype-world ticks. Never imported by policies. */
import type { AgentMode } from '../agents/index.js';
import { DEFAULT_MEMORY_CAPACITY } from '../memory/index.js';
import { DEFAULT_PERCEPTION_RANGE } from '../perception/index.js';
import type { WorldOptions } from '../world.js';
import { createPhysicalAudit } from './physical-audit.js';
import { AGENT_COUNT, CARGO_LIMIT, createWorld, stepWorld, snapshot } from '../world.js';

export interface DiagnosticConfig extends Pick<WorldOptions, 'resourceMode' | 'thermal' | 'kgPerUnit' | 'initialTemperatureC'> {
  readonly seed: number;
  readonly ticks: number;
  readonly agentMode?: AgentMode;
  readonly agentCount?: number;
  readonly perceptionRange?: number;
  readonly memoryCapacity?: number;
  readonly eventCapacity?: number;
}
function integer(value: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError('Invalid ' + name);
  return value === 0 ? 0 : value;
}
const units = () => ({ wood: 0, stone: 0 });
const decisions = () => ({ move: 0, harvest: 0, deliver: 0, rest: 0, idle: 0 });
const outcomes = () => ({ move: 0, harvest: 0, deliver: 0, rest: 0, idle: 0 });
function tracker(id: number, tile: number) {
  return {
    id, visited: new Set([tile]), observed: new Set<number>(),
    lastTile: tile, previousMoveOrigin: -1, stationaryRun: 0,
    maxStationaryRun: 0, idleRun: 0, maxIdleRun: 0,
    revisits: 0, backtracks: 0, distance: 0,
    harvested: units(), delivered: units(), outcomes: outcomes(), intentions: decisions(),
    rejected: { move: 0, harvest: 0, deliver: 0 },
    explorationMoves: 0, memorySum: 0, memoryPeak: 0,
    observedDepositTicks: 0, hubVisibleTicks: 0, fullTicks: 0, fullRun: 0, maxFullRun: 0,
  };
}
export function runDiagnosticSession(input: DiagnosticConfig) {
  const config = {
    resourceMode: input.resourceMode === undefined ? 'legacy' : input.resourceMode,
    thermal: input.thermal === undefined ? false : input.thermal,
    ...(input.kgPerUnit === undefined ? {} : { kgPerUnit: { ...input.kgPerUnit } }),
    ...(input.initialTemperatureC === undefined ? {} : { initialTemperatureC: { ...input.initialTemperatureC } }),
    seed: integer(input.seed, 'seed', Number.MIN_SAFE_INTEGER),
    ticks: integer(input.ticks, 'ticks', 0, Math.floor(Number.MAX_SAFE_INTEGER / (2 * AGENT_COUNT))),
    agentMode: input.agentMode === undefined ? 'legacy' : input.agentMode,
    agentCount: integer(input.agentCount === undefined ? AGENT_COUNT : input.agentCount, 'agentCount', 1, AGENT_COUNT),
    perceptionRange: integer(input.perceptionRange === undefined ? DEFAULT_PERCEPTION_RANGE : input.perceptionRange, 'perceptionRange', 0),
    memoryCapacity: integer(input.memoryCapacity === undefined ? DEFAULT_MEMORY_CAPACITY : input.memoryCapacity, 'memoryCapacity', 1),
    eventCapacity: integer(input.eventCapacity === undefined ? 1 : input.eventCapacity, 'eventCapacity', 1),
  } as const;
  if (config.agentMode !== 'legacy' && config.agentMode !== 'knowledge') throw new RangeError('Invalid agentMode');
  if (config.resourceMode !== 'legacy' && config.resourceMode !== 'physical') throw new RangeError('Invalid resourceMode');
  if (typeof config.thermal !== 'boolean' && (!config.thermal || typeof config.thermal !== 'object' || Array.isArray(config.thermal))) throw new RangeError('Invalid thermal option');
  const world = createWorld(config.seed, config);
  // Scenario setup only: retain a stable prefix of the generated population.
  // Terrain, deposits, IDs, RNG and retained agents are otherwise unchanged.
  if (world.agents.slice(config.agentCount).some(a => a.cargo.wood !== 0 || a.cargo.stone !== 0)) throw new Error('Cannot remove loaded agents');
  world.agents = world.agents.slice(0, config.agentCount);
  const audit = world.physicalInventory ? createPhysicalAudit(world) : null;
  const initialDepositCount = world.deposits.length;
  let lastHarvestTick: number | null = null, lastDeliveryTick: number | null = null;
  let maxNoDeliveryRun = 0, noDeliveryRun = 0;
  const tile = (p: { x: number; y: number }) => p.y * world.width + p.x;
  const trackers = world.agents.map(a => tracker(a.id, tile(a)));
  const visited = new Set(trackers.map(t => t.lastTile));
  const observed = new Set<number>();
  const harvested = units(), delivered = units();
  let firstConstructionTick: number | null = null;
  let constructionCount = 0;
  for (let i = 0; i < config.ticks; i++) {
    const before = world.agents.map(a => ({
      x: a.x, y: a.y, wood: a.cargo.wood, stone: a.cargo.stone,
      resting: a.resting || a.energy <= 12,
    }));
    stepWorld(world);
    audit?.sample(world);
    let deliveredThisTick = false;
    if (world.stats.hearthsBuilt > constructionCount) {
      firstConstructionTick ??= world.tick;
      constructionCount = world.stats.hearthsBuilt;
    }
    for (const [j, a] of world.agents.entries()) {
      const t = trackers[j]!, b = before[j]!;
      if (a.id !== t.id) throw new Error('Diagnostics requires stable agent order and population');
      const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      const wood = a.cargo.wood - b.wood, stone = a.cargo.stone - b.stone;
      let outcome: keyof ReturnType<typeof outcomes>;
      if (distance > 0) {
        outcome = 'move';
        const next = tile(a);
        t.distance += distance;
        if (t.visited.has(next)) t.revisits++;
        if (next === t.previousMoveOrigin) t.backtracks++;
        t.previousMoveOrigin = t.lastTile;
        t.lastTile = next;
        t.visited.add(next); visited.add(next);
      } else if (wood > 0 || stone > 0) {
        outcome = 'harvest';
        lastHarvestTick = world.tick;
        t.harvested.wood += wood; harvested.wood += wood;
        t.harvested.stone += stone; harvested.stone += stone;
      } else if (wood < 0 || stone < 0) {
        outcome = 'deliver';
        lastDeliveryTick = world.tick; deliveredThisTick = true;
        t.delivered.wood -= wood; delivered.wood -= wood;
        t.delivered.stone -= stone; delivered.stone -= stone;
      } else outcome = b.resting ? 'rest' : 'idle';
      t.outcomes[outcome]++;
      const full = a.cargo.wood + a.cargo.stone === CARGO_LIMIT;
      if (full) t.fullTicks++;
      t.fullRun = full ? t.fullRun + 1 : 0;
      t.maxFullRun = Math.max(t.maxFullRun, t.fullRun);
      t.stationaryRun = distance === 0 ? t.stationaryRun + 1 : 0;
      t.maxStationaryRun = Math.max(t.maxStationaryRun, t.stationaryRun);
      t.idleRun = outcome === 'idle' ? t.idleRun + 1 : 0;
      t.maxIdleRun = Math.max(t.maxIdleRun, t.idleRun);
      if (a.decision) {
        const kind = a.decision.action.kind;
        t.intentions[kind]++;
        if ((kind === 'move' || kind === 'harvest' || kind === 'deliver') && kind !== outcome) t.rejected[kind]++;
        if (outcome === 'move' && a.decision.intention.startsWith('Explore')) t.explorationMoves++;
      }
      // Recorded pre-action observation only: never resample or update memory.
      if (a.observation?.tick === world.tick) {
        for (const p of a.observation.terrain) {
          const k = tile(p); t.observed.add(k); observed.add(k);
        }
        t.observedDepositTicks += a.observation.deposits.length;
        if (a.observation.hub) t.hubVisibleTicks++;
      }
      t.memorySum += a.memory.size;
      t.memoryPeak = Math.max(t.memoryPeak, a.memory.size);
    }
    noDeliveryRun = deliveredThisTick ? 0 : noDeliveryRun + 1;
    maxNoDeliveryRun = Math.max(maxNoDeliveryRun, noDeliveryRun);
  }
  if (harvested.wood !== world.stats.woodHarvested || harvested.stone !== world.stats.stoneHarvested) {
    throw new Error('Cargo transitions no longer match world harvest accounting');
  }
  const agents = world.agents.map((a, i) => {
    const t = trackers[i]!;
    const retained = { current: 0, stale: 0, absent: 0 };
    const retainedDeposits = { current: 0, stale: 0, absent: 0 };
    for (const e of a.memory.snapshot().entries) {
      retained[e.status]++;
      if (e.value.kind === 'deposit') retainedDeposits[e.status]++;
    }
    return {
      id: a.id, fullCargo: { ticks: t.fullTicks, maxRun: t.maxFullRun, final: t.fullRun > 0 }, harvested: t.harvested, delivered: t.delivered, cargo: { ...a.cargo },
      skill: { ...a.skills.gathering }, outcomes: t.outcomes,
      intentions: config.agentMode === 'knowledge' ? t.intentions : null,
      rejected: config.agentMode === 'knowledge' ? t.rejected : null,
      movement: { distance: t.distance, revisits: t.revisits, backtracks: t.backtracks,
        maxStationaryRun: t.maxStationaryRun, maxIdleRun: t.maxIdleRun,
        explorationMoves: config.agentMode === 'knowledge' ? t.explorationMoves : null },
      coverage: { visitedTiles: t.visited.size, observedTiles: config.agentMode === 'knowledge' ? t.observed.size : null },
      evidence: config.agentMode === 'knowledge' ? { observedDepositTicks: t.observedDepositTicks, hubVisibleTicks: t.hubVisibleTicks } : null,
      memory: { final: a.memory.size, peak: t.memoryPeak, mean: config.ticks ? t.memorySum / config.ticks : 0,
        capacity: a.memory.capacity, retained, retainedDeposits },
    };
  });
  const total = (fn: (a: typeof agents[number]) => number) => agents.reduce((n, a) => n + fn(a), 0);
  const gridTiles = world.width * world.height;
  const remaining = units();
  for (const d of world.deposits) remaining[d.material] += d.amount;
  const report = {
    version: 1 as const, config, gridTiles, harvested, delivered, firstConstructionTick, constructionCount,
    physical: audit?.report() ?? null,
    resources: { initialDepositCount, remainingDepositCount: world.deposits.length, remaining, lastHarvestTick, lastDeliveryTick, maxNoDeliveryRun },
    fullCargo: { ticks: total(a => a.fullCargo.ticks), maxRun: Math.max(...agents.map(a => a.fullCargo.maxRun)), finalAgents: total(a => Number(a.fullCargo.final)) },
    gatheringExperience: total(a => a.skill.experience),
    gatheringSuccesses: total(a => a.skill.successes),
    coverage: { visitedTiles: visited.size, observedTiles: config.agentMode === 'knowledge' ? observed.size : null },
    movement: { distance: total(a => a.movement.distance), revisits: total(a => a.movement.revisits),
      backtracks: total(a => a.movement.backtracks) },
    outcomes: { move: total(a => a.outcomes.move), harvest: total(a => a.outcomes.harvest),
      deliver: total(a => a.outcomes.deliver), rest: total(a => a.outcomes.rest), idle: total(a => a.outcomes.idle) },
    memory: { final: total(a => a.memory.final), peakPerAgent: Math.max(...agents.map(a => a.memory.peak)),
      meanPerAgent: total(a => a.memory.mean) / agents.length },
    agents,
  };
  return { report, finalSnapshot: snapshot(world) };
}
export function runDiagnostics(input: DiagnosticConfig) { return runDiagnosticSession(input).report; }
export type DiagnosticReport = ReturnType<typeof runDiagnostics>;

/** Same generated initial world for each configuration, with no shared mutable state. */
export function comparePolicies(config: Omit<DiagnosticConfig, 'agentMode'>) {
  return { legacy: runDiagnostics({ ...config, agentMode: 'legacy' }),
    knowledge: runDiagnostics({ ...config, agentMode: 'knowledge' }) };
}

/** Fixed representative matrix; each seed includes the same policy/config variants. */
export function baselineScenarios(): DiagnosticConfig[] {
  return [42, 12345, 2026].flatMap(seed => [
    { seed, ticks: 200, agentMode: 'legacy' as const },
    ...[[0, 512], [2, 32], [2, 512], [6, 32], [6, 512]].map(([range, capacity]) =>
      ({ seed, ticks: 200, agentMode: 'knowledge' as const, perceptionRange: range!, memoryCapacity: capacity! })),
  ]);
}
