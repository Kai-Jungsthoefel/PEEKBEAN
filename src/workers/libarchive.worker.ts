// SPDX-License-Identifier: GPL-3.0-or-later
// 7z, RAR, tar.bz2/xz/zst, CAB, ISO … with our own libarchive build (BSD-2-Clause, no OpenSSL), see
// scripts/build-libarchive-wasm.mjs. The archive stays open in this worker; the viewer asks for entries by index.
import { createReader, type LibarchiveArchive } from '../wasm/libarchive/libarchive-reader.js';
import wasmUrl from '../wasm/libarchive/libarchive.wasm?url';

export type LibarchiveRequest = { kind: 'open'; file: Blob } | { kind: 'extract'; index: number; passphrase?: string };

export type LibarchiveResponse =
  | { ok: true; kind: 'open'; format: string; filters: string[]; warning: string | null; entries: { index: number; path: string; size: number | null; mtime: number | null; encrypted: boolean }[] }
  | { ok: true; kind: 'extract'; data: Uint8Array }
  | { ok: false; code: string; error: string };

let archive: LibarchiveArchive | null = null;

const post = (response: LibarchiveResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);

self.onmessage = async (event: MessageEvent<LibarchiveRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'open') {
      const reader = await createReader({ locateFile: () => wasmUrl });
      archive = await reader.openBlob(request.file);
      post({ ok: true, kind: 'open', format: archive.format, filters: [...archive.filters], warning: archive.warning, entries: archive.entries.map((e) => ({ ...e, rawPath: undefined })) });
    } else {
      if (!archive) throw new Error('The archive is not open.');
      const data = archive.extract(request.index, request.passphrase);
      post({ ok: true, kind: 'extract', data }, [data.buffer]);
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'ERROR';
    post({ ok: false, code, error: error instanceof Error ? error.message : String(error) });
  }
};
