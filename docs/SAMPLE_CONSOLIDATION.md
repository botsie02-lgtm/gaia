# Explicit conservative sample consolidation

This headless layer is not called by World, policies, biology, diagnostics or
rendering. It does not change the existing PhysicalInventory or resource action
implementations or version-1 snapshot schema.

## API and authority

```ts
import { consolidateSamples } from '../src/sim/inventory/consolidation/index.js';
const receipt = consolidateSamples(inventory, inventory.revision, {
  ownerId: hubOwnerId,
  maxPairs: 64,
  excludedSampleIds: protectedLiveIds,
});
```

Only the privileged controller can decide which owner is registered and safe
to compact. Explicitly supply the union of **all** active reservations,
pending sample-specific actions, process inputs, contact references and
other protected live IDs, including provenance-sensitive samples.
An empty list certifies no such restrictions for the request. The subsystem
does not discover reservations, prove authority, or infer that a same-owner
sample is physically co-located with another. Unknown, retired, duplicate
or invalid excluded IDs fail closed; exclusions may include other owners.
An empty or nonexistent owner returns a no-op; owner registration is caller
responsibility.

Only identical owner, material, supported phase and exact stored Celsius
temperature qualify. There is no epsilon temperature grouping, averaging of
distinct temperatures, chemical transformation or phase change. The existing
material equilibrium routine returns the original temperature on exact equality.

Ascending numeric owner sample IDs are scanned, skipping exclusions.
For each material/phase/temperature group, pair the next eligible ID with
its earliest unmatched member; order pairs by their second ID. Stop after
maxPairs (integer 1–256). Pairs are disjoint; new outputs cannot be inputs
again in the same request. A caller can explicitly request further batches
with the new revision and a freshly verified protection list.

All pairs execute as one existing revision-checked combine transaction.
A numerical failure in any pair aborts the whole request (no silent skipping);
stale revision, invalid input, ID or revision exhaustion also fail without
publishing any changes. A successful nonempty batch increments revision
once. No eligible pairs returns a frozen empty receipt and consumes no
revision or allocation IDs. The existing pair mass, energy, representability
and overflow validation remains the authority; no alternate solver.
Mass and sensible energy are conserved within the existing IEEE-754
pair tolerances, not exact decimal or arbitrary-scale thermodynamics.
Same-temperature combining cannot erase a thermal gradient between the
two input samples, but can change subsequent contact topology.

Each immutable receipt contains ownerId, previousRevision, revision,
retiredIds, createdIds and lineage, in operation order. Each lineage entry
contains both source IDs/masses, result ID/mass, owner, material, phase and
temperature. New IDs are predicted from the existing allocation cursor and
match the combine transaction's monotonic allocation contract. Old IDs
never recur; saved inventory still carries the cursor. No lineage is stored
by the subsystem. Bounded receipts can be attached to a future event at
the committed logical tick; full historical lineage needs separately managed
retention, not an unbounded in-memory lookup.

For k samples at an owner and E exclusions, discovery costs O(k log k + E)
including the indexed sorted owner view and expected O(k + E) scratch
space. Up to B=min(maxPairs,floor(k/2)) combines, O(B) staged changes and
receipt entries; the cap bounds mutations and receipt size, not discovery
or caller exclusion-list size. Repeated batches take new sorted views.
One compatible group can shrink to a single sample across multiple calls,
but groups with all distinct temperatures cannot shrink. A failed pair may
require an explicit revised request/exclusion policy rather than retrying
the same failing batch indefinitely.

## Integration safeguards (not implemented)

* Quiescent controller phase: stop new reservations, finish or cancel
  pending actions, derive a fresh complete exclusion set, validate revision,
  then commit a bounded batch. Do not give agents registry access.
* Coordinate receipt publication with the World event ledger and dependent
  references. Historical IDs remain historical, not live handles. Do not
  silently alias retired IDs to a successor, especially across later splits.
  Preserve provenance by excluding identity-sensitive matter. Coordinate
  reservations/chemistry/consumption with the relevant subsystem specialists.
* Resource actions choose ascending live sample IDs. Combining IDs 1 and 2
  at 20 C into ID 4 while ID 3 remains at 80 C can change the next withdrawal
  from 20 C to 80 C, even with identical total and per-material mass/energy.
  This is tested, not an equivalence guarantee. A future controller needs
  explicit material selection/provenance policy and acceptance tests.
* Current thermal scheduler constructs sorted-ID rings for hubs/structures,
  a single edge when two samples remain. The same example changes edges
  (1,2),(2,3),(3,1) into (3,4); the next anchor after cursor 1 changes
  from 2 to 3. A stale cursor is a numeric ordering boundary, not a live
  sample lookup, but contact budget, capacity, visit order and exchange
  change. Rebuild topology from live IDs at a defined boundary, never
  execute an old cached edge against retired IDs, define cursor continuation
  or reset policy explicitly, and measure thermal trajectories/conservation.
  Prefer initially eligible non-contacting storage, not active thermal rings.
  A physical geometry or effective conductance model is future work.
* QA split-only audit must be extended before World integration:
  remove the live-count+1 cursor equality and the requirement that every
  previous live ID persists, but keep strictly increasing allocation
  cursor, no reuse (new IDs >= previous cursor), uniqueness, registration,
  indexed view checks, surviving identity and mass/phase/temperature rules.
  Require committed retirement/creation receipts and reconcile
  liveCountDelta = splitCount - combineCount, cursorDelta =
  splitCount + combineCount for these operations, plus revision accounting
  that recognizes one revision per batch. Verify two distinct live sources,
  one fresh result, exact compatibility, unchanged exclusions, matching
  owner and source/result mass/energy, no missing/phantom retirements;
  process receipts in operation order for within-tick creations/retirements.
  Use a bounded direct audit stream at commit (not only the bounded
  event ledger or tick boundary snapshots); old snapshots alone cannot
  authenticate transient IDs or lineage. Distinguish legitimate transformations
  in future chemistry/biology, with separate element/energy budgets.
  Do not change the existing split-only audit while consolidation is offline.

## Reproducible measurements

Run `npm ci`, `npm test`, or compile with `npx tsc -p tsconfig.sim.json`
and run `node scripts/benchmark-consolidation.mjs`. The benchmark generates
a physical World, runs fixed ticks with event capacity 1, retains the
requested prefix of initially empty-cargo agents and then operates only on
detached inventory restores. It never continues the World after consolidation.

Baseline-only commit 238d996 verified combined main d8ae44a with 240 tests
passing and successful build:
https://github.com/botsie02-lgtm/gaia/actions/runs/45947450522 .
All three QA counts reproduced:

| Seed/ticks/agents/thermal | Initial | Final | Hub | World elapsed ms (single baseline run) |
|---|---:|---:|---:|---:|
| 2026/5000/1/on | 135 | 435 | 342 | 2528.32 |
| 42/200/14/off | 135 | 318 | 189 | 1592.17 |
| 42/200/14/on | 135 | 318 | 189 | 1632.93 |

Seed 2026 uses legacy; seed 42 uses default knowledge. Default calibration.
The benchmark invokes 64-pair batches until no compatible disjoint pairs
remain, on a hub-only detached inventory. It uses one warmup and three
measured repetitions of consolidation and 2,000 hub owner queries plus
200 alternating 8 kg wood transfers (hub/temporary recipient). The same
request sequence is used for before and after, but operation counts and IDs
may differ due to changed sample granularity/order. The recipient is an
explicitly registered synthetic benchmark owner, not a World entity.
Each repetition restores the starting snapshot; timed lookups and transfers
exclude restore, accounting checks and World simulation. Medians are external
wall-clock observations; concurrent CI, JIT and GC influence measurements.
The benchmark verifies deterministic compacted snapshots, exact calibrated
per-material masses, modeled sensible energy within 1e-12 relative, hub
material mass and cursor/revision changes. No timing assertions, exact
behavioural equivalence, retained-memory measurement or scalability claim.

### Measured results

Implementation/benchmark commit 3dbc026: 247/247 tests passed and production
build succeeded in https://github.com/botsie02-lgtm/gaia/actions/runs/45947629875 .
All elapsed times below are medians of three measured repetitions after warmup
on the same CI job; ms, not simulation time.

| Seed/ticks/thermal | Total samples before -> after | Hub before -> after | Pairs / batches | Consolidation ms | Lookup ms before -> after | Transfer ms before -> after |
|---|---:|---:|---:|---:|---:|---:|
| 2026/5000/on | 435 -> 435 | 342 -> 342 | 0 / 0 | 0.444 | 26.496 -> 26.714 | 6.714 -> 6.394 |
| 42/200/off | 318 -> 131 | 189 -> 2 | 187 / 8 | 1.291 | 14.900 -> 0.519 | 7.372 -> 5.676 |
| 42/200/on | 318 -> 314 | 189 -> 185 | 4 / 2 | 0.436 | 14.484 -> 14.497 | 6.926 -> 6.552 |

All three cases conserved per-material mass exactly at this calibration.
Naively summed sensible energy differences (after minus before) were
0, 0 and +1.1920928955078125e-7 J respectively, within the model tolerance
and attributable to floating-point summation/rounding. All three compacted
snapshots reproduced exactly across repetitions. The thermal-disabled
hub shrank 98.94%, total inventory 58.81%; lookup median was about 28.7x
faster and full transfer workload about 1.30x faster. The 200 transfers
required 800 -> 228 split/transfer operations in that case and grew the
compacted hub from 2 to 30 live samples, showing renewed fragmentation.
The two thermal-enabled scenarios both required 800 -> 800 operations.
The 200-tick thermal-enabled hub shrank only 2.12%, total 1.26%;
lookup showed no improvement. The 5000-tick thermal-enabled hub had no
compatible pairs. Timing differences on these unchanged or near-unchanged
workloads are not evidence of a meaningful gain.

This is a conservative identity-changing storage optimization, not a
solution to fragmentation in an actively heated hub. Do not widen the
temperature matching criterion to manufacture a speedup. Physical mixing
or improved thermal/spatial representations require separately justified
models and specialist review. No World continuation or timing equivalence
after compaction is claimed.
