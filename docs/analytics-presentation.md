# Research Analytics presentation contract

Research Analytics is **summary first, audit second**. A report opens with its scope, effective denominator, principal metrics, and an attention summary. Large event, candidate, structure, position, path, and endpoint tables belong in closed semantic `<details>` sections. Small comparison tables may remain visible when they are the decision surface.

## Evidence is not performance

Evidence validity and economic attention are independent dimensions:

- **VALID** means the canonical observation is usable. A loss can be fully valid.
- **PARTIAL** means some canonical evidence needed by the displayed record is missing.
- **UNAVAILABLE** means the value was not established; it is never rendered as zero.
- **INVALID** is reserved for canonical integrity, semantic, or causal failures.
- **UNUSUAL** is an attention flag, not an evidence state or exclusion rule.
- **ADVERSE** and **FAVORABLE** describe economic direction without saying “invalid”, “preferred”, or recommending a strategy.
- **TAIL** is descriptive distribution context. Economics only assigns P10/P90 tail attention with at least 20 priced observations. Tail rows remain in every calculation.
- **LOW N** identifies insufficient support and must show both the observed N and required minimum.

Color reinforces these labels but never replaces them. Badges have accessible text and highlighted records state a readable reason.

## Coverage and metric states

Every aggregate metric displays its effective `n / denominator` (or the exact independent-event N). `Unavailable`, `Not estimable`, `Not evaluated`, and `Not configured` remain distinct; none is coerced to zero. Tail estimates preserve their minimum-N reason.

## Audit interaction

Audit tables are keyboard-accessible disclosure widgets. Where attention filters exist, flagged rows are shown first and “Attention only” is the initial filter when flags exist. Filtering changes presentation only, never the analytical cohort or formulas.

Future reports must reuse the shared evidence badge, attention badge, panel, KPI, and assessment vocabulary rather than introducing report-specific red/yellow/green meanings.

Evidence invalidity is code-driven. Economics uses structured exit diagnostic codes for impossible/ambiguous causal ordering; prose is explanatory only. Ordinary states such as an endpoint after expiry remain unavailable/not reached rather than becoming invalid because of their wording. Configuration tail metrics below their declared minimum receive LOW N with observed N and minimum.
