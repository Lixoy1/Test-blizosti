'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const data = require('../public/questions.json');

assert.equal(data.questions.length, 125, 'Questionnaire must contain exactly 125 questions');
assert.equal(data.blocks.length, 8, 'Questionnaire must contain eight blocks');
assert.equal(new Set(data.questions.map((q) => q.id)).size, 125, 'Question IDs must be unique');
assert.deepEqual(data.questions.map((q) => q.id), Array.from({ length: 125 }, (_, i) => i + 1), 'Question IDs must run from 1 to 125');

const expectedBlockCounts = {
  feelings: 10, trust: 10, mutuality: 10, reality: 10,
  future: 10, choice: 10, personality: 50, love: 15,
};
for (const [blockId, count] of Object.entries(expectedBlockCounts)) {
  assert.equal(data.questions.filter((q) => q.block === blockId).length, count, `Block ${blockId} must contain ${count} questions`);
}

for (const scaleId of ['default', 'ipip', 'tls']) {
  const scale = data.scales?.[scaleId];
  assert.ok(Array.isArray(scale) && scale.length === 5, `Scale ${scaleId} must contain five response anchors`);
  assert.deepEqual(scale.map((item) => item.value), [1, 2, 3, 4, 5], `Scale ${scaleId} must use values 1–5`);
}

const dimensionIds = new Set(data.dimensions.map((d) => d.id));
for (const q of data.questions) {
  assert.ok(data.blocks.some((block) => block.id === q.block), `Question ${q.id} must belong to a known block`);
  assert.ok(['scale', 'text', 'single'].includes(q.type), `Question ${q.id} has an unsupported answer type`);
  if (q.type === 'text') {
    assert.ok(Number.isInteger(q.minLength) && q.minLength >= 12 && q.minLength <= 3000, `Question ${q.id} must require a valid substantive answer`);
  }
  if (q.type === 'scale') {
    assert.ok(['default', 'ipip', 'tls'].includes(q.scaleType || 'default'), `Question ${q.id} uses an unknown scale`);
    assert.ok(q.score && dimensionIds.has(q.score.dimension), `Scored question ${q.id} must reference a known dimension`);
  }
  if (q.type === 'single') {
    assert.ok(Array.isArray(q.options) && q.options.length >= 2, `Question ${q.id} needs answer options`);
    assert.equal(new Set(q.options.map((o) => o.value)).size, q.options.length, `Question ${q.id} has duplicate option values`);
    if (q.score?.fromOption) assert.ok(q.options.every((option) => Number.isFinite(option.score)), `Question ${q.id} is missing option scores`);
  }
}
for (const dimension of data.dimensions) {
  assert.ok(data.questions.some((q) => q.score?.dimension === dimension.id), `Dimension ${dimension.id} has no scored questions`);
}
for (const trait of ['extraversion','agreeableness','conscientiousness','stability','openness']) {
  assert.equal(data.questions.filter((q) => q.score?.dimension === `personality_${trait}`).length, 10, `Big Five trait ${trait} must have 10 items`);
}
for (const component of ['intimacy','passion','commitment']) {
  assert.equal(data.questions.filter((q) => q.score?.dimension === `love_${component}`).length, 5, `TLS-15 component ${component} must have 5 items`);
}
const optimistPath = path.join(__dirname, '..', 'public', 'assets', 'optimist.webp');
const optimistBuffer = fs.readFileSync(optimistPath);
assert.ok(optimistBuffer.length > 1000, 'Optimist artwork must not be empty');
assert.equal(optimistBuffer.toString('ascii', 0, 4), 'RIFF', 'Optimist artwork must be WebP');
assert.equal(optimistBuffer.toString('ascii', 8, 12), 'WEBP', 'Optimist artwork must be WebP');

const poisonPath = path.join(__dirname, '..', 'public', 'assets', 'poison.svg');
const poisonSvg = fs.readFileSync(poisonPath, 'utf8');
assert.ok(poisonSvg.length > 1000, 'Poison SVG artwork must not be empty');
assert.ok(poisonSvg.trimStart().startsWith('<svg'), 'Poison artwork must be an SVG');
assert.match(poisonSvg, /POISON/, 'Poison artwork must include its visual mark');
assert.ok(data.scoringNotes?.personality && data.scoringNotes?.love && data.scoringNotes?.compatibility, 'Scoring limitations must be documented');
console.log('Questionnaire check passed: 125 mandatory items, 8 blocks, Big Five 50, TLS-15 15, 15 dimensions, Optimist WebP and Poison SVG assets.');
