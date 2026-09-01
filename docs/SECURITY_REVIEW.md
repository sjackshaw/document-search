# Security Analysis Report — document-search

**Date**: March 16, 2026 (C-1 status updated August 4, 2026)  
**2026-08-24 update**: `app`, `genai-search`, and `member-benefits-app` were merged into a single `portal` service (`services/portal/`, one container, port 3000). File references below to `services/app/src/index.js` and `services/genai-search/src/index.js` now correspond to `services/portal/src/routes/search.js` and `services/portal/src/routes/chat.js`; `services/member-benefits-app/src/index.js` now corresponds to `services/portal/src/routes/member.js`, mounted at `/api/member/*`. The per-router authorization boundaries described in C-1 are unchanged by the merge (search/chat routes remain unauthenticated; `/api/member/*` still requires `x-api-key` when `API_KEY` is set) — only the process/container boundary collapsed from three to one. A **new finding (C-3)** was added below for the chat routes' new optional `memberEmail` personalization feature, which has no authorization check.  
**Scope**: Full codebase review (application services, ETL pipelines, Docker infrastructure, database schema, frontend clients)  
**Methodology**: Manual code review mapped to OWASP Top 10 (2021) and CWE identifiers

---

## Executive Summary

The project uses parameterized SQL queries and `path.basename()` for file serving, which mitigates the most critical injection and path traversal vectors. However, significant gaps remain: **search and chat API endpoints are unauthenticated**, HTML files are served under the application origin enabling stored XSS, default database credentials are hardcoded throughout, no security headers are set, no rate limiting exists, and internal error details leak to clients.

**Finding Counts**: Critical: 3 | High: 5 | Medium: 6 | Low: 3 | Informational: 3

> **August 4, 2026 update:** C-1 is **partially resolved**. The member-benefits routes (`/api/member/*`) enforce `API_KEY` via an `x-api-key` header check, returning `401 Unauthorized` for missing or invalid keys. **2026-08-24:** these routes, along with search and chat, now all live in the single `portal` service (port 3000) after the `app`/`genai-search`/`member-benefits-app` merge — the search (`/api/*`) and chat (`/api/chat`, `/api/ask`, etc.) routes remain unauthenticated in local development.

---

## Findings

### CRITICAL

---

#### C-1: Search and Chat API Endpoints Lack Authentication — ⚠ PARTIALLY RESOLVED

| Attribute | Value |
|---|---|
| **Category** | Broken Access Control |
| **OWASP** | A01:2021 — Broken Access Control |
| **CWE** | CWE-306: Missing Authentication for Critical Function |
| **Files** | `services/portal/src/routes/search.js`, `services/portal/src/routes/chat.js` |

**Description**: Every endpoint in the search routes (`/api/search*`, `/api/documents*`, etc.) and chat routes (`/api/chat`, `/api/ask`, `/api/analytics/*`) is freely accessible without any authentication or authorization. These are mounted in the same `portal` process/container as the member routes, but on separate, unauthenticated route groups.

**August 4, 2026 — Partial resolution:** the member-benefits routes (now `/api/member/*` within `portal`, formerly the standalone `member-benefits-app` on port 3002) enforce the `API_KEY` environment variable. All `/api/member/*` routes require an `x-api-key` header matching `process.env.API_KEY` and return `401 Unauthorized` for missing or invalid keys. Member identity is resolved via `x-member-email` header, `memberEmail` query parameter, or request body field, with a `404` returned when the member is not found in the claims data.

**Remaining exposure:**
- Search routes (`/api/search*`, `/api/documents*`, `/api/web-sources`, `/api/etl-jobs`): still unauthenticated in local development. The admin endpoints (`PATCH /api/documents/:id`, `DELETE /api/documents/:id`) support an optional `X-Admin-Key` / `ADMIN_KEY` guard but it is not enabled by default.
- Chat routes (`/api/chat`, `/api/ask`, `/api/feedback`, `/api/analytics/*`): still unauthenticated.

**Risk**: Unrestricted access to document search and chat; unconstrained LLM usage.

**Remaining remediation:**
1. Apply API key middleware to the search and chat routes, matching the pattern already implemented for `/api/member/*`.
2. Enable `ADMIN_KEY` for the admin endpoints in any non-local environment.
3. For chat, consider per-user authentication to prevent session hijacking.

---

#### C-2: Stored XSS via Same-Origin HTML File Serving

| Attribute | Value |
|---|---|
| **Category** | Cross-Site Scripting (XSS) |
| **OWASP** | A03:2021 — Injection |
| **CWE** | CWE-79: Improper Neutralization of Input During Web Page Generation |
| **Files** | `services/portal/src/routes/search.js` (`GET /api/web-pages/:filename`) |

**Description**: The `/api/web-pages/:filename` endpoint serves raw HTML files from disk with `Content-Type: text/html; charset=utf-8` under the **same origin** as the rest of the application (port 3000):

```js
app.get('/api/web-pages/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(WEB_PAGES_DIR, filename);
  // ...
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(filePath).pipe(res);
});
```

If any HTML file in the web-pages data directory contains or is modified to contain malicious JavaScript, it will execute in the main application's origin. **2026-08-24 update:** since the `app`/`genai-search`/`member-benefits-app` merge, this origin (port 3000) now also serves the chat UI and the member benefits UI, so the blast radius is larger than when this finding was first written — an attacker-crafted page could:
- Steal cookies/session tokens via `document.cookie`
- Make authenticated API calls on behalf of the user, including `/api/member/*` calls if an `X-API-Key`/session were ever cached client-side
- Exfiltrate search history and chat conversation content

The ETL pipeline ingests externally-sourced web content, making this a realistic attack vector — any compromised or malicious content in the crawl data flows directly into servable HTML.

**Risk**: Full same-origin JavaScript execution via malicious crawled content, now with a larger attack surface (chat + member routes co-located).

**Remediation**:
1. Serve user-uploaded/crawled HTML from a **separate domain or subdomain** (e.g., `static-content.example.com`) so it is cross-origin isolated.
2. Alternatively, serve HTML inside a sandboxed `<iframe>` with `sandbox="allow-same-origin"` only, or strip all `<script>` tags and event handlers before serving.
3. Set `Content-Security-Policy` headers on served HTML to block inline scripts: `Content-Security-Policy: script-src 'none'`.
4. Add `X-Content-Type-Options: nosniff` to prevent MIME-type sniffing.

---

#### C-3: Unauthenticated Member Impersonation via Chat `memberEmail` Parameter — NEW (2026-08-24)

| Attribute | Value |
|---|---|
| **Category** | Broken Access Control |
| **OWASP** | A01:2021 — Broken Access Control |
| **CWE** | CWE-639: Authorization Bypass Through User-Controlled Key |
| **Files** | `services/portal/src/routes/chat.js` (`buildMemberContext`, `POST /api/chat`, `POST /api/ask`), `services/portal/public/chat/index.html` (member picker) |

**Description**: The chat routes were extended to optionally personalize answers using a member's own claims record. The caller supplies an arbitrary `memberEmail` field in the request body — there is no session, token, or header proving the caller is that member (or is authorized to view their data):

```js
let memberContext = null;
if (memberEmail) {
  memberContext = await buildMemberContext(memberEmail); // no ownership/authorization check
}
```

`buildMemberContext()` resolves the email directly against the `claims` table (parameterized query, no SQL injection risk) and, if found, returns that member's open claims, claims summary, and deductible status — all of which are then included in the streamed/returned chat answer. Unlike `/api/member/*`, this path is **not** gated by `API_KEY`, `x-member-email` ownership, or any other check: `POST /api/chat` and `POST /api/ask` are otherwise fully anonymous endpoints.

The shipped UI (`/chat`) makes this trivially exploitable by design — it lists all members via `GET /api/chat/members` (also unauthenticated) in a plain dropdown, so any visitor can select any member and ask for their claims, billed/paid amounts, and deductible status.

**Risk**: Full read access to any member's personal claims and health-benefits-adjacent financial data (billed/paid amounts, provider names, claim statuses, deductible spend) by anyone who can reach the chat endpoint, with no authentication at all. This is a straightforward IDOR (Insecure Direct Object Reference) against health/financial data.

**Context**: This was an intentional demo shortcut (see the "single chat, chosen via dropdown" feature request) explicitly scoped to make it easy to demo personalized answers without building session-linked member auth. It is appropriate for a local demo audience but **must not** be deployed as-is anywhere the claims data is real or the chat endpoint is reachable by untrusted users.

**Remediation**:
1. Before production use, require the same authentication `/api/member/*` already uses (`API_KEY` + a session/token proving the caller *is* that member) before resolving `memberEmail` in chat.
2. Remove or gate `GET /api/chat/members` behind the same auth — it currently enumerates all members' emails and claim counts to any caller.
3. If a demo mode is still desired in shared/production environments, put it behind a feature flag defaulting to off, and label it clearly as impersonation-capable in any deployment docs.

---

### HIGH

---

#### H-1: Default / Hardcoded Database Credentials

| Attribute | Value |
|---|---|
| **Category** | Cryptographic / Credential Failure |
| **OWASP** | A07:2021 — Identification and Authentication Failures |
| **CWE** | CWE-798: Use of Hard-coded Credentials |
| **Files** | `docker-compose.postgres.yml` (lines 8-10), `docker-compose.portal.yml`, `docker-compose.etl-documents.yml`, `docker-compose.etl-webcrawl.yml`, `docker-compose.etl-claims-line.yml` |

**Description**: Every Docker Compose file embeds the same default credentials as fallback values:

```yaml
PGUSER: ${PGUSER:-postgres}
PGPASSWORD: ${PGPASSWORD:-postgres}
```

The `.env.example` file also contains `PGPASSWORD=postgres`. The setup script at `startup/setup.sh` copies `.env.example` to `.env` verbatim, so production deployments that follow the setup flow will run with well-known credentials.

**Risk**: Any attacker with network access to port 5433 (exposed in the postgres compose file) can connect with `postgres/postgres`.

**Remediation**:
1. Remove default password fallbacks from compose files; require explicit `.env` configuration.
2. Generate random credentials in `setup.sh` instead of copying defaults.
3. Use Docker secrets or a vault integration for production.
4. Do not expose the Postgres port (5433) to the host in production.

---

#### H-2: PostgreSQL Port Exposed to Host Network

| Attribute | Value |
|---|---|
| **Category** | Security Misconfiguration |
| **OWASP** | A05:2021 — Security Misconfiguration |
| **CWE** | CWE-668: Exposure of Resource to Wrong Sphere |
| **File** | `docker-compose.postgres.yml` (line 6) |

**Description**: The PostgreSQL service is mapped to host port 5433:

```yaml
ports:
  - "5433:5432"
```

Combined with default credentials (H-1), this allows any process on the host or local network to directly connect to the database and read/modify all document data, embeddings, and ETL job logs.

**Risk**: Direct unprotected database access from the host network.

**Remediation**:
1. Remove port mapping for production; services connect via the Docker internal network.
2. If host access is needed for debugging, bind only to localhost: `"127.0.0.1:5433:5432"`.

---

#### H-3: No Rate Limiting on LLM-Backed Endpoints

| Attribute | Value |
|---|---|
| **Category** | Resource Exhaustion / DoS |
| **OWASP** | A04:2021 — Insecure Design |
| **CWE** | CWE-770: Allocation of Resources Without Limits or Throttling |
| **File** | `services/genai-search/src/index.js` (lines 158-230) |

**Description**: The `/api/chat` and `/api/ask` endpoints (now `services/portal/src/routes/chat.js`) trigger embedding generation + LLM inference on every request with no rate limiting. An attacker can flood these endpoints to:
- Exhaust GPU/CPU resources via Ollama inference
- Consume all available database connections via the `pg` pool
- Cause denial of service for legitimate users

The search routes (`services/portal/src/routes/search.js`) also have no rate limiting, though they are less expensive.

**Risk**: Service degradation or complete denial of service through resource exhaustion.

**Remediation**:
1. Add `express-rate-limit` middleware (e.g., 10 requests/minute per IP for chat endpoints, 60/minute for search).
2. Configure the `pg` Pool with explicit `max` connection limits.
3. Set request timeouts on the Express server.

---

#### H-4: Missing Security Headers

| Attribute | Value |
|---|---|
| **Category** | Security Misconfiguration |
| **OWASP** | A05:2021 — Security Misconfiguration |
| **CWE** | CWE-693: Protection Mechanism Failure |
| **Files** | `services/portal/src/index.js`, `services/portal/src/routes/search.js`, `services/portal/src/routes/chat.js` |

**Description**: Neither route group sets any security headers on the shared `portal` Express app. Missing headers include:
- `Content-Security-Policy` — no CSP at all, allows inline scripts
- `X-Content-Type-Options` — no MIME sniffing protection
- `X-Frame-Options` — no clickjacking protection
- `Strict-Transport-Security` — no HSTS (relevant for production)
- `X-XSS-Protection` — legacy but still useful for older browsers
- `Referrer-Policy`
- `Permissions-Policy`

**Risk**: Increased attack surface for XSS, clickjacking, MIME confusion, and data leakage via referrer headers.

**Remediation**:
1. Add the `helmet` npm package and use `app.use(helmet())` in both services.
2. Configure a strict CSP that disallows inline scripts: `script-src 'self'`.

---

#### H-5: No Request Body Size Limit

| Attribute | Value |
|---|---|
| **Category** | Resource Exhaustion |
| **OWASP** | A04:2021 — Insecure Design |
| **CWE** | CWE-400: Uncontrolled Resource Consumption |
| **Files** | `services/portal/src/index.js`, `services/portal/src/routes/search.js`, `services/portal/src/routes/chat.js` |

**Description**: The shared `portal` app uses `app.use(express.json({ limit: '1mb' }))` — an explicit limit exists (unlike the original finding, which predates the merge and described the implicit Express default), but `1mb` is still generous for a chat question. An attacker could send many large payloads to the chat endpoints, where the question is embedded and sent to the LLM, amplifying resource consumption.

**Risk**: Memory exhaustion via large JSON payloads, especially when combined with the lack of rate limiting.

**Remediation**:
1. Set explicit limits: `app.use(express.json({ limit: '10kb' }))`.
2. Validate `question` string length in the chat handler (e.g., max 2000 characters).

---

### MEDIUM

---

#### M-1: Internal Error Details Leaked to Clients

| Attribute | Value |
|---|---|
| **Category** | Information Disclosure |
| **OWASP** | A01:2021 — Broken Access Control |
| **CWE** | CWE-209: Generation of Error Message Containing Sensitive Information |
| **File** | `services/genai-search/src/index.js` (lines 204-207 and 238-239) |

**Description**: Error responses in the chat routes (now `services/portal/src/routes/chat.js`) expose the raw `err.message` to clients:

```js
res.status(500).json({ error: 'Chat failed', detail: err.message });
res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
res.status(500).json({ error: 'Ask failed', detail: err.message });
```

This can leak internal infrastructure details (hostnames, ports, stack information, database error messages).

**Risk**: Information disclosure aids attacker reconnaissance.

**Remediation**:
1. Return generic error messages to clients: `{ error: 'An internal error occurred' }`.
2. Log full error details server-side only.

---

#### M-2: Session Hijacking via Predictable Session Flow

| Attribute | Value |
|---|---|
| **Category** | Session Management |
| **OWASP** | A07:2021 — Identification and Authentication Failures |
| **CWE** | CWE-384: Session Fixation |
| **File** | `services/genai-search/src/index.js` (lines 164-172) |

**Description**: The chat endpoints (now `services/portal/src/routes/chat.js`) accept a user-supplied `sessionId` in the request body. While UUIDs are cryptographically random (using `crypto.randomUUID()`), the session ID is returned in a response header (`X-Session-Id`) without TLS enforcement and accepted from any client without binding to an IP, user agent, or auth token.

**Risk**: Unauthorized access to conversation history containing potentially sensitive benefits questions.

**Remediation**:
1. Bind sessions to authenticated users rather than accepting arbitrary session IDs from clients.
2. If anonymous sessions must exist, generate session IDs server-side only and set them as `HttpOnly`, `Secure`, `SameSite=Strict` cookies.
3. Enforce HTTPS so session IDs are not transmitted in cleartext.

---

#### M-3: Ollama Service Exposed on Host Network

| Attribute | Value |
|---|---|
| **Category** | Security Misconfiguration |
| **OWASP** | A05:2021 — Security Misconfiguration |
| **CWE** | CWE-668: Exposure of Resource to Wrong Sphere |
| **File** | `docker-compose.ollama.yml` (line 6) |

**Description**: The Ollama container exposes port 11434 to the host with no built-in authentication (overridable via `OLLAMA_HOST_PORT`). Any host or network-local process can directly call `http://localhost:11434/api/chat` to use the LLM, bypassing any application-level controls.

**Risk**: Unauthorized direct LLM access, resource abuse.

**Remediation**:
1. Remove the port mapping; the `portal` chat routes connect via the Docker internal network.
2. If host access is needed, bind to localhost only: `"127.0.0.1:11434:11434"`.

---

#### M-4: Ollama Container Runs as Root

| Attribute | Value |
|---|---|
| **Category** | Docker Security |
| **OWASP** | A05:2021 — Security Misconfiguration |
| **CWE** | CWE-250: Execution with Unnecessary Privileges |
| **File** | `docker-compose.ollama.yml` (lines 3-14) |

**Description**: The Ollama container uses the default `ollama/ollama:latest` image which runs as root. The volume mount at `/root/.ollama` confirms this. The application Node.js containers (`portal`, ETL services) correctly use `USER node`, but the Ollama container is an exception.

**Risk**: Container breakout from Ollama would grant root-level host access.

**Remediation**:
1. Apply Docker security options: `security_opt: [no-new-privileges:true]`, `read_only: true` (with tmpfs for runtime writes).

---

#### M-5: DOM XSS Pattern in Frontend Error Rendering

| Attribute | Value |
|---|---|
| **Category** | Cross-Site Scripting (XSS) |
| **OWASP** | A03:2021 — Injection |
| **CWE** | CWE-79: Improper Neutralization of Input During Web Page Generation |
| **File** | `services/app/public/index.html` |

**Description**: The search UI (now `services/portal/public/search/index.html`) renders server error messages using `innerHTML` without escaping:

```js
resultsEl.innerHTML = `<div class="no-results"><h2>Error</h2><p>${data.error || 'Search failed'}</p></div>`;
```

The `escapeHtml()` function exists in the same file but isn't used here.

**Risk**: Low immediate risk (server errors are fixed strings), but a fragile pattern that could become exploitable with future changes.

**Remediation**: Use `escapeHtml(data.error || 'Search failed')` or use `textContent` assignment instead of `innerHTML`.

---

#### M-6: Category Parameter Passthrough Without Allowlist

| Attribute | Value |
|---|---|
| **Category** | Input Validation |
| **OWASP** | A03:2021 — Injection |
| **CWE** | CWE-20: Improper Input Validation |
| **File** | `services/app/src/queryParser.js` (lines 65-69) |

**Description**: The `category:` prefix parser (now `services/portal/src/queryParser.js`) extracts any arbitrary string and passes it through if it doesn't match a known alias:

```js
category = CATEGORY_ALIASES[alias] || alias;  // passes unknown values through
```

**Risk**: Low — no injection due to parameterized queries — but violates the principle of strict input validation.

**Remediation**: Validate category against the known set: `category = CATEGORY_ALIASES[alias] || null;`

---

### LOW

---

#### L-1: No HTTPS / TLS Configuration

All services communicate over plaintext HTTP. Session IDs, API keys (if enforced), and all employee benefits data transmit in cleartext. For production, terminate TLS at a reverse proxy (nginx, Traefik, ALB).

---

#### L-2: In-Memory Session Store Not Suitable for Production

Sessions are stored in a JavaScript `Map()`. Sessions are lost on restart, don't persist across replicas, and accumulate unbounded between purge cycles. For production, use Redis or a database-backed session store.

---

#### L-3: No File Extension Validation on Served Files

The PDF and web-page serving endpoints use `path.basename()` (good) but do not validate file extensions. Add extension checks: `.pdf` for the PDF endpoint, `.html` for the web endpoint.

---

#### L-4: ~~Unused `uuid` Dependency in genai-search~~ — ✅ RESOLVED (2026-08-24)

The `uuid` package (^9.0.0) was listed as a dependency in the old `genai-search/package.json` but never imported — the code uses Node.js built-in `crypto.randomUUID()`. Removed entirely when `genai-search` was merged into `services/portal` (the new `portal/package.json` never listed it).

---

### INFORMATIONAL

---

#### I-1: `express.static` Serves Without Cache Control

`express.static()` is used without `maxAge` or `etag` configuration. For production, set cache headers.

---

#### I-2: Ollama Image Tag Uses `latest`

`ollama/ollama:latest` is unpinned. Pin to a specific version for reproducible builds.

---

#### I-3: No Container Resource Limits

No Docker Compose service sets `mem_limit`, `cpus`, or `deploy.resources`. A runaway process (especially Ollama) can consume all host resources. Add resource constraints for production.

---

## Summary Table

| Severity | Count | Key Themes |
|---|---|---|
| **Critical** | 3 | No authentication on search/chat; stored XSS via HTML serving; unauthenticated member impersonation via chat `memberEmail` *(new 2026-08-24)* |
| **High** | 5 | Default credentials; exposed ports; no rate limiting; missing security headers; no body size limits |
| **Medium** | 6 | Error leakage; session hijacking; exposed Ollama; root container; DOM XSS pattern; input validation |
| **Low** | 3 | No TLS; in-memory sessions; no extension validation *(unused `uuid` dependency resolved 2026-08-24)* |
| **Informational** | 3 | Cache control; unpinned image; no resource limits |
