const HEAVY_JOB_TYPES = new Set(['chop', 'mine', 'build', 'haul', 'craft_bow', 'hunt']);
const NURTURE_JOB_TYPES = new Set(['sow', 'harvest', 'forage']);
const FARM_JOB_TYPES = new Set(['sow', 'harvest', 'forage']);

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return value > max ? max : min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function getStyle(policy) {
  return policy?.style?.jobScoring || {};
}

function getCaps(policy) {
  return policy?.caps || {};
}

function resolveSkill(value, fallback = 0.5) {
  if (Number.isFinite(value)) return clamp(value, 0, 1);
  return clamp(fallback, 0, 1);
}

export function computeFamineSeverity(blackboard) {
  if (!blackboard || !blackboard.famine) return 0;
  const villagerCount = Math.max(1, blackboard.villagers || 0);
  const weightedNeed = (blackboard.starvingVillagers || 0) + (blackboard.hungryVillagers || 0) * 0.5;
  return clamp(weightedNeed / villagerCount, 0, 1);
}

export function score(job, villager, policy, blackboard) {
  if (!job || !villager || !policy) {
    return -Infinity;
  }

  const style = getStyle(policy);
  const caps = getCaps(policy);

  const defaultPriority = Number.isFinite(style.defaultPriority) ? style.defaultPriority : 0.5;
  const distanceFalloff = Number.isFinite(style.distanceFalloff) ? style.distanceFalloff : 0;
  const baseMoodWeight = Number.isFinite(style.baseMoodWeight) ? style.baseMoodWeight : 0;
  const heavyRoleMoodWeight = Number.isFinite(style.heavyRoleMoodWeight) ? style.heavyRoleMoodWeight : 0;
  const nurtureRoleMoodWeight = Number.isFinite(style.nurtureRoleMoodWeight) ? style.nurtureRoleMoodWeight : 0;
  const priorityMoodWeight = Number.isFinite(style.priorityMoodWeight) ? style.priorityMoodWeight : 0;
  const lowPriorityBaseline = Number.isFinite(style.lowPriorityBaseline) ? style.lowPriorityBaseline : 0.7;
  const farmerRoleBonus = Number.isFinite(style.farmerRoleBonus) ? style.farmerRoleBonus : 0;
  const workerRoleBonus = Number.isFinite(style.workerRoleBonus) ? style.workerRoleBonus : 0;
  const hungerFarmThreshold = Number.isFinite(style.hungerFarmThreshold) ? style.hungerFarmThreshold : Infinity;
  const hungerFarmBonus = Number.isFinite(style.hungerFarmBonus) ? style.hungerFarmBonus : 0;
  const famineFoodBonus = Number.isFinite(style.famineFoodBonus) ? style.famineFoodBonus : 0;
  const famineNonEssentialPenalty = Number.isFinite(style.famineNonEssentialPenalty) ? style.famineNonEssentialPenalty : 0;
  const buildPushBonus = Number.isFinite(style.buildPushBonus) ? style.buildPushBonus : 0;
  const growthPushBonus = Number.isFinite(style.growthPushBonus) ? style.growthPushBonus : 0;
  const buildMaterialPenaltyWeight = Number.isFinite(style.buildMaterialPenaltyWeight) ? style.buildMaterialPenaltyWeight : 0;
  const buildMaterialReserveTarget = Number.isFinite(style.buildMaterialReserveTarget) ? style.buildMaterialReserveTarget : 0;
  const farmingSkillWeight = Number.isFinite(style.farmingSkillWeight)
    ? style.farmingSkillWeight
    : farmerRoleBonus * 2;
  const constructionSkillWeight = Number.isFinite(style.constructionSkillWeight)
    ? style.constructionSkillWeight
    : workerRoleBonus * 2;
  const energyFatigueThreshold = Number.isFinite(style.energyFatigueThreshold) ? style.energyFatigueThreshold : 0.32;
  const energyHeavyJobPenalty = Number.isFinite(style.energyHeavyJobPenalty) ? style.energyHeavyJobPenalty : 0;
  const energyRestBonus = Number.isFinite(style.energyRestBonus) ? style.energyRestBonus : 0;
  const seasonWinterHarvestLead = Number.isFinite(style.seasonWinterHarvestLead) ? style.seasonWinterHarvestLead : 0.25;
  const seasonHarvestWinterBonus = Number.isFinite(style.seasonHarvestWinterBonus) ? style.seasonHarvestWinterBonus : 0;
  const seasonWinterSowPenalty = Number.isFinite(style.seasonWinterSowPenalty) ? style.seasonWinterSowPenalty : 0;
  const travelCostWeight = Number.isFinite(style.travelCostWeight) ? style.travelCostWeight : 0;
  const famineUrgencyWeight = Number.isFinite(style.famineUrgencyWeight) ? style.famineUrgencyWeight : 0;
  const foodTightHarvestBonus = Number.isFinite(style.foodTightHarvestBonus) ? style.foodTightHarvestBonus : 0;
  const foodTightNonFarmPenalty = Number.isFinite(style.foodTightNonFarmPenalty) ? style.foodTightNonFarmPenalty : 0;
  const foodComfortPerVillager = Number.isFinite(style.foodComfortPerVillager) ? style.foodComfortPerVillager : 1;

  const rawPriority = Number.isFinite(job.prio) ? job.prio : defaultPriority;
  let effectivePriority = rawPriority;

  if (job.type === 'build' && job.supply && job.supply.fullyDelivered === false) {
    const cap = typeof caps.buildWaiting === 'function'
      ? caps.buildWaiting(policy, job, villager, blackboard)
      : null;
    if (Number.isFinite(cap) && cap < effectivePriority) {
      effectivePriority = cap;
    }
  }

  const distance = Number.isFinite(job.distance) ? job.distance : 0;
  let value = effectivePriority - distance * distanceFalloff;

  if (travelCostWeight !== 0) {
    const speed = Number.isFinite(villager.speed) ? Math.max(0.25, villager.speed) : 1;
    value -= (distance / speed) * travelCostWeight;
  }

  const happy = Number.isFinite(villager.happy) ? villager.happy : 0.5;
  const mood = clamp((happy - 0.5) * 2, -1, 1);

  value += mood * baseMoodWeight;
  if (HEAVY_JOB_TYPES.has(job.type)) {
    value += mood * heavyRoleMoodWeight;
  } else if (NURTURE_JOB_TYPES.has(job.type)) {
    value += mood * nurtureRoleMoodWeight;
  }

  if (priorityMoodWeight !== 0) {
    if (mood >= 0) {
      value += mood * (effectivePriority * priorityMoodWeight);
    } else {
      value += mood * ((lowPriorityBaseline - effectivePriority) * priorityMoodWeight);
    }
  }

  if (FARM_JOB_TYPES.has(job.type)) {
    const farmingSkill = resolveSkill(villager.farmingSkill, villager.role === 'farmer' ? 0.7 : 0.5);
    value += (farmingSkill - 0.5) * farmingSkillWeight;
  }
  if (HEAVY_JOB_TYPES.has(job.type)) {
    const constructionSkill = resolveSkill(villager.constructionSkill, villager.role === 'worker' ? 0.65 : 0.5);
    value += (constructionSkill - 0.5) * constructionSkillWeight;
  }

  const energy = Number.isFinite(villager.energy) ? villager.energy : 1;
  if (energyHeavyJobPenalty !== 0 && energy < energyFatigueThreshold) {
    const deficit = energyFatigueThreshold - energy;
    const penalty = clamp(deficit / Math.max(energyFatigueThreshold, 0.0001), 0, 1) * energyHeavyJobPenalty;
    if (HEAVY_JOB_TYPES.has(job.type)) {
      value -= penalty;
    }
    if (job.type === 'rest') {
      value += penalty * energyRestBonus;
    }
  }

  const hunger = Number.isFinite(villager.hunger) ? villager.hunger : 0;
  if (hunger > hungerFarmThreshold && FARM_JOB_TYPES.has(job.type)) {
    value += hungerFarmBonus;
  }

  if (blackboard) {
    const famineSeverity = computeFamineSeverity(blackboard);
    if (blackboard.famine && famineSeverity > 0) {
      if (FARM_JOB_TYPES.has(job.type)) {
        value += famineFoodBonus * famineSeverity;
      } else {
        value -= famineNonEssentialPenalty * famineSeverity;
      }
    }

    if (blackboard.buildPush && job.type === 'build') {
      value += buildPushBonus;
    }
    if (blackboard.growthPush && FARM_JOB_TYPES.has(job.type)) {
      value += growthPushBonus;
    }

    if (job.type === 'build' && buildMaterialPenaltyWeight !== 0 && buildMaterialReserveTarget > 0) {
      const villagersCount = Math.max(1, blackboard.villagers || 0);
      const target = buildMaterialReserveTarget * villagersCount;
      const availableMaterials = (blackboard.availableWood || 0) + (blackboard.availableStone || 0);
      const deficit = Math.max(0, target - availableMaterials);
      if (deficit > 0) {
        const penalty = buildMaterialPenaltyWeight * (deficit / target);
        value -= penalty;
      }
    }

    if (famineUrgencyWeight !== 0) {
      const famineSeverity = computeFamineSeverity(blackboard);
      if (famineSeverity > 0) {
        if (FARM_JOB_TYPES.has(job.type) || job.type === 'harvest') {
          value += famineSeverity * famineUrgencyWeight;
        } else {
          value -= famineSeverity * (famineUrgencyWeight * 0.5);
        }
      }
    }

    if (foodComfortPerVillager > 0) {
      const villagerCount = Math.max(1, blackboard.villagers || 0);
      const foodPerVillager = (blackboard.availableFood || 0) / villagerCount;
      const foodTightness = clamp((foodComfortPerVillager - foodPerVillager) / foodComfortPerVillager, 0, 1);
      if (foodTightness > 0) {
        if (job.type === 'harvest') {
          value += foodTightHarvestBonus * foodTightness;
        } else if (!FARM_JOB_TYPES.has(job.type)) {
          value -= foodTightNonFarmPenalty * foodTightness;
        }
      }
    }

    const season = Number.isFinite(blackboard.season) ? blackboard.season : null;
    if (season !== null) {
      const progress = clamp(Number.isFinite(blackboard.seasonProgress) ? blackboard.seasonProgress : 0, 0, 1);
      const approachingWinter = season === 2 && progress >= (1 - seasonWinterHarvestLead);
      const inWinter = season === 3;
      if ((approachingWinter || inWinter) && job.type === 'harvest') {
        value += seasonHarvestWinterBonus;
      }
      if (inWinter && job.type === 'sow') {
        value -= seasonWinterSowPenalty;
      }
    }
  }

  return value;
}
