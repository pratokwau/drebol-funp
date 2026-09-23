(() => {
  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  const tip = $('tip');
  const STORE = 'drebol-profit-filters';

  // цвета графиков: проверены валидатором на поверхности карточки (#101015)
  const C = {
    pos: '#c6ff3d',              // прибыль, выручка, заказы (акцент темы)
    neg: '#ff6b6b',              // отрицательная прибыль (второй полюс)
    grid: '#1d1f24',
    base: '#363a42',
    muted: '#7d828c',
    ramp: ['#27330f', '#44591a', '#6f8f22', '#a3cf2e', '#d4ff6a'],  // теплокарта: меньше -> больше
    empty: '#15171b',
  };

  const defaults = {
    period: '30d', from: '', to: '',
    statuses: ['closed', 'paid'], game: '', group: '', onlyMatched: false,
  };
  let f = (() => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return { ...defaults }; }
  })();
  let metric = 'profit';
  let report = null;
  let pollTimer = null;

  // ---------------------------- утилиты ----------------------------
  const toast = (msg, kind = '') => {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${kind}`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.className = 'toast'), 3200);
  };
  const busy = (btn, on) => { btn.classList.toggle('loading', on); btn.disabled = on; };
  const rub = (v, digits = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)))
    ? '—'
    : `${Number(v).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ₽`;
  const signed = (v) => (v > 0 ? '+' : '') + rub(v);
  const int = (v) => Number(v || 0).toLocaleString('ru-RU');
  const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`);
  const compact = (v) => {
    const a = Math.abs(v);
    if (a >= 1e6) return `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`;
    if (a >= 1e3) return `${(v / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} тыс`;
    return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(f)); } catch { /* приватный режим */ } };

  const api = async (url, options = {}) => {
    const res = await fetch(url, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined, ...options,
    });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('auth'); }
    return res.json().catch(() => ({}));
  };

  // ---------------------------- подсказка ----------------------------
  const showTip = (evt, value, label, color, extra = []) => {
    tip.replaceChildren();
    const head = el('div', 'tip-row');
    const key = el('span', 'tip-key');
    key.style.background = color;
    head.append(key, el('strong', 'tip-value', value));
    tip.append(head, el('div', 'tip-label', label));
    extra.forEach((line) => tip.append(el('div', 'tip-extra', line)));
    tip.hidden = false;
    const r = evt.target.getBoundingClientRect ? evt.target.getBoundingClientRect() : null;
    const x = evt.clientX ?? (r ? r.left + r.width / 2 : 0);
    const y = evt.clientY ?? (r ? r.top : 0);
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(window.innerWidth - w - 12, Math.max(12, x - w / 2))}px`;
    tip.style.top = `${Math.max(12, y - h - 14)}px`;
  };
  const hideTip = () => { tip.hidden = true; };

  // ---------------------------- фильтры ----------------------------
  const paintFilters = () => {
    document.querySelectorAll('#periods [data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === f.period));
    $('customRange').hidden = f.period !== 'custom';
    $('dateFrom').value = f.from;
    $('dateTo').value = f.to;
    document.querySelectorAll('#statuses [data-s]').forEach((b) => b.classList.toggle('on', f.statuses.includes(b.dataset.s)));
    $('group').value = f.group;
    $('onlyMatched').checked = f.onlyMatched;
  };

  const changed = () => { save(); paintFilters(); load(); };

  document.querySelectorAll('#periods [data-p]').forEach((b) => b.addEventListener('click', () => {
    f.period = b.dataset.p;
    if (f.period === 'custom' && !f.from) {
      const t = new Date();
      f.to = t.toISOString().slice(0, 10);
      f.from = new Date(t - 13 * 864e5).toISOString().slice(0, 10);
    }
    changed();
  }));
  ['dateFrom', 'dateTo'].forEach((id) => $(id).addEventListener('change', () => {
    f.from = $('dateFrom').value; f.to = $('dateTo').value; changed();
  }));
  document.querySelectorAll('#statuses [data-s]').forEach((b) => b.addEventListener('click', () => {
    const s = b.dataset.s;
    const next = f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : [...f.statuses, s];
    if (!next.length) { toast('Нужен хотя бы один статус'); return; }
    f.statuses = next; changed();
  }));
  $('game').addEventListener('change', () => { f.game = $('game').value; changed(); });
  $('group').addEventListener('change', () => { f.group = $('group').value; changed(); });
  $('onlyMatched').addEventListener('change', () => { f.onlyMatched = $('onlyMatched').checked; changed(); });
  document.querySelectorAll('#metricTabs [data-m]').forEach((b) => b.addEventListener('click', () => {
    metric = b.dataset.m;
    document.querySelectorAll('#metricTabs [data-m]').forEach((x) => x.classList.toggle('active', x === b));
    if (report) renderTrend(report);
  }));
  document.querySelectorAll('.table-toggle').forEach((b) => b.addEventListener('click', () => {
    const t = $(b.dataset.table);
    t.hidden = !t.hidden;
    b.textContent = t.hidden ? 'Показать таблицей' : 'Скрыть таблицу';
  }));

  // ---------------------------- отчёт ----------------------------
  const load = async () => {
    const q = new URLSearchParams({
      period: f.period, date_from: f.from, date_to: f.to,
      statuses: f.statuses.join(','), game: f.game, group: f.group, only_matched: f.onlyMatched,
    });
    $('report').classList.add('refetch');     // держим прошлую картинку, без скелетонов
    try {
      const r = await api(`/api/profit/report?${q}`);
      if (!r.ok) { toast(r.error || 'Не удалось построить отчёт', 'bad'); return; }
      report = r;
      render(r);
    } catch (e) {
      if (e.message !== 'auth') toast('Сервер недоступен', 'bad');
    } finally {
      $('report').classList.remove('refetch');
    }
  };

  const render = (r) => {
    const empty = !r.cache.cached;
    $('report').hidden = empty;
    $('emptyState').hidden = !empty;
    if (empty) {
      $('emptyState').replaceChildren(
        el('h3', '', 'Заказов в базе пока нет'),
        el('p', 'muted', 'Нажми «Загрузить всю историю» — панель скачает продажи с FunPay и дальше будет докачивать только новые.'),
      );
      return;
    }

    // список разделов, выбранный сохраняем
    const sel = $('game');
    const keep = f.game;
    sel.replaceChildren(new Option('Все разделы', ''));
    r.categories.forEach((c) => sel.append(new Option(c, c)));
    sel.value = r.categories.includes(keep) ? keep : '';

    renderHero(r);
    renderKpis(r);
    renderTrend(r);
    renderTable('products', r.products, 'Товар', 'Товаров с закупом за период нет.');
    renderTable('games', r.games, 'Раздел', 'Нет продаж за период.');
    renderTable('buyers', r.buyers, 'Покупатель', 'Нет продаж за период.');
    renderLosses(r.losses);
    renderHeat(r);
    renderUnmatched(r.unmatched);
  };

  const periodText = (r) => {
    const p = r.period;
    const d = (s) => (s ? s.split('-').reverse().join('.') : '');
    return p.key === 'custom' || p.key === 'all' ? `${d(p.from)} — ${d(p.to)}` : p.label.toLowerCase();
  };

  const renderHero = (r) => {
    const t = r.totals;
    $('heroLabel').textContent = `Чистая прибыль · ${periodText(r)}`;
    $('heroValue').textContent = signed(t.profit);
    $('heroValue').className = `hero-value ${t.profit < 0 ? 'neg' : ''}`;

    const delta = $('heroDelta');
    delta.replaceChildren();
    if (r.prev && (r.prev.profit || t.profit)) {
      const diff = t.profit - r.prev.profit;
      const base = Math.abs(r.prev.profit);
      const up = diff >= 0;
      const box = el('span', `delta ${up ? 'up' : 'down'}`);
      box.append(el('span', 'arrow', up ? '▲' : '▼'),
        el('span', '', `${signed(diff)}${base ? ` (${up ? '+' : ''}${pct((diff / base) * 100)})` : ''}`));
      delta.append(box, el('span', 'muted', ` к предыдущему такому же периоду (${signed(r.prev.profit)})`));
    }

    // из чего сложилась прибыль
    const side = $('heroSide');
    side.replaceChildren();
    const feePart = t.matched_revenue - t.net_matched;
    [
      ['Выручка с закупом', rub(t.matched_revenue), ''],
      [`Комиссия FunPay ${pct(r.fee_percent)}`, `−${rub(feePart)}`, ''],
      ['Закуп', `−${rub(t.cost)}`, ''],
      ['Прибыль', signed(t.profit), 'total'],
    ].forEach(([k, v, cls]) => {
      const row = el('div', `eq ${cls}`);
      row.append(el('span', 'k', k), el('span', 'v', v));
      side.append(row);
    });

    const warn = $('warnBar');
    const parts = [];
    if (t.unmatched) parts.push(`${int(t.unmatched)} из ${int(t.orders)} заказов без закупа — в прибыль не вошли`);
    if (t.zero_cost) parts.push(`${int(t.zero_cost)} с нулевым закупом`);
    if (t.undecided) parts.push(`в ${int(t.undecided)} не выбран закуп с кэшбеком или без — посчитаны без кэшбека`);
    if (t.no_game) parts.push(`${int(t.no_game)} разделов FunPay не добавлены в «Мин. цены»`);
    warn.hidden = !parts.length;
    if (parts.length) {
      warn.replaceChildren(el('span', 'icon', '⚠'), el('span', '', `${parts.join('; ')}.`));
      const onlyChoice = !t.unmatched && !t.zero_cost;
      const a = el('a', '', onlyChoice ? 'Выбрать в «Заказах» →' : 'Заведи цены в «Мин. ценах» →');
      a.href = onlyChoice ? '/orders' : '/pricing';
      warn.append(a);
    }
  };

  const renderKpis = (r) => {
    const t = r.totals;
    const tiles = [
      ['Выручка', rub(t.revenue), `${int(t.orders)} заказов`],
      ['Комиссия FunPay', rub(t.fee), `на баланс ${rub(t.net)}`],
      ['Закуп', rub(t.cost), `по ${int(t.matched)} заказам`],
      ['Маржа', pct(t.margin), 'прибыль / выручка'],
      ['ROI', pct(t.roi), 'прибыль / закуп'],
      ['Средний чек', rub(t.avg_check), `прибыль с заказа ${rub(t.avg_profit)}`],
      ['Кэшбек дал', rub(t.cashback_saved), `в ${int(t.cashback_orders)} заказах${t.undecided ? ` · не выбрано ${int(t.undecided)}` : ''}`],
      ['Возвраты', rub(r.refunds.sum), `${int(r.refunds.count)} шт за период`],
      ['В минус', int(t.loss_orders), 'убыточных продаж'],
    ];
    const box = $('kpis');
    box.replaceChildren();
    tiles.forEach(([label, value, sub], i) => {
      const tile = el('div', 'kpi');
      tile.style.setProperty('--i', i);
      tile.append(el('span', 'kpi-label', label), el('span', 'kpi-value', value), el('span', 'kpi-sub', sub));
      box.append(tile);
    });
  };

  // ---------------------------- динамика ----------------------------
  const niceTicks = (min, max, count = 5) => {
    if (min === max) { max = min + 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  };

  const barPath = (x, yBase, yVal, w) => {
    const h = Math.abs(yBase - yVal);
    if (h < 0.5) return '';
    const r = Math.min(4, w / 2, h);
    if (yVal < yBase) {   // вверх: скругляем верхний конец, основание прямое
      return `M${x},${yBase}V${yVal + r}Q${x},${yVal} ${x + r},${yVal}H${x + w - r}Q${x + w},${yVal} ${x + w},${yVal + r}V${yBase}Z`;
    }
    return `M${x},${yBase}V${yVal - r}Q${x},${yVal} ${x + r},${yVal}H${x + w - r}Q${x + w},${yVal} ${x + w},${yVal - r}V${yBase}Z`;
  };

  const METRIC = {
    profit: { title: 'Прибыль', fmt: signed, tick: compact },
    revenue: { title: 'Выручка', fmt: rub, tick: compact },
    orders: { title: 'Заказы', fmt: int, tick: (v) => v.toLocaleString('ru-RU') },
  };
  const GROUP = { day: 'по дням', week: 'по неделям', month: 'по месяцам' };

  const renderTrend = (r) => {
    const m = METRIC[metric];
    const rows = r.series;
    $('trendTitle').textContent = `${m.title} ${GROUP[r.group] || ''}`;
    $('trendNote').textContent = metric === 'profit'
      ? 'Только заказы с закупом. Ниже нуля — продажи в минус.'
      : metric === 'revenue' ? 'Все заказы выбранных статусов.' : 'Количество заказов.';

    const host = $('trend');
    host.replaceChildren();
    if (!rows.length) { host.append(el('p', 'muted pad', 'Нет данных за период.')); return; }

    const W = Math.max(320, host.clientWidth), H = 280;
    const pad = { l: 64, r: 12, t: 22, b: 32 };
    const vals = rows.map((x) => x[metric]);
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const y = (v) => pad.t + ((hi - v) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const band = (W - pad.l - pad.r) / rows.length;
    const bw = Math.max(2, Math.min(24, band * 0.62));

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${m.title}, ${rows.length} интервалов`);
    const add = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
      if (text !== undefined) n.textContent = text;
      svg.append(n);
      return n;
    };

    ticks.forEach((t) => {
      add('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), stroke: t === 0 ? C.base : C.grid, 'stroke-width': 1 });
      add('text', { x: pad.l - 10, y: y(t) + 4, 'text-anchor': 'end', class: 'axis' }, m.tick(t));
    });

    const every = Math.max(1, Math.ceil(rows.length / Math.floor((W - pad.l) / 64)));
    let extreme = 0;
    rows.forEach((row, i) => { if (Math.abs(row[metric]) > Math.abs(rows[extreme][metric])) extreme = i; });

    rows.forEach((row, i) => {
      const v = row[metric];
      const cx = pad.l + band * i + band / 2;
      const color = metric === 'profit' && v < 0 ? C.neg : C.pos;
      const d = barPath(cx - bw / 2, y(0), y(v), bw);
      if (d) add('path', { d, fill: color, class: 'bar' });

      if (i % every === 0) add('text', { x: cx, y: H - 10, 'text-anchor': 'middle', class: 'axis' }, row.label);

      // подпись только у крайнего значения — остальное в подсказке и таблице
      if (i === extreme && v !== 0) {
        add('text', { x: cx, y: v >= 0 ? y(v) - 7 : y(v) + 15, 'text-anchor': 'middle', class: 'val' }, m.tick(v));
      }

      // зона наведения — вся полоса, а не только столбик.
      // данные кладём в сам элемент: на телефоне сотни обработчиков заметно тормозят
      const extra = [];
      if (metric !== 'orders') extra.push(`заказов: ${int(row.orders)}`);
      if (metric === 'profit' && row.matched < row.orders) extra.push(`с закупом: ${int(row.matched)} из ${int(row.orders)}`);
      if (metric !== 'revenue') extra.push(`выручка: ${rub(row.revenue)}`);
      add('rect', {
        x: pad.l + band * i, y: pad.t, width: band, height: H - pad.t - pad.b,
        fill: 'transparent', tabindex: 0, class: 'hit',
        'data-value': m.fmt(v), 'data-label': row.label, 'data-color': color,
        'data-extra': extra.join('|'),
      });
    });

    const tipFromEl = (e, el) => showTip(e, el.dataset.value, el.dataset.label, el.dataset.color,
      el.dataset.extra ? el.dataset.extra.split('|') : []);
    svg.addEventListener('pointermove', (e) => {
      const hit = e.target.closest('.hit');
      if (hit) tipFromEl(e, hit); else hideTip();
    });
    svg.addEventListener('pointerleave', hideTip);
    svg.addEventListener('focusin', (e) => { if (e.target.classList.contains('hit')) tipFromEl(e, e.target); });
    svg.addEventListener('focusout', hideTip);

    host.append(svg);

    // табличный вид того же графика
    const table = el('table', 'data');
    const head = el('tr');
    ['Интервал', 'Заказов', 'С закупом', 'Выручка', 'Прибыль'].forEach((h) => head.append(el('th', '', h)));
    table.append(head);
    rows.forEach((row) => {
      const tr = el('tr');
      tr.append(el('td', '', row.label), el('td', 'num', int(row.orders)), el('td', 'num', int(row.matched)),
        el('td', 'num', rub(row.revenue)), el('td', `num ${row.profit < 0 ? 'neg' : ''}`, signed(row.profit)));
      table.append(tr);
    });
    $('trendTable').replaceChildren(table);
  };

  // ---------------------------- таблицы с полосками ----------------------------
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

  const renderTable = (id, rows, firstCol, emptyText, expanded = false) => {
    const host = $(id);
    host.replaceChildren();
    if (!rows.length) { host.append(el('p', 'muted pad', emptyText)); return; }

    // на телефоне длинные таблицы рисуем частями — иначе страница еле ворочается
    const limit = isPhone() && !expanded ? 8 : rows.length;
    const visible = rows.slice(0, limit);
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.profit)), 1);
    const table = el('table', 'data');
    const head = el('tr');
    [firstCol, 'Продаж', 'Выручка', 'Прибыль', 'Маржа'].forEach((h) => head.append(el('th', '', h)));
    table.append(head);

    visible.forEach((r) => {
      const tr = el('tr');
      const name = el('td', 'name', r.name);
      name.title = r.name;
      // полоска в своей дорожке слева от числа — текст никогда её не перекрывает
      const profitCell = el('td', 'num bar-cell');
      const wrap = el('span', 'bar-wrap');
      const track = el('span', 'track');
      const bar = el('span', `inbar ${r.profit < 0 ? 'neg' : ''}`);
      bar.style.width = `${Math.max(3, (Math.abs(r.profit) / maxAbs) * 100)}%`;
      if (!r.matched) bar.hidden = true;
      track.append(bar);
      wrap.append(track, el('span', `v ${r.profit < 0 ? 'neg' : ''}`, r.matched ? signed(r.profit) : '—'));
      profitCell.append(wrap);
      tr.append(name, el('td', 'num', int(r.orders)), el('td', 'num', rub(r.revenue)), profitCell,
        el('td', 'num', pct(r.margin)));
      table.append(tr);
    });
    host.append(table);

    if (rows.length > visible.length) {
      const more = el('button', 'mini-btn', `Показать все (${rows.length})`);
      more.addEventListener('click', () => renderTable(id, rows, firstCol, emptyText, true));
      host.append(more);
    }
  };

  const renderLosses = (rows) => {
    const host = $('losses');
    host.replaceChildren();
    if (!rows.length) { host.append(el('p', 'muted pad', 'Убыточных продаж нет 👍')); return; }
    const table = el('table', 'data');
    const head = el('tr');
    ['Заказ', 'Продажа', 'Закуп', 'Итог'].forEach((h) => head.append(el('th', '', h)));
    table.append(head);
    rows.forEach((o) => {
      const tr = el('tr');
      const name = el('td', 'name');
      const a = el('a', '', o.title || `#${o.id}`);
      a.href = o.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      name.append(a, el('span', 'sub', `#${o.id} · ${(o.date || '').slice(0, 10).split('-').reverse().join('.')}`));
      tr.append(name, el('td', 'num', rub(o.price)), el('td', 'num', rub(o.cost)), el('td', 'num neg', signed(o.profit)));
      table.append(tr);
    });
    host.append(table);
  };

  const renderUnmatched = (rows) => {
    $('unmatchedCard').hidden = !rows.length;
    const host = $('unmatched');
    host.replaceChildren();
    if (!rows.length) return;
    const table = el('table', 'data');
    const head = el('tr');
    ['Название в заказе', 'Продаж', 'Выручка'].forEach((h) => head.append(el('th', '', h)));
    table.append(head);
    rows.forEach((r) => {
      const tr = el('tr');
      tr.append(el('td', 'name', r.name), el('td', 'num', int(r.orders)), el('td', 'num', rub(r.revenue)));
      table.append(tr);
    });
    host.append(table);
  };

  // ---------------------------- теплокарта ----------------------------
  const renderHeat = (r) => {
    const host = $('heat');
    host.replaceChildren();

    // на телефоне 24 колонки дают ячейку в 8px — склеиваем часы по два
    const span = isPhone() ? 2 : 1;
    const cols = 24 / span;
    const heat = r.heat.map((row) => Array.from({ length: cols }, (_, i) =>
      row.slice(i * span, i * span + span).reduce((a, b) => a + b, 0)));
    host.style.gridTemplateColumns = `var(--hl) repeat(${cols}, minmax(0, 1fr)) var(--ht)`;
    const max = Math.max(...heat.flat(), 0);
    const step = (v) => (v <= 0 ? -1 : Math.min(C.ramp.length - 1, Math.floor(((v - 1) / Math.max(1, max)) * C.ramp.length)));

    host.append(el('span', 'hl'));
    for (let i = 0; i < cols; i++) {
      const hour = i * span;
      host.append(el('span', 'hh', hour % (span === 1 ? 3 : 6) === 0 ? String(hour) : ''));
    }
    host.append(el('span', 'hh total', 'всего'));

    heat.forEach((row, d) => {
      host.append(el('span', 'hl', r.weekdays[d].name));
      row.forEach((v, h) => {
        const cell = el('span', 'hc');
        const s = step(v);
        cell.style.background = s < 0 ? C.empty : C.ramp[s];
        cell.tabIndex = 0;
        cell.dataset.value = `${int(v)} заказов`;
        const from = h * span, to = (from + span) % 24;
        cell.dataset.label = `${r.weekdays[d].name}, ${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00`;
        cell.dataset.color = s < 0 ? C.empty : C.ramp[s];
        host.append(cell);
      });
      host.append(el('span', 'ht', int(r.weekdays[d].orders)));
    });

    if (!host.dataset.bound) {
      const show = (e) => {
        const cell = e.target.closest('.hc');
        if (cell) showTip(e, cell.dataset.value, cell.dataset.label, cell.dataset.color);
        else hideTip();
      };
      host.addEventListener('pointermove', show);
      host.addEventListener('pointerleave', hideTip);
      host.addEventListener('focusin', show);
      host.addEventListener('focusout', hideTip);
      host.dataset.bound = '1';
    }

    const legend = $('heatLegend');
    legend.replaceChildren(el('span', 'muted', '0'));
    const sw0 = el('span', 'sw'); sw0.style.background = C.empty; legend.append(sw0);
    C.ramp.forEach((c) => { const sw = el('span', 'sw'); sw.style.background = c; legend.append(sw); });
    legend.append(el('span', 'muted', `до ${int(max)} заказов ${span === 1 ? 'в час' : 'за 2 часа'}`));
  };

  // ---------------------------- синхронизация ----------------------------
  const ago = (iso) => {
    if (!iso) return 'никогда';
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) return `${Math.round(s / 60)} мин назад`;
    if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
    return new Date(iso).toLocaleDateString('ru-RU');
  };

  const paintSync = (st) => {
    const info = $('syncInfo');
    const d = (s) => (s ? s.slice(0, 10).split('-').reverse().join('.') : '');
    let text = `Заказов в базе: ${int(st.cached)}`;
    if (st.oldest) text += ` · с ${d(st.oldest)} по ${d(st.newest)}`;
    text += ` · обновлено ${ago(st.synced_at)}`;
    if (!st.full_synced_at && st.cached) text += ' · история загружена не полностью';
    if (st.running) text = `Загружаю заказы с FunPay: страниц ${int(st.pages)}, заказов ${int(st.fetched)}, новых ${int(st.new)}...`;
    if (st.error && !st.running) text += ` · ошибка: ${st.error}`;
    info.textContent = text;

    const bar = $('syncBar');
    bar.hidden = !st.running;
    busy($('syncBtn'), st.running && st.mode === 'new');
    busy($('fullBtn'), st.running && st.mode === 'full');
    $('syncBtn').disabled = st.running;
    $('fullBtn').disabled = st.running;
  };

  const poll = () => {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const st = await api('/api/profit/sync').catch(() => null);
      if (!st) return;
      paintSync(st);
      if (!st.running) {
        clearInterval(pollTimer);
        if (st.error) toast(st.error, 'bad');
        else toast(`Готово: новых заказов ${int(st.new)}`, 'good');
        load();
      }
    }, 1500);
  };

  const sync = async (full) => {
    const r = await api('/api/profit/sync', { method: 'POST', body: JSON.stringify({ full }) });
    if (!r.ok) { toast(r.error || 'Не удалось запустить', 'bad'); if (r.running) poll(); return; }
    paintSync(r);
    poll();
  };

  $('syncBtn').addEventListener('click', () => sync(false));
  $('fullBtn').addEventListener('click', () => {
    if (!confirm('Скачать всю историю продаж? На больших аккаунтах это займёт несколько минут — страницы идут по одной, чтобы FunPay не заблокировал.')) return;
    sync(true);
  });

  // ---------------------------- старт ----------------------------
  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });
  fetch('/api/me').then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => ($('user').textContent = d.login)).catch(() => (window.location.href = '/login'));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => report && renderTrend(report), 150);
  });

  paintFilters();
  (async () => {
    const st = await api('/api/profit/sync').catch(() => null);
    if (st) {
      paintSync(st);
      if (st.running) poll();
      // база старше 10 минут — тихо докачиваем новое
      else if (st.cached && (!st.synced_at || Date.now() - new Date(st.synced_at) > 10 * 60 * 1000)) sync(false);
    }
    load();
  })();
})();
