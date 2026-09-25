// animations.js
// Efeitos leves de interatividade. Pensado para não pesar em celular:
// o brilho do cursor só é criado em telas com mouse (pointer: fine);
// em celular esse bloco nem executa. Respeita prefers-reduced-motion.
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var isFinePointer = window.matchMedia("(pointer: fine)").matches;

  /* ---------- brilho que segue o cursor (só desktop) ---------- */
  if (isFinePointer && !reduceMotion) {
    var glow = document.createElement("div");
    glow.className = "cursor-glow";
    document.body.appendChild(glow);

    var targetX = window.innerWidth / 2;
    var targetY = window.innerHeight / 2;
    var currentX = targetX;
    var currentY = targetY;
    var raf = null;

    function render() {
      currentX += (targetX - currentX) * 0.18;
      currentY += (targetY - currentY) * 0.18;
      glow.style.transform = "translate3d(" + currentX + "px," + currentY + "px,0)";
      if (Math.abs(targetX - currentX) > 0.5 || Math.abs(targetY - currentY) > 0.5) {
        raf = requestAnimationFrame(render);
      } else {
        raf = null;
      }
    }

    window.addEventListener(
      "mousemove",
      function (e) {
        targetX = e.clientX;
        targetY = e.clientY;
        glow.style.opacity = "1";
        if (!raf) raf = requestAnimationFrame(render);
      },
      { passive: true }
    );

    document.addEventListener("mouseleave", function () {
      glow.style.opacity = "0";
    });
  }

  /* ---------- destaca no menu a seção que está na tela ---------- */
  var navLinks = document.querySelectorAll(".cat-nav a");
  if (navLinks.length && "IntersectionObserver" in window) {
    var sections = [];
    navLinks.forEach(function (link) {
      var href = link.getAttribute("href") || "";
      if (href.charAt(0) === "#") {
        var el = document.querySelector(href);
        if (el) sections.push({ el: el, link: link });
      }
    });

    if (sections.length) {
      var navObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            var match = sections.filter(function (s) {
              return s.el === entry.target;
            })[0];
            if (!match) return;
            navLinks.forEach(function (l) {
              l.classList.remove("active");
            });
            match.link.classList.add("active");
          });
        },
        { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
      );
      sections.forEach(function (s) {
        navObserver.observe(s.el);
      });
    }
  }
})();
