import type { TtsSpeakResult } from "../../../../packages/gateway-protocol/src/schema/channels.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../i18n/locales/en-chat-message-metadata.ts";
import { formatUiError } from "../format-error.ts";
import { canCallGatewayMethod } from "../gateway-methods.ts";
import { showToast } from "../toast.ts";

registerChatMessageMetadataEnglish();

type Playback = { text: string; audio: HTMLAudioElement; url?: string };

// One voice per document: starting another message stops the current one.
let playback: Playback | null = null;

function stopPlayback() {
  const current = playback;
  playback = null;
  if (current) {
    current.audio.pause();
    if (current.url) {
      URL.revokeObjectURL(current.url);
    }
  }
}

async function speak(client: GatewayBrowserClient, text: string) {
  if (playback?.text === text) {
    stopPlayback();
    return;
  }
  stopPlayback();
  const current: Playback = { text, audio: new Audio() };
  // WebKit lifts its autoplay block for an element that load()s or play()s inside a user
  // gesture; this runs in the click, so play() is allowed after tts.speak resolves.
  current.audio.load();
  playback = current;
  try {
    // The Gateway strips markdown and enforces tts.maxTextLength.
    const result = await client.request<TtsSpeakResult>("tts.speak", { text });
    if (playback !== current) {
      return;
    }
    const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
    current.url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType ?? "audio/mpeg" }));
    current.audio.src = current.url;
    current.audio.addEventListener("ended", () => playback === current && stopPlayback(), {
      once: true,
    });
    await current.audio.play();
  } catch (error) {
    if (playback === current) {
      stopPlayback();
      showToast({ message: t("chat.messages.readAloudFailed", { error: formatUiError(error) }) });
    }
  }
}

/** Whether this message is the one being read; its menu item then stops it. */
export function isReadingAloud(text: string): boolean {
  return playback?.text === text;
}

/** Reads a message with the Gateway's text-to-speech, or undefined where it cannot. */
export function readAloudAction(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase">,
): ((text: string) => void) | undefined {
  const client = snapshot.client;
  return client && canCallGatewayMethod(snapshot, "tts.speak", "operator.write")
    ? (text) => void speak(client, text)
    : undefined;
}
