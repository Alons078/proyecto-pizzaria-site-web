/*
 * Aviso de privacidade da página do cliente: um pequeno banner explicando
 * quais dados o site usa (carrinho salvo no navegador + dados do pedido),
 * com um link "Leia aqui" que abre o texto completo, e botões Aceitar/
 * Rejeitar. A escolha fica salva no navegador, então o aviso só aparece de
 * novo se o cliente limpar os dados do site ou usar outro aparelho.
 *
 * Rejeitar não trava nenhuma função do site: como o cardápio não usa
 * cookies de propaganda nem rastreamento, os únicos dados guardados são os
 * necessários para o carrinho funcionar e para o pedido chegar até o
 * cliente — por isso o aviso já deixa isso claro em vez de fingir que dá
 * pra navegar sem eles.
 */

const PRIVACY_CHOICE_KEY = "rey_pizzaria_privacy_choice_v1";

function privacyGetChoice() {
  try {
    return localStorage.getItem(PRIVACY_CHOICE_KEY);
  } catch (_) {
    return "accepted"; // sem localStorage, não tem como perguntar de novo a cada página
  }
}

function privacySaveChoice(choice) {
  try {
    localStorage.setItem(PRIVACY_CHOICE_KEY, choice);
  } catch (_) { /* sem localStorage: só não lembra a escolha */ }
}

function privacyHideBanner() {
  const banner = document.getElementById("privacy-banner");
  if (banner) banner.style.display = "none";
}

function privacyHideModal() {
  const modal = document.getElementById("privacy-modal-overlay");
  if (modal) modal.style.display = "none";
}

function privacyInit() {
  const banner = document.getElementById("privacy-banner");
  if (!banner) return;

  if (!privacyGetChoice()) {
    banner.style.display = "flex";
  }

  document.getElementById("privacy-read-btn")?.addEventListener("click", () => {
    const modal = document.getElementById("privacy-modal-overlay");
    if (modal) modal.style.display = "flex";
  });

  document.getElementById("privacy-modal-close-btn")?.addEventListener("click", privacyHideModal);
  document.getElementById("privacy-modal-overlay")?.addEventListener("click", (event) => {
    if (event.target.id === "privacy-modal-overlay") privacyHideModal();
  });

  const accept = () => { privacySaveChoice("accepted"); privacyHideBanner(); privacyHideModal(); };
  const reject = () => { privacySaveChoice("rejected"); privacyHideBanner(); privacyHideModal(); };

  document.getElementById("privacy-accept-btn")?.addEventListener("click", accept);
  document.getElementById("privacy-modal-accept-btn")?.addEventListener("click", accept);
  document.getElementById("privacy-reject-btn")?.addEventListener("click", reject);
  document.getElementById("privacy-modal-reject-btn")?.addEventListener("click", reject);
}

document.addEventListener("DOMContentLoaded", privacyInit);
