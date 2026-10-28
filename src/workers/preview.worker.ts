// SPDX-License-Identifier: GPL-3.0-or-later
// Reads the preview pictures, properties and structure of CAD and design files off the main thread.
import { readPreview } from '../viewers/preview/read';
import type { PreviewMessage } from '../viewers/preview/types';

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  const post = (message: PreviewMessage) => self.postMessage(message);
  let reported = 0;
  try {
    const result = await readPreview(event.data.file, (fraction) => {
      // A message per percent is plenty.
      if (fraction - reported < 0.01) return;
      reported = fraction;
      post({ progress: fraction });
    });
    // The pictures are views into the whole file; copies keep the message small.
    post({ ok: true, result: { ...result, images: result.images.map((image) => ({ ...image, bytes: image.bytes.slice() })) } });
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
