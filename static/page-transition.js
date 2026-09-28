// page-transition.js
// Transição em fade ao trocar de página (cliente -> produto -> carrinho...).
// Super leve: só anima opacity (custa quase nada pro celular) e, se a
// pessoa tem "reduzir movimento" ativado no aparelho, não faz nada.
(function () {
  "use strict";

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var LEAVE_MS = 170;

  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!link) return;

    var href = link.getAttribute("href") || "";
    var target = link.getAttribute("target");

    if (
      href === "" ||
      href.charAt(0) === "#" ||
      href.indexOf("mailto:") === 0 ||
      href.indexOf("tel:") === 0 ||
      href.indexOf("javascript:") === 0 ||
      link.hasAttribute("download") ||
      (target && target !== "_self")
    ) {
      return;
    }

    var url;
    try {
      url = new URL(href, window.location.href);
    } catch (err) {
      return;
    }

    // só aplica o efeito em navegação interna, para o mesmo site
    if (url.origin !== window.location.origin) return;
    if (url.href === window.location.href) return;

    e.preventDefault();
    document.body.classList.add("is-leaving");
    window.setTimeout(function () {
      window.location.href = url.href;
    }, LEAVE_MS);
  });

  // se a página voltar do cache do navegador (botão "voltar"), garante
  // que ela não fique presa com opacidade zero
  window.addEventListener("pageshow", function (evt) {
    if (evt.persisted) {
      document.body.classList.remove("is-leaving");
    }
  });
})();
