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

    <button type="button" class="add-to-cart-btn" id="add-to-cart-btn">Adicionar ao carrinho</button>
  `;

  const selects = [...container.querySelectorAll(".promo-select")];
  selects.forEach((select) => select.addEventListener("change", updatePromoState));
  document.getElementById("qty-minus").addEventListener("click", () => updateQty(-1));
  document.getElementById("qty-plus").addEventListener("click", () => updateQty(1));
  document.getElementById("add-to-cart-btn").addEventListener("click", addToCart);

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
  const complete = allSlotsChosen();

  priceEl.textContent = cartFormatPrice(currentUnitPrice() * currentQty);
  warningEl.textContent = complete ? "" : "Selecione todas as opções para adicionar ao carrinho.";
  btn.disabled = !complete;
  btn.style.opacity = complete ? "1" : "0.5";
  btn.style.cursor = complete ? "pointer" : "not-allowed";
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

loadPromotion();
