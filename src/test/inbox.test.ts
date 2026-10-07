import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UnauthorizedError } from "../auth/api.js";
import type { GlobalFlags } from "../types.js";

const {
  loadConfigMock,
  fetchInboxMock,
  fetchExchangeMock,
  fetchSpaceThreadsMock,
  acknowledgeSubscriptionMock,
  fetchExchangeMapMemberMock,
  fetchSubscriptionEventsMock,
  listSubscriptionsMock,
  sendInquiryMock,
  replyToExchangeMock,
  addPersonShareMock,
  addExchangePersonMock, closeExchangeMock, renameExchangeMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchInboxMock: vi.fn(),
  fetchExchangeMock: vi.fn(),
  fetchSpaceThreadsMock: vi.fn(),
  acknowledgeSubscriptionMock: vi.fn(),
  fetchExchangeMapMemberMock: vi.fn(),
  fetchSubscriptionEventsMock: vi.fn(),
  listSubscriptionsMock: vi.fn(),
  sendInquiryMock: vi.fn(),
  replyToExchangeMock: vi.fn(),
  addPersonShareMock: vi.fn(),
  addExchangePersonMock: vi.fn(), closeExchangeMock: vi.fn(), renameExchangeMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    fetchInbox: fetchInboxMock,
    fetchExchange: fetchExchangeMock,
    fetchSpaceThreads: fetchSpaceThreadsMock,
    acknowledgeSubscription: acknowledgeSubscriptionMock,
    fetchExchangeMapMember: fetchExchangeMapMemberMock,
    fetchSubscriptionEvents: fetchSubscriptionEventsMock,
    listSubscriptions: listSubscriptionsMock,
    sendInquiry: sendInquiryMock,
    replyToExchange: replyToExchangeMock,
    addPersonShare: addPersonShareMock,
    addExchangePerson: addExchangePersonMock,
    closeExchange: closeExchangeMock,
    renameExchange: renameExchangeMock,
  };
});

const { inboxCommand } = await import("../commands/inbox.js");
const { threadsCommand } = await import("../commands/threads.js");

const CFG = { apiUrl: "https://api.example.test", apiKey: "k" };
const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const TEXT_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };
const TARGET = "n_0123456789abcdef01234567";

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset().mockReturnValue(CFG);
  fetchInboxMock.mockReset();
  fetchExchangeMock.mockReset();
  fetchSpaceThreadsMock.mockReset();
  acknowledgeSubscriptionMock.mockReset();
  fetchExchangeMapMemberMock.mockReset();
  fetchSubscriptionEventsMock.mockReset().mockResolvedValue([]);
  listSubscriptionsMock.mockReset();
  sendInquiryMock.mockReset();
  replyToExchangeMock.mockReset();
  addPersonShareMock.mockReset();
  addExchangePersonMock.mockReset(); closeExchangeMock.mockReset(); renameExchangeMock.mockReset();
  stdoutChunks = [];
  stderrChunks = [];
  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

const participant = (id: number, name: string) => ({
  participant: `person:user_${id}`,
  username: name.toLowerCase(),
  name,
  person_node_id: `n_person_${id}`,
});

const message = {
  note_node_id: "n_note",
  name: "Question",
  summary: "A focused question",
  author_ref: "person:user_1",
  actor_ref: "person:user_1",
  surface: "human" as const,
  action: "inquiry.opened" as const,
  recipient_ref: "person:user_2",
  position: 1,
  created_at: "2026-08-29T00:00:00Z",
  event_at: "2026-08-29T00:00:00Z",
};

const map = {
  roots: [{
    repo: "https://ideaspaces.xyz/repos/n_0123456789abcdef01234567",
    root_node_id: "n_0123456789abcdef01234567",
    sha: "a".repeat(40),
  }],
  members: [
    {
      root: 0,
      position: "notes/finding.md",
      depth: "surface" as const,
      name: "Why this Note",
      disclosure: { name: "Finding", summary: "Observed at the pin." },
    },
    {
      address: "hostname:example.com",
      depth: "summary" as const,
      disclosure: { name: "Example", summary: "Observed when sent." },
    },
  ],
};

const selection = {
  kind: "exchange-map-selection",
  target_node_id: TARGET,
  map,
};

const writeResult = {
  note_node_id: "n_note",
  exchange_id: "x_one",
  event_id: "evt_one",
  position: 1,
  created_at: "2026-08-29T00:00:00Z",
  target_node_id: TARGET,
  author_ref: "person:user_1",
  recipient_ref: "person:user_2",
  actor_ref: "person:user_1",
  surface: "human" as const,
  action: "inquiry.opened" as const,
};

describe("inbox", () => {
  it("lists threads as JSON", async () => {
    fetchInboxMock.mockResolvedValue({
      items: [{
        kind: "inquiry",
        mode: "direct",
        exchange_id: "x_one",
        target_node_id: TARGET,
        participants: [participant(1, "One"), participant(2, "Two")],
        opening_note: message,
        latest_message: message,
        latest_position: 1,
        latest_received_position: 1,
        message_count: 1,
        received_message_count: 1,
      }],
    });

    const code = await inboxCommand.run(["list"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(fetchInboxMock).toHaveBeenCalledWith(CFG);
    expect(JSON.parse(stdout()).items[0]).toMatchObject({ exchange_id: "x_one", target_node_id: TARGET });
  });

  it("renders complete exchange Markdown for a party", async () => {
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_one",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [{ ...message, markdown: "# Question\n\nWhat next?" }],
    });

    const code = await inboxCommand.run(["read", "x_one"], {}, TEXT_GLOBAL);

    expect(code).toBe(0);
    expect(fetchExchangeMock).toHaveBeenCalledWith(CFG, "x_one");
    expect(stdout()).toContain("Thread x_one");
    expect(stdout()).toContain("# Question\n\nWhat next?");
  });

  it("bounds hosted Thread disclosure and selects one immutable Note by id", async () => {
    const dated = [
      { ...message, note_node_id: "n_first", created_at: "2026-10-06T00:00:00Z", position: 1, markdown: "Old private body" },
      { ...message, note_node_id: "n_second", created_at: "2026-10-07T00:00:00Z", position: 2, markdown: "Selected body" },
    ];
    fetchExchangeMock.mockResolvedValue({ exchange_id: "x_one", name: "Thread", your_grade: "view", target_node_id: null,
      participants: [], cursor: 1, latest_position: 2, messages: dated });
    expect(await inboxCommand.run(["read", "x_one"], { depth: "summary", new: true }, JSON_GLOBAL)).toBe(0);
    let result = JSON.parse(stdout());
    expect(result.messages).toMatchObject([{ id: "n_second", kind: "inquiry.opened", date: "2026-10-07T00:00:00Z", in_reply_to: null }]);
    expect(stdout()).not.toContain("Selected body");
    stdoutChunks = [];
    expect(await inboxCommand.run(["read", "x_one"], { depth: "name" }, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout()).messages).toEqual([]);
    stdoutChunks = [];
    expect(await inboxCommand.run(["read", "x_one"], { depth: "summary", since: "n_first" }, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout()).messages.map((p: { id: string }) => p.id)).toEqual(["n_second"]);
    stdoutChunks = [];
    expect(await inboxCommand.run(["read", "x_one"], { depth: "summary", since: "2026-10-06T00:00:00Z" }, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout()).messages.map((p: { id: string }) => p.id)).toEqual(["n_second"]);
    stdoutChunks = [];
    expect(await inboxCommand.run(["read", "x_one"], { depth: "surface", post: "n_second" }, JSON_GLOBAL)).toBe(0);
    result = JSON.parse(stdout());
    expect(result.messages).toMatchObject([{ note_node_id: "n_second", markdown: "Selected body" }]);
    expect(stdout()).not.toContain("Old private body");
    expect(await inboxCommand.run(["read", "x_one"], { depth: "children" }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("do not expose reply-parent links");
  });

  it("renders preserved Map context without losing the question", async () => {
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_one",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [{ ...message, markdown: "# Question\n\nWhat next?", map }],
    });

    const code = await inboxCommand.run(["read", "x_one"], {}, TEXT_GLOBAL);

    expect(code).toBe(0);
    expect(stdout()).toContain("Context Map (2 ordered members)");
    expect(stdout()).toContain("observed name=\"Finding\" summary=\"Observed at the pin.\"");
    expect(stdout()).toContain("curated name=\"Why this Note\"");
    expect(stdout()).toContain("# Question\n\nWhat next?");
  });

  it("lists only followed Threads newer than their cursor at name depth", async () => {
    fetchInboxMock.mockResolvedValue({
      items: [
        {
          kind: "inquiry",
          mode: "direct",
          exchange_id: "x_new",
          target_node_id: TARGET,
          participants: [participant(1, "One"), participant(2, "Two")],
          opening_note: message,
          latest_message: { ...message, name: "New answer", position: 4 },
          latest_position: 4,
          cursor: 2,
          latest_received_position: 4,
          message_count: 2,
          received_message_count: 1,
        },
        {
          kind: "inquiry",
          mode: "direct",
          exchange_id: "x_seen",
          target_node_id: TARGET,
          participants: [participant(1, "One"), participant(2, "Two")],
          opening_note: message,
          latest_message: message,
          latest_position: 1,
          cursor: 1,
          latest_received_position: 1,
          message_count: 1,
          received_message_count: 1,
        },
      ],
    });

    const code = await inboxCommand.run(["list"], { new: true, depth: "name" }, TEXT_GLOBAL);

    expect(code).toBe(0);
    expect(stdout()).toContain("x_new  New answer");
    expect(stdout()).not.toContain("x_seen");
  });

  it("rejects --new for access requests because they have no followed cursor", async () => {
    const code = await inboxCommand.run(
      ["list"],
      { new: true, kind: "request" },
      TEXT_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("access requests have no followed cursor");
    expect(fetchInboxMock).not.toHaveBeenCalled();
  });

  it("renders only reframe Notes at full depth", async () => {
    fetchInboxMock.mockResolvedValue({
      items: [{
        kind: "inquiry",
        mode: "direct",
        exchange_id: "x_one",
        target_node_id: TARGET,
        participants: [participant(1, "One"), participant(2, "Two")],
        opening_note: message,
        latest_message: { ...message, note_node_id: "n_reply", name: "Later reply", position: 6 },
        latest_position: 6,
        cursor: 1,
        latest_received_position: 6,
        message_count: 3,
        received_message_count: 2,
      }],
    });
    fetchSubscriptionEventsMock.mockResolvedValue([{
      action: "thread.reframed",
      exchange_id: "x_one",
      note_node_id: "n_reframe",
      position: 5,
    }]);
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_one",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [
        { ...message, markdown: "# Original\n\nHidden by the kind filter." },
        { ...message, note_node_id: "n_reframe", name: "New frame", position: 4, markdown: "# New frame" },
        { ...message, note_node_id: "n_reply", name: "Later reply", position: 6, markdown: "# Later reply" },
      ],
      subject: { opening_note_id: "n_note", current_note_id: "n_reframe" },
      latest_position: 6,
      cursor: 1,
    });

    const code = await inboxCommand.run(
      ["list"],
      { kind: "reframe", depth: "full" },
      TEXT_GLOBAL,
    );

    expect(code).toBe(0);
    expect(stdout()).toContain("# New frame");
    expect(stdout()).not.toContain("Hidden by the kind filter");
    expect(stdout()).not.toContain("# Later reply");
  });

  it("reads only new Notes and explicitly advances the followed Thread cursor", async () => {
    const reply = {
      ...message,
      note_node_id: "n_reply",
      name: "Answer",
      summary: "The new answer",
      action: "note.replied" as const,
      author_ref: "person:user_2",
      recipient_ref: "person:user_1",
      position: 3,
      markdown: "# Answer\n\nShip it.",
    };
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_one",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [{ ...message, markdown: "# Question" }, reply],
      subject: { opening_note_id: "n_note", current_note_id: "n_note" },
      latest_position: 3,
      cursor: 1,
    });
    listSubscriptionsMock.mockResolvedValue([{
      id: "fol_0123456789abcdef01234567",
      source_kind: "exchange",
      source_id: "x_one",
      filter: "follow",
      cursor: 1,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    }]);
    acknowledgeSubscriptionMock.mockResolvedValue({ cursor: 3 });

    const code = await inboxCommand.run(
      ["read", "x_one"],
      { new: true, depth: "full", ack: true },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(acknowledgeSubscriptionMock).toHaveBeenCalledWith(
      CFG,
      "fol_0123456789abcdef01234567",
      3,
    );
    expect(JSON.parse(stdout())).toMatchObject({
      messages: [{ note_node_id: "n_reply" }],
      acknowledged_cursor: 3,
    });
  });

  it("reads reframe events as their subject Notes", async () => {
    const reframed = {
      ...message,
      note_node_id: "n_reframe",
      name: "New frame",
      action: "note.replied" as const,
      position: 4,
      markdown: "# New frame",
    };
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_one",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [{ ...message, markdown: "# Question" }, reframed],
      subject: { opening_note_id: "n_note", current_note_id: "n_reframe" },
      latest_position: 5,
      cursor: 1,
    });
    fetchSubscriptionEventsMock.mockResolvedValue([{
      follow_ids: ["fol_0123456789abcdef01234567"],
      position: 5,
      event_id: "evt_reframe",
      v: 1,
      ts: "2026-09-20T00:00:00Z",
      actor_ref: "person:user_1",
      surface: "human",
      action: "thread.reframed",
      target_node_id: TARGET,
      recipient_ref: null,
      note_node_id: "n_reframe",
      exchange_id: "x_one",
      outcome: null,
      retention_class: "coordination",
    }]);

    const code = await inboxCommand.run(
      ["read", "x_one"],
      { new: true, kind: "reframe", depth: "summary" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(fetchSubscriptionEventsMock).toHaveBeenCalledWith(CFG, 1_000);
    expect(JSON.parse(stdout())).toMatchObject({
      messages: [{ note_node_id: "n_reframe" }],
      events: [{ action: "thread.reframed" }],
    });
  });

  it("refuses acknowledgement when a filter would hide unread events", async () => {
    expect(await inboxCommand.run(
      ["read", "x_one"],
      { new: true, kind: "reframe", ack: true },
      TEXT_GLOBAL,
    )).toBe(1);
    expect(stderr()).toContain("hidden message events would be marked read");
    expect(fetchExchangeMock).not.toHaveBeenCalled();
    expect(acknowledgeSubscriptionMock).not.toHaveBeenCalled();

    stderrChunks = [];
    expect(await inboxCommand.run(
      ["read", "x_one"],
      { since: "20", ack: true },
      TEXT_GLOBAL,
    )).toBe(1);
    expect(stderr()).toContain("omitted events would be marked read");
  });

  it("fails loudly when the bounded reframe feed may be truncated", async () => {
    fetchInboxMock.mockResolvedValue({ items: [] });
    fetchSubscriptionEventsMock.mockResolvedValue(
      Array.from({ length: 1_000 }, (_, position) => ({
        action: "thread.reframed",
        exchange_id: `x_${position}`,
        position,
      })),
    );

    const code = await inboxCommand.run(["list"], { kind: "reframe" }, TEXT_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("1,000-event safety bound");
  });

  it("sends only a reviewed Map selection and infers its target", async () => {
    sendInquiryMock.mockResolvedValue(writeResult);
    const file = join(tmpdir(), `is-cli-map-selection-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(selection));
    try {
      const code = await inboxCommand.run(
        ["send", "@two"],
        {
          map: file,
          name: "Question",
          summary: "A focused question",
          message: "# Question\n\nWhat next?",
          "send-id": "send-map",
        },
        JSON_GLOBAL,
      );

      expect(code).toBe(0);
      expect(sendInquiryMock).toHaveBeenCalledWith(CFG, {
        target_node_id: TARGET,
        recipient: { username: "two" },
        send_id: "send-map",
        name: "Question",
        summary: "A focused question",
        markdown: "# Question\n\nWhat next?",
        map,
      });
    } finally {
      unlinkSync(file);
    }
  });

  it("refuses a target that disagrees with the reviewed selection", async () => {
    const file = join(tmpdir(), `is-cli-map-selection-mismatch-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(selection));
    try {
      const code = await inboxCommand.run(
        ["send", "@two"],
        {
          map: file,
          about: "n_abcdefabcdefabcdefabcdef",
          name: "Question",
          summary: "Summary",
          message: "Body",
        },
        TEXT_GLOBAL,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("does not match");
      expect(sendInquiryMock).not.toHaveBeenCalled();
    } finally {
      unlinkSync(file);
    }
  });

  it("expands one member while retaining its exact root reference", async () => {
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_one",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [{ ...message, markdown: "Question", map }],
    });
    fetchExchangeMapMemberMock.mockResolvedValue({
      member_ordinal: 0,
      member: map.members[0],
      representation: { name: "Finding", summary: "Observed at the pin.", surface: "# Finding" },
    });

    const code = await inboxCommand.run(["expand", "x_one", "0"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(fetchExchangeMapMemberMock).toHaveBeenCalledWith(CFG, "x_one", 0);
    expect(JSON.parse(stdout())).toMatchObject({
      member_ordinal: 0,
      map: { roots: map.roots, members: [map.members[0]] },
      representation: { surface: "# Finding" },
    });
  });

  it("renders expansion as reference, ceiling, preserved disclosure, and resolved content", async () => {
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_one",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [{ ...message, markdown: "Question", map }],
    });
    fetchExchangeMapMemberMock.mockResolvedValue({
      member_ordinal: 0,
      member: map.members[0],
      representation: { name: "Finding", summary: "Observed at the pin.", surface: "# Finding\n\nExact body." },
    });

    const code = await inboxCommand.run(["expand", "x_one", "0"], {}, TEXT_GLOBAL);

    expect(code).toBe(0);
    expect(stdout()).toContain(`${map.roots[0].root_node_id}@${map.roots[0].sha}:notes/finding.md`);
    expect(stdout()).toContain("Declared ceiling: surface");
    expect(stdout()).toContain("observed name=\"Finding\" summary=\"Observed at the pin.\"");
    expect(stdout()).toContain("Resolved representation:");
    expect(stdout()).toContain("# Finding\n\nExact body.");
  });

  it("handles a refused member expansion with You need access and request instructions", async () => {
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_one",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [{ ...message, markdown: "Question", map }],
    });
    fetchExchangeMapMemberMock.mockRejectedValue(new Error("Exchange or map source not found"));

    const textCode = await inboxCommand.run(["expand", "x_one", "0"], {}, TEXT_GLOBAL);
    expect(textCode).toBe(0);
    expect(stdout()).toContain("You need access to read this member.");
    expect(stdout()).toContain("Name: Finding");
    expect(stdout()).toContain("Request access with:");
    expect(stdout()).toContain(`ideaspaces request ${map.roots[0].root_node_id} --grade viewer`);

    stdoutChunks = [];
    const jsonCode = await inboxCommand.run(["expand", "x_one", "0"], {}, JSON_GLOBAL);
    expect(jsonCode).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      status: "refused",
      reason: "you_need_access",
      member_ordinal: 0,
      target_node_id: map.roots[0].root_node_id,
    });
  });

  it("sends view grade explicitly and defaults to participate when omitted", async () => {
    sendInquiryMock.mockResolvedValue({ ...writeResult, target_node_id: null });
    expect(await inboxCommand.run(["send", "@two"], { name: "Hello", summary: "First", message: "Body", grade: "view" }, JSON_GLOBAL)).toBe(0);
    expect(sendInquiryMock.mock.calls[0][1]).toMatchObject({ recipient: { username: "two" }, grade: "view" });
    expect(await inboxCommand.run(["send", "@two"], { name: "Hello", summary: "First", message: "Body" }, JSON_GLOBAL)).toBe(0);
    expect(sendInquiryMock.mock.calls[1][1]).not.toHaveProperty("grade");
    expect(await inboxCommand.run(["send", "@two"], { name: "Hello", summary: "First", message: "Body", grade: "manage" }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("--grade must be view or participate");
    expect(sendInquiryMock).toHaveBeenCalledTimes(2);
  });

  it("exposes your_grade in hosted list and read JSON without local grading", async () => {
    fetchInboxMock.mockResolvedValue({ items: [{ kind: "inquiry", exchange_id: "x_one", your_grade: "view", latest_message: message, latest_position: 1 }] });
    expect(await inboxCommand.run(["list"], { kind: "message", depth: "name" }, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout()).items[0].your_grade).toBe("view");
    stdoutChunks = [];
    fetchExchangeMock.mockResolvedValue({ exchange_id: "x_one", your_grade: "manage", target_node_id: null, participants: [], messages: [], cursor: null, latest_position: 1 });
    expect(await inboxCommand.run(["read", "x_one"], {}, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout()).your_grade).toBe("manage");
  });

  it("routes hosted owner controls and passes through server refusals", async () => {
    const id = "x_0123456789abcdef01234567";
    const result = { exchange_id: id, position: 5 };
    addExchangePersonMock.mockResolvedValue(result); closeExchangeMock.mockResolvedValue(result); renameExchangeMock.mockResolvedValue(result);
    expect(await inboxCommand.run(["add", id, "@two"], { grade: "view" }, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ planned: true, recipient: { username: "two" }, grade: "view" });
    expect(addExchangePersonMock).not.toHaveBeenCalled();
    stdoutChunks = [];
    expect(await inboxCommand.run(["add", id, "@two"], { grade: "view" }, { ...JSON_GLOBAL, yes: true })).toBe(0);
    expect(addExchangePersonMock).toHaveBeenCalledWith(CFG, id, { username: "two" }, "view");
    expect(addExchangePersonMock).toHaveBeenCalledTimes(1);
    stdoutChunks = [];
    expect(await inboxCommand.run(["close", id], {}, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout()).planned).toBe(true);
    expect(closeExchangeMock).not.toHaveBeenCalled();
    expect(await inboxCommand.run(["close", id], {}, { ...JSON_GLOBAL, yes: true })).toBe(0);
    expect(closeExchangeMock).toHaveBeenCalledWith(CFG, id);
    expect(await inboxCommand.run(["rename", id], { name: "New title" }, JSON_GLOBAL)).toBe(0);
    expect(renameExchangeMock).toHaveBeenCalledWith(CFG, id, "New title");
    closeExchangeMock.mockRejectedValue(new Error(`POST /api/v1/exchanges/${id}/close → 403: {"detail":"Only the Thread owner can manage it"}`));
    expect(await inboxCommand.run(["close", id], {}, { ...TEXT_GLOBAL, yes: true })).toBe(1);
    expect(stderr()).toContain("Only the Thread owner can manage it");
    expect(await inboxCommand.run(["add", id, "@two"], { grade: "manage" }, TEXT_GLOBAL)).toBe(1);
    expect(addExchangePersonMock).toHaveBeenCalledTimes(1);
  });

  it("shows grade and closure in human hosted reads and lists", async () => {
    fetchInboxMock.mockResolvedValue({ items: [{ kind: "inquiry", exchange_id: "x_one", name: "Updated title", your_grade: "view", closed: true,
      latest_message: message, participants: [participant(1, "One")], latest_position: 1, cursor: null, message_count: 1 }] });
    expect(await inboxCommand.run(["list"], { kind: "message" }, TEXT_GLOBAL)).toBe(0);
    expect(stdout()).toContain("Updated title [view] [closed]");
    stdoutChunks = [];
    fetchExchangeMock.mockResolvedValue({ exchange_id: "x_one", name: "Updated title", your_grade: "view", closed: true,
      target_node_id: null, participants: [], messages: [{ ...message, markdown: "Body" }], cursor: null, latest_position: 1 });
    expect(await inboxCommand.run(["read", "x_one"], {}, TEXT_GLOBAL)).toBe(0);
    expect(stdout()).toContain("Thread x_one [closed]");
    expect(stdout()).toContain("Your grade: view");
  });

  it("rejects malformed hosted management flags before network access", async () => {
    const id = "x_0123456789abcdef01234567";
    expect(await inboxCommand.run(["add", id], {}, TEXT_GLOBAL)).toBe(1);
    expect(await inboxCommand.run(["add", id, "two@example.test"], {}, TEXT_GLOBAL)).toBe(1);
    expect(await inboxCommand.run(["add", id, "@two"], { grade: true }, TEXT_GLOBAL)).toBe(1);
    expect(await inboxCommand.run(["close", id], { message: "why" }, { ...TEXT_GLOBAL, yes: true })).toBe(1);
    expect(await inboxCommand.run(["rename", id], {}, TEXT_GLOBAL)).toBe(1);
    expect(addExchangePersonMock).not.toHaveBeenCalled();
    expect(closeExchangeMock).not.toHaveBeenCalled();
    expect(renameExchangeMock).not.toHaveBeenCalled();
  });

  it("routes hosted owner controls through threads without touching local close", async () => {
    const hosted = "x_0123456789abcdef01234567";
    closeExchangeMock.mockResolvedValue({ exchange_id: hosted, position: 6 });
    addExchangePersonMock.mockResolvedValue({ exchange_id: hosted, position: 7 });
    renameExchangeMock.mockResolvedValue({ exchange_id: hosted, position: 8 });
    expect(await threadsCommand.run(["close", hosted], {}, { ...JSON_GLOBAL, yes: true })).toBe(0);
    expect(await threadsCommand.run(["add", hosted, "@two"], {}, { ...JSON_GLOBAL, yes: true })).toBe(0);
    expect(addExchangePersonMock).toHaveBeenCalledWith(CFG, hosted, { username: "two" }, "participate");
    expect(await threadsCommand.run(["rename", hosted], { name: "Title" }, JSON_GLOBAL)).toBe(0);
    expect(closeExchangeMock).toHaveBeenCalledWith(CFG, hosted);
    expect(renameExchangeMock).toHaveBeenCalledWith(CFG, hosted, "Title");
    expect(await threadsCommand.run(["close", hosted], { message: "why" }, { ...TEXT_GLOBAL, yes: true })).toBe(1);
    expect(stderr()).toContain("Hosted close has no --message");
    expect(closeExchangeMock).toHaveBeenCalledTimes(1);
  });

  it("sends a message-first Thread without an about Node or Map", async () => {
    sendInquiryMock.mockResolvedValue({ ...writeResult, target_node_id: null });
    const code = await inboxCommand.run(["send", "@two"], {
      name: "Hello", summary: "A first exchange", message: "# Hello\n\nLet's talk.", "send-id": "message-first",
    }, TEXT_GLOBAL);
    expect(code).toBe(0);
    expect(sendInquiryMock).toHaveBeenCalledWith(CFG, {
      recipient: { username: "two" }, send_id: "message-first", name: "Hello",
      summary: "A first exchange", markdown: "# Hello\n\nLet's talk.",
    });
    expect(stdout()).toContain("Sent. Thread x_one.");
    expect(stdout()).not.toContain("about null");
  });

  it("keeps null subject in list/read JSON without printing an about line", async () => {
    fetchInboxMock.mockResolvedValue({ items: [{ kind: "inquiry", mode: "direct", exchange_id: "x_one",
      target_node_id: null, participants: [participant(1, "One"), participant(2, "Two")],
      opening_note: message, latest_message: message, latest_position: 1, cursor: null,
      latest_received_position: 1, message_count: 1, received_message_count: 1 }] });
    expect(await inboxCommand.run(["list"], {}, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout()).items[0].target_node_id).toBeNull();
    stdoutChunks = [];
    expect(await inboxCommand.run(["list"], {}, TEXT_GLOBAL)).toBe(0);
    expect(stdout()).not.toContain("about null");
    stdoutChunks = [];
    fetchExchangeMock.mockResolvedValue({ mode: "direct", exchange_id: "x_one", target_node_id: null,
      participants: [participant(1, "One"), participant(2, "Two")], messages: [message],
      subject: { opening_note_id: message.note_node_id, current_note_id: message.note_node_id },
      latest_position: 1, cursor: null });
    expect(await inboxCommand.run(["read", "x_one"], {}, JSON_GLOBAL)).toBe(0);
    expect(JSON.parse(stdout()).target_node_id).toBeNull();
    stdoutChunks = [];
    expect(await inboxCommand.run(["read", "x_one"], {}, TEXT_GLOBAL)).toBe(0);
    expect(stdout()).not.toContain("About null");
  });

  it("explains the old server's 422 until the targetless API is deployed", async () => {
    sendInquiryMock.mockRejectedValue(new Error('POST /api/v1/inquiries → 422: {"detail":[{"loc":["body","target_node_id"],"msg":"Field required"}]}'));
    expect(await inboxCommand.run(["send", "@two"], { name: "Hello", summary: "First", message: "Body" }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("does not yet accept message-only Threads");
    expect(stderr()).toContain("Wait for the API rollout");
    expect(sendInquiryMock).toHaveBeenCalledTimes(1);
  });

  it("requires a recipient before network access when no target is named", async () => {
    expect(await inboxCommand.run(["send"], { name: "Hello", summary: "First", message: "Body" }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Say who to send to");
    expect(sendInquiryMock).not.toHaveBeenCalled();
  });

  it("sends an address-only Map without a target or published Note", async () => {
    sendInquiryMock.mockResolvedValue({ ...writeResult, target_node_id: null });
    const path = join(tmpdir(), `is-cli-links-only-${process.pid}.json`);
    const links = { roots: [], members: [{ address: "https://github.com/example/project", depth: "summary",
      disclosure: { name: "Project", summary: "Link" } }] };
    writeFileSync(path, JSON.stringify({ kind: "exchange-map-selection", map: links }));
    try {
      expect(await inboxCommand.run(["send", "@two"], { map: path, name: "Links", summary: "Useful", message: "See link" }, JSON_GLOBAL)).toBe(0);
      expect(sendInquiryMock.mock.calls[0][1]).toMatchObject({ recipient: { username: "two" }, map: links });
      expect(sendInquiryMock.mock.calls[0][1]).not.toHaveProperty("target_node_id");
    } finally { unlinkSync(path); }
  });

  it("shares explicit roots alongside a message-first send", async () => {
    addPersonShareMock.mockResolvedValue({ status: "added", target_node_id: TARGET, grade: "viewer", share_history: false, recipient_route: "@two" });
    sendInquiryMock.mockResolvedValue({ ...writeResult, target_node_id: null });
    expect(await inboxCommand.run(["send", "@two"], { name: "Hello", summary: "First", message: "Body",
      share: "viewer", "share-roots": TARGET }, JSON_GLOBAL)).toBe(0);
    expect(addPersonShareMock).toHaveBeenCalledTimes(1);
    expect(sendInquiryMock.mock.calls[0][1]).not.toHaveProperty("target_node_id");
  });

  it("refuses sharing without any root on a message-first send", async () => {
    expect(await inboxCommand.run(["send", "@two"], { name: "Hello", summary: "First", message: "Body", share: "viewer" }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("--share-roots");
    expect(sendInquiryMock).not.toHaveBeenCalled();
  });

  it("sends an inquiry to a handle about one target", async () => {
    sendInquiryMock.mockResolvedValue(writeResult);

    const code = await inboxCommand.run(
      ["send", "@two"],
      {
        about: TARGET,
        name: "Question",
        summary: "A focused question",
        message: "# Question\n\nWhat next?",
        "send-id": "send-one",
      },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(sendInquiryMock).toHaveBeenCalledWith(CFG, {
      target_node_id: TARGET,
      recipient: { username: "two" },
      send_id: "send-one",
      name: "Question",
      summary: "A focused question",
      markdown: "# Question\n\nWhat next?",
    });
    expect(JSON.parse(stdout())).toMatchObject({ exchange_id: "x_one", target_node_id: TARGET });
  });

  it("sends without a recipient and says it went to the owner", async () => {
    sendInquiryMock.mockResolvedValue(writeResult);

    const code = await inboxCommand.run(
      ["send"],
      {
        about: TARGET,
        name: "Bug",
        summary: "share invite 404s",
        message: "# Bug\n\nEvery repo.",
        "send-id": "send-owner",
      },
      TEXT_GLOBAL,
    );

    expect(code).toBe(0);
    const body = sendInquiryMock.mock.calls[0][1];
    expect(body).not.toHaveProperty("recipient");
    expect(body).toMatchObject({ target_node_id: TARGET, send_id: "send-owner" });
    expect(stdout()).toContain(`Sent to the owner of ${TARGET}. Thread x_one.`);
  });

  it("refuses more than one recipient", async () => {
    const code = await inboxCommand.run(
      ["send", "@two", "@three"],
      { about: TARGET, name: "Question", summary: "Summary", message: "Body" },
      TEXT_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
    expect(sendInquiryMock).not.toHaveBeenCalled();
  });

  it("replies through an existing exchange", async () => {
    replyToExchangeMock.mockResolvedValue({ ...writeResult, action: "note.replied" });

    const code = await inboxCommand.run(
      ["reply", "x_one"],
      {
        name: "Answer",
        summary: "A bounded answer",
        message: "# Answer\n\nKeep it narrow.",
        "send-id": "reply-one",
      },
      TEXT_GLOBAL,
    );

    expect(code).toBe(0);
    expect(replyToExchangeMock).toHaveBeenCalledWith(CFG, "x_one", {
      send_id: "reply-one",
      name: "Answer",
      summary: "A bounded answer",
      markdown: "# Answer\n\nKeep it narrow.",
    });
    expect(stdout()).toContain("Replied in thread x_one");
  });

  it("rejects an internal or ambiguous recipient before the API", async () => {
    const code = await inboxCommand.run(
      ["send", "person:user_2"],
      { about: TARGET, name: "Question", summary: "Summary", message: "Body" },
      TEXT_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
    expect(sendInquiryMock).not.toHaveBeenCalled();
  });

  it("requires login and maps an expired session", async () => {
    loadConfigMock.mockReturnValue(null);
    expect(await inboxCommand.run(["list"], {}, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Not logged in");

    stderrChunks = [];
    loadConfigMock.mockReturnValue(CFG);
    fetchInboxMock.mockRejectedValue(new UnauthorizedError("401"));
    expect(await inboxCommand.run(["list"], {}, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("Session expired");
  });

  it("lists Space-scoped threads at disclosure ceiling with --space", async () => {
    const spaceId = "n_0123456789abcdef01234567";
    fetchSpaceThreadsMock.mockResolvedValue({
      threads: [
        {
          exchange_id: "x_readable",
          name: "Readable Thread",
          summary: "Summary of readable thread",
          revision: "n_111111111111111111111111",
          can_read: true,
          created_at: "2026-09-24T00:00:00Z",
          latest_activity_at: "2026-09-24T01:00:00Z",
        },
        {
          exchange_id: "x_discover_only",
          name: "Discover Only Thread",
          summary: "Summary of discover only thread",
          revision: "n_222222222222222222222222",
          can_read: false,
          created_at: "2026-09-24T00:00:00Z",
          latest_activity_at: "2026-09-24T01:00:00Z",
        },
      ],
    });

    // Summary depth (default)
    const codeSummary = await inboxCommand.run(["list"], { space: spaceId }, TEXT_GLOBAL);
    expect(codeSummary).toBe(0);
    expect(fetchSpaceThreadsMock).toHaveBeenCalledWith(CFG, spaceId);
    expect(stdout()).toContain("x_readable  Readable Thread");
    expect(stdout()).toContain("revision n_111111111111111111111111 · readable");
    expect(stdout()).toContain("x_discover_only  Discover Only Thread");
    expect(stdout()).toContain("revision n_222222222222222222222222 · not open to you");

    // JSON output
    stdoutChunks = [];
    const codeJson = await inboxCommand.run(["list"], { space: spaceId }, JSON_GLOBAL);
    expect(codeJson).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      threads: [
        { exchange_id: "x_readable", can_read: true },
        { exchange_id: "x_discover_only", can_read: false },
      ],
    });

    // Name depth
    stdoutChunks = [];
    const codeName = await inboxCommand.run(["list"], { space: spaceId, depth: "name" }, TEXT_GLOBAL);
    expect(codeName).toBe(0);
    expect(stdout()).toBe("x_readable  Readable Thread\nx_discover_only  Discover Only Thread\n");

    // Full depth (fetches readable, names refusal for unreadable)
    stdoutChunks = [];
    fetchExchangeMock.mockResolvedValue({
      mode: "direct",
      exchange_id: "x_readable",
      target_node_id: TARGET,
      participants: [participant(1, "One"), participant(2, "Two")],
      messages: [message],
      subject: { opening_note_id: "n_note", current_note_id: "n_note" },
      latest_position: 1,
      cursor: null,
    });
    const codeFull = await inboxCommand.run(["list"], { space: spaceId, depth: "full" }, TEXT_GLOBAL);
    expect(codeFull).toBe(0);
    expect(fetchExchangeMock).toHaveBeenCalledWith(CFG, "x_readable");
    expect(stdout()).toContain("Thread x_readable");
    expect(stdout()).toContain("A focused question");
    expect(stdout()).toContain("x_discover_only  Discover Only Thread");
    expect(stdout()).toContain("[Not open to you]");

    // Empty space threads
    stdoutChunks = [];
    fetchSpaceThreadsMock.mockResolvedValue({ threads: [] });
    const codeEmpty = await inboxCommand.run(["list"], { space: spaceId }, TEXT_GLOBAL);
    expect(codeEmpty).toBe(0);
    expect(stdout()).toContain(`No threads in Space ${spaceId}.`);
  });

  it("propagates session expiry during --depth full space thread reading", async () => {
    const spaceId = "n_0123456789abcdef01234567";
    fetchSpaceThreadsMock.mockResolvedValue({
      threads: [
        {
          exchange_id: "x_readable",
          name: "Readable Thread",
          summary: "Summary",
          revision: "n_111111111111111111111111",
          can_read: true,
          created_at: "2026-09-24T00:00:00Z",
          latest_activity_at: "2026-09-24T01:00:00Z",
        },
      ],
    });
    fetchExchangeMock.mockRejectedValue(new UnauthorizedError("401"));

    const code = await inboxCommand.run(["list"], { space: spaceId, depth: "full" }, TEXT_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Session expired. Run `ideaspaces login`.");
  });

  it("refuses --space combined with --new, --since, or --kind", async () => {
    const spaceId = "n_0123456789abcdef01234567";
    expect(await inboxCommand.run(["list"], { space: spaceId, new: true }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("--space lists coordination Space threads and cannot be combined with --new, --since, or --kind.");

    stderrChunks = [];
    expect(await inboxCommand.run(["list"], { space: spaceId, since: "5" }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("--space lists coordination Space threads and cannot be combined with --new, --since, or --kind.");

    stderrChunks = [];
    expect(await inboxCommand.run(["list"], { space: spaceId, kind: "message" }, TEXT_GLOBAL)).toBe(1);
    expect(stderr()).toContain("--space lists coordination Space threads and cannot be combined with --new, --since, or --kind.");
  });

  it("refuses an invalid --space node id", async () => {
    const code = await inboxCommand.run(["list"], { space: "not_a_node_id" }, TEXT_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Invalid --space: must be a Space node_id (n_…).");
  });

  it("sends a thread bound to an explicit coordination space with --space", async () => {
    const spaceId = "n_0123456789abcdef01234567";
    sendInquiryMock.mockResolvedValue({
      ...writeResult,
      space_id: spaceId,
    });

    const code = await inboxCommand.run(
      ["send", "@two"],
      {
        space: spaceId,
        about: TARGET,
        name: "Space Thread",
        summary: "Bound to space",
        message: "# Thread in Space\n\nContent here.",
        "send-id": "send-space-1",
      },
      TEXT_GLOBAL,
    );

    expect(code).toBe(0);
    expect(sendInquiryMock).toHaveBeenCalledWith(CFG, {
      target_node_id: TARGET,
      recipient: { username: "two" },
      space_id: spaceId,
      send_id: "send-space-1",
      name: "Space Thread",
      summary: "Bound to space",
      markdown: "# Thread in Space\n\nContent here.",
    });
    expect(stdout()).toContain(`Sent in Space ${spaceId}. Thread x_one is about ${TARGET}.`);
  });

  it("reports a clean named refusal on 403 when opening a discover-only thread", async () => {
    fetchExchangeMock.mockRejectedValue(
      new Error('GET /api/v1/exchanges/x_closed → 403: {"detail":"Not open to you"}'),
    );

    const code = await inboxCommand.run(["read", "x_closed"], {}, TEXT_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Not open to you");
  });

  it("reports clean 404 when thread is absent", async () => {
    fetchExchangeMock.mockRejectedValue(
      new Error('GET /api/v1/exchanges/x_missing → 404: {"detail":"Exchange not found"}'),
    );

    const code = await inboxCommand.run(["read", "x_missing"], {}, TEXT_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Exchange not found");
  });

  it("sends a thread and shares root access with --share viewer as two acts", async () => {
    addPersonShareMock.mockResolvedValue({
      target_node_id: TARGET,
      grade: "explore",
      share_history: false,
      status: "added",
      recipient_route: "user_2",
    });
    sendInquiryMock.mockResolvedValue({
      exchange_id: "x_shared",
      note_node_id: "n_note_1",
      target_node_id: TARGET,
      space_id: null,
    });

    const code = await inboxCommand.run(
      ["send", "@colleague"],
      {
        about: TARGET,
        share: "viewer",
        name: "Joint review",
        summary: "Review finding",
        message: "Please check this note",
      },
      TEXT_GLOBAL,
    );

    expect(code).toBe(0);
    expect(addPersonShareMock).toHaveBeenCalledWith(CFG, TARGET, {
      username: "colleague",
      invite_if_no_match: false,
      grade: "explore",
    });
    expect(sendInquiryMock).toHaveBeenCalledWith(CFG, {
      send_id: expect.any(String),
      name: "Joint review",
      summary: "Review finding",
      markdown: "Please check this note",
      target_node_id: TARGET,
      recipient: { username: "colleague" },
    });
    expect(stdout()).toContain(`Shared ${TARGET} with @colleague at Viewer (explore).`);
    expect(stdout()).toContain(`Sent. Thread x_shared is about ${TARGET}.`);
  });

  it("refuses sending a thread when recipient has no account, naming why and next steps", async () => {
    sendInquiryMock.mockRejectedValue(
      new Error("POST /api/v1/inquiries → 409: recipient unavailable"),
    );

    const code = await inboxCommand.run(
      ["send", "newuser@example.com"],
      {
        about: TARGET,
        name: "Welcome",
        summary: "Initial discussion",
        message: "Let's talk",
      },
      TEXT_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("Cannot send thread to newuser@example.com: newuser@example.com does not have an IdeaSpaces account yet.");
    expect(stderr()).toContain("Next steps:");
    expect(stderr()).toContain("Have them sign up at ideaspaces.xyz first");
    expect(stderr()).toContain("ideaspaces share person newuser@example.com --grade viewer");
  });

  it("invites via share and explains refusal when sending thread to unregistered email with --share", async () => {
    addPersonShareMock.mockResolvedValue({
      target_node_id: TARGET,
      grade: "explore",
      share_history: false,
      status: "invited",
      recipient_route: "pending_invite",
    });
    sendInquiryMock.mockRejectedValue(
      new Error("POST /api/v1/inquiries → 409: recipient unavailable"),
    );

    const code = await inboxCommand.run(
      ["send", "stranger@example.com"],
      {
        about: TARGET,
        share: "viewer",
        name: "Invite note",
        summary: "Summary",
        message: "Message",
      },
      TEXT_GLOBAL,
    );

    expect(code).toBe(1);
    expect(addPersonShareMock).toHaveBeenCalledWith(CFG, TARGET, {
      email: "stranger@example.com",
      invite_if_no_match: true,
      grade: "explore",
    });
    expect(stderr()).toContain("No account yet — invited stranger@example.com at Viewer (explore) for n_0123456789abcdef01234567.");
    expect(stderr()).toContain("Cannot send thread to stranger@example.com: stranger@example.com does not have an IdeaSpaces account yet.");
    expect(stderr()).toContain("the invitation email has been sent for the shared root(s).");
  });

  it("replies carrying an attached Map selection with --map", async () => {
    const selectionFile = join(tmpdir(), `selection-${Date.now()}.json`);
    const selection = {
      kind: "exchange-map-selection",
      target_node_id: TARGET,
      map: {
        roots: [{ root_node_id: TARGET, sha: "a".repeat(40) }],
        members: [
          {
            root: 0,
            position: "reply.md",
            depth: "summary",
            disclosure: { name: "Reply note", summary: "Proposal summary" },
          },
        ],
      },
    };
    writeFileSync(selectionFile, JSON.stringify(selection));

    replyToExchangeMock.mockResolvedValue({
      exchange_id: "x_target",
      note_node_id: "n_reply_1",
      target_node_id: TARGET,
      space_id: null,
    });

    const code = await inboxCommand.run(
      ["reply", "x_target"],
      {
        map: selectionFile,
        name: "Counter proposal",
        summary: "Alternative approach",
        message: "Here is the map with my proposal",
      },
      TEXT_GLOBAL,
    );

    expect(code).toBe(0);
    expect(replyToExchangeMock).toHaveBeenCalledWith(CFG, "x_target", {
      send_id: expect.any(String),
      name: "Counter proposal",
      summary: "Alternative approach",
      markdown: "Here is the map with my proposal",
      map: selection.map,
    });
    expect(stdout()).toContain("Replied in thread x_target.");
    unlinkSync(selectionFile);
  });
});
