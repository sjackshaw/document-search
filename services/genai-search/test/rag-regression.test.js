'use strict';

/**
 * RAG Regression Suite (#9)
 *
 * Integration tests that call the running genai-search service at
 * TEST_BASE_URL (default: http://localhost:3001) and verify that
 * answers to golden Q&A pairs contain expected keywords.
 *
 * Run with:
 *   npm test  (from services/genai-search/ while the stack is running)
 *
 * The suite skips automatically when the service is unreachable, so it
 * is safe to include in CI pipelines that don't spin up the full stack.
 *
 * Each test case has:
 *   - question   : the question sent to POST /api/ask
 *   - keywords   : lowercase strings that MUST appear in the answer
 *   - notKeywords: strings that must NOT appear (hallucination guards)
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const TIMEOUT_MS = 60_000; // Ollama on CPU can be slow

// Golden test cases — update/extend as content is added to the index
const GOLDEN_CASES = [
  {
    id: 'medical-deductible',
    question: 'What is the annual deductible for the medical plan?',
    keywords: ['deductible', 'medical'],
    notKeywords: [],
  },
  {
    id: 'dental-coverage',
    question: 'Does the dental plan cover orthodontics?',
    keywords: ['dental'],
    notKeywords: [],
  },
  {
    id: '401k-match',
    question: 'What is the employer 401k match?',
    keywords: ['401'],
    notKeywords: [],
  },
  {
    id: 'vision-exam',
    question: 'How often is an eye exam covered under the vision plan?',
    keywords: ['vision', 'eye'],
    notKeywords: [],
  },
  {
    id: 'pto-accrual',
    question: 'How many days of paid time off do new employees receive?',
    keywords: ['pto', 'vacation', 'days', 'time off'],
    notKeywords: [],
  },
  {
    id: 'fmla-eligibility',
    question: 'Am I eligible for FMLA leave?',
    keywords: ['fmla', 'leave'],
    notKeywords: [],
  },
  {
    id: 'rx-tier',
    question: 'What are the prescription drug tiers?',
    keywords: ['generic', 'prescription', 'tier'],
    notKeywords: [],
  },
  {
    id: 'oop-max',
    question: 'What is the out-of-pocket maximum for the health plan?',
    keywords: ['out-of-pocket', 'maximum'],
    notKeywords: [],
  },
  {
    id: 'mental-health',
    question: 'Does the plan cover mental health therapy?',
    keywords: ['mental', 'therapy', 'behavioral'],
    notKeywords: [],
  },
  {
    id: 'appeal-process',
    question: 'How do I appeal a denied claim?',
    keywords: ['appeal', 'denied', 'claim'],
    notKeywords: [],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function checkServiceReachable() {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function askQuestion(question) {
  const res = await fetch(`${BASE_URL}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('RAG regression suite', () => {
  let serviceAvailable = false;

  beforeAll(async () => {
    serviceAvailable = await checkServiceReachable();
    if (!serviceAvailable) {
      console.warn(`[RAG regression] Service unreachable at ${BASE_URL} — all tests will be skipped.`);
    }
  });

  for (const tc of GOLDEN_CASES) {
    // eslint-disable-next-line no-loop-func
    test(`[${tc.id}] "${tc.question}"`, async () => {
      if (!serviceAvailable) {
        console.warn(`Skipping: service not running at ${BASE_URL}`);
        return;
      }

      const { answer } = await askQuestion(tc.question);

      expect(typeof answer).toBe('string');
      expect(answer.length).toBeGreaterThan(20);

      const lower = answer.toLowerCase();

      // At least one required keyword must appear in the answer
      const matchedKeyword = tc.keywords.find(k => lower.includes(k.toLowerCase()));
      expect(matchedKeyword).toBeDefined();

      // None of the forbidden strings should appear
      for (const forbidden of tc.notKeywords) {
        expect(lower).not.toContain(forbidden.toLowerCase());
      }
    }, TIMEOUT_MS + 5000);
  }

  test('POST /api/ask returns chatLogId for feedback tracking', async () => {
    if (!serviceAvailable) {
      console.warn(`Skipping: service not running at ${BASE_URL}`);
      return;
    }

    const data = await askQuestion('What benefits does the company offer?');
    expect(data).toHaveProperty('answer');
    expect(data).toHaveProperty('sessionId');
    // chatLogId is present when the DB table exists
    // (may be null if chat_logs table not yet migrated)
    expect(data).toHaveProperty('chatLogId');
  }, TIMEOUT_MS + 5000);

  test('escalationFlagged is returned on legal-signal questions', async () => {
    if (!serviceAvailable) {
      console.warn(`Skipping: service not running at ${BASE_URL}`);
      return;
    }

    const data = await askQuestion('I need to consult an attorney about my denied claim.');
    expect(data).toHaveProperty('escalationFlagged', true);
  }, TIMEOUT_MS + 5000);
});
