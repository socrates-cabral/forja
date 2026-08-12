/**
 * Tests del Follow-up bot: selección conservadora (caliente / activo),
 * ventana 3-20h, exclusiones (pausadas, instagram, último mensaje
 * del cliente, ya enviado), claim único de por vida y caps. LLM + adapter
 * mockeados; D1 real via miniflare.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const sendReplyMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({
    provider: "anthropic",
    modelId: "modelo-test",
    model: {},
    supportsPromptCache: true,
  }),
}));

vi.mock("../../src/replies/sender", () => ({
  pickAdapter: () => ({ sendReply: (...a: unknown[]) => sendReplyMock(...a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { InsightsRepo } from "../../src/db/insights";
import {
  pickFollowupCandidates,
  parseFollowupExcludeIds,
  runFollowups,
  MIN_IDLE_MS,
  MAX_IDLE_MS,
} from "../../src/followup/run";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let insights: InsightsRepo;

const NOW = Date.now();
const IDLE_OK = NOW - MIN_IDLE_MS - 60 * 60 * 1000; // 4h atrás: dentro de la ventana

/** Conversación con user→assistant terminada hace `userAt`. */
async function seed(
  userId: string,
  opts: { channel?: string; userMsgs?: number; userAt?: number; endsWithUser?: boolean } = {},
): Promise<string> {
  const channel = opts.channel ?? "manychat";
  const userAt = opts.userAt ?? IDLE_OK;
  const conv = await convs.getOrCreate(channel, userId, `Lead ${userId}`);
  const n = opts.userMsgs ?? 1;
  for (let i = 0; i < n; i++) {
    await msgs.append(conv.id, "user", `pregunta ${i + 1}`, { createdAt: userAt - (n - i) * 1000 });
  }
  if (!opts.endsWithUser) {
    await msgs.append(conv.id, "assistant", "respuesta del bot", { createdAt: userAt + 500 });
  }
  await convs.touchLastMessage(conv.id, userAt + (opts.endsWithUser ? 0 : 500));
  return conv.id;
}

async function markHot(convId: string) {
  await insights.upsert({
    conversationId: convId,
    sentiment: "positive",
    resolution: "unresolved",
    botScore: 4,
    topics: [],
    summary: "interesado",
    missedKb: null,
    saleOpportunity: true,
  });
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    BOT_NAME: "Ana",
    BUSINESS_NAME: "Mi Negocio",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    MANYCHAT_API_KEY: "mc-test",
  } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  insights = new InsightsRepo(db);
  generateTextMock.mockReset().mockResolvedValue({ text: "¿Quedaste con alguna duda? Aquí ando." });
  sendReplyMock.mockReset().mockResolvedValue(undefined);
});

describe("pickFollowupCandidates — selección", () => {
  it("sin FOLLOWUP_EXCLUDE_IDS configurada, el comportamiento es idéntico al de antes de la exclusión (regresión)", async () => {
    // env.FOLLOWUP_EXCLUDE_IDS no está seteada acá a propósito — confirma que
    // la cláusula SQL dinámica se omite por completo (no un `NOT IN ()`
    // colgando) y que instalaciones sin esta var (la inmensa mayoría) ven el
    // mismo resultado que devolvía pickFollowupCandidates antes de a932ec2.
    expect(env.FOLLOWUP_EXCLUDE_IDS).toBeUndefined();
    const hot = await seed("hot-no-exclusion");
    await markHot(hot);

    const c = await pickFollowupCandidates(env, NOW, 10);
    expect(c).toHaveLength(1);
    expect(c[0].id).toBe(hot);
  });

  it("elige calientes (sale_opportunity) y activos (4+ msgs); ignora al resto", async () => {
    const hot = await seed("hot");
    await markHot(hot);
    await seed("active", { userMsgs: 4 });
    await seed("quiet"); // 1 mensaje, sin señales → NO

    const c = await pickFollowupCandidates(env, NOW, 10);
    const byId = Object.fromEntries(c.map((x) => [x.id, x.reason]));
    expect(byId[hot]).toBe("hot");
    expect(byId["manychat:active"]).toBe("active");
    expect(byId["manychat:quiet"]).toBeUndefined();
    expect(c).toHaveLength(2);
  });

  it("respeta la ventana 3-20h y las exclusiones", async () => {
    const fresh = await seed("fresh", { userAt: NOW - 30 * 60 * 1000 }); // hace 30 min
    await markHot(fresh);
    const stale = await seed("stale", { userAt: NOW - MAX_IDLE_MS - 60 * 60 * 1000 }); // hace 21h
    await markHot(stale);
    const pending = await seed("pending", { endsWithUser: true }); // terminó hablando el cliente
    await markHot(pending);
    const ig = await seed("igdead", { channel: "instagram" });
    await markHot(ig);
    const paused = await seed("paused");
    await markHot(paused);
    await convs.setPausedUntil(paused, NOW + 60 * 60 * 1000);

    const c = await pickFollowupCandidates(env, NOW, 10);
    expect(c).toHaveLength(0);
  });

  it("excluye las cuentas propias del dueño listadas en FOLLOWUP_EXCLUDE_IDS, sin vaciar el batch de candidatos reales", async () => {
    // 2026-08-12: bug real en vivo — las cuentas propias del dueño (usadas
    // para probar el bot como si fueran cliente) calificaban igual que un
    // lead real y el follow-up le mandaba mensajes al propio dueño. La
    // exclusión debe ser en SQL (WHERE), no post-filtro, para no comerse el
    // cupo de un candidato real que sí debía recibir el follow-up.
    const own = await seed("owner-test-account");
    await markHot(own);
    const real = await seed("real-lead");
    await markHot(real);
    env.FOLLOWUP_EXCLUDE_IDS = "manychat:owner-test-account";

    const c = await pickFollowupCandidates(env, NOW, 10);
    const ids = c.map((x) => x.id);
    expect(ids).not.toContain(own);
    expect(ids).toContain(real);
    expect(c).toHaveLength(1);
  });

  it("excluye varias cuentas propias a la vez (CSV con espacios)", async () => {
    const own1 = await seed("own1");
    await markHot(own1);
    const own2 = await seed("own2");
    await markHot(own2);
    const real = await seed("real2");
    await markHot(real);
    env.FOLLOWUP_EXCLUDE_IDS = " manychat:own1 , manychat:own2 ";

    const c = await pickFollowupCandidates(env, NOW, 10);
    expect(c.map((x) => x.id)).toEqual([real]);
  });
});

describe("parseFollowupExcludeIds", () => {
  it("parsea el CSV, recorta espacios y descarta vacíos", () => {
    env.FOLLOWUP_EXCLUDE_IDS = " telegram:1137802732 ,whatsapp:56967491268,,  ";
    expect(parseFollowupExcludeIds(env)).toEqual([
      "telegram:1137802732",
      "whatsapp:56967491268",
    ]);
  });

  it("devuelve [] cuando la var no está configurada", () => {
    delete env.FOLLOWUP_EXCLUDE_IDS;
    expect(parseFollowupExcludeIds(env)).toEqual([]);
  });
});

describe("runFollowups — envío y garantías", () => {
  it("manda UN follow-up por candidato, lo persiste como assistant y lo registra", async () => {
    const hot = await seed("h1");
    await markHot(hot);

    const r = await runFollowups(env, { now: NOW });
    expect(r).toEqual({ sent: 1, skipped: 0, errors: 0 });
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    const [payload] = sendReplyMock.mock.calls[0];
    expect(payload.channelUserId).toBe("h1");
    expect(payload.chunks[0]).toContain("duda");

    const history = await msgs.lastN(hot, 5);
    expect(history[history.length - 1].role).toBe("assistant");
    expect(history[history.length - 1].content).toContain("duda");

    // El prompt llevó contexto real y la razón
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("pregunta 1");
    expect(prompt).toContain("venta o interés abierto");
  });

  it("NUNCA repite: la segunda corrida no le manda a nadie", async () => {
    const hot = await seed("h2");
    await markHot(hot);
    await runFollowups(env, { now: NOW });
    const r2 = await runFollowups(env, { now: NOW });
    expect(r2.sent).toBe(0);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });

  it("si el envío falla, el claim se queda (no reintenta a ese cliente)", async () => {
    sendReplyMock.mockRejectedValueOnce(new Error("manychat 500"));
    const hot = await seed("h3");
    await markHot(hot);

    const r = await runFollowups(env, { now: NOW });
    expect(r.errors).toBe(1);
    const r2 = await runFollowups(env, { now: NOW });
    expect(r2.sent).toBe(0); // claimed — no double touch
  });

  it("respeta el cap diario", async () => {
    for (const u of ["c1", "c2", "c3"]) {
      const id = await seed(u);
      await markHot(id);
    }
    const r = await runFollowups(env, { now: NOW, dailyCap: 2 });
    expect(r.sent).toBe(2);
  });

  it("no hace nada con el bot pausado globalmente", async () => {
    const { SettingsRepo, SETTING_KEYS } = await import("../../src/db/settings");
    await new SettingsRepo(db).set(SETTING_KEYS.botPaused, "1");
    const hot = await seed("h4");
    await markHot(hot);
    const r = await runFollowups(env, { now: NOW });
    expect(r.sent).toBe(0);
    expect(sendReplyMock).not.toHaveBeenCalled();
  });
});
