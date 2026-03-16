/**
 * Conflict marker parser for 4-tier merge resolution.
 * Parses git conflict markers and provides resolution helpers.
 */

export interface ConflictChunk {
  /** Line offset in original file (0-based) */
  startLine: number;
  /** Content from HEAD (canonical/target branch) */
  ours: string;
  /** Content from incoming (agent/source branch) */
  theirs: string;
}

const MARKER_OURS = /^<{7}\s/;
const MARKER_SEPARATOR = /^={7}$/;
const MARKER_THEIRS = /^>{7}\s/;

/**
 * Parse conflict markers from file content.
 * Returns empty array if no conflicts found.
 */
export function parseConflictMarkers(content: string): ConflictChunk[] {
  const lines = content.split("\n");
  const chunks: ConflictChunk[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!MARKER_OURS.test(lines[i])) {
      i++;
      continue;
    }

    const startLine = i;
    const oursLines: string[] = [];
    const theirsLines: string[] = [];
    let inOurs = true;
    i++; // skip <<<<<<< line

    while (i < lines.length) {
      if (MARKER_SEPARATOR.test(lines[i])) {
        inOurs = false;
        i++;
        continue;
      }
      if (MARKER_THEIRS.test(lines[i])) {
        break;
      }
      if (inOurs) {
        oursLines.push(lines[i]);
      } else {
        theirsLines.push(lines[i]);
      }
      i++;
    }

    chunks.push({
      startLine,
      ours: oursLines.join("\n"),
      theirs: theirsLines.join("\n"),
    });
    i++; // skip >>>>>>> line
  }

  return chunks;
}

/**
 * Check if the HEAD (canonical) side has non-whitespace content.
 * If true, we should NOT silently discard it via keep-incoming.
 */
export function hasContentfulCanonical(chunk: ConflictChunk): boolean {
  return chunk.ours.trim().length > 0;
}

/**
 * Resolve all conflicts in file by keeping incoming (agent) side.
 * Only safe when hasContentfulCanonical is false for all chunks,
 * or when the caller has decided keep-incoming is acceptable.
 */
export function resolveKeepIncoming(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!MARKER_OURS.test(lines[i])) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Skip ours section + separator
    i++; // skip <<<<<<< line
    while (i < lines.length && !MARKER_SEPARATOR.test(lines[i])) {
      i++;
    }
    i++; // skip ======= line

    // Keep theirs section
    while (i < lines.length && !MARKER_THEIRS.test(lines[i])) {
      result.push(lines[i]);
      i++;
    }
    i++; // skip >>>>>>> line
  }

  return result.join("\n");
}
