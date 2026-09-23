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
/* mode: "one" = solo el sabor de la pizza; "split" = dividida em 2 ou 3 sabores */
let flavorMode = "one";
let splitCount = 2; // 2 (metade/metade) ou 3 (dividida em 3), según el tamaño
let splitFlavorIds = []; // ids de cada parte, largo === splitCount cuando flavorMode === "split"
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
 * no total (meio a meio); Grande e Família aceitam até 3 (mínimo 2 quando
 * dividida). Se o nome do tamanho não bater com nenhum desses, usa o
 * diâmetro (cm) como critério de reserva, pra continuar funcionando mesmo
 * se o admin renomear os tamanhos. */
function maxTotalFlavors(size) {
  if (!size) return 1;
  const name = String(size.name || "").toLowerCase();
  if (name.includes("broto") || name.includes("média") || name.includes("media")) return 2;
  if (name.includes("grande") || name.includes("família") || name.includes("familia")) return 3;
  return Number(size.cm) > 32 ? 3 : 2;
}

function currentSize() {
  return currentSizes.find((s) => s.id === selectedSizeId) || null;
}

/* Preço de uma pizza num tamanho. O "Preço" que o admin coloca em cada pizza
 * vale para o tamanho base (o primeiro da tabela "Tamanhos das pizzas"); os
 * outros tamanhos somam a mesma diferença que a tabela tem em relação ao
 * base. Pizza sem preço próprio (0) usa direto o preço da tabela. */
function pizzaPriceForSize(pizza, size) {
  if (!size) return Number(pizza?.price || 0);
  const own = Number(pizza?.price || 0);
  if (!own) return Number(size.price || 0);
  const baseSize = currentSizes[0];
  return own + Number(size.price || 0) - Number(baseSize?.price || 0);
}

/* Garante que splitFlavorIds tenha exatamente `splitCount` ids válidos,
 * mantendo o que já estava escolhido e completando o resto com sabores
 * diferentes (a 1ª parte começa sempre com o sabor da própria página). */
function ensureSplitFlavorIds(allFlavors) {
  const validIds = allFlavors.map((f) => Number(f.id));
  const next = [];
  for (let i = 0; i < splitCount; i++) {
    let id = splitFlavorIds[i] != null ? Number(splitFlavorIds[i]) : null;
    if (id == null || !validIds.includes(id)) {
      if (i === 0) {
        id = Number(currentItem.id);
      } else {
        const other = allFlavors.find((f) => !next.includes(Number(f.id)));
        id = other ? Number(other.id) : validIds[0];
      }
    }
    next.push(id);
  }
  splitFlavorIds = next;
}

function pizzaFlavorOptions() {
  if (!currentItem || currentItem.category !== "pizza") return [];
  // Todas as pizzas disponíveis (incluído o sabor atual, mesmo que ele
  // esteja esgotado) para poder escolher na meia a meia. Sabores esgotados
  // de outras pizzas não entram na lista, pra não vender o que não tem.
  return currentAllItems.filter((i) => i.category === "pizza" && (i.available !== false || i.id === currentItem.id));
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
            <span class="size-price">${cartFormatPrice(pizzaPriceForSize(currentItem, size))}</span>
          </button>
        `).join("")}
      </div>
    </div>
  ` : "";

  const allFlavors = pizzaFlavorOptions();
  const sizeMaxParts = currentSizes.length ? maxTotalFlavors(currentSize()) : 1;
  const maxParts = Math.min(sizeMaxParts, allFlavors.length);
  const canSplit = allFlavors.length >= 2 && currentSizes.length && maxParts >= 2;

  if (!canSplit) flavorMode = "one";
  if (splitCount > maxParts) splitCount = Math.max(2, maxParts);
  if (splitCount < 2) splitCount = 2;

  let flavorsHTML = "";
  if (canSplit) {
    ensureSplitFlavorIds(allFlavors);

    const optionsHTML = (selectedId) => allFlavors.map((f) => {
      const extra = "";   // o adicional (promo_extra) só vale dentro de promoções
      const selected = Number(selectedId) === Number(f.id) ? " selected" : "";
      return `<option value="${f.id}"${selected}>${escapeHTML(f.name)}${extra}</option>`;
    }).join("");

    const partLabels = splitCount === 3 ? ["1º terço", "2º terço", "3º terço"] : ["1ª metade", "2ª metade"];

    const countSelectorHTML = maxParts >= 3 ? `
      <p class="flavor-hint">Quantos sabores?</p>
      <div class="flavor-mode-options split-count-options" id="split-count-options">
        <button type="button" class="flavor-mode-btn${splitCount === 2 ? " selected" : ""}" data-count="2">2 sabores</button>
        <button type="button" class="flavor-mode-btn${splitCount === 3 ? " selected" : ""}" data-count="3">3 sabores</button>
      </div>
    ` : "";

    const fieldsHTML = splitFlavorIds.map((id, i) => `
      <div class="half-flavor-field">
        <label>${partLabels[i]}</label>
        <select class="half-flavor-select split-flavor-select" data-part-index="${i}">
          ${optionsHTML(id)}
        </select>
      </div>
    `).join("");

    flavorsHTML = `
    <div class="flavor-block flavor-block-compact">
      <label>Como quer a pizza?</label>
      <div class="flavor-mode-options" id="flavor-mode-options">
        <button type="button" class="flavor-mode-btn${flavorMode === "one" ? " selected" : ""}" data-mode="one">
          1 sabor
        </button>
        <button type="button" class="flavor-mode-btn${flavorMode === "split" ? " selected" : ""}" data-mode="split">
          Dividir sabores${maxParts >= 3 ? " (2 ou 3)" : " (2 sabores)"}
        </button>
      </div>
      <div id="split-flavor-panel" style="display:${flavorMode === "split" ? "block" : "none"};">
        ${countSelectorHTML}
        <p class="flavor-hint">Escolha o sabor de cada ${splitCount === 3 ? "parte" : "metade"}:</p>
        <div class="half-flavor-row split-row-${splitCount}">
          ${fieldsHTML}
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
        // Si el tamaño no permite dividir en sabores, forzar modo 1 sabor
        if (maxTotalFlavors(currentSize()) < 2) {
          flavorMode = "one";
        }
        renderProduct(currentItem);
      });
    });
  }

  // Modo 1 sabor / dividir sabores
  container.querySelectorAll("#flavor-mode-options .flavor-mode-btn[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      flavorMode = btn.dataset.mode;
      renderProduct(currentItem);
    });
  });

  // Cuántos sabores (2 o 3) cuando el tamaño lo permite
  container.querySelectorAll("#split-count-options .flavor-mode-btn[data-count]").forEach((btn) => {
    btn.addEventListener("click", () => {
      splitCount = Number(btn.dataset.count);
      renderProduct(currentItem);
    });
  });

  container.querySelectorAll(".split-flavor-select").forEach((select) => {
    select.addEventListener("change", onSplitFlavorChange);
  });

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

function onSplitFlavorChange(event) {
  const idx = Number(event.target.dataset.partIndex);
  splitFlavorIds[idx] = Number(event.target.value);
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
    if (flavorMode === "split") {
      // Pizza dividida: cobra pelo sabor mais caro entre as partes.
      // (O "adicional" de cada pizza só vale dentro de promoções.)
      const prices = splitFlavorIds.map((id) => {
        const flavor = currentAllItems.find((i) => Number(i.id) === Number(id)) || currentItem;
        return pizzaPriceForSize(flavor, size);
      });
      price = prices.length ? Math.max(...prices) : pizzaPriceForSize(currentItem, size);
    } else {
      price = pizzaPriceForSize(currentItem, size);
    }
  } else {
    price = Number(currentItem.price || 0);
  }
  const borda = currentBorda();
  if (borda) price += Number(borda.price || 0);
  return price;
}

function fullProductName() {
  const size = currentSize();
  const sizePart = size ? ` (${size.name} ${size.cm}cm)` : "";
  const borda = currentBorda();
  const bordaPart = borda ? ` + Borda de ${borda.name}` : "";
  if (flavorMode === "split" && splitFlavorIds.length) {
    const names = splitFlavorIds.map((id) => {
      const f = currentAllItems.find((i) => Number(i.id) === Number(id));
      return f ? f.name : currentItem.name;
    });
    const uniqueNames = [...new Set(names)];
    if (uniqueNames.length === 1) return `${uniqueNames[0]}${sizePart}${bordaPart}`;
    if (names.length === 2) return `Meia ${names[0]} / Meia ${names[1]}${sizePart}${bordaPart}`;
    return `${names.map((n) => `1/3 ${n}`).join(" + ")}${sizePart}${bordaPart}`;
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
  if (flavorMode === "split" && splitFlavorIds.length) {
    const ids = [...splitFlavorIds].map(Number).sort((a, b) => a - b);
    key += `-div-${ids.join("-")}`;
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
    // Quantas pizzas tem em uma unidade deste produto (1 se for pizza,
    // 0 se for salgado/bebida). Só usado pro resumo de vendas do admin.
    pizza_count: currentItem.category === "pizza" ? 1 : 0,
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

  const orderPromise = cartRegisterOrder(cartLine, checkout);
  const message = cartOrderMessage(cartLine, total, checkout);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");

  const confirmBtn = document.getElementById("buy-now-confirm");
  const original = confirmBtn.textContent;
  confirmBtn.textContent = "Pedido enviado ✓";
  setTimeout(() => { confirmBtn.textContent = original; }, 1500);
  cartGoToTracking(orderPromise);
}

loadProduct();

/* Se o admin mudar preço, sabor, esgotado, promoção ou horário enquanto o
 * cliente está aqui: recarrega sozinha (se ele ainda não mexeu em nada) ou
 * mostra a faixa "Atualizar agora" (se já estava preenchendo o pedido). */
LiveRefresh.watchPage({
  pick: (d) => ({ store: d.store, items: d.items, promotions: d.promotions, pizza_sizes: d.pizza_sizes }),
});
