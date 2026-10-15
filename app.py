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
- DEV_PASSWORD    -> senha da área do desenvolvedor /dev (avisos para o admin; sem ela /dev fica bloqueado)
- SECRET_KEY      -> chave para assinar os cookies de sessão
- PORT            -> porta em que o servidor escuta (o Render define sozinho)
- FLASK_DEBUG     -> "1" para ligar o modo debug (deixe desligado em produção)
- NEIGHBORHOOD_FEES -> taxas fixas de entrega por zona (veja delivery_fee.py)
"""

from flask import Flask, jsonify, request, render_template, session, redirect, url_for, g
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
from functools import wraps
import os
import uuid
import hashlib
import hmac
import secrets
import ipaddress
import json
import math
import base64
import threading
import time

import db
import delivery_fee
import print_format

# Avisos push (o celular do entregador recebe "pedido pronto" mesmo com o
# navegador fechado). Se a biblioteca não estiver instalada, o resto do site
# funciona normalmente — só ficam sem push.
try:
    from pywebpush import webpush, WebPushException
except Exception:  # pragma: no cover
    webpush = None
    WebPushException = Exception


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
# Cookie de sessão só por HTTPS. O Render define RENDER=true sozinho; em testes
# locais por http:// fica desligado. SESSION_COOKIE_SECURE=1/0 força o valor.
app.config["SESSION_COOKIE_SECURE"] = (
    os.environ.get("SESSION_COOKIE_SECURE", "1" if os.environ.get("RENDER") else "0") == "1"
)

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
DEV_PASSWORD = os.environ.get("DEV_PASSWORD")
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(16))

if not ADMIN_PASSWORD:
    print("AVISO: a variável de ambiente ADMIN_PASSWORD não foi definida — "
          "o painel /admin ficará bloqueado. Defina ADMIN_PASSWORD no Render.")
if not DEV_PASSWORD:
    print("AVISO: a variável de ambiente DEV_PASSWORD não foi definida — "
          "a área /dev (avisos para o admin) ficará bloqueada.")
if not os.environ.get("SECRET_KEY"):
    print("AVISO: a variável de ambiente SECRET_KEY não foi definida — "
          "as sessões (login) serão invalidadas sempre que o servidor reiniciar.")

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

# Senhas de turno em texto puro (data.json antigo / bancos antigos) viram hash
# aqui, uma vez, no arranque. Se falhar, o app continua subindo: o login ainda
# aceita texto puro (check_shift_password) e tenta de novo no próximo arranque.
try:
    _n_migrated = db.migrate_plaintext_shift_passwords(hash_shift_password)
    if _n_migrated:
        print(f"Senhas de turno migradas de texto puro para hash: {_n_migrated}.")
except Exception as _exc:  # noqa: BLE001
    print(f"AVISO: não foi possível migrar senhas de turno para hash: {_exc!r}")


def is_allowed_image(filename):
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS
    )


def is_open_now(store):
    """Decide se a loja está aberta pelo horário ou pelo status forçado.

    Importante: usamos sempre o horário de Río de Janeiro (America/Sao_Paulo),
    não o horário do servidor. O Render roda os containers em UTC, então sem
    isso a loja fechava (e abria) 3 horas antes do horário configurado."""
    if store.get("force_status") is not None:
        return store["force_status"]

    now = db.now_store().strftime("%H:%M")
    hours = store["hours"]
    if hours["open"] <= hours["close"]:
        # Caso normal: não cruza a meia-noite (ej. 18:00 - 23:00).
        return hours["open"] <= now <= hours["close"]
    # Caso em que o fechamento é depois da meia-noite (ej. 18:00 - 01:00).
    return now >= hours["open"] or now <= hours["close"]


# ---------- registro de abertura/fechamento da loja (noites) ----------
# O admin trabalha por NOITE (18h às 2h), não por data. store_sessions guarda
# quando a loja abriu/fechou; o resto do sistema usa isso como corte de "hoje".

SESSION_SYNC_EVERY = 30          # segundos entre verificações "preguiçosas" (por processo)
_session_sync_state = {"last": None}
_session_sync_lock = threading.Lock()


def _last_scheduled(hhmm, now):
    """Última ocorrência (<= agora) do horário "HH:MM" da loja, ou None se inválido."""
    try:
        h, m = [int(x) for x in str(hhmm).split(":")[:2]]
        t = now.replace(hour=h, minute=m, second=0, microsecond=0)
    except (TypeError, ValueError):
        return None
    return t if t <= now else t - timedelta(days=1)


def sync_store_session_now(store=None, force=False):
    """Registra em store_sessions a abertura/fechamento da loja.

    - force=False (uso "preguiçoso", onde já se calcula is_open_now): no máximo
      1 vez a cada ~30 s por processo, só memória; nada de consulta extra
      entre uma verificação e outra.
    - force=True (admin acabou de salvar o force_status): sempre verifica.
    Em modo automático grava a hora PROGRAMADA (hours open/close), não a hora em
    que a mudança foi percebida, para que nenhum pedido fique fora da noite.
    Nunca derruba a requisição: qualquer erro só vai pro log."""
    with _session_sync_lock:
        t = time.monotonic()
        last = _session_sync_state["last"]
        if not force and last is not None and t - last < SESSION_SYNC_EVERY:
            return
        _session_sync_state["last"] = t
    try:
        if store is None:
            store = db.load_data()["store"]
        now = db.now_store()
        now_iso = now.isoformat(timespec="seconds")
        auto = store.get("force_status") is None
        hours = store.get("hours") or {}
        open_dt = _last_scheduled(hours.get("open"), now)
        close_dt = _last_scheduled(hours.get("close"), now)
        # Primeira sessão da vida (banco novo): se o horário diz "aberto", começa
        # na abertura programada; senão, à meia-noite (igual ao "hoje" antigo).
        sched_open = is_open_now({**store, "force_status": None}) if hours else False
        first_dt = open_dt if (sched_open and open_dt) else now.replace(hour=0, minute=0, second=0, microsecond=0)
        db.sync_store_session(
            bool(is_open_now(store)),
            now_iso,
            open_iso=open_dt.isoformat(timespec="seconds") if open_dt else None,
            close_iso=close_dt.isoformat(timespec="seconds") if close_dt else None,
            auto=auto,
            first_open_iso=first_dt.isoformat(timespec="seconds"),
        )
    except Exception:
        app.logger.exception("Falha ao registrar abertura/fechamento da loja")


def _night_window():
    """(início, fim) da noite atual — fim None se a loja está aberta — ou None
    se ainda não há nenhum registro (aí valem os cortes antigos)."""
    sess = db.get_current_store_session()
    if not sess:
        return None
    try:
        start = datetime.fromisoformat(sess["opened_at"])
        end = datetime.fromisoformat(sess["closed_at"]) if sess["closed_at"] else None
    except (TypeError, ValueError):
        return None
    return start, end


def require_admin(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("is_admin"):
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Sessão de administrador expirada. Entre novamente."}), 401
            return redirect(url_for("admin_login"))
        return view(*args, **kwargs)
    return wrapped


def require_dev(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("is_dev"):
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Sessão expirada. Entre novamente em /dev."}), 401
            return redirect(url_for("dev_login"))
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


# ---------- proteção contra excesso de requisições (plano de 7 dólares) ----------
# O servidor roda com 1 worker e poucos threads (veja o Procfile), num plano
# pequeno do Render. Poucas dezenas de requisições rápidas na mesma rota já
# bastam para deixar o site lento ou travado pra todo mundo. As proteções
# abaixo são só sobre "quantas vezes o MESMO visitante pode bater na MESMA
# rota" — não impedem uma enchente vinda de muitos IPs diferentes ao mesmo
# tempo (isso é proteção de rede/infraestrutura, fora do alcance do código
# da aplicação), mas cobrem os dois casos mais prováveis aqui: alguém
# tentando adivinhar uma senha por tentativa e erro, e um cliente (ou bug no
# navegador) mandando pedidos repetidos rápido demais.
#
# Fica tudo em memória (sem Redis, sem tabela nova): como o gunicorn roda
# com 1 worker só, um dicionário comum já é compartilhado por todas as
# requisições do processo.

_rate_lock = threading.Lock()
_rate_buckets = {}   # "chave:ip" -> [timestamps das últimas requisições]
_rate_hits_since_cleanup = 0


def _parse_trusted_proxies():
    raw = os.environ.get("TRUSTED_PROXIES", "").strip()
    if not raw:
        return None
    try:
        n = int(raw)
        if 0 <= n <= 10:
            return n
    except ValueError:
        pass
    print(f"AVISO: TRUSTED_PROXIES={raw!r} inválido (use um inteiro de 0 a 10) — ignorado.")
    return None


# Quantos proxies confiáveis ficam na frente do app (cada um ACRESCENTA o IP de
# quem falou com ele no fim do X-Forwarded-For). None = não configurado (usa o
# primeiro valor, que o cliente consegue falsificar). 0 = sem proxy (usa
# remote_addr). N >= 1 = usa o N-ésimo valor contando da DIREITA, que é o que
# o último proxy confiável escreveu e o cliente não controla.
TRUSTED_PROXIES = _parse_trusted_proxies()
_ip_debug_left = 30 if os.environ.get("IP_DEBUG") == "1" else 0

if TRUSTED_PROXIES is None:
    print("AVISO: TRUSTED_PROXIES não definido — o limite de tentativas usa o primeiro IP do "
          "X-Forwarded-For, que pode ser falsificado. Ligue IP_DEBUG=1 uma vez para ver a cadeia "
          "de IPs nos logs e então defina TRUSTED_PROXIES.")


def _client_ip():
    """IP de quem fez a requisição, usado só pelo limite de tentativas.
    O Render fica atrás de proxies que ACRESCENTAM o IP no fim do
    X-Forwarded-For sem apagar o que o cliente mandou: o primeiro valor é
    falsificável, o da direita (escrito pelo proxy) não. Ver TRUSTED_PROXIES."""
    cached = getattr(g, "_client_ip", None)
    if cached:
        return cached
    global _ip_debug_left
    forwarded = request.headers.get("X-Forwarded-For", "")
    parts = [p.strip() for p in forwarded.split(",") if p.strip()]
    remote = request.remote_addr or "desconhecido"
    if not parts:
        ip = remote
    elif TRUSTED_PROXIES is None:
        ip = parts[0]                      # comportamento antigo
    elif TRUSTED_PROXIES == 0:
        ip = remote
    else:
        # Se vieram menos valores que o esperado, nunca devolve o IP do proxy
        # (todos os clientes cairiam no mesmo balde): cai no primeiro valor.
        ip = parts[-TRUSTED_PROXIES] if len(parts) >= TRUSTED_PROXIES else parts[0]
        try:
            ipaddress.ip_address(ip)
        except ValueError:
            ip = remote
    if _ip_debug_left > 0:
        _ip_debug_left -= 1
        app.logger.warning("IP_DEBUG xff=%r remote_addr=%s trusted=%s -> %s", forwarded, remote, TRUSTED_PROXIES, ip)
    g._client_ip = ip
    return ip


def _rate_limited(key, max_hits, window_seconds):
    """True se `key` já bateu `max_hits` vezes nos últimos `window_seconds`
    segundos (e registra esta tentativa). Faz uma limpeza leve de vez em
    quando para o dicionário não crescer pra sempre."""
    global _rate_hits_since_cleanup
    now = time.monotonic()
    cutoff = now - window_seconds
    with _rate_lock:
        hits = _rate_buckets.setdefault(key, [])
        while hits and hits[0] < cutoff:
            hits.pop(0)
        if len(hits) >= max_hits:
            return True
        hits.append(now)

        _rate_hits_since_cleanup += 1
        if _rate_hits_since_cleanup >= 500:
            _rate_hits_since_cleanup = 0
            for stale_key in [k for k, v in _rate_buckets.items() if not v]:
                del _rate_buckets[stale_key]
    return False


def rate_limit(name, max_hits, window_seconds):
    """Decorator: no máximo `max_hits` requisições por IP a cada
    `window_seconds` segundos, nesta rota. Passa direto quem está dentro do
    limite; devolve 429 (\"muitas tentativas\") pra quem estourou."""
    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            key = f"{name}:{_client_ip()}"
            if _rate_limited(key, max_hits, window_seconds):
                return jsonify({
                    "ok": False,
                    "error": "Muitas tentativas em pouco tempo. Espere um instante e tente de novo.",
                }), 429
            return view(*args, **kwargs)
        return wrapped
    return decorator


# Teto geral e mais folgado pra qualquer rota /api/ que não tenha um limite
# próprio (rede de segurança contra uma rota esquecida ser martelada). Os
# números abaixo dão bastante folga pra uso normal: o polling mais rápido do
# site (painel da cozinha) já é só 1 requisição a cada 3 segundos.
API_GENERAL_MAX_HITS = int(os.environ.get("API_RATE_LIMIT_MAX", "180"))
API_GENERAL_WINDOW_S = int(os.environ.get("API_RATE_LIMIT_WINDOW_S", "60"))


@app.before_request
def _api_general_rate_limit():
    if not request.path.startswith("/api/"):
        return None
    key = f"api:{_client_ip()}"
    if _rate_limited(key, API_GENERAL_MAX_HITS, API_GENERAL_WINDOW_S):
        return jsonify({
            "ok": False,
            "error": "Muitas requisições em pouco tempo. Espere um instante e tente de novo.",
        }), 429
    return None


# Cabeçalhos de segurança em todas as respostas. A CSP vai em modo
# Report-Only: o navegador NÃO bloqueia nada, só avisa (POST /csp-report ->
# log "CSP_REPORT"). script-src sem 'unsafe-inline' de propósito: assim os
# <script> inline de produto.html/promocao.html aparecem nos relatórios.
# worker-src blob: é o Worker do live.js (relógio da cozinha em 2º plano).
CSP_REPORT_ONLY = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "report-uri /csp-report",
])


@app.after_request
def _security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if response.mimetype == "text/html":
        response.headers.setdefault("Content-Security-Policy-Report-Only", CSP_REPORT_ONLY)
    return response


@app.route("/csp-report", methods=["POST"])
@rate_limit("csp_report", max_hits=30, window_seconds=600)
def csp_report():
    """Recebe os avisos da CSP em modo Report-Only e só escreve no log."""
    if (request.content_length or 0) <= 10000:
        text = request.get_data(cache=False, as_text=True)[:800]
        app.logger.warning("CSP_REPORT %s", text.replace("\n", " ").replace("\r", " "))
    return "", 204


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
@rate_limit("admin_login", max_hits=8, window_seconds=300)
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


# ---------- área do desenvolvedor: avisos para o administrador ----------

@app.route("/dev/login", methods=["GET"])
def dev_login():
    if session.get("is_dev"):
        return redirect(url_for("dev"))
    return render_template("admin_login.html", error=None, login_title="Área do desenvolvedor",
                           login_action="/dev/login", login_back="/admin", login_back_text="← ir para o painel")


@app.route("/dev/login", methods=["POST"])
@rate_limit("dev_login", max_hits=8, window_seconds=300)
def dev_login_submit():
    password = (request.form.get("password") or "").strip()
    if DEV_PASSWORD and password and hmac.compare_digest(password, DEV_PASSWORD):
        session["is_dev"] = True
        return redirect(url_for("dev"))
    return render_template("admin_login.html", error="Senha incorreta.", login_title="Área do desenvolvedor",
                           login_action="/dev/login", login_back="/admin", login_back_text="← ir para o painel"), 401


@app.route("/dev/logout", methods=["POST"])
def dev_logout():
    session.pop("is_dev", None)
    return redirect(url_for("dev_login"))


@app.route("/dev")
@require_dev
def dev():
    return render_template("dev.html")


NOTICE_TITLE_MAX = 80
NOTICE_TEXT_MAX = 800


def _parse_notice_body():
    """Valida título/texto/ativo vindos do /dev. Devolve (dados, None) ou (None, resposta de erro)."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return None, (jsonify({"ok": False, "error": "Dados inválidos."}), 400)
    title = str(body.get("title") or "").strip()
    text = str(body.get("text") or "").strip()
    if not text:
        return None, (jsonify({"ok": False, "error": "Escreva o texto do aviso."}), 400)
    if len(title) > NOTICE_TITLE_MAX:
        return None, (jsonify({"ok": False, "error": f"O título pode ter no máximo {NOTICE_TITLE_MAX} caracteres."}), 400)
    if len(text) > NOTICE_TEXT_MAX:
        return None, (jsonify({"ok": False, "error": f"O texto pode ter no máximo {NOTICE_TEXT_MAX} caracteres."}), 400)
    return (title, text, body.get("active") is not False), None


@app.route("/api/dev/novedades", methods=["GET"])
@require_dev
def dev_list_notices():
    return jsonify({"ok": True, "notices": db.list_dev_notices()})


@app.route("/api/dev/novedades", methods=["POST"])
@require_dev
def dev_create_notice():
    parsed, error = _parse_notice_body()
    if error:
        return error
    notice_id = db.add_dev_notice(*parsed)
    return jsonify({"ok": True, "id": notice_id})


@app.route("/api/dev/novedades/<int:notice_id>", methods=["POST"])
@require_dev
def dev_update_notice(notice_id):
    parsed, error = _parse_notice_body()
    if error:
        return error
    if not db.update_dev_notice(notice_id, *parsed):
        return jsonify({"ok": False, "error": "Aviso não encontrado."}), 404
    return jsonify({"ok": True})


@app.route("/api/dev/novedades/<int:notice_id>/excluir", methods=["POST"])
@require_dev
def dev_delete_notice(notice_id):
    if not db.delete_dev_notice(notice_id):
        return jsonify({"ok": False, "error": "Aviso não encontrado."}), 404
    return jsonify({"ok": True})


@app.route("/api/dev/novedades/reenviar", methods=["POST"])
@require_dev
def dev_resend_notices():
    """Marca todos como 'não vistos': o admin os verá de novo ao entrar."""
    db.reset_dev_notices_seen()
    return jsonify({"ok": True})


# Lado do administrador: só lê os avisos novos e marca como vistos.
@app.route("/api/admin/novedades", methods=["GET"])
@require_admin
def admin_get_notices():
    notices = [{"id": n["id"], "title": n["title"], "text": n["text"]} for n in db.list_dev_notices(only_unseen=True)]
    return jsonify({"ok": True, "notices": notices})


@app.route("/api/admin/novedades/vistas", methods=["POST"])
@require_admin
def admin_mark_notices_seen():
    body = request.get_json(silent=True) or {}
    ids = body.get("ids")
    if not isinstance(ids, list) or len(ids) > 100 or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        return jsonify({"ok": False, "error": "Dados inválidos."}), 400
    db.mark_dev_notices_seen(ids)
    return jsonify({"ok": True})


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
    sync_store_session_now(data["store"])
    # O token do agente de impressão é uma senha: nunca vai para o público.
    public_store = {k: v for k, v in data["store"].items() if k != "print_agent_token"}
    public = {
        "store": public_store,
        "today_post": data["today_post"],
        "items": data["items"],
        "promotions": data["promotions"],
        "pizza_sizes": data["pizza_sizes"],
        "sections": data["sections"],
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


# ---------- taxa de entrega por zona ----------

@app.route("/api/calcular-tarifa", methods=["POST"])
@rate_limit("calcular_tarifa", max_hits=40, window_seconds=300)
def calcular_tarifa():
    """Recebe {address} e devolve {fee, distance_km, cached}. Resposta na
    hora: é só conferir se o texto cita uma zona com taxa fixa conhecida."""
    body = request.get_json(silent=True) or {}
    try:
        result = delivery_fee.calculate_fee(body.get("address"))
    except delivery_fee.DeliveryFeeError as exc:
        payload = {"ok": False, "code": exc.code, "error": exc.message}
        payload.update(exc.extra)
        return jsonify(payload), exc.status
    return jsonify({"ok": True, **result})


# ---------- pedidos do cliente (fila de impressão térmica) ----------

MAX_ORDER_ITEMS = 40
MAX_UNIT_PRICE = 100000.0   # teto por unidade (R$): barra 1e308 e afins
MAX_TROCO = 100000.0


def _price_enforced():
    """PRICE_ENFORCE=1 -> o servidor usa o preço que ele mesmo calculou.
    Sem a variável (padrão) fica em modo observação: grava o preço do
    navegador e só registra no log quando o cálculo do servidor difere."""
    return os.environ.get("PRICE_ENFORCE", "") == "1"


def _pizza_price_for_size(pizza, size, sizes):
    """Mesma fórmula de pizzaPriceForSize() em static/produto.js."""
    own = float(pizza.get("price") or 0)
    if size is None:
        return own
    if not own:
        return float(size.get("price") or 0)
    base = sizes[0] if sizes else None
    return own + float(size.get("price") or 0) - float((base or {}).get("price") or 0)


def price_line(entry, data):
    """Recalcula o preço UNITÁRIO de uma linha do carrinho pelo cardápio do
    banco, com a mesma fórmula de static/produto.js (item/tamanho/meia a
    meia/borda) e static/promocao.js (preço + extras dos sabores + bordas).

    Devolve {"price": float|None, "issue": str|None, "hard": bool}.
    - price None  -> não deu para calcular com certeza (issue explica): quem
      chama deve usar o preço do navegador e logar, nunca rejeitar por isso.
    - hard=True   -> problema CERTO (produto/promoção não existe ou esgotado).
    """
    def unsure(issue):
        return {"price": None, "issue": issue, "hard": False}

    def hard(issue):
        return {"price": None, "issue": issue, "hard": True}

    kind = entry.get("type")
    sel = entry.get("sel")
    try:
        ref_id = int(entry.get("id"))
    except (TypeError, ValueError, OverflowError):
        return unsure("no_id")
    items_by_id = {int(i["id"]): i for i in data.get("items", [])}
    items_by_str = {str(i["id"]): i for i in data.get("items", [])}
    bordas = {str(b.get("id")): b for b in (data.get("store", {}).get("bordas") or []) if isinstance(b, dict)}

    def borda_price(borda_id):
        if borda_id is None or borda_id == "":
            return 0.0
        borda = bordas.get(str(borda_id))
        return None if borda is None else float(borda.get("price") or 0)

    if kind == "item":
        item = items_by_id.get(ref_id)
        if item is None:
            return hard("item_missing")
        if item.get("available") is False:
            return hard("item_unavailable")
        if not isinstance(sel, dict):
            return unsure("no_sel")
        sizes = data.get("pizza_sizes") or []
        if item.get("category") == "pizza" and sizes:
            size = next((s for s in sizes if str(s["id"]) == str(sel.get("size_id"))), None)
            if size is None:
                return unsure("unknown_size")
            split_ids = sel.get("split_ids")
            if split_ids:
                if not isinstance(split_ids, list) or not 2 <= len(split_ids) <= 3:
                    return unsure("bad_split")
                prices = []
                for fid in split_ids:
                    flavor = items_by_str.get(str(fid))
                    if flavor is None or flavor.get("category") != "pizza":
                        return unsure("unknown_flavor")
                    if flavor.get("available") is False and int(flavor["id"]) != ref_id:
                        return hard("item_unavailable")
                    prices.append(_pizza_price_for_size(flavor, size, sizes))
                price = max(prices)
            else:
                price = _pizza_price_for_size(item, size, sizes)
        else:
            price = float(item.get("price") or 0)
        extra = borda_price(sel.get("borda_id"))
        if extra is None:
            return unsure("unknown_borda")
        return {"price": round(price + extra, 2), "issue": None, "hard": False}

    if kind == "promotion":
        promo = next((p for p in data.get("promotions", []) if int(p["id"]) == ref_id), None)
        if promo is None:
            return hard("promo_missing")
        slots = promo.get("slots") or []
        if not isinstance(sel, dict) or not isinstance(sel.get("slots"), list):
            return unsure("no_sel")
        if len(sel["slots"]) != len(slots):
            return unsure("bad_sel")
        total = float(promo.get("price") or 0)
        for chosen in sel["slots"]:
            if not isinstance(chosen, dict) or not isinstance(chosen.get("ids"), list) or not 1 <= len(chosen["ids"]) <= 2:
                return unsure("bad_sel")
            for fid in chosen["ids"]:
                flavor = items_by_str.get(str(fid))
                if flavor is None:
                    return unsure("unknown_flavor")
                if flavor.get("available") is False:
                    return hard("item_unavailable")
                total += float(flavor.get("promo_extra") or 0)
            extra = borda_price(chosen.get("borda_id"))
            if extra is None:
                return unsure("unknown_borda")
            total += extra
        return {"price": round(total, 2), "issue": None, "hard": False}

    return unsure("no_type")


@app.route("/api/pedidos", methods=["POST"])
@rate_limit("create_order", max_hits=15, window_seconds=600)
def create_order():
    """O carrinho do cliente manda o pedido pra cá antes de abrir o
    WhatsApp, só para que o agente de impressão da pizzaria possa
    imprimir o ticket. Não precisa de login — é o mesmo pedido que o
    cliente já vai mandar por WhatsApp de qualquer forma."""
    data = db.load_data()
    store = data["store"]
    sync_store_session_now(store)
    if not is_open_now(store):
        return jsonify({"ok": False, "error": "A loja está fechada agora. Não é possível fazer pedidos fora do horário de funcionamento."}), 403

    body = request.get_json(silent=True) or {}
    cart = body.get("items")
    if not isinstance(cart, list) or not cart or len(cart) > MAX_ORDER_ITEMS:
        return jsonify({"ok": False, "error": "Carrinho inválido."}), 400

    enforce = _price_enforced()
    order_items = []
    total = 0.0
    min_check_subtotal = 0.0
    n_ok = n_diff = n_unsure = 0
    for entry in cart:
        if not isinstance(entry, dict):
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400
        raw_qty = entry.get("qty")
        if isinstance(raw_qty, float) and raw_qty.is_integer():
            raw_qty = int(raw_qty)
        if type(raw_qty) is not int:
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400
        try:
            qty = raw_qty
            unit_price = float(entry.get("unit_price"))
            # Quantas pizzas tem em UMA unidade desta linha (0 para bebida/salgado,
            # 1 para uma pizza normal, 2 para uma promoção de "2 pizzas" etc.).
            # Usado só para o resumo "pizzas vendidas por tipo de entrega" do admin.
            pizza_count = int(entry.get("pizza_count") or 0)
        except (TypeError, ValueError, OverflowError):
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400
        # isfinite: o JSON do Flask aceita NaN/Infinity e eles passariam pelas
        # comparações abaixo (NaN < 0 é False) e acabariam gravados / dando 500.
        if (not math.isfinite(unit_price) or qty <= 0 or qty > 500 or unit_price < 0
                or unit_price > MAX_UNIT_PRICE or pizza_count < 0 or pizza_count > 20):
            return jsonify({"ok": False, "error": "Item de pedido inválido."}), 400

        # Preço calculado pelo servidor (ver price_line). Modo observação: o
        # que vale continua sendo o preço do navegador; só logamos diferenças.
        # Com PRICE_ENFORCE=1 vale o preço do servidor. Se não dá para calcular
        # com certeza, NUNCA rejeitamos: usa o do navegador e loga.
        priced = price_line(entry, data)
        if priced["price"] is None:
            n_unsure += 1
            app.logger.warning("PRICE_UNSURE issue=%s hard=%s type=%s id=%s client=%.2f sel=%s",
                               priced["issue"], priced["hard"], entry.get("type"), entry.get("id"),
                               unit_price, json.dumps(entry.get("sel"), ensure_ascii=False)[:300])
            if priced["hard"] and enforce:
                return jsonify({"ok": False, "error": "Um item do carrinho não está mais disponível. Atualize o cardápio."}), 409
        elif abs(priced["price"] - unit_price) > 0.005:
            n_diff += 1
            app.logger.warning("PRICE_DIFF type=%s id=%s client=%.2f server=%.2f enforce=%s sel=%s",
                               entry.get("type"), entry.get("id"), unit_price, priced["price"], enforce,
                               json.dumps(entry.get("sel"), ensure_ascii=False)[:300])
            if enforce:
                unit_price = priced["price"]
        else:
            n_ok += 1
        entry_server_price = priced["price"] if priced["price"] is not None else unit_price

        name = str(entry.get("name") or "")[:200]
        order_items.append({"name": name, "qty": qty, "unit_price": round(unit_price, 2), "pizza_count": pizza_count})
        total += unit_price * qty
        # Subtotal pro pedido mínimo: usa o preço do servidor quando existe
        # (já vale em modo observação), senão o do navegador.
        min_check_subtotal += entry_server_price * qty

    if not order_items:
        return jsonify({"ok": False, "error": "Carrinho vazio."}), 400

    app.logger.warning("PRICE_CHECK mode=%s lines=%d ok=%d diff=%d unsure=%d",
                       "enforce" if enforce else "observe", len(order_items), n_ok, n_diff, n_unsure)

    # Pedido mínimo (só os itens; a taxa de entrega não conta).
    try:
        min_order = float(store.get("min_order") or 0)
    except (TypeError, ValueError):
        min_order = 0.0
    if min_order > 0 and round(min_check_subtotal, 2) < round(min_order, 2):
        return jsonify({"ok": False, "code": "min_order",
                        "error": f"Pedido mínimo de R$ {min_order:.2f}".replace(".", ",") + " (sem contar a taxa de entrega)."}), 400

    delivery_type = str(body.get("delivery_type") or "")[:60]
    address = str(body.get("address") or "")[:300]

    # Taxa de entrega: o servidor confere de novo se o endereço cita uma zona
    # com taxa fixa. Não aceitamos o valor vindo do navegador, senão qualquer
    # um mandaria taxa = 0. Sem zona reconhecida -> None ("a combinar" pelo
    # WhatsApp).
    order_delivery_fee = None
    if delivery_type == "Entrega (delivery)":
        order_delivery_fee = delivery_fee.lookup_cached_fee(address)
        if order_delivery_fee is not None:
            total += order_delivery_fee

    payment_method = str(body.get("payment_method") or "")[:60]

    troco_paid_with = None
    troco_amount = None
    raw_troco = body.get("troco_paid_with")
    if raw_troco is not None and payment_method == "Dinheiro":
        try:
            troco_paid_with = round(float(raw_troco), 2)
        except (TypeError, ValueError, OverflowError):
            troco_paid_with = None
        # NaN/inf/valores absurdos não são "troco para" válidos.
        if troco_paid_with is not None and (not math.isfinite(troco_paid_with) or troco_paid_with > MAX_TROCO):
            troco_paid_with = None
        # Se o valor não cobre o total do pedido, não faz sentido como
        # "troco para" — trata como se não tivesse sido informado, em vez
        # de guardar um troco inválido (ex.: negativo).
        if troco_paid_with is not None and troco_paid_with < total:
            troco_paid_with = None
        if troco_paid_with is not None:
            troco_amount = round(troco_paid_with - total, 2)

    order = {
        "created_at": db.datetime_now_iso(),
        "customer_name": str(body.get("customer_name") or "")[:120],
        "customer_phone": str(body.get("customer_phone") or "")[:30],
        "delivery_type": delivery_type,
        "address": address,
        "payment_method": payment_method,
        "notes": str(body.get("notes") or "").strip()[:100],
        "items": order_items,
        "total": round(total, 2),
        "troco_paid_with": troco_paid_with,
        "troco_amount": troco_amount,
        "delivery_fee": order_delivery_fee,
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
@rate_limit("cancel_order", max_hits=10, window_seconds=600)
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
@rate_limit("my_orders", max_hits=20, window_seconds=600)
def my_orders():
    """'Meus pedidos': o navegador do cliente guarda os códigos dos pedidos
    que ele fez e manda a lista para cá. Não existe login de cliente — só
    quem tem o código secreto de um pedido consegue ver aquele pedido."""
    body = request.get_json(silent=True) or {}
    tokens = body.get("tokens")
    if not isinstance(tokens, list):
        return jsonify({"ok": False, "error": "Lista inválida."}), 400
    now = db.now_store()
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
    now = db.now_store()
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
    if updated["stage"] == "pronto" and updated["is_delivery"]:
        _notify_courier_ready(updated)
    return jsonify({"ok": True, "order": updated})


# ---------- entregador: pedidos em rota + confirmar entrega ----------

@app.route("/entregador")
def entregador():
    return render_template("entregador.html")


@app.route("/api/entregador/login", methods=["POST"])
@rate_limit("courier_login", max_hits=8, window_seconds=300)
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
    db.open_courier_shift(db.datetime_now_iso())   # começa a contagem das entregas da noite
    return jsonify({"ok": True})


@app.route("/api/entregador/logout", methods=["POST"])
def courier_logout():
    session.pop("courier_pw", None)
    return jsonify({"ok": True})


@app.route("/api/entregador/pedidos", methods=["GET"])
@require_courier
def courier_orders():
    """Pedidos de ENTREGA que o entregador precisa atender: 'pronto' (esperando
    ele pegar na cozinha) e 'em_rota' (já saíram), do mais antigo para o mais
    novo. Retirada nunca aparece aqui. Devolve também a contagem da noite."""
    now = db.now_store()
    orders = []
    for order in db.list_kitchen_orders():
        if order["stage"] not in ("pronto", "em_rota") or order["delivery_type"] != db.DELIVERY_TYPE_VALUE:
            continue
        order["is_delivery"] = True
        # Minutos desde que o pedido entrou nessa etapa (calculado no servidor).
        try:
            minutes = max(0, int((now - datetime.fromisoformat(order["stage_updated_at"])).total_seconds() // 60))
        except (TypeError, ValueError):
            minutes = None
        order["route_min"] = minutes if order["stage"] == "em_rota" else None
        order["ready_min"] = minutes if order["stage"] == "pronto" else None
        orders.append(order)
    return jsonify({
        "ok": True,
        "orders": orders,
        "shift": db.get_open_courier_shift(),
        # True só para a sessão do ENTREGADOR (não para o admin espiando): a tela usa
        # isto para voltar ao login se o admin fechou a noite enquanto ele estava conectado.
        "courier_session": _courier_session_valid(),
    })


@app.route("/api/entregador/pedidos/<int:order_id>/sair", methods=["POST"])
@require_courier
def courier_pickup(order_id):
    """O entregador pegou o pedido pronto na cozinha e saiu para entregar
    ('pronto' -> 'em_rota'). O cliente vê "em rota" sozinho."""
    if not db.courier_pickup_order(order_id):
        return jsonify({"ok": False, "error": "Esse pedido já saiu ou não está mais pronto."}), 409
    return jsonify({"ok": True})


@app.route("/api/entregador/pedidos/<int:order_id>/entregar", methods=["POST"])
@require_courier
def courier_deliver_order(order_id):
    """O entregador confirma a entrega: o pedido passa de 'em_rota' para
    'entregue' (e entra na contagem da noite). A cozinha e o cliente veem a
    mudança sozinhos (as telas se atualizam a cada poucos segundos)."""
    # Se o admin fechou a noite e o entregador ainda não voltou ao login, esta
    # entrega abre uma noite nova em vez de ficar sem contar.
    if _courier_session_valid():
        db.open_courier_shift(db.datetime_now_iso())
    updated = db.advance_order_stage(order_id, "em_rota")
    if not updated:
        return jsonify({"ok": False, "error": "Esse pedido já foi confirmado ou não está mais em rota."}), 409
    return jsonify({"ok": True})


# ---------- noite de entregas (contagem do entregador -> admin) ----------

def _courier_session_valid():
    stored = db.get_courier_password()
    return bool(stored) and session.get("courier_pw") == _courier_fingerprint(stored)


@app.route("/api/entregador/turno/iniciar", methods=["POST"])
@require_courier
def courier_shift_start():
    """Garante que existe uma noite aberta. Só a sessão do ENTREGADOR abre
    (o admin só espiando a tela do entregador não começa contagem nenhuma)."""
    if _courier_session_valid():
        return jsonify({"ok": True, "shift": db.open_courier_shift(db.datetime_now_iso())})
    return jsonify({"ok": True, "shift": db.get_open_courier_shift()})


@app.route("/api/entregador/turno/fechar", methods=["POST"])
@require_courier
def courier_shift_close():
    """O entregador toca em "Fechar entregas": a noite é fechada e o total vai
    para o admin. A sessão do entregador é encerrada (na próxima noite, ao
    entrar de novo, começa uma contagem nova)."""
    body = request.get_json(silent=True) or {}
    endpoint = str(body.get("endpoint") or "")
    closed = db.close_courier_shift(db.datetime_now_iso())
    # O aparelho é esquecido aqui, enquanto a sessão ainda vale (depois do
    # logout a chamada de "unsubscribe" já daria 401 e o aviso ficaria salvo).
    if endpoint:
        db.remove_push_sub(endpoint)
    # A sessão termina sempre: se a noite já tinha sido fechada (pelo admin ou
    # em outro aparelho) o entregador não fica preso numa tela sem saída.
    session.pop("courier_pw", None)
    if not closed:
        return jsonify({
            "ok": False,
            "already_closed": True,
            "error": "As entregas já tinham sido fechadas (pelo administrador ou em outro aparelho). Para começar uma nova noite, entre de novo.",
        }), 409
    return jsonify({"ok": True, "shift": closed})


@app.route("/api/admin/entregas/turnos", methods=["GET"])
@require_admin
def admin_courier_shifts():
    open_shift = db.get_open_courier_shift()
    return jsonify({
        "ok": True,
        "open": open_shift,
        # A noite aberta já vem com o detalhe; as fechadas carregam ao tocar na linha.
        "open_deliveries": db.list_courier_deliveries(open_shift["id"]) if open_shift else [],
        "shifts": db.list_closed_courier_shifts(30),
    })


@app.route("/api/admin/entregas/turnos/<int:shift_id>/entregas", methods=["GET"])
@require_admin
def admin_courier_shift_deliveries(shift_id):
    """Detalhe de uma noite do entregador: nome, taxa, endereço e hora de cada
    entrega. Nunca devolve telefone. Noites antigas (sem detalhe) voltam com lista vazia."""
    shift = db.get_courier_shift(shift_id)
    if not shift:
        return jsonify({"ok": False, "error": "Noite não encontrada."}), 404
    deliveries = [
        {
            "customer_name": d["customer_name"],
            "delivery_fee": d["delivery_fee"],
            "address": d["address"],
            "delivered_at": d["delivered_at"],
        }
        for d in db.list_courier_deliveries(shift_id)
    ]
    return jsonify({"ok": True, "shift": shift, "deliveries": deliveries})


@app.route("/api/admin/entregas/turnos/fechar", methods=["POST"])
@require_admin
def admin_close_courier_shift():
    """Fecha à força a noite aberta (ex.: o entregador esqueceu de fechar)."""
    closed = db.close_courier_shift(db.datetime_now_iso())
    if not closed:
        return jsonify({"ok": False, "error": "Não há noite aberta."}), 409
    return jsonify({"ok": True, "shift": closed})


# ---------- avisos push para o entregador ----------

def _vapid_keys():
    """Par de chaves do push: gerado uma vez e guardado no banco (assim não
    precisa configurar nada no Render). Devolve (privada, pública) em base64url."""
    raw = db.get_meta("vapid_keys")
    if not raw:
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization
        key = ec.generate_private_key(ec.SECP256R1())
        b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
        priv = b64(key.private_numbers().private_value.to_bytes(32, "big"))
        pub = b64(key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
        raw = db.set_meta_if_absent("vapid_keys", json.dumps({"private": priv, "public": pub}))
    keys = json.loads(raw)
    return keys["private"], keys["public"]


def _vapid_subject():
    explicit = os.environ.get("VAPID_SUBJECT")
    if explicit:
        return explicit
    host = os.environ.get("RENDER_EXTERNAL_HOSTNAME") or "reypizzaria.onrender.com"
    return f"mailto:admin@{host}"


PUSH_REPEAT_EVERY_S = 45   # enquanto o pedido continuar "pronto", repete o aviso
PUSH_REPEAT_MAX = 6        # no máximo 6 lembretes (~4,5 min)
PUSH_TEST_DELAY_S = 12     # tempo para o entregador fechar o app antes do aviso de teste


def _send_push_now(payload, private_key, subject):
    """Envia agora o aviso para todos os aparelhos salvos (a lista é lida a cada
    envio, então aparelhos que deixaram de valer somem sozinhos)."""
    for sub_json in db.list_push_subs():
        try:
            sub = json.loads(sub_json)
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=private_key,
                vapid_claims={"sub": subject},
                ttl=900,
                headers={"Urgency": "high"},
                timeout=10,
            )
        except WebPushException as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            if status in (404, 410):   # aparelho não recebe mais: esquece
                try:
                    db.remove_push_sub(json.loads(sub_json).get("endpoint", ""))
                except Exception:
                    pass
            else:
                print("push: falha ao enviar:", error)
        except Exception as error:
            print("push: falha ao enviar:", error)


def _notify_courier_ready(order):
    """Manda o aviso "pedido pronto" para o celular do entregador. Roda numa
    thread à parte para o clique da cozinha não esperar o serviço de push, e
    só envia se o entregador tem uma noite aberta (ou seja, está trabalhando).
    Enquanto o pedido continuar "pronto", repete o aviso (o toque do celular é
    curto: o lembrete faz o alarme insistir até ele pegar o pedido)."""
    if webpush is None:
        return
    try:
        if not db.get_open_courier_shift():
            return
        if not db.list_push_subs():
            return
        private_key, _ = _vapid_keys()
    except Exception as error:
        print("push: não foi possível preparar o aviso:", error)
        return

    name = (order.get("customer_name") or "").strip()
    address = (order.get("address") or "").strip()
    payload = json.dumps({
        "title": f"🍕 Pedido #{order['id']} PRONTO!",
        "body": " · ".join(part for part in (name, address) if part) or "Pode retirar na cozinha.",
        "order_id": order["id"],
    }, ensure_ascii=False)
    subject = _vapid_subject()
    order_id = order["id"]

    def send_all():
        _send_push_now(payload, private_key, subject)
        for _ in range(PUSH_REPEAT_MAX):
            time.sleep(PUSH_REPEAT_EVERY_S)
            try:
                # Para de insistir quando ele pegou o pedido, a noite fechou ou não há aparelhos.
                if db.get_order_stage(order_id) != "pronto":
                    return
                if not db.get_open_courier_shift() or not db.list_push_subs():
                    return
            except Exception as error:
                print("push: lembrete cancelado:", error)
                return
            _send_push_now(payload, private_key, subject)

    threading.Thread(target=send_all, daemon=True).start()


@app.route("/entregador-sw.js")
def courier_service_worker():
    """O service worker precisa ser servido da raiz do site para poder
    receber os avisos mesmo com a página fechada."""
    from flask import send_from_directory
    response = send_from_directory(os.path.join(BASE_PATH, "static"), "entregador-sw.js", mimetype="application/javascript")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Service-Worker-Allowed"] = "/"
    return response


@app.route("/api/entregador/push/key", methods=["GET"])
@require_courier
def courier_push_key():
    if webpush is None:
        return jsonify({"ok": True, "enabled": False})
    try:
        return jsonify({"ok": True, "enabled": True, "key": _vapid_keys()[1]})
    except Exception as error:
        print("push: erro nas chaves:", error)
        return jsonify({"ok": True, "enabled": False})


@app.route("/api/entregador/push/subscribe", methods=["POST"])
@require_courier
def courier_push_subscribe():
    sub = request.get_json(silent=True) or {}
    endpoint = str(sub.get("endpoint") or "")
    keys = sub.get("keys") or {}
    if not endpoint.startswith("https://") or len(endpoint) > 1000 or not keys.get("p256dh") or not keys.get("auth"):
        return jsonify({"ok": False, "error": "Inscrição inválida."}), 400
    clean = {"endpoint": endpoint, "keys": {"p256dh": str(keys["p256dh"]), "auth": str(keys["auth"])}}
    db.save_push_sub(endpoint, json.dumps(clean))
    return jsonify({"ok": True})


@app.route("/api/entregador/push/unsubscribe", methods=["POST"])
@require_courier
def courier_push_unsubscribe():
    endpoint = str((request.get_json(silent=True) or {}).get("endpoint") or "")
    if endpoint:
        db.remove_push_sub(endpoint)
    return jsonify({"ok": True})


@app.route("/api/entregador/push/testar", methods=["POST"])
@require_courier
def courier_push_test():
    """Manda um aviso de teste em alguns segundos, para o entregador fechar o
    app e conferir que o alarme chega com o app fechado."""
    if webpush is None:
        return jsonify({"ok": False, "error": "Os avisos com o app fechado não estão disponíveis neste servidor."}), 503
    if not db.list_push_subs():
        return jsonify({"ok": False, "error": "Este aparelho ainda não ativou os avisos. Toque em \"Ativar avisos\" primeiro."}), 409
    try:
        private_key, _ = _vapid_keys()
    except Exception as error:
        print("push: erro nas chaves:", error)
        return jsonify({"ok": False, "error": "Não foi possível preparar o aviso de teste."}), 500
    payload = json.dumps({
        "title": "🔔 Teste de aviso",
        "body": "Se você recebeu isto com o app fechado, o alarme de pedido pronto vai funcionar.",
        "order_id": "teste",
        "test": True,
    }, ensure_ascii=False)
    subject = _vapid_subject()

    def later():
        time.sleep(PUSH_TEST_DELAY_S)
        _send_push_now(payload, private_key, subject)

    threading.Thread(target=later, daemon=True).start()
    return jsonify({"ok": True, "delay": PUSH_TEST_DELAY_S})


@app.route("/api/cozinha/pedidos/<int:order_id>/cancelar", methods=["POST"])
@require_kitchen
def kitchen_cancel_order(order_id):
    """Cancela um pedido (trote, endereço errado, cliente desistiu...). Ele
    some do painel da cozinha e não entra na contagem de pizzas vendidas."""
    updated = db.cancel_order(order_id)
    if not updated:
        return jsonify({"ok": False, "error": "Não foi possível cancelar (o pedido já saiu da lista ou já foi cancelado)."}), 409
    return jsonify({"ok": True})


def _parse_money(value, allow_none=False):
    """Valor em reais vindo do navegador -> float >= 0 com 2 casas. ValueError se inválido."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if allow_none:
            return None
        raise ValueError("valor obrigatório")
    if isinstance(value, bool):
        raise ValueError("valor inválido")
    number = round(float(str(value).replace(",", ".")), 2)
    if not 0 <= number <= 100000:   # também rejeita NaN e infinito
        raise ValueError("valor fora do limite")
    return number


EDIT_TEXT_LIMITS = (("customer_name", 120), ("customer_phone", 30), ("address", 300), ("payment_method", 60), ("notes", 500))


@app.route("/api/cozinha/pedidos/<int:order_id>/reimprimir", methods=["POST"])
@require_kitchen
def kitchen_reprint_order(order_id):
    """Volta o pedido para a fila do agente de impressão (ele imprime de novo)."""
    if not db.requeue_print(order_id):
        return jsonify({"ok": False, "error": "Não foi possível reimprimir (pedido não encontrado ou cancelado)."}), 409
    return jsonify({"ok": True})


@app.route("/api/cozinha/pedidos/<int:order_id>/editar", methods=["POST"])
@require_kitchen
def kitchen_edit_order(order_id):
    """Edita dados, valores e itens de um pedido ainda em andamento."""
    body = request.get_json(silent=True) or {}
    fields = {key: str(body.get(key) or "").strip()[:limit] for key, limit in EDIT_TEXT_LIMITS if key in body}
    items = None
    try:
        for key in ("delivery_fee", "troco_paid_with"):
            if key in body:
                fields[key] = _parse_money(body[key], allow_none=True)
        if "total" in body:
            fields["total"] = _parse_money(body["total"])
        if "items" in body:
            raw_items = body["items"]
            if not isinstance(raw_items, list) or not 1 <= len(raw_items) <= MAX_ORDER_ITEMS:
                raise ValueError("itens")
            items = []
            for entry in raw_items:
                if not isinstance(entry, dict):
                    raise ValueError("item")
                qty = float(entry.get("qty"))
                name = str(entry.get("name") or "").strip()[:200]
                if not qty.is_integer() or not 1 <= qty <= 500 or not name:
                    raise ValueError("item")
                items.append({
                    "index": int(entry.get("index")),
                    "name": name,
                    "qty": int(qty),
                    "unit_price": _parse_money(entry.get("unit_price")),
                })
            if len({item["index"] for item in items}) != len(items):
                raise ValueError("itens repetidos")
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Dados inválidos. Confira quantidades, preços e nomes."}), 400

    try:
        updated = db.update_order_fields(order_id, fields, items)
    except ValueError:
        return jsonify({"ok": False, "error": "Item do pedido inválido. Atualize a lista e tente de novo."}), 400
    if not updated:
        return jsonify({"ok": False, "error": "Esse pedido não pode mais ser editado (já foi entregue ou cancelado)."}), 409
    if body.get("reprint"):
        updated = db.requeue_print(order_id) or updated
    updated["is_delivery"] = updated["delivery_type"] == db.DELIVERY_TYPE_VALUE
    return jsonify({"ok": True, "order": updated})


@app.route("/api/pedidos/pendentes", methods=["GET"])
@require_print_agent
def pending_orders():
    """Usado pelo programinha da impressora, que fica perguntando aqui
    de tempos em tempos se chegou pedido novo."""
    orders = [print_format.pedido_para_impressao(o) for o in db.list_pending_orders()]
    return jsonify({"ok": True, "orders": orders})


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

def _safe_shifts(shifts):
    """Turnos sem a senha (nem hash): só um marcador de que existe uma."""
    return [
        {
            "id": shift["id"],
            "name": shift.get("name", ""),
            "password": "__unchanged__" if shift.get("password") else "",
            "has_password": bool(shift.get("password")),
        }
        for shift in shifts
    ]


@app.route("/api/admin/data", methods=["GET"])
@require_admin
def get_admin_data():
    data = db.load_data()
    data["store"]["is_open"] = is_open_now(data["store"])
    sync_store_session_now(data["store"])
    # No devolver hashes ni contraseñas reales al navegador.
    # El admin solo ve un marcador; si no cambia el campo, se conserva la anterior.
    safe_shifts = _safe_shifts(data.get("shifts", []))
    admin_view = {
        "store": data["store"],
        "today_post": data["today_post"],
        "items": data["items"],
        "promotions": data["promotions"],
        "shifts": safe_shifts,
        "pizza_sizes": data["pizza_sizes"],
        "sections": data["sections"],
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

    # Seções extras: se vier algo que não é lista, ignora (não apaga as atuais).
    if "sections" in new_data and not isinstance(new_data["sections"], list):
        del new_data["sections"]

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
    # O admin pode ter mexido em force_status ou nos horários: registra na hora
    # a abertura/fechamento (sem depender do intervalo de 30 s).
    sync_store_session_now({**existing_data["store"], **store_in}, force=True)
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
    """Filtra pedidos pelo campo created_at. 'today' = a NOITE atual (da abertura
    da loja até agora, ou até o fechamento se já fechou); sem nenhuma abertura
    registrada ainda, cai no corte antigo (data da loja, horário de Brasil).
    'week' = últimos 7 dias, qualquer outro valor = tudo."""
    if period not in ("today", "week"):
        return orders
    now = db.now_store()
    upper = None
    if period == "today":
        window = _night_window()
        if window:
            cutoff, upper = window
        else:
            cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        cutoff = now - timedelta(days=7)
    result = []
    for o in orders:
        try:
            ts = datetime.fromisoformat(o.get("created_at", ""))
        except ValueError:
            continue
        if ts >= cutoff and (upper is None or ts <= upper):
            result.append(o)
    return result


@app.route("/api/admin/pedidos/historico", methods=["GET"])
@require_admin
def admin_pedidos_historico():
    """Histórico dos pedidos feitos pelo site (os mesmos que passam pelo
    painel da cozinha), com o total de pizzas vendidas separado por tipo de
    entrega. period: 'today' (padrão), 'week' ou 'all'."""
    period = request.args.get("period", "today")
    sync_store_session_now()   # limitado a 1x/30 s; garante a noite certa mesmo sem visitas ao site
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
        # Noite atual (ou a última que fechou) e as últimas aberturas/fechamentos.
        "night": db.get_current_store_session(),
        "sessions": db.list_store_sessions(10),
    })


@app.route("/api/admin/pedidos/historico/limpar-hoje", methods=["POST"])
@require_admin
def admin_limpar_historico_hoje():
    """Apaga do histórico os pedidos DESTA NOITE (o mesmo corte de "hoje" do
    admin) que já terminaram (entregues ou cancelados). Pedidos ainda em
    andamento (confirmado/preparando/pronto/em_rota) nunca são apagados por
    aqui, pra não quebrar o painel da cozinha nem o acompanhamento do cliente."""
    sync_store_session_now(force=True)
    orders = _orders_in_period(db.list_all_orders(), "today")
    ids = [o["id"] for o in orders if o.get("stage") in ("entregue", "cancelado")]
    deleted = db.delete_orders(ids)
    return jsonify({"ok": True, "deleted": deleted})


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

    week_ago = db.now_store() - timedelta(days=7)
    total_semana = 0.0
    for s in sales:
        try:
            ts = datetime.fromisoformat(s.get("timestamp", ""))
        except ValueError:
            continue
        if ts >= week_ago:
            total_semana += float(s.get("total", 0))
    total_semana = round(total_semana, 2)

    # Total desta noite (mesmo corte de "Noite" no histórico). None = ainda não há
    # nenhuma abertura registrada: a tela simplesmente não mostra o cartão.
    total_noite = None
    window = _night_window()
    if window:
        start, end = window
        total_noite = 0.0
        for s in sales:
            try:
                ts = datetime.fromisoformat(s.get("timestamp", ""))
            except ValueError:
                continue
            if ts >= start and (end is None or ts <= end):
                total_noite += float(s.get("total", 0))
        total_noite = round(total_noite, 2)

    recent = sorted(sales, key=lambda s: s.get("timestamp", ""), reverse=True)[:80]

    return jsonify({
        "ok": True,
        "shifts": _safe_shifts(data["shifts"]),
        "sales": recent,
        "stats": {
            "total_geral": total_geral,
            "total_semana": total_semana,
            "total_noite": total_noite,
            "by_shift": by_shift,
        },
    })


# ---------- API dos funcionários ----------

@app.route("/api/employee/login", methods=["POST"])
@rate_limit("employee_login", max_hits=8, window_seconds=300)
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
        "timestamp": db.datetime_now_iso(),
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
