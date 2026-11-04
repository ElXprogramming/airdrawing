import {
  BRUSH_PRESETS,
  CAMERA_BG_LABELS,
  INK_PALETTE,
  type AppState,
  type CameraBgMode,
  type GestureMode,
  type Point2D,
} from '../types';
import { ICONS } from './icons';

export interface ToolbarCallbacks {
  onSelectColor: (hex: string) => void;
  onSelectBrushSize: (sizePx: number) => void;
  onCycleCameraBg: () => void;
  onSelectCameraBg: (mode: CameraBgMode) => void;
  onToggleSkeleton: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onExportPng: () => void;
  onRetryCamera: () => void;
}

export interface SpatialUIInteractionResult {
  /** True when cursor is hovering over or interacting with the floating dock/UI */
  suppressCanvasDrawing: boolean;
  /** True when cursor is directly over an interactive dock button */
  isHoveringButton: boolean;
  /** True while actively pinch-holding the Trash button for 1.0s wipe */
  isHoldingTrash: boolean;
  /** Progress [0..1] of the 1.0s Trash pinch-hold */
  trashClearProgress: number;
  /** True on the exact frame when 1.0s Trash pinch-hold completes */
  shouldTriggerTrashClear: boolean;
}

const TRASH_HOLD_DURATION_MS = 1000;
const TRASH_COOLDOWN_MS = 1500;
const HIT_PADDING_PX = 8;

export class ToolbarUI {
  private readonly root: HTMLElement;
  private readonly callbacks: ToolbarCallbacks;

  private hudPillEl!: HTMLElement;
  private hudStatusTextEl!: HTMLElement;
  private hudRadialSvgEl!: SVGSVGElement;
  private hudRadialCircleEl!: SVGCircleElement;
  private fpsEl!: HTMLElement;
  private delegateEl!: HTMLElement;

  private capsuleEl!: HTMLElement;
  private colorButtons: Map<string, HTMLButtonElement> = new Map();
  private customColorInput!: HTMLInputElement;
  private customColorChip!: HTMLElement;
  private brushButtons: Map<number, HTMLButtonElement> = new Map();

  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private cameraBgBtn!: HTMLButtonElement;
  private cameraBgBadgeEl!: HTMLElement;
  private cameraBgSegmentBtns: Map<CameraBgMode, HTMLButtonElement> = new Map();
  private skeletonBtn!: HTMLButtonElement;
  private downloadBtn!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;

  private gestureGuideEl!: HTMLElement;
  private guideToggleBtn!: HTMLButtonElement;
  private guideManuallyPinned = false;
  private hasAutoHiddenGuide = false;

  private cameraBannerEl!: HTMLElement;
  private cameraBannerMsgEl!: HTMLElement;

  private interactiveTargets: HTMLElement[] = [];
  private currentHoveredTarget: HTMLElement | null = null;
  private wasPinchingPrevFrame = false;
  private pinchStartedInUI = false;
  private pinchStartedOnCanvas = false;

  private trashHoldStartMs: number | null = null;
  private trashCooldownUntilMs = 0;

  private lastRenderedMode: GestureMode | null = null;
  private lastClearPct = -1;

  constructor(root: HTMLElement, callbacks: ToolbarCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.buildDOM();
    this.bindKeyboardShortcuts();
  }

  private buildDOM(): void {
    // 1. Top Center — Dynamic Gesture Pill (HUD)
    const topHudWrapper = document.createElement('header');
    topHudWrapper.className = 'hud-top-wrapper';
    topHudWrapper.innerHTML = `
      <div class="gesture-pill mode-looking" id="gesture-pill" role="status" aria-live="polite">
        <div class="gesture-pill-indicator">
          <span class="status-dot"></span>
          <svg class="pill-radial-progress" width="22" height="22" viewBox="0 0 24 24">
            <circle class="pill-radial-track" cx="12" cy="12" r="9" fill="none" stroke-width="2.5"></circle>
            <circle class="pill-radial-bar" cx="12" cy="12" r="9" fill="none" stroke-width="2.5" stroke-dasharray="56.55" stroke-dashoffset="56.55"></circle>
          </svg>
        </div>
        <span class="gesture-pill-text" id="gesture-pill-text">[ 🔍 LOOKING FOR HAND ]</span>
        <div class="hud-divider"></div>
        <div class="hud-metrics">
          <span class="hud-fps" id="hud-fps">60 FPS</span>
          <span class="hud-delegate" id="hud-delegate">GPU</span>
        </div>
      </div>
    `;
    this.root.appendChild(topHudWrapper);

    this.hudPillEl = topHudWrapper.querySelector('#gesture-pill') as HTMLElement;
    this.hudStatusTextEl = topHudWrapper.querySelector(
      '#gesture-pill-text'
    ) as HTMLElement;
    this.hudRadialSvgEl = topHudWrapper.querySelector(
      '.pill-radial-progress'
    ) as SVGSVGElement;
    this.hudRadialCircleEl = topHudWrapper.querySelector(
      '.pill-radial-bar'
    ) as SVGCircleElement;
    this.fpsEl = topHudWrapper.querySelector('#hud-fps') as HTMLElement;
    this.delegateEl = topHudWrapper.querySelector(
      '#hud-delegate'
    ) as HTMLElement;

    // 2. Camera fallback banner (hidden when camera is active)
    this.cameraBannerEl = document.createElement('div');
    this.cameraBannerEl.className = 'camera-banner hidden';
    this.cameraBannerEl.innerHTML = `
      <span class="camera-banner-text" id="camera-banner-text">Camera unavailable — Pointer Studio Mode enabled (draw with mouse/touch)</span>
      <button type="button" class="camera-retry-btn" id="camera-retry-btn">Retry Camera</button>
    `;
    this.root.appendChild(this.cameraBannerEl);
    this.cameraBannerMsgEl = this.cameraBannerEl.querySelector(
      '#camera-banner-text'
    ) as HTMLElement;
    const retryBtn = this.cameraBannerEl.querySelector(
      '#camera-retry-btn'
    ) as HTMLButtonElement;
    retryBtn.addEventListener('click', () => this.callbacks.onRetryCamera());

    // 3. Bottom-Left — Floating Gesture Guide Cheat Sheet
    const guideWrapper = document.createElement('aside');
    guideWrapper.className = 'gesture-guide-wrapper';
    guideWrapper.innerHTML = `
      <div class="gesture-guide-card" id="gesture-guide-card" aria-label="Gesture Controls Guide">
        <div class="gesture-guide-header">
          <span class="gesture-guide-title">GESTURE CONTROLS</span>
          <span class="gesture-guide-badge">Pinch to Draw</span>
        </div>
        <ul class="gesture-guide-list">
          <li class="gesture-guide-item" data-gesture="DRAWING">
            <span class="gesture-emoji">🤏</span>
            <div class="gesture-info">
              <strong>Pinch (Thumb + Index)</strong>
              <span>Pen down &amp; draw strokes</span>
            </div>
          </li>
          <li class="gesture-guide-item" data-gesture="HOVERING">
            <span class="gesture-emoji">✋</span>
            <div class="gesture-info">
              <strong>Open Hand</strong>
              <span>Hover &amp; aim cursor</span>
            </div>
          </li>
          <li class="gesture-guide-item" data-gesture="AIRCLICK">
            <span class="gesture-emoji">🎯</span>
            <div class="gesture-info">
              <strong>Air-Click Dock</strong>
              <span>Hover tool &amp; pinch to select</span>
            </div>
          </li>
          <li class="gesture-guide-item" data-gesture="ERASER">
            <span class="gesture-emoji">✊</span>
            <div class="gesture-info">
              <strong>Closed Fist</strong>
              <span>Precision eraser</span>
            </div>
          </li>
          <li class="gesture-guide-item" data-gesture="CLEARING">
            <span class="gesture-emoji">🗑️</span>
            <div class="gesture-info">
              <strong>Hold Trash (1.0s)</strong>
              <span>Pinch &amp; hold 🗑️ to wipe canvas</span>
            </div>
          </li>
        </ul>
      </div>
      <button type="button" class="guide-toggle-btn" id="guide-toggle-btn" title="Toggle Gesture Guide (?)">
        ${ICONS.help}
      </button>
    `;
    this.root.appendChild(guideWrapper);

    this.gestureGuideEl = guideWrapper.querySelector(
      '#gesture-guide-card'
    ) as HTMLElement;
    this.guideToggleBtn = guideWrapper.querySelector(
      '#guide-toggle-btn'
    ) as HTMLButtonElement;
    this.guideToggleBtn.addEventListener('click', () => {
      const isHidden = this.gestureGuideEl.classList.contains('fade-out');
      if (isHidden) {
        this.guideManuallyPinned = true;
        this.gestureGuideEl.classList.remove('fade-out');
      } else {
        this.guideManuallyPinned = false;
        this.gestureGuideEl.classList.add('fade-out');
      }
    });

    // 4. Bottom Center — Floating Tool Capsule
    const bottomDock = document.createElement('nav');
    bottomDock.className = 'tool-capsule-wrapper';
    bottomDock.setAttribute('aria-label', 'Drawing Studio Controls');

    const capsule = document.createElement('div');
    capsule.className = 'tool-capsule';
    this.capsuleEl = capsule;

    // 4A. Color Swatches + Custom Color Picker
    const swatchGroup = document.createElement('div');
    swatchGroup.className = 'capsule-section swatch-group';
    swatchGroup.setAttribute('role', 'group');
    swatchGroup.setAttribute('aria-label', 'Ink Color Palette');

    for (const swatch of INK_PALETTE) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch-btn';
      btn.title = `${swatch.name} (${swatch.hex}) — Air-Pinch to select`;
      btn.setAttribute('aria-label', swatch.name);
      btn.dataset.color = swatch.hex;
      btn.style.setProperty('--swatch-color', swatch.hex);
      btn.style.setProperty('--swatch-glow', swatch.glow);
      btn.addEventListener('click', () => {
        this.callbacks.onSelectColor(swatch.hex);
      });
      swatchGroup.appendChild(btn);
      this.colorButtons.set(swatch.hex.toUpperCase(), btn);
      this.interactiveTargets.push(btn);
    }

    // Custom Color Picker Chip
    const customLabel = document.createElement('label');
    customLabel.className = 'color-swatch-btn custom-color-chip';
    customLabel.title = 'Custom Ink Color';
    customLabel.innerHTML = `
      <input type="color" class="sr-only-color-input" value="#00F0FF" aria-label="Custom Ink Color" />
      <span class="custom-color-icon">${ICONS.palette}</span>
    `;
    this.customColorInput = customLabel.querySelector(
      'input'
    ) as HTMLInputElement;
    this.customColorChip = customLabel;
    this.customColorInput.addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value.toUpperCase();
      this.callbacks.onSelectColor(val);
    });
    swatchGroup.appendChild(customLabel);
    capsule.appendChild(swatchGroup);

    capsule.appendChild(this.createDivider());

    // 4B. Brush Size Selector (3 discrete dot presets: Fine 3px, Medium 8px, Marker 18px)
    const brushGroup = document.createElement('div');
    brushGroup.className = 'capsule-section brush-group';
    brushGroup.setAttribute('role', 'group');
    brushGroup.setAttribute('aria-label', 'Brush Size Presets');

    for (const preset of BRUSH_PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'brush-preset-btn';
      btn.title = `${preset.label} — Air-Pinch to select`;
      btn.setAttribute('aria-label', preset.label);
      btn.dataset.size = String(preset.size);

      const visualDiameter =
        preset.id === 'fine' ? 6 : preset.id === 'medium' ? 11 : 17;
      btn.innerHTML = `<span class="brush-dot" style="width:${visualDiameter}px;height:${visualDiameter}px;"></span>`;

      btn.addEventListener('click', () => {
        this.callbacks.onSelectBrushSize(preset.size);
      });
      brushGroup.appendChild(btn);
      this.brushButtons.set(preset.size, btn);
      this.interactiveTargets.push(btn);
    }
    capsule.appendChild(brushGroup);

    capsule.appendChild(this.createDivider());

    // 4C. Camera Background 3-Way Control (100% Video | 30% Dimmed | 0% Studio)
    const bgGroup = document.createElement('div');
    bgGroup.className = 'capsule-section bg-control-group';

    this.cameraBgBtn = document.createElement('button');
    this.cameraBgBtn.type = 'button';
    this.cameraBgBtn.className = 'utility-btn camera-toggle-btn';
    this.cameraBgBtn.title = 'Cycle Camera Background (100% / 30% / 0%) [C]';
    this.cameraBgBtn.setAttribute('aria-label', 'Cycle Camera View');
    this.cameraBgBtn.innerHTML = `
      ${ICONS.camera}
      <span class="camera-bg-badge" id="camera-bg-badge">30%</span>
    `;
    this.cameraBgBadgeEl = this.cameraBgBtn.querySelector(
      '#camera-bg-badge'
    ) as HTMLElement;
    this.cameraBgBtn.addEventListener('click', () => {
      this.callbacks.onCycleCameraBg();
    });
    bgGroup.appendChild(this.cameraBgBtn);
    this.interactiveTargets.push(this.cameraBgBtn);

    const segContainer = document.createElement('div');
    segContainer.className = 'bg-segmented-pills';
    segContainer.setAttribute('role', 'group');
    segContainer.setAttribute('aria-label', 'Camera Background Opacity');
    const modes: Array<{ mode: CameraBgMode; short: string }> = [
      { mode: 'full', short: '100%' },
      { mode: 'dimmed', short: '30%' },
      { mode: 'studio', short: '0%' },
    ];
    for (const item of modes) {
      const segBtn = document.createElement('button');
      segBtn.type = 'button';
      segBtn.className = 'bg-seg-btn';
      segBtn.textContent = item.short;
      segBtn.title = CAMERA_BG_LABELS[item.mode];
      segBtn.addEventListener('click', () => {
        this.callbacks.onSelectCameraBg(item.mode);
      });
      segContainer.appendChild(segBtn);
      this.cameraBgSegmentBtns.set(item.mode, segBtn);
      this.interactiveTargets.push(segBtn);
    }
    bgGroup.appendChild(segContainer);
    capsule.appendChild(bgGroup);

    capsule.appendChild(this.createDivider());

    // 4D. Utility Actions: Undo (↩), Redo (↪), Hand Skeleton, Download PNG (📥), Trash/Clear (🗑️)
    const utilityGroup = document.createElement('div');
    utilityGroup.className = 'capsule-section utility-group';

    this.undoBtn = this.createUtilityButton(
      ICONS.undo,
      'Undo Stroke (Ctrl+Z or Air-Pinch)',
      'undo-btn',
      () => this.callbacks.onUndo()
    );
    this.redoBtn = this.createUtilityButton(
      ICONS.redo,
      'Redo Stroke (Ctrl+Y or Air-Pinch)',
      'redo-btn',
      () => this.callbacks.onRedo()
    );
    this.skeletonBtn = this.createUtilityButton(
      ICONS.skeleton,
      'Toggle Hand Skeleton Overlay (S or Air-Pinch)',
      'skeleton-btn',
      () => this.callbacks.onToggleSkeleton()
    );
    this.downloadBtn = this.createUtilityButton(
      ICONS.download,
      'Download PNG Artwork (Air-Pinch)',
      'download-btn',
      () => this.callbacks.onExportPng()
    );
    this.clearBtn = this.createUtilityButton(
      ICONS.trash,
      'Clear Canvas (Click or Air-Pinch & Hold 1.0s)',
      'clear-btn danger-hover',
      () => this.callbacks.onClear()
    );

    utilityGroup.append(
      this.undoBtn,
      this.redoBtn,
      this.skeletonBtn,
      this.downloadBtn,
      this.clearBtn
    );
    capsule.appendChild(utilityGroup);

    this.interactiveTargets.push(
      this.undoBtn,
      this.redoBtn,
      this.skeletonBtn,
      this.downloadBtn,
      this.clearBtn,
      this.guideToggleBtn
    );

    bottomDock.appendChild(capsule);
    this.root.appendChild(bottomDock);
  }

  private createDivider(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'capsule-divider';
    return div;
  }

  private createUtilityButton(
    svgHtml: string,
    title: string,
    extraClass: string,
    onClick: () => void
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `utility-btn ${extraClass}`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = svgHtml;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Evaluates spatial Air-Hover, Air-Click (Pinch on Dock Swatches/Buttons),
   * and Air-Pinch & Hold (1.0s on Trash Button to wipe canvas).
   */
  public evaluateSpatialCursor(
    cursorNormalized: Point2D | null,
    isPinching: boolean,
    nowMs: number
  ): SpatialUIInteractionResult {
    if (!cursorNormalized) {
      this.setHoveredTarget(null);
      this.wasPinchingPrevFrame = false;
      this.pinchStartedInUI = false;
      this.pinchStartedOnCanvas = false;
      this.trashHoldStartMs = null;
      return {
        suppressCanvasDrawing: false,
        isHoveringButton: false,
        isHoldingTrash: false,
        trashClearProgress: 0,
        shouldTriggerTrashClear: false,
      };
    }

    const screenX = cursorNormalized.x * window.innerWidth;
    const screenY = cursorNormalized.y * window.innerHeight;

    // Reset pinch origin latches when user opens their fingers
    if (!isPinching) {
      this.wasPinchingPrevFrame = false;
      this.pinchStartedInUI = false;
      this.pinchStartedOnCanvas = false;
      this.trashHoldStartMs = null;
    }

    // If the user began pinching out on the drawing canvas, allow continuous stroke
    // even if their hand passes near the bottom dock.
    if (this.pinchStartedOnCanvas && isPinching) {
      this.setHoveredTarget(null);
      return {
        suppressCanvasDrawing: false,
        isHoveringButton: false,
        isHoldingTrash: false,
        trashClearProgress: 0,
        shouldTriggerTrashClear: false,
      };
    }

    // Hit-test interactive dock targets & capsule bounding box
    const hitTarget = this.findHitTarget(screenX, screenY);
    const overCapsule = this.isPointInsideElement(
      screenX,
      screenY,
      this.capsuleEl,
      12
    );
    const isOverUI = hitTarget !== null || overCapsule;

    this.setHoveredTarget(hitTarget);

    // Rising edge of Pinch
    if (isPinching && !this.wasPinchingPrevFrame) {
      this.wasPinchingPrevFrame = true;
      if (isOverUI) {
        this.pinchStartedInUI = true;
        this.pinchStartedOnCanvas = false;

        if (hitTarget && hitTarget !== this.clearBtn) {
          // Air-Click dock button (Color swatch, Brush preset, Undo, Redo, Camera, etc.)
          if (!(hitTarget as HTMLButtonElement).disabled) {
            hitTarget.click();
            hitTarget.classList.add('air-clicked');
            setTimeout(() => hitTarget.classList.remove('air-clicked'), 240);
          }
        } else if (hitTarget === this.clearBtn && nowMs >= this.trashCooldownUntilMs) {
          this.trashHoldStartMs = nowMs;
        }
      } else {
        this.pinchStartedOnCanvas = true;
        this.pinchStartedInUI = false;
      }
    }

    // Handle continuous 1.0s Air-Pinch Hold on Trash Button
    let isHoldingTrash = false;
    let trashClearProgress = 0;
    let shouldTriggerTrashClear = false;

    if (
      isPinching &&
      this.pinchStartedInUI &&
      hitTarget === this.clearBtn &&
      nowMs >= this.trashCooldownUntilMs
    ) {
      if (this.trashHoldStartMs === null) {
        this.trashHoldStartMs = nowMs;
      }
      isHoldingTrash = true;
      const elapsed = Math.max(0, nowMs - this.trashHoldStartMs);
      trashClearProgress = Math.min(1.0, elapsed / TRASH_HOLD_DURATION_MS);

      if (elapsed >= TRASH_HOLD_DURATION_MS) {
        shouldTriggerTrashClear = true;
        trashClearProgress = 1.0;
        this.trashCooldownUntilMs = nowMs + TRASH_COOLDOWN_MS;
        this.trashHoldStartMs = null;
      }
    } else {
      this.trashHoldStartMs = null;
    }

    return {
      suppressCanvasDrawing: isOverUI || this.pinchStartedInUI,
      isHoveringButton: hitTarget !== null,
      isHoldingTrash,
      trashClearProgress,
      shouldTriggerTrashClear,
    };
  }

  private findHitTarget(x: number, y: number): HTMLElement | null {
    let bestTarget: HTMLElement | null = null;
    let bestDist = Infinity;

    for (const el of this.interactiveTargets) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      if (
        x >= rect.left - HIT_PADDING_PX &&
        x <= rect.right + HIT_PADDING_PX &&
        y >= rect.top - HIT_PADDING_PX &&
        y <= rect.bottom + HIT_PADDING_PX
      ) {
        const cx = (rect.left + rect.right) * 0.5;
        const cy = (rect.top + rect.bottom) * 0.5;
        const d = Math.hypot(x - cx, y - cy);
        if (d < bestDist) {
          bestDist = d;
          bestTarget = el;
        }
      }
    }
    return bestTarget;
  }

  private isPointInsideElement(
    x: number,
    y: number,
    el: HTMLElement,
    pad = 0
  ): boolean {
    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 &&
      x >= rect.left - pad &&
      x <= rect.right + pad &&
      y >= rect.top - pad &&
      y <= rect.bottom + pad
    );
  }

  private setHoveredTarget(target: HTMLElement | null): void {
    if (this.currentHoveredTarget === target) {
      return;
    }
    if (this.currentHoveredTarget) {
      this.currentHoveredTarget.classList.remove('air-hover');
    }
    this.currentHoveredTarget = target;
    if (this.currentHoveredTarget) {
      this.currentHoveredTarget.classList.add('air-hover');
    }
  }

  private bindKeyboardShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          this.callbacks.onRedo();
        } else {
          this.callbacks.onUndo();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        this.callbacks.onRedo();
        return;
      }

      if (key === 'c' && !e.ctrlKey && !e.metaKey) {
        this.callbacks.onCycleCameraBg();
      } else if (key === 's' && !e.ctrlKey && !e.metaKey) {
        this.callbacks.onToggleSkeleton();
      } else if (key === 'delete' || key === 'backspace') {
        this.callbacks.onClear();
      } else if (key === '?') {
        this.guideToggleBtn.click();
      }
    });
  }

  /**
   * Synchronizes the floating HUD and bottom tool capsule with current application state.
   */
  public sync(state: AppState): void {
    // 1. Update Top Gesture Pill
    const clearPct = Math.round(state.clearProgress * 100);
    if (
      state.gestureMode !== this.lastRenderedMode ||
      (state.gestureMode === 'CLEARING' && clearPct !== this.lastClearPct)
    ) {
      this.lastRenderedMode = state.gestureMode;
      this.lastClearPct = clearPct;

      this.hudPillEl.className = `gesture-pill mode-${state.gestureMode.toLowerCase()}`;

      switch (state.gestureMode) {
        case 'DRAWING':
          this.hudStatusTextEl.textContent = '[ 🤏 DRAWING ]';
          this.hudRadialSvgEl.style.display = 'none';
          break;
        case 'HOVERING':
          this.hudStatusTextEl.textContent = '[ ✋ HOVERING ]';
          this.hudRadialSvgEl.style.display = 'none';
          break;
        case 'ERASER':
          this.hudStatusTextEl.textContent = '[ ✊ ERASER ]';
          this.hudRadialSvgEl.style.display = 'none';
          break;
        case 'CLEARING': {
          this.hudStatusTextEl.textContent = `[ 🗑️ CLEARING (${clearPct}%) ]`;
          this.hudRadialSvgEl.style.display = 'block';
          const circumference = 56.55;
          const offset = circumference * (1 - state.clearProgress);
          this.hudRadialCircleEl.style.strokeDashoffset = `${offset}`;
          break;
        }
        case 'LOOKING':
        default:
          this.hudStatusTextEl.textContent = '[ 🔍 LOOKING FOR HAND ]';
          this.hudRadialSvgEl.style.display = 'none';
          break;
      }
    }

    // 2. Update FPS and Hardware Delegate
    this.fpsEl.textContent = `${state.fps} FPS`;
    this.delegateEl.textContent = state.delegate;

    // 3. Auto-fade Gesture Guide after first successful gesture
    if (
      state.hasPerformedFirstGesture &&
      !this.hasAutoHiddenGuide &&
      !this.guideManuallyPinned
    ) {
      this.hasAutoHiddenGuide = true;
      this.gestureGuideEl.classList.add('fade-out');
    }

    // 4. Update Active Color Swatches
    const upperColor = state.activeColor.toUpperCase();
    let matchedPreset = false;
    for (const [hex, btn] of this.colorButtons.entries()) {
      if (hex === upperColor) {
        btn.classList.add('active');
        matchedPreset = true;
      } else {
        btn.classList.remove('active');
      }
    }
    if (!matchedPreset) {
      this.customColorChip.classList.add('active');
      this.customColorChip.style.setProperty('--swatch-color', upperColor);
      this.customColorChip.style.setProperty('--swatch-glow', upperColor);
    } else {
      this.customColorChip.classList.remove('active');
    }

    // 5. Update Active Brush Preset
    for (const [size, btn] of this.brushButtons.entries()) {
      btn.classList.toggle('active', size === state.brushSize);
    }

    // 6. Update Camera Background Badge & Segmented Control
    const badgeLabel =
      state.cameraBgMode === 'full'
        ? '100%'
        : state.cameraBgMode === 'dimmed'
          ? '30%'
          : '0%';
    this.cameraBgBadgeEl.textContent = badgeLabel;
    for (const [mode, btn] of this.cameraBgSegmentBtns.entries()) {
      btn.classList.toggle('active', mode === state.cameraBgMode);
    }

    // 7. Update Undo / Redo / Skeleton states
    this.undoBtn.disabled = !state.canUndo;
    this.redoBtn.disabled = !state.canRedo;
    this.skeletonBtn.classList.toggle('active', state.showSkeleton);

    // 8. Update Camera Error Banner
    if (state.cameraError) {
      this.cameraBannerEl.classList.remove('hidden');
      this.cameraBannerMsgEl.textContent = `Camera notice: ${state.cameraError} — Pointer Studio Mode active`;
    } else {
      this.cameraBannerEl.classList.add('hidden');
    }
  }
}
