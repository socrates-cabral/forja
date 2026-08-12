import { describe, it, expect, vi } from "vitest";
import {
  renderSystemPrompt,
  systemPromptFromEnv,
  type SystemPromptInput,
} from "../src/system-prompt";

const input: SystemPromptInput = {
  botName: "Asistente",
  businessName: "Barbería Centro",
  language: "es",
  businessContext: "Horarios: Lun-Sáb 10am-8pm\nUbicación: Monterrey",
  toolList: ["searchKb", "handoffHuman", "pauseBot"],
};

describe("renderSystemPrompt", () => {
  it("contains all 10 sections", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("<output_language>");
    expect(prompt).toContain("<role>");
    expect(prompt).toContain("<business_context>");
    expect(prompt).toContain("<identity_and_voice>");
    expect(prompt).toContain("<core_principles>");
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("<escalation_rules>");
    expect(prompt).toContain("<style_guide>");
    expect(prompt).toContain("<anti_patterns>");
  });

  it("replaces every placeholder (none left)", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("}}");
  });

  it("interpolates language, bot name and business name", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("es");
    expect(prompt).toContain("Asistente");
    expect(prompt).toContain("Barbería Centro");
  });

  it("renders tool list as bullet lines", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("- searchKb");
    expect(prompt).toContain("- handoffHuman");
    expect(prompt).toContain("- pauseBot");
  });

  it("injects business context", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("Horarios: Lun-Sáb 10am-8pm");
  });

  it("inserts nichoPlaybook when provided and empty string when omitted", () => {
    const withPlaybook = renderSystemPrompt({
      ...input,
      nichoPlaybook: "<diagnostic_playbooks>X</diagnostic_playbooks>",
    });
    expect(withPlaybook).toContain("<diagnostic_playbooks>X</diagnostic_playbooks>");
    // omitted -> the placeholder is gone, replaced by ""
    const withoutPlaybook = renderSystemPrompt(input);
    expect(withoutPlaybook).not.toContain("{{NICHO_PLAYBOOK}}");
  });

  it("inyecta <current_date> con la fecha exacta cuando se pasa today", () => {
    const prompt = renderSystemPrompt({ ...input, today: "2026-08-08" });
    expect(prompt).toContain("<current_date>");
    expect(prompt).toContain("Hoy es 2026-08-08");
    expect(prompt).toContain("</current_date>");
  });

  it("<current_date> trae una tabla de 30 días con el día de la semana ya calculado", () => {
    // 2026-08-12, bug real en producción: el modelo calculó mal el día de la
    // semana tres veces seguidas en la misma conversación (dijo "hoy es
    // martes 12 de agosto" cuando el 12 de agosto de 2026 es MIÉRCOLES, y
    // terminó prometiéndole al cliente "martes 19 de agosto" — el martes
    // real, contando desde un miércoles 12, es el 18). Este test ancla los
    // valores reales para que una regresión de zona horaria o de fórmula se
    // note de inmediato — no solo que la tabla "exista". 30 días (no 14):
    // la revisión del fix original notó que un horizonte corto deja al
    // modelo expuesto al mismo bug apenas el cliente pide algo más lejos.
    const prompt = renderSystemPrompt({ ...input, today: "2026-08-12" });
    const block = prompt.split("<current_date>")[1].split("</current_date>")[0];
    expect(block).toContain("2026-08-12 miércoles (hoy)");
    expect(block).toContain("2026-08-13 jueves");
    expect(block).toContain("2026-08-18 martes");
    expect(block).toContain("2026-08-19 miércoles");
    // Cruce de mes, dentro de los 30 días: día 29 (0-indexado) = 10 de
    // septiembre, jueves.
    expect(block).toContain("2026-09-10 jueves");
    // 30 días exactos: hoy (día 0) + 29 más, ni uno más.
    expect(block).not.toContain("2026-09-11");
  });

  it("nextDaysReference no rompe silenciosamente con un today mal formado — devuelve el bloque vacío", () => {
    // Hoy solo lo alimenta systemPromptFromEnv con formato garantizado,
    // pero renderSystemPrompt es exportada — un caller futuro con un string
    // mal formado no debe producir "Invalid Date" repetido 30 veces.
    const prompt = renderSystemPrompt({ ...input, today: "12 de agosto" });
    expect(prompt).toContain("<current_date>");
    expect(prompt).not.toContain("Invalid Date");
  });

  it("omite el bloque <current_date> completo si no hay today", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).not.toContain("<current_date>");
    expect(prompt).not.toContain("Hoy es");
  });
});

describe("systemPromptFromEnv", () => {
  it("pulls botName/businessName/language from env", () => {
    const env = {
      BOT_NAME: "Bot",
      BUSINESS_NAME: "Acme",
      BOT_LANGUAGE: "en",
    } as any;
    const prompt = systemPromptFromEnv(env, ["searchKb"], "ctx here");
    expect(prompt).toContain("Bot");
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("en");
    expect(prompt).toContain("- searchKb");
    expect(prompt).toContain("ctx here");
  });

  it("inyecta la fecha de hoy automáticamente (sin parámetro del llamador)", () => {
    const env = { BOT_NAME: "Bot", BUSINESS_NAME: "Acme", BOT_LANGUAGE: "es" } as any;
    const prompt = systemPromptFromEnv(env, ["searchKb"], "ctx");
    expect(prompt).toContain("<current_date>");
    expect(prompt).toContain(`Hoy es ${new Date().toISOString().slice(0, 10)}`);
  });

  it("instruye usar askWithOptions para preguntas de opción múltiple, en imperativo y en su propio bloque", () => {
    // 2026-08-09: un test en vivo (Clínica Demo, WhatsApp) mostró que ni
    // Haiku ni Sonnet 4.6 llamaban la tool cuando la regla era un ítem más
    // ("preferí...") dentro de la lista numerada de <core_principles>. Se
    // movió a su propio bloque <opciones_multiples> en imperativo ("SIEMPRE").
    const env = { BOT_NAME: "Bot", BUSINESS_NAME: "Acme", BOT_LANGUAGE: "es" } as any;
    const prompt = systemPromptFromEnv(env, ["searchKb", "askWithOptions"], "ctx");
    expect(prompt).toContain("<opciones_multiples>");
    const block = prompt.split("<opciones_multiples>")[1].split("</opciones_multiples>")[0];
    expect(block).toContain("SIEMPRE llamá askWithOptions");
    expect(block).toContain("ni siquiera parcialmente");
    // Ejemplo contrastivo MAL/BIEN — a los modelos les cuesta menos seguir un
    // contraste concreto que una regla abstracta (2026-08-09: la redacción
    // sin ejemplo dejaba pasar frases de transición que ya reformulaban la
    // pregunta, ej. "¿y con cuál Isapre estás?" antes del askWithOptions).
    expect(block).toContain("MAL:");
    expect(block).toContain("BIEN:");
    // No debe quedar un rastro de la regla vieja como ítem numerado dentro
    // de core_principles — confirma que realmente se movió, no que se duplicó.
    const corePrinciples = prompt.split("<core_principles>")[1].split("</core_principles>")[0];
    expect(corePrinciples).not.toContain("askWithOptions");
  });

  it("el bloque <opciones_multiples> NO aparece si la tool no está en toolList (Hallazgo 2)", () => {
    // Antes de este fix la regla vivía hardcodeada en el TEMPLATE, así que
    // aparecía SIEMPRE — incluso cuando el dueño apagó askWithOptions desde
    // /admin y la tool ni siquiera está en <tools>. Eso le decía al modelo
    // "usá askWithOptions" y "no uses tools fuera de <tools>" al mismo
    // tiempo, en el mismo prompt.
    const env = { BOT_NAME: "Bot", BUSINESS_NAME: "Acme", BOT_LANGUAGE: "es" } as any;
    const prompt = systemPromptFromEnv(env, ["searchKb"], "ctx");
    expect(prompt).not.toContain("<opciones_multiples>");
    expect(prompt).not.toContain("askWithOptions");
  });

  it("calcula 'hoy' en BOT_TIMEZONE, no en UTC — deuda técnica 2026-08-09", () => {
    // 2026-08-09T02:00:00Z: en UTC ya es 9 de agosto, pero en Santiago
    // (UTC-4 en agosto) todavía es 8 de agosto a las 22:00. Antes del fix,
    // el bot le habría dicho al modelo que "hoy" es un día adelantado.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T02:00:00Z"));
    try {
      const envUtc = { BOT_NAME: "Bot", BUSINESS_NAME: "Acme", BOT_LANGUAGE: "es" } as any;
      const envSantiago = { ...envUtc, BOT_TIMEZONE: "America/Santiago" } as any;
      const promptUtc = systemPromptFromEnv(envUtc, ["searchKb"], "ctx");
      const promptSantiago = systemPromptFromEnv(envSantiago, ["searchKb"], "ctx");
      expect(promptUtc).toContain("Hoy es 2026-08-09");
      expect(promptSantiago).toContain("Hoy es 2026-08-08");
    } finally {
      vi.useRealTimers();
    }
  });
});
