"""The rule-based planner on the shapes real forms take: radio groups, wizards, and
forms that start below the fold. Each was a place it used to stop and say "done"."""

from __future__ import annotations

from app.planner import answer_from_text, plan, search_query
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


STATUS_SCREEN = "\n".join([
    "Post-Matric Scholarship Portal Track your application",
    "Application SCH-2026-044817",
    "Status: Approved",
    "Scholarship amount: ₹12,000 for the 2026–27 academic year.",
])


class TestAnsweringFromScreenText:
    def test_the_rarer_word_picks_the_line(self):
        # "application" is on three lines, "status" on one: that one is the answer.
        assert answer_from_text("What is the status of my application?", STATUS_SCREEN) == "Status: Approved"

    def test_a_bare_label_brings_its_value(self):
        text = "Payment details\nAmount due\n₹4,500\nDue date\n30 September 2026"
        assert answer_from_text("When is the due date?", text) == "Due date 30 September 2026"

    def test_nothing_in_common_is_no_answer(self):
        assert answer_from_text("Where is the office?", STATUS_SCREEN) is None

    def test_a_question_is_answered_not_filled(self):
        r = plan(req(task="What is the status of my application?", visible_text=STATUS_SCREEN))
        assert r.action == "done"
        assert "Approved" in r.summary
        assert "keyword" in r.reason  # never passed off as a model reading the page

    def test_without_screen_text_it_describes_instead(self):
        r = plan(req(task="What is the status of my application?"))
        assert r.action == "done"
        assert "From the screen" not in r.summary

    def test_an_instruction_is_not_mistaken_for_a_question(self):
        r = plan(req(
            task="Fill this form with my details",
            visible_text=STATUS_SCREEN,
            elements=[element(id=1, label="Email", sensitive="EMAIL")],
        ))
        assert r.action == "type"


class TestSearch:
    box = element(id=7, role="searchbox", label="Search")

    def test_types_the_query_not_the_profile(self):
        r = plan(req(task="Search for post-matric scholarships", elements=[
            element(id=2, label="Email address", sensitive="EMAIL", filled=False), self.box,
        ]))
        assert r.action == "type" and r.element_id == 7 and r.text == "post-matric scholarships"

    def test_presses_enter_then_stops(self):
        typed = element(id=7, role="searchbox", label="Search", value="post-matric scholarships")
        r = plan(req(task="search for post-matric scholarships", elements=[typed]))
        assert r.action == "key" and r.key == "Enter"
        r = plan(req(task="search for post-matric scholarships", elements=[typed],
                     history=[{"action": "key", "element_id": 7, "ok": True}]))
        assert r.action == "done"

    def test_finds_a_search_box_by_its_label(self):
        r = plan(req(task="look up NSP deadlines", elements=[element(id=3, label="Search schemes")]))
        assert r.action == "type" and r.element_id == 3

    def test_a_compound_task_is_not_a_bare_search(self):
        assert search_query("search for scholarships and apply to the first") is None


class TestCheckIsNotAlwaysAQuestion:
    def test_ticking_a_box_is_an_instruction(self):
        r = plan(req(task="Check the terms box and fill my details"))
        assert r.action == "type"

    def test_checking_a_status_is_a_question(self):
        assert plan(req(task="check my application status")).action == "done"
