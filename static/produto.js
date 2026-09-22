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
  // Todas las pizzas (incluido el sabor actual) para poder elegir en meia a meia
  return currentAllItems.filter((i) => i.category === "pizza");
}

function otherPizzaFlavors() {
  if (!currentItem || currentItem.category !== "pizza") return [];
  return currentAllItems.filter((i) => i.category === "pizza" && i.id !== currentItem.id);
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

  container.innerHTML = `
    <div class="product-image">
      ${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : `<span>foto</span>`}
    </div>
    <h1 class="product-title">${escapeHTML(item.name)}</h1>
    ${item.description ? `<p class="product-description">${escapeHTML(item.description)}</p>` : ""}
    ${sizesHTML}
    ${flavorsHTML}
    <div class="product-price" id="product-price"></div>

    <div class="qty-control">
      <button type="button" id="qty-minus" aria-label="Diminuir quantidade">−</button>
      <span class="qty-value" id="qty-value">${currentQty}</span>
      <button type="button" id="qty-plus" aria-label="Aumentar quantidade">+</button>
    </div>

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
  if (flavorMode === "half" && halfFlavor1Id != null && halfFlavor2Id != null) {
    const f1 = currentAllItems.find((i) => Number(i.id) === Number(halfFlavor1Id));
    const f2 = currentAllItems.find((i) => Number(i.id) === Number(halfFlavor2Id));
    const n1 = f1 ? f1.name : currentItem.name;
    const n2 = f2 ? f2.name : currentItem.name;
    if (n1 === n2) return `${n1}${sizePart}`;
    return `Meia ${n1} / Meia ${n2}${sizePart}`;
  }
  return `${currentItem.name}${sizePart}`;
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
}

function addToCart() {
  const size = currentSize();
  const name = fullProductName();
  let key = size ? `item-${currentItem.id}-tam-${size.id}` : `item-${currentItem.id}`;
  if (flavorMode === "half") {
    const ids = [halfFlavor1Id, halfFlavor2Id].map(Number).sort((a, b) => a - b);
    key += `-meia-${ids.join("-")}`;
  } else if (selectedFlavorIds.length) {
    key += `-sab-${[...selectedFlavorIds].sort((a, b) => a - b).join("-")}`;
  }

  cartAdd({
    key,
    type: "item",
    id: currentItem.id,
    name,
    qty: currentQty,
    unit_price: currentUnitPrice(),
  });

  const btn = document.getElementById("add-to-cart-btn");
  const original = btn.textContent;
  btn.textContent = "Adicionado ✓";
  setTimeout(() => { btn.textContent = original; }, 1200);
}

function toggleInlineCheckout() {
  const panel = document.getElementById("inline-checkout");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
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

  const unitPrice = currentUnitPrice();
  const total = unitPrice * currentQty + deliveryFee;   // total COM a taxa de entrega
  const cartLine = [{ name: fullProductName(), qty: currentQty, unit_price: unitPrice }];
  const checkout = {
    name: customerName, delivery, address, payment,
    notes: "", trocoPaidWith: null, trocoAmount: null,
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
