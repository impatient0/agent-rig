# Human-in-the-Loop Domain & Schema Contract Gate (`contract-change-gate`)

## Core Principle

Public interfaces, persistence schemas, wire protocols, and state-machine invariants form the structural spine of a repository and require explicit human approval before modification.
An isolated Worker subagent in [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md) MUST NOT invent, alter, or weaken a system contract to make a local slice or test pass.

---

## Governed Artifacts & Boundaries

Unless a project's root `AGENTS.md` narrows or expands this list, the following five categories are strictly human-gated:

1. **Persistence & Database Schemas:**
   - SQL migration files (Liquibase, Flyway, Prisma, Alembic, raw `.sql` migrations), table/index definitions, ORM entity column mappings, and transaction isolation levels.
2. **Wire Protocols & API Schemas:**
   - OpenAPI/Swagger specs, Avro schemas (`.avsc`), Protobuf definitions (`.proto`), GraphQL schemas, REST route signatures, and event/message payload contracts (such as Kafka topic schemas).
3. **Cross-Module Public Interfaces & SPIs:**
   - Exported service interfaces, library entry-point signatures, domain repository contracts, and shared DTO/value-object shapes consumed across module or package boundaries.
4. **State Machines & Concurrency Invariants:**
   - Enumerated lifecycle states, legal state transitions, idempotency keys, lock/lease acquisition order, and retry/backoff policies.
5. **Security, Auth & Runtime Topology:**
   - Authentication/authorization middleware, permission scopes, cryptographic parameters, dependency manifests (`package.json`, `pom.xml`, `build.gradle`, `Cargo.toml`, `go.mod`), and deployment/container descriptors.

---

## Gate Rules by Execution Gear

### 1. Gear 1 — Interactive Pairing (Default Mode)

When collaborating directly with the user in the main session:
- Propose the exact signature, schema diff, or state transition in chat (or in an ADR under `docs/adr/`) and confirm with the user before writing the implementation.
- Once confirmed by the user in conversation, edit the contract files directly in the linked worktree and cite the decision in the commit message or ADR.

### 2. Gear 2 — Autonomous Dispatch ([`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md))

During `/dispatch` triage and Worker execution:
- **Triage (Gate A):**
  If a candidate item requires designing a new governed contract or altering an existing one without an already-approved specification, the Tech Lead MUST place it in **Bucket 2 (Ask User First)**.
- **Authorized Contract Execution:**
  A Worker subagent MAY create or modify a governed contract file ONLY when the grounded Task Brief explicitly includes the approved signature, schema definition, or ADR section reference.
- **Worker Stop Trigger #1:**
  If a Worker discovers mid-slice that completing its task requires touching any governed contract not explicitly authorized in the Task Brief, it MUST halt immediately and report the exact file, symbol, and required change back to the Tech Lead.

---

## Cold Verifier Audit Check ([`agents/verifier.md`](../agents/verifier.md))

When auditing a diff under Check 3 (**Human-Gated Boundary Compliance**), the Cold Verifier MUST fail the branch (`VERDICT: FAIL`) if any diff hunk modifies a governed contract file, public signature, or dependency manifest without an explicit authorization in the grounded Task Brief.

---

## Allowed Without Gate Activation

Internal implementation details that do not cross module boundaries or alter observable contracts do not trigger this gate:
- Private helper functions, module-internal classes, and local data structures.
- Test files, test fixtures, and mock implementations that conform to existing interfaces.
- Internal refactoring, performance tuning, or logging additions that preserve exact input/output types, error contracts, and concurrency semantics.
