/** Deterministic, bounded history; no dependency on World or rendering. */
export type EventValue = null | boolean | number | string |
  readonly EventValue[] | { readonly [key: string]: EventValue };
export type EventDetails = { readonly [key: string]: EventValue };

export interface EventInput {
  readonly tick: number;
  readonly kind: string;
  readonly actorId?: number;
  readonly targetId?: number;
  readonly details?: EventDetails;
}

export interface SimulationEvent extends EventInput {
  readonly eventId: number;
}

export interface EventQuery {
  readonly fromTick?: number;
  readonly toTick?: number;
  readonly kind?: string;
  readonly entityId?: number;
}

export interface LedgerSnapshot {
  readonly version: 1;
  readonly capacity: number;
  readonly nextEventId: number;
  readonly events: readonly SimulationEvent[];
}

export const DEFAULT_EVENT_CAPACITY = 4096;

function integer(value: unknown, name: string, min: number,
  max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      value < min || value > max) {
    throw new RangeError(name + ' must be a safe integer in range');
  }
  return value === 0 ? 0 : value;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(name + ' must be a nonempty string');
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('Expected a plain object');
  }
  return value as Record<string, unknown>;
}

/** Copy and freeze JSON data, rejecting lossy or cyclic representations. */
function copyValue(value: unknown, ancestors: Set<object>): EventValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid JSON value');
  if (ancestors.has(value)) throw new TypeError('Cyclic event details');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // Reject holes, extra properties, symbols and getters instead of silently losing data.
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError('Expected a dense JSON array');
      }
      const items: EventValue[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('Expected a dense JSON array');
        }
        items.push(copyValue(descriptor.value, ancestors));
      }
      return Object.freeze(items);
    }
    const source = record(value);
    const entries: [string, EventValue][] = [];
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (typeof key !== 'string' || !descriptor || !descriptor.enumerable ||
          !('value' in descriptor)) throw new TypeError('Expected JSON properties');
      entries.push([key, copyValue(descriptor.value, ancestors)]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

function makeEvent(input: unknown, eventId: number): SimulationEvent {
  const data = record(input);
  const tick = integer(data.tick, 'tick', 0);
  const kind = nonempty(data.kind, 'kind');
  const actorId = data.actorId === undefined ? undefined : integer(data.actorId, 'actorId', 1);
  const targetId = data.targetId === undefined ? undefined : integer(data.targetId, 'targetId', 1);
  const details = data.details === undefined ? undefined :
    copyValue(record(data.details), new Set()) as EventDetails;
  return Object.freeze({
    eventId, tick, kind,
    ...(actorId === undefined ? {} : { actorId }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(details === undefined ? {} : { details }),
  });
}

export class EventLedger {
  readonly #capacity: number;
  readonly #buffer: SimulationEvent[] = [];
  #start = 0;
  #nextEventId = 1;
  #lastTick = 0;

  constructor(capacity = DEFAULT_EVENT_CAPACITY) {
    this.#capacity = integer(capacity, 'capacity', 1, 0xffffffff);
  }

  get capacity(): number { return this.#capacity; }
  get size(): number { return this.#buffer.length; }

  /** Append in nondecreasing tick order; ties preserve publication order. */
  append(input: EventInput): SimulationEvent {
    if (this.#nextEventId >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Event IDs exhausted');
    }
    const event = makeEvent(input, this.#nextEventId);
    if (event.tick < this.#lastTick) throw new RangeError('Cannot append an earlier tick');
    if (this.size < this.capacity) {
      this.#buffer.push(event);
    } else {
      this.#buffer[this.#start] = event;
      this.#start = (this.#start + 1) % this.capacity;
    }
    this.#nextEventId++;
    this.#lastTick = event.tick;
    return event;
  }

  /** Inclusive tick bounds; filters combine with AND, entity matches either role. */
  query(filter: EventQuery = {}): readonly SimulationEvent[] {
    const data = record(filter);
    const from = data.fromTick === undefined ? 0 : integer(data.fromTick, 'fromTick', 0);
    const to = data.toTick === undefined ? Number.MAX_SAFE_INTEGER : integer(data.toTick, 'toTick', 0);
    if (from > to) throw new RangeError('Invalid tick range');
    const kind = data.kind === undefined ? undefined : nonempty(data.kind, 'kind');
    const entity = data.entityId === undefined ? undefined : integer(data.entityId, 'entityId', 1);
    const matches: SimulationEvent[] = [];
    for (let i = 0; i < this.size; i++) {
      const event = this.#buffer[(this.#start + i) % this.size]!;
      if (event.tick > to) break;
      if (event.tick < from || (kind !== undefined && event.kind !== kind) ||
          (entity !== undefined && event.actorId !== entity && event.targetId !== entity)) continue;
      matches.push(event);
    }
    return Object.freeze(matches);
  }

  /** Stable, JSON-compatible snapshot independent of future appends. */
  snapshot(): LedgerSnapshot {
    return Object.freeze({
      version: 1, capacity: this.capacity, nextEventId: this.#nextEventId,
      events: this.query(),
    });
  }

  toJSON(): LedgerSnapshot { return this.snapshot(); }

  /** Restore a serialized snapshot, including its ID sequence after eviction. */
  static fromSnapshot(snapshot: unknown): EventLedger {
    const data = record(snapshot);
    if (data.version !== 1) throw new TypeError('Unsupported ledger version');
    const ledger = new EventLedger(integer(data.capacity, 'capacity', 1, 0xffffffff));
    const next = integer(data.nextEventId, 'nextEventId', 1);
    const events = data.events;
    if (!Array.isArray(events) || events.length !== Math.min(ledger.capacity, next - 1)) {
      throw new RangeError('Invalid retained event count');
    }
    ledger.#nextEventId = next - events.length;
    for (const input of events) {
      const event = record(input);
      if (event.eventId !== ledger.#nextEventId) throw new RangeError('Invalid event ID sequence');
      // makeEvent also validates fields; append enforces chronological order.
      ledger.append(event as unknown as EventInput);
    }
    return ledger;
  }
}
