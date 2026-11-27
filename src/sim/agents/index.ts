import type { Inventory, Material, Position, Terrain } from '../model.js';
import type { MemorySnapshot } from '../memory/index.js';
import type { Observation, ObservedDeposit, ObservedHub } from '../perception/index.js';

export type AgentAction =
  | { readonly kind: 'rest' | 'idle' }
  | { readonly kind: 'harvest' | 'deliver'; readonly targetId: number }
  | { readonly kind: 'move'; readonly to: Readonly<Position> };

export interface Decision {
  readonly intention: string;
  readonly action: AgentAction;
}
export interface AgentInternal {
  readonly energy: number;
  readonly resting: boolean;
  readonly cargo: Readonly<Inventory>;
}
/** Public scenario geometry, not a terrain map or hub coordinates. */
export interface PolicyConfig {
  readonly width: number;
  readonly height: number;
  readonly cargoLimit: number;
}
export type AgentMode = 'legacy' | 'knowledge';
const key = (p: Readonly<Position>): string => p.x + ':' + p.y;
const neighbors = (p: Readonly<Position>): Position[] => [
  { x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 },
  { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 },
];
interface Route {
  readonly position: Readonly<Position>;
  readonly first: Readonly<Position> | null;
  readonly distance: number;
}

/** One BFS over known passable terrain. Missing tiles are not traversable. */
function routes(origin: Readonly<Position>, terrain: ReadonlyMap<string, Terrain>): Map<string, Route> {
  const start: Route = { position: origin, first: null, distance: 0 };
  const queue = [start];
  const found = new Map([[key(origin), start]]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const next of neighbors(current.position)) {
      const k = key(next);
      const tile = terrain.get(k);
      if (!tile || tile === 'water' || found.has(k)) continue;
      const route = { position: next, first: current.first ?? next, distance: current.distance + 1 };
      found.set(k, route);
      queue.push(route);
    }
  }
  return found;
}
function decision(intention: string, action: AgentAction): Decision {
  return Object.freeze({ intention, action: Object.freeze(action) });
}
function move(intention: string, to: Readonly<Position>): Decision {
  return decision(intention, { kind: 'move', to: Object.freeze({ x: to.x, y: to.y }) });
}

/** Pure, faction-neutral policy. No World, RNG, global history or stockpile access. */
export function decideAgent(observation: Observation, memory: MemorySnapshot,
  own: AgentInternal, config: PolicyConfig): Decision {
  if (memory.observerId !== observation.observer.id || memory.lastObservationTick !== observation.tick) {
    throw new RangeError('Policy requires matching current individual memory');
  }
  if (own.energy <= 12 || own.resting) return decision('Rest', { kind: 'rest' });
  const terrain = new Map<string, Terrain>();
  const deposits = new Map<number, ObservedDeposit>();
  const hubs = new Map<number, ObservedHub>();
  const visible = new Set(observation.terrain.map(key));
  for (const entry of memory.entries) {
    if (entry.status === 'absent') continue;
    const v = entry.value;
    if (v.kind === 'terrain') terrain.set(key(v), v.terrain);
    // Current projection wins, including absence from visible tiles.
    else if (!visible.has(key(v))) {
      if (v.kind === 'deposit' && v.amount > 0) deposits.set(v.id, v);
      if (v.kind === 'hub') hubs.set(v.id, v);
    }
  }
  for (const tile of observation.terrain) terrain.set(key(tile), tile.terrain);
  for (const d of observation.deposits) if (d.amount > 0) deposits.set(d.id, d);
  if (observation.hub) hubs.set(observation.hub.id, observation.hub);
  const reachable = routes(observation.observer, terrain);
  const carrying = own.cargo.wood + own.cargo.stone;
  const preferred: Material = own.cargo.wood > 0 ? 'wood' : own.cargo.stone > 0 ? 'stone'
    : observation.observer.id % 2 === 0 ? 'wood' : 'stone';
  const hub = [...hubs.values()].filter(h => reachable.has(key(h)))
    .sort((a,b) => reachable.get(key(a))!.distance - reachable.get(key(b))!.distance || a.id-b.id)[0];
  const deliver = (): Decision | null => {
    if (!hub) return null;
    const first = reachable.get(key(hub))!.first;
    return first ? move('Return to hub #' + hub.id, first)
      : decision('Deliver to hub #' + hub.id, { kind: 'deliver', targetId: hub.id });
  };
  if (carrying > 0 && hub && key(hub) === key(observation.observer)) return deliver()!;
  if (carrying >= config.cargoLimit) {
    const result = deliver();
    if (result) return result;
  } else {
    const candidates = [...deposits.values()].filter(d => reachable.has(key(d)) &&
      (carrying === 0 || d.material === preferred));
    candidates.sort((a,b) => Number(b.material === preferred) - Number(a.material === preferred) ||
      reachable.get(key(a))!.distance - reachable.get(key(b))!.distance || a.id-b.id);
    const target = candidates[0];
    if (target) {
      const first = reachable.get(key(target))!.first;
      const intention = 'Gather ' + target.material + ' #' + target.id;
      return first ? move(intention, first) : decision(intention, { kind: 'harvest', targetId: target.id });
    }
    if (carrying > 0) {
      const result = deliver();
      if (result) return result;
    }
  }
  // Explore only reachable known frontier tiles. In constrained memories, a
  // forgotten tile is not necessarily a new place. Recent actual visits are
  // attached to retained terrain; penalize them only during exploration.
  const frontiers = [...reachable.values()].filter(route => route.first &&
    neighbors(route.position).some(p => p.x >= 0 && p.y >= 0 &&
      p.x < config.width && p.y < config.height && !terrain.has(key(p))));
  if (memory.retention === 'navigation') {
    const visits = new Map(memory.entries.filter(e => e.lastVisitedTick !== undefined)
      .map(e => [key(e.value), e.lastVisitedTick!]));
    const penalty = (p: Readonly<Position>): number =>
      Math.max(0, 13 - (observation.tick - (visits.get(key(p)) ?? -13)));
    const home = carrying > 0 ? [...hubs.values()].sort((a,b) => a.id-b.id)[0] : undefined;
    const homeDistance = (p: Readonly<Position>): number => home
      ? Math.abs(p.x-home.x)+Math.abs(p.y-home.y) : 0;
    // Prefer a less recently visited first step; when disconnected and carrying
    // cargo, rank frontiers toward the remembered hub, not arbitrary frontiers.
    // No visit penalty for normal gathering/return routes above.
    frontiers.sort((a,b) => penalty(a.first!) - penalty(b.first!) ||
      homeDistance(a.position) - homeDistance(b.position) ||
      penalty(a.position) - penalty(b.position) || a.distance - b.distance);
  }
  const frontier = frontiers[0];
  if (frontier?.first) {
    return move(carrying ? 'Explore for hub or resources' : 'Explore unknown terrain', frontier.first);
  }
  return decision('No reachable known goal or frontier', { kind: 'idle' });
}
