# Constrained navigation and memory retention

## Reproduced evidence and diagnosis

Combined main ccecae3 passed 153 tests and build:
https://github.com/botsie02-lgtm/gaia/actions/runs/45942182486.
Before changing rules, a separate diagnostic test on ac3e702 reproduced the
existing 18 rows and additionally measured post-tick cargo saturation and
seed 7 at 400 ticks (154 tests):
https://github.com/botsie02-lgtm/gaia/actions/runs/45942381782.

The recency eviction policy prioritizes all fresh entities and row-major
tiles, not connected routes. At range 2 and capacity 32, all 14 agents
ended with full cargo and zero delivered on every original seed. At range 6,
85 terrain tiles alone can exceed the 32-entry budget. As fresh evidence
replaces old terrain, the nearest known frontier can point back toward a
recently visited position even when the environment has not changed.
Aggregate reversals do not prove loops; these code-level mechanisms motivated
the corridor and movement-evidence fixtures and measured comparisons.

## Rules and bounds

- The rollout is deliberately limited to knowledge Worlds with memory capacity
  <=64. The optional third AgentMemory constructor argument selects navigation
  retention; direct two-argument clients retain recency semantics. The cutoff,
  75% corridor budget, one-eighth productive deposit allowance, up to eight
  recent visit entries and 12-tick exploration penalty are heuristic tuning,
  not learned parameters or universal optima.
- Candidate evidence is produced by the existing observation validation and
  contradiction/absence logic. Prefer a non-absent observed hub, own terrain,
  and a deterministic BFS corridor from that hub toward the current position
  (or its closest reachable point if disconnected). Preserve the hub-side
  prefix if the path exceeds the corridor budget. Then select nearby positive
  deposits, recent visited terrain and nearby terrain; fill remaining slots
  by canonical recency. No extra retained entries or global terrain.
- lastVisitedTick is metadata on retained terrain only, updated from actual
  own observed position. Eviction also loses visit metadata. Snapshots retain
  version 1 with optional retention discriminator and visit metadata;
  older recency snapshots restore unchanged. Full World restore remains absent.
- Current observations override remembered tiles and objects including
  visible absence. BFS never crosses unknown or water tiles. On exploration,
  rank frontiers by recent first-step penalty, proximity to a non-absent
  remembered hub when loaded, recent frontier visit penalty and shortest
  route; stable BFS ordering breaks ties. If the hub is unknown, search
  without privileged coordinates. If no frontier exists, idle/resample.
  Direct reachable gather and delivery routes bypass the visit penalty.
- Memory uses O(C) retained entries and bounded per-entry metadata; temporary
  maps, corridor BFS and sorting use O(C+V) space and O((C+V) log(C+V)) time.
  There is no additional persistent map, global route cache or hidden capacity.
  Constrained policy frontier ranking adds sorting overhead. No changes to
  physical inventory, resources, event accounting or original diagnostics.

## Measured comparison

The unchanged diagnostic harness and additional replay test both ran on
implementation commit c8bf8ac (154 passing tests):
https://github.com/botsie02-lgtm/gaia/actions/runs/45942442369.
Each arrow compares the original rule set to this implementation, 14 agents,
prototype units, legacy resource mode. Full ticks = number of post-tick
agent states with 3 cargo units; denominator is ticks*14. Full final = number
of saturated agents at the end. Coverage counts unique visited/observed tiles
across agents (not retained terrain). Peak memory is per agent.

| Seed/ticks | Range/cap | Delivered | First build tick | Reversals / moves | Full ticks | Full final | Visited | Observed | Peak |
|---|---|---|---|---|---|---|---|---|---|
|42/200|2/32|0 -> 95|- ->112|0/2419 ->34/2318|2475 ->1033|14 ->2|196 ->317|460 ->623|32|
|12345/200|2/32|0 ->110|- ->49|0/2404 ->32/2267|2549 ->889|14 ->3|255 ->295|617 ->613|32|
|2026/200|2/32|0 ->116|- ->44|0/2418 ->41/2262|2601 ->1063|14 ->5|200 ->278|509 ->597|32|
|42/200|6/32|27 ->176|20 ->20|1649/2379 ->53/2189|2518 ->1138|14 ->6|212 ->291|935 ->1033|32|
|12345/200|6/32|24 ->192|- ->18|1775/2384 ->49/2177|2560 ->1017|14 ->3|293 ->279|947 ->911|32|
|2026/200|6/32|50 ->209|16 ->16|1456/2344 ->64/2151|2402 ->1205|14 ->4|254 ->272|978 ->912|32|
|42/200|6/512|201 ->201|20 ->20|81/2158 unchanged|1235 unchanged|7 unchanged|385|1247|512|
|12345/200|6/512|232 ->232|18 ->18|76/2127 unchanged|1164 unchanged|6 unchanged|326|1026|512|
|2026/200|6/512|221 ->221|26 ->26|92/2125 unchanged|1131 unchanged|7 unchanged|350|1057|512|
|7/400|2/32|0 ->88|- ->21|0/4714 ->49/4623|5375 ->831|14 ->1|149 ->214|341 ->479|32|
|7/400|6/32|66 ->308|16 ->16|3752/4622 ->86/4313|5127 ->2053|14 ->3|241 ->398|907 ->1027|32|
|7/400|6/512|384 ->384|16 ->16|150/4206 unchanged|2340 unchanged|7 unchanged|545|1366|512|

The original 18 rows for legacy, zero range and both 512-capacity
knowledge configurations are behaviourally identical. For the three
original seeds: range 2/32 delivers 321 instead of zero; range 6/32 delivers
577 instead of 101. Each constrained configuration builds on all three seeds.
Reversals at 6/32 fall from 62.1–74.5% to about 2.3–3.0%. Range 2/32
mean occupancy remains about 31.90 entries; range 6/32 mean and peak remain
32. The original 6/512 delivery total remains 654, with 512 peak.

## Remaining limitations

- At 2/32, 321 deliveries still trail 476 at 2/512; seed 42 takes 112 ticks
  to construct. Seed 7 at 400 ticks produces only 88 deliveries at 2/32
  versus 384 at 6/512. Some agents still end saturated. A low reversal rate
  alone does not imply efficient exploration or a successful return.
- Visited/observed coverage is not uniformly higher; 6/32 seed 12345 visits
  fewer tiles (279 vs 293) and observes fewer (911 vs 947); 2026 observes
  fewer (912 vs 978). Repeated observation and forgotten corridors can
  still cause longer cycles, detours, dead ends or eventual idle. The
  heuristic cannot guarantee home discovery, particularly when no hub
  was seen, the capacity is extremely small, or the only path is blocked.
  There is no persistent exploration goal, completeness proof or map outside
  the configured budget. A disconnected remembered hub is a hint, not a
  route. Visit recency can penalize a useful exploratory detour temporarily.
- Prioritizing navigation sacrifices some entity history. Larger-memory
  behaviour is intentionally unchanged rather than a claim that the
  threshold is optimal. The CI matrix is not a controlled performance
  benchmark: no isolated timing, heap profiling or scalability conclusions.
- Test code uses only headless worlds; no manual browser testing. Physical
  mode has a separate constrained-world conservation/determinism test.
  The original diagnostic matrix remains unchanged. No dependencies or
  workflow changes; no claims of learned intelligence.
