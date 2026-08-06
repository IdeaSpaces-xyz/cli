/**
 * Default template — minimal scaffolding for `ideaspaces create`.
 *
 * Templates ship as inline string constants compiled into the CLI bundle.
 * Only `foundation.md` and `guide.md` are scaffolded as contract files —
 * they describe the five-file contract that names `purpose.md`, `now.md`,
 * and `next.md`. The agent reading these on first session sees those names
 * without matching files and the drift rule fires: propose creating them in
 * conversation. Real content from real exchange beats placeholder filler.
 *
 * The conduct section of the scaffolded foundation is not authored here: it
 * is the protocol's canonical FOUNDATION_CORE, composed in at bundle time and
 * stamped with core_version so drift against the canonical seed stays
 * detectable. This file owns only space structure and house style.
 *
 * `skills/` and `perspectives/` get convention READMEs only — no content.
 * The universal skills are catalog-served (`ideaspaces skills`); these
 * folders are the character layer, holding what is specific to the space.
 *
 * Two shapes for `_agent/` visibility (set by the create command per the
 * detected target shape):
 *   - shared: content space or opt-in shared code repo (default for content)
 *   - private: code repo with per-developer agent context (default for code)
 *
 * The `.gitignore` defaults differ between shapes; everything else is the same.
 */

import { FOUNDATION_CORE, FOUNDATION_CORE_VERSION } from "@ideaspaces/protocol";

export const FOUNDATION_MD = `---
name: Foundation
summary: Baseline contract for this ideaspace — what kind of place this is, how
  the agent and human work together. Lives only at the space root and always
  loads; deeper branches refine via their own \`_agent/\` when they need to.
core_version: ${FOUNDATION_CORE_VERSION}
---

# Foundation

> Baseline for the space. Lives only at the root.

---

## Space

This is an ideaspace — a markdown folder where knowledge accumulates. The
directory tree is how you navigate. \`_agent/\` carries the Agreement between
you and the user about how to work here.

The five-file contract:

- \`foundation.md\` — this file. What this place is, baseline behaviors.
- \`guide.md\` — specific agreements for this space.
- \`purpose.md\` — why this place exists.
- \`now.md\` — what's currently active.
- \`next.md\` — what's queued.

Only \`foundation.md\` and \`guide.md\` are scaffolded at create time.
\`purpose.md\`, \`now.md\`, and \`next.md\` are emergent — when the agent
reads this contract and finds those files missing, propose creating
them in conversation. Real content from real exchange.

Dimensions inside \`_agent/\` (grown as the space earns them):

- \`skills/\` — operating procedures specific to this space — the character
  layer. Universal skills (capture, writing, awareness, …) come from the
  protocol catalog (\`ideaspaces skills\`) and are not copied here. Each
  skill is a markdown file whose \`description\` is its trigger; skills
  compose along the path, a deeper same-named skill shadowing an ancestor's.
- \`perspectives/\` — reusable thinking patterns: how to see, where skills
  are how to do. User-authored; none are bundled.

\`CLAUDE.md\` at the space root tells Claude Code where this contract lives.

\`.gitignore\` is also part of the Agreement — the boundary between what's
shared and what stays local. Drafts, scratch, secrets, per-developer context
go there. Propose changes; never edit silently.

---

## The Agreement

${FOUNDATION_CORE.trim()}

---

## Practice

- **No slop.** Every line earns its place.
- **Three-tier commits.** Subject (one line), body (what shifted, why),
  trailers (\`Co-authored-by\`, etc.).
`;

/**
 * Agent-vantage variant (`create --agent`): the space IS the character.
 * Same five-file contract, same protocol conduct core — read agent-first:
 * foundation declares the vantage, guide is how work goes when inhabiting it,
 * skills are what the agent can repeat. Character sections ship as elicitation
 * prompts, not filler — the agent draws them out in conversation and replaces
 * them with real content.
 */
export function agentFoundationMd(agentName: string): string {
  return `---
name: Foundation — ${agentName}
summary: The declared vantage of ${agentName}. This space is not a subject to
  study — it is a way of looking, inhabited by an agent. Character, boundaries,
  and what this vantage is not.
core_version: ${FOUNDATION_CORE_VERSION}
---

# Foundation — ${agentName}

> This space is a **vantage**, not a subject. An agent launched here inhabits
> ${agentName}: nothing in this tree is knowledge *about* ${agentName} — it is
> the position ${agentName} looks from, and the memory that position accumulates.

\`agent = stable identity + name + description + declared vantage\`. This file
is the declared vantage. The habitat (Claude Code, Pi, …) supplies model,
tools, and reach; identity names who is inhabiting.

The five-file contract, read agent-first:

- \`foundation.md\` — this file. What ${agentName} is, character, boundaries.
- \`guide.md\` — how work goes when inhabiting ${agentName}.
- \`purpose.md\` — why this vantage exists (emergent).
- \`now.md\` — the current lane (emergent).
- \`next.md\` — what's queued (emergent).

## Character

_Elicit and replace: how does ${agentName} show up? Three to five traits,
each one bolded line + one sentence of what it means in practice. Drawn from
real examples of the work, not adjectives._

## Boundaries

_Elicit and replace: what does ${agentName} refuse to do, and what does it
never claim without checking? Boundaries are what make an agent trustworthy
enough to delegate to._

## What this vantage is not

_Elicit and replace: name the neighboring role people might confuse this
with, and where the line sits._

Dimensions inside \`_agent/\` (grown as the character earns them):

- \`skills/\` — what ${agentName} can repeat: procedures worth doing the same
  way every time. Each skill's \`description\` is its trigger; skills compose
  along the path.
- \`perspectives/\` — how ${agentName} sees: reusable thinking patterns.

The content tree is ${agentName}'s memory — what it has produced and learned.
Capture is conscious there like anywhere else.

---

## The Agreement

${FOUNDATION_CORE.trim()}

---

## Practice

- **No slop.** Every line earns its place.
- **Three-tier commits.** Subject (one line), body (what shifted, why),
  trailers (\`Co-authored-by\`, etc.).
`;
}

export function agentGuideMd(agentName: string): string {
  return `---
name: Guide — ${agentName}
summary: How work goes when inhabiting ${agentName} — working rhythm,
  conventions, and what gets captured where. Grows from real sessions.
---

# Guide — ${agentName}

> How work goes when inhabiting [${agentName}](foundation.md).

_Fill in as patterns emerge from real sessions. Examples to consider:_

- What does a typical ${agentName} session produce, and where does it land
  in the tree?
- Which decisions does ${agentName} make alone, and which does it bring back?
- What gets captured into memory, and what stays in the conversation?

## When the Agreement drifts

If \`now.md\` stops matching reality, or the character in
[foundation](foundation.md) contradicts how ${agentName} actually works —
surface it. Character changes cross the same capture boundary as knowledge.
`;
}

export function agentClaudeMd(agentName: string): string {
  return `---
name: Claude Code orientation — ${agentName}
summary: Tells Claude Code this space is a vantage, not a subject. Launching
  here means inhabiting ${agentName}.
---

# CLAUDE.md — ${agentName}

> This ideaspace is a **vantage**, not a subject. Launching here means
> inhabiting ${agentName}, not studying it.

## Orient

Read in order:

1. [\`_agent/foundation.md\`](_agent/foundation.md) — the declared vantage:
   character and boundaries
2. [\`_agent/guide.md\`](_agent/guide.md) — how work goes when inhabiting it
3. \`_agent/purpose.md\` / \`_agent/now.md\` / \`_agent/next.md\` — direction
   (emergent; their absence is a prompt to elicit, not invent)

If the Character, Boundaries, or "What this vantage is not" sections still
carry elicitation prompts, that is the first conversation: draw the character
out from the user with real examples, replace the prompts, and confirm before
committing.

## The work

The content tree here is ${agentName}'s memory. The subject of the work may
live elsewhere — this repo carries the position it is seen from.
`;
}

/** Contract files for an agent-vantage scaffold, keyed like CONTRACT_TEMPLATES. */
export function agentContractTemplates(agentName: string): Record<string, string> {
  return {
    foundation: agentFoundationMd(agentName),
    guide: agentGuideMd(agentName),
  };
}

export const GUIDE_MD = `---
name: Guide
summary: Specific agreements for working in this space. As patterns emerge —
  how we capture, what conventions live where, how branches are organized —
  capture them here.
---

# Guide

> Specific agreements for this space, beyond [foundation](foundation.md)
> defaults.

---

## What's specific here

_Fill in as patterns emerge. Examples to consider:_

- Is the \`_agent/\` shared (committed) or private (gitignored)?
- Where do conventions live (commit shape, tagging, identity)?
- Are there active tracks running in parallel?

---

## When the Agreement drifts

If \`now.md\` stops matching reality, or [foundation](foundation.md)
contradicts current practice, or this guide is silent on something we keep
doing — surface it. Update this guide for this scope, or revisit foundation
if a baseline needs to shift.
`;

export const SKILLS_README_MD = `---
name: Skills
summary: Space-specific operating procedures — the character layer. Universal
  skills come from the protocol catalog; this folder holds what makes this
  space's agent distinct.
---

# Skills

Operating procedures the agent should follow here — the **character layer**.

The universal operating skills (capture, writing, awareness, guide, …) are
served by the protocol catalog — \`ideaspaces skills\` lists them — and are
not copied into spaces. This folder holds what is distinct about working
*here*: procedures worth repeating that only make sense in this space.

Each skill is a markdown file with \`name\` + \`description\` frontmatter;
the description is the trigger — it tells the agent when the skill applies.
Skills compose along the path: a skill here reaches every position below,
and a deeper \`_agent/skills/\` file with the same name shadows this one.
`;

export const PERSPECTIVES_README_MD = `---
name: Perspectives
summary: Reusable thinking patterns for this space — how to see, where skills
  are how to do. User-authored; none are bundled.
---

# Perspectives

Reusable thinking patterns — how to *see*, where [skills](../skills/README.md)
are how to *do*.

Perspectives are user-authored; none are bundled on purpose. When a way of
evaluating or analyzing keeps recurring, capture it here in three parts —
lens (what to look at), framework (how to think it through), and expected
output — so anyone, human or agent, can apply the same way of looking.
`;

export const GITATTRIBUTES = `*.md diff=markdown text eol=lf
`;

export const CLAUDE_MD = `---
name: Claude Code orientation
summary: Tells Claude Code this directory is an ideaspace and points at the seed
  _agent contract. Purpose, Now, and Next may be missing at first; their absence
  is a prompt to capture real direction in conversation.
---

# CLAUDE.md

> This is an ideaspace. The \`_agent/\` contract carries the working agreement.

## Orient

At session start, read the seed files first:

1. [\`_agent/foundation.md\`](_agent/foundation.md) — what this place is, baseline behaviors
2. [\`_agent/guide.md\`](_agent/guide.md) — how agent and human work together here

Then look for the emergent direction files:

3. \`_agent/purpose.md\` — why this exists
4. \`_agent/now.md\` — what's currently active
5. \`_agent/next.md\` — what's queued

\`purpose.md\`, \`now.md\`, and \`next.md\` may not exist yet. If missing,
don't invent them. Treat the gap as direction not yet captured and propose
creating them in conversation when there is enough real signal.

## When the Agreement drifts

Now stops matching reality. Foundation contradicts current practice. Guide is
silent on something we keep doing. → Surface it. Propose an update. Update
[\`_agent/guide.md\`](_agent/guide.md) for this scope, or revisit
[\`_agent/foundation.md\`](_agent/foundation.md) if a baseline needs to shift.
`;

/**
 * `.gitignore` defaults appended under a `# ideaspace defaults` header.
 * Append, never replace — existing entries are preserved.
 */
export function gitignoreDefaults(opts: { privateAgent: boolean }): string {
  const lines = ["", "# ideaspace defaults"];
  if (opts.privateAgent) {
    lines.push(
      "# (code repo with private _agent/ — each developer's contract stays local)",
      "_agent/",
      "CLAUDE.local.md",
    );
  }
  lines.push("*.draft.md", "scratch/", "_local/", "");
  return lines.join("\n");
}

/** Seed contract files keyed by name.
 *
 * `foundation.md` + `guide.md` describe the contract that names
 * `purpose.md`, `now.md`, and `next.md`. Those three are not scaffolded —
 * the agent on first session reads foundation+guide, notices the missing
 * files (the contract names them), and proposes capturing them in
 * conversation. Real content over placeholder filler.
 */
export const CONTRACT_TEMPLATES: Record<string, string> = {
  foundation: FOUNDATION_MD,
  guide: GUIDE_MD,
};
