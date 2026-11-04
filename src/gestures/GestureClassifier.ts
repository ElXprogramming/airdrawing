import type {
  FingerExtensionStates,
  GestureEvaluationResult,
  GestureMode,
  NormalizedLandmark,
  Point2D,
} from '../types';

export interface GestureClassifierConfig {
  /** Hold duration in milliseconds required for Open Palm clear (default: 1500ms) */
  clearHoldDurationMs?: number;
  /** Cooldown duration in milliseconds after a canvas clear (default: 2000ms) */
  clearCooldownDurationMs?: number;
  /** Grace window in ms to tolerate single-frame tracking dropout during palm hold (default: 120ms) */
  clearDropoutGraceMs?: number;
  /** Consecutive frames required to confirm entering DRAWING or ERASER mode (default: 2) */
  confirmFramesRequired?: number;
}

/**
 * Scale- and tilt-invariant geometric heuristic classifier for the
 * "Point & Palm" gesture state machine.
 */
export class GestureClassifier {
  private readonly clearHoldDurationMs: number;
  private readonly clearCooldownDurationMs: number;
  private readonly clearDropoutGraceMs: number;
  private readonly confirmFramesRequired: number;

  private activeMode: GestureMode = 'LOOKING';
  private pendingMode: GestureMode = 'LOOKING';
  private pendingCount = 0;

  private clearHoldStartMs: number | null = null;
  private lastClearFrameMs: number | null = null;
  private cooldownUntilMs = 0;

  constructor(config: GestureClassifierConfig = {}) {
    this.clearHoldDurationMs = config.clearHoldDurationMs ?? 1500;
    this.clearCooldownDurationMs = config.clearCooldownDurationMs ?? 2000;
    this.clearDropoutGraceMs = config.clearDropoutGraceMs ?? 120;
    this.confirmFramesRequired = config.confirmFramesRequired ?? 2;
  }

  /**
   * 3D-aware Euclidean distance in normalized landmark space.
   * Uses 0.25 weight on Z to remain resilient to monocular depth estimation noise.
   */
  private static dist(a: NormalizedLandmark, b: NormalizedLandmark): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z - b.z) * 0.25;
    return Math.hypot(dx, dy, dz);
  }

  /**
   * Cosine of the angle between segments (a -> b) and (b -> c).
   * Returns ~1.0 when collinear/straight, and < 0.3 when sharply bent/curled.
   */
  private static bendCosine(
    a: NormalizedLandmark,
    b: NormalizedLandmark,
    c: NormalizedLandmark
  ): number {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = (b.z - a.z) * 0.25;

    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const vz = (c.z - b.z) * 0.25;

    const magU = Math.hypot(ux, uy, uz);
    const magV = Math.hypot(vx, vy, vz);
    if (magU < 1e-6 || magV < 1e-6) {
      return 1.0;
    }
    return (ux * vx + uy * vy + uz * vz) / (magU * magV);
  }

  /**
   * Evaluates whether a non-thumb finger (Index, Middle, Ring, Pinky) is extended.
   * Invariant to 360-degree planar hand tilt and camera distance.
   */
  private static isFingerExtended(
    landmarks: NormalizedLandmark[],
    mcpIdx: number,
    pipIdx: number,
    dipIdx: number,
    tipIdx: number,
    palmScale: number
  ): boolean {
    const wrist = landmarks[0];
    const mcp = landmarks[mcpIdx];
    const pip = landmarks[pipIdx];
    const dip = landmarks[dipIdx];
    const tip = landmarks[tipIdx];

    const distWristTip = GestureClassifier.dist(wrist, tip);
    const distWristDip = GestureClassifier.dist(wrist, dip);
    const distWristPip = GestureClassifier.dist(wrist, pip);
    const distMcpTip = GestureClassifier.dist(mcp, tip);

    // Joint straightness at PIP and DIP
    const cosPip = GestureClassifier.bendCosine(mcp, pip, dip);
    const cosDip = GestureClassifier.bendCosine(pip, dip, tip);

    // Radial extension ratio relative to PIP
    const radialExtended =
      distWristTip > distWristPip * 1.1 &&
      distWristTip > distWristDip * 1.01 &&
      distMcpTip > palmScale * 0.55;

    // Straightness check ensures curled fingers tilted toward camera are rejected
    const jointsStraight = cosPip > 0.45 && cosDip > 0.35;

    return radialExtended && jointsStraight;
  }

  /**
   * Evaluates whether a non-thumb finger is distinctly curled/folded into the palm.
   */
  private static isFingerCurled(
    landmarks: NormalizedLandmark[],
    mcpIdx: number,
    pipIdx: number,
    dipIdx: number,
    tipIdx: number,
    palmScale: number
  ): boolean {
    const wrist = landmarks[0];
    const mcp = landmarks[mcpIdx];
    const pip = landmarks[pipIdx];
    const dip = landmarks[dipIdx];
    const tip = landmarks[tipIdx];

    const distWristTip = GestureClassifier.dist(wrist, tip);
    const distWristPip = GestureClassifier.dist(wrist, pip);
    const distMcpTip = GestureClassifier.dist(mcp, tip);
    const cosPip = GestureClassifier.bendCosine(mcp, pip, dip);

    return (
      distWristTip < distWristPip * 1.08 ||
      distMcpTip < palmScale * 0.58 ||
      cosPip < 0.42
    );
  }

  /**
   * Evaluates whether the thumb (landmarks 1..4) is openly extended away from the palm.
   */
  private static isThumbExtended(
    landmarks: NormalizedLandmark[],
    palmScale: number
  ): boolean {
    const cmc = landmarks[1];
    const mcp = landmarks[2];
    const ip = landmarks[3];
    const tip = landmarks[4];
    const indexMcp = landmarks[5];
    const middleMcp = landmarks[9];
    const pinkyMcp = landmarks[17];

    const palmWidth = Math.max(
      0.02,
      GestureClassifier.dist(indexMcp, pinkyMcp)
    );
    const distTipToIndexMcp = GestureClassifier.dist(tip, indexMcp);
    const distTipToMiddleMcp = GestureClassifier.dist(tip, middleMcp);
    const distTipToPinkyMcp = GestureClassifier.dist(tip, pinkyMcp);
    const distIpToPinkyMcp = GestureClassifier.dist(ip, pinkyMcp);

    const cosThumb = GestureClassifier.bendCosine(cmc, mcp, tip);

    return (
      distTipToIndexMcp > palmScale * 0.48 &&
      distTipToMiddleMcp > palmScale * 0.62 &&
      distTipToPinkyMcp > distIpToPinkyMcp * 1.06 &&
      distTipToPinkyMcp > palmWidth * 1.05 &&
      cosThumb > 0.45
    );
  }

  /**
   * Computes finger extension states for all 5 digits.
   */
  public static getFingerStates(
    landmarks: NormalizedLandmark[]
  ): FingerExtensionStates {
    const palmScale = Math.max(
      0.02,
      GestureClassifier.dist(landmarks[0], landmarks[9])
    );

    const thumb = GestureClassifier.isThumbExtended(landmarks, palmScale);
    const index = GestureClassifier.isFingerExtended(
      landmarks,
      5,
      6,
      7,
      8,
      palmScale
    );
    const middle = GestureClassifier.isFingerExtended(
      landmarks,
      9,
      10,
      11,
      12,
      palmScale
    );
    const ring = GestureClassifier.isFingerExtended(
      landmarks,
      13,
      14,
      15,
      16,
      palmScale
    );
    const pinky = GestureClassifier.isFingerExtended(
      landmarks,
      17,
      18,
      19,
      20,
      palmScale
    );

    return { thumb, index, middle, ring, pinky };
  }

  /**
   * Classifies raw single-frame gesture from 21 hand landmarks.
   */
  private classifyRawGesture(
    landmarks: NormalizedLandmark[],
    fingerStates: FingerExtensionStates
  ): GestureMode {
    const palmScale = Math.max(
      0.02,
      GestureClassifier.dist(landmarks[0], landmarks[9])
    );

    const middleCurled = GestureClassifier.isFingerCurled(
      landmarks,
      9,
      10,
      11,
      12,
      palmScale
    );
    const ringCurled = GestureClassifier.isFingerCurled(
      landmarks,
      13,
      14,
      15,
      16,
      palmScale
    );
    const pinkyCurled = GestureClassifier.isFingerCurled(
      landmarks,
      17,
      18,
      19,
      20,
      palmScale
    );
    const indexCurled = GestureClassifier.isFingerCurled(
      landmarks,
      5,
      6,
      7,
      8,
      palmScale
    );

    // 1. Open Palm (Clear Canvas): All 5 fingers extended and spread
    if (
      fingerStates.thumb &&
      fingerStates.index &&
      fingerStates.middle &&
      fingerStates.ring &&
      fingerStates.pinky
    ) {
      const spreadSpan = GestureClassifier.dist(landmarks[8], landmarks[20]);
      if (spreadSpan > palmScale * 0.55) {
        return 'CLEARING';
      }
    }

    // 2. Peace / V Sign (Hover Mode): Index + Middle extended, Ring + Pinky curled
    if (
      fingerStates.index &&
      fingerStates.middle &&
      !fingerStates.ring &&
      !fingerStates.pinky &&
      ringCurled &&
      pinkyCurled
    ) {
      return 'HOVERING';
    }

    // 3. Index Point (Draw Mode): Index extended, Middle + Ring + Pinky curled
    if (
      fingerStates.index &&
      !fingerStates.middle &&
      !fingerStates.ring &&
      !fingerStates.pinky &&
      middleCurled &&
      ringCurled &&
      pinkyCurled
    ) {
      return 'DRAWING';
    }

    // 4. Closed Fist (Eraser Mode): All 4 fingers curled and thumb not openly extended
    if (
      !fingerStates.index &&
      !fingerStates.middle &&
      !fingerStates.ring &&
      !fingerStates.pinky &&
      indexCurled &&
      middleCurled &&
      ringCurled &&
      pinkyCurled &&
      !fingerStates.thumb
    ) {
      return 'ERASER';
    }

    // Fallback transitional posture defaults to non-destructive HOVERING
    return 'HOVERING';
  }

  /**
   * Evaluates the current hand landmarks and timestamp to produce the stabilized
   * gesture state, mirrored cursor coordinates, and 1.5s radial palm-clear progress.
   */
  public evaluate(
    landmarks: NormalizedLandmark[] | null | undefined,
    nowMs: number
  ): GestureEvaluationResult {
    const inClearCooldown = nowMs < this.cooldownUntilMs;

    if (!landmarks || landmarks.length < 21) {
      this.activeMode = 'LOOKING';
      this.pendingMode = 'LOOKING';
      this.pendingCount = 0;

      if (
        this.clearHoldStartMs !== null &&
        this.lastClearFrameMs !== null &&
        nowMs - this.lastClearFrameMs > this.clearDropoutGraceMs
      ) {
        this.clearHoldStartMs = null;
        this.lastClearFrameMs = null;
      }

      return {
        mode: 'LOOKING',
        rawMode: 'LOOKING',
        cursorNormalized: null,
        palmCenterNormalized: null,
        clearProgress: 0,
        shouldTriggerClear: false,
        inClearCooldown,
        fingerStates: null,
      };
    }

    const fingerStates = GestureClassifier.getFingerStates(landmarks);
    const rawMode = this.classifyRawGesture(landmarks, fingerStates);

    // Mirror X coordinate: x = 1 - landmark.x
    const indexTip: Point2D = {
      x: 1.0 - landmarks[8].x,
      y: landmarks[8].y,
    };
    const palmCenter: Point2D = {
      x: 1.0 - landmarks[9].x,
      y: landmarks[9].y,
    };

    // Stabilize transitions:
    // - Exiting DRAWING to any other posture happens immediately on frame 1
    //   so lifting or curling a finger never drags an unwanted tail stroke.
    // - Entering DRAWING or ERASER requires confirmFramesRequired consecutive frames
    //   to eliminate accidental false triggers while navigating across the screen.
    if (rawMode === this.activeMode) {
      this.pendingMode = rawMode;
      this.pendingCount = 0;
    } else {
      const immediateTransition =
        rawMode === 'HOVERING' || rawMode === 'CLEARING';

      if (immediateTransition || this.confirmFramesRequired <= 1) {
        this.activeMode = rawMode;
        this.pendingMode = rawMode;
        this.pendingCount = 0;
      } else {
        // If currently DRAWING and user curls into ERASER, lift pen immediately to HOVERING
        // while confirming ERASER over confirmFramesRequired frames.
        if (this.activeMode === 'DRAWING') {
          this.activeMode = 'HOVERING';
        }

        if (this.pendingMode === rawMode) {
          this.pendingCount += 1;
        } else {
          this.pendingMode = rawMode;
          this.pendingCount = 1;
        }

        if (this.pendingCount >= this.confirmFramesRequired) {
          this.activeMode = rawMode;
          this.pendingCount = 0;
        }
      }
    }

    // Handle 1.5-second Open Palm Clear timer & 2-second cooldown
    let clearProgress = 0;
    let shouldTriggerClear = false;

    if (this.activeMode === 'CLEARING') {
      if (inClearCooldown) {
        // During 2-second cooldown after a wipe, show hover behavior without re-clearing
        this.clearHoldStartMs = null;
        this.lastClearFrameMs = null;
      } else {
        if (this.clearHoldStartMs === null) {
          this.clearHoldStartMs = nowMs;
        }
        this.lastClearFrameMs = nowMs;
        const elapsed = Math.max(0, nowMs - this.clearHoldStartMs);
        clearProgress = Math.min(1.0, elapsed / this.clearHoldDurationMs);

        if (elapsed >= this.clearHoldDurationMs) {
          shouldTriggerClear = true;
          clearProgress = 1.0;
          this.cooldownUntilMs = nowMs + this.clearCooldownDurationMs;
          this.clearHoldStartMs = null;
          this.lastClearFrameMs = null;
        }
      }
    } else {
      if (
        this.clearHoldStartMs !== null &&
        this.lastClearFrameMs !== null &&
        nowMs - this.lastClearFrameMs <= this.clearDropoutGraceMs
      ) {
        // Keep hold timer alive across brief 1-frame jitter
        const elapsed = Math.max(0, nowMs - this.clearHoldStartMs);
        clearProgress = Math.min(0.99, elapsed / this.clearHoldDurationMs);
      } else {
        this.clearHoldStartMs = null;
        this.lastClearFrameMs = null;
      }
    }

    const effectiveMode: GestureMode =
      this.activeMode === 'CLEARING' && inClearCooldown && !shouldTriggerClear
        ? 'HOVERING'
        : this.activeMode;

    return {
      mode: effectiveMode,
      rawMode,
      cursorNormalized: indexTip,
      palmCenterNormalized: palmCenter,
      clearProgress,
      shouldTriggerClear,
      inClearCooldown: nowMs < this.cooldownUntilMs,
      fingerStates,
    };
  }

  public reset(): void {
    this.activeMode = 'LOOKING';
    this.pendingMode = 'LOOKING';
    this.pendingCount = 0;
    this.clearHoldStartMs = null;
    this.lastClearFrameMs = null;
    this.cooldownUntilMs = 0;
  }
}
