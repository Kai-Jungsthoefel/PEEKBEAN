// SPDX-License-Identifier: GPL-3.0-or-later
// Writing pictures with the browser's own encoders: PNG and JPEG everywhere, WebP in Chrome, Edge and Firefox.

const TYPES: Record<string, { type: string; label: string }> = {
  png: { type: 'image/png', label: 'PNG' },
  jpg: { type: 'image/jpeg', label: 'JPG' },
  webp: { type: 'image/webp', label: 'WebP' },
};

/** A canvas to draw on; JPEG has no transparency, so its canvas starts white like a page. */
export function canvasFor(width: number, height: number, target: string): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw the picture.');
  if (target === 'jpg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  return { canvas, context };
}

export async function encodeCanvas(canvas: HTMLCanvasElement, target: string, quality: string | undefined, name: string): Promise<File> {
  const { type, label } = TYPES[target];
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality === undefined ? undefined : Number(quality)));
  // Frees the pixels right away instead of when the canvas is collected; matters for many large pages.
  canvas.width = 0;
  if (!blob) throw new Error('The picture is too large for this browser to convert.');
  // A browser without an encoder for the type hands out PNG instead (Safari and WebP).
  if (blob.type !== type) throw new Error(`This browser cannot write ${label} files. Chrome, Edge and Firefox can.`);
  return new File([blob], name, { type });
}
