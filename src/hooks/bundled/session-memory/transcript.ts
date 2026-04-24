import fs from "node:fs/promises";
import path from "node:path";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";

function extractTextMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  return undefined;
}

/**
 * Sanitize raw model output to strip chat-template artifacts, housekeeping tokens,
 * and other content that should not be saved to memory files.
 *
 * This prevents the progressive degradation loop described in GitHub issue #71031:
 * raw model output (template tokens, NO_REPLY markers, tool-call XML) saved to
 * memory files gets re-injected on /new, causing the model to interpret embedded
 * role markers as in-progress scaffolding and produce more malformed output.
 *
 * @param text Raw text content from model output
 * @returns Sanitized text safe for memory file storage
 */
export function sanitizeModelOutput(text: string): string {
  if (!text) {
    return text;
  }

  let sanitized = text;

  // Strip NO_REPLY token (OpenClaw housekeeping convention)
  sanitized = sanitized.replace(/\[NO_REPLY\]/gi, "");

  // Strip metadata delivery tags that leak channel metadata into memory
  sanitized = sanitized.replace(/\[AUDIO_AS_VOICE\]/gi, "");
  sanitized = sanitized.replace(/\[reply_to(?:_current|:[^\]]+)?\]/gi, "");

  // Strip double-bracket reply tag variants
  sanitized = sanitized.replace(/\[{2}reply_to(?:_current|:[^\]]+)?\]{2}/gi, "");
  sanitized = sanitized.replace(/\[{2}audio_as_voice\]{2}/gi, "");

  // Remove any empty bracket pairs left behind by token stripping
  sanitized = sanitized.replace(/\[\s*\]/g, "");

  // Strip generic chat-template control tokens (various model families)
  sanitized = sanitized.replace(/\[REMOVED[_\s]SPECIAL[_\s]TOKEN\]/gi, "");
  sanitized = sanitized.replace(/\[UNUSED[_\s]TOKEN\]/gi, "");
  sanitized = sanitized.replace(/\[PAD[_\s]TOKEN\]/gi, "");
  sanitized = sanitized.replace(/\[CLS[_\s]TOKEN\]/gi, "");
  sanitized = sanitized.replace(/\[SEP[_\s]TOKEN\]/gi, "");
  sanitized = sanitized.replace(/\[MASK[_\s]TOKEN\]/gi, "");
  sanitized = sanitized.replace(/\[EXTRA[_\s]TOKEN[_\s]\d+\]/gi, "");
  sanitized = sanitized.replace(/\[SYSTEM[_\s]PROMPT[_\s]\d+\]/gi, "");

  // Strip Anthropic-style template tokens (if model outputs them raw)
  sanitized = sanitized.replace(/<\|im_start\|>/gi, "");
  sanitized = sanitized.replace(/<\|im_end\|>/gi, "");
  sanitized = sanitized.replace(/<\|provider\|>/gi, "");
  sanitized = sanitized.replace(/<\|reserved_[^|]+\|>/gi, "");

  // Strip Anthropic-style special content blocks if they leak into message content
  sanitized = sanitized.replace(/<\|message\|>[\s\S]*?<\|message_end\|>/gi, "");

  // Strip tool-call XML blocks that may leak from function-calling models
  sanitized = sanitized.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  sanitized = sanitized.replace(/<invoke\s+name="[^"]*">[\s\S]*?<\/invoke>/gi, "");
  sanitized = sanitized.replace(/<tool_>[\s\S]*?<\/tool_>/gi, "");

  // Strip thinking blocks (some models output raw think tags)
  sanitized = sanitized.replace(/<think>[\s\S]*?<\/think>/gi, "");
  sanitized = sanitized.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");

  // Strip content within obvious RAG/retrieval markers that leak system context
  // Matches: <<[Document id=1 content="some facts"]>> with optional trailing whitespace
  sanitized = sanitized.replace(/<<\[Document[^\]]*\]\s*>>\s*/gi, "");
  sanitized = sanitized.replace(/<retrieved_context>[\s\S]*?<\/retrieved_context>/gi, "");

  // Normalize multiple consecutive blank lines (artifact from stripping)
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

  // Strip leading/trailing whitespace from each line, then trim overall
  sanitized = sanitized
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

  return sanitized;
}

export async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    const allMessages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message as {
            role?: unknown;
            content?: unknown;
            provenance?: unknown;
          };
          const role = msg.role;
          if ((role === "user" || role === "assistant") && "content" in msg && msg.content) {
            if (role === "user" && hasInterSessionUserProvenance(msg)) {
              continue;
            }
            const rawText = extractTextMessageContent(msg.content);
            if (!rawText || rawText.startsWith("/")) {
              continue;
            }
            // Sanitize model output before saving to memory to prevent the degradation
            // loop described in GitHub issue #71031.
            const text = sanitizeModelOutput(rawText);
            if (text) {
              allMessages.push(`${role}: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines.
      }
    }

    return allMessages.slice(-messageCount).join("\n");
  } catch {
    return null;
  }
}

export async function getRecentSessionContentWithResetFallback(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  const primary = await getRecentSessionContent(sessionFilePath, messageCount);
  if (primary) {
    return primary;
  }

  try {
    const dir = path.dirname(sessionFilePath);
    const base = path.basename(sessionFilePath);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resetCandidates = files.filter((name) => name.startsWith(resetPrefix)).toSorted();

    if (resetCandidates.length === 0) {
      return primary;
    }

    const latestResetPath = path.join(dir, resetCandidates[resetCandidates.length - 1]);
    return (await getRecentSessionContent(latestResetPath, messageCount)) || primary;
  } catch {
    return primary;
  }
}

export function stripResetSuffix(fileName: string): string {
  const resetIndex = fileName.indexOf(".reset.");
  return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}

export async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);

    const baseFromReset = params.currentSessionFile
      ? stripResetSuffix(path.basename(params.currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) {
      return path.join(params.sessionsDir, baseFromReset);
    }

    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const canonicalFile = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonicalFile)) {
        return path.join(params.sessionsDir, canonicalFile);
      }

      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }
    }

    if (!params.currentSessionFile) {
      return undefined;
    }

    const nonResetJsonl = files
      .filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
      .toSorted()
      .toReversed();
    if (nonResetJsonl.length > 0) {
      return path.join(params.sessionsDir, nonResetJsonl[0]);
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}
