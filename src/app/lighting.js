import { SHADING_DEFAULTS, AIV_SCOPE } from './environment.js';

const LIGHTING = {
  mode: 'hillshade',
  useMultiplyComposite: true,
  lightmapScale: 0.25,
  uiMinLight: 0.94,
  exposure: 1.0,
  nightFloor: 0.32,
  lightCap: 1.40,
  softLights: true,
  debugShowLightmap: false
};

const clamp01 = (value) => {
  if (!Number.isFinite(value)) {
    return value > 0 ? 1 : 0;
  }
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
};

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
  LIGHTING,
  makeAltitudeShade,
  registerShadingHandlers,
  setShadingMode,
  setShadingParams
};
