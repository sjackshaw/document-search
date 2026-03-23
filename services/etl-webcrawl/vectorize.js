const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cron = require('node-cron');
const { getEmbedder, embed, embedBatch, chunkText } = require('../../lib/embedding');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 64;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';
const MANIFEST_PATH = path.join(__dirname, 'data', 'web_manifest.json');

const pool = new Pool();

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function loadWebSource(entry) {
  // Upsert web source record
  const srcResult = await pool.query(
    'SELECT sp_upsert_web_source($1, $2, $3, $4, $5, $6, $7)',
    [
      entry.url,
      entry.domain,
      entry.title,
      entry.category,
      entry.section_count,
      entry.sections.reduce((sum, s) => sum + s.text.length, 0),
      entry.content_hash,
    ]
  );
  const sourceId = srcResult.rows[0].sp_upsert_web_source;

  // Delete existing sections/chunks for this source (cascade handles chunks)
  await pool.query('DELETE FROM web_sections WHERE source_id = $1', [sourceId]);

  // Process sections
  for (let s = 0; s < entry.sections.length; s++) {
    const section = entry.sections[s];
    const sectionEmbedding = await embed(section.text.slice(0, 512));

    const secResult = await pool.query(
      'SELECT sp_upsert_web_section($1, $2, $3, $4, $5)',
      [
        sourceId,
        s,
        section.heading,
        section.text,
        `[${sectionEmbedding.join(',')}]`,
      ]
    );
    const sectionId = secResult.rows[0].sp_upsert_web_section;

    // Chunk the section and embed each chunk
    const chunks = chunkText(section.text);
    const chunkEmbeddings = await embedBatch(chunks);

    for (let c = 0; c < chunks.length; c++) {
      await pool.query(
        'SELECT sp_upsert_web_chunk($1, $2, $3, $4, $5)',
        [
          sourceId,
          sectionId,
          c,
          chunks[c],
          `[${chunkEmbeddings[c].join(',')}]`,
        ]
      );
    }
  }

  return sourceId;
}

async function runEtl() {
  console.log(`[ETL] Starting web crawl ETL run at ${new Date().toISOString()}`);

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log(`[ETL] Manifest not found: ${MANIFEST_PATH}`);
    return;
  }

  const manifest = loadManifest();
  const total = manifest.length;
  console.log(`[ETL] Loaded manifest with ${total} web sources`);

  if (total === 0) return;

  // Start ETL job
  const jobResult = await pool.query(
    'SELECT sp_etl_start_job($1, $2, $3)',
    ['etl-webcrawl', 'complete', 'web']
  );
  const jobId = jobResult.rows[0].sp_etl_start_job;

  let processed = 0;
  let created = 0;
  let failed = 0;

  try {
    await getEmbedder();

    for (let i = 0; i < total; i++) {
      const entry = manifest[i];
      manifest[i] = null; // release reference to free memory

      try {
        console.log(`[ETL] Processing (${i + 1}/${total}): ${entry.url}`);

        await loadWebSource(entry);

        processed++;
        created++;
        const totalChars = entry.sections.reduce((sum, s) => sum + s.text.length, 0);
        console.log(`[ETL] Loaded: ${entry.url} (${entry.section_count} sections, ${totalChars} chars)`);

        if (processed % 10 === 0 && global.gc) {
          global.gc();
        }
      } catch (err) {
        failed++;
        console.error(`[ETL] Failed to process ${entry.url}:`, err.message);
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
  console.log('[ETL] Web crawl ETL service starting...');
  await runEtl();

  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`[ETL] Cron triggered: ${CRON_SCHEDULE}`);
    runEtl().catch(err => console.error('[ETL] Cron run failed:', err));
  });

  console.log(`[ETL] Cron scheduled: ${CRON_SCHEDULE}`);
})();
