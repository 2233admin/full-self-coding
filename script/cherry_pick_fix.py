"""cherry_pick_fix -- Targeted repair of LLM-generated text.

Pattern origin: JuliusBrussee/caveman (caveman-compress/scripts/compress.py),
MIT-licensed, 2026-04. Adapted and generalized here as a reusable utility.

Core idea
---------
When an LLM produces output that fails validation, the naive fix is to
re-run the original prompt with a more detailed instruction. That wastes
tokens (the LLM re-reads the full input and re-derives unaffected
sections) and often drifts further from the original because the second
pass is another creative generation.

Cherry-pick fix instead feeds the LLM THREE things:
  1. the original (read-only reference)
  2. the current broken output (to be patched)
  3. a concrete list of validation errors (what to fix)

The fix-prompt explicitly tells the LLM: do not re-generate, do not
re-phrase, only patch the listed errors using the original as a source of
truth. Untouched sections must remain byte-identical to the current
broken output.

When to use
-----------
Good fit:
  - LLM output is mostly correct but fails a structural check
    (missing URL, dropped heading, code block not preserved,
    frontmatter stripped, wikilink broken).
  - You can cheaply enumerate the specific errors locally
    (regex, parser, schema diff).
  - The corrupt output is long enough that re-generating is wasteful.

Bad fit:
  - Output is fundamentally wrong (hallucinated facts, wrong format).
    Cherry-pick cannot recover from "the model misunderstood the task".
    Use a full regeneration with a clearer prompt instead.
  - Errors are not enumerable -- "this feels wrong" is not a fix target.
  - The valid-content:broken-content ratio is low (<50%). Regeneration
    is cheaper when most of the output is bad.

Comparison to naive retry
-------------------------
              | naive retry          | cherry-pick fix
  ------------|----------------------|---------------------------
  tokens in   | full prompt again    | original + broken + errors
  tokens out  | full regeneration    | full broken (mostly copy)
  convergence | can diverge each try | monotonic towards correct
  side effect | unrelated drift      | scoped to listed errors

Convergence property
--------------------
Cherry-pick fix is convergent in practice (not provable theoretically).
Because the prompt pins untouched sections to the current broken output
and forbids re-phrasing, each fix pass should strictly reduce the error
set -- assuming the validator is deterministic and the LLM obeys the
"do not touch untouched sections" rule. In caveman's benchmark runs,
2 retries are sufficient for ~95% of cases; the 5% that fail 2 retries
usually fail 10 retries too (the error is not cherry-pickable).

Use max_retries=2 as the caveman default. Raising it rarely helps.

Usage
-----
    from cherry_pick_fix import cherry_pick_fix

    def my_llm(prompt: str) -> str:
        # Your Claude/Codex/Gemini call here.
        return call_anthropic_sdk(prompt)

    def my_validator(original: str, output: str) -> list[str]:
        errors = []
        if extract_urls(original) != extract_urls(output):
            errors.append("URL mismatch")
        if extract_headings(original) != extract_headings(output):
            errors.append("Heading mismatch")
        return errors

    original = open("CLAUDE.md").read()
    initial_output = my_llm(f"Compress this: {original}")
    errors = my_validator(original, initial_output)

    fixed, ok = cherry_pick_fix(
        original=original,
        llm_output=initial_output,
        validation_errors=errors,
        llm_call=my_llm,
        max_retries=2,
    )
    if not ok:
        # Fall back: restore original or abort.
        fixed = original
"""

from __future__ import annotations

from typing import Callable

__all__ = ["cherry_pick_fix", "build_fix_prompt"]


def build_fix_prompt(original: str, broken: str, errors: list[str]) -> str:
    """Build the cherry-pick fix prompt.

    Template is derived from caveman-compress/scripts/compress.py. The
    key discipline is: original is REFERENCE ONLY, the LLM patches the
    broken version, and the error list is the sole scope of change.
    """
    errors_str = "\n".join(f"- {e}" for e in errors) if errors else "- (none listed)"
    return f"""You are fixing a generated text file. Specific validation errors were found.

CRITICAL RULES:
- DO NOT regenerate or rephrase the file
- ONLY fix the listed errors -- leave everything else exactly as-is
- The ORIGINAL is provided as reference only (to restore missing content)
- Preserve the existing style in all untouched sections
- Return byte-identical content for any section not mentioned in errors

ERRORS TO FIX:
{errors_str}

HOW TO FIX:
- Missing URL: find it in ORIGINAL, restore it exactly where it belongs in BROKEN
- Missing code block: find the exact code block in ORIGINAL, restore it in BROKEN
- Missing heading: restore the exact heading text from ORIGINAL into BROKEN
- Missing frontmatter: restore the '---' block from ORIGINAL to top of BROKEN
- Broken wikilink: restore the [[...]] from ORIGINAL
- Do not touch any section not mentioned in the errors

ORIGINAL (reference only):
{original}

BROKEN (fix this):
{broken}

Return ONLY the fixed file. No explanation. No preamble. No code fences around the output.
"""


def cherry_pick_fix(
    original: str,
    llm_output: str,
    validation_errors: list[str],
    llm_call: Callable[[str], str],
    max_retries: int = 2,
    revalidate: Callable[[str, str], list[str]] | None = None,
) -> tuple[str, bool]:
    """Cherry-pick fix an LLM-generated output that failed validation.

    Args:
        original: The source text the LLM was asked to transform.
        llm_output: The current (broken) LLM output to be patched.
        validation_errors: Initial list of errors found in llm_output.
        llm_call: A sync function that takes a prompt and returns the
            LLM's response text. You own auth, retries on network
            errors, and rate limiting.
        max_retries: Maximum cherry-pick passes. Default 2 matches
            caveman's empirical sweet spot.
        revalidate: Optional. A callable(original, current) -> errors
            that re-checks the output after each fix pass. If None,
            cherry_pick_fix runs exactly one fix pass and returns its
            result (caller must re-validate).

    Returns:
        A tuple (fixed_text, success). success is True if:
          - there were no initial errors (nothing to fix, returns input), or
          - revalidate is provided and the final error list is empty, or
          - revalidate is None and one fix pass completed without exception.
        success is False if:
          - max_retries exhausted with revalidate still returning errors.

    Notes:
        If the LLM call raises, the exception propagates. We do not
        retry on network errors -- that is the caller's responsibility.
        On LLM exception, the last good output is lost; wrap accordingly.
    """
    if not validation_errors:
        return (llm_output, True)

    current = llm_output
    errors = list(validation_errors)

    for attempt in range(max_retries):
        prompt = build_fix_prompt(original, current, errors)
        current = llm_call(prompt)

        if revalidate is None:
            # Single-pass mode: trust the fix and return.
            return (current, True)

        errors = revalidate(original, current)
        if not errors:
            return (current, True)

    # Exhausted retries with remaining errors.
    return (current, False)
