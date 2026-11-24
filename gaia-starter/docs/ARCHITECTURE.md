# Architecture

```text
src/sim/model.ts   World state and typed entities
src/sim/random.ts  Seeded deterministic RNG
src/sim/world.ts   World generation, pathfinding, agent actions, material rules, fixed tick
src/ui/draw.ts     Canvas renderer (read-only view of simulation state)
src/main.ts        Browser controls, time accumulator, selection, data panels
tests/             Black-box simulation invariants and reproducibility tests
```

## Core invariants

- `stepWorld(world)` advances exactly one fixed logical tick. It has no dependency on FPS, Date.now, Math.random or DOM.
- Terrain is a fixed width × height tile array. Water is impassable.
- Deposits are finite. Agent cargo and hub inventory are non-negative.
- Entity IDs are monotonic within one world.
- Rules are deterministic for a given seed and sequence of actions.

## Deliberate simplifications

- Agents may temporarily occupy the same tile, and all agents currently belong to the settler faction.
- Agents use deterministic local decision policies, not AI training or learned skills.
- Agent pathfinding uses BFS recomputed per step. Replace with cached route planning after profiling.
- Heat is abstract and wood burning is not chemically modeled. Future process rules should explicitly account for mass, energy, products and environmental conditions.
- Each world is kept in memory and rendered in full. Later: chunking, headless runs, storage, spatial indexes and simulation LOD.

## Future systems and boundaries

1. `sim/materials`: common material properties, inventories, transformations, combustion and heat transfer.
2. `sim/agents`: shared perception, memory, motives, task planning and learning interfaces for any faction.
3. `sim/world`: chunk-based world rules, terrain, weather and locality.
4. `sim/history`: world event log, snapshots and long-term summaries feeding collective agents.
5. `ui`: replace the basic Canvas view with efficient rendering only when needed.

**Do not add all of these modules immediately.** Evolve boundaries as their first concrete implementations arrive.
