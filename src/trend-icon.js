'use strict';
const vscode = require('vscode');

function trendIcon(extensionUri, percent) {
  if (!Number.isFinite(percent) || percent === 0) return new vscode.ThemeIcon('dash');
  const direction = percent > 0 ? 'up' : 'down';
  // Selection foreground overrides ThemeIcon colors. Image strokes retain their
  // own colors in focused and inactive selections, with assets for both themes.
  return {
    light: vscode.Uri.joinPath(extensionUri, 'media', `trend-${direction}-light.svg`),
    dark: vscode.Uri.joinPath(extensionUri, 'media', `trend-${direction}-dark.svg`)
  };
}
module.exports = { trendIcon };
