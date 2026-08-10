"""
Servidor Flask da Rey Pizzaria.

/        -> vista do cliente
/admin   -> painel do administrador

Os dados do cardápio são armazenados em data.json.
As imagens enviadas pelo administrador são armazenadas em:
static/uploads/
"""

from flask import Flask, jsonify, request, render_template
from werkzeug.utils import secure_filename
from datetime import datetime
import json
import os
import uuid

app = Flask(__name__)

BASE_PATH = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_PATH, "data.json")
UPLOAD_FOLDER = os.path.join(BASE_PATH, "static", "uploads")

# Limite de 8 MB por arquivo enviado.
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}

os.makedirs(UPLOAD_FOLDER, exist_ok=True)


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


# ---------- páginas ----------

@app.route("/")
def cliente():
    return render_template("cliente.html")


@app.route("/admin")
def admin():
    return render_template("admin.html")


# ---------- API dos dados ----------

@app.route("/api/data", methods=["GET"])
def get_data():
    data = load_data()
    data["store"]["is_open"] = is_open_now(data["store"])
    return jsonify(data)


@app.route("/api/data", methods=["POST"])
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
    app.run(debug=True, port=5000)
