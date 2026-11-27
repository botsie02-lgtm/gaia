# Headless simulation diagnostics

Compile using the existing test command (npm test), or npx tsc -p tsconfig.sim.json.
Run node scripts/benchmark.mjs for the fixed matrix, or pass one JSON configuration
as the sole command argument (e.g. '{"seed":42,"ticks":200,"agentMode":"knowledge","perceptionRange":2,"memoryCapacity":32}').
The deterministic version-1 report contains resolved outcomes and per-agent evidence.
Benchmark elapsed time and post-run process heap are external, nondeterministic and
include observer overhead; heap is neither peak nor isolated simulation allocation.

## Contract

runDiagnostics creates a fresh seeded World, optionally retains the first 1–14
generated agents at initialization, then steps it exactly once per tick. Policies
never receive diagnostic state. comparePolicies creates independent worlds with
the same seed and configuration. Defaults: legacy, 14 agents, range 6, memory
512, ledger capacity 1. The small ledger is intentional: metrics are accumulated
from cargo transitions, skill records, positions and construction counters, not
retained event logs. Counts are prototype units, not kilograms. The observer
assumes the current World rule of at most one resolved action per agent tick;
harvest increases cargo and delivery decreases it. This assumption must be
revisited if later worlds introduce mixed actions or cargo consumption.

Each agent tick is classified as move, harvest, deliver, rest (pre-tick rest
state or energy <=12) or idle (none of the preceding). An idle outcome can be
a rejected intention, not necessarily an explicit policy idle. Legacy decisions
are not exposed; intention/observation-specific metrics are null, not zero.
Knowledge intentions count requested action kinds; rejected counts requests
without the matching resolved outcome. A move with an Explore intention counts
as an exploration move, not all movement.

Visited coverage includes starting positions and successful movement endpoints;
observed coverage includes recorded pre-action terrain (even water), never
omniscient terrain or memory. Revisit means a move to any previously visited
tile for that agent; backtrack means reversal of the previous successful move,
even after stationary ticks. Neither proves a pathological loop: normal hauling
also revisits and reverses. Stationary streaks include work and rest; idle streaks
exclude those. Memory occupancy is post-tick mean/peak/final, and final entry
statuses separate current, stale and absent evidence. ObservedDepositTicks is
the sum of deposit sightings per tick, not unique deposits or memory entries.
No fresh perception or memory ingestion is performed by diagnostics.

Diagnostic storage is O(agent count * grid tiles) for coverage, plus fixed
counters per agent; no per-tick trace or event archive is retained. Runtime is
additional work proportional to recorded visible tiles and agent count per tick.
The report is JSON-compatible, without wall-clock values, and deterministic
for identical configuration and code. Report storage is O(agent count).
Current fixed population/geometry does not establish large-world scalability.

## Baseline matrix

Seeds 42, 12345, 2026; 200 ticks; 14 agents; legacy defaults plus knowledge
(range, capacity) pairs (0,512), (2,32), (2,512), (6,32), (6,512).
The test suite prints GAIA_BASELINE JSON rows for every scenario. The following values are from the actual verification run at d80acf8:
https://github.com/botsie02-lgtm/gaia/actions/runs/45941891198.
Wood/stone columns are prototype units; dash is not applicable or no construction.
Peak is maximum occupancy of any single agent.

| Seed | Mode | Range/capacity | Harvest W/S | Deliver W/S | First build tick | XP | Visited | Observed | Moves | Revisits | Backtracks | Idle agent-ticks | Peak |
|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 42 | legacy | 6/512 | 127/99 | 123/87 | 16 | 452 | 401 | — | 2168 | 700 | 63 | 0 | 0 |
| 42 | knowledge | 0/512 | 0/0 | 0/0 | — | 0 | 14 | 14 | 0 | 0 | 0 | 2800 | 2 |
| 42 | knowledge | 2/32 | 36/6 | 0/0 | — | 84 | 196 | 460 | 2419 | 1136 | 0 | 3 | 32 |
| 42 | knowledge | 2/512 | 117/42 | 96/36 | 55 | 318 | 366 | 661 | 2247 | 917 | 59 | 8 | 494 |
| 42 | knowledge | 6/32 | 39/30 | 18/9 | 20 | 138 | 212 | 935 | 2379 | 1671 | 1649 | 7 | 32 |
| 42 | knowledge | 6/512 | 129/95 | 120/81 | 20 | 448 | 385 | 1247 | 2158 | 976 | 81 | 15 | 512 |
| 12345 | legacy | 6/512 | 139/111 | 120/102 | 18 | 500 | 333 | — | 2140 | 898 | 63 | 0 | 0 |
| 12345 | knowledge | 0/512 | 0/0 | 0/0 | — | 0 | 14 | 14 | 0 | 0 | 0 | 2800 | 2 |
| 12345 | knowledge | 2/32 | 39/3 | 0/0 | — | 84 | 255 | 617 | 2404 | 1192 | 0 | 17 | 32 |
| 12345 | knowledge | 2/512 | 146/61 | 134/51 | 45 | 414 | 239 | 429 | 2154 | 1136 | 79 | 32 | 295 |
| 12345 | knowledge | 6/32 | 39/27 | 18/6 | — | 132 | 293 | 947 | 2384 | 1797 | 1775 | 6 | 32 |
| 12345 | knowledge | 6/512 | 141/109 | 132/100 | 18 | 500 | 326 | 1026 | 2127 | 1037 | 76 | 9 | 512 |
| 2026 | legacy | 6/512 | 146/105 | 126/102 | 30 | 502 | 319 | — | 2137 | 767 | 85 | 0 | 0 |
| 2026 | knowledge | 0/512 | 0/0 | 0/0 | — | 0 | 14 | 14 | 0 | 0 | 0 | 2800 | 2 |
| 2026 | knowledge | 2/32 | 36/6 | 0/0 | — | 84 | 200 | 509 | 2418 | 1077 | 0 | 4 | 32 |
| 2026 | knowledge | 2/512 | 134/52 | 119/40 | 42 | 372 | 382 | 756 | 2209 | 905 | 60 | 8 | 512 |
| 2026 | knowledge | 6/32 | 63/29 | 33/17 | 16 | 184 | 254 | 978 | 2344 | 1523 | 1456 | 10 | 32 |
| 2026 | knowledge | 6/512 | 151/96 | 135/86 | 26 | 494 | 350 | 1057 | 2125 | 992 | 92 | 17 | 512 |

## Findings and recommendations

- Legacy delivered 660 units total; default knowledge (6/512) delivered 654
  (99.1% of legacy) and built on all three seeds. This is a narrow behavioural
  baseline, not evidence of general intelligence or larger-world scalability.
- Range zero produced 2,800 idle agent-ticks and zero gathering on every seed.
  No useful terrain can be discovered without a visible adjacent tile.
- Range 2/capacity 32 harvested exactly 42 units on every seed but delivered
  zero. Cargo saturation across 14 agents and no return route are consistent
  with hub/route retention problems; the aggregate alone does not prove why.
  Retain hub evidence and connected route corridors preferentially, then test
  hub rediscovery and successful delivery under constrained capacity.
- Range 6/capacity 32 produced 1,456–1,775 backtracks in 2,344–2,384 moves
  per scenario, versus 76–92 at capacity 512. One seed never built a hearth.
  Since the 85-tile unobstructed interior range-6 footprint already exceeds
  capacity 32 before entities, evidence eviction can erase frontiers between
  steps. Investigate frontier persistence, visit penalties and explicit
  progress checks; preserve deterministic tie breaks. Revisit counts alone
  are not proof of a loop because successful hauling repeats routes.
- Range 2/capacity 512 built on every seed but took 42–55 ticks vs 18–26
  at 6/512. Test a wider seed/horizon sweep and separate exploration moves
  from hauling reversals. Track cargo-full duration and hub reachability
  before changing rules. Add targeted regression fixtures for observed loops.
- At 6/512, observed coverage reached 1,026–1,247 tiles but agents retained
  at most 512 total entries each (including entities). Coverage must not be
  mistaken for retained usable terrain or complete connected routes.
- The first CI matrix test took 3,853 ms for 3,600 world ticks (50,400
  agent-ticks), including the observer, test/logging overhead and concurrent
  CI work. The full Node test run took 5,255 ms. These are single-run
  measurements, not steady-state throughput or a memory benchmark.
  Instrument sensing, memory update/sorting, BFS and resource scans separately;
  these are code-inspection candidates, not profiled hotspots. Prioritize
  spatial indexing, compact terrain storage and route caching only after
  profiling. Compare fixed-seed outcomes before and after optimizations.
  Larger population/grid benchmarks require explicit supported scenario
  generation; this harness only retains subsets of the fixed 14 agents.

The optional benchmark runner reports wall-clock time and post-run heap outside
simulation logic. Use repeated fresh processes and warmups for comparisons;
post-run heap includes other allocations and is not peak heap or memory growth.
The test matrix also logs external elapsed time separately from the JSON metrics.

