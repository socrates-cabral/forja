export type ChannelId = "manychat" | "telegram" | "twilio" | "messenger" | "instagram" | "whatsapp";

export interface IncomingMessage {
  channel: ChannelId;
  channelUserId: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  isOwnerMessage?: boolean;
  receivedAt: number;
  rawPayload: unknown;
}

/** Pregunta de opción múltiple — ver askWithOptions. 2-10 opciones, ≤20 chars c/u. */
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

export interface ChannelAdapter {
  parseIncoming(request: Request, env: any): Promise<IncomingMessage>;
  sendReply(reply: OutgoingReply, env: any): Promise<void>;
  showTyping?(channelUserId: string, env: any): Promise<void>;
}

/**
 * Degrada un InteractivePrompt a texto plano numerado, para los canales sin
 * soporte nativo de botones/lista (Meta, ManyChat, Twilio, learned).
 */
export function renderInteractiveAsText(prompt: InteractivePrompt): string {
  const lines = prompt.options.map((opt, i) => `${i + 1}. ${opt}`);
  return `${prompt.question}\n\n${lines.join("\n")}`;
}
