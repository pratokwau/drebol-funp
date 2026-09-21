(() => {
  const $ = (id) => document.getElementById(id);
  const keyInput = $('goldenKey');
  const uaInput = $('userAgent');
  const toastEl = $('toast');
  let defaultUA = '';
  let pollTimer = null;

  const toast = (msg, kind = '') => {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${kind}`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.className = 'toast'), 3200);
  };

  const busy = (btn, on) => {
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  };

  const showResult = (el, html, kind) => {
    el.innerHTML = `<div class="box ${kind}">${html}</div>`;
    el.classList.add('show');
  };

  const post = async (url, fields = {}) => {
    const body = new FormData();
    Object.entries(fields).forEach(([k, v]) => body.append(k, v));
    const res = await fetch(url, { method: 'POST', body });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('auth'); }
    return { res, data: await res.json().catch(() => ({})) };
  };

  const get = async (url) => {
    const res = await fetch(url);
    if (res.status === 401) { window.location.href = '/login'; throw new Error('auth'); }
    return res.json();
  };

  // ---------- настройки FunPay ----------
  const esc = (v) => String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const paintAccount = (acc) => {
    const card = document.getElementById('accountCard');
    if (!acc || !acc.id) { card.hidden = true; return; }
    const nick = esc(acc.username || 'аккаунт');
    const balance = acc.balance === null || acc.balance === undefined
      ? '—' : `${esc(acc.balance)} ${esc(acc.currency || '')}`.trim();
    card.innerHTML = `
      <div class="ava">${nick.slice(0, 1).toUpperCase()}</div>
      <div class="who">
        <span class="nick">${nick}</span>
        <span class="uid">ID ${esc(acc.id)}</span>
      </div>
      <div class="stats">
        <div class="stat"><span class="n">${balance}</span><span class="t">баланс</span></div>
        <div class="stat"><span class="n">${esc(acc.active_sales ?? 0)}</span><span class="t">активных продаж</span></div>
        <div class="stat"><span class="n">${esc(acc.active_purchases ?? 0)}</span><span class="t">активных покупок</span></div>
      </div>`;
    card.hidden = false;
    const pill = document.getElementById('fpStatus');
    pill.textContent = nick;
    pill.className = 'pill on';
  };
  const paintKeyState = (d) => {
    const pill = $('fpStatus');
    if (d.has_key) {
      pill.textContent = 'ключ сохранён';
      pill.className = 'pill on';
      $('keyHint').textContent = `Сохранён ключ ${d.key_mask}. Поле пустое — старый ключ не изменится.`;
      keyInput.placeholder = ' ';
    } else {
      pill.textContent = 'не подключён';
      pill.className = 'pill off';
      $('keyHint').textContent = 'Ключ ещё не сохранён.';
    }
  };

  const loadSettings = async () => {
    const d = await get('/api/settings');
    defaultUA = d.default_user_agent;
    uaInput.value = d.user_agent || '';
    paintKeyState(d);
    paintAccount(d.account);
  };

  $('eyeKey').addEventListener('click', () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    $('eyeKey').classList.toggle('off', show);
  });

  $('saveBtn').addEventListener('click', async () => {
    const btn = $('saveBtn');
    busy(btn, true);
    try {
      const { res, data } = await post('/api/settings', {
        golden_key: keyInput.value,
        user_agent: uaInput.value,
      });
      if (res.ok && data.ok) {
        keyInput.value = '';
        paintKeyState(data);
        toast('Сохранено, забираю данные аккаунта...');
        busy(btn, false);
        await fetchAccount(btn);
        return;
      } else {
        toast(data.error || 'Не удалось сохранить', 'bad');
      }
    } catch (e) { if (e.message !== 'auth') toast('Сервер недоступен', 'bad'); }
    busy(btn, false);
  });

  $('clearBtn').addEventListener('click', async () => {
    if (!confirm('Удалить сохранённый golden key?')) return;
    const { data } = await post('/api/settings', { clear_key: '1', user_agent: uaInput.value });
    keyInput.value = '';
    paintKeyState(data);
    paintAccount(null);
    $('fpResult').classList.remove('show');
    toast('Ключ удалён', 'good');
  });

  $('uaResetBtn').addEventListener('click', () => {
    uaInput.value = defaultUA;
    toast('Подставил стандартный user-agent');
  });

  const fetchAccount = async (btn) => {
    busy(btn, true);
    try {
      const { data } = await post('/api/settings/check', {
        golden_key: keyInput.value,
        user_agent: uaInput.value,
      });
      if (data.ok) {
        paintAccount({
          id: data.user_id,
          username: data.username,
          balance: data.balance,
          currency: data.currency,
          active_sales: data.active_sales,
          active_purchases: data.active_purchases,
        });
        showResult($('fpResult'),
          `Получил данные аккаунта — <b>${esc(data.username)}</b>, ID <b>${esc(data.user_id)}</b>`, 'good');
        toast(`Аккаунт: ${data.username}`, 'good');
      } else {
        showResult($('fpResult'), esc(data.error) || 'Не удалось получить данные', 'bad');
        toast('Данные получить не вышло', 'bad');
      }
    } catch (e) { if (e.message !== 'auth') toast('Сервер недоступен', 'bad'); }
    busy(btn, false);
  };

  $('checkBtn').addEventListener('click', () => fetchAccount($('checkBtn')));

  // ---------- логотип сайта ----------
  const brandRow = (title, file, note, preview) => {
    const row = el('div', 'brand-row');
    const prev = el('span', 'brand-prev');
    if (preview) {
      const img = new Image();
      img.src = preview;
      img.alt = '';
      prev.append(img);
    } else {
      prev.append(el('span', 'muted', '—'));
    }
    const info = el('div', 'brand-info');
    info.append(el('span', 'brand-name', title), el('span', 'brand-path', note));
    row.append(prev, info, el('span', `pill ${file ? 'on' : ''}`, file ? `файл ${file}` : 'файла нет'));
    return row;
  };

  const loadBrand = async () => {
    const d = await get('/api/brand');
    $('brandBox').replaceChildren(
      brandRow('Логотип в шапке', d.logo_file, `${d.dir}/logo.png`, d.logo),
      brandRow('Иконка вкладки', d.favicon_file,
        `${d.dir}/favicon.png — если файла нет, берётся логотип`, d.logo),
    );
    $('brandHint').textContent = `Подойдут форматы: ${d.formats.join(', ')}. Имя файла — logo или favicon.`
      + ' Папка не трогается при обновлении с GitHub. После замены файла обнови страницу.';
  };

  $('brandReload').addEventListener('click', () => loadBrand()
    .then(() => toast('Проверил папку'))
    .catch(() => toast('Не удалось прочитать папку', 'bad')));

  // ---------- обновление ----------
  const paintVersion = (v) => {
    const box = $('verBox');
    if (!v.ok) {
      box.innerHTML = `<span class="muted">${v.error}</span>`;
      $('verPill').textContent = 'недоступно';
      $('verPill').className = 'pill off';
      $('updBtn').disabled = true;
      $('checkUpdBtn').disabled = true;
      return;
    }
    const when = v.date ? new Date(v.date).toLocaleString('ru-RU') : '—';
    box.innerHTML = `
      <span><span class="k">коммит</span><span class="v">${v.commit}</span></span>
      <span><span class="k">ветка</span><span class="v">${v.branch}</span></span>
      <span><span class="k">дата</span><span class="v">${when}</span></span>
      <span><span class="k">описание</span>${v.subject || '—'}</span>`;
    $('verPill').textContent = `версия ${v.commit}`;
    $('verPill').className = 'pill';
  };

  $('checkUpdBtn').addEventListener('click', async () => {
    const btn = $('checkUpdBtn');
    busy(btn, true);
    try {
      const { data } = await post('/api/update/check');
      paintVersion(data);
      if (data.error) {
        showResult($('updResult'), data.error, 'bad');
      } else if (data.behind > 0) {
        const list = data.commits.map((c) => `<li>${c.replace(/</g, '&lt;')}</li>`).join('');
        showResult($('updResult'),
          `Есть <b>${data.behind}</b> новых коммитов в ${data.upstream}:<ul class="commits">${list}</ul>`, 'good');
        $('verPill').textContent = `доступно обновление`;
        $('verPill').className = 'pill on';
      } else {
        showResult($('updResult'), 'Уже последняя версия.', '');
      }
      if (data.dirty) toast('В папке есть локальные правки — при обновлении уйдут в git stash');
    } catch (e) { if (e.message !== 'auth') toast('Сервер недоступен', 'bad'); }
    busy(btn, false);
  });

  const pollLog = () => {
    clearInterval(pollTimer);
    const logEl = $('updLog');
    logEl.hidden = false;
    let misses = 0;
    pollTimer = setInterval(async () => {
      try {
        const d = await get('/api/update/log');
        if (d.log) { logEl.textContent = d.log; logEl.scrollTop = logEl.scrollHeight; }
        if (!d.running) {
          clearInterval(pollTimer);
          busy($('updBtn'), false);
          get('/api/version').then(paintVersion).catch(() => {});
          toast('Обновление завершено', 'good');
        }
      } catch {
        // сервис перезапускается — это нормально, ждём
        misses += 1;
        if (misses > 40) { clearInterval(pollTimer); busy($('updBtn'), false); }
      }
    }, 1500);
  };

  $('updBtn').addEventListener('click', async () => {
    if (!confirm('Обновить панель с GitHub и перезапустить сайт?')) return;
    const btn = $('updBtn');
    busy(btn, true);
    try {
      const { data } = await post('/api/update/run');
      if (data.ok) {
        showResult($('updResult'), 'Обновление запущено — сайт ненадолго уйдёт на перезапуск.', '');
        toast('Обновляюсь...');
        pollLog();
      } else {
        showResult($('updResult'), data.error || 'Не удалось запустить обновление', 'bad');
        busy(btn, false);
      }
    } catch (e) { if (e.message !== 'auth') { toast('Сервер недоступен', 'bad'); busy(btn, false); } }
  });

  // ---------- старт ----------
  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  get('/api/me').then((d) => ($('user').textContent = d.login)).catch(() => {});
  loadSettings().catch(() => {});
  loadBrand().catch(() => {});
  get('/api/version').then(paintVersion).catch(() => {});
})();
