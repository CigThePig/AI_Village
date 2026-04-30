import { DAY_LENGTH } from './constants.js';
import { SHADING_DEFAULTS } from './environment.js';

const LIGHTING = {
  mode: 'hillshade',
  useMultiplyComposite: true,
  lightmapScale: 0.25,
  uiMinLight: 0.94,
  exposure: 1.08,
  nightFloor: 0.38,
  lightCap: 1.45,
  softLights: true,
  debugShowLightmap: false
};

const clamp01 = (value) => {
  if (!Number.isFinite(value)) {
    return value > 0 ? 1 : 0;
  }
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
};

// Lightmap color grading. The lightmap composites with 'multiply', so these
// tints are channel scalars in [0, 1] applied to the greyscale brightness.
// A value below 1 attenuates that channel (cools when r/g drop, warms when
// b drops). Dawn and dusk are split so morning reads as pale gold and
// evening reads as deeper amber; deep night pushes further blue than the
// dawn/dusk shoulders.
const NIGHT_TINT = Object.freeze({ r: 0.58, g: 0.70, b: 1.00 });
const DEEP_NIGHT_TINT = Object.freeze({ r: 0.48, g: 0.62, b: 1.00 });
const DAWN_TINT = Object.freeze({ r: 1.00, g: 0.86, b: 0.66 });
const DUSK_TINT = Object.freeze({ r: 1.00, g: 0.76, b: 0.54 });
const DAY_TINT = Object.freeze({ r: 1.00, g: 0.99, b: 0.94 });
const NEUTRAL_TINT = Object.freeze({ r: 1.00, g: 1.00, b: 1.00 });

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpTint(a, b, t) {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t)
  };
}

// timePhase wraps dayTime into [0, 1) so we can split the warm shoulder
// into morning (dawn) vs. evening (dusk). The first half of the cycle is
// morning; the second half is evening.
function timePhase(dayTime) {
  if (!Number.isFinite(dayTime)) return null;
  return ((dayTime % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH / DAY_LENGTH;
}

function isMorningPhase(phase) {
  return phase < 0.5;
}

// gradeLightmap maps ambient → per-channel multiplier with five bands:
//   ambient < 0.28  : deep blue night → cooler night
//   0.28 ≤ a < 0.42 : night → warm shoulder (dawn or dusk)
//   0.42 ≤ a < 0.62 : warm shoulder → soft daylight
//   0.62 ≤ a < 0.92 : soft daylight → neutral
//   ambient ≥ 0.92  : neutral daylight
// dayTime selects DAWN_TINT before midday and DUSK_TINT after.
function gradeLightmap(ambient, dayTime = null) {
  const a = clamp01(ambient);
  const phase = timePhase(dayTime);
  const warmTint = phase == null || isMorningPhase(phase) ? DAWN_TINT : DUSK_TINT;
  // Deep blue night.
  if (a < 0.28) {
    return lerpTint(DEEP_NIGHT_TINT, NIGHT_TINT, a / 0.28);
  }
  // Night fading into dawn/dusk.
  if (a < 0.42) {
    return lerpTint(NIGHT_TINT, warmTint, (a - 0.28) / 0.14);
  }
  // Warm dawn/dusk.
  if (a < 0.62) {
    return lerpTint(warmTint, DAY_TINT, (a - 0.42) / 0.20);
  }
  // Long readable daylight.
  if (a < 0.92) {
    return lerpTint(DAY_TINT, NEUTRAL_TINT, (a - 0.62) / 0.30);
  }
  return { ...NEUTRAL_TINT };
}

let setShadingModeImpl = () => {};
let setShadingParamsImpl = () => {};

function setShadingMode(mode) {
  return setShadingModeImpl(mode);
}

function setShadingParams(params = {}) {
  return setShadingParamsImpl(params);
}

function registerShadingHandlers({ setMode, setParams }) {
  if (typeof setMode === 'function') {
    setShadingModeImpl = setMode;
  }
  if (typeof setParams === 'function') {
    setShadingParamsImpl = setParams;
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.setShadingMode = setShadingMode;
  globalThis.setShadingParams = setShadingParams;
  globalThis.SHADING_DEFAULTS = SHADING_DEFAULTS;
}

function makeAltitudeShade(height, w, h, cfg = SHADING_DEFAULTS) {
  const size = w * h;
  const shade = new Float32Array(size);
  if (!height || height.length !== size || size === 0) {
    return shade;
  }
  const ambient = clamp01(typeof cfg?.ambient === 'number' ? cfg.ambient : SHADING_DEFAULTS.ambient);
  const intensity = clamp01(typeof cfg?.intensity === 'number' ? cfg.intensity : SHADING_DEFAULTS.intensity);
  shade.fill(ambient);
  const span = intensity * 2;
  if (span === 0) {
    return shade;
  }
  const min = ambient - intensity;
  for (let i = 0; i < size; i++) {
    const hVal = clamp01(height[i]);
    const lit = clamp01(min + span * hVal);
    shade[i] = lit;
  }
  return shade;
}

export {
  clamp01,
  DAWN_TINT,
  DAY_TINT,
  DEEP_NIGHT_TINT,
  DUSK_TINT,
  gradeLightmap,
  LIGHTING,
  makeAltitudeShade,
  NEUTRAL_TINT,
  NIGHT_TINT,
  registerShadingHandlers,
  setShadingMode,
  setShadingParams
};
