export type Flags = Record<string, string | boolean>;

export const HOSTED_THREAD_ID = /^x_[0-9a-f]{24}$/;
export const NODE_ID = /^n_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;

const THREAD_FLAGS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    list: "new space depth kind since",
    locate: "",
    open: "depth new ack since post map member checkout pin position limit order",
    read: "depth new ack kind since post map member checkout pin position limit order",
    new: "about",
    post: "map member checkout reply-to kind author name summary supersedes message tags",
    posts: "space scope limit since depth order cursor",
    close: "map reply-to kind author name summary supersedes message",
    render: "",
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
