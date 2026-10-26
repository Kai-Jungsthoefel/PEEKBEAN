// SPDX-License-Identifier: GPL-3.0-or-later
// Fonts are imported here rather than in CSS so the license report picks them up.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { App } from './app';
import { initTheme } from './core/theme';

initTheme();
new App(document.querySelector<HTMLElement>('#app')!);
