import { DAY_LENGTH } from './constants.js';
import { DAYTIME_PORTION, NIGHTTIME_PORTION } from './environment.js';
import { LIGHTING, clamp01 } from './lighting.js';
import { clamp } from './rng.js';

export const NIGHT_AMBIENT_THRESHOLD = 0.6;
export const DAWN_AMBIENT_THRESHOLD = 0.68;

export const JOB_EXPERIENCE_MAP = Object.freeze({
  sow: 'farming',
  harvest: 'farming',
  forage: 'farming',
  chop: 'construction',
  mine: 'construction',
  build: 'construction',
  haul: 'hauling',
  hunt: 'hunting',
  craft_bow: 'crafting',
  socialize: 'social'
});

export const EXPERIENCE_THRESHOLDS = [0, 10, 30, 60];
export const XP_SKILL_STEP = 0.05;

export function createExperienceLedger() {
  return {
    farming: 0,
    construction: 0,
    crafting: 0,
    hunting: 0,
    hauling: 0,
    social: 0
  };
}

export function normalizeExperienceLedger(raw) {
  const ledger = createExperienceLedger();
  if (!raw || typeof raw !== 'object') return ledger;
  for (const key of Object.keys(ledger)) {
    const value = raw[key];
    if (Number.isFinite(value) && value > 0) {
      ledger[key] = value;
    }
  }
  return ledger;
}

export function ensureExperienceLedger(v) {
  if (!v) return createExperienceLedger();
  if (!v.experience || typeof v.experience !== 'object') {
    v.experience = createExperienceLedger();
  } else {
    v.experience = normalizeExperienceLedger(v.experience);
  }
  return v.experience;
}

export function addJobExperience(v, jobType, amount = 1) {
  const ledger = ensureExperienceLedger(v);
  const key = JOB_EXPERIENCE_MAP[jobType];
  if (!key) return 0;
  const current = Number.isFinite(ledger[key]) ? ledger[key] : 0;
  const next = Math.max(0, current + Math.max(0, amount));
  ledger[key] = next;
  return next;
}

export function experienceLevelFromXp(xp) {
  let level = 0;
  for (let i = 0; i < EXPERIENCE_THRESHOLDS.length; i++) {
    if (xp >= EXPERIENCE_THRESHOLDS[i]) {
      level = i;
    }
  }
  return level;
}

export function effectiveSkillFromExperience(v, skillKey, fallback = 0.5, jobType = null) {
  const base = clamp(Number.isFinite(v?.[skillKey]) ? v[skillKey] : fallback, 0, 1);
  if (!jobType) return base;
  const ledger = ensureExperienceLedger(v);
  const key = JOB_EXPERIENCE_MAP[jobType];
  const xp = key ? Number.isFinite(ledger[key]) ? ledger[key] : 0 : 0;
  const level = experienceLevelFromXp(xp);
  const bonus = clamp(level * XP_SKILL_STEP, 0, 0.25);
  return clamp(base + bonus, 0, 1);
}

export function applySkillGain(v, key, amount = 0.02, softCap = 0.9, hardCap = 1) {
  const current = clamp(Number.isFinite(v[key]) ? v[key] : 0, 0, hardCap);
  let delta = amount;
  if (current >= softCap) {
    const span = Math.max(0.0001, hardCap - softCap);
    const progress = clamp((current - softCap) / span, 0, 1);
    delta *= Math.max(0.15, 1 - progress);
  }
  const next = clamp(current + delta, 0, hardCap);
  if (next > current) {
    v[key] = next;
    v.happy = clamp(v.happy + Math.min(0.01, (next - current) * 1.5), 0, 1);
  } else {
    v[key] = current;
  }
  return v[key];
}

export function moodMotivation(v) {
  return clamp((v.happy - 0.5) * 2, -1, 1);
}

export function moodPrefix(v) {
  if (v.happy >= 0.8) return '😊 ';
  if (v.happy >= 0.6) return '🙂 ';
  if (v.happy <= 0.2) return '☹️ ';
  if (v.happy <= 0.4) return '😟 ';
  return '';
}

export function moodThought(v, base) {
  const prefix = moodPrefix(v);
  return prefix ? `${prefix}${base}` : base;
}

export function isNightAmbient(ambient) {
  return ambient <= NIGHT_AMBIENT_THRESHOLD;
}

export function isDawnAmbient(ambient) {
  return ambient >= DAWN_AMBIENT_THRESHOLD;
}

export function computeDayNightAngle(currentDayTime, dayLen = DAY_LENGTH) {
  const phase = ((currentDayTime / dayLen) + (DAYTIME_PORTION / 2)) % 1;
  const wrappedPhase = phase < 0 ? phase + 1 : phase;

  if (wrappedPhase < DAYTIME_PORTION) {
    const dayPhase = wrappedPhase / DAYTIME_PORTION;
    return dayPhase * Math.PI - Math.PI / 2;
  }

  const nightPhase = (wrappedPhase - DAYTIME_PORTION) / NIGHTTIME_PORTION;
  return Math.PI / 2 + nightPhase * Math.PI;
}

export function createTimeOfDay(deps) {
  const { getTick, getDayTime, dayLen = DAY_LENGTH } = deps;

  function ambientAt(currentDayTime) {
    const theta = computeDayNightAngle(currentDayTime, dayLen);
    const cosv = Math.max(0, Math.cos(theta));
    const ramp = cosv * cosv;
    const A = LIGHTING.nightFloor + (1 - LIGHTING.nightFloor) * ramp;

    const moonCycle = dayLen * 6;
    const moonTheta = ((getTick() % moonCycle) / moonCycle) * 2 * Math.PI;
    const moonPhase = (1 + Math.sin(moonTheta - Math.PI / 2)) * 0.5;
    const moonlight = 0.9 + 0.3 * moonPhase;
    const nightBlend = clamp01(1 - ramp);
    const ambientWithMoon = A * (1 + nightBlend * (moonlight - 1));

    return Math.min(1.0, ambientWithMoon * LIGHTING.exposure);
  }

  function isNightTime() {
    return isNightAmbient(ambientAt(getDayTime()));
  }

  return { ambientAt, isNightTime };
}
