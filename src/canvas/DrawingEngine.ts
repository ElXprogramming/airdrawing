import type { CameraBgMode, Point2D, StrokeAction } from '../types';
import { CAMERA_BG_OPACITY } from '../types';

export interface DrawingEngineCallbacks {
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
}

/**
 * High-DPI persistent drawing engine using Quadratic Bézier midpoint interpolation
 * and dual-buffer active stroke compositing for uniform neon glow at 60+ FPS.
 */
export class DrawingEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly committedCanvas: HTMLCanvasElement;
  private readonly committedCtx: CanvasRenderingContext2D;
  private readonly callbacks: DrawingEngineCallbacks;

  private width = 1;
  private height = 1;
  private dpr = 1;

  private undoStack: StrokeAction[] = [];
  private redoStack: StrokeAction[] = [];
  private activeStroke: StrokeAction | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    callbacks: DrawingEngineCallbacks = {}
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) {
      throw new Error('Failed to initialize 2D context on drawing canvas.');
    }
    this.ctx = ctx;

    this.committedCanvas = document.createElement('canvas');
    const committedCtx = this.committedCanvas.getContext('2d', { alpha: true });
    if (!committedCtx) {
      throw new Error('Failed to initialize offscreen committed canvas.');
    }
    this.committedCtx = committedCtx;
    this.callbacks = callbacks;

    this.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  }

  /**
   * Resizes the drawing and committed canvases with full HiDPI support
   * and losslessly re-renders existing vector stroke history.
   */
  public resize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio = window.devicePixelRatio || 1
  ): void {
    this.width = Math.max(1, Math.floor(cssWidth));
    this.height = Math.max(1, Math.floor(cssHeight));
    this.dpr = Math.max(1, Math.min(3, devicePixelRatio));

    const pixelW = Math.floor(this.width * this.dpr);
    const pixelH = Math.floor(this.height * this.dpr);

    this.canvas.width = pixelW;
    this.canvas.height = pixelH;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.committedCanvas.width = pixelW;
    this.committedCanvas.height = pixelH;

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.committedCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.rebuildFromHistory();
  }

  /**
   * Starts or continues an ink stroke or eraser path at normalized [0..1] coordinates.
   */
  public addStrokePoint(
    normalizedPt: Point2D,
    type: 'draw' | 'erase',
    color: string,
    sizePx: number
  ): void {
    if (this.activeStroke && this.activeStroke.type !== type) {
      this.endStroke();
    }

    if (!this.activeStroke) {
      this.activeStroke = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        color,
        size: sizePx,
        points: [{ x: normalizedPt.x, y: normalizedPt.y }],
      };
      this.redoStack = [];
      this.renderActiveStrokeIncremental();
      this.notifyHistory();
      return;
    }

    const pts = this.activeStroke.points;
    const lastPt = pts[pts.length - 1];
    const dx = (normalizedPt.x - lastPt.x) * this.width;
    const dy = (normalizedPt.y - lastPt.y) * this.height;
    const distPx = Math.hypot(dx, dy);

    // Sub-pixel threshold avoids redundant points when finger is stationary
    if (distPx < 0.75) {
      return;
    }

    pts.push({ x: normalizedPt.x, y: normalizedPt.y });
    this.renderActiveStrokeIncremental();
  }

  /**
   * Finishes the current stroke and commits it to the undo stack and backing store.
   */
  public endStroke(): void {
    if (!this.activeStroke) {
      return;
    }

    const finished = this.activeStroke;
    this.activeStroke = null;

    if (finished.points.length > 0) {
      this.undoStack.push(finished);
      this.renderStrokeToContext(this.committedCtx, finished);
      this.syncMainFromCommitted();
      this.notifyHistory();
    }
  }

  /**
   * Renders the active stroke with zero-artifact glow or immediate destination-out erasing.
   */
  private renderActiveStrokeIncremental(): void {
    if (!this.activeStroke) {
      return;
    }

    if (this.activeStroke.type === 'erase') {
      // For eraser, apply latest segment directly to both committed & main canvases
      this.renderLatestEraserSegment(this.committedCtx, this.activeStroke);
      this.syncMainFromCommitted();
    } else {
      // For glowing ink, composite committed canvas + single continuous Bézier stroke
      this.syncMainFromCommitted();
      this.renderStrokeToContext(this.ctx, this.activeStroke);
    }
  }

  /**
   * Renders a complete StrokeAction onto a 2D context using Quadratic Bézier midpoint curves.
   */
  private renderStrokeToContext(
    targetCtx: CanvasRenderingContext2D,
    stroke: StrokeAction
  ): void {
    if (stroke.type === 'clear') {
      targetCtx.save();
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.clearRect(
        0,
        0,
        targetCtx.canvas.width,
        targetCtx.canvas.height
      );
      targetCtx.restore();
      return;
    }

    const pts = stroke.points;
    if (pts.length === 0) {
      return;
    }

    targetCtx.save();
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.lineWidth = stroke.size;

    if (stroke.type === 'erase') {
      targetCtx.globalCompositeOperation = 'destination-out';
      targetCtx.strokeStyle = 'rgba(0,0,0,1)';
      targetCtx.fillStyle = 'rgba(0,0,0,1)';
      targetCtx.shadowBlur = 0;
    } else {
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.strokeStyle = stroke.color;
      targetCtx.fillStyle = stroke.color;
      targetCtx.shadowColor = stroke.color;
      targetCtx.shadowBlur = Math.max(8, stroke.size * 1.35);
    }

    const p0x = pts[0].x * this.width;
    const p0y = pts[0].y * this.height;

    if (pts.length === 1) {
      targetCtx.beginPath();
      targetCtx.arc(p0x, p0y, stroke.size * 0.5, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.restore();
      return;
    }

    targetCtx.beginPath();
    targetCtx.moveTo(p0x, p0y);

    if (pts.length === 2) {
      const p1x = pts[1].x * this.width;
      const p1y = pts[1].y * this.height;
      targetCtx.lineTo(p1x, p1y);
    } else {
      // Quadratic Bézier interpolation through consecutive midpoints
      for (let i = 1; i < pts.length - 1; i++) {
        const currX = pts[i].x * this.width;
        const currY = pts[i].y * this.height;
        const nextX = pts[i + 1].x * this.width;
        const nextY = pts[i + 1].y * this.height;
        const midX = (currX + nextX) * 0.5;
        const midY = (currY + nextY) * 0.5;
        targetCtx.quadraticCurveTo(currX, currY, midX, midY);
      }
      const last = pts[pts.length - 1];
      targetCtx.lineTo(last.x * this.width, last.y * this.height);
    }

    targetCtx.stroke();
    targetCtx.restore();
  }

  /**
   * Incrementally erases the newest segment on the target context for 60+ FPS fist erasing.
   */
  private renderLatestEraserSegment(
    targetCtx: CanvasRenderingContext2D,
    stroke: StrokeAction
  ): void {
    const pts = stroke.points;
    const n = pts.length;
    if (n === 0) {
      return;
    }

    targetCtx.save();
    targetCtx.globalCompositeOperation = 'destination-out';
    targetCtx.strokeStyle = 'rgba(0,0,0,1)';
    targetCtx.fillStyle = 'rgba(0,0,0,1)';
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.lineWidth = stroke.size;
    targetCtx.shadowBlur = 0;

    if (n === 1) {
      const x = pts[0].x * this.width;
      const y = pts[0].y * this.height;
      targetCtx.beginPath();
      targetCtx.arc(x, y, stroke.size * 0.5, 0, Math.PI * 2);
      targetCtx.fill();
    } else if (n === 2) {
      const x0 = pts[0].x * this.width;
      const y0 = pts[0].y * this.height;
      const x1 = pts[1].x * this.width;
      const y1 = pts[1].y * this.height;
      targetCtx.beginPath();
      targetCtx.moveTo(x0, y0);
      targetCtx.lineTo(x1, y1);
      targetCtx.stroke();
    } else {
      const pPrev2 = pts[n - 3];
      const pPrev1 = pts[n - 2];
      const pCurr = pts[n - 1];

      const startMidX = ((pPrev2.x + pPrev1.x) * 0.5) * this.width;
      const startMidY = ((pPrev2.y + pPrev1.y) * 0.5) * this.height;
      const ctrlX = pPrev1.x * this.width;
      const ctrlY = pPrev1.y * this.height;
      const endMidX = ((pPrev1.x + pCurr.x) * 0.5) * this.width;
      const endMidY = ((pPrev1.y + pCurr.y) * 0.5) * this.height;

      targetCtx.beginPath();
      targetCtx.moveTo(startMidX, startMidY);
      targetCtx.quadraticCurveTo(ctrlX, ctrlY, endMidX, endMidY);
      targetCtx.stroke();
    }

    targetCtx.restore();
  }

  private syncMainFromCommitted(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.committedCanvas, 0, 0);
    this.ctx.restore();
  }

  private rebuildFromHistory(): void {
    this.committedCtx.save();
    this.committedCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.committedCtx.clearRect(
      0,
      0,
      this.committedCanvas.width,
      this.committedCanvas.height
    );
    this.committedCtx.restore();

    for (const action of this.undoStack) {
      this.renderStrokeToContext(this.committedCtx, action);
    }

    this.syncMainFromCommitted();
    if (this.activeStroke) {
      this.renderStrokeToContext(this.ctx, this.activeStroke);
    }
  }

  /**
   * Clears the canvas and records the clear action in the Undo history stack.
   */
  public clearCanvas(): void {
    this.endStroke();

    const hasVisibleStrokes =
      this.undoStack.length > 0 &&
      this.undoStack[this.undoStack.length - 1].type !== 'clear';

    if (hasVisibleStrokes) {
      this.undoStack.push({
        id: `clear-${Date.now()}`,
        type: 'clear',
        color: '#000000',
        size: 0,
        points: [],
      });
      this.redoStack = [];
    }

    this.committedCtx.save();
    this.committedCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.committedCtx.clearRect(
      0,
      0,
      this.committedCanvas.width,
      this.committedCanvas.height
    );
    this.committedCtx.restore();

    this.syncMainFromCommitted();
    this.notifyHistory();
  }

  public undo(): boolean {
    this.endStroke();
    const popped = this.undoStack.pop();
    if (!popped) {
      return false;
    }
    this.redoStack.push(popped);
    this.rebuildFromHistory();
    this.notifyHistory();
    return true;
  }

  public redo(): boolean {
    this.endStroke();
    const popped = this.redoStack.pop();
    if (!popped) {
      return false;
    }
    this.undoStack.push(popped);
    this.rebuildFromHistory();
    this.notifyHistory();
    return true;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0 || this.activeStroke !== null;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public getStrokeCount(): number {
    return this.undoStack.length;
  }

  private notifyHistory(): void {
    this.callbacks.onHistoryChange?.(this.canUndo(), this.canRedo());
  }

  /**
   * Merges the current background layer (studio dark + optional mirrored video feed)
   * with the high-DPI drawing canvas and triggers a PNG download.
   */
  public exportToPng(
    videoElement: HTMLVideoElement | null,
    cameraBgMode: CameraBgMode
  ): string {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = this.canvas.width;
    exportCanvas.height = this.canvas.height;
    const exportCtx = exportCanvas.getContext('2d');
    if (!exportCtx) {
      return '';
    }

    // 1. Fill base cyber-dark studio canvas background
    exportCtx.fillStyle = '#050811';
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    // 2. If video feed is visible (100% or 30%), composite mirrored video with object-fit: cover
    const bgOpacity = CAMERA_BG_OPACITY[cameraBgMode];
    if (
      videoElement &&
      bgOpacity > 0 &&
      videoElement.readyState >= 2 &&
      videoElement.videoWidth > 0 &&
      videoElement.videoHeight > 0
    ) {
      exportCtx.save();
      exportCtx.globalAlpha = bgOpacity;

      const vw = videoElement.videoWidth;
      const vh = videoElement.videoHeight;
      const cw = exportCanvas.width;
      const ch = exportCanvas.height;
      const scale = Math.max(cw / vw, ch / vh);
      const drawW = vw * scale;
      const drawH = vh * scale;
      const offsetX = (cw - drawW) * 0.5;
      const offsetY = (ch - drawH) * 0.5;

      exportCtx.translate(cw, 0);
      exportCtx.scale(-1, 1);
      exportCtx.drawImage(videoElement, offsetX, offsetY, drawW, drawH);
      exportCtx.restore();
    }

    // 3. Composite high-DPI persistent drawing layer
    exportCtx.drawImage(this.canvas, 0, 0);

    const dataUrl = exportCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    link.download = `airdrawing-${timestamp}.png`;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    return dataUrl;
  }
}
