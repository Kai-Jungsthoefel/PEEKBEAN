// SPDX-License-Identifier: GPL-3.0-or-later
// Color theme: follows the system unless the user picks Light or Dark. The choice is kept in this browser only.
// The colors themselves are CSS tokens written with light-dark(); this module only sets the color scheme.

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'ev-theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readStored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    // Storage can be blocked (private windows, strict settings); then the system setting applies.
    return 'system';
  }
}

let preference = readStored();

function apply(): void {
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
  for (const listener of listeners) listener();
}

systemDark.addEventListener('change', () => {
  if (preference === 'system') apply();
});

/** Sets the color scheme on the page; call once before the first render. */
export function initTheme(): void {
  apply();
}

export function themePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(value: ThemePreference): void {
  preference = value;
  try {
    if (value === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Not stored; the choice still holds until the page is closed.
  }
  apply();
}

/** Calls `listener` after every theme change; returns the function that unsubscribes it. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Resolves a color token to an rgb() string as it renders inside `element`. Reading the custom property directly would
 * return the unresolved light-dark() expression, which canvas and WebGL code cannot use.
 */
export function tokenColor(element: Element, name: string): string {
  const probe = document.createElement('span');
  probe.hidden = true;
  probe.style.color = `var(${name})`;
  element.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
