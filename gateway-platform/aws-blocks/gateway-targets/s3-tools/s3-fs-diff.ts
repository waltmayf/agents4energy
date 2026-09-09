// SEARCH/REPLACE diff format for the ApplyDiff filesystem tool (issue #240).
//
// Format (Aider / Cline / Roo-Code "apply_diff" style — content-keyed, not
// line-number-keyed, since models are unreliable with line numbers):
//
//   <<<<<<< SEARCH
//   :start_line:<N>          (optional hint; NOT trusted — used only to break ties)
//   -------
//   <exact existing content>
//   =======
//   <replacement content>
//   >>>>>>> REPLACE
//
// Multiple blocks may appear in one diff; they're applied top-to-bottom
// against the evolving buffer. An empty SEARCH block against a non-existent
// file creates it with the REPLACE body as its full content.

export class DiffFormatError extends Error {}
export class DiffApplyError extends Error {}

export interface DiffBlock {
  startLineHint: number | null;
  search: string;
  replace: string;
}

const RE_SEARCH_START = /^<<<<<<< SEARCH>?\s*$/;
const RE_START_LINE = /^:start_line:(\d+)\s*$/;
const RE_SEP = /^-------\s*$/;
const RE_DIVIDER = /^=======\s*$/;
const RE_REPLACE_END = /^>>>>>>> REPLACE\s*$/;

function isMarkerLine(line: string): boolean {
  return (
    RE_SEARCH_START.test(line)
    || RE_START_LINE.test(line)
    || RE_SEP.test(line)
    || RE_DIVIDER.test(line)
    || RE_REPLACE_END.test(line)
  );
}

// A literal marker-like line inside SEARCH/REPLACE content is backslash-escaped
// in the diff (e.g. "\<<<<<<< SEARCH"). Strip exactly one leading backslash
// when the unescaped line would otherwise be mistaken for a marker.
function unescapeContentLine(line: string): string {
  if (line.startsWith('\\') && isMarkerLine(line.slice(1))) {
    return line.slice(1);
  }
  return line;
}

/** Parse one or more SEARCH/REPLACE blocks out of a raw diff string. */
export function parseSearchReplaceBlocks(diffText: string): DiffBlock[] {
  const lines = diffText.split(/\r\n|\r|\n/);
  const blocks: DiffBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!RE_SEARCH_START.test(lines[i])) {
      i++;
      continue;
    }
    i++; // consume "<<<<<<< SEARCH"

    let startLineHint: number | null = null;
    const hintMatch = i < lines.length ? RE_START_LINE.exec(lines[i]) : null;
    if (hintMatch) {
      startLineHint = parseInt(hintMatch[1], 10);
      i++;
      if (i < lines.length && RE_SEP.test(lines[i])) i++;
    } else if (i < lines.length && RE_SEP.test(lines[i])) {
      i++;
    }

    const searchLines: string[] = [];
    while (i < lines.length && !RE_DIVIDER.test(lines[i])) {
      searchLines.push(unescapeContentLine(lines[i]));
      i++;
    }
    if (i >= lines.length) {
      throw new DiffFormatError(`Unterminated SEARCH block ${blocks.length + 1}: missing "=======" divider`);
    }
    i++; // consume "======="

    const replaceLines: string[] = [];
    while (i < lines.length && !RE_REPLACE_END.test(lines[i])) {
      replaceLines.push(unescapeContentLine(lines[i]));
      i++;
    }
    if (i >= lines.length) {
      throw new DiffFormatError(`Unterminated REPLACE block ${blocks.length + 1}: missing ">>>>>>> REPLACE"`);
    }
    i++; // consume ">>>>>>> REPLACE"

    blocks.push({ startLineHint, search: searchLines.join('\n'), replace: replaceLines.join('\n') });
  }

  return blocks;
}

function normalize(str: string): string {
  return str
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length, 1);
  return 1 - levenshtein(a, b) / maxLen;
}

function allIndices(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

function multiMatchError(blockNum: number, count: number): DiffApplyError {
  return new DiffApplyError(`SEARCH block ${blockNum} matched ${count} locations — add more surrounding context`);
}

function noMatchError(blockNum: number): DiffApplyError {
  return new DiffApplyError(`no match found for SEARCH block ${blockNum}`);
}

/**
 * Locate the span of `buffer` that `block.search` refers to. Tries an exact
 * substring match first; falls back to a normalized, similarity-scored
 * line-window search (near the `:start_line:` hint first, then middle-out)
 * when no exact match exists.
 */
function findMatch(
  buffer: string,
  block: DiffBlock,
  blockNum: number,
  fuzzyThreshold: number,
): { start: number; end: number } {
  const rawMatches = allIndices(buffer, block.search);
  if (rawMatches.length === 1) {
    return { start: rawMatches[0], end: rawMatches[0] + block.search.length };
  }
  if (rawMatches.length > 1) {
    throw multiMatchError(blockNum, rawMatches.length);
  }

  const bufferLines = buffer.split('\n');
  const searchLines = block.search.split('\n');
  const windowSize = searchLines.length;
  if (bufferLines.length < windowSize) {
    throw noMatchError(blockNum);
  }

  const normalizedSearch = normalize(searchLines.join('\n'));
  const candidates: Array<{ start: number; score: number }> = [];
  for (let start = 0; start <= bufferLines.length - windowSize; start++) {
    const windowJoined = normalize(bufferLines.slice(start, start + windowSize).join('\n'));
    candidates.push({ start, score: similarity(windowJoined, normalizedSearch) });
  }

  const bestScore = Math.max(...candidates.map((c) => c.score));
  if (bestScore < fuzzyThreshold) {
    throw noMatchError(blockNum);
  }

  const topCandidates = candidates.filter((c) => c.score === bestScore);
  // Multiple normalized-exact matches are genuinely ambiguous, same as the raw
  // exact-match case above. Multiple merely-fuzzy ties are resolved by
  // proximity to the hint (or file middle) rather than treated as an error.
  if (bestScore >= 0.999 && topCandidates.length > 1) {
    throw multiMatchError(blockNum, topCandidates.length);
  }

  const targetLine = block.startLineHint != null
    ? block.startLineHint - 1
    : Math.floor((bufferLines.length - windowSize) / 2);
  topCandidates.sort((a, b) => Math.abs(a.start - targetLine) - Math.abs(b.start - targetLine));
  const chosenStart = topCandidates[0].start;

  const charStart = bufferLines
    .slice(0, chosenStart)
    .reduce((sum, line) => sum + line.length + 1, 0);
  const charEnd = charStart + bufferLines.slice(chosenStart, chosenStart + windowSize).join('\n').length;
  return { start: charStart, end: charEnd };
}

export interface ApplyDiffOptions {
  /** Similarity threshold (0..1) below which a fuzzy match is rejected. Default 1.0 (normalized-exact only) — lower to ~0.9 for lenient fuzzy matching. */
  fuzzyThreshold?: number;
}

export interface ApplyDiffResult {
  content: string;
  /** True if this call created a new file (via an empty SEARCH block). */
  created: boolean;
}

/**
 * Apply one or more SEARCH/REPLACE blocks to `originalContent` (undefined if
 * the target file doesn't exist yet). Blocks are applied top-to-bottom
 * against the evolving buffer.
 */
export function applyDiff(
  originalContent: string | undefined,
  diffText: string,
  opts: ApplyDiffOptions = {},
): ApplyDiffResult {
  const fuzzyThreshold = opts.fuzzyThreshold ?? 1.0;
  const blocks = parseSearchReplaceBlocks(diffText);
  if (blocks.length === 0) {
    throw new DiffFormatError('No SEARCH/REPLACE blocks found in diff');
  }

  let buffer = originalContent;
  let created = false;

  blocks.forEach((block, idx) => {
    const blockNum = idx + 1;

    if (block.search === '') {
      if (buffer === undefined) {
        buffer = block.replace;
        created = true;
        return;
      }
      if (buffer === '') {
        buffer = block.replace;
        return;
      }
      throw new DiffApplyError(
        `SEARCH block ${blockNum} is empty, but the file already has content — an empty SEARCH block may only be used to create a new file`,
      );
    }

    if (buffer === undefined) {
      throw new DiffApplyError(
        `SEARCH block ${blockNum} targets a file that does not exist — use an empty SEARCH block to create it`,
      );
    }

    const { start, end } = findMatch(buffer, block, blockNum, fuzzyThreshold);
    buffer = buffer.slice(0, start) + block.replace + buffer.slice(end);
  });

  return { content: buffer ?? '', created };
}
