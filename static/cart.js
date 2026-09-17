/*
 * Carrinho do cliente, guardado no localStorage do navegador.
 * Assim, ao navegar entre a página principal e a página de um produto,
 * o carrinho continua com o que já foi escolhido antes.
 *
 * Cada item do carrinho é um objeto:
 *   { key, type: "item"|"promotion", id, name, qty, unit_price, note }
 * "key" identifica a linha do carrinho (id + type), pra poder somar
 * quantidades quando o mesmo produto é adicionado de novo.
 */

const CART_STORAGE_KEY = "rey_pizzaria_cart_v1";

function cartLoad() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

function cartSave(cart) {
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  cartUpdateBadge();
}

function cartAdd(entry) {
  const cart = cartLoad();
  const existing = cart.find((line) => line.key === entry.key);
  if (existing) {
    existing.qty += entry.qty;
  } else {
    cart.push(entry);
  }
  cartSave(cart);
  return cart;
}

function cartSetQty(key, qty) {
  let cart = cartLoad();
  if (qty <= 0) {
    cart = cart.filter((line) => line.key !== key);
  } else {
    const line = cart.find((l) => l.key === key);
    if (line) line.qty = qty;
  }
  cartSave(cart);
  return cart;
}

function cartRemove(key) {
  const cart = cartLoad().filter((line) => line.key !== key);
  cartSave(cart);
  return cart;
}

function cartClear() {
  cartSave([]);
}

function cartTotal(cart) {
  return cart.reduce((sum, line) => sum + line.unit_price * line.qty, 0);
}

function cartCount(cart) {
  return cart.reduce((sum, line) => sum + line.qty, 0);
}

function cartFormatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

/* Bolinha com a quantidade de itens no carrinho, mostrada perto da marca. */
function cartUpdateBadge() {
  const badge = document.getElementById("cart-badge");
  if (!badge) return;
  const count = cartCount(cartLoad());
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

document.addEventListener("DOMContentLoaded", cartUpdateBadge);
