import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";

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
  toolCall: { toolName: string; input: unknown },
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
    steps: Promise.resolve([{ toolCalls: [toolCall] }]),
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

  it("si el modelo llamó askWithOptions, manda interactive en vez de chunks de texto", async () => {
    const { agent } = makeAgentForToolCallTest();

    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() =>
      // The model ALSO wrote normal assistant text alongside the tool call —
      // the point of this test is that it must be ignored, not just that
      // `interactive` happens to also be present.
      makeToolCallStreamResult("Dale, ¿cuál es tu previsión?", {
        toolName: "askWithOptions",
        input: { pregunta: "¿Cuál es tu previsión?", opciones: ["Fonasa", "Isapre"] },
      }),
    );

    vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue(undefined as any);
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

    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        interactive: { question: "¿Cuál es tu previsión?", options: ["Fonasa", "Isapre"] },
      }),
      expect.anything(),
    );
    // Not sent with chunks containing the normal assistant text in that same call.
    const sentReply = sendReplySpy.mock.calls[0][0];
    expect(sentReply.chunks).toEqual([]);
  });
});
