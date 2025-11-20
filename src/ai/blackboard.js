const DEFAULT_HUNGER_THRESHOLDS = Object.freeze({
  hungry: 0.82,
  starving: 1.08,
  minHungry: 0.7,
  minStarving: 1.0,
  famineTightening: 0.14,
  coldSeasonTightening: 0.05
});

const FARM_JOB_TYPES = new Set(['sow', 'harvest']);
const BUILD_JOB_TYPES = new Set(['build']);
const DEFAULT_FATIGUE_THRESHOLD = 0.32;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function resolveHungerConfig(policy) {
  const config = policy?.style?.hunger || policy?.style?.jobScoring?.hungerThresholds;
  if (!config || typeof config !== 'object') {
    return DEFAULT_HUNGER_THRESHOLDS;
  }
  return {
    hungry: Number.isFinite(config.hungry) ? config.hungry : DEFAULT_HUNGER_THRESHOLDS.hungry,
    starving: Number.isFinite(config.starving) ? config.starving : DEFAULT_HUNGER_THRESHOLDS.starving,
    minHungry: Number.isFinite(config.minHungry) ? config.minHungry : DEFAULT_HUNGER_THRESHOLDS.minHungry,
    minStarving: Number.isFinite(config.minStarving) ? config.minStarving : DEFAULT_HUNGER_THRESHOLDS.minStarving,
    famineTightening: Number.isFinite(config.famineTightening) ? config.famineTightening : DEFAULT_HUNGER_THRESHOLDS.famineTightening,
    coldSeasonTightening: Number.isFinite(config.coldSeasonTightening) ? config.coldSeasonTightening : DEFAULT_HUNGER_THRESHOLDS.coldSeasonTightening
  };
}

function computeHungerThresholds(villagers, availableFood, policy, state) {
  const cfg = resolveHungerConfig(policy);
  const villagerCount = Math.max(1, villagers);
  const foodGap = clamp((villagers - availableFood) / villagerCount, 0, 1);
  const famineTighten = cfg.famineTightening * foodGap;

  const season = state?.world?.season;
  const isColdSeason = season === 3; // winter
  const coldPenalty = isColdSeason ? cfg.coldSeasonTightening : 0;

  const hungry = clamp(cfg.hungry - famineTighten - coldPenalty, cfg.minHungry, cfg.hungry);
  const starving = clamp(cfg.starving - famineTighten - coldPenalty, cfg.minStarving, cfg.starving);
  return { hungry, starving };
}

function coalesceNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function countVillagerNeeds(villagers, thresholds) {
  let hungry = 0;
  let starving = 0;
  for (const villager of villagers) {
    if (!villager) continue;
    const hunger = coalesceNumber(villager.hunger, 0);
    const condition = villager.condition;
    if (hunger > thresholds.starving || condition === 'starving' || condition === 'sick') {
      starving++;
    } else if (hunger > thresholds.hungry || condition === 'hungry') {
      hungry++;
    }
  }
  return { hungry, starving };
}

function availableResource(totals, reserved, key) {
  const total = coalesceNumber(totals?.[key], 0);
  const res = coalesceNumber(reserved?.[key], 0);
  return Math.max(0, total - res);
}

function inspectJobs(jobs) {
  let buildPush = false;
  let growthPush = false;
  for (const job of jobs) {
    if (!job || typeof job.type !== 'string') continue;
    if (!buildPush && BUILD_JOB_TYPES.has(job.type) && job.waitingForMaterials !== true) {
      buildPush = true;
    }
    if (!growthPush && FARM_JOB_TYPES.has(job.type)) {
      growthPush = true;
    }
    if (buildPush && growthPush) break;
  }
  return { buildPush, growthPush };
}

function computeEnergyStats(villagers, policy) {
  const fatigueThreshold = Number.isFinite(policy?.style?.jobScoring?.energyFatigueThreshold)
    ? policy.style.jobScoring.energyFatigueThreshold
    : DEFAULT_FATIGUE_THRESHOLD;
  let totalEnergy = 0;
  let minEnergy = Infinity;
  let fatigued = 0;
  let count = 0;

  for (const villager of villagers) {
    if (!villager) continue;
    const energy = clamp(coalesceNumber(villager.energy, 1), 0, 1);
    totalEnergy += energy;
    count++;
    if (energy < minEnergy) {
      minEnergy = energy;
    }
    if (energy < fatigueThreshold) {
      fatigued++;
    }
  }

  const avgEnergy = count > 0 ? totalEnergy / count : 1;
  if (minEnergy === Infinity) minEnergy = 1;
  return { avgEnergy, minEnergy, fatiguedVillagers: fatigued, fatigue: fatigued > 0 };
}

export function computeBlackboard(state, policy) {
  const villagers = Array.isArray(state?.units?.villagers) ? state.units.villagers : [];
  const jobs = Array.isArray(state?.units?.jobs) ? state.units.jobs : [];
  const totals = state?.stocks?.totals || null;
  const reserved = state?.stocks?.reserved || null;
  const tick = coalesceNumber(state?.time?.tick, 0);
  const season = coalesceNumber(state?.world?.season, 0);
  const seasonProgress = clamp(coalesceNumber(state?.world?.tSeason, 0) / (60 * 10), 0, 1);

  const availableFood = availableResource(totals, reserved, 'food');
  const hungerThresholds = computeHungerThresholds(villagers.length, availableFood, policy, state);
  const { hungry, starving } = countVillagerNeeds(villagers, hungerThresholds);
  const availableWood = availableResource(totals, reserved, 'wood');
  const availableStone = availableResource(totals, reserved, 'stone');

  const famine = starving > 0 || availableFood <= Math.max(0, villagers.length - hungry);
  const { buildPush, growthPush } = inspectJobs(jobs);
  const energy = computeEnergyStats(villagers, policy);

  return {
    tick,
    villagers: villagers.length,
    season,
    seasonProgress,
    availableFood,
    availableWood,
    availableStone,
    hungryVillagers: hungry,
    starvingVillagers: starving,
    famine,
    buildPush,
    growthPush,
    hungerThresholds,
    energy
  };
}
