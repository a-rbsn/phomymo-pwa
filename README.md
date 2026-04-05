# Phomemo Print

A minimal PWA for printing images and text notes to Phomemo thermal printers via Bluetooth. Share an image or text from any Android app, preview the monochrome output, and print.

## How It Works

1. Install the PWA from Chrome on Android
2. Connect to your Phomemo printer via Bluetooth
3. Share an image or text from any app (Gallery, Keep, Samsung Notes, etc.) — or upload/capture directly
4. Adjust dithering, brightness, contrast, and print darkness
5. Tap Print

Text shared from apps like Google Keep is automatically rendered as a printable note. Images are resized to the printer width, dithered to 1-bit monochrome, and previewed so you can see exactly what will print.

## Features

- **Share target** — appears in the Android share sheet for both images and text
- **Image printing** — PNG, JPEG, WEBP via share, upload, or camera capture
- **Text notes** — shared text rendered as a formatted note with title and body
- **Live preview** — monochrome dithered preview shows exact print output
- **Dithering options** — Floyd-Steinberg, Atkinson, ordered (Bayer), or threshold
- **Brightness/contrast** — adjust before printing
- **Print darkness** — controls thermal head heat (1-8)
- **Auto-detect** — reads Bluetooth device name and configures protocol, width, and DPI automatically
- **Offline** — service worker caches the app for use without internet
- **Installable** — standalone PWA on Android home screen

## Supported Printers

| Model | Width | Protocol |
|-------|-------|----------|
| T02 | 48mm (384px) | M-series |
| M02 / M02S / M02X | 48mm (384px) | M02-series |
| M02 Pro | 53mm (626px, 300 DPI) | M02-series |
| M03 | 53mm (432px) | M-series |
| M04S / M04AS | 53/80/110mm (300 DPI) | M04-series |
| M110 / M120 | 48mm (384px) | M110-series |
| M200 / M250 | 75mm (608px) | M-series |
| M220 / M221 | 72mm (576px) | M-series |
| M260 | 72mm (576px) | M-series |
| D30 / D35 / D50 / Q30 / Q30S | 12-15mm | D-series (rotated) |
| P12 / P12 Pro | 12mm | P12 (rotated, tape) |
| A30 | 12-15mm | P12 (rotated, tape) |
| PM-241-BT | 102mm (4") | TSPL |

Auto-detection matches the Bluetooth device name to the correct configuration. Printer definitions are loaded from `printers.json`.

## Requirements

- Chrome on Android (Web Bluetooth)
- HTTPS (provided by Netlify, or localhost for development)

Web Bluetooth is not available in Firefox, Safari, or Brave.

### Auto-reconnect

The app automatically reconnects to your printer when you open it — no need to tap Connect every time. This requires a Chrome flag:

1. Open Chrome and go to `chrome://flags`
2. Search for **"Web Bluetooth new permissions backend"**
3. Set it to **Enabled**
4. Relaunch Chrome

Without this flag the app still works, but you'll need to tap Connect and select the printer each time.

## Run Locally

```bash
cd src/web
python3 -m http.server 8080
# Open http://localhost:8080 in Chrome
```

## Deploy

Hosted as a static site on Netlify. Push to the repo and Netlify auto-deploys from `src/web/`.

```
netlify.toml → publish = "src/web"
```

## Project Structure

```
src/web/
├── index.html        # Single page app
├── app.js            # UI logic, image processing, dithering, print flow
├── ble.js            # Web Bluetooth transport
├── printer.js        # ESC/POS protocol (all printer variants)
├── printers.json     # Printer definitions (auto-detect patterns, widths, protocols)
├── constants.js      # BLE and storage constants
├── style.css         # Dark mobile-first theme
├── sw.js             # Service worker (share target + offline cache)
├── manifest.json     # PWA manifest with share target
└── icons/            # SVG app icons
```

## Acknowledgments

Forked from [transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo). Protocol research:

- [vivier/phomemo-tools](https://github.com/vivier/phomemo-tools) — CUPS driver with reverse-engineered protocol
- [yaddran/thermal-print](https://github.com/yaddran/thermal-print) — Printer status query commands
- [ooki1jp](https://github.com/vivier/phomemo-tools/issues/27#issuecomment-3850158579) — M04AS/M04S protocol

## License

MIT License — see LICENSE file for details.
