// SPDX-License-Identifier: GPL-3.0-or-later
// The converter page. Without files it is a start page: the drop zone, a search over all conversions and the kinds of
// files with their formats. One file gets a card of its own: the conversion, one button, and once converted the
// download and a button to compare. Several files share one panel, grouped by kind, each group with its target
// format and options in its first line; each file downloads from its row. Input and output open on demand next to the
// list (preview.ts), so nobody who only wants the converted file waits for viewers. The files are converted here in
// the browser, one after another. Pages such as jpg-to-png.html are this page with one conversion chosen; there files
// of that kind convert right away.
import { extensionOf, formatBytes } from '../core/bytes';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { conversionIssueLink, REPO_URL } from '../github';
import { brand, fileDrop, githubLink, LocalStatus, siteFooter, siteNav, themeControls } from '../site';
import { CONVERTERS, PAIRS, defaultTarget, findPair, initialOptions, optionsFor, pairPage, sourceFor, type ConversionPair, type ConvertOption, type ConverterInfo, type TargetFormat } from './catalog';
import { baseName, download, zipFiles } from './files';
import { converterFor, loadConverter } from './modules';
import { Preview, type PreviewItem } from './preview';
import type { ConvertResult } from './types';

type Status = 'detecting' | 'ready' | 'working' | 'done' | 'failed' | 'unsupported';

interface Job {
  /** Tells the preview when another file is selected. */
  id: number;
  file: File;
  status: Status;
  converter: ConverterInfo | null;
  /** Viewer the format detection chose; converters with several readers pick by it. */
  viewer: string;
  /** Kind of file as detected, e.g. "PDF document". */
  kind: string;
  /** Progress while converting, the reason when it failed. */
  message: string;
  fraction?: number;
  result?: ConvertResult;
  /** Of the kind a conversion's page is for: converted as soon as it is detected. */
  auto?: boolean;
  /** The file's row in the list, redrawn while it converts. */
  row?: HTMLElement;
  /** Thumbnail of a picture the browser shows itself; made once, as the row is redrawn often. */
  thumb?: HTMLElement;
  thumbUrl?: string;
}

/** Target and options per converter; they apply to all files of that kind. */
interface Settings {
  target: string;
  options: Record<string, string>;
}

/** Shown on the general page before anything is typed into the search; missing ones are skipped. */
const POPULAR = ['heic-to-jpg', 'png-to-jpg', 'jpg-to-png', 'webp-to-png', 'pdf-to-png', 'xlsx-to-csv', 'csv-to-xlsx', 'step-to-stl', 'step-to-glb', 'dwg-to-dxf', 'svg-to-png', 'rar-to-zip', 'msg-to-eml', 'kml-to-geojson'];
const THUMBNAILS = ['jpg', 'jpeg', 'jfif', 'pjpeg', 'png', 'apng', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico'];
const MAX_RESULTS = 24;
/** Source formats a kind shows before "more". */
const SHOWN_SOURCES = 8;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });

export class ConverterPage {
  private readonly jobs: Job[] = [];
  private readonly settings = new Map<string, Settings>();
  private nextId = 1;
  private running = false;
  /** File shown in the preview; the preview is only there while open (beside the list, on phones instead of it). */
  private selected: Job | null = null;
  private previewOpen = false;
  private readonly local = new LocalStatus();
  private readonly picker = h('input', { type: 'file', multiple: true, hidden: true });
  private readonly landing: HTMLElement;
  /** The card of a single file or the panel of several, redrawn as a whole. */
  private readonly queue = h('div', { class: 'cv-queue' });
  /** Foot of the panel; it counts along while files convert. */
  private foot: HTMLElement | null = null;
  private readonly preview = new Preview({
    close: () => {
      this.previewOpen = false;
      this.render();
    },
    download: (files, button) => this.save(files, `${baseName(this.selected?.file.name ?? 'converted')}.zip`, button),
  });
  private readonly bench = h(
    'div',
    { class: 'cv-bench', hidden: true },
    this.queue,
    this.preview.element,
  );

  constructor(
    root: HTMLElement,
    private readonly pair: ConversionPair | null,
  ) {
    const header = h('header', { class: 'top' }, brand(), siteNav('convert'), h('span', { class: 'grow' }), this.local.button, ...themeControls(), githubLink());
    this.landing = h('section', { class: 'start-body' }, h('div', { class: 'start cv-page' }, this.hero(), this.finder(), this.kinds(), this.steps(), siteFooter()));
    root.replaceChildren(header, h('main', { class: 'stage' }, this.landing, this.bench), fileDrop('Drop to convert', (files) => this.add(files)), this.picker, this.local.dialog);
    this.picker.addEventListener('change', () => {
      this.add([...(this.picker.files ?? [])]);
      this.picker.value = '';
    });
  }

  // ---- Start page ---------------------------------------------------------------------------------------------------

  private hero(): HTMLElement {
    const pair = this.pair;
    const title = pair
      ? h('h1', {}, 'Convert ', h('em', { class: 'any' }, pair.source.label), ' to ', h('em', { class: 'any' }, pair.target.label), '.')
      : h('h1', {}, 'Convert files.', h('br'), h('em', { class: 'any' }, 'Locally.'));
    const lead = pair
      ? ` Your ${pair.source.label} files become ${pair.target.label} on your computer and are never uploaded.`
      : ' Images, documents, spreadsheets, 3D models and more are converted on your computer. Compare input and output before you download.';
    const notes = pair ? [pair.source.note, pair.target.loss].filter(Boolean) : [];
    return h(
      'div',
      { class: 'hero' },
      h(
        'div',
        { class: 'hero-text' },
        h('span', { class: 'eyebrow' }, 'CLIENT-SIDE FILE CONVERTER'),
        title,
        h('p', { class: 'lead' }, h('b', {}, 'Private and secure.'), lead),
        notes.length > 0 && h('p', { class: 'cv-lead-note' }, notes.join(' ')),
        h('button', { type: 'button', class: 'text-link', 'aria-haspopup': 'dialog', onclick: () => this.local.explain() }, 'How your files stay local', icon('chevRight', 16, 2)),
        pair && h('a', { class: 'text-link', href: 'convert.html' }, 'All conversions', icon('chevRight', 16, 2)),
        h('a', { class: 'text-link site-switch', href: './' }, 'View files instead', icon('chevRight', 16, 2)),
      ),
      h(
        'div',
        {
          class: 'dropzone',
          // A click anywhere in the zone opens the picker; the button inside handles its own click.
          onclick: (event: MouseEvent) => {
            if (!(event.target as Element).closest('button')) this.picker.click();
          },
        },
        h('span', { class: 'drop-ico' }, icon('drop', 26, 1.8)),
        h('b', { class: 'drop-title' }, pair ? `Drop ${pair.source.label} files here` : 'Drop files to convert'),
        h('span', { class: 'drop-sub' }, 'or choose files from your computer'),
        h('button', { type: 'button', class: 'btn primary xl', onclick: () => this.picker.click() }, icon('open', 20, 1.9), 'Choose files'),
        h('span', { class: 'local-line' }, h('span', { class: 'dot' }), 'Converted locally on your device. Nothing is uploaded.'),
      ),
    );
  }

  /** A search over all conversions; each result links to the conversion's own page. */
  private finder(): HTMLElement {
    const input = h('input', { type: 'search', class: 'cv-search-input', placeholder: 'Try “heic to jpg” or “step”', 'aria-label': 'Find a conversion', autocomplete: 'off', spellcheck: false });
    const results = h('div', { class: 'cv-results', 'aria-live': 'polite' });
    const update = () => {
      const query = input.value.trim();
      const { label, pairs } = this.search(query);
      const items: HTMLElement[] = pairs.map((p) =>
        h('a', { class: 'cv-pair', href: pairPage(p), 'aria-current': p === this.pair ? 'page' : undefined }, p.source.label, h('span', { class: 'c3' }, '→'), p.target.label),
      );
      if (label) items.unshift(h('span', { class: 'c3' }, label));
      if (pairs.length === 0 && query) {
        items.push(h('span', { class: 'c2' }, `No conversion matches “${query}” yet.`));
        if (REPO_URL) items.push(h('a', { class: 'text-link', target: '_blank', rel: 'noopener noreferrer', ...conversionIssueLink() }, 'Suggest a converter', icon('chevRight', 16, 2)));
      }
      results.replaceChildren(...items);
    };
    input.addEventListener('input', update);
    update();
    const formats = new Set(PAIRS.flatMap((p) => [p.source.label, p.target.label])).size;
    return h(
      'section',
      { class: 'formats', 'aria-labelledby': 'find-title' },
      h('div', { class: 'formats-head' }, h('h2', { id: 'find-title' }, 'Find a conversion'), h('span', { class: 'c3' }, `${PAIRS.length} conversions between ${formats} formats`)),
      h('label', { class: 'cv-search' }, icon('search', 18), input),
      results,
    );
  }

  /**
   * Conversions whose formats or kind start with every word typed; "to" and arrows are left out, so "heic to jpg"
   * finds HEIC to JPG. Without a query: popular ones, or on a conversion's page its neighbors.
   */
  private search(query: string): { label: string; pairs: ConversionPair[] } {
    const words = query.toLowerCase().replace(/→|->/g, ' ').split(/[\s,]+/).filter((w) => w && w !== 'to');
    if (words.length === 0) {
      const pair = this.pair;
      return pair
        ? { label: 'Related:', pairs: PAIRS.filter((p) => p !== pair && p.converter === pair.converter && (p.source === pair.source || p.target === pair.target)).slice(0, MAX_RESULTS) }
        : { label: 'Popular:', pairs: POPULAR.map(findPair).filter((p): p is ConversionPair => !!p) };
    }
    const starts = (names: string[], word: string) => names.some((name) => name.toLowerCase().replace(/\s/g, '').startsWith(word));
    const source = (p: ConversionPair) => [p.source.label, p.source.slug, ...p.source.extensions];
    const target = (p: ConversionPair) => [p.target.label, p.target.id, p.target.extension];
    const matches = PAIRS.filter((p) => words.every((w) => starts(source(p), w) || starts(target(p), w) || starts([p.converter.label], w)))
      // The first word is most likely the format the files are in.
      .sort((a, b) => Number(starts(source(b), words[0])) - Number(starts(source(a), words[0])));
    const count = plural(matches.length, 'match', 'matches');
    return { label: matches.length === 0 ? '' : matches.length > MAX_RESULTS ? `${count}, the first ${MAX_RESULTS}:` : `${count}:`, pairs: matches.slice(0, MAX_RESULTS) };
  }

  /** One card per converter: the formats it reads and the ones it writes. */
  private kinds(): HTMLElement {
    const cards = CONVERTERS.map((converter) => {
      const sources = h('div', { class: 'cv-tags' });
      const more = converter.sources.length > SHOWN_SOURCES ? h('button', { type: 'button', class: 'cv-tag more', 'aria-expanded': 'false' }) : null;
      let open = false;
      const draw = () => {
        const shown = open || !more ? converter.sources : converter.sources.slice(0, SHOWN_SOURCES);
        sources.replaceChildren(...shown.map((s) => h('span', { class: 'cv-tag' }, s.label)), ...(more ? [more] : []));
        if (!more) return;
        more.textContent = open ? 'Show less' : `+${converter.sources.length - SHOWN_SOURCES} more`;
        more.setAttribute('aria-expanded', String(open));
      };
      more?.addEventListener('click', () => {
        open = !open;
        draw();
      });
      draw();
      const count = PAIRS.filter((p) => p.converter === converter).length;
      return h(
        'article',
        { class: 'cv-kind' },
        h('div', { class: 'cv-kind-hd' }, h('span', { class: 'ico' }, icon(converter.icon, 18)), h('div', { class: 'fmt-txt' }, h('b', {}, converter.label), h('span', {}, plural(count, 'conversion', 'conversions')))),
        h('div', { class: 'cv-kind-row' }, h('span', { class: 'cv-kind-lbl' }, 'FROM'), sources),
        h('div', { class: 'cv-kind-row' }, h('span', { class: 'cv-kind-lbl' }, 'TO'), h('div', { class: 'cv-tags' }, ...converter.targets.map((t) => h('span', { class: 'cv-tag to' }, t.label)))),
      );
    });
    return h(
      'section',
      { class: 'formats', 'aria-labelledby': 'kinds-title' },
      h('div', { class: 'formats-head' }, h('h2', { id: 'kinds-title' }, 'Browse by kind'), h('span', { class: 'c3' }, 'Every format of a kind converts to each of its targets.')),
      h('div', { class: 'cv-kinds' }, ...cards),
      REPO_URL &&
        h(
          'div',
          { class: 'fmt-rest' },
          h('span', { class: 'fmt-ico' }, icon('feedback', 18)),
          h('span', {}, h('b', {}, 'Missing a conversion? '), 'Tell us which formats you need.'),
          h('a', { class: 'text-link', target: '_blank', rel: 'noopener noreferrer', ...conversionIssueLink() }, 'Suggest a converter', icon('chevRight', 16, 2)),
        ),
    );
  }

  private steps(): HTMLElement {
    const step = (num: string, title: string, text: string) => h('li', { class: 'cv-step' }, h('span', { class: 'num' }, num), h('div', {}, h('b', {}, title), h('span', {}, text)));
    return h(
      'section',
      { class: 'formats', 'aria-labelledby': 'steps-title' },
      h('div', { class: 'formats-head' }, h('h2', { id: 'steps-title' }, 'How it works')),
      h(
        'ol',
        { class: 'cv-steps' },
        step('01', 'Drop your files', 'Any mix of files at once. The format is detected from the content, not from the file name.'),
        step('02', 'Pick the target', 'One choice per kind of file, for example JPG for all images. Quality or resolution sit right next to it.'),
        step('03', 'Compare, then download', 'See input and output side by side and what the new format leaves out. Several files come as one ZIP.'),
      ),
    );
  }

  // ---- Files ------------------------------------------------------------------------------------------------------

  private add(files: File[]): void {
    if (files.length === 0) return;
    for (const file of files) {
      const job: Job = { id: this.nextId++, file, status: 'detecting', converter: null, viewer: '', kind: '', message: '' };
      this.jobs.push(job);
      converterFor(file).then(
        ({ converter, viewer, kind }) => {
          Object.assign(job, { converter, viewer, kind, status: converter ? 'ready' : 'unsupported' });
          if (converter && !this.settings.has(converter.id)) this.settings.set(converter.id, this.initialSettings(converter, file));
          this.render();
          // The page's address already says what the files should become; elsewhere the target is only a guess.
          if (converter && converter === this.pair?.converter) {
            job.auto = true;
            void this.convertAll(true);
          }
        },
        (error) => {
          Object.assign(job, { status: 'failed', message: errorText(error) });
          this.render();
        },
      );
    }
    this.render();
  }

  /** The conversion of the page if it has one; otherwise the first target that is not the file's own format. */
  private initialSettings(converter: ConverterInfo, file: File): Settings {
    const target = this.pair?.converter === converter ? this.pair.target : defaultTarget(converter, file.name);
    return { target: target.id, options: initialOptions(converter) };
  }

  private openPreview(job: Job): void {
    this.selected = job;
    this.previewOpen = true;
    this.preview.reset();
    this.render();
  }

  private remove(...jobs: Job[]): void {
    for (const job of jobs) {
      const index = this.jobs.indexOf(job);
      this.jobs.splice(index, 1);
      this.forget(job);
      if (this.selected === job) this.selected = this.jobs[Math.min(index, this.jobs.length - 1)] ?? null;
    }
    this.render();
  }

  private clear(): void {
    for (const job of this.jobs) this.forget(job);
    this.jobs.length = 0;
    this.selected = null;
    this.previewOpen = false;
    this.render();
  }

  private forget(job: Job): void {
    if (job.thumbUrl) URL.revokeObjectURL(job.thumbUrl);
    this.reset(job);
  }

  /** Back to waiting for "Convert", without the result of an earlier run. */
  private reset(job: Job): void {
    Object.assign(job, { status: 'ready', message: '', result: undefined });
  }

  /** New settings make earlier results stale; those files are converted again on the next run. */
  private change(converter: ConverterInfo, update: (settings: Settings) => void): void {
    update(this.settings.get(converter.id)!);
    for (const job of this.jobs) {
      if (job.converter === converter && (job.status === 'done' || job.status === 'failed')) this.reset(job);
    }
    this.render();
  }

  /** `auto` converts only the files of a conversion's page; the others wait for "Convert". */
  private async convertAll(auto = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.render();
    // Files added meanwhile are taken along as soon as their format is known.
    for (let job = this.nextReady(auto); job; job = this.nextReady(auto)) {
      const { target, options } = this.settings.get(job.converter!.id)!;
      Object.assign(job, { status: 'working', message: 'Starting …', fraction: undefined });
      this.drawRow(job);
      const current = job;
      try {
        const module = await loadConverter(job.converter!.id);
        job.result = await module.convert({
          file: job.file,
          viewer: job.viewer,
          target,
          options,
          progress: (message, fraction) => {
            if (current.status !== 'working') return;
            Object.assign(current, { message, fraction });
            this.drawRow(current);
          },
        });
        job.status = 'done';
      } catch (error) {
        console.error(error);
        Object.assign(job, { status: 'failed', message: errorText(error) });
      }
      this.drawRow(job);
    }
    this.running = false;
    this.render();
  }

  private nextReady(auto: boolean): Job | undefined {
    return this.jobs.find((job) => job.status === 'ready' && job.converter && (!auto || job.auto));
  }

  // ---- The card of one file, the panel of several ------------------------------------------------------------------

  /** One file without the preview open gets a card of its own; otherwise the files share a panel. */
  private get single(): boolean {
    return this.jobs.length === 1 && !this.previewOpen;
  }

  private render(): void {
    const empty = this.jobs.length === 0;
    this.landing.hidden = !empty;
    this.bench.hidden = empty;
    if (!this.selected || !this.jobs.includes(this.selected)) {
      this.selected = this.jobs[0] ?? null;
      if (!this.selected) this.previewOpen = false;
    }
    if (empty) {
      this.preview.show(null);
      return;
    }
    this.bench.classList.toggle('open', this.previewOpen);
    this.bench.classList.toggle('single', this.single);
    if (this.single) {
      this.foot = null;
      this.queue.replaceChildren(...this.singleCard(this.jobs[0]));
    } else {
      this.queue.replaceChildren(this.panel());
    }
    this.showPreview();
  }

  /** One file: what it is, how it converts and one button; once converted the download and what changed. */
  private singleCard(job: Job): HTMLElement[] {
    const card = h('section', { class: 'cv-single', 'aria-label': 'File to convert' });
    card.dataset.status = job.status;
    // Preview, feedback and remove in the corner, as in the list and the viewer's file bar. Once converted, Compare
    // below takes the preview's place; a file no converter takes asks for one in its warning.
    const tools = h(
      'div',
      { class: 'cv-single-tools' },
      job.status !== 'detecting' && job.status !== 'done' ? this.previewButton(job, false) : null,
      job.converter ? this.feedbackLink(job) : null,
      h('button', { type: 'button', class: 'hb x', 'aria-label': `Remove ${job.file.name}`, title: 'Remove', disabled: job.status === 'working', onclick: () => this.remove(job) }, icon('close', 15, 2.2)),
    );
    if (job.status === 'done') {
      card.append(...this.singleDone(job, tools));
    } else {
      card.append(h('div', { class: 'cv-single-hd' }, this.thumb(job), h('div', { class: 'cv-txt' }, h('b', { title: job.file.name }, job.file.name), h('span', { class: 'cv-meta' }, job.status === 'detecting' ? 'Detecting format …' : this.info(job))), tools));
      if (job.converter) {
        card.append(this.route(job), ...this.singleAction(job));
      } else if (job.status !== 'detecting') {
        card.append(h('div', { class: 'cv-banner' }, icon('alert', 18, 1.9), h('div', { class: 'cv-banner-txt' }, h('b', {}, 'This file can’t be converted yet'), h('span', {}, ...this.unsupportedText([job])))));
      }
    }
    return [card, h('p', { class: 'cv-more' }, h('button', { type: 'button', class: 'text-link', onclick: () => this.picker.click() }, icon('plus', 15, 2), 'Add more files'), h('span', { class: 'c3' }, 'or drop them anywhere'))];
  }

  /** The file's format, an arrow, the formats it can become; then the options and what the target loses. */
  private route(job: Job): HTMLElement {
    const converter = job.converter!;
    const settings = this.settings.get(converter.id)!;
    const target = this.targetOf(job)!;
    return h(
      'div',
      { class: 'cv-route' },
      h('div', { class: 'cv-route-main' }, h('span', { class: 'cv-from' }, sourceFor(converter, job.file.name)?.label ?? job.kind), h('span', { class: 'cv-arrow', 'aria-hidden': 'true' }, icon('arrowRight', 26, 1.8)), this.targets(converter, settings)),
      ...this.details(converter, settings, target),
    );
  }

  private singleAction(job: Job): HTMLElement[] {
    const target = this.targetOf(job)!;
    const convert = (label: string) => h('button', { type: 'button', class: 'btn primary cv-wide', onclick: () => void this.convertAll() }, label);
    switch (job.status) {
      case 'working':
        return [h('div', { class: 'cv-wide-progress' }, this.progress(job))];
      case 'failed': {
        const report = this.report(job);
        return [
          h(
            'div',
            { class: 'cv-fail' },
            h('span', { class: 'cv-err' }, icon('alert', 15, 1.8), h('span', {}, job.message)),
            report && h('a', { class: 'cv-link', target: '_blank', rel: 'noopener noreferrer', ...report }, 'Report this problem'),
          ),
          convert('Try again'),
        ];
      }
      default:
        return [convert(`Convert to ${target.label}`)];
    }
  }

  private singleDone(job: Job, tools: HTMLElement): HTMLElement[] {
    const files = job.result!.files;
    const target = this.targetOf(job)!;
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const parts: HTMLElement[] = [
      h(
        'div',
        { class: 'cv-single-hd' },
        h('span', { class: 'cv-done-ico' }, icon('check', 20, 2.4)),
        h('div', { class: 'cv-txt' }, h('b', {}, files.length === 1 ? files[0].name : plural(files.length, 'file', 'files')), h('span', { class: 'cv-meta' }, `from ${job.file.name} · ${formatBytes(total)}${this.sizeChange(job.file.size, total)}`)),
        tools,
      ),
    ];
    if (target.loss) parts.push(h('p', { class: 'cv-loss warn' }, icon('alert', 15, 1.8), h('span', {}, target.loss)));
    // Download first; comparing opens the preview with input and output in full size.
    parts.push(
      h(
        'div',
        { class: 'cv-done-actions' },
        this.downloadButton(job, true),
        h('button', { type: 'button', class: 'btn cv-compare', title: 'Compare input and output', onclick: () => this.openPreview(job) }, icon('eye', 18), 'Compare'),
      ),
    );
    const options = optionsFor(job.converter!, target.id).map((o) => `${o.label}: ${o.choices.find((c) => c.value === this.settings.get(job.converter!.id)!.options[o.id])?.label ?? ''}`);
    parts.push(
      h(
        'p',
        { class: 'cv-change' },
        [target.label, ...options].join(' · '),
        h('button', {
          type: 'button',
          class: 'cv-link',
          onclick: () => {
            this.reset(job);
            this.render();
          },
        }, 'Change format or options'),
      ),
    );
    return parts;
  }

  /** "35% smaller" after the size of a result. */
  private sizeChange(before: number, after: number): string {
    if (before === 0) return '';
    const change = Math.round((after / before - 1) * 100);
    return change === 0 ? ', same size' : `, ${Math.abs(change)}% ${change < 0 ? 'smaller' : 'larger'}`;
  }

  /** Several files: the head, files no converter takes, one group per kind, and the actions at the foot. */
  private panel(): HTMLElement {
    const groups = CONVERTERS.filter((c) => this.jobs.some((job) => job.converter === c));
    const pending = this.jobs.filter((job) => !job.converter && job.status === 'detecting');
    const unsupported = this.jobs.filter((job) => !job.converter && job.status !== 'detecting');
    const summary = [groups.length > 0 && plural(groups.length, 'kind', 'kinds'), unsupported.length > 0 && `${unsupported.length} not supported`].filter(Boolean).join(' · ');
    this.foot = h('div', { class: 'cv-panel-ft' }, ...this.actions());
    return h(
      'section',
      { class: 'cv-panel', 'aria-label': 'Files to convert' },
      h(
        'div',
        { class: 'cv-panel-hd' },
        h('h2', {}, plural(this.jobs.length, 'file', 'files')),
        h('span', { class: 'c3' }, summary),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'cv-ghost', onclick: () => this.picker.click() }, icon('plus', 16, 2), 'Add files'),
      ),
      h(
        'div',
        { class: 'cv-list' },
        ...(unsupported.length > 0 ? [this.unsupportedBanner(unsupported)] : []),
        ...groups.map((c) => this.group(c)),
        ...(pending.length > 0 ? [this.pendingGroup(pending)] : []),
      ),
      this.foot,
    );
  }

  /** Files no converter takes, as a warning above the groups. */
  private unsupportedBanner(jobs: Job[]): HTMLElement {
    const one = jobs.length === 1;
    return h(
      'div',
      { class: 'cv-banner', role: 'status' },
      icon('alert', 18, 1.9),
      h('div', { class: 'cv-banner-txt' }, h('b', {}, one ? `${jobs[0].file.name} can’t be converted` : `${jobs.length} files can’t be converted`), h('span', {}, ...this.unsupportedText(jobs))),
      h('button', { type: 'button', class: 'hb x', 'aria-label': one ? `Remove ${jobs[0].file.name}` : 'Remove these files', title: 'Remove', onclick: () => this.remove(...jobs) }, icon('close', 14, 2.2)),
    );
  }

  /** Why files are not converted, and the ways out: the viewer, or asking for a converter. */
  private unsupportedText(jobs: Job[]): (Node | string)[] {
    const kinds = [...new Set(jobs.map((job) => job.kind).filter(Boolean))].join(', ');
    const failed = jobs.length === 1 && jobs[0].status === 'failed' ? jobs[0].message : '';
    const text = failed || `There is no converter for ${jobs.length === 1 ? 'this format' : 'these formats'}${kinds ? ` (${kinds})` : ''} yet.`;
    return [
      `${text} `,
      h('a', { class: 'cv-link', href: './', title: 'Opens the viewer; drop the file there' }, 'Open in the viewer'),
      // One file names its format in the request; several may be of different formats.
      ...(REPO_URL ? [' · ', h('a', { class: 'cv-link', target: '_blank', rel: 'noopener noreferrer', ...(jobs.length === 1 ? conversionIssueLink(jobs[0].file, jobs[0].kind || undefined) : conversionIssueLink()) }, 'Suggest a converter')] : []),
    ];
  }

  /** New issue about converting this file: its formats and options, never its name or content. */
  private report(job: Job): { href: string; title: string } | null {
    const target = this.targetOf(job);
    if (!REPO_URL || !job.converter || !target) return null;
    const settings = this.settings.get(job.converter.id)!;
    const options = optionsFor(job.converter, target.id).map((o) => `${o.label}: ${o.choices.find((c) => c.value === settings.options[o.id])?.label ?? settings.options[o.id]}`);
    return conversionIssueLink(job.file, job.kind || undefined, { from: sourceFor(job.converter, job.file.name)?.label ?? job.kind, to: target.label, options });
  }

  private feedbackLink(job: Job): HTMLElement | null {
    const report = this.report(job);
    return report && h('a', { class: 'hb cv-feedback', target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Feedback', ...report }, icon('feedback', 15));
  }

  /**
   * A kind of file: a tinted band with its name and count, the arrow and the target formats, then options and what
   * gets lost; the files below it on the plain surface, so the band never reads as one more file.
   */
  private group(converter: ConverterInfo): HTMLElement {
    const jobs = this.jobs.filter((job) => job.converter === converter);
    const settings = this.settings.get(converter.id)!;
    const target = converter.targets.find((t) => t.id === settings.target)!;
    const details = this.details(converter, settings, target);
    return h(
      'section',
      { class: 'cv-group', 'aria-label': converter.label },
      h(
        'div',
        { class: 'cv-group-set' },
        h(
          'div',
          { class: 'cv-group-hd' },
          h('span', { class: 'ico' }, icon(converter.icon, 16)),
          h('div', { class: 'cv-group-title' }, h('b', {}, converter.label), h('span', {}, plural(jobs.length, 'file', 'files'))),
          h('div', { class: 'cv-to' }, h('span', { class: 'cv-arrow', 'aria-hidden': 'true' }, icon('arrowRight', 22, 1.8)), this.targets(converter, settings)),
        ),
        ...(details.length > 0 ? [h('div', { class: 'cv-group-opts' }, ...details)] : []),
      ),
      h('ul', { class: 'cv-files' }, ...jobs.map((job) => this.row(job))),
    );
  }

  private pendingGroup(jobs: Job[]): HTMLElement {
    return h(
      'section',
      { class: 'cv-group' },
      h('div', { class: 'cv-group-set' }, h('div', { class: 'cv-group-hd' }, h('span', { class: 'ico' }, icon('file', 16)), h('div', { class: 'cv-group-title' }, h('b', {}, 'Detecting the format'), h('span', {}, plural(jobs.length, 'file', 'files'))))),
      h('ul', { class: 'cv-files' }, ...jobs.map((job) => this.row(job))),
    );
  }

  /** The target formats; orange marks the one chosen, as it decides what comes out. */
  private targets(converter: ConverterInfo, settings: Settings): HTMLElement {
    return h(
      'div',
      { class: 'cv-seg cv-targets', role: 'radiogroup', 'aria-label': `Convert ${converter.label.toLowerCase()} to` },
      ...converter.targets.map((t) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(t.id === settings.target), disabled: this.running, onclick: () => this.change(converter, (s) => (s.target = t.id)) }, t.label),
      ),
    );
  }

  /** The options of the chosen target, then a line on what it loses. */
  private details(converter: ConverterInfo, settings: Settings, target: TargetFormat): HTMLElement[] {
    const options = optionsFor(converter, settings.target).map((option) =>
      h('div', { class: 'cv-ctl' }, h('span', { class: 'cv-ctl-lbl' }, option.label), this.choice(option, settings.options[option.id], (value) => this.change(converter, (s) => (s.options[option.id] = value)))),
    );
    return target.loss ? [...options, h('p', { class: 'cv-loss' }, icon('info', 14), h('span', {}, target.loss))] : options;
  }

  /** A few choices side by side; longer lists in a select. */
  private choice(option: ConvertOption, value: string, onchange: (value: string) => void): HTMLElement {
    if (option.choices.length <= 4) {
      return h(
        'div',
        { class: 'cv-seg', role: 'radiogroup', 'aria-label': option.label },
        ...option.choices.map((c) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(c.value === value), disabled: this.running, onclick: () => onchange(c.value) }, c.label)),
      );
    }
    const select = h('select', { class: 'select', 'aria-label': option.label, disabled: this.running, onchange: () => onchange(select.value) }, ...option.choices.map((c) => h('option', { value: c.value }, c.label)));
    select.value = value;
    return h('span', { class: 'select-wrap' }, select, icon('chevDown', 14, 2));
  }

  private row(job: Job): HTMLElement {
    job.row = h('li', { class: 'cv-file' });
    this.drawRow(job);
    return job.row;
  }

  /** A row: the file, its state on the right, then preview and download once converted, or remove. */
  private drawRow(job: Job): void {
    if (this.single) {
      // The card shows more than a row would; it is drawn anew, keeping its thumbnail and comparison.
      if (this.jobs[0] === job) this.queue.replaceChildren(...this.singleCard(job));
    } else if (job.row) {
      const shown = this.previewOpen && job === this.selected;
      job.row.dataset.status = job.status;
      job.row.classList.toggle('sel', shown);
      const actions = h('div', { class: 'cv-row-actions' });
      if (job.status !== 'detecting') actions.append(this.previewButton(job, shown));
      // A failed conversion offers its report right in the row; the others have it in the preview.
      const feedback = job.status === 'failed' && this.feedbackLink(job);
      if (feedback) actions.append(feedback);
      if (job.status === 'done') actions.append(this.downloadButton(job, false));
      else actions.append(h('button', { type: 'button', class: 'hb x', 'aria-label': `Remove ${job.file.name}`, title: 'Remove', disabled: job.status === 'working', onclick: () => this.remove(job) }, icon('close', 14, 2.2)));
      job.row.replaceChildren(
        this.thumb(job),
        h('div', { class: 'cv-txt' }, h('b', { title: job.file.name }, job.file.name), h('span', { class: 'cv-meta' }, this.info(job))),
        h('div', { class: 'cv-state' }, ...this.state(job)),
        actions,
      );
      this.foot?.replaceChildren(...this.actions());
    }
    if (job === this.selected) this.showPreview();
  }

  /** Format and size of the file as it came in. */
  private info(job: Job): string {
    const source = job.converter && sourceFor(job.converter, job.file.name);
    return [source?.label ?? job.kind, formatBytes(job.file.size)].filter(Boolean).join(' · ');
  }

  private previewButton(job: Job, shown: boolean): HTMLElement {
    const label = job.status === 'done' ? 'Compare input and output' : 'Preview';
    return h(
      'button',
      { type: 'button', class: 'hb cv-look', 'aria-pressed': String(shown), 'aria-label': `${label}: ${job.file.name}`, title: label, onclick: () => this.openPreview(job) },
      icon('eye', 16),
    );
  }

  /** The result of a file: as it is when there is one, several as a ZIP. */
  private downloadButton(job: Job, wide: boolean): HTMLElement {
    const files = job.result!.files;
    const target = this.targetOf(job);
    const size = formatBytes(files.reduce((sum, f) => sum + f.size, 0));
    const label = files.length === 1 ? `Download ${target?.label ?? ''}`.trim() : `Download ${plural(files.length, 'file', 'files')} (ZIP)`;
    return h(
      'button',
      {
        type: 'button',
        class: wide ? 'btn primary cv-wide' : 'btn sm cv-dl',
        title: files.length === 1 ? `Download ${files[0].name}` : `Download ${plural(files.length, 'file', 'files')} as a ZIP`,
        onclick: (event: MouseEvent) => this.save(files, `${baseName(job.file.name)}.zip`, event.currentTarget as HTMLButtonElement),
      },
      icon('download', wide ? 18 : 15),
      wide ? `${label} · ${size}` : h('span', { class: 'lbl' }, 'Download'),
    );
  }

  private targetOf(job: Job): TargetFormat | undefined {
    const settings = job.converter && this.settings.get(job.converter.id);
    return settings ? job.converter!.targets.find((t) => t.id === settings.target) : undefined;
  }

  private thumb(job: Job): HTMLElement {
    if (!job.thumb && !job.thumbUrl && THUMBNAILS.includes(extensionOf(job.file.name))) {
      job.thumbUrl = URL.createObjectURL(job.file);
      const picture = h('img', { src: job.thumbUrl, alt: '', decoding: 'async' });
      job.thumb = h('span', { class: 'cv-thumb checkerboard' }, picture);
      // A damaged picture or one this browser cannot show falls back to the icon.
      picture.addEventListener('error', () => {
        job.thumb = undefined;
        this.drawRow(job);
      });
    }
    if (job.thumb) return job.thumb;
    // Without a picture the file shows its extension, so it never looks like the icon of its kind above it.
    const ext = extensionOf(job.file.name);
    if (job.status !== 'unsupported' && ext && ext.length <= 4) return h('span', { class: 'cv-thumb ext' }, ext.toUpperCase());
    return h('span', { class: 'cv-thumb' }, icon(job.converter ? job.converter.icon : job.status === 'detecting' ? 'file' : 'alert', 18));
  }

  /** The right side of a row: waiting, progress, the result or what went wrong. */
  private state(job: Job): (Node | string)[] {
    switch (job.status) {
      case 'detecting':
        return [h('span', { class: 'spinner' }), 'Detecting …'];
      case 'ready':
        return ['Ready'];
      case 'unsupported':
        return ['No converter'];
      case 'failed':
        // One line in the row; the whole message is in the tooltip and in the preview.
        return [h('span', { class: 'cv-err', title: job.message }, icon('alert', 15, 1.8), h('span', {}, job.message))];
      case 'working':
        return [this.progress(job)];
      case 'done': {
        const files = job.result!.files;
        const total = files.reduce((sum, f) => sum + f.size, 0);
        const change = job.file.size > 0 && files.length === 1 ? percent.format(total / job.file.size - 1) : '';
        return [
          h(
            'span',
            { class: 'cv-done', title: files.map((f) => f.name).join('\n') },
            icon('check', 14, 2.4),
            files.length === 1 ? formatBytes(total) : `${plural(files.length, 'file', 'files')} · ${formatBytes(total)}`,
            change && h('span', { class: 'c3' }, change),
          ),
        ];
      }
    }
  }

  private progress(job: Job): HTMLElement {
    const determinate = job.fraction !== undefined && Number.isFinite(job.fraction);
    const bar = h('div', { class: determinate ? 'lc-bar' : 'lc-bar indet' }, h('div'));
    if (determinate) (bar.firstChild as HTMLElement).style.width = `${Math.round(Math.min(1, Math.max(0, job.fraction!)) * 100)}%`;
    return h('div', { class: 'cv-progress' }, h('span', { class: 'cv-progress-text' }, h('span', { class: 'spinner' }), job.message), bar);
  }

  /**
   * The foot of the panel: clearing, how far it is, and one main action at a time: converting while files wait, then
   * downloading. A single result downloads as itself ("Download JPG"), several as one ZIP.
   */
  private actions(): HTMLElement[] {
    const convertible = this.jobs.filter((job) => job.converter).length;
    const ready = this.jobs.filter((job) => job.status === 'ready').length;
    const done = this.jobs.filter((job) => job.status === 'done');
    const results = done.flatMap((job) => job.result!.files);
    const hint = this.running || (done.length > 0 && ready > 0) ? `${done.length} of ${convertible} done` : done.length > 0 && done.length === convertible ? `All ${convertible} converted` : 'Drop more files anywhere on the page';
    const downloadAll = (primary: boolean) => {
      const one = results.length === 1 ? this.targetOf(done[0]) : undefined;
      const label = one ? `Download ${one.label}` : primary ? `Download all · ${plural(results.length, 'file', 'files')} (ZIP)` : 'Download all';
      return h(
        'button',
        { type: 'button', class: primary ? 'btn primary' : 'btn', onclick: (event: MouseEvent) => this.save(results, 'converted.zip', event.currentTarget as HTMLButtonElement) },
        icon('download', 16),
        label,
      );
    };
    const actions = [h('button', { type: 'button', class: 'cv-ghost', disabled: this.running, onclick: () => this.clear() }, 'Clear list'), h('span', { class: 'cv-hint' }, hint)];
    if (this.running) {
      actions.push(h('button', { type: 'button', class: 'btn cv-busy', disabled: true }, h('span', { class: 'spinner' }), `Converting ${Math.min(convertible, done.length + 1)} of ${convertible} …`));
    } else if (ready > 0) {
      // Earlier results stay downloadable together while new files wait.
      if (results.length > 1) actions.push(downloadAll(false));
      actions.push(h('button', { type: 'button', class: 'btn primary', onclick: () => void this.convertAll() }, `Convert ${plural(ready, 'file', 'files')}`));
    } else if (results.length > 0) {
      actions.push(downloadAll(true));
    } else {
      actions.push(h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Convert'));
    }
    return actions;
  }

  // ---- Preview ------------------------------------------------------------------------------------------------------

  /** The viewers only run while the preview is open. */
  private showPreview(): void {
    this.preview.show(this.previewOpen && this.selected ? this.previewItem(this.selected) : null);
  }

  private previewItem(job: Job): PreviewItem {
    const converter = job.converter;
    const target = this.targetOf(job);
    const source = converter ? sourceFor(converter, job.file.name) : undefined;
    const outputs = job.status === 'done' && job.result ? job.result.files : null;
    const inputLabel = source?.label ?? (extensionOf(job.file.name).toUpperCase() || job.kind || 'File');
    // The comparison of input and output, once there is an output.
    const facts: PreviewItem['facts'] = [];
    if (outputs && target) {
      const total = outputs.reduce((sum, f) => sum + f.size, 0);
      const change = job.file.size > 0 ? ` (${percent.format(total / job.file.size - 1)})` : '';
      facts.push({ label: 'Format', input: inputLabel, output: target.label }, { label: 'File size', input: formatBytes(job.file.size), output: `${formatBytes(total)}${change}` });
      if (outputs.length > 1) facts.push({ label: 'Files', input: '1', output: String(outputs.length) });
    }
    return {
      key: job.id,
      file: job.file,
      viewer: job.viewer,
      sourceLabel: inputLabel,
      targetLabel: target?.label ?? '',
      kindLabel: converter?.label ?? (job.kind || 'Unknown format'),
      picture: converter?.id === 'image',
      outputs,
      status: this.previewStatus(job),
      report: this.report(job),
      facts,
      notes: [
        ...(target?.loss ? [{ text: `${target.label}: ${target.loss}`, warn: true }] : []),
        ...(source?.note ? [{ text: source.note, warn: false }] : []),
        ...(job.result?.notes ?? []).map((text) => ({ text, warn: false })),
      ],
    };
  }

  private previewStatus(job: Job): (Node | string)[] {
    switch (job.status) {
      case 'detecting':
        return [h('span', { class: 'spinner' }), 'Detecting format …'];
      case 'ready':
        return ['Output and Compare open once the file is converted.'];
      case 'unsupported':
        return ['No converter for this format yet. This is the file as it is.'];
      case 'working':
        return [this.progress(job)];
      case 'failed':
        return [h('span', { class: 'cv-err' }, icon('alert', 15, 1.8), h('span', {}, job.message))];
      case 'done':
        return [];
    }
  }

  /** One file downloads as it is, several as a ZIP. */
  private async save(files: File[], zipName: string, button: HTMLButtonElement): Promise<void> {
    if (files.length === 1) {
      download(files[0]);
      return;
    }
    const content = [...button.childNodes];
    button.disabled = true;
    button.replaceChildren('Packing …');
    try {
      download(await zipFiles(files, zipName));
    } catch (error) {
      console.error(error);
      window.alert(`The ZIP file could not be made: ${errorText(error)}`);
    } finally {
      button.disabled = false;
      button.replaceChildren(...content);
    }
  }
}
