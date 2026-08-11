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

  fillPromotions(data.promotions || [], items);
  fillGrid("pizzas-grid", items.filter((i) => i.category === "pizza"));
  fillGrid("salgados-grid", items.filter((i) => i.category === "salgado"));
  fillGrid("bebidas-grid", items.filter((i) => i.category === "bebida"));

  document.getElementById("foot-hours").textContent =
    `${store.hours.open} – ${store.hours.close}`;
  document.getElementById("foot-address").textContent = store.address;

  setupReveal();
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
      <div class="price">R$ ${Number(item.price || 0).toFixed(2)}</div>
    </div>`
    )
    .join("");
}

loadData();


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
      <div class="promo-total">Total: <strong>${formatPrice(promo.price)}</strong></div>
      <div class="promo-warning" aria-live="polite"></div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".promo-card").forEach((card) => {
    const promo = promotions.find((p) => String(p.id) === String(card.dataset.promoId));
    const selects = [...card.querySelectorAll(".promo-select")];
    const updateTotal = () => {
      let total = Number(promo.price || 0);
      let complete = true;
      selects.forEach((select) => {
        if (!select.value) { complete = false; return; }
        const item = items.find((i) => String(i.id) === String(select.value));
        total += Number(item?.promo_extra || 0);
      });
      card.querySelector(".promo-total strong").textContent = formatPrice(total);
      const warning = card.querySelector(".promo-warning");
      warning.textContent = complete ? "" : "Selecione todas as opções para ver o valor final.";
    };
    selects.forEach((select) => select.addEventListener("change", updateTotal));
    updateTotal();
  });
}

function categoryLabel(category) {
  return { pizza: "Pizza", salgado: "Salgado", bebida: "Bebida" }[category] || category;
}
