# Research-selection payload normalization (schema 1.6.0)

## Measurement

The pre-change and normalized representations were serialized with `JSON.stringify` from the same nine-structure stress fixture: three structures each at 7D (43 points), 14D (85 points), and 30D (181 points), sampled every four hours. Each structure contains independent maker, taker, and reference paths, outcomes, raw/model estimates, and evidence references. The fixture intentionally includes the runtime calibration matrix that was previously copied recursively.

| Component | Before (bytes) | After (bytes) |
| --- | ---: | ---: |
| Complete event PUT body | 56,811,661 | 8,743,444 |
| Source run | 30 | 30 |
| Generation configuration | 460 | 460 |
| Generation candidates | 3,724 | 3,724 |
| Shared underlying hourly path (721 points) | 72,101 | 72,101 |
| Selected structures | 56,679,760 | 8,611,543 |
| Event evidence catalog (400 unique trades) | 55,385 | 55,385 |

Per-structure normalized totals for the 7D/14D/30D groups were 399,896 / 789,489 / 1,681,126 bytes. Per distinct maker or taker track they were 126,981 / 250,797 / 534,131 bytes; reference tracks were 127,031 / 250,847 / 534,181 bytes. Evidence usage rows contributed 18,558 / 36,702 / 78,337 bytes. The deliberately conservative stress fixture is 84.6% smaller and remains below the unchanged 10,000,000-byte request guard.

The automated compact fixture writes and reloads one nine-structure event and measures a pretty-printed 25-event store. Its regression ceilings are 9 MB per event request and 70 MB per store; the measured 25-event file is 63,321,250 bytes.

## Canonical representation

Schema 1.6.0 persists `referenceValuation` as the execution-independent fair-value track. New writes no longer emit the former `modelTrack` alias. Migration compares entry, path, and outcome arrays: an equivalent 1.5 model alias is removed, while a genuinely different track is retained once as `legacyModelTrack`. This makes migration deterministic and idempotent without inferring equivalence from a field name.

`compactValuationPoint` is now an allow-list DTO. It retains timestamps/status, target/index resolution, distinct raw and model leg marks, fees and BTC PnL (USD remains exactly derivable from BTC PnL and target index), IV/model provenance, quality/missingness, and evidence IDs. It drops runtime calibration matrices, the `ivNormalizedEstimate` alias, disclaimers/UI warnings, and duplicated estimate-level timing/economic intermediates already canonical at the point or entry snapshot. Supporting trades remain solely in the event evidence catalog. Evidence usages and repeated evidence IDs are deterministically deduplicated.
