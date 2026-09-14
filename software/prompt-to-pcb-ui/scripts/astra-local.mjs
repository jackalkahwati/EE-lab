#!/usr/bin/env node
/** Actual source app only. No inferred launch, proxy lifecycle, installs, or inference. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { SOURCE, SCRATCH, LIMIT, EXCLUDED, fail, hash, noLinks, safeRead, inventory,
  inspectImports, inspectDependencyLinks, writeNew, freeBytes, treeSize } from './source-snapshot.mjs';

const SELF = path.join(SOURCE, 'scripts/astra-local.mjs');
const PINS = 'lib/astra-native-pins.json';
export const NATIVE_SCRIPTS = Object.freeze({ native: 'scripts/astra-native.py', probe: 'scripts/astra-sandbox-probe.py' });
export const VALIDATOR_SCRIPTS = Object.freeze(['scripts/astra-validator-controller.mjs', 'scripts/astra-stage-validator.mjs',
  'scripts/astra-linux-runtime.mjs', 'scripts/astra-linux-drc.mjs']);
const EXTRA_SOURCE_FILES = Object.freeze([...Object.values(NATIVE_SCRIPTS), ...VALIDATOR_SCRIPTS]);
const require = createRequire(path.join(SOURCE, 'package.json'));
const OWNED_PREFIX = 'astra-app-owned-';
const SHA = /^[a-f0-9]{64}$/;
// Exact installed Node 25.9 runtime inventory, inspected from dyld shared objects.
// A changed runtime requires review/update, not a broad Homebrew read allowance.
const NODE_RUNTIME_PINS = Object.freeze([
  {
    "path": "/opt/homebrew/Cellar/node/25.9.0_2/bin/node",
    "sha256": "32e234a5b6bec67d72a016f2baadf7fadf3afd328470b395b73af473fdee0d85"
  },
  {
    "path": "/opt/homebrew/Cellar/node/25.9.0_2/lib/libnode.141.dylib",
    "sha256": "a9d4a6ac7ae673af0f40f13dedccf251fa24c4a706c493db215e2490e2254c96"
  },
  {
    "path": "/opt/homebrew/Cellar/llhttp/9.3.1/lib/libllhttp.9.3.1.dylib",
    "sha256": "84d500746c0e7017b2f2a8cfb001c8788cbb83ca065db126368d1da868ac18c5"
  },
  {
    "path": "/opt/homebrew/Cellar/libuv/1.52.1/lib/libuv.1.0.0.dylib",
    "sha256": "34d4e2cd30b56dca5bda539f4448667360f0994c6b337ffebc5d37d818bc15d5"
  },
  {
    "path": "/opt/homebrew/Cellar/ada-url/3.4.4/lib/libada.3.4.4.dylib",
    "sha256": "a55588fab581b41c9b918f4a5bab044e946091eb72cbed3bc82a8df00db189a2"
  },
  {
    "path": "/opt/homebrew/Cellar/simdjson/4.6.3/lib/libsimdjson.33.0.0.dylib",
    "sha256": "9ac6d74a81c248a5a946fae44bc88ad0705f3a32a495aa1a906fb6a35fe3d258"
  },
  {
    "path": "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlidec.1.2.0.dylib",
    "sha256": "d7ac1e69b6c443341fb4302de0169d187489d58d8a641c8eadd6db9ca2cd0cbf"
  },
  {
    "path": "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlienc.1.2.0.dylib",
    "sha256": "32e38a8ab06c8770ea4bfaf11ea324d7bcb6fe5f07eaff9d6260f93984ee6729"
  },
  {
    "path": "/opt/homebrew/Cellar/c-ares/1.34.6/lib/libcares.2.19.5.dylib",
    "sha256": "e5595a0c640a2341e2df5a0fedaa63e7e9afe99b01c9880338064e0746414518"
  },
  {
    "path": "/opt/homebrew/Cellar/hdrhistogram_c/0.11.9/lib/libhdr_histogram.6.2.3.dylib",
    "sha256": "d1f4ba22087781611f0187787217ffef1ef97b96cd76ff2af3fb600a4434bbb6"
  },
  {
    "path": "/opt/homebrew/Cellar/merve/1.2.2_1/lib/libmerve.1.2.2.dylib",
    "sha256": "a39e3416af9b155ba8ab441f30b2ea58b853d5ae955cb35efd53bd72d299299f"
  },
  {
    "path": "/opt/homebrew/Cellar/nbytes/0.1.4/lib/libnbytes.dylib",
    "sha256": "2ebb8415d537b47420fc46efb6d6271b93befd22b30ad2afba75ab5e2be55fcc"
  },
  {
    "path": "/opt/homebrew/Cellar/libnghttp2/1.69.0/lib/libnghttp2.14.dylib",
    "sha256": "b56cd6b95765b0c608a6cb50ab44ffb4ab29303d627f0c2d96a028aa11688cc2"
  },
  {
    "path": "/opt/homebrew/Cellar/libnghttp3/1.15.0/lib/libnghttp3.9.6.1.dylib",
    "sha256": "f16407d21bebb61f141026116f304bd02ac9c2c44f7e2aee051293290c8bcd2f"
  },
  {
    "path": "/opt/homebrew/Cellar/libngtcp2/1.22.1/lib/libngtcp2.16.dylib",
    "sha256": "e82462c1d2c68aa714e20e8665a3c35de8ae50e9631f640ceabfd3e41f25feca"
  },
  {
    "path": "/opt/homebrew/Cellar/sqlite/3.53.4/lib/libsqlite3.3.53.4.dylib",
    "sha256": "75feed7151d3e496343ffee9c25960d85188ed99b2ffb1051fe016f912c6c808"
  },
  {
    "path": "/opt/homebrew/Cellar/uvwasi/0.0.23/lib/libuvwasi.dylib",
    "sha256": "c922288c5179279316b32b2c83d5c50d7b87216b442473ada8c99ef4a58ba312"
  },
  {
    "path": "/opt/homebrew/Cellar/zstd/1.5.7_1/lib/libzstd.1.5.7.dylib",
    "sha256": "e2847c4613b386683c234913ae3b7b04299254096caf7616e3b3cd9bb97a39ab"
  },
  {
    "path": "/opt/homebrew/Cellar/openssl@3/3.6.3/lib/libcrypto.3.dylib",
    "sha256": "a12805a18cd5e4f733fa8727b91afa08b587f9da5a760517cd79cb508a3a3f71"
  },
  {
    "path": "/opt/homebrew/Cellar/openssl@3/3.6.3/lib/libssl.3.dylib",
    "sha256": "ffd8ac6981000def0928367924b6cb1e7a98712efbc06e2a2f3f750138bd89ca"
  },
  {
    "path": "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicui18n.78.3.dylib",
    "sha256": "f319e50c965a1a0065d2cc5595d8553ff60b0e78a2e76bc3173774fd112de9ed"
  },
  {
    "path": "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicuuc.78.3.dylib",
    "sha256": "177dab8ae0bf0b1357d7ec6404a1e145bcc3d927aa15c3064171d23b2a1fd263"
  },
  {
    "path": "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlicommon.1.2.0.dylib",
    "sha256": "3426742c78df5c3b523071df603f07f2bb8dea6bd8e65c366a2c6adf2bf0a3ad"
  },
  {
    "path": "/opt/homebrew/Cellar/simdutf/9.0.0/lib/libsimdutf.34.0.0.dylib",
    "sha256": "9491fe37cead254d8fd5655699f6832606ae45fc885a42ddaa072560c27dc1fc"
  },
  {
    "path": "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicudata.78.3.dylib",
    "sha256": "e7dafc3fe6613326daa30d1c930aa66219ab5524fe576b0e7b3039451652b6bf"
  }
]);
const NODE_RUNTIME_ALIASES = Object.freeze({
  "/opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib": "/opt/homebrew/Cellar/llhttp/9.3.1/lib/libllhttp.9.3.1.dylib",
  "/opt/homebrew/opt/libuv/lib/libuv.1.dylib": "/opt/homebrew/Cellar/libuv/1.52.1/lib/libuv.1.0.0.dylib",
  "/opt/homebrew/opt/ada-url/lib/libada.3.dylib": "/opt/homebrew/Cellar/ada-url/3.4.4/lib/libada.3.4.4.dylib",
  "/opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib": "/opt/homebrew/Cellar/simdjson/4.6.3/lib/libsimdjson.33.0.0.dylib",
  "/opt/homebrew/opt/brotli/lib/libbrotlidec.1.dylib": "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlidec.1.2.0.dylib",
  "/opt/homebrew/opt/brotli/lib/libbrotlienc.1.dylib": "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlienc.1.2.0.dylib",
  "/opt/homebrew/opt/c-ares/lib/libcares.2.dylib": "/opt/homebrew/Cellar/c-ares/1.34.6/lib/libcares.2.19.5.dylib",
  "/opt/homebrew/opt/hdrhistogram_c/lib/libhdr_histogram.6.dylib": "/opt/homebrew/Cellar/hdrhistogram_c/0.11.9/lib/libhdr_histogram.6.2.3.dylib",
  "/opt/homebrew/opt/merve/lib/libmerve.1.dylib": "/opt/homebrew/Cellar/merve/1.2.2_1/lib/libmerve.1.2.2.dylib",
  "/opt/homebrew/opt/nbytes/lib/libnbytes.dylib": "/opt/homebrew/Cellar/nbytes/0.1.4/lib/libnbytes.dylib",
  "/opt/homebrew/opt/libnghttp2/lib/libnghttp2.14.dylib": "/opt/homebrew/Cellar/libnghttp2/1.69.0/lib/libnghttp2.14.dylib",
  "/opt/homebrew/opt/libnghttp3/lib/libnghttp3.9.dylib": "/opt/homebrew/Cellar/libnghttp3/1.15.0/lib/libnghttp3.9.6.1.dylib",
  "/opt/homebrew/opt/libngtcp2/lib/libngtcp2.16.dylib": "/opt/homebrew/Cellar/libngtcp2/1.22.1/lib/libngtcp2.16.dylib",
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib": "/opt/homebrew/Cellar/sqlite/3.53.4/lib/libsqlite3.3.53.4.dylib",
  "/opt/homebrew/opt/uvwasi/lib/libuvwasi.dylib": "/opt/homebrew/Cellar/uvwasi/0.0.23/lib/libuvwasi.dylib",
  "/opt/homebrew/opt/zstd/lib/libzstd.1.dylib": "/opt/homebrew/Cellar/zstd/1.5.7_1/lib/libzstd.1.5.7.dylib",
  "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib": "/opt/homebrew/Cellar/openssl@3/3.6.3/lib/libcrypto.3.dylib",
  "/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib": "/opt/homebrew/Cellar/openssl@3/3.6.3/lib/libssl.3.dylib",
  "/opt/homebrew/opt/icu4c@78/lib/libicui18n.78.dylib": "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicui18n.78.3.dylib",
  "/opt/homebrew/opt/icu4c@78/lib/libicuuc.78.dylib": "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicuuc.78.3.dylib",
  "/opt/homebrew/opt/node/lib/libnode.141.dylib": "/opt/homebrew/Cellar/node/25.9.0_2/lib/libnode.141.dylib",
  "/opt/homebrew/opt/simdutf/lib/libsimdutf.34.dylib": "/opt/homebrew/Cellar/simdutf/9.0.0/lib/libsimdutf.34.0.0.dylib",
  "/opt/homebrew/opt/brotli/lib/libbrotlicommon.1.dylib": "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlicommon.1.2.0.dylib",
  "/opt/homebrew/opt/icu4c@78/lib/libicudata.78.dylib": "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicudata.78.3.dylib"
});
const NODE_LOADER_CHAIN = Object.freeze({
  "links": {
    "/opt/homebrew/opt/llhttp": "../Cellar/llhttp/9.3.1",
    "/opt/homebrew/Cellar/llhttp/9.3.1/lib/libllhttp.9.3.dylib": "libllhttp.9.3.1.dylib",
    "/opt/homebrew/opt/libuv": "../Cellar/libuv/1.52.1",
    "/opt/homebrew/Cellar/libuv/1.52.1/lib/libuv.1.dylib": "libuv.1.0.0.dylib",
    "/opt/homebrew/opt/ada-url": "../Cellar/ada-url/3.4.4",
    "/opt/homebrew/Cellar/ada-url/3.4.4/lib/libada.3.dylib": "libada.3.4.4.dylib",
    "/opt/homebrew/opt/simdjson": "../Cellar/simdjson/4.6.3",
    "/opt/homebrew/Cellar/simdjson/4.6.3/lib/libsimdjson.33.dylib": "libsimdjson.33.0.0.dylib",
    "/opt/homebrew/opt/brotli": "../Cellar/brotli/1.2.0",
    "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlidec.1.dylib": "libbrotlidec.1.2.0.dylib",
    "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlienc.1.dylib": "libbrotlienc.1.2.0.dylib",
    "/opt/homebrew/opt/c-ares": "../Cellar/c-ares/1.34.6",
    "/opt/homebrew/Cellar/c-ares/1.34.6/lib/libcares.2.dylib": "libcares.2.19.5.dylib",
    "/opt/homebrew/opt/hdrhistogram_c": "../Cellar/hdrhistogram_c/0.11.9",
    "/opt/homebrew/Cellar/hdrhistogram_c/0.11.9/lib/libhdr_histogram.6.dylib": "libhdr_histogram.6.2.3.dylib",
    "/opt/homebrew/opt/merve": "../Cellar/merve/1.2.2_1",
    "/opt/homebrew/Cellar/merve/1.2.2_1/lib/libmerve.1.dylib": "libmerve.1.2.2.dylib",
    "/opt/homebrew/opt/nbytes": "../Cellar/nbytes/0.1.4",
    "/opt/homebrew/opt/libnghttp2": "../Cellar/libnghttp2/1.69.0",
    "/opt/homebrew/opt/libnghttp3": "../Cellar/libnghttp3/1.15.0",
    "/opt/homebrew/Cellar/libnghttp3/1.15.0/lib/libnghttp3.9.dylib": "libnghttp3.9.6.1.dylib",
    "/opt/homebrew/opt/libngtcp2": "../Cellar/libngtcp2/1.22.1",
    "/opt/homebrew/opt/sqlite": "../Cellar/sqlite/3.53.4",
    "/opt/homebrew/Cellar/sqlite/3.53.4/lib/libsqlite3.dylib": "libsqlite3.3.53.4.dylib",
    "/opt/homebrew/opt/uvwasi": "../Cellar/uvwasi/0.0.23",
    "/opt/homebrew/opt/zstd": "../Cellar/zstd/1.5.7_1",
    "/opt/homebrew/Cellar/zstd/1.5.7_1/lib/libzstd.1.dylib": "libzstd.1.5.7.dylib",
    "/opt/homebrew/opt/openssl@3": "../Cellar/openssl@3/3.6.3",
    "/opt/homebrew/opt/icu4c@78": "../Cellar/icu4c@78/78.3",
    "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicui18n.78.dylib": "libicui18n.78.3.dylib",
    "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicuuc.78.dylib": "libicuuc.78.3.dylib",
    "/opt/homebrew/opt/node": "../Cellar/node/25.9.0_2",
    "/opt/homebrew/opt/simdutf": "../Cellar/simdutf/9.0.0",
    "/opt/homebrew/Cellar/simdutf/9.0.0/lib/libsimdutf.34.dylib": "libsimdutf.34.0.0.dylib",
    "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlicommon.1.dylib": "libbrotlicommon.1.2.0.dylib",
    "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicudata.78.dylib": "libicudata.78.3.dylib"
  },
  "directories": {
    "/opt/homebrew/Cellar/llhttp/9.3.1/lib": {
      "dev": 16777229,
      "ino": 64151474,
      "mode": 493
    },
    "/opt/homebrew/Cellar/libuv/1.52.1/lib": {
      "dev": 16777229,
      "ino": 64100171,
      "mode": 493
    },
    "/opt/homebrew/Cellar/ada-url/3.4.4/lib": {
      "dev": 16777229,
      "ino": 64151529,
      "mode": 493
    },
    "/opt/homebrew/Cellar/simdjson/4.6.3/lib": {
      "dev": 16777229,
      "ino": 64100249,
      "mode": 493
    },
    "/opt/homebrew/Cellar/brotli/1.2.0/lib": {
      "dev": 16777229,
      "ino": 1781536,
      "mode": 493
    },
    "/opt/homebrew/Cellar/c-ares/1.34.6/lib": {
      "dev": 16777229,
      "ino": 64099431,
      "mode": 493
    },
    "/opt/homebrew/Cellar/hdrhistogram_c/0.11.9/lib": {
      "dev": 16777229,
      "ino": 64099685,
      "mode": 493
    },
    "/opt/homebrew/Cellar/merve/1.2.2_1/lib": {
      "dev": 16777229,
      "ino": 64151571,
      "mode": 493
    },
    "/opt/homebrew/Cellar/nbytes/0.1.4/lib": {
      "dev": 16777229,
      "ino": 64151685,
      "mode": 493
    },
    "/opt/homebrew/Cellar/libnghttp2/1.69.0/lib": {
      "dev": 16777229,
      "ino": 64099857,
      "mode": 493
    },
    "/opt/homebrew/Cellar/libnghttp3/1.15.0/lib": {
      "dev": 16777229,
      "ino": 64099757,
      "mode": 493
    },
    "/opt/homebrew/Cellar/libngtcp2/1.22.1/lib": {
      "dev": 16777229,
      "ino": 64099990,
      "mode": 493
    },
    "/opt/homebrew/Cellar/sqlite/3.53.4/lib": {
      "dev": 16777229,
      "ino": 118657398,
      "mode": 493
    },
    "/opt/homebrew/Cellar/uvwasi/0.0.23/lib": {
      "dev": 16777229,
      "ino": 1797032,
      "mode": 493
    },
    "/opt/homebrew/Cellar/zstd/1.5.7_1/lib": {
      "dev": 16777229,
      "ino": 33862743,
      "mode": 493
    },
    "/opt/homebrew/Cellar/openssl@3/3.6.3/lib": {
      "dev": 16777229,
      "ino": 89750932,
      "mode": 493
    },
    "/opt/homebrew/Cellar/icu4c@78/78.3/lib": {
      "dev": 16777229,
      "ino": 64112953,
      "mode": 493
    },
    "/opt/homebrew/Cellar/node/25.9.0_2/lib": {
      "dev": 16777229,
      "ino": 64151830,
      "mode": 493
    },
    "/opt/homebrew/Cellar/simdutf/9.0.0/lib": {
      "dev": 16777229,
      "ino": 64151659,
      "mode": 493
    }
  },
  "metadataFiles": [
    "/opt/homebrew/Cellar/ada-url/3.4.4/lib/libada.3.dylib",
    "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlicommon.1.dylib",
    "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlidec.1.dylib",
    "/opt/homebrew/Cellar/brotli/1.2.0/lib/libbrotlienc.1.dylib",
    "/opt/homebrew/Cellar/c-ares/1.34.6/lib/libcares.2.dylib",
    "/opt/homebrew/Cellar/hdrhistogram_c/0.11.9/lib/libhdr_histogram.6.dylib",
    "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicudata.78.dylib",
    "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicui18n.78.dylib",
    "/opt/homebrew/Cellar/icu4c@78/78.3/lib/libicuuc.78.dylib",
    "/opt/homebrew/Cellar/libnghttp3/1.15.0/lib/libnghttp3.9.dylib",
    "/opt/homebrew/Cellar/libuv/1.52.1/lib/libuv.1.dylib",
    "/opt/homebrew/Cellar/llhttp/9.3.1/lib/libllhttp.9.3.dylib",
    "/opt/homebrew/Cellar/merve/1.2.2_1/lib/libmerve.1.dylib",
    "/opt/homebrew/Cellar/simdjson/4.6.3/lib/libsimdjson.33.dylib",
    "/opt/homebrew/Cellar/simdutf/9.0.0/lib/libsimdutf.34.dylib",
    "/opt/homebrew/Cellar/sqlite/3.53.4/lib/libsqlite3.dylib",
    "/opt/homebrew/Cellar/zstd/1.5.7_1/lib/libzstd.1.dylib"
  ]
});
export const LAUNCH_LIMITS = Object.freeze({ ...LIMIT, serveMs: 40 * 60_000 });

export function parseArgs(args) {
  if (!['--check', '--prepare', '--serve', '--build', '--seal-qualification'].includes(args[0])) fail('Explicit --check, --prepare, --build <snapshot>, --serve <snapshot>, or --seal-qualification <snapshot> required. No default launch.');
  const mode = args[0].slice(2), options = { mode };
  let i = 1;
  if (mode === 'serve' || mode === 'build' || mode === 'seal-qualification') {
    if (!args[i] || args[i].startsWith('--')) fail('An explicit owned snapshot is required');
    options.snapshot = args[i++];
  }
  const allowed = mode === 'prepare' ? ['--native-manifest', '--test-email'] : mode === 'check' ? ['--native-manifest'] : mode === 'serve' ? ['--port', '--proxy-url', '--cli', '--cli-sha256'] : mode === 'seal-qualification' ? ['--bundle-id', '--port'] : [];
  while (i < args.length) {
    const key = args[i++], value = args[i++];
    if (!allowed.includes(key) || !value || value.startsWith('--') || options[key.slice(2)] !== undefined) fail('Unknown, repeated, or incomplete launcher option');
    options[key.slice(2)] = value;
  }
  if (['check', 'prepare'].includes(mode) && !options['native-manifest']) fail('Explicit --native-manifest matching reviewed source pins is required');
  if (mode === 'prepare' && !/^[a-z0-9][a-z0-9._+\-]*@example\.test$/.test(options['test-email'] ?? '')) fail('Explicit dedicated --test-email at example.test required');
  if (mode === 'seal-qualification' && !/^[a-z0-9][a-z0-9-]{7,63}$/.test(options['bundle-id'] ?? '')) fail('Explicit qualification bundle ID required');
  if (mode === 'serve' || mode === 'seal-qualification') {
    if (!/^[1-9]\d{3,4}$/.test(options.port ?? '') || Number(options.port) < 1024 || Number(options.port) > 65535) fail('Explicit unprivileged --port required');
    options.port = Number(options.port);
    if (options['proxy-url'] || options.cli || options['cli-sha256']) {
      if (!options['proxy-url'] || !options.cli || !SHA.test(options['cli-sha256'] ?? '')) fail('Adapter requires all of --proxy-url, --cli, --cli-sha256 from explicit bounded approval');
      options['proxy-url'] = proxyOrigin(options['proxy-url'], options.port);
      if (!path.isAbsolute(options.cli) || path.resolve(options.cli) !== options.cli || path.basename(options.cli) === 'claude-astra') fail('Explicit canonical native CLI required, not global launcher');
    }
  }
  return options;
}
function proxyOrigin(value, appPort) {
  let url; try { url = new URL(value); } catch { fail('Invalid adapter URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[1-9]\d{3,4}$/.test(url.port) || Number(url.port) < 1024 || Number(url.port) > 65535 || Number(url.port) === appPort || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('Adapter must be an explicit distinct loopback HTTP origin, without credentials or URL parameters');
  return url.origin;
}
export function inspectAdapter(cli, sha256) {
  if (!path.isAbsolute(cli) || fs.realpathSync(cli) !== cli || path.basename(cli) === 'claude-astra' || !SHA.test(sha256)) fail('Invalid pinned native adapter');
  const bytes = readAbsolute(cli, 384 * 1024 ** 2), st = fs.statSync(cli);
  if (st.nlink !== 1 || (st.mode & 0o022) || hash(bytes) !== sha256 || !['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', '7f454c46'].includes(bytes.subarray(0, 4).toString('hex'))) fail('Adapter must be the approved pinned native executable, not a wrapper');
  fs.accessSync(cli, fs.constants.X_OK);
  return { cli, sha256 };
}
function readAbsolute(file, cap = LIMIT.fileBytes) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) fail('An exact absolute manifest path is required');
  return safeRead(path.dirname(file), path.basename(file), cap);
}
function privateFile(root, relative, cap = LIMIT.fileBytes) {
  const absolute = path.join(root, relative);
  const st = fs.lstatSync(absolute);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.nlink !== 1) fail('Private launcher file permissions/ownership changed');
  // Generated private names are fixed by code, not supplied by a request.
  noLinks(absolute);
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.fstatSync(fd).size > cap) fail('Private file too large');
    const out = Buffer.alloc(cap + 1); let length = 0;
    while (length <= cap) { const n = fs.readSync(fd, out, length, out.length - length, null); if (!n) break; length += n; }
    if (length > cap) fail('Private file grew beyond limit');
    return out.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function privateDir(dir) {
  noLinks(dir);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077)) fail('Expected a private owned directory');
}

/** Manifest paths are evidence, not permission: source-owned pins are authoritative. */
export function inspectNativeManifest(manifestPath) {
  const sourceBytes = safeRead(SOURCE, PINS), bytes = readAbsolute(manifestPath);
  const pins = JSON.parse(sourceBytes);
  if (hash(bytes) !== hash(sourceBytes)) fail('Native manifest must exactly match reviewed source pins');
  if (pins.schema !== 'astra-native-pins/v1' || !pins.tools || !pins.scripts || !Array.isArray(pins.assetRoots) || !Array.isArray(pins.runtimeRoots) || !Array.isArray(pins.runtimeFiles) || !Array.isArray(pins.runtimeDirectoryData) || !Array.isArray(pins.machServices)) fail('Unsupported native pins schema');
  if (Object.keys(pins.tools).sort().join(',') !== 'bundledPython,flroute,kicadCli,pythonRuntime,sandbox' || Object.keys(pins.scripts).sort().join(',') !== 'native,probe') fail('Unexpected native inventory keys');
  for (const [key, relative] of Object.entries(NATIVE_SCRIPTS)) {
    if (!SHA.test(pins.scripts[key]) || hash(safeRead(SOURCE, relative)) !== pins.scripts[key]) fail(`Native script pin unavailable or drifted: ${key}`);
  }
  for (const [key, pin] of Object.entries(pins.tools)) {
    if (!SHA.test(pin.sha256) || !path.isAbsolute(pin.path)) fail(`Missing native executable pin: ${key}`);
    const canonical = fs.realpathSync(pin.path);
    if (canonical !== (pin.canonicalPath ?? pin.path)) fail(`Native executable path drift: ${key}`);
    noLinks(canonical);
    const st = fs.statSync(canonical);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o022) || st.size > 256 * 1024 ** 2 || hash(safeRead(path.dirname(canonical), path.basename(canonical), 256 * 1024 ** 2)) !== pin.sha256) fail(`Native executable hash/permissions drift: ${key}`);
    fs.accessSync(canonical, fs.constants.X_OK);
  }
  for (const directory of pins.runtimeDirectoryData) {
    noLinks(directory);
    const st = fs.lstatSync(directory);
    if (fs.realpathSync(directory) !== directory || !st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022)) fail('Native runtime directory identity/permissions drift');
  }
  for (const root of [...pins.assetRoots, ...pins.runtimeRoots]) {
    noLinks(root);
    if (!fs.statSync(root).isDirectory()) fail('Missing reviewed native runtime/asset directory');
  }
  return { pins, sha256: hash(sourceBytes), sourcePath: path.join(SOURCE, PINS), containment: 'unverified', capabilities: 'unverified' };
}
export function cleanEnv(m, { mode = 'serve', port, proxyUrl, adapter, validator } = {}, secrets) {
  if (!secrets || !/^[a-f0-9]{64}$/.test(secrets.authSecret)) fail('Fresh private auth secret required');
  const env = { PATH: path.dirname(m.node), HOME: path.join(m.app, '.astra-home'),
    TMPDIR: path.join(m.app, '.astra-home/tmp'), XDG_CACHE_HOME: path.join(m.app, '.astra-home/cache'),
    NODE_ENV: mode === 'build' ? 'production' : 'development', NEXT_DIST_DIR: '.next-astra', NEXT_TELEMETRY_DISABLED: '1',
    // Isolated Node uses its built-in crypto defaults, never host config/includes.
    OPENSSL_CONF: '/dev/null',
    FL_ASTRA_BETA: '1', FL_ASTRA_ROOT: m.app, FL_ASTRA_BIND: '127.0.0.1',
    AUTH_SECRET: secrets.authSecret, FL_ADMIN_EMAILS: m.testEmail,
    ENTERPRISE_STORE_DIR: path.join(m.app, 'data/enterprise'),
    NO_COLOR: '1', CI: '1', TZ: 'UTC', RAYON_NUM_THREADS: '1', UV_THREADPOOL_SIZE: '2',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    NODE_OPTIONS: `--max-old-space-size=${LIMIT.nodeHeapMiB} --require=${JSON.stringify(path.join(m.root, 'resource-guard.cjs'))}` };
  if (mode === 'serve') {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('Explicit loopback port required');
    env.FL_ASTRA_ORIGIN = `http://127.0.0.1:${port}`;
    // Native FSEvents requires a broker denied by isolation; polling stays local.
    env.WATCHPACK_POLLING = '1000';
    if (validator) {
      env.ASTRA_VALIDATOR_SOCKET = validator.socketPath;
      env.ASTRA_VALIDATOR_SECRET = validator.authSecret;
    }
    if (proxyUrl || adapter) {
      if (!proxyUrl || !adapter) fail('Adapter and proxy must be paired');
      env.FL_ASTRA_PROXY_URL = proxyOrigin(proxyUrl, port);
      env.FL_ASTRA_CLI = adapter.cli;
    }
  }
  return env;
}
export function sandboxProfile(m, { mode, port, proxyUrl, adapter, validator }) {
  const q = JSON.stringify, pins = m.native.pins;
  const tools = [...Object.values(pins.tools).map(p => p.canonicalPath ?? p.path), ...(adapter ? [adapter.cli] : [])];
  const roots = [m.root, m.dependencies, ...pins.assetRoots, ...pins.runtimeRoots];
  const literals = [...tools, ...NODE_RUNTIME_PINS.map(p => p.path), ...Object.keys(NODE_RUNTIME_ALIASES), ...pins.runtimeFiles, m.node, '/Applications/KiCad/KiCad.app/Contents/Info.plist', '/dev/null', '/dev/random', '/dev/urandom', '/private/etc/localtime'];
  const controllerFiles = mode === 'serve' && validator ? [validator.socketPath, path.dirname(validator.socketPath)] : [];
  const ancestors = new Set(['/']);
  for (const p of [...roots, ...literals, ...controllerFiles]) for (let d = path.dirname(p); d !== '/'; d = path.dirname(d)) ancestors.add(d);
  return ['(version 1)', '(deny default)', '(allow process-fork process-info* sysctl-read)', '(allow signal (target self))',
    ...(pins.machServices?.length ? [`(allow mach-lookup ${pins.machServices.map(s => `(global-name ${q(s)})`).join(' ')})`] : []),
    `(allow process-exec ${[m.node, ...tools].map(p => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-read* ${roots.map(p => `(subpath ${q(p)})`).join(' ')} ${literals.map(p => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-read-metadata ${[...ancestors, ...NODE_LOADER_CHAIN.metadataFiles, '/System/Cryptexes/OS'].map(p => `(literal ${q(p)})`).join(' ')})`,
    // Kernel-denied directory openat during dyld lookup; a literal grants the
    // directory handle only, never read access to unlisted child file content.
    `(allow file-read-data ${[...Object.keys(NODE_LOADER_CHAIN.directories), ...pins.runtimeDirectoryData].map(p => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-write* (subpath ${q(m.root)}) (literal "/dev/null"))`,
    ...(controllerFiles.length ? [
      `(allow file-read* ${controllerFiles.map(p => `(literal ${q(p)})`).join(' ')})`,
      `(allow network-outbound (remote unix-socket (literal ${q(validator.socketPath)})))`,
    ] : []),
    // Seatbelt accepts only the special host `localhost` or wildcard here;
    // never use a wildcard. The actual server/adapter use numeric 127.0.0.1.
    // Default deny blocks every other network destination. The nested native
    // sandbox additionally denies ALL network, including these loopback ports.
    ...(mode === 'serve' ? [`(allow network-bind network-inbound (local ip ${q(`localhost:${port}`)}))`,
      `(allow network-outbound (remote ip ${q(`localhost:${port}`)})${proxyUrl ? ` (remote ip ${q(`localhost:${new URL(proxyUrl).port}`)})` : ''})`] : []),
  ].join('\n') + '\n';
}
const RESOURCE_GUARD = `'use strict';\nconst os = require('node:os'); const cpus = os.cpus;\nos.availableParallelism = () => 2; os.cpus = () => cpus().slice(0, 2);\nrequire('node:module').syncBuiltinESMExports();\n`;
function inspectNodeRuntime() {
  const actual = process.report.getReport().sharedObjects.filter(p => p.startsWith('/opt/homebrew/Cellar/')).sort();
  const expected = NODE_RUNTIME_PINS.map(p => p.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || fs.realpathSync(process.execPath) !== NODE_RUNTIME_PINS[0].path) fail('Node runtime inventory changed; review exact library pins');
  for (const [link, target] of Object.entries(NODE_LOADER_CHAIN.links)) {
    if (!fs.lstatSync(link).isSymbolicLink() || fs.readlinkSync(link) !== target) fail('Node loader symlink chain drift');
  }
  for (const [directory, pin] of Object.entries(NODE_LOADER_CHAIN.directories)) {
    const st = fs.statSync(directory);
    if (fs.realpathSync(directory) !== directory || !st.isDirectory() || st.dev !== pin.dev || st.ino !== pin.ino || (st.mode & 0o777) !== pin.mode) fail('Node loader parent identity drift');
  }
  for (const [alias, canonical] of Object.entries(NODE_RUNTIME_ALIASES)) {
    if (!NODE_RUNTIME_PINS.some(p => p.path === canonical) || fs.realpathSync(alias) !== canonical) fail('Node loader alias drift');
  }
  for (const pin of NODE_RUNTIME_PINS) {
    if (hash(readAbsolute(pin.path, 256 * 1024 ** 2)) !== pin.sha256 || (fs.statSync(pin.path).mode & 0o022)) fail('Node runtime hash/permissions drift');
  }
}
function inspect(manifestPath) {
  inspectNodeRuntime();
  const native = inspectNativeManifest(manifestPath);
  const files = inventory({ extraFiles: EXTRA_SOURCE_FILES });
  const imports = inspectImports(files), dependencyLinks = inspectDependencyLinks();
  if (imports.fonts.some(p => p !== 'lib/app-fonts.ts')) fail('Unreviewed Google font entrypoint in source');
  noLinks(SCRATCH);
  if (freeBytes(SCRATCH) < LIMIT.minFreeBytes) fail('Insufficient scratch free space');
  if (process.platform !== 'darwin') fail('Reviewed macOS containment required; no fallback');
  return { files, imports, native, dependencyLinks };
}
export async function prepare(options) {
  const checked = inspect(options['native-manifest']);
  const root = fs.mkdtempSync(path.join(SCRATCH, OWNED_PREFIX));
  fs.chmodSync(root, 0o700);
  const app = path.join(root, 'app-source');
  fs.mkdirSync(app, { mode: 0o700 });
  const copied = [];
  for (const [relative, bytes] of checked.files) {
    writeNew(app, relative, bytes); copied.push({ relative, sha256: hash(bytes), bytes: bytes.length });
  }
  const dependencies = path.join(SOURCE, 'node_modules');
  fs.symlinkSync(dependencies, path.join(app, 'node_modules'), 'dir');
  for (const dir of ['data', 'public', 'public/runs', '.astra-home', '.astra-home/tmp', '.astra-home/cache', '.astra-home/native-jobs']) fs.mkdirSync(path.join(app, dir), { mode: 0o700 });
  const generated = {
    'app-source/next-env.d.ts': '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    'app-source/.astra-workspace.json': JSON.stringify({ version: 1, root: app, purpose: 'isolated-astra-beta' }),
    'resource-guard.cjs': RESOURCE_GUARD,
  };
  for (const [relative, bytes] of Object.entries(generated)) writeNew(root, relative, bytes);
  const secrets = { authSecret: randomBytes(32).toString('hex'), email: options['test-email'], password: randomBytes(24).toString('base64url') };
  writeNew(root, 'operator-secrets.json', JSON.stringify(secrets));
  // Existing auth owns its module-level data path. Select staged cwd BEFORE
  // importing it. This module has only built-in imports; never copy an account DB.
  const authBytes = checked.files.get('lib/auth.ts');
  // Other auth functions have a lazy design-state require. It is covered by
  // full-snapshot import inspection, but createUser does not execute it.
  const ts = require('typescript');
  const authTree = ts.createSourceFile('auth.ts', authBytes.toString(), ts.ScriptTarget.Latest, true);
  for (const statement of authTree.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && !statement.moduleSpecifier.text.startsWith('node:')) fail('Auth initialization imports need review');
  }
  const oldCwd = process.cwd(), oldMask = process.umask(0o077);
  try {
    process.chdir(app);
    const { createUser } = await import(pathToFileURL(path.join(app, 'lib/auth.ts')).href);
    const result = createUser(secrets.email, secrets.password);
    if ('error' in result) fail('Dedicated isolated account creation failed');
  } finally { process.chdir(oldCwd); process.umask(oldMask); }
  const m = { schema: 'astra-source-snapshot/v1', root, app, source: SOURCE,
    createdAt: new Date().toISOString(), testEmail: secrets.email, node: fs.realpathSync(process.execPath), nodeVersion: process.version,
    dependencies, nextCli: fs.realpathSync(require.resolve('next/dist/bin/next')), copied,
    generated: Object.entries(generated).map(([relative, bytes]) => ({ relative, sha256: hash(bytes) })),
    launcherSha256: hash(safeRead(SOURCE, 'scripts/astra-local.mjs')), stagingSha256: hash(safeRead(SOURCE, 'scripts/source-snapshot.mjs')),
    native: checked.native, imports: checked.imports, dependencyLinks: checked.dependencyLinks, excluded: EXCLUDED,
    limits: LAUNCH_LIMITS, fonts: 'beta-only actual system fonts; webpack alias; not a production-font gate',
    status: { built: false, served: false, inference: 'not run', nativeContainment: 'unverified' } };
  writeNew(root, 'manifest.json', JSON.stringify(m, null, 2));
  return m;
}
const QUALIFICATION_MODULES = Object.freeze(['astra-readiness', 'astra-beta', 'astra-origin', 'auth', 'astra-execution',
  'astra-local-parts', 'astra-validator-evidence', 'astra-validator-containment', 'astra-drc', 'astra-ground-evidence',
  'astra-project-policy', 'astra-export-evidence'].map(name => `lib/${name}.ts`));
const QUALIFICATION_JSON = Object.freeze(['lib/astra-catalog.json', 'lib/astra-native-pins.json']);
const QUALIFICATION_BUILTINS = new Set(['node:fs', 'node:fs/promises', 'node:path', 'node:crypto', 'node:async_hooks', 'node:os', 'node:child_process']);
/** Actual staged modules, not replacement validators. Process execution and network are unavailable. */
export function loadQualificationModule(m, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('Qualification needs the selected loopback port');
  const ts = require('typescript'), cache = new Map();
  const env = Object.freeze({ NODE_ENV: 'development', FL_ASTRA_BETA: '1', FL_ASTRA_ROOT: m.app, FL_ASTRA_BIND: '127.0.0.1',
    FL_ASTRA_ORIGIN: `http://127.0.0.1:${port}`, HOME: path.join(m.app, '.astra-home'), FL_ADMIN_EMAILS: m.testEmail });
  const blocked = () => { throw new Error('Qualification cannot execute processes or make network requests'); };
  const context = vm.createContext({ Error, Buffer, Uint8Array, URL, TextDecoder, TextEncoder, AbortController, AbortSignal, setTimeout, clearTimeout,
    process: Object.freeze({ env, cwd: () => m.app, getuid: () => process.getuid(), platform: process.platform }), fetch: blocked,
  }, { codeGeneration: { strings: false, wasm: false } });
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    if (QUALIFICATION_JSON.includes(relative)) {
      const value = JSON.parse(safeRead(m.app, relative)); cache.set(relative, { exports: value }); return value;
    }
    if (!QUALIFICATION_MODULES.includes(relative)) fail('Qualification import outside fixed module graph');
    const loadedModule = { exports: {} }; cache.set(relative, loadedModule);
    const localRequire = specifier => {
      if (QUALIFICATION_BUILTINS.has(specifier)) {
        if (specifier === 'node:child_process') return Object.freeze({ spawn: blocked, spawnSync: blocked, exec: blocked, execFile: blocked, fork: blocked });
        return require(specifier);
      }
      if (typeof specifier !== 'string' || (!specifier.startsWith('.') && !specifier.startsWith('@/'))) fail('Unapproved qualification dependency');
      let next = specifier.startsWith('@/') ? specifier.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (!next.endsWith('.json') && !next.endsWith('.ts')) next += '.ts';
      return load(next);
    };
    const output = ts.transpileModule(safeRead(m.app, relative).toString(), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    // Invocation stays inside runInContext so synchronous module initialization,
    // not just function creation, is covered by the timeout. Preserve nested loads.
    const previous = context.__qualificationLoad;
    context.__qualificationLoad = { require: localRequire, loadedModule };
    try {
      vm.runInContext(`(function(require,module,exports){${output}\n})(__qualificationLoad.require, __qualificationLoad.loadedModule, __qualificationLoad.loadedModule.exports)`,
        context, { filename: path.join(m.app, relative), timeout: 2000 });
    } finally { context.__qualificationLoad = previous; }
    return loadedModule.exports;
  }
  return load('lib/astra-readiness.ts');
}

export function qualificationInventory(m, api, bundleId, includeReceipt = false) {
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(bundleId ?? '')) fail('Invalid qualification bundle ID');
  const base = '.astra-home/qualifications', bundle = `${base}/${bundleId}`;
  privateDir(path.join(m.app, base)); privateDir(path.join(m.app, bundle));
  if (fs.readdirSync(path.join(m.app, base)).join(',') !== bundleId) fail('Exactly one qualification bundle is permitted');
  const limits = { ...api.ASTRA_QUALIFICATION_FILES, 'qualification.json': 256 * 1024 };
  if (!Object.keys(limits).length || Object.keys(limits).length > 64) fail('Qualification inventory exceeds limit');
  const expected = Object.keys(limits).sort();
  if (JSON.stringify(fs.readdirSync(path.join(m.app, bundle)).sort()) !== JSON.stringify(expected)) fail('Qualification files must match the exact reviewed inventory');
  const records = {}; let total = 0;
  for (const name of expected) {
    if (!/^[a-z0-9][a-z0-9._-]+$/.test(name) || !Number.isSafeInteger(limits[name]) || limits[name] <= 0 || limits[name] > 64 * 1024 ** 2) fail('Unsafe qualification filename/bound');
    const relative = `${bundle}/${name}`, bytes = privateFile(m.app, relative, limits[name]); total += bytes.length;
    if (total > 192 * 1024 ** 2) fail('Qualification total size limit');
    records[relative] = { sha256: hash(bytes), bytes: bytes.length };
  }
  if (includeReceipt) {
    const relative = '.astra-home/astra-readiness.json', bytes = privateFile(m.app, relative, 64 * 1024);
    records[relative] = { sha256: hash(bytes), bytes: bytes.length };
  }
  return { bundleRoot: path.join(m.app, bundle), records, directories: [base, bundle] };
}
function validateSnapshot(input, options = {}) {
  const root = path.resolve(input);
  if (path.dirname(root) !== SCRATCH || !path.basename(root).startsWith(OWNED_PREFIX)) fail('Not an owned Astra snapshot');
  privateDir(root);
  const m = JSON.parse(privateFile(root, 'manifest.json'));
  if (m.schema !== 'astra-source-snapshot/v1' || m.root !== root || m.app !== path.join(root, 'app-source') || m.source !== SOURCE) fail('Snapshot identity changed');
  if (m.launcherSha256 !== hash(safeRead(SOURCE, 'scripts/astra-local.mjs')) || m.stagingSha256 !== hash(safeRead(SOURCE, 'scripts/source-snapshot.mjs'))) fail('Launcher/helper drift: prepare again');
  if (m.node !== fs.realpathSync(process.execPath) || m.nextCli !== fs.realpathSync(require.resolve('next/dist/bin/next'))) fail('Runtime drift');
  inspectNodeRuntime();
  const native = inspectNativeManifest(m.native.sourcePath);
  if (native.sha256 !== m.native.sha256 || JSON.stringify(native.pins) !== JSON.stringify(m.native.pins)) fail('Native pins drift');
  inspectDependencyLinks();
  if (m.dependencies !== path.join(SOURCE, 'node_modules') || !fs.lstatSync(path.join(m.app, 'node_modules')).isSymbolicLink() || fs.realpathSync(path.join(m.app, 'node_modules')) !== m.dependencies) fail('Dependency link drift');
  const current = inventory({ extraFiles: EXTRA_SOURCE_FILES });
  inspectImports(current);
  if (current.size !== m.copied.length) fail('Source inventory changed; prepare again');
  for (const f of m.copied) if (!current.has(f.relative) || hash(current.get(f.relative)) !== f.sha256 || hash(safeRead(m.app, f.relative)) !== f.sha256) fail(`Source drift: ${f.relative}`);
  for (const f of m.generated) if (hash(privateFile(root, f.relative)) !== f.sha256) fail('Generated launcher input drift');
  for (const dir of [m.app, ...['data', 'public', 'public/runs', '.astra-home', '.astra-home/tmp', '.astra-home/cache', '.astra-home/native-jobs'].map(d => path.join(m.app, d))]) privateDir(dir);
  // Initial snapshot is single-use for serve and contains only one NEW account.
  if (fs.existsSync(path.join(root, 'serve-started.json')) || fs.existsSync(path.join(root, 'build-started.json'))) fail('Snapshot already used; prepare a fresh snapshot for each build or serve');
  const secrets = JSON.parse(privateFile(root, 'operator-secrets.json'));
  if (secrets.email !== m.testEmail || !/^[a-z0-9][a-z0-9._+\-]*@example\.test$/.test(m.testEmail)) fail('Dedicated identity mismatch');
  const users = JSON.parse(privateFile(m.app, 'data/users.json'));
  if (Object.keys(users).length !== 1 || users[m.testEmail]?.email !== m.testEmail || users[m.testEmail]?.llmKey || users[m.testEmail]?.runIds?.length) fail('Snapshot identity store changed');
  if (fs.readdirSync(path.join(m.app, 'public/runs')).length) fail('Run storage must start empty');
  const sourceAllowed = new Set([...m.copied.map(f => f.relative), 'next-env.d.ts', '.astra-workspace.json', 'data/users.json']);
  const directoryAllowed = new Set(['data', 'public', 'public/runs', '.astra-home', '.astra-home/tmp', '.astra-home/cache', '.astra-home/native-jobs']);
  let qualification;
  const sealPath = path.join(root, 'qualification-seal.json');
  if (options.qualification) {
    if (fs.existsSync(sealPath)) fail('Qualification already sealed');
    if (fs.existsSync(path.join(m.app, '.astra-home/astra-readiness.json'))) fail('Fresh qualification cannot replace an existing receipt');
    const api = loadQualificationModule(m, options.port);
    qualification = { ...qualificationInventory(m, api, options.bundleId), api, bundleId: options.bundleId, port: options.port };
  } else if (fs.existsSync(sealPath)) {
    const seal = JSON.parse(privateFile(root, 'qualification-seal.json', 128 * 1024));
    if (seal.schema !== 'astra-launcher-qualification-seal/v1' || seal.root !== m.root || seal.sourceManifestSha256 !== hash(privateFile(root, 'manifest.json')) || !Number.isInteger(seal.port)) fail('Qualification seal identity mismatch');
    const api = loadQualificationModule(m, seal.port), current = qualificationInventory(m, api, seal.bundleId, true);
    if (JSON.stringify(current.records) !== JSON.stringify(seal.records)) fail('Qualification seal file drift');
    qualification = { ...current, api, bundleId: seal.bundleId, port: seal.port, sealed: true };
  }
  if (qualification) {
    for (const file of Object.keys(qualification.records)) sourceAllowed.add(file);
    for (const dir of qualification.directories) directoryAllowed.add(dir);
  }
  for (const file of sourceAllowed) for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) directoryAllowed.add(dir);
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(m.app, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === 'node_modules' && entry.isSymbolicLink()) continue;
      if (entry.isSymbolicLink()) fail('Unexpected staged symlink');
      if (entry.isDirectory()) { if (!directoryAllowed.has(name)) fail('Unexpected staged directory'); privateDir(path.join(m.app, name)); walk(name); }
      else if (!entry.isFile() || !sourceAllowed.has(name) || fs.lstatSync(path.join(m.app, name)).nlink !== 1) fail(`Unexpected staged file: ${name}`);
    }
  }
  walk();
  if (fs.existsSync(path.join(m.app, '.next-astra'))) fail('Compiler output must start empty');
  const rootAllowed = new Set(['app-source', 'manifest.json', 'operator-secrets.json', 'resource-guard.cjs', ...(qualification?.sealed ? ['qualification-seal.json'] : [])]);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!rootAllowed.has(entry.name) || entry.isSymbolicLink()) fail('Unexpected launcher-root input');
  }
  return { m, secrets, qualification };
}
export async function verifyAndPublishQualification(api, bundleRoot, expectedRecords, inspect) {
  const capability = await api.verifyAstraQualification(bundleRoot);
  await api.publishAstraReadiness(capability);
  const status = await api.readAstraReadiness();
  if (status.ready !== true) fail('Published qualification did not reverify');
  const current = inspect();
  for (const [name, record] of Object.entries(expectedRecords)) if (JSON.stringify(current.records[name]) !== JSON.stringify(record)) fail('Qualification changed during publication');
  return { status, current };
}
export async function sealQualification(options) {
  const { m, qualification } = validateSnapshot(options.snapshot, { qualification: true, bundleId: options['bundle-id'], port: options.port });
  const { status, current } = await verifyAndPublishQualification(qualification.api, qualification.bundleRoot, qualification.records,
    () => qualificationInventory(m, qualification.api, qualification.bundleId, true));
  const seal = { schema: 'astra-launcher-qualification-seal/v1', root: m.root, sourceManifestSha256: hash(privateFile(m.root, 'manifest.json')),
    bundleId: qualification.bundleId, port: options.port, records: current.records, qualifiedAt: status.qualifiedAt, expiresAt: status.expiresAt };
  writeNew(m.root, 'qualification-seal.json', JSON.stringify(seal, null, 2));
  return { root: m.root, bundleId: seal.bundleId, sealed: true, qualificationScope: 'native-backend', expiresAt: status.expiresAt,
    applicationIntegrationVerified: false, inference: 'not run' };
}
export function inspectValidatorEndpoint(m, controller) {
  if (!controller || typeof controller.close !== 'function' || !/^[a-f0-9]{64}$/.test(controller.authSecret ?? '')) fail('Invalid private validator endpoint');
  const socket = controller.socketPath;
  if (typeof socket !== 'string' || !/^\/private\/tmp\/astra-v-[A-Za-z0-9]+\/control\.sock$/.test(socket) || socket.startsWith(`${m.root}/`)) fail('Validator socket must be outside app-owned storage');
  const parent = path.dirname(socket); privateDir(parent); noLinks(socket);
  const st = fs.lstatSync(socket);
  if (!st.isSocket() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) fail('Validator socket ownership/permissions changed');
}

/** Injectable lifecycle seam for mock tests; the CLI always supplies the fixed host controller. */
export async function withValidatorController({ mode, manifest, start, run, inspect = inspectValidatorEndpoint, signal }) {
  if (mode !== 'serve') return { result: await run(undefined), cleanupConfirmed: true };
  let controller, result, failed = false, cleanupConfirmed = false;
  try {
    controller = await start({ launchRoot: manifest.root });
    inspect(manifest, controller);
    if (signal?.aborted) throw new Error('Interrupted during validator startup');
    result = await run(controller);
  } catch { failed = true; }
  finally {
    if (controller) {
      try { cleanupConfirmed = (await controller.close())?.cleanupConfirmed === true; }
      catch { cleanupConfirmed = false; }
    }
  }
  return { result, failed, cleanupConfirmed };
}
async function startFixedValidator(options) {
  const { startAstraValidatorController } = await import('./astra-validator-controller.mjs');
  return startAstraValidatorController(options);
}
export async function launch(options) {
  const { m, secrets, qualification } = validateSnapshot(options.snapshot);
  if (qualification) {
    if (options.mode !== 'serve' || options.port !== qualification.port || (await qualification.api.readAstraReadiness()).ready !== true) fail('Sealed qualification is stale or bound to a different serve port');
  }
  // Validate all user-provided execution options before opening the controller.
  if (options.mode !== 'serve' && options.mode !== 'build') fail('Launch requires an explicit execution mode');
  if (options.mode === 'serve' && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) fail('Explicit loopback port required');
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let outcome;
  try {
    outcome = await withValidatorController({ mode: options.mode, manifest: m, start: startFixedValidator, signal: abort.signal,
      run: validator => runAppProcess(options, m, secrets, validator, abort.signal) });
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  const report = outcome.result ?? { mode: options.mode, code: null, signal: null, reason: 'validator-or-app-start-failed', productionGate: false };
  report.validatorCleanupConfirmed = outcome.cleanupConfirmed;
  if (!outcome.cleanupConfirmed) report.reason = 'validator-cleanup-unconfirmed';
  else if (outcome.failed) report.reason = 'validator-or-app-start-failed';
  writeNew(m.root, `${options.mode}-result.json`, JSON.stringify(report, null, 2));
  return report;
}
async function runAppProcess(options, m, secrets, validator, signal) {
  const mode = options.mode, port = options.port, proxyUrl = options['proxy-url'];
  const adapter = options.cli ? inspectAdapter(options.cli, options['cli-sha256']) : undefined;
  if (!!adapter !== !!proxyUrl || (mode !== 'serve' && adapter)) fail('Adapter only allowed with explicit serve and proxy options');
  if (mode === 'build' && fs.existsSync(path.join(m.root, 'build-started.json'))) fail('Snapshot already built');
  if (freeBytes(m.root) < LIMIT.minFreeBytes) fail('Insufficient free space');
  writeNew(m.root, `${mode}-started.json`, JSON.stringify({ startedAt: new Date().toISOString(), mode, port, adapter: proxyUrl ?? null }));
  const profile = sandboxProfile(m, { mode, port, proxyUrl, adapter, validator });
  writeNew(m.root, `${mode}.sb`, profile);
  const log = fs.openSync(path.join(m.root, `${mode}.log`), 'wx', 0o600);
  const args = mode === 'build' ? ['build', '--webpack'] : ['dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)];
  let child;
  try {
    child = spawn(m.native.pins.tools.sandbox.path, ['-f', path.join(m.root, `${mode}.sb`), m.node, m.nextCli, ...args], {
      cwd: m.app, env: cleanEnv(m, { mode, port, proxyUrl, adapter, validator }, secrets), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { fs.closeSync(log); throw new Error('Owned app spawn failed'); }
  let logBytes = 0, reason = null, hardKill;
  const started = Date.now();
  const kill = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch {} };
  const stop = why => { if (reason) return; reason = why; kill('SIGTERM'); hardKill = setTimeout(() => kill('SIGKILL'), 2000); };
  const capture = chunk => { const room = Math.max(0, LIMIT.logBytes - logBytes); if (room) fs.writeSync(log, chunk.subarray(0, room)); logBytes += chunk.length; if (logBytes > LIMIT.logBytes) stop('log-size-limit'); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setInterval(() => { try {
    if (Date.now() - started >= (mode === 'serve' ? LAUNCH_LIMITS.serveMs : LIMIT.wallMs)) stop('wall-time-limit');
    else if (freeBytes(m.root) < LIMIT.minFreeBytes) stop('free-space-limit');
    else if (treeSize(m.root) > LIMIT.outputBytes) stop('output-size-limit');
  } catch { stop('resource-check-failed'); } }, LIMIT.pollMs);
  const interrupted = () => stop('interrupted');
  signal.addEventListener('abort', interrupted, { once: true });
  if (signal.aborted) interrupted();
  const result = await new Promise(resolve => { child.once('error', () => { reason = 'spawn-error'; resolve({ code: null, signal: null }); }); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearInterval(timer); clearTimeout(hardKill); kill('SIGKILL'); fs.closeSync(log);
  signal.removeEventListener('abort', interrupted);
  return { mode, ...result, reason, elapsedMs: Date.now() - started, logBytes, log: path.join(m.root, `${mode}.log`), productionGate: false };
}
async function main() {
  if (fileURLToPath(import.meta.url) !== SELF) fail('Use the canonical reviewed source launcher');
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'check') {
    const checked = inspect(options['native-manifest']);
    console.log(JSON.stringify({ mode: 'check-only', files: checked.files.size, sourceBytes: [...checked.files.values()].reduce((n, b) => n + b.length, 0),
      nativePins: checked.native.sha256, containment: 'unverified; requires contained probes', capabilities: 'unverified', imports: checked.imports,
      dependencyLinks: checked.dependencyLinks, limits: LAUNCH_LIMITS, noProcessesStarted: true }, null, 2));
  } else if (options.mode === 'prepare') {
    const m = await prepare(options);
    console.log(JSON.stringify({ root: m.root, app: m.app, manifest: path.join(m.root, 'manifest.json'), privateCredentialsFile: path.join(m.root, 'operator-secrets.json'), testEmail: m.testEmail,
      built: false, served: false, inference: 'not run' }, null, 2));
  } else if (options.mode === 'seal-qualification') {
    console.log(JSON.stringify(await sealQualification(options), null, 2));
  } else {
    const result = await launch(options); console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.code === 0 && !result.reason ? 0 : 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  // Source/OS diagnostics can contain credentials. Details stay in private logs.
  console.error('Astra launcher blocked. Check explicit options, reviewed pins, snapshot freshness and private logs. No credentials are printed.'); process.exitCode = 1;
});
