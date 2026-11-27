/** World-owned outcome adapter; physiological rules remain in biology. */
import type { Agent, World } from './model.js';
import type { AgentAction } from './agents/index.js';
import { advanceBiology, createBiologicalState, createBiologyConfig } from './biology/index.js';
import type { BiologicalState, BiologyConfig, ActivityOutcome } from './biology/index.js';

export type ActionKind = AgentAction['kind'];
export type ResolvedActionKind = ActionKind | 'rejected';
export interface ResolvedAction {
  readonly tick: number;
  readonly agentId: number;
  readonly requested: ActionKind;
  /** Actual activity; forced rest is rest even if movement was requested. */
  readonly kind: ResolvedActionKind;
  readonly status: 'succeeded' | 'failed';
  readonly reason?: string;
}
export interface WorldBiologyOptions {
  readonly config?: BiologyConfig;
  readonly initial?: Omit<BiologicalState, 'version'>;
  readonly exertion?: Partial<Readonly<Record<'move' | 'harvest' | 'deliver', number>>>;
}
export interface WorldBiologyConfig {
  readonly config: BiologyConfig;
  readonly initial: BiologicalState;
  readonly exertion: Readonly<Record<'move' | 'harvest' | 'deliver', number>>;
}
export const DEFAULT_EXERTION = Object.freeze({ move: 0.5, harvest: 1, deliver: 0.25 });

export function createWorldBiology(options: WorldBiologyOptions = {}): WorldBiologyConfig {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid World biology options');
  const exertion = { ...DEFAULT_EXERTION, ...options.exertion };
  for (const kind of ['move', 'harvest', 'deliver'] as const) {
    const value = exertion[kind];
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Invalid exertion intensity: ' + kind);
  }
  return Object.freeze({ config: createBiologyConfig(options.config),
    initial: createBiologicalState(options.initial),
    exertion: Object.freeze({ move: exertion.move, harvest: exertion.harvest, deliver: exertion.deliver }) });
}

export function resolved(world: World, agent: Agent, requested: ActionKind,
  kind: ResolvedActionKind = requested, reason?: string): ResolvedAction {
  return Object.freeze({ tick: world.tick, agentId: agent.id, requested, kind,
    status: kind === 'rejected' ? 'failed' : 'succeeded', ...(reason ? { reason } : {}) });
}

/** A rejected action involves no confirmed effort in the current executor.
 * If future rules allow partial effort, report it explicitly rather than infer it. */
export function activityFor(outcome: ResolvedAction, config: WorldBiologyConfig): ActivityOutcome {
  switch (outcome.kind) {
    case 'move': case 'harvest': case 'deliver':
      return { kind: 'exertion', status: 'succeeded', intensity: config.exertion[outcome.kind] };
    case 'rest': return { kind: 'rest', status: 'succeeded' };
    case 'idle': return { kind: 'idle', status: 'succeeded' };
    case 'rejected': return { kind: 'idle', status: 'failed' };
  }
}

/** Only stepWorld calls this once per registered agent per tick.
 * Direct executeAgentAction callers receive a receipt but consume no modeled time. */
export function completeAgentTick(world: World, agent: Agent, outcome: ResolvedAction): void {
  if (outcome.tick !== world.tick || outcome.agentId !== agent.id ||
      agent.lastOutcome?.tick === world.tick) throw new RangeError('Duplicate or mismatched agent tick outcome');
  if (world.biology) {
    if (!agent.biology) throw new Error('Living agent missing biological state');
    agent.biology = advanceBiology(agent.biology, world.tickDurationSeconds,
      activityFor(outcome, world.biology), world.biology.config);
  }
  agent.lastOutcome = outcome;
}
