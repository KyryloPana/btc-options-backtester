#!/usr/bin/env bash
set -euo pipefail

# Deterministic sparse-tape acceptance harness.  This intentionally spans the
# engine, lifecycle, persistence/bundle, import, and normalized analytics
# boundaries rather than treating any one green unit suite as historical proof.
node --experimental-strip-types --test \
  tests/backtester.unit.test.ts \
  tests/research-valuation.unit.test.ts \
  tests/causal-valuation.unit.test.ts \
  tests/delayed-execution.unit.test.ts \
  tests/execution-side.unit.test.ts \
  tests/execution-scenarios.unit.test.ts \
  tests/observation-ledger.unit.test.ts \
  tests/research-selections.unit.test.ts \
  tests/event-lifecycle.unit.test.ts \
  tests/research-bundle.unit.test.ts \
  tests/research-analysis.unit.test.ts \
  tests/research-analytics-model.unit.test.ts \
  tests/duration-dte-statistics.unit.test.ts \
  tests/duration-dte-report.unit.test.ts \
  tests/spread-width-report.unit.test.ts \
  tests/short-strike-report.unit.test.ts
