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
  message += "\n\n";
  // checkout.deliveryFeeText: "R$ 5,00" (calculada) ou "a combinar" (não deu
  // para calcular). Ausente na retirada. `total` já vem COM a taxa somada.
  if (checkout.deliveryFeeText) {
    message += `Taxa de entrega: ${checkout.deliveryFeeText}\n`;
  }
  message += `*Total: ${cartFormatPrice(total)}*`;
  if (checkout.deliveryFeeText === "a combinar") message += " (+ taxa de entrega)";
  message += "\n\n";
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

/*
 * ---------- taxa de entrega por distância ----------
 * Usado pelas três telas de checkout (carrinho, produto, promoção).
 * Pergunta ao servidor (POST /api/calcular-tarifa) a taxa do endereço.
 * Endereço novo pode levar alguns segundos (fila de 1 req/s do Nominatim);
 * endereço já consultado responde na hora (cache).
 */
const CART_DELIVERY_VALUE = "Entrega (delivery)";

async function cartFetchDeliveryQuote(address) {
  try {
    const res = await fetch("/api/calcular-tarifa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      // distance_km vem null quando a taxa é fixa por bairro (sem geocodificação).
      const hasDistance = data.distance_km !== null && data.distance_km !== undefined;
      return { status: "ok", address, fee: Number(data.fee), distance_km: hasDistance ? Number(data.distance_km) : null };
    }
    return {
      status: "manual",
      address,
      message: data.error || "Não foi possível calcular a taxa agora.",
    };
  } catch (error) {
    console.error(error);
    return {
      status: "manual",
      address,
      message: "Não foi possível calcular a taxa agora.",
    };
  }
}

/*
 * Liga o cálculo de taxa a um checkout.
 *   deliverySelect / addressInput: os campos já existentes da tela
 *   mount:    elemento vazio onde o botão e o resultado serão desenhados
 *   onChange: chamado quando a taxa muda (para a tela refazer o total)
 * Devolve { calculate, isResolved, feeAmount, feeText }.
 *
 * "manual" (endereço não achado, fora da área, sem internet...) NÃO bloqueia
 * o pedido: a taxa vai como "a combinar" e a pizzaria confirma pelo WhatsApp.
 */
function cartAttachDeliveryFee({ deliverySelect, addressInput, mount, onChange }) {
  let quote = null;
  let busy = false;

  mount.innerHTML = `
    <button type="button" class="fee-btn">📍 Calcular taxa de entrega</button>
    <p class="fee-result" aria-live="polite"></p>
  `;
  const button = mount.querySelector(".fee-btn");
  const resultEl = mount.querySelector(".fee-result");

  const isDelivery = () => deliverySelect.value === CART_DELIVERY_VALUE;
  const currentAddress = () => addressInput.value.trim();

  function render() {
    mount.style.display = isDelivery() ? "block" : "none";
    resultEl.classList.remove("fee-warning");
    if (busy) {
      resultEl.textContent = "Calculando a taxa… pode levar alguns segundos.";
    } else if (!quote) {
      resultEl.textContent = "";
    } else if (quote.status === "ok") {
      const distanceText = quote.distance_km === null ? "" : ` (≈ ${quote.distance_km.toFixed(1).replace(".", ",")} km)`;
      resultEl.textContent = `Taxa de entrega: ${cartFormatPrice(quote.fee)}${distanceText}`;
    } else {
      resultEl.textContent = `${quote.message} A taxa será combinada pelo WhatsApp.`;
      resultEl.classList.add("fee-warning");
    }
    button.disabled = busy;
  }

  async function calculate() {
    const address = currentAddress();
    if (!isDelivery() || !address || busy) return quote;
    busy = true;
    quote = null;
    render();
    const result = await cartFetchDeliveryQuote(address);
    busy = false;
    // Se o cliente mudou o endereço enquanto esperava, descarta a resposta velha.
    if (currentAddress() === address) quote = result;
    render();
    onChange();
    return quote;
  }

  button.addEventListener("click", calculate);
  addressInput.addEventListener("input", () => {
    if (quote) {
      quote = null;
      render();
      onChange();
    }
  });
  deliverySelect.addEventListener("change", () => {
    render();
    onChange();
  });
  render();

  return {
    calculate,
    /* Retirada, ou entrega com taxa já calculada para o endereço atual. */
    isResolved: () => !isDelivery() || (!!quote && quote.address === currentAddress()),
    isBusy: () => busy,
    feeAmount: () => (isDelivery() && quote && quote.status === "ok" ? quote.fee : 0),
    /* "R$ 5,00", "a combinar", ou null na retirada. */
    feeText: () => {
      if (!isDelivery() || !quote) return null;
      return quote.status === "ok" ? cartFormatPrice(quote.fee) : "a combinar";
    },
  };
}

/*
 * ---------- zona de entrega (Piscinão de Ramos / Ramos) ----------
 * Em vez de um texto livre para o endereço, o cliente escolhe primeiro a
 * zona (botões) e só depois aparece o campo de rua/número. O endereço
 * final gravado no input hidden é "<rua>, <zona>", para que geocoding.py
 * continue casando por substring ("ramos" / "piscinão de ramos").
 */
function cartAttachDeliveryZone(root) {
  if (!root) return;
  const buttons = root.querySelectorAll(".zone-option");
  const wrap = root.querySelector(".zone-address-wrap");
  const streetInput = root.querySelector(".zone-street-input");
  const hiddenInput = root.querySelector(".zone-hidden-address");
  let zone = "";
  function sync() {
    const street = streetInput ? streetInput.value.trim() : "";
    hiddenInput.value = zone && street ? `${street}, ${zone}` : "";
    hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      zone = btn.dataset.zone;
      buttons.forEach((b) => b.classList.toggle("selected", b === btn));
      if (wrap) wrap.style.display = "block";
      sync();
    });
  });
  if (streetInput) streetInput.addEventListener("input", sync);
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
