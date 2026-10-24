export const MAX_IMAGE_SIDE = 512;

// Midpoints of N equal slices, so neither the often-black first frame nor the end of the clip is sampled.
export function frameTimes(duration: number, count: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || count < 1) return [];
  const step = duration / count;
  return Array.from({ length: count }, (_, i) => Math.round((i + 0.5) * step * 1000) / 1000);
}

export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function drawJpeg(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const size = fitWithin(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d")!.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode frame"))), "image/jpeg", 0.85),
  );
}

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true });
    target.addEventListener("error", () => reject(new Error("Could not decode video")), { once: true });
  });
}

export async function extractFrames(video: Blob, count: number): Promise<Blob[]> {
  const url = URL.createObjectURL(video);
  const el = document.createElement("video");
  el.muted = true;
  el.preload = "auto";
  try {
    const loaded = once(el, "loadeddata");
    el.src = url;
    await loaded;
    const frames: Blob[] = [];
    for (const t of frameTimes(el.duration, count)) {
      const seeked = once(el, "seeked");
      el.currentTime = t;
      await seeked;
      frames.push(await canvasBlob(drawJpeg(el, el.videoWidth, el.videoHeight)));
    }
    if (frames.length === 0) throw new Error("Video has no duration");
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Vision models take at most a few hundred pixels per side, so shrinking first keeps the request small.
export async function toJpegDataUrl(image: Blob): Promise<string> {
  const bitmap = await createImageBitmap(image);
  try {
    return drawJpeg(bitmap, bitmap.width, bitmap.height).toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}

export function base64ToBlob(b64: string, type = "image/png"): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
