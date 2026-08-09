import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { telegramAdapter, resolveTelegramFileUrl } from "../../src/channels/telegram";
import type { Env } from "../../src/env";

function makeReq(body: unknown): Request {
  return new Request("https://bot.test/webhooks/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const env = { TELEGRAM_BOT_TOKEN: "test-token" } as Env;

// Telegram media (voice/photo) is NOT directly addressable by file_id — the
// adapter must call getFile to obtain a file_path, then build the download URL.
// So media tests mock fetch to stand in for that getFile call.
function mockGetFile(filePath: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { file_path: filePath } }), {
      status: 200,
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegramAdapter.parseIncoming", () => {
  it("parses a text message (no fetch needed)", async () => {
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          text: "hola",
        },
      }),
      env,
    );
    expect(msg.channel).toBe("telegram");
    expect(msg.channelUserId).toBe("555");
    expect(msg.text).toBe("hola");
    expect(msg.displayName).toBe("Ana");
  });

  it("resolves voice notes to a real download URL via getFile", async () => {
    mockGetFile("voice/file_5.oga");
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 2,
        message: {
          message_id: 11,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          voice: { file_id: "voice-abc", duration: 5 },
        },
      }),
      env,
    );
    // The resolved URL is the downloadable HTTPS path, not the raw file_id.
    expect(msg.audioUrl).toBe(
      "https://api.telegram.org/file/bottest-token/voice/file_5.oga",
    );
  });

  it("resolves photos to a real download URL + uses caption as text", async () => {
    mockGetFile("photos/file_9.jpg");
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 3,
        message: {
          message_id: 12,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          photo: [
            { file_id: "photo-small", width: 90, height: 90 },
            { file_id: "photo-large", width: 800, height: 800 },
          ],
          caption: "mira esto",
        },
      }),
      env,
    );
    expect(msg.imageUrl).toBe(
      "https://api.telegram.org/file/bottest-token/photos/file_9.jpg",
    );
    expect(msg.text).toBe("mira esto");
  });

  it("flags the owner's own message via OWNER_TELEGRAM_CHAT_ID", async () => {
    const ownerEnv = { TELEGRAM_BOT_TOKEN: "t", OWNER_TELEGRAM_CHAT_ID: "999" } as Env;
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 4,
        message: {
          message_id: 13,
          from: { id: 999, first_name: "Dueño", is_bot: false },
          chat: { id: 999, type: "private" },
          date: 100,
          text: "yo me encargo",
        },
      }),
      ownerEnv,
    );
    expect(msg.isOwnerMessage).toBe(true);
  });

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
});

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

describe("resolveTelegramFileUrl", () => {
  it("returns null when getFile fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 400 }));
    const url = await resolveTelegramFileUrl("x", "tok");
    expect(url).toBeNull();
  });
});
