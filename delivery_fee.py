"""
Taxa de entrega da Rey Pizzaria — por zona, sem geocodificação.

Fluxo (chamado por POST /api/calcular-tarifa em app.py):

1. O cliente escolhe a zona (botões "Piscinão de Ramos" / "Ramos") e digita
   rua/número; o front-end (static/cart.js) monta o endereço final como
   "<rua>, <zona>".
2. Este módulo só confere se o texto contém o nome de uma zona conhecida
   (comparação por substring, sem acentos nem maiúsculas/minúsculas) e
   devolve a taxa fixa correspondente. Não há chamada a nenhuma API externa
   nem cálculo de distância — é só combinar texto.
3. Se o endereço não citar nenhuma zona conhecida, não há taxa automática:
   o pedido segue com "taxa a combinar" (resolvida pela pizzaria no
   WhatsApp), exatamente como qualquer outra falha do cálculo automático.

Configuração (variável de ambiente no Render, opcional):

- NEIGHBORHOOD_FEES -> taxas fixas por zona, em formato JSON
                     '{"nome da zona": valor, ...}'. Padrão:
                     {"piscinão de ramos": 3, "ramos": 10}
"""

import json
import os
import re
import unicodedata


MAX_ADDRESS_LENGTH = 200


# ---------- erros ----------

class DeliveryFeeError(Exception):
    """Base. `code` vai para o frontend; `message` é o texto para o cliente."""
    code = "error"
    status = 500
    message = "Não foi possível calcular a taxa agora."

    def __init__(self, message=None, **extra):
        super().__init__(message or self.message)
        self.message = message or self.message
        self.extra = extra


class InvalidAddress(DeliveryFeeError):
    code, status = "invalid_address", 400
    message = "Digite o endereço de entrega."


class AddressNotFound(DeliveryFeeError):
    code, status = "address_not_found", 404
    message = "Não encontramos uma zona de entrega conhecida nesse endereço."


# ---------- funções puras ----------

def normalize_address(text):
    """Minúsculas, sem acentos, espaços e pontuação nas pontas normalizados.
    'Rua  São  José, 10 ' e 'rua sao jose, 10' viram o mesmo texto."""
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"\s+", " ", text.lower()).strip(" ,.;-")
    return text


# ---------- taxas fixas por zona ----------
# Endereços que contêm um desses nomes usam a taxa fixa direto.
# Configurável por NEIGHBORHOOD_FEES (veja o topo do arquivo).

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
    """Devolve (zona, taxa) se o endereço citar uma zona com taxa fixa,
    senão None. Comparação por substring, sem acentos nem maiúsculas."""
    key = normalize_address(address)
    for bairro, taxa in NEIGHBORHOOD_FEES:
        if bairro in key:
            return bairro, taxa
    return None


# ---------- API pública do módulo ----------

def lookup_cached_fee(address):
    """Só consulta taxa fixa por zona. Usado ao registrar o pedido, para o
    servidor não confiar na taxa enviada pelo navegador. Devolve a taxa
    (float) ou None se o endereço não citar nenhuma zona conhecida."""
    match = match_neighborhood_fee(str(address or ""))
    return match[1] if match else None


def calculate_fee(address):
    """Devolve {"fee", "distance_km", "cached"} ou levanta DeliveryFeeError.
    distance_km vem sempre None (mantido por compatibilidade com o front-end,
    que já sabe exibir a taxa sem distância quando ela é fixa por zona)."""
    address = str(address or "").strip()
    if not address:
        raise InvalidAddress()
    if len(address) > MAX_ADDRESS_LENGTH:
        raise InvalidAddress("Endereço muito longo.")

    match = match_neighborhood_fee(address)
    if not match:
        raise AddressNotFound()

    _, fee = match
    return {"fee": fee, "distance_km": None, "cached": True}
