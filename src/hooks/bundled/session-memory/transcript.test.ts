import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { sanitizeModelOutput, getRecentSessionContent } from "./transcript.js";

/**
 * Unit tests for sanitizeModelOutput() and related transcript utilities.
 * These tests cover the fix for GitHub issue #71031:
 * "session-memory hook saves raw model output (chat-template tokens, NO_REPLY)
 * to memory files, progressively degrading agent responsiveness"
 */
describe("sanitizeModelOutput", () => {
  // --- NO_REPLY token stripping ---

  it("strips standalone [NO_REPLY] token", () => {
    expect(sanitizeModelOutput("[NO_REPLY]")).toBe("");
  });

  it("strips [NO_REPLY] at end of response", () => {
    expect(sanitizeModelOutput("Here's my answer.\n[NO_REPLY]")).toBe("Here's my answer.");
  });

  it("strips multiple [NO_REPLY] tokens", () => {
    expect(sanitizeModelOutput("[NO_REPLY]\n[NO_REPLY]\n[NO_REPLY]")).toBe("");
  });

  it("strips [no_reply] case-insensitively", () => {
    expect(sanitizeModelOutput("[no_reply]")).toBe("");
    expect(sanitizeModelOutput("[No_Reply]")).toBe("");
  });

  // --- OpenClaw metadata token stripping ---

  it("strips [AUDIO_AS_VOICE] metadata token", () => {
    expect(sanitizeModelOutput("Hello there[NO_REPLY]\n[AUDIO_AS_VOICE]")).toBe("Hello there");
  });

  it("strips single-bracket [reply_to_current] delivery tag", () => {
    // Single-bracket form
    expect(sanitizeModelOutput("Sure thing[reply_to_current] Done.")).toBe("Sure thing Done.");
  });

  it("strips [reply_to:xxx] delivery tags", () => {
    expect(sanitizeModelOutput("Answer[reply_to:12345].")).toBe("Answer.");
  });

  // --- Generic chat-template token stripping ---

  it("strips [REMOVED_SPECIAL_TOKEN]", () => {
    expect(sanitizeModelOutput("[REMOVED_SPECIAL_TOKEN]")).toBe("");
  });

  it("strips [REMOVED_SPECIAL_TOKEN] embedded in text", () => {
    const input = "User asked about pets[REMOVED_SPECIAL_TOKEN]The cat is fine.";
    expect(sanitizeModelOutput(input)).toBe("User asked about petsThe cat is fine.");
  });

  it("strips [UNUSED_TOKEN] and [PAD_TOKEN]", () => {
    expect(sanitizeModelOutput("[UNUSED_TOKEN]")).toBe("");
    expect(sanitizeModelOutput("[PAD_TOKEN]")).toBe("");
  });

  it("strips [EXTRA_TOKEN_123] style tokens", () => {
    expect(sanitizeModelOutput("[EXTRA_TOKEN_42]")).toBe("");
  });

  it("strips [SYSTEM_PROMPT_0] style tokens", () => {
    expect(sanitizeModelOutput("[SYSTEM_PROMPT_0]")).toBe("");
  });

  // --- Anthropic-style template markers ---

  it("strips <|im_start|> and <|im_end|>", () => {
    expect(sanitizeModelOutput("<|im_start|>user\nHello<|im_end|>")).toBe("user\nHello");
  });

  it("strips <|provider|> markers", () => {
    expect(sanitizeModelOutput("Response<|provider|>")).toBe("Response");
  });

  it("strips <|reserved_xxx|> tokens", () => {
    expect(sanitizeModelOutput("Text<|reserved_200|>")).toBe("Text");
  });

  // --- Tool-call XML block stripping ---

  it("strips <tool_call> XML blocks", () => {
    const input =
      'I\'ll search for that.<tool_call>{"name": "search", "input": {"query": "cats"}}</tool_call>Done.';
    expect(sanitizeModelOutput(input)).toBe("I'll search for that.Done.");
  });

  it('strips <invoke name="..."> XML blocks', () => {
    const input =
      'Before<invoke name="web_search"><parameter name="query">test</parameter></invoke>After';
    expect(sanitizeModelOutput(input)).toBe("BeforeAfter");
  });

  it("strips <tool_> XML blocks", () => {
    const input = "Result<tool_><name>test</name></tool_>End";
    expect(sanitizeModelOutput(input)).toBe("ResultEnd");
  });

  // --- Thinking block stripping ---

  it("strips <think>...</think> blocks", () => {
    const input = "Answer<think>I need to calculate 2+2</think>2 plus 2 is 4.";
    expect(sanitizeModelOutput(input)).toBe("Answer2 plus 2 is 4.");
  });

  it("strips <reasoning>...</reasoning> blocks", () => {
    const input = "Result<reasoning>Let me think...</reasoning>Final answer.";
    expect(sanitizeModelOutput(input)).toBe("ResultFinal answer.");
  });

  // --- RAG / retrieval marker stripping ---

  it("strips <<[Document ...]>> retrieval markers", () => {
    const input = 'Based on <<[Document id=1 content="some facts"]>> the answer is yes.';
    expect(sanitizeModelOutput(input)).toBe("Based on the answer is yes.");
  });

  it("strips <retrieved_context> blocks", () => {
    const input = "Answer<retrieved_context>Some context here</retrieved_context>End.";
    expect(sanitizeModelOutput(input)).toBe("AnswerEnd.");
  });

  // --- Whitespace normalization ---

  it("normalizes multiple blank lines to at most two", () => {
    const input = "Line 1\n\n\n\n\nLine 2";
    expect(sanitizeModelOutput(input)).toBe("Line 1\n\nLine 2");
  });

  it("trims leading/trailing whitespace from each line and overall", () => {
    const input = "  Hello  \n  World  \n";
    expect(sanitizeModelOutput(input)).toBe("Hello\nWorld");
  });

  // --- Non-affected content preservation ---

  it("preserves normal conversation text unchanged", () => {
    const input = "user: Hello, how are you?\nassistant: I'm doing well, thanks!";
    expect(sanitizeModelOutput(input)).toBe(input);
  });

  it("preserves code blocks and special characters", () => {
    const input = "Here's some code: `const x = 42;` and symbols: @#$%^&*()";
    expect(sanitizeModelOutput(input)).toBe(input);
  });

  it("handles empty string gracefully", () => {
    expect(sanitizeModelOutput("")).toBe("");
  });

  it("handles string with only whitespace", () => {
    expect(sanitizeModelOutput("   \n\n  ")).toBe("");
  });

  // --- Integration-style tests ---

  it("cleans a real-looking poisoned assistant message", () => {
    const poisoned =
      "I'll help you with that.\n" +
      "<think>I need to check the documentation</think>\n" +
      "The answer is 42.\n" +
      "[NO_REPLY]\n" +
      "[AUDIO_AS_VOICE]";
    // Tokens and thinking blocks are stripped; blank lines may remain from multi-line thinking removal
    const result = sanitizeModelOutput(poisoned);
    expect(result).toContain("I'll help you with that.");
    expect(result).toContain("The answer is 42.");
    expect(result).not.toContain("[NO_REPLY]");
    expect(result).not.toContain("[AUDIO_AS_VOICE]");
    expect(result).not.toContain("<think>");
  });

  it("cleans multi-token poisoning with template + tool blocks", () => {
    const poisoned =
      'Before <tool_call>{"name": "test"}</tool_call> after ' +
      "[REMOVED_SPECIAL_TOKEN] and [NO_REPLY] done.";
    // Tokens and XML are stripped; key content is preserved
    const result = sanitizeModelOutput(poisoned);
    expect(result).toContain("Before");
    expect(result).toContain("after");
    expect(result).toContain("and");
    expect(result).toContain("done.");
    expect(result).not.toContain("tool_call");
    expect(result).not.toContain("[REMOVED_SPECIAL_TOKEN]");
    expect(result).not.toContain("[NO_REPLY]");
  });
});

/**
 * Integration tests for getRecentSessionContent with sanitization.
 * These verify that poisoned content from the session transcript is
 * properly cleaned before being returned for memory file writing.
 */
describe("getRecentSessionContent sanitization integration", () => {
  async function writeTempSession(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sanitize-test-"));
    const sessionFile = await writeWorkspaceFile({
      dir,
      name: "session.jsonl",
      content,
    });
    return sessionFile;
  }

  it("sanitizes NO_REPLY tokens from assistant messages in transcript", async () => {
    const sessionFile = await writeTempSession(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Hello" },
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Hi there[NO_REPLY]" },
        }),
    );
    const result = await getRecentSessionContent(sessionFile, 10);
    expect(result).toBe("user: Hello\nassistant: Hi there");
  });

  it("sanitizes template tokens from assistant messages in transcript", async () => {
    const sessionFile = await writeTempSession(
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Answer[REMOVED_SPECIAL_TOKEN]42" },
      }),
    );
    const result = await getRecentSessionContent(sessionFile, 10);
    expect(result).toBe("assistant: Answer42");
  });

  it("sanitizes audio metadata token from poisoned message", async () => {
    const sessionFile = await writeTempSession(
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Sure.\n[AUDIO_AS_VOICE][NO_REPLY]" },
      }),
    );
    const result = await getRecentSessionContent(sessionFile, 10);
    expect(result).toBe("assistant: Sure.");
  });

  it("sanitizes tool-call XML blocks leaking into message content", async () => {
    const sessionFile = await writeTempSession(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content:
            'I\'ll search.<tool_call>{"name": "web_search", "input": {}}</tool_call>Found it.',
        },
      }),
    );
    const result = await getRecentSessionContent(sessionFile, 10);
    expect(result).toBe("assistant: I'll search.Found it.");
  });

  it("skips assistant messages that become empty after sanitization", async () => {
    const sessionFile = await writeTempSession(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Hello" },
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "[NO_REPLY]" },
        }),
    );
    const result = await getRecentSessionContent(sessionFile, 10);
    // Empty messages after sanitization should not be added
    expect(result).toBe("user: Hello");
  });
});
