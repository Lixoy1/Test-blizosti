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
const QUESTIONS = require('./public/questions.json');
const QUESTION_BY_ID = new Map(QUESTIONS.questions.map((q) => [String(q.id), q]));
const DIMENSIONS = QUESTIONS.dimensions;

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
app.use(express.json({ limit: '40kb' }));
app.use('/api/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api/', apiLimiter);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const makeToken = () => crypto.randomBytes(32).toString('base64url');
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

async function requireDatabase(req, res, next) {
  if (!pool || !databaseReady) {
    return res.status(503).json({ error: 'Хранилище ещё не настроено. Подключите PostgreSQL через DATABASE_URL.' });
  }
  next();
}

async function getParticipant(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 100) return null;
  const result = await pool.query(
    `SELECT p.room_id, p.role, p.display_name, r.created_at, r.status
       FROM participants p JOIN rooms r ON r.id = p.room_id
      WHERE p.token_hash = $1 LIMIT 1`,
    [sha256(token)]
  );
  return result.rows[0] || null;
}

function validateAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'Ответы имеют неверный формат.';
  const expected = QUESTIONS.questions.map((q) => String(q.id));
  const received = Object.keys(answers);
  if (received.length !== expected.length || expected.some((id) => !Object.prototype.hasOwnProperty.call(answers, id))) {
    return 'Нужно ответить на все 60 вопросов.';
  }

  for (const question of QUESTIONS.questions) {
    const value = answers[String(question.id)];
    if (question.type === 'scale') {
      if (!Number.isInteger(value) || value < 1 || value > 5) return `Проверь ответ на вопрос ${question.id}.`;
    } else if (question.type === 'text') {
      if (typeof value !== 'string' || value.trim().length < (question.minLength || 12) || value.length > 3000) {
        return `В вопросе ${question.id} нужен развёрнутый ответ.`;
      }
    } else if (question.type === 'single') {
      if (typeof value !== 'string' || !question.options.some((option) => option.value === value)) {
        return `Выбери вариант в вопросе ${question.id}.`;
      }
    } else {
      return `Неизвестный тип вопроса ${question.id}.`;
    }
  }
  return null;
}

function profileFromAnswers(answers) {
  const result = {};
  for (const dimension of DIMENSIONS) {
    const scores = [];
    for (const question of QUESTIONS.questions) {
      if (!question.score || question.score.dimension !== dimension.id) continue;
      const raw = answers[String(question.id)];
      let score = null;
      if (question.type === 'scale' && Number.isInteger(raw)) score = raw;
      if (question.type === 'single' && question.score.fromOption) {
        const option = question.options.find((item) => item.value === raw);
        if (option && Number.isFinite(option.score)) score = option.score;
      }
      if (score !== null) {
        if (question.score.reverse) score = 6 - score;
        scores.push(score);
      }
    }
    if (scores.length) {
      const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
      result[dimension.id] = {
        title: dimension.title,
        description: dimension.description,
        average: Math.round(average * 10) / 10,
        count: scores.length,
        interpretation: average >= 4.2 ? 'Выражено высоко' : average >= 3.4 ? 'Скорее выражено' : average >= 2.6 ? 'Смешанная картина' : average >= 1.8 ? 'Скорее низко' : 'Выражено слабо',
      };
    }
  }
  return result;
}

function compareAnswers(answersA, answersB) {
  const numericGaps = [];
  const differentChoices = [];
  const writtenAnswers = [];

  for (const question of QUESTIONS.questions) {
    const a = answersA[String(question.id)];
    const b = answersB[String(question.id)];
    if (question.type === 'scale' || (question.type === 'single' && question.score?.fromOption)) {
      const getScore = (value) => question.type === 'scale' ? value : question.options.find((o) => o.value === value)?.score;
      const av = getScore(a);
      const bv = getScore(b);
      if (Number.isFinite(av) && Number.isFinite(bv)) {
        numericGaps.push({ id: question.id, text: question.text, a, b, gap: Math.abs(av - bv) });
      }
    } else if (question.type === 'text') {
      writtenAnswers.push({ id: question.id, text: question.text, a, b });
    } else if (a !== b) {
      const label = (value) => question.options.find((o) => o.value === value)?.label || value;
      differentChoices.push({ id: question.id, text: question.text, a: label(a), b: label(b) });
    }
  }

  numericGaps.sort((x, y) => y.gap - x.gap);
  return {
    numericGaps: numericGaps.slice(0, 8),
    differentChoices,
    writtenAnswers,
    closeQuestions: numericGaps.filter((item) => item.gap <= 1).slice(0, 8),
  };
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
      'INSERT INTO participants (room_id, role, display_name, token_hash) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)',
      [roomId, 'A', 'Василий', sha256(tokenA), 'B', 'Полина', sha256(tokenB)]
    );
    await client.query('COMMIT');
    const origin = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      participantUrl: `${origin}/p/${tokenA}`,
      inviteUrl: `${origin}/p/${tokenB}`,
      note: 'Сохраните обе ссылки. Они дают доступ к анкетам и отчётам соответствующих участников.',
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
    const rows = await pool.query(
      'SELECT role, answers, completed_at FROM submissions WHERE room_id = $1',
      [participant.room_id]
    );
    const own = rows.rows.find((row) => row.role === participant.role);
    const partner = rows.rows.find((row) => row.role !== participant.role);
    res.json({
      role: participant.role,
      displayName: participant.display_name,
      partnerName: participant.role === 'A' ? 'Полина' : 'Василий',
      createdAt: participant.created_at,
      ownCompleted: Boolean(own),
      partnerCompleted: Boolean(partner),
      ownAnswers: own ? own.answers : null,
      ownCompletedAt: own ? own.completed_at : null,
    });
  } catch (error) {
    console.error('session_read_failed', error.message);
    res.status(500).json({ error: 'Не удалось загрузить анкету.' });
  }
});

app.post('/api/session/:token/submit', requireDatabase, async (req, res) => {
  const errorMessage = validateAnswers(req.body?.answers);
  if (errorMessage) return res.status(400).json({ error: errorMessage });
  if (req.body?.consent !== true) return res.status(400).json({ error: 'Нужно подтвердить согласие на сохранение и совместное сравнение ответов.' });

  const participant = await getParticipant(req.params.token);
  if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO submissions (room_id, role, answers, consent)
       VALUES ($1, $2, $3::jsonb, TRUE)
       ON CONFLICT (room_id, role) DO NOTHING
       RETURNING id`,
      [participant.room_id, participant.role, JSON.stringify(req.body.answers)]
    );
    if (!inserted.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Эта анкета уже завершена. Ответы после отправки не редактируются.' });
    }
    const count = await client.query('SELECT COUNT(*)::int AS total FROM submissions WHERE room_id = $1', [participant.room_id]);
    if (count.rows[0].total === 2) {
      await client.query("UPDATE rooms SET status = 'completed' WHERE id = $1", [participant.room_id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ saved: true, partnerCompleted: count.rows[0].total === 2 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('submission_failed', error.message);
    res.status(500).json({ error: 'Не удалось сохранить ответы. Попробуйте ещё раз.' });
  } finally {
    client.release();
  }
});

app.get('/api/report/:token', requireDatabase, async (req, res) => {
  try {
    const participant = await getParticipant(req.params.token);
    if (!participant) return res.status(404).json({ error: 'Ссылка не найдена или недействительна.' });
    const rows = await pool.query(
      'SELECT role, answers, completed_at FROM submissions WHERE room_id = $1',
      [participant.room_id]
    );
    const own = rows.rows.find((row) => row.role === participant.role);
    if (!own) return res.status(409).json({ error: 'Сначала заверши свою анкету.' });
    const partner = rows.rows.find((row) => row.role !== participant.role);
    const ownReport = {
      participant: participant.display_name,
      completedAt: own.completed_at,
      profile: profileFromAnswers(own.answers),
      answers: own.answers,
    };
    if (!partner) return res.json({ ownReport, partnerCompleted: false, comparison: null });

    const partnerReport = {
      participant: participant.role === 'A' ? 'Полина' : 'Василий',
      completedAt: partner.completed_at,
      profile: profileFromAnswers(partner.answers),
      answers: partner.answers,
    };
    const ownFirst = participant.role === 'A' ? own.answers : partner.answers;
    const ownSecond = participant.role === 'A' ? partner.answers : own.answers;
    const profileA = participant.role === 'A' ? ownReport.profile : partnerReport.profile;
    const profileB = participant.role === 'A' ? partnerReport.profile : ownReport.profile;
    const dimensionComparison = DIMENSIONS.map((dimension) => {
      const a = profileA[dimension.id];
      const b = profileB[dimension.id];
      const gap = a && b ? Math.round(Math.abs(a.average - b.average) * 10) / 10 : null;
      return {
        id: dimension.id,
        title: dimension.title,
        description: dimension.description,
        a: a?.average ?? null,
        b: b?.average ?? null,
        gap,
        match: gap === null ? 'Недостаточно данных' : gap <= 0.5 ? 'Близкие оценки' : gap <= 1.2 ? 'Есть различия' : 'Заметное расхождение',
      };
    });
    res.json({
      ownReport,
      partnerCompleted: true,
      partnerReport,
      comparison: {
        dimensionComparison,
        questions: compareAnswers(ownFirst, ownSecond),
        note: 'Сравнение показывает различия в самооценках, а не устанавливает, кто прав и кто любит сильнее.',
      },
    });
  } catch (error) {
    console.error('report_failed', error.message);
    res.status(500).json({ error: 'Не удалось сформировать отчёт.' });
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
