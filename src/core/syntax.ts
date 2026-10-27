// SPDX-License-Identifier: GPL-3.0-or-later
// Syntax colors for code, shared by the text viewer (CodeMirror) and static code blocks (notebooks).
import { HighlightStyle, defaultHighlightStyle } from '@codemirror/language';

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

export const syntax = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec) =>
    typeof spec.color === 'string' && DARK_SYNTAX[spec.color] ? { ...spec, color: `light-dark(${spec.color}, ${DARK_SYNTAX[spec.color]})` } : spec,
  ),
);
