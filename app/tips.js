// The little ⓘ buttons. Each sits right before a hidden <span class="tip"> holding its help text.
// Hover or focus one to read it; click to keep it open (so links in it can be clicked); Esc, a click
// elsewhere or scrolling closes it. One floating box is shared by all of them and kept inside the window.
(function () {
  const box = document.createElement('div');
  box.className = 'tip-pop'; box.id = 'tip-pop'; box.setAttribute('role', 'tooltip'); box.hidden = true;
  document.body.append(box);
  let owner = null, pinned = false;
  const sourceOf = btn => { const s = btn && btn.nextElementSibling; return s && s.classList.contains('tip') ? s : null; };
  function place() {
    if (!owner) return;
    const r = owner.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - 24));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    box.style.left = left + 'px'; box.style.top = top + 'px';
  }
  function show(btn, pin) {
    const src = sourceOf(btn);
    if (owner && owner !== btn) hide();
    if (!src || !src.innerHTML.trim()) return;
    box.innerHTML = src.innerHTML; // the app's own help text (anything dynamic in it is escaped where it's set)
    box.hidden = false; owner = btn; pinned = !!pin;
    btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-describedby', 'tip-pop'); btn.classList.add('on');
    place();
  }
  function hide() {
    if (owner) { owner.setAttribute('aria-expanded', 'false'); owner.removeAttribute('aria-describedby'); owner.classList.remove('on'); }
    box.hidden = true; owner = null; pinned = false;
  }
  document.addEventListener('mouseover', e => { const b = e.target.closest('.info'); if (b && !pinned) show(b); });
  document.addEventListener('mouseout', e => { const b = e.target.closest('.info'); if (b && b === owner && !pinned && !b.contains(e.relatedTarget)) hide(); });
  document.addEventListener('focusin', e => { const b = e.target.closest('.info'); if (b && !pinned) show(b); });
  document.addEventListener('focusout', e => { const b = e.target.closest('.info'); if (b && b === owner && !pinned) hide(); });
  document.addEventListener('click', e => {
    const b = e.target.closest('.info');
    if (b) { e.preventDefault(); e.stopPropagation(); if (owner === b && pinned) hide(); else show(b, true); return; }
    if (owner && !box.contains(e.target)) hide();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && owner) { const b = owner; hide(); b.focus(); } });
  document.addEventListener('scroll', () => { if (owner) pinned ? place() : hide(); }, true);
  window.addEventListener('resize', () => { if (owner) place(); });
})();
