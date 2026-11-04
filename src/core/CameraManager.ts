export class CameraManager {
  private readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private lastVideoTime = -1;

  constructor(videoElement: HTMLVideoElement) {
    this.video = videoElement;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  /**
   * Requests webcam stream at balanced HD/VGA resolution (30fps)
   * with automatic constraint fallback for mobile & desktop compatibility.
   */
  public async start(): Promise<void> {
    this.stop();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        'Camera API (navigator.mediaDevices.getUserMedia) is unavailable in this browser context.'
      );
    }

    const constraintProfiles: MediaStreamConstraints[] = [
      {
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 60 },
        },
      },
      {
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
      },
      {
        audio: false,
        video: true,
      },
    ];

    let lastError: unknown = null;
    for (const constraints of constraintProfiles) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!this.stream) {
      const msg =
        lastError instanceof Error
          ? lastError.message
          : 'Unable to access webcam stream.';
      throw new Error(msg);
    }

    this.video.srcObject = this.stream;

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        this.video
          .play()
          .then(() => resolve())
          .catch((err) => reject(err));
      };
      const onError = () => {
        cleanup();
        reject(new Error('Failed to load video stream metadata.'));
      };
      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };

      if (this.video.readyState >= 1) {
        onLoaded();
      } else {
        this.video.addEventListener('loadedmetadata', onLoaded);
        this.video.addEventListener('error', onError);
      }
    });
  }

  /**
   * Returns true only when a new video frame has been decoded since the last check.
   */
  public consumeNewFrame(): boolean {
    if (
      this.video.readyState < 2 ||
      this.video.paused ||
      this.video.videoWidth === 0
    ) {
      return false;
    }

    const currentTime = this.video.currentTime;
    if (currentTime === this.lastVideoTime) {
      return false;
    }

    this.lastVideoTime = currentTime;
    return true;
  }

  public getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  public isReady(): boolean {
    return (
      this.stream !== null &&
      this.video.readyState >= 2 &&
      this.video.videoWidth > 0
    );
  }

  public stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    this.video.srcObject = null;
    this.lastVideoTime = -1;
  }
}
