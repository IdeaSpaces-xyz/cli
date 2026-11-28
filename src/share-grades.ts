/**
 * One set of grade words for every sharing verb, the service's own: a person,
 * a team and an access request all take `explore`, `fork` or `collaborate`, and
 * `--json` carries the same three. The older words still work, so a script or
 * an agent that learned them keeps going.
 */
export type ShareGradeWord = "explore" | "fork" | "collaborate";

export const SHARE_GRADES: readonly ShareGradeWord[] = ["explore", "fork", "collaborate"];

/** Earlier words for the same three grades: the request verb's and the web's. */
const GRADE_ALIASES: Readonly<Record<string, ShareGradeWord>> = {
  viewer: "explore",
  copy: "fork",
  copying: "fork",
  "allow copying": "fork",
  "allow-copying": "fork",
  editor: "collaborate",
};

/** The grade a word names, or null for a word that names none. */
export function parseShareGrade(value: string): ShareGradeWord | null {
  const word = value.toLowerCase().trim();
  if ((SHARE_GRADES as readonly string[]).includes(word)) return word as ShareGradeWord;
  return Object.hasOwn(GRADE_ALIASES, word) ? GRADE_ALIASES[word] : null;
}

/** For help text: the three words, and the older ones that still mean them. */
export const SHARE_GRADE_HELP =
  "Grades: explore (read it), fork (read it and take an independent copy; Copy on the web), " +
  "collaborate (read and edit it). The older words viewer, copying (or copy) and editor still work.";
