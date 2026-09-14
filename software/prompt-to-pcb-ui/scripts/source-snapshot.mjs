/** Shared source-only staging primitives. Inspection does not execute app code. */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';

export const SOURCE = '/Users/jackal-kahwati/EE-lab/software/prompt-to-pcb-ui';
export const SCRATCH = '/Volumes/T9 Backup/compose-ux-tmp-bQ4c59';
export const LIMIT = Object.freeze({ fileBytes: 2 * 1024 ** 2, sourceBytes: 16 * 1024 ** 2,
  sourceFiles: 1000, outputBytes: 768 * 1024 ** 2, logBytes: 8 * 1024 ** 2,
  minFreeBytes: 2 * 1024 ** 3, wallMs: 8 * 60_000, prepareMs: 30_000,
  nodeHeapMiB: 2048, pollMs: 1000 });
const ROOT_FILES = ['package.json', 'pnpm-lock.yaml', 'next.config.mjs',
  'postcss.config.mjs', 'tsconfig.json', 'proxy.ts', 'instrumentation.ts'];
const TREES = ['app', 'components', 'lib'];
const EXT = /\.(?:tsx?|mts|cts|mjs|cjs|js|json|css|svg|ico|png|jpe?g|woff2?)$/;
export const EXCLUDED = ['public (entire tree, including runs symlink)', 'data', 'env and dotfiles',
  'all source symlinks', 'all caches', 'tests', 'scripts except exact approved extras', 'deploy', 'docs', 'website and other repos'];
export const hash = b => createHash('sha256').update(b).digest('hex');
export const fail = message => { throw new Error(message); };

export function cleanRelative(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(s => !s || s === '..' || s.startsWith('.'))) fail(`Unsafe relative path: ${relative}`);
  return relative;
}
export function noLinks(absolute) {
  if (!path.isAbsolute(absolute)) fail('Expected an absolute path');
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail(`Symlink path rejected: ${cursor}`);
  }
}
export function safeRead(root, relative, maxBytes = LIMIT.fileBytes) {
  cleanRelative(relative);
  const absolute = path.join(root, relative);
  noLinks(absolute);
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) fail(`Oversize/non-file input: ${relative}`);
    const chunks = []; let length = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - length));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      length += count;
      if (length > maxBytes) fail(`Input grew beyond read limit: ${relative}`);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, length);
  } finally { fs.closeSync(fd); }
}
export function inventory({ source = SOURCE, extraFiles = [] } = {}) {
  const started = Date.now(), files = new Map();
  let totalBytes = 0;
  function add(relative) {
    if (Date.now() - started > LIMIT.prepareMs) fail('Source inspection time cap reached');
    if (files.has(relative)) fail(`Duplicate inventory entry: ${relative}`);
    const bytes = safeRead(source, relative);
    files.set(relative, bytes); totalBytes += bytes.length;
    if (files.size > LIMIT.sourceFiles || totalBytes > LIMIT.sourceBytes) fail('Source snapshot budget exceeded');
  }
  function walk(relative) {
    noLinks(path.join(source, relative));
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const next = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`Source symlink rejected without reading: ${next}`);
      if (entry.isDirectory()) walk(next);
      else if (EXT.test(entry.name)) add(next);
      else fail(`Unreviewed source extension: ${next}`);
    }
  }
  for (const relative of ROOT_FILES) add(relative);
  for (const tree of TREES) walk(tree);
  // The caller owns the exact reviewed list. Never expand directories here.
  for (const relative of extraFiles) add(cleanRelative(relative));
  return files;
}
export function inspectImports(files, source = SOURCE) {
  const require = createRequire(path.join(source, 'package.json'));
  const ts = require('typescript'), packages = new Set(), fonts = [], outside = [], unresolved = [];
  for (const [relative, bytes] of files) {
    if (!/\.(?:tsx?|mts|cts|mjs|cjs|js)$/.test(relative)) continue;
    const tree = ts.createSourceFile(relative, bytes.toString(), ts.ScriptTarget.Latest, true);
    function resolve(specifier) {
      if (typeof specifier !== 'string') fail(`Computed module import requires review: ${relative}`);
      if (specifier === 'firstlight-app-fonts') {
        for (const target of ['lib/app-fonts.ts', 'lib/app-fonts-system.ts', 'lib/app-fonts-alias.d.ts']) if (!files.has(target)) unresolved.push({ relative, specifier: target });
      } else if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        const base = specifier.startsWith('@/') ? specifier.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
        if (base.startsWith('../') || path.isAbsolute(base)) { outside.push({ relative, specifier }); return; }
        const variants = [base, ...['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.js'].map(s => base + s)];
        if (base.endsWith('.js')) variants.push(base.slice(0, -3) + '.ts');
        if (!variants.some(p => files.has(p))) unresolved.push({ relative, specifier });
      } else {
        packages.add(specifier);
        if (specifier === 'next/font/google') fonts.push(relative);
        if (!builtinModules.includes(specifier) && !specifier.startsWith('node:')) {
          try { require.resolve(specifier); } catch { unresolved.push({ relative, specifier }); }
        }
      }
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) resolve(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.text === 'require')) resolve(node.arguments[0]?.text);
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  if (outside.length || unresolved.length) fail(`Unresolved or outside-snapshot imports: ${JSON.stringify({ outside, unresolved })}`);
  return { outside, unresolved, fonts, packages: [...packages].sort() };
}
export function inspectDependencyLinks(source = SOURCE) {
  const root = path.join(source, 'node_modules'), started = Date.now();
  noLinks(root);
  let entries = 0, links = 0;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 150_000 || Date.now() - started > LIMIT.prepareMs) fail('Dependency metadata audit budget exceeded');
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        links++;
        if (!fs.realpathSync(absolute).startsWith(root + path.sep)) fail(`Dependency symlink escapes installed root: ${absolute}`);
      } else if (entry.isDirectory()) walk(absolute);
    }
  }
  walk(root);
  return { entries, links, outsideRoot: 0 };
}
export function writeNew(root, relative, bytes) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(s => !s || s === '.' || s === '..')) fail('Unsafe generated path');
  noLinks(root);
  const dest = path.join(root, relative);
  let parent = root;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    try { fs.mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const st = fs.lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('Generated parent must be a real directory');
  }
  fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
}
export function freeBytes(root) { const st = fs.statfsSync(root); return st.bavail * st.bsize; }
export function treeSize(root) {
  let bytes = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const p = path.join(root, entry.name);
    bytes += entry.isDirectory() ? treeSize(p) : fs.lstatSync(p).size;
  }
  return bytes;
}
