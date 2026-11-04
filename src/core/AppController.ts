import { DrawingEngine } from '../canvas/DrawingEngine';
import { HudRenderer } from '../canvas/HudRenderer';
import { GestureClassifier } from '../gestures/GestureClassifier';
import { PointSmoother2D } from '../math/OneEuroFilter';
import {
  BRUSH_PRESETS,
  CAMERA_BG_OPACITY,
  INK_PALETTE,
  type AppState,
  type CameraBgMode,
  type GestureMode,
  type NormalizedLandmark,
  type Point2D,
} from '../types';
import { ToolbarUI } from '../ui/ToolbarUI';
import { CameraManager } from './CameraManager';
import { HandTracker } from './HandTracker';

const ERASER_DIAMETER_PX = 46;
const FIRST_GESTURE_HOLD_MS = 350;

export class AppController {
  private readonly videoEl: HTMLVideoElement;
  private readonly cameraManager: CameraManager;
  private readonly handTracker: HandTracker;
  private readonly gestureClassifier: GestureClassifier;
  private readonly cursorSmoother: PointSmoother2D;
  private readonly palmSmoother: PointSmoother2D;
  private readonly drawingEngine: DrawingEngine;
  private readonly hudRenderer: HudRenderer;
  private readonly toolbarUI: ToolbarUI;

  private state: AppState = {
    gestureMode: 'LOOKING',
    clearProgress: 0,
    activeColor: INK_PALETTE[0].hex, // #00F0FF Neon Cyan Default
    brushSize: BRUSH_PRESETS[1].size, // Medium 8px Default
    eraserRadius: ERASER_DIAMETER_PX * 0.5,
    cameraBgMode: 'dimmed', // 30% dimmed contrast ideal default
    showSkeleton: false,
    fps: 60,
    delegate: 'INIT',
    canUndo: false,
    canRedo: false,
    hasPerformedFirstGesture: false,
    cameraReady: false,
    cameraError: null,
  };

  private latestLandmarks: NormalizedLandmark[] | null = null;
  private simulatedLandmarks: NormalizedLandmark[] | null = null;
  private baseGestureMode: GestureMode = 'LOOKING';
  private isPinching = false;
  private pinchProximity = 0;

  private pointerFallbackActive = false;
  private pointerDown = false;
  private pointerPosNormalized: Point2D | null = null;
  private pointerRightButton = false;

  private firstGestureStartMs: number | null = null;
  private rafId: number | null = null;
  private fpsFrameCount = 0;
  private fpsWindowStartMs = performance.now();

  constructor(
    videoEl: HTMLVideoElement,
    drawingCanvas: HTMLCanvasElement,
    hudCanvas: HTMLCanvasElement,
    uiRoot: HTMLElement
  ) {
    this.videoEl = videoEl;
    this.cameraManager = new CameraManager(videoEl);
    this.handTracker = new HandTracker();
    this.gestureClassifier = new GestureClassifier({
      pinchEnterThreshold: 0.34,
      pinchExitThreshold: 0.43,
      confirmFramesRequired: 2,
    });

    this.cursorSmoother = new PointSmoother2D(1.3, 4.8, 1.5, 0.92);
    this.palmSmoother = new PointSmoother2D(1.2, 3.0, 1.5, 0.88);

    this.drawingEngine = new DrawingEngine(drawingCanvas, {
      onHistoryChange: (canUndo, canRedo) => {
        this.state.canUndo = canUndo;
        this.state.canRedo = canRedo;
        this.toolbarUI.sync(this.state);
      },
    });

    this.hudRenderer = new HudRenderer(hudCanvas);

    this.toolbarUI = new ToolbarUI(uiRoot, {
      onSelectColor: (hex) => {
        this.state.activeColor = hex;
        this.toolbarUI.sync(this.state);
      },
      onSelectBrushSize: (sizePx) => {
        this.state.brushSize = sizePx;
        this.toolbarUI.sync(this.state);
      },
      onCycleCameraBg: () => {
        const order: CameraBgMode[] = ['full', 'dimmed', 'studio'];
        const nextIdx =
          (order.indexOf(this.state.cameraBgMode) + 1) % order.length;
        this.setCameraBgMode(order[nextIdx]);
      },
      onSelectCameraBg: (mode) => {
        this.setCameraBgMode(mode);
      },
      onToggleSkeleton: () => {
        this.state.showSkeleton = !this.state.showSkeleton;
        this.toolbarUI.sync(this.state);
      },
      onUndo: () => {
        this.drawingEngine.undo();
      },
      onRedo: () => {
        this.drawingEngine.redo();
      },
      onClear: () => {
        this.drawingEngine.clearCanvas();
        this.hudRenderer.triggerClearFlash({ x: 0.5, y: 0.5 });
      },
      onExportPng: () => {
        this.drawingEngine.exportToPng(this.videoEl, this.state.cameraBgMode);
      },
      onRetryCamera: () => {
        void this.initializeCamera();
      },
    });

    this.applyCameraBgOpacity();
    this.toolbarUI.sync(this.state);
    this.bindWindowEvents(hudCanvas);
  }

  public async start(): Promise<void> {
    this.rafId = requestAnimationFrame((ts) => this.tick(ts));
    await Promise.all([this.initializeVision(), this.initializeCamera()]);
  }

  private async initializeVision(): Promise<void> {
    try {
      const delegate = await this.handTracker.init();
      this.state.delegate = delegate;
      this.toolbarUI.sync(this.state);
    } catch (err) {
      console.error('Failed to initialize MediaPipe HandLandmarker:', err);
      this.state.delegate = 'CPU';
      this.toolbarUI.sync(this.state);
    }
  }

  private async initializeCamera(): Promise<void> {
    try {
      await this.cameraManager.start();
      this.state.cameraReady = true;
      this.state.cameraError = null;
      this.toolbarUI.sync(this.state);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Webcam permission or hardware unavailable';
      this.state.cameraReady = false;
      this.state.cameraError = msg;
      this.toolbarUI.sync(this.state);
    }
  }

  private setCameraBgMode(mode: CameraBgMode): void {
    this.state.cameraBgMode = mode;
    this.applyCameraBgOpacity();
    this.toolbarUI.sync(this.state);
  }

  private applyCameraBgOpacity(): void {
    const opacity = CAMERA_BG_OPACITY[this.state.cameraBgMode];
    this.videoEl.style.opacity = String(opacity);
  }

  private bindWindowEvents(interactiveCanvas: HTMLCanvasElement): void {
    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      this.drawingEngine.resize(w, h, dpr);
      this.hudRenderer.resize(w, h, dpr);
    });

    interactiveCanvas.addEventListener('contextmenu', (e) =>
      e.preventDefault()
    );

    interactiveCanvas.addEventListener('pointerdown', (e) => {
      if (this.latestLandmarks !== null || this.simulatedLandmarks !== null) {
        return;
      }
      this.pointerFallbackActive = true;
      this.pointerDown = true;
      this.pointerRightButton = e.button === 2 || e.shiftKey;
      this.pointerPosNormalized = {
        x: e.clientX / Math.max(1, window.innerWidth),
        y: e.clientY / Math.max(1, window.innerHeight),
      };
      this.cursorSmoother.reset();
      this.cursorSmoother.updateFromMeasurement(
        this.pointerPosNormalized,
        performance.now()
      );
    });

    window.addEventListener('pointermove', (e) => {
      if (this.latestLandmarks !== null || this.simulatedLandmarks !== null) {
        this.pointerFallbackActive = false;
        return;
      }
      this.pointerFallbackActive = true;
      this.pointerPosNormalized = {
        x: e.clientX / Math.max(1, window.innerWidth),
        y: e.clientY / Math.max(1, window.innerHeight),
      };
      this.cursorSmoother.updateFromMeasurement(
        this.pointerPosNormalized,
        performance.now()
      );
    });

    window.addEventListener('pointerup', () => {
      if (this.pointerDown) {
        this.pointerDown = false;
        this.pointerRightButton = false;
        this.drawingEngine.endStroke();
      }
    });
  }

  /**
   * Main 60+ FPS decoupled loop:
   * - Vision inference runs ONLY when a new video frame is decoded
   * - Spatial Air-Click dock hit-testing, 1.0s Trash pinch-hold, Bézier stroke emission,
   *   and HUD rendering run at full display refresh rate
   */
  private tick(nowMs: number): void {
    // 1. Update rolling FPS counter
    this.fpsFrameCount += 1;
    const elapsedFpsWindow = nowMs - this.fpsWindowStartMs;
    if (elapsedFpsWindow >= 500) {
      this.state.fps = Math.min(
        120,
        Math.max(1, Math.round((this.fpsFrameCount * 1000) / elapsedFpsWindow))
      );
      this.fpsFrameCount = 0;
      this.fpsWindowStartMs = nowMs;
    }

    // 2. Vision Step: Only detect when a new video frame is available (or simulated landmarks injected)
    if (this.simulatedLandmarks !== null) {
      this.latestLandmarks = this.simulatedLandmarks;
      this.processVisionMeasurement(this.latestLandmarks, nowMs);
    } else if (
      this.cameraManager.isReady() &&
      this.handTracker.isReady() &&
      this.cameraManager.consumeNewFrame()
    ) {
      this.latestLandmarks = this.handTracker.detect(this.videoEl, nowMs);
      this.processVisionMeasurement(this.latestLandmarks, nowMs);
    }

    // 3. Render Step: Advance 60fps interpolated cursor, evaluate Spatial Dock UI, & emit strokes
    let renderCursor: Point2D | null = null;
    let renderPalm: Point2D | null = null;
    let isHoveringUI = false;

    if (this.latestLandmarks !== null) {
      renderCursor = this.cursorSmoother.stepRenderFrame(0.6);
      renderPalm = this.palmSmoother.stepRenderFrame(0.55);

      const spatialUI = this.toolbarUI.evaluateSpatialCursor(
        renderCursor,
        this.isPinching,
        nowMs
      );
      isHoveringUI = spatialUI.isHoveringButton;

      if (spatialUI.isHoldingTrash) {
        this.state.gestureMode = 'CLEARING';
        this.state.clearProgress = spatialUI.trashClearProgress;
        this.drawingEngine.endStroke();

        if (spatialUI.shouldTriggerTrashClear) {
          this.drawingEngine.clearCanvas();
          this.hudRenderer.triggerClearFlash(renderCursor);
        }
      } else if (spatialUI.suppressCanvasDrawing) {
        this.state.gestureMode = 'HOVERING';
        this.state.clearProgress = 0;
        this.drawingEngine.endStroke();
      } else {
        this.state.gestureMode = this.baseGestureMode;
        this.state.clearProgress = 0;

        if (this.state.gestureMode === 'DRAWING' && renderCursor) {
          this.drawingEngine.addStrokePoint(
            renderCursor,
            'draw',
            this.state.activeColor,
            this.state.brushSize
          );
        } else if (this.state.gestureMode === 'ERASER' && renderCursor) {
          this.drawingEngine.addStrokePoint(
            renderCursor,
            'erase',
            '#000000',
            ERASER_DIAMETER_PX
          );
        } else {
          this.drawingEngine.endStroke();
        }
      }
    } else if (this.pointerFallbackActive && this.pointerPosNormalized) {
      renderCursor = this.cursorSmoother.stepRenderFrame(0.75);
      this.toolbarUI.evaluateSpatialCursor(null, false, nowMs);

      if (this.pointerDown && renderCursor) {
        if (this.pointerRightButton) {
          this.state.gestureMode = 'ERASER';
          this.drawingEngine.addStrokePoint(
            renderCursor,
            'erase',
            '#000000',
            ERASER_DIAMETER_PX
          );
        } else {
          this.state.gestureMode = 'DRAWING';
          this.drawingEngine.addStrokePoint(
            renderCursor,
            'draw',
            this.state.activeColor,
            this.state.brushSize
          );
        }
        this.markFirstGesture(nowMs);
      } else {
        this.state.gestureMode = this.cameraManager.isReady()
          ? 'LOOKING'
          : 'HOVERING';
        this.drawingEngine.endStroke();
      }
    } else {
      this.toolbarUI.evaluateSpatialCursor(null, false, nowMs);
      this.drawingEngine.endStroke();
    }

    // 4. Render HUD Overlay Canvas
    this.hudRenderer.render({
      mode: this.state.gestureMode,
      cursorNormalized: renderCursor,
      palmCenterNormalized: renderPalm,
      landmarks: this.latestLandmarks,
      showSkeleton: this.state.showSkeleton,
      activeColor: this.state.activeColor,
      brushSize: this.state.brushSize,
      eraserDiameter: ERASER_DIAMETER_PX,
      clearProgress: this.state.clearProgress,
      pinchProximity: this.pinchProximity,
      isHoveringUI,
      nowMs,
    });

    // 5. Sync Floating UI Controls
    this.toolbarUI.sync(this.state);

    this.rafId = requestAnimationFrame((ts) => this.tick(ts));
  }

  private processVisionMeasurement(
    landmarks: NormalizedLandmark[] | null,
    nowMs: number
  ): void {
    const evalResult = this.gestureClassifier.evaluate(landmarks, nowMs);
    const prevBaseMode = this.baseGestureMode;

    this.baseGestureMode = evalResult.mode;
    this.isPinching = evalResult.isPinching;
    this.pinchProximity = evalResult.pinchProximity;

    if (evalResult.mode === 'LOOKING') {
      this.state.gestureMode = 'LOOKING';
      this.state.clearProgress = 0;
      this.cursorSmoother.reset();
      this.palmSmoother.reset();
      this.firstGestureStartMs = null;
      return;
    }

    this.markFirstGesture(nowMs);

    if (evalResult.cursorNormalized) {
      if (
        prevBaseMode === 'LOOKING' ||
        (prevBaseMode !== evalResult.mode && evalResult.mode === 'ERASER')
      ) {
        this.cursorSmoother.reset();
      }
      this.cursorSmoother.updateFromMeasurement(
        evalResult.cursorNormalized,
        nowMs
      );
    }

    if (evalResult.palmCenterNormalized) {
      if (prevBaseMode === 'LOOKING') {
        this.palmSmoother.reset();
      }
      this.palmSmoother.updateFromMeasurement(
        evalResult.palmCenterNormalized,
        nowMs
      );
    }
  }

  private markFirstGesture(nowMs: number): void {
    if (this.state.hasPerformedFirstGesture) {
      return;
    }
    if (this.firstGestureStartMs === null) {
      this.firstGestureStartMs = nowMs;
    } else if (nowMs - this.firstGestureStartMs >= FIRST_GESTURE_HOLD_MS) {
      this.state.hasPerformedFirstGesture = true;
    }
  }

  /**
   * Programmatic API for injecting simulated 21-point hand landmarks (used for testing & demos).
   */
  public setSimulatedLandmarks(landmarks: NormalizedLandmark[] | null): void {
    this.simulatedLandmarks = landmarks;
    if (landmarks === null) {
      this.latestLandmarks = null;
      this.gestureClassifier.reset();
      this.baseGestureMode = 'LOOKING';
      this.state.gestureMode = 'LOOKING';
      this.state.clearProgress = 0;
      this.isPinching = false;
      this.pinchProximity = 0;
    }
  }

  public getState(): Readonly<AppState> {
    return { ...this.state };
  }

  public getDrawingEngine(): DrawingEngine {
    return this.drawingEngine;
  }

  public destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.cameraManager.stop();
    this.handTracker.close();
  }
}
