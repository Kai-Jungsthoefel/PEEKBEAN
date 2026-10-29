// SPDX-License-Identifier: GPL-3.0-or-later
// Splits a large STEP file off the main thread (see step-split.ts). The parts come back as Blobs, which the browser
// may keep on disk until they are read.
import { splitStep } from './step-split';

export interface StepSplitRequest {
  file: Blob;
  partBytes: number;
}

export type StepSplitResponse =
  | { ok: true; parts: Blob[] }
  /** The file cannot be split (too few solids). */
  | { ok: true; parts: null }
  | { ok: false; error: string };

self.onmessage = async (event: MessageEvent<StepSplitRequest>) => {
  const post = (response: StepSplitResponse) => (self as unknown as Worker).postMessage(response);
  try {
    const split = splitStep(new Uint8Array(await event.data.file.arrayBuffer()), event.data.partBytes);
    post({ ok: true, parts: split ? [...split.parts].map((part) => new Blob([part])) : null });
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
