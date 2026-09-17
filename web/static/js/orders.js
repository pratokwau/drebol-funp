(() => {
  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  let nextFrom = null;
  let loading = false;
  let all = [];
  let cashbackMin = 100;
  // режим расчёта запоминаем в браузере
  let mode = (() => {
    try { return localStorage.getItem('drebol-orders-mode') || 'cashback'; } catch { return 'cashback'; }
  })();

  // прибыль и закуп в выбранном режиме
  const pick = (o) => (mode === 'cashback' && o.profit_cashback !== null && o.profit_cashback !== undefined
    ? { profit: o.profit_cashback, cost: o.cost_cashback, cb: o.cashback_used }
    : { profit: o.profit, cost: o.cost, cb: false });

  const toast = (msg, kind = '') => {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${kind}`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.className = 'toast'), 3200);
  };

  const esc = (v) =>
    String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  const money = (v) =>
    Number.isFinite(v) ? v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  const when = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `${date}<span class="t">${time}</span>`;
  };

  const busy = (btn, on) => {
    if (!btn) return;
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  };

  const row = (o) => {
    const p = pick(o);
    return `
    <a class="order" href="${esc(o.link)}" target="_blank" rel="noopener noreferrer">
      <span class="oid">#${esc(o.id)}</span>
      <span class="otitle">
        ${esc(o.title) || '<span class="muted">без описания</span>'}
        <span class="ocat">${esc(o.category || '')}${o.amount && o.amount > 1 ? ` · ${o.amount} шт` : ''}</span>
      </span>
      <span class="obuyer">${esc(o.buyer)}</span>
      <span class="ostatus st-${esc(o.status_code)}">${esc(o.status)}</span>
      <span class="oprice">${money(o.price)} ${esc(o.currency)}</span>
      <span class="oprofit ${p.profit === null ? 'none' : p.profit >= 0 ? 'plus' : 'minus'}"
            title="${o.matched
              ? `закуп: ${money(p.cost)}${p.cb ? ' (с кэшбеком)' : ''} · товар «${esc(o.matched)}»`
              : 'товар не найден в мин. ценах'}">
        ${p.profit === null ? '—' : (p.profit > 0 ? '+' : '') + money(p.profit)}${p.cb ? '<span class="cbdot" title="учтён кэшбек">•</span>' : ''}
      </span>
      <span class="odate">${when(o.date)}</span>
    </a>`;
  };

  const paintFoot = () => {
    if (!all.length) return;
    const noMatch = all.filter((o) => o.profit === null).length;
    const withCb = all.filter((o) => o.cashback_used).length;
    const tail = (noMatch ? ` Без цены закупа: ${noMatch} — заведи товары во вкладке «Мин. цены».` : '')
      + (mode === 'cashback' && withCb ? ` С кэшбеком посчитано: ${withCb} (порог ${money(cashbackMin)}).` : '');
    $('footHint').textContent = (nextFrom
      ? `Показано ${all.length}. Есть ещё — жми кнопку.`
      : `Это все заказы: ${all.length}.`) + tail;
  };

  const render = () => {
    const q = $('filter').value.trim().toLowerCase();
    const shown = q
      ? all.filter((o) =>
          [o.title, o.buyer, o.id, o.category].some((f) => String(f ?? '').toLowerCase().includes(q)))
      : all;

    $('list').innerHTML = shown.map(row).join('');
    $('cntPill').textContent = q
      ? `${shown.length} из ${all.length}`
      : `загружено ${all.length}`;

    const sum = shown.reduce((acc, o) => acc + (Number(o.price) || 0), 0);
    const cur = shown.length ? shown[0].currency : '';
    const sumPill = $('sumPill');
    sumPill.hidden = !shown.length;
    sumPill.textContent = `на сумму ${money(sum)} ${cur}`;

    const counted = shown.filter((o) => o.profit !== null && o.profit !== undefined);
    const profit = counted.reduce((acc, o) => acc + pick(o).profit, 0);
    const profitPill = $('profitPill');
    profitPill.hidden = !counted.length;
    profitPill.className = `pill ${profit >= 0 ? 'on' : 'off'}`;
    profitPill.textContent = `прибыль ${profit > 0 ? '+' : ''}${money(profit)} ${cur} (${counted.length} из ${shown.length})`;

    paintFoot();

    const empty = $('empty');
    if (!all.length) {
      empty.hidden = false;
      empty.innerHTML = '<p class="muted">Заказов нет.</p>';
    } else if (!shown.length) {
      empty.hidden = false;
      empty.innerHTML = '<p class="muted">Под фильтр ничего не подошло.</p>';
    } else {
      empty.hidden = true;
    }
  };

  const load = async (btn) => {
    if (loading) return;
    loading = true;
    busy(btn, true);
    $('footHint').textContent = 'Тяну заказы с FunPay, это занимает несколько секунд...';

    try {
      const url = nextFrom ? `/api/orders?start_from=${encodeURIComponent(nextFrom)}` : '/api/orders';
      const res = await fetch(url);
      if (res.status === 401) { window.location.href = '/login'; return; }
      const data = await res.json().catch(() => ({}));

      if (!data.ok) {
        $('footHint').innerHTML = `<span class="err">${esc(data.error || 'Не удалось получить заказы')}</span>`;
        toast(data.error || 'Ошибка запроса', 'bad');
        return;
      }

      all = all.concat(data.orders);
      nextFrom = data.next;
      if (data.cashback_min !== undefined) cashbackMin = data.cashback_min;
      render();

      $('moreBtn').hidden = !nextFrom;
      paintFoot();
      if (data.orders.length) toast(`+${data.orders.length} заказов`, 'good');
    } catch {
      $('footHint').innerHTML = '<span class="err">Сервер недоступен</span>';
    } finally {
      loading = false;
      busy(btn, false);
    }
  };

  $('moreBtn').addEventListener('click', () => load($('moreBtn')));

  $('reloadBtn').addEventListener('click', () => {
    all = [];
    nextFrom = null;
    $('list').innerHTML = '';
    $('moreBtn').hidden = true;
    load($('reloadBtn'));
  });

  $('filter').addEventListener('input', render);

  document.querySelectorAll('[data-cb]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.cb === mode);
    tab.addEventListener('click', () => {
      mode = tab.dataset.cb;
      try { localStorage.setItem('drebol-orders-mode', mode); } catch { /* приватный режим */ }
      document.querySelectorAll('[data-cb]').forEach((b) => b.classList.toggle('active', b.dataset.cb === mode));
      render();
      toast(mode === 'cashback' ? 'Считаю с кэшбеком' : 'Считаю без кэшбека');
    });
  });

  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => ($('user').textContent = d.login))
    .catch(() => (window.location.href = '/login'));

  load($('reloadBtn'));
})();
