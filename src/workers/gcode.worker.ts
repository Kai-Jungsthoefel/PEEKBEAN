// SPDX-License-Identifier: GPL-3.0-or-later
// Interprets G-code off the main thread; slicer output easily has millions of lines.
import { interpret, type GcodeResult } from '../viewers/gcode/interpret';

export type GcodeResponse = ({ ok: true } & GcodeResult) | { ok: false; error: string };

self.onmessage = (event: MessageEvent<string>) => {
  try {
    const result = interpret(event.data);
    const { positions, lines, kinds, tools, holes, holeTools, holeDoneAt, arcs } = result;
    const transfer = [positions, lines, kinds, tools, holes, holeTools, holeDoneAt, arcs].map((a) => a.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ ok: true, ...result } satisfies GcodeResponse, transfer);
  } catch (error) {
    (self as unknown as Worker).postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies GcodeResponse);
  }
};
