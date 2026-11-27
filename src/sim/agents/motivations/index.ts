import { decideAgent } from '../index.js';
import type { AgentAction, AgentInternal, Decision, PolicyConfig } from '../index.js';
import { rankMotivations } from '../../biology/index.js';
import type { BiologicalState, BiologyConfig } from '../../biology/index.js';
import type { MemorySnapshot } from '../../memory/index.js';
import type { Observation } from '../../perception/index.js';

export type Goal = 'obtain-water' | 'obtain-food' | 'rest' | 'gather' | 'explore';
const GOALS: readonly Goal[] = Object.freeze(['obtain-water', 'obtain-food', 'rest', 'gather', 'explore']);

export interface MotivationConfig {
  readonly gatherUrgency: number;
  readonly exploreUrgency: number;
  /** Costs in abstract utility units for the immediate requested action. */
  readonly moveCost: number;
  readonly harvestCost: number;
  readonly deliverCost: number;
  readonly restCost: number;
  readonly unknownSearchPenalty: number;
  readonly rememberedPenalty: number;
  readonly switchMargin: number;
  readonly maxCommitmentTicks: number;
}
export const DEFAULT_MOTIVATIONS: MotivationConfig = Object.freeze({
  gatherUrgency: 0.25, exploreUrgency: 0.15,
  moveCost: 0.04, harvestCost: 0.03, deliverCost: 0.01, restCost: 0.02,
  unknownSearchPenalty: 0.10, rememberedPenalty: 0.05,
  switchMargin: 0.08, maxCommitmentTicks: 6,
});

export interface GoalState {
  readonly version: 1;
  readonly observerId: number;
  readonly lastTick: number;
  readonly goal: Goal | null;
  readonly sinceTick: number;
}
export interface MotivationInput {
  readonly observation: Observation;
  readonly memory: MemorySnapshot;
  readonly own: AgentInternal;
  readonly biology: BiologicalState;
  readonly policy: PolicyConfig;
  readonly biologyConfig?: BiologyConfig;
  readonly previous?: GoalState | null;
}
export type Opportunity = 'self' | 'observed' | 'remembered' | 'frontier' | 'unknown' | 'none-known';
export type Feasibility = 'requestable' | 'search-only' | 'blocked';
export interface GoalEvaluation {
  readonly goal: Goal;
  readonly urgency: number;
  /** Evidence for the goal, not confirmation of action success. */
  readonly opportunity: Opportunity;
  readonly feasibility: Feasibility;
  readonly estimatedActionCost: number | null;
  readonly uncertaintyPenalty: number;
  readonly score: number | null;
  readonly targetId: number | null;
  readonly decision: Decision | null;
}
export interface MotivatedDecision {
  /** Highest raw urgency even when there is no supporting action. */
  readonly desiredGoal: Goal;
  /** Goal motivating the next requested action, or null for idle. */
  readonly selectedGoal: Goal | null;
  readonly reason: 'legacy-rest' | 'persist' | 'best-feasible' | 'no-positive-feasible';
  readonly evaluations: readonly GoalEvaluation[];
  readonly decision: Decision;
  readonly nextState: GoalState;
}

function integer(value: unknown, label: string, min = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new RangeError(label + ' must be a safe integer >= ' + min);
}
function unit(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError(label + ' must be in [0,1]');
}
function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(label + ' must be an object');
}
export function createMotivationConfig(overrides: Partial<MotivationConfig> = {}): MotivationConfig {
  record(overrides, 'Motivation config');
  const c = { ...DEFAULT_MOTIVATIONS, ...overrides };
  const { gatherUrgency, exploreUrgency, moveCost, harvestCost, deliverCost, restCost,
    unknownSearchPenalty, rememberedPenalty, switchMargin, maxCommitmentTicks } = c;
  for (const [name, value] of Object.entries({ gatherUrgency, exploreUrgency, moveCost,
    harvestCost, deliverCost, restCost, unknownSearchPenalty, rememberedPenalty, switchMargin }))
    unit(value, name);
  integer(maxCommitmentTicks, 'maxCommitmentTicks', 1);
  if (maxCommitmentTicks > 1024) throw new RangeError('maxCommitmentTicks exceeds 1024');
  return Object.freeze({ gatherUrgency, exploreUrgency, moveCost, harvestCost, deliverCost,
    restCost, unknownSearchPenalty, rememberedPenalty, switchMargin, maxCommitmentTicks });
}
/** Restore only trusted individual state from the corresponding world. */
export function restoreGoalState(value: unknown): GoalState {
  record(value, 'Goal state');
  const { version, observerId, lastTick, goal, sinceTick } = value;
  if (version !== 1 || (goal !== null && !GOALS.includes(goal as Goal)))
    throw new TypeError('Invalid goal state version or goal');
  integer(observerId, 'observerId', 1);
  integer(lastTick, 'lastTick');
  integer(sinceTick, 'sinceTick');
  if (sinceTick > lastTick || (goal === null && sinceTick !== lastTick))
    throw new RangeError('Invalid goal state chronology');
  return Object.freeze({ version: 1, observerId, lastTick, goal: goal as Goal | null, sinceTick });
}

function validateInput(input: MotivationInput): GoalState | null {
  const { observation: o, memory: m, own, policy: p } = input;
  integer(o.tick, 'tick');
  integer(o.observer.id, 'observer ID', 1);
  integer(o.range, 'range');
  integer(p.width, 'width', 1);
  integer(p.height, 'height', 1);
  integer(p.cargoLimit, 'cargoLimit', 1);
  integer(o.observer.x, 'observer x');
  integer(o.observer.y, 'observer y');
  if (o.observer.x >= p.width || o.observer.y >= p.height)
    throw new RangeError('Observer outside permitted geometry');
  integer(m.capacity, 'memory capacity', 1);
  if (m.version !== 1 || m.observerId !== o.observer.id || m.lastObservationTick !== o.tick ||
      !Array.isArray(m.entries) || m.entries.length > m.capacity)
    throw new RangeError('Expected matching current individual memory');
  if (!Number.isFinite(own.energy) || own.energy < 0 || own.energy > 100 ||
      typeof own.resting !== 'boolean') throw new RangeError('Invalid own energy or rest state');
  integer(own.cargo.wood, 'wood cargo');
  integer(own.cargo.stone, 'stone cargo');
  if (own.cargo.wood + own.cargo.stone > p.cargoLimit)
    throw new RangeError('Cargo exceeds capacity');
  const prior = input.previous == null ? null : restoreGoalState(input.previous);
  if (prior && (prior.observerId !== o.observer.id || prior.lastTick >= o.tick))
    throw new RangeError('Prior goal state must belong to the observer and an earlier tick');
  return prior;
}
function request(intention: string, action: AgentAction): Decision {
  return Object.freeze({ intention, action: Object.freeze(action) });
}
function cost(action: AgentAction, c: MotivationConfig): number {
  switch (action.kind) {
    case 'move': return c.moveCost;
    case 'harvest': return c.harvestCost;
    case 'deliver': return c.deliverCost;
    case 'rest': return c.restCost;
    case 'idle': return 0;
  }
}
/** Adapt the existing policy without editing its navigation or benchmarks.
 * Its public Decision currently identifies a movement goal in the intention.
 * Fail closed if that vocabulary changes; never infer a new target. */
function workTarget(d: Decision): number | null {
  if (d.action.kind === 'harvest' || d.action.kind === 'deliver') return d.action.targetId;
  if (d.action.kind !== 'move') return null;
  const match = /^(?:Gather (?:wood|stone)|Return to hub) #(\d+)$/.exec(d.intention);
  return match ? Number(match[1]) : null;
}
function exploration(d: Decision): boolean {
  return d.action.kind === 'move' && d.intention.startsWith('Explore ');
}

/** Pure arbitration. Observation and memory are trusted local projections
 * from observeAgent and AgentMemory, not arbitrary world-shaped input. */
export function decideMotivatedAgent(input: MotivationInput,
  overrides: Partial<MotivationConfig> = {}): MotivatedDecision {
  const prior = validateInput(input);
  const c = createMotivationConfig(overrides);
  const { observation: o, memory: m, own, policy: p } = input;
  const motives = rankMotivations(input.biology, input.biologyConfig);
  const urgency = (kind: 'drink' | 'feed' | 'rest'): number =>
    motives.find(motive => motive.kind === kind)!.urgency;
  const legacyRest = own.energy <= 12 || own.resting;
  const normal = decideAgent(o, m, own, p);
  const targetId = workTarget(normal);
  const visibleTarget = targetId !== null &&
    (o.deposits.some(d => d.id === targetId && d.amount > 0) || o.hub?.id === targetId);
  // The normal policy already rejects absent/zero/contradicted resource evidence.
  const rememberedTarget = targetId !== null && !visibleTarget &&
    m.entries.some(e => e.status !== 'absent' &&
      ((e.value.kind === 'deposit' && e.value.amount > 0) || e.value.kind === 'hub') &&
      e.value.id === targetId);
  const work = visibleTarget || rememberedTarget ? normal : null;

  // The same known-terrain policy can search independently of resource work.
  // Hide ordinary targets for this alternative only; retain real cargo, terrain,
  // visit metadata, observation identity/tick and geometry. Never fake a sighting.
  let frontier: Decision | null = exploration(normal) ? normal : null;
  if (!frontier && !legacyRest) {
    const search = decideAgent({ ...o, deposits: [], hub: null },
      { ...m, entries: m.entries.filter(e => e.value.kind === 'terrain') }, own, p);
    if (exploration(search)) frontier = search;
  }
  const evaluate = (goal: Goal, u: number, opportunity: Opportunity,
    feasibility: Feasibility, d: Decision | null, penalty = 0, id: number | null = null): GoalEvaluation => {
    const estimatedActionCost = d ? cost(d.action, c) : null;
    return Object.freeze({ goal, urgency: u, opportunity, feasibility, estimatedActionCost,
      uncertaintyPenalty: penalty, score: estimatedActionCost === null ? null : u - estimatedActionCost - penalty,
      targetId: id, decision: d });
  };
  const seek = (goal: 'obtain-food' | 'obtain-water', u: number): GoalEvaluation =>
    evaluate(goal, u, 'unknown', frontier ? 'search-only' : 'blocked',
      frontier ? request('Explore for ' + (goal === 'obtain-food' ? 'food' : 'water') +
        ' (availability unknown)', frontier.action) : null, c.unknownSearchPenalty);
  const evaluations = Object.freeze([
    seek('obtain-water', urgency('drink')),
    seek('obtain-food', urgency('feed')),
    evaluate('rest', urgency('rest'), 'self', 'requestable', request('Rest', { kind: 'rest' })),
    evaluate('gather', c.gatherUrgency, visibleTarget ? 'observed' : rememberedTarget ? 'remembered' : 'none-known',
      work ? 'requestable' : 'blocked', work, rememberedTarget ? c.rememberedPenalty : 0, work ? targetId : null),
    evaluate('explore', c.exploreUrgency, frontier ? 'frontier' : 'none-known',
      frontier ? 'requestable' : 'blocked', frontier),
  ]);
  // Stable sort preserves the fixed GOALS order for exact ties.
  const desiredGoal = [...evaluations].sort((a,b) => b.urgency-a.urgency)[0]!.goal;
  const eligible = evaluations.filter(e => e.score !== null && e.score > 0)
    .sort((a,b) => b.score! - a.score!);
  let selected = eligible[0];
  let reason: MotivatedDecision['reason'] = selected ? 'best-feasible' : 'no-positive-feasible';
  const committed = eligible.find(e => e.goal === prior?.goal);
  const active = prior !== null && o.tick - prior.sinceTick < c.maxCommitmentTicks;
  if (legacyRest) {
    selected = evaluations.find(e => e.goal === 'rest')!;
    reason = 'legacy-rest';
  } else if (selected && committed && active && selected.goal !== committed.goal &&
      selected.score! - committed.score! <= c.switchMargin) {
    selected = committed;
    reason = 'persist';
  }
  const selectedGoal = selected?.goal ?? null;
  const nextState: GoalState = Object.freeze({
    version: 1, observerId: o.observer.id, lastTick: o.tick, goal: selectedGoal,
    sinceTick: active && selectedGoal !== null && prior?.goal === selectedGoal ? prior.sinceTick : o.tick,
  });
  return Object.freeze({ desiredGoal, selectedGoal, reason, evaluations,
    decision: selected?.decision ?? request('No positive feasible goal', { kind: 'idle' }), nextState });
}
