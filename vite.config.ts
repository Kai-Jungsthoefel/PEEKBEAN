// SPDX-License-Identifier: GPL-3.0-or-later
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin, type PluginOption } from 'vite';
import license, { type Dependency } from 'rollup-plugin-license';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { findPair, PAIRS, pairPage } from './src/convert/catalog';
import { converterPageHtml } from './src/convert/prerender';
import { findFormatPage, FORMAT_PAGES, formatPagePath } from './src/format-pages';
import { pageUrl, SITE_URL, viewerPageHtml } from './src/prerender';

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
  ['Rust crates in jxl_oxide_wasm_bg.wasm (JPEG XL decoder)', 'licenses/jxl-oxide.txt'],
  ['C++ libraries compiled into web-ifc.wasm', 'licenses/web-ifc.txt'],
  // Both are fetched at run time (rhino3dm/, basis/), so the module graph never sees them.
  ['rhino3dm 8.32.1 (rhino3dm.js, rhino3dm.wasm)', 'licenses/rhino3dm.txt'],
  ['Basis Universal transcoder (basis_transcoder.js, basis_transcoder.wasm, shipped with three.js)', 'licenses/basis-universal.txt'],
  // Bundled into @tracespace/parser's own build, so the module graph only sees the parser.
  ['moo 0.5 (lexer, bundled in @tracespace/parser)', 'licenses/moo.txt'],
  // The npm package of laz-perf declares Apache-2.0 but ships no license text.
  ['laz-perf 0.0.7 (laz-perf.wasm)', 'licenses/laz-perf.txt'],
  ['Lucide icons (GitHub mark and star in src/core/icons.ts)', 'licenses/lucide.txt'],
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
    name: 'peekbean:csp',
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

/**
 * The header shows how many stars the repository has. They are counted while building, so the page itself never
 * asks GitHub; without network or while the repository is private, the link shows no count.
 */
function githubStars(): Plugin {
  return {
    name: 'peekbean:github-stars',
    apply: 'build',
    async config() {
      const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(sourceUrl)?.[1];
      if (!repo) return;
      try {
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
        // CI can pass its token to avoid the low rate limit for anonymous requests.
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        const response = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { stargazers_count: stars } = await response.json();
        if (typeof stars === 'number') return { define: { __GITHUB_STARS__: JSON.stringify(stars) } };
      } catch (error) {
        console.warn(`GitHub star count not available (${error instanceof Error ? error.message : error}); the header shows the link without it.`);
      }
    },
  };
}

/**
 * Pages that searches find: the viewer has one per common format (dwg-viewer.html …, src/format-pages.ts), the
 * converter one per conversion (jpg-to-png.html …). Each is the built index.html or convert.html with its own title,
 * description and content (src/prerender.ts, src/convert/prerender.ts) and the format in <html data-view> or the
 * conversion in <html data-convert>. They sit next to index.html, so every relative path of the build works for them
 * unchanged. The dev server makes them on request.
 */
function landingPages(): Plugin {
  let outDir = path.join(root, 'dist');
  let building = false;
  return {
    name: 'peekbean:landing-pages',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      building = config.command === 'build';
    },
    transformIndexHtml: {
      order: 'pre',
      // index.html and convert.html become the general pages; the pages of single formats and conversions are already
      // filled in.
      handler: (html, { path: page }) => {
        if (!html.includes('<!--prerender-->') || /<html [^>]*data-(?:view|convert)=/.test(html)) return html;
        return page.endsWith('/convert.html') ? converterPageHtml(html, null) : viewerPageHtml(html, null);
      },
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = /^\/([a-z0-9-]+)\.html(?:\?|$)/.exec(req.url ?? '')?.[1] ?? '';
        const pair = findPair(name);
        const format = findFormatPage(/^(.+)-viewer$/.exec(name)?.[1] ?? '');
        if (!pair && !format) return next();
        const html = pair
          ? converterPageHtml(readFileSync(path.join(root, 'convert.html'), 'utf8'), pair)
          : viewerPageHtml(readFileSync(path.join(root, 'index.html'), 'utf8'), format!);
        server.transformIndexHtml(req.url!, html).then((page) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(page);
        }, next);
      });
    },
    closeBundle() {
      if (!building) return;
      const viewer = readFileSync(path.join(outDir, 'index.html'), 'utf8');
      for (const format of FORMAT_PAGES) writeFileSync(path.join(outDir, formatPagePath(format)), viewerPageHtml(viewer, format));
      const converter = readFileSync(path.join(outDir, 'convert.html'), 'utf8');
      for (const pair of PAIRS) writeFileSync(path.join(outDir, pairPage(pair)), converterPageHtml(converter, pair));
      // Conversions marked noindex stay out of the sitemap as well.
      const pages = ['index.html', 'convert.html', ...FORMAT_PAGES.map(formatPagePath), ...PAIRS.filter((p) => p.indexed).map(pairPage)];
      const today = new Date().toISOString().slice(0, 10);
      const urls = pages.map((page) => `  <url><loc>${pageUrl(page)}</loc><lastmod>${today}</lastmod></url>`);
      writeFileSync(path.join(outDir, 'sitemap.xml'), ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n'));
      writeFileSync(path.join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    },
  };
}

function warnMissingSourceUrl(): Plugin {
  return {
    name: 'peekbean:source-url',
    apply: 'build',
    buildStart() {
      if (!sourceUrl) {
        this.warn('package.json has no "repository" — set it before publishing, the GPL requires a link to the source.');
      }
    },
  };
}

/** Replaces each pattern exactly once; fails the build when a library update moved the code a patch relies on. */
function patch(code: string, library: string, replacements: [string, string][]): string {
  for (const [pattern, replacement] of replacements) {
    if (code.split(pattern).length !== 2) throw new Error(`${library} changed: the embind eval patch in vite.config.ts no longer applies.`);
    code = code.replace(pattern, () => replacement);
  }
  return code;
}

/**
 * Emscripten's default DYNAMIC_EXECUTION=1 makes embind build its call wrappers with `new Function`, which our CSP
 * forbids (no 'unsafe-eval'). These swap in generic wrappers like the ones Emscripten itself emits with
 * DYNAMIC_EXECUTION=0. Same behavior, a little slower per call.
 *
 * The first set fits the Emscripten version of occt-import-js and of the Basis Universal transcoder.
 */
const INVOKER = 'var invokerFn=newFunc(Function,args)(...closureArgs);';
const GENERIC_INVOKER = `var invokerFn=(function(){var expected=argCount-2;var argsWired=new Array(expected);var destructors=[];return function(...callArgs){if(callArgs.length!==expected){throwBindingError(\`function \${humanName} called with \${callArgs.length} arguments, expected \${expected}\`)}destructors.length=0;var thisWired;var invokerArgs=[cppTargetFunc];if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);invokerArgs.push(thisWired)}for(var i=0;i<expected;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,callArgs[i]);invokerArgs.push(argsWired[i])}var rv=cppInvokerFunc(...invokerArgs);var done=function(rv){if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;i++){var param=i===1?thisWired:argsWired[i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(param)}}}if(returns){return argTypes[0].fromWireType(rv)}};return isAsync?rv.then(done):done(rv)}})();`;
const METHOD_CALLER = 'var invokerFunction=newFunc(Function,params)(...args);';
const GENERIC_METHOD_CALLER = 'var invokerFunction=(obj,func,destructorsRef,ptr)=>{var off=0;var argN=[];for(var j=0;j<argCount;++j){argN.push(types[j].readValueFromPointer(ptr+off));off+=types[j].argPackAdvance}var rv=kind===1?new func(...argN):func.call(...(kind===0?[obj,...argN]:argN));return retType.isVoid?undefined:emval_returnValue(retType,destructorsRef,rv)};';
const embindWithoutEval = (code: string, library: string) => patch(code, library, [[INVOKER, GENERIC_INVOKER], [METHOD_CALLER, GENERIC_METHOD_CALLER]]);

/**
 * rhino3dm comes from a newer Emscripten: createJsInvoker returns the source of a factory, and emval method callers
 * are built from captured helpers. Both become plain closures over the same values.
 */
const RHINO_INVOKER = 'return new Function(args1,invokerFnBody)}';
const RHINO_GENERIC_INVOKER = 'return function(humanName,throwBindingError,invoker,fn,runDestructors,fromRetWire,toClassParamWire,...rest){var toArgWire=rest.slice(0,argCount);var dtors=rest.slice(argCount);return function(...callArgs){var destructors=needsDestructorStack?[]:null;var thisWired;var argsWired=[];var wired=[fn];if(isClassMethodFunc){thisWired=toClassParamWire(destructors,this);wired.push(thisWired)}for(var i=0;i<argCount;++i){argsWired.push(toArgWire[i](destructors,callArgs[i]));wired.push(argsWired[i])}var rv=invoker(...wired);if(needsDestructorStack){runDestructors(destructors)}else{var d=0;for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null){dtors[d++](i===1?thisWired:argsWired[i-2])}}}if(returns){return fromRetWire(rv)}}}}';
const RHINO_METHOD_CALLER = 'var invokerFunction=new Function(Object.keys(captures),functionBody)(...Object.values(captures));';
const RHINO_GENERIC_METHOD_CALLER = 'var invokerFunction=function(handle,methodName,destructorsRef,args){var a=argFromPtr.map((read,i)=>read(args+i*GenericWireTypeSize));var rv=kind===0?Emval.toValue(handle)(...a):kind===2?new(Emval.toValue(handle))(...a):kind===1?Emval.toValue(handle)[getStringOrSymbol(methodName)](...a):a[a.length-1];return retType.isVoid?undefined:emval_returnValue(toReturnWire,destructorsRef,rv)};';
const rhinoWithoutEval = (code: string) =>
  patch(code, 'rhino3dm', [[RHINO_INVOKER, RHINO_GENERIC_INVOKER], [RHINO_METHOD_CALLER, RHINO_GENERIC_METHOD_CALLER]]);

function occtWithoutEval(): Plugin {
  return {
    name: 'peekbean:occt-without-eval',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('occt-import-js/dist/occt-import-js.js')) return null;
      return { code: embindWithoutEval(code, 'occt-import-js'), map: null };
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
    name: 'peekbean:license-report',
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

// Lazily loaded chunks are named after what they are (assets/viewer.dwg-<hash>.js, assets/lang.python-<hash>.js),
// so Cloudflare's request counts per path tell which viewers, converters and formats people use.
// The first matching pattern wins; chunks shared by several modules keep Rolldown's name.
const CHUNK_NAMES: [RegExp, string][] = [
  [/\/src\/viewers\/([\w-]+)\.ts$/, 'viewer.$1'],
  // Parts a viewer loads only for some of its formats, e.g. viewer.ebook.epub.
  [/\/src\/viewers\/([\w-]+)\/([\w-]+)\.ts$/, 'viewer.$1.$2'],
  [/\/src\/convert\/converters\/([\w-]+)\.ts$/, 'convert.$1'],
  // Readers and writers per format, e.g. convert.database.write-xlsx.
  [/\/src\/convert\/([\w-]+)\/([\w-]+)\.ts$/, 'convert.$1.$2'],
  [/\/src\/metadata\/([\w-]+)\.ts$/, 'meta.$1'],
  [/\/src\/workers\/([\w-]+)\.ts$/, 'worker.$1'],
  // Syntax highlighting in the text viewer, one chunk per language.
  [/\/node_modules\/@codemirror\/(?:lang-|legacy-modes\/mode\/)([\w-]+)[/.]/, 'lang.$1'],
  [/\/node_modules\/three\/examples\/jsm\/loaders\/(\w+)\.js$/, 'lib.three.$1'],
  // Other packages by name, without the scope: lib.libheif-js, lib.zip.js.
  [/\/node_modules\/(?:@[\w.-]+\/)?([\w.-]+)\//, 'lib.$1'],
];

function chunkFileNames(chunk: { facadeModuleId: string | null }): string {
  const id = chunk.facadeModuleId?.replace(/\\/g, '/') ?? '';
  for (const [pattern, name] of CHUNK_NAMES) {
    const match = pattern.exec(id);
    if (match) return `assets/${match[0].replace(pattern, name)}-[hash].js`;
  }
  return 'assets/[name]-[hash].js';
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
    __SOURCE_URL__: JSON.stringify(sourceUrl),
    // Set by githubStars() when building.
    __GITHUB_STARS__: 'null',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    // The viewer and the converter; the pages per format and per conversion are copies of these two (landingPages).
    rolldownOptions: {
      input: { main: path.join(root, 'index.html'), convert: path.join(root, 'convert.html') },
      output: { chunkFileNames },
    },
  },
  worker: {
    format: 'es',
    plugins: sharedPlugins,
    rolldownOptions: { output: { chunkFileNames } },
  },
  resolve: {
    alias: [
      // mdb-reader's browser build hashes and decrypts (password-protected .accdb) with Node polyfills that need Node's
      // stream module; these stand-ins do the same with @noble. Nothing else in the app imports either package.
      { find: /^create-hash$/, replacement: path.join(root, 'src/workers/mdb-hash.ts') },
      { find: /^browserify-aes\/browser\.js$/, replacement: path.join(root, 'src/workers/mdb-aes.ts') },
    ],
  },
  // Dependencies only a worker imports: the dev server would find them late, re-bundle its dependencies and leave
  // the running worker with outdated URLs. Bundling them at startup avoids that.
  optimizeDeps: {
    include: [
      'utif2', 'ag-psd', 'decode-dxt', 'libheif-js/libheif-wasm/libheif-bundle.mjs', 'occt-import-js', 'xlsx', 'xlsx/dist/cpexcel.full',
      'dxf-viewer', 'dxf-viewer/src/DxfScene.js', '@zip.js/zip.js', 'web-ifc',
      'three/addons/loaders/DDSLoader.js', 'three/addons/loaders/EXRLoader.js', 'three/addons/loaders/HDRLoader.js', 'three/addons/loaders/TGALoader.js',
      '@tracespace/parser', '@tracespace/plotter', '@tracespace/identify-layers', 'shpjs', 'proj4', 'topojson-client',
      'jxl-oxide-wasm', 'laz-perf/lib/worker/laz-perf.js', 'fzstd',
      'mdb-reader', 'buffer', '@noble/hashes/legacy', '@noble/hashes/sha2', '@noble/ciphers/aes.js',
    ],
  },
  // Lets `npm run preview` behave like a host that sends the CSP as a header (workers included).
  preview: {
    headers: { 'Content-Security-Policy': CSP },
  },
  plugins: [
    contentSecurityPolicy(),
    landingPages(),
    warnMissingSourceUrl(),
    githubStars(),
    // pdf.js fetches these on demand; serving them ourselves keeps PDFs from triggering CDN requests.
    // Likewise the Rhino reader and the KTX2 (Basis Universal) transcoder, which three.js loads by URL into workers.
    viteStaticCopy({
      targets: [
        ...['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((dir) => ({
          src: `node_modules/pdfjs-dist/${dir}`,
          dest: 'pdfjs',
          rename: { stripBase: 2 },
        })),
        { src: 'node_modules/rhino3dm/rhino3dm.wasm', dest: 'rhino3dm', rename: { stripBase: true } },
        { src: 'node_modules/rhino3dm/rhino3dm.js', dest: 'rhino3dm', rename: { stripBase: true }, transform: (content: string) => rhinoWithoutEval(content) },
        { src: 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm', dest: 'basis', rename: { stripBase: true } },
        {
          src: 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.js',
          dest: 'basis',
          rename: { stripBase: true },
          transform: (content: string) => embindWithoutEval(content, 'basis_transcoder'),
        },
      ],
    }),
    ...sharedPlugins(),
    licenseReport(),
  ],
});
