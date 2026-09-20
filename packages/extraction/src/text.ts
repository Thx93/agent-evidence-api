/**
 * Text normalisation primitives shared by extraction and evidence ranking.
 *
 * Everything in this module is deterministic and side-effect free: the same
 * input always produces the same output, on any machine, with no locale or
 * clock dependency (SPEC section 7, "use deterministic processing wherever
 * practical").
 */
import { createHash } from "node:crypto";

/**
 * C0/C1 control characters that carry no meaning in extracted text.
 *
 * `\t` (0x09) and `\n` (0x0A) are deliberately *not* included: tabs are
 * whitespace and are collapsed later, and newlines are handled explicitly by
 * {@link normalizeLines}. `\r` (0x0D) is handled by the line-ending
 * normalisation step.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Collapse whitespace, normalise line endings, strip control chars.
 *
 * - CRLF and lone CR become LF.
 * - Control characters are replaced by a single space (rather than deleted) so
 *   that `"foo\u0000bar"` normalises to `"foo bar"` and never to the invented
 *   word `"foobar"`.
 * - Every run of whitespace (including newlines) collapses to one space and the
 *   result is trimmed.
 *
 * Because newlines collapse here, this function is for *single-value* fields
 * such as `title`, `language`, or a date string. Multi-line content (the body
 * text) goes through {@link normalizeLines} so paragraph boundaries survive.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalise text while preserving line structure.
 *
 * Returns one entry per non-empty line, with CRLF normalised to LF, control
 * characters stripped, and horizontal whitespace collapsed and trimmed. Empty
 * (or whitespace-only) lines are dropped, so the array contains no blank
 * entries. This is the representation used for `mainText`, where line breaks
 * are meaningful block separators.
 */
export function normalizeLines(input: string): string[] {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/** sha256 hex of a UTF-8 string. */
export function hashContent(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
