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
const closedHere = new Set(); // pedidos que ESTA tela entregou/cancelou (não avisar de novo)
const moreIds = new Set();    // pedidos com o bloco "Mais opções" aberto
let editingId = null;         // pedido com o formulário de edição aberto (o polling não redesenha a lista enquanto isso)
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

/* ---------- som de pedido novo ----------
 * Um "ding-ding-DING!" duas vezes (~1,4 s), alto e fácil de reconhecer.
 * Os navegadores só liberam som depois que a pessoa toca/clica na página
 * pelo menos uma vez; por isso o botão "Toque para ativar o som" aparece
 * enquanto o som estiver bloqueado, e qualquer toque na tela já libera. */

function getAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
    audioCtx.onstatechange = updateSoundButton;
  }
  return audioCtx;
}

async function unlockAudio() {
  const ctx = getAudio();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch (_) { /* ainda bloqueado */ }
  }
  updateSoundButton();
  return ctx.state === "running";
}

function soundIsOn() {
  return !!audioCtx && audioCtx.state === "running";
}

function updateSoundButton() {
  const btn = document.getElementById("k-sound");
  if (!btn) return;
  const on = soundIsOn();
  btn.textContent = on ? "🔊 Testar som" : "🔇 Toque para ativar o som";
  btn.classList.toggle("is-alert", !on);
}

function playNewOrderSound() {
  if (!soundIsOn()) return;
  const ctx = audioCtx;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const limiter = ctx.createDynamicsCompressor(); // evita estourar/distorcer o alto-falante
  master.connect(limiter);
  limiter.connect(ctx.destination);

  const notes = [659.25, 783.99, 1046.5];   // Mi, Sol, Dó (subindo)
  const start = ctx.currentTime + 0.02;
  [0, 0.75].forEach((offset) => {
    notes.forEach((freq, i) => {
      const t = start + offset + i * 0.16;
      const dur = i === 2 ? 0.36 : 0.14;    // a última nota é mais longa
      [["square", freq, 0.32], ["sine", freq * 2, 0.22]].forEach(([type, f, level]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(level, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain);
        gain.connect(master);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      });
    });
  });
}

// Qualquer toque/tecla na página libera o som (regra dos navegadores).
["pointerdown", "keydown", "touchstart"].forEach((type) => {
  document.addEventListener(type, () => { if (!soundIsOn()) unlockAudio(); }, { passive: true });
});

// Com a aba em segundo plano, o título avisa que chegou pedido novo.
const BASE_TITLE = document.title;
function flashTitle(text) {
  if (document.hidden) document.title = text;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = BASE_TITLE; });

/* ---------- etapas ---------- */

function stepsFor(order) {
  return order.is_delivery
    ? [
        { key: "confirmado", label: "Pedido confirmado" },
        { key: "preparando", label: "Em preparação" },
        { key: "pronto", label: "Pedido pronto" },
        { key: "em_rota", label: "Pedido em rota" },
      ]
    : [
        { key: "confirmado", label: "Pedido confirmado" },
        { key: "preparando", label: "Em preparação" },
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
  if (order.stage === "confirmado") return "Próxima etapa → INICIAR PREPARO";
  if (order.stage === "preparando") return "Próxima etapa → marcar como PRONTO";
  if (order.stage === "pronto") {
    return order.is_delivery ? "Próxima etapa → SAIU PARA ENTREGA" : "Próxima etapa → ENTREGUE (retirado)";
  }
  return "Próxima etapa → ENTREGUE ao cliente";
}

/* ---------- desenho da lista ---------- */

/* Bloco oculto "Mais opções": reimprimir comprovante e editar pedido. */
function moreHTML(order) {
  const open = moreIds.has(order.id);
  const busy = busyIds.has(order.id) ? " disabled" : "";
  const inner = editingId === order.id
    ? `<div class="k-edit-slot"></div>`
    : `<div class="k-more-actions">
        <button type="button" class="item-toggle-all k-reprint"${busy}>🖨 Reimprimir comprovante</button>
        <button type="button" class="item-toggle-all k-edit-open"${busy}>✏️ Editar pedido</button>
      </div>`;
  return `<button type="button" class="item-toggle-all k-more-toggle" aria-expanded="${open}">⋯ Mais opções</button>
      <div class="k-more"${open ? "" : " hidden"}>${inner}</div>`;
}

function orderHTML(order) {
  const isOpen = openIds.has(order.id);
  const items = (order.items || []).map((it) =>
    `<li><strong>${escapeHTML(it.qty)}x</strong> ${escapeHTML(it.name)}</li>`).join("");
  const age = order.age_min == null ? "" : ` · há ${order.age_min} min`;
  const details = [
    order.is_delivery && order.address ? `<p><span>Endereço</span> ${escapeHTML(order.address)}</p>` : "",
    order.customer_phone ? `<p><span>Telefone</span> ${escapeHTML(order.customer_phone)}</p>` : "",
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
      ${moreHTML(order)}
    </div>
    <button type="button" class="save-btn k-next"${busyIds.has(order.id) ? " disabled" : ""}>${nextButtonLabel(order)}</button>
    <button type="button" class="delete-item-btn k-cancel"${busyIds.has(order.id) ? " disabled" : ""}>Cancelar pedido</button>
  </article>`;
}

function render() {
  const list = document.getElementById("k-list");
  if (editingId !== null && !orders.some((o) => o.id === editingId)) editingId = null;
  // O formulário de edição sobrevive ao redesenho da lista (mantém o que já foi digitado).
  const keptForm = editingId !== null ? list.querySelector(".k-edit") : null;
  if (keptForm) keptForm.remove();
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
    const more = card.querySelector(".k-more");
    const moreToggle = card.querySelector(".k-more-toggle");
    moreToggle.addEventListener("click", () => {
      const open = more.hidden;
      more.hidden = !open;
      moreToggle.setAttribute("aria-expanded", String(open));
      if (open) moreIds.add(id); else moreIds.delete(id);
    });
    card.querySelector(".k-reprint")?.addEventListener("click", () => reprintOrder(id));
    card.querySelector(".k-edit-open")?.addEventListener("click", () => openEdit(id));
  });

  if (editingId !== null) {
    const slot = list.querySelector(`.k-order[data-id="${editingId}"] .k-edit-slot`);
    const order = orders.find((o) => o.id === editingId);
    if (slot && order) slot.replaceWith(keptForm || buildEditForm(order));
  }
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
        playNewOrderSound();
        flashTitle("🔔 Novo pedido! · Cozinha");
        showToast(fresh.length === 1 ? `Novo pedido #${fresh[0]}` : `${fresh.length} pedidos novos`);
      }
    }
    // Pedido que saiu da lista sem ter sido por esta tela = o entregador
    // confirmou a entrega (ou alguém cancelou em outro aparelho).
    if (knownIds !== null) {
      const gone = [...knownIds].filter((id) => !ids.includes(id) && !closedHere.has(id));
      if (gone.length) showToast(gone.length === 1 ? `Pedido #${gone[0]} saiu da lista (entregue ou cancelado)` : `${gone.length} pedidos saíram da lista (entregues)`);
    }
    knownIds = new Set(ids);
    [...openIds].forEach((id) => { if (!knownIds.has(id)) openIds.delete(id); });

    const signature = JSON.stringify(data.orders);
    if (signature !== lastSignature) {
      lastSignature = signature;
      orders = data.orders;
      if (editingId === null) render();   // com o formulário aberto, só atualiza os dados
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

  if (editingId === id) editingId = null;
  busyIds.add(id);
  if (willFinish) closedHere.add(id);
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

  if (editingId === id) editingId = null;
  busyIds.add(id);
  closedHere.add(id);
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

/* ---------- mais opções: reimprimir e editar ---------- */

async function reprintOrder(id) {
  if (busyIds.has(id)) return;
  if (!window.confirm(`Reimprimir o comprovante do pedido #${id}?`)) return;
  busyIds.add(id);
  render();
  try {
    const res = await fetch(`/api/cozinha/pedidos/${id}/reimprimir`, { method: "POST" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) showToast(data.error || "Não foi possível reimprimir");
    else showToast(`Pedido #${id} enviado para impressão`);
  } catch (error) {
    console.error(error);
    showToast("Sem conexão — tente de novo");
  } finally {
    busyIds.delete(id);
    lastSignature = "";
    await loadOrders();
  }
}

const PAYMENT_OPTIONS = ["Dinheiro", "Cartão na entrega", "Pix na maquininha", "Pix"];

function moneyInput(value) {
  return value == null || value === "" ? "" : Number(value).toFixed(2);
}

function parseNumber(value) {
  return parseFloat(String(value ?? "").replace(",", "."));
}

function openEdit(id) {
  if (busyIds.has(id)) return;
  if (editingId !== null && editingId !== id) {
    showToast(`Termine ou cancele a edição do pedido #${editingId} primeiro`);
    return;
  }
  editingId = id;
  openIds.add(id);
  moreIds.add(id);
  render();
  document.querySelector(`.k-order[data-id="${id}"] .k-edit`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function cancelEdit() {
  editingId = null;
  render();
}

// Total = soma dos itens + taxa, a menos que o total tenha sido digitado à mão.
function recalcEditTotal(wrap) {
  if (wrap.dataset.manualTotal === "1") return;
  const num = (el) => { const n = parseNumber(el && el.value); return Number.isFinite(n) ? n : 0; };
  let sum = 0;
  wrap.querySelectorAll(".k-edit-item").forEach((row) => {
    sum += num(row.querySelector(".ke-qty")) * num(row.querySelector(".ke-price"));
  });
  wrap.querySelector(".ke-total").value = (sum + num(wrap.querySelector(".ke-fee"))).toFixed(2);
}

function buildEditForm(order) {
  const payments = PAYMENT_OPTIONS.includes(order.payment_method) || !order.payment_method
    ? [...PAYMENT_OPTIONS]
    : [order.payment_method, ...PAYMENT_OPTIONS];
  if (!order.payment_method) payments.unshift("");
  const paymentOptions = payments.map((p) =>
    `<option value="${escapeHTML(p)}"${p === (order.payment_method || "") ? " selected" : ""}>${escapeHTML(p || "Não informado")}</option>`).join("");

  const itemRows = (order.items || []).map((it, i) => `
    <div class="k-edit-item" data-index="${i}">
      <div class="field k-edit-name"><label>Item</label><input type="text" class="ke-name" maxlength="200" value="${escapeHTML(it.name)}"></div>
      <div class="field"><label>Qtd</label><input type="number" class="ke-qty" min="1" step="1" inputmode="numeric" value="${escapeHTML(it.qty)}"></div>
      <div class="field"><label>Preço un. (R$)</label><input type="number" class="ke-price" min="0" step="0.01" inputmode="decimal" value="${moneyInput(it.unit_price)}"></div>
      <button type="button" class="delete-item-btn ke-remove">Remover</button>
    </div>`).join("");

  const wrap = document.createElement("div");
  wrap.className = "k-edit";
  wrap.innerHTML = `
    <h4 class="k-edit-title">✏️ Editar pedido #${order.id}</h4>
    <div class="field"><label>Nome do cliente</label><input type="text" class="ke-customer" maxlength="120" value="${escapeHTML(order.customer_name)}"></div>
    <div class="field"><label>Telefone</label><input type="text" class="ke-phone" maxlength="30" inputmode="tel" value="${escapeHTML(order.customer_phone)}"></div>
    ${order.is_delivery ? `
    <div class="field"><label>Endereço</label><input type="text" class="ke-address" maxlength="300" value="${escapeHTML(order.address)}"></div>
    <div class="field"><label>Taxa de entrega (R$) — vazio = a combinar</label><input type="number" class="ke-fee" min="0" step="0.01" inputmode="decimal" value="${moneyInput(order.delivery_fee)}"></div>` : ""}
    <div class="field"><label>Pagamento</label><select class="ke-payment">${paymentOptions}</select></div>
    <div class="field ke-troco-field"${order.payment_method === "Dinheiro" ? "" : " hidden"}><label>Troco para (R$)</label><input type="number" class="ke-troco" min="0" step="0.01" inputmode="decimal" value="${moneyInput(order.troco_paid_with)}"></div>
    <div class="field"><label>Observações</label><textarea class="ke-notes" maxlength="500">${escapeHTML(order.notes)}</textarea></div>
    ${itemRows}
    <div class="field"><label>Total (R$)</label><input type="number" class="ke-total" min="0" step="0.01" inputmode="decimal" value="${moneyInput(order.total)}"><small>Soma dos itens + taxa, calculado sozinho. Pode ser alterado à mão.</small></div>
    <button type="button" class="item-toggle-all ke-recalc">↻ Recalcular total</button>
    <label class="k-edit-check"><input type="checkbox" class="ke-reprint"> Reimprimir ao salvar</label>
    <div class="k-edit-actions">
      <button type="button" class="save-btn ke-save">Salvar alterações</button>
      <button type="button" class="item-toggle-all ke-cancel">Cancelar</button>
    </div>`;

  wrap.addEventListener("input", (event) => {
    if (event.target.matches(".ke-qty, .ke-price, .ke-fee")) recalcEditTotal(wrap);
    else if (event.target.matches(".ke-total")) wrap.dataset.manualTotal = "1";
  });
  wrap.addEventListener("change", (event) => {
    if (event.target.matches(".ke-payment")) wrap.querySelector(".ke-troco-field").hidden = event.target.value !== "Dinheiro";
  });
  wrap.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    if (btn.matches(".ke-remove")) {
      if (wrap.querySelectorAll(".k-edit-item").length <= 1) { showToast("O pedido precisa ter pelo menos 1 item"); return; }
      btn.closest(".k-edit-item").remove();
      recalcEditTotal(wrap);
    } else if (btn.matches(".ke-recalc")) {
      delete wrap.dataset.manualTotal;
      recalcEditTotal(wrap);
    } else if (btn.matches(".ke-save")) {
      saveEdit(order.id, wrap);
    } else if (btn.matches(".ke-cancel")) {
      cancelEdit();
    }
  });
  return wrap;
}

async function saveEdit(id, wrap) {
  const q = (sel) => wrap.querySelector(sel);
  const items = [];
  for (const row of wrap.querySelectorAll(".k-edit-item")) {
    const name = row.querySelector(".ke-name").value.trim();
    const qty = parseNumber(row.querySelector(".ke-qty").value);
    const price = parseNumber(row.querySelector(".ke-price").value);
    if (!name) { showToast("Todo item precisa de um nome"); return; }
    if (!Number.isInteger(qty) || qty < 1) { showToast("A quantidade precisa ser um número inteiro (mínimo 1)"); return; }
    if (!Number.isFinite(price) || price < 0) { showToast("Confira o preço dos itens"); return; }
    items.push({ index: Number(row.dataset.index), name, qty, unit_price: price });
  }
  const total = parseNumber(q(".ke-total").value);
  if (!Number.isFinite(total) || total < 0) { showToast("Confira o total do pedido"); return; }

  const optional = (sel) => { const raw = q(sel).value.trim(); return raw === "" ? null : raw; };
  const payment = q(".ke-payment").value;
  const body = {
    customer_name: q(".ke-customer").value.trim(),
    customer_phone: q(".ke-phone").value.trim(),
    payment_method: payment,
    troco_paid_with: payment === "Dinheiro" ? optional(".ke-troco") : null,
    notes: q(".ke-notes").value.trim(),
    total,
    items,
    reprint: q(".ke-reprint").checked,
  };
  if (q(".ke-address")) body.address = q(".ke-address").value.trim();
  if (q(".ke-fee")) body.delivery_fee = optional(".ke-fee");

  const saveBtn = q(".ke-save");
  saveBtn.disabled = true;
  try {
    const res = await fetch(`/api/cozinha/pedidos/${id}/editar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showToast(data.error || "Não foi possível salvar as alterações");
      if (res.status === 409) { editingId = null; lastSignature = ""; await loadOrders(); }
      return;
    }
    editingId = null;
    const i = orders.findIndex((o) => o.id === id);
    if (i >= 0 && data.order) orders[i] = { ...orders[i], ...data.order };
    render();
    showToast(body.reprint ? `Pedido #${id} salvo e enviado para impressão` : `Pedido #${id} salvo`);
    lastSignature = "";
    await loadOrders();
  } catch (error) {
    console.error(error);
    showToast("Sem conexão — tente de novo");
  } finally {
    saveBtn.disabled = false;
  }
}

/* ---------- login ---------- */

function showLogin() {
  editingId = null;
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
    unlockAudio(); // o clique em "Entrar" já libera o som para os avisos de pedido novo
    showBoard();
  } catch (error) {
    errorEl.textContent = "Sem conexão com o servidor.";
    errorEl.style.display = "block";
  }
}

document.getElementById("k-sound").addEventListener("click", async () => {
  const wasOn = soundIsOn();
  await unlockAudio();
  if (wasOn || soundIsOn()) playNewOrderSound();   // toque = teste do som
});
updateSoundButton();

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
