import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseReviewResult, permissionReplyCommand } from '../run-pipeline.mjs';
import { loadConfig, resolveTierModel } from '../resolve-model.mjs';

test('parseReviewResult: clean PASS', () => {
  const { verdict, reason } = parseReviewResult('Looks good.\nREVIEW_RESULT: PASS');
  assert.equal(verdict, 'PASS');
  assert.equal(reason, null);
});

test('parseReviewResult: FAIL carries the reason', () => {
  const { verdict, reason } = parseReviewResult('REVIEW_RESULT: FAIL: tests were not run');
  assert.equal(verdict, 'FAIL');
  assert.equal(reason, 'tests were not run');
});

test('parseReviewResult: FAIL without a reason gets a placeholder', () => {
  const { verdict, reason } = parseReviewResult('REVIEW_RESULT: FAIL');
  assert.equal(verdict, 'FAIL');
  assert.ok(reason.length > 0);
});

test('parseReviewResult: missing sentinel is a FAIL', () => {
  const { verdict, reason } = parseReviewResult('The work seems fine, ship it.');
  assert.equal(verdict, 'FAIL');
  assert.match(reason, /did not emit/i);
});

test('parseReviewResult: last sentinel wins (PASS after FAIL)', () => {
  const { verdict } = parseReviewResult('REVIEW_RESULT: FAIL: first\n...\nREVIEW_RESULT: PASS');
  assert.equal(verdict, 'PASS');
});

test('parseReviewResult: last sentinel wins (FAIL after PASS)', () => {
  const { verdict, reason } = parseReviewResult('REVIEW_RESULT: PASS\nREVIEW_RESULT: FAIL: broke it');
  assert.equal(verdict, 'FAIL');
  assert.equal(reason, 'broke it');
});

test('resolveTierModel: picks cheapest blended price, weighting completion 4x', () => {
  // a/z has the cheaper prompt price but loses on the blended score.
  const tiers = { cheap: ['a/x', 'a/z'] };
  const pricing = new Map([
    ['a/x', { prompt: 1, completion: 1 }], // blended 5
    ['a/z', { prompt: 0.1, completion: 2 }], // blended 8.1
  ]);
  const winner = resolveTierModel('cheap', tiers, pricing);
  assert.equal(winner.model, 'openrouter/a/x');
});

test('resolveTierModel: skips models missing from live pricing', () => {
  const tiers = { cheap: ['a/gone', 'a/here'] };
  const pricing = new Map([['a/here', { prompt: 1, completion: 1 }]]);
  const winner = resolveTierModel('cheap', tiers, pricing);
  assert.equal(winner.model, 'openrouter/a/here');
});

test('resolveTierModel: unknown tier throws', () => {
  assert.throws(() => resolveTierModel('nope', { cheap: ['a/x'] }, new Map()), /No models configured for tier/);
});

test('resolveTierModel: throws when nothing in the tier is currently priced', () => {
  assert.throws(() => resolveTierModel('cheap', { cheap: ['a/gone'] }, new Map()), /not currently listed|No models in tier/);
});

test('permissionReplyCommand: includes directory-scoped URL, request id, and reply', () => {
  const cmd = permissionReplyCommand('http://127.0.0.1:4747', '/tmp/my dir', 'req123', 'once');
  assert.match(cmd, /permission\/req123\/reply/);
  assert.match(cmd, /directory=%2Ftmp%2Fmy%20dir/);
  assert.match(cmd, /"reply":"once"/);
});

test('loadConfig: defaults stageTiers and maxRetries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'pipeline.config.json');
    await writeFile(p, JSON.stringify({ tiers: { cheap: ['a/x'] } }));
    const config = await loadConfig(p);
    assert.deepEqual(config.tiers, { cheap: ['a/x'] });
    assert.deepEqual(config.stageTiers, { plan: 'smart', execute: 'cheap', review: 'very-smart' });
    assert.equal(config.maxRetries, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: explicit stageTiers and maxRetries win', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'pipeline.config.json');
    await writeFile(
      p,
      JSON.stringify({ tiers: { cheap: ['a/x'] }, stageTiers: { plan: 'cheap' }, maxRetries: 5 })
    );
    const config = await loadConfig(p);
    assert.equal(config.stageTiers.plan, 'cheap');
    assert.equal(config.stageTiers.execute, 'cheap'); // default fills the rest
    assert.equal(config.maxRetries, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: missing tiers is an error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-config-'));
  try {
    const p = path.join(dir, 'pipeline.config.json');
    await writeFile(p, JSON.stringify({ maxRetries: 1 }));
    await assert.rejects(() => loadConfig(p), /"tiers"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: missing file is an error', async () => {
  await assert.rejects(() => loadConfig('/nonexistent/pipeline.config.json'), /Could not read/);
});
