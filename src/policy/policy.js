const DEFAULT_SLIDERS = Object.freeze({
  food: 0.7,
  build: 0.5,
  explore: 0.3
});

const DEFAULT_MOOD_TARGETS = Object.freeze({
  upbeat: 0.8,
  cheerful: 0.65,
  lowSpirits: 0.35,
  miserable: 0.2
});

const TICKS_PER_SECOND = 6;
const DEFAULT_MINUTES = 60;

const DEFAULT_JOB_STYLE = Object.freeze({
  defaultPriority: 0.5,
  distanceFalloff: 0.01,
  baseMoodWeight: 0.04,
  heavyRoleMoodWeight: 0.04,
  nurtureRoleMoodWeight: 0.02,
  priorityMoodWeight: 0.03,
  lowPriorityBaseline: 0.7,
  farmerRoleBonus: 0.08,
  workerRoleBonus: 0.06,
  hungerFarmThreshold: 0.6,
  hungerFarmBonus: 0.03,
  famineFoodBonus: 0.12,
  famineNonEssentialPenalty: 0.08,
  buildPushBonus: 0.05,
  growthPushBonus: 0.06,
  buildMaterialPenaltyWeight: 0.12,
  buildMaterialReserveTarget: 4,
  farmingSkillWeight: 0.4,
  constructionSkillWeight: 0.3,
  minPickScore: 0
});

const DEFAULT_HUNGER_THRESHOLDS = Object.freeze({
  hungry: 0.78,
  starving: 1.02,
  minHungry: 0.65,
  minStarving: 0.95,
  famineTightening: 0.14,
  coldSeasonTightening: 0.05
});

export const policy = {
  state: null,
  sliders: { ...DEFAULT_SLIDERS },
  attach(state) {
    this.state = state || null;
    const fromState = state?.population?.priorities;
    if (fromState && typeof fromState === 'object') {
      this.sliders = fromState;
    } else {
      this.sliders = { ...DEFAULT_SLIDERS };
    }
    return this;
  },
  caps: {
    buildWaiting(policyRef = null) {
      const source = (policyRef || policy).sliders;
      const buildValue = typeof source?.build === 'number' ? source.build : DEFAULT_SLIDERS.build;
      return 0.5 + buildValue * 0.35;
    }
  },
  routine: {
    jobGenerationTickInterval: 20,
    seasonTickInterval: 10,
    blackboardCadenceTicks: 30,
    ticksPerSecond: TICKS_PER_SECOND,
    blackboardLogging: {
      enabled: false,
      intervalTicks: TICKS_PER_SECOND * DEFAULT_MINUTES
    }
  },
  moodTargets: { ...DEFAULT_MOOD_TARGETS },
  style: {
    jobScoring: { ...DEFAULT_JOB_STYLE },
    hunger: { ...DEFAULT_HUNGER_THRESHOLDS }
  }
};
