// Authored contracts. Do not infer permissions or host exposure from this catalog.
import type { Entry, Group } from "./types.js";

export const groups: Group[] = [
  {
    "id": "read",
    "job": "J1",
    "name": "Read content",
    "use_when": "Read one target progressively, inspect Markdown, or locate content."
  },
  {
    "id": "notes",
    "job": "J2",
    "name": "Write Notes",
    "use_when": "Create or update a Note, locally or by hosted identity."
  },
  {
    "id": "commits",
    "job": "J3",
    "name": "Save captures",
    "use_when": "Save explicitly selected staged files to Git."
  },
  {
    "id": "threads",
    "job": "J4",
    "name": "Local Threads",
    "use_when": "Create, post to, close, attach or maintain a local Thread."
  },
  {
    "id": "hosted-threads",
    "job": "J5",
    "name": "Hosted Threads",
    "use_when": "Send or reply remotely, acknowledge, rename, or check transport support."
  },
  {
    "id": "thread-status",
    "job": "J6",
    "name": "Thread activity",
    "use_when": "List Threads, see what moved, or check immutable posts."
  },
  {
    "id": "maps",
    "job": "J7",
    "name": "Local Maps",
    "use_when": "Create or edit references in a local Map; list Spaces."
  },
  {
    "id": "spaces",
    "job": "J8",
    "name": "Hosted Spaces",
    "use_when": "Read, create, edit or copy a hosted Map, or choose a Vault."
  },
  {
    "id": "repositories",
    "job": "J9",
    "name": "Repositories",
    "use_when": "Bring repos home, inspect sync state, integrate, push or publish."
  },
  {
    "id": "share",
    "job": "J10",
    "name": "Access",
    "use_when": "Inspect access or explicitly grant, revoke or request it."
  },
  {
    "id": "agent-tools",
    "job": "J11",
    "name": "Agents and runtimes",
    "use_when": "Discover and run agents, inspect conversations, or configure a runtime provider."
  },
  {
    "id": "changes",
    "job": "J12",
    "name": "Changes",
    "use_when": "Mint or manage a session Change spanning commits and repos."
  },
  {
    "id": "account",
    "job": "J13",
    "name": "Account and setup",
    "use_when": "Sign in or out, diagnose installation, upgrade the CLI or scaffold a repo."
  },
  {
    "id": "searching",
    "job": "J14",
    "name": "Search",
    "use_when": "Find Markdown by query or open a saved result Map."
  }
];

export const entries: Entry[] = [
  {
    "id": "look",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read one local Note, Content directory, Thread or pinned Map address.",
      "use_when": "Deepen one identified target; use navigate for orientation.",
      "check": "Check nextCursor and continue with since. Thread summaries show folded marks; open the post for body evidence.",
      "bound": "Rungs bound detail; directory pages report shown, matching and nextCursor. Continue with since."
    },
    "bound": {
      "unit": "entries",
      "says": true,
      "continue": "since"
    },
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "depth": {
          "type": "string",
          "description": "Progressive-disclosure rung or numeric tree depth as documented.",
          "enum": [
            "name",
            "summary",
            "surface",
            "children",
            "full"
          ],
          "default": "summary"
        },
        "contract": {
          "type": "string",
          "description": "The contract option for look; see this entry's check and bound.",
          "enum": [
            "foundation",
            "agreement"
          ]
        },
        "agreement": {
          "type": "string",
          "description": "Reference Agreement representation, never caller authority.",
          "enum": [
            "summary",
            "full"
          ]
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 0
        },
        "since": {
          "type": "string",
          "description": "Continuation position from the prior page or ISO filter where supported."
        },
        "order": {
          "type": "string",
          "description": "The order option for look; see this entry's check and bound.",
          "enum": [
            "older",
            "newer"
          ]
        },
        "post": {
          "type": "string",
          "description": "Exact post id to select."
        },
        "pin": {
          "type": "string",
          "description": "The pin option for look; see this entry's check and bound."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "at": {
          "type": "string",
          "description": "The at option for look; see this entry's check and bound.",
          "enum": [
            "pin",
            "head"
          ]
        },
        "new": {
          "type": "string",
          "description": "The new option for look; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "look"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "depth": {
          "flag": "--depth"
        },
        "contract": {
          "flag": "--contract"
        },
        "agreement": {
          "flag": "--agreement"
        },
        "limit": {
          "flag": "--limit"
        },
        "since": {
          "flag": "--since"
        },
        "order": {
          "flag": "--order"
        },
        "post": {
          "flag": "--post"
        },
        "pin": {
          "flag": "--pin"
        },
        "map": {
          "flag": "--map"
        },
        "at": {
          "flag": "--at"
        },
        "new": {
          "flag": "--new"
        }
      }
    },
    "output": {
      "json": [
        "text",
        "kind",
        "depth",
        "reference",
        "target",
        "map",
        "portable",
        "dirty"
      ]
    }
  },
  {
    "id": "navigate",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Orient here or read another position as reference without changing authority.",
      "use_when": "Change reference focus, not your working directory or operating contract.",
      "check": "A target Agreement is reference only. Check selected contract and tree depth.",
      "bound": "Depth 1 by default, up to 4; focus is a bounded depth-one reference view."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "focus": {
          "type": "boolean",
          "description": "The focus option for navigate; see this entry's check and bound."
        },
        "agreement": {
          "type": "string",
          "description": "Reference Agreement representation, never caller authority."
        },
        "contract": {
          "type": "string",
          "description": "The contract option for navigate; see this entry's check and bound."
        },
        "depth": {
          "type": "string",
          "description": "Progressive-disclosure rung or numeric tree depth as documented."
        },
        "mark_seen": {
          "type": "boolean",
          "description": "The mark-seen option for navigate; see this entry's check and bound."
        },
        "workspace": {
          "type": "string",
          "description": "The workspace option for navigate; see this entry's check and bound."
        },
        "mount": {
          "type": "array",
          "description": "The mount option for navigate; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        },
        "pullable": {
          "type": "string",
          "description": "The pullable option for navigate; see this entry's check and bound."
        },
        "no_git": {
          "type": "boolean",
          "description": "The no-git option for navigate; see this entry's check and bound."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "at": {
          "type": "string",
          "description": "The at option for navigate; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "navigate"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "focus": {
          "flag": "--focus",
          "boolean": "bare"
        },
        "agreement": {
          "flag": "--agreement"
        },
        "contract": {
          "flag": "--contract"
        },
        "depth": {
          "flag": "--depth"
        },
        "mark_seen": {
          "flag": "--mark-seen",
          "boolean": "bare"
        },
        "workspace": {
          "flag": "--workspace"
        },
        "mount": {
          "flag": "--mount",
          "list": "csv"
        },
        "pullable": {
          "flag": "--pullable"
        },
        "no_git": {
          "flag": "--no-git",
          "boolean": "bare"
        },
        "map": {
          "flag": "--map"
        },
        "at": {
          "flag": "--at"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "inspect",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Inspect one Markdown file by summary, outline or exact section.",
      "use_when": "Start at summary, then outline, then one heading; no full-document mode.",
      "check": "Check truncation and section status; disambiguate duplicate headings with occurrence.",
      "bound": "Defaults to 51200 inspection bytes, max 1048576; raise max_bytes or read the exact file if truncated."
    },
    "bound": {
      "unit": "bytes",
      "default": 51200,
      "max": 1048576,
      "says": true
    },
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "mode": {
          "type": "string",
          "description": "The mode option for inspect; see this entry's check and bound.",
          "enum": [
            "summary",
            "outline",
            "section"
          ],
          "default": "summary"
        },
        "heading": {
          "type": "string",
          "description": "The heading option for inspect; see this entry's check and bound."
        },
        "occurrence": {
          "type": "integer",
          "description": "The occurrence option for inspect; see this entry's check and bound.",
          "minimum": 1
        },
        "max_bytes": {
          "type": "integer",
          "description": "The max-bytes option for inspect; see this entry's check and bound.",
          "minimum": 128,
          "maximum": 1048576,
          "default": 51200
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "inspect"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "mode": {
          "flag": "--mode"
        },
        "heading": {
          "flag": "--heading"
        },
        "occurrence": {
          "flag": "--occurrence"
        },
        "max_bytes": {
          "flag": "--max-bytes"
        }
      }
    },
    "output": {
      "json": [
        "path",
        "mode",
        "status",
        "truncation"
      ]
    }
  },
  {
    "id": "map.read",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read a curated Map, derive a Content Map, or render orientation.",
      "use_when": "Inspect references before editing a Map or launching from it.",
      "check": "References do not grant access. Check file_sha before guarded removal.",
      "bound": "Depth defaults to 1, max 4 or full; orientation uses a character budget."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "depth": {
          "type": "string",
          "description": "Progressive-disclosure rung or numeric tree depth as documented."
        },
        "orientation": {
          "type": "boolean",
          "description": "The orientation option for map.read; see this entry's check and bound."
        },
        "budget": {
          "type": "integer",
          "description": "The budget option for map.read; see this entry's check and bound.",
          "minimum": 0
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "map"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "depth": {
          "flag": "--depth"
        },
        "orientation": {
          "flag": "--orientation",
          "boolean": "bare"
        },
        "budget": {
          "flag": "--budget"
        }
      }
    },
    "aliases": [
      "map"
    ],
    "output": {
      "json": []
    }
  },
  {
    "id": "ls",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List typed files and folders for a path and optional query.",
      "use_when": "Find a filename rather than search Markdown bodies.",
      "check": "Check truncation before treating the list as complete.",
      "bound": "Default limit 25; scan caps at 5000 entries and depth 10. Check truncated and narrow the path/query."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "query": {
          "type": "string",
          "description": "The query option for ls; see this entry's check and bound."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 1,
          "default": 25
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "ls"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "query": {
          "flag": "--query"
        },
        "limit": {
          "flag": "--limit"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "times",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read first and last Git commit times per Note in this checkout.",
      "use_when": "Need clone-local Git timestamps, not authored dates.",
      "check": "Uncommitted Notes have no committed timestamp; shallow history may be incomplete.",
      "bound": "Unbounded per-note output for this checkout; no continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "times"
      ],
      "positional": [],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.open",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read one local or hosted Thread at a selected rung.",
      "use_when": "Read a Thread or one exact post; use list for discovery.",
      "check": "Compare shown with matching. A snapshot plus tail can omit intervening posts; page since the snapshot.",
      "bound": "Local default 4 tail posts, max 500; hosted default 50, max 200. Continue with since locally or cursor remotely."
    },
    "bound": {
      "unit": "posts",
      "default": 4,
      "max": 500,
      "says": true,
      "continue": "since"
    },
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "depth": {
          "type": "string",
          "description": "Progressive-disclosure rung or numeric tree depth as documented."
        },
        "new": {
          "type": "boolean",
          "description": "The new option for threads.open; see this entry's check and bound."
        },
        "ack": {
          "type": "boolean",
          "description": "The ack option for threads.open; see this entry's check and bound."
        },
        "since": {
          "type": "string",
          "description": "Continuation position from the prior page or ISO filter where supported."
        },
        "post": {
          "type": "string",
          "description": "Exact post id to select."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "member": {
          "type": "integer",
          "description": "The member option for threads.open; see this entry's check and bound.",
          "minimum": 0
        },
        "checkout": {
          "type": "string",
          "description": "The checkout option for threads.open; see this entry's check and bound."
        },
        "pin": {
          "type": "string",
          "description": "The pin option for threads.open; see this entry's check and bound."
        },
        "position": {
          "type": "string",
          "description": "The position option for threads.open; see this entry's check and bound."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 1,
          "maximum": 500
        },
        "order": {
          "type": "string",
          "description": "The order option for threads.open; see this entry's check and bound."
        },
        "agreement": {
          "type": "string",
          "description": "Reference Agreement representation, never caller authority."
        },
        "reader": {
          "type": "string",
          "description": "The reader option for threads.open; see this entry's check and bound."
        },
        "cursor": {
          "type": "string",
          "description": "Opaque continuation/read position returned by this operation."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "open"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "depth": {
          "flag": "--depth"
        },
        "new": {
          "flag": "--new",
          "boolean": "bare"
        },
        "ack": {
          "flag": "--ack",
          "boolean": "bare"
        },
        "since": {
          "flag": "--since"
        },
        "post": {
          "flag": "--post"
        },
        "map": {
          "flag": "--map"
        },
        "member": {
          "flag": "--member"
        },
        "checkout": {
          "flag": "--checkout"
        },
        "pin": {
          "flag": "--pin"
        },
        "position": {
          "flag": "--position"
        },
        "limit": {
          "flag": "--limit"
        },
        "order": {
          "flag": "--order"
        },
        "agreement": {
          "flag": "--agreement"
        },
        "reader": {
          "flag": "--reader"
        },
        "cursor": {
          "flag": "--cursor"
        }
      },
      "local_flags": [
        "depth",
        "new",
        "ack",
        "since",
        "post",
        "map",
        "member",
        "checkout",
        "pin",
        "position",
        "limit",
        "order",
        "agreement",
        "reader"
      ],
      "hosted_flags": [
        "limit",
        "cursor"
      ],
      "alias_flags": {
        "threads read": [
          "kind"
        ]
      }
    },
    "aliases": [
      "threads read"
    ],
    "output": {
      "json": [
        "shown",
        "matching",
        "has_more",
        "posts",
        "snapshot",
        "childThreads"
      ]
    }
  },
  {
    "id": "threads.render",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Render one local Thread as Markdown.",
      "use_when": "Need a full local export rather than bounded discovery.",
      "check": "Full output can be large; local authors are unverified claims.",
      "bound": "Unbounded complete local Thread rendering; prefer open for bounded reads."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        }
      },
      "required": [
        "thread"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "render"
      ],
      "positional": [
        "thread"
      ],
      "flags": {},
      "local_flags": []
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.locate",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Locate an opening post id in explicit local Space roots.",
      "use_when": "Know the Thread identity but not its folder.",
      "check": "Check found, ambiguous or not_found; never pick an ambiguous location silently.",
      "bound": "Only supplied Space roots are searched; returns every matching Thread."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "opening_id": {
          "type": "string",
          "description": "Positional opening id for threads.locate."
        },
        "roots": {
          "type": "array",
          "description": "Positional roots for threads.locate.",
          "items": {
            "type": "string"
          },
          "minItems": 1
        }
      },
      "required": [
        "opening_id",
        "roots"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "locate"
      ],
      "positional": [
        "opening_id",
        "roots"
      ],
      "flags": {},
      "local_flags": []
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "skills.read",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List the skill catalog or read one skill.",
      "use_when": "Find instructions before executing a workflow.",
      "check": "Read the selected skill in full before relying on it.",
      "bound": "One skill body or the complete local skill catalog; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "skills"
      ],
      "positional": [
        "name"
      ],
      "flags": {}
    },
    "aliases": [
      "skills"
    ],
    "output": {
      "json": []
    }
  },
  {
    "id": "skills.sync",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Sync Space skills into the Claude skills directory.",
      "use_when": "Need local harness skill files, or check generated drift.",
      "check": "Use check to inspect drift without writing; inspect the selected Space root.",
      "bound": "All discovered skills; check reports drift without copying."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "check": {
          "type": "boolean",
          "description": "The check option for skills.sync; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "skills",
        "sync"
      ],
      "positional": [],
      "flags": {
        "check": {
          "flag": "--check",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "node.get",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Resolve one hosted Note by repo and node identity.",
      "use_when": "Know the exact hosted identity to read.",
      "check": "Check returned identity and content; access remains independently checked.",
      "bound": "One Note per call; no continuation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_id": {
          "type": "string",
          "description": "Hosted repository id."
        },
        "node_id": {
          "type": "string",
          "description": "Hosted node identity."
        }
      },
      "required": [
        "repo_id",
        "node_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "node",
        "get"
      ],
      "positional": [
        "repo_id",
        "node_id"
      ],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "node.history",
    "owner": "cli",
    "status": "active",
    "job": "J1",
    "effect": "read",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read local path or hosted Note version history.",
      "use_when": "Need committed versions, not filesystem modification times.",
      "check": "Check whether the path is local or hosted; shallow Git history may be incomplete.",
      "bound": "Local limit defaults to 20; hosted returns its service result without client paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path_or_repo_id": {
          "type": "string",
          "description": "Positional path or repo id for node.history."
        },
        "node_id": {
          "type": "string",
          "description": "Hosted node identity."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 1
        },
        "cwd": {
          "type": "string",
          "description": "The cwd option for node.history; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "node",
        "history"
      ],
      "positional": [
        "path_or_repo_id",
        "node_id"
      ],
      "flags": {
        "limit": {
          "flag": "--limit"
        },
        "cwd": {
          "flag": "--cwd"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "write",
    "owner": "cli",
    "status": "active",
    "job": "J2",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Create or update a local Note with frontmatter and optional staging.",
      "use_when": "Capture durable knowledge; use if_match when updating a prior revision.",
      "check": "Check frontmatter validation and returned sha; force bypasses revision checking.",
      "bound": "One Note per call; content is supplied explicitly or on stdin."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "tags": {
          "type": "array",
          "description": "Retrieval labels.",
          "items": {
            "type": "string"
          }
        },
        "attached_to": {
          "type": "string",
          "description": "The attached-to option for write; see this entry's check and bound."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "content": {
          "type": "string",
          "description": "Exact Note content; otherwise reads stdin."
        },
        "if_match": {
          "type": "string",
          "description": "Expected revision: local hash, or hosted version_id for spaces edits."
        },
        "force": {
          "type": "boolean",
          "description": "Bypass existing revision/overwrite protection explicitly."
        },
        "stage": {
          "type": "boolean",
          "description": "Stage the written Note in Git (default true).",
          "default": true
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "write"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "tags": {
          "flag": "--tags",
          "list": "csv"
        },
        "attached_to": {
          "flag": "--attached-to"
        },
        "map": {
          "flag": "--map"
        },
        "content": {
          "flag": "--content"
        },
        "if_match": {
          "flag": "--if-match"
        },
        "force": {
          "flag": "--force",
          "boolean": "bare"
        },
        "stage": {
          "flag": "--stage",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": [
        "path",
        "sha",
        "staged"
      ]
    }
  },
  {
    "id": "node.put",
    "owner": "cli",
    "status": "active",
    "job": "J2",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Write hosted Note content by repo identity and path.",
      "use_when": "Update a hosted Note, not a local capture.",
      "check": "Check returned save report; do not equate an HTTP response with a local Git commit.",
      "bound": "One Note per call; content argument or stdin."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_id": {
          "type": "string",
          "description": "Hosted repository id."
        },
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "content": {
          "type": "string",
          "description": "Exact Note content; otherwise reads stdin."
        }
      },
      "required": [
        "repo_id",
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "node",
        "put"
      ],
      "positional": [
        "repo_id",
        "path"
      ],
      "flags": {
        "content": {
          "flag": "--content"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "commit",
    "owner": "cli",
    "status": "active",
    "job": "J3",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Commit only named staged paths, or all staged files when all is explicit.",
      "use_when": "Save agreed captures to Git; this CLI has no session-owned capture set.",
      "check": "Inspect selected paths. all means every staged file, not this session; check returned commit SHA.",
      "bound": "One commit; explicit paths or all, never both."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "paths": {
          "type": "array",
          "description": "Positional paths for commit.",
          "items": {
            "type": "string"
          },
          "minItems": 1
        },
        "all": {
          "type": "boolean",
          "description": "Commit all staged files, NOT this session captures."
        },
        "author_name": {
          "type": "string",
          "description": "The author-name option for commit; see this entry's check and bound."
        },
        "author_email": {
          "type": "string",
          "description": "The author-email option for commit; see this entry's check and bound."
        },
        "op": {
          "type": "string",
          "description": "The op option for commit; see this entry's check and bound."
        },
        "change_id": {
          "type": "string",
          "description": "The change-id option for commit; see this entry's check and bound."
        },
        "conversation": {
          "type": "string",
          "description": "The conversation option for commit; see this entry's check and bound."
        },
        "co_author": {
          "type": "string",
          "description": "The co-author option for commit; see this entry's check and bound."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        }
      },
      "required": [
        "message"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "commit"
      ],
      "positional": [
        "paths"
      ],
      "flags": {
        "all": {
          "flag": "--all",
          "boolean": "bare"
        },
        "author_name": {
          "flag": "--author-name"
        },
        "author_email": {
          "flag": "--author-email"
        },
        "op": {
          "flag": "--op"
        },
        "change_id": {
          "flag": "--change-id"
        },
        "conversation": {
          "flag": "--conversation"
        },
        "co_author": {
          "flag": "--co-author"
        },
        "message": {
          "flag": "--message",
          "aliases": [
            "-m"
          ]
        }
      }
    },
    "output": {
      "json": [
        "commit_sha",
        "committed_paths"
      ]
    }
  },
  {
    "id": "threads.post",
    "owner": "cli",
    "status": "active",
    "job": "J4",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Append an immutable local or hosted Thread post.",
      "use_when": "Reply to a specific post or branch from the post your topic serves.",
      "check": "Supply name, summary and reply_to; verify returned id/path. Local author is a claim. Keep post_id for exact hosted retries.",
      "bound": "One post; local kind/mark and host metadata have distinct validation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "member": {
          "type": "integer",
          "description": "The member option for threads.post; see this entry's check and bound.",
          "minimum": 0
        },
        "checkout": {
          "type": "string",
          "description": "The checkout option for threads.post; see this entry's check and bound."
        },
        "reply_to": {
          "type": "array",
          "description": "Parent post id(s); latest is explicit, never implicit.",
          "items": {
            "type": "string"
          }
        },
        "kind": {
          "type": "string",
          "description": "Local immutable post kind; hosted kind is chosen by its verb."
        },
        "mark": {
          "type": "string",
          "description": "Value of a local mark replying to exactly one post."
        },
        "author": {
          "type": "string",
          "description": "Local author claim, not verified identity."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "supersedes": {
          "type": "string",
          "description": "The supersedes option for threads.post; see this entry's check and bound."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "tags": {
          "type": "array",
          "description": "Retrieval labels.",
          "items": {
            "type": "string"
          }
        },
        "no_check_links": {
          "type": "boolean",
          "description": "Skip local post link validation only when deliberately required."
        },
        "post_id": {
          "type": "string",
          "description": "Stable id for exact hosted resend after uncertain delivery."
        }
      },
      "required": [
        "thread"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "post"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "map": {
          "flag": "--map"
        },
        "member": {
          "flag": "--member"
        },
        "checkout": {
          "flag": "--checkout"
        },
        "reply_to": {
          "flag": "--reply-to",
          "list": "csv"
        },
        "kind": {
          "flag": "--kind"
        },
        "mark": {
          "flag": "--mark"
        },
        "author": {
          "flag": "--author"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "supersedes": {
          "flag": "--supersedes"
        },
        "message": {
          "flag": "--message"
        },
        "tags": {
          "flag": "--tags",
          "list": "csv"
        },
        "no_check_links": {
          "flag": "--no-check-links",
          "boolean": "bare"
        },
        "post_id": {
          "flag": "--post-id"
        }
      },
      "local_flags": [
        "map",
        "member",
        "checkout",
        "reply-to",
        "kind",
        "mark",
        "author",
        "name",
        "summary",
        "supersedes",
        "message",
        "tags",
        "no-check-links"
      ],
      "hosted_flags": [
        "reply-to",
        "message",
        "name",
        "summary",
        "post-id",
        "map",
        "tags"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.close",
    "owner": "cli",
    "status": "active",
    "job": "J4",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Append a closure post to a local or hosted Thread.",
      "use_when": "Done-when holds and closure has been agreed.",
      "check": "Verify target and rationale; hosted close requires yes.",
      "bound": "One closure post; no content or history is removed."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "reply_to": {
          "type": "array",
          "description": "Parent post id(s); latest is explicit, never implicit.",
          "items": {
            "type": "string"
          }
        },
        "kind": {
          "type": "string",
          "description": "Local immutable post kind; hosted kind is chosen by its verb."
        },
        "author": {
          "type": "string",
          "description": "Local author claim, not verified identity."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "supersedes": {
          "type": "string",
          "description": "The supersedes option for threads.close; see this entry's check and bound."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "post_id": {
          "type": "string",
          "description": "Stable id for exact hosted resend after uncertain delivery."
        }
      },
      "required": [
        "thread"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "close"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "map": {
          "flag": "--map"
        },
        "reply_to": {
          "flag": "--reply-to",
          "list": "csv"
        },
        "kind": {
          "flag": "--kind"
        },
        "author": {
          "flag": "--author"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "supersedes": {
          "flag": "--supersedes"
        },
        "message": {
          "flag": "--message"
        },
        "post_id": {
          "flag": "--post-id"
        }
      },
      "local_flags": [
        "map",
        "reply-to",
        "kind",
        "author",
        "name",
        "summary",
        "supersedes",
        "message"
      ],
      "hosted_flags": [
        "message",
        "post-id"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.new",
    "owner": "cli",
    "status": "active",
    "job": "J4",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Start a local or hosted Thread.",
      "use_when": "New direction needs a Thread, not another reply.",
      "check": "Local needs about; hosted needs name, summary and message. Check attachment, recipients and returned id.",
      "bound": "One Thread; local/hosted creation are independent."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "about": {
          "type": "string",
          "description": "The about option for threads.new; see this entry's check and bound."
        },
        "attached_to": {
          "type": "string",
          "description": "The attached-to option for threads.new; see this entry's check and bound."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "hosted": {
          "type": "boolean",
          "description": "Use hosted routing rather than the local/legacy path."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "post_id": {
          "type": "string",
          "description": "Stable id for exact hosted resend after uncertain delivery."
        },
        "recipients": {
          "type": "array",
          "description": "The recipients option for threads.new; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        },
        "tags": {
          "type": "array",
          "description": "Retrieval labels.",
          "items": {
            "type": "string"
          }
        },
        "home": {
          "type": "string",
          "description": "The home option for threads.new; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "new"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "about": {
          "flag": "--about"
        },
        "attached_to": {
          "flag": "--attached-to"
        },
        "map": {
          "flag": "--map"
        },
        "hosted": {
          "flag": "--hosted",
          "boolean": "bare"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "message": {
          "flag": "--message"
        },
        "post_id": {
          "flag": "--post-id"
        },
        "recipients": {
          "flag": "--recipients",
          "list": "csv"
        },
        "tags": {
          "flag": "--tags",
          "list": "csv"
        },
        "home": {
          "flag": "--home"
        }
      },
      "local_flags": [
        "about",
        "attached-to",
        "map"
      ],
      "hosted_flags": [
        "hosted",
        "name",
        "summary",
        "message",
        "post-id",
        "recipients",
        "map",
        "tags",
        "home"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.attach",
    "owner": "cli",
    "status": "active",
    "job": "J4",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Append a local Thread attachment change.",
      "use_when": "Move a Thread direction to another parent post explicitly.",
      "check": "Check the parent post and rationale; prior attachment stays in history.",
      "bound": "One local Thread attachment event."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "parent": {
          "type": "string",
          "description": "Positional parent for threads.attach."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "author": {
          "type": "string",
          "description": "Local author claim, not verified identity."
        }
      },
      "required": [
        "thread",
        "parent",
        "message"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "attach"
      ],
      "positional": [
        "thread",
        "parent"
      ],
      "flags": {
        "message": {
          "flag": "--message"
        },
        "author": {
          "flag": "--author"
        }
      },
      "local_flags": [
        "message",
        "author"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.init",
    "owner": "cli",
    "status": "active",
    "job": "J4",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Initialize the local Threads worktree.",
      "use_when": "Set up a repository Threads branch.",
      "check": "Check repository and worktree location before initialization.",
      "bound": "One repository worktree."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "init"
      ],
      "positional": [],
      "flags": {},
      "local_flags": []
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.push",
    "owner": "cli",
    "status": "active",
    "job": "J4",
    "effect": "share",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Push the local Threads branch to an explicit team remote.",
      "use_when": "Sharing the committed Thread branch has been agreed.",
      "check": "Verify remote; this explicitly shares committed posts, never a private conversation log.",
      "bound": "One Threads branch to the named remote."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "remote": {
          "type": "string",
          "description": "The remote option for threads.push; see this entry's check and bound."
        }
      },
      "required": [
        "remote"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "push"
      ],
      "positional": [],
      "flags": {
        "remote": {
          "flag": "--remote"
        }
      },
      "local_flags": [
        "remote"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.send",
    "owner": "cli",
    "status": "active",
    "job": "J5",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Start a hosted Thread with an explicit recipient.",
      "use_when": "Send a new topic remotely; use reply/post for an existing Thread.",
      "check": "Verify recipient and content. Preserve post_id and all arguments for an exact retry after uncertain delivery.",
      "bound": "One opening post; no automatic retry of an uncertain send."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "recipient": {
          "type": "string",
          "description": "Positional recipient for threads.send."
        },
        "space": {
          "type": "string",
          "description": "The space option for threads.send; see this entry's check and bound."
        },
        "about": {
          "type": "string",
          "description": "The about option for threads.send; see this entry's check and bound."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "share": {
          "type": "string",
          "description": "The share option for threads.send; see this entry's check and bound."
        },
        "share_roots": {
          "type": "array",
          "description": "The share-roots option for threads.send; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        },
        "space_map": {
          "type": "string",
          "description": "The space-map option for threads.send; see this entry's check and bound."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "send_id": {
          "type": "string",
          "description": "The send-id option for threads.send; see this entry's check and bound."
        },
        "grade": {
          "type": "string",
          "description": "The grade option for threads.send; see this entry's check and bound."
        },
        "post_id": {
          "type": "string",
          "description": "Stable id for exact hosted resend after uncertain delivery."
        },
        "tags": {
          "type": "array",
          "description": "Retrieval labels.",
          "items": {
            "type": "string"
          }
        },
        "home": {
          "type": "string",
          "description": "The home option for threads.send; see this entry's check and bound."
        }
      },
      "required": [
        "recipient",
        "name",
        "summary",
        "message"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "send"
      ],
      "positional": [
        "recipient"
      ],
      "flags": {
        "space": {
          "flag": "--space"
        },
        "about": {
          "flag": "--about"
        },
        "map": {
          "flag": "--map"
        },
        "share": {
          "flag": "--share"
        },
        "share_roots": {
          "flag": "--share-roots",
          "list": "csv"
        },
        "space_map": {
          "flag": "--space-map"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "message": {
          "flag": "--message"
        },
        "send_id": {
          "flag": "--send-id"
        },
        "grade": {
          "flag": "--grade"
        },
        "post_id": {
          "flag": "--post-id"
        },
        "tags": {
          "flag": "--tags",
          "list": "csv"
        },
        "home": {
          "flag": "--home"
        }
      },
      "local_flags": [
        "space",
        "about",
        "map",
        "share",
        "share-roots",
        "space-map",
        "name",
        "summary",
        "message",
        "send-id",
        "grade"
      ],
      "hosted_flags": [
        "name",
        "summary",
        "message",
        "post-id",
        "map",
        "tags",
        "home"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.reply",
    "owner": "cli",
    "status": "active",
    "job": "J5",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Reply to an exact hosted Thread post.",
      "use_when": "Continue an existing hosted discussion.",
      "check": "Supply reply_to; preserve post_id for exact retry. Do not resend as a new topic.",
      "bound": "One hosted post."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "reply_to": {
          "type": "array",
          "description": "Parent post id(s); latest is explicit, never implicit.",
          "items": {
            "type": "string"
          }
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "post_id": {
          "type": "string",
          "description": "Stable id for exact hosted resend after uncertain delivery."
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "tags": {
          "type": "array",
          "description": "Retrieval labels.",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "thread",
        "reply_to"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "reply"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "reply_to": {
          "flag": "--reply-to",
          "list": "csv"
        },
        "message": {
          "flag": "--message"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "post_id": {
          "flag": "--post-id"
        },
        "map": {
          "flag": "--map"
        },
        "tags": {
          "flag": "--tags",
          "list": "csv"
        }
      },
      "local_flags": [
        "map",
        "name",
        "summary",
        "message",
        "send-id",
        "reply-to"
      ],
      "hosted_flags": [
        "reply-to",
        "message",
        "name",
        "summary",
        "post-id",
        "map",
        "tags"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.ack",
    "owner": "cli",
    "status": "active",
    "job": "J5",
    "effect": "write-hosted",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Explicitly acknowledge local or hosted Thread activity.",
      "use_when": "A person or reader explicitly chooses how far to mark read.",
      "check": "Reading does not acknowledge. Supply through, recent, seq or cursor for the selected location.",
      "bound": "One explicit read position; unseen posts remain unread."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "through": {
          "type": "string",
          "description": "The through option for threads.ack; see this entry's check and bound."
        },
        "recent": {
          "type": "string",
          "description": "The recent option for threads.ack; see this entry's check and bound."
        },
        "reader": {
          "type": "string",
          "description": "The reader option for threads.ack; see this entry's check and bound."
        },
        "seq": {
          "type": "integer",
          "description": "The seq option for threads.ack; see this entry's check and bound.",
          "minimum": 0
        },
        "cursor": {
          "type": "string",
          "description": "Opaque continuation/read position returned by this operation."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "ack"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "through": {
          "flag": "--through"
        },
        "recent": {
          "flag": "--recent"
        },
        "reader": {
          "flag": "--reader"
        },
        "seq": {
          "flag": "--seq"
        },
        "cursor": {
          "flag": "--cursor"
        }
      },
      "local_flags": [
        "through",
        "recent",
        "reader"
      ],
      "hosted_flags": [
        "seq",
        "cursor"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.rename",
    "owner": "cli",
    "status": "active",
    "job": "J5",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Append a hosted Thread reframe with title and summary.",
      "use_when": "Rename a hosted Thread with a stated reason.",
      "check": "Supply name, summary and message; preserve post_id for retries.",
      "bound": "One hosted reframe post."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "post_id": {
          "type": "string",
          "description": "Stable id for exact hosted resend after uncertain delivery."
        }
      },
      "required": [
        "thread",
        "name",
        "summary",
        "message"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "rename"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "name": {
          "flag": "--name"
        },
        "message": {
          "flag": "--message"
        },
        "summary": {
          "flag": "--summary"
        },
        "post_id": {
          "flag": "--post-id"
        }
      },
      "local_flags": [
        "name"
      ],
      "hosted_flags": [
        "message",
        "name",
        "summary",
        "post-id"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.capabilities",
    "owner": "cli",
    "status": "active",
    "job": "J5",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read the existing hosted Threads transport capability schema.",
      "use_when": "Before a remote Thread operation.",
      "check": "Schema must be ideaspaces.threads.capabilities.v1; no legacy exchange fallback.",
      "bound": "One unchanged capability document."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "capabilities"
      ],
      "positional": [],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.list",
    "owner": "cli",
    "status": "active",
    "job": "J6",
    "effect": "read",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List local or hosted Threads.",
      "use_when": "Discover Threads before reading one.",
      "check": "Local rows may include unreadable posts. new is reader state; hosted unread counts come from the service.",
      "bound": "Hosted pages default 50, max 200; continue cursor. Local list has no paging and returns all discovered Threads."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "new": {
          "type": "boolean",
          "description": "The new option for threads.list; see this entry's check and bound."
        },
        "unread": {
          "type": "boolean",
          "description": "The unread option for threads.list; see this entry's check and bound."
        },
        "space": {
          "type": "string",
          "description": "The space option for threads.list; see this entry's check and bound."
        },
        "depth": {
          "type": "string",
          "description": "Progressive-disclosure rung or numeric tree depth as documented."
        },
        "kind": {
          "type": "string",
          "description": "Local immutable post kind; hosted kind is chosen by its verb."
        },
        "since": {
          "type": "string",
          "description": "Continuation position from the prior page or ISO filter where supported."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 1
        },
        "cursor": {
          "type": "string",
          "description": "Opaque continuation/read position returned by this operation."
        },
        "open": {
          "type": "boolean",
          "description": "The open option for threads.list; see this entry's check and bound."
        },
        "reader": {
          "type": "string",
          "description": "The reader option for threads.list; see this entry's check and bound."
        },
        "hosted": {
          "type": "boolean",
          "description": "Use hosted routing rather than the local/legacy path."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "list"
      ],
      "positional": [],
      "flags": {
        "new": {
          "flag": "--new",
          "boolean": "bare"
        },
        "unread": {
          "flag": "--unread",
          "boolean": "bare"
        },
        "space": {
          "flag": "--space"
        },
        "depth": {
          "flag": "--depth"
        },
        "kind": {
          "flag": "--kind"
        },
        "since": {
          "flag": "--since"
        },
        "limit": {
          "flag": "--limit"
        },
        "cursor": {
          "flag": "--cursor"
        },
        "open": {
          "flag": "--open",
          "boolean": "bare"
        },
        "reader": {
          "flag": "--reader"
        },
        "hosted": {
          "flag": "--hosted",
          "boolean": "bare"
        }
      },
      "local_flags": [
        "new",
        "unread",
        "space",
        "depth",
        "kind",
        "since",
        "limit",
        "cursor",
        "open",
        "reader"
      ],
      "hosted_flags": [
        "hosted",
        "limit",
        "cursor",
        "new",
        "unread"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.recent",
    "owner": "cli",
    "status": "active",
    "job": "J6",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read local Thread activity since a cursor or named reader baseline.",
      "use_when": "Find what moved, not every Thread.",
      "check": "Compare shown with moved; baseline means nothing new yet. Reading does not advance the position.",
      "bound": "Default 50 Threads, max 500; keep returned cursor; unshown activity stays new."
    },
    "bound": {
      "unit": "entries",
      "default": 50,
      "max": 500,
      "says": true,
      "continue": "cursor"
    },
    "parameters": {
      "type": "object",
      "properties": {
        "cursor": {
          "type": "string",
          "description": "Opaque continuation/read position returned by this operation."
        },
        "reader": {
          "type": "string",
          "description": "The reader option for threads.recent; see this entry's check and bound."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 1,
          "maximum": 500,
          "default": 50
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "recent"
      ],
      "positional": [],
      "flags": {
        "cursor": {
          "flag": "--cursor"
        },
        "reader": {
          "flag": "--reader"
        },
        "limit": {
          "flag": "--limit"
        }
      },
      "local_flags": [
        "cursor",
        "reader",
        "limit"
      ]
    },
    "output": {
      "json": [
        "schema",
        "baseline",
        "threads",
        "moved",
        "shown",
        "cursor"
      ]
    }
  },
  {
    "id": "threads.check",
    "owner": "cli",
    "status": "active",
    "job": "J6",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Check local posts changed or deleted since commit.",
      "use_when": "Verify immutable Thread history before relying on it.",
      "check": "Strict exits nonzero on findings or incomplete Git evidence.",
      "bound": "All findings in selected Thread or local root; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "strict": {
          "type": "boolean",
          "description": "The strict option for threads.check; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "check"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "strict": {
          "flag": "--strict",
          "boolean": "bare"
        }
      },
      "local_flags": [
        "strict"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "map.create",
    "owner": "cli",
    "status": "active",
    "job": "J7",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Create a local Map Note.",
      "use_when": "Start a local view over references.",
      "check": "Check path, name and summary; a Map never grants content access.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        }
      },
      "required": [
        "path",
        "name",
        "summary"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "map",
        "create"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "map.add",
    "owner": "cli",
    "status": "active",
    "job": "J7",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Add one reference or root/member to a local Map.",
      "use_when": "Explicitly extend a local view.",
      "check": "Check root identity, pin and position; adding a reference shares nothing.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "address": {
          "type": "string",
          "description": "Positional address for map.add."
        },
        "depth": {
          "type": "string",
          "description": "Progressive-disclosure rung or numeric tree depth as documented."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "position": {
          "type": "string",
          "description": "The position option for map.add; see this entry's check and bound."
        },
        "root": {
          "type": "integer",
          "description": "Explicit root selector; meaning is command-specific.",
          "minimum": 0
        },
        "root_node_id": {
          "type": "string",
          "description": "The root-node-id option for map.add; see this entry's check and bound."
        },
        "sha": {
          "type": "string",
          "description": "The sha option for map.add; see this entry's check and bound."
        },
        "checkout": {
          "type": "string",
          "description": "The checkout option for map.add; see this entry's check and bound."
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "map",
        "add"
      ],
      "positional": [
        "path",
        "address"
      ],
      "flags": {
        "depth": {
          "flag": "--depth"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "position": {
          "flag": "--position"
        },
        "root": {
          "flag": "--root"
        },
        "root_node_id": {
          "flag": "--root-node-id"
        },
        "sha": {
          "flag": "--sha"
        },
        "checkout": {
          "flag": "--checkout"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "map.remove",
    "owner": "cli",
    "status": "active",
    "job": "J7",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Remove one local Map member or empty root.",
      "use_when": "Explicitly narrow a view, never delete referenced content.",
      "check": "Use if_match from map.read for ordinal removal; inspect address/position.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "selector": {
          "type": "string",
          "description": "Positional selector for map.remove."
        },
        "if_match": {
          "type": "string",
          "description": "Expected revision: local hash, or hosted version_id for spaces edits."
        },
        "root_node_id": {
          "type": "string",
          "description": "The root-node-id option for map.remove; see this entry's check and bound."
        },
        "position": {
          "type": "string",
          "description": "The position option for map.remove; see this entry's check and bound."
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "map",
        "remove"
      ],
      "positional": [
        "path",
        "selector"
      ],
      "flags": {
        "if_match": {
          "flag": "--if-match"
        },
        "root_node_id": {
          "flag": "--root-node-id"
        },
        "position": {
          "flag": "--position"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "map.select",
    "owner": "cli",
    "status": "active",
    "job": "J7",
    "effect": "read",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Select exact hosted context from a local Note, Map or directory.",
      "use_when": "Build a pinned hosted-context selection for an existing published repo.",
      "check": "Check binding, committed identity and remote head; references never grant access.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "hostname": {
          "type": "string",
          "description": "The hostname option for map.select; see this entry's check and bound."
        },
        "note_depth": {
          "type": "string",
          "description": "The note-depth option for map.select; see this entry's check and bound."
        },
        "entity_depth": {
          "type": "string",
          "description": "The entity-depth option for map.select; see this entry's check and bound."
        },
        "note_name": {
          "type": "string",
          "description": "The note-name option for map.select; see this entry's check and bound."
        },
        "note_summary": {
          "type": "string",
          "description": "The note-summary option for map.select; see this entry's check and bound."
        },
        "entity_name": {
          "type": "string",
          "description": "The entity-name option for map.select; see this entry's check and bound."
        },
        "entity_summary": {
          "type": "string",
          "description": "The entity-summary option for map.select; see this entry's check and bound."
        },
        "about": {
          "type": "string",
          "description": "The about option for map.select; see this entry's check and bound."
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "map",
        "select"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "hostname": {
          "flag": "--hostname"
        },
        "note_depth": {
          "flag": "--note-depth"
        },
        "entity_depth": {
          "flag": "--entity-depth"
        },
        "note_name": {
          "flag": "--note-name"
        },
        "note_summary": {
          "flag": "--note-summary"
        },
        "entity_name": {
          "flag": "--entity-name"
        },
        "entity_summary": {
          "flag": "--entity-summary"
        },
        "about": {
          "flag": "--about"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "spaces.list",
    "owner": "cli",
    "status": "active",
    "job": "J7",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List hosted Maps or legacy coordination objects.",
      "use_when": "Choose a hosted Space before reading or editing it.",
      "check": "Use hosted for Maps; local Maps and legacy objects are different.",
      "bound": "Unbounded result for the selected scope; no client continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "hosted": {
          "type": "boolean",
          "description": "Use hosted routing rather than the local/legacy path."
        },
        "attached_to": {
          "type": "string",
          "description": "The attached-to option for spaces.list; see this entry's check and bound."
        },
        "include_dormant": {
          "type": "boolean",
          "description": "The include-dormant option for spaces.list; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "spaces",
        "list"
      ],
      "positional": [],
      "flags": {
        "hosted": {
          "flag": "--hosted",
          "boolean": "bare"
        },
        "attached_to": {
          "flag": "--attached-to"
        },
        "include_dormant": {
          "flag": "--include-dormant",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "spaces.open",
    "owner": "cli",
    "status": "active",
    "job": "J8",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read one hosted Map and its current version.",
      "use_when": "Need members and version_id for a guarded hosted edit.",
      "check": "Check omitted_members, independent item access and version_id.",
      "bound": "Service may omit members; inspect omitted_members. No client continuation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "map_id": {
          "type": "string",
          "description": "Positional map id for spaces.open."
        }
      },
      "required": [
        "map_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "spaces",
        "open"
      ],
      "positional": [
        "map_id"
      ],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "spaces.new",
    "owner": "cli",
    "status": "active",
    "job": "J8",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Create a hosted Space with a Core Thread in an explicit Vault.",
      "use_when": "A person explicitly wants a new hosted Space.",
      "check": "Check Vault ownership and subscription; keep command_id and arguments for exact retries.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "hosted": {
          "type": "boolean",
          "description": "Use hosted routing rather than the local/legacy path."
        },
        "vault": {
          "type": "string",
          "description": "The vault option for spaces.new; see this entry's check and bound."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "command_id": {
          "type": "string",
          "description": "Stable hosted write id; retain identical arguments for exact retry."
        }
      },
      "required": [
        "hosted",
        "vault",
        "name",
        "summary",
        "message"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "spaces",
        "new"
      ],
      "positional": [],
      "flags": {
        "hosted": {
          "flag": "--hosted",
          "boolean": "bare"
        },
        "vault": {
          "flag": "--vault"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "message": {
          "flag": "--message"
        },
        "command_id": {
          "flag": "--command-id"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "spaces.add",
    "owner": "cli",
    "status": "active",
    "job": "J8",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Add one reference to a hosted Map at an expected version.",
      "use_when": "Extend a hosted view without granting content access.",
      "check": "Use if_match version_id, not a file hash; preserve command_id for retries.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "map_id": {
          "type": "string",
          "description": "Positional map id for spaces.add."
        },
        "address": {
          "type": "string",
          "description": "Positional address for spaces.add."
        },
        "if_match": {
          "type": "string",
          "description": "Expected revision: local hash, or hosted version_id for spaces edits."
        },
        "command_id": {
          "type": "string",
          "description": "Stable hosted write id; retain identical arguments for exact retry."
        },
        "depth": {
          "type": "string",
          "description": "Progressive-disclosure rung or numeric tree depth as documented."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "position": {
          "type": "string",
          "description": "The position option for spaces.add; see this entry's check and bound."
        },
        "root_node_id": {
          "type": "string",
          "description": "The root-node-id option for spaces.add; see this entry's check and bound."
        },
        "sha": {
          "type": "string",
          "description": "The sha option for spaces.add; see this entry's check and bound."
        }
      },
      "required": [
        "map_id",
        "if_match"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "spaces",
        "add"
      ],
      "positional": [
        "map_id",
        "address"
      ],
      "flags": {
        "if_match": {
          "flag": "--if-match"
        },
        "command_id": {
          "flag": "--command-id"
        },
        "depth": {
          "flag": "--depth"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "position": {
          "flag": "--position"
        },
        "root_node_id": {
          "flag": "--root-node-id"
        },
        "sha": {
          "flag": "--sha"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "spaces.remove",
    "owner": "cli",
    "status": "active",
    "job": "J8",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "plan-then-yes",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Preview or remove one hosted Map member.",
      "use_when": "Explicitly remove a reference, never content.",
      "check": "Read the preview then yes; Core cannot be removed. Use if_match version_id.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "map_id": {
          "type": "string",
          "description": "Positional map id for spaces.remove."
        },
        "ordinal": {
          "type": "string",
          "description": "Positional ordinal for spaces.remove."
        },
        "if_match": {
          "type": "string",
          "description": "Expected revision: local hash, or hosted version_id for spaces edits."
        },
        "command_id": {
          "type": "string",
          "description": "Stable hosted write id; retain identical arguments for exact retry."
        },
        "yes": {
          "type": "boolean",
          "description": "The yes option for spaces.remove; see this entry's check and bound."
        }
      },
      "required": [
        "map_id",
        "ordinal",
        "if_match"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "spaces",
        "remove"
      ],
      "positional": [
        "map_id",
        "ordinal"
      ],
      "flags": {
        "if_match": {
          "flag": "--if-match"
        },
        "command_id": {
          "flag": "--command-id"
        },
        "yes": {
          "flag": "--yes",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "spaces.import",
    "owner": "cli",
    "status": "active",
    "job": "J8",
    "effect": "write-hosted",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Create a personal hosted copy of a local Map.",
      "use_when": "Copy a local view to the service explicitly.",
      "check": "Uncertain import is not retried; check list first. No new Core or content grants.",
      "bound": "One local Map, max 1048576 UTF-8 bytes."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "spaces",
        "import"
      ],
      "positional": [
        "path"
      ],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "spaces.export",
    "owner": "cli",
    "status": "active",
    "job": "J8",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Write an independent local copy of a hosted Map/version.",
      "use_when": "Need a portable local Map copy.",
      "check": "Use version_id for an exact copy; destination must not exist.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "map_or_version_id": {
          "type": "string",
          "description": "Positional map or version id for spaces.export."
        },
        "path": {
          "type": "string",
          "description": "Local path to the target."
        }
      },
      "required": [
        "map_or_version_id",
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "spaces",
        "export"
      ],
      "positional": [
        "map_or_version_id",
        "path"
      ],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "vaults",
    "owner": "cli",
    "status": "active",
    "job": "J8",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List personal, organization and shared Vaults.",
      "use_when": "Choose a Vault for hosted Space creation.",
      "check": "Company creation needs org_node_id and current OWNER authority.",
      "bound": "Unbounded result for the selected scope; no client continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "vaults"
      ],
      "positional": [],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "get",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "plan-then-yes",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Preview bringing a Space home; yes plus as selects clone, fork or link.",
      "use_when": "Start from a shared URL or existing directory.",
      "check": "Read proposed action and destination before yes.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "source": {
          "type": "string",
          "description": "Positional source for get."
        },
        "destination": {
          "type": "string",
          "description": "Positional destination for get."
        },
        "as": {
          "type": "string",
          "description": "The as option for get; see this entry's check and bound."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "yes": {
          "type": "boolean",
          "description": "The yes option for get; see this entry's check and bound."
        }
      },
      "required": [
        "source"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "get"
      ],
      "positional": [
        "source",
        "destination"
      ],
      "flags": {
        "as": {
          "flag": "--as"
        },
        "name": {
          "flag": "--name"
        },
        "yes": {
          "flag": "--yes",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "clone",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Clone an authorized repo into a local folder.",
      "use_when": "Need remote history and an ongoing Git remote.",
      "check": "Check destination and authorization; cloning does not widen access.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "source": {
          "type": "string",
          "description": "Positional source for clone."
        },
        "destination": {
          "type": "string",
          "description": "Positional destination for clone."
        }
      },
      "required": [
        "source"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "clone"
      ],
      "positional": [
        "source",
        "destination"
      ],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "fork",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Materialize an independent local copy without source history.",
      "use_when": "Need an independent Space rather than a remote clone.",
      "check": "Check source lineage and destination; no implicit publish or sharing.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "source": {
          "type": "string",
          "description": "Positional source for fork."
        },
        "destination": {
          "type": "string",
          "description": "Positional destination for fork."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        }
      },
      "required": [
        "source"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "fork"
      ],
      "positional": [
        "source",
        "destination"
      ],
      "flags": {
        "name": {
          "flag": "--name"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "link",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Bind an existing local clone to a hosted repo.",
      "use_when": "Already have a checkout to register.",
      "check": "Check the checkout identity and selected hosted repo.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "link"
      ],
      "positional": [
        "path",
        "repo"
      ],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "forget",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Unregister a local checkout, optionally delete its folder.",
      "use_when": "Explicitly stop tracking a clone.",
      "check": "Delete removes the folder; never set delete without the person agreeing.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "delete": {
          "type": "boolean",
          "description": "The delete option for forget; see this entry's check and bound."
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "forget"
      ],
      "positional": [
        "path"
      ],
      "flags": {
        "delete": {
          "flag": "--delete",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "clones",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List registered local checkouts.",
      "use_when": "Need local paths and identities, not hosted repo discovery.",
      "check": "Entries can be stale; check path availability before using them.",
      "bound": "Unbounded result for the selected scope; no client continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "clones"
      ],
      "positional": [],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "integrate",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "plan-then-yes",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Preview or apply remote/source updates for this checkout.",
      "use_when": "Bring content up to date using the checkout kind.",
      "check": "Read preview before yes; check from and conflict results.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "description": "The from option for integrate; see this entry's check and bound."
        },
        "rebase": {
          "type": "boolean",
          "description": "The rebase option for integrate; see this entry's check and bound."
        },
        "yes": {
          "type": "boolean",
          "description": "The yes option for integrate; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "integrate"
      ],
      "positional": [],
      "flags": {
        "from": {
          "flag": "--from"
        },
        "rebase": {
          "flag": "--rebase",
          "boolean": "bare"
        },
        "yes": {
          "flag": "--yes",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "update",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "plan-then-yes",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Preview or apply source updates to a fork.",
      "use_when": "Need a three-way fork source update, not a CLI upgrade.",
      "check": "Read plan before yes; resolve conflicts deliberately.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "yes": {
          "type": "boolean",
          "description": "The yes option for update; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "update"
      ],
      "positional": [],
      "flags": {
        "yes": {
          "flag": "--yes",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "pull",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "write-local",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Fetch and integrate remote Git changes into this checkout.",
      "use_when": "Explicitly update a clone, not a fork source.",
      "check": "Use dry_run first when useful; dirty captures must be saved first.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "dry_run": {
          "type": "boolean",
          "description": "The dry-run option for pull; see this entry's check and bound."
        },
        "rebase": {
          "type": "boolean",
          "description": "The rebase option for pull; see this entry's check and bound.",
          "default": true
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "pull"
      ],
      "positional": [],
      "flags": {
        "dry_run": {
          "flag": "--dry-run",
          "boolean": "bare"
        },
        "rebase": {
          "flag": "--rebase",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "push",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "share",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Push committed captures to the configured remote.",
      "use_when": "Sharing committed repo state was explicitly requested.",
      "check": "Check dry_run, remote and ahead/behind; pull first if behind.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "dry_run": {
          "type": "boolean",
          "description": "The dry-run option for push; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "push"
      ],
      "positional": [],
      "flags": {
        "dry_run": {
          "flag": "--dry-run",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "sync",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "status",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Report local, remote and fork-source state without integrating.",
      "use_when": "Need a sync plan rather than an update.",
      "check": "Read conflict/drift findings; this report does not integrate content.",
      "bound": "Unbounded result for the selected scope; no client continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 1
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "sync"
      ],
      "positional": [],
      "flags": {
        "limit": {
          "flag": "--limit"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "catalog",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "read",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List local and remote repos with sync state.",
      "use_when": "Need a combined repository overview.",
      "check": "Fetch is explicit; unavailable remote evidence is not clean state.",
      "bound": "Unbounded result for the selected scope; no client continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "fetch": {
          "type": "boolean",
          "description": "The fetch option for catalog; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "catalog"
      ],
      "positional": [],
      "flags": {
        "fetch": {
          "flag": "--fetch",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "repos",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List hosted repos and your available actions.",
      "use_when": "Discover repos, not Maps or local checkout paths.",
      "check": "Check relationship and actions; repo access is separate from Space membership.",
      "bound": "Unbounded result for the selected scope; no client continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "repos"
      ],
      "positional": [],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "publish",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "share",
    "reach": "local+hosted",
    "confirm": "plan-then-yes",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Preview or publish this folder as a remote repo.",
      "use_when": "A person explicitly wants to host this local repo.",
      "check": "Read the plan before yes; verify slug and hostname.",
      "bound": "One target per call; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "slug": {
          "type": "string",
          "description": "The slug option for publish; see this entry's check and bound."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "hostname": {
          "type": "string",
          "description": "The hostname option for publish; see this entry's check and bound."
        },
        "yes": {
          "type": "boolean",
          "description": "The yes option for publish; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "publish"
      ],
      "positional": [],
      "flags": {
        "slug": {
          "flag": "--slug"
        },
        "name": {
          "flag": "--name"
        },
        "hostname": {
          "flag": "--hostname"
        },
        "yes": {
          "flag": "--yes",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "status",
    "owner": "cli",
    "status": "active",
    "job": "J9",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read Git state, staged captures, activity and drift.",
      "use_when": "Need volatile checkout state or one file revision.",
      "check": "No session capture ownership is inferred by this CLI; inspect staged paths.",
      "bound": "Unbounded result for the selected scope; no client continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local path to the target."
        },
        "fetch": {
          "type": "boolean",
          "description": "The fetch option for status; see this entry's check and bound."
        },
        "workspace": {
          "type": "string",
          "description": "The workspace option for status; see this entry's check and bound."
        },
        "mount": {
          "type": "array",
          "description": "The mount option for status; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        },
        "pullable": {
          "type": "string",
          "description": "The pullable option for status; see this entry's check and bound."
        },
        "contract": {
          "type": "string",
          "description": "The contract option for status; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "status"
      ],
      "positional": [],
      "flags": {
        "path": {
          "flag": "--path"
        },
        "fetch": {
          "flag": "--fetch",
          "boolean": "bare"
        },
        "workspace": {
          "flag": "--workspace"
        },
        "mount": {
          "flag": "--mount",
          "list": "csv"
        },
        "pullable": {
          "flag": "--pullable"
        },
        "contract": {
          "flag": "--contract"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.status",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Inspect access and standing.",
      "use_when": "Before changing access.",
      "check": "Read standing and direct versus inherited capabilities.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_url": {
          "type": "string",
          "description": "Positional repo url for share.status."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.status; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "status"
      ],
      "positional": [
        "repo_url"
      ],
      "flags": {
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.log",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read the per-node access event log.",
      "use_when": "When auditing access decisions.",
      "check": "Verify the node id and event provenance.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_url": {
          "type": "string",
          "description": "Positional repo url for share.log."
        },
        "node": {
          "type": "string",
          "description": "The node option for share.log; see this entry's check and bound."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.log; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "log"
      ],
      "positional": [
        "repo_url"
      ],
      "flags": {
        "node": {
          "flag": "--node"
        },
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.person",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "share",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Grant or invite a person at an explicit grade.",
      "use_when": "When the person explicitly requested sharing.",
      "check": "Verify recipient and grade; history is a separate explicit grant.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "recipient": {
          "type": "string",
          "description": "Positional recipient for share.person."
        },
        "grade": {
          "type": "string",
          "description": "The grade option for share.person; see this entry's check and bound."
        },
        "history": {
          "type": "boolean",
          "description": "The history option for share.person; see this entry's check and bound."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.person; see this entry's check and bound."
        }
      },
      "required": [
        "recipient"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "person"
      ],
      "positional": [
        "recipient"
      ],
      "flags": {
        "grade": {
          "flag": "--grade"
        },
        "history": {
          "flag": "--history",
          "boolean": "bare"
        },
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.team",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "share",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Grant access to a team.",
      "use_when": "When team sharing is explicitly agreed.",
      "check": "Verify hostname, grade and inherited access.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "hostname": {
          "type": "string",
          "description": "Positional hostname for share.team."
        },
        "grade": {
          "type": "string",
          "description": "The grade option for share.team; see this entry's check and bound."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.team; see this entry's check and bound."
        }
      },
      "required": [
        "hostname"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "team"
      ],
      "positional": [
        "hostname"
      ],
      "flags": {
        "grade": {
          "flag": "--grade"
        },
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.list",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List direct people, invitations and teams.",
      "use_when": "Before changing an existing grant.",
      "check": "Inspect direct and inherited grants separately.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.list; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "list"
      ],
      "positional": [],
      "flags": {
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.remove",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "share",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Remove direct access or an invitation.",
      "use_when": "When revocation is explicitly agreed.",
      "check": "Inherited access may remain; inspect the result.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "recipient": {
          "type": "string",
          "description": "Positional recipient for share.remove."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.remove; see this entry's check and bound."
        }
      },
      "required": [
        "recipient"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "remove"
      ],
      "positional": [
        "recipient"
      ],
      "flags": {
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.resend",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "share",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Resend a pending invitation.",
      "use_when": "When an invitation needs another delivery.",
      "check": "Verify email and pending state.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "recipient": {
          "type": "string",
          "description": "Positional recipient for share.resend."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.resend; see this entry's check and bound."
        }
      },
      "required": [
        "recipient"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "resend"
      ],
      "positional": [
        "recipient"
      ],
      "flags": {
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.history",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "share",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Set history visibility for a person.",
      "use_when": "When explicitly asked to change history access.",
      "check": "Verify identity and on/off; this changes what history is shared.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "recipient": {
          "type": "string",
          "description": "Positional recipient for share.history."
        },
        "state": {
          "type": "string",
          "description": "Positional state for share.history."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.history; see this entry's check and bound."
        }
      },
      "required": [
        "recipient",
        "state"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "history"
      ],
      "positional": [
        "recipient",
        "state"
      ],
      "flags": {
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "share.visibility",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "share",
    "reach": "hosted",
    "confirm": "plan-then-yes",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Preview or set public/private visibility.",
      "use_when": "When publication visibility is explicitly agreed.",
      "check": "Read plan before yes; public visibility exposes content.",
      "bound": "Unbounded service result for this repo/node; no client-side continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "visibility": {
          "type": "string",
          "description": "Positional visibility for share.visibility."
        },
        "repo": {
          "type": "string",
          "description": "Explicit remote repository URL (global CLI flag)."
        },
        "space": {
          "type": "string",
          "description": "The space option for share.visibility; see this entry's check and bound."
        },
        "yes": {
          "type": "boolean",
          "description": "The yes option for share.visibility; see this entry's check and bound."
        }
      },
      "required": [
        "visibility"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "share",
        "visibility"
      ],
      "positional": [
        "visibility"
      ],
      "flags": {
        "repo": {
          "flag": "--repo"
        },
        "space": {
          "flag": "--space"
        },
        "yes": {
          "flag": "--yes",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "request.ask",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Ask an owner for access.",
      "use_when": "Need access that is not granted yet.",
      "check": "A request is not a grant; check target, grade and returned request id.",
      "bound": "One request per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "node_id": {
          "type": "string",
          "description": "Hosted node identity."
        },
        "grade": {
          "type": "string",
          "description": "The grade option for request.ask; see this entry's check and bound."
        },
        "reason": {
          "type": "string",
          "description": "The reason option for request.ask; see this entry's check and bound."
        }
      },
      "required": [
        "node_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "request",
        "ask"
      ],
      "positional": [
        "node_id"
      ],
      "flags": {
        "grade": {
          "flag": "--grade"
        },
        "reason": {
          "flag": "--reason"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "request.list",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List incoming or your own access requests.",
      "use_when": "Inspect pending decisions before approving or cancelling.",
      "check": "Mine/own select your requests; incoming is the default.",
      "bound": "Unbounded service request list; no client continuation."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "incoming": {
          "type": "boolean",
          "description": "The incoming option for request.list; see this entry's check and bound."
        },
        "mine": {
          "type": "boolean",
          "description": "The mine option for request.list; see this entry's check and bound."
        },
        "own": {
          "type": "boolean",
          "description": "The own option for request.list; see this entry's check and bound."
        },
        "include_terminal": {
          "type": "boolean",
          "description": "The include-terminal option for request.list; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "request",
        "list"
      ],
      "positional": [],
      "flags": {
        "incoming": {
          "flag": "--incoming",
          "boolean": "bare"
        },
        "mine": {
          "flag": "--mine",
          "boolean": "bare"
        },
        "own": {
          "flag": "--own",
          "boolean": "bare"
        },
        "include_terminal": {
          "flag": "--include-terminal",
          "boolean": "bare"
        }
      }
    },
    "aliases": [
      "request incoming"
    ],
    "output": {
      "json": []
    }
  },
  {
    "id": "request.approve",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "share",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Approve one incoming access request.",
      "use_when": "An authorized owner explicitly agrees to grant access.",
      "check": "Verify request, recipient and approved grade.",
      "bound": "One request per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "request_id": {
          "type": "string",
          "description": "Positional request id for request.approve."
        },
        "grade": {
          "type": "string",
          "description": "The grade option for request.approve; see this entry's check and bound."
        }
      },
      "required": [
        "request_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "request",
        "approve"
      ],
      "positional": [
        "request_id"
      ],
      "flags": {
        "grade": {
          "flag": "--grade"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "request.deny",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Decline one incoming access request.",
      "use_when": "An authorized owner explicitly refuses the request.",
      "check": "Check request identity and resulting state.",
      "bound": "One request per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "request_id": {
          "type": "string",
          "description": "Positional request id for request.deny."
        }
      },
      "required": [
        "request_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "request",
        "deny"
      ],
      "positional": [
        "request_id"
      ],
      "flags": {}
    },
    "aliases": [
      "request decline"
    ],
    "output": {
      "json": []
    }
  },
  {
    "id": "request.cancel",
    "owner": "cli",
    "status": "active",
    "job": "J10",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Cancel your own pending access request.",
      "use_when": "Explicitly withdraw a request you made.",
      "check": "Check ownership and request state; grants are not revoked.",
      "bound": "One request per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "request_id": {
          "type": "string",
          "description": "Positional request id for request.cancel."
        }
      },
      "required": [
        "request_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "request",
        "cancel"
      ],
      "positional": [
        "request_id"
      ],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "agent.run",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "launch",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Launch a local agent POV on Pi or Claude with explicit reach.",
      "use_when": "Need a separate agent run; inspect agent.capabilities first.",
      "check": "Check disclosed reach, requested versus observed model and final status. Host permissions still govern.",
      "bound": "Message capped at 8192 bytes; no implicit run ceiling. Output streams lifecycle events."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "pov": {
          "type": "string",
          "description": "Positional pov for agent.run."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "task": {
          "type": "string",
          "description": "The task option for agent.run; see this entry's check and bound."
        },
        "runtime": {
          "type": "string",
          "description": "The runtime option for agent.run; see this entry's check and bound.",
          "enum": [
            "pi",
            "claude"
          ],
          "default": "pi"
        },
        "model": {
          "type": "string",
          "description": "The model option for agent.run; see this entry's check and bound."
        },
        "parent": {
          "type": "string",
          "description": "The parent option for agent.run; see this entry's check and bound."
        },
        "parent_tool_use_id": {
          "type": "string",
          "description": "The parent-tool-use-id option for agent.run; see this entry's check and bound."
        },
        "run_id": {
          "type": "string",
          "description": "The run-id option for agent.run; see this entry's check and bound."
        },
        "pi_thinking": {
          "type": "string",
          "description": "The pi-thinking option for agent.run; see this entry's check and bound."
        },
        "pi_trust": {
          "type": "string",
          "description": "The pi-trust option for agent.run; see this entry's check and bound."
        },
        "topic": {
          "type": "string",
          "description": "The topic option for agent.run; see this entry's check and bound."
        },
        "ext": {
          "type": "array",
          "description": "The ext option for agent.run; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        },
        "skill": {
          "type": "array",
          "description": "The skill option for agent.run; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        },
        "claude_effort": {
          "type": "string",
          "description": "The claude-effort option for agent.run; see this entry's check and bound."
        },
        "permission_mode": {
          "type": "string",
          "description": "The permission-mode option for agent.run; see this entry's check and bound."
        },
        "read_only": {
          "type": "boolean",
          "description": "Claude read-only launch, with MCP servers removed."
        },
        "reach": {
          "type": "array",
          "description": "Explicit extra directories for a Claude local turn.",
          "items": {
            "type": "string"
          }
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "conversation": {
          "type": "string",
          "description": "The conversation option for agent.run; see this entry's check and bound."
        },
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "thread_map": {
          "type": "string",
          "description": "The thread-map option for agent.run; see this entry's check and bound."
        },
        "thread_member": {
          "type": "integer",
          "description": "The thread-member option for agent.run; see this entry's check and bound.",
          "minimum": 0
        },
        "pi_bin": {
          "type": "string",
          "description": "The pi-bin option for agent.run; see this entry's check and bound."
        },
        "claude_bin": {
          "type": "string",
          "description": "The claude-bin option for agent.run; see this entry's check and bound."
        },
        "pi_model": {
          "type": "string",
          "description": "The pi-model option for agent.run; see this entry's check and bound."
        },
        "claude_model": {
          "type": "string",
          "description": "The claude-model option for agent.run; see this entry's check and bound."
        },
        "session_dir": {
          "type": "string",
          "description": "The session-dir option for agent.run; see this entry's check and bound."
        },
        "working_root": {
          "type": "string",
          "description": "The working-root option for agent.run; see this entry's check and bound."
        },
        "focus": {
          "type": "string",
          "description": "The focus option for agent.run; see this entry's check and bound."
        },
        "autocompact": {
          "type": "string",
          "description": "The autocompact option for agent.run; see this entry's check and bound."
        }
      },
      "required": [
        "pov",
        "message"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "agent",
        "run"
      ],
      "positional": [
        "pov"
      ],
      "flags": {
        "message": {
          "flag": "--message"
        },
        "task": {
          "flag": "--task"
        },
        "runtime": {
          "flag": "--runtime"
        },
        "model": {
          "flag": "--model"
        },
        "parent": {
          "flag": "--parent"
        },
        "parent_tool_use_id": {
          "flag": "--parent-tool-use-id"
        },
        "run_id": {
          "flag": "--run-id"
        },
        "pi_thinking": {
          "flag": "--pi-thinking"
        },
        "pi_trust": {
          "flag": "--pi-trust"
        },
        "topic": {
          "flag": "--topic"
        },
        "ext": {
          "flag": "--ext",
          "list": "csv"
        },
        "skill": {
          "flag": "--skill",
          "list": "csv"
        },
        "claude_effort": {
          "flag": "--claude-effort"
        },
        "permission_mode": {
          "flag": "--permission-mode"
        },
        "read_only": {
          "flag": "--read-only",
          "boolean": "bare"
        },
        "reach": {
          "flag": "--reach",
          "list": "repeat"
        },
        "map": {
          "flag": "--map"
        },
        "conversation": {
          "flag": "--conversation"
        },
        "thread": {
          "flag": "--thread"
        },
        "thread_map": {
          "flag": "--thread-map"
        },
        "thread_member": {
          "flag": "--thread-member"
        },
        "pi_bin": {
          "flag": "--pi-bin"
        },
        "claude_bin": {
          "flag": "--claude-bin"
        },
        "pi_model": {
          "flag": "--pi-model"
        },
        "claude_model": {
          "flag": "--claude-model"
        },
        "session_dir": {
          "flag": "--session-dir"
        },
        "working_root": {
          "flag": "--working-root"
        },
        "focus": {
          "flag": "--focus"
        },
        "autocompact": {
          "flag": "--autocompact"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "agent.runs",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List persisted local agent run records.",
      "use_when": "Inspect past or active runs, optionally by parent or POV.",
      "check": "Check status and model provenance; recorded state is not a live process probe.",
      "bound": "Unbounded unless limit is supplied; filter parent/agent to narrow the local run store."
    },
    "bound": "unbounded",
    "parameters": {
      "type": "object",
      "properties": {
        "parent": {
          "type": "string",
          "description": "The parent option for agent.runs; see this entry's check and bound."
        },
        "agent": {
          "type": "string",
          "description": "The agent option for agent.runs; see this entry's check and bound."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 1
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "agent",
        "runs"
      ],
      "positional": [],
      "flags": {
        "parent": {
          "flag": "--parent"
        },
        "agent": {
          "flag": "--agent"
        },
        "limit": {
          "flag": "--limit"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "agent.record",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Append or merge lifecycle information for an external agent run.",
      "use_when": "A hook or runtime has observed a run update.",
      "check": "Record observed facts only; unavailable model or usage is unknown, not zero.",
      "bound": "One run update, identified by run_id; existing fields merge."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "description": "The run-id option for agent.record; see this entry's check and bound."
        },
        "parent": {
          "type": "string",
          "description": "The parent option for agent.record; see this entry's check and bound."
        },
        "parent_tool_use_id": {
          "type": "string",
          "description": "The parent-tool-use-id option for agent.record; see this entry's check and bound."
        },
        "agent": {
          "type": "string",
          "description": "The agent option for agent.record; see this entry's check and bound."
        },
        "task": {
          "type": "string",
          "description": "The task option for agent.record; see this entry's check and bound."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "harness": {
          "type": "string",
          "description": "The harness option for agent.record; see this entry's check and bound."
        },
        "model": {
          "type": "string",
          "description": "The model option for agent.record; see this entry's check and bound."
        },
        "model_requested": {
          "type": "string",
          "description": "The model-requested option for agent.record; see this entry's check and bound."
        },
        "model_observed": {
          "type": "string",
          "description": "The model-observed option for agent.record; see this entry's check and bound."
        },
        "conversation": {
          "type": "string",
          "description": "The conversation option for agent.record; see this entry's check and bound."
        },
        "status": {
          "type": "string",
          "description": "The status option for agent.record; see this entry's check and bound."
        },
        "started": {
          "type": "string",
          "description": "The started option for agent.record; see this entry's check and bound."
        },
        "ended": {
          "type": "string",
          "description": "The ended option for agent.record; see this entry's check and bound."
        }
      },
      "required": [
        "run_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "agent",
        "record"
      ],
      "positional": [],
      "flags": {
        "run_id": {
          "flag": "--run-id"
        },
        "parent": {
          "flag": "--parent"
        },
        "parent_tool_use_id": {
          "flag": "--parent-tool-use-id"
        },
        "agent": {
          "flag": "--agent"
        },
        "task": {
          "flag": "--task"
        },
        "message": {
          "flag": "--message"
        },
        "harness": {
          "flag": "--harness"
        },
        "model": {
          "flag": "--model"
        },
        "model_requested": {
          "flag": "--model-requested"
        },
        "model_observed": {
          "flag": "--model-observed"
        },
        "conversation": {
          "flag": "--conversation"
        },
        "status": {
          "flag": "--status"
        },
        "started": {
          "flag": "--started"
        },
        "ended": {
          "flag": "--ended"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "agent.list",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List validated local POVs from an explicit Map.",
      "use_when": "Choose an agent POV before launching.",
      "check": "Check validation status and resolved checkout; Map membership grants no access.",
      "bound": "All agent members in the selected Map; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        }
      },
      "required": [
        "map"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "agent",
        "list"
      ],
      "positional": [],
      "flags": {
        "map": {
          "flag": "--map"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "agent.capabilities",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read the existing agent-run guarantees and feature schema.",
      "use_when": "Before building a launcher or choosing run flags.",
      "check": "Use feature guarantees, not help text, to decide what this installed CLI supports.",
      "bound": "One capability document; unchanged schema id."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "agent",
        "capabilities"
      ],
      "positional": [],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "conversation.new",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Create a private hosted conversation.",
      "use_when": "Start a hosted conversation for a repo and optional Agent Actor.",
      "check": "Check returned conversation id and selected repo.",
      "bound": "One conversation per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_id": {
          "type": "string",
          "description": "Hosted repository id."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "agent": {
          "type": "string",
          "description": "The agent option for conversation.new; see this entry's check and bound."
        },
        "local": {
          "type": "boolean",
          "description": "Use the local runtime rather than hosted conversation."
        },
        "context": {
          "type": "string",
          "description": "The context option for conversation.new; see this entry's check and bound."
        },
        "runtime": {
          "type": "string",
          "description": "The runtime option for conversation.new; see this entry's check and bound."
        },
        "model_tier": {
          "type": "string",
          "description": "The model-tier option for conversation.new; see this entry's check and bound."
        },
        "claude_bin": {
          "type": "string",
          "description": "The claude-bin option for conversation.new; see this entry's check and bound."
        },
        "claude_auth": {
          "type": "string",
          "description": "The claude-auth option for conversation.new; see this entry's check and bound."
        }
      },
      "required": [
        "repo_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "conversation",
        "new"
      ],
      "positional": [
        "repo_id"
      ],
      "flags": {
        "name": {
          "flag": "--name"
        },
        "agent": {
          "flag": "--agent"
        },
        "local": {
          "flag": "--local",
          "boolean": "bare"
        },
        "context": {
          "flag": "--context"
        },
        "runtime": {
          "flag": "--runtime"
        },
        "model_tier": {
          "flag": "--model-tier"
        },
        "claude_bin": {
          "flag": "--claude-bin"
        },
        "claude_auth": {
          "flag": "--claude-auth"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "conversation.send",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "launch",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Send one hosted or local conversation turn.",
      "use_when": "Continue an existing conversation, not launch a new POV.",
      "check": "For local turns check runtime, reach and final outcome. Host permissions remain authoritative.",
      "bound": "Streams one turn; use conversation get for persisted hosted output."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_id": {
          "type": "string",
          "description": "Hosted repository id."
        },
        "conversation_id": {
          "type": "string",
          "description": "Positional conversation id for conversation.send."
        },
        "message": {
          "type": "string",
          "description": "Exact message/content; stdin is accepted where documented."
        },
        "local": {
          "type": "boolean",
          "description": "Use the local runtime rather than hosted conversation."
        },
        "context": {
          "type": "string",
          "description": "The context option for conversation.send; see this entry's check and bound."
        },
        "conversation": {
          "type": "string",
          "description": "The conversation option for conversation.send; see this entry's check and bound."
        },
        "runtime": {
          "type": "string",
          "description": "The runtime option for conversation.send; see this entry's check and bound.",
          "enum": [
            "pi",
            "claude"
          ],
          "default": "pi"
        },
        "map": {
          "type": "string",
          "description": "Authored Map input/path; references grant no access."
        },
        "ext": {
          "type": "array",
          "description": "The ext option for conversation.send; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        },
        "skill": {
          "type": "array",
          "description": "The skill option for conversation.send; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        },
        "pi_bin": {
          "type": "string",
          "description": "The pi-bin option for conversation.send; see this entry's check and bound."
        },
        "pi_model": {
          "type": "string",
          "description": "The pi-model option for conversation.send; see this entry's check and bound."
        },
        "pi_thinking": {
          "type": "string",
          "description": "The pi-thinking option for conversation.send; see this entry's check and bound."
        },
        "pi_trust": {
          "type": "string",
          "description": "The pi-trust option for conversation.send; see this entry's check and bound."
        },
        "claude_bin": {
          "type": "string",
          "description": "The claude-bin option for conversation.send; see this entry's check and bound."
        },
        "claude_model": {
          "type": "string",
          "description": "The claude-model option for conversation.send; see this entry's check and bound."
        },
        "claude_effort": {
          "type": "string",
          "description": "The claude-effort option for conversation.send; see this entry's check and bound."
        },
        "permission_mode": {
          "type": "string",
          "description": "The permission-mode option for conversation.send; see this entry's check and bound."
        },
        "read_only": {
          "type": "boolean",
          "description": "Claude read-only launch, with MCP servers removed."
        },
        "reach": {
          "type": "array",
          "description": "Explicit extra directories for a Claude local turn.",
          "items": {
            "type": "string"
          }
        },
        "autocompact": {
          "type": "string",
          "description": "The autocompact option for conversation.send; see this entry's check and bound."
        },
        "working_root": {
          "type": "string",
          "description": "The working-root option for conversation.send; see this entry's check and bound."
        },
        "focus": {
          "type": "string",
          "description": "The focus option for conversation.send; see this entry's check and bound."
        },
        "session_dir": {
          "type": "string",
          "description": "The session-dir option for conversation.send; see this entry's check and bound."
        },
        "model": {
          "type": "string",
          "description": "The model option for conversation.send; see this entry's check and bound."
        },
        "thinking": {
          "type": "boolean",
          "description": "The thinking option for conversation.send; see this entry's check and bound."
        },
        "model_tier": {
          "type": "string",
          "description": "The model-tier option for conversation.send; see this entry's check and bound."
        },
        "claude_auth": {
          "type": "string",
          "description": "The claude-auth option for conversation.send; see this entry's check and bound."
        },
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "thread_map": {
          "type": "string",
          "description": "The thread-map option for conversation.send; see this entry's check and bound."
        },
        "thread_member": {
          "type": "integer",
          "description": "The thread-member option for conversation.send; see this entry's check and bound.",
          "minimum": 0
        }
      },
      "required": [
        "message"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "conversation",
        "send"
      ],
      "positional": [
        "repo_id",
        "conversation_id"
      ],
      "flags": {
        "message": {
          "flag": "--message"
        },
        "local": {
          "flag": "--local",
          "boolean": "bare"
        },
        "context": {
          "flag": "--context"
        },
        "conversation": {
          "flag": "--conversation"
        },
        "runtime": {
          "flag": "--runtime"
        },
        "map": {
          "flag": "--map"
        },
        "ext": {
          "flag": "--ext",
          "list": "csv"
        },
        "skill": {
          "flag": "--skill",
          "list": "csv"
        },
        "pi_bin": {
          "flag": "--pi-bin"
        },
        "pi_model": {
          "flag": "--pi-model"
        },
        "pi_thinking": {
          "flag": "--pi-thinking"
        },
        "pi_trust": {
          "flag": "--pi-trust"
        },
        "claude_bin": {
          "flag": "--claude-bin"
        },
        "claude_model": {
          "flag": "--claude-model"
        },
        "claude_effort": {
          "flag": "--claude-effort"
        },
        "permission_mode": {
          "flag": "--permission-mode"
        },
        "read_only": {
          "flag": "--read-only",
          "boolean": "bare"
        },
        "reach": {
          "flag": "--reach",
          "list": "repeat"
        },
        "autocompact": {
          "flag": "--autocompact"
        },
        "working_root": {
          "flag": "--working-root"
        },
        "focus": {
          "flag": "--focus"
        },
        "session_dir": {
          "flag": "--session-dir"
        },
        "model": {
          "flag": "--model"
        },
        "thinking": {
          "flag": "--thinking",
          "boolean": "bare"
        },
        "model_tier": {
          "flag": "--model-tier"
        },
        "claude_auth": {
          "flag": "--claude-auth"
        },
        "thread": {
          "flag": "--thread"
        },
        "thread_map": {
          "flag": "--thread-map"
        },
        "thread_member": {
          "flag": "--thread-member"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "conversation.get",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read one hosted conversation and its messages.",
      "use_when": "Inspect an exact hosted conversation.",
      "check": "Check the conversation identity and message states.",
      "bound": "Service result without client-side paging; output may be large."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_id": {
          "type": "string",
          "description": "Hosted repository id."
        },
        "conversation_id": {
          "type": "string",
          "description": "Positional conversation id for conversation.get."
        },
        "local": {
          "type": "boolean",
          "description": "Use the local runtime rather than hosted conversation."
        },
        "context": {
          "type": "string",
          "description": "The context option for conversation.get; see this entry's check and bound."
        },
        "runtime": {
          "type": "string",
          "description": "The runtime option for conversation.get; see this entry's check and bound."
        },
        "conversation": {
          "type": "string",
          "description": "The conversation option for conversation.get; see this entry's check and bound."
        }
      },
      "required": [
        "repo_id",
        "conversation_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "conversation",
        "get"
      ],
      "positional": [
        "repo_id",
        "conversation_id"
      ],
      "flags": {
        "local": {
          "flag": "--local",
          "boolean": "bare"
        },
        "context": {
          "flag": "--context"
        },
        "runtime": {
          "flag": "--runtime"
        },
        "conversation": {
          "flag": "--conversation"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "conversation.cancel",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "write-hosted",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Cancel a hosted conversation turn.",
      "use_when": "Stop an active hosted turn.",
      "check": "Check returned cancellation state; completed work is not undone.",
      "bound": "One conversation per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_id": {
          "type": "string",
          "description": "Hosted repository id."
        },
        "conversation_id": {
          "type": "string",
          "description": "Positional conversation id for conversation.cancel."
        },
        "local": {
          "type": "boolean",
          "description": "Use the local runtime rather than hosted conversation."
        },
        "context": {
          "type": "string",
          "description": "The context option for conversation.cancel; see this entry's check and bound."
        },
        "runtime": {
          "type": "string",
          "description": "The runtime option for conversation.cancel; see this entry's check and bound."
        },
        "conversation": {
          "type": "string",
          "description": "The conversation option for conversation.cancel; see this entry's check and bound."
        }
      },
      "required": [
        "repo_id",
        "conversation_id"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "conversation",
        "cancel"
      ],
      "positional": [
        "repo_id",
        "conversation_id"
      ],
      "flags": {
        "local": {
          "flag": "--local",
          "boolean": "bare"
        },
        "context": {
          "flag": "--context"
        },
        "runtime": {
          "flag": "--runtime"
        },
        "conversation": {
          "flag": "--conversation"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "conversation.compact",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Compact a local runtime conversation.",
      "use_when": "Runtime context needs compaction; this is not a shared-state edit.",
      "check": "Check selected context, conversation and runtime; raw history remains runtime-owned.",
      "bound": "One local conversation per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "local": {
          "type": "boolean",
          "description": "Use the local runtime rather than hosted conversation."
        },
        "context": {
          "type": "string",
          "description": "The context option for conversation.compact; see this entry's check and bound."
        },
        "conversation": {
          "type": "string",
          "description": "The conversation option for conversation.compact; see this entry's check and bound."
        },
        "runtime": {
          "type": "string",
          "description": "The runtime option for conversation.compact; see this entry's check and bound.",
          "enum": [
            "pi",
            "claude"
          ],
          "default": "pi"
        }
      },
      "required": [
        "local",
        "context",
        "conversation"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "conversation",
        "compact"
      ],
      "positional": [],
      "flags": {
        "local": {
          "flag": "--local",
          "boolean": "bare"
        },
        "context": {
          "flag": "--context"
        },
        "conversation": {
          "flag": "--conversation"
        },
        "runtime": {
          "flag": "--runtime"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "conversations",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "read",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List hosted or local conversations.",
      "use_when": "Choose an existing conversation before continuing it.",
      "check": "Check whether the result is local or hosted and the selected context/repo.",
      "bound": "Complete runtime/service list; no client-side continuation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "repo_id": {
          "type": "string",
          "description": "Hosted repository id."
        },
        "local": {
          "type": "boolean",
          "description": "Use the local runtime rather than hosted conversation."
        },
        "context": {
          "type": "string",
          "description": "The context option for conversations; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "conversations"
      ],
      "positional": [
        "repo_id"
      ],
      "flags": {
        "local": {
          "flag": "--local",
          "boolean": "bare"
        },
        "context": {
          "flag": "--context"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "agents",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "read",
    "reach": "hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List Agent Actors available to the signed-in account.",
      "use_when": "Choose a hosted actor, not a local POV.",
      "check": "Check owner and actor identity; availability is not a permission grant.",
      "bound": "Complete service list; no client-side paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "The owner option for agents; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "agents"
      ],
      "positional": [],
      "flags": {
        "owner": {
          "flag": "--owner"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "threads.launch-text",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Assemble bounded launch context from one local Thread post and its Map.",
      "use_when": "Start a session from an explicit post, not the latest by accident.",
      "check": "Read cut diagnostics; pinned Map members are reference, not added authority.",
      "bound": "Launch capped at 16384 bytes; Map character budget can lower detail or drop members."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "string",
          "description": "Local Thread slug/path or hosted x_ id."
        },
        "post": {
          "type": "string",
          "description": "Exact post id to select."
        },
        "member": {
          "type": "integer",
          "description": "The member option for threads.launch-text; see this entry's check and bound.",
          "minimum": 0
        },
        "pov": {
          "type": "string",
          "description": "The pov option for threads.launch-text; see this entry's check and bound."
        },
        "budget": {
          "type": "integer",
          "description": "The budget option for threads.launch-text; see this entry's check and bound.",
          "minimum": 0
        }
      },
      "required": [
        "thread",
        "post"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "launch-text"
      ],
      "positional": [
        "thread"
      ],
      "flags": {
        "post": {
          "flag": "--post"
        },
        "member": {
          "flag": "--member"
        },
        "pov": {
          "flag": "--pov"
        },
        "budget": {
          "flag": "--budget"
        }
      },
      "local_flags": [
        "post",
        "member",
        "pov",
        "budget"
      ]
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "pi.status",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Probe the local Pi binary, providers and extensions.",
      "use_when": "Check whether Pi can run a local agent.",
      "check": "Check binary provenance, provider availability and extension diagnostics; not a hosted account check.",
      "bound": "One installed runtime probe; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "pi_bin": {
          "type": "string",
          "description": "The pi-bin option for pi.status; see this entry's check and bound."
        },
        "ext": {
          "type": "array",
          "description": "The ext option for pi.status; see this entry's check and bound.",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "pi-status"
      ],
      "positional": [],
      "flags": {
        "pi_bin": {
          "flag": "--pi-bin"
        },
        "ext": {
          "flag": "--ext",
          "list": "csv"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "pi.models",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List models available through the local Pi runtime.",
      "use_when": "Choose an authenticated Pi provider/model before launch.",
      "check": "Availability is auth-gated; inspect provider and model id, not just labels.",
      "bound": "One installed runtime model list; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "pi_bin": {
          "type": "string",
          "description": "The pi-bin option for pi.models; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "pi-models"
      ],
      "positional": [],
      "flags": {
        "pi_bin": {
          "flag": "--pi-bin"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "pi.login",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "account",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Configure one local Pi model provider credential.",
      "use_when": "Explicitly asked to configure a model provider for Pi.",
      "check": "Writes Pi auth.json, not IdeaSpaces login. Keep api_key out of logs and shared artifacts.",
      "bound": "One provider credential per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "description": "Pi model-provider id."
        },
        "api_key": {
          "type": "string",
          "description": "Secret model-provider key; never log or capture it."
        }
      },
      "required": [
        "provider",
        "api_key"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "pi-login"
      ],
      "positional": [],
      "flags": {
        "provider": {
          "flag": "--provider"
        },
        "api_key": {
          "flag": "--api-key"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "pi.logout",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "account",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Remove one provider from local Pi credentials.",
      "use_when": "Explicitly asked to disconnect a Pi model provider.",
      "check": "Check provider id; does not sign out of IdeaSpaces.",
      "bound": "One provider per call."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "description": "Pi model-provider id."
        }
      },
      "required": [
        "provider"
      ],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "pi-logout"
      ],
      "positional": [],
      "flags": {
        "provider": {
          "flag": "--provider"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "claude.status",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Probe local Claude Code binary, version and sign-in.",
      "use_when": "Check whether Claude can run a local agent.",
      "check": "Check binary path and auth mode; this is not IdeaSpaces account status.",
      "bound": "One installed runtime probe; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "claude_bin": {
          "type": "string",
          "description": "The claude-bin option for claude.status; see this entry's check and bound."
        },
        "claude_auth": {
          "type": "string",
          "description": "The claude-auth option for claude.status; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "claude-status"
      ],
      "positional": [],
      "flags": {
        "claude_bin": {
          "flag": "--claude-bin"
        },
        "claude_auth": {
          "flag": "--claude-auth"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "claude.models",
    "owner": "cli",
    "status": "active",
    "job": "J11",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "List models and context capabilities of local Claude Code.",
      "use_when": "Choose a model supported by the installed Claude binary.",
      "check": "Check installed binary and model capabilities; not an online latest-version claim.",
      "bound": "One installed runtime model list; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "claude_bin": {
          "type": "string",
          "description": "The claude-bin option for claude.models; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "claude-models"
      ],
      "positional": [],
      "flags": {
        "claude_bin": {
          "flag": "--claude-bin"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "change.new",
    "owner": "cli",
    "status": "active",
    "job": "J12",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Mint a Change-Id for one decision spanning commits or repos.",
      "use_when": "A decision needs one durable coordinate across several commits.",
      "check": "Reuse an existing Change-Id when continuing the same decision.",
      "bound": "One id per call; does not arm host session state."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "handle": {
          "type": "string",
          "description": "Positional handle for change.new."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "change",
        "new"
      ],
      "positional": [
        "handle"
      ],
      "flags": {
        "handle": {
          "flag": "--handle"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "login",
    "owner": "cli",
    "status": "active",
    "job": "J13",
    "effect": "account",
    "reach": "local+hosted",
    "confirm": "browser",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Open browser sign-in for this CLI on this machine.",
      "use_when": "A person explicitly wants this CLI authenticated.",
      "check": "Complete browser authorization; host-run auth must stay with the host.",
      "bound": "One browser flow; headless callers use an existing IS_API_KEY."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "login"
      ],
      "positional": [],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "logout",
    "owner": "cli",
    "status": "active",
    "job": "J13",
    "effect": "account",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Revoke this CLI session, then clear its credentials.",
      "use_when": "Explicitly asked to sign this CLI out.",
      "check": "Credentials are retained if revocation fails; host auth is not replaced.",
      "bound": "One CLI session; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "logout"
      ],
      "positional": [],
      "flags": {}
    },
    "aliases": [
      "power logout"
    ],
    "output": {
      "json": []
    }
  },
  {
    "id": "whoami",
    "owner": "cli",
    "status": "active",
    "job": "J13",
    "effect": "status",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Show this CLI login state.",
      "use_when": "Need account identity rather than repo status.",
      "check": "Check account and configured endpoint; does not prove a hosted write is authorized.",
      "bound": "One account status result."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "whoami"
      ],
      "positional": [],
      "flags": {}
    },
    "aliases": [
      "status account"
    ],
    "output": {
      "json": []
    }
  },
  {
    "id": "doctor",
    "owner": "cli",
    "status": "active",
    "job": "J13",
    "effect": "status",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Diagnose Node, Git, remote auth and CLI update state.",
      "use_when": "Investigate installation or credential problems.",
      "check": "Read individual findings; an installed version is not a claim about the latest release.",
      "bound": "One diagnostic report."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "doctor"
      ],
      "positional": [],
      "flags": {}
    },
    "aliases": [
      "status doctor"
    ],
    "output": {
      "json": []
    }
  },
  {
    "id": "upgrade",
    "owner": "cli",
    "status": "active",
    "job": "J13",
    "effect": "account",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Check for or install a newer CLI.",
      "use_when": "Update the CLI itself; update/integrate are for repo content.",
      "check": "Check installation kind; check is read-only. Host-managed installs must use their host updater.",
      "bound": "One installation; check does not install."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "check": {
          "type": "boolean",
          "description": "The check option for upgrade; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "upgrade"
      ],
      "positional": [],
      "flags": {
        "check": {
          "flag": "--check",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "version",
    "owner": "cli",
    "status": "active",
    "job": "J13",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Report the installed CLI version.",
      "use_when": "Need build identity, not online update availability.",
      "check": "This is the built package version, not the latest published version.",
      "bound": "One version field."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "--version"
      ],
      "positional": [],
      "flags": {}
    },
    "aliases": [
      "--version",
      "-v"
    ],
    "output": {
      "json": []
    }
  },
  {
    "id": "create",
    "owner": "cli",
    "status": "active",
    "job": "J13",
    "effect": "write-local",
    "reach": "local",
    "confirm": "plan-then-yes",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Preview or scaffold a local ideaspace.",
      "use_when": "A person wants a new local repo or Home scaffold.",
      "check": "Read the plan before yes; check destination and scaffold kind.",
      "bound": "One destination; defaults to preview until yes."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "shared": {
          "type": "boolean",
          "description": "The shared option for create; see this entry's check and bound."
        },
        "agent": {
          "type": "boolean",
          "description": "The agent option for create; see this entry's check and bound."
        },
        "foundation": {
          "type": "boolean",
          "description": "The foundation option for create; see this entry's check and bound."
        },
        "home": {
          "type": "string",
          "description": "The home option for create; see this entry's check and bound."
        },
        "yes": {
          "type": "boolean",
          "description": "The yes option for create; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "create"
      ],
      "positional": [
        "name"
      ],
      "flags": {
        "shared": {
          "flag": "--shared",
          "boolean": "bare"
        },
        "agent": {
          "flag": "--agent",
          "boolean": "bare"
        },
        "foundation": {
          "flag": "--foundation",
          "boolean": "bare"
        },
        "home": {
          "flag": "--home"
        },
        "yes": {
          "flag": "--yes",
          "boolean": "bare"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "capabilities",
    "owner": "cli",
    "status": "active",
    "job": "J13",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Discover agent contracts progressively by group and id.",
      "use_when": "Discover groups first, then entries, then the full contract for one id.",
      "check": "Catalogs describe contracts, not host permissions or exposure.",
      "bound": "Fourteen group lines, group summaries, or one complete entry; no paging."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": {
          "type": "string",
          "description": "Positional selector for capabilities."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "capabilities"
      ],
      "positional": [
        "selector"
      ],
      "flags": {}
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "search",
    "owner": "cli",
    "status": "active",
    "job": "J14",
    "effect": "read",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Search local Markdown or open a saved result Map.",
      "use_when": "Find content across explicit roots; save references only when requested.",
      "check": "Check result roots, match count and any unresolved saved references. Saving does not share content.",
      "bound": "Default limit 20, no result maximum; scan truncation/incomplete roots are reported. Narrow query/roots or increase limit."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Positional query for search."
        },
        "root": {
          "type": "array",
          "description": "Explicit root selector; meaning is command-specific.",
          "items": {
            "type": "string"
          }
        },
        "threads": {
          "type": "boolean",
          "description": "The threads option for search; see this entry's check and bound."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results in this page; inspect returned continuation/counts.",
          "minimum": 1,
          "default": 20
        },
        "save": {
          "type": "string",
          "description": "The save option for search; see this entry's check and bound."
        },
        "name": {
          "type": "string",
          "description": "Human-readable name/title."
        },
        "summary": {
          "type": "string",
          "description": "Dense summary for progressive discovery."
        },
        "force": {
          "type": "boolean",
          "description": "Bypass existing revision/overwrite protection explicitly."
        },
        "open": {
          "type": "string",
          "description": "The open option for search; see this entry's check and bound."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "search"
      ],
      "positional": [
        "query"
      ],
      "flags": {
        "root": {
          "flag": "--root",
          "list": "repeat"
        },
        "threads": {
          "flag": "--threads",
          "boolean": "bare"
        },
        "limit": {
          "flag": "--limit"
        },
        "save": {
          "flag": "--save"
        },
        "name": {
          "flag": "--name"
        },
        "summary": {
          "flag": "--summary"
        },
        "force": {
          "flag": "--force",
          "boolean": "bare"
        },
        "open": {
          "flag": "--open"
        }
      }
    },
    "output": {
      "json": []
    }
  },
  {
    "id": "follow",
    "owner": "cli",
    "status": "retired",
    "refusal": "Follow, unfollow and subscription cursor acknowledgement are retired. No request was sent. Use `ideaspaces threads list --unread` for unread Threads; use `ideaspaces threads ack <id> --cursor <cursor>` only to mark a Thread read explicitly.",
    "job": "J16",
    "effect": "status",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Refuse a retired operation; no request is sent.",
      "use_when": "Recognize a stale wrapper or instruction; choose the replacement instead.",
      "check": "Read the refusal and do not retry this retired id.",
      "bound": "One refusal; no continuation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "follow"
      ],
      "positional": [],
      "flags": {}
    }
  },
  {
    "id": "unfollow",
    "owner": "cli",
    "status": "retired",
    "refusal": "Follow, unfollow and subscription cursor acknowledgement are retired. No request was sent. Use `ideaspaces threads list --unread` for unread Threads; use `ideaspaces threads ack <id> --cursor <cursor>` only to mark a Thread read explicitly.",
    "job": "J16",
    "effect": "status",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Refuse a retired operation; no request is sent.",
      "use_when": "Recognize a stale wrapper or instruction; choose the replacement instead.",
      "check": "Read the refusal and do not retry this retired id.",
      "bound": "One refusal; no continuation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "unfollow"
      ],
      "positional": [],
      "flags": {}
    }
  },
  {
    "id": "threads.posts",
    "owner": "cli",
    "status": "retired",
    "refusal": "threads posts retired with the Inbox; use threads list and open, or manage membership on the web.",
    "job": "J16",
    "effect": "status",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Refuse a retired operation; no request is sent.",
      "use_when": "Recognize a stale wrapper or instruction; choose the replacement instead.",
      "check": "Read the refusal and do not retry this retired id.",
      "bound": "One refusal; no continuation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "posts"
      ],
      "positional": [],
      "flags": {}
    }
  },
  {
    "id": "threads.expand",
    "owner": "cli",
    "status": "retired",
    "refusal": "threads expand retired with the Inbox; use threads list and open, or manage membership on the web.",
    "job": "J16",
    "effect": "status",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Refuse a retired operation; no request is sent.",
      "use_when": "Recognize a stale wrapper or instruction; choose the replacement instead.",
      "check": "Read the refusal and do not retry this retired id.",
      "bound": "One refusal; no continuation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "expand"
      ],
      "positional": [],
      "flags": {}
    }
  },
  {
    "id": "threads.add",
    "owner": "cli",
    "status": "retired",
    "refusal": "threads add retired with the Inbox; use threads list and open, or manage membership on the web.",
    "job": "J16",
    "effect": "status",
    "reach": "local+hosted",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Refuse a retired operation; no request is sent.",
      "use_when": "Recognize a stale wrapper or instruction; choose the replacement instead.",
      "check": "Read the refusal and do not retry this retired id.",
      "bound": "One refusal; no continuation."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "cli": {
      "argv": [
        "threads",
        "add"
      ],
      "positional": [],
      "flags": {}
    }
  },
  {
    "id": "change.open",
    "owner": "host",
    "implemented_by": [
      "mcp",
      "pi"
    ],
    "status": "active",
    "job": "J12",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Open a session Change, minting or continuing its id.",
      "use_when": "Manage a multi-commit decision in the current host session.",
      "check": "Session state belongs to the host; this entry grants no permissions or cross-session ownership.",
      "bound": "One host session; optional file selection is exact."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "handle": {
          "type": "string",
          "description": "Handle used to mint a new Change-Id."
        },
        "id": {
          "type": "string",
          "description": "Existing Change-Id to continue."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "calls": [
      "change.new"
    ],
    "output": {
      "json": [
        "id"
      ]
    }
  },
  {
    "id": "change.close",
    "owner": "host",
    "implemented_by": [
      "mcp",
      "pi"
    ],
    "status": "active",
    "job": "J12",
    "effect": "write-local",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Close the session Change; later commits no longer carry its id.",
      "use_when": "Manage a multi-commit decision in the current host session.",
      "check": "Session state belongs to the host; this entry grants no permissions or cross-session ownership.",
      "bound": "One host session; optional file selection is exact."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "calls": [],
    "output": {
      "json": [
        "id"
      ]
    }
  },
  {
    "id": "session.status",
    "owner": "host",
    "implemented_by": [
      "mcp",
      "pi"
    ],
    "status": "active",
    "job": "J9",
    "effect": "status",
    "reach": "local",
    "confirm": "none",
    "requires": {
      "cli": ">=0.9.0"
    },
    "text": {
      "does": "Read session captures, open Change and optional safe file revisions.",
      "use_when": "Inspect session-owned captures and file revisions before saving.",
      "check": "Session state belongs to the host; this entry grants no permissions or cross-session ownership.",
      "bound": "One host session; optional file selection is exact."
    },
    "bound": "n/a",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Optional file to inspect for safe refinement."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "calls": [
      "status"
    ],
    "output": {
      "json": [
        "session_owned",
        "change",
        "captures",
        "revision"
      ]
    }
  }
];

export const exclusions = [
  {
    "id": "agent_session",
    "reason": "Removed from every surface; not a tool."
  },
  {
    "id": "is_cli",
    "reason": "Shell alias in a plugin skill, not a tool."
  },
  {
    "id": "is_share",
    "reason": "Mentioned only in no-native-tool guidance; not a tool."
  },
  {
    "id": "credential",
    "reason": "Git credential helper, not an agent-facing command."
  },
  {
    "id": "update-check",
    "reason": "Internal update probe, not an agent-facing command."
  }
];
