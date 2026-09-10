"""Named page recipes.

The dataset is split **by recipe**, not by image (docs/PLAN.md §6.1). Splitting by
image would put near-identical pages in both train and validation and produce a
validation score that means nothing — the model would have seen that layout with a
different name on it. Holding whole recipes out is the only way the validation
number answers the question we actually care about: does this work on a page we have
never seen?

Each recipe is a fixed spine — which sections, in what order. Everything else
(content, palette, font, density, viewport, zoom, scroll) is randomised per sample.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .canvas import canvas_app
from .sections import ALL_SECTIONS, Section


@dataclass(frozen=True)
class Recipe:
    name: str
    sections: tuple[str, ...]
    #: Sections chosen at random from this pool, to vary length within the recipe.
    optional: tuple[str, ...] = ()


RECIPES: tuple[Recipe, ...] = (
    Recipe("login", ("header", "login_form"), ("article",)),
    Recipe("signup_kyc", ("header", "kyc_form"), ("article", "signature_block")),
    Recipe("kyc_with_document", ("header", "kyc_form", "id_document_block"), ("signature_block",)),
    Recipe("bank_dashboard", ("header", "profile_block", "transactions_table"), ("qr_block",)),
    Recipe("transfer", ("header", "bank_form"), ("transactions_table", "article")),
    Recipe("checkout", ("header", "payment_form"), ("product_grid", "qr_block")),
    Recipe("wallet_cards", ("header", "payment_card_block", "payment_form"), ("qr_block",)),
    Recipe("profile_page", ("header", "profile_block"), ("signature_block", "article")),
    Recipe("messages", ("header", "chat_thread"), ("profile_block",)),
    Recipe("document_upload", ("header", "id_document_block", "signature_block"), ("article",)),
    Recipe("pay_qr", ("header", "qr_block", "bank_form"), ("article",)),
    Recipe("statement", ("header", "transactions_table", "profile_block"), ("payment_card_block",)),
    Recipe("canvas_form", ("header", "canvas_app"), ("article",)),
    Recipe("canvas_mixed", ("header", "canvas_app", "profile_block"), ("transactions_table",)),
    Recipe("onboarding", ("header", "login_form", "kyc_form"), ("qr_block",)),
    Recipe("card_and_id", ("header", "payment_card_block", "id_document_block"), ("profile_block",)),
    # Negatives. Without these the model learns "a form-shaped box is PII" and the
    # precision half of the score collapses on ordinary pages.
    Recipe("catalogue", ("header", "product_grid"), ("article", "article")),
    Recipe("notice", ("header", "article"), ("article", "product_grid")),
    Recipe("empty_form", ("header", "login_form_blank"), ("article",)),
)

#: Recipe name → section builders, resolved once.
_BUILDERS: dict[str, Section] = {**ALL_SECTIONS, "canvas_app": canvas_app}


def _blank_login(rng: random.Random, person) -> str:
    """An unfilled form: inputs and buttons to find, no PII to redact."""
    from .sections import button, field

    return f"""<section class="card"><h2>Sign in</h2>
{field(rng, 'Email address', '', None)}
{field(rng, 'Password', '', None, 'password')}
<div class="actions">{button(rng, 'Sign in', True)}{button(rng, 'Create account')}</div></section>"""


_BUILDERS["login_form_blank"] = _blank_login


def build_sections(recipe: Recipe, rng: random.Random, person) -> list[str]:
    names = list(recipe.sections)
    for optional in recipe.optional:
        if rng.random() < 0.5:
            names.append(optional)
    if rng.random() < 0.25:
        rng.shuffle(names[1:])  # keep the header first
    return [_BUILDERS[name](rng, person) for name in names]


def split_recipes(seed: int = 7) -> dict[str, list[Recipe]]:
    """
    80/10/10 by recipe. Fixed seed so the split is stable across regenerations —
    a dataset regenerated with a different split silently invalidates every number
    measured against the old one.
    """
    rng = random.Random(seed)
    shuffled = list(RECIPES)
    rng.shuffle(shuffled)

    n = len(shuffled)
    n_val = max(1, round(n * 0.1))
    n_test = max(1, round(n * 0.1))
    return {
        "val": shuffled[:n_val],
        "test": shuffled[n_val : n_val + n_test],
        "train": shuffled[n_val + n_test :],
    }
