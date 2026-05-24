declare const GEMINI_API_KEY: string;

interface CanvasRenderingContext2D {
  roundRect(x: number, y: number, w: number, h: number, radii?: number | number[]): void;
}