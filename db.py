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

# Pasta onde ficam os dados que NÃO podem se perder (banco e fotos enviadas).
# No Render, defina DATA_DIR=/var/data (o Mount Path do Persistent Disk).
# Sem a variável, usa a pasta do projeto, como antes (bom para rodar local).
DATA_DIR = os.environ.get("DATA_DIR") or BASE_PATH
os.makedirs(DATA_DIR, exist_ok=True)

DB_PATH = os.path.join(DATA_DIR, "pizzaria.db")
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
    whatsapp_number TEXT NOT NULL DEFAULT '',
    print_agent_token TEXT NOT NULL DEFAULT '',
    bordas TEXT NOT NULL DEFAULT '[]',
    pix_key TEXT NOT NULL DEFAULT '',
    pix_name TEXT NOT NULL DEFAULT '',
    pix_city TEXT NOT NULL DEFAULT ''
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

CREATE TABLE IF NOT EXISTS pizza_sizes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    cm INTEGER NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER,
    shift_name TEXT NOT NULL DEFAULT '',
    timestamp TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    total REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    delivery_type TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]',
    total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pendente',
    printed_at TEXT,
    troco_paid_with REAL,
    troco_amount REAL,
    delivery_fee REAL
);

-- Cache de geocodificação: cada endereço só vai UMA vez ao Nominatim.
-- lat/lon/distance_km são fatos do endereço; delivery_fee é a taxa
-- calculada com as regras vigentes na hora (NULL = fora da área).
CREATE TABLE IF NOT EXISTS geocoded_addresses (
    id INTEGER PRIMARY KEY,
    address_text TEXT UNIQUE,
    lat REAL,
    lon REAL,
    distance_km REAL,
    delivery_fee REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    if "print_agent_token" not in existing_columns:
        conn.execute("ALTER TABLE store ADD COLUMN print_agent_token TEXT NOT NULL DEFAULT ''")
        conn.commit()
    if "bordas" not in existing_columns:
        conn.execute("ALTER TABLE store ADD COLUMN bordas TEXT NOT NULL DEFAULT '[]'")
        conn.commit()
    if "pix_key" not in existing_columns:
        conn.execute("ALTER TABLE store ADD COLUMN pix_key TEXT NOT NULL DEFAULT ''")
        conn.commit()
    if "pix_name" not in existing_columns:
        conn.execute("ALTER TABLE store ADD COLUMN pix_name TEXT NOT NULL DEFAULT ''")
        conn.commit()
    if "pix_city" not in existing_columns:
        conn.execute("ALTER TABLE store ADD COLUMN pix_city TEXT NOT NULL DEFAULT ''")
        conn.commit()

    # Troco (vuelto): colunas novas na tabela orders, para bancos criados
    # antes desse recurso existir.
    existing_order_columns = [r["name"] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    if "troco_paid_with" not in existing_order_columns:
        conn.execute("ALTER TABLE orders ADD COLUMN troco_paid_with REAL")
        conn.commit()
    if "troco_amount" not in existing_order_columns:
        conn.execute("ALTER TABLE orders ADD COLUMN troco_amount REAL")
        conn.commit()
    if "delivery_fee" not in existing_order_columns:
        conn.execute("ALTER TABLE orders ADD COLUMN delivery_fee REAL")
        conn.commit()

    # Disponibilidade (produto "esgotado"): coluna nova na tabela items,
    # para bancos criados antes desse recurso existir. Todo item antigo
    # entra como disponível (1), pra não sumir nada do cardápio.
    existing_item_columns = [r["name"] for r in conn.execute("PRAGMA table_info(items)").fetchall()]
    if "available" not in existing_item_columns:
        conn.execute("ALTER TABLE items ADD COLUMN available INTEGER NOT NULL DEFAULT 1")
        conn.commit()

    row = conn.execute("SELECT COUNT(*) AS c FROM store").fetchone()
    is_empty = row["c"] == 0

    # Tamanhos de pizza: se ainda não existe nenhum (banco novo, ou banco
    # de uma versão anterior a esse recurso), cria os padrões da Rey
    # Pizzaria. O admin pode depois editar os preços e nomes.
    sizes_count = conn.execute("SELECT COUNT(*) AS c FROM pizza_sizes").fetchone()["c"]
    if sizes_count == 0:
        conn.executemany(
            "INSERT INTO pizza_sizes (id, name, cm, price, sort_order) VALUES (?, ?, ?, ?, ?)",
            [
                (1, "Broto", 25, 20.0, 1),
                (2, "Média", 30, 30.0, 2),
                (3, "Grande", 40, 40.0, 3),
                (4, "Família", 45, 50.0, 4),
            ],
        )
        conn.commit()

    conn.close()

    if is_empty and os.path.exists(OLD_JSON_PATH):
        _migrate_from_json()
    elif is_empty:
        # Sem data.json para migrar (banco novo, ou o arquivo já foi
        # migrado antes e renomeado para data.json.migrado): garante que
        # sempre exista uma linha padrão em `store` e em `today_post`,
        # senão load_data() devolve {} pra elas e o site quebra ao
        # checar se está aberto (store) ou ao mostrar o post do dia.
        conn = get_connection()
        conn.execute(
            """INSERT OR IGNORE INTO store
            (id, name, logo, address, hours_open, hours_close, force_status, delivery_time, min_order, whatsapp_number, print_agent_token)
            VALUES (1, '', '', '', '18:00', '20:00', NULL, '', 0, '', '')"""
        )
        conn.execute(
            "INSERT OR IGNORE INTO today_post (id, title, text, image) VALUES (1, '', '', '')"
        )
        conn.commit()
        conn.close()


def _migrate_from_json():
    with open(OLD_JSON_PATH, "r", encoding="utf-8") as f:
        old = json.load(f)

    conn = get_connection()
    store = old.get("store", {})
    hours = store.get("hours", {})
    conn.execute(
        """INSERT OR REPLACE INTO store
        (id, name, logo, address, hours_open, hours_close, force_status, delivery_time, min_order, whatsapp_number, print_agent_token)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
            store.get("print_agent_token", ""),
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


# ---------- bordas (bordas recheadas de pizza) ----------

_DEFAULT_BORDAS = [
    {"id": 1, "name": "Catupiry", "price": 10.0},
    {"id": 2, "name": "Cheddar", "price": 10.0},
]


def _load_bordas(store_row):
    raw = store_row["bordas"] if "bordas" in store_row.keys() else None
    if not raw:
        return list(_DEFAULT_BORDAS)
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return list(_DEFAULT_BORDAS)
    if not isinstance(parsed, list) or not parsed:
        return list(_DEFAULT_BORDAS)
    return parsed


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
    size_rows = conn.execute("SELECT * FROM pizza_sizes ORDER BY sort_order, id").fetchall()
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
        "print_agent_token": store_row["print_agent_token"],
        "bordas": _load_bordas(store_row),
        "pix_key": store_row["pix_key"],
        "pix_name": store_row["pix_name"],
        "pix_city": store_row["pix_city"],
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
            "available": bool(r["available"]),
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

    pizza_sizes = [
        {"id": r["id"], "name": r["name"], "cm": r["cm"], "price": r["price"]}
        for r in size_rows
    ]

    return {
        "store": store,
        "today_post": today_post,
        "items": items,
        "promotions": promotions,
        "shifts": shifts,
        "sales": sales,
        "pizza_sizes": pizza_sizes,
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
            (id, name, logo, address, hours_open, hours_close, force_status, delivery_time, min_order, whatsapp_number, print_agent_token, bordas, pix_key, pix_name, pix_city)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                store.get("print_agent_token", ""),
                json.dumps(store.get("bordas") if isinstance(store.get("bordas"), list) else [], ensure_ascii=False),
                store.get("pix_key", ""),
                store.get("pix_name", ""),
                store.get("pix_city", ""),
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
                """INSERT INTO items (id, category, name, price, description, image, promo_extra, featured, available)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    int(item["id"]),
                    item.get("category", ""),
                    item.get("name", ""),
                    float(item.get("price", 0) or 0),
                    item.get("description", ""),
                    item.get("image", ""),
                    float(item.get("promo_extra", 0) or 0),
                    1 if item.get("featured") else 0,
                    0 if item.get("available") is False else 1,
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

        if "pizza_sizes" in new_data:
            conn.execute("DELETE FROM pizza_sizes")
            for order, size in enumerate(new_data.get("pizza_sizes", [])):
                conn.execute(
                    "INSERT INTO pizza_sizes (id, name, cm, price, sort_order) VALUES (?, ?, ?, ?, ?)",
                    (
                        int(size["id"]),
                        size.get("name", ""),
                        int(size.get("cm", 0) or 0),
                        float(size.get("price", 0) or 0),
                        order,
                    ),
                )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def set_item_availability(item_id, available):
    """Liga/desliga um único produto (marcar como 'esgotado' e voltar a
    disponibilizar), sem precisar reescrever o cardápio inteiro. Usado pelo
    botão rápido do admin, que aplica na hora, sem precisar clicar em Salvar."""
    conn = get_connection()
    try:
        cursor = conn.execute(
            "UPDATE items SET available = ? WHERE id = ?",
            (1 if available else 0, int(item_id)),
        )
        conn.commit()
        return cursor.rowcount > 0
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


# ---------- cache de geocodificação (taxa de entrega) ----------

def get_geocoded(address_text):
    """Devolve a linha do cache para esse endereço (já normalizado) ou None."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT address_text, lat, lon, distance_km, delivery_fee FROM geocoded_addresses WHERE address_text = ?",
            (address_text,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def save_geocoded(address_text, lat, lon, distance_km, delivery_fee):
    """Grava (ou atualiza) um endereço geocodificado. UNIQUE em address_text
    evita duplicatas se duas requisições gravarem o mesmo endereço."""
    conn = get_connection()
    try:
        conn.execute(
            """INSERT INTO geocoded_addresses (address_text, lat, lon, distance_km, delivery_fee)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(address_text) DO UPDATE SET
                lat = excluded.lat, lon = excluded.lon,
                distance_km = excluded.distance_km, delivery_fee = excluded.delivery_fee""",
            (address_text, lat, lon, distance_km, delivery_fee),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def update_geocoded_fee(address_text, delivery_fee):
    """Atualiza só a taxa (quando o dono muda a tabela de preços)."""
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE geocoded_addresses SET delivery_fee = ? WHERE address_text = ?",
            (delivery_fee, address_text),
        )
        conn.commit()
    finally:
        conn.close()


# ---------- pedidos do cliente (fila de impressão) ----------
#
# Quando o cliente confirma o pedido no carrinho, o navegador manda o
# pedido para cá (POST /api/pedidos) E abre o WhatsApp. O agente de
# impressão que roda no computador da pizzaria (imprimir_agent.py) fica
# perguntando pra cá "tem pedido novo?" (GET /api/pedidos/pendentes) a
# cada poucos segundos, e quando acha um, manda pra impressora térmica
# e avisa que já imprimiu (POST /api/pedidos/<id>/impresso).

def insert_order(order):
    """Grava um pedido novo do cliente, status inicial 'pendente'."""
    conn = get_connection()
    try:
        cursor = conn.execute(
            """INSERT INTO orders
            (created_at, customer_name, delivery_type, address, payment_method, notes, items_json, total, status, troco_paid_with, troco_amount, delivery_fee)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)""",
            (
                order.get("created_at"),
                order.get("customer_name", ""),
                order.get("delivery_type", ""),
                order.get("address", ""),
                order.get("payment_method", ""),
                order.get("notes", ""),
                json.dumps(order.get("items", []), ensure_ascii=False),
                float(order.get("total", 0) or 0),
                order.get("troco_paid_with"),
                order.get("troco_amount"),
                order.get("delivery_fee"),
            ),
        )
        conn.commit()
        return cursor.lastrowid
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _order_row_to_dict(r):
    return {
        "id": r["id"],
        "created_at": r["created_at"],
        "customer_name": r["customer_name"],
        "delivery_type": r["delivery_type"],
        "address": r["address"],
        "payment_method": r["payment_method"],
        "notes": r["notes"],
        "items": json.loads(r["items_json"]),
        "total": r["total"],
        "status": r["status"],
        "printed_at": r["printed_at"],
        "troco_paid_with": r["troco_paid_with"],
        "troco_amount": r["troco_amount"],
        "delivery_fee": r["delivery_fee"],
    }


def list_pending_orders():
    """Pedidos ainda não impressos, do mais antigo para o mais novo."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM orders WHERE status = 'pendente' ORDER BY id ASC"
    ).fetchall()
    conn.close()
    return [_order_row_to_dict(r) for r in rows]


def mark_order_printed(order_id):
    """Marca um pedido como impresso. Devolve False se o id não existia
    ou já estava marcado (evita reimprimir por engano)."""
    conn = get_connection()
    try:
        cursor = conn.execute(
            "UPDATE orders SET status = 'impresso', printed_at = ? WHERE id = ? AND status = 'pendente'",
            (datetime_now_iso(), order_id),
        )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def datetime_now_iso():
    from datetime import datetime
    return datetime.now().isoformat(timespec="seconds")


def set_print_agent_token(token):
    """Grava o token que o agente de impressão usa para se autenticar,
    sem mexer no resto dos dados da loja."""
    conn = get_connection()
    try:
        conn.execute("UPDATE store SET print_agent_token = ? WHERE id = 1", (token,))
        conn.commit()
    finally:
        conn.close()
