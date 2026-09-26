"""The rule-based planner on the shapes real forms take: radio groups, wizards, and
forms that start below the fold. Each was a place it used to stop and say "done"."""

from __future__ import annotations

from app.planner import answer_from_text, plan, search_query, task_facts
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


class TestFactsInTheTask:
    category = element(id=4, role="combobox", label="Category *", options=["General", "OBC", "SC", "ST"])

    def test_parses_what_the_user_said(self):
        assert task_facts("Fill this; my category is OBC and my gender is female.") == {
            "category": "OBC", "gender": "female"}

    def test_selects_a_stated_option_instead_of_asking(self):
        r = plan(req(task="Fill the form, my category is OBC", elements=[self.category]))
        assert r.action == "select" and r.element_id == 4 and r.option == "OBC"

    def test_chooses_a_stated_radio(self):
        r = plan(req(task="my gender is female", elements=[radio(1, "Female"), radio(2, "Male")]))
        assert r.action == "select" and r.option == "female"

    def test_a_stated_token_is_typed_as_a_token(self):
        r = plan(req(task="Fill it in; my phone is ⟦PROFILE.PHONE⟧",
                     elements=[element(id=3, label="Alternate phone")]))
        assert r.action == "type" and r.text == "⟦PROFILE.PHONE⟧"

    def test_leaves_a_filled_field_alone(self):
        filled = element(id=4, role="combobox", label="Category", options=["OBC"], value="General", filled=True)
        assert plan(req(task="my category is OBC", elements=[filled])).action != "select"


class TestDeclarations:
    declare = element(id=9, role="checkbox", label="I declare that the information given is true",
                      required=True, checked=False)

    def test_asks_before_ticking_it(self):
        r = plan(req(elements=[self.declare]))
        assert r.action == "ask_user" and r.element_id == 9 and r.question.startswith("Tick")

    def test_asks_once(self):
        r = plan(req(elements=[self.declare], history=[{"action": "click", "element_id": 9, "ok": True}]))
        assert not (r.action == "ask_user" and r.element_id == 9)

    def test_leaves_an_optional_box_alone(self):
        optional = element(id=9, role="checkbox", label="Send me updates", checked=False)
        r = plan(req(elements=[optional]))
        assert not (r.action == "ask_user" and r.element_id == 9)


class TestScrollingPanels:
    def test_scrolls_when_everything_in_view_is_done(self):
        r = plan(req(page={"origin": "https://demo.local", "path": "/apply", "title": "A", "more_below": True},
                     elements=[element(id=1, label="Full name", sensitive="NAME", filled=True, value="⟦PROFILE.FULL_NAME⟧")]))
        assert r.action == "scroll" and r.direction == "down"


class TestHindi:
    def test_a_hindi_submit_is_never_pressed_unasked(self):
        r = plan(req(task="यह फ़ॉर्म भरें", elements=[element(id=5, role="button", text="जमा करें")]))
        assert r.action == "ask_user" and r.element_id == 5

    def test_a_hindi_stop_phrase_is_respected(self):
        r = plan(req(task="फ़ॉर्म भरें, जमा न करें", elements=[element(id=5, role="button", text="जमा करें")]))
        assert r.action == "done"


class TestAnsweringAboutYourOwnData:
    PROFILE_SCREEN = "My profile\nName\n⟦PROFILE.FULL_NAME⟧\nRegistered email\n⟦PROFILE.EMAIL⟧\nMember since\nMarch 2024"

    def test_answers_with_the_token_for_the_client_to_fill_in(self):
        # The server answers a question about the user's email without learning it.
        assert answer_from_text("What email address is on my profile?", self.PROFILE_SCREEN) == \
            "Registered email ⟦PROFILE.EMAIL⟧"

    def test_a_complete_pair_is_not_extended(self):
        assert answer_from_text("What is the status?", "Status: Approved\nNext steps") == "Status: Approved"


class TestFindIsASearchWhenItNamesAThing:
    def test_find_a_topic_is_a_search(self):
        assert search_query("Find scholarships for engineering students") == "scholarships for engineering students"
        assert search_query("look for merit scholarships") == "merit scholarships"

    def test_find_a_control_is_not(self):
        assert search_query("Find the login button") is None
        assert search_query("find the sign-up link") is None

    def test_a_search_for_a_login_topic_still_is_one(self):
        # "search for" is unambiguous; only "find" gets the control check.
        assert search_query("search for login problems") == "login problems"
