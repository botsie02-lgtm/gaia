import type {
  Observation, ObservedAgent, ObservedDeposit, ObservedHub, ObservedStructure, ObservedTile,
} from '../perception/index.js';

export type MemoryValue = ObservedAgent | ObservedDeposit | ObservedHub |
  ObservedStructure | Readonly<ObservedTile & { kind: 'terrain' }>;
export type MemoryStatus = 'current' | 'stale' | 'absent';

export interface MemoryEntry<T extends MemoryValue = MemoryValue> {
  readonly value: T;
  readonly status: MemoryStatus;
  /** Last positive sighting, even when the former position is now empty. */
  readonly lastObservedTick: number;
  /** Latest positive sighting or visible absence at the last known position. */
  readonly lastCheckedTick: number;
  /** Own observed visit; attached to a retained terrain entry, not a second map. */
  readonly lastVisitedTick?: number;
  /** First locally observed own position; counted as an ordinary terrain entry. */
  readonly searchOrigin?: true;
}

export interface MemorySnapshot {
  readonly version: 1;
  readonly retention?: 'navigation';
  readonly observerId: number;
  readonly capacity: number;
  readonly lastObservationTick: number | null;
  readonly entries: readonly MemoryEntry[];
  /** Bounded approximate regional observation pressure, not a terrain map. */
  readonly searchPressure?: readonly number[];
}

export interface MemoryQuery {
  readonly kind?: MemoryValue['kind'];
  readonly entityId?: number;
  readonly material?: ObservedDeposit['material'];
  readonly x?: number;
  readonly y?: number;
  readonly status?: MemoryStatus;
}

export const DEFAULT_MEMORY_CAPACITY = 512;
export type MemoryRetention = 'recency' | 'navigation';
/** Conservative rollout: preserve the established larger-memory policy. */
export const NAVIGATION_MEMORY_MAX_CAPACITY = 64;

function integer(value: unknown, name: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new RangeError(name + ' must be a safe integer >= ' + min);
  }
  return value === 0 ? 0 : value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a record');
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Expected an array');
  return value;
}

function position(value: Record<string, unknown>): { x: number; y: number } {
  return { x: integer(value.x, 'x'), y: integer(value.y, 'y') };
}

function copyValue(input: unknown, kind: unknown): MemoryValue {
  const value = record(input);
  const p = position(value);
  if (kind === 'terrain') {
    if (value.terrain !== 'grass' && value.terrain !== 'dirt' && value.terrain !== 'water') {
      throw new RangeError('Unknown terrain');
    }
    return Object.freeze({ kind, ...p, terrain: value.terrain });
  }
  if (value.kind !== kind) throw new TypeError('Mismatched entity kind');
  const id = integer(value.id, 'entity ID', 1);
  switch (kind) {
    case 'agent':
      if (value.faction !== 'settler' && value.faction !== 'neutral' && value.faction !== 'hostile') {
        throw new RangeError('Unknown faction');
      }
      return Object.freeze({ kind, id, ...p, faction: value.faction });
    case 'deposit':
      if (value.material !== 'wood' && value.material !== 'stone') {
        throw new RangeError('Unknown material');
      }
      if (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount < 0) {
        throw new RangeError('Invalid observed quantity');
      }
      return Object.freeze({ kind, id, ...p, material: value.material,
        amount: value.amount === 0 ? 0 : value.amount });
    case 'structure':
      if (value.structure !== 'hearth') throw new RangeError('Unknown structure');
      return Object.freeze({ kind, id, ...p, structure: value.structure });
    case 'hub':
      return Object.freeze({ kind, id, ...p });
    default:
      throw new TypeError('Unknown memory kind');
  }
}

function tileKey(p: { readonly x: number; readonly y: number }): string {
  return p.x + ':' + p.y;
}

function key(value: MemoryValue): string {
  return value.kind === 'terrain' ? 'tile:' + tileKey(value) : 'entity:' + value.id;
}

function entry(value: MemoryValue, status: MemoryStatus, lastObservedTick: number,
  lastCheckedTick: number, lastVisitedTick?: number, searchOrigin?: true): MemoryEntry {
  return Object.freeze({ value, status, lastObservedTick, lastCheckedTick,
    ...(lastVisitedTick === undefined ? {} : { lastVisitedTick }),
    ...(searchOrigin === true ? { searchOrigin } : {}) });
}

/** Newest evidence first; ties favor entities, then numeric ID or row-major tile. */
function compare(a: MemoryEntry, b: MemoryEntry): number {
  const recency = b.lastCheckedTick - a.lastCheckedTick;
  if (recency) return recency;
  const av = a.value;
  const bv = b.value;
  if (av.kind === 'terrain') {
    return bv.kind === 'terrain' ? av.y - bv.y || av.x - bv.x : 1;
  }
  return bv.kind === 'terrain' ? -1 : av.id - bv.id;
}

const manhattan = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Coarse four-tile regions share fixed buckets; collisions only affect search ranking. */
export function searchBucket(p: { readonly x: number; readonly y: number }, length: number): number {
  const x = Math.floor(p.x / 4), y = Math.floor(p.y / 4);
  return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % length;
}
function searchEnabled(observation: Observation, capacity: number): boolean {
  return capacity >= 16 && observation.range > 0 && observation.range <= 2;
}
function updatePressure(previous: readonly number[] | undefined, observation: Observation,
  capacity: number, lastTick: number | null, entries: readonly MemoryEntry[]): readonly number[] {
  const length = Math.min(capacity, 64);
  const epochs = lastTick === null ? 0 : Math.min(8,
    Math.floor(observation.tick / 256) - Math.floor(lastTick / 256));
  const pressure = Array.from({ length }, (_, i) => (previous?.[i] ?? 0) >> epochs);
  const previousPosition = entries.find(e => e.value.kind === 'terrain' &&
    e.lastVisitedTick !== undefined && e.lastVisitedTick === lastTick);
  // Count actual observed positions, not repeated stationary ticks or requested moves.
  if (!previousPosition || tileKey(previousPosition.value) !== tileKey(observation.observer)) {
    const regions = new Set(observation.terrain.map(t => searchBucket(t, length)));
    for (const index of regions) pressure[index] = Math.min(255, pressure[index]! + 1);
    const own = searchBucket(observation.observer, length);
    pressure[own] = Math.min(255, pressure[own]! + 2);
  }
  return Object.freeze(pressure);
}

/** Select within the original entry budget. No coordinates beyond candidate evidence.
 * Keep the hub and a connected corridor from it toward the observer, then reserve
 * space for useful deposits, recent visits and local terrain. */
function retainNavigation(entries: MemoryEntry[], observation: Observation, capacity: number): MemoryEntry[] {
  const origin = observation.observer;
  const chosen = new Set<MemoryEntry>();
  const add = (e: MemoryEntry | undefined): void => {
    if (e && chosen.size < capacity) chosen.add(e);
  };
  const terrain = new Map(entries.filter(e => e.value.kind === 'terrain').map(e => [tileKey(e.value), e]));
  const recovery = searchEnabled(observation, capacity);
  // Local connectivity is based only on currently available terrain evidence.
  const local = new Set<string>();
  if (recovery) {
    const queue = [origin as { x: number; y: number }];
    local.add(tileKey(origin));
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i]!;
      for (const n of [{ x:p.x+1,y:p.y },{ x:p.x,y:p.y+1 },
        { x:p.x-1,y:p.y },{ x:p.x,y:p.y-1 }]) {
        const k = tileKey(n), v = terrain.get(k)?.value;
        if (local.has(k) || v?.kind !== 'terrain' || v.terrain === 'water') continue;
        local.add(k); queue.push(n);
      }
    }
  }
  const hub = entries.filter(e => e.value.kind === 'hub' && e.status !== 'absent')
    .sort(compare)[0];
  add(hub);
  add(terrain.get(tileKey(origin)));
  if (recovery && !hub) add(entries.find(e => e.searchOrigin === true));
  if (hub) {
    const start = tileKey(hub.value);
    const root = terrain.get(start);
    if (root?.value.kind === 'terrain' && root.value.terrain !== 'water') {
      const queue = [root];
      const parents = new Map<string, string | null>([[start, null]]);
      let nearest = root;
      for (let i = 0; i < queue.length; i++) {
        const e = queue[i]!, p = e.value;
        if (manhattan(p, origin) < manhattan(nearest.value, origin)) nearest = e;
        if (manhattan(p, origin) === 0) break;
        for (const n of [{ x: p.x+1, y:p.y }, { x:p.x,y:p.y+1 },
          { x:p.x-1,y:p.y }, { x:p.x,y:p.y-1 }]) {
          const k = tileKey(n), next = terrain.get(k);
          if (parents.has(k) || next?.value.kind !== 'terrain' || next.value.terrain === 'water') continue;
          parents.set(k, tileKey(p));
          queue.push(next);
        }
      }
      // If disconnected, preserve the hub-connected prefix closest to self.
      const corridor: MemoryEntry[] = [];
      for (let k: string | null = tileKey(nearest.value); k !== null; k = parents.get(k) ?? null) {
        corridor.push(terrain.get(k)!);
      }
      // A disconnected prefix cannot route the observer home. Retain a small
      // anchor instead of sacrificing most of the local search budget.
      const fraction = recovery && !local.has(start) ? 0.25 : 0.75;
      const budget = Math.max(0, Math.floor(capacity * fraction) - chosen.size);
      for (const e of corridor.reverse().slice(0, budget)) add(e);
    }
  }
  const near = (a: MemoryEntry, b: MemoryEntry): number =>
    manhattan(a.value, origin) - manhattan(b.value, origin) || compare(a,b);
  const deposits = entries.filter(e => e.value.kind === 'deposit' &&
    e.value.amount > 0 && e.status !== 'absent' && (!recovery || local.has(tileKey(e.value)))).sort(near);
  for (const e of deposits.slice(0, Math.max(1, Math.floor(capacity / 8)))) add(e);
  const visits = entries.filter(e => e.lastVisitedTick !== undefined)
    .sort((a,b) => b.lastVisitedTick! - a.lastVisitedTick! || compare(a,b));
  for (const e of visits.slice(0, Math.min(8, Math.floor(capacity / 4)))) add(e);
  for (const e of [...terrain.values()].sort(near)) add(e);
  for (const e of entries.sort(compare)) add(e);
  return [...chosen].sort(compare);
}

/** Validate the local projection and copy only explicitly observable fields. */
function sightings(observation: Observation, observerId: number): Map<string, MemoryValue> {
  const observer = copyValue(observation.observer, 'agent');
  if (observer.kind !== 'agent' || observer.id !== observerId) {
    throw new RangeError('Observation belongs to a different agent');
  }
  const range = integer(observation.range, 'range');
  const seen = new Map<string, MemoryValue>();
  const add = (value: MemoryValue): void => {
    const k = key(value);
    if (seen.has(k)) throw new RangeError('Duplicate observed tile or entity ID');
    seen.set(k, value);
  };
  for (const tile of array(observation.terrain)) {
    const value = copyValue(tile, 'terrain');
    if (Math.abs(value.x - observer.x) + Math.abs(value.y - observer.y) > range) {
      throw new RangeError('Tile outside observation range');
    }
    add(value);
  }
  if (!seen.has('tile:' + tileKey(observer))) throw new RangeError('Observer tile is not visible');
  const addEntity = (input: unknown, kind: string): void => {
    const value = copyValue(input, kind);
    if (value.kind === 'terrain' || value.id === observerId ||
        !seen.has('tile:' + tileKey(value))) {
      throw new RangeError('Entity is not a visible other object');
    }
    add(value);
  };
  for (const agent of array(observation.agents)) addEntity(agent, 'agent');
  for (const deposit of array(observation.deposits)) addEntity(deposit, 'deposit');
  for (const structure of array(observation.structures)) addEntity(structure, 'structure');
  if (observation.hub !== null) addEntity(observation.hub, 'hub');
  return seen;
}

function isStatus(value: unknown): value is MemoryStatus {
  return value === 'current' || value === 'stale' || value === 'absent';
}

function isKind(value: unknown): value is MemoryValue['kind'] {
  return value === 'terrain' || value === 'agent' || value === 'deposit' ||
    value === 'structure' || value === 'hub';
}

/** One instance per agent, scoped to one world. No World or ledger access. */
export class AgentMemory {
  readonly #observerId: number;
  readonly #capacity: number;
  readonly #retention: MemoryRetention;
  #lastObservationTick: number | null = null;
  #entries: readonly MemoryEntry[] = Object.freeze([]);
  #searchPressure: readonly number[] | undefined;

  constructor(observerId: number, capacity = DEFAULT_MEMORY_CAPACITY, retention: MemoryRetention = 'recency') {
    this.#observerId = integer(observerId, 'observer ID', 1);
    this.#capacity = integer(capacity, 'capacity', 1);
    if (retention !== 'recency' && retention !== 'navigation') throw new RangeError('Invalid retention');
    this.#retention = retention;
  }

  get observerId(): number { return this.#observerId; }
  get capacity(): number { return this.#capacity; }
  get size(): number { return this.#entries.length; }

  /** Apply one complete observation per strictly increasing logical tick.
   * Invalid input leaves the previous snapshot untouched. */
  update(observation: Observation): MemorySnapshot {
    const tick = integer(observation.tick, 'observation tick');
    if (this.#lastObservationTick !== null && tick <= this.#lastObservationTick) {
      throw new RangeError('Observation ticks must strictly increase');
    }
    const seen = sightings(observation, this.observerId);
    const next: MemoryEntry[] = [];
    const oldVisits = this.#retention === 'navigation'
      ? new Map(this.#entries.filter(e => e.lastVisitedTick !== undefined)
        .map(e => [key(e.value), e.lastVisitedTick])) : undefined;
    const recovery = this.#retention === 'navigation' && searchEnabled(observation, this.capacity);
    const originKey = this.#entries.find(e => e.searchOrigin === true);
    const anchor = recovery ? (originKey ? key(originKey.value) :
      this.#searchPressure === undefined ? 'tile:' + tileKey(observation.observer) : undefined) : undefined;
    for (const old of this.#entries) {
      const fresh = seen.get(key(old.value));
      if (fresh) {
        if (fresh.kind !== old.value.kind) throw new RangeError('Entity ID changed kind');
        continue; // Positive sightings (including movement) override old positions.
      }
      if (old.value.kind !== 'terrain' && seen.has('tile:' + tileKey(old.value))) {
        next.push(entry(old.value, 'absent', old.lastObservedTick, tick));
      } else if (old.status === 'current') {
        next.push(entry(old.value, 'stale', old.lastObservedTick, old.lastCheckedTick, old.lastVisitedTick, old.searchOrigin));
      } else {
        next.push(old);
      }
    }
    for (const value of seen.values()) {
      const visit = this.#retention === 'navigation' && value.kind === 'terrain'
        ? (tileKey(value) === tileKey(observation.observer) ? tick : oldVisits?.get(key(value))) : undefined;
      next.push(entry(value, 'current', tick, tick, visit, key(value) === anchor ? true : undefined));
    }
    const pressure = this.#retention === 'navigation' && searchEnabled(observation, this.capacity)
      ? updatePressure(this.#searchPressure, observation, this.capacity, this.#lastObservationTick, this.#entries)
      : undefined;
    this.#entries = Object.freeze(this.#retention === 'navigation'
      ? retainNavigation(next, observation, this.capacity) : next.sort(compare).slice(0, this.capacity));
    this.#searchPressure = pressure;
    this.#lastObservationTick = tick;
    return this.snapshot();
  }

  /** Filters combine with AND; positions refer to last positive sightings.
   * Resource results include stale/absent/zero records unless filtered. */
  query(filter: MemoryQuery = {}): readonly MemoryEntry[] {
    const q = record(filter);
    if (q.kind !== undefined && !isKind(q.kind)) throw new RangeError('Unknown query kind');
    if (q.status !== undefined && !isStatus(q.status)) throw new RangeError('Unknown query status');
    if (q.material !== undefined && q.material !== 'wood' && q.material !== 'stone') {
      throw new RangeError('Unknown query material');
    }
    const id = q.entityId === undefined ? undefined : integer(q.entityId, 'entity ID', 1);
    const x = q.x === undefined ? undefined : integer(q.x, 'x');
    const y = q.y === undefined ? undefined : integer(q.y, 'y');
    return Object.freeze(this.#entries.filter(({ value, status }) =>
      (q.kind === undefined || value.kind === q.kind) &&
      (q.status === undefined || status === q.status) &&
      (id === undefined || (value.kind !== 'terrain' && value.id === id)) &&
      (q.material === undefined || (value.kind === 'deposit' && value.material === q.material)) &&
      (x === undefined || value.x === x) && (y === undefined || value.y === y)));
  }

  snapshot(): MemorySnapshot {
    return Object.freeze({ version: 1, observerId: this.observerId, capacity: this.capacity,
      ...(this.#retention === 'navigation' ? { retention: 'navigation' as const } : {}),
      lastObservationTick: this.#lastObservationTick, entries: this.#entries,
      ...(this.#searchPressure === undefined ? {} : { searchPressure: this.#searchPressure }) });
  }

  toJSON(): MemorySnapshot { return this.snapshot(); }

  /** Restore trusted save data; validation checks structure, not provenance. */
  static fromSnapshot(input: unknown): AgentMemory {
    const data = record(input);
    if (data.version !== 1) throw new TypeError('Unsupported memory snapshot version');
    if (data.retention !== undefined && data.retention !== 'navigation') throw new RangeError('Invalid retention');
    const memory = new AgentMemory(integer(data.observerId, 'observer ID', 1),
      integer(data.capacity, 'capacity', 1), data.retention === 'navigation' ? 'navigation' : 'recency');
    const tick = data.lastObservationTick === null ? null :
      integer(data.lastObservationTick, 'observation tick');
    const entries = array(data.entries);
    if (entries.length > memory.capacity || (tick === null && entries.length !== 0) ||
        (tick !== null && entries.length === 0)) throw new RangeError('Invalid memory size');
    const keys = new Set<string>();
    let originSeen = false;
    const restored: MemoryEntry[] = [];
    for (const input of entries) {
      const data = record(input);
      const raw = record(data.value);
      const value = copyValue(raw, raw.kind);
      const status = data.status;
      const observed = integer(data.lastObservedTick, 'last observed tick');
      const checked = integer(data.lastCheckedTick, 'last checked tick');
      if (!isStatus(status) || tick === null || observed > checked || checked > tick ||
          (status === 'current' && (observed !== tick || checked !== tick)) ||
          (status === 'stale' && (observed !== checked || checked >= tick)) ||
          (status === 'absent' && (value.kind === 'terrain' || observed >= checked)) ||
          (value.kind !== 'terrain' && value.id === memory.observerId) || keys.has(key(value))) {
        throw new RangeError('Inconsistent memory entry');
      }
      const visit = data.lastVisitedTick === undefined ? undefined : integer(data.lastVisitedTick, 'last visited tick');
      if (visit !== undefined && (memory.#retention !== 'navigation' || value.kind !== 'terrain' || visit > observed)) {
        throw new RangeError('Inconsistent visit evidence');
      }
      const anchor = data.searchOrigin;
      if (anchor !== undefined && (anchor !== true || originSeen ||
          memory.#retention !== 'navigation' || value.kind !== 'terrain' || visit === undefined)) {
        throw new RangeError('Invalid search origin');
      }
      if (anchor === true) originSeen = true;
      keys.add(key(value));
      restored.push(entry(value, status, observed, checked, visit, anchor === true ? true : undefined));
    }
    if (data.searchPressure !== undefined) {
      const pressure = array(data.searchPressure);
      if (memory.#retention !== 'navigation' || memory.capacity < 16 || tick === null ||
          pressure.length !== Math.min(memory.capacity, 64)) throw new RangeError('Invalid search pressure');
      memory.#searchPressure = Object.freeze(Array.from(pressure, n => {
        const value = integer(n, 'search pressure');
        if (value > 255) throw new RangeError('Invalid search pressure counter');
        return value;
      }));
    }
    restored.sort(compare);
    memory.#entries = Object.freeze(restored);
    memory.#lastObservationTick = tick;
    return memory;
  }
}
