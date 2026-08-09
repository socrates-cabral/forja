import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { getAvailableSlots, resolveEventTypeId, calcomTimeZone } from "../integrations/calcom";

// Deuda técnica 2026-08-09: getAvailableSlots ya existía en integrations/calcom.ts
// (testeado) pero no tenía tool que lo consumiera — un negocio con solo Cal.com
// configurado no tenía forma de chequear disponibilidad real antes de agendar,
// contradiciendo la regla del playbook que exige confirmar disponibilidad primero.
export function calcomAvailabilityTool(env: Env) {
  return tool({
    description:
      "Consulta horarios disponibles en Cal.com para un servicio y fecha. " +
      "Úsala SIEMPRE antes de scheduleAppointment — nunca ofrezcas un horario sin haberlo confirmado libre aquí.",
    inputSchema: z.object({
      fecha: z.string().describe("Fecha a consultar, formato YYYY-MM-DD"),
      servicio: z.string().optional().describe("Tipo de servicio/cita, para elegir el evento correcto"),
    }),
    execute: async ({ fecha, servicio }) => {
      const eventTypeId = resolveEventTypeId(env, servicio);
      if (!eventTypeId) return { error: "calcom_not_configured" as const };
      const result = await getAvailableSlots(env, eventTypeId, fecha, calcomTimeZone(env));
      if (!result.ok) return { error: "calcom_failed" as const, reason: result.reason };
      return { fecha, slots: result.slots, timezone: calcomTimeZone(env) };
    },
  });
}
