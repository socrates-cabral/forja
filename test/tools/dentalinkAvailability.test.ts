import { describe, it, expect, vi } from "vitest";
import { dentalinkAvailabilityTool } from "../../src/tools/dentalinkAvailability";

describe("dentalinkAvailabilityTool", () => {
  it("consulta horarios libres y los devuelve", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id_paciente: 0, hora_inicio: "09:00", hora_fin: "09:30" }] }), {
          status: 200,
        }),
    ) as any;
    const env = {
      DENTALINK_API_TOKEN: "tok",
      DENTALINK_SUCURSAL_ID: "1",
      DENTALINK_DENTISTA_ID: "9",
    } as any;
    const tool = dentalinkAvailabilityTool(env);
    const result = (await tool.execute!({ fecha: "2026-08-10" }, {} as any)) as {
      slots: { horaInicio: string; horaFin: string }[];
      timezone: string;
    };
    expect(result.slots).toEqual([{ horaInicio: "09:00", horaFin: "09:30" }]);
    expect(result.timezone).toBe("America/Santiago");
  });

  it("elige el dentista según el servicio pedido", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    global.fetch = fetchMock as any;
    const env = {
      DENTALINK_API_TOKEN: "tok",
      DENTALINK_SUCURSAL_ID: "1",
      DENTALINK_DENTISTA_MAP: '{"ortodoncia":20}',
    } as any;
    const tool = dentalinkAvailabilityTool(env);
    await tool.execute!({ fecha: "2026-08-10", servicio: "control de ortodoncia" }, {} as any);
    const [url] = (fetchMock.mock.calls as any)[0];
    expect(String(url)).toContain("/dentistas/20/");
  });

  it("dentalink_not_configured si no hay dentista resuelto", async () => {
    const env = { DENTALINK_SUCURSAL_ID: "1" } as any;
    const tool = dentalinkAvailabilityTool(env);
    const result = (await tool.execute!({ fecha: "2026-08-10" }, {} as any)) as { error: string };
    expect(result.error).toBe("dentalink_not_configured");
  });
});
