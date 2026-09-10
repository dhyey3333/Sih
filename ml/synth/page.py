"""Assemble a complete HTML document from a recipe."""

from __future__ import annotations

import random

from faker import Faker

from .person import make_person
from .recipes import Recipe, build_sections
from .theme import build_theme

_TITLES = (
    "Account", "Sign in", "Verification", "Dashboard", "Profile", "Payments",
    "Application", "Statement", "Transfer", "Settings",
)


def build_page(recipe: Recipe, rng: random.Random, faker: Faker) -> str:
    person = make_person(rng, faker)
    css, dark = build_theme(rng)
    body = "\n".join(build_sections(recipe, rng, person))
    title = rng.choice(_TITLES)

    # `lang` and `color-scheme` are set because they change how the browser renders
    # form controls, which is exactly the kind of variation the model should see.
    return f"""<!doctype html>
<html lang="en" style="color-scheme:{'dark' if dark else 'light'}">
<head><meta charset="utf-8" /><title>{title}</title><style>{css}</style></head>
<body><main>{body}</main></body></html>"""
