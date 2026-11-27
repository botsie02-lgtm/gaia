/** Independent, abstract physiology. No World, inventory, clock or RNG access. */
export interface BiologicalState {
  readonly version: 1;
  /** 0 = satisfied/rested, 1 = maximum unmet need. */
  readonly hunger: number;
  readonly thirst: number;
  readonly fatigue: number;
  /** 1 = best condition, 0 = worst modeled condition (not death). */
  readonly condition: number;
}

export type Need = 'hunger' | 'thirst' | 'fatigue';
export type MotivationKind = 'drink' | 'feed' | 'rest';
export interface NeedRule {
  readonly threshold: number;
  /** Maximum coefficient in condition score per modeled hour. */
  readonly damagePerHour: number;
  readonly urgencyWeight: number;
}

export interface BiologyConfig {
  readonly hungerPerHour: number;
  readonly thirstPerHour: number;
  readonly awakeFatiguePerHour: number;
  readonly exertionFatiguePerHour: number;
  readonly restRecoveryPerHour: number;
  readonly hunger: NeedRule;
  readonly thirst: NeedRule;
  readonly fatigue: NeedRule;
}

export type ActivityOutcome =
  | { readonly kind: 'idle'; readonly status: 'succeeded' | 'failed' }
  | { readonly kind: 'rest'; readonly status: 'succeeded' | 'failed' }
  | { readonly kind: 'exertion'; readonly status: 'succeeded' | 'failed'; readonly intensity: number };

export interface ConsumptionOutcome {
  readonly kind: 'drink' | 'feed';
  readonly status: 'succeeded' | 'failed';
  /** Confirmed need-score relief, not kg, joules, calories or liters. */
  readonly relief: number;
}

export interface Motivation {
  readonly kind: MotivationKind;
  readonly urgency: number;
}

export const DEFAULT_BIOLOGY: BiologyConfig = Object.freeze({
  hungerPerHour: 0.04,
  thirstPerHour: 0.08,
  awakeFatiguePerHour: 0.06,
  exertionFatiguePerHour: 0.12,
  restRecoveryPerHour: 0.2,
  hunger: Object.freeze({ threshold: 0.7, damagePerHour: 0.04, urgencyWeight: 0.8 }),
  thirst: Object.freeze({ threshold: 0.65, damagePerHour: 0.12, urgencyWeight: 1 }),
  fatigue: Object.freeze({ threshold: 0.8, damagePerHour: 0.03, urgencyWeight: 0.7 }),
});

const NEEDS: readonly Need[] = Object.freeze(['hunger', 'thirst', 'fatigue']);
function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(label + ' must be an object');
  }
}
function unit(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(label + ' must be finite and in [0, 1]');
  }
}
function duration(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Duration must be finite nonnegative modeled seconds');
  }
}
function status(value: unknown): void {
  if (value !== 'succeeded' && value !== 'failed') {
    throw new TypeError('A resolved outcome status is required');
  }
}
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/** Validate and detach a serializable configuration; coefficients are bounded [0,1]. */
export function createBiologyConfig(config: BiologyConfig = DEFAULT_BIOLOGY): BiologyConfig {
  object(config, 'Biology config');
  const { hungerPerHour, thirstPerHour, awakeFatiguePerHour,
    exertionFatiguePerHour, restRecoveryPerHour } = config;
  unit(hungerPerHour, 'hungerPerHour');
  unit(thirstPerHour, 'thirstPerHour');
  unit(awakeFatiguePerHour, 'awakeFatiguePerHour');
  unit(exertionFatiguePerHour, 'exertionFatiguePerHour');
  unit(restRecoveryPerHour, 'restRecoveryPerHour');
  const copyRule = (need: Need): NeedRule => {
    const rule = config[need];
    object(rule, need);
    const { threshold, damagePerHour, urgencyWeight } = rule;
    unit(threshold, need + ' threshold');
    unit(damagePerHour, need + ' damagePerHour');
    unit(urgencyWeight, need + ' urgencyWeight');
    return Object.freeze({ threshold, damagePerHour, urgencyWeight });
  };
  return Object.freeze({ hungerPerHour, thirstPerHour, awakeFatiguePerHour,
    exertionFatiguePerHour, restRecoveryPerHour,
    hunger: copyRule('hunger'), thirst: copyRule('thirst'), fatigue: copyRule('fatigue') });
}

/** Accept an untrusted JSON-shaped snapshot; copy only known scalar fields. */
export function restoreBiologicalState(snapshot: unknown): BiologicalState {
  object(snapshot, 'Biological state');
  if (snapshot.version !== 1) throw new TypeError('Unsupported biology snapshot version');
  const { hunger, thirst, fatigue, condition } = snapshot;
  unit(hunger, 'hunger');
  unit(thirst, 'thirst');
  unit(fatigue, 'fatigue');
  unit(condition, 'condition');
  return Object.freeze({ version: 1, hunger, thirst, fatigue, condition });
}

export function createBiologicalState(initial: Omit<BiologicalState, 'version'> = {
  hunger: 0, thirst: 0, fatigue: 0, condition: 1,
}): BiologicalState {
  object(initial, 'Initial biological state');
  return restoreBiologicalState({ ...initial, version: 1 });
}

/** Mean positive threshold excess along a linear, then clamped trajectory.
 * Uses fractions of the interval rather than large time integrals.
 */
function meanExcess(start: number, end: number, delta: number, threshold: number): number {
  if (delta === 0 || start === end) return Math.max(0, start - threshold);
  const linearFraction = clamp(Math.abs((end - start) / delta));
  const a = start - threshold;
  const b = end - threshold;
  let linearMean = 0;
  if (a >= 0 && b >= 0) linearMean = (a + b) / 2;
  else if (a > 0 || b > 0) {
    const positive = Math.max(a, b);
    linearMean = (positive / Math.abs(b - a)) * positive / 2;
  }
  return linearFraction * linearMean + (1 - linearFraction) * Math.max(0, b);
}

/** Advance one interval using its actually resolved activity.
 * Failed rest/exertion receives awake baseline only. A caller may report
 * actual effort as successful exertion even when the associated task failed.
 */
export function advanceBiology(
  state: BiologicalState, durationSeconds: number, activity: ActivityOutcome,
  config: BiologyConfig = DEFAULT_BIOLOGY,
): BiologicalState {
  const prior = restoreBiologicalState(state);
  const rules = createBiologyConfig(config);
  duration(durationSeconds);
  object(activity, 'Activity outcome');
  status(activity.status);
  let fatigueRate = rules.awakeFatiguePerHour;
  switch (activity.kind) {
    case 'idle': break;
    case 'rest':
      if (activity.status === 'succeeded') fatigueRate = -rules.restRecoveryPerHour;
      break;
    case 'exertion':
      unit(activity.intensity, 'Exertion intensity');
      if (activity.status === 'succeeded') {
        fatigueRate += rules.exertionFatiguePerHour * activity.intensity;
      }
      break;
    default: throw new TypeError('Unknown activity kind');
  }
  const hours = durationSeconds / 3600;
  const changes: Record<Need, number> = {
    hunger: hours * rules.hungerPerHour,
    thirst: hours * rules.thirstPerHour,
    fatigue: hours * fatigueRate,
  };
  const next = { ...prior };
  let damage = 0;
  for (const need of NEEDS) {
    const delta = changes[need];
    const end = clamp(prior[need] + delta);
    next[need] = end;
    damage += hours * rules[need].damagePerHour *
      meanExcess(prior[need], end, delta, rules[need].threshold);
  }
  next.condition = clamp(prior.condition - damage);
  return Object.freeze(next);
}

/** Apply one trusted consumption receipt at an interval boundary.
 * Failed consumption must report zero relief. No material is consumed here.
 * The caller is responsible for exactly-once application.
 */
export function applyConsumptionOutcome(
  state: BiologicalState, outcome: ConsumptionOutcome,
): BiologicalState {
  const prior = restoreBiologicalState(state);
  object(outcome, 'Consumption outcome');
  status(outcome.status);
  unit(outcome.relief, 'Consumption relief');
  if (outcome.kind !== 'drink' && outcome.kind !== 'feed') {
    throw new TypeError('Unknown consumption kind');
  }
  if (outcome.status === 'failed') {
    if (outcome.relief !== 0) throw new RangeError('Failed consumption cannot report relief');
    return prior;
  }
  const need = outcome.kind === 'drink' ? 'thirst' : 'hunger';
  return Object.freeze({ ...prior, [need]: clamp(prior[need] - outcome.relief) });
}

/** Pure ranking, descending urgency; ties drink, feed, rest in that order.
 * This is not a decision or knowledge of food/water availability.
 */
export function rankMotivations(
  state: BiologicalState, config: BiologyConfig = DEFAULT_BIOLOGY,
): readonly Motivation[] {
  const prior = restoreBiologicalState(state);
  const rules = createBiologyConfig(config);
  const score = (kind: MotivationKind, need: Need): Motivation => Object.freeze({
    kind, urgency: prior[need] * prior[need] * rules[need].urgencyWeight,
  });
  // ES2022 stable sort preserves the explicitly specified tie order.
  return Object.freeze([
    score('drink', 'thirst'), score('feed', 'hunger'), score('rest', 'fatigue'),
  ].sort((a, b) => b.urgency - a.urgency));
}
