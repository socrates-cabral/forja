import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { getAvailableSlots, resolveDentistaId, resolveSucursalId, dentalinkTimeZone } from "../integrations/dentalink";

export function dentalinkAvailabilityTool(env: Env) {
  return tool({
    description:
      "Consulta horarios disponibles en la clínica dental (Dentalink) para un servicio y fecha. " +
      "Úsala SIEMPRE antes de dentalinkAppointment — nunca ofrezcas un horario sin haberlo confirmado libre aquí.",
    inputSchema: z.object({
      fecha: z.string().describe("Fecha a consultar, formato YYYY-MM-DD"),
      servicio: z
        .string()
        .optional()
        .describe("Tipo de tratamiento (ej. 'limpieza', 'ortodoncia'), para elegir al dentista correcto"),
    }),
    execute: async ({ fecha, servicio }) => {
      const dentistaId = resolveDentistaId(env, servicio);
      const sucursalId = resolveSucursalId(env);
      if (!dentistaId || !sucursalId) return { error: "dentalink_not_configured" as const };
      const result = await getAvailableSlots(env, dentistaId, sucursalId, fecha);
      if (!result.ok) return { error: "dentalink_failed" as const, reason: result.reason };
      return { fecha, slots: result.slots, timezone: dentalinkTimeZone(env) };
    },
  });
}
