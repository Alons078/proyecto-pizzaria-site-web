/* Página de acompanhamento do pedido (cliente): barra com as etapas
 * Pedido confirmado -> Pedido pronto -> Pedido em rota. Atualiza sozinha. */

const TOKEN = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).pop() || "");
const LAST_ORDER_KEY = "rey_pizzaria_last_order_v1";
let poller = null;
let lastSignature = "";
let lastStage = null;

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
        { key: "confirmado", label: "Pedido confirmado" },
        { key: "pronto", label: "Pedido pronto" },
        { key: "em_rota", label: "Pedido em rota" },
      ]
    : [
        { key: "confirmado", label: "Pedido confirmado" },
        { key: "pronto", label: "Pronto para retirada" },
      ];
}

function headline(order) {
  if (order.stage === "confirmado") return "Pedido confirmado! Estamos preparando.";
  if (order.stage === "pronto") return order.is_delivery ? "Pedido pronto! Já já sai para entrega." : "Pedido pronto! Pode vir retirar.";
  if (order.stage === "em_rota") return "Pedido em rota! Está a caminho.";
  return "Pedido entregue. Bom apetite! 🍕";
}

function render(order) {
  const steps = stepsFor(order);
  const delivered = order.stage === "entregue";
  const current = delivered ? steps.length : steps.findIndex((s) => s.key === order.stage);
  document.getElementById("t-title").textContent = `Pedido #${order.id}`;

  const bar = `<ol class="stage-bar stage-bar-big">${steps.map((step, i) => `
    <li class="stage-step${i < current ? " is-done" : ""}${i === current ? " is-current" : ""}">
      <span class="stage-dot">${i < current ? "✓" : i + 1}</span>
      <span class="stage-label">${escapeHTML(step.label)}</span>
    </li>`).join("")}</ol>`;

  const items = (order.items || []).map((it) =>
    `<li>${escapeHTML(it.qty)}x ${escapeHTML(it.name)}</li>`).join("");

  document.getElementById("t-content").innerHTML = `
    <div class="track-headline">${escapeHTML(headline(order))}</div>
    ${bar}
    <div class="track-summary">
      <h3>Resumo</h3>
      <ul>${items}</ul>
      <p><strong>Total: ${formatPrice(order.total)}</strong></p>
      <p class="field-hint">Esta página atualiza sozinha. Não precisa recarregar.</p>
    </div>`;

  // Título da aba com a etapa atual + vibração leve quando muda de etapa.
  document.title = `${headline(order).replace(/[!.]$/, "")} · Rey Pizzaria`;
  if (lastStage !== null && lastStage !== order.stage && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  lastStage = order.stage;

  if (delivered) {
    if (poller) { poller.stop(); poller = null; }
    try { localStorage.removeItem(LAST_ORDER_KEY); } catch (_) {}
  }
}

async function load() {
  try {
    const res = await fetch(`/api/pedido/${encodeURIComponent(TOKEN)}`, { cache: "no-store" });
    if (res.status === 404) {
      if (poller) { poller.stop(); poller = null; }
      document.getElementById("t-content").innerHTML = `<p class="product-warning">Pedido não encontrado. Confira o link.</p>`;
      return;
    }
    const data = await res.json();
    if (!data.ok) return;
    const signature = JSON.stringify(data.order);
    if (signature === lastSignature) return;
    lastSignature = signature;
    render(data.order);
  } catch (error) {
    console.error(error);
  }
}

load();
poller = LiveRefresh.every(load, 4000);
