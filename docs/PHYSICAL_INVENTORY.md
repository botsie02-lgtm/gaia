# Persistent physical inventory (v0.2 foundation)

This headless subsystem owns persistent catalog samples, not legacy abstract
resource counts. It is independent of World, agents, rendering, history and
process progress. There is no crafting, chemistry or phase change.

## Single authority and identity

Use one PhysicalInventory per world, imported from
`src/sim/inventory/index.ts` with .js import specifiers. Each positive-mass
homogeneous sample has sampleId (positive safe integer), ownerId (non-empty
string), materialId, massKg, temperatureC and phase. Sample IDs are scoped to
the registry; use namespaced owner strings such as entity:12, deposit:5 or
container:3 to avoid collisions between caller-defined ID domains. The caller
is responsible for verifying owners exist and are authorized. An owner need
not contain any samples. Owner views are derived from one authoritative map,
not duplicate inventories.

- initialize(ownedSamples) assigns IDs starting at 1 in input order.
- initializeLegacy(entries, calibrations) uses the physics bridge's
  createResourceConverter. A scenario must explicitly supply kgPerUnit for
  each resource, temperature and ownership. Omit empty legacy entries; zero
  mass records are rejected. Do not initialize the same resources twice.
- Transfer retains the ID and changes only its owner, requiring the current
  owner as a precondition. Partial transfer is split then transfer.
- Split retains the original ID for the remainder and assigns a new ID to
  the removed portion at the same owner and temperature.
- Combine requires distinct compatible samples at the same owner, retires
  both IDs, assigns a new one and uses catalog combineSamples.
- Heat retains both IDs, ownership, masses, materials and phases; delegates
  to stepThermalContact for both temperatures and signed nominal joules.
- Retired IDs never recur in committed state. No tombstone log is retained:
  the allocation cursor survives serialization even when high IDs retire.
  A failed transaction consumes no IDs. IDs allocated then retired within
  a successful transaction appear in both receipt arrays.
- No general add, remove, temperature setter, mass setter or external energy
  injection is provided. Initialization and restoration are trusted world
  lifecycle boundaries, not actions available to agents.

## Transactions and persistence

```ts
import { PhysicalInventory } from './sim/inventory/index.js';

const inventory = PhysicalInventory.initialize([
  { ownerId: 'entity:1', materialId: 'stone', massKg: 2,
    temperatureC: 90, phase: 'solid' },
  { ownerId: 'container:2', materialId: 'water', massKg: 1,
    temperatureC: 20, phase: 'liquid' },
]);
const receipt = inventory.transact(inventory.revision, [
  { kind: 'heat', a: 1, b: 2,
    contact: { conductanceWPerK: 100, tickDurationSeconds: 1 } },
]);
// Both temperatures have committed; signed joules are in receipt.heat.
const saved = JSON.stringify(inventory.snapshot());
const restored = PhysicalInventory.restore(JSON.parse(saved));
```

transact(expectedRevision, operations) applies a nonempty ordered batch
synchronously. A later operation sees earlier staged results (including IDs
allocated in that transaction, starting from snapshot.nextSampleId).
Failure throws and leaves ownership, temperatures, masses, revision and ID
cursor unchanged. A successful call advances revision once, including
valid no-op heat contacts. Stale revision prevents replay against the same
live registry. The receipt contains createdIds, retiredIds and heat
entries in operation order within each category. It is not a durable event
ledger or proof of authorization. Heat may occur across owners; the world
controller must authorize actual contact. Do not expose the registry itself
to unprivileged agents.

get(id), forOwner(ownerId) and snapshot() return immutable records/views;
owner queries and snapshots are sorted by ID. Old snapshots remain unchanged.
Snapshot schema version 1 carries revision, nextSampleId and all live samples.
Restore validates positive finite catalog samples, safe IDs, unique ownership
by sample ID and cursor bounds. It canonicalizes ordering and detaches input.
Restoration is not authentication: a valid-looking modified save cannot be
distinguished from an intentional bootstrap, and two independently restored
copies must not both be authoritative in the same world. Persist calibration
policy separately with the world save.

## Conservation and limits

Transfer preserves all physical fields exactly. Split and combine conserve
per-material mass and modeled sensible thermal energy; heat exchanges conserve
pair energy with no external energy debit. Thermal energy is obtained from
sensibleEnergyJ (constant catalog specific heat, arbitrary absolute-zero
reference). Each affected pair is checked against 16 machine epsilons of
its mass/energy scale with an eight-minimum-subnormal floor. Additionally
split/merge reject mass movement when its representable difference is zero
or differs by more than 1e-9 relative to the smaller/requested quantity.
Non-finite capacities, energies and pair totals are rejected. Only the
affected records are checked; a global aggregate can overflow even when
individual samples are valid. Long sequences can accumulate roundoff, so
this is not exact decimal or full thermodynamic conservation. Nominal heat
transfer can differ from the actual representable temperature changes at
extreme scales. The existing fixed-phase model does not infer phase changes,
pressure, chemistry or real contact geometry; see THERMAL.md and MATERIALS.md.

Storage is O(live samples); a transaction uses O(touched IDs + operations)
temporary space and expected O(operations) map work. No global copy or scan
per transaction. get is expected O(1); owner views currently scan O(N) and
sort matching records; snapshots sort O(N log N). Add an owner index only
after profiling. Keep sample granularity coarse, and do not split every
particle or retain a snapshot per tick. No external persistence or crash
recovery is implemented.

## Recommended World integration (separate PR)

1. Define owner namespaces and calibrated scenario masses/initial temperatures.
   Migrate deposit, cargo, hub and structure stocks once; derive legacy UI
   counts from the physical registry instead of updating parallel stocks.
2. Keep stable references by sample ID, not detached material copies. Gather
   and deliver via ordered split/transfer transactions. Serialize competing
   actions by stable entity ID at a logical tick boundary.
3. Introduce modeled tick seconds and actual contact scheduling. Commit both
   thermal outputs once; emit history events only after success.
4. Before integrating the process bridge, add identity-aware input
   reservations/consumption and a transaction that also covers process state,
   external energy reservoirs and balanced output creation. Do not install
   anonymous batch samples as a second authoritative stockpile.
5. Save the registry snapshot, calibration and world tick together. Add
   replay and conservation tests spanning the whole migration. No current
   World behavior or prototype hearth fuel is changed by this module.
