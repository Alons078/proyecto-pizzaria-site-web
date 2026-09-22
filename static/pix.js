/*
 * Gera o código Pix "copia e cola" (padrão BR Code / EMV do Banco Central)
 * e o QR Code correspondente, direto no navegador do cliente — nada do
 * pedido sai para servidores externos, é só matemática em cima do valor
 * e da chave Pix cadastrada pela pizzaria no admin.
 *
 * Depende de /static/vendor/qrcode.js (biblioteca qrcode-generator, MIT)
 * para desenhar o QR Code.
 */

/* Pix só aceita letras (sem acento), números e espaço nos campos de nome
 * e cidade do recebedor, com um tamanho máximo — por isso normalizamos
 * antes de montar o código. */
function pixSanitizeText(value, maxLength, fallback) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .toUpperCase();
  return (normalized || fallback).slice(0, maxLength);
}

function pixField(id, value) {
  const str = String(value);
  const length = str.length.toString().padStart(2, "0");
  return `${id}${length}${str}`;
}

/* CRC16-CCITT (falso), polinômio 0x1021, valor inicial 0xFFFF — é o
 * checksum de 4 dígitos hexadecimais que o Banco Central exige no fim
 * de todo código Pix, pra garantir que ele não foi digitado/alterado
 * errado em algum lugar no meio do caminho. */
function pixCrc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/*
 * Monta o "Pix Copia e Cola" de um pedido específico, já com o valor
 * exato preenchido: o cliente só cola no app do banco e confirma, sem
 * digitar nada.
 *
 * opts:
 *   key    = chave Pix da pizzaria (CPF, CNPJ, e-mail, telefone ou chave aleatória)
 *   name   = nome do recebedor (até 25 caracteres, sem acento)
 *   city   = cidade do recebedor (até 15 caracteres, sem acento)
 *   amount = valor total do pedido, em reais (ex.: 45.9)
 *   txid   = identificador opcional do pedido (até 25 caracteres alfanuméricos)
 */
function buildPixPayload({ key, name, city, amount, txid }) {
  const merchantAccount =
    pixField("00", "br.gov.bcb.pix") +
    pixField("01", String(key || "").trim());

  const reference = txid
    ? String(txid).replace(/[^a-zA-Z0-9]/g, "").slice(0, 25)
    : "";
  const additionalData = pixField("05", reference || "***");

  const amountStr = Math.max(0, Number(amount) || 0).toFixed(2);

  let payload =
    pixField("00", "01") +                                    // Payload Format Indicator
    pixField("01", "11") +                                     // Point of Initiation: Pix estático (valor fixo embutido no próprio código, sem depender de nenhuma URL)
    pixField("26", merchantAccount) +                          // Informações da conta Pix
    pixField("52", "0000") +                                   // Categoria do comerciante (genérica)
    pixField("53", "986") +                                    // Moeda: Real (BRL)
    pixField("54", amountStr) +                                 // Valor da transação
    pixField("58", "BR") +                                      // País
    pixField("59", pixSanitizeText(name, 25, "PIZZARIA")) +       // Nome do recebedor
    pixField("60", pixSanitizeText(city, 15, "BRASIL")) +         // Cidade do recebedor
    pixField("62", additionalData);                               // Identificador do pedido

  payload += "6304"; // ID + tamanho do campo do CRC, exigidos antes de calculá-lo
  return payload + pixCrc16(payload);
}

/* Desenha o QR Code como SVG dentro do elemento informado. */
function renderPixQr(containerEl, payload) {
  if (!containerEl) return;
  containerEl.innerHTML = "";
  const qr = qrcode(0, "M"); // tipo 0 = a biblioteca escolhe o menor tamanho que cabe o texto
  qr.addData(payload);
  qr.make();
  containerEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
