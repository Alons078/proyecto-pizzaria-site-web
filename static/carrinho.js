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
    <div class="cart-total-row cart-fee-row" id="cart-fee-row" style="display:none;">
      <span>Taxa de entrega</span>
      <strong id="cart-fee-value"></strong>
    </div>
    <div class="cart-total-row">
      <span>Total</span>
      <strong id="cart-total-value">${cartFormatPrice(total)}</strong>
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
    <div class="checkout-field" id="fee-field"></div>
    <div class="checkout-field">
      <label>Forma de pagamento</label>
      <select id="checkout-payment">
        <option value="Dinheiro">Dinheiro</option>
        <option value="Cartão na entrega">Cartão na entrega</option>
        <option value="Pix">Pix</option>
      </select>
    </div>
    <div class="checkout-field" id="troco-field">
      <label>Troco para quanto? (opcional)</label>
      <input type="number" id="checkout-troco" placeholder="Ex.: 100" min="0" step="0.01" inputmode="decimal">
      <p class="troco-result" id="troco-result"></p>
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

  const paymentSelect = document.getElementById("checkout-payment");
  const trocoField = document.getElementById("troco-field");
  const trocoInput = document.getElementById("checkout-troco");
  const trocoResult = document.getElementById("troco-result");

  // Taxa de entrega por distância: o total e o troco passam a considerá-la.
  const feeCtl = cartAttachDeliveryFee({
    deliverySelect,
    addressInput: document.getElementById("checkout-address"),
    mount: document.getElementById("fee-field"),
    onChange: () => updateTotals(),
  });
  const grandTotal = () => total + feeCtl.feeAmount();

  function updateTotals() {
    const feeRow = document.getElementById("cart-fee-row");
    const feeText = feeCtl.feeText();
    feeRow.style.display = feeText ? "flex" : "none";
    document.getElementById("cart-fee-value").textContent = feeText || "";
    document.getElementById("cart-total-value").textContent = cartFormatPrice(grandTotal());
    updateTrocoResult();
  }

  const toggleTrocoField = () => {
    const isDinheiro = paymentSelect.value === "Dinheiro";
    trocoField.style.display = isDinheiro ? "block" : "none";
    if (!isDinheiro) {
      trocoInput.value = "";
      trocoResult.textContent = "";
      trocoResult.classList.remove("troco-warning");
    }
  };

  const updateTrocoResult = () => {
    const raw = trocoInput.value.trim();
    if (!raw) {
      trocoResult.textContent = "";
      trocoResult.classList.remove("troco-warning");
      return;
    }
    const paidWith = Number(raw.replace(",", "."));
    if (Number.isNaN(paidWith)) {
      trocoResult.textContent = "";
      trocoResult.classList.remove("troco-warning");
      return;
    }
    if (paidWith < grandTotal()) {
      trocoResult.textContent = `Valor menor que o total do pedido (${cartFormatPrice(grandTotal())}).`;
      trocoResult.classList.add("troco-warning");
      return;
    }
    trocoResult.textContent = `Troco: ${cartFormatPrice(paidWith - grandTotal())}`;
    trocoResult.classList.remove("troco-warning");
  };

  paymentSelect.addEventListener("change", toggleTrocoField);
  trocoInput.addEventListener("input", updateTrocoResult);
  toggleTrocoField();

  document.getElementById("checkout-btn").addEventListener("click", (event) => {
    event.preventDefault();
    sendToWhatsApp(cart, total, feeCtl);
  });
}

function sendToWhatsApp(cart, subtotal, feeCtl) {
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
  const trocoRaw = document.getElementById("checkout-troco").value.trim();

  if (!name) {
    warningEl.textContent = "Digite seu nome para confirmar o pedido.";
    return;
  }
  if (delivery === "Entrega (delivery)" && !address) {
    warningEl.textContent = "Digite o endereço de entrega.";
    return;
  }
  if (feeCtl.isBusy()) {
    warningEl.textContent = "Aguarde, ainda estamos calculando a taxa de entrega.";
    return;
  }
  if (!feeCtl.isResolved()) {
    warningEl.textContent = "Toque em “Calcular taxa de entrega” antes de confirmar o pedido.";
    return;
  }

  const total = subtotal + feeCtl.feeAmount();   // total COM a taxa de entrega

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

  const checkout = {
    name, delivery, address, payment, notes, trocoPaidWith, trocoAmount,
    deliveryFeeText: feeCtl.feeText(),
  };

  /* Manda o pedido para o servidor (para o agente de impressão térmica
   * pegar), mas sem travar o cliente: mesmo que isso falhe (sem
   * internet no momento, servidor fora do ar), o pedido continua indo
   * pelo WhatsApp normalmente — só não vai sair impresso sozinho. */
  cartRegisterOrder(cart, checkout);

  const message = cartOrderMessage(cart, total, checkout);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
  cartClear();
  renderCart();
}

loadStoreInfo().then(renderCart);
