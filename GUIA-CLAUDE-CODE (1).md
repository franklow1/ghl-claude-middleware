# Guía Completa: Configurar todo con Claude Code

## ANTES DE ABRIR CLAUDE CODE — Prepara tu carpeta

1. Descarga toda esta carpeta `ghl-claude-middleware` a tu escritorio
2. Los videos ya están dentro en la carpeta `videos/`
3. Los archivos del proyecto (server.js, package.json, etc.) ya están listos

---

## REQUISITOS EN TU MAC

Necesitas tener instalado:
- Node.js → descárgalo de https://nodejs.org si no lo tienes
- Git → descárgalo de https://git-scm.com si no lo tienes
- Una cuenta en Railway → créala en https://railway.app
- Una cuenta en GitHub → créala en https://github.com

---

## PASO A PASO

### Paso 1: Abre la Terminal
Presiona Cmd + Espacio → escribe "Terminal" → Enter

### Paso 2: Instala Claude Code
Pega esto y dale Enter:
```bash
npm install -g @anthropic-ai/claude-code
```

### Paso 3: Entra a la carpeta del proyecto
```bash
cd ~/Desktop/ghl-claude-middleware
```

### Paso 4: Abre Claude Code
```bash
claude
```

### Paso 5: Pega este prompt 👇

---

## PROMPT PARA CLAUDE CODE (copia todo esto):

```
Necesito que hagas todo esto en orden:

## 1. TRANSCRIBIR LOS VIDEOS
Instala whisper (openai-whisper) y transcribe todos los archivos .mp4 que están en la carpeta videos/. Guarda cada transcripción en un archivo .txt. Si whisper no funciona, usa cualquier otra herramienta de transcripción que puedas instalar.

## 2. ANALIZAR MI TONO Y ESTILO
Lee todas las transcripciones y mi CLAUDE.md (si existe). Identifica:
- Las frases exactas que uso frecuentemente
- Mi tono (calmado, de mentor, sin hype)
- Cómo explico las cosas
- Qué argumentos de venta uso
- Cómo manejo objeciones
- Palabras o expresiones que repito

## 3. ACTUALIZAR EL SYSTEM PROMPT EN server.js
Con toda esa información, reescribe los system prompts dentro de server.js (hay dos: venta_29 y upsell_900). Los prompts deben:
- Sonar EXACTAMENTE como yo hablo en los videos
- Usar mis frases reales, no frases genéricas
- Mantener mi tono de mentor calmado y seguro
- Incluir los argumentos de venta que uso en mis videos
- Los testimonios reales ya están en el archivo, no los cambies
- Agregar cualquier información relevante sobre la oferta que encuentres en los videos

## 4. INSTALAR DEPENDENCIAS
Corre npm install para instalar todas las dependencias del proyecto.

## 5. PREPARAR PARA DEPLOY EN RAILWAY
- Inicializa un repositorio de git (git init, git add ., git commit)
- Instala Railway CLI si no está instalada (npm install -g @railway/cli)
- Dime los comandos exactos que necesito correr para hacer login en Railway y deployar

## 6. MOSTRARME EL RESULTADO
Al final muéstrame:
- Un resumen de lo que encontraste en los videos
- Los system prompts actualizados para que los revise
- Los pasos finales que tengo que hacer manualmente

IMPORTANTE: No me preguntes nada, solo hazlo todo en orden. Si algo falla, intenta una alternativa.
```

---

## DESPUÉS DE QUE CLAUDE CODE TERMINE

### Paso 6: Revisa los prompts
Lee los system prompts que Claude Code actualizó. Si algo no suena como tú, dile "cambia X por Y".

### Paso 7: Deploy a Railway
Corre estos comandos en la terminal:
```bash
railway login
railway init
railway up
```
Railway te da una URL como: https://tu-app.up.railway.app

### Paso 8: Configura variables en Railway
Ve a railway.app → tu proyecto → Variables → agrega:
- ANTHROPIC_API_KEY = (de console.anthropic.com)
- GHL_API_KEY = (de GHL → Settings → API Keys)
- SKOOL_PAYMENT_LINK = (tu link de pago de Skool)

### Paso 9: Configura el webhook en GHL
En tu Workflow (donde ya tienes el trigger de "SSA"):
1. Después del If/Else branch
2. Agrega acción "Webhook"
3. Method: POST
4. URL: https://tu-app.up.railway.app/webhook/ghl
5. Body → Custom:

```json
{
  "contact_id": "{{contact.id}}",
  "message": "{{message.body}}",
  "contact_name": "{{contact.first_name}}",
  "tags": "{{contact.tags}}",
  "pipeline_stage": "{{opportunity.stage_name}}"
}
```

### Paso 10: Configura webhook de Stripe
1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: https://tu-app.up.railway.app/webhook/stripe
3. Evento: checkout.session.completed

### Paso 11: Prueba
Envíate un DM a ti mismo con "SSA" en Instagram.

---

## SI ALGO FALLA
Vuelve a Claude Code y dile:
"Me está dando este error: [pega el error]. Arréglalo."

O vuelve a esta conversación conmigo y te ayudo.
