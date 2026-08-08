import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dentalinkConfigured,
  dentalinkTimeZone,
  resolveDentistaId,
  resolveSucursalId,
  getAvailableSlots,
  findPatientByPhone,
  createPatient,
  findOrCreatePatient,
  createBooking,
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

describe("findPatientByPhone", () => {
  it("devuelve el id si Dentalink encuentra un paciente con ese teléfono", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 321, nombre: "Ana" }] }), { status: 200 })),
    );
    const res = await findPatientByPhone(env({ DENTALINK_API_TOKEN: "tok" }), "+56912345678");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patientId).toBe(321);
  });

  it("devuelve patientId null si no hay match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const res = await findPatientByPhone(env({ DENTALINK_API_TOKEN: "tok" }), "+56900000000");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patientId).toBeNull();
  });

  it("error si no hay token", async () => {
    const res = await findPatientByPhone(env(), "+56912345678");
    expect(res.ok).toBe(false);
  });
});

describe("createPatient", () => {
  it("crea el paciente y devuelve su id", async () => {
    const fetchMock = vi.fn(async (_url: any, _init: any) => new Response(JSON.stringify({ data: { id: 999 } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await createPatient(env({ DENTALINK_API_TOKEN: "tok" }), {
      nombre: "Ana Pérez",
      telefono: "+56912345678",
      email: "ana@example.com",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patientId).toBe(999);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/pacientes");
    expect((init as any).method).toBe("POST");
    const body = JSON.parse((init as any).body);
    expect(body).toEqual({ nombre: "Ana Pérez", telefono: "+56912345678", email: "ana@example.com" });
  });

  it("error http → ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    const res = await createPatient(env({ DENTALINK_API_TOKEN: "tok" }), { nombre: "X", telefono: "1" });
    expect(res.ok).toBe(false);
  });
});

describe("findOrCreatePatient", () => {
  it("reusa el paciente si ya existe (no llama a crear)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 42 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await findOrCreatePatient(env({ DENTALINK_API_TOKEN: "tok" }), { nombre: "Ana", telefono: "+56911111111" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patientId).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1); // solo la búsqueda, no creó
  });

  it("crea el paciente si la búsqueda no encuentra nada", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 })) // búsqueda vacía
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 77 } }), { status: 201 })); // creación
    vi.stubGlobal("fetch", fetchMock);
    const res = await findOrCreatePatient(env({ DENTALINK_API_TOKEN: "tok" }), { nombre: "Ana", telefono: "+56911111111" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patientId).toBe(77);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("createBooking", () => {
  it("busca/crea al paciente y crea la cita", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 42 }] }), { status: 200 })) // paciente existe
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 555 } }), { status: 201 })); // cita creada
    vi.stubGlobal("fetch", fetchMock);

    const res = await createBooking(env({ DENTALINK_API_TOKEN: "tok" }), {
      dentistaId: 9,
      sucursalId: 1,
      date: "2026-08-10",
      horaInicio: "09:00",
      horaFin: "09:30",
      nombrePaciente: "Ana Pérez",
      telefonoPaciente: "+56912345678",
      comentario: "Primera visita",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.citaId).toBe(555);
      expect(res.patientId).toBe(42);
    }

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain("/citas/");
    const body = JSON.parse((init as any).body);
    expect(body).toEqual({
      id_paciente: 42,
      id_dentista: 9,
      id_sucursal: 1,
      fecha: "2026-08-10",
      hora_inicio: "09:00",
      hora_fin: "09:30",
      comentario: "Primera visita",
    });
  });

  it("propaga el error si falla la búsqueda/creación del paciente", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    const res = await createBooking(env({ DENTALINK_API_TOKEN: "tok" }), {
      dentistaId: 9,
      sucursalId: 1,
      date: "2026-08-10",
      horaInicio: "09:00",
      horaFin: "09:30",
      nombrePaciente: "Ana",
      telefonoPaciente: "+56912345678",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("patient:");
  });

  it("error si no hay token", async () => {
    const res = await createBooking(env(), {
      dentistaId: 9,
      sucursalId: 1,
      date: "2026-08-10",
      horaInicio: "09:00",
      horaFin: "09:30",
      nombrePaciente: "Ana",
      telefonoPaciente: "+56912345678",
    });
    expect(res.ok).toBe(false);
  });
});
