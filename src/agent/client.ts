import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

// Resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile from the environment.
export const anthropic = new Anthropic({ timeout: 10 * 60 * 1000, maxRetries: 3 });
export const MODEL = config.CLAUDE_MODEL;

/** Server-side refusal fallback: if a safety classifier declines, the API re-runs on a fallback model. */
export const FALLBACK_PARAMS = {
  betas: ["server-side-fallback-2026-07-01"] as Anthropic.AnthropicBeta[],
  fallbacks: "default" as const,
};

export function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
