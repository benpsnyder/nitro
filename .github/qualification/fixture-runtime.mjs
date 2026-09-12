import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { cp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

export async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export async function request(port, child, path = '/ts') {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child && child.exitCode !== null) return { status: null, exited: child.exitCode };
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
      return { status: response.status, body: await response.text() };
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  return { status: null, timeout: true };
}

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((e) => e.isDirectory() ? files(join(dir, e.name)) : join(dir, e.name)))).flat();
}

export async function checkOutput(serverDir, deployment, unused = false) {
  await rm(deployment, { recursive: true, force: true });
  await cp(serverDir, deployment, { recursive: true });
  const emitted = await files(deployment);
  const compilerManifest = emitted.find((file) => file.endsWith(join('typescript', 'package.json')));
  const compilerChunk = emitted.some((file) => /[\\/]chunks[\\/].*[\\/]typescript\.mjs$/.test(file));
  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, [join(deployment, 'index.mjs')], {
    cwd: deployment,
    env: { ...process.env, NITRO_PORT: `${port}`, NITRO_HOST: '127.0.0.1', PORT: `${port}`, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  let result;
  try {
    result = { ...await request(port, child), compilerManifest: !!compilerManifest, compilerChunk };
    if (compilerManifest) {
      const compiler = createRequire(join(deployment, 'index.mjs')).resolve('typescript');
      assert(compiler.startsWith(deployment), 'compiler must resolve inside relocated output');
      result.compilerVersion = JSON.parse(await readFile(compilerManifest, 'utf8')).version;
    }
    if (unused) {
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
  }
  return { ...result, logs };
}
