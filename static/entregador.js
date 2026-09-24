/* Painel do entregador: pedidos de ENTREGA que já saíram da cozinha
 * (etapa "em rota"), a mais antiga em cima. Cada pedido tem um botão
 * "Confirmar entrega" que passa o pedido para "entregue": some daqui, some
 * da tela da cozinha e o cliente vê "Pedido entregue" — tudo sozinho. */

const POLL_MS = 3000;
let orders = [];
let lastSignature = "";
let knownIds = null;
const openIds = new Set();
const busyIds = new Set();
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
  const el = document.getElementById("d-live");
  if (!el) return;
  if (ok) {
    el.classList.remove("is-offline");
    el.textContent = `● Ao vivo · ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } else {
    el.classList.add("is-offline");
    el.textContent = "⚠ Sem conexão — tentando de novo...";
  }
}

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
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
  } catch (_) { /* sem áudio: tudo bem */ }
}

/* ---------- desenho da lista ---------- */

function trocoInfo(order) {
  if (order.payment_method !== "Dinheiro") return "";
  const paidWith = Number(order.troco_paid_with);
  if (Number.isFinite(paidWith) && paidWith > 0) {
    const change = paidWith - Number(order.total || 0);
    return change > 0
      ? `<p class="d-money">💵 Cobrar ${formatPrice(order.total)} · cliente paga com ${formatPrice(paidWith)} → <strong>levar troco: ${formatPrice(change)}</strong></p>`
      : `<p class="d-money">💵 Cobrar ${formatPrice(order.total)} (sem troco)</p>`;
  }
  return `<p class="d-money">💵 Cobrar ${formatPrice(order.total)} em dinheiro</p>`;
}

function paymentLine(order) {
  if (order.payment_method === "Dinheiro") return trocoInfo(order);
  const label = order.payment_method ? escapeHTML(order.payment_method) : "Não informado";
  return `<p><span>Pagamento</span> ${label} · ${formatPrice(order.total)}</p>`;
}

function orderHTML(order) {
  const isOpen = openIds.has(order.id);
  const items = (order.items || []).map((it) =>
    `<li><strong>${escapeHTML(it.qty)}x</strong> ${escapeHTML(it.name)}</li>`).join("");
  const route = order.route_min == null ? "" : ` · em rota há ${order.route_min} min`;
  const mapsUrl = order.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}`
    : "";

  return `
  <article class="k-order stage-em_rota${isOpen ? " is-open" : ""}" data-id="${order.id}">
    <button type="button" class="k-head" aria-expanded="${isOpen}">
      <span class="k-num">#${order.id}</span>
      <span class="k-who">
        <strong>${escapeHTML(order.customer_name || "Sem nome")}</strong>
        <small>🛵 Entrega${route}</small>
      </span>
      <span class="k-chevron">▾</span>
    </button>
    <p class="d-address">📍 ${escapeHTML(order.address || "Endereço não informado")}</p>
    ${mapsUrl ? `<a class="d-maps" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ Abrir no Maps</a>` : ""}
    <div class="k-body">
      <ul class="k-items">${items}</ul>
      <div class="k-details">
        ${order.notes ? `<p class="k-notes"><span>Observações</span> ${escapeHTML(order.notes)}</p>` : ""}
        ${paymentLine(order)}
      </div>
    </div>
    <button type="button" class="save-btn k-next d-confirm"${busyIds.has(order.id) ? " disabled" : ""}>✅ Confirmar entrega</button>
  </article>`;
}

function render() {
  const list = document.getElementById("d-list");
  document.getElementById("d-count").textContent = orders.length ? `(${orders.length})` : "";
  if (!orders.length) {
    list.innerHTML = `<div class="empty-items">Nenhuma entrega em rota agora. Quando a cozinha marcar um pedido como "em rota", ele aparece aqui.</div>`;
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
    card.querySelector(".d-confirm").addEventListener("click", () => confirmDelivery(id));
  });
}

/* ---------- servidor ---------- */

async function loadOrders() {
  try {
    const res = await fetch("/api/entregador/pedidos", { cache: "no-store" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) { setLive(false); return; }
    setLive(true);

    const ids = data.orders.map((o) => o.id);
    if (knownIds !== null) {
      const fresh = ids.filter((id) => !knownIds.has(id));
      if (fresh.length) {
        beep();
        showToast(fresh.length === 1 ? `Nova entrega: pedido #${fresh[0]}` : `${fresh.length} novas entregas`);
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

async function confirmDelivery(id) {
  const order = orders.find((o) => o.id === id);
  if (!order || busyIds.has(id)) return;
  if (!window.confirm(`Confirmar que o pedido #${id} (${order.customer_name || "cliente"}) foi ENTREGUE?`)) return;

  busyIds.add(id);
  render();
  try {
    const res = await fetch(`/api/entregador/pedidos/${id}/entregar`, { method: "POST" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) showToast(data.error || "Não foi possível confirmar a entrega");
    else showToast(`Pedido #${id} entregue ✓`);
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
  document.getElementById("d-login").style.display = "block";
  document.getElementById("d-board").style.display = "none";
  document.getElementById("d-logout").style.display = "none";
}

function showBoard() {
  document.getElementById("d-login").style.display = "none";
  document.getElementById("d-board").style.display = "block";
  document.getElementById("d-logout").style.display = "inline-block";
  knownIds = null;
  lastSignature = "";
  loadOrders();
  if (poller) poller.stop();
  poller = LiveRefresh.every(loadOrders, POLL_MS, { keepAlive: true });
  keepScreenOn();
}

async function login() {
  const errorEl = document.getElementById("d-login-error");
  errorEl.style.display = "none";
  const password = document.getElementById("d-password").value;
  try {
    const res = await fetch("/api/entregador/login", {
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
    document.getElementById("d-password").value = "";
    beep(); // libera o áudio do navegador para o aviso de nova entrega
    showBoard();
  } catch (error) {
    errorEl.textContent = "Sem conexão com o servidor.";
    errorEl.style.display = "block";
  }
}

document.getElementById("d-login-btn").addEventListener("click", login);
document.getElementById("d-password").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
document.getElementById("d-logout").addEventListener("click", async () => {
  await fetch("/api/entregador/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// Já está logado (senha do entregador ou admin)? Entra direto.
(async function init() {
  try {
    const res = await fetch("/api/entregador/pedidos", { cache: "no-store" });
    if (res.ok) showBoard(); else showLogin();
  } catch (_) {
    showLogin();
  }
})();
