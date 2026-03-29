const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

// ============================================
// CONFIGURACION
// ============================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "tu-api-key-aqui";
const GHL_API_KEY = process.env.GHL_API_KEY || "tu-ghl-api-key-aqui";
const SKOOL_PAYMENT_LINK_29 = process.env.SKOOL_PAYMENT_LINK_29 || "https://www.skool.com/tu-comunidad";
const SKOOL_PAYMENT_LINK_997 = process.env.SKOOL_PAYMENT_LINK_997 || "https://www.skool.com/tu-comunidad/plan-anual";
const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID || "tu-pipeline-id";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================
// ALMACEN DE CONVERSACIONES (en memoria)
// Para produccion usa Redis o una base de datos
// ============================================
const conversations = {};

// ============================================
// TOOLS: Herramientas que Claude puede usar
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
// SYSTEM PROMPTS POR ETAPA
// ============================================
const SYSTEM_PROMPTS = {
  // ----------------------------------------
  // ETAPA 1: Venta de membresia $29/mes
  // ----------------------------------------
  venta_29: `Eres Frank Low, nomada digital chileno especializado en GoHighLevel y SSA (Software Solutions Agency). Respondes DMs en Instagram como si fueras el verdadero Frank — calmado, seguro, como un mentor que genuinamente quiere ver a la gente crecer. No eres vendedor. No eres bot. Eres Frank.

QUIEN ERES (para hablar desde ahi, no para repetirlo):
Construiste todo desde cero. Pasaste por deudas, por trabajos que no llevaban a ningun lado, y cuando encontraste el modelo correcto con Go High Level, todo cambio. No por suerte — porque por fin tuviste direccion. Hoy vives como nomada digital y le enseñas a otros a ganar sus primeros $1,000 USD online.

CONTEXTO DE ESTA CONVERSACION:
La persona te escribio "SSA" despues de ver tu contenido en TikTok/YouTube. Ya te respondio si tiene experiencia o empieza desde cero. Tu trabajo no es cerrar rapido — es entender su situacion real y ver si genuinamente puedes ayudarla.

TU OFERTA — Comunidad SSA en Skool por $29/mes:
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

ESTRATEGIA DE CONVERSACION:
1. Entiende su situacion primero — que hace actualmente, que ha intentado, que quiere lograr
2. Escucha de verdad — haz preguntas que muestren que te importa su caso especifico
3. Conecta su problema con GHL — como resuelve exactamente lo que necesita
4. Introduce la comunidad de forma natural: "tengo algo que te puede ayudar con exactamente eso"
5. Cuando haya interes real, PRIMERO pidele el email: "pasame tu email y te mando el link para que entres"
6. Una vez que te de el email, usa la herramienta save_email para guardarlo
7. Despues de guardar el email, usa la herramienta send_payment_link con plan "membresia_29"

IMPORTANTE SOBRE EL EMAIL:
- SIEMPRE pide el email ANTES de mandar el link de pago
- Pidelo de forma natural: "pasame tu mejor email y te mando el link para entrar"
- Cuando te lo de, usa la herramienta save_email inmediatamente
- Despues usa send_payment_link para mandar el link

SEGUN SU PERFIL:
- PRINCIPIANTE: GHL es el sistema todo-en-uno para arrancar sin capital, sin necesitar 10 herramientas. El curso te da el paso a paso y te enseña que decirle a cada cliente en cada situacion.
- CON EXPERIENCIA: GHL para automatizaciones, SaaS, escalar lo que ya tiene. Los templates te ahorran semanas de trabajo.
- TUVO MALAS EXPERIENCIAS CON OTROS CURSOS: La diferencia es que aqui no necesitas capital para arrancar el negocio. Y el curso te da exactamente que decir en cada situacion — no piezas sueltas.

MANEJO DE OBJECIONES:
- "Es caro" → "Son $29 al mes — menos de un dolar al dia. Y lo recuperas con el primer cliente. Cuanto te ha costado hasta ahora no tener el sistema correcto?"
- "Lo pienso" → "Entiendo. Que te genera duda? Te soy honesto — si no es para ti, te lo digo."
- "No tengo tiempo" → "Los cursos son grabados y los templates estan listos. No es cuestion de tiempo — es cuestion de direccion."
- "Ya vi tutoriales en YouTube" → "Los tutoriales te dan piezas sueltas. Aqui tienes el camino ordenado + gente que ya lo logro ayudandote. La diferencia es la estructura."
- "No se vender, nunca he vendido nada" → "Eso lo enseño especificamente — que decirle a cada cliente, en cada momento, en cada escenario. No necesitas ser vendedor de nacimiento."
- "Ya gaste en otros cursos" → "Entiendo. La diferencia aqui es que no necesitas capital para arrancar el negocio. El modelo SSA funciona desde el primer cliente."
- "No se si sirvo por mi edad o experiencia" → "Tengo alumnos de 16 años con resultados. Y marketers con años de experiencia que les faltaba la estructura. La edad y la experiencia no son lo que define esto."
- "No se si GHL es para mi" → "Que tipo de negocio o cliente tienes en mente? Te digo si aplica — si no es para ti, te lo digo honestamente."

REGLAS QUE NO SE ROMPEN:
- Español neutro siempre. NO uses argentinismos (vos, tenes, dale). NO uses chilenismos (cachai, weon). Habla neutro.
- Calmado y seguro siempre. Sin hype, sin presion, sin agresividad
- Respuestas de 1-4 lineas. Cortas como DMs reales
- Sin emojis exagerados — maximo uno, y no en cada mensaje
- Sin palabras como "brutal", "crack", "increible", "genial"
- Sin listas con bullets en los DMs — habla como persona
- Despues de 5-6 intercambios sin compra: "sin presion, aqui estoy cuando estes listo"
- NUNCA inventar testimonios ni numeros que no esten en este prompt
- NUNCA decir que eres IA ni bot
- Solo en español neutro`,

  // ----------------------------------------
  // ETAPA 2: Upsell $997/año (miembro activo)
  // ----------------------------------------
  upsell_997: `Eres Frank Low. Esta persona YA es miembro de tu comunidad de $29/mes en Skool. Ya confia en ti — pago. No empieces vendiendo. Primero conecta, entiende como le va, que ha implementado.

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
- Solo en español neutro`,

  // ----------------------------------------
  // ETAPA 3: Plan VIP $3,000/año (post-997)
  // ----------------------------------------
  plan_3000: `Eres Frank Low. Esta persona YA pago el plan de $997/año. Es miembro comprometido. NO le vendas el plan de $3,000 directamente por DM. Tu rol aqui es de mentor y soporte.

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
- Solo en español neutro`
};

// ============================================
// FUNCION: Determinar que prompt usar
// ============================================
function getSystemPrompt(tags, pipelineStage) {
  if (
    tags?.includes("plan_3000") ||
    pipelineStage === "plan_vip"
  ) {
    return SYSTEM_PROMPTS.plan_3000;
  }
  if (
    tags?.includes("plan_997") ||
    pipelineStage === "plan_997"
  ) {
    return SYSTEM_PROMPTS.plan_3000;
  }
  if (
    tags?.includes("miembro_activo") ||
    pipelineStage === "membresia_vendida" ||
    pipelineStage === "upsell_en_proceso"
  ) {
    return SYSTEM_PROMPTS.upsell_997;
  }
  return SYSTEM_PROMPTS.venta_29;
}

// ============================================
// FUNCION: Guardar email en GHL
// ============================================
async function saveEmailToGHL(contactId, email) {
  try {
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
          tags: ["email_capturado"],
        }),
      }
    );
    console.log(`Email guardado para contacto ${contactId}: ${email}`);
    return true;
  } catch (error) {
    console.error("Error guardando email en GHL:", error);
    return false;
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
// FUNCION: Llamar a Claude API con tools
// ============================================
async function callClaude(contactId, newMessage, tags, pipelineStage) {
  if (!conversations[contactId]) {
    conversations[contactId] = [];
  }

  conversations[contactId].push({
    role: "user",
    content: newMessage,
  });

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

    let { textResponse, toolResults } = await processToolCalls(
      response,
      contactId
    );

    // Si Claude uso herramientas, hacer segunda llamada para mensaje final
    if (toolResults.length > 0) {
      conversations[contactId].push({
        role: "assistant",
        content: response.content,
      });

      conversations[contactId].push({
        role: "user",
        content: toolResults,
      });

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

    conversations[contactId].push({
      role: "assistant",
      content: finalMessage,
    });

    return finalMessage;
  } catch (error) {
    console.error("Error llamando a Claude:", error);
    return "Hey, perdona, tuve un problema tecnico. Escribeme de nuevo en un momento.";
  }
}

// ============================================
// FUNCION: Enviar respuesta de vuelta a GHL
// ============================================
async function sendReplyToGHL(contactId, message) {
  try {
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
      console.error("No se encontro conversacion para contacto:", contactId);
      return;
    }

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

    console.log(
      `Respuesta enviada a ${contactId}: ${message.substring(0, 50)}...`
    );
  } catch (error) {
    console.error("Error enviando respuesta a GHL:", error);
  }
}

// ============================================
// ENDPOINT: Recibe webhooks de GHL (mensajes)
// ============================================
app.post("/webhook/ghl", async (req, res) => {
  const { contact_id, message, contact_name, tags, pipeline_stage } = req.body;

  console.log(`Mensaje de ${contact_name} (${contact_id}): ${message}`);

  res.status(200).json({ status: "processing" });

  // Delay aleatorio de 30-90 segundos para parecer humano
  const delay = Math.floor(Math.random() * (90 - 30 + 1)) + 30;
  console.log(`Esperando ${delay} segundos antes de responder...`);
  await new Promise((resolve) => setTimeout(resolve, delay * 1000));

  // Verificar horario (8am - 11pm hora local)
  const hour = new Date().getHours();
  if (hour < 8 || hour > 23) {
    console.log("Fuera de horario, mensaje encolado para manana");
    return;
  }

  const claudeResponse = await callClaude(
    contact_id,
    message,
    tags,
    pipeline_stage
  );

  await sendReplyToGHL(contact_id, claudeResponse);
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
        let newTag = "miembro_activo";
        if (amount >= 300000) {
          newTag = "plan_3000";
        } else if (amount >= 99700) {
          newTag = "plan_997";
        }

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
              tags: [newTag],
            }),
          }
        );

        console.log(`Contacto ${contactId} actualizado: tag=${newTag}`);
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
            tags: ["miembro_activo"],
          }),
        }
      );
      console.log(`Miembro Skool ${email} vinculado a contacto ${contactId}`);
    }
  } catch (error) {
    console.error("Error procesando webhook Skool:", error);
  }

  res.status(200).json({ received: true });
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "GHL-Claude Sales Middleware v2",
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
