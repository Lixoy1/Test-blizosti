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
const intimacy = require('../public/intimacy-questions.json');
assert.equal(intimacy.questions.length, 90, 'Intimacy questionnaire must contain exactly 90 questions');
assert.equal(intimacy.blocks.length, 10, 'Intimacy questionnaire must contain ten blocks');
assert.equal(new Set(intimacy.questions.map((q) => q.id)).size, 90, 'Intimacy question IDs must be unique');
assert.deepEqual(intimacy.questions.map((q) => q.id), Array.from({ length: 90 }, (_, i) => i + 1), 'Intimacy IDs must run from 1 to 90');
const intimacyCounts = { desire:10, oral:10, penetrative:10, anal:8, roles:10, fantasies:10, distance:8, pleasure:10, boundaries:10, personal:4 };
for (const [blockId, count] of Object.entries(intimacyCounts)) {
  assert.ok(intimacy.blocks.some((block) => block.id === blockId), `Missing intimacy block ${blockId}`);
  assert.equal(intimacy.questions.filter((q) => q.block === blockId).length, count, `Intimacy block ${blockId} must contain ${count} items`);
}
for (const q of intimacy.questions) {
  assert.ok(q.text && typeof q.text.A === 'string' && q.text.A.length > 0, `Intimacy question ${q.id} needs an A prompt`);
  assert.ok(q.text && typeof q.text.B === 'string' && q.text.B.length > 0, `Intimacy question ${q.id} needs a B prompt`);
  assert.ok(q.optional === true && q.privateAllowed === true, `Intimacy question ${q.id} must allow skip and private visibility`);
  assert.ok(['scale','single','multi','text','practice'].includes(q.type), `Unsupported intimacy question type: ${q.type}`);
  if (q.type === 'single' || q.type === 'multi') {
    assert.ok(Array.isArray(q.options) && q.options.length >= 2, `Intimacy question ${q.id} needs options`);
    assert.equal(new Set(q.options.map((o) => o.value)).size, q.options.length, `Duplicate choices in intimacy question ${q.id}`);
  }
  if (q.type === 'text') assert.ok(Number.isInteger(q.minLength) && q.minLength >= 5 && q.minLength <= 3000, `Intimacy text question ${q.id} has invalid minLength`);
  if (q.type === 'practice') {
    for (const field of ['experience','desire','comfort']) assert.ok(intimacy.practiceFields[field]?.length >= 2, `Practice field ${field} is missing options`);
  }
}
console.log('Questionnaire checks passed: relationship 125 questions + intimacy 90 questions, 18 blocks combined.');
