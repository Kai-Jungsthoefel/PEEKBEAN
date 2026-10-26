// SPDX-License-Identifier: GPL-3.0-or-later
//! Converts a DWG to DXF natively with the same code as the WebAssembly module, and prints sizes and timings
//! (no drawing content). For development; the web app uses the WebAssembly build.
//!
//!   cargo run --release --example dwg_to_dxf -- <input.dwg> [output.dxf] [--full] [--layouts]
//!
//! With `--layouts` every paper-space layout is converted too (written next to the output as `<output>.layoutN.dxf`).
use std::process::ExitCode;
use std::time::Instant;

fn run(args: &[String]) -> Result<(), String> {
    let full = args.iter().any(|a| a == "--full");
    let with_layouts = args.iter().any(|a| a == "--layouts");
    let paths: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let input = paths.first().ok_or("usage: dwg_to_dxf <input.dwg> [output.dxf] [--full] [--layouts]")?;
    let bytes = std::fs::read(input).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let drawing = dwg2dxf::Drawing::open(&bytes, full)?;
    let opened = started.elapsed().as_secs_f64();
    let model = drawing.model_dxf()?;
    println!(
        "{} ({}): {} entities, {} layers, {} warnings, {} details, recovered: {}, {} layouts; read {:.2} s, model DXF {} bytes in {:.2} s",
        drawing.version,
        drawing.release,
        drawing.entities,
        drawing.layers,
        drawing.warnings().len(),
        drawing.details().len(),
        drawing.recovered,
        drawing.layout_names().len(),
        opened,
        model.len,
        started.elapsed().as_secs_f64() - opened
    );
    if let Some(output) = paths.get(1) {
        std::fs::write(output, model.to_vec()).map_err(|e| e.to_string())?;
    }
    if with_layouts {
        for index in 0..drawing.layout_names().len() {
            let started = Instant::now();
            let dxf = drawing.layout_dxf(index)?;
            println!("  layout {index}: DXF {} bytes in {:.2} s", dxf.len, started.elapsed().as_secs_f64());
            if let Some(output) = paths.get(1) {
                std::fs::write(format!("{output}.layout{index}.dxf"), dxf.to_vec()).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
