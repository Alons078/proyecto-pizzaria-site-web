/* Área do desenvolvedor (/dev): escreve os avisos que o admin vê ao entrar. */
let notices = [];
let editingId = null;

const $ = (id) => document.getElementById(id);

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

async function api(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = "/dev/login"; throw new Error("Sesión expirada"); }
  if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo completar la acción.");
  return data;
}

function updateCount() {
  $("dev-count").textContent = `${$("dev-text").value.length} / 800`;
}

function resetForm() {
  editingId = null;
  $("dev-title").value = "";
  $("dev-text").value = "";
  $("dev-active").checked = true;
  $("dev-form-title").textContent = "Nuevo aviso";
  $("dev-save-btn").textContent = "Publicar";
  $("dev-cancel-btn").hidden = true;
  updateCount();
}

function renderList() {
  const list = $("dev-list");
  list.textContent = "";
  if (!notices.length) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = "Todavía no hay avisos.";
    list.appendChild(empty);
    return;
  }
  notices.forEach((n, i) => {
    const row = document.createElement("div");
    row.className = "dev-notice" + (n.active ? "" : " is-off");

    const main = document.createElement("div");
    main.className = "dev-notice-main";
    const meta = document.createElement("p");
    meta.className = "dev-notice-meta";
    meta.textContent = `#${i + 1} · ${n.active ? "activo" : "inactivo"} · ${n.seen ? "leído por el admin" : "sin leer"}`;
    main.appendChild(meta);
    if (n.title) {
      const title = document.createElement("p");
      title.className = "dev-notice-title";
      title.textContent = n.title;
      main.appendChild(title);
    }
    const text = document.createElement("p");
    text.className = "dev-notice-text";
    text.textContent = n.text;
    main.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "dev-notice-actions";
    [
      ["Editar", () => startEdit(n)],
      [n.active ? "Desactivar" : "Activar", () => save(n.id, { title: n.title, text: n.text, active: !n.active }, n.active ? "Aviso desactivado" : "Aviso activado")],
      ["Eliminar", () => remove(n)],
    ].forEach(([label, handler]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.addEventListener("click", handler);
      actions.appendChild(btn);
    });

    row.append(main, actions);
    list.appendChild(row);
  });
}

async function load() {
  try {
    notices = (await api("/api/dev/novedades")).notices;
    renderList();
  } catch (error) {
    showToast(error.message);
  }
}

function startEdit(n) {
  editingId = n.id;
  $("dev-title").value = n.title;
  $("dev-text").value = n.text;
  $("dev-active").checked = n.active;
  $("dev-form-title").textContent = "Editando aviso";
  $("dev-save-btn").textContent = "Guardar cambios";
  $("dev-cancel-btn").hidden = false;
  updateCount();
  $("dev-form-title").scrollIntoView({ behavior: "smooth", block: "start" });
  $("dev-text").focus();
}

async function save(id, payload, okMessage) {
  try {
    await api(id ? `/api/dev/novedades/${id}` : "/api/dev/novedades", payload);
    showToast(okMessage);
    await load();
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

async function remove(n) {
  if (!confirm("¿Eliminar este aviso?")) return;
  try {
    await api(`/api/dev/novedades/${n.id}/excluir`, {});
    if (editingId === n.id) resetForm();
    showToast("Aviso eliminado");
    await load();
  } catch (error) {
    showToast(error.message);
  }
}

$("dev-text").addEventListener("input", updateCount);
$("dev-cancel-btn").addEventListener("click", resetForm);

$("dev-save-btn").addEventListener("click", async () => {
  const btn = $("dev-save-btn");
  btn.disabled = true;
  const ok = await save(
    editingId,
    { title: $("dev-title").value.trim(), text: $("dev-text").value.trim(), active: $("dev-active").checked },
    editingId ? "Cambios guardados" : "Aviso publicado",
  );
  btn.disabled = false;
  if (ok) resetForm();
});

$("dev-preview-btn").addEventListener("click", () => {
  const active = notices.filter((n) => n.active);
  if (!active.length) { showToast("No hay avisos activos para previsualizar"); return; }
  ReyNovidades.show(active);
});

$("dev-resend-btn").addEventListener("click", async () => {
  try {
    await api("/api/dev/novedades/reenviar", {});
    showToast("Listo: el admin los verá al entrar");
    await load();
  } catch (error) {
    showToast(error.message);
  }
});

load();
