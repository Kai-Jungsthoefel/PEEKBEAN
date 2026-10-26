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
  drawing: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9.5" cy="12" r="3"/><path d="M14 8.5h3.5M14 12h3.5M14 15.5h3.5M9.5 7.5v1.5m0 6v1.5"/>',
  cad: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9Z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/><circle cx="12" cy="12" r="2.2"/>',
  doc: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v4h4"/><path d="M8.5 11.5l1.2 5 1.8-4 1.8 4 1.2-5"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M15 9.5v10"/>',
  slides: '<rect x="3.5" y="4.5" width="17" height="12" rx="1.5"/><path d="M12 16.5V20m-3.5 0h7"/><path d="M7.5 12.5l3-3 2.5 2 3.5-3.5"/>',
  archive: '<rect x="4" y="3.5" width="16" height="17" rx="1.5"/><path d="M11 3.5v2h2v2h-2v2h2v2h-2"/><rect x="10" y="13" width="4" height="4" rx="1"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M4 7l8 6 8-6"/>',
  media: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M10 9.5v5l4.5-2.5Z" fill="currentColor"/>',
  font: '<path d="M5 19L10 5h1l5 14M7 14.5h7"/><path d="M16.5 12.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm2.5 0v5"/>',
  markdown: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M6.5 15V9l2.5 3 2.5-3v6M15.5 9v5.5m-2-2 2 2 2-2"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.3 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.3-3.5-8.5s1-6 3.5-8.5Z"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  folder: '<path d="M3.5 18.5v-12a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5Z"/><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>',
  paperclip: '<path d="M8.5 12.5l6-6a3 3 0 0 1 4.2 4.2l-7.6 7.6a4.5 4.5 0 0 1-6.4-6.4l7-7"/>',
  download: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.8v.1"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5L11 13M17.5 14v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5"/>',
  alert: '<path d="M12 4l9 16H3Z"/><path d="M12 10v4.5m0 2.5v.1"/>',
  // From SOMA (github.com/Kai-Jungsthoefel/SOMA, GPL-3.0), for the 3D viewer controls.
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  chevUp: '<path d="m6 15 6-6 6 6"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  tree: '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="13" y="10.5" width="8" height="4.5" rx="1"/><rect x="13" y="17" width="8" height="4.5" rx="1"/><path d="M6.5 8v11.2H13M6.5 12.7H13"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>',
  ghost: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" fill-opacity=".45"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  axes: '<path d="M6 18V4M6 18h14M6 18l7.5-7.5"/><path d="m3.5 6.5 2.5-2.5 2.5 2.5M17.5 15.5l2.5 2.5-2.5 2.5"/><circle cx="6" cy="18" r="1.4" fill="currentColor"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  target: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16, stroke = 1.7): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML =
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}
