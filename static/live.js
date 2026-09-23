/* Atualização automática das páginas (sem precisar apertar F5).
 *
 * Funciona perguntando ao servidor de tempos em tempos "mudou alguma
 * coisa?" (polling leve). Em todas as páginas:
 *   - pausa quando a aba está escondida (economiza bateria e internet),
 *     e atualiza NA HORA quando a pessoa volta para a aba;
 *   - atualiza NA HORA quando a internet volta.
 * A cozinha usa "keepAlive": continua atualizando mesmo com a aba em
 * segundo plano (senão o navegador congela os temporizadores e o aviso
 * de pedido novo atrasa). */
const LiveRefresh = (() => {
  function backgroundTicker(ms, callback) {
    // Temporizador dentro de um Worker: o navegador não o congela como
    // congela os setInterval de abas em segundo plano.
    try {
      const blob = new Blob([`setInterval(function(){postMessage(1)}, ${ms});`], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.onmessage = callback;
      return () => { worker.terminate(); URL.revokeObjectURL(url); };
    } catch (_) {
      const timer = setInterval(callback, ms);
      return () => clearInterval(timer);
    }
  }

  /* every(fn, ms, { keepAlive }) — roda fn a cada ms milissegundos.
   * Nunca roda duas vezes ao mesmo tempo. Devolve { tick, stop }. */
  function every(fn, ms, { keepAlive = false } = {}) {
    let running = false;
    let stopTicker = null;

    async function tick() {
      if (running) return;
      if (document.hidden && !keepAlive) return;
      running = true;
      try { await fn(); } catch (error) { console.error(error); } finally { running = false; }
    }

    stopTicker = keepAlive
      ? backgroundTicker(ms, tick)
      : (() => { const t = setInterval(tick, ms); return () => clearInterval(t); })();

    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", tick);
    window.addEventListener("focus", tick);

    return {
      tick,
      stop() {
        if (stopTicker) stopTicker();
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", tick);
        window.removeEventListener("focus", tick);
      },
    };
  }

  /* watchPage({ ms, pick }) — para as páginas de produto, promoção e
   * carrinho, que têm campos que o cliente vai preenchendo (nome, endereço,
   * sabores...). Se o cardápio/preços/loja mudarem:
   *   - cliente ainda não mexeu em nada -> recarrega a página sozinha;
   *   - cliente já estava mexendo -> NÃO recarrega (perderia o que digitou);
   *     mostra uma faixa "Atualizamos o cardápio — Atualizar".
   * O carrinho fica salvo no navegador, então recarregar não perde itens. */
  function watchPage({ ms = 20000, pick } = {}) {
    let baseline = null;
    let touched = false;
    let bannerShown = false;

    ["input", "change", "click", "keydown"].forEach((type) => {
      document.addEventListener(type, (event) => {
        if (event.target && event.target.closest && event.target.closest("#live-update-banner")) return;
        touched = true;
      }, true);
    });

    function showBanner() {
      if (bannerShown) return;
      bannerShown = true;
      const banner = document.createElement("div");
      banner.id = "live-update-banner";
      banner.className = "live-update-banner";
      banner.innerHTML = `<span>O cardápio foi atualizado.</span><button type="button">Atualizar agora</button>`;
      banner.querySelector("button").addEventListener("click", () => window.location.reload());
      document.body.appendChild(banner);
    }

    return every(async () => {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const signature = JSON.stringify(pick ? pick(data) : data);
      if (baseline === null) { baseline = signature; return; }
      if (signature === baseline) return;
      if (!touched) { window.location.reload(); return; }
      showBanner();
    }, ms);
  }

  return { every, watchPage };
})();
