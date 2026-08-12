function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(value) {
  return "R$ " + Number(value || 0).toFixed(2).replace(".", ",");
}

function showToast(message = "Venda registrada") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// ---------- login por turno ----------

async function loadTurnosSelect() {
  try {
    const res = await fetch("/api/funcionario/turnos");
    const data = await res.json();
    const select = document.getElementById("func-turno-select");
    select.innerHTML = (data.turnos || []).map((t) =>
      `<option value="${t.id}">${escapeHTML(t.label)} (${escapeHTML(t.hora_inicio)}–${escapeHTML(t.hora_fim)})</option>`
    ).join("");
  } catch (error) {
    console.error(error);
  }
}

async function initAuth() {
  await loadTurnosSelect();
  try {
    const res = await fetch("/api/funcionario/session");
    const data = await res.json();
    if (data.authenticated) {
      showApp(data.turno_label);
    } else {
      showLoginGate();
    }
  } catch (error) {
    console.error(error);
    showLoginGate();
  }
}

function showLoginGate() {
  document.getElementById("func-login-gate").style.display = "flex";
  document.getElementById("func-app").style.display = "none";
  document.getElementById("func-login-password").focus();
}

function showApp(turnoLabel) {
  document.getElementById("func-login-gate").style.display = "none";
  document.getElementById("func-app").style.display = "";
  document.getElementById("func-turno-label").textContent = turnoLabel || "";
  loadCardapio();
}

async function attemptLogin() {
  const turno_id = document.getElementById("func-turno-select").value;
  const password = document.getElementById("func-login-password").value;
  const errorEl = document.getElementById("func-login-error");
  errorEl.textContent = "";

  try {
    const res = await fetch("/api/funcionario/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turno_id, password }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) {
      errorEl.textContent = result.error || "Senha incorreta.";
      return;
    }
    document.getElementById("func-login-password").value = "";
    showApp(result.turno_label);
  } catch (error) {
    console.error(error);
    errorEl.textContent = "Erro ao entrar. Tente novamente.";
  }
}

document.getElementById("func-login-btn").addEventListener("click", attemptLogin);
document.getElementById("func-login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptLogin();
});

document.getElementById("func-logout-btn").addEventListener("click", async () => {
  try {
    await fetch("/api/funcionario/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  }
  location.reload();
});

// ---------- cardápio e registro de vendas ----------

const SECTION_MAP = {
  pizza: "func-pizzas-list",
  salgado: "func-salgados-list",
  bebida: "func-bebidas-list",
};

async function loadCardapio() {
  try {
    const res = await fetch("/api/funcionario/cardapio");
    if (res.status === 401) { showLoginGate(); return; }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    renderCardapio(data.items);
  } catch (error) {
    console.error(error);
    showToast("Erro ao carregar o cardápio");
  }
}

function renderCardapio(items) {
  ["pizza", "salgado", "bebida"].forEach((category) => {
    const container = document.getElementById(SECTION_MAP[category]);
    const list = items.filter((i) => i.category === category);

    if (!list.length) {
      container.innerHTML = "<p class=\"panel-help\">Nenhum item nesta categoria.</p>";
      return;
    }

    container.innerHTML = list.map((item) => {
      const stockInfo = item.tracked
        ? `<span class="func-stock ${item.quantity <= 0 ? "func-stock-zero" : ""}">restam ${item.quantity}</span>`
        : "";

      const deliverySelect = category === "pizza"
        ? `
          <select class="func-delivery-select">
            <option value="retirada">Retirada</option>
            <option value="mesa">Mesa</option>
            <option value="entrega">Entrega</option>
          </select>
        `
        : "";

      const disabled = item.tracked && item.quantity <= 0 ? "disabled" : "";

      return `
        <div class="func-item-row" data-item-id="${item.id}" data-tracked="${item.tracked}">
          <div class="func-item-info">
            <span class="func-item-name">${escapeHTML(item.name)}</span>
            <span class="func-item-price">${fmtMoney(item.price)}</span>
            ${stockInfo}
          </div>
          <div class="func-item-controls">
            ${deliverySelect}
            <input type="number" class="func-qty-input" min="1" step="1" value="1">
            <button type="button" class="save-btn func-register-btn" ${disabled}>Registrar</button>
          </div>
        </div>
      `;
    }).join("");
  });

  document.querySelectorAll(".func-register-btn").forEach((btn) => {
    btn.addEventListener("click", () => registerSale(btn));
  });
}

async function registerSale(btn) {
  const row = btn.closest(".func-item-row");
  const item_id = row.dataset.itemId;
  const quantity = Number(row.querySelector(".func-qty-input").value) || 1;
  const deliverySelect = row.querySelector(".func-delivery-select");
  const delivery_type = deliverySelect ? deliverySelect.value : undefined;

  btn.disabled = true;
  try {
    const res = await fetch("/api/funcionario/venda", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id, quantity, delivery_type }),
    });
    const result = await res.json();
    if (res.status === 401) { showLoginGate(); return; }
    if (!res.ok || !result.ok) throw new Error(result.error);
    showToast("Venda registrada");
    loadCardapio();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Erro ao registrar a venda");
    btn.disabled = false;
  }
}

initAuth();
