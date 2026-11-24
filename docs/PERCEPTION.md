# Local agent perception (v0.3 foundation)

The perception module is a read-only projection of the current authoritative
world. It does not change World or Agent, advance ticks, consume random numbers,
publish events, or select actions. Existing world policies remain unchanged and
still have global information; migrating them is a separate task.

## API

```ts
import { observeAgent } from './sim/perception/index.js';

const observation = observeAgent(world, agent.id, {
  range: 6,
  opaqueTerrain: ['water'],
});
```

Call this in a privileged simulation controller at a consistent logical tick
boundary. Pass only the returned Observation to a future agent policy, not the
world or the projection function. This is an architectural information boundary,
not a security sandbox. The structural PerceptionWorld input accepts the existing
World and requires only geometry, tick, positions and visible object attributes.

- Range is an inclusive Manhattan distance in integer tiles, default 6; zero
  includes the observer tile and objects sharing it. Grid edges clip the search.
- Default opaque terrain is empty. The caller may opt into any current terrain
  kind as opaque. Water blocking movement does not inherently mean it blocks sight.
- A center-to-center grid ray checks every intervening cell. A ray exactly through
  a corner is blocked by either adjacent opaque cell, preventing diagonal corner
  peeking. The origin and destination cells do not block their own ray. An opaque
  tile and objects on it can be seen, but that tile blocks rays beyond it.
- The same visible tile set gates terrain, other agents, deposits, hearths and
  the hub. Other entities and structures do not themselves occlude sight.
- Terrain is row-major (y then x); entity lists are ascending numeric ID, independent
  of input collection order. The observer is separate from the other-agent list.
  A hidden hub is null. Missing objects are not evidence of global absence.
- All records and arrays are freshly allocated and frozen, including the root.
  They contain only primitive fields; no live world references or methods.
- The tick, agent ID, faction, coordinates, deposit material ID (existing
  `material` field), deposit amount and structure kind are preserved. Amounts
  remain prototype units, not kilograms. No inferred material masses are exposed.
- Other agents' energy, cargo, skill records, hearth fuel/heat, shared inventory,
  history, seed, random state, global stats, dimensions and unseen locations are
  not exposed. Faction labels are the current model's settler, neutral and hostile;
  all use identical rules. The labels do not imply an alliance or hostility model.
- Invalid range, observer ID/position, grid dimensions, tick and opaque terrain
  names are rejected. The authoritative world is trusted to maintain valid
  entity records and unique IDs. IDs are scoped to one world.

## Limitations

This is perfect, instantaneous 360-degree tile sensing within the chosen range,
not a physical vision model. Visible faction/material labels and exact deposit
amounts are a prototype simplification. No facing, darkness, weather, detection
probability, elevation, hearing, disguise, learned identification, partial
knowledge, memory, persistence or decision integration. The entire world is
still held in memory by the existing simulation.

The projection scans a clipped Manhattan neighborhood (up to the whole grid),
with up to O(range) ray steps per candidate tile when obstruction is enabled.
It scans current entity arrays once for each observer and sorts only visible
records by ID. No spatial index, cache or multi-agent batch optimization is
introduced; profile before scaling. Snapshots are immutable values, not a
retained event log or a subscription to subsequent changes.
