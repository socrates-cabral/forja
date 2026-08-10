import { describe, it, expect, vi } from "vitest";
import { validateDeployConfig, fetchRemoteSecretNames } from "../../scripts/deploy-check";

describe("validateDeployConfig", () => {
  const full = {
    ANTHROPIC_API_KEY: "sk-x",
    BOT_NAME: "Testi",
    BOT_TIER: "pro",
    DASHBOARD_PASSWORD: "pw",
    TELEGRAM_BOT_TOKEN: "tok",
  };

  it("passes with a complete Pro config", () => {
    expect(validateDeployConfig(full)).toEqual({ ok: true, errors: [] });
  });

  it("passes a Free config without DASHBOARD_PASSWORD", () => {
    const { DASHBOARD_PASSWORD, ...rest } = full;
    expect(validateDeployConfig({ ...rest, BOT_TIER: "free" }).ok).toBe(true);
  });

  it("fails when ANTHROPIC_API_KEY is missing", () => {
    const { ANTHROPIC_API_KEY, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("ANTHROPIC_API_KEY");
  });

  it("fails when no channel is configured", () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("canal");
  });

  it("fails Pro without DASHBOARD_PASSWORD", () => {
    const { DASHBOARD_PASSWORD, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("DASHBOARD_PASSWORD");
  });
});

describe("fetchRemoteSecretNames", () => {
  // Regresión: en Windows, execFileSync("npx", ...) sin shell:true falla
  // (ENOENT/EINVAL — npx es un shim .cmd) y un catch vacío lo tragaba en
  // silencio, reportando secrets remotos como faltantes aunque existieran en
  // Cloudflare. Confirma que la llamada real sigue pasando shell:true.
  it("calls execFileSync with shell:true (el fix de Windows)", () => {
    const execFileSyncMock = vi.fn(() => '[{"name":"DASHBOARD_PASSWORD","type":"secret_text"}]');
    fetchRemoteSecretNames(execFileSyncMock as any);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      ["wrangler", "secret", "list"],
      expect.objectContaining({ shell: true }),
    );
  });

  it("parses secret names from the wrangler JSON output", () => {
    const execFileSyncMock = vi.fn(
      () => '[{"name":"ANTHROPIC_API_KEY","type":"secret_text"},{"name":"DASHBOARD_PASSWORD","type":"secret_text"}]',
    );
    expect(fetchRemoteSecretNames(execFileSyncMock as any)).toEqual([
      "ANTHROPIC_API_KEY",
      "DASHBOARD_PASSWORD",
    ]);
  });

  it("returns [] on any failure (sin red, sin login, sin npx) — nunca la ruta crítica", () => {
    const execFileSyncMock = vi.fn(() => {
      throw new Error("spawnSync npx ENOENT");
    });
    expect(fetchRemoteSecretNames(execFileSyncMock as any)).toEqual([]);
  });
});
