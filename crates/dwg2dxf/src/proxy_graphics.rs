// SPDX-License-Identifier: GPL-3.0-or-later
//! Reads the proxy graphics ("graphic metafile") that custom entities such as AutoCAD Architecture walls carry as a
//! cached picture of themselves, and turns it into simple shapes.
//!
//! Format: `u32 total size, u32 record count`, then records of `u32 size, u32 type, payload`. Everything is little
//! endian; points are three f64. Handled record types:
//! - geometry: 2 circle, 3 circle through 3 points, 4 circular arc, 5 arc through 3 points, 6 polyline, 7 polygon,
//!   8 mesh (as grid lines), 9 shell (as face edges), 10 text, 11 text with style, 32 polyline with normal,
//!   33 lightweight polyline, 36 Unicode text, 38 Unicode text with style;
//! - traits: 14 color, 22 true color; 29/30 push transformation matrix, 31 pop.
//!
//! Everything else (extents, xlines, rays, layer/linetype/lineweight/fill traits, clipping, materials) is skipped.
//! All reads are bounds-checked and every allocation is proportional to the input or capped by [`Budget`].

use acadrust::types::Vector3;
use acadrust::Color;

/// A shape in the coordinate system of the entity's owner (world or block coordinates).
#[derive(Debug, Clone)]
pub enum Shape {
    Polyline { points: Vec<Vector3>, closed: bool },
    Circle { center: Vector3, radius: f64, normal: Vector3 },
    /// Counter-clockwise around `normal`, from the direction `start` through `sweep` radians.
    Arc { center: Vector3, radius: f64, normal: Vector3, start: Vector3, sweep: f64 },
    Text { position: Vector3, direction: Vector3, height: f64, width_factor: f64, oblique: f64, value: String },
}

#[derive(Debug, Clone)]
pub struct Primitive {
    pub shape: Shape,
    /// Color set by a trait record; `None` means the color of the entity itself.
    pub color: Option<Color>,
}

/// Limits shared by all entities of a drawing, so a corrupt or huge file cannot blow up the output.
pub struct Budget {
    pub primitives: usize,
    pub points: usize,
    pub exhausted: bool,
}

impl Budget {
    pub fn new(primitives: usize, points: usize) -> Self {
        Self { primitives, points, exhausted: false }
    }

    fn take(&mut self, points: usize) -> bool {
        if self.exhausted || self.primitives == 0 || self.points < points {
            self.exhausted = true;
            return false;
        }
        self.primitives -= 1;
        self.points -= points;
        true
    }
}

const MAX_MATRIX_DEPTH: usize = 64;
const MAX_TEXT_UNITS: usize = 4096;

/// Decodes a proxy-graphics blob. Returns `None` if the blob is not a well-formed metafile; unknown or malformed
/// records inside a well-formed one are skipped.
pub fn decode(data: &[u8], budget: &mut Budget) -> Option<Vec<Primitive>> {
    let total = read_u32(data, 0)? as usize;
    let count = read_u32(data, 4)? as usize;
    if total < 8 || total > data.len() {
        return None;
    }
    let mut state = State { out: Vec::new(), color: None, matrices: Vec::new(), matrix: Matrix::IDENTITY };
    let mut offset = 8usize;
    for _ in 0..count {
        let size = read_u32(data, offset)? as usize;
        let kind = read_u32(data, offset + 4)?;
        let end = offset.checked_add(size)?;
        if size < 8 || end > total {
            return None;
        }
        state.record(kind, &data[offset + 8..end], budget);
        offset = end;
        if budget.exhausted {
            break;
        }
    }
    Some(state.out)
}

struct State {
    out: Vec<Primitive>,
    color: Option<Color>,
    matrices: Vec<Matrix>,
    matrix: Matrix,
}

impl State {
    fn record(&mut self, kind: u32, p: &[u8], budget: &mut Budget) {
        match kind {
            2 => {
                if let (Some(center), Some(radius), Some(normal)) = (read_point(p, 0), read_f64(p, 24), read_point(p, 32)) {
                    self.circle(center, radius, normal, budget);
                }
            }
            3 => {
                if let (Some(a), Some(b), Some(c)) = (read_point(p, 0), read_point(p, 24), read_point(p, 48)) {
                    if let Some((center, radius, normal)) = circle_through(a, b, c) {
                        self.circle(center, radius, normal, budget);
                    }
                }
            }
            4 => {
                let (Some(center), Some(radius), Some(normal), Some(start), Some(sweep)) =
                    (read_point(p, 0), read_f64(p, 24), read_point(p, 32), read_point(p, 56), read_f64(p, 80))
                else {
                    return;
                };
                let arc_type = read_u32(p, 88).unwrap_or(0);
                self.arc(center, radius, normal, start, sweep, arc_type, budget);
            }
            5 => {
                let (Some(a), Some(b), Some(c)) = (read_point(p, 0), read_point(p, 24), read_point(p, 48)) else {
                    return;
                };
                let arc_type = read_u32(p, 72).unwrap_or(0);
                if let Some((center, radius, normal)) = circle_through(a, b, c) {
                    let start = a - center;
                    let sweep = angle_around(start, c - center, normal);
                    self.arc(center, radius, normal, start, sweep, arc_type, budget);
                }
            }
            6 | 7 | 32 => {
                if let Some(points) = read_points(p) {
                    self.polyline(points, kind == 7, budget);
                }
            }
            8 => self.mesh(p, budget),
            9 => self.shell(p, budget),
            10 | 11 | 36 | 38 => self.text(kind, p, budget),
            33 => {
                if let Some(points) = lwpolyline(p) {
                    let (points, closed) = points;
                    self.polyline(points, closed, budget);
                }
            }
            14 => {
                if let Some(index) = read_u32(p, 0) {
                    self.color = match index {
                        0 => None, // ByBlock: the entity's own color
                        256 => Some(Color::ByLayer),
                        1..=255 => Some(Color::Index(index as u8)),
                        _ => self.color.clone(),
                    };
                }
            }
            22 => {
                if let Some(value) = read_u32(p, 0) {
                    self.color = match value >> 24 {
                        0xC0 => Some(Color::ByLayer),
                        0xC1 => None,
                        0xC2 => Some(Color::from_rgb((value >> 16) as u8, (value >> 8) as u8, value as u8)),
                        0xC3 if (1..=255).contains(&(value & 0xFF)) => Some(Color::Index((value & 0xFF) as u8)),
                        _ => self.color.clone(),
                    };
                }
            }
            29 | 30 => {
                if let Some(m) = Matrix::read(p) {
                    if self.matrices.len() < MAX_MATRIX_DEPTH {
                        self.matrices.push(self.matrix);
                        self.matrix = self.matrix.then(&m);
                    }
                }
            }
            31 => {
                if let Some(m) = self.matrices.pop() {
                    self.matrix = m;
                }
            }
            _ => {}
        }
    }

    fn push(&mut self, shape: Shape, points: usize, budget: &mut Budget) {
        if budget.take(points) {
            self.out.push(Primitive { shape, color: self.color.clone() });
        }
    }

    fn polyline(&mut self, points: Vec<Vector3>, closed: bool, budget: &mut Budget) {
        if points.len() < 2 {
            return;
        }
        let points: Vec<Vector3> = points.into_iter().map(|q| self.matrix.point(q)).collect();
        if points.iter().all(|q| finite(*q)) {
            let n = points.len();
            self.push(Shape::Polyline { points, closed }, n, budget);
        }
    }

    fn circle(&mut self, center: Vector3, radius: f64, normal: Vector3, budget: &mut Budget) {
        if !(radius > 0.0) || !radius.is_finite() || !(normal.length() > 0.0) {
            return;
        }
        match self.matrix.similarity() {
            Some((scale, sign)) => {
                let center = self.matrix.point(center);
                let normal = (self.matrix.vector(normal) * sign).normalize();
                if finite(center) && finite(normal) {
                    self.push(Shape::Circle { center, radius: radius * scale, normal }, 1, budget);
                }
            }
            None => {
                let points = tessellate(center, radius, normal, any_perpendicular(normal), std::f64::consts::TAU);
                self.polyline(points, true, budget);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn arc(&mut self, center: Vector3, radius: f64, normal: Vector3, start: Vector3, sweep: f64, arc_type: u32, budget: &mut Budget) {
        if !(radius > 0.0) || !radius.is_finite() || !sweep.is_finite() || sweep == 0.0 || !(start.length() > 0.0) || !(normal.length() > 0.0) {
            return;
        }
        let sweep = sweep.clamp(-std::f64::consts::TAU, std::f64::consts::TAU);
        // Normalize to a counter-clockwise sweep.
        let (normal, sweep) = if sweep < 0.0 { (normal * -1.0, -sweep) } else { (normal, sweep) };
        let start_dir = start.normalize();
        let end_dir = rotate(start_dir, normal.normalize(), sweep);
        let (start_point, end_point) = (center + start_dir * radius, center + end_dir * radius);
        match self.matrix.similarity() {
            Some((scale, sign)) => {
                let c = self.matrix.point(center);
                let n = (self.matrix.vector(normal) * sign).normalize();
                let s = self.matrix.vector(start_dir);
                if finite(c) && finite(n) && finite(s) {
                    self.push(Shape::Arc { center: c, radius: radius * scale, normal: n, start: s, sweep }, 1, budget);
                }
            }
            None => {
                let points = tessellate(center, radius, normal, start_dir, sweep);
                self.polyline(points, false, budget);
            }
        }
        match arc_type {
            1 => {
                self.polyline(vec![center, start_point], false, budget);
                self.polyline(vec![center, end_point], false, budget);
            }
            2 => self.polyline(vec![start_point, end_point], false, budget),
            _ => {}
        }
    }

    fn mesh(&mut self, p: &[u8], budget: &mut Budget) {
        let (Some(rows), Some(columns)) = (read_u32(p, 0), read_u32(p, 4)) else { return };
        let (rows, columns) = (rows as usize, columns as usize);
        let Some(count) = rows.checked_mul(columns) else { return };
        if (rows < 2 && columns < 2) || count.checked_mul(24).and_then(|n| n.checked_add(8)).is_none_or(|n| n > p.len()) {
            return;
        }
        let Some(vertices) = (0..count).map(|i| read_point(p, 8 + i * 24)).collect::<Option<Vec<_>>>() else { return };
        for r in 0..rows {
            self.polyline(vertices[r * columns..(r + 1) * columns].to_vec(), false, budget);
        }
        for c in 0..columns {
            self.polyline((0..rows).map(|r| vertices[r * columns + c]).collect(), false, budget);
        }
    }

    fn shell(&mut self, p: &[u8], budget: &mut Budget) {
        let Some(count) = read_u32(p, 0).map(|n| n as usize) else { return };
        if count.checked_mul(24).and_then(|n| n.checked_add(8)).is_none_or(|n| n > p.len()) {
            return;
        }
        let Some(vertices) = (0..count).map(|i| read_point(p, 4 + i * 24)).collect::<Option<Vec<_>>>() else { return };
        let mut offset = 4 + count * 24;
        let Some(entries) = read_u32(p, offset).map(|n| n as usize) else { return };
        offset += 4;
        let mut read = 0usize;
        let mut edges = std::collections::HashSet::new();
        while read < entries {
            let Some(n) = read_i32(p, offset) else { break };
            let n = n.unsigned_abs() as usize;
            offset += 4;
            read = read.saturating_add(n).saturating_add(1);
            let end = n.checked_mul(4).and_then(|bytes| offset.checked_add(bytes));
            if n == 0 || end.is_none_or(|end| end > p.len()) {
                break;
            }
            let face: Vec<usize> = (0..n).filter_map(|k| read_u32(p, offset + k * 4).map(|i| i as usize)).collect();
            offset += n * 4;
            for k in 0..face.len() {
                let (a, b) = (face[k], face[(k + 1) % face.len()]);
                if a < vertices.len() && b < vertices.len() && a != b {
                    edges.insert((a.min(b), a.max(b)));
                }
            }
        }
        let mut edges: Vec<_> = edges.into_iter().collect();
        edges.sort_unstable();
        for (a, b) in edges {
            self.polyline(vec![vertices[a], vertices[b]], false, budget);
        }
    }

    fn text(&mut self, kind: u32, p: &[u8], budget: &mut Budget) {
        let (Some(position), Some(_normal), Some(direction)) = (read_point(p, 0), read_point(p, 24), read_point(p, 48)) else {
            return;
        };
        let unicode = kind == 36 || kind == 38;
        let (value, height, width_factor, oblique) = if kind == 10 || kind == 36 {
            let (Some(h), Some(w), Some(o)) = (read_f64(p, 72), read_f64(p, 80), read_f64(p, 88)) else { return };
            let Some((value, _)) = read_string(p, 96, unicode) else { return };
            (value, h, w, o)
        } else {
            // Text2: string, two longs (length, raw flag), height, width factor, oblique, tracking, flags, fonts.
            let Some((value, next)) = read_string(p, 72, unicode) else { return };
            let (Some(h), Some(w), Some(o)) = (read_f64(p, next + 8), read_f64(p, next + 16), read_f64(p, next + 24)) else {
                return;
            };
            (value, h, w, o)
        };
        let value = value.trim_end_matches('\0').to_string();
        if value.trim().is_empty() || !(height > 0.0) {
            return;
        }
        let scale = self.matrix.similarity().map(|(s, _)| s).unwrap_or_else(|| self.matrix.vector(Vector3::UNIT_Y).length());
        let position = self.matrix.point(position);
        let direction = self.matrix.vector(if direction.length() > 0.0 { direction } else { Vector3::UNIT_X });
        if finite(position) && finite(direction) && (height * scale).is_finite() {
            let width_factor = if width_factor > 0.0 && width_factor.is_finite() { width_factor } else { 1.0 };
            let oblique = if oblique.is_finite() { oblique } else { 0.0 };
            self.push(Shape::Text { position, direction, height: height * scale, width_factor, oblique, value }, 1, budget);
        }
    }
}

// ---- Geometry helpers ---------------------------------------------------------------------------------------

fn finite(v: Vector3) -> bool {
    v.x.is_finite() && v.y.is_finite() && v.z.is_finite()
}

/// Rotates `v` around the unit axis `axis` by `angle` radians (Rodrigues).
fn rotate(v: Vector3, axis: Vector3, angle: f64) -> Vector3 {
    let (s, c) = angle.sin_cos();
    v * c + axis.cross(&v) * s + axis * (axis.dot(&v) * (1.0 - c))
}

fn any_perpendicular(normal: Vector3) -> Vector3 {
    let n = normal.normalize();
    let helper = if n.x.abs() < 0.9 { Vector3::UNIT_X } else { Vector3::UNIT_Y };
    n.cross(&helper).normalize()
}

/// Counter-clockwise angle from `from` to `to` around `normal`, in [0, 2π).
fn angle_around(from: Vector3, to: Vector3, normal: Vector3) -> f64 {
    let n = normal.normalize();
    let angle = n.cross(&from).dot(&to).atan2(from.dot(&to));
    if angle < 0.0 { angle + std::f64::consts::TAU } else { angle }
}

/// Points along an arc, at most 64 segments per full turn.
pub fn tessellate(center: Vector3, radius: f64, normal: Vector3, start: Vector3, sweep: f64) -> Vec<Vector3> {
    let n = normal.normalize();
    let u = start.normalize();
    let segments = ((sweep.abs() / std::f64::consts::TAU * 64.0).ceil() as usize).clamp(4, 64);
    (0..=segments).map(|i| center + rotate(u, n, sweep * i as f64 / segments as f64) * radius).collect()
}

fn circle_through(a: Vector3, b: Vector3, c: Vector3) -> Option<(Vector3, f64, Vector3)> {
    let (ab, ac) = (b - a, c - a);
    let normal = ab.cross(&ac);
    let n2 = normal.length_squared();
    if !(n2 > 1e-20) {
        return None;
    }
    let center = a + (normal.cross(&ab) * ac.length_squared() + ac.cross(&normal) * ab.length_squared()) / (2.0 * n2);
    let radius = (a - center).length();
    (finite(center) && radius.is_finite() && radius > 0.0).then(|| (center, radius, normal.normalize()))
}

/// Column-vector 4x4 matrix, row-major storage.
#[derive(Clone, Copy)]
struct Matrix([[f64; 4]; 4]);

impl Matrix {
    const IDENTITY: Matrix = Matrix([[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]);

    fn read(p: &[u8]) -> Option<Matrix> {
        let mut m = [[0.0; 4]; 4];
        for (i, value) in m.iter_mut().flatten().enumerate() {
            *value = read_f64(p, i * 8)?;
        }
        // Translation is expected in the last column. Some writers store the transpose; detect it by its bottom row.
        let bottom_is_affine = m[3][0].abs() < 1e-12 && m[3][1].abs() < 1e-12 && m[3][2].abs() < 1e-12;
        let right_is_affine = m[0][3].abs() < 1e-12 && m[1][3].abs() < 1e-12 && m[2][3].abs() < 1e-12;
        if !bottom_is_affine && right_is_affine {
            let t = m;
            for (r, row) in m.iter_mut().enumerate() {
                for (c, value) in row.iter_mut().enumerate() {
                    *value = t[c][r];
                }
            }
        }
        if (m[3][3] - 1.0).abs() > 1e-9 || m[3][0].abs() > 1e-9 || m[3][1].abs() > 1e-9 || m[3][2].abs() > 1e-9 {
            return None; // projective transforms are not used for 2D display
        }
        Some(Matrix(m))
    }

    /// `self * other`: `other` is applied first.
    fn then(&self, other: &Matrix) -> Matrix {
        let mut r = [[0.0; 4]; 4];
        for (i, row) in r.iter_mut().enumerate() {
            for (j, value) in row.iter_mut().enumerate() {
                *value = (0..4).map(|k| self.0[i][k] * other.0[k][j]).sum();
            }
        }
        Matrix(r)
    }

    fn point(&self, p: Vector3) -> Vector3 {
        let m = &self.0;
        Vector3::new(
            m[0][0] * p.x + m[0][1] * p.y + m[0][2] * p.z + m[0][3],
            m[1][0] * p.x + m[1][1] * p.y + m[1][2] * p.z + m[1][3],
            m[2][0] * p.x + m[2][1] * p.y + m[2][2] * p.z + m[2][3],
        )
    }

    fn vector(&self, v: Vector3) -> Vector3 {
        let m = &self.0;
        Vector3::new(
            m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
            m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
            m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
        )
    }

    /// Uniform scale and orientation sign (1 or -1 for a mirror) if the matrix is a similarity transform.
    fn similarity(&self) -> Option<(f64, f64)> {
        let (x, y, z) = (self.vector(Vector3::UNIT_X), self.vector(Vector3::UNIT_Y), self.vector(Vector3::UNIT_Z));
        let s = x.length();
        let tolerance = 1e-9 * s.max(1.0);
        if !(s > 0.0)
            || (y.length() - s).abs() > tolerance
            || (z.length() - s).abs() > tolerance
            || x.dot(&y).abs() > tolerance * s
            || x.dot(&z).abs() > tolerance * s
            || y.dot(&z).abs() > tolerance * s
        {
            return None;
        }
        Some((s, if x.cross(&y).dot(&z) < 0.0 { -1.0 } else { 1.0 }))
    }
}

// ---- Byte readers -------------------------------------------------------------------------------------------

fn read_u32(p: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(p.get(offset..offset.checked_add(4)?)?.try_into().ok()?))
}

fn read_i32(p: &[u8], offset: usize) -> Option<i32> {
    read_u32(p, offset).map(|v| v as i32)
}

fn read_f64(p: &[u8], offset: usize) -> Option<f64> {
    let value = f64::from_le_bytes(p.get(offset..offset.checked_add(8)?)?.try_into().ok()?);
    value.is_finite().then_some(value)
}

fn read_point(p: &[u8], offset: usize) -> Option<Vector3> {
    Some(Vector3::new(read_f64(p, offset)?, read_f64(p, offset + 8)?, read_f64(p, offset + 16)?))
}

/// `u32 count`, then `count` points.
fn read_points(p: &[u8]) -> Option<Vec<Vector3>> {
    let count = read_u32(p, 0)? as usize;
    if count < 2 || count.checked_mul(24)?.checked_add(4)? > p.len() {
        return None;
    }
    (0..count).map(|i| read_point(p, 4 + i * 24)).collect()
}

/// Zero-terminated string padded to 4 bytes; returns the text and the offset after the padding.
fn read_string(p: &[u8], offset: usize, unicode: bool) -> Option<(String, usize)> {
    let tail = p.get(offset..)?;
    if unicode {
        let units: Vec<u16> = tail.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take(MAX_TEXT_UNITS).take_while(|u| *u != 0).collect();
        let used = (units.len() + 1) * 2;
        Some((String::from_utf16_lossy(&units), offset + used.div_ceil(4) * 4))
    } else {
        let bytes: Vec<u8> = tail.iter().copied().take(MAX_TEXT_UNITS).take_while(|b| *b != 0).collect();
        let used = bytes.len() + 1;
        let (text, _, _) = encoding_rs::WINDOWS_1252.decode(&bytes);
        Some((text.into_owned(), offset + used.div_ceil(4) * 4))
    }
}

// ---- Record type 33: lightweight polyline in DWG bit coding -------------------------------------------------

/// Reads an LWPOLYLINE record: `u32 byte count`, then the entity data as stored in a DWG (R2000+ coding).
/// Returns the vertices (bulges are ignored, arcs segments become straight) and the closed flag.
fn lwpolyline(p: &[u8]) -> Option<(Vec<Vector3>, bool)> {
    let declared = read_u32(p, 0)? as usize;
    let body = match declared.checked_add(4) {
        Some(end) if declared > 0 && end <= p.len() => &p[4..end],
        _ => p,
    };
    let mut r = BitReader { data: body, bit: 0 };
    let flags = r.bit_short()?;
    if flags & 4 != 0 {
        r.bit_double()?; // constant width
    }
    let elevation = if flags & 8 != 0 { r.bit_double()? } else { 0.0 };
    if flags & 2 != 0 {
        r.bit_double()?; // thickness
    }
    if flags & 1 != 0 {
        for _ in 0..3 {
            r.bit_double()?; // normal: drawn as seen from above
        }
    }
    let count = r.bit_long()? as usize;
    if count < 2 || count > body.len().saturating_mul(4) {
        return None;
    }
    if flags & 16 != 0 {
        r.bit_long()?; // number of bulges
    }
    if flags & 1024 != 0 {
        r.bit_long()?; // number of vertex ids
    }
    if flags & 32 != 0 {
        r.bit_long()?; // number of widths
    }
    let mut points = Vec::with_capacity(count);
    let (mut x, mut y) = (r.raw_double()?, r.raw_double()?);
    points.push(Vector3::new(x, y, elevation));
    for _ in 1..count {
        x = r.default_double(x)?;
        y = r.default_double(y)?;
        points.push(Vector3::new(x, y, elevation));
    }
    points.iter().all(|q| finite(*q)).then_some((points, flags & 512 != 0))
}

struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl BitReader<'_> {
    fn bits(&mut self, count: usize) -> Option<u64> {
        if self.bit.checked_add(count)? > self.data.len().saturating_mul(8) {
            return None;
        }
        let mut value = 0u64;
        for _ in 0..count {
            let byte = self.data[self.bit / 8];
            value = (value << 1) | u64::from((byte >> (7 - self.bit % 8)) & 1);
            self.bit += 1;
        }
        Some(value)
    }

    fn bytes<const N: usize>(&mut self) -> Option<[u8; N]> {
        let mut out = [0u8; N];
        for byte in out.iter_mut() {
            *byte = self.bits(8)? as u8;
        }
        Some(out)
    }

    fn raw_double(&mut self) -> Option<f64> {
        Some(f64::from_le_bytes(self.bytes::<8>()?)).filter(|v| v.is_finite())
    }

    fn bit_short(&mut self) -> Option<u16> {
        match self.bits(2)? {
            0 => Some(u16::from_le_bytes(self.bytes::<2>()?)),
            1 => Some(u16::from(self.bytes::<1>()?[0])),
            2 => Some(0),
            _ => Some(256),
        }
    }

    fn bit_long(&mut self) -> Option<u32> {
        match self.bits(2)? {
            0 => Some(u32::from_le_bytes(self.bytes::<4>()?)),
            1 => Some(u32::from(self.bytes::<1>()?[0])),
            2 => Some(0),
            _ => None,
        }
    }

    fn bit_double(&mut self) -> Option<f64> {
        match self.bits(2)? {
            0 => self.raw_double(),
            1 => Some(1.0),
            2 => Some(0.0),
            _ => None,
        }
    }

    fn default_double(&mut self, default: f64) -> Option<f64> {
        let mut bytes = default.to_le_bytes();
        match self.bits(2)? {
            0 => return Some(default),
            1 => bytes[..4].copy_from_slice(&self.bytes::<4>()?),
            2 => {
                let high = self.bytes::<2>()?;
                bytes[4..6].copy_from_slice(&high);
                bytes[..4].copy_from_slice(&self.bytes::<4>()?);
            }
            _ => return self.raw_double(),
        }
        Some(f64::from_le_bytes(bytes)).filter(|v| v.is_finite())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: u32, payload: &[u8]) -> Vec<u8> {
        let mut r = Vec::new();
        r.extend_from_slice(&((payload.len() + 8) as u32).to_le_bytes());
        r.extend_from_slice(&kind.to_le_bytes());
        r.extend_from_slice(payload);
        r
    }

    fn metafile(records: &[Vec<u8>]) -> Vec<u8> {
        let mut out = vec![0u8; 8];
        out[4..8].copy_from_slice(&(records.len() as u32).to_le_bytes());
        for r in records {
            out.extend_from_slice(r);
        }
        let total = out.len() as u32;
        out[0..4].copy_from_slice(&total.to_le_bytes());
        out
    }

    fn f(values: &[f64]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn translation_matrix_moves_circle() {
        let mut matrix = vec![1.0, 0.0, 0.0, 100.0, 0.0, 1.0, 0.0, 50.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        let push = record(29, &f(&matrix));
        let circle = record(2, &f(&[1.0, 2.0, 0.0, 5.0, 0.0, 0.0, 1.0]));
        let pop = record(31, &[]);
        let data = metafile(&[push, circle.clone(), pop, circle]);
        let shapes = decode(&data, &mut Budget::new(100, 1000)).unwrap();
        let centers: Vec<_> = shapes.iter().map(|p| match p.shape { Shape::Circle { center, .. } => (center.x, center.y), _ => panic!() }).collect();
        assert_eq!(centers, vec![(101.0, 52.0), (1.0, 2.0)]);
        matrix[3] = f64::NAN;
        assert!(Matrix::read(&f(&matrix)).is_none());
    }

    #[test]
    fn corrupt_counts_do_not_allocate() {
        let mut payload = (u32::MAX).to_le_bytes().to_vec();
        payload.extend_from_slice(&f(&[0.0; 6]));
        let data = metafile(&[record(6, &payload), record(9, &payload), record(8, &[255; 16])]);
        assert!(decode(&data, &mut Budget::new(100, 1000)).unwrap().is_empty());
        let mut header = metafile(&[]);
        header[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&header, &mut Budget::new(100, 1000)).is_none());
    }

    #[test]
    fn lightweight_polyline_bits() {
        // flags BS=512 (closed): code 00 + 16 bits; count BL=3: code 01 + 8 bits; first point 2RD; then DD with code 00 (= default)
        // for x of the 2nd point, and full raw doubles (code 11) for the rest.
        let mut bits = String::new();
        let push_bytes = |bits: &mut String, bytes: &[u8]| bytes.iter().for_each(|b| bits.push_str(&format!("{b:08b}")));
        bits.push_str("00");
        push_bytes(&mut bits, &512u16.to_le_bytes());
        bits.push_str("01");
        push_bytes(&mut bits, &[3]);
        push_bytes(&mut bits, &1.0f64.to_le_bytes());
        push_bytes(&mut bits, &2.0f64.to_le_bytes());
        bits.push_str("00"); // x = 1.0 (default)
        bits.push_str("11");
        push_bytes(&mut bits, &7.0f64.to_le_bytes());
        bits.push_str("11");
        push_bytes(&mut bits, &4.0f64.to_le_bytes());
        bits.push_str("11");
        push_bytes(&mut bits, &9.0f64.to_le_bytes());
        while bits.len() % 8 != 0 {
            bits.push('0');
        }
        let body: Vec<u8> = bits.as_bytes().chunks(8).map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 2).unwrap()).collect();
        let mut payload = (body.len() as u32).to_le_bytes().to_vec();
        payload.extend_from_slice(&body);
        let (points, closed) = lwpolyline(&payload).unwrap();
        assert!(closed);
        let xy: Vec<_> = points.iter().map(|p| (p.x, p.y)).collect();
        assert_eq!(xy, vec![(1.0, 2.0), (1.0, 7.0), (4.0, 9.0)]);
    }

    #[test]
    fn arc_through_three_points() {
        let (center, radius, normal) =
            circle_through(Vector3::new(1.0, 0.0, 0.0), Vector3::new(0.0, 1.0, 0.0), Vector3::new(-1.0, 0.0, 0.0)).unwrap();
        assert!(center.length() < 1e-12 && (radius - 1.0).abs() < 1e-12 && (normal.z - 1.0).abs() < 1e-12);
        let sweep = angle_around(Vector3::UNIT_X, Vector3::new(-1.0, 0.0, 0.0), normal);
        assert!((sweep - std::f64::consts::PI).abs() < 1e-12);
    }
}
