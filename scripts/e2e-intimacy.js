'use strict';

const BASE_URL = (process.env.BASE_URL || 'https://mezhdu-nami-bj4n.onrender.com').replace(/\/+$/, '');
const EXPECTED_RELEASE = '2026-11-17-e2e-v2';

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(BASE_URL + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
  const accepted = Array.isArray(expectedStatus) ? expectedStatus.includes(response.status) : response.status === expectedStatus;
  if (!accepted) {
    throw new Error(path + ' returned HTTP ' + response.status + ': ' + JSON.stringify(data).slice(0, 500));
  }
  return { status: response.status, data };
}

function makeAnswer(question, visibility = 'shared') {
  if (question.type === 'scale') return { value: 3, visibility };
  if (question.type === 'single') return { value: question.options[0].value, visibility };
  if (question.type === 'multi') return { value: question.options.slice(0, Math.min(2, question.maxSelections || 2)).map((option) => option.value), visibility };
  if (question.type === 'text') return { value: 'Synthetic E2E response for question ' + question.id, visibility };
  if (question.type === 'practice') return { experience: 'none', desire: 'curious', comfort: 3, visibility };
  throw new Error('Unsupported question type for #' + question.id + ': ' + question.type);
}

function setPractice(answers, id, desire, comfort = 4) {
  answers[String(id)] = { experience: 'none', desire, comfort, visibility: 'shared' };
}

function assert(condition, message) {
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

async function main() {
  let tokens = [];
  let createdRoom = false;
  const checks = [];
  const mark = (label) => { checks.push(label); process.stdout.write('PASS ' + label + '\n'); };

  try {
    const health = await request('/api/health');
    assert(health.data.database === 'connected', 'production database must be connected');
    mark('production API and database health');

    const questionResponse = await request('/intimacy-questions.json?e2e=' + Date.now());
    const questionnaire = questionResponse.data;
    assert(questionnaire.e2eRelease === EXPECTED_RELEASE, 'deployed questionnaire release marker must match this CI run');
    assert(questionnaire.questions.length === 90, 'intimacy module must expose 90 questions');
    assert(questionnaire.blocks.length === 10, 'intimacy module must expose 10 blocks');
    assert(questionnaire.questions.every((q, index) => q.id === index + 1), 'question IDs must be complete and sequential');
    mark('deployed 90-question / 10-block questionnaire');

    const roomResult = await request('/api/rooms', { method: 'POST', body: '{}' }, 201);
    const room = roomResult.data;
    const tokenA = (room.participantUrl || '').split('/p/')[1];
    const tokenB = (room.inviteUrl || '').split('/p/')[1];
    assert(tokenA && tokenB && tokenA.length >= 32 && tokenB.length >= 32 && tokenA !== tokenB, 'temporary room must issue two distinct participant tokens');
    tokens = [tokenA, tokenB];
    createdRoom = true;
    mark('temporary two-participant test room creation');

    const [firstA, firstB, intimacyA, intimacyB] = await Promise.all([
      request('/api/session/' + tokenA),
      request('/api/session/' + tokenB),
      request('/api/intimacy/' + tokenA),
      request('/api/intimacy/' + tokenB),
    ]);
    assert(firstA.data.ownCompleted === false && firstB.data.ownCompleted === false, 'new test room must leave relationship test incomplete');
    assert(intimacyA.data.consented === false && intimacyB.data.consented === false, 'intimacy consent must be independent for both participants');
    mark('new-room isolation and independent intimacy consent');

    await request('/api/intimacy/' + tokenA + '/consent', { method: 'POST', body: JSON.stringify({ consent: true }) });
    await request('/api/intimacy/' + tokenB + '/consent', { method: 'POST', body: JSON.stringify({ consent: true }) });
    const [afterConsentA, afterConsentB] = await Promise.all([
      request('/api/intimacy/' + tokenA),
      request('/api/intimacy/' + tokenB),
    ]);
    assert(afterConsentA.data.consented && afterConsentB.data.consented, 'both independent consent flags must persist');
    mark('separate consent persistence');

    const draftA = { '1': { value: 4, visibility: 'shared' }, '58': { value: 'A private draft test', visibility: 'private' } };
    const draftB = { '1': { value: 2, visibility: 'shared' } };
    await request('/api/intimacy/' + tokenA + '/draft', { method: 'PUT', body: JSON.stringify({ answers: draftA }) });
    const draftIsolation = await request('/api/intimacy/' + tokenB);
    assert(Object.keys(draftIsolation.data.draftAnswers || {}).length === 0, 'partner must not receive another participant draft');
    await request('/api/intimacy/' + tokenB + '/draft', { method: 'PUT', body: JSON.stringify({ answers: draftB }) });
    const [draftReloadA, draftReloadB] = await Promise.all([
      request('/api/intimacy/' + tokenA),
      request('/api/intimacy/' + tokenB),
    ]);
    assert(draftReloadA.data.draftAnswers['58']?.value === 'A private draft test', 'participant A draft must survive reload');
    assert(draftReloadB.data.draftAnswers['1']?.value === 2, 'participant B draft must survive reload');
    assert(!draftReloadB.data.draftAnswers['58'], 'participant B must not see participant A draft content');
    mark('draft autosave, reload recovery, and participant isolation');

    const answersA = Object.fromEntries(questionnaire.questions.map((q) => [String(q.id), makeAnswer(q)]));
    const answersB = Object.fromEntries(questionnaire.questions.map((q) => [String(q.id), makeAnswer(q)]));
    answersA['58'] = { value: 'A shared fantasy answer used only for synthetic testing.', visibility: 'shared' };
    answersB['58'] = { value: 'B private answer must never reach the partner report.', visibility: 'private' };
    answersB['15'] = { value: 'Private oral-preference note must not appear in pair analysis.', visibility: 'private' };
    answersA['90'] = { skipped: true };

    // Role-aware oral pairs: A receives blowjob / B gives it; B receives cunnilingus / A gives it.
    setPractice(answersA, 11, 'want', 5);
    setPractice(answersB, 14, 'want', 4);
    setPractice(answersB, 11, 'conditional', 4);
    setPractice(answersA, 14, 'conditional', 5);
    setPractice(answersA, 17, 'want', 4);
    setPractice(answersB, 17, 'conditional', 3);

    // Role-aware anal pairs: each participant answers for receiving and giving separately.
    setPractice(answersA, 31, 'want', 4);
    setPractice(answersB, 32, 'want', 5);
    setPractice(answersA, 32, 'conditional', 3);
    setPractice(answersB, 31, 'conditional', 4);

    await request('/api/intimacy/' + tokenA + '/submit', { method: 'POST', body: JSON.stringify({ answers: answersA }) }, 201);
    const reportAWhileWaiting = await request('/api/intimacy-report/' + tokenA);
    assert(reportAWhileWaiting.data.partnerCompleted === false && reportAWhileWaiting.data.comparison === null, 'first participant report must not reveal a comparison before partner completion');
    const partnerSession = await request('/api/intimacy/' + tokenB);
    assert(partnerSession.data.partnerCompleted === true && partnerSession.data.answers === null, 'completion status may be visible but partner answers must remain hidden');
    const prematureReport = await request('/api/intimacy-report/' + tokenB, {}, 409);
    assert(prematureReport.status === 409, 'unfinished participant must not open their report');
    mark('first submission waiting state and pre-completion answer protection');

    await request('/api/intimacy/' + tokenB + '/submit', { method: 'POST', body: JSON.stringify({ answers: answersB }) }, 201);
    const [reportA, reportB] = await Promise.all([
      request('/api/intimacy-report/' + tokenA),
      request('/api/intimacy-report/' + tokenB),
    ]);
    assert(reportA.data.partnerCompleted && reportB.data.partnerCompleted, 'both participants must receive the comparison after both finish');
    assert(reportA.data.comparison && reportB.data.comparison, 'shared comparison must be created for both participants');
    mark('both submissions and shared comparison activation');

    assert(!Object.prototype.hasOwnProperty.call(reportA.data.partnerReport.answers, '58'), 'B private text answer must be excluded from A partner report');
    assert(!reportA.data.comparison.rows.some((row) => row.id === 58), 'B private text answer must not enter comparison rows');
    assert(reportB.data.ownReport.answers['58']?.visibility === 'private', 'private answer must remain available in its owner personal report');
    assert(!reportA.data.comparison.rows.some((row) => row.id === 15), 'private oral note must not appear in comparison rows');
    const blowjob = reportA.data.comparison.oralPairs.find((pair) => pair.id === 'blowjob');
    const cunnilingus = reportA.data.comparison.oralPairs.find((pair) => pair.id === 'cunnilingus');
    assert(blowjob && blowjob.receiver.participant === 'Василий' && blowjob.giver.participant === 'Полина', 'blowjob must pair Vasiliy receiving with Polina giving');
    assert(blowjob.giver.note === null, 'private oral note must not leak into oral pair detail');
    assert(cunnilingus && cunnilingus.receiver.participant === 'Полина' && cunnilingus.giver.participant === 'Василий', 'cunnilingus must pair Polina receiving with Vasiliy giving');
    const analRows = reportA.data.comparison.analComparison.rows;
    assert(analRows.some((row) => row.id === 'anal-receptive'), 'receiving anal-stimulation pairing must be present');
    assert(analRows.some((row) => row.id === 'anal-active'), 'active anal-stimulation pairing must be present');
    assert(reportA.data.counts.skipped === 1 && reportA.data.counts.answered === 89, 'skipped question accounting must be accurate');
    assert(reportB.data.counts.private >= 2, 'private-answer count must include both private test answers');
    mark('private-answer filtering, skipped answers, and cross-role oral / anal pairing');

    await request('/api/session/' + tokenA + '/data', { method: 'DELETE' });
    await request('/api/session/' + tokenB + '/data', { method: 'DELETE' });
    createdRoom = false;
    mark('cleanup of synthetic room and all test data');

    process.stdout.write('\nE2E PASSED: ' + checks.length + ' test groups.\n');
  } finally {
    if (createdRoom) {
      for (const token of tokens) {
        try { await request('/api/session/' + token + '/data', { method: 'DELETE' }, [200, 404]); } catch (_) {}
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write('\nE2E FAILED: ' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
