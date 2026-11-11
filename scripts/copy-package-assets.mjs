#!/usr/bin/env node

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const [, , packagePathArg, sourceDirArg, outputDirArg, extensionArg] = process.argv;

if ([packagePathArg, sourceDirArg, outputDirArg, extensionArg].some((arg) => arg === undefined)) {
  console.error('Usage: node scripts/copy-package-assets.mjs <package> <source-dir> <output-dir> <extension>');
  process.exit(1);
}

if (!extensionArg.startsWith('.')) {
  console.error('Asset extension must start with a dot, for example .md');
  process.exit(1);
}

const packageRoot = resolve(packagePathArg);
const sourceDir = resolve(packageRoot, sourceDirArg);
const outputDir = resolve(packageRoot, outputDirArg);

for (const path of [sourceDir, outputDir]) {
  const relativePath = relative(packageRoot, path);
  if (relativePath.startsWith('..') || relativePath === '') {
    console.error(`Asset path must be inside package root: ${path}`);
    process.exit(1);
  }
}

let sourceStat;
try {
  sourceStat = statSync(sourceDir);
} catch {
  console.error(`Asset source directory does not exist: ${sourceDir}`);
  process.exit(1);
}

if (!sourceStat.isDirectory()) {
  console.error(`Asset source path is not a directory: ${sourceDir}`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

let copied = 0;
for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(extensionArg)) continue;
  copyFileSync(join(sourceDir, entry.name), join(outputDir, entry.name));
  copied += 1;
}

if (copied === 0) {
  console.error(`No ${extensionArg} assets found in ${sourceDir}`);
  process.exit(1);
}

console.log(`Copied ${copied} ${extensionArg} asset(s) from ${sourceDirArg} to ${outputDirArg}`);
