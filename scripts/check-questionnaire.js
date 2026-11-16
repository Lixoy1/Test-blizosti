'use strict';
const assert = require('node:assert/strict');
const data = require('../public/questions.json');

assert.equal(data.questions.length, 60, 'Questionnaire must contain exactly 60 questions');
assert.equal(data.blocks.length, 6, 'Questionnaire must contain six blocks');
assert.equal(new Set(data.questions.map((q) => q.id)).size, 60, 'Question IDs must be unique');
assert.deepEqual(data.questions.map((q) => q.id), Array.from({ length: 60 }, (_, i) => i + 1), 'Question IDs must run from 1 to 60');

const dimensionIds = new Set(data.dimensions.map((d) => d.id));
for (const q of data.questions) {
  assert.ok(data.blocks.some((block) => block.id === q.block), `Question ${q.id} must belong to a known block`);
  assert.ok(['scale', 'text', 'single'].includes(q.type), `Question ${q.id} has an unsupported answer type`);
  if (q.type === 'text') assert.ok(Number.isInteger(q.minLength) && q.minLength >= 12, `Question ${q.id} must require a substantive text answer`);
  if (q.type === 'single') {
    assert.ok(Array.isArray(q.options) && q.options.length >= 2, `Question ${q.id} needs answer options`);
    assert.equal(new Set(q.options.map((o) => o.value)).size, q.options.length, `Question ${q.id} has duplicate option values`);
  }
  if (q.score && dimensionIds.has(q.score.dimension)) assert.ok(q.score.dimension, `Question ${q.id} has an invalid score dimension`);
}
for (const dimension of data.dimensions) {
  assert.ok(data.questions.some((q) => q.score?.dimension === dimension.id), `Dimension ${dimension.id} has no scored questions`);
}
console.log('Questionnaire check passed: 60 unique mandatory questions, 6 blocks, 6 scored dimensions.');
