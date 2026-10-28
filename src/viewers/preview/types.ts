// SPDX-License-Identifier: GPL-3.0-or-later
// What the preview readers hand to the viewer: the pictures a file carries, its properties and its structure.
import type { MetaSection } from '../../metadata/model';

export interface PreviewImage {
  /** "Preview", a configuration or page name. */
  label: string;
  /** image/png, image/jpeg, image/bmp; image/wmf and image/emf are drawn on the main thread. */
  type: string;
  bytes: Uint8Array;
}

export interface PreviewNode {
  name: string;
  /** Shown after the name, dimmed (a file path, a type, a count). */
  detail?: string;
  children?: PreviewNode[];
  /** Suppressed or hidden components. */
  muted?: boolean;
}

export interface PreviewList {
  title: string;
  nodes: PreviewNode[];
  /** Total count when the list was cut short. */
  total?: number;
}

/** Pictures a file contains besides its preview (textures packed into a Blender file), shown as tiles. */
export interface PreviewGallery {
  title: string;
  items: { label: string; detail?: string; image?: PreviewImage }[];
}

export interface PreviewResult {
  /** Kind of document, e.g. "SolidWorks part". */
  kind: string;
  images: PreviewImage[];
  /** What OPSIS cannot show of this file, and how to get a full view. */
  limits: string;
  sections: MetaSection[];
  lists: PreviewList[];
  galleries?: PreviewGallery[];
}

export type PreviewResponse = { ok: true; result: PreviewResult } | { ok: false; error: string };

/** Worker messages: progress while reading, then the result. */
export type PreviewMessage = PreviewResponse | { progress: number };
