import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The commit this process is actually running, read from the checkout rather than
 * baked in at build time. Without it, a deploy that silently failed to restart looks
 * identical to one that worked.
 */
export function deployedCommit(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head.slice(0, 7);
    const ref = head.slice(5).trim();
    try {
      return readFileSync(join(root, ".git", ref), "utf8").trim().slice(0, 7);
    } catch {
      // The ref may be packed rather than loose.
      const packed = readFileSync(join(root, ".git", "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
      return line ? line.slice(0, 7) : "unknown";
    }
  } catch {
    return "unknown";
  }
}

export const COMMIT = deployedCommit();
export const STARTED_AT = new Date().toISOString();
