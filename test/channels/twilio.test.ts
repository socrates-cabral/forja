import { describe, it, expect, vi, afterEach } from "vitest";
import { twilioAdapter } from "../../src/channels/twilio";

describe("twilioAdapter.parseIncoming", () => {
  it("parses text WA", async () => {
    const body = new URLSearchParams({
      From: "whatsapp:+5215512345",
      To: "whatsapp:+5215587654",
      Body: "hola",
      ProfileName: "María",
      NumMedia: "0",
    });
    const req = new Request("https://x", { method: "POST", body });
    const msg = await twilioAdapter.parseIncoming(req, {} as any);
    expect(msg.channel).toBe("twilio");
    expect(msg.channelUserId).toBe("+5215512345");
    expect(msg.text).toBe("hola");
    expect(msg.displayName).toBe("María");
  });

  it("parses image attachment", async () => {
    const body = new URLSearchParams({
      From: "whatsapp:+5215512345",
      To: "whatsapp:+5215587654",
      Body: "ese corte",
      NumMedia: "1",
      MediaUrl0: "https://media.twilio/img.jpg",
      MediaContentType0: "image/jpeg",
    });
    const req = new Request("https://x", { method: "POST", body });
    const msg = await twilioAdapter.parseIncoming(req, {} as any);
    expect(msg.imageUrl).toBe("https://media.twilio/img.jpg");
    expect(msg.text).toBe("ese corte");
  });

  it("parses audio attachment", async () => {
    const body = new URLSearchParams({
      From: "whatsapp:+5215512345",
      To: "whatsapp:+5215587654",
      NumMedia: "1",
      MediaUrl0: "https://media.twilio/voice.ogg",
      MediaContentType0: "audio/ogg",
    });
    const req = new Request("https://x", { method: "POST", body });
    const msg = await twilioAdapter.parseIncoming(req, {} as any);
    expect(msg.audioUrl).toBe("https://media.twilio/voice.ogg");
  });
});

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
