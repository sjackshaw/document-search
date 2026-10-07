'use strict';

// RAG chat, feedback, and analytics routes. Merged from the former
// standalone `genai-search` service.

const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { embedQuery } = require('../../../../lib/embedding');
const { detectEscalation } = require('../escalation');
const { parseQuery } = require('../queryParser');
const benefits = require('../member-benefits');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const TOP_K = parseInt(process.env.RAG_TOP_K) || 10;
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS) || 6000;
const MEMBER_CONTEXT_MAX_CHARS = parseInt(process.env.MEMBER_CONTEXT_MAX_CHARS) || 2000;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Keeps the model resident in Ollama between requests, avoiding a reload stall after an idle gap
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
// Caps generation length so answers can't run long on slower hardware
const OLLAMA_NUM_PREDICT = parseInt(process.env.OLLAMA_NUM_PREDICT) || 400;
const OLLAMA_OPTIONS = { num_predict: OLLAMA_NUM_PREDICT, temperature: 0.1 };
// How many prior messages to replay as history; lower = faster prompt processing
const CHAT_HISTORY_MESSAGES = parseInt(process.env.CHAT_HISTORY_MESSAGES) || 20;

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

  // If the question names a specific benefits category (e.g. "dental"),
  // restrict retrieval to that category so a handful of matching chunks
  // aren't crowded out of the top-K by the much larger general web corpus.
  const { category } = parseQuery(question);

  const result = category
    ? await pool.query(
        'SELECT * FROM sp_search_all_filtered($1, $2, $3)',
        [embeddingLiteral, TOP_K, category]
      )
    : await pool.query(
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

// ── Member context (demo-only personalisation) ────────────────────────

// Builds a compact, plain-text summary of a member's own claims record so
// it can be dropped into the chat prompt alongside the document/web RAG
// context. This is intentionally simple (plain SQL lookups, not vector
// search) — see docs discussion on merging the member bot into chat.
async function buildMemberContext(memberEmail) {
  const member = await benefits.resolveMember(pool, memberEmail);
  if (!member) return null;

  const planYear = new Date().getFullYear();
  const [openClaims, summary, deductible] = await Promise.all([
    benefits.getOpenClaims(pool, member),
    benefits.getClaimsSummary(pool, member, null),
    benefits.getDeductibleStatus(pool, member, planYear),
  ]);

  const lines = [`Member: ${member.memberId} (${member.memberEmail})`];

  if (openClaims.length) {
    lines.push(`Open claims (${openClaims.length}):`);
    for (const claim of openClaims.slice(0, 10)) {
      lines.push(`- ${claim.claimId} ${claim.claimType} with ${claim.provider || 'an unspecified provider'} on ${claim.serviceDate}: billed ${benefits.dollars(claim.amountBilled)}, paid ${benefits.dollars(claim.amountPaid)}, status ${claim.status}`);
    }
  } else {
    lines.push('Open claims: none');
  }

  if (summary.length) {
    lines.push('Claims summary by plan year and type:');
    for (const row of summary.slice(0, 10)) {
      lines.push(`- ${row.planYear} ${row.claimType}: ${row.claimCount} claims, billed ${benefits.dollars(row.billed)}, paid ${benefits.dollars(row.paid)}, member responsibility ${benefits.dollars(row.memberResponsibility)}`);
    }
  }

  if (deductible.length) {
    lines.push(`Deductible status (${planYear}):`);
    for (const row of deductible) {
      lines.push(`- ${row.claimType} (${row.planName}): ${benefits.dollars(row.memberSpend)} spent of ${benefits.dollars(row.deductible)} deductible, ${row.deductibleMet ? 'deductible met' : `${benefits.dollars(row.deductibleRemaining)} remaining`}`);
    }
  }

  let contextText = lines.join('\n');
  if (contextText.length > MEMBER_CONTEXT_MAX_CHARS) {
    contextText = contextText.slice(0, MEMBER_CONTEXT_MAX_CHARS) + '\n... (truncated)';
  }

  return { member, contextText };
}

// ── Ollama chat ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful benefits assistant. Answer questions about employee benefits using ONLY the provided context. If the context does not contain enough information to answer, say so clearly. Be concise and cite which source document or web page your answer comes from when possible. You may also be given a "member's personal benefits record" section — use it ONLY to answer that specific member's personal questions about their own claims, deductible, or plan usage, and do not apply it to general policy questions.`;

async function chatWithOllama(messages, res) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: true,
      options: OLLAMA_OPTIONS,
      keep_alive: OLLAMA_KEEP_ALIVE,
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
    const { question, sessionId, memberEmail } = req.body;

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

    // Optionally resolve a demo member so personal questions (open claims,
    // deductible, plan usage) can be answered in the same chat. Anonymous
    // chat (no memberEmail) is completely unaffected.
    let memberContext = null;
    if (memberEmail) {
      try {
        memberContext = await buildMemberContext(memberEmail);
      } catch (err) {
        console.error('Member context lookup failed:', err.message);
      }
    }

    // Detect escalation signals before building the response
    const { flagged: escalationFlagged, signals: escalationSignals } = detectEscalation(question.trim());

    // Insert chat log early so we can send its ID as a response header
    const chatLogId = await insertChatLog('genai', session.id, question.trim(), escalationFlagged, escalationSignals);

    // Build the message list for Ollama
    const ollamaMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    // Include recent conversation history (bounded by CHAT_HISTORY_MESSAGES)
    const recentHistory = session.messages.slice(-CHAT_HISTORY_MESSAGES);
    ollamaMessages.push(...recentHistory);

    // Add the new user message with context
    const contextSections = [`Context from internal documents and web pages:\n${contextText}`];
    if (memberContext) {
      contextSections.push(`Context from the member's personal benefits record:\n${memberContext.contextText}`);
    }
    const userMessageWithContext = `${contextSections.join('\n\n')}\n\nQuestion: ${question.trim()}`;
    ollamaMessages.push({ role: 'user', content: userMessageWithContext });

    // Send metadata headers before streaming starts
    res.setHeader('X-Session-Id', session.id);
    res.setHeader('X-Sources', Buffer.from(JSON.stringify(sources)).toString('base64'));
    if (chatLogId) res.setHeader('X-Chat-Log-Id', String(chatLogId));
    if (escalationFlagged) res.setHeader('X-Escalation-Flagged', 'true');
    if (memberContext) {
      res.setHeader('X-Member-Id', memberContext.member.memberId);
      res.setHeader('X-Member-Email', memberContext.member.memberEmail);
    }

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
    const { question, sessionId, memberEmail } = req.body;

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

    let memberContext = null;
    if (memberEmail) {
      try {
        memberContext = await buildMemberContext(memberEmail);
      } catch (err) {
        console.error('Member context lookup failed:', err.message);
      }
    }

    const { flagged: escalationFlagged, signals: escalationSignals } = detectEscalation(question.trim());

    const contextSections = [`Context from internal documents and web pages:\n${contextText}`];
    if (memberContext) {
      contextSections.push(`Context from the member's personal benefits record:\n${memberContext.contextText}`);
    }

    const ollamaMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...session.messages.slice(-CHAT_HISTORY_MESSAGES),
      { role: 'user', content: `${contextSections.join('\n\n')}\n\nQuestion: ${question.trim()}` },
    ];

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: ollamaMessages,
        stream: false,
        options: OLLAMA_OPTIONS,
        keep_alive: OLLAMA_KEEP_ALIVE,
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
      member: memberContext ? memberContext.member : null,
    });
  } catch (err) {
    console.error('Ask error:', err);
    res.status(500).json({ error: 'Ask failed', detail: err.message });
  }
});

// ── Member list (demo dropdown) ──────────────────────────────────────

router.get('/chat/members', async (_req, res) => {
  try {
    const members = await benefits.listMembers(pool, 2000);
    res.json({ members });
  } catch (err) {
    console.error('Chat members list error:', err.message);
    res.status(500).json({ error: 'Unable to list members' });
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
