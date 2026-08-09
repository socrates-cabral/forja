import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { createBooking, resolveEventTypeId, calcomTimeZone } from "../integrations/calcom";

// Deuda técnica 2026-08-09: esta tool antes traía su propio cliente Cal.com v1
// inline (eventTypeId pedido al modelo como input libre, API key en query
// string, sin guardia sobre un booking sin id). Ahora reusa el cliente v2 ya
// testeado de src/integrations/calcom.ts — el mismo patrón que dentalinkAppointment
// usa para src/integrations/dentalink.ts.
export function scheduleAppointmentTool(env: Env, _getConversationId: () => string | null) {
  return tool({
    description:
      "Agenda una cita usando Cal.com. Pasa el servicio solicitado — el tipo de evento " +
      "correcto se resuelve solo según la configuración del negocio, nunca lo inventes.",
    inputSchema: z.object({
      servicio: z.string().optional().describe("Tipo de servicio/cita solicitado, para elegir el evento correcto"),
      startTime: z.string().describe("ISO datetime, e.g. 2026-06-01T17:00:00Z"),
      attendeeName: z.string(),
      attendeeEmail: z.string().email(),
      attendeePhone: z.string().optional(),
      notes: z.string().optional(),
    }),
    execute: async ({ servicio, startTime, attendeeName, attendeeEmail, attendeePhone, notes }) => {
      const eventTypeId = resolveEventTypeId(env, servicio);
      if (!eventTypeId) return { error: "calcom_not_configured" as const };
      const result = await createBooking(env, {
        eventTypeId,
        start: startTime,
        name: attendeeName,
        email: attendeeEmail,
        timeZone: calcomTimeZone(env),
        phone: attendeePhone,
        notes,
      });
      if (!result.ok) return { error: "calcom_failed" as const, reason: result.reason };
      return { bookingId: result.bookingId, status: result.status };
    },
  });
}
