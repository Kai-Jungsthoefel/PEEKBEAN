// SPDX-License-Identifier: GPL-3.0-or-later
import { basicSetup } from 'codemirror';
import { HighlightStyle, LanguageDescription, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { formatBytes } from '../core/bytes';
import { decodeText } from '../core/text';
import { h, setPressed, toolButton } from '../core/dom';
import type { ViewerContext } from '../core/types';

// CodeMirror copes with large documents, but the browser tab's memory does not scale forever.
const MAX_BYTES = 50 * 1024 * 1024;

// CodeMirror's default syntax colors are made for a white page; each gets a counterpart for the dark theme.
const DARK_SYNTAX: Record<string, string> = {
  '#404740': '#9aa3ad', // meta
  '#708': '#c792ea', // keyword
  '#219': '#82aaff', // atom, bool, url
  '#164': '#f78c6c', // literal, number
  '#a11': '#98c379', // string
  '#e40': '#f07178', // regexp, escape
  '#00f': '#61afef', // variable definition
  '#30a': '#d7a6f5', // local variable
  '#085': '#56b6c2', // type, namespace
  '#167': '#e5c07b', // class
  '#256': '#56b6c2', // special variable, macro
  '#00c': '#61afef', // property definition
  '#940': '#7f8994', // comment
  '#f00': '#f07470', // invalid
};
const syntax = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec) =>
    typeof spec.color === 'string' && DARK_SYNTAX[spec.color] ? { ...spec, color: `light-dark(${spec.color}, ${DARK_SYNTAX[spec.color]})` } : spec,
  ),
);

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Loading text …');
  const truncated = file.size > MAX_BYTES;
  const bytes = new Uint8Array(await file.slice(0, MAX_BYTES).arrayBuffer());
  const { text, encoding } = decodeText(bytes);

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
        syntaxHighlighting(syntax),
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

  const wrapButton = toolButton('Wrap', 'Toggle line wrapping', () => {
    wrap = !wrap;
    setPressed(wrapButton, wrap);
    view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
  });
  toolbar.append(
    h('span', { class: 'meta' }, [language?.name, encoding].filter(Boolean).join(' · ')),
    wrapButton,
  );
  if (truncated) {
    container.prepend(h('div', { class: 'banner' }, `The file is very large. Only the first ${formatBytes(MAX_BYTES)} are shown.`));
  }

  return { destroy: () => view.destroy() };
}
