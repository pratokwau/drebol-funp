(() => {
  const form = document.getElementById('loginForm');
  const card = document.getElementById('card');
  const btn = document.getElementById('submit');
  const err = document.getElementById('error');
  const eye = document.getElementById('eye');
  const pwd = document.getElementById('password');

  eye.addEventListener('click', () => {
    const show = pwd.type === 'password';
    pwd.type = show ? 'text' : 'password';
    eye.classList.toggle('off', show);
    pwd.focus();
  });

  const showError = (msg) => {
    err.textContent = msg;
    err.classList.add('show');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.remove('show');
    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const res = await fetch('/api/login', { method: 'POST', body: new FormData(form) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        card.style.transition = 'opacity .35s ease, transform .35s ease';
        card.style.opacity = '0';
        card.style.transform = 'translateY(-12px) scale(.98)';
        setTimeout(() => (window.location.href = '/'), 300);
        return;
      }
      showError(data.error || 'Не удалось войти');
    } catch {
      showError('Сервер недоступен');
    }
    btn.classList.remove('loading');
    btn.disabled = false;
  });

  document.getElementById('login').focus();
})();
