#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Aplica as melhorias da página do entregador (Rey Pizzaria).

Como usar: copie este arquivo para a PASTA DO PROJETO (junto de app.py) e rode
    python aplicar_mejoras_entregador.py

- Só grava algo se TODOS os trechos forem encontrados (senão avisa e não muda nada).
- Guarda cópia dos originais em _backup_antes_entregador/ (pode apagar depois).
- Respeita o formato de fim de linha (CRLF/LF) de cada arquivo.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKUP_DIR = ROOT / "_backup_antes_entregador"

files = {}
errors = []


def load(rel):
    if rel not in files:
        path = ROOT / rel
        if not path.is_file():
            errors.append(f"{rel}: arquivo não encontrado (rode o script na pasta do projeto)")
            files[rel] = None
        else:
            raw = path.read_bytes().decode("utf-8")
            text = raw.lstrip("\ufeff").replace("\r\n", "\n")
            files[rel] = {"crlf": "\r\n" in raw, "bom": raw.startswith("\ufeff"), "orig": text, "text": text}
    return files[rel]


def _label(snippet):
    lines = snippet.strip().splitlines()
    return repr(lines[0][:70]) if lines else "''"


def replace(rel, old, new):
    f = load(rel)
    if f is None:
        return
    n = f["text"].count(old)
    if n != 1:
        errors.append(f"{rel}: trecho encontrado {n} vez(es) (deveria ser 1): {_label(old)}")
        return
    f["text"] = f["text"].replace(old, new)


def replace_all(rel, old, new):
    f = load(rel)
    if f is None:
        return
    if old not in f["text"]:
        errors.append(f"{rel}: trecho não encontrado: {_label(old)}")
        return
    f["text"] = f["text"].replace(old, new)


def cut(rel, start, end, new="", include_end=False):
    """Troca tudo entre `start` e `end` (o trecho `end` fica, salvo include_end)."""
    f = load(rel)
    if f is None:
        return
    text = f["text"]
    if text.count(start) != 1 or text.count(end) != 1:
        errors.append(f"{rel}: marcadores não encontrados exatamente 1 vez: {_label(start)} .. {_label(end)}")
        return
    i = text.index(start)
    j = text.index(end)
    if j < i:
        errors.append(f"{rel}: marcadores fora de ordem: {_label(start)} .. {_label(end)}")
        return
    if include_end:
        j += len(end)
    f["text"] = text[:i] + new + text[j:]


def append(rel, block):
    f = load(rel)
    if f is None:
        return
    f["text"] = f["text"].rstrip("\n") + "\n\n" + block


# ---------------------------------------------------------------------------
# static/ui-utils.js (arquivo novo)
# ---------------------------------------------------------------------------

UI_UTILS = r"""/* Utilidades compartilhadas pelas telas de cozinha e entregador. */
function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

/* Alarme sonoro (Web Audio). Os navegadores só liberam o som depois de um toque na página. */
const AlertSound = (() => {
  let ctx = null;
  let onChange = () => {};

  function get() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      ctx.onstatechange = () => onChange();
    }
    return ctx;
  }

  async function unlock() {
    const c = get();
    if (!c) return false;
    if (c.state === "suspended") {
      try { await c.resume(); } catch (_) { /* ainda bloqueado */ }
    }
    onChange();
    return c.state === "running";
  }

  const isOn = () => !!ctx && ctx.state === "running";

  /* "ding-ding-DING" duas vezes (~1,4 s), alto e fácil de reconhecer. */
  function play() {
    if (!isOn()) return;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    const limiter = ctx.createDynamicsCompressor();   // evita estourar o alto-falante
    master.connect(limiter);
    limiter.connect(ctx.destination);
    const notes = [659.25, 783.99, 1046.5];           // Mi, Sol, Dó (subindo)
    const start = ctx.currentTime + 0.02;
    [0, 0.75].forEach((offset) => {
      notes.forEach((freq, i) => {
        const t = start + offset + i * 0.16;
        const dur = i === 2 ? 0.36 : 0.14;
        [["square", freq, 0.32], ["sine", freq * 2, 0.22]].forEach(([type, f, level]) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = type;
          osc.frequency.value = f;
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(level, t + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(gain);
          gain.connect(master);
          osc.start(t);
          osc.stop(t + dur + 0.02);
        });
      });
    });
  }

  // Qualquer toque/tecla na página libera o som.
  ["pointerdown", "keydown", "touchstart"].forEach((type) => {
    document.addEventListener(type, () => { if (!isOn()) unlock(); }, { passive: true });
  });

  return { unlock, isOn, play, setOnChange(fn) { onChange = fn; } };
})();
"""

CSS_BLOCK = r"""/* ---------- entregador: ações, resumo e histórico ---------- */
.d-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.d-actions .d-maps { margin-bottom: 0; padding: 10px 14px; }
.d-summary { margin: 0 0 8px; font-size: 14px; }
.d-history { margin: 14px 0; background: var(--paper-warm); border: 1px solid var(--line); border-radius: 14px; padding: 10px 14px; }
.d-history summary { cursor: pointer; font-family: var(--font-mono); font-weight: 700; padding: 4px 0; }
.d-history-row { padding: 8px 0; border-top: 1px solid var(--line); font-size: 14px; }
.d-history-row small { display: block; font-family: var(--font-mono); font-size: 12px; color: var(--ink-soft); }
"""

JS_UTILS_BLOCK = r"""function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

"""


def build():
    # ------------------------------------------------------------------ db.py
    replace("db.py", "    fees REAL NOT NULL DEFAULT 0\n);", "    fees REAL NOT NULL DEFAULT 0,\n    cash REAL NOT NULL DEFAULT 0\n);")

    replace("db.py",
            '    row = conn.execute("SELECT COUNT(*) AS c FROM store").fetchone()\n',
            r'''    # Dinheiro recebido pelo entregador na noite: coluna nova para bancos antigos.
    shift_columns = [r["name"] for r in conn.execute("PRAGMA table_info(courier_shifts)").fetchall()]
    if "cash" not in shift_columns:
        conn.execute("ALTER TABLE courier_shifts ADD COLUMN cash REAL NOT NULL DEFAULT 0")
        conn.commit()

    # Índices: o painel da cozinha (a cada 3 s) e o acompanhamento do cliente
    # (a cada 10 s) consultam por estes campos; sem índice varrem a tabela toda.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_orders_stage ON orders(stage)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_orders_track ON orders(track_token)")
    conn.commit()

    row = conn.execute("SELECT COUNT(*) AS c FROM store").fetchone()
''')

    replace("db.py", '        "fees": r["fees"],\n', '        "fees": r["fees"],\n        "cash": r["cash"],\n')

    replace("db.py",
            '            conn.execute(\n'
            '                "UPDATE courier_shifts SET deliveries = deliveries + 1, fees = fees + ? WHERE closed_at IS NULL",\n'
            '                (float(row["delivery_fee"] or 0),),\n',
            '            cash = float(row["total"] or 0) if row["payment_method"] == "Dinheiro" else 0.0\n'
            '            conn.execute(\n'
            '                "UPDATE courier_shifts SET deliveries = deliveries + 1, fees = fees + ?, cash = cash + ? WHERE closed_at IS NULL",\n'
            '                (float(row["delivery_fee"] or 0), cash),\n')

    replace("db.py", "def get_order_stage(order_id):\n", r'''def list_courier_orders():
    """Entregas que o entregador precisa atender: 'pronto' primeiro (urgente),
    depois 'em_rota', do mais antigo para o mais novo."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM orders WHERE stage IN ('pronto', 'em_rota') AND delivery_type = ? "
            "ORDER BY (stage = 'pronto') DESC, id ASC",
            (DELIVERY_TYPE_VALUE,),
        ).fetchall()
        return [_order_row_to_dict(r) for r in rows]
    finally:
        conn.close()


def list_delivered_since(since_iso, limit=40):
    """Entregas confirmadas desde `since_iso` (relógio do servidor)."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT id, customer_name, address, total, payment_method, delivery_fee, stage_updated_at "
            "FROM orders WHERE stage = 'entregue' AND delivery_type = ? AND stage_updated_at >= ? "
            "ORDER BY stage_updated_at DESC, id DESC LIMIT ?",
            (DELIVERY_TYPE_VALUE, since_iso, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_order_stage(order_id):
''')

    # ----------------------------------------------------------------- app.py
    replace("app.py",
            "from flask import Flask, jsonify, request, render_template, session, redirect, url_for\n",
            "from flask import Flask, jsonify, request, render_template, session, redirect, url_for, g\n")

    replace("app.py",
            'app.config["SESSION_COOKIE_SAMESITE"] = "Lax"\n',
            'app.config["SESSION_COOKIE_SAMESITE"] = "Lax"\n'
            '# O Render define RENDER=true; em local (http) o cookie continua funcionando sem "Secure".\n'
            'app.config["SESSION_COOKIE_SECURE"] = bool(os.environ.get("RENDER"))\n')

    replace("app.py",
            '        stored = db.get_courier_password()\n'
            '        if not stored or session.get("courier_pw") != _courier_fingerprint(stored):\n',
            '        stored = db.get_courier_password()\n'
            '        g.courier_stored = stored   # reaproveitado por _courier_session_valid (evita outra consulta)\n'
            '        if not stored or session.get("courier_pw") != _courier_fingerprint(stored):\n')

    replace("app.py",
            'def _courier_session_valid():\n'
            '    stored = db.get_courier_password()\n',
            'def _courier_session_valid():\n'
            '    stored = g.get("courier_stored")\n'
            '    if stored is None:\n'
            '        stored = db.get_courier_password()\n')

    replace("app.py",
            '    orders = []\n'
            '    for order in db.list_kitchen_orders():\n'
            '        if order["stage"] not in ("pronto", "em_rota") or order["delivery_type"] != db.DELIVERY_TYPE_VALUE:\n'
            '            continue\n'
            '        order["is_delivery"] = True\n',
            '    orders = db.list_courier_orders()\n'
            '    for order in orders:\n'
            '        order["is_delivery"] = True\n')

    replace("app.py",
            '        order["ready_min"] = minutes if order["stage"] == "pronto" else None\n'
            '        orders.append(order)\n',
            '        order["ready_min"] = minutes if order["stage"] == "pronto" else None\n')

    replace("app.py",
            '@app.route("/api/entregador/pedidos/<int:order_id>/sair", methods=["POST"])\n',
            r'''@app.route("/api/entregador/entregues", methods=["GET"])
@require_courier
def courier_delivered():
    """Entregas confirmadas na noite aberta. Só é consultada quando o entregador
    abre o histórico (não faz parte do polling de 5 s)."""
    shift = db.get_open_courier_shift()
    if not shift:
        return jsonify({"ok": True, "orders": []})
    # stage_updated_at usa o relógio do servidor; o início da noite, o da loja (Brasil).
    since = datetime.fromisoformat(shift["started_at"]).replace(tzinfo=FUSO_LOJA).astimezone().replace(tzinfo=None)
    orders = db.list_delivered_since(since.isoformat(timespec="seconds"))
    for order in orders:
        try:
            order["stage_updated_at"] = (
                datetime.fromisoformat(order["stage_updated_at"]).astimezone(FUSO_LOJA).replace(tzinfo=None).isoformat(timespec="seconds")
            )
        except (TypeError, ValueError):
            pass
    return jsonify({"ok": True, "orders": orders})


@app.route("/api/entregador/pedidos/<int:order_id>/sair", methods=["POST"])
''')

    # ------------------------------------------------------ entregador-sw.js
    replace("static/entregador-sw.js",
            '      data: { url: "/entregador" },\n',
            '      data: { url: "/entregador", order_id: data.order_id, test: !!data.test },\n')

    # ----------------------------------------------------------------- HTMLs
    for html in ("templates/cozinha.html", "templates/entregador.html"):
        replace(html,
                '<script src="/static/live.js"></script>\n',
                '<script src="/static/ui-utils.js"></script>\n<script src="/static/live.js"></script>\n')

    replace("templates/entregador.html",
            '<small id="d-shift-since"></small>\n',
            '<small id="d-shift-since"></small>\n        <small id="d-shift-money"></small>\n')

    replace("templates/entregador.html",
            '    <div id="d-list"></div>\n',
            '    <div id="d-list"></div>\n'
            '    <details class="d-history" id="d-history">\n'
            '      <summary>✅ Entregues nesta noite</summary>\n'
            '      <div id="d-history-list"><p class="field-hint">Carregando...</p></div>\n'
            '    </details>\n')

    # -------------------------------------------------------------- cozinha.js
    js = "static/cozinha.js"
    replace(js, "let audioCtx = null;\n", "")
    replace(js, JS_UTILS_BLOCK, "")
    cut(js, "function getAudio() {", "function updateSoundButton() {")
    cut(js, "function playNewOrderSound() {",
        "  document.addEventListener(type, () => { if (!soundIsOn()) unlockAudio(); }, { passive: true });\n});\n",
        new="AlertSound.setOnChange(updateSoundButton);\n", include_end=True)
    replace_all(js, "playNewOrderSound()", "AlertSound.play()")
    replace_all(js, "unlockAudio()", "AlertSound.unlock()")
    replace_all(js, "soundIsOn()", "AlertSound.isOn()")

    # ---------------------------------------------------------- entregador.js
    js = "static/entregador.js"
    replace(js, "let audioCtx = null;\n",
            'let currentShift = null;\nlet hiddenTicks = 0;\nconst CITY_HINT = "Rio de Janeiro, RJ";\n')
    replace(js, JS_UTILS_BLOCK, "")
    cut(js, "function getAudio() {", "function updateSoundButton() {")
    cut(js, '["pointerdown", "keydown", "touchstart"].forEach((type) => {',
        '/* ---------- alarme de "pedido pronto" ---------- */',
        new="AlertSound.setOnChange(updateSoundButton);\n\n")
    replace_all(js, "playAlarmSound()", "AlertSound.play()")
    replace_all(js, "unlockAudio()", "AlertSound.unlock()")
    replace_all(js, "soundIsOn()", "AlertSound.isOn()")

    cut(js, "function orderHTML(order) {", "function render() {", new=r'''function phoneDigits(order) {
  return String(order.customer_phone || "").replace(/\D/g, "");
}

function contactButtons(order) {
  const digits = phoneDigits(order);
  if (!digits) return "";
  const wa = digits.length <= 11 ? `55${digits}` : digits;   // acrescenta o código do Brasil se faltar
  return `<a class="d-maps" href="tel:${digits}">📞 Ligar</a><a class="d-maps" href="https://wa.me/${wa}" target="_blank" rel="noopener">💬 WhatsApp</a>`;
}

function payShort(order) {
  if (order.payment_method === "Dinheiro") {
    const paidWith = Number(order.troco_paid_with);
    const change = Number.isFinite(paidWith) && paidWith > 0 ? paidWith - Number(order.total || 0) : 0;
    return `💵 Dinheiro · ${formatPrice(order.total)}${change > 0 ? ` · troco ${formatPrice(change)}` : ""}`;
  }
  return `💳 ${escapeHTML(order.payment_method || "Pagamento não informado")} · ${formatPrice(order.total)}`;
}

function orderHTML(order) {
  const isOpen = openIds.has(order.id);
  const isReady = order.stage === "pronto";
  const busy = busyIds.has(order.id) ? " disabled" : "";
  const items = (order.items || []).map((it) =>
    `<li><strong>${escapeHTML(it.qty)}x</strong> ${escapeHTML(it.name)}</li>`).join("");
  const itemCount = (order.items || []).reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
  const sub = isReady
    ? `<span class="d-ready-tag">PRONTO — pegar na cozinha</span>${order.ready_min == null ? "" : ` · há ${order.ready_min} min`}`
    : `🛵 Entrega${order.route_min == null ? "" : ` · em rota há ${order.route_min} min`}`;
  const mapsUrl = order.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${order.address}, ${CITY_HINT}`)}`
    : "";
  const button = isReady
    ? `<button type="button" class="save-btn k-next d-pickup"${busy}>🛵 Saí para entrega</button>`
    : confirmId === order.id
      ? `<div class="d-confirm-ask">
           <button type="button" class="save-btn k-next d-confirm d-confirm-yes"${busy}>✅ Sim, foi entregue</button>
           <button type="button" class="item-toggle-all d-confirm-no"${busy}>Cancelar</button>
         </div>`
      : `<button type="button" class="save-btn k-next d-confirm"${busy}>✅ Confirmar entrega</button>`;

  return `
  <article class="k-order stage-${escapeHTML(order.stage)}${isOpen ? " is-open" : ""}" data-id="${order.id}">
    <button type="button" class="k-head" aria-expanded="${isOpen}">
      <span class="k-num">#${order.id}</span>
      <span class="k-who">
        <strong>${escapeHTML(order.customer_name || "Sem nome")}</strong>
        <small>${sub}</small>
      </span>
      <span class="k-chevron">▾</span>
    </button>
    <p class="d-address">📍 ${escapeHTML(order.address || "Endereço não informado")}</p>
    <p class="d-money d-summary">${payShort(order)} · ${itemCount} item(ns)</p>
    <div class="d-actions">${mapsUrl ? `<a class="d-maps" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ Maps</a>` : ""}${contactButtons(order)}</div>
    <div class="k-body">
      <ul class="k-items">${items}</ul>
      <div class="k-details">
        ${order.customer_phone ? `<p><span>Telefone</span> <a href="tel:${escapeHTML(phoneDigits(order))}">${escapeHTML(order.customer_phone)}</a></p>` : ""}
        ${order.notes ? `<p class="k-notes"><span>Observações</span> ${escapeHTML(order.notes)}</p>` : ""}
        ${paymentLine(order)}
      </div>
    </div>
    ${button}
  </article>`;
}

''')

    cut(js, "function renderShift(shift) {", "function formatClock(iso) {", new=r'''function renderShift(shift) {
  currentShift = shift;
  const countEl = document.getElementById("d-shift-count");
  const sinceEl = document.getElementById("d-shift-since");
  if (!countEl) return;
  countEl.textContent = shift ? shift.deliveries : 0;
  sinceEl.textContent = shift ? `Desde as ${formatClock(shift.started_at)}` : "Nenhuma contagem aberta";
  document.getElementById("d-shift-money").textContent = shift
    ? `💵 Dinheiro recebido: ${formatPrice(shift.cash)} · Taxas: ${formatPrice(shift.fees)}`
    : "";
}

''')

    replace(js, "async function loadOrders() {\n  try {\n",
            "async function loadOrders() {\n"
            "  // Com a aba em segundo plano consulta 1 de cada 2 vezes (o push já avisa): menos carga no servidor.\n"
            "  if (document.hidden && hiddenTicks++ % 2) return;\n"
            "  try {\n")

    replace(js,
            "    if (knownReady !== null) {\n      const freshReady = readyIds.filter((id) => !knownReady.has(id));\n",
            "    if (knownReady === null) {\n"
            "      // Primeira carga (entrou ou recarregou): já avisa dos pedidos que estavam prontos.\n"
            "      if (readyIds.length) {\n"
            "        readyIds.forEach((id) => alarmIds.add(id));\n"
            "        alarmPlays = 0;\n"
            "        ringAlarm();\n"
            "      }\n"
            "    } else {\n"
            "      const freshReady = readyIds.filter((id) => !knownReady.has(id));\n")

    replace(js, "    else showToast(`Pedido #${id} entregue ✓`);\n",
            "    else {\n"
            "      showToast(`Pedido #${id} entregue ✓`);\n"
            '      if (document.getElementById("d-history").open) loadHistory();\n'
            "    }\n")

    replace(js, '  const count = document.getElementById("d-shift-count").textContent;\n',
            "  const count = currentShift ? currentShift.deliveries : 0;\n"
            "  const cash = currentShift ? currentShift.cash : 0;\n")
    replace(js, "Total desta noite: ${count} entrega(s). O total vai",
            "Total desta noite: ${count} entrega(s) e ${formatPrice(cash)} em dinheiro recebido. O total vai")
    replace(js, "Entregas fechadas: ${data.shift.deliveries} entrega(s) nesta noite. O total já está",
            "Entregas fechadas: ${data.shift.deliveries} entrega(s) e ${formatPrice(data.shift.cash)} em dinheiro nesta noite. O total já está")

    replace(js, "async function showBoard() {\n",
            'async function showBoard() {\n  document.getElementById("d-history").open = false;\n')

    replace(js, "// Já está logado (senha do entregador ou admin)? Entra direto.\n", r'''/* ---------- histórico da noite (só consulta quando o entregador abre a seção) ---------- */

async function loadHistory() {
  const box = document.getElementById("d-history-list");
  try {
    const res = await fetch("/api/entregador/entregues", { cache: "no-store" });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) return;
    box.innerHTML = data.orders.length
      ? data.orders.map((o) => `<div class="d-history-row"><strong>#${o.id}</strong> ${escapeHTML(o.customer_name || "Sem nome")}<small>${escapeHTML(o.address || "")} · ${escapeHTML(formatClock(o.stage_updated_at))} · ${formatPrice(o.total)}${o.payment_method === "Dinheiro" ? " · 💵" : ""}</small></div>`).join("")
      : `<p class="field-hint">Nenhuma entrega confirmada ainda nesta noite.</p>`;
  } catch (error) {
    console.error(error);
  }
}
document.getElementById("d-history").addEventListener("toggle", (e) => { if (e.target.open) loadHistory(); });

// Já está logado (senha do entregador ou admin)? Entra direto.
''')

    # ------------------------------------------------------------- admin.js
    replace("static/admin.js",
            "<span>Taxas de entrega</span><strong>${formatPrice(data.open.fees)}</strong></div>",
            "<span>Taxas de entrega</span><strong>${formatPrice(data.open.fees)}</strong></div>\n"
            '        <div class="sales-stat-card"><span>Dinheiro recebido</span><strong>${formatPrice(data.open.cash)}</strong></div>')
    replace("static/admin.js",
            "<th>Entregas</th><th>Taxas</th></tr></thead>",
            "<th>Entregas</th><th>Taxas</th><th>Dinheiro</th></tr></thead>")
    replace("static/admin.js",
            "        <td>${formatPrice(sh.fees)}</td>\n",
            "        <td>${formatPrice(sh.fees)}</td>\n        <td>${formatPrice(sh.cash)}</td>\n")

    # ------------------------------------------------------------ style.css
    append("static/style.css", CSS_BLOCK)


def main():
    if (ROOT / "static" / "ui-utils.js").exists():
        print("static/ui-utils.js já existe: parece que as melhorias já foram aplicadas. Nada foi alterado.")
        return 1

    build()
    if errors:
        print("NADA foi alterado. Estes trechos não bateram (o arquivo mudou desde a versão que eu vi?):\n")
        for e in errors:
            print(" -", e)
        return 1

    for rel, f in files.items():
        if f["text"] == f["orig"]:
            continue
        src = ROOT / rel
        dst = BACKUP_DIR / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(src.read_bytes())
        out = f["text"].replace("\n", "\r\n") if f["crlf"] else f["text"]
        if f["bom"]:
            out = "\ufeff" + out
        src.write_bytes(out.encode("utf-8"))
        print("modificado:", rel)

    (ROOT / "static" / "ui-utils.js").write_text(UI_UTILS, encoding="utf-8", newline="\n")
    print("criado:    static/ui-utils.js")
    print(f"\nPronto. Cópias dos originais em {BACKUP_DIR.name}/ (pode apagar depois de testar).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
