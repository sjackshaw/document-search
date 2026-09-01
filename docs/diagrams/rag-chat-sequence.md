# RAG Chat Request Flow

Covers both the streaming endpoint (`POST /api/chat`) and the non-streaming endpoint (`POST /api/ask`), both served by the `portal` service's chat routes (`services/portal/src/routes/chat.js`). The member benefits bot (`POST /api/member/bot`) follows the same escalation-detection and logging steps but does not call Ollama.

Both chat endpoints accept an optional `memberEmail` field. When present, the request is personalized with that member's own claims record (see "Member Context" below); when absent, behavior is unchanged from a document/web-only assistant — anonymous chat is not gated in any way.

## Streaming Chat (`POST /api/chat`)

```mermaid
sequenceDiagram
    participant Browser
    participant Portal as portal :3000<br/>(chat routes)
    participant Embedding as lib/embedding.js<br/>(BGE-small ONNX)
    participant PG as PostgreSQL + pgvector
    participant Ollama as Ollama :11434

    Browser->>Portal: POST /api/chat<br/>{ question, sessionId?, memberEmail? }

    Portal->>Portal: Validate question (non-empty string)
    Portal->>Portal: Resolve or create in-memory session<br/>(30-min TTL, up to 10 exchanges history)

    Portal->>Embedding: embedQuery(question)<br/>prefix: "Represent this sentence for searching relevant passages: "
    Embedding-->>Portal: 384-dimensional float vector

    Portal->>Portal: parseQuery(question)<br/>→ detect benefits category (e.g. "dental"), if any

    alt category detected
        Portal->>PG: sp_search_all_filtered(embedding, top_k=10, category)<br/>UNION ALL document_chunks + web_chunks, WHERE category matches<br/>ORDER BY cosine distance
    else no category detected
        Portal->>PG: sp_search_all(embedding, top_k=10)<br/>UNION ALL document_chunks + web_chunks<br/>ORDER BY cosine distance
    end
    PG-->>Portal: up to 10 ranked chunks<br/>(title, category, source_type, ref, chunk_text, distance)

    opt memberEmail provided
        Portal->>PG: resolveMember(memberEmail)<br/>+ getOpenClaims, getClaimsSummary,<br/>getDeductibleStatus (plain SQL, no vector search)
        PG-->>Portal: member record + claims summary
        Portal->>Portal: buildMemberContext()<br/>→ compact plain-text block,<br/>truncated at MEMBER_CONTEXT_MAX_CHARS (2 000)
    end

    Portal->>Portal: detectEscalation(question)<br/>→ { flagged, signals[] }

    Portal->>PG: INSERT chat_logs<br/>(service, session_id, question,<br/>escalation_flagged, escalation_signals)<br/>← chat_log_id

    Portal->>Portal: Build context string<br/>truncated at MAX_CONTEXT_CHARS (6 000)<br/>+ member context block (if resolved)

    Note over Portal: Response headers sent before streaming:<br/>X-Session-Id, X-Sources (base64 JSON),<br/>X-Chat-Log-Id, X-Escalation-Flagged,<br/>X-Member-Id / X-Member-Email (if memberEmail resolved)

    Portal->>Portal: Prepend session history (last 20 messages)<br/>+ system prompt + user message with context

    Portal->>Ollama: POST /api/chat<br/>{ model: qwen2.5:3b, messages, stream: true }

    loop newline-delimited JSON tokens
        Ollama-->>Portal: { message: { content: "..." } }
        Portal-->>Browser: SSE: data: { token: "..." }
    end

    Ollama-->>Portal: { done: true }
    Portal-->>Browser: SSE: data: { done: true }

    Portal->>Portal: Append question + answer to session history
    Portal->>PG: UPDATE chat_logs<br/>SET sources_count, answer_length
```

## Member Context (demo personalization)

`memberEmail` is supplied by the user via a "Chatting as" dropdown in the chat UI (populated from `GET /api/chat/members`) and is **not authenticated** — any caller can pass any member's email and receive that member's claims summary, open claims, and deductible status in the answer. This is an intentional demo/PoC shortcut, not a production-ready personalization model; see [SECURITY_REVIEW.md](../SECURITY_REVIEW.md) for the corresponding finding.

```mermaid
flowchart LR
    Email["memberEmail\n(from request body)"]
    Resolve["resolveMember()\nfirst match by email,\nno ownership check"]
    Fetch["getOpenClaims()\ngetClaimsSummary()\ngetDeductibleStatus()"]
    Build["buildMemberContext()\nplain-text summary,\ncapped at 2 000 chars"]
    Prompt["Appended to the same\nprompt as document/web RAG context"]

    Email --> Resolve --> Fetch --> Build --> Prompt
```

## Escalation Detection

Escalation runs synchronously before the Ollama call. If triggered, the `X-Escalation-Flagged: true` header is included in the response and the chat UI displays a support-desk notice.

```mermaid
flowchart LR
    Q["Question text"]
    D{"detectEscalation()\nregex scan against\n10 signal patterns"}
    F["escalationFlagged = true\nsignals[] populated"]
    NF["escalationFlagged = false\nsignals = []"]
    LOG["Stored in chat_logs\nescalation_flagged,\nescalation_signals"]
    HEADER["X-Escalation-Flagged: true\nheader on response"]
    UI["Chat UI shows\nsupport-desk notice"]

    Q --> D
    D -- "match found" --> F --> LOG
    D -- "no match" --> NF --> LOG
    F --> HEADER --> UI
```

## Feedback Loop (`POST /api/feedback`)

```mermaid
sequenceDiagram
    participant Browser
    participant Portal as portal :3000<br/>(chat routes)
    participant PG as PostgreSQL

    Browser->>Portal: POST /api/feedback<br/>{ chatLogId, rating: "up"|"down" }
    Portal->>PG: INSERT chat_feedback<br/>(chat_log_id, rating)<br/>ON CONFLICT (chat_log_id) DO UPDATE
    PG-->>Portal: OK
    Portal-->>Browser: 200 { ok: true }
```

## Analytics Summary (`GET /api/analytics/summary`)

```mermaid
sequenceDiagram
    participant Browser
    participant Portal as portal :3000<br/>(chat routes)
    participant PG as PostgreSQL

    Browser->>Portal: GET /api/analytics/summary?days=7
    Portal->>PG: sp_analytics_summary(days=7)<br/>→ total_queries, escalations,<br/>feedback_up/down, no_source_queries,<br/>short_answer_queries
    PG-->>Portal: aggregate row
    Portal-->>Browser: 200 { summary: { ... } }
```
