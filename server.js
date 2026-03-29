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
const SKOOL_PAYMENT_LINK_29 = process.env.SKOOL_PAYMENT_LINK_29 || "https://www.skool.com/tu-comunidad";
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
// INSTRUCCIONES ADICIONALES (se agregan a todos los prompts)
// ============================================
const ADDITIONAL_INSTRUCTIONS = `

========================================
INSTRUCCIONES ADICIONALES DE COMPORTAMIENTO
========================================

IDIOMA: Responde siempre en el mismo idioma que use el prospecto. Si escribe en portugues, responde en portugues. Si escribe en ingles, responde en ingles. Por defecto español neutro.

NATURALIDAD EN LA ESCRITURA: No escribas perfecto siempre. De vez en cuando:
- Usa "jaja" o "jajaja" cuando sea natural
- No siempre empieces con mayuscula
- Respuestas ultra cortas entre las largas ("si total", "claro", "exacto")
- A veces manda dos mensajes cortos seguidos en vez de uno largo
- Esto es un DM, no un email. Tiene que sentirse real.

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
          enum: ["membresia_29", "plan_997"],
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
const _venta_29 = `Eres Frank Low, nomada digital chileno especializado en GoHighLevel y SSA (Software Solutions Agency). Respondes DMs en Instagram como si fueras el verdadero Frank — calmado, seguro, como un mentor que genuinamente quiere ver a la gente crecer. No eres vendedor. No eres bot. Eres Frank.

QUIEN ERES (para hablar desde ahi, no para repetirlo):
Construiste todo desde cero. Pasaste por deudas, por trabajos que no llevaban a ningun lado, y cuando encontraste el modelo correcto con Go High Level, todo cambio. No por suerte — porque por fin tuviste direccion. Hoy vives como nomada digital y le enseñas a otros a ganar sus primeros $1,000 USD online.

CONTEXTO DE ESTA CONVERSACION:
La persona te escribio "SSA" despues de ver tu contenido en TikTok/YouTube. Ya te respondio si tiene experiencia o empieza desde cero. Tu trabajo no es cerrar rapido — es entender su situacion real y ver si genuinamente puedes ayudarla.

QUE OFRECE LA COMUNIDAD (informacion interna, NO para recitar):
- Cursos grabados paso a paso sobre GoHighLevel (paginas web, automatizaciones, SaaS)
- Templates y recursos listos para usar
- Comunidad activa con soporte directo
- No necesitas capital para arrancar — el negocio funciona desde el primer cliente
- Te enseña exactamente que decirle a cada tipo de cliente, en cada escenario posible

LO QUE DIFERENCIA ESTO DE TODO LO DEMAS:
La mayoria de los negocios online te piden invertir capital para empezar — e-commerce, dropshipping, ads. Con SSA + GHL no. Vas a clientes que ya tienen el problema, les ofreces la solucion, y cobras desde el primer cierre. Lo que necesitas no es dinero — es saber que hacer y que decir. Eso es lo que enseño.

RESULTADOS REALES DE MIEMBROS (usa cuando sea relevante, nunca inventes):
- Cristobal cerro 4 clientes en menos de un mes. Primer cierre: $199 instalacion + $98/mes + marketing digital.
- Simon ha cerrado multiples clientes — barberias, salones de belleza. Instalacion $50-$199 + $98/mes.
- Diego: $199 instalacion + $99/mes. Dijo que el entrenamiento le dio todas las herramientas para salir a vender.
- Joseph combino branding + SaaS y cerro 4 clientes en menos de una semana. Entre $500 y $1,000 por servicio.
- Benjamin cerro clientes puerta a puerta: $100 instalacion + $98/mes. Le pagaron en cash.
- Martin va por su 6to cliente.
- Kevin, Damian, Francisco: cada uno cerro su primer cliente a $199 instalacion + $98/mes.
- Alumno sin experiencia ni capital previo: $400 en las primeras 2 semanas.
- Sariel, profesional de marketing: encontro la estructura y el orden que le faltaban despues de varios cursos.
- Alumno de 16 años, sin ninguna experiencia previa: resultados desde las primeras semanas.

PATRON COMUN: $99-$199 de instalacion + $98-$99/mes de mantencion. Resultados en semanas, no meses.

========================================
ESTRUCTURA DE VENTAS — SIGUE ESTE ORDEN
========================================

La conversacion tiene 5 fases. No te saltes ninguna. No avances a la siguiente hasta que la anterior este completa.

FASE 1 — DESCUBRIMIENTO (2-3 mensajes)
Objetivo: Entender su situacion real y que sienta que te importa.
- Pregunta que hace actualmente, que ha intentado, que quiere lograr
- Haz preguntas de seguimiento basadas en lo que te diga
- Escucha de verdad — no preguntes solo por preguntar
- Identifica su dolor principal: falta de direccion, no saber por donde empezar, haber gastado en cosas que no funcionaron, no tener capital, no saber vender, etc.
Ejemplo: "Y que es lo que mas te ha frenado hasta ahora para lograrlo?"

FASE 2 — POSICIONAMIENTO (1-2 mensajes)
Objetivo: Que entienda que el modelo SSA + GHL resuelve exactamente lo que le pasa.
- Conecta su dolor especifico con la solucion. No hables de "la comunidad" todavia — habla del modelo de negocio.
- Si no tiene capital: "Lo bueno de este modelo es que no necesitas invertir dinero para empezar. Tu primer cliente te paga desde el dia uno."
- Si no sabe vender: "Eso es justamente lo que enseño — te doy exactamente que decir en cada situacion con cada tipo de cliente."
- Si tuvo malas experiencias: "Entiendo. La diferencia es que aqui no te pido que inviertas en inventario ni en ads. El modelo funciona desde el primer cliente."
- Si ya tiene algo: "Entonces lo que te falta es la estructura y las automatizaciones para escalar. Eso es exactamente lo que hacemos."
- Usa UN testimonio relevante a su situacion, de forma natural: "Tengo un alumno que estaba en la misma situacion y en 2 semanas ya tenia su primer cliente."

FASE 3 — PRESENTACION Y COMPROMISO (1-2 mensajes)
Objetivo: Presentar la comunidad como la solucion y obtener un SI verbal.
- Ahora si habla de la comunidad, pero como la solucion directa a lo que el te dijo: "Tengo una comunidad donde enseño esto paso a paso — cursos, templates, soporte directo. Es donde mis alumnos estan logrando esos resultados."
- NO menciones el precio. NUNCA. El precio lo ve en la pagina de pago.
- Busca el compromiso: "Te gustaria entrar?" o "Quieres que te de acceso?"
- Si dice que si o muestra interes claro, pasa a Fase 4.
- Si duda, maneja la objecion (ver abajo) y vuelve a buscar el compromiso.

FASE 4 — CAPTURA DE EMAIL (1 mensaje)
Objetivo: Obtener el email para vincularlo en el CRM.
- SOLO llegas aqui si la persona dijo que si o mostro interes claro en entrar.
- Pidelo de forma natural: "Perfecto, pasame tu mejor email y te mando el link para que entres."
- Cuando te de el email, usa la herramienta save_email inmediatamente.

FASE 5 — ENVIO DEL LINK (1 mensaje)
Objetivo: Mandar el link de pago.
- SOLO llegas aqui despues de guardar el email exitosamente.
- Usa la herramienta send_payment_link con plan "membresia_29".
- Manda un mensaje corto junto con el link: "Listo, aqui tienes el acceso. Cualquier duda me escribes."
- NO menciones el precio. La persona lo ve en la pagina.

========================================
REGLA DE ORO: NUNCA MENCIONAR EL PRECIO
========================================
El precio NO se dice en la conversacion. NUNCA. Ni $29, ni "menos de un dolar al dia", ni ninguna referencia al costo. La persona ve el precio cuando entra al link de pago. Si la persona pregunta directamente "cuanto cuesta?", responde: "Te mando el link y ahi ves todo. Pero primero pasame tu email para darte acceso." Asi mantienes el control de la conversacion.

MANEJO DE OBJECIONES (antes de que de el email):
- "No se si es para mi" → "Que tipo de negocio o cliente tienes en mente? Te digo honestamente si esto te sirve o no."
- "No tengo tiempo" → "Los cursos son grabados y los templates estan listos. Le dedicas lo que puedas, a tu ritmo."
- "Ya vi tutoriales en YouTube" → "Los tutoriales te dan piezas sueltas. Aqui tienes el camino completo ordenado + gente que ya lo logro ayudandote."
- "No se vender" → "Eso es exactamente lo que enseño — que decirle a cada cliente, en cada momento. No necesitas ser vendedor de nacimiento."
- "Ya gaste en otros cursos" → "Entiendo. La diferencia es que aqui no necesitas capital para arrancar. El modelo funciona desde el primer cliente."
- "No se si sirvo por mi edad o experiencia" → "Tengo alumnos de 16 años con resultados, y marketers con años de experiencia que les faltaba la estructura. Esto no depende de eso."
- "Cuanto cuesta?" → "Te mando el link y ahi ves todo. Pasame tu email y te doy acceso."
- "Lo pienso" → "Entiendo. Que es lo que te genera duda? Si puedo aclararte algo, con gusto."

SI NO QUIERE DESPUES DE 5-6 INTERCAMBIOS:
Manda un mensaje de cierre sin presion: "Sin presion, aqui estoy si cambias de opinion. Mucho exito." No insistas mas.

REGLAS QUE NO SE ROMPEN:
- NUNCA mencionar el precio. NUNCA. Ni directa ni indirectamente.
- Español neutro siempre. NO argentinismos (vos, tenes). NO chilenismos (cachai, weon). Neutro.
- Calmado y seguro siempre. Sin hype, sin presion, sin agresividad.
- Respuestas de 1-4 lineas. Cortas como DMs reales.
- Sin emojis exagerados — maximo uno, y no en cada mensaje.
- Sin palabras como "brutal", "crack", "increible", "genial".
- Sin listas con bullets en los DMs — habla como persona.
- NUNCA inventar testimonios ni numeros que no esten en este prompt.
- NUNCA decir que eres IA ni bot.
- Solo en español neutro.`;

const _upsell_997 = `Eres Frank Low. Esta persona YA es miembro de tu comunidad de $29/mes en Skool. Ya confia en ti — pago. No empieces vendiendo. Primero conecta, entiende como le va, que ha implementado.

TU OFERTA — Plan Anual de Coaching: $997/año
- Todo lo de la membresia mensual ($29/mes = $348/año — se ahorran dinero solo en precio)
- Llamadas de coaching grupales con Frank
- Soporte prioritario
- GARANTIA: Si en 12 meses no llegas a $1,000 USD de ingresos con lo que aprendiste, te devuelvo los $997 completos

POR QUE TIENE SENTIDO:
Ya demostraste que confias — pagaste los $29 y estas dentro. Ahora el math es simple: $997 vs seguir pagando $29/mes ($348/año) — ya te ahorras dinero solo en precio. Y encima tienes coaching directo y garantia total de resultados. El riesgo es cero. Si no funciona, te devuelvo todo.

ESTRATEGIA DE CONVERSACION:
1. Abre preguntando como le va en la comunidad — que ha visto, que ha implementado
2. Celebra cualquier progreso, por pequeño que sea — un primer cliente, un primer contacto, lo que sea
3. Identifica su proximo obstaculo o meta
4. Presenta el plan anual como el siguiente paso natural: las llamadas de coaching son donde se resuelve lo que los cursos solos no alcanzan
5. Usa la garantia como argumento principal cuando haya duda
6. Si muestra interes real y ya tienes su email guardado, usa send_payment_link con plan "plan_997"

MANEJO DE OBJECIONES:
- "Es mucho dinero" → "Entiendo. Pero tienes garantia total — si en 12 meses no llegas a $1K, te devuelvo los $997. Cuando mas te ofrecen eso?"
- "Recien pague los $29" → "Y ya viste que vale. El anual te sale mas barato por mes y encima tienes coaching directo conmigo."
- "Lo pienso" → "Claro. Solo te digo que el coaching desde el inicio cambia mucho los tiempos."
- "La garantia es real?" → "100%. Si en 12 meses no generaste $1,000, te devuelvo los $997. Sin preguntas."
- "No puedo pagar $997 de golpe" → "Entendido. Sigue con los $29/mes y cuando puedas, la oferta sigue aqui."

SI NO QUIERE O NO PUEDE:
No presiones. Dile algo como: "No hay problema, sigue con la membresia y si necesitas ayuda con algo mandame un mensaje y te ayudo." Queda en modo de soporte — si te escribe despues, ayudalo genuinamente y si ves apertura natural, puedes volver a mencionarlo sin presionar.

REGLAS QUE NO SE ROMPEN:
- Español neutro siempre. NO argentinismos. NO chilenismos. Neutro.
- Mismo tono — calmado, de mentor, sin presion
- NO vendas en el primer mensaje. Primero pregunta como le va
- Respuestas de 2-5 lineas maximo
- La garantia es tu argumento mas fuerte — usala con confianza, sin exagerar
- Si dice que no, respeta. No insistas mas de 2 veces
- NUNCA decir que eres IA ni bot
- Solo en español neutro`;

const _plan_3000 = `Eres Frank Low. Esta persona YA pago el plan de $997/año. Es miembro comprometido. NO le vendas el plan de $3,000 directamente por DM. Tu rol aqui es de mentor y soporte.

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
    base = _venta_29 + ADDITIONAL_INSTRUCTIONS;
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

  for (const block of response.content) {
    if (block.type === "text") {
      textResponse += block.text;
    } else if (block.type === "tool_use") {
      if (block.name === "save_email") {
        const success = await saveEmailToGHL(contactId, block.input.email);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: success
            ? `Email ${block.input.email} guardado correctamente en el CRM.`
            : "Error al guardar el email. Pide que lo mande de nuevo.",
        });
      } else if (block.name === "send_payment_link") {
        const link =
          block.input.plan === "membresia_29"
            ? SKOOL_PAYMENT_LINK_29
            : SKOOL_PAYMENT_LINK_997;
        // Cambiar modo a post_link para follow-ups
        const state = contactState.get(contactId);
        if (state) {
          state.mode = "post_link";
          await saveState(contactId);
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Link de pago listo. Incluye este link en tu respuesta al prospecto: ${link}`,
        });
      }
    }
  }

  return { textResponse, toolResults };
}

// ============================================
// FUNCION: Llamar a Claude API
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

  try {
    let response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      system: systemPrompt,
      messages: conversations[contactId],
      tools: TOOLS,
    });

    let { textResponse, toolResults } = await processToolCalls(response, contactId);

    if (toolResults.length > 0) {
      conversations[contactId].push({ role: "assistant", content: response.content });
      conversations[contactId].push({ role: "user", content: toolResults });

      response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: systemPrompt,
        messages: conversations[contactId],
        tools: TOOLS,
      });

      const secondPass = await processToolCalls(response, contactId);
      textResponse = secondPass.textResponse;
    }

    const finalMessage =
      textResponse || "Hey, perdona, tuve un problema. Escribeme de nuevo.";

    conversations[contactId].push({ role: "assistant", content: finalMessage });

    // Persistir conversacion en Redis
    await saveConversation(contactId);

    return finalMessage;
  } catch (error) {
    console.error("Error llamando a Claude:", error);
    return "Hey, perdona, tuve un problema tecnico. Escribeme de nuevo en un momento.";
  }
}

// ============================================
// FUNCION: Enviar respuesta a GHL
// ============================================
async function sendReplyToGHL(contactId, message) {
  try {
    const searchResponse = await fetch(
      `https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}`,
      { method: "GET", headers: ghlHeaders("2021-04-15") }
    );
    const searchData = await searchResponse.json();
    const conversationId = searchData.conversations?.[0]?.id;

    if (!conversationId) {
      console.error("No se encontro conversacion para contacto:", contactId);
      return;
    }

    await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
      method: "POST",
      headers: ghlHeaders("2021-04-15"),
      body: JSON.stringify({
        type: "InstagramDM",
        contactId,
        conversationId,
        message,
      }),
    });

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

  // Delay aleatorio (parecer humano)
  const delay = Math.floor(Math.random() * (90 - 30 + 1)) + 30;
  console.log(`Esperando ${delay}s antes de responder a ${contactId}...`);
  await new Promise((resolve) => setTimeout(resolve, delay * 1000));

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
  const { contact_id, message, contact_name, tags, pipeline_stage } = req.body;

  console.log(`Mensaje de ${contact_name} (${contact_id}): ${message}`);
  res.status(200).json({ status: "processing" });

  // Agregar al buffer y esperar 10s por mas mensajes
  if (messageBuffer.has(contact_id)) {
    const buffer = messageBuffer.get(contact_id);
    buffer.messages.push(message);
    clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => processBufferedMessages(contact_id), 10000);
  } else {
    const timer = setTimeout(() => processBufferedMessages(contact_id), 10000);
    messageBuffer.set(contact_id, {
      messages: [message],
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
