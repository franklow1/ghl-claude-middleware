const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

// ============================================
// CONFIGURACION
// ============================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "tu-api-key-aqui";
const GHL_API_KEY = process.env.GHL_API_KEY || "tu-ghl-api-key-aqui";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "tu-location-id";
const SKOOL_PAYMENT_LINK_199 = process.env.SKOOL_PAYMENT_LINK_199 || "https://www.skool.com/tu-comunidad";
const SKOOL_PAYMENT_LINK_997 = process.env.SKOOL_PAYMENT_LINK_997 || "https://www.skool.com/tu-comunidad/plan-anual";
const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID || "tu-pipeline-id";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Helper: headers base para todas las llamadas a GHL
const ghlHeaders = (version = "2021-07-28") => ({
  Authorization: `Bearer ${GHL_API_KEY}`,
  "Content-Type": "application/json",
  Version: version,
  Location: GHL_LOCATION_ID,
});

// ============================================
// REDIS
// ============================================
const REDIS_TTL = 90 * 24 * 60 * 60; // 90 dias en segundos

let redis = null;
let redisConnected = false;

try {
  const redisUrl = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || "redis://localhost:6379";
  // commandTimeout: ioredis lanza error si el comando tarda mas de 5s — evita colgarse
  redis = new Redis(redisUrl, { connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 1 });
  redis.on("error", (err) => { if (redisConnected) console.error("Redis error:", err.message); redisConnected = false; });
  redis.on("ready", () => { console.log("Redis listo"); redisConnected = true; });
  redis.on("connect", () => { redisConnected = true; });
  redis.on("close", () => { redisConnected = false; });
} catch (e) {
  console.error("Redis no disponible:", e.message);
  redis = null;
}

async function rGet(key) {
  if (!redis) return null;
  try { return await redis.get(key); } catch (e) { console.error(`rGet(${key}):`, e.message); return null; }
}

async function rSet(key, value, ttl) {
  if (!redis) return;
  try {
    if (ttl) await redis.set(key, value, "EX", ttl);
    else await redis.set(key, value);
  } catch (e) { console.error(`rSet(${key}):`, e.message); }
}

async function rKeys(pattern) {
  if (!redis) return [];
  try { return await redis.keys(pattern); } catch (e) { return []; }
}

async function rIncr(key) {
  if (!redis) return 0;
  try { return await redis.incr(key); } catch (e) { return 0; }
}

// ============================================
// ALMACEN DE CONVERSACIONES
// ============================================
const conversations = {};

async function saveConversation(contactId) {
  const isNew = !(await rGet(`conv:${contactId}`));
  await rSet(`conv:${contactId}`, JSON.stringify(conversations[contactId] || []), REDIS_TTL);
  if (isNew) await rIncr("metrics:total_conversaciones");
}

// ============================================
// ALMACEN DE ESTADO POR CONTACTO
// ============================================
const contactState = new Map();

async function saveState(contactId) {
  const state = contactState.get(contactId);
  if (!state) return;
  const toSave = { ...state, followUpTimers: [] }; // no guardar handles de timers
  await rSet(`state:${contactId}`, JSON.stringify(toSave), REDIS_TTL);
}

// ============================================
// SISTEMA DE APRENDIZAJE — PLAYBOOK EN MEMORIA
// ============================================
let currentPlaybook = null; // se carga desde Redis al arrancar
let playbookUpdatedAt = null;

// ============================================
// BUFFER DE MENSAJES (agrupacion 10s)
// ============================================
const messageBuffer = new Map();

// ============================================
// DETECCION DE MULTIMEDIA
// ============================================
const MULTIMEDIA_MARKERS = [
  "[audio]", "[imagen]", "[image]", "[video]", "[sticker]", "[gif]",
  "audio message", "voice message", "🎤", "🎵", "🎧",
];

function isMultimediaMessage(msg) {
  if (!msg || msg.trim() === "") return true;
  const lower = msg.toLowerCase().trim();
  return MULTIMEDIA_MARKERS.some((m) => lower.includes(m));
}

// ============================================
// COMO ESCRIBIR — se inyecta al inicio de cada prompt
// ============================================
const COMO_ESCRIBIR = `

========================================
COMO ESCRIBIR (esto es lo mas importante):
========================================

Escribe EXACTAMENTE como una persona real escribe por DM. Esto significa:

- todo en minusculas la mayor parte del tiempo. no empieces con mayuscula siempre
- no uses signos de exclamacion invertidos (¡) ni signos de pregunta invertidos (¿). solo el signo final
- usa "jaja" o "jajaja" cuando sea natural
- mensajes CORTOS. maximo 1-2 lineas por mensaje. si necesitas decir mas, dilo en mensajes separados
- a veces responde con una sola palabra: "claro", "si", "exacto", "dale"
- usa emojis con moderacion pero natural — un 💪 o un 👊 de vez en cuando, no en cada mensaje
- no escribas perfecto. a veces omite tildes. a veces no pongas punto al final
- NUNCA uses bullets ni listas. habla corrido
- suena como alguien que esta escribiendo rapido desde el celular, no como alguien redactando un email

EJEMPLOS DE COMO DEBE SONAR:
bien: "que bueno que me escribiste"
mal: "¡Qué bueno que me escribiste!"
bien: "y que haces actualmente? ya tienes algo montado o estas empezando?"
mal: "¿Qué haces actualmente? ¿Ya tienes algo montado o estás empezando desde cero?"
bien: "jaja si, eso es exactamente lo que enseño"
mal: "Sí, eso es exactamente lo que enseño."
`;

// ============================================
// INSTRUCCIONES ADICIONALES (se agregan a todos los prompts)
// ============================================
const ADDITIONAL_INSTRUCTIONS = `

========================================
INSTRUCCIONES ADICIONALES DE COMPORTAMIENTO
========================================

IDIOMA: Responde siempre en el mismo idioma que use el prospecto. Si escribe en portugues, responde en portugues. Si escribe en ingles, responde en ingles. Por defecto español neutro.

PREGUNTAS FUERA DE TEMA: Si te preguntan algo personal o no relacionado (que camara usas, donde vives, etc), responde brevemente y con buena onda, y despues redirige la conversacion naturalmente. No ignores la pregunta.

REACCIONES A STORIES: Si alguien responde con solo un emoji, una reaccion, o algo tipo "jajaja buenisimo", no le vendas inmediatamente. Responde casual y pregunta si le interesa saber mas sobre lo que haces.

DETECCION DE COMPETIDORES: Si alguien hace preguntas muy tecnicas sobre tu modelo de negocio, tus numeros exactos, tu estructura de precios, cuantos alumnos tienes, o suena como si estuviera investigando en vez de comprando, no des informacion detallada. Redirige: "eso lo vemos adentro de la comunidad" o "depende de cada caso".

MULTIPLES MENSAJES: Si recibes varios mensajes concatenados del prospecto, responde a todo de forma coherente como si fuera una sola conversacion. No ignores ninguna parte.

MANEJO DE YA COMPRE: Si alguien dice que ya pago o ya compro pero el sistema todavia no lo refleja, responde: "que bueno que entraste, a veces tarda unos minutos en activarse. Si en un rato no te llega el acceso me escribes y lo revisamos." No sigas vendiendo.

MANEJO DE QUEJAS O PROBLEMAS: Si alguien tiene un problema tecnico, una queja, o necesita soporte que no puedes resolver, responde con empatia y di: "dejame revisarlo y te escribo en un momento." Esto le da tiempo a Frank de intervenir manualmente.`;

// ============================================
// TOOLS
// ============================================
const TOOLS = [
  {
    name: "save_email",
    description:
      "Usa esta herramienta cuando el prospecto comparta su email. Guarda el email para vincularlo con su cuenta de Instagram en el CRM.",
    input_schema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "El email que el prospecto compartio",
        },
      },
      required: ["email"],
    },
  },
  {
    name: "send_payment_link",
    description:
      "Usa esta herramienta cuando el prospecto haya dado su email Y haya confirmado que quiere comprar. Envia el link de pago correspondiente a la etapa actual.",
    input_schema: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          enum: ["membresia_199", "plan_997"],
          description: "El plan que se le va a vender",
        },
      },
      required: ["plan"],
    },
  },
];

// ============================================
// SYSTEM PROMPTS
// ============================================
const _venta_199 = `Eres Frank Low. Vendes por DM en Instagram. Eres un closer de elite disfrazado de amigo. Calmado, seguro, directo. No eres bot. No eres vendedor. Eres Frank.

COMO ESCRIBES:
minusculas casi siempre
sin ¡ ni ¿
mensajes cortos, 1-2 lineas maximo
a veces una palabra: "claro", "exacto", "total"
"jaja" cuando sea natural
emojis con moderacion
sin puntos finales siempre
NUNCA bullets, NUNCA dashes (-), NUNCA guiones, NUNCA listas
suenas como alguien escribiendo rapido desde el cel

REGLA #0 — NO SUENES A CHATGPT:
PROHIBIDO usar: "que bueno", "excelente", "eso es genial", "que interesante", "perfecto", "sin duda", "tienes mentalidad de X", "eso te va a ayudar mucho", "me alegra que me cuentes"
PROHIBIDO usar dashes (-) o guiones para separar ideas
Frank no halaga. Frank pregunta. Frank escucha. Frank cierra.

REGLA #1 — MAXIMO 2 ORACIONES POR TURNO

REGLA #2 — SIEMPRE TERMINA CON UNA PREGUNTA:
TODOS tus mensajes terminan con pregunta (?). La UNICA excepcion es cuando mandas el link de pago. Si tu mensaje no termina en ? esta mal.

REGLA #3 — NUNCA STATEMENTS SIN PREGUNTA:
MAL: "lo bueno de este modelo es que no necesitas capital"
BIEN: "lo bueno es que no necesitas capital, sientes que eso te serviria?"
Siempre engancha con pregunta. Siempre.

REGLA #4 — LA COMUNIDAD ES LA SOLUCION PERFECTA:
NUNCA digas "te gustaria saber mas?" ni "quieres que te cuente?". Eso es pedir permiso y suena a vendedor. SIEMPRE presenta la comunidad como la solucion EXACTA y PERFECTA al problema ESPECIFICO que el prospecto acaba de describir. Despues pregunta "sientes que eso te ayudaria?" — eso es confirmar, no pedir permiso. La persona tiene que sentir "esto es justo lo que me faltaba".

REGLA #5 — ESPEJAR EL DOLOR:
Cuando el prospecto te dice su problema, repitelo con sus propias palabras antes de presentar la solucion. Esto genera conexion psicologica inmediata.
MAL: prospecto dice "no se por donde empezar" tu dices "tengo una comunidad que te enseña"
BIEN: prospecto dice "no se por donde empezar" tu dices "si, esa sensacion de no saber por donde empezar es lo que frena a la mayoria. justamente para eso arme la comunidad, para darte el paso a paso exacto desde cero, sientes que eso te ayudaria?"

REGLA #6 — LLEGA A LA VENTA LO MAS RAPIDO POSIBLE:
No te quedes en modo entrevista. El objetivo es llegar al paso 4 (presentar solucion) en maximo 4 turnos. Si la persona ya te dijo su dolor, no sigas preguntando. Presenta la solucion inmediatamente.

CONTEXTO DE FRANK (solo si preguntan):
Frank Low es Francisco Lopez. LOW = Living Our Way. $15K de deuda, vivio en una oficina, camino perros para comer. Construyo SSA desde cero. Hoy es nomada digital.

KNOWLEDGE BASE INTERNO — NO COMPARTIR, SOLO PARA ENTENDER:
SSA = Software Solutions Agency. Modelo basado en Go High Level (GHL), software todo-en-uno.
Con GHL puedes ofrecer: paginas web, funnels, automatizacion de citas, recordatorios por whatsapp/sms/email, captura de leads, CRM, email marketing, reputacion online, chatbots con IA, cursos online, sistemas de pago.
Funciona con cualquier negocio: barberos, dentistas, restaurantes, gimnasios, coaches, agencias.
Modelo tipico: $99-$199 instalacion + $98-$99/mes mantencion.
Niveles (adapta segun el prospecto, NUNCA expliques los 4):
Desde cero: paginas web + mantenimiento. Tangible, facil, sin experiencia necesaria. Es para entrar al juego.
Con experiencia: web + marketing + garantia de resultados. Cobras mas.
Avanzado: asociarte con creadores de contenido. Frank hizo meses de $34K+.
Experto: crear tu propio programa o comunidad.
Psicologia del ICP: no le falta info, le sobra. Le falta estructura y direccion. Cambia de modelo cada mes y resetea progreso. Se esconde detras del aprendizaje. Quiere automatizar antes de saber vender. El momento de compra es cuando dice "he intentado cosas pero no se que estoy haciendo" o "funciona para otros pero no para mi".
Filosofia de Frank: el problema no es info sino ejecucion. 10 conversaciones reales valen mas que 100 horas de contenido. La gente se va antes de que funcione. No necesitas info, necesitas incomodidad. Tu primer cliente no cae del cielo.
ESTA INFO ES SOLO PARA QUE ENTIENDAS EL NEGOCIO. NO la compartas a menos que el prospecto pregunte algo especifico. Tu trabajo es hacer preguntas y llevar a la venta, no dar clases.

TESTIMONIOS (usa maximo UNO, solo si necesitas social proof):
Cristobal cerro 4 clientes en un mes. Benjamin cerro puerta a puerta le pagaron cash. Alumno de 16 años sin experiencia con resultados desde las primeras semanas. Un alumno hizo $400 en 2 semanas sin capital. Sariel tenia el problema de no tener estructura y el programa le dio exactamente eso. Diego dijo que el entrenamiento le dio todas las herramientas para salir a vender. Simon cerro en barberias y salones.

=============================================
FLUJO DE VENTAS — SIGUE ESTE ORDEN EXACTO
=============================================

PASO 1 — SALUDO + BUSCAR EL SI:
"hey que onda 💪 quieres comenzar un negocio online?"
SOLO eso. Espera respuesta.

PASO 2 — BUSCAR EL DESEO:
"y por que quieres comenzar? cual es tu meta?"
SOLO pregunta. No des info. Espera respuesta.

PASO 3 — BUSCAR EL DOLOR:
"y por que crees que no lo has logrado todavia? que sientes que te ha faltado?"
SOLO pregunta. Espera respuesta. ESTE ES EL PASO MAS IMPORTANTE. Lo que diga aqui es lo que usas en el paso 4.

PASO 4 — PRESENTAR SOLUCION COMO LA RESPUESTA PERFECTA:
Espeja su dolor con sus propias palabras. Presenta la comunidad como la solucion EXACTA. Termina con "sientes que eso te ayudaria?"
Ejemplos segun lo que diga:
"no se por donde empezar" → "si, esa es la barrera mas comun. justamente para eso arme una comunidad donde te doy el paso a paso exacto desde cero, que hacer, que decirle a los clientes, todo. sientes que eso te ayudaria?"
"no tengo capital" → "total, yo empece sin nada tambien. el modelo que enseño no necesita capital porque tu primer cliente te paga desde el dia uno. tengo una comunidad donde explico todo el sistema, sientes que eso te serviria?"
"he probado cosas y nada funciona" → "si, eso pasa cuando no tienes un sistema claro. yo arme una comunidad donde te doy exactamente eso, el sistema completo para que no estes improvisando. sientes que eso es lo que te falta?"
"no se vender" → "eso es justamente lo que mas fuerte enseño adentro. te doy los scripts exactos de que decir en cada situacion con cada tipo de cliente. sientes que con eso podrias arrancar?"
"estudio y no tengo tiempo" → "claro, por eso es todo grabado y a tu ritmo. el modelo no necesita que le dediques 8 horas, con un par de horas a la semana puedes empezar a generar ingresos. sientes que te ayudaria tener esa estructura?"
LA CLAVE: la solucion tiene que sentirse HECHA PARA EL. No generica. Usa sus palabras exactas.

PASO 5 — PEDIR EMAIL:
SOLO cuando diga que si o muestre interes claro.
"me das tu correo para darte acceso?"
Usa save_email cuando lo de.

PASO 6 — MANDAR LINK:
Despues de guardar email, usa send_payment_link("membresia_199").
"aqui esta el link, avisame una vez que entres 👊"
NUNCA menciones el precio.

PASO 7 — FOLLOW UP POST-LINK:
Si no responde o tiene dudas:
"cuanto cuesta?" → "lo ves en el link, pero te digo que es una fraccion de lo que puedes generar con tu primer cliente"
"lo pienso" → "que te genera duda? te la resuelvo"
"no se vender" → "eso es exactamente lo que enseño adentro, que decir en cada situacion"
"ya gaste en cursos" → "esto no es un curso, es un sistema completo con el modelo de negocio incluido. sientes que la diferencia es esa estructura que te faltaba?"
"y eso funciona?" → comparte UN testimonio + "te gustaria intentarlo?"

REGLAS ABSOLUTAS:
NUNCA mencionar el precio
NUNCA decir que eres IA
NUNCA mas de 2 oraciones por turno
NUNCA listas, bullets, dashes ni guiones
NUNCA statements sin pregunta (excepto al mandar link)
SIEMPRE terminar con pregunta (excepto al mandar link)
NUNCA "te gustaria saber mas?" ni "quieres que te cuente?" — siempre "sientes que eso te ayudaria?"
NUNCA des info que no te pidieron. Tu trabajo es preguntar y cerrar, no dar clases
Solo español neutro
NUNCA inventes info
SSA = Software Solutions Agency siempre`;

const _upsell_997 = `Eres Frank Low. Esta persona acaba de entrar a la comunidad o ya es miembro activo. Ya confio en ti con su dinero. Tu rol ahora es conectar, entender como le va, y presentar el plan de coaching de $997 como el siguiente paso natural.

COMO ESCRIBES:
minusculas casi siempre
sin ¡ ni ¿
mensajes cortos, 1-2 lineas maximo
NUNCA bullets, NUNCA dashes, NUNCA listas
suenas como alguien escribiendo rapido desde el cel
SIEMPRE termina con pregunta (excepto al mandar link)

PRIMER MENSAJE CUANDO ENTRA A LA COMUNIDAD:
"bienvenido a la comunidad 👊 ahora que estas adentro tienes acceso a todo. pero si quieres lograr resultados mas rapido y de manera garantizada tengo algo que te puede servir mucho, sientes que te gustaria escuchar de que se trata?"

SI DICE QUE SI — PRESENTA EL PLAN:
El plan de coaching incluye llamadas grupales directas conmigo, soporte prioritario, y lo mas importante: una garantia total. Si en 12 meses no generas $1,000 con lo que aprendes, te devuelvo los $997 completos. El riesgo es cero — lo unico que puede pasar es que ganes. sientes que eso tiene sentido para ti?

LA GARANTIA ES TU ARGUMENTO MAS FUERTE:
Siempre encuadra el precio en terminos de riesgo cero. No vendes $997 — vendes certeza. El peor escenario es que recuperas mas de lo que pusiste. Eso no existe en ningun otro lado.

MANEJO DE OBJECIONES (1 oracion + pregunta):
"es mucho dinero" → "entiendo, pero piensalo asi: si en 12 meses no generas $1,000 te devuelvo los $997. el riesgo real es cero, que te genera duda entonces?"
"recien pague los $199" → "y ya viste que vale. son $798 mas por tener coaching directo conmigo y garantia total. sientes que eso cambia el calculo?"
"lo pienso" → "que te genera duda? te la resuelvo"
"la garantia es real?" → "100%, sin preguntas. si en 12 meses no llegaste a $1,000 te devuelvo los $997. cuando mas te ofrecen eso?"
"no puedo pagar de golpe" → "entendido, sigue con la membresia y cuando puedas la oferta sigue aqui. en que parte del proceso estas ahora?"

SI MUESTRA INTERES Y TIENES SU EMAIL:
Usa send_payment_link con plan "plan_997".
"aqui esta el link, avisame cuando entres 👊"

SI NO QUIERE:
"no hay problema, sigue con la membresia y cualquier duda me escribes. en que parte del proceso estas ahora?"
Queda en modo soporte. Si mas adelante ve apertura, puedes mencionarlo de nuevo sin presionar.

REGLAS ABSOLUTAS:
NUNCA decir que eres IA
NUNCA mas de 2 oraciones por turno
NUNCA listas, bullets ni dashes
SIEMPRE terminar con pregunta (excepto al mandar link)
Solo español neutro
NUNCA inventes info`;

const _plan_3000 = `Eres Frank Low. Esta persona YA pago el plan de $997/año. Es miembro comprometido. NO le vendas el plan de $3,000 directamente por DM. Tu rol aqui es de mentor y soporte.
` + COMO_ESCRIBIR + `

CONTEXTO:
Esta persona ya invirtio $997 y esta en coaching. Sabe que existe un nivel mas — el plan VIP de $3,000/año — pero no lo empujes. Solo mencionalo si la persona pregunta directamente o si la conversacion llega naturalmente a ese punto.

EL PLAN VIP — $3,000/año (solo si pregunta):
- Cursos avanzados enfocados en escalar a +$10K USD mensuales
- Acceso a una clase semanal extra llamada "Sala VIP" donde se resuelven dudas avanzadas
- Para gente que ya tiene resultados y quiere ir al siguiente nivel

TU ROL EN ESTA ETAPA:
- Responde preguntas, ayuda con lo que necesite
- Celebra sus logros
- Si pregunta como escalar mas o si hay algo mas avanzado, ahi puedes mencionar el plan VIP de forma natural
- Si no pregunta, no lo menciones

REGLAS QUE NO SE ROMPEN:
- Español neutro siempre. NO argentinismos. NO chilenismos. Neutro.
- Tono de mentor que esta orgulloso del progreso de su alumno
- NO vendas el plan de $3,000 a menos que la conversacion lo pida
- Respuestas de 2-5 lineas
- NUNCA decir que eres IA ni bot
- Solo en español neutro`;

// ============================================
// FUNCION: Determinar que prompt usar (inyecta playbook si existe)
// ============================================
function getSystemPrompt(tags, pipelineStage) {
  let base;
  if (tags?.includes("plan_3000") || pipelineStage === "plan_vip") {
    base = _plan_3000 + ADDITIONAL_INSTRUCTIONS;
  } else if (tags?.includes("plan_997") || pipelineStage === "plan_997") {
    base = _plan_3000 + ADDITIONAL_INSTRUCTIONS;
  } else if (
    tags?.includes("miembro_activo") ||
    pipelineStage === "membresia_vendida" ||
    pipelineStage === "upsell_en_proceso"
  ) {
    base = _upsell_997 + ADDITIONAL_INSTRUCTIONS;
  } else {
    base = _venta_199 + ADDITIONAL_INSTRUCTIONS;
  }

  if (currentPlaybook) {
    base += `

========================================
PLAYBOOK DE VENTAS (generado automaticamente con datos reales de tus conversaciones):
${JSON.stringify(currentPlaybook, null, 2)}

Usa esta informacion para mejorar tus respuestas. Prioriza las frases y estrategias que han demostrado funcionar en conversaciones reales. Evita los errores documentados. Adapta tu enfoque segun el perfil del prospecto.
========================================`;
  }

  return base;
}

// ============================================
// FUNCION: Guardar email en GHL
// ============================================
async function saveEmailToGHL(contactId, email) {
  try {
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: "PUT",
      headers: ghlHeaders("2021-07-28"),
      body: JSON.stringify({ email, tags: ["email_capturado"] }),
    });
    console.log(`Email guardado para contacto ${contactId}: ${email}`);
    return true;
  } catch (error) {
    console.error("Error guardando email en GHL:", error);
    return false;
  }
}

// ============================================
// FUNCION: Agregar tag en GHL
// ============================================
async function addTagToGHL(contactId, tag) {
  try {
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: "PUT",
      headers: ghlHeaders("2021-07-28"),
      body: JSON.stringify({ tags: [tag] }),
    });
    // Disparar analisis de aprendizaje segun el tag
    if (tag === "lead_frio") {
      analyzeLoss(contactId).catch((e) => console.error("Error analizando perdida:", e));
    }
  } catch (error) {
    console.error(`Error agregando tag ${tag} a ${contactId}:`, error);
  }
}

// ============================================
// FUNCION: Remover tag en GHL
// ============================================
async function removeTagFromGHL(contactId, tag) {
  try {
    await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}/tags`,
      {
        method: "DELETE",
        headers: ghlHeaders("2021-07-28"),
        body: JSON.stringify({ tags: [tag] }),
      }
    );
  } catch (error) {
    console.error(`Error removiendo tag ${tag} de ${contactId}:`, error);
  }
}

// ============================================
// FUNCION: Procesar tool calls de Claude
// ============================================
async function processToolCalls(response, contactId) {
  let textResponse = "";
  let toolResults = [];
  let lastPaymentLink = null;
  let emailSaved = false;
  let emailFailed = false;

  for (const block of response.content) {
    if (block.type === "text") {
      textResponse += block.text;
    } else if (block.type === "tool_use") {
      if (block.name === "save_email") {
        const success = await saveEmailToGHL(contactId, block.input.email);
        if (success) emailSaved = true; else emailFailed = true;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: success
            ? `Email ${block.input.email} guardado correctamente en el CRM.`
            : "Error al guardar el email. Pide que lo mande de nuevo.",
        });
      } else if (block.name === "send_payment_link") {
        const link =
          block.input.plan === "membresia_199"
            ? SKOOL_PAYMENT_LINK_199
            : SKOOL_PAYMENT_LINK_997;
        const state = contactState.get(contactId);
        if (state) {
          state.mode = "post_link";
          await saveState(contactId);
        }
        lastPaymentLink = link;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Link de pago listo. Incluye este link en tu respuesta al prospecto: ${link}`,
        });
      }
    }
  }

  return { textResponse, toolResults, lastPaymentLink, emailSaved, emailFailed };
}

// ============================================
// FUNCION: Llamar a Claude API (con retry + fallbacks humanos)
// ============================================
async function callClaude(contactId, newMessage, tags, pipelineStage) {
  // Cargar conversacion desde Redis si no está en memoria (lazy load tras reinicio)
  if (!conversations[contactId]) {
    const stored = await rGet(`conv:${contactId}`);
    conversations[contactId] = stored ? JSON.parse(stored) : [];
  }

  conversations[contactId].push({ role: "user", content: newMessage });

  if (conversations[contactId].length > 30) {
    conversations[contactId] = conversations[contactId].slice(-30);
  }

  const systemPrompt = getSystemPrompt(tags, pipelineStage);
  const claudeParams = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 400,
    system: systemPrompt,
    messages: conversations[contactId],
    tools: TOOLS,
  };

  // Helper: llamar a Claude con 1 retry automático
  async function callWithRetry(params) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      console.error("Claude primera llamada falló, reintentando:", err.message);
      await new Promise(r => setTimeout(r, 2000));
      return await anthropic.messages.create(params);
    }
  }

  try {
    let response = await callWithRetry(claudeParams);
    let { textResponse, toolResults, lastPaymentLink, emailSaved, emailFailed } =
      await processToolCalls(response, contactId);

    if (toolResults.length > 0) {
      conversations[contactId].push({ role: "assistant", content: response.content });
      conversations[contactId].push({ role: "user", content: toolResults });

      let secondText = "";
      try {
        const secondResponse = await callWithRetry({
          ...claudeParams,
          messages: conversations[contactId],
        });
        const secondPass = await processToolCalls(secondResponse, contactId);
        secondText = secondPass.textResponse;
      } catch (err) {
        console.error("Segunda llamada a Claude falló:", err.message);
      }

      // Si la segunda llamada devuelve texto, usarlo
      // Si no, construir fallback según qué herramienta se usó
      if (secondText) {
        textResponse = secondText;
      } else if (emailFailed) {
        textResponse = "no me llego bien el email, me lo mandas de nuevo?";
      } else if (lastPaymentLink) {
        // save_email exitoso o send_payment_link directo
        textResponse = `ahi tienes el acceso 👊\n${lastPaymentLink}`;
      } else if (emailSaved) {
        // Email guardado pero aún no se mandó el link — construirlo manualmente
        const link = SKOOL_PAYMENT_LINK_199;
        textResponse = `listo, ahi te va el link 👊\n${link}`;
      }
    }

    const finalMessage = textResponse || "perdon, se me trabo el cel jaja, que me decias?";

    conversations[contactId].push({ role: "assistant", content: finalMessage });
    await saveConversation(contactId);

    return finalMessage;
  } catch (error) {
    console.error("Error en callClaude (ambos intentos fallaron):", error);
    return "perdon, se me trabo el cel jaja, que me decias?";
  }
}

// ============================================
// FUNCION: Dividir respuesta en mensajes cortos
// ============================================
function splitMessage(text) {
  if (!text) return [];

  const cleaned = text.trim().replace(/\n{2,}/g, "\n");

  // Si es corto y de una sola línea, mandarlo tal cual
  if (cleaned.length <= 160 && !cleaned.includes("\n")) return [cleaned];

  // Dividir primero por saltos de línea
  const byLines = cleaned.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  const parts = [];
  for (const line of byLines) {
    if (line.length <= 160) {
      parts.push(line);
    } else {
      // Dividir líneas largas por oraciones (., ?, !)
      const sentences = line.split(/(?<=[.?!])\s+/);
      for (const s of sentences) {
        const trimmed = s.trim();
        if (trimmed) parts.push(trimmed);
      }
    }
  }

  // Máximo 2 mensajes por turno
  return parts.filter(p => p.length > 0).slice(0, 2);
}

// ============================================
// FUNCION: Enviar respuesta a GHL
// ============================================
async function sendReplyToGHL(contactId, message) {
  try {
    // Buscar conversationId UNA sola vez
    const searchResponse = await fetch(
      `https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&limit=1`,
      { method: "GET", headers: ghlHeaders("2021-07-28") }
    );
    const searchData = await searchResponse.json();
    console.log(`Busqueda conversacion ${contactId} [${searchResponse.status}]:`, JSON.stringify(searchData).substring(0, 300));
    const conversationId = searchData.conversations?.[0]?.id;

    if (!conversationId) {
      console.error("No se encontro conversacion para contacto:", contactId, "| HTTP:", searchResponse.status);
      return;
    }

    const parts = splitMessage(message);
    console.log(`Enviando ${parts.length} mensaje(s) a ${contactId}`);

    // Enviar en secuencia estricta con await — nunca en paralelo
    for (const part of parts) {
      const sendRes = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
        method: "POST",
        headers: ghlHeaders("2021-07-28"),
        body: JSON.stringify({ type: "IG", contactId, conversationId, message: part }),
      });
      const sendData = await sendRes.json();
      console.log(`POST msg [${sendRes.status}]: ${part.substring(0, 60)}`);
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`Respuesta enviada a ${contactId}: ${message.substring(0, 50)}...`);
  } catch (error) {
    console.error("Error enviando respuesta a GHL:", error);
  }
}

// ============================================
// SISTEMA DE FOLLOW-UP
// ============================================

function getOrCreateState(contactId, tags, pipelineStage) {
  if (!contactState.has(contactId)) {
    contactState.set(contactId, {
      prospectTimestamps: [],
      claudeTimestamps: [],
      followUpCount: 0,
      mode: "conversacion",
      followUpTimers: [],
      tags: tags || [],
      pipelineStage: pipelineStage || "",
    });
  }
  return contactState.get(contactId);
}

// Calcula el ritmo promedio de respuesta del prospecto en ms
function calcAvgRhythm(timestamps) {
  if (timestamps.length < 2) return 15 * 60 * 1000; // default 15 min
  const diffs = [];
  for (let i = 1; i < timestamps.length; i++) {
    diffs.push(timestamps[i] - timestamps[i - 1]);
  }
  return diffs.reduce((a, b) => a + b, 0) / diffs.length;
}

// Calcula delay del primer follow-up: doble del ritmo, entre 10 y 30 min
function calcFirstFollowUpDelay(state) {
  const avg = calcAvgRhythm(state.prospectTimestamps);
  const delay = avg * 2;
  const min = 10 * 60 * 1000;
  const max = 30 * 60 * 1000;
  return Math.min(Math.max(delay, min), max);
}

function isWithinHours() {
  const hour = new Date().getHours();
  return hour >= 8 && hour <= 23;
}

function msUntil9amTomorrow() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, Math.floor(Math.random() * 5), 0, 0);
  return tomorrow - Date.now();
}

function cancelFollowUpTimers(contactId) {
  const state = contactState.get(contactId);
  if (!state) return;
  state.followUpTimers.forEach((t) => clearTimeout(t));
  state.followUpTimers = [];
  console.log(`Timers de follow-up cancelados para ${contactId}`);
}

function scheduleOneFollowUp(contactId, delayMs, followUpNumber, instruction) {
  const state = contactState.get(contactId);
  if (!state) return;

  const execute = async () => {
    const currentState = contactState.get(contactId);
    if (!currentState) return;

    if (!isWithinHours()) {
      console.log(`Follow-up ${followUpNumber} fuera de horario, reagendando a las 9am`);
      const timer = setTimeout(execute, msUntil9amTomorrow());
      currentState.followUpTimers.push(timer);
      return;
    }

    currentState.followUpCount = followUpNumber;
    console.log(`Ejecutando follow-up ${followUpNumber} para ${contactId} (modo: ${currentState.mode})`);

    const followUpPrompt =
      getSystemPrompt(currentState.tags, currentState.pipelineStage) +
      `\n\n========================================\nINSTRUCCION ESPECIAL PARA ESTE MENSAJE (follow-up ${followUpNumber})\n========================================\n${instruction}`;

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        system: followUpPrompt,
        messages: conversations[contactId] || [],
        tools: TOOLS,
      });

      let text = "";
      for (const block of response.content) {
        if (block.type === "text") text += block.text;
      }

      if (!text) return;

      if (!conversations[contactId]) conversations[contactId] = [];
      conversations[contactId].push({ role: "assistant", content: text });
      await saveConversation(contactId);

      await sendReplyToGHL(contactId, text);
      currentState.claudeTimestamps.push(Date.now());

      if (followUpNumber >= 3) {
        await addTagToGHL(contactId, "lead_frio");
        console.log(`Contacto ${contactId} marcado como lead_frio`);
      }
    } catch (error) {
      console.error(`Error en follow-up ${followUpNumber} para ${contactId}:`, error);
    }
  };

  const timer = setTimeout(execute, delayMs);
  state.followUpTimers.push(timer);
}

function scheduleFollowUps(contactId) {
  const state = contactState.get(contactId);
  if (!state) return;

  cancelFollowUpTimers(contactId);
  state.followUpCount = 0;

  if (state.mode === "conversacion") {
    const fu1Delay = calcFirstFollowUpDelay(state);

    scheduleOneFollowUp(
      contactId,
      fu1Delay,
      1,
      `El prospecto dejo de responder. Analiza el ultimo intercambio e infiere por que se enfrio. No mandes un "follow-up". Manda algo que parezca que se te acaba de ocurrir y que sea relevante a su situacion especifica. Puede ser un testimonio nuevo, algo que acabas de ver, o un angulo diferente que conecte con el dolor que te compartio. NO digas "oye no se si viste mi mensaje" ni "te escribo de nuevo". Maximo 2 lineas. Tiene que sonar como un mensaje nuevo, no como persecucion.`
    );

    scheduleOneFollowUp(
      contactId,
      6 * 60 * 60 * 1000,
      2,
      `Pasaron varias horas sin respuesta. Analiza que fue lo ultimo que se dijo y por que pudo haberse enfriado. Si parece que tenia una duda sin resolver, resuelvela sin que te la pida. Si parece que necesitaba mas prueba social, comparte un resultado diferente. Si simplemente se distrajo, manda algo que aporte valor puro. Maximo 2 lineas. Que se sienta como contenido, no como seguimiento.`
    );

    scheduleOneFollowUp(
      contactId,
      24 * 60 * 60 * 1000,
      3,
      `Ultimo mensaje. Algo breve y sin presion tipo "por cierto, si algun dia quieres retomar esto me escribes y seguimos donde nos quedamos". Despues de esto no se mandan mas mensajes a menos que el prospecto escriba primero.`
    );
  } else {
    // post_link
    scheduleOneFollowUp(
      contactId,
      2 * 60 * 60 * 1000,
      1,
      `El prospecto tiene el link pero no ha pagado. NO preguntes si pago. Manda algo que refuerce la decision — un resultado especifico de alguien similar, algo que va a encontrar adentro, o anticipa una duda comun y resuelvela. Maximo 2 lineas.`
    );

    scheduleOneFollowUp(
      contactId,
      24 * 60 * 60 * 1000,
      2,
      `Un dia despues. Manda algo natural que aporte valor y sutilmente recuerde la oportunidad. Puede ser "por cierto, si te genera duda algo del proceso me dices". Sin presion.`
    );

    scheduleOneFollowUp(
      contactId,
      72 * 60 * 60 * 1000,
      3,
      `Ultimo mensaje. "Sin presion, cuando estes listo aqui estoy." Corto. Despues de esto no se mandan mas.`
    );
  }

  console.log(`Follow-ups agendados para ${contactId} (modo: ${state.mode})`);
}

// ============================================
// PROCESAMIENTO DE MENSAJES AGRUPADOS
// ============================================
async function processBufferedMessages(contactId) {
  const buffer = messageBuffer.get(contactId);
  if (!buffer || buffer.messages.length === 0) return;

  const combinedMessage = buffer.messages.join("\n");
  const { tags, pipelineStage, contactName } = buffer;
  messageBuffer.delete(contactId);

  console.log(
    `Procesando ${buffer.messages.length} msg(s) de ${contactName} (${contactId}): ${combinedMessage.substring(0, 80)}`
  );

  // Manejo de multimedia / mensaje vacio
  if (isMultimediaMessage(combinedMessage)) {
    const response = "jaja perdona, ahora no puedo escuchar audios, me lo escribes?";
    if (!conversations[contactId]) conversations[contactId] = [];
    conversations[contactId].push({ role: "assistant", content: response });
    await saveConversation(contactId);
    await sendReplyToGHL(contactId, response);
    return;
  }

  // Actualizar estado del contacto
  const state = getOrCreateState(contactId, tags, pipelineStage);
  state.prospectTimestamps.push(Date.now());
  state.tags = tags || state.tags;
  state.pipelineStage = pipelineStage || state.pipelineStage;

  // Cancelar follow-ups pendientes (el prospecto respondio)
  cancelFollowUpTimers(contactId);

  // Remover tag lead_frio si existia
  await removeTagFromGHL(contactId, "lead_frio");

  // Persistir estado
  await saveState(contactId);

  // Verificar horario
  const hour = new Date().getHours();
  if (hour < 8 || hour > 23) {
    console.log(`Fuera de horario para ${contactId}, ignorando`);
    return;
  }

  // Llamar a Claude
  const claudeResponse = await callClaude(contactId, combinedMessage, tags, pipelineStage);
  state.claudeTimestamps.push(Date.now());

  // Enviar respuesta
  await sendReplyToGHL(contactId, claudeResponse);

  // Agendar follow-ups
  scheduleFollowUps(contactId);
}

// ============================================
// SISTEMA DE APRENDIZAJE
// ============================================

async function checkAndUpdatePlaybook() {
  try {
    const count = parseInt(await rGet("metrics:analyses_count") || "0");
    if (count > 0 && count % 5 === 0) {
      console.log(`Generando nuevo playbook con ${count} analisis acumulados...`);
      await generatePlaybook();
    }
  } catch (e) {
    console.error("Error verificando playbook:", e);
  }
}

async function generatePlaybook() {
  try {
    const winsRaw = await rGet("wins:all");
    const lossesRaw = await rGet("losses:all");
    const wins = JSON.parse(winsRaw || "[]");
    const losses = JSON.parse(lossesRaw || "[]");

    if (wins.length + losses.length === 0) return;

    const allData = JSON.stringify({ wins, losses }, null, 2);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `Eres un experto en ventas por DM. Tienes acceso a datos reales de conversaciones — cuales funcionaron y cuales no. Con esta informacion, genera un PLAYBOOK actualizado en formato JSON:
{
  "mejores_frases": ["lista de las frases exactas que mas convirtieron"],
  "mejores_testimonios": ["lista de que testimonios funcionaron mejor y para que tipo de prospecto"],
  "objeciones_frecuentes": [{"objecion": "texto", "mejor_respuesta": "la respuesta que mejor funciono"}],
  "patrones_de_exito": ["lista de patrones que se repiten en ventas exitosas"],
  "errores_a_evitar": ["lista de cosas que hicieron que se perdieran ventas"],
  "perfiles_dificiles": [{"perfil": "tipo", "estrategia_recomendada": "como manejarlos"}],
  "tiempo_promedio_cierre": "numero promedio de mensajes para cerrar",
  "mejor_momento_pedir_email": "en que momento de la conversacion funciona mejor pedir el email",
  "insights_nuevos": ["cualquier patron o insight que no estaba en el playbook anterior"]
}
Responde SOLO el JSON, nada mas.

DATOS:
${allData}`,
        },
      ],
    });

    const text = response.content[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("No se pudo parsear JSON del playbook");
      return;
    }

    const playbook = JSON.parse(jsonMatch[0]);
    currentPlaybook = playbook;
    playbookUpdatedAt = new Date().toISOString();

    await rSet("playbook:current", JSON.stringify(playbook));
    await rSet("playbook:updated_at", playbookUpdatedAt);

    console.log("Playbook actualizado con", wins.length, "wins y", losses.length, "losses");
  } catch (e) {
    console.error("Error generando playbook:", e);
  }
}

async function analyzeWin(contactId) {
  try {
    const conv = conversations[contactId];
    if (!conv || conv.length < 4) return;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `Analiza esta conversacion de venta exitosa. Extrae en formato JSON:
{
  "perfil_prospecto": "descripcion corta del tipo de persona (principiante, con experiencia, esceptico, etc)",
  "dolor_principal": "cual era su problema o frustracion principal",
  "objecion_principal": "cual fue la objecion mas fuerte que puso, o null si no hubo",
  "que_funciono": "que frase, argumento o momento fue el punto de inflexion que lo convencio",
  "testimonio_usado": "que testimonio se uso y si fue efectivo",
  "mensajes_hasta_cierre": 0,
  "patron": "descripcion de una linea del patron de esta venta exitosa"
}
Responde SOLO el JSON, nada mas.

CONVERSACION:
${JSON.stringify(conv)}`,
        },
      ],
    });

    const text = response.content[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const analysis = JSON.parse(jsonMatch[0]);
    analysis.contact_id = contactId;
    analysis.timestamp = new Date().toISOString();

    const winsRaw = await rGet("wins:all");
    const wins = JSON.parse(winsRaw || "[]");
    wins.push(analysis);
    await rSet("wins:all", JSON.stringify(wins));

    await rIncr("metrics:analyses_count");
    await checkAndUpdatePlaybook();

    console.log(`Win analizado para ${contactId}: ${analysis.patron}`);
  } catch (e) {
    console.error("Error analizando win:", e);
  }
}

async function analyzeLoss(contactId) {
  try {
    const conv = conversations[contactId];
    if (!conv || conv.length < 2) return;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `Analiza esta conversacion donde el prospecto no compro. Extrae en formato JSON:
{
  "perfil_prospecto": "descripcion corta del tipo de persona",
  "dolor_principal": "cual era su problema",
  "punto_de_quiebre": "en que momento exacto se enfrio la conversacion y por que",
  "que_fallo": "que se podria haber hecho diferente para no perderlo",
  "objecion_no_resuelta": "cual fue la objecion que no se logro manejar",
  "leccion": "que aprendizaje se saca de esta conversacion perdida"
}
Responde SOLO el JSON, nada mas.

CONVERSACION:
${JSON.stringify(conv)}`,
        },
      ],
    });

    const text = response.content[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const analysis = JSON.parse(jsonMatch[0]);
    analysis.contact_id = contactId;
    analysis.timestamp = new Date().toISOString();

    const lossesRaw = await rGet("losses:all");
    const losses = JSON.parse(lossesRaw || "[]");
    losses.push(analysis);
    await rSet("losses:all", JSON.stringify(losses));

    await rIncr("metrics:analyses_count");
    await checkAndUpdatePlaybook();

    console.log(`Loss analizado para ${contactId}: ${analysis.leccion}`);
  } catch (e) {
    console.error("Error analizando loss:", e);
  }
}

// ============================================
// ENDPOINT: Webhooks de GHL
// ============================================
app.post("/webhook/ghl", async (req, res) => {
  console.log("GHL PAYLOAD:", JSON.stringify(req.body));
  const body = req.body;

  // GHL envía el contactId en el root
  const contact_id = body.contact_id || body.customData?.contact_id;

  // El mensaje viene como objeto {type, body} o como string
  const rawMessage = body.message;
  const messageText = typeof rawMessage === "string"
    ? rawMessage
    : (rawMessage?.body || rawMessage?.text || body.customData?.message || "");

  // El nombre viene en first_name o full_name en el root
  const contact_name = body.first_name || body.full_name || body.customData?.contact_name || "Prospecto";

  // Los tags reales vienen en el root como string separado por comas
  const tagsRaw = body.tags || body.customData?.tags || "";
  const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : [];

  // Pipeline stage viene en customData
  const pipeline_stage = body.pipeline_stage || body.customData?.pipeline_stage || "";

  console.log(`Mensaje de ${contact_name} (${contact_id}): ${messageText} | tags: [${tags}]`);
  res.status(200).json({ status: "processing" });

  // Agregar al buffer y esperar 10s por mas mensajes
  if (messageBuffer.has(contact_id)) {
    const buffer = messageBuffer.get(contact_id);
    buffer.messages.push(messageText);
    clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => processBufferedMessages(contact_id), 10000);
  } else {
    const timer = setTimeout(() => processBufferedMessages(contact_id), 10000);
    messageBuffer.set(contact_id, {
      messages: [messageText],
      timer,
      tags,
      pipelineStage: pipeline_stage,
      contactName: contact_name,
    });
  }
});

// ============================================
// ENDPOINT: Webhook de Stripe (pagos)
// ============================================
app.post("/webhook/stripe", async (req, res) => {
  const event = req.body;

  if (event.type === "checkout.session.completed") {
    const email = event.data.object.customer_details?.email;
    const amount = event.data.object.amount_total;

    console.log(`Pago recibido: ${email} - $${amount / 100}`);

    try {
      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/search/duplicate?email=${email}`,
        { headers: ghlHeaders("2021-07-28") }
      );
      const searchData = await searchRes.json();
      const contactId = searchData.contact?.id;

      if (contactId) {
        let newTag = "miembro_activo";
        if (amount >= 300000) newTag = "plan_3000";
        else if (amount >= 99700) newTag = "plan_997";

        await fetch(
          `https://services.leadconnectorhq.com/contacts/${contactId}`,
          {
            method: "PUT",
            headers: ghlHeaders("2021-07-28"),
            body: JSON.stringify({ tags: [newTag] }),
          }
        );

        cancelFollowUpTimers(contactId);
        console.log(`Contacto ${contactId} actualizado: tag=${newTag}`);

        // Analizar venta exitosa
        analyzeWin(contactId).catch((e) => console.error("Error analizando win:", e));
      } else {
        console.log(`No se encontro contacto con email ${email} en GHL`);
      }
    } catch (error) {
      console.error("Error procesando pago:", error);
    }
  }

  res.status(200).json({ received: true });
});

// ============================================
// ENDPOINT: Webhook de Zapier/Skool
// ============================================
app.post("/webhook/skool", async (req, res) => {
  const { email, plan } = req.body;

  console.log(`Nuevo miembro Skool: ${email} - plan: ${plan}`);

  try {
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/search/duplicate?email=${email}`,
      { headers: ghlHeaders("2021-07-28") }
    );
    const searchData = await searchRes.json();
    const contactId = searchData.contact?.id;

    if (contactId) {
      await fetch(
        `https://services.leadconnectorhq.com/contacts/${contactId}`,
        {
          method: "PUT",
          headers: ghlHeaders("2021-07-28"),
          body: JSON.stringify({ tags: ["miembro_activo"] }),
        }
      );
      cancelFollowUpTimers(contactId);
      console.log(`Miembro Skool ${email} vinculado a contacto ${contactId}`);

      // Analizar venta exitosa
      analyzeWin(contactId).catch((e) => console.error("Error analizando win:", e));
    }
  } catch (error) {
    console.error("Error procesando webhook Skool:", error);
  }

  res.status(200).json({ received: true });
});

// ============================================
// ENDPOINT: Metricas del sistema de aprendizaje
// ============================================
app.get("/metrics", async (req, res) => {
  try {
    const winsRaw = await rGet("wins:all");
    const lossesRaw = await rGet("losses:all");
    const wins = JSON.parse(winsRaw || "[]");
    const losses = JSON.parse(lossesRaw || "[]");
    const playbookTs = await rGet("playbook:updated_at");
    const totalConvCount = parseInt(await rGet("metrics:total_conversaciones") || "0");

    const tasa =
      wins.length + losses.length > 0
        ? ((wins.length / (wins.length + losses.length)) * 100).toFixed(1)
        : "0.0";

    const avgCierre =
      wins.length > 0
        ? (
            wins.reduce((a, b) => a + (b.mensajes_hasta_cierre || 0), 0) /
            wins.length
          ).toFixed(1)
        : null;

    // Objecion mas comun (de wins y losses)
    const objCounts = {};
    [...wins, ...losses].forEach((a) => {
      const obj = a.objecion_principal || a.objecion_no_resuelta;
      if (obj && obj !== "null" && obj !== null) {
        objCounts[obj] = (objCounts[obj] || 0) + 1;
      }
    });
    const objecionMasComun =
      Object.entries(objCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // Perfil que mas convierte
    const perfilCounts = {};
    wins.forEach((w) => {
      if (w.perfil_prospecto) {
        perfilCounts[w.perfil_prospecto] = (perfilCounts[w.perfil_prospecto] || 0) + 1;
      }
    });
    const perfilQueMasConvierte =
      Object.entries(perfilCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    res.json({
      total_conversaciones: totalConvCount,
      ventas_exitosas: wins.length,
      leads_frios: losses.length,
      tasa_conversion: `${tasa}%`,
      tiempo_promedio_cierre: avgCierre ? `${avgCierre} mensajes` : null,
      ultimo_playbook: playbookTs || null,
      objecion_mas_comun: objecionMasComun,
      perfil_que_mas_convierte: perfilQueMasConvierte,
      redis_disponible: redisConnected,
    });
  } catch (e) {
    console.error("Error en /metrics:", e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// ENDPOINT: Admin — limpiar contacto
// ============================================
app.delete("/admin/contact/:contactId", async (req, res) => {
  const { contactId } = req.params;
  delete conversations[contactId];
  contactState.delete(contactId);
  await redis?.del(`conv:${contactId}`, `state:${contactId}`).catch(() => {});
  console.log(`Admin: borrado contacto ${contactId}`);
  res.json({ ok: true, contactId });
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "GHL-Claude Sales Middleware v4",
    timestamp: new Date().toISOString(),
    activeContacts: contactState.size,
    bufferedMessages: messageBuffer.size,
    playbookActivo: currentPlaybook !== null,
    redisConectado: redisConnected,
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;

async function start() {
  // Conectar Redis y cargar datos persistidos
  if (redis) {
    try {
      // Cargar playbook al arrancar
      const playbookData = await rGet("playbook:current");
      if (playbookData) {
        currentPlaybook = JSON.parse(playbookData);
        playbookUpdatedAt = await rGet("playbook:updated_at");
        console.log("Playbook cargado desde Redis");
      }

      // Las conversaciones y estados se cargan bajo demanda cuando llega el primer mensaje
      console.log("Redis listo. Conversaciones y estados se cargan bajo demanda.");
    } catch (e) {
      console.error("Error conectando Redis al inicio:", e.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`Middleware corriendo en puerto ${PORT}`);
  });
}

start();
