'use strict';
(() => {
  const root = document.getElementById("app");
  const tokenMatch = location.pathname.match(/^\/p\/([A-Za-z0-9_-]{32,100})\/intimacy\/?$/);
  const token = tokenMatch ? tokenMatch[1] : null;
  const API = "/api/intimacy/" + encodeURIComponent(token || "");
  const state = { data:null, session:null, answers:{}, index:0, timer:null, pending:Promise.resolve() };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const safe = (v) => esc(v).replace(/\n/g,"<br>");
  const req = async (url, options) => {
    const res = await fetch(url, {...(options || {}), headers:{"Content-Type":"application/json",...((options && options.headers) || {})}});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Ошибка запроса (" + res.status + ")");
    return data;
  };
  const toast = (message, success) => {
    const old = document.querySelector(".toast-message"); if (old) old.remove();
    const el = document.createElement("div"); el.className = "toast-message " + (success ? "success" : "error"); el.textContent = message;
    Object.assign(el.style,{position:"fixed",zIndex:"20",left:"50%",bottom:"22px",transform:"translateX(-50%)",maxWidth:"calc(100% - 32px)",padding:"12px 17px",borderRadius:"99px",background:success?"#25392c":"#482a3b",color:"#fff",fontSize:"12px",boxShadow:"0 10px 35px rgba(0,0,0,.35)",textAlign:"center"});
    document.body.appendChild(el); setTimeout(() => el.remove(),3500);
  };
  const qs = () => state.data.questions;
  const key = (q) => String(q.id);
  const current = () => qs()[state.index];
  const block = (q) => state.data.blocks.find((b) => b.id === q.block);
  const prompt = (q) => q.text[state.session.role];

  function valid(q,a) {
    if (!a || typeof a !== "object") return false;
    if (a.skipped === true) return true;
    if (!["shared","private"].includes(a.visibility)) return false;
    if (q.type === "scale") return Number.isInteger(a.value) && a.value >= 1 && a.value <= 5;
    if (q.type === "single") return typeof a.value === "string" && q.options.some((o) => o.value === a.value);
    if (q.type === "multi") return Array.isArray(a.value) && a.value.length > 0 && (!q.maxSelections || a.value.length <= q.maxSelections) && new Set(a.value).size === a.value.length && a.value.every((v) => q.options.some((o) => o.value === v));
    if (q.type === "text") return typeof a.value === "string" && a.value.trim().length >= (q.minLength || 5);
    if (q.type === "practice") {
      const f = state.data.practiceFields;
      return f.experience.some((o) => o.value === a.experience) && f.desire.some((o) => o.value === a.desire) && Number.isInteger(a.comfort) && a.comfort >= 1 && a.comfort <= 5;
    }
    return false;
  }
  function savable() {
    const out = {};
    qs().forEach((q) => { const a = state.answers[key(q)]; if (valid(q,a)) out[key(q)] = a; });
    return out;
  }
  function save() {
    if (!state.session || !state.session.consented || state.session.completed) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.pending = req(API + "/draft",{method:"PUT",body:JSON.stringify({answers:savable()})}).catch((e) => { console.warn("Intimacy draft save failed",e); toast("Черновик пока не сохранился. Проверь соединение."); });
    },450);
  }
  async function flush() {
    clearTimeout(state.timer); state.timer = null; await state.pending;
    if (state.session && state.session.consented && !state.session.completed) await req(API + "/draft",{method:"PUT",body:JSON.stringify({answers:savable()})});
  }
  function styles() {
    if (document.getElementById("intimacy-styles")) return;
    const s = document.createElement("style"); s.id = "intimacy-styles";
    s.textContent = ".intimacy-hero{text-align:center;padding:24px 0 18px}.intimacy-hero h1{font-family:var(--serif);font-weight:500;font-size:clamp(38px,8vw,62px);margin:8px 0}.intimacy-hero em{color:var(--gold-bright)}.intimacy-copy{max-width:690px;margin:0 auto;color:var(--muted);font-size:12px;line-height:1.8}.intimacy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:20px 0}.intimacy-block{border:1px solid var(--line);border-radius:14px;padding:14px;background:rgba(255,255,255,.025)}.intimacy-block strong{display:block;font-size:11px;margin-bottom:5px}.intimacy-block span{color:var(--muted-2);font-size:9px;line-height:1.5}.intimacy-field{display:grid;gap:7px;margin:13px 0}.intimacy-field label{font-size:10px;color:var(--muted)}.intimacy-field select{width:100%;background:#171522;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:13px;font:inherit;font-size:12px}.intimacy-multi{display:grid;gap:8px}.intimacy-option{display:flex;align-items:center;gap:10px;text-align:left;min-height:48px;border:1px solid var(--line);border-radius:12px;padding:11px 13px;background:rgba(255,255,255,.025);color:var(--text);font-size:11px;line-height:1.5}.intimacy-option.selected{border-color:var(--gold);background:rgba(217,185,120,.1);color:#fff2d7}.intimacy-option input{accent-color:var(--gold)}.intimacy-privacy{display:flex;align-items:flex-start;gap:10px;margin-top:20px;padding:13px;border:1px solid var(--line);border-radius:13px;color:var(--muted);font-size:10px;line-height:1.6}.intimacy-privacy input{margin-top:2px;accent-color:var(--gold)}.intimacy-private-tag{display:inline-block;border:1px solid rgba(217,155,180,.35);border-radius:99px;padding:3px 7px;color:#e6aebe;font-size:8px;margin-left:6px}.intimacy-report-card{border:1px solid var(--line);border-radius:15px;padding:15px;background:rgba(255,255,255,.025);margin:10px 0}.intimacy-report-card h4{font-size:11px;line-height:1.6;margin:0 0 9px;color:#eee5db}.intimacy-answer-pair{display:grid;grid-template-columns:1fr 1fr;gap:9px}.intimacy-answer-pair>div{background:rgba(0,0,0,.15);padding:10px;border-radius:10px;color:var(--muted);font-size:10px;line-height:1.7;overflow-wrap:anywhere}.intimacy-answer-pair b{display:block;color:var(--gold);font-size:9px;margin-bottom:4px}.intimacy-stat{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.intimacy-stat span{border:1px solid var(--line);border-radius:99px;padding:7px 10px;color:var(--muted);font-size:9px}.intimacy-report-head{font-family:var(--serif);font-size:25px;font-weight:500;margin:25px 0 10px}.intimacy-note{border-left:2px solid var(--rose);padding:11px 14px;background:rgba(217,155,180,.06);color:#c9bdca;font-size:10px;line-height:1.75;margin-top:15px}@media(max-width:700px){.intimacy-grid,.intimacy-answer-pair{grid-template-columns:1fr}}";
    document.head.appendChild(s);
  }
  function renderIntro() {
    root.innerHTML = '<div class="content-wrap"><div class="center" style="margin-bottom:16px"><a class="fine" href="/p/'+esc(token)+'">← Вернуться к первому тесту</a></div><section class="intimacy-hero"><div class="eyebrow">второй модуль · только для взрослых</div><h1>Между нами <em>18+</em></h1><p class="intimacy-copy">Откровенный разговор о сексуальных желаниях, опыте, фантазиях, предпочтениях и границах. Здесь нет правильных ответов и нет обязанности пробовать то, что не подходит.</p></section><section class="panel intro-card"><h2>Перед началом</h2><p>Анкета состоит из '+qs().length+' вопросов в десяти тематических блоках. В некоторых вопросах отдельно спрашиваются опыт, желание и комфорт — это разные вещи. Любой вопрос можно пропустить.</p><div class="intimacy-grid">'+state.data.blocks.map((b)=>'<div class="intimacy-block"><strong>'+esc(b.title)+'</strong><span>'+esc(b.subtitle)+'</span></div>').join("")+'</div><div class="rule-list"><div class="rule-item"><span class="rule-icon">01</span><span>Отвечай только за себя. Фантазия не означает согласие воплощать её в реальности.</span></div><div class="rule-item"><span class="rule-icon">02</span><span>Любой ответ можно сделать приватным. Он останется в твоём личном отчёте и не попадёт в общий анализ.</span></div><div class="rule-item"><span class="rule-icon">03</span><span>Общие ответы будут доступны обоим только после завершения обеих анкет. Пропущенные и приватные ответы не сравниваются.</span></div><div class="rule-item"><span class="rule-icon">04</span><span>Ответы сохраняются на сервере. Технический администратор проекта может иметь доступ к данным. Не указывай сведения, которые не готов(а) хранить в этом проекте.</span></div><div class="rule-item"><span class="rule-icon">05</span><span>Интимные фотографии и видео здесь не загружаются. Не отправляйте их через ответы анкеты.</span></div></div><label class="consent-box"><input type="checkbox" id="intimacy-consent" '+(state.session.consented?"checked":"")+'><span>Мне исполнилось 18 лет. Я добровольно соглашаюсь на отдельное сохранение моих ответов в интимном модуле и понимаю, что только ответы, помеченные мной как общие, будут доступны партнёру после завершения обеих анкет. Я могу удалить свои ответы этого модуля отдельно.</span></label><div class="intro-actions"><span class="fine">'+qs().length+' вопросов · '+(state.session.consented?"согласие уже сохранено":"отдельное согласие обязательно")+'</span><button class="btn" id="intimacy-start" '+(state.session.consented?"":"disabled")+'>'+(Object.keys(state.session.draftAnswers||{}).length?"Продолжить":"Начать отвечать")+' <span>→</span></button></div></section></div>';
    const checkbox=document.getElementById("intimacy-consent"),button=document.getElementById("intimacy-start");
    checkbox.addEventListener("change",()=>{button.disabled=!checkbox.checked;});
    button.addEventListener("click",async()=>{
      if(!checkbox.checked)return;button.disabled=true;button.textContent="Сохраняем согласие…";
      try{if(!state.session.consented)await req(API+"/consent",{method:"POST",body:JSON.stringify({consent:true})});state.session.consented=true;
        const first=qs().findIndex((q)=>!valid(q,state.answers[key(q)]));state.index=first<0?qs().length-1:first;renderQuestion();
      }catch(e){button.disabled=false;button.innerHTML='Начать отвечать <span>→</span>';toast(e.message);}
    });
  }
  function choice(label,value,selected,attr){return '<button type="button" class="intimacy-option '+(selected?"selected":"")+'" '+attr+'="'+esc(value)+'" aria-pressed="'+selected+'">'+esc(label)+'</button>';}
  function controls(q,a) {
    const visibility=a.visibility||"shared";let html="";
    if(q.type==="scale")html='<div class="scale-list">'+state.data.scale.map((o)=>'<button type="button" class="scale-option '+(a.value===o.value?"selected":"")+'" data-scale="'+o.value+'" aria-pressed="'+(a.value===o.value)+'"><strong>'+o.value+'</strong><span>'+esc(o.label)+'</span></button>').join("")+'</div>';
    else if(q.type==="single")html='<div class="intimacy-multi">'+q.options.map((o)=>choice(o.label,o.value,a.value===o.value,"data-single")).join("")+'</div>';
    else if(q.type==="multi"){const vals=Array.isArray(a.value)?a.value:[];html='<div class="intimacy-multi">'+q.options.map((o)=>'<label class="intimacy-option '+(vals.includes(o.value)?"selected":"")+'"><input type="checkbox" data-multi="'+esc(o.value)+'" '+(vals.includes(o.value)?"checked":"")+'> '+esc(o.label)+'</label>').join("")+'</div>'+(q.maxSelections?'<div class="answer-hint">Можно выбрать не более '+q.maxSelections+' вариантов.</div>':"");}
    else if(q.type==="text")html='<textarea class="text-answer" id="intimacy-text" maxlength="3000" placeholder="Напиши так, как есть…">'+esc(a.value||"")+'</textarea><div class="answer-hint">Ответ можно оставить приватным. Минимум '+(q.minLength||5)+' символов.</div>';
    else if(q.type==="practice"){
      const f=state.data.practiceFields;
      const select=(id,label,opts,val)=>'<div class="intimacy-field"><label for="practice-'+id+'">'+label+'</label><select id="practice-'+id+'" data-practice="'+id+'"><option value="">Выбери ответ</option>'+opts.map((o)=>'<option value="'+esc(o.value)+'" '+(String(val??"")===String(o.value)?"selected":"")+'>'+esc(o.label)+'</option>').join("")+'</select></div>';
      html=select("experience","Опыт",f.experience,a.experience)+select("desire","Твоё желание",f.desire,a.desire)+select("comfort","Насколько это для тебя комфортно",f.comfort,a.comfort);
    }
    return html+'<label class="intimacy-privacy"><input type="checkbox" id="intimacy-private" '+(visibility==="private"?"checked":"")+'><span><strong>Оставить этот ответ только в моём личном отчёте.</strong><br>Он не будет показан партнёру и не попадёт в совместное сравнение.</span></label>';
  }
  function renderQuestion() {
    const q=current(),b=block(q),a=state.answers[key(q)]||{visibility:"shared"},progress=Math.round(state.index/qs().length*100);
    root.innerHTML='<div class="content-wrap"><div class="quiz-top"><div class="quiz-topline"><span class="quiz-block">'+esc(b.title)+'</span><span class="quiz-counter">ВОПРОС '+String(q.id).padStart(2,"0")+' / '+qs().length+'</span></div><div class="progress-track"><div class="progress-fill" style="width:'+Math.max(2,progress)+'%"></div></div></div><section class="panel question-card"><div class="question-kicker"><span>'+esc(b.subtitle)+'</span><span class="question-number">'+String(q.id).padStart(2,"0")+'</span></div><h2>'+esc(prompt(q))+'</h2>'+controls(q,a)+'<div id="intimacy-error" class="question-error"></div></section><div class="quiz-nav"><button class="nav-back" id="intimacy-back" '+(state.index===0?"disabled":"")+'>← Назад</button><button class="btn btn-secondary" id="intimacy-skip">Пропустить</button><button class="btn" id="intimacy-next">'+(state.index===qs().length-1?"Завершить":"Далее")+' <span>→</span></button></div><div class="autosave">Ответы сохраняются автоматически · приватность задаётся для каждого вопроса</div></div>';
    const visibility=(obj)=>{obj.visibility=document.getElementById("intimacy-private").checked?"private":"shared";state.answers[key(q)]=obj;save();};
    root.querySelectorAll("[data-scale]").forEach((btn)=>btn.addEventListener("click",()=>{const old=state.answers[key(q)]||{visibility:"shared"};state.answers[key(q)]={value:Number(btn.dataset.scale),visibility:old.visibility||"shared"};save();renderQuestion();}));
    root.querySelectorAll("[data-single]").forEach((btn)=>btn.addEventListener("click",()=>{const old=state.answers[key(q)]||{visibility:"shared"};state.answers[key(q)]={value:btn.dataset.single,visibility:old.visibility||"shared"};save();renderQuestion();}));
    root.querySelectorAll("[data-multi]").forEach((input)=>input.addEventListener("change",()=>{const old=state.answers[key(q)]||{visibility:"shared"},vals=new Set(Array.isArray(old.value)?old.value:[]);if(input.checked)vals.add(input.dataset.multi);else vals.delete(input.dataset.multi);const next=Array.from(vals);if(q.maxSelections&&next.length>q.maxSelections){input.checked=false;toast("Можно выбрать не более "+q.maxSelections+" вариантов.");return;}state.answers[key(q)]={value:next,visibility:old.visibility||"shared"};save();renderQuestion();}));
    root.querySelectorAll("[data-practice]").forEach((sel)=>sel.addEventListener("change",()=>{const old=state.answers[key(q)]||{visibility:"shared"},next={...old};if(sel.dataset.practice==="comfort")next.comfort=Number(sel.value);else next[sel.dataset.practice]=sel.value;state.answers[key(q)]=next;save();}));
    const ta=document.getElementById("intimacy-text");if(ta)ta.addEventListener("input",()=>{const old=state.answers[key(q)]||{visibility:"shared"};state.answers[key(q)]={value:ta.value,visibility:old.visibility||"shared"};save();});
    document.getElementById("intimacy-private").addEventListener("change",()=>{const old=state.answers[key(q)]||{visibility:"shared"};visibility(old);});
    document.getElementById("intimacy-back").addEventListener("click",()=>{if(state.index>0){state.index--;renderQuestion();}});
    document.getElementById("intimacy-skip").addEventListener("click",async()=>{state.answers[key(q)]={skipped:true};save();await advance();});
    document.getElementById("intimacy-next").addEventListener("click",async()=>{if(!valid(q,state.answers[key(q)])){document.getElementById("intimacy-error").textContent=q.type==="text"?"Добавь ответ или пропусти вопрос.":q.type==="practice"?"Заполни опыт, желание и комфорт или пропусти вопрос.":"Выбери ответ или пропусти вопрос.";return;}await advance();});
  }
  async function advance() {
    try{await flush();if(state.index<qs().length-1){state.index++;renderQuestion();window.scrollTo({top:0,behavior:"smooth"});}else await submit();}
    catch(e){const el=document.getElementById("intimacy-error");if(el)el.textContent="Не удалось сохранить ответы. Проверь интернет и повтори попытку.";toast(e.message);}
  }
  async function submit() {
    const btn=document.getElementById("intimacy-next");if(btn){btn.disabled=true;btn.textContent="Сохраняем ответы…";}
    try{await flush();await req(API+"/submit",{method:"POST",body:JSON.stringify({answers:savable()})});state.session.completed=true;await report();}
    catch(e){if(btn){btn.disabled=false;btn.innerHTML='Завершить <span>→</span>';}toast(e.message);}
  }
  function answerHtml(q,a) {
    if(!a)return "Нет ответа";if(a.skipped)return "Вопрос пропущен";
    if(a.visibility==="private")return '<span class="intimacy-private-tag">Только мне</span>';
    if(q.type==="scale")return a.value+" из 5 · "+esc(state.data.scale.find((o)=>o.value===a.value)?.label||"");
    if(q.type==="single")return esc(q.options.find((o)=>o.value===a.value)?.label||a.value);
    if(q.type==="multi")return a.value.map((v)=>esc(q.options.find((o)=>o.value===v)?.label||v)).join(", ");
    if(q.type==="text")return safe(a.value);
    if(q.type==="practice"){const f=state.data.practiceFields;return "<b>Опыт:</b> "+esc(f.experience.find((o)=>o.value===a.experience)?.label||"")+"<br><b>Желание:</b> "+esc(f.desire.find((o)=>o.value===a.desire)?.label||"")+"<br><b>Комфорт:</b> "+a.comfort+" из 5";}
    return "";
  }
  function ownAnswersHtml(answers) {
    return qs().map((q)=>{const a=answers[String(q.id)];if(!a)return "";return '<article class="intimacy-report-card"><h4>'+String(q.id).padStart(2,"0")+". "+esc(prompt(q))+'</h4><div class="answer-review"><p>'+answerHtml(q,a)+'</p></div></article>';}).join("");
  }
  function comparisonHtml(data) {
    if(!data.partnerCompleted)return '<section class="panel waiting-card report-section"><div class="waiting-heart">♥</div><h2>Ждём второй взгляд</h2><p>Твой личный отчёт готов. Совместное сравнение появится после завершения анкеты вторым участником.</p><button class="btn btn-secondary" id="intimacy-refresh">Проверить второй отчёт</button></section>';
    const rows=data.comparison.rows;
    if(!rows.length)return '<section class="panel waiting-card"><h2>Пока нет общих ответов для сравнения</h2><p>Вы можете пропускать вопросы и оставлять ответы приватными. Сравниваются только ответы, которыми оба решили поделиться.</p></section>';
    return '<section class="report-section"><h2 class="intimacy-report-head">Ваши ответы рядом</h2><p class="report-subtitle">Показаны только вопросы, на которые оба ответили и разрешили общий просмотр.</p><div class="intimacy-stat"><span>Общих ответов: '+data.comparison.sharedCount+'</span><span>Близких оценок: '+data.comparison.closeScale+'</span><span>Различий по шкалам: '+data.comparison.differentScale+'</span></div>'+
      rows.map((r)=>{const title=r.textA===r.textB?r.textA:"Вопросы: Василий — "+r.textA+" · Полина — "+r.textB;let extra="";if(r.type==="multi")extra="<p><b>Общие варианты:</b> "+esc((r.shared||[]).join(", ")||"нет")+"<br><b>Только Василий:</b> "+esc((r.onlyA||[]).join(", ")||"нет")+"<br><b>Только Полина:</b> "+esc((r.onlyB||[]).join(", ")||"нет")+"</p>";if(r.type==="practice")extra="<p>"+r.differences.map((d)=>"<b>"+esc(d.label)+":</b> Василий — "+esc(d.a)+"; Полина — "+esc(d.b)).join("<br>")+"</p>";const badge=r.type==="text"?"Оба поделились ответом":r.same?"Совпадение":"Есть различия";const a=typeof r.a==="object"?esc(r.a.experience+"; "+r.a.desire+"; комфорт "+r.a.comfort+"/5"):esc(r.a);const b=typeof r.b==="object"?esc(r.b.experience+"; "+r.b.desire+"; комфорт "+r.b.comfort+"/5"):esc(r.b);return '<article class="intimacy-report-card"><h4>'+esc(title)+'</h4><span class="match-tag">'+badge+'</span><div class="intimacy-answer-pair"><div><b>Василий</b>'+a+'</div><div><b>Полина</b>'+b+'</div></div>'+extra+'</article>';}).join("")+"</section>";
  }
  async function report() {
    try{
      const r=await req("/api/intimacy-report/"+encodeURIComponent(token));
      const own=r.ownReport,done=new Date(own.completedAt).toLocaleString("ru-RU",{dateStyle:"long",timeStyle:"short"});
      root.innerHTML='<div class="content-wrap"><div class="center"><a class="fine" href="/p/'+esc(token)+'">← К первому тесту</a></div><header class="page-head"><div class="eyebrow">интимный модуль · личный отчёт</div><h1>Твой откровенный <em style="color:var(--gold-bright)">взгляд.</em></h1><p>Ответы сохранены. Дата завершения: '+esc(done)+'</p></header><div class="intimacy-stat"><span>Ответов: '+r.counts.answered+'</span><span>Пропущено: '+r.counts.skipped+'</span><span>Приватных: '+r.counts.private+'</span><span>Общих: '+r.counts.shared+'</span></div><section class="analysis-summary"><h2 class="report-title">Личный отчёт</h2><p class="analysis-paragraph">Здесь собраны твои ответы. Приватные ответы доступны только в твоём личном отчёте; они не передаются партнёру в сравнительном отчёте.</p><details><summary>Посмотреть все мои ответы</summary><div class="details-body">'+ownAnswersHtml(own.answers)+'</div></details></section>'+comparisonHtml(r)+'<div class="intimacy-note">Отчёт отражает ответы, а не устанавливает сексуальную совместимость как объективный факт. Различия не являются проблемой сами по себе и не создают обязанности соглашаться на практики, которые не подходят.</div><div class="report-actions"><button class="btn btn-secondary" id="intimacy-delete">Удалить мои данные 18+</button><button class="btn btn-quiet" id="intimacy-print">Сохранить отчёт в PDF</button></div></div>';
      document.getElementById("intimacy-refresh")?.addEventListener("click",report);
      document.getElementById("intimacy-print")?.addEventListener("click",()=>window.print());
      document.getElementById("intimacy-delete")?.addEventListener("click",deleteData);
    }catch(e){errorPage(e.message);}
  }
  async function deleteData() {
    if(!confirm("Удалить только твои ответы и черновик интимного теста? Первый тест об отношениях останется без изменений."))return;
    if(!confirm("Подтверди удаление своих данных 18+. Это действие нельзя отменить."))return;
    try{await req(API+"/data",{method:"DELETE"});state.answers={};state.session.consented=false;state.session.completed=false;state.session.draftAnswers={};renderIntro();toast("Твои данные 18+ удалены. Первый тест не затронут.",true);}
    catch(e){toast(e.message);}
  }
  function errorPage(message) {
    root.innerHTML='<div class="content-wrap"><section class="panel waiting-card"><div class="waiting-heart">♡</div><h2>Не получилось открыть интимный модуль</h2><p>'+esc(message)+'</p><a class="btn btn-secondary" href="/p/'+esc(token)+'">Вернуться к первому тесту</a></section></div>';
  }
  async function init() {
    styles();
    if(!token)return errorPage("Не удалось прочитать личную ссылку.");
    try{
      state.data=await fetch("/intimacy-questions.json",{cache:"no-store"}).then((r)=>{if(!r.ok)throw new Error("Не удалось загрузить вопросы.");return r.json();});
      state.session=await req(API);
      state.answers=state.session.answers||state.session.draftAnswers||{};
      if(state.session.completed)return report();
      const first=qs().findIndex((q)=>!valid(q,state.answers[key(q)]));
      state.index=first<0?qs().length-1:first;
      renderIntro();
    }catch(e){errorPage(e.message);}
  }
  init();
})();