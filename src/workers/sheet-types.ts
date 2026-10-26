// SPDX-License-Identifier: GPL-3.0-or-later
import type { GridCell, Merge } from '../viewers/grid';

export interface SheetRequest {
  buffer: ArrayBuffer;
  /** Plain text formats are decoded first so legacy encodings survive. */
  csv: boolean;
  /** Read formatting too (xlsx/xlsm via ExcelJS). */
  styled: boolean;
}

export interface SheetData {
  name: string;
  rows: GridCell[][];
  columnCount: number;
  columnWidths: number[];
  /** Index of the first row in the sheet (0 = Excel row 1). */
  firstRow: number;
  rowHeights?: number[];
  styles?: string[];
  merges?: Merge[];
  gridlines?: boolean;
  baseStyle?: string;
}

export type SheetResponse = { ok: true; sheets: SheetData[]; formatted: boolean } | { ok: false; error: string };
