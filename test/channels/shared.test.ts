import { describe, it, expect } from "vitest";
import { renderInteractiveAsText } from "../../src/channels/shared";

describe("renderInteractiveAsText", () => {
  it("arma la pregunta + opciones numeradas", () => {
    const text = renderInteractiveAsText({
      question: "¿Cuál es tu previsión?",
      options: ["Fonasa", "Isapre", "Particular"],
    });
    expect(text).toBe("¿Cuál es tu previsión?\n\n1. Fonasa\n2. Isapre\n3. Particular");
  });

  it("funciona con una sola línea de opciones (2, el mínimo)", () => {
    const text = renderInteractiveAsText({ question: "¿Primera vez?", options: ["Sí", "No"] });
    expect(text).toBe("¿Primera vez?\n\n1. Sí\n2. No");
  });
});
