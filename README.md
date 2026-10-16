# 🍕 Rey Pizzaria — Sistema de pedidos online

Sistema web completo para uma pizzaria real: cardápio público, carrinho com envio do pedido por WhatsApp, acompanhamento do pedido, painel administrativo, tela da cozinha, registro de vendas dos funcionários e página do entregador com notificações push.

Desenvolvido do zero (back-end e front-end) com **Flask + SQLite**, pensado para rodar barato no Render (0,5 CPU / 512 MB) e aguentar os horários de pico.

## ✨ Principais funcionalidades

- **Cardápio e promoções** com produtos, tamanhos, bordas e montagem do pedido.
- **Carrinho** com taxa de entrega por bairro, pagamento via Pix e envio do pedido por WhatsApp.
- **Acompanhamento do pedido** em tempo real, por link único (`/pedido/<token>`).
- **Painel do administrador**: cardápio, preços, turnos, horários de funcionamento e vendas.
- **Tela da cozinha** com os pedidos em andamento.
- **Página do entregador** (instalável no celular) com avisos push de "pedido pronto", mesmo com o navegador fechado.
- **Impressão automática** de tickets em impressora térmica, por meio de um programa externo.
- **Assistente virtual** no site do cliente, baseado em regras (sem IA e sem custo adicional).

## 🛠️ Tecnologias

| Camada | Tecnologia |
|---|---|
| Back-end | Python, Flask, Gunicorn |
| Banco de dados | SQLite |
| Front-end | HTML (Jinja), CSS e JavaScript puro |
| Notificações | Web Push (`pywebpush`) e Service Worker |
| Hospedagem | Render (serviço web com disco persistente) |

## 🧭 Páginas do sistema

| Rota | Para quem | O que faz |
|---|---|---|
| `/` | Clientes | Cardápio, promoções e post do dia |
| `/produto/<id>`, `/promocao/<id>` | Clientes | Detalhes e montagem do produto ou da promoção |
| `/carrinho` | Clientes | Carrinho, taxa de entrega, pagamento (Pix) e envio por WhatsApp |
| `/pedido/<token>`, `/meus-pedidos` | Clientes | Acompanhamento do pedido |
| `/admin` | Administrador | Cardápio, preços, tamanhos, bordas, turnos, horários e vendas |
| `/funcionarios` | Funcionários (senha do turno) | Registro de vendas |
| `/cozinha` | Cozinha | Pedidos em andamento |
| `/entregador` | Entregador | Pedidos prontos e em rota, avisos push |
| `/dev` | Desenvolvedor | Avisos de atualização para o administrador |

## 📁 Estrutura do projeto

```
app.py            Rotas, segurança, regras de pedido e preços
db.py             SQLite: esquema, leitura e escrita
delivery_fee.py   Taxa de entrega fixa por bairro
print_format.py   Formato do ticket para a impressora térmica
static/           JS, CSS, ícones e fotos (static/uploads)
templates/        Páginas HTML (Jinja)
data.json         Dados iniciais; só é usado se o banco estiver vazio
Procfile          Comando de inicialização (referência)
```

## 🚀 Como rodar localmente

```bash
pip install -r requirements.txt
ADMIN_PASSWORD=troque-isto python app.py   # http://localhost:5000
```

Sem `DATA_DIR`, o banco (`pizzaria.db`) e as fotos enviadas ficam dentro do projeto. O banco já está no `.gitignore`, então não vai para o repositório.

## ⚙️ Variáveis de ambiente

| Variável | Obrigatória | Para que serve |
|---|---|---|
| `SECRET_KEY` | Sim | Assina as sessões. Sem ela, cada reinício derruba todos os logins. |
| `ADMIN_PASSWORD` | Sim | Senha do `/admin`. Sem ela, o painel fica bloqueado. |
| `DEV_PASSWORD` | Sim | Senha do `/dev`. Sem ela, essa área fica bloqueada. |
| `DATA_DIR` | Sim no Render | Pasta do disco persistente (`/var/data`), onde ficam o banco e as fotos enviadas (`DATA_DIR/uploads`). |
| `TRUSTED_PROXIES` | Recomendada | Quantos proxies existem na frente do app. No Render (com Cloudflare), o valor é `2`. Sem ela, o limite de tentativas usa o primeiro valor de `X-Forwarded-For`, que pode ser falsificado. |
| `IP_DEBUG` | Não | `1` registra no log as primeiras 30 cadeias `X-Forwarded-For`, para calcular `TRUSTED_PROXIES`. Deixe em `0` ou sem definir. |
| `PRICE_ENFORCE` | Não | `1` faz valer o preço recalculado pelo servidor. Sem definir, apenas registra diferenças (`PRICE_DIFF`, `PRICE_UNSURE`, `PRICE_CHECK`) e vale o preço do navegador. |
| `SESSION_COOKIE_SECURE` | Não | Força `1`/`0`. Por padrão é `1` quando roda no Render. |
| `NEIGHBORHOOD_FEES` | Não | Taxas por bairro em JSON, por exemplo `{"piscinão de ramos": 3, "ramos": 10}` (é o valor padrão). |
| `VAPID_SUBJECT` | Não | Contato para os avisos push (e-mail real ou URL https do site). As chaves VAPID são geradas automaticamente e guardadas no banco. |
| `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_S` | Não | Limite geral da API por IP (padrão: 180 requisições a cada 60 s). |
| `FLASK_DEBUG`, `PORT` | Não | Apenas para rodar localmente. |

O Render define `RENDER` e `RENDER_EXTERNAL_HOSTNAME` automaticamente.

## ☁️ Deploy no Render

- Serviço web de Python com disco persistente montado em `/var/data` e `DATA_DIR=/var/data`.
- Build: `pip install -r requirements.txt`.
- Start: `gunicorn app:app --workers 1 --threads 16 --timeout 30 --keep-alive 5`. O Render usa este comando configurado no painel, não o `Procfile`. Usa-se **um único worker** de propósito: o limite de tentativas e a sessão da loja ficam em memória.
- Deploy automático a cada commit na `main`.
- No deploy, `init_db()` cria as tabelas e os índices que faltarem, sem tocar nos dados existentes.

## 🔒 Segurança e operação

- **Preços**: o carrinho envia `type`, `id` e `sel`; `price_line()` recalcula o preço a partir do banco e compara com o do navegador. Confira os logs `PRICE_DIFF` e `PRICE_UNSURE` depois de alguns pedidos reais, antes de ativar `PRICE_ENFORCE=1`.
- **Senhas de turno**: guardadas com hash. As antigas, em texto puro, são migradas na inicialização. Para trocar uma, edite o turno em `/admin`.
- **Cabeçalhos HTTP**: `nosniff`, `X-Frame-Options`, `Referrer-Policy` e uma CSP em modo *Report-Only* (os avisos aparecem como `CSP_REPORT` no log; há scripts inline nas páginas de produto e promoção).
- **Imagens**: apenas PNG, JPG, WEBP ou GIF, verificadas pelo conteúdo real. Máximo de 8 MB.
- **Cache de JS**: ao alterar `static/entregador.js` (ou os JS do admin), aumente o número `?v=` no `<script>` correspondente em `templates/`, para que os celulares não usem a versão antiga.
- **Impressora térmica**: um programa separado consulta `GET /api/pedidos/pendentes` com o cabeçalho `X-Print-Token` (o token é gerado em `/admin`; o programa de impressão roda no computador da pizzaria e não faz parte deste repositório).
- **Backups do cardápio**: o servidor guarda cópias do cardápio e o admin pode restaurar os produtos que faltarem.

## ✅ Testes manuais básicos

1. Abrir `/`, um produto e uma promoção.
2. Fazer um pedido de teste (com a loja aberta): ele deve aparecer em `/cozinha` e na impressora, e abrir o WhatsApp.
3. Em `/admin`, salvar o cardápio sem alterações e enviar uma foto.
4. Em `/entregador`, entrar com a senha do entregador e conferir os avisos.
5. Conferir os logs do Render: sem erros na inicialização e sem avisos `AVISO:` de variáveis faltando.

## 👤 Autor

Desenvolvido por **Alonso** — desenvolvedor back-end e front-end freelancer.
GitHub: [@Alons078](https://github.com/Alons078)
