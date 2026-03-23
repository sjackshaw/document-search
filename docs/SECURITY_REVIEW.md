# Security Analysis Report — document-search

**Date**: March 16, 2026  
**Scope**: Full codebase review (application services, ETL pipelines, Docker infrastructure, database schema, frontend clients)  
**Methodology**: Manual code review mapped to OWASP Top 10 (2021) and CWE identifiers

---

## Executive Summary

The project uses parameterized SQL queries and `path.basename()` for file serving, which mitigates the most critical injection and path traversal vectors. However, significant gaps remain: **all API endpoints are completely unauthenticated**, a defined `API_KEY` is never enforced, HTML files are served under the application origin enabling stored XSS, default database credentials are hardcoded throughout, no security headers are set, no rate limiting exists, and internal error details leak to clients.

**Finding Counts**: Critical: 2 | High: 5 | Medium: 6 | Low: 4 | Informational: 3

---

## Findings

### CRITICAL

---

#### C-1: All API Endpoints Lack Authentication

| Attribute | Value |
|---|---|
| **Category** | Broken Access Control |
| **OWASP** | A01:2021 — Broken Access Control |
| **CWE** | CWE-306: Missing Authentication for Critical Function |
| **Files** | `services/app/src/index.js`, `services/genai-search/src/index.js` |

**Description**: Every endpoint in both Express services (search API on port 3000, GenAI chat on port 3001) is freely accessible without any authentication or authorization. The `API_KEY` environment variable is defined in `docker-compose.app.yml` (`API_KEY: ${API_KEY:-dev-key-please-change}`) but is **never read or enforced** anywhere in the application code — no middleware, no header check, no guard on any route.

This means:
- Any network-accessible client can query the full document corpus, access all search APIs, and interact with the GenAI chat.
- The Ollama LLM can be used as an unlimited oracle by any caller.
- Internal documents and employee benefits data are publicly accessible.

**Risk**: Unrestricted access to potentially sensitive employee benefits information and unconstrained LLM usage.

**Remediation**:
1. Implement API key middleware that verifies an `Authorization` or `X-API-Key` header against `process.env.API_KEY` on all routes.
2. Return `401 Unauthorized` for missing/invalid keys.
3. For the GenAI chat, consider per-user authentication to prevent session hijacking.

---

#### C-2: Stored XSS via Same-Origin HTML File Serving

| Attribute | Value |
|---|---|
| **Category** | Cross-Site Scripting (XSS) |
| **OWASP** | A03:2021 — Injection |
| **CWE** | CWE-79: Improper Neutralization of Input During Web Page Generation |
| **Files** | `services/app/src/index.js` (lines 39-47 and 184-191) |

**Description**: The `/api/web-pages/:filename` endpoint serves raw HTML files from disk with `Content-Type: text/html; charset=utf-8` under the **same origin** as the application UI (port 3000):

```js
app.get('/api/web-pages/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(WEB_PAGES_DIR, filename);
  // ...
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(filePath).pipe(res);
});
```

If any HTML file in the web-pages data directory contains or is modified to contain malicious JavaScript, it will execute in the main application's origin. Since the search UI on port 3000 also serves from the same origin, an attacker-crafted page could:
- Steal cookies/session tokens via `document.cookie`
- Make authenticated API calls on behalf of the user
- Exfiltrate search history

The ETL pipeline ingests externally-sourced web content, making this a realistic attack vector — any compromised or malicious content in the crawl data flows directly into servable HTML.

**Risk**: Full same-origin JavaScript execution via malicious crawled content.

**Remediation**:
1. Serve user-uploaded/crawled HTML from a **separate domain or subdomain** (e.g., `static-content.example.com`) so it is cross-origin isolated.
2. Alternatively, serve HTML inside a sandboxed `<iframe>` with `sandbox="allow-same-origin"` only, or strip all `<script>` tags and event handlers before serving.
3. Set `Content-Security-Policy` headers on served HTML to block inline scripts: `Content-Security-Policy: script-src 'none'`.
4. Add `X-Content-Type-Options: nosniff` to prevent MIME-type sniffing.

---

### HIGH

---

#### H-1: Default / Hardcoded Database Credentials

| Attribute | Value |
|---|---|
| **Category** | Cryptographic / Credential Failure |
| **OWASP** | A07:2021 — Identification and Authentication Failures |
| **CWE** | CWE-798: Use of Hard-coded Credentials |
| **Files** | `docker-compose.postgres.yml` (lines 8-10), `docker-compose.app.yml` (lines 11-15), `docker-compose.genai-search.yml` (lines 24-28), `docker-compose.etl-documents.yml` (lines 10-14), `docker-compose.etl-webcrawl.yml` (lines 10-14) |

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

**Description**: The `/api/chat` and `/api/ask` endpoints trigger embedding generation + LLM inference on every request with no rate limiting. An attacker can flood these endpoints to:
- Exhaust GPU/CPU resources via Ollama inference
- Consume all available database connections via the `pg` pool
- Cause denial of service for legitimate users

The search service endpoints at port 3000 also have no rate limiting, though they are less expensive.

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
| **Files** | `services/app/src/index.js`, `services/genai-search/src/index.js` |

**Description**: Neither Express application sets any security headers. Missing headers include:
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
| **Files** | `services/app/src/index.js`, `services/genai-search/src/index.js` |

**Description**: Both services use `app.use(express.json())` without a `limit` option. While Express defaults to 100KB, this is not explicitly configured. An attacker could send many large payloads to the chat endpoints, where the question is embedded and sent to the LLM, amplifying resource consumption.

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

**Description**: Error responses in the GenAI service expose the raw `err.message` to clients:

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

**Description**: The chat endpoints accept a user-supplied `sessionId` in the request body. While UUIDs are cryptographically random (using `crypto.randomUUID()`), the session ID is returned in a response header (`X-Session-Id`) without TLS enforcement and accepted from any client without binding to an IP, user agent, or auth token.

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
| **File** | `docker-compose.genai-search.yml` (line 6) |

**Description**: The Ollama container exposes port 11434 to the host with no built-in authentication. Any host or network-local process can directly call `http://localhost:11434/api/chat` to use the LLM, bypassing any application-level controls.

**Risk**: Unauthorized direct LLM access, resource abuse.

**Remediation**:
1. Remove the port mapping; the genai-search service connects via the Docker internal network.
2. If host access is needed, bind to localhost only: `"127.0.0.1:11434:11434"`.

---

#### M-4: Ollama Container Runs as Root

| Attribute | Value |
|---|---|
| **Category** | Docker Security |
| **OWASP** | A05:2021 — Security Misconfiguration |
| **CWE** | CWE-250: Execution with Unnecessary Privileges |
| **File** | `docker-compose.genai-search.yml` (lines 3-14) |

**Description**: The Ollama container uses the default `ollama/ollama:latest` image which runs as root. The volume mount at `/root/.ollama` confirms this. The application Node.js containers correctly use `USER node`, but the Ollama container is an exception.

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

**Description**: The search UI renders server error messages using `innerHTML` without escaping:

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

**Description**: The `category:` prefix parser extracts any arbitrary string and passes it through if it doesn't match a known alias:

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

#### L-4: Unused `uuid` Dependency in genai-search

The `uuid` package (^9.0.0) is listed as a dependency but never imported — the code uses Node.js built-in `crypto.randomUUID()`. Remove to reduce supply chain risk.

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
| **Critical** | 2 | No authentication; stored XSS via HTML serving |
| **High** | 5 | Default credentials; exposed ports; no rate limiting; missing security headers; no body size limits |
| **Medium** | 6 | Error leakage; session hijacking; exposed Ollama; root container; DOM XSS pattern; input validation |
| **Low** | 4 | No TLS; in-memory sessions; no extension validation; unused dependency |
| **Informational** | 3 | Cache control; unpinned image; no resource limits |
