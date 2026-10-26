// SPDX-License-Identifier: GPL-3.0-or-later

// Line icons on a 24-unit grid, drawn for this project.
const PATHS = {
  logo: '<path d="M2.5 12S6.5 5 12 5s9.5 7 9.5 7-4 7-9.5 7-9.5-7-9.5-7Z"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  open: '<path d="M3 19V6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v2"/><path d="M3 19l2.6-8.2a1 1 0 0 1 1-.8H21l-2.7 8.3a1 1 0 0 1-1 .7Z"/>',
  drop: '<path d="M12 3v11m-4.5-4.5L12 14l4.5-4.5"/><path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  shield: '<path d="M12 3l7 2.8V11c0 4.6-3 8-7 10-4-2-7-5.4-7-10V5.8Z"/><path d="M9 12l2 2 4-4"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5m7-9L20 12l-4.5 4.5"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
  file: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v4h4"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9Z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  text: '<path d="M6 3h8l4 4v14H6Z"/><path d="M9 11h6m-6 3.5h6m-6 3.5h3.5"/>',
  binary: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8.5 9v6m3.5-6h2.5v6H12Z"/>',
  alert: '<path d="M12 4l9 16H3Z"/><path d="M12 10v4.5m0 2.5v.1"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16, stroke = 1.7): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML =
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}
