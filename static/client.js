let lastMenuSignature = "";

async function loadData() {
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    if (!res.ok) throw new Error("Não foi possível carregar o cardápio.");
    const data = await res.json();
    // Só redesenha se algo mudou (preço, esgotado, aberto/fechado, promoção...).
    const signature = JSON.stringify(data);
    if (signature === lastMenuSignature) return;
    lastMenuSignature = signature;
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

function render(data) {
  const { store, today_post, items } = data;

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

  fillInfoBar(store);
  fillPromoBanner(data.promotions || []);
  fillMaisPedidos(items, data.pizza_sizes || []);
  fillPromotions(data.promotions || [], items);
  fillGrid("pizzas-grid", items.filter((i) => i.category === "pizza"), data.pizza_sizes || []);
  fillGrid("salgados-grid", items.filter((i) => i.category === "salgado"));
  fillGrid("bebidas-grid", items.filter((i) => i.category === "bebida"));

  document.getElementById("foot-hours").textContent =
    `${store.hours.open} – ${store.hours.close}`;
  document.getElementById("foot-address").textContent = store.address;

  setupScrollReveal();
}

function fillInfoBar(store) {
  const deliveryEl = document.getElementById("info-delivery");
  const minOrderEl = document.getElementById("info-min-order");
  const addressEl = document.getElementById("info-address");
  if (deliveryEl) {
    deliveryEl.innerHTML = store.delivery_time
      ? `Entrega <strong>${escapeHTML(store.delivery_time)}</strong>`
      : "";
  }
  if (minOrderEl) {
    minOrderEl.innerHTML = store.min_order
      ? `Pedido mínimo <strong>${formatPrice(store.min_order)}</strong>`
      : "";
  }
  if (addressEl) addressEl.textContent = store.address || "";
}

function fillPromoBanner(promotions) {
  const banner = document.getElementById("promo-banner");
  const textEl = document.getElementById("promo-banner-text");
  if (!banner || !textEl) return;
  const first = promotions[0];
  if (!first) {
    banner.style.display = "none";
    return;
  }
  textEl.textContent = `${first.name} — ${formatPrice(first.price)}`;
  banner.style.display = "block";
}

function fillMaisPedidos(items, pizzaSizes) {
  const section = document.getElementById("mais-pedidos-section");
  const row = document.getElementById("mais-pedidos-row");
  if (!section || !row) return;

  let featured = items.filter((i) => i.featured);
  if (!featured.length) featured = items.slice(0, 4);
  if (!featured.length) {
    section.classList.add("is-empty");
    return;
  }

  section.classList.remove("is-empty");
  row.innerHTML = featured.map((item, index) => `
    <a class="highlight-card reveal${item.available === false ? " is-sold-out" : ""}" href="/produto/${escapeHTML(item.id)}" style="transition-delay:${Math.min(index, 8) * 70}ms">
      <div class="thumb">
        ${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : `<span>foto</span>`}
        ${item.available === false ? `<span class="sold-out-badge">Esgotado</span>` : ""}
      </div>
      <div class="name">${escapeHTML(item.name)}</div>
      <div class="price">${itemPriceLabel(item, pizzaSizes)}</div>
    </a>`).join("");

  setupScrollReveal();
}

function cheapestPizzaPrice(pizzaSizes) {
  if (!pizzaSizes || !pizzaSizes.length) return null;
  return Math.min(...pizzaSizes.map((s) => Number(s.price || 0)));
}

function itemPriceLabel(item, pizzaSizes) {
  if (item.category === "pizza") {
    const cheapest = cheapestPizzaPrice(pizzaSizes);
    if (cheapest !== null) {
      // Mesma regra da página do produto: o preço da pizza vale para o
      // primeiro tamanho da tabela; os outros somam a diferença da tabela.
      const own = Number(item.price || 0);
      const from = own ? own + cheapest - Number(pizzaSizes[0].price || 0) : cheapest;
      return `A partir de ${formatPrice(from)}`;
    }
  }
  return formatPrice(item.price);
}

let revealObserver = null;

function setupScrollReveal() {
  const els = document.querySelectorAll(".reveal:not(.is-observed)");
  if (!("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-visible", "is-observed"));
    return;
  }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add("is-visible");
      });
    }, { threshold: 0.12 });
  }
  els.forEach((el) => {
    el.classList.add("is-observed");
    revealObserver.observe(el);
  });
}

function fillGrid(elementId, list, pizzaSizes) {
  const grid = document.getElementById(elementId);

  grid.innerHTML = list
    .map((item, index) => {
      const soldOut = item.available === false;
      return `
    <a class="card reveal${soldOut ? " is-sold-out" : ""}" href="/produto/${escapeHTML(item.id)}" style="transition-delay:${Math.min(index, 8) * 70}ms">
      <div class="image-slot small">
        ${
          item.image
            ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">`
            : `<span>foto</span>`
        }
        ${soldOut ? `<span class="sold-out-badge">Esgotado</span>` : ""}
      </div>
      <div class="name">${escapeHTML(item.name)}</div>
      ${
        item.description
          ? `<div class="description">${escapeHTML(item.description)}</div>`
          : ""
      }
      <div class="price">${itemPriceLabel(item, pizzaSizes)}</div>
      <span class="card-cta">${soldOut ? "Esgotado no momento" : "Ver e pedir →"}</span>
    </a>`;
    })
    .join("");

  setupScrollReveal();
}

loadData();
// Atualiza o cardápio sozinho a cada 15s (e na hora ao voltar para a aba).
LiveRefresh.every(loadData, 15000);


function formatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
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
  grid.innerHTML = promotions.map((promo, promoIndex) => `
    <a class="promo-card reveal" style="transition-delay:${Math.min(promoIndex, 8) * 70}ms" href="/promocao/${escapeHTML(promo.id)}">
      <div class="image-slot small">${promo.image ? `<img src="${escapeHTML(promo.image)}" alt="${escapeHTML(promo.name)}">` : `<span>foto</span>`}</div>
      <div class="name">${escapeHTML(promo.name)}</div>
      ${promo.description ? `<div class="description">${escapeHTML(promo.description)}</div>` : ""}
      <div class="promo-base-price">Preço base: ${formatPrice(promo.price)}</div>
      <span class="card-cta">Escolher e pedir →</span>
    </a>`).join("");

  setupScrollReveal();
}

function categoryLabel(category) {
  return { pizza: "Pizza", salgado: "Salgado", bebida: "Bebida" }[category] || category;
}
