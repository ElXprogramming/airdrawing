import { describe, expect, it } from 'vitest';
import { GestureClassifier } from '../gestures/GestureClassifier';
import { OneEuroFilter1D, PointSmoother2D } from '../math/OneEuroFilter';
import type { NormalizedLandmark } from '../types';

/**
 * Helper to synthesize realistic 21-point MediaPipe hand landmarks
 * for each posture in normalized [0..1] space.
 */
function createSyntheticHand(options: {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
  rotationRad?: number;
  scale?: number;
}): NormalizedLandmark[] {
  const {
    thumb,
    index,
    middle,
    ring,
    pinky,
    rotationRad = 0,
    scale = 1.0,
  } = options;

  // Base wrist at (0.5, 0.75)
  const cx = 0.5;
  const cy = 0.75;

  const rawPoints: Array<{ x: number; y: number; z: number }> = new Array(21)
    .fill(null)
    .map(() => ({ x: cx, y: cy, z: 0 }));

  // 0: Wrist
  rawPoints[0] = { x: 0, y: 0, z: 0 };

  // Thumb (1..4)
  rawPoints[1] = { x: -0.05, y: -0.03, z: 0 };
  rawPoints[2] = { x: -0.09, y: -0.08, z: 0 };
  if (thumb) {
    rawPoints[3] = { x: -0.14, y: -0.13, z: 0 };
    rawPoints[4] = { x: -0.19, y: -0.18, z: 0 };
  } else {
    // Folded across palm toward index/middle MCP
    rawPoints[3] = { x: -0.05, y: -0.12, z: 0 };
    rawPoints[4] = { x: -0.01, y: -0.13, z: 0 };
  }

  // Helper to populate a 4-joint finger (MCP, PIP, DIP, TIP)
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
      // Curled back toward palm/MCP
      rawPoints[mcpIdx + 1] = { x: baseX, y: baseY - 0.04, z: 0 };
      rawPoints[mcpIdx + 2] = { x: baseX, y: baseY - 0.01, z: 0 };
      rawPoints[mcpIdx + 3] = { x: baseX, y: baseY + 0.02, z: 0 };
    }
  };

  setFinger(5, -0.06, -0.15, index, -0.03);
  setFinger(9, -0.02, -0.16, middle, -0.005);
  setFinger(13, 0.02, -0.15, ring, 0.02);
  setFinger(17, 0.06, -0.13, pinky, 0.05);

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

    // Variance of filtered signal should be substantially smaller than raw jitter
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

describe('GestureClassifier — Point & Palm State Machine', () => {
  it('classifies Draw Mode (Index extended, others curled) and mirrors X coordinate', () => {
    const classifier = new GestureClassifier({ confirmFramesRequired: 2 });
    const drawHand = createSyntheticHand({
      thumb: false,
      index: true,
      middle: false,
      ring: false,
      pinky: false,
    });

    // Frame 1 (pending confirmation)
    classifier.evaluate(drawHand, 100);
    // Frame 2 (confirmed)
    const res = classifier.evaluate(drawHand, 133);

    expect(res.mode).toBe('DRAWING');
    expect(res.cursorNormalized).not.toBeNull();
    expect(res.cursorNormalized!.x).toBeCloseTo(1.0 - drawHand[8].x, 5);
    expect(res.cursorNormalized!.y).toBeCloseTo(drawHand[8].y, 5);
  });

  it('classifies Hover Mode (Peace / V sign) and exits Draw Mode on the very first frame', () => {
    const classifier = new GestureClassifier({ confirmFramesRequired: 2 });
    const drawHand = createSyntheticHand({
      thumb: false,
      index: true,
      middle: false,
      ring: false,
      pinky: false,
    });
    const peaceHand = createSyntheticHand({
      thumb: false,
      index: true,
      middle: true,
      ring: false,
      pinky: false,
    });

    classifier.evaluate(drawHand, 100);
    expect(classifier.evaluate(drawHand, 133).mode).toBe('DRAWING');

    // Immediate 1-frame pen-up transition to HOVERING
    const hoverRes = classifier.evaluate(peaceHand, 166);
    expect(hoverRes.mode).toBe('HOVERING');
  });

  it('classifies Eraser Mode (Closed Fist)', () => {
    const classifier = new GestureClassifier({ confirmFramesRequired: 2 });
    const fistHand = createSyntheticHand({
      thumb: false,
      index: false,
      middle: false,
      ring: false,
      pinky: false,
    });

    classifier.evaluate(fistHand, 100);
    const res = classifier.evaluate(fistHand, 133);
    expect(res.mode).toBe('ERASER');
  });

  it('is invariant to hand tilt rotation and camera distance scaling', () => {
    const classifier = new GestureClassifier({ confirmFramesRequired: 1 });

    // Tilted 65 degrees and scaled 0.6x (farther from camera)
    const tiltedDraw = createSyntheticHand({
      thumb: false,
      index: true,
      middle: false,
      ring: false,
      pinky: false,
      rotationRad: (65 * Math.PI) / 180,
      scale: 0.6,
    });
    expect(classifier.evaluate(tiltedDraw, 200).mode).toBe('DRAWING');

    // Tilted -50 degrees and scaled 1.5x (closer to camera)
    const tiltedHover = createSyntheticHand({
      thumb: false,
      index: true,
      middle: true,
      ring: false,
      pinky: false,
      rotationRad: (-50 * Math.PI) / 180,
      scale: 1.5,
    });
    expect(classifier.evaluate(tiltedHover, 233).mode).toBe('HOVERING');
  });

  it('triggers Canvas Clear after 1.5s continuous Open Palm hold and enforces 2s cooldown', () => {
    const classifier = new GestureClassifier({
      clearHoldDurationMs: 1500,
      clearCooldownDurationMs: 2000,
      confirmFramesRequired: 2,
    });
    const openPalm = createSyntheticHand({
      thumb: true,
      index: true,
      middle: true,
      ring: true,
      pinky: true,
    });

    // Start at t = 1000ms
    const r0 = classifier.evaluate(openPalm, 1000);
    expect(r0.mode).toBe('CLEARING');
    expect(r0.clearProgress).toBe(0);
    expect(r0.shouldTriggerClear).toBe(false);

    // Halfway at t = 1750ms (750ms elapsed -> 50%)
    const rHalf = classifier.evaluate(openPalm, 1750);
    expect(rHalf.mode).toBe('CLEARING');
    expect(rHalf.clearProgress).toBeCloseTo(0.5, 2);
    expect(rHalf.shouldTriggerClear).toBe(false);

    // Complete at t = 2500ms (1500ms elapsed -> 100% trigger!)
    const rDone = classifier.evaluate(openPalm, 2500);
    expect(rDone.clearProgress).toBe(1.0);
    expect(rDone.shouldTriggerClear).toBe(true);
    expect(rDone.inClearCooldown).toBe(true);

    // During 2-second cooldown (t = 3200ms), holding palm does not re-trigger clear
    const rCooldown = classifier.evaluate(openPalm, 3200);
    expect(rCooldown.shouldTriggerClear).toBe(false);
    expect(rCooldown.inClearCooldown).toBe(true);
    expect(rCooldown.mode).toBe('HOVERING');

    // After 2-second cooldown expires (t = 4600ms), open palm can start a new clear cycle
    const rPostCooldown = classifier.evaluate(openPalm, 4600);
    expect(rPostCooldown.inClearCooldown).toBe(false);
    expect(rPostCooldown.mode).toBe('CLEARING');
  });
});
