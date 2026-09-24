let currentData = null;

/* Lê/escreve um campo do formulário só se ele existir na página. Evita que
 * o painel inteiro quebre (bordas, pizzas, etc. pararem de carregar) se
 * algum campo do HTML e do admin.js ficarem fora de sincronia — por
 * exemplo, se o admin.html enviado ao servidor for uma versão mais antiga
 * que o admin.js. */
function setFieldValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getFieldValue(id, fallback = "") {
  const el = document.getElementById(id);
  return el ? el.value : fallback;
}

/* Painéis colapsáveis: cada <section class="panel"> pode ser fechado
 * clicando no título, pra página não ficar gigante com o cardápio inteiro
 * sempre aberto. Não mexe no HTML original — só pega o que já existe
 * depois do título (h2 ou .panel-heading-row) e empacota numa "gaveta"
 * que anima ao abrir/fechar. Os IDs de dentro (pizzas-list, etc.)
 * continuam os mesmos, então o resto do admin.js nem percebe a mudança.
 * Lembra o que o admin deixou aberto/fechado entre uma visita e outra. */
const PANEL_COLLAPSE_STORAGE_KEY = "rey-admin-panel-collapse-v1";

// Cardápio, promoções e vendas tendem a ficar compridos — começam fechados
// na primeira visita. O resto (loja, bordas, etc.) começa aberto.
const PANEL_DEFAULT_COLLAPSED = [
  "cardapio-pizzas",
  "cardapio-salgados",
  "cardapio-bebidas",
  "promocoes",
  "vendas-dos-funcionarios",
];

function slugifyPanelId(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function initCollapsiblePanels() {
  let savedState = {};
  try {
    savedState = JSON.parse(localStorage.getItem(PANEL_COLLAPSE_STORAGE_KEY) || "{}");
  } catch (_) {
    savedState = {};
  }

  document.querySelectorAll("main.wrap > .panel").forEach((panel, index) => {
    const headerRow = panel.querySelector(":scope > h2, :scope > .panel-heading-row");
    if (!headerRow) return;

    const isRow = headerRow.classList.contains("panel-heading-row");
    const heading = isRow ? headerRow.querySelector("h2") : headerRow;
    if (!heading) return;

    const panelId = slugifyPanelId(heading.textContent) || `panel-${index}`;

    // Empacota tudo que vem depois do título numa "gaveta" que anima.
    const body = document.createElement("div");
    body.className = "panel-body";
    const inner = document.createElement("div");
    inner.className = "panel-body-inner";
    body.appendChild(inner);
    let node = headerRow.nextSibling;
    while (node) {
      const next = node.nextSibling;
      inner.appendChild(node);
      node = next;
    }
    panel.appendChild(body);

    // Vira o clique só na área do título (não no botão "+ Adicionar", que
    // continua funcionando normal do lado dele).
    let toggleTarget = heading;
    if (isRow) {
      toggleTarget = document.createElement("div");
      toggleTarget.className = "panel-toggle-heading";
      headerRow.insertBefore(toggleTarget, heading);
      toggleTarget.appendChild(heading);
    } else {
      heading.classList.add("panel-toggle-heading");
    }
    toggleTarget.setAttribute("role", "button");
    toggleTarget.setAttribute("tabindex", "0");

    const chevron = document.createElement("span");
    chevron.className = "panel-toggle-chevron";
    chevron.textContent = "▾";
    toggleTarget.appendChild(chevron);

    function setCollapsed(collapsed) {
      panel.classList.toggle("is-collapsed", collapsed);
      toggleTarget.setAttribute("aria-expanded", String(!collapsed));
      savedState[panelId] = collapsed;
      try {
        localStorage.setItem(PANEL_COLLAPSE_STORAGE_KEY, JSON.stringify(savedState));
      } catch (_) { /* localStorage indisponível — só não lembra a preferência */ }
    }

    toggleTarget.addEventListener("click", () => setCollapsed(!panel.classList.contains("is-collapsed")));
    toggleTarget.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setCollapsed(!panel.classList.contains("is-collapsed"));
    });

    const startCollapsed = panelId in savedState ? savedState[panelId] : PANEL_DEFAULT_COLLAPSED.includes(panelId);
    panel.classList.toggle("is-collapsed", startCollapsed);
    toggleTarget.setAttribute("aria-expanded", String(!startCollapsed));
  });
}

async function loadData() {
  try {
    const res = await fetch("/api/admin/data");
    if (res.status === 401) { window.location.href = "/admin/login"; return; }
    if (!res.ok) throw new Error("Não foi possível carregar os dados.");
    currentData = await res.json();
    currentData.promotions = Array.isArray(currentData.promotions) ? currentData.promotions : [];
    currentData.shifts = Array.isArray(currentData.shifts) ? currentData.shifts : [];
    currentData.pizza_sizes = Array.isArray(currentData.pizza_sizes) ? currentData.pizza_sizes : [];
    currentData.store.bordas = Array.isArray(currentData.store.bordas) ? currentData.store.bordas : [];
    fillForm(currentData);
  } catch (error) {
    console.error(error);
    showToast("Erro ao carregar os dados");
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

function fillForm(data) {
  const { store, today_post, items } = data;
  setFieldValue("hour-open", store.hours.open);
  setFieldValue("hour-close", store.hours.close);
  setFieldValue("store-address", store.address);
  setFieldValue("store-delivery-time", store.delivery_time || "");
  setFieldValue("store-min-order", store.min_order || "");
  setFieldValue("store-whatsapp", store.whatsapp_number || "");
  setFieldValue("store-pix-key", store.pix_key || "");
  setFieldValue("store-pix-name", store.pix_name || "");
  setFieldValue("store-pix-city", store.pix_city || "");
  setFieldValue("store-print-token", store.print_agent_token || "");
  setImagePreview("store-logo-preview", store.logo);
  setImagePreview("post-image-preview", today_post.image);
  setStatusButton(store.force_status);
  document.getElementById("post-title").value = today_post.title;
  document.getElementById("post-text").value = today_post.text;
  fillPromoList(data.promotions, items);
  fillShiftList(data.shifts);
  fillSizeList(data.pizza_sizes || []);
  fillBordaList(store.bordas || []);
  fillItemList("pizzas-list", items.filter((i) => i.category === "pizza"));
  fillItemList("salgados-list", items.filter((i) => i.category === "salgado"));
  fillItemList("bebidas-list", items.filter((i) => i.category === "bebida"));
}

function setImagePreview(elementId, url) {
  const preview = document.getElementById(elementId);
  if (!preview) return;
  preview.innerHTML = url
    ? `<img src="${escapeHTML(url)}" alt="Pré-visualização">`
    : `<span>Nenhuma imagem selecionada</span>`;
}

function setStatusButton(forceStatus) {
  const value = forceStatus === null ? "auto" : forceStatus === true ? "true" : "false";
  document.querySelectorAll(".status-toggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.status === value);
  });
}

async function uploadImage(file, filename = "imagem.jpg") {
  if (!file) return null;
  const formData = new FormData();
  formData.append("image", file, filename);
  const res = await fetch("/api/upload-image", { method: "POST", body: formData });
  let result = {};
  try { result = await res.json(); } catch (_) {}
  if (!res.ok || !result.ok) {
    throw new Error(result.error || "Não foi possível enviar a imagem.");
  }
  return result.url;
}

const cropState = {
  image: null,
  aspectRatio: 4 / 3,
  outputType: "image/jpeg",
  zoom: 1,
  x: 0,
  y: 0,
  baseScale: 1,
  scale: 1,
  dragging: false,
  startX: 0,
  startY: 0,
  startImageX: 0,
  startImageY: 0,
  resolve: null
};

function setupCropper() {
  const modal = document.getElementById("crop-modal");
  const canvas = document.getElementById("crop-canvas");
  const zoom = document.getElementById("crop-zoom");
  const zoomValue = document.getElementById("crop-zoom-value");
  const save = document.getElementById("crop-save");
  const cancel = document.getElementById("crop-cancel");
  const cancelBottom = document.getElementById("crop-cancel-bottom");

  if (!modal || !canvas || !zoom || !save || !cancel || !cancelBottom) return;

  zoom.addEventListener("input", () => {
    const previousScale = cropState.scale;
    cropState.zoom = Number(zoom.value);
    cropState.scale = cropState.baseScale * cropState.zoom;

    // Mantém o ponto central visual o mais estável possível ao aplicar o zoom.
    const factor = cropState.scale / previousScale;
    cropState.x = canvas.width / 2 + (cropState.x - canvas.width / 2) * factor;
    cropState.y = canvas.height / 2 + (cropState.y - canvas.height / 2) * factor;
    clampCropPosition();
    zoomValue.textContent = `${Math.round(cropState.zoom * 100)}%`;
    drawCrop();
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (!cropState.image) return;
    cropState.dragging = true;
    cropState.startX = event.clientX;
    cropState.startY = event.clientY;
    cropState.startImageX = cropState.x;
    cropState.startImageY = cropState.y;
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!cropState.dragging) return;
    const rect = canvas.getBoundingClientRect();
    const factorX = canvas.width / rect.width;
    const factorY = canvas.height / rect.height;
    cropState.x = cropState.startImageX + (event.clientX - cropState.startX) * factorX;
    cropState.y = cropState.startImageY + (event.clientY - cropState.startY) * factorY;
    clampCropPosition();
    drawCrop();
  });

  const stopDrag = () => { cropState.dragging = false; };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("pointerleave", stopDrag);

  cancel.addEventListener("click", () => closeCropper(null));
  cancelBottom.addEventListener("click", () => closeCropper(null));

  const fitButton = document.getElementById("fit-image-btn");
  fitButton?.addEventListener("click", () => {
    if (!cropState.image) return;
    cropState.zoom = 1;
    cropState.scale = cropState.baseScale;
    cropState.x = canvas.width / 2;
    cropState.y = canvas.height / 2;
    zoom.value = "1";
    zoomValue.textContent = "100%";
    clampCropPosition();
    drawCrop();
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeCropper(null);
  });

  save.addEventListener("click", async () => {
    if (!cropState.image || !cropState.resolve) return;
    save.disabled = true;
    try {
      const blob = await createCroppedBlob();
      closeCropper(blob);
    } catch (error) {
      console.error(error);
      showToast("Não foi possível preparar a imagem");
    } finally {
      save.disabled = false;
    }
  });
}

function openCropper(file, aspectRatio = 4 / 3, outputType = "image/jpeg") {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler a imagem."));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const modal = document.getElementById("crop-modal");
        const canvas = document.getElementById("crop-canvas");
        const zoom = document.getElementById("crop-zoom");
        const zoomValue = document.getElementById("crop-zoom-value");
        const title = document.getElementById("crop-title");
        const help = document.getElementById("crop-help");

        cropState.image = image;
        cropState.aspectRatio = aspectRatio;
        cropState.outputType = outputType;
        cropState.zoom = 1;
        cropState.resolve = resolve;

        // Saída grande o suficiente para não perder qualidade no cardápio.
        canvas.width = aspectRatio === 16 / 9 ? 1200 : aspectRatio === 1 ? 900 : 1200;
        canvas.height = Math.round(canvas.width / aspectRatio);

        cropState.baseScale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        cropState.scale = cropState.baseScale;
        cropState.x = canvas.width / 2;
        cropState.y = canvas.height / 2;

        zoom.value = "1";
        zoomValue.textContent = "100%";
        title.textContent = aspectRatio === 16 / 9 ? "Ajustar imagem do post" : aspectRatio === 1 ? "Ajustar logo" : "Ajustar imagem do produto";
        help.textContent = "A imagem começa ajustada para aparecer inteira. Você pode afastar, aproximar ou arrastar para escolher o resultado.";

        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        document.body.classList.add("crop-open");
        clampCropPosition();
        drawCrop();
      };
      image.onerror = () => reject(new Error("O arquivo selecionado não é uma imagem válida."));
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function clampCropPosition() {
  const canvas = document.getElementById("crop-canvas");
  if (!canvas || !cropState.image) return;

  const drawWidth = cropState.image.naturalWidth * cropState.scale;
  const drawHeight = cropState.image.naturalHeight * cropState.scale;
  const halfW = drawWidth / 2;
  const halfH = drawHeight / 2;

  // Quando a imagem é menor que o quadro, ela pode ficar inteira visível.
  // Nesse caso, mantemos o centro para evitar que ela saia da área de edição.
  if (drawWidth <= canvas.width) {
    cropState.x = canvas.width / 2;
  } else {
    const minX = canvas.width - halfW;
    const maxX = halfW;
    cropState.x = Math.min(maxX, Math.max(minX, cropState.x));
  }

  if (drawHeight <= canvas.height) {
    cropState.y = canvas.height / 2;
  } else {
    const minY = canvas.height - halfH;
    const maxY = halfH;
    cropState.y = Math.min(maxY, Math.max(minY, cropState.y));
  }
}

function drawCrop() {
  const canvas = document.getElementById("crop-canvas");
  if (!canvas || !cropState.image) return;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const width = cropState.image.naturalWidth * cropState.scale;
  const height = cropState.image.naturalHeight * cropState.scale;
  ctx.drawImage(
    cropState.image,
    cropState.x - width / 2,
    cropState.y - height / 2,
    width,
    height
  );
}

function createCroppedBlob() {
  const canvas = document.getElementById("crop-canvas");
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Não foi possível gerar o recorte.")),
      cropState.outputType,
      cropState.outputType === "image/png" ? undefined : 0.90
    );
  });
}

function closeCropper(result) {
  const modal = document.getElementById("crop-modal");
  const resolve = cropState.resolve;
  cropState.image = null;
  cropState.resolve = null;
  cropState.dragging = false;
  modal?.classList.remove("is-open");
  modal?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("crop-open");
  if (resolve) resolve(result);
}

async function handleSingleImageUpload(input, onUploaded, previewId, aspectRatio = 4 / 3, outputType = "image/jpeg") {
  const file = input.files?.[0];
  if (!file) return;

  try {
    if (!file.type.startsWith("image/")) {
      throw new Error("Selecione um arquivo de imagem.");
    }

    showToast("Abra o editor para ajustar a imagem...");
    const croppedBlob = await openCropper(file, aspectRatio, outputType);
    if (!croppedBlob) return;

    showToast("Enviando imagem...");
    const extension = outputType === "image/png" ? "png" : "jpg";
    const url = await uploadImage(croppedBlob, `imagem-${Date.now()}.${extension}`);
    onUploaded(url);
    if (previewId) setImagePreview(previewId, url);
    showToast("Imagem ajustada e enviada");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Erro ao enviar imagem");
  } finally {
    input.value = "";
  }
}

/* ---------- Lista de produtos (pizzas / salgados / bebidas) ----------
 * Cada produto aparece como uma linha compacta (foto, nome, preço). Clicar
 * na linha abre/fecha os campos de edição. Produtos novos (ainda não salvos)
 * ficam no TOPO da lista e já vêm abertos, pra não precisar rolar a página. */
const ITEM_LIST_IDS = { pizza: "pizzas-list", salgado: "salgados-list", bebida: "bebidas-list" };
const ITEM_EMOJI = { pizza: "🍕", salgado: "🥟", bebida: "🥤" };
const expandedItemIds = new Set();
const newItemIds = new Set();

function formatBRL(value) {
  return (Number(value) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function normalizeSearch(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function setRowOpen(row, open) {
  row.classList.toggle("is-open", open);
  row.querySelector(".item-summary")?.setAttribute("aria-expanded", String(open));
  const id = Number(row.dataset.id);
  if (open) expandedItemIds.add(id); else expandedItemIds.delete(id);
}

function updateRowSummary(row) {
  const name = row.querySelector(".item-name-input").value.trim() || "(sem nome)";
  const price = row.querySelector(".item-price").value;
  const featured = row.querySelector(".item-featured")?.checked;
  const isNew = newItemIds.has(Number(row.dataset.id));
  const soldOut = row.classList.contains("is-unavailable");
  row.querySelector(".item-summary-name").textContent = name;
  row.querySelector(".item-summary-meta").textContent = [
    formatBRL(price),
    featured ? "⭐ destaque" : "",
    soldOut ? "🔴 esgotado" : "",
    isNew ? "✨ novo (não salvo)" : "",
  ].filter(Boolean).join(" · ");
}

function applyItemFilter(container) {
  const bar = container.previousElementSibling;
  const isBar = bar && bar.classList.contains("item-toolbar");
  const term = normalizeSearch(isBar ? bar.querySelector(".item-search").value : "");
  let shown = 0;
  const rows = container.querySelectorAll(".item-row");
  rows.forEach((row) => {
    const match = !term || normalizeSearch(row.querySelector(".item-name-input").value).includes(term);
    row.hidden = !match;
    if (match) shown += 1;
  });
  if (isBar) {
    bar.querySelector(".item-count").textContent = term
      ? `${shown} de ${rows.length}`
      : `${rows.length} produto${rows.length === 1 ? "" : "s"}`;
  }
}

function initItemToolbars() {
  Object.values(ITEM_LIST_IDS).forEach((listId) => {
    const container = document.getElementById(listId);
    if (!container || (container.previousElementSibling && container.previousElementSibling.classList.contains("item-toolbar"))) return;
    const bar = document.createElement("div");
    bar.className = "item-toolbar";
    bar.innerHTML = `
      <input type="search" class="item-search" placeholder="🔍 Buscar por nome..." aria-label="Buscar produto">
      <button type="button" class="item-toggle-all">Abrir todos</button>
      <span class="item-count"></span>`;
    container.parentNode.insertBefore(bar, container);
    bar.querySelector(".item-search").addEventListener("input", () => applyItemFilter(container));
    const toggleAll = bar.querySelector(".item-toggle-all");
    toggleAll.addEventListener("click", () => {
      const rows = [...container.querySelectorAll(".item-row:not([hidden])")];
      const open = rows.some((row) => !row.classList.contains("is-open"));
      rows.forEach((row) => setRowOpen(row, open));
      toggleAll.textContent = open ? "Fechar todos" : "Abrir todos";
    });
  });
}

function fillItemList(elementId, list) {
  const container = document.getElementById(elementId);
  if (!list.length) {
    container.innerHTML = `<div class="empty-items">Nenhum produto cadastrado.</div>`;
    applyItemFilter(container);
    return;
  }
  // Produtos novos primeiro (a ordem "oficial" do cardápio continua sendo a do servidor).
  const ordered = [...list].sort((a, b) => (newItemIds.has(Number(b.id)) ? 1 : 0) - (newItemIds.has(Number(a.id)) ? 1 : 0));
  container.innerHTML = ordered.map((item) => {
    const isAvailable = item.available !== false;
    const isOpen = expandedItemIds.has(Number(item.id));
    const thumb = item.image ? `<img src="${escapeHTML(item.image)}" alt="">` : (ITEM_EMOJI[item.category] || "🍽️");
    return `
    <div class="item-row${isAvailable ? "" : " is-unavailable"}${isOpen ? " is-open" : ""}" data-id="${escapeHTML(item.id)}">
      <div class="item-summary" role="button" tabindex="0" aria-expanded="${isOpen}">
        <div class="item-thumb">${thumb}</div>
        <div class="item-summary-text"><strong class="item-summary-name"></strong><span class="item-summary-meta"></span></div>
        <span class="item-chevron">▾</span>
      </div>
      <div class="item-details">
        <button type="button" class="availability-toggle-btn${isAvailable ? "" : " is-sold-out"}" data-id="${escapeHTML(item.id)}">
          ${isAvailable ? "🟢 Disponível — clique para marcar como esgotado" : "🔴 Esgotado — clique para disponibilizar de novo"}
        </button>
        <div class="field item-name-field"><label>Nome</label><input type="text" class="item-name-input" value="${escapeHTML(item.name)}" placeholder="Nome do produto"></div>
        <div class="field"><label>Preço (R$)</label><input type="number" min="0" step="0.5" class="item-price" value="${escapeHTML(item.price)}">${item.category === "pizza" ? `<small>Preço no tamanho base (o primeiro de "Tamanhos das pizzas"). Os outros tamanhos somam a diferença da tabela.</small>` : ""}</div>
        <div class="field"><label>Adicional na promoção (R$)</label><input type="number" min="0" step="0.5" class="item-promo-extra" value="${escapeHTML(item.promo_extra || 0)}"><small>Só é cobrado quando este produto é escolhido dentro de uma promoção (inteiro ou em metade). Na venda individual não tem efeito.</small></div>
        <div class="field item-image-field"><label>Imagem do produto</label><input type="file" class="item-image-file" accept="image/png,image/jpeg,image/webp,image/gif"><div class="image-preview item-image-preview">${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : `<span>Nenhuma imagem</span>`}</div></div>
        <div class="field item-description-field"><label>Comentário / descrição</label><textarea class="item-description" placeholder="Ex.: Molho de tomate, mussarela e manjericão">${escapeHTML(item.description || "")}</textarea></div>
        <label class="item-featured-field"><input type="checkbox" class="item-featured" ${item.featured ? "checked" : ""}> Destacar em "Mais pedidos"</label>
        <button type="button" class="delete-item-btn" data-id="${escapeHTML(item.id)}">Excluir produto</button>
      </div>
    </div>`;
  }).join("");

  container.querySelectorAll(".item-row").forEach((row) => {
    updateRowSummary(row);
    const summary = row.querySelector(".item-summary");
    summary.addEventListener("click", () => setRowOpen(row, !row.classList.contains("is-open")));
    summary.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setRowOpen(row, !row.classList.contains("is-open"));
    });
    row.addEventListener("input", () => { updateRowSummary(row); });
    row.querySelector(".item-name-input").addEventListener("input", () => applyItemFilter(container));
  });

  container.querySelectorAll(".delete-item-btn").forEach((button) => button.addEventListener("click", () => removeItem(Number(button.dataset.id))));
  container.querySelectorAll(".availability-toggle-btn").forEach((button) => button.addEventListener("click", () => toggleItemAvailability(Number(button.dataset.id))));
  container.querySelectorAll(".item-image-file").forEach((input) => input.addEventListener("change", async () => {
    const row = input.closest(".item-row");
    const id = Number(row.dataset.id);
    await handleSingleImageUpload(input, (url) => {
      const item = currentData.items.find((entry) => Number(entry.id) === id);
      if (item) item.image = url;
    }, null, 4 / 3, "image/jpeg");
    const item = currentData.items.find((entry) => Number(entry.id) === id);
    if (item?.image) {
      row.querySelector(".item-image-preview").innerHTML = `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">`;
      row.querySelector(".item-thumb").innerHTML = `<img src="${escapeHTML(item.image)}" alt="">`;
    }
  }));
  applyItemFilter(container);
}

/* Copia o que está digitado nos campos dos produtos de volta para
 * currentData.items. Assim, adicionar ou excluir um produto NÃO apaga o que
 * você já tinha digitado (e ainda não salvo) nos outros produtos. */
function syncItemsFromDOM() {
  if (!currentData) return;
  currentData.items = currentData.items.map((item) => {
    const row = document.querySelector(`.item-row[data-id="${item.id}"]`);
    if (!row) return item;
    return {
      ...item,
      name: row.querySelector(".item-name-input").value,
      price: parseFloat(row.querySelector(".item-price").value) || 0,
      promo_extra: parseFloat(row.querySelector(".item-promo-extra").value) || 0,
      description: row.querySelector(".item-description").value,
      featured: row.querySelector(".item-featured")?.checked || false,
    };
  });
}

function refreshItemLists() {
  Object.entries(ITEM_LIST_IDS).forEach(([category, listId]) => {
    fillItemList(listId, currentData.items.filter((i) => i.category === category));
  });
}

function openPanelContaining(element) {
  const panel = element?.closest(".panel");
  if (panel && panel.classList.contains("is-collapsed")) {
    panel.querySelector(".panel-toggle-heading")?.click();
  }
}

async function toggleItemAvailability(id) {
  const item = currentData.items.find((entry) => Number(entry.id) === id);
  if (!item) return;
  const nextAvailable = !(item.available !== false);
  try {
    const res = await fetch(`/api/admin/item/${id}/disponibilidade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ available: nextAvailable }),
    });
    if (!res.ok) throw new Error("O servidor recusou a alteração.");
    item.available = nextAvailable;
    // Só atualiza esse botão e essa linha na tela — não re-renderiza o
    // formulário inteiro, pra não perder alterações não salvas em outros campos.
    const row = document.querySelector(`.item-row[data-id="${id}"]`);
    const button = row?.querySelector(".availability-toggle-btn");
    if (row) row.classList.toggle("is-unavailable", !nextAvailable);
    if (button) {
      button.classList.toggle("is-sold-out", !nextAvailable);
      button.textContent = nextAvailable
        ? "🟢 Disponível — clique para marcar como esgotado"
        : "🔴 Esgotado — clique para disponibilizar de novo";
    }
    showToast(nextAvailable ? "Produto disponível de novo" : "Produto marcado como esgotado");
  } catch (error) {
    console.error(error);
    showToast("Erro ao alterar a disponibilidade");
  }
}

function categoryLabel(category) {
  return { pizza: "Pizza", salgado: "Salgado", bebida: "Bebida" }[category] || category;
}

function fillPromoList(promotions, items) {
  const container = document.getElementById("promos-list");
  if (!promotions.length) {
    container.innerHTML = `<div class="empty-items">Nenhuma promoção cadastrada.</div>`;
    return;
  }
  container.innerHTML = promotions.map((promo) => `
    <div class="promo-admin-card" data-promo-id="${escapeHTML(promo.id)}">
      <div class="field"><label>Nome da promoção</label><input type="text" class="promo-name" value="${escapeHTML(promo.name)}"></div>
      <div class="row">
        <div class="field"><label>Preço base (R$)</label><input type="number" min="0" step="0.5" class="promo-price" value="${escapeHTML(promo.price)}"></div>
        <div class="field"><label>Imagem da promoção</label><input type="file" class="promo-image-file" accept="image/png,image/jpeg,image/webp,image/gif"><div class="image-preview promo-image-preview">${promo.image ? `<img src="${escapeHTML(promo.image)}" alt="${escapeHTML(promo.name)}">` : `<span>Nenhuma imagem</span>`}</div></div>
      </div>
      <div class="field"><label>Descrição</label><textarea class="promo-description" placeholder="Ex.: Escolha os sabores das duas pizzas. Algumas pizzas podem ter adicional.">${escapeHTML(promo.description || "")}</textarea></div>
      <div class="promo-slots-header"><strong>Escolhas do cliente</strong><button type="button" class="add-slot-btn">+ Adicionar escolha</button></div>
      <div class="promo-slots">${(promo.slots || []).map((slot, index) => `
        <div class="promo-slot" data-slot-index="${index}">
          <div class="field"><label>Nome da escolha</label><input type="text" class="slot-label" value="${escapeHTML(slot.label || `Escolha ${index + 1}`)}"></div>
          <div class="field"><label>Categoria permitida</label><select class="slot-category"><option value="pizza" ${slot.category === "pizza" ? "selected" : ""}>Pizza</option><option value="salgado" ${slot.category === "salgado" ? "selected" : ""}>Salgado</option><option value="bebida" ${slot.category === "bebida" ? "selected" : ""}>Bebida</option></select></div>
          <button type="button" class="delete-slot-btn">Excluir escolha</button>
        </div>`).join("")}</div>
      <button type="button" class="delete-promo-btn">Excluir promoção</button>
    </div>`).join("");

  container.querySelectorAll(".delete-promo-btn").forEach((btn) => btn.addEventListener("click", () => removePromo(btn.closest(".promo-admin-card").dataset.promoId)));
  container.querySelectorAll(".add-slot-btn").forEach((btn) => btn.addEventListener("click", () => addPromoSlot(btn.closest(".promo-admin-card"))));
  container.querySelectorAll(".delete-slot-btn").forEach((btn) => btn.addEventListener("click", () => btn.closest(".promo-slot").remove()));
  container.querySelectorAll(".promo-image-file").forEach((input) => input.addEventListener("change", async () => {
    const card = input.closest(".promo-admin-card");
    const promo = currentData.promotions.find((p) => String(p.id) === String(card.dataset.promoId));
    await handleSingleImageUpload(input, (url) => { if (promo) promo.image = url; }, null, 4 / 3, "image/jpeg");
    if (promo?.image) card.querySelector(".promo-image-preview").innerHTML = `<img src="${escapeHTML(promo.image)}" alt="${escapeHTML(promo.name)}">`;
  }));
}

function addPromoSlot(card) {
  const slots = card.querySelector(".promo-slots");
  const index = slots.children.length;
  const div = document.createElement("div");
  div.className = "promo-slot";
  div.dataset.slotIndex = index;
  div.innerHTML = `<div class="field"><label>Nome da escolha</label><input type="text" class="slot-label" value="Escolha ${index + 1}"></div><div class="field"><label>Categoria permitida</label><select class="slot-category"><option value="pizza">Pizza</option><option value="salgado">Salgado</option><option value="bebida">Bebida</option></select></div><button type="button" class="delete-slot-btn">Excluir escolha</button>`;
  div.querySelector(".delete-slot-btn").addEventListener("click", () => div.remove());
  slots.appendChild(div);
}

function fillShiftList(shifts) {
  const container = document.getElementById("shifts-list");
  if (!shifts.length) {
    container.innerHTML = `<div class="empty-items">Nenhum turno cadastrado. Sem turnos, ninguém consegue entrar em /funcionarios.</div>`;
    return;
  }
  container.innerHTML = shifts.map((shift) => {
    const hasPw = shift.has_password || (shift.password && shift.password !== "" && shift.password !== "__unchanged__");
    const placeholder = hasPw
      ? "Deixe em branco para manter a senha atual"
      : "Senha para este turno";
    return `
    <div class="shift-admin-card" data-shift-id="${escapeHTML(shift.id)}">
      <div class="row">
        <div class="field"><label>Nome do turno</label><input type="text" class="shift-name" value="${escapeHTML(shift.name)}" placeholder="Ex.: Turno 1 (18h-19h)"></div>
        <div class="field"><label>Senha do turno</label><input type="password" class="shift-password" value="" placeholder="${escapeHTML(placeholder)}" autocomplete="new-password"></div>
      </div>
      <p class="field-hint" style="font-size:0.8rem;color:var(--ink-soft);margin:0 0 8px;">${hasPw ? "Senha já definida (não é possível visualizá-la). Preencha só se quiser trocar." : "Defina uma senha para este turno."}</p>
      <button type="button" class="delete-item-btn delete-shift-btn">Excluir turno</button>
    </div>`;
  }).join("");

  container.querySelectorAll(".delete-shift-btn").forEach((btn) => btn.addEventListener("click", () => removeShift(btn.closest(".shift-admin-card").dataset.shiftId)));
}

function addShift() {
  const ids = currentData.shifts.map((s) => Number(s.id)).filter(Number.isFinite);
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  currentData.shifts.push({ id: nextId, name: `Turno ${nextId}`, password: "" });
  fillForm(currentData);
  const card = document.querySelector(`.shift-admin-card[data-shift-id="${nextId}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.querySelector(".shift-name")?.focus();
}

function removeShift(id) {
  const shift = currentData.shifts.find((s) => String(s.id) === String(id));
  if (!shift || !window.confirm(`Excluir o turno "${shift.name}"? Quem usa essa senha não conseguirá mais entrar em /funcionarios.`)) return;
  currentData.shifts = currentData.shifts.filter((s) => String(s.id) !== String(id));
  fillForm(currentData);
}

function fillSizeList(sizes) {
  const container = document.getElementById("sizes-list");
  if (!sizes.length) {
    container.innerHTML = `<div class="empty-items">Nenhum tamanho cadastrado. Sem tamanhos, as pizzas ficam com preço único.</div>`;
    return;
  }
  container.innerHTML = sizes.map((size) => `
    <div class="size-admin-card" data-size-id="${escapeHTML(size.id)}">
      <div class="row">
        <div class="field"><label>Nome</label><input type="text" class="size-name" value="${escapeHTML(size.name)}" placeholder="Ex.: Broto"></div>
        <div class="field"><label>Centímetros</label><input type="number" min="0" class="size-cm" value="${escapeHTML(size.cm)}" placeholder="Ex.: 25"></div>
        <div class="field"><label>Preço (R$)</label><input type="number" min="0" step="0.5" class="size-price" value="${escapeHTML(size.price)}" placeholder="Ex.: 20"></div>
      </div>
      <button type="button" class="delete-item-btn delete-size-btn">Excluir tamanho</button>
    </div>`).join("");

  container.querySelectorAll(".delete-size-btn").forEach((btn) => btn.addEventListener("click", () => removeSize(btn.closest(".size-admin-card").dataset.sizeId)));
}

function addSize() {
  const sizes = currentData.pizza_sizes || [];
  const ids = sizes.map((s) => Number(s.id)).filter(Number.isFinite);
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  sizes.push({ id: nextId, name: "Novo tamanho", cm: 0, price: 0 });
  currentData.pizza_sizes = sizes;
  fillForm(currentData);
  const card = document.querySelector(`.size-admin-card[data-size-id="${nextId}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.querySelector(".size-name")?.focus();
}

function removeSize(id) {
  const size = (currentData.pizza_sizes || []).find((s) => String(s.id) === String(id));
  if (!size || !window.confirm(`Excluir o tamanho "${size.name}"? Ele deixará de aparecer na página das pizzas.`)) return;
  currentData.pizza_sizes = currentData.pizza_sizes.filter((s) => String(s.id) !== String(id));
  fillForm(currentData);
}

function fillBordaList(bordas) {
  const container = document.getElementById("bordas-list");
  if (!container) return;
  if (!bordas.length) {
    container.innerHTML = `<div class="empty-items">Nenhuma borda cadastrada. Sem bordas, essa opção não aparece nas pizzas.</div>`;
    return;
  }
  container.innerHTML = bordas.map((borda) => `
    <div class="size-admin-card" data-borda-id="${escapeHTML(borda.id)}">
      <div class="row">
        <div class="field"><label>Nome</label><input type="text" class="borda-name" value="${escapeHTML(borda.name)}" placeholder="Ex.: Catupiry"></div>
        <div class="field"><label>Preço adicional (R$)</label><input type="number" min="0" step="0.5" class="borda-price" value="${escapeHTML(borda.price)}" placeholder="Ex.: 10"></div>
      </div>
      <button type="button" class="delete-item-btn delete-borda-btn">Excluir borda</button>
    </div>`).join("");

  container.querySelectorAll(".delete-borda-btn").forEach((btn) => btn.addEventListener("click", () => removeBorda(btn.closest(".size-admin-card").dataset.bordaId)));
}

function addBorda() {
  const bordas = currentData.store.bordas || [];
  const ids = bordas.map((b) => Number(b.id)).filter(Number.isFinite);
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  bordas.push({ id: nextId, name: "Nova borda", price: 0 });
  currentData.store.bordas = bordas;
  fillForm(currentData);
  const card = document.querySelector(`.size-admin-card[data-borda-id="${nextId}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.querySelector(".borda-name")?.focus();
}

function removeBorda(id) {
  const borda = (currentData.store.bordas || []).find((b) => String(b.id) === String(id));
  if (!borda || !window.confirm(`Excluir a borda "${borda.name}"? Ela deixará de aparecer nas pizzas.`)) return;
  currentData.store.bordas = currentData.store.bordas.filter((b) => String(b.id) !== String(id));
  fillForm(currentData);
}

function formatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

async function loadSales() {
  const statsEl = document.getElementById("sales-stats");
  const tableEl = document.getElementById("sales-table-wrap");
  if (!statsEl || !tableEl) return;
  try {
    const res = await fetch("/api/admin/sales");
    if (res.status === 401) return;
    if (!res.ok) throw new Error("Não foi possível carregar as vendas.");
    const data = await res.json();

    const byShiftHTML = Object.entries(data.stats.by_shift)
      .map(([name, total]) => `<div class="sales-stat-card"><span>${escapeHTML(name)}</span><strong>${formatPrice(total)}</strong></div>`)
      .join("") || `<div class="empty-items">Nenhuma venda registrada ainda.</div>`;

    statsEl.innerHTML = `
      <div class="sales-stat-card sales-stat-highlight"><span>Total geral</span><strong>${formatPrice(data.stats.total_geral)}</strong></div>
      <div class="sales-stat-card sales-stat-highlight"><span>Últimos 7 dias</span><strong>${formatPrice(data.stats.total_semana)}</strong></div>
      ${byShiftHTML}`;

    if (!data.sales.length) {
      tableEl.innerHTML = `<div class="empty-items">Nenhuma venda registrada ainda.</div>`;
      return;
    }

    tableEl.innerHTML = `<table class="sales-table">
      <thead><tr><th>Data/hora</th><th>Turno</th><th>Itens</th><th>Total</th></tr></thead>
      <tbody>
        ${data.sales.map((sale) => `<tr>
          <td>${escapeHTML(formatTimestamp(sale.timestamp))}</td>
          <td>${escapeHTML(sale.shift_name || "—")}</td>
          <td>${sale.items.map((i) => `${escapeHTML(i.qty)}× ${escapeHTML(i.name)}`).join(", ")}</td>
          <td>${formatPrice(sale.total)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
  } catch (error) {
    console.error(error);
    statsEl.innerHTML = `<div class="empty-items">Erro ao carregar as vendas.</div>`;
  }
}

// ---------- histórico de pedidos (cozinha) ----------

let pedidosPeriod = "today";
let pedidosDeliveryFilter = "all";
let lastPedidosOrders = [];

const PEDIDOS_STAGE_LABELS = {
  confirmado: "Confirmado",
  preparando: "Em preparação",
  pronto: "Pronto",
  em_rota: "Em rota",
  entregue: "Entregue",
  cancelado: "Cancelado",
};

async function loadPedidosHistorico() {
  const tableEl = document.getElementById("pedidos-table-wrap");
  const statsEl = document.getElementById("pedidos-pizzas-stats");
  if (!tableEl) return;
  try {
    const res = await fetch(`/api/admin/pedidos/historico?period=${pedidosPeriod}`);
    if (res.status === 401) return;
    if (!res.ok) throw new Error("Não foi possível carregar o histórico de pedidos.");
    const data = await res.json();
    lastPedidosOrders = data.orders;
    // Some a estatística de pizzas quando os dados mudam, até apertar o botão de novo.
    statsEl.innerHTML = "";
    renderPedidosTable();
  } catch (error) {
    console.error(error);
    tableEl.innerHTML = `<div class="empty-items">Erro ao carregar o histórico de pedidos.</div>`;
  }
}

function filteredPedidosOrders() {
  if (pedidosDeliveryFilter === "all") return lastPedidosOrders;
  return lastPedidosOrders.filter((o) => o.delivery_type === pedidosDeliveryFilter);
}

function renderPedidosTable() {
  const tableEl = document.getElementById("pedidos-table-wrap");
  const orders = filteredPedidosOrders();
  if (!orders.length) {
    tableEl.innerHTML = `<div class="empty-items">Nenhum pedido neste filtro.</div>`;
    return;
  }
  tableEl.innerHTML = `<table class="sales-table">
    <thead><tr><th>Data/hora</th><th>Cliente</th><th>Entrega</th><th>Itens</th><th>Total</th><th>Etapa</th></tr></thead>
    <tbody>
      ${orders.map((order) => `<tr${order.stage === "cancelado" ? ' class="pedido-cancelado"' : ""}>
        <td>${escapeHTML(formatTimestamp(order.created_at))}</td>
        <td>${escapeHTML(order.customer_name || "—")}</td>
        <td>${escapeHTML(order.delivery_type || "—")}</td>
        <td>${order.items.map((i) => `${escapeHTML(i.qty)}× ${escapeHTML(i.name)}`).join(", ")}</td>
        <td>${formatPrice(order.total)}</td>
        <td>${escapeHTML(PEDIDOS_STAGE_LABELS[order.stage] || order.stage)}</td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

function showPedidosPizzasStats() {
  const statsEl = document.getElementById("pedidos-pizzas-stats");
  if (!statsEl) return;
  const porEntrega = {};
  filteredPedidosOrders().forEach((order) => {
    if (order.stage === "cancelado") return; // cancelado não conta como venda
    const pizzas = (order.items || []).reduce((sum, i) => sum + (Number(i.pizza_count) || 0) * (Number(i.qty) || 0), 0);
    if (pizzas) porEntrega[order.delivery_type || "Não informado"] = (porEntrega[order.delivery_type || "Não informado"] || 0) + pizzas;
  });
  const entries = Object.entries(porEntrega);
  if (!entries.length) {
    statsEl.innerHTML = `<div class="empty-items">Nenhuma pizza vendida neste filtro.</div>`;
    return;
  }
  const total = entries.reduce((sum, [, qty]) => sum + qty, 0);
  statsEl.innerHTML = `
    <div class="sales-stat-card sales-stat-highlight"><span>Total de pizzas</span><strong>${total}</strong></div>
    ${entries.map(([label, qty]) => `<div class="sales-stat-card"><span>${escapeHTML(label)}</span><strong>${qty}</strong></div>`).join("")}
  `;
}

document.querySelectorAll("#pedidos-period-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#pedidos-period-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    pedidosPeriod = btn.dataset.period;
    loadPedidosHistorico();
  });
});

document.querySelectorAll("#pedidos-delivery-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#pedidos-delivery-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    pedidosDeliveryFilter = btn.dataset.delivery;
    document.getElementById("pedidos-pizzas-stats").innerHTML = "";
    renderPedidosTable();
  });
});

document.getElementById("pedidos-pizzas-btn")?.addEventListener("click", showPedidosPizzasStats);

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function addItem(category) {
  syncItemsFromDOM();
  const ids = currentData.items.map((item) => Number(item.id)).filter(Number.isFinite);
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  currentData.items.push({ id: nextId, category, name: "Novo produto", price: 0, promo_extra: 0, image: "", description: "", featured: false });
  newItemIds.add(nextId);
  expandedItemIds.add(nextId);
  const container = document.getElementById(ITEM_LIST_IDS[category]);
  // Limpa a busca (senão o produto novo poderia ficar escondido) e abre o painel se estiver fechado.
  const search = container.previousElementSibling?.querySelector?.(".item-search");
  if (search) search.value = "";
  openPanelContaining(container);
  refreshItemLists();
  const row = container.querySelector(`.item-row[data-id="${nextId}"]`);
  row?.scrollIntoView({ behavior: "smooth", block: "center" });
  const input = row?.querySelector(".item-name-input");
  input?.focus();
  input?.select();
}

function removeItem(id) {
  syncItemsFromDOM();
  const item = currentData.items.find((entry) => Number(entry.id) === Number(id));
  if (!item || !window.confirm(`Excluir "${item.name}" do cardápio?`)) return;
  currentData.items = currentData.items.filter((entry) => Number(entry.id) !== Number(id));
  newItemIds.delete(Number(id));
  expandedItemIds.delete(Number(id));
  refreshItemLists();
}

function addPromotion() {
  const ids = currentData.promotions.map((p) => Number(p.id)).filter(Number.isFinite);
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  currentData.promotions.push({ id: nextId, name: "Promoção de 2 pizzas", price: 50, image: "", description: "Escolha o sabor de cada pizza. Pizzas com adicional podem aumentar o valor final.", slots: [{ label: "Pizza 1", category: "pizza" }, { label: "Pizza 2", category: "pizza" }] });
  fillForm(currentData);
  const card = document.querySelector(`.promo-admin-card[data-promo-id="${nextId}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function removePromo(id) {
  const promo = currentData.promotions.find((p) => String(p.id) === String(id));
  if (!promo || !window.confirm(`Excluir a promoção "${promo.name}"?`)) return;
  currentData.promotions = currentData.promotions.filter((p) => String(p.id) !== String(id));
  fillForm(currentData);
}

document.querySelectorAll(".status-toggle button").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".status-toggle button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
}));
document.querySelectorAll(".add-item-btn[data-category]").forEach((button) => button.addEventListener("click", () => addItem(button.dataset.category)));
document.querySelector(".add-promo-btn")?.addEventListener("click", addPromotion);
document.querySelector(".add-shift-btn")?.addEventListener("click", addShift);
document.getElementById("add-size-btn")?.addEventListener("click", addSize);
document.getElementById("add-borda-btn")?.addEventListener("click", addBorda);
document.getElementById("store-logo-file").addEventListener("change", async function () {
  await handleSingleImageUpload(this, (url) => { currentData.store.logo = url; }, "store-logo-preview", 1, "image/png");
});
document.getElementById("post-image-file").addEventListener("change", async function () {
  await handleSingleImageUpload(this, (url) => { currentData.today_post.image = url; }, "post-image-preview", 16 / 9, "image/jpeg");
});

function collectForm() {
  const activeButton = document.querySelector(".status-toggle button.active");
  const forceValue = activeButton ? activeButton.dataset.status : "auto";
  const force_status = forceValue === "auto" ? null : forceValue === "true";

  const items = currentData.items.map((item) => {
    const row = document.querySelector(`.item-row[data-id="${item.id}"]`);
    if (!row) return null;
    const name = row.querySelector(".item-name-input").value.trim();
    if (!name) throw new Error("Todos os produtos precisam ter um nome.");
    return { ...item, name, price: parseFloat(row.querySelector(".item-price").value) || 0, promo_extra: parseFloat(row.querySelector(".item-promo-extra").value) || 0, image: item.image || "", description: row.querySelector(".item-description").value.trim(), featured: row.querySelector(".item-featured")?.checked || false };
  }).filter(Boolean);

  const promotions = [...document.querySelectorAll(".promo-admin-card")].map((card) => {
    const existing = currentData.promotions.find((p) => String(p.id) === String(card.dataset.promoId));
    const slots = [...card.querySelectorAll(".promo-slot")].map((slot, index) => ({ label: slot.querySelector(".slot-label").value.trim() || `Escolha ${index + 1}`, category: slot.querySelector(".slot-category").value }));
    if (!slots.length) throw new Error(`A promoção "${card.querySelector(".promo-name").value.trim()}" precisa ter pelo menos uma escolha.`);
    return { ...existing, name: card.querySelector(".promo-name").value.trim(), price: parseFloat(card.querySelector(".promo-price").value) || 0, image: existing?.image || "", description: card.querySelector(".promo-description").value.trim(), slots };
  });

  const shifts = [...document.querySelectorAll(".shift-admin-card")].map((card) => {
    const existing = currentData.shifts.find((s) => String(s.id) === String(card.dataset.shiftId));
    const name = card.querySelector(".shift-name").value.trim();
    const password = card.querySelector(".shift-password").value.trim();
    if (!name) throw new Error("Todos os turnos precisam ter um nome.");
    // Vacío = mantener la contraseña anterior (el servidor usa "__unchanged__")
    const hasExisting = existing && (existing.has_password || (existing.password && existing.password !== ""));
    if (!password && !hasExisting) {
      throw new Error(`O turno "${name}" precisa ter uma senha.`);
    }
    return { ...existing, name, password: password || "__unchanged__" };
  });

  const pizza_sizes = [...document.querySelectorAll("#sizes-list .size-admin-card")].map((card) => {
    const existing = (currentData.pizza_sizes || []).find((s) => String(s.id) === String(card.dataset.sizeId));
    const name = card.querySelector(".size-name").value.trim();
    if (!name) throw new Error("Todos os tamanhos de pizza precisam ter um nome.");
    return { ...existing, name, cm: parseInt(card.querySelector(".size-cm").value, 10) || 0, price: parseFloat(card.querySelector(".size-price").value) || 0 };
  });

  const bordas = [...document.querySelectorAll("[data-borda-id]")].map((card) => {
    const name = card.querySelector(".borda-name").value.trim();
    if (!name) throw new Error("Todas as bordas precisam ter um nome.");
    return {
      id: card.dataset.bordaId,
      name,
      price: parseFloat(card.querySelector(".borda-price").value) || 0,
    };
  });

  return {
    store: { ...currentData.store, hours: { open: getFieldValue("hour-open").trim(), close: getFieldValue("hour-close").trim() }, force_status, address: getFieldValue("store-address").trim(), delivery_time: getFieldValue("store-delivery-time").trim(), min_order: parseFloat(getFieldValue("store-min-order")) || 0, whatsapp_number: getFieldValue("store-whatsapp").trim(), pix_key: getFieldValue("store-pix-key", currentData.store.pix_key || "").trim(), pix_name: getFieldValue("store-pix-name", currentData.store.pix_name || "").trim(), pix_city: getFieldValue("store-pix-city", currentData.store.pix_city || "").trim(), logo: currentData.store.logo || "", bordas },
    today_post: { title: document.getElementById("post-title").value.trim(), text: document.getElementById("post-text").value.trim(), image: currentData.today_post.image || "" },
    items,
    promotions,
    shifts,
    pizza_sizes
  };
}

document.getElementById("save-btn").addEventListener("click", async () => {
  try {
    const payload = collectForm();
    const res = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) { let message = "O servidor recusou as alterações."; try { const result = await res.json(); message = result.error || message; } catch (_) {} throw new Error(message); }
    currentData = payload;
    newItemIds.clear();
    document.querySelectorAll(".item-row").forEach(updateRowSummary);
    showToast("Alterações salvas");
  } catch (error) { console.error(error); showToast(error.message || "Erro ao salvar"); }
});

function showToast(message = "Alterações salvas") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

document.getElementById("print-token-copy-btn").addEventListener("click", async () => {
  const input = document.getElementById("store-print-token");
  if (!input.value) { showToast("Gere um token primeiro"); return; }
  try {
    await navigator.clipboard.writeText(input.value);
    showToast("Token copiado");
  } catch (error) {
    input.select();
    showToast("Selecione e copie manualmente (Ctrl+C)");
  }
});

document.getElementById("print-token-regenerate-btn").addEventListener("click", async () => {
  if (document.getElementById("store-print-token").value) {
    const confirmado = confirm("Isso invalida o token atual. O computador da pizzaria vai parar de imprimir até você colocar o novo token nele. Continuar?");
    if (!confirmado) return;
  }
  try {
    const res = await fetch("/api/admin/print-token/regenerate", { method: "POST" });
    if (!res.ok) throw new Error("Não foi possível gerar o token.");
    const result = await res.json();
    document.getElementById("store-print-token").value = result.token;
    if (currentData) currentData.store.print_agent_token = result.token;
    showToast("Novo token gerado — copie para o agente de impressão");
  } catch (error) {
    showToast(error.message || "Erro ao gerar token");
  }
});

/* Barra de atalhos fixa no topo: pula direto para qualquer seção (abrindo
 * ela se estiver fechada), sem precisar rolar a página inteira. */
function initSectionNav() {
  const wrap = document.querySelector("main.wrap");
  if (!wrap) return;
  const panels = [...wrap.querySelectorAll(":scope > .panel")];
  const nav = document.createElement("nav");
  nav.className = "admin-quicknav";
  nav.setAttribute("aria-label", "Ir para seção");
  panels.forEach((panel) => {
    const h2 = panel.querySelector("h2");
    if (!h2) return;
    const label = h2.textContent.replace("Cardápio — ", "").replace("Vendas dos funcionários", "Vendas").replace("Turnos de funcionários", "Turnos").replace("Tamanhos das pizzas", "Tamanhos").trim();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      openPanelContaining(panel);
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.appendChild(btn);
  });
  wrap.insertBefore(nav, wrap.firstChild);
}

setupCropper();
initSectionNav();
initCollapsiblePanels();
initItemToolbars();
loadData();
loadSales();
loadPedidosHistorico();
// Só a tabela de vendas se atualiza sozinha; o formulário do cardápio NÃO
// (senão apagaria o que você está digitando).
LiveRefresh.every(loadSales, 30000);
LiveRefresh.every(loadPedidosHistorico, 30000);
