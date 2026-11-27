# Physical world integration

## Modes and calibration

Headless createWorld(seed) still defaults to legacy policy and resources. The
browser starts with knowledge-limited agents and physical matter; either selector
regenerates the seed, resetting history, memory and inventory independently of the
other selector. To opt in headlessly:

```ts
createWorld(12345, {
  agentMode: 'knowledge', resourceMode: 'physical',
  kgPerUnit: { wood: 2, stone: 3 },
  initialTemperatureC: { wood: 20, stone: 15 },
});
```

Defaults above are explicit scenario tuning, not measured masses or temperatures.
Mass calibrations must be positive multiples of 1/1024 kg, up to 1024 kg, so
this finite integer-unit gameplay economy has exact representable mass increments.
The lower-level physical APIs still support arbitrary validated finite quantities.
Temperatures are validated catalog starting conditions, not environmental fields.
The cargo limit is 3 prototype units across materials, not a fixed mass limit.
The hearth consumes no matter: its construction allocates 4 wood and 8 stone
prototype units to structure ownership using the calibrated mass of each.

The initial generator allocates all stable IDs before migrating deposits, cargo
and hub balances exactly once. Existing cumulative stats are not resources.
PhysicalInventory is the sole live authority. Getter-backed legacy views retain
the existing perception, decision and rendering contracts; writes throw in
strict mode. Entity collections and positions remain controller-owned. This is
not a security sandbox; callers must not mutate entity registries out of band.
No hot migration of a previously burning legacy world is offered; lost legacy
fuel cannot be reconstructed.

## Transactions and history

Harvest and delivery validate positions, registered entities, availability and
cargo capacity, then use the existing revision-checked transferResources API.
Physical legacy execution and knowledge execution resolve in stable agent ID
order. Knowledge decisions still receive detached local observations and own
cargo only. The construction site must be passable and free of deposits; the
prospective structure ID is registered for its entire atomic two-material bill,
and published only after success. Failed transfers do not award experience or
publish successful events. Resource events retain prototype-unit fields and add
physical receipts with owner IDs, revision, material massKg and source/transferred
sample IDs. Depletion removes empty deposits, not samples. Traveling changes
position but not ownership. Whole transfers preserve identity; splits preserve
temperature, phase and material, retaining the source ID on its remainder.
No merges or transformations occur.

Physical hearths are dormant: no fuel destruction, abstract heat, cooling or
refueling runs. Legacy mode retains all original fuel/heat rules. No ambient
heat exchange, reaction chemistry, oxygen, gas products, phase changes, energy
reservoirs, mechanical work, or actual forging is modeled. Agent energy remains
abstract. Conservation applies to tracked material samples and modeled sensible
energy, not the entire universe. Floating-point thermal sums are approximate.

## Snapshot compatibility and scaling

Use snapshot(world) for deterministic JSON including the version-1 physical
inventory snapshot, calibration, initial temperatures, resource mode and
existing entity, memory, tick and history data. Plain JSON.stringify(world)
is not a supported physical save (the live registry has private state).
The derived counts in the diagnostic snapshot are redundant read-only views;
on future full-world restoration, restore the inventory via PhysicalInventory.restore
and rebuild projections, never reinitialize from those counts. Old legacy
snapshots lack the new fields; full-world save/load and migration remain future
work. Resource mode is fixed at creation.

Owner views use a derived index, and transfers read the allocation cursor
without constructing a full snapshot. The registry remains authoritative and
transactions remain revision-checked and atomic. As samples split, retained
sample count grows; the index does not consolidate samples or change identities.
Owner registry validation, large-owner sorting, perception and rendering remain
potential costs. See INVENTORY_PERFORMANCE.md for measured headless scenarios;
no browser benchmark, chunking or consolidation is implemented. The browser inspector is omniscient for debugging, not agent knowledge.
