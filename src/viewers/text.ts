// SPDX-License-Identifier: GPL-3.0-or-later
import { basicSetup } from 'codemirror';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { formatBytes, startsWith } from '../core/bytes';
import { h, setPressed, toolButton } from '../core/dom';
import type { ViewerContext } from '../core/types';

// CodeMirror copes with large documents, but the browser tab's memory does not scale forever.
const MAX_BYTES = 50 * 1024 * 1024;

function decode(bytes: Uint8Array): { text: string; encoding: string } {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8 (BOM)' };
  if (startsWith(bytes, [0xff, 0xfe])) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16 LE' };
  if (startsWith(bytes, [0xfe, 0xff])) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16 BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    // Most non-UTF-8 text found in the wild here is legacy Windows text.
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' };
  }
}

export async function mount({ file, container, toolbar }: ViewerContext) {
  const truncated = file.size > MAX_BYTES;
  const bytes = new Uint8Array(await file.slice(0, MAX_BYTES).arrayBuffer());
  const { text, encoding } = decode(bytes);

  const language = LanguageDescription.matchFilename(languages, file.name);
  const languageSupport: Extension = language ? await language.load() : [];
  const wrapping = new Compartment();
  let wrap = false;

  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        EditorState.readOnly.of(true),
        languageSupport,
        wrapping.of([]),
        EditorView.theme({
          '&': { height: '100%', fontSize: '12.5px' },
          '.cm-scroller': { fontFamily: 'var(--mono)' },
          '.cm-gutters': { background: 'var(--s1)', color: 'var(--tx3)', borderRight: '1px solid var(--line)' },
          '.cm-activeLine, .cm-activeLineGutter': { background: 'var(--acc-tint)' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'rgba(242,154,56,.28) !important' },
        }),
      ],
    }),
  });
  container.classList.add('text-viewer');

  const wrapButton = toolButton('Umbruch', 'Zeilenumbruch umschalten', () => {
    wrap = !wrap;
    setPressed(wrapButton, wrap);
    view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
  });
  toolbar.append(
    h('span', { class: 'meta' }, [language?.name, encoding].filter(Boolean).join(' · ')),
    wrapButton,
  );
  if (truncated) {
    container.prepend(h('div', { class: 'banner' }, `Die Datei ist sehr groß. Angezeigt werden nur die ersten ${formatBytes(MAX_BYTES)}.`));
  }

  return { destroy: () => view.destroy() };
}
