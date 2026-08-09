import { describe, it, expect, vi, afterEach } from "vitest";
import { scheduleAppointmentTool } from "../../src/tools/scheduleAppointment";

afterEach(() => vi.restoreAllMocks());

describe("scheduleAppointmentTool", () => {
  it("resuelve el eventTypeId por servicio y crea el booking vía Cal.com v2", async () => {
    const fetchMock = vi.fn(
      async (_url: any, _init: any) =>
        new Response(JSON.stringify({ status: "success", data: { id: 12345, status: "accepted" } }), {
          status: 201,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      CALCOM_API_KEY: "cal_x",
      CALCOM_EVENT_TYPES: '{"limpieza":100}',
      BOT_TIER: "pro",
    } as any;
    const tool = scheduleAppointmentTool(env, () => "conv_x");
    const result = (await tool.execute!(
      {
        servicio: "limpieza dental",
        startTime: "2026-06-01T17:00:00Z",
        attendeeName: "María",
        attendeeEmail: "maria@x.com",
      },
      {} as any,
    )) as { bookingId: number; status: string };
    expect(result.bookingId).toBe(12345);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v2/bookings");
    expect((init as any).headers.Authorization).toBe("Bearer cal_x");
    const body = JSON.parse((init as any).body);
    expect(body.eventTypeId).toBe(100);
  });

  it("dentalink_failed → calcom_failed cuando la API responde error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 400 })));
    const env = { CALCOM_API_KEY: "cal_x", CALCOM_EVENT_TYPE_ID: "1", BOT_TIER: "pro" } as any;
    const tool = scheduleAppointmentTool(env, () => "conv_x");
    const result = (await tool.execute!(
      { startTime: "2026-06-01T17:00:00Z", attendeeName: "María", attendeeEmail: "maria@x.com" },
      {} as any,
    )) as { error: string };
    expect(result.error).toBe("calcom_failed");
  });

  it("nunca declara éxito sin un booking id real — la API responde 2xx pero sin id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "success", data: {} }), { status: 201 })));
    const env = { CALCOM_API_KEY: "cal_x", CALCOM_EVENT_TYPE_ID: "1", BOT_TIER: "pro" } as any;
    const tool = scheduleAppointmentTool(env, () => "conv_x");
    const result = (await tool.execute!(
      { startTime: "2026-06-01T17:00:00Z", attendeeName: "María", attendeeEmail: "maria@x.com" },
      {} as any,
    )) as { error: string };
    expect(result.error).toBe("calcom_failed");
  });

  it("returns calcom_not_configured when no API key/event type", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = { BOT_TIER: "pro" } as any;
    const tool = scheduleAppointmentTool(env, () => "conv_x");
    const result = (await tool.execute!(
      { startTime: "2026-06-01T17:00:00Z", attendeeName: "María", attendeeEmail: "maria@x.com" },
      {} as any,
    )) as { error: string };
    expect(result.error).toBe("calcom_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
