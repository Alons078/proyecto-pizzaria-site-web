# -*- coding: utf-8 -*-
"""
print_format.py - prepara os pedidos para o agente de impressão.

O carrinho do site só guarda o NOME da linha (ex.: "Meia Mussarela / Meia
Calabresa (Grande 35cm) + Borda de Cheddar"). Este módulo lê esse texto e
devolve as escolhas ESTRUTURADAS que o ticket da cozinha precisa:

  pizza normal / meia a meia / 3 sabores:
      {"name": "Pizza Meia / Meia (Grande)", "sabores": ["MUSSARELA", "CALABRESA"],
       "borda": "CHEDDAR", "pizzas": []}

  promoção (cada pizza com seu tamanho, sabores e borda):
      {"name": "Promo 2 pizzas", "sabores": [], "borda": "",
       "pizzas": [{"rotulo": "PIZZA 1 (GRANDE)", "sabores": ["CALABRESA"], "borda": "CHEDDAR"}, ...]}

  bebida / salgado: só o nome, sem sabores.

Os formatos de texto vêm de produto.js (fullProductName) e promocao.js
(chosenSlotNames). Se mudar o texto lá, ajuste as expressões aqui.
"""

import re

_SIZE_RE = re.compile(r"\s*\(([^()]+?)\s+(\d+(?:[.,]\d+)?)\s*cm\)\s*$", re.IGNORECASE)
_PROMO_RE = re.compile(r"^(?P<promo>.+?) \((?P<slots>[^()|:]+(?: \([^()]*\))?: .+)\)$")
_SLOT_RE = re.compile(r"^(?P<label>[^:()]+?)(?: \((?P<size>[^()]*)\))?: (?P<chosen>.+)$")
_BORDA_SEP = " + Borda de "


def _tirar_borda(texto):
    """'X + Borda de Cheddar' -> ('X', 'Cheddar')."""
    i = texto.rfind(_BORDA_SEP)
    if i == -1:
        return texto.strip(), ""
    return texto[:i].strip(), texto[i + len(_BORDA_SEP):].strip()


def _separar_sabores(texto):
    texto = texto.strip()
    m = re.match(r"^Meia (.+?) / Meia (.+)$", texto)
    if m:
        a, b = m.group(1).strip(), m.group(2).strip()
        return [a] if a == b else [a, b]
    if texto.startswith("1/3 "):
        return [re.sub(r"^1/3\s+", "", p).strip() for p in texto.split(" + ") if p.strip()]
    return [texto] if texto else []


def _promocao(nome):
    m = _PROMO_RE.match(nome)
    if not m:
        return None
    pizzas = []
    for slot in m.group("slots").split(" | "):
        sm = _SLOT_RE.match(slot.strip())
        if not sm:
            return None
        escolhido, borda = _tirar_borda(sm.group("chosen"))
        rotulo = sm.group("label").strip()
        if sm.group("size"):
            rotulo += f" ({sm.group('size').strip()})"
        pizzas.append({
            "rotulo": rotulo.upper(),
            "sabores": [s.upper() for s in _separar_sabores(escolhido)],
            "borda": borda.upper(),
        })
    return m.group("promo").strip(), pizzas


def formatar_item(item):
    """Um item do pedido -> item pronto para imprimir."""
    bruto = str(item.get("name") or "")
    saida = {
        "qty": item.get("qty", 1),
        "unit_price": item.get("unit_price", 0),
        "name": bruto,
        "original_name": bruto,
        "sabores": [],
        "borda": "",
        "pizzas": [],
        # o site ainda não guarda observação por item; se um dia guardar
        # (campo "obs" ou "note"), já sai no ticket.
        "obs": str(item.get("obs") or item.get("note") or ""),
    }

    promo = _promocao(bruto)
    if promo:
        saida["name"], saida["pizzas"] = promo
        return saida

    resto, borda = _tirar_borda(bruto)
    tamanho = ""
    m = _SIZE_RE.search(resto)
    if m:
        tamanho = m.group(1).strip()
        resto = resto[:m.start()].strip()

    try:
        eh_pizza = bool(m) or int(item.get("pizza_count") or 0) > 0
    except (TypeError, ValueError):
        eh_pizza = bool(m)
    if not eh_pizza:  # bebida, salgado...: mantém o nome como está
        return saida

    sabores = _separar_sabores(resto)
    n = len(sabores)
    if n == 2 and sabores[0] != sabores[1]:
        titulo = "Pizza Meia / Meia"
    elif n >= 3:
        titulo = f"Pizza {n} sabores"
    else:
        titulo = "Pizza"
    if tamanho:
        titulo = f"{titulo} ({tamanho})" if titulo != "Pizza" else f"Pizza {tamanho}"

    saida["name"] = titulo
    saida["sabores"] = [s.upper() for s in sabores]
    saida["borda"] = borda.upper()
    return saida


def pedido_para_impressao(pedido):
    """Pedido vindo de db.list_pending_orders() -> JSON para o agente."""
    itens = [formatar_item(i) for i in (pedido.get("items") or []) if isinstance(i, dict)]
    subtotal = 0.0
    for i in itens:
        try:
            subtotal += float(i["unit_price"]) * int(i["qty"])
        except (TypeError, ValueError):
            pass
    saida = dict(pedido)
    saida["items"] = itens
    saida["subtotal"] = round(subtotal, 2)
    # delivery_fee continua None quando a taxa é "a combinar" pelo WhatsApp.
    return saida
