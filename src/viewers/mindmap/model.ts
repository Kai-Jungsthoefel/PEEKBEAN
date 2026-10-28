// SPDX-License-Identifier: GPL-3.0-or-later
// One model for all mind map formats (XMind, MindManager, FreeMind/Freeplane): sheets of topic trees, plus floating
// topics and relationships between topics.

export interface MindMarker {
  /** Short text on the badge: "1" for priority 1, "50%" for a task, "" for a plain colored dot. */
  text: string;
  /** Full name for the tooltip and the details panel. */
  title: string;
  /** Index into the branch palette, or -1 for neutral. */
  color: number;
}

export interface MindTopic {
  id: string;
  title: string;
  children: MindTopic[];
  folded?: boolean;
  /** First-level topics may sit left or right of the central topic. */
  side?: 'left' | 'right';
  notes?: string;
  link?: string;
  labels?: string[];
  markers?: MindMarker[];
  /** Object URL of a picture shown in the topic. */
  image?: string;
  /** Key/value attributes (Freeplane) and task data (MindManager). */
  attributes?: [string, string][];
  /** XMind summary topics stand for a range of their siblings. */
  summary?: boolean;
  /** Position of a floating topic relative to the central topic. */
  position?: { x: number; y: number };
}

export interface MindSheet {
  title: string;
  root: MindTopic;
  floating: MindTopic[];
  relationships: { from: string; to: string; title?: string }[];
  /** "map": first-level topics on both sides; "right"/"left": all on one side (logic charts, trees). */
  layout: 'map' | 'right' | 'left';
}

export interface MindMap {
  /** "XMind", "XMind 8", "MindManager", "FreeMind", "Freeplane". */
  format: string;
  sheets: MindSheet[];
  /** Creator application and version, when the file says. */
  creator?: string;
  /** Object URLs to revoke when the viewer closes. */
  urls: string[];
}

export function countTopics(topic: MindTopic): number {
  return 1 + topic.children.reduce((n, c) => n + countTopics(c), 0);
}

/** Palette index from a color word in a marker id ("flag-red", "star-orange"). */
export function colorIndex(name: string): number {
  const colors = ['blue', 'red', 'green', 'purple', 'orange', 'cyan', 'pink', 'gray'];
  const found = colors.findIndex((c) => name.toLowerCase().includes(c));
  if (found >= 0) return found;
  return name.toLowerCase().includes('yellow') ? 4 : -1;
}
