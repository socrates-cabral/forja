import { describe, it, expect } from "vitest";
import { resolveBotTimezone } from "../src/config";
import type { Env } from "../src/env";

const envWith = (tz?: string) => ({ BOT_TIMEZONE: tz }) as unknown as Env;

describe("resolveBotTimezone", () => {
  it("default UTC cuando no está seteada — no asume ningún país", () => {
    expect(resolveBotTimezone(envWith(undefined))).toBe("UTC");
    expect(resolveBotTimezone(envWith(""))).toBe("UTC");
  });

  it("respeta BOT_TIMEZONE cuando está seteada", () => {
    expect(resolveBotTimezone(envWith("America/Santiago"))).toBe("America/Santiago");
  });
});
