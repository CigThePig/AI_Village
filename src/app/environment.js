const AIV_SCOPE = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);
const terrainAPI = AIV_SCOPE && AIV_SCOPE.AIV_TERRAIN ? AIV_SCOPE.AIV_TERRAIN : null;
const configAPI = AIV_SCOPE && AIV_SCOPE.AIV_CONFIG ? AIV_SCOPE.AIV_CONFIG : null;

const generateTerrain = terrainAPI ? terrainAPI.generateTerrain : null;
const makeHillshade = terrainAPI ? terrainAPI.makeHillshade : null;
const WORLDGEN_DEFAULTS = configAPI ? configAPI.WORLDGEN_DEFAULTS : undefined;
const SHADING_DEFAULTS = configAPI ? configAPI.SHADING_DEFAULTS : undefined;

if (typeof generateTerrain !== 'function' || typeof makeHillshade !== 'function') {
  throw new Error('AI Village terrain module unavailable.');
}
if (!WORLDGEN_DEFAULTS || !SHADING_DEFAULTS) {
  throw new Error('AI Village configuration unavailable.');
}

// Keep nights at their previous duration while doubling the daylight window.
const DAYTIME_PORTION = 2 / 3;
const NIGHTTIME_PORTION = 1 - DAYTIME_PORTION;

export {
  AIV_SCOPE,
  generateTerrain,
  makeHillshade,
  WORLDGEN_DEFAULTS,
  SHADING_DEFAULTS,
  DAYTIME_PORTION,
  NIGHTTIME_PORTION
};
