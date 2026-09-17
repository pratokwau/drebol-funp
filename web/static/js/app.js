(() => {
  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => (document.getElementById('user').textContent = d.login))
    .catch(() => (window.location.href = '/login'));

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });
})();
