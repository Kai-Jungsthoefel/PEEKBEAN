// SPDX-License-Identifier: GPL-3.0-or-later
//! Text adjustments for viewers that ignore MTEXT inline formatting.
//!
//! AutoCAD often sizes a whole MTEXT with an inline height code at the start of its content (`\H2.5;` absolute or
//! `\H0.7x;` relative to the entity height) instead of the entity height. dxf-viewer ignores `\H`, so such texts
//! come out too large or too small. When a single `\H` code at the start applies to the whole text, it is moved
//! into the entity height. Texts that change size in the middle are left as they are.

use acadrust::{CadDocument, EntityType};

/// Moves a whole-text `\H` code into the MTEXT height. Returns the number of texts changed.
pub fn fold_mtext_heights(doc: &mut CadDocument) -> usize {
    let changes: Vec<_> = doc
        .entities()
        .filter_map(|entity| match entity {
            EntityType::MText(text) => fold(&text.value, text.height).map(|(height, value)| (text.common.handle, height, value)),
            _ => None,
        })
        .collect();
    for (handle, height, value) in &changes {
        if let Some(EntityType::MText(text)) = doc.get_entity_mut(*handle) {
            text.height = *height;
            text.value = value.clone();
        }
    }
    changes.len()
}

/// Positions of the inline codes `\X…;` for the letters in `letters`, ignoring escaped backslashes.
fn codes(value: &str, letters: &[u8]) -> Vec<(usize, usize)> {
    let bytes = value.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let letter = bytes[i + 1];
        if letters.contains(&letter) {
            if let Some(end) = value[i + 2..].find(';') {
                found.push((i, i + 2 + end + 1));
                i = i + 2 + end + 1;
                continue;
            }
        }
        i += 2; // skip escaped character or other code letter
    }
    found
}

/// New height and content if `value` starts with a single `\H` code that covers the whole text.
fn fold(value: &str, height: f64) -> Option<(f64, String)> {
    let heights = codes(value, b"H");
    let [(start, end)] = heights.as_slice() else { return None };
    // Only alignment (\A) and paragraph (\p) codes and one opening brace may come before it.
    let mut prefix_end = 0;
    let braced = value.starts_with('{');
    if braced {
        prefix_end = 1;
    }
    for (code_start, code_end) in codes(value, b"Ap") {
        if code_start == prefix_end && code_start < *start {
            prefix_end = code_end;
        }
    }
    if prefix_end != *start {
        return None;
    }
    if braced && closing_brace(value) != Some(value.len() - 1) {
        return None; // the brace group, and with it the height, ends before the text does
    }
    let argument = &value[start + 2..end - 1];
    let (number, relative) = match argument.strip_suffix(['x', 'X']) {
        Some(number) => (number, true),
        None => (argument, false),
    };
    let factor: f64 = number.trim().parse().ok()?;
    let new_height = if relative { height * factor } else { factor };
    if !(new_height > 0.0 && new_height.is_finite()) {
        return None;
    }
    Some((new_height, format!("{}{}", &value[..*start], &value[*end..])))
}

/// Byte index of the brace that closes the one at index 0.
fn closing_brace(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1, // escaped character, e.g. \{ or \}
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::fold;

    #[test]
    fn folds_whole_text_heights() {
        assert_eq!(fold("\\H0.5x;Text", 4.0), Some((2.0, "Text".into())));
        assert_eq!(fold("{\\H2.5;Text}", 100.0), Some((2.5, "{Text}".into())));
        assert_eq!(fold("\\A1;\\H3x;Text", 1.0), Some((3.0, "\\A1;Text".into())));
        assert_eq!(fold("{\\H2;Te}xt", 1.0), None); // height ends early
        assert_eq!(fold("Te\\H2;xt", 1.0), None); // changes in the middle
        assert_eq!(fold("\\H2;A\\H3;B", 1.0), None);
        assert_eq!(fold("\\\\H2;Text", 1.0), None); // escaped backslash, not a code
        assert_eq!(fold("Text", 1.0), None);
    }
}
