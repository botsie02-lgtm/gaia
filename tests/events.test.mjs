import assert from 'node:assert/strict';
import test from 'node:test';
import { EventLedger, DEFAULT_EVENT_CAPACITY } from '../.sim-test/history/events.js';

const event = (tick, kind = 'resource.harvested', extra = {}) => ({ tick, kind, ...extra });
const ids = (events) => events.map((item) => item.eventId);

test('event IDs start at one and preserve publication order within a tick', () => {
  const ledger = new EventLedger();
  assert.equal(ledger.capacity, DEFAULT_EVENT_CAPACITY);
  assert.deepEqual(ledger.query(), []);
  const first = ledger.append(event(0));
  ledger.append(event(0, 'agent.rested', { actorId: 1 }));
  ledger.append(event(3));
  assert.deepEqual(first, { eventId: 1, tick: 0, kind: 'resource.harvested' });
  assert.deepEqual(ids(ledger.query()), [1, 2, 3]);
  assert.deepEqual(ledger.query().map((item) => item.tick), [0, 0, 3]);
});

test('retention evicts oldest events across repeated ring wraps without reusing IDs', () => {
  const ledger = new EventLedger(3);
  for (let i = 0; i < 10000; i++) ledger.append(event(i));
  assert.equal(ledger.size, 3);
  assert.deepEqual(ids(ledger.query()), [9998, 9999, 10000]);
  assert.equal(ledger.snapshot().nextEventId, 10001);
  assert.deepEqual(ledger.query({ toTick: 9996 }), []);
});

test('capacity one retains only the latest event including same-tick events', () => {
  const ledger = new EventLedger(1);
  ledger.append(event(5));
  ledger.append(event(5, 'resource.depleted'));
  assert.deepEqual(ids(ledger.query()), [2]);
});

test('filters include both tick endpoints, combine with AND and match either entity role', () => {
  const ledger = new EventLedger(5);
  ledger.append(event(1, 'harvest', { actorId: 7, targetId: 8 }));
  ledger.append(event(2, 'harvest', { actorId: 9, targetId: 7 }));
  ledger.append(event(2, 'rest', { actorId: 7 }));
  ledger.append(event(3, 'harvest', { actorId: 7, targetId: 7 }));
  ledger.append(event(4, 'harvest'));
  ledger.append(event(5, 'harvest', { actorId: 8 }));
  assert.deepEqual(ids(ledger.query({ fromTick: 2, toTick: 3 })), [2, 3, 4]);
  assert.deepEqual(ids(ledger.query({ entityId: 7 })), [2, 3, 4]);
  assert.deepEqual(ids(ledger.query({ kind: 'harvest' })), [2, 4, 5, 6]);
  assert.deepEqual(ids(ledger.query({ fromTick: 2, toTick: 3, kind: 'harvest', entityId: 7 })), [2, 4]);
  assert.deepEqual(ledger.query({ entityId: 100 }), []);
  assert.deepEqual(ids(ledger.query({ toTick: 2 })), [2, 3]);
  assert.deepEqual(ids(ledger.query({ fromTick: 5 })), [6]);
});

test('nested payloads, returned events, queries and snapshots are immutable and detached', () => {
  const ledger = new EventLedger(1);
  const details = { resources: [{ massKg: 2 }], valid: true, note: null };
  const first = ledger.append(event(1, 'harvest', { details }));
  const snapshot = ledger.snapshot();
  details.resources[0].massKg = 99;
  details.resources.push({ massKg: 4 });
  assert.equal(first.details.resources[0].massKg, 2);
  assert.equal(first.details.resources.length, 1);
  assert.throws(() => { first.details.resources[0].massKg = 5; }, TypeError);
  assert.throws(() => { first.details.resources.push(5); }, TypeError);
  assert.throws(() => { first.tick = 9; }, TypeError);
  assert.throws(() => { snapshot.events.pop(); }, TypeError);
  assert.throws(() => { snapshot.nextEventId = 99; }, TypeError);
  assert.throws(() => { ledger.query().push(first); }, TypeError);
  ledger.append(event(2));
  assert.deepEqual(ids(snapshot.events), [1]);
  assert.deepEqual(ids(ledger.query()), [2]);
});

test('JSON serialization restores retention, tick constraints and next ID', () => {
  const ledger = new EventLedger(2);
  ledger.append(event(0));
  ledger.append(event(1, 'harvest', { actorId: 3, details: { items: ['wood', 1, null] } }));
  ledger.append(event(3, 'rest', { targetId: 4 }));
  const serialized = JSON.stringify(ledger);
  const parsed = JSON.parse(serialized);
  const restored = EventLedger.fromSnapshot(parsed);
  assert.equal(JSON.stringify(restored), serialized);
  parsed.events[0].details.items[0] = 'stone';
  assert.equal(restored.query()[0].details.items[0], 'wood');
  assert.throws(() => restored.append(event(2)), RangeError);
  const next = event(3, 'new');
  assert.deepEqual(restored.append(next), ledger.append(next));
  assert.equal(JSON.stringify(restored), JSON.stringify(ledger));
  assert.deepEqual(EventLedger.fromSnapshot(new EventLedger().snapshot()).snapshot(), new EventLedger().snapshot());
});

test('identical ordered inputs produce byte-identical histories', () => {
  const run = () => {
    const ledger = new EventLedger(10);
    for (let i = 0; i < 80; i++) {
      ledger.append(event(Math.floor(i / 3), i % 2 ? 'harvest' : 'rest',
        { actorId: i % 5 + 1, details: { count: i, tags: ['a', 'b'] } }));
    }
    return JSON.stringify(ledger);
  };
  assert.equal(run(), run());
});

test('invalid capacities and event fields are rejected without consuming an ID', () => {
  for (const capacity of [0, -1, 1.2, Infinity, NaN, '2', null, 2 ** 32]) {
    assert.throws(() => new EventLedger(capacity));
  }
  const ledger = new EventLedger();
  ledger.append(event(2));
  for (const input of [
    null, [], {}, event(-1), event(1), event(2.5), event(Infinity), event(NaN),
    event(Number.MAX_SAFE_INTEGER + 1), event('2'), event(2, ''),
    event(2, '  '), event(2, 1), event(2, 'x', { actorId: 0 }),
    event(2, 'x', { targetId: -1 }), event(2, 'x', { actorId: 1.1 }),
    event(2, 'x', { targetId: '7' }), event(2, 'x', { details: [] }),
  ]) assert.throws(() => ledger.append(input));
  assert.equal(ledger.size, 1);
  assert.equal(ledger.append(event(2)).eventId, 2);
});

test('non-JSON payloads are rejected; shared acyclic references are copied', () => {
  const ledger = new EventLedger();
  const cycle = {};
  cycle.self = cycle;
  for (const details of [
    cycle, { x: undefined }, { x: NaN }, { x: Infinity }, { x: 1n },
    { x: () => 1 }, { x: new Date(0) }, { x: new Map() }, { x: Symbol('x') },
    { x: [, 1] }, { [Symbol('x')]: 1 }, { get x() { return 1; } },
  ]) assert.throws(() => ledger.append(event(0, 'x', { details })), TypeError);
  const shared = { x: 1 };
  const saved = ledger.append(event(0, 'x', { details: { a: shared, b: shared } }));
  assert.deepEqual(saved.details, { a: { x: 1 }, b: { x: 1 } });
  assert.equal(saved.eventId, 1);
});

test('invalid query bounds and filters are rejected', () => {
  const ledger = new EventLedger();
  for (const filter of [
    null, [], { fromTick: -1 }, { toTick: 0.1 }, { fromTick: 4, toTick: 3 },
    { toTick: Infinity }, { kind: '' }, { kind: 3 }, { entityId: 0 }, { entityId: '2' },
  ]) assert.throws(() => ledger.query(filter));
});

test('invalid snapshots reject unsupported versions, missing history and corrupt ordering', () => {
  const ledger = new EventLedger(2);
  ledger.append(event(1));
  ledger.append(event(2));
  ledger.append(event(3));
  const snapshot = ledger.snapshot();
  for (const invalid of [
    null, { ...snapshot, version: 2 }, { ...snapshot, capacity: 0 },
    { ...snapshot, nextEventId: 1 }, { ...snapshot, nextEventId: 5 },
    { ...snapshot, events: [] }, { ...snapshot, events: [snapshot.events[1], snapshot.events[0]] },
    { ...snapshot, events: [snapshot.events[0], { ...snapshot.events[1], tick: 0 }] },
    { ...snapshot, events: [snapshot.events[0], { ...snapshot.events[1], kind: '' }] },
  ]) assert.throws(() => EventLedger.fromSnapshot(invalid));
});

test('event ID exhaustion fails explicitly rather than losing integer precision', () => {
  const nextEventId = Number.MAX_SAFE_INTEGER;
  const ledger = EventLedger.fromSnapshot({
    version: 1, capacity: 1, nextEventId,
    events: [{ eventId: nextEventId - 1, tick: 0, kind: 'test' }],
  });
  assert.throws(() => ledger.append(event(0)), RangeError);
  assert.equal(ledger.snapshot().nextEventId, nextEventId);
});
