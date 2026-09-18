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
let storeInfo = { whatsapp_number: "" };

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

  const flavorOptions = pizzaFlavorOptions();
  const flavorsHTML = (flavorOptions.length && currentSizes.length) ? `
    <div class="flavor-block">
      <label>Sabores adicionais (opcional)</label>
      <p class="flavor-hint" id="flavor-hint"></p>
      <div class="flavor-options" id="flavor-options">
        ${flavorOptions.map((flavor) => `
          <label class="flavor-option" data-flavor-id="${flavor.id}">
            <input type="checkbox" class="flavor-checkbox" value="${flavor.id}" ${selectedFlavorIds.includes(flavor.id) ? "checked" : ""}>
            <span class="flavor-name">${escapeHTML(flavor.name)}</span>
            ${Number(flavor.promo_extra || 0) > 0 ? `<span class="flavor-extra">+${cartFormatPrice(flavor.promo_extra)}</span>` : ""}
          </label>
        `).join("")}
      </div>
    </div>
  ` : "";

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
        const newMax = maxTotalFlavors(currentSize());
        if (selectedFlavorIds.length > newMax - 1) {
          selectedFlavorIds = selectedFlavorIds.slice(0, Math.max(0, newMax - 1));
        }
        renderProduct(currentItem);
      });
    });
  }

  if (flavorOptions.length) {
    container.querySelectorAll(".flavor-checkbox").forEach((cb) => {
      cb.addEventListener("change", onFlavorChange);
    });
    onFlavorChange();
  }

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

  document.getElementById("buy-now-confirm").addEventListener("click", buyNowConfirm);

  updatePriceDisplay();
}

/* Ajusta as caixinhas de sabor extra: quando o limite do tamanho já foi
 * atingido, desabilita as opções que ainda não foram marcadas, pra não
 * deixar escolher mais sabores do que o tamanho permite. */
function onFlavorChange() {
  const checkboxes = [...document.querySelectorAll(".flavor-checkbox")];
  selectedFlavorIds = checkboxes.filter((cb) => cb.checked).map((cb) => Number(cb.value));

  const max = maxTotalFlavors(currentSize());
  const extraAllowed = Math.max(0, max - 1);
  const limitReached = selectedFlavorIds.length >= extraAllowed;

  checkboxes.forEach((cb) => {
    const optionEl = cb.closest(".flavor-option");
    const shouldDisable = !cb.checked && limitReached;
    cb.disabled = shouldDisable;
    if (optionEl) optionEl.classList.toggle("disabled", shouldDisable);
  });

  const hintEl = document.getElementById("flavor-hint");
  if (hintEl) {
    hintEl.textContent = extraAllowed > 0
      ? `Escolha até ${extraAllowed} sabor${extraAllowed > 1 ? "es" : ""} a mais para este tamanho (${selectedFlavorIds.length}/${extraAllowed} escolhidos).`
      : "Este tamanho não aceita sabores adicionais.";
  }

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
  selectedFlavorIds.forEach((id) => {
    const flavor = currentAllItems.find((i) => i.id === id);
    if (flavor) price += Number(flavor.promo_extra || 0);
  });
  return price;
}

function selectedFlavorItems() {
  return selectedFlavorIds
    .map((id) => currentAllItems.find((i) => i.id === id))
    .filter(Boolean);
}

function fullProductName() {
  const size = currentSize();
  const baseName = size ? `${currentItem.name} (${size.name} ${size.cm}cm)` : currentItem.name;
  const flavors = selectedFlavorItems();
  return flavors.length ? `${baseName} + ${flavors.map((f) => f.name).join(", ")}` : baseName;
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
  const flavors = selectedFlavorItems();
  const name = fullProductName();
  const key = (size ? `item-${currentItem.id}-tam-${size.id}` : `item-${currentItem.id}`) +
    (flavors.length ? `-sab-${[...selectedFlavorIds].sort((a, b) => a - b).join("-")}` : "");

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
  warningEl.textContent = "";

  const unitPrice = currentUnitPrice();
  const total = unitPrice * currentQty;
  const cartLine = [{ name: fullProductName(), qty: currentQty, unit_price: unitPrice }];
  const checkout = {
    name: customerName, delivery, address, payment,
    notes: "", trocoPaidWith: null, trocoAmount: null,
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
