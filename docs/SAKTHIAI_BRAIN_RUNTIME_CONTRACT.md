# SakthiAI Brain Runtime Contract

Status: FOUNDATION / PURE CONTROL-PLANE LOGIC / NO MODEL OR TOOL SIDE EFFECTS

## Purpose

Define the transparent execution contract for SakthiAI's application-level "brain": how a user objective becomes a bounded task graph, how risky actions are approval-gated, how retries are limited, and how evidence is verified before the final result is accepted.

This contract deliberately does not expose or attempt to reproduce any provider's private chain-of-thought. Internal model reasoning remains model-owned. SakthiAI stores and audits only useful execution artifacts: task intent, plan steps, evidence, tool outcomes, approvals, test results and final decisions.

## Planning contract

A `BrainTaskRequest` declares:
- objective;
- task intents;
- required capabilities;
- fresh-information/workspace/tool needs;
- action risk;
- autonomy mode.

The deterministic foundation planner can add:
- tenant-scoped context assembly;
- fresh-source research;
- reasoning/decomposition;
- coding/test work;
- approval before high-risk external actions;
- bounded tool execution;
- verification;
- final synthesis.

The planner has hard execution limits for total steps, tool calls and retry counts.

## Execution contract

The orchestrator is a pure state machine in this phase. It does not call browsers, shells, providers or cloud APIs.

A step is executable only when:
- all dependencies succeeded;
- its state is pending;
- any required approval is recorded;
- tool-call budget remains;
- its attempt limit has not been exhausted.

A failed step becomes retryable only while attempts remain. Repeated failure becomes terminal; the system does not silently loop forever.

## Approval contract

High/critical-risk tool workflows receive an explicit approval gate before the tool step. Future tool adapters must preserve this dependency and may not bypass it.

Examples of actions expected to remain approval-gated include:
- production/deployment changes;
- paid-provider submissions;
- destructive data operations;
- externally visible publication or messaging;
- privileged cloud/account actions.

Domain-specific policy may require approval at lower risk levels.

## Verification contract

The verifier consumes explicit evidence artifacts rather than trusting a model's confidence statement.

Supported evidence classes include:
- authoritative source;
- retrieval result;
- test result;
- tool result;
- owner/human approval;
- checksum/provenance;
- human review.

Policies can require:
- particular evidence types;
- a minimum count of trusted sources;
- test evidence for coding tasks;
- human approval for high-risk results.

If a required evidence gate is missing, verification fails closed.

## Integration roadmap

Future phases may connect these contracts to:
1. the Model Fabric router;
2. local/self-hosted LLM inference;
3. RAG/memory/provenance;
4. browser/computer tools;
5. repository/code sandboxes;
6. connector actions;
7. long-running durable task storage;
8. observability/evaluation dashboards.

Those integrations must be separate evidence-backed changes. This foundation must not be treated as proof that autonomous execution is already live.

## Current safety boundary

No API key, provider, browser, shell, cloud resource, database mutation, deployment, paid call or production action is invoked by this module.
