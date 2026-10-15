# Rey Pizzaria — sitio de pedidos

Sitio web de la pizzería: menú público, carrito con envío del pedido por WhatsApp, seguimiento del pedido, panel de administración, cocina, empleados y página del repartidor. Flask + SQLite, pensado para correr barato en Render (0.5 CPU / 512 MB) y aguantar picos de clientes.

## Páginas

| Ruta | Para quién | Qué hace |
|---|---|---|
| `/` | Clientes | Menú, promociones y post del día |
| `/produto/<id>`, `/promocao/<id>` | Clientes | Detalle y armado del producto o promoción |
| `/carrinho` | Clientes | Carrito, tasa de entrega, pago (Pix) y envío por WhatsApp |
| `/pedido/<token>`, `/meus-pedidos` | Clientes | Seguimiento del pedido |
| `/admin` | Administrador | Menú, precios, tamaños, bordas, turnos, horarios, ventas |
| `/funcionarios` | Empleados (clave de turno) | Registro de ventas |
| `/cozinha` | Cocina | Pedidos en curso |
| `/entregador` | Repartidor | Pedidos listos y en ruta, avisos push |
| `/dev` | Desarrollador | Avisos para el administrador |

## Estructura

```
app.py            Rutas, seguridad, reglas de pedido y precios
db.py             SQLite: esquema, lectura y escritura
delivery_fee.py   Tasa de entrega fija por barrio
print_format.py   Formato del ticket para la impresora térmica
static/           JS, CSS, íconos y fotos incluidas en el repo (static/uploads)
templates/        Páginas HTML (Jinja)
data.json         Datos iniciales; solo se usa si la base está vacía
```

## Ejecutar en local

```bash
pip install -r requirements.txt
ADMIN_PASSWORD=cambia-esto python app.py   # http://localhost:5000
```

Sin `DATA_DIR`, la base (`pizzaria.db`) y las fotos subidas quedan dentro del proyecto. Ambas están en `.gitignore` o se pueden ignorar al hacer commit.

## Variables de entorno

| Variable | Obligatoria | Para qué sirve |
|---|---|---|
| `SECRET_KEY` | Sí | Firma las sesiones. Sin ella, cada reinicio cierra todos los logins. |
| `ADMIN_PASSWORD` | Sí | Clave de `/admin`. Sin ella el panel queda bloqueado. |
| `DEV_PASSWORD` | Sí | Clave de `/dev`. Sin ella esa área queda bloqueada. |
| `DATA_DIR` | Sí en Render | Carpeta del disco persistente (`/var/data`). Ahí viven la base y las fotos subidas (`DATA_DIR/uploads`). |
| `TRUSTED_PROXIES` | Recomendada | Cuántos proxies hay delante de la app. En Render (con Cloudflare) vale `2`. Sin ella, el límite de intentos usa el primer valor de `X-Forwarded-For`, que se puede falsificar. |
| `IP_DEBUG` | No | `1` registra en el log las primeras 30 cadenas `X-Forwarded-For`, para calcular `TRUSTED_PROXIES`. Déjala en `0` o sin definir. |
| `PRICE_ENFORCE` | No | `1` hace valer el precio recalculado por el servidor. Sin definir, solo registra diferencias (`PRICE_DIFF`, `PRICE_UNSURE`, `PRICE_CHECK`) y vale el precio del navegador. |
| `SESSION_COOKIE_SECURE` | No | Fuerza `1`/`0`. Por defecto es `1` cuando corre en Render. |
| `NEIGHBORHOOD_FEES` | No | Tasas por barrio en JSON, por ejemplo `{"piscinão de ramos": 3, "ramos": 10}` (es el valor por defecto). |
| `VAPID_SUBJECT` | No | Contacto para los avisos push. Las claves VAPID se generan solas y se guardan en la base. |
| `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_S` | No | Límite general de la API por IP (por defecto 180 peticiones por 60 s). |
| `FLASK_DEBUG`, `PORT` | No | Solo para ejecutar en local. |

Render define `RENDER` y `RENDER_EXTERNAL_HOSTNAME` automáticamente.

## Despliegue en Render

- Servicio web de Python con disco persistente montado en `/var/data` y `DATA_DIR=/var/data`.
- Build: `pip install -r requirements.txt`.
- Start: `gunicorn app:app --workers 1 --threads 16 --timeout 30 --keep-alive 5`. Render usa este comando del dashboard, no el `Procfile`. Se usa **un solo worker** a propósito: el límite de intentos y la sesión de la tienda viven en memoria.
- Despliegue automático con cada commit a `main`.
- Al desplegar, `init_db()` crea las tablas y los índices que falten sin tocar los datos existentes.

## Seguridad y operación

- **Precios**: el carrito manda `type`, `id` y `sel`; `price_line()` recalcula el precio desde la base y lo compara con el del navegador. Revisa los logs `PRICE_DIFF` y `PRICE_UNSURE` tras unos pedidos reales antes de activar `PRICE_ENFORCE=1`.
- **Contraseñas de turno**: se guardan con hash. Las antiguas en texto plano se migran al arrancar. Para cambiar una, edita el turno en `/admin`.
- **Encabezados**: `nosniff`, `X-Frame-Options`, `Referrer-Policy` y una CSP en modo *Report-Only* (los avisos aparecen como `CSP_REPORT` en el log; hay scripts en línea en las páginas de producto y promoción).
- **Imágenes**: solo PNG, JPG, WEBP o GIF, verificadas por su contenido real. Máximo 8 MB.
- **Caché de JS**: cuando cambies `static/entregador.js` (o los JS del admin), sube el número `?v=` en su `<script>` dentro de `templates/`, para que los celulares no usen la versión vieja.
- **Impresora térmica**: un programa aparte consulta `GET /api/pedidos/pendentes` con el encabezado `X-Print-Token` (el token se genera en `/admin`; el programa de impresión corre en el computador de la pizzería y no está en este repo).
- **Respaldos del menú**: el servidor guarda copias del cardápio y el admin puede restaurar los productos que falten.

## Pruebas manuales básicas

1. Abrir `/`, un producto y una promoción.
2. Hacer un pedido de prueba (con la tienda abierta): debe aparecer en `/cozinha` y en la impresora, y abrir WhatsApp.
3. En `/admin`, guardar el menú sin cambios y subir una foto.
4. En `/entregador`, entrar con la clave del repartidor y comprobar los avisos.
5. Revisar los logs de Render: sin errores al arrancar ni avisos `AVISO:` de variables faltantes.
