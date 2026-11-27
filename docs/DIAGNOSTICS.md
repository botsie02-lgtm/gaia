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
The test suite prints GAIA_BASELINE JSON rows for every scenario. Results will
be recorded from the actual verification run, not inferred from intentions.
