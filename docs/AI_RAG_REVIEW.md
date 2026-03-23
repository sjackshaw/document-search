# AI & RAG Architecture Review — document-search

**Date**: March 16, 2026  
**Scope**: Embedding model, chunking strategy, RAG pipeline, LLM integration, prompt engineering, search quality, session management, streaming implementation

---

## Executive Summary

This is a well-structured Node.js PoC for benefits document search using BGE embeddings + pgvector for retrieval and Ollama/Qwen 2.5 3B for generative chat. The architecture is clean with good separation of concerns across four services. However, there are several meaningful issues in the embedding pipeline, chunking strategy, RAG context assembly, prompt engineering, and session management that would degrade retrieval quality and answer accuracy.

---

## 1. Embedding Model Choice

**Model:** `Xenova/bge-small-en-v1.5` (33M params, 384 dimensions, ONNX via `@xenova/transformers`)

**Verdict: Appropriate for a PoC, with correct asymmetric embedding.**

### Finding 1.1 — CORRECT: Asymmetric BGE prefix usage

The BGE model family has an asymmetric design:
- **Query-time**: Prefix with `"Represent this sentence for searching relevant passages: "`
- **Passage-time** (indexing): No prefix needed (raw text)

The search services correctly apply the prefix at query time. The ETL pipelines correctly omit it during indexing. **This is properly implemented.** However, this critical design decision is not documented anywhere — if someone adds the prefix to ETL (or removes it from search), recall will degrade silently.

### Finding 1.2 — LOW: Model loaded 3 separate times across services

The same model is loaded independently in `app`, `genai-search`, and both ETL containers. This means ~130MB of ONNX model memory × 3 at runtime. Acceptable for Docker Compose architecture but worth noting for memory footprint.

### Finding 1.3 — INFO: 384 dimensions is a reasonable trade-off

384d from BGE-small is a good balance of quality vs. storage/speed for a PoC. The AWS doc correctly recommends upgrading to 1024d Cohere Embed v3 or Titan V2 for production.

---

## 2. Chunking Strategy

**Settings:** 500 characters per chunk, 50-character overlap

### Finding 2.1 — MEDIUM: Character-based chunking splits mid-word and mid-sentence

The `chunkText()` function slices at exact character positions:

```js
function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}
```

**Problems:**
- Cuts mid-word (e.g., "reimburse" / "ment") — the embedding of a truncated word is poor
- Cuts mid-sentence — semantic meaning is split across chunks
- 50-character overlap (~8-10 words) is slim; if a key phrase straddles the boundary, neither chunk fully captures it

**Recommendation:** Use sentence-boundary-aware chunking. At minimum, extend/retract to the nearest sentence terminator (`. `, `\n`). A simple improvement:

```js
function chunkText(text, targetSize = 500, overlap = 100) {
  const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if (current.length + s.length > targetSize && current.length > 0) {
      chunks.push(current.trim());
      const overlapStart = current.length - overlap;
      current = current.slice(Math.max(0, overlapStart)) + s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
```

### Finding 2.2 — MEDIUM: 500-character chunks are quite small

500 characters ≈ 70-80 words ≈ ~100 tokens. This is on the small side for a benefits domain where a single policy clause can span 150-200 words. Small chunks mean:
- More chunks to search through (slower)
- Individual chunks lack sufficient context for the LLM to understand the full policy
- More reliance on the LLM to synthesize across multiple fragments

**Recommendation:** Increase to 800-1200 characters with 150-200 character overlap. For benefits documents where paragraphs are the natural unit, paragraph-based chunking would be superior.

### Finding 2.3 — LOW: Page-level embedding truncates to first 512 characters

```js
const pageEmbedding = await embed(pageText.slice(0, 512));
```

For multi-page documents where the first 512 chars are headers/boilerplate, this produces poor page-level embeddings.

**Recommendation:** Use mean pooling over all chunk embeddings for the page/section embedding, or embed a representative summary.

### Finding 2.4 — LOW: No metadata embedded alongside text

Chunks are pure text slices with no contextual framing. Adding metadata like the document title and category to the chunk text before embedding can significantly improve retrieval relevance:

```js
const enrichedChunk = `${doc.title} | ${doc.category} | ${chunk}`;
```

This helps the embedding model understand that "the deductible is $500" is about health insurance vs. auto insurance.

---

## 3. RAG Pipeline

### Finding 3.1 — MEDIUM: TOP_K=10 with MAX_CONTEXT_CHARS=6000 may starve or over-pack context

With 500-char chunks + source labels (~50 chars overhead per chunk), you get ~550 chars per chunk. 6000 / 550 ≈ **10-11 chunks** — so the char limit and TOP_K are roughly aligned. However:

- If early chunks are long, you'll hit the char limit after only 6-7 chunks, wasting available context
- 6,000 chars ≈ ~1,500 tokens of context. Qwen 2.5 3B has a 32K-token context window, so you're using < 5% of it

**Recommendation:** Increase `MAX_CONTEXT_CHARS` to 12,000+ and `TOP_K` to 15-20 for the local PoC. The 3B model can handle this comfortably.

### Finding 3.2 — MEDIUM: No similarity threshold — irrelevant chunks are included

The retrieval takes the top-K results by distance with no minimum similarity filter:

```js
for (const row of result.rows) {
  const snippet = row.chunk_text.trim();
  if (contextText.length + snippet.length > MAX_CONTEXT_CHARS) break;
  // adds to context regardless of distance
}
```

If the user asks about a topic not covered in the corpus, all 10 results will be irrelevant but still passed to the LLM. Cosine distance values > 0.5 (or similarity < 0.5) are typically noise for BGE embeddings.

**Recommendation:** Add a distance threshold:
```js
if (row.distance > 0.45) break; // skip low-relevance chunks
```

### Finding 3.3 — LOW: No deduplication of overlapping chunks

Because of chunk overlap, consecutive chunks from the same page often appear in the top-K results. The context assembly doesn't deduplicate, so the LLM may receive near-identical text 2-3 times, wasting context window.

**Recommendation:** Deduplicate by checking if a chunk's text is mostly contained in an already-selected chunk, or deduplicate by `(document_id, page_id, chunk_index ± 1)`.

### Finding 3.4 — LOW: Retrieval always queries all sources (no source-type routing)

The GenAI search always calls `sp_search_all` which unions documents and web chunks. For certain queries (e.g., "show me the 401k enrollment form PDF"), limiting to `source_type = 'document'` would produce better results. The `queryParser.js` already extracts categories — it could also detect source-type intent.

---

## 4. LLM Integration

### Finding 4.1 — MEDIUM: Qwen 2.5 3B is underpowered for complex benefits Q&A

Qwen 2.5 3B is a good choice for a PoC that must run on a MacBook CPU. However, for a benefits assistant:
- 3B models struggle with multi-hop reasoning ("Am I eligible for FMLA if I've worked here 10 months and my employer has 45 employees?")
- Citation accuracy is poor — the model will often fabricate which document a fact came from
- Instruction following is inconsistent — the model may ignore the "only use provided context" directive

**Recommendation for local PoC:** If the MacBook has 16GB+ RAM, consider `qwen2.5:7b` (Q4 quantization, ~4.4GB) or `phi-3:3.8b` which has stronger instruction following at similar size. If GPU is available (Apple Silicon), `llama3.1:8b` via Ollama with Metal acceleration performs well.

### Finding 4.2 — LOW: No temperature/parameter tuning

The Ollama call uses default parameters:
```js
body: JSON.stringify({
  model: OLLAMA_MODEL,
  messages,
  stream: true,
}),
```

For a factual Q&A system, you should set `temperature: 0.1` (or 0) and optionally `top_p: 0.9` to reduce hallucination:

```js
body: JSON.stringify({
  model: OLLAMA_MODEL,
  messages,
  stream: true,
  options: { temperature: 0.1, top_p: 0.9 },
}),
```

---

## 5. Prompt Engineering

### Finding 5.1 — MEDIUM: System prompt is functional but could be stronger

```js
const SYSTEM_PROMPT = `You are a helpful benefits assistant. Answer questions about employee benefits 
using ONLY the provided context. If the context does not contain enough information to answer, say so 
clearly. Be concise and cite which source document or web page your answer comes from when possible.`;
```

**Issues:**
- "when possible" weakens the citation instruction — should be "always cite"
- No format guidance for citations (inline? footnotes? document title + page?)
- No instruction on how to handle contradictions between sources
- No guidance on tone or audience (employees? HR admins?)
- Small models like Qwen 3B need more explicit, structured instructions

**Recommended improved prompt:**
```
You are a benefits assistant for employees. Answer questions using ONLY the context provided below.

Rules:
1. Base every claim on the provided context. If the context doesn't contain the answer, say: "I don't have enough information to answer that based on the available documents."
2. NEVER make up information not in the context.
3. After each factual statement, cite the source in brackets like [Source: document title].
4. If multiple sources give different information, mention both and note the discrepancy.
5. Be concise — use bullet points for lists.
6. Do not repeat the question back to the user.
```

### Finding 5.2 — LOW: Context injection format could be more structured

The context is a flat concatenation of chunks separated by `---`. For small models, numbering the sources helps with citation:

```
Context:
[1] Source: "401k Plan Overview" (retirement) — Page 3
The employer matches 50% of contributions up to 6% of salary...

[2] Source: "Health Insurance Guide" (health_insurance) — Page 12
The annual deductible for the PPO plan is $500 per individual...

Question: What is the 401k match?
Answer using only the numbered sources above. Cite sources as [1], [2], etc.
```

---

## 6. Search Quality (SQL / pgvector)

### Finding 6.1 — GOOD: HNSW indexes are properly configured

`m=16` and `ef_construction=64` are reasonable defaults for a small-to-medium corpus. For the PoC scale (thousands of chunks, not millions), these will provide good recall.

**Note:** For production with > 100K chunks, increase `ef_construction` to 128-200 and consider setting `ef_search=100` for better recall at query time.

### Finding 6.2 — LOW: `sp_search_all` UNION ALL is not index-optimal

The `sp_search_all` function uses `UNION ALL` of two vector scans then sorts by distance. Each sub-query effectively retrieves results independently without per-branch limits. Functional but not optimal for the current architecture.

**Recommendation:** For a true unified index, consider a single table with a `source_type` discriminator column. For the PoC scale, the current approach works acceptably.

### Finding 6.3 — GOOD: Cosine distance operator is correctly used

`<=>` is the cosine distance operator matching the `vector_cosine_ops` index. Normalized embeddings ensure cosine distance = 1 - cosine similarity. Consistent throughout.

---

## 7. Session Management

### Finding 7.1 — MEDIUM: Conversation history grows unbounded within a session

The code limits the Ollama prompt to the last 20 messages, but `session.messages` itself grows unboundedly during the 30-minute TTL. With long conversations, memory usage per session increases.

More critically, with 20 messages of history + context + system prompt, the total prompt can be 4,000-7,000 tokens input for a 3B model — within limits for Qwen 2.5 3B (32K context) but quality degrades with more context in practice.

**Recommendation:** Trim `session.messages` array itself (not just the view) to avoid memory growth. Consider reducing history to 6-10 messages (3-5 exchanges) for the 3B model.

### Finding 7.2 — GOOD: Session history strips context (smart design)

The stored user message is the raw question (not the context-stuffed version). This prevents context from previous turns from polluting the history and consuming tokens. Well designed.

### Finding 7.3 — LOW: In-memory session store won't survive restarts

The `sessions` Map is in-memory. Container restarts lose all sessions. Acceptable for a PoC. The AWS doc correctly recommends DynamoDB for production.

---

## 8. Streaming Implementation

### Finding 8.1 — MEDIUM: SSE parsing doesn't handle split JSON lines across chunks

The server-side Ollama stream reader:
```js
const text = decoder.decode(value, { stream: true });
for (const line of text.split('\n').filter(Boolean)) {
  try {
    const parsed = JSON.parse(line);
  } catch {
    // skip malformed lines
  }
}
```

A network chunk boundary could split a JSON line across two `reader.read()` calls:
- Chunk 1: `{"message":{"content":"Hel`
- Chunk 2: `lo"},"done":false}\n`

Both partial lines would fail to parse. **Tokens can be silently dropped in the stream.**

**Recommendation:** Use a line buffer:
```js
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete line
  for (const line of lines.filter(Boolean)) {
    // parse line...
  }
}
```

**Note:** The client-side SSE parsing in the HTML frontend does correctly use a buffer pattern. Only the server-side Ollama reader has this issue.

### Finding 8.2 — LOW: Error during stream has limited recovery

The error handling sends an error SSE event if headers are already sent, or a 500 JSON response if not. The partial `assistantContent` from a failed stream is never stored in the session, keeping session state consistent. Good.

---

## 9. Model Selection Alternatives (Local PoC)

| Model | Size | Advantage |
|---|---|---|
| `qwen2.5:7b` (Q4) | ~4.4GB | Significantly better reasoning, still runs on 16GB Mac |
| `phi-3.5:3.8b` | ~2.3GB | Strong instruction following, good at structured output |
| `llama3.2:3b` | ~2.0GB | Meta's latest small model, good multilingual |
| `gemma2:2b` | ~1.6GB | Google's smallest, very fast |

**Recommendation:** If the MacBook has 16GB+ RAM, test with `qwen2.5:7b` — the jump from 3B to 7B is the single biggest quality improvement available without changing the architecture.

---

## 10. Production Architecture Review (AWS Doc)

The AWS Production Architecture document is **exceptionally thorough**:

- **Embedding model recommendation is sound** — Cohere Embed v3 with Matryoshka truncation
- **Reranking strategy is correctly placed** — Retrieve top-50 → rerank → take top-10
- **Hybrid search recommendation is appropriate** — BM25 + vector in OpenSearch Serverless
- **Sites.Selected over Sites.Read.All** is excellent security guidance
- **Missing**: Cohere Rerank cost estimate in the cost table
- **Minor**: Claude model references may need updating to latest Bedrock availability

---

## Summary of Findings by Severity

| # | Severity | Finding |
|---|---|---|
| 8.1 | **MEDIUM** | SSE stream parsing drops tokens on chunk boundaries (server-side Ollama reader) |
| 2.1 | **MEDIUM** | Character-based chunking splits mid-word/mid-sentence |
| 2.2 | **MEDIUM** | 500-char chunks too small for benefits policy text |
| 3.1 | **MEDIUM** | Context window under-utilized (6K chars, model supports ~24K+ chars) |
| 3.2 | **MEDIUM** | No similarity distance threshold — irrelevant chunks sent to LLM |
| 4.1 | **MEDIUM** | Qwen 2.5 3B struggles with complex multi-hop benefits questions |
| 5.1 | **MEDIUM** | System prompt too permissive — "when possible" weakens citation/grounding |
| 7.1 | **MEDIUM** | Session message array grows unbounded in memory |
| 4.2 | **LOW** | No temperature setting — defaults increase hallucination risk |
| 2.3 | **LOW** | Page/section embeddings truncated to first 512 chars |
| 2.4 | **LOW** | No metadata in chunk text for embedding enrichment |
| 3.3 | **LOW** | No deduplication of overlapping chunks in context |
| 3.4 | **LOW** | No source-type routing in retrieval |
| 5.2 | **LOW** | Context format not numbered — hurts citation accuracy |
| 6.2 | **LOW** | UNION ALL search is not index-optimal |
| 7.3 | **LOW** | In-memory sessions lost on restart |

---

## Top 5 Recommended Actions (Effort vs. Impact)

1. **Fix SSE buffer** (Finding 8.1) — 10 min fix, prevents dropped tokens in streaming responses
2. **Add `temperature: 0.1`** (Finding 4.2) — 1-line change, meaningfully reduces hallucination
3. **Strengthen system prompt** (Finding 5.1) — 5 min, improves answer grounding and citation quality
4. **Add distance threshold** (Finding 3.2) — 3-line change, prevents garbage context injection
5. **Improve chunking** (Findings 2.1 + 2.2) — 30 min, largest single impact on retrieval quality (requires re-indexing)
