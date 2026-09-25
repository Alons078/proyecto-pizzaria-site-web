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
- ADMIN_PASSWORD  -> senha do painel /admin (OBRIGATÓRIA: sem ela o painel fica bloqueado)
- SECRET_KEY      -> chave para assinar os cookies de sessão
- PORT            -> porta em que o servidor escuta (o Render define sozinho)
- FLASK_DEBUG     -> "1" para ligar o modo debug (deixe desligado em produção)
- PIZZERIA_LAT, PIZZERIA_LON -> coordenadas da pizzaria (taxa de entrega automática)
- FEE_RADIUS_KM, FEE_BASE, FEE_EXTRA, MAX_DELIVERY_KM -> regra da taxa (veja geocoding.py)
"""

from flask import Flask, jsonify, request, render_template, session, redirect, url_for
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from functools import wraps
import os
import uuid
import hashlib
import hmac
import secrets

import db
import geocoding


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
BUNDLED_UPLOAD_FOLDER = os.path.join(BASE_PATH, "static", "uploads")
# Fotos novas vão para o disco persistente (DATA_DIR/uploads); sem DATA_DIR,
# continuam em static/uploads como antes.
UPLOAD_FOLDER = (
    os.path.join(db.DATA_DIR, "uploads")
    if db.DATA_DIR != BASE_PATH
    else BUNDLED_UPLOAD_FOLDER
)

# Limite de 8 MB por arquivo enviado.
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(16))

if not ADMIN_PASSWORD:
    print("AVISO: a variável de ambiente ADMIN_PASSWORD não foi definida — "
          "o painel /admin ficará bloqueado. Defina ADMIN_PASSWORD no Render.")
if not os.environ.get("SECRET_KEY"):
    print("AVISO: a variável de ambiente SECRET_KEY não foi definida — "
          "as sessões (login) serão invalidadas sempre que o servidor reiniciar.")

if not geocoding.is_configured():
    print("AVISO: PIZZERIA_LAT / PIZZERIA_LON não definidos — a taxa de entrega "
          "automática fica desligada (o pedido segue com 'taxa a combinar').")

os.makedirs(UPLOAD_FOLDER, exist_ok=True)


@app.route("/static/uploads/<path:filename>")
def serve_upload(filename):
    """Serve as fotos: primeiro do disco persistente e, se não achar, das
    fotos que já vêm junto com o projeto (as antigas continuam funcionando)."""
    from flask import send_from_directory
    path = os.path.join(UPLOAD_FOLDER, filename)
    if os.path.isfile(path):
        return send_from_directory(UPLOAD_FOLDER, filename)
    return send_from_directory(BUNDLED_UPLOAD_FOLDER, filename)


db.init_db()


def is_allowed_image(filename):
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS
    )


FUSO_LOJA = ZoneInfo("America/Sao_Paulo")


def is_open_now(store):
    """Decide se a loja está aberta pelo horário ou pelo status forçado.

    Importante: usamos sempre o horário de Río de Janeiro (America/Sao_Paulo),
    não o horário do servidor. O Render roda os containers em UTC, então sem
    isso a loja fechava (e abria) 3 horas antes do horário configurado."""
    if store.get("force_status") is not None:
        return store["force_status"]

    now = datetime.now(FUSO_LOJA).strftime("%H:%M")
    hours = store["hours"]
    if hours["open"] <= hours["close"]:
        # Caso normal: não cruza a meia-noite (ej. 18:00 - 23:00).
        return hours["open"] <= now <= hours["close"]
    # Caso em que o fechamento é depois da meia-noite (ej. 18:00 - 01:00).
    return now >= hours["open"] or now <= hours["close"]


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


def require_kitchen(view):
    """Painel da cozinha: entra quem está logado como admin OU com a senha
    de um turno (a mesma que os funcionários já usam em /funcionarios)."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not (session.get("is_admin") or session.get("shift_id")):
            return jsonify({"ok": False, "error": "Entre com a senha do turno para ver os pedidos."}), 401
        return view(*args, **kwargs)
    return wrapped


def _courier_fingerprint(stored_hash):
    """Identificador curto da senha atual do entregador. Vai dentro da sessão:
    quando o admin troca a senha, o valor muda e a sessão antiga deixa de valer."""
    return hashlib.sha256(str(stored_hash or "").encode("utf-8")).hexdigest()[:16]


def require_courier(view):
    """Painel do entregador: entra quem fez login com a SENHA DO ENTREGADOR
    (sessão própria, que não abre cozinha nem funcionários) ou o admin. A senha
    de turno NÃO serve aqui, e a do entregador NÃO serve nas outras telas."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if session.get("is_admin"):
            return view(*args, **kwargs)
        stored = db.get_courier_password()
        if not stored or session.get("courier_pw") != _courier_fingerprint(stored):
            return jsonify({"ok": False, "error": "Entre com a senha do entregador."}), 401
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
    if ADMIN_PASSWORD and password and hmac.compare_digest(password, ADMIN_PASSWORD):
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


@app.route("/cozinha")
def cozinha():
    return render_template("cozinha.html")


@app.route("/pedido/<token>")
def acompanhar_pedido(token):
    return render_template("pedido.html")


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
    # O token do agente de impressão é uma senha: nunca vai para o público.
    public_store = {k: v for k, v in data["store"].items() if k != "print_agent_token"}
    public = {
        "store": public_store,
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
        "store": {
            "whatsapp_number": data["store"].get("whatsapp_number", ""),
            "bordas": data["store"].get("bordas", []),
        },
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
        "store": {
            "whatsapp_number": data["store"].get("whatsapp_number", ""),
            "bordas": data["store"].get("bordas", []),
        },
    })


# ---------- taxa de entrega por distância ----------

@app.route("/api/calcular-tarifa", methods=["POST"])
def calcular_tarifa():
    """Recebe {address} e devolve {fee, distance_km, cached}. Endereços já
    consultados saem do cache; os novos passam pela fila do Nominatim (1 req/s)
    e por isso podem levar alguns segundos."""
    body = request.get_json(silent=True) or {}
    try:
        result = geocoding.calculate_fee(body.get("address"))
    except geocoding.GeocodingError as exc:
        payload = {"ok": False, "code": exc.code, "error": exc.message}
        payload.update(exc.extra)
        return jsonify(payload), exc.status
    return jsonify({"ok": True, **result})


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
            # Quantas pizzas tem em UMA unidade desta linha (0 para bebida/salgado,
            # 1 para uma pizza normal, 2 para uma promoção de "2 pizzas" etc.).
            # Usado só para o resumo "pizzas vendidas por tipo de entrega" do admin.
            pizza_count = int(entry.get("pizza_count") or 0)
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400
        if qty <= 0 or qty > 500 or unit_price < 0 or pizza_count < 0 or pizza_count > 20:
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400
        name = str(entry.get("name") or "")[:200]
        order_items.append({"name": name, "qty": qty, "unit_price": round(unit_price, 2), "pizza_count": pizza_count})
        total += unit_price * qty

    if not order_items:
        return jsonify({"ok": False, "error": "Carrinho vazio."}), 400

    delivery_type = str(body.get("delivery_type") or "")[:60]
    address = str(body.get("address") or "")[:300]

    # Taxa de entrega: o servidor a busca no cache de geocodificação (que o
    # próprio cliente acabou de preencher ao calcular a taxa). Não aceitamos
    # o valor vindo do navegador, senão qualquer um mandaria taxa = 0.
    # Sem taxa em cache -> None ("a combinar" pelo WhatsApp).
    delivery_fee = None
    if delivery_type == "Entrega (delivery)":
        delivery_fee = geocoding.lookup_cached_fee(address)
        if delivery_fee is not None:
            total += delivery_fee

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
        "customer_phone": str(body.get("customer_phone") or "")[:30],
        "delivery_type": delivery_type,
        "address": address,
        "payment_method": payment_method,
        "notes": str(body.get("notes") or "")[:500],
        "items": order_items,
        "total": round(total, 2),
        "troco_paid_with": troco_paid_with,
        "troco_amount": troco_amount,
        "delivery_fee": delivery_fee,
        # Código secreto (impossível de adivinhar) para o cliente acompanhar
        # o pedido em /pedido/<código> sem precisar de login.
        "track_token": secrets.token_urlsafe(12),
    }
    order_id = db.insert_order(order)
    return jsonify({"ok": True, "order_id": order_id, "track_token": order["track_token"]})


# ---------- etapas do pedido: cozinha e acompanhamento do cliente ----------

@app.route("/api/pedido/<token>", methods=["GET"])
def track_order(token):
    """Público (quem tem o código secreto vê). Não devolve endereço nem
    dados de pagamento — só o necessário para mostrar a barra de progresso."""
    order = db.get_order_by_token(token)
    if not order:
        return jsonify({"ok": False, "error": "Pedido não encontrado."}), 404
    return jsonify({
        "ok": True,
        "order": {
            "id": order["id"],
            "customer_name": order["customer_name"],
            "delivery_type": order["delivery_type"],
            "is_delivery": order["delivery_type"] == db.DELIVERY_TYPE_VALUE,
            "items": order["items"],
            "total": order["total"],
            "created_at": order["created_at"],
            "stage": order["stage"],
            "stage_updated_at": order["stage_updated_at"],
            "can_cancel": order["stage"] == "confirmado",
        },
    })


@app.route("/meus-pedidos")
def meus_pedidos():
    return render_template("meus_pedidos.html")


CANCEL_TOO_LATE_MESSAGE = (
    "A cozinha já começou a preparar este pedido, então não dá mais para cancelar por aqui. "
    "Se precisar, fale com a pizzaria."
)


@app.route("/api/pedido/<token>/cancelar", methods=["POST"])
def customer_cancel_order(token):
    """O cliente cancela o próprio pedido (quem tem o código secreto). Só
    funciona enquanto a cozinha ainda não iniciou o preparo."""
    order = db.get_order_by_token(token)
    if not order:
        return jsonify({"ok": False, "error": "Pedido não encontrado."}), 404
    if order["stage"] == "cancelado":
        return jsonify({"ok": True})
    if not db.cancel_order_by_token(token):
        return jsonify({"ok": False, "error": CANCEL_TOO_LATE_MESSAGE}), 409
    return jsonify({"ok": True})


@app.route("/api/meus-pedidos", methods=["POST"])
def my_orders():
    """'Meus pedidos': o navegador do cliente guarda os códigos dos pedidos
    que ele fez e manda a lista para cá. Não existe login de cliente — só
    quem tem o código secreto de um pedido consegue ver aquele pedido."""
    body = request.get_json(silent=True) or {}
    tokens = body.get("tokens")
    if not isinstance(tokens, list):
        return jsonify({"ok": False, "error": "Lista inválida."}), 400
    now = datetime.now()
    result = []
    for token in tokens[:20]:
        order = db.get_order_by_token(str(token))
        if not order:
            continue
        try:
            age_min = max(0, int((now - datetime.fromisoformat(order["created_at"])).total_seconds() // 60))
        except (TypeError, ValueError):
            age_min = None
        result.append({
            "token": str(token),
            "id": order["id"],
            "delivery_type": order["delivery_type"],
            "is_delivery": order["delivery_type"] == db.DELIVERY_TYPE_VALUE,
            "items": order["items"],
            "total": order["total"],
            "stage": order["stage"],
            "can_cancel": order["stage"] == "confirmado",
            "age_min": age_min,
        })
    result.sort(key=lambda o: o["id"], reverse=True)
    return jsonify({"ok": True, "orders": result})


@app.route("/api/cozinha/pedidos", methods=["GET"])
@require_kitchen
def kitchen_orders():
    orders = db.list_kitchen_orders()
    now = datetime.now()
    for order in orders:
        order["is_delivery"] = order["delivery_type"] == db.DELIVERY_TYPE_VALUE
        # Minutos desde que o pedido chegou (calculado no servidor, pra não
        # depender do fuso horário do navegador).
        try:
            order["age_min"] = max(0, int((now - datetime.fromisoformat(order["created_at"])).total_seconds() // 60))
        except (TypeError, ValueError):
            order["age_min"] = None
    return jsonify({"ok": True, "orders": orders})


@app.route("/api/cozinha/pedidos/<int:order_id>/avancar", methods=["POST"])
@require_kitchen
def kitchen_advance_order(order_id):
    body = request.get_json(silent=True) or {}
    expected = str(body.get("from_stage") or "")
    if expected not in db.ORDER_STAGES:
        return jsonify({"ok": False, "error": "Etapa inválida."}), 400
    updated = db.advance_order_stage(order_id, expected)
    if not updated:
        return jsonify({"ok": False, "error": "Esse pedido já mudou de etapa. Atualizando a lista..."}), 409
    updated["is_delivery"] = updated["delivery_type"] == db.DELIVERY_TYPE_VALUE
    return jsonify({"ok": True, "order": updated})


# ---------- entregador: pedidos em rota + confirmar entrega ----------

@app.route("/entregador")
def entregador():
    return render_template("entregador.html")


@app.route("/api/entregador/login", methods=["POST"])
def courier_login():
    """Login do entregador, com a senha que o admin define em /admin
    ("Acesso do entregador"). Não usa a senha dos turnos."""
    body = request.get_json(silent=True) or {}
    password = str(body.get("password") or "").strip()
    if not password:
        return jsonify({"ok": False, "error": "Digite a senha do entregador."}), 400
    stored = db.get_courier_password()
    if not stored:
        return jsonify({"ok": False, "error": "A senha do entregador ainda não foi definida. Peça ao administrador."}), 403
    if not check_shift_password(stored, password):
        return jsonify({"ok": False, "error": "Senha incorreta."}), 401
    session["courier_pw"] = _courier_fingerprint(stored)
    session.permanent = True  # o celular não deve pedir a senha de novo a cada vez que fechar o navegador
    return jsonify({"ok": True})


@app.route("/api/entregador/logout", methods=["POST"])
def courier_logout():
    session.pop("courier_pw", None)
    return jsonify({"ok": True})


@app.route("/api/entregador/pedidos", methods=["GET"])
@require_courier
def courier_orders():
    """Pedidos de ENTREGA que já saíram da cozinha (etapa 'em_rota'), do mais
    antigo para o mais novo. Retirada nunca aparece aqui."""
    now = datetime.now()
    orders = []
    for order in db.list_kitchen_orders():
        if order["stage"] != "em_rota" or order["delivery_type"] != db.DELIVERY_TYPE_VALUE:
            continue
        order["is_delivery"] = True
        # Minutos desde que o pedido saiu da cozinha (calculado no servidor).
        try:
            order["route_min"] = max(0, int((now - datetime.fromisoformat(order["stage_updated_at"])).total_seconds() // 60))
        except (TypeError, ValueError):
            order["route_min"] = None
        orders.append(order)
    return jsonify({"ok": True, "orders": orders})


@app.route("/api/entregador/pedidos/<int:order_id>/entregar", methods=["POST"])
@require_courier
def courier_deliver_order(order_id):
    """O entregador confirma a entrega: o pedido passa de 'em_rota' para
    'entregue'. A cozinha e o cliente veem a mudança sozinhos (as telas se
    atualizam a cada poucos segundos)."""
    updated = db.advance_order_stage(order_id, "em_rota")
    if not updated:
        return jsonify({"ok": False, "error": "Esse pedido já foi confirmado ou não está mais em rota."}), 409
    return jsonify({"ok": True})


@app.route("/api/cozinha/pedidos/<int:order_id>/cancelar", methods=["POST"])
@require_kitchen
def kitchen_cancel_order(order_id):
    """Cancela um pedido (trote, endereço errado, cliente desistiu...). Ele
    some do painel da cozinha e não entra na contagem de pizzas vendidas."""
    updated = db.cancel_order(order_id)
    if not updated:
        return jsonify({"ok": False, "error": "Não foi possível cancelar (o pedido já saiu da lista ou já foi cancelado)."}), 409
    return jsonify({"ok": True})


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
        # Número de versão do cardápio: o "Salvar" só é aceito se a tela
        # ainda estiver na versão atual (evita sobrescrever com dados velhos).
        "revision": db.get_menu_revision(),
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

    store_in = new_data.get("store", {})
    if not isinstance(store_in, dict):
        store_in = {}
    if "bordas" not in store_in or not isinstance(store_in["bordas"], list):
        store_in["bordas"] = []
    for borda in store_in["bordas"]:
        if not isinstance(borda, dict) or not str(borda.get("name") or "").strip():
            return jsonify({"ok": False, "error": "Existe uma borda sem nome."}), 400
        try:
            float(borda.get("price", 0))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": f'A borda "{borda.get("name")}" tem preço inválido.'}), 400
    new_data["store"] = store_in

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

    # Sem número de versão (tela velha guardada no navegador) ou com versão
    # diferente da atual: recusa, pra não apagar produtos por engano.
    revision = new_data.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool):
        return jsonify({"ok": False, "error": "Esta tela está desatualizada. Recarregue a página (Ctrl+F5) e faça as alterações de novo."}), 409

    # save_menu_data nunca mexe na tabela de vendas: elas só são gravadas
    # pela rota de funcionários (insert_sale), uma de cada vez.
    try:
        new_revision = db.save_menu_data(new_data, expected_revision=revision)
    except db.StaleMenuError:
        return jsonify({"ok": False, "error": "O cardápio foi alterado em outra aba ou aparelho depois que esta tela abriu. Suas alterações NÃO foram salvas: recarregue a página (Ctrl+F5) e refaça."}), 409
    return jsonify({"ok": True, "revision": new_revision})


@app.route("/api/admin/backups", methods=["GET"])
@require_admin
def list_menu_backups():
    return jsonify({"ok": True, "backups": db.list_menu_backups()})


@app.route("/api/admin/backups/<int:backup_id>/restaurar", methods=["POST"])
@require_admin
def restore_menu_backup(backup_id):
    """Devolve ao cardápio os produtos que existem no backup e sumiram.
    Não apaga nem altera os produtos que já estão lá."""
    result = db.restore_missing_items(backup_id)
    if result is None:
        return jsonify({"ok": False, "error": "Backup não encontrado."}), 404
    restored, revision = result
    return jsonify({"ok": True, "restored": restored, "count": len(restored), "revision": revision})


@app.route("/api/admin/item/<int:item_id>/disponibilidade", methods=["POST"])
@require_admin
def toggle_item_availability(item_id):
    """Liga/desliga a disponibilidade de um produto na hora (botão
    'Esgotado' do admin), sem precisar salvar o cardápio inteiro."""
    body = request.get_json(silent=True) or {}
    available = bool(body.get("available"))
    ok = db.set_item_availability(item_id, available)
    if not ok:
        return jsonify({"ok": False, "error": "Produto não encontrado."}), 404
    return jsonify({"ok": True, "available": available})


@app.route("/api/admin/print-token/regenerate", methods=["POST"])
@require_admin
def regenerate_print_token():
    """Gera um novo token para o agente de impressão. Depois de gerar,
    é preciso atualizar esse mesmo valor no arquivo de configuração do
    programinha que roda no computador da pizzaria (imprimir_agent.py)."""
    token = secrets.token_hex(16)
    db.set_print_agent_token(token)
    return jsonify({"ok": True, "token": token})


@app.route("/api/admin/entregador", methods=["GET"])
@require_admin
def admin_courier_status():
    return jsonify({"ok": True, "has_password": bool(db.get_courier_password())})


@app.route("/api/admin/entregador/senha", methods=["POST"])
@require_admin
def admin_set_courier_password():
    """Define ou troca a senha do entregador. Quem estava logado com a senha
    antiga é desconectado na próxima atualização da tela."""
    body = request.get_json(silent=True) or {}
    password = str(body.get("password") or "").strip()
    if len(password) < 4:
        return jsonify({"ok": False, "error": "A senha precisa ter pelo menos 4 caracteres."}), 400
    if len(password) > 64:
        return jsonify({"ok": False, "error": "Senha muito longa (máximo 64 caracteres)."}), 400
    db.set_courier_password(hash_shift_password(password))
    return jsonify({"ok": True, "has_password": True})


def _orders_in_period(orders, period):
    """Filtra pedidos pelo campo created_at. 'today' = hoje (data local do
    servidor), 'week' = últimos 7 dias, qualquer outro valor = tudo."""
    if period not in ("today", "week"):
        return orders
    now = datetime.now()
    if period == "today":
        cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        cutoff = now - timedelta(days=7)
    result = []
    for o in orders:
        try:
            ts = datetime.fromisoformat(o.get("created_at", ""))
        except ValueError:
            continue
        if ts >= cutoff:
            result.append(o)
    return result


@app.route("/api/admin/pedidos/historico", methods=["GET"])
@require_admin
def admin_pedidos_historico():
    """Histórico dos pedidos feitos pelo site (os mesmos que passam pelo
    painel da cozinha), com o total de pizzas vendidas separado por tipo de
    entrega. period: 'today' (padrão), 'week' ou 'all'."""
    period = request.args.get("period", "today")
    orders = _orders_in_period(db.list_all_orders(), period)

    pizzas_por_entrega = {}
    active_orders = 0
    for o in orders:
        if o.get("stage") == "cancelado":
            continue
        active_orders += 1
        dt_label = o.get("delivery_type") or "Não informado"
        pizzas = sum(int(item.get("pizza_count") or 0) * int(item.get("qty") or 0) for item in o.get("items", []))
        if pizzas:
            pizzas_por_entrega[dt_label] = pizzas_por_entrega.get(dt_label, 0) + pizzas

    return jsonify({
        "ok": True,
        "orders": orders[:200],
        "total_pedidos": active_orders,
        "pizzas_por_entrega": [{"delivery_type": k, "qty": v} for k, v in pizzas_por_entrega.items()],
    })


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
