# Preserve analyzer summary facts in HTML and Markdown reports

## Traceability

- Spec ID: html-summary-facts-companion
- Status: Implemented

## Intent

Qoder and Cursor reports keep machine-owned `summaryFacts` in an adjacent
`canvas.json`, which `harness render --findings` merges automatically. HTML and
Markdown had no equivalent carrier, so a model-authored `findings.json` that
omitted session, episode, usage, or learning facts rendered them as zero or
`not observed`. This change gives HTML and Markdown the same deterministic
companion without changing the Qoder/Cursor Canvas path.

## Acceptance Scenarios

- AC-1: `harness analyze --summary-out <file>` and `harness evidence-bundle
  --summary-out <file>` write a validated `summary-facts.json` from the exact
  analyzer summary facts.
- AC-2: `harness render --findings <findings.json>` in `html` and `markdown`
  modes discovers and merges an adjacent `summary-facts.json`. Qoder and Cursor
  keep using their adjacent `canvas.json`.
- AC-3: Machine summary facts override model-authored session, episode, usage,
  and learning counts; findings and dimensions remain model-authored.
- AC-4: A missing companion produces a `MISSING_SUMMARY_FACTS` warning instead
  of silently rendering collected data as zero.
- AC-5: A malformed or unsupported `summary-facts.json` fails closed, and the
  companion is preserved when render publishes a run directory.
- AC-6: The skill keeps `findings.json` and `summary-facts.json` in the same run
  directory and does not copy `summaryFacts` into findings.

## Non-goals

- Replacing the reviewed report source or source-review workflow.
- Changing Qoder/Cursor Canvas schema or precedence.
- Adding delivery, acceptance, or comparison evidence that the analyzer did not
  observe.

## Test and Review Evidence

- `test/reporting/harness-report-render-cli.test.mjs` covers summary-facts
  production, adjacent merge, missing-companion warning, Qoder Canvas
  regression, and the existing HTML coverage precedence.
- Real inspection of `my-context-cockpit` showed a complete bundle with 8
  selected sessions and 16 episodes; the rendered Markdown reports those values
  after the companion merge instead of `0`, and the HTML renderer uses the same
  evidence boundary.
- `npm run pack:verify`, the doc-link graph, and the full test suite remain the
  release gates; the pre-existing DSH test failure is outside this change.