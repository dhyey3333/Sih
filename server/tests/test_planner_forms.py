"""The rule-based planner on the shapes real forms take: radio groups, wizards, and
forms that start below the fold. Each was a place it used to stop and say "done"."""

from __future__ import annotations

from app.planner import plan
from app.schemas import StepRequest

from .fixtures import element, sanitized_request


def req(**overrides) -> StepRequest:
    return StepRequest(**sanitized_request(**overrides))


def radio(id_: int, label: str, *, checked=False, required=True) -> dict:
    return element(id=id_, role="radio", label=label, group="gender", checked=checked, required=required)


class TestRadioGroups:
    def test_asks_about_a_required_group_as_one_question(self):
        r = plan(req(elements=[radio(1, "Female"), radio(2, "Male"), radio(3, "Other")]))
        assert r.action == "ask_user"
        assert r.element_id == 1
        assert "Female / Male / Other" in r.question

    def test_leaves_a_group_alone_once_something_is_chosen(self):
        r = plan(req(elements=[radio(1, "Female", checked=True), radio(2, "Male")]))
        assert r.action != "ask_user"

    def test_does_not_ask_twice_after_an_answer(self):
        r = plan(req(
            elements=[radio(1, "Female"), radio(2, "Male")],
            history=[{"action": "select", "element_id": 1, "ok": True}],
        ))
        assert r.action != "ask_user"


class TestWizards:
    step_one_done = [
        element(id=1, label="Full name", sensitive="NAME", filled=True, value="⟦PROFILE.FULL_NAME⟧"),
        element(id=2, role="button", text="Next"),
    ]

    def test_presses_next_when_this_step_is_done(self):
        r = plan(req(elements=self.step_one_done))
        assert r.action == "click" and r.element_id == 2

    def test_presses_it_only_once(self):
        r = plan(req(elements=self.step_one_done,
                     history=[{"action": "click", "element_id": 2, "ok": True}]))
        assert not (r.action == "click" and r.element_id == 2)

    def test_never_treats_a_payment_as_a_next_step(self):
        r = plan(req(elements=[element(id=4, role="button", text="Continue to payment")]))
        assert r.action != "click"

    def test_does_not_advance_on_a_read_only_task(self):
        r = plan(req(task="Describe what is on this page", elements=self.step_one_done))
        assert r.action == "done"


class TestFormsBelowTheFold:
    def test_scrolls_when_nothing_is_in_view_and_the_page_goes_on(self):
        r = plan(req(elements=[element(id=1, role="link", text="Home")],
                     page={"origin": "https://x.gov.in", "path": "/apply", "title": "", "more_below": True}))
        assert r.action == "scroll" and r.direction == "down"

    def test_does_not_scroll_when_the_form_is_already_in_view(self):
        r = plan(req(page={"origin": "https://x.gov.in", "path": "/apply", "title": "", "more_below": True}))
        assert r.action != "scroll"

    def test_gives_up_after_a_few_scrolls(self):
        r = plan(req(
            elements=[element(id=1, role="link", text="Home")],
            page={"origin": "https://x.gov.in", "path": "/apply", "title": "", "more_below": True},
            history=[{"action": "scroll", "ok": True}] * 4,
        ))
        assert r.action != "scroll"


class TestSomeoneElsesName:
    """Father's, mother's, guardian's and nominee's names are on almost every Indian form."""

    def test_never_types_the_applicants_name_into_a_fathers_name_field(self):
        r = plan(req(elements=[element(id=3, label="Father's name", sensitive="NAME", required=True)]))
        assert r.action == "ask_user" and r.element_id == 3

    def test_still_fills_the_applicants_own_name(self):
        r = plan(req(elements=[element(id=1, label="Applicant name", sensitive="NAME")]))
        assert r.action == "type" and r.text == "⟦PROFILE.FULL_NAME⟧"

    def test_hindi_label_for_father(self):
        r = plan(req(elements=[element(id=3, label="पिता का नाम", sensitive="NAME", required=True)]))
        assert r.action == "ask_user"


class TestQuestions:
    def test_a_question_is_answered_not_treated_as_a_form_to_fill(self):
        r = plan(req(task="What is the status of my application?"))
        assert r.action == "done"


class TestHistoryIsPerPage:
    """Element ids are stable within a page only. History from the previous page of a
    multi-page form must not stop the planner filling field 1 on this one."""

    def test_a_field_typed_on_another_page_does_not_block_this_one(self):
        r = plan(req(
            elements=[element(id=1, label="Email address", sensitive="EMAIL", filled=False)],
            history=[{"action": "type", "element_id": 1, "ok": True, "page": "https://demo.local/step-1"}],
        ))
        assert r.action == "type" and r.element_id == 1

    def test_the_same_field_on_this_page_is_not_typed_twice(self):
        r = plan(req(
            elements=[element(id=1, label="Email address", sensitive="EMAIL", filled=False)],
            history=[{"action": "type", "element_id": 1, "ok": True, "page": "https://demo.local/apply"}],
        ))
        assert not (r.action == "type" and r.element_id == 1)
