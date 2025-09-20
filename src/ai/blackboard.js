const HUNGER_THRESHOLDS = Object.freeze({
  hungry: 0.78,
  starving: 1.02
});

const FARM_JOB_TYPES = new Set(['sow', 'harvest']);
const BUILD_JOB_TYPES = new Set(['build']);

function coalesceNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function countVillagerNeeds(villagers) {
  let hungry = 0;
  let starving = 0;
  for (const villager of villagers) {
    if (!villager) continue;
    const hunger = coalesceNumber(villager.hunger, 0);
    const condition = villager.condition;
    if (hunger > HUNGER_THRESHOLDS.starving || condition === 'starving' || condition === 'sick') {
      starving++;
    } else if (hunger > HUNGER_THRESHOLDS.hungry || condition === 'hungry') {
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

export function computeBlackboard(state) {
  const villagers = Array.isArray(state?.units?.villagers) ? state.units.villagers : [];
  const jobs = Array.isArray(state?.units?.jobs) ? state.units.jobs : [];
  const totals = state?.stocks?.totals || null;
  const reserved = state?.stocks?.reserved || null;
  const tick = coalesceNumber(state?.time?.tick, 0);

  const { hungry, starving } = countVillagerNeeds(villagers);
  const availableFood = availableResource(totals, reserved, 'food');
  const famine = starving > 0 || availableFood <= Math.max(0, villagers.length - hungry);
  const { buildPush, growthPush } = inspectJobs(jobs);

  return {
    tick,
    villagers: villagers.length,
    availableFood,
    hungryVillagers: hungry,
    starvingVillagers: starving,
    famine,
    buildPush,
    growthPush
  };
}
