export type Flags = Record<string, string | boolean>;

export const NODE_ID = /^n_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;

const THREAD_FLAGS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    list: "new unread space depth kind since limit cursor open reader",
    recent: "cursor reader limit",
    ack: "through recent reader",
    locate: "",
    open: "depth new ack since post map member checkout pin position limit order agreement reader",
    read: "depth new ack kind since post map member checkout pin position limit order agreement reader",
    new: "about attached-to map",
    attach: "message author",
    post: "map member checkout reply-to kind mark author name summary supersedes message tags no-check-links",
    posts: "space scope limit since depth order cursor",
    close: "map reply-to kind author name summary supersedes message",
    render: "",
    check: "strict",
    init: "",
    push: "remote",
    send: "space about map share share-roots space-map name summary message send-id grade",
    reply: "map name summary message send-id reply-to",
    expand: "",
    add: "grade",
    rename: "name",
  }).map(([verb, names]) => [verb, new Set(names ? names.split(" ") : [])]),
);

export function threadFlagError(verb: string, flags: Flags): string | undefined {
  const known = THREAD_FLAGS[verb];
  const unknown = known && Object.keys(flags).find((flag) => !known.has(flag));
  return unknown ? `Unknown flag for threads ${verb}: --${unknown}. Run ideaspaces threads --help for supported flags.` : undefined;
}

/** The only flags each hosted-Thread (x_<id>) verb takes; anything else is refused by name.
 * Checked instead of THREAD_FLAGS when the verb is hosted, so local verbs keep their own set. */
const HOSTED_VERB_FLAGS: Record<string, ReadonlySet<string>> = {
  list: new Set(["hosted", "limit", "cursor", "new", "unread"]),
  open: new Set(["limit", "cursor"]),
  post: new Set(["reply-to", "message", "name", "summary", "post-id", "map", "tags"]),
  new: new Set(["hosted", "name", "summary", "message", "post-id", "recipients", "map", "tags", "home"]),
  close: new Set(["message", "post-id"]),
  rename: new Set(["message", "name", "summary", "post-id"]),
  send: new Set(["name", "summary", "message", "post-id", "map", "tags", "home"]),
  ack: new Set(["seq", "cursor"]),
};

export function hostedVerbFlagError(verb: string, flags: Flags): string | undefined {
  const known = HOSTED_VERB_FLAGS[verb === "read" ? "open" : verb === "reply" ? "post" : verb];
  const unknown = known && Object.keys(flags).find((flag) => !known.has(flag));
  if (!unknown) return undefined;
  const label = unknown === "kind" && known.has("tags") ? " A hosted post's kind comes from its verb; a label goes in --tags." : "";
  return `--${unknown} is not supported by hosted threads ${verb}; it takes ${[...known].map((f) => `--${f}`).join(", ")}.${label}`;
}
