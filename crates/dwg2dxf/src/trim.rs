// SPDX-License-Identifier: GPL-3.0-or-later
//! Leaves out what a DXF viewer never draws, to keep the DXF small: all non-graphical objects (the OBJECTS section:
//! dictionaries, extension data, styles, layouts, …), block definitions that no INSERT or DIMENSION in model space
//! or the active paper space uses (directly or nested), other paper-space layouts, and block preview images.

use std::collections::HashSet;

use acadrust::{CadDocument, EntityType};

pub fn trim_for_display(doc: &mut CadDocument) {
    doc.objects.clear();

    let key = |name: &str| name.to_uppercase();
    let mut reachable: HashSet<String> = HashSet::new();
    let mut queue = vec![key("*Model_Space"), key("*Paper_Space")];
    while let Some(name) = queue.pop() {
        if !reachable.insert(name.clone()) {
            continue;
        }
        let Some(block) = doc.block_records.get(&name) else { continue };
        for handle in &block.entity_handles {
            match doc.get_entity(*handle) {
                Some(EntityType::Insert(insert)) => queue.push(key(&insert.block_name)),
                Some(EntityType::Dimension(dimension)) => queue.push(key(&dimension.base().block_name)),
                Some(EntityType::Table(table)) => queue.push(key(&table.block_name)),
                _ => {}
            }
        }
    }
    let unused: Vec<String> =
        doc.block_records.iter().filter(|b| !reachable.contains(&key(&b.name))).map(|b| b.name.clone()).collect();
    for name in unused {
        let Some(block) = doc.block_records.remove(&name) else { continue };
        for handle in &block.entity_handles {
            doc.remove_entity_arc(*handle);
        }
        doc.remove_entity_arc(block.block_entity_handle);
        doc.remove_entity_arc(block.block_end_handle);
    }
    for block in doc.block_records.iter_mut() {
        block.preview_data.clear();
    }
}
