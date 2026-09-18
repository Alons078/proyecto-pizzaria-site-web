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

/*
 * Monta a mensagem de WhatsApp de um pedido, dado o conteúdo do carrinho
 * (lista de linhas { name, qty, unit_price }), o total já calculado, e os
 * dados do checkout ({ name, delivery, address, payment, notes,
 * trocoPaidWith, trocoAmount }). Usada tanto pela página do carrinho quanto
 * pelo botão "Pagar agora" na página do produto, pra não duplicar o texto
 * do pedido em dois lugares.
 */
function cartOrderMessage(cart, total, checkout) {
  const lines = cart.map((line) =>
    `• ${line.qty}x ${line.name} — ${cartFormatPrice(line.unit_price * line.qty)}`
  );

  let message = `Olá! Gostaria de fazer o seguinte pedido:\n\n`;
  message += lines.join("\n");
  message += `\n\n*Total: ${cartFormatPrice(total)}*\n\n`;
  message += `Nome: ${checkout.name}\n`;
  message += `Entrega: ${checkout.delivery}\n`;
  if (checkout.delivery === "Entrega (delivery)" && checkout.address) {
    message += `Endereço: ${checkout.address}\n`;
  }
  message += `Pagamento: ${checkout.payment}\n`;
  if (checkout.trocoPaidWith !== null && checkout.trocoPaidWith !== undefined) {
    message += `Troco para: ${cartFormatPrice(checkout.trocoPaidWith)} (troco de ${cartFormatPrice(checkout.trocoAmount)})\n`;
  }
  if (checkout.notes) message += `Observações: ${checkout.notes}\n`;
  return message;
}

/* Manda o pedido para o servidor (para o agente de impressão térmica
 * pegar), mas sem travar o cliente: mesmo que isso falhe (sem internet no
 * momento, servidor fora do ar), o pedido continua indo pelo WhatsApp
 * normalmente — só não vai sair impresso sozinho. */
function cartRegisterOrder(cart, checkout) {
  const payload = {
    items: cart.map((line) => ({ name: line.name, qty: line.qty, unit_price: line.unit_price })),
    customer_name: checkout.name,
    delivery_type: checkout.delivery,
    address: checkout.address,
    payment_method: checkout.payment,
    notes: checkout.notes,
    troco_paid_with: checkout.trocoPaidWith,
  };
  fetch("/api/pedidos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((error) => console.error("Não foi possível registrar o pedido para impressão:", error));
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
