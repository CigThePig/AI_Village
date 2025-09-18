export const WORLDGEN_DEFAULTS = {
  heightScale: 0.010,
  moistureScale: 0.015,
  warpScale: 0.040,
  water: { level: 0.42, minLakeSize: 18, maxLakeSize: 650 },
  rivers: {
    count: 4,
    sourceMin: 0.58,
    sourceSpacing: 16,
    accumThreshold: 2,
    meanderJitter: 0.32,
    smoothIterations: 4,
    maxWidth: 6,
    widenK: 0.55
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
