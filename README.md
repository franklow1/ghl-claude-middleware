# GHL + Claude Sales Middleware

Middleware que conecta GoHighLevel con Claude API para automatizar ventas por Instagram DM.

## Cómo funciona

```
Prospecto manda DM → GHL detecta → Webhook a este servidor → Claude responde → GHL envía respuesta por DM
```

## Setup paso a paso

### 1. Sube el código a GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/tu-usuario/ghl-claude-middleware.git
git push -u origin main
```

### 2. Despliega en Railway

1. Ve a [railway.app](https://railway.app) y crea una cuenta
2. Click en "New Project" → "Deploy from GitHub repo"
3. Selecciona tu repositorio
4. Ve a la pestaña "Variables" y agrega:
   - `ANTHROPIC_API_KEY` = tu API key de Claude
   - `GHL_API_KEY` = tu API key de GHL
   - `SKOOL_PAYMENT_LINK` = link de pago de tu Skool
5. Railway te da una URL pública (ej: `https://tu-app.up.railway.app`)

### 3. Configura el Webhook en GHL

En tu Workflow de GHL, en el paso del Webhook:
- Method: POST
- URL: `https://tu-app.up.railway.app/webhook/ghl`
- Body (Custom):
```json
{
  "contact_id": "{{contact.id}}",
  "message": "{{message.body}}",
  "contact_name": "{{contact.first_name}}",
  "tags": "{{contact.tags}}",
  "pipeline_stage": "{{opportunity.stage_name}}"
}
```

### 4. Configura el Webhook de Stripe

En Stripe Dashboard:
1. Ve a Developers → Webhooks → Add endpoint
2. URL: `https://tu-app.up.railway.app/webhook/stripe`
3. Eventos: selecciona `checkout.session.completed`

## Personalización

### Cambiar los System Prompts
Edita `server.js` → sección `SYSTEM_PROMPTS`. Hay dos prompts:
- `venta_29`: Para vender la membresía de $29
- `upsell_900`: Para vender el plan anual de $900 (post-compra)

### IMPORTANTE: Antes de lanzar
1. Reemplaza `[TU NOMBRE]` en los system prompts con tu nombre real
2. Agrega tus testimonios reales en la sección de resultados
3. Actualiza el link de Skool
4. Prueba el flujo completo enviándote un DM a ti mismo

## Arquitectura

```
Instagram DM
    ↓
GoHighLevel (trigger + webhook)
    ↓
Este Middleware (server.js)
    ↓
Claude API (genera respuesta)
    ↓
GHL API (envía respuesta por DM)
    ↓
Instagram DM (prospecto recibe)
```

## Notas

- Las conversaciones se guardan en memoria. Si el servidor se reinicia, se pierden.
  Para producción, usa Redis o una base de datos.
- El delay de respuesta es aleatorio (30-90 seg) para parecer humano.
- Fuera de horario (11pm-8am) los mensajes no se responden.
  Puedes agregar una cola para enviarlos al día siguiente.
