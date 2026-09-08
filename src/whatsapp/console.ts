import type { SendResult, WhatsAppProvider } from "./provider.js";

/** Prints messages to stdout instead of sending. Use WHATSAPP_PROVIDER=console for local testing. */
export class ConsoleProvider implements WhatsAppProvider {
  private n = 0;
  async send(to: string, body: string, from?: string): Promise<SendResult> {
    console.log(`\n┌── WhatsApp ${from ?? "(default)"} → ${to} ──────────────────────────\n${body}\n└──────────────────────────────────────────────\n`);
    return { id: `console-${++this.n}` };
  }
  async sendTemplate(to: string, contentSid: string, variables?: Record<string, string>): Promise<SendResult> {
    console.log(`\n┌── WhatsApp TEMPLATE ${contentSid} → ${to} ${JSON.stringify(variables ?? {})}\n`);
    return { id: `console-tpl-${++this.n}` };
  }
}
