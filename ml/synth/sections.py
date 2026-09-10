"""Page sections.

Each builder returns an HTML fragment. Sensitive elements carry `data-pii="TYPE"`
and interactive ones `data-ui="input|button|password"` — the same annotation the
demo site uses, so one extractor serves both the training labels and the eval
ground truth, and the two can never drift apart.

Variety comes from composition and randomised styling rather than from hand-writing
thirty fixed pages: a fixed page teaches the model that page.
"""

from __future__ import annotations

import html
import random
from typing import Callable

from . import assets
from .person import Person

Section = Callable[[random.Random, Person], str]


def esc(value: str) -> str:
    return html.escape(str(value))


def field(rng: random.Random, label: str, value: str, pii: str | None, kind: str = "text") -> str:
    """A labelled input. Half the time the label is a <label for>, half a bare div —
    real forms are inconsistent, and the model should not rely on one shape."""
    ui = "password" if kind == "password" else "input"
    pii_attr = f' data-pii="{pii}"' if pii else ""
    name = label.lower().replace(" ", rng.choice(("_", "-", "")))
    input_html = (
        f'<input type="{kind}" name="{esc(name)}" value="{esc(value)}"'
        f' data-ui="{ui}"{pii_attr} />'
    )
    if rng.random() < 0.5:
        return f'<label class="f"><span class="lbl">{esc(label)}</span>{input_html}</label>'
    return f'<div class="f"><div class="lbl">{esc(label)}</div>{input_html}</div>'


def button(rng: random.Random, text: str, primary: bool = False) -> str:
    cls = "btn primary" if primary else "btn"
    tag = rng.choice(("button", "a")) if not primary else "button"
    if tag == "a":
        return f'<a href="#" class="{cls}" data-ui="button">{esc(text)}</a>'
    return f'<button type="button" class="{cls}" data-ui="button">{esc(text)}</button>'


def row(label: str, value: str, pii: str | None = None) -> str:
    pii_attr = f' data-pii="{pii}"' if pii else ""
    return f'<div class="row"><span class="k">{esc(label)}</span><span class="v"{pii_attr}>{esc(value)}</span></div>'


# --- headers -----------------------------------------------------------------


def header(rng: random.Random, p: Person) -> str:
    title = rng.choice(
        ("National Portal", "SecureBank", "PayFlow", "GovServices", esc(p.company), "MyAccount", "CityUtilities")
    )
    avatar = (
        f'<img class="avatar-sm" src="{assets.avatar_svg(rng)}" alt="Profile" />'
        if rng.random() < 0.6
        else ""
    )
    nav = "".join(
        f'<a href="#" data-ui="button">{esc(t)}</a>'
        for t in rng.sample(["Home", "Accounts", "Transfer", "Cards", "Help", "Settings", "Profile"], k=rng.randint(3, 5))
    )
    return f'<header class="hdr"><div class="brand">{title}</div><nav>{nav}</nav>{avatar}</header>'


# --- forms -------------------------------------------------------------------


def login_form(rng: random.Random, p: Person) -> str:
    identifier = rng.choice((p.email, p.username, p.phone))
    pii = "EMAIL" if identifier == p.email else ("PHONE" if identifier == p.phone else None)
    return f"""<section class="card"><h2>{esc(rng.choice(('Sign in', 'Log in', 'Member login')))}</h2>
{field(rng, rng.choice(('Email address', 'Username', 'Email or mobile')), identifier, pii)}
{field(rng, rng.choice(('Password', 'Passcode')), 'correct-horse-battery', 'PASSWORD', 'password')}
<div class="actions">{button(rng, 'Sign in', True)}{button(rng, 'Forgot password?')}</div></section>"""


def kyc_form(rng: random.Random, p: Person) -> str:
    rows = [
        field(rng, "Full name", p.name, "NAME"),
        field(rng, rng.choice(("Aadhaar number", "Aadhaar / UID", "UID")), p.aadhaar, "AADHAAR"),
        field(rng, "PAN", p.pan, "PAN"),
        field(rng, "Date of birth", p.dob, "DOB"),
        field(rng, "Mobile number", p.phone, "PHONE"),
        field(rng, "Email address", p.email, "EMAIL"),
        field(rng, "Residential address", p.address, "ADDRESS"),
        field(rng, "PIN code", p.pincode, "PINCODE"),
    ]
    if rng.random() < 0.4:
        rows.append(field(rng, "Passport number", p.passport, "PASSPORT"))
    if rng.random() < 0.3:
        rows.append(field(rng, "Reference code", rng.choice(p.decoys), None))
    rng.shuffle(rows)
    return f"""<section class="card"><h2>{esc(rng.choice(('KYC verification', 'Identity details', 'Applicant details')))}</h2>
<div class="grid">{''.join(rows)}</div>
<div class="actions">{button(rng, 'Save', True)}{button(rng, 'Cancel')}</div></section>"""


def payment_form(rng: random.Random, p: Person) -> str:
    return f"""<section class="card"><h2>{esc(rng.choice(('Payment', 'Card details', 'Checkout')))}</h2>
<div class="grid">
{field(rng, 'Card number', p.card, 'CARD')}
{field(rng, 'Name on card', p.name, 'NAME')}
{field(rng, 'Expiry', p.card_expiry, None)}
{field(rng, 'CVV', p.cvv, 'CVV', 'password' if rng.random() < 0.5 else 'text')}
{field(rng, 'Billing PIN code', p.pincode, 'PINCODE')}
</div>
<p class="muted">Order {esc(rng.choice(p.decoys))} · total {esc(rng.choice(p.decoys))}</p>
<div class="actions">{button(rng, 'Pay now', True)}</div></section>"""


def bank_form(rng: random.Random, p: Person) -> str:
    return f"""<section class="card"><h2>Transfer funds</h2><div class="grid">
{field(rng, 'Account number', p.account, 'ACCOUNT')}
{field(rng, 'IFSC code', p.ifsc, 'IFSC')}
{field(rng, 'UPI ID', p.upi, 'UPI')}
{field(rng, 'Amount', rng.choice(p.decoys), None)}
{field(rng, 'Enter OTP', p.otp, 'OTP')}
</div><div class="actions">{button(rng, 'Transfer', True)}{button(rng, 'Back')}</div></section>"""


# --- read-only detail blocks -------------------------------------------------


def profile_block(rng: random.Random, p: Person) -> str:
    rows = [
        row("Name", p.name, "NAME"),
        row("Email", p.email, "EMAIL"),
        row("Mobile", p.phone, "PHONE"),
        row("Date of birth", p.dob, "DOB"),
        row("Aadhaar", p.aadhaar, "AADHAAR"),
        row("PAN", p.pan, "PAN"),
        row("Address", f"{p.address}, {p.city} {p.pincode}", "ADDRESS"),
        row("Member since", str(rng.randint(2014, 2025)), None),
        row("Reference", rng.choice(p.decoys), None),
    ]
    rng.shuffle(rows)
    avatar = f'<img class="avatar" src="{assets.avatar_svg(rng)}" alt="Profile photo" />'
    return f'<section class="card"><h2>Profile</h2><div class="split">{avatar}<div class="rows">{"".join(rows)}</div></div></section>'


def transactions_table(rng: random.Random, p: Person) -> str:
    head = "<tr><th>Date</th><th>Description</th><th>Reference</th><th>Amount</th></tr>"
    body = []
    for _ in range(rng.randint(4, 9)):
        # Most rows are noise; a few carry something real. That ratio is the point:
        # a table where every cell is PII teaches the model to redact tables.
        if rng.random() < 0.3:
            ref, pii = rng.choice(((p.account, "ACCOUNT"), (p.upi, "UPI"), (p.card, "CARD"), (p.ifsc, "IFSC")))
        else:
            ref, pii = rng.choice(p.decoys), None
        attr = f' data-pii="{pii}"' if pii else ""
        body.append(
            f'<tr><td>{rng.randint(1,28):02d}/{rng.randint(1,12):02d}</td>'
            f"<td>{esc(rng.choice(('UPI transfer', 'Card payment', 'NEFT credit', 'ATM withdrawal', 'Subscription')))}</td>"
            f'<td{attr}>{esc(ref)}</td><td>{esc(rng.choice(p.decoys))}</td></tr>'
        )
    return f'<section class="card"><h2>Recent activity</h2><table>{head}{"".join(body)}</table></section>'


def chat_thread(rng: random.Random, p: Person) -> str:
    lines = []
    secrets = [(p.otp, "OTP"), (p.phone, "PHONE"), (p.email, "EMAIL"), (p.upi, "UPI"), (p.account, "ACCOUNT")]
    for _ in range(rng.randint(3, 7)):
        side = rng.choice(("me", "them"))
        if rng.random() < 0.45:
            value, pii = rng.choice(secrets)
            prefix = rng.choice(("here it is: ", "my details — ", "use ", "sending "))
            content = f'{esc(prefix)}<span data-pii="{pii}">{esc(value)}</span>'
        else:
            content = esc(rng.choice((
                "sounds good", "can you check please", "thanks!", "will do it today",
                "did the payment go through?", "on my way", "let me confirm",
            )))
        avatar = f'<img class="avatar-sm" src="{assets.avatar_svg(rng)}" alt="" />' if rng.random() < 0.5 else ""
        lines.append(f'<div class="msg {side}">{avatar}<div class="bubble">{content}</div></div>')
    return f'<section class="card"><h2>Messages</h2><div class="chat">{"".join(lines)}</div></section>'


# --- image blocks ------------------------------------------------------------


def id_document_block(rng: random.Random, p: Person) -> str:
    number = rng.choice((p.aadhaar, p.pan, p.passport))
    src = assets.id_document_svg(rng, p.name, number, p.dob)
    caption = rng.choice(("Uploaded document", "Proof of identity", "Scanned ID", "Verification document"))
    width = rng.choice((260, 320, 380, 440))
    return (
        f'<section class="card"><h2>{esc(caption)}</h2>'
        f'<img class="doc" style="width:{width}px" src="{src}" alt="{esc(caption)}" data-pii="ID_DOCUMENT" />'
        f"</section>"
    )


def payment_card_block(rng: random.Random, p: Person) -> str:
    src = assets.payment_card_svg(rng, p.card, p.name, p.card_expiry)
    width = rng.choice((240, 300, 360, 420))
    return (
        f'<section class="card"><h2>Saved card</h2>'
        f'<img class="doc" style="width:{width}px" src="{src}" alt="Saved card" data-pii="CARD" />'
        f'<p class="muted">Ending {esc(p.card[-4:])} · expires {esc(p.card_expiry)}</p></section>'
    )


def qr_block(rng: random.Random, p: Person) -> str:
    size = rng.choice((120, 160, 200, 240))
    return (
        f'<section class="card"><h2>Scan to pay</h2>'
        f'<img class="qr" style="width:{size}px" src="{assets.qr_svg(rng)}" alt="QR code" data-pii="QR_CODE" />'
        f'<p class="muted">{esc(rng.choice(("Valid for 10 minutes", "Scan with any UPI app", "Present at counter")))}</p>'
        f"</section>"
    )


def signature_block(rng: random.Random, p: Person) -> str:
    width = rng.choice((200, 260, 320))
    return (
        f'<section class="card"><h2>Signature</h2>'
        f'<img class="sig" style="width:{width}px" src="{assets.signature_svg(rng)}" alt="Signature" data-pii="SIGNATURE" />'
        f'<p class="muted">Signed on {rng.randint(1,28):02d}/{rng.randint(1,12):02d}/{rng.randint(2024,2026)}</p></section>'
    )


# --- negatives ---------------------------------------------------------------


def article(rng: random.Random, p: Person) -> str:
    """No PII at all. Roughly a quarter of the dataset is this kind of thing."""
    paras = []
    for _ in range(rng.randint(2, 4)):
        sentences = rng.sample(
            [
                "The scheme is open to applicants from all districts.",
                "Processing usually completes within three working days.",
                "Support for additional languages is planned for a later release.",
                "Please read the guidelines before continuing.",
                "Office hours are 09:00 to 17:30 on weekdays.",
                "Applications received after the deadline will not be considered.",
                "Refer to the FAQ for common questions about eligibility.",
                "A confirmation will be shown once the form is complete.",
            ],
            k=rng.randint(2, 4),
        )
        paras.append(f"<p>{esc(' '.join(sentences))}</p>")
    stats = "".join(
        f'<div class="stat"><b>{esc(rng.choice(p.decoys))}</b><small>{esc(t)}</small></div>'
        for t in rng.sample(["applications", "approved", "pending", "districts"], k=3)
    )
    return f'<section class="card"><h2>{esc(rng.choice(("About the scheme", "Notice", "Guidelines")))}</h2>{"".join(paras)}<div class="stats">{stats}</div></section>'


def product_grid(rng: random.Random, p: Person) -> str:
    """Decoy-heavy and PII-free: prices, SKUs and counts that must survive untouched."""
    cards = []
    for _ in range(rng.randint(3, 8)):
        cards.append(
            f'<div class="tile"><div class="thumb"></div>'
            f'<div class="t">{esc(rng.choice(("Steel bottle", "Notebook", "Desk lamp", "Backpack", "Mouse", "Cable")))}</div>'
            f'<div class="p">{esc(rng.choice(p.decoys))}</div>'
            f'<div class="sku">SKU {rng.randint(10**7, 10**10)}</div>{button(rng, "Add")}</div>'
        )
    return f'<section class="card"><h2>Catalogue</h2><div class="tiles">{"".join(cards)}</div></section>'


ALL_SECTIONS: dict[str, Section] = {
    "header": header,
    "login_form": login_form,
    "kyc_form": kyc_form,
    "payment_form": payment_form,
    "bank_form": bank_form,
    "profile_block": profile_block,
    "transactions_table": transactions_table,
    "chat_thread": chat_thread,
    "id_document_block": id_document_block,
    "payment_card_block": payment_card_block,
    "qr_block": qr_block,
    "signature_block": signature_block,
    "article": article,
    "product_grid": product_grid,
}
