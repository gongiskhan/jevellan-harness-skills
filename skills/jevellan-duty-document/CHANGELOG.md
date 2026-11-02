# Changelog: jevellan-duty-document

Changes made by the trigger-eval improvement loop (brief section 10); `evals/RESULTS.md` at the repository root holds each round's numbers.

## Trigger evals round 1, 2026-11-02

- The description says the duty applies when the runtime's instructions name it, and that a plain request to write docs is not a task step: "Write a README for my Rust CLI tool" picked this skill first (case 11, a negative).

## Trigger evals round 2, 2026-11-02

- The description says the duty applies only when the runtime's instructions say "Your step is duty document", never for a request typed by the owner: plain requests ("Write a README for my Rust CLI tool", document case 11; "Investigate this stack trace", investigate case 14) picked the document and investigate duties first. All eight duty descriptions got the same wording, so they stay alike.

## 0.2.0 - Interface section added; body otherwise unchanged
