// SPDX-License-Identifier: GPL-3.0-or-later
// Files whose content Peekbean cannot draw (closed CAD formats, Blender, design documents) but which carry a preview
// picture: the pictures, the properties and the structure (components, objects, linked files), with a note on what is
// missing and how to get a full view.
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { readPreviewInWorker } from './preview/client';
import type { PreviewGallery, PreviewImage, PreviewList, PreviewNode } from './preview/types';

/** An object URL for a picture; metafiles are drawn to PNG first, as browsers do not show them. */
async function pictureUrl(image: PreviewImage): Promise<string | null> {
  if (image.type === 'image/wmf' || image.type === 'image/emf') {
    const { metafileToPng } = await import('ooxml-pages/metafile');
    const png = await metafileToPng(image.bytes).catch(() => null);
    return png ? URL.createObjectURL(png) : null;
  }
  return URL.createObjectURL(new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.type }));
}

function treeItems(nodes: PreviewNode[], depth: number): HTMLElement[] {
  return nodes.map((node) => {
    const label = h('span', { class: 'pv-node' }, h('span', { class: 'pv-name' }, node.name), node.detail ? h('span', { class: 'pv-detail' }, node.detail) : null);
    if (!node.children?.length) return h('li', { class: node.muted ? 'muted' : '' }, label);
    // Subassemblies start open on the first level only.
    return h('li', { class: node.muted ? 'muted' : '' }, h('details', { open: depth === 0 }, h('summary', {}, label), h('ul', {}, ...treeItems(node.children, depth + 1))));
  });
}

function listCard(list: PreviewList): HTMLElement {
  const total = list.total ?? list.nodes.length;
  return h(
    'div',
    { class: 'record' },
    h('div', { class: 'record-hd' }, h('b', {}, list.title), h('span', { class: 'pv-count' }, total.toLocaleString('en-US'))),
    h('ul', { class: 'pv-tree' }, ...treeItems(list.nodes, 0)),
    total > list.nodes.length ? h('p', { class: 'records-note' }, `The first ${list.nodes.length.toLocaleString('en-US')} are listed.`) : null,
  );
}

/** File extensions for opening a picture in the image viewer; the first four the browser shows on a tile too. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/x-exr': 'exr',
  'image/vnd.radiance': 'hdr',
};
const TILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp']);

/** Tiles for pictures inside the file (packed textures); a click opens one in the image viewer. */
function galleryCard(gallery: PreviewGallery, openFile: ViewerContext['openFile'], urls: string[]): HTMLElement {
  const grid = h('div', { class: 'pv-gallery' });
  for (const item of gallery.items) {
    const { image } = item;
    let picture: HTMLElement = h('span', { class: 'pv-tile-none' }, image ? 'Click to open' : 'No picture in the file');
    if (image && TILE_TYPES.has(image.type)) {
      const url = URL.createObjectURL(new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.type }));
      urls.push(url);
      picture = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' });
    }
    const caption = h('span', { class: 'pv-tile-text' }, h('b', { title: item.label }, item.label), item.detail ? h('span', { title: item.detail }, item.detail) : null);
    if (!image) {
      grid.append(h('div', { class: 'pv-tile' }, picture, caption));
      continue;
    }
    const extension = EXTENSIONS[image.type] ?? 'png';
    const name = new RegExp(`\\.(${Object.values(EXTENSIONS).join('|')}|jpeg|tiff)$`, 'i').test(item.label) ? item.label : `${item.label}.${extension}`;
    grid.append(
      h(
        'button',
        { type: 'button', class: 'pv-tile', title: `Open ${item.label} in a new tab`, onclick: () => openFile(new File([image.bytes as Uint8Array<ArrayBuffer>], name, { type: image.type }), 'image') },
        picture,
        caption,
      ),
    );
  }
  return h('div', { class: 'record' }, h('div', { class: 'record-hd' }, h('b', {}, gallery.title), h('span', { class: 'pv-count' }, gallery.items.length.toLocaleString('en-US'))), grid);
}

export async function mount({ file, container, toolbar, progress, openFile }: ViewerContext) {
  progress('Reading the file …');
  const result = await readPreviewInWorker(file, (fraction) => progress('Reading the file …', fraction));
  const pictures = (await Promise.all(result.images.map(async (image) => ({ image, url: await pictureUrl(image) })))).filter((p): p is { image: PreviewImage; url: string } => !!p.url);

  const list = h('div', { class: 'records-list' });
  if (pictures.length) {
    const img = h('img', { class: 'pv-image', alt: `Preview of ${file.name}`, draggable: false });
    const caption = h('figcaption', {});
    const thumbs = h('div', { class: 'pv-thumbs', role: 'tablist', 'aria-label': 'Preview pictures' });
    const show = (index: number) => {
      const { image, url } = pictures[index];
      img.src = url;
      img.onload = () => {
        caption.textContent = `${image.label} · ${img.naturalWidth} × ${img.naturalHeight} px`;
        // Small thumbnails are shown at twice their size at most, so they stay sharp enough.
        img.style.maxWidth = `${img.naturalWidth * 2}px`;
      };
      thumbs.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-selected', String(i === index)));
    };
    if (pictures.length > 1) {
      pictures.forEach(({ image, url }, i) =>
        thumbs.append(h('button', { type: 'button', class: 'pv-thumb', role: 'tab', title: image.label, onclick: () => show(i) }, h('img', { src: url, alt: '' }), h('span', {}, image.label))),
      );
    }
    list.append(h('figure', { class: 'record pv-hero' }, h('div', { class: 'pv-frame' }, img), caption, pictures.length > 1 ? thumbs : null));
    show(0);
  } else {
    list.append(h('div', { class: 'record pv-empty' }, 'The file contains no preview picture.'));
  }
  const urls = pictures.map((p) => p.url);
  for (const gallery of result.galleries ?? []) list.append(galleryCard(gallery, openFile, urls));
  for (const s of result.sections) {
    list.append(h('div', { class: 'record' }, h('div', { class: 'record-hd' }, h('b', {}, s.title)), h('dl', {}, ...s.rows.flatMap((r) => [h('dt', {}, r.label), h('dd', {}, r.value)]))));
  }
  for (const l of result.lists) if (l.nodes.length) list.append(listCard(l));

  container.append(h('div', { class: 'banner' }, result.limits), h('div', { class: 'records pv-view' }, list));
  toolbar.append(h('span', { class: 'meta' }, result.kind));

  return {
    destroy: () => {
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}
