// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionOf, looksLikeText, startsWith } from './bytes';
import type { ViewerDefinition } from './types';

const SNIFF_LENGTH = 4096;

function containsAscii(head: Uint8Array, needle: string, within: number): boolean {
  const limit = Math.min(head.length, within) - needle.length;
  for (let i = 0; i <= limit; i++) {
    if (startsWith(head, needle, i)) return true;
  }
  return false;
}

export const textViewer: ViewerDefinition = {
  id: 'text',
  label: 'Text / Quellcode',
  icon: 'text',
  extensions: [
    'txt', 'log', 'md', 'markdown', 'rst', 'json', 'jsonc', 'json5', 'xml', 'xsd', 'xsl', 'csv', 'tsv',
    'ini', 'cfg', 'conf', 'properties', 'env', 'yaml', 'yml', 'toml', 'html', 'htm', 'css', 'scss', 'less',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'php', 'pl', 'lua', 'r',
    'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'fs',
    'go', 'rs', 'swift', 'dart', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql',
    'proto', 'tex', 'bib', 'diff', 'patch', 'dockerfile', 'makefile', 'cmake', 'tf', 'nc', 'gcode', 'ngc',
  ],
  load: () => import('../viewers/text'),
};

export const hexViewer: ViewerDefinition = {
  id: 'hex',
  label: 'Binärdaten (Hex)',
  icon: 'binary',
  extensions: [],
  load: () => import('../viewers/hex'),
};

export const viewers: ViewerDefinition[] = [
  {
    id: 'pdf',
    label: 'PDF-Dokument',
    icon: 'file',
    extensions: ['pdf'],
    // The spec allows junk before the header, readers accept it within the first KB.
    sniff: (head) => containsAscii(head, '%PDF-', 1024),
    load: () => import('../viewers/pdf'),
  },
  {
    id: 'image',
    label: 'Bild',
    icon: 'image',
    extensions: ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'cur', 'svg'],
    sniff: (head) =>
      startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
      startsWith(head, [0xff, 0xd8, 0xff]) ||
      startsWith(head, 'GIF87a') ||
      startsWith(head, 'GIF89a') ||
      (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8)) ||
      startsWith(head, 'ftypavif', 4) ||
      startsWith(head, 'ftypavis', 4),
    load: () => import('../viewers/image'),
  },
  {
    id: 'model3d',
    label: '3D-Modell',
    icon: 'cube',
    extensions: ['stl', 'obj', 'ply', 'glb', 'gltf', '3mf'],
    sniff: (head) => startsWith(head, 'glTF') || startsWith(head, 'ply\n') || startsWith(head, 'ply\r\n'),
    load: () => import('../viewers/model3d'),
  },
  textViewer,
  hexViewer,
];

/** Picks a viewer: file signature first, then extension, then a text/binary guess. */
export async function detectViewer(file: File): Promise<ViewerDefinition> {
  const head = new Uint8Array(await file.slice(0, SNIFF_LENGTH).arrayBuffer());
  const ext = extensionOf(file.name) || file.name.toLowerCase();
  return (
    viewers.find((v) => v.sniff?.(head)) ??
    viewers.find((v) => v.extensions.includes(ext)) ??
    (looksLikeText(head) ? textViewer : hexViewer)
  );
}
