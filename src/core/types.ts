// SPDX-License-Identifier: GPL-3.0-or-later
import type { IconName } from './icons';

export interface ViewerContext {
  file: File;
  /** Area the viewer renders into; it fills the space below the toolbar. */
  container: HTMLElement;
  /** Slot in the file toolbar for viewer-specific controls (zoom, page, ...). */
  toolbar: HTMLElement;
  /** Opens another file in a new tab, e.g. an archive entry or an e-mail attachment. */
  openFile(file: File): void;
  /** Tells the loading screen what is happening; `fraction` (0–1) shows a determinate bar. No effect after mount. */
  progress(message: string, fraction?: number): void;
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
  /**
   * The signature is shared with more specific formats (a ZIP signature also matches DOCX and 3MF),
   * so a matching extension of another viewer wins over it.
   */
  container?: boolean;
  load: () => Promise<ViewerModule>;
}
