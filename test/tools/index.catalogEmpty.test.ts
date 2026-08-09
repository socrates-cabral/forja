import { describe, it, expect, vi } from "vitest";

// Catálogo vacío — el default real del repo (member/config.local.ts lo deja
// así hasta que el dueño lo llena). Archivo separado de index.test.ts porque
// vi.mock aplica a todo el módulo por archivo: no se puede tener un catálogo
// vacío y uno no-vacío en el mismo archivo sin mocks dinámicos.
vi.mock("../../member/config.local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../member/config.local")>();
  return { ...actual, catalog: [] };
});

import { buildTools, type ToolContext } from "../../src/tools/index";

function makeProCtx(): ToolContext {
  const env = {
    BOT_TIER: "pro",
    DB: {} as any,
    AI: {} as any,
    BUSINESS_NAME: "Test",
    OWNER_EMAIL: "owner@test.com",
    DASHBOARD_BASE_URL: "https://example.com",
  } as any;
  return { env, getConversationId: () => "conv-1" };
}

describe("buildTools — catálogo vacío", () => {
  it("no registra catalogQuery cuando el catálogo del negocio está vacío, aunque sea tier Pro", () => {
    const tools = buildTools(makeProCtx());
    expect(tools.catalogQuery).toBeUndefined();
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
      "captureLead",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
  });
});
