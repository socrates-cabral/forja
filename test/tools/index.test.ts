import { describe, it, expect } from "vitest";
import { buildTools, type ToolContext } from "../../src/tools/index";

function makeCtx(tier: "free" | "pro", niche?: string): ToolContext {
  const env = {
    BOT_TIER: tier,
    BOT_NICHE: niche,
    DB: {} as any,
    AI: {} as any,
    BUSINESS_NAME: "Test",
    OWNER_EMAIL: "owner@test.com",
    DASHBOARD_BASE_URL: "https://example.com",
  } as any;
  return { env, getConversationId: () => "conv-1" };
}

describe("buildTools", () => {
  it("registers the 5 free-tier tools (incluye captureLead)", () => {
    const tools = buildTools(makeCtx("free"));
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
  });

  it("free tier captura leads pero excluye las Pro-only avanzadas", () => {
    const tools = buildTools(makeCtx("free"));
    expect(tools.captureLead).toBeDefined();
    expect(tools.scheduleAppointment).toBeUndefined();
    expect(tools.catalogQuery).toBeUndefined();
  });

  it("pro tier con Cal.com configurado agrega scheduleAppointment además de catalogQuery", () => {
    const ctx = makeCtx("pro");
    (ctx.env as any).CALCOM_API_KEY = "cal_x";
    (ctx.env as any).CALCOM_EVENT_TYPE_ID = "1";
    const tools = buildTools(ctx);
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "catalogQuery",
      "handoffHuman",
      "pauseBot",
      "scheduleAppointment",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeDefined();
    expect(tools.catalogQuery).toBeDefined();
  });

  it("pro tier SIN Cal.com ni Dentalink configurados no registra ninguna tool de agendar — evita ofrecer una tool rota que el modelo intente usar y luego invente un resultado", () => {
    const tools = buildTools(makeCtx("pro"));
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "catalogQuery",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeUndefined();
    expect(tools.dentalinkAvailability).toBeUndefined();
    expect(tools.dentalinkAppointment).toBeUndefined();
  });

  it("el Starter genérico no agrega tools de nicho (aunque BOT_NICHE traiga un giro)", () => {
    for (const niche of [undefined, "restaurante", "inmobiliaria", "hoteleria"]) {
      const tools = buildTools(makeCtx("pro", niche));
      expect(tools.crearReservacion).toBeUndefined();
      expect(tools.calificarComprador).toBeUndefined();
      expect(tools.agendarCita).toBeUndefined();
      expect(tools.registrarPedido).toBeUndefined();
      expect(tools.registrarProspecto).toBeUndefined();
      expect(tools.reservarHospedaje).toBeUndefined();
    }
  });

  it("pro tier con Dentalink configurado usa dentalinkAvailability/dentalinkAppointment en vez de scheduleAppointment", () => {
    const ctx = makeCtx("pro");
    (ctx.env as any).DENTALINK_API_TOKEN = "tok";
    (ctx.env as any).DENTALINK_SUCURSAL_ID = "1";
    (ctx.env as any).DENTALINK_DENTISTA_ID = "9";
    const tools = buildTools(ctx);
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "catalogQuery",
      "dentalinkAppointment",
      "dentalinkAvailability",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeUndefined();
  });
});
