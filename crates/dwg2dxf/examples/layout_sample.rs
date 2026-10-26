// SPDX-License-Identifier: GPL-3.0-or-later
//! Writes the flange sample with a paper-space layout (R2018 DWG) for scripts/test-dwg-wasm.mjs. Everything is
//! generated here from samples/cad/flange.dxf, so the file can be published as CC0-1.0.
//!
//!   cargo run --release --example layout_sample -- ../../samples/cad/flange.dxf ../../samples/cad/flange-layout-r2018.dwg
//!
//! Layout1 is an A4 landscape sheet (mm) with a frame and a title text, the overall paper viewport, and two
//! viewports onto model space: the whole flange at 1:2, and a detail of the bolt hole at (55, 0) at 2:1, twisted by
//! 30 degrees, with layer CENTERLINES frozen in it.
use std::process::ExitCode;

use acadrust::entities::Viewport;
use acadrust::tables::{Layer, TableEntry};
use acadrust::types::{DxfVersion, Vector2, Vector3};
use acadrust::{Color, DwgReader, DwgWriter, DxfReader, EntityType, LwPolyline, Text};

fn viewport(id: i16, center: (f64, f64), size: (f64, f64), view_center: (f64, f64), view_height: f64, twist_degrees: f64) -> Viewport {
    let mut viewport = Viewport::new();
    viewport.id = id;
    viewport.center = Vector3::new(center.0, center.1, 0.0);
    viewport.width = size.0;
    viewport.height = size.1;
    viewport.view_center = Vector3::new(view_center.0, view_center.1, 0.0);
    viewport.view_height = view_height;
    viewport.view_direction = Vector3::UNIT_Z;
    viewport.view_target = Vector3::ZERO;
    viewport.twist_angle = twist_degrees.to_radians();
    viewport.status.is_on = true;
    viewport.status.is_off = false;
    viewport
}

fn run(input: &str, output: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut doc = DxfReader::from_file(input)?.read()?;
    doc.version = DxfVersion::AC1032;
    let mut frame_layer = Layer::new("FRAME");
    frame_layer.set_handle(doc.allocate_handle());
    frame_layer.color = Color::Index(7);
    doc.layers.add(frame_layer)?;

    doc.add_entity_to_layout(EntityType::Viewport(Box::new(viewport(1, (148.5, 105.0), (297.0, 210.0), (148.5, 105.0), 210.0, 0.0))), "Layout1")?;
    doc.add_entity_to_layout(EntityType::Viewport(Box::new(viewport(2, (100.0, 105.0), (180.0, 170.0), (0.0, -16.0), 340.0, 0.0))), "Layout1")?;
    let twist = 30f64.to_radians();
    let detail_center = (55.0 * twist.cos(), 55.0 * twist.sin()); // the view center is in view (twisted) coordinates
    let mut detail = viewport(3, (235.0, 140.0), (70.0, 70.0), detail_center, 35.0, 30.0);
    detail.frozen_layers = doc.layers.get("CENTERLINES").map(|l| vec![l.handle()]).unwrap_or_default();
    doc.add_entity_to_layout(EntityType::Viewport(Box::new(detail)), "Layout1")?;

    let mut frame = LwPolyline::from_points(vec![
        Vector2::new(10.0, 10.0),
        Vector2::new(287.0, 10.0),
        Vector2::new(287.0, 200.0),
        Vector2::new(10.0, 200.0),
    ]);
    frame.is_closed = true;
    frame.common.layer = "FRAME".into();
    doc.add_entity_to_layout(EntityType::LwPolyline(frame), "Layout1")?;
    let mut title = Text::with_value("FLANGE 160x160 - SHEET 1", Vector3::new(190.0, 20.0, 0.0)).with_height(5.0);
    title.common.layer = "FRAME".into();
    doc.add_entity_to_layout(EntityType::Text(title), "Layout1")?;

    let bytes = DwgWriter::write_to_vec(&doc)?;
    let check = DwgReader::from_stream(std::io::Cursor::new(bytes.as_slice())).read()?;
    let viewports = check.entities().filter(|e| matches!(e, EntityType::Viewport(_))).count();
    if viewports != 3 {
        return Err(format!("expected 3 viewports after reading back, found {viewports}").into());
    }
    std::fs::write(output, &bytes)?;
    println!("{output}: {} bytes, {} entities, {viewports} viewports", bytes.len(), check.entities().count());
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: layout_sample <flange.dxf> <output.dwg>");
        return ExitCode::from(2);
    }
    match run(&args[1], &args[2]) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
