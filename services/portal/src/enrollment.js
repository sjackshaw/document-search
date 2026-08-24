'use strict';

// Open Enrollment Decision Support (#7)
// Compares available plan options against a member's historical utilization
// to produce projected cost estimates and a recommendation.

// Standard plan tier (current offerings)
const STANDARD_PLANS = {
  medical: {
    name: 'Core Medical PPO',
    tier: 'standard',
    deductible: 1800,
    outOfPocketMax: 6500,
    note: 'Broad network, lower deductible',
  },
  dental: {
    name: 'Dental Plus',
    tier: 'standard',
    deductible: 75,
    outOfPocketMax: 1500,
    note: 'Covers preventive, restorative, and major dental',
  },
  vision: {
    name: 'Vision Select',
    tier: 'standard',
    deductible: 0,
    outOfPocketMax: 450,
    note: 'Annual exam plus frames/lens allowance',
  },
  rx: {
    name: 'Prescription Advantage',
    tier: 'standard',
    deductible: 250,
    outOfPocketMax: 2200,
    note: 'Retail and mail-order; generic, preferred, and specialty tiers',
  },
  mental_health: {
    name: 'Behavioral Health Support',
    tier: 'standard',
    deductible: 300,
    outOfPocketMax: 2500,
    note: 'Therapy, psychiatry, virtual visits, and outpatient programs',
  },
};

// High-deductible / economy alternative offered during open enrollment
const HDHP_PLANS = {
  medical: {
    name: 'Medical HDHP',
    tier: 'hdhp',
    deductible: 3500,
    outOfPocketMax: 7000,
    note: 'HSA-eligible; lower monthly premium',
  },
  dental: {
    name: 'Dental Basic',
    tier: 'economy',
    deductible: 150,
    outOfPocketMax: 1000,
    note: 'Preventive and basic restorative only; lower premium',
  },
  vision: {
    name: 'Vision Economy',
    tier: 'economy',
    deductible: 0,
    outOfPocketMax: 250,
    note: 'Annual exam covered; reduced frame/lens allowance',
  },
  rx: {
    name: 'Prescription Basic',
    tier: 'economy',
    deductible: 150,
    outOfPocketMax: 1500,
    note: 'Generic and preferred tiers; higher specialty copays',
  },
  mental_health: {
    name: 'Behavioral Health Basic',
    tier: 'economy',
    deductible: 500,
    outOfPocketMax: 2000,
    note: 'Virtual visits and outpatient; limited in-person sessions',
  },
};

/**
 * Estimate a member's projected out-of-pocket cost for a given plan
 * based on their actual spending from the reference plan year.
 *
 * @param {number} historicalMemberPaid - member's actual OOP spend last year
 * @param {{ deductible: number, outOfPocketMax: number }} plan
 * @returns {number}
 */
function estimateCost(historicalMemberPaid, plan) {
  // If spending exceeds this plan's OOP max, cap at OOP max
  if (historicalMemberPaid >= plan.outOfPocketMax) return plan.outOfPocketMax;
  // If spending is between deductible and OOP max, apply proportional cost share
  if (historicalMemberPaid >= plan.deductible) return historicalMemberPaid;
  // Low utilizer: assume spending tracks similarly but capped at deductible
  return Math.min(historicalMemberPaid, plan.deductible);
}

/**
 * Generate a recommendation and reasoning string for a plan type.
 *
 * @param {number} memberPaid
 * @param {object} standard
 * @param {object} hdhp
 * @returns {{ recommendation: string, reasoning: string }}
 */
function recommend(memberPaid, standard, hdhp) {
  const stdCost = estimateCost(memberPaid, standard);
  const hdhpCost = estimateCost(memberPaid, hdhp);

  if (memberPaid === 0) {
    return {
      recommendation: hdhp.tier,
      reasoning: 'No utilization recorded. The lower-premium economy option carries less financial risk for low utilizers.',
    };
  }

  if (memberPaid >= standard.deductible) {
    return {
      recommendation: standard.tier,
      reasoning: `Your spending ($${memberPaid.toFixed(2)}) exceeded the ${standard.name} deductible ($${standard.deductible}). The standard plan is more cost-effective at this utilization level.`,
    };
  }

  const diff = Math.abs(stdCost - hdhpCost);
  if (diff < 100) {
    return {
      recommendation: 'similar',
      reasoning: `Projected costs are within $${diff.toFixed(2)} of each other. Consider premium differences and coverage breadth when choosing.`,
    };
  }

  if (hdhpCost < stdCost) {
    return {
      recommendation: hdhp.tier,
      reasoning: `Your utilization is below the ${standard.name} deductible. The economy option projects lower total cost ($${hdhpCost.toFixed(2)} vs $${stdCost.toFixed(2)}).`,
    };
  }

  return {
    recommendation: standard.tier,
    reasoning: `The standard plan projects lower total cost ($${stdCost.toFixed(2)} vs $${hdhpCost.toFixed(2)}) based on your utilization.`,
  };
}

/**
 * Build the open-enrollment comparison for a member.
 *
 * @param {import('pg').Pool} pool
 * @param {{ memberId: string }} member
 * @param {number} referenceYear  - plan year whose claims drive the projection
 * @returns {Promise<object>}
 */
async function compareEnrollmentOptions(pool, member, referenceYear) {
  const { rows } = await pool.query(
    `SELECT claim_type,
            count(*)::int                              AS claim_count,
            sum(amount_billed)::numeric(12,2)          AS billed,
            sum(amount_billed - amount_paid)::numeric(12,2) AS member_paid
     FROM claims
     WHERE member_id = $1 AND plan_year = $2
     GROUP BY claim_type
     ORDER BY claim_type`,
    [member.memberId, referenceYear],
  );

  // Index utilization by plan type
  const utilization = {};
  for (const row of rows) {
    utilization[row.claim_type] = {
      claimCount: row.claim_count,
      billed: Number(row.billed || 0),
      memberPaid: Number(row.member_paid || 0),
    };
  }

  const planTypes = Object.keys(STANDARD_PLANS);
  const planComparison = planTypes.map(planType => {
    const standard = STANDARD_PLANS[planType];
    const hdhp = HDHP_PLANS[planType];
    const util = utilization[planType] || { claimCount: 0, billed: 0, memberPaid: 0 };
    const { recommendation, reasoning } = recommend(util.memberPaid, standard, hdhp);

    return {
      planType,
      utilizationLastYear: util,
      options: [
        {
          ...standard,
          estimatedMemberCost: estimateCost(util.memberPaid, standard),
        },
        {
          ...hdhp,
          estimatedMemberCost: estimateCost(util.memberPaid, hdhp),
        },
      ],
      recommendation,
      reasoning,
    };
  });

  return {
    referenceYear,
    utilizationSummary: rows.map(r => ({
      planType: r.claim_type,
      claimCount: r.claim_count,
      billed: Number(r.billed || 0),
      memberPaid: Number(r.member_paid || 0),
    })),
    planComparison,
  };
}

module.exports = { compareEnrollmentOptions };
