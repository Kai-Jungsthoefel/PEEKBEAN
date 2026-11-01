// SPDX-License-Identifier: GPL-3.0-or-later
// Fetches TeX Live for the LaTeX viewer: the repository peekbean-texlive at the commit texlive.json names (about
// 1.9 GB, ready-made bundles, engine and formats). The build copies it into dist/texlive, the dev server serves it
// from where it is. Kept outside the project in ~/.cache/peekbean, or in the folder PEEKBEAN_TEXLIVE names (a clone
// of peekbean-texlive itself works too).
//
// node scripts/fetch-texlive.mjs      or      npm run texlive
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.join(import.meta.dirname, '..');
export const pin = JSON.parse(readFileSync(path.join(root, 'texlive.json'), 'utf8'));

/** The folder holding texlive/ (index.json, bundles, engine) */
export function texliveDir() {
  return process.env.PEEKBEAN_TEXLIVE ?? path.join(os.homedir(), '.cache', 'peekbean', `texlive-${pin.commit.slice(0, 12)}`);
}

export const hasTexlive = (dir = texliveDir()) => existsSync(path.join(dir, 'texlive', 'index.json'));

export function fetchTexlive(dir = texliveDir()) {
  if (hasTexlive(dir) && existsSync(path.join(dir, '.fetched'))) return dir;
  if (process.env.PEEKBEAN_TEXLIVE && hasTexlive(dir)) return dir;
  console.log(`Fetching TeX Live (${pin.repository} at ${pin.commit.slice(0, 12)}, about 1.9 GB) into ${dir} …`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'inherit' });
  git('init', '--quiet');
  // Only the one commit, without history
  git('fetch', '--quiet', '--depth', '1', `${pin.repository}.git`, pin.commit);
  git('-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD');
  rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  writeFileSync(path.join(dir, '.fetched'), `${pin.commit}\n`);
  return dir;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) fetchTexlive();
