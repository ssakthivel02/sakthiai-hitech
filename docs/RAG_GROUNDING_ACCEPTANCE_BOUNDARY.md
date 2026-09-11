# RAG / grounding acceptance boundary

This lane provides deterministic repository-level evidence for the canonical SakthiAI retrieval fusion policy.

## Proven here

- query terms are normalized before lexical scoring;
- lexical retrieval remains available when embeddings are unavailable;
- semantic-only evidence is distinguished from lexical evidence;
- hybrid evidence is explicitly identified when both signals exist;
- fusion weights remain 35% lexical / 65% semantic;
- incompatible vectors do not produce a positive semantic score;
- candidates with no lexical or semantic evidence score zero and are therefore removed by `searchChunks`;
- tenant filtering remains in the database query before scoring/fusion.

## Not proven here

This does not claim:

- live embedding-provider quality;
- retrieval recall/precision against a production corpus;
- multilingual Tamil semantic quality;
- deployed MySQL query behavior;
- citation rendering UX correctness;
- hallucination-free model output;
- production RAG quality or latency;
- real preview upload → extraction → retrieval → grounded answer acceptance.

A controlled preview must still exercise a representative corpus and record grounded/insufficient-evidence behavior against the exact deployed commit.
