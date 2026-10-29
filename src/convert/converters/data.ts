// SPDX-License-Identifier: GPL-3.0-or-later
// Structured data between JSON, JSON Lines and YAML; JSON with comments (JSONC, JSON5) becomes plain JSON. YAML is
// read and written by the yaml package (ISC). The text's encoding is detected as in the text viewer.
import { extensionOf } from '../../core/bytes';
import { readText } from '../../core/text';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

const MIME: Record<string, string> = { json: 'application/json', jsonl: 'application/jsonl', yaml: 'application/yaml' };

/** The values of the file: one, or several for YAML files with more than one document. JSON Lines give an array. */
async function read(text: string, extension: string): Promise<{ values: unknown[]; notes: string[] }> {
  if (extension === 'jsonl' || extension === 'ndjson') {
    const values = text.split(/\r?\n/).flatMap((line, i) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        throw new Error(`Line ${i + 1} is no valid JSON.`);
      }
    });
    return { values: [values], notes: [] };
  }
  if (extension === 'yaml' || extension === 'yml') {
    const { parseAllDocuments } = await import('yaml');
    // Merge keys ("<<: *defaults") are common in configuration files, though only YAML 1.1 has them.
    const documents = parseAllDocuments(text, { merge: true });
    if (!Array.isArray(documents)) throw new Error('The file is empty.');
    const errors = documents.flatMap((d) => d.errors);
    if (errors.length > 0) throw new Error(`The YAML is not valid: ${errors[0].message.split('\n')[0]}`);
    const notes = /(^|\s)(#|&\w|!\w)/.test(text) ? ['Comments, anchors and tags of the YAML are not kept; anchors are written out where they are used.'] : [];
    return { values: documents.map((d) => d.toJS({ maxAliasCount: 10_000 }) as unknown), notes };
  }
  try {
    return { values: [JSON.parse(text)], notes: [] };
  } catch (error) {
    // JSONC and JSON5: comments and trailing commas removed; what JSON5 allows beyond that (single quotes, names
    // without quotes) YAML reads as well.
    const stripped = withoutComments(text);
    try {
      return { values: [JSON.parse(stripped)], notes: commentNote(text, stripped) };
    } catch {
      const { parse } = await import('yaml');
      try {
        return { values: [parse(stripped) as unknown], notes: commentNote(text, stripped) };
      } catch {
        throw new Error(`The JSON is not valid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

const commentNote = (text: string, stripped: string) => (text === stripped ? [] : ['Comments are left out; JSON has none.']);

/** JSON with its comments and trailing commas removed, strings left as they are. */
function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[\]}])/g, '$1');
}

export async function convert({ file, target, options, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading data …');
  const { text } = await readText(file);
  const { values, notes } = await read(text, extensionOf(file.name));
  if (values.length === 0) throw new Error('The file contains no data.');
  progress('Writing …');
  let output: string;
  if (target === 'yaml') {
    const { stringify } = await import('yaml');
    output = values.map((value) => stringify(value, { lineWidth: 0 })).join('---\n');
  } else if (target === 'jsonl') {
    // An array gives a line per element, YAML documents a line each; anything else is one line.
    const lines = values.length === 1 && Array.isArray(values[0]) ? (values[0] as unknown[]) : values;
    output = lines.map((value) => JSON.stringify(value)).join('\n') + '\n';
  } else {
    const value = values.length === 1 ? values[0] : values;
    if (values.length > 1) notes.push(`The ${values.length} YAML documents become one array.`);
    output = options.layout === 'minified' ? JSON.stringify(value) : `${JSON.stringify(value, null, 2)}\n`;
  }
  return { files: [new File([output], resultName(file.name, target), { type: MIME[target] })], notes };
}
