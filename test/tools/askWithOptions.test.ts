import { describe, it, expect } from "vitest";
import { askWithOptionsTool } from "../../src/tools/askWithOptions";

describe("askWithOptionsTool", () => {
  it("devuelve la pregunta y las opciones tal cual (pass-through)", async () => {
    const tool = askWithOptionsTool();
    const result = await tool.execute!(
      { pregunta: "¿Cuál es tu previsión?", opciones: ["Fonasa", "Isapre", "Particular"] },
      {} as any,
    );
    expect(result).toEqual({
      pregunta: "¿Cuál es tu previsión?",
      opciones: ["Fonasa", "Isapre", "Particular"],
    });
  });
});
