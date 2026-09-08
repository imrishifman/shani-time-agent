import twilio from "twilio";
import { config } from "../config.js";
import { WindowClosedError, type SendResult, type WhatsAppProvider } from "./provider.js";

// Twilio error codes for "outside the 24h WhatsApp session window"
const WINDOW_CLOSED_CODES = new Set([63016, 63051]);

export class TwilioProvider implements WhatsAppProvider {
  private client = twilio(config.TWILIO_ACCOUNT_SID!, config.TWILIO_AUTH_TOKEN!);
  private from = config.TWILIO_WHATSAPP_FROM!;

  async send(to: string, body: string, from?: string): Promise<SendResult> {
    const sender = from ?? this.from;
    try {
      const msg = await this.client.messages.create({ from: sender, to, body });
      return { id: msg.sid };
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code && WINDOW_CLOSED_CODES.has(code)) throw new WindowClosedError();
      // Surface the Twilio code; without it a failed send is indistinguishable from a hang.
      throw new Error(`Twilio send failed from ${sender}${code ? ` (code ${code})` : ""}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async sendTemplate(to: string, contentSid: string, variables?: Record<string, string>): Promise<SendResult> {
    const msg = await this.client.messages.create({
      from: this.from,
      to,
      contentSid,
      contentVariables: variables ? JSON.stringify(variables) : undefined,
    });
    return { id: msg.sid };
  }
}

/** Validate that an inbound webhook really came from Twilio. */
export function validateSignature(signature: string | undefined, url: string, params: Record<string, string>): boolean {
  if (!signature) return false;
  return twilio.validateRequest(config.TWILIO_AUTH_TOKEN!, signature, url, params);
}
