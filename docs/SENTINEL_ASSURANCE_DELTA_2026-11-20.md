# Sentinel assurance delta — 20 November 2026

Production HOLD. This is implementation qualification, not independent semantic certification or competition approval. Existing PR #34 only; Creator#58/integration#63 and all SQL migrations are unchanged.

## Independent evidence recovered

The supplied private Drive assurance ZIP SHA256 is `1bdb7ad109dd93e67dff2184a23f79884b07797a63605c89bd2303df851ea117`. All four internal manifest checksums passed. Its verifier source matches blob `49369998ff6249802ee7eebbfc028ad20cb5259c` at head050058c. The original isolated12-observation probe was rerun with only the local TypeScript installation path adapted, preserving the original artifact. Those12 observations include7 adverse acceptances and are not12 security passes.

Full-path regression uses the actual production handler, GatewayPolicy/parser, broker, strict ledger, verifier, event store and final-event path with scripted diagnostic/model transports. It is not genuine-model or live-MCP acceptance. The initial run reproduced the adverse behaviors; six desired-control tests failed before fixes. The semantic-mismatch case intentionally records a remaining limitation. A separate self-consistent checkpoint reuse regression failed before restore hardening.

## Finding disposition

| ID | Full-path observation and change | Remaining boundary |
| --- | --- | --- |
| A01 old evidence | Year-old cited data reached a verified diagnosis. Cited/contradiction records now require valid event timestamps inside the configured incident window. | Historical analysis is valid when aligned with the incident; timestamps are not attested. This is not a universal wall-clock age guarantee. |
| A02 future evidence | Future-dated records reached verification. New checks reject records beyond the incident lookahead or verification clock plus allowed skew; ambiguous/impossible timestamps fail closed. | Trusted server clock/policy required; bounded skew is deliberate. No proof that a source's timestamp is truthful. |
| A03 unrelated semantic label | DNS_MISCONFIG with disk-full facts still passes structural checks with signatureKb=off. **OPEN P0.** | Do not re-enable synthetic signature rules as a universal production judge, train on holdout answers, or call structural success causal proof. Domain/topology-aware evaluation and independent scoring are required. |
| A04 shared observation | Unequal record counts let repeated observation IDs overwrite part of earlier evidence and still satisfy two-tool counting. Broker now rejects reused observation IDs, verifier requires distinct observations, restore rejects duplicate IDs/RIDs in non-replayed results. Exact-request replay remains permitted. | **PARTIAL:** distinct IDs/tool labels do not prove independent underlying sources. The MCP adapter's generated IDs include tool/request context; two bindings may still wrap one backend snapshot under different IDs. Source identity/provenance attestation remains OPEN. |
| A05 quarantined contradiction | Broker quarantined the malicious record but verifier accepted its contradiction reference. Now rejected like quarantined direct citations. | Detection patterns are incomplete; all tool text remains untrusted. |
| A06 false claim in abstention reason | Claim reached persisted final event. Same bounded schema/false-execution checks now cover abstain_reason. | Existing phrase detectors are not exhaustive semantic claim detection. |
| A07 URL in abstention reason | URL reached persisted final event. Same echo/URL redaction now covers abstain_reason. | Redaction is defense in depth, not universal secrets/DLP certification. |

## Temporal policy and compatibility

New verification policy marker: `sentinel-evidence-2`. Default incident-relative lookback24h and lookahead24h, plus an absolute verification-clock future allowance5min. ISO-like event timestamps must have an explicit timezone and valid calendar/time values. Unknown/invalid/out-of-window cited or contradiction evidence causes rejection, not silent replacement with retrieval time.

An internal trusted `VerifyOptions.evidenceWindow` may specify lookbackMs, lookaheadMs, clockSkewMs and asOfMs for a documented historical/event-time assessment. These are never model-selected fields. The effective policy/time and alert anchor are recorded as a `verification_context` trace event. The resulting timestamp check uses that exact captured context. It does not make inferred retrieval timestamps equivalent to known event timestamps; `recordsFromText` can still use retrieval time when the source has no event time, which remains an assurance limitation.

Previously stored terminal traces retain their recorded outcome and are not retroactively reclassified. New active/replayed investigations are subject to the current checks; stale or colliding legacy evidence may now cause rejection or require a fresh investigation. No old evidence was deleted or counters lowered. Existing atomic restore behavior is retained: malformed results do not partially commit restored state.

## Honest output

Report JSON now says semanticValidation=NOT_PERFORMED and sourceAuthenticity=NOT_ATTESTED, even if structural checks pass. Markdown/HTML already distinguish structural verification from root-cause proof; disclosures now avoid implying all injections are detected. Two tool names or observation IDs must not be presented as independently authenticated sources.

The previous161.623s model development diagnosis and172.680s abstention remain historical evidence at their recorded source versions. This change does not retrospectively claim those runs were assessed with the new policy, and their original21-event traces are preserved. New traces include verification context, so their event count differs.

## Test scope

The router fixtures previously used the current alert time with fixed1Oct telemetry. They now explicitly use1Oct alert time for their historical valid-data tests; assertions and security controls are unchanged. The new old/future timestamp tests cover the rejected mismatch rather than weakening the window. No sealed benchmark was opened or regenerated.

Further qualification must cover genuine-model fresh/insufficient/stale incidents, real connector provenance, timestamp-source uncertainty, independent semantic correctness and canonical integration migrations. The independent reviewer retains the holdout and business/presentation workstream. No user should infer zero underlying risk from these regressions.


## Connector event-time follow-up

The MCP adapter previously substituted retrieval time for missing record timestamps. Retrieval proves when output was fetched, not when an event occurred; old undated text could therefore pass incident-relative freshness checks. Missing JSON timestamps, string-array items, plain lines and adapter-generated truncation notes now carry an unknown event timestamp (empty string). The existing final verifier rejects any cited or contradiction reference with that timestamp. Actual supplied timestamps remain unchanged and subject to existing temporal validation; no source attestation is implied. Unknown-time records remain visible for investigation, but cannot establish a verified diagnosis. Connectors must provide valid event timestamps for qualifying citations. This deliberately reduces acceptance of undated diagnostics rather than fabricating freshness. Historical stored traces are unchanged.

Regression evidence includes a failing pre-fix missing-time test and adapter→broker→verifier tests contrasting identical undated and timestamped disk evidence. These are deterministic control tests, not live connector or model acceptance. Source-supplied timestamp authenticity, semantic diagnosis correctness and underlying source independence remain open.


### Governed connector / local SQL qualification

The missing-event-time regression is also exercised through the production Sentinel handler, MCP adapter and connector service, HTTP JSON-RPC to the existing synthetic loopback MCP server, and actual disposable MySQL8.0.46 stores. Three cases cover plain text, JSON objects and string arrays. Each uses a current incident so retrieval time is inside its evidence window. All three fail against the pre-fix adapter (it incorrectly verifies the diagnosis), and pass against the fixed adapter with persisted abstention, invalid-timestamp rejection, intact trace chain, exactly two authorized diagnostic calls and no secret in the exported report. The existing timestamped positive case remains accepted.

Combined connector and Sentinel SQL store suites:23/23 passed, no skips. This includes disabled/foreign connector and denied mutation controls, unavailable and hung connector behavior, auditing, secret redaction and store isolation. The model remains scripted and task context is fake; this is local connector/store qualification, not genuine-model autonomy, TaskWorker integration, external monitoring or hosted OIDC/UI acceptance. Migration application covers only this branch's journal on disposable MySQL8.0; combined integration authority and MySQL8.4 are not newly qualified here. Prior exact-head1850e0e CI was rechecked7/7 green before this test-only follow-up; a later commit must obtain its own CI results.


### Adapter accounting follow-up

The broker now validates nonnegative finite time accounting for every adapter outcome before retry/settlement, including errors and timeouts. Previously only successful observations were checked, so malformed error/timeout values could increase remaining time or introduce NaN/Infinity into durable accounting. Durations above Number.MAX_SAFE_INTEGER are also refused; a contract violation gets the existing bounded error charge and is not retried. Sync and async execution share the check. Valid zero-duration outputs remain supported.

Checkpoint restore rejects non-finite durations and overflowing aggregate time before committing restored state. This is protection against malformed adapters/checkpoints, not a claim that the model can directly choose trusted adapter accounting or that tool-count/tenant restrictions were bypassed. Tool allowlists, maximum calls, cancellation semantics and remediation approval are unchanged. Regression tests exercise each outcome kind through sync/async execution and restore. The pre-fix run records14 failing controls among22 tests; subsequent added overflow-range cases are separately verified in the final suite. Semantic verification, source attestation, migration authority and independent benchmark remain open.
