// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionOf } from '../core/bytes';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import type { ViewerContext } from '../core/types';

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'];

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'Livestream';
  const s = Math.round(seconds);
  const parts = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return (parts[0] ? parts : parts.slice(1)).map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0'))).join(':');
}

export async function mount({ file, container, toolbar }: ViewerContext) {
  const url = URL.createObjectURL(file);
  const isAudio = file.type.startsWith('audio/') || AUDIO_EXTENSIONS.includes(extensionOf(file.name));
  const media = isAudio ? h('audio', { controls: true, preload: 'metadata' }) : h('video', { controls: true, preload: 'metadata', playsInline: true });
  media.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      media.addEventListener('loadedmetadata', () => resolve(), { once: true });
      media.addEventListener('error', () => reject(new Error('The browser cannot play this format or codec.')), { once: true });
    });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }

  const video = media instanceof HTMLVideoElement && media.videoWidth > 0 ? media : null;
  container.classList.add('media-view');
  container.append(
    video
      ? h('div', { class: 'media-stage' }, media)
      : h('div', { class: 'media-stage audio' }, h('div', { class: 'audio-card' }, h('span', { class: 'ico acc' }, icon('media', 22, 1.8)), h('b', {}, file.name), media)),
  );
  toolbar.append(
    h('span', { class: 'meta' }, formatDuration(media.duration)),
    ...(video ? [h('span', { class: 'meta' }, `${video.videoWidth} × ${video.videoHeight} px`)] : []),
  );

  return {
    destroy: () => {
      media.pause();
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(url);
    },
  };
}
