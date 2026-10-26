// SPDX-License-Identifier: GPL-3.0-or-later
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin, type PluginOption } from 'vite';
import license, { type Dependency } from 'rollup-plugin-license';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

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
  'Apache-2.0', 'MPL-2.0',
  // LGPL-2.1 code may be relicensed to GPL-2.0-or-later, LGPL-3.0 to GPL-3.0.
  'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  // Fonts (IBM Plex). The OFL allows bundling fonts with software under any license.
  'OFL-1.1',
];

// Packages that only ship CSS and fonts never show up in the JS module graph the license plugin scans.
const CSS_ONLY_PACKAGES = ['@fontsource/ibm-plex-sans', '@fontsource/ibm-plex-mono'];

// License texts of native code compiled to WebAssembly, which no package.json describes completely.
const EXTRA_NOTICES = [
  ['OpenCascade (in occt-import-js.wasm)', 'node_modules/occt-import-js/dist/license.occt.txt'],
  ['pdf.js decoders (OpenJPEG, JBIG2, QCMS)', 'node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG'],
  ['acadrust and Rust crates (in dwg2dxf.wasm)', 'src/wasm/dwg2dxf/THIRD_PARTY_LICENSES.txt'],
  ['libarchive and compression libraries (in libarchive.wasm)', 'src/wasm/libarchive/THIRD_PARTY_LICENSES.txt'],
];

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
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The CSP goes into the page as a meta tag, and into _headers in the output folder for hosts that read that file
 * (Netlify, Cloudflare Pages). Only an HTTP header also covers the web workers.
 */
function contentSecurityPolicy(): Plugin {
  let outDir = path.join(root, 'dist');
  return {
    name: 'everythingviewer:csp',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }];
    },
    closeBundle() {
      const headers = [`/*`, `  Content-Security-Policy: ${CSP}`, '  X-Content-Type-Options: nosniff', '  Referrer-Policy: no-referrer', ''];
      writeFileSync(path.join(outDir, '_headers'), headers.join('\n'));
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

/**
 * occt-import-js was compiled with Emscripten's default DYNAMIC_EXECUTION=1: embind builds its call
 * wrappers with `new Function`, which our CSP forbids (no 'unsafe-eval'). This swaps in the generic
 * wrapper Emscripten itself emits with DYNAMIC_EXECUTION=0. Same behavior, a little slower per call.
 */
function occtWithoutEval(): Plugin {
  const INVOKER = 'var invokerFn=newFunc(Function,args)(...closureArgs);';
  const GENERIC_INVOKER = `var invokerFn=(function(){var expected=argCount-2;var argsWired=new Array(expected);var destructors=[];return function(...callArgs){if(callArgs.length!==expected){throwBindingError(\`function \${humanName} called with \${callArgs.length} arguments, expected \${expected}\`)}destructors.length=0;var thisWired;var invokerArgs=[cppTargetFunc];if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);invokerArgs.push(thisWired)}for(var i=0;i<expected;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,callArgs[i]);invokerArgs.push(argsWired[i])}var rv=cppInvokerFunc(...invokerArgs);var done=function(rv){if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;i++){var param=i===1?thisWired:argsWired[i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(param)}}}if(returns){return argTypes[0].fromWireType(rv)}};return isAsync?rv.then(done):done(rv)}})();`;
  const METHOD_CALLER = 'var invokerFunction=newFunc(Function,params)(...args);';
  const GENERIC_METHOD_CALLER = 'var invokerFunction=(obj,func,destructorsRef,ptr)=>{var off=0;var argN=[];for(var j=0;j<argCount;++j){argN.push(types[j].readValueFromPointer(ptr+off));off+=types[j].argPackAdvance}var rv=kind===1?new func(...argN):func.call(...(kind===0?[obj,...argN]:argN));return retType.isVoid?undefined:emval_returnValue(retType,destructorsRef,rv)};';
  return {
    name: 'everythingviewer:occt-without-eval',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('occt-import-js/dist/occt-import-js.js')) return null;
      for (const pattern of [INVOKER, METHOD_CALLER]) {
        if (!code.includes(pattern)) throw new Error('occt-import-js changed: the embind eval patch in vite.config.ts no longer applies.');
      }
      return { code: code.replace(INVOKER, GENERIC_INVOKER).replace(METHOD_CALLER, GENERIC_METHOD_CALLER), map: null };
    },
  };
}

// Vite bundles each web worker in a separate build. Every build reports its dependencies here,
// so the license check and the report cover the workers too.
const dependencies = new Map<string, Dependency>();

function licenseCheck(): Plugin {
  return {
    ...license({
      thirdParty: {
        allow: { test: `(${ALLOWED_LICENSES.join(' OR ')})`, failOnUnlicensed: true, failOnViolation: true },
        output: (found) => found.forEach((d) => dependencies.set(`${d.name}@${d.version}`, d)),
      },
    }),
    apply: 'build',
  } as Plugin;
}

function licenseReport(): Plugin {
  let outDir = path.join(root, 'dist');
  return {
    name: 'everythingviewer:license-report',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const entries = [...dependencies.values()]
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
        .map((d) => `Name: ${d.name}\nVersion: ${d.version}\nLicense: ${d.license}\n\n${(d.licenseText ?? '').trim()}${d.noticeText ? `\n\n${d.noticeText.trim()}` : ''}`);
      for (const name of CSS_ONLY_PACKAGES) {
        if ([...dependencies.values()].some((d) => d.name === name)) continue;
        const dir = path.join(root, 'node_modules', name);
        const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (!ALLOWED_LICENSES.includes(meta.license)) throw new Error(`${name} is licensed ${meta.license}, which is not on the allowlist.`);
        entries.push(`Name: ${name}\nVersion: ${meta.version}\nLicense: ${meta.license}\n\n${readFileSync(path.join(dir, 'LICENSE'), 'utf8').trim()}`);
      }
      for (const [title, file] of EXTRA_NOTICES) {
        const full = path.join(root, file);
        if (existsSync(full)) entries.push(`${title}\n\n${readFileSync(full, 'utf8').trim()}`);
      }
      writeFileSync(path.join(outDir, 'third-party-licenses.txt'), `${entries.join('\n\n---\n\n')}\n`);
    },
  };
}

const sharedPlugins = (): PluginOption[] => [licenseCheck(), occtWithoutEval()];

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
  worker: {
    format: 'es',
    plugins: sharedPlugins,
  },
  // Lets `npm run preview` behave like a host that sends the CSP as a header (workers included).
  preview: {
    headers: { 'Content-Security-Policy': CSP },
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
    ...sharedPlugins(),
    licenseReport(),
  ],
});
