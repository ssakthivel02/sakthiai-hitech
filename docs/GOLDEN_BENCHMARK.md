# Tamil / English / code-switch golden benchmark

Status: **SOURCE_IMPLEMENTED / LOCALLY_TESTED / CI_PENDING**. Evidence class `CONTRACT_HARNESS_GOLDEN`. Real-model quality: **`REAL_MODEL_QUALITY_UNVERIFIED`**.

## What it is
A fixed, hand-written corpus (`server/evals/golden/corpus.json`, 14 documents in 2 tenants, 48 cases (47 scored + 1 documented gap)) scored by `pnpm evals` (alongside the existing contract harness) into a SEPARATE report: `reports/evals/golden-benchmark.json` + `.md`.
Real code under test: the lexical/hybrid ranker (`rankChunkCandidates`), tenant filtering, and `resolveGroundedOutcome`. The model reply per case is **scripted**; no model is called, no network, no paid provider.

## What it does and does not prove
- Proves: Tamil/English/code-switch lexical retrieval, Tamil digit folding, invisible-character normalisation, tenant isolation, grounded / insufficient / model-unavailable states, conflicting-source surfacing, citation selection (all retrieved evidence is cited when grounded), lexical fallback with embeddings off, and hybrid/semantic paths using SYNTHETIC vectors.
- Does NOT prove: real LLM answer quality, real embedding quality, Tamil fluency, or hallucination rates. Those need a real-model run reported separately; it must never be merged into this report (`run-evals.mjs` rejects any golden report that claims otherwise).

## Categories
tamil, english, code_switch, transliterated, grounded, insufficient, conflicting, citation_selection, ambiguous, multi_document, adversarial, provider_unavailable, embeddings_unavailable (lexical fallback), embeddings_available_synthetic.

## Known gaps (tracked, not hidden; a gap that starts passing FAILS the run until `knownGap` is removed)
1. `CROSS_LINGUAL_NEEDS_EMBEDDINGS` - English query for a Tamil-only chunk needs a working embedding model. This is a semantic dependency: it is NOT approximated with word lists or fake vectors, and stays RUNTIME_UNVERIFIED until a real embedding model runs.

Closed by Package 0019 (now scored cases): `tr-tanglish-to-script`, `tr-script-to-tanglish` (deterministic Tamil<->Tanglish consonant-skeleton matching, cross-script only, half weight) and `amb-stopwords` / `amb-stopwords-ta` / `amb-stopwords-tanglish` / `amb-stopwords-with-embeddings` (stopword-only queries are suppressed, including the embedding lookup). Guard cases: `tr-direct-beats-translit`, `tr-no-latin-latin-noise`, `tr-translit-tenant-isolation`.

Honest limits of the transliteration channel: it is a heuristic (vowels, length, voicing and aspiration are discarded, so unrelated words can share a key; keys need >= 2 consonants), it only crosses scripts, it scores half a lexical hit, and it needs `pnpm db:backfill-search-text` to upgrade rows indexed before 0019 (they otherwise keep working with their original lexical matching only).

## Adding cases
Add to `corpus.json`; set `knownGap` only for a real, understood limitation (expectations describe the DESIRED behaviour; the case must currently fail). The corpus SHA-256 is recorded in every report.
