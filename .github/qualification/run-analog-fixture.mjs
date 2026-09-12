import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkOutput, request } from './fixture-runtime.mjs';

const root = resolve(process.argv[2]);
const mode = process.argv[3] || 'production';
const outDir = join(root, `output-${mode}`);
const source = mode === 'unused'
  ? 'export default () => ({ ok: true });\n'
  : "export default async () => { const ts = await import('typescript'); return { version: ts.version }; };\n";
await writeFile(join(root, 'src/server/routes/ts.get.ts'), source);
const { build, createServer } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
const { default: nitro } = await import(pathToFileURL(join(root, 'node_modules/@analogjs/vite-plugin-nitro/src/index.js')).href);
const config = {
  root,
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: { usePolling: true } },
  plugins: [nitro({ ssr: false, workspaceRoot: root, sourceRoot: 'src' }, {
    preset: 'node-server',
    output: { dir: outDir, serverDir: join(outDir, 'server'), publicDir: join(outDir, 'public') },
  })],
};
let result;
if (mode === 'development') {
  const server = await createServer(config);
  try {
    await server.listen();
    result = await request(server.httpServer.address().port, undefined, '/api/ts');
  } finally {
    await server.close();
  }
} else {
  await build(config);
  const deployment = join(root, '..', `portable-${root.split(/[\\/]/).at(-1)}-${mode}`);
  result = await checkOutput(join(outDir, 'server'), deployment, mode === 'unused');
}
const receipt = { root, mode, node: process.version, ...result };
await writeFile(join(root, `result-${mode}.json`), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
process.exit(result.status === 200 ? 0 : 1);
