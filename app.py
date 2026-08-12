"""
Servidor Flask da Rey Pizzaria.

/              -> vista do cliente
/admin         -> painel do administrador (protegido por senha)
/admin/vendas  -> registro de vendas e estatísticas (protegido por senha)
/funcionarios  -> página dos funcionários (protegida por senha do turno)

Os dados do cardápio são armazenados em data.json (público).
Senhas, turnos, vendas e estoque são armazenados em pizzaria.db (SQLite, privado).
As imagens enviadas pelo administrador são armazenadas em:
static/uploads/
"""

from functools import wraps
from flask import Flask, jsonify, request, render_template, session
from werkzeug.utils import secure_filename
from datetime import datetime
import json
import os
import uuid

import db

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "troque-esta-chave-em-producao-" + uuid.uuid4().hex)

BASE_PATH = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_PATH, "data.json")
UPLOAD_FOLDER = os.path.join(BASE_PATH, "static", "uploads")

# Limite de 8 MB por arquivo enviado.
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
db.init_db()


def load_data():
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


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


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("is_admin"):
            return jsonify({"ok": False, "error": "Não autenticado."}), 401
        return view(*args, **kwargs)
    return wrapped


def funcionario_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("func_turno_id"):
            return jsonify({"ok": False, "error": "Não autenticado."}), 401
        return view(*args, **kwargs)
    return wrapped


# ---------- páginas ----------

@app.route("/")
def cliente():
    return render_template("cliente.html")


@app.route("/admin")
def admin():
    return render_template("admin.html")


@app.route("/admin/vendas")
def admin_vendas_page():
    return render_template("admin_vendas.html")


@app.route("/funcionarios")
def funcionarios_page():
    return render_template("funcionarios.html")


# ---------- autenticação do administrador ----------

@app.route("/api/admin/session", methods=["GET"])
def admin_session():
    return jsonify({"authenticated": bool(session.get("is_admin"))})


@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    body = request.get_json(silent=True) or {}
    password = body.get("password", "")
    if db.check_admin_password(password):
        session["is_admin"] = True
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Senha incorreta."}), 401


@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("is_admin", None)
    return jsonify({"ok": True})


@app.route("/api/admin/change-password", methods=["POST"])
@admin_required
def admin_change_password():
    body = request.get_json(silent=True) or {}
    current = body.get("current_password", "")
    new_password = (body.get("new_password") or "").strip()

    if not db.check_admin_password(current):
        return jsonify({"ok": False, "error": "Senha atual incorreta."}), 400
    if len(new_password) < 4:
        return jsonify({"ok": False, "error": "A nova senha precisa ter pelo menos 4 caracteres."}), 400

    db.set_admin_password(new_password)
    return jsonify({"ok": True})


# ---------- API dos dados do cardápio (pública para o cliente) ----------

@app.route("/api/data", methods=["GET"])
def get_data():
    data = load_data()
    data["store"]["is_open"] = is_open_now(data["store"])
    return jsonify(data)


@app.route("/api/data", methods=["POST"])
@admin_required
def update_data():
    """Recebe o objeto completo enviado pelo administrador e salva no data.json."""
    new_data = request.get_json()

    if not isinstance(new_data, dict):
        return jsonify({"ok": False, "error": "Dados inválidos."}), 400

    if "store" not in new_data or "today_post" not in new_data or "items" not in new_data:
        return jsonify({"ok": False, "error": "Estrutura de dados incompleta."}), 400

    if "promotions" not in new_data or not isinstance(new_data["promotions"], list):
        new_data["promotions"] = []

    for item in new_data["items"]:
        item.setdefault("promo_extra", 0)

    for promo in new_data["promotions"]:
        if not isinstance(promo, dict) or not promo.get("name"):
            return jsonify({"ok": False, "error": "Existe uma promoção inválida."}), 400
        if not isinstance(promo.get("slots", []), list) or not promo.get("slots"):
            return jsonify({"ok": False, "error": f'A promoção "{promo.get("name", "")}" precisa ter pelo menos uma escolha.'}), 400

    save_data(new_data)
    return jsonify({"ok": True})


# ---------- upload de imagens ----------

@app.route("/api/upload-image", methods=["POST"])
@admin_required
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


# ---------- turnos (admin) ----------

@app.route("/api/admin/turnos", methods=["GET"])
@admin_required
def list_turnos():
    return jsonify({"ok": True, "turnos": db.list_turnos()})


@app.route("/api/admin/turnos", methods=["POST"])
@admin_required
def create_turno():
    body = request.get_json(silent=True) or {}
    label = (body.get("label") or "").strip()
    hora_inicio = (body.get("hora_inicio") or "").strip()
    hora_fim = (body.get("hora_fim") or "").strip()
    password = (body.get("password") or "").strip()

    if not label or not hora_inicio or not hora_fim or not password:
        return jsonify({"ok": False, "error": "Preencha turno, horários e senha."}), 400
    if len(password) < 4:
        return jsonify({"ok": False, "error": "A senha do turno precisa ter pelo menos 4 caracteres."}), 400

    new_id = db.create_turno(label, hora_inicio, hora_fim, password)
    return jsonify({"ok": True, "id": new_id})


@app.route("/api/admin/turnos/<int:turno_id>", methods=["PUT"])
@admin_required
def update_turno(turno_id):
    body = request.get_json(silent=True) or {}
    label = (body.get("label") or "").strip()
    hora_inicio = (body.get("hora_inicio") or "").strip()
    hora_fim = (body.get("hora_fim") or "").strip()
    password = (body.get("password") or "").strip() or None

    if not label or not hora_inicio or not hora_fim:
        return jsonify({"ok": False, "error": "Preencha turno e horários."}), 400
    if password and len(password) < 4:
        return jsonify({"ok": False, "error": "A senha do turno precisa ter pelo menos 4 caracteres."}), 400

    db.update_turno(turno_id, label, hora_inicio, hora_fim, password)
    return jsonify({"ok": True})


@app.route("/api/admin/turnos/<int:turno_id>", methods=["DELETE"])
@admin_required
def delete_turno(turno_id):
    db.delete_turno(turno_id)
    return jsonify({"ok": True})


# ---------- estoque (admin) ----------

@app.route("/api/admin/estoque", methods=["GET"])
@admin_required
def get_estoque():
    data = load_data()
    stock_map = db.get_stock_map()
    items = []
    for item in data["items"]:
        item_id = int(item["id"])
        info = stock_map.get(item_id, {"quantity": 0, "tracked": False})
        items.append({
            "id": item_id,
            "name": item["name"],
            "category": item["category"],
            "tracked": info["tracked"],
            "quantity": info["quantity"],
        })
    return jsonify({"ok": True, "items": items})


@app.route("/api/admin/estoque", methods=["POST"])
@admin_required
def set_estoque():
    body = request.get_json(silent=True) or {}
    items = body.get("items", [])
    if not isinstance(items, list):
        return jsonify({"ok": False, "error": "Dados inválidos."}), 400

    for entry in items:
        item_id = int(entry.get("id"))
        tracked = bool(entry.get("tracked"))
        quantity = int(entry.get("quantity") or 0)
        db.set_stock(item_id, quantity, tracked)

    return jsonify({"ok": True})


# ---------- relatório de vendas (admin) ----------

@app.route("/api/admin/vendas/resumo", methods=["GET"])
@admin_required
def vendas_resumo():
    period = request.args.get("period", "today")
    if period not in ("today", "week"):
        period = "today"
    return jsonify({"ok": True, "resumo": db.sales_summary(period)})


# ---------- funcionários ----------

@app.route("/api/funcionario/turnos", methods=["GET"])
def funcionario_list_turnos():
    """Lista pública apenas com nome e horário dos turnos (sem senha) para o funcionário escolher."""
    return jsonify({"ok": True, "turnos": db.list_turnos()})


@app.route("/api/funcionario/session", methods=["GET"])
def funcionario_session():
    if session.get("func_turno_id"):
        return jsonify({"authenticated": True, "turno_label": session.get("func_turno_label")})
    return jsonify({"authenticated": False})


@app.route("/api/funcionario/login", methods=["POST"])
def funcionario_login():
    body = request.get_json(silent=True) or {}
    turno_id = body.get("turno_id")
    password = body.get("password", "")

    if not turno_id:
        return jsonify({"ok": False, "error": "Selecione o turno."}), 400

    ok, label = db.check_turno_password(int(turno_id), password)
    if not ok:
        return jsonify({"ok": False, "error": "Senha incorreta para este turno."}), 401

    session["func_turno_id"] = int(turno_id)
    session["func_turno_label"] = label
    return jsonify({"ok": True, "turno_label": label})


@app.route("/api/funcionario/logout", methods=["POST"])
def funcionario_logout():
    session.pop("func_turno_id", None)
    session.pop("func_turno_label", None)
    return jsonify({"ok": True})


@app.route("/api/funcionario/cardapio", methods=["GET"])
@funcionario_required
def funcionario_cardapio():
    data = load_data()
    stock_map = db.get_stock_map()
    items = []
    for item in data["items"]:
        item_id = int(item["id"])
        info = stock_map.get(item_id, {"quantity": 0, "tracked": False})
        items.append({
            "id": item_id,
            "name": item["name"],
            "category": item["category"],
            "price": item["price"],
            "tracked": info["tracked"],
            "quantity": info["quantity"],
        })
    return jsonify({"ok": True, "items": items, "turno_label": session.get("func_turno_label")})


@app.route("/api/funcionario/venda", methods=["POST"])
@funcionario_required
def funcionario_venda():
    body = request.get_json(silent=True) or {}
    item_id = body.get("item_id")
    quantity = int(body.get("quantity") or 0)
    delivery_type = body.get("delivery_type")

    if not item_id or quantity <= 0:
        return jsonify({"ok": False, "error": "Escolha um item e uma quantidade válida."}), 400

    data = load_data()
    item = next((i for i in data["items"] if int(i["id"]) == int(item_id)), None)
    if not item:
        return jsonify({"ok": False, "error": "Item não encontrado."}), 404

    if item["category"] == "pizza" and delivery_type not in ("retirada", "mesa", "entrega"):
        return jsonify({"ok": False, "error": "Escolha o tipo de entrega da pizza."}), 400
    if item["category"] != "pizza":
        delivery_type = None

    ok, error = db.decrement_stock(int(item_id), quantity)
    if not ok:
        return jsonify({"ok": False, "error": error}), 400

    db.register_sale(
        turno_id=session.get("func_turno_id"),
        turno_label=session.get("func_turno_label"),
        item_id=int(item_id),
        item_name=item["name"],
        category=item["category"],
        quantity=quantity,
        unit_price=item["price"],
        delivery_type=delivery_type,
    )

    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=False, port=5000)
