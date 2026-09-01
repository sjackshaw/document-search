# AWS Production Architecture

This document maps the current proof-of-concept (PoC) stack — built to run on a single MacBook — to the recommended AWS services for a production deployment.
> **2026-08-24 update:** The PoC's `app`, `genai-search`, and `member-benefits-app` services were merged into a single `portal` service/container (one Node.js process, three Express routers: `search.js`, `chat.js`, `member.js`). This section still recommends splitting search, chat, and member benefits into separate deployable units in AWS (see "Compute" below) because their production resource profiles differ significantly — chat is Bedrock-bound, search is embedding+DB-bound, and the member API is DB-bound with document-generation spikes. The PoC's single-container simplicity does not need to carry over to production, but starting from one deployable unit and splitting later (by route group, matching `services/portal/src/routes/`) is also a reasonable, lower-effort path if independent scaling isn't needed immediately.
> **PoC diagrams:** [System Architecture](diagrams/system-architecture.md) \u00b7 [Database Schema](diagrams/database-schema.md) \u00b7 [ETL Pipeline](diagrams/etl-pipeline.md)
> **Detailed cost breakdown:** see [AWS_COST_PROJECTION.md](AWS_COST_PROJECTION.md) for alternate configurations, annualized totals, and cost-driven key decisions.

---

## Current PoC vs AWS Production

| Component | PoC (MacBook) | AWS Production | Why |
|---|---|---|---|
| **Compute** | Docker Compose on laptop (single `portal` container + 3 ETL containers + Postgres + Ollama) | EKS (primary); Lambda + API Gateway (serverless fallback) | Kubernetes on AWS; no ECS/Fargate permitted by organisational policy; production still splits search/chat/member into separate deployables for independent scaling even though the PoC runs them as one process |
| **Embedding Model** | Xenova/bge-small-en-v1.5 (384d, ONNX in Node.js) | Amazon Bedrock — Cohere Embed v3 or Amazon Titan Embeddings V2 | Managed API, 1024d vectors, multilingual, far higher quality |
| **Vector Index** | PostgreSQL 15 + pgvector (HNSW) | Amazon OpenSearch Serverless (vector engine) or Amazon Aurora PostgreSQL + pgvector | Purpose-built vector search at scale with filtering |
| **LLM** | Ollama + Qwen 2.5 3B (local, CPU) | Amazon Bedrock — Anthropic Claude Sonnet 5 or Claude Haiku 4.5 | Managed, fast, high-quality reasoning; no GPU management |
| **Database** | PostgreSQL 15 (Docker) | Amazon Aurora PostgreSQL Serverless v2 | Auto-scaling, managed backups, high availability |
| **Document Source** | Local synthetic PDFs plus generated `manifest.json` | SharePoint Online (Microsoft 365) document libraries | Single source of truth for documents; managed by content owners in 365 |
| **Web Content Source** | Local synthetic HTML plus generated `web_manifest.json` | Umbraco CMS (web crawl) | Authoritative source for web-based benefits content |
| **Claims Source** | Local synthetic JSON files (`primary.json`, `logs.json`) | Carrier, TPA, or data-warehouse feeds via S3, API, or event stream | Replaces demo data with operational member claims events |
| **Document Cache** | — | Amazon S3 (ETL staging) | Temporary cache during ETL; not the system of record |
| **Generated Member Docs** | Local bind mount (`data-output/member-benefits-docs`) | Amazon S3 with presigned URLs | Durable storage and controlled download of generated member documents |
| **ETL Orchestration** | node-cron in a container | AWS Step Functions + AWS Lambda | Event-driven, visual orchestration, pay-per-execution |
| **ETL Auth to SharePoint** | — | Entra ID app registration (`Sites.Selected`, client credentials) → AWS Secrets Manager | Least-privilege access to specific SharePoint site(s) only |
| **ETL Auth to Umbraco** | — | API key or basic auth → AWS Secrets Manager | Credentials for Umbraco Content Delivery API |
| **PDF Processing** | Synthetic manifest generated from local source files | Amazon Textract | Production ingestion will need managed text extraction from real source documents |
| **Networking** | Docker bridge network | VPC, ALB, private subnets, NAT gateway | Network isolation, TLS termination, WAF integration |
| **Secrets** | `.env` file / environment variables | AWS Secrets Manager | Audit trail, rotation, IAM-scoped access; stores Entra ID client credentials |
| **Monitoring** | `docker logs` | CloudWatch Logs, CloudWatch Metrics, X-Ray | Dashboards, alarms, distributed tracing |
| **Auth** | Search/chat are open in local dev; member app uses API key plus member identity header | Okta (IdP) → PingFederate (federation hub) → ALB OIDC listener | Enterprise SSO via existing Okta/PingFed infrastructure; ALB validates OIDC tokens before forwarding requests |
| **CDN / Frontend** | Express static files | CloudFront + S3 (static hosting) | Global edge caching, HTTPS |

---

## Detailed Recommendations

### 1. Embedding Model

**PoC:** `Xenova/bge-small-en-v1.5` — a 33M-parameter SBERT model running as ONNX in Node.js. Produces 384-dimensional vectors. Chosen because it runs on CPU without external dependencies.

**AWS Production — Amazon Bedrock Embeddings:**

| Option | Dimensions | Strengths |
|---|---|---|
| **Cohere Embed English v3** | 1024 (or 256/384/512 with Matryoshka) | Best-in-class retrieval quality; compression-friendly |
| **Amazon Titan Embeddings V2** | 1024 (or 256/512) | Native AWS integration, low latency, cost-effective |
| Cohere Embed Multilingual v3 | 1024 | Use if multilingual content is in scope |

**Recommendation:** Start with **Cohere Embed v3** for highest retrieval quality. Use its flexible dimensions feature — embed at 1024d for storage, truncate to 512d at query time for faster search with minimal quality loss. If cost is the primary driver, Amazon Titan V2 is ~40% cheaper per token.

**Migration note:** Switching embedding models requires re-vectorizing all documents. Build the ETL pipeline to support re-indexing from the start.

### 2. Large Language Model (RAG Chat)

**PoC:** Qwen 2.5 3B running locally on Ollama (CPU-only, ~1.9 GB). Chosen because it's one of the few models that fits and runs acceptably on a MacBook with limited memory.

**AWS Production — Amazon Bedrock LLMs:**

> **Last reviewed:** August 4, 2026. Bedrock model availability and pricing change frequently — verify against [aws.amazon.com/bedrock/pricing](https://aws.amazon.com/bedrock/pricing/) before committing to a model.

| Option | Context Window | Max Output | Strengths | Cost (per 1M tokens) |
|---|---|---|---|---|
| **Claude Sonnet 5** ⭐ | 1M tokens | 128K tokens | Best balance of speed and intelligence; near-Opus quality at Sonnet cost; adaptive thinking always on | $3 input / $15 output¹ |
| **Claude Opus 5** | 1M tokens | 128K tokens | Highest general capability for complex agentic and enterprise work | $5 input / $25 output |
| **Claude Fable 5** | 1M tokens | 128K tokens | Top-of-range capability for long-running agents and deep reasoning; highest cost | $10 input / $50 output |
| **Claude Haiku 4.5** | 200K tokens | 64K tokens | Fastest model with near-frontier intelligence; lowest-cost Anthropic option | $1 input / $5 output |
| Amazon Nova Pro | 300K tokens | 5K tokens | Low cost, fast, native AWS; limited by 5K max output — suitable for short answers only | ~$0.80 input / $3.20 output |
| Amazon Nova Lite | 300K tokens | 5K tokens | Lowest cost per token; acceptable for very simple, short lookups only | ~$0.06 input / $0.24 output |

¹ Introductory pricing of **$2 input / $10 output** per MTok applies to Claude Sonnet 5 through August 31, 2026.

> **Note on Amazon Nova Premier:** Nova Premier reached **Legacy** status and has an EOL date of **September 14, 2026**. Do not use it for new deployments.

> **Note on Nova output limits:** Amazon Nova Pro and Nova Lite cap output at 5K tokens. This is adequate for short Q&A but is a hard constraint for RAG responses that include multi-paragraph answers or document summaries. Claude models allow 64K–128K output tokens, making them much better suited for a benefits Q&A product.

**Recommendation:** Start with **Claude Sonnet 5** for the best combination of answer quality, cost, and context capacity. Its 1M token context window means the PoC's `MAX_CONTEXT_CHARS` cap of 6,000 characters can be raised substantially — you can pass 50–100 chunks instead of the PoC's 10. For maximum accuracy with complex member benefits questions, step up to **Claude Opus 5**. Use **Claude Haiku 4.5** as the cost-optimized path for high-volume simple queries (e.g., "what is my deductible?") where latency matters more than depth.

**RAG strategy upgrade:** With a production LLM, implement:
- **Re-ranking** — Use Cohere Rerank 3.5 (via Bedrock) to re-order the top-50 vector results before passing the top-10 to the LLM. This dramatically improves retrieval precision.
- **Hybrid search** — Combine vector similarity with BM25 keyword search (OpenSearch supports this natively).

### 3. Vector Index / Search

**PoC:** pgvector with HNSW indexes inside PostgreSQL 15. Simple and effective for the PoC, but pgvector has limitations at scale (no hybrid search, limited filtering performance, no built-in reranking).

**AWS Production Options:**

| Option | Use When |
|---|---|
| **Amazon OpenSearch Serverless (vector engine)** | High query volume, need hybrid search (BM25 + kNN), metadata filtering, auto-scaling |
| **Amazon Aurora PostgreSQL + pgvector** | Want to keep everything in SQL, moderate scale (<10M vectors), team prefers PostgreSQL |
| Amazon Neptune Analytics | Graph + vector use case (not applicable here) |

**Recommendation:** **Amazon OpenSearch Serverless** with the vector engine. Benefits:
- Native hybrid search (combine keyword and vector scoring)
- Built-in metadata filtering (category, source type) without performance degradation
- Auto-scales compute and storage independently
- No cluster management

If the team wants to keep pgvector for simplicity, **Aurora PostgreSQL Serverless v2** with the pgvector extension is production-ready and handles the expected scale (thousands of documents, not millions).

### 4. Compute

**PoC:** A single Node.js container (`portal`) serving search, chat, and member benefits through separate Express routers, plus three short-lived ETL containers.

> **Organisational constraint:** ECS and ECS Fargate are not permitted. The preferred container platform is **EKS**. Where Kubernetes is not yet available or practical (e.g. early-phase deployments), fall back to **Lambda + API Gateway** for API services and **Step Functions + Lambda** for ETL.

#### Primary: Amazon EKS

| Service | EKS Deployment |
|---|---|
| **Search API** | Kubernetes `Deployment` + `Service`; exposed via ALB Ingress (AWS Load Balancer Controller) |
| **GenAI Chat API** | Kubernetes `Deployment` + `Service`; separate namespace or node group for independent scaling |
| **Member Benefits API** | Kubernetes `Deployment` + `Service`; member-scoped traffic and document generation |
| **ETL Pipelines** | Kubernetes `CronJob` (or `Job` triggered by EventBridge → Step Functions → EKS `run-job` step) |

**Recommendation:** Deploy all three API concerns as separate Kubernetes Deployments in a shared EKS cluster, with separate namespaces for isolation — even though the PoC runs them as one process, they have different scaling triggers (chat scales with Bedrock latency/concurrency, search scales with query volume, member scales with document-generation bursts) and splitting them avoids one workload's load spikes starving the others. Use the AWS Load Balancer Controller to provision ALB Ingress resources from Kubernetes manifests. Use Karpenter (or Cluster Autoscaler) for node auto-scaling.

- Search API: requests 256m CPU / 512Mi memory; scales on request count (KEDA HTTP add-on or HPA on custom metrics)
- GenAI Chat API: requests 256m CPU / 512Mi memory; LLM and embedding work is offloaded to Bedrock, so compute needs are light
- Member Benefits API: requests 256m CPU / 512Mi memory to start; scale on request count and document-generation volume
- ETL: Kubernetes `CronJob` resources (one per pipeline) replace `node-cron` containers. For long-running ingestion jobs (Textract, large batch embeds), use `Job` resources with a generous `activeDeadlineSeconds`; orchestrate with Step Functions calling the EKS `run-job` API action if central workflow visibility is needed.

#### Fallback: Lambda + API Gateway

If EKS is not available in the target account or region at deployment time, each API concern can be re-packaged as a Lambda function behind an API Gateway HTTP API:

| Service | Lambda Fallback |
|---|---|
| **Search API** | Lambda (Node.js 22.x) + API Gateway HTTP API; `GET /api/search*` and `GET /api/documents*` map to Lambda handlers |
| **GenAI Chat API** | Lambda (Node.js 22.x) + API Gateway HTTP API; streaming responses use Lambda response streaming (`InvokeWithResponseURL`) |
| **Member Benefits API** | Lambda (Node.js 22.x) + API Gateway HTTP API |
| **ETL Pipelines** | Step Functions + Lambda (Node.js 22.x); each ETL stage is a separate Lambda function (15-minute limit applies — split large batches accordingly) |

> Lambda's **15-minute execution limit** is a constraint for ETL steps that process large documents or large batches. Mitigate by splitting work into smaller per-document or per-chunk Lambda invocations coordinated by Step Functions Map states, or by using Textract's asynchronous job API (start job → poll or receive SNS notification → process results in a subsequent Lambda).

**Key difference from PoC:** The PoC runs the embedding model in-process (Node.js ONNX) inside a single container that also handles chat and member routes. In production, embedding is an API call to Bedrock, so the compute services need very little local CPU/memory regardless of whether they're deployed as one service or three, and regardless of whether EKS or Lambda is used — the split into three deployable units is primarily about independent scaling and blast-radius isolation, not resource requirements.

### 5. ETL Pipelines

The PoC has three ETL pipelines:

- document ETL from synthetic document manifests
- web-content ETL from synthetic HTML manifests
- claims ETL from synthetic member claims and claims activity logs

In production, these become separate workflows pulling from distinct systems of record.

---

#### 5a. Document ETL — SharePoint Online

**PoC:** `node-cron` scheduler in a Docker container running `vectorize.js`, reading the generated document manifest and embedding the associated page text.

**Production data source:** All benefits documents (PDFs, DOCX, PPTX) reside in **SharePoint Online** document libraries within the organization's Microsoft 365 tenant. The ETL pipeline pulls documents from SharePoint via the **Microsoft Graph API**.

**AWS Production:**

```
EventBridge Scheduler → Step Functions (Document ETL) →
  ┌─ Lambda (list/sync)  ← Microsoft Graph API ← SharePoint Online
  │    │
  │    ▼
  │  S3 (staging bucket)  ← downloaded documents
  │    │
  │    ▼
  ├─ Textract (extract text from PDFs)
  │    │
  │    ▼
  ├─ Lambda (chunk text)
  │    │
  │    ▼
  ├─ Bedrock (embed chunks)
  │    │
  │    ▼
  └─ OpenSearch / Aurora (load vectors, source_type = 'document')
```

##### SharePoint Connector Design

**Authentication — Entra ID App Registration with `Sites.Selected`:**

1. Register an application in **Microsoft Entra ID** (Azure AD) in the organization's tenant
2. Grant the **`Sites.Selected`** application permission — this is the **least-privilege** approach:
   - `Sites.Selected` grants **no access by default** — access must be explicitly granted to specific SharePoint site(s) via a separate Graph API call or SharePoint admin action
   - This is preferable to `Sites.Read.All` which grants read access to *every* site in the tenant
3. A SharePoint administrator grants the app registration **Read** permission on the specific benefits site(s):
   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   {
     "roles": ["read"],
     "grantedToIdentities": [{
       "application": {
         "id": "{client-id}",
         "displayName": "Benefits ETL"
       }
     }]
   }
   ```
4. Generate a **client secret** (or preferably a certificate) for the app registration
5. Store the credentials in **AWS Secrets Manager**:
   - Secret: `sharepoint/etl-credentials`
   - Fields: `tenant_id`, `client_id`, `client_secret` (or `certificate_pfx` + `certificate_password`), `site_id`
6. The ETL Lambda retrieves credentials from Secrets Manager at runtime via IAM role

**Why `Sites.Selected` over `Sites.Read.All`:**

| Permission | Scope | Risk |
|---|---|---|
| `Sites.Read.All` | Every SharePoint site in the tenant | High — leaked credentials expose all corporate content |
| **`Sites.Selected`** | **Only explicitly granted site(s)** | **Low — blast radius limited to the benefits site** |

**Sync Strategy:**

| Step | Detail |
|---|---|
| **1. Authenticate** | Lambda retrieves Entra ID credentials from Secrets Manager → requests OAuth2 token via client credentials flow (`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`) |
| **2. List changes** | Call Microsoft Graph [delta query](https://learn.microsoft.com/en-us/graph/delta-query-overview) on the document library to get only new/modified/deleted files since the last sync |
| **3. Download** | Download changed documents to an S3 staging bucket via Graph API (`/drives/{driveId}/items/{itemId}/content`) |
| **4. Process** | Run downloaded files through the pipeline: Textract → chunk → embed → load |
| **5. Handle deletes** | Remove vectors for documents deleted from SharePoint |
| **6. Record checkpoint** | Store the Graph delta token in DynamoDB or SSM Parameter Store for the next run |

**Schedule:** EventBridge Scheduler triggers the workflow on a configurable cadence (e.g., every 15 minutes or hourly). Delta queries ensure only changed documents are processed.

**Supported document types from SharePoint:**
- PDF — processed directly by Textract
- DOCX, PPTX, XLSX — convert to PDF via a Lambda layer (e.g., LibreOffice) or a dedicated EKS Job before Textract

##### Secrets Manager Configuration (SharePoint)

```json
{
  "SecretName": "sharepoint/etl-credentials",
  "SecretString": {
    "tenant_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "client_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "client_secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "site_id": "contoso.sharepoint.com,guid,guid",
    "drive_id": "b!xxxxxxxxxxxxxxxxxx"
  }
}
```

Enable **automatic rotation** (90-day cycle) using a Secrets Manager rotation Lambda that calls the Microsoft Graph API to regenerate the client secret and update both Entra ID and the Secrets Manager value.

---

#### 5b. Web Content ETL — Umbraco CMS

**PoC:** `node-cron` scheduler in a Docker container running `vectorize.js`, reading the generated web manifest and embedding sectioned page content.

**Production data source:** All web-based benefits content is hosted by an **Umbraco CMS** instance. The ETL pipeline retrieves content via Umbraco's **Content Delivery API** (or by crawling the rendered site).

**AWS Production:**

```
EventBridge Scheduler → Step Functions (Web Content ETL) →
  ┌─ Lambda (fetch content)  ← Umbraco Content Delivery API / web crawl
  │    │
  │    ▼
  │  S3 (staging bucket)  ← downloaded HTML / JSON content
  │    │
  │    ▼
  ├─ Lambda (extract text, split sections)
  │    │
  │    ▼
  ├─ Lambda (chunk text)
  │    │
  │    ▼
  ├─ Bedrock (embed chunks)
  │    │
  │    ▼
  └─ OpenSearch / Aurora (load vectors, source_type = 'web')
```

##### Umbraco Integration Options

| Approach | How | Best When |
|---|---|---|
| **Content Delivery API** (recommended) | Call Umbraco's built-in headless API (`/umbraco/delivery/api/v2/content`) to fetch structured JSON content | Umbraco 12+ with Content Delivery API enabled; cleanest data |
| **Web crawl** | HTTP GET each page URL, parse HTML (same as PoC approach but against the live Umbraco site) | Older Umbraco versions or when the API isn't exposed |
| **Webhook-triggered** | Umbraco fires a webhook on publish → API Gateway → Step Functions | Near-real-time indexing; requires Umbraco configuration |

**Recommendation:** Use the **Content Delivery API** if available. It returns structured JSON with content fields, metadata, and URLs — no HTML parsing required. This produces cleaner text chunks and more reliable section boundaries than scraping rendered HTML.

**Authentication:**
- If the Umbraco Content Delivery API requires authentication, store the API key in Secrets Manager:
  ```json
  {
    "SecretName": "umbraco/etl-credentials",
    "SecretString": {
      "base_url": "https://benefits.example.com",
      "api_key": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
  ```
- If the Umbraco site is publicly accessible (common for a benefits site), no credentials are needed — the Lambda makes unauthenticated HTTP requests
- If the Umbraco instance is on-prem or in a private network, route traffic through a **VPN** or **AWS PrivateLink** connection

**Sync Strategy:**

| Step | Detail |
|---|---|
| **1. List content** | Call the Umbraco Content Delivery API to list all published content items (or only items modified since last sync, if the API supports filtering by `updateDate`) |
| **2. Detect changes** | Compare content hashes (stored from previous run in DynamoDB) against current content to identify new/modified/deleted pages |
| **3. Extract text** | For API approach: extract text fields from JSON response. For crawl approach: strip HTML tags, extract semantic sections by heading |
| **4. Chunk & embed** | Same pipeline as document ETL — chunk text → Bedrock embed → load to vector DB |
| **5. Handle deletes** | Remove vectors for unpublished/deleted pages |
| **6. Record checkpoint** | Store content hashes and last sync timestamp in DynamoDB |

**Schedule:** EventBridge Scheduler triggers the workflow (e.g., every 30 minutes or hourly). If Umbraco webhooks are configured, the workflow can also run on-demand when content is published.

---

#### ETL Error Handling (Both Pipelines)

- **Token expiry (SharePoint):** OAuth2 tokens are short-lived (1 hour). The Lambda caches the token in memory and refreshes on 401 responses.
- **Throttling:** Microsoft Graph and Umbraco both enforce rate limits. Implement exponential backoff and respect `Retry-After` headers. Step Functions retries handle transient failures.
- **Large files (SharePoint):** For documents >10 MB, use Graph API's large file download (range requests). Lambda has a 512 MB `/tmp` limit; for very large files, stream directly to S3.
- **Umbraco downtime:** If the Umbraco site is unreachable, the web content ETL skips the run and retries on the next schedule. CloudWatch Alarm triggers after consecutive failures.
- **Permissions changes:** If the SharePoint app registration loses `Sites.Selected` access or the Umbraco API key is revoked, the respective workflow fails and triggers a CloudWatch Alarm → SNS notification.

---

#### 5c. Claims ETL — Carrier, TPA, or Warehouse Feed

**PoC:** `etl-claims-line` reads committed synthetic JSON files (`primary.json` and `logs.json`) and upserts member claims plus claims activity logs into PostgreSQL.

**Production data source:** Member claims should come from the operational system of record, typically one of:

- a nightly carrier or TPA file drop into S3
- a claims platform API
- a warehouse or event stream publishing adjudication updates

**AWS Production:**

```text
EventBridge Scheduler or EventBridge bus -> Step Functions (Claims ETL) ->
  Lambda (or EKS Job) to fetch and normalize claims -> Bedrock embeddings for searchable text fields ->
  Aurora PostgreSQL or OpenSearch -> Member Benefits API
```

**Recommended shape:**

| Stage | Recommendation |
|---|---|
| Ingest | Land source files or events in S3, or pull from the carrier API on a schedule |
| Normalize | Convert incoming claim records and timeline events into a stable internal schema |
| Load | Upsert claims, deductible facts, and claim logs into relational tables |
| Searchable text | Embed provider, claim type, status, and notes fields for member-scoped search |
| Audit | Preserve source file metadata, load status, and change logs for reconciliation |

**Why separate it from document search:** Claims data has different retention, privacy, and authorization requirements than public benefits content. Keep the workload isolated at both the storage and API layers.

### 6. Storage

**PoC:** Synthetic PDFs and HTML pages are stored locally, and generated member documents are written to a host-mounted directory.

**Production — Systems of Record:**
- **SharePoint Online** is the authoritative source for all benefits **documents** (PDFs, DOCX, PPTX)
  - Content owners upload, version, and manage documents through the normal SharePoint/Teams/365 workflow
- **Umbraco CMS** is the authoritative source for all benefits **web content** (articles, FAQs, guides)
  - Content editors publish and manage web pages through the Umbraco back office
- No manual file management in AWS — the two ETL pipelines are the only path content enters the search index

**Production — AWS Storage (ETL staging & cache):**
- **S3 staging bucket** — holds downloaded documents and web content temporarily during ETL processing
  - Lifecycle policy: delete objects after 7 days (these are copies, not the source of truth)
  - Separate prefixes: `documents/` (from SharePoint) and `web-content/` (from Umbraco)
- **S3 generated-documents bucket** — stores member-specific output documents such as EOBs and plan summaries
  - Use short-lived presigned URLs for download
  - Apply object lifecycle rules based on retention policy
- **Linking back to originals:**
  - For documents: generate a SharePoint sharing link via Graph API, or serve a cached copy from S3 with CloudFront
  - For web content: link directly to the Umbraco-hosted page URL (the canonical source)

### 7. Frontend

**PoC:** A single Express app (`portal`) serves three static HTML frontends from `public/search`, `public/chat`, and `public/member`, plus a tab-shell landing page at `/`.

**AWS Production:**
- **S3 + CloudFront** for static assets (search UI, chat UI, and member benefits UI)
- APIs served through **ALB** or **API Gateway** behind CloudFront
- Single CloudFront distribution with origin routing: `/api/*` → ALB, `/*` → S3

### 8. Security

| Concern | AWS Service |
|---|---|
| Authentication | **Okta → PingFederate → ALB OIDC listener**; users authenticate via Okta, PingFederate acts as the federation hub and issues OIDC tokens, the ALB OIDC authenticator validates tokens before routing to backend services |
| Authorization | IAM roles, resource policies |
| Network isolation | VPC with private subnets for databases and services |
| TLS | ACM certificates on ALB + CloudFront |
| WAF | AWS WAF on ALB / CloudFront |
| Secrets | Secrets Manager (DB credentials, API keys, **Entra ID app registration credentials for SharePoint**, **Umbraco API key**) |
| Compliance | CloudTrail, Config rules, GuardDuty |

### 9. Monitoring & Observability

| Signal | AWS Service |
|---|---|
| Logs | CloudWatch Logs (structured JSON) |
| Metrics | CloudWatch Metrics (latency, error rate, token usage) |
| Traces | AWS X-Ray (end-to-end request tracing through API → Bedrock → DB) |
| Dashboards | CloudWatch Dashboards or Grafana on Amazon Managed Grafana |
| Alarms | CloudWatch Alarms → SNS → PagerDuty/Slack |

---

## Cost Estimates (Monthly)

> See [AWS_COST_PROJECTION.md](AWS_COST_PROJECTION.md) for the full breakdown, alternate stack configurations, annualized totals, and the rationale behind each cost-driven decision.

Estimates for a moderate workload: ~10K chat queries/day, ~2K document searches/day, ~5K documents indexed. LLM costs use Claude Sonnet 5 standard pricing; an introductory rate of $2/$10 per MTok applies through August 31, 2026.

| Service | Dev/Test | Production |
|---|---|---|
| EKS cluster (shared, 3 services) | $75 | $250 |
| *or* Lambda + API Gateway (fallback) | $10 | $80 |
| Aurora PostgreSQL Serverless v2 | $50 | $200 |
| *or* OpenSearch Serverless | $175 (2 OCU minimum) | $350 |
| Bedrock Embeddings (Titan V2) | $5 | $20 |
| Bedrock LLM (Claude Sonnet 5) | $30 | $300 |
| *or* Bedrock LLM (Claude Haiku 4.5) | $10 | $100 |
| *or* Bedrock LLM (Nova Pro) | $15 | $120 |
| S3 (staging only — source docs in SharePoint) | $1 | $3 |
| CloudFront | $1 | $10 |
| Secrets Manager, CloudWatch, etc. | $10 | $30 |
| Authentication (Okta → PingFederate) | Org-provided | Org-provided |
| **Total (EKS + Aurora + Sonnet 5)** | **~$175/mo** | **~$815/mo** |
| **Total (EKS + Aurora + Haiku 4.5)** | **~$155/mo** | **~$615/mo** |
| **Total (Lambda + Aurora + Sonnet 5)** | **~$110/mo** | **~$645/mo** |
| **Total (OpenSearch + Nova Pro + EKS)** | **~$315/mo** | **~$850/mo** |

> **Recommended configuration — expected cost per month:**
> EKS + Aurora PostgreSQL + Claude Sonnet 5 → **~$815/mo (production)** · **~$175/mo (dev/test)**
> Authentication (Okta → PingFederate) is covered by existing enterprise licensing and carries no additional AWS cost.

---

## Migration Phases

### Phase 1 — Data Layer & External Source Setup
- Provision Aurora PostgreSQL with pgvector (or OpenSearch Serverless)
- Migrate existing DB schema and stored procedures
- Set up S3 staging bucket with `documents/` and `web-content/` prefixes
- **SharePoint setup:**
  - Register an **Entra ID application** in the 365 tenant
  - Grant the **`Sites.Selected`** application permission (not `Sites.Read.All`)
  - Have a SharePoint admin grant the app **Read** access to the specific benefits site via Graph API permissions endpoint
  - Generate a client secret (or certificate)
  - Store credentials (`tenant_id`, `client_id`, `client_secret`, `site_id`) in **AWS Secrets Manager**
  - Organize benefits documents into the SharePoint document library
- **Umbraco setup:**
  - Enable the Umbraco Content Delivery API (if not already enabled)
  - Generate an API key if the endpoint requires authentication
  - Store Umbraco credentials (`base_url`, `api_key`) in **AWS Secrets Manager**
  - Confirm the content structure and URL patterns for benefits web pages

### Phase 2 — ETL Pipelines
- **Document ETL (SharePoint):**
  - Build Step Functions workflow for document ingestion
  - Implement Microsoft Graph API connector Lambda (authenticate via Secrets Manager → Entra ID OAuth2 client credentials flow with `Sites.Selected` scope)
  - Implement delta sync using Graph delta queries
  - Download documents to S3 staging bucket (`documents/` prefix)
  - Integrate Amazon Textract for PDF processing; add Office format conversion for DOCX/PPTX
  - Switch embedding calls from local ONNX to Bedrock
  - Implement delete handling
  - Set up Secrets Manager rotation Lambda for Entra ID client secret
- **Web Content ETL (Umbraco):**
  - Build separate Step Functions workflow for web content ingestion
  - Implement Umbraco Content Delivery API connector Lambda
  - Implement change detection via content hashing (store hashes in DynamoDB)
  - Download content to S3 staging bucket (`web-content/` prefix)
  - Extract text from JSON responses (or HTML if crawling)
  - Chunk, embed via Bedrock, and load to vector DB
  - Implement delete handling for unpublished pages
- **Claims ETL:**
  - Integrate carrier, TPA, or warehouse feeds
  - Normalize claims and activity events into the production schema
  - Preserve change logs and reconciliation metadata
  - Generate member-scoped searchable embeddings where needed
- Re-vectorize all content with production embedding model
- Validate search quality against PoC baseline

### Phase 3 — Search API
- **EKS path:** Build and push Docker image to ECR; apply Kubernetes `Deployment`, `Service`, and `Ingress` manifests; expose via ALB Ingress (AWS Load Balancer Controller)
- **Lambda fallback:** Package search handlers as Lambda functions; create API Gateway HTTP API with `GET /api/search*` and `GET /api/documents*` routes
- Replace in-process embeddings with Bedrock API call
- Switch vector queries to OpenSearch or Aurora
- Deploy static frontend to S3 + CloudFront

### Phase 4 — GenAI Chat
- **EKS path:** Deploy chat API as a Kubernetes `Deployment`; streaming SSE responses work without modification in EKS
- **Lambda fallback:** Use Lambda response streaming (`FunctionUrlConfig: InvokeMode: RESPONSE_STREAM`) or API Gateway WebSocket API for streaming; replace Ollama with Bedrock LLM calls
- Implement conversation persistence (DynamoDB for sessions instead of in-memory)
- Add Cohere Rerank 3.5 for improved retrieval
- Implement streaming via Bedrock's `InvokeModelWithResponseStream`

### Phase 5 — Member Benefits Experience
- **EKS path:** Deploy member benefits API as a Kubernetes `Deployment`; mount generated-docs volume or switch to S3
- **Lambda fallback:** Package member benefits handlers as Lambda functions behind API Gateway
- Integrate Okta → PingFederate OIDC with the ALB listener; propagate member identity downstream via JWT claims (`sub`, `email`, or a custom claim) as a request header
- Move generated documents to S3 with presigned downloads
- Apply member-scoped authorization checks to claims, deductible, and generated-document endpoints

### Phase 6 — Production Hardening
- Validate Okta → PingFederate OIDC integration end-to-end; confirm ALB OIDC listener rejects unauthenticated requests and that member identity flows correctly to backend services
- Enable WAF, GuardDuty, CloudTrail
- Set up monitoring dashboards and alarms
- Load test and tune auto-scaling / Karpenter node provisioning policies (EKS) or Lambda concurrency limits (fallback)
- Implement CI/CD pipeline (CodePipeline or GitHub Actions → ECR → EKS rolling deployment or Lambda update)

---

## Architecture Diagram

```
  ┌─────────────────────────────────┐       ┌─────────────────────────────┐
  │   Microsoft 365                  │       │   Umbraco CMS               │
  │  ┌───────────────────────────┐   │       │  ┌───────────────────────┐  │
  │  │  SharePoint Online         │   │       │  │  Benefits Website     │  │
  │  │  (Document Libraries)      │   │       │  │  (Articles, FAQs,     │  │
  │  │  ┌─────┐ ┌──────┐ ┌─────┐ │   │       │  │   Guides)             │  │
  │  │  │ PDF │ │ DOCX │ │ PPTX│ │   │       │  └───────────┬───────────┘  │
  │  │  └──┬──┘ └──┬───┘ └──┬──┘ │   │       │              │              │
  │  └─────┼───────┼────────┼────┘   │       │  ┌───────────▼───────────┐  │
  │        │       │        │        │       │  │  Content Delivery API │  │
  │  ┌─────▼───────▼────────▼────┐   │       │  │  (or web crawl)       │  │
  │  │  Microsoft Graph API       │   │       │  └───────────┬───────────┘  │
  │  │  (delta queries)           │   │       └──────────────┼──────────────┘
  │  └─────────────┬──────────────┘   │                      │
  │               │                   │                      │
  │  ┌────────────▼──────────────┐    │                      │
  │  │  Entra ID (App Reg)       │    │                      │
  │  │  Sites.Selected           │    │                      │
  │  │  OAuth2 Client Credentials│    │                      │
  │  └───────────────────────────┘    │                      │
  └───────────────┬───────────────────┘                      │
                  │                                          │
══════════════════╪══════════════════════════════════════════╪══════
  AWS             │                                          │
                  │                                          │
  ┌───────────────▼──────────────────────────────────────────▼────┐
  │  Secrets Manager                                             │
  │  (SharePoint: tenant_id, client_id, client_secret, site_id)  │
  │  (Umbraco: base_url, api_key)                                │
  └───────────────┬──────────────────────────────────┬───────────┘
                  │                                  │
  ┌───────────────▼───────────────┐  ┌───────────────▼───────────────┐
  │  EventBridge Scheduler        │  │  EventBridge Scheduler        │
  │  (e.g. every 15 min)          │  │  (e.g. every 30 min)          │
  └───────────────┬───────────────┘  └───────────────┬───────────────┘
                  │                                  │
  ┌───────────────▼───────────────┐  ┌───────────────▼───────────────┐
  │  Step Functions               │  │  Step Functions               │
  │  Document ETL                 │  │  Web Content ETL              │
  │  ┌─────────────────────────┐  │  │  ┌─────────────────────────┐  │
  │  │ 1. Auth + Graph delta   │  │  │  │ 1. Fetch Umbraco API    │  │
  │  │ 2. Download → S3        │  │  │  │ 2. Detect changes       │  │
  │  │ 3. Textract (PDF)       │  │  │  │ 3. Extract text         │  │
  │  │ 4. Chunk text           │  │  │  │ 4. Chunk text           │  │
  │  │ 5. Bedrock embed        │  │  │  │ 5. Bedrock embed        │  │
  │  │ 6. Load (source_type=   │  │  │  │ 6. Load (source_type=   │  │
  │  │    'document')          │  │  │  │    'web')               │  │
  │  └─────────────────────────┘  │  │  └─────────────────────────┘  │
  └───────────────────────────────┘  └───────────────────────────────┘

┌──────────────┐     ┌──────────────┐     ┌───────────────────┐
│  CloudFront  │────▶│  S3 (static) │     │ Okta → PingFed    │
│              │     └──────────────┘     │ (OIDC / SAML)     │
│              │                          └─────────┬─────────┘
│              │────▶┌──────────────┐               │
└──────────────┘     │     ALB      │◀──────────────┘
                     │  (TLS/WAF)   │
                     └──────┬───────┘
                            │
                ┌───────────┴───────────┐
                │                       │
        ┌───────▼───────┐       ┌───────▼───────┐
        │  EKS Pod      │       │  EKS Pod      │
        │  Search API   │       │  GenAI Chat   │
        └───────┬───────┘       └───┬───────┬───┘
                │                   │       │
                │           ┌───────▼──┐ ┌──▼──────────┐
                │           │ Bedrock  │ │  Bedrock    │
                │           │ Embed    │ │  LLM        │
                │           └───────┬──┘ └──┬──────────┘
                │                   │       │
        ┌───────▼───────────────────▼───────▼───┐
        │  Aurora PostgreSQL + pgvector          │
        │  (or OpenSearch Serverless)            │
        └───────────────────────────────────────┘
```
