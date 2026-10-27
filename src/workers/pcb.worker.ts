// SPDX-License-Identifier: GPL-3.0-or-later
// Parses and plots Gerber and drill files off the main thread; the copper layers of a board can take seconds.
import { readPcbFiles, type PcbReadResult } from '../viewers/pcb/read';

export interface PcbRequest {
  files: { name: string; blob: Blob }[];
}

export type PcbResponse = ({ ok: true } & PcbReadResult) | { ok: false; error: string };

self.onmessage = async (event: MessageEvent<PcbRequest>) => {
  try {
    const files = await Promise.all(event.data.files.map(async ({ name, blob }) => ({ name, text: await blob.text() })));
    (self as unknown as Worker).postMessage({ ok: true, ...readPcbFiles(files) } satisfies PcbResponse);
  } catch (error) {
    (self as unknown as Worker).postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies PcbResponse);
  }
};
