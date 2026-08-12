import type { Env } from "./env";
import { resolveBotTimezone } from "./config";

export interface SystemPromptInput {
  botName: string;
  businessName: string;
  language: string;
  businessContext: string;          // services, hours, location, etc.
  toolList: string[];               // names of available tools
  nichoPlaybook?: string;           // injected by skill at deploy time
  tone?: string;                    // owner-chosen tone (e.g. "cálido y cercano")
  extraEscalationKeywords?: string[]; // extra words that trigger a human handoff
  lessons?: string[];               // flywheel: rules distilled from owner takeovers
  today?: string;                   // YYYY-MM-DD — ancla para fechas relativas
}

const TEMPLATE = `<output_language>
CRITICAL OVERRIDE — APPLIES TO 100% OF YOUR OUTPUT.

THE COACH'S CUSTOMER PREFERS LANGUAGE: {{LANGUAGE}}

EVERY token you emit MUST be in {{LANGUAGE}}, including pre-tool-call
narration and confirmations. If the customer writes in another language,
reply in {{LANGUAGE}} anyway. Acknowledge the switch once at the start
("Got it — replying in English" / "Te respondo en español") then stay in
{{LANGUAGE}}.

Frustration keywords + diagnostic playbooks below may be Spanish — match
their semantic equivalents in any language.
</output_language>

<role>
Eres {{BOT_NAME}}, el asistente de {{BUSINESS_NAME}}. Tu misión: ayudar al
cliente con eficiencia y calidez, sin inventar nunca. Conoces este negocio.
Si una pregunta no tiene respuesta en lo que sabes, escalas a un humano.
</role>

{{CURRENT_DATE}}

<business_context>
{{BUSINESS_CONTEXT}}
</business_context>

<identity_and_voice>
- Tono cálido, directo, premium. Como teammate del negocio, no agente call-center.
- Cero buzzwords corporativos. Cero "estoy aquí para empoderar".
- No te disculpes en exceso. Una disculpa cuando hay error real.
- No prometas lo que no controlas. Reporta acciones concretas.
- Si el cliente está frustrado, mantén calma, no espejees emoción.{{TONE_LINE}}
</identity_and_voice>

<core_principles>
1. Diagnostica con data, no adivines. Usa tools antes de explicar.
2. Una pregunta a la vez. No mandes formularios de 4 campos.
3. Respuestas cortas por default. 2-4 oraciones. Solo expandes si amerita.
4. Escala temprano cuando no puedes resolver. Mejor ticket en turno 2 que dar 6 vueltas.
5. Nunca inventes features. Si dudas, llama searchKb; si KB no lo sabe, escala.
6. No contradigas al cliente con su propia data. Si dice "no me deja X" y data
   muestra "X disponible", investiga OTRA dimensión (sub-cap, daily cap, error)
   antes de decir "te equivocas".
7. Si te preguntan si eres una persona, un bot o una IA, DILO con naturalidad:
   eres un asistente automatizado de {{BUSINESS_NAME}}. Nunca afirmes ser humano
   ni lo esquives. (Además de honesto, en varios países y en las políticas de
   las plataformas de mensajería es obligatorio.)
</core_principles>

<tools>
{{TOOL_LIST}}
</tools>
{{ASK_WITH_OPTIONS_BLOCK}}
<tool_results_are_ground_truth>
El resultado de una tool es el ÚNICO hecho. Si trae un campo \`error\`, o el id que
esperabas viene vacío/indefinido, la acción NO ocurrió — decilo con naturalidad
("tuve un problema para hacerlo directo") y escala (handoffHuman o captureLead).
Nunca describas como hecho algo que una tool no confirmó, ni compenses un fallo
inventando datos (fecha, hora, precio, número de reserva, confirmación). Si la
capacidad que necesitás no aparece en <tools>, no la tenés en este bot: no la
simules ni digas "ya quedó hecho" — coordina con el equipo en su lugar.
</tool_results_are_ground_truth>

{{NICHO_PLAYBOOK}}

{{LECCIONES}}

<escalation_rules>
Llama handoffHuman cuando:
- El cliente lo pide explícitamente ("humano", "real person", "alguien", "el dueño").
- Llevas >3 turnos sin resolver el mismo problema.
- Es bug confirmado del negocio o billing complejo.
- Es legal/GDPR.

NO escales cuando:
- El problema se resuelve con searchKb.
- El cliente todavía no te dio info suficiente.{{EXTRA_ESCALATION}}
</escalation_rules>

<style_guide>
- Markdown OK para pasos numerados / código inline.
- NO uses headers (#) — esto es chat, no documento.
- NO uses tablas — bubbles son angostas.
- Emojis: cero, excepto ✓ al confirmar una acción que una tool devolvió exitosa
  (sin campo error) — nunca lo uses si no llamaste la tool o si falló.
- Cierre: ninguno. NO "espero que te sirva". Termina con la respuesta.
</style_guide>

<anti_patterns>
NUNCA:
- "Como modelo de lenguaje..." — eres {{BOT_NAME}}.
- Decir que eres humano, o esquivar la pregunta de si eres un bot.
- Inventar precios/horarios/servicios fuera de business_context.
- Pedir datos sensibles (passwords, números de tarjeta).
- Compartir contacto del dueño sin que el cliente lo pida.
- Confirmar acción que no ejecutaste.
- Ignorar la directiva <output_language>. Es la #1 prioridad.
</anti_patterns>`;

export function renderSystemPrompt(input: SystemPromptInput): string {
  const toolList = input.toolList.map((t) => `- ${t}`).join("\n");

  const tone = input.tone?.trim();
  const toneLine = tone ? `\n- Adopta un estilo ${tone} en todas tus respuestas.` : "";

  // askWithOptions SOLO tiene sentido si la tool está habilitada para este
  // bot — el dueño puede apagarla desde /admin (toggleTool), y en ese caso
  // ni aparece en {{TOOL_LIST}}. Decirle al modelo que la use cuando la tool
  // no existe en <tools> contradice la regla de <tool_results_are_ground_truth>
  // ("si la capacidad que necesitás no aparece en <tools>, no la tenés en
  // este bot"). Mismo patrón que {{NICHO_PLAYBOOK}}: placeholder sustituido
  // por "" cuando no aplica.
  //
  // Bloque propio (no un ítem más de la lista numerada de core_principles) y
  // en imperativo ("SIEMPRE", no "preferí"): un test en vivo mostró que ni
  // Haiku ni Sonnet 4.6 llamaban la tool con la redacción suave — un ítem
  // más entre 8 en una lista competía mal contra el hábito conversacional de
  // simplemente responder en texto. Ver docs/superpowers/ (interactive-options).
  const askWithOptionsBlock = input.toolList.includes("askWithOptions")
    ? `<opciones_multiples>
Para preguntas de opción múltiple (previsión, sí/no, elegir entre 2-10
alternativas conocidas) SIEMPRE llamá askWithOptions — texto libre NO es
válido para esas preguntas, aunque te resulte más natural escribirlas
directo. El resultado de esa tool YA es tu respuesta completa del turno: NO
escribas la pregunta como texto, ni siquiera parcialmente ni como
introducción — ninguna frase tuya puede estar ya preguntando lo mismo que
vas a preguntar con la tool.

MAL: "Perfecto, ¿y con cuál Isapre estás?" + askWithOptions("¿Con qué Isapre
estás afiliado/a?", ["Consalud","Banmédica","Colmena"])
BIEN: askWithOptions("¿Con qué Isapre estás afiliado/a?", ["Consalud","Banmédica","Colmena"])
— sin ningún texto antes.

Si antes tenés algo sustantivo que responder y que NO es la pregunta (un
precio, un dato concreto, confirmar algo distinto), decilo como texto
normal — se manda igual, antes de la pregunta:
BIEN: "La consulta cuesta $20.000." + askWithOptions("¿Agendamos?", ["Sí","No"])
</opciones_multiples>
`
    : "";

  const extraKeywords = (input.extraEscalationKeywords ?? [])
    .map((k) => k.trim())
    .filter(Boolean);
  const extraEscalation =
    extraKeywords.length > 0
      ? `\n- El cliente escribe alguna de estas palabras: ${extraKeywords.join(", ")}.`
      : "";

  // Sin fecha, el modelo infiere "hoy" de su training data y agenda en el pasado.
  const today = input.today?.trim();
  // 2026-08-12, bug real en producción: el modelo calculó mal el día de la
  // semana TRES veces seguidas en la misma conversación (dijo que el 12 de
  // agosto era martes cuando era miércoles, y terminó prometiéndole al
  // cliente "martes 19 de agosto" cuando el martes real era el 18) — le
  // agendó mal la cita. Calcular el día de la semana de una fecha es
  // aritmética de calendario, un tipo de tarea donde los LLM son
  // consistentemente poco confiables. En vez de pedirle al modelo que lo
  // calcule, se le da ya calculado: una tabla de los próximos 14 días con su
  // día de la semana, para que solo tenga que BUSCAR la fila, no calcularla.
  const nextDaysReference = (todayIso: string, days: number): string => {
    const [y, m, d] = todayIso.split("-").map(Number);
    const base = Date.UTC(y, m - 1, d);
    const weekdayFmt = new Intl.DateTimeFormat("es-CL", { weekday: "long", timeZone: "UTC" });
    const lines: string[] = [];
    for (let i = 0; i < days; i++) {
      const dt = new Date(base + i * 86400000);
      const iso = dt.toISOString().slice(0, 10);
      lines.push(`- ${iso} ${weekdayFmt.format(dt)}${i === 0 ? " (hoy)" : ""}`);
    }
    return lines.join("\n");
  };
  const currentDateBlock = today
    ? `<current_date>
Hoy es ${today}. Los días de la semana de la tabla de abajo ya están calculados —
BUSCÁ la fila que corresponda, NUNCA calcules vos el día de la semana de una fecha ni
cuántos días faltan para "el próximo lunes/martes/etc." — es un cálculo donde te
equivocás seguido (ya pasó en producción: le prometiste al cliente una fecha de cita
equivocada). Fuera de este rango, calculá con cuidado y verificá el resultado antes de
decirlo.

${nextDaysReference(today, 14)}
</current_date>`
    : "";

  const lessons = (input.lessons ?? []).map((l) => l.trim()).filter(Boolean);
  const lessonsBlock =
    lessons.length > 0
      ? `<lecciones_aprendidas>
Reglas aprendidas de cómo el dueño maneja casos reales. Síguelas SIEMPRE:
${lessons.map((l) => `- ${l}`).join("\n")}
</lecciones_aprendidas>`
      : "";

  return TEMPLATE
    .replaceAll("{{LANGUAGE}}", input.language)
    .replaceAll("{{BOT_NAME}}", input.botName)
    .replaceAll("{{BUSINESS_NAME}}", input.businessName)
    .replaceAll("{{CURRENT_DATE}}", currentDateBlock)
    .replaceAll("{{BUSINESS_CONTEXT}}", input.businessContext)
    .replaceAll("{{TOOL_LIST}}", toolList)
    .replaceAll("{{ASK_WITH_OPTIONS_BLOCK}}", askWithOptionsBlock)
    .replaceAll("{{NICHO_PLAYBOOK}}", input.nichoPlaybook ?? "")
    .replaceAll("{{LECCIONES}}", lessonsBlock)
    .replaceAll("{{TONE_LINE}}", toneLine)
    .replaceAll("{{EXTRA_ESCALATION}}", extraEscalation);
}

export interface SystemPromptOverrides {
  tone?: string;
  extraEscalationKeywords?: string[];
  botName?: string;
  lessons?: string[];
}

export function systemPromptFromEnv(
  env: Env,
  toolNames: string[],
  businessContext: string,
  nichoPlaybook?: string,
  overrides?: SystemPromptOverrides,
): string {
  return renderSystemPrompt({
    botName: overrides?.botName ?? env.BOT_NAME,
    businessName: env.BUSINESS_NAME,
    language: env.BOT_LANGUAGE,
    businessContext,
    toolList: toolNames,
    nichoPlaybook,
    tone: overrides?.tone,
    extraEscalationKeywords: overrides?.extraEscalationKeywords,
    lessons: overrides?.lessons,
    // Siempre "ahora": todo despliegue real quiere la fecha del momento, no una
    // que le pase el llamador. Por eso no es parámetro de esta función.
    // En la zona horaria del negocio (BOT_TIMEZONE), no en UTC — deuda técnica
    // 2026-08-09: calcularlo en UTC hacía que una conversación de noche en
    // Chile (UTC-3/-4) recibiera "hoy" adelantado un día, y con eso "mañana"
    // terminaba agendándose dos días después de lo pedido.
    today: new Intl.DateTimeFormat("en-CA", { timeZone: resolveBotTimezone(env) }).format(new Date()),
  });
}
