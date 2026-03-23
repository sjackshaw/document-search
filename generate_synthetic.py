#!/usr/bin/env python3
"""
Generate 1,500 synthetic PDF documents (3-10 pages each) containing
benefits-related language across multiple categories.

Usage:
    pip install fpdf2
    python generate_synthetic.py

Output:
    services/etl-documents/data/pdfs/<category>_<title>.pdf
"""

import os
import random
import textwrap
from fpdf import FPDF

import json

random.seed(42)

OUTPUT_DIR = os.path.join(
    os.path.dirname(__file__), "services", "etl-documents", "data", "pdfs"
)
MANIFEST_PATH = os.path.join(
    os.path.dirname(__file__), "services", "etl-documents", "data", "manifest.json"
)
TOTAL_DOCUMENTS = 1500

# ── Category definitions with realistic content templates ──────────────

CATEGORIES = {
    "health_insurance": {
        "weight": 0.15,
        "titles": [
            "PPO Plan Summary", "HMO Plan Details", "High Deductible Health Plan",
            "Preferred Provider Organization Guide", "Health Plan Comparison",
            "Annual Benefits Summary", "Medical Coverage Overview",
            "In-Network Provider Guide", "Out-of-Pocket Maximum Explanation",
            "Preventive Care Benefits", "Specialist Referral Policy",
            "Emergency Room Coverage", "Prescription Drug Coverage Tier List",
            "Mental Health Parity Notice", "Telehealth Services Guide",
            "Prior Authorization Requirements", "Claims Filing Procedures",
            "Coordination of Benefits Policy", "Dependent Coverage Rules",
            "Coverage During Leave of Absence",
        ],
        "paragraphs": [
            "This group health insurance plan provides comprehensive medical coverage for eligible employees and their qualified dependents. Coverage begins on the first day of the month following thirty days of continuous employment.",
            "The annual deductible for individual coverage is $1,500 for in-network services and $3,000 for out-of-network services. Family deductible amounts are two times the individual amounts.",
            "Preventive care services, including annual physicals, immunizations, and age-appropriate screenings, are covered at 100% when performed by an in-network provider with no deductible required.",
            "After meeting the annual deductible, the plan pays 80% of covered in-network charges and 60% of covered out-of-network charges. The member is responsible for the remaining coinsurance.",
            "The out-of-pocket maximum limits the total amount you pay for covered services in a plan year. For individual coverage, the in-network out-of-pocket maximum is $6,500. For family coverage, the limit is $13,000.",
            "Emergency room visits are covered at in-network rates regardless of facility location. A $250 copay applies per visit and is waived if the member is admitted to the hospital.",
            "Mental health and substance abuse treatment services are provided in accordance with federal mental health parity requirements. Inpatient and outpatient services are covered under the same terms as medical/surgical benefits.",
            "Prior authorization is required for all inpatient hospital admissions, outpatient surgical procedures, advanced imaging studies (MRI, CT, PET scans), and specialty medications.",
            "Prescription drugs are covered under a four-tier formulary. Generic drugs require a $10 copay, preferred brand-name drugs require a $35 copay, non-preferred brands require a $60 copay, and specialty drugs require 25% coinsurance up to $250 per fill.",
            "Members may continue coverage under COBRA for up to 18 months following a qualifying event such as termination of employment or reduction in work hours.",
            "Telemedicine consultations are available 24/7 through the plan's designated virtual care platform. Office visit copays apply to scheduled telehealth appointments with in-network providers.",
            "Well-child visits are covered at no cost to the member through age 18, including all recommended vaccinations per the CDC immunization schedule.",
            "The plan includes coverage for maternity care, including prenatal visits, delivery, and postnatal care. A hospital stay of up to 48 hours for vaginal delivery and 96 hours for cesarean section is covered.",
            "Durable medical equipment such as wheelchairs, hospital beds, and oxygen equipment is covered at 80% after deductible when deemed medically necessary by the treating physician.",
            "Physical therapy, occupational therapy, and speech therapy services are covered for up to 60 visits per plan year combined when prescribed by a physician and performed by a licensed therapist.",
        ],
    },
    "dental": {
        "weight": 0.10,
        "titles": [
            "Dental PPO Plan Summary", "Dental HMO Benefits Guide",
            "Orthodontic Coverage Policy", "Dental Preventive Care Schedule",
            "Dental Claims Procedures", "Dental Fee Schedule",
            "Dental Network Provider List", "Dental Waiting Period Policy",
            "Dental Annual Maximum Benefit", "Dental Implant Coverage Policy",
            "Pediatric Dental Benefits", "Dental Emergency Coverage",
            "Cosmetic Dentistry Exclusions", "Dental Coordination of Benefits",
            "Dental Plan Comparison Chart",
        ],
        "paragraphs": [
            "The dental plan provides coverage for preventive, basic, and major dental services. Preventive services are covered at 100%, basic services at 80%, and major services at 50% after the annual deductible.",
            "The annual deductible is $50 per individual and $150 per family. The deductible does not apply to preventive services including routine cleanings, exams, and bitewing X-rays.",
            "The annual maximum benefit is $2,000 per covered individual. Orthodontic benefits have a separate lifetime maximum of $2,500 for dependents under age 19.",
            "Preventive care includes two routine cleanings per year, one comprehensive oral exam, one set of bitewing X-rays, and one panoramic X-ray every three years.",
            "Basic services include fillings (amalgam and composite), simple extractions, periodontal scaling and root planing, and endodontic treatment on permanent teeth.",
            "Major services include crowns, bridges, dentures, dental implants, and oral surgery requiring general anesthesia. A 12-month waiting period applies to major services for new enrollees.",
            "Orthodontic treatment is covered only for dependent children under age 19 with a documented malocclusion severity index score. Adult orthodontia is not covered under this plan.",
            "Emergency dental treatment for accidental injury to natural teeth is covered at 80% with no waiting period, provided treatment begins within 72 hours of the accident.",
            "Dental sealants are covered at 100% for children ages 6 through 14 on permanent molars only. Each tooth is eligible for sealant coverage once.",
            "Fluoride treatments are covered at 100% for children under age 16, limited to two applications per plan year during routine preventive visits.",
            "Dental implant placement and associated abutment and crown are covered at 50% after a 12-month waiting period, subject to the annual maximum benefit.",
            "Teeth whitening, cosmetic bonding, and other elective cosmetic dental procedures are not covered under this dental plan.",
        ],
    },
    "vision": {
        "weight": 0.08,
        "titles": [
            "Vision Plan Summary", "VSP Coverage Details",
            "Eyeglass Frame Allowance Policy", "Contact Lens Benefit Overview",
            "Pediatric Vision Benefits", "Vision Network Provider Directory",
            "LASIK Discount Program", "Vision Claims Filing Guide",
            "Vision Hardware Benefit Schedule", "Routine Eye Exam Coverage",
        ],
        "paragraphs": [
            "The vision plan covers one comprehensive eye exam per plan year with a $10 copay when using an in-network provider. Out-of-network exams are reimbursed up to $50.",
            "Eyeglass lenses are covered in full for single vision, bifocal, or progressive lenses once every 12 months. Lens enhancements such as anti-reflective coating and photochromic lenses are available at a discount.",
            "The plan provides a $200 allowance toward eyeglass frames from an in-network provider once every 24 months. Any amount exceeding the allowance is the member's responsibility.",
            "Contact lenses are covered as an alternative to eyeglasses. The plan provides up to $150 toward contact lens materials and a contact lens fitting exam with a $60 copay.",
            "Medically necessary contact lenses are covered in full when prescribed for conditions such as keratoconus, aphakia, or anisometropia.",
            "Pediatric vision coverage includes annual comprehensive eye exams and one pair of eyeglasses per year for dependent children through age 18.",
            "LASIK and PRK refractive surgery are not covered under the standard vision plan but are available at a negotiated discount of 15-20% through participating laser vision correction centers.",
            "Sunglasses with prescription lenses can be obtained using the frame allowance benefit once every 24 months in lieu of regular eyeglasses.",
            "Blue light filtering lenses and digital screen protection coatings are available as add-on options at reduced member pricing through in-network optical retailers.",
            "Replacement of lost or broken eyeglasses outside the benefit cycle is not covered. Members are responsible for the full cost of replacement materials.",
        ],
    },
    "life_insurance": {
        "weight": 0.08,
        "titles": [
            "Basic Life Insurance Summary", "Supplemental Life Insurance Guide",
            "AD&D Coverage Details", "Beneficiary Designation Form Instructions",
            "Life Insurance Portability Options", "Dependent Life Insurance Coverage",
            "Evidence of Insurability Requirements", "Life Insurance Conversion Rights",
            "Accelerated Death Benefit Provision", "Life Insurance Imputed Income Notice",
        ],
        "paragraphs": [
            "The company provides basic life insurance coverage at no cost to eligible employees. The benefit amount is equal to one times the employee's annual base salary, rounded to the nearest $1,000, up to a maximum of $500,000.",
            "Accidental death and dismemberment (AD&D) coverage is included with the basic life insurance benefit at the same coverage amount. AD&D pays an additional benefit if death results from a covered accident.",
            "Supplemental life insurance is available for purchase at group rates. Employees may elect coverage in increments of $10,000 up to five times their annual salary, not to exceed $1,000,000.",
            "Dependent life insurance is available for spouses/domestic partners (up to $250,000) and children ($10,000 per child from live birth to age 26).",
            "Employees electing supplemental life insurance coverage above the guaranteed issue amount of $200,000 must provide satisfactory evidence of insurability.",
            "The life insurance benefit includes an accelerated death benefit provision, which allows terminally ill participants to receive up to 75% of their benefit while living.",
            "Upon termination of employment, employees may convert their group life insurance to an individual policy without evidence of insurability, provided application is made within 31 days.",
            "The portability option allows terminated employees to continue their group supplemental life insurance coverage by paying premiums directly to the carrier.",
            "Imputed income for employer-paid life insurance coverage exceeding $50,000 is taxable and will be reported on the employee's W-2 form.",
            "Beneficiary designations should be reviewed annually and updated following major life events such as marriage, divorce, birth, or adoption.",
        ],
    },
    "disability": {
        "weight": 0.08,
        "titles": [
            "Short-Term Disability Plan Summary", "Long-Term Disability Coverage Guide",
            "Disability Claims Process", "Return to Work Program",
            "Disability Benefit Calculation", "Disability Elimination Period Details",
            "Disability and FMLA Coordination", "Disability Pre-Existing Condition Clause",
            "Disability Partial Benefits Policy", "Disability Rehabilitation Services",
        ],
        "paragraphs": [
            "Short-term disability (STD) benefits replace 60% of weekly base earnings for up to 26 weeks following a 7-day elimination period for illness or a 0-day elimination period for accidental injury.",
            "Long-term disability (LTD) coverage provides 60% of monthly pre-disability earnings, up to a maximum monthly benefit of $15,000, beginning after the short-term disability benefit period ends.",
            "The LTD benefit is payable to age 65 for disabilities that commence before age 60. For disabilities beginning at age 60 or later, benefits are payable for a reduced duration per the plan schedule.",
            "A pre-existing condition limitation applies to LTD benefits. Conditions for which treatment was received in the 3 months prior to the effective date of coverage are excluded for the first 12 months.",
            "Disability benefits are offset by any income received from Social Security disability, workers' compensation, state disability programs, or retirement benefits attributable to employer contributions.",
            "The plan includes a rehabilitation incentive benefit that provides an additional 5% of pre-disability earnings during participation in an approved vocational rehabilitation program.",
            "Partial disability benefits are available for employees who can work in a reduced capacity. The benefit is calculated as the difference between 60% of pre-disability earnings and current earnings.",
            "Pregnancy-related disability is covered under the same terms as any other disability. The standard elimination period and benefit percentage apply.",
            "Employees must submit a completed disability claim form along with supporting medical documentation within 30 days of the onset of disability to avoid delays in benefit processing.",
            "The definition of disability changes after 24 months of benefit payments from 'own occupation' to 'any occupation' for which the employee is qualified by education, training, or experience.",
        ],
    },
    "retirement": {
        "weight": 0.12,
        "titles": [
            "401(k) Plan Summary Description", "Roth 401(k) Contribution Guide",
            "Employer Match Policy", "Vesting Schedule",
            "Retirement Plan Loan Provisions", "Hardship Withdrawal Rules",
            "Required Minimum Distribution Notice", "Retirement Plan Investment Options",
            "Catch-Up Contribution Rules", "Retirement Plan Rollover Guide",
            "Automatic Enrollment Notice", "Retirement Plan Fee Disclosure",
            "Plan Amendment Summary", "QDIA Investment Default Policy",
            "Retirement Income Planning Guide",
        ],
        "paragraphs": [
            "The company sponsors a 401(k) retirement savings plan that allows eligible employees to defer a portion of their compensation on a pre-tax or Roth after-tax basis.",
            "Employees are eligible to participate in the 401(k) plan on the first day of the month following 60 days of employment. Automatic enrollment at a 6% deferral rate applies unless the employee elects otherwise.",
            "The company provides a matching contribution of 100% on the first 3% of eligible compensation deferred and 50% on the next 2%, for a maximum employer match of 4% of eligible compensation.",
            "Employee contributions are 100% vested immediately. Employer matching contributions vest according to a 3-year graded vesting schedule: 33% after year 1, 67% after year 2, and 100% after year 3.",
            "The annual IRS contribution limit for employee deferrals is $23,000 for 2024. Employees age 50 and older may make additional catch-up contributions of $7,500 per year.",
            "Plan participants may take a loan from their vested account balance. The minimum loan amount is $1,000 and the maximum is the lesser of 50% of the vested balance or $50,000.",
            "Hardship withdrawals are available for immediate and heavy financial needs including medical expenses, tuition, purchase of a principal residence, funeral expenses, and prevention of eviction.",
            "The plan offers a diversified menu of investment options including target-date funds, index funds, actively managed funds, a stable value fund, and a self-directed brokerage window.",
            "Target-date funds are the plan's qualified default investment alternative (QDIA). Automatically enrolled participants who do not make an investment election will be invested in the target-date fund closest to their projected retirement year.",
            "Required minimum distributions (RMDs) must begin by April 1 of the year following the year the participant reaches age 73, unless the participant is still employed.",
            "Rollovers from other qualified plans and traditional IRAs are accepted at any time. Roth rollovers from designated Roth accounts in other employer plans are also permitted.",
            "Total plan fees, including investment management fees, recordkeeping charges, and administrative expenses, are disclosed annually in the plan's fee disclosure notice.",
            "Participants should review their investment allocations and contribution rates at least annually, especially following significant life changes or market conditions.",
            "The plan offers both traditional pre-tax and Roth after-tax contribution options. Participants may split their deferral between both types up to the combined annual limit.",
            "Upon termination, participants with a vested balance over $7,000 may leave their balance in the plan, roll it over to another qualified plan or IRA, or take a taxable distribution.",
        ],
    },
    "paid_time_off": {
        "weight": 0.08,
        "titles": [
            "PTO Policy Overview", "Vacation Accrual Schedule",
            "Sick Leave Policy", "Holiday Schedule",
            "PTO Carry-Over and Payout Policy", "Bereavement Leave Policy",
            "Jury Duty Leave", "Voting Leave Policy",
            "Personal Day Policy", "PTO Donation Program",
        ],
        "paragraphs": [
            "Full-time employees accrue paid time off (PTO) on a bi-weekly basis. Accrual rates increase with years of service: 0-2 years receive 15 days, 3-5 years receive 20 days, and 6+ years receive 25 days annually.",
            "PTO may be used for any purpose including vacation, personal time, or illness. Requests for planned PTO should be submitted at least two weeks in advance through the self-service portal.",
            "Employees may carry over a maximum of 40 hours of unused PTO into the next calendar year. Unused PTO above the carry-over limit will be forfeited on December 31.",
            "Upon separation from employment, employees will be paid for accrued but unused PTO at their current base rate of pay, up to the maximum accrual cap.",
            "The company observes 11 paid holidays per year: New Year's Day, Martin Luther King Jr. Day, Presidents' Day, Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus Day, Veterans Day, Thanksgiving Day, and Christmas Day.",
            "Bereavement leave of up to 5 days is provided for the death of an immediate family member (spouse, child, parent, sibling). Up to 3 days are provided for extended family members.",
            "Employees called for jury duty will receive full pay for up to 10 business days. If jury service extends beyond 10 days, unpaid leave will be granted for the duration.",
            "Sick leave may be used for the employee's own illness or injury, medical appointments, or to care for an immediate family member. A doctor's note is required for absences exceeding 3 consecutive days.",
            "The PTO donation program allows employees to voluntarily transfer accrued PTO hours to a colleague who has exhausted their own leave due to a serious medical condition.",
            "Part-time employees working 20 or more hours per week accrue PTO on a prorated basis relative to their scheduled hours.",
        ],
    },
    "fmla": {
        "weight": 0.07,
        "titles": [
            "FMLA Rights and Responsibilities", "FMLA Eligibility Requirements",
            "FMLA Leave Request Procedures", "Military Family Leave Provisions",
            "FMLA and Disability Coordination", "FMLA Medical Certification Guide",
            "Intermittent FMLA Leave Policy", "FMLA Return to Work Policy",
            "Parental Leave Under FMLA", "FMLA Benefits Continuation",
        ],
        "paragraphs": [
            "The Family and Medical Leave Act (FMLA) provides eligible employees with up to 12 weeks of unpaid, job-protected leave during a 12-month period for qualifying family and medical reasons.",
            "To be eligible for FMLA leave, an employee must have worked for the company for at least 12 months, have worked at least 1,250 hours during the 12 months prior to the start of leave, and work at a location with 50 or more employees within 75 miles.",
            "Qualifying reasons for FMLA leave include: the birth and care of a newborn child, placement of a child for adoption or foster care, care of an immediate family member with a serious health condition, and the employee's own serious health condition.",
            "Employees requesting foreseeable FMLA leave must provide at least 30 days' advance notice. For unforeseeable leave, notice must be given as soon as practicable.",
            "Medical certification from a healthcare provider is required for FMLA leave due to a serious health condition. The certification must be submitted within 15 calendar days of the request.",
            "Intermittent FMLA leave may be taken in separate blocks of time for a single qualifying reason. Employees on intermittent leave must make reasonable efforts to schedule treatment so as not to unduly disrupt business operations.",
            "During FMLA leave, the company will maintain the employee's group health insurance coverage under the same terms as if the employee were actively working. The employee must continue to pay their share of premiums.",
            "Upon return from FMLA leave, the employee will be restored to the same or an equivalent position with equivalent pay, benefits, and other terms and conditions of employment.",
            "Military caregiver leave under FMLA provides up to 26 weeks of leave during a single 12-month period to care for a covered servicemember with a serious injury or illness.",
            "Qualifying exigency leave is available for up to 12 weeks when a family member is on active duty or called to active duty in the Armed Forces for eligible activities such as childcare arrangements, financial and legal matters, and rest and recuperation.",
        ],
    },
    "cobra": {
        "weight": 0.05,
        "titles": [
            "COBRA General Notice", "COBRA Election Notice",
            "COBRA Premium Schedule", "COBRA Qualifying Events Guide",
            "COBRA Rights for Dependents", "COBRA and Medicare Coordination",
            "COBRA Continuation Coverage Timeline", "COBRA Premium Payment Procedures",
        ],
        "paragraphs": [
            "The Consolidated Omnibus Budget Reconciliation Act (COBRA) provides continuation of group health plan coverage that otherwise would be lost due to certain qualifying events.",
            "Qualifying events that trigger COBRA eligibility include: voluntary or involuntary termination of employment (other than for gross misconduct), reduction in work hours, divorce or legal separation, death of the covered employee, and a dependent child losing eligibility.",
            "Eligible individuals have 60 days from the date of the qualifying event or the date of the COBRA election notice, whichever is later, to elect continuation coverage.",
            "COBRA coverage may continue for up to 18 months following termination of employment or reduction in hours. An additional 11 months (29 months total) may be available if the qualified beneficiary is determined to be disabled.",
            "The monthly COBRA premium is 102% of the full cost of coverage (employer and employee portions combined). The 2% administrative fee is permitted under COBRA regulations.",
            "COBRA premiums must be paid monthly and are due on the first of each month. A 30-day grace period applies to each monthly payment. Failure to pay within the grace period will result in termination of coverage.",
            "Second qualifying events (such as divorce, death of the employee, or Medicare entitlement) may extend the maximum COBRA coverage period to 36 months for qualified beneficiaries other than the employee.",
            "COBRA coverage terminates when the qualified beneficiary becomes covered under another group health plan, becomes entitled to Medicare, fails to pay premiums timely, or the employer ceases to maintain any group health plan.",
        ],
    },
    "hsa": {
        "weight": 0.05,
        "titles": [
            "HSA Eligibility and Contribution Guide", "HSA Investment Options",
            "HSA Qualified Medical Expenses", "HSA Tax Advantages Overview",
            "HSA Employer Contribution Policy", "HSA Rollover and Portability",
            "HSA and Medicare Coordination", "HSA Beneficiary Designation",
        ],
        "paragraphs": [
            "A Health Savings Account (HSA) is a tax-advantaged savings account available to employees enrolled in a qualified high deductible health plan (HDHP). Contributions, earnings, and withdrawals for qualified expenses are all tax-free.",
            "For 2024, the IRS contribution limits are $4,150 for individual HDHP coverage and $8,300 for family HDHP coverage. Employees age 55 and older may contribute an additional $1,000 catch-up contribution.",
            "The company contributes $750 for individual coverage and $1,500 for family coverage annually to each eligible employee's HSA. Employer contributions count toward the annual IRS limit.",
            "HSA funds may be used to pay for qualified medical expenses including deductibles, copays, coinsurance, dental care, vision care, prescription drugs, and certain over-the-counter medications.",
            "Unlike flexible spending accounts, HSA balances roll over from year to year and are fully portable. The account belongs to the employee even after termination of employment.",
            "Once the HSA balance exceeds $2,000, participants may invest the excess in a selection of mutual funds and ETFs offered through the HSA custodian's investment platform.",
            "HSA distributions used for non-qualified expenses are subject to income tax plus a 20% penalty for individuals under age 65. After age 65, non-qualified distributions are subject to income tax only.",
            "Employees enrolled in Medicare Part A or Part B are not eligible to contribute to an HSA. Existing HSA funds may still be used for qualified medical expenses tax-free.",
        ],
    },
    "fsa": {
        "weight": 0.04,
        "titles": [
            "Healthcare FSA Plan Summary", "Dependent Care FSA Guide",
            "FSA Eligible Expenses List", "FSA Grace Period and Run-Out Policy",
            "FSA Enrollment and Election Changes", "Limited Purpose FSA Overview",
        ],
        "paragraphs": [
            "The Healthcare Flexible Spending Account (FSA) allows employees to set aside pre-tax dollars to pay for eligible out-of-pocket medical, dental, and vision expenses not covered by insurance.",
            "The maximum annual healthcare FSA election for 2024 is $3,200. Elections are made during open enrollment and cannot be changed mid-year unless the employee experiences a qualifying life event.",
            "The Dependent Care FSA allows employees to set aside up to $5,000 per household (or $2,500 if married filing separately) in pre-tax dollars for eligible child and elder care expenses.",
            "A 2.5-month grace period extends into the following year, allowing participants to use remaining FSA funds for expenses incurred through March 15 of the subsequent plan year.",
            "Claims for FSA reimbursement must be submitted within 90 days after the end of the plan year (run-out period). Unclaimed funds after the run-out period are forfeited under the use-it-or-lose-it rule.",
            "Employees enrolled in an HSA-qualified HDHP may participate in a Limited Purpose FSA, which covers only dental and vision expenses until the HDHP deductible is met.",
        ],
    },
    "wellness": {
        "weight": 0.04,
        "titles": [
            "Employee Wellness Program Overview", "Wellness Incentive Program Guide",
            "Biometric Screening Requirements", "Tobacco Cessation Program",
            "Employee Assistance Program (EAP)", "Fitness Reimbursement Policy",
        ],
        "paragraphs": [
            "The company's wellness program encourages employees to adopt and maintain healthy behaviors. Participation in the program may qualify employees for reduced medical plan premiums.",
            "Employees who complete an annual biometric screening and health risk assessment may earn up to $500 in wellness incentives applied as a premium reduction to their medical plan.",
            "Biometric screenings measure blood pressure, cholesterol, blood glucose, BMI, and waist circumference. Screenings are offered on-site during scheduled events or at participating lab facilities.",
            "The tobacco cessation program provides free nicotine replacement therapy, counseling sessions, and online support tools. Employees who complete the program receive a $200 wellness incentive.",
            "The Employee Assistance Program (EAP) provides confidential, no-cost counseling and referral services for personal and work-related concerns including stress, anxiety, depression, substance abuse, and financial difficulties.",
            "Fitness reimbursement of up to $50 per month is available for eligible gym memberships, fitness classes, and qualifying home exercise equipment purchases with proof of regular participation.",
        ],
    },
    "tuition_reimbursement": {
        "weight": 0.04,
        "titles": [
            "Tuition Reimbursement Policy", "Educational Assistance Program Guide",
            "Approved Degree Programs List", "Tuition Reimbursement Application Process",
            "Professional Certification Reimbursement", "Student Loan Repayment Benefit",
        ],
        "paragraphs": [
            "The company provides tuition reimbursement for eligible employees pursuing undergraduate or graduate degrees at accredited institutions in fields related to their current role or career path within the organization.",
            "Full-time employees with at least one year of service are eligible for up to $5,250 per calendar year in tuition reimbursement. Amounts exceeding $5,250 are treated as taxable income.",
            "To qualify for reimbursement, courses must be completed with a grade of B or higher for graduate programs and C or higher for undergraduate programs.",
            "Reimbursement applications must be submitted within 60 days of course completion along with official transcripts and receipts for tuition and required fees. Books and supplies are not eligible.",
            "Employees who receive tuition reimbursement must remain employed for 24 months following the last reimbursement payment. Early departure requires prorated repayment of benefits received in the prior 24 months.",
            "Professional certification exam fees and study materials are reimbursable up to $2,000 per year for certifications directly relevant to the employee's role, subject to manager approval.",
        ],
    },
    "open_enrollment": {
        "weight": 0.02,
        "titles": [
            "Open Enrollment Guide", "Benefits Election Change Form",
            "Open Enrollment FAQ", "New Hire Benefits Enrollment",
        ],
        "paragraphs": [
            "Open enrollment is the annual period during which eligible employees may enroll in, change, or cancel their benefits elections for the upcoming plan year without a qualifying life event.",
            "The open enrollment period runs from November 1 through November 30. Elections made during this period are effective January 1 of the following plan year.",
            "Qualifying life events that permit mid-year changes include marriage, divorce, birth or adoption of a child, loss of other coverage, and changes in employment status.",
            "New hires must complete benefits enrollment within 30 days of their date of hire. Elections not made within this window will default to waived coverage for all optional benefits.",
        ],
    },
}


def _slug(text):
    """Convert title to a filename-safe slug."""
    return text.lower().replace(" ", "_").replace("(", "").replace(")", "").replace("/", "_").replace("'", "").replace(",", "")


def _random_paragraphs(category_data, count):
    """Return *count* paragraphs, cycling through the pool with random shuffling."""
    pool = category_data["paragraphs"]
    paras = []
    while len(paras) < count:
        batch = pool[:]
        random.shuffle(batch)
        paras.extend(batch)
    return paras[:count]


def create_pdf(filepath, title, category_key, category_data, page_count):
    """Generate a single PDF with the given number of pages of benefits content.
    Returns the page texts for the manifest."""
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)

    paragraphs = _random_paragraphs(category_data, page_count * 4)
    para_idx = 0
    page_texts = []

    for page_num in range(page_count):
        pdf.add_page()
        page_content = []

        if page_num == 0:
            # Title page header
            pdf.set_font("Helvetica", "B", 18)
            pdf.cell(0, 12, title, new_x="LMARGIN", new_y="NEXT", align="C")
            pdf.ln(4)
            pdf.set_font("Helvetica", "I", 11)
            pdf.cell(
                0, 8,
                f"Category: {category_key.replace('_', ' ').title()}",
                new_x="LMARGIN", new_y="NEXT", align="C",
            )
            pdf.ln(6)
            page_content.append(title)
            page_content.append(f"Category: {category_key.replace('_', ' ').title()}")
        else:
            pdf.set_font("Helvetica", "B", 13)
            section_label = f"Section {page_num}: {title} (continued)"
            pdf.cell(0, 10, section_label, new_x="LMARGIN", new_y="NEXT")
            pdf.ln(3)
            page_content.append(section_label)

        pdf.set_font("Helvetica", "", 10)
        # 3-5 paragraphs per page
        paras_this_page = random.randint(3, 5)
        for _ in range(paras_this_page):
            if para_idx < len(paragraphs):
                text = paragraphs[para_idx]
                para_idx += 1
            else:
                text = random.choice(category_data["paragraphs"])
            pdf.multi_cell(0, 5, text)
            pdf.ln(3)
            page_content.append(text)

        # Footer
        pdf.set_y(-20)
        pdf.set_font("Helvetica", "I", 8)
        pdf.cell(0, 8, f"Page {page_num + 1} of {page_count}", align="C")

        page_texts.append("\n\n".join(page_content))

    pdf.output(filepath)
    return page_texts


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Build weighted category list
    categories = list(CATEGORIES.keys())
    weights = [CATEGORIES[c]["weight"] for c in categories]

    # Normalise weights so they sum to 1
    total_w = sum(weights)
    weights = [w / total_w for w in weights]

    generated = 0
    seen_filenames = set()
    manifest = []

    print(f"Generating {TOTAL_DOCUMENTS} synthetic benefit PDFs in {OUTPUT_DIR} ...")

    while generated < TOTAL_DOCUMENTS:
        cat_key = random.choices(categories, weights=weights, k=1)[0]
        cat_data = CATEGORIES[cat_key]

        # Pick a title, optionally append a numeric suffix to ensure uniqueness
        base_title = random.choice(cat_data["titles"])
        suffix = random.randint(1000, 9999)
        title = f"{base_title} {suffix}"
        filename = f"{cat_key}_{_slug(base_title)}_{suffix}.pdf"

        if filename in seen_filenames:
            continue
        seen_filenames.add(filename)

        page_count = random.randint(3, 10)
        filepath = os.path.join(OUTPUT_DIR, filename)
        page_texts = create_pdf(filepath, title, cat_key, cat_data, page_count)

        manifest.append({
            "filename": filename,
            "title": title,
            "category": cat_key,
            "page_count": page_count,
            "pages": page_texts,
        })

        generated += 1
        if generated % 100 == 0:
            print(f"  ... {generated}/{TOTAL_DOCUMENTS}")

    # Write manifest with pre-extracted text
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)

    print(f"Done. Generated {generated} PDFs in {OUTPUT_DIR}")
    print(f"Manifest written to {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
