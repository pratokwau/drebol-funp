(() => {
  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  let nextFrom = null;
  let loading = false;
  let all = [];
  // закуп по заказу уже посчитан сервером с учётом выбора «с кэшбеком / без»
  const pick = (o) => ({ profit: o.profit, cost: o.cost, cb: o.cashback_used });

  // пересчёт на месте после клика по варианту закупа
  const applyChoice = (o, choice) => {
    o.choice = choice;
    const cost = choice === 'cashback' ? o.variants.cashback : o.variants.plain;
    o.cost = cost;
    o.cashback_used = choice === 'cashback';
    o.profit = Math.round((o.net - cost) * 100) / 100;
  };

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

  // две цены закупа — выбираешь, какая пошла в этот заказ
  const costPick = (o) => {
    if (!o.variants) return '';
    const btn = (key, label) => `
      <button class="cp ${o.choice === key ? 'on' : ''}" data-choice="${key}" data-id="${esc(o.id)}"
              title="${o.choice === key ? 'нажми ещё раз, чтобы сбросить' : 'посчитать заказ с этим закупом'}">
        ${label} <b>${money(o.variants[key])}</b>
      </button>`;
    return `
      <span class="cost-pick ${o.choice ? '' : 'undecided'}">
        <span class="cp-label">Закуп:</span>
        ${btn('cashback', 'с кэшбеком')}${btn('plain', 'без кэшбека')}
        ${o.choice ? '' : '<span class="cp-hint">не выбран — считаю без кэшбека</span>'}
      </span>`;
  };

  const row = (o) => {
    const p = pick(o);
    return `
    <div class="order" data-row="${esc(o.id)}">
      <a class="oid" href="${esc(o.link)}" target="_blank" rel="noopener noreferrer">#${esc(o.id)}</a>
      <span class="otitle">
        <a href="${esc(o.link)}" target="_blank" rel="noopener noreferrer">${esc(o.title) || '<span class="muted">без описания</span>'}</a>
        <span class="ocat">${esc(o.category || '')}${o.amount && o.amount > 1 ? ` · ${o.amount} шт` : ''}${
          o.matched ? ` · закуп по «${esc(o.matched)}»` : ''}</span>
        ${costPick(o)}
      </span>
      <span class="obuyer">${esc(o.buyer)}</span>
      <span class="ostatus st-${esc(o.status_code)}">${esc(o.status)}</span>
      <span class="oprice">${money(o.price)} ${esc(o.currency)}</span>
      <span class="oprofit ${p.profit === null ? 'none' : !p.cost ? 'warn' : p.profit >= 0 ? 'plus' : 'minus'}"
            title="${o.matched
              ? (!p.cost
                  ? `у товара «${esc(o.matched)}» не задан закуп — прибыль показана как вся сумма`
                  : `закуп: ${money(p.cost)}${p.cb ? ' (с кэшбеком)' : ''} · товар «${esc(o.matched)}»`)
              : 'товар не найден в мин. ценах'}">
        ${p.profit === null ? '—' : (p.profit > 0 ? '+' : '') + money(p.profit)}${
          p.cb ? '<span class="cbdot" title="учтён кэшбек">•</span>' : ''}${
          o.matched && !p.cost ? '<span class="warndot" title="закуп не задан">⚠</span>' : ''}
      </span>
      <span class="odate">${when(o.date)}</span>
    </div>`;
  };

  const paintFoot = () => {
    if (!all.length) return;
    const noMatch = all.filter((o) => o.profit === null).length;
    const withCb = all.filter((o) => o.cashback_used).length;
    const undecided = all.filter((o) => o.variants && !o.choice).length;
    const zeroCost = all.filter((o) => o.matched && !pick(o).cost).length;
    const tail = (noMatch ? ` Без цены закупа: ${noMatch} — заведи товары во вкладке «Мин. цены».` : '')
      + (zeroCost ? ` С нулевым закупом: ${zeroCost} — проставь цены в «Мин. ценах».` : '')
      + (undecided ? ` Не выбран вариант закупа: ${undecided} — пока считаю без кэшбека.` : '')
      + (withCb ? ` С кэшбеком: ${withCb}.` : '');
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

  $('list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-choice]');
    if (!btn) return;
    const o = all.find((x) => String(x.id) === btn.dataset.id);
    if (!o || !o.variants) return;

    // повторный клик по выбранному — сброс
    const next = o.choice === btn.dataset.choice ? null : btn.dataset.choice;
    const prev = { choice: o.choice, cost: o.cost, profit: o.profit, cashback_used: o.cashback_used };
    applyChoice(o, next);
    render();
    try {
      const res = await fetch('/api/orders/choice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: o.id, choice: next }),
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || 'не сохранилось');
      toast(next === 'cashback' ? `#${o.id}: закуп с кэшбеком`
        : next === 'plain' ? `#${o.id}: закуп без кэшбека` : `#${o.id}: выбор сброшен`, 'good');
    } catch (err) {
      Object.assign(o, prev);   // откатываем, если сервер не сохранил
      render();
      toast(`Не сохранилось: ${err.message}`, 'bad');
    }
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
