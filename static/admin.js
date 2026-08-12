let currentData = null;

async function loadData() {
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error("Não foi possível carregar os dados.");
    currentData = await res.json();
    currentData.promotions = Array.isArray(currentData.promotions) ? currentData.promotions : [];
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
  document.getElementById("hour-open").value = store.hours.open;
  document.getElementById("hour-close").value = store.hours.close;
  document.getElementById("store-address").value = store.address;
  setImagePreview("store-logo-preview", store.logo);
  setImagePreview("post-image-preview", today_post.image);
  setStatusButton(store.force_status);
  document.getElementById("post-title").value = today_post.title;
  document.getElementById("post-text").value = today_post.text;
  fillPromoList(data.promotions, items);
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

function fillItemList(elementId, list) {
  const container = document.getElementById(elementId);
  if (!list.length) {
    container.innerHTML = `<div class="empty-items">Nenhum produto cadastrado.</div>`;
    return;
  }
  container.innerHTML = list.map((item) => `
    <div class="item-row" data-id="${escapeHTML(item.id)}">
      <div class="field item-name-field"><label>Nome</label><input type="text" class="item-name-input" value="${escapeHTML(item.name)}" placeholder="Nome do produto"></div>
      <div class="field"><label>Preço (R$)</label><input type="number" min="0" step="0.5" class="item-price" value="${escapeHTML(item.price)}"></div>
      <div class="field"><label>Extra em promoções (R$)</label><input type="number" min="0" step="0.5" class="item-promo-extra" value="${escapeHTML(item.promo_extra || 0)}"><small>Valor somado quando este produto for escolhido numa promoção.</small></div>
      <div class="field item-image-field"><label>Imagem do produto</label><input type="file" class="item-image-file" accept="image/png,image/jpeg,image/webp,image/gif"><div class="image-preview item-image-preview">${item.image ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">` : `<span>Nenhuma imagem</span>`}</div></div>
      <div class="field item-description-field"><label>Comentário / descrição</label><textarea class="item-description" placeholder="Ex.: Molho de tomate, mussarela e manjericão">${escapeHTML(item.description || "")}</textarea></div>
      <button type="button" class="delete-item-btn" data-id="${escapeHTML(item.id)}">Excluir produto</button>
    </div>`).join("");

  container.querySelectorAll(".delete-item-btn").forEach((button) => button.addEventListener("click", () => removeItem(Number(button.dataset.id))));
  container.querySelectorAll(".item-image-file").forEach((input) => input.addEventListener("change", async () => {
    const row = input.closest(".item-row");
    const id = Number(row.dataset.id);
    await handleSingleImageUpload(input, (url) => {
      const item = currentData.items.find((entry) => Number(entry.id) === id);
      if (item) item.image = url;
    }, null, 4 / 3, "image/jpeg");
    const item = currentData.items.find((entry) => Number(entry.id) === id);
    if (item?.image) row.querySelector(".item-image-preview").innerHTML = `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">`;
  }));
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

function addItem(category) {
  const ids = currentData.items.map((item) => Number(item.id)).filter(Number.isFinite);
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  currentData.items.push({ id: nextId, category, name: "Novo produto", price: 0, promo_extra: 0, image: "", description: "" });
  fillForm(currentData);
  const sectionMap = { pizza: "pizzas-list", salgado: "salgados-list", bebida: "bebidas-list" };
  const row = document.getElementById(sectionMap[category]).querySelector(`.item-row[data-id="${nextId}"]`);
  row?.scrollIntoView({ behavior: "smooth", block: "center" });
  row?.querySelector(".item-name-input")?.focus();
  row?.querySelector(".item-name-input")?.select();
}

function removeItem(id) {
  const item = currentData.items.find((entry) => Number(entry.id) === Number(id));
  if (!item || !window.confirm(`Excluir "${item.name}" do cardápio?`)) return;
  currentData.items = currentData.items.filter((entry) => Number(entry.id) !== Number(id));
  fillForm(currentData);
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
    return { ...item, name, price: parseFloat(row.querySelector(".item-price").value) || 0, promo_extra: parseFloat(row.querySelector(".item-promo-extra").value) || 0, image: item.image || "", description: row.querySelector(".item-description").value.trim() };
  }).filter(Boolean);

  const promotions = [...document.querySelectorAll(".promo-admin-card")].map((card) => {
    const existing = currentData.promotions.find((p) => String(p.id) === String(card.dataset.promoId));
    const slots = [...card.querySelectorAll(".promo-slot")].map((slot, index) => ({ label: slot.querySelector(".slot-label").value.trim() || `Escolha ${index + 1}`, category: slot.querySelector(".slot-category").value }));
    if (!slots.length) throw new Error(`A promoção "${card.querySelector(".promo-name").value.trim()}" precisa ter pelo menos uma escolha.`);
    return { ...existing, name: card.querySelector(".promo-name").value.trim(), price: parseFloat(card.querySelector(".promo-price").value) || 0, image: existing?.image || "", description: card.querySelector(".promo-description").value.trim(), slots };
  });

  return {
    store: { ...currentData.store, hours: { open: document.getElementById("hour-open").value.trim(), close: document.getElementById("hour-close").value.trim() }, force_status, address: document.getElementById("store-address").value.trim(), logo: currentData.store.logo || "" },
    today_post: { title: document.getElementById("post-title").value.trim(), text: document.getElementById("post-text").value.trim(), image: currentData.today_post.image || "" },
    items,
    promotions
  };
}

document.getElementById("save-btn").addEventListener("click", async () => {
  try {
    const payload = collectForm();
    const res = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) { let message = "O servidor recusou as alterações."; try { const result = await res.json(); message = result.error || message; } catch (_) {} throw new Error(message); }
    currentData = payload;
    showToast("Alterações salvas");
  } catch (error) { console.error(error); showToast(error.message || "Erro ao salvar"); }
});

function showToast(message = "Alterações salvas") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

setupCropper();
initAdminAuth();

// ---------- autenticação do administrador ----------

async function initAdminAuth() {
  try {
    const res = await fetch("/api/admin/session");
    const data = await res.json();
    if (data.authenticated) {
      showAdminApp();
    } else {
      showLoginGate();
    }
  } catch (error) {
    console.error(error);
    showLoginGate();
  }
}

function showLoginGate() {
  document.getElementById("admin-login-gate").style.display = "flex";
  document.getElementById("admin-app").style.display = "none";
  document.getElementById("admin-login-password").focus();
}

function showAdminApp() {
  document.getElementById("admin-login-gate").style.display = "none";
  document.getElementById("admin-app").style.display = "";
  loadData();
  loadTurnos();
}

async function attemptAdminLogin() {
  const password = document.getElementById("admin-login-password").value;
  const errorEl = document.getElementById("admin-login-error");
  errorEl.textContent = "";
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) {
      errorEl.textContent = result.error || "Senha incorreta.";
      return;
    }
    document.getElementById("admin-login-password").value = "";
    showAdminApp();
  } catch (error) {
    console.error(error);
    errorEl.textContent = "Erro ao entrar. Tente novamente.";
  }
}

document.getElementById("admin-login-btn").addEventListener("click", attemptAdminLogin);
document.getElementById("admin-login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptAdminLogin();
});

document.getElementById("admin-logout-btn").addEventListener("click", async () => {
  try {
    await fetch("/api/admin/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  }
  location.reload();
});

document.getElementById("change-pass-btn").addEventListener("click", async () => {
  const current_password = document.getElementById("change-pass-current").value;
  const new_password = document.getElementById("change-pass-new").value;
  try {
    const res = await fetch("/api/admin/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password, new_password }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error);
    document.getElementById("change-pass-current").value = "";
    document.getElementById("change-pass-new").value = "";
    showToast("Senha alterada");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Erro ao alterar a senha");
  }
});

// ---------- turnos dos funcionários ----------

let currentTurnos = [];

async function loadTurnos() {
  try {
    const res = await fetch("/api/admin/turnos");
    const data = await res.json();
    currentTurnos = data.turnos || [];
    renderTurnos();
  } catch (error) {
    console.error(error);
    showToast("Erro ao carregar os turnos");
  }
}

function renderTurnos() {
  const list = document.getElementById("turnos-list");
  list.innerHTML = "";

  currentTurnos.forEach((turno) => {
    const card = document.createElement("div");
    card.className = "promo-admin-card turno-card";
    card.dataset.turnoId = turno.id;
    card.innerHTML = `
      <div class="row">
        <div class="field">
          <label>Nome do turno</label>
          <input type="text" class="turno-label" value="${escapeHTML(turno.label)}">
        </div>
        <div class="field">
          <label>Início</label>
          <input type="text" class="turno-inicio" value="${escapeHTML(turno.hora_inicio)}" placeholder="18:00">
        </div>
        <div class="field">
          <label>Fim</label>
          <input type="text" class="turno-fim" value="${escapeHTML(turno.hora_fim)}" placeholder="20:00">
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>Nova senha (deixe em branco para manter a atual)</label>
          <input type="password" class="turno-password" autocomplete="new-password">
        </div>
      </div>
      <div class="turno-card-actions">
        <button type="button" class="crop-secondary turno-save-btn">Salvar turno</button>
        <button type="button" class="delete-item-btn turno-delete-btn">Excluir turno</button>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll(".turno-save-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".turno-card");
      const id = card.dataset.turnoId;
      const label = card.querySelector(".turno-label").value.trim();
      const hora_inicio = card.querySelector(".turno-inicio").value.trim();
      const hora_fim = card.querySelector(".turno-fim").value.trim();
      const password = card.querySelector(".turno-password").value.trim();

      try {
        const res = await fetch(`/api/admin/turnos/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, hora_inicio, hora_fim, password }),
        });
        const result = await res.json();
        if (!res.ok || !result.ok) throw new Error(result.error);
        showToast("Turno salvo");
        loadTurnos();
      } catch (error) {
        console.error(error);
        showToast(error.message || "Erro ao salvar o turno");
      }
    });
  });

  list.querySelectorAll(".turno-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".turno-card");
      const id = card.dataset.turnoId;
      if (!confirm("Excluir este turno? Os funcionários não poderão mais usar a senha dele.")) return;
      try {
        const res = await fetch(`/api/admin/turnos/${id}`, { method: "DELETE" });
        const result = await res.json();
        if (!res.ok || !result.ok) throw new Error(result.error);
        loadTurnos();
      } catch (error) {
        console.error(error);
        showToast(error.message || "Erro ao excluir o turno");
      }
    });
  });
}

document.getElementById("add-turno-btn").addEventListener("click", async () => {
  const label = prompt("Nome do turno (ex.: Turno da tarde):", "Novo turno");
  if (!label) return;
  const hora_inicio = prompt("Horário de início (ex.: 18:00):", "18:00") || "18:00";
  const hora_fim = prompt("Horário de fim (ex.: 20:00):", "20:00") || "20:00";
  const password = prompt("Senha deste turno (mínimo 4 caracteres):");
  if (!password || password.trim().length < 4) {
    showToast("A senha precisa ter pelo menos 4 caracteres");
    return;
  }

  try {
    const res = await fetch("/api/admin/turnos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, hora_inicio, hora_fim, password: password.trim() }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error);
    showToast("Turno adicionado");
    loadTurnos();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Erro ao adicionar o turno");
  }
});
