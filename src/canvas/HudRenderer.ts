import type { GestureMode, NormalizedLandmark, Point2D } from '../types';

interface TrailParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  color: string;
}

const HAND_CONNECTIONS: ReadonlyArray< readonly [number, number] > = [
  // Thumb
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  // Index
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  // Middle
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  // Ring
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  // Pinky
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];

export interface HudRenderParams {
  mode: GestureMode;
  cursorNormalized: Point2D | null;
  palmCenterNormalized: Point2D | null;
  landmarks: NormalizedLandmark[] | null;
  showSkeleton: boolean;
  activeColor: string;
  brushSize: number;
  eraserDiameter: number;
  clearProgress: number;
  nowMs: number;
}

/**
 * Dynamic 60+ FPS overlay canvas renderer for adaptive fingertip reticles,
 * glowing particle trails, radial palm-clear progress rings, and optional hand skeleton.
 */
export class HudRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private width = 1;
  private height = 1;
  private dpr = 1;

  private particles: TrailParticle[] = [];
  private lastParticleSpawnMs = 0;
  private clearFlashStartMs: number | null = null;
  private clearFlashOrigin: Point2D | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to initialize 2D context on HUD overlay canvas.');
    }
    this.ctx = ctx;
    this.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  }

  public resize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio = window.devicePixelRatio || 1
  ): void {
    this.width = Math.max(1, Math.floor(cssWidth));
    this.height = Math.max(1, Math.floor(cssHeight));
    this.dpr = Math.max(1, Math.min(3, devicePixelRatio));

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /**
   * Triggers a gentle shockwave/flash animation when the canvas is cleared.
   */
  public triggerClearFlash(originNormalized?: Point2D | null): void {
    this.clearFlashStartMs = performance.now();
    this.clearFlashOrigin = originNormalized
      ? {
          x: originNormalized.x * this.width,
          y: originNormalized.y * this.height,
        }
      : { x: this.width * 0.5, y: this.height * 0.5 };
  }

  public render(params: HudRenderParams): void {
    const {
      mode,
      cursorNormalized,
      palmCenterNormalized,
      landmarks,
      showSkeleton,
      activeColor,
      brushSize,
      eraserDiameter,
      clearProgress,
      nowMs,
    } = params;

    this.ctx.clearRect(0, 0, this.width, this.height);

    // 1. Render Clear Flash Shockwave (if active)
    this.renderClearFlash(nowMs);

    // 2. Render Optional 21-Landmark Hand Skeleton
    if (showSkeleton && landmarks && landmarks.length >= 21) {
      this.renderHandSkeleton(landmarks, activeColor, mode);
    }

    // 3. Update & Render Trailing Particles (from Drawing Mode)
    if (mode === 'DRAWING' && cursorNormalized) {
      const cx = cursorNormalized.x * this.width;
      const cy = cursorNormalized.y * this.height;
      this.spawnDrawingParticles(cx, cy, activeColor, brushSize, nowMs);
    }
    this.updateAndRenderParticles();

    // 4. Render Adaptive Cursor Reticle at Fingertip / Palm Center
    if (mode === 'CLEARING' && palmCenterNormalized) {
      const px = palmCenterNormalized.x * this.width;
      const py = palmCenterNormalized.y * this.height;
      this.renderPalmClearRing(px, py, clearProgress, nowMs);
    } else if (cursorNormalized) {
      const cx = cursorNormalized.x * this.width;
      const cy = cursorNormalized.y * this.height;

      if (mode === 'DRAWING') {
        this.renderDrawingReticle(cx, cy, activeColor, brushSize);
      } else if (mode === 'HOVERING') {
        this.renderHoverReticle(cx, cy, activeColor, brushSize, nowMs);
      } else if (mode === 'ERASER') {
        this.renderEraserReticle(cx, cy, eraserDiameter, nowMs);
      }
    }
  }

  /**
   * Drawing Mode Reticle: Solid glowing dot matching the active ink color
   * with a luminous outer halo.
   */
  private renderDrawingReticle(
    x: number,
    y: number,
    color: string,
    brushSize: number
  ): void {
    const ctx = this.ctx;
    const dotRadius = Math.max(4, brushSize * 0.5);

    ctx.save();

    // Outer ambient halo
    ctx.beginPath();
    ctx.arc(x, y, dotRadius + 7, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.stroke();

    // Solid glowing core dot
    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fill();

    // Crisp white specular center pinpoint
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, dotRadius * 0.35), 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowBlur = 0;
    ctx.fill();

    ctx.restore();
  }

  /**
   * Hover Mode Reticle: Dual-concentric dashed crosshair circle (aiming reticle)
   * indicating pen-up motion.
   */
  private renderHoverReticle(
    x: number,
    y: number,
    activeColor: string,
    brushSize: number,
    nowMs: number
  ): void {
    const ctx = this.ctx;
    const rotation = (nowMs * 0.0018) % (Math.PI * 2);
    const outerRadius = 22;
    const innerRadius = 12;

    ctx.save();
    ctx.translate(x, y);

    // Outer rotating dashed circle (Amber/Cyan cyber aim ring)
    ctx.save();
    ctx.rotate(rotation);
    ctx.beginPath();
    ctx.arc(0, 0, outerRadius, 0, Math.PI * 2);
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1.75;
    ctx.shadowColor = 'rgba(245, 158, 11, 0.8)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();

    // Inner counter-rotating dashed circle
    ctx.save();
    ctx.rotate(-rotation * 1.4);
    ctx.beginPath();
    ctx.arc(0, 0, innerRadius, 0, Math.PI * 2);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.restore();

    // 4 Crosshair precision ticks
    ctx.beginPath();
    const tickInner = outerRadius + 2;
    const tickOuter = outerRadius + 7;
    ctx.moveTo(0, -tickInner);
    ctx.lineTo(0, -tickOuter);
    ctx.moveTo(0, tickInner);
    ctx.lineTo(0, tickOuter);
    ctx.moveTo(-tickInner, 0);
    ctx.lineTo(-tickOuter, 0);
    ctx.moveTo(tickInner, 0);
    ctx.lineTo(tickOuter, 0);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Center preview dot showing loaded ink color & brush scale
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(2.5, Math.min(7, brushSize * 0.35)), 0, Math.PI * 2);
    ctx.fillStyle = activeColor;
    ctx.shadowColor = activeColor;
    ctx.shadowBlur = 8;
    ctx.fill();

    ctx.restore();
  }

  /**
   * Eraser Mode Reticle: Translucent red circle showing the exact destructive
   * eraser collision radius.
   */
  private renderEraserReticle(
    x: number,
    y: number,
    eraserDiameter: number,
    nowMs: number
  ): void {
    const ctx = this.ctx;
    const radius = Math.max(12, eraserDiameter * 0.5);
    const pulse = 1 + Math.sin(nowMs * 0.008) * 0.03;

    ctx.save();
    ctx.translate(x, y);

    // Translucent destructive collision zone fill
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 59, 92, 0.24)';
    ctx.fill();

    // Crisp coral-red glowing perimeter matching exact eraser radius
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FF3B5C';
    ctx.shadowColor = 'rgba(255, 59, 92, 0.85)';
    ctx.shadowBlur = 14;
    ctx.stroke();

    // Inner dashed ring
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.65 * pulse, 0, Math.PI * 2);
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 180, 195, 0.75)';
    ctx.shadowBlur = 0;
    ctx.stroke();

    // Center X cross mark
    const crossSize = 4.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-crossSize, -crossSize);
    ctx.lineTo(crossSize, crossSize);
    ctx.moveTo(crossSize, -crossSize);
    ctx.lineTo(-crossSize, crossSize);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Palm Clear Mode: Circular radial progress ring anchored at the palm center (Landmark 9)
   * that sweeps clockwise from 0° to 360° over 1.5 seconds.
   */
  private renderPalmClearRing(
    x: number,
    y: number,
    progress: number,
    nowMs: number
  ): void {
    const ctx = this.ctx;
    const clamped = Math.max(0, Math.min(1, progress));
    const radius = 44;
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + clamped * Math.PI * 2;
    const pct = Math.round(clamped * 100);

    ctx.save();
    ctx.translate(x, y);

    // Dark glassmorphic backing disc
    ctx.beginPath();
    ctx.arc(0, 0, radius + 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.fill();

    // Track ring (muted slate)
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 6;
    ctx.stroke();

    // Sweeping clockwise radial progress arc (0° -> 360°)
    if (clamped > 0.005) {
      ctx.beginPath();
      ctx.arc(0, 0, radius, startAngle, endAngle, false);
      ctx.strokeStyle = '#C084FC';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(192, 132, 252, 0.95)';
      ctx.shadowBlur = 18;
      ctx.stroke();
    }

    // Outer subtle pulsing aura
    const pulseRadius = radius + 12 + Math.sin(nowMs * 0.012) * 3;
    ctx.beginPath();
    ctx.arc(0, 0, pulseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(192, 132, 252, ${0.25 + clamped * 0.45})`;
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 0;
    ctx.stroke();

    // Percentage readout inside palm ring
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 15px Inter, system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${pct}%`, 0, -5);

    ctx.fillStyle = 'rgba(216, 180, 254, 0.9)';
    ctx.font = '600 9px Inter, system-ui, -apple-system, sans-serif';
    ctx.fillText('CLEARING', 0, 11);

    ctx.restore();
  }

  private spawnDrawingParticles(
    x: number,
    y: number,
    color: string,
    brushSize: number,
    nowMs: number
  ): void {
    if (nowMs - this.lastParticleSpawnMs < 18) {
      return;
    }
    this.lastParticleSpawnMs = nowMs;

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.25 + Math.random() * 0.9;
    this.particles.push({
      x: x + (Math.random() - 0.5) * brushSize * 0.6,
      y: y + (Math.random() - 0.5) * brushSize * 0.6,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.2,
      radius: Math.max(1.5, Math.min(4.5, brushSize * 0.22)),
      alpha: 0.85,
      color,
    });

    if (this.particles.length > 36) {
      this.particles.shift();
    }
  }

  private updateAndRenderParticles(): void {
    if (this.particles.length === 0) {
      return;
    }
    const ctx = this.ctx;
    ctx.save();

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= 0.045;
      p.radius *= 0.96;

      if (p.alpha <= 0.03 || p.radius <= 0.3) {
        this.particles.splice(i, 1);
        continue;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.fill();
    }

    ctx.restore();
  }

  private renderHandSkeleton(
    landmarks: NormalizedLandmark[],
    activeColor: string,
    mode: GestureMode
  ): void {
    const ctx = this.ctx;
    ctx.save();

    // Draw bone connections
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.42)';
    ctx.beginPath();
    for (const [startIdx, endIdx] of HAND_CONNECTIONS) {
      const a = landmarks[startIdx];
      const b = landmarks[endIdx];
      const ax = (1.0 - a.x) * this.width;
      const ay = a.y * this.height;
      const bx = (1.0 - b.x) * this.width;
      const by = b.y * this.height;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // Draw 21 landmark joints
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      const x = (1.0 - lm.x) * this.width;
      const y = lm.y * this.height;

      const isIndexTip = i === 8;
      const isPalmCenter = i === 9;

      ctx.beginPath();
      ctx.arc(x, y, isIndexTip ? 4.5 : isPalmCenter ? 4 : 2.5, 0, Math.PI * 2);
      if (isIndexTip) {
        ctx.fillStyle = mode === 'ERASER' ? '#FF3B5C' : activeColor;
      } else if (isPalmCenter) {
        ctx.fillStyle = '#C084FC';
      } else {
        ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
      }
      ctx.fill();
    }

    ctx.restore();
  }

  private renderClearFlash(nowMs: number): void {
    if (this.clearFlashStartMs === null || !this.clearFlashOrigin) {
      return;
    }

    const durationMs = 500;
    const elapsed = nowMs - this.clearFlashStartMs;
    if (elapsed >= durationMs) {
      this.clearFlashStartMs = null;
      this.clearFlashOrigin = null;
      return;
    }

    const t = elapsed / durationMs;
    const maxRadius = Math.hypot(this.width, this.height);
    const currentRadius = Math.max(20, t * maxRadius);
    const alpha = (1 - t) * 0.38;

    const ctx = this.ctx;
    ctx.save();

    // Expanding violet/cyan shockwave ring
    ctx.beginPath();
    ctx.arc(
      this.clearFlashOrigin.x,
      this.clearFlashOrigin.y,
      currentRadius,
      0,
      Math.PI * 2
    );
    ctx.strokeStyle = `rgba(192, 132, 252, ${(1 - t) * 0.85})`;
    ctx.lineWidth = 8 * (1 - t) + 2;
    ctx.shadowColor = '#C084FC';
    ctx.shadowBlur = 24;
    ctx.stroke();

    // Gentle screen-wide fade flash
    ctx.fillStyle = `rgba(168, 85, 247, ${alpha * 0.45})`;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.restore();
  }
}
