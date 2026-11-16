'use strict';

const app = document.getElementById('app');
const PARTNER_NAMES = { A: 'Василий', B: 'Полина' };
const DRAFT_PREFIX = 'mn-draft-v2-';
let questionSet;
let sessionToken = null;
let sessionInfo = null;
let answers = {};
let currentIndex = 0;
let consentAccepted = false;
let draftTimer = null;
let draftInFlight = Promise.resolve();
let lastDraftError = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const safeText = (value) => escapeHtml(value).replace(/\n/g, '<br>');
const draftKey = () => `${DRAFT_PREFIX}${sessionToken}-v${sessionInfo?.currentVersionNo || 1}`;
const loadDraft = () => {
  try {
    const stored = localStorage.getItem(draftKey());
    return stored ? JSON.parse(stored) : {};
  } catch (_) { return {}; }
};
const saveDraft = () => {
  try { localStorage.setItem(draftKey(), JSON.stringify(answers)); } catch (_) { /* optional local fallback */ }
  if (!sessionToken || !sessionInfo?.consented || sessionInfo?.ownCompleted) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const snapshot = JSON.stringify({ answers, versionNo: sessionInfo.currentVersionNo });
    draftInFlight = api(`/api/session/${encodeURIComponent(sessionToken)}/draft`, {
      method: 'PUT',
      body: snapshot,
    }).then(() => { lastDraftError = null; }).catch((error) => {
      lastDraftError = error;
      console.warn('Server draft save failed; local fallback remains available.', error);
    });
  }, 350);
};
const flushDraft = async () => {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = null;
  await draftInFlight;
  if (!sessionToken || !sessionInfo?.consented || sessionInfo?.ownCompleted) return;
  await api(`/api/session/${encodeURIComponent(sessionToken)}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ answers, versionNo: sessionInfo.currentVersionNo }),
  });
  lastDraftError = null;
};
const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка запроса (${response.status})`);
  return data;
};
const toast = (message, kind = 'error') => {
  const old = document.querySelector('.toast-message');
  if (old) old.remove();
  const node = document.createElement('div');
  node.className = `toast-message ${kind}`;
  node.textContent = message;
  Object.assign(node.style, {
    position: 'fixed', zIndex: '20', left: '50%', bottom: '22px', transform: 'translateX(-50%)',
    maxWidth: 'calc(100% - 32px)', padding: '12px 17px', borderRadius: '99px',
    background: kind === 'error' ? '#482a3b' : '#25392c', color: '#fff', fontSize: '12px',
    boxShadow: '0 10px 35px rgba(0,0,0,.35)', textAlign: 'center'
  });
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3600);
};

async function init() {
  try {
    questionSet = await fetch('/questions.json', { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('Не удалось загрузить вопросы.');
      return r.json();
    });
    const match = window.location.pathname.match(/^\/p\/([A-Za-z0-9_-]{32,100})\/?$/);
    if (match) {
      sessionToken = match[1];
      await loadParticipant();
    } else {
      renderHome();
    }
  } catch (error) {
    renderError(error.message || 'Не удалось открыть страницу.');
  }
}

function renderHome() {
  app.innerHTML = `
    <section class="hero">
      <div class="eyebrow">личное исследование для двоих</div>
      <h1>Между <em>нами</em></h1>
      <p class="hero-copy">Иногда чувства живут в словах. Но отношения становятся настоящими, когда два человека готовы услышать друг друга, быть честными и сделать шаг навстречу.</p>
      <div class="hero-divider"><span>♥</span></div>
    </section>
    <section class="people" aria-label="Участники">
      <article class="person-card optimist">
        <img src="/assets/optimist.webp" alt="Образ участника Василия" fetchpriority="high">
        <div class="person-meta"><small>участник A</small><strong>Василий</strong><span>свой взгляд на отношения</span></div>
      </article>
      <div class="between" aria-hidden="true">♡</div>
      <article class="person-card poison">
        <img src="/assets/file_00000000a98c8210bddc88a74eb95263.png" alt="Образ участницы Полины" fetchpriority="high">
        <div class="person-meta"><small>участник B</small><strong>Полина</strong><span>свой взгляд на отношения</span></div>
      </article>
    </section>
    <div class="feature-row">
      <span class="feature-pill"><b>125</b> вопросов всего</span>
      <span class="feature-pill"><b>60</b> о ваших отношениях</span>
      <span class="feature-pill"><b>8</b> тематических блоков</span>
      <span class="feature-pill"><b>2</b> личных отчёта</span>
      <span class="feature-pill"><b>1</b> общий взгляд</span>
    </div>
    <section class="panel start-panel">
      <div><h3>У каждого будет свой голос.</h3><p>Создайте закрытое пространство. Получите личную ссылку и отдельную ссылку-приглашение. Ответы откроются для сравнения только после того, как оба участника завершат анкету.</p></div>
      <button class="btn" id="create-room">Создать наше пространство <span>↗</span></button>
    </section>
    <div id="create-result-slot"></div>
    <p class="fine center" style="max-width:660px;margin:20px auto 0">Это не проверка на любовь и не психологический диагноз. Здесь нет правильных ответов или рейтинга пары — только ваши собственные ответы и то, где ваши взгляды совпадают или расходятся.</p>
  `;
  document.getElementById('create-room').addEventListener('click', createRoom);
}

async function createRoom(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Создаём пространство…';
  try {
    const data = await api('/api/rooms', { method: 'POST', body: '{}' });
    const slot = document.getElementById('create-result-slot');
    slot.innerHTML = `
      <section class="panel create-result">
        <div class="eyebrow">пространство создано</div>
        <h3>Теперь у каждого своя дверь.</h3>
        <p class="fine">Сначала открой личную ссылку Василия. Вторую отправь Полине. Ссылки работают как ключи доступа — не публикуй их и не пересылай посторонним.</p>
        <div class="link-row"><div class="link-info"><strong>Твоя личная ссылка · Василий</strong><span>${escapeHtml(data.participantUrl)}</span></div><button class="btn btn-secondary copy-link" data-copy="${escapeHtml(data.participantUrl)}">Скопировать</button></div>
        <div class="link-row"><div class="link-info"><strong>Приглашение · Полина</strong><span>${escapeHtml(data.inviteUrl)}</span></div><button class="btn copy-link" data-copy="${escapeHtml(data.inviteUrl)}">Скопировать ссылку</button></div>
        <div class="security-note">Ответы не показываются друг другу во время прохождения. После завершения обеих анкет общий отчёт станет доступен по обеим личным ссылкам. Сохрани обе ссылки.</div>
        <div style="margin-top:17px"><a class="btn" href="${escapeHtml(data.participantUrl)}">Перейти к своей анкете <span>→</span></a></div>
      </section>`;
    slot.querySelectorAll('.copy-link').forEach((copyButton) => copyButton.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(copyButton.dataset.copy); toast('Ссылка скопирована', 'success'); }
      catch (_) { toast('Не удалось скопировать автоматически. Нажми и удерживай ссылку, чтобы скопировать её вручную.'); }
    }));
    button.textContent = 'Пространство создано';
    slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Создать наше пространство ↗';
    toast(error.message);
  }
}

async function loadParticipant() {
  try {
    sessionInfo = await api(`/api/session/${encodeURIComponent(sessionToken)}`);
    consentAccepted = Boolean(sessionInfo.consented);
    if (sessionInfo.ownCompleted) {
      answers = sessionInfo.ownAnswers || {};
      await loadReport();
      return;
    }
    answers = sessionInfo.ownDraftAnswers || {};
    if (!Object.keys(answers).length) answers = loadDraft();
    const firstUnanswered = questionSet.questions.findIndex((question) => !validateAnswer(question, answers[String(question.id)]));
    currentIndex = firstUnanswered < 0 ? questionSet.questions.length - 1 : firstUnanswered;
    renderIntro();
  } catch (error) {
    renderError(error.message);
  }
}

function renderIntro() {
  const role = sessionInfo.role;
  app.innerHTML = `
    <div class="content-wrap">
      <div class="center" style="margin-bottom:18px"><span class="room-label"><i></i> закрытое пространство · участник ${role}</span></div>
      <header class="page-head"><div class="eyebrow">твой взгляд на отношения</div><h1>Привет, ${escapeHtml(sessionInfo.displayName)}.</h1><p>Здесь не нужно угадывать, что хочет услышать другой человек. Важно только то, что действительно думаешь и чувствуешь ты.</p></header>
      <section class="panel intro-card">
        <h2>Перед началом — несколько важных вещей</h2>
        <p>Анкета состоит из 125 обязательных вопросов: 60 о вашей связи, 50 о характере по пятифакторной модели Big Five и 15 о близости, страсти и обязательствах по модели треугольной любви. Прохождение разделено на смысловые части.</p>
        <div class="rule-list">
          <div class="rule-item"><span class="rule-icon">01</span><span>Отвечай самостоятельно, не обсуждая варианты с партнёром во время прохождения.</span></div>
          <div class="rule-item"><span class="rule-icon">02</span><span>Можно не знать точного ответа. В таком случае выбирай наиболее близкий вариант, а не тот, который выглядит правильным.</span></div>
          <div class="rule-item"><span class="rule-icon">03</span><span>После согласия сервер сохраняет черновик и журнал изменений ответов с датой и временем. Это позволяет восстановить прохождение после перезапуска; личный журнал доступен тебе в экспорте.</span></div>
          <div class="rule-item"><span class="rule-icon">04</span><span>Завершённая версия остаётся в истории. Повторное прохождение создаёт новую версию и не заменяет прежнюю. После завершения обеих анкет участники видят общий отчёт и ответы друг друга.</span></div>
          <div class="rule-item"><span class="rule-icon">05</span><span>Это авторский проект для саморефлексии, а не диагноз и не научно-нормированный тест совместимости. В отчёте будут указаны ограничения переводов и интерпретаций.</span></div>
        </div>
        <label class="consent-box"><input type="checkbox" id="consent" ${consentAccepted ? 'checked' : ''}><span>Я добровольно соглашаюсь на сохранение моих ответов и журнала их изменений в базе проекта. Администратор проекта технически имеет доступ к данным. После завершения обеих анкет финальные ответы станут доступны обоим участникам в общем отчёте. Я могу удалить свои ответы и историю.</span></label>
        <div class="intro-actions"><span class="fine">125 вопросов · ${currentIndex > 0 ? `продолжение с № ${currentIndex + 1}` : 'начало прохождения'}</span><button class="btn" id="start-quiz" ${consentAccepted ? '' : 'disabled'}>${currentIndex > 0 ? 'Продолжить' : 'Начать отвечать'} <span>→</span></button></div>
        ${consentAccepted ? '<div class="report-actions" style="margin-top:14px"><button class="btn btn-quiet" id="delete-my-data">Удалить мои ответы и историю</button></div>' : ''}
      </section>
    </div>`;
  const checkbox = document.getElementById('consent');
  const startButton = document.getElementById('start-quiz');
  checkbox.addEventListener('change', () => {
    consentAccepted = checkbox.checked;
    startButton.disabled = !consentAccepted;
  });
  document.getElementById('delete-my-data')?.addEventListener('click', deleteMyData);
  startButton.addEventListener('click', async () => {
    if (!checkbox.checked) return;
    startButton.disabled = true;
    startButton.textContent = 'Сохраняем согласие…';
    try {
      await api(`/api/session/${encodeURIComponent(sessionToken)}/consent`, {
        method: 'POST', body: JSON.stringify({ consent: true, versionNo: sessionInfo.currentVersionNo }),
      });
      sessionInfo.consented = true;
      consentAccepted = true;
      currentIndex = 0;
      renderQuestion();
    } catch (error) {
      startButton.disabled = false;
      startButton.innerHTML = 'Начать отвечать <span>→</span>';
      toast(error.message);
    }
  });
}

function currentQuestion() { return questionSet.questions[currentIndex]; }
function currentBlock(question) { return questionSet.blocks.find((block) => block.id === question.block); }
function validateAnswer(question, value) {
  if (question.type === 'scale') return Number.isInteger(value) && value >= 1 && value <= 5;
  if (question.type === 'single') return typeof value === 'string' && question.options.some((option) => option.value === value);
  if (question.type === 'text') return typeof value === 'string' && value.trim().length >= (question.minLength || 12);
  return false;
}

function renderQuestion() {
  const q = currentQuestion();
  const block = currentBlock(q);
  const progress = Math.round((currentIndex / questionSet.questions.length) * 100);
  const value = answers[String(q.id)];
  let controls = '';
  if (q.type === 'scale') {
    const scaleOptions = questionSet.scales?.[q.scaleType || 'default'] || questionSet.scale;
    controls = `<div class="scale-list">${scaleOptions.map((option) => `
      <button class="scale-option ${value === option.value ? 'selected' : ''}" data-scale="${option.value}" aria-pressed="${value === option.value}">
        <strong>${option.value}</strong><span>${escapeHtml(option.label)}</span>
      </button>`).join('')}</div>`;
  } else if (q.type === 'text') {
    controls = `<textarea class="text-answer" id="text-answer" maxlength="3000" placeholder="Напиши так, как есть…">${escapeHtml(value || '')}</textarea><div class="answer-hint">Ответ обязателен · не менее ${q.minLength || 12} символов. ${escapeHtml(q.hint || '')}</div>`;
  } else {
    controls = `<div class="choice-list">${q.options.map((option) => `
      <button class="choice-option ${value === option.value ? 'selected' : ''}" data-choice="${escapeHtml(option.value)}" aria-pressed="${value === option.value}">
        <span class="choice-radio"></span><span>${escapeHtml(option.label)}</span>
      </button>`).join('')}</div>`;
  }

  app.innerHTML = `
    <div class="content-wrap">
      <div class="quiz-top">
        <div class="quiz-topline"><span class="quiz-block">${escapeHtml(block.title)}</span><span class="quiz-counter">ВОПРОС ${String(q.id).padStart(3,'0')} / ${questionSet.questions.length}</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${Math.max(2, progress)}%"></div></div>
      </div>
      <section class="panel question-card" key="q-${q.id}">
        <div class="question-kicker"><span>${escapeHtml(block.subtitle)}</span><span class="question-number">${String(q.id).padStart(2,'0')}</span></div>
        <h2>${escapeHtml(q.text)}</h2>
        ${controls}
        <div id="question-error" class="question-error"></div>
      </section>
      <div class="quiz-nav">
        <button class="nav-back" id="previous" ${currentIndex === 0 ? 'disabled' : ''}>← Назад</button>
        <button class="btn" id="next">${currentIndex === questionSet.questions.length - 1 ? 'Завершить анкету' : 'Следующий вопрос'} <span>→</span></button>
      </div>
      <div class="autosave">Черновик автоматически сохраняется в защищённом серверном хранилище</div>
    </div>`;

  app.querySelectorAll('[data-scale]').forEach((button) => button.addEventListener('click', () => {
    answers[String(q.id)] = Number(button.dataset.scale);
    saveDraft();
    renderQuestion();
  }));
  app.querySelectorAll('[data-choice]').forEach((button) => button.addEventListener('click', () => {
    answers[String(q.id)] = button.dataset.choice;
    saveDraft();
    renderQuestion();
  }));
  const textarea = document.getElementById('text-answer');
  if (textarea) textarea.addEventListener('input', () => {
    answers[String(q.id)] = textarea.value;
    saveDraft();
  });
  document.getElementById('previous').addEventListener('click', () => {
    if (currentIndex > 0) { currentIndex -= 1; renderQuestion(); }
  });
  document.getElementById('next').addEventListener('click', async () => {
    const currentValue = answers[String(q.id)];
    if (!validateAnswer(q, currentValue)) {
      const msg = q.type === 'text' ? `Добавь ответ длиной не менее ${q.minLength || 12} символов.` : 'Выбери один из вариантов ответа.';
      document.getElementById('question-error').textContent = msg;
      if (textarea) textarea.focus();
      else app.querySelector('.scale-option, .choice-option')?.focus();
      return;
    }
    try {
      await flushDraft();
      if (currentIndex < questionSet.questions.length - 1) {
        currentIndex += 1;
        renderQuestion();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        await submitAnswers();
      }
    } catch (error) {
      document.getElementById('question-error').textContent = 'Не удалось сохранить черновик. Проверь интернет и повтори попытку.';
      toast(error.message);
    }
  });
}

async function submitAnswers() {
  const button = document.getElementById('next');
  button.disabled = true;
  button.textContent = 'Сохраняем 125 ответов…';
  try {
    await flushDraft();
    await api(`/api/session/${encodeURIComponent(sessionToken)}/submit`, {
      method: 'POST', body: JSON.stringify({ answers, consent: true, versionNo: sessionInfo.currentVersionNo }),
    });
    try { localStorage.removeItem(draftKey()); } catch (_) {}
    await loadParticipant();
  } catch (error) {
    button.disabled = false;
    button.innerHTML = 'Завершить анкету <span>→</span>';
    toast(error.message);
  }
}

async function loadReport() {
  try {
    const report = await api(`/api/report/${encodeURIComponent(sessionToken)}`);
    renderReport(report);
  } catch (error) {
    renderError(error.message);
  }
}

function metricCard(dimension, profile) {
  const metric = profile[dimension.id];
  if (!metric) return '';
  return `<article class="metric-card">
    <div class="metric-head"><strong>${escapeHtml(dimension.title)}</strong><span class="metric-value">${metric.average.toFixed(1)}<small style="font:10px var(--sans);color:var(--muted-2)"> / 5</small></span></div>
    <p>${escapeHtml(dimension.description)}</p>
    <div class="meter"><span style="width:${metric.average * 20}%"></span></div>
    <div class="metric-foot"><span>${escapeHtml(metric.interpretation)}</span><span>${metric.count} пунктов</span></div>
  </article>`;
}

function renderMetricSections(profile) {
  const groups = [
    { id: 'relationship', title: 'Ваше восприятие отношений' },
    { id: 'personality', title: 'Психологический портрет · Big Five' },
    { id: 'love', title: 'Три грани любви · TLS-15' },
  ];
  return groups.map((group) => {
    const dimensions = questionSet.dimensions.filter((dimension) => dimension.group === group.id);
    return `<section class="report-section">
      <h3 class="report-title" style="font-size:23px">${escapeHtml(group.title)}</h3>
      <div class="report-grid">${dimensions.map((dimension) => metricCard(dimension, profile)).join('')}</div>
    </section>`;
  }).join('');
}

function renderPersonalAnswers(answersObj) {
  return questionSet.questions.map((q) => {
    const value = answersObj[String(q.id)];
    let label = value;
    if (q.type === 'single') label = q.options.find((option) => option.value === value)?.label || value;
    if (q.type === 'scale') {
      const scale = questionSet.scales?.[q.scaleType || 'default'] || questionSet.scale;
      label = `${value} / 5 · ${scale.find((option) => option.value === value)?.label || ''}`;
    }
    return `<div class="answer-review"><strong>${String(q.id).padStart(3,'0')}. ${escapeHtml(q.text)}</strong><p>${safeText(label)}</p></div>`;
  }).join('');
}

function renderPersonalAnswers(answersObj) {
  const selectedIds = [1, 10, 20, 21, 30, 36, 47, 49, 56, 57, 59, 60];
  return selectedIds.map((id) => {
    const q = questionSet.questions.find((item) => item.id === id);
    const value = answersObj[String(id)];
    const label = q.type === 'single' ? (q.options.find((o) => o.value === value)?.label || value) : value;
    return `<div class="answer-review"><strong>${String(id).padStart(2,'0')}. ${escapeHtml(q.text)}</strong><p>${safeText(label)}</p></div>`;
  }).join('');
}

function comparisonRows(items) {
  if (!items?.length) return '<p class="fine">Нет данных для сравнения.</p>';
  return items.map((item) => `
    <div class="comparison-row">
      <div class="comparison-name"><strong>${escapeHtml(item.title)}</strong><span class="match-tag">${escapeHtml(item.match)}</span></div>
      <div class="dual-bars">
        <div class="dual-line"><span>Василий</span><div class="meter"><span style="width:${(item.a || 0) * 20}%"></span></div><b>${item.a === null ? '—' : item.a.toFixed(1)}</b></div>
        <div class="dual-line"><span>Полина</span><div class="meter"><span class="meter-b" style="width:${(item.b || 0) * 20}%"></span></div><b>${item.b === null ? '—' : item.b.toFixed(1)}</b></div>
      </div>
    </div>`).join('');
}

function personalityRows(personality) {
  return personality.traits.map((item) => `
    <article class="trait-compare">
      <div class="comparison-name"><strong>${escapeHtml(item.title)}</strong><span class="match-tag">${escapeHtml(item.classification)}</span></div>
      <div class="dual-bars">
        <div class="dual-line"><span>Василий</span><div class="meter"><span style="width:${(item.a || 0) * 20}%"></span></div><b>${item.a === null ? '—' : item.a.toFixed(1)}</b></div>
        <div class="dual-line"><span>Полина</span><div class="meter"><span class="meter-b" style="width:${(item.b || 0) * 20}%"></span></div><b>${item.b === null ? '—' : item.b.toFixed(1)}</b></div>
      </div>
      <p>${escapeHtml(item.possibleDynamic)}</p>
    </article>`).join('');
}



function questionDifferenceItems(items) {
  if (!items?.length) return '<p class="fine">В этом разделе нет заметных различий в выбранных ответах.</p>';
  return `<div class="compare-list">${items.map((item) => `
    <article class="compare-item"><h4>${String(item.id).padStart(2,'0')}. ${escapeHtml(item.text)}</h4>
      <div class="compare-answer"><div><strong>Василий</strong>${typeof item.a === 'number' ? `${item.a} из 5` : escapeHtml(item.a)}</div><div><strong>Полина</strong>${typeof item.b === 'number' ? `${item.b} из 5` : escapeHtml(item.b)}</div></div>
    </article>`).join('')}</div>`;
}

function renderComparison(report) {
  const comparison = report.comparison;
  const questions = comparison.questions;
  const personality = comparison.personality;
  const biggestPersonalityDifferences = personality.different.map((item) => item.title);
  const closeTraits = personality.similar.map((item) => item.title);
  const traitSummary = `
    <div class="compat-summary">
      <div class="summary-tile"><span>Похожие оценки</span><strong>${closeTraits.length}</strong><small>${closeTraits.length ? escapeHtml(closeTraits.join(' · ')) : 'Явных совпадений по чертам нет'}</small></div>
      <div class="summary-tile"><span>Выраженные различия</span><strong>${biggestPersonalityDifferences.length}</strong><small>${biggestPersonalityDifferences.length ? escapeHtml(biggestPersonalityDifferences.join(' · ')) : 'Нет больших разрывов'}</small></div>
    </div>`;
  return `
    <section class="report-section">
      <div class="eyebrow">два взгляда рядом</div><h2 class="report-title">Общий сравнительный отчёт</h2>
      <p class="report-subtitle">Здесь не будет искусственного процента «совместимости». Мы сравниваем отдельные области, чтобы было видно, где вы похожи, где различаетесь и что можно обсудить.</p>

      <section class="report-section">
        <h3 class="report-title" style="font-size:25px">Характер и совместимость</h3>
        <p class="report-subtitle">Пять черт Big Five. Близкие оценки означают сходство самоописания, а не автоматическую гарантию гармонии. Различия не являются недостатком: важнее то, как вы договариваетесь.</p>
        ${traitSummary}
        <div class="panel comparison-card personality-card">${personalityRows(personality)}</div>
        <div class="report-note">${escapeHtml(personality.note)}</div>
      </section>

      <section class="report-section">
        <h3 class="report-title" style="font-size:25px">Романтическая связь и влечение</h3>
        <p class="report-subtitle">Три компонента TLS-15 — близость, страсть и обязательство. Профили могут быть разными: важно не только наличие чувств, но и то, одинаково ли вы воспринимаете их интенсивность.</p>
        <div class="panel comparison-card">${comparisonRows(comparison.love)}</div>
      </section>

      <section class="report-section">
        <h3 class="report-title" style="font-size:25px">Совместимость в реальных отношениях</h3>
        <p class="report-subtitle">Доверие, взаимность, инициатива, встреча и взгляд на будущее.</p>
        <div class="panel comparison-card">${comparisonRows(comparison.relationship)}</div>
      </section>

      <section class="report-section">
        <h3 class="report-title" style="font-size:23px">Ответы, в которых вы разошлись</h3>
        <p class="report-subtitle">Самые заметные расхождения по отдельным утверждениям и прямым выборам.</p>
        ${questionDifferenceItems(questions.numericGaps.filter((item) => item.gap > 1).slice(0,12))}
        ${questionDifferenceItems(questions.differentChoices)}
      </section>

      <section class="report-section">
        <h3 class="report-title" style="font-size:23px">Ваши ответы своими словами</h3>
        <p class="report-subtitle">Текстовые ответы не оцениваются баллами. Их смысл лучше обсуждать, а не превращать в рейтинг.</p>
        <div class="compare-list">${questions.writtenAnswers.map((item) => `<article class="compare-item"><h4>${String(item.id).padStart(3,'0')}. ${escapeHtml(item.text)}</h4><div class="text-pair"><div><b>Василий</b>${safeText(item.a)}</div><div><b>Полина</b>${safeText(item.b)}</div></div></article>`).join('')}</div>
      </section>
      <div class="report-note">${escapeHtml(comparison.note)}</div>
    </section>`;
}

function renderAttemptHistory(history) {
  if (!history || history.length <= 1) return '';
  return `<details class="report-section"><summary>История предыдущих прохождений (${history.length})</summary>
    <div class="details-body attempt-history">${history.map((item) => {
      const date = new Date(item.completed_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
      return `<div class="attempt-row"><strong>Версия ${item.version_no}</strong><span>${escapeHtml(date)}</span><small>${item.edits} изменений ответов в черновике</small></div>`;
    }).join('')}</div>
  </details>`;
}

async function startNewAttempt() {
  if (!window.confirm('Начать новое прохождение? Предыдущие завершённые ответы и история останутся сохранены как отдельная версия.')) return;
  try {
    const result = await api(`/api/session/${encodeURIComponent(sessionToken)}/new-attempt`, {
      method: 'POST', body: JSON.stringify({ versionNo: sessionInfo.currentVersionNo }),
    });
    try { localStorage.removeItem(draftKey()); } catch (_) {}
    sessionInfo.currentVersionNo = result.versionNo;
    sessionInfo.consented = false;
    sessionInfo.ownCompleted = false;
    consentAccepted = false;
    answers = {};
    currentIndex = 0;
    renderIntro();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    toast(error.message);
  }
}

async function deleteMyData() {
  const first = window.confirm('Удалить все твои черновики, завершённые версии и журнал изменений? Это действие нельзя отменить.');
  if (!first) return;
  const second = window.confirm('Подтверди ещё раз: удалить именно твои ответы и историю из этого пространства?');
  if (!second) return;
  try {
    await api(`/api/session/${encodeURIComponent(sessionToken)}/data`, { method: 'DELETE' });
    try {
      const prefix = `${DRAFT_PREFIX}${sessionToken}`;
      Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key));
    } catch (_) {}
    sessionToken = null;
    sessionInfo = null;
    answers = {};
    renderHome();
    toast('Твои ответы и журнал удалены.', 'success');
  } catch (error) {
    toast(error.message);
  }
}



function downloadReport(report) {
  const payload = {
    project: 'Между нами',
    questionnaireVersion: questionSet.version,
    exportedAt: new Date().toISOString(),
    participant: sessionInfo.displayName,
    personalReport: report.ownReport,
    partnerReport: report.partnerReport || null,
    comparativeReport: report.comparison,
    partnerCompleted: report.partnerCompleted,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Между-нами-${sessionInfo.displayName.toLowerCase()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderReport(report) {
  const own = report.ownReport;
  const profileSections = renderMetricSections(own.profile);
  const completed = new Date(own.completedAt).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
  const commonActions = `
    ${renderAttemptHistory(own.history)}
    <div class="report-actions">
      <button class="btn btn-secondary" id="new-attempt">Пройти заново · новая версия</button>
      <button class="btn btn-quiet" id="delete-my-data">Удалить мои ответы и историю</button>
    </div>`;
  if (!report.partnerCompleted) {
    app.innerHTML = `
      <div class="content-wrap">
        <div class="page-head"><div class="eyebrow">твой взгляд сохранён</div><h1>Твоя история <em style="color:var(--gold-bright)">зафиксирована.</em></h1><p>Ты ответил(а) на все 125 вопросов. Личный профиль уже сформирован. Общая картина появится, когда второй участник завершит свою анкету.</p><span class="room-label" style="margin-top:15px"><i></i> ${escapeHtml(own.participant)} · версия ${own.versionNo} · ${escapeHtml(completed)}</span></div>
        ${profileSections}
        <section class="panel waiting-card report-section"><div class="waiting-heart">♥</div><h2>Теперь очередь второго взгляда</h2><p>Общий сравнительный отчёт откроется автоматически после завершения второй анкеты. Вернись по своей ссылке позже — твоя завершённая версия останется в истории.</p><button class="btn btn-secondary" id="refresh-report">Проверить вторую анкету</button></section>
        <details class="report-section"><summary>Все мои ответы · 125 вопросов</summary><div class="details-body report-answers">${renderPersonalAnswers(own.answers)}</div></details>
        <div class="report-actions"><button class="btn" id="print-report">Сохранить личный отчёт в PDF</button><button class="btn btn-secondary" id="download-report">Экспортировать ответы JSON</button></div>
        ${commonActions}
        <div class="report-note">Ответы другого участника пока скрыты. После его согласованного завершения оба получат доступ к общему сравнительному отчёту. IPIP и TLS-15 здесь используются как описательные инструменты; русские формулировки не являются отдельной клинической диагностикой.</div>
      </div>`;
  } else {
    const partner = report.partnerReport;
    app.innerHTML = `
      <div class="content-wrap">
        <div class="page-head"><div class="eyebrow">оба взгляда собраны</div><h1>Теперь видно <em style="color:var(--gold-bright)">между вами.</em></h1><p>Две самостоятельные анкеты завершены. Ниже — личный портрет, характер, влечение, совпадения и темы, в которых ваши взгляды расходятся.</p><span class="room-label" style="margin-top:15px"><i></i> ${escapeHtml(own.participant)} · версия ${own.versionNo} &nbsp; + &nbsp; ${escapeHtml(partner.participant)} · версия ${partner.versionNo}</span></div>
        ${profileSections}
        ${renderComparison(report)}
        <details class="report-section"><summary>Все мои ответы · 125 вопросов</summary><div class="details-body report-answers">${renderPersonalAnswers(own.answers)}</div></details>
        ${commonActions}
        <div class="report-actions"><button class="btn" id="print-report">Сохранить отчёт в PDF</button><button class="btn btn-secondary" id="download-report">Экспортировать JSON</button></div>
        <div class="report-note">У каждого участника есть личная ссылка. Не публикуйте её: она открывает сохранённые ответы и отчёты. Оценки отражают самоописание и самооценку; они не доказывают любовь, не предсказывают будущее и не заменяют разговор.</div>
      </div>`;
  }
  document.getElementById('refresh-report')?.addEventListener('click', loadReport);
  document.getElementById('print-report')?.addEventListener('click', () => window.print());
  document.getElementById('download-report')?.addEventListener('click', () => downloadReport(report));
  document.getElementById('new-attempt')?.addEventListener('click', startNewAttempt);
  document.getElementById('delete-my-data')?.addEventListener('click', deleteMyData);
}


function renderError(message) {
  app.innerHTML = `<div class="content-wrap"><section class="panel waiting-card"><div class="waiting-heart">♡</div><h2>Не получилось открыть пространство</h2><p>${escapeHtml(message || 'Проверь ссылку и попробуй ещё раз.')}</p><a class="btn btn-secondary" href="/">На главную</a></section></div>`;
}

init();
