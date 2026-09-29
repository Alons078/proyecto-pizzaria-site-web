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
    // Pode ser chamada de novo (painéis das seções novas entram depois): pula os já preparados.
    if (panel.dataset.collapsibleReady) return;
    const headerRow = panel.querySelector(":scope > h2, :scope > .panel-heading-row");
    if (!headerRow) return;
    panel.dataset.collapsibleReady = "1";

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
    currentData.sections = Array.isArray(currentData.sections) ? currentData.sections : [];
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
  renderCustomSections();
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

/* ---------- editor de recorte de imagens ----------
 * O quadro tem exatamente a proporção usada no site (4:3 nos produtos e
 * promoções), então o que aparece aqui é o que o cliente vê.
 * - Começa preenchendo o quadro (sem faixas brancas).
 * - Arrastar move; roda do mouse / pinça / controle de zoom aproximam ou afastam.
 * - Dá para afastar até ver a imagem inteira; a sobra é preenchida com
 *   fundo desfocado (padrão), branco, preto ou transparente (só PNG).
 */
const cropState = {
  image: null,
  aspectRatio: 4 / 3,
  outputType: "image/jpeg",
  bgMode: "blur",
  bgCanvas: null,
  coverScale: 1,   // escala que preenche o quadro (zoom = 1)
  minZoom: 1,      // zoom mínimo = imagem inteira visível
  maxZoom: 4,
  zoom: 1,
  scale: 1,
  x: 0,
  y: 0,
  pointers: new Map(),
  startX: 0,
  startY: 0,
  startImageX: 0,
  startImageY: 0,
  pinchDistance: 0,
  pinchZoom: 1,
  resolve: null
};

function cropCanvasPoint(clientX, clientY) {
  const canvas = document.getElementById("crop-canvas");
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height)
  };
}

function setCropZoom(value, anchorX, anchorY) {
  const canvas = document.getElementById("crop-canvas");
  if (!canvas || !cropState.image || !Number.isFinite(value)) return;
  const zoom = Math.min(cropState.maxZoom, Math.max(cropState.minZoom, value));
  const newScale = cropState.coverScale * zoom;
  const factor = newScale / cropState.scale;
  cropState.x = anchorX + (cropState.x - anchorX) * factor;
  cropState.y = anchorY + (cropState.y - anchorY) * factor;
  cropState.zoom = zoom;
  cropState.scale = newScale;
  clampCropPosition();
  syncCropControls();
  drawCrop();
}

function resetCrop(zoom) {
  const canvas = document.getElementById("crop-canvas");
  if (!canvas || !cropState.image) return;
  cropState.zoom = zoom;
  cropState.scale = cropState.coverScale * zoom;
  cropState.x = canvas.width / 2;
  cropState.y = canvas.height / 2;
  clampCropPosition();
  syncCropControls();
  drawCrop();
}

function syncCropControls() {
  const zoomInput = document.getElementById("crop-zoom");
  const zoomValue = document.getElementById("crop-zoom-value");
  if (zoomInput) zoomInput.value = String(cropState.zoom);
  if (zoomValue) zoomValue.textContent = `${Math.round(cropState.zoom * 100)}%`;
}

function setupCropper() {
  const modal = document.getElementById("crop-modal");
  const canvas = document.getElementById("crop-canvas");
  const zoom = document.getElementById("crop-zoom");
  const save = document.getElementById("crop-save");
  const cancel = document.getElementById("crop-cancel");
  const cancelBottom = document.getElementById("crop-cancel-bottom");
  const fillButton = document.getElementById("crop-fill-btn");
  const fitButton = document.getElementById("fit-image-btn");
  const bgSelect = document.getElementById("crop-bg");

  if (!modal || !canvas || !zoom || !save || !cancel || !cancelBottom) return;

  zoom.addEventListener("input", () => {
    setCropZoom(Number(zoom.value), canvas.width / 2, canvas.height / 2);
  });

  // Roda do mouse: zoom em torno do ponteiro.
  canvas.addEventListener("wheel", (event) => {
    if (!cropState.image) return;
    event.preventDefault();
    const point = cropCanvasPoint(event.clientX, event.clientY);
    setCropZoom(cropState.zoom * Math.exp(-event.deltaY * 0.0015), point.x, point.y);
  }, { passive: false });

  const beginDrag = (pointer) => {
    cropState.startX = pointer.x;
    cropState.startY = pointer.y;
    cropState.startImageX = cropState.x;
    cropState.startImageY = cropState.y;
  };

  const pinchInfo = () => {
    const [a, b] = Array.from(cropState.pointers.values());
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (!cropState.image) return;
    cropState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture?.(event.pointerId);
    if (cropState.pointers.size === 1) {
      beginDrag({ x: event.clientX, y: event.clientY });
    } else if (cropState.pointers.size === 2) {
      const info = pinchInfo();
      cropState.pinchDistance = info.dist;
      cropState.pinchZoom = cropState.zoom;
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!cropState.pointers.has(event.pointerId)) return;
    cropState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (cropState.pointers.size >= 2) {
      // Pinça: zoom em torno do ponto médio entre os dois dedos.
      const info = pinchInfo();
      const point = cropCanvasPoint(info.midX, info.midY);
      setCropZoom(cropState.pinchZoom * (info.dist / cropState.pinchDistance), point.x, point.y);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const factorX = canvas.width / rect.width;
    const factorY = canvas.height / rect.height;
    cropState.x = cropState.startImageX + (event.clientX - cropState.startX) * factorX;
    cropState.y = cropState.startImageY + (event.clientY - cropState.startY) * factorY;
    clampCropPosition();
    drawCrop();
  });

  const endPointer = (event) => {
    cropState.pointers.delete(event.pointerId);
    // Se sobrou um dedo depois da pinça, recomeça o arraste dele sem "pulo".
    if (cropState.pointers.size === 1) {
      const [remaining] = Array.from(cropState.pointers.values());
      beginDrag(remaining);
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  cancel.addEventListener("click", () => closeCropper(null));
  cancelBottom.addEventListener("click", () => closeCropper(null));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeCropper(null);
  });

  fillButton?.addEventListener("click", () => resetCrop(1));
  fitButton?.addEventListener("click", () => resetCrop(cropState.minZoom));

  bgSelect?.addEventListener("change", () => {
    cropState.bgMode = bgSelect.value;
    drawCrop();
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

/* Versão minúscula da foto, esticada depois: dá um efeito de desfoque
 * que funciona em qualquer navegador (inclusive iPhone). */
function buildBlurBackground(image, aspectRatio) {
  const bw = 48;
  const bh = Math.max(1, Math.round(bw / aspectRatio));
  const small = document.createElement("canvas");
  small.width = bw;
  small.height = bh;
  const ctx = small.getContext("2d");
  const s = Math.max(bw / image.naturalWidth, bh / image.naturalHeight);
  const dw = image.naturalWidth * s;
  const dh = image.naturalHeight * s;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
  return small;
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
        const title = document.getElementById("crop-title");
        const help = document.getElementById("crop-help");
        const bgSelect = document.getElementById("crop-bg");

        cropState.image = image;
        cropState.aspectRatio = aspectRatio;
        cropState.outputType = outputType;
        cropState.resolve = resolve;
        cropState.pointers.clear();

        // Saída grande o suficiente para não perder qualidade no cardápio.
        canvas.width = aspectRatio === 16 / 9 ? 1200 : aspectRatio === 1 ? 900 : 1200;
        canvas.height = Math.round(canvas.width / aspectRatio);

        const coverScale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const containScale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        cropState.coverScale = coverScale;
        cropState.minZoom = Math.floor((containScale / coverScale) * 100) / 100 || 0.1;
        cropState.maxZoom = 4;
        cropState.bgCanvas = buildBlurBackground(image, aspectRatio);

        // Fundo para a sobra quando a imagem não preenche o quadro.
        const isPng = outputType === "image/png";
        cropState.bgMode = isPng ? "transparent" : "blur";
        if (bgSelect) {
          bgSelect.innerHTML = [
            ["blur", "Desfocado"],
            ["white", "Branco"],
            ["black", "Preto"],
            ...(isPng ? [["transparent", "Transparente"]] : [])
          ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
          bgSelect.value = cropState.bgMode;
        }

        zoom.min = String(cropState.minZoom);
        zoom.max = String(cropState.maxZoom);
        zoom.step = "0.01";

        title.textContent = aspectRatio === 16 / 9 ? "Ajustar imagem do post" : aspectRatio === 1 ? "Ajustar logo" : "Ajustar imagem do produto";
        help.textContent = "Arraste a foto para posicionar. Use a roda do mouse, a pinça ou o zoom para aproximar/afastar. O quadro é exatamente o que aparece no site.";

        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        document.body.classList.add("crop-open");
        resetCrop(1); // começa preenchendo o quadro, sem faixas brancas
      };
      image.onerror = () => reject(new Error("O arquivo selecionado não é uma imagem válida."));
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function clampCropAxis(pos, drawSize, frameSize) {
  const half = drawSize / 2;
  if (drawSize >= frameSize) {
    // Imagem maior que o quadro: não deixa aparecer vazio nas bordas.
    return Math.min(half, Math.max(frameSize - half, pos));
  }
  // Imagem menor que o quadro: pode ser posicionada livremente, mas inteira dentro.
  return Math.min(frameSize - half, Math.max(half, pos));
}

function clampCropPosition() {
  const canvas = document.getElementById("crop-canvas");
  if (!canvas || !cropState.image) return;
  const drawWidth = cropState.image.naturalWidth * cropState.scale;
  const drawHeight = cropState.image.naturalHeight * cropState.scale;
  cropState.x = clampCropAxis(cropState.x, drawWidth, canvas.width);
  cropState.y = clampCropAxis(cropState.y, drawHeight, canvas.height);
}

function drawCrop() {
  const canvas = document.getElementById("crop-canvas");
  if (!canvas || !cropState.image) return;

  const ctx = canvas.getContext("2d");
  const width = cropState.image.naturalWidth * cropState.scale;
  const height = cropState.image.naturalHeight * cropState.scale;
  const left = cropState.x - width / 2;
  const top = cropState.y - height / 2;
  const coversFrame = left <= 0.5 && top <= 0.5 && left + width >= canvas.width - 0.5 && top + height >= canvas.height - 0.5;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!coversFrame) {
    if (cropState.bgMode === "white" || cropState.bgMode === "black") {
      ctx.fillStyle = cropState.bgMode === "white" ? "#ffffff" : "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (cropState.bgMode === "blur" || cropState.outputType !== "image/png") {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(cropState.bgCanvas, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(0, 0, 0, 0.30)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // "transparent" (PNG): deixa o canvas vazio.
  }

  const bgField = document.getElementById("crop-bg-field");
  if (bgField) bgField.toggleAttribute("data-idle", coversFrame);

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cropState.image, left, top, width, height);
}

function createCroppedBlob() {
  const canvas = document.getElementById("crop-canvas");
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Não foi possível gerar o recorte.")),
      cropState.outputType,
      cropState.outputType === "image/png" ? undefined : 0.92
    );
  });
}

function closeCropper(result) {
  const modal = document.getElementById("crop-modal");
  const resolve = cropState.resolve;
  cropState.image = null;
  cropState.bgCanvas = null;
  cropState.resolve = null;
  cropState.pointers.clear();
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

const QUICKADD_LABEL = { pizza: "Nova pizza", salgado: "Novo salgado", bebida: "Nova bebida" };

/* Adicionar rápido: escreva nome + preço e aperte Enter. O produto entra no
 * TOPO da lista (fechado), o cursor volta para o campo do nome e a página NÃO
 * rola: dá para cadastrar vários seguidos sem sair do lugar. Foto e descrição
 * podem ser colocadas depois, abrindo o produto. */
function quickAddItem(category, quick) {
  const nameInput = quick.querySelector(".qa-name");
  const priceInput = quick.querySelector(".qa-price");
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  if (priceInput.value.trim() === "") { priceInput.focus(); showToast("Coloque o preço (pode ser 0)"); return; }
  const price = Math.max(0, parseFloat(priceInput.value) || 0);

  syncItemsFromDOM();
  const ids = currentData.items.map((item) => Number(item.id)).filter(Number.isFinite);
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  currentData.items.push({ id: nextId, category, name, price, promo_extra: 0, image: "", description: "", featured: false });
  newItemIds.add(nextId);   // fica fechado (não entra em expandedItemIds)

  const search = quick.nextElementSibling && quick.nextElementSibling.querySelector(".item-search");
  if (search) search.value = "";
  refreshItemLists();
  nameInput.value = "";
  priceInput.value = "";
  nameInput.focus({ preventScroll: true });
  const pending = newItemIds.size;
  showToast(`"${name}" adicionado no topo (${pending} novo${pending === 1 ? "" : "s"} para salvar)`);
}

function initItemToolbars() {
  Object.entries(ITEM_LIST_IDS).forEach(([category, listId]) => {
    const container = document.getElementById(listId);
    if (!container || (container.previousElementSibling && container.previousElementSibling.classList.contains("item-toolbar"))) return;
    const bar = document.createElement("div");
    bar.className = "item-toolbar";
    bar.innerHTML = `
      <input type="search" class="item-search" placeholder="🔍 Buscar por nome..." aria-label="Buscar produto">
      <button type="button" class="item-toggle-all">Abrir todos</button>
      <span class="item-count"></span>`;
    container.parentNode.insertBefore(bar, container);

    // A barra de adicionar rápido vem ANTES da barra de busca (a busca precisa
    // continuar colada na lista).
    const quick = document.createElement("div");
    quick.className = "item-quickadd";
    quick.innerHTML = `
      <input type="text" class="qa-name" placeholder="+ ${QUICKADD_LABEL[category] || "Novo produto"}: nome" aria-label="Nome do novo produto" autocomplete="off">
      <input type="number" class="qa-price" min="0" step="0.5" placeholder="R$" aria-label="Preço do novo produto">
      <button type="button" class="qa-add">Adicionar</button>`;
    bar.parentNode.insertBefore(quick, bar);
    quick.querySelector(".qa-add").addEventListener("click", () => quickAddItem(category, quick));
    quick.querySelector(".qa-name").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (quick.querySelector(".qa-price").value.trim() === "") quick.querySelector(".qa-price").focus();
      else quickAddItem(category, quick);
    });
    quick.querySelector(".qa-price").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); quickAddItem(category, quick); }
    });

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
  // Produtos novos (ainda não salvos) ficam no TOPO, o mais recente primeiro;
  // assim cada novo aparece bem em cima, sem precisar rolar até o fim da lista.
  const ordered = [...list].sort((a, b) => {
    const aNew = newItemIds.has(Number(a.id));
    const bNew = newItemIds.has(Number(b.id));
    if (aNew && bNew) return Number(b.id) - Number(a.id);
    return (bNew ? 1 : 0) - (aNew ? 1 : 0);
  });
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

/* Antes de redesenhar a tela (adicionar/excluir turno, tamanho, borda ou
 * promoção), guarda em currentData tudo o que a pessoa já digitou e ainda não
 * salvou. Sem isso, fillForm() redesenhava tudo a partir dos dados antigos e
 * os campos editados voltavam ao valor de antes, em silêncio.
 * É uma leitura "tolerante": não valida nada (a validação continua só no
 * collectForm(), que é o que roda ao clicar em Salvar). */
const pendingShiftPasswords = {};

function syncAllFromDOM() {
  if (!currentData) return;
  syncItemsFromDOM();

  const readValue = (root, selector) => {
    const el = root.querySelector(selector);
    return el ? el.value : "";
  };

  // Promoções
  const promoCards = [...document.querySelectorAll(".promo-admin-card")];
  if (promoCards.length) {
    currentData.promotions = promoCards.map((card) => {
      const existing = currentData.promotions.find((p) => String(p.id) === String(card.dataset.promoId)) || { id: Number(card.dataset.promoId) };
      const slots = [...card.querySelectorAll(".promo-slot")].map((slot, index) => {
        const category = readValue(slot, ".slot-category");
        const out = { label: readValue(slot, ".slot-label").trim() || `Escolha ${index + 1}`, category };
        const sizeSelect = slot.querySelector(".slot-size");
        if (category === "pizza" && sizeSelect && sizeSelect.value) {
          out.size_id = Number(sizeSelect.value);
          out.size_name = sizeSelect.options[sizeSelect.selectedIndex].textContent;
        }
        return out;
      });
      return { ...existing, name: readValue(card, ".promo-name").trim(), price: parseFloat(readValue(card, ".promo-price")) || 0, description: readValue(card, ".promo-description").trim(), slots };
    });
  }

  // Turnos (a senha digitada fica guardada à parte até salvar)
  const shiftCards = [...document.querySelectorAll(".shift-admin-card")];
  if (shiftCards.length) {
    currentData.shifts = shiftCards.map((card) => {
      const existing = currentData.shifts.find((s) => String(s.id) === String(card.dataset.shiftId)) || { id: Number(card.dataset.shiftId), password: "" };
      const typed = readValue(card, ".shift-password");
      if (typed) pendingShiftPasswords[card.dataset.shiftId] = typed; else delete pendingShiftPasswords[card.dataset.shiftId];
      return { ...existing, name: readValue(card, ".shift-name").trim() };
    });
  }

  // Tamanhos de pizza
  const sizeCards = [...document.querySelectorAll("#sizes-list .size-admin-card")];
  if (sizeCards.length) {
    currentData.pizza_sizes = sizeCards.map((card) => {
      const existing = (currentData.pizza_sizes || []).find((s) => String(s.id) === String(card.dataset.sizeId)) || { id: Number(card.dataset.sizeId) };
      return { ...existing, name: readValue(card, ".size-name").trim(), cm: parseInt(readValue(card, ".size-cm"), 10) || 0, price: parseFloat(readValue(card, ".size-price")) || 0 };
    });
  }

  // Bordas e demais campos da loja / post do dia
  const bordaCards = [...document.querySelectorAll("[data-borda-id]")];
  const store = currentData.store;
  if (bordaCards.length) {
    store.bordas = bordaCards.map((card) => ({ id: card.dataset.bordaId, name: readValue(card, ".borda-name").trim(), price: parseFloat(readValue(card, ".borda-price")) || 0 }));
  }
  const activeButton = document.querySelector(".status-toggle button.active");
  if (activeButton) {
    const forceValue = activeButton.dataset.status;
    store.force_status = forceValue === "auto" ? null : forceValue === "true";
  }
  store.hours = { open: getFieldValue("hour-open").trim(), close: getFieldValue("hour-close").trim() };
  store.address = getFieldValue("store-address").trim();
  store.delivery_time = getFieldValue("store-delivery-time").trim();
  store.min_order = parseFloat(getFieldValue("store-min-order")) || 0;
  store.whatsapp_number = getFieldValue("store-whatsapp").trim();
  store.pix_key = getFieldValue("store-pix-key", store.pix_key || "").trim();
  store.pix_name = getFieldValue("store-pix-name", store.pix_name || "").trim();
  store.pix_city = getFieldValue("store-pix-city", store.pix_city || "").trim();
  currentData.today_post = { ...currentData.today_post, title: document.getElementById("post-title").value.trim(), text: document.getElementById("post-text").value.trim() };
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

/* Botões "Gerenciar senhas dos turnos" (dentro do resumo de senhas das
 * telas): abrem e rolam até o painel de Turnos, já que cozinha e
 * funcionários usam a mesma senha de turno em vez de uma senha própria. */
function initAccessPagesLinks() {
  const panels = [...document.querySelectorAll("main.wrap > .panel")];
  const shiftsPanel = panels.find((panel) => panel.querySelector("h2")?.textContent.includes("Turnos de funcionários"));
  if (!shiftsPanel) return;
  document.querySelectorAll(".goto-shifts-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      openPanelContaining(shiftsPanel);
      shiftsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
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
  const custom = ((currentData && currentData.sections) || []).find((s) => s.category === category);
  return { pizza: "Pizza", salgado: "Salgado", bebida: "Bebida" }[category] || (custom ? custom.name : category);
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
      <div class="promo-slots">${(promo.slots || []).map((slot, index) => promoSlotHTML(slot, index)).join("")}</div>
      <button type="button" class="delete-promo-btn">Excluir promoção</button>
    </div>`).join("");

  container.querySelectorAll(".delete-promo-btn").forEach((btn) => btn.addEventListener("click", () => removePromo(btn.closest(".promo-admin-card").dataset.promoId)));
  container.querySelectorAll(".add-slot-btn").forEach((btn) => btn.addEventListener("click", () => addPromoSlot(btn.closest(".promo-admin-card"))));
  container.querySelectorAll(".promo-slot").forEach(wirePromoSlot);
  container.querySelectorAll(".promo-image-file").forEach((input) => input.addEventListener("change", async () => {
    const card = input.closest(".promo-admin-card");
    const promo = currentData.promotions.find((p) => String(p.id) === String(card.dataset.promoId));
    await handleSingleImageUpload(input, (url) => { if (promo) promo.image = url; }, null, 4 / 3, "image/jpeg");
    if (promo?.image) card.querySelector(".promo-image-preview").innerHTML = `<img src="${escapeHTML(promo.image)}" alt="${escapeHTML(promo.name)}">`;
  }));
}

/* ---------- escolhas (slots) das promoções ---------- */

/* Tamanhos de pizza disponíveis agora (lidos da tela, para pegar também os
 * tamanhos que o admin acabou de criar/renomear e ainda não salvou). */
function currentSizeOptions() {
  const cards = [...document.querySelectorAll("#sizes-list .size-admin-card")];
  if (cards.length) {
    return cards.map((card) => ({ id: String(card.dataset.sizeId), name: card.querySelector(".size-name").value.trim() || "(sem nome)" }));
  }
  return (currentData.pizza_sizes || []).map((size) => ({ id: String(size.id), name: size.name }));
}

function slotSizeOptionsHTML(selectedId, enabled) {
  const first = enabled ? "Sem tamanho específico" : "— (só para pizza)";
  const selected = selectedId == null ? "" : String(selectedId);
  return `<option value="">${first}</option>` + currentSizeOptions()
    .map((size) => `<option value="${escapeHTML(size.id)}"${size.id === selected ? " selected" : ""}>${escapeHTML(size.name)}</option>`)
    .join("");
}

function slotCategoryOptionsHTML(selected) {
  const options = [["pizza", "Pizza"], ["salgado", "Salgado"], ["bebida", "Bebida"], ...((currentData && currentData.sections) || []).map((s) => [s.category, s.name])];
  return options.map(([value, label]) => `<option value="${escapeHTML(value)}"${value === selected ? " selected" : ""}>${escapeHTML(label)}</option>`).join("");
}

function promoSlotHTML(slot, index) {
  const isPizza = slot.category === "pizza";
  return `
        <div class="promo-slot" data-slot-index="${index}">
          <div class="field"><label>Nome da escolha</label><input type="text" class="slot-label" value="${escapeHTML(slot.label || `Escolha ${index + 1}`)}"></div>
          <div class="field"><label>Categoria permitida</label><select class="slot-category">${slotCategoryOptionsHTML(slot.category)}</select></div>
          <div class="field"><label>Tamanho da pizza</label><select class="slot-size"${isPizza ? "" : " disabled"}>${slotSizeOptionsHTML(isPizza ? slot.size_id : null, isPizza)}</select></div>
          <button type="button" class="delete-slot-btn">Excluir escolha</button>
        </div>`;
}

/* Liga os botões de uma escolha: excluir, e trocar categoria (o tamanho só
 * vale quando a categoria é pizza). */
function wirePromoSlot(slotEl) {
  slotEl.querySelector(".delete-slot-btn").addEventListener("click", () => slotEl.remove());
  const categorySelect = slotEl.querySelector(".slot-category");
  const sizeSelect = slotEl.querySelector(".slot-size");
  categorySelect.addEventListener("change", () => {
    const isPizza = categorySelect.value === "pizza";
    sizeSelect.disabled = !isPizza;
    if (!isPizza) sizeSelect.value = "";
    sizeSelect.options[0].textContent = isPizza ? "Sem tamanho específico" : "— (só para pizza)";
  });
}

function addPromoSlot(card) {
  const slots = card.querySelector(".promo-slots");
  const index = slots.children.length;
  const holder = document.createElement("div");
  holder.innerHTML = promoSlotHTML({ label: `Escolha ${index + 1}`, category: "pizza" }, index).trim();
  const div = holder.firstElementChild;
  wirePromoSlot(div);
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
        <div class="field"><label>Senha do turno</label><input type="password" class="shift-password" value="${escapeHTML(pendingShiftPasswords[shift.id] || "")}" placeholder="${escapeHTML(placeholder)}" autocomplete="new-password"></div>
      </div>
      <p class="field-hint" style="font-size:0.8rem;color:var(--ink-soft);margin:0 0 8px;">${hasPw ? "Senha já definida (não é possível visualizá-la). Preencha só se quiser trocar." : "Defina uma senha para este turno."}</p>
      <button type="button" class="delete-item-btn delete-shift-btn">Excluir turno</button>
    </div>`;
  }).join("");

  container.querySelectorAll(".delete-shift-btn").forEach((btn) => btn.addEventListener("click", () => removeShift(btn.closest(".shift-admin-card").dataset.shiftId)));
}

function addShift() {
  syncAllFromDOM();
  const ids = currentData.shifts.map((s) => Number(s.id)).filter(Number.isFinite);
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  currentData.shifts.push({ id: nextId, name: `Turno ${nextId}`, password: "" });
  fillForm(currentData);
  const card = document.querySelector(`.shift-admin-card[data-shift-id="${nextId}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.querySelector(".shift-name")?.focus();
}

function removeShift(id) {
  syncAllFromDOM();
  const shift = currentData.shifts.find((s) => String(s.id) === String(id));
  if (!shift || !window.confirm(`Excluir o turno "${shift.name}"? Quem usa essa senha não conseguirá mais entrar em /funcionarios.`)) return;
  delete pendingShiftPasswords[id];
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
  syncAllFromDOM();
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
  syncAllFromDOM();
  const size = (currentData.pizza_sizes || []).find((s) => String(s.id) === String(id));
  if (!size) return;
  const usedBy = [...document.querySelectorAll(".promo-admin-card .slot-size")].filter((select) => select.value === String(id)).length;
  const promoWarning = usedBy ? `\n\nAtenção: ele é usado em ${usedBy} escolha${usedBy === 1 ? "" : "s"} de promoções, que ficarão sem tamanho definido.` : "";
  if (!window.confirm(`Excluir o tamanho "${size.name}"? Ele deixará de aparecer na página das pizzas.${promoWarning}`)) return;
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
  syncAllFromDOM();
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
  syncAllFromDOM();
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
    // Some as estatísticas quando os dados mudam, até apertar o botão de novo.
    statsEl.innerHTML = "";
    document.getElementById("pedidos-entregas-stats").innerHTML = "";
    document.getElementById("pedidos-pizzas-valor-stats").innerHTML = "";
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
        <td>${escapeHTML(order.customer_name || "—")}${order.customer_phone ? `<br><small>${escapeHTML(order.customer_phone)}</small>` : ""}</td>
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
    if (order.stage !== "entregue") return; // só conta o que já foi realmente entregue
    const pizzas = (order.items || []).reduce((sum, i) => sum + (Number(i.pizza_count) || 0) * (Number(i.qty) || 0), 0);
    if (pizzas) porEntrega[order.delivery_type || "Não informado"] = (porEntrega[order.delivery_type || "Não informado"] || 0) + pizzas;
  });
  const entries = Object.entries(porEntrega);
  if (!entries.length) {
    statsEl.innerHTML = `<div class="empty-items">Nenhuma pizza entregue neste filtro.</div>`;
    return;
  }
  const total = entries.reduce((sum, [, qty]) => sum + qty, 0);
  statsEl.innerHTML = `
    <div class="sales-stat-card sales-stat-highlight"><span>Total de pizzas entregues</span><strong>${total}</strong></div>
    ${entries.map(([label, qty]) => `<div class="sales-stat-card"><span>${escapeHTML(label)}</span><strong>${qty}</strong></div>`).join("")}
  `;
}

/* Quantas entregas foram pedidas no total (delivery, sem contar canceladas)
 * e quantas de fato chegaram ao cliente (etapa "entregue"), além do valor
 * somado das taxas de entrega já concluídas. */
function showPedidosEntregasStats() {
  const statsEl = document.getElementById("pedidos-entregas-stats");
  if (!statsEl) return;
  const deliveryOrders = filteredPedidosOrders().filter(
    (o) => o.delivery_type === "Entrega (delivery)" && o.stage !== "cancelado"
  );
  const entregues = deliveryOrders.filter((o) => o.stage === "entregue");
  const valorEntregas = entregues.reduce((sum, o) => sum + (Number(o.delivery_fee) || 0), 0);

  if (!deliveryOrders.length) {
    statsEl.innerHTML = `<div class="empty-items">Nenhuma entrega neste filtro.</div>`;
    return;
  }
  statsEl.innerHTML = `
    <div class="sales-stat-card sales-stat-highlight"><span>Total de entregas</span><strong>${deliveryOrders.length}</strong></div>
    <div class="sales-stat-card"><span>Entregas concluídas</span><strong>${entregues.length}</strong></div>
    <div class="sales-stat-card"><span>Valor das entregas concluídas</span><strong>${formatPrice(valorEntregas)}</strong></div>
  `;
}

/* Valor em reais de tudo que tinha pizza nos pedidos já entregues (a linha
 * inteira do item, já que numa promoção o preço cobre a pizza junto com o
 * que mais vier nela). */
function showPedidosPizzasValorStats() {
  const statsEl = document.getElementById("pedidos-pizzas-valor-stats");
  if (!statsEl) return;
  const porEntrega = {};
  filteredPedidosOrders().forEach((order) => {
    if (order.stage !== "entregue") return;
    const valor = (order.items || [])
      .filter((i) => (Number(i.pizza_count) || 0) > 0)
      .reduce((sum, i) => sum + (Number(i.unit_price) || 0) * (Number(i.qty) || 0), 0);
    if (valor) porEntrega[order.delivery_type || "Não informado"] = (porEntrega[order.delivery_type || "Não informado"] || 0) + valor;
  });
  const entries = Object.entries(porEntrega);
  if (!entries.length) {
    statsEl.innerHTML = `<div class="empty-items">Nenhuma pizza entregue neste filtro.</div>`;
    return;
  }
  const total = entries.reduce((sum, [, valor]) => sum + valor, 0);
  statsEl.innerHTML = `
    <div class="sales-stat-card sales-stat-highlight"><span>Valor total em pizzas</span><strong>${formatPrice(total)}</strong></div>
    ${entries.map(([label, valor]) => `<div class="sales-stat-card"><span>${escapeHTML(label)}</span><strong>${formatPrice(valor)}</strong></div>`).join("")}
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

document.getElementById("pedidos-limpar-hoje-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("pedidos-limpar-hoje-btn");
  const confirmado = window.confirm(
    "Apagar o histórico de hoje?\n\nIsso apaga pra sempre os pedidos de hoje já entregues ou cancelados. Pedidos ainda em andamento não são afetados. Essa ação não pode ser desfeita."
  );
  if (!confirmado) return;
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = "Apagando…";
  try {
    const res = await fetch("/api/admin/pedidos/historico/limpar-hoje", { method: "POST" });
    if (res.status === 401) return;
    if (!res.ok) throw new Error("Não foi possível apagar o histórico.");
    const data = await res.json();
    await loadPedidosHistorico();
    btn.textContent = `Apagado! (${data.deleted} pedido${data.deleted === 1 ? "" : "s"})`;
    setTimeout(() => { btn.textContent = textoOriginal; }, 2500);
  } catch (error) {
    console.error(error);
    window.alert("Não foi possível apagar o histórico. Tente de novo.");
    btn.textContent = textoOriginal;
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll("#pedidos-delivery-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#pedidos-delivery-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    pedidosDeliveryFilter = btn.dataset.delivery;
    document.getElementById("pedidos-pizzas-stats").innerHTML = "";
    document.getElementById("pedidos-entregas-stats").innerHTML = "";
    document.getElementById("pedidos-pizzas-valor-stats").innerHTML = "";
    renderPedidosTable();
  });
});

document.getElementById("pedidos-pizzas-btn")?.addEventListener("click", showPedidosPizzasStats);
document.getElementById("pedidos-entregas-btn")?.addEventListener("click", showPedidosEntregasStats);
document.getElementById("pedidos-pizzas-valor-btn")?.addEventListener("click", showPedidosPizzasValorStats);

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
  const input = row?.querySelector(".item-name-input");
  input?.focus({ preventScroll: true });
  input?.select();
  // O novo produto já está no topo da lista, então só ajusta se ficou fora da tela.
  row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

/* ---------- Seções extras do cardápio ----------
 * Pizzas, Salgados e Bebidas são fixas. Além delas o admin cria as seções que
 * quiser (Sobremesas, Porções...). Cada seção nova ganha o próprio painel de
 * produtos (mesmos campos: nome, preço, foto, descrição) e aparece sozinha no
 * site do cliente. Os produtos guardam o código da seção (ex.: "sec-1"), que
 * não muda quando a seção é renomeada. */
const BUILTIN_CATEGORIES = ["pizza", "salgado", "bebida"];

function ensureSections() {
  if (!Array.isArray(currentData.sections)) currentData.sections = [];
  return currentData.sections;
}

function renderCustomSections() {
  const wrap = document.querySelector("main.wrap");
  const anchor = document.getElementById("custom-sections-anchor");
  if (!wrap || !anchor || !currentData) return;
  const sections = ensureSections();

  wrap.querySelectorAll(":scope > .custom-section-panel").forEach((panel) => panel.remove());
  Object.keys(ITEM_LIST_IDS).forEach((category) => {
    if (BUILTIN_CATEGORIES.includes(category)) return;
    delete ITEM_LIST_IDS[category];
    delete QUICKADD_LABEL[category];
  });

  sections.forEach((section) => {
    const listId = `custom-list-${section.id}`;
    ITEM_LIST_IDS[section.category] = listId;
    QUICKADD_LABEL[section.category] = "Novo produto";
    const panel = document.createElement("section");
    panel.className = "panel custom-section-panel";
    panel.dataset.category = section.category;
    panel.innerHTML = `<div class="panel-heading-row"><h2>Cardápio — ${escapeHTML(section.name)}</h2><button type="button" class="add-item-btn" data-category="${escapeHTML(section.category)}">+ Adicionar produto</button></div><div id="${listId}"></div>`;
    anchor.before(panel);
    panel.querySelector(".add-item-btn").addEventListener("click", () => addItem(section.category));
  });

  initCollapsiblePanels();
  initItemToolbars();
  sections.forEach((section) => {
    fillItemList(ITEM_LIST_IDS[section.category], currentData.items.filter((item) => item.category === section.category));
  });
  renderSectionsManageList();
  renderSectionQuickNav();
}

function renderSectionsManageList() {
  const box = document.getElementById("sections-manage-list");
  if (!box) return;
  const sections = ensureSections();
  if (!sections.length) {
    box.innerHTML = `<div class="empty-items">Nenhuma seção extra criada ainda. Clique em "+ Adicionar nova seção".</div>`;
    return;
  }
  box.innerHTML = sections.map((section) => {
    const count = currentData.items.filter((item) => item.category === section.category).length;
    return `
    <div class="section-manage-row" data-section-id="${escapeHTML(section.id)}">
      <div class="section-manage-name"><strong>${escapeHTML(section.name)}</strong><small>${count} produto${count === 1 ? "" : "s"}</small></div>
      <div class="section-manage-actions">
        <button type="button" class="rename-section-btn">Renomear</button>
        <button type="button" class="delete-item-btn delete-section-btn">Excluir seção</button>
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll(".section-manage-row").forEach((row) => {
    const id = row.dataset.sectionId;
    row.querySelector(".rename-section-btn").addEventListener("click", () => renameSection(id));
    row.querySelector(".delete-section-btn").addEventListener("click", () => deleteSection(id));
  });
}

/* Atalhos no topo: um botão por seção nova, logo depois de "Bebidas". */
function renderSectionQuickNav() {
  const nav = document.querySelector(".admin-quicknav");
  if (!nav) return;
  nav.querySelectorAll(".custom-quicknav-btn").forEach((btn) => btn.remove());
  let ref = [...nav.children].find((btn) => btn.textContent === "Bebidas") || null;
  document.querySelectorAll("main.wrap > .custom-section-panel").forEach((panel) => {
    const section = ensureSections().find((entry) => entry.category === panel.dataset.category);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "custom-quicknav-btn";
    btn.textContent = section ? section.name : "Seção";
    btn.addEventListener("click", () => {
      openPanelContaining(panel);
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    if (ref) { ref.after(btn); ref = btn; } else { nav.appendChild(btn); }
  });
}

function sectionNameTaken(name, ignoreId) {
  const wanted = normalizeSearch(name);
  const reserved = ["pizza", "pizzas", "salgado", "salgados", "bebida", "bebidas", "promocao", "promocoes"];
  if (reserved.includes(wanted)) return true;
  return ensureSections().some((section) => String(section.id) !== String(ignoreId) && normalizeSearch(section.name) === wanted);
}

function addSection() {
  const raw = window.prompt("Qual será o nome da nova seção?\n(ex.: Sobremesas, Porções, Hambúrgueres)");
  if (raw === null) return;
  const name = raw.trim().slice(0, 60);
  if (!name) { showToast("Digite um nome para a seção"); return; }
  if (sectionNameTaken(name)) { showToast("Já existe uma seção com esse nome"); return; }

  syncItemsFromDOM();
  const sections = ensureSections();
  // O número nunca repete um já usado (nem por produtos "órfãos" de uma seção apagada).
  const used = [
    ...sections.map((section) => Number(section.id)),
    ...currentData.items.map((item) => Number(String(item.category).replace(/^sec-/, ""))),
  ].filter(Number.isFinite);
  const nextId = used.length ? Math.max(...used) + 1 : 1;
  const category = `sec-${nextId}`;
  sections.push({ id: nextId, category, name });
  renderCustomSections();

  const panel = document.querySelector(`.custom-section-panel[data-category="${category}"]`);
  openPanelContaining(panel);
  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
  showToast(`Seção "${name}" criada. Adicione os produtos e clique em Salvar.`);
}

function renameSection(id) {
  const section = ensureSections().find((entry) => String(entry.id) === String(id));
  if (!section) return;
  const raw = window.prompt("Novo nome da seção:", section.name);
  if (raw === null) return;
  const name = raw.trim().slice(0, 60);
  if (!name) { showToast("O nome da seção não pode ficar vazio"); return; }
  if (sectionNameTaken(name, id)) { showToast("Já existe uma seção com esse nome"); return; }
  syncItemsFromDOM();
  section.name = name;
  renderCustomSections();
  fillPromoList(currentData.promotions, currentData.items);
  showToast("Seção renomeada. Clique em Salvar para publicar.");
}

function deleteSection(id) {
  const section = ensureSections().find((entry) => String(entry.id) === String(id));
  if (!section) return;

  const usedInPromo = currentData.promotions.some((promo) => (promo.slots || []).some((slot) => slot.category === section.category))
    || [...document.querySelectorAll(".promo-admin-card .slot-category")].some((select) => select.value === section.category);
  if (usedInPromo) {
    window.alert(`A seção "${section.name}" é usada em uma promoção. Tire essa escolha da promoção (ou troque a categoria dela) antes de excluir a seção.`);
    return;
  }

  syncItemsFromDOM();
  const inside = currentData.items.filter((item) => item.category === section.category);
  const message = inside.length
    ? `Excluir a seção "${section.name}" e os ${inside.length} produto${inside.length === 1 ? "" : "s"} dentro dela? A exclusão só vale depois de clicar em Salvar (o sistema guarda um backup dos produtos).`
    : `Excluir a seção "${section.name}"?`;
  if (!window.confirm(message)) return;

  inside.forEach((item) => { newItemIds.delete(Number(item.id)); expandedItemIds.delete(Number(item.id)); });
  currentData.items = currentData.items.filter((item) => item.category !== section.category);
  currentData.sections = ensureSections().filter((entry) => String(entry.id) !== String(id));
  renderCustomSections();
  showToast("Seção excluída. Clique em Salvar para publicar.");
}

/* "+ Adicionar promoção": abre uma janelinha que pergunta primeiro o
 * TAMANHO de cada pizza (ex.: Grande + Broto) e o PREÇO das pizzas juntas.
 * Depois cria a promoção já pronta; o resto (foto, descrição, mais
 * escolhas) se edita no cartão da promoção. */
function addPromotion() {
  const sizes = currentSizeOptions();
  const overlay = document.createElement("div");
  overlay.className = "admin-modal-overlay";
  overlay.innerHTML = `
    <div class="admin-modal" role="dialog" aria-modal="true" aria-label="Nova promoção">
      <button type="button" class="admin-modal-close" aria-label="Fechar">×</button>
      <h2>Nova promoção</h2>
      <div class="field"><label>Nome da promoção (opcional)</label><input type="text" class="np-name" placeholder="Ex.: Combo Grande + Broto"></div>
      <div class="np-pizzas"></div>
      <button type="button" class="np-add-pizza">+ Adicionar outra pizza</button>
      ${sizes.length ? "" : `<p class="field-hint">Ainda não há tamanhos cadastrados (painel "Tamanhos das pizzas"). A promoção será criada sem tamanho definido.</p>`}
      <div class="field"><label>Preço das pizzas juntas (R$)</label><input type="number" min="0" step="0.5" class="np-price" placeholder="Ex.: 79.90"></div>
      <p class="np-error product-warning"></p>
      <div class="admin-modal-actions">
        <button type="button" class="np-cancel">Cancelar</button>
        <button type="button" class="np-create">Criar promoção</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const pizzasBox = overlay.querySelector(".np-pizzas");
  const sizeSelectHTML = (defaultId) => `<option value="">Sem tamanho específico</option>` + sizes
    .map((size) => `<option value="${escapeHTML(size.id)}"${String(defaultId) === size.id ? " selected" : ""}>${escapeHTML(size.name)}</option>`)
    .join("");
  const addPizzaRow = (defaultId) => {
    const row = document.createElement("div");
    row.className = "field np-pizza-row";
    const number = pizzasBox.children.length + 1;
    row.innerHTML = `<label>Tamanho da Pizza ${number}</label><div class="np-pizza-line"><select class="np-size">${sizeSelectHTML(defaultId)}</select>${number > 2 ? `<button type="button" class="np-remove-pizza" aria-label="Remover pizza">✕</button>` : ""}</div>`;
    row.querySelector(".np-remove-pizza")?.addEventListener("click", () => {
      row.remove();
      [...pizzasBox.querySelectorAll(".np-pizza-row label")].forEach((label, i) => { label.textContent = `Tamanho da Pizza ${i + 1}`; });
    });
    pizzasBox.appendChild(row);
  };
  // Começa com 2 pizzas; se já existirem tamanhos, sugere os dois maiores da lista.
  addPizzaRow(sizes.length ? sizes[Math.min(2, sizes.length - 1)].id : "");
  addPizzaRow(sizes.length ? sizes[0].id : "");
  overlay.querySelector(".np-add-pizza").addEventListener("click", () => addPizzaRow(""));

  const close = () => overlay.remove();
  overlay.querySelector(".admin-modal-close").addEventListener("click", close);
  overlay.querySelector(".np-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });

  overlay.querySelector(".np-create").addEventListener("click", () => {
    const errorEl = overlay.querySelector(".np-error");
    const priceRaw = overlay.querySelector(".np-price").value.trim();
    if (priceRaw === "" || Number.isNaN(Number(priceRaw)) || Number(priceRaw) < 0) {
      errorEl.textContent = "Digite o preço das pizzas juntas (pode ser 0).";
      overlay.querySelector(".np-price").focus();
      return;
    }
    const price = Number(priceRaw);
    const slots = [...pizzasBox.querySelectorAll(".np-size")].map((select, index) => {
      const slot = { label: `Pizza ${index + 1}`, category: "pizza" };
      const size = sizes.find((entry) => entry.id === select.value);
      if (size) { slot.size_id = Number(size.id); slot.size_name = size.name; }
      return slot;
    });
    const sizeNames = slots.map((slot) => slot.size_name).filter(Boolean);
    const typedName = overlay.querySelector(".np-name").value.trim();
    const name = typedName || (sizeNames.length === slots.length ? `Promoção ${sizeNames.join(" + ")}` : `Promoção de ${slots.length} pizzas`);

    syncAllFromDOM();   // guarda o que já foi digitado nas outras promoções antes de redesenhar
    const ids = currentData.promotions.map((p) => Number(p.id)).filter(Number.isFinite);
    const nextId = ids.length ? Math.max(...ids) + 1 : 1;
    currentData.promotions.push({ id: nextId, name, price, image: "", description: "Escolha o sabor de cada pizza. Pizzas com adicional podem aumentar o valor final.", slots });
    close();
    syncItemsFromDOM();
    fillForm(currentData);
    const card = document.querySelector(`.promo-admin-card[data-promo-id="${nextId}"]`);
    openPanelContaining(card);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast(`Promoção "${name}" criada. Clique em Salvar para publicar.`);
  });

  overlay.querySelector(".np-price").focus();
}

function removePromo(id) {
  syncAllFromDOM();
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
document.getElementById("add-section-btn")?.addEventListener("click", addSection);
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
    // Nunca descartar produto em silêncio: se a lista não carregou completa, NÃO salva.
    if (!row) throw new Error("A lista de produtos não carregou por completo. Recarregue a página (Ctrl+F5) antes de salvar.");
    const name = row.querySelector(".item-name-input").value.trim();
    if (!name) throw new Error("Todos os produtos precisam ter um nome.");
    return { ...item, name, price: parseFloat(row.querySelector(".item-price").value) || 0, promo_extra: parseFloat(row.querySelector(".item-promo-extra").value) || 0, image: item.image || "", description: row.querySelector(".item-description").value.trim(), featured: row.querySelector(".item-featured")?.checked || false };
  });

  const promotions = [...document.querySelectorAll(".promo-admin-card")].map((card) => {
    const existing = currentData.promotions.find((p) => String(p.id) === String(card.dataset.promoId));
    const slots = [...card.querySelectorAll(".promo-slot")].map((slot, index) => {
      const category = slot.querySelector(".slot-category").value;
      const out = { label: slot.querySelector(".slot-label").value.trim() || `Escolha ${index + 1}`, category };
      const sizeSelect = slot.querySelector(".slot-size");
      // O tamanho só vale para pizza. O servidor confere o id e atualiza o nome.
      if (category === "pizza" && sizeSelect && sizeSelect.value) {
        out.size_id = Number(sizeSelect.value);
        out.size_name = sizeSelect.options[sizeSelect.selectedIndex].textContent;
      }
      return out;
    });
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
    revision: currentData.revision,
    promotions,
    shifts,
    pizza_sizes,
    sections: (currentData.sections || []).map((section) => ({ id: section.id, category: section.category, name: section.name }))
  };
}

document.getElementById("save-btn").addEventListener("click", async () => {
  try {
    const payload = collectForm();
    const res = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) { let message = "O servidor recusou as alterações."; try { const result = await res.json(); message = result.error || message; } catch (_) {} throw new Error(message); }
    const saved = await res.json().catch(() => ({}));
    currentData = payload;
    Object.keys(pendingShiftPasswords).forEach((key) => delete pendingShiftPasswords[key]);
    if (Number.isInteger(saved.revision)) currentData.revision = saved.revision;
    newItemIds.clear();
    document.querySelectorAll(".item-row").forEach(updateRowSummary);
    showToast("Alterações salvas");
    loadBackups();
  } catch (error) {
    console.error(error);
    // Avisos importantes de proteção ficam na tela até a pessoa ler.
    if (/recarregue/i.test(error.message || "")) window.alert(error.message);
    else showToast(error.message || "Erro ao salvar");
  }
});

/* ---------- backups do cardápio ---------- */

const BACKUP_LABELS = { pizza: "pizzas", salgado: "salgados", bebida: "bebidas" };

async function loadBackups() {
  const box = document.getElementById("backups-list");
  if (!box) return;
  try {
    const res = await fetch("/api/admin/backups");
    if (!res.ok) return;
    const data = await res.json();
    if (!data.backups.length) {
      box.innerHTML = `<p class="field-hint">Ainda não há backups. O primeiro é criado no próximo "Salvar".</p>`;
      return;
    }
    box.innerHTML = data.backups.map((b) => {
      const parts = Object.entries(b.counts).map(([cat, n]) => `${n} ${BACKUP_LABELS[cat] || categoryLabel(cat)}`).join(" · ");
      const when = String(b.created_at).replace("T", " ").slice(0, 16);
      return `<div class="backup-row" data-id="${b.id}"><div><strong>${escapeHTML(when)}</strong><small>${escapeHTML(parts)} (${b.item_count} no total)</small></div><button type="button" class="item-toggle-all backup-restore-btn">Recuperar</button></div>`;
    }).join("");
    box.querySelectorAll(".backup-restore-btn").forEach((btn) => btn.addEventListener("click", () => restoreBackup(Number(btn.closest(".backup-row").dataset.id))));
  } catch (error) {
    console.error(error);
  }
}

async function restoreBackup(id) {
  if (!window.confirm("Recuperar os produtos que estão faltando neste backup? Nada do que já existe será apagado ou alterado. A página vai recarregar.")) return;
  try {
    const res = await fetch(`/api/admin/backups/${id}/restaurar`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { showToast(data.error || "Não foi possível recuperar"); return; }
    if (!data.count) { showToast("Nenhum produto faltando neste backup"); return; }
    showToast(`${data.count} produto${data.count === 1 ? "" : "s"} recuperado${data.count === 1 ? "" : "s"}`);
    setTimeout(() => window.location.reload(), 900);
  } catch (error) {
    console.error(error);
    showToast("Sem conexão — tente de novo");
  }
}

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

/* ---------- acesso do entregador ---------- */

async function loadCourierStatus() {
  const status = document.getElementById("courier-password-status");
  if (!status) return;
  try {
    const res = await fetch("/api/admin/entregador", { cache: "no-store" });
    const data = await res.json();
    status.textContent = data.has_password
      ? "Senha definida. Por segurança ela não é exibida: para trocar, digite uma nova e salve (quem estiver logado sai na hora)."
      : "Nenhuma senha definida — o entregador não consegue entrar até você criar uma.";
  } catch (_) {
    status.textContent = "Não foi possível verificar o estado da senha.";
  }
}

document.getElementById("courier-password-save-btn").addEventListener("click", async () => {
  const input = document.getElementById("courier-password");
  const password = input.value.trim();
  if (password.length < 4) { showToast("A senha precisa ter pelo menos 4 caracteres"); return; }
  try {
    const res = await fetch("/api/admin/entregador/senha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Não foi possível salvar a senha.");
    input.value = "";
    showToast("Senha do entregador salva");
    loadCourierStatus();
  } catch (error) {
    showToast(error.message || "Erro ao salvar a senha");
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
    const label = h2.textContent.replace("Cardápio — ", "").replace("Vendas dos funcionários", "Vendas").replace("Turnos de funcionários", "Turnos").replace("Senhas de acesso das telas", "Senhas").replace("Tamanhos das pizzas", "Tamanhos").replace("Backups do cardápio", "Backups").trim();
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

/* ---------- entregas da noite (contagem do entregador) ---------- */

function formatShiftTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function loadCourierShifts() {
  const openEl = document.getElementById("courier-open-shift");
  const tableEl = document.getElementById("courier-shifts-table");
  if (!openEl || !tableEl) return;
  try {
    const res = await fetch("/api/admin/entregas/turnos", { cache: "no-store" });
    if (res.status === 401) return;
    if (!res.ok) throw new Error("Não foi possível carregar as entregas da noite.");
    const data = await res.json();

    const forceBtn = document.getElementById("courier-shift-force-close");
    const forceHint = document.getElementById("courier-shift-force-hint");
    if (data.open) {
      openEl.innerHTML = `
        <div class="sales-stat-card sales-stat-highlight"><span>Noite em andamento — entregas até agora</span><strong>${data.open.deliveries}</strong></div>
        <div class="sales-stat-card"><span>Começou</span><strong>${escapeHTML(formatShiftTime(data.open.started_at))}</strong></div>
        <div class="sales-stat-card"><span>Taxas de entrega</span><strong>${formatPrice(data.open.fees)}</strong></div>`;
    } else {
      openEl.innerHTML = `<div class="empty-items">Nenhuma noite aberta. A contagem começa quando o entregador entrar em /entregador.</div>`;
    }
    forceBtn.style.display = data.open ? "inline-block" : "none";
    forceHint.style.display = data.open ? "block" : "none";

    if (!data.shifts.length) {
      tableEl.innerHTML = `<div class="empty-items">Nenhuma noite fechada ainda.</div>`;
      return;
    }
    const total = data.shifts.reduce((sum, sh) => sum + sh.deliveries, 0);
    tableEl.innerHTML = `<table class="sales-table">
      <thead><tr><th>Início</th><th>Fechou</th><th>Entregas</th><th>Taxas</th></tr></thead>
      <tbody>${data.shifts.map((sh) => `<tr>
        <td>${escapeHTML(formatShiftTime(sh.started_at))}</td>
        <td>${escapeHTML(formatShiftTime(sh.closed_at))}</td>
        <td><strong>${sh.deliveries}</strong></td>
        <td>${formatPrice(sh.fees)}</td>
      </tr>`).join("")}</tbody>
    </table>
    <p class="field-hint">Total das últimas ${data.shifts.length} noite(s) fechada(s): <strong>${total}</strong> entrega(s).</p>`;
  } catch (error) {
    console.error(error);
    tableEl.innerHTML = `<div class="empty-items">Erro ao carregar as entregas da noite.</div>`;
  }
}

document.getElementById("courier-shifts-refresh")?.addEventListener("click", loadCourierShifts);
document.getElementById("courier-shift-force-close")?.addEventListener("click", async () => {
  if (!window.confirm("Fechar a noite de entregas agora?\n\nA contagem atual é encerrada e guardada no histórico.")) return;
  try {
    const res = await fetch("/api/admin/entregas/turnos/fechar", { method: "POST" });
    if (res.status === 401) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) window.alert(data.error || "Não foi possível fechar a noite.");
  } catch (error) {
    console.error(error);
    window.alert("Sem conexão. Tente de novo.");
  }
  loadCourierShifts();
});

setupCropper();
initSectionNav();
initCollapsiblePanels();
initItemToolbars();
initAccessPagesLinks();
loadData();
loadBackups();
loadCourierStatus();
loadSales();
loadPedidosHistorico();
loadCourierShifts();
// Só a tabela de vendas se atualiza sozinha; o formulário do cardápio NÃO
// (senão apagaria o que você está digitando).
LiveRefresh.every(loadSales, 30000);
LiveRefresh.every(loadPedidosHistorico, 30000);
LiveRefresh.every(loadCourierShifts, 30000);
