import { tool } from "ai";
import { z } from "zod";
import { Resend } from "resend";
import type { Env } from "../env";
import { Db } from "../db/client";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { isPro } from "../config";

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

export function handoffHumanTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Crea un ticket para el dueño + intenta avisarle (Telegram/WhatsApp/email, lo que tenga configurado). " +
      "Usalo cuando el bot no puede resolver o el cliente pide humano explícitamente. El resultado trae " +
      "`notified`: los canales que SÍ recibieron el aviso. Si viene vacío, nadie fue notificado en el momento " +
      "— el ticket quedó guardado igual, pero decile al cliente que su solicitud quedó registrada, NUNCA que " +
      "ya le avisaste al equipo (eso no pasó).",
    inputSchema: z.object({
      reason: z.string().describe("Categoría corta del problema"),
      summary: z.string().max(300).describe("Resumen en 1 frase del contexto"),
      category: z.enum(["billing", "product", "complaint", "other"]).default("other"),
    }),
    execute: async ({ reason, summary, category }) => {
      const convId = getConversationId();
      const db = new Db(env.DB);
      const tickets = new TicketsRepo(db);
      const ticketId = await tickets.create({
        conversationId: convId,
        category,
        summary: `[${reason}] ${summary}`,
        transcript: "", // populated by agent if it has access; left blank otherwise
      });
      if (convId) {
        const convs = new ConversationsRepo(db);
        await convs.setOpenTicket(convId, ticketId);
      }

      // Send email if Resend configured. The SDK doesn't throw on an API-level
      // rejection — it resolves with {data, error} — so a bare try/catch alone
      // would call a rejected send "sent" (deuda técnica 2026-08-09).
      let emailSent = false;
      if (env.RESEND_API_KEY && env.OWNER_EMAIL) {
        try {
          const resend = new Resend(env.RESEND_API_KEY);
          const { data, error } = await resend.emails.send({
            from: `${env.BUSINESS_NAME} Bot <onboarding@resend.dev>`,
            to: env.OWNER_EMAIL,
            subject: `[Bot] Ticket ${reason}: ${summary.slice(0, 60)}`,
            html: `<p><strong>Categoría:</strong> ${esc(category)}</p>
                   <p><strong>Resumen:</strong> ${esc(summary)}</p>
                   <p><a href="${env.DASHBOARD_BASE_URL}/admin/tickets/${ticketId}">Ver ticket</a></p>`,
          });
          if (error) console.error("[handoffHuman] resend rejected:", error);
          else emailSent = Boolean(data?.id);
        } catch (e) {
          console.error("[handoffHuman] resend failed:", e);
        }
      }

      // Notify the owner. The ticket is already saved in D1 + dashboard; these
      // are just the "ping" so the owner sees it fast. Default channel is
      // Telegram DM (free, reuses the bot token). Twilio WhatsApp is optional
      // and, because this is a business-INITIATED message outside any 24h
      // session window, MUST use a pre-approved Content Template (HSM) — free
      // text would be rejected by WhatsApp. Both are best-effort.
      const notified = await notifyOwner(env, { reason, summary, ticketId });
      if (emailSent) notified.push("email");

      return { ticketId, notified };
    },
  });
}

interface HandoffNotice {
  reason: string;
  summary: string;
  ticketId: string;
}

/**
 * Qué canales de aviso al dueño están configurados. Lo usa el dashboard
 * (Salud del bot) para hacer VISIBLE cuando un handoff no le avisaría a nadie
 * — antes fallaba en silencio y el ticket se quedaba huérfano.
 */
export function handoffNotifyStatus(env: Env): { ok: boolean; channels: string[] } {
  const channels: string[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.OWNER_TELEGRAM_CHAT_ID) channels.push("Telegram");
  if (
    isPro(env) &&
    env.OWNER_WA_NUMBER &&
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_WA_FROM &&
    env.TWILIO_HANDOFF_CONTENT_SID
  )
    channels.push("WhatsApp");
  if (env.RESEND_API_KEY && env.OWNER_EMAIL) channels.push("Email");
  return { ok: channels.length > 0, channels };
}

/**
 * Best-effort owner notification on handoff. Default = Telegram DM (free,
 * reuses the bot token). Optional = Twilio WhatsApp via an approved Content
 * Template. Each channel is independent and never throws into the tool.
 *
 * Devuelve los canales que SÍ confirmaron el envío (deuda técnica 2026-08-09:
 * antes esto era void y la tool declaraba éxito sin importar si algún canal
 * había funcionado — el modelo no tenía cómo saber que nadie fue avisado).
 */
export async function notifyOwner(env: Env, notice: HandoffNotice): Promise<string[]> {
  const notified: string[] = [];
  const ticketUrl = `${env.DASHBOARD_BASE_URL}/admin/tickets`;

  // El SID de la plantilla puede venir del secret O del setting que escribe el
  // setup del panel. Se resuelve ANTES del guard: si vive solo en settings, el
  // guard sync (env-only) diría "sin canal" y saldríamos sin avisar a nadie.
  let handoffContentSid = env.TWILIO_HANDOFF_CONTENT_SID ?? "";
  if (!handoffContentSid) {
    try {
      const { SettingsRepo, SETTING_KEYS } = await import("../db/settings");
      handoffContentSid =
        (await new SettingsRepo(new Db(env.DB)).get(SETTING_KEYS.twilioHandoffContentSid)) ?? "";
    } catch {
      // settings no disponible — se comporta como no configurado
    }
  }
  const waViaSetting = Boolean(
    handoffContentSid && env.OWNER_WA_NUMBER && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WA_FROM,
  );

  // Fail-LOUD (en logs) cuando no hay ningún canal de aviso configurado: el
  // ticket existe en el dashboard pero nadie se entera. El dashboard también
  // lo muestra en "Salud del bot" (handoffNotifyStatus).
  if (!handoffNotifyStatus(env).ok && !waViaSetting) {
    console.error(
      `[notifyOwner] ticket ${notice.ticketId} creado pero SIN canal de aviso configurado ` +
        "(faltan OWNER_TELEGRAM_CHAT_ID, OWNER_WA_NUMBER+template o RESEND_API_KEY+OWNER_EMAIL) — el dueño no será notificado",
    );
    return notified;
  }

  // --- Telegram DM (default) ------------------------------------------------
  if (env.TELEGRAM_BOT_TOKEN && env.OWNER_TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.OWNER_TELEGRAM_CHAT_ID,
            text:
              `🚨 Nuevo ticket [${notice.reason}]\n${notice.summary}\n\nVer: ${ticketUrl}`,
          }),
        },
      );
      if (res.ok) notified.push("telegram");
      else console.error(`[notifyOwner] telegram respondió ${res.status}`);
    } catch (e) {
      console.error("[notifyOwner] telegram failed:", e);
    }
  }

  // --- Twilio WhatsApp via approved Content Template (optional) --------------
  // A business-initiated WhatsApp message outside a 24h session window REQUIRES
  // an approved template — Twilio rejects free-form Body. We send ContentSid +
  // ContentVariables (the template's {{1}}, {{2}}, {{3}} placeholders), not Body.
  // El SID (secret o setting) ya se resolvió arriba, antes del guard.
  if (
    isPro(env) &&
    env.OWNER_WA_NUMBER &&
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_WA_FROM &&
    handoffContentSid
  ) {
    try {
      const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
      const body = new URLSearchParams({
        From: `whatsapp:${env.TWILIO_WA_FROM}`,
        To: `whatsapp:${env.OWNER_WA_NUMBER}`,
        ContentSid: handoffContentSid,
        // Template placeholders: {{1}}=reason, {{2}}=summary, {{3}}=ticket URL.
        // The member authors the template in Twilio to match this ordering.
        ContentVariables: JSON.stringify({
          "1": notice.reason,
          "2": notice.summary,
          "3": ticketUrl,
        }),
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );
      if (res.ok) notified.push("whatsapp");
      else console.error(`[notifyOwner] twilio respondió ${res.status}`);
    } catch (e) {
      console.error("[notifyOwner] twilio template failed:", e);
    }
  }

  return notified;
}
