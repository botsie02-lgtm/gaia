# Long-duration knowledge navigation recovery — Sprint 002

## Baseline and evidence
Main d8ae44a, PRs #20–23 merged, CI 45947092419 (239 tests). Diagnostic-only
commit 304d9fe, CI 45947437698 (241 tests), reproduced the QA rows before
production changes. Seed 7, physical resources, 3 agents, 1000 ticks, range 2,
capacity 32: 81 delivered, 401 last harvest, 435 last delivery, 565 longest
delivery gap, 685 remaining, 2029 revisits / 2418 moves. Thermal on/off agreed.
Seed 12345, physical thermal on, 14 agents, 200 ticks, same range/capacity:
110 delivered, longest full-cargo run 196.

After tick 435 on seed 7 the three agents (136,137,138) made 469 exploration
moves each, of which 444/466/463 revisited positions; only 54/2/3 newly observed
tiles respectively. All 565 ticks had no local deposit sightings and only
unreachable positive remembered deposits. Known home disconnected for
565/526/529 ticks. Final positions repeatedly traversed x48–51/y31–32.
This distinguishes exploration cycles from legitimate hauling; neither
revisits alone nor an unreachable memory implies global absence. Individual
seed 12345 baseline cargo-stall cause was not traced to the same depth.

## Implementation
For navigation retention only, range 1–2 and capacity >=16 (World already
selects navigation only for capacity <=64), use regional search pressure.
A fixed array of min(capacity,64) saturated 0–255 counters hashes four-tile
regions. At each changed actual observed self position (and first observation),
increment unique visible-region buckets once, plus two at the self region.
Halve at each crossed 256-tick epoch, bounded to eight shifts. Stationary
observations do not inflate pressure. Hash collisions are possible and may
discourage genuinely unfamiliar areas; no counter proves sight, absence,
passability or discovery. The counters are additional explicitly bounded
metadata, not extra exact terrain/entity records. Serialized snapshots remain
version 1 with optional searchPressure and at most one searchOrigin flag.
The first own observed tile is retained within the entry budget while no
non-absent hub is known. A previously forgotten origin cannot be reconstructed
from hidden state. Snapshot restoration validates the added metadata.

Compute connectivity on candidate terrain from the observer; disconnected
home prefixes use at most 25% instead of 75% of capacity, with home identity
still retained. Prefer reachable positive deposits for the dedicated deposit
allowance; ordinary filler retention may still keep other entries. Current
observations override old evidence exactly as before. All movement still
uses BFS over known passable terrain. Frontier ranking uses estimated regional
pressure, recent visits and route distance; for loaded agents with remembered
hub, also homeward distance; for loaded agents without a known hub, bias
toward the genuinely observed initial reference area rather than invent
a hub location. Unloaded search weakly discourages excessive distance from
a known hub. There is no persistent exact target or full visited map:
pressure is approximate evidence that a forgotten area may have been searched,
not a distinction between certainly unseen/seen. No new action types or
intention vocabulary. No World, model, UI, motivation, diagnostics or CI
changes. Existing observation and action interfaces remain unchanged.

First candidate 8e4201d (CI 45947641569) improved deliveries but increased
seed 7 maximum full-cargo duration to 993; agent 136 had no known hub even at
tick 1000. The search-origin revision 330c980 (CI 45947801241) improves
this to 86 ticks; seed 12345 200-tick run to 54. We did not retain the
first candidate as the final rule.

## Measured results
The unchanged matrix and independent recovery diagnostics in CI 45947801241
(241 tests and build) measured the revised production code. The later tests
do not alter simulation rules. Counts are prototype units; observed/visited
coverage is external diagnostic union across agents, not available to policy.
Arrows mean baseline -> revised. All long rows have three agents and 1000
ticks, physical resources, range 2/capacity 32, thermal off except where noted.

|Seed|Delivered|Last harvest/delivery|Max gap|Max full|Full ticks|Idle|Visited|Observed|Build|
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
|7 (off/on identical)|81->201|401/435->993/994|565->113|35->86|431->1083|2->0|151->349|425->644|55->42|
|42|91->190|639/670->970/995|330->55|51->105|619->1018|4->1|269->398|565->714|216->82|
|12345|119->194|901/932->1000/993|97->45|49->157|869->1019|5->0|225->381|489->681|253->73|
|2026|119->194|919/961->995/965|85->62|43->78|850->1005|6->1|276->364|689->643|118->165|
|19|110->180|810/834->976/1000|166->63|49->157|862->960|6->1|271->386|547->685|391->40|

Peak occupancy 32 for all; mean 31.96–31.97 both versions. Seed 7 remaining
559 units, revisits 1474/2252, all three saw deposits after 435 and
home disconnected only 66/78/94 ticks in that interval. More coverage and
deliveries do not prove complete exploration or absence of loops.

Original diagnostic matrix 18 rows: 15 JSON rows identical; only three
2/32 rows changed, all 200 ticks and 14 agents, legacy resources.
|Seed|Delivered|Built|Visited|Observed|Backtracks/moves|Full agent-ticks|Idle|
|---|---:|---:|---:|---:|---|---:|---:|
|42|95->163|112->21|317->331|623->562|34/2318->85/2225|1033->771|8->4|
|12345|110->170|49->24|295->300|613->517|32/2267->50/2210|889->832|35->7|
|2026|116->177|44->50|278->310|597->575|41/2262->51/2191|1063->772|19->7|
Total delivered 321->510. All three build; 2026 construction slightly later.
Range 6/32, range 6/512, range 2/512, zero range and legacy unchanged in
the original rows. Seed 7/400/14 range 2/32: delivery 88->289, build 21->21,
visited 214->492, observed 479->794, full agent-ticks 831->1565.

QA seed 12345/200/14 physical thermal on: 110->170 delivered, longest
gap 43->14, longest full 196->54, full ticks 889->832, idle 35->7,
visited 295->300, observed 613->517, build 49->24, last delivery 199->197.

## Limits and cost
Individual full-cargo runs increased in all five 1000-tick comparisons
relative to baseline, despite greater output and less world-wide inactivity.
Some agents still end full; seed 7 delivers near end but carries six units
at final tick. Seed 2026 observed coverage and construction timing worsen.
No guarantee that a hub will be found or that all terrain will be explored;
region hash collisions, decaying pressure, topology and lost route evidence
can still trap agents. This is a scoped heuristic, not a learned or globally
complete planner. No explicit persistent exploration target; a future
feedback API could support bounded target commitment and rejection evidence.
Storage stays O(C) records plus O(min(C,64)) small scalar counters and one
per-entry flag. Connectivity search and counter updates use O(C+V) temporary
space; retention sort remains O((C+V) log(C+V)). Frontier ranking has additional
constant-sized score work per candidate. No isolated wall-clock/heap
benchmark, no browser testing. Existing physical audits remain unchanged.

Reproduce with npm test (including independent tests/navigation-recovery*
and unchanged matrix). CI logs contain GAIA_RECOVERY and GAIA_RECOVERY_TRACE.
