/**
 * Extract basic video metadata locally using the native HTMLVideoElement —
 * no ffmpeg.wasm dependency (keeps the bundle small and avoids WASM/COOP
 * headaches). Reports duration and resolution reliably; FPS is estimated via
 * `requestVideoFrameCallback` when the browser supports it.
 */
export type VideoMeta = {
  duration: number;
  width: number;
  height: number;
  fps?: number;
};

export function extractVideoMeta(url: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = url;

    const onError = () => reject(new Error('Could not read video metadata'));
    video.onerror = onError;

    video.onloadedmetadata = () => {
      const base: VideoMeta = {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      };

      const rvfc = (video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
      }).requestVideoFrameCallback;

      if (typeof rvfc !== 'function') {
        resolve(base);
        return;
      }

      // Estimate FPS by sampling a few frame callbacks during a short play burst.
      let frames = 0;
      let firstMediaTime = -1;
      let lastMediaTime = 0;
      const sampleTarget = 10;

      const step = (_now: number, meta: { mediaTime: number }) => {
        if (firstMediaTime < 0) firstMediaTime = meta.mediaTime;
        lastMediaTime = meta.mediaTime;
        frames++;
        if (frames < sampleTarget) {
          rvfc.call(video, step);
        } else {
          video.pause();
          const span = lastMediaTime - firstMediaTime;
          const fps = span > 0 ? Math.round((frames - 1) / span) : undefined;
          resolve({ ...base, fps: fps && fps > 0 && fps < 1000 ? fps : undefined });
        }
      };

      rvfc.call(video, step);
      // Best-effort: muted playback to drive frame callbacks.
      void video.play().catch(() => resolve(base));
      // Safety timeout so we never hang.
      window.setTimeout(() => {
        video.pause();
        resolve(base);
      }, 2000);
    };
  });
}

export function formatMeta(meta: VideoMeta): string {
  const parts = [`${meta.width}×${meta.height}`, `${meta.duration.toFixed(1)}s`];
  if (meta.fps) parts.push(`~${meta.fps} fps`);
  return parts.join(' · ');
}
