(() => {
  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  let state = { fee: 3, cashbackMin: 100, games: [], items: {} };
  let found = [];          // результат сканирования
  let picked = new Set();  // выбранные в окне сканирования
  let openGame = null;     // раскрытая игра
  let pickedGames = new Set();  // отмеченные игры в списке
  let lotsCache = {};      // лоты с FunPay по ключу игры

  const toast = (msg, kind = '') => {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${kind}`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.className = 'toast'), 3200);
  };

  const esc = (v) =>
    String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  const money = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—');

  const busy = (btn, on) => {
    if (!btn) return;
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  };

  const api = async (url, options = {}) => {
    const res = await fetch(url, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
    });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('auth'); }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.error || 'Запрос не удался');
    return data;
  };

  // ---------------------------- список игр ----------------------------

  const itemRow = (item) => {
    const cb = item.has_cashback && item.cost_cashback !== null && item.cost_cashback !== undefined;
    const below = cb && Number(item.cost) < Number(state.cashbackMin);
    const noCost = !Number(item.cost);
    return `
    <div class="pitem" data-id="${esc(item.id)}">
      <span class="ptitle">${esc(item.title)}${item.keywords ? `<span class="pkeys-sm">${esc(item.keywords)}</span>` : ''}</span>
      <span class="pcost ${noCost ? 'zero' : ''}" title="${noCost ? 'закуп не задан — прибыль считается как вся сумма' : ''}">${noCost ? 'не задан' : money(item.cost)}</span>
      <span class="pcost cb ${cb ? (below ? 'off' : 'on') : 'none'}"
            title="${below ? `закуп меньше порога ${money(state.cashbackMin)} ₽ — кэшбек не применяется` : ''}">
        ${cb ? money(item.cost_cashback) + (below ? ' ⚠' : '') : '—'}
      </span>
      <button class="mini danger" data-del="${esc(item.id)}" title="Удалить">×</button>
    </div>`;
  };

  const gameCard = (game) => {
    const items = state.items[game.key] || [];
    const open = openGame === game.key;
    return `
      <div class="game ${open ? 'open' : ''} ${pickedGames.has(game.key) ? 'picked' : ''}" data-key="${esc(game.key)}">
        <div class="game-head" data-toggle="${esc(game.key)}">
          <label class="check" data-nopick>
            <input type="checkbox" data-pick="${esc(game.key)}" ${pickedGames.has(game.key) ? 'checked' : ''}>
          </label>
          <div class="game-name">
            <span class="gtitle">${esc(game.game || game.name)}</span>
            <span class="gsub">${esc(game.name)}${game.lots ? ` · ${game.lots} лотов` : ''}</span>
          </div>
          <span class="pill ${items.length ? 'on' : ''}">${items.length} товаров</span>
          <button class="mini danger" data-delgame="${esc(game.key)}" title="Убрать игру">×</button>
          <span class="chev">${open ? '▾' : '▸'}</span>
        </div>

        <div class="game-body" ${open ? '' : 'hidden'}>
          <div class="pitem head">
            <span class="ptitle">Товар</span>
            <span class="pcost">Закуп</span>
            <span class="pcost">С кэшбеком</span>
            <span></span>
          </div>
          <div class="pitems">${items.map(itemRow).join('') || '<p class="muted pad">Товаров пока нет.</p>'}</div>

          <div class="add-row">
            <input type="text" class="search" data-f="title" placeholder="Название товара (как в заказе)">
            <input type="text" class="search narrow" data-f="keywords" placeholder="Слова для поиска">
            <input type="text" class="search narrow" data-f="cost" inputmode="decimal" placeholder="Закуп">
            <input type="text" class="search narrow" data-f="cost_cashback" inputmode="decimal" placeholder="С кэшбеком">
            <button class="btn primary" data-add="${esc(game.key)}"><span class="label">Добавить</span><span class="spinner"></span></button>
          </div>

          <div class="lots-block">
            <button class="btn ghost-btn" data-lots="${esc(game.key)}"><span class="label">Подтянуть лоты с FunPay</span><span class="spinner"></span></button>
            <div class="lots" data-lotsbox="${esc(game.key)}"></div>
          </div>
        </div>
      </div>`;
  };

  const paintBulk = () => {
    const keys = state.games.map((g) => g.key);
    pickedGames = new Set([...pickedGames].filter((k) => keys.includes(k)));

    $('bulk').hidden = !state.games.length;
    $('pickGamesInfo').textContent = `выбрано ${pickedGames.size}`;
    $('removePicked').disabled = !pickedGames.size;
    $('removePicked').querySelector('.label').textContent =
      `Убрать выбранные${pickedGames.size ? ` (${pickedGames.size})` : ''}`;
    const all = $('pickAllGames');
    all.checked = state.games.length > 0 && pickedGames.size === state.games.length;
    all.indeterminate = pickedGames.size > 0 && pickedGames.size < state.games.length;
  };

  const render = () => {
    $('fee').value = state.fee;
    $('cashbackMin').value = state.cashbackMin;
    $('games').innerHTML = state.games.map(gameCard).join('');
    paintBulk();
    const all = Object.values(state.items).flat();
    const total = all.length;
    const cb = all.filter((i) => i.has_cashback).length;
    const empty = all.filter((i) => !Number(i.cost)).length;
    $('gamesHint').textContent = state.games.length
      ? `Игр: ${state.games.length}, товаров: ${total}, с кэшбеком: ${cb}${empty ? `, без закупа: ${empty}` : ''}.`
        + ` Кэшбек считается только когда закуп от ${money(state.cashbackMin)} ₽.`
      : 'Пока пусто. Нажми «Добавить игры с FunPay» — панель просканирует профиль и покажет твои разделы.';
  };

  const reload = async () => {
    const data = await api('/api/pricing');
    state = { fee: data.fee, cashbackMin: data.cashback_min, games: data.games, items: data.items };
    render();
  };

  // ---------------------------- сканирование ----------------------------

  const scanRow = (g) => `
    <label class="scan-item ${g.added ? 'added' : ''}">
      <input type="checkbox" value="${esc(g.key)}" ${g.added ? 'disabled checked' : ''}>
      <span class="sname">${esc(g.game || g.name)}<span class="ssub">${esc(g.name)}</span></span>
      <span class="slots">${g.lots} лотов</span>
      ${g.added ? '<span class="pill on">уже добавлено</span>' : ''}
    </label>`;

  const renderScan = () => {
    const q = $('scanFilter').value.trim().toLowerCase();
    const list = q
      ? found.filter((g) => `${g.game} ${g.name}`.toLowerCase().includes(q))
      : found;
    $('scanList').innerHTML = list.map(scanRow).join('') || '<p class="muted pad">Ничего не найдено.</p>';
    $('scanList').querySelectorAll('input[type=checkbox]:not([disabled])').forEach((cb) => {
      cb.checked = picked.has(cb.value);
      cb.addEventListener('change', () => {
        cb.checked ? picked.add(cb.value) : picked.delete(cb.value);
        $('pickInfo').textContent = `выбрано ${picked.size}`;
      });
    });
    $('pickInfo').textContent = `выбрано ${picked.size}`;
    paintScanBulk();
  };

  const visibleScanKeys = () => {
    const q = $('scanFilter').value.trim().toLowerCase();
    return found
      .filter((g) => !g.added && (!q || `${g.game} ${g.name}`.toLowerCase().includes(q)))
      .map((g) => g.key);
  };

  const paintScanBulk = () => {
    const keys = visibleScanKeys();
    const chosen = keys.filter((k) => picked.has(k)).length;
    const all = $('pickAllScan');
    all.disabled = !keys.length;
    all.checked = keys.length > 0 && chosen === keys.length;
    all.indeterminate = chosen > 0 && chosen < keys.length;
  };

  $('scanBtn').addEventListener('click', async () => {
    const btn = $('scanBtn');
    busy(btn, true);
    try {
      const data = await api('/api/pricing/scan', { method: 'POST' });
      found = data.games;
      picked = new Set();
      $('scanInfo').textContent = `${data.username}: найдено разделов — ${data.total}`;
      $('scanFilter').value = '';
      renderScan();
      $('modal').hidden = false;
      if (!found.length) toast('В профиле не нашлось лотов', 'bad');
    } catch (e) {
      if (e.message !== 'auth') toast(e.message, 'bad');
    }
    busy(btn, false);
  });

  $('addGamesBtn').addEventListener('click', async () => {
    if (!picked.size) { toast('Отметь хотя бы одну игру'); return; }
    const btn = $('addGamesBtn');
    busy(btn, true);
    try {
      await api('/api/pricing/games', {
        method: 'POST',
        body: JSON.stringify({ keys: [...picked], found }),
      });
      await reload();
      $('modal').hidden = true;
      toast(`Добавлено игр: ${picked.size}`, 'good');
    } catch (e) {
      if (e.message !== 'auth') toast(e.message, 'bad');
    }
    busy(btn, false);
  });

  $('pickAllScan').addEventListener('change', (e) => {
    const keys = visibleScanKeys();
    keys.forEach((k) => (e.target.checked ? picked.add(k) : picked.delete(k)));
    renderScan();
  });

  $('clearScan').addEventListener('click', () => {
    picked = new Set();
    renderScan();
  });

  $('closeModal').addEventListener('click', () => ($('modal').hidden = true));
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });
  $('scanFilter').addEventListener('input', renderScan);
  $('refreshBtn').addEventListener('click', () => reload().then(() => toast('Обновил')));

  // ---------------------------- действия внутри игры ----------------------------

  $('pickAllGames').addEventListener('change', (e) => {
    pickedGames = e.target.checked ? new Set(state.games.map((g) => g.key)) : new Set();
    render();
  });

  $('removePicked').addEventListener('click', async () => {
    if (!pickedGames.size) return;
    const names = state.games.filter((g) => pickedGames.has(g.key)).map((g) => g.game || g.name);
    if (!confirm(`Убрать ${pickedGames.size} игр вместе с товарами?\n\n${names.join(', ')}`)) return;
    const btn = $('removePicked');
    busy(btn, true);
    try {
      const keys = [...pickedGames];
      await api('/api/pricing/games/delete', { method: 'POST', body: JSON.stringify({ keys }) });
      if (keys.includes(openGame)) openGame = null;
      pickedGames = new Set();
      await reload();
      toast(`Убрано игр: ${keys.length}`, 'good');
    } catch (e) {
      if (e.message !== 'auth') toast(e.message, 'bad');
    }
    busy(btn, false);
  });

  $('games').addEventListener('change', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (!pick) return;
    pick.checked ? pickedGames.add(pick.dataset.pick) : pickedGames.delete(pick.dataset.pick);
    pick.closest('.game').classList.toggle('picked', pick.checked);
    paintBulk();
  });

  $('games').addEventListener('click', async (e) => {
    const t = e.target;

    // клик по чекбоксу не должен раскрывать игру
    if (t.closest('[data-nopick]')) { e.stopPropagation(); return; }

    const delGame = t.closest('[data-delgame]');
    if (delGame) {
      e.stopPropagation();
      const key = delGame.dataset.delgame;
      if (!confirm('Убрать игру вместе с её товарами?')) return;
      await api(`/api/pricing/games/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (openGame === key) openGame = null;
      await reload();
      toast('Игра убрана');
      return;
    }

    const toggle = t.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      openGame = openGame === key ? null : key;
      render();
      return;
    }

    const del = t.closest('[data-del]');
    if (del) {
      await api(`/api/pricing/items/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
      await reload();
      toast('Товар удалён');
      return;
    }

    const add = t.closest('[data-add]');
    if (add) {
      const key = add.dataset.add;
      const box = add.closest('.add-row');
      const get = (f) => box.querySelector(`[data-f="${f}"]`).value;
      if (!get('title').trim()) { toast('Введи название товара', 'bad'); return; }
      busy(add, true);
      try {
        const cashback = get('cost_cashback').trim();
        await api('/api/pricing/items', {
          method: 'POST',
          body: JSON.stringify({
            key, title: get('title'), keywords: get('keywords'), cost: get('cost') || '0',
            cost_cashback: cashback, has_cashback: !!cashback,
          }),
        });
        await reload();
        toast('Товар добавлен', 'good');
      } catch (err) {
        if (err.message !== 'auth') toast(err.message, 'bad');
      }
      busy(add, false);
      return;
    }

    const lots = t.closest('[data-lots]');
    if (lots) {
      const key = lots.dataset.lots;
      busy(lots, true);
      try {
        const data = await api(`/api/pricing/lots?key=${encodeURIComponent(key)}`);
        lotsCache[key] = data.lots;
        renderLots(key);
        toast(`Лотов: ${data.count}`, 'good');
      } catch (err) {
        if (err.message !== 'auth') toast(err.message, 'bad');
      }
      busy(lots, false);
      return;
    }

    const save = t.closest('[data-savelot]');
    if (save) {
      const box = save.closest('.lot');
      const key = save.dataset.savelot;
      const cost = box.querySelector('[data-lf="cost"]').value;
      const cashback = box.querySelector('[data-lf="cost_cashback"]').value.trim();
      if (!cost.trim()) { toast('Укажи закуп', 'bad'); return; }
      busy(save, true);
      try {
        await api('/api/pricing/items', {
          method: 'POST',
          body: JSON.stringify({
            key, title: box.dataset.title, cost,
            cost_cashback: cashback, has_cashback: !!cashback,
            lot_id: box.dataset.lot, price: Number(box.dataset.price),
          }),
        });
        await reload();
        renderLots(key);
        toast('Добавлено в мин. цены', 'good');
      } catch (err) {
        if (err.message !== 'auth') toast(err.message, 'bad');
      }
      busy(save, false);
    }
  });

  // та же логика, что на сервере: сравниваем токены, числа — целиком,
  // иначе «50 голосов» цепляется к «500 голосов»
  const tokens = (v) => String(v ?? '').toLowerCase().match(/\d+|[^\W\d_]+/gu) || [];
  const contains = (hay, needle) => {
    if (!needle.length || needle.length > hay.length) return false;
    return hay.some((_, i) => needle.every((t, j) => hay[i + j] === t));
  };
  const alreadyAdded = (lotTitle, items) => {
    const lot = tokens(lotTitle);
    return items.some((i) => {
      const it = tokens(i.title);
      return contains(lot, it) || contains(it, lot);
    });
  };

  const renderLots = (key) => {
    const box = document.querySelector(`[data-lotsbox="${key}"]`);
    if (!box) return;
    const items = state.items[key] || [];
    box.innerHTML = (lotsCache[key] || []).map((lot) => `
      <div class="lot" data-title="${esc(lot.title)}" data-lot="${esc(lot.id)}" data-price="${esc(lot.price)}">
        <span class="ltitle">${esc(lot.title) || '<span class="muted">без названия</span>'}</span>
        <span class="lprice">${money(lot.price)} ${esc(lot.currency)}</span>
        ${alreadyAdded(lot.title || '', items)
          ? '<span class="pill on">уже в списке</span>'
          : `<input type="text" class="search narrow" data-lf="cost" inputmode="decimal" placeholder="закуп">
             <input type="text" class="search narrow" data-lf="cost_cashback" inputmode="decimal" placeholder="с кэшбеком">
             <button class="btn ghost-btn" data-savelot="${esc(key)}"><span class="label">Добавить</span><span class="spinner"></span></button>`}
      </div>`).join('') || '<p class="muted pad">Лотов в этом разделе нет.</p>';
  };

  // ---------------------------- комиссия ----------------------------

  let feeTimer = null;
  $('fee').addEventListener('input', () => {
    clearTimeout(feeTimer);
    feeTimer = setTimeout(async () => {
      try {
        const data = await api('/api/pricing/fee', {
          method: 'POST',
          body: JSON.stringify({ fee: $('fee').value }),
        });
        state.fee = data.fee;
        toast(`Комиссия ${data.fee}%`, 'good');
      } catch (e) {
        if (e.message !== 'auth') toast(e.message, 'bad');
      }
    }, 700);
  });

  let cbTimer = null;
  $('cashbackMin').addEventListener('input', () => {
    clearTimeout(cbTimer);
    cbTimer = setTimeout(async () => {
      try {
        const data = await api('/api/pricing/cashback-min', {
          method: 'POST',
          body: JSON.stringify({ cashback_min: $('cashbackMin').value }),
        });
        state.cashbackMin = data.cashback_min;
        render();
        toast(`Кэшбек считается от ${money(data.cashback_min)} ₽`, 'good');
      } catch (e) {
        if (e.message !== 'auth') toast(e.message, 'bad');
      }
    }, 700);
  });

  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => ($('user').textContent = d.login))
    .catch(() => (window.location.href = '/login'));

  reload().catch(() => {});
})();
