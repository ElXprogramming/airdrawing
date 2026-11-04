import type {
  FingerExtensionStates,
  GestureEvaluationResult,
  GestureMode,
  NormalizedLandmark,
  Point2D,
} from '../types';

export interface GestureClassifierConfig {
  /** Normalized distance threshold (dist(4,8) / palmScale) to enter Pinch Draw mode (default: 0.34) */
  pinchEnterThreshold?: number;
  /** Normalized distance threshold (dist(4,8) / palmScale) to exit Pinch Draw mode (default: 0.43) */
  pinchExitThreshold?: number;
  /** Consecutive frames required to confirm entering DRAWING or ERASER mode (default: 2) */
  confirmFramesRequired?: number;
}

/**
 * Scale- and tilt-invariant geometric heuristic classifier for the
 * "Pinch to Draw" gesture state machine:
 * - Pinch (Thumb 4 + Index 8 < epsilon): DRAWING (Pen Down) or Spatial UI Air-Click
 * - Open / Relaxed Hand: HOVERING (Pen Up)
 * - Closed Fist (All fingers curled): ERASER
 */
export class GestureClassifier {
  private readonly pinchEnterThreshold: number;
  private readonly pinchExitThreshold: number;
  private readonly confirmFramesRequired: number;

  private activeMode: GestureMode = 'LOOKING';
  private pendingMode: GestureMode = 'LOOKING';
  private pendingCount = 0;
  private isPinchLatched = false;

  constructor(config: GestureClassifierConfig = {}) {
    this.pinchEnterThreshold = config.pinchEnterThreshold ?? 0.34;
    this.pinchExitThreshold = config.pinchExitThreshold ?? 0.43;
    this.confirmFramesRequired = config.confirmFramesRequired ?? 2;
  }

  /**
   * 3D-aware Euclidean distance in normalized landmark space.
   * Uses 0.25 weight on Z to remain resilient to monocular depth estimation noise.
   */
  public static dist(a: NormalizedLandmark, b: NormalizedLandmark): number {
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

    const cosPip = GestureClassifier.bendCosine(mcp, pip, dip);
    const cosDip = GestureClassifier.bendCosine(pip, dip, tip);

    const radialExtended =
      distWristTip > distWristPip * 1.1 &&
      distWristTip > distWristDip * 1.01 &&
      distMcpTip > palmScale * 0.55;

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
   * Evaluates the current hand landmarks to produce the stabilized
   * "Pinch to Draw" gesture state, mirrored cursor coordinates, and pinch proximity.
   */
  public evaluate(
    landmarks: NormalizedLandmark[] | null | undefined,
    _nowMs: number
  ): GestureEvaluationResult {
    if (!landmarks || landmarks.length < 21) {
      this.activeMode = 'LOOKING';
      this.pendingMode = 'LOOKING';
      this.pendingCount = 0;
      this.isPinchLatched = false;

      return {
        mode: 'LOOKING',
        rawMode: 'LOOKING',
        cursorNormalized: null,
        palmCenterNormalized: null,
        isPinching: false,
        pinchProximity: 0,
        clearProgress: 0,
        shouldTriggerClear: false,
        inClearCooldown: false,
        fingerStates: null,
      };
    }

    const palmScale = Math.max(
      0.02,
      GestureClassifier.dist(landmarks[0], landmarks[9])
    );
    const fingerStates = GestureClassifier.getFingerStates(landmarks);

    // Compute normalized pinch distance between Thumb Tip (4) and Index Tip (8)
    const pinchDist = GestureClassifier.dist(landmarks[4], landmarks[8]);
    const pinchRatio = pinchDist / palmScale;

    // Hysteresis latch for Pinch (prevents mid-stroke dropout)
    if (this.isPinchLatched) {
      if (pinchRatio > this.pinchExitThreshold) {
        this.isPinchLatched = false;
      }
    } else {
      if (pinchRatio < this.pinchEnterThreshold) {
        this.isPinchLatched = true;
      }
    }

    // Continuous proximity [0..1] for dynamic aiming reticle feedback
    const maxHoverRatio = 0.85;
    const rawProximity =
      (maxHoverRatio - pinchRatio) /
      Math.max(0.05, maxHoverRatio - this.pinchEnterThreshold);
    const pinchProximity = Math.max(0, Math.min(1, rawProximity));

    // Check if all 4 main fingers are curled into a Closed Fist
    const indexCurled = GestureClassifier.isFingerCurled(
      landmarks,
      5,
      6,
      7,
      8,
      palmScale
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

    const allFourCurled =
      !fingerStates.index &&
      !fingerStates.middle &&
      !fingerStates.ring &&
      !fingerStates.pinky &&
      indexCurled &&
      middleCurled &&
      ringCurled &&
      pinkyCurled;

    // Distinguish Precision Pinch from Closed Fist:
    // In a Precision Pinch, Thumb Tip (4) and Index Tip (8) meet (< pinchThreshold),
    // and either at least one other finger is relaxed/extended OR the index tip is
    // held forward of the knuckle base rather than tucked into the wrist.
    const distWristIndexTip = GestureClassifier.dist(landmarks[0], landmarks[8]);
    const distWristIndexMcp = GestureClassifier.dist(landmarks[0], landmarks[5]);
    const indexFoldedDeepIntoPalm = distWristIndexTip < distWristIndexMcp * 0.96;

    let rawMode: GestureMode = 'HOVERING';

    if (this.isPinchLatched && !(allFourCurled && indexFoldedDeepIntoPalm)) {
      rawMode = 'DRAWING';
    } else if (allFourCurled && !fingerStates.thumb && !this.isPinchLatched) {
      rawMode = 'ERASER';
    } else {
      rawMode = 'HOVERING';
    }

    // Mirror X coordinate and smoothly blend cursor between Index Tip (8) when hovering
    // and the exact Pinch Midpoint ((4 + 8) / 2) when pinching.
    const blendToMidpoint = pinchProximity * 0.5;
    const rawCursorX =
      landmarks[8].x * (1 - blendToMidpoint) +
      landmarks[4].x * blendToMidpoint;
    const rawCursorY =
      landmarks[8].y * (1 - blendToMidpoint) +
      landmarks[4].y * blendToMidpoint;

    const cursorPoint: Point2D = {
      x: 1.0 - rawCursorX,
      y: rawCursorY,
    };

    const palmCenter: Point2D = {
      x: 1.0 - landmarks[9].x,
      y: landmarks[9].y,
    };

    // Stabilize transitions:
    // - Exiting DRAWING to HOVERING happens immediately on frame 1 (unpinching lifts pen immediately)
    // - Entering DRAWING or ERASER requires confirmFramesRequired consecutive frames
    if (rawMode === this.activeMode) {
      this.pendingMode = rawMode;
      this.pendingCount = 0;
    } else {
      const immediateTransition = rawMode === 'HOVERING';

      if (immediateTransition || this.confirmFramesRequired <= 1) {
        this.activeMode = rawMode;
        this.pendingMode = rawMode;
        this.pendingCount = 0;
      } else {
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

    return {
      mode: this.activeMode,
      rawMode,
      cursorNormalized: cursorPoint,
      palmCenterNormalized: palmCenter,
      isPinching: this.activeMode === 'DRAWING',
      pinchProximity,
      clearProgress: 0,
      shouldTriggerClear: false,
      inClearCooldown: false,
      fingerStates,
    };
  }

  public reset(): void {
    this.activeMode = 'LOOKING';
    this.pendingMode = 'LOOKING';
    this.pendingCount = 0;
    this.isPinchLatched = false;
  }
}
