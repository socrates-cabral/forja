import { describe, it, expect, vi, afterEach } from "vitest";
import { parseWhatsAppEvents, whatsappAdapter } from "../../src/channels/whatsapp";

const ORIGIN = "https://bot.example.workers.dev";
const env = { WHATSAPP_APP_SECRET: "s3cr3t" } as any;

function body(messages: any[], extra: any = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: "PHONE_ID" },
              contacts: [{ profile: { name: "María" }, wa_id: "5215512345678" }],
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

describe("parseWhatsAppEvents", () => {
  it("parsea texto", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.1", type: "text", text: { body: "hola" } }]) as any,
      env,
      ORIGIN,
    );
    expect(out).toHaveLength(1);
    expect(out[0].channel).toBe("whatsapp");
    expect(out[0].channelUserId).toBe("5215512345678");
    expect(out[0].text).toBe("hola");
    expect(out[0].displayName).toBe("María");
  });

  it("parsea imagen con caption a una URL de media firmada", async () => {
    const out = await parseWhatsAppEvents(
      body([
        { from: "5215512345678", id: "wamid.2", type: "image", image: { id: "MEDIA_IMG", caption: "ese corte" } },
      ]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBe("ese corte");
    expect(out[0].imageUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media/MEDIA_IMG`);
    expect(out[0].imageUrl).toMatch(/[?&]sig=/);
    expect(out[0].imageUrl).toMatch(/[?&]exp=/);
  });

  it("parsea nota de voz (type audio)", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.3", type: "audio", audio: { id: "MEDIA_AUD", voice: true } }]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].audioUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media/MEDIA_AUD`);
    expect(out[0].text).toBeUndefined();
  });

  it("ignora los recibos de entrega/lectura (statuses)", async () => {
    const b = {
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    };
    const out = await parseWhatsAppEvents(b as any, env, ORIGIN);
    expect(out).toHaveLength(0);
  });

  it("sin App Secret no firma media pero no truena (texto sigue)", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.4", type: "image", image: { id: "X" } }]) as any,
      {} as any,
      ORIGIN,
    );
    // imagen sin caption y sin URL firmable → se descarta
    expect(out).toHaveLength(0);
  });

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
});

describe("whatsappAdapter.sendReply", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hace POST al endpoint de Cloud API con el formato correcto", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await whatsappAdapter.sendReply(
      { channel: "whatsapp", channelUserId: "5215512345678", chunks: ["hola"] },
      { WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", WHATSAPP_ACCESS_TOKEN: "TOKEN" } as any,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://graph.facebook.com/v21.0/PHONE_ID/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
    const payload = JSON.parse(init.body);
    expect(payload.messaging_product).toBe("whatsapp");
    expect(payload.to).toBe("5215512345678");
    expect(payload.type).toBe("text");
    expect(payload.text.body).toBe("hola");
  });

  it("lanza si falta configuración", async () => {
    await expect(
      whatsappAdapter.sendReply({ channel: "whatsapp", channelUserId: "x", chunks: ["hi"] }, {} as any),
    ).rejects.toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
  });

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
});
