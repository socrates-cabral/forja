import type { Env } from "../env";

// Cliente de la API de Dentalink (software de gestión dental líder en Chile).
// Docs: https://api.dentalink.healthatom.com/docs/
// Auth: header "Authorization: Token <access_token>" (NO "Bearer").

const DENTALINK_API = "https://api.dentalink.healthatom.com/api/v1";

export const DEFAULT_TZ = "America/Santiago";

/**
 * ¿El dueño ya conectó Dentalink? (token + sucursal + al menos un dentista).
 *
 * Valida que los valores REALMENTE parseen, no solo que la variable exista: si
 * DENTALINK_SUCURSAL_ID trae un typo no numérico (o el mapa de dentistas es JSON
 * roto), buildTools sacaría scheduleAppointment sin dejar nada funcional en su
 * lugar — la clínica quedaría sin ninguna herramienta de agendamiento.
 * (Las function declarations se hoistean: resolveSucursalId/resolveDentistaId
 * están declaradas más abajo en este mismo archivo.)
 */
export function dentalinkConfigured(env: Env): boolean {
  return Boolean(env.DENTALINK_API_TOKEN) && resolveSucursalId(env) !== null && resolveDentistaId(env) !== null;
}

export function dentalinkTimeZone(env: Env): string {
  return (env.DENTALINK_TIMEZONE || "").trim() || DEFAULT_TZ;
}

/**
 * Resuelve el id_dentista para un servicio. Prioridad:
 *   1. coincidencia de palabra en DENTALINK_DENTISTA_MAP (case-insensitive);
 *   2. DENTALINK_DENTISTA_ID — el default que el dueño configuró explícitamente;
 *   3. el primer valor del mapa (último recurso: depende del orden de claves JSON).
 *
 * El orden importa: si el tratamiento no matchea ninguna clave del mapa, caer al
 * "primero del mapa" agenda con el especialista equivocado según el orden en que
 * quedaron escritas las claves. El default configurado gana.
 */
export function resolveDentistaId(env: Env, servicio?: string): number | null {
  const map = parseIdMap(env.DENTALINK_DENTISTA_MAP);
  if (map && servicio) {
    const s = servicio.toLowerCase();
    for (const [key, id] of Object.entries(map)) {
      if (s.includes(key.toLowerCase())) return id;
    }
  }
  const def = Number(env.DENTALINK_DENTISTA_ID);
  if (Number.isFinite(def) && def > 0) return def;
  if (map) {
    const first = Object.values(map)[0];
    if (typeof first === "number") return first;
  }
  return null;
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
  // El contrato real de la API sólo está confirmado en parte: los bloques libres
  // se han visto como 0 numérico, pero no hay garantía de que no llegue "0" o null.
  id_paciente?: number | string | null;
  hora_inicio?: string;
  hora_fin?: string;
}

/** Un bloque está libre si no tiene paciente: 0, "0", null o el campo ausente. */
function bloqueLibre(idPaciente: DentalinkSlot["id_paciente"]): boolean {
  if (idPaciente === null || idPaciente === undefined) return true;
  if (typeof idPaciente === "number") return idPaciente === 0;
  return idPaciente.trim() === "0";
}

function horaValida(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Normaliza un teléfono a sus últimos 9 dígitos (largo de un móvil chileno), de
 * modo que "+56912345678", "+56 9 1234 5678" y "912345678" comparen iguales.
 */
export function normalizePhone(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "").slice(-9);
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
      .filter((s) => bloqueLibre(s.id_paciente) && horaValida(s.hora_inicio) && horaValida(s.hora_fin))
      .map((s) => ({ horaInicio: s.hora_inicio as string, horaFin: s.hora_fin as string }));
    return { ok: true, slots };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

interface DentalinkPatientMatch {
  id: number;
  telefono?: string;
}

/**
 * Busca un paciente existente por teléfono. patientId: null si no hay match.
 *
 * NUNCA devuelve el primer resultado a ciegas: verifica que el teléfono del
 * candidato normalice igual al buscado. Si la búsqueda de Dentalink fuera parcial
 * o difusa, tomar list[0] escribiría la cita en la ficha de OTRO paciente. Sin
 * match verificado devolvemos null y el llamador crea un paciente nuevo — una
 * ficha duplicada es mucho menos grave que una cita mal atribuida.
 */
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
    const buscado = normalizePhone(telefono);
    const match = buscado
      ? list.find((p) => typeof p?.telefono === "string" && normalizePhone(p.telefono) === buscado)
      : undefined;
    return { ok: true, patientId: match?.id ?? null };
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

  // Guardia contra doble reserva (TOCTOU): el prompt le pide al modelo consultar
  // disponibilidad antes, pero un modelo que se la salta —o dos conversaciones
  // concurrentes— pisarían el mismo bloque. Revalidamos acá, del lado del código.
  const avail = await getAvailableSlots(env, args.dentistaId, args.sucursalId, args.date);
  if (!avail.ok) return { ok: false, reason: `availability:${avail.reason}` };
  if (!avail.slots.some((s) => s.horaInicio === args.horaInicio)) {
    return { ok: false, reason: "slot_unavailable" };
  }

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
