#!/usr/bin/env node
/**
 * Drift-check: asserts that the inline THEME_COLORS map in src/index.html
 * matches the canonical map exported from theme-colors.ts, AND that the
 * static <meta name="theme-color"> tag matches THEME_COLORS[DEFAULT_THEME].
 *
 * Runs as a prebuild step so CI fails immediately on divergence rather than
 * silently shipping mismatched pre-boot colors.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/**
 * Parse a block of `key: '#value',` lines into an object.
 * Fails if no entries parsed or if the count of key/value pairs in the
 * source doesn't match the parsed count (guards against silent regex drift
 * if the source formatting ever changes — e.g. double quotes, quoted keys).
 */
function parseColorBlock(block, label) {
  const parsed = {};
  const lines = block.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(\w+):\s*'(#[0-9a-fA-F]{3,8})'/);
    if (m) parsed[m[1]] = m[2];
  }
  // Count lines that look like a key/value entry (a colon followed by a value
  // that doesn't start with `{` or `[`), so we can detect silent parse skips.
  const entryLines = lines.filter(l => /^\s*\S+\s*:\s*[^{[]/.test(l));
  const parsedCount = Object.keys(parsed).length;
  if (parsedCount === 0) {
    console.error(`ERROR: parsed 0 entries from ${label} THEME_COLORS block; regex likely out of sync with source format.`);
    process.exit(1);
  }
  if (parsedCount !== entryLines.length) {
    console.error(`ERROR: ${label} THEME_COLORS has ${entryLines.length} entry lines but only ${parsedCount} parsed; regex likely out of sync with source format.`);
    process.exit(1);
  }
  return parsed;
}

// --- Load the canonical source of truth ---
const tsSource = readFileSync(join(root, 'src/app/core/services/theme-colors.ts'), 'utf8');

// Parse THEME_COLORS object entries from the TS source
const tsColorsMatch = tsSource.match(/export const THEME_COLORS\s*=\s*\{([^}]+)\}/s);
if (!tsColorsMatch) {
  console.error('ERROR: Could not parse THEME_COLORS from theme-colors.ts');
  process.exit(1);
}
const tsColors = parseColorBlock(tsColorsMatch[1], 'theme-colors.ts');

// Parse DEFAULT_THEME from the TS source
const tsDefaultMatch = tsSource.match(/export const DEFAULT_THEME[^=]*=\s*'(\w+)'/);
if (!tsDefaultMatch) {
  console.error('ERROR: Could not parse DEFAULT_THEME from theme-colors.ts');
  process.exit(1);
}
const tsDefault = tsDefaultMatch[1];

// --- Load the inline script in index.html ---
const html = readFileSync(join(root, 'src/index.html'), 'utf8');

const htmlColorsMatch = html.match(/var THEME_COLORS\s*=\s*\{([^}]+)\}/s);
if (!htmlColorsMatch) {
  console.error('ERROR: Could not parse var THEME_COLORS from index.html');
  process.exit(1);
}
const htmlColors = parseColorBlock(htmlColorsMatch[1], 'index.html');

const htmlDefaultMatch = html.match(/var DEFAULT_THEME\s*=\s*'(\w+)'/);
if (!htmlDefaultMatch) {
  console.error('ERROR: Could not parse var DEFAULT_THEME from index.html');
  process.exit(1);
}
const htmlDefault = htmlDefaultMatch[1];

// Parse the static <meta name="theme-color" content="..."> tag — the color
// Safari samples on first paint before the inline script runs.
const metaMatch = html.match(/<meta\s+name=["']theme-color["']\s+content=["'](#[0-9a-fA-F]{3,8})["']/);
if (!metaMatch) {
  console.error('ERROR: Could not find <meta name="theme-color" content="..."> tag in index.html');
  process.exit(1);
}
const metaColor = metaMatch[1];

// --- Compare ---
let failed = false;

const tsKeys = Object.keys(tsColors).sort();
const htmlKeys = Object.keys(htmlColors).sort();
if (JSON.stringify(tsKeys) !== JSON.stringify(htmlKeys)) {
  console.error(`DRIFT: key sets differ.\n  theme-colors.ts: ${tsKeys.join(', ')}\n  index.html:      ${htmlKeys.join(', ')}`);
  failed = true;
}

for (const key of tsKeys) {
  if (tsColors[key] !== htmlColors[key]) {
    console.error(`DRIFT: ${key}: theme-colors.ts='${tsColors[key]}' vs index.html='${htmlColors[key]}'`);
    failed = true;
  }
}

if (tsDefault !== htmlDefault) {
  console.error(`DRIFT: DEFAULT_THEME: theme-colors.ts='${tsDefault}' vs index.html='${htmlDefault}'`);
  failed = true;
}

// The static <meta> tag Safari samples on first paint MUST equal the color
// that THEME_COLORS[DEFAULT_THEME] resolves to — otherwise the default theme
// flashes the wrong color before the inline script can update it.
const expectedMetaColor = tsColors[tsDefault];
if (expectedMetaColor && metaColor.toLowerCase() !== expectedMetaColor.toLowerCase()) {
  console.error(`DRIFT: <meta name="theme-color"> content='${metaColor}' but THEME_COLORS[DEFAULT_THEME='${tsDefault}']='${expectedMetaColor}'`);
  failed = true;
}

if (failed) {
  console.error('\nFix: update index.html inline script and <meta name="theme-color"> tag to match theme-colors.ts (the single source of truth).');
  process.exit(1);
}

console.log('theme-colors check passed: index.html and theme-colors.ts are in sync.');
