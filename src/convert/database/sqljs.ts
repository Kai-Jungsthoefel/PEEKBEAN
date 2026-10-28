// SPDX-License-Identifier: GPL-3.0-or-later
// sql.js (MIT) for the database converter, loaded once per worker. The declaration in types/modules.d.ts covers what
// the viewer uses; reading with big integers, binding and exporting are described here.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

export interface SqlStatement {
  getColumnNames(): string[];
  step(): boolean;
  /** The current row; with useBigInt, integers come as BigInt, so none beyond 2^53 lose digits. */
  get(params?: null, config?: { useBigInt?: boolean }): unknown[];
  /** Binds the values, runs the statement and resets it. */
  run(values: unknown[]): void;
  free(): boolean;
}

export interface SqlDatabase {
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  run(sql: string): void;
  prepare(sql: string): SqlStatement;
  export(): Uint8Array;
  close(): void;
}

let loading: Promise<{ Database: new (data?: Uint8Array) => SqlDatabase }> | null = null;

export function loadSqlJs() {
  loading ??= initSqlJs({ locateFile: () => wasmUrl }) as unknown as Promise<{ Database: new (data?: Uint8Array) => SqlDatabase }>;
  return loading;
}

export const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
