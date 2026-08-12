let currentPeriod = "today";

function fmtMoney(value) {
  return "R$ " + Number(value || 0).toFixed(2).replace(".", ",");
}

const DELIVERY_LABELS = {
  retirada: "Retirada",
  mesa: "Mesa",
  entrega: "Entrega",
  "não informado": "Não informado",
};

const CATEGORY_LABELS = {
  pizza: "Pizzas",
  salgado: "Salgados",
  bebida: "Bebidas",
};

async function loadResumo() {
  try {
    const res = await fetch(`/api/admin/vendas/resumo?period=${currentPeriod}`);
    if (res.status === 401) { showLoginGate(); return; }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    renderResumo(data.resumo);
  } catch (error) {
    console.error(error);
    showToast("Erro ao carregar o resumo de vendas");
  }
}

function renderResumo(resumo) {
  document.getElementById("vendas-totais").innerHTML = `
    <div class="vendas-total-card">
      <span class="vendas-total-label">Total vendido</span>
      <strong class="vendas-total-value">${fmtMoney(resumo.total)}</strong>
      <span class="vendas-total-sub">${resumo.quantidade} itens vendidos</span>
    </div>
  `;

  const porTurno = document.getElementById("vendas-por-turno");
  if (!resumo.por_turno.length) {
    porTurno.innerHTML = "<p class=\"panel-help\">Nenhuma venda registrada neste período.</p>";
  } else {
    porTurno.innerHTML = resumo.por_turno.map((t) => `
      <div class="vendas-row">
        <span>${escapeHTML(t.turno_label || "Turno não identificado")}</span>
        <span>${t.qty} itens — ${fmtMoney(t.total)}</span>
      </div>
    `).join("");
  }

  const pizzasEntrega = document.getElementById("vendas-pizzas-entrega");
  if (!resumo.pizzas_por_entrega.length) {
    pizzasEntrega.innerHTML = "<p class=\"panel-help\">Nenhuma pizza vendida neste período.</p>";
  } else {
    pizzasEntrega.innerHTML = resumo.pizzas_por_entrega.map((p) => `
      <div class="vendas-row">
        <span>${DELIVERY_LABELS[p.delivery_type] || escapeHTML(p.delivery_type)}</span>
        <span>${p.qty} pizzas</span>
      </div>
    `).join("");
  }

  const porCategoria = document.getElementById("vendas-por-categoria");
  if (!resumo.por_categoria.length) {
    porCategoria.innerHTML = "<p class=\"panel-help\">Sem dados para este período.</p>";
  } else {
    porCategoria.innerHTML = resumo.por_categoria.map((c) => `
      <div class="vendas-row">
        <span>${CATEGORY_LABELS[c.category] || escapeHTML(c.category)}</span>
        <span>${c.qty} itens — ${fmtMoney(c.total)}</span>
      </div>
    `).join("");
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.querySelectorAll("#period-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#period-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentPeriod = btn.dataset.period;
    loadResumo();
  });
});

// ---------- estoque ----------

let currentEstoque = [];

async function loadEstoque() {
  try {
    const res = await fetch("/api/admin/estoque");
    if (res.status === 401) { showLoginGate(); return; }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    currentEstoque = data.items;
    renderEstoque();
  } catch (error) {
    console.error(error);
    showToast("Erro ao carregar o estoque");
  }
}

function renderEstoque() {
  const list = document.getElementById("estoque-list");
  if (!currentEstoque.length) {
    list.innerHTML = "<p class=\"panel-help\">Nenhum item no cardápio ainda.</p>";
    return;
  }
  list.innerHTML = currentEstoque.map((item) => `
    <div class="estoque-row" data-item-id="${item.id}">
      <span class="estoque-name">${escapeHTML(item.name)} <small>(${CATEGORY_LABELS[item.category] || item.category})</small></span>
      <label class="estoque-tracked">
        <input type="checkbox" class="estoque-tracked-input" ${item.tracked ? "checked" : ""}>
        controlar estoque
      </label>
      <input type="number" class="estoque-qty-input" min="0" step="1" value="${item.quantity}" ${item.tracked ? "" : "disabled"}>
    </div>
  `).join("");

  list.querySelectorAll(".estoque-tracked-input").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const qtyInput = checkbox.closest(".estoque-row").querySelector(".estoque-qty-input");
      qtyInput.disabled = !checkbox.checked;
    });
  });
}

document.getElementById("estoque-save-btn").addEventListener("click", async () => {
  const items = [...document.querySelectorAll(".estoque-row")].map((row) => ({
    id: Number(row.dataset.itemId),
    tracked: row.querySelector(".estoque-tracked-input").checked,
    quantity: Number(row.querySelector(".estoque-qty-input").value) || 0,
  }));

  try {
    const res = await fetch("/api/admin/estoque", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error);
    showToast("Estoque salvo");
    loadEstoque();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Erro ao salvar o estoque");
  }
});

function showToast(message = "Alterações salvas") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// ---------- autenticação ----------

async function initAuth() {
  try {
    const res = await fetch("/api/admin/session");
    const data = await res.json();
    if (data.authenticated) {
      showApp();
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

function showApp() {
  document.getElementById("admin-login-gate").style.display = "none";
  document.getElementById("admin-app").style.display = "";
  loadResumo();
  loadEstoque();
}

async function attemptLogin() {
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
    showApp();
  } catch (error) {
    console.error(error);
    errorEl.textContent = "Erro ao entrar. Tente novamente.";
  }
}

document.getElementById("admin-login-btn").addEventListener("click", attemptLogin);
document.getElementById("admin-login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptLogin();
});

document.getElementById("admin-logout-btn").addEventListener("click", async () => {
  try {
    await fetch("/api/admin/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  }
  location.reload();
});

initAuth();
