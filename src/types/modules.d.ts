// SPDX-License-Identifier: GPL-3.0-or-later
// Type declarations for dependencies that ship none.

declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  // Emscripten module factory with the wasm binary embedded; the decoder API is loosely typed.
  const factory: () => Promise<any>;
  export default factory;
}

declare module 'dxf-viewer/src/DxfScene.js' {
  // Internal scene builder of dxf-viewer; only patched (see workers/hatch-limit.ts), never called directly.
  export class DxfScene {
    Build(dxf: unknown, fontFetchers: unknown): Promise<void>;
  }
}

declare module 'opentype.js' {
  const opentype: {
    parse(buffer: ArrayBuffer): { names?: Record<string, Record<string, string>>; numGlyphs: number };
  };
  export default opentype;
}

declare module 'sql.js' {
  interface Statement {
    getColumnNames(): string[];
    step(): boolean;
    get(): unknown[];
    free(): boolean;
  }
  interface Database {
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    prepare(sql: string): Statement;
    close(): void;
  }
  interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}

declare module 'occt-import-js' {
  interface OcctResult {
    success: boolean;
    root: { name: string; meshes: number[]; children: OcctResult['root'][] };
    meshes: {
      name: string;
      color?: [number, number, number];
      brep_faces: { first: number; last: number; color: [number, number, number] | null }[];
      attributes: { position: { array: number[] }; normal?: { array: number[] } };
      index: { array: number[] };
    }[];
  }
  interface Occt {
    ReadFile(format: 'step' | 'iges' | 'brep', content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
  }
  export default function occtimportjs(overrides?: { locateFile?: (path: string) => string }): Promise<Occt>;
}

declare module 'exifr/src/core.mjs' {
  // exifr's core from its sources (see metadata/exif.ts); readers and parsers register themselves on import.
  export function parse(input: Blob | ArrayBuffer | Uint8Array, options?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
}

declare module 'exifr/src/*';
