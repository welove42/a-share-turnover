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
  // Marketplace rejects icons over 1 MiB even when vsce package succeeds; catch this locally before publishing.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.icon && fs.statSync(path.join(root, manifest.icon)).size > 1024 * 1024) {
    throw new Error('插件图标超过 Marketplace 的 1024 KB 限制，请压缩后重新打包。');
  }
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
      ['ai-analysis', 'chart', 'settings', 'temperature-chart', 'sector-board'].map((name) => [
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
