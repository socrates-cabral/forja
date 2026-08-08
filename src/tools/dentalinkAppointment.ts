import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { createBooking, resolveDentistaId, resolveSucursalId } from "../integrations/dentalink";

export function dentalinkAppointmentTool(env: Env, _getConversationId: () => string | null) {
  return tool({
    description:
      "Agenda una cita real en la clínica dental (Dentalink). Llama SIEMPRE a dentalinkAvailability antes " +
      "para confirmar que el horario está libre — nunca ofrezcas ni agendes un horario sin haberlo consultado.",
    inputSchema: z.object({
      fecha: z.string().describe("YYYY-MM-DD"),
      horaInicio: z.string().describe("HH:MM — debe ser un horario confirmado libre por dentalinkAvailability"),
      horaFin: z.string().describe("HH:MM"),
      nombrePaciente: z.string(),
      telefonoPaciente: z.string(),
      emailPaciente: z.string().email().optional(),
      servicio: z.string().optional().describe("Tipo de tratamiento, para elegir al dentista correcto"),
      comentario: z.string().optional(),
    }),
    execute: async ({ fecha, horaInicio, horaFin, nombrePaciente, telefonoPaciente, emailPaciente, servicio, comentario }) => {
      const dentistaId = resolveDentistaId(env, servicio);
      const sucursalId = resolveSucursalId(env);
      if (!dentistaId || !sucursalId) return { error: "dentalink_not_configured" as const };
      const result = await createBooking(env, {
        dentistaId,
        sucursalId,
        date: fecha,
        horaInicio,
        horaFin,
        nombrePaciente,
        telefonoPaciente,
        emailPaciente,
        comentario,
      });
      if (!result.ok) return { error: "dentalink_failed" as const, reason: result.reason };
      return { citaId: result.citaId, patientId: result.patientId };
    },
  });
}
