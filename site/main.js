// Highlight the download for the visitor's system and point the top button at it.
const ua = navigator.userAgent;
const os = /Mac/.test(ua) ? 'mac' : /Win/.test(ua) ? 'win' : /Linux|X11/.test(ua) ? 'linux' : null;
const card = os && document.querySelector(`.dl[data-os="${os}"]`);
if (card) {
  card.classList.add('mine');
  const main = document.getElementById('dl-main');
  main.textContent = `下载 ${card.querySelector('h3').textContent} 版`;
}

// Click an animation to see it full size.
const box = document.querySelector('.lightbox');
for (const img of document.querySelectorAll('img.zoomable')) {
  img.addEventListener('click', () => {
    box.querySelector('img').src = img.src;
    box.querySelector('img').alt = img.alt;
    box.hidden = false;
  });
}
box.addEventListener('click', () => (box.hidden = true));
addEventListener('keydown', (e) => e.key === 'Escape' && (box.hidden = true));

// Sections fade in as they scroll into view.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) (e.target.classList.add('in'), io.unobserve(e.target));
  },
  { threshold: 0.12 },
);
const sections = document.querySelectorAll('.heads, .feature, .grid-wrap, .download');
for (const el of sections) {
  el.classList.add('reveal');
  io.observe(el);
}
// Never leave a section hidden if the observer does not fire (old browsers, page captures).
setTimeout(() => sections.forEach((el) => el.classList.add('in')), 4000);
