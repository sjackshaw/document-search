# AWS Cost Projection

Cost projection for the production AWS deployment described in [AWS_PRODUCTION_ARCHITECTURE.md](AWS_PRODUCTION_ARCHITECTURE.md). This is a continuously-running enterprise workload (not seasonal), so costs are tracked monthly, with annualized totals shown for budgeting purposes.

**Estimated cost — recommended configuration:** ~$815/mo production · ~$175/mo dev/test (see [Cost Summary](#cost-summary))

**Stack:** EKS · Aurora PostgreSQL Serverless v2 + pgvector · Amazon Bedrock (Titan V2 embeddings, Claude Sonnet 5) · S3 · CloudFront · Secrets Manager

---

## Cost Summary

> **Assumptions:** moderate workload of ~10K chat queries/day, ~2K document searches/day, ~5K documents indexed (same assumptions as the source architecture doc). Bedrock LLM costs use Claude Sonnet 5 standard pricing ($3 input / $15 output per MTok). Claude Sonnet 5's introductory rate ($2 input / $10 output per MTok) applied only through August 31, 2026 and has now lapsed as of this document's date — figures below already reflect standard pricing, so no further downward adjustment is needed. Authentication (Okta → PingFederate) is covered by existing enterprise licensing and carries no additional AWS cost.

| Component | Dev/Test (monthly) | Production (monthly) |
|---|---|---|
| EKS cluster (shared across search, chat, member APIs) | $75 | $250 |
| Aurora PostgreSQL Serverless v2 (+ pgvector) | $50 | $200 |
| Bedrock Embeddings (Titan V2) | $5 | $20 |
| Bedrock LLM (Claude Sonnet 5) | $30 | $300 |
| S3 (ETL staging only — source docs live in SharePoint) | $1 | $3 |
| CloudFront | $1 | $10 |
| Secrets Manager, CloudWatch, X-Ray | $10 | $30 |
| Authentication (Okta → PingFederate) | Org-provided | Org-provided |
| **Total (monthly)** | **~$175** | **~$815** |
| **Total (annualized)** | **~$2,100/yr** | **~$9,780/yr** |

---

## Alternate Configurations

The recommended stack above is one of several combinations evaluated in the architecture doc. Swapping compute, vector store, or LLM changes the total meaningfully:

| Configuration | Dev/Test (monthly) | Production (monthly) | Production (annualized) |
|---|---|---|---|
| **EKS + Aurora + Claude Sonnet 5** (recommended) | ~$175 | ~$815 | ~$9,780/yr |
| EKS + Aurora + Claude Haiku 4.5 | ~$155 | ~$615 | ~$7,380/yr |
| Lambda + API Gateway + Aurora + Claude Sonnet 5 | ~$110 | ~$645 | ~$7,740/yr |
| OpenSearch Serverless + Nova Pro + EKS | ~$315 | ~$850 | ~$10,200/yr |

> **Note on organisational constraint:** ECS/Fargate is not permitted per policy, so the Lambda + API Gateway row is the only lower-cost fallback to EKS, not a Fargate alternative. It trades ~$170/mo in production savings for less operational flexibility (cold starts, 15-minute execution limits) — see the "Compute" section of the architecture doc for details.

> **Note on OpenSearch:** the OpenSearch Serverless configuration costs more overall (2 OCU minimum floor of ~$175/mo even in dev/test) but adds native hybrid search (BM25 + vector) and metadata filtering that pgvector cannot match at scale. Only switch if query volume or filtering needs outgrow Aurora + pgvector (see [DATA_REVIEW.md](DATA_REVIEW.md)).

---

## Key Decisions

| Decision | Rationale |
|---|---|
| EKS over Lambda/API Gateway | Organisational policy mandates Kubernetes as the primary platform; Lambda is the approved fallback only where EKS isn't yet available |
| Aurora PostgreSQL Serverless v2 over OpenSearch Serverless | Keeps the existing pgvector schema and stored procedures with minimal migration effort; sufficient for the expected scale (thousands of documents, not millions) |
| Claude Sonnet 5 over Haiku 4.5 or Nova Pro | Best balance of answer quality and cost for benefits Q&A; Haiku 4.5 is the cost-optimized fallback for high-volume simple queries, Nova Pro's 5K-token output cap is too small for multi-paragraph RAG answers |
| Titan Embeddings V2 over Cohere Embed v3 | ~40% cheaper per token; acceptable quality trade-off unless retrieval precision becomes a measured problem |
| Separate EKS Deployments per API (search/chat/member) | Chat scales with Bedrock latency/concurrency, search scales with query volume, member scales with document-generation bursts — independent scaling avoids one workload starving the others |

---

## Revisiting This Projection

Update this document whenever:
- Bedrock model pricing changes (verify against [aws.amazon.com/bedrock/pricing](https://aws.amazon.com/bedrock/pricing/) — introductory rates and model availability change frequently)
- The workload assumptions above (chat/search volume, documents indexed) shift materially from actuals
- [AWS_PRODUCTION_ARCHITECTURE.md](AWS_PRODUCTION_ARCHITECTURE.md)'s "Cost Estimates (Monthly)" section is revised
