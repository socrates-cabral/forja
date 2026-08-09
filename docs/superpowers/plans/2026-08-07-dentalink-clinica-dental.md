# Integración Dentalink + Nicho Clínica Dental — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un "niche pack" de clínica dental (Chile) a Forja, con una tool Pro que agenda citas reales contra la API de Dentalink (el software de gestión dental líder en Chile), para poder ofrecer el bot a clínicas dentales en Santiago como producto de reventa.

**Architecture:** Forja ya separa integraciones externas (`src/integrations/`) de las tools que el LLM invoca (`src/tools/`) y de los "niche packs" que personalizan el prompt/dashboard (`src/niches/`). Este plan sigue exactamente ese patrón existente (mismo que `src/integrations/calcom.ts` + su test): un módulo de integración sin estado que habla HTTP con Dentalink, dos tools delgadas que lo envuelven con `ai`/`zod`, y un archivo de nicho que aporta el playbook y las columnas del dashboard. Cuando el dueño configura las credenciales de Dentalink, `buildTools` sustituye la tool genérica de Cal.com (`scheduleAppointment`) por las dos tools de Dentalink — son mutuamente excluyentes, una clínica no tiene ambas.

**Tech Stack:** TypeScript, Cloudflare Workers, `ai` SDK (`tool()` + `zod` para el schema), Vitest (mocks de `fetch` vía `vi.stubGlobal`/`global.fetch`), Dentalink REST API (`https://api.dentalink.healthatom.com/api/v1`, auth `Authorization: Token <token>`).

## Global Constraints

- Todo el código nuevo va en TypeScript strict, sin `any` salvo en tests (mismo estilo que `src/integrations/calcom.ts`).
- Todas las funciones de integración devuelven `{ ok: true; ... } | { ok: false; reason: string }` — nunca lanzan (`throw`) hacia la tool. Mismo contrato que `calcom.ts`.
- Ningún secreto se hardcodea. Todo llega vía `Env` (`src/env.ts`), seteado con `wrangler secret put` en producción.
- Comandos siempre desde la raíz del repo clonado: `C:\ClaudeWork\freelance\forja`.
- Test runner: `pnpm test` (= `vitest run`). Typecheck: `pnpm typecheck` (= `tsc --noEmit`).
- Los nombres de tools deben coincidir EXACTO entre `src/tools/*.ts`, su registro en `src/tools/index.ts`, y `PRO_ONLY_TOOLS` en `src/config.ts` — un desajuste deja la tool inaccesible sin error visible.
- **Riesgo documentado:** el body exacto de `POST /citas/` y `POST /pacientes` de Dentalink no está 100% publicado en su documentación pública (confirmado por scraping de `https://api.dentalink.healthatom.com/docs/` el 2026-08-07) — los nombres de campo usados aquí (`id_paciente`, `id_dentista`, `id_sucursal`, `fecha`, `hora_inicio`, `hora_fin`) están inferidos de la respuesta real de `GET /agendas` (que sí trae esos mismos nombres) y son el patrón más probable. El parsing de respuesta es defensivo (acepta array plano o `{data: [...]}`) para no romper si la forma real difiere. **Task 7 es el gate de verificación contra el sandbox real antes de ir a producción — no saltarla.**

---

## File Structure

```
src/env.ts                              MODIFICAR — 5 secrets nuevos de Dentalink
src/integrations/dentalink.ts           CREAR — cliente HTTP (config, disponibilidad, pacientes, citas)
test/integrations/dentalink.test.ts     CREAR — tests del cliente (fetch mockeado)
src/tools/dentalinkAvailability.ts      CREAR — tool: consulta horarios libres
test/tools/dentalinkAvailability.test.ts CREAR
src/tools/dentalinkAppointment.ts       CREAR — tool: agenda la cita
test/tools/dentalinkAppointment.test.ts CREAR
src/config.ts                           MODIFICAR — 2 tools nuevas en PRO_ONLY_TOOLS
src/tools/index.ts                      MODIFICAR — buildTools: swap Cal.com ↔ Dentalink
test/tools/index.test.ts                MODIFICAR — 1 test case nuevo
src/niches/dentista.ts                  CREAR — playbook + columnas del giro
src/niches/index.ts                     MODIFICAR — registrar el pack
test/niches.test.ts                     MODIFICAR — casos del nicho "dentista"
```

---

### Task 1: Cliente Dentalink — configuración y disponibilidad (lectura)

**Files:**
- Modify: `src/env.ts:73-77` (bloque de Cal.com, insertar después de `CALCOM_TIMEZONE`)
- Create: `src/integrations/dentalink.ts`
- Test: `test/integrations/dentalink.test.ts`

**Interfaces:**
- Produces: `dentalinkConfigured(env: Env): boolean`, `dentalinkTimeZone(env: Env): string`, `resolveDentistaId(env: Env, servicio?: string): number | null`, `resolveSucursalId(env: Env): number | null`, `getAvailableSlots(env: Env, dentistaId: number, sucursalId: number, date: string): Promise<{ ok: true; slots: { horaInicio: string; horaFin: string }[] } | { ok: false; reason: string }>`, `DEFAULT_TZ: string` — todo consumido por Task 3 (tool de disponibilidad) y por Task 2 (mismo archivo).

- [ ] **Step 1: Agregar los secrets de Dentalink a `Env`**

En `src/env.ts`, justo después de la línea `CALCOM_TIMEZONE?: string;` (línea 76) y antes de `GOOGLE_SERVICE_ACCOUNT_JSON?: string;`, insertar:

```ts
  // ── Dentalink (agenda real para el nicho "dentista") ─────────────────────
  // Con estas vars, el bot consulta disponibilidad real y agenda citas en
  // Dentalink (https://api.dentalink.healthatom.com). Mutuamente excluyente
  // con Cal.com: si Dentalink está configurado, buildTools() usa las tools
  // dentalinkAvailability/dentalinkAppointment en vez de scheduleAppointment.
  DENTALINK_API_TOKEN?: string;            // secret: token de la API (Authorization: Token <token>)
  DENTALINK_SUCURSAL_ID?: string;          // id numérico de la sucursal (como string)
  DENTALINK_DENTISTA_ID?: string;          // dentista por defecto (numérico, como string)
  DENTALINK_DENTISTA_MAP?: string;         // opcional: JSON {"limpieza":123,"ortodoncia":456} servicio→id_dentista
  DENTALINK_TIMEZONE?: string;             // zona horaria (default America/Santiago)
```

- [ ] **Step 2: Escribir el test que falla — configuración y zona horaria**

Crear `test/integrations/dentalink.test.ts`:

```ts
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
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `pnpm test test/integrations/dentalink.test.ts`
Expected: FAIL — `Cannot find module '../../src/integrations/dentalink'`

- [ ] **Step 4: Implementar `src/integrations/dentalink.ts` (parte 1: config + disponibilidad)**

```ts
import type { Env } from "../env";

// Cliente de la API de Dentalink (software de gestión dental líder en Chile).
// Docs: https://api.dentalink.healthatom.com/docs/
// Auth: header "Authorization: Token <access_token>" (NO "Bearer").

const DENTALINK_API = "https://api.dentalink.healthatom.com/api/v1";

export const DEFAULT_TZ = "America/Santiago";

/** ¿El dueño ya conectó Dentalink? (token + sucursal + al menos un dentista). */
export function dentalinkConfigured(env: Env): boolean {
  return Boolean(
    env.DENTALINK_API_TOKEN &&
      env.DENTALINK_SUCURSAL_ID &&
      (env.DENTALINK_DENTISTA_ID || env.DENTALINK_DENTISTA_MAP),
  );
}

export function dentalinkTimeZone(env: Env): string {
  return (env.DENTALINK_TIMEZONE || "").trim() || DEFAULT_TZ;
}

/**
 * Resuelve el id_dentista para un servicio. Si hay un mapa DENTALINK_DENTISTA_MAP,
 * busca por coincidencia de palabra (case-insensitive); si no, usa el default.
 */
export function resolveDentistaId(env: Env, servicio?: string): number | null {
  const map = parseIdMap(env.DENTALINK_DENTISTA_MAP);
  if (map && servicio) {
    const s = servicio.toLowerCase();
    for (const [key, id] of Object.entries(map)) {
      if (s.includes(key.toLowerCase())) return id;
    }
  }
  if (map) {
    const first = Object.values(map)[0];
    if (typeof first === "number") return first;
  }
  const def = Number(env.DENTALINK_DENTISTA_ID);
  return Number.isFinite(def) && def > 0 ? def : null;
}

export function resolveSucursalId(env: Env): number | null {
  const n = Number(env.DENTALINK_SUCURSAL_ID);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseIdMap(raw?: string): Record<string, number> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

interface DentalinkSlot {
  id_paciente: number;
  hora_inicio: string;
  hora_fin: string;
}

/** Lee `data` si viene envuelto en {data: [...]}, o el array directo si no. */
function extractList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const raw = (body as { data?: unknown } | null)?.data;
  return Array.isArray(raw) ? (raw as T[]) : [];
}

/**
 * Horarios libres de un dentista/sucursal para una fecha (YYYY-MM-DD).
 * Un bloque está libre cuando id_paciente === 0 (visto en la respuesta real
 * de GET /agendas: bloques ocupados traen el id del paciente agendado).
 */
export async function getAvailableSlots(
  env: Env,
  dentistaId: number,
  sucursalId: number,
  date: string,
): Promise<{ ok: true; slots: { horaInicio: string; horaFin: string }[] } | { ok: false; reason: string }> {
  if (!env.DENTALINK_API_TOKEN) return { ok: false, reason: "not_configured" };
  const url = `${DENTALINK_API}/sucursales/${sucursalId}/dentistas/${dentistaId}/agendas?fecha_inicio=${date}&fecha_fin=${date}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Token ${env.DENTALINK_API_TOKEN}` } });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = await res.json();
    const slots = extractList<DentalinkSlot>(body)
      .filter((s) => s.id_paciente === 0)
      .map((s) => ({ horaInicio: s.hora_inicio, horaFin: s.hora_fin }));
    return { ok: true, slots };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `pnpm test test/integrations/dentalink.test.ts`
Expected: PASS (todos los `describe` de este step — `getAvailableSlots` y anteriores)

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 7: Commit**

```bash
git add src/env.ts src/integrations/dentalink.ts test/integrations/dentalink.test.ts
git commit -m "feat(dentalink): cliente de disponibilidad — config, resolve ids, getAvailableSlots"
```

---

### Task 2: Cliente Dentalink — pacientes y creación de cita (escritura)

**Files:**
- Modify: `src/integrations/dentalink.ts` (agregar al final del archivo)
- Modify: `test/integrations/dentalink.test.ts` (agregar al final del archivo)

**Interfaces:**
- Consumes: nada nuevo de otras tasks — usa el mismo archivo de Task 1.
- Produces: `findPatientByPhone(env: Env, telefono: string): Promise<{ ok: true; patientId: number | null } | { ok: false; reason: string }>`, `createPatient(env: Env, args: { nombre: string; telefono: string; email?: string }): Promise<{ ok: true; patientId: number } | { ok: false; reason: string }>`, `findOrCreatePatient(env: Env, args: { nombre: string; telefono: string; email?: string }): Promise<{ ok: true; patientId: number } | { ok: false; reason: string }>`, `createBooking(env: Env, args: { dentistaId: number; sucursalId: number; date: string; horaInicio: string; horaFin: string; nombrePaciente: string; telefonoPaciente: string; emailPaciente?: string; comentario?: string }): Promise<{ ok: true; citaId: number; patientId: number } | { ok: false; reason: string }>` — todo consumido por Task 4 (tool de agendamiento).

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `test/integrations/dentalink.test.ts`:

```ts
import { findPatientByPhone, createPatient, findOrCreatePatient, createBooking } from "../../src/integrations/dentalink";

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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: 999 } }), { status: 201 }));
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
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm test test/integrations/dentalink.test.ts`
Expected: FAIL — `findPatientByPhone`/`createPatient`/`findOrCreatePatient`/`createBooking` no exportados

- [ ] **Step 3: Implementar la parte 2 en `src/integrations/dentalink.ts`**

Agregar al final del archivo:

```ts
interface DentalinkPatientMatch {
  id: number;
}

/** Busca un paciente existente por teléfono. patientId: null si no hay match. */
export async function findPatientByPhone(
  env: Env,
  telefono: string,
): Promise<{ ok: true; patientId: number | null } | { ok: false; reason: string }> {
  if (!env.DENTALINK_API_TOKEN) return { ok: false, reason: "not_configured" };
  const url = `${DENTALINK_API}/pacientes/buscar?telefono=${encodeURIComponent(telefono)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Token ${env.DENTALINK_API_TOKEN}` } });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = await res.json();
    const list = extractList<DentalinkPatientMatch>(body);
    return { ok: true, patientId: list[0]?.id ?? null };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/** Crea un paciente nuevo en Dentalink. */
export async function createPatient(
  env: Env,
  args: { nombre: string; telefono: string; email?: string },
): Promise<{ ok: true; patientId: number } | { ok: false; reason: string }> {
  if (!env.DENTALINK_API_TOKEN) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(`${DENTALINK_API}/pacientes`, {
      method: "POST",
      headers: { Authorization: `Token ${env.DENTALINK_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: args.nombre,
        telefono: args.telefono,
        ...(args.email ? { email: args.email } : {}),
      }),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = (await res.json()) as { data?: { id: number }; id?: number };
    const id = body.data?.id ?? body.id;
    if (!id) return { ok: false, reason: "no_patient_id" };
    return { ok: true, patientId: id };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/** Reusa el paciente si ya existe por teléfono; si no, lo crea. */
export async function findOrCreatePatient(
  env: Env,
  args: { nombre: string; telefono: string; email?: string },
): Promise<{ ok: true; patientId: number } | { ok: false; reason: string }> {
  const found = await findPatientByPhone(env, args.telefono);
  if (!found.ok) return found;
  if (found.patientId) return { ok: true, patientId: found.patientId };
  return createPatient(env, args);
}

/** Busca/crea al paciente y agenda la cita. */
export async function createBooking(
  env: Env,
  args: {
    dentistaId: number;
    sucursalId: number;
    date: string;
    horaInicio: string;
    horaFin: string;
    nombrePaciente: string;
    telefonoPaciente: string;
    emailPaciente?: string;
    comentario?: string;
  },
): Promise<{ ok: true; citaId: number; patientId: number } | { ok: false; reason: string }> {
  if (!env.DENTALINK_API_TOKEN) return { ok: false, reason: "not_configured" };
  const patient = await findOrCreatePatient(env, {
    nombre: args.nombrePaciente,
    telefono: args.telefonoPaciente,
    email: args.emailPaciente,
  });
  if (!patient.ok) return { ok: false, reason: `patient:${patient.reason}` };
  try {
    const res = await fetch(`${DENTALINK_API}/citas/`, {
      method: "POST",
      headers: { Authorization: `Token ${env.DENTALINK_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id_paciente: patient.patientId,
        id_dentista: args.dentistaId,
        id_sucursal: args.sucursalId,
        fecha: args.date,
        hora_inicio: args.horaInicio,
        hora_fin: args.horaFin,
        ...(args.comentario ? { comentario: args.comentario } : {}),
      }),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = (await res.json()) as { data?: { id: number }; id?: number };
    const citaId = body.data?.id ?? body.id;
    if (!citaId) return { ok: false, reason: "no_cita_id" };
    return { ok: true, citaId, patientId: patient.patientId };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm test test/integrations/dentalink.test.ts`
Expected: PASS (todos)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 6: Commit**

```bash
git add src/integrations/dentalink.ts test/integrations/dentalink.test.ts
git commit -m "feat(dentalink): pacientes (buscar/crear) y createBooking"
```

---

### Task 3: Tool `dentalinkAvailability`

**Files:**
- Create: `src/tools/dentalinkAvailability.ts`
- Test: `test/tools/dentalinkAvailability.test.ts`
- Modify: `src/config.ts:14-17` (`PRO_ONLY_TOOLS`)

**Interfaces:**
- Consumes: `getAvailableSlots`, `resolveDentistaId`, `resolveSucursalId`, `dentalinkTimeZone` de `src/integrations/dentalink.ts` (Task 1).
- Produces: `dentalinkAvailabilityTool(env: Env)` — factory que devuelve una tool `ai`, consumida por Task 5 (`buildTools`).

- [ ] **Step 1: Escribir el test que falla**

Crear `test/tools/dentalinkAvailability.test.ts`:

```ts
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
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/dentistas/20/");
  });

  it("dentalink_not_configured si no hay dentista resuelto", async () => {
    const env = { DENTALINK_SUCURSAL_ID: "1" } as any;
    const tool = dentalinkAvailabilityTool(env);
    const result = (await tool.execute!({ fecha: "2026-08-10" }, {} as any)) as { error: string };
    expect(result.error).toBe("dentalink_not_configured");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test test/tools/dentalinkAvailability.test.ts`
Expected: FAIL — módulo no existe

- [ ] **Step 3: Implementar `src/tools/dentalinkAvailability.ts`**

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { getAvailableSlots, resolveDentistaId, resolveSucursalId, dentalinkTimeZone } from "../integrations/dentalink";

export function dentalinkAvailabilityTool(env: Env) {
  return tool({
    description:
      "Consulta horarios disponibles en la clínica dental (Dentalink) para un servicio y fecha. " +
      "Úsala SIEMPRE antes de dentalinkAppointment — nunca ofrezcas un horario sin haberlo confirmado libre aquí.",
    inputSchema: z.object({
      fecha: z.string().describe("Fecha a consultar, formato YYYY-MM-DD"),
      servicio: z
        .string()
        .optional()
        .describe("Tipo de tratamiento (ej. 'limpieza', 'ortodoncia'), para elegir al dentista correcto"),
    }),
    execute: async ({ fecha, servicio }) => {
      const dentistaId = resolveDentistaId(env, servicio);
      const sucursalId = resolveSucursalId(env);
      if (!dentistaId || !sucursalId) return { error: "dentalink_not_configured" as const };
      const result = await getAvailableSlots(env, dentistaId, sucursalId, fecha);
      if (!result.ok) return { error: "dentalink_failed" as const, reason: result.reason };
      return { fecha, slots: result.slots, timezone: dentalinkTimeZone(env) };
    },
  });
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm test test/tools/dentalinkAvailability.test.ts`
Expected: PASS

- [ ] **Step 5: Registrar la tool en `PRO_ONLY_TOOLS`**

En `src/config.ts`, reemplazar:

```ts
export const PRO_ONLY_TOOLS = [
  "scheduleAppointment",
  "catalogQuery",
] as const;
```

por:

```ts
export const PRO_ONLY_TOOLS = [
  "scheduleAppointment",
  "catalogQuery",
  "dentalinkAvailability",
  "dentalinkAppointment",
] as const;
```

(`dentalinkAppointment` se usa recién en Task 4, pero se agrega aquí junto a su hermana para no tocar este array dos veces.)

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 7: Commit**

```bash
git add src/tools/dentalinkAvailability.ts test/tools/dentalinkAvailability.test.ts src/config.ts
git commit -m "feat(dentalink): tool dentalinkAvailability + registro en PRO_ONLY_TOOLS"
```

---

### Task 4: Tool `dentalinkAppointment`

**Files:**
- Create: `src/tools/dentalinkAppointment.ts`
- Test: `test/tools/dentalinkAppointment.test.ts`

**Interfaces:**
- Consumes: `createBooking`, `resolveDentistaId`, `resolveSucursalId` de `src/integrations/dentalink.ts` (Tasks 1-2).
- Produces: `dentalinkAppointmentTool(env: Env, getConversationId: () => string | null)` — factory que devuelve una tool `ai`, consumida por Task 5 (`buildTools`). Firma idéntica a `scheduleAppointmentTool` para mantener el mismo patrón de registro.

- [ ] **Step 1: Escribir el test que falla**

Crear `test/tools/dentalinkAppointment.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { dentalinkAppointmentTool } from "../../src/tools/dentalinkAppointment";

describe("dentalinkAppointmentTool", () => {
  it("agenda la cita vía Dentalink", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 })) // no existe el paciente
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 77 } }), { status: 201 })) // paciente creado
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 555 } }), { status: 201 })) as any; // cita creada

    const env = { DENTALINK_API_TOKEN: "tok", DENTALINK_SUCURSAL_ID: "1", DENTALINK_DENTISTA_ID: "9" } as any;
    const tool = dentalinkAppointmentTool(env, () => "conv_x");
    const result = (await tool.execute!(
      {
        fecha: "2026-08-10",
        horaInicio: "09:00",
        horaFin: "09:30",
        nombrePaciente: "Ana Pérez",
        telefonoPaciente: "+56912345678",
      },
      {} as any,
    )) as { citaId: number; patientId: number };
    expect(result.citaId).toBe(555);
    expect(result.patientId).toBe(77);
  });

  it("dentalink_not_configured si falta la sucursal/dentista", async () => {
    const env = { DENTALINK_API_TOKEN: "tok" } as any;
    const tool = dentalinkAppointmentTool(env, () => "conv_x");
    const result = (await tool.execute!(
      {
        fecha: "2026-08-10",
        horaInicio: "09:00",
        horaFin: "09:30",
        nombrePaciente: "Ana",
        telefonoPaciente: "+56912345678",
      },
      {} as any,
    )) as { error: string };
    expect(result.error).toBe("dentalink_not_configured");
  });

  it("dentalink_failed si la API falla", async () => {
    global.fetch = vi.fn(async () => new Response("bad", { status: 500 })) as any;
    const env = { DENTALINK_API_TOKEN: "tok", DENTALINK_SUCURSAL_ID: "1", DENTALINK_DENTISTA_ID: "9" } as any;
    const tool = dentalinkAppointmentTool(env, () => "conv_x");
    const result = (await tool.execute!(
      {
        fecha: "2026-08-10",
        horaInicio: "09:00",
        horaFin: "09:30",
        nombrePaciente: "Ana",
        telefonoPaciente: "+56912345678",
      },
      {} as any,
    )) as { error: string };
    expect(result.error).toBe("dentalink_failed");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test test/tools/dentalinkAppointment.test.ts`
Expected: FAIL — módulo no existe

- [ ] **Step 3: Implementar `src/tools/dentalinkAppointment.ts`**

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { createBooking, resolveDentistaId, resolveSucursalId } from "../integrations/dentalink";

export function dentalinkAppointmentTool(env: Env, _getConversationId: () => string | null) {
  return tool({
    description:
      "Agenda una cita real en la clínica dental (Dentalink). Llama SIEMPRE a dentalinkAvailability antes " +
      "para confirmar que el horario está libre — nunca ofrezcas ni agendes un horario sin haberlo consultado.",
    inputSchema: z.object({
      fecha: z.string().describe("YYYY-MM-DD"),
      horaInicio: z.string().describe("HH:MM — debe ser un horario confirmado libre por dentalinkAvailability"),
      horaFin: z.string().describe("HH:MM"),
      nombrePaciente: z.string(),
      telefonoPaciente: z.string(),
      emailPaciente: z.string().email().optional(),
      servicio: z.string().optional().describe("Tipo de tratamiento, para elegir al dentista correcto"),
      comentario: z.string().optional(),
    }),
    execute: async ({ fecha, horaInicio, horaFin, nombrePaciente, telefonoPaciente, emailPaciente, servicio, comentario }) => {
      const dentistaId = resolveDentistaId(env, servicio);
      const sucursalId = resolveSucursalId(env);
      if (!dentistaId || !sucursalId) return { error: "dentalink_not_configured" as const };
      const result = await createBooking(env, {
        dentistaId,
        sucursalId,
        date: fecha,
        horaInicio,
        horaFin,
        nombrePaciente,
        telefonoPaciente,
        emailPaciente,
        comentario,
      });
      if (!result.ok) return { error: "dentalink_failed" as const, reason: result.reason };
      return { citaId: result.citaId, patientId: result.patientId };
    },
  });
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm test test/tools/dentalinkAppointment.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 6: Commit**

```bash
git add src/tools/dentalinkAppointment.ts test/tools/dentalinkAppointment.test.ts
git commit -m "feat(dentalink): tool dentalinkAppointment"
```

---

### Task 5: Wiring en `buildTools` — swap Cal.com ↔ Dentalink

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `test/tools/index.test.ts`

**Interfaces:**
- Consumes: `dentalinkConfigured` (Task 1), `dentalinkAvailabilityTool` (Task 3), `dentalinkAppointmentTool` (Task 4).

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `test/tools/index.test.ts` (dentro del `describe("buildTools", ...)` ya existente, como nuevo `it`):

```ts
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
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test test/tools/index.test.ts`
Expected: FAIL — hoy `scheduleAppointment` sigue registrado sin importar Dentalink; `dentalinkAvailability`/`dentalinkAppointment` no existen en el resultado.

- [ ] **Step 3: Modificar `buildTools` en `src/tools/index.ts`**

Reemplazar el archivo completo por:

```ts
import type { Env } from "../env";
import { isPro } from "../config";
import { searchKbTool } from "./searchKb";
import { handoffHumanTool } from "./handoffHuman";
import { pauseBotTool } from "./pauseBot";
import { snoozeUserTool } from "./snoozeUser";
import { captureLeadTool } from "./captureLead";
import { scheduleAppointmentTool } from "./scheduleAppointment";
import { catalogQueryTool } from "./catalogQuery";
import { dentalinkAvailabilityTool } from "./dentalinkAvailability";
import { dentalinkAppointmentTool } from "./dentalinkAppointment";
import { dentalinkConfigured } from "../integrations/dentalink";

export interface ToolContext {
  env: Env;
  getConversationId: () => string | null;
}

export function buildTools(ctx: ToolContext) {
  // Free tier base set. captureLead va aquí a propósito: el bot Starter (free)
  // captura prospectos — es el valor central de un bot de ventas. Lo Pro son las
  // tools más avanzadas por nicho (agendar citas, consultar catálogo/inventario).
  const tools: Record<string, any> = {
    searchKb: searchKbTool(ctx.env),
    handoffHuman: handoffHumanTool(ctx.env, ctx.getConversationId),
    pauseBot: pauseBotTool(ctx.env, ctx.getConversationId),
    snoozeUser: snoozeUserTool(ctx.env, ctx.getConversationId),
    captureLead: captureLeadTool(ctx.env, ctx.getConversationId),
  };

  // Pro tier additions
  if (isPro(ctx.env)) {
    tools.catalogQuery = catalogQueryTool(ctx.env);

    // Agenda de citas: Dentalink y Cal.com son mutuamente excluyentes — una
    // clínica que configuró Dentalink no necesita (ni debe ver) la tool
    // genérica de Cal.com, y viceversa.
    if (dentalinkConfigured(ctx.env)) {
      tools.dentalinkAvailability = dentalinkAvailabilityTool(ctx.env);
      tools.dentalinkAppointment = dentalinkAppointmentTool(ctx.env, ctx.getConversationId);
    } else {
      tools.scheduleAppointment = scheduleAppointmentTool(ctx.env, ctx.getConversationId);
    }
  }

  return tools;
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm test test/tools/index.test.ts`
Expected: PASS (incluye el caso nuevo Y los 3 casos existentes sin cambios — el flujo sin Dentalink configurado sigue registrando `scheduleAppointment` igual que antes)

- [ ] **Step 5: Correr toda la suite (nada debe haberse roto)**

Run: `pnpm test`
Expected: PASS — todos los tests, incluidos los de Tasks 1-4

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 7: Commit**

```bash
git add src/tools/index.ts test/tools/index.test.ts
git commit -m "feat(dentalink): buildTools alterna Dentalink/Cal.com según configuración"
```

---

### Task 6: Niche pack "dentista"

**Files:**
- Create: `src/niches/dentista.ts`
- Modify: `src/niches/index.ts`
- Modify: `test/niches.test.ts`

**Interfaces:**
- Consumes: `NichePack` type de `src/niches/types.ts` (ya existente).
- Produces: `dentista: NichePack`, registrado en `PACKS["dentista"]` — consumido por `getNiche(env)` cuando `env.BOT_NICHE === "dentista"`, que a su vez alimenta `resolveAgentConfig` (`src/settings-loader.ts:91,115`, ya existente, sin cambios) y las vistas del admin (`src/admin/views/*.ts`, ya existentes, sin cambios — leen `getNiche(env)` genéricamente).

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `test/niches.test.ts`:

```ts
describe("getNiche — dentista", () => {
  it("BOT_NICHE=dentista resuelve el pack de clínica dental", () => {
    const n = getNiche(envWith("dentista"));
    expect(n.id).toBe("dentista");
    expect(n.navLabel).toBe("Pacientes");
    expect(n.recordSingular).toBe("Paciente");
    expect(n.statusLabels.sold).toBe("Cita agendada");
    expect(n.columns.map((c) => c.key)).toEqual(["tratamiento", "prevision", "fecha_cita"]);
    expect(n.playbook).toContain("Previsión primero");
    expect(n.defaultTone).toBe("cercano y tranquilizador");
    expect(n.kbDocs.length).toBeGreaterThan(0);
  });

  it("normaliza mayúsculas/espacios (DENTISTA, ' dentista ')", () => {
    expect(getNiche(envWith("DENTISTA")).id).toBe("dentista");
    expect(getNiche(envWith(" dentista ")).id).toBe("dentista");
  });
});

describe("cableado del playbook de dentista al prompt", () => {
  it("inyecta el playbook del giro en el system prompt", () => {
    const env = envWith("dentista");
    const prompt = systemPromptFromEnv(env, ["searchKb", "dentalinkAvailability"], "ctx", getNiche(env).playbook || undefined);
    expect(prompt).toContain("<diagnostic_playbooks>");
    expect(prompt).toContain("Urgencia dental");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test test/niches.test.ts`
Expected: FAIL — `getNiche(envWith("dentista")).id` es `"generico"` (nicho desconocido cae al default)

- [ ] **Step 3: Implementar `src/niches/dentista.ts`**

```ts
import type { NichePack } from "./types";

// Nicho para clínicas dentales en Chile. Playbook cubre lo específico del
// giro: previsión (Fonasa/Isapre/particular) y triage de urgencias — dos
// cosas que un bot genérico se pierde y que sí cambian el precio/la prioridad
// de atención.
export const dentista: NichePack = {
  id: "dentista",
  recordSingular: "Paciente",
  recordPlural: "Pacientes",
  navLabel: "Pacientes",
  navIcon: "stethoscope",
  kpiLabel: "Pacientes captados",
  statusLabels: {
    new: "Nuevo contacto",
    contacted: "Contactado",
    sold: "Cita agendada",
    lost: "No agendó",
  },
  columns: [
    { key: "tratamiento", label: "Tratamiento" },
    { key: "prevision", label: "Previsión" },
    { key: "fecha_cita", label: "Fecha cita" },
  ],
  playbook: `<diagnostic_playbooks>
Eres el asistente de una clínica dental en Chile. Reglas del giro:

1. **Previsión primero**: si el paciente no menciona su previsión (Fonasa, Isapre o
   particular), pregúntala antes de cotizar — el precio y la cobertura cambian según
   eso. Nunca asumas particular por default.
2. **Urgencia dental**: dolor agudo, sangrado que no para, trauma o diente caído/quebrado
   → NO agendes como consulta normal. Ofrece la hora más próxima disponible y, si no hay
   cupo hoy, escala con handoffHuman marcando urgencia — estos casos no esperan a mañana.
3. **Primera visita vs control**: si es la primera vez del paciente en la clínica, dilo
   al agendar — una primera consulta con diagnóstico dura más que un control, y el
   dentista necesita saberlo para bloquear el tiempo correcto.
4. **Antes de agendar, confirma disponibilidad real**: usa dentalinkAvailability con la
   fecha y el servicio ANTES de ofrecer un horario. Nunca inventes un horario "libre"
   sin haberlo consultado.
5. **Datos mínimos para agendar**: nombre completo, teléfono de contacto, tratamiento,
   y fecha/hora elegida de los horarios reales que devolvió dentalinkAvailability. El
   email es opcional pero pídelo si el paciente lo da fácil (sirve para el recordatorio).
6. **No prometas resultados clínicos** ("te va a doler poco", "en una sesión queda
   listo") — eso lo evalúa el dentista en la consulta, no el bot.
</diagnostic_playbooks>`,
  defaultTone: "cercano y tranquilizador",
  kbDocs: [
    "Lista de tratamientos y precios (particular / Fonasa / convenios Isapre)",
    "Protocolo de urgencias dentales y horario de atención de urgencia",
    "Convenios vigentes con Isapres",
    "Política de cancelación / reagendamiento",
  ],
};
```

- [ ] **Step 4: Registrar el pack en `src/niches/index.ts`**

```ts
import type { Env } from "../env";
import type { NichePack } from "./types";
import { generico } from "./generico";
import { dentista } from "./dentista";

export type { NichePack, NicheColumn } from "./types";

// Registro de packs. Agregar un nicho = importar su archivo y sumarlo aquí.
const PACKS: Record<string, NichePack> = {
  generico,
  dentista,
};

/** Resuelve el pack activo desde BOT_NICHE. Nicho ausente/desconocido → genérico. */
export function getNiche(env: Env): NichePack {
  const id = (env.BOT_NICHE ?? "").trim().toLowerCase();
  return PACKS[id] ?? generico;
}
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `pnpm test test/niches.test.ts`
Expected: PASS (incluye los casos preexistentes de `generico`, sin cambios)

- [ ] **Step 6: Correr toda la suite**

Run: `pnpm test`
Expected: PASS — toda la suite, incluidas Tasks 1-5

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 8: Commit**

```bash
git add src/niches/dentista.ts src/niches/index.ts test/niches.test.ts
git commit -m "feat(niche): pack dentista — previsión, triage de urgencia, playbook Chile"
```

---

### Task 7: Verificación manual contra el sandbox real de Dentalink (gate antes de producción)

No es código — es el paso que cierra el riesgo documentado en **Global Constraints**: los nombres de campo de `POST /citas/` y `POST /pacientes` están inferidos, no confirmados 1:1 contra la doc oficial. Antes de vender esto a una clínica real:

- [ ] **Step 1: Conseguir credenciales de sandbox/trial de Dentalink**

Contactar a soporte de Dentalink (ver `https://www.softwaredentalink.com/planes` o `api@softwaredentalink.com`, confirmar el contacto exacto en `https://api.dentalink.healthatom.com/docs/`) y pedir un token de prueba con una sucursal y un dentista de test.

- [ ] **Step 2: Confirmar el body real de `POST /citas/` con curl**

```bash
curl -s -X POST "https://api.dentalink.healthatom.com/api/v1/citas/" \
  -H "Authorization: Token <TOKEN_SANDBOX>" \
  -H "Content-Type: application/json" \
  -d '{"id_paciente": <ID_PACIENTE_TEST>, "id_dentista": <ID>, "id_sucursal": <ID>, "fecha": "2026-08-15", "hora_inicio": "09:00", "hora_fin": "09:30", "comentario": "test"}' | jq .
```

Si el nombre de algún campo difiere (por ejemplo si Dentalink espera `hora` en vez de `hora_inicio`/`hora_fin`, o un formato de fecha distinto a `YYYY-MM-DD`), ajustar el `body` en `createBooking` (`src/integrations/dentalink.ts`, Task 2) y su test correspondiente.

- [ ] **Step 3: Confirmar el body real de `POST /pacientes` con curl**

```bash
curl -s -X POST "https://api.dentalink.healthatom.com/api/v1/pacientes" \
  -H "Authorization: Token <TOKEN_SANDBOX>" \
  -H "Content-Type: application/json" \
  -d '{"nombre": "Test Paciente", "telefono": "+56900000000", "email": "test@example.com"}' | jq .
```

Ajustar `createPatient` si algún campo requerido falta (ej. Dentalink podría pedir `apellidos` por separado de `nombre`, o `rut`).

- [ ] **Step 4: Confirmar la forma real de la respuesta de `GET /agendas`**

```bash
curl -s "https://api.dentalink.healthatom.com/api/v1/sucursales/<ID_SUCURSAL>/dentistas/<ID_DENTISTA>/agendas?fecha_inicio=2026-08-15&fecha_fin=2026-08-15" \
  -H "Authorization: Token <TOKEN_SANDBOX>" | jq .
```

Confirmar si viene envuelta en `{"data": [...]}` (como se implementó) o en otra forma — el parser de `extractList()` en `src/integrations/dentalink.ts` ya acepta ambas, pero confirmar igual evita sorpresas con paginación (`links`/`meta`) que no está manejada.

- [ ] **Step 5: Ajustar y re-correr la suite si algo cambió**

Si algún paso anterior encontró una diferencia, corregir el código de integración (Tasks 1-2) y sus tests (mismos archivos), luego:

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit (si hubo ajustes)**

```bash
git add src/integrations/dentalink.ts test/integrations/dentalink.test.ts
git commit -m "fix(dentalink): ajustar contrato real de la API tras verificar en sandbox"
```

---

## Self-Review

**Spec coverage:**
- Integración con Dentalink (disponibilidad + agendamiento) → Tasks 1, 2, 3, 4, 7.
- Tools Pro correctamente gateadas y excluyentes con Cal.com → Task 5.
- Nicho "dentista" con contexto de Chile (previsión, urgencias) → Task 6.
- Riesgo de contrato de API no confirmado → declarado en Global Constraints + cerrado en Task 7.

**Placeholder scan:** sin TBD/TODO ni "similar a la task N" — cada paso trae el código completo.

**Type consistency:** `dentalinkConfigured`, `resolveDentistaId`, `resolveSucursalId`, `dentalinkTimeZone`, `getAvailableSlots`, `findPatientByPhone`, `createPatient`, `findOrCreatePatient`, `createBooking` se usan con la misma firma en Task 1/2 (definición) y Tasks 3/4/5 (consumo) — verificado.
