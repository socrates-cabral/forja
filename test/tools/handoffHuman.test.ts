import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";
import { handoffHumanTool } from "../../src/tools/handoffHuman";

let env: any;
let tickets: TicketsRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  tickets = new TicketsRepo(db);
  // The tickets table FKs conversation_id -> conversations(id), so we need a
  // real conversation row before the tool can attach a ticket to it.
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  env = {
    DB: d1,
    OWNER_EMAIL: "hugo@hugohair.com",
    RESEND_API_KEY: "fake_key",
    BUSINESS_NAME: "Hugo Hair",
    DASHBOARD_BASE_URL: "https://dash.test",
    BOT_TIER: "free",
  };
});

describe("handoffHumanTool", () => {
  it("creates a ticket row in D1 even without Resend key", async () => {
    const envNoResend = { ...env, RESEND_API_KEY: undefined };
    const tool = handoffHumanTool(envNoResend, () => convId);
    const result = await tool.execute!(
      {
        reason: "complejo",
        summary: "María pregunta sobre shampoo sin sulfatos",
        category: "product",
      },
      {} as any,
    );
    expect((result as { ticketId: string }).ticketId).toBeTruthy();
    const list = await tickets.listOpen();
    expect(list).toHaveLength(1);
    expect(list[0].summary).toContain("María");
  });

  it("notified queda vacío cuando no hay NINGÚN canal de aviso configurado — el modelo debe poder distinguirlo", async () => {
    const envNoChannels = { ...env, RESEND_API_KEY: undefined };
    const tool = handoffHumanTool(envNoChannels, () => convId);
    const result = (await tool.execute!(
      { reason: "x", summary: "y", category: "other" },
      {} as any,
    )) as { ticketId: string; notified: string[] };
    expect(result.ticketId).toBeTruthy();
    expect(result.notified).toEqual([]);
  });

  it("notified incluye 'email' cuando Resend confirma el envío, y escapa HTML del cliente en el cuerpo", async () => {
    const fetchMock = vi.fn(async (url: any, _init: any) =>
      String(url).includes("resend.com")
        ? new Response(JSON.stringify({ id: "re_123" }), { status: 200 })
        : new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = handoffHumanTool(env, () => convId);
    const result = (await tool.execute!(
      { reason: "x", summary: "<script>alert(1)</script>", category: "complaint" },
      {} as any,
    )) as { ticketId: string; notified: string[] };
    expect(result.notified).toContain("email");

    const resendCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("resend.com"));
    expect(resendCall).toBeTruthy();
    const payload = JSON.parse(String((resendCall![1] as RequestInit).body));
    expect(payload.html).not.toContain("<script>alert(1)</script>");
    expect(payload.html).toContain("&lt;script&gt;");
    vi.unstubAllGlobals();
  });
});
