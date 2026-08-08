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
