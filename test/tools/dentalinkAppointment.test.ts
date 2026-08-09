import { describe, it, expect, vi } from "vitest";
import { dentalinkAppointmentTool } from "../../src/tools/dentalinkAppointment";

describe("dentalinkAppointmentTool", () => {
  it("agenda la cita vía Dentalink", async () => {
    global.fetch = vi
      .fn()
      // createBooking revalida disponibilidad antes de agendar (guardia anti doble reserva)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id_paciente: 0, hora_inicio: "09:00", hora_fin: "09:30" }] }), {
          status: 200,
        }),
      )
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
