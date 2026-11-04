import './styles/main.css';
import { AppController } from './core/AppController';

declare global {
  interface Window {
    __AIR_DRAWING_APP__?: AppController;
  }
}

function bootstrap(): void {
  const videoEl = document.getElementById(
    'camera-video'
  ) as HTMLVideoElement | null;
  const drawingCanvas = document.getElementById(
    'drawing-canvas'
  ) as HTMLCanvasElement | null;
  const hudCanvas = document.getElementById(
    'hud-canvas'
  ) as HTMLCanvasElement | null;
  const uiLayer = document.getElementById('ui-layer') as HTMLElement | null;

  if (!videoEl || !drawingCanvas || !hudCanvas || !uiLayer) {
    throw new Error('Required AirDraw DOM elements are missing.');
  }

  const app = new AppController(videoEl, drawingCanvas, hudCanvas, uiLayer);
  window.__AIR_DRAWING_APP__ = app;
  void app.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
