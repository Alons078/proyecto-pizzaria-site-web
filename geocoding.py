"""
Taxa de entrega automática da Rey Pizzaria.

Fluxo (chamado por POST /api/calcular-tarifa em app.py):

0. Se o endereço contém o nome de um bairro com taxa fixa (NEIGHBORHOOD_FEES),
   devolve essa taxa na hora — sem geocodificar, sem gastar consulta ao
   Nominatim. É a exceção às regras abaixo.
1. Senão, normaliza o endereço e procura em `geocoded_addresses` (cache).
2. Se achou -> devolve a taxa sem chamar nenhuma API externa.
3. Se não achou -> coloca o endereço numa fila. UMA thread trabalhadora
   consulta o Nominatim (OpenStreetMap) no máximo 1 vez por segundo.
4. Com lat/lon, calcula a distância em linha reta (Haversine) até a pizzaria.
5. Aplica a regra de taxa por distância e grava tudo no cache.

Configuração (variáveis de ambiente no Render; todas opcionais menos as
coordenadas da pizzaria):

- NEIGHBORHOOD_FEES -> taxas fixas por bairro, em formato JSON
                     '{"nome do bairro": valor, ...}'. Quando o endereço
                     digitado contém esse texto (sem diferenciar maiúsculas
                     ou acentos), usa essa taxa fixa direto, sem geocodificar.
                     Padrão: {"piscinão de ramos": 3, "ramos": 10}
                     Ex. no Render: {"piscinão de ramos": 3, "ramos": 10, "penha": 7}
- PIZZERIA_LAT / PIZZERIA_LON -> coordenadas da pizzaria, para o cálculo
                                 automático por distância nos demais endereços
                                 (opcional se todos os bairros tiverem taxa
                                 fixa; senão, esses endereços saem "a combinar").
                                 Ex.: abra o Google Maps, clique com o botão
                                 direito no ponto da loja e copie os números.
- FEE_RADIUS_KM   -> raio da taxa base (padrão 3.0)
- FEE_BASE        -> taxa até FEE_RADIUS_KM, em R$ (padrão 5.00)  <- combinar com o dono
- FEE_EXTRA       -> taxa acima de FEE_RADIUS_KM, em R$ (padrão 8.00)  <- combinar com o dono
- MAX_DELIVERY_KM -> acima disso não entrega automático (padrão 10.0). Protege
                     contra o Nominatim achar uma rua homônima em outra cidade.
- GEOCODE_CONTEXT -> texto acrescentado à busca quando o cliente não digita a
                     cidade (padrão "Rio de Janeiro, RJ, Brasil")
- NOMINATIM_USER_AGENT -> identifica o app para o Nominatim (padrão
                     "Rey-Pizzaria/1.0"; a política deles pede um contato,
                     ex.: "Rey-Pizzaria/1.0 (contato@seudominio.com)")

IMPORTANTE: a fila vive na memória do processo. Ela só garante 1 req/s se o
gunicorn roda com UM worker (use threads para concorrência):
    web: gunicorn app:app --workers 1 --threads 4 --timeout 30
"""

import json
import math
import os
import queue
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

import db


def _env_float(name, default):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw.replace(",", "."))
    except ValueError:
        print(f"AVISO: {name}={raw!r} não é um número — usando {default}.")
        return default


# ---------- configuração ----------

PIZZERIA_LAT = _env_float("PIZZERIA_LAT", None)
PIZZERIA_LON = _env_float("PIZZERIA_LON", None)

FEE_RADIUS_KM = _env_float("FEE_RADIUS_KM", 3.0)
FEE_BASE = _env_float("FEE_BASE", 5.0)
FEE_EXTRA = _env_float("FEE_EXTRA", 8.0)
MAX_DELIVERY_KM = _env_float("MAX_DELIVERY_KM", 10.0)

GEOCODE_CONTEXT = os.environ.get("GEOCODE_CONTEXT", "Rio de Janeiro, RJ, Brasil")
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_USER_AGENT = os.environ.get("NOMINATIM_USER_AGENT", "Rey-Pizzaria/1.0")

MIN_INTERVAL_SECONDS = 1.0     # política do Nominatim público: no máximo 1 req/s
HTTP_TIMEOUT_SECONDS = 8       # tempo máximo de uma chamada ao Nominatim
WAIT_TIMEOUT_SECONDS = 20      # quanto a requisição do cliente espera na fila
QUEUE_MAX = 15                 # fila cheia -> "tente novamente" (proteção contra abuso)
MAX_ADDRESS_LENGTH = 200
EARTH_RADIUS_KM = 6371.0


def is_configured():
    return PIZZERIA_LAT is not None and PIZZERIA_LON is not None


# ---------- erros ----------

class GeocodingError(Exception):
    """Base. `code` vai para o frontend; `message` é o texto para o cliente."""
    code = "error"
    status = 500
    message = "Não foi possível calcular a taxa agora."

    def __init__(self, message=None, **extra):
        super().__init__(message or self.message)
        self.message = message or self.message
        self.extra = extra


class NotConfigured(GeocodingError):
    code, status = "not_configured", 503
    message = "Cálculo automático de taxa indisponível no momento."


class InvalidAddress(GeocodingError):
    code, status = "invalid_address", 400
    message = "Digite o endereço de entrega."


class AddressNotFound(GeocodingError):
    code, status = "address_not_found", 404
    message = "Não encontramos esse endereço. Confira rua, número e bairro."


class OutOfArea(GeocodingError):
    code, status = "out_of_area", 422
    message = "Esse endereço fica fora da nossa área de entrega automática."


class ServiceBusy(GeocodingError):
    code, status = "busy", 503
    message = "Muitas consultas agora. Tente de novo em alguns segundos."


class ServiceUnavailable(GeocodingError):
    code, status = "unavailable", 503
    message = "Não foi possível consultar o mapa agora."


# ---------- funções puras ----------

def normalize_address(text):
    """Chave do cache: minúsculas, sem acentos, espaços e pontuação nas pontas
    normalizados. 'Rua  São  José, 10 ' e 'rua sao jose, 10' são o mesmo endereço."""
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"\s+", " ", text.lower()).strip(" ,.;-")
    return text


def haversine_km(lat1, lon1, lat2, lon2):
    """Distância em linha reta entre dois pontos (graus), em km."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def fee_for_distance(distance_km):
    """Regra de taxa. Devolve o valor em R$ ou None se estiver fora da área."""
    if distance_km > MAX_DELIVERY_KM:
        return None
    return round(FEE_BASE if distance_km <= FEE_RADIUS_KM else FEE_EXTRA, 2)


# ---------- taxas fixas por bairro ----------
# Endereços que contêm um desses nomes usam a taxa fixa direto, sem
# geocodificar. Configurável por NEIGHBORHOOD_FEES (veja o topo do arquivo).

_DEFAULT_NEIGHBORHOOD_FEES = [("piscinão de ramos", 3.0), ("ramos", 10.0)]


def _load_neighborhood_fees(name="NEIGHBORHOOD_FEES", default=_DEFAULT_NEIGHBORHOOD_FEES):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        pairs = default
    else:
        try:
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError('esperado um objeto JSON {"bairro": valor}')
            pairs = list(parsed.items())
        except (json.JSONDecodeError, ValueError) as exc:
            print(f"AVISO: {name} inválido ({exc}) — usando o padrão.")
            pairs = default
    normalized = []
    for bairro, valor in pairs:
        key = normalize_address(bairro)
        try:
            valor = round(float(str(valor).replace(",", ".")), 2)
        except (TypeError, ValueError):
            print(f"AVISO: taxa inválida para o bairro {bairro!r} em {name} — ignorada.")
            continue
        if key:
            normalized.append((key, valor))
    # Mais específico primeiro: "piscinão de ramos" antes de "ramos", senão
    # um endereço no Piscinão bateria primeiro na regra genérica de Ramos.
    normalized.sort(key=lambda par: len(par[0]), reverse=True)
    return normalized


NEIGHBORHOOD_FEES = _load_neighborhood_fees()


def match_neighborhood_fee(address):
    """Devolve (bairro, taxa) se o endereço citar um bairro com taxa fixa,
    senão None. Comparação por substring, sem acentos nem maiúsculas."""
    key = normalize_address(address)
    for bairro, taxa in NEIGHBORHOOD_FEES:
        if bairro in key:
            return bairro, taxa
    return None


# ---------- Nominatim ----------

def _nominatim_search(query):
    """Uma chamada ao Nominatim. Devolve (lat, lon) ou levanta AddressNotFound /
    ServiceUnavailable. NÃO controla o ritmo — quem controla é o worker."""
    params = urllib.parse.urlencode({
        "q": query,
        "format": "json",
        "limit": 1,
        "countrycodes": "br",
    })
    request = urllib.request.Request(
        f"{NOMINATIM_URL}?{params}",
        headers={"User-Agent": NOMINATIM_USER_AGENT, "Accept-Language": "pt-BR"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            results = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        print(f"AVISO: falha ao consultar o Nominatim: {exc}")
        raise ServiceUnavailable() from exc

    if not results:
        raise AddressNotFound()
    try:
        return float(results[0]["lat"]), float(results[0]["lon"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ServiceUnavailable() from exc


def _search_query(address):
    """Acrescenta a cidade se o cliente não a digitou (melhora muito a precisão)."""
    if GEOCODE_CONTEXT:
        first_part = normalize_address(GEOCODE_CONTEXT.split(",")[0])
        if first_part and first_part not in normalize_address(address):
            return f"{address}, {GEOCODE_CONTEXT}"
    return address


# ---------- fila + worker ----------

class _Job:
    def __init__(self, key, address):
        self.key = key
        self.address = address
        self.event = threading.Event()
        self.result = None   # dict pronto para devolver ao cliente
        self.error = None    # GeocodingError


_queue = queue.Queue(maxsize=QUEUE_MAX)
_pending = {}                       # key -> _Job (dedupe: mesmo endereço = mesma consulta)
_pending_lock = threading.Lock()
_worker_lock = threading.Lock()
_worker_thread = None


def _ensure_worker():
    global _worker_thread
    with _worker_lock:
        if _worker_thread is None or not _worker_thread.is_alive():
            _worker_thread = threading.Thread(target=_worker_loop, name="geocoder", daemon=True)
            _worker_thread.start()


def _process(job):
    """Roda no worker: Nominatim -> distância -> taxa -> cache."""
    lat, lon = _nominatim_search(_search_query(job.address))
    distance = round(haversine_km(PIZZERIA_LAT, PIZZERIA_LON, lat, lon), 2)
    fee = fee_for_distance(distance)
    # Grava mesmo quando está fora da área (fee = NULL): evita reconsultar.
    db.save_geocoded(job.key, lat, lon, distance, fee)
    return _build_result(distance, fee, cached=False)


def _worker_loop():
    last_call = 0.0
    while True:
        job = _queue.get()
        try:
            wait = MIN_INTERVAL_SECONDS - (time.monotonic() - last_call)
            if wait > 0:
                time.sleep(wait)
            try:
                job.result = _process(job)
            except GeocodingError as exc:
                job.error = exc
            except Exception as exc:  # não deixa a thread morrer por um bug
                print(f"ERRO inesperado no geocoder: {exc!r}")
                job.error = ServiceUnavailable()
            last_call = time.monotonic()
        finally:
            with _pending_lock:
                _pending.pop(job.key, None)
            job.event.set()
            _queue.task_done()


def _build_result(distance, fee, cached):
    if fee is None:
        raise OutOfArea(
            f"Esse endereço fica a {distance:.1f} km, fora da nossa área de entrega automática.",
            distance_km=distance,
        )
    return {"fee": fee, "distance_km": distance, "cached": cached}


def _from_cache(key):
    """Resultado a partir do cache. A taxa é RECALCULADA com as regras atuais
    (se o dono mudar os preços, endereços antigos acompanham) e o valor
    gravado é corrigido se estiver desatualizado."""
    row = db.get_geocoded(key)
    if not row or row["distance_km"] is None:
        return None
    fee = fee_for_distance(row["distance_km"])
    if row["delivery_fee"] != fee:
        db.update_geocoded_fee(key, fee)
    return _build_result(row["distance_km"], fee, cached=True)


# ---------- API pública do módulo ----------

def lookup_cached_fee(address):
    """Só consulta taxa fixa por bairro ou cache (nunca chama API externa).
    Usado ao registrar o pedido, para o servidor não confiar na taxa enviada
    pelo navegador. Devolve a taxa (float) ou None se não houver taxa válida."""
    address = str(address or "")
    match = match_neighborhood_fee(address)
    if match:
        return match[1]
    key = normalize_address(address)
    if not key or not is_configured():
        return None
    try:
        return _from_cache(key)["fee"]
    except (GeocodingError, TypeError):
        return None


def calculate_fee(address):
    """Devolve {"fee", "distance_km", "cached"} ou levanta GeocodingError.
    distance_km vem None quando a taxa veio de um bairro com preço fixo."""
    address = str(address or "").strip()
    if not address:
        raise InvalidAddress()
    if len(address) > MAX_ADDRESS_LENGTH:
        raise InvalidAddress("Endereço muito longo.")

    match = match_neighborhood_fee(address)
    if match:
        return {"fee": match[1], "distance_km": None, "cached": True}

    if not is_configured():
        print("AVISO: PIZZERIA_LAT/PIZZERIA_LON não definidos — taxa automática desligada.")
        raise NotConfigured()

    key = normalize_address(address)
    if not key:
        raise InvalidAddress()

    cached = _from_cache(key)
    if cached:
        return cached

    with _pending_lock:
        job = _pending.get(key)
        if job is None:
            # Reconfere o cache dentro do lock: outra requisição pode ter
            # terminado entre a checagem acima e agora.
            cached = _from_cache(key)
            if cached:
                return cached
            job = _Job(key, address)
            try:
                _queue.put_nowait(job)
            except queue.Full:
                raise ServiceBusy()
            _pending[key] = job

    _ensure_worker()
    if not job.event.wait(WAIT_TIMEOUT_SECONDS):
        raise ServiceBusy()
    if job.error:
        raise job.error
    return job.result
