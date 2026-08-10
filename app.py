"""
Servidor Flask da Rey Pizzaria.

/              -> vista do cliente (pública)
/admin         -> painel do administrador (requer senha)
/funcionarios  -> registro de vendas por turno (requer senha do turno)

Os dados do cardápio, promoções, turnos e vendas são armazenados em data.json.
As imagens enviadas pelo administrador são armazenadas em:
static/uploads/

Variáveis de ambiente usadas em produção (configure-as no Render):
- ADMIN_PASSWORD  -> senha do painel /admin (padrão inseguro: "admin123")
- SECRET_KEY      -> chave para assinar os cookies de sessão
- PORT            -> porta em que o servidor escuta (o Render define sozinho)
- FLASK_DEBUG     -> "1" para ligar o modo debug (deixe desligado em produção)
"""

from flask import Flask, jsonify, request, render_template, session, redirect, url_for
from werkzeug.utils import secure_filename
from datetime import datetime, timedelta
from functools import wraps
import json
import os
import uuid
import hmac
import secrets

app = Flask(__name__)

BASE_PATH = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_PATH, "data.json")
UPLOAD_FOLDER = os.path.join(BASE_PATH, "static", "uploads")

# Limite de 8 MB por arquivo enviado.
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(16))

if not os.environ.get("ADMIN_PASSWORD"):
    print("AVISO: a variável de ambiente ADMIN_PASSWORD não foi definida — "
          "usando a senha padrão 'admin123'. Defina ADMIN_PASSWORD no Render antes de divulgar o site.")
if not os.environ.get("SECRET_KEY"):
    print("AVISO: a variável de ambiente SECRET_KEY não foi definida — "
          "as sessões (login) serão invalidadas sempre que o servidor reiniciar.")

os.makedirs(UPLOAD_FOLDER, exist_ok=True)


def load_data():
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("promotions", [])
    data.setdefault("shifts", [])
    data.setdefault("sales", [])
    return data


def save_data(data):
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def is_allowed_image(filename):
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS
    )


def is_open_now(store):
    """Decide se a loja está aberta pelo horário ou pelo status forçado."""
    if store.get("force_status") is not None:
        return store["force_status"]

    now = datetime.now().strftime("%H:%M")
    return store["hours"]["open"] <= now <= store["hours"]["close"]


def require_admin(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("is_admin"):
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Sessão de administrador expirada. Entre novamente."}), 401
            return redirect(url_for("admin_login"))
        return view(*args, **kwargs)
    return wrapped


def require_employee(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("shift_id"):
            return jsonify({"ok": False, "error": "Sessão do turno expirada. Entre novamente com a senha do turno."}), 401
        return view(*args, **kwargs)
    return wrapped


# ---------- páginas ----------

@app.route("/")
def cliente():
    return render_template("cliente.html")


@app.route("/admin/login", methods=["GET"])
def admin_login():
    if session.get("is_admin"):
        return redirect(url_for("admin"))
    return render_template("admin_login.html", error=None)


@app.route("/admin/login", methods=["POST"])
def admin_login_submit():
    password = (request.form.get("password") or "").strip()
    if password and hmac.compare_digest(password, ADMIN_PASSWORD):
        session["is_admin"] = True
        return redirect(url_for("admin"))
    return render_template("admin_login.html", error="Senha incorreta."), 401


@app.route("/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("is_admin", None)
    return redirect(url_for("admin_login"))


@app.route("/admin")
@require_admin
def admin():
    return render_template("admin.html")


@app.route("/funcionarios")
def funcionarios():
    return render_template("funcionarios.html")


# ---------- API pública (vista do cliente) ----------

@app.route("/api/data", methods=["GET"])
def get_data():
    """Dados públicos para a vista do cliente. Não inclui turnos, senhas nem vendas."""
    data = load_data()
    data["store"]["is_open"] = is_open_now(data["store"])
    public = {
        "store": data["store"],
        "today_post": data["today_post"],
        "items": data["items"],
        "promotions": data["promotions"],
    }
    return jsonify(public)


# ---------- API do administrador ----------

@app.route("/api/admin/data", methods=["GET"])
@require_admin
def get_admin_data():
    data = load_data()
    data["store"]["is_open"] = is_open_now(data["store"])
    admin_view = {
        "store": data["store"],
        "today_post": data["today_post"],
        "items": data["items"],
        "promotions": data["promotions"],
        "shifts": data["shifts"],
    }
    return jsonify(admin_view)


@app.route("/api/data", methods=["POST"])
@require_admin
def update_data():
    """Recebe o objeto completo enviado pelo administrador e salva no data.json."""
    new_data = request.get_json(silent=True)

    if not isinstance(new_data, dict):
        return jsonify({"ok": False, "error": "Dados inválidos."}), 400

    if "store" not in new_data or "today_post" not in new_data or "items" not in new_data:
        return jsonify({"ok": False, "error": "Estrutura de dados incompleta."}), 400

    if "promotions" not in new_data or not isinstance(new_data["promotions"], list):
        new_data["promotions"] = []

    if "shifts" not in new_data or not isinstance(new_data["shifts"], list):
        new_data["shifts"] = []

    for item in new_data["items"]:
        item.setdefault("promo_extra", 0)

    for promo in new_data["promotions"]:
        if not isinstance(promo, dict) or not promo.get("name"):
            return jsonify({"ok": False, "error": "Existe uma promoção inválida."}), 400
        if not isinstance(promo.get("slots", []), list) or not promo.get("slots"):
            return jsonify({"ok": False, "error": f'A promoção "{promo.get("name", "")}" precisa ter pelo menos uma escolha.'}), 400

    seen_passwords = set()
    for shift in new_data["shifts"]:
        if not isinstance(shift, dict) or not shift.get("name"):
            return jsonify({"ok": False, "error": "Existe um turno sem nome."}), 400
        password = str(shift.get("password") or "").strip()
        if not password:
            return jsonify({"ok": False, "error": f'O turno "{shift.get("name")}" precisa ter uma senha.'}), 400
        if password in seen_passwords:
            return jsonify({"ok": False, "error": "Dois turnos não podem usar a mesma senha."}), 400
        seen_passwords.add(password)
        shift["password"] = password

    # A lista de vendas é gerenciada só pelas rotas de funcionários,
    # nunca é sobrescrita a partir do painel do admin.
    existing = load_data()
    new_data["sales"] = existing["sales"]

    save_data(new_data)
    return jsonify({"ok": True})


@app.route("/api/admin/sales", methods=["GET"])
@require_admin
def admin_sales():
    data = load_data()
    sales = data["sales"]

    total_geral = round(sum(float(s.get("total", 0)) for s in sales), 2)

    by_shift = {}
    for s in sales:
        key = s.get("shift_name") or "Turno removido"
        by_shift[key] = round(by_shift.get(key, 0) + float(s.get("total", 0)), 2)

    week_ago = datetime.now() - timedelta(days=7)
    total_semana = 0.0
    for s in sales:
        try:
            ts = datetime.fromisoformat(s.get("timestamp", ""))
        except ValueError:
            continue
        if ts >= week_ago:
            total_semana += float(s.get("total", 0))
    total_semana = round(total_semana, 2)

    recent = sorted(sales, key=lambda s: s.get("timestamp", ""), reverse=True)[:80]

    return jsonify({
        "ok": True,
        "shifts": data["shifts"],
        "sales": recent,
        "stats": {
            "total_geral": total_geral,
            "total_semana": total_semana,
            "by_shift": by_shift,
        },
    })


# ---------- API dos funcionários ----------

@app.route("/api/employee/login", methods=["POST"])
def employee_login():
    body = request.get_json(silent=True) or {}
    password = str(body.get("password") or "").strip()
    if not password:
        return jsonify({"ok": False, "error": "Digite a senha do turno."}), 400

    data = load_data()
    for shift in data["shifts"]:
        shift_password = str(shift.get("password") or "")
        if shift_password and hmac.compare_digest(shift_password, password):
            session["shift_id"] = shift["id"]
            session["shift_name"] = shift.get("name", "")
            return jsonify({"ok": True, "shift": {"id": shift["id"], "name": shift.get("name", "")}})

    return jsonify({"ok": False, "error": "Senha incorreta."}), 401


@app.route("/api/employee/logout", methods=["POST"])
def employee_logout():
    session.pop("shift_id", None)
    session.pop("shift_name", None)
    return jsonify({"ok": True})


@app.route("/api/employee/session", methods=["GET"])
def employee_session():
    if not session.get("shift_id"):
        return jsonify({"ok": False})
    data = load_data()
    return jsonify({
        "ok": True,
        "shift": {"id": session["shift_id"], "name": session.get("shift_name", "")},
        "items": data["items"],
    })


@app.route("/api/employee/sale", methods=["POST"])
@require_employee
def register_sale():
    body = request.get_json(silent=True) or {}
    cart = body.get("items")
    if not isinstance(cart, list) or not cart:
        return jsonify({"ok": False, "error": "Adicione pelo menos um produto à venda."}), 400

    data = load_data()
    items_by_id = {}
    for entry in data["items"]:
        try:
            items_by_id[int(entry["id"])] = entry
        except (TypeError, ValueError, KeyError):
            continue

    sale_items = []
    total = 0.0
    for entry in cart:
        try:
            item_id = int(entry.get("item_id"))
            qty = int(entry.get("qty"))
        except (TypeError, ValueError, AttributeError):
            return jsonify({"ok": False, "error": "Item de venda inválido."}), 400
        if qty <= 0:
            continue
        item = items_by_id.get(item_id)
        if not item:
            return jsonify({"ok": False, "error": "Um dos produtos não foi encontrado no cardápio."}), 400
        price = float(item.get("price") or 0)
        subtotal = round(price * qty, 2)
        sale_items.append({
            "item_id": item_id,
            "name": item.get("name", ""),
            "qty": qty,
            "price": price,
            "subtotal": subtotal,
        })
        total += subtotal

    if not sale_items:
        return jsonify({"ok": False, "error": "Adicione pelo menos um produto à venda."}), 400

    sales = data["sales"]
    sale_ids = [int(s.get("id", 0)) for s in sales if str(s.get("id", "")).isdigit()]
    next_id = max(sale_ids) + 1 if sale_ids else 1

    sale = {
        "id": next_id,
        "shift_id": session.get("shift_id"),
        "shift_name": session.get("shift_name", ""),
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "items": sale_items,
        "total": round(total, 2),
    }
    sales.append(sale)
    save_data(data)
    return jsonify({"ok": True, "sale": sale})


# ---------- upload de imagens (somente admin) ----------

@app.route("/api/upload-image", methods=["POST"])
@require_admin
def upload_image():
    """Recebe uma imagem do computador e salva em static/uploads/."""
    if "image" not in request.files:
        return jsonify({"ok": False, "error": "Nenhuma imagem foi enviada."}), 400

    file = request.files["image"]

    if not file or not file.filename:
        return jsonify({"ok": False, "error": "Nenhuma imagem foi selecionada."}), 400

    if not is_allowed_image(file.filename):
        return jsonify({
            "ok": False,
            "error": "Formato não permitido. Use PNG, JPG, JPEG, WEBP ou GIF."
        }), 400

    extension = secure_filename(file.filename).rsplit(".", 1)[1].lower()
    filename = f"{uuid.uuid4().hex}.{extension}"
    destination = os.path.join(UPLOAD_FOLDER, filename)

    file.save(destination)

    return jsonify({
        "ok": True,
        "url": f"/static/uploads/{filename}",
        "filename": filename
    })


@app.errorhandler(413)
def file_too_large(error):
    return jsonify({
        "ok": False,
        "error": "A imagem é muito grande. O limite é 8 MB."
    }), 413


if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
