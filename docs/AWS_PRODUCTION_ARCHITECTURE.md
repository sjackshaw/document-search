# AWS Production Architecture

This document maps the current proof-of-concept (PoC) stack — built to run on a single MacBook — to the recommended AWS services for a production deployment.

---

## Current PoC vs AWS Production

| Component | PoC (MacBook) | AWS Production | Why |
|---|---|---|---|
| **Compute** | Docker Compose on laptop | ECS Fargate or EKS | Serverless containers, no instance management |
| **Embedding Model** | Xenova/bge-small-en-v1.5 (384d, ONNX in Node.js) | Amazon Bedrock — Cohere Embed v3 or Amazon Titan Embeddings V2 | Managed API, 1024d vectors, multilingual, far higher quality |
| **Vector Index** | PostgreSQL 15 + pgvector (HNSW) | Amazon OpenSearch Serverless (vector engine) or Amazon Aurora PostgreSQL + pgvector | Purpose-built vector search at scale with filtering |
| **LLM** | Ollama + Qwen 2.5 3B (local, CPU) | Amazon Bedrock — Anthropic Claude 3.5 Sonnet or Amazon Nova Pro | Managed, fast, high-quality reasoning; no GPU management |
| **Database** | PostgreSQL 15 (Docker) | Amazon Aurora PostgreSQL Serverless v2 | Auto-scaling, managed backups, high availability |
| **Document Source** | Local PDF volume mounts | SharePoint Online (Microsoft 365) document libraries | Single source of truth for documents; managed by content owners in 365 |
| **Web Content Source** | Local HTML file volume mounts | Umbraco CMS (web crawl) | Authoritative source for web-based benefits content |
| **Document Cache** | — | Amazon S3 (ETL staging) | Temporary cache during ETL; not the system of record |
| **ETL Orchestration** | node-cron in a container | AWS Step Functions + AWS Lambda | Event-driven, visual orchestration, pay-per-execution |
| **ETL Auth to SharePoint** | — | Entra ID app registration (`Sites.Selected`, client credentials) → AWS Secrets Manager | Least-privilege access to specific SharePoint site(s) only |
| **ETL Auth to Umbraco** | — | API key or basic auth → AWS Secrets Manager | Credentials for Umbraco Content Delivery API |
| **PDF Processing** | pdf-parse in Node.js | Amazon Textract | OCR support, table extraction, higher accuracy |
| **Networking** | Docker bridge network | VPC, ALB, private subnets, NAT gateway | Network isolation, TLS termination, WAF integration |
| **Secrets** | `.env` file / environment variables | AWS Secrets Manager | Audit trail, rotation, IAM-scoped access; stores Entra ID client credentials |
| **Monitoring** | `docker logs` | CloudWatch Logs, CloudWatch Metrics, X-Ray | Dashboards, alarms, distributed tracing |
| **Auth** | None (API key) | Amazon Cognito + ALB OIDC integration | SSO, MFA, user management |
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

| Option | Context Window | Strengths | Cost (est. per 1M tokens) |
|---|---|---|---|
| **Claude 3.5 Sonnet** | 200K tokens | Best reasoning + instruction following; excellent at citing sources | ~$3 input / $15 output |
| **Amazon Nova Pro** | 300K tokens | Low cost, fast, good for straightforward Q&A | ~$0.80 input / $3.20 output |
| **Claude 3.5 Haiku** | 200K tokens | Fast and cheap; good middle ground | ~$0.80 input / $4 output |
| Amazon Nova Lite | 300K tokens | Lowest cost; acceptable for simple lookups | ~$0.06 input / $0.24 output |

**Recommendation:** Start with **Claude 3.5 Sonnet** for highest answer quality, especially for a benefits Q&A product where accuracy matters. Use **Amazon Nova Pro** or **Claude 3.5 Haiku** as a cost-optimized fallback for high-volume, simple queries. The large context windows (200K–300K tokens) eliminate the need to aggressively truncate retrieved context — you can pass 20–50 chunks instead of the PoC's 10.

**RAG strategy upgrade:** With a production LLM, implement:
- **Re-ranking** — Use Cohere Rerank v3 (via Bedrock) to re-order the top-50 vector results before passing the top-10 to the LLM. This dramatically improves retrieval precision.
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

**PoC:** Four Node.js containers running under Docker Compose.

**AWS Production:**

| Service | Deployment |
|---|---|
| **Search API** | ECS Fargate (or App Runner for simplicity) behind ALB |
| **GenAI Chat API** | ECS Fargate behind ALB — separate service for independent scaling |
| **ETL Pipeline** | AWS Step Functions → Lambda functions (or ECS Fargate tasks for long-running jobs) |

**Recommendation:** **ECS Fargate** for the API services. Fargate removes all server management — you define CPU/memory per task, set auto-scaling rules, and deploy via CI/CD.

- Search API: 0.5 vCPU / 1 GB (scales on request count)
- GenAI Chat API: 0.5 vCPU / 1 GB (scales on request count — LLM work is offloaded to Bedrock)
- ETL: Step Functions orchestrating Lambda functions. Lambda handles the chunking and calls Bedrock for embeddings. For PDF processing, use Textract async jobs.

**Key difference from PoC:** The PoC runs the embedding model in-process (Node.js ONNX). In production, embedding is an API call to Bedrock, so the compute services need very little local CPU/memory.

### 5. ETL Pipelines

The PoC has two ETL pipelines (documents and web crawl) both reading from local file mounts. In production these become two separate Step Functions workflows pulling from distinct external sources.

---

#### 5a. Document ETL — SharePoint Online

**PoC:** `node-cron` scheduler in a Docker container running `vectorize.js`, reading PDFs from a local volume mount.

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
- DOCX, PPTX, XLSX — convert to PDF via a Lambda layer (e.g., LibreOffice) or ECS task before Textract

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

**PoC:** `node-cron` scheduler in a Docker container running `vectorize.js`, reading HTML files from a local volume mount.

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

### 6. Storage

**PoC:** PDFs mounted as Docker volumes. Web pages stored as local HTML files.

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
- **Linking back to originals:**
  - For documents: generate a SharePoint sharing link via Graph API, or serve a cached copy from S3 with CloudFront
  - For web content: link directly to the Umbraco-hosted page URL (the canonical source)

### 7. Frontend

**PoC:** Express serves static HTML from `public/`.

**AWS Production:**
- **S3 + CloudFront** for static assets (both the vector search UI and the chat UI)
- APIs served through **ALB** or **API Gateway** behind CloudFront
- Single CloudFront distribution with origin routing: `/api/*` → ALB, `/*` → S3

### 8. Security

| Concern | AWS Service |
|---|---|
| Authentication | Amazon Cognito (user pools, OIDC) |
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

Estimates for a moderate workload: ~10K chat queries/day, ~2K document searches/day, ~5K documents indexed.

| Service | Dev/Test | Production |
|---|---|---|
| ECS Fargate (2 services) | $30 | $150 |
| Aurora PostgreSQL Serverless v2 | $50 | $200 |
| *or* OpenSearch Serverless | $175 (2 OCU minimum) | $350 |
| Bedrock Embeddings (Titan V2) | $5 | $20 |
| Bedrock LLM (Claude 3.5 Sonnet) | $50 | $500 |
| *or* Bedrock LLM (Nova Pro) | $15 | $120 |
| S3 (staging only — source docs in SharePoint) | $1 | $3 |
| CloudFront | $1 | $10 |
| Secrets Manager, CloudWatch, etc. | $10 | $30 |
| **Total (Aurora + Sonnet)** | **~$150/mo** | **~$900/mo** |
| **Total (OpenSearch + Nova Pro)** | **~$240/mo** | **~$700/mo** |

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
- Re-vectorize all content with production embedding model
- Validate search quality against PoC baseline

### Phase 3 — Search API
- Deploy search API to ECS Fargate behind ALB
- Replace in-process embeddings with Bedrock API call
- Switch vector queries to OpenSearch or Aurora
- Deploy static frontend to S3 + CloudFront

### Phase 4 — GenAI Chat
- Deploy chat API to ECS Fargate
- Replace Ollama with Bedrock LLM calls
- Implement conversation persistence (DynamoDB for sessions instead of in-memory)
- Add Cohere Rerank for improved retrieval
- Implement streaming via Bedrock's `InvokeModelWithResponseStream`

### Phase 5 — Production Hardening
- Add Cognito authentication
- Enable WAF, GuardDuty, CloudTrail
- Set up monitoring dashboards and alarms
- Load test and tune auto-scaling policies
- Implement CI/CD pipeline (CodePipeline or GitHub Actions → ECR → ECS)

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
│  CloudFront  │────▶│  S3 (static) │     │   Amazon Cognito  │
│              │     └──────────────┘     │   (auth)          │
│              │                          └─────────┬─────────┘
│              │────▶┌──────────────┐               │
└──────────────┘     │     ALB      │◀──────────────┘
                     │  (TLS/WAF)   │
                     └──────┬───────┘
                            │
                ┌───────────┴───────────┐
                │                       │
        ┌───────▼───────┐       ┌───────▼───────┐
        │  ECS Fargate  │       │  ECS Fargate  │
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
