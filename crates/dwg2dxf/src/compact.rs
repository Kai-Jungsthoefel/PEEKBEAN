// SPDX-License-Identifier: GPL-3.0-or-later
//! Receives the DXF text from acadrust's writer. The text is kept in chunks instead of one growing buffer, which
//! would briefly need twice its size while reallocating (and WebAssembly memory never shrinks).
//!
//! In compact mode the text is rewritten as it streams through, without changing what a viewer draws: LF instead
//! of CRLF line ends, group codes and integer values without padding, floating-point values rounded to 12
//! significant digits (about a micrometre on a 1 km drawing in mm) and values below 1e-12 written as 0. In the
//! ENTITIES and BLOCKS sections, zero widths and bulges of LWPOLYLINE vertices (the default) and extended data
//! (XDATA) are left out, except the XDATA of DIMENSION entities, which carries dimension style overrides.

use std::io::{self, Write};

const CHUNK: usize = 4 << 20;
const SIGNIFICANT: usize = 12;

/// The finished DXF text, in chunks.
pub struct Dxf {
    pub chunks: Vec<Vec<u8>>,
    pub len: usize,
}

impl Dxf {
    pub fn to_vec(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.len);
        for chunk in &self.chunks {
            out.extend_from_slice(chunk);
        }
        out
    }
}

pub struct DxfSink {
    compact: bool,
    chunks: Vec<Vec<u8>>,
    current: Vec<u8>,
    len: usize,
    partial: Vec<u8>,
    expect_code: bool,
    code: i32,
    /// The group code as written, kept until its value decides whether the pair is written.
    code_text: Vec<u8>,
    /// Inside the ENTITIES or BLOCKS section.
    in_geometry: bool,
    /// The previous pair was 0/SECTION, so this one names the section.
    section_next: bool,
    entity_is_lwpolyline: bool,
    entity_is_dimension: bool,
}

#[derive(PartialEq)]
enum Value {
    Float,
    Integer,
    Text,
}

fn value_kind(code: i32) -> Value {
    match code {
        10..=59 | 110..=149 | 210..=239 | 460..=469 | 1010..=1059 => Value::Float,
        60..=99 | 160..=179 | 270..=299 | 370..=389 | 400..=409 | 420..=459 | 1060..=1071 => Value::Integer,
        _ => Value::Text,
    }
}

impl DxfSink {
    pub fn new(compact: bool) -> Self {
        Self {
            compact,
            chunks: Vec::new(),
            current: Vec::with_capacity(CHUNK),
            len: 0,
            partial: Vec::new(),
            expect_code: true,
            code: 0,
            code_text: Vec::new(),
            in_geometry: false,
            section_next: false,
            entity_is_lwpolyline: false,
            entity_is_dimension: false,
        }
    }

    pub fn finish(mut self) -> Dxf {
        if !self.partial.is_empty() {
            let partial = std::mem::take(&mut self.partial);
            self.line(&partial);
        }
        if !self.current.is_empty() {
            self.chunks.push(std::mem::take(&mut self.current));
        }
        Dxf { chunks: self.chunks, len: self.len }
    }

    fn emit(&mut self, mut bytes: &[u8]) {
        self.len += bytes.len();
        while !bytes.is_empty() {
            let room = CHUNK - self.current.len();
            let (now, later) = bytes.split_at(room.min(bytes.len()));
            self.current.extend_from_slice(now);
            bytes = later;
            if self.current.len() == CHUNK {
                self.chunks.push(std::mem::replace(&mut self.current, Vec::with_capacity(CHUNK)));
            }
        }
    }

    fn line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if self.expect_code {
            self.expect_code = false;
            let code = line.trim_ascii();
            self.code = std::str::from_utf8(code).ok().and_then(|c| c.parse().ok()).unwrap_or(-1);
            self.code_text.clear();
            self.code_text.extend_from_slice(code);
            return;
        }
        self.expect_code = true;
        let code = self.code;
        if code == 0 {
            self.entity_is_lwpolyline = line == b"LWPOLYLINE";
            self.entity_is_dimension = line == b"DIMENSION";
            if line == b"ENDSEC" {
                self.in_geometry = false;
            }
        } else if code == 2 && self.section_next {
            self.in_geometry = line == b"ENTITIES" || line == b"BLOCKS";
        }
        self.section_next = code == 0 && line == b"SECTION";

        let mut buffer = [0u8; 64];
        let value: &[u8] = match value_kind(code) {
            Value::Float => {
                let value = line.trim_ascii();
                match round_decimal(value, &mut buffer) {
                    Some(len) => &buffer[..len],
                    // Exponent notation: acadrust uses it below 1e-15 and above 1e15.
                    None if std::str::from_utf8(value).ok().and_then(|v| v.parse::<f64>().ok()).is_some_and(|v| v.abs() < 1e-12) => {
                        b"0.0"
                    }
                    None => value,
                }
            }
            Value::Integer => line.trim_ascii(),
            Value::Text => line,
        };
        if self.in_geometry {
            let zero_vertex_value = self.entity_is_lwpolyline && matches!(code, 40..=43) && value == b"0.0";
            let xdata = code >= 1000 && !self.entity_is_dimension;
            if zero_vertex_value || xdata {
                return;
            }
        }
        let code_text = std::mem::take(&mut self.code_text);
        self.emit(&code_text);
        self.emit(b"\n");
        self.emit(value);
        self.emit(b"\n");
        self.code_text = code_text;
    }
}

impl Write for DxfSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if !self.compact {
            self.emit(buf);
            return Ok(buf.len());
        }
        let mut rest = buf;
        while let Some(end) = rest.iter().position(|b| *b == b'\n') {
            if self.partial.is_empty() {
                self.line(&rest[..end]);
            } else {
                let mut partial = std::mem::take(&mut self.partial);
                partial.extend_from_slice(&rest[..end]);
                self.line(&partial);
                partial.clear();
                self.partial = partial;
            }
            rest = &rest[end + 1..];
        }
        self.partial.extend_from_slice(rest);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Rounds a number written as `[-]digits.digits` to 12 significant digits into `out`, returning its length.
/// Returns `None` for other forms (exponent notation, no decimal point, 12 or more integer digits).
fn round_decimal(value: &[u8], out: &mut [u8; 64]) -> Option<usize> {
    let (negative, body) = match value.split_first() {
        Some((b'-', rest)) => (true, rest),
        _ => (false, value),
    };
    let dot = body.iter().position(|b| *b == b'.')?;
    let (int, frac) = (&body[..dot], &body[dot + 1..]);
    if int.is_empty() || frac.is_empty() || int.len() >= SIGNIFICANT || !int.iter().chain(frac).all(u8::is_ascii_digit) {
        return None;
    }
    let int_significant = if int.iter().all(|d| *d == b'0') { 0 } else { int.len() };
    let leading = if int_significant == 0 { frac.iter().take_while(|d| **d == b'0').count() } else { 0 };
    if int_significant == 0 && (leading == frac.len() || leading >= SIGNIFICANT) {
        out[..3].copy_from_slice(b"0.0"); // zero, or below 1e-12
        return Some(3);
    }
    let keep = leading + SIGNIFICANT - int_significant;
    if frac.len() <= keep {
        out[..value.len().min(64)].copy_from_slice(&value[..value.len().min(64)]);
        return (value.len() <= 64).then_some(value.len());
    }
    // Digits as numbers, with room for one carry digit in front.
    let mut digits = [0u8; 48];
    let count = int.len() + keep;
    for (slot, d) in digits[1..=count].iter_mut().zip(int.iter().chain(&frac[..keep])) {
        *slot = d - b'0';
    }
    let mut first = 1;
    if frac[keep] >= b'5' {
        let mut i = count;
        loop {
            if i == 0 {
                digits[0] = 1;
                first = 0;
                break;
            }
            if digits[i] == 9 {
                digits[i] = 0;
                i -= 1;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let int_end = 1 + int.len();
    let mut end = count + 1;
    while end > int_end + 1 && digits[end - 1] == 0 {
        end -= 1;
    }
    let mut len = 0;
    let nonzero = digits[first..end].iter().any(|d| *d != 0);
    if negative && nonzero {
        out[len] = b'-';
        len += 1;
    }
    for d in &digits[first..int_end] {
        out[len] = d + b'0';
        len += 1;
    }
    out[len] = b'.';
    len += 1;
    for d in &digits[int_end..end] {
        out[len] = d + b'0';
        len += 1;
    }
    Some(len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(value: &str) -> String {
        let mut out = [0u8; 64];
        match round_decimal(value.as_bytes(), &mut out) {
            Some(len) => String::from_utf8(out[..len].to_vec()).unwrap(),
            None => "-".into(),
        }
    }

    #[test]
    fn rounding() {
        assert_eq!(round("1234.5678901234567"), "1234.56789012");
        assert_eq!(round("-1234.5678901234567"), "-1234.56789012");
        assert_eq!(round("0.30000000000000004"), "0.3");
        assert_eq!(round("0.000123456789012345678"), "0.000123456789012");
        assert_eq!(round("999.9999999999999"), "1000.0");
        assert_eq!(round("0.99999999999999994"), "1.0");
        assert_eq!(round("-0.0000000000000123"), "0.0");
        assert_eq!(round("15.0"), "15.0");
        assert_eq!(round("2.5"), "2.5");
        assert_eq!(round("123456789012.5"), "-");
        assert_eq!(round("1e-16"), "-");
    }

    #[test]
    fn compact_stream() {
        let mut sink = DxfSink::new(true);
        // Split writes in odd places, as a writer may do.
        for part in ["  0\r\nLI", "NE\r\n  8\r\n0\r\n 10\r\n1.2345678901234567\r\n 20\r\n2.0\r\n 70\r\n     1\r\n", "1040\r\n1.2246467991473532e-16\r\n  0\r\nEOF\r\n"] {
            sink.write_all(part.as_bytes()).unwrap();
        }
        let out = String::from_utf8(sink.finish().to_vec()).unwrap();
        assert_eq!(out, "0\nLINE\n8\n0\n10\n1.23456789012\n20\n2.0\n70\n1\n1040\n0.0\n0\nEOF\n");
    }

    #[test]
    fn geometry_sections_drop_defaults_and_xdata() {
        let mut sink = DxfSink::new(true);
        let input = "  0\r\nSECTION\r\n  2\r\nENTITIES\r\n  0\r\nLWPOLYLINE\r\n 10\r\n1.0\r\n 40\r\n0.0\r\n 42\r\n0.5\r\n\
                     1001\r\nAPP\r\n1000\r\nx\r\n  0\r\nDIMENSION\r\n1001\r\nACAD\r\n  0\r\nENDSEC\r\n\
                     \x20 0\r\nSECTION\r\n  2\r\nTABLES\r\n  0\r\nLAYER\r\n1001\r\nAPP\r\n  0\r\nEOF\r\n";
        sink.write_all(input.as_bytes()).unwrap();
        let out = String::from_utf8(sink.finish().to_vec()).unwrap();
        assert_eq!(
            out,
            "0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n10\n1.0\n42\n0.5\n0\nDIMENSION\n1001\nACAD\n0\nENDSEC\n\
             0\nSECTION\n2\nTABLES\n0\nLAYER\n1001\nAPP\n0\nEOF\n"
        );
    }
}
