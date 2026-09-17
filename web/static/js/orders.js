(() => {
  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  let nextFrom = null;
  let loading = false;
  let all = [];

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

  const row = (o) => `
    <a class="order" href="${esc(o.link)}" target="_blank" rel="noopener noreferrer">
      <span class="oid">#${esc(o.id)}</span>
      <span class="otitle">
        ${esc(o.title) || '<span class="muted">без описания</span>'}
        <span class="ocat">${esc(o.category || '')}${o.amount && o.amount > 1 ? ` · ${o.amount} шт` : ''}</span>
      </span>
      <span class="obuyer">${esc(o.buyer)}</span>
      <span class="ostatus st-${esc(o.status_code)}">${esc(o.status)}</span>
      <span class="oprice">${money(o.price)} ${esc(o.currency)}</span>
      <span class="odate">${when(o.date)}</span>
    </a>`;

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
      $('footHint').textContent = nextFrom
        ? `Показано ${all.length}. Есть ещё — жми кнопку.`
        : `Это все заказы: ${all.length}.`;
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
