let posItems = [];
let cart = {}; // item_id -> qty

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

function showToast(message = "Venda registrada") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function showLoginError(message) {
  const el = document.getElementById("pos-login-error");
  if (!message) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.style.display = "block";
}

async function checkSession() {
  try {
    const res = await fetch("/api/employee/session");
    const data = await res.json();
    if (data.ok) {
      showPosPanel(data.shift, data.items);
    } else {
      showLoginPanel();
    }
  } catch (error) {
    console.error(error);
    showLoginPanel();
  }
}

function showLoginPanel() {
  document.getElementById("pos-login").style.display = "block";
  document.getElementById("pos-panel").style.display = "none";
}

function showPosPanel(shift, items) {
  document.getElementById("pos-login").style.display = "none";
  document.getElementById("pos-panel").style.display = "block";
  document.getElementById("pos-shift-name").textContent = shift.name || "Turno";
  posItems = items || [];
  cart = {};
  renderPosGrid();
  updateCartTotal();
}

function categoryLabel(category) {
  return { pizza: "Pizzas", salgado: "Salgados", bebida: "Bebidas" }[category] || category;
}

function renderPosGrid() {
  const grid = document.getElementById("pos-grid");
  const categories = ["pizza", "salgado", "bebida"];
  grid.innerHTML = categories.map((category) => {
    const items = posItems.filter((item) => item.category === category);
    if (!items.length) return "";
    const cards = items.map((item) => `
      <div class="pos-card">
        <div class="pos-card-name">${escapeHTML(item.name)}</div>
        <div class="pos-card-price">${formatPrice(item.price)}</div>
        <div class="pos-stepper">
          <button type="button" class="pos-step-btn" data-action="minus" data-id="${item.id}">−</button>
          <span class="pos-qty" id="pos-qty-${item.id}">0</span>
          <button type="button" class="pos-step-btn" data-action="plus" data-id="${item.id}">+</button>
        </div>
      </div>`).join("");
    return `<div class="pos-category">
      <h3 class="pos-category-title">${categoryLabel(category)}</h3>
      <div class="pos-category-grid">${cards}</div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".pos-step-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const current = cart[id] || 0;
      const next = btn.dataset.action === "plus" ? current + 1 : Math.max(0, current - 1);
      cart[id] = next;
      document.getElementById(`pos-qty-${id}`).textContent = String(next);
      updateCartTotal();
    });
  });
}

function updateCartTotal() {
  let total = 0;
  Object.entries(cart).forEach(([id, qty]) => {
    if (qty <= 0) return;
    const item = posItems.find((i) => Number(i.id) === Number(id));
    if (item) total += Number(item.price || 0) * qty;
  });
  document.getElementById("pos-cart-total").textContent = formatPrice(total);
}

document.getElementById("pos-login-btn").addEventListener("click", async () => {
  const password = document.getElementById("pos-password").value.trim();
  if (!password) {
    showLoginError("Digite a senha do turno.");
    return;
  }
  try {
    const res = await fetch("/api/employee/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showLoginError(data.error || "Senha incorreta.");
      return;
    }
    showLoginError(null);
    document.getElementById("pos-password").value = "";
    await checkSession();
  } catch (error) {
    console.error(error);
    showLoginError("Não foi possível entrar. Tente novamente.");
  }
});

document.getElementById("pos-password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") document.getElementById("pos-login-btn").click();
});

document.getElementById("pos-logout-btn").addEventListener("click", async () => {
  try {
    await fetch("/api/employee/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  }
  cart = {};
  showLoginPanel();
});

document.getElementById("pos-register-btn").addEventListener("click", async () => {
  const items = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([item_id, qty]) => ({ item_id: Number(item_id), qty }));

  if (!items.length) {
    showToast("Adicione pelo menos um produto");
    return;
  }

  try {
    const res = await fetch("/api/employee/sale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showToast(data.error || "Erro ao registrar a venda");
      if (res.status === 401) showLoginPanel();
      return;
    }
    cart = {};
    renderPosGrid();
    updateCartTotal();
    showToast(`Venda registrada: ${formatPrice(data.sale.total)}`);
  } catch (error) {
    console.error(error);
    showToast("Erro ao registrar a venda");
  }
});

checkSession();
