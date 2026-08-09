import { describe, it, expect, vi, afterEach } from "vitest";
import { calcomAvailabilityTool } from "../../src/tools/calcomAvailability";

afterEach(() => vi.restoreAllMocks());

describe("calcomAvailabilityTool", () => {
  it("consulta horarios libres y los devuelve", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ status: "success", data: { "2026-07-20": [{ start: "2026-07-20T09:00:00.000Z" }] } }),
          { status: 200 },
        ),
      ),
    );
    const env = { CALCOM_API_KEY: "cal_x", CALCOM_EVENT_TYPE_ID: "10" } as any;
    const tool = calcomAvailabilityTool(env);
    const result = (await tool.execute!({ fecha: "2026-07-20" }, {} as any)) as {
      slots: string[];
      timezone: string;
    };
    expect(result.slots).toEqual(["2026-07-20T09:00:00.000Z"]);
  });

  it("elige el event type según el servicio pedido", async () => {
    const fetchMock = vi.fn(async (_url: any, _init: any) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { CALCOM_API_KEY: "cal_x", CALCOM_EVENT_TYPES: '{"corte":20}' } as any;
    const tool = calcomAvailabilityTool(env);
    await tool.execute!({ fecha: "2026-07-20", servicio: "quiero un corte" }, {} as any);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("eventTypeId=20");
  });

  it("calcom_not_configured si no hay event type resuelto", async () => {
    const env = {} as any;
    const tool = calcomAvailabilityTool(env);
    const result = (await tool.execute!({ fecha: "2026-07-20" }, {} as any)) as { error: string };
    expect(result.error).toBe("calcom_not_configured");
  });

  it("calcom_failed si la API falla", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const env = { CALCOM_API_KEY: "cal_x", CALCOM_EVENT_TYPE_ID: "10" } as any;
    const tool = calcomAvailabilityTool(env);
    const result = (await tool.execute!({ fecha: "2026-07-20" }, {} as any)) as { error: string };
    expect(result.error).toBe("calcom_failed");
  });
});
