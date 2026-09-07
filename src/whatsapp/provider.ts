import { config } from "../config.js";

export type SendResult = { id: string };

export interface WhatsAppProvider {
  /** Send a free-form text message. Throws WindowClosedError when outside the 24h customer-service window. */
  send(to: string, body: string): Promise<SendResult>;
  /** Send a pre-approved template (used to re-open the 24h window). */
  sendTemplate(to: string, contentSid: string, variables?: Record<string, string>): Promise<SendResult>;
}

export class WindowClosedError extends Error {
  constructor(message = "Outside the WhatsApp 24h messaging window") {
    super(message);
    this.name = "WindowClosedError";
  }
}

let provider: WhatsAppProvider | undefined;

export async function getProvider(): Promise<WhatsAppProvider> {
  if (provider) return provider;
  if (config.WHATSAPP_PROVIDER === "console") {
    const { ConsoleProvider } = await import("./console.js");
    provider = new ConsoleProvider();
  } else {
    const { TwilioProvider } = await import("./twilio.js");
    provider = new TwilioProvider();
  }
  return provider;
}

/** For tests / local runs. */
export function setProvider(p: WhatsAppProvider) {
  provider = p;
}
