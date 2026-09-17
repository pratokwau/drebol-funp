(() => {
  const $ = (id) => document.getElementById(id);
  const inputs = ['cost', 'sell', 'want', 'fee', 'qty'].map($);
  const toastEl = $('toast');
  const STORE_KEY = 'drebol-calc';
  let mode = 'profit';

  const toast = (msg, kind = '') => {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${kind}`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.className = 'toast'), 2600);
  };

  // "1 099,50" -> 1099.5
  const num = (el) => {
    const raw = (el.value || '').replace(/\s/g, '').replace(',', '.');
    if (!raw) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };

  // формат как в примере: 1099.00, -8.14
  const fmt = (v) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(2));

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        mode, fee: $('fee').value, qty: $('qty').value,
      }));
    } catch { /* приватный режим — переживём */ }
  };

  const restore = () => {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      $('fee').value = d.fee ?? '3';
      $('qty').value = d.qty ?? '1';
      if (d.mode === 'price') setMode('price');
    } catch {
      $('fee').value = '3';
      $('qty').value = '1';
    }
  };

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === next));
    $('sellWrap').hidden = next === 'price';
    $('wantWrap').hidden = next !== 'price';
    calc();
  }

  function calc() {
    const cost = num($('cost'));
    const feePct = num($('fee'));
    const qty = num($('qty')) || 1;
    const fee = feePct === null ? 0 : feePct / 100;

    let sell;
    if (mode === 'price') {
      // какую цену выставить, чтобы получить желаемую прибыль
      const want = num($('want'));
      sell = cost === null || want === null || fee >= 1 ? null : (cost + want) / (1 - fee);
      $('sell').value = sell === null ? '' : sell.toFixed(2);
    } else {
      sell = num($('sell'));
    }

    const ready = cost !== null && sell !== null && feePct !== null;
    const feeSum = ready ? sell * fee : null;
    const net = ready ? sell - feeSum : null;       // придёт на баланс
    const profit = ready ? net - cost : null;        // за одну штуку
    const total = ready ? profit * qty : null;
    const breakEven = cost !== null && fee < 1 ? cost / (1 - fee) : null;
    const margin = ready && cost > 0 ? (profit / cost) * 100 : null;

    $('rCost').textContent = fmt(cost);
    $('rSell').textContent = fmt(sell);
    $('rFee').textContent = feePct === null ? '—' : `${fmt(feePct)}%`;
    $('rProfit').textContent = ready
      ? `${profit > 0 ? '+' : ''}${fmt(profit)}${qty > 1 ? ` × ${qty} = ${profit > 0 ? '+' : ''}${fmt(total)}` : ''}`
      : '—';

    const line = $('profitLine');
    line.classList.toggle('good', ready && profit > 0);
    line.classList.toggle('bad', ready && profit < 0);

    $('xFee').textContent = fmt(feeSum);
    $('xNet').textContent = fmt(net);
    $('xMargin').textContent = margin === null ? '—' : `${margin > 0 ? '+' : ''}${fmt(margin)}%`;
    $('xBreak').textContent = fmt(breakEven);

    const hint = $('hint');
    if (!ready) {
      hint.textContent = mode === 'price'
        ? 'Введи цену закупа и желаемую прибыль — посчитаю, за сколько выставлять.'
        : 'Введи цену закупа, цену продажи и комиссию.';
    } else if (profit < 0) {
      hint.textContent = `В минусе. Чтобы выйти в ноль, продавай минимум за ${fmt(breakEven)} — это на ${fmt(breakEven - sell)} дороже текущей цены.`;
    } else if (profit === 0) {
      hint.textContent = 'Ровно в ноль — комиссия съедает всю наценку.';
    } else {
      hint.textContent = `С каждой продажи остаётся ${fmt(profit)}. Безубыточная цена — ${fmt(breakEven)}.`;
    }
    save();
  }

  const text = () => {
    const qty = num($('qty')) || 1;
    const lines = [
      '📊 Результаты расчёта',
      '',
      `🛒 Цена товара: ${$('rCost').textContent}`,
      `💰 Цена продажи: ${$('rSell').textContent}`,
      `🏦 Комиссия: ${$('rFee').textContent}`,
      '',
      `💎 Чистая прибыль: ${$('rProfit').textContent} 💎`,
    ];
    if (qty > 1) lines.push(`📦 Количество: ${qty} шт`);
    return lines.join('\n');
  };

  $('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text());
      toast('Расчёт скопирован', 'good');
    } catch {
      toast('Браузер не дал доступ к буферу', 'bad');
    }
  });

  $('resetBtn').addEventListener('click', () => {
    ['cost', 'sell', 'want'].forEach((id) => ($(id).value = ''));
    $('fee').value = '3';
    $('qty').value = '1';
    calc();
    $('cost').focus();
  });

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setMode(t.dataset.mode)));

  inputs.forEach((el) => el.addEventListener('input', calc));

  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => ($('user').textContent = d.login))
    .catch(() => (window.location.href = '/login'));

  restore();
  calc();
  $('cost').focus();
})();
