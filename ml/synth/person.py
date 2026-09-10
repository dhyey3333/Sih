"""One coherent fake identity per page.

Pages have to be internally consistent — the name in the header, the name on the ID
card and the name on the card all being the same person is what a real screen looks
like, and it is also what exercises the extension's value-deduplication (the same
value should collapse to one token wherever it appears).
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from faker import Faker

from . import fakes


@dataclass
class Person:
    name: str
    email: str
    phone: str
    dob: str
    address: str
    city: str
    pincode: str
    aadhaar: str
    pan: str
    passport: str
    ifsc: str
    upi: str
    account: str
    card: str
    cvv: str
    card_expiry: str
    otp: str
    username: str
    company: str
    #: Values that must NOT be detected, for the precision half of the dataset.
    decoys: list[str] = field(default_factory=list)


def make_person(rng: random.Random, faker: Faker) -> Person:
    name = faker.name()
    first = name.split()[0].lower()
    surname = name.split()[-1].lower()

    return Person(
        name=name,
        email=f"{first}.{surname}{rng.randint(1, 99)}@{rng.choice(('example.com', 'example.org', 'mail.example.in', 'test.example.co.in'))}",
        phone=fakes.fake_phone(rng, with_code=rng.random() < 0.25),
        dob=fakes.fake_dob(rng),
        address=faker.street_address().replace("\n", ", "),
        city=faker.city(),
        pincode=fakes.fake_pincode(rng),
        aadhaar=fakes.fake_aadhaar(rng, spaced=rng.random() < 0.8),
        pan=fakes.fake_pan(rng),
        passport=fakes.fake_passport(rng),
        ifsc=fakes.fake_ifsc(rng),
        upi=fakes.fake_upi(rng, name),
        account=fakes.fake_account_number(rng),
        card=fakes.fake_card(rng, grouped=rng.random() < 0.85),
        cvv=fakes.fake_cvv(rng),
        card_expiry=f"{rng.randint(1, 12):02d}/{rng.randint(27, 34)}",
        otp=fakes.fake_otp(rng),
        username=f"{first}{rng.randint(1, 9999)}",
        company=faker.company(),
        decoys=[fakes.decoy_number(rng) for _ in range(rng.randint(2, 5))],
    )
