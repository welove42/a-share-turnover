/** 编译扩展主进程，并把浏览器依赖打入独立 Webview 文件。 */
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
const { build } = require('esbuild') as typeof import('esbuild');
const root = path.resolve(__dirname, '..');
function tsc(config: string, noEmit: boolean) {
  const args = [require.resolve('typescript/bin/tsc'), '-p', config, ...(noEmit ? ['--noEmit'] : [])];
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
async function main() {
  const checking = process.argv.includes('--check');
  if (!checking) {
    const output = path.resolve(root, 'dist');
    // 清理范围固定在本项目的编译目录，不接收外部路径。
    if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('Invalid build path');
    fs.rmSync(output, { recursive: true, force: true });
  }
  tsc('tsconfig.json', checking);
  tsc('tsconfig.webviews.json', true);
  if (checking) return;
  await build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(
      ['ai-analysis', 'chart', 'settings', 'temperature-chart'].map((name) => [
        name,
        'src/webviews/' + name + '/index.ts'
      ])
    ),
    bundle: true,
    outdir: 'dist/webviews',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: false,
    logLevel: 'info'
  });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
