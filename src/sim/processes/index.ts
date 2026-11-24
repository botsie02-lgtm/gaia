// Standalone, fixed-tick batch transformations. No material registry or world dependency.
export type Phase = 'solid' | 'liquid' | 'gas';

export interface MaterialQuantity {
  readonly materialId: string;
  readonly massKg: number;
  readonly phase: Phase;
}

export interface MaterialSample extends MaterialQuantity {
  readonly temperatureC: number;
}

export interface TransformationRule {
  readonly id: string;
  readonly inputs: readonly MaterialQuantity[];
  readonly outputs: readonly MaterialSample[];
  // Inclusive bounds on every consumed input sample; omitted means unconstrained.
  readonly minTemperatureC?: number;
  readonly maxTemperatureC?: number;
  readonly durationTicks: number;
  // External energy spent on each successful tick, not inferred from temperature.
  readonly energyPerTickJ: number;
}

export interface ProcessState {
  readonly rule: TransformationRule;
  readonly completedTicks: number;
}

export type PauseReason = 'insufficient-input' | 'temperature' | 'insufficient-energy';
export interface ProcessStep {
  readonly state: ProcessState;
  readonly samples: readonly MaterialSample[];
  readonly energyConsumedJ: number;
  readonly status: 'progressed' | 'paused' | 'completed';
  readonly pauseReason?: PauseReason;
}

function nonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(name + ' must be finite and non-negative');
}

function temperature(value: number): void {
  if (!Number.isFinite(value) || value < -273.15) throw new RangeError('invalid temperatureC');
}

function identifier(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('invalid identifier');
}

function quantity(value: MaterialQuantity, positive: boolean): void {
  if (!value || typeof value !== 'object') throw new TypeError('invalid quantity');
  identifier(value.materialId);
  nonNegative(value.massKg, 'massKg');
  if (positive && value.massKg === 0) throw new RangeError('rule quantities must be positive');
  if (value.phase !== 'solid' && value.phase !== 'liquid' && value.phase !== 'gas') {
    throw new TypeError('invalid phase');
  }
}

function sample(value: MaterialSample, positive: boolean): void {
  quantity(value, positive);
  temperature(value.temperatureC);
}

function totalMass(values: readonly MaterialQuantity[]): number {
  const total = values.reduce((sum, value) => sum + value.massKg, 0);
  nonNegative(total, 'total mass');
  return total;
}

function matches(a: MaterialQuantity, b: MaterialQuantity): boolean {
  return a.materialId === b.materialId && a.phase === b.phase;
}

export function validateRule(rule: TransformationRule): void {
  if (!rule || typeof rule !== 'object') throw new TypeError('invalid rule');
  identifier(rule.id);
  if (!Array.isArray(rule.inputs) || !Array.isArray(rule.outputs) ||
      rule.inputs.length === 0 || rule.outputs.length === 0) {
    throw new TypeError('rules require non-empty inputs and outputs');
  }
  for (const input of rule.inputs) quantity(input, true);
  for (const output of rule.outputs) sample(output, true);
  for (let i = 0; i < rule.inputs.length; i++) {
    const input = rule.inputs[i]!;
    if (rule.inputs.slice(0, i).some(other => matches(input, other))) {
      throw new TypeError('combine duplicate input material/phase requirements');
    }
  }
  if (rule.minTemperatureC !== undefined) temperature(rule.minTemperatureC);
  if (rule.maxTemperatureC !== undefined) temperature(rule.maxTemperatureC);
  if (rule.minTemperatureC !== undefined && rule.maxTemperatureC !== undefined &&
      rule.minTemperatureC > rule.maxTemperatureC) throw new RangeError('inverted temperature range');
  if (!Number.isSafeInteger(rule.durationTicks) || rule.durationTicks <= 0) {
    throw new RangeError('durationTicks must be a positive safe integer');
  }
  nonNegative(rule.energyPerTickJ, 'energyPerTickJ');
  nonNegative(rule.energyPerTickJ * rule.durationTicks, 'total required energy');
  const inputMass = totalMass(rule.inputs);
  const outputMass = totalMass(rule.outputs);
  // Relative floating-point tolerance only; no absolute allowance for tiny batches.
  if (Math.abs(inputMass - outputMass) > 8 * Number.EPSILON * Math.max(inputMass, outputMass)) {
    throw new RangeError('unbalanced rule mass: account for all products and inputs');
  }
}

export function createProcess(rule: TransformationRule): ProcessState {
  validateRule(rule);
  // Snapshot the rule so later edits to the definition cannot change an active batch.
  const snapshot = Object.freeze({
    ...rule,
    inputs: Object.freeze(rule.inputs.map(input => Object.freeze({ ...input }))),
    outputs: Object.freeze(rule.outputs.map(output => Object.freeze({ ...output }))),
  });
  return { rule: snapshot, completedTicks: 0 };
}

function inRange(rule: TransformationRule, value: MaterialSample): boolean {
  return (rule.minTemperatureC === undefined || value.temperatureC >= rule.minTemperatureC) &&
    (rule.maxTemperatureC === undefined || value.temperatureC <= rule.maxTemperatureC);
}

// Plan consumption in inventory order. Distinct input keys cannot spend the same sample.
// Availability uses strict comparisons: an actually short batch is not topped up by tolerance.
function plan(rule: TransformationRule, samples: readonly MaterialSample[], checkTemperature: boolean): number[] | undefined {
  const consumed = samples.map(() => 0);
  for (const input of rule.inputs) {
    let remaining = input.massKg;
    for (let i = 0; i < samples.length && remaining > 0; i++) {
      const value = samples[i]!;
      if (!matches(input, value) || (checkTemperature && !inRange(rule, value))) continue;
      const take = Math.min(remaining, value.massKg);
      if (take === 0) continue;
      if (remaining - take === remaining || value.massKg - take === value.massKg) {
        throw new RangeError('mass resolution insufficient for this batch');
      }
      consumed[i] = take;
      remaining -= take;
    }
    if (remaining > 0) return undefined;
  }
  return consumed;
}

/**
 * Attempt exactly one tick. No mutation, no clock, no randomness.
 * Inputs are checked every tick, but exchanged atomically only on completion.
 * The caller owns inventory and energy: apply the returned inventory and debit
 * energyConsumedJ exactly once; serialize competing processes and retain state.
 * A paused tick spends no energy. Already-spent energy is not refunded.
 * Output temperatures are authored approximations, not an enthalpy calculation.
 */
export function stepProcess(
  state: ProcessState,
  samples: readonly MaterialSample[],
  availableEnergyJ: number,
): ProcessStep {
  validateRule(state.rule);
  const rule = state.rule;
  if (!Number.isSafeInteger(state.completedTicks) || state.completedTicks < 0 ||
      state.completedTicks > rule.durationTicks) throw new RangeError('invalid completedTicks');
  if (!Array.isArray(samples)) throw new TypeError('invalid sample inventory');
  for (const value of samples) sample(value, false);
  totalMass(samples);
  nonNegative(availableEnergyJ, 'availableEnergyJ');

  const unchanged = (status: 'paused' | 'completed', pauseReason?: PauseReason): ProcessStep =>
    ({ state, samples, energyConsumedJ: 0, status, ...(pauseReason ? { pauseReason } : {}) });
  if (state.completedTicks === rule.durationTicks) return unchanged('completed');

  const consumed = plan(rule, samples, true);
  if (!consumed) {
    return unchanged('paused', plan(rule, samples, false) ? 'temperature' : 'insufficient-input');
  }
  if (availableEnergyJ < rule.energyPerTickJ) return unchanged('paused', 'insufficient-energy');

  const next = { rule, completedTicks: state.completedTicks + 1 };
  if (next.completedTicks < rule.durationTicks) {
    return { state: next, samples, energyConsumedJ: rule.energyPerTickJ, status: 'progressed' };
  }
  const products: MaterialSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]!;
    const massKg = value.massKg - consumed[i]!;
    if (consumed[i] === 0 || massKg > 0) products.push({ ...value, massKg });
  }
  products.push(...rule.outputs.map(output => ({ ...output })));
  totalMass(products);
  return { state: next, samples: products, energyConsumedJ: rule.energyPerTickJ, status: 'completed' };
}
