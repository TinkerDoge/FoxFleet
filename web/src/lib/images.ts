/** Per-image budget for the base64 data URL (about 2.5 MB), same as the Android app; the hub caps a chat body at 10 MiB. */
export const IMAGE_BUDGET = 2_500_000;
export const MAX_IMAGE_EDGE = 2048;

/** Largest size that fits `max` on the long edge, keeping the aspect ratio (never upscales). */
export function fitDimensions(w: number, h: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

export interface Encoder { (width: number, height: number, quality: number): Promise<string> }
/**
 * Re-encodes until the data URL fits the budget: quality steps down first, then the long edge shrinks by 25%.
 * `encode` draws the (already decoded) image at the given size and returns a JPEG data URL; injectable for tests.
 */
export async function shrinkToBudget(w: number, h: number, encode: Encoder, budget = IMAGE_BUDGET): Promise<{ dataUrl: string; width: number; height: number }> {
  let dim = fitDimensions(w, h);
  for (let round = 0; round < 8; round++) {
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const dataUrl = await encode(dim.width, dim.height, q);
      if (dataUrl.length <= budget) return { dataUrl, ...dim };
    }
    dim = fitDimensions(dim.width, dim.height, Math.max(64, Math.round(Math.max(dim.width, dim.height) * 0.75)));
  }
  throw new Error('That image is too large to send.');
}

/** Browser path: decode (honouring EXIF orientation), draw on a canvas, shrink to budget. */
export async function downscaleImage(file: Blob): Promise<{ dataUrl: string; width: number; height: number }> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return await shrinkToBudget(bmp.width, bmp.height, async (width, height, quality) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const g = c.getContext('2d'); if (!g) throw new Error('Canvas is not available');
      g.fillStyle = '#fff'; g.fillRect(0, 0, width, height); g.drawImage(bmp, 0, 0, width, height);
      return c.toDataURL('image/jpeg', quality);
    });
  } finally { bmp.close?.(); }
}

export const isImageFile = (f: { type: string }) => /^image\/(png|jpe?g|webp|gif|heic|heif|avif)$/i.test(f.type);
