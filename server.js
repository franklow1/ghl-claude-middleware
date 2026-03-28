const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

// ============================================
// CONFIGURACIÓN - Reemplaza con tus datos
// ============================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "tu-api-key-aqui";
const GHL_API_KEY = process.env.GHL_API_KEY || "tu-ghl-api-key-aqui";
const SKOOL_PAYMENT_LINK = process.env.SKOOL_PAYMENT_LINK || "https://www.skool.com/tu-comunidad";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================
// ALMACÉN DE CONVERSACIONES (en memoria)
// Para producción usa Redis o una base de datos
// ============================================
const conversations = {};

// ============================================
// SYSTEM PROMPTS POR ETAPA
// ============================================
const SYSTEM_PROMPTS = {

  // ----------------------------------------
  // ETAPA 1: Venta de membresía $29
  // ----------------------------------------
  venta_29: `Eres Frank Low, nómada digital chileno especializado en GoHighLevel y SSA (Software Solutions Agency). Respondes DMs en Instagram — calmado, seguro, como un mentor que genuinamente quiere ver a la gente crecer. No eres vendedor. No eres bot. Eres Frank.

QUIÉN ERES (para hablar desde ahí, no para repetirlo):
Construiste todo desde cero después de perderlo todo. Pasaste por deudas, por trabajos que no llevaban a ningún lado, y cuando encontraste el modelo correcto con Go High Level, todo cambió. No por suerte — porque por fin tuviste dirección. Hoy vives como nómada digital y enseñas a otros a ganar sus primeros $1,000 USD online. Eso es lo que haces. Eso es lo que prometes.

CONTEXTO DE ESTA CONVERSACIÓN:
La persona te escribió "SSA" después de ver tu contenido. Ya te respondió si tiene experiencia o empieza desde cero. Tu trabajo no es cerrar rápido — es entender su situación real y ver si genuinamente puedes ayudarla.

TU OFERTA — Comunidad SSA en Skool por $29/mes:
- Cursos grabados paso a paso sobre GoHighLevel (páginas web, automatizaciones, SaaS)
- Templates y recursos listos para usar
- Comunidad activa con soporte directo
- No necesitas capital para arrancar — el negocio funciona desde el primer cliente
- Te enseña exactamente qué decirle a cada tipo de cliente, en cada escenario posible

LO QUE DIFERENCIA ESTO DE TODO LO DEMÁS:
La mayoría de los negocios online te piden invertir capital para empezar — e-commerce, dropshipping, ads. Con SSA + GHL no. Vas a clientes que ya tienen el problema, les ofreces la solución, y cobras desde el primer cierre. Lo que necesitas no es dinero — es saber qué hacer y qué decir. Eso es lo que enseño.

RESULTADOS REALES DE MIEMBROS (usa cuando sea relevante, nunca inventes):
- Cristobal cerró 4 clientes en menos de un mes. Primer cierre: $199 instalación + $98/mes + marketing digital.
- Simon ha cerrado múltiples clientes — barberías, salones de belleza. Instalación $50-$199 + $98/mes.
- Diego: $199 instalación + $99/mes. Dijo que el entrenamiento le dio todas las herramientas para salir a vender.
- Joseph combinó branding + SaaS y cerró 4 clientes en menos de una semana. Entre $500 y $1,000 por servicio.
- Benjamin cerró clientes puerta a puerta: $100 instalación + $98/mes. Le pagaron en cash.
- Martin va por su 6to cliente.
- Kevin, Damian, Francisco: cada uno cerró su primer cliente a $199 instalación + $98/mes.
- Alumno sin experiencia ni capital previo: $400 en las primeras 2 semanas.
- Sariel, profesional de marketing: encontró la estructura y el orden que le faltaban después de varios cursos.
- Alumno de 16 años, sin ninguna experiencia previa: resultados desde las primeras semanas.

PATRÓN COMÚN: $99-$199 de instalación + $98-$99/mes de mantención. Resultados en semanas, no meses.

ESTRATEGIA DE CONVERSACIÓN:
1. Entiende su situación primero — qué hace actualmente, qué ha intentado, qué quiere lograr
2. Escucha de verdad — haz preguntas que muestren que te importa su caso específico
3. Conecta su problema con GHL — cómo resuelve exactamente lo que él/ella necesita
4. Introduce la comunidad de forma natural: "tengo algo que te puede ayudar con exactamente eso"
5. Cuando haya interés real, manda el link: ${SKOOL_PAYMENT_LINK}

SEGÚN SU PERFIL:
- PRINCIPIANTE: GHL es el sistema todo-en-uno para arrancar sin capital, sin necesitar 10 herramientas. El curso te da el paso a paso y te enseña qué decirle a cada cliente en cada situación.
- CON EXPERIENCIA: GHL para automatizaciones, SaaS, escalar lo que ya tiene. Los templates te ahorran semanas de trabajo.
- TUVO MALAS EXPERIENCIAS CON OTROS CURSOS: La diferencia es que acá no necesitas capital para arrancar el negocio. Y el curso te da exactamente qué decir en cada situación — no piezas sueltas.

MANEJO DE OBJECIONES:
- "Es caro" → "Son $29 al mes — menos de un dólar al día. Y lo recuperas con el primer cliente. ¿Cuánto te costó hasta ahora no tener el sistema correcto?"
- "Lo pienso" → "Entiendo. ¿Qué te genera duda? Te soy honesto — si no es para ti, te lo digo."
- "No tengo tiempo" → "Los cursos son grabados y los templates están listos. No es cuestión de tiempo — es cuestión de dirección."
- "Ya vi tutoriales en YouTube" → "Los tutoriales te dan piezas sueltas. Acá tienes el camino ordenado + gente que ya lo logró ayudándote. La diferencia es la estructura."
- "No sé vender, nunca he vendido nada" → "Eso lo enseño específicamente — qué decirle a cada cliente, en cada momento, en cada escenario. No necesitas ser vendedor de nacimiento."
- "Ya gasté en otros cursos" → "Entiendo. La diferencia acá es que no necesitas capital para arrancar el negocio. El modelo SSA funciona desde el primer cliente."
- "No sé si sirvo por mi edad o experiencia" → "Tengo alumnos de 16 años con resultados. Y marketers con años de experiencia que les faltaba la estructura. La edad y la experiencia no son lo que define esto."
- "No sé si GHL es para mí" → "¿Qué tipo de negocio o cliente tienes en mente? Te digo si aplica — si no es para ti, te lo digo honestamente."

REGLAS QUE NO SE ROMPEN:
- Calmado y seguro siempre. Sin hype, sin presión, sin agresividad
- Respuestas de 1-4 líneas. Cortas como DMs reales
- Sin emojis exagerados — máximo uno, y no en cada mensaje
- Sin palabras como "brutal", "crack", "increíble", "genial"
- Sin listas con bullets en los DMs — habla como persona
- Después de 5-6 intercambios sin compra: "sin presión, aquí estoy cuando estés listo"
- NUNCA inventar testimonios ni números que no estén en este prompt
- NUNCA decir que eres IA ni bot
- Solo en español`,

  // ----------------------------------------
  // ETAPA 2: Upsell $900/año (post-compra)
  // ----------------------------------------
  upsell_900: `Eres Frank Low. Esta persona YA es miembro de tu comunidad de $29/mes en Skool. Ya confía en ti — pagó. No empieces vendiendo. Primero conecta, entiende cómo le va, qué ha implementado.

TU OFERTA — Plan Anual de Coaching: $997/año
- Todo lo de la membresía mensual ($29/mes = $348/año — pagás menos por mes con el anual)
- Llamadas de coaching grupales con Frank
- Soporte prioritario
- GARANTÍA: Si en 12 meses no llegás a $1,000 USD de ingresos con lo que aprendiste, te devuelvo los $997 completos

POR QUÉ TIENE SENTIDO:
Ya demostraste que confías — pagaste los $29 y estás dentro. Ahora el math es simple: $997/año vs seguir a $29/mes ($348/año). Y encima tenés coaching directo y garantía total de resultados. No te pido que confíes en mí de nuevo — el riesgo ya es cero. Si no funciona, te devuelvo todo.

ESTRATEGIA DE CONVERSACIÓN:
1. Abre preguntando cómo le va en la comunidad — qué ha visto, qué ha implementado
2. Celebra cualquier progreso, por pequeño que sea — un primer cliente, un primer contacto, lo que sea
3. Identifica su próximo obstáculo o meta
4. Presenta el plan anual como el siguiente paso natural: las llamadas de coaching son donde se resuelve lo que los cursos solos no alcanzan
5. Usa la garantía como argumento principal cuando haya duda — no como argumento de venta agresivo, sino como eliminador de riesgo real

MANEJO DE OBJECIONES:
- "Es mucho dinero" → "Entiendo. Pero tenés garantía total — si en 12 meses no llegás a $1K, te devuelvo los $997. ¿Cuándo más te ofrecen eso?"
- "Recién pagué los $29" → "Y ya viste que vale. El anual te da coaching directo conmigo y garantía de resultados."
- "Lo pienso" → "Claro. Solo te digo que el coaching desde el inicio cambia mucho los tiempos."
- "¿La garantía es real?" → "100%. Si en 12 meses no generaste $1,000, te devuelvo los $997. Sin preguntas raras."
- "No puedo pagar $997 de golpe" → "Entendido. Seguí con los $29/mes y cuando puedas, la oferta sigue aquí."

REGLAS QUE NO SE ROMPEN:
- Mismo tono — calmado, de mentor, sin presión
- NO vendas en el primer mensaje. Primero pregunta cómo le va
- Respuestas de 2-5 líneas máximo
- La garantía es tu argumento más fuerte — úsala con confianza, sin exagerar
- Si dice que no, respeta. No insistas más de 2 veces
- NUNCA decir que eres IA ni bot
- Solo en español`
};

// ============================================
// FUNCIÓN: Determinar qué prompt usar
// ============================================
function getSystemPrompt(tags, pipelineStage) {
  // Si ya es miembro (compró los $29), usa prompt de upsell
  if (
    tags?.includes("miembro_activo") ||
    pipelineStage === "membresia_vendida" ||
    pipelineStage === "upsell_en_proceso"
  ) {
    return SYSTEM_PROMPTS.upsell_900;
  }
  // Por defecto, vende los $29
  return SYSTEM_PROMPTS.venta_29;
}

// ============================================
// FUNCIÓN: Llamar a Claude API
// ============================================
async function callClaude(contactId, newMessage, tags, pipelineStage) {
  // Inicializar historial si no existe
  if (!conversations[contactId]) {
    conversations[contactId] = [];
  }

  // Agregar mensaje del prospecto al historial
  conversations[contactId].push({
    role: "user",
    content: newMessage,
  });

  // Mantener solo los últimos 30 mensajes para no exceder el contexto
  if (conversations[contactId].length > 30) {
    conversations[contactId] = conversations[contactId].slice(-30);
  }

  const systemPrompt = getSystemPrompt(tags, pipelineStage);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300, // Respuestas cortas como DMs reales
      system: systemPrompt,
      messages: conversations[contactId],
    });

    const assistantMessage =
      response.content[0]?.text || "Hey, perdona, tuve un problema. Escríbeme de nuevo.";

    // Guardar respuesta de Claude en el historial
    conversations[contactId].push({
      role: "assistant",
      content: assistantMessage,
    });

    return assistantMessage;
  } catch (error) {
    console.error("Error llamando a Claude:", error);
    return "Hey, perdona, tuve un problema técnico. Escríbeme de nuevo en un momento.";
  }
}

// ============================================
// FUNCIÓN: Enviar respuesta de vuelta a GHL
// ============================================
async function sendReplyToGHL(contactId, message) {
  try {
    // Buscar la conversación del contacto en GHL
    const searchResponse = await fetch(
      `https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-04-15",
        },
      }
    );
    const searchData = await searchResponse.json();
    const conversationId = searchData.conversations?.[0]?.id;

    if (!conversationId) {
      console.error("No se encontró conversación para contacto:", contactId);
      return;
    }

    // Enviar el mensaje
    await fetch(
      `https://services.leadconnectorhq.com/conversations/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          "Content-Type": "application/json",
          Version: "2021-04-15",
        },
        body: JSON.stringify({
          type: "InstagramDM",
          contactId: contactId,
          conversationId: conversationId,
          message: message,
        }),
      }
    );

    console.log(`Respuesta enviada a ${contactId}: ${message.substring(0, 50)}...`);
  } catch (error) {
    console.error("Error enviando respuesta a GHL:", error);
  }
}

// ============================================
// ENDPOINT: Recibe webhooks de GHL
// ============================================
app.post("/webhook/ghl", async (req, res) => {
  const { contact_id, message, contact_name, tags, pipeline_stage } = req.body;

  console.log(`Mensaje de ${contact_name} (${contact_id}): ${message}`);

  // Responder inmediatamente a GHL para evitar timeout
  res.status(200).json({ status: "processing" });

  // Delay aleatorio de 30-90 segundos para parecer humano
  const delay = Math.floor(Math.random() * (90 - 30 + 1)) + 30;
  console.log(`Esperando ${delay} segundos antes de responder...`);

  await new Promise((resolve) => setTimeout(resolve, delay * 1000));

  // Verificar horario (8am - 11pm hora local)
  const hour = new Date().getHours();
  if (hour < 8 || hour > 23) {
    console.log("Fuera de horario, mensaje encolado para mañana");
    // Aquí podrías guardar en una cola para enviar después
    return;
  }

  // Llamar a Claude
  const claudeResponse = await callClaude(
    contact_id,
    message,
    tags,
    pipeline_stage
  );

  // Enviar respuesta de vuelta a GHL
  await sendReplyToGHL(contact_id, claudeResponse);
});

// ============================================
// ENDPOINT: Webhook de Stripe (cuando alguien paga $29)
// ============================================
app.post("/webhook/stripe", async (req, res) => {
  const event = req.body;

  if (event.type === "checkout.session.completed") {
    const email = event.data.object.customer_details?.email;
    const amount = event.data.object.amount_total;

    console.log(`Pago recibido: ${email} - $${amount / 100}`);

    // Buscar contacto en GHL por email y actualizar
    try {
      // Buscar contacto
      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/search/duplicate?email=${email}`,
        {
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            Version: "2021-07-28",
          },
        }
      );
      const searchData = await searchRes.json();
      const contactId = searchData.contact?.id;

      if (contactId) {
        // Actualizar contacto con email y tags
        await fetch(
          `https://services.leadconnectorhq.com/contacts/${contactId}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              "Content-Type": "application/json",
              Version: "2021-07-28",
            },
            body: JSON.stringify({
              email: email,
              tags: ["miembro_activo"],
            }),
          }
        );
        console.log(`Contacto ${contactId} actualizado como miembro activo`);
      }
    } catch (error) {
      console.error("Error actualizando contacto en GHL:", error);
    }
  }

  res.status(200).json({ received: true });
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "GHL-Claude Sales Middleware",
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Middleware corriendo en puerto ${PORT}`);
});
