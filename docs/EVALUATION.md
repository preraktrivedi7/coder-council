# Evaluation and the Kimi-value benchmark

Council compares representative real tasks across feasible arms:

- A: OpenAI only
- B: OpenAI plus a free/local challenger
- C: OpenAI plus Kimi
- D: OpenAI plus Kimi and a free/local arbiter

Add ready tasks and run the benchmark:

```bash
council benchmark add "Review a representative authentication change"
council benchmark run
council benchmark report
```

Arm identity is deterministically blinded behind neutral labels until rating. Record
pending results and record ratings with:

```bash
council benchmark pending
council benchmark rate <evaluation-id> <1..5> <contribution-label>
```

Contribution labels are `none`, `duplicate`, `useful-detail`,
`material-improvement`, `critical-catch`, and `harmful`.

The generated `.council/evaluations/kimi-value-report.md` reports changed outcomes,
beneficial changes, unique findings, useful categories, latency, reported cost, and
one of `keep-kimi`, `selective-kimi`, `free-is-enough`, or
`insufficient-evidence`. At least three rated Kimi evaluations are required before
a non-insufficient recommendation. Objective tests and human ratings outrank model
self-evaluation.
