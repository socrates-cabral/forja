import type { Env } from "./env";

export function getBufferMs(env: Env): number {
  return Math.max(1000, parseInt(env.BUFFER_SECONDS, 10) * 1000);
}

export function isPro(env: Env): boolean {
  return env.BOT_TIER === "pro";
}

const DEFAULT_BOT_TIMEZONE = "UTC";

/**
 * Zona horaria del negocio, para anclar el bot a la fecha/hora real (ver
 * {{TODAY}} en system-prompt.ts). Default UTC — no se asume ningún país,
 * a diferencia de calcomTimeZone/dentalinkTimeZone que sí tienen un default
 * regional porque son integraciones específicas de un mercado.
 */
export function resolveBotTimezone(env: Env): string {
  return (env.BOT_TIMEZONE || "").trim() || DEFAULT_BOT_TIMEZONE;
}

// Tools reservadas al tier Pro. captureLead NO está aquí a propósito: el bot
// Starter (free) captura leads — es su valor central. Lo Pro son las tools más
// avanzadas por nicho (agendar citas, consultar catálogo/inventario).
export const PRO_ONLY_TOOLS = [
  "scheduleAppointment",
  "calcomAvailability",
  "catalogQuery",
  "dentalinkAvailability",
  "dentalinkAppointment",
] as const;

// Tabs del dashboard reservadas al tier Pro (Análisis + growth). El tier free
// ve un panel funcional (Resumen, Conversaciones, Leads, Tickets, Flujo, KB,
// Conexiones, Config) pero sin el Analista IA, métricas, costos, mejoras ni
// campañas — esos desbloquean con la comunidad.
export const PRO_ONLY_TABS = ["insights", "stats", "costs", "mejoras", "campanas"] as const;

export function isToolAvailable(env: Env, toolName: string): boolean {
  if (!PRO_ONLY_TOOLS.includes(toolName as (typeof PRO_ONLY_TOOLS)[number])) return true;
  return isPro(env);
}
