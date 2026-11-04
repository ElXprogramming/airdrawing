export interface Point2D {
  x: number;
  y: number;
}

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export type GestureMode =
  | 'LOOKING'
  | 'DRAWING'
  | 'HOVERING'
  | 'ERASER'
  | 'CLEARING';

export type CameraBgMode = 'full' | 'dimmed' | 'studio';

export interface ColorSwatch {
  id: string;
  name: string;
  hex: string;
  glow: string;
}

export interface BrushPreset {
  id: 'fine' | 'medium' | 'marker';
  label: string;
  size: number;
}

export interface FingerExtensionStates {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
}

export interface GestureEvaluationResult {
  mode: GestureMode;
  rawMode: GestureMode;
  /** Mirrored normalized [0..1] coordinates for active cursor (Landmark 8 or fist/eraser center) */
  cursorNormalized: Point2D | null;
  /** Mirrored normalized [0..1] coordinates for palm center (Landmark 9) */
  palmCenterNormalized: Point2D | null;
  /** Progress of 1.5-second open palm clear gesture in [0..1] */
  clearProgress: number;
  /** True on the exact transition frame when 1.5s open palm hold completes */
  shouldTriggerClear: boolean;
  /** True while inside the 2.0s post-clear cooldown window */
  inClearCooldown: boolean;
  /** Finger extension debug/telemetry state */
  fingerStates: FingerExtensionStates | null;
}

export interface StrokeAction {
  id: string;
  type: 'draw' | 'erase' | 'clear';
  color: string;
  size: number;
  points: Point2D[]; // Stored in normalized [0..1] canvas coordinates so resize is lossless
}

export interface AppState {
  gestureMode: GestureMode;
  clearProgress: number;
  activeColor: string;
  brushSize: number;
  eraserRadius: number;
  cameraBgMode: CameraBgMode;
  showSkeleton: boolean;
  fps: number;
  delegate: 'GPU' | 'CPU' | 'INIT';
  canUndo: boolean;
  canRedo: boolean;
  hasPerformedFirstGesture: boolean;
  cameraReady: boolean;
  cameraError: string | null;
}

export const INK_PALETTE: ColorSwatch[] = [
  {
    id: 'neon-cyan',
    name: 'Neon Cyan',
    hex: '#00F0FF',
    glow: 'rgba(0, 240, 255, 0.75)',
  },
  {
    id: 'neon-magenta',
    name: 'Neon Magenta',
    hex: '#FF007F',
    glow: 'rgba(255, 0, 127, 0.75)',
  },
  {
    id: 'coral-red',
    name: 'Coral Red',
    hex: '#FF3B5C',
    glow: 'rgba(255, 59, 92, 0.75)',
  },
  {
    id: 'solar-yellow',
    name: 'Solar Yellow',
    hex: '#FFE600',
    glow: 'rgba(255, 230, 0, 0.75)',
  },
  {
    id: 'acid-lime',
    name: 'Acid Lime',
    hex: '#39FF14',
    glow: 'rgba(57, 255, 20, 0.75)',
  },
  {
    id: 'pure-white',
    name: 'Pure White',
    hex: '#FFFFFF',
    glow: 'rgba(255, 255, 255, 0.8)',
  },
];

export const BRUSH_PRESETS: BrushPreset[] = [
  { id: 'fine', label: 'Fine (3px)', size: 3 },
  { id: 'medium', label: 'Medium (8px)', size: 8 },
  { id: 'marker', label: 'Marker (18px)', size: 18 },
];

export const CAMERA_BG_OPACITY: Record<CameraBgMode, number> = {
  full: 1.0,
  dimmed: 0.3,
  studio: 0.0,
};

export const CAMERA_BG_LABELS: Record<CameraBgMode, string> = {
  full: '100% Video',
  dimmed: '30% Dimmed',
  studio: '0% Studio',
};
