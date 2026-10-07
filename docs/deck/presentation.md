---
marp: true
theme: default
paginate: true
size: 16:9
title: Benefits Intelligence Platform
---

<!--
This file is written in Marp markdown so it can be converted directly to a
PowerPoint deck:

  npx @marp-team/marp-cli docs/deck/presentation.md -o presentation.pptx

Each "---" below starts a new slide. Source content is condensed from the
companion documents in this folder and in docs/: problem.md, benefits.md,
technicalsolution.md, aiusage.md, AWS_PRODUCTION_ARCHITECTURE.md, and
AWS_COST_PROJECTION.md. Update this file whenever those source documents
change materially.
-->

# Benefits Intelligence Platform

Semantic search, RAG chat, and self-service claims — built in-house, proof of concept validated

**Executive & Technical Leadership Briefing**
October 2026

---

## Agenda

1. The problem
2. What we built
3. How the technology works
4. AI usage — what's real ML vs. rule-based
5. Cost & benefits
6. Production path on AWS
7. Recommendation & next steps

---

## The Problem

- Benefits content is fragmented across **SharePoint** (documents) and **Umbraco** (web content), with claims data held separately by carriers/TPAs
- SharePoint's keyword search can't match questions to answers — members must guess exact wording
- No conversational interface — every question requires manually finding and reading a document
- Claims and deductible status are not self-serve — members must call to ask
- Result: high HR hotline contact volume for questions that are already answered in existing content

---

## Impact

| Dimension | Effect |
|---|---|
| Member experience | Frustration, wasted time, reliance on phone support |
| Administrator efficiency | High call volume for routine, answerable questions |
| Answer consistency | Answers vary by channel — search vs. call vs. document |
| Operational cost | Every avoidable call scales with member population |
| Content ROI | Documentation effort is wasted if members can't find it |

---

## What We Built

Three member-facing applications over one shared, semantic search index:

| Application | Who | What |
|---|---|---|
| **Document & Web Search** | Members, admins | Semantic search across the full benefits library |
| **Benefits Chat** | Members | Conversational Q&A, grounded in real content, streamed answers |
| **Member Benefits Assistant** | Members | Personal claims, deductible status, plan comparisons, document generation |

All three are served by a single unified `portal` service — one team, one codebase, one deployable unit.

---

## How Semantic Search Works

- Keyword search fails when the question and the document use different words
- **Embeddings** convert text into a 384-number vector that encodes *meaning*
- Documents and questions are embedded with the same model; the system finds content *closest in meaning*, not closest in spelling
- A question like *"Can I keep my doctor if I switch plans?"* reliably finds the right content even without matching keywords

---

## How RAG Chat Works

1. **Retrieve** — semantic search finds the most relevant passages from the content library
2. **Augment** — those passages are added to the prompt as grounding context
3. **Generate** — the language model answers using *only* that context, streamed back token-by-token

The model cannot invent facts outside the retrieved passages — if the answer isn't in the content, it says so.

---

## Data Pipelines

Three automated ETL pipelines keep the search index current — no manual re-indexing:

| Pipeline | Source | Content |
|---|---|---|
| Document ETL | SharePoint Online | PDFs, SPDs, policy guides |
| Web ETL | Umbraco CMS | Benefit guides, FAQs, articles |
| Claims ETL | Carrier / TPA feed | Claims lines, adjudication status, activity logs |

Each pipeline chunks text, generates embeddings, and upserts into the shared vector index on an **Amazon EventBridge** schedule — idempotent and incremental.

---

## Safety: Escalation Detection

Every chat and bot message is scanned for signals that a member needs human support:

- Legal representation, litigation threats, formal grievances
- State or federal regulator mentions, BBB complaints
- Wrongful denial claims, discrimination claims, compliance violations

Detection is **deterministic regex matching, not an ML classifier** — fully auditable, no training data required. When triggered, the member sees a support-desk referral and the event is logged for triage.

---

## AI Usage — What's Really "AI" Here

| Component | Type | PoC Technology | Production Technology |
|---|---|---|---|
| Text embedding | ML model | BGE-small (ONNX, in-process) | Cohere Embed v3 via Bedrock |
| Vector search | Algorithm (HNSW) | pgvector on PostgreSQL | OpenSearch Serverless / Aurora + pgvector |
| RAG chat | Architecture pattern | Qwen 2.5 3B via Ollama | Claude Sonnet 5 via Bedrock |
| Query pre-processing | Rule-based NLP | Keyword aliasing, category detection | Same pattern, extended |
| Escalation detection | Rule-based regex | 10 patterns | Same pattern; candidate for ML at scale |

Two ML models do the heavy lifting; two deterministic, auditable rule systems handle safety and routing.

---

## Proof of Concept vs. Production

| Dimension | Proof of Concept | Production |
|---|---|---|
| Data | 1,500 synthetic PDFs, 700 web pages, synthetic claims | Live SharePoint, Umbraco, carrier/TPA feeds |
| Embedding | BGE-small, CPU, in-process (384d) | Cohere Embed v3 via Bedrock (1024d) |
| Language model | Qwen 2.5 3B, local Ollama | Claude Sonnet 5 via Bedrock |
| Vector store | PostgreSQL + pgvector | OpenSearch Serverless or Aurora + pgvector |
| Compute | Docker Compose on a laptop | AWS Lambda (serverless) |
| Auth | Open in local dev; API key on member app | Okta → PingFederate → ALB OIDC |
| Cost | ~$0 (local) | ~$645/mo production · ~$110/mo dev/test |

---

## Cost — Direct AWS Running Cost

| Configuration | Production (monthly) |
|---|---|
| Lambda + Aurora + Claude Sonnet 5 (recommended) | ~$645 |
| Lambda + Aurora + Claude Haiku 4.5 (cost-optimised) | ~$445 |

**~$7,740/year** in production — primarily fixed infrastructure cost that scales with *query volume*, not headcount.

---

## Cost — Avoided Costs

| Item | Why it's not a new cost |
|---|---|
| SharePoint licensing | Already licensed org-wide |
| Authentication infrastructure | Okta → PingFederate SSO already deployed |
| Search/chatbot vendor platform | No third-party product introduced |
| External development labour | Built in-house — no contractors required |
| Content system changes | SharePoint and Umbraco remain systems of record |

---

## Cost — vs. Buying a SaaS Platform

| Product Category | Est. Annual Cost — 1,000 users |
|---|---|
| Enterprise AI Search (Glean, Coveo, Lucidworks) | ~$300,000 – $360,000 |
| HR / Benefits AI Chatbot (Leena AI, Moveworks) | ~$120,000 – $240,000 |
| **This solution (AWS, in-house)** | **~$9,000** |

**5-year total: ~$45,000 (this solution) vs. $600,000–$1,500,000 (SaaS alternatives)**

---

## Cost — vs. Hiring Contractors

| Item | In-House | Contractor |
|---|---|---|
| Development labour | Existing team (already budgeted) | $198,000 – $267,000 upfront |
| Time to start | Immediately — PoC already built | 4–8 weeks sourcing delay |
| Year 2–3 maintenance | Existing team | $30,000 – $66,000/year |
| Knowledge retention | Stays with the team | Leaves with the contractor |
| **3-year total** | **~$30,000** | **~$268,000 – $412,000** |

---

## Operational & Strategic Benefits

**Operational**
- One team owns the full member search/chat experience
- Reduced HR hotline contact volume for answerable questions
- Content workflows in SharePoint/Umbraco are unchanged
- Analytics dashboard gives real-time visibility into member needs

**Strategic**
- First in-house AI production deployment — reusable patterns for future projects
- Demonstrates responsible AI: grounded answers, source citation, auditable safety logic
- Reduces dependency on SharePoint's built-in search roadmap

---

## Production Architecture on AWS

- **Compute**: AWS Lambda + API Gateway (fully serverless); Amazon EventBridge for scheduled ETL orchestration
- **Data**: Aurora PostgreSQL + pgvector (or OpenSearch Serverless); S3 for staging and generated documents
- **Auth**: Existing Okta → PingFederate SSO via ALB OIDC — no new auth infrastructure
- **Security**: Private VPC subnets, AWS WAF, Secrets Manager, CloudTrail, GuardDuty

---

## Migration Phases

| Phase | Deliverable |
|---|---|
| 1 | Data layer: Aurora + S3; SharePoint/Umbraco connectors |
| 2 | ETL pipelines against live sources, orchestrated by Amazon EventBridge |
| 3 | Search API live on Lambda — early member value |
| 4 | RAG chat live with Bedrock — major capability |
| 5 | Member benefits assistant with real claims + Okta auth — full value |
| 6 | Production hardening: WAF, GuardDuty, CloudTrail, CI/CD, load testing |

Each phase is independently deliverable — member value starts accruing after Phase 3.

---

## Recommendation

- The proof of concept demonstrates the technology is mature, deployable, and cost-predictable
- Direct running cost (~$645/mo) is a fraction of comparable SaaS platforms or a contractor build
- No new licensing, authentication, or content-system investment required
- Recommend proceeding to **Phase 1** (data layer + connector setup) to begin the production path

---

# Questions?

**Companion documents:**
[The Problem](problem.md) · [Technical Solution](technicalsolution.md) · [How AI Is Used](aiusage.md) · [Solution Benefits](benefits.md)
[AWS Production Architecture](../AWS_PRODUCTION_ARCHITECTURE.md) · [AWS Cost Projection](../AWS_COST_PROJECTION.md)
