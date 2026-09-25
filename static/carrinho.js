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
      <label>Seu telefone</label>
      <input type="tel" id="checkout-phone" placeholder="Ex.: (21) 99999-9999" inputmode="tel">
      <p class="checkout-hint">É para o entregador poder te ligar caso precise de alguma informação.</p>
    </div>
    <div class="checkout-field">
      <label>Forma de entrega</label>
      <select id="checkout-delivery">
        <option value="Retirada no local">Retirada no local</option>
        <option value="Entrega (delivery)">Entrega (delivery)</option>
      </select>
    </div>
    <div class="checkout-field" id="address-field">
      <label>Bairro de entrega</label>
      <div class="flavor-mode-options">
        <button type="button" class="zone-option flavor-mode-btn" data-zone="Piscinão de Ramos">Piscinão de Ramos</button>
        <button type="button" class="zone-option flavor-mode-btn" data-zone="Ramos">Ramos</button>
      </div>
      <div class="zone-address-wrap" style="display:none;">
        <label>Seu endereço (rua, número)</label>
        <input type="text" class="zone-street-input" placeholder="Rua, número">
      </div>
      <input type="hidden" class="zone-hidden-address" id="checkout-address">
    </div>
    <div class="checkout-field" id="fee-field"></div>
    <div class="checkout-field">
      <label>Forma de pagamento</label>
      <select id="checkout-payment">
        <option value="Dinheiro">Dinheiro</option>
        <option value="Cartão na entrega">Cartão na entrega</option>
        <option value="Pix na maquininha ">Pix na maquina /option>
      </select> 
    </div>
    <div class="checkout-field pix-section" id="pix-section" style="display:none;"></div>
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
  const pixSection = document.getElementById("pix-section");

  cartAttachDeliveryZone(document.getElementById("address-field"));

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
    updatePixSection();
  }

  /* Mostra o QR Code e o código "Pix Copia e Cola" com o valor exato do
   * pedido (já somando a taxa de entrega, se houver), sempre que o
   * cliente escolhe Pix como forma de pagamento. */
  function updatePixSection() {
    if (paymentSelect.value !== "Pix") {
      pixSection.style.display = "none";
      pixSection.innerHTML = "";
      return;
    }

    const pixKey = String(storeInfo.pix_key || "").trim();
    pixSection.style.display = "block";

    if (!pixKey) {
      pixSection.innerHTML = `<p class="pix-missing">A pizzaria ainda não configurou uma chave Pix. Escolha outra forma de pagamento ou combine o Pix direto pelo WhatsApp.</p>`;
      return;
    }

    // Se /static/pix.js ou /static/vendor/qrcode.js não carregaram (por
    // exemplo, um deploy incompleto), cai aqui em vez de travar o resto
    // do carrinho com um erro de JavaScript.
    if (typeof buildPixPayload !== "function" || typeof renderPixQr !== "function") {
      pixSection.innerHTML = `<p class="pix-missing">Não foi possível carregar o Pix agora. Escolha outra forma de pagamento ou combine o Pix direto pelo WhatsApp.</p>`;
      return;
    }

    const amount = grandTotal();
    const payload = buildPixPayload({
      key: pixKey,
      name: storeInfo.pix_name || storeInfo.name,
      city: storeInfo.pix_city,
      amount,
    });

    pixSection.innerHTML = `
      <div class="pix-box">
        <div class="pix-qr" id="pix-qr"></div>
        <p class="pix-amount">${cartFormatPrice(amount)}</p>
        <label>Pix Copia e Cola</label>
        <textarea id="pix-code" readonly rows="3"></textarea>
        <button type="button" class="pix-copy-btn" id="pix-copy-btn">Copiar código Pix</button>
        <p class="pix-hint">Abra o Pix no app do seu banco e cole o código — o valor já vem preenchido, é só confirmar.</p>
      </div>
    `;
    document.getElementById("pix-code").value = payload;
    renderPixQr(document.getElementById("pix-qr"), payload);
    document.getElementById("pix-copy-btn").addEventListener("click", () => copyPixCode(payload));
  }

  function copyPixCode(payload) {
    const finish = (ok) => {
      const btn = document.getElementById("pix-copy-btn");
      if (!btn) return;
      btn.textContent = ok ? "Código copiado ✓" : "Não foi possível copiar, selecione e copie manualmente";
      btn.classList.toggle("copied", ok);
      setTimeout(() => {
        const stillThere = document.getElementById("pix-copy-btn");
        if (stillThere) {
          stillThere.textContent = "Copiar código Pix";
          stillThere.classList.remove("copied");
        }
      }, 1800);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(payload).then(() => finish(true)).catch(() => finish(false));
    } else {
      const codeEl = document.getElementById("pix-code");
      codeEl.select();
      try {
        document.execCommand("copy");
        finish(true);
      } catch (error) {
        finish(false);
      }
    }
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

  paymentSelect.addEventListener("change", () => {
    toggleTrocoField();
    updatePixSection();
  });
  trocoInput.addEventListener("input", updateTrocoResult);
  toggleTrocoField();
  updatePixSection();

  document.getElementById("checkout-btn").addEventListener("click", (event) => {
    event.preventDefault();
    sendToWhatsApp(cart, total, feeCtl);
  });
}

/* Tela de "pedido enviado": aparece por cima da página enquanto o
 * navegador troca para o WhatsApp e depois nos leva ao acompanhamento
 * (esse intervalo já existe em cartGoToTracking, então aproveitamos ele
 * pra mostrar a confirmação em vez de deixar a tela parada). */
function showOrderSuccessOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "order-success-overlay";
  overlay.innerHTML = `
    <svg class="order-success-check" width="88" height="88" viewBox="0 0 90 90" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="45" cy="45" r="38"></circle>
      <path d="M28 46 L40 58 L64 32"></path>
    </svg>
    <p class="order-success-text">Pedido enviado! 🎉<br>Te levando para o acompanhamento…</p>
  `;
  document.body.appendChild(overlay);

  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const colors = ["#ff7a3d", "#ffd166", "#06d6a0", "#ef476f", "#118ab2"];
    for (let i = 0; i < 26; i++) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      piece.style.left = `${Math.random() * 100}vw`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = `${1.1 + Math.random() * 0.9}s`;
      piece.style.animationDelay = `${Math.random() * 0.3}s`;
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 2500);
    }
  }
  return overlay;
}

function sendToWhatsApp(cart, subtotal, feeCtl) {
  const warningEl = document.getElementById("checkout-warning");
  const phone = String(storeInfo.whatsapp_number || "").replace(/\D/g, "");

  if (!phone) {
    warningEl.textContent = "A pizzaria ainda não configurou um número de WhatsApp. Entre em contato diretamente.";
    return;
  }

  const name = document.getElementById("checkout-name").value.trim();
  const customerPhone = document.getElementById("checkout-phone").value.trim();
  const delivery = document.getElementById("checkout-delivery").value;
  const address = document.getElementById("checkout-address").value.trim();
  const payment = document.getElementById("checkout-payment").value;
  const notes = document.getElementById("checkout-notes").value.trim();
  const trocoRaw = document.getElementById("checkout-troco").value.trim();

  if (!name) {
    warningEl.textContent = "Digite seu nome para confirmar o pedido.";
    return;
  }
  if (!customerPhone) {
    warningEl.textContent = "Digite seu telefone para confirmar o pedido.";
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
  document.getElementById("checkout-btn").classList.add("is-loading");
  showOrderSuccessOverlay();

  const checkout = {
    name, phone: customerPhone, delivery, address, payment, notes, trocoPaidWith, trocoAmount,
    deliveryFeeText: feeCtl.feeText(),
  };

  /* Manda o pedido para o servidor (para o agente de impressão térmica
   * pegar), mas sem travar o cliente: mesmo que isso falhe (sem
   * internet no momento, servidor fora do ar), o pedido continua indo
   * pelo WhatsApp normalmente — só não vai sair impresso sozinho. */
  const orderPromise = cartRegisterOrder(cart, checkout);

  const message = cartOrderMessage(cart, total, checkout);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
  cartClear();
  renderCart();
  cartGoToTracking(orderPromise);
}

loadStoreInfo().then(renderCart);

/* WhatsApp, Pix e horário podem mudar no admin: se mudarem, atualiza. */
LiveRefresh.watchPage({ pick: (d) => d.store });
