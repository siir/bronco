# Gap Analysis: Architecture Diagram vs. Implementation

**Date:** 2026-03-29

This document compares the aspirational architecture flow diagram against the current Bronco codebase implementation, identifying gaps that need to be addressed.

---

## 1. Ingestion Sources (Left Side of Diagram)

The diagram shows all sources flowing through a single **Ingestion Queue (New Ticket or Update)** into the **Ticket API**. In reality, most sources bypass the ingestion queue entirely.

| Diagram Source | Implemented? | How It Actually Works |
|---|---|---|
| **Client Web App** | Yes | Portal tickets via `POST /api/portal-tickets` — creates tickets **directly in DB**, then emits `ticket-created` event. Bypasses ingestion queue. |
| **Slack Worker** | **No** | No Slack service or integration exists anywhere in the codebase. |
| **IMAP Worker** | Yes | Polls IMAP mailbox → parses/threads emails → creates tickets **directly in DB** → emits `ticket-created` event. Bypasses ingestion queue. |
| **Probe Worker** | Yes | **Only source that uses the `ticket-ingest` queue** (modern path). Falls back to direct DB creation if queue is unavailable. |
| **DevOps Worker** | Yes | Polls Azure DevOps → syncs work items → creates tickets **directly in DB** → emits `ticket-created` event. Bypasses ingestion queue. |
| **Manual (Control Panel)** | Yes | `POST /api/tickets` → creates ticket **directly in DB** → emits `ticket-created` event. Bypasses ingestion queue. |

### Gap: Unified Ingestion Queue

The `ticket-ingest` BullMQ queue and ingestion engine (`services/ticket-analyzer/src/ingestion-engine.ts`) exist and support route-driven processing with configurable steps (categorize, generate title, create ticket, etc.). However, only probe-worker feeds into it. All other sources create tickets directly and skip the ingestion pipeline.

**To match the diagram:** IMAP Worker, DevOps Worker, Manual/Portal, and the future Slack Worker should all submit normalized payloads to the `ticket-ingest` queue instead of creating tickets directly. The ingestion engine would then handle ticket creation uniformly via configurable routes.

**Ingestion payload types already defined** in `packages/shared-types/src/ingestion.ts`:
- `ProbeIngestionPayload` (in use)
- `EmailIngestionPayload` (defined but not used by IMAP worker)
- `DevOpsIngestionPayload` (defined but not used by DevOps worker)
- `ManualIngestionPayload` (defined but not used by API)

---

## 2. Ticket Analysis (Middle of Diagram)

The diagram shows an analysis pipeline with two decision branches:
1. "Does it have all the info needed to proceed?" — Yes: Reply Analysis / No: continue
2. "Need more info about the system or user knowledge?" — System: Detective Worker / User: Contact User

### What Exists

| Diagram Concept | Implemented? | Current Implementation |
|---|---|---|
| **Reply Receipt** | Yes | `DRAFT_RECEIPT` route step sends an auto-reply email acknowledging the ticket. |
| **Analysis Worker (figure out facts)** | Yes | `EXTRACT_FACTS` pulls structured data (error messages, files, services, keywords). `DEEP_ANALYSIS` does comprehensive Claude analysis. `AGENTIC_ANALYSIS` runs a multi-turn Claude loop with MCP tool calls. |
| **Reply Analysis (send findings)** | Yes | `DRAFT_FINDINGS_EMAIL` sends analysis results back to the sender. |
| **Detective Worker (gather system info)** | Partial | `GATHER_DB_CONTEXT` calls MCP tools for database health/blocking/wait stats. `GATHER_REPO_CONTEXT` clones repos and searches for relevant source code. `AGENTIC_ANALYSIS` has an iterative loop where Claude can call MCP tools dynamically (up to 10 iterations). |

### Gap: Info Sufficiency Decision

The diagram shows a decision point: "Does it have all the info needed to proceed?" This does not exist in the implementation. The pipeline runs linearly — every configured step executes in sequence regardless of whether the system has enough information. There is no branching logic that evaluates sufficiency and decides whether to gather more data or proceed to findings.

### Gap: Detective Worker as Conditional Loop

`GATHER_DB_CONTEXT` and `GATHER_REPO_CONTEXT` exist but run as fixed pipeline steps based on route configuration. They are not triggered conditionally by a "need more info about the system" decision. The `AGENTIC_ANALYSIS` step comes closest — Claude iteratively calls MCP tools until it decides it has enough — but this is within a single analysis step, not a pipeline-level decision.

### Gap: Contact User (Proactive Outreach)

**No step exists that proactively emails the user to ask for more information.** The current flow is:
1. System runs analysis with whatever info it has
2. System sends findings email (`DRAFT_FINDINGS_EMAIL`)
3. System passively waits for user to reply
4. If user replies, IMAP Worker detects the reply and triggers re-analysis (up to 10 cycles)

The diagram envisions the system recognizing it lacks sufficient information, deciding whether the gap is about system data (→ Detective Worker) or user knowledge (→ Contact User), and proactively reaching out to the user with specific questions before producing findings.

**To match the diagram:** A new step type (e.g., `EVALUATE_SUFFICIENCY`) would need to:
1. Review the accumulated context from prior steps
2. Ask Claude: "Do you have enough information to produce a useful analysis?"
3. If no — determine whether the gap is system info (trigger more MCP/repo gathering) or user info (send a targeted email asking specific questions)
4. Loop back to analysis after gathering the missing info

---

## 3. Resolution Worker (Right Side of Diagram)

The diagram shows a full approval workflow:
1. **Plan Worker** — Define resolution plan
2. **Send Operator Plan** — Notify operator of the plan
3. **Receive Plan Feedback** — Operator reviews
4. **Approved?** — Decision gate with rejection loop back to planning
5. **Execute Plan** — Pull repos, make changes, push

### What Exists

| Diagram Concept | Implemented? | Current Implementation |
|---|---|---|
| **Execute Plan (pull repos, etc)** | Yes | `services/issue-resolver/` — clones repo, creates branch, Claude generates changes in one shot, applies file changes, commits, pushes to feature branch. |
| **Plan Worker** | **No** | No structured plan is generated before execution. Claude produces code changes directly. |
| **Send Operator Plan** | **No** | No notification to operator before or after execution. The only trace is a `CODE_CHANGE` ticket event. |
| **Receive Plan Feedback** | **No** | No feedback mechanism exists. |
| **Approved? decision loop** | **No** | No approval gate. Execution is automatic and immediate once triggered. |

### Current Flow (Fire-and-Forget)

```
POST /api/issue-jobs → IssueJob created (PENDING)
  → CLONING: clone/fetch repo, create feature branch
  → ANALYZING: single Claude call generates all file changes
  → APPLYING: write files to disk
  → PUSHING: commit and push to feature branch
  → COMPLETED: create CODE_CHANGE ticket event
```

No human is in the loop at any point after the job is triggered.

### Current IssueJob Status Enum

```
PENDING → CLONING → ANALYZING → APPLYING → PUSHING → COMPLETED
                                                    ↘ FAILED
```

No `PLANNING`, `AWAITING_APPROVAL`, or `PLAN_REJECTED` states.

### Existing Pattern: DevOps Worker Approval Workflow

The **devops-worker** (`services/devops-worker/src/workflow.ts`) already implements the exact approval pattern the resolution worker needs:

```
IDLE → ANALYZING → QUESTIONING → PLANNING → AWAITING_APPROVAL → EXECUTING → COMPLETED
```

Features:
- Generates a structured JSON plan with steps, descriptions, and types
- Posts the plan as an Azure DevOps comment for operator review
- Detects operator intent via NLP classification + regex fallback ("approved", "lgtm", "go ahead")
- On rejection: loops back to planning/questioning with feedback
- On clarification: answers questions, stays in `AWAITING_APPROVAL`
- Only executes after explicit approval

**To match the diagram:** The issue-resolver should adopt this pattern:
1. Add `PLANNING` and `AWAITING_APPROVAL` states to `IssueJobStatus`
2. After `ANALYZING`, generate a structured plan (list of proposed changes with rationale) instead of immediately producing code
3. Store the plan in `IssueJob` (new `plan` JSON field)
4. Notify the operator (email, control panel notification, or both)
5. Wait for operator response via API endpoint (`POST /api/issue-jobs/:id/approve` or `POST /api/issue-jobs/:id/reject`)
6. On approval: proceed to code generation and execution
7. On rejection: loop back to planning with feedback, or cancel the job

---

## Summary of All Gaps

| # | Gap | Severity | Existing Pattern/Foundation |
|---|---|---|---|
| 1 | **Slack Worker** — not implemented at all | New service | IMAP Worker is the model |
| 2 | **Unified ingestion queue** — only probes use it; all other sources bypass | Architectural | Ingestion engine + payload types already exist, just need to wire sources in |
| 3 | **Resolution approval loop** — no plan, no notification, no approve/reject | Major feature | DevOps Worker `workflow.ts` is the proven pattern |
| 4 | **Contact User step** — no proactive outreach when info is insufficient | New step type | `DRAFT_FINDINGS_EMAIL` and email sending infra exist |
| 5 | **Info sufficiency decision** — no branching logic in analysis pipeline | New step type | `AGENTIC_ANALYSIS` tool loop is a partial model |
| 6 | **Detective Worker as conditional** — MCP gathering runs unconditionally | Pipeline logic | Steps exist, need conditional execution based on sufficiency evaluation |
