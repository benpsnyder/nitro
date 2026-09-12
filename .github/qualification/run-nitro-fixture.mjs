import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(process.argv[2]);
const mode = process.argv[3] || 'production';
const legacy = process.argv[4] === 'legacy';
const includeCompiler = mode !== 'unused';
const outDir = join(root, `output-${mode}-${legacy ? 'legacy' : 'default'}`);
const source = includeCompiler
  ? "export default async () => { const ts = await import('typescript'); return { version: ts.version }; };\n"
  : 'export default () => ({ ok: true });\n';
await writeFile(join(root, 'server/routes/ts.get.ts'), source);
const { createNitro, prepare, build, createDevServer } = await import(
  pathToFileURL(join(root, 'node_modules/nitropack/dist/core/index.mjs')).href
);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function request(port, child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child && child.exitCode !== null) return { status: null, exited: child.exitCode };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ts`, { signal: AbortSignal.timeout(2000) });
      return { status: response.status, body: await response.text() };
    } catch {
      await delay(100);
    }
  }
  return { status: null, timeout: true };
}

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((e) => e.isDirectory() ? files(join(dir, e.name)) : join(dir, e.name)))).flat();
}

const nitro = await createNitro({
  rootDir: root,
  srcDir: 'server',
  preset: 'node-server',
  dev: mode === 'development',
  compatibilityDate: '2024-11-19',
  logLevel: 0,
  typescript: { generateTsConfig: false },
  experimental: { legacyExternals: legacy },
  output: { dir: outDir, serverDir: join(outDir, 'server'), publicDir: join(outDir, 'public') },
});
let result;
try {
  if (mode === 'development') {
    const server = createDevServer(nitro);
    try {
      await build(nitro);
      const port = await freePort();
      await server.listen(port, { hostname: '127.0.0.1', showURL: false });
      result = await request(port);
    } finally {
      await server.close();
    }
  } else {
    await prepare(nitro);
    await build(nitro);
    const deployment = join(root, '..', `portable-${root.split(/[\\/]/).at(-1)}-${mode}-${legacy}`);
    await rm(deployment, { recursive: true, force: true });
    await cp(join(outDir, 'server'), deployment, { recursive: true });
    const emitted = await files(deployment);
    const compilerManifest = emitted.find((file) => file.endsWith(join('typescript', 'package.json')));
    const compilerChunk = emitted.some((file) => /[\\/]chunks[\\/].*[\\/]typescript\.mjs$/.test(file));
    const port = await freePort();
    let logs = '';
    const child = spawn(process.execPath, [join(deployment, 'index.mjs')], {
      cwd: deployment,
      env: { ...process.env, NITRO_PORT: `${port}`, NITRO_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    try {
      result = { ...await request(port, child), compilerManifest: !!compilerManifest, compilerChunk };
      if (compilerManifest) {
        const compiler = createRequire(join(deployment, 'index.mjs')).resolve('typescript');
        assert(compiler.startsWith(deployment), 'compiler must resolve inside relocated output');
        result.compilerVersion = JSON.parse(await readFile(compilerManifest, 'utf8')).version;
      }
      if (!includeCompiler) {
        assert.equal(compilerManifest, undefined);
        assert.equal(compilerChunk, false);
        assert.equal(result.status, 200);
        assert.deepEqual(JSON.parse(result.body), { ok: true });
      }
    } finally {
      if (child.exitCode === null) {
        const exit = new Promise((done) => child.once('exit', done));
        child.kill();
        await exit;
      }
      result.logs = logs;
    }
  }
} finally {
  await nitro.close();
}
const receipt = { root, mode, legacy, node: process.version, ...result };
await writeFile(join(root, `result-${mode}-${legacy ? 'legacy' : 'default'}.json`), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
