/* Painel do entregador: pedidos de ENTREGA que precisam dele, a mais antiga em
 * cima. Dois momentos:
 *   - "Pronto"  -> a cozinha terminou: toca o alarme (e chega um aviso no
 *                  celular mesmo com o navegador fechado). Botão "Saí para
 *                  entrega" quando ele pega o pedido.
 *   - "Em rota" -> botão "Confirmar entrega": some daqui, some da cozinha e o
 *                  cliente vê "Pedido entregue".
 * Também mostra a contagem de entregas da NOITE (começa quando o entregador
 * entra) e o botão "Fechar entregas", que manda o total para o admin. */

const POLL_MS = 5000;
const ALARM_EVERY_MS = 8000;   // repete o alarme até o entregador tocar em "Entendi"
const ALARM_MAX_PLAYS = 8;
let orders = [];
let lastSignature = "";
let knownIds = null;
let knownReady = null;        // ids que já estavam "prontos" (null = ainda não carregou)
const alarmIds = new Set();   // prontos que o entregador ainda não reconheceu
let alarmPlays = 0;
let lastAlarmAt = 0;
const openIds = new Set();
const busyIds = new Set();
let poller = null;
let audioCtx = null;
let wakeLock = null;
let shiftBusy = false;
let confirmId = null;         // pedido cujo "Confirmar entrega" está esperando o 2º toque
let confirmTimer = null;

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

/* ---------- som ----------
 * Os navegadores só liberam som depois de um toque na página; por isso o
 * botão "Toque para ativar o som" aparece enquanto estiver bloqueado. */

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

function soundIsOn() { return !!audioCtx && audioCtx.state === "running"; }

function updateSoundButton() {
  const btn = document.getElementById("d-sound");
  if (!btn) return;
  const on = soundIsOn();
  btn.textContent = on ? "🔊 Testar som" : "🔇 Toque para ativar o som";
  btn.classList.toggle("is-alert", !on);
}

["pointerdown", "keydown", "touchstart"].forEach((type) => {
  document.addEventListener(type, () => { if (!soundIsOn()) unlockAudio(); }, { passive: true });
});

/* Toque alto e bem diferente de um "plim": "ding-ding-DING" duas vezes. */
function playAlarmSound() {
  if (!soundIsOn()) return;
  const ctx = audioCtx;
  const master = ctx.createGain();
  master.gain.value = 0.95;
  const limiter = ctx.createDynamicsCompressor();
  master.connect(limiter);
  limiter.connect(ctx.destination);
  const notes = [659.25, 783.99, 1046.5];
  const start = ctx.currentTime + 0.02;
  [0, 0.75].forEach((offset) => {
    notes.forEach((freq, i) => {
      const t = start + offset + i * 0.16;
      const dur = i === 2 ? 0.36 : 0.14;
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

/* ---------- alarme de "pedido pronto" ---------- */

const BASE_TITLE = document.title;
document.addEventListener("visibilitychange", () => { if (!document.hidden && !alarmIds.size) document.title = BASE_TITLE; });

function ringAlarm() {
  playAlarmSound();
  try { if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]); } catch (_) { /* sem vibração */ }
  alarmPlays += 1;
  lastAlarmAt = Date.now();
}

function updateAlarmBanner() {
  const banner = document.getElementById("d-alarm");
  if (!banner) return;
  if (!alarmIds.size) {
    banner.style.display = "none";
    document.title = BASE_TITLE;
    return;
  }
  const ids = [...alarmIds].sort((a, b) => a - b).map((id) => `#${id}`).join(", ");
  document.getElementById("d-alarm-text").textContent =
    alarmIds.size === 1 ? `🍕 Pedido ${ids} PRONTO na cozinha!` : `🍕 ${alarmIds.size} pedidos prontos: ${ids}`;
  banner.style.display = "flex";
  if (document.hidden) document.title = `🍕 PRONTO ${ids}`;
}

// Chamado a cada atualização da lista: toca o alarme de novo de tempos em
// tempos enquanto houver pedido pronto que ele ainda não reconheceu.
function maybeRepeatAlarm() {
  if (alarmIds.size && alarmPlays < ALARM_MAX_PLAYS && Date.now() - lastAlarmAt >= ALARM_EVERY_MS) ringAlarm();
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
  const isReady = order.stage === "pronto";
  const items = (order.items || []).map((it) =>
    `<li><strong>${escapeHTML(it.qty)}x</strong> ${escapeHTML(it.name)}</li>`).join("");
  const sub = isReady
    ? `<span class="d-ready-tag">PRONTO — pegar na cozinha</span>${order.ready_min == null ? "" : ` · há ${order.ready_min} min`}`
    : `🛵 Entrega${order.route_min == null ? "" : ` · em rota há ${order.route_min} min`}`;
  const mapsUrl = order.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}`
    : "";
  const button = isReady
    ? `<button type="button" class="save-btn k-next d-pickup"${busyIds.has(order.id) ? " disabled" : ""}>🛵 Saí para entrega</button>`
    : confirmId === order.id
      ? `<div class="d-confirm-ask">
           <button type="button" class="save-btn k-next d-confirm d-confirm-yes"${busyIds.has(order.id) ? " disabled" : ""}>✅ Sim, foi entregue</button>
           <button type="button" class="item-toggle-all d-confirm-no"${busyIds.has(order.id) ? " disabled" : ""}>Cancelar</button>
         </div>`
      : `<button type="button" class="save-btn k-next d-confirm"${busyIds.has(order.id) ? " disabled" : ""}>✅ Confirmar entrega</button>`;

  return `
  <article class="k-order stage-${escapeHTML(order.stage)}${isOpen ? " is-open" : ""}" data-id="${order.id}">
    <button type="button" class="k-head" aria-expanded="${isOpen}">
      <span class="k-num">#${order.id}</span>
      <span class="k-who">
        <strong>${escapeHTML(order.customer_name || "Sem nome")}</strong>
        <small>${sub}</small>
      </span>
      <span class="k-chevron">▾</span>
    </button>
    <p class="d-address">📍 ${escapeHTML(order.address || "Endereço não informado")}</p>
    ${mapsUrl ? `<a class="d-maps" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ Abrir no Maps</a>` : ""}
    <div class="k-body">
      <ul class="k-items">${items}</ul>
      <div class="k-details">
        ${order.customer_phone ? `<p><span>Telefone</span> <a href="tel:${escapeHTML(order.customer_phone.replace(/\D/g, ""))}">${escapeHTML(order.customer_phone)}</a></p>` : ""}
        ${order.notes ? `<p class="k-notes"><span>Observações</span> ${escapeHTML(order.notes)}</p>` : ""}
        ${paymentLine(order)}
      </div>
    </div>
    ${button}
  </article>`;
}

function render() {
  const list = document.getElementById("d-list");
  document.getElementById("d-count").textContent = orders.length ? `(${orders.length})` : "";
  if (!orders.length) {
    list.innerHTML = `<div class="empty-items">Nenhuma entrega agora. Quando a cozinha marcar um pedido de entrega como "pronto", ele aparece aqui (com aviso sonoro).</div>`;
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
    card.querySelector(".d-confirm:not(.d-confirm-yes)")?.addEventListener("click", () => askDelivery(id));
    card.querySelector(".d-confirm-yes")?.addEventListener("click", () => confirmDelivery(id));
    card.querySelector(".d-confirm-no")?.addEventListener("click", () => cancelAskDelivery());
    card.querySelector(".d-pickup")?.addEventListener("click", () => pickupOrder(id));
  });
}

/* ---------- servidor ---------- */

function renderShift(shift) {
  const countEl = document.getElementById("d-shift-count");
  const sinceEl = document.getElementById("d-shift-since");
  if (!countEl) return;
  countEl.textContent = shift ? shift.deliveries : 0;
  sinceEl.textContent = shift ? `Desde as ${formatClock(shift.started_at)}` : "Nenhuma contagem aberta";
}

function formatClock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

async function loadOrders() {
  try {
    const res = await fetch("/api/entregador/pedidos", { cache: "no-store" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) { setLive(false); return; }
    setLive(true);
    renderShift(data.shift);
    // O admin fechou a noite enquanto o entregador estava conectado: volta ao
    // login (é lá que uma noite nova começa) em vez de contar entregas no vazio.
    if (data.courier_session && !data.shift) {
      showLogin("A noite de entregas foi fechada pelo administrador. Para começar uma nova noite, entre de novo.");
      return;
    }

    const ids = data.orders.map((o) => o.id);
    const readyIds = data.orders.filter((o) => o.stage === "pronto").map((o) => o.id);
    const routeIds = data.orders.filter((o) => o.stage === "em_rota").map((o) => o.id);

    if (knownReady !== null) {
      const freshReady = readyIds.filter((id) => !knownReady.has(id));
      if (freshReady.length) {
        freshReady.forEach((id) => alarmIds.add(id));
        alarmPlays = 0;
        ringAlarm();
        showToast(freshReady.length === 1 ? `Pedido #${freshReady[0]} PRONTO!` : `${freshReady.length} pedidos prontos!`);
      }
    }
    knownReady = new Set(readyIds);
    // O alarme só vale para pedidos que ainda estão prontos (se ele já pegou, some).
    [...alarmIds].forEach((id) => { if (!knownReady.has(id)) alarmIds.delete(id); });
    updateAlarmBanner();
    maybeRepeatAlarm();

    knownIds = new Set(ids);
    [...openIds].forEach((id) => { if (!knownIds.has(id)) openIds.delete(id); });
    if (confirmId !== null && !knownIds.has(confirmId)) confirmId = null;
    clearStaleNotifications(readyIds);

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

async function pickupOrder(id) {
  if (busyIds.has(id)) return;
  busyIds.add(id);
  render();
  try {
    const res = await fetch(`/api/entregador/pedidos/${id}/sair`, { method: "POST" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) showToast(data.error || "Não foi possível marcar a saída");
    else { alarmIds.delete(id); showToast(`Pedido #${id} em rota 🛵`); }
  } catch (error) {
    console.error(error);
    showToast("Sem conexão — tente de novo");
  } finally {
    busyIds.delete(id);
    lastSignature = "";
    await loadOrders();
  }
}

// 1º toque em "Confirmar entrega": pede o 2º toque na própria tela (o
// window.confirm() trava a tela e alguns celulares o bloqueiam). Se ele não
// tocar de novo em 6 s, volta ao normal sozinho.
function askDelivery(id) {
  if (busyIds.has(id)) return;
  confirmId = id;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(cancelAskDelivery, 6000);
  render();
}

function cancelAskDelivery() {
  clearTimeout(confirmTimer);
  if (confirmId === null) return;
  confirmId = null;
  render();
}

async function confirmDelivery(id) {
  const order = orders.find((o) => o.id === id);
  if (!order || busyIds.has(id)) return;
  clearTimeout(confirmTimer);
  confirmId = null;

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

/* ---------- avisos com o app fechado (push) ---------- */

function urlBase64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// iPadOS 13+ se identifica como "Macintosh": diferencia pelo toque.
const IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const IS_STANDALONE = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function setPushUI(state, detail) {
  const btn = document.getElementById("d-push");
  const hint = document.getElementById("d-push-hint");
  const iosHelp = document.getElementById("d-ios-help");
  if (!btn || !hint) return;
  btn.style.display = state === "ask" || state === "ios-install" || state === "error" ? "inline-block" : "none";
  const testBtn = document.getElementById("d-push-test");
  if (testBtn) testBtn.style.display = state === "on" ? "inline-block" : "none";
  if (iosHelp) iosHelp.style.display = state === "ios-install" ? "block" : "none";
  const messages = {
    on: "🔔 Avisos ativados: você recebe o aviso de pedido pronto mesmo com o navegador fechado. O som do aviso é o do celular: deixe o volume alto, o modo silencioso desligado e o modo \"Não perturbe\" fora. Toque em \"Testar aviso\", feche o app e confira.",
    denied: "🔕 Avisos bloqueados. Libere as notificações deste site nas configurações do navegador para receber aviso com o app fechado.",
    unsupported: IS_IOS
      ? "Este iPhone/iPad não permite avisos com o app fechado (precisa do iOS 16.4 ou mais novo). O alarme toca enquanto esta tela estiver aberta."
      : "Este navegador não permite avisos com o app fechado. O alarme toca enquanto esta tela estiver aberta.",
    error: `⚠️ Não foi possível ativar os avisos${detail ? `: ${detail}` : "."} Toque no botão para tentar de novo.`,
  };
  hint.textContent = messages[state] || "";
  hint.style.display = messages[state] ? "block" : "none";
}

// fromClick=true quando o entregador tocou no botão (só assim o navegador deixa pedir a permissão).
async function setupPush(fromClick) {
  try {
    // iOS só tem Web Push com o site instalado na tela de início.
    if (IS_IOS && !IS_STANDALONE) {
      setPushUI("ios-install");
      if (fromClick) document.getElementById("d-ios-help")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushUI("unsupported");
      return;
    }
    // A permissão é pedida antes de qualquer espera de rede: o iOS só aceita dentro do gesto do toque.
    if (fromClick && Notification.permission === "default") await Notification.requestPermission();

    const info = await (await fetch("/api/entregador/push/key", { cache: "no-store" })).json();
    if (!info.ok || !info.enabled) { setPushUI("none"); return; }

    if (Notification.permission === "denied") { setPushUI("denied"); return; }
    if (Notification.permission !== "granted") { setPushUI("ask"); return; }

    const reg = await navigator.serviceWorker.register("/entregador-sw.js");
    await navigator.serviceWorker.ready;
    const key = urlBase64ToBytes(info.key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey) {
      const current = new Uint8Array(sub.options.applicationServerKey);
      if (current.length !== key.length || current.some((b, i) => b !== key[i])) {
        await sub.unsubscribe();   // chave do servidor mudou: inscreve de novo
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const saved = await fetch("/api/entregador/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!saved.ok) throw new Error("o servidor recusou a inscrição");
    setPushUI("on");
    if (fromClick) showToast("Avisos ativados ✓");
  } catch (error) {
    console.error(error);
    setPushUI("error", error && error.message);
  }
}

// Aviso de teste: o servidor manda um push em alguns segundos; o entregador
// fecha o app e confere se o aviso chega.
async function testPush() {
  const btn = document.getElementById("d-push-test");
  btn.disabled = true;
  try {
    const res = await fetch("/api/entregador/push/testar", { method: "POST" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { showToast(data.error || "Não foi possível enviar o teste"); return; }
    showToast(`Feche o app agora — o aviso chega em ${data.delay || 12} s`);
  } catch (error) {
    console.error(error);
    showToast("Sem conexão — tente de novo");
  } finally {
    setTimeout(() => { btn.disabled = false; }, 15000);
  }
}

// Tira da bandeja do celular os avisos de "pronto" de pedidos que já saíram.
async function clearStaleNotifications(readyIds) {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration("/entregador-sw.js");
    if (!reg) return;
    const keep = new Set(readyIds.map(String));
    (await reg.getNotifications()).forEach((n) => {
      const d = n.data || {};
      if (!d.test && !keep.has(String(d.order_id))) n.close();
    });
  } catch (_) { /* sem problema */ }
}

// Endpoint do aviso push deste aparelho ("" se não houver).
async function currentPushEndpoint() {
  try {
    if (!("serviceWorker" in navigator)) return "";
    const reg = await navigator.serviceWorker.getRegistration("/entregador-sw.js");
    const sub = reg && (await reg.pushManager.getSubscription());
    return sub ? sub.endpoint : "";
  } catch (_) { return ""; }
}

// notifyServer=false: quando a sessão já foi encerrada (fechar entregas) o
// servidor recusaria a chamada (401); nesse caso ele já apagou o aparelho.
async function disablePush(notifyServer = true) {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration("/entregador-sw.js");
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    if (notifyServer) {
      await fetch("/api/entregador/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
    }
    await sub.unsubscribe();
  } catch (_) { /* sem problema */ }
}

if ("serviceWorker" in navigator) {
  // O service worker avisa quando chega um "pedido pronto" com a tela aberta: atualiza na hora.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "pedido-pronto" && poller) loadOrders();
  });
}

/* ---------- fechar a noite de entregas ---------- */

function hideCloseConfirm() {
  const box = document.getElementById("d-close-confirm");
  if (box) box.style.display = "none";
}

// 1º toque: mostra a confirmação na própria tela (o confirm() do navegador
// trava a tela e alguns celulares/apps instalados o bloqueiam sem avisar).
function askCloseShift() {
  if (shiftBusy) return;
  const box = document.getElementById("d-close-confirm");
  if (box.style.display !== "none") { hideCloseConfirm(); return; }   // segundo toque = cancela
  const pending = orders.length;
  const count = document.getElementById("d-shift-count").textContent;
  document.getElementById("d-close-confirm-text").textContent =
    `Fechar as entregas de hoje? Total desta noite: ${count} entrega(s). O total vai para o administrador e a contagem é encerrada.` +
    (pending ? ` Atenção: ainda há ${pending} pedido(s) na lista. Se você entregar depois, contam na próxima noite.` : "");
  box.style.display = "block";
}

// 2º toque ("Sim, fechar"): fecha de verdade.
async function closeShift() {
  if (shiftBusy) return;
  shiftBusy = true;
  const openBtn = document.getElementById("d-close-shift");
  const yesBtn = document.getElementById("d-close-yes");
  openBtn.disabled = true;
  yesBtn.disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);   // rede pendurada não deixa o botão travado
  try {
    const endpoint = await currentPushEndpoint();
    const res = await fetch("/api/entregador/turno/fechar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
      signal: controller.signal,
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.already_closed) {   // noite já fechada em outro lugar: sai em vez de ficar preso
      await disablePush(false);
      showLogin(data.error);
      return;
    }
    if (!res.ok || !data.ok) { showToast(data.error || "Não foi possível fechar as entregas"); return; }
    await disablePush(false);   // a sessão já acabou: só cancela o aviso neste aparelho
    showLogin(`✅ Entregas fechadas: ${data.shift.deliveries} entrega(s) nesta noite. O total já está no painel do administrador. Para começar uma nova noite, entre de novo.`);
  } catch (error) {
    console.error(error);
    showToast("Sem conexão — tente de novo");
  } finally {
    clearTimeout(timeout);
    shiftBusy = false;
    openBtn.disabled = false;
    yesBtn.disabled = false;
    hideCloseConfirm();
  }
}

/* ---------- login ---------- */

function showLogin(message) {
  if (poller) { poller.stop(); poller = null; }
  alarmIds.clear();
  updateAlarmBanner();
  hideCloseConfirm();
  clearTimeout(confirmTimer);
  confirmId = null;
  knownReady = null;
  const msg = document.getElementById("d-closed-msg");
  msg.textContent = message || "";
  msg.style.display = message ? "block" : "none";
  document.getElementById("d-login").style.display = "block";
  document.getElementById("d-board").style.display = "none";
  document.getElementById("d-logout").style.display = "none";
}

async function showBoard() {
  document.getElementById("d-login").style.display = "none";
  document.getElementById("d-board").style.display = "block";
  document.getElementById("d-logout").style.display = "inline-block";
  knownIds = null;
  knownReady = null;
  lastSignature = "";
  updateSoundButton();
  // Garante que a noite de entregas está aberta (entrar já abre; isto cobre
  // quem continua logado de antes).
  try { await fetch("/api/entregador/turno/iniciar", { method: "POST" }); } catch (_) { /* tenta na próxima */ }
  loadOrders();
  if (poller) poller.stop();
  poller = LiveRefresh.every(loadOrders, POLL_MS, { keepAlive: true });
  keepScreenOn();
  setupPush(false);
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
    unlockAudio();   // o toque em "Entrar" já libera o som para o alarme
    showBoard();
  } catch (error) {
    errorEl.textContent = "Sem conexão com o servidor.";
    errorEl.style.display = "block";
  }
}

document.getElementById("d-login-btn").addEventListener("click", login);
document.getElementById("d-password").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
document.getElementById("d-logout").addEventListener("click", async () => {
  await disablePush();
  await fetch("/api/entregador/logout", { method: "POST" }).catch(() => {});
  showLogin();
});
document.getElementById("d-close-shift").addEventListener("click", askCloseShift);
document.getElementById("d-close-yes").addEventListener("click", closeShift);
document.getElementById("d-close-no").addEventListener("click", hideCloseConfirm);
document.getElementById("d-sound").addEventListener("click", async () => {
  const ok = await unlockAudio();
  if (ok) playAlarmSound();
});
document.getElementById("d-push").addEventListener("click", () => setupPush(true));
document.getElementById("d-push-test").addEventListener("click", testPush);
document.getElementById("d-alarm-stop").addEventListener("click", () => {
  alarmIds.clear();
  alarmPlays = 0;
  updateAlarmBanner();
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
