// SPDX-License-Identifier: GPL-3.0-or-later
//! Paper-space layouts as drawings of their own, for a viewer that only shows model space.
//!
//! The layout's paper-space entities become the model space of a new document. What each viewport shows is added
//! as a block holding the model-space entities whose bounding box overlaps the viewport's view, inserted with the
//! viewport's scale, twist and position. The view is not clipped: an entity reaching over the viewport border is
//! drawn completely. Viewports that are off, perspective or not looking straight down (3D views) stay empty, and
//! entities on layers frozen in a viewport are left out of it (top-level entities only).

use std::collections::{HashMap, HashSet};

use acadrust::entities::Insert;
use acadrust::objects::ObjectType;
use acadrust::tables::BlockRecord;
use acadrust::types::{Handle, Vector3};
use acadrust::{CadDocument, EntityType};

/// A paper-space layout of the drawing.
#[derive(Clone, Debug)]
pub struct Layout {
    pub name: String,
    block: Handle,
    /// The viewport that shows the paper itself, not part of the model.
    overall_viewport: Option<Handle>,
    tab_order: i16,
}

/// Paper-space layouts in tab order. Needs the layout objects, so call it before objects are removed.
pub fn layouts(doc: &CadDocument) -> Vec<Layout> {
    let model = doc.header.model_space_block_handle;
    let mut list: Vec<Layout> = doc
        .objects
        .values()
        .filter_map(|object| match object {
            ObjectType::Layout(layout) if layout.block_record != model && !layout.name.eq_ignore_ascii_case("Model") => {
                let block = doc.block_records.iter().find(|b| b.handle == layout.block_record)?;
                let viewports: Vec<Handle> = block
                    .entity_handles
                    .iter()
                    .copied()
                    .filter(|h| matches!(doc.get_entity(*h), Some(EntityType::Viewport(_))))
                    .collect();
                let overall = layout
                    .viewports
                    .first()
                    .copied()
                    .into_iter()
                    .chain([layout.viewport])
                    .find(|h| viewports.contains(h))
                    .or_else(|| viewports.first().copied());
                Some(Layout { name: layout.name.clone(), block: block.handle, overall_viewport: overall, tab_order: layout.tab_order })
            }
            _ => None,
        })
        .collect();
    list.sort_by(|a, b| a.tab_order.cmp(&b.tab_order).then_with(|| a.name.cmp(&b.name)));
    list
}

/// A document whose model space shows `layout`.
pub fn layout_document(doc: &CadDocument, layout: &Layout) -> CadDocument {
    let mut out = doc.clone();
    let paper: Vec<Handle> =
        out.block_records.iter().find(|b| b.handle == layout.block).map(|b| b.entity_handles.clone()).unwrap_or_default();
    let model: Vec<Handle> = out.block_records.get("*Model_Space").map(|b| b.entity_handles.clone()).unwrap_or_default();
    let model_handle = out.block_records.get("*Model_Space").map(|b| b.handle).unwrap_or(out.header.model_space_block_handle);
    let layer_names: HashMap<Handle, String> = out.layers.iter().map(|l| (l.handle, l.name.to_uppercase())).collect();

    let mut extents = Extents { doc, blocks: HashMap::new(), depth: 0 };
    let mut boxes: Option<Vec<(Handle, Box2, String)>> = None;
    let mut inserts = Vec::new();
    let mut kept = Vec::new();
    for handle in paper {
        let Some(EntityType::Viewport(viewport)) = doc.get_entity(handle) else {
            kept.push(handle);
            continue;
        };
        if Some(handle) == layout.overall_viewport {
            continue;
        }
        let Some(view) = View::of(viewport) else { continue };
        let window = view.model_window();
        let boxes = boxes.get_or_insert_with(|| {
            model
                .iter()
                .filter_map(|h| {
                    let entity = doc.get_entity(*h)?;
                    let bounds = extents.entity(entity)?;
                    Some((*h, bounds, entity.common().layer.to_uppercase()))
                })
                .collect()
        });
        let frozen: HashSet<&String> = viewport.frozen_layers.iter().filter_map(|h| layer_names.get(h)).collect();
        let content: Vec<Handle> = boxes
            .iter()
            .filter(|(_, bounds, layer)| bounds.intersects(&window) && !frozen.contains(layer))
            .map(|(h, _, _)| *h)
            .collect();
        if content.is_empty() {
            continue;
        }
        let mut name = format!("_VIEWPORT{}", inserts.len() + 1);
        while out.block_records.contains(&name) {
            name.push('_');
        }
        let mut block = BlockRecord::new(name.clone());
        block.handle = out.allocate_handle();
        block.block_entity_handle = out.allocate_handle();
        block.block_end_handle = out.allocate_handle();
        block.entity_handles = content;
        if out.block_records.add(block).is_err() {
            continue;
        }
        let mut insert = Insert::new(name, Vector3::new(view.offset.0, view.offset.1, 0.0))
            .with_uniform_scale(view.scale)
            .with_rotation(view.twist.rem_euclid(std::f64::consts::TAU));
        insert.common.owner_handle = model_handle;
        if let Ok(h) = out.add_entity(EntityType::Insert(insert)) {
            inserts.push(h);
        }
    }

    // Model space now holds the viewport contents, then the layout's own entities on top. Other layouts are emptied,
    // so they and the blocks only they use are left out when the document is trimmed.
    for block in out.block_records.iter_mut() {
        if block.name.to_uppercase().starts_with("*PAPER_SPACE") {
            block.entity_handles.clear();
        } else if block.handle == model_handle {
            block.entity_handles = inserts.iter().chain(&kept).copied().collect();
        }
    }
    out
}

// ---- Viewport view ------------------------------------------------------------------------------------------

/// Maps model space (plan view) to paper space: `paper = scale * rotate(twist, model) + offset`.
struct View {
    scale: f64,
    twist: f64,
    offset: (f64, f64),
    /// Viewport rectangle on paper: center and half size.
    center: (f64, f64),
    half: (f64, f64),
}

impl View {
    fn of(viewport: &acadrust::entities::Viewport) -> Option<View> {
        let direction = viewport.view_direction.normalize();
        if viewport.status.is_off
            || viewport.status.perspective
            || !(viewport.width > 0.0 && viewport.height > 0.0 && viewport.view_height > 0.0)
            || !(direction.z > 1.0 - 1e-6)
        {
            return None;
        }
        let scale = viewport.height / viewport.view_height;
        let twist = viewport.twist_angle;
        let (s, c) = twist.sin_cos();
        let target = viewport.view_target;
        let center = (viewport.center.x, viewport.center.y);
        // paper = center + scale * (rotate(twist, model - target) - view_center)
        let offset = (
            center.0 - scale * (viewport.view_center.x + c * target.x - s * target.y),
            center.1 - scale * (viewport.view_center.y + s * target.x + c * target.y),
        );
        let view = View { scale, twist, offset, center, half: (viewport.width / 2.0, viewport.height / 2.0) };
        [scale, twist, offset.0, offset.1].iter().all(|v| v.is_finite()).then_some(view)
    }

    /// The part of model space the viewport shows, as an axis-aligned box.
    fn model_window(&self) -> Box2 {
        let (s, c) = self.twist.sin_cos();
        let to_model = |x: f64, y: f64| {
            let (x, y) = ((x - self.offset.0) / self.scale, (y - self.offset.1) / self.scale);
            (c * x + s * y, -s * x + c * y)
        };
        let (cx, cy, hx, hy) = (self.center.0, self.center.1, self.half.0, self.half.1);
        Box2::from_points([(cx - hx, cy - hy), (cx + hx, cy - hy), (cx + hx, cy + hy), (cx - hx, cy + hy)].map(|(x, y)| to_model(x, y)))
    }
}

// ---- Extents ------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Box2 {
    min: (f64, f64),
    max: (f64, f64),
}

impl Box2 {
    fn from_points(points: impl IntoIterator<Item = (f64, f64)>) -> Box2 {
        let mut b = Box2 { min: (f64::INFINITY, f64::INFINITY), max: (f64::NEG_INFINITY, f64::NEG_INFINITY) };
        for (x, y) in points {
            b.min = (b.min.0.min(x), b.min.1.min(y));
            b.max = (b.max.0.max(x), b.max.1.max(y));
        }
        b
    }

    fn valid(&self) -> bool {
        [self.min.0, self.min.1, self.max.0, self.max.1].iter().all(|v| v.is_finite()) && self.min.0 <= self.max.0 && self.min.1 <= self.max.1
    }

    fn union(&self, other: &Box2) -> Box2 {
        Box2::from_points([self.min, self.max, other.min, other.max])
    }

    fn corners(&self) -> [(f64, f64); 4] {
        [self.min, (self.max.0, self.min.1), self.max, (self.min.0, self.max.1)]
    }

    fn intersects(&self, other: &Box2) -> bool {
        self.min.0 <= other.max.0 && other.min.0 <= self.max.0 && self.min.1 <= other.max.1 && other.min.1 <= self.max.1
    }
}

const MAX_BLOCK_DEPTH: usize = 32;

struct Extents<'a> {
    doc: &'a CadDocument,
    /// Block extents by upper-case name; `None` while being computed (guards against cycles) or if empty.
    blocks: HashMap<String, Option<Box2>>,
    depth: usize,
}

impl Extents<'_> {
    fn entity(&mut self, entity: &EntityType) -> Option<Box2> {
        let bounds = match entity {
            EntityType::Insert(insert) => return self.insert(insert),
            EntityType::Viewport(_) | EntityType::Block(_) | EntityType::BlockEnd(_) | EntityType::Seqend(_) => return None,
            EntityType::AttributeDefinition(_) => return None, // not drawn in a block reference
            other => other.as_entity().bounding_box(),
        };
        let b = Box2 { min: (bounds.min.x, bounds.min.y), max: (bounds.max.x, bounds.max.y) };
        b.valid().then_some(b)
    }

    fn block(&mut self, name: &str) -> Option<Box2> {
        let key = name.to_uppercase();
        if let Some(cached) = self.blocks.get(&key) {
            return *cached;
        }
        if self.depth >= MAX_BLOCK_DEPTH {
            return None;
        }
        self.blocks.insert(key.clone(), None);
        self.depth += 1;
        let doc = self.doc;
        let mut result: Option<Box2> = None;
        if let Some(block) = doc.block_records.get(name) {
            for handle in &block.entity_handles {
                if let Some(b) = doc.get_entity(*handle).and_then(|e| self.entity(e)) {
                    result = Some(result.map_or(b, |r| r.union(&b)));
                }
            }
        }
        self.depth -= 1;
        self.blocks.insert(key, result);
        result
    }

    fn insert(&mut self, insert: &Insert) -> Option<Box2> {
        let mut bounds = self.block(&insert.block_name);
        let base = self.doc.block_records.get(&insert.block_name).map(|b| b.base_point).unwrap_or(Vector3::ZERO);
        let (sx, sy) = (insert.x_scale(), insert.y_scale());
        let (s, c) = insert.rotation.sin_cos();
        let p = insert.insert_point;
        let place = |(x, y): (f64, f64), (dx, dy): (f64, f64)| {
            let (x, y) = ((x - base.x) * sx + dx, (y - base.y) * sy + dy);
            (p.x + c * x - s * y, p.y + s * x + c * y)
        };
        if let Some(b) = bounds {
            // A MINSERT repeats the block in columns and rows.
            let last = (
                f64::from(insert.column_count.max(1) - 1) * insert.column_spacing,
                f64::from(insert.row_count.max(1) - 1) * insert.row_spacing,
            );
            let corners = b.corners();
            bounds = Some(Box2::from_points(
                corners.iter().map(|q| place(*q, (0.0, 0.0))).chain(corners.iter().map(|q| place(*q, last))),
            ));
        }
        for attribute in &insert.attributes {
            let a = Box2::from_points([(attribute.insertion_point.x, attribute.insertion_point.y)]);
            bounds = Some(bounds.map_or(a, |b| b.union(&a)));
        }
        bounds.filter(Box2::valid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_maps_model_to_paper() {
        let mut viewport = acadrust::entities::Viewport::new();
        viewport.center = Vector3::new(100.0, 50.0, 0.0);
        viewport.width = 80.0;
        viewport.height = 40.0;
        viewport.view_center = Vector3::new(1000.0, 500.0, 0.0);
        viewport.view_height = 4000.0; // 1:100
        viewport.view_direction = Vector3::UNIT_Z;
        viewport.status.is_off = false;
        let view = View::of(&viewport).unwrap();
        assert!((view.scale - 0.01).abs() < 1e-12);
        let paper = |x: f64, y: f64| (view.scale * x + view.offset.0, view.scale * y + view.offset.1);
        assert_eq!(paper(1000.0, 500.0), (100.0, 50.0));
        let window = view.model_window();
        assert!((window.min.0 + 3000.0).abs() < 1e-9 && (window.max.1 - 2500.0).abs() < 1e-9);
    }
}
