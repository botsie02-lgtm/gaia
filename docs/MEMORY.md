# Individual agent memory (v0.3 foundation)

The headless memory module consumes only Developer 7's Observation. It is
separate from World, history, skill records, rendering and decisions. An owner
creates one memory per agent, within one world; no automatic sharing occurs.

```ts
import { AgentMemory } from './sim/memory/index.js';
import { observeAgent } from './sim/perception/index.js';

const memory = new AgentMemory(agent.id, 512);
// Privileged controller obtains observation; agent receives only local data.
memory.update(observeAgent(world, agent.id, { range: 6 }));
const wood = memory.query({ kind: 'deposit', material: 'wood', status: 'current' });
const atLocation = memory.query({ x: 10, y: 12 });
const restored = AgentMemory.fromSnapshot(JSON.parse(JSON.stringify(memory)));
```

## Evidence model

One entry per tile coordinate or globally stable entity ID within the world.
Terrain, other agents (including faction), deposits (material and observed
amount), hearths and hub locations are copied from the local projection. Amounts
are legacy prototype units, not kilograms. The observer itself is not stored
as another entity. No unobserved attributes, inventory, skills or event data
are copied. An observation must belong to the memory owner and be supplied
at most once per strictly increasing logical tick; skipped ticks are allowed.

- **current**: positively observed in the latest accepted observation, not
  necessarily at the current world tick if the controller has not updated.
  An explicitly observed deposit with amount zero is current but exhausted.
- **stale**: last positively observed earlier, not confirmed by the latest
  observation. Its last known amount and position are not live facts.
- **absent**: a later observation covered the last known tile without that ID.
  This is evidence only that the object was not at that location at
  lastCheckedTick. It is not proof of destruction, death or global depletion.
  The last positive sighting (including any old amount) remains historical;
  do not treat absent deposits as available. An absent entry remains absent
  until a new sighting, and its absence evidence can itself become old.

lastObservedTick dates the positive sighting; lastCheckedTick dates the
latest positive sighting or confirmation of absence. Seeing the same ID at a
different position replaces the old record, even if the old tile is also
visible. New quantities, terrain and faction labels replace old values.
The current World removes exhausted deposits, so their later absence is
represented without inventing a measured zero or cause. An empty or occluded
location outside the actual visible tile set cannot invalidate a sighting.
A different ID at the old position is a separate object.

## Retention and queries

Capacity defaults to 512 entries total, configurable as a positive safe
integer. Newest evidence is retained first; ties prefer entities over terrain,
then ascending numeric entity ID or row-major terrain coordinates. The order is
canonical, independent of input collection ordering. A new observation may
itself exceed capacity: some current sightings can be forgotten immediately.
Absence markers count toward capacity and can be evicted. Rechecking an empty
former location refreshes its absence evidence. Missing/evicted records mean
unknown, not absent. This policy is intentionally simple, not salience-based.

query() returns frozen entries in retention order; optional kind, entityId,
material, x, y and status filters combine with AND. Coordinates always refer to
last positive sightings. Resource queries include old and absent quantities
unless filtered; even current entries require amount > 0 to be useful for
gathering. Use lastCheckedTick and snapshot.lastObservationTick to assess how
recent any evidence is. Queries are read-only; they do not refresh retention.

update() commits only after validation and returns a frozen snapshot. All
entries and their value records are frozen, detached from input observations.
Earlier snapshots remain unchanged; unchanged immutable entries may be shared
between snapshots of the same agent. snapshot() and toJSON() expose version 1
data; fromSnapshot() validates fields, tick relationships, unique keys and
capacity and restores the canonical order. Restore only trusted saves from the
matching world and agent. This is not a security boundary or a proof that
input observations actually originated from the projection. The controller
must enforce provenance and reset memory when regenerating a world.

## Cost and limitations

For C retained entries and V observed tiles plus entities, the update builds
a temporary map and scans old records, then sorts at most C+V candidates:
O((C+V) log(C+V)) time and O(C+V) temporary space, with O(C) retained space.
snapshot() is O(1) before serialization; query() and JSON serialization are
O(C). For N agents, retained memory is O(N*C), excluding snapshots held by
callers and the separate perception cost. No spatial index, chunk persistence,
compression, byte budget or performance benchmark is introduced. Profile
before scaling populations or increasing range and capacity.

No world lifecycle or decision integration is included. Existing agents still
use their current global policies. No inferred destination for missing
entities, confidence decay, causal reasoning, long-term experience log,
skill learning, communication, collective knowledge or intelligence claims.
Future controllers should take consistent observations at logical tick
boundaries and persist individual memories with their corresponding world.
