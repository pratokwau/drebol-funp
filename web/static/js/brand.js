// Логотип сайта: если в data/brand лежит свой файл — показываем его вместо монограммы DF
(() => {
  fetch('/api/brand')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => {
      if (!d.logo) return;
      document.querySelectorAll('.logo-mark').forEach((mark) => {
        const img = new Image();
        img.src = d.logo;
        img.alt = 'Логотип';
        img.addEventListener('load', () => {
          mark.classList.add('has-img');
          mark.replaceChildren(img);
        });
      });
    })
    .catch(() => { /* своего логотипа нет — остаётся монограмма */ });
})();
