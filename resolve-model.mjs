#!/usr/bin/env node
// Picks the cheapest model in a caller-maintained tier from pipeline.config.json,
// ranked against OpenRouter's live per-token pricing (not hardcoded prices).
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'pipeline.config.json');
const PRICING_URL = 'https://openrouter.ai/api/v1/models';

// Weighted toward completion price: agentic coding calls are output-heavy.
const PROMPT_WEIGHT = 1;
const COMPLETION_WEIGHT = 4;

const DEFAULT_STAGE_TIERS = { plan: 'smart', execute: 'cheap', review: 'very-smart' };
const DEFAULT_MAX_RETRIES = 2;

// Loads pipeline.config.json (path overridable via PIPELINE_CONFIG, mainly for
// tests). `tiers` is required; `stageTiers` and `maxRetries` fall back to
// sensible defaults so a minimal config — just tiers — still works.
export async function loadConfig(configPath = process.env.PIPELINE_CONFIG || DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new Error(`Could not read pipeline config at ${configPath}`);
  }
  const config = JSON.parse(raw);
  if (!config.tiers || typeof config.tiers !== 'object' || Object.keys(config.tiers).length === 0) {
    throw new Error(`Pipeline config at ${configPath} must define a non-empty "tiers" object`);
  }
  return {
    tiers: config.tiers,
    stageTiers: { ...DEFAULT_STAGE_TIERS, ...(config.stageTiers || {}) },
    maxRetries: Number.isInteger(config.maxRetries) ? config.maxRetries : DEFAULT_MAX_RETRIES,
  };
}

export async function fetchPricing() {
  const res = await fetch(PRICING_URL);
  if (!res.ok) {
    throw new Error(`OpenRouter pricing fetch failed: ${res.status} ${res.statusText}`);
  }
  const { data } = await res.json();
  const map = new Map();
  for (const m of data) {
    const prompt = Number(m.pricing?.prompt);
    const completion = Number(m.pricing?.completion);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      map.set(m.id, { prompt, completion });
    }
  }
  return map;
}

export function resolveTierModel(tier, tiers, pricingMap) {
  const ids = tiers[tier];
  if (!ids || ids.length === 0) {
    throw new Error(`No models configured for tier "${tier}" in pipeline config`);
  }

  const candidates = [];
  for (const id of ids) {
    const price = pricingMap.get(id);
    if (!price) {
      console.warn(`[resolve-model] "${id}" (tier "${tier}") not found in live OpenRouter pricing — skipping`);
      continue;
    }
    const blended = price.prompt * PROMPT_WEIGHT + price.completion * COMPLETION_WEIGHT;
    candidates.push({ id, price, blended });
  }

  if (candidates.length === 0) {
    throw new Error(`No models in tier "${tier}" are currently listed by OpenRouter (checked: ${ids.join(', ')})`);
  }

  candidates.sort((a, b) => a.blended - b.blended);
  const winner = candidates[0];
  return {
    model: `openrouter/${winner.id}`,
    id: winner.id,
    price: winner.price,
    blended: winner.blended,
  };
}

// Entry-point check that survives bin symlinks and paths with spaces.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const tier = process.argv[2];
  if (!tier) {
    console.error('Usage: node resolve-model.mjs <tier-name>  (tiers are defined in pipeline.config.json)');
    process.exit(1);
  }
  const { tiers } = await loadConfig();
  const pricingMap = await fetchPricing();
  const result = resolveTierModel(tier, tiers, pricingMap);
  console.log(
    `${result.model}  (prompt $${result.price.prompt}/tok, completion $${result.price.completion}/tok, blended score ${result.blended.toExponential(3)})`
  );
}
