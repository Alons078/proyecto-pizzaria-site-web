/*
 * Assistente virtual da página do cliente.
 *
 * Funciona por REGRAS (palavras-chave), sem IA e sem custo: lê os mesmos dados
 * públicos que o cardápio já usa (/api/data) e responde sobre horário, entrega,
 * pagamento, cardápio, promoções e recomendações, sempre com links para o
 * produto, a promoção ou o carrinho.
 *
 * Carga no servidor: zero até a pessoa abrir o assistente. Depois disso, no
 * máximo 1 leitura de /api/data por minuto e 2 consultas de taxa (guardadas
 * em memória). Nada de pedido é criado aqui — ele só orienta e leva até as
 * páginas que já existem.
 *
 * Para ensinar uma resposta nova: adicione uma regra em RULES (mais abaixo).
 */
(() => {
  "use strict";
  if (window.__reyAssistantLoaded) return;
  window.__reyAssistantLoaded = true;

  /* ---------- configuração ---------- */

  // Espelham o que o carrinho (carrinho.js) oferece hoje.
  const PAYMENTS = ["Dinheiro (informe no carrinho se precisa de troco)", "Cartão na entrega", "Pix na maquininha"];
  const ZONES = [
    { label: "Piscinão de Ramos", query: "Piscinão de Ramos" },
    { label: "Do outro lado da passarela (Ramos)", query: "Ramos" },
  ];
  const CATEGORY_LABELS = { pizza: "Pizzas", salgado: "Salgados", bebida: "Bebidas" };
  const CATEGORY_ANCHORS = { pizza: "pizzas-section", salgado: "salgados-section", bebida: "bebidas-section" };
  const QUICK_REPLIES = ["Está aberto?", "Cardápio", "Promoções", "Taxa de entrega", "Pagamento", "Recomendar"];

  const MENU_MAX_AGE_MS = 60 * 1000;
  const HOURS_MAX_AGE_MS = 15 * 1000;
  const MAX_INPUT = 120;
  const MAX_LIST_ROWS = 8;
  const STORAGE_KEY = "rey_pizzaria_assistant_v1";
  const STORAGE_TTL_MS = 30 * 60 * 1000;
  const STORAGE_MAX_MESSAGES = 30;

  // Palavras ignoradas ao procurar um produto pelo nome.
  const STOP = new Set((
    "a o as os um uma uns umas de da do das dos com sem e ou em no na nos nas para pra por pelo pela " +
    "que qual quais quanto quanta quantos custa custam preco precos valor valores tem tenho voces voce vcs vc " +
    "quero queria quer gostaria ver me mostra mostrar mostre sabor sabores pizza pizzas ainda hoje agora " +
    "tambem mais algum alguma ter ser esta estao oi ola bom dia tarde noite favor " +
    "broto media grande familia gigante disponivel disponiveis existe existem opcao opcoes cardapio sobre saber pedir pedido"
  ).split(" "));

  // Gostos: palavras do pedido (sem acento) -> trechos que procuramos no nome/descrição dos produtos.
  const TASTES = [
    { words: ["doce", "doces", "sobremesa", "sobremesas"], label: "quem gosta de doce",
      terms: ["chocolate", "banana", "doce de leite", "morango", "brigadeiro", "romeu", "nutella", "sorvete", "goiabada", "doce"] },
    { words: ["crianca", "criancas", "kids", "infantil", "filho", "filha", "filhos"], label: "as crianças", terms: ["kids"] },
    { words: ["peixe", "peixes", "marisco", "mariscos"], label: "quem curte peixe e frutos do mar",
      terms: ["atum", "sardinha", "camarao", "bacalhau"] },
    { words: ["carne", "carnes"], label: "quem curte carne",
      terms: ["carne", "calabresa", "bacon", "presunto", "strogonoff"] },
    { words: ["queijo", "queijos"], label: "quem ama queijo",
      terms: ["queijo", "mussarela", "mucarela", "catupiry", "cheddar", "parmesao", "gorgonzola", "provolone"] },
  ];
  TASTES.forEach((taste) => { taste.re = new RegExp(`\\b(${taste.words.join("|")})\\b`); });
  // Essas palavras já indicam um gosto: não servem para achar um produto pelo nome.
  const TASTE_WORDS = new Set(TASTES.flatMap((t) => t.words).map((w) => w.replace(/s$/, "")));

  /* ---------- utilidades ---------- */

  const norm = (value) => String(value == null ? "" : value)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  const money = (value) => `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;

  function tokens(text) {
    return norm(text).split(" ")
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.replace(/s$/, ""));
  }

  function distance(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = row;
    }
    return prev[b.length];
  }

  // "calabreza" ~ "calabresa", "margarita" ~ "marguerita": tolera erros de digitação.
  function sameWord(a, b) {
    if (a === b) return true;
    const size = Math.min(a.length, b.length);
    if (size < 5) return false;
    return distance(a, b) <= (size >= 8 ? 2 : 1);
  }

  const itemsOf = (menu) => (menu && menu.items) || [];
  const sizesOf = (menu) => (menu && menu.pizza_sizes) || [];
  const storeOf = (menu) => (menu && menu.store) || {};
  const isAvailable = (item) => item.available !== false;

  // Mesma regra do cardápio: o preço da pizza vale para o 1º tamanho da tabela
  // e os demais somam a diferença da tabela.
  function pizzaPrice(item, size, sizes) {
    const own = Number(item.price || 0);
    return own ? own + Number(size.price || 0) - Number(sizes[0].price || 0) : Number(size.price || 0);
  }

  function priceLabel(item, sizes) {
    if (item.category === "pizza" && sizes.length) {
      const cheapest = Math.min(...sizes.map((s) => pizzaPrice(item, s, sizes)));
      return `a partir de ${money(cheapest)}`;
    }
    return money(item.price);
  }

  function itemRow(item, sizes) {
    return isAvailable(item)
      ? { title: item.name, sub: priceLabel(item, sizes), href: `/produto/${item.id}`, cta: "Pedir" }
      : { title: item.name, sub: "Esgotado no momento" };
  }

  function cartCount() {
    try {
      const cart = typeof cartLoad === "function" ? cartLoad() : [];
      return cart.reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    } catch (_) {
      return 0;
    }
  }

  function whatsappAction(menu, text) {
    const phone = String(storeOf(menu).whatsapp_number || "").replace(/\D/g, "");
    if (!phone) return null;
    return {
      label: "Falar no WhatsApp",
      href: `https://wa.me/${phone}?text=${encodeURIComponent(text || "Olá! Preciso de ajuda.")}`,
      external: true,
    };
  }

  /* ---------- dados (carregados só quando a pessoa usa o assistente) ---------- */

  let cachedMenu = null;
  let menuAt = 0;
  let menuPromise = null;

  function loadMenu(maxAge = MENU_MAX_AGE_MS) {
    if (cachedMenu && Date.now() - menuAt < maxAge) return Promise.resolve(cachedMenu);
    if (menuPromise) return menuPromise;
    menuPromise = fetch("/api/data", { cache: "no-cache" })
      .then((res) => {
        if (!res.ok) throw new Error("menu");
        return res.json();
      })
      .then((data) => {
        cachedMenu = data;
        menuAt = Date.now();
        return cachedMenu;
      })
      .catch(() => cachedMenu) // sem rede: usa o último que já tinha, se houver
      .finally(() => { menuPromise = null; });
    return menuPromise;
  }

  const feeCache = {};

  async function zoneFee(query) {
    if (query in feeCache) return feeCache[query];
    try {
      const res = await fetch("/api/calcular-tarifa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: query }),
      });
      const body = await res.json();
      if (body && body.ok) {
        feeCache[query] = Number(body.fee);
        return feeCache[query];
      }
    } catch (_) { /* sem resposta: a taxa fica "a combinar" */ }
    return null;
  }

  /* ---------- respostas ---------- */

  const closedNote = (menu) => {
    const store = storeOf(menu);
    if (store.is_open !== false) return "";
    return `🔒 Estamos fechados agora${store.hours && store.hours.open ? ` (abrimos às ${store.hours.open})` : ""}. ` +
      "Dá para ver o cardápio, mas só é possível fechar o pedido no horário de funcionamento.";
  };

  function replyGreeting(menu) {
    const name = storeOf(menu).name || "nossa pizzaria";
    return {
      text: `Oi! 👋 Eu sou o assistente da ${name}. Posso ajudar com cardápio, promoções, entrega, pagamento e horário. O que você procura?`,
    };
  }

  function replyHours(menu) {
    const store = storeOf(menu);
    const hours = store.hours || {};
    const status = store.is_open
      ? `Estamos abertos agora 🍕${hours.close ? ` e fechamos às ${hours.close}` : ""}.`
      : `Estamos fechados agora${hours.open ? `. Abrimos às ${hours.open}` : ""}.`;
    const schedule = hours.open && hours.close ? `\nHorário de funcionamento: ${hours.open} às ${hours.close}.` : "";
    return { text: status + schedule };
  }

  async function replyDelivery(menu) {
    const store = storeOf(menu);
    const fees = await Promise.all(ZONES.map((zone) => zoneFee(zone.query)));
    const lines = [];
    if (store.delivery_time) lines.push(`Entregamos em ${store.delivery_time}.`);
    lines.push("Taxa de entrega por região:");
    ZONES.forEach((zone, i) => {
      lines.push(`• ${zone.label}: ${fees[i] === null ? "a combinar" : money(fees[i])}`);
    });
    lines.push("Outras regiões: a taxa é combinada pelo WhatsApp.");
    if (store.min_order) lines.push(`Pedido mínimo: ${money(store.min_order)}.`);
    lines.push("Se preferir, também dá para retirar no local.");
    const whats = whatsappAction(menu, "Olá! Quero saber a taxa de entrega para o meu endereço.");
    return { text: lines.join("\n"), actions: whats ? [whats] : [] };
  }

  function replyMinimum(menu) {
    const min = Number(storeOf(menu).min_order || 0);
    return { text: min ? `O pedido mínimo é ${money(min)}.` : "Não temos pedido mínimo." };
  }

  function replyPayment() {
    return {
      text: "Formas de pagamento:\n" + PAYMENTS.map((p) => `• ${p}`).join("\n") +
        "\nVocê escolhe no carrinho, na hora de fechar o pedido.",
      actions: [{ label: "Abrir carrinho", href: "/carrinho" }],
    };
  }

  function replyAddress(menu) {
    const store = storeOf(menu);
    if (!store.address) return { text: "Ainda não temos o endereço cadastrado aqui. Chame a gente no WhatsApp." };
    const actions = [{
      label: "Abrir no mapa",
      href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(store.address)}`,
      external: true,
    }];
    return {
      text: `Estamos em: ${store.address}\nVocê pode retirar seu pedido aqui ou pedir entrega.`,
      actions,
    };
  }

  function replyTrack() {
    return {
      text: "Em “Meus pedidos” você acompanha o andamento e, se ainda for possível, cancela o pedido.",
      actions: [{ label: "Meus pedidos", href: "/meus-pedidos" }],
    };
  }

  function replyHuman(menu) {
    const whats = whatsappAction(menu, "Olá! Preciso de ajuda.");
    return whats
      ? { text: "Para falar com a gente, chame no WhatsApp:", actions: [whats] }
      : { text: "Ainda não temos um WhatsApp cadastrado. Tente de novo mais tarde." };
  }

  function replyBorda(menu) {
    const bordas = storeOf(menu).bordas || [];
    if (!bordas.length) return { text: "No momento não temos bordas recheadas." };
    return {
      text: "Bordas recheadas:\n" + bordas.map((b) => `• ${b.name}: +${money(b.price)}`).join("\n") +
        "\nVocê escolhe a borda na página da pizza.",
      actions: [{ label: "Ver pizzas", ask: "pizzas" }],
      order: true,
    };
  }

  function replySizes(menu) {
    const sizes = sizesOf(menu);
    if (!sizes.length) return { text: "Veja os tamanhos disponíveis na página de cada pizza.", order: true };
    const base = Number(sizes[0].price || 0);
    const lines = sizes.map((s, i) => {
      const diff = Number(s.price || 0) - base;
      const extra = i === 0 ? "preço do sabor" : `${diff >= 0 ? "+" : "-"}${money(Math.abs(diff))}`;
      return `• ${s.name}${s.cm ? ` (${s.cm} cm)` : ""}: ${extra}`;
    });
    return {
      text: `Tamanhos das pizzas:\n${lines.join("\n")}\nO preço de cada sabor vale para o ${sizes[0].name}; nos outros tamanhos soma a diferença acima. O valor exato aparece na página da pizza.`,
      actions: [{ label: "Ver pizzas", ask: "pizzas" }],
      order: true,
    };
  }

  function replyPromotions(menu) {
    const promos = (menu && menu.promotions) || [];
    if (!promos.length) return { text: "No momento não temos promoções ativas. Dá uma olhada no cardápio!", actions: [{ label: "Ver cardápio", ask: "cardápio" }] };
    return {
      text: promos.length === 1 ? "Temos esta promoção:" : "Temos estas promoções:",
      rows: promos.map((p) => ({
        title: `${p.name} — ${money(p.price)}`,
        sub: String(p.description || "").slice(0, 100),
        href: `/promocao/${p.id}`,
        cta: "Ver",
      })),
      order: true,
    };
  }

  function replyRecommend(menu) {
    const items = itemsOf(menu).filter(isAvailable);
    const sizes = sizesOf(menu);
    const featured = items.filter((i) => i.featured);
    const picks = (featured.length ? featured : items.filter((i) => i.category === "pizza")).slice(0, 5);
    const promos = (menu && menu.promotions) || [];
    const rows = picks.map((i) => itemRow(i, sizes));
    promos.slice(0, 1).forEach((p) => rows.push({ title: `${p.name} — ${money(p.price)}`, sub: "Promoção", href: `/promocao/${p.id}`, cta: "Ver" }));
    if (!rows.length) return { text: "Ainda estou sem sugestões. Veja o cardápio completo!", actions: [{ label: "Ver cardápio", ask: "cardápio" }] };
    return {
      text: featured.length ? "Os mais pedidos da casa:" : "Algumas sugestões para você:",
      rows,
      order: true,
    };
  }

  function replyCheap(menu) {
    const sizes = sizesOf(menu);
    const cost = (i) => (i.category === "pizza" && sizes.length
      ? Math.min(...sizes.map((s) => pizzaPrice(i, s, sizes))) : Number(i.price || 0));
    const pizzas = itemsOf(menu).filter((i) => isAvailable(i) && i.category === "pizza")
      .sort((a, b) => cost(a) - cost(b)).slice(0, 4);
    const rows = pizzas.map((i) => itemRow(i, sizes));
    ((menu && menu.promotions) || []).slice(0, 1)
      .forEach((p) => rows.push({ title: `${p.name} — ${money(p.price)}`, sub: "Promoção", href: `/promocao/${p.id}`, cta: "Ver" }));
    if (!rows.length) return { text: "Veja o cardápio completo para comparar os preços.", actions: [{ label: "Ver cardápio", ask: "cardápio" }] };
    return { text: "As opções mais em conta:", rows, order: true };
  }

  function replyTaste(menu, taste) {
    const sizes = sizesOf(menu);
    const found = itemsOf(menu).filter((i) => {
      const text = norm(`${i.name} ${i.description || ""}`);
      return isAvailable(i) && taste.terms.some((term) => text.includes(term));
    }).slice(0, MAX_LIST_ROWS);
    if (!found.length) return replyRecommend(menu);
    return { text: `Para ${taste.label}, olha essas:`, rows: found.map((i) => itemRow(i, sizes)), order: true };
  }

  // Devolve os produtos que melhor combinam com o texto. `full` = todas as palavras do
  // cliente foram encontradas (senão é só o mais parecido).
  function searchItems(text, data, ignore) {
    const query = tokens(text).filter((q) => !(ignore && ignore.has(q)));
    if (!query.length) return { items: [], full: false };
    const scored = [];
    itemsOf(data).forEach((item) => {
      const words = tokens(`${item.name} ${item.description || ""}`);
      const score = query.filter((q) => words.some((w) => sameWord(q, w))).length;
      if (score) scored.push({ item, score });
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored.length ? scored[0].score : 0;
    return {
      items: scored.filter((s) => s.score === best).map((s) => s.item).slice(0, 5),
      full: best === query.length,
    };
  }

  function replyProduct(menu, found) {
    const sizes = sizesOf(menu);
    const list = found.items;
    if (list.length === 1) {
      const item = list[0];
      let text;
      if (!isAvailable(item)) {
        text = `${item.name} está esgotado no momento. 😕`;
      } else {
        text = found.full ? `Temos sim! ${item.name}.` : `Não achei exatamente isso, mas temos: ${item.name}.`;
        if (item.description) text += `\n${item.description}`;
        text += item.category === "pizza" && sizes.length
          ? "\n" + sizes.map((s) => `• ${s.name}: ${money(pizzaPrice(item, s, sizes))}`).join("\n")
          : `\nPreço: ${money(item.price)}.`;
      }
      return { text, rows: isAvailable(item) ? [itemRow(item, sizes)] : [], order: true };
    }
    return {
      text: found.full ? "Encontrei estas opções:" : "Não achei exatamente isso, mas estas são parecidas:",
      rows: list.map((i) => itemRow(i, sizes)),
      order: true,
    };
  }

  function categoryName(menu, category) {
    if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
    const section = ((menu && menu.sections) || []).find((s) => s.category === category);
    return section ? section.name : category;
  }

  function replyCategory(menu, category) {
    const sizes = sizesOf(menu);
    const all = itemsOf(menu).filter((i) => i.category === category);
    if (!all.length) return { text: "Ainda não temos itens nessa categoria.", actions: [{ label: "Ver cardápio", ask: "cardápio" }] };
    const available = all.filter(isAvailable);
    const shown = available.slice(0, MAX_LIST_ROWS);
    const reply = {
      text: `${categoryName(menu, category)} disponíveis:`,
      rows: shown.map((i) => itemRow(i, sizes)),
      order: true,
    };
    if (available.length > shown.length) {
      reply.actions = [{ label: `Ver todos (${available.length})`, href: `/#${CATEGORY_ANCHORS[category] || `${category}-section`}` }];
    }
    return reply;
  }

  function replyOverview(menu) {
    const sizes = sizesOf(menu);
    const groups = {};
    itemsOf(menu).filter(isAvailable).forEach((i) => { (groups[i.category] = groups[i.category] || []).push(i); });
    const rows = Object.keys(groups).map((category) => {
      const list = groups[category];
      const prices = list.map((i) => (i.category === "pizza" && sizes.length
        ? Math.min(...sizes.map((s) => pizzaPrice(i, s, sizes))) : Number(i.price || 0)));
      return {
        title: categoryName(menu, category),
        sub: `${list.length} ${list.length === 1 ? "opção" : "opções"} · a partir de ${money(Math.min(...prices))}`,
        ask: categoryName(menu, category),
        cta: "Ver",
      };
    });
    if (((menu && menu.promotions) || []).length) rows.unshift({ title: "Promoções", sub: "Combos com preço especial", ask: "promoções", cta: "Ver" });
    if (!rows.length) return { text: "O cardápio está vazio no momento. Volte daqui a pouco!" };
    return { text: "O que você quer ver?", rows };
  }

  function replyHowToOrder(menu) {
    const count = cartCount();
    const lines = [
      "É simples:",
      "1. Escolha seus itens no cardápio.",
      "2. Abra o carrinho e confira.",
      "3. Informe seus dados, a forma de entrega e o pagamento.",
    ];
    if (count) lines.push(`\nSeu carrinho tem ${count} ${count === 1 ? "item" : "itens"}.`);
    return {
      text: lines.join("\n"),
      actions: [{ label: "Ver cardápio", ask: "cardápio" }, { label: count ? `Abrir carrinho (${count})` : "Abrir carrinho", href: "/carrinho" }],
      order: true,
    };
  }

  function replyThanks() {
    return { text: "Por nada! 😊 Se precisar de mais alguma coisa, é só chamar." };
  }

  function replyFallback(menu) {
    const whats = whatsappAction(menu, "Olá! Tenho uma dúvida.");
    return {
      text: "Não entendi muito bem 😅. Tente perguntar sobre cardápio, promoções, entrega, pagamento ou horário — ou fale com a gente no WhatsApp.",
      actions: whats ? [whats] : [],
    };
  }

  /* ---------- regras: a primeira que combinar responde ---------- */

  const RULES = [
    { re: /\b(obrigad[oa]?|valeu|vlw)\b/, run: replyThanks },
    { re: /\b(horario|horarios|aberto|aberta|abertos|abre|abrem|fecha|fecham|funcionam|funcionamento)\b|ate que horas|que horas/, run: replyHours, fresh: true },
    { re: /\b(entrega|entregas|entregam|entregar|delivery|frete|taxa|taxas|motoboy|bairro|bairros|ramos|piscinao|demora|demorar|tempo|chega|chegar)\b/, run: replyDelivery },
    { re: /\bminimo\b/, run: replyMinimum },
    { re: /\b(pagamento|pagamentos|pagar|pagam|pix|cartao|cartoes|dinheiro|troco|credito|debito|maquininha)\b/, run: replyPayment },
    { re: /\b(endereco|localizacao|onde fica|onde ficam|retirada|retirar|buscar|mapa|como chegar)\b/, run: replyAddress },
    { re: /\b(acompanhar|acompanho|status|rastrear|meus pedidos|meu pedido|cancelar|cancelamento)\b/, run: replyTrack },
    { re: /\b(whats|whatsapp|atendente|humano|telefone|contato|ligar|reclamacao|reclamar|problema)\b|falar com/, run: replyHuman },
    { re: /\b(borda|bordas|recheada|recheadas)\b/, run: replyBorda },
    { re: /\b(tamanho|tamanhos|broto|media|grande|familia|gigante|fatias?|pedacos?)\b/, run: replySizes, skipIfProduct: true },
    { re: /\b(promocao|promocoes|promo|combo|combos|oferta|ofertas|desconto|descontos)\b/, run: replyPromotions },
    { re: /\b(barato|barata|baratas|baratos|economico|economica|em conta|menor preco)\b/, run: replyCheap },
    { re: /\b(recomend\w*|sugest\w*|sugir\w*|indica\w*|melhor|melhores|mais pedid\w*|popular|populares|favorit\w*|indeciso|indecisa|o que pedir|o que escolher|nao sei o que)\b/, run: replyRecommend },
  ];

  async function answer(text) {
    const t = norm(text);
    const early = RULES.find((r) => r.re.test(t));
    const data = await loadMenu(early && early.fresh ? HOURS_MAX_AGE_MS : MENU_MAX_AGE_MS);
    if (!data) {
      return { text: "Não consegui carregar as informações agora 😕. Verifique sua internet e tente de novo em instantes." };
    }

    const rule = RULES.find((r) => r.re.test(t) && !(r.skipIfProduct && searchItems(t, data, TASTE_WORDS).items.length));
    let reply = null;
    if (rule) {
      reply = await rule.run(data);
    } else {
      const found = searchItems(t, data, TASTE_WORDS);
      const taste = TASTES.find((x) => x.re.test(t));
      if (found.items.length) {
        reply = replyProduct(data, found);
      } else if (taste) {
        reply = replyTaste(data, taste);
      } else {
        const categories = [...new Set(itemsOf(data).map((i) => i.category))];
        const category = categories.find((c) => {
          const name = norm(categoryName(data, c));
          return name && (t.includes(name) || t.includes(name.replace(/s$/, "")));
        }) || (/\b(refri|refrigerante|refrigerantes|suco|sucos|beber|tomar|agua)\b/.test(t) ? "bebida" : null)
          || (/\b(lanche|lanches)\b/.test(t) ? "salgado" : null);
        if (category) reply = replyCategory(data, category);
        else if (/\b(cardapio|menu|opcoes|produtos|vende|vendem|o que tem|que tem)\b/.test(t)) reply = replyOverview(data);
        else if (/\b(pedir|pedido|pedidos|carrinho|finalizar|comprar|encomendar)\b|como faco|como fazer|como funciona/.test(t)) reply = replyHowToOrder(data);
        else if (t.split(" ").length <= 4 && /\b(oi|ola|opa|eae|bom dia|boa tarde|boa noite|hey|hello)\b/.test(t)) reply = replyGreeting(data);
        else reply = replyFallback(data);
      }
    }

    if (reply.order) {
      const note = closedNote(data);
      if (note) reply.note = note;
    }
    return reply;
  }

  /* ---------- interface ---------- */

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const fab = make("button", "rpa-fab", "💬");
  fab.type = "button";
  fab.setAttribute("aria-label", "Abrir assistente virtual");
  fab.setAttribute("aria-expanded", "false");
  fab.setAttribute("aria-controls", "rpa-panel");

  const panel = make("section", "rpa-panel");
  panel.id = "rpa-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Assistente virtual");

  const head = make("header", "rpa-head");
  const headText = make("div", "rpa-head-text");
  headText.append(make("strong", "rpa-title", "Assistente virtual"), make("span", "rpa-subtitle", "Tire dúvidas e peça mais rápido"));
  const closeBtn = make("button", "rpa-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Fechar assistente");
  head.append(headText, closeBtn);

  const log = make("div", "rpa-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  const chips = make("div", "rpa-chips");
  QUICK_REPLIES.forEach((label) => {
    const chip = make("button", "rpa-chip", label);
    chip.type = "button";
    chip.addEventListener("click", () => send(label));
    chips.append(chip);
  });

  const form = make("form", "rpa-form");
  const input = make("input", "rpa-input");
  input.type = "text";
  input.maxLength = MAX_INPUT;
  input.placeholder = "Digite sua dúvida…";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Sua mensagem");
  const sendBtn = make("button", "rpa-send", "Enviar");
  sendBtn.type = "submit";
  form.append(input, sendBtn);

  panel.append(head, log, chips, form);

  let history = [];
  let busy = false;
  let greeted = false;

  function renderMessage(msg) {
    const bubble = make("div", `rpa-msg rpa-${msg.from}`);
    if (msg.text) bubble.append(make("p", "rpa-text", msg.text));

    if (msg.rows && msg.rows.length) {
      const list = make("div", "rpa-rows");
      msg.rows.forEach((row) => {
        const line = make("div", "rpa-row");
        const main = make("div", "rpa-row-main");
        main.append(make("strong", "", row.title));
        if (row.sub) main.append(make("span", "", row.sub));
        line.append(main);
        if (row.href) {
          const link = make("a", "rpa-row-cta", row.cta || "Ver");
          link.href = row.href;
          line.append(link);
        } else if (row.ask) {
          const btn = make("button", "rpa-row-cta", row.cta || "Ver");
          btn.type = "button";
          btn.addEventListener("click", () => send(row.ask));
          line.append(btn);
        }
        list.append(line);
      });
      bubble.append(list);
    }

    if (msg.actions && msg.actions.length) {
      const bar = make("div", "rpa-actions");
      msg.actions.forEach((action) => {
        if (action.href) {
          const link = make("a", "rpa-action", action.label);
          link.href = action.href;
          if (action.external) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
          bar.append(link);
        } else if (action.ask) {
          const btn = make("button", "rpa-action", action.label);
          btn.type = "button";
          btn.addEventListener("click", () => send(action.ask));
          bar.append(btn);
        }
      });
      bubble.append(bar);
    }

    if (msg.note) bubble.append(make("p", "rpa-note", msg.note));
    log.append(bubble);
    return bubble;
  }

  function scrollToBubble(bubble) {
    const top = Math.max(0, bubble.offsetTop - 8);
    log.scrollTop = Math.min(top, log.scrollHeight - log.clientHeight);
  }

  function persist() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ t: Date.now(), msgs: history.slice(-STORAGE_MAX_MESSAGES) }));
    } catch (_) { /* sem sessionStorage: a conversa só não sobrevive à troca de página */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || !Array.isArray(saved.msgs) || Date.now() - saved.t > STORAGE_TTL_MS) return;
      saved.msgs.forEach((msg) => {
        if (msg && (msg.from === "bot" || msg.from === "user")) { history.push(msg); renderMessage(msg); }
      });
      greeted = history.length > 0;
    } catch (_) { /* conversa guardada ilegível: começa do zero */ }
  }

  function addMessage(msg) {
    history.push(msg);
    persist();
    const bubble = renderMessage(msg);
    scrollToBubble(bubble);
    return bubble;
  }

  function showTyping() {
    const bubble = make("div", "rpa-msg rpa-bot rpa-typing");
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-label", "Digitando");
    bubble.append(make("span"), make("span"), make("span"));
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  async function send(text) {
    const clean = String(text || "").trim().slice(0, MAX_INPUT);
    if (!clean || busy) return;
    busy = true;
    try {
      addMessage({ from: "user", text: clean });
      input.value = "";
      const typing = showTyping();
      let reply;
      try {
        reply = await answer(clean);
      } catch (error) {
        console.error(error);
        reply = { text: "Algo deu errado por aqui 😕. Tente de novo em instantes." };
      }
      typing.remove();
      addMessage(Object.assign({ from: "bot" }, reply));
    } finally {
      busy = false;
    }
  }

  function updateSubtitle(data) {
    const store = storeOf(data);
    const hours = store.hours || {};
    const sub = panel.querySelector(".rpa-subtitle");
    if (!sub || !data) return;
    sub.textContent = store.is_open
      ? `Aberto agora${hours.close ? ` · fecha às ${hours.close}` : ""}`
      : `Fechado agora${hours.open ? ` · abre às ${hours.open}` : ""}`;
  }

  async function open() {
    panel.hidden = false;
    fab.hidden = true;
    fab.setAttribute("aria-expanded", "true");
    input.focus({ preventScroll: true });
    const data = await loadMenu();
    updateSubtitle(data);
    if (!greeted) {
      greeted = true;
      addMessage(Object.assign({ from: "bot" }, data ? replyGreeting(data) : { text: "Oi! 👋 Sou o assistente virtual. Não consegui carregar o cardápio agora, mas pode perguntar." }));
    }
    log.scrollTop = log.scrollHeight;
  }

  function close() {
    panel.hidden = true;
    fab.hidden = false;
    fab.setAttribute("aria-expanded", "false");
    fab.focus({ preventScroll: true });
  }

  fab.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send(input.value);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) close();
  });
  // Link da mesma página (ex.: "#pizzas-section"): fecha o assistente para a pessoa ver o resultado.
  log.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (link && !link.target) close();
  });

  // O aviso de privacidade (fixo no rodapé, na primeira visita) cobriria o botão e o campo de
  // texto: enquanto ele aparecer, o assistente sobe acima dele.
  const privacyBanner = document.getElementById("privacy-banner");
  if (privacyBanner) {
    const lift = () => {
      const shown = getComputedStyle(privacyBanner).display !== "none";
      document.documentElement.style.setProperty("--rpa-lift", shown ? `${privacyBanner.offsetHeight}px` : "0px");
    };
    new MutationObserver(lift).observe(privacyBanner, { attributes: true, attributeFilter: ["style"] });
    if ("ResizeObserver" in window) new ResizeObserver(lift).observe(privacyBanner);
    window.addEventListener("resize", lift);
    lift();
  }

  restore();
  document.body.classList.add("rpa-on");
  document.body.append(fab, panel);
})();
