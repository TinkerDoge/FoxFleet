import { describe, expect, it } from 'vitest';
import { fitDimensions, IMAGE_BUDGET, shrinkToBudget } from '../src/lib/images';

describe('image downscaler', () => {
  it('fits the long edge and never upscales', () => {
    expect(fitDimensions(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitDimensions(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(fitDimensions(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitDimensions(1, 5000, 2048).width).toBe(1);
  });
  it('keeps the first encode when it fits', async () => {
    const calls: number[][] = [];
    const r = await shrinkToBudget(1000, 500, async (w, h, q) => { calls.push([w, h, q]); return 'x'.repeat(1000); });
    expect(calls).toEqual([[1000, 500, 0.85]]); expect(r.dataUrl.length).toBe(1000);
  });
  it('lowers quality, then size, until under budget', async () => {
    // size grows with pixels and quality; budget is only met after both drop
    const enc = async (w: number, h: number, q: number) => 'x'.repeat(Math.round(w * h * q * 6));
    const r = await shrinkToBudget(6000, 4000, enc);
    expect(r.dataUrl.length).toBeLessThanOrEqual(IMAGE_BUDGET); expect(Math.max(r.width, r.height)).toBeLessThan(2048);
    expect(r.width / r.height).toBeCloseTo(1.5, 1);
  });
  it('gives up with a clear error when nothing fits', async () => {
    await expect(shrinkToBudget(100, 100, async () => 'x'.repeat(IMAGE_BUDGET + 1))).rejects.toThrow(/too large/);
  });
});
