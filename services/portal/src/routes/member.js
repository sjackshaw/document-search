'use strict';

// Member-scoped claims, plan, deductible, document generation, bot, and
// enrollment routes. Merged from the former standalone `member-benefits-app`
// service. All routes here require a resolvable member (via X-Member-Email
// header or memberEmail query/body param) and are mounted under /api/member.

const express = require('express');
const path = require('path');
const pool = require('../db');
const benefits = require('../member-benefits');
const { detectEscalation } = require('../escalation');
const { compareEnrollmentOptions } = require('../enrollment');

const API_KEY = process.env.API_KEY || '';
const DOCUMENT_DIR = process.env.DOCUMENT_DIR || path.join(__dirname, '..', '..', 'generated-docs');

async function logBotQuery(question, escalationFlagged, escalationSignals) {
  try {
    await pool.query(
      `INSERT INTO chat_logs
         (service, question, escalation_flagged, escalation_signals)
       VALUES ('member-bot', $1, $2, $3)`,
      [question, escalationFlagged, escalationSignals],
    );
  } catch (err) {
    console.error('chat_logs insert failed:', err.message);
  }
}

const router = express.Router();

router.use(async (req, res, next) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const requestedEmail = req.headers['x-member-email'] || req.query.memberEmail || req.body?.memberEmail;
  try {
    const member = await benefits.resolveMember(pool, requestedEmail);
    if (!member) return res.status(404).json({ error: 'Member not found in claims data' });
    req.user = member;
    return next();
  } catch (err) {
    console.error('Member resolution failed:', err);
    return res.status(500).json({ error: 'Unable to resolve member' });
  }
});

router.get('/session', async (req, res) => {
  const members = await benefits.listMembers(pool, 40);
  res.json({ member: req.user, sampleMembers: members });
});

router.get('/claims/open', async (req, res) => {
  try {
    const claims = await benefits.getOpenClaims(pool, req.user);
    res.json({ member: req.user, claims });
  } catch (err) {
    console.error('Open claims failed:', err);
    res.status(500).json({ error: 'Unable to load open claims' });
  }
});

router.get('/claims/summary', async (req, res) => {
  try {
    const planYear = req.query.planYear ? parseInt(req.query.planYear, 10) : null;
    const summary = await benefits.getClaimsSummary(pool, req.user, planYear);
    res.json({ member: req.user, summary });
  } catch (err) {
    console.error('Claims summary failed:', err);
    res.status(500).json({ error: 'Unable to load claims summary' });
  }
});

router.get('/claims/search', async (req, res) => {
  try {
    const claims = await benefits.searchClaims(pool, req.user, req.query.q || '');
    res.json({ member: req.user, claims });
  } catch (err) {
    console.error('Claims search failed:', err);
    res.status(500).json({ error: 'Unable to search claims' });
  }
});

router.get('/plan', (req, res) => {
  const plan = benefits.getPlanDetails(req.query.type || 'medical');
  res.json({ member: req.user, plan });
});

router.get('/deductible', async (req, res) => {
  try {
    const planYear = req.query.planYear ? parseInt(req.query.planYear, 10) : new Date().getFullYear();
    const deductible = await benefits.getDeductibleStatus(pool, req.user, planYear);
    res.json({ member: req.user, deductible });
  } catch (err) {
    console.error('Deductible status failed:', err);
    res.status(500).json({ error: 'Unable to load deductible status' });
  }
});

router.post('/documents/:type', async (req, res) => {
  try {
    const type = req.params.type;
    const planYear = req.body.planYear || new Date().getFullYear();
    const summary = await benefits.getClaimsSummary(pool, req.user, planYear);
    const rows = [];

    if (type === 'eob') {
      const claim = await benefits.getClaimById(pool, req.user, req.body.claimId);
      if (!claim) return res.status(404).json({ error: 'Claim not found for this member' });
      rows.push(
        { label: 'Claim ID', value: claim.claimId },
        { label: 'Provider', value: claim.provider },
        { label: 'Service date', value: claim.serviceDate },
        { label: 'Status', value: claim.status },
        { label: 'Amount billed', value: benefits.dollars(claim.amountBilled) },
        { label: 'Amount paid', value: benefits.dollars(claim.amountPaid) },
        { label: 'Member responsibility', value: benefits.dollars(claim.amountBilled - claim.amountPaid) },
      );
    } else if (type === 'spd') {
      const plan = benefits.getPlanDetails(req.body.planType || 'medical');
      rows.push(
        { label: 'Plan', value: plan.name },
        { label: 'Coverage', value: plan.coverage },
        { label: 'Deductible', value: benefits.dollars(plan.deductible) },
        { label: 'Out-of-pocket maximum', value: benefits.dollars(plan.outOfPocketMax) },
      );
    } else if (type === 'enrollment_form' || type === 'beneficiary_form') {
      rows.push(
        { label: 'Member ID', value: req.user.memberId },
        { label: 'Member email', value: req.user.memberEmail },
        { label: 'Document status', value: 'Pre-filled for member review and signature' },
      );
    } else {
      for (const row of summary) {
        rows.push({
          label: `${row.planYear} ${row.claimType}`,
          value: `Billed ${benefits.dollars(row.billed)}, paid ${benefits.dollars(row.paid)}, member responsibility ${benefits.dollars(row.memberResponsibility)}`,
        });
      }
    }

    const html = benefits.renderDocumentHtml(type, req.user, {
      summary: `Generated ${type.replace(/_/g, ' ')} for plan year ${planYear}.`,
      rows,
    });
    const filename = benefits.writeDocument(DOCUMENT_DIR, req.user, type, html);
    res.json({
      member: req.user,
      document: {
        type,
        filename,
        url: `/member/documents/${filename}`,
      },
    });
  } catch (err) {
    console.error('Document generation failed:', err);
    res.status(500).json({ error: 'Unable to generate document' });
  }
});

router.post('/bot', async (req, res) => {
  const prompt = String(req.body.prompt || '').toLowerCase();
  const rawPrompt = String(req.body.prompt || '');

  // Detect escalation signals before answering
  const { flagged: escalationFlagged, signals: escalationSignals } = detectEscalation(rawPrompt);
  logBotQuery(rawPrompt, escalationFlagged, escalationSignals);

  try {
    let response;
    if (prompt.includes('open') || prompt.includes('pending') || prompt.includes('appeal')) {
      const claims = await benefits.getOpenClaims(pool, req.user);
      response = { tool: 'get_open_claims', message: `You have ${claims.length} open claims.`, data: claims };
    } else if (prompt.includes('deductible')) {
      const deductible = await benefits.getDeductibleStatus(pool, req.user, new Date().getFullYear());
      response = { tool: 'get_deductible_status', message: 'Here is your current deductible status.', data: deductible };
    } else if (prompt.includes('dental') || prompt.includes('vision') || prompt.includes('medical') || prompt.includes('rx')) {
      const planType = ['dental', 'vision', 'medical', 'rx'].find(type => prompt.includes(type)) || 'medical';
      response = { tool: 'get_plan_details', message: `Here are your ${planType} plan details.`, data: benefits.getPlanDetails(planType) };
    } else {
      const summary = await benefits.getClaimsSummary(pool, req.user, null);
      response = { tool: 'get_claims_summary', message: 'Here is your claims summary.', data: summary };
    }

    if (escalationFlagged) {
      response.escalationFlagged = true;
      response.escalationNotice = 'Your message has been flagged for support desk review. A benefits specialist will follow up with you shortly.';
    }

    return res.json(response);
  } catch (err) {
    console.error('Bot request failed:', err);
    return res.status(500).json({ error: 'Unable to answer benefits question' });
  }
});

router.get('/enrollment/compare', async (req, res) => {
  try {
    const referenceYear = req.query.planYear
      ? parseInt(req.query.planYear, 10)
      : new Date().getFullYear() - 1;
    const comparison = await compareEnrollmentOptions(pool, req.user, referenceYear);
    res.json({ member: req.user, ...comparison });
  } catch (err) {
    console.error('Enrollment comparison failed:', err);
    res.status(500).json({ error: 'Unable to generate enrollment comparison' });
  }
});

module.exports = { router, DOCUMENT_DIR };
