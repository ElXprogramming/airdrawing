import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '../types';

const LOCAL_WASM_PATH = '/wasm';
const CDN_WASM_PATH =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';

const LOCAL_MODEL_PATH = '/models/hand_landmarker.task';
const CDN_MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandTracker {
  private handLandmarker: HandLandmarker | null = null;
  private activeDelegate: 'GPU' | 'CPU' = 'GPU';
  private lastTimestampMs = 0;

  /**
   * Initializes MediaPipe HandLandmarker using local WASM & model assets
   * (with CDN fallback) and GPU acceleration (with automatic CPU fallback).
   */
  public async init(): Promise<'GPU' | 'CPU'> {
    let visionWasm: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

    try {
      visionWasm = await FilesetResolver.forVisionTasks(LOCAL_WASM_PATH);
    } catch {
      visionWasm = await FilesetResolver.forVisionTasks(CDN_WASM_PATH);
    }

    const tryCreate = async (
      modelPath: string,
      delegate: 'GPU' | 'CPU'
    ): Promise<HandLandmarker> => {
      return HandLandmarker.createFromOptions(visionWasm, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate,
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      });
    };

    // 1. Try local model with GPU delegate
    try {
      this.handLandmarker = await tryCreate(LOCAL_MODEL_PATH, 'GPU');
      this.activeDelegate = 'GPU';
      return 'GPU';
    } catch {
      // 2. Fallback to local model with CPU delegate
      try {
        this.handLandmarker = await tryCreate(LOCAL_MODEL_PATH, 'CPU');
        this.activeDelegate = 'CPU';
        return 'CPU';
      } catch {
        // 3. Fallback to CDN model with GPU, then CPU
        try {
          this.handLandmarker = await tryCreate(CDN_MODEL_PATH, 'GPU');
          this.activeDelegate = 'GPU';
          return 'GPU';
        } catch {
          this.handLandmarker = await tryCreate(CDN_MODEL_PATH, 'CPU');
          this.activeDelegate = 'CPU';
          return 'CPU';
        }
      }
    }
  }

  /**
   * Runs hand landmark inference on the current video frame.
   * Enforces monotonically increasing timestamps required by MediaPipe VIDEO mode.
   */
  public detect(
    video: HTMLVideoElement,
    nowMs: number
  ): NormalizedLandmark[] | null {
    if (!this.handLandmarker) {
      return null;
    }

    const monotonicMs = Math.max(
      this.lastTimestampMs + 1,
      Math.floor(nowMs)
    );
    this.lastTimestampMs = monotonicMs;

    try {
      const result = this.handLandmarker.detectForVideo(video, monotonicMs);
      if (result.landmarks && result.landmarks.length > 0) {
        return result.landmarks[0] as NormalizedLandmark[];
      }
    } catch (err) {
      console.warn('HandLandmarker frame detection warning:', err);
    }

    return null;
  }

  public getDelegate(): 'GPU' | 'CPU' {
    return this.activeDelegate;
  }

  public isReady(): boolean {
    return this.handLandmarker !== null;
  }

  public close(): void {
    if (this.handLandmarker) {
      this.handLandmarker.close();
      this.handLandmarker = null;
    }
  }
}
