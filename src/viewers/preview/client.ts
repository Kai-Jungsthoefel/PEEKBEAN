// SPDX-License-Identifier: GPL-3.0-or-later
// Main-thread side of the preview readers: runs them in a worker, once per file for the viewer and the info panel.
import type { PreviewMessage, PreviewResult } from './types';

const cache = new WeakMap<File, Promise<PreviewResult>>();

function run(file: File, progress?: (fraction: number) => void): Promise<PreviewResult> {
  const worker = new Worker(new URL('../../workers/preview.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<PreviewResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<PreviewMessage>) => {
      const message = event.data;
      if ('progress' in message) progress?.(message.progress);
      else if (message.ok) resolve(message.result);
      else reject(new Error(message.error));
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The preview reader could not be loaded.'));
    worker.postMessage({ file });
  }).finally(() => worker.terminate());
}

export function readPreviewInWorker(file: File, progress?: (fraction: number) => void): Promise<PreviewResult> {
  let pending = cache.get(file);
  if (!pending) {
    pending = run(file, progress);
    cache.set(file, pending);
    pending.catch(() => cache.delete(file));
  }
  return pending;
}
