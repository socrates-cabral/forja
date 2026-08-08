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
