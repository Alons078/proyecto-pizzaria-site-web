/* Página de detalhe de uma promoção: escolher os sabores de cada posição
 * (slot) e adicionar ao carrinho com o preço já calculado, incluindo
 * qualquer valor extra dos sabores escolhidos. */

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function categoryLabel(category) {
  return { pizza: "Pizza", salgado: "Salgado", bebida: "Bebida" }[category] || category;
}

let currentPromo = null;
let currentItems = [];
let currentQty = 1;
let storeInfo = { whatsapp_number: "" };
let buyNowFee = null; // controlador da taxa de entrega (ver cart.js)
let updateBuyNowTroco = () => {}; // atualiza o resultado do troco (definida a cada render)
let storeBordas = [];
let selectedBordaId = null;

/* Estado por slot: "one" (1 sabor, seleção simples) ou "split" (meia a meia,
 * máximo 2 sabores — mesmo limite do broto/média). Só se aplica a slots de
 * categoria "pizza" com pelo menos 2 opções disponíveis. */
let promoSlotMode = {};   // { [slotIndex]: "one" | "split" }
let promoSlotSingle = {}; // { [slotIndex]: itemId }
let promoSlotSplit = {};  // { [slotIndex]: [itemId1, itemId2] }

async function loadPromotion() {
  const container = document.getElementById("promo-content");
  try {
    const res = await fetch(`/api/promotion/${PROMO_ID}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      container.innerHTML = `<p class="product-warning">Promoção não encontrada.</p>`;
      return;
    }
    currentPromo = data.promotion;
    currentItems = data.items;
    storeInfo = data.store || {};
    storeBordas = Array.isArray(data.store && data.store.bordas) ? data.store.bordas : [];
    selectedBordaId = null;
    promoSlotMode = {};
    promoSlotSingle = {};
    promoSlotSplit = {};
    renderPromotion(currentPromo, currentItems);
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="product-warning">Não foi possível carregar a promoção.</p>`;
  }
}

function promoIncludesPizza(promo) {
  return (promo.slots || []).some((s) => s.category === "pizza");
}

function currentBorda() {
  if (selectedBordaId == null) return null;
  return storeBordas.find((b) => String(b.id) === String(selectedBordaId)) || null;
}

function slotOptions(slot) {
  return currentItems.filter((item) => item.category === slot.category && item.available !== false);
}

/* HTML do corpo de um slot: seleção simples, ou — para slots de pizza com
 * pelo menos 2 opções — um alternador "1 sabor / Meia a meia (2 sabores)". */
function slotBodyHTML(slot, index) {
  const options = slotOptions(slot);
  const canSplit = slot.category === "pizza" && options.length >= 2;
  const mode = canSplit ? (promoSlotMode[index] || "one") : "one";

  const singleSelectHTML = () => `
    <select class="promo-select" data-slot-index="${index}" data-category="${escapeHTML(slot.category)}">
      <option value="">Selecione ${escapeHTML(categoryLabel(slot.category))}</option>
      ${options.map((item) => `<option value="${escapeHTML(item.id)}"${String(promoSlotSingle[index] ?? "") === String(item.id) ? " selected" : ""}>${escapeHTML(item.name)}${Number(item.promo_extra || 0) > 0 ? ` (+${cartFormatPrice(item.promo_extra)})` : ""}</option>`).join("")}
    </select>
  `;

  if (!canSplit) return singleSelectHTML();

  if (!Array.isArray(promoSlotSplit[index]) || promoSlotSplit[index].length !== 2) {
    promoSlotSplit[index] = [options[0].id, (options[1] || options[0]).id];
  }
  const splitIds = promoSlotSplit[index];
  const splitOptionsHTML = (selectedId) => options.map((o) => `<option value="${escapeHTML(o.id)}"${String(selectedId) === String(o.id) ? " selected" : ""}>${escapeHTML(o.name)}${Number(o.promo_extra || 0) > 0 ? ` (+${cartFormatPrice(o.promo_extra)})` : ""}</option>`).join("");

  return `
    <div class="flavor-mode-options">
      <button type="button" class="flavor-mode-btn${mode === "one" ? " selected" : ""}" data-slot-index="${index}" data-mode="one">1 sabor</button>
      <button type="button" class="flavor-mode-btn${mode === "split" ? " selected" : ""}" data-slot-index="${index}" data-mode="split">Meia a meia (2 sabores)</button>
    </div>
    ${mode === "split" ? `
      <p class="flavor-hint">Escolha o sabor de cada metade:</p>
      <div class="half-flavor-row">
        <div class="half-flavor-field">
          <label>1ª metade</label>
          <select class="half-flavor-select promo-split-select" data-slot-index="${index}" data-part-index="0">${splitOptionsHTML(splitIds[0])}</select>
        </div>
        <div class="half-flavor-field">
          <label>2ª metade</label>
          <select class="half-flavor-select promo-split-select" data-slot-index="${index}" data-part-index="1">${splitOptionsHTML(splitIds[1])}</select>
        </div>
      </div>
    ` : singleSelectHTML()}
  `;
}

/* Re-renderiza só o corpo de um slot (ao trocar de modo), sem mexer nos
 * outros slots já preenchidos. */
function renderSlotBody(index) {
  const slot = (currentPromo.slots || [])[index];
  if (!slot) return;
  const el = document.getElementById(`promo-slot-${index}`);
  if (!el) return;
  el.querySelector(".promo-slot-body").innerHTML = slotBodyHTML(slot, index);
  updatePromoState();
}

/* Seleção atual de um slot: { mode, ids } ou null se ainda incompleto. */
function getSlotSelection(index) {
  const canSplit = (promoSlotMode[index] || "one") === "split";
  if (canSplit) {
    const ids = promoSlotSplit[index] || [];
    if (ids.length !== 2 || ids[0] == null || ids[0] === "" || ids[1] == null || ids[1] === "") return null;
    return { mode: "split", ids };
  }
  const id = promoSlotSingle[index];
  if (id == null || id === "") return null;
  return { mode: "one", ids: [id] };
}

function renderPromotion(promo, items) {
  const container = document.getElementById("promo-content");
  const slots = (promo.slots || []).map((slot, index) => `
    <div class="promo-slot-block" id="promo-slot-${index}">
      <label>${escapeHTML(slot.label || `Escolha ${index + 1}`)}</label>
      <div class="promo-slot-body">${slotBodyHTML(slot, index)}</div>
    </div>
  `).join("");

  let bordaHTML = "";
  if (promoIncludesPizza(promo) && storeBordas.length) {
    bordaHTML = `
    <div class="flavor-block">
      <label>Borda recheada</label>
      <div class="flavor-options" id="borda-options">
        <label class="flavor-option">
          <input type="radio" name="borda" value="" ${selectedBordaId == null ? "checked" : ""}>
          <span class="flavor-name">Sem borda</span>
        </label>
        ${storeBordas.map((borda) => `
          <label class="flavor-option">
            <input type="radio" name="borda" value="${escapeHTML(borda.id)}" ${String(selectedBordaId) === String(borda.id) ? "checked" : ""}>
            <span class="flavor-name">Borda de ${escapeHTML(borda.name)}</span>
            <span class="flavor-extra">+${cartFormatPrice(borda.price)}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `;
  }

  container.innerHTML = `
    <div class="product-image">
      ${promo.image ? `<img src="${escapeHTML(promo.image)}" alt="${escapeHTML(promo.name)}">` : `<span>foto</span>`}
    </div>
    <h1 class="product-title">${escapeHTML(promo.name)}</h1>
    ${promo.description ? `<p class="product-description">${escapeHTML(promo.description)}</p>` : ""}

    <div class="promo-choices">${slots}</div>
    ${bordaHTML}

    <div class="qty-control">
      <button type="button" id="qty-minus" aria-label="Diminuir quantidade">−</button>
      <span class="qty-value" id="qty-value">1</span>
      <button type="button" id="qty-plus" aria-label="Aumentar quantidade">+</button>
    </div>

    <div class="product-price" id="promo-price">${cartFormatPrice(promo.price)}</div>
    <div class="product-warning" id="promo-warning" aria-live="polite"></div>

    <div class="product-actions">
      <button type="button" class="add-to-cart-btn" id="add-to-cart-btn">Adicionar ao carrinho</button>
      <button type="button" class="buy-now-btn" id="buy-now-btn">📲 Pagar agora</button>
    </div>

    <div class="inline-checkout" id="inline-checkout" style="display:none;">
      <h2>Finalizar pedido</h2>
      <div class="checkout-field">
        <label>Seu nome</label>
        <input type="text" id="buy-now-name" placeholder="Nome para o pedido">
      </div>
      <div class="checkout-field">
        <label>Seu telefone</label>
        <input type="tel" id="buy-now-phone" placeholder="Ex.: (21) 99999-9999" inputmode="tel">
        <p class="checkout-hint">É para o entregador poder te ligar caso precise de alguma informação.</p>
      </div>
      <div class="checkout-field">
        <label>Forma de entrega</label>
        <select id="buy-now-delivery">
          <option value="Retirada no local">Retirada no local</option>
          <option value="Entrega (delivery)">Entrega (delivery)</option>
        </select>
      </div>
      <div class="checkout-field" id="buy-now-address-field">
        <label>Bairro de entrega</label>
        <div class="flavor-mode-options">
          <button type="button" class="zone-option flavor-mode-btn" data-zone="Piscinão de Ramos">Piscinão de Ramos</button>
          <button type="button" class="zone-option flavor-mode-btn" data-zone="Ramos">Ramos</button>
        </div>
        <div class="zone-address-wrap" style="display:none;">
          <label>Seu endereço (rua, número)</label>
          <input type="text" class="zone-street-input" placeholder="Rua, número">
        </div>
        <input type="hidden" class="zone-hidden-address" id="buy-now-address">
      </div>
      <div class="checkout-field" id="buy-now-fee-field"></div>
      <div class="checkout-field">
        <label>Forma de pagamento</label>
        <select id="buy-now-payment">
          <option value="Dinheiro">Dinheiro</option>
          <option value="Cartão na entrega">Cartão na entrega</option>
          <option value="Pix">Pix</option>
        </select>
      </div>
      <div class="checkout-field" id="buy-now-troco-field">
        <label>Troco para quanto? (opcional)</label>
        <input type="number" id="buy-now-troco" placeholder="Ex.: 100" min="0" step="0.01" inputmode="decimal">
        <p class="troco-result" id="buy-now-troco-result"></p>
      </div>
      <a href="#" class="checkout-btn" id="buy-now-confirm">📲 Confirmar pedido pelo WhatsApp</a>
      <p class="product-warning" id="buy-now-warning"></p>
    </div>
  `;

  const promoChoicesEl = container.querySelector(".promo-choices");
  promoChoicesEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".flavor-mode-btn[data-slot-index]");
    if (!btn) return;
    const idx = Number(btn.dataset.slotIndex);
    promoSlotMode[idx] = btn.dataset.mode;
    renderSlotBody(idx);
  });
  promoChoicesEl.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches(".promo-select[data-slot-index]")) {
      promoSlotSingle[Number(target.dataset.slotIndex)] = target.value;
      updatePromoState();
    } else if (target.matches(".promo-split-select")) {
      const idx = Number(target.dataset.slotIndex);
      const part = Number(target.dataset.partIndex);
      if (!Array.isArray(promoSlotSplit[idx])) promoSlotSplit[idx] = [];
      promoSlotSplit[idx][part] = target.value;
      updatePromoState();
    }
  });
  container.querySelectorAll('input[name="borda"]').forEach((input) => {
    input.addEventListener("change", () => {
      selectedBordaId = input.value ? input.value : null;
      updatePromoState();
    });
  });
  document.getElementById("qty-minus").addEventListener("click", () => updateQty(-1));
  document.getElementById("qty-plus").addEventListener("click", () => updateQty(1));
  document.getElementById("add-to-cart-btn").addEventListener("click", addToCart);
  document.getElementById("buy-now-btn").addEventListener("click", goToCartToPay);

  const deliverySelect = document.getElementById("buy-now-delivery");
  const addressField = document.getElementById("buy-now-address-field");
  const toggleAddressField = () => {
    addressField.style.display = deliverySelect.value === "Entrega (delivery)" ? "block" : "none";
  };
  deliverySelect.addEventListener("change", toggleAddressField);
  toggleAddressField();

  cartAttachDeliveryZone(document.getElementById("buy-now-address-field"));

  buyNowFee = cartAttachDeliveryFee({
    deliverySelect,
    addressInput: document.getElementById("buy-now-address"),
    mount: document.getElementById("buy-now-fee-field"),
    onChange: () => updateBuyNowTroco(),
  });

  const buyNowPaymentSelect = document.getElementById("buy-now-payment");
  const buyNowTrocoField = document.getElementById("buy-now-troco-field");
  const buyNowTrocoInput = document.getElementById("buy-now-troco");
  const buyNowTrocoResult = document.getElementById("buy-now-troco-result");

  const toggleBuyNowTrocoField = () => {
    const isDinheiro = buyNowPaymentSelect.value === "Dinheiro";
    buyNowTrocoField.style.display = isDinheiro ? "block" : "none";
    if (!isDinheiro) {
      buyNowTrocoInput.value = "";
      buyNowTrocoResult.textContent = "";
      buyNowTrocoResult.classList.remove("troco-warning");
    }
  };

  function updateBuyNowTrocoResult() {
    const raw = buyNowTrocoInput.value.trim();
    const grandTotal = currentUnitPrice() * currentQty + (buyNowFee ? buyNowFee.feeAmount() : 0);
    if (!raw) {
      buyNowTrocoResult.textContent = "";
      buyNowTrocoResult.classList.remove("troco-warning");
      return;
    }
    const paidWith = Number(raw.replace(",", "."));
    if (Number.isNaN(paidWith)) {
      buyNowTrocoResult.textContent = "";
      buyNowTrocoResult.classList.remove("troco-warning");
      return;
    }
    if (paidWith < grandTotal) {
      buyNowTrocoResult.textContent = `Valor menor que o total do pedido (${cartFormatPrice(grandTotal)}).`;
      buyNowTrocoResult.classList.add("troco-warning");
      return;
    }
    buyNowTrocoResult.textContent = `Troco: ${cartFormatPrice(paidWith - grandTotal)}`;
    buyNowTrocoResult.classList.remove("troco-warning");
  }

  updateBuyNowTroco = updateBuyNowTrocoResult;
  buyNowPaymentSelect.addEventListener("change", toggleBuyNowTrocoField);
  buyNowTrocoInput.addEventListener("input", updateBuyNowTrocoResult);
  toggleBuyNowTrocoField();

  document.getElementById("buy-now-confirm").addEventListener("click", buyNowConfirm);

  updatePromoState();
}

function currentUnitPrice() {
  let total = Number(currentPromo.price || 0);
  (currentPromo.slots || []).forEach((slot, index) => {
    const sel = getSlotSelection(index);
    if (!sel) return;
    sel.ids.forEach((id) => {
      const item = currentItems.find((i) => String(i.id) === String(id));
      total += Number(item?.promo_extra || 0);
    });
  });
  const borda = currentBorda();
  if (borda) total += Number(borda.price || 0);
  return total;
}

function allSlotsChosen() {
  return (currentPromo.slots || []).every((slot, index) => getSlotSelection(index) !== null);
}

/* Nomes escolhidos em cada slot, prontos para exibir (ex.: "Meia
 * Calabresa / Meia Frango" quando o slot está no modo meia a meia). */
function chosenSlotNames() {
  return (currentPromo.slots || []).map((slot, index) => {
    const sel = getSlotSelection(index);
    if (!sel) return "";
    const names = sel.ids.map((id) => {
      const item = currentItems.find((i) => String(i.id) === String(id));
      return item ? item.name : "";
    }).filter(Boolean);
    if (sel.mode === "split" && names.length === 2) {
      if (names[0] === names[1]) return names[0];
      return `Meia ${names[0]} / Meia ${names[1]}`;
    }
    return names[0] || "";
  }).filter(Boolean);
}

function updatePromoState() {
  const priceEl = document.getElementById("promo-price");
  const warningEl = document.getElementById("promo-warning");
  const btn = document.getElementById("add-to-cart-btn");
  const buyBtn = document.getElementById("buy-now-btn");
  const complete = allSlotsChosen();

  priceEl.textContent = cartFormatPrice(currentUnitPrice() * currentQty);
  warningEl.textContent = complete ? "" : "Selecione todas as opções para adicionar ao carrinho.";
  updateBuyNowTroco();
  if (btn) {
    btn.disabled = !complete;
    btn.style.opacity = complete ? "1" : "0.5";
    btn.style.cursor = complete ? "pointer" : "not-allowed";
  }
  if (buyBtn) {
    buyBtn.disabled = !complete;
    buyBtn.style.opacity = complete ? "1" : "0.5";
    buyBtn.style.cursor = complete ? "pointer" : "not-allowed";
  }
}

function updateQty(delta) {
  currentQty = Math.max(1, currentQty + delta);
  document.getElementById("qty-value").textContent = currentQty;
  updatePromoState();
}

function buildCartEntry() {
  const chosenNames = chosenSlotNames();

  const borda = currentBorda();
  if (borda) chosenNames.push(`Borda de ${borda.name}`);

  const unitPrice = currentUnitPrice();
  let choiceKey = (currentPromo.slots || []).map((slot, index) => {
    const sel = getSlotSelection(index);
    return sel ? sel.ids.join("-") : "x";
  }).join("_");
  if (selectedBordaId != null) choiceKey += `-borda-${selectedBordaId}`;

  return {
    key: `promo-${currentPromo.id}-${choiceKey}`,
    type: "promotion",
    id: currentPromo.id,
    name: `${currentPromo.name} (${chosenNames.join(", ")})`,
    qty: currentQty,
    unit_price: unitPrice,
    // Quantas pizzas tem em uma unidade desta promoção (ex.: promoção de
    // "2 pizzas" = 2). Só usado pro resumo de vendas do admin.
    pizza_count: (currentPromo.slots || []).filter((s) => s.category === "pizza").length,
  };
}

function addToCart() {
  if (!allSlotsChosen()) return;

  cartAdd(buildCartEntry());

  const btn = document.getElementById("add-to-cart-btn");
  const original = btn.textContent;
  cartFlyToBadge(btn, "🎉");
  btn.textContent = "Adicionado ✓";
  btn.classList.add("is-added");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("is-added");
  }, 1200);
}

/* Botão "Pagar agora": adiciona esta promoção (com os sabores/borda
 * escolhidos) ao carrinho e leva o cliente direto pra página do carrinho,
 * já com tudo lá dentro, pra finalizar o pedido por lá. */
function goToCartToPay() {
  if (!allSlotsChosen()) return;
  cartAdd(buildCartEntry());
  window.location.href = "/carrinho";
}

function buyNowConfirm(event) {
  event.preventDefault();
  if (!allSlotsChosen()) return;

  const warningEl = document.getElementById("buy-now-warning");
  const phone = String(storeInfo.whatsapp_number || "").replace(/\D/g, "");

  if (!phone) {
    warningEl.textContent = "A pizzaria ainda não configurou um número de WhatsApp. Entre em contato diretamente.";
    return;
  }

  const customerName = document.getElementById("buy-now-name").value.trim();
  const customerPhone = document.getElementById("buy-now-phone").value.trim();
  const delivery = document.getElementById("buy-now-delivery").value;
  const address = document.getElementById("buy-now-address").value.trim();
  const payment = document.getElementById("buy-now-payment").value;
  const trocoRaw = document.getElementById("buy-now-troco").value.trim();

  if (!customerName) {
    warningEl.textContent = "Digite seu nome para confirmar o pedido.";
    return;
  }
  if (!customerPhone) {
    warningEl.textContent = "Digite seu telefone para confirmar o pedido.";
    return;
  }
  if (delivery === "Entrega (delivery)" && !address) {
    warningEl.textContent = "Digite o endereço de entrega.";
    return;
  }
  if (buyNowFee && buyNowFee.isBusy()) {
    warningEl.textContent = "Aguarde, ainda estamos calculando a taxa de entrega.";
    return;
  }
  if (buyNowFee && !buyNowFee.isResolved()) {
    warningEl.textContent = "Toque em “Calcular taxa de entrega” antes de confirmar o pedido.";
    return;
  }
  const deliveryFee = buyNowFee ? buyNowFee.feeAmount() : 0;

  const chosenNames = chosenSlotNames();

  const borda = currentBorda();
  if (borda) chosenNames.push(`Borda de ${borda.name}`);

  const unitPrice = currentUnitPrice();
  const line = {
    name: `${currentPromo.name} (${chosenNames.join(", ")})`,
    qty: currentQty,
    unit_price: unitPrice,
  };
  const total = unitPrice * currentQty + deliveryFee;   // total COM a taxa de entrega

  let trocoPaidWith = null;
  let trocoAmount = null;
  if (payment === "Dinheiro" && trocoRaw) {
    trocoPaidWith = Number(trocoRaw.replace(",", "."));
    if (Number.isNaN(trocoPaidWith)) {
      warningEl.textContent = "Digite um valor válido para o troco.";
      return;
    }
    if (trocoPaidWith < total) {
      warningEl.textContent = `O valor para troco precisa ser maior ou igual ao total (${cartFormatPrice(total)}).`;
      return;
    }
    trocoAmount = trocoPaidWith - total;
  }
  warningEl.textContent = "";

  const checkout = {
    name: customerName,
    phone: customerPhone,
    delivery,
    address,
    payment,
    notes: "",
    trocoPaidWith,
    trocoAmount,
    deliveryFeeText: buyNowFee ? buyNowFee.feeText() : null,
  };

  const orderPromise = cartRegisterOrder([line], checkout);
  const message = cartOrderMessage([line], total, checkout);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
  cartGoToTracking(orderPromise);
}

loadPromotion();

/* Se o admin mudar preço, sabor, esgotado, promoção ou horário enquanto o
 * cliente está aqui: recarrega sozinha (se ele ainda não mexeu em nada) ou
 * mostra a faixa "Atualizar agora" (se já estava preenchendo o pedido). */
LiveRefresh.watchPage({
  pick: (d) => ({ store: d.store, items: d.items, promotions: d.promotions, pizza_sizes: d.pizza_sizes }),
});
