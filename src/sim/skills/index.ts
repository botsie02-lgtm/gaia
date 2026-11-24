/** Deterministic practice accounting, not a complete agent learning model. */
export interface SkillRecord {
  readonly skillId: string;
  readonly attempts: number;
  readonly successes: number;
  readonly experience: number;
  /** Dimensionless, in [0, 1]. Not a probability of action success. */
  readonly proficiency: number;
}

export interface SkillConfig {
  readonly skillId: string;
  /** Non-negative safe integer XP rewards per completed attempt. */
  readonly failureExperience: number;
  readonly successExperience: number;
  /** Positive safe integer XP at which proficiency is 0.5. */
  readonly halfProficiencyExperience: number;
  /** Strictly increasing positive safe integer attempt counts. */
  readonly attemptMilestones: readonly number[];
}

export interface PracticeOutcome {
  readonly skillId: string;
  readonly success: boolean;
}

export interface PracticeUpdate {
  readonly record: SkillRecord;
  /** Only milestones crossed by this update, not previously reached ones. */
  readonly reachedMilestones: readonly number[];
}

/** Illustrative tuning, not measured human learning or an ability unlock. */
export const THROWING_SKILL: SkillConfig = Object.freeze({
  skillId: 'throwing',
  failureExperience: 1,
  successExperience: 2,
  halfProficiencyExperience: 400,
  attemptMilestones: Object.freeze([100]),
});

function requireId(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new RangeError('skillId must be a non-empty, trimmed string');
  }
}

function requireCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(name + ' must be a non-negative safe integer');
  }
}

function requireUnit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(name + ' must be in [0, 1]');
  }
}

function validateConfig(config: SkillConfig): void {
  requireId(config.skillId);
  requireCount(config.failureExperience, 'failureExperience');
  requireCount(config.successExperience, 'successExperience');
  requireCount(config.halfProficiencyExperience, 'halfProficiencyExperience');
  if (config.successExperience === 0 ||
      config.successExperience < config.failureExperience ||
      config.halfProficiencyExperience === 0) {
    throw new RangeError('invalid experience rewards or growth scale');
  }
  if (!Array.isArray(config.attemptMilestones)) {
    throw new TypeError('attemptMilestones must be an array');
  }
  let previous = 0;
  for (const milestone of config.attemptMilestones) {
    requireCount(milestone, 'milestone');
    if (milestone <= previous) {
      throw new RangeError('milestones must be positive and strictly increasing');
    }
    previous = milestone;
  }
}

/** Saturating curve: equal XP increments yield progressively smaller gains. */
function proficiencyFor(experience: number, config: SkillConfig): number {
  return experience / (experience + config.halfProficiencyExperience);
}

function experienceFor(attempts: number, successes: number, config: SkillConfig): number {
  const experience = (attempts - successes) * config.failureExperience +
    successes * config.successExperience;
  requireCount(experience, 'experience');
  return experience;
}

/** A record is tied to its XP/growth configuration. Retuning requires migration. */
function validateRecord(record: SkillRecord, config: SkillConfig): void {
  validateConfig(config);
  if (record.skillId !== config.skillId) {
    throw new RangeError('record and config skill IDs differ');
  }
  requireCount(record.attempts, 'attempts');
  requireCount(record.successes, 'successes');
  requireCount(record.experience, 'experience');
  requireUnit(record.proficiency, 'proficiency');
  if (record.successes > record.attempts ||
      record.experience !== experienceFor(record.attempts, record.successes, config) ||
      record.proficiency !== proficiencyFor(record.experience, config)) {
    throw new RangeError('inconsistent skill record');
  }
}

export function createSkillRecord(config: SkillConfig): SkillRecord {
  validateConfig(config);
  return Object.freeze({
    skillId: config.skillId, attempts: 0, successes: 0, experience: 0, proficiency: 0,
  });
}

/** Record exactly one resolved action. No time, RNG, or mutation of inputs. */
export function applyPracticeOutcome(
  record: SkillRecord, outcome: PracticeOutcome, config: SkillConfig,
): PracticeUpdate {
  validateRecord(record, config);
  if (outcome.skillId !== record.skillId || typeof outcome.success !== 'boolean') {
    throw new TypeError('invalid or mismatched practice outcome');
  }
  const attempts = record.attempts + 1;
  requireCount(attempts, 'attempts');
  const successes = record.successes + (outcome.success ? 1 : 0);
  const experience = experienceFor(attempts, successes, config);
  const next = Object.freeze({
    skillId: record.skillId, attempts, successes, experience,
    proficiency: proficiencyFor(experience, config),
  });
  const reachedMilestones = Object.freeze(config.attemptMilestones.filter(
    milestone => record.attempts < milestone && milestone <= attempts,
  ));
  return Object.freeze({ record: next, reachedMilestones });
}

/** Query cumulative milestones, including after a JSON snapshot round-trip. */
export function getReachedMilestones(
  record: SkillRecord, config: SkillConfig,
): readonly number[] {
  validateRecord(record, config);
  return Object.freeze(config.attemptMilestones.filter(m => m <= record.attempts));
}

/**
 * Optional adapter for future action resolvers. The caller supplies the
 * untrained chance and maximum fraction of remaining success chance that
 * proficiency may recover. This never rolls RNG or resolves an action.
 */
export function getActionSuccessChance(
  record: SkillRecord, config: SkillConfig, baseChance: number, maxInfluence: number,
): number {
  validateRecord(record, config);
  requireUnit(baseChance, 'baseChance');
  requireUnit(maxInfluence, 'maxInfluence');
  return Math.min(1, baseChance + (1 - baseChance) * maxInfluence * record.proficiency);
}
