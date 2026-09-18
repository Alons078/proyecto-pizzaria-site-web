/* Página de detalhe de um produto: escolher quantidade e adicionar ao carrinho. */

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

async function loadProduct() {
  const container = document.getElementById("product-content");
  try {
    const res = await fetch(`/api/item/${ITEM_ID}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      container.innerHTML = `<p class="product-warning">Produto não encontrado.</p>`;
      return;
    }
    currentItem = data.item;
    currentSizes = Array.isArray(data.pizza_sizes) ? data.pizza_sizes : [];
    if (currentSizes.length) selectedSizeId = currentSizes[0].id;
    renderProduct(currentItem);
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="product-warning">Não foi possível carregar o produto.</p>`;
  }
}

function currentUnitPrice() {
  if (currentSizes.length) {
    const size = currentSizes.find((s) => s.id === selectedSizeId);
    return size ? Number(size.price || 0) : 0;
  }
  return Number(currentItem.price || 0);
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

  container.innerHTML = `
    <div class="product-image">
      ${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : `<span>foto</span>`}
    </div>
    <h1 class="product-title">${escapeHTML(item.name)}</h1>
    ${item.description ? `<p class="product-description">${escapeHTML(item.description)}</p>` : ""}
    ${sizesHTML}
    <div class="product-price" id="product-price"></div>

    <div class="qty-control">
      <button type="button" id="qty-minus" aria-label="Diminuir quantidade">−</button>
      <span class="qty-value" id="qty-value">1</span>
      <button type="button" id="qty-plus" aria-label="Aumentar quantidade">+</button>
    </div>

    <button type="button" class="add-to-cart-btn" id="add-to-cart-btn">Adicionar ao carrinho</button>
  `;

  if (currentSizes.length) {
    container.querySelectorAll(".size-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedSizeId = Number(btn.dataset.sizeId);
        container.querySelectorAll(".size-option").forEach((b) => b.classList.toggle("selected", Number(b.dataset.sizeId) === selectedSizeId));
        updatePriceDisplay();
      });
    });
  }

  document.getElementById("qty-minus").addEventListener("click", () => updateQty(-1));
  document.getElementById("qty-plus").addEventListener("click", () => updateQty(1));
  document.getElementById("add-to-cart-btn").addEventListener("click", addToCart);
  updatePriceDisplay();
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
  const size = currentSizes.length ? currentSizes.find((s) => s.id === selectedSizeId) : null;
  const name = size ? `${currentItem.name} (${size.name} ${size.cm}cm)` : currentItem.name;
  const key = size ? `item-${currentItem.id}-tam-${size.id}` : `item-${currentItem.id}`;

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

loadProduct();
