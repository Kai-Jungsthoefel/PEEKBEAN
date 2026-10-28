// SPDX-License-Identifier: GPL-3.0-or-later

export interface ConvertContext {
  file: File;
  /** Viewer the format detection chose for the file (core/registry.ts), e.g. "step" or "model3d". */
  viewer: string;
  /** Id of the target format in the catalog, e.g. "png". */
  target: string;
  /** Values of the converter's options, by option id. */
  options: Record<string, string>;
  /** What is happening; `fraction` (0–1) shows a determinate bar. */
  progress(message: string, fraction?: number): void;
}

export interface ConvertResult {
  files: File[];
  /** Shown below the file, e.g. which page was converted or what the DWG reader replaced. */
  notes: string[];
}

/** One module per converter in converters/, loaded when a file needs it. */
export interface ConverterModule {
  convert(ctx: ConvertContext): Promise<ConvertResult>;
}
