const CATEGORY_ALIASES = {
  health: 'health_insurance',
  medical: 'health_insurance',
  dental: 'dental',
  vision: 'vision',
  eye: 'vision',
  life: 'life_insurance',
  'life insurance': 'life_insurance',
  disability: 'disability',
  'short-term': 'disability',
  'long-term': 'disability',
  std: 'disability',
  ltd: 'disability',
  retirement: 'retirement',
  '401k': 'retirement',
  '401(k)': 'retirement',
  pension: 'retirement',
  pto: 'paid_time_off',
  'paid time off': 'paid_time_off',
  vacation: 'paid_time_off',
  'time off': 'paid_time_off',
  fmla: 'fmla',
  'family leave': 'fmla',
  'maternity leave': 'fmla',
  'paternity leave': 'fmla',
  cobra: 'cobra',
  hsa: 'hsa',
  'health savings': 'hsa',
  fsa: 'fsa',
  'flexible spending': 'fsa',
  wellness: 'wellness',
  eap: 'eap',
  'employee assistance': 'eap',
  tuition: 'tuition_reimbursement',
  'tuition reimbursement': 'tuition_reimbursement',
  education: 'tuition_reimbursement',
};

const NOISE_WORDS = [
  'can you', 'please', 'find me', 'search for', 'look up', 'show me',
  'what is', 'what are', 'tell me about', 'i need', 'i want',
  'documents about', 'documents on', 'docs about', 'docs on',
  'information on', 'info on', 'info about',
];

function parseQuery(rawQuery) {
  let cleaned = rawQuery.trim().toLowerCase();
  let category = null;

  // Strip noise / conversational preamble
  for (const noise of NOISE_WORDS) {
    if (cleaned.startsWith(noise)) {
      cleaned = cleaned.slice(noise.length).trim();
    }
  }

  // Detect explicit category: prefix ("category:dental")
  const categoryMatch = cleaned.match(/^category:(\S+)\s*/);
  if (categoryMatch) {
    const alias = categoryMatch[1];
    category = CATEGORY_ALIASES[alias] || alias;
    cleaned = cleaned.slice(categoryMatch[0].length).trim();
  }

  // Detect implicit category from keywords
  if (!category) {
    for (const [alias, cat] of Object.entries(CATEGORY_ALIASES)) {
      if (cleaned.includes(alias)) {
        category = cat;
        break;
      }
    }
  }

  // If query is empty after cleanup, fall back to raw
  if (cleaned.length === 0) {
    cleaned = rawQuery.trim();
  }

  return {
    rawQuery: rawQuery,
    cleanedQuery: cleaned,
    category,
  };
}

module.exports = { parseQuery, CATEGORY_ALIASES };
