/* tslint:disable */
/* eslint-disable */

/** Result of {@link dwg_convert}. */
export interface DwgConversion {
    /** Model space as ASCII DXF, UTF-8 encoded (DXF R2007 or later). */
    dxf: Uint8Array;
    /** Version code from the DWG header, e.g. "AC1032". */
    version: string;
    /** AutoCAD release, e.g. "R2018". */
    release: string;
    /** Entities read from the file (model space, paper space and block definitions). */
    entities: number;
    /** Layers in the layer table. */
    layers: number;
    /** Short German notes for the user, grouped by kind with counts; empty for an intact, ordinary drawing. */
    warnings: string[];
    /** The raw (English) reader and writer messages behind the warnings, at most 50, for showing on demand. */
    details: string[];
    /** True only if drawing data could not be read; undecodable non-graphical objects do not count. */
    recovered: boolean;
    /** Paper-space layout names in tab order (without "Model"); see {@link DwgDrawing.layoutDxf} and {@link dwg_layout_to_dxf}. */
    layouts: string[];
}



/**
 * A DWG read once, from which model space and each layout can be converted to DXF on demand. Holds the drawing in
 * WebAssembly memory until `free()` is called.
 */
export class DwgDrawing {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A paper-space layout as ASCII DXF: its paper-space entities in model space and what its viewports show
     * (model space scaled, rotated and moved onto the sheet; not clipped at the viewport border).
     */
    layoutDxf(index: number): Uint8Array;
    /**
     * Paper-space layout names in tab order (without "Model").
     */
    layouts(): string[];
    /**
     * Model space as ASCII DXF.
     */
    modelDxf(): Uint8Array;
    /**
     * Reads a DWG file. Throws an `Error` with a readable message if it cannot be read. With `full`,
     * `modelDxf()` keeps everything acadrust can write.
     */
    static open(bytes: Uint8Array, full?: boolean | null): DwgDrawing;
    /**
     * Raw (English) messages behind the warnings, at most 50.
     */
    readonly details: string[];
    /**
     * Entities read from the file.
     */
    readonly entities: number;
    /**
     * Layers in the layer table.
     */
    readonly layers: number;
    /**
     * True only if drawing data could not be read.
     */
    readonly recovered: boolean;
    /**
     * AutoCAD release, e.g. "R2018".
     */
    readonly release: string;
    /**
     * Version code from the DWG header, e.g. "AC1032".
     */
    readonly version: string;
    /**
     * Short German notes for the user, grouped by kind. Can grow when a DXF is written.
     */
    readonly warnings: string[];
}

export function __wbg_reset_state(): void;

/**
 * Like `dwg_to_dxf`, but also returns information about the drawing, warnings and the layout names.
 */
export function dwg_convert(bytes: Uint8Array, full?: boolean | null): DwgConversion;

/**
 * DXF of one paper-space layout (index into `layouts` of `dwg_convert`). Reads the whole DWG again; to show
 * several layouts, keep a `DwgDrawing` instead.
 */
export function dwg_layout_to_dxf(bytes: Uint8Array, index: number): Uint8Array;

/**
 * Converts a DWG file to ASCII DXF of its model space (UTF-8). Throws an `Error` with a readable message if the
 * file cannot be read. By default the DXF contains only what a viewer draws (no OBJECTS, no unused blocks, no
 * paper space) and is written compactly; pass `full = true` for everything acadrust can write.
 */
export function dwg_to_dxf(bytes: Uint8Array, full?: boolean | null): Uint8Array;

/**
 * Returns the version code in the DWG header (for example "AC1032"), or `undefined` if the bytes are not a DWG.
 * Only looks at the first six bytes, so it is cheap.
 */
export function dwg_version(bytes: Uint8Array): string | undefined;

/**
 * Internal: installs the panic hook. Runs when the module is instantiated and after `__wbg_reset_state()`.
 */
export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_dwgdrawing_free: (a: number, b: number) => void;
    readonly dwg_convert: (a: number, b: number, c: number, d: number) => void;
    readonly dwg_layout_to_dxf: (a: number, b: number, c: number, d: number) => void;
    readonly dwg_to_dxf: (a: number, b: number, c: number, d: number) => void;
    readonly dwg_version: (a: number, b: number, c: number) => void;
    readonly dwgdrawing_details: (a: number, b: number) => void;
    readonly dwgdrawing_entities: (a: number) => number;
    readonly dwgdrawing_layers: (a: number) => number;
    readonly dwgdrawing_layoutDxf: (a: number, b: number, c: number) => void;
    readonly dwgdrawing_layouts: (a: number, b: number) => void;
    readonly dwgdrawing_modelDxf: (a: number, b: number) => void;
    readonly dwgdrawing_open: (a: number, b: number, c: number, d: number) => void;
    readonly dwgdrawing_recovered: (a: number) => number;
    readonly dwgdrawing_release: (a: number, b: number) => void;
    readonly dwgdrawing_version: (a: number, b: number) => void;
    readonly dwgdrawing_warnings: (a: number, b: number) => void;
    readonly start: () => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
