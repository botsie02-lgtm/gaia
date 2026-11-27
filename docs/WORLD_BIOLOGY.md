# World biological integration

Biology is opt-in in both headless and browser worlds. Example:

```ts
createWorld(42, {
  agentMode: 'knowledge', resourceMode: 'physical', thermal: true,
  tickDurationSeconds: 60,
  biology: { exertion: { move: 0.5, harvest: 1, deliver: 0.25 } },
});
```

## Configuration and timing

World.tickDurationSeconds is the single authoritative modeled interval, default
1 second (the existing thermal default). An explicit thermal.tickDurationSeconds
is accepted as a backward-compatible source if World duration is omitted.
When both are explicitly provided they must agree, even with biology disabled.
Enabled thermal config is created with the resolved World duration; it is a
read-only projection required by the existing solver API. No clock/FPS
participates. The legacy energy, movement, gathering and hearth rules remain
per logical tick, not per modeled second. Accelerated times are diagnostic
scenarios, not physically calibrated walking speeds or fuel rates.

Biology true uses DEFAULT_BIOLOGY; an object may supply a full biology config,
initial hunger/thirst/fatigue/condition scores (default 0/0/0/1), and partial
exertion mapping. The mapping defaults to move .5, harvest 1, deliver .25;
each is a finite [0,1] scenario coefficient, not measured physical work.
All physiology rates, thresholds and urgency weights are documented in
BIOLOGY.md and validated by its API. World retains a detached frozen config,
and each agent owns a distinct frozen biological state. Faction does not
change physiology. No migration from abstract energy to fatigue is attempted.

## Resolved action boundary

executeAgentAction returns a frozen ResolvedAction receipt:
tick, agentId, requested (move/harvest/deliver/rest/idle), kind (actual action
or rejected), status (succeeded/failed), and an optional reason. A mandatory
rest can resolve a non-rest request as successful rest; a rest request without
the existing rest gate is rejected. Failed physical transactions, unavailable
targets, invalid movement and full cargo are not exertion. Direct calls execute
actions but do not advance modeled time or publish the latest tick receipt.
Legacy privileged policy uses the same action helpers and returns receipts.

stepWorld forms all knowledge decisions before execution as previously, then
resolves exactly one outcome per agent. Each completed agent tick stores the
latest receipt and, if enabled, invokes advanceBiology exactly once for the
full interval. A confirmed move/harvest/delivery maps to exertion at configured
intensity; confirmed rest maps to recovery; idle or rejected actions map to
awake baseline. No actual partial effort on a rejected task is modeled.
Rest remains confirmed even on the final tick where abstract resting flips
false. Construction and thermal processing then proceed as before. No agent
policy is given new inputs; rankings are read-only inspector information.
The existing abstract energy/rest gate is still the only action controller:
fatigue is a separate score, not a conversion or second gate. Condition zero
does not veto actions, remove agents or kill them.

## Deprivation and presentation

No nutrition, hydration or relief is injected. No food, potable water actions,
metabolism, body inventories, thermal physiology, recovery of condition, or
death. The incomplete deprivation model cannot predict real survival times.
The browser exposes a disabled-by-default biology selector, modeled duration
selector (1/60/300/3600 seconds; larger durations are test accelerations), and
regenerates when changed. Inspector shows individual scores, actual outcomes
and ranked motivations separately from intention and abstract energy. Both
policies and both resource modes are compatible; thermal still requires physical
resources. The viewer is not agent knowledge.

Snapshots add tickDurationSeconds and lastOutcome (after a tick) in all
worlds, plus optional config and individual version-1 state when enabled.
No full World restore is implemented; future restoration must restore state
via restoreBiologicalState, validate config, retain tick and lastOutcome, and
avoid replaying completed intervals. Existing agent collections remain
controller-owned; future spawning must initialize physiology before ticking.
Storage is O(agent count), retaining one receipt and one state per agent.
Per-agent update is O(1) with validation/allocation by biology; no benchmark
claim. No changes to agent policy, biology internals, inventory, thermal solver
or diagnostics. Tests print deterministic GAIA_WORLD_BIOLOGY_TRACE and
GAIA_WORLD_BIOLOGY_RUN metrics, not estimates of real physiology.
