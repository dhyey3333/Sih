/**
 * The L0 planner: steps that never leave the device.
 *
 * §3.5 of docs/PLAN.md defines three disclosure levels, and this is the first one.
 * A large share of a form-filling task is not a reasoning problem at all — the page
 * has *declared* that a field holds an email (`autocomplete="email"`), and the user
 * has stored their email. Asking a vision-language model over the network to
 * rediscover that costs ~50 ms of network, a screenshot upload, and a round trip
 * through a third party, to reach a conclusion the DOM already stated.
 *
 * So: if the next action is unambiguous from declarations the page made about
 * itself, do it locally and send nothing. Anything less certain escalates.
 *
 * Two hard limits, because "handled locally" must never mean "acted rashly":
 *
 *   - **It never clicks.** Only typing into a field the page itself labelled,
 *     scrolling, and pressing Enter in a box the page declared as a search box — a
 *     search is not irreversible. Every click, and therefore everything that is,
 *     goes through the normal path and its confirmation gate.
 *   - **It only acts on a page author's declaration**, not on our own heuristics.
 *     A guess from a nearby word is exactly the case that deserves a model.
 *
 * And it acts only on the task it was given: a question is never answered by
 * filling in the form it happens to be asked on.
 */

import type { PageElement, StepResponse } from './protocol';
import { sanitizeText } from './pii/sanitize';
import type { Vault } from './pii/vault';
import { PROFILE_KEY_TYPE, type ProfileKey } from './pii/vault';

/** Reverse of PROFILE_KEY_TYPE: which profile key fills a field of this type. */
const TYPE_TO_PROFILE_KEY = Object.fromEntries(
  Object.entries(PROFILE_KEY_TYPE).map(([key, type]) => [type, key as ProfileKey]),
) as Partial<Record<string, ProfileKey>>;

/**
 * Only these reasons are trusted at L0. Every one of them is the *page* telling us
 * what the field is, not us inferring it.
 *
 * `kw:` rules — our own keyword heuristics — are deliberately excluded. They are
 * good enough to redact on (over-redacting is safe) and not good enough to type on
 * (typing an Aadhaar number into the wrong box is not).
 */
function isDeclaredByPage(reason: string | undefined): boolean {
  return reason?.startsWith('autocomplete=') === true;
}

/**
 * Scrolling, and only scrolling.
 *
 * "Go back" and "next page" are deliberately absent: the first is browser history
 * and the second is usually a pagination button, and treating either as a scroll
 * is acting on a guess — the one thing this planner must never do.
 */
const SCROLL_PATTERNS: Array<[RegExp, 'up' | 'down']> = [
  [/\b(scroll|page|move)\s+(down|further|lower)\b/i, 'down'],
  [/\b(scroll|page|move)\s+(back\s+)?(up|higher)\b/i, 'up'],
];

/** Words that add nothing to a scroll instruction. */
const SCROLL_FILLER = /\b(please|pls|a|bit|little|more|the|page|once|again|for me|now|just|can you|could you)\b/gi;

/**
 * True only when the whole task *is* the scroll. "Scroll down and fill the form"
 * is a form-filling task that happens to start with a scroll: handling its scroll
 * here used to repeat on every step, since the task still matched, until the step
 * budget ran out.
 */
function isBareScroll(task: string, pattern: RegExp): boolean {
  const rest = task.replace(pattern, ' ').replace(SCROLL_FILLER, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return rest.length === 0;
}

/**
 * A task that wants to be told something, not have something done. Mirrors
 * `_QUESTION` and `_READ_ONLY_PHRASES` in server/app/planner.py.
 *
 * "Check" only counts when it is asking — "check whether", "check my status" — and
 * not when it means ticking a box.
 */
const QUESTION =
  /^\s*(what|which|when|where|who|how much|how many|is|are|does|did|has|have|can you tell|tell me|check (if|whether|my|the status|status|what)|क्या)(?=[\s'’?,.!]|$)/i;
const READ_ONLY_PHRASES = [
  'describe', 'what is on', "what's on", 'summarise', 'summarize', 'summary',
  'read this', 'read the page', 'tell me about', 'explain this page', 'what does this page',
];

export function isReadOnlyTask(task: string): boolean {
  const t = task.trim().toLowerCase();
  return t.endsWith('?') || QUESTION.test(t) || READ_ONLY_PHRASES.some((p) => t.includes(p));
}

/**
 * "Search for post-matric scholarships" → "post-matric scholarships". Null for
 * anything that asks for more than the search itself ("… and apply to the first"),
 * which is a job for a planner that can read the results.
 */
export function searchQuery(task: string): string | null {
  const m =
    /^\s*(?:please\s+)?(?:search|look\s+up)\s+(?:for\s+|about\s+)?(.+?)\s*[.!]?\s*$/i.exec(task) ??
    /^\s*(.+?)\s+(?:खोजें|खोजो|ढूंढें|ढूँढें)\s*[।.]?\s*$/.exec(task);
  if (!m) return null;
  const query = (m[1] ?? '').replace(/^["'“‘]|["'”’]$/g, '').trim();
  if (!query || /\b(and|then)\b|,/i.test(query)) return null;
  return query;
}

const sameText = (a: string | undefined, b: string): boolean =>
  (a ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

export interface LocalDecision {
  response: StepResponse;
  /** Shown in the UI: why this needed no server. */
  because: string;
  /**
   * What history should record instead of `response.text`. History goes back to the
   * server, and a search query is the user's own words — sanitized like the task is.
   */
  historyText?: string;
}

export interface LocalPlannerInput {
  task: string;
  elements: PageElement[];
  vault: Vault;
  /** Element ids already typed into, so a failed field is not retried forever. */
  attempted: ReadonlySet<number>;
  /** Whether this task has already scrolled — a bare scroll task is then finished. */
  alreadyScrolled?: boolean;
  /** Whether this task has already pressed Enter in a search box. */
  alreadySearched?: boolean;
}

/**
 * Decide whether this step can be handled without the server.
 * Returns null to escalate — which is the default, not the exception.
 */
export function planLocally(input: LocalPlannerInput): LocalDecision | null {
  const { task, elements, vault, attempted } = input;

  // 1. A bare scroll instruction needs no model — once. Then it is done.
  for (const [pattern, direction] of SCROLL_PATTERNS) {
    if (pattern.test(task) && isBareScroll(task, pattern)) {
      if (input.alreadyScrolled) {
        return {
          response: {
            action: 'done',
            summary: `Scrolled ${direction}.`,
            reason: 'The task was a single scroll, and it has happened.',
            confidence: 1,
            planner: 'local',
          },
          because: 'the scroll this task asked for is done',
        };
      }
      return {
        response: {
          action: 'scroll',
          direction,
          reason: 'Scroll instruction handled on-device.',
          confidence: 1,
          planner: 'local',
        },
        because: 'a scroll instruction needs no reasoning',
      };
    }
  }

  // A question is for a planner that can read; typing into the page is never an answer.
  if (isReadOnlyTask(task)) return null;

  // 2. A search, when the page declares exactly one search box: type the user's own
  //    words, press Enter, done. Nothing about the page goes anywhere — including
  //    whatever the page says to an AI reading it (eval/tasks/pages/injection.html).
  const query = searchQuery(task);
  if (query) {
    if (input.alreadySearched) {
      return {
        response: {
          action: 'done',
          summary: `Searched for “${query}”. The results are on screen.`,
          reason: 'The task was a search, and it has been run.',
          confidence: 0.95,
          planner: 'local',
        },
        because: 'the search this task asked for has run',
      };
    }
    const boxes = elements.filter((e) => e.role === 'searchbox' && !e.disabled);
    const box = boxes.length === 1 ? boxes[0] : undefined;
    if (!box) return null; // none, or a choice to make: escalate
    if (!sameText(box.value, query)) {
      if (attempted.has(box.id)) return null; // typed once and it did not take
      return {
        response: {
          action: 'type',
          element_id: box.id,
          text: query,
          reason: 'The task is a search and the page declares one search box.',
          confidence: 0.95,
          planner: 'local',
        },
        because: `field ${box.id} is the page's only declared search box`,
        historyText: sanitizeText(query, vault).text,
      };
    }
    return {
      response: {
        action: 'key',
        element_id: box.id,
        key: 'Enter',
        reason: 'The query is in the search box; Enter runs it.',
        confidence: 0.95,
        planner: 'local',
      },
      because: 'running a search is not irreversible',
    };
  }

  // 3. An empty field the *page* declared, which the vault can fill.
  const available = new Set(vault.profileKeys());

  for (const element of elements) {
    if (!element.sensitive || element.disabled) continue;
    if (element.sensitive === 'PASSWORD') continue; // never typed by the agent
    if (attempted.has(element.id)) continue;
    if ((element.value ?? '').length > 0) continue;
    if (!isDeclaredByPage(element.sensitiveReason)) continue;

    const key = TYPE_TO_PROFILE_KEY[element.sensitive];
    if (!key || !available.has(key)) continue;

    return {
      response: {
        action: 'type',
        element_id: element.id,
        text: `⟦PROFILE.${key}⟧`,
        reason: `The page declares this field as ${element.sensitiveReason}; the vault holds ${key}.`,
        confidence: 0.99,
        planner: 'local',
      },
      because: `the page itself declares field ${element.id} as ${element.sensitiveReason}`,
    };
  }

  return null;
}
