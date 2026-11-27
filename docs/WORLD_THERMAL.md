# World thermal contacts

Opt in with createWorld(seed, { resourceMode: 'physical', thermal: true }) or
pass a partial thermal configuration: tickDurationSeconds (default 1),
conductanceWPerK (100), maxContactsPerTick (8, allowed 1–256),
eventThresholdJ (1). These are explicit scenario parameters, not measured
properties. Disabled by default; legacy resources reject enabled thermal mode.
Browser checkbox regenerates the world; inspector temperatures and simulation
configuration are read-only. Browser playback speed does not change modeled time.

After agent actions and construction, registered hub and structure holdings at
valid land positions each form a separate contact group. Sorted sample IDs form
a ring, with a single edge for two samples. No contact between different owners,
even on the same tile, or with deposits, cargo, air or ground. This deliberately
coarse rule is not geometry. Each edge's anchor ID is unique; the cursor resumes
at the next greater ID, wraps, and advances for no-ops and rejected transactions.
At most the configured budget of distinct edges is attempted per tick. For a
static graph all edges are visited within ceil(edge count / budget) ticks.
Changing membership changes the graph; no arbitrary-churn latency guarantee.
Discovery uses indexed owner queries and sorts O(N log N) across stored samples,
with O(N) scratch space, no all-pairs calculation. Budget bounds solver calls,
not discovery. The cursor and config are included in enabled World snapshots.

Each pair is isolated for its modeled tick duration, with sequential ordering.
Later pairs see earlier committed temperatures; skipped pairs are not credited
elapsed time or accumulated energy. Thus this is an operator-split, sparse,
budget-dependent approximation, not a simultaneous coupled solver. Inventory
heat transactions preserve IDs, ownership, mass, materials and phase, with
existing pair conservation checks (16 machine epsilons of energy scale and
subnormal floor); no external energy or fuel consumption. Global floating-point
error can accumulate. Constant bulk specific heats, no phase changes, no
radiation, ambient reservoir, contact geometry, combustion or chemistry.
RangeError rejections leave that pair unchanged; other unexpected errors
propagate. At most one thermal.contact event per tick contains significant
committed pair exchanges (signed nominal joules, before/after Celsius, sample
IDs, container entity ID and committed revision). Small exchanges still occur
but are not logged. History retention remains bounded.

Reproduce with npm test, npm run typecheck, npm run build. The thermal test
prints GAIA_THERMAL_TRACE and GAIA_THERMAL_BENCH. Benchmark runs 100 ticks on
seed 42 with both policies and thermal off/on, one warmup and three measured
alternating repetitions, reporting median elapsed milliseconds. World creation
and energy checks are outside timed ticks; shared CI runner timing and concurrent
tests can introduce noise. No timing threshold or scalability claim.
