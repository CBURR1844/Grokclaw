import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { isReadingAloud, readAloudAction } from "./read-aloud.ts";

const showToast = vi.hoisted(() => vi.fn());
vi.mock("../toast.ts", () => ({ showToast }));

class FakeAudio extends EventTarget {
  static created: FakeAudio[] = [];
  src = "";
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  constructor() {
    super();
    FakeAudio.created.push(this);
  }
}

function snapshot(request: GatewayBrowserClient["request"], scopes = ["operator.write"]) {
  return {
    client: { request } as GatewayBrowserClient,
    hello: gatewayHelloForMethods(["tts.speak"], scopes),
    phase: "connected",
  } as ApplicationGatewaySnapshot;
}

beforeEach(() => {
  FakeAudio.created = [];
  vi.stubGlobal("Audio", FakeAudio);
  // jsdom has no Blob URLs.
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:audio"), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  showToast.mockReset();
});

describe("read aloud", () => {
  it("is unavailable without tts.speak write access", () => {
    expect(readAloudAction(snapshot(vi.fn(), ["operator.read"]))).toBeUndefined();
  });

  it("plays one message at a time and stops it on the second click", async () => {
    const request = vi.fn(async () => ({ audioBase64: btoa("mp3"), provider: "test" }));
    const read = readAloudAction(snapshot(request as GatewayBrowserClient["request"]))!;

    read("Hello there");

    expect(isReadingAloud("Hello there")).toBe(true);
    expect(request).toHaveBeenCalledWith("tts.speak", { text: "Hello there" });
    const audio = FakeAudio.created[0]!;
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    expect(audio.src).toBe("blob:audio");

    read("Hello there");

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:audio");
    expect(isReadingAloud("Hello there")).toBe(false);
  });

  it("drops a reply that arrives after another message started", async () => {
    const first = createDeferred<{ audioBase64: string; provider: string }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ audioBase64: btoa("mp3"), provider: "test" });
    const read = readAloudAction(snapshot(request))!;

    read("First");
    read("Second");
    first.resolve({ audioBase64: btoa("late"), provider: "test" });

    await vi.waitFor(() => expect(FakeAudio.created[1]!.play).toHaveBeenCalledOnce());
    expect(FakeAudio.created[0]!.play).not.toHaveBeenCalled();
    expect(isReadingAloud("Second")).toBe(true);
  });

  it("explains a Gateway refusal", async () => {
    const read = readAloudAction(
      snapshot(vi.fn().mockRejectedValue(new Error("tts.speak text too long"))),
    )!;

    read("Too long");

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        message: "Couldn't read this aloud: tts.speak text too long",
      }),
    );
    expect(isReadingAloud("Too long")).toBe(false);
  });
});
