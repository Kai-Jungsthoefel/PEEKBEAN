// SPDX-License-Identifier: GPL-3.0-or-later
// E-mails (.eml and Outlook .msg) to EML, to a web page, or to a ZIP of their attachments. The messages are read by
// the e-mail viewer's reader (viewers/email/read.ts); the writers are in convert/email/.
import { isOutlookMessage, picturesInBody, readMail, type Mail } from '../../viewers/email/read';
import { bodyOf } from '../email/body';
import { encrypted, mailToEml, smimeAttachment } from '../email/eml';
import { mailPage } from '../email/html';
import { resultName, zipFiles } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A name that is safe as a ZIP entry on every system: no folders, no characters Windows refuses. */
function entryName(name: string, index: number): string {
  const safe = name
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!safe) return `attachment-${index + 1}`;
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe) ? `_${safe}` : safe;
}

async function attachments(file: File, mail: Mail, progress: ConvertContext['progress']): Promise<ConvertResult> {
  const body = await bodyOf(mail);
  const shown = picturesInBody({ html: body.html, attachments: mail.attachments });
  let list = mail.attachments.filter((a) => !shown.has(a));
  const notes: string[] = [];
  if (list.length === 0) {
    if (shown.size === 0) throw new Error('This e-mail has no attachments.');
    // Nothing but the pictures of the text: those are what the user is after then.
    list = [...shown];
    notes.push(`The e-mail has no attachments; the ZIP holds the ${plural(shown.size, 'picture', 'pictures')} shown in its text.`);
  } else if (shown.size > 0) {
    notes.push(`${plural(shown.size, 'picture', 'pictures')} shown in the text of the e-mail ${shown.size === 1 ? 'is' : 'are'} left out.`);
  }
  if (mail.skipped.length) notes.push(`Left out, as they hold no file (embedded objects or links): ${mail.skipped.join(', ')}.`);
  progress(`Packing ${plural(list.length, 'attachment', 'attachments')} …`, 0.6);
  const files = list.map((a, i) => new File([a.data as Uint8Array<ArrayBuffer>], entryName(a.name, i), { type: a.mimeType }));
  return { files: [await zipFiles(files, resultName(file.name, 'zip', 'attachments'))], notes };
}

export async function convert({ file, target, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading e-mail …', 0);
  const buffer = await file.arrayBuffer();
  const outlook = isOutlookMessage(file.name, new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength)));
  if (target === 'eml' && !outlook) return { files: [file], notes: ['The file is an EML file already and stays as it is.'] };
  let mail = await readMail(file.name, buffer);

  if (target === 'eml') {
    progress('Writing EML …', 0.4);
    const eml = await mailToEml(mail);
    return { files: [new File(eml.chunks as BlobPart[], resultName(file.name, 'eml'), { type: 'message/rfc822' })], notes: eml.notes };
  }

  const notes: string[] = [];
  const smime = smimeAttachment(mail);
  if (smime && encrypted(smime)) {
    notes.push('The message is encrypted (S/MIME); its text and attachments can only be read with the key of a recipient.');
  } else if (smime) {
    // A signed Outlook message keeps its text in the signed MIME entity: it is read from the EML it makes.
    const eml = await mailToEml(mail);
    mail = await readMail('message.eml', await new Blob(eml.chunks as BlobPart[]).arrayBuffer());
  }

  if (target === 'attachments') {
    const result = await attachments(file, mail, progress);
    return { files: result.files, notes: [...notes, ...result.notes] };
  }

  progress('Reading the message text …', 0.3);
  const body = await bodyOf(mail);
  progress('Writing web page …', 0.7);
  const page = mailPage(mail, body);
  if (page.blocked > 0) notes.push('External images and content were blocked; the page never loads anything from the internet.');
  return { files: [new File([page.html], resultName(file.name, 'html'), { type: 'text/html' })], notes: [...notes, ...body.notes] };
}
