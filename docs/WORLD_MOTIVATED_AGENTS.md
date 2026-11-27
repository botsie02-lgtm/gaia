# Motivated agents in World (Sprint 002)

```ts
createWorld(42, {
  agentMode: 'motivated', biology: true, resourceMode: 'physical',
  thermal: true, tickDurationSeconds: 300,
  motivations: { maxCommitmentTicks: 6 },
});
```

WorldAgentMode extends the standalone AgentMode with motivated. Explicit
biology (true or a valid WorldBiologyOptions object) is required; omission
or false is rejected. Both knowledge and motivated use the same bounded
perception, observation timing and memory retention (navigation retention
at capacity <=64). No omniscient mode can be combined with motivations.
Legacy and ordinary knowledge behavior/snapshots retain existing fields
and rules. Optional motivations overrides are allowed only in motivated
mode and validated, detached and frozen by createMotivationConfig. See
MOTIVATED_AGENTS.md for all defaults, scoring and commitment rules;
WORLD_BIOLOGY.md for timing, biological state and exertion coefficients.

At creation every motivated agent receives its own frozen version-1 GoalState
(observerId, lastTick=0, goal=null, sinceTick=0). At each logical tick, before
any action executes, observe each agent, update its memory once, and invoke
decideMotivatedAgent with only that observation, its memory snapshot, detached
own energy/rest/cargo, its own biology, shared public geometry/cargo limit,
biology/motivation tuning and previous GoalState. Persist nextState once.
The latest pre-action evidence (desiredGoal, selectedGoal, reason, five
evaluations) is held separately from the ordinary Decision and lastOutcome.
The only authoritative commitment is goalState. Evidence includes opportunity,
feasibility, urgency, immediate costs, uncertainty, score and local target.
The goal is not a promise of successful execution, and the latest ranking
is not recalculated with post-action biology. No feedback or global history
enters the pure engine. Execute requests by stable agent ID and advance
biology once via completeAgentTick, including idle/rejected actions.

Voluntary rest is accepted only for motivated agents with biological state.
It occupies one full tick, does not move/harvest/deliver, recovers abstract
energy by 5 (cap 100), and does not set the mandatory resting latch.
The existing mandatory <=12 / resting gate runs first, continuing until
energy >=70, even when another goal has greater urgency. Motivated rest
receipts distinguish mandatory-rest and voluntary-rest, including the
last recovery tick. Ordinary policies retain the earlier rest semantics.
Biological fatigue recovery is delegated to advanceBiology for both kinds
of actual rest; hunger/thirst continue rising. Direct executor calls return
receipts but do not advance biology or goal state. They are privileged
test/controller calls, not a second policy or simulation clock.

Food/water opportunity remains unknown; no availability or coordinates are
invented. Search-only goals reuse actual known-frontier moves and may
interrupt hauling with cargo intact. No consumption actions, relief,
metabolism, death or condition-based action veto. Unmet hunger/thirst
may dominate indefinitely; blocked desires may fall back to feasible
work/rest/exploration or idle. This is an incomplete survival model,
not evidence of real-world survival or intelligent discovery.

Browser policy selector offers Motivated and explicitly enables/locks
biology while that mode is selected. On leaving, biology remains enabled
until the user changes it. Regeneration resets commitments, evidence and
biology. Inspector labels pre-action arbitration, selected and desired
goals, competing evaluations, intention, actual outcome, and post-action
physiology separately. Headless default remains legacy; browser default
remains ordinary knowledge with biology disabled.

Snapshots include the versioned per-agent goalState, latest bounded
evaluation evidence and motivationConfig only in motivated mode. Restore
goalState via restoreGoalState in a future complete World restoration;
snapshot equality is tested, full World restore remains absent.
Retained additional state is O(agent count), five evaluations and one
commitment per agent, no histories or route caches. At most two existing
knowledge-policy evaluations per tick; no runtime scalability claim.
Existing diagnostics are intentionally unchanged and currently accept
legacy/knowledge only; World integration tests print deterministic
GAIA_MOTIVATED_WORLD comparison rows. No specialist internals modified.
