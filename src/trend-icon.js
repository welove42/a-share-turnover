'use strict';
const vscode = require('vscode');
const { HEX_COLOR } = require('./stock-colors');

function trendIcon(extensionUri, percent, palette) {
  if (!Number.isFinite(percent) || percent === 0) return new vscode.ThemeIcon('dash');
  const direction = percent > 0 ? 'up' : 'down';
  if (palette?.mode === 'neutral') return new vscode.ThemeIcon(`chevron-${direction}`);
  const color = percent > 0 ? palette?.up : palette?.down;
  if (palette?.mode === 'custom' && typeof color === 'string' && HEX_COLOR.test(color)) {
    const path = percent > 0 ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const uri = vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
    return { light: uri, dark: uri };
  }
  // Selection foreground overrides ThemeIcon colors. Image strokes retain their
  // own colors in focused and inactive selections, with assets for both themes.
  return {
    light: vscode.Uri.joinPath(extensionUri, 'media', `trend-${direction}-light.svg`),
    dark: vscode.Uri.joinPath(extensionUri, 'media', `trend-${direction}-dark.svg`)
  };
}
module.exports = { trendIcon };
