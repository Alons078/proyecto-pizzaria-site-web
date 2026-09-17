/* Página do carrinho: revisar itens, ajustar quantidades e fechar o pedido
 * gerando uma mensagem de WhatsApp para o cliente enviar à pizzaria. */

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let storeInfo = { whatsapp_number: "" };

async function loadStoreInfo() {
  try {
    const res = await fetch("/api/data");
    const data = await res.json();
    storeInfo = data.store || {};
  } catch (error) {
    console.error(error);
  }
}

function renderCart() {
  const cart = cartLoad();
  const linesEl = document.getElementById("cart-lines");
  const footerEl = document.getElementById("cart-footer");

  if (!cart.length) {
    linesEl.innerHTML = `<p class="cart-empty">Seu carrinho está vazio.<br>Volte ao cardápio para escolher algo gostoso.</p>`;
    footerEl.innerHTML = "";
    return;
  }

  linesEl.innerHTML = cart.map((line) => `
    <div class="cart-line" data-key="${escapeHTML(line.key)}">
      <div>
        <div class="cart-line-name">${escapeHTML(line.name)}</div>
        <div class="cart-line-price">${cartFormatPrice(line.unit_price)} cada</div>
      </div>
      <div class="cart-qty-control">
        <button type="button" class="qty-dec" aria-label="Diminuir">−</button>
        <span class="qty-value">${line.qty}</span>
        <button type="button" class="qty-inc" aria-label="Aumentar">+</button>
      </div>
      <button type="button" class="cart-line-remove" aria-label="Remover">×</button>
    </div>
  `).join("");

  linesEl.querySelectorAll(".cart-line").forEach((lineEl) => {
    const key = lineEl.dataset.key;
    const line = cart.find((l) => l.key === key);
    lineEl.querySelector(".qty-inc").addEventListener("click", () => {
      cartSetQty(key, line.qty + 1);
      renderCart();
    });
    lineEl.querySelector(".qty-dec").addEventListener("click", () => {
      cartSetQty(key, line.qty - 1);
      renderCart();
    });
    lineEl.querySelector(".cart-line-remove").addEventListener("click", () => {
      cartRemove(key);
      renderCart();
    });
  });

  const total = cartTotal(cart);

  footerEl.innerHTML = `
    <div class="cart-total-row">
      <span>Total</span>
      <strong>${cartFormatPrice(total)}</strong>
    </div>

    <div class="checkout-field">
      <label>Seu nome</label>
      <input type="text" id="checkout-name" placeholder="Nome para o pedido">
    </div>
    <div class="checkout-field">
      <label>Forma de entrega</label>
      <select id="checkout-delivery">
        <option value="Retirada no local">Retirada no local</option>
        <option value="Entrega (delivery)">Entrega (delivery)</option>
      </select>
    </div>
    <div class="checkout-field" id="address-field">
      <label>Endereço para entrega</label>
      <input type="text" id="checkout-address" placeholder="Rua, número, bairro">
    </div>
    <div class="checkout-field">
      <label>Forma de pagamento</label>
      <select id="checkout-payment">
        <option value="Dinheiro">Dinheiro</option>
        <option value="Cartão na entrega">Cartão na entrega</option>
        <option value="Pix">Pix</option>
      </select>
    </div>
    <div class="checkout-field">
      <label>Observações (opcional)</label>
      <textarea id="checkout-notes" rows="2" placeholder="Ex.: sem cebola, troco para R$ 100..."></textarea>
    </div>

    <a href="#" class="checkout-btn" id="checkout-btn">📲 Confirmar pedido pelo WhatsApp</a>
    <p class="product-warning" id="checkout-warning"></p>
  `;

  const deliverySelect = document.getElementById("checkout-delivery");
  const addressField = document.getElementById("address-field");
  const toggleAddressField = () => {
    addressField.style.display = deliverySelect.value === "Entrega (delivery)" ? "block" : "none";
  };
  deliverySelect.addEventListener("change", toggleAddressField);
  toggleAddressField();

  document.getElementById("checkout-btn").addEventListener("click", (event) => {
    event.preventDefault();
    sendToWhatsApp(cart, total);
  });
}

function sendToWhatsApp(cart, total) {
  const warningEl = document.getElementById("checkout-warning");
  const phone = String(storeInfo.whatsapp_number || "").replace(/\D/g, "");

  if (!phone) {
    warningEl.textContent = "A pizzaria ainda não configurou um número de WhatsApp. Entre em contato diretamente.";
    return;
  }

  const name = document.getElementById("checkout-name").value.trim();
  const delivery = document.getElementById("checkout-delivery").value;
  const address = document.getElementById("checkout-address").value.trim();
  const payment = document.getElementById("checkout-payment").value;
  const notes = document.getElementById("checkout-notes").value.trim();

  if (!name) {
    warningEl.textContent = "Digite seu nome para confirmar o pedido.";
    return;
  }
  if (delivery === "Entrega (delivery)" && !address) {
    warningEl.textContent = "Digite o endereço de entrega.";
    return;
  }
  warningEl.textContent = "";

  const lines = cart.map((line) =>
    `• ${line.qty}x ${line.name} — ${cartFormatPrice(line.unit_price * line.qty)}`
  );

  let message = `Olá! Gostaria de fazer o seguinte pedido:\n\n`;
  message += lines.join("\n");
  message += `\n\n*Total: ${cartFormatPrice(total)}*\n\n`;
  message += `Nome: ${name}\n`;
  message += `Entrega: ${delivery}\n`;
  if (delivery === "Entrega (delivery)") message += `Endereço: ${address}\n`;
  message += `Pagamento: ${payment}\n`;
  if (notes) message += `Observações: ${notes}\n`;

  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
  cartClear();
  renderCart();
}

loadStoreInfo().then(renderCart);
