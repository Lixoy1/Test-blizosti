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
    `SELECT p.room_id, p.role, p.display_name, p.current_version_no, p.consented_at,
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
        numericGaps.push({ id: question.id, block: question.block, text: question.text, a: av, b: bv, gap: Math.abs(av - bv) });
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
    await pool.query(
      'UPDATE participants SET consented_at = COALESCE(consented_at, NOW()) WHERE room_id = $1 AND role = $2',
      [participant.room_id, participant.role]
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
    if (!participant.consented_at) return res.status(403).json({ error: 'Сначала подтверди согласие на сохранение ответов.' });
    const existing = await client.query(
      'SELECT id FROM submissions WHERE room_id = $1 AND role = $2 AND version_no = $3',
      [participant.room_id, participant.role, participant.current_version_no]
    );
    if (existing.rowCount) return res.status(409).json({ error: 'Эта версия анкеты уже завершена.' });
    await client.query('BEGIN');
    await writeDraftSnapshot(client, participant, req.body.answers);
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
    if (!participant.consented_at) return res.status(403).json({ error: 'Сначала подтверди согласие на сохранение ответов.' });
    await client.query('BEGIN');
    await client.query(
      'SELECT id FROM participants WHERE room_id = $1 AND role = $2 FOR UPDATE',
      [participant.room_id, participant.role]
    );
    await writeDraftSnapshot(client, participant, req.body.answers);
    const inserted = await client.query(
      `INSERT INTO submissions (room_id, role, version_no, answers, consent)
       VALUES ($1, $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (room_id, role, version_no) DO NOTHING
       RETURNING id`,
      [participant.room_id, participant.role, participant.current_version_no, JSON.stringify(req.body.answers)]
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
    res.status(201).json({ saved: true, versionNo: participant.current_version_no, partnerCompleted: Boolean(partner) });
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
    await client.query('SELECT id FROM participants WHERE room_id = $1 AND role = $2 FOR UPDATE', [participant.room_id, participant.role]);
    const completed = await client.query(
      'SELECT id FROM submissions WHERE room_id = $1 AND role = $2 AND version_no = $3',
      [participant.room_id, participant.role, participant.current_version_no]
    );
    if (!completed.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Сначала заверши текущую анкету. Начать новую версию можно только после отправки.' });
    }
    const nextVersion = participant.current_version_no + 1;
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

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
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
