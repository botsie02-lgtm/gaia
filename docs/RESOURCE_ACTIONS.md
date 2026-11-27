# Physical resource actions (v0.2 foundation)

This headless adapter implements ownership-based resource movement without
changing World or its prototype counts. PhysicalInventory is the only
authoritative sample store. No action creates matter, consumes fuel, changes
phase or performs chemistry. The world controller, not an agent policy,
authorizes and executes these operations.

## Bootstrap and identifiers

Use resourceOwnerId(kind, entityId), with kind deposit, agent, hub or structure
and the positive safe integer stable entity ID allocated by World. Do not use
coordinates, collection indices or a temporary hub ID of zero. Pass a list of
registered owner IDs (including empty owners) to each operation. Invalid,
duplicate or unregistered IDs are rejected. The controller owns the registry
of actual entities; the list is not another inventory or an authorization proof.

```ts
import { resourceOwnerId, migrateLegacyResources, transferResources,
  resourceUnits } from '../src/sim/resource-actions/index.js';

const deposit = resourceOwnerId('deposit', 1);
const agent = resourceOwnerId('agent', 2);
const hub = resourceOwnerId('hub', 3);
const hearth = resourceOwnerId('structure', 4);
const owners = [deposit, agent, hub, hearth];
const calibration = [
  { resourceId: 'wood', materialId: 'wood', kgPerUnit: 2 },
  { resourceId: 'stone', materialId: 'stone', kgPerUnit: 3 },
] as const; // scenario choices, not physical measurements
const inventory = migrateLegacyResources(null, owners, [
  { ownerId: deposit, resourceId: 'wood', units: 5, temperatureC: 20 },
  { ownerId: deposit, resourceId: 'stone', units: 4, temperatureC: 45 },
], calibration);

const move = (from: typeof owners[number], to: typeof owners[number]) =>
  transferResources(inventory, inventory.revision, owners, from, to, [
    { materialId: 'wood', massKg: 8 },
    { materialId: 'stone', massKg: 12 },
  ]);
move(deposit, agent); // harvest
// Travel changes position, not cargo ownership.
move(agent, hub); // delivery
const receipt = move(hub, hearth); // material allocation, not chemistry
const remainingWoodUnits = resourceUnits(inventory, owners, deposit, 'wood', calibration);
```

The example leaves 2 kg wood in the deposit and allocates 8 kg wood plus 12 kg
stone to the structure. Each original material's mass and modeled sensible
energy are preserved. The example is an accounting demonstration, not a
claim that one agent can carry this amount in the existing World.

Migration accepts a null inventory only, rejects a live or restored store,
validates the calibration and each holding, including zero holdings, then
omits zeros and bootstraps once through PhysicalInventory.initializeLegacy.
One holding per owner/resource pair is permitted. There must be at most one
calibrated resource ID per catalog material, to avoid reverse-view double
counting. Initialization IDs are assigned in lexical owner ID then resource ID
order, independent of input ordering. Calibration is scenario policy: no
implicit kg-per-unit or starting temperature. The caller must supply complete
legacy holdings, and must retain the resulting store (including an empty one)
as the world lifecycle authority. Passing null again to create a second world
is possible; no standalone function can prove two calls describe the same
world. Do not reconstruct an existing world from legacy counts.

## Transfer and numerical semantics

transferResources accepts an expected inventory revision, registered owners,
source and destination IDs, and a nonempty list of distinct positive material
masses in kilograms. A transfer may cover several materials atomically, for
example when allocating a complete construction bill. Material requests are
processed in lexical material ID order; within each material, live source
samples are consumed in ascending numeric sample ID order. Compatible here
means the same catalog material in its supported phase, not equal temperature.
Whole samples retain their ID; a partial sample retains the parent ID on the
source remainder and moves the new child ID. Different temperatures are
preserved without merging or averaging.

All operations are planned before submitting one revision-checked
PhysicalInventory.transact call. Insufficient material or invalid requests
throw before commit; a failed staged split likewise rolls back every prior
operation, revision and allocated ID. A successful batch advances revision
once. The returned frozen JSON-compatible receipt contains source/destination
owner IDs, resulting revision, per-material actual planned transferred kg,
per-sample original and transferred IDs and kg, and created sample IDs. It
contains no wall-clock time and is not a durable event ledger. The controller
adds the logical tick, semantic event kind and actor/target world IDs only
after commit; failed actions must not produce success events or skill practice.

This uses IEEE-754 doubles and the inventory's pair conservation checks
(16 machine epsilons with a subnormal floor, plus relative split resolution
checks). Whole transfers preserve every physical field exactly; partial
transfers preserve material, phase and temperature exactly, and mass and
constant-specific-heat sensible energy within the underlying tolerance.
Requests are strict: no epsilon stock grant, automatic rounding, or
unrepresentable debit. Subtracting decimal quantities can leave a tiny
remainder or reject a nominally equal request; use consistently representable
scenario quantities, or explicitly request a representable mass. The planner
rejects lost positive operands, nonfinite sums and material movement errors
over 1e-9 relative. Global sums can overflow or accumulate roundoff; there
is no claim of exact decimal or full thermodynamic conservation.

resourceMassKg and resourceUnits compute views on demand from live owner
samples. The latter delegates conversion to the physics bridge; it can
return fractional units. No setters, mutable copies or parallel balance
are maintained. Persist the calibration and world entity registry alongside
the existing inventory snapshot; restore with PhysicalInventory.restore,
never by repeating migration. Receipts do not need to be persisted for ID
allocation or deterministic continuation.

Owner queries use the inventory's derived owner index. Transfer planning reads
the read-only nextSampleId cursor directly (O(1)) rather than serializing a
complete inventory snapshot. Planning scans source samples once per requested
material in numeric ID order. Owner-registry validation and calibration
conversion remain per-call work. See INVENTORY_PERFORMANCE.md for measurements.

## Incremental World migration (future integration PR)

1. Establish scenario calibration and explicit starting temperatures. At a
   quiescent logical tick, enumerate every live deposit amount, agent cargo,
   hub stockpile, and structure stoneUsed and remaining fuel. Validate IDs
   after the hub has its allocated ID. Do not migrate cumulative harvested
   statistics as matter. Already-burned legacy fuel cannot be recovered
   from current holdings; establish a new accounted baseline, or migrate
   a fresh world before any combustion.
2. Publish one physical registry, discard the writable legacy resource
   balances, and derive compatible deposit/cargo/hub/structure values for
   UI and perception. Do not dual-write authoritative counts and kilograms.
   Save inventory, calibration, tick, entity allocation and state together.
3. Convert prototype action quantities explicitly using the scenario
   calibration. Authorize position, reach, carrying capacity, source
   existence, faction permissions and construction prerequisites in the
   privileged world executor. Serialize competing actions by stable entity
   ID and logical tick; send receipts/events and genuine skill practice
   only after success. A depleted deposit can be removed only when its
   physical inventory is empty. Travel leaves sample ownership unchanged.
4. Register a proposed structure ID and stage its full material bill in
   one transfer; publish entity creation only if allocation succeeds.
   Refueling is a hub-to-structure transfer, not resource creation. Stone
   and unburned fuel remain identifiable physical samples. Future structures
   may need distinct containers for different roles of the same material.
   World-level entity creation and inventory publication must be coordinated;
   this module only guarantees inventory transaction atomicity.
5. Disable the legacy hearth fuel decrement and associated abstract heat
   gain before enabling physical authority. Never delete wood, turn all
   wood into ash, or treat heat as a mass sink. Until a balanced reaction
   model is available, retain unburned fuel and leave combustion disabled
   (a deliberately dormant hearth). Implement oxygen/air inputs, fuel
   composition, gas and solid products including water vapour, elemental
   balances, reaction energy, environment exchange and explicit thermal
   reservoirs. Coordinate process progress, energy and identity-aware
   inventory mutations atomically before re-enabling combustion. The
   existing physics bridge does not yet support chemical transmutation.
   No claim of full world physical conservation is valid while the
   legacy fuel sink or unaccounted energy source remains active.
6. Verify replay, save/load, per-material conservation for transfers,
   balanced reaction products for future chemistry, and unchanged
   nonphysical agent rules. Developer 11's decision-policy integration
   remains independent; policies should never receive the authoritative
   inventory or owner registry.

This PR does not modify the running World, rendering, inventory internals,
materials, processes, thermal contact, physics bridge or CI.
