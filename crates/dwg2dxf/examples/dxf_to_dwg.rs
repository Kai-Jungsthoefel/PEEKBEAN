// SPDX-License-Identifier: GPL-3.0-or-later
//! Converts a DXF file to DWG with acadrust. Only used to create the sample drawings in samples/cad/.
//!
//!   cargo run --release --example dxf_to_dwg -- <input.dxf> <output.dwg> <version>
//!
//! <version> is an AutoCAD release (R12, R13, R14, R2000, R2004, R2007, R2010, R2013, R2018)
//! or a DWG version code (AC1009 ... AC1032).
use std::process::ExitCode;

use acadrust::types::DxfVersion;
use acadrust::{DwgReader, DwgWriter, DxfReader};

fn parse_version(text: &str) -> Option<DxfVersion> {
    Some(match text.to_ascii_uppercase().as_str() {
        "R12" | "AC1009" => DxfVersion::AC1009,
        "R13" | "AC1012" => DxfVersion::AC1012,
        "R14" | "AC1014" => DxfVersion::AC1014,
        "R2000" | "AC1015" => DxfVersion::AC1015,
        "R2004" | "AC1018" => DxfVersion::AC1018,
        "R2007" | "AC1021" => DxfVersion::AC1021,
        "R2010" | "AC1024" => DxfVersion::AC1024,
        "R2013" | "AC1027" => DxfVersion::AC1027,
        "R2018" | "AC1032" => DxfVersion::AC1032,
        _ => return None,
    })
}

fn run(input: &str, output: &str, version: DxfVersion) -> Result<(), Box<dyn std::error::Error>> {
    let mut document = DxfReader::from_file(input)?.read()?;
    let source_version = document.version;
    document.version = version;
    let bytes = DwgWriter::write_to_vec(&document)?;

    // Read the result back before keeping it, so a broken file never ends up in samples/.
    let check = DwgReader::from_stream(std::io::Cursor::new(bytes.as_slice())).read()?;
    if check.entities().count() != document.entities().count() {
        return Err(format!(
            "read-back mismatch: wrote {} entities, read {}",
            document.entities().count(),
            check.entities().count()
        )
        .into());
    }
    std::fs::write(output, &bytes)?;
    println!(
        "{input} ({}) -> {output} ({}, {} bytes, {} entities, {} layers)",
        source_version.as_str(),
        version.as_str(),
        bytes.len(),
        check.entities().count(),
        check.layers.iter().count()
    );
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: dxf_to_dwg <input.dxf> <output.dwg> <R12|R13|R14|R2000|R2004|R2007|R2010|R2013|R2018>");
        return ExitCode::from(2);
    }
    let Some(version) = parse_version(&args[3]) else {
        eprintln!("unknown DWG version: {}", args[3]);
        return ExitCode::from(2);
    };
    match run(&args[1], &args[2], version) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
