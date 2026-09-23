// Визуальные эффекты: свет за курсором, подсветка карточек, наклон плиток,
// «волна» по клику и плавный пересчёт больших чисел. На логику страниц не влияет.
(() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(pointer: fine)').matches;
  const CARDS = '.panel,.tile,.kpi,.game,.order,.card';

  /* ---------- свет за курсором и подсветка карточек ---------- */
  if (finePointer && !reduce) {
    let x = 0, y = 0, target = null, raf = 0, lastCard = null;

    const tick = () => {
      raf = 0;
      root.style.setProperty('--cx', `${x}px`);
      root.style.setProperty('--cy', `${y}px`);

      const card = target && target.closest ? target.closest(CARDS) : null;
      if (lastCard && lastCard !== card && lastCard.classList.contains('tile')) {
        lastCard.style.setProperty('--rx', '0deg');
        lastCard.style.setProperty('--ry', '0deg');
      }
      lastCard = card;
      if (!card) return;

      const r = card.getBoundingClientRect();
      const mx = x - r.left, my = y - r.top;
      card.style.setProperty('--mx', `${mx}px`);
      card.style.setProperty('--my', `${my}px`);

      if (card.classList.contains('tile')) {
        const px = mx / r.width - 0.5, py = my / r.height - 0.5;
        card.style.setProperty('--ry', `${(px * 7).toFixed(2)}deg`);
        card.style.setProperty('--rx', `${(-py * 7).toFixed(2)}deg`);
      }
    };

    addEventListener('pointermove', (e) => {
      x = e.clientX; y = e.clientY; target = e.target;
      if (!raf) raf = requestAnimationFrame(tick);
    }, { passive: true });

    document.addEventListener('pointerleave', () => { target = null; if (!raf) raf = requestAnimationFrame(tick); });
  }

  /* ---------- волна по клику ---------- */
  if (!reduce) {
    document.addEventListener('pointerdown', (e) => {
      const b = e.target.closest && e.target.closest('.btn,.submit,.ghost,.tab,.chips button');
      if (!b || b.disabled) return;
      const r = b.getBoundingClientRect();
      const d = Math.max(r.width, r.height) * 2.2;
      const s = document.createElement('span');
      s.className = 'ripple';
      s.setAttribute('aria-hidden', 'true');
      s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
      b.appendChild(s);
      s.addEventListener('animationend', () => s.remove());
      setTimeout(() => s.remove(), 900);
    });
  }

  /* ---------- плавный пересчёт чисел ---------- */
  if (reduce) return;

  const NUM = /-?\d[\d\s  ]*(?:[.,]\d+)?/;
  const parse = (txt) => {
    const m = txt.match(NUM);
    if (!m) return null;
    const raw = m[0].trim();
    const dec = (raw.split(/[.,]/)[1] || '').length;
    const n = parseFloat(raw.replace(/[\s  ]/g, '').replace(',', '.'));
    if (!isFinite(n)) return null;
    return { n, dec, idx: m.index, len: m[0].length, raw: m[0] };
  };
  const fmt = (v, dec, sample) => {
    const s = Math.abs(v).toFixed(dec).split('.');
    const sep = / /.test(sample) ? ' ' : / /.test(sample) ? ' ' : ' ';
    const grouped = /\d[\s  ]\d/.test(sample) ? s[0].replace(/\B(?=(\d{3})+(?!\d))/g, sep) : s[0];
    const decSep = sample.includes(',') ? ',' : '.';
    return (v < 0 ? '-' : '') + grouped + (s[1] ? decSep + s[1] : '');
  };

  const running = new WeakMap();
  const animate = (el) => {
    const final = el.textContent;
    if (el._fxLast === final) return;          // это наш собственный кадр
    const p = parse(final);
    if (!p || Math.abs(p.n) < 1) return;
    const from = typeof el._fxValue === 'number' ? el._fxValue : 0;
    el._fxValue = p.n;
    if (from === p.n) return;

    cancelAnimationFrame(running.get(el));
    const t0 = performance.now(), dur = 900;
    const before = final.slice(0, p.idx), after = final.slice(p.idx + p.len);
    const trail = /\s$/.test(p.raw) ? p.raw.match(/\s+$/)[0] : '';

    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 4);
      const txt = k < 1 ? before + fmt(from + (p.n - from) * e, p.dec, p.raw) + trail + after : final;
      el._fxLast = txt;
      el.textContent = txt;
      if (k < 1) running.set(el, requestAnimationFrame(step));
    };
    running.set(el, requestAnimationFrame(step));
  };

  const SEL = '.hero-value,.kpi-value';
  const scan = (node) => {
    if (node.nodeType !== 1) node = node.parentElement;
    if (!node) return;
    if (node.matches && node.matches(SEL)) animate(node);
    node.querySelectorAll && node.querySelectorAll(SEL).forEach(animate);
  };

  const start = () => {
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') scan(m.target);
        else { scan(m.target); m.addedNodes.forEach(scan); }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start(); else addEventListener('DOMContentLoaded', start);
})();
