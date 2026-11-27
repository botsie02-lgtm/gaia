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

Measured rows to be recorded from actual CI. No save/load claim.
