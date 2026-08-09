import { describe, it, expect, vi } from "vitest";

// Mock del catálogo del negocio: no vacío por default, para no cambiar el
// comportamiento de los tests preexistentes que asumen catalogQuery presente.
// El gate real (catálogo vacío → catalogQuery ausente) se prueba en
// index.catalogEmpty.test.ts, con su propio mock.
vi.mock("../../member/config.local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../member/config.local")>();
  return { ...actual, catalog: [{ name: "Producto Test", price: 100 }] };
});

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
  it("registers the 6 free-tier tools (incluye captureLead y askWithOptions)", () => {
    const tools = buildTools(makeCtx("free"));
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
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
    expect(tools.askWithOptions).toBeDefined();
    expect(tools.scheduleAppointment).toBeUndefined();
    expect(tools.catalogQuery).toBeUndefined();
  });

  it("pro tier con Cal.com configurado agrega calcomAvailability + scheduleAppointment además de catalogQuery", () => {
    const ctx = makeCtx("pro");
    (ctx.env as any).CALCOM_API_KEY = "cal_x";
    (ctx.env as any).CALCOM_EVENT_TYPE_ID = "1";
    const tools = buildTools(ctx);
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
      "calcomAvailability",
      "captureLead",
      "catalogQuery",
      "handoffHuman",
      "pauseBot",
      "scheduleAppointment",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeDefined();
    expect(tools.calcomAvailability).toBeDefined();
    expect(tools.catalogQuery).toBeDefined();
  });

  it("pro tier SIN Cal.com ni Dentalink configurados no registra ninguna tool de agendar — evita ofrecer una tool rota que el modelo intente usar y luego invente un resultado", () => {
    const tools = buildTools(makeCtx("pro"));
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
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
      "askWithOptions",
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
