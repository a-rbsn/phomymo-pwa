/**
 * Phomemo Print PWA — Main application
 * Receives an image (share target or upload) and prints it to a Phomemo printer via BLE.
 */

import { BLETransport } from './ble.js';
import {
  loadPrinterDefinitions, print,
  getPrinterWidthBytes, getPrinterDpi,
  getPrinterDescription, getPrinterAlignment,
  isRotatedPrinter,
} from './printer.js';

// Default width when no printer connected (T02 = 48 bytes = 384px)
const DEFAULT_WIDTH_BYTES = 48;

// =============================================================================
// STATE
// =============================================================================

const state = {
  ble: BLETransport.getShared(),
  connected: false,
  deviceName: '',
  sourceImage: null, // HTMLImageElement from upload/share
  brightness: 0,     // -100 to 100
  contrast: 0,       // -100 to 100
  ditherMode: 'floyd-steinberg',
  density: 6,        // 1-8 (print heat)
  printing: false,
  autoConnecting: false,
  autoConnectAbort: null,
};

// =============================================================================
// DOM HELPERS
// =============================================================================

const $ = (id) => document.getElementById(id);
let processTimeout = null;

// =============================================================================
// INIT
// =============================================================================

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadPrinterDefinitions();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) =>
      console.warn('SW registration failed:', e)
    );
  }

  setupEvents();
  await checkShareTarget();

  if (!BLETransport.isAvailable()) {
    setStatus('Web Bluetooth not available in this browser', 'error');
    $('connect-btn').disabled = true;
  } else {
    // Try auto-reconnecting to a previously paired printer
    await tryAutoConnect();
  }
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

function setupEvents() {
  $('connect-btn').addEventListener('click', connect);
  $('disconnect-btn').addEventListener('click', disconnect);
  $('upload-btn').addEventListener('click', () => $('file-input').click());
  $('camera-btn').addEventListener('click', () => $('camera-input').click());
  $('preview-area').addEventListener('click', () => {
    if (!state.sourceImage) $('file-input').click();
  });

  $('file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = ''; // allow re-selecting same file
  });
  $('camera-input').addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = '';
  });

  $('dither-mode').addEventListener('change', (e) => {
    state.ditherMode = e.target.value;
    scheduleProcess();
  });
  $('brightness').addEventListener('input', (e) => {
    state.brightness = +e.target.value;
    $('brightness-value').textContent = e.target.value;
    scheduleProcess();
  });
  $('contrast').addEventListener('input', (e) => {
    state.contrast = +e.target.value;
    $('contrast-value').textContent = e.target.value;
    scheduleProcess();
  });
  $('density').addEventListener('input', (e) => {
    state.density = +e.target.value;
    $('density-value').textContent = e.target.value;
  });

  $('print-btn').addEventListener('click', printImage);
}

/** Debounce image processing while sliders are being dragged */
function scheduleProcess() {
  clearTimeout(processTimeout);
  processTimeout = setTimeout(() => processImage(), 50);
}

// =============================================================================
// BLUETOOTH CONNECTION
// =============================================================================

/**
 * Try to auto-reconnect to a previously paired printer.
 * Uses navigator.bluetooth.getDevices() + watchAdvertisements() to listen
 * continuously until the printer appears, then connects automatically.
 * Stops when connected or when the user taps Connect manually.
 */
async function tryAutoConnect() {
  if (!navigator.bluetooth?.getDevices) {
    setStatus('getDevices() not supported', 'warning');
    return;
  }

  let devices;
  try {
    devices = await navigator.bluetooth.getDevices();
  } catch (e) {
    setStatus('getDevices() error: ' + e.message, 'warning');
    return;
  }

  const names = devices.map(d => d.name || '(unnamed)').join(', ');
  setStatus('Saved devices: ' + (devices.length ? names : 'none'), 'info');

  if (devices.length === 0) return;

  // Use all devices — name may not be populated until advertisement is seen
  const targets = devices;

  setStatus('Waiting for printer...', 'info');
  state.autoConnecting = true;

  // Listen for advertisements on all known devices simultaneously.
  // When any device is seen, try connecting to it.
  const abort = new AbortController();
  let watching = 0;

  for (const device of targets) {
    if (!device.watchAdvertisements) continue;

    device.addEventListener('advertisementreceived', async (event) => {
      // Only act once
      if (!state.autoConnecting || state.connected) return;
      state.autoConnecting = false;
      abort.abort();

      const name = event.device.name || device.name || 'printer';
      try {
        setStatus('Reconnecting to ' + name + '...', 'info');
        state.ble.device = device;
        state.ble.onDisconnect = handleDisconnect;
        await state.ble.connectGATT();

        state.connected = true;
        state.deviceName = state.ble.getDeviceName();
        onConnected();
      } catch (e) {
        console.log('Auto-connect failed for', name + ':', e.message);
        state.ble.device = null;
        setStatus('', '');
        updateConnectionUI();
      }
    }, { once: true });

    device.watchAdvertisements({ signal: abort.signal }).catch(() => {});
    watching++;
  }

  console.log('Auto-connect: watching', watching, 'device(s) for advertisements');
  if (watching === 0) {
    setStatus('', '');
    return;
  }

  // Store abort so manual connect can cancel the background scan
  state.autoConnectAbort = abort;
}

function handleDisconnect() {
  state.connected = false;
  state.deviceName = '';
  updateConnectionUI();
  setStatus('Printer disconnected', 'warning');
}

/** Shared post-connection setup */
function onConnected() {
  updateConnectionUI();
  const desc = getPrinterDescription(state.deviceName);
  const widthPx = getPrinterWidthBytes(state.deviceName) * 8;
  setStatus('Connected', 'success');
  $('printer-name').textContent = `${desc} (${widthPx}px wide)`;

  // Query printer info (non-blocking)
  state.ble.queryAll().catch(() => {});

  // Re-process image at correct printer width if one is loaded
  if (state.sourceImage) processImage();
}

async function connect() {
  // Cancel background auto-connect scan if running
  if (state.autoConnectAbort) {
    state.autoConnecting = false;
    state.autoConnectAbort.abort();
    state.autoConnectAbort = null;
  }

  try {
    setStatus('Connecting...', 'info');
    $('connect-btn').disabled = true;

    state.ble.onDisconnect = handleDisconnect;

    await state.ble.connect();
    state.connected = true;
    state.deviceName = state.ble.getDeviceName();
    onConnected();

  } catch (e) {
    state.connected = false;
    updateConnectionUI();
    if (e.message?.includes('cancel')) {
      setStatus('Connection cancelled', 'info');
    } else if (e.message?.includes('globally disabled')) {
      setStatus('Bluetooth blocked — open Chrome Settings > Site Settings > Bluetooth and enable it', 'error');
    } else {
      setStatus('Connection failed: ' + e.message, 'error');
    }
  }
}

async function disconnect() {
  try { await state.ble.disconnect(); } catch (_) { /* ignore */ }
  state.connected = false;
  state.deviceName = '';
  updateConnectionUI();
  setStatus('Disconnected', 'info');
}

function updateConnectionUI() {
  const connected = state.connected;
  $('connect-btn').disabled = false;
  $('connect-btn').textContent = connected ? 'Connected' : 'Connect to Printer';
  $('connect-btn').classList.toggle('hidden', connected);
  $('disconnect-btn').classList.toggle('hidden', !connected);
  $('printer-info').classList.toggle('hidden', !connected);
  updatePrintBtn();
}

// =============================================================================
// IMAGE LOADING
// =============================================================================

function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Please select an image file', 'error');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    state.sourceImage = img;
    processImage();
    setStatus('Image loaded — ' + img.naturalWidth + 'x' + img.naturalHeight, 'success');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('Failed to load image', 'error');
  };
  img.src = url;
}

/** Check if the app was opened via the share target */
async function checkShareTarget() {
  const params = new URLSearchParams(window.location.search);
  const shareType = params.get('share');
  if (!shareType) return;

  // Clean URL immediately
  window.history.replaceState({}, '', window.location.pathname);

  try {
    const cache = await caches.open('shared-image');

    if (shareType === 'text') {
      // Shared text — render as a note image
      const response = await cache.match('shared-text');
      if (response) {
        const { title, text } = await response.json();
        await cache.delete('shared-text');
        if (title || text) {
          const img = await renderTextToImage(title, text);
          state.sourceImage = img;
          // Optimize settings for text: crisp threshold, max darkness, bold contrast
          state.ditherMode = 'threshold';
          $('dither-mode').value = 'threshold';
          state.density = 8;
          $('density').value = 8;
          $('density-value').textContent = '8';
          state.brightness = -20;
          $('brightness').value = -20;
          $('brightness-value').textContent = '-20';
          state.contrast = 50;
          $('contrast').value = 50;
          $('contrast-value').textContent = '50';
          processImage();
          setStatus('Shared text loaded', 'success');
        }
      }
    } else if (shareType === 'image') {
      // Shared image file
      const response = await cache.match('latest');
      if (response) {
        const blob = await response.blob();
        await cache.delete('latest');
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            state.sourceImage = img;
            processImage();
            setStatus('Shared image loaded', 'success');
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            setStatus('Failed to load shared image', 'error');
          };
          img.src = url;
        }
      }
    }
    // shareType === 'debug' — just shows the debug info above
  } catch (e) {
    console.error('Share target load error:', e);
  }
}

/**
 * Render text as a note image at printer width.
 * Returns an HTMLImageElement ready for the processing pipeline.
 */
function renderTextToImage(title, text) {
  const widthBytes = state.connected
    ? getPrinterWidthBytes(state.deviceName)
    : DEFAULT_WIDTH_BYTES;
  const widthPx = widthBytes * 8;
  const padding = Math.round(widthPx * 0.03);
  const contentWidth = widthPx - padding * 2;

  // Set up a measuring canvas
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  const ctx = canvas.getContext('2d');

  const titleSize = Math.round(widthPx * 0.065);
  const bodySize = Math.round(widthPx * 0.055);
  const lineHeight = 1.2;

  // Wrap text into lines
  function wrapText(str, font, maxWidth) {
    ctx.font = font;
    const lines = [];
    for (const paragraph of str.split('\n')) {
      if (paragraph === '') { lines.push(''); continue; }
      const words = paragraph.split(/\s+/);
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  const titleFont = `bold ${titleSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const bodyFont = `${bodySize}px -apple-system, BlinkMacSystemFont, sans-serif`;

  const titleLines = title ? wrapText(title, titleFont, contentWidth) : [];
  const bodyLines = text ? wrapText(text, bodyFont, contentWidth) : [];

  // Calculate total height
  let y = padding;
  if (titleLines.length) y += titleLines.length * (titleSize * lineHeight) + titleSize * 0.3;
  if (bodyLines.length) y += bodyLines.length * (bodySize * lineHeight);
  y += padding;

  // Render
  canvas.height = Math.round(y);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';

  let curY = padding;

  if (titleLines.length) {
    ctx.font = titleFont;
    ctx.textBaseline = 'top';
    for (const line of titleLines) {
      ctx.fillText(line, padding, curY);
      curY += titleSize * lineHeight;
    }
    curY += titleSize * 0.3;
  }

  if (bodyLines.length) {
    ctx.font = bodyFont;
    ctx.textBaseline = 'top';
    for (const line of bodyLines) {
      ctx.fillText(line, padding, curY);
      curY += bodySize * lineHeight;
    }
  }

  // Convert canvas to image — must wait for load before returning
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to render text'));
    img.src = canvas.toDataURL();
  });
}

// =============================================================================
// IMAGE PROCESSING
// =============================================================================

function processImage() {
  if (!state.sourceImage) return;
  const img = state.sourceImage;

  // Determine printer width
  const widthBytes = state.connected
    ? getPrinterWidthBytes(state.deviceName)
    : DEFAULT_WIDTH_BYTES;
  const widthPx = widthBytes * 8;

  // Resize maintaining aspect ratio
  const scale = widthPx / img.naturalWidth;
  const heightPx = Math.round(img.naturalHeight * scale);

  // Draw image with brightness/contrast adjustments
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');

  const bVal = 1 + state.brightness / 100;
  const cVal = 1 + state.contrast / 100;
  ctx.filter = `brightness(${bVal}) contrast(${cVal})`;
  ctx.drawImage(img, 0, 0, widthPx, heightPx);
  ctx.filter = 'none';

  // Get pixel data and dither
  const imageData = ctx.getImageData(0, 0, widthPx, heightPx);
  const grayscale = rgbaToGrayscale(imageData.data, widthPx, heightPx);
  const dithered = applyDither(grayscale, widthPx, heightPx, state.ditherMode);

  // Render monochrome preview
  const preview = $('preview-canvas');
  preview.width = widthPx;
  preview.height = heightPx;
  const pCtx = preview.getContext('2d');
  const pData = pCtx.createImageData(widthPx, heightPx);
  for (let i = 0; i < dithered.length; i++) {
    const c = dithered[i] === 1 ? 0 : 255;
    const j = i * 4;
    pData.data[j] = c;
    pData.data[j + 1] = c;
    pData.data[j + 2] = c;
    pData.data[j + 3] = 255;
  }
  pCtx.putImageData(pData, 0, 0);

  // Show preview, hide placeholder
  preview.classList.remove('hidden');
  $('preview-placeholder').classList.add('hidden');
  updatePrintBtn();
}

// =============================================================================
// PRINTING
// =============================================================================

async function printImage() {
  if (!state.connected || !state.sourceImage || state.printing) return;

  state.printing = true;
  updatePrintBtn();
  showProgress(0, 'Preparing...');

  try {
    const widthBytes = getPrinterWidthBytes(state.deviceName);
    const alignment = getPrinterAlignment(state.deviceName);
    const rotated = isRotatedPrinter(state.deviceName);

    // Render at print resolution
    const widthPx = widthBytes * 8;
    const scale = widthPx / state.sourceImage.naturalWidth;
    const heightPx = Math.round(state.sourceImage.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext('2d');

    const bVal = 1 + state.brightness / 100;
    const cVal = 1 + state.contrast / 100;
    ctx.filter = `brightness(${bVal}) contrast(${cVal})`;
    ctx.drawImage(state.sourceImage, 0, 0, widthPx, heightPx);
    ctx.filter = 'none';

    const imageData = ctx.getImageData(0, 0, widthPx, heightPx);
    const grayscale = rgbaToGrayscale(imageData.data, widthPx, heightPx);
    const dithered = applyDither(grayscale, widthPx, heightPx, state.ditherMode);

    // Pack into raster bytes
    let rasterWidthBytes, rasterData;
    if (rotated) {
      // D-series / P12: raw width, printer.js handles rotation
      rasterWidthBytes = Math.ceil(widthPx / 8);
      rasterData = packBits(dithered, widthPx, heightPx, rasterWidthBytes, 'left');
    } else {
      // M-series: align within printer width
      rasterWidthBytes = widthBytes;
      rasterData = packBits(dithered, widthPx, heightPx, widthBytes, alignment);
    }

    // Append blank rows so the print clears the tear edge
    // (some printers ignore ESC J feed, but blank raster rows always work)
    const feedRows = 80;
    const paddedData = new Uint8Array(rasterData.length + rasterWidthBytes * feedRows);
    paddedData.set(rasterData);
    // Rest is already zeroes (white)

    showProgress(0, 'Sending to printer...');

    await print(state.ble,
      { data: paddedData, widthBytes: rasterWidthBytes, heightLines: heightPx + feedRows },
      {
        isBLE: true,
        deviceName: state.deviceName,
        printerModel: 'auto',
        density: state.density,
        feed: 0,
        onProgress: (pct) => showProgress(pct, `Printing... ${pct}%`),
      }
    );

    showProgress(100, 'Done!');
    setStatus('Print complete', 'success');
    setTimeout(hideProgress, 2000);

  } catch (e) {
    setStatus('Print failed: ' + e.message, 'error');
    hideProgress();
  } finally {
    state.printing = false;
    updatePrintBtn();
  }
}

// =============================================================================
// UI HELPERS
// =============================================================================

function setStatus(msg, level = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (level ? ' ' + level : '');
}

function updatePrintBtn() {
  const btn = $('print-btn');
  const ready = state.connected && state.sourceImage && !state.printing;
  btn.disabled = !ready;
  if (state.printing) {
    btn.textContent = 'Printing...';
  } else if (!state.connected) {
    btn.textContent = 'Connect printer to print';
  } else if (!state.sourceImage) {
    btn.textContent = 'Load an image to print';
  } else {
    btn.textContent = 'Print';
  }
}

function showProgress(pct, text) {
  $('progress').classList.remove('hidden');
  $('progress-fill').style.width = pct + '%';
  $('progress-text').textContent = text || '';
}

function hideProgress() {
  $('progress').classList.add('hidden');
  $('progress-fill').style.width = '0%';
  $('progress-text').textContent = '';
}

// =============================================================================
// DITHERING & RASTER CONVERSION (ported from phomymo canvas.js)
// =============================================================================

/** Convert RGBA pixels to perceptual grayscale with gamma correction for thermal printing */
function rgbaToGrayscale(pixels, width, height) {
  const out = new Float32Array(width * height);
  const gammaInv = 1.0 / 1.3;
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    const r = pixels[j], g = pixels[j + 1], b = pixels[j + 2], a = pixels[j + 3];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    if (a < 255) gray = gray * (a / 255) + 255 * (1 - a / 255);
    out[i] = 255 * Math.pow(gray / 255, gammaInv);
  }
  return out;
}

/** Dispatch to the selected dithering algorithm */
function applyDither(grayscale, w, h, mode) {
  switch (mode) {
    case 'threshold': return thresholdDither(grayscale, w, h);
    case 'atkinson':  return atkinsonDither(grayscale, w, h);
    case 'ordered':   return orderedDither(grayscale, w, h);
    default:          return floydSteinbergDither(grayscale, w, h);
  }
}

function thresholdDither(grayscale, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = grayscale[i] < 128 ? 1 : 0;
  return out;
}

function floydSteinbergDither(grayscale, w, h) {
  const px = new Float32Array(grayscale);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = px[i];
      const val = old < 128 ? 0 : 255;
      out[i] = val === 0 ? 1 : 0;
      const err = old - val;
      if (x + 1 < w)                      px[i + 1]               += err * 7 / 16;
      if (y + 1 < h && x > 0)             px[(y + 1) * w + x - 1] += err * 3 / 16;
      if (y + 1 < h)                      px[(y + 1) * w + x]     += err * 5 / 16;
      if (y + 1 < h && x + 1 < w)         px[(y + 1) * w + x + 1] += err * 1 / 16;
    }
  }
  return out;
}

function atkinsonDither(grayscale, w, h) {
  const px = new Float32Array(grayscale);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = px[i];
      const val = old < 128 ? 0 : 255;
      out[i] = val === 0 ? 1 : 0;
      const err = (old - val) / 8;
      if (x + 1 < w)              px[i + 1]               += err;
      if (x + 2 < w)              px[i + 2]               += err;
      if (y + 1 < h && x > 0)     px[(y + 1) * w + x - 1] += err;
      if (y + 1 < h)              px[(y + 1) * w + x]     += err;
      if (y + 1 < h && x + 1 < w) px[(y + 1) * w + x + 1] += err;
      if (y + 2 < h)              px[(y + 2) * w + x]     += err;
    }
  }
  return out;
}

function orderedDither(grayscale, w, h) {
  const out = new Uint8Array(w * h);
  const bayer = [
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const threshold = (bayer[(y % 8) * 8 + (x % 8)] / 64) * 255;
      out[i] = grayscale[i] < threshold ? 1 : 0;
    }
  }
  return out;
}

/** Pack 1-bit dithered pixels into raster bytes with alignment */
function packBits(dithered, width, height, outputWidthBytes, alignment) {
  const srcBytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(outputWidthBytes * height);

  let offset = 0;
  if (alignment === 'center') offset = Math.floor((outputWidthBytes - srcBytesPerRow) / 2);
  else if (alignment === 'right') offset = outputWidthBytes - srcBytesPerRow;
  if (offset < 0) offset = 0;

  for (let y = 0; y < height; y++) {
    for (let bx = 0; bx < srcBytesPerRow; bx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        if (x < width && dithered[y * width + x] === 1) {
          byte |= 1 << (7 - bit);
        }
      }
      const pos = y * outputWidthBytes + offset + bx;
      if (pos >= 0 && pos < out.length) out[pos] = byte;
    }
  }
  return out;
}
