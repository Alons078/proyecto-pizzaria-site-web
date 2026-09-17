"""
Banco de dados SQLite da Rey Pizzaria.

Substitui o antigo data.json. Continua entregando os mesmos dicionários
Python que o app.py já sabe usar, então o resto do código quase não muda.

Diferença importante em relação ao JSON:
- Registrar uma venda agora é UM INSERT numa linha da tabela `sales`,
  não uma reescrita do arquivo inteiro. Isso é o que evita que duas vendas
  ao mesmo tempo se atropelem ou corrompam os dados.
- O SQLite cuida sozinho de travar a escrita quando duas requisições
  chegam ao mesmo tempo (uma espera meio milissegundo pela outra, em vez
  de corromper o arquivo).

O arquivo do banco (pizzaria.db) fica na mesma pasta do projeto.
"""

import sqlite3
import json
import os

BASE_PATH = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_PATH, "pizzaria.db")
OLD_JSON_PATH = os.path.join(BASE_PATH, "data.json")

SCHEMA = """
CREATE TABLE IF NOT EXISTS store (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT '',
    logo TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    hours_open TEXT NOT NULL DEFAULT '18:00',
    hours_close TEXT NOT NULL DEFAULT '20:00',
    force_status INTEGER,
    delivery_time TEXT NOT NULL DEFAULT '',
    min_order REAL NOT NULL DEFAULT 0,
    whatsapp_number TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS today_post (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    promo_extra REAL NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    slots_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER,
    shift_name TEXT NOT NULL DEFAULT '',
    timestamp TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    total REAL NOT NULL DEFAULT 0
);
"""


def get_connection():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    # WAL: permite que leituras (menu do cliente) e escritas (uma venda)
    # aconteçam ao mesmo tempo sem se bloquear.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Cria as tabelas se não existirem. Se o banco está vazio e existe um
    data.json antigo, migra os dados de lá uma única vez."""
    conn = get_connection()
    conn.executescript(SCHEMA)
    conn.commit()

    # Se o banco já existia de uma versão anterior (antes da coluna
    # whatsapp_number existir), adiciona a coluna sem apagar nada.
    existing_columns = [r["name"] for r in conn.execute("PRAGMA table_info(store)").fetchall()]
    if "whatsapp_number" not in existing_columns:
        conn.execute("ALTER TABLE store ADD COLUMN whatsapp_number TEXT NOT NULL DEFAULT ''")
        conn.commit()

    row = conn.execute("SELECT COUNT(*) AS c FROM store").fetchone()
    is_empty = row["c"] == 0
    conn.close()

    if is_empty and os.path.exists(OLD_JSON_PATH):
        _migrate_from_json()


def _migrate_from_json():
    with open(OLD_JSON_PATH, "r", encoding="utf-8") as f:
        old = json.load(f)

    conn = get_connection()
    store = old.get("store", {})
    hours = store.get("hours", {})
    conn.execute(
        """INSERT OR REPLACE INTO store
        (id, name, logo, address, hours_open, hours_close, force_status, delivery_time, min_order, whatsapp_number)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            store.get("name", ""),
            store.get("logo", ""),
            store.get("address", ""),
            hours.get("open", "18:00"),
            hours.get("close", "20:00"),
            _bool_to_int_or_none(store.get("force_status")),
            store.get("delivery_time", ""),
            float(store.get("min_order", 0) or 0),
            store.get("whatsapp_number", ""),
        ),
    )

    post = old.get("today_post", {})
    conn.execute(
        "INSERT OR REPLACE INTO today_post (id, title, text, image) VALUES (1, ?, ?, ?)",
        (post.get("title", ""), post.get("text", ""), post.get("image", "")),
    )

    for item in old.get("items", []):
        conn.execute(
            """INSERT OR REPLACE INTO items
            (id, category, name, price, description, image, promo_extra, featured)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                int(item["id"]),
                item.get("category", ""),
                item.get("name", ""),
                float(item.get("price", 0) or 0),
                item.get("description", ""),
                item.get("image", ""),
                float(item.get("promo_extra", 0) or 0),
                1 if item.get("featured") else 0,
            ),
        )

    for promo in old.get("promotions", []):
        conn.execute(
            """INSERT OR REPLACE INTO promotions
            (id, name, description, image, price, slots_json)
            VALUES (?, ?, ?, ?, ?, ?)""",
            (
                int(promo["id"]),
                promo.get("name", ""),
                promo.get("description", ""),
                promo.get("image", ""),
                float(promo.get("price", 0) or 0),
                json.dumps(promo.get("slots", []), ensure_ascii=False),
            ),
        )

    for shift in old.get("shifts", []):
        conn.execute(
            "INSERT OR REPLACE INTO shifts (id, name, password) VALUES (?, ?, ?)",
            (int(shift["id"]), shift.get("name", ""), shift.get("password", "")),
        )

    for sale in old.get("sales", []):
        conn.execute(
            """INSERT OR REPLACE INTO sales (id, shift_id, shift_name, timestamp, items_json, total)
            VALUES (?, ?, ?, ?, ?, ?)""",
            (
                int(sale["id"]),
                sale.get("shift_id"),
                sale.get("shift_name", ""),
                sale.get("timestamp", ""),
                json.dumps(sale.get("items", []), ensure_ascii=False),
                float(sale.get("total", 0) or 0),
            ),
        )

    conn.commit()
    conn.close()

    backup_path = OLD_JSON_PATH + ".migrado"
    if not os.path.exists(backup_path):
        os.rename(OLD_JSON_PATH, backup_path)


def _bool_to_int_or_none(value):
    if value is None:
        return None
    return 1 if value else 0


def _int_to_bool_or_none(value):
    if value is None:
        return None
    return bool(value)


# ---------- leitura ----------

def load_data():
    """Devolve o mesmo formato de dicionário que o antigo data.json tinha,
    para que o resto do app.py não precise mudar sua lógica interna."""
    conn = get_connection()

    store_row = conn.execute("SELECT * FROM store WHERE id = 1").fetchone()
    post_row = conn.execute("SELECT * FROM today_post WHERE id = 1").fetchone()
    item_rows = conn.execute("SELECT * FROM items ORDER BY id").fetchall()
    promo_rows = conn.execute("SELECT * FROM promotions ORDER BY id").fetchall()
    shift_rows = conn.execute("SELECT * FROM shifts ORDER BY id").fetchall()
    sale_rows = conn.execute("SELECT * FROM sales ORDER BY id").fetchall()
    conn.close()

    store = {
        "name": store_row["name"],
        "logo": store_row["logo"],
        "address": store_row["address"],
        "hours": {"open": store_row["hours_open"], "close": store_row["hours_close"]},
        "force_status": _int_to_bool_or_none(store_row["force_status"]),
        "delivery_time": store_row["delivery_time"],
        "min_order": store_row["min_order"],
        "whatsapp_number": store_row["whatsapp_number"],
    } if store_row else {}

    today_post = {
        "title": post_row["title"],
        "text": post_row["text"],
        "image": post_row["image"],
    } if post_row else {}

    items = [
        {
            "id": r["id"],
            "category": r["category"],
            "name": r["name"],
            "price": r["price"],
            "description": r["description"],
            "image": r["image"],
            "promo_extra": r["promo_extra"],
            "featured": bool(r["featured"]),
        }
        for r in item_rows
    ]

    promotions = [
        {
            "id": r["id"],
            "name": r["name"],
            "description": r["description"],
            "image": r["image"],
            "price": r["price"],
            "slots": json.loads(r["slots_json"]),
        }
        for r in promo_rows
    ]

    shifts = [
        {"id": r["id"], "name": r["name"], "password": r["password"]}
        for r in shift_rows
    ]

    sales = [
        {
            "id": r["id"],
            "shift_id": r["shift_id"],
            "shift_name": r["shift_name"],
            "timestamp": r["timestamp"],
            "items": json.loads(r["items_json"]),
            "total": r["total"],
        }
        for r in sale_rows
    ]

    return {
        "store": store,
        "today_post": today_post,
        "items": items,
        "promotions": promotions,
        "shifts": shifts,
        "sales": sales,
    }


# ---------- escrita (painel do admin: cardápio, turnos, loja) ----------

def save_menu_data(new_data):
    """Substitui loja, post do dia, itens, promoções e turnos.
    NÃO mexe na tabela de vendas — essa é só via insert_sale(), para nunca
    travar o registro de vendas por causa de uma edição do admin."""
    conn = get_connection()
    try:
        store = new_data.get("store", {})
        hours = store.get("hours", {})
        conn.execute(
            """INSERT OR REPLACE INTO store
            (id, name, logo, address, hours_open, hours_close, force_status, delivery_time, min_order, whatsapp_number)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                store.get("name", ""),
                store.get("logo", ""),
                store.get("address", ""),
                hours.get("open", "18:00"),
                hours.get("close", "20:00"),
                _bool_to_int_or_none(store.get("force_status")),
                store.get("delivery_time", ""),
                float(store.get("min_order", 0) or 0),
                store.get("whatsapp_number", ""),
            ),
        )

        post = new_data.get("today_post", {})
        conn.execute(
            "INSERT OR REPLACE INTO today_post (id, title, text, image) VALUES (1, ?, ?, ?)",
            (post.get("title", ""), post.get("text", ""), post.get("image", "")),
        )

        conn.execute("DELETE FROM items")
        for item in new_data.get("items", []):
            conn.execute(
                """INSERT INTO items (id, category, name, price, description, image, promo_extra, featured)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    int(item["id"]),
                    item.get("category", ""),
                    item.get("name", ""),
                    float(item.get("price", 0) or 0),
                    item.get("description", ""),
                    item.get("image", ""),
                    float(item.get("promo_extra", 0) or 0),
                    1 if item.get("featured") else 0,
                ),
            )

        conn.execute("DELETE FROM promotions")
        for promo in new_data.get("promotions", []):
            conn.execute(
                """INSERT INTO promotions (id, name, description, image, price, slots_json)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    int(promo["id"]),
                    promo.get("name", ""),
                    promo.get("description", ""),
                    promo.get("image", ""),
                    float(promo.get("price", 0) or 0),
                    json.dumps(promo.get("slots", []), ensure_ascii=False),
                ),
            )

        conn.execute("DELETE FROM shifts")
        for shift in new_data.get("shifts", []):
            conn.execute(
                "INSERT INTO shifts (id, name, password) VALUES (?, ?, ?)",
                (int(shift["id"]), shift.get("name", ""), shift.get("password", "")),
            )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------- escrita (funcionários: uma venda por vez) ----------

def insert_sale(sale):
    """Insere UMA venda. É só isso que acontece quando um funcionário
    registra uma venda — nunca reescreve o restante dos dados."""
    conn = get_connection()
    try:
        cursor = conn.execute(
            """INSERT INTO sales (shift_id, shift_name, timestamp, items_json, total)
            VALUES (?, ?, ?, ?, ?)""",
            (
                sale.get("shift_id"),
                sale.get("shift_name", ""),
                sale.get("timestamp", ""),
                json.dumps(sale.get("items", []), ensure_ascii=False),
                float(sale.get("total", 0) or 0),
            ),
        )
        conn.commit()
        new_id = cursor.lastrowid
        return new_id
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
