# Grounded Answer Acceptance Boundary

This control covers the canonical `server/routers.ts` chat path only.

## Repository evidence enforced

The validator requires the chat path to:

1. retrieve workspace-scoped evidence before generation;
2. execute an explicit no-evidence branch before any LLM invocation;
3. return the exact `INSUFFICIENT_EVIDENCE` sentinel when retrieval returns no matches;
4. persist and return an empty citation array for that path;
5. expose `grounding: INSUFFICIENT_EVIDENCE` for that path;
6. instruct the model to use only supplied evidence;
7. instruct the model to return the exact sentinel when evidence is insufficient;
8. explicitly forbid invented citations.

## Claim boundary

A passing repository gate does **not** prove live retrieval quality, Tamil answer quality, hallucination-free generation, citation correctness against a representative corpus, deployed database behavior, embedding-provider behavior, or production readiness.

Controlled-preview acceptance still requires representative upload → extraction → retrieval → grounded-answer and insufficient-evidence exercises against the exact deployed commit with captured citations and human review.

No provider activation, deployment, database mutation, DNS change, secret operation, or production approval is authorised by this control.
