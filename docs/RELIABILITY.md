# Cross-system reliability baseline

Pre-biological and pre-chemical integration. World resource mode physical,
thermal optional. No production simulation changes. Use npm ci and
npx tsc -p tsconfig.sim.json, then node scripts/benchmark-reliability.mjs
for the short matrix or node scripts/benchmark-reliability.mjs --extended.
Pass a JSON configuration for a single scenario. npm test runs regression
checks. Benchmark timings and process memory readings are outside World;
heap before/after and RSS after include observer, GC and runtime allocations,
not isolated or peak memory. No timing threshold.

The existing diagnostics now accept World physical/thermal options and return
an additive physical audit report (null in legacy mode), cargo saturation
and resource exhaustion counters. runDiagnosticSession also returns the full
World snapshot string for byte equality/reproducibility; this is not restoration.
Retained population is a prefix of the generated empty-cargo population,
not arbitrary population scaling. No observations are fabricated.

The audit samples tick zero and each completed tick. It reconstructs per-material
mass and owner sums from inventory snapshots, checks exact binary-calibrated
mass conservation, stable unique IDs, cursor and revision monotonicity, absence
of retired IDs (current split-only World), owner registration, indexed views,
derived resource projections, positive finite valid samples and bounded
temperatures. Audit uses a compensated sum of mass*catalog cp*(C+273.15).
Global sensible energy error >1e-12 times initial energy is classified as
a conservation discrepancy; smaller errors are reported as numerical drift
consistent with the model, not proof of exact conservation. No per-material
energy conservation is expected with thermal exchange. Current tracked matter
is wood/stone only. No combustion, phase change, metabolic reservoirs or
chemistry. Energy is modeled sensible heat, not total physical energy.
A temperature change count tracks existing sample IDs at tick boundaries,
not number of contact calls. Ownership changes count surviving IDs, not transfers
via newly allocated IDs. The audit records failure counts and first ticks
without storing the entire history; memory O(live samples + owners + grid*agents).
It cannot observe transient within-tick violations or authenticate receipts.
Zero ledger retention is not supported; default capacity one demonstrates
independence from complete history.

Full cargo ticks count post-tick saturated agent states; max run is consecutive
saturation for any agent. Idle excludes rest and actions; max no-delivery run
is world ticks with no delivery, including initial/trailing intervals. Last
harvest/delivery null means no success. Remaining deposit units are finite
authoritative projections, not an assertion of reachability.

## Measured baseline (2026-11-27)

Base 515d9f3 (190 tests passing, combined main CI [45946117588](https://github.com/botsie02-lgtm/gaia/actions/runs/45946117588)).
Audit implementation 29e3f20 measured the complete matrix in
[push CI 45946607718](https://github.com/botsie02-lgtm/gaia/actions/runs/45946607718) and
[PR CI 45946621254](https://github.com/botsie02-lgtm/gaia/actions/runs/45946621254):
197/197 tests in each including the one-time extended capture, zero failures
or skips and successful TypeScript/Vite builds. Extended capture is removed from
default CI after measurement; the benchmark remains runnable independently.
All eight deterministic GAIA_RELIABILITY rows were identical across both
runs, including hashes of complete final World snapshots. 8,800 world ticks
per matrix (8,808 sampled boundaries), not 8,800 distinct scenarios.
Exact snapshot-string equality is separately asserted in a 100-tick fixture.
This verifies reproduction, not save/load.

Row keys are seed/ticks/agents/thermal. Knowledge defaults are range 6,
capacity 512; seed 7 and 12345 use range 2/capacity 32, zero-sight seed 42
uses range 0, and seed 2026 uses legacy policy. Seed 2026/200 uses 0.5/1.25
kg per wood/stone unit, starting at 90/10 C respectively. Other scenarios
use World defaults. All physical runs use event capacity 1.

### Conservation and fragmentation

| Scenario | Wood kg | Stone kg | Total kg | Initial J | Max global error J | Max step error J | Audit tolerance J | Samples initial/final | Hub samples final | Max temperature shift C |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 7/1000/3/off | 1028 | 756 | 1784 | 684403646 | 0 | 0 | 0.000684403646 | 135 → 200 | 69 | 0.000 |
| 7/1000/3/on | 1028 | 756 | 1784 | 684403646 | 0 | 0 | 0.000684403646 | 135 → 200 | 69 | 4.258 |
| 2026/5000/1/on | 954 | 801 | 1755 | 657769108.5 | 0 | 0 | 0.0006577691085 | 135 → 435 | 342 | 4.557 |
| 42/1000/14/on | 954 | 726 | 1680 | 640696221 | 0 | 0 | 0.0006406962209999999 | 135 → 135 | 0 | 0.000 |
| 42/200/14/off | 954 | 726 | 1680 | 640696221 | 0 | 0 | 0.0006406962209999999 | 135 → 318 | 189 | 0.000 |
| 42/200/14/on | 954 | 726 | 1680 | 640696221 | 0 | 0 | 0.0006406962209999999 | 135 → 318 | 189 | 2.390 |
| 12345/200/14/on | 942 | 762 | 1704 | 642910947 | 0 | 0 | 0.000642910947 | 135 → 233 | 98 | 3.465 |
| 2026/200/14/on | 238.5 | 333.75 | 572.25 | 221895204.375 | 0 | 0 | 0.000221895204375 | 135 → 347 | 216 | 60.564 |

Every row had zero maximum per-material mass error, zero signed final energy
error, and zero mass, energy, owner, projection, index, identity, sample and
temperature failures. Final and peak sample counts were identical in all rows.
Zero energy discrepancy means zero at the precision of the compensated
aggregate, not proof that local rounding is absent. Thermal-on samples did
change temperature (except the no-action zero-sight scenario). No mass was
created by sample allocation. The 5,000-tick run grew 135→435 samples
(3.22×); 342 live samples belonged to the hub. Split-only identity assumptions
must be revisited when explicit sample consolidation is implemented.

### Behaviour

Units are prototype resource units, not kilograms. Full ticks count agent-ticks,
max full is the longest consecutive run for one agent, idle counts resolved
idle agent-ticks, revisits count successful moves to previously visited tiles,
not proven loops. Remaining W/S refers to unharvested deposits.

| Scenario | Harvest | Delivery | First hearth | Full ticks | Max full | Final full agents | Idle | Max idle | Revisits/moves | Deposits left | W/S left | Last harvest/delivery | Max no delivery |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 7/1000/3/off | 81 | 81 | 55 | 431 | 35 | 0 | 2 | 1 | 2029/2418 | 119 | 464/221 | 401/435 | 565 |
| 7/1000/3/on | 81 | 81 | 55 | 431 | 35 | 0 | 2 | 1 | 2029/2418 | 119 | 464/221 | 401/435 | 565 |
| 2026/5000/1/on | 357 | 354 | 103 | 2287 | 36 | 1 | 0 | 0 | 3254/3721 | 78 | 129/258 | 4980/4951 | 69 |
| 42/1000/14/on | 0 | 0 | — | 0 | 0 | 0 | 14000 | 1000 | 0/0 | 135 | 477/242 | —/— | 1000 |
| 42/200/14/off | 224 | 201 | 20 | 1235 | 40 | 7 | 15 | 1 | 976/2158 | 94 | 348/147 | 200/200 | 14 |
| 42/200/14/on | 224 | 201 | 20 | 1235 | 40 | 7 | 15 | 1 | 976/2158 | 94 | 348/147 | 200/200 | 14 |
| 12345/200/14/on | 119 | 110 | 49 | 889 | 196 | 3 | 35 | 1 | 852/2267 | 114 | 393/213 | 188/199 | 43 |
| 2026/200/14/on | 251 | 228 | 30 | 1259 | 35 | 7 | 0 | 0 | 767/2137 | 96 | 331/162 | 199/198 | 20 |

- Seed 7/1000 (both thermal modes) stopped harvesting at tick 401 and
  delivering at 435; no deliveries for the final 565 ticks while 119 deposits
  and 685 units remain. Only two idle agent-ticks, with 2,029 revisits among
  2,418 moves (83.9%). This is a productive-progress failure, not evidence
  of resource exhaustion or proof of a specific navigation loop. Diagnose
  knowledge retention and exploration state before changing policy.
- Seed 12345/200 (2/32) reached a 196-tick consecutive full-cargo interval;
  three agents remained full. Seed 42/200 default still had seven full
  at the final tick, but its longest full interval was 40 ticks.
- Zero perception yields 14,000 idle agent-ticks and no harvest/delivery,
  as expected from the information boundary. Thermal has no contacts here.
- Seed 2026/5000 (one legacy agent) was still gathering/delivering near
  the end (last harvest 4980, last delivery 4951); neither material was
  exhausted. Long-run finite-stock behaviour remains unverified beyond
  these horizons.
- Thermal-off/on pairs for seeds 42 and 7 have identical observed behaviour,
  ownership changes, fragmentation and material balances; thermal changes
  energy distribution and inventory revision counts, not these outcomes.
  The 100-tick regression also compares final physical samples excluding
  temperature, and compares complete deterministic reports for repeat runs.

### External performance indicators

Node v22.23.5. A/B are the two independent CI runs above.
Elapsed ms includes World generation, diagnostics and final serialization,
not a bare simulation tick benchmark. Heap values are MiB before→after and
RSS is MiB after; no explicit GC or isolated/peak memory measurement.

| Seed/ticks/thermal | Elapsed ms A/B | Heap A MiB | Heap B MiB | RSS A/B MiB |
|---|---:|---:|---:|---:|
| 7/1000/off | 1222 / 1969 | 5.92 → 14.89 | 5.90 → 14.58 | 78.93 / 81.94 |
| 7/1000/on | 1281 / 1481 | 14.93 → 18.26 | 14.62 → 15.49 | 99.09 / 101.59 |
| 2026/5000/on | 4487 / 5883 | 18.27 → 26.30 | 15.49 → 22.17 | 102.54 / 104.45 |
| 42/1000/on | 1012 / 2005 | 26.31 → 27.82 | 22.17 → 23.32 | 103.77 / 107.01 |
| 42/200/off | 1178 / 2433 | 5.97 → 30.83 | 5.95 → 9.33 | 102.43 / 105.79 |
| 42/200/on | 1023 / 2154 | 30.88 → 18.54 | 9.39 → 17.51 | 118.20 / 122.04 |
| 12345/200/on | 500 / 977 | 18.55 → 21.93 | 17.52 → 20.61 | 123.79 / 128.72 |
| 2026/200/on | 368 / 941 | 21.93 → 19.45 | 20.61 → 17.84 | 120.67 / 129.59 |

Timing variance, JIT, allocation and concurrent tests prohibit an isolated
thermal-overhead conclusion. Use fresh-process repeated trials and separate
observer profiling for Performance. This is not evidence for arbitrary
population/terrain scalability. The 5,000-tick workload uses one agent.

### Complete snapshot digests

- 7/1000/3/off: `98381a434b076f6b66658701e695d4b41e9fbc17e0f5c46bc1d39b4355e1e3f7`
- 7/1000/3/on: `f941dba42429b0a99198f2662ae524760629619f886110ee8adbad66aba5a43d`
- 2026/5000/1/on: `e2c9775f533719c2a174f74a5cfe57ef809a7eadbc8a889bca05f5dabba368cd`
- 42/1000/14/on: `d2420f85e712d64b910a5b5affb237e44f680e653409f830b3ea524c085f8995`
- 42/200/14/off: `fcb5ef813eaf8a5cdcb4362034998d907215d91cf42e66d3ef4870239cf5d0f4`
- 42/200/14/on: `149e83d7fe13b9bfbd2f99c5cefd3612c0dc5edc3d7473716faa718516ff2571`
- 12345/200/14/on: `8697007d453101cae3d50694ec165260b14d7a81791009f6274e4593e353dcf0`
- 2026/200/14/on: `af864be9d29d1c083481e4cc7146edd48c1b7145ea091172888ed438a06942ae`

### Reproduction and next actions

```sh
npm ci
npm test
npx tsc -p tsconfig.sim.json
node scripts/benchmark-reliability.mjs
node scripts/benchmark-reliability.mjs --extended
node scripts/benchmark-reliability.mjs '{"seed":7,"ticks":1000,"agentCount":3,"agentMode":"knowledge","perceptionRange":2,"memoryCapacity":32,"resourceMode":"physical","thermal":true}'
```

1. Navigation/Intelligence: independently investigate seed 7; add a bounded
   no-progress watchdog metric and objective acceptance (deliveries resume
   with knowledge-limited targets, no omniscient world access). Investigate
   long full-cargo intervals in seed 12345. Keep reproduction tests, not
   assertions requiring the faulty outcome to persist.
2. Performance/Physics: evaluate deterministic sample consolidation with
   explicit identity retirement/lineage and conservation rules; measure
   owner-size/contact budgets, heap and runtime separately. No production
   consolidation in this audit.
3. World Systems/Biology/Chemistry: extend invariant accounting before
   integrating metabolic or reaction transformations. Include per-element
   mass/chemical energy and external exchanges explicitly; do not apply
   fixed-material and isolated sensible-energy assertions unchanged to
   systems that legitimately transform matter or exchange energy.
4. QA: increase seeds and horizons, include full-population 5,000-tick
   runs in opt-in suites, record first failure ticks and eventual resource
   exhaustion; implement full-world restoration tests only after restoration
   exists.

No production changes; no full save/load or future cross-system guarantee.
