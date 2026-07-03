/*
 * main.js — UI wiring and orchestration.
 *
 * Responsibilities:
 *   - Load the fixed cat image (assets/xiaojie.jpg) and hand its pixels to the worker.
 *   - Accept a source photo (drag-and-drop or file picker), read its pixels, hand them over.
 *   - Drive the worker (process on upload and on control change, debounced).
 *   - Show progress, render the result, report stats, and offer a PNG download.
 *
 * All the heavy pixel work lives in js/worker.js. This file stays on the main thread
 * and only touches the DOM and small buffers.
 */

'use strict';

const TARGET_SRC = 'assets/xiaojie.jpg';
const MAX_SOURCE_DIM = 4096; // guard against enormous uploads blowing past canvas limits
const CONTROL_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// DOM references.
// ---------------------------------------------------------------------------
const el = {
  targetCanvas: document.getElementById('target-canvas'),
  sourceCanvas: document.getElementById('source-canvas'),
  resultCanvas: document.getElementById('result-canvas'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  sourcePlaceholder: document.getElementById('source-placeholder'),
  resultPlaceholder: document.getElementById('result-placeholder'),
  paletteSize: document.getElementById('palette-size'),
  paletteSizeValue: document.getElementById('palette-size-value'),
  colorspaceInputs: Array.from(document.querySelectorAll('input[name="colorspace"]')),
  downloadBtn: document.getElementById('download-btn'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progress-bar'),
  progressLabel: document.getElementById('progress-label'),
  status: document.getElementById('status'),
  statSourceRes: document.getElementById('stat-source-res'),
  statUniqueColors: document.getElementById('stat-unique-colors'),
  statTime: document.getElementById('stat-time'),
};

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------
let worker = null;
let targetReady = false;   // cat pixels handed to the worker
let sourceReady = false;   // a source photo has been handed to the worker
let busy = false;          // a run is in flight
let pendingRun = false;    // a run was requested while busy; coalesce into one follow-up
let runStart = 0;          // performance.now() at run start, for the timing stat
let debounceTimer = null;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function setStatus(message, kind) {
  // kind: 'info' | 'error' | '' (cleared)
  // The element stays in the DOM (never `hidden`/display:none) so it remains in the
  // accessibility tree and screen readers announce text as it is inserted. When the
  // message is empty the `.status:empty` CSS rule collapses it to zero visual footprint.
  el.status.textContent = message || '';
  el.status.className = 'status' + (kind ? ' status--' + kind : '');
}

function showProgress(show) {
  el.progress.hidden = !show;
  if (!show) {
    el.progressBar.style.width = '0%';
  }
}

function setProgress(phase, percent) {
  // Palette build is the first ~40% of the bar, mapping the remaining ~60%.
  const overall = phase === 'palette' ? percent * 0.4 : 40 + percent * 0.6;
  el.progressBar.style.width = Math.round(overall) + '%';
  el.progressLabel.textContent =
    (phase === 'palette' ? 'Building palette' : 'Recreating Xiaojie') + ' ' + Math.round(overall) + '%';
}

function readImageData(image, maxDim) {
  // Draw an image element to an offscreen canvas (downscaled if huge) and read RGBA.
  let w = image.naturalWidth || image.width;
  let h = image.naturalHeight || image.height;
  if (maxDim && Math.max(w, h) > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function drawScaledPreview(canvas, imageData) {
  // Render an ImageData into a preview canvas at the image's own resolution.
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  canvas.hidden = false;
}

// ---------------------------------------------------------------------------
// Worker setup.
// ---------------------------------------------------------------------------
function initWorker() {
  worker = new Worker('js/worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    busy = false;
    showProgress(false);
    setStatus('Worker error: ' + (e.message || 'unknown') + '. The page must be served over http, not opened as a file://.', 'error');
    console.error('[xiaojie] worker error', e);
    // Same stale-result cleanup and pending re-run as the reported-error path, so a
    // worker crash mid-run does not leave a stale result on screen or strand a request.
    el.downloadBtn.disabled = true;
    el.resultCanvas.hidden = true;
    el.resultPlaceholder.hidden = false;
    maybeRunPending();
  };
}

function onWorkerMessage(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      console.info('[xiaojie] worker ready');
      break;

    case 'progress':
      setProgress(msg.phase, msg.percent);
      break;

    case 'result': {
      const { width, height, buffer, stats } = msg;
      const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
      el.resultCanvas.width = width;
      el.resultCanvas.height = height;
      el.resultCanvas.getContext('2d').putImageData(imageData, 0, 0);
      el.resultCanvas.hidden = false;
      el.resultPlaceholder.hidden = true;
      el.downloadBtn.disabled = false;

      const ms = Math.round(performance.now() - runStart);
      el.statUniqueColors.textContent =
        stats.uniqueColorsUsed + ' of ' + stats.paletteSize + ' palette';
      el.statTime.textContent = ms + ' ms';

      busy = false;
      showProgress(false);
      setStatus('', '');
      maybeRunPending();
      break;
    }

    case 'error':
      busy = false;
      showProgress(false);
      setStatus('Could not recreate Xiaojie: ' + msg.message, 'error');
      console.error('[xiaojie] worker reported error:', msg.message);
      // The previous result no longer matches the current source, so do not leave
      // it on screen with Download enabled as if it were the current output.
      el.downloadBtn.disabled = true;
      el.resultCanvas.hidden = true;
      el.resultPlaceholder.hidden = false;
      maybeRunPending();
      break;

    default:
      console.warn('[xiaojie] unknown worker message', msg);
  }
}

// ---------------------------------------------------------------------------
// Load the fixed cat image.
// ---------------------------------------------------------------------------
function loadTarget() {
  const img = new Image();
  img.onload = () => {
    try {
      const imageData = readImageData(img, null);
      el.targetCanvas.width = imageData.width;
      el.targetCanvas.height = imageData.height;
      el.targetCanvas.getContext('2d').putImageData(imageData, 0, 0);

      // Transfer the pixel buffer to the worker (the main thread no longer needs it).
      worker.postMessage(
        { type: 'setTarget', width: imageData.width, height: imageData.height, buffer: imageData.data.buffer },
        [imageData.data.buffer],
      );
      targetReady = true;
      console.info('[xiaojie] target loaded', imageData.width + 'x' + imageData.height);
      // If a source was uploaded before the cat finished decoding, its run was
      // refused for want of a target. Now that the target is here, run it.
      if (sourceReady && !busy) {
        setStatus('', '');
        run();
      }
    } catch (err) {
      setStatus('Loaded the cat image but could not read its pixels: ' + err.message, 'error');
      console.error('[xiaojie] target read failed', err);
    }
  };
  img.onerror = () => {
    const message =
      'Missing target image at ' + TARGET_SRC + '. Drop your cat photo there (assets/xiaojie.jpg) and reload.';
    setStatus(message, 'error');
    console.error('[xiaojie] ' + message);
  };
  img.src = TARGET_SRC;
}

// ---------------------------------------------------------------------------
// Handle a source upload.
// ---------------------------------------------------------------------------
function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setStatus('That is not an image file. Try a JPG, PNG, or WebP.', 'error');
    return;
  }

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    try {
      const imageData = readImageData(img, MAX_SOURCE_DIM);
      drawScaledPreview(el.sourceCanvas, imageData);
      el.sourcePlaceholder.hidden = true;
      el.statSourceRes.textContent = imageData.width + ' x ' + imageData.height;

      // Transfer the source pixels to the worker; it caches them for re-runs.
      worker.postMessage(
        { type: 'setSource', width: imageData.width, height: imageData.height, buffer: imageData.data.buffer },
        [imageData.data.buffer],
      );
      sourceReady = true;
      run(); // auto-run on upload
    } catch (err) {
      setStatus('Could not read that image: ' + err.message, 'error');
      console.error('[xiaojie] source read failed', err);
    }
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('Could not decode that image file.', 'error');
  };
  img.src = url;
}

// ---------------------------------------------------------------------------
// Kick off a run.
// ---------------------------------------------------------------------------
function currentOptions() {
  const colorSpace = el.colorspaceInputs.find((i) => i.checked)?.value || 'lab';
  return {
    paletteSize: parseInt(el.paletteSize.value, 10),
    colorSpace,
  };
}

function run() {
  if (!targetReady) {
    setStatus('Target cat image is not loaded, so there is nothing to recreate.', 'error');
    return;
  }
  if (!sourceReady) return; // nothing uploaded yet, quietly wait
  if (busy) {
    // A run is already crunching. Remember that the controls/source changed so we
    // re-run with the newest state the moment the in-flight run finishes, instead
    // of silently dropping this request and leaving a stale result.
    pendingRun = true;
    return;
  }

  busy = true;
  runStart = performance.now();
  showProgress(true);
  setProgress('palette', 0);
  setStatus('', '');
  worker.postMessage({ type: 'process', options: currentOptions() });
}

function scheduleRun() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(run, CONTROL_DEBOUNCE_MS);
}

// After a run finishes (or errors), apply any request that arrived while it was busy.
// Bounded to one follow-up per pending flag, so this cannot loop.
function maybeRunPending() {
  if (pendingRun) {
    pendingRun = false;
    run();
  }
}

// ---------------------------------------------------------------------------
// Wire up controls.
// ---------------------------------------------------------------------------
function wireControls() {
  // Palette size slider.
  el.paletteSize.addEventListener('input', () => {
    el.paletteSizeValue.textContent = el.paletteSize.value;
    scheduleRun();
  });

  // Colour space toggle.
  el.colorspaceInputs.forEach((input) => {
    input.addEventListener('change', scheduleRun);
  });

  // Download.
  el.downloadBtn.addEventListener('click', () => {
    el.resultCanvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'xiaojie-recreated.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  });

  // File picker.
  el.fileInput.addEventListener('change', (e) => {
    handleFile(e.target.files && e.target.files[0]);
    e.target.value = ''; // allow re-selecting the same file
  });
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.fileInput.click();
    }
  });

  // Drag and drop.
  ['dragenter', 'dragover'].forEach((type) => {
    el.dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      el.dropZone.classList.add('drop-zone--over');
    });
  });
  ['dragleave', 'dragend', 'drop'].forEach((type) => {
    el.dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      el.dropZone.classList.remove('drop-zone--over');
    });
  });
  el.dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
function init() {
  el.paletteSizeValue.textContent = el.paletteSize.value;
  if (typeof Worker === 'undefined') {
    setStatus('Your browser does not support Web Workers, which this tool needs.', 'error');
    return;
  }
  try {
    // new Worker() throws synchronously under file:// (origin "null"), so catch it
    // here and show the same "serve over http" guidance the worker.onerror path gives.
    initWorker();
  } catch (err) {
    setStatus(
      'Could not start the Web Worker. Serve this page over http (for example "npx serve" or "python -m http.server"), not by opening the file directly with a file:// URL.',
      'error',
    );
    console.error('[xiaojie] worker construction failed', err);
    return;
  }
  wireControls();
  loadTarget();
}

document.addEventListener('DOMContentLoaded', init);
