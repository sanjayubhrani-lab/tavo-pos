/* Tavo marketing site — sleek motion: scroll reveals + subtle card tilt.
   Progressive enhancement: if JS is off or reduced-motion is set, content
   still shows (CSS .reveal only hides when this script marks elements). */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  // Elements to reveal on scroll. Auto-selected so no per-element markup needed.
  var sel = 'section .eyebrow, section h2, .lead, .card, .price, .split > div, ' +
            '.band, .faq details, .cmp, .note, .strip';
  var targets = Array.prototype.slice.call(document.querySelectorAll(sel))
    // don't double-animate the hero (it has its own entrance)
    .filter(function (el) { return !el.closest('header.site'); });

  targets.forEach(function (el) { el.classList.add('reveal'); });

  if (!('IntersectionObserver' in window)) {
    targets.forEach(function (el) { el.classList.add('in'); });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

  targets.forEach(function (el) { io.observe(el); });

  // Subtle pointer-tilt on feature/pricing cards (sleek, gentle).
  var tiltCards = document.querySelectorAll('.card, .price');
  if (window.matchMedia('(hover: hover)').matches) {
    tiltCards.forEach(function (card) {
      card.style.transformStyle = 'preserve-3d';
      card.addEventListener('mousemove', function (ev) {
        var r = card.getBoundingClientRect();
        var px = (ev.clientX - r.left) / r.width - 0.5;
        var py = (ev.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'translateY(-6px) perspective(800px) rotateX(' +
          (py * -5).toFixed(2) + 'deg) rotateY(' + (px * 6).toFixed(2) + 'deg)';
      });
      card.addEventListener('mouseleave', function () { card.style.transform = ''; });
    });
  }
})();
