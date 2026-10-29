// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A lazily loaded part could not be fetched. Almost always the site was deployed
 * while the page was open: the hashed file names changed and the old ones are gone.
 * Chrome, Firefox and Safari word it differently; Vite's own message covers CSS.
 */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}

export const STALE_CHUNK_MESSAGE = 'Peekbean was updated since this page was opened. Reload the page and open the file again.';

/** The message to show for an error, with the cryptic module error replaced. */
export function errorText(error: unknown): string {
  if (isStaleChunkError(error)) return STALE_CHUNK_MESSAGE;
  return error instanceof Error ? error.message : String(error);
}
