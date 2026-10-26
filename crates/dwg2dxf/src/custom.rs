// SPDX-License-Identifier: GPL-3.0-or-later
//! Custom (application-defined) entities and objects that acadrust cannot write to DXF, or that a plain DXF viewer
//! cannot draw, are replaced here by ordinary geometry or removed.
//!
//! - AutoCAD Architecture entities read from a DWG have no DXF form; acadrust refuses to export them. They become
//!   LINE / LWPOLYLINE / POLYLINE / CIRCLE / ARC / TEXT from their proxy graphics, on the entity's layer and with its
//!   color, linetype and lineweight. A wall without proxy graphics becomes its outline. Other Arch entities without
//!   usable graphics are left out.
//! - Optionally the same is done for other custom entities (proxies, unknown classes): DXF viewers do not draw
//!   ACAD_PROXY_ENTITY.
//! - Arch objects (styles, display settings, …) without DXF form are removed, and dictionary entries pointing at them.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use acadrust::classes::arch::{continuous_wall_outline, ArchKind};
use acadrust::entities::{EntityCommon, ExtendedEntityData};
use acadrust::objects::ObjectType;
use acadrust::types::{Handle, Vector2, Vector3};
use acadrust::{Arc, CadDocument, Circle, Color, EntityType, Line, LwPolyline, Text};

use crate::proxy_graphics::{self, tessellate, Budget, Primitive, Shape};

/// What was changed, for the warnings shown to the user.
#[derive(Default, Debug)]
pub struct Report {
    /// Arch entities drawn as plain geometry.
    pub arch_replaced: usize,
    /// Arch entities without anything drawable.
    pub arch_dropped: usize,
    /// Other custom entities drawn as plain geometry.
    pub custom_replaced: usize,
    /// Other custom entities without anything drawable.
    pub custom_dropped: usize,
    /// Arch objects removed.
    pub arch_objects: usize,
    /// Other objects removed because they cannot be written to DXF.
    pub other_objects: usize,
    /// The output limit was reached; some geometry is missing.
    pub truncated: bool,
}

/// At most this many shapes and points are created from proxy graphics for a whole drawing.
const MAX_PRIMITIVES: usize = 2_000_000;
const MAX_POINTS: usize = 20_000_000;

/// Replaces Arch entities without DXF form (and, with `all_custom`, every other custom entity) by plain entities.
pub fn replace_custom_entities(doc: &mut CadDocument, all_custom: bool, report: &mut Report) {
    let mut budget = Budget::new(MAX_PRIMITIVES, MAX_POINTS);
    // handle -> (replacement entities, is Arch)
    let mut replacements: Vec<(Handle, Vec<EntityType>, bool)> = Vec::new();
    for entity in doc.entities() {
        let (arch, graphics, wall_outline) = match entity {
            EntityType::Extended(e) => match &e.data {
                ExtendedEntityData::Arch(data) if data.raw_dxf_codes.is_none() => {
                    let outline = (data.kind == ArchKind::Wall)
                        .then(|| data.straight_wall_geometry())
                        .flatten()
                        .and_then(|g| continuous_wall_outline(&[g.start, g.end], g.width));
                    (true, e.common.graphic_data.as_deref().map(Cow::Borrowed), outline)
                }
                ExtendedEntityData::Proxy(data) if all_custom => {
                    let graphics = match e.common.graphic_data.as_deref() {
                        Some(g) => Some(Cow::Borrowed(g)),
                        None => Some(Cow::<[u8]>::Owned(data.graphics.data())).filter(|g| !g.is_empty()),
                    };
                    (false, graphics, None)
                }
                _ => continue,
            },
            EntityType::Unknown(u) if u.raw_dxf_codes.is_none() => {
                let unwritable = u.common.graphic_data.is_none() && u.raw_dwg_data.is_none();
                if !all_custom && !unwritable {
                    continue; // acadrust writes it as ACAD_PROXY_ENTITY
                }
                (false, u.common.graphic_data.as_deref().map(Cow::Borrowed), None)
            }
            _ => continue,
        };
        let common = entity.common();
        let mut shapes = graphics.and_then(|g: Cow<[u8]>| proxy_graphics::decode(&g, &mut budget)).unwrap_or_default();
        if shapes.is_empty() {
            if let Some(mut outline) = wall_outline {
                outline.pop(); // the outline repeats its first point
                shapes.push(Primitive { shape: Shape::Polyline { points: outline, closed: true }, color: None });
            }
        }
        let entities: Vec<EntityType> = shapes.into_iter().flat_map(|p| to_entities(p, common)).collect();
        replacements.push((common.handle, entities, arch));
    }
    report.truncated |= budget.exhausted;
    if replacements.is_empty() {
        return;
    }

    let mut new_handles: HashMap<Handle, Vec<Handle>> = HashMap::new();
    let mut added: HashSet<Handle> = HashSet::new();
    for (handle, entities, arch) in replacements {
        doc.remove_entity_arc(handle);
        match (entities.is_empty(), arch) {
            (false, true) => report.arch_replaced += 1,
            (true, true) => report.arch_dropped += 1,
            (false, false) => report.custom_replaced += 1,
            (true, false) => report.custom_dropped += 1,
        }
        let mut handles = Vec::with_capacity(entities.len());
        for entity in entities {
            if let Ok(new) = doc.add_entity(entity) {
                handles.push(new);
                added.insert(new);
            }
        }
        new_handles.insert(handle, handles);
    }
    // add_entity appended the new entities at the end of their block; put them where the replaced entity was, so
    // the drawing order stays, and forget the removed handles.
    for block in doc.block_records.iter_mut() {
        if !block.entity_handles.iter().any(|h| new_handles.contains_key(h) || added.contains(h)) {
            continue;
        }
        let old = std::mem::take(&mut block.entity_handles);
        for handle in old {
            if let Some(replacement) = new_handles.get(&handle) {
                block.entity_handles.extend_from_slice(replacement);
            } else if !added.contains(&handle) {
                block.entity_handles.push(handle);
            }
        }
    }
}

/// Removes Arch objects and other objects acadrust cannot write to DXF, plus dictionary entries pointing at them.
pub fn remove_unwritable_objects(doc: &mut CadDocument, report: &mut Report) {
    let mut removed = HashSet::new();
    doc.objects.retain(|handle, object| {
        let keep = match object {
            ObjectType::Arch(arch) if arch.raw_dxf_codes.is_none() => {
                report.arch_objects += 1;
                false
            }
            ObjectType::Unknown { type_name, raw_dxf_codes: None, .. }
                if type_name.to_ascii_uppercase().replace('_', "").contains("ASSOC2DCONSTRAINTGROUP") =>
            {
                report.other_objects += 1;
                false
            }
            _ => true,
        };
        if !keep {
            removed.insert(*handle);
        }
        keep
    });
    remove_dictionary_entries(doc, &removed);
}

/// Drops dictionary entries that point at `removed` handles.
pub fn remove_dictionary_entries(doc: &mut CadDocument, removed: &HashSet<Handle>) {
    if removed.is_empty() {
        return;
    }
    for object in doc.objects.values_mut() {
        match object {
            ObjectType::Dictionary(dictionary) => {
                dictionary.entries.retain(|(_, handle)| !removed.contains(handle));
                let names: HashSet<String> = dictionary.entries.iter().map(|(name, _)| name.clone()).collect();
                dictionary.hard_owner_entries.retain(|name| names.contains(name));
                dictionary.reactors.retain(|handle| !removed.contains(handle));
            }
            ObjectType::DictionaryWithDefault(dictionary) => {
                dictionary.entries.retain(|(_, handle)| !removed.contains(handle));
                if removed.contains(&dictionary.default_handle) {
                    dictionary.default_handle = Handle::NULL;
                }
            }
            _ => {}
        }
    }
}

// ---- Shapes to entities -------------------------------------------------------------------------------------

/// The new entity takes over the replaced entity's layer, color, linetype, lineweight, visibility and owner.
fn common_from(source: &EntityCommon, color: Option<Color>) -> EntityCommon {
    let mut common = EntityCommon::new();
    common.layer = source.layer.clone();
    common.layer_handle = source.layer_handle;
    common.color = color.unwrap_or_else(|| source.color.clone());
    common.line_weight = source.line_weight;
    common.linetype = source.linetype.clone();
    common.linetype_handle = source.linetype_handle;
    common.linetype_scale = source.linetype_scale;
    common.transparency = source.transparency;
    common.invisible = source.invisible;
    common.owner_handle = source.owner_handle;
    common.entity_mode = source.entity_mode;
    common
}

const FLAT: f64 = 1.0 - 1e-9;

fn to_entities(primitive: Primitive, source: &EntityCommon) -> Vec<EntityType> {
    let common = common_from(source, primitive.color);
    match primitive.shape {
        Shape::Polyline { points, closed } => polyline(points, closed, common),
        Shape::Circle { center, radius, normal } => {
            if normal.z.abs() >= FLAT {
                let mut circle = Circle::from_coords(center.x, center.y, center.z, radius);
                circle.common = common;
                vec![EntityType::Circle(circle)]
            } else {
                let start = normal.cross(&if normal.x.abs() < 0.9 { Vector3::UNIT_X } else { Vector3::UNIT_Y });
                let mut points = tessellate(center, radius, normal, start, std::f64::consts::TAU);
                points.pop();
                polyline(points, true, common)
            }
        }
        Shape::Arc { center, radius, normal, start, sweep } => {
            if sweep >= std::f64::consts::TAU - 1e-9 {
                return to_entities(Primitive { shape: Shape::Circle { center, radius, normal }, color: Some(common.color.clone()) }, source);
            }
            if normal.z.abs() >= FLAT {
                let angle = start.y.atan2(start.x);
                // Seen from below (normal -Z) the arc runs clockwise in the XY plane.
                let (from, to) = if normal.z > 0.0 { (angle, angle + sweep) } else { (angle - sweep, angle) };
                let mut arc = Arc::from_coords(center.x, center.y, center.z, radius, normalize_angle(from), normalize_angle(to));
                arc.common = common;
                vec![EntityType::Arc(arc)]
            } else {
                polyline(tessellate(center, radius, normal, start, sweep), false, common)
            }
        }
        Shape::Text { position, direction, height, width_factor, oblique, value } => {
            let mut text = Text::with_value(value, position).with_height(height);
            text.rotation = normalize_angle(direction.y.atan2(direction.x));
            text.width_factor = width_factor;
            text.oblique_angle = oblique;
            text.common = common;
            vec![EntityType::Text(text)]
        }
    }
}

fn normalize_angle(angle: f64) -> f64 {
    angle.rem_euclid(std::f64::consts::TAU)
}

fn polyline(mut points: Vec<Vector3>, mut closed: bool, common: EntityCommon) -> Vec<EntityType> {
    let scale = points.iter().map(|p| p.x.abs().max(p.y.abs()).max(p.z.abs())).fold(1.0, f64::max);
    let same = |a: Vector3, b: Vector3| (a - b).length() <= 1e-12 * scale;
    points.dedup_by(|a, b| same(*a, *b));
    if points.len() > 2 && same(points[0], points[points.len() - 1]) {
        points.pop();
        closed = true;
    }
    match points.len() {
        0 | 1 => Vec::new(),
        2 if !closed => {
            let (a, b) = (points[0], points[1]);
            let mut line = Line::from_coords(a.x, a.y, a.z, b.x, b.y, b.z);
            line.common = common;
            vec![EntityType::Line(line)]
        }
        _ => {
            let z = points[0].z;
            if points.iter().all(|p| (p.z - z).abs() <= 1e-9 * scale) {
                let mut lw = LwPolyline::from_points(points.iter().map(|p| Vector2::new(p.x, p.y)).collect());
                lw.is_closed = closed;
                lw.elevation = z;
                lw.common = common;
                vec![EntityType::LwPolyline(lw)]
            } else {
                let mut poly = acadrust::entities::Polyline3D::from_points(points);
                if closed {
                    poly.close();
                }
                poly.common = common;
                vec![EntityType::Polyline3D(poly)]
            }
        }
    }
}
