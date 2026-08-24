'use strict';

// Escalation signal detection for benefits chat services.
// Each entry maps a regex pattern to a human-readable signal label stored
// in chat_logs.escalation_signals for dashboard reporting.

const ESCALATION_PATTERNS = [
  { pattern: /\battorney\b|\blawyer\b|\blegal\s+counsel\b/i,        signal: 'legal_representation' },
  { pattern: /\blawsuit\b|\bsuing\b|\bsue\b|\blitigation\b/i,       signal: 'litigation_threat' },
  { pattern: /\bgrievance\b|\bformal\s+complaint\b/i,               signal: 'formal_grievance' },
  { pattern: /\binsurance\s+commissioner\b|\bstate\s+(insurance\s+)?board\b/i, signal: 'state_regulator' },
  { pattern: /\bDOL\b|\bDepartment\s+of\s+Labor\b|\bERISA\b/i,     signal: 'federal_regulator' },
  { pattern: /\bBBB\b|\bBetter\s+Business\s+Bureau\b/i,             signal: 'bbb_complaint' },
  { pattern: /\bwrongful\s+denial\b|\billegal\s+denial\b|\bunfair\s+denial\b/i, signal: 'wrongful_denial' },
  { pattern: /\bdiscrimination\b/i,                                  signal: 'discrimination_claim' },
  { pattern: /\bcompliance\s+violation\b|\bregulation\s+violation\b/i, signal: 'compliance_violation' },
  { pattern: /\bclass\s+action\b/i,                                  signal: 'class_action' },
];

/**
 * Scan text for escalation signals.
 *
 * @param {string} text
 * @returns {{ flagged: boolean, signals: string[] }}
 */
function detectEscalation(text) {
  const signals = [];
  const input = String(text || '');
  for (const { pattern, signal } of ESCALATION_PATTERNS) {
    if (pattern.test(input)) {
      signals.push(signal);
    }
  }
  return { flagged: signals.length > 0, signals };
}

module.exports = { detectEscalation };
