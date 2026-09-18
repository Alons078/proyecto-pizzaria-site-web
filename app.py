"""
Servidor Flask da Rey Pizzaria.

/              -> vista do cliente (pública)
/admin         -> painel do administrador (requer senha)
/funcionarios  -> registro de vendas por turno (requer senha do turno)

Os dados do cardápio, promoções, turnos e vendas são armazenados em um banco
SQLite (pizzaria.db), pelo módulo db.py. Isso evita que duas vendas ao mesmo
tempo corrompam os dados, coisa que podia acontecer com o antigo data.json.
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
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
from functools import wraps
import os
import uuid
import hmac
import secrets

import db


def _is_password_hash(value):
    """Detecta si un valor ya es un hash de Werkzeug (pbkdf2/scrypt)."""
    if not value or not isinstance(value, str):
        return False
    return value.startswith("pbkdf2:") or value.startswith("scrypt:")


def hash_shift_password(plain):
    """Hashea una contraseña de turno. Si ya es un hash, la deja igual."""
    plain = str(plain or "").strip()
    if not plain:
        return plain
    if _is_password_hash(plain):
        return plain
    return generate_password_hash(plain)


def check_shift_password(stored, plain):
    """Compara contraseña de turno. Acepta hashes nuevos y texto plano antiguo (migración)."""
    stored = str(stored or "")
    plain = str(plain or "")
    if not stored or not plain:
        return False
    if _is_password_hash(stored):
        return check_password_hash(stored, plain)
    # Compatibilidad: turnos guardados antes del hash (texto plano)
    return hmac.compare_digest(stored, plain)


app = Flask(__name__)

BASE_PATH = os.path.dirname(os.path.abspath(__file__))
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


db.init_db()


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


def require_print_agent(view):
    """Protege as rotas que o programinha da impressora térmica usa.
    Ele não faz login como o admin; manda o token num cabeçalho."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        data = db.load_data()
        expected = (data["store"].get("print_agent_token") or "").strip()
        sent = (request.headers.get("X-Print-Token") or "").strip()
        if not expected or not sent or not hmac.compare_digest(sent, expected):
            return jsonify({"ok": False, "error": "Token do agente de impressão inválido ou não configurado."}), 401
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


@app.route("/produto/<int:item_id>")
def produto(item_id):
    data = db.load_data()
    item = next((i for i in data["items"] if int(i["id"]) == item_id), None)
    if not item:
        return redirect(url_for("cliente"))
    return render_template("produto.html", item_id=item_id)


@app.route("/promocao/<int:promo_id>")
def promocao(promo_id):
    data = db.load_data()
    promo = next((p for p in data["promotions"] if int(p["id"]) == promo_id), None)
    if not promo:
        return redirect(url_for("cliente"))
    return render_template("promocao.html", promo_id=promo_id)


@app.route("/carrinho")
def carrinho():
    return render_template("carrinho.html")


# ---------- API pública (vista do cliente) ----------

@app.route("/api/data", methods=["GET"])
def get_data():
    """Dados públicos para a vista do cliente. Não inclui turnos, senhas nem vendas."""
    data = db.load_data()
    data["store"]["is_open"] = is_open_now(data["store"])
    public = {
        "store": data["store"],
        "today_post": data["today_post"],
        "items": data["items"],
        "promotions": data["promotions"],
        "pizza_sizes": data["pizza_sizes"],
    }
    return jsonify(public)


@app.route("/api/item/<int:item_id>", methods=["GET"])
def get_item(item_id):
    """Dados públicos de um único produto, para a página de detalhe."""
    data = db.load_data()
    item = next((i for i in data["items"] if int(i["id"]) == item_id), None)
    if not item:
        return jsonify({"ok": False, "error": "Produto não encontrado."}), 404
    return jsonify({
        "ok": True,
        "item": item,
        "pizza_sizes": data["pizza_sizes"] if item.get("category") == "pizza" else [],
        "store": {"whatsapp_number": data["store"].get("whatsapp_number", "")},
    })


@app.route("/api/promotion/<int:promo_id>", methods=["GET"])
def get_promotion(promo_id):
    """Dados públicos de uma única promoção, para a página de detalhe."""
    data = db.load_data()
    promo = next((p for p in data["promotions"] if int(p["id"]) == promo_id), None)
    if not promo:
        return jsonify({"ok": False, "error": "Promoção não encontrada."}), 404
    return jsonify({
        "ok": True,
        "promotion": promo,
        "items": data["items"],
        "store": {"whatsapp_number": data["store"].get("whatsapp_number", "")},
    })


# ---------- pedidos do cliente (fila de impressão térmica) ----------

MAX_ORDER_ITEMS = 40


@app.route("/api/pedidos", methods=["POST"])
def create_order():
    """O carrinho do cliente manda o pedido pra cá antes de abrir o
    WhatsApp, só para que o agente de impressão da pizzaria possa
    imprimir o ticket. Não precisa de login — é o mesmo pedido que o
    cliente já vai mandar por WhatsApp de qualquer forma."""
    body = request.get_json(silent=True) or {}
    cart = body.get("items")
    if not isinstance(cart, list) or not cart or len(cart) > MAX_ORDER_ITEMS:
        return jsonify({"ok": False, "error": "Carrinho inválido."}), 400

    order_items = []
    total = 0.0
    for entry in cart:
        if not isinstance(entry, dict):
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400
        try:
            qty = int(entry.get("qty"))
            unit_price = float(entry.get("unit_price"))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400
        if qty <= 0 or qty > 500 or unit_price < 0:
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400
        name = str(entry.get("name") or "")[:200]
        order_items.append({"name": name, "qty": qty, "unit_price": round(unit_price, 2)})
        total += unit_price * qty

    if not order_items:
        return jsonify({"ok": False, "error": "Carrinho vazio."}), 400

    payment_method = str(body.get("payment_method") or "")[:60]

    troco_paid_with = None
    troco_amount = None
    raw_troco = body.get("troco_paid_with")
    if raw_troco is not None and payment_method == "Dinheiro":
        try:
            troco_paid_with = round(float(raw_troco), 2)
        except (TypeError, ValueError):
            troco_paid_with = None
        # Se o valor não cobre o total do pedido, não faz sentido como
        # "troco para" — trata como se não tivesse sido informado, em vez
        # de guardar um troco inválido (ex.: negativo).
        if troco_paid_with is not None and troco_paid_with < total:
            troco_paid_with = None
        if troco_paid_with is not None:
            troco_amount = round(troco_paid_with - total, 2)

    order = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "customer_name": str(body.get("customer_name") or "")[:120],
        "delivery_type": str(body.get("delivery_type") or "")[:60],
        "address": str(body.get("address") or "")[:300],
        "payment_method": payment_method,
        "notes": str(body.get("notes") or "")[:500],
        "items": order_items,
        "total": round(total, 2),
        "troco_paid_with": troco_paid_with,
        "troco_amount": troco_amount,
    }
    order_id = db.insert_order(order)
    return jsonify({"ok": True, "order_id": order_id})


@app.route("/api/pedidos/pendentes", methods=["GET"])
@require_print_agent
def pending_orders():
    """Usado pelo programinha da impressora, que fica perguntando aqui
    de tempos em tempos se chegou pedido novo."""
    return jsonify({"ok": True, "orders": db.list_pending_orders()})


@app.route("/api/pedidos/<int:order_id>/impresso", methods=["POST"])
@require_print_agent
def order_printed(order_id):
    """O programinha avisa aqui depois de imprimir com sucesso, para o
    pedido não ser impresso de novo."""
    marked = db.mark_order_printed(order_id)
    if not marked:
        return jsonify({"ok": False, "error": "Pedido não encontrado ou já estava marcado como impresso."}), 404
    return jsonify({"ok": True})


# ---------- API do administrador ----------

@app.route("/api/admin/data", methods=["GET"])
@require_admin
def get_admin_data():
    data = db.load_data()
    data["store"]["is_open"] = is_open_now(data["store"])
    # No devolver hashes ni contraseñas reales al navegador.
    # El admin solo ve un marcador; si no cambia el campo, se conserva la anterior.
    safe_shifts = []
    for shift in data.get("shifts", []):
        safe_shifts.append({
            "id": shift["id"],
            "name": shift.get("name", ""),
            "password": "__unchanged__" if shift.get("password") else "",
            "has_password": bool(shift.get("password")),
        })
    admin_view = {
        "store": data["store"],
        "today_post": data["today_post"],
        "items": data["items"],
        "promotions": data["promotions"],
        "shifts": safe_shifts,
        "pizza_sizes": data["pizza_sizes"],
    }
    return jsonify(admin_view)


@app.route("/api/data", methods=["POST"])
@require_admin
def update_data():
    """Recebe o objeto completo enviado pelo administrador e salva no banco."""
    new_data = request.get_json(silent=True)

    if not isinstance(new_data, dict):
        return jsonify({"ok": False, "error": "Dados inválidos."}), 400

    if "store" not in new_data or "today_post" not in new_data or "items" not in new_data:
        return jsonify({"ok": False, "error": "Estrutura de dados incompleta."}), 400

    if "promotions" not in new_data or not isinstance(new_data["promotions"], list):
        new_data["promotions"] = []

    if "shifts" not in new_data or not isinstance(new_data["shifts"], list):
        new_data["shifts"] = []

    if "pizza_sizes" not in new_data or not isinstance(new_data["pizza_sizes"], list):
        new_data["pizza_sizes"] = []

    for size in new_data["pizza_sizes"]:
        if not isinstance(size, dict) or not str(size.get("name") or "").strip():
            return jsonify({"ok": False, "error": "Existe um tamanho de pizza sem nome."}), 400
        try:
            float(size.get("price", 0))
            int(size.get("cm", 0) or 0)
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": f'O tamanho "{size.get("name")}" tem preço ou centímetros inválidos.'}), 400

    for item in new_data["items"]:
        item.setdefault("promo_extra", 0)

    for promo in new_data["promotions"]:
        if not isinstance(promo, dict) or not promo.get("name"):
            return jsonify({"ok": False, "error": "Existe uma promoção inválida."}), 400
        if not isinstance(promo.get("slots", []), list) or not promo.get("slots"):
            return jsonify({"ok": False, "error": f'A promoção "{promo.get("name", "")}" precisa ter pelo menos uma escolha.'}), 400

    # Contraseñas de turnos: se hashean antes de guardar.
    # Si el admin deja el campo vacío o con el marcador "__unchanged__",
    # se conserva el hash anterior (no se puede "ver" la contraseña).
    existing_data = db.load_data()
    existing_by_id = {str(s["id"]): s for s in existing_data.get("shifts", [])}

    for shift in new_data["shifts"]:
        if not isinstance(shift, dict) or not shift.get("name"):
            return jsonify({"ok": False, "error": "Existe um turno sem nome."}), 400
        password = str(shift.get("password") or "").strip()
        old = existing_by_id.get(str(shift.get("id")))
        if not password or password == "__unchanged__":
            if old and old.get("password"):
                shift["password"] = old["password"]
            else:
                return jsonify({"ok": False, "error": f'O turno "{shift.get("name")}" precisa ter uma senha.'}), 400
        else:
            shift["password"] = hash_shift_password(password)

    # save_menu_data nunca mexe na tabela de vendas: elas só são gravadas
    # pela rota de funcionários (insert_sale), uma de cada vez.
    db.save_menu_data(new_data)
    return jsonify({"ok": True})


@app.route("/api/admin/print-token/regenerate", methods=["POST"])
@require_admin
def regenerate_print_token():
    """Gera um novo token para o agente de impressão. Depois de gerar,
    é preciso atualizar esse mesmo valor no arquivo de configuração do
    programinha que roda no computador da pizzaria (imprimir_agent.py)."""
    token = secrets.token_hex(16)
    db.set_print_agent_token(token)
    return jsonify({"ok": True, "token": token})


@app.route("/api/admin/sales", methods=["GET"])
@require_admin
def admin_sales():
    data = db.load_data()
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

    data = db.load_data()
    for shift in data["shifts"]:
        shift_password = str(shift.get("password") or "")
        if shift_password and check_shift_password(shift_password, password):
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
    data = db.load_data()
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

    data = db.load_data()
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

    sale = {
        "shift_id": session.get("shift_id"),
        "shift_name": session.get("shift_name", ""),
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "items": sale_items,
        "total": round(total, 2),
    }
    # insert_sale grava só esta venda (uma linha), sem tocar no resto dos
    # dados — é essa a mudança que evita que vendas simultâneas se atropelem.
    sale["id"] = db.insert_sale(sale)
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
