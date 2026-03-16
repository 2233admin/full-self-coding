/**
 * Detect when AI output is conversational prose instead of code.
 * Used to validate Tier 3 (AI resolve) output.
 */

const CONVERSATIONAL_OPENERS = [
  /^(I |Here |Let me |Sure|Of course|Certainly|Based on|Looking at|The |This )/im,
  /^(I'm sorry|I cannot|I can't|Unfortunately)/im,
];

const PROSE_INDICATORS = [
  /\bI (would|suggest|recommend|think|believe|can)\b/i,
  /\bhere('s| is| are) (the|a|an|your)\b/i,
  /\blet me (explain|show|help|walk)\b/i,
  /\bplease (note|be aware|consider)\b/i,
];

/**
 * Returns true if the output looks like conversational prose
 * rather than raw file content.
 *
 * The AI was instructed to output ONLY the merged file content.
 * Any conversational framing means it didn't follow instructions.
 */
export function looksLikeProse(output: string): boolean {
  const trimmed = output.trim();

  // Empty output is not prose, but also not valid
  if (!trimmed) return false;

  // Check conversational openers (first line)
  const firstLine = trimmed.split("\n")[0];
  for (const pattern of CONVERSATIONAL_OPENERS) {
    if (pattern.test(firstLine)) return true;
  }

  // Check prose indicators anywhere in output
  let proseHits = 0;
  for (const pattern of PROSE_INDICATORS) {
    if (pattern.test(trimmed)) proseHits++;
  }

  // 2+ prose indicators = likely prose
  return proseHits >= 2;
}
