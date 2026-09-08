import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { config } from "../config.js";

/**
 * Vertex AI client. On a Compute Engine VM this authenticates with the instance's
 * own service account through Application Default Credentials, so there is no API
 * key to store or rotate. Locally, `gcloud auth application-default login` works.
 */
export const genai = new GoogleGenAI({
  vertexai: true,
  ...(config.GOOGLE_CLOUD_PROJECT ? { project: config.GOOGLE_CLOUD_PROJECT } : {}),
  location: config.GOOGLE_CLOUD_LOCATION,
});

export const MODEL = config.GEMINI_MODEL;
export { ThinkingLevel };
