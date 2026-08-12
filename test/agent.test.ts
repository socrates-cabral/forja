import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";

let mf: Awaited<ReturnType<typeof createTestMiniflare>>;

beforeEach(async () => {
  mf = await createTestMiniflare();
});

describe("SupportAgent", () => {
  it("instantiates a DO per (channel, user_id)", async () => {
    // createTestMiniflare returns the raw Miniflare instance; bindings are
    // accessed via getBindings() (it has no `.bindings` property).
    const bindings = (await mf.getBindings()) as Record<string, any>;
    const ns = bindings.AGENT as any;
    const id1 = ns.idFromName("telegram:user_1");
    const id2 = ns.idFromName("telegram:user_2");
    const id3 = ns.idFromName("telegram:user_1");
    expect(id1.toString()).toBe(id3.toString());
    expect(id1.toString()).not.toBe(id2.toString());
  });
});

// --- IO Task 6: agent.ts decide interactive vs texto ------------------------
//
// Reuses the exact mocking mechanism already established in
// test/agent.media.test.ts to drive SupportAgent.processBuffer() with a
// mocked `streamText`/`result.steps` (so we can simulate the model calling a
// tool) and a mocked channel adapter (so we can assert what was sent without
// touching a real channel). See that file for the original pattern; it is
// reproduced here because it lives at module scope (vi.mock is hoisted) and
// this suite needs its own copy to simulate an askWithOptions tool call.

vi.mock("agents", () => ({
  Agent: class {
    ctx: any;
    env: any;
    state: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    setState(s: any) {
      this.state = s;
    }
    sql(..._args: any[]) {
      return undefined;
    }
  },
}));

const streamTextMock = vi.fn();

vi.mock("ai", () => ({
  streamText: (...args: any[]) => streamTextMock(...args),
  tool: (def: any) => def,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

const { SupportAgent } = await import("../src/agent");
const { ConversationsRepo } = await import("../src/db/conversations");
const { MessagesRepo } = await import("../src/db/messages");
const { SettingsRepo } = await import("../src/db/settings");
const senderMod = await import("../src/replies/sender");

function stubSettings(overrides: Record<string, string> = {}) {
  vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue(overrides);
}

function stubConversations() {
  vi.spyOn(ConversationsRepo.prototype, "getOrCreate").mockResolvedValue({
    id: "conv-1",
    paused_until: null,
  } as any);
  vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(false);
}

function makeAgentForToolCallTest() {
  const storage = { setAlarm: vi.fn(), getAlarm: vi.fn() };
  const env: any = {
    DB: {},
    AI: { run: vi.fn(async () => ({ text: "" })) },
    ANTHROPIC_API_KEY: "sk-test",
    BOT_TIER: "free",
    BOT_LANGUAGE: "es",
    BUFFER_SECONDS: "8",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "TestCo",
  };
  const agent: any = new (SupportAgent as any)({ storage }, env);
  agent.setState({
    conversationId: "conv-1",
    channel: "telegram",
    channelUserId: "u1",
    pendingMessages: [],
    lastAlarmAt: 0,
    lastUserLang: "es",
    toolCallsInLast2Turns: 0,
    lastSearchKbScore: 1,
    imageRetryCount: 0,
  });
  return { agent, env, storage };
}

// Same shape as makeStreamResult() in agent.media.test.ts, but the `steps`
// carry a tool call — this is how those neighboring tests already simulate
// "the model called a tool" for `toolCallsMade` in agent.ts.
function makeToolCallStreamResult(
  assistantText: string,
  toolCall: { toolName: string; input: unknown } | undefined,
) {
  async function* gen() {
    yield assistantText;
  }
  return {
    textStream: gen(),
    usage: Promise.resolve({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
    }),
    steps: Promise.resolve([{ toolCalls: toolCall ? [toolCall] : [] }]),
  };
}

describe("SupportAgent.processBuffer — askWithOptions decides interactive vs texto (IO Task 6)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubSettings();
    stubConversations();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("si el modelo llamó askWithOptions CON texto sustantivo, manda el texto y DESPUÉS el interactive (Hallazgo 3)", async () => {
    // Antes de este fix, `assistantText` se descartaba SIEMPRE que hubiera un
    // askCall — bien cuando el modelo solo repetía la pregunta (rule 8), mal
    // cuando el modelo respondía algo real antes ("El control cuesta
    // $30.000.") y ofrecía un follow-up ("¿Agendamos?"): el cliente nunca
    // veía el precio, y ni siquiera quedaba en D1. Decisión del dueño: si
    // hay texto sustantivo, se manda como mensaje de texto normal PRIMERO,
    // y el interactive DESPUÉS — nada se descarta.
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      makeToolCallStreamResult("El control cuesta $30.000.", {
        toolName: "askWithOptions",
        input: { pregunta: "¿Agendamos?", opciones: ["Sí", "No"] },
      }),
    );

    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(undefined as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "cuánto cuesta el control" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );

    const sendReplySpy = vi.fn(async (_reply: any, _env: any) => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: sendReplySpy,
    } as any);

    agent.state.pendingMessages = [{ text: "cuánto cuesta el control", receivedAt: Date.now() }];
    await agent.processBuffer();

    expect(sendReplySpy).toHaveBeenCalledTimes(2);
    // 1ª llamada: el texto real, como chunks normales, SIN interactive.
    const [firstReply] = sendReplySpy.mock.calls[0];
    expect(firstReply.chunks).toEqual(["El control cuesta $30.000."]);
    expect(firstReply.interactive).toBeUndefined();
    // 2ª llamada: el prompt interactivo, con chunks vacíos.
    const [secondReply] = sendReplySpy.mock.calls[1];
    expect(secondReply.chunks).toEqual([]);
    expect(secondReply.interactive).toEqual({ question: "¿Agendamos?", options: ["Sí", "No"] });
  });

  it("si assistantText es la MISMA pregunta que askWithOptions, NO la manda dos veces (red de seguridad de código)", async () => {
    // 2026-08-09, prueba en vivo (WhatsApp): pese a <opciones_multiples> en
    // imperativo y a la description de la tool actualizada, el modelo a
    // veces escribe la pregunta tal cual como texto Y ADEMÁS la manda vía
    // askWithOptions — "¿Cuál es tu previsión?" apareció duplicado dos veces
    // seguidas en la conversación real. Dos vueltas de wording más fuerte no
    // lo eliminaron del todo: esto verifica el guardrail de código (comparar
    // assistantText normalizado contra la pregunta de la tool), no una
    // instrucción más al modelo.
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      // Mayúsculas/espacios distintos a propósito: la comparación debe
      // normalizar (trim + lowercase + colapsar espacios), no exigir un
      // match byte-a-byte.
      makeToolCallStreamResult("  ¿Cuál  es tu previsión?  ", {
        toolName: "askWithOptions",
        input: { pregunta: "¿Cuál es tu previsión?", opciones: ["Fonasa", "Isapre", "Particular"] },
      }),
    );

    const appendSpy = vi.fn(
      async (_convId: string, _role: string, _content: string, _opts?: any) => "msg-id",
    );
    vi.spyOn(MessagesRepo.prototype, "append").mockImplementation(appendSpy as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "quiero agendar un control" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );

    const sendReplySpy = vi.fn(async (_reply: any, _env: any) => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: sendReplySpy,
    } as any);

    agent.state.pendingMessages = [{ text: "quiero agendar un control", receivedAt: Date.now() }];
    await agent.processBuffer();

    // Una sola llamada — el interactive. NO un chunk de texto con la
    // pregunta duplicada antes.
    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    const [reply] = sendReplySpy.mock.calls[0];
    expect(reply.chunks).toEqual([]);
    expect(reply.interactive).toEqual({
      question: "¿Cuál es tu previsión?",
      options: ["Fonasa", "Isapre", "Particular"],
    });

    // Persistido en D1: la pregunta aparece UNA sola vez, no duplicada.
    const assistantCall = appendSpy.mock.calls.find((call) => call[1] === "assistant");
    const [, , persistedContent] = assistantCall!;
    const occurrences = (persistedContent.match(/Cuál es tu previsión/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("el guardrail normaliza tildes/puntuación — 'Cual es tu prevision?' (sin tildes) también se descarta", async () => {
    // Hallazgo de la revisión de código de 63bc1a6: el modelo genera texto
    // libre y puede escribirlo sin tildes, mientras que `pregunta` viene de
    // un argumento estructurado con tildes — un guardrail que exigiera match
    // byte-a-byte se perdería este caso, tan real en este dominio como el
    // duplicado exacto.
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      makeToolCallStreamResult("Cual es tu prevision?", {
        toolName: "askWithOptions",
        input: { pregunta: "¿Cuál es tu previsión?", opciones: ["Fonasa", "Isapre", "Particular"] },
      }),
    );

    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(undefined as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "quiero agendar un control" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );

    const sendReplySpy = vi.fn(async (_reply: any, _env: any) => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: sendReplySpy,
    } as any);

    agent.state.pendingMessages = [{ text: "quiero agendar un control", receivedAt: Date.now() }];
    await agent.processBuffer();

    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    expect(sendReplySpy.mock.calls[0][0].chunks).toEqual([]);
  });

  it("recorta la pregunta aunque venga pegada con relleno en la misma frase ('Dime, ¿cuál es tu previsión?')", async () => {
    // Antes esto era un límite documentado como "no cubierto" (ver git log
    // de este test). El fix del 2026-08-12 (separar por línea/párrafo/antes
    // de "¿" y recortar el último trozo si normaliza igual a la pregunta)
    // también resuelve este caso — "Dime," queda como residual, corto pero
    // sin la pregunta duplicada.
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      makeToolCallStreamResult("Dime, ¿cuál es tu previsión?", {
        toolName: "askWithOptions",
        input: { pregunta: "¿Cuál es tu previsión?", opciones: ["Fonasa", "Isapre", "Particular"] },
      }),
    );

    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(undefined as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "quiero agendar un control" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );

    const sendReplySpy = vi.fn(async (_reply: any, _env: any) => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: sendReplySpy,
    } as any);

    agent.state.pendingMessages = [{ text: "quiero agendar un control", receivedAt: Date.now() }];
    await agent.processBuffer();

    expect(sendReplySpy).toHaveBeenCalledTimes(2);
    const [firstReply] = sendReplySpy.mock.calls[0];
    expect(firstReply.chunks.join(" ")).not.toMatch(/previsión/i);
    const [secondReply] = sendReplySpy.mock.calls[1];
    expect(secondReply.interactive).toEqual({
      question: "¿Cuál es tu previsión?",
      options: ["Fonasa", "Isapre", "Particular"],
    });
  });

  it("recorta la pregunta repetida DOS veces con contenido real antes (caso real en vivo, WhatsApp 2026-08-12)", async () => {
    // Captura real: el cliente vio "Excelente. [...] dura 45 minutos." y
    // DESPUÉS "¿Con cuál previsión estás afiliado?" en DOS burbujas de texto
    // separadas, antes de los botones — el modelo escribió la pregunta dos
    // veces seguidas, cada una en su propio párrafo. El guardrail debe
    // recortar AMBAS repeticiones y quedarse solo con el contenido real.
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      makeToolCallStreamResult(
        "Excelente. La primera consulta incluye diagnóstico + panorámica y dura 45 minutos.\n\n" +
          "¿Con cuál previsión estás afiliado?\n\n¿Con cuál previsión estás afiliado?",
        {
          toolName: "askWithOptions",
          input: {
            pregunta: "¿Con cuál previsión estás afiliado?",
            opciones: ["Fonasa", "Isapre", "Particular"],
          },
        },
      ),
    );

    const appendSpy = vi.fn(
      async (_convId: string, _role: string, _content: string, _opts?: any) => "msg-id",
    );
    vi.spyOn(MessagesRepo.prototype, "append").mockImplementation(appendSpy as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "es mi primera vez" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );

    const sendReplySpy = vi.fn(async (_reply: any, _env: any) => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: sendReplySpy,
    } as any);

    agent.state.pendingMessages = [{ text: "es mi primera vez", receivedAt: Date.now() }];
    await agent.processBuffer();

    expect(sendReplySpy).toHaveBeenCalledTimes(2);
    // chunkReply puede partir el texto real en más de una burbuja (por
    // oración) — lo que importa acá es que NINGUNA burbuja de texto trae la
    // pregunta duplicada, no la forma exacta del chunking (ya cubierto por
    // los tests propios de chunkReply).
    const [firstReply] = sendReplySpy.mock.calls[0];
    expect(firstReply.chunks.join(" ")).not.toMatch(/con cuál previsión/i);
    expect(firstReply.chunks.join(" ")).toContain("diagnóstico");
    expect(firstReply.interactive).toBeUndefined();
    const [secondReply] = sendReplySpy.mock.calls[1];
    expect(secondReply.chunks).toEqual([]);
    expect(secondReply.interactive).toEqual({
      question: "¿Con cuál previsión estás afiliado?",
      options: ["Fonasa", "Isapre", "Particular"],
    });

    // Persistido en D1: la pregunta aparece UNA sola vez (dentro del
    // interactive renderizado), no tres.
    const assistantCall = appendSpy.mock.calls.find((call) => call[1] === "assistant");
    const [, , persistedContent] = assistantCall!;
    const occurrences = (persistedContent.match(/con cuál previsión estás afiliado/gi) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("persiste en D1 el texto real + la pregunta renderizada, concatenados (Hallazgo 3)", async () => {
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      makeToolCallStreamResult("El control cuesta $30.000.", {
        toolName: "askWithOptions",
        input: { pregunta: "¿Agendamos?", opciones: ["Sí", "No"] },
      }),
    );

    const appendSpy = vi.fn(
      async (_convId: string, _role: string, _content: string, _opts?: any) => "msg-id",
    );
    vi.spyOn(MessagesRepo.prototype, "append").mockImplementation(appendSpy as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "cuánto cuesta el control" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: vi.fn(async () => {}),
    } as any);

    agent.state.pendingMessages = [{ text: "cuánto cuesta el control", receivedAt: Date.now() }];
    await agent.processBuffer();

    const assistantCall = appendSpy.mock.calls.find((call) => call[1] === "assistant");
    expect(assistantCall).toBeDefined();
    const [, , persistedContent] = assistantCall!;
    // D1 debe quedar como un registro fiel de TODO lo que recibió el cliente
    // en este turno: el precio real Y la pregunta de seguimiento.
    expect(persistedContent).toContain("El control cuesta $30.000.");
    expect(persistedContent).toContain("¿Agendamos?");
    expect(persistedContent).toContain("Sí");
    expect(persistedContent).toContain("No");
  });

  it("persiste el texto de pregunta+opciones en D1, no el assistantText descartado (Hallazgo 2)", async () => {
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      // Con <opciones_multiples> del prompt ("no escribas la pregunta ni
      // siquiera parcialmente"), el modelo normalmente no escribe nada aquí — assistantText
      // queda vacío. Si eso se persistiera tal cual, el turno siguiente
      // mandaría un content block de texto vacío a Anthropic (rechazado con
      // 400), tumbando conversaciones después de un solo uso de botones.
      makeToolCallStreamResult("", {
        toolName: "askWithOptions",
        input: { pregunta: "¿Cuál es tu previsión?", opciones: ["Fonasa", "Isapre"] },
      }),
    );

    const appendSpy = vi.fn(
      async (_convId: string, _role: string, _content: string, _opts?: any) => "msg-id",
    );
    vi.spyOn(MessagesRepo.prototype, "append").mockImplementation(appendSpy as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "quiero agendar" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );
    const sendReplySpy = vi.fn(async (_reply: any, _env: any) => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: sendReplySpy,
    } as any);

    agent.state.pendingMessages = [{ text: "quiero agendar", receivedAt: Date.now() }];
    await agent.processBuffer();

    // append(conversationId, role, content, opts) — content is the 3rd positional
    // arg. processBuffer() calls append twice per turn: once for the user's
    // message (role "user"), once for the assistant's (role "assistant") —
    // isolate the assistant call, which is the one under test.
    const assistantCall = appendSpy.mock.calls.find((call) => call[1] === "assistant");
    expect(assistantCall).toBeDefined();
    const [, role, persistedContent] = assistantCall!;
    expect(persistedContent).not.toBe("");
    expect(persistedContent).toContain("¿Cuál es tu previsión?");
    expect(persistedContent).toContain("Fonasa");
    expect(persistedContent).toContain("Isapre");
    // assistantText vacío (Hallazgo 3 no aplica): un solo sendReply, solo interactive.
    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    const [onlyReply] = sendReplySpy.mock.calls[0];
    expect(onlyReply.interactive).toEqual({
      question: "¿Cuál es tu previsión?",
      options: ["Fonasa", "Isapre"],
    });
  });

  it("sin askWithOptions, manda chunks de texto normal (comportamiento preexistente, Hallazgo 3)", async () => {
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      // No tool call at all — the everyday path that existed before this task.
      makeToolCallStreamResult("Claro, tenemos turno mañana a las 10am.", undefined),
    );

    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(undefined as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "hola" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(
      undefined as any,
    );

    const sendReplySpy = vi.fn(async (_reply: any, _env: any) => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({
      sendReply: sendReplySpy,
    } as any);

    agent.state.pendingMessages = [{ text: "hola", receivedAt: Date.now() }];
    await agent.processBuffer();

    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    const sentReply = sendReplySpy.mock.calls[0][0];
    expect(sentReply.chunks).toEqual(["Claro, tenemos turno mañana a las 10am."]);
    expect(sentReply.interactive).toBeUndefined();
  });
});

// --- Hallazgo 1 (revisión final): el guard anti-spam no debe silenciar taps
// de botones/lista --------------------------------------------------------
//
// isRepeatSpam() se dispara cuando el texto ENTRANTE coincide con 2+ de los
// últimos 5 mensajes de usuario YA PERSISTIDOS en D1 (persistidos por
// processBuffer(), no por ingest()). Estas pruebas corren ingest() contra un
// D1 real (miniflare, mismo helper que test/spam.test.ts) con 2 mensajes
// idénticos ya sembrados directamente en la tabla `messages` — así el 3er
// mensaje entrante (el que procesa ingest() en la prueba) es justo el que
// decide si el guard dispara o no.
describe("SupportAgent.ingest — el guard anti-spam saltea taps interactivos (Hallazgo 1)", () => {
  let realDb: any;
  let db: InstanceType<typeof Db>;
  let convs: InstanceType<typeof ConversationsRepo>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stubSettings();
    const localMf = await createTestMiniflare();
    realDb = await localMf.getD1Database("DB");
    db = new Db(realDb);
    convs = new ConversationsRepo(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedTwoRepeats(channelUserId: string, text: string) {
    const conv = await convs.getOrCreate("telegram", channelUserId);
    for (let i = 0; i < 2; i++) {
      await db.run(
        `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
        [crypto.randomUUID(), conv.id, text, Date.now() - (2 - i) * 1000],
      );
    }
    return conv;
  }

  function makeAgentWithRealDb() {
    const storage = { setAlarm: vi.fn(), getAlarm: vi.fn() };
    const env: any = {
      DB: realDb,
      BOT_TIER: "free",
      BOT_LANGUAGE: "es",
      BUFFER_SECONDS: "8",
      BOT_NAME: "TestBot",
      BUSINESS_NAME: "TestCo",
    };
    const agent: any = new (SupportAgent as any)({ storage }, env);
    agent.setState({
      conversationId: null,
      channel: "",
      channelUserId: "",
      pendingMessages: [],
      lastAlarmAt: 0,
      lastUserLang: "es",
      toolCallsInLast2Turns: 0,
      lastSearchKbScore: 1,
      imageRetryCount: 0,
    });
    return agent;
  }

  it("un 3er tap de botón idéntico (isInteractiveReply) NO dispara el cooldown de 1h", async () => {
    const conv = await seedTwoRepeats("u-btn", "Sí");
    const agent = makeAgentWithRealDb();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u-btn",
      text: "Sí",
      isInteractiveReply: true,
    });

    expect(await convs.isPaused(conv.id)).toBe(false);
  });

  it("un 3er mensaje TIPEADO idéntico (sin isInteractiveReply) sigue disparando el cooldown (regresión)", async () => {
    const conv = await seedTwoRepeats("u-typed", "Sí");
    const agent = makeAgentWithRealDb();

    await agent.ingest({
      channel: "telegram",
      channelUserId: "u-typed",
      text: "Sí",
    });

    expect(await convs.isPaused(conv.id)).toBe(true);
  });
});
