# World event ledger (v0.2)

The headless module `src/sim/history/events.ts` records observed simulation changes.
It has no dependency on World, material/process implementations, rendering or real time.

## Contract

- One EventLedger per world; default capacity 4096 events, configurable at construction.
- append takes a nonnegative safe integer world tick, a nonblank kind string, optional
  positive numeric actorId and targetId (matching current World entity IDs), and optional
  details containing plain JSON data. Details are copied and recursively frozen.
- eventId is assigned by the ledger, starts at 1, and never resets after eviction.
  Ticks must be nondecreasing; events at the same tick follow publication order.
  An invalid append changes neither the sequence nor retained history.
- query returns an immutable array in event ID order. fromTick/toTick are inclusive;
  kind is an exact match, entityId matches either actor or target, and filters combine
  with AND. Queries only see retained events; eviction is not an absence-of-event proof.
- snapshot() and JSON.stringify(ledger) yield version 1 data with capacity, nextEventId
  and retained events. EventLedger.fromSnapshot(parsedData) validates and restores
  the sequence and chronological constraints. Save the ledger alongside the world,
  not independently, once world save/load is implemented.
- Ring-buffer insertion and eviction are O(1) amortized excluding payload copying.
  Queries and snapshots are O(retained event count); storage is O(capacity) events plus
  payload size. Keep details compact; capacity is a count limit, not a byte budget.
  Event IDs are per world, not global. ID exhaustion raises an error rather than
  reusing or rounding IDs.

## World integration

The simulation layer owns one ledger per world and publishes events after rules
successfully apply their state changes. Use the current fixed world tick and stable
rule execution order (including order of multiple events in one tick). For example:

```ts
ledger.append({
  tick: world.tick,
  kind: 'resource.harvested',
  actorId: agent.id,
  targetId: deposit.id,
  details: { material: deposit.material, amount: 1 },
});
```

The example uses current prototype resource units; future material events should
explicitly name quantities and units (e.g. massKg). The current world publishes resource.harvested, resource.depleted,
stockpile.delivered, structure.built, hearth.fuel_consumed, hearth.refueled and
skill.milestone. All use the current tick. Harvest and depletion identify the
agent and deposit; delivery identifies the agent and hub. Hearth events identify
the hearth without inventing an acting agent. Milestones identify the practicing
agent and report skillId, attempts and proficiency. Amounts are legacy prototype
units, not kilograms. The hub receives a stable entity ID after the initial
agents, preserving their existing IDs and resource-choice parity.

`createWorld(seed, { eventCapacity, gatheringMilestones })` optionally overrides
the default ledger capacity and gathering milestones (10, 50, 100). Each agent
has an independent gathering record. Each successful one-unit harvest adds one
practice and 2 XP, using the skills module's saturating curve with half
proficiency at 100 XP. Moving, resting, delivering and depleted deposits give no
practice; proficiency does not alter action outcomes yet. Milestones are
published only on threshold crossings. History and configuration are reset on
world regeneration.

World JSON snapshots now include ledger snapshot data, gathering configuration,
per-agent skill records and a hub ID. This is an additive schema change, except
that newly allocated structure IDs shift by one. JSON parsing alone does not
restore a live EventLedger; use its fromSnapshot API for the ledger. Full world
save/load and old snapshot migration remain future work.

Publish semantic transitions instead of every unchanged state or frame. Never pass
mutable World objects as payloads; use stable IDs and compact facts. World rules
must not call UI code. A future controller may expose snapshots/queries to the
renderer or debugger as read-only observations; UI frame timing, filtering and
selection must not determine which simulation events are recorded.

When world serialization/replay is added, persist and restore the ledger with its
matching world snapshot, and test that identical seeds and actions reproduce the
same event sequence. Decide retention policy for each world; if a consumer falls
behind, detect the gap via IDs instead of assuming complete history.

This is a bounded recent-event history, not an authoritative replay log, AI memory,
database, long-term archive or collective agent. Future long-term consumers must
explicitly handle eviction and define separate storage/summarization policies.
