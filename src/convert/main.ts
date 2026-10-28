// SPDX-License-Identifier: GPL-3.0-or-later
// Entry of convert.html and of the page of each conversion (jpg-to-png.html …), which names its conversion in
// <html data-convert>. Fonts are imported here rather than in CSS so the license report picks them up.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '../styles.css';
import { initTheme } from '../core/theme';
import { findPair } from './catalog';
import { ConverterPage } from './page';

initTheme();
const slug = document.documentElement.dataset.convert;
new ConverterPage(document.querySelector<HTMLElement>('#app')!, (slug && findPair(slug)) || null);
