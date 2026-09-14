#!/usr/bin/env node
/** Isolated, offline Compose preview. Never imports the production Next config,
 * layout, API routes, proxy, instrumentation, env, public tree, or run store.
 * Usage: node scripts/ux-preview.mjs [--check | --prepare] [--frozen]
 * --check validates only. --prepare writes the bounded snapshot, never listens.
 * Default mirrors reviewed UI files; --frozen disables all snapshot updates.
 * Both modes serve synthetic data only on 127.0.0.1:4510.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = 'tests/fixtures/ux';
const require = createRequire(path.join(source, 'package.json'));
const ts = require('typescript');
const port = 4510;
const frozen = process.argv.includes('--frozen');
const flags = new Set(['--check', '--prepare', '--frozen']);
if (process.argv.slice(2).some(arg => !flags.has(arg))) throw new Error('Unknown preview option');
const packages = new Set(['react', 'next/link', 'next/navigation', 'lucide-react', 'clsx', 'tailwind-merge', 'three', '@base-ui/react/dialog', '@base-ui/react/popover', '@base-ui/react/menu',
  'three/examples/jsm/controls/OrbitControls.js', 'three/examples/jsm/environments/RoomEnvironment.js',
  'three/examples/jsm/loaders/GLTFLoader.js']);
const maxFile = 2 * 1024 * 1024;
const maxSource = 8 * 1024 * 1024;

// Check each path component before any read: never follow a public/runs link,
// or a symlink substituted into the reviewed client source graph.
function safeRead(relative) {
  if (path.isAbsolute(relative) || relative.split('/').some(p => p === '..' || p.startsWith('.'))) throw new Error(`Unsafe source path: ${relative}`);
  let current = source;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink source rejected: ${relative}`);
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.size > maxFile) throw new Error(`Oversize/non-file source rejected: ${relative}`);
  return fs.readFileSync(current, 'utf8');
}
const allowlist = JSON.parse(safeRead(`${fixtures}/client-allowlist.json`));
// Explicitly reviewed upcoming UI-only modules; absence is fine until created.
const optionalSources = ['lib/compose-session.ts', 'lib/workspace-state.ts', 'components/workspace-panes.tsx'];
allowlist.push(...optionalSources, 'app/login/page.tsx', 'components/command-palette.tsx');
const allowed = new Set(allowlist);
function inspect(relative, text) {
  if (!/^(components\/[^/]+\.tsx|lib\/[^/]+\.ts|app\/(compose|login|start)\/page\.tsx|app\/enterprise\/(layout|page)\.tsx|app\/enterprise\/(activity|approvals|audit|budgets|catalog|iam|integrations|quotes|settings|validation)\/page\.tsx)$/.test(relative)) throw new Error(`Not a reviewed UI source: ${relative}`);
  const tree = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  function resolve(specifier) {
    if (specifier.startsWith('@/') || specifier.startsWith('.')) {
      const base = specifier.startsWith('@/') ? specifier.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (![base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].some(p => allowed.has(p))) throw new Error(`Unreviewed import in ${relative}: ${specifier}`);
    } else if (!packages.has(specifier)) throw new Error(`Non-client package in ${relative}: ${specifier}`);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!node.isTypeOnly && !node.importClause?.isTypeOnly) resolve(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error(`Computed import blocked: ${relative}`);
        resolve(node.arguments[0].text);
      }
      if (ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text)) throw new Error(`Executable loader blocked: ${relative}`);
    }
    if (ts.isStringLiteral(node) && node.text === 'use server') throw new Error(`Server code blocked: ${relative}`);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (/\bprocess\s*\.\s*env\b|\bimport\s*\.\s*meta\b/.test(text)) throw new Error(`Environment access blocked: ${relative}`);
}
function snapshot() {
  const files = new Map();
  for (const relative of allowlist) {
    if (optionalSources.includes(relative) && !fs.existsSync(path.join(source, relative))) continue;
    const text = safeRead(relative); inspect(relative, text); files.set(relative, text);
  }
  const css = safeRead('app/globals.css');
  if (/@import\s+['"](?:https?:|\/\/)|url\s*\(/i.test(css)) throw new Error('External CSS sources blocked');
  files.set('app/globals.css', css);
  if ([...files.values()].reduce((n, s) => n + Buffer.byteLength(s), 0) > maxSource) throw new Error('Source snapshot exceeds 8 MiB budget');
  return files;
}
let files = snapshot();
const fixtureFiles = {
  'fixture-router.mjs': 'preview/fixture-router.mjs',
  'artifacts.mjs': 'preview/artifacts.mjs',
  'enterprise-fixtures.mjs': 'preview/enterprise-fixtures.mjs',
  'pipeline-fixtures.mjs': 'preview/pipeline-fixtures.mjs',
  'model-glb.mjs': 'preview/model-glb.mjs',
  'preview-banner.tsx': 'preview/preview-banner.tsx',
};
let guardCode = safeRead(`${fixtures}/browser-guard.js`);
const fixtureSnapshot = new Map(Object.entries(fixtureFiles).map(([name, target]) => [target, safeRead(`${fixtures}/${name}`)]));
const serverGuard = safeRead(`${fixtures}/server-guard.cjs`);
const fingerprint = createHash('sha256');
for (const [name, text] of [...files, ...fixtureSnapshot, ['preview/browser-guard.js', guardCode], ['preview/server-guard.cjs', serverGuard]].sort(([a], [b]) => a.localeCompare(b))) {
  fingerprint.update(name).update('\0').update(text).update('\0');
}
const snapshotHash = fingerprint.digest('hex');
if (process.argv.includes('--check')) {
  console.log(`Preview validated: ${allowlist.length} reviewed client files, no server started.`);
  process.exit(0);
}
const free = fs.statfsSync(os.tmpdir());
if (free.bavail * free.bsize < 700 * 1024 * 1024) throw new Error('Preview needs 700 MiB free before starting; no install or build attempted');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firstlight-ux-'));
function write(relative, text) {
  const dest = path.join(root, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}
for (const [relative, text] of files) write(relative, text);
fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir');
write('package.json', JSON.stringify({ name: 'firstlight-offline-preview', private: true, type: 'module' }));
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true,
  skipLibCheck: true, strict: false, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler',
  resolveJsonModule: true, isolatedModules: true, jsx: 'react-jsx', incremental: false, paths: { '@/*': ['./*'] } },
  include: ['**/*.ts', '**/*.tsx'], exclude: ['node_modules'] }));
write('postcss.config.mjs', "export default { plugins: { '@tailwindcss/postcss': {} } };\n");
const csp = ["default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self'", `connect-src 'self' ws://127.0.0.1:${port}/_next/webpack-hmr`,
  "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "worker-src 'none'"].join('; ');
write('next.config.mjs', `export default { distDir: '.next', devIndicators: false, poweredByHeader: false,
  experimental: { webpackMemoryOptimizations: true },
  webpack(config) { config.cache = false; return config; },
  async headers() { return [{ source: '/:path*', headers: [
    { key: 'Content-Security-Policy', value: ${JSON.stringify(csp)} },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-DNS-Prefetch-Control', value: 'off' },
    { key: 'X-UI-Preview', value: 'synthetic-only' }
  ] }]; }
};\n`);
for (const [target, text] of fixtureSnapshot) write(target, text);
write('preview/snapshot.json', JSON.stringify({ frozen, sha256: snapshotHash, createdAt: new Date().toISOString(), files: [...files.keys(), ...fixtureSnapshot.keys()] }, null, 2));
write('app/api/ux-preview/snapshot/route.ts', `import snapshot from '@/preview/snapshot.json';
export const dynamic = 'force-dynamic';
export function GET() { return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store', 'X-UI-Preview': 'synthetic-only' } }); }\n`);
write('app/runs/[...path]/route.ts', `import { artifactRequest } from '@/preview/artifacts.mjs';
import { enterpriseRequest } from '@/preview/enterprise-fixtures.mjs';
import { pipelineRequest } from '@/preview/pipeline-fixtures.mjs';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const scenario = request.headers.get('x-ux-scenario') || 'empty';
  return await pipelineRequest(request, scenario) ?? await enterpriseRequest(request, scenario) ?? artifactRequest(request);
}
export const GET = handle; export const HEAD = handle;\n`);
write('app/api/[[...path]]/route.ts', `import { fixtureRequest } from '@/preview/fixture-router.mjs';
export const dynamic = 'force-dynamic';
export const GET = fixtureRequest; export const POST = fixtureRequest; export const PUT = fixtureRequest;
export const PATCH = fixtureRequest; export const DELETE = fixtureRequest; export const HEAD = fixtureRequest; export const OPTIONS = fixtureRequest;\n`);
write('app/page.tsx', "import { redirect } from 'next/navigation'; export default function Home() { redirect('/compose'); }\n");
function writeLayout() {
  write('app/layout.tsx', `import './globals.css';
import { TopNav } from '@/components/top-nav';
import { CommandPalette } from '@/components/command-palette';
import { PreviewBanner } from '@/preview/preview-banner';
export const metadata = { title: 'UI preview · synthetic data', robots: 'noindex, nofollow' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className="dark" style={{ '--font-inter': 'Arial', '--font-jetbrains-mono': 'monospace' } as React.CSSProperties}><head><script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(guardCode)} }} /></head>
  <body><PreviewBanner /><TopNav /><CommandPalette />{children}</body></html>;
}\n`);
}
writeLayout();
console.log(`Preview root: ${root}\nURL: http://127.0.0.1:${port}/compose\nMode: ${frozen ? 'frozen acceptance snapshot' : 'watched development snapshot'}\nInitial source SHA256: ${snapshotHash}\nLogs: this terminal (no persistent log file).\nNo production routes, data, env, instrumentation, or public/runs included.`);
if (process.argv.includes('--prepare')) {
  console.log('Prepared only. Run node scripts/ux-preview.mjs to start a fresh watched preview.');
  process.exit(0);
}
// Do not inherit provider keys, NODE_OPTIONS, proxy config, NEXT_* variables,
// cloud metadata credentials, shell startup behavior, or production HOME.
const home = path.join(root, 'preview-home'); fs.mkdirSync(home);
write('preview/server-guard.cjs', serverGuard);
const env = { PATH: path.dirname(process.execPath), HOME: home, TMPDIR: root, NODE_ENV: 'development',
  NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1', TZ: 'UTC', REACT_EDITOR: 'none',
  NODE_OPTIONS: `--require=${JSON.stringify(path.join(root, 'preview/server-guard.cjs'))}` };
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', root, '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, stdio: 'inherit' });
let stopping = false;
function stop() { if (!stopping) { stopping = true; child.kill('SIGTERM'); } }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const watched = frozen ? [] : [...allowlist, 'app/globals.css'];
const watchedFixtures = frozen ? [] : [...Object.keys(fixtureFiles), 'browser-guard.js'];
for (const fixture of watchedFixtures) fs.watchFile(path.join(source, fixtures, fixture), { interval: 600 }, () => {
  try {
    if (fixture === 'browser-guard.js') { guardCode = safeRead(`${fixtures}/${fixture}`); writeLayout(); }
    else write(fixtureFiles[fixture], safeRead(`${fixtures}/${fixture}`));
  } catch (error) { console.error(`Preview fixture update rejected: ${error.message}`); stop(); }
});
for (const relative of watched) fs.watchFile(path.join(source, relative), { interval: 600 }, () => {
  try {
    const next = snapshot();
    for (const [name, text] of next) if (files.get(name) !== text) write(name, text);
    files = next;
  } catch (error) { console.error(`Unsafe source update refused; stopping preview: ${error.message}`); stop(); }
});
function sizeOf(directory) {
  let size = 0;
  if (!fs.existsSync(directory)) return size;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const name = path.join(directory, item.name);
    size += item.isDirectory() ? sizeOf(name) : fs.statSync(name).size;
  }
  return size;
}
const budget = setInterval(() => {
  const disk = fs.statfsSync(root);
  if (disk.bavail * disk.bsize < 350 * 1024 * 1024 || sizeOf(path.join(root, '.next')) > 384 * 1024 * 1024) {
    console.error('Preview output/free-space budget reached; stopping only this preview.'); stop();
  }
}, 5000);
child.on('error', error => { console.error(error.message); stop(); });
child.on('exit', (code) => {
  clearInterval(budget);
  for (const relative of watched) fs.unwatchFile(path.join(source, relative));
  for (const fixture of watchedFixtures) fs.unwatchFile(path.join(source, fixtures, fixture));
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = code ?? 0;
});
