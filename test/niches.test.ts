import { describe, it, expect } from "vitest";
import { getNiche } from "../src/niches";
import { systemPromptFromEnv } from "../src/system-prompt";
import { layout } from "../src/admin/views/layout";
import type { Env } from "../src/env";

const envWith = (niche?: string) => ({ BOT_NICHE: niche, BOT_NAME: "Bot", BUSINESS_NAME: "Neg", BOT_LANGUAGE: "es-MX" }) as unknown as Env;

describe("getNiche", () => {
  it("nicho ausente o desconocido → genérico (comportamiento del Starter)", () => {
    for (const v of [undefined, "", "xyz", "restaurante"]) {
      const n = getNiche(envWith(v));
      expect(n.id).toBe("generico");
      expect(n.navLabel).toBe("Leads");
      expect(n.playbook).toBe("");
      expect(n.defaultTone).toBe("");
    }
  });

  it("normaliza mayúsculas/espacios al resolver el pack", () => {
    expect(getNiche(envWith("  GENERICO ")).id).toBe("generico");
  });
});

describe("dashboard (nav genérico)", () => {
  const page = (niche?: string) => layout({ title: "T", activeTab: "leads", body: "x", env: envWith(niche) });

  it("genérico: el nav dice 'Leads'", () => {
    const html = page(undefined);
    expect(html).toContain("Leads");
    expect(html).toContain('href="/admin/leads"');
  });
});

describe("cableado del playbook al prompt", () => {
  it("genérico no inyecta playbook", () => {
    const env = envWith(undefined);
    const prompt = systemPromptFromEnv(env, ["searchKb"], "ctx", getNiche(env).playbook || undefined);
    expect(prompt).not.toContain("<diagnostic_playbooks>");
  });
});

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
