import { describe, expect, it } from 'vitest';
import { GestureClassifier } from '../gestures/GestureClassifier';
import { OneEuroFilter1D, PointSmoother2D } from '../math/OneEuroFilter';
import type { NormalizedLandmark } from '../types';

/**
 * Helper to synthesize realistic 21-point MediaPipe hand landmarks
 * for Pinch-to-Draw, Open-Hand Hover, and Closed-Fist Eraser postures.
 */
function createSyntheticHand(options: {
  posture: 'PINCH' | 'OPEN_HOVER' | 'CLOSED_FIST';
  pinchGapRatio?: number;
  rotationRad?: number;
  scale?: number;
}): NormalizedLandmark[] {
  const {
    posture,
    pinchGapRatio = posture === 'PINCH' ? 0.12 : 0.75,
    rotationRad = 0,
    scale = 1.0,
  } = options;

  const cx = 0.5;
  const cy = 0.75;
  const palmLen = 0.16;

  const rawPoints: Array<{ x: number; y: number; z: number }> = new Array(21)
    .fill(null)
    .map(() => ({ x: 0, y: 0, z: 0 }));

  // 0: Wrist at origin, 9: Middle MCP at (0, -palmLen) -> palmScale = 0.16
  rawPoints[0] = { x: 0, y: 0, z: 0 };

  const setFinger = (
    mcpIdx: number,
    baseX: number,
    baseY: number,
    isExtended: boolean,
    spreadX = 0
  ) => {
    rawPoints[mcpIdx] = { x: baseX, y: baseY, z: 0 };
    if (isExtended) {
      rawPoints[mcpIdx + 1] = {
        x: baseX + spreadX * 0.33,
        y: baseY - 0.06,
        z: 0,
      };
      rawPoints[mcpIdx + 2] = {
        x: baseX + spreadX * 0.66,
        y: baseY - 0.11,
        z: 0,
      };
      rawPoints[mcpIdx + 3] = {
        x: baseX + spreadX,
        y: baseY - 0.16,
        z: 0,
      };
    } else {
      rawPoints[mcpIdx + 1] = { x: baseX, y: baseY - 0.03, z: 0 };
      rawPoints[mcpIdx + 2] = { x: baseX, y: baseY - 0.01, z: 0 };
      rawPoints[mcpIdx + 3] = { x: baseX, y: baseY + 0.02, z: 0 };
    }
  };

  if (posture === 'PINCH') {
    // Index finger angled toward thumb tip; Middle, Ring, Pinky extended/relaxed
    rawPoints[5] = { x: -0.05, y: -0.15, z: 0 };
    rawPoints[6] = { x: -0.06, y: -0.21, z: 0 };
    rawPoints[7] = { x: -0.06, y: -0.25, z: 0 };
    rawPoints[8] = { x: -0.05, y: -0.27, z: 0 };

    const gap = pinchGapRatio * palmLen;
    rawPoints[1] = { x: -0.04, y: -0.04, z: 0 };
    rawPoints[2] = { x: -0.07, y: -0.11, z: 0 };
    rawPoints[3] = { x: -0.07, y: -0.19, z: 0 };
    rawPoints[4] = { x: -0.05 - gap, y: -0.27, z: 0 };

    setFinger(9, -0.01, -palmLen, true, 0);
    setFinger(13, 0.03, -0.15, true, 0.02);
    setFinger(17, 0.06, -0.13, true, 0.04);
  } else if (posture === 'OPEN_HOVER') {
    // Open hand with thumb and index separated
    rawPoints[1] = { x: -0.05, y: -0.03, z: 0 };
    rawPoints[2] = { x: -0.09, y: -0.08, z: 0 };
    rawPoints[3] = { x: -0.14, y: -0.13, z: 0 };
    rawPoints[4] = { x: -0.19, y: -0.18, z: 0 };

    setFinger(5, -0.05, -0.15, true, -0.03);
    setFinger(9, -0.01, -palmLen, true, 0);
    setFinger(13, 0.03, -0.15, true, 0.02);
    setFinger(17, 0.06, -0.13, true, 0.04);
  } else {
    // CLOSED_FIST: all 4 fingers curled tightly, thumb tucked along lower palm
    rawPoints[1] = { x: -0.04, y: -0.03, z: 0 };
    rawPoints[2] = { x: -0.06, y: -0.07, z: 0 };
    rawPoints[3] = { x: -0.03, y: -0.09, z: 0 };
    rawPoints[4] = { x: 0.02, y: -0.09, z: 0 };

    setFinger(5, -0.05, -0.15, false);
    setFinger(9, -0.01, -palmLen, false);
    setFinger(13, 0.03, -0.15, false);
    setFinger(17, 0.06, -0.13, false);
  }

  const cosR = Math.cos(rotationRad);
  const sinR = Math.sin(rotationRad);

  return rawPoints.map((pt) => {
    const sx = pt.x * scale;
    const sy = pt.y * scale;
    const rx = sx * cosR - sy * sinR;
    const ry = sx * sinR + sy * cosR;
    return {
      x: cx + rx,
      y: cy + ry,
      z: pt.z * scale,
    };
  });
}

describe('OneEuroFilter1D & PointSmoother2D', () => {
  it('suppresses high-frequency micro-jitter while stationary', () => {
    const filter = new OneEuroFilter1D(1.2, 1.5, 1.0);
    const rawValues = [0.5, 0.504, 0.496, 0.505, 0.495, 0.503, 0.497, 0.5];
    const filtered: number[] = [];

    rawValues.forEach((v, idx) => {
      filtered.push(filter.filter(v, idx * 16.67));
    });

    const rawRange = Math.max(...rawValues) - Math.min(...rawValues);
    const filteredTail = filtered.slice(2);
    const filteredRange =
      Math.max(...filteredTail) - Math.min(...filteredTail);

    expect(filteredRange).toBeLessThan(rawRange * 0.65);
  });

  it('tracks rapid cursor movements with minimal lag and smooth 60fps interpolation', () => {
    const smoother = new PointSmoother2D();
    smoother.updateFromMeasurement({ x: 0.1, y: 0.1 }, 0);
    smoother.updateFromMeasurement({ x: 0.8, y: 0.8 }, 33);

    let pt = smoother.stepRenderFrame(0.6);
    expect(pt).not.toBeNull();
    for (let i = 0; i < 10; i++) {
      pt = smoother.stepRenderFrame(0.6);
    }
    expect(pt!.x).toBeGreaterThan(0.5);
    expect(pt!.y).toBeGreaterThan(0.5);
  });
});

describe('GestureClassifier — Pinch-to-Draw State Machine', () => {
  it('classifies Pinch (Thumb 4 + Index 8 < epsilon) as DRAWING and blends cursor to pinch midpoint', () => {
    const classifier = new GestureClassifier({ confirmFramesRequired: 2 });
    const pinchHand = createSyntheticHand({ posture: 'PINCH' });

    classifier.evaluate(pinchHand, 100);
    const res = classifier.evaluate(pinchHand, 133);

    expect(res.mode).toBe('DRAWING');
    expect(res.isPinching).toBe(true);
    expect(res.pinchProximity).toBe(1);

    const expectedMidX = 1.0 - (pinchHand[8].x + pinchHand[4].x) * 0.5;
    const expectedMidY = (pinchHand[8].y + pinchHand[4].y) * 0.5;
    expect(res.cursorNormalized!.x).toBeCloseTo(expectedMidX, 4);
    expect(res.cursorNormalized!.y).toBeCloseTo(expectedMidY, 4);
  });

  it('maintains Pinch via hysteresis and exits immediately to HOVERING when fingers open', () => {
    const classifier = new GestureClassifier({
      pinchEnterThreshold: 0.34,
      pinchExitThreshold: 0.43,
      confirmFramesRequired: 1,
    });

    // Enter pinch at ratio 0.20 (< 0.34)
    const tightPinch = createSyntheticHand({
      posture: 'PINCH',
      pinchGapRatio: 0.2,
    });
    expect(classifier.evaluate(tightPinch, 100).mode).toBe('DRAWING');

    // Slight separation to ratio 0.38 (between 0.34 and 0.43) stays latched in DRAWING
    const hysteresisPinch = createSyntheticHand({
      posture: 'PINCH',
      pinchGapRatio: 0.38,
    });
    expect(classifier.evaluate(hysteresisPinch, 133).mode).toBe('DRAWING');

    // Opening fingers transitions immediately on frame 1 to HOVERING
    const openHand = createSyntheticHand({ posture: 'OPEN_HOVER' });
    const hoverRes = classifier.evaluate(openHand, 166);
    expect(hoverRes.mode).toBe('HOVERING');
    expect(hoverRes.isPinching).toBe(false);
  });

  it('classifies Closed Fist as ERASER and does not confuse it with Pinch', () => {
    const classifier = new GestureClassifier({ confirmFramesRequired: 2 });
    const fistHand = createSyntheticHand({ posture: 'CLOSED_FIST' });

    classifier.evaluate(fistHand, 100);
    const res = classifier.evaluate(fistHand, 133);
    expect(res.mode).toBe('ERASER');
    expect(res.isPinching).toBe(false);
  });

  it('is invariant to hand tilt rotation and camera distance scaling', () => {
    const classifier = new GestureClassifier({ confirmFramesRequired: 1 });

    const tiltedPinch = createSyntheticHand({
      posture: 'PINCH',
      rotationRad: (60 * Math.PI) / 180,
      scale: 0.65,
    });
    expect(classifier.evaluate(tiltedPinch, 200).mode).toBe('DRAWING');

    const tiltedHover = createSyntheticHand({
      posture: 'OPEN_HOVER',
      rotationRad: (-45 * Math.PI) / 180,
      scale: 1.4,
    });
    expect(classifier.evaluate(tiltedHover, 233).mode).toBe('HOVERING');

    const tiltedFist = createSyntheticHand({
      posture: 'CLOSED_FIST',
      rotationRad: (35 * Math.PI) / 180,
      scale: 0.8,
    });
    expect(classifier.evaluate(tiltedFist, 266).mode).toBe('ERASER');
  });
});
