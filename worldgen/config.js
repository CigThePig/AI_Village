export const WORLDGEN_DEFAULTS = {
  heightScale: 0.010,
  moistureScale: 0.015,
  warpScale: 0.040,
  water: { level: 0.32, minLakeSize: 12, maxLakeSize: 220 },
  rivers: {
    count: 2,
    sourceMin: 0.66,
    sourceSpacing: 24,
    accumThreshold: 15,
    meanderJitter: 0.20,
    smoothIterations: 2,
    maxWidth: 5,
    widenK: 0.45
  },
  rock: {
    targetRatio: 0.06,
    pOnRock: 0.70,
    blobChance: 0.30,
    ensureMinDeposits: 120
  },
  fertile: {
    areaMin: 4,
    areaMax: 50,
    edgeFeather: 1,
    berryBaseP: 0.06,
    clusterCentersPer1k: 2.0,
    clusterRadius: 4
  }
};
