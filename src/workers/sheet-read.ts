// SPDX-License-Identifier: GPL-3.0-or-later
// Reading a workbook with SheetJS (Apache-2.0), shared by the spreadsheet viewer's worker and the converter's.
import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full';

// Legacy .xls and DBF files store text in Windows code pages.
XLSX.set_cptable(cptable);

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** CSV and TSV files (`text`) are read as UTF-8, or as Windows-1252 when they are not valid UTF-8. */
export function readWorkbook(buffer: ArrayBuffer, text: boolean, options: XLSX.ParsingOptions): XLSX.WorkBook {
  return text
    ? XLSX.read(decodeText(new Uint8Array(buffer)), { ...options, type: 'string', raw: false })
    : XLSX.read(new Uint8Array(buffer), { ...options, type: 'array' });
}
