/**
 * Screen-change detection.
 *
 * Running a model on every frame is the easiest way to lose the resource metric.
 * Most agent steps look at a screen that is identical to the last one, or differs
 * only where the agent just typed, so the cheapest useful optimisation is to not
 * run the model at all.
 *
 * The comparison is deliberately crude: downscale to 48×48 greyscale — about
 * 2,300 bytes — and take the mean absolute difference. That costs well under a
 * millisecond and is insensitive to antialiasing and cursor blink, while still
 * catching any real layout change.
 */

export interface ChangeResult {
  changed: boolean;
  /** Mean absolute difference per pixel, 0–255. Reported in the UI. */
  diff: number;
  /** True when there was nothing to compare against. */
  first: boolean;
}

const GRID = 48;

/** Below this mean difference the screen is treated as unchanged. */
const DEFAULT_THRESHOLD = 2;

export class ChangeDetector {
  private previous: Float32Array | null = null;
  private previousKey = '';
  private readonly canvas: HTMLCanvasElement;

  constructor(private readonly threshold = DEFAULT_THRESHOLD) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = GRID;
    this.canvas.height = GRID;
  }

  /**
   * `key` scopes the comparison, so scrolling or navigating always counts as a
   * change even if the pixels happen to be similar. Pass URL + scroll position.
   */
  check(source: CanvasImageSource, key: string): ChangeResult {
    const signature = this.signature(source);

    if (this.previous === null || key !== this.previousKey) {
      this.previous = signature;
      this.previousKey = key;
      return { changed: true, diff: 255, first: true };
    }

    let total = 0;
    for (let i = 0; i < signature.length; i++) {
      total += Math.abs(signature[i]! - this.previous[i]!);
    }
    const diff = total / signature.length;

    this.previous = signature;
    this.previousKey = key;
    return { changed: diff >= this.threshold, diff: Math.round(diff * 100) / 100, first: false };
  }

  private signature(source: CanvasImageSource): Float32Array {
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable for change detection');

    ctx.clearRect(0, 0, GRID, GRID);
    ctx.drawImage(source, 0, 0, GRID, GRID);
    const { data } = ctx.getImageData(0, 0, GRID, GRID);

    const out = new Float32Array(GRID * GRID);
    for (let i = 0; i < out.length; i++) {
      const o = i * 4;
      // Rec. 601 luma. Colour is not what tells us the screen changed.
      out[i] = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
    }
    return out;
  }

  reset(): void {
    this.previous = null;
    this.previousKey = '';
  }
}
