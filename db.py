"""
Banco de dados SQLite da Rey Pizzaria.

Guarda o que NÃO pode aparecer para o cliente público:
- senha do administrador
- turnos dos funcionários e suas senhas
- vendas registradas pelos funcionários
- estoque dos produtos
"""

import os
import sqlite3
from datetime import datetime, timedelta
from werkzeug.security import generate_password_hash, check_password_hash

BASE_PATH = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_PATH, "pizzaria.db")

DEFAULT_ADMIN_PASSWORD = "pizzaria2026"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS turnos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            hora_inicio TEXT NOT NULL,
            hora_fim TEXT NOT NULL,
            password_hash TEXT NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock (
            item_id INTEGER PRIMARY KEY,
            quantity INTEGER NOT NULL DEFAULT 0,
            tracked INTEGER NOT NULL DEFAULT 0
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            turno_id INTEGER,
            turno_label TEXT,
            item_id INTEGER,
            item_name TEXT,
            category TEXT,
            quantity INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            total REAL NOT NULL,
            delivery_type TEXT
        )
    """)

    # senha padrão do admin, se ainda não existir nenhuma
    cur.execute("SELECT value FROM settings WHERE key = 'admin_password_hash'")
    if cur.fetchone() is None:
        cur.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            ("admin_password_hash", generate_password_hash(DEFAULT_ADMIN_PASSWORD)),
        )

    # turno de exemplo, se a tabela estiver vazia
    cur.execute("SELECT COUNT(*) AS c FROM turnos")
    if cur.fetchone()["c"] == 0:
        cur.execute(
            "INSERT INTO turnos (label, hora_inicio, hora_fim, password_hash) VALUES (?, ?, ?, ?)",
            ("Turno 18h-20h", "18:00", "20:00", generate_password_hash("turno1234")),
        )

    conn.commit()
    conn.close()


# ---------- admin ----------

def check_admin_password(password):
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key = 'admin_password_hash'").fetchone()
    conn.close()
    if not row:
        return False
    return check_password_hash(row["value"], password or "")


def set_admin_password(new_password):
    conn = get_conn()
    conn.execute(
        "UPDATE settings SET value = ? WHERE key = 'admin_password_hash'",
        (generate_password_hash(new_password),),
    )
    conn.commit()
    conn.close()


# ---------- turnos ----------

def list_turnos():
    conn = get_conn()
    rows = conn.execute("SELECT id, label, hora_inicio, hora_fim FROM turnos ORDER BY hora_inicio").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_turno(label, hora_inicio, hora_fim, password):
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO turnos (label, hora_inicio, hora_fim, password_hash) VALUES (?, ?, ?, ?)",
        (label, hora_inicio, hora_fim, generate_password_hash(password)),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return new_id


def update_turno(turno_id, label, hora_inicio, hora_fim, password=None):
    conn = get_conn()
    if password:
        conn.execute(
            "UPDATE turnos SET label=?, hora_inicio=?, hora_fim=?, password_hash=? WHERE id=?",
            (label, hora_inicio, hora_fim, generate_password_hash(password), turno_id),
        )
    else:
        conn.execute(
            "UPDATE turnos SET label=?, hora_inicio=?, hora_fim=? WHERE id=?",
            (label, hora_inicio, hora_fim, turno_id),
        )
    conn.commit()
    conn.close()


def delete_turno(turno_id):
    conn = get_conn()
    conn.execute("DELETE FROM turnos WHERE id = ?", (turno_id,))
    conn.commit()
    conn.close()


def check_turno_password(turno_id, password):
    conn = get_conn()
    row = conn.execute("SELECT password_hash, label FROM turnos WHERE id = ?", (turno_id,)).fetchone()
    conn.close()
    if not row:
        return False, None
    if check_password_hash(row["password_hash"], password or ""):
        return True, row["label"]
    return False, None


def get_turno(turno_id):
    conn = get_conn()
    row = conn.execute("SELECT id, label, hora_inicio, hora_fim FROM turnos WHERE id = ?", (turno_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


# ---------- estoque ----------

def get_stock_map():
    conn = get_conn()
    rows = conn.execute("SELECT item_id, quantity, tracked FROM stock").fetchall()
    conn.close()
    return {r["item_id"]: {"quantity": r["quantity"], "tracked": bool(r["tracked"])} for r in rows}


def set_stock(item_id, quantity, tracked=True):
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO stock (item_id, quantity, tracked) VALUES (?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET quantity = excluded.quantity, tracked = excluded.tracked
        """,
        (item_id, quantity, 1 if tracked else 0),
    )
    conn.commit()
    conn.close()


def decrement_stock(item_id, amount):
    """Retorna (ok, mensagem). Só falha se o item tiver controle de estoque ativo e não houver quantidade suficiente."""
    conn = get_conn()
    row = conn.execute("SELECT quantity, tracked FROM stock WHERE item_id = ?", (item_id,)).fetchone()
    if not row or not row["tracked"]:
        conn.close()
        return True, None

    if row["quantity"] < amount:
        conn.close()
        return False, f"Estoque insuficiente (restam {row['quantity']})."

    conn.execute("UPDATE stock SET quantity = quantity - ? WHERE item_id = ?", (amount, item_id))
    conn.commit()
    conn.close()
    return True, None


# ---------- vendas ----------

def register_sale(turno_id, turno_label, item_id, item_name, category, quantity, unit_price, delivery_type=None):
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO sales (timestamp, turno_id, turno_label, item_id, item_name, category, quantity, unit_price, total, delivery_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            datetime.now().isoformat(timespec="seconds"),
            turno_id,
            turno_label,
            item_id,
            item_name,
            category,
            quantity,
            unit_price,
            round(unit_price * quantity, 2),
            delivery_type,
        ),
    )
    conn.commit()
    conn.close()


def _period_start(period):
    now = datetime.now()
    if period == "week":
        start = now - timedelta(days=now.weekday())
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.isoformat(timespec="seconds")


def sales_summary(period="today"):
    """Resumo de vendas: total geral, por turno, e desglose de pizzas por tipo de entrega."""
    start = _period_start(period)
    conn = get_conn()

    total_row = conn.execute(
        "SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(quantity), 0) AS qty FROM sales WHERE timestamp >= ?",
        (start,),
    ).fetchone()

    por_turno = conn.execute(
        """
        SELECT turno_label, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(quantity), 0) AS qty
        FROM sales WHERE timestamp >= ?
        GROUP BY turno_label ORDER BY turno_label
        """,
        (start,),
    ).fetchall()

    pizzas_por_entrega = conn.execute(
        """
        SELECT COALESCE(delivery_type, 'não informado') AS delivery_type, COALESCE(SUM(quantity), 0) AS qty
        FROM sales WHERE timestamp >= ? AND category = 'pizza'
        GROUP BY delivery_type
        """,
        (start,),
    ).fetchall()

    por_categoria = conn.execute(
        """
        SELECT category, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(quantity), 0) AS qty
        FROM sales WHERE timestamp >= ?
        GROUP BY category
        """,
        (start,),
    ).fetchall()

    conn.close()

    return {
        "total": total_row["total"],
        "quantidade": total_row["qty"],
        "por_turno": [dict(r) for r in por_turno],
        "pizzas_por_entrega": [dict(r) for r in pizzas_por_entrega],
        "por_categoria": [dict(r) for r in por_categoria],
    }
