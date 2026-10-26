// SPDX-License-Identifier: GPL-3.0-or-later
import type { IconName } from './icons';

export interface ViewerContext {
  file: File;
  /** Area the viewer renders into; it fills the space below the toolbar. */
  container: HTMLElement;
  /** Slot in the file toolbar for viewer-specific controls (zoom, page, ...). */
  toolbar: HTMLElement;
}

export interface Viewer {
  destroy(): void;
}

export interface ViewerModule {
  mount(ctx: ViewerContext): Promise<Viewer>;
}

export interface ViewerDefinition {
  id: string;
  /** Human-readable kind of file, e.g. "PDF-Dokument". */
  label: string;
  icon: IconName;
  extensions: string[];
  /** Recognizes the format from the first bytes of the file. Only for unambiguous signatures. */
  sniff?: (head: Uint8Array) => boolean;
  load: () => Promise<ViewerModule>;
}
