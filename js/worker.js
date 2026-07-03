/*
 * worker.js — the heavy pixel crunching runs here so the main thread never freezes.
 *
 * Protocol (main -> worker):
 *   { type: 'setTarget', width, height, buffer }   // the fixed cat image, sent once. buffer transferred.
 *   { type: 'setSource', width, height, buffer }   // the uploaded photo, sent on each new upload. buffer transferred.
 *   { type: 'process', options: { paletteSize, colorSpace } }  // run the recreation with the cached target + source.
 *
 * Protocol (worker -> main):
 *   { type: 'ready' }                                          // worker booted.
 *   { type: 'progress', phase: 'palette'|'mapping', percent }  // 0..100 for the current run.
 *   { type: 'result', width, height, buffer, stats }           // output pixels (buffer transferred back) + stats.
 *   { type: 'error', message }                                 // something went wrong.
 *
 * The target and source pixels are cached in the worker so a control change (e.g. toggling the
 * colour space) can re-run without the main thread re-sending or re-reading the images.
 */

'use strict';

// ---------------------------------------------------------------------------
// Cached state. The cat never changes; the source changes only on a new upload.
// ---------------------------------------------------------------------------
const state = {
  target: null,            // { data: Uint8ClampedArray, width, height }
  source: null,            // { data: Uint8ClampedArray, width, height }
  palette: null,           // cached palette (array of {r,g,b}) for the last paletteSize
  paletteSize: -1,         // the cap the cached palette was built for
};

// ---------------------------------------------------------------------------
// sRGB -> CIELAB conversion (D65). Euclidean distance in LAB approximates Delta E
// and matches human colour perception far better than raw RGB distance, so the
// recreated cat looks much closer to what your eye would call "the nearest colour".
// ---------------------------------------------------------------------------
function srgbToLinear(channel) {
  const u = channel / 255;
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

function labFinv(t) {
  // The nonlinear CIELAB companding function.
  return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
}

function rgbToLab(r, g, b) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);

  // Linear sRGB -> XYZ (D65 primaries).
  let X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  let Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  let Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;

  // Normalise by the D65 reference white.
  X /= 0.95047;
  Y /= 1.00000;
  Z /= 1.08883;

  const fx = labFinv(X);
  const fy = labFinv(Y);
  const fz = labFinv(Z);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  return [L, a, bb];
}

// ---------------------------------------------------------------------------
// Palette building.
//
// We reduce to the cap with MEDIAN CUT rather than uniform sampling. Median cut
// recursively splits the source's colour cube along its longest axis at the
// population-weighted median, so the palette adapts to the source's actual colour
// distribution. Uniform (random/strided) sampling would over-represent whatever
// colour dominates the frame and would likely miss small but important regions
// (a thin sunset streak, a single neon sign). Median cut keeps those.
//
// Each resulting bucket is represented by its population-weighted mean colour. That
// mean lies inside the source's colour hull, so it is effectively a colour "stolen"
// from the source. When the source has fewer unique colours than the cap we skip
// reduction entirely and use the exact source colours.
// ---------------------------------------------------------------------------

// Cap on how many pixels we scan when building the palette. A few-megapixel photo
// has plenty of colour redundancy, so sampling with a stride keeps palette build
// fast without meaningfully changing the resulting palette.
const MAX_PALETTE_SAMPLE = 1000000;

function collectUniqueColors(data, width, height) {
  const totalPx = width * height;
  const stride = totalPx > MAX_PALETTE_SAMPLE ? Math.ceil(totalPx / MAX_PALETTE_SAMPLE) : 1;
  const counts = new Map(); // packed RGB int -> pixel count

  for (let i = 0; i < totalPx; i += stride) {
    const idx = i * 4;
    if (data[idx + 3] === 0) continue; // skip fully transparent pixels
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const colors = new Array(counts.size);
  let i = 0;
  for (const [key, count] of counts) {
    colors[i++] = { r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255, count };
  }
  return colors;
}

function makeBox(cols) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, total = 0;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (c.r < rmin) rmin = c.r;
    if (c.r > rmax) rmax = c.r;
    if (c.g < gmin) gmin = c.g;
    if (c.g > gmax) gmax = c.g;
    if (c.b < bmin) bmin = c.b;
    if (c.b > bmax) bmax = c.b;
    total += c.count;
  }
  return { cols, rmin, rmax, gmin, gmax, bmin, bmax, total };
}

function medianCut(colors, cap, onProgress) {
  let boxes = [makeBox(colors)];

  while (boxes.length < cap) {
    // Split the box that will benefit most: widest side scaled by its population.
    let target = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.cols.length < 2) continue; // a single colour cannot be split
      const longest = Math.max(bx.rmax - bx.rmin, bx.gmax - bx.gmin, bx.bmax - bx.bmin);
      const score = longest * bx.total;
      if (score > bestScore) {
        bestScore = score;
        target = i;
      }
    }
    if (target < 0) break; // nothing left to split

    const box = boxes[target];
    const rr = box.rmax - box.rmin;
    const gr = box.gmax - box.gmin;
    const br = box.bmax - box.bmin;
    const ch = rr >= gr && rr >= br ? 'r' : (gr >= br ? 'g' : 'b');

    box.cols.sort((a, b) => a[ch] - b[ch]);

    // Population-weighted median: split where cumulative pixel count crosses half.
    const half = box.total / 2;
    let acc = 0;
    let splitIdx = 0;
    for (let i = 0; i < box.cols.length; i++) {
      acc += box.cols[i].count;
      if (acc >= half) { splitIdx = i; break; }
    }
    // Guarantee both halves are non-empty.
    if (splitIdx <= 0) splitIdx = 1;
    if (splitIdx >= box.cols.length) splitIdx = box.cols.length - 1;

    const left = makeBox(box.cols.slice(0, splitIdx));
    const right = makeBox(box.cols.slice(splitIdx));
    boxes.splice(target, 1, left, right);

    if (onProgress && (boxes.length & 63) === 0) onProgress(boxes.length / cap);
  }

  // Each bucket -> its population-weighted mean colour.
  return boxes.map((bx) => {
    let r = 0, g = 0, b = 0, t = 0;
    for (let i = 0; i < bx.cols.length; i++) {
      const c = bx.cols[i];
      r += c.r * c.count;
      g += c.g * c.count;
      b += c.b * c.count;
      t += c.count;
    }
    return { r: Math.round(r / t), g: Math.round(g / t), b: Math.round(b / t) };
  });
}

function buildPalette(source, cap, onProgress) {
  const colors = collectUniqueColors(source.data, source.width, source.height);
  if (colors.length === 0) return [];
  if (colors.length <= cap) {
    // Few enough unique colours that every palette entry is an exact source colour.
    return colors.map((c) => ({ r: c.r, g: c.g, b: c.b }));
  }
  return medianCut(colors, cap, onProgress);
}

// ---------------------------------------------------------------------------
// Nearest-colour search. Linear scan over the palette. We only ever call this once
// per UNIQUE target colour thanks to the cache in processImage, so a scan is plenty
// fast for v1. (A k-d tree would help for very large palettes — see TODO below.)
// ---------------------------------------------------------------------------
function nearestLab(lab, palLab) {
  const L = lab[0], A = lab[1], B = lab[2];
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palLab.length; i++) {
    const p = palLab[i];
    const dL = L - p[0];
    const dA = A - p[1];
    const dB = B - p[2];
    const dist = dL * dL + dA * dA + dB * dB;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function nearestRgb(r, g, b, palette) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The main recreation pass.
// ---------------------------------------------------------------------------
function processImage(target, palette, colorSpace, onProgress) {
  // Pre-convert the palette to LAB once when in LAB mode.
  const palLab = colorSpace === 'lab' ? palette.map((c) => rgbToLab(c.r, c.g, c.b)) : null;

  const n = target.width * target.height;
  const tdata = target.data;
  const out = new Uint8ClampedArray(n * 4);

  // Cache keyed by the packed RGB of the target pixel. The cat has far fewer unique
  // colours than pixels, so most lookups are cache hits and cost almost nothing.
  const cache = new Map();
  const usedIndices = new Set(); // which palette colours actually made it into the output

  const progressEvery = Math.max(1, n >> 6); // ~64 progress ticks across the pass

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const r = tdata[idx];
    const g = tdata[idx + 1];
    const b = tdata[idx + 2];
    const key = (r << 16) | (g << 8) | b;

    let pi = cache.get(key);
    if (pi === undefined) {
      pi = colorSpace === 'lab'
        ? nearestLab(rgbToLab(r, g, b), palLab)
        : nearestRgb(r, g, b, palette);
      cache.set(key, pi);
    }

    const pc = palette[pi];
    out[idx] = pc.r;
    out[idx + 1] = pc.g;
    out[idx + 2] = pc.b;
    out[idx + 3] = tdata[idx + 3]; // preserve the cat's original alpha so its edges stay intact
    usedIndices.add(pi);

    if (onProgress && (i % progressEvery) === 0) onProgress(i / n);
  }

  return {
    out,
    stats: {
      paletteSize: palette.length,
      uniqueTargetColors: cache.size,
      uniqueColorsUsed: usedIndices.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Message handling.
// ---------------------------------------------------------------------------
function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function run(options) {
  if (!state.target) throw new Error('Target image not loaded yet.');
  if (!state.source) throw new Error('No source image uploaded yet.');

  const paletteSize = clampPaletteSize(options.paletteSize);
  const colorSpace = options.colorSpace === 'rgb' ? 'rgb' : 'lab';

  // Palette phase. Reuse the cached palette when only the colour space changed.
  post({ type: 'progress', phase: 'palette', percent: 0 });
  if (!state.palette || state.paletteSize !== paletteSize) {
    state.palette = buildPalette(state.source, paletteSize, (frac) => {
      post({ type: 'progress', phase: 'palette', percent: Math.round(frac * 100) });
    });
    state.paletteSize = paletteSize;
  }
  post({ type: 'progress', phase: 'palette', percent: 100 });

  if (state.palette.length === 0) {
    throw new Error('The source image has no opaque pixels to steal colours from.');
  }

  // Mapping phase.
  post({ type: 'progress', phase: 'mapping', percent: 0 });
  const { out, stats } = processImage(state.target, state.palette, colorSpace, (frac) => {
    post({ type: 'progress', phase: 'mapping', percent: Math.round(frac * 100) });
  });
  post({ type: 'progress', phase: 'mapping', percent: 100 });

  post(
    {
      type: 'result',
      width: state.target.width,
      height: state.target.height,
      buffer: out.buffer,
      stats,
    },
    [out.buffer],
  );
}

function clampPaletteSize(n) {
  n = Math.floor(Number(n) || 2048);
  if (n < 2) n = 2;
  if (n > 65536) n = 65536;
  return n;
}

self.onmessage = function (e) {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'setTarget':
        state.target = {
          data: new Uint8ClampedArray(msg.buffer),
          width: msg.width,
          height: msg.height,
        };
        break;

      case 'setSource':
        state.source = {
          data: new Uint8ClampedArray(msg.buffer),
          width: msg.width,
          height: msg.height,
        };
        // A new source invalidates the cached palette.
        state.palette = null;
        state.paletteSize = -1;
        break;

      case 'process':
        run(msg.options || {});
        break;

      default:
        throw new Error('Unknown message type: ' + msg.type);
    }
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

// ---------------------------------------------------------------------------
// STRETCH GOAL STUBS (v1 leaves these unimplemented on purpose).
// ---------------------------------------------------------------------------

// TODO(distribution-match): Instead of pure nearest-colour (which can collapse the
// whole cat onto one dominant source colour), remap so the cat's luminance/tonal
// distribution is preserved while pulling hues from the source. Rough plan: sort
// target pixels by L, sort palette by L, then map along matched quantiles.
// eslint-disable-next-line no-unused-vars
function distributionMatch() { /* not implemented in v1 */ }

// TODO(dither): Optional Floyd-Steinberg error diffusion to reduce banding when the
// palette is small. Would run in a second pass over the output, spreading the
// quantisation error to neighbouring pixels.
// eslint-disable-next-line no-unused-vars
function floydSteinberg() { /* not implemented in v1 */ }

// Announce readiness so the main thread knows the worker booted.
post({ type: 'ready' });
