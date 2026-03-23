#!/usr/bin/env python3
"""
Generate 700 synthetic web pages containing benefits-related language
across multiple categories, with a JSON manifest for ETL and HTML files
for serving.

Usage:
    python generate_synthetic_web.py

Output:
    services/etl-webcrawl/data/web_manifest.json
    services/etl-webcrawl/data/pages/<slug>.html
"""

import hashlib
import json
import os
import random

random.seed(99)

OUTPUT_DIR = os.path.join(
    os.path.dirname(__file__), "services", "etl-webcrawl", "data", "pages"
)
MANIFEST_PATH = os.path.join(
    os.path.dirname(__file__), "services", "etl-webcrawl", "data", "web_manifest.json"
)
TOTAL_PAGES = 700

DOMAINS = [
    "benefits.example.com",
    "hr-portal.example.com",
    "employee-hub.example.com",
    "my-benefits.example.com",
    "benefits-center.example.com",
]

# ── Category definitions with web-oriented section headings and content ──

CATEGORIES = {
    "health_insurance": {
        "weight": 0.15,
        "titles": [
            "Understanding Your Health Plan",
            "PPO vs HMO: Choosing the Right Plan",
            "How to Find In-Network Providers",
            "Managing Your Annual Deductible",
            "Emergency Room vs Urgent Care",
            "Preventive Care Benefits Guide",
            "Telehealth Services FAQ",
            "Prior Authorization Explained",
            "Prescription Drug Coverage Tiers",
            "Adding Dependents to Your Health Plan",
            "Out-of-Pocket Maximum Explained",
            "Mental Health Coverage Overview",
            "Claims and Appeals Process",
            "Health Plan Comparison Tool Guide",
            "Specialist Referral Requirements",
        ],
        "headings": [
            "Plan Overview", "Deductibles and Copays", "In-Network Benefits",
            "Out-of-Network Coverage", "Preventive Care", "Prescription Drugs",
            "Emergency Services", "Mental Health Services", "Telehealth Options",
            "How to File a Claim", "Appeals Process", "Dependent Coverage",
        ],
        "paragraphs": [
            "Your group health insurance plan provides comprehensive medical coverage for eligible employees and their qualified dependents. Coverage begins on the first day of the month following thirty days of continuous employment.",
            "The annual deductible for individual coverage is $1,500 for in-network services and $3,000 for out-of-network services. Family deductible amounts are two times the individual amounts.",
            "Preventive care services, including annual physicals, immunizations, and age-appropriate screenings, are covered at 100% when performed by an in-network provider with no deductible required.",
            "After meeting the annual deductible, the plan pays 80% of covered in-network charges and 60% of covered out-of-network charges. The member is responsible for the remaining coinsurance.",
            "The out-of-pocket maximum limits the total amount you pay for covered services in a plan year. For individual coverage, the in-network out-of-pocket maximum is $6,500.",
            "Emergency room visits are covered at in-network rates regardless of facility location. A $250 copay applies per visit and is waived if the member is admitted to the hospital.",
            "Mental health and substance abuse treatment services are provided in accordance with federal mental health parity requirements.",
            "Prior authorization is required for all inpatient hospital admissions, outpatient surgical procedures, and advanced imaging studies such as MRI, CT, and PET scans.",
            "Prescription drugs are covered under a four-tier formulary. Generic drugs require a $10 copay, preferred brand-name drugs require a $35 copay, non-preferred brands require a $60 copay.",
            "Telemedicine consultations are available 24/7 through the plan's designated virtual care platform. Office visit copays apply to scheduled telehealth appointments.",
            "Well-child visits are covered at no cost to the member through age 18, including all recommended vaccinations per the CDC immunization schedule.",
            "Physical therapy, occupational therapy, and speech therapy services are covered for up to 60 visits per plan year combined when prescribed by a physician.",
        ],
    },
    "dental": {
        "weight": 0.10,
        "titles": [
            "Dental Benefits Overview",
            "Understanding Dental Preventive Care",
            "Orthodontic Coverage for Dependents",
            "Dental Claims Process Guide",
            "Dental PPO vs DHMO Plans",
            "Dental Emergency Coverage",
            "Annual Maximum Benefit Explained",
            "Pediatric Dental Services",
            "Dental Implant Coverage Details",
            "Cosmetic Dentistry Policy",
        ],
        "headings": [
            "Coverage Levels", "Preventive Services", "Basic Services",
            "Major Services", "Orthodontics", "Annual Maximum",
            "Waiting Periods", "How to File Claims", "Finding a Dentist",
        ],
        "paragraphs": [
            "The dental plan provides coverage for preventive, basic, and major dental services. Preventive services are covered at 100%, basic services at 80%, and major services at 50% after the annual deductible.",
            "The annual deductible is $50 per individual and $150 per family. The deductible does not apply to preventive services including routine cleanings, exams, and bitewing X-rays.",
            "The annual maximum benefit is $2,000 per covered individual. Orthodontic benefits have a separate lifetime maximum of $2,500 for dependents under age 19.",
            "Preventive care includes two routine cleanings per year, one comprehensive oral exam, one set of bitewing X-rays, and one panoramic X-ray every three years.",
            "Basic services include fillings, simple extractions, periodontal scaling and root planing, and endodontic treatment on permanent teeth.",
            "Major services include crowns, bridges, dentures, dental implants, and oral surgery. A 12-month waiting period applies to major services for new enrollees.",
            "Emergency dental treatment for accidental injury to natural teeth is covered at 80% with no waiting period, provided treatment begins within 72 hours.",
            "Dental sealants are covered at 100% for children ages 6 through 14 on permanent molars only.",
            "Teeth whitening, cosmetic bonding, and other elective cosmetic dental procedures are not covered under this dental plan.",
        ],
    },
    "vision": {
        "weight": 0.08,
        "titles": [
            "Vision Benefits Overview",
            "Eye Exam Coverage Details",
            "Eyeglass Frame Allowance Guide",
            "Contact Lens Benefits Explained",
            "Pediatric Vision Care",
            "LASIK Discount Information",
            "Vision Network Providers",
            "Vision Claims FAQ",
        ],
        "headings": [
            "Eye Exams", "Eyeglass Lenses", "Frame Allowance",
            "Contact Lenses", "Pediatric Vision", "Discounts and Savings",
        ],
        "paragraphs": [
            "The vision plan covers one comprehensive eye exam per plan year with a $10 copay when using an in-network provider. Out-of-network exams are reimbursed up to $50.",
            "Eyeglass lenses are covered in full for single vision, bifocal, or progressive lenses once every 12 months.",
            "The plan provides a $200 allowance toward eyeglass frames from an in-network provider once every 24 months.",
            "Contact lenses are covered as an alternative to eyeglasses. The plan provides up to $150 toward contact lens materials.",
            "Pediatric vision coverage includes annual comprehensive eye exams and one pair of eyeglasses per year for dependent children through age 18.",
            "LASIK and PRK refractive surgery are available at a negotiated discount of 15-20% through participating centers.",
            "Blue light filtering lenses and digital screen protection coatings are available as add-on options at reduced member pricing.",
        ],
    },
    "life_insurance": {
        "weight": 0.08,
        "titles": [
            "Life Insurance Benefits Overview",
            "Supplemental Life Insurance Guide",
            "AD&D Coverage Explained",
            "Beneficiary Designation Guide",
            "Life Insurance Portability Options",
            "Dependent Life Insurance",
            "Evidence of Insurability FAQ",
            "Life Insurance Conversion Rights",
        ],
        "headings": [
            "Basic Coverage", "Supplemental Options", "AD&D Benefits",
            "Beneficiary Information", "Portability", "Dependent Coverage",
            "Tax Implications",
        ],
        "paragraphs": [
            "The company provides basic life insurance coverage at no cost to eligible employees. The benefit amount is equal to one times the employee's annual base salary up to $500,000.",
            "Accidental death and dismemberment coverage is included with the basic life insurance benefit at the same coverage amount.",
            "Supplemental life insurance is available for purchase at group rates in increments of $10,000 up to five times annual salary.",
            "Dependent life insurance is available for spouses up to $250,000 and children at $10,000 per child from live birth to age 26.",
            "Evidence of insurability is required for supplemental coverage above the guaranteed issue amount of $200,000.",
            "The portability option allows terminated employees to continue their supplemental life coverage by paying premiums directly.",
            "Imputed income for employer-paid coverage exceeding $50,000 is taxable and will be reported on the employee's W-2 form.",
            "Beneficiary designations should be reviewed annually and updated following major life events.",
        ],
    },
    "disability": {
        "weight": 0.08,
        "titles": [
            "Disability Benefits Overview",
            "Short-Term Disability Guide",
            "Long-Term Disability Coverage",
            "Filing a Disability Claim",
            "Return to Work Program",
            "Disability Benefit Calculations",
            "Disability and FMLA Coordination",
            "Partial Disability Benefits",
        ],
        "headings": [
            "Short-Term Disability", "Long-Term Disability", "Elimination Periods",
            "Benefit Calculations", "Claims Process", "Return to Work",
            "Coordination with Other Benefits",
        ],
        "paragraphs": [
            "Short-term disability benefits replace 60% of weekly base earnings for up to 26 weeks following a 7-day elimination period for illness.",
            "Long-term disability coverage provides 60% of monthly pre-disability earnings up to $15,000 per month beginning after STD ends.",
            "A pre-existing condition limitation applies to LTD benefits for conditions treated in the 3 months prior to coverage effective date.",
            "Disability benefits are offset by income from Social Security disability, workers' compensation, and state disability programs.",
            "The plan includes a rehabilitation incentive benefit providing an additional 5% during approved vocational rehabilitation.",
            "Partial disability benefits are calculated as the difference between 60% of pre-disability earnings and current earnings.",
            "Pregnancy-related disability is covered under the same terms as any other disability.",
            "The definition of disability changes after 24 months from 'own occupation' to 'any occupation.'",
        ],
    },
    "retirement": {
        "weight": 0.12,
        "titles": [
            "401(k) Plan Overview",
            "Roth 401(k) Contribution Guide",
            "Understanding Employer Match",
            "Vesting Schedule Explained",
            "401(k) Loan Provisions",
            "Hardship Withdrawal Rules",
            "Required Minimum Distributions",
            "Investment Options Guide",
            "Catch-Up Contributions for 50+",
            "Rollover Options at Separation",
            "Automatic Enrollment Information",
            "Plan Fee Disclosure Guide",
        ],
        "headings": [
            "Plan Basics", "Contribution Limits", "Employer Match",
            "Vesting", "Investment Options", "Loans and Withdrawals",
            "Rollovers", "Tax Considerations", "Retirement Planning",
        ],
        "paragraphs": [
            "The company sponsors a 401(k) retirement savings plan allowing eligible employees to defer compensation on a pre-tax or Roth after-tax basis.",
            "Employees are eligible to participate on the first day of the month following 60 days of employment. Automatic enrollment at 6% applies unless otherwise elected.",
            "The company matches 100% on the first 3% and 50% on the next 2%, for a maximum employer match of 4% of eligible compensation.",
            "Employee contributions are 100% vested immediately. Employer matching contributions vest on a 3-year graded schedule.",
            "The annual IRS contribution limit for employee deferrals is $23,000. Employees age 50+ may contribute an additional $7,500.",
            "Plan loans are available from vested balances. The minimum is $1,000 and maximum is the lesser of 50% of vested balance or $50,000.",
            "Hardship withdrawals are available for immediate financial needs including medical expenses, tuition, and prevention of eviction.",
            "The plan offers target-date funds, index funds, actively managed funds, a stable value fund, and a self-directed brokerage window.",
            "Target-date funds are the qualified default investment alternative for automatically enrolled participants.",
            "Required minimum distributions must begin by April 1 of the year following the year the participant reaches age 73.",
            "Rollovers from other qualified plans and traditional IRAs are accepted at any time.",
            "Participants should review investment allocations and contribution rates at least annually.",
        ],
    },
    "paid_time_off": {
        "weight": 0.08,
        "titles": [
            "PTO Policy Overview",
            "Vacation Accrual Rates",
            "Sick Leave Guidelines",
            "Holiday Schedule",
            "PTO Carry-Over Rules",
            "Bereavement Leave Policy",
            "Jury Duty Leave",
            "PTO Donation Program",
        ],
        "headings": [
            "Accrual Rates", "Using Your PTO", "Carry-Over Policy",
            "Holidays", "Sick Leave", "Special Leave Types",
        ],
        "paragraphs": [
            "Full-time employees accrue PTO on a bi-weekly basis. Rates increase with tenure: 0-2 years get 15 days, 3-5 years get 20 days, 6+ years get 25 days annually.",
            "PTO requests should be submitted at least two weeks in advance through the self-service portal.",
            "Employees may carry over a maximum of 40 hours of unused PTO into the next calendar year.",
            "Upon separation, employees are paid for accrued but unused PTO at their current base rate.",
            "The company observes 11 paid holidays per year including New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving, and Christmas.",
            "Bereavement leave of up to 5 days is provided for immediate family members and 3 days for extended family.",
            "Jury duty leave provides full pay for up to 10 business days.",
            "The PTO donation program allows voluntary transfer of hours to colleagues with serious medical conditions.",
        ],
    },
    "fmla": {
        "weight": 0.07,
        "titles": [
            "FMLA Rights and Responsibilities",
            "Am I Eligible for FMLA?",
            "How to Request FMLA Leave",
            "FMLA Medical Certification Guide",
            "Intermittent FMLA Leave Explained",
            "FMLA Return to Work Requirements",
            "Parental Leave Under FMLA",
            "Military Family Leave",
        ],
        "headings": [
            "Eligibility", "Qualifying Reasons", "Leave Duration",
            "Requesting Leave", "Medical Certification", "Benefits During Leave",
            "Return to Work",
        ],
        "paragraphs": [
            "The Family and Medical Leave Act provides eligible employees with up to 12 weeks of unpaid, job-protected leave during a 12-month period.",
            "To be eligible, an employee must have worked for the company for at least 12 months and at least 1,250 hours in the prior 12 months.",
            "Qualifying reasons include birth of a child, adoption or foster placement, care of a family member with serious health condition, or employee's own serious condition.",
            "Employees requesting foreseeable leave must provide at least 30 days' advance notice.",
            "Medical certification must be submitted within 15 calendar days of the request.",
            "During FMLA leave, group health insurance continues under the same terms as active employment.",
            "Upon return, the employee will be restored to the same or equivalent position.",
            "Military caregiver leave provides up to 26 weeks for care of a covered servicemember.",
        ],
    },
    "cobra": {
        "weight": 0.05,
        "titles": [
            "COBRA Continuation Coverage Guide",
            "COBRA Qualifying Events",
            "COBRA Premium Information",
            "COBRA Election Timeline",
            "COBRA and Medicare",
            "COBRA for Dependents",
        ],
        "headings": [
            "What is COBRA", "Qualifying Events", "Election Timeline",
            "Premium Payments", "Duration of Coverage", "Termination of Coverage",
        ],
        "paragraphs": [
            "COBRA provides continuation of group health coverage that would otherwise be lost due to qualifying events such as termination or reduction in hours.",
            "Eligible individuals have 60 days from the qualifying event or COBRA notice to elect continuation coverage.",
            "COBRA coverage may continue for up to 18 months following termination. Disability may extend this to 29 months.",
            "The monthly COBRA premium is 102% of the full cost of coverage including the employer and employee portions.",
            "Premiums are due monthly with a 30-day grace period. Failure to pay within the grace period terminates coverage.",
            "COBRA coverage terminates when the beneficiary becomes covered under another group plan or becomes entitled to Medicare.",
        ],
    },
    "hsa": {
        "weight": 0.05,
        "titles": [
            "HSA Basics and Eligibility",
            "HSA Contribution Limits",
            "HSA Qualified Expenses",
            "HSA Tax Advantages",
            "HSA Investment Options",
            "HSA and Medicare",
        ],
        "headings": [
            "Eligibility", "Contributions", "Qualified Expenses",
            "Tax Benefits", "Investing Your HSA", "Portability",
        ],
        "paragraphs": [
            "A Health Savings Account is a tax-advantaged savings account for employees enrolled in a qualified high deductible health plan.",
            "For 2024, IRS limits are $4,150 for individual and $8,300 for family coverage. Employees 55+ may contribute an additional $1,000.",
            "The company contributes $750 for individual and $1,500 for family coverage to each eligible employee's HSA.",
            "HSA funds may be used for deductibles, copays, dental, vision, prescriptions, and certain over-the-counter medications.",
            "HSA balances roll over year to year and are fully portable even after termination.",
            "Once the balance exceeds $2,000, participants may invest in mutual funds and ETFs through the HSA custodian.",
            "Employees enrolled in Medicare are not eligible to contribute but may use existing funds tax-free.",
        ],
    },
    "fsa": {
        "weight": 0.04,
        "titles": [
            "Healthcare FSA Overview",
            "Dependent Care FSA Guide",
            "FSA Eligible Expenses",
            "FSA Grace Period Rules",
            "Limited Purpose FSA",
        ],
        "headings": [
            "Healthcare FSA", "Dependent Care FSA", "Eligible Expenses",
            "Grace Period", "Use-It-or-Lose-It Rule",
        ],
        "paragraphs": [
            "The Healthcare FSA allows employees to set aside pre-tax dollars for eligible medical, dental, and vision expenses.",
            "The maximum annual healthcare FSA election is $3,200. Elections cannot be changed mid-year without a qualifying life event.",
            "The Dependent Care FSA allows up to $5,000 per household in pre-tax dollars for child and elder care expenses.",
            "A 2.5-month grace period allows use of remaining funds for expenses through March 15 of the subsequent year.",
            "Claims must be submitted within 90 days after plan year end. Unclaimed funds are forfeited.",
            "A Limited Purpose FSA covers only dental and vision expenses for those enrolled in an HSA-qualified HDHP.",
        ],
    },
    "wellness": {
        "weight": 0.04,
        "titles": [
            "Employee Wellness Program",
            "Wellness Incentives Guide",
            "Biometric Screening Information",
            "Employee Assistance Program (EAP)",
            "Fitness Reimbursement",
            "Tobacco Cessation Resources",
        ],
        "headings": [
            "Program Overview", "Wellness Incentives", "Biometric Screening",
            "EAP Services", "Fitness Benefits", "Tobacco Cessation",
        ],
        "paragraphs": [
            "The wellness program encourages healthy behaviors and may qualify employees for reduced medical plan premiums.",
            "Completing an annual biometric screening and health risk assessment can earn up to $500 in incentives.",
            "Biometric screenings measure blood pressure, cholesterol, blood glucose, BMI, and waist circumference.",
            "The tobacco cessation program provides free nicotine replacement therapy, counseling, and online tools.",
            "The EAP provides confidential, no-cost counseling for stress, anxiety, depression, substance abuse, and financial concerns.",
            "Fitness reimbursement of up to $50/month is available for gym memberships and qualifying fitness expenses.",
        ],
    },
    "tuition_reimbursement": {
        "weight": 0.04,
        "titles": [
            "Tuition Reimbursement Program",
            "Educational Assistance Guide",
            "Professional Certification Benefits",
            "Student Loan Repayment Benefit",
            "Approved Programs and Requirements",
        ],
        "headings": [
            "Eligibility", "Reimbursement Limits", "Approved Programs",
            "Application Process", "Repayment Obligations", "Certifications",
        ],
        "paragraphs": [
            "Tuition reimbursement is available for employees pursuing degrees at accredited institutions in fields related to their role.",
            "Full-time employees with one year of service are eligible for up to $5,250 per year. Amounts above that are taxable.",
            "Courses must be completed with a B or higher for graduate and C or higher for undergraduate programs.",
            "Applications must be submitted within 60 days of course completion with official transcripts and receipts.",
            "Employees must remain employed for 24 months following reimbursement or repay prorated benefits.",
            "Professional certification exam fees are reimbursable up to $2,000 per year with manager approval.",
        ],
    },
    "open_enrollment": {
        "weight": 0.02,
        "titles": [
            "Open Enrollment Guide",
            "What Changes During Open Enrollment",
            "Open Enrollment FAQ",
            "New Hire Enrollment Guide",
        ],
        "headings": [
            "Overview", "Timeline", "What You Can Change",
            "Qualifying Life Events", "How to Enroll",
        ],
        "paragraphs": [
            "Open enrollment is the annual period to enroll in, change, or cancel benefits elections for the upcoming plan year.",
            "The open enrollment period runs November 1 through November 30. Elections are effective January 1.",
            "Qualifying life events that permit mid-year changes include marriage, divorce, birth, adoption, and loss of other coverage.",
            "New hires must complete enrollment within 30 days of hire. Missed deadlines default to waived optional benefits.",
        ],
    },
}


def _slug(text):
    """Convert title to a URL/filename-safe slug."""
    return (
        text.lower()
        .replace(" ", "-")
        .replace("(", "")
        .replace(")", "")
        .replace("/", "-")
        .replace("'", "")
        .replace(",", "")
        .replace(":", "")
        .replace("&", "and")
        .replace("+", "plus")
        .replace("?", "")
    )


def _random_paragraphs(category_data, count):
    """Return count paragraphs, cycling through the pool with random shuffling."""
    pool_list = category_data["paragraphs"]
    paras = []
    while len(paras) < count:
        batch = pool_list[:]
        random.shuffle(batch)
        paras.extend(batch)
    return paras[:count]


def _random_headings(category_data, count):
    """Return count headings from the category pool."""
    pool_list = category_data["headings"]
    heads = []
    while len(heads) < count:
        batch = pool_list[:]
        random.shuffle(batch)
        heads.extend(batch)
    return heads[:count]


def create_web_page(title, category_key, category_data, section_count):
    """Generate a single web page with sections.
    Returns (html_content, sections_list) where sections_list is
    [{heading, text}]."""

    headings = _random_headings(category_data, section_count)
    paragraphs = _random_paragraphs(category_data, section_count * 3)
    para_idx = 0

    sections = []
    html_sections = []

    for i in range(section_count):
        heading = headings[i]
        paras_this_section = random.randint(2, 4)
        section_paras = []
        for _ in range(paras_this_section):
            if para_idx < len(paragraphs):
                section_paras.append(paragraphs[para_idx])
                para_idx += 1
            else:
                section_paras.append(random.choice(category_data["paragraphs"]))

        section_text = "\n\n".join(section_paras)
        sections.append({"heading": heading, "text": section_text})

        html_paras = "".join(f"      <p>{p}</p>\n" for p in section_paras)
        html_sections.append(
            f"    <section>\n      <h2>{heading}</h2>\n{html_paras}    </section>"
        )

    category_label = category_key.replace("_", " ").title()
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px; color: #1a1a1a; }}
    h1 {{ font-size: 24px; border-bottom: 2px solid #0969da; padding-bottom: 8px; }}
    h2 {{ font-size: 18px; color: #24292f; margin-top: 24px; }}
    p {{ line-height: 1.7; color: #424a53; }}
    .meta {{ font-size: 13px; color: #656d76; margin-bottom: 24px; }}
  </style>
</head>
<body>
  <main>
    <article>
      <h1>{title}</h1>
      <div class="meta">Category: {category_label}</div>
{chr(10).join(html_sections)}
    </article>
  </main>
</body>
</html>"""

    return html, sections


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    categories = list(CATEGORIES.keys())
    weights = [CATEGORIES[c]["weight"] for c in categories]
    total_w = sum(weights)
    weights = [w / total_w for w in weights]

    generated = 0
    seen_slugs = set()
    manifest = []

    print(f"Generating {TOTAL_PAGES} synthetic web pages in {OUTPUT_DIR} ...")

    while generated < TOTAL_PAGES:
        cat_key = random.choices(categories, weights=weights, k=1)[0]
        cat_data = CATEGORIES[cat_key]

        base_title = random.choice(cat_data["titles"])
        suffix = random.randint(100, 9999)
        title = f"{base_title} #{suffix}"
        slug = _slug(base_title) + f"-{suffix}"

        if slug in seen_slugs:
            continue
        seen_slugs.add(slug)

        domain = random.choice(DOMAINS)
        cat_slug = cat_key.replace("_", "-")
        url = f"https://{domain}/{cat_slug}/{slug}"
        filename = f"{slug}.html"

        section_count = random.randint(2, 8)
        html_content, sections = create_web_page(
            title, cat_key, cat_data, section_count
        )

        # Write HTML file
        filepath = os.path.join(OUTPUT_DIR, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(html_content)

        # Compute content hash
        all_text = "".join(s["text"] for s in sections)
        content_hash = hashlib.sha256(all_text.encode("utf-8")).hexdigest()

        manifest.append({
            "url": url,
            "domain": domain,
            "title": title,
            "category": cat_key,
            "filename": filename,
            "section_count": section_count,
            "content_hash": content_hash,
            "sections": sections,
        })

        generated += 1
        if generated % 100 == 0:
            print(f"  ... {generated}/{TOTAL_PAGES}")

    # Write manifest
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)

    print(f"Done. Generated {generated} web pages in {OUTPUT_DIR}")
    print(f"Manifest written to {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
