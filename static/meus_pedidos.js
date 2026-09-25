/* "Meus pedidos": lista os pedidos feitos neste aparelho (o navegador guarda
 * o código secreto de cada um), com a etapa atual e o botão de cancelar
 * enquanto a cozinha ainda não iniciou o preparo. Atualiza sozinha. */

let lastSignature = "";
let poller = null;
const lastStageByToken = {}; // pra saber quando a etapa de um pedido avançou e animar

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

function stepsFor(order) {
  return order.is_delivery
    ? [
        { key: "confirmado", label: "Confirmado" },
        { key: "preparando", label: "Em preparação" },
        { key: "pronto", label: "Pronto" },
        { key: "em_rota", label: "Em rota" },
      ]
    : [
        { key: "confirmado", label: "Confirmado" },
        { key: "preparando", label: "Em preparação" },
        { key: "pronto", label: "Pronto p/ retirada" },
      ];
}

const STAGE_TEXT = {
  confirmado: "Pedido confirmado",
  preparando: "Em preparação",
  pronto: "Pedido pronto",
  em_rota: "Pedido em rota",
  entregue: "Entregue",
  cancelado: "Cancelado",
};

function barHTML(order) {
  const steps = stepsFor(order);
  const current = order.stage === "entregue" ? steps.length : steps.findIndex((s) => s.key === order.stage);
  return `<ol class="stage-bar">${steps.map((step, i) => `
    <li class="stage-step${i < current ? " is-done" : ""}${i === current ? " is-current" : ""}">
      <span class="stage-dot">${i < current ? "✓" : i + 1}</span>
      <span class="stage-label">${escapeHTML(step.label)}</span>
    </li>`).join("")}</ol>`;
}

function orderHTML(order) {
  const cancelled = order.stage === "cancelado";
  const done = order.stage === "entregue";
  const items = (order.items || []).map((it) => `<li>${escapeHTML(it.qty)}x ${escapeHTML(it.name)}</li>`).join("");
  const age = order.age_min == null ? "" : `há ${order.age_min} min · `;
  return `
  <article class="my-order${cancelled ? " is-cancelled" : ""}${done ? " is-done" : ""}" data-token="${escapeHTML(order.token)}">
    <div class="my-order-head">
      <strong>#${escapeHTML(order.id)}</strong>
      <span class="my-order-badge">${escapeHTML(STAGE_TEXT[order.stage] || order.stage)}</span>
    </div>
    <small>${age}${order.is_delivery ? "🛵 Entrega" : "🏪 Retirada"} · ${formatPrice(order.total)}</small>
    ${cancelled ? "" : barHTML(order)}
    <ul>${items}</ul>
    <div class="my-order-actions">
      <a class="d-maps" href="/pedido/${encodeURIComponent(order.token)}">Acompanhar →</a>
      ${order.can_cancel ? `<button type="button" class="delete-item-btn my-order-cancel">Cancelar pedido</button>` : ""}
    </div>
    ${!order.can_cancel && !cancelled && !done ? `<p class="field-hint">A cozinha já começou o preparo: não dá mais para cancelar por aqui.</p>` : ""}
  </article>`;
}

function showMessage(text) {
  const el = document.getElementById("mp-msg");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

async function load() {
  const list = document.getElementById("mp-list");
  const tokens = cartOrderTokens().map((o) => o.token);
  if (!tokens.length) {
    list.innerHTML = `<p class="cart-empty">Você ainda não fez nenhum pedido neste aparelho.<br>Volte ao cardápio para escolher algo gostoso.</p>`;
    if (poller) { poller.stop(); poller = null; }
    return;
  }
  try {
    const res = await fetch("/api/meus-pedidos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
      cache: "no-store",
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    const signature = JSON.stringify(data.orders);
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (!data.orders.length) {
      list.innerHTML = `<p class="cart-empty">Nenhum pedido encontrado.</p>`;
      return;
    }
    // Antes de trocar o HTML, guarda quais pedidos avançaram de etapa desde
    // a última vez, pra animar só a bolinha que realmente mudou.
    const advancedTokens = data.orders
      .filter((o) => lastStageByToken[o.token] !== undefined && lastStageByToken[o.token] !== o.stage)
      .map((o) => o.token);

    list.innerHTML = data.orders.map(orderHTML).join("");
    list.querySelectorAll(".my-order-cancel").forEach((btn) => {
      btn.addEventListener("click", () => cancelOrder(btn.closest(".my-order").dataset.token, btn));
    });
    advancedTokens.forEach((token) => {
      const article = list.querySelector(`.my-order[data-token="${CSS.escape(token)}"]`);
      const dot = article && article.querySelector(".stage-step.is-current .stage-dot");
      if (dot) dot.classList.add("is-popping");
    });
    data.orders.forEach((o) => { lastStageByToken[o.token] = o.stage; });
  } catch (error) {
    console.error(error);
  }
}

async function cancelOrder(token, btn) {
  if (!window.confirm("Cancelar este pedido? Não dá para desfazer.")) return;
  btn.disabled = true;
  showMessage("");
  try {
    const res = await fetch(`/api/pedido/${encodeURIComponent(token)}/cancelar`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) showMessage(data.error || "Não foi possível cancelar.");
  } catch (error) {
    console.error(error);
    showMessage("Sem conexão — tente de novo.");
  }
  lastSignature = "";
  load();
}

load();
poller = LiveRefresh.every(load, 4000);
