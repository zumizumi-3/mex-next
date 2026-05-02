/**
 * Edit-diff computation.
 *
 * When the customer edits a draft (original → final) we record the diff
 * as an *exemplar* in `account.json::writing_exemplars`. Future draft
 * generations include these exemplars in the prompt so the model
 * learns "this customer's voice".
 *
 * We use a line-based LCS diff because:
 *  - X posts are typically short, line-level granularity is enough
 *  - LCS is deterministic (same input → same diff, easy to test)
 *  - JSON-friendly output (arrays of lines, not unified-diff strings)
 *
 * Mirrors the structured `compute_edit_diff` in the Python repo.
 */

export interface DiffHunk {
  /** 'context' | 'added' | 'removed'. */
  kind: 'context' | 'added' | 'removed';
  text: string;
}

export interface EditDiff {
  /** Original draft (pre-edit). */
  original: string;
  /** Final text (post-edit). */
  final: string;
  /** Line-level hunks in order. */
  hunks: DiffHunk[];
  /**
   * High-level summary counts for quick logging / scoring without
   * having to walk the hunk array.
   */
  summary: {
    addedLines: number;
    removedLines: number;
    contextLines: number;
    /** final.length - original.length. Negative = trimmed. */
    charDelta: number;
    /** True iff original === final after trim — a no-op edit. */
    noop: boolean;
  };
}

/**
 * Compute the longest-common-subsequence of two line arrays. Returns
 * the LCS length matrix; we then walk it to extract the diff.
 *
 * O(n*m) time/space — fine for our typical input sizes (<10 lines).
 */
function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }
  return table;
}

/**
 * Walk the LCS table backwards to produce a hunk list. We emit
 * removals before additions in the same position so the result reads
 * naturally top-to-bottom in UI surfaces.
 */
function buildHunks(a: readonly string[], b: readonly string[], table: readonly number[][]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      hunks.push({ kind: 'context', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      hunks.push({ kind: 'added', text: b[j - 1] });
      j--;
    } else if (i > 0) {
      hunks.push({ kind: 'removed', text: a[i - 1] });
      i--;
    }
  }
  hunks.reverse();
  return hunks;
}

/**
 * Compute a structured edit-diff between original and final text.
 *
 * Determinism: equal inputs always produce equal output (relied on by
 * tests + by the exemplar dedup logic in `_save_exemplar`).
 */
export function computeEditDiff(original: string, final: string): EditDiff {
  const a = original.split('\n');
  const b = final.split('\n');
  const table = lcsTable(a, b);
  const hunks = buildHunks(a, b, table);

  const addedLines = hunks.filter((h) => h.kind === 'added').length;
  const removedLines = hunks.filter((h) => h.kind === 'removed').length;
  const contextLines = hunks.filter((h) => h.kind === 'context').length;

  return {
    original,
    final,
    hunks,
    summary: {
      addedLines,
      removedLines,
      contextLines,
      charDelta: final.length - original.length,
      noop: original.trim() === final.trim(),
    },
  };
}
