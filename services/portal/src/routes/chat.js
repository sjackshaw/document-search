'use strict';

// RAG chat, feedback, and analytics routes. Merged from the former
// standalone `genai-search` service.

const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { embedQuery } = require('../../../../lib/embedding');
const { detectEscalation } = require('../escalation');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const TOP_K = parseInt(process.env.RAG_TOP_K) || 10;
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS) || 6000;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Session store (in-memory) ────────────────────────────────────────

const sessions = new Map();

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastAccess = Date.now();
    return session;
  }
  return null;
}

function createSession() {
  const id = crypto.randomUUID();
  const session = { id, messages: [], lastAccess: Date.now() };
  sessions.set(id, session);
  return session;
}

// Purge expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── Chat query logging ─────────────────────────────────────────────

async function insertChatLog(service, sessionId, question, escalationFlagged, escalationSignals) {
  try {
    const result = await pool.query(
      `INSERT INTO chat_logs
         (service, session_id, question, escalation_flagged, escalation_signals)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [service, sessionId || null, question, escalationFlagged, escalationSignals],
    );
    return result.rows[0].id;
  } catch (err) {
    console.error('chat_logs insert failed:', err.message);
    return null;
  }
}

async function updateChatLog(logId, sourcesCount, answerLength) {
  if (!logId) return;
  try {
    await pool.query(
      'UPDATE chat_logs SET sources_count = $1, answer_length = $2 WHERE id = $3',
      [sourcesCount, answerLength, logId],
    );
  } catch (err) {
    console.error('chat_logs update failed:', err.message);
  }
}

// ── Vector retrieval ─────────────────────────────────────────────────

async function retrieveContext(question) {
  const queryEmbedding = await embedQuery(question);
  const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

  const result = await pool.query(
    'SELECT * FROM sp_search_all($1, $2)',
    [embeddingLiteral, TOP_K]
  );

  // Build context string from chunks, respecting max length
  const sources = [];
  let contextText = '';

  for (const row of result.rows) {
    const snippet = row.chunk_text.trim();
    if (contextText.length + snippet.length > MAX_CONTEXT_CHARS) break;

    const label = row.section_label ? ` — ${row.section_label}` : '';
    contextText += `\n---\nSource: ${row.title} (${row.category})${label}\n${snippet}\n`;
    sources.push({
      title: row.title,
      category: row.category,
      source_type: row.source_type,
      ref: row.ref,
      section_label: row.section_label,
      distance: row.distance,
    });
  }

  return { contextText, sources };
}

// ── Ollama chat ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful benefits assistant. Answer questions about employee benefits using ONLY the provided context. If the context does not contain enough information to answer, say so clearly. Be concise and cite which source document or web page your answer comes from when possible.`;

async function chatWithOllama(messages, res) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error ${response.status}: ${body}`);
  }

  // Stream the response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullContent = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      // Ollama streams newline-delimited JSON
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message && parsed.message.content) {
            fullContent += parsed.message.content;
            res.write(`data: ${JSON.stringify({ token: parsed.message.content })}\n\n`);
          }
          if (parsed.done) {
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  res.end();
  return fullContent;
}

const router = express.Router();

router.get('/health', async (_req, res) => {
  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    const ollamaOk = ollamaRes.ok;
    res.json({ status: 'ok', ollama: ollamaOk ? 'connected' : 'unreachable' });
  } catch {
    res.json({ status: 'ok', ollama: 'unreachable' });
  }
});

// ── Chat endpoint (streaming) ────────────────────────────────────────

router.post('/chat', async (req, res) => {
  try {
    const { question, sessionId } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: '"question" is required' });
    }

    // Resolve or create session
    let session;
    if (sessionId) {
      session = getSession(sessionId);
    }
    if (!session) {
      session = createSession();
    }

    // Retrieve relevant context from vector DB
    const { contextText, sources } = await retrieveContext(question.trim());

    // Detect escalation signals before building the response
    const { flagged: escalationFlagged, signals: escalationSignals } = detectEscalation(question.trim());

    // Insert chat log early so we can send its ID as a response header
    const chatLogId = await insertChatLog('genai', session.id, question.trim(), escalationFlagged, escalationSignals);

    // Build the message list for Ollama
    const ollamaMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    // Include recent conversation history (last 10 exchanges max)
    const recentHistory = session.messages.slice(-20); // 20 messages = ~10 exchanges
    ollamaMessages.push(...recentHistory);

    // Add the new user message with context
    const userMessageWithContext = `Context from internal documents and web pages:\n${contextText}\n\nQuestion: ${question.trim()}`;
    ollamaMessages.push({ role: 'user', content: userMessageWithContext });

    // Send metadata headers before streaming starts
    res.setHeader('X-Session-Id', session.id);
    res.setHeader('X-Sources', Buffer.from(JSON.stringify(sources)).toString('base64'));
    if (chatLogId) res.setHeader('X-Chat-Log-Id', String(chatLogId));
    if (escalationFlagged) res.setHeader('X-Escalation-Flagged', 'true');

    // Stream the LLM response
    const assistantContent = await chatWithOllama(ollamaMessages, res);

    // Update the log with actual answer metrics (fire-and-forget)
    updateChatLog(chatLogId, sources.length, assistantContent.length);

    // Store in session history (without the bulky context, to keep token usage manageable)
    session.messages.push({ role: 'user', content: question.trim() });
    session.messages.push({ role: 'assistant', content: assistantContent });
  } catch (err) {
    console.error('Chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Chat failed', detail: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ── Non-streaming chat (simpler clients) ─────────────────────────────

router.post('/ask', async (req, res) => {
  try {
    const { question, sessionId } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: '"question" is required' });
    }

    let session;
    if (sessionId) {
      session = getSession(sessionId);
    }
    if (!session) {
      session = createSession();
    }

    const { contextText, sources } = await retrieveContext(question.trim());

    const { flagged: escalationFlagged, signals: escalationSignals } = detectEscalation(question.trim());

    const ollamaMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...session.messages.slice(-20),
      { role: 'user', content: `Context from internal documents and web pages:\n${contextText}\n\nQuestion: ${question.trim()}` },
    ];

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: ollamaMessages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama error ${response.status}: ${body}`);
    }

    const data = await response.json();
    const assistantContent = data.message.content;

    session.messages.push({ role: 'user', content: question.trim() });
    session.messages.push({ role: 'assistant', content: assistantContent });

    // Log the completed interaction
    const chatLogId = await insertChatLog('genai', session.id, question.trim(), escalationFlagged, escalationSignals);
    updateChatLog(chatLogId, sources.length, assistantContent.length);

    res.json({
      sessionId: session.id,
      answer: assistantContent,
      sources,
      chatLogId,
      escalationFlagged,
    });
  } catch (err) {
    console.error('Ask error:', err);
    res.status(500).json({ error: 'Ask failed', detail: err.message });
  }
});

// ── Feedback endpoint ────────────────────────────────────────────────

router.post('/feedback', async (req, res) => {
  try {
    const { chatLogId, rating } = req.body;
    if (!chatLogId || !['up', 'down'].includes(rating)) {
      return res.status(400).json({ error: '"chatLogId" and "rating" (up|down) are required' });
    }
    await pool.query(
      `INSERT INTO chat_feedback (chat_log_id, rating)
       VALUES ($1, $2)
       ON CONFLICT (chat_log_id) DO UPDATE SET rating = EXCLUDED.rating`,
      [chatLogId, rating],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Feedback error:', err);
    res.status(500).json({ error: 'Feedback submission failed' });
  }
});

// ── Analytics endpoints ──────────────────────────────────────────────

router.get('/analytics/summary', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const result = await pool.query('SELECT * FROM sp_analytics_summary($1)', [days]);
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: 'Analytics summary failed' });
  }
});

router.get('/analytics/questions', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    // Return questions with no retrieved sources or negative feedback — likely gaps
    const result = await pool.query(
      `SELECT cl.id, cl.service, cl.question, cl.sources_count, cl.answer_length,
              cl.created_at, f.rating
       FROM chat_logs cl
       LEFT JOIN chat_feedback f ON f.chat_log_id = cl.id
       WHERE cl.created_at >= now() - ($1 || ' days')::INTERVAL
         AND (cl.sources_count = 0 OR f.rating = 'down' OR cl.answer_length < 80)
       ORDER BY cl.created_at DESC
       LIMIT $2`,
      [days, limit],
    );
    res.json({ questions: result.rows, days, count: result.rows.length });
  } catch (err) {
    console.error('Analytics questions error:', err);
    res.status(500).json({ error: 'Analytics questions failed' });
  }
});

router.get('/analytics/escalations', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const result = await pool.query(
      `SELECT id, service, session_id, question, escalation_signals, created_at
       FROM chat_logs
       WHERE escalation_flagged = TRUE
         AND created_at >= now() - ($1 || ' days')::INTERVAL
       ORDER BY created_at DESC
       LIMIT $2`,
      [days, limit],
    );
    res.json({ escalations: result.rows, days, count: result.rows.length });
  } catch (err) {
    console.error('Analytics escalations error:', err);
    res.status(500).json({ error: 'Analytics escalations failed' });
  }
});

module.exports = router;
