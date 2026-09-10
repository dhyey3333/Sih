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
 *   - **It never clicks.** Only typing into a field the page itself labelled, and
 *     scrolling. Every click — and therefore everything irreversible — goes through
 *     the normal path and its confirmation gate.
 *   - **It only acts on a page author's declaration**, not on our own heuristics.
 *     A guess from a nearby word is exactly the case that deserves a model.
 */

import type { PageElement, StepResponse } from './protocol';
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

const SCROLL_PATTERNS: Array<[RegExp, 'up' | 'down']> = [
  [/\b(scroll|page|move|go)\s+(down|further|lower)\b|\bnext page\b/i, 'down'],
  [/\b(scroll|page|move|go)\s+(up|back|higher)\b|\bprevious page\b/i, 'up'],
];

export interface LocalDecision {
  response: StepResponse;
  /** Shown in the UI: why this needed no server. */
  because: string;
}

export interface LocalPlannerInput {
  task: string;
  elements: PageElement[];
  vault: Vault;
  /** Element ids already typed into, so a failed field is not retried forever. */
  attempted: ReadonlySet<number>;
}

/**
 * Decide whether this step can be handled without the server.
 * Returns null to escalate — which is the default, not the exception.
 */
export function planLocally(input: LocalPlannerInput): LocalDecision | null {
  const { task, elements, vault, attempted } = input;

  // 1. A bare scroll instruction needs no model.
  for (const [pattern, direction] of SCROLL_PATTERNS) {
    if (pattern.test(task)) {
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

  // 2. An empty field the *page* declared, which the vault can fill.
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
