// SPDX-License-Identifier: GPL-3.0-or-later
// Types for libarchive-reader.js: read-only archive access with libarchive compiled to WebAssembly.
//
// Reads 7z, RAR (v4 and v5, libarchive's own decoder), tar (plain, .gz, .bz2, .xz, .lzma, .zst, .lz4, .lz, .Z),
// single compressed files (.xz, .bz2, .lzma, .zst, .lz4, .lz, .Z, .gz; format "raw"), ZIP, CAB, ISO 9660,
// CPIO, RPM, AR/deb, LHA and WARC. XAR is not available (no XML parser is compiled in).
// Encryption: only traditional ZIP encryption ("ZipCrypto") can be decrypted. AES-encrypted ZIP, encrypted 7z
// and encrypted RAR are listed (encrypted: true) but extracting them fails with code UNSUPPORTED_ENCRYPTION,
// because no cryptography library is compiled in. 7z/RAR archives with encrypted file names cannot be opened.

/** A regular file inside an archive. Directories, symbolic links and devices are not listed. */
export interface ArchiveEntry {
  /** Pass this to extract(). It is the entry's position among all headers, so the numbers can have gaps. */
  readonly index: number;
  /**
   * Path as stored in the archive, '/'-separated and not normalized (may contain '..' or a leading '/').
   * Names in a legacy charset (no UTF-8/Unicode marker, not valid UTF-8) are guessed: code page 437 for ZIP
   * and RAR, windows-1252 for everything else; `rawPath` then holds the original bytes.
   */
  readonly path: string;
  /** Only for guessed names: the stored bytes, e.g. to re-decode with `new TextDecoder('shift_jis')`. */
  readonly rawPath?: Uint8Array;
  /** Uncompressed size in bytes; null if the archive does not record it (e.g. a single .xz or .bz2 file). */
  readonly size: number | null;
  /** Modification time in seconds since 1970-01-01 UTC; null if unknown. */
  readonly mtime: number | null;
  /** Data (or metadata) is encrypted. */
  readonly encrypted: boolean;
}

export type LibarchiveErrorCode =
  /** Not an archive libarchive knows, or an empty file. */
  | 'UNRECOGNIZED'
  /** A passphrase is needed or the one given is wrong (traditional ZIP encryption). */
  | 'PASSPHRASE'
  /** The entry is encrypted with a method this build cannot decrypt (ZIP AES, 7z AES, RAR). */
  | 'UNSUPPORTED_ENCRYPTION'
  /** The archive or the entry does not fit into WebAssembly memory (at most 4 GiB in total). */
  | 'OUT_OF_MEMORY'
  /** The WebAssembly module failed hard; this reader is unusable, create a new one. */
  | 'CRASHED'
  /** Anything else: damaged data, unsupported compression method, ... The message is libarchive's. */
  | 'ERROR';

/** Every failure is thrown as this error; `message` is libarchive's archive_error_string() where available. */
export declare class LibarchiveError extends Error {
  readonly name: 'LibarchiveError';
  /** Best-effort classification of the message. */
  readonly code: LibarchiveErrorCode;
  constructor(message: string, code?: LibarchiveErrorCode, options?: ErrorOptions);
}

/**
 * An archive copied once into WebAssembly memory and listed. Extract as many entries as needed, then close().
 * Extracting in ascending index order is fastest: the decoder continues instead of starting over, which
 * matters for solid 7z/RAR archives and compressed tarballs.
 */
export interface LibarchiveArchive {
  /** libarchive's format name, e.g. "7-Zip", "RAR5", "RAR", "GNU tar format", "ZIP 2.0 (deflation)", "raw". */
  readonly format: string;
  /** Compression around the archive, outermost first, e.g. ["xz"] for .tar.xz; [] if none. */
  readonly filters: readonly string[];
  /**
   * Regular files in archive order. For format "raw" (a single compressed file) there is exactly one entry
   * named "data"; name it after the outer file yourself (e.g. "notes.txt.xz" -> "notes.txt").
   */
  readonly entries: readonly ArchiveEntry[];
  /** Set when listing stopped early (damaged or truncated archive); `entries` holds what could be read. */
  readonly warning: string | null;
  /**
   * Decompresses one entry. The result is a copy owned by JS. `passphrase` is added to the passphrases
   * libarchive tries (ZIP traditional encryption only). Throws LibarchiveError.
   */
  extract(index: number, passphrase?: string): Uint8Array;
  /** Frees the archive's WebAssembly memory. Idempotent; extract() throws afterwards. */
  close(): void;
}

export interface LibarchiveReader {
  /** Lists the regular files. Copies `data` into WebAssembly memory for this call only. */
  list(data: Uint8Array | ArrayBuffer, passphrase?: string): ArchiveEntry[];
  /** Extracts one entry. Copies and lists the archive on every call; use open() for more than one entry. */
  extract(data: Uint8Array | ArrayBuffer, index: number, passphrase?: string): Uint8Array;
  /** Copies `data` into WebAssembly memory once and lists it. Close the result when done. */
  open(data: Uint8Array | ArrayBuffer, passphrase?: string): LibarchiveArchive;
  /** Like open(), but copies a Blob/File in 16 MiB pieces, so no second full-size copy exists in JS memory. */
  openBlob(blob: Blob, passphrase?: string): Promise<LibarchiveArchive>;
}

export interface CreateReaderOptions {
  /**
   * Returns the URL of a file the module needs; it only asks for "libarchive.wasm". Without it the URL is
   * resolved relative to libarchive.js (`new URL('libarchive.wasm', import.meta.url)`, which Vite understands).
   * Example: `import wasmUrl from './libarchive.wasm?url'; createReader({ locateFile: () => wasmUrl })`.
   */
  locateFile?: (path: string, scriptDirectory: string) => string;
  /** The bytes of libarchive.wasm, to skip fetching it (e.g. in Node: `fs.readFileSync(...)`). */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** An already compiled libarchive.wasm, e.g. shared between workers; skips fetching and compiling. */
  wasmModule?: WebAssembly.Module;
}

/**
 * Loads libarchive.wasm and returns a synchronous reader. Each reader has its own WebAssembly memory, which
 * grows as needed (up to 4 GiB) and never shrinks; drop the reader to release it. Use it in a worker for big
 * archives, since list/extract block the calling thread.
 */
export declare function createReader(options?: CreateReaderOptions): Promise<LibarchiveReader>;
