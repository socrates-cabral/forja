import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dentalinkConfigured,
  dentalinkTimeZone,
  resolveDentistaId,
  resolveSucursalId,
  getAvailableSlots,
  DEFAULT_TZ,
} from "../../src/integrations/dentalink";
import type { Env } from "../../src/env";

const env = (over: Partial<Env> = {}) => ({ ...over }) as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe("dentalinkConfigured", () => {
  it("false sin token", () => {
    expect(dentalinkConfigured(env({ DENTALINK_SUCURSAL_ID: "1", DENTALINK_DENTISTA_ID: "1" }))).toBe(false);
  });
  it("false sin sucursal", () => {
    expect(dentalinkConfigured(env({ DENTALINK_API_TOKEN: "tok", DENTALINK_DENTISTA_ID: "1" }))).toBe(false);
  });
  it("false sin dentista ni mapa", () => {
    expect(dentalinkConfigured(env({ DENTALINK_API_TOKEN: "tok", DENTALINK_SUCURSAL_ID: "1" }))).toBe(false);
  });
  it("true con token + sucursal + dentista", () => {
    expect(
      dentalinkConfigured(env({ DENTALINK_API_TOKEN: "tok", DENTALINK_SUCURSAL_ID: "1", DENTALINK_DENTISTA_ID: "9" })),
    ).toBe(true);
  });
  it("true con token + sucursal + mapa de dentistas", () => {
    expect(
      dentalinkConfigured(
        env({ DENTALINK_API_TOKEN: "tok", DENTALINK_SUCURSAL_ID: "1", DENTALINK_DENTISTA_MAP: '{"limpieza":9}' }),
      ),
    ).toBe(true);
  });
});

describe("dentalinkTimeZone", () => {
  it("default America/Santiago", () => {
    expect(dentalinkTimeZone(env())).toBe(DEFAULT_TZ);
  });
  it("respeta DENTALINK_TIMEZONE", () => {
    expect(dentalinkTimeZone(env({ DENTALINK_TIMEZONE: "America/Argentina/Buenos_Aires" }))).toBe(
      "America/Argentina/Buenos_Aires",
    );
  });
});

describe("resolveDentistaId", () => {
  it("usa el default numérico", () => {
    expect(resolveDentistaId(env({ DENTALINK_DENTISTA_ID: "42" }))).toBe(42);
  });
  it("hace match por palabra en el mapa", () => {
    const e = env({ DENTALINK_DENTISTA_MAP: '{"limpieza":10,"ortodoncia":20}' });
    expect(resolveDentistaId(e, "quiero agendar una limpieza")).toBe(10);
    expect(resolveDentistaId(e, "control de ortodoncia")).toBe(20);
  });
  it("sin match usa el primero del mapa", () => {
    expect(resolveDentistaId(env({ DENTALINK_DENTISTA_MAP: '{"limpieza":10}' }), "algo raro")).toBe(10);
  });
  it("null sin config", () => {
    expect(resolveDentistaId(env(), "limpieza")).toBeNull();
  });
});

describe("resolveSucursalId", () => {
  it("parsea el id numérico", () => {
    expect(resolveSucursalId(env({ DENTALINK_SUCURSAL_ID: "7" }))).toBe(7);
  });
  it("null sin config o inválido", () => {
    expect(resolveSucursalId(env())).toBeNull();
    expect(resolveSucursalId(env({ DENTALINK_SUCURSAL_ID: "abc" }))).toBeNull();
  });
});

describe("getAvailableSlots", () => {
  it("arma la URL, manda el header Token y filtra solo bloques libres (id_paciente=0)", async () => {
    const fetchMock = vi.fn(async (_url: any, _init: any) =>
      new Response(
        JSON.stringify({
          data: [
            { id_paciente: 0, hora_inicio: "09:00", hora_fin: "09:30", id_dentista: 9, fecha: "07/08/2026" },
            { id_paciente: 55, hora_inicio: "09:30", hora_fin: "10:00", id_dentista: 9, fecha: "07/08/2026" },
            { id_paciente: 0, hora_inicio: "10:00", hora_fin: "10:30", id_dentista: 9, fecha: "07/08/2026" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAvailableSlots(env({ DENTALINK_API_TOKEN: "tok" }), 9, 1, "2026-08-07");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.slots).toEqual([
        { horaInicio: "09:00", horaFin: "09:30" },
        { horaInicio: "10:00", horaFin: "10:30" },
      ]);
    }

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/sucursales/1/dentistas/9/agendas");
    expect(String(url)).toContain("fecha_inicio=2026-08-07");
    expect(String(url)).toContain("fecha_fin=2026-08-07");
    expect((init as any).headers.Authorization).toBe("Token tok");
  });

  it("acepta también una respuesta en array plano (forma alternativa no confirmada)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ id_paciente: 0, hora_inicio: "11:00", hora_fin: "11:30" }]), { status: 200 })),
    );
    const res = await getAvailableSlots(env({ DENTALINK_API_TOKEN: "tok" }), 9, 1, "2026-08-07");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.slots).toEqual([{ horaInicio: "11:00", horaFin: "11:30" }]);
  });

  it("devuelve error si la API falla", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const res = await getAvailableSlots(env({ DENTALINK_API_TOKEN: "tok" }), 9, 1, "2026-08-07");
    expect(res.ok).toBe(false);
  });

  it("no llama a la API sin token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await getAvailableSlots(env(), 9, 1, "2026-08-07");
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
