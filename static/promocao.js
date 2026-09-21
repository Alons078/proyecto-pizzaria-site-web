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
    renderPromotion(currentPromo, currentItems);
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="product-warning">Não foi possível carregar a promoção.</p>`;
  }
}

function renderPromotion(promo, items) {
  const container = document.getElementById("promo-content");
  const slots = (promo.slots || []).map((slot, index) => {
    const options = items.filter((item) => item.category === slot.category);
    return `<div class="promo-slot-block">
      <label>${escapeHTML(slot.label || `Escolha ${index + 1}`)}</label>
      <select class="promo-select" data-slot-index="${index}" data-category="${escapeHTML(slot.category)}">
        <option value="">Selecione ${escapeHTML(categoryLabel(slot.category))}</option>
        ${options.map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}${Number(item.promo_extra || 0) > 0 ? ` (+${cartFormatPrice(item.promo_extra)})` : ""}</option>`).join("")}
      </select>
    </div>`;
  }).join("");

  container.innerHTML = `
    <div class="product-image">
      ${promo.image ? `<img src="${escapeHTML(promo.image)}" alt="${escapeHTML(promo.name)}">` : `<span>foto</span>`}
    </div>
    <h1 class="product-title">${escapeHTML(promo.name)}</h1>
    ${promo.description ? `<p class="product-description">${escapeHTML(promo.description)}</p>` : ""}

    <div class="promo-choices">${slots}</div>

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
        <label>Endereço para entrega</label>
        <input type="text" id="buy-now-address" placeholder="Rua, número, bairro">
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
      <a href="#" class="checkout-btn" id="buy-now-confirm">📲 Confirmar pedido pelo WhatsApp</a>
      <p class="product-warning" id="buy-now-warning"></p>
    </div>
  `;

  const selects = [...container.querySelectorAll(".promo-select")];
  selects.forEach((select) => select.addEventListener("change", updatePromoState));
  document.getElementById("qty-minus").addEventListener("click", () => updateQty(-1));
  document.getElementById("qty-plus").addEventListener("click", () => updateQty(1));
  document.getElementById("add-to-cart-btn").addEventListener("click", addToCart);
  document.getElementById("buy-now-btn").addEventListener("click", toggleInlineCheckout);

  const deliverySelect = document.getElementById("buy-now-delivery");
  const addressField = document.getElementById("buy-now-address-field");
  const toggleAddressField = () => {
    addressField.style.display = deliverySelect.value === "Entrega (delivery)" ? "block" : "none";
  };
  deliverySelect.addEventListener("change", toggleAddressField);
  toggleAddressField();

  buyNowFee = cartAttachDeliveryFee({
    deliverySelect,
    addressInput: document.getElementById("buy-now-address"),
    mount: document.getElementById("buy-now-fee-field"),
    onChange: () => {},
  });

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

function addToCart() {
  if (!allSlotsChosen()) return;

  const selects = [...document.querySelectorAll(".promo-select")];
  const chosenNames = selects.map((select) => {
    const item = currentItems.find((i) => String(i.id) === String(select.value));
    return item ? item.name : "";
  }).filter(Boolean);

  const unitPrice = currentUnitPrice();
  const choiceKey = selects.map((s) => s.value).join("-");

  cartAdd({
    key: `promo-${currentPromo.id}-${choiceKey}`,
    type: "promotion",
    id: currentPromo.id,
    name: `${currentPromo.name} (${chosenNames.join(", ")})`,
    qty: currentQty,
    unit_price: unitPrice,
  });

  const btn = document.getElementById("add-to-cart-btn");
  const original = btn.textContent;
  btn.textContent = "Adicionado ✓";
  setTimeout(() => { btn.textContent = original; }, 1200);
}

function toggleInlineCheckout() {
  if (!allSlotsChosen()) return;
  const panel = document.getElementById("inline-checkout");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
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
  warningEl.textContent = "";
  const deliveryFee = buyNowFee ? buyNowFee.feeAmount() : 0;

  const selects = [...document.querySelectorAll(".promo-select")];
  const chosenNames = selects.map((select) => {
    const item = currentItems.find((i) => String(i.id) === String(select.value));
    return item ? item.name : "";
  }).filter(Boolean);

  const unitPrice = currentUnitPrice();
  const line = {
    name: `${currentPromo.name} (${chosenNames.join(", ")})`,
    qty: currentQty,
    unit_price: unitPrice,
  };
  const total = unitPrice * currentQty + deliveryFee;   // total COM a taxa de entrega
  const checkout = {
    name: customerName,
    delivery,
    address,
    payment,
    notes: "",
    trocoPaidWith: null,
    trocoAmount: null,
    deliveryFeeText: buyNowFee ? buyNowFee.feeText() : null,
  };

  cartRegisterOrder([line], checkout);
  const message = cartOrderMessage([line], total, checkout);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
}

loadPromotion();
