// SPDX-License-Identifier: GPL-3.0-or-later
// Calendars (iCalendar .ics) and contacts (vCard .vcf) via ical.js (MPL-2.0), as a list of cards. Contact photos
// are shown only when the file contains them; photo links to the internet are never loaded.
import ICAL from 'ical.js';
import { h } from '../core/dom';
import { readText } from '../core/text';
import type { ViewerContext } from '../core/types';
import { guardLinks } from './paged';

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

const dateText = (t: Time) =>
  t.toJSDate().toLocaleString('en-US', t.isDate ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' });

function range(start: Time | null, end: Time | null): string {
  if (!start) return '';
  if (!end || end.compare(start) <= 0) return dateText(start);
  // All-day events end on the following day, exclusively.
  if (start.isDate && end.isDate) {
    const last = end.clone();
    last.adjust(-1, 0, 0, 0);
    return last.compare(start) === 0 ? dateText(start) : `${dateText(start)} – ${dateText(last)}`;
  }
  const sameDay = start.year === end.year && start.month === end.month && start.day === end.day;
  return sameDay
    ? `${dateText(start)} – ${end.toJSDate().toLocaleTimeString('en-US', { timeStyle: 'short' })}`
    : `${dateText(start)} – ${dateText(end)}`;
}

const mailto = (value: string) => value.replace(/^mailto:/i, '');

/** Label/value rows; empty values are left out. */
function rows(pairs: [string, string | Node | null | undefined][]): HTMLElement {
  const list = h('dl');
  for (const [label, value] of pairs) {
    if (value === null || value === undefined || value === '') continue;
    list.append(h('dt', {}, label), h('dd', {}, value));
  }
  return list;
}

function link(href: string, text = href): Node {
  return /^(https?|mailto|tel):/i.test(href) ? h('a', { href }, text) : document.createTextNode(text);
}

function eventCard(component: Component, kind: 'Event' | 'Task'): { when: number; card: HTMLElement } {
  const event = new ICAL.Event(component);
  const start: Time | null = kind === 'Event' ? event.startDate : (component.getFirstPropertyValue('due') as Time | null);
  const end: Time | null = kind === 'Event' ? event.endDate : null;
  const attendees = event.attendees.map((a) => {
    const name = a.getParameter('cn');
    const address = mailto(String(a.getFirstValue()));
    return name ? `${name} <${address}>` : address;
  });
  const rule = component.getFirstPropertyValue('rrule');
  const status = component.getFirstPropertyValue('status');
  const url = component.getFirstPropertyValue('url');
  const card = h(
    'div',
    { class: 'record' },
    h('div', { class: 'record-hd' }, h('b', {}, event.summary || '(No title)'), h('span', { class: 'when' }, `${kind === 'Task' && start ? 'Due ' : ''}${range(start, end)}`)),
    rows([
      ['Location', event.location],
      ['Organizer', event.organizer ? mailto(event.organizer) : null],
      ['Attendees', attendees.join('\n')],
      ['Repeats', rule ? String(rule) : null],
      ['Status', status ? String(status).toLowerCase() : null],
      ['Link', url ? link(String(url)) : null],
      ['Description', event.description],
    ]),
  );
  return { when: start ? start.toJSDate().getTime() : Number.MAX_SAFE_INTEGER, card };
}

function photo(card: Component): HTMLElement | null {
  const prop = card.getFirstProperty('photo');
  if (!prop) return null;
  const value = String(prop.getFirstValue() ?? '');
  const encoding = String(prop.getParameter('encoding') ?? '').toLowerCase();
  const type = String(prop.getParameter('type') ?? 'jpeg').toLowerCase().replace(/^image\//, '');
  let src: string | null = null;
  if (/^data:image\//i.test(value)) src = value;
  else if (encoding === 'b' || encoding === 'base64') src = `data:image/${type};base64,${value.replace(/\s/g, '')}`;
  return src ? h('img', { class: 'record-photo', src, alt: '' }) : null;
}

function contactCard(card: Component): { name: string; card: HTMLElement } {
  const values = (name: string) => card.getAllProperties(name).map((p) => ({ value: p.getFirstValue(), type: [p.getParameter('type')].flat().filter(Boolean).join(', ') }));
  const n = card.getFirstPropertyValue('n') as string[] | null;
  const name = String(card.getFirstPropertyValue('fn') ?? (n ? [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(' ') : '')) || '(No name)';
  const org = card.getFirstPropertyValue('org');
  const lines = (list: { value: unknown; type: string }[], toNode: (v: string) => Node | string) => {
    if (!list.length) return null;
    const box = h('span', { class: 'record-lines' });
    for (const { value, type } of list) box.append(h('span', {}, toNode(String(value)), type ? h('small', {}, ` ${type.toLowerCase()}`) : ''));
    return box;
  };
  const addresses = values('adr').map(({ value, type }) => ({
    // Structured: post box, extended, street, city, region, postal code, country.
    value: (Array.isArray(value) ? value : String(value).split(';')).flat().filter(Boolean).join(', '),
    type,
  }));
  const birthday = card.getFirstPropertyValue('bday');
  const element = h(
    'div',
    { class: 'record record-contact' },
    photo(card),
    h(
      'div',
      { class: 'record-main' },
      h('div', { class: 'record-hd' }, h('b', {}, name), h('span', { class: 'when' }, [card.getFirstPropertyValue('title'), Array.isArray(org) ? org.join(', ') : org].filter(Boolean).join(' · '))),
      rows([
        ['E-mail', lines(values('email'), (v) => link(`mailto:${v}`, v))],
        ['Phone', lines(values('tel'), (v) => link(v.startsWith('tel:') ? v : `tel:${v.replace(/[^\d+]/g, '')}`, v.replace(/^tel:/, '')))],
        ['Address', lines(addresses, (v) => v)],
        ['Website', lines(values('url'), (v) => link(v))],
        ['Birthday', birthday ? String(birthday) : null],
        ['Note', card.getFirstPropertyValue('note') as string | null],
      ]),
    ),
  );
  return { name, card: element };
}

export async function mount({ file, container, toolbar }: ViewerContext) {
  const { text } = await readText(file);
  let parsed: unknown[];
  try {
    parsed = ICAL.parse(text);
  } catch (error) {
    throw new Error(`The file could not be read: ${error instanceof Error ? error.message : error}`);
  }
  // One component parses to [name, properties, children], several to a list of them.
  const roots = (typeof parsed[0] === 'string' ? [parsed] : parsed).map((jcal) => new ICAL.Component(jcal as unknown[]));
  const list = h('div', { class: 'records-list' });

  const calendars = roots.filter((c) => c.name === 'vcalendar');
  if (calendars.length) {
    for (const cal of calendars) {
      // Time zones defined in the file make local times convert correctly.
      for (const zone of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(new ICAL.Timezone(zone));
    }
    const items = calendars.flatMap((cal) => [
      ...cal.getAllSubcomponents('vevent').map((e) => eventCard(e, 'Event')),
      ...cal.getAllSubcomponents('vtodo').map((t) => eventCard(t, 'Task')),
    ]);
    items.sort((a, b) => a.when - b.when);
    list.append(...items.map((i) => i.card));
    const name = calendars[0].getFirstPropertyValue('x-wr-calname');
    toolbar.append(h('span', { class: 'meta' }, `${name ? `${name} · ` : ''}${items.length} ${items.length === 1 ? 'entry' : 'entries'}`));
    if (!items.length) list.append(h('p', { class: 'records-empty' }, 'The calendar contains no events or tasks.'));
  } else {
    const contacts = roots.filter((c) => c.name === 'vcard').map(contactCard);
    if (!contacts.length) throw new Error('The file contains neither calendar entries nor contacts.');
    contacts.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    list.append(...contacts.map((c) => c.card));
    toolbar.append(h('span', { class: 'meta' }, `${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'}`));
  }
  guardLinks(list);
  container.append(h('div', { class: 'records' }, list));
  return { destroy: () => {} };
}
