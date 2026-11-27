# Biological needs (v0.3 foundation)

This independent, deterministic module models individual physiological pressure,
not real physiology. It does not import World, agent policies, inventory, materials,
skills, perception, rendering, random sources or clocks. Existing agents still use
their legacy energy/resting fields. No World behavior or snapshot schema changes.

## State and parameters

Version-1 BiologicalState is a frozen JSON object: hunger, thirst and fatigue
are unmet-need scores in [0,1] (0 satisfied, 1 maximum pressure); condition is
in [0,1] (1 best, 0 worst modeled condition). Condition zero is not death and
does not prevent further actions. None is a mass, energy, measured physiological
quantity, probability of survival, or conversion from legacy energy. Each caller
owns one state per individual. Faction has no role in the rules.

Default coefficients are arbitrary scenario-tuning values, not physiological
measurements or claims about any species. Time is passed in modeled seconds,
converted to modeled hours by dividing by 3600. There is no FPS or wall-clock link.

| Parameter | Default | Units |
|---|---:|---|
| hungerPerHour | 0.04 | need score / modeled hour |
| thirstPerHour | 0.08 | need score / modeled hour |
| awakeFatiguePerHour | 0.06 | need score / modeled hour |
| exertionFatiguePerHour | 0.12 | additional fatigue score / modeled hour at full intensity |
| restRecoveryPerHour | 0.20 | fatigue score recovered / modeled hour |

| Need | Damage threshold | Damage coefficient / modeled hour | Urgency weight |
|---|---:|---:|---:|
| Hunger | 0.70 | 0.04 | 0.8 |
| Thirst | 0.65 | 0.12 | 1.0 |
| Fatigue | 0.80 | 0.03 | 0.7 |

All config scalars and activity intensity/consumption relief must be finite
numbers in [0,1]; duration must be finite and nonnegative. Zero rates, weights,
or damage coefficients are permitted. These bounds are design choices for
this foundation, not universal limits. A full custom configuration can be
created using createBiologyConfig, which validates and deep-freezes a detached
copy of all fields. Defaults are deeply frozen. Save config alongside state
to preserve reproducibility across future balance changes. Restore validates
version and all four scores; extra fields are not part of the canonical state.
Restore is validation, not authentication.

## API and ordering

- createBiologicalState(initial?) creates a healthy, satisfied individual by
  default; an explicitly supplied initial object specifies all four scores.
- restoreBiologicalState(parsedJSON) validates and returns a frozen copy.
- advanceBiology(state, durationSeconds, activity, config?) applies time once.
  Activity is an explicit outcome with kind idle, rest or exertion and status
  succeeded or failed. Exertion also specifies normalized intensity.
- applyConsumptionOutcome(state, outcome) applies confirmed drinking or feeding
  relief at a boundary, not an elapsed interval. Outcome kind is drink or feed,
  status succeeded or failed, relief is the already-resolved abstract need-score
  reduction. A failed outcome must specify zero relief.
- rankMotivations(state, config?) returns a frozen array of frozen drink, feed,
  rest urgency records in descending order; exact ties prefer drink, feed, rest.
  All three are returned, even when urgency is zero. This is not an action,
  target selection, availability check, pathfinding instruction or world query.

A policy intention does not qualify as an outcome. Missing or intended status
is rejected, as are invalid kinds, numbers, configurations or state. Failed
rest or exertion receives awake baseline only; if a failed task actually involved
physical effort, the executor should separately report its confirmed exertion
as succeeded with actual intensity. Time for a mixed interval must be partitioned
into ordered non-overlapping activities. A rest success is confirmation of
actually resting for the interval, not a request to rest. Only consumption
receipts change the relevant need downward. The module cannot independently
authenticate a receipt, deduplicate it, or validate food/water availability:
the caller owns exactly-once ordering and must commit only one successor state
per interval and apply each actual consumption receipt once. Replaying the same
input and receipts is deterministic; applying a receipt twice is not idempotent.

## Model and numerical properties

For constant activity over h modeled hours, hunger and thirst increase at their
configured rates, regardless of rest. Awake fatigue grows at its baseline rate;
successful exertion adds exertionFatiguePerHour times intensity. Successful rest
replaces awake fatigue growth with negative restRecoveryPerHour. Each trajectory
is clamped to [0,1]. Consumption subtracts only the specified relief from the
corresponding score, clamped at zero. No surplus reserve or healing is implied.

Condition decreases by the sum over needs of damagePerHour times the integral
of max(0, need(t) - threshold) over the interval in modeled hours. The solver
integrates the linear segment and its saturated tail; crossing a threshold late
in a step does not charge the whole interval. For constant activity and no
intervening consumption, subdivisions agree within floating-point tolerance.
Condition is clamped at zero and never automatically recovers, even after
drinking, feeding or rest. A future recovery model must be explicitly designed.
No death or condition-dependent action veto is implemented.

Urgency is weight times need squared: it grows monotonically for a positive
weight and gives larger marginal increases at high deprivation. Condition is
a consequence, not a fourth motive or skill multiplier. A weight of zero
disables a motive's score. No hidden knowledge, PRNG or time source is used.
All computations and allocations are O(1) per individual per update, with
ordinary IEEE-754 rounding (not exact decimal math); large finite durations
remain bounded. Subdivision may accumulate rounding error.

## Reproducible lifecycles

Run npm test; tests/biology.test.mjs checks these numeric examples and JSON replay.

```ts
import {
  createBiologicalState, advanceBiology, applyConsumptionOutcome, rankMotivations,
} from './src/sim/biology/index.js';

let s = createBiologicalState();
s = advanceBiology(s, 4 * 3600, { kind: 'exertion', status: 'succeeded', intensity: 1 });
s = advanceBiology(s, 2 * 3600, { kind: 'rest', status: 'succeeded' });
s = applyConsumptionOutcome(s, { kind: 'drink', status: 'succeeded', relief: 0.4 });
s = applyConsumptionOutcome(s, { kind: 'feed', status: 'succeeded', relief: 0.2 });
const motives = rankMotivations(s);
```

| Boundary | Hunger | Thirst | Fatigue | Condition | Top motive |
|---|---:|---:|---:|---:|---|
| Fresh | 0 | 0 | 0 | 1 | All zero (tie order drink) |
| 4h full exertion | .16 | .32 | .72 | 1 | rest |
| 2h confirmed rest | .24 | .48 | .32 | 1 | drink |
| Confirmed drink .40 | .24 | .08 | .32 | 1 | rest |
| Confirmed feed .20 | .04 | .08 | .32 | 1 | rest |

Fresh individual, idle with no consumption: at 12 hours hunger .48, thirst .96,
fatigue .72 and condition .927925; at 48 hours all needs are 1 and condition 0.
A drink and feed with relief 1 each, then five hours confirmed rest, yield
hunger .20, thirst .40, fatigue 0, condition 0. This intentionally illustrates
unmet needs causing accumulated consequences, not actual survival times.

## Recommended later World integration

1. Introduce one state per agent (any faction) behind an explicit configuration
   or mode, persist the versioned state and parameters. Use one modeled
   seconds-per-tick authority shared with other physical systems once merged;
   do not derive physiology from browser speed. Choose migration from legacy
   energy/resting explicitly. Do not let both systems independently control
   fatigue and rest. Keep existing behavior as a regression baseline.
2. At a documented logical tick boundary, provide immutable own physiology
   alongside local observations, bounded memory, and existing policy inputs.
   Use ranked motives to compare resource work, exploration, food/water
   seeking and rest; avoid privileged World access. Seek observed or remembered
   targets and known passable routes only; if unknown, explore deterministically.
   Add bounded commitment/hysteresis and feasibility so agents do not oscillate
   between motives or repeatedly attempt impossible consumption. High thirst
   could interrupt hauling; hunger could motivate discovering food; fatigue
   could make long routes less attractive. These are proposed policies, not
   behavior currently implemented.
3. The World executor validates and resolves actions, records actual duration
   and effort, then advances biology once and applies confirmed consumption
   receipts in stable order. Rejected intentions do not relieve a need. Route
   success/failure and skill practice remain independently accounted for.
   Record outcome events only after successful commits and add headless
   diagnostics for time above thresholds, relief, condition and motive changes.
4. Establish explicit food and potable water availability. The existing catalog
   has liquid water but no food composition or metabolism. Water terrain is
   not automatically a consumable material sample. Add species-specific
   nutrition/hydration mappings from actual consumption and explicitly validated
   transactions. PhysicalInventory currently preserves matter through
   transfers/splits/combinations and heat exchange; it is not a deletion API.
   Model transfer into body stores, digestion, absorption, oxygen inputs,
   metabolic energy use and heat, carbon dioxide, water and other waste outputs,
   and environmental exchange using an extended balanced process/transaction
   layer. Track body material and energy reservoirs and composition, and commit
   physical receipts, physiology, waste and energy changes atomically under
   authoritative ownership. Prevent double receipts and verify rollback and
   matter/energy balances before any conservation claim.
5. Add deterministic regression tests for identical seeds, persistence, policy
   isolation, consumption failures, resource conservation where modeled,
   all factions and diagnostics. Profile before expanding to large populations.

## Scientific and functional limits

No measured nutritional requirements, hydration volumes, calories, basal
metabolic rate, temperature effects, sleep cycles, digestion delay, homeostatic
reserve, species calibration, healing, disease, reproduction, combat or death.
The linear need rates, quadratic motives and condition damage are configurable
heuristics. They do not model biochemical pathways, predict biological outcomes,
or imply matter/energy conservation. No physical food or water is created,
deleted or transformed. No integration with existing agents or dependence on
Developer 17's branch. No dependencies added.
