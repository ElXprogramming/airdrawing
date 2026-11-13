# AirDraw — Spatial Camera Air-Drawing Studio ✨🖐️

> **Real-time spatial camera air-drawing web application powered by `@mediapipe/tasks-vision`, a scale- and tilt-invariant gesture classifier, One-Euro jitter filtering, and HTML5 Canvas.**

[![Live Demo](https://img.shields.io/badge/Live_Demo-airdrawing--mu.vercel.app-00F0FF?style=flat-square&logo=vercel&logoColor=white)](https://airdrawing-mu.vercel.app)
[![Latest Release](https://img.shields.io/github/v/release/ElXprogramming/airdrawing?color=blue)](https://github.com/ElXprogramming/airdrawing/releases)
[![CI](https://github.com/ElXprogramming/airdrawing/actions/workflows/ci.yml/badge.svg)](https://github.com/ElXprogramming/airdrawing/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5.4-646CFF.svg?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Client-Side](https://img.shields.io/badge/Privacy-100%25%20Client--Side-10b981.svg)](#architecture)
[![GitHub Stars](https://img.shields.io/github/stars/ElXprogramming/airdrawing?style=social)](https://github.com/ElXprogramming/airdrawing/stargazers)

🌐 **Live Web App**: [https://airdrawing-mu.vercel.app](https://airdrawing-mu.vercel.app)

---

## 🎯 Overview

**AirDraw** turns any webcam into a touchless spatial drawing canvas. Hand landmarks are tracked locally in your browser using **MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`), smoothed in real time with a **One-Euro Filter** (`OneEuroFilter1D` / `PointSmoother2D`) to eliminate micro-jitter without adding lag, and classified into intuitive drawing, erasing, hovering, and UI air-click actions.

If camera permissions are unavailable or denied, AirDraw automatically switches to **Pointer Studio Mode** so you can draw seamlessly with a mouse or touch input.

---

## ✨ Features

- **🤏 Pinch-to-Draw State Machine**:
  - **Pinch (Thumb Tip `4` + Index Tip `8`)**: Enters `DRAWING` mode with hysteresis thresholds (`0.34` enter / `0.43` exit) to prevent broken strokes.
  - **Open Hand**: Switches to `HOVERING` (pen-up cursor aiming).
  - **Closed Fist**: Activates precision `ERASER` mode (`46px` eraser radius).
  - **Spatial UI Air-Click Dock**: Hover over any color swatch, brush size, or action button in the floating bottom capsule and pinch to select without touching your keyboard or mouse.
  - **1.0s Trash Pinch-Hold**: Pinch and hold the Trash control for `1.0s` (with radial progress feedback and cooldown guard) to clear the canvas safely.
- **📐 Scale- & Tilt-Invariant Geometry**: Normalizes landmark distances against palm scale and uses joint bend cosines so gestures stay reliable regardless of camera distance or hand tilt.
- **〰️ One-Euro Filter Smoothing**: Adaptive low-pass jitter filtering (`PointSmoother2D`) for smooth 60 FPS neon strokes stored in normalized `[0..1]` canvas coordinates for lossless resizing.
- **🎨 Studio Palette & Controls**:
  - **6 Neon Ink Presets**: Neon Cyan (`#00F0FF`), Neon Magenta (`#FF007F`), Coral Red (`#FF3B5C`), Solar Yellow (`#FFE600`), Acid Lime (`#39FF14`), and Pure White (`#FFFFFF`), plus a custom color picker.
  - **3 Brush Presets**: Fine (`3px`), Medium (`8px`), and Marker (`18px`).
  - **Camera Background Modes**: Switch between `100% Video`, `30% Dimmed`, and `0% Studio` dark canvas.
  - **Hand Skeleton Overlay**: Toggle live landmark visualization, FPS counter, and GPU/CPU delegate status pill.
  - **History & Export**: Multi-step Undo/Redo stack and 1-click PNG export.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl/Cmd + Z` | Undo last stroke |
| `Ctrl/Cmd + Shift + Z` / `Ctrl/Cmd + Y` | Redo stroke |
| `C` | Cycle camera background mode (`100%` / `30%` / `0%`) |
| `S` | Toggle MediaPipe hand skeleton overlay |
| `Delete` / `Backspace` | Clear canvas |
| `?` | Toggle floating Gesture Controls guide |

---

## 🛠️ Tech Stack

- **Hand Tracking**: [`@mediapipe/tasks-vision`](https://developers.google.com/mediapipe) (WebAssembly + GPU/CPU delegate)
- **Language**: TypeScript 5.6 (strict mode)
- **Rendering**: Dual-layer HTML5 Canvas (`DrawingEngine` + `HudRenderer`)
- **Build Tool**: Vite 5
- **Testing**: Vitest (`src/__tests__/airdrawing.test.ts`)

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or higher

### Installation & Local Development

```bash
git clone https://github.com/ElXprogramming/airdrawing.git
cd airdrawing
npm install
npm run dev
```

### Verification & Build

```bash
# Run TypeScript typecheck
npm run typecheck

# Run unit tests (OneEuroFilter & GestureClassifier)
npm test

# Build production bundle
npm run build
```

---

## 🏗️ Architecture

```text
src/
├── core/
│   ├── AppController.ts      # Main animation loop, mode coordination, pointer fallback
│   ├── CameraManager.ts      # Webcam stream setup & retry handling
│   └── HandTracker.ts        # MediaPipe HandLandmarker wrapper
├── gestures/
│   └── GestureClassifier.ts  # Scale/tilt-invariant Pinch, Hover, Fist Eraser classifier
├── math/
│   └── OneEuroFilter.ts      # Adaptive 1D & 2D One-Euro smoothing filters
├── canvas/
│   ├── DrawingEngine.ts      # Normalized stroke rendering, undo/redo, PNG export
│   └── HudRenderer.ts        # Reticle, pinch proximity ring, and hand skeleton overlay
├── ui/
│   ├── ToolbarUI.ts          # Spatial air-click capsule, gesture guide, shortcuts
│   └── icons.ts              # Inline SVG icons
└── __tests__/
    └── airdrawing.test.ts    # Filter & gesture unit tests
```

---

## 🤝 Contributing & Security

Contributions and bug reports are welcome! Please review [CONTRIBUTING.md](CONTRIBUTING.md), our [Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).
