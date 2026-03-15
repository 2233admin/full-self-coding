/**
 * API key setup for integration tests.
 * Set environment variables before running: ANTHROPIC_API_KEY, GEMINI_API_KEY
 */

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
export const CLAUDE_CODE_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const CLAUDE_CODE_API_URL = process.env.ANTHROPIC_API_BASE_URL ?? "https://api.anthropic.com";
