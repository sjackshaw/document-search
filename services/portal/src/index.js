'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const searchRoutes = require('./routes/search');
const chatRoutes = require('./routes/chat');
const { router: memberRoutes, DOCUMENT_DIR } = require('./routes/member');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const MEMBER_API_KEY = process.env.API_KEY || '';

// ── Static UI ──────────────────────────────────────────────────────────────

// Member benefits portal under /member. The page is served through a
// handler (rather than plain static) so the API key can be injected, same
// as the former standalone member-benefits-app. This must be registered
// before the generic static mounts below, otherwise they would serve the
// raw (un-injected) file first.
const memberIndexPath = path.join(__dirname, '..', 'public', 'member', 'index.html');
app.get(['/member', '/member/', '/member/index.html'], (_req, res) => {
  const html = fs.readFileSync(memberIndexPath, 'utf8');
  const injected = html.replace(
    '</head>',
    `<script>window.APP_API_KEY=${JSON.stringify(MEMBER_API_KEY)};</script>\n</head>`,
  );
  res.type('html').send(injected);
});

// Unified tab shell at the root (embeds /search, /chat, /member via iframes),
// plus the admin dashboard at /admin.html. The document/web search UI itself
// lives under /search and is served by this same static mount (nested
// directories are resolved automatically).
app.use(express.static(path.join(__dirname, '..', 'public')));

// RAG chat UI (+ analytics dashboard) under /chat.
app.use('/chat', express.static(path.join(__dirname, '..', 'public', 'chat')));
app.use('/member', express.static(path.join(__dirname, '..', 'public', 'member')));

// Generated member documents (EOBs, SPDs, enrollment forms, etc.)
app.use('/member/documents', express.static(DOCUMENT_DIR));

// ── API routes ───────────────────────────────────────────────────────────────
app.use('/api', searchRoutes);
app.use('/api', chatRoutes);
app.use('/api/member', memberRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const health = { status: 'ok' };
  try {
    await pool.query('SELECT 1');
    health.db = 'connected';
  } catch (err) {
    console.error('Health check DB error:', err.message);
    health.db = 'unreachable';
  }
  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    health.ollama = ollamaRes.ok ? 'connected' : 'unreachable';
  } catch {
    health.ollama = 'unreachable';
  }
  res.json(health);
});

app.listen(PORT, () => {
  console.log(`Benefits portal listening on port ${PORT}`);
  console.log(`Ollama endpoint: ${OLLAMA_BASE_URL}`);
});
