const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { embedQuery } = require('../../../lib/embedding');
const { parseQuery } = require('./queryParser');

const app = express();
app.use(express.json());

const PDF_DIR = process.env.PDF_DIR || '/data/pdfs';
const WEB_PAGES_DIR = process.env.WEB_PAGES_DIR || '/data/web-pages';

const pool = new Pool();

// Static UI
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve PDFs for in-browser viewing
app.get('/api/pdfs/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(PDF_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'PDF not found' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Semantic search across document chunks
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const parsed = parseQuery(q);
    const queryEmbedding = await embedQuery(parsed.cleanedQuery);
    const topK = Math.min(parseInt(req.query.limit) || 20, 100);

    let result;
    if (parsed.category) {
      result = await pool.query(
        'SELECT * FROM sp_search_documents_filtered($1, $2, $3)',
        [`[${queryEmbedding.join(',')}]`, topK, parsed.category]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM sp_search_documents($1, $2)',
        [`[${queryEmbedding.join(',')}]`, topK]
      );
    }

    res.json({
      query: q,
      parsed,
      results: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Page-level search (coarser grain)
app.get('/api/search/pages', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const parsed = parseQuery(q);
    const queryEmbedding = await embedQuery(parsed.cleanedQuery);
    const topK = Math.min(parseInt(req.query.limit) || 10, 50);

    const result = await pool.query(
      'SELECT * FROM sp_search_pages($1, $2)',
      [`[${queryEmbedding.join(',')}]`, topK]
    );

    res.json({
      query: q,
      parsed,
      results: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    console.error('Page search error:', err);
    res.status(500).json({ error: 'Page search failed' });
  }
});

// Lookup a document by filename
app.get('/api/documents/:filename', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sp_lookup_document($1)',
      [req.params.filename]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Also fetch pages for this document
    const docId = result.rows[0].document_id;
    const pages = await pool.query(
      'SELECT page_number, page_text FROM document_pages WHERE document_id = $1 ORDER BY page_number',
      [docId]
    );

    res.json({
      document: result.rows[0],
      pages: pages.rows,
    });
  } catch (err) {
    console.error('Document lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// List all documents (paginated)
app.get('/api/documents', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const category = req.query.category;

    let query, params;
    if (category) {
      query = 'SELECT id, filename, title, category, page_count, created_at FROM documents WHERE category = $1 ORDER BY title LIMIT $2 OFFSET $3';
      params = [category, limit, offset];
    } else {
      query = 'SELECT id, filename, title, category, page_count, created_at FROM documents ORDER BY title LIMIT $1 OFFSET $2';
      params = [limit, offset];
    }

    const result = await pool.query(query, params);
    const countResult = await pool.query(
      category
        ? 'SELECT COUNT(*) FROM documents WHERE category = $1'
        : 'SELECT COUNT(*) FROM documents',
      category ? [category] : []
    );

    res.json({
      documents: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset,
    });
  } catch (err) {
    console.error('List documents error:', err);
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// ETL job history
app.get('/api/etl-jobs', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sp_etl_job_history($1)', [50]);
    res.json({ jobs: result.rows });
  } catch (err) {
    console.error('ETL jobs error:', err);
    res.status(500).json({ error: 'Failed to fetch ETL jobs' });
  }
});

// ── Web content routes ──

// Serve web pages for in-browser viewing
app.get('/api/web-pages/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(WEB_PAGES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Web page not found' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(filePath).pipe(res);
});

// Semantic search across web content chunks
app.get('/api/search/web', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const parsed = parseQuery(q);
    const queryEmbedding = await embedQuery(parsed.cleanedQuery);
    const topK = Math.min(parseInt(req.query.limit) || 20, 100);

    let result;
    if (parsed.category) {
      result = await pool.query(
        'SELECT * FROM sp_search_web_filtered($1, $2, $3)',
        [`[${queryEmbedding.join(',')}]`, topK, parsed.category]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM sp_search_web($1, $2)',
        [`[${queryEmbedding.join(',')}]`, topK]
      );
    }

    res.json({
      query: q,
      parsed,
      results: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    console.error('Web search error:', err);
    res.status(500).json({ error: 'Web search failed' });
  }
});

// Unified search across documents and web content
app.get('/api/search/all', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const parsed = parseQuery(q);
    const queryEmbedding = await embedQuery(parsed.cleanedQuery);
    const topK = Math.min(parseInt(req.query.limit) || 20, 100);

    let result;
    if (parsed.category) {
      result = await pool.query(
        'SELECT * FROM sp_search_all_filtered($1, $2, $3)',
        [`[${queryEmbedding.join(',')}]`, topK, parsed.category]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM sp_search_all($1, $2)',
        [`[${queryEmbedding.join(',')}]`, topK]
      );
    }

    res.json({
      query: q,
      parsed,
      results: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    console.error('Unified search error:', err);
    res.status(500).json({ error: 'Unified search failed' });
  }
});

// List web sources (paginated)
app.get('/api/web-sources', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const category = req.query.category;

    let query, params;
    if (category) {
      query = 'SELECT id, url, domain, title, category, section_count, created_at FROM web_sources WHERE category = $1 ORDER BY title LIMIT $2 OFFSET $3';
      params = [category, limit, offset];
    } else {
      query = 'SELECT id, url, domain, title, category, section_count, created_at FROM web_sources ORDER BY title LIMIT $1 OFFSET $2';
      params = [limit, offset];
    }

    const result = await pool.query(query, params);
    const countResult = await pool.query(
      category
        ? 'SELECT COUNT(*) FROM web_sources WHERE category = $1'
        : 'SELECT COUNT(*) FROM web_sources',
      category ? [category] : []
    );

    res.json({
      sources: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset,
    });
  } catch (err) {
    console.error('List web sources error:', err);
    res.status(500).json({ error: 'Failed to list web sources' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Document search API listening on port ${PORT}`);
});
