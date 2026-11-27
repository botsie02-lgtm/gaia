# Physical consumption foundation — Specialist Sprint 002

This independent, privileged adapter connects the existing PhysicalInventory
and abstract biology API. It implements liquid water drinking only. No World,
agent policy, chemistry, material catalog, inventory internal, thermal or UI
changes. No water is created, destroyed, replenished or removed as waste.
There is no atmospheric or food supply.

## Units and accounting

The existing catalog identifies water as a liquid, with reference density
998.2 kg/m³ and constant specific heat 4182 J/(kg K), rounded at 20 C and
atmospheric pressure (see MATERIALS.md). The catalog does not establish
potability or phase equilibrium. A scenario must explicitly allocate actual
water samples to authorized source owners; water terrain is not a source.

Each body has a unique stable owner ID body-water:<agentId>, separate from
agent cargo agent:<agentId>. Registration records the positive safe integer
agent ID, capacity in kg, a configured thirst relief per kg, and a validated
individual physiological state. Registration creates no physical samples.
Existing explicitly allocated liquid-water holdings may be registered if
valid and within capacity. Empty reservoirs have no sample records.
PhysicalInventory is the sole physical authority; reservoirMassKg derives
from its indexed owner view. No separate authoritative balance is stored.

For a successful drink of m kg, the mapping is:

    mappedRelief = min(1, m * thirstReliefPerKg)
    nextThirst = max(0, priorThirst - mappedRelief)
    actualRelief = priorThirst - nextThirst

The two relief values are dimensionless, unlike the mass. The coefficient
is a scenario parameter (score/kg), not a verified physiological constant.
No default human or species coefficient is assumed. Zero is valid; an already
satisfied individual can still receive physical water, with zero actual relief.
The whole confirmed mass is retained even when relief saturates. No reserves,
absorption, digestion, energy, condition recovery or conversion between
normalized need scores and kilograms beyond this explicit mapping is implied.

## Owner registration and API

Use existing resource owner IDs deposit:<id>, agent:<id>, hub:<id> or
structure:<id> as explicitly registered sources. They need not contain samples.
Only the controller may authorize which sources exist, can be reached, contain
potable water, and may be accessed by this particular individual. The registry
is not a proximity, safety, permissions or entity-life proof. Body-water owners
are distinct and cannot serve as sources. A registered source can hold other
materials, but they are not selected.

```ts
import { PhysicalInventory } from '../../src/sim/inventory/index.js';
import { createBiologicalState } from '../../src/sim/biology/index.js';
import { PhysicalConsumption } from '../../src/sim/biology/consumption/index.js';

const inventory = PhysicalInventory.initialize([
  { ownerId: 'hub:1', materialId: 'water', phase: 'liquid',
    massKg: 1, temperatureC: 20 },
]);
const consumption = PhysicalConsumption.initialize(inventory, ['hub:1'], [{
  agentId: 2,
  config: { capacityKg: 0.5, thirstReliefPerKg: 0.5 },
  physiology: createBiologicalState({
    hunger: 0.3, thirst: 0.75, fatigue: 0.4, condition: 0.8,
  }),
}]);
const receipt = consumption.drink({
  kind: 'drink', materialId: 'water', phase: 'liquid',
  agentId: 2, sourceOwnerId: 'hub:1',
  expectedInventoryRevision: inventory.revision, sequence: 1, massKg: 0.25,
});
const body = consumption.getBody(2);
const retainedKg = consumption.reservoirMassKg(2); // 0.25
```

The example uses explicit synthetic parameters and samples. Drinking splits
sample 1 into its 0.75 kg remainder (ID 1) and a new 0.25 kg sample (ID 2)
owned by body-water:2, both liquid at 20 C. The source loses exactly the
transferred kg; the reservoir gains them. The inventory revision advances
from 0 to 1, thirst drops from .75 to .625, and hunger, fatigue and condition
are unchanged. This is not a measured safe dose or physiological response.

- initialize is a trusted one-time bootstrap on a PhysicalInventory.
  Source IDs and body IDs must be unique and canonical; configuration and
  physiology are detached/frozen. Existing body-water holdings are checked
  for water identity, liquid phase, valid mass and capacity.
- getBody returns a frozen individual record including the lastSequence cursor
  and derived reservoir owner ID; reservoirMassKg reads actual samples.
- drink is an execution API, not a policy intention or a caller-supplied
  success flag. It accepts liquid water identity/phase, positive kg, registered
  agent and source, exact expected inventory revision, and next sequence.
- advanceIndividual delegates to advanceBiology with the caller's actual
  resolved activity and modeled duration, without touching inventory or
  resetting the replay cursor. It is optional; the controller is responsible
  for interval ordering and providing the intended biology config.
- snapshot and restore persist/validate the registry, configs, physiological
  records and last committed sequences with the matching inventory revision.

## Transaction and exactly-once contract

Every drink is all-or-nothing (no automatic partial grant when stocks or
capacity are insufficient). Validate the request and body contents, plan in
ascending source sample ID order, take whole samples first as encountered and
split only the final partial sample. Whole transfers retain their ID; a
partial transfer keeps the original ID on the remainder and moves the new
child ID. No merging, averaging temperature, heating, phase change or chemistry
occurs. Prepare the immutable receipt and pure candidate biological successor
before mutation. Submit one revision-checked PhysicalInventory.transact batch.
Publish the candidate body state and cursor only after this succeeds, then
return the frozen success receipt. There are no callbacks, additional
validation or user-controlled operations between physical commit and publication.

Each committed receipt is identified within the inventory lifecycle by
(agentId, sequence), with the resulting inventory revision also recorded.
Sequence must equal lastSequence + 1, starting at 1. A duplicate or older
sequence is rejected even with an updated expected inventory revision,
including after biological time progression and snapshot restoration.
Skipped sequences and stale inventory revisions are rejected. A failed
operation does not consume the sequence, allocate a durable ID, advance
revision, transfer water or grant relief; the caller may retry that same
sequence with corrected inputs. The controller must preserve the original
sequence on retry; assigning a new sequence represents a new physical drink.
Different individuals have independent cursors. No receipt-application API
is exposed; receipts are audit records of already applied physiological
effects, not vouchers. Never pass their relief into applyConsumptionOutcome
again. Every newly committed drink must move new actual mass.

The receipt includes material/phase, mass, original and transferred sample
IDs and kg for each movement, source/reservoir owner, new revision, agent,
sequence, mapped relief and actual relief, resulting physiology and reservoir
mass after commit. The inventory still owns the actual samples, not the receipt.
It need not retain every receipt to prevent replay; state is O(individuals)
plus the supplied source registry, not O(drinks). Sample fragmentation can
grow with successful splits.

One live consumption authority per inventory object is guarded by a WeakSet.
The adapter owns its physiological records for this independent scenario; do
not maintain a second writable physiology store or directly modify body-water
holdings through other inventory operations. The latter could bypass capacity
and registration; the World controller must restrict authorization. Registry
membership is supplied by the privileged caller, not a global entity registry
or a proof that all other inventory owners are live. This is synchronous
in-process publication, not database crash recovery or hostile-code isolation.
Out-of-memory/process failure, fabricated snapshots, calling the raw biological
API elsewhere, or restoring two copies as if they were one world are outside
the guarantee.

Persist the inventory and consumption snapshots together at a quiescent
logical boundary (plus the logical time/biology config if time advances).
Restore the inventory first, then PhysicalConsumption.restore with its
matching consumption snapshot. It checks version, exact revision, source
registry, body owner derivation, configuration, physiology, unique body
identity and nonnegative safe cursors whose sum cannot exceed the inventory
revision. Reservoir holdings are revalidated. This is structural validation
of trusted paired saves, not authentication of every prior receipt; revision
alone cannot detect substitution of another world's equally revised inventory.
Do not reinitialize a saved body to reset its cursor. Replays starting from
the same paired snapshot and input sequence yield the same receipts and
complete next paired snapshot.

## Numerical decisions

To make capacity and mass movement exact at the adapter boundary, use the
same binary quantum as current physical World calibration: 1/1024 kg
(0.9765625 g). Capacity, requested masses and selected/retained water samples
must be nonnegative safe integer multiples of this quantum, with samples
and requests strictly positive. The adapter accepts up to MAX_SAFE_INTEGER
quanta, an arithmetic boundary, not a claim of plausible body sizes. Zero
capacity is allowed. Off-grid masses (including nominal decimal 0.1 kg)
are rejected rather than rounded or topped up. An unrelated material or
unselected source sample need not be on the grid. The existing inventory
still accepts general validated physical quantities; this is a deliberately
narrow scenario-level restriction, not a new global material law.
Future finer mass resolution requires an explicit calibration or robust
general numeric strategy; do not silently round existing holdings.

Capacity is checked by subtracting exact safe integer quanta, avoiding
a lost positive operand at extreme scales. No epsilon grants. Relief rate
must be finite and nonnegative; capacity times rate must remain finite,
and a positive mapping that underflows to zero is rejected. Actual relief
is computed from the actual successor score (may round to zero); normalized
scores and energy remain IEEE-754 doubles. Split/transfer delegates to
inventory's mass-resolution and modeled sensible-energy conservation checks.
Mass/ownership are exact in supported grid scenarios; sensible energy
preservation is within existing floating-point model tolerances. The
thermal reference is constant cp times absolute temperature; it is not total
internal, chemical or metabolic energy. No biological heating is modeled.
A split can be rejected even after a valid plan, e.g. exhausted allocation
cursor or unrepresentable sensible-energy calculations. No global precision,
unbounded capacity, or performance claim is made.

## Reproducible scenarios

Run npm test (or compile with tsc -p tsconfig.sim.json and run
node --test tests/physical-consumption.test.mjs). Tests cover:

| Scenario | Expected outcome |
|---|---|
| 1 kg at hub, drink .25 kg, capacity .5 kg, coefficient .5/kg | .75 kg source, .25 kg retained; .125 relief |
| .25 kg source, request .5 kg | rejected, no state or inventory change |
| .25 kg already retained, capacity .5 kg, drink .25 kg | fills exactly; further positive drink rejected |
| .25 and 1 kg samples, exhausted ID cursor, request .5 kg | whole transfer stages, final split fails; complete rollback |
| Duplicate sequence, stale inventory revision or future sequence | rejected without new relief or transfer |
| Two individuals with different parameters | isolated states, owners and cursors |
| Snapshot after first drink, restore, continue | identical receipts and serialized paired state |
| 32 drinks per individual, two 1 kg sources at different temperatures | 64 commits, both reservoirs 1 kg, all 2 kg water retained; 65 total live samples including unrelated wood |

Tests compare per-material kg and modeled sensible energy before/after,
whole/partial sample IDs and temperatures, exact capacity and numerical
boundaries, runtime validation, receipt handling and rollback. Extended
scenario is deterministic, not a claim about real hydration.

## Future feeding and metabolism (not implemented)

FeedingRequest defines the future request shape (kind feed, stable foodProfileId,
source owner, massKg, revision, agent and sequence). No executable feeding
resolver or food profile is provided. drink rejects any kind other than drink,
any material other than water and any phase other than liquid. Existing wood,
charcoal, ash and stone are not treated as food. A material being combustible
does not establish nutritional suitability, and liquid identity does not
establish safe drinking temperature or potability.

Future feeding must identify validated nutritional materials and edible
fractions for the species, moisture, carbohydrates, lipids, proteins, minerals,
fiber and other relevant components; elemental composition (including H/N
and other elements), digestibility, absorption, nutrient requirements and
dose/availability restrictions; temperature, phase and toxicity data as needed.
Use documented reference data or explicitly calibrated approximations. Distinguish
gross chemical energy, metabolizable energy and physiological relief. Model
ingested matter, digestive compartments, body stores, actual reactants including
finite oxygen if needed, balanced transformations and waste outputs. Chemical
formation enthalpy and sensible heat require compatible reference conventions;
do not infer nutrient energy from wood fuel flags or abstract needs. Do not
invent oxygen or body composition, delete waste, or replenish water to sustain
the model. The retained-water reservoir is a temporary mass-accounting
abstraction and eventually fills; it is not hydration physiology or a prediction
of the amount a human can drink.

## Required World integration changes

1. Register stable body-water owners as live entity-owned reservoirs, including
   empty ones; adapt physical owner audits, rendering and snapshot schema.
   Authorize only actual potable water samples and accessible sources; water
   terrain remains distinct. Use one PhysicalInventory and no hidden sources.
2. Establish one authority for per-agent physiology/cursor and shared modeled
   tick duration. Integrate the consumption executor with resolved outcomes,
   stable agent ordering, source accessibility and permissions, exactly-once
   sequence assignment and commit-before-event ordering. Do not apply receipt
   relief a second time in World. Persist paired state at a quiescent boundary.
3. Expose only own needs and observed/remembered water opportunities to agents;
   let motivation arbitration compare drinking feasibility and action cost
   without omniscient owner scans. A rejected drink gives no relief.
4. Prevent out-of-band reservoir mutation and ensure entity removal or future
   transfer of body matter preserves ownership and all tracked mass. Decide
   finer resolution and sample consolidation explicitly, with identity rules.
5. Extend reliability audits to body owners and water samples; monitor finite
   supplies, saturation, fragmentation, replay and deterministic snapshots.
   Before digestion or waste, add identity-aware atomic transformation support
   with balanced per-element and energy accounting in cooperation with
   Chemistry & Materials, Physics and World Systems. No total mass/energy
   conservation claim for unmodeled physiology.

No changes to running World, existing inventory internals or other specialist
branches. No external or real-time dependencies.
