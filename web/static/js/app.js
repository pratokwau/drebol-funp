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
      tile.textContent = d.has_key ? `ключ сохранён · ${d.key_mask}` : 'не подключён — задай golden key';
      tile.style.color = d.has_key ? '#4ade80' : '';
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
