const HEAVY_JOB_TYPES = new Set(['chop', 'mine', 'build', 'haul']);
const NURTURE_JOB_TYPES = new Set(['sow', 'harvest']);
const FARM_JOB_TYPES = new Set(['sow', 'harvest']);

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

  if (villager.role === 'farmer' && FARM_JOB_TYPES.has(job.type)) {
    value += farmerRoleBonus;
  }
  if (villager.role === 'worker' && HEAVY_JOB_TYPES.has(job.type)) {
    value += workerRoleBonus;
  }

  const hunger = Number.isFinite(villager.hunger) ? villager.hunger : 0;
  if (hunger > hungerFarmThreshold && FARM_JOB_TYPES.has(job.type)) {
    value += hungerFarmBonus;
  }

  return value;
}
