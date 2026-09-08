import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { config } from "../config.js";
import { log } from "../logger.js";

export const MODEL = config.GEMINI_MODEL;
export { ThinkingLevel };

/** True for Gemini 3 and newer, which use thinkingLevel rather than a token budget. */
const USES_THINKING_LEVEL = /^gemini-(?:[3-9]|\d{2})/.test(config.GEMINI_MODEL);

/**
 * Thinking config for the configured model family.
 *
 * Gemini 3 takes a qualitative `thinkingLevel`; Gemini 2.5 takes a `thinkingBudget`
 * in tokens, where -1 lets the model decide. Sending the wrong one is rejected.
 */
export function thinkingFor(effort: "low" | "high") {
  if (USES_THINKING_LEVEL) {
    return { thinkingLevel: effort === "high" ? ThinkingLevel.HIGH : ThinkingLevel.LOW };
  }
  return { thinkingBudget: effort === "high" ? 8192 : -1 };
}

const METADATA_PROJECT_URL = "http://metadata.google.internal/computeMetadata/v1/project/project-id";

let projectPromise: Promise<string> | undefined;
let client: GoogleGenAI | undefined;

/** Ask the GCE metadata server which project this VM belongs to. Undefined off-VM. */
async function projectFromMetadata(): Promise<string | undefined> {
  try {
    const res = await fetch(METADATA_PROJECT_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    return (await res.text()).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveProject(): Promise<string> {
  projectPromise ??= (async () => {
    const configured = config.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    if (configured) return configured;
    const detected = await projectFromMetadata();
    if (detected) {
      log.info(`Detected Google Cloud project from instance metadata: ${detected}`);
      return detected;
    }
    throw new Error(
      "No Google Cloud project. Set GOOGLE_CLOUD_PROJECT in .env, or run on a Compute Engine VM where it can be read from instance metadata.",
    );
  })();
  return projectPromise;
}

/**
 * Vertex AI client, built on first use rather than at import.
 *
 * Constructing it eagerly meant a missing project crashed the process on startup,
 * taking down the web server and every CLI command with it, including the ones
 * that never call the model.
 */
export async function getClient(): Promise<GoogleGenAI> {
  if (client) return client;
  client = new GoogleGenAI({
    vertexai: true,
    project: await resolveProject(),
    location: config.GOOGLE_CLOUD_LOCATION,
  });
  return client;
}
