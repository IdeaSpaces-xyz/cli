/**
 * Default template — minimal scaffolding for `ideaspaces create`.
 *
 * Templates ship as inline string constants compiled into the CLI bundle.
 *
 * The current scaffold is one contract file, `_agent/agreement.md`, written
 * under one of the two kinds IdeaSpaces listens for — a knowledge space or
 * an agent — and referencing that kind's public Agreement Space through the
 * protocol's `agreement:` frontmatter field. Its sections ship as prompts:
 * the agent draws them out in conversation and replaces them. Nothing else
 * is scaffolded beside it; `purpose.md`, `now.md`, and `skills/` come when
 * there is something real to put in them.
 *
 * The Foundation scaffold below it (`foundation.md` + `guide.md` + the
 * convention READMEs) is the older shape, kept behind `create --foundation`
 * for one release. Its conduct section is the protocol's canonical
 * FOUNDATION_CORE, composed in at bundle time and stamped with core_version.
 *
 * Two shapes for `_agent/` visibility (set by the create command per the
 * detected target shape):
 *   - shared: content space or opt-in shared code repo (default for content)
 *   - private: code repo with per-developer agent context (default for code)
 *
 * The `.gitignore` defaults differ between shapes; everything else is the same.
 */

import { FOUNDATION_CORE, FOUNDATION_CORE_VERSION } from "@ideaspaces/protocol";

/** Shared closing block for both foundation variants — one source, no drift. */
const FOUNDATION_CLOSING = `---

## The Agreement

${FOUNDATION_CORE.trim()}

---

## Practice

- **No slop.** Every line earns its place.
- **Three-tier commits.** Subject (one line), body (what shifted, why),
  trailers (\`Co-authored-by\`, etc.).
`;

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

${FOUNDATION_CLOSING}`;

/**
 * Agent variant (`create --agent`): the space IS the character.
 * Same five-file contract, same protocol conduct core — read agent-first:
 * foundation declares the agent's point of view, guide is how work goes when
 * inhabiting it, skills are what the agent can repeat. Character sections
 * ship as prompts, not filler — the agent draws them out in conversation and
 * replaces them with real content.
 */
export function agentFoundationMd(agentName: string): string {
  return `---
name: Foundation — ${agentName}
summary: What ${agentName} is. This space is not a subject to study — it is
  ${agentName}'s point of view, inhabited by an agent. Character, boundaries,
  and what ${agentName} is not.
core_version: ${FOUNDATION_CORE_VERSION}
---

# Foundation — ${agentName}

> This space is ${agentName}'s **point of view** — the *vantage* it works
> from — not a subject to study. An agent launched here inhabits ${agentName}: nothing
> in this tree is knowledge *about* ${agentName} — it is the place ${agentName}
> looks from, and the memory that place accumulates.

This file declares that point of view. The tool running the agent (Claude
Code, Pi, …) supplies the model and its reach; this space supplies who the
agent is.

Five files, in the order an agent reads them:

- \`foundation.md\` — this file. What ${agentName} is, character, boundaries.
- \`guide.md\` — how work goes when inhabiting ${agentName}.
- \`purpose.md\` — why ${agentName} exists (emergent).
- \`now.md\` — the current lane (emergent).
- \`next.md\` — what's queued (emergent).

## Character

_Draw out and replace: how does ${agentName} show up? Three to five traits,
each one bolded line + one sentence of what it means in practice. Drawn from
real examples of the work, not adjectives._

## Boundaries

_Draw out and replace: what does ${agentName} refuse to do, and what does it
never claim without checking? Boundaries are what make an agent trustworthy
enough to delegate to._

## What ${agentName} is not

_Draw out and replace: name the neighboring role people might confuse this
with, and where the line sits._

Dimensions inside \`_agent/\` (grown as the character earns them):

- \`skills/\` — what ${agentName} can repeat: procedures worth doing the same
  way every time. Each skill's \`description\` is its trigger; skills compose
  along the path.
- \`perspectives/\` — how ${agentName} sees: reusable thinking patterns.

The content tree is ${agentName}'s memory — what it has produced and learned.
Nothing is saved there without agreement — the handshake below.

${FOUNDATION_CLOSING}`;
}

/**
 * The two kinds IdeaSpaces listens for, as the protocol's
 * `<kind>:repo:<root_node_id>` references to their public Agreement Spaces.
 * The ids are the ones SPEC.md names as the standard public examples.
 */
export const KIND_REFERENCES = Object.freeze({
  knowledge: "knowledge:repo:n_f1511280efecd7fcff155152",
  agent: "agent:repo:n_0935a5df1f883eeb60bcdfbb",
});

export type Kind = keyof typeof KIND_REFERENCES;

/** Public page of each kind — where the shape the prompts ask for is explained. */
const KIND_PAGES: Record<Kind, string> = {
  knowledge: "https://ideaspaces.xyz/repos/n_f1511280efecd7fcff155152",
  agent: "https://ideaspaces.xyz/repos/n_0935a5df1f883eeb60bcdfbb",
};

/**
 * The Agreement's `name:` for a user-supplied folder name. Plain when the
 * name is frontmatter-safe; otherwise a JSON string, which YAML reads verbatim.
 * `--agent` refuses unsafe names up front; the knowledge shape takes the
 * folder as it is.
 */
function agreementTitle(name: string): string {
  const title = `Agreement — ${name}`;
  return isSafeAgentName(name) ? title : JSON.stringify(title);
}

const PROMPTS_NOTE = `> Every section below is a prompt, not content. Draw it out in conversation — cases, in the owner's
> own words — and replace it. Thin is honest; invented is not.`;

const AGREEMENT_TAIL = (page: string) => `## Alone, and brought back

Alone: _what may be done without asking_. Brought back: _what must be shown first_, and any change to
this file.

## Words with local meaning

- **_term_** — _what it means here_

## Still open

- _What is not decided yet, named so the work can start anyway._

## When to revisit

_What would say this is set up wrong — the signals that should reopen this file._

---

The shape of this file, and a complete example to compare against, are at ${page}.
`;

/**
 * Knowledge-space Agreement: the default scaffold. References the Knowledge
 * kind; every section is a prompt to be replaced in conversation.
 */
export function knowledgeAgreementMd(name: string): string {
  return `---
name: ${agreementTitle(name)}
summary: What this place is and how work goes here, in two sentences. A prompt — replace it in
  conversation before the first capture.
agreement: ${KIND_REFERENCES.knowledge}
---

# Agreement — ${name}

${PROMPTS_NOTE}

## What this place is

_The story. The last time this was needed — what was being done, what got in the way, what this
place should make possible next week that it cannot today._

## How work goes here

_Three to six lines: what lands where, what a good result looks like. A Note is one file with a
two-line summary at the top, in a folder named for what it is about. The agent proposes; the owner
confirms. Nothing lands otherwise._

${AGREEMENT_TAIL(KIND_PAGES.knowledge)}`;
}

/**
 * Agent Agreement (`create --agent`): the folder IS the agent. References the
 * Agent kind; the opener declares point of view, the rest are prompts.
 */
export function agentAgreementMd(agentName: string): string {
  return `---
name: Agreement — ${agentName}
summary: ${agentName} is … (one sentence — what it does, for whom). Launching here means being
  ${agentName} — … (one sentence — the core of how it works and its hardest boundary). A prompt;
  replace it in conversation.
agreement: ${KIND_REFERENCES.agent}
---

# Agreement — ${agentName}

This folder is ${agentName}'s **point of view**, not a subject to study. An agent launched here is
${agentName} for the session. Nothing in this folder is knowledge *about* ${agentName}; it is the
place ${agentName} looks from and what it has produced.

${PROMPTS_NOTE}

## What this place is

_What ${agentName} reads, what it produces, for whom — from a task the owner would hand it._

## Character

- **_Trait._** _One sentence of what it means in practice — something you could check in an output.
  Three to five of these; "helpful and concise" is nothing, "cuts any line it cannot link to a
  source" is a trait._

## Boundaries

- Never _…_.
- Never claims _…_ without _…_.

## What ${agentName} is not

_The neighbouring role someone might confuse this with, where the line sits, and when to hand back._

## How a task goes

1. _…_
2. _…_

${AGREEMENT_TAIL(KIND_PAGES.agent)}`;
}

/** Contract files for an Agreement scaffold, keyed by entrypoint name. */
export function agreementContractTemplates(kind: Kind, name: string): Record<string, string> {
  return { agreement: kind === "agent" ? agentAgreementMd(name) : knowledgeAgreementMd(name) };
}

export const HOME_MAP_MD = `---
name: Home
summary: Everything this folder holds. Each space here is its own repo, pinned by identity and commit, never copied in.
map:
  roots: []
  members: []
---

# Home

Each space this folder holds is pinned here by identity and commit, and opened from here.
`;

/**
 * Home's three goal prompts. The first conversation in a fresh Home asks them;
 * the answers replace them in this Agreement.
 */
export const HOME_GOAL_PROMPTS = Object.freeze([
  "What this place is",
  "What we hold here",
  "What we want to accomplish",
] as const);

export const HOME_AGREEMENT_MD = `---
name: Agreement — Home
summary: Home, this folder's own place. What it is for is not written yet. A prompt — the first
  conversation asks, and the answers replace this line.
agreement: ${KIND_REFERENCES.knowledge}
---

# Agreement — Home

> The three sections below are prompts, not content. The first conversation here asks them, in the
> owner's own words, and replaces them. Thin is honest; invented is not.

## ${HOME_GOAL_PROMPTS[0]}

_A prompt. Whose place this is and what it is about, in a sentence or two._

## ${HOME_GOAL_PROMPTS[1]}

_A prompt. What lives here: the kinds of notes, sources, projects and agents this place keeps._

## ${HOME_GOAL_PROMPTS[2]}

_A prompt. What this place should make possible, and how you would know it worked._

## How work goes here

Home is this folder. Every other space it holds (a knowledge repo, an agent, a code repo) is its own repo, pinned in \`home.map.md\` by identity and commit and opened from here, never copied in. A Thread is how something gets worked on: a folder in \`_threads/\`, one Markdown file per post, picked up again from its last post.

## Alone, and brought back

Alone: start a local Thread or append to one, read any space Home pins, add a space to \`home.map.md\`. Brought back: creating, erasing or moving a space, publishing anything, sharing a Thread beyond this machine, and any change to this file.

## Words with local meaning

- **Space** — a \`.map.md\` file, opened. In the folder it is a Note with pointers.
- **Thread** — a folder in \`_threads/\`: an Agreement for its terms, a README that tells what it has become, and dated posts, one file each, never changed.
- **Home** — this folder.
- **Child** — a repo pinned by \`home.map.md\`, never tracked by Home's own Git.

## When to revisit

When something is copied here instead of pinned. When a Thread cannot be picked up again from its last post.
`;

/**
 * The procedure a conversation with no agent follows in a fresh Space: ask
 * the three goal prompts, write the answers after a yes, open the first
 * Thread, and create agents or knowledge repos on request. Harness-neutral:
 * no tool or button names a single surface owns.
 */
export const HOME_FIRST_CONVERSATION_SKILL_MD = `---
name: first-conversation
description: A fresh Space's first conversation, with no agent. Ask what this place is, what it holds and what it should accomplish; write the answers into its Agreement after the person's yes; open its first Thread; create an agent or a knowledge repo when asked.
---

# First conversation

Use this when a conversation here has no agent and the place's goal is still prompts. Also use it
when the person asks to say again what this place is for, or to add an agent or a knowledge repo.

There is no agent in this conversation and no point of view to speak from. Talk plainly, as help
in this place. The only frame is the place's goal. Never invent the answers: a short answer in the
person's own words is right. Write only what the person said, with no name, date or detail they
did not give, even one you could find elsewhere.

## 1. Ask the three questions

1. **What is this place?** Whose it is, and what it is about.
2. **What do we hold here?** The kinds of notes, sources, projects and agents it keeps.
3. **What do we want to accomplish?** What it should make possible, and how they would know it
   worked.

If the person's first message already answers some of them, say back what you understood and ask
only for what is missing. Ask one follow-up at most. If they don't want to answer now, stop. The
prompts stay as they are, and that is fine.

## 2. Show the text, then wait for a yes

Show the exact text you would write, and say which file it goes to. Write nothing until the person
says yes in words. If they change something, show the text again.

- **Home**, the folder with \`home.map.md\` at its root: write its \`_agent/agreement.md\`. Replace
  the three prompt sections (*What this place is*, *What we hold here*, *What we want to
  accomplish*), the prompt note above them, and the \`summary:\` line with two sentences from the
  answers. Keep every other section and every other frontmatter field (\`name\`, \`agreement\`,
  \`root_node_id\`) exactly as they are.
- **Any other Space:** its goal lives in its Core Thread's \`_agent/agreement.md\` (the Space's
  orientation names the Core Thread). Replace its Goal section and its \`summary:\` line the same way.
  If it has no Core Thread, the answers go into the first Thread (step 4).

## 3. Write, then commit only that file

Read the file and its current revision first. Write it whole, with the change, and stage it. Then
commit only that path, with a message in the person's terms ("Say what this place is for"). Tell
the person where the file is: it is theirs to read and edit. If the commit fails, say the file is
saved but not committed, and why.

The answers are your own words in this conversation, so you already know them. Re-read the file
before you change it again.

## 4. Open the first Thread

- **No Core Thread yet** (a fresh Home): open the Space's Core Thread, named in the person's words
  (for example "What this place is for"). Its opening post carries the three answers. Use the tool
  this surface gives for a Core Thread on an existing Map. Where there is none, start a local
  Thread with \`ideaspaces threads new\` and say it is not yet the Space's Core.
- **A Core Thread exists** (a Space made with one): post the three answers to it, as a reply to its
  opening post.

Tell the person where the Thread is. Offer to commit it, with the Map's change if there is one, and
commit only those paths after a yes.

## 5. An agent or a knowledge repo, when asked

Explain the difference once, briefly, in the person's terms:

- A **knowledge repo** is a folder of Notes about one subject, with its own history.
- An **agent** is a folder that is a point of view: its Agreement says who it is, what it does and
  what it never does. A conversation can start with it once it is in the Space.

The person asking for one is the approval to create it. Use the name they chose: letters, digits,
spaces, \`.\`, \`_\` or \`-\`, and no \`/\`.

- An agent: in Home's \`agents/\` folder (make it first if it is missing), run
  \`ideaspaces create <name> --agent --yes\`. It becomes \`agents/<name>\`.
- A knowledge repo: in Home's root, run \`ideaspaces create <name> --yes\`.

Each one is its own Git repo, with its own identity. Then:

1. Add it to this Space: the Space's curation tool, or
   \`ideaspaces map add home.map.md --position . --checkout <path>\`.
2. Add \`/<path>/\` to Home's \`.gitignore\`: Home's own Git never tracks a child. Commit
   \`.gitignore\` with the person's yes.
3. Its Agreement's sections are prompts too. Offer to draw them out now, the same way: ask, show,
   write after a yes, commit.

Then tell the person the new agent can be chosen for the next conversation in this Space.
`;

export const HOME_CLAUDE_MD = `---
name: Claude Code orientation — Home
summary: This folder is Home. Read the Agreement first, then open home.map.md, which is the Space.
---

# CLAUDE.md

This folder is Home. Read [\`_agent/agreement.md\`](_agent/agreement.md) first, then open \`home.map.md\`, which is the Space. While the Agreement's first three sections are still prompts, the first conversation follows [\`_agent/skills/first-conversation.md\`](_agent/skills/first-conversation.md).
`;

/** Claude Code orientation for an Agreement Space — it points, it does not repeat. */
export function agreementClaudeMd(kind: Kind, name: string): string {
  if (kind === "agent") {
    return `---
name: Claude Code orientation — ${name}
summary: Launching here means being ${name}, not studying it. Read the Agreement first.
---

# CLAUDE.md — ${name}

Launching here means **being ${name}**, not studying it. Read [\`_agent/agreement.md\`](_agent/agreement.md)
first — it is who you are for the session. While its sections are still prompts, the first
conversation is drawing out who ${name} is, from real tasks, and replacing them.
`;
  }
  return `---
name: Claude Code orientation
summary: This folder is an ideaspace. Read the Agreement first — it says what this place is and how
  work goes here.
---

# CLAUDE.md

This folder is an ideaspace. Read [\`_agent/agreement.md\`](_agent/agreement.md) first — it says what
this place is and how work goes here. While its sections are still prompts, the first conversation
is drawing them out with the owner and replacing them. Knowledge lands as Notes: one file, a two-line
summary at the top, proposed by the agent and confirmed by the owner.
`;
}

/**
 * Agent names land verbatim in YAML frontmatter values and prose. Rather than
 * inventing an escaping scheme, accept names that are safe in both: letters,
 * digits, then spaces/dots/underscores/hyphens. Everything else is refused up
 * front, like the code-repo shape.
 */
export function isSafeAgentName(name: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(name) && !/[ ]$/.test(name);
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
surface it. Character changes get proposed and confirmed like anything else
saved here.
`;
}

export function agentClaudeMd(agentName: string): string {
  return `---
name: Claude Code orientation — ${agentName}
summary: Tells Claude Code this space is ${agentName}'s point of view, not a
  subject. Launching here means inhabiting ${agentName}.
---

# CLAUDE.md — ${agentName}

> This ideaspace is ${agentName}'s **point of view**, not a subject.
> Launching here means inhabiting ${agentName}, not studying it.

## Orient

Read in order:

1. [\`_agent/foundation.md\`](_agent/foundation.md) — who ${agentName} is:
   character and boundaries
2. [\`_agent/guide.md\`](_agent/guide.md) — how work goes when inhabiting it
3. \`_agent/purpose.md\` / \`_agent/now.md\` / \`_agent/next.md\` — direction
   (emergent; their absence is a prompt to draw them out, not invent them)

If the Character, Boundaries, or "What ${agentName} is not" sections still
carry their placeholder prompts, that is the first conversation: draw the
character out from the user with real examples, replace the prompts, and
confirm before committing.

## The work

The content tree here is ${agentName}'s memory. The subject of the work may
live elsewhere — this space carries the point of view it is seen from.
`;
}

/** Contract files for an agent scaffold, keyed like CONTRACT_TEMPLATES. */
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

Each skill is a markdown file with \`name\` + \`description\` frontmatter.
The filename stem and frontmatter \`name\` are the same portable id: 1–64
lowercase letters, digits, or single hyphens (for example,
\`weekly-review.md\` with \`name: weekly-review\`). Put the human-readable
title in the Markdown heading. The description is the trigger — it tells the
agent when the skill applies. Skills compose along the path: a skill here
reaches every position below, and a deeper \`_agent/skills/\` file with the
same name shadows this one.
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
  lines.push(
    "*.draft.md",
    "scratch/",
    "_local/",
    "# Local-only material — yours, on this machine. Never synced or shared.",
    "*.local.md",
    "",
  );
  return lines.join("\n");
}

/**
 * The `.gitignore` a scaffold should write, or `null` when the defaults are
 * already in place and the file must be left alone.
 *
 * Shared by `create` and `fork` so the two scaffolds cannot drift on what
 * local-only means. Pass `null` for `existing` when there is no `.gitignore` —
 * the state every forked Space arrives in.
 */
export function gitignoreWithDefaults(
  existing: string | null,
  opts: { privateAgent: boolean },
): string | null {
  const additions = gitignoreDefaults(opts);
  if (existing === null) return additions.replace(/^\n/, "");
  if (existing.includes("# ideaspace defaults")) return null;
  return existing.endsWith("\n") ? existing + additions : existing + "\n" + additions;
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
