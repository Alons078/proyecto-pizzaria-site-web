/* Janela "Novidades do sistema": avisos do desenvolvedor para o administrador.
 * Stickers à esquerda (o personagem muda de pose sozinho e a cada "Próximo") e
 * o texto à direita. Usada em /admin (avisos novos) e em /dev (pré-visualização).
 *
 * ReyNovidades.show(avisos, aoFechar): avisos = [{id, title, text}];
 * aoFechar(ids) recebe os ids já lidos (do primeiro até o último que apareceu). */
const ReyNovidades = (() => {
  const POSES = [1, 2, 3, 4, 5, 6, 7].map((n) => `/static/stickers/rei-pose-${n}.webp`);
  const LOGO = "/static/stickers/rei-logo.webp";

  function show(notices, onClose) {
    if (!notices.length) return;
    const opener = document.activeElement;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const overlay = document.createElement("div");
    overlay.className = "nv-overlay";
    overlay.innerHTML = `
      <div class="nv-card" role="dialog" aria-modal="true" aria-label="Novidades do sistema">
        <button type="button" class="nv-close" aria-label="Fechar">×</button>
        <div class="nv-stickers" aria-hidden="true">
          <img class="nv-pose" alt="">
          <img class="nv-logo" src="${LOGO}" alt="">
        </div>
        <div class="nv-body">
          <p class="nv-eyebrow"></p>
          <h2 class="nv-title"></h2>
          <p class="nv-text"></p>
          <div class="nv-dots" aria-hidden="true"></div>
          <div class="nv-actions">
            <button type="button" class="nv-back">← Voltar</button>
            <button type="button" class="nv-next"></button>
          </div>
        </div>
      </div>`;
    const $ = (selector) => overlay.querySelector(selector);

    let index = 0;
    let reached = 0;
    let poseIndex = Math.floor(Math.random() * POSES.length);
    let timer = null;
    const pose = $(".nv-pose");

    function changePose(animate) {
      pose.src = POSES[poseIndex];
      if (!animate) return;
      pose.classList.remove("is-swapping");
      void pose.offsetWidth; // reinicia a animação
      pose.classList.add("is-swapping");
    }

    function render() {
      const notice = notices[index];
      const last = index === notices.length - 1;
      $(".nv-eyebrow").textContent = notices.length > 1
        ? `Novidades do sistema · ${index + 1} de ${notices.length}`
        : "Novidades do sistema";
      const title = $(".nv-title");
      title.textContent = notice.title || "";
      title.hidden = !notice.title;
      const text = $(".nv-text");
      text.textContent = notice.text;
      text.scrollTop = 0;
      $(".nv-back").hidden = index === 0;
      $(".nv-next").textContent = last ? "Entendi" : "Próximo →";
      $(".nv-dots").innerHTML = notices.length > 1
        ? notices.map((_, i) => `<span class="${i === index ? "is-on" : ""}"></span>`).join("")
        : "";
      const body = $(".nv-body");
      body.classList.remove("is-changing");
      void body.offsetWidth;
      body.classList.add("is-changing");
    }

    function go(step) {
      index += step;
      reached = Math.max(reached, index);
      poseIndex = (poseIndex + 1) % POSES.length;
      changePose(true);
      render();
    }

    function close() {
      clearInterval(timer);
      overlay.remove();
      document.body.classList.remove("nv-open");
      document.removeEventListener("keydown", onKey);
      if (opener && opener.focus) opener.focus();
      if (onClose) onClose(notices.slice(0, reached + 1).map((n) => n.id));
    }

    function onKey(event) {
      if (event.key === "Escape") { close(); return; }
      if (event.key !== "Tab") return;
      const items = [...overlay.querySelectorAll("button:not([hidden])")];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    $(".nv-next").addEventListener("click", () => {
      if (index === notices.length - 1) close(); else go(1);
    });
    $(".nv-back").addEventListener("click", () => go(-1));
    $(".nv-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    changePose(false);
    render();
    if (!reduceMotion) {
      POSES.forEach((src) => { new Image().src = src; });
      timer = setInterval(() => { poseIndex = (poseIndex + 1) % POSES.length; changePose(true); }, 2600);
    }
    document.body.classList.add("nv-open");
    document.body.appendChild(overlay);
    $(".nv-next").focus();
  }

  return { show };
})();
