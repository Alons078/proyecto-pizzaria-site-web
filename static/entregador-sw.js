/* Service worker do entregador: recebe o aviso "pedido pronto" do servidor
 * (push) mesmo com o navegador/aba fechados e mostra a notificação com som e
 * vibração do celular. Não faz cache de nada nem consulta o servidor: só
 * acorda quando chega um aviso, então não pesa no Render. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { /* aviso sem dados */ }

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const courierWins = wins.filter((w) => new URL(w.url).pathname.startsWith("/entregador"));

    // Se a tela do entregador está aberta e visível, ela mesma toca o alarme:
    // só a avisamos para atualizar a lista já (sem notificação duplicada).
    if (courierWins.some((w) => w.visibilityState === "visible")) {
      courierWins.forEach((w) => w.postMessage({ type: "pedido-pronto", order_id: data.order_id }));
      return;
    }

    await self.registration.showNotification(data.title || "🍕 Pedido pronto!", {
      body: data.body || "Pode retirar na cozinha.",
      tag: `pedido-pronto-${data.order_id || "x"}`,
      renotify: true,
      requireInteraction: true,            // fica na tela até o entregador tocar
      vibrate: [600, 200, 600, 200, 600, 200, 600],
      icon: "/static/entregador-icon.png",
      badge: "/static/entregador-icon.png",
      data: { url: "/entregador" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = wins.find((w) => new URL(w.url).pathname.startsWith("/entregador"));
    if (existing) { await existing.focus(); return; }
    await self.clients.openWindow("/entregador");
  })());
});
