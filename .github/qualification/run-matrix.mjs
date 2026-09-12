import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(process.argv[2]);
const fixtures = join(workspace, 'qualification');
const artifacts = join(workspace, 'artifacts');
const fileSpec = (name) => `file:${join(artifacts, name).replaceAll('\\', '/')}`;
const receipts = [];
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, env: { ...process.env, CHOKIDAR_USEPOLLING: '1' }, encoding: 'utf8', shell: process.platform === 'win32' && command === 'pnpm', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] });
}
for (const [name, analog, overrides] of [
  ['baseline', false, {}],
  ['mlly-only', false, { mlly: fileSpec('mlly-1.8.2.tgz') }],
  ['nitro-only', false, { nitropack: fileSpec('nitropack-2.13.4.tgz') }],
  ['paired', false, { mlly: fileSpec('mlly-1.8.2.tgz'), nitropack: fileSpec('nitropack-2.13.4.tgz') }],
  ...['6.4.3', '7.3.6', '8.2.2'].map(v => [`analog-v${v[0]}`, v, { mlly: fileSpec('mlly-1.8.2.tgz'), nitropack: fileSpec('nitropack-2.13.4.tgz') }]),
]) {
  const root = join(fixtures, name);
  await mkdir(join(root, analog ? 'src/server/routes' : 'server/routes'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, private: true, type: 'module', packageManager: 'pnpm@10.33.4', dependencies: { typescript: '6.0.3', ...(analog ? { '@analogjs/vite-plugin-nitro': '2.8.0-beta.3', vite: analog } : { nitropack: '2.13.4' }) }, pnpm: { overrides } }, null, 2));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\nonlyBuiltDependencies:\n  - esbuild\n  - "@parcel/watcher"\n');
  if (analog) await writeFile(join(root, 'index.html'), '<html><body>qualification</body></html>');
  await writeFile(join(root, 'install.log'), run('pnpm', ['install', '--no-frozen-lockfile'], root));
  const cases = name === 'paired' ? [['production'], ['development'], ['unused'], ['production', 'legacy']] : analog ? [['production'], ['development'], ['unused']] : [['production']];
  for (const [mode, legacy] of cases) {
    console.log(`Running ${name} ${mode} ${legacy || ''}`);
    const log = join(root, `run-${mode}-${legacy || 'default'}.log`);
    try { await writeFile(log, run(process.execPath, [join(here, analog ? 'run-analog-fixture.mjs' : 'run-nitro-fixture.mjs'), root, mode, ...(legacy ? [legacy] : [])], root)); }
    catch (error) { await writeFile(log, `${error.stdout || ''}\n${error.stderr || ''}`); throw error; }
    const receipt = JSON.parse(await readFile(join(root, `result-${mode}${analog ? '' : `-${legacy || 'default'}`}.json`), 'utf8'));
    const paired = name === 'paired' || analog;
    assert.equal(receipt.status, paired ? 200 : 500, name);
    if (paired && mode !== 'unused') assert.equal(JSON.parse(receipt.body).version, '6.0.3');
    if (mode !== 'development') {
      assert.equal(receipt.compilerManifest, !!paired && mode !== 'unused');
      assert.equal(receipt.compilerChunk, !paired);
    }
    receipts.push({ name, ...receipt });
    await writeFile(join(fixtures, 'matrix.json'), JSON.stringify(receipts, null, 2));
  }
}
console.log(`PASS: ${receipts.length} qualification cases on ${process.platform}`);
