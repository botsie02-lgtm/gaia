# Motivation-driven agent decisions (Sprint 001)

Standalone arbitration under src/sim/agents/motivations/. It does not change
World, Agent, browser, the existing knowledge policy, navigation benchmarks,
or physical systems. No dependency on another specialist's unfinished branch.
This is inspectable deterministic goal-ranking, not general intelligence,
learned planning, or actual food/water discovery.

## Public contract

```ts
import { decideMotivatedAgent } from './sim/agents/motivations/index.js';

const result = decideMotivatedAgent({
  observation,           // existing observeAgent projection
  memory,                // this observer's matching current MemorySnapshot
  own: { energy, resting, cargo },
  biology,               // existing version-1 BiologicalState
  policy: { width, height, cargoLimit },
  biologyConfig,         // optional; same as used by physiology
  previous,              // optional previous GoalState (null on first tick)
});
const actionRequest = result.decision;  // existing Decision / AgentAction
const nextCommitment = result.nextState; // save for the next logical tick
```

The return includes desiredGoal (highest raw urgency, including blocked goals),
selectedGoal (goal motivating the next request or null), reason, five
GoalEvaluation records in fixed order, Decision and nextState. Each evaluation
separates urgency, opportunity evidence, feasibility, estimatedActionCost,
uncertaintyPenalty, score, targetId (null when no target), and Decision (null if
blocked). An opportunity is evidence rather than a promise that execution will
succeed. The policy uses rankMotivations for biological urgency; it does not
copy biological formulas or update physiology.

Inputs are local: immutable projection and memory obtained from the existing
controller, detached own energy/rest/cargo, own biological state, public
geometry/capacity and configuration, and its own preceding commitment. No
World, global stockpile, event history, physical registry, RNG or hidden map.
The caller enforces provenance; this is not a security sandbox. The layer
checks observation/memory identity, tick and capacity, own scalar ranges,
geometry, config, biological state and prior state chronology. Observation
and memory entries themselves are trusted products of observeAgent and
AgentMemory; their full validation is not repeated here. Restore memory using
its existing API, not arbitrary fabricated evidence.

## Scores and feasibility

Five goals, with fixed descending-priority tie order: obtain-water,
obtain-food, rest, gather (including hauling/delivery), explore. Biological
urgencies come directly from rankMotivations, using the same biology config
as the caller. Ordinary gathering/exploration have configurable baseline
urgencies. A candidate with a next request has score = urgency minus estimated
immediate action cost minus uncertainty penalty. Blocked candidates have null
cost and score. Select highest positive feasible score, else idle. Desired goal
is independently the highest raw urgency, not necessarily the selected one.
Equal scores use the fixed order unless an eligible prior goal is retained.

| Configuration | Default |
|---|---:|
| gatherUrgency | .25 |
| exploreUrgency | .15 |
| moveCost | .04 |
| harvestCost | .03 |
| deliverCost | .01 |
| restCost | .02 |
| unknownSearchPenalty | .10 |
| rememberedPenalty | .05 |
| switchMargin | .08 |
| maxCommitmentTicks | 6 |

These are arbitrary normalized utility heuristics, not seconds, energy, damage
or success probabilities. Costs are for the immediate request only; the layer
does not estimate full route duration, biological relief or risk of death.
createMotivationConfig accepts partial overrides, validates all scores in [0,1],
and limits commitment to 1–1024 logical ticks. Configuration is detached,
canonical and frozen. Persist tuning and biology config with future saves.

- Ordinary work: call the existing decideAgent policy using unmodified local
  input. Preserve its chosen work action, including constrained navigation
  behaviour. Current positive target evidence is observed; an eligible unseen
  memory target is remembered and receives the uncertainty penalty. An absent
  or contradicted target is not available. A blocked work goal means no known
  reachable work request, not proof the universe has no resources. The adapter
  uses typed harvest/deliver IDs and the existing stable Gather/Return intention
  vocabulary to identify movement targets; unexpected work vocabulary fails
  closed. Future structured target metadata would remove this coupling.
- Exploration: reuse the existing frontier navigation if that policy already
  returns it. Otherwise evaluate a terrain-only alternative by filtering
  ordinary deposit/hub targets from the local projection and memory, retaining
  actual cargo, geometry and visit metadata. This is a planning alternative,
  not a new observation or an update to AgentMemory. A full-cargo search may
  interrupt hauling; it does not discard cargo or bypass movement rules.
  A reachable known frontier is required; unknown terrain is never assumed
  passable. The original navigation and retention rules are not modified.
- Food/water: current Observation/MemoryValue schemas have no verified food
  or potable water affordances. Opportunity is always unknown (not global
  absence), targetId is null, and consumption is never requested. A reachable
  frontier permits search-only feasibility with an explicitly unknown
  availability intention; otherwise the goal is blocked. Search uses the
  generic frontier step, not a food/water-specific map or a promise of discovery.
  Water terrain is not drinkable inventory; wood, stone, hubs and hearths
  are not nutritional evidence. No special search relief, resource creation
  or fabricated coordinates. High urgency can outrank work even when only
  exploration is possible; blocked high urgency remains visible while the
  agent selects a lower feasible goal or idles.
- Rest: self opportunity, requestable in the existing action vocabulary.
  Fatigue can outrank work even when legacy energy is high. The legacy energy
  <=12 or resting gate overrides arbitration while both systems coexist;
  ordinary work/exploration opportunities are then not-evaluated. Food/water
  remain unknown and blocked during the gate. A voluntary rest request does
  NOT yet imply actual rest in main: executeAgentAction currently returns on
  rest without recovery unless restIfNeeded already ran. World Systems must
  explicitly support voluntary rest and coordinate the two rest authorities.
  Rest does not reduce hunger or thirst and is not a substitute for consumption.

## Bounded commitment

Version-1 GoalState is five scalar fields: version, observerId, lastTick, goal
(nullable), sinceTick. It stores no coordinates, path, additional memories,
action receipts or accumulated histories. restoreGoalState validates and
detaches trusted JSON, including ownership and tick chronology; the decision
rejects previous state from another observer or a non-earlier tick. A pure
repeat with the same input is allowed, but feeding the returned state back
into the same tick is not. No clocks, random numbers or module-level mutable
state. While a selected goal remains positively feasible and its age is less
than maxCommitmentTicks, keep it if the best alternative improves score by
at most switchMargin. A larger improvement, lost feasibility, nonpositive
score or legacy rest can interrupt immediately. At expiry reconsider without
the margin; if the same goal wins, renew its start tick. The rule bounds
commitment, not the total duration of a genuinely dominant goal. It stabilizes
goal kinds, not individual route targets, and does not prove absence of loops.

## Verified examples (tests/motivations.test.mjs)

With defaults, an observed local wood deposit, reachable frontier, energy 100
and no prior commitment:

| Hunger / thirst / fatigue | Desired | Selected | Request |
|---|---|---|---|
| 0 / 0 / 0 | gather | gather | harvest (score .22) |
| .25 / .20 / .95 | rest | rest | rest (score .61175) |
| .40 / .95 / 0 | obtain-water | obtain-water | move to explore (score .7625) |
| 1 / .10 / 0 | obtain-food | obtain-food | move to explore (score .66) |
| 0 / 1 / 0, no frontier | obtain-water | gather | harvest |
| 1 / 0 / 0, no frontier or work | obtain-food | none | idle |

At fatigue .62 the rest score is .24908 vs .22 gather, an improvement of
.02908: a prior gathering commitment can continue for the configured window.
After expiry, rest wins; raising thirst to 1 immediately preempts rest.
The tests also verify stale target discounts, absence invalidation, exact
ties, JSON replay, input validation, local-only inputs under changed hidden
resources/inventory/hub coordinates, and the biology rule that confirmed rest
reduces fatigue but does not reduce hunger or thirst. These are controlled
policy fixtures, not a live integrated population benchmark.

## Recommended World Systems integration (separate PR)

1. Keep an opt-in motivated policy flag and independently versioned state per
   agent, sharing modeled seconds per tick with biology/thermal settings.
   Preserve legacy and current knowledge modes. Coordinate with Biology on
   initial state/config and with Perception & Memory on trusted projections.
2. At the existing pre-action boundary observe all agents, update each memory
   once, pass own biology/internal state and previous commitment to this pure
   policy. Persist nextState exactly once alongside that tick's intention.
   UI/diagnostics may display desired/selected goal and evidence separately.
3. Execute only result.decision.action in stable entity order. Explicitly
   resolve voluntary rest with actual duration and legacy energy semantics;
   do not confuse desired rest or requested movement with a successful outcome.
   Preserve resource conservation and existing skill practice rules. Advance
   biology exactly once from resolved activity and shared modeled duration
   (including idle/rejected actions). No relief from any policy selection.
4. Future feedback must be local and attributable to the agent's own request:
   agent ID, logical tick/request identity, actual action/status, movement
   performed, duration and exertion, optional reason locally observable.
   Keep world-global outcomes/history out of policy inputs. This module
   currently has no feedback parameter: re-evaluates from next observation,
   own state and commitment only; a later bounded feedback API can record
   rejected/stalled actions without inventing progress or knowledge.
5. Add explicit food/potable-water affordances to perception/memory only when
   validated by actual subsystems. Add balanced material/body transfers and
   confirmed consumption receipts before applying feeding/drinking relief.
   Exactly-once feedback/consumption receipt application is the executor's
   responsibility. No unsupported World actions are emitted here.
6. Extend diagnostics for desired vs executable goals, time above thresholds,
   goal switches, search success and actual rest; test cross-system replay,
   resolved outcomes and conservation. Do not change baseline benchmarks
   simply to make the new policy appear effective.

## Cost and limitations

Five fixed evaluations and O(1) retained goal state per agent; at most two
existing knowledge-policy calls per evaluation, each with known-terrain BFS,
local scans and candidate sorting. Terrain-only alternative adds an O(C)
temporary filter, C = retained memory entries. No extra persistent map.
Time/heap not independently profiled. High unsupported food/water urgency
may dominate searches indefinitely, or agents may idle/work when no frontier
exists. No guarantee of return, successful search, relief or survival.
No learned action costs, goal decomposition, planning beyond existing local
navigation, hunger/thirst consumption, death or condition-based action veto.
No per-agent LLMs, dependencies, World modifications or changes to the
original diagnostic matrix.
