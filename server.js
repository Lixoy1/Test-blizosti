'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const QUESTIONNAIRE = require('./public/questions.json');
const QUESTIONS = QUESTIONNAIRE.questions;
const INTIMACY_QUESTIONNAIRE = require('./public/intimacy-questions.json');
const INTIMACY_QUESTIONS = INTIMACY_QUESTIONNAIRE.questions;
const INTIMACY_QUESTION_BY_ID = new Map(INTIMACY_QUESTIONS.map((question) => [String(question.id), question]));
const QUESTION_BY_ID = new Map(QUESTIONS.map((question) => [String(question.id), question]));
const DIMENSIONS = QUESTIONNAIRE.dimensions;
const PERSONALITY_IDS = DIMENSIONS.filter((dimension) => dimension.group === 'personality').map((dimension) => dimension.id);

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

let databaseReady = false;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '80kb' }));
app.use('/api/', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 220, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api/', apiLimiter);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const makeToken = () => crypto.randomBytes(32).toString('base64url');

function validToken(token) {
  return typeof token === 'string' && token.length >= 32 && token.length <= 100;
}

async function requireDatabase(_req, res, next) {
  if (!pool || !databaseReady) {
    return res.status(503).json({ error: 'Хранилище пока не подключено. Настрой DATABASE_URL.' });
  }
  next();
}

async function getParticipant(token) {
  if (!validToken(token)) return null;
  const result = await pool.query(
    `SELECT p.room_id, p.role, p.display_name, p.current_version_no, p.consented_at, p.intimacy_consented_at,
            r.created_at, r.status
       FROM participants p
       JOIN rooms r ON r.id = p.room_id
      WHERE p.token_hash = $1
      LIMIT 1`,
    [sha256(token)]
  );
  return result.rows[0] || null;
}

function validSingle(question, value) {
  return typeof value === 'string' && question.options.some((option) => option.value === value);
}

function validateOneAnswer(question, value, allowEmptyText = false) {
  if (question.type === 'scale') return Number.isInteger(value) && value >= 1 && value <= 5;
  if (question.type === 'single') return validSingle(question, value);
  if (question.type === 'text') {
    if (allowEmptyText && (value === '' || value === null || value === undefined)) return true;
    return typeof value === 'string' && value.trim().length >= (question.minLength || 12) && value.length <= 3000;
  }
  return false;
}

function validateDraft(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'Черновик имеет неверный формат.';
  for (const [id, value] of Object.entries(answers)) {
    const question = QUESTION_BY_ID.get(id);
    if (!question) return 'В черновике найден неизвестный вопрос.';
    if (!validateOneAnswer(question, value, true)) return `Проверь ответ на вопрос ${id}.`;
  }
  return null;
}

function validateFinalAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'Ответы имеют неверный формат.';
  const expected = QUESTIONS.map((question) => String(question.id));
  const received = Object.keys(answers);
  if (received.length !== expected.length || expected.some((id) => !Object.prototype.hasOwnProperty.call(answers, id))) {
    return `Нужно ответить на все ${QUESTIONS.length} вопросов.`;
  }
  for (const question of QUESTIONS) {
    if (!validateOneAnswer(question, answers[String(question.id)])) {
      return `Проверь ответ на вопрос ${question.id}.`;
    }
  }
  return null;
}

function getNumericScore(question, value) {
  if (question.type === 'scale' && Number.isInteger(value)) {
    return question.score?.reverse ? 6 - value : value;
  }
  if (question.type === 'single' && question.score?.fromOption) {
    const option = question.options.find((item) => item.value === value);
    if (option && Number.isFinite(option.score)) {
      return question.score.reverse ? 6 - option.score : option.score;
    }
  }
  return null;
}

function profileFromAnswers(answers) {
  const result = {};
  for (const dimension of DIMENSIONS) {
    const scores = [];
    for (const question of QUESTIONS) {
      if (question.score?.dimension !== dimension.id) continue;
      const score = getNumericScore(question, answers[String(question.id)]);
      if (score !== null) scores.push(score);
    }
    if (scores.length) {
      const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
      result[dimension.id] = {
        title: dimension.title,
        description: dimension.description,
        group: dimension.group || 'relationship',
        average: Math.round(average * 100) / 100,
        count: scores.length,
        interpretation: average >= 4.2 ? 'Выражено высоко' : average >= 3.4 ? 'Скорее выражено' : average >= 2.6 ? 'Умеренная выраженность' : average >= 1.8 ? 'Скорее низко' : 'Выражено слабо',
      };
    }
  }
  return result;
}

function compareAnswers(answersA, answersB) {
  const numericGaps = [];
  const differentChoices = [];
  const writtenAnswers = [];

  for (const question of QUESTIONS) {
    const a = answersA[String(question.id)];
    const b = answersB[String(question.id)];
    if (question.type === 'scale' || (question.type === 'single' && question.score?.fromOption)) {
      const av = getNumericScore(question, a);
      const bv = getNumericScore(question, b);
      if (Number.isFinite(av) && Number.isFinite(bv)) {
        const optionLabel = (value) => question.type === 'single' ? (question.options.find((option) => option.value === value)?.label || value) : value;
      numericGaps.push({
        id: question.id,
        block: question.block,
        text: question.text,
        a: optionLabel(a),
        b: optionLabel(b),
        scoreA: av,
        scoreB: bv,
        gap: Math.abs(av - bv),
      });
      }
    } else if (question.type === 'text') {
      writtenAnswers.push({ id: question.id, block: question.block, text: question.text, a, b });
    } else if (a !== b) {
      const label = (value) => question.options.find((option) => option.value === value)?.label || value;
      differentChoices.push({ id: question.id, block: question.block, text: question.text, a: label(a), b: label(b) });
    }
  }

  numericGaps.sort((x, y) => y.gap - x.gap);
  return {
    numericGaps,
    differentChoices,
    writtenAnswers,
    closeQuestions: numericGaps.filter((item) => item.gap <= 0.5),
  };
}

function personalityCompatibility(profileA, profileB) {
  const traits = PERSONALITY_IDS.map((id) => {
    const dimension = DIMENSIONS.find((item) => item.id === id);
    const a = profileA[id]?.average ?? null;
    const b = profileB[id]?.average ?? null;
    const gap = a === null || b === null ? null : Math.round(Math.abs(a - b) * 100) / 100;
    const classification = gap === null ? 'Недостаточно данных' : gap <= 0.4 ? 'Похожие оценки' : gap <= 1 ? 'Умеренное различие' : 'Выраженное различие';
    return { id, title: dimension.title, description: dimension.description, a, b, gap, classification, possibleDynamic: dimension.meaning };
  });
  return {
    traits,
    similar: traits.filter((trait) => trait.gap !== null && trait.gap <= 0.4),
    different: traits.filter((trait) => trait.gap !== null && trait.gap > 1),
    note: 'Сходство или различие черт не является само по себе оценкой качества пары. Эти результаты помогают увидеть возможные темы для согласования, а не предсказать судьбу отношений.',
  };
}


function validateIntimacyAnswer(question, answer, allowIncomplete = false) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  if (answer.skipped === true) return Object.keys(answer).length === 1;
  if (!['shared', 'private'].includes(answer.visibility)) return false;
  if (question.type === 'scale') return Number.isInteger(answer.value) && answer.value >= 1 && answer.value <= 5;
  if (question.type === 'single') return typeof answer.value === 'string' && question.options.some((option) => option.value === answer.value);
  if (question.type === 'multi') {
    if (!Array.isArray(answer.value) || (!allowIncomplete && answer.value.length < 1)) return false;
    if (new Set(answer.value).size !== answer.value.length) return false;
    if (question.maxSelections && answer.value.length > question.maxSelections) return false;
    return answer.value.every((value) => question.options.some((option) => option.value === value));
  }
  if (question.type === 'text') {
    return typeof answer.value === 'string' && answer.value.length <= 3000
      && (allowIncomplete || answer.value.trim().length >= (question.minLength || 5));
  }
  if (question.type === 'practice') {
    const fields = INTIMACY_QUESTIONNAIRE.practiceFields;
    const experienceValid = answer.experience === undefined || fields.experience.some((option) => option.value === answer.experience);
    const desireValid = answer.desire === undefined || fields.desire.some((option) => option.value === answer.desire);
    const comfortValid = answer.comfort === undefined || (Number.isInteger(answer.comfort) && answer.comfort >= 1 && answer.comfort <= 5);
    if (allowIncomplete) return (answer.experience !== undefined || answer.desire !== undefined || answer.comfort !== undefined)
      && experienceValid && desireValid && comfortValid;
    return typeof answer.experience === 'string' && experienceValid
      && typeof answer.desire === 'string' && desireValid
      && Number.isInteger(answer.comfort) && comfortValid;
  }
  return false;
}

function validateIntimacyAnswers(answers, requireAll = false) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'Ответы имеют неверный формат.';
  const expected = INTIMACY_QUESTIONS.map((question) => String(question.id));
  if (requireAll) {
    const received = Object.keys(answers);
    if (received.length !== expected.length || expected.some((id) => !Object.prototype.hasOwnProperty.call(answers, id))) {
      return 'Нужно ответить на все ' + INTIMACY_QUESTIONS.length + ' вопросов или явно пропустить те, на которые не хочется отвечать.';
    }
  }
  for (const [id, answer] of Object.entries(answers)) {
    const question = INTIMACY_QUESTION_BY_ID.get(id);
    if (!question) return 'В ответах найден неизвестный вопрос.';
    if (!validateIntimacyAnswer(question, answer, !requireAll)) return 'Проверь ответ на вопрос ' + id + '.';
  }
  return null;
}

function isSharedIntimacyAnswer(answer) {
  return Boolean(answer && answer.skipped !== true && answer.visibility !== 'private');
}

function intimacyAnswerLabel(question, answer) {
  if (!answer || answer.skipped) return 'Пропущено';
  if (question.type === 'scale') return answer.value + ' из 5';
  if (question.type === 'single') return question.options.find((option) => option.value === answer.value)?.label || answer.value;
  if (question.type === 'multi') return answer.value.map((value) => question.options.find((option) => option.value === value)?.label || value).join(', ');
  if (question.type === 'text') return answer.value;
  if (question.type === 'practice') {
    const fields = INTIMACY_QUESTIONNAIRE.practiceFields;
    return {
      experience: fields.experience.find((option) => option.value === answer.experience)?.label || answer.experience,
      desire: fields.desire.find((option) => option.value === answer.desire)?.label || answer.desire,
      comfort: answer.comfort,
    };
  }
  return String(answer.value ?? '');
}

function compareOralActivities(answersA, answersB) {
  const definitions = [
    { id: 'blowjob', title: 'Минет: Полина делает, Василий получает', receiver: { role: 'A', practiceId: 11, textId: 12 }, giver: { role: 'B', practiceId: 14, textId: 15 } },
    { id: 'cunnilingus', title: 'Куннилингус: Василий делает, Полина получает', receiver: { role: 'B', practiceId: 11, textId: 12 }, giver: { role: 'A', practiceId: 14, textId: 15 } },
  ];
  const answersFor = (role) => role === 'A' ? answersA : answersB;
  return definitions.map((definition) => {
    const receiverAnswers = answersFor(definition.receiver.role);
    const giverAnswers = answersFor(definition.giver.role);
    const receiver = receiverAnswers[String(definition.receiver.practiceId)];
    const giver = giverAnswers[String(definition.giver.practiceId)];
    if (!isSharedIntimacyAnswer(receiver) || !isSharedIntimacyAnswer(giver)) return null;
    const fields = INTIMACY_QUESTIONNAIRE.practiceFields;
    const receiverQuestion = INTIMACY_QUESTION_BY_ID.get(String(definition.receiver.practiceId));
    const giverQuestion = INTIMACY_QUESTION_BY_ID.get(String(definition.giver.practiceId));
    const receiverTextAnswer = receiverAnswers[String(definition.receiver.textId)];
    const giverTextAnswer = giverAnswers[String(definition.giver.textId)];
    return {
      id: definition.id,
      title: definition.title,
      receiver: {
        participant: definition.receiver.role === 'A' ? 'Василий' : 'Полина',
        prompt: receiverQuestion.text[definition.receiver.role],
        experience: fields.experience.find((option) => option.value === receiver.experience)?.label || receiver.experience,
        desire: fields.desire.find((option) => option.value === receiver.desire)?.label || receiver.desire,
        comfort: receiver.comfort,
        note: isSharedIntimacyAnswer(receiverTextAnswer) ? receiverTextAnswer.value : null,
      },
      giver: {
        participant: definition.giver.role === 'A' ? 'Василий' : 'Полина',
        prompt: giverQuestion.text[definition.giver.role],
        experience: fields.experience.find((option) => option.value === giver.experience)?.label || giver.experience,
        desire: fields.desire.find((option) => option.value === giver.desire)?.label || giver.desire,
        comfort: giver.comfort,
        note: isSharedIntimacyAnswer(giverTextAnswer) ? giverTextAnswer.value : null,
      },
      desireCategoriesMatch: receiver.desire === giver.desire,
      comfortGap: Math.abs(receiver.comfort - giver.comfort),
      completion: {
        vasiliy: answersA['17'] && answersA['17'].skipped !== true && answersA['17'].visibility !== 'private' ? {
          experience: fields.experience.find((option) => option.value === answersA['17'].experience)?.label || answersA['17'].experience,
          desire: fields.desire.find((option) => option.value === answersA['17'].desire)?.label || answersA['17'].desire,
          comfort: answersA['17'].comfort,
        } : null,
        polina: answersB['17'] && answersB['17'].skipped !== true && answersB['17'].visibility !== 'private' ? {
          experience: fields.experience.find((option) => option.value === answersB['17'].experience)?.label || answersB['17'].experience,
          desire: fields.desire.find((option) => option.value === answersB['17'].desire)?.label || answersB['17'].desire,
          comfort: answersB['17'].comfort,
        } : null,
      },
      pleasure: {
        vasiliy: isSharedIntimacyAnswer(answersA['18']) ? answersA['18'].value : null,
        polina: isSharedIntimacyAnswer(answersB['18']) ? answersB['18'].value : null,
      },
    };
  }).filter(Boolean);
}

function compareAnalActivities(answersA, answersB) {
  const pairs = [
    { id: 'anal-receptive', title: 'Анальная стимуляция: принимающая роль', a: 31, b: 32 },
    { id: 'anal-active', title: 'Анальная стимуляция: активная роль', a: 32, b: 31 },
  ];
  const rows = pairs.map((pair) => {
    const a = answersA[String(pair.a)];
    const b = answersB[String(pair.b)];
    if (!isSharedIntimacyAnswer(a) || !isSharedIntimacyAnswer(b)) return null;
    const fields = INTIMACY_QUESTIONNAIRE.practiceFields;
    const label = (answer) => ({
      experience: fields.experience.find((option) => option.value === answer.experience)?.label || answer.experience,
      desire: fields.desire.find((option) => option.value === answer.desire)?.label || answer.desire,
      comfort: answer.comfort,
    });
    return { id: pair.id, title: pair.title, a: label(a), b: label(b), same: a.experience === b.experience && a.desire === b.desire && a.comfort === b.comfort };
  }).filter(Boolean);
  const penetrationA = answersA['33'];
  const penetrationB = answersB['33'];
  let penetration = null;
  if (isSharedIntimacyAnswer(penetrationA) && isSharedIntimacyAnswer(penetrationB)) {
    penetration = { title: 'Анальное проникновение: желания принимающей и активной стороны', a: penetrationA.value, b: penetrationB.value, gap: Math.abs(penetrationA.value - penetrationB.value) };
  }
  return { rows, penetration };
}

function compareIntimacyAnswers(answersA, answersB) {
  const rows = [];
  for (const question of INTIMACY_QUESTIONS) {
    if ([11, 12, 14, 15, 17, 18, 31, 32, 33].includes(question.id)) continue;
    const a = answersA[String(question.id)];
    const b = answersB[String(question.id)];
    if (!isSharedIntimacyAnswer(a) || !isSharedIntimacyAnswer(b)) continue;
    const row = {
      id: question.id, block: question.block, type: question.type,
      textA: question.text.A, textB: question.text.B,
      a: intimacyAnswerLabel(question, a), b: intimacyAnswerLabel(question, b),
      same: false, differences: [],
    };
    if (question.type === 'scale') {
      row.gap = Math.abs(a.value - b.value);
      row.same = row.gap === 0;
    } else if (question.type === 'single') {
      row.same = a.value === b.value;
    } else if (question.type === 'multi') {
      const shared = a.value.filter((value) => b.value.includes(value));
      const onlyA = a.value.filter((value) => !b.value.includes(value));
      const onlyB = b.value.filter((value) => !a.value.includes(value));
      row.same = onlyA.length === 0 && onlyB.length === 0;
      row.shared = shared.map((value) => question.options.find((option) => option.value === value)?.label || value);
      row.onlyA = onlyA.map((value) => question.options.find((option) => option.value === value)?.label || value);
      row.onlyB = onlyB.map((value) => question.options.find((option) => option.value === value)?.label || value);
    } else if (question.type === 'practice') {
      const fields = INTIMACY_QUESTIONNAIRE.practiceFields;
      row.same = a.experience === b.experience && a.desire === b.desire && a.comfort === b.comfort;
      row.differences = [
        { label: 'Опыт', a: fields.experience.find((option) => option.value === a.experience)?.label, b: fields.experience.find((option) => option.value === b.experience)?.label },
        { label: 'Желание', a: fields.desire.find((option) => option.value === a.desire)?.label, b: fields.desire.find((option) => option.value === b.desire)?.label },
        { label: 'Комфорт', a: a.comfort, b: b.comfort },
      ].filter((item) => item.a !== item.b);
    }
    rows.push(row);
  }
  return {
    rows,
    oralPairs: compareOralActivities(answersA, answersB),
    analComparison: compareAnalActivities(answersA, answersB),
    sharedCount: rows.length,
    closeScale: rows.filter((row) => row.type === 'scale' && row.gap <= 1).length,
    differentScale: rows.filter((row) => row.type === 'scale' && row.gap > 1).length,
  };
}

function summarizeIntimacyAnswers(answers) {
  const values = Object.values(answers || {});
  return {
    total: INTIMACY_QUESTIONS.length,
    answered: values.filter((answer) => answer && answer.skipped !== true).length,
    skipped: values.filter((answer) => answer?.skipped === true).length,
    private: values.filter((answer) => answer && answer.skipped !== true && answer.visibility === 'private').length,
    shared: values.filter((answer) => isSharedIntimacyAnswer(answer)).length,
  };
}

async function latestSubmission(roomId, role) {
  const result = await pool.query(
    'SELECT version_no, answers, completed_at FROM submissions WHERE room_id = $1 AND role = $2 ORDER BY version_no DESC LIMIT 1',
    [roomId, role]
  );
  return result.rows[0] || null;
}

async function writeDraftSnapshot(client, participant, answers) {
  const { room_id: roomId, role, current_version_no: versionNo } = participant;
  const previous = await client.query(
    'SELECT answers FROM drafts WHERE room_id = $1 AND role = $2 AND version_no = $3 FOR UPDATE',
    [roomId, role, versionNo]
  );
  const oldAnswers = previous.rows[0]?.answers || {};
  const allIds = new Set([...Object.keys(oldAnswers), ...Object.keys(answers)]);
  for (const id of allIds) {
    const before = oldAnswers[id];
    const after = answers[id];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    await client.query(
      `INSERT INTO answer_history
        (room_id, role, version_no, question_id, old_value, new_value)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        roomId, role, versionNo, Number(id),
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
      ]
    );
  }
  await client.query(
    `INSERT INTO drafts (room_id, role, version_no, answers, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (room_id, role, version_no)
     DO UPDATE SET answers = EXCLUDED.answers, updated_at = NOW()`,
    [roomId, role, versionNo, JSON.stringify(answers)]
  );
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, database: databaseReady ? 'connected' : (pool ? 'starting' : 'not_configured') });
});

app.post('/api/rooms', createLimiter, requireDatabase, async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId = crypto.randomUUID();
    const tokenA = makeToken();
    const tokenB = makeToken();
    await client.query('BEGIN');
    await client.query('INSERT INTO rooms (id) VALUES ($1)', [roomId]);
    await client.query(
      `INSERT INTO participants (room_id, role, display_name, token_hash, current_version_no)
       VALUES ($1, 'A', 'Василий', $2, 1), ($1, 'B', 'Полина', $3, 1)`,
      [roomId, sha256(tokenA), sha256(tokenB)]
    );
    await client.query('COMMIT');
    const origin = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      participantUrl: `${origin}/p/${tokenA}`,
      inviteUrl: `${origin}/p/${tokenB}`,
      note: 'Каждая ссылка — личный ключ доступа. Сохрани её и не публикуй.',
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('room_create_failed', error.message);
    res.status(500).json({ error: 'Не удалось создать пространство. Попробуйте ещё раз.' });
  } finally {
    client.release();
  }
});

app.get('/api/session/:token', requireDatabase, async (req, res) => {
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    const versionNo = participant.current_version_no;
    const [ownSubmission, partnerSubmission, draft] = await Promise.all([
      pool.query(
        'SELECT answers, completed_at FROM submissions WHERE room_id = $1 AND role = $2 AND version_no = $3',
        [participant.room_id, participant.role, versionNo]
      ),
      latestSubmission(participant.room_id, participant.role === 'A' ? 'B' : 'A'),
      pool.query(
        'SELECT answers, updated_at FROM drafts WHERE room_id = $1 AND role = $2 AND version_no = $3',
        [participant.room_id, participant.role, versionNo]
      ),
    ]);
    const own = ownSubmission.rows[0] || null;
    res.json({
      role: participant.role,
      displayName: participant.display_name,
      partnerName: participant.role === 'A' ? 'Полина' : 'Василий',
      createdAt: participant.created_at,
      currentVersionNo: versionNo,
      consented: Boolean(participant.consented_at),
      ownCompleted: Boolean(own),
      ownAnswers: own ? own.answers : null,
      ownDraftAnswers: draft.rows[0]?.answers || {},
      draftUpdatedAt: draft.rows[0]?.updated_at || null,
      ownCompletedAt: own?.completed_at || null,
      partnerCompleted: Boolean(partnerSubmission),
      partnerLatestVersion: partnerSubmission?.version_no || null,
    });
  } catch (error) {
    console.error('session_read_failed', error.message);
    res.status(500).json({ error: 'Не удалось загрузить анкету.' });
  }
});

app.post('/api/session/:token/consent', requireDatabase, async (req, res) => {
  if (req.body?.consent !== true) return res.status(400).json({ error: 'Нужно подтвердить согласие.' });
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    if (Number(req.body.versionNo) !== participant.current_version_no) {
      return res.status(409).json({ error: 'Эта ссылка открыта на предыдущей версии. Обнови страницу, чтобы продолжить актуальное прохождение.' });
    }
    await pool.query(
      'UPDATE participants SET consented_at = COALESCE(consented_at, NOW()) WHERE room_id = $1 AND role = $2 AND current_version_no = $3',
      [participant.room_id, participant.role, participant.current_version_no]
    );
    res.json({ consented: true });
  } catch (error) {
    console.error('consent_failed', error.message);
    res.status(500).json({ error: 'Не удалось сохранить согласие.' });
  }
});

app.put('/api/session/:token/draft', requireDatabase, async (req, res) => {
  const validationError = validateDraft(req.body?.answers);
  if (validationError) return res.status(400).json({ error: validationError });
  const client = await pool.connect();
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT current_version_no, consented_at FROM participants WHERE room_id = $1 AND role = $2 FOR UPDATE',
      [participant.room_id, participant.role]
    );
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Участник не найден.' });
    }
    const activeVersion = locked.rows[0].current_version_no;
    if (Number(req.body.versionNo) !== activeVersion) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Открыта предыдущая версия анкеты. Обнови страницу.' });
    }
    if (!locked.rows[0].consented_at) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Сначала подтверди согласие на сохранение ответов.' });
    }
    const activeParticipant = { ...participant, current_version_no: activeVersion };
    const existing = await client.query(
      'SELECT id FROM submissions WHERE room_id = $1 AND role = $2 AND version_no = $3',
      [participant.room_id, participant.role, activeVersion]
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Эта версия анкеты уже завершена.' });
    }
    await writeDraftSnapshot(client, activeParticipant, req.body.answers);
    await client.query('COMMIT');
    res.json({ saved: true, versionNo: participant.current_version_no });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('draft_save_failed', error.message);
    res.status(500).json({ error: 'Не удалось сохранить черновик. Проверь соединение.' });
  } finally {
    client.release();
  }
});

app.post('/api/session/:token/submit', requireDatabase, async (req, res) => {
  const validationError = validateFinalAnswers(req.body?.answers);
  if (validationError) return res.status(400).json({ error: validationError });
  if (req.body?.consent !== true) return res.status(400).json({ error: 'Нужно подтвердить согласие на сохранение и совместное сравнение ответов.' });

  const client = await pool.connect();
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT current_version_no, consented_at FROM participants WHERE room_id = $1 AND role = $2 FOR UPDATE',
      [participant.room_id, participant.role]
    );
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Участник не найден.' });
    }
    const activeVersion = locked.rows[0].current_version_no;
    if (Number(req.body.versionNo) !== activeVersion) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Открыта предыдущая версия анкеты. Обнови страницу.' });
    }
    if (!locked.rows[0].consented_at) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Сначала подтверди согласие на сохранение ответов.' });
    }
    const activeParticipant = { ...participant, current_version_no: activeVersion };
    await writeDraftSnapshot(client, activeParticipant, req.body.answers);
    const inserted = await client.query(
      `INSERT INTO submissions (room_id, role, version_no, answers, consent)
       VALUES ($1, $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (room_id, role, version_no) DO NOTHING
       RETURNING id`,
      [participant.room_id, participant.role, activeVersion, JSON.stringify(req.body.answers)]
    );
    if (!inserted.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Эта версия уже завершена. История предыдущих прохождений сохранена.' });
    }
    const partner = await latestSubmission(participant.room_id, participant.role === 'A' ? 'B' : 'A');
    await client.query(
      "UPDATE rooms SET status = CASE WHEN EXISTS (SELECT 1 FROM submissions WHERE room_id = $1 AND role = 'A') AND EXISTS (SELECT 1 FROM submissions WHERE room_id = $1 AND role = 'B') THEN 'completed' ELSE 'open' END WHERE id = $1",
      [participant.room_id]
    );
    await client.query('COMMIT');
    res.status(201).json({ saved: true, versionNo: activeVersion, partnerCompleted: Boolean(partner) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('submission_failed', error.message);
    res.status(500).json({ error: 'Не удалось сохранить ответы. Попробуйте ещё раз.' });
  } finally {
    client.release();
  }
});

app.post('/api/session/:token/new-attempt', requireDatabase, async (req, res) => {
  const client = await pool.connect();
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT current_version_no FROM participants WHERE room_id = $1 AND role = $2 FOR UPDATE',
      [participant.room_id, participant.role]
    );
    if (!locked.rowCount || Number(req.body.versionNo) !== locked.rows[0].current_version_no) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Версия анкеты уже изменилась. Обнови страницу.' });
    }
    const activeVersion = locked.rows[0].current_version_no;
    const completed = await client.query(
      'SELECT id FROM submissions WHERE room_id = $1 AND role = $2 AND version_no = $3',
      [participant.room_id, participant.role, activeVersion]
    );
    if (!completed.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Сначала заверши текущую анкету. Начать новую версию можно только после отправки.' });
    }
    const nextVersion = activeVersion + 1;
    await client.query(
      'UPDATE participants SET current_version_no = $3, consented_at = NULL WHERE room_id = $1 AND role = $2',
      [participant.room_id, participant.role, nextVersion]
    );
    await client.query(
      'INSERT INTO drafts (room_id, role, version_no, answers) VALUES ($1, $2, $3, \'{}\'::jsonb)',
      [participant.room_id, participant.role, nextVersion]
    );
    await client.query('COMMIT');
    res.status(201).json({ versionNo: nextVersion });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('new_attempt_failed', error.message);
    res.status(500).json({ error: 'Не удалось создать новую версию анкеты.' });
  } finally {
    client.release();
  }
});

app.get('/api/report/:token', requireDatabase, async (req, res) => {
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    const own = await pool.query(
      'SELECT version_no, answers, completed_at FROM submissions WHERE room_id = $1 AND role = $2 AND version_no = $3',
      [participant.room_id, participant.role, participant.current_version_no]
    );
    if (!own.rowCount) return res.status(409).json({ error: 'Сначала заверши текущую анкету.' });
    const partnerRole = participant.role === 'A' ? 'B' : 'A';
    const partner = await latestSubmission(participant.room_id, partnerRole);
    const history = await pool.query(
      `SELECT s.version_no, s.completed_at,
              (SELECT COUNT(*)::int FROM answer_history h
                WHERE h.room_id = s.room_id AND h.role = s.role AND h.version_no = s.version_no) AS edits
         FROM submissions s
        WHERE s.room_id = $1 AND s.role = $2
        ORDER BY s.version_no DESC`,
      [participant.room_id, participant.role]
    );
    const ownAnswers = own.rows[0].answers;
    const ownProfile = profileFromAnswers(ownAnswers);
    const changeLog = await pool.query(
      `SELECT version_no, question_id, old_value, new_value, changed_at
         FROM answer_history
        WHERE room_id = $1 AND role = $2
        ORDER BY changed_at ASC, id ASC`,
      [participant.room_id, participant.role]
    );
    const ownReport = {
      participant: participant.display_name,
      versionNo: own.rows[0].version_no,
      completedAt: own.rows[0].completed_at,
      profile: ownProfile,
      answers: ownAnswers,
      history: history.rows,
      changeLog: changeLog.rows,
    };
    if (!partner) return res.json({ ownReport, partnerCompleted: false, comparison: null });

    const partnerProfile = profileFromAnswers(partner.answers);
    const partnerReport = {
      participant: participant.role === 'A' ? 'Полина' : 'Василий',
      versionNo: partner.version_no,
      completedAt: partner.completed_at,
      profile: partnerProfile,
      answers: partner.answers,
    };

    const answersA = participant.role === 'A' ? ownAnswers : partner.answers;
    const answersB = participant.role === 'A' ? partner.answers : ownAnswers;
    const profileA = participant.role === 'A' ? ownProfile : partnerProfile;
    const profileB = participant.role === 'A' ? partnerProfile : ownProfile;

    const dimensionComparison = DIMENSIONS.map((dimension) => {
      const a = profileA[dimension.id]?.average ?? null;
      const b = profileB[dimension.id]?.average ?? null;
      const gap = a === null || b === null ? null : Math.round(Math.abs(a - b) * 100) / 100;
      let match = 'Недостаточно данных';
      if (gap !== null) {
        if (dimension.group === 'personality') match = gap <= 0.4 ? 'Похожие оценки' : gap <= 1 ? 'Умеренное различие' : 'Выраженное различие';
        else match = gap <= 0.5 ? 'Близкие оценки' : gap <= 1.2 ? 'Есть различия' : 'Заметное расхождение';
      }
      return { id: dimension.id, title: dimension.title, description: dimension.description, group: dimension.group, a, b, gap, match };
    });

    const personality = personalityCompatibility(profileA, profileB);
    const love = dimensionComparison.filter((dimension) => dimension.group === 'love');
    const relationship = dimensionComparison.filter((dimension) => dimension.group === 'relationship');

    res.json({
      ownReport,
      partnerCompleted: true,
      partnerReport,
      comparison: {
        relationship,
        love,
        personality,
        dimensionComparison,
        questions: compareAnswers(answersA, answersB),
        note: 'Сравнение показывает различия в самооценках, а не устанавливает, кто прав и кто любит сильнее.',
      },
    });
  } catch (error) {
    console.error('report_failed', error.message);
    res.status(500).json({ error: 'Не удалось сформировать отчёт.' });
  }
});

app.delete('/api/session/:token/data', requireDatabase, async (req, res) => {
  const client = await pool.connect();
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или данные уже удалены.' });
    await client.query('BEGIN');
    await client.query('DELETE FROM answer_history WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    await client.query('DELETE FROM drafts WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    await client.query('DELETE FROM submissions WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    await client.query('DELETE FROM participants WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    await client.query('DELETE FROM rooms WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM participants WHERE room_id = $1)', [participant.room_id]);
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('data_delete_failed', error.message);
    res.status(500).json({ error: 'Не удалось удалить данные. Попробуйте позже.' });
  } finally {
    client.release();
  }
});


// Adult intimacy questionnaire: stored independently from the relationship questionnaire.
app.get('/api/intimacy/:token', requireDatabase, async (req, res) => {
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    const [own, draft, partner] = await Promise.all([
      pool.query('SELECT answers, completed_at FROM intimacy_submissions WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]),
      pool.query('SELECT answers, updated_at FROM intimacy_drafts WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]),
      pool.query('SELECT completed_at FROM intimacy_submissions WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role === 'A' ? 'B' : 'A']),
    ]);
    res.json({
      role: participant.role, displayName: participant.display_name,
      partnerName: participant.role === 'A' ? 'Полина' : 'Василий',
      consented: Boolean(participant.intimacy_consented_at),
      completed: Boolean(own.rows[0]), completedAt: own.rows[0]?.completed_at || null,
      answers: own.rows[0]?.answers || null, draftAnswers: draft.rows[0]?.answers || {},
      draftUpdatedAt: draft.rows[0]?.updated_at || null, partnerCompleted: Boolean(partner.rows[0]),
    });
  } catch (error) {
    console.error('intimacy_session_failed', error.message);
    res.status(500).json({ error: 'Не удалось загрузить интимную анкету.' });
  }
});

app.post('/api/intimacy/:token/consent', requireDatabase, async (req, res) => {
  if (req.body?.consent !== true) return res.status(400).json({ error: 'Нужно подтвердить отдельное согласие.' });
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    await pool.query('UPDATE participants SET intimacy_consented_at = COALESCE(intimacy_consented_at, NOW()) WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    res.json({ consented: true });
  } catch (error) {
    console.error('intimacy_consent_failed', error.message);
    res.status(500).json({ error: 'Не удалось сохранить согласие.' });
  }
});

app.put('/api/intimacy/:token/draft', requireDatabase, async (req, res) => {
  const validationError = validateIntimacyAnswers(req.body?.answers, false);
  if (validationError) return res.status(400).json({ error: validationError });
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    if (!participant.intimacy_consented_at) return res.status(403).json({ error: 'Сначала подтверди отдельное согласие на интимную анкету.' });
    const existing = await pool.query('SELECT room_id FROM intimacy_submissions WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    if (existing.rowCount) return res.status(409).json({ error: 'Интимная анкета уже завершена.' });
    await pool.query(
      'INSERT INTO intimacy_drafts (room_id, role, answers, updated_at) VALUES ($1, $2, $3::jsonb, NOW()) ON CONFLICT (room_id, role) DO UPDATE SET answers = EXCLUDED.answers, updated_at = NOW()',
      [participant.room_id, participant.role, JSON.stringify(req.body.answers)]
    );
    res.json({ saved: true });
  } catch (error) {
    console.error('intimacy_draft_failed', error.message);
    res.status(500).json({ error: 'Не удалось сохранить интимный черновик.' });
  }
});

app.post('/api/intimacy/:token/submit', requireDatabase, async (req, res) => {
  const validationError = validateIntimacyAnswers(req.body?.answers, true);
  if (validationError) return res.status(400).json({ error: validationError });
  const client = await pool.connect();
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    await client.query('BEGIN');
    const locked = await client.query('SELECT intimacy_consented_at FROM participants WHERE room_id = $1 AND role = $2 FOR UPDATE', [participant.room_id, participant.role]);
    if (!locked.rowCount || !locked.rows[0].intimacy_consented_at) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Сначала подтверди отдельное согласие на интимную анкету.' });
    }
    const inserted = await client.query(
      'INSERT INTO intimacy_submissions (room_id, role, answers, consent) VALUES ($1, $2, $3::jsonb, TRUE) ON CONFLICT (room_id, role) DO NOTHING RETURNING completed_at',
      [participant.room_id, participant.role, JSON.stringify(req.body.answers)]
    );
    if (!inserted.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Интимная анкета уже завершена.' });
    }
    await client.query('DELETE FROM intimacy_drafts WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    const partner = await client.query('SELECT completed_at FROM intimacy_submissions WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role === 'A' ? 'B' : 'A']);
    await client.query('COMMIT');
    res.status(201).json({ saved: true, partnerCompleted: Boolean(partner.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('intimacy_submit_failed', error.message);
    res.status(500).json({ error: 'Не удалось завершить интимную анкету.' });
  } finally {
    client.release();
  }
});

app.get('/api/intimacy-report/:token', requireDatabase, async (req, res) => {
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    const ownRole = participant.role;
    const partnerRole = ownRole === 'A' ? 'B' : 'A';
    const [own, partner] = await Promise.all([
      pool.query('SELECT answers, completed_at FROM intimacy_submissions WHERE room_id = $1 AND role = $2', [participant.room_id, ownRole]),
      pool.query('SELECT answers, completed_at FROM intimacy_submissions WHERE room_id = $1 AND role = $2', [participant.room_id, partnerRole]),
    ]);
    if (!own.rows[0]) return res.status(409).json({ error: 'Сначала заверши интимную анкету.' });
    const ownAnswers = own.rows[0].answers;
    if (!partner.rows[0]) {
      return res.json({
        ownReport: { participant: participant.display_name, completedAt: own.rows[0].completed_at, answers: ownAnswers },
        partnerCompleted: false, comparison: null, counts: summarizeIntimacyAnswers(ownAnswers),
      });
    }
    const partnerAnswersFull = partner.rows[0].answers;
    const partnerSharedAnswers = Object.fromEntries(Object.entries(partnerAnswersFull).filter(([, answer]) => isSharedIntimacyAnswer(answer)));
    const ownSharedAnswers = Object.fromEntries(Object.entries(ownAnswers).filter(([, answer]) => isSharedIntimacyAnswer(answer)));
    const answersA = ownRole === 'A' ? ownSharedAnswers : partnerSharedAnswers;
    const answersB = ownRole === 'A' ? partnerSharedAnswers : ownSharedAnswers;
    res.json({
      ownReport: { participant: participant.display_name, completedAt: own.rows[0].completed_at, answers: ownAnswers },
      partnerCompleted: true,
      partnerReport: { participant: partnerRole === 'A' ? 'Василий' : 'Полина', completedAt: partner.rows[0].completed_at, answers: partnerSharedAnswers },
      comparison: compareIntimacyAnswers(answersA, answersB),
      counts: summarizeIntimacyAnswers(ownAnswers),
      partnerCounts: summarizeIntimacyAnswers(partnerSharedAnswers),
    });
  } catch (error) {
    console.error('intimacy_report_failed', error.message);
    res.status(500).json({ error: 'Не удалось сформировать интимный отчёт.' });
  }
});

app.delete('/api/intimacy/:token/data', requireDatabase, async (req, res) => {
  const client = await pool.connect();
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена.' });
    await client.query('BEGIN');
    await client.query('DELETE FROM intimacy_drafts WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    await client.query('DELETE FROM intimacy_submissions WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    await client.query('UPDATE participants SET intimacy_consented_at = NULL WHERE room_id = $1 AND role = $2', [participant.room_id, participant.role]);
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('intimacy_delete_failed', error.message);
    res.status(500).json({ error: 'Не удалось удалить интимные ответы.' });
  } finally {
    client.release();
  }
});

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    // HTML and app bundles must revalidate immediately after a deploy.
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  }
}));
app.get('/p/:token', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

async function start() {
  if (pool) {
    try {
      const schema = fs.readFileSync(path.join(__dirname, 'sql', 'schema.sql'), 'utf8');
      await pool.query(schema);
      databaseReady = true;
      console.log('database_ready');
    } catch (error) {
      console.error('database_setup_failed', error.message);
    }
  } else {
    console.warn('DATABASE_URL is not set; persistent API is disabled.');
  }
  app.listen(PORT, () => console.log(`Mezhdu Nami listening on ${PORT}`));
}

start();
