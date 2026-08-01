# Documentation Review Report — document-search

**Date**: August 1, 2026  
**Scope**: docs README, AWS production architecture, setup guidance, API coverage, environment-variable documentation

---

## Executive Summary

The documentation is now materially closer to the running system than it was in the earlier review cycle. The docs README covers the current local stack: search, RAG chat, member benefits, and all three ETL services. The AWS architecture document also reflects the newer member-benefits and claims-ingestion surfaces.

The remaining documentation gaps are narrower:

- `.env.example` still only exposes the shared baseline variables, not the optional GenAI overrides documented in the README
- there is still no standalone API contract document for request and response schemas
- review notes in the docs folder should be treated as point-in-time assessments, not as normative product documentation

---

## 1. Docs README Assessment

### What is now current

- The opening description matches the actual scope: search, chat, and member benefits
- The service table covers PostgreSQL, Ollama, three application services, and three ETL services
- The quick-start flow matches `startup/setup.sh`, including data generation, schema verification, and Ollama model pull
- The API reference now includes search, web search, unified search, chat, and member-benefits routes
- The data-flow description correctly states that document ETL reads `manifest.json` rather than parsing PDFs during ETL runtime

### Remaining gaps

| Gap | Impact |
|---|---|
| No dedicated response-schema section beyond endpoint summaries | Integrators still need to inspect code for full payload details |
| Optional runtime variables are documented in README but not mirrored in `.env.example` | Operators may not discover them from the bootstrap files alone |
| Troubleshooting is still light | First-run issues such as port conflicts or failed Ollama pulls require source inspection |

---

## 2. AWS Production Architecture Assessment

### What is now current

- The document now maps the claims ETL and member-benefits app in addition to search and chat
- The PoC vs production table reflects generated-document storage and member-facing authentication needs
- The migration phases separate claims ingestion and member-benefits rollout from generic search/chat migration
- Frontend and storage sections now acknowledge all three local UIs and the generated-document output path

### Remaining gaps

| Gap | Impact |
|---|---|
| The architecture diagram is still centered on search and chat | Readers need prose sections to understand the member-benefits extension |
| Cost estimates are still service-family level, not split by member-benefits traffic | Capacity planning remains approximate |
| Bedrock model recommendations should be re-checked periodically | Managed-model naming and pricing can drift faster than code |

---

## 3. API Documentation Assessment

The documentation now identifies the important endpoint groups and the key request shape for chat, but it is still summary-level documentation rather than a full API reference.

### Still missing

- explicit response examples for search, member session, and document-generation routes
- a clear contract for the `X-Sources` header format in streaming chat
- member-benefits error cases and authorization expectations documented outside the code

---

## 4. Setup and Operations Assessment

The setup instructions now reflect the real bootstrap sequence and the local prerequisites. That closes the biggest usability gap from the earlier review.

The main operational gaps still worth addressing later are:

- a troubleshooting section for Docker daemon issues, port collisions, and failed model pulls
- a short data-reset section explaining when to use `npm run teardown` versus regenerating synthetic data only
- a note that `member-benefits-app` enforces `x-api-key` on `/api/*` routes when `API_KEY` is set

---

## 5. Environment Variable Assessment

Current state:

- The docs README now documents the important optional runtime variables
- `.env.example` still only contains the shared baseline variables used across the stack
- `API_KEY` is actively enforced by the member-benefits app, but not by the search or chat services

Recommended follow-up:

| Item | Reason |
|---|---|
| Add optional GenAI variables to `.env.example` | Keeps bootstrap files and docs aligned |
| Document which services honor `API_KEY` | Avoids implying uniform protection across all APIs |
| Separate required versus optional settings | Makes production hardening easier |

---

## 6. Current Documentation Priorities

### High priority

| Priority | Item | Why |
|---|---|---|
| 1 | Align `.env.example` with documented optional variables | Prevents drift between bootstrap artifacts and docs |
| 2 | Add a dedicated API reference doc if external consumers are expected | Current docs are good for developers but still light for integration work |

### Medium priority

| Priority | Item | Why |
|---|---|---|
| 3 | Add troubleshooting for first-run local setup | Reduces support overhead |
| 4 | Document search/chat/member-auth boundaries more explicitly | Clarifies which APIs are open versus protected in local dev |

### Low priority

| Priority | Item | Why |
|---|---|---|
| 5 | Add DB schema overview or links to init scripts | Helpful for onboarding, not required for local usage |
| 6 | Split long review docs from product docs more clearly | Reduces the chance of readers treating review notes as canonical instructions |

---

## Summary Scorecard

| Area | Rating | Notes |
|---|---|---|
| Docs README completeness | **Good** | Covers the current local stack and primary API surfaces |
| AWS architecture doc | **Good** | Now reflects claims and member-benefits additions; diagram is still search-centric |
| API documentation depth | **Fair** | Endpoint coverage is good, schema depth is still limited |
| Setup instructions | **Good** | Matches the real bootstrap path and prerequisites |
| Environment variable documentation | **Fair** | README improved; `.env.example` still trails it |
| Overall documentation currency | **Good** | Main factual drift has been addressed |
