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

function renderPromotion(promo, items) {
  const container = document.getElementById("promo-content");
  const slots = (promo.slots || []).map((slot, index) => {
    const options = items.filter((item) => item.category === slot.category && item.available !== false);
    return `<div class="promo-slot-block">
      <label>${escapeHTML(slot.label || `Escolha ${index + 1}`)}</label>
      <select class="promo-select" data-slot-index="${index}" data-category="${escapeHTML(slot.category)}">
        <option value="">Selecione ${escapeHTML(categoryLabel(slot.category))}</option>
        ${options.map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}${Number(item.promo_extra || 0) > 0 ? ` (+${cartFormatPrice(item.promo_extra)})` : ""}</option>`).join("")}
      </select>
    </div>`;
  }).join("");

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

  const selects = [...container.querySelectorAll(".promo-select")];
  selects.forEach((select) => select.addEventListener("change", updatePromoState));
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
  const selects = [...document.querySelectorAll(".promo-select")];
  selects.forEach((select) => {
    if (!select.value) return;
    const item = currentItems.find((i) => String(i.id) === String(select.value));
    total += Number(item?.promo_extra || 0);
  });
  const borda = currentBorda();
  if (borda) total += Number(borda.price || 0);
  return total;
}

function allSlotsChosen() {
  const selects = [...document.querySelectorAll(".promo-select")];
  return selects.every((select) => select.value);
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
  const selects = [...document.querySelectorAll(".promo-select")];
  const chosenNames = selects.map((select) => {
    const item = currentItems.find((i) => String(i.id) === String(select.value));
    return item ? item.name : "";
  }).filter(Boolean);

  const borda = currentBorda();
  if (borda) chosenNames.push(`Borda de ${borda.name}`);

  const unitPrice = currentUnitPrice();
  let choiceKey = selects.map((s) => s.value).join("-");
  if (selectedBordaId != null) choiceKey += `-borda-${selectedBordaId}`;

  return {
    key: `promo-${currentPromo.id}-${choiceKey}`,
    type: "promotion",
    id: currentPromo.id,
    name: `${currentPromo.name} (${chosenNames.join(", ")})`,
    qty: currentQty,
    unit_price: unitPrice,
  };
}

function addToCart() {
  if (!allSlotsChosen()) return;

  cartAdd(buildCartEntry());

  const btn = document.getElementById("add-to-cart-btn");
  const original = btn.textContent;
  btn.textContent = "Adicionado ✓";
  setTimeout(() => { btn.textContent = original; }, 1200);
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
  const delivery = document.getElementById("buy-now-delivery").value;
  const address = document.getElementById("buy-now-address").value.trim();
  const payment = document.getElementById("buy-now-payment").value;
  const trocoRaw = document.getElementById("buy-now-troco").value.trim();

  if (!customerName) {
    warningEl.textContent = "Digite seu nome para confirmar o pedido.";
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

  const selects = [...document.querySelectorAll(".promo-select")];
  const chosenNames = selects.map((select) => {
    const item = currentItems.find((i) => String(i.id) === String(select.value));
    return item ? item.name : "";
  }).filter(Boolean);

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
    delivery,
    address,
    payment,
    notes: "",
    trocoPaidWith,
    trocoAmount,
    deliveryFeeText: buyNowFee ? buyNowFee.feeText() : null,
  };

  cartRegisterOrder([line], checkout);
  const message = cartOrderMessage([line], total, checkout);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
}

loadPromotion();
