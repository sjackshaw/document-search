"""
Generate synthetic member benefits claims for the member-benefits-app bot.

Unlike user-search's version of this script (which sourced member identities
from netForum), this repo has no member-identity ETL line, so member
identities are synthesized locally from first/last name pools. Each generated
member gets 5-15 claims across the current and previous plan year.

Output is written to the etl-claims-line service data directory so the
isolated claims ETL container can ingest it directly.
"""

import json
import os
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path


RANDOM_SEED = 7213
MEMBER_COUNT = 1000
SERVICE_DATA_DIR = Path("services/etl-claims-line/data")

FIRST_NAMES = [
    "Emily", "Sebastian", "Sana", "Omar", "Dorothy", "Camila", "Liam", "Ava",
    "Noah", "Mia", "Ethan", "Sofia", "Lucas", "Chloe", "Mason", "Zoe", "Elijah",
    "Layla", "James", "Grace", "Benjamin", "Nora", "Henry", "Hannah", "Alexander",
    "Lily", "Michael", "Ellie", "Daniel", "Aria",
]
LAST_NAMES = [
    "Becker", "Qureshi", "Gonzalez", "Thompson", "Keita", "Neumann", "Carter",
    "Nguyen", "Patel", "Martinez", "Johnson", "Kim", "Anderson", "Rossi",
    "Muller", "OBrien", "Silva", "Novak", "Haddad", "Larsen", "Fischer",
    "Rivera", "Adeyemi", "Sato", "Kowalski", "Moreau", "Petrov", "Costa",
]
EMAIL_DOMAINS = ["members.org", "corporate.com", "company.net"]

CLAIM_TYPES = [
    ("medical", ["North Ridge Medical", "Cedar Valley Clinic", "Summit Health Partners"]),
    ("dental", ["BrightPath Dental", "Harbor Dental Group", "Oak Street Dental"]),
    ("vision", ["ClearView Optometry", "Lumen Vision Center", "Northstar Eye Care"]),
    ("rx", ["WellSpring Pharmacy", "CivicCare Rx", "Greenline Pharmacy"]),
    ("mental_health", ["Balance Behavioral Health", "Renew Counseling", "Harbor Mind Clinic"]),
]
STATUSES = ["processed", "pending", "denied", "appealed"]
EVENTS_BY_STATUS = {
    "processed": ["submitted", "adjudicated", "paid"],
    "pending": ["submitted", "in_review"],
    "denied": ["submitted", "adjudicated", "denied"],
    "appealed": ["submitted", "denied", "appealed"],
}


def generate_members(rng, count):
    members = []
    for index in range(1, count + 1):
        first_name = rng.choice(FIRST_NAMES)
        last_name = rng.choice(LAST_NAMES)
        domain = rng.choice(EMAIL_DOMAINS)
        email = f"{first_name}.{last_name}@{domain}".lower()
        members.append({
            "memberId": f"NF-{index:06d}",
            "email": email,
            "firstName": first_name,
            "lastName": last_name,
        })
    return members


def iso_date(dt):
    return dt.date().isoformat()


def iso_timestamp(dt):
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def currency(amount):
    return round(amount, 2)


def generate_claims(members, rng):
    now = datetime.now(timezone.utc)
    current_year = now.year
    claims = []
    logs = []

    for member in members:
        claim_count = rng.randint(5, 15)
        for sequence in range(1, claim_count + 1):
            claim_type, providers = rng.choice(CLAIM_TYPES)
            service_date = now - timedelta(days=rng.randint(5, 700))
            plan_year = service_date.year if service_date.year in (current_year, current_year - 1) else current_year - 1
            provider = rng.choice(providers)
            status = rng.choices(STATUSES, weights=[64, 18, 12, 6], k=1)[0]
            amount_billed = currency(rng.uniform(45, 4200))
            paid_factor = {
                "processed": rng.uniform(0.55, 0.92),
                "pending": 0,
                "denied": 0,
                "appealed": rng.uniform(0, 0.35),
            }[status]
            amount_paid = currency(amount_billed * paid_factor)
            claim_id = f"CLM-{member['memberId']}-{sequence:03d}"

            claims.append({
                "memberId": member["memberId"],
                "memberEmail": member["email"],
                "claimId": claim_id,
                "claimType": claim_type,
                "serviceDate": iso_date(service_date),
                "provider": provider,
                "amountBilled": amount_billed,
                "amountPaid": amount_paid,
                "planYear": plan_year,
                "status": status,
            })

            event_time = service_date + timedelta(days=1)
            for event in EVENTS_BY_STATUS[status]:
                notes = f"{claim_type.replace('_', ' ').title()} claim {event.replace('_', ' ')} by {provider}."
                logs.append({
                    "logTimestamp": iso_timestamp(event_time),
                    "memberId": member["memberId"],
                    "memberEmail": member["email"],
                    "claimId": claim_id,
                    "eventType": event,
                    "notes": notes,
                })
                event_time += timedelta(days=rng.randint(1, 12))

    return claims, logs


def write_json(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as target:
        json.dump(records, target, indent=2)
        target.write("\n")


def main():
    rng = random.Random(RANDOM_SEED)
    member_count = int(os.environ.get("CLAIMS_MEMBER_LIMIT", MEMBER_COUNT))
    members = generate_members(rng, member_count)

    claims, logs = generate_claims(members, rng)
    write_json(SERVICE_DATA_DIR / "primary.json", claims)
    write_json(SERVICE_DATA_DIR / "logs.json", logs)
    print(f"Generated {len(claims)} claims and {len(logs)} log events from {len(members)} synthetic members.")


if __name__ == "__main__":
    main()
