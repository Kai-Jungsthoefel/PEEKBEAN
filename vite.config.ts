// SPDX-License-Identifier: GPL-3.0-or-later
import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import license from 'rollup-plugin-license';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// GPL-3.0 requires every visitor to be able to get the exact source of what they ran.
const sourceUrl: string = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unversioned';
  }
}

// Licenses that may end up in the shipped bundle. Everything here is compatible with GPL-3.0-or-later.
const ALLOWED_LICENSES = [
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Zlib', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0',
  'Apache-2.0', 'MPL-2.0', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  // Fonts (IBM Plex). The OFL allows bundling fonts with software under any license.
  'OFL-1.1',
];

const LICENSE_REPORT = path.resolve(import.meta.dirname, 'dist/third-party-licenses.txt');

// Packages that only ship CSS and fonts never show up in the JS module graph the license plugin scans.
const CSS_ONLY_PACKAGES = ['@fontsource/ibm-plex-sans', '@fontsource/ibm-plex-mono'];

function cssPackageLicenses(): Plugin {
  return {
    name: 'everythingviewer:css-licenses',
    apply: 'build',
    closeBundle() {
      const entries = CSS_ONLY_PACKAGES.map((name) => {
        const dir = path.resolve(import.meta.dirname, 'node_modules', name);
        const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (!ALLOWED_LICENSES.includes(meta.license)) {
          throw new Error(`${name} is licensed ${meta.license}, which is not on the allowlist.`);
        }
        const text = readFileSync(path.join(dir, 'LICENSE'), 'utf8').trim();
        return `Name: ${name}\nVersion: ${meta.version}\nLicense: ${meta.license}\nLicense Text:\n===\n\n${text}\n`;
      });
      appendFileSync(LICENSE_REPORT, `\n---\n\n${entries.join('\n---\n\n')}`);
    },
  };
}

// The page must not be able to talk to any server but its own origin; that is the privacy promise.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Only for production builds: the dev server needs inline scripts and a websocket for HMR.
function contentSecurityPolicy(): Plugin {
  return {
    name: 'everythingviewer:csp',
    apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }];
    },
  };
}

function warnMissingSourceUrl(): Plugin {
  return {
    name: 'everythingviewer:source-url',
    apply: 'build',
    buildStart() {
      if (!sourceUrl) {
        this.warn('package.json has no "repository" — set it before publishing, the GPL requires a link to the source.');
      }
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
    __SOURCE_URL__: JSON.stringify(sourceUrl),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  plugins: [
    contentSecurityPolicy(),
    warnMissingSourceUrl(),
    // pdf.js fetches these on demand; serving them ourselves keeps PDFs from triggering CDN requests.
    viteStaticCopy({
      targets: ['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((dir) => ({
        src: `node_modules/pdfjs-dist/${dir}`,
        dest: 'pdfjs',
        rename: { stripBase: 2 },
      })),
    }),
    {
      ...license({
        thirdParty: {
          allow: {
            test: `(${ALLOWED_LICENSES.join(' OR ')})`,
            failOnUnlicensed: true,
            failOnViolation: true,
          },
          output: { file: LICENSE_REPORT },
        },
      }),
      apply: 'build',
    },
    cssPackageLicenses(),
  ],
});
