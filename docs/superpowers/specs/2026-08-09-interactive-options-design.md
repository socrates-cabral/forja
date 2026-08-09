# Preguntas con opciones (botones/listas) — Design Spec

## Motivación

Hoy (2026-08-09) los tres canales de Forja (WhatsApp, Telegram, Meta) mandan
**siempre texto plano** — verificado en el código, no es una suposición
(`grep type: "text"` en `src/channels/*.ts` no encuentra ninguna otra forma
de envío). Cuando el bot le pide al cliente que elija entre opciones fijas
(previsión, sí/no, tipo de servicio), depende de que el cliente **escriba
bien** la opción.

En la prueba en vivo de esta tarde, un cliente escribió "previsión con
salud" (dos palabras) en vez de "Consalud" (el nombre real de la Isapre,
una palabra) tres veces seguidas, y el bot terminó cediendo la pregunta sin
resolver la ambigüedad. Con botones, ese problema no puede ocurrir: el
cliente toca una opción, no la escribe.

## Alcance

- **Canales:** WhatsApp Cloud API + Telegram, con soporte nativo (botones /
  lista). Meta (Messenger/IG), ManyChat y Twilio **no** reciben soporte
  nativo en esta vuelta — degradan a texto plano numerado (ver más abajo) en
  vez de fallar o no ofrecer la función.
- **Tier:** disponible en todos los tiers (free y pro) — es una mejora de
  experiencia de chat, no una función de negocio avanzada.
- **Amplitud:** el modelo decide libremente cuándo usar la tool para
  cualquier pregunta de opción múltiple — no está limitado a una lista fija
  de preguntas predefinidas (previsión, urgencia, etc.).

## Arquitectura

### La tool: `askWithOptions`

Nueva tool en `src/tools/askWithOptions.ts`, registrada en `buildTools`
**fuera** del bloque `if (isPro(...))` (junto a `searchKb`/`captureLead`,
disponible en todo tier).

```ts
inputSchema: z.object({
  pregunta: z.string().min(1).max(1024).describe("La pregunta a mostrar, texto completo"),
  opciones: z.array(z.string().min(1).max(20))
    .min(2).max(10)
    .describe("Entre 2 y 10 opciones, cada una de máximo 20 caracteres (límite real de un botón de WhatsApp)"),
}),
execute: async ({ pregunta, opciones }) => {
  return { pregunta, opciones };
},
```

No toca D1 ni necesita `getConversationId` — es un *pass-through* validado
por Zod (los límites de conteo/largo ya quedan garantizados por el schema,
así el SDK de IA reintenta solo si el modelo los viola). El *resultado* de
la tool no importa tanto como el hecho de haberla llamado — ver siguiente
sección.

**Regla de prompt nueva** (en `system-prompt.ts`, bloque base — aplica a
todo bot): *"Si llamaste a askWithOptions, esa tool ES tu respuesta
completa de este turno — no repitas la pregunta como texto aparte."*

### Integración con el envío (sin persistencia nueva)

`src/agent.ts` ya arma `toolCallsMade: {toolName, input}[]` a partir de los
steps del SDK, disponible en el mismo scope de función donde se arma el
envío final (líneas ~325-435 de `agent.ts`, confirmado leyendo el archivo).
No hace falta ningún mecanismo nuevo de estado — justo antes del paso de
"Chunk + send":

```ts
const askCall = toolCallsMade.findLast((c) => c.toolName === "askWithOptions");
if (askCall) {
  const { pregunta, opciones } = askCall.input as { pregunta: string; opciones: string[] };
  await adapter.sendReply({ channel, channelUserId, interactive: { question: pregunta, options: opciones } }, env);
} else {
  const chunks = chunkReply(assistantText, cfg.maxChunks);
  await adapter.sendReply({ channel, channelUserId, chunks, interChunkDelayMs: cfg.interChunkDelayMs }, env);
}
```

Si el modelo llamó `askWithOptions` más de una vez en el mismo turno (no
debería, pero por si acaso), se usa la **última** llamada. El texto normal
(`assistantText`) se ignora por completo en este caso — nunca se manda
además de los botones, evitando el mensaje duplicado sin depender de que el
modelo obedezca la regla de prompt a la perfección.

### Extensión de tipos compartidos

`src/channels/shared.ts`:

```ts
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
```

`sendReply` de cada adaptador chequea `reply.interactive` primero. Los que
tienen soporte nativo (WhatsApp, Telegram) lo mandan como botones/lista. Los
que no (Meta, ManyChat, Twilio) usan un helper compartido
`renderInteractiveAsText(prompt): string` (nuevo, en `shared.ts`) que arma
`"<pregunta>\n\n1. <opción>\n2. <opción>..."` y lo manda como su único chunk
de texto normal — degradación, no fallo.

## WhatsApp — formato nativo

**2-3 opciones → Reply Buttons.** POST a `.../messages`:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<phone>",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": { "text": "<pregunta>" },
    "action": { "buttons": [
      { "type": "reply", "reply": { "id": "opt_0", "title": "<opción, ≤20 chars>" } }
    ]}
  }
}
```

**4-10 opciones → List Message:**

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<phone>",
  "type": "interactive",
  "interactive": {
    "type": "list",
    "body": { "text": "<pregunta>" },
    "action": {
      "button": "Ver opciones",
      "sections": [{ "title": "Opciones", "rows": [{ "id": "opt_0", "title": "<opción>" }] }]
    }
  }
}
```

**Recepción del toque** — llega como `type: "interactive"` en vez de
`type: "text"` en `parseWhatsAppEvents` (`src/channels/whatsapp.ts`):

```json
{ "type": "interactive", "interactive": { "type": "button_reply", "button_reply": { "id": "opt_0", "title": "Fonasa" } } }
```
o `list_reply` con la misma forma. Se mapea `interactive.button_reply.title`
(o `.list_reply.title`) directo a `IncomingMessage.text` — el resto del
pipeline no se entera de que no fue texto tipeado.

## Telegram — formato nativo

**Envío** (`sendMessage` con teclado inline, un botón por fila):

```json
{
  "chat_id": "<id>",
  "text": "<pregunta>",
  "reply_markup": { "inline_keyboard": [
    [{ "text": "<opción>", "callback_data": "<opción>" }]
  ]}
}
```

`callback_data` = el texto de la opción directo (≤20 chars, muy por debajo
del límite de 64 bytes de Telegram) — evita tener que resolver un id contra
el teclado original.

**Recepción:** un tipo de update distinto (`callback_query`, no
`message`) — hoy `TgUpdate` en `telegram.ts` ni lo tipa. Se agrega:

```ts
callback_query?: { id: string; from: {...}; message?: {...}; data?: string };
```

`parseIncoming` chequea `update.callback_query` antes que
`update.message`; usa `callback_query.data` como `IncomingMessage.text`, y
**debe** llamar `answerCallbackQuery` (POST con `callback_query_id`) — si no,
el botón queda con el ícono de carga girando en el cliente de Telegram
indefinidamente.

## Texto libre en vez de tocar

Sin cambios — si el cliente escribe en vez de tocar, WhatsApp/Telegram
mandan un `message`/`type:"text"` normal, indistinguible de cualquier otro
mensaje de hoy. El modelo lo interpreta como siempre. Confirmado con el
usuario como comportamiento deseado (no forzar reintento si el texto libre
no calza con ninguna opción).

## Testing

- `test/tools/askWithOptions.test.ts` — validación del schema (2-10
  opciones, ≤20 chars), pass-through del resultado.
- `test/channels/whatsapp.test.ts` (extender el existente) — envío de
  botones (2-3 opciones) y lista (4-10), y parseo de `button_reply`/
  `list_reply` entrante → `IncomingMessage.text`.
- `test/channels/telegram.test.ts` (extender el existente) — envío de
  inline keyboard, parseo de `callback_query` → `IncomingMessage.text`, y
  que se llame `answerCallbackQuery`.
- `test/channels/shared.test.ts` (nuevo) — `renderInteractiveAsText`.
- `test/agent.test.ts` (extender) — que `askWithOptions` en `toolCallsMade`
  dispare `interactive` en vez de `chunks`, y que `assistantText` se ignore
  cuando eso pasa.

## Fuera de alcance (explícito)

- Soporte nativo en Meta/ManyChat/Twilio (degradan a texto).
- Editar/actualizar un mensaje interactivo ya enviado (ej. "opción ya no
  disponible") — no existe ese caso de uso hoy.
- Botones con URL o llamada a acción (WhatsApp CTA buttons) — solo reply
  buttons/list, que son los que resuelven el caso real (elegir entre
  opciones fijas).
