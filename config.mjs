// Loads and validates both supported pipeline configuration strategies. The
// legacy tiered schema remains the default when modelStrategy is omitted;
// fixed-model configs opt in explicitly so they can never accidentally mix
// OpenRouter pricing with subscription-backed routing.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CONFIG_PATH = path.join(__dirname, 'pipeline.config.json');
export const GPT_CONFIG_PATH = path.join(__dirname, 'gpt-pipeline.config.json');
export const PIPELINE_STAGES = ['plan', 'execute', 'review'];

const DEFAULT_STAGE_TIERS = { plan: 'smart', execute: 'cheap', review: 'very-smart' };
const DEFAULT_MAX_RETRIES = 2;

function configError(configPath, message) {
  return new Error(`Pipeline config at ${configPath} ${message}`);
}

function loadMaxRetries(value, configPath) {
  if (value === undefined) return DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(value) || value < 0) {
    throw configError(configPath, 'must define "maxRetries" as a non-negative integer');
  }
  return value;
}

function requireStageMap(value, field, configPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(configPath, `must define a "${field}" object`);
  }
  for (const stage of PIPELINE_STAGES) {
    if (typeof value[stage] !== 'string' || value[stage].trim() === '') {
      throw configError(configPath, `must define a non-empty "${field}.${stage}" string`);
    }
  }
  return Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, value[stage]]));
}

function loadOptionalStageVariants(value, configPath) {
  if (value === undefined) return {};
  return requireStageMap(value, 'stageVariants', configPath);
}

function loadTieredConfig(config, configPath) {
  if (config.stageModels !== undefined) {
    throw configError(configPath, 'cannot mix "stageModels" with the tiered model strategy');
  }
  if (config.billingMode !== undefined && config.billingMode !== 'openrouter') {
    throw configError(configPath, 'must use billingMode "openrouter" with the tiered model strategy');
  }
  if (!config.tiers || typeof config.tiers !== 'object' || Array.isArray(config.tiers) || Object.keys(config.tiers).length === 0) {
    throw configError(configPath, 'must define a non-empty "tiers" object');
  }
  for (const [tier, models] of Object.entries(config.tiers)) {
    if (!Array.isArray(models) || models.length === 0 || models.some((model) => typeof model !== 'string' || !model)) {
      throw configError(configPath, `must define "tiers.${tier}" as a non-empty array of model IDs`);
    }
  }
  if (
    config.stageTiers !== undefined &&
    (!config.stageTiers || typeof config.stageTiers !== 'object' || Array.isArray(config.stageTiers))
  ) {
    throw configError(configPath, 'must define "stageTiers" as an object');
  }

  const stageTiers = { ...DEFAULT_STAGE_TIERS, ...(config.stageTiers || {}) };
  requireStageMap(stageTiers, 'stageTiers', configPath);
  const stageVariants = loadOptionalStageVariants(config.stageVariants, configPath);
  return {
    modelStrategy: 'tiered',
    billingMode: 'openrouter',
    tiers: config.tiers,
    stageTiers,
    stageVariants,
    maxRetries: loadMaxRetries(config.maxRetries, configPath),
  };
}

function loadFixedConfig(config, configPath) {
  if (config.tiers !== undefined || config.stageTiers !== undefined) {
    throw configError(configPath, 'cannot mix "tiers" or "stageTiers" with the fixed model strategy');
  }
  if (config.billingMode !== 'chatgpt-subscription') {
    throw configError(configPath, 'must use billingMode "chatgpt-subscription" with the fixed model strategy');
  }
  const stageModels = requireStageMap(config.stageModels, 'stageModels', configPath);
  const stageVariants = loadOptionalStageVariants(config.stageVariants, configPath);
  for (const [stage, model] of Object.entries(stageModels)) {
    if (!/^[^/\s]+\/\S+$/.test(model)) {
      throw configError(configPath, `must define "stageModels.${stage}" as a provider/model ID`);
    }
  }
  return {
    modelStrategy: 'fixed',
    billingMode: 'chatgpt-subscription',
    stageModels,
    stageVariants,
    maxRetries: loadMaxRetries(config.maxRetries, configPath),
  };
}

export async function loadConfig(configPath = process.env.PIPELINE_CONFIG || DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new Error(`Could not read pipeline config at ${configPath}`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw configError(configPath, `is not valid JSON: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw configError(configPath, 'must contain a JSON object');
  }

  const strategy = config.modelStrategy || 'tiered';
  if (strategy === 'tiered') return loadTieredConfig(config, configPath);
  if (strategy === 'fixed') return loadFixedConfig(config, configPath);
  throw configError(configPath, `has unsupported modelStrategy "${strategy}"`);
}
