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
  let editingCost = null;   // номер заказа, где сейчас правят закуп

  // ---------------------------- фильтры и сортировка ----------------------------
  const FKEY = 'drebol-orders-filters';
  const flt = (() => {
    try { return { st: 'all', cf: 'all', sort: 'new', ...JSON.parse(localStorage.getItem(FKEY) || '{}') }; }
    catch { return { st: 'all', cf: 'all', sort: 'new' }; }
  })();
  const saveFlt = () => { try { localStorage.setItem(FKEY, JSON.stringify(flt)); } catch { /* приватный режим */ } };

  const needsChoice = (o) => !!o.variants && !o.choice && !o.manual && !o.refunded;
  const STATUS = {
    all: () => true,
    paid: (o) => o.status_code === 'paid',
    closed: (o) => o.status_code === 'closed',
    refund: (o) => !!o.refunded,
  };
  const COST = {
    all: () => true,
    undecided: needsChoice,
    nocost: (o) => o.profit === null && !o.refunded,
    loss: (o) => o.profit !== null && o.profit < 0,
    manual: (o) => o.manual && !o.refunded,
    cashback: (o) => !!o.cashback_used,
  };
  const matchesText = (o, q) => !q
    || [o.title, o.buyer, o.id, o.category, o.matched].some((f) => String(f ?? '').toLowerCase().includes(q));
  const SORT = {
    new: (a, b) => String(b.date).localeCompare(String(a.date)),
    old: (a, b) => String(a.date).localeCompare(String(b.date)),
    profit_desc: (a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity),
    profit_asc: (a, b) => (a.profit ?? Infinity) - (b.profit ?? Infinity),
    price_desc: (a, b) => (b.price || 0) - (a.price || 0),
  };

  const paintChips = (q) => {
    document.querySelectorAll('#statusChips [data-st]').forEach((b) => {
      const n = all.filter((o) => STATUS[b.dataset.st](o) && COST[flt.cf](o) && matchesText(o, q)).length;
      b.classList.toggle('on', b.dataset.st === flt.st);
      b.dataset.count = n;
      b.innerHTML = `${esc(b.textContent.replace(/\s*\d+$/, ''))} <span class="cnt">${n}</span>`;
    });
    document.querySelectorAll('#costChips [data-cf]').forEach((b) => {
      const n = all.filter((o) => COST[b.dataset.cf](o) && STATUS[flt.st](o) && matchesText(o, q)).length;
      b.classList.toggle('on', b.dataset.cf === flt.cf);
      b.classList.toggle('attention', b.dataset.cf === 'undecided' && n > 0);
      b.innerHTML = `${esc(b.textContent.replace(/\s*\d+$/, ''))} <span class="cnt">${n}</span>`;
    });
  };

  const costPick = (o) => {
    if (!o.variants || o.refunded || o.manual) return '';
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

  // закуп в этом заказе: видно, откуда он, и можно вписать свой
  const costLine = (o) => {
    if (o.refunded) return '<span class="cost-line refund">Возврат — прибыль не считается</span>';
    const per = o.amount > 1 ? ` <span class="muted">(${money(o.amount ? o.cost / o.amount : o.cost)} за шт)</span>` : '';
    if (editingCost === String(o.id)) {
      return `
        <span class="cost-line editing">
          <span class="cp-label">Закуп за заказ:</span>
          <input type="text" class="cost-input" inputmode="decimal" data-costinput="${esc(o.id)}"
                 value="${o.manual ? esc(o.override) : ''}" placeholder="${o.base_cost !== null ? money(o.base_cost) : 'сумма'}">
          <button class="mini ok" data-costsave="${esc(o.id)}" title="Сохранить (Enter)">✓</button>
          <button class="mini" data-costcancel title="Отмена (Esc)">↺</button>
          <span class="cp-hint muted-hint">пусто — вернуть ${o.base_cost !== null ? 'закуп из «Мин. цен»' : 'как было'}</span>
        </span>`;
    }
    if (o.manual) {
      return `
        <span class="cost-line">
          <span class="cp-label">Закуп:</span> <b>${money(o.cost)}</b>${per}
          <span class="badge-manual" title="вписан вручную в этом заказе">вручную</span>
          <button class="mini" data-costedit="${esc(o.id)}" title="Изменить закуп">✎</button>
          <button class="link-btn" data-costreset="${esc(o.id)}">сбросить</button>
        </span>`;
    }
    const label = o.cost !== null && o.cost !== undefined ? `<b>${money(o.cost)}</b>${per}` : '<span class="muted">не задан</span>';
    return `
      <span class="cost-line">
        <span class="cp-label">Закуп:</span> ${label}
        <button class="mini" data-costedit="${esc(o.id)}" title="Вписать закуп для этого заказа">✎</button>
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
        ${costLine(o)}
      </span>
      <span class="obuyer">${esc(o.buyer)}</span>
      <span class="ostatus st-${esc(o.status_code)}">${esc(o.status)}</span>
      <span class="oprice">${money(o.price)} ${esc(o.currency)}</span>
      ${o.refunded ? '<span class="oprofit none refund" title="заказ возвращён — прибыль не учитывается">возврат</span>' : `<span class="oprofit ${p.profit === null ? 'none' : !p.cost ? 'warn' : p.profit >= 0 ? 'plus' : 'minus'}"
            title="${o.manual ? `закуп вписан вручную: ${money(p.cost)}` : o.matched
              ? (!p.cost
                  ? `у товара «${esc(o.matched)}» не задан закуп — прибыль показана как вся сумма`
                  : `закуп: ${money(p.cost)}${p.cb ? ' (с кэшбеком)' : ''} · товар «${esc(o.matched)}»`)
              : (o.game_missing ? `раздел «${esc(o.category || '')}» не добавлен в мин. цены` : 'товар не найден в мин. ценах')}">
        ${p.profit === null ? '—' : (p.profit > 0 ? '+' : '') + money(p.profit)}${
          p.cb ? '<span class="cbdot" title="учтён кэшбек">•</span>' : ''}${
          o.matched && !p.cost && !o.manual ? '<span class="warndot" title="закуп не задан">⚠</span>' : ''}
      </span>`}
      <span class="odate">${when(o.date)}</span>
    </div>`;
  };

  const paintFoot = () => {
    if (!all.length) return;
    const noMatch = all.filter((o) => o.profit === null && !o.refunded).length;
    const withCb = all.filter((o) => o.cashback_used).length;
    const undecided = all.filter((o) => o.variants && !o.choice && !o.manual && !o.refunded).length;
    const zeroCost = all.filter((o) => o.matched && !o.manual && !o.refunded && !pick(o).cost).length;
    const refunds = all.filter((o) => o.refunded).length;
    const noGame = new Set(all.filter((o) => o.game_missing && !o.refunded).map((o) => o.category)).size;
    const manual = all.filter((o) => o.manual && !o.refunded).length;
    const tail = (noMatch ? ` Без цены закупа: ${noMatch} — заведи товары во вкладке «Мин. цены».` : '')
      + (zeroCost ? ` С нулевым закупом: ${zeroCost} — проставь цены в «Мин. ценах».` : '')
      + (undecided ? ` Не выбран вариант закупа: ${undecided} — пока считаю без кэшбека.` : '')
      + (withCb ? ` С кэшбеком: ${withCb}.` : '')
      + (manual ? ` Закуп вписан вручную: ${manual}.` : '')
      + (refunds ? ` Возвратов: ${refunds} — в прибыль не входят.` : '')
      + (noGame ? ` Разделов нет в «Мин. ценах»: ${noGame} — добавь игру, иначе закуп не подставится.` : '');
    $('footHint').textContent = (nextFrom
      ? `Показано ${all.length}. Есть ещё — жми кнопку.`
      : `Это все заказы: ${all.length}.`) + tail;
  };

  const render = () => {
    const q = $('filter').value.trim().toLowerCase();
    const shown = all
      .filter((o) => STATUS[flt.st](o) && COST[flt.cf](o) && matchesText(o, q))
      .sort(SORT[flt.sort] || SORT.new);
    const filtered = q || flt.st !== 'all' || flt.cf !== 'all';

    paintChips(q);
    $('sort').value = flt.sort;
    $('list').innerHTML = shown.map(row).join('');
    $('cntPill').textContent = filtered
      ? `${shown.length} из ${all.length}`
      : `загружено ${all.length}`;

    // массовый выбор — для показанных заказов, где он ещё нужен
    const pending = shown.filter(needsChoice);
    $('bulkChoice').hidden = !pending.length;
    $('bulkInfo').textContent = `Не выбран закуп в ${pending.length} ${pending.length === 1 ? 'заказе' : 'заказах'} из показанных:`;

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
      empty.innerHTML = `<p class="muted">Под фильтр ничего не подошло${
        flt.st !== 'all' || flt.cf !== 'all' ? ' — попробуй «Все» или загрузи ещё заказов' : ''}.</p>`;
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

  $('sort').addEventListener('change', () => { flt.sort = $('sort').value; saveFlt(); render(); });
  $('statusChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    flt.st = b.dataset.st; saveFlt(); render();
  });
  $('costChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cf]');
    if (!b) return;
    flt.cf = b.dataset.cf; saveFlt(); render();
  });

  $('bulkChoice').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn) return;
    const q = $('filter').value.trim().toLowerCase();
    const targets = all.filter((o) => STATUS[flt.st](o) && COST[flt.cf](o) && matchesText(o, q) && needsChoice(o));
    if (!targets.length) return;
    const label = btn.dataset.bulk === 'cashback' ? 'с кэшбеком' : 'без кэшбека';
    if (!confirm(`Поставить закуп «${label}» в ${targets.length} заказах?`)) return;
    btn.classList.add('loading'); btn.disabled = true;
    try {
      const res = await fetch('/api/orders/choice-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: targets.map((o) => o.id), choice: btn.dataset.bulk }),
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || 'не сохранилось');
      targets.forEach((o) => applyChoice(o, btn.dataset.bulk));
      render();
      toast(`${targets.length} заказов — закуп ${label}`, 'good');
    } catch (err) {
      toast(`Не сохранилось: ${err.message}`, 'bad');
    }
    btn.classList.remove('loading'); btn.disabled = false;
  });

  const saveCost = async (id, value) => {
    const o = all.find((x) => String(x.id) === String(id));
    if (!o) return;
    try {
      const res = await fetch('/api/orders/cost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: o.id, cost: value,
          order: { id: o.id, title: o.title, price: o.price, amount: o.amount, status_code: o.status_code },
        }),
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || 'не сохранилось');
      if (data.order) Object.assign(o, data.order);
      editingCost = null;
      render();
      toast(value === '' ? `#${o.id}: закуп снова из «Мин. цен»` : `#${o.id}: закуп ${money(o.cost)} вручную`, 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  $('list').addEventListener('keydown', (e) => {
    const inp = e.target.closest('[data-costinput]');
    if (!inp) return;
    if (e.key === 'Enter') { e.preventDefault(); saveCost(inp.dataset.costinput, inp.value.trim()); }
    if (e.key === 'Escape') { editingCost = null; render(); }
  });

  $('list').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-costedit]');
    if (edit) {
      editingCost = edit.dataset.costedit;
      render();
      const inp = document.querySelector(`[data-costinput="${CSS.escape(editingCost)}"]`);
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
    if (e.target.closest('[data-costcancel]')) { editingCost = null; render(); return; }
    const save = e.target.closest('[data-costsave]');
    if (save) {
      const inp = document.querySelector(`[data-costinput="${CSS.escape(save.dataset.costsave)}"]`);
      saveCost(save.dataset.costsave, inp ? inp.value.trim() : '');
      return;
    }
    const reset = e.target.closest('[data-costreset]');
    if (reset) { saveCost(reset.dataset.costreset, ''); return; }

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
