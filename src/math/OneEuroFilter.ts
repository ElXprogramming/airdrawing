import type { Point2D } from '../types';

/**
 * Low-pass filter primitive used by the One Euro (1€) Filter
 * and Exponential Moving Average (EMA) smoothing.
 */
export class LowPassFilter {
  private y: number | null = null;
  private s: number | null = null;

  public filter(value: number, alpha: number): number {
    const clampedAlpha = Math.max(0.0001, Math.min(1.0, alpha));
    if (this.y === null || this.s === null) {
      this.s = value;
      this.y = value;
      return value;
    }
    this.s = clampedAlpha * value + (1.0 - clampedAlpha) * this.s;
    this.y = value;
    return this.s;
  }

  public hasLastRawValue(): boolean {
    return this.y !== null;
  }

  public lastRawValue(): number {
    return this.y ?? 0;
  }

  public lastFilteredValue(): number {
    return this.s ?? 0;
  }

  public reset(): void {
    this.y = null;
    this.s = null;
  }
}

/**
 * 1D One Euro (1€) Filter (Casiez et al., CHI 2012).
 * Adapts cutoff frequency dynamically based on velocity:
 * - Low velocity -> low cutoff -> eliminates hand tremor & MediaPipe micro-jitter
 * - High velocity -> high cutoff -> near-zero phase lag during fast strokes
 */
export class OneEuroFilter1D {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private readonly xFilter = new LowPassFilter();
  private readonly dxFilter = new LowPassFilter();
  private lastTimeMs: number | null = null;

  constructor(minCutoff = 1.4, beta = 1.8, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private computeAlpha(cutoffHz: number, dtSeconds: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoffHz);
    return 1.0 / (1.0 + tau / dtSeconds);
  }

  public filter(value: number, timestampMs: number): number {
    let dtSeconds = 1.0 / 60.0;
    if (this.lastTimeMs !== null) {
      const elapsedMs = timestampMs - this.lastTimeMs;
      if (elapsedMs > 0 && elapsedMs < 500) {
        dtSeconds = elapsedMs / 1000.0;
      }
    }
    this.lastTimeMs = timestampMs;

    const dValue = this.xFilter.hasLastRawValue()
      ? (value - this.xFilter.lastFilteredValue()) / dtSeconds
      : 0.0;

    const edValue = this.dxFilter.filter(
      dValue,
      this.computeAlpha(this.dCutoff, dtSeconds)
    );

    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    return this.xFilter.filter(value, this.computeAlpha(cutoff, dtSeconds));
  }

  public reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTimeMs = null;
  }
}

/**
 * 2D Point Smoother combining a 2D One Euro Filter with high-refresh-rate
 * frame interpolation for decoupled 30fps vision -> 60/120fps canvas rendering.
 */
export class PointSmoother2D {
  private readonly filterX: OneEuroFilter1D;
  private readonly filterY: OneEuroFilter1D;
  private readonly emaAlpha: number;
  private emaPoint: Point2D | null = null;
  private targetPoint: Point2D | null = null;
  private renderedPoint: Point2D | null = null;

  /**
   * @param minCutoff Minimum cutoff frequency in Hz (default 1.3 Hz for normalized [0..1] coords)
   * @param beta Speed coefficient (default 4.8 for normalized [0..1] coords)
   * @param dCutoff Derivative cutoff frequency in Hz (default 1.5 Hz)
   * @param emaAlpha Optional secondary EMA blend factor (default 0.92)
   */
  constructor(
    minCutoff = 1.3,
    beta = 4.8,
    dCutoff = 1.5,
    emaAlpha = 0.92
  ) {
    this.filterX = new OneEuroFilter1D(minCutoff, beta, dCutoff);
    this.filterY = new OneEuroFilter1D(minCutoff, beta, dCutoff);
    this.emaAlpha = emaAlpha;
  }

  /**
   * Feed a new raw measurement from MediaPipe (when a new video frame arrives).
   */
  public updateFromMeasurement(raw: Point2D, timestampMs: number): Point2D {
    const euroX = this.filterX.filter(raw.x, timestampMs);
    const euroY = this.filterY.filter(raw.y, timestampMs);

    if (this.emaPoint === null) {
      this.emaPoint = { x: euroX, y: euroY };
    } else {
      this.emaPoint = {
        x: this.emaAlpha * euroX + (1 - this.emaAlpha) * this.emaPoint.x,
        y: this.emaAlpha * euroY + (1 - this.emaAlpha) * this.emaPoint.y,
      };
    }

    this.targetPoint = { ...this.emaPoint };
    if (this.renderedPoint === null) {
      this.renderedPoint = { ...this.targetPoint };
    }

    return { ...this.targetPoint };
  }

  /**
   * Called on every 60fps+ requestAnimationFrame tick to smoothly advance
   * the displayed cursor toward the latest filtered measurement.
   */
  public stepRenderFrame(lerpFactor = 0.55): Point2D | null {
    if (this.targetPoint === null) {
      return null;
    }
    if (this.renderedPoint === null) {
      this.renderedPoint = { ...this.targetPoint };
      return { ...this.renderedPoint };
    }

    this.renderedPoint = {
      x:
        this.renderedPoint.x +
        (this.targetPoint.x - this.renderedPoint.x) * lerpFactor,
      y:
        this.renderedPoint.y +
        (this.targetPoint.y - this.renderedPoint.y) * lerpFactor,
    };

    return { ...this.renderedPoint };
  }

  public getCurrent(): Point2D | null {
    return this.renderedPoint ? { ...this.renderedPoint } : null;
  }

  public reset(): void {
    this.filterX.reset();
    this.filterY.reset();
    this.emaPoint = null;
    this.targetPoint = null;
    this.renderedPoint = null;
  }
}
