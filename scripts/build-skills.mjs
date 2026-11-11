#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readSkillCatalogs } from './lib/skill-assets.mjs';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseFrontmatter(text, sourcePath) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`Skill is missing YAML frontmatter: ${sourcePath}`);

  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (field) fields.set(field[1], field[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !SKILL_NAME.test(name)) throw new Error(`Skill has an invalid frontmatter name: ${sourcePath}`);
  if (!description) throw new Error(`Skill is missing a frontmatter description: ${sourcePath}`);
  return { name };
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Build the public asset-only skills tree from repository source catalogs.
 *
 * @param {{workspaceRoot: string, outputDir: string}} options workspace and generated dist or repository-local scratch output
 * @returns {Promise<void>}
 */
export async function buildSkills({ workspaceRoot, outputDir }) {
  const root = path.resolve(workspaceRoot);
  const output = path.resolve(outputDir);
  const relativeOutput = path.relative(root, output);
  if (relativeOutput === '' || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error(`Skills output must be a dedicated directory inside the workspace: ${output}`);
  }
  if (
    !pathsOverlap(path.join(root, 'packages/ccd-skills/dist'), output) &&
    !relativeOutput.split(path.sep).includes('.test-tmp')
  ) {
    throw new Error('Skills output must be inside packages/ccd-skills/dist or repository-local .test-tmp scratch.');
  }
  const catalogs = await readSkillCatalogs(root);

  for (const { directory } of catalogs) {
    if (pathsOverlap(directory, output) || pathsOverlap(output, directory)) {
      throw new Error(`Skills output must not overlap source assets: ${output}`);
    }
  }

  const skills = new Map();
  for (const { directory, files } of catalogs) {
    for (const file of files) {
      const sourcePath = path.join(directory, file);
      const text = await readFile(sourcePath, 'utf8');
      const { name } = parseFrontmatter(text, sourcePath);
      if (`${name}.md` !== file) throw new Error(`Skill filename must match its frontmatter name: ${sourcePath}`);

      const existing = skills.get(name);
      if (existing !== undefined && existing !== text) {
        throw new Error(`Conflicting skill definitions use the name ${name}`);
      }
      skills.set(name, text);
    }
  }

  await rm(output, { recursive: true, force: true });
  for (const [name, text] of skills) {
    const skillDirectory = path.join(output, name);
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), text);
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const workspaceRoot = path.resolve(path.dirname(scriptPath), '..');
  const outputDir = path.join(workspaceRoot, 'packages/ccd-skills/dist/skills');
  await buildSkills({ workspaceRoot, outputDir });
}
