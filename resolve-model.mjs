#!/usr/bin/env node
// Picks the cheapest model in a caller-maintained tier from pipeline.config.json,
// ranked against OpenRouter's live per-token pricing and optional effort support.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
const PRICING_URL = 'https://openrouter.ai/api/v1/models';

// Weighted toward completion price: agentic coding calls are output-heavy.
const PROMPT_WEIGHT = 1;
const COMPLETION_WEIGHT = 4;

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
      map.set(m.id, {
        prompt,
        completion,
        supportedParameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
        ...(m.reasoning && typeof m.reasoning === 'object' ? { reasoning: m.reasoning } : {}),
      });
    }
  }
  return map;
}

function supportsReasoningEffort(model, effort) {
  if (!effort) return true;
  const supportedEfforts = model.reasoning?.supported_efforts;
  if (Array.isArray(supportedEfforts)) return supportedEfforts.includes(effort);
  // OpenRouter uses null to mean that all gateway effort values are accepted.
  return supportedEfforts === null;
}

export function resolveTierModel(tier, tiers, pricingMap, { requiredVariant } = {}) {
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
    if (!supportsReasoningEffort(price, requiredVariant)) {
      console.warn(
        `[resolve-model] "${id}" (tier "${tier}") does not advertise reasoning effort "${requiredVariant}" — skipping`
      );
      continue;
    }
    const blended = price.prompt * PROMPT_WEIGHT + price.completion * COMPLETION_WEIGHT;
    candidates.push({ id, price, blended });
  }

  if (candidates.length === 0) {
    const effortDetail = requiredVariant ? ` supporting reasoning effort "${requiredVariant}"` : '';
    throw new Error(
      `No models in tier "${tier}" are currently listed by OpenRouter${effortDetail} (checked: ${ids.join(', ')})`
    );
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
  const variant = process.argv[3];
  if (!tier) {
    console.error('Usage: node resolve-model.mjs <tier-name> [variant]  (tiers are defined in pipeline.config.json)');
    process.exit(1);
  }
  const { tiers } = await loadConfig();
  if (!tiers) {
    throw new Error('resolve-model.mjs only supports tiered OpenRouter configurations');
  }
  const pricingMap = await fetchPricing();
  const result = resolveTierModel(tier, tiers, pricingMap, { requiredVariant: variant });
  const effort = variant ? `, effort=${variant}` : '';
  console.log(
    `${result.model}${effort}  (prompt $${result.price.prompt}/tok, completion $${result.price.completion}/tok, blended score ${result.blended.toExponential(3)})`
  );
}

export { loadConfig } from './config.mjs';
