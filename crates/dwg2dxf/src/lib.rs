// SPDX-License-Identifier: GPL-3.0-or-later
//! DWG to DXF conversion for OPSIS, compiled to WebAssembly.
//!
//! The heavy lifting is done by acadrust (MPL-2.0). This crate reads a DWG from memory, makes the drawing
//! exportable (custom entities such as AutoCAD Architecture walls become plain geometry, see [`custom`]), and
//! writes it back out as ASCII DXF for the viewer's DXF renderer: model space, and each paper-space layout as a
//! drawing of its own (see [`layouts`]). Nothing leaves the browser.
//!
//! By default the DXF is meant for display only: what a viewer does not draw is left out, the text is written
//! compactly and whole-text MTEXT heights are made explicit (see [`trim`], [`compact`] and [`text`]). With `full`
//! the model-space DXF keeps everything acadrust can write.

mod compact;
mod custom;
mod layouts;
mod proxy_graphics;
mod text;
mod trim;

use std::cell::RefCell;
use std::io::Cursor;

use acadrust::objects::{ClassObjectData, ObjectType};
use acadrust::types::{DxfVersion, Handle};
use acadrust::{CadDocument, DwgReadOptions, DwgReader, DxfError, DxfWriter};
use wasm_bindgen::prelude::*;

pub use compact::Dxf;

/// Version code and AutoCAD release of a DWG file, read from its first six bytes.
/// Returns `None` if the bytes do not start like a DWG file.
pub fn sniff_version(bytes: &[u8]) -> Option<(String, &'static str)> {
    let head = bytes.get(..6)?;
    if !head.starts_with(b"AC") || !head[2..].iter().all(|b| b.is_ascii_alphanumeric() || *b == b'.') {
        return None;
    }
    let code = std::str::from_utf8(head).ok()?;
    let release = match code {
        "AC1.2" | "AC1.40" | "AC1.50" | "AC2.10" | "AC1001" | "AC1002" | "AC1003" | "AC1004" | "AC1006" => {
            "pre-R11"
        }
        "AC1009" => "R11/R12",
        "AC1012" => "R13",
        "AC1014" => "R14",
        "AC1015" => "R2000",
        "AC1018" => "R2004",
        "AC1021" => "R2007",
        "AC1024" => "R2010",
        "AC1027" => "R2013",
        "AC1032" => "R2018",
        _ => "unknown",
    };
    Some((code.to_owned(), release))
}

/// German number with thousands separators, e.g. "1.020".
fn number(n: usize) -> String {
    let digits = n.to_string();
    let mut grouped = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// German count with the right noun form, e.g. "1 Element", "1.020 Elemente".
fn count(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", number(n), if n == 1 { one } else { many })
}

/// At most this many raw reader and writer messages are kept in `details`.
const MAX_DETAILS: usize = 50;

// ---- Reading ------------------------------------------------------------------------------------------------

struct Read {
    document: CadDocument,
    warnings: Vec<String>,
    details: Vec<String>,
    recovered: bool,
}

// Diagnostics that do not mean drawing data was lost.
const AUXILIARY: &str = "auxiliary-object-preserved"; // a non-graphical object kept undecoded
const LIMIT: &str = "diagnostic-limit-reached";
const MESH: &str = "mesh-face-budget";

/// Class name in an `auxiliary-object-preserved` message.
fn auxiliary_class(message: &str) -> &str {
    message.split("auxiliary object ").nth(1).and_then(|rest| rest.split_whitespace().next()).unwrap_or_default()
}

/// Kind of a non-graphical object class, for grouping warnings.
fn auxiliary_kind(class: &str) -> &'static str {
    let name = class.to_ascii_uppercase();
    if name.contains("OBJECTCONTEXTDATA") || name.contains("SCALE") {
        "annotation scales"
    } else if name.contains("ASSOC") || name.contains("CONSTRAINT") || name.contains("EVALUATION") || name.contains("PARAM") {
        "constraints and parameters"
    } else {
        "other"
    }
}

fn read_document(bytes: &[u8]) -> Result<Read, String> {
    let Some((code, release)) = sniff_version(bytes) else {
        return Err(if bytes.is_empty() {
            "The file is empty.".to_owned()
        } else {
            "Not a DWG file (the AutoCAD version signature is missing).".to_owned()
        });
    };
    if matches!(release, "pre-R11" | "unknown") {
        return Err(format!("Unsupported DWG version {code} ({release}); supported are R12 (AC1009) to R2018+ (AC1032)."));
    }

    // Failsafe mode only changes error handling: an intact file reads the same, a damaged one as far as possible.
    // (Strict mode also gives up on a single undecodable non-graphical object, which real drawings often contain.)
    let outcome = DwgReader::from_stream_with_options(Cursor::new(bytes), DwgReadOptions::failsafe())
        .read_with_stats()
        .map_err(|error| format!("Could not read the {release} DWG file: {error}"))?;
    let diagnostics = &outcome.stats.diagnostics;
    let damage: Vec<_> = diagnostics.iter().filter(|d| ![AUXILIARY, LIMIT, MESH].contains(&d.code.as_str())).collect();
    if outcome.document.entities().next().is_none() && !damage.is_empty() {
        return Err(format!("Could not read the {release} DWG file: {}", damage[0].message));
    }

    let capped = diagnostics.iter().any(|d| d.code == LIMIT);
    let at_least = if capped { "at least " } else { "" };
    let recovered = !damage.is_empty() || outcome.stats.skipped_source_records > 0;
    let mut warnings = Vec::new();
    if recovered {
        let n = damage.len().max(outcome.stats.skipped_source_records);
        warnings.push(format!(
            "The file is damaged; showing what could be read ({at_least}{})",
            count(n, "read error", "read errors")
        ));
    }
    // acadrust keeps at most 1000 diagnostics. Undecoded objects stay in the document as raw (unknown) objects, so
    // when the list was cut off, count those instead.
    let classes: Vec<&str> = if capped {
        outcome
            .document
            .objects
            .values()
            .filter_map(|o| match o {
                ObjectType::Unknown { type_name, raw_dwg_data: Some(_), .. } => Some(type_name.as_str()),
                _ => None,
            })
            .collect()
    } else {
        diagnostics.iter().filter(|d| d.code == AUXILIARY).map(|d| auxiliary_class(&d.message)).collect()
    };
    let mut kinds: Vec<(&str, usize)> = Vec::new();
    for class in classes {
        let kind = auxiliary_kind(class);
        match kinds.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, n)) => *n += 1,
            None => kinds.push((kind, 1)),
        }
    }
    kinds.sort_by_key(|(kind, _)| ["annotation scales", "constraints and parameters", "other"].iter().position(|k| k == kind));
    for (kind, n) in kinds {
        let what = if kind == "other" {
            count(n, "other auxiliary object", "other auxiliary objects")
        } else {
            format!("{} ({kind})", count(n, "auxiliary object", "auxiliary objects"))
        };
        warnings.push(format!("{what} could not be read; the drawing is not affected"));
    }
    let meshes = diagnostics.iter().filter(|d| d.code == MESH).count();
    if meshes > 0 {
        warnings.push(format!("{} shortened because of {} size", count(meshes, "mesh was", "meshes were"), if meshes == 1 { "its" } else { "their" }));
    }
    // Damage first, then the rest, in reading order.
    let details: Vec<String> = damage
        .iter()
        .map(|d| d.message.clone())
        .chain(diagnostics.iter().filter(|d| d.code == AUXILIARY || d.code == MESH).map(|d| d.message.clone()))
        .take(MAX_DETAILS)
        .collect();
    Ok(Read { document: outcome.document, warnings, details, recovered })
}

// ---- Writing ------------------------------------------------------------------------------------------------

/// At most this many records are skipped one by one when the DXF writer refuses them.
const MAX_SKIPPED_RECORDS: usize = 25;

/// Writes `document` as DXF. Records the writer refuses are removed from `document` and their messages added to
/// `skipped`.
fn write_dxf(document: &mut CadDocument, compact: bool, skipped: &mut Vec<String>) -> Result<Dxf, String> {
    // DXF before R2007 stores text in the drawing's code page; from R2007 on it is UTF-8.
    // Writing at least R2007 gives the viewer one encoding to deal with.
    let version = if document.version < DxfVersion::AC1021 { DxfVersion::AC1021 } else { document.version };
    let mut attempts = 0;
    loop {
        let mut sink = compact::DxfSink::new(compact);
        let error = match DxfWriter::new(document).with_version(version).write_to_writer(&mut sink) {
            Ok(()) => return Ok(sink.finish()),
            Err(error) => error,
        };
        // Some records cannot be written to DXF (acadrust reports them as not implemented). Leave such a record out
        // instead of failing the whole drawing.
        let DxfError::NotImplemented(message) = &error else {
            return Err(format!("Could not write DXF: {error}"));
        };
        attempts += 1;
        if attempts > MAX_SKIPPED_RECORDS || !skip_record(document, message) {
            return Err(format!("Could not write DXF: {error}"));
        }
        skipped.push(message.clone());
    }
}

/// Removes the record named in a writer error. Returns false if there is nothing to remove.
fn skip_record(document: &mut CadDocument, message: &str) -> bool {
    let handle = message.find("handle 0x").and_then(|at| {
        let hex: String = message[at + 9..].chars().take_while(char::is_ascii_hexdigit).collect();
        u64::from_str_radix(&hex, 16).ok().map(Handle::from)
    });
    if let Some(handle) = handle {
        if document.objects.remove(&handle).is_some() {
            custom::remove_dictionary_entries(document, &[handle].into_iter().collect());
            return true;
        }
        return document.remove_entity_arc(handle).is_some();
    }
    if message.starts_with("DATATABLE") {
        let before = document.objects.len();
        document.objects.retain(|_, object| {
            !matches!(object, ObjectType::ClassObject(class) if matches!(class.data, ClassObjectData::DataTable(_)))
        });
        return document.objects.len() < before;
    }
    false
}

// ---- Drawing ------------------------------------------------------------------------------------------------

/// Grows the heap in one step to roughly what reading a drawing of `input` bytes needs. Growing WebAssembly memory
/// in the allocator's small steps made the first conversion of a large drawing several times slower than later
/// ones. The memory is freed right away and reused by the allocator; untouched pages cost no physical memory.
fn reserve_heap(input: usize) {
    if cfg!(target_arch = "wasm32") {
        let size = input.saturating_mul(20).min(1 << 30);
        drop(Vec::<u8>::with_capacity(size));
    }
}

/// A DWG read and prepared for conversion. DXF for model space and for each layout is written on request.
pub struct Drawing {
    document: CadDocument,
    full: bool,
    layouts: Vec<layouts::Layout>,
    /// Version code from the DWG header, for example `AC1032`.
    pub version: String,
    /// AutoCAD release of that version, for example `R2018`.
    pub release: &'static str,
    /// Number of entities read from the file (model space, paper space and block definitions).
    pub entities: usize,
    /// Number of layers in the layer table.
    pub layers: usize,
    /// True if the file is damaged and only part of it could be read.
    pub recovered: bool,
    warnings: RefCell<Vec<String>>,
    details: RefCell<Vec<String>>,
    skipped: RefCell<usize>,
}

impl Drawing {
    /// Reads a DWG from memory. With `full`, the model-space DXF keeps everything acadrust can write; otherwise
    /// it only contains what a viewer draws, written compactly.
    pub fn open(bytes: &[u8], full: bool) -> Result<Drawing, String> {
        reserve_heap(bytes.len());
        let Read { mut document, mut warnings, details, recovered } = read_document(bytes)?;
        let entities = document.entities().count();
        let layers = document.layers.len();
        let layouts = layouts::layouts(&document);

        let mut report = custom::Report::default();
        custom::replace_custom_entities(&mut document, !full, &mut report);
        custom::remove_unwritable_objects(&mut document, &mut report);
        if !full {
            text::fold_mtext_heights(&mut document);
            // A viewer does not use the OBJECTS section; without it the copies made for each DXF are cheap.
            document.objects.clear();
        }

        if report.arch_replaced > 0 {
            warnings.push(format!("{} from AutoCAD Architecture shown as simple geometry", count(report.arch_replaced, "element", "elements")));
        }
        if report.arch_dropped > 0 {
            warnings.push(format!(
                "{} without displayable geometry left out",
                count(report.arch_dropped, "Architecture element", "Architecture elements")
            ));
        }
        if report.arch_objects > 0 {
            warnings.push(format!(
                "{} skipped",
                count(report.arch_objects, "Architecture settings object", "Architecture settings objects")
            ));
        }
        if report.custom_replaced > 0 {
            warnings.push(format!(
                "{} shown as simple geometry",
                count(report.custom_replaced, "custom element (proxy)", "custom elements (proxy)")
            ));
        }
        if report.custom_dropped > 0 {
            warnings.push(format!(
                "{} without displayable geometry left out",
                count(report.custom_dropped, "custom element", "custom elements")
            ));
        }
        if report.other_objects > 0 {
            warnings.push(format!(
                "{} skipped that cannot be carried over to DXF",
                count(report.other_objects, "record", "records")
            ));
        }
        if report.truncated {
            warnings.push("The substitute geometry for custom elements was shortened because of its size".to_owned());
        }

        let (version, release) = sniff_version(bytes).unwrap_or_default();
        Ok(Drawing {
            document,
            full,
            layouts,
            version,
            release,
            entities,
            layers,
            recovered,
            warnings: RefCell::new(warnings),
            details: RefCell::new(details),
            skipped: RefCell::new(0),
        })
    }

    /// Short German notes for the user, grouped by kind.
    pub fn warnings(&self) -> Vec<String> {
        self.warnings.borrow().clone()
    }

    /// Raw (English) reader and writer messages behind the warnings, at most 50.
    pub fn details(&self) -> Vec<String> {
        self.details.borrow().clone()
    }

    /// Names of the paper-space layouts, in tab order.
    pub fn layout_names(&self) -> Vec<String> {
        self.layouts.iter().map(|l| l.name.clone()).collect()
    }

    /// DXF of model space.
    pub fn model_dxf(&self) -> Result<Dxf, String> {
        let mut document = self.document.clone();
        if !self.full {
            for block in document.block_records.iter_mut() {
                if block.name.to_uppercase().starts_with("*PAPER_SPACE") {
                    block.entity_handles.clear();
                }
            }
            trim::trim_for_display(&mut document);
        }
        self.write(document, !self.full)
    }

    /// DXF of a paper-space layout (index into [`Self::layout_names`]), with the layout's paper-space entities in
    /// model space and the viewports' contents placed on the sheet. Always written for display.
    pub fn layout_dxf(&self, index: usize) -> Result<Dxf, String> {
        let layout = self.layouts.get(index).ok_or_else(|| format!("There is no layout {index}."))?;
        let mut document = layouts::layout_document(&self.document, layout);
        trim::trim_for_display(&mut document);
        self.write(document, true)
    }

    fn write(&self, mut document: CadDocument, compact: bool) -> Result<Dxf, String> {
        let mut skipped = Vec::new();
        let dxf = write_dxf(&mut document, compact, &mut skipped)?;
        drop(document);
        if !skipped.is_empty() {
            // The same records are skipped again for the next DXF; count them once.
            let mut total = self.skipped.borrow_mut();
            if skipped.len() > *total {
                let mut warnings = self.warnings.borrow_mut();
                warnings.retain(|w| !w.ends_with("that cannot be carried over to DXF (when writing)"));
                warnings.push(format!(
                    "{} skipped that cannot be carried over to DXF (when writing)",
                    count(skipped.len(), "record", "records")
                ));
                let mut details = self.details.borrow_mut();
                for message in skipped.iter().skip(*total) {
                    if details.len() < MAX_DETAILS {
                        details.push(format!("Not written to DXF: {message}"));
                    }
                }
                *total = skipped.len();
            }
        }
        Ok(dxf)
    }
}

/// Model-space DXF and information about a DWG, see [`Drawing`].
pub struct Conversion {
    pub drawing: Drawing,
    pub dxf: Dxf,
}

/// Reads a DWG file from memory and converts its model space to ASCII DXF.
pub fn convert(bytes: &[u8], full: bool) -> Result<Conversion, String> {
    let drawing = Drawing::open(bytes, full)?;
    let dxf = drawing.model_dxf()?;
    Ok(Conversion { drawing, dxf })
}

// ---- WebAssembly interface ----------------------------------------------------------------------------------

/// Name of the JS error thrown when the Rust code panics (a bug or an unexpected file structure in acadrust).
const PANIC_ERROR_NAME: &str = "DwgReaderCrash";

fn js_error(message: String) -> JsError {
    JsError::new(&message)
}

/// Copies the chunks into one JS array, freeing each chunk on the way.
fn to_js(dxf: Dxf) -> js_sys::Uint8Array {
    let array = js_sys::Uint8Array::new_with_length(dxf.len as u32);
    let mut offset = 0u32;
    for chunk in dxf.chunks {
        let end = offset + chunk.len() as u32;
        array.subarray(offset, end).copy_from(&chunk);
        offset = end;
    }
    array
}

fn strings(values: &[String]) -> js_sys::Array {
    values.iter().map(|v| JsValue::from_str(v)).collect()
}

// The standard library for wasm32-unknown-unknown is built with panic = "abort", so a panic cannot be caught with
// `catch_unwind`. Instead the hook throws a JS error named `DwgReaderCrash` straight out of the module. The aborted
// call leaks its memory and leaves the panic counter set (a second panic in the same instance traps as
// `RuntimeError: unreachable`), so callers should call `__wbg_reset_state()` (generated by wasm-bindgen with
// `--experimental-reset-state-function`) after such an error to continue with a fresh instance. Objects of the old
// instance (DwgDrawing) are invalid after that.
//
// wasm-bindgen's automatic `handler::schedule_reinit()` is deliberately not used: in 0.2.129 its glue swaps the
// instance after the arguments were already copied into the old one, which corrupts the next call.

/// Internal: installs the panic hook. Runs when the module is instantiated and after `__wbg_reset_state()`.
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| {
        let error = js_sys::Error::new(&format!("The DWG reader crashed on this file: {info}"));
        error.set_name(PANIC_ERROR_NAME);
        wasm_bindgen::throw_val(error.into());
    }));
}

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &'static str = r#"
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
"#;

/// Converts a DWG file to ASCII DXF of its model space (UTF-8). Throws an `Error` with a readable message if the
/// file cannot be read. By default the DXF contains only what a viewer draws (no OBJECTS, no unused blocks, no
/// paper space) and is written compactly; pass `full = true` for everything acadrust can write.
#[wasm_bindgen]
pub fn dwg_to_dxf(bytes: &[u8], full: Option<bool>) -> Result<js_sys::Uint8Array, JsError> {
    convert(bytes, full.unwrap_or(false)).map(|conversion| to_js(conversion.dxf)).map_err(js_error)
}

/// Like `dwg_to_dxf`, but also returns information about the drawing, warnings and the layout names.
#[wasm_bindgen(unchecked_return_type = "DwgConversion")]
pub fn dwg_convert(bytes: &[u8], full: Option<bool>) -> Result<JsValue, JsError> {
    let Conversion { drawing, dxf } = convert(bytes, full.unwrap_or(false)).map_err(js_error)?;
    let object = js_sys::Object::new();
    let set = |key: &str, value: JsValue| {
        js_sys::Reflect::set(&object, &JsValue::from_str(key), &value).expect("setting a property on a plain object");
    };
    set("version", JsValue::from_str(&drawing.version));
    set("release", JsValue::from_str(drawing.release));
    set("entities", JsValue::from_f64(drawing.entities as f64));
    set("layers", JsValue::from_f64(drawing.layers as f64));
    set("warnings", strings(&drawing.warnings()).into());
    set("details", strings(&drawing.details()).into());
    set("recovered", JsValue::from_bool(drawing.recovered));
    set("layouts", strings(&drawing.layout_names()).into());
    drop(drawing);
    set("dxf", to_js(dxf).into());
    Ok(object.into())
}

/// DXF of one paper-space layout (index into `layouts` of `dwg_convert`). Reads the whole DWG again; to show
/// several layouts, keep a `DwgDrawing` instead.
#[wasm_bindgen]
pub fn dwg_layout_to_dxf(bytes: &[u8], index: u32) -> Result<js_sys::Uint8Array, JsError> {
    let drawing = Drawing::open(bytes, false).map_err(js_error)?;
    drawing.layout_dxf(index as usize).map(to_js).map_err(js_error)
}

/// Returns the version code in the DWG header (for example "AC1032"), or `undefined` if the bytes are not a DWG.
/// Only looks at the first six bytes, so it is cheap.
#[wasm_bindgen]
pub fn dwg_version(bytes: &[u8]) -> Option<String> {
    sniff_version(bytes).map(|(code, _)| code)
}

/// A DWG read once, from which model space and each layout can be converted to DXF on demand. Holds the drawing in
/// WebAssembly memory until `free()` is called.
#[wasm_bindgen]
pub struct DwgDrawing {
    inner: Drawing,
}

#[wasm_bindgen]
impl DwgDrawing {
    /// Reads a DWG file. Throws an `Error` with a readable message if it cannot be read. With `full`,
    /// `modelDxf()` keeps everything acadrust can write.
    pub fn open(bytes: &[u8], full: Option<bool>) -> Result<DwgDrawing, JsError> {
        Drawing::open(bytes, full.unwrap_or(false)).map(|inner| DwgDrawing { inner }).map_err(js_error)
    }

    /// Version code from the DWG header, e.g. "AC1032".
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        self.inner.version.clone()
    }

    /// AutoCAD release, e.g. "R2018".
    #[wasm_bindgen(getter)]
    pub fn release(&self) -> String {
        self.inner.release.to_owned()
    }

    /// Entities read from the file.
    #[wasm_bindgen(getter)]
    pub fn entities(&self) -> u32 {
        self.inner.entities as u32
    }

    /// Layers in the layer table.
    #[wasm_bindgen(getter)]
    pub fn layers(&self) -> u32 {
        self.inner.layers as u32
    }

    /// Short German notes for the user, grouped by kind. Can grow when a DXF is written.
    #[wasm_bindgen(getter)]
    pub fn warnings(&self) -> Vec<String> {
        self.inner.warnings()
    }

    /// Raw (English) messages behind the warnings, at most 50.
    #[wasm_bindgen(getter)]
    pub fn details(&self) -> Vec<String> {
        self.inner.details()
    }

    /// True only if drawing data could not be read.
    #[wasm_bindgen(getter)]
    pub fn recovered(&self) -> bool {
        self.inner.recovered
    }

    /// Paper-space layout names in tab order (without "Model").
    pub fn layouts(&self) -> Vec<String> {
        self.inner.layout_names()
    }

    /// Model space as ASCII DXF.
    #[wasm_bindgen(js_name = modelDxf)]
    pub fn model_dxf(&self) -> Result<js_sys::Uint8Array, JsError> {
        self.inner.model_dxf().map(to_js).map_err(js_error)
    }

    /// A paper-space layout as ASCII DXF: its paper-space entities in model space and what its viewports show
    /// (model space scaled, rotated and moved onto the sheet; not clipped at the viewport border).
    #[wasm_bindgen(js_name = layoutDxf)]
    pub fn layout_dxf(&self, index: u32) -> Result<js_sys::Uint8Array, JsError> {
        self.inner.layout_dxf(index as usize).map(to_js).map_err(js_error)
    }
}
