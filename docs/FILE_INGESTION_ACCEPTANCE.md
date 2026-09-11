# File Ingestion Acceptance Boundary

This document defines what repository evidence does and does not prove for SakthiAI HI-TECH file ingestion.

## Proven by repository controls

The canonical upload path requires authentication, checks workspace ownership before processing, checks optional project ownership before persistence, enforces a 12 MiB maximum, sanitizes the filename, restricts supported extensions, performs basic PDF/DOCX signature checks, computes a SHA-256 content hash, rejects duplicate content within the workspace, requires extractable text, uses mediated object storage, persists document metadata/provenance, and persists chunk-level provenance.

`server/fileIngestion.acceptance.test.ts` additionally verifies deterministic plain-text extraction, bounded chunk segmentation/source offsets, whitespace-only handling, and rejection of unsupported MIME types.

## Explicit scanner boundary

The current runtime truth is `SCANNER_NOT_CONFIGURED`. Therefore SakthiAI must not claim that uploads are malware-scanned, antivirus-clean, safe to open, or production-secure merely because extension/signature validation passes.

Until a scanner is configured and real scanner acceptance evidence exists:

- `mayClaimSecureScannedUpload` remains false;
- the unconfigured scanner blocks a production-ready upload-security claim;
- controlled beta may expose the upload feature only with this limitation represented truthfully.

## Runtime evidence still required

Repository CI does not prove a real object-storage round trip, provider availability, deployed database persistence, malware scanning, malicious-file handling, extraction quality across a representative PDF/DOCX corpus, or recovery after partial storage/database failure.

A live controlled-preview acceptance must use the exact deployed commit and record storage write/read evidence, persistence evidence, supported-format samples, rejected-format samples, and—before any secure/scanned claim—real malware-scanner evidence.

No production approval is granted by this document or its CI gate.
