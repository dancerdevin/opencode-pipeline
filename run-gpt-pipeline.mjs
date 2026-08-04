#!/usr/bin/env node
// GPT-only entry point. It pins plan/execute/review to Terra/Luna/Sol through
// the bundled fixed configuration, then delegates every pipeline operation to
// the shared orchestrator.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GPT_CONFIG_PATH } from './config.mjs';
import { runPipelineFromCli } from './run-pipeline.mjs';

async function runGptPipelineFromCli(
  args = process.argv.slice(2),
  dependencies = {}
) {
  return runPipelineFromCli({
    configPath: GPT_CONFIG_PATH,
    command: 'opencode-gpt-pipeline',
    args,
    ...dependencies,
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  runGptPipelineFromCli()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error(`Pipeline failed: ${error.message}`);
      process.exit(1);
    });
}

export { runGptPipelineFromCli };
