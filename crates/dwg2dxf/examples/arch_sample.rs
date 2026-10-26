// SPDX-License-Identifier: GPL-3.0-or-later
//! Writes a small AutoCAD Architecture test drawing (R2018 DWG) for scripts/test-dwg-wasm.mjs: walls, doors and
//! windows built with acadrust's Arch constructors, with the Arch style objects those create, plus ordinary
//! entities. Everything is generated here, so the file can be published as CC0-1.0.
//!
//!   cargo run --release --example arch_sample -- ../../samples/cad/arch-walls-r2018.dwg
//!
//! Arch entities read from a DWG have no DXF form, which is what the converter has to handle. Their cached proxy
//! graphics are replaced by hand-made ones that use every record type the converter understands:
//! - wall 1: acadrust's own graphics (one polyline profile);
//! - wall 2: graphics with nothing drawable (only extents), so the converter falls back to the outline from the
//!   wall's native parameters;
//! - door: lines, arcs, circles, texts, color traits and a transformation matrix (see `door_graphics`);
//! - window: a frame polygon and a glass line, once in model space and once in a block definition inserted twice;
//! - a second door without graphics, which the converter has to leave out.
use std::process::ExitCode;

use acadrust::classes::arch::{door, wall, window};
use acadrust::entities::{ExtendedEntity, ExtendedEntityData, Insert};
use acadrust::tables::{BlockRecord, TableEntry};
use acadrust::types::{Handle, Vector3};
use acadrust::{CadDocument, Circle, DwgReader, DwgWriter, EntityType, Line, Text};

// ---- Proxy graphics writer ----------------------------------------------------------------------------------

#[derive(Default)]
struct Graphics {
    records: Vec<u8>,
    count: u32,
}

impl Graphics {
    fn record(&mut self, kind: u32, payload: &[u8]) -> &mut Self {
        let mut payload = payload.to_vec();
        while payload.len() % 4 != 0 {
            payload.push(0);
        }
        self.records.extend_from_slice(&(payload.len() as u32 + 8).to_le_bytes());
        self.records.extend_from_slice(&kind.to_le_bytes());
        self.records.extend_from_slice(&payload);
        self.count += 1;
        self
    }

    fn finish(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(self.records.len() as u32 + 8).to_le_bytes());
        out.extend_from_slice(&self.count.to_le_bytes());
        out.extend_from_slice(&self.records);
        out
    }
}

fn f(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn u(value: u32) -> Vec<u8> {
    value.to_le_bytes().to_vec()
}

fn points(points: &[[f64; 2]]) -> Vec<u8> {
    let mut out = u(points.len() as u32);
    for p in points {
        out.extend(f(&[p[0], p[1], 0.0]));
    }
    out
}

fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

/// Text record (10 or 36): position, normal, direction, height, width factor, oblique, zero-terminated string.
fn text(x: f64, y: f64, height: f64, value: &str, unicode: bool) -> Vec<u8> {
    let mut out = f(&[x, y, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, height, 1.0, 0.0]);
    out.extend(string(value, unicode));
    out
}

fn string(value: &str, unicode: bool) -> Vec<u8> {
    let mut out: Vec<u8> = if unicode {
        value.encode_utf16().chain([0]).flat_map(|c| c.to_le_bytes()).collect()
    } else {
        value.bytes().chain([0]).collect()
    };
    while out.len() % 4 != 0 {
        out.push(0);
    }
    out
}

/// Record 33: byte count, then a closed LWPOLYLINE in DWG bit coding (flags, count, first point raw, others full).
fn lwpolyline(points: &[[f64; 2]]) -> Vec<u8> {
    let mut bits: Vec<bool> = Vec::new();
    let mut push = |value: u64, count: usize| (0..count).rev().for_each(|i| bits.push(value >> i & 1 == 1));
    let bytes = |push: &mut dyn FnMut(u64, usize), data: &[u8]| data.iter().for_each(|b| push(u64::from(*b), 8));
    push(0b00, 2);
    bytes(&mut push, &512u16.to_le_bytes()); // closed
    push(0b01, 2);
    bytes(&mut push, &[points.len() as u8]);
    bytes(&mut push, &points[0][0].to_le_bytes());
    bytes(&mut push, &points[0][1].to_le_bytes());
    for p in &points[1..] {
        for value in p {
            push(0b11, 2);
            bytes(&mut push, &value.to_le_bytes());
        }
    }
    let mut body: Vec<u8> = bits.chunks(8).map(|c| c.iter().enumerate().fold(0u8, |b, (i, bit)| b | (u8::from(*bit) << (7 - i)))).collect();
    let mut out = u(body.len() as u32);
    out.append(&mut body);
    out
}

fn door_graphics() -> Vec<u8> {
    let half_pi = std::f64::consts::FRAC_PI_2;
    let mut g = Graphics::default();
    g.record(1, &f(&[-60.0, -60.0, 0.0, 960.0, 900.0, 0.0])) // extents: ignored
        .record(14, &u(1)) // red
        .record(6, &points(&[[0.0, 0.0], [0.0, 900.0], [40.0, 900.0], [40.0, 0.0], [0.0, 0.0]])) // door leaf
        .record(14, &u(256)) // by layer
        .record(4, &concat(&[f(&[0.0, 0.0, 0.0, 900.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, half_pi]), u(0)])) // swing
        .record(7, &points(&[[-60.0, -60.0], [960.0, -60.0], [960.0, 0.0], [-60.0, 0.0]])) // frame
        .record(36, &text(300.0, -400.0, 150.0, "Door 1 – Ø 90", true))
        .record(10, &text(300.0, -700.0, 100.0, "T-01", false))
        .record(16, &u(3)) // layer index: ignored
        .record(20, &u(1)) // fill on: ignored
        .record(27, &f(&[0.0; 4])) // push clip: ignored
        .record(28, &[]) // pop clip
        // rotate 90 degrees and move to (2000, 1000)
        .record(29, &f(&[0.0, -1.0, 0.0, 2000.0, 1.0, 0.0, 0.0, 1000.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]))
        .record(2, &f(&[100.0, 0.0, 0.0, 50.0, 0.0, 0.0, 1.0])) // circle -> (2000, 1100) r 50
        .record(4, &concat(&[f(&[0.0, 0.0, 0.0, 200.0, 0.0, 0.0, -1.0, 1.0, 0.0, 0.0, half_pi]), u(0)])) // -> 0..90 deg
        .record(31, &[])
        .record(22, &u(0xC2FF_8000)) // orange
        .record(3, &f(&[3000.0, 0.0, 0.0, 3100.0, 100.0, 0.0, 3200.0, 0.0, 0.0])) // circle (3100, 0) r 100
        .record(5, &concat(&[f(&[3600.0, 0.0, 0.0, 3500.0, 100.0, 0.0, 3400.0, 0.0, 0.0]), u(1)])) // half circle as sector
        .record(32, &concat(&[points(&[[4000.0, 0.0], [4100.0, 0.0], [4100.0, 100.0]]), f(&[0.0, 0.0, 1.0])]))
        .record(33, &lwpolyline(&[[5000.0, 0.0], [5100.0, 0.0], [5050.0, 80.0]]))
        .record(8, &concat(&[u(2), u(2), f(&[6000.0, 0.0, 0.0, 6100.0, 0.0, 0.0, 6000.0, 100.0, 0.0, 6100.0, 100.0, 0.0])]))
        .record(
            9,
            &concat(&[
                u(4),
                f(&[6500.0, 0.0, 0.0, 6600.0, 0.0, 0.0, 6600.0, 100.0, 0.0, 6500.0, 100.0, 0.0]),
                u(8),
                u(3), u(0), u(1), u(2),
                u(3), u(0), u(2), u(3),
            ]),
        )
        .record(38, &concat(&[f(&[7000.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0]), string("Opening 1 × 1 m", true), u(7), u(0), f(&[120.0, 1.0, 0.0, 1.0])]))
        .record(14, &u(0)) // by block: the entity's own color
        .record(6, &points(&[[0.0, -1000.0], [900.0, -1000.0]]));
    g.finish()
}

fn window_graphics(x: f64, y: f64) -> Vec<u8> {
    let mut g = Graphics::default();
    g.record(7, &points(&[[x, y], [x + 1200.0, y], [x + 1200.0, y + 100.0], [x, y + 100.0]]))
        .record(6, &points(&[[x, y + 50.0], [x + 1200.0, y + 50.0]]));
    g.finish()
}

// ---- Drawing ------------------------------------------------------------------------------------------------

/// The single Arch entity of a document made by one of the Arch constructors.
fn arch_entity(document: &CadDocument) -> ExtendedEntity {
    document
        .entities()
        .find_map(|e| match e {
            EntityType::Extended(x) if matches!(x.data, ExtendedEntityData::Arch(_)) => Some((**x).clone()),
            _ => None,
        })
        .expect("Arch entity")
}

/// Copies an Arch entity's class and layer from `source` and adds the entity to `target` under `owner`.
fn add_arch(target: &mut CadDocument, source: &CadDocument, mut entity: ExtendedEntity, owner: Handle, graphics: Option<Vec<u8>>) -> Handle {
    let ExtendedEntityData::Arch(data) = &entity.data else { unreachable!() };
    if target.classes.get_by_name(&data.dxf_name).is_none() {
        let mut class = source.classes.get_by_name(&data.dxf_name).expect("class").clone();
        class.class_number = 0; // numbered anew in the target
        target.classes.add_or_update(class);
    }
    if target.layers.get(&entity.common.layer).is_none() {
        let mut layer = source.layers.get(&entity.common.layer).expect("layer").clone();
        layer.set_handle(target.allocate_handle());
        target.layers.add(layer).expect("layer");
    }
    entity.common.layer_handle = target.layers.get(&entity.common.layer).map(|l| l.handle());
    entity.common.handle = Handle::NULL;
    entity.common.owner_handle = owner;
    entity.common.graphic_data = graphics;
    target.add_entity(EntityType::Extended(Box::new(entity))).expect("add Arch entity")
}

fn build() -> Result<CadDocument, Box<dyn std::error::Error>> {
    let mut doc = wall(Vector3::new(0.0, 0.0, 0.0), Vector3::new(6000.0, 0.0, 0.0), 240.0, 2750.0, None)?;
    let model = doc.header.model_space_block_handle;
    let wall_2 = wall(Vector3::new(6000.0, 0.0, 0.0), Vector3::new(6000.0, 4000.0, 0.0), 240.0, 2750.0, None)?;
    let door_doc = door(900.0, 2100.0, None)?;
    let window_doc = window(1200.0, 1500.0, None)?;

    let mut extents_only = Graphics::default();
    extents_only.record(1, &f(&[5880.0, 0.0, 0.0, 6120.0, 4000.0, 0.0]));
    add_arch(&mut doc, &wall_2, arch_entity(&wall_2), model, Some(extents_only.finish()));
    add_arch(&mut doc, &door_doc, arch_entity(&door_doc), model, Some(door_graphics()));
    add_arch(&mut doc, &door_doc, arch_entity(&door_doc), model, None);
    add_arch(&mut doc, &window_doc, arch_entity(&window_doc), model, Some(window_graphics(1000.0, 3000.0)));

    let mut block = BlockRecord::new("WINDOW");
    block.handle = doc.allocate_handle();
    block.block_entity_handle = doc.allocate_handle();
    block.block_end_handle = doc.allocate_handle();
    let block_handle = block.handle;
    doc.block_records.add(block)?;
    add_arch(&mut doc, &window_doc, arch_entity(&window_doc), block_handle, Some(window_graphics(0.0, 0.0)));
    doc.add_entity(EntityType::Insert(Insert::new("WINDOW", Vector3::new(8000.0, 0.0, 0.0))))?;
    doc.add_entity(EntityType::Insert(Insert::new("WINDOW", Vector3::new(8000.0, 2000.0, 0.0)).with_rotation(std::f64::consts::FRAC_PI_2)))?;

    doc.add_entity(EntityType::Line(Line::from_coords(0.0, -2000.0, 0.0, 10000.0, -2000.0, 0.0)))?;
    doc.add_entity(EntityType::Circle(Circle::from_coords(10000.0, 4000.0, 0.0, 500.0)))?;
    doc.add_entity(EntityType::Text(Text::with_value("Ground floor plan", Vector3::new(0.0, -2500.0, 0.0)).with_height(250.0)))?;
    Ok(doc)
}

fn main() -> ExitCode {
    let Some(output) = std::env::args().nth(1) else {
        eprintln!("usage: arch_sample <output.dwg>");
        return ExitCode::from(2);
    };
    let result = build().and_then(|doc| {
        let bytes = DwgWriter::write_to_vec(&doc)?;
        // Read it back: the Arch entities must survive, without DXF form, with their graphics.
        let check = DwgReader::from_stream(std::io::Cursor::new(bytes.as_slice())).read()?;
        let arch: Vec<_> = check
            .entities()
            .filter_map(|e| match e {
                EntityType::Extended(x) => match &x.data {
                    ExtendedEntityData::Arch(a) => Some((a.dxf_name.clone(), a.raw_dxf_codes.is_none(), x.common.graphic_data.is_some())),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        let objects = check.objects.values().filter(|o| matches!(o, acadrust::objects::ObjectType::Arch(_))).count();
        if arch.len() != 6 || arch.iter().any(|(_, no_dxf, _)| !no_dxf) || arch.iter().filter(|(_, _, g)| *g).count() != 5 {
            return Err(format!("unexpected Arch entities after reading back: {arch:?}").into());
        }
        std::fs::write(&output, &bytes)?;
        println!("{output}: {} bytes, {} entities, {} Arch entities, {} Arch objects", bytes.len(), check.entities().count(), arch.len(), objects);
        Ok(())
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
