/* Painel da cozinha: lista os pedidos em andamento (o mais antigo em cima),
 * cada um com um desplegável de detalhes e o botão "Próxima etapa".
 * Etapas: Pedido confirmado -> Pedido pronto -> Pedido em rota
 * (retirada não tem "em rota"). O cliente vê a mesma barra em /pedido/<código>. */

const POLL_MS = 3000;
let orders = [];
let lastSignature = "";
let knownIds = null;          // null = ainda não carregou a primeira vez
const openIds = new Set();    // pedidos com o desplegável aberto
const busyIds = new Set();    // pedidos com clique em andamento
let poller = null;
let audioCtx = null;
let wakeLock = null;

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function setLive(ok) {
  const el = document.getElementById("k-live");
  if (!el) return;
  if (ok) {
    el.classList.remove("is-offline");
    el.textContent = `● Ao vivo · ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } else {
    el.classList.add("is-offline");
    el.textContent = "⚠ Sem conexão — tentando de novo...";
  }
}

// Mantém a tela do tablet/computador da cozinha acesa (quando o navegador permite).
async function keepScreenOn() {
  try {
    if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (_) { /* sem suporte: tudo bem */ }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && poller) keepScreenOn(); });

function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
  } catch (_) { /* sem áudio: tudo bem */ }
}

/* ---------- etapas ---------- */

function stepsFor(order) {
  return order.is_delivery
    ? [
        { key: "confirmado", label: "Pedido confirmado" },
        { key: "pronto", label: "Pedido pronto" },
        { key: "em_rota", label: "Pedido em rota" },
      ]
    : [
        { key: "confirmado", label: "Pedido confirmado" },
        { key: "pronto", label: "Pronto p/ retirada" },
      ];
}

function stageBarHTML(order) {
  const steps = stepsFor(order);
  const current = steps.findIndex((s) => s.key === order.stage);
  return `<ol class="stage-bar">${steps.map((step, i) => `
    <li class="stage-step${i < current ? " is-done" : ""}${i === current ? " is-current" : ""}">
      <span class="stage-dot">${i < current ? "✓" : i + 1}</span>
      <span class="stage-label">${escapeHTML(step.label)}</span>
    </li>`).join("")}</ol>`;
}

function nextButtonLabel(order) {
  if (order.stage === "confirmado") return "Próxima etapa → marcar como PRONTO";
  if (order.stage === "pronto") {
    return order.is_delivery ? "Próxima etapa → SAIU PARA ENTREGA" : "Próxima etapa → ENTREGUE (retirado)";
  }
  return "Próxima etapa → ENTREGUE ao cliente";
}

/* ---------- desenho da lista ---------- */

function orderHTML(order) {
  const isOpen = openIds.has(order.id);
  const items = (order.items || []).map((it) =>
    `<li><strong>${escapeHTML(it.qty)}x</strong> ${escapeHTML(it.name)}</li>`).join("");
  const age = order.age_min == null ? "" : ` · há ${order.age_min} min`;
  const details = [
    order.is_delivery && order.address ? `<p><span>Endereço</span> ${escapeHTML(order.address)}</p>` : "",
    order.notes ? `<p class="k-notes"><span>Observações</span> ${escapeHTML(order.notes)}</p>` : "",
    order.payment_method ? `<p><span>Pagamento</span> ${escapeHTML(order.payment_method)}${order.troco_paid_with != null ? ` — troco para ${formatPrice(order.troco_paid_with)}` : ""}</p>` : "",
    `<p><span>Total</span> ${formatPrice(order.total)}</p>`,
  ].join("");

  return `
  <article class="k-order stage-${order.stage}${isOpen ? " is-open" : ""}" data-id="${order.id}" data-stage="${order.stage}">
    <button type="button" class="k-head" aria-expanded="${isOpen}">
      <span class="k-num">#${order.id}</span>
      <span class="k-who">
        <strong>${escapeHTML(order.customer_name || "Sem nome")}</strong>
        <small>${order.is_delivery ? "🛵 Entrega" : "🏪 Retirada"}${age}</small>
      </span>
      <span class="k-chevron">▾</span>
    </button>
    ${stageBarHTML(order)}
    <div class="k-body">
      <ul class="k-items">${items}</ul>
      <div class="k-details">${details}</div>
    </div>
    <button type="button" class="save-btn k-next"${busyIds.has(order.id) ? " disabled" : ""}>${nextButtonLabel(order)}</button>
    <button type="button" class="delete-item-btn k-cancel"${busyIds.has(order.id) ? " disabled" : ""}>Cancelar pedido</button>
  </article>`;
}

function render() {
  const list = document.getElementById("k-list");
  document.getElementById("k-count").textContent = orders.length ? `(${orders.length})` : "";
  if (!orders.length) {
    list.innerHTML = `<div class="empty-items">Nenhum pedido em andamento. Quando chegar um novo, ele aparece aqui.</div>`;
    return;
  }
  list.innerHTML = orders.map(orderHTML).join("");

  list.querySelectorAll(".k-order").forEach((card) => {
    const id = Number(card.dataset.id);
    card.querySelector(".k-head").addEventListener("click", () => {
      const open = !card.classList.contains("is-open");
      card.classList.toggle("is-open", open);
      card.querySelector(".k-head").setAttribute("aria-expanded", String(open));
      if (open) openIds.add(id); else openIds.delete(id);
    });
    card.querySelector(".k-next").addEventListener("click", () => advance(id, card.dataset.stage));
    card.querySelector(".k-cancel").addEventListener("click", () => cancelOrder(id));
  });
}

/* ---------- servidor ---------- */

async function loadOrders() {
  try {
    const res = await fetch("/api/cozinha/pedidos", { cache: "no-store" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) { setLive(false); return; }
    setLive(true);

    const ids = data.orders.map((o) => o.id);
    if (knownIds !== null) {
      const fresh = ids.filter((id) => !knownIds.has(id));
      if (fresh.length) {
        beep();
        showToast(fresh.length === 1 ? `Novo pedido #${fresh[0]}` : `${fresh.length} pedidos novos`);
      }
    }
    knownIds = new Set(ids);
    [...openIds].forEach((id) => { if (!knownIds.has(id)) openIds.delete(id); });

    const signature = JSON.stringify(data.orders);
    if (signature !== lastSignature) {
      lastSignature = signature;
      orders = data.orders;
      render();
    }
  } catch (error) {
    console.error(error);
    setLive(false);
  }
}

async function advance(id, fromStage) {
  const order = orders.find((o) => o.id === id);
  if (!order || busyIds.has(id)) return;
  // Última etapa: o pedido some da lista, então confirma pra não tocar sem querer.
  const willFinish = order.stage === "em_rota" || (order.stage === "pronto" && !order.is_delivery);
  if (willFinish && !window.confirm(`Marcar o pedido #${id} como entregue? Ele sai desta lista.`)) return;

  busyIds.add(id);
  render();
  try {
    const res = await fetch(`/api/cozinha/pedidos/${id}/avancar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_stage: fromStage }),
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) showToast(data.error || "Não foi possível avançar o pedido");
    else showToast(`Pedido #${id} atualizado`);
  } catch (error) {
    console.error(error);
    showToast("Sem conexão — tente de novo");
  } finally {
    busyIds.delete(id);
    lastSignature = "";
    await loadOrders();
  }
}

async function cancelOrder(id) {
  const order = orders.find((o) => o.id === id);
  if (!order || busyIds.has(id)) return;
  if (!window.confirm(`Cancelar o pedido #${id}? Ele sai da lista e não conta como venda.`)) return;

  busyIds.add(id);
  render();
  try {
    const res = await fetch(`/api/cozinha/pedidos/${id}/cancelar`, { method: "POST" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) showToast(data.error || "Não foi possível cancelar o pedido");
    else showToast(`Pedido #${id} cancelado`);
  } catch (error) {
    console.error(error);
    showToast("Sem conexão — tente de novo");
  } finally {
    busyIds.delete(id);
    lastSignature = "";
    await loadOrders();
  }
}

/* ---------- login ---------- */

function showLogin() {
  if (poller) { poller.stop(); poller = null; }
  document.getElementById("k-login").style.display = "block";
  document.getElementById("k-board").style.display = "none";
  document.getElementById("k-logout").style.display = "none";
}

function showBoard() {
  document.getElementById("k-login").style.display = "none";
  document.getElementById("k-board").style.display = "block";
  document.getElementById("k-logout").style.display = "inline-block";
  knownIds = null;
  lastSignature = "";
  loadOrders();
  if (poller) poller.stop();
  // A cada 3s, mesmo com a aba em segundo plano (pedido novo tem que aparecer e apitar).
  poller = LiveRefresh.every(loadOrders, POLL_MS, { keepAlive: true });
  keepScreenOn();
}

async function login() {
  const errorEl = document.getElementById("k-login-error");
  errorEl.style.display = "none";
  const password = document.getElementById("k-password").value;
  try {
    const res = await fetch("/api/employee/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      errorEl.textContent = data.error || "Não foi possível entrar.";
      errorEl.style.display = "block";
      return;
    }
    document.getElementById("k-password").value = "";
    beep(); // libera o áudio do navegador para os avisos de pedido novo
    showBoard();
  } catch (error) {
    errorEl.textContent = "Sem conexão com o servidor.";
    errorEl.style.display = "block";
  }
}

document.getElementById("k-login-btn").addEventListener("click", login);
document.getElementById("k-password").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
document.getElementById("k-logout").addEventListener("click", async () => {
  await fetch("/api/employee/logout", { method: "POST" }).catch(() => {});
  showLogin();
});
document.getElementById("k-toggle-all").addEventListener("click", (event) => {
  const cards = [...document.querySelectorAll(".k-order")];
  const open = cards.some((c) => !c.classList.contains("is-open"));
  cards.forEach((card) => {
    card.classList.toggle("is-open", open);
    card.querySelector(".k-head").setAttribute("aria-expanded", String(open));
    const id = Number(card.dataset.id);
    if (open) openIds.add(id); else openIds.delete(id);
  });
  event.target.textContent = open ? "Fechar todos" : "Abrir todos";
});

// Já está logado (admin ou turno)? Então entra direto.
(async function init() {
  try {
    const res = await fetch("/api/cozinha/pedidos");
    if (res.ok) showBoard(); else showLogin();
  } catch (_) {
    showLogin();
  }
})();
