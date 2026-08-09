# Preguntas con opciones (botones/listas) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar una tool `askWithOptions` que el modelo llama para preguntas de opción múltiple, mostrando botones/lista nativos en WhatsApp y Telegram (texto numerado en el resto de canales) en vez de depender de que el cliente escriba bien la opción exacta.

**Architecture:** Una tool nueva (pass-through, sin efectos secundarios) cuyo resultado se lee directo de `toolCallsMade` — ya disponible en el mismo scope de `agent.ts` donde se arma el envío final — para decidir entre mandar `chunks` de texto (como siempre) o un payload `interactive` nuevo. Cada `ChannelAdapter.sendReply` decide cómo representar ese payload: nativo (WhatsApp/Telegram) o degradado a texto numerado (Meta/ManyChat/Twilio/learned) vía un helper compartido.

**Tech Stack:** TypeScript, Cloudflare Workers, `ai` SDK (`tool()` + `zod`), Vitest (`vi.stubGlobal`/`vi.spyOn` para mockear `fetch`).

## Global Constraints

- TypeScript strict, sin `any` salvo en tests (estilo ya establecido en el repo).
- La tool `askWithOptions` está disponible en **todos los tiers** (free y pro) — se registra en `buildTools` fuera del bloque `if (isPro(...))`.
- Límites de la tool (impuestos por el schema Zod, no a mano en `execute`): 2 a 10 opciones, cada una de máximo 20 caracteres (el límite real de un botón de WhatsApp — se usa el mismo límite en Telegram por consistencia, aunque Telegram admite más).
- Canales con soporte **nativo**: WhatsApp Cloud API y Telegram. Canales con **degradación a texto**: Meta (Messenger/Instagram), ManyChat, Twilio, y el adaptador `learned`.
- Si el cliente responde con texto libre en vez de tocar una opción, se procesa exactamente igual que cualquier mensaje de texto hoy — sin cambios en ningún otro lugar del pipeline.
- Comandos siempre desde `C:\ClaudeWork\freelance\forja`. Tests: `pnpm test <archivo>`. Typecheck: `pnpm typecheck`.

---

## File Structure

```
src/channels/shared.ts         MODIFICAR — InteractivePrompt, OutgoingReply.interactive, renderInteractiveAsText
src/tools/askWithOptions.ts    CREAR — la tool pass-through
test/channels/shared.test.ts   CREAR
test/tools/askWithOptions.test.ts CREAR

src/tools/index.ts             MODIFICAR — registrar en el set base (todos los tiers)
src/admin/views/agente.ts      MODIFICAR — TOOL_META para askWithOptions
test/tools/index.test.ts       MODIFICAR
test/tools/index.catalogEmpty.test.ts MODIFICAR

src/channels/whatsapp.ts       MODIFICAR — enviar botones/lista, parsear button_reply/list_reply
test/channels/whatsapp.test.ts MODIFICAR

src/channels/telegram.ts       MODIFICAR — enviar inline keyboard, parsear callback_query
test/channels/telegram.test.ts MODIFICAR

src/channels/meta.ts           MODIFICAR — degradar a texto
src/channels/manychat.ts       MODIFICAR — degradar a texto
src/channels/twilio.ts         MODIFICAR — degradar a texto
src/channels/learned.ts        MODIFICAR — degradar a texto
test/channels/meta.test.ts     CREAR (no existía)
test/channels/manychat.test.ts MODIFICAR
test/channels/twilio.test.ts   MODIFICAR
test/channels/learned.test.ts  MODIFICAR

src/agent.ts                   MODIFICAR — decidir interactive vs chunks al enviar
src/system-prompt.ts           MODIFICAR — regla nueva en <core_principles>
test/agent.test.ts             MODIFICAR
test/system-prompt.test.ts     MODIFICAR
```

---

### Task 1: Tipos compartidos + helper de degradación + la tool

**Files:**
- Modify: `src/channels/shared.ts`
- Create: `src/tools/askWithOptions.ts`
- Test: `test/channels/shared.test.ts`
- Test: `test/tools/askWithOptions.test.ts`

**Interfaces:**
- Produces: `InteractivePrompt { question: string; options: string[] }`, `OutgoingReply.interactive?: InteractivePrompt`, `renderInteractiveAsText(prompt: InteractivePrompt): string`, `askWithOptionsTool(): Tool` (factory sin argumentos) — consumidos por todas las tasks siguientes.

- [ ] **Step 1: Escribir el test que falla — `renderInteractiveAsText`**

Crear `test/channels/shared.test.ts`:

```ts
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
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test test/channels/shared.test.ts`
Expected: FAIL — `renderInteractiveAsText` no existe

- [ ] **Step 3: Implementar en `src/channels/shared.ts`**

Reemplazar el archivo completo por:

```ts
export type ChannelId = "manychat" | "telegram" | "twilio" | "messenger" | "instagram" | "whatsapp";

export interface IncomingMessage {
  channel: ChannelId;
  channelUserId: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  isOwnerMessage?: boolean;
  receivedAt: number;
  rawPayload: unknown;
}

/** Pregunta de opción múltiple — ver askWithOptions. 2-10 opciones, ≤20 chars c/u. */
export interface InteractivePrompt {
  question: string;
  options: string[];
}

export interface OutgoingReply {
  channel: ChannelId;
  channelUserId: string;
  chunks: string[];          // ignorado si `interactive` está presente
  interChunkDelayMs?: number;
  interactive?: InteractivePrompt;
}

export interface ChannelAdapter {
  parseIncoming(request: Request, env: any): Promise<IncomingMessage>;
  sendReply(reply: OutgoingReply, env: any): Promise<void>;
  showTyping?(channelUserId: string, env: any): Promise<void>;
}

/**
 * Degrada un InteractivePrompt a texto plano numerado, para los canales sin
 * soporte nativo de botones/lista (Meta, ManyChat, Twilio, learned).
 */
export function renderInteractiveAsText(prompt: InteractivePrompt): string {
  const lines = prompt.options.map((opt, i) => `${i + 1}. ${opt}`);
  return `${prompt.question}\n\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm test test/channels/shared.test.ts`
Expected: PASS

- [ ] **Step 5: Escribir el test que falla — la tool**

Crear `test/tools/askWithOptions.test.ts`:

```ts
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
```

- [ ] **Step 6: Correr el test y verificar que falla**

Run: `pnpm test test/tools/askWithOptions.test.ts`
Expected: FAIL — módulo no existe

- [ ] **Step 7: Implementar `src/tools/askWithOptions.ts`**

```ts
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
      "de esta tool YA es tu respuesta completa de este turno: no repitas la " +
      "pregunta como texto aparte.",
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
```

- [ ] **Step 8: Correr el test y verificar que pasa**

Run: `pnpm test test/tools/askWithOptions.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 10: Commit**

```bash
git add src/channels/shared.ts src/tools/askWithOptions.ts test/channels/shared.test.ts test/tools/askWithOptions.test.ts
git commit -m "feat(interactive): tipos compartidos + helper de degradación + tool askWithOptions"
```

---

### Task 2: Registrar la tool (todos los tiers) + ícono en el panel

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/admin/views/agente.ts`
- Modify: `test/tools/index.test.ts`
- Modify: `test/tools/index.catalogEmpty.test.ts`

**Interfaces:**
- Consumes: `askWithOptionsTool` de Task 1.

- [ ] **Step 1: Actualizar los tests existentes que listan el set de tools**

En `test/tools/index.test.ts`, el archivo completo queda así (agrega `askWithOptions` a los 4 arrays que listan tools explícitamente — el resto del archivo no cambia):

```ts
import { describe, it, expect, vi } from "vitest";

// Mock del catálogo del negocio: no vacío por default, para no cambiar el
// comportamiento de los tests preexistentes que asumen catalogQuery presente.
// El gate real (catálogo vacío → catalogQuery ausente) se prueba en
// index.catalogEmpty.test.ts, con su propio mock.
vi.mock("../../member/config.local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../member/config.local")>();
  return { ...actual, catalog: [{ name: "Producto Test", price: 100 }] };
});

import { buildTools, type ToolContext } from "../../src/tools/index";

function makeCtx(tier: "free" | "pro", niche?: string): ToolContext {
  const env = {
    BOT_TIER: tier,
    BOT_NICHE: niche,
    DB: {} as any,
    AI: {} as any,
    BUSINESS_NAME: "Test",
    OWNER_EMAIL: "owner@test.com",
    DASHBOARD_BASE_URL: "https://example.com",
  } as any;
  return { env, getConversationId: () => "conv-1" };
}

describe("buildTools", () => {
  it("registers the 6 free-tier tools (incluye captureLead y askWithOptions)", () => {
    const tools = buildTools(makeCtx("free"));
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
      "captureLead",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
  });

  it("free tier captura leads pero excluye las Pro-only avanzadas", () => {
    const tools = buildTools(makeCtx("free"));
    expect(tools.captureLead).toBeDefined();
    expect(tools.askWithOptions).toBeDefined();
    expect(tools.scheduleAppointment).toBeUndefined();
    expect(tools.catalogQuery).toBeUndefined();
  });

  it("pro tier con Cal.com configurado agrega calcomAvailability + scheduleAppointment además de catalogQuery", () => {
    const ctx = makeCtx("pro");
    (ctx.env as any).CALCOM_API_KEY = "cal_x";
    (ctx.env as any).CALCOM_EVENT_TYPE_ID = "1";
    const tools = buildTools(ctx);
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
      "calcomAvailability",
      "captureLead",
      "catalogQuery",
      "handoffHuman",
      "pauseBot",
      "scheduleAppointment",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeDefined();
    expect(tools.calcomAvailability).toBeDefined();
    expect(tools.catalogQuery).toBeDefined();
  });

  it("pro tier SIN Cal.com ni Dentalink configurados no registra ninguna tool de agendar — evita ofrecer una tool rota que el modelo intente usar y luego invente un resultado", () => {
    const tools = buildTools(makeCtx("pro"));
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
      "captureLead",
      "catalogQuery",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeUndefined();
    expect(tools.dentalinkAvailability).toBeUndefined();
    expect(tools.dentalinkAppointment).toBeUndefined();
  });

  it("el Starter genérico no agrega tools de nicho (aunque BOT_NICHE traiga un giro)", () => {
    for (const niche of [undefined, "restaurante", "inmobiliaria", "hoteleria"]) {
      const tools = buildTools(makeCtx("pro", niche));
      expect(tools.crearReservacion).toBeUndefined();
      expect(tools.calificarComprador).toBeUndefined();
      expect(tools.agendarCita).toBeUndefined();
      expect(tools.registrarPedido).toBeUndefined();
      expect(tools.registrarProspecto).toBeUndefined();
      expect(tools.reservarHospedaje).toBeUndefined();
    }
  });

  it("pro tier con Dentalink configurado usa dentalinkAvailability/dentalinkAppointment en vez de scheduleAppointment", () => {
    const ctx = makeCtx("pro");
    (ctx.env as any).DENTALINK_API_TOKEN = "tok";
    (ctx.env as any).DENTALINK_SUCURSAL_ID = "1";
    (ctx.env as any).DENTALINK_DENTISTA_ID = "9";
    const tools = buildTools(ctx);
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
      "captureLead",
      "catalogQuery",
      "dentalinkAppointment",
      "dentalinkAvailability",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeUndefined();
  });
});
```

En `test/tools/index.catalogEmpty.test.ts`, actualizar el array esperado (agregar `askWithOptions`):

```ts
    expect(Object.keys(tools).sort()).toEqual([
      "askWithOptions",
      "captureLead",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
```

(Solo esa línea cambia dentro del archivo — el resto queda igual.)

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm test test/tools/index.test.ts test/tools/index.catalogEmpty.test.ts`
Expected: FAIL — `askWithOptions` no está en `buildTools` todavía

- [ ] **Step 3: Registrar la tool en `src/tools/index.ts`**

```ts
import type { Env } from "../env";
import { isPro } from "../config";
import { searchKbTool } from "./searchKb";
import { handoffHumanTool } from "./handoffHuman";
import { pauseBotTool } from "./pauseBot";
import { snoozeUserTool } from "./snoozeUser";
import { captureLeadTool } from "./captureLead";
import { askWithOptionsTool } from "./askWithOptions";
import { scheduleAppointmentTool } from "./scheduleAppointment";
import { calcomAvailabilityTool } from "./calcomAvailability";
import { catalogQueryTool } from "./catalogQuery";
import { dentalinkAvailabilityTool } from "./dentalinkAvailability";
import { dentalinkAppointmentTool } from "./dentalinkAppointment";
import { dentalinkConfigured } from "../integrations/dentalink";
import { calcomConfigured } from "../integrations/calcom";
import { catalog } from "../../member/config.local";

export interface ToolContext {
  env: Env;
  getConversationId: () => string | null;
}

export function buildTools(ctx: ToolContext) {
  // Free tier base set. captureLead va aquí a propósito: el bot Starter (free)
  // captura prospectos — es el valor central de un bot de ventas. Lo Pro son las
  // tools más avanzadas por nicho (agendar citas, consultar catálogo/inventario).
  // askWithOptions también va en el set base — es una mejora de experiencia de
  // chat (botones en vez de texto libre), no una función de negocio avanzada.
  const tools: Record<string, any> = {
    searchKb: searchKbTool(ctx.env),
    handoffHuman: handoffHumanTool(ctx.env, ctx.getConversationId),
    pauseBot: pauseBotTool(ctx.env, ctx.getConversationId),
    snoozeUser: snoozeUserTool(ctx.env, ctx.getConversationId),
    captureLead: captureLeadTool(ctx.env, ctx.getConversationId),
    askWithOptions: askWithOptionsTool(),
  };

  // Pro tier additions
  if (isPro(ctx.env)) {
    // Mismo principio que la agenda de citas: un catálogo vacío (el default
    // del repo) no tiene nada que consultar — ofrecer la tool igual invita al
    // modelo a inventar productos o a declarar "no lo tenemos" sobre datos
    // que en realidad viven en businessConfig.services, no en el catálogo.
    if (catalog.length > 0) {
      tools.catalogQuery = catalogQueryTool(ctx.env);
    }

    // Agenda de citas: Dentalink y Cal.com son mutuamente excluyentes — una
    // clínica que configuró Dentalink no necesita (ni debe ver) la tool
    // genérica de Cal.com, y viceversa. Y ninguna de las dos se registra si
    // no está realmente configurada: una tool visible-pero-rota invita al
    // modelo a "usarla" y luego inventar un resultado cuando falla (bug real
    // observado 2026-08-09 — el bot declaró una cita "confirmada" tras un
    // scheduleAppointment que devolvió calcom_not_configured).
    if (dentalinkConfigured(ctx.env)) {
      tools.dentalinkAvailability = dentalinkAvailabilityTool(ctx.env);
      tools.dentalinkAppointment = dentalinkAppointmentTool(ctx.env, ctx.getConversationId);
    } else if (calcomConfigured(ctx.env)) {
      tools.calcomAvailability = calcomAvailabilityTool(ctx.env);
      tools.scheduleAppointment = scheduleAppointmentTool(ctx.env, ctx.getConversationId);
    }
  }

  return tools;
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm test test/tools/index.test.ts test/tools/index.catalogEmpty.test.ts`
Expected: PASS

- [ ] **Step 5: Agregar el ícono en el panel (`src/admin/views/agente.ts`)**

Buscar el objeto `TOOL_META` y agregar esta entrada (junto a las demás, antes del `};` de cierre):

```ts
  askWithOptions: {
    label: "Preguntar con opciones",
    desc: "Muestra botones o una lista nativa en vez de esperar que el cliente escriba la opción exacta (ej. elegir su previsión).",
    icon: "list-checks",
  },
```

- [ ] **Step 6: Correr la suite de admin y confirmar que nada se rompió**

Run: `pnpm test test/admin/agente.test.ts`
Expected: PASS (este archivo no necesita cambios — solo confirma que agregar la entrada no rompió nada)

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 8: Commit**

```bash
git add src/tools/index.ts src/admin/views/agente.ts test/tools/index.test.ts test/tools/index.catalogEmpty.test.ts
git commit -m "feat(interactive): registrar askWithOptions en todos los tiers + ícono en el panel"
```

---

### Task 3: WhatsApp — enviar botones/lista, recibir el toque

**Files:**
- Modify: `src/channels/whatsapp.ts`
- Modify: `test/channels/whatsapp.test.ts`

**Interfaces:**
- Consumes: `OutgoingReply.interactive` (Task 1).

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/channels/whatsapp.test.ts`, dentro de `describe("parseWhatsAppEvents", ...)`, dos casos nuevos (antes del `});` de cierre de ese describe):

```ts
  it("parsea el toque de un botón (interactive/button_reply)", async () => {
    const out = await parseWhatsAppEvents(
      body([
        {
          from: "5215512345678",
          id: "wamid.5",
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "opt_0", title: "Fonasa" } },
        } as any,
      ]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBe("Fonasa");
  });

  it("parsea el toque de una opción de lista (interactive/list_reply)", async () => {
    const out = await parseWhatsAppEvents(
      body([
        {
          from: "5215512345678",
          id: "wamid.6",
          type: "interactive",
          interactive: { type: "list_reply", list_reply: { id: "opt_2", title: "Particular" } },
        } as any,
      ]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBe("Particular");
  });
```

Y dentro de `describe("whatsappAdapter.sendReply", ...)`, dos casos nuevos:

```ts
  it("2-3 opciones → manda Reply Buttons", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await whatsappAdapter.sendReply(
      {
        channel: "whatsapp",
        channelUserId: "5215512345678",
        chunks: [],
        interactive: { question: "¿Cuál es tu previsión?", options: ["Fonasa", "Isapre", "Particular"] },
      },
      { WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", WHATSAPP_ACCESS_TOKEN: "TOKEN" } as any,
    );
    const [, init] = fetchMock.mock.calls[0] as any[];
    const payload = JSON.parse(init.body);
    expect(payload.type).toBe("interactive");
    expect(payload.interactive.type).toBe("button");
    expect(payload.interactive.body.text).toBe("¿Cuál es tu previsión?");
    expect(payload.interactive.action.buttons).toHaveLength(3);
    expect(payload.interactive.action.buttons[0]).toEqual({ type: "reply", reply: { id: "opt_0", title: "Fonasa" } });
  });

  it("4-10 opciones → manda una List Message", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await whatsappAdapter.sendReply(
      {
        channel: "whatsapp",
        channelUserId: "5215512345678",
        chunks: [],
        interactive: { question: "¿Qué servicio?", options: ["Limpieza", "Consulta", "Blanqueamiento", "Urgencia"] },
      },
      { WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", WHATSAPP_ACCESS_TOKEN: "TOKEN" } as any,
    );
    const [, init] = fetchMock.mock.calls[0] as any[];
    const payload = JSON.parse(init.body);
    expect(payload.interactive.type).toBe("list");
    expect(payload.interactive.action.sections[0].rows).toHaveLength(4);
    expect(payload.interactive.action.sections[0].rows[0]).toEqual({ id: "opt_0", title: "Limpieza" });
  });
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm test test/channels/whatsapp.test.ts`
Expected: FAIL — `interactive` no se parsea ni se manda todavía

- [ ] **Step 3: Implementar en `src/channels/whatsapp.ts`**

Modificar la interfaz `WaMessage` (agregar el campo `interactive`):

```ts
interface WaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string; mime_type?: string };
  audio?: { id?: string; voice?: boolean; mime_type?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}
```

En `parseWhatsAppEvents`, agregar una rama al `if/else if` que arma `text`/`audioUrl`/`imageUrl` (justo después de la rama de `audio`):

```ts
        } else if (m.type === "audio" && m.audio?.id) {
          // Las notas de voz llegan como type "audio" con voice:true.
          audioUrl = (await signedMediaUrl(m.audio.id, env, origin)) ?? undefined;
        } else if (m.type === "interactive") {
          // Toque de un botón o de una opción de lista — se trata como si el
          // cliente hubiera escrito el título de la opción.
          text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || undefined;
        }
```

En `whatsappAdapter.sendReply`, insertar el branch de `interactive` antes del loop de `chunks` (justo después de armar `url`, antes de `for (let i = 0; ...)`):

```ts
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;

    if (reply.interactive) {
      const { question, options } = reply.interactive;
      const interactive =
        options.length <= 3
          ? {
              type: "button",
              body: { text: question },
              action: {
                buttons: options.map((opt, i) => ({
                  type: "reply",
                  reply: { id: `opt_${i}`, title: opt },
                })),
              },
            }
          : {
              type: "list",
              body: { text: question },
              action: {
                button: "Ver opciones",
                sections: [
                  { title: "Opciones", rows: options.map((opt, i) => ({ id: `opt_${i}`, title: opt })) },
                ],
              },
            };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: reply.channelUserId,
          type: "interactive",
          interactive,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(`whatsapp sendReply (interactive) ${res.status}: ${errBody}`);
      }
      return;
    }

    for (let i = 0; i < reply.chunks.length; i++) {
```

(El resto del loop de `chunks` queda exactamente igual — solo se agrega el bloque `if (reply.interactive) { ... return; }` antes.)

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm test test/channels/whatsapp.test.ts`
Expected: PASS (todos, incluidos los preexistentes)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 6: Commit**

```bash
git add src/channels/whatsapp.ts test/channels/whatsapp.test.ts
git commit -m "feat(interactive): WhatsApp — enviar Reply Buttons/List Message, parsear el toque"
```

---

### Task 4: Telegram — enviar inline keyboard, recibir el callback

**Files:**
- Modify: `src/channels/telegram.ts`
- Modify: `test/channels/telegram.test.ts`

**Interfaces:**
- Consumes: `OutgoingReply.interactive` (Task 1).

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/channels/telegram.test.ts`, dentro de `describe("telegramAdapter.parseIncoming", ...)`, un caso nuevo:

```ts
  it("procesa el toque de un botón inline (callback_query) y confirma con answerCallbackQuery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 5,
        callback_query: {
          id: "cbq1",
          from: { id: 555, first_name: "Ana", is_bot: false },
          data: "Fonasa",
        },
      }),
      env,
    );
    expect(msg.channel).toBe("telegram");
    expect(msg.channelUserId).toBe("555");
    expect(msg.text).toBe("Fonasa");
    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeTruthy();
    const body = JSON.parse(String((ackCall![1] as RequestInit).body));
    expect(body.callback_query_id).toBe("cbq1");
  });
```

Y un nuevo describe block para `sendReply` (el archivo hoy no lo testea):

```ts
describe("telegramAdapter.sendReply", () => {
  it("con interactive, manda un inline keyboard (un botón por fila)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await telegramAdapter.sendReply(
      {
        channel: "telegram",
        channelUserId: "555",
        chunks: [],
        interactive: { question: "¿Cuál es tu previsión?", options: ["Fonasa", "Isapre", "Particular"] },
      },
      env,
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sendMessage");
    const body = JSON.parse(String(init.body));
    expect(body.text).toBe("¿Cuál es tu previsión?");
    expect(body.reply_markup.inline_keyboard).toEqual([
      [{ text: "Fonasa", callback_data: "Fonasa" }],
      [{ text: "Isapre", callback_data: "Isapre" }],
      [{ text: "Particular", callback_data: "Particular" }],
    ]);
  });

  it("sin interactive, manda texto normal (comportamiento preexistente)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await telegramAdapter.sendReply(
      { channel: "telegram", channelUserId: "555", chunks: ["hola"] },
      env,
    );
    const sendCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("/sendMessage"));
    const body = JSON.parse(String((sendCall![1] as RequestInit).body));
    expect(body.text).toBe("hola");
    expect(body.reply_markup).toBeUndefined();
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `pnpm test test/channels/telegram.test.ts`
Expected: FAIL — `callback_query` no se maneja, `interactive` no se manda

- [ ] **Step 3: Implementar en `src/channels/telegram.ts`**

Agregar `callback_query` a la interfaz `TgUpdate`:

```ts
interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name?: string; is_bot: boolean };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    caption?: string;
    voice?: { file_id: string; duration: number };
    photo?: { file_id: string; width: number; height: number }[];
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string; is_bot: boolean };
    data?: string;
  };
}
```

En `telegramAdapter.parseIncoming`, chequear `callback_query` ANTES de `message` (reemplazar el inicio de la función):

```ts
  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage> {
    const update = (await request.json()) as TgUpdate;
    const token = env.TELEGRAM_BOT_TOKEN ?? "";

    const cq = update.callback_query;
    if (cq) {
      // Ack obligatorio — si no, el botón queda con el ícono de carga girando
      // en el cliente de Telegram indefinidamente.
      await fetch(`${TG_API}${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cq.id }),
      }).catch(() => {});
      const channelUserId = String(cq.from.id);
      return {
        channel: "telegram",
        channelUserId,
        displayName: cq.from.first_name,
        text: cq.data,
        isOwnerMessage:
          env.OWNER_TELEGRAM_CHAT_ID != null && channelUserId === String(env.OWNER_TELEGRAM_CHAT_ID),
        receivedAt: Date.now(),
        rawPayload: update,
      };
    }

    const msg = update.message;
    if (!msg) throw new Error("not a message update");
    const channelUserId = String(msg.from.id);
    const displayName = msg.from.first_name;
    let text = msg.text;
    let audioUrl: string | undefined;
    let imageUrl: string | undefined;
    if (msg.voice) {
```

(El resto de la función, desde `if (msg.voice) {` hacia abajo, queda exactamente igual — solo se quitó la declaración duplicada de `const token = ...` que antes estaba más abajo, ya que ahora se declara al principio.)

Buscar y eliminar la línea `const token = env.TELEGRAM_BOT_TOKEN ?? "";` que quedaba más abajo en el cuerpo original de la función (ya no hace falta, quedó declarada arriba).

En `telegramAdapter.sendReply`, insertar el branch de `interactive` antes del loop de `chunks`:

```ts
  async sendReply(reply: OutgoingReply, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

    if (reply.interactive) {
      await fetch(`${TG_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: reply.channelUserId,
          text: reply.interactive.question,
          reply_markup: {
            inline_keyboard: reply.interactive.options.map((opt) => [{ text: opt, callback_data: opt }]),
          },
        }),
      });
      return;
    }

    for (let i = 0; i < reply.chunks.length; i++) {
```

(El resto del loop de `chunks` queda exactamente igual.)

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `pnpm test test/channels/telegram.test.ts`
Expected: PASS (todos, incluidos los preexistentes)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores

- [ ] **Step 6: Commit**

```bash
git add src/channels/telegram.ts test/channels/telegram.test.ts
git commit -m "feat(interactive): Telegram — enviar inline keyboard, procesar callback_query"
```

---

### Task 5: Degradación a texto — Meta, ManyChat, Twilio, learned

**Files:**
- Modify: `src/channels/meta.ts`
- Modify: `src/channels/manychat.ts`
- Modify: `src/channels/twilio.ts`
- Modify: `src/channels/learned.ts`
- Create: `test/channels/meta.test.ts`
- Modify: `test/channels/manychat.test.ts`
- Modify: `test/channels/twilio.test.ts`
- Modify: `test/channels/learned.test.ts`

**Interfaces:**
- Consumes: `OutgoingReply.interactive`, `renderInteractiveAsText` (Task 1).

- [ ] **Step 1: Escribir el test que falla — Meta**

Crear `test/channels/meta.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { metaAdapter } from "../../src/channels/meta";
import type { Env } from "../../src/env";

afterEach(() => vi.restoreAllMocks());

describe("metaAdapter.sendReply — degradación de interactive a texto", () => {
  it("con interactive, manda un único mensaje de texto numerado (Messenger)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message_id: "m1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { META_PAGE_ACCESS_TOKEN: "tok" } as unknown as Env;
    await metaAdapter.sendReply(
      {
        channel: "messenger",
        channelUserId: "u1",
        chunks: [],
        interactive: { question: "¿Primera vez?", options: ["Sí", "No"] },
      },
      env,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as any[];
    const payload = JSON.parse(init.body);
    expect(payload.message.text).toBe("¿Primera vez?\n\n1. Sí\n2. No");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test test/channels/meta.test.ts`
Expected: FAIL — hoy `reply.chunks` está vacío (`[]`) así que el loop no manda nada; `fetchMock` nunca se llama

- [ ] **Step 3: Implementar la degradación en `src/channels/meta.ts`**

Cambiar el import del inicio del archivo:

```ts
import type { ChannelAdapter, IncomingMessage, OutgoingReply, ChannelId } from "./shared";
import { renderInteractiveAsText } from "./shared";
import type { Env } from "../env";
```

Dentro de `sendReply`, justo antes del `for (let i = 0; i < reply.chunks.length; i++) {`, agregar:

```ts
    const chunks = reply.interactive ? [renderInteractiveAsText(reply.interactive)] : reply.chunks;
```

Y reemplazar, dentro del loop, las dos referencias a `reply.chunks` por `chunks`:

```ts
    for (let i = 0; i < chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const payload: Record<string, unknown> = {
        recipient: { id: reply.channelUserId },
        message: { text: chunks[i] },
      };
```

(El resto de la función queda igual.)

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm test test/channels/meta.test.ts`
Expected: PASS

- [ ] **Step 5: Repetir el mismo patrón en ManyChat — test primero**

Agregar a `test/channels/manychat.test.ts`, dentro de `describe("manychatAdapter.sendReply", ...)`:

```ts
  it("con interactive, manda un único mensaje de texto numerado", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const env = { MANYCHAT_API_KEY: "key" } as unknown as Env;
    await manychatAdapter.sendReply(
      {
        channel: "manychat",
        channelUserId: "abc123",
        chunks: [],
        interactive: { question: "¿Primera vez?", options: ["Sí", "No"] },
      },
      env,
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.data.content.messages[0].text).toBe("¿Primera vez?\n\n1. Sí\n2. No");
  });
```

- [ ] **Step 6: Correr, ver que falla, implementar en `src/channels/manychat.ts`**

Run: `pnpm test test/channels/manychat.test.ts` → FAIL esperado.

Cambiar el import:

```ts
import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import { renderInteractiveAsText } from "./shared";
import type { Env } from "../env";
```

Dentro de `sendReply`, antes del `for (let i = 0; i < reply.chunks.length; i++) {`:

```ts
    const chunks = reply.interactive ? [renderInteractiveAsText(reply.interactive)] : reply.chunks;
```

Y en el loop, reemplazar `reply.chunks.length`/`reply.chunks[i]` por `chunks.length`/`chunks[i]`:

```ts
    for (let i = 0; i < chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await fetch(`${MANYCHAT_API}/sending/sendContent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subscriber_id: reply.channelUserId,
          data: {
            version: "v2",
            content: {
              type: contentType,
              messages: [{ type: "text", text: chunks[i] }],
            },
          },
        }),
      });
```

Run: `pnpm test test/channels/manychat.test.ts` → PASS esperado.

- [ ] **Step 7: Mismo patrón en Twilio — test primero**

Agregar a `test/channels/twilio.test.ts` un describe block nuevo (el archivo hoy solo testea `parseIncoming`):

```ts
import { twilioAdapter } from "../../src/channels/twilio";
```

(agregar ese import junto a los que ya existen al inicio del archivo, si `twilioAdapter` no está importado todavía)

```ts
describe("twilioAdapter.sendReply", () => {
  afterEach(() => vi.restoreAllMocks());

  it("con interactive, manda un único mensaje de texto numerado", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const env = {
      TWILIO_ACCOUNT_SID: "AC1",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_WA_FROM: "+5215500000000",
    } as any;
    await twilioAdapter.sendReply(
      {
        channel: "twilio",
        channelUserId: "+5215512345678",
        chunks: [],
        interactive: { question: "¿Primera vez?", options: ["Sí", "No"] },
      },
      env,
    );
    const body = String((fetchSpy.mock.calls[0][1] as RequestInit).body);
    const params = new URLSearchParams(body);
    expect(params.get("Body")).toBe("¿Primera vez?\n\n1. Sí\n2. No");
  });
});
```

(Si el archivo no importa `describe`/`afterEach`/`vi` todavía, confirmar que el `import { describe, it, expect, ... } from "vitest";` del inicio del archivo los incluya — agregar los que falten a esa misma línea de import.)

- [ ] **Step 8: Correr, ver que falla, implementar en `src/channels/twilio.ts`**

Run: `pnpm test test/channels/twilio.test.ts` → FAIL esperado.

Cambiar el import:

```ts
import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import { renderInteractiveAsText } from "./shared";
import type { Env } from "../env";
```

Dentro de `sendReply`, antes del `for (let i = 0; i < reply.chunks.length; i++) {`:

```ts
    const chunks = reply.interactive ? [renderInteractiveAsText(reply.interactive)] : reply.chunks;
```

Y en el loop:

```ts
    for (let i = 0; i < chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const body = new URLSearchParams({
        From: `whatsapp:${from}`,
        To: `whatsapp:${reply.channelUserId}`,
        Body: chunks[i],
      });
```

Run: `pnpm test test/channels/twilio.test.ts` → PASS esperado.

- [ ] **Step 9: Mismo patrón en `learned.ts` — test primero**

Agregar a `test/channels/learned.test.ts`, dentro de `describe("makeLearnedAdapter.sendReply — content.type (auto-channel)", ...)`, un caso nuevo (seguir el mismo patrón de construcción de `env`/`adapter` que ya usan los tests vecinos de ese mismo describe block — leer los tests existentes de ese bloque en el archivo antes de escribir este, para reusar el mismo helper de setup):

```ts
  it("con interactive, manda un único mensaje de texto numerado", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const env = { DB: await makeTestDb(), MANYCHAT_API_KEY: "key" } as unknown as Env;
    const adapter = makeLearnedAdapter("manychat");
    await adapter.sendReply(
      {
        channel: "manychat",
        channelUserId: "abc123",
        chunks: [],
        interactive: { question: "¿Primera vez?", options: ["Sí", "No"] },
      },
      env,
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.data.content.messages[0].text).toBe("¿Primera vez?\n\n1. Sí\n2. No");
  });
```

> **Nota para quien implemente:** el helper exacto para construir `env.DB` (ej. `makeTestDb()`) y el nombre exacto del canal que acepta `makeLearnedAdapter(...)` deben copiarse de un test **existente** dentro de ese mismo describe block en `test/channels/learned.test.ts` — leelo antes de escribir este test, y usá el mismo patrón de setup línea por línea (mismo helper de DB, mismo tipo de mock). Si el helper se llama distinto, usá el nombre real que encuentres en el archivo.

- [ ] **Step 10: Correr, ver que falla, implementar en `src/channels/learned.ts`**

Run: `pnpm test test/channels/learned.test.ts` → FAIL esperado.

Cambiar el import:

```ts
import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import { renderInteractiveAsText } from "./shared";
import type { Env } from "../env";
```

Dentro de `sendReply` (el método dentro del objeto que devuelve `makeLearnedAdapter`), antes del `for (let i = 0; i < reply.chunks.length; i++) {`:

```ts
      const chunks = reply.interactive ? [renderInteractiveAsText(reply.interactive)] : reply.chunks;
```

Y en el loop, reemplazar `reply.chunks.length`/`reply.chunks[i]` por `chunks.length`/`chunks[i]`:

```ts
      for (let i = 0; i < chunks.length; i++) {
        const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        await fetch(`${MANYCHAT_API}/sending/sendContent`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subscriber_id: reply.channelUserId,
            data: {
              version: "v2",
              content: {
                type: contentType,
                messages: [{ type: "text", text: chunks[i] }],
              },
            },
          }),
        });
```

Run: `pnpm test test/channels/learned.test.ts` → PASS esperado.

- [ ] **Step 11: Typecheck + correr los 5 archivos de este task juntos**

Run: `pnpm typecheck`
Expected: sin errores

Run: `pnpm test test/channels/meta.test.ts test/channels/manychat.test.ts test/channels/twilio.test.ts test/channels/learned.test.ts`
Expected: PASS (todos)

- [ ] **Step 12: Commit**

```bash
git add src/channels/meta.ts src/channels/manychat.ts src/channels/twilio.ts src/channels/learned.ts test/channels/meta.test.ts test/channels/manychat.test.ts test/channels/twilio.test.ts test/channels/learned.test.ts
git commit -m "feat(interactive): degradar a texto numerado en Meta/ManyChat/Twilio/learned"
```

---

### Task 6: Conectar todo — `agent.ts` decide interactive vs texto

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/system-prompt.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/system-prompt.test.ts`

**Interfaces:**
- Consumes: `toolCallsMade: {toolName: string; input: unknown}[]` (ya existe en `agent.ts`), `OutgoingReply.interactive` (Task 1).

- [ ] **Step 1: Escribir el test que falla — regla del prompt**

Agregar a `test/system-prompt.test.ts`, dentro del `describe` que testea `<core_principles>` o el más cercano (si no hay uno específico, agregar como test suelto al final del archivo, antes del último `});`):

```ts
  it("core_principles instruye usar askWithOptions para preguntas de opción múltiple", () => {
    const env = { BOT_NAME: "Bot", BUSINESS_NAME: "Acme", BOT_LANGUAGE: "es" } as any;
    const prompt = systemPromptFromEnv(env, ["searchKb", "askWithOptions"], "ctx");
    expect(prompt).toContain("askWithOptions");
  });
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm test test/system-prompt.test.ts`
Expected: FAIL — el prompt base no menciona `askWithOptions` en ningún lado

- [ ] **Step 3: Agregar la regla en `src/system-prompt.ts`**

Dentro de `<core_principles>`, agregar el punto 8 (después del punto 7 existente, antes de `</core_principles>`):

```
7. Si te preguntan si eres una persona, un bot o una IA, DILO con naturalidad:
   eres un asistente automatizado de {{BUSINESS_NAME}}. Nunca afirmes ser humano
   ni lo esquives. (Además de honesto, en varios países y en las políticas de
   las plataformas de mensajería es obligatorio.)
8. Para preguntas de opción múltiple (previsión, sí/no, elegir entre 2-10
   alternativas conocidas), preferí llamar askWithOptions en vez de escribir
   la pregunta como texto — evita que el cliente tenga que escribir bien una
   opción exacta. El resultado de esa tool YA es tu respuesta completa del
   turno: no repitas la pregunta como texto aparte.
</core_principles>
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm test test/system-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Escribir el test que falla — `agent.ts`**

Leer primero `test/agent.test.ts` completo para identificar el patrón de setup existente (cómo se mockea `streamText`/`steps`/el adapter de envío) y seguir ese mismo patrón — el archivo ya tiene tests que verifican qué se manda vía `adapter.sendReply` para casos de texto normal; agregar un caso nuevo con esa misma estructura:

```ts
  it("si el modelo llamó askWithOptions, manda interactive en vez de chunks de texto", async () => {
    // Seguir el mismo patrón de mock de streamText/steps que ya usan los tests
    // vecinos de este archivo para simular que el modelo llamó a una tool —
    // la diferencia es que el tool call simulado debe ser:
    //   { toolName: "askWithOptions", input: { pregunta: "¿Cuál es tu previsión?", opciones: ["Fonasa", "Isapre"] } }
    // y la aserción final debe confirmar que adapter.sendReply fue llamado con:
    //   expect(sendReplySpy).toHaveBeenCalledWith(
    //     expect.objectContaining({
    //       interactive: { question: "¿Cuál es tu previsión?", options: ["Fonasa", "Isapre"] },
    //     }),
    //     expect.anything(),
    //   );
    // y que NO se le pasó `chunks` con contenido de texto normal en esa misma llamada.
  });
```

> **Nota para quien implemente:** este archivo (`test/agent.test.ts`) ya mockea el loop de `streamText`/`result.steps` de alguna forma para tests existentes que verifican tool calls — abrí el archivo, encontrá cómo simulan ya un tool call ahí, y escribí este test siguiendo EXACTAMENTE ese mismo mecanismo (mismo helper, mismo shape de mock), reemplazando el pseudocódigo de arriba por el código real. No inventes un mecanismo de mock nuevo si el archivo ya tiene uno establecido.

- [ ] **Step 6: Correr el test y verificar que falla**

Run: `pnpm test test/agent.test.ts`
Expected: FAIL — `agent.ts` todavía manda siempre `chunks`, nunca `interactive`

- [ ] **Step 7: Implementar en `src/agent.ts`**

Ubicar el bloque (identificado en el spec, líneas ~423-435 del archivo actual):

```ts
    // Chunk + send via the channel adapter
    const chunks = chunkReply(assistantText, cfg.maxChunks);
    const channel = this.state.channel as ChannelId;
    const adapter = pickAdapter(channel);
    await adapter.sendReply(
      {
        channel,
        channelUserId: this.state.channelUserId,
        chunks,
        interChunkDelayMs: cfg.interChunkDelayMs,
      },
      this.env,
    );
```

Reemplazarlo por:

```ts
    // Chunk + send via the channel adapter. Si el modelo llamó askWithOptions,
    // esa llamada YA es la respuesta completa del turno — se manda como
    // interactive (botones/lista nativos o texto numerado, según el canal) y
    // se ignora `assistantText` por completo, sin importar qué haya escrito el
    // modelo además (evita el mensaje duplicado sin depender de que el modelo
    // obedezca la regla de prompt a la perfección).
    const channel = this.state.channel as ChannelId;
    const adapter = pickAdapter(channel);
    const askCall = toolCallsMade.findLast((c) => c.toolName === "askWithOptions");
    if (askCall) {
      const { pregunta, opciones } = askCall.input as { pregunta: string; opciones: string[] };
      await adapter.sendReply(
        {
          channel,
          channelUserId: this.state.channelUserId,
          chunks: [],
          interactive: { question: pregunta, options: opciones },
        },
        this.env,
      );
    } else {
      const chunks = chunkReply(assistantText, cfg.maxChunks);
      await adapter.sendReply(
        {
          channel,
          channelUserId: this.state.channelUserId,
          chunks,
          interChunkDelayMs: cfg.interChunkDelayMs,
        },
        this.env,
      );
    }
```

- [ ] **Step 8: Correr el test y verificar que pasa**

Run: `pnpm test test/agent.test.ts`
Expected: PASS (todos, incluidos los preexistentes)

- [ ] **Step 9: Typecheck + suite completa**

Run: `pnpm typecheck`
Expected: sin errores

Run: `pnpm test`
Expected: PASS — el único fallo aceptable es el flake preexistente y conocido de `test/spam.test.ts` bajo carga paralela (confirmarlo corriendo `pnpm test test/spam.test.ts` solo, debe dar PASS aislado). Cualquier otro fallo es una regresión real a corregir antes de continuar.

- [ ] **Step 10: Commit**

```bash
git add src/agent.ts src/system-prompt.ts test/agent.test.ts test/system-prompt.test.ts
git commit -m "feat(interactive): agent.ts manda botones/lista cuando el modelo llama askWithOptions"
```

---

## Self-Review

**Spec coverage:** los 6 tasks cubren cada sección del spec — la tool (Task 1), el registro en todos los tiers (Task 2), WhatsApp nativo (Task 3), Telegram nativo (Task 4), degradación a texto en el resto de canales (Task 5), y la integración con el único punto de envío + la regla de prompt (Task 6). El punto "fuera de alcance" del spec (editar mensajes ya enviados, CTA buttons) correctamente no tiene task — no se construye.

**Placeholder scan:** Task 6 Steps 5-6 tienen una nota explícita para quien implemente en vez de código exacto, porque `test/agent.test.ts` ya tiene un mecanismo de mock establecido para simular tool calls que este plan no puede citar sin haberlo leído línea por línea en el momento — es una excepción deliberada (seguir el patrón existente del archivo es más seguro que inventar uno nuevo aquí), no un placeholder por pereza. El resto del plan no tiene TBD/TODO.

**Type consistency:** `InteractivePrompt { question, options }` se usa igual en Tasks 1, 3, 4, 5 y 6. `askWithOptionsTool()` (sin argumentos) se usa igual en Tasks 1 y 2. `toolCallsMade: {toolName, input}[]` (ya existente) se usa igual en Task 6. `renderInteractiveAsText(prompt): string` se usa igual en Task 5.
