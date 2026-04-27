import { GRID_W } from './constants.js';
import { uid } from './rng.js';

export function createJobsSystem(opts) {
  const {
    state,
    policy,
  } = opts;

  const jobs = state.units.jobs;
  const villagers = state.units.villagers;

  const jobSuppression = new Map();
  const activeZoneJobs = { sow: new Set(), chop: new Set(), mine: new Set() };

  function clearActiveZoneJobs() {
    activeZoneJobs.sow.clear();
    activeZoneJobs.chop.clear();
    activeZoneJobs.mine.clear();
  }

  function noteJobAssignmentChanged(j) {
    if (!j) return;
    const set = activeZoneJobs[j.type];
    if (!set) return;
    const key = j.y * GRID_W + j.x;
    if ((j.assigned || 0) > 0) set.add(key);
    else set.delete(key);
  }

  function noteJobRemoved(j) {
    if (!j) return;
    const set = activeZoneJobs[j.type];
    if (!set) return;
    set.delete(j.y * GRID_W + j.x);
  }

  function getJobCreationConfig() {
    return policy?.style?.jobCreation || {};
  }

  // Identity keys must include the fields that distinguish one unit of work
  // from another. Same tile does not mean same work — wood vs stone hauls
  // for one building share type/x/y/bid but are different jobs, and a hunt
  // on a fleeing animal moves but is still the same hunt.
  function getJobIdentity(job) {
    if (!job || !job.type) return null;
    switch (job.type) {
      case 'haul':
        return `haul:b${job.bid}:r${job.resource}`;
      case 'hunt':
        return job.targetAid != null
          ? `hunt:a${job.targetAid}`
          : `hunt:noaid:${job.x},${job.y}:b${job.bid}`;
      case 'build':
        return `build:b${job.bid}`;
      case 'craft_bow':
        return `craft_bow:b${job.bid}`;
      case 'sow':
      case 'harvest':
      case 'chop':
      case 'mine':
      case 'forage':
        return `${job.type}:${job.x},${job.y}`;
      default:
        return null;
    }
  }

  function isJobSuppressed(job) {
    const key = getJobIdentity(job);
    if (!key) return false;
    const until = jobSuppression.get(key);
    if (until === undefined) return false;
    if (until <= state.time.tick) {
      jobSuppression.delete(key);
      return false;
    }
    return true;
  }

  function suppressJob(job, duration = 0) {
    const key = getJobIdentity(job);
    if (!key || duration <= 0) return;
    jobSuppression.set(key, state.time.tick + duration);
  }

  function hasSimilarJob(job) {
    const id = getJobIdentity(job);
    if (!id) return false;
    return jobs.some(j => j && !j.cancelled && getJobIdentity(j) === id);
  }

  function violatesSpacing(x, y, type, cfg) {
    const spacing = cfg?.minSpacing?.[type];
    if (!Number.isFinite(spacing) || spacing <= 0) return false;
    for (const j of jobs) {
      if (!j || j.type !== type) continue;
      const dist = Math.abs((j.x || 0) - x) + Math.abs((j.y || 0) - y);
      if (dist <= spacing) return true;
    }
    return false;
  }

  function addJob(job) {
    if (!job || !job.type) return null;
    if (hasSimilarJob(job) || isJobSuppressed(job)) return null;
    job.id = uid();
    job.assigned = 0;
    jobs.push(job);
    return job;
  }

  function finishJob(v, remove = false) {
    const job = v.targetJob;
    if (job) {
      job.assigned = Math.max(0, (job.assigned || 0) - 1);
      noteJobAssignmentChanged(job);
      if (remove) {
        const ji = jobs.indexOf(job);
        if (ji !== -1) {
          noteJobRemoved(job);
          jobs.splice(ji, 1);
        }
      }
    }
    v.targetJob = null;
  }

  function detachVillagersFromJob(job) {
    for (const villager of villagers) {
      if (villager.targetJob === job) {
        villager.targetJob = null;
        if (villager.path) villager.path.length = 0;
        villager.state = 'idle';
      }
    }
  }

  return {
    activeZoneJobs,
    clearActiveZoneJobs,
    noteJobAssignmentChanged,
    noteJobRemoved,
    getJobCreationConfig,
    getJobIdentity,
    isJobSuppressed,
    suppressJob,
    hasSimilarJob,
    violatesSpacing,
    addJob,
    finishJob,
    detachVillagersFromJob,
  };
}
