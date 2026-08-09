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
