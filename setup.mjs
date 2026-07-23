#!/usr/bin/env node
// Installs (or, with --uninstall, removes) the three pipeline agents —
// pipeline-plan, pipeline-execute, pipeline-review — as global OpenCode
// markdown agents under ~/.config/opencode/agents/ (or
// $XDG_CONFIG_HOME/opencode/agents/). Each agent's prompt body comes from this
// repo's prompts/ directory, so there is exactly one source of truth.
//
// Files written by this script carry a marker comment; install never clobbers
// an unrelated same-named file (it backs it up first) and uninstall only
// removes files that carry the marker.
import { readFile, writeFile, mkdir, copyFile, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MARKER = '<!-- managed by opencode-pipeline setup.mjs -->';

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const AGENTS_DIR = path.join(CONFIG_HOME, 'opencode', 'agents');

// Read-only inspection commands the execute stage may run without asking;
// anything that writes, builds, tests, or touches git state still falls through
// to "ask". (Last matching rule wins, so the broad "ask" stays first.)
const EXECUTE_BASH_ALLOW = [
  'cat*', 'head*', 'tail*', 'ls*', 'pwd', 'cd*', 'wc*', 'file*',
  'grep*', 'rg*', 'sed -n*', 'jq*',
  'git status*', 'git diff*', 'git log*', 'git show*',
];

const READ_ONLY_PERMISSION = ['  read: allow', '  edit: deny', '  bash: deny'].join('\n');
const EXECUTE_PERMISSION = [
  '  read: allow',
  '  edit: allow',
  '  bash:',
  '    "*": ask',
  ...EXECUTE_BASH_ALLOW.map((pattern) => `    "${pattern}": allow`),
].join('\n');

const AGENTS = [
  {
    name: 'pipeline-plan',
    promptFile: 'plan.txt',
    description:
      'Plan stage of opencode-pipeline: read-only repo inspection, outputs an ordered implementation plan.',
    permission: READ_ONLY_PERMISSION,
  },
  {
    name: 'pipeline-execute',
    promptFile: 'execute.txt',
    description:
      'Execute stage of opencode-pipeline: carries out the plan; edits allowed, bash commands require approval.',
    permission: EXECUTE_PERMISSION,
  },
  {
    name: 'pipeline-review',
    promptFile: 'review.txt',
    description:
      'Review stage of opencode-pipeline: read-only verification, emits the REVIEW_RESULT sentinel.',
    permission: READ_ONLY_PERMISSION,
  },
];

function agentFileContent({ description, permission }, promptBody) {
  return `---
description: ${description}
mode: primary
permission:
${permission}
---

${promptBody.trim()}

${MARKER}
`;
}

async function warnOnInlineAgents() {
  for (const file of ['opencode.json', 'opencode.jsonc']) {
    const p = path.join(CONFIG_HOME, 'opencode', file);
    if (!existsSync(p)) continue;
    const content = await readFile(p, 'utf8');
    if (content.includes('pipeline-')) {
      console.warn(
        `note: ${p} mentions "pipeline-" agents — inline agent definitions there ` +
          `are merged with (and can shadow) the markdown agents this script installs. ` +
          `Consider removing the inline pipeline-* block to avoid confusion.`
      );
    }
  }
}

async function install() {
  await mkdir(AGENTS_DIR, { recursive: true });
  for (const agent of AGENTS) {
    const promptBody = await readFile(path.join(__dirname, 'prompts', agent.promptFile), 'utf8');
    const content = agentFileContent(agent, promptBody);
    const target = path.join(AGENTS_DIR, `${agent.name}.md`);
    if (existsSync(target)) {
      const existing = await readFile(target, 'utf8');
      if (!existing.includes(MARKER)) {
        const backup = `${target}.bak`;
        await copyFile(target, backup);
        console.log(`existing ${target} is not managed by this script — backed up to ${backup}`);
      }
    }
    await writeFile(target, content);
    console.log(`installed ${target}`);
  }
  await warnOnInlineAgents();
  console.log(
    '\nDone. OpenCode loads agents at startup: restart any running `opencode serve`\n' +
      '(and TUI) for the pipeline agents to appear.'
  );
}

async function uninstall() {
  for (const agent of AGENTS) {
    const target = path.join(AGENTS_DIR, `${agent.name}.md`);
    if (!existsSync(target)) {
      console.log(`not present, skipping ${target}`);
      continue;
    }
    const existing = await readFile(target, 'utf8');
    if (!existing.includes(MARKER)) {
      console.log(`not managed by this script, leaving untouched: ${target}`);
      continue;
    }
    await unlink(target);
    console.log(`removed ${target}`);
    const backup = `${target}.bak`;
    if (existsSync(backup)) {
      await rename(backup, target);
      console.log(`restored pre-existing file from backup: ${target}`);
    }
  }
  console.log('\nDone. Restart any running `opencode serve` (and TUI) for the change to take effect.');
}

const arg = process.argv[2];
if (arg === '--uninstall') {
  await uninstall();
} else if (arg === '--help' || arg === '-h') {
  console.log('Usage: node setup.mjs [--uninstall]');
  console.log('Installs the pipeline-* agents into', AGENTS_DIR);
} else {
  await install();
}
