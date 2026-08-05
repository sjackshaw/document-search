# RAG Chat Request Flow

Covers both the streaming endpoint (`POST /api/chat`) and the non-streaming endpoint (`POST /api/ask`). The member benefits bot (`POST /api/bot`) follows the same escalation-detection and logging steps but does not call Ollama.

## Streaming Chat (`POST /api/chat`)

```mermaid
sequenceDiagram
    participant Browser
    participant GenAI as genai-search :3001
    participant Embedding as lib/embedding.js<br/>(BGE-small ONNX)
    participant PG as PostgreSQL + pgvector
    participant Ollama as Ollama :11434

    Browser->>GenAI: POST /api/chat<br/>{ question, sessionId? }

    GenAI->>GenAI: Validate question (non-empty string)
    GenAI->>GenAI: Resolve or create in-memory session<br/>(30-min TTL, up to 10 exchanges history)

    GenAI->>GenAI: detectEscalation(question)<br/>→ { flagged, signals[] }

    GenAI->>PG: INSERT chat_logs<br/>(service, session_id, question,<br/>escalation_flagged, escalation_signals)<br/>← chat_log_id

    GenAI->>Embedding: embedQuery(question)<br/>prefix: "Represent this sentence for searching relevant passages: "
    Embedding-->>GenAI: 384-dimensional float vector

    GenAI->>PG: sp_search_all(embedding, top_k=10)<br/>UNION ALL document_chunks + web_chunks<br/>ORDER BY cosine distance
    PG-->>GenAI: up to 10 ranked chunks<br/>(title, category, source_type, ref, chunk_text, distance)

    GenAI->>GenAI: Build context string<br/>truncated at MAX_CONTEXT_CHARS (6 000)

    Note over GenAI: Response headers sent before streaming:<br/>X-Session-Id, X-Sources (base64 JSON),<br/>X-Chat-Log-Id, X-Escalation-Flagged

    GenAI->>GenAI: Prepend session history (last 20 messages)<br/>+ system prompt + user message with context

    GenAI->>Ollama: POST /api/chat<br/>{ model: qwen2.5:3b, messages, stream: true }

    loop newline-delimited JSON tokens
        Ollama-->>GenAI: { message: { content: "..." } }
        GenAI-->>Browser: SSE: data: { token: "..." }
    end

    Ollama-->>GenAI: { done: true }
    GenAI-->>Browser: SSE: data: { done: true }

    GenAI->>GenAI: Append question + answer to session history
    GenAI->>PG: UPDATE chat_logs<br/>SET sources_count, answer_length
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
    participant GenAI as genai-search :3001
    participant PG as PostgreSQL

    Browser->>GenAI: POST /api/feedback<br/>{ chatLogId, rating: "up"|"down" }
    GenAI->>PG: INSERT chat_feedback<br/>(chat_log_id, rating)<br/>ON CONFLICT (chat_log_id) DO UPDATE
    PG-->>GenAI: OK
    GenAI-->>Browser: 200 { ok: true }
```

## Analytics Summary (`GET /api/analytics/summary`)

```mermaid
sequenceDiagram
    participant Browser
    participant GenAI as genai-search :3001
    participant PG as PostgreSQL

    Browser->>GenAI: GET /api/analytics/summary?days=7
    GenAI->>PG: sp_analytics_summary(days=7)<br/>→ total_queries, escalations,<br/>feedback_up/down, no_source_queries,<br/>short_answer_queries
    PG-->>GenAI: aggregate row
    GenAI-->>Browser: 200 { summary: { ... } }
```
