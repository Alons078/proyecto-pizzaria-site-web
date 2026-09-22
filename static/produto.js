/* Página de detalhe de um produto: escolher tamanho, sabores extras (pizza),
 * quantidade, e adicionar ao carrinho — ou pagar direto por aqui mesmo,
 * sem passar pelo carrinho. */

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let currentItem = null;
let currentQty = 1;
let currentSizes = [];
let selectedSizeId = null;
let currentAllItems = [];
let selectedFlavorIds = [];
/* mode: "one" = solo el sabor de la pizza; "half" = meia a meia (2 sabores) */
let flavorMode = "one";
let halfFlavor1Id = null; // primera mitad (puede ser el sabor actual u otro)
let halfFlavor2Id = null; // segunda mitad
let storeInfo = { whatsapp_number: "" };
let buyNowFee = null; // controlador da taxa de entrega (ver cart.js)
let updateBuyNowTroco = () => {}; // atualiza o resultado do troco (definida a cada render)
let storeBordas = [];
let selectedBordaId = null;

async function loadProduct() {
  const container = document.getElementById("product-content");
  try {
    const [itemRes, dataRes] = await Promise.all([
      fetch(`/api/item/${ITEM_ID}`),
      fetch(`/api/data`),
    ]);
    const data = await itemRes.json();
    if (!itemRes.ok || !data.ok) {
      container.innerHTML = `<p class="product-warning">Produto não encontrado.</p>`;
      return;
    }
    currentItem = data.item;
    currentSizes = Array.isArray(data.pizza_sizes) ? data.pizza_sizes : [];
    if (currentSizes.length) selectedSizeId = currentSizes[0].id;
    storeInfo = data.store || {};
    storeBordas = Array.isArray(data.store && data.store.bordas) ? data.store.bordas : [];
    selectedBordaId = null;

    try {
      const siteData = await dataRes.json();
      currentAllItems = Array.isArray(siteData.items) ? siteData.items : [];
    } catch (error) {
      currentAllItems = [];
    }

    renderProduct(currentItem);
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="product-warning">Não foi possível carregar o produto.</p>`;
  }
}

/* Quantos sabores no total (contando o sabor original) uma pizza aceita,
 * de acordo com o tamanho escolhido. Broto e Média aceitam até 2 sabores
 * no total (1 extra); Grande e Família aceitam até 4 (3 extras). Se o
 * nome do tamanho não bater com nenhum desses, usa o diâmetro (cm) como
 * critério de reserva, pra continuar funcionando mesmo se o admin
 * renomear os tamanhos. */
function maxTotalFlavors(size) {
  if (!size) return 1;
  const name = String(size.name || "").toLowerCase();
  if (name.includes("broto") || name.includes("média") || name.includes("media")) return 2;
  if (name.includes("grande") || name.includes("família") || name.includes("familia")) return 4;
  return Number(size.cm) > 32 ? 4 : 2;
}

function currentSize() {
  return currentSizes.find((s) => s.id === selectedSizeId) || null;
}

function pizzaFlavorOptions() {
  if (!currentItem || currentItem.category !== "pizza") return [];
  // Todas as pizzas disponíveis (incluído o sabor atual, mesmo que ele
  // esteja esgotado) para poder escolher na meia a meia. Sabores esgotados
  // de outras pizzas não entram na lista, pra não vender o que não tem.
  return currentAllItems.filter((i) => i.category === "pizza" && (i.available !== false || i.id === currentItem.id));
}

function otherPizzaFlavors() {
  if (!currentItem || currentItem.category !== "pizza") return [];
  return currentAllItems.filter((i) => i.category === "pizza" && i.id !== currentItem.id && i.available !== false);
}

function renderProduct(item) {
  const container = document.getElementById("product-content");
  const sizesHTML = currentSizes.length ? `
    <div class="size-control">
      <label>Escolha o tamanho</label>
      <div class="size-options" id="size-options">
        ${currentSizes.map((size) => `
          <button type="button" class="size-option${size.id === selectedSizeId ? " selected" : ""}" data-size-id="${size.id}">
            <span class="size-name">${escapeHTML(size.name)}</span>
            <span class="size-cm">${escapeHTML(String(size.cm))}cm</span>
            <span class="size-price">${cartFormatPrice(size.price)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  ` : "";

  const allFlavors = pizzaFlavorOptions();
  const canHalf = allFlavors.length >= 2 && currentSizes.length && maxTotalFlavors(currentSize()) >= 2;

  let flavorsHTML = "";
  if (canHalf) {
    const optionsHTML = (selectedId) => allFlavors.map((f) => {
      const extra = Number(f.promo_extra || 0) > 0 && f.id !== currentItem.id
        ? ` (+${cartFormatPrice(f.promo_extra)})` : "";
      const selected = Number(selectedId) === Number(f.id) ? " selected" : "";
      return `<option value="${f.id}"${selected}>${escapeHTML(f.name)}${extra}</option>`;
    }).join("");

    if (halfFlavor1Id == null) halfFlavor1Id = currentItem.id;
    if (halfFlavor2Id == null && allFlavors.length) {
      const other = allFlavors.find((f) => f.id !== currentItem.id);
      halfFlavor2Id = other ? other.id : allFlavors[0].id;
    }

    flavorsHTML = `
    <div class="flavor-block flavor-block-compact">
      <label>Como quer a pizza?</label>
      <div class="flavor-mode-options" id="flavor-mode-options">
        <button type="button" class="flavor-mode-btn${flavorMode === "one" ? " selected" : ""}" data-mode="one">
          1 sabor
        </button>
        <button type="button" class="flavor-mode-btn${flavorMode === "half" ? " selected" : ""}" data-mode="half">
          Meia a meia (2 sabores)
        </button>
      </div>
      <div id="half-flavor-panel" style="display:${flavorMode === "half" ? "block" : "none"};">
        <p class="flavor-hint">Escolha o sabor de cada metade:</p>
        <div class="half-flavor-row">
          <div class="half-flavor-field">
            <label>1ª metade</label>
            <select id="half-flavor-1" class="half-flavor-select">
              ${optionsHTML(halfFlavor1Id)}
            </select>
          </div>
          <div class="half-flavor-field">
            <label>2ª metade</label>
            <select id="half-flavor-2" class="half-flavor-select">
              ${optionsHTML(halfFlavor2Id)}
            </select>
          </div>
        </div>
      </div>
    </div>
  `;
  }

  let bordaHTML = "";
  if (currentItem.category === "pizza" && storeBordas.length) {
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

  const soldOut = item.available === false;

  container.innerHTML = `
    <div class="product-image">
      ${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : `<span>foto</span>`}
      ${soldOut ? `<span class="sold-out-badge">Esgotado</span>` : ""}
    </div>
    <h1 class="product-title">${escapeHTML(item.name)}</h1>
    ${item.description ? `<p class="product-description">${escapeHTML(item.description)}</p>` : ""}
    ${soldOut ? `<p class="sold-out-notice">Esse produto está esgotado no momento. Volte mais tarde para pedir.</p>` : ""}
    ${sizesHTML}
    ${flavorsHTML}
    ${bordaHTML}
    <div class="product-price" id="product-price"></div>

    <div class="qty-control">
      <button type="button" id="qty-minus" aria-label="Diminuir quantidade" ${soldOut ? "disabled" : ""}>−</button>
      <span class="qty-value" id="qty-value">${currentQty}</span>
      <button type="button" id="qty-plus" aria-label="Aumentar quantidade" ${soldOut ? "disabled" : ""}>+</button>
    </div>

    <div class="product-actions">
      <button type="button" class="add-to-cart-btn" id="add-to-cart-btn" ${soldOut ? "disabled" : ""}>${soldOut ? "Produto esgotado" : "Adicionar ao carrinho"}</button>
      <button type="button" class="buy-now-btn" id="buy-now-btn" ${soldOut ? "disabled" : ""}>📲 Pagar agora</button>
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

  if (currentSizes.length) {
    container.querySelectorAll(".size-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedSizeId = Number(btn.dataset.sizeId);
        // Si el tamaño no permite 2 sabores, forzar modo 1 sabor
        if (maxTotalFlavors(currentSize()) < 2) {
          flavorMode = "one";
          selectedFlavorIds = [];
        }
        renderProduct(currentItem);
      });
    });
  }

  // Modo 1 sabor / meia a meia
  container.querySelectorAll(".flavor-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      flavorMode = btn.dataset.mode;
      if (flavorMode === "one") {
        selectedFlavorIds = [];
      } else {
        syncHalfFromSelects();
      }
      renderProduct(currentItem);
    });
  });

  const half1 = document.getElementById("half-flavor-1");
  const half2 = document.getElementById("half-flavor-2");
  if (half1) half1.addEventListener("change", onHalfFlavorChange);
  if (half2) half2.addEventListener("change", onHalfFlavorChange);

  container.querySelectorAll('input[name="borda"]').forEach((input) => {
    input.addEventListener("change", () => {
      selectedBordaId = input.value ? input.value : null;
      updatePriceDisplay();
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

  updatePriceDisplay();
}

function syncHalfFromSelects() {
  const half1 = document.getElementById("half-flavor-1");
  const half2 = document.getElementById("half-flavor-2");
  if (half1) halfFlavor1Id = Number(half1.value);
  if (half2) halfFlavor2Id = Number(half2.value);
  // selectedFlavorIds = sabores extra (los que no son el "principal" de la página)
  selectedFlavorIds = [halfFlavor1Id, halfFlavor2Id]
    .filter((id) => id != null && Number(id) !== Number(currentItem.id));
  // Si ambas mitades son el mismo sabor que no es el actual, aún así contamos
  if (halfFlavor1Id === halfFlavor2Id && Number(halfFlavor1Id) !== Number(currentItem.id)) {
    selectedFlavorIds = [halfFlavor1Id];
  }
}

function onHalfFlavorChange() {
  syncHalfFromSelects();
  updatePriceDisplay();
}

function currentBorda() {
  if (selectedBordaId == null) return null;
  return storeBordas.find((b) => String(b.id) === String(selectedBordaId)) || null;
}

function currentUnitPrice() {
  let price = 0;
  if (currentSizes.length) {
    const size = currentSize();
    price = size ? Number(size.price || 0) : 0;
  } else {
    price = Number(currentItem.price || 0);
  }
  if (flavorMode === "half") {
    // Cobrar extra de cada mitad que no sea el sabor "base" de la página
    [halfFlavor1Id, halfFlavor2Id].forEach((id) => {
      if (id == null || Number(id) === Number(currentItem.id)) return;
      const flavor = currentAllItems.find((i) => Number(i.id) === Number(id));
      if (flavor) price += Number(flavor.promo_extra || 0);
    });
  } else {
    selectedFlavorIds.forEach((id) => {
      const flavor = currentAllItems.find((i) => i.id === id);
      if (flavor) price += Number(flavor.promo_extra || 0);
    });
  }
  const borda = currentBorda();
  if (borda) price += Number(borda.price || 0);
  return price;
}

function selectedFlavorItems() {
  if (flavorMode === "half") {
    const ids = [halfFlavor1Id, halfFlavor2Id].filter((id) => id != null);
    const unique = [...new Set(ids.map(Number))];
    return unique
      .map((id) => currentAllItems.find((i) => Number(i.id) === id))
      .filter(Boolean);
  }
  return selectedFlavorIds
    .map((id) => currentAllItems.find((i) => i.id === id))
    .filter(Boolean);
}

function fullProductName() {
  const size = currentSize();
  const sizePart = size ? ` (${size.name} ${size.cm}cm)` : "";
  const borda = currentBorda();
  const bordaPart = borda ? ` + Borda de ${borda.name}` : "";
  if (flavorMode === "half" && halfFlavor1Id != null && halfFlavor2Id != null) {
    const f1 = currentAllItems.find((i) => Number(i.id) === Number(halfFlavor1Id));
    const f2 = currentAllItems.find((i) => Number(i.id) === Number(halfFlavor2Id));
    const n1 = f1 ? f1.name : currentItem.name;
    const n2 = f2 ? f2.name : currentItem.name;
    if (n1 === n2) return `${n1}${sizePart}${bordaPart}`;
    return `Meia ${n1} / Meia ${n2}${sizePart}${bordaPart}`;
  }
  return `${currentItem.name}${sizePart}${bordaPart}`;
}

function updateQty(delta) {
  currentQty = Math.max(1, currentQty + delta);
  document.getElementById("qty-value").textContent = currentQty;
  updatePriceDisplay();
}

function updatePriceDisplay() {
  const priceEl = document.getElementById("product-price");
  if (priceEl && currentItem) {
    priceEl.textContent = cartFormatPrice(currentUnitPrice() * currentQty);
  }
  updateBuyNowTroco();
}

function buildCartEntry() {
  const size = currentSize();
  const name = fullProductName();
  let key = size ? `item-${currentItem.id}-tam-${size.id}` : `item-${currentItem.id}`;
  if (flavorMode === "half") {
    const ids = [halfFlavor1Id, halfFlavor2Id].map(Number).sort((a, b) => a - b);
    key += `-meia-${ids.join("-")}`;
  } else if (selectedFlavorIds.length) {
    key += `-sab-${[...selectedFlavorIds].sort((a, b) => a - b).join("-")}`;
  }
  if (selectedBordaId != null) {
    key += `-borda-${selectedBordaId}`;
  }

  return {
    key,
    type: "item",
    id: currentItem.id,
    name,
    qty: currentQty,
    unit_price: currentUnitPrice(),
  };
}

function addToCart() {
  if (currentItem?.available === false) return;
  cartAdd(buildCartEntry());

  const btn = document.getElementById("add-to-cart-btn");
  const original = btn.textContent;
  btn.textContent = "Adicionado ✓";
  setTimeout(() => { btn.textContent = original; }, 1200);
}

/* Botão "Pagar agora": adiciona este produto (com o tamanho/sabor/borda
 * escolhidos) ao carrinho e leva o cliente direto pra página do carrinho,
 * já com tudo lá dentro, pra finalizar o pedido por lá. */
function goToCartToPay() {
  if (currentItem?.available === false) return;
  cartAdd(buildCartEntry());
  window.location.href = "/carrinho";
}

function buyNowConfirm(event) {
  event.preventDefault();
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

  const unitPrice = currentUnitPrice();
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

  const cartLine = [{ name: fullProductName(), qty: currentQty, unit_price: unitPrice }];
  const checkout = {
    name: customerName, delivery, address, payment,
    notes: "", trocoPaidWith, trocoAmount,
    deliveryFeeText: buyNowFee ? buyNowFee.feeText() : null,
  };

  cartRegisterOrder(cartLine, checkout);
  const message = cartOrderMessage(cartLine, total, checkout);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");

  const confirmBtn = document.getElementById("buy-now-confirm");
  const original = confirmBtn.textContent;
  confirmBtn.textContent = "Pedido enviado ✓";
  setTimeout(() => { confirmBtn.textContent = original; }, 1500);
}

loadProduct();
