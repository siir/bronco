#!/usr/bin/env node
/**
 * Drift-check: asserts that the inline THEME_COLORS map in src/index.html
 * matches the canonical map exported from theme-colors.ts.
 *
 * Runs as a prebuild step so CI fails immediately on divergence rather than
 * silently shipping mismatched pre-boot colors.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// --- Load the canonical source of truth ---
const tsSource = readFileSync(join(root, 'src/app/core/services/theme-colors.ts'), 'utf8');

// Parse THEME_COLORS object entries from the TS source
const tsColorsMatch = tsSource.match(/export const THEME_COLORS\s*=\s*\{([^}]+)\}/s);
if (!tsColorsMatch) {
  console.error('ERROR: Could not parse THEME_COLORS from theme-colors.ts');
  process.exit(1);
}
const tsColors = {};
for (const line of tsColorsMatch[1].split('\n')) {
  const m = line.match(/^\s*(\w+):\s*'(#[0-9a-fA-F]{3,8})'/);
  if (m) tsColors[m[1]] = m[2];
}

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
const htmlColors = {};
for (const line of htmlColorsMatch[1].split('\n')) {
  const m = line.match(/^\s*(\w+):\s*'(#[0-9a-fA-F]{3,8})'/);
  if (m) htmlColors[m[1]] = m[2];
}

const htmlDefaultMatch = html.match(/var DEFAULT_THEME\s*=\s*'(\w+)'/);
if (!htmlDefaultMatch) {
  console.error('ERROR: Could not parse var DEFAULT_THEME from index.html');
  process.exit(1);
}
const htmlDefault = htmlDefaultMatch[1];

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

if (failed) {
  console.error('\nFix: update index.html inline script to match theme-colors.ts (the single source of truth).');
  process.exit(1);
}

console.log('theme-colors check passed: index.html and theme-colors.ts are in sync.');
