(() => {
  const $ = (id) => document.getElementById(id);

  const get = async (url) => {
    const res = await fetch(url);
    if (res.status === 401) { window.location.href = '/login'; throw new Error('auth'); }
    return res.json();
  };

  get('/api/me')
    .then((d) => ($('user').textContent = d.login))
    .catch(() => {});

  get('/api/settings')
    .then((d) => {
      const tile = $('fpTile');
      const acc = d.account || {};
      if (acc.id) {
        tile.textContent = `${acc.username} · ID ${acc.id}`;
        tile.style.color = '#4ade80';
      } else if (d.has_key) {
        tile.textContent = `ключ сохранён · ${d.key_mask}`;
      } else {
        tile.textContent = 'не подключён — задай golden key';
      }
    })
    .catch(() => {});

  get('/api/version')
    .then((v) => {
      if (!v.ok) return;
      $('verPill').textContent = `версия ${v.commit}`;
    })
    .catch(() => {});

  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });
})();
