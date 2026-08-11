// ⚠️ Troque pelo número de WhatsApp da pizzaria (com DDI+DDD, só números).
const WHATSAPP_NUMBER = "5521999999999";
// ⚠️ Troque pela chave Pix da pizzaria (CPF/CNPJ, e-mail, telefone ou chave aleatória).
const PIX_KEY = "sua-chave-pix-aqui";

let storeItems = [];
let storePromotions = [];
let cart = {}; // key -> { type: 'item'|'promo', id, name, qty, unitPrice? }
let paymentMethod = null; // "pix" | "cartao" | "dinheiro"

async function loadData() {
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error("Não foi possível carregar o cardápio.");
    const data = await res.json();
    render(data);
  } catch (error) {
    console.error(error);
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

function render(data) {
  const { store, today_post, items } = data;
  storeItems = items;
  storePromotions = data.promotions || [];

  if (store.logo) {
    const headerLogo = document.getElementById("brand-logo");
    headerLogo.src = store.logo;
    headerLogo.style.display = "block";
    document.getElementById("brand-name").style.display = "none";

    const bigLogo = document.getElementById("logo-big");
    bigLogo.src = store.logo;
    bigLogo.style.display = "block";
  }

  const sign = document.getElementById("sign");
  const signText = document.getElementById("sign-text");
  if (store.is_open) {
    sign.className = "sign is-open";
    signText.textContent = `ABERTO · fecha às ${store.hours.close}`;
  } else {
    sign.className = "sign is-closed";
    signText.textContent = `FECHADO · abre às ${store.hours.open}`;
  }

  document.getElementById("post-title").textContent = today_post.title;
  document.getElementById("post-text").textContent = today_post.text;
  const postImage = document.getElementById("post-image");
  if (today_post.image) {
    postImage.innerHTML = `<img src="${escapeHTML(today_post.image)}" alt="${escapeHTML(today_post.title)}">`;
  } else {
    postImage.innerHTML = `<span>espaço para foto do dia</span>`;
  }

  fillPromotions(storePromotions, items);
  fillGrid("pizzas-grid", items.filter((i) => i.category === "pizza"));
  fillGrid("salgados-grid", items.filter((i) => i.category === "salgado"));
  fillGrid("bebidas-grid", items.filter((i) => i.category === "bebida"));

  document.getElementById("foot-hours").textContent =
    `${store.hours.open} – ${store.hours.close}`;
  document.getElementById("foot-address").textContent = store.address;

  setupReveal();
  updateCartBar();
}

function setupReveal() {
  const targets = document.querySelectorAll(".reveal:not(.is-visible)");
  if (!targets.length) return;

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );

  targets.forEach((el) => observer.observe(el));
}

/* ---------------- cardápio (produtos) ---------------- */

function fillGrid(elementId, list) {
  const grid = document.getElementById(elementId);

  grid.innerHTML = list
    .map(
      (item) => `
    <div class="card reveal">
      <div class="image-slot small">
        ${
          item.image
            ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">`
            : `<span>foto</span>`
        }
      </div>
      <div class="name">${escapeHTML(item.name)}</div>
      ${
        item.description
          ? `<div class="description">${escapeHTML(item.description)}</div>`
          : ""
      }
      <div class="card-bottom">
        <div class="price">${formatPrice(item.price)}</div>
        <div class="qty-stepper" data-item-id="${item.id}">
          <button type="button" class="qty-btn" data-action="minus" aria-label="Diminuir">−</button>
          <span class="qty-value" id="qty-item-${item.id}">0</span>
          <button type="button" class="qty-btn" data-action="plus" aria-label="Adicionar">+</button>
        </div>
      </div>
    </div>`
    )
    .join("");

  grid.querySelectorAll(".qty-stepper").forEach((stepper) => {
    const id = Number(stepper.dataset.itemId);
    stepper.querySelectorAll(".qty-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = storeItems.find((i) => Number(i.id) === id);
        if (!item) return;
        const key = `item:${id}`;
        const current = cart[key]?.qty || 0;
        const next = btn.dataset.action === "plus" ? current + 1 : Math.max(0, current - 1);
        if (next === 0) {
          delete cart[key];
        } else {
          cart[key] = { type: "item", id, name: item.name, qty: next, unitPrice: Number(item.price || 0) };
        }
        document.getElementById(`qty-item-${id}`).textContent = String(next);
        updateCartBar();
      });
    });
  });
}

/* ---------------- promoções ---------------- */

function categoryLabel(category) {
  return { pizza: "Pizza", salgado: "Salgado", bebida: "Bebida" }[category] || category;
}

function computePromoTotal(promo, selects, items) {
  let total = Number(promo.price || 0);
  let complete = true;
  const chosenNames = [];
  selects.forEach((select) => {
    if (!select.value) { complete = false; return; }
    const item = items.find((i) => String(i.id) === String(select.value));
    if (item) {
      total += Number(item.promo_extra || 0);
      chosenNames.push(item.name);
    }
  });
  return { total, complete, chosenNames };
}

function fillPromotions(promotions, items) {
  const grid = document.getElementById("promos-grid");
  const section = document.getElementById("promos-section");
  if (!grid || !section) return;
  if (!promotions.length) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  grid.innerHTML = promotions.map((promo) => {
    const slots = (promo.slots || []).map((slot, index) => {
      const options = items.filter((item) => item.category === slot.category);
      return `<div class="promo-choice">
        <label>${escapeHTML(slot.label || `Escolha ${index + 1}`)}</label>
        <select class="promo-select" data-slot-index="${index}">
          <option value="">Selecione ${escapeHTML(categoryLabel(slot.category))}</option>
          ${options.map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}${Number(item.promo_extra || 0) > 0 ? ` (+${formatPrice(item.promo_extra)})` : ""}</option>`).join("")}
        </select>
      </div>`;
    }).join("");
    return `<div class="promo-card reveal" data-promo-id="${escapeHTML(promo.id)}">
      <div class="image-slot small">${promo.image ? `<img src="${escapeHTML(promo.image)}" alt="${escapeHTML(promo.name)}">` : `<span>foto</span>`}</div>
      <div class="name">${escapeHTML(promo.name)}</div>
      ${promo.description ? `<div class="description">${escapeHTML(promo.description)}</div>` : ""}
      <div class="promo-base-price">Preço base: ${formatPrice(promo.price)}</div>
      <div class="promo-choices">${slots}</div>
      <div class="promo-warning" aria-live="polite"></div>
      <div class="card-bottom">
        <div class="promo-total">Total: <strong>${formatPrice(promo.price)}</strong></div>
        <div class="qty-stepper" data-promo-id="${escapeHTML(promo.id)}">
          <button type="button" class="qty-btn" data-action="minus" aria-label="Diminuir">−</button>
          <span class="qty-value" id="qty-promo-${escapeHTML(promo.id)}">0</span>
          <button type="button" class="qty-btn" data-action="plus" aria-label="Adicionar" disabled>+</button>
        </div>
      </div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".promo-card").forEach((card) => {
    const promo = promotions.find((p) => String(p.id) === String(card.dataset.promoId));
    const selects = [...card.querySelectorAll(".promo-select")];
    const plusBtn = card.querySelector('.qty-btn[data-action="plus"]');
    const minusBtn = card.querySelector('.qty-btn[data-action="minus"]');
    const key = `promo:${promo.id}`;

    const refresh = () => {
      const { total, complete, chosenNames } = computePromoTotal(promo, selects, items);
      card.querySelector(".promo-total strong").textContent = formatPrice(total);
      const warning = card.querySelector(".promo-warning");
      warning.textContent = complete ? "" : "Selecione todas as opções para adicionar ao pedido.";
      plusBtn.disabled = !complete;

      // Se a promoção já está no carrinho, mantém a quantidade mas atualiza o preço/composição atual.
      if (cart[key]) {
        if (!complete) {
          delete cart[key];
          document.getElementById(`qty-promo-${promo.id}`).textContent = "0";
        } else {
          cart[key].unitPrice = total;
          cart[key].name = `${promo.name} (${chosenNames.join(" + ")})`;
        }
        updateCartBar();
      }
    };

    selects.forEach((select) => select.addEventListener("change", refresh));

    plusBtn.addEventListener("click", () => {
      const { total, complete, chosenNames } = computePromoTotal(promo, selects, items);
      if (!complete) return;
      const current = cart[key]?.qty || 0;
      cart[key] = {
        type: "promo",
        id: promo.id,
        name: `${promo.name} (${chosenNames.join(" + ")})`,
        qty: current + 1,
        unitPrice: total,
      };
      document.getElementById(`qty-promo-${promo.id}`).textContent = String(cart[key].qty);
      updateCartBar();
    });

    minusBtn.addEventListener("click", () => {
      const current = cart[key]?.qty || 0;
      const next = Math.max(0, current - 1);
      if (next === 0) {
        delete cart[key];
      } else {
        cart[key].qty = next;
      }
      document.getElementById(`qty-promo-${promo.id}`).textContent = String(next);
      updateCartBar();
    });

    refresh();
  });
}

/* ---------------- carrinho flutuante + WhatsApp ---------------- */

function updateCartBar() {
  const bar = document.getElementById("cart-bar");
  if (!bar) return;

  const entries = Object.values(cart);
  const totalQty = entries.reduce((sum, e) => sum + e.qty, 0);
  const totalPrice = entries.reduce((sum, e) => sum + e.qty * e.unitPrice, 0);

  if (!totalQty) {
    bar.classList.remove("is-visible");
    return;
  }

  bar.classList.add("is-visible");
  document.getElementById("cart-count").textContent =
    totalQty === 1 ? "1 item" : `${totalQty} itens`;
  document.getElementById("cart-total").textContent = formatPrice(totalPrice);
}

function buildWhatsAppMessage() {
  const entries = Object.entries(cart);
  const lines = entries.map(([, e]) => {
    let line = `• ${e.qty}x ${e.name} — ${formatPrice(e.qty * e.unitPrice)}`;
    if (e.note && e.note.trim()) line += `\n   obs: ${e.note.trim()}`;
    return line;
  });
  const total = Object.values(cart).reduce((sum, e) => sum + e.qty * e.unitPrice, 0);
  const generalNote = document.getElementById("cart-general-note")?.value.trim();

  const paymentLines = [];
  if (paymentMethod === "pix") {
    paymentLines.push(`Pagamento: Pix (chave: ${PIX_KEY})`);
    paymentLines.push("Vou enviar o comprovante aqui pelo WhatsApp.");
  } else if (paymentMethod === "cartao") {
    paymentLines.push("Pagamento: Cartão na entrega (débito/crédito)");
  } else if (paymentMethod === "dinheiro") {
    const trocoInput = document.getElementById("troco-valor");
    const trocoPara = parseFloat(trocoInput?.value);
    if (trocoInput?.value && !Number.isNaN(trocoPara)) {
      const troco = trocoPara - total;
      paymentLines.push(`Pagamento: Dinheiro — troco para ${formatPrice(trocoPara)}`);
      if (troco > 0) paymentLines.push(`(troco de ${formatPrice(troco)})`);
    } else {
      paymentLines.push("Pagamento: Dinheiro — sem troco (valor exato)");
    }
  }

  const message = [
    "Olá! Quero fazer um pedido na Rey Pizzaria:",
    "",
    ...lines,
    "",
    `Total: ${formatPrice(total)}`,
    "",
    ...paymentLines,
    ...(generalNote ? ["", `Observações: ${generalNote}`] : []),
  ].join("\n");
  return message;
}

/* ---------------- modal de resumo do pedido ---------------- */

function openCartModal() {
  const modal = document.getElementById("cart-modal");
  const list = document.getElementById("cart-modal-items");
  if (!modal || !list) return;

  const entries = Object.entries(cart);
  if (!entries.length) return;

  list.innerHTML = entries
    .map(
      ([key, e]) => `
    <div class="cart-modal-item">
      <div class="cart-modal-item-row">
        <span>${e.qty}x ${escapeHTML(e.name)}</span>
        <span>${formatPrice(e.qty * e.unitPrice)}</span>
      </div>
      <input
        type="text"
        class="cart-item-note"
        data-key="${escapeHTML(key)}"
        placeholder="Alguma observação? Ex.: sem cebola, bem passada..."
        value="${escapeHTML(e.note || "")}"
      >
    </div>`
    )
    .join("");

  list.querySelectorAll(".cart-item-note").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.key;
      if (cart[key]) cart[key].note = input.value;
    });
  });

  const total = Object.values(cart).reduce((sum, e) => sum + e.qty * e.unitPrice, 0);
  document.getElementById("cart-modal-total").textContent = formatPrice(total);

  // reseta a forma de pagamento a cada abertura
  paymentMethod = null;
  document.querySelectorAll(".payment-btn").forEach((btn) => btn.classList.remove("active"));
  document.getElementById("troco-field").style.display = "none";
  document.getElementById("pix-info").style.display = "none";
  document.getElementById("troco-valor").value = "";
  document.getElementById("payment-warning").textContent = "";
  document.getElementById("pix-key-display").textContent = PIX_KEY;

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("crop-open");
}

function closeCartModal() {
  const modal = document.getElementById("cart-modal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("crop-open");
}

document.querySelectorAll(".payment-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    paymentMethod = btn.dataset.method;
    document.querySelectorAll(".payment-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("troco-field").style.display = paymentMethod === "dinheiro" ? "flex" : "none";
    document.getElementById("pix-info").style.display = paymentMethod === "pix" ? "block" : "none";
    document.getElementById("payment-warning").textContent = "";
  });
});

document.getElementById("copy-pix-btn")?.addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText(PIX_KEY);
    const btn = event.currentTarget;
    const original = btn.textContent;
    btn.textContent = "Copiado!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch (error) {
    console.error(error);
  }
});

document.getElementById("cart-checkout-btn")?.addEventListener("click", () => {
  if (!Object.keys(cart).length) return;
  openCartModal();
});

document.getElementById("cart-modal-close")?.addEventListener("click", closeCartModal);
document.getElementById("cart-modal-cancel")?.addEventListener("click", closeCartModal);
document.getElementById("cart-modal")?.addEventListener("click", (event) => {
  if (event.target.id === "cart-modal") closeCartModal();
});

document.getElementById("cart-modal-confirm")?.addEventListener("click", () => {
  if (!paymentMethod) {
    document.getElementById("payment-warning").textContent = "Selecione uma forma de pagamento.";
    return;
  }
  const message = buildWhatsAppMessage();
  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
  closeCartModal();
});

loadData();
