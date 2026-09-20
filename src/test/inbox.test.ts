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
  acknowledgeSubscriptionMock,
  fetchExchangeMapMemberMock,
  fetchSubscriptionEventsMock,
  listSubscriptionsMock,
  sendInquiryMock,
  replyToExchangeMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchInboxMock: vi.fn(),
  fetchExchangeMock: vi.fn(),
  acknowledgeSubscriptionMock: vi.fn(),
  fetchExchangeMapMemberMock: vi.fn(),
  fetchSubscriptionEventsMock: vi.fn(),
  listSubscriptionsMock: vi.fn(),
  sendInquiryMock: vi.fn(),
  replyToExchangeMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    fetchInbox: fetchInboxMock,
    fetchExchange: fetchExchangeMock,
    acknowledgeSubscription: acknowledgeSubscriptionMock,
    fetchExchangeMapMember: fetchExchangeMapMemberMock,
    fetchSubscriptionEvents: fetchSubscriptionEventsMock,
    listSubscriptions: listSubscriptionsMock,
    sendInquiry: sendInquiryMock,
    replyToExchange: replyToExchangeMock,
  };
});

const { inboxCommand } = await import("../commands/inbox.js");

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
  acknowledgeSubscriptionMock.mockReset();
  fetchExchangeMapMemberMock.mockReset();
  fetchSubscriptionEventsMock.mockReset().mockResolvedValue([]);
  listSubscriptionsMock.mockReset();
  sendInquiryMock.mockReset();
  replyToExchangeMock.mockReset();
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
});
