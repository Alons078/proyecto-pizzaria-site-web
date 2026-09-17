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
    renderProduct(currentItem);
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="product-warning">Não foi possível carregar o produto.</p>`;
  }
}

function renderProduct(item) {
  const container = document.getElementById("product-content");
  container.innerHTML = `
    <div class="product-image">
      ${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : `<span>foto</span>`}
    </div>
    <h1 class="product-title">${escapeHTML(item.name)}</h1>
    ${item.description ? `<p class="product-description">${escapeHTML(item.description)}</p>` : ""}
    <div class="product-price" id="product-price">${cartFormatPrice(item.price)}</div>

    <div class="qty-control">
      <button type="button" id="qty-minus" aria-label="Diminuir quantidade">−</button>
      <span class="qty-value" id="qty-value">1</span>
      <button type="button" id="qty-plus" aria-label="Aumentar quantidade">+</button>
    </div>

    <button type="button" class="add-to-cart-btn" id="add-to-cart-btn">Adicionar ao carrinho</button>
  `;

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
    priceEl.textContent = cartFormatPrice(Number(currentItem.price || 0) * currentQty);
  }
}

function addToCart() {
  cartAdd({
    key: `item-${currentItem.id}`,
    type: "item",
    id: currentItem.id,
    name: currentItem.name,
    qty: currentQty,
    unit_price: Number(currentItem.price || 0),
  });

  const btn = document.getElementById("add-to-cart-btn");
  const original = btn.textContent;
  btn.textContent = "Adicionado ✓";
  setTimeout(() => { btn.textContent = original; }, 1200);
}

loadProduct();
