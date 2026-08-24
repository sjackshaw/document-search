const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cron = require('node-cron');
const { getEmbedder, embed, embedBatch, chunkText } = require('../../lib/embedding');

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';
const MANIFEST_PATH = path.join(__dirname, 'data', 'manifest.json');

const pool = new Pool();

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function loadDocument(doc) {
  // Upsert document record
  const docResult = await pool.query(
    'SELECT sp_upsert_document($1, $2, $3, $4, $5)',
    [doc.filename, doc.title, doc.category, doc.pageCount, doc.totalChars]
  );
  const documentId = docResult.rows[0].sp_upsert_document;

  // Delete existing chunks for this document (will be re-created)
  await pool.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);

  // Process pages
  for (let p = 0; p < doc.pages.length; p++) {
    const pageText = doc.pages[p];
    const pageEmbedding = await embed(pageText.slice(0, 512)); // embed first 512 chars of page

    const pageResult = await pool.query(
      'SELECT sp_upsert_document_page($1, $2, $3, $4)',
      [documentId, p + 1, pageText, `[${pageEmbedding.join(',')}]`]
    );
    const pageId = pageResult.rows[0].sp_upsert_document_page;

    // Chunk the page and embed each chunk
    const chunks = chunkText(pageText);
    const chunkEmbeddings = await embedBatch(chunks);

    for (let c = 0; c < chunks.length; c++) {
      await pool.query(
        'SELECT sp_upsert_document_chunk($1, $2, $3, $4, $5)',
        [documentId, pageId, c, chunks[c], `[${chunkEmbeddings[c].join(',')}]`]
      );
    }
  }

  return documentId;
}

async function runEtl() {
  console.log(`[ETL] Starting document ETL run at ${new Date().toISOString()}`);

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log(`[ETL] Manifest not found: ${MANIFEST_PATH}`);
    return;
  }

  const manifest = loadManifest();
  const total = manifest.length;
  console.log(`[ETL] Loaded manifest with ${total} documents`);

  if (total === 0) return;

  // Start ETL job
  const jobResult = await pool.query(
    'SELECT sp_etl_start_job($1, $2, $3)',
    ['etl-documents', 'complete', 'documents']
  );
  const jobId = jobResult.rows[0].sp_etl_start_job;

  let processed = 0;
  let created = 0;
  let failed = 0;

  try {
    // Pre-load the model
    await getEmbedder();

    for (let i = 0; i < total; i++) {
      const entry = manifest[i];
      manifest[i] = null; // release reference to free memory

      try {
        console.log(`[ETL] Processing (${i + 1}/${total}): ${entry.filename}`);

        const totalChars = entry.pages.reduce((sum, p) => sum + p.length, 0);
        const doc = {
          filename: entry.filename,
          title: entry.title,
          category: entry.category,
          pages: entry.pages,
          pageCount: entry.page_count,
          totalChars,
        };

        await loadDocument(doc);

        processed++;
        created++;
        console.log(`[ETL] Loaded: ${entry.filename} (${doc.pageCount} pages, ${totalChars} chars)`);

        // Periodic GC hint every 10 docs
        if (processed % 10 === 0 && global.gc) {
          global.gc();
        }
      } catch (err) {
        failed++;
        console.error(`[ETL] Failed to process ${entry.filename}:`, err.message);
      }
    }

    await pool.query(
      'SELECT sp_etl_complete_job($1, $2, $3, $4, $5)',
      [jobId, processed, created, 0, 0]
    );
    console.log(`[ETL] Completed: ${processed} processed, ${created} loaded, ${failed} failed`);
  } catch (err) {
    await pool.query('SELECT sp_etl_fail_job($1, $2)', [jobId, err.message]);
    console.error('[ETL] Job failed:', err);
  }
}

// Run once on startup, then on schedule
(async () => {
  console.log('[ETL] Document ETL service starting...');
  await runEtl();

  cron.schedule(CRON_SCHEDULE, async () => {
    await runEtl();
  });

  console.log(`[ETL] Scheduled to run on: ${CRON_SCHEDULE}`);
})();
