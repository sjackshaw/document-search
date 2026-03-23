const { pipeline } = require('@xenova/transformers');

const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let embedderPromise = null;

function getEmbedder() {
  if (!embedderPromise) {
    console.log('Loading BGE embedding model...');
    embedderPromise = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5').then(
      (model) => {
        console.log('BGE embedding model loaded.');
        return model;
      }
    );
  }
  return embedderPromise;
}

async function embed(text) {
  const model = await getEmbedder();
  const result = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

async function embedQuery(text) {
  return embed(BGE_QUERY_PREFIX + text);
}

async function embedBatch(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

function chunkText(text, chunkSize = 500, chunkOverlap = 50) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - chunkOverlap;
  }
  return chunks;
}

module.exports = { BGE_QUERY_PREFIX, getEmbedder, embed, embedQuery, embedBatch, chunkText };
