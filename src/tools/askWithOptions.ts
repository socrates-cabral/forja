import { tool } from "ai";
import { z } from "zod";

// Sin efectos secundarios: no llama a env ni a D1. El resultado se lee
// directo de toolCallsMade en agent.ts para decidir cómo mandar la
// respuesta final del turno — ver Task 6.
export function askWithOptionsTool() {
  return tool({
    description:
      "Hace una pregunta de opción múltiple mostrando botones o una lista nativa " +
      "(WhatsApp/Telegram) en vez de texto libre — evita que el cliente tenga que " +
      "escribir bien una opción exacta (ej. el nombre de una Isapre). El resultado " +
      "de esta tool YA es tu respuesta completa de este turno: no escribas la " +
      "pregunta como texto, ni siquiera parcialmente ni como frase de transición " +
      "(ej. \"¿y cuál es?\") — ninguna frase tuya puede estar ya preguntando lo " +
      "mismo que vas a preguntar acá.",
    inputSchema: z.object({
      pregunta: z.string().min(1).max(1024).describe("La pregunta completa a mostrar al cliente"),
      opciones: z
        .array(z.string().min(1).max(20))
        .min(2)
        .max(10)
        .describe("Entre 2 y 10 opciones, cada una de máximo 20 caracteres"),
    }),
    execute: async ({ pregunta, opciones }) => {
      return { pregunta, opciones };
    },
  });
}
