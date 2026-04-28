/**
 * Default template — minimal scaffolding for `ideaspaces create`.
 *
 * Templates ship as inline string constants compiled into the CLI bundle.
 * They're starting points, not finished documents — the user fills via
 * `/is-setup` (conversational seeding) or by editing directly.
 *
 * Two shapes for `_agent/` visibility (set by the create command per the
 * detected target shape):
 *   - shared: content space or opt-in shared code repo (default for content)
 *   - private: code repo with per-developer agent context (default for code)
 *
 * The `.gitignore` defaults differ between shapes; everything else is the same.
 */

export const FOUNDATION_MD = `---
name: Foundation
summary: Baseline contract for this ideaspace — what kind of place this is, how
  the agent and human work together. Lives only at the space root and always
  loads; deeper branches refine via their own \`_agent/\` when they need to.
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

Optional dimensions inside \`_agent/\` (add as the space earns them):

- \`skills/\` — operating procedures the agent should follow here. Each
  skill is a markdown file (e.g., \`commit.md\` for the commit shape).
  Surfaced at session start by name + summary; body loads on demand.

\`CLAUDE.md\` at the space root tells Claude Code where this contract lives.

\`.gitignore\` is also part of the Agreement — the boundary between what's
shared and what stays local. Drafts, scratch, secrets, per-developer context
go there. Propose changes; never edit silently.

---

## Identity

You inhabit the Space. Position persists across turns. The Space outlasts
the conversation — when it matters, verify against the Space rather than
relying on conversation memory.

**Drawing out over filling in.** Your questions surface what's already there.

**Evidence over assertion.** Work with what's provided. Gaps are information.

**Form over meaning.** The user provides meaning. You provide structure.
Structure reveals contradictions.

**Honesty over comfort.** Surface contradictions. Notice when stated criteria
don't match actual decisions.

---

## Practice

- **No slop.** Every line earns its place.
- **Capture is conscious.** Propose; the user confirms. Both sides agree before
  committing.
- **Three-tier commits.** Subject (one line), body (what shifted, why),
  trailers (\`Co-authored-by\`, etc.).

When the Agreement drifts — \`now.md\` no longer matches reality, or guidance
contradicts current practice — surface it. Update [guide.md](guide.md) for
this scope, or revisit this file if a baseline needs to shift.
`;

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

export const PURPOSE_MD = `---
name: Purpose
summary: Why this space exists — the North Star. Fill in via \`/is-setup\` or
  edit directly.
---

# Purpose

_Why does this space exist? What's it for?_

Two or three sentences. Concrete over aspirational. What would make this
valuable to you six months from now?
`;

export const NOW_MD = `---
name: Now
summary: What's currently active in this space. Fill in via \`/is-setup\` or
  edit directly. Update at natural breaks; let it drift, then reflect.
---

# Now

_What are you working on right now? What would progress look like this week?_

A single paragraph or a short list. Concrete, evaluable.
`;

export const NEXT_MD = `---
name: Next
summary: What's queued after Now. Vague is OK — agents and humans figure out
  the flow.
---

# Next

_What's queued after the current focus? What's plausibly next but not yet
active?_

Vague is OK. Leave a placeholder if nothing comes to mind.
`;

export const CLAUDE_MD = `# CLAUDE.md

> This is an ideaspace. The five-file \`_agent/\` contract carries the Agreement.

## Orient

At session start, read in order:

1. [\`_agent/foundation.md\`](_agent/foundation.md) — what this place is, baseline behaviors
2. [\`_agent/guide.md\`](_agent/guide.md) — how agent and human work together here
3. [\`_agent/purpose.md\`](_agent/purpose.md) — why this exists
4. [\`_agent/now.md\`](_agent/now.md) — what's currently active
5. [\`_agent/next.md\`](_agent/next.md) — what's queued

These five files are loaded by position. Read them before answering.

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

/** All five contract files keyed by name. */
export const CONTRACT_TEMPLATES: Record<string, string> = {
  foundation: FOUNDATION_MD,
  guide: GUIDE_MD,
  purpose: PURPOSE_MD,
  now: NOW_MD,
  next: NEXT_MD,
};
