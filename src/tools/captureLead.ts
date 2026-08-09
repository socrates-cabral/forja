import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { LeadsRepo } from "../db/leads";

export function captureLeadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Captura un lead (cliente interesado) para que el dueño venda después. Lo guarda en la base del negocio.",
    inputSchema: z.object({
      name: z.string().optional().describe("Nombre del cliente"),
      contact: z.string().optional().describe("Teléfono o email"),
      intent: z.string().describe("Qué quiere el cliente, en 1-2 frases"),
      notes: z.string().optional(),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Campos propios del nicho de negocio (ej. tratamiento, previsión, fecha_cita para clínicas dentales). Opcional.",
        ),
    }),
    execute: async ({ name, contact, intent, notes, metadata }) => {
      const convId = getConversationId();
      const leads = new LeadsRepo(new Db(env.DB));
      const leadId = await leads.create({
        conversationId: convId,
        name,
        contact,
        channelUserId: null,
        intent,
        notes,
        metadata,
      });

      // Optional external export — Pro-tier feature, skipped if no creds
      // (Implementation deferred to Task 7.4 — adds Google Sheets export)

      return { leadId, message: "Lead capturado." };
    },
  });
}
