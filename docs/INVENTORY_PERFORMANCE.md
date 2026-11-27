# Physical inventory profiling and indexing

## Reproduce

On Node 22.12+, run `npm ci`, `npm test` (includes the benchmark and all
regression tests), or compile with `npx tsc -p tsconfig.sim.json` then run
`node scripts/benchmark-inventory.mjs` alone. For a controlled comparison,
run that same script at baseline commit 78cf1507 and optimized commit
718fa136 in fresh processes on the same otherwise-idle machine. Both commits
contain the identical benchmark script. Timing is diagnostic, not a test
threshold. The baseline PR checkout included combined main ccecae38 and
both PRs #14 and #15; no Developer 15 branch dependency.

Actual CI measurements (Linux x64, Node v22.23.5):
- Baseline: https://github.com/botsie02-lgtm/gaia/actions/runs/45942404389
  (154/154 tests; production source unchanged from main).
- Optimized: https://github.com/botsie02-lgtm/gaia/actions/runs/45942539375
  (157/157 tests; build passed).
- One warmup and three measured repetitions per workload, reported as separate
  medians. These are shared CI runners, not a controlled same-host experiment.
  Concurrent tests, JIT, CPU scheduling and GC can affect results.
  Timing and process heap are outside simulation state.

Synthetic inventories contain 100, 1,000 or 10,000 samples, two samples
initially at the source, an empty destination, and the remainder distributed
over 64 other owners. 2,000 alternating owner lookups, 1,000 unit projections,
and 200 alternating transfers of 2 kg are performed per run. Transfers include
whole and partial movements. Every workload starts from a fresh inventory.
The benchmark wraps transact on that instance only to time commit calls;
nonCommitMs is total transfer time minus time inside transact, including
validation, planning, timer/wrapper and receipt overhead. It is not a pure
planner CPU profile. Medians of components need not sum to the total.

### Synthetic median elapsed ms (baseline -> indexed)

| Samples | Lookup | Unit projection | Transfer end-to-end | Inside transact | Outside transact |
|---:|---:|---:|---:|---:|---:|
| 100 | 5.038 -> 0.762 | 32.379 -> 33.419 | 7.580 -> 7.630 | 0.911 -> 1.047 | 6.256 -> 5.902 |
| 1,000 | 18.201 -> 0.432 | 29.573 -> 23.034 | 12.994 -> 6.313 | 0.596 -> 1.148 | 12.398 -> 5.165 |
| 10,000 | 108.742 -> 0.444 | 79.422 -> 22.817 | 46.946 -> 5.012 | 0.345 -> 0.400 | 46.600 -> 4.619 |

At 10,000 samples these observed medians are about 245x, 3.48x and 9.37x
faster for lookup, projection and full transfer respectively. This deliberately
sparse owner workload favors an index; it does not represent all distributions.
The small-inventory projection and transfer did not improve, and timed
transact calls cost somewhat more. No attempt was made to weaken transaction
validation, cache projections or replace the existing owner registry validation.

### Physical World: median time for 200 ticks (ms)

Default calibration, 14 agents, unchanged policy and resource mode physical.
World creation, snapshot serialization, checks and hashing are outside timed ticks.

| Seed | Policy | Baseline | Indexed | Initial -> final samples |
|---:|---|---:|---:|---:|
| 42 | legacy | 752.25 | 503.96 | 135 -> 316 |
| 42 | knowledge | 1582.32 | 1767.89 | 135 -> 318 |
| 12345 | legacy | 494.29 | 307.76 | 135 -> 338 |
| 12345 | knowledge | 1044.90 | 1040.07 | 135 -> 342 |
| 2026 | legacy | 498.50 | 313.33 | 135 -> 347 |
| 2026 | knowledge | 1031.81 | 1034.58 | 135 -> 342 |

Legacy scenarios showed lower observed medians, while knowledge scenarios were
mixed (seed 42 slower). This is not evidence of a universal world speedup;
perception, memory, routing, owner-list validation and scheduling remain potential
costs. No browser benchmark or scalability guarantee is provided.

### Deterministic equivalence

All nine complete SHA-256 deterministic digests in GAIA_INVENTORY_BENCH
matched across the two runs; all six physical world inventory digests also
matched. Each repetition matched its warmup within each version. Digest input
is JSON of the complete world snapshot string, or JSON of receipts and final
inventory for synthetic runs; full hashes are in the CI logs above. The
following prefixes identify each matching comparison (not truncated hashes
used for verification):

| Scenario | Digest prefix | Inventory digest prefix (world only) |
|---|---|---|
| synthetic 100 | 0b652b0b1c035e7a | — |
| synthetic 1,000 | 7ceb4bbd36ffffb5 | — |
| synthetic 10,000 | 7680477f090a81f7 | — |
| 42 legacy | 6f53792a916463e4 | 20fa1e7bffe6ba3c |
| 42 knowledge | 4aace775e5d0d5b7 | f872ea600d03c94f |
| 12345 legacy | b48e75f3f858ee6e | 9bf9d57f3c916ea4 |
| 12345 knowledge | a8d86752cf391474 | 38b9232ce3886c68 |
| 2026 legacy | 5350e4431618b4e6 | 38dd1801cce6d9f3 |
| 2026 knowledge | dbb595599fa1de67 | 9a243020e2c308ce |

Hashes are baseline evidence for this optimization, not permanent golden
world hashes: a future intentional policy change may legitimately change them.
The harness verifies mass (per material for worlds), sensible energy within
1e-12 relative tolerance, and repeatability. Existing pair conservation and
numerical checks are unchanged.

## Complexity and memory

The authoritative map contains frozen physical records. A private
Map<OwnerId, Set<SampleId>> stores membership only, rebuilt on initialization
and restore. The final staged records update registry and membership in one
synchronous publication phase, after all validation and receipt construction.
A sample created and retired in one transaction never enters the index; moving
several times publishes only its final owner. Empty buckets are removed. No
material totals or thermal state are duplicated. Sorted numeric IDs preserve
original owner-query ordering and transfer choices.

For N live samples, k samples at the queried owner, and U nonempty owners:
- Owner lookup: O(N + k log k) -> O(k log k), expected O(1) for empty
  owners; O(k) temporary array space instead of O(N) scan allocation.
- Cursor access in planning: O(N log N) snapshot -> O(1) getter.
- Transaction staging: still O(touched IDs + operations), with expected
  constant map/set work per changed ID on publication. Snapshot version 1
  unchanged; snapshots still sort all samples. Restoration builds membership
  in expected O(N) time.
- Additional retained memory: O(N + U), one ID membership per live sample
  plus one Set per nonempty owner and Map entries. No tombstones or unbounded
  cache. V8 byte overhead varies by engine and owner distribution.

External process heap before/after the complete benchmark was 6,059,528 /
13,582,952 bytes (baseline) and 6,043,448 / 32,311,664 bytes (indexed).
These are post-run observations of the whole benchmark process, including
transient allocations and GC state, not peak heap or isolated retained index
bytes. Do not attribute their difference to the index. A dedicated repeated
fresh-process retained-heap study with controlled GC and owner distributions
is future work.

## Fragmentation and safe consolidation

Synthetic inventories gained exactly three samples each; the six worlds grew
from 135 to 316–347 samples over 200 ticks, about 2.34–2.57 times initial count.
A large hub bucket can still be expensive to sort/scan; the benchmark's sparse
source does not test worst-case bucket skew. Profile dense hubs, registry
validation, calibration conversion and longer horizons before further changes.
Owner membership does not suppress fragmentation.

No automatic combine is introduced. Future consolidation should be an explicit
deterministic transaction under the world controller, limited initially to
same owner/material/phase, exactly equal temperature and compatible provenance
or reservations. Reuse combine and existing numerical checks; even then,
combining retires IDs, allocates a new ID, and can alter future transfer
ordering. Establish rules for historical references, active reservations,
identity-sensitive consumers and event publication before changing that
behavior. Thermally different samples require explicit modeled equilibration
or deliberate validated physical mixing, not an indexing shortcut. Do not
silently average temperatures, discard mass, or erase samples to cap storage.
