import type { Env } from "../env";
import { isPro } from "../config";
import { searchKbTool } from "./searchKb";
import { handoffHumanTool } from "./handoffHuman";
import { pauseBotTool } from "./pauseBot";
import { snoozeUserTool } from "./snoozeUser";
import { captureLeadTool } from "./captureLead";
import { scheduleAppointmentTool } from "./scheduleAppointment";
import { catalogQueryTool } from "./catalogQuery";
import { dentalinkAvailabilityTool } from "./dentalinkAvailability";
import { dentalinkAppointmentTool } from "./dentalinkAppointment";
import { dentalinkConfigured } from "../integrations/dentalink";
import { calcomConfigured } from "../integrations/calcom";

export interface ToolContext {
  env: Env;
  getConversationId: () => string | null;
}

export function buildTools(ctx: ToolContext) {
  // Free tier base set. captureLead va aquí a propósito: el bot Starter (free)
  // captura prospectos — es el valor central de un bot de ventas. Lo Pro son las
  // tools más avanzadas por nicho (agendar citas, consultar catálogo/inventario).
  const tools: Record<string, any> = {
    searchKb: searchKbTool(ctx.env),
    handoffHuman: handoffHumanTool(ctx.env, ctx.getConversationId),
    pauseBot: pauseBotTool(ctx.env, ctx.getConversationId),
    snoozeUser: snoozeUserTool(ctx.env, ctx.getConversationId),
    captureLead: captureLeadTool(ctx.env, ctx.getConversationId),
  };

  // Pro tier additions
  if (isPro(ctx.env)) {
    tools.catalogQuery = catalogQueryTool(ctx.env);

    // Agenda de citas: Dentalink y Cal.com son mutuamente excluyentes — una
    // clínica que configuró Dentalink no necesita (ni debe ver) la tool
    // genérica de Cal.com, y viceversa. Y ninguna de las dos se registra si
    // no está realmente configurada: una tool visible-pero-rota invita al
    // modelo a "usarla" y luego inventar un resultado cuando falla (bug real
    // observado 2026-08-09 — el bot declaró una cita "confirmada" tras un
    // scheduleAppointment que devolvió calcom_not_configured).
    if (dentalinkConfigured(ctx.env)) {
      tools.dentalinkAvailability = dentalinkAvailabilityTool(ctx.env);
      tools.dentalinkAppointment = dentalinkAppointmentTool(ctx.env, ctx.getConversationId);
    } else if (calcomConfigured(ctx.env)) {
      tools.scheduleAppointment = scheduleAppointmentTool(ctx.env, ctx.getConversationId);
    }
  }

  return tools;
}
