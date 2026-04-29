import { ENTITY_TILE_PX, TILE } from './constants.js';
import { context2d } from './canvas.js';
import { hash2, irnd, seededFrom } from './rng.js';

// Per-tile variant count for ground kinds that support visual variation. Three
// variants is enough to break the obvious 192×192 stamping pattern without
// inflating the bake time meaningfully.
const GROUND_VARIANTS = 3;
const TREE_VARIANTS = 3;

function makeIrand(rng) {
  if (!rng) return irnd;
  return (a, b) => ((rng() * (b - a + 1)) | 0) + a;
}

const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'];

function normalizeSeason(season) {
  const n = Number.isFinite(season) ? Math.floor(season) : 0;
  return ((n % 4) + 4) % 4;
}

function seasonName(season) {
  return SEASON_NAMES[normalizeSeason(season)] || 'spring';
}

const Tileset = {
  base: {},
  baseBySeason: [{}, {}, {}, {}],
  waterOverlay: [],
  waterOverlayBySeason: [[], [], [], []],
  zoneGlyphs: {},
  villagerSprites: {},
  sprite: {
    tree: null,
    treeBySeason: [],
    berry: null,
    berryBySeason: [],
    sprout: [],
    sproutBySeason: [[], [], [], []],
    animals: {}
  }
};

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function px(g, x, y, c) {
  if (!g) return;
  g.fillStyle = c;
  g.fillRect(x, y, 1, 1);
}

function rect(g, x, y, w, h, c) {
  if (!g) return;
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

function makeSprite(w, h, drawFn) {
  const c = makeCanvas(w, h);
  const g = context2d(c);
  if (!g) return c;
  if (typeof drawFn === 'function') drawFn(g);
  return c;
}

const SHADOW_TEXTURE = (() => {
  const size = 128;
  const canvas = makeCanvas(size, size);
  const g = context2d(canvas);
  if (!g) return null;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2;
  const gradient = g.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  return canvas;
})();

const SEASON_PALETTES = [
  {
    name: 'spring',
    grass: {
      base: '#2d6a3a',
      blades: ['#449152', '#58a45e', '#85c180', '#327a44'],
      shadow: '#1f4a2a',
      flowers: ['#f0dd9a', '#f3bcd4', '#cfe9f6']
    },
    forest: {
      base: '#234f2c',
      blades: ['#316f3d', '#418c4f', '#5ea66a'],
      shadow: '#173a22'
    },
    fertile: {
      base: '#327443',
      blades: ['#56a566', '#418f50', '#86c780'],
      shadow: '#225a31'
    },
    meadow: {
      base: '#3c7e47',
      blades: ['#62ac6c', '#4a9658', '#94ce85'],
      shadow: '#2a5e35',
      flowers: ['#f6ecaa', '#f5b8d2', '#c5ecf6', '#dcc4ee']
    },
    marsh: {
      base: '#255940',
      blades: ['#357953', '#2d6849', '#4d8c65'],
      shadow: '#183b2a',
      puddle: '#34615e'
    },
    sand: {
      base: '#c4a761',
      specks: ['#d8c17c', '#a98c4a', '#edd691']
    },
    rock: {
      base: '#626c75',
      specks: ['#8d98a2', '#4e5861', '#74808b']
    },
    water: {
      base: '#155a7c',
      deep: '#0e3f5b',
      ripple: '#79c7ef'
    },
    farmland: {
      soil: '#563d26',
      furrow: '#3d2a1a',
      highlight: '#745133'
    },
    snow: {
      base: '#d9e8f7',
      specks: ['#c8d8e8', '#eef8ff']
    },
    tree: {
      trunk: '#5e3b1d',
      barkDark: '#41260f',
      leafDark: '#22552d',
      leafMid: '#347340',
      leafLight: '#6caa6c',
      accent: '#bedbb0',
      snow: null
    },
    berry: {
      leafDark: '#2c5f33',
      leafMid: '#3a7a44',
      leafLight: '#5da265',
      fruit: '#a64458',
      fruitLight: '#d3768c',
      snow: null
    },
    crop: {
      stem: '#6ba35a',
      leaf: '#90c275',
      head: '#d2b95a',
      frost: null
    }
  },
  {
    name: 'summer',
    grass: {
      base: '#2c6533',
      blades: ['#3e8744', '#4d9b4f', '#75b465', '#2d703a'],
      shadow: '#1d4524',
      flowers: ['#ecd07a', '#eda5c2']
    },
    forest: {
      base: '#1f4d28',
      blades: ['#306a39', '#3d8044', '#549858'],
      shadow: '#15391c'
    },
    fertile: {
      base: '#316b38',
      blades: ['#509853', '#418548', '#80b573'],
      shadow: '#1f4628'
    },
    meadow: {
      base: '#3a763f',
      blades: ['#5d9b5d', '#4b8c50', '#82bd72'],
      shadow: '#28522e',
      flowers: ['#f0d176', '#e7a4be', '#f3e09a']
    },
    marsh: {
      base: '#254f38',
      blades: ['#34704d', '#2d6044', '#4a805d'],
      shadow: '#173625',
      puddle: '#2f5657'
    },
    sand: {
      base: '#c9aa61',
      specks: ['#e0c87e', '#ac8f4a', '#f1d98d']
    },
    rock: {
      base: '#5f6870',
      specks: ['#89949d', '#4d555d', '#717b84']
    },
    water: {
      base: '#145273',
      deep: '#0b3a54',
      ripple: '#68b9e5'
    },
    farmland: {
      soil: '#523720',
      furrow: '#392616',
      highlight: '#6d492b'
    },
    snow: {
      base: '#d3e1ef',
      specks: ['#c0cfdd', '#eaf3fb']
    },
    tree: {
      trunk: '#56331c',
      barkDark: '#3a2110',
      leafDark: '#1d4624',
      leafMid: '#2d6a33',
      leafLight: '#549952',
      accent: '#94c481',
      snow: null
    },
    berry: {
      leafDark: '#28552c',
      leafMid: '#356c39',
      leafLight: '#5b9858',
      fruit: '#94364a',
      fruitLight: '#c8576c',
      snow: null
    },
    crop: {
      stem: '#5f924a',
      leaf: '#85b25e',
      head: '#d6bc5a',
      frost: null
    }
  },
  {
    name: 'autumn',
    grass: {
      base: '#675f35',
      blades: ['#7a6f3a', '#947c3d', '#a87a3a', '#5b552f'],
      shadow: '#443f25',
      leaves: ['#c66e2c', '#a8462a', '#d3923a']
    },
    forest: {
      base: '#564e2c',
      blades: ['#7a6233', '#9e6b34', '#b07d3a'],
      shadow: '#3a3320'
    },
    fertile: {
      base: '#675e36',
      blades: ['#86763f', '#9a7e3e', '#b58940'],
      shadow: '#443d25'
    },
    meadow: {
      base: '#6f6238',
      blades: ['#94793c', '#ad853f', '#c39146'],
      shadow: '#4a4028',
      flowers: ['#d8a85a', '#c97044']
    },
    marsh: {
      base: '#455139',
      blades: ['#667148', '#76693f', '#8a6b3d'],
      shadow: '#303827',
      puddle: '#435a56'
    },
    sand: {
      base: '#b99858',
      specks: ['#c8aa68', '#9f8045', '#dfc47a']
    },
    rock: {
      base: '#626468',
      specks: ['#888b90', '#4d5054', '#777a7f']
    },
    water: {
      base: '#174d66',
      deep: '#0d384a',
      ripple: '#6aa8c8'
    },
    farmland: {
      soil: '#4e321e',
      furrow: '#362114',
      highlight: '#69442a'
    },
    snow: {
      base: '#d3dfec',
      specks: ['#c3cfdb', '#eef5fb']
    },
    tree: {
      trunk: '#553118',
      barkDark: '#371e0e',
      leafDark: '#7c3923',
      leafMid: '#a6552d',
      leafLight: '#c98a3c',
      accent: '#e2b15a',
      snow: null
    },
    berry: {
      leafDark: '#564a2b',
      leafMid: '#766332',
      leafLight: '#a87c3c',
      fruit: '#852b39',
      fruitLight: '#bb5160',
      snow: null
    },
    crop: {
      stem: '#8a703e',
      leaf: '#a78743',
      head: '#d2ab52',
      frost: null
    }
  },
  {
    name: 'winter',
    grass: {
      base: '#b9cddd',
      blades: ['#d7e6f1', '#a8bdcc', '#eef7fb', '#91a7b7'],
      shadow: '#93aabc',
      snowFlecks: ['#f8fdff', '#dcecf7']
    },
    forest: {
      base: '#aebfcd',
      blades: ['#cbdbe7', '#91a5b5', '#eaf5fb'],
      shadow: '#879cac'
    },
    fertile: {
      base: '#b5c6d3',
      blades: ['#d5e2ec', '#9cafbd', '#edf6fb'],
      shadow: '#8ba0b0'
    },
    meadow: {
      base: '#bdcfdb',
      blades: ['#d9e8f2', '#a5b9c7', '#eff8fc'],
      shadow: '#95aaba',
      flowers: []
    },
    marsh: {
      base: '#91a9b5',
      blades: ['#b5c9d4', '#839ca9', '#d5e5ec'],
      shadow: '#6f8793',
      puddle: '#73919f'
    },
    sand: {
      base: '#c4c7bd',
      specks: ['#e5e9e5', '#aaaea7', '#d6dad2']
    },
    rock: {
      base: '#68727c',
      specks: ['#a1adb6', '#515b65', '#d9e5ee']
    },
    water: {
      base: '#8fb6c8',
      deep: '#5d879c',
      ripple: '#d8f4ff'
    },
    farmland: {
      soil: '#81756a',
      furrow: '#6b625a',
      highlight: '#b9c9d4'
    },
    snow: {
      base: '#dcebf8',
      specks: ['#c8d9e8', '#f6fdff']
    },
    tree: {
      trunk: '#4f321c',
      barkDark: '#332011',
      leafDark: '#6f8290',
      leafMid: '#91a7b5',
      leafLight: '#dcecf7',
      accent: '#f8fdff',
      snow: '#eef8ff'
    },
    berry: {
      leafDark: '#71818b',
      leafMid: '#9aacb8',
      leafLight: '#dcebf4',
      fruit: '#8e3345',
      fruitLight: '#c55b6c',
      snow: '#f4fbff'
    },
    crop: {
      stem: '#8da18a',
      leaf: '#b6c6ad',
      head: '#d6d4a5',
      frost: '#eef8ff'
    }
  }
];

function noisePixels(g, colors, count, alpha = 1, irand = irnd) {
  if (!g || !colors || !colors.length) return;
  const oldAlpha = g.globalAlpha;
  g.globalAlpha = alpha;
  for (let i = 0; i < count; i++) {
    px(g, irand(0, TILE - 1), irand(0, TILE - 1), colors[i % colors.length]);
  }
  g.globalAlpha = oldAlpha;
}

function grassClumps(g, colors, count, irand = irnd) {
  if (!g || !colors || !colors.length) return;
  for (let i = 0; i < count; i++) {
    const x = irand(0, TILE - 2);
    const y = irand(2, TILE - 3);
    const c = colors[i % colors.length];
    px(g, x, y, c);
    if (i % 3 === 0) px(g, x + 1, y, c);
    if (i % 5 === 0 && y > 0) px(g, x, y - 1, c);
  }
}

function cornerShade(g, color) {
  if (!g) return;
  const oldAlpha = g.globalAlpha;
  g.globalAlpha = 0.22;
  rect(g, 0, TILE - 5, TILE, 5, color);
  rect(g, TILE - 4, 0, 4, TILE, color);
  g.globalAlpha = oldAlpha;
}

function snowDust(g, colors, count = 22, irand = irnd) {
  if (!g || !colors || !colors.length) return;
  const oldAlpha = g.globalAlpha;
  g.globalAlpha = 0.55;
  for (let i = 0; i < count; i++) {
    const x = irand(0, TILE - 2);
    const y = irand(0, TILE - 2);
    const c = colors[i % colors.length];
    px(g, x, y, c);
    if (i % 4 === 0) px(g, x + 1, y, c);
  }
  g.globalAlpha = oldAlpha;
}

function leafScatter(g, colors, count = 8, irand = irnd) {
  if (!g || !colors || !colors.length) return;
  for (let i = 0; i < count; i++) {
    const x = irand(1, TILE - 3);
    const y = irand(2, TILE - 3);
    const c = colors[i % colors.length];
    px(g, x, y, c);
    if (i % 2 === 0) px(g, x + 1, y, c);
  }
}

function flowerScatter(g, colors, count = 5, irand = irnd) {
  if (!g || !colors || !colors.length) return;
  const oldAlpha = g.globalAlpha;
  g.globalAlpha = 0.9;
  for (let i = 0; i < count; i++) {
    const x = irand(1, TILE - 2);
    const y = irand(2, TILE - 3);
    const c = colors[i % colors.length];
    px(g, x, y, c);
    if (i % 3 === 0) px(g, x + 1, y, c);
  }
  g.globalAlpha = oldAlpha;
}

function makeGroundTile(palette, kind, variantSeed = 0) {
  const c = makeCanvas(TILE, TILE);
  const g = context2d(c);
  if (!g) return c;

  // Each variant gets its own deterministic RNG so blade/flower/leaf noise
  // differs between variants but is reproducible across reloads.
  const irand = makeIrand(seededFrom(variantSeed));

  const p = palette[kind] || palette.grass;
  rect(g, 0, 0, TILE, TILE, p.base);

  grassClumps(g, p.blades || [], kind === 'forest' ? 32 : 42, irand);

  if (kind === 'marsh' && p.puddle) {
    const oldAlpha = g.globalAlpha;
    g.globalAlpha = 0.28;
    rect(g, 4, 8, 7, 2, p.puddle);
    rect(g, 17, 18, 8, 2, p.puddle);
    rect(g, 12, 25, 5, 1, p.puddle);
    g.globalAlpha = oldAlpha;
  }

  if (palette.name === 'spring' && kind === 'meadow') {
    flowerScatter(g, p.flowers, 8, irand);
  } else if (palette.name === 'summer' && kind === 'meadow') {
    flowerScatter(g, p.flowers, 5, irand);
  }

  if (palette.name === 'autumn') {
    leafScatter(g, p.leaves || palette.grass.leaves, kind === 'forest' ? 12 : 7, irand);
  }

  if (palette.name === 'winter') {
    snowDust(g, p.snowFlecks || palette.grass.snowFlecks, kind === 'forest' ? 26 : 34, irand);
  }

  cornerShade(g, p.shadow || palette.grass.shadow);
  return c;
}

function makeSandTile(palette) {
  const c = makeCanvas(TILE, TILE);
  const g = context2d(c);
  if (!g) return c;
  const p = palette.sand;
  rect(g, 0, 0, TILE, TILE, p.base);
  noisePixels(g, p.specks, 32, 0.8);
  if (palette.name === 'winter') snowDust(g, palette.snow.specks, 12);
  cornerShade(g, '#927a45');
  return c;
}

function makeSnowTile(palette) {
  const c = makeCanvas(TILE, TILE);
  const g = context2d(c);
  if (!g) return c;
  const p = palette.snow;
  rect(g, 0, 0, TILE, TILE, p.base);
  snowDust(g, p.specks, 36);
  cornerShade(g, '#b9cadc');
  return c;
}

function makeRockTile(palette) {
  const c = makeCanvas(TILE, TILE);
  const g = context2d(c);
  if (!g) return c;
  const p = palette.rock;
  rect(g, 0, 0, TILE, TILE, p.base);
  noisePixels(g, p.specks, 36, 0.85);

  g.globalAlpha = 0.18;
  rect(g, 3, 4, 12, 3, '#ffffff');
  rect(g, 14, 18, 10, 2, '#ffffff');
  g.globalAlpha = 1;

  if (palette.name === 'winter') snowDust(g, palette.snow.specks, 16);
  cornerShade(g, '#454d55');
  return c;
}

function makeWaterBase(palette) {
  const c = makeCanvas(TILE, TILE);
  const g = context2d(c);
  if (!g) return c;
  const p = palette.water;
  rect(g, 0, 0, TILE, TILE, p.base);

  g.globalAlpha = 0.28;
  rect(g, 0, TILE - 9, TILE, 9, p.deep);
  rect(g, 0, 0, TILE, 4, '#ffffff');
  g.globalAlpha = 1;

  noisePixels(g, [p.deep, p.ripple], 18, palette.name === 'winter' ? 0.35 : 0.2);

  if (palette.name === 'winter') {
    g.globalAlpha = 0.32;
    rect(g, 2, 5, 12, 2, '#e8fbff');
    rect(g, 18, 20, 10, 2, '#e8fbff');
    g.globalAlpha = 1;
  }

  return c;
}

function makeWaterOverlayFrames(palette) {
  const frames = [];
  const p = palette.water;

  for (let f = 0; f < 4; f++) {
    const c = makeCanvas(TILE, TILE);
    const g = context2d(c);
    if (!g) {
      frames.push(c);
      continue;
    }

    g.globalAlpha = palette.name === 'winter' ? 0.18 : 0.26;
    g.strokeStyle = p.ripple;
    g.lineWidth = 1;

    for (let i = 0; i < 3; i++) {
      const y = 6 + i * 9 + f;
      g.beginPath();
      g.moveTo(-2, y);
      g.quadraticCurveTo(TILE * 0.35, y + 3, TILE * 0.7, y);
      g.quadraticCurveTo(TILE * 0.88, y - 2, TILE + 2, y + 1);
      g.stroke();
    }

    g.globalAlpha = 1;
    frames.push(c);
  }

  return frames;
}

function makeFarmlandTile(palette) {
  const c = makeCanvas(TILE, TILE);
  const g = context2d(c);
  if (!g) return c;

  const p = palette.farmland;
  rect(g, 0, 0, TILE, TILE, p.soil);

  for (let y = 4; y < TILE; y += 6) {
    rect(g, 0, y, TILE, 2, p.furrow);
    rect(g, 0, y - 1, TILE, 1, p.highlight);
  }

  noisePixels(g, [p.furrow, p.highlight], 24, 0.35);

  if (palette.name === 'autumn') {
    leafScatter(g, palette.grass.leaves, 7);
  }

  if (palette.name === 'winter') {
    snowDust(g, palette.snow.specks, 20);
  }

  cornerShade(g, p.furrow);
  return c;
}
function drawCanopyBlob(g, x, y, w, h, color) {
  rect(g, x + 2, y, w - 4, h, color);
  rect(g, x, y + 2, w, h - 4, color);
  rect(g, x + 1, y + 1, w - 2, h - 2, color);
}

// Sun comes from the upper-left (LIGHT_VECTOR ≈ (-0.75, -0.65)), so canopy
// rim highlights belong on the upper-left edge — that anchor point is shared
// across all three silhouette variants so a forest reads as one lit scene.
function drawCanopyRim(g, x, y, w, h, color) {
  rect(g, x + 1, y, Math.max(2, w - 4), 1, color);
  rect(g, x, y + 1, 1, Math.max(2, h - 4), color);
}

function drawTreeRound(g, p) {
  rect(g, 14, 17, 5, 10, p.trunk);
  rect(g, 13, 22, 3, 4, p.barkDark);
  rect(g, 18, 21, 3, 5, p.barkDark);
  rect(g, 12, 26, 4, 2, p.barkDark);
  rect(g, 18, 26, 4, 2, p.barkDark);

  drawCanopyBlob(g, 8, 8, 17, 13, p.leafDark);
  drawCanopyBlob(g, 6, 13, 21, 10, p.leafMid);
  drawCanopyBlob(g, 11, 5, 12, 10, p.leafMid);
  rect(g, 12, 7, 7, 2, p.leafLight);
  rect(g, 9, 15, 6, 2, p.leafLight);
  rect(g, 18, 13, 5, 2, p.accent);
  drawCanopyRim(g, 8, 6, 14, 4, p.accent);
  px(g, 22, 18, p.leafDark);
  px(g, 7, 17, p.leafDark);
}

function drawTreeConical(g, p) {
  rect(g, 15, 19, 3, 8, p.trunk);
  rect(g, 14, 23, 2, 4, p.barkDark);
  rect(g, 18, 23, 2, 4, p.barkDark);

  // Three stacked tiers, narrowing toward the top.
  drawCanopyBlob(g, 9, 17, 15, 7, p.leafDark);
  drawCanopyBlob(g, 11, 11, 11, 7, p.leafMid);
  drawCanopyBlob(g, 13, 5, 7, 7, p.leafMid);
  rect(g, 13, 17, 6, 2, p.leafLight);
  rect(g, 14, 11, 5, 2, p.leafLight);
  rect(g, 15, 6, 3, 2, p.accent);
  drawCanopyRim(g, 11, 11, 6, 2, p.accent);
  drawCanopyRim(g, 9, 17, 6, 2, p.accent);
  px(g, 23, 22, p.leafDark);
  px(g, 8, 22, p.leafDark);
}

function drawTreeSparse(g, p) {
  rect(g, 14, 14, 4, 13, p.trunk);
  rect(g, 13, 18, 2, 6, p.barkDark);
  rect(g, 17, 20, 2, 4, p.barkDark);
  rect(g, 12, 26, 4, 2, p.barkDark);
  rect(g, 18, 26, 4, 2, p.barkDark);

  // Branch silhouettes peeking through a thinner canopy.
  rect(g, 8, 14, 6, 1, p.barkDark);
  rect(g, 18, 12, 6, 1, p.barkDark);

  drawCanopyBlob(g, 7, 7, 9, 8, p.leafDark);
  drawCanopyBlob(g, 16, 8, 10, 9, p.leafDark);
  drawCanopyBlob(g, 11, 4, 10, 8, p.leafMid);
  rect(g, 8, 9, 5, 2, p.leafLight);
  rect(g, 18, 10, 5, 2, p.leafLight);
  rect(g, 13, 5, 5, 2, p.accent);
  drawCanopyRim(g, 7, 5, 7, 3, p.accent);
}

function drawTreeWinter(g, p) {
  rect(g, 14, 17, 5, 10, p.trunk);
  rect(g, 13, 22, 3, 4, p.barkDark);
  rect(g, 18, 21, 3, 5, p.barkDark);
  rect(g, 12, 26, 4, 2, p.barkDark);
  rect(g, 18, 26, 4, 2, p.barkDark);

  rect(g, 15, 8, 2, 10, p.barkDark);
  rect(g, 10, 12, 7, 2, p.barkDark);
  rect(g, 17, 13, 7, 2, p.barkDark);
  rect(g, 8, 9, 4, 2, p.snow);
  rect(g, 19, 10, 7, 2, p.snow);
  rect(g, 12, 5, 8, 3, p.leafLight);
  rect(g, 9, 8, 14, 4, p.leafMid);
  rect(g, 7, 13, 18, 4, p.leafDark);
  rect(g, 10, 7, 8, 1, p.accent);
  rect(g, 7, 12, 12, 1, p.accent);
}

function drawTreeVariant(g, season = 0, variant = 0) {
  if (!g) return;
  const palette = SEASON_PALETTES[normalizeSeason(season)];
  const p = palette.tree;
  const winter = palette.name === 'winter';

  g.globalAlpha = 0.25;
  rect(g, 8, 25, 17, 3, '#000000');
  g.globalAlpha = 1;

  if (winter) {
    drawTreeWinter(g, p);
    return;
  }

  const v = ((variant | 0) % TREE_VARIANTS + TREE_VARIANTS) % TREE_VARIANTS;
  if (v === 1) drawTreeConical(g, p);
  else if (v === 2) drawTreeSparse(g, p);
  else drawTreeRound(g, p);
}

function drawBerry(g, season = 0) {
  if (!g) return;
  const palette = SEASON_PALETTES[normalizeSeason(season)];
  const p = palette.berry;
  const winter = palette.name === 'winter';

  g.globalAlpha = 0.22;
  rect(g, 8, 25, 17, 3, '#000000');
  g.globalAlpha = 1;

  drawCanopyBlob(g, 8, 15, 16, 10, p.leafDark);
  drawCanopyBlob(g, 6, 18, 20, 8, p.leafMid);
  rect(g, 10, 16, 7, 2, p.leafLight);
  rect(g, 17, 20, 6, 2, p.leafLight);

  if (!winter) {
    rect(g, 11, 18, 2, 2, p.fruit);
    rect(g, 18, 19, 2, 2, p.fruit);
    rect(g, 15, 22, 2, 2, p.fruitLight);
    if (palette.name !== 'spring') rect(g, 22, 22, 2, 2, p.fruit);
  } else {
    rect(g, 8, 15, 10, 2, p.snow);
    rect(g, 15, 19, 10, 2, p.snow);
    rect(g, 13, 23, 2, 2, p.fruit);
  }
}

function drawSproutOn(g, stage, season = 0) {
  if (!g) return;
  const s = Math.min(3, Math.max(1, Math.floor(stage)));
  const palette = SEASON_PALETTES[normalizeSeason(season)];
  const p = palette.crop;

  g.globalAlpha = 0.18;
  rect(g, 8, 25, 17, 2, '#000000');
  g.globalAlpha = 1;

  if (s === 1) {
    rect(g, 15, 19, 2, 6, p.stem);
    rect(g, 12, 20, 4, 2, p.leaf);
    rect(g, 17, 18, 4, 2, p.leaf);
  } else if (s === 2) {
    for (let x = 9; x <= 21; x += 4) {
      rect(g, x, 16, 2, 9, p.stem);
      rect(g, x - 2, 18, 4, 2, p.leaf);
      rect(g, x + 1, 20, 4, 2, p.leaf);
    }
  } else {
    for (let x = 8; x <= 22; x += 4) {
      rect(g, x, 13, 2, 12, p.stem);
      rect(g, x - 2, 16, 4, 2, p.leaf);
      rect(g, x + 1, 19, 4, 2, p.leaf);
      rect(g, x - 1, 11, 4, 3, p.head);
    }
  }

  if (p.frost) {
    g.globalAlpha = 0.55;
    rect(g, 10, 13, 13, 1, p.frost);
    rect(g, 12, 18, 10, 1, p.frost);
    g.globalAlpha = 1;
  }
}
function makeZoneGlyphs(){ const farm=makeCanvas(8,8), f=context2d(farm); rect(f,0,0,8,8,'rgba(0,0,0,0)'); px(f,3,6,'#9dd47a'); px(f,4,6,'#9dd47a'); px(f,3,5,'#73b85d'); px(f,4,5,'#73b85d'); px(f,3,4,'#5aa34b'); const cut=makeCanvas(8,8), c=context2d(cut); rect(c,0,0,8,8,'rgba(0,0,0,0)'); rect(c,2,2,4,1,'#caa56a'); rect(c,3,1,2,1,'#8f6934'); const mine=makeCanvas(8,8), m=context2d(mine); rect(m,0,0,8,8,'rgba(0,0,0,0)'); rect(m,2,2,4,1,'#9aa3ad'); rect(m,3,3,2,1,'#6d7782'); Tileset.zoneGlyphs={farm,cut,mine}; }
function makeVillagerFrames() {
  function role(options) {
    const {
      shirt,
      shirtDark,
      pants,
      hair,
      hat,
      skin = '#f1d4b6'
    } = options;

    const frames = [];

    for (let f = 0; f < 3; f++) {
      const c = makeCanvas(16, 16);
      const g = context2d(c);
      if (!g) {
        frames.push(c);
        continue;
      }

      const armSwing = f === 1 ? 1 : f === 2 ? -1 : 0;
      const legA = f === 1 ? 1 : 0;
      const legB = f === 2 ? 1 : 0;

      g.globalAlpha = 0.2;
      rect(g, 4, 14, 8, 1, '#000000');
      g.globalAlpha = 1;

      rect(g, 6, 4, 4, 4, skin);
      rect(g, 6, 3, 4, 2, hair);

      if (hat) {
        rect(g, 5, 2, 6, 1, hat);
        rect(g, 6, 1, 4, 2, hat);
      }

      px(g, 7, 5, '#35251d');
      px(g, 9, 5, '#35251d');

      rect(g, 5, 8, 6, 4, shirt);
      rect(g, 5, 11, 6, 1, shirtDark || shirt);

      rect(g, 4, 8 + armSwing, 1, 4, shirtDark || shirt);
      rect(g, 11, 8 - armSwing, 1, 4, shirtDark || shirt);

      rect(g, 5, 12, 2, 3 + legA, pants);
      rect(g, 9, 12, 2, 3 + legB, pants);

      rect(g, 5, 15, 2, 1, '#2b2524');
      rect(g, 9, 15, 2, 1, '#2b2524');

      frames.push(c);
    }

    return frames;
  }

  Tileset.villagerSprites.farmer = role({
    shirt: '#3aa357',
    shirtDark: '#2b7c42',
    pants: '#4b4631',
    hair: '#7a4d27',
    hat: '#d6cf74'
  });

  Tileset.villagerSprites.worker = role({
    shirt: '#a36b3a',
    shirtDark: '#704825',
    pants: '#3f3a32',
    hair: '#5a3820',
    hat: '#8f7440'
  });

  Tileset.villagerSprites.explorer = role({
    shirt: '#3a6aa3',
    shirtDark: '#284d7a',
    pants: '#38394a',
    hair: '#3b2a1d',
    hat: '#5a78a8'
  });

  Tileset.villagerSprites.sleepy = role({
    shirt: '#777777',
    shirtDark: '#555555',
    pants: '#3f3f4f',
    hair: '#444444',
    hat: null
  });
}

function drawDeer(g) {
  if (!g) return;

  g.globalAlpha = 0.22;
  rect(g, 8, 25, 17, 3, '#000000');
  g.globalAlpha = 1;

  const body = '#8b5a35';
  const dark = '#5b351f';
  const light = '#c08a5a';

  rect(g, 10, 15, 12, 8, body);
  rect(g, 13, 13, 6, 4, body);
  rect(g, 15, 11, 4, 3, body);
  rect(g, 11, 23, 2, 5, dark);
  rect(g, 19, 23, 2, 5, dark);
  rect(g, 10, 18, 10, 2, light);
  rect(g, 18, 10, 2, 2, light);
  px(g, 17, 12, '#111111');

  rect(g, 13, 9, 1, 3, dark);
  rect(g, 20, 9, 1, 3, dark);
  rect(g, 12, 8, 3, 1, dark);
  rect(g, 20, 8, 3, 1, dark);
  rect(g, 7, 17, 3, 2, body);
  px(g, 6, 17, light);
}

function drawBoar(g) {
  if (!g) return;

  g.globalAlpha = 0.25;
  rect(g, 8, 25, 18, 3, '#000000');
  g.globalAlpha = 1;

  const body = '#5b3b2b';
  const dark = '#352015';
  const light = '#8a634f';

  rect(g, 9, 16, 15, 8, body);
  rect(g, 12, 13, 8, 4, body);
  rect(g, 7, 18, 4, 4, body);
  rect(g, 6, 20, 3, 2, light);
  rect(g, 10, 24, 2, 4, dark);
  rect(g, 21, 24, 2, 4, dark);

  rect(g, 12, 12, 2, 2, dark);
  rect(g, 15, 11, 2, 2, dark);
  rect(g, 18, 12, 2, 2, dark);
  px(g, 8, 18, '#111111');
  px(g, 6, 22, '#e8d8c8');
}

function buildTileset() {
  try {
    for (let s = 0; s < 4; s++) {
      const palette = SEASON_PALETTES[s];
      const base = {};

      // Grassy tiles get GROUND_VARIANTS unique bakes so the static albedo
      // doesn't read as a stamped grid. Variant 0 doubles as the legacy
      // single-canvas fallback for any consumer that picks a fixed index.
      const variants = (kind) => Array.from(
        { length: GROUND_VARIANTS },
        (_, v) => makeGroundTile(palette, kind, hash2(s, v, kind.charCodeAt(0)))
      );
      base.grass = variants('grass');
      base.forest = variants('forest');
      base.fertile = variants('fertile');
      base.meadow = variants('meadow');
      base.marsh = variants('marsh');
      base.sand = [makeSandTile(palette)];
      base.snow = [makeSnowTile(palette)];
      base.rock = [makeRockTile(palette)];
      base.water = [makeWaterBase(palette)];
      base.farmland = [makeFarmlandTile(palette)];

      Tileset.baseBySeason[s] = base;
      Tileset.waterOverlayBySeason[s] = makeWaterOverlayFrames(palette);

      Tileset.sprite.treeBySeason[s] = Array.from(
        { length: TREE_VARIANTS },
        (_, v) => makeSprite(
          ENTITY_TILE_PX,
          ENTITY_TILE_PX,
          g => drawTreeVariant(g, s, v)
        )
      );

      Tileset.sprite.berryBySeason[s] = makeSprite(
        ENTITY_TILE_PX,
        ENTITY_TILE_PX,
        g => drawBerry(g, s)
      );

      Tileset.sprite.sproutBySeason[s] = [
        makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, g => drawSproutOn(g, 1, s)),
        makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, g => drawSproutOn(g, 2, s)),
        makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, g => drawSproutOn(g, 3, s))
      ];
    }

    Tileset.base = Tileset.baseBySeason[0];
    Tileset.waterOverlay = Tileset.waterOverlayBySeason[0];

    Tileset.sprite.tree = Tileset.sprite.treeBySeason[0]?.[0] || null;
    Tileset.sprite.berry = Tileset.sprite.berryBySeason[0];
    Tileset.sprite.sprout = Tileset.sprite.sproutBySeason[0];
  } catch (e) {
    console.warn('seasonal tileset generation failed', e);
  }

  try {
    makeZoneGlyphs();
  } catch (e) {
    console.warn('zones', e);
  }

  try {
    makeVillagerFrames();
  } catch (e) {
    console.warn('villagers', e);
  }

  try {
    Tileset.sprite.animals = {
      deer: makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, drawDeer),
      boar: makeSprite(ENTITY_TILE_PX, ENTITY_TILE_PX, drawBoar)
    };
  } catch (e) {
    console.warn('animal sprites', e);
  }
}

export {
  Tileset,
  SHADOW_TEXTURE,
  buildTileset,
  makeCanvas,
  px,
  rect,
  normalizeSeason,
  seasonName
};
