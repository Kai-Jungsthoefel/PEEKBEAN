// SPDX-License-Identifier: GPL-3.0-or-later
// Mind map layout: the central topic in the middle, first-level topics to its right and left (or one side for logic
// charts), each subtree stacked vertically and centered on its parent. Positions are top-left corners in map units
// (CSS pixels at zoom 1), the central topic centered on the origin.
import type { MindSheet, MindTopic } from './model';

export interface Placed {
  topic: MindTopic;
  depth: number;
  /** First-level branch the topic belongs to, for its color; -1 for the central topic. */
  branch: number;
  side: 1 | -1;
  x: number;
  y: number;
  w: number;
  h: number;
  parent?: Placed;
}

const ROOT_GAP = 54;
const GAP = 34;
const SIBLING_GAP = 8;
const BRANCH_GAP = 20;

export function layoutSheet(sheet: MindSheet, size: (topic: MindTopic) => { w: number; h: number }, open: (topic: MindTopic) => boolean): Placed[] {
  const placed: Placed[] = [];
  const memo = new Map<MindTopic, number>();
  const shown = (topic: MindTopic) => (open(topic) ? topic.children : []);
  const gap = (depth: number) => (depth <= 1 ? BRANCH_GAP : SIBLING_GAP);
  const subtree = (topic: MindTopic, depth: number): number => {
    const known = memo.get(topic);
    if (known !== undefined) return known;
    const children = shown(topic);
    const block = children.reduce((sum, c) => sum + subtree(c, depth + 1), 0) + Math.max(0, children.length - 1) * gap(depth + 1);
    const height = Math.max(size(topic).h, block);
    memo.set(topic, height);
    return height;
  };
  const place = (children: MindTopic[], parent: Placed, side: 1 | -1, edge: number, centerY: number, depth: number, branch: (i: number) => number) => {
    const total = children.reduce((sum, c) => sum + subtree(c, depth), 0) + Math.max(0, children.length - 1) * gap(depth);
    let y = centerY - total / 2;
    children.forEach((topic, i) => {
      const { w, h } = size(topic);
      const height = subtree(topic, depth);
      const cy = y + height / 2;
      const node: Placed = { topic, depth, branch: branch(i), side, x: side > 0 ? edge : edge - w, y: cy - h / 2, w, h, parent };
      placed.push(node);
      place(shown(topic), node, side, side > 0 ? node.x + w + GAP : node.x - GAP, cy, depth + 1, () => node.branch);
      y += height + gap(depth);
    });
  };

  const { w, h } = size(sheet.root);
  const root: Placed = { topic: sheet.root, depth: 0, branch: -1, side: 1, x: -w / 2, y: -h / 2, w, h };
  placed.push(root);
  const first = shown(sheet.root).map((topic, index) => ({ topic, index }));
  let right = first;
  let left: typeof first = [];
  if (sheet.layout === 'left') [right, left] = [[], first];
  else if (sheet.layout === 'map') {
    if (first.some((f) => f.topic.side)) {
      right = first.filter((f) => f.topic.side !== 'left');
      left = first.filter((f) => f.topic.side === 'left');
    } else {
      // Balanced like XMind: the first half on the right, the rest on the left, going round clockwise.
      const half = Math.ceil(first.length / 2);
      right = first.slice(0, half);
      left = first.slice(half).reverse();
    }
  }
  place(right.map((f) => f.topic), root, 1, w / 2 + ROOT_GAP, 0, 1, (i) => right[i].index);
  place(left.map((f) => f.topic), root, -1, -w / 2 - ROOT_GAP, 0, 1, (i) => left[i].index);

  // Floating topics at their stored place, or stacked below the map.
  let below = Math.max(...placed.map((p) => p.y + p.h)) + 60;
  sheet.floating.forEach((topic, i) => {
    const size0 = size(topic);
    const height = subtree(topic, 1);
    const x = topic.position ? topic.position.x - size0.w / 2 : -size0.w / 2;
    const cy = topic.position ? topic.position.y : below + height / 2;
    if (!topic.position) below += height + 40;
    const node: Placed = { topic, depth: 1, branch: first.length + i, side: 1, x, y: cy - size0.h / 2, w: size0.w, h: size0.h };
    placed.push(node);
    place(shown(topic), node, 1, x + size0.w + GAP, cy, 2, () => node.branch);
  });
  return placed;
}

/** The connector from a parent to a child: a smooth curve from the parent's side to the child's near side. */
export function connector(parent: Placed, child: Placed): string {
  const side = child.side;
  const from = parent.depth === 0 ? { x: parent.x + parent.w / 2 + (side * parent.w) / 2.6, y: parent.y + parent.h / 2 } : { x: side > 0 ? parent.x + parent.w : parent.x, y: parent.y + parent.h / 2 };
  const to = { x: side > 0 ? child.x : child.x + child.w, y: child.y + child.h / 2 };
  const bend = (to.x - from.x) * 0.5;
  return `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${(from.x + bend).toFixed(1)},${from.y.toFixed(1)} ${(to.x - bend).toFixed(1)},${to.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
}
