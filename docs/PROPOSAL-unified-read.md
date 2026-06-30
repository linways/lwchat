# Proposal: Unified `read` — one command to read any Chat target

**Status:** reviewed — decisions locked, ready for development
**Author:** (handoff from agent session, 2026-06-30; review folded in 2026-06-30)
**Scope:** read side only (text + attachments + audio), from spaces, threads, and personal DMs.

---

## 1. Why

lwchat started as a Redmine→Chat bridge: every read command keys on an **issue id**.
It has since become a general Chat tool. The read surface never caught up, so an AI
agent (the primary user) has to *classify the target and pick the right command*
before it can read anything. That mid-step guessing is the problem this proposal removes.

### Use cases driving this

1. **Read a DM and act on it.** Someone DMs me. I want: "Claude, read my last DM
   from X and draft a reply." Today there is **no command to read a DM at all** —
   only `dm` (send) and `by` (a person's posts across spaces).
2. **Read any general space.** e.g. catch up on `engineers-linways`. `thread show`
   reads a thread but **silently drops attachments**, and there's no plain "read the
   last N messages of this space" path that includes files.
3. **Read/transcribe an audio note from a non-issue thread.** Exactly what we just
   did manually: list thread → find audio → download → transcribe. Four steps and a
   throwaway script, because `attachments fetch` is issue-bound and writes into the
   `~/.lwr` issue tree.

### The core defect

Reading is fragmented across issue-keyed commands, and **attachments are second-class**:

| command | reads | gap |
|---|---|---|
| `read <issue_id>` | issue → thread(s) | issue-only; no attachments inline |
| `digest <issue_id>` | issue + Redmine | issue-only |
| `thread show <thread>` | any thread | **drops attachments**; no DM |
| `attachments fetch <issue_id>` | issue's files | issue-only; writes to `~/.lwr` tree; needs `lwr` |
| `by <user>` | a person's posts | not a target read; no attachments |
| — | **a DM** | **does not exist** |

---

## 2. Design principles (optimized for AI agents)

1. **One target syntax.** The agent passes *what it has* (an id, a name, an email, a
   thread name, an alias) and lwchat figures out the rest. No "which command do I use" step.
2. **Deterministic resolution, never silent.** Fixed precedence (§4). lwchat always
   **echoes what it resolved to** (`resolved "rameez" → DM with Muhammed Rameez`) — the
   same safety pattern `dm`/`reply` already use for @mentions. A wrong target is visible,
   never silent.
3. **One output shape, always.** Space read, thread read, DM read → identical JSON.
   The agent writes one parser, not four.
4. **Attachment metadata is free; bytes are on demand.** The Chat `messages.list`
   response *already* contains `attachment[]` (name, type, `resourceName`). Surface it on
   every read at **zero extra API cost**. Only `--analyze`/`--download` spend a round trip.
5. **One call to "understandable content".** `read --analyze` returns message text plus
   enriched attachments in one call — audio transcribed inline, images and documents
   downloaded to a path the agent can read — so the agent never chains
   classify→download→process→re-read. No agent-side branching on `content_type`.
6. **Ephemeral by default.** On-the-fly downloads/transcripts go to `/tmp/lwchat`, not the
   `~/.lwr` issue tree. No `lwr` dependency for non-issue reads, no persistent clutter, gone on reboot.

---

## 3. The command

```
lwchat read <target> [--as space|thread|dm|person|issue]
                      [--limit N] [--analyze] [--download]
                      [--out <dir>] [--json]
```

`read` **replaces the need to know** issue read / `thread show` / `attachments fetch` / DM read.
This repo is currently single-user, so we intentionally optimize the surface instead of preserving old read-side compatibility. The Redmine bridge survives as a resolver, and `digest` stays because it adds Redmine record data.

- `<target>` — anything (§4).
- `--as` — force the interpretation when the sniffer would be ambiguous. Rarely needed.
- `--limit N` — for space/DM reads, last N messages (default 30). Ignored for a single thread.
- `--analyze` — content-aware enrichment per attachment: `audio/*` → transcribe inline; `image/*` and documents → download to `/tmp/lwchat/...` (agent reads the path); other types → metadata only. No agent-side `content_type` branching needed.
- `--download` — fetch bytes for all attachments without analysis; use when you just need the files.
- `--json` — the stable shape in §5.

---

## 4. Target resolution (the "no guessing" core)

`resolveTarget(input, asHint)` → `{ kind, spaceId, spaceAlias?, threadName?, userId? }`.
Strict precedence, first match wins. `--as` short-circuits to that branch.

| # | input looks like | kind | how |
|---|---|---|---|
| 1 | `spaces/<id>/threads/<id>` | `thread` | use directly (spaceId is embedded) |
| 2 | `spaces/<id>` | `space` | use directly |
| 3 | all digits (`126270`) | `issue` | Redmine bridge → thread(s) (existing `resolveLocations`) |
| 4 | configured alias (`engineers-linways`) | `space` | `config.spaces[alias]` |
| 5 | contains `@` (email) | `dm` | `resolveUserRef` → **`findDirectMessage`** (resolve-only) |
| 6 | otherwise (a name) | `person` → `dm` | `resolveUserRef` (directory) → **`findDirectMessage`** (resolve-only) |

Notes that keep it unambiguous:
- **Alias before name** (4 before 6): a configured space alias is a space, not a person,
  even if a person happens to share the name. `--as person` overrides.
- **DM read never creates** (review fix 1): a read must not have a write side-effect. Use
  `findDirectMessage(userId)` (returns `null` on 404) and **fail** if there's no existing DM
  space — do *not* fall through to `getOrCreateDmSpace`. `findDirectMessage` already exists in
  `chat-api.js`; the read path simply omits the "create" half. Suggested error:
  `No DM with <name> yet — send one first with \`lwchat dm <name> "…"\`.`
- Ambiguous person names already throw a listing error in `resolveUserRef` — reuse it verbatim.
- Every branch logs the resolution line before reading (principle 2).

Each kind maps to an existing fetch:
- `thread` → `summarizeThread(spaceId, threadName)` *(extended, §6)*
- `space` / `dm` → `listMessages(spaceId, { orderBy:"createTime desc", pageSize: limit })`
- `issue` → `resolveLocations` → thread name(s) → uniform §5 shape (one or many threads merged)

---

## 5. Uniform output shape

Every `read`, regardless of kind, returns:

```json
{
  "ok": true,
  "kind": "dm",
  "target": { "space": "spaces/AAA", "space_alias": null,
              "thread": null, "user": "users/123", "user_name": "Muhammed Rameez" },
  "resolved_from": "rameez",
  "message_count": 3,
  "participants": ["Sibin Baby", "Muhammed Rameez"],
  "first_activity": "2026-06-30T05:00:00Z",
  "last_activity": "2026-06-30T05:09:29Z",
  "messages": [
    {
      "sender": "users/123",
      "sender_name": "Muhammed Rameez",
      "text": "can you check the folio bug",
      "created": "2026-06-30T05:09:29Z",
      "is_reply": false,
      "attachments": [
        {
          "content_name": "voice_message_2026-06-30T0509Z.m4a",
          "content_type": "audio/mpeg",
          "is_audio": true,
          "resource_name": "spaces/AAA/.../attachments/...",
          "downloaded_path": "/tmp/lwchat/AAA/<msgId>/voice_message_….m4a",   // --analyze or --download
          "analysis": {                                                         // only with --analyze
            "kind": "transcript",
            "content": "this is the voice note text"
          }
        }
      ]
    }
  ]
}
```

- `attachments[]` is **always present** (empty array when none). `downloaded_path` appears with
  `--analyze` (images/docs) or `--download`; `analysis` appears only with `--analyze`. This is the
  single shape the agent learns — `analysis.kind` tells it what it got (`"transcript"` / `"image_path"` /
  `"document_path"` / `null` for unsupported types).
- `kind`, `target`, `resolved_from` let the agent confirm it read the right thing and know how
  to reply (it has the space/thread/user to hand straight to `reply`/`post --thread`/`dm`).

---

## 6. Changes to internals (minimal — reuse-first)

This is a **resolver + one field + one tmp helper**, not a rewrite.

| Need | Existing function to reuse | Change |
|---|---|---|
| classify target | `resolveUserRef`, `config.spaces`, `resolveLocations` (issue) | new thin `resolveTarget()` wraps these |
| read a thread | `summarizeThread()` | **add `attachments[]`** to each message (see below) |
| read a space/DM | `listMessages()` | new tiny `summarizeSpace(spaceId,{limit})` mirroring `summarizeThread`'s shape |
| open a DM (read) | `findDirectMessage()` | reuse **resolve-only** — fail on null, never create (review fix 1) |
| attachment object | `normalizeChatAttachment()` | reuse — already computes `is_audio`, `resource_name` |
| download bytes | `downloadAttachmentMedia()` | reuse — write to `/tmp/lwchat` instead of `~/.lwr` |
| `--analyze` dispatch | `content_type` switch per attachment | `audio/*` → transcribe; `image/*` / doc → download + path; other → metadata only |
| transcribe | `voice-coder analyze` (spawned) | reuse — same sidecar convention as `attachments fetch` |

**The one substantive edit:** `summarizeThread` currently maps messages but discards
`m.attachment`. Add it:

```js
// in summarizeThread / summarizeSpace message map:
attachments: (m.attachment || []).map((a, i) =>
  normalizeChatAttachment(m, a, { spaceAlias, spaceId, threadName, messageIndex, attachmentIndex: i, idToName })),
```

Because `normalizeChatAttachment` already exists and `m.attachment` is already in the
payload, **attachment visibility costs nothing extra** — no new API call, no new parse.

### `/tmp/lwchat` layout

```
/tmp/lwchat/<spaceIdTail>/<messageIdTail>/<sanitized-filename>
/tmp/lwchat/<spaceIdTail>/<messageIdTail>/<filename>_transcribed.json   // {file,text,profile,...}
```

- Deterministic path = natural cache: if the file is already there, `--download` is a no-op
  (skip the round trip) unless `--force`.
- Ephemeral: `/tmp` clears on reboot; no `lwr issue fetch` materialization, no `~/.lwr` coupling.
- `--out <dir>` overrides for when the user wants to keep a file (this is how the old
  `attachments fetch` colocation is reproduced: `--out ~/.lwr/issues/<id>/chat-attachments`).
- `read --download` is the single download path for everything — issue threads included. No
  `~/.lwr` coupling anywhere in the read path.

---

## 7. Step reduction (before → after)

**Read a DM and draft a reply**
- Before: *no command exists.* Agent must hand-script: resolveUserRef → getOrCreateDmSpace
  → listMessages → map attachments. 4 internal calls, off-menu.
- After: `lwchat read rameez --json` → reply with `lwchat dm rameez "..."`. **1 read.**

**Catch up on a general space**
- Before: `threads --space engineers-linways` → pick a thread → `thread show <name>`
  (and still no attachments). 2–3 calls, files invisible.
- After: `lwchat read engineers-linways --limit 30 --json`. **1 read, files visible.**

**Transcribe an audio note in a non-issue thread** (what we did manually today)
- Before: `thread show` (no attachment shown) → realize it's audio → custom script:
  listThreadMessages → find audio → downloadAttachmentMedia → write → voice-coder. **~5 steps + script.**
- After: `lwchat read <thread> --analyze --json` → transcript inline. **1 call.**

The win for an agent isn't just fewer keystrokes — it's **no decision points**. One command,
one shape, resolution echoed back. Nothing to infer between steps.

---

### Worked example: "Read Akshay's messages" (mixed text + image + voice)

This is the scenario that illustrates the full `--analyze` contract.

**The agent runs one command:**
```
lwchat read akshay --analyze --json
```

**What lwchat does — entirely internally, no agent involvement:**

1. **Resolve** — `"akshay"` matches row 6 (§4): `resolveUserRef("akshay")` → finds "Akshay T" in the Chat directory → `findDirectMessage(userId)` → gets DM space `spaces/XYZ`. Logs: `resolved "akshay" → DM with Akshay T`.
2. **Fetch** — `listMessages("spaces/XYZ", { orderBy: "createTime desc", pageSize: 30 })`. One API call. The raw response already contains `attachment[]` on each message — free, no extra call.
3. **Map** — for each message, `normalizeChatAttachment` reshapes the raw attachment objects. Pure function, no network.
4. **Analyze** — for each attachment, lwchat checks `content_type` and acts:
   - `text message` — no attachment, nothing to do.
   - `image/jpeg` → `downloadAttachmentMedia()` → `/tmp/lwchat/XYZ/msg2/photo.jpg`. Sets `analysis.kind = "image_path"`.
   - `audio/mpeg` → download → spawn `voice-coder analyze` → read transcript back. Sets `analysis.kind = "transcript"`, `analysis.content = "hey can you look at the login page bug"`.

**The JSON the agent receives:**

```json
{
  "ok": true,
  "kind": "dm",
  "resolved_from": "akshay",
  "target": { "space": "spaces/XYZ", "user_name": "Akshay T" },
  "messages": [
    {
      "sender_name": "Akshay T",
      "text": "hey check this out",
      "attachments": []
    },
    {
      "sender_name": "Akshay T",
      "text": "",
      "attachments": [{
        "content_name": "photo.jpg",
        "content_type": "image/jpeg",
        "downloaded_path": "/tmp/lwchat/XYZ/msg2/photo.jpg",
        "analysis": { "kind": "image_path", "content": "/tmp/lwchat/XYZ/msg2/photo.jpg" }
      }]
    },
    {
      "sender_name": "Akshay T",
      "text": "",
      "attachments": [{
        "content_name": "voice_message.m4a",
        "content_type": "audio/mpeg",
        "downloaded_path": "/tmp/lwchat/XYZ/msg3/voice_message.m4a",
        "analysis": { "kind": "transcript", "content": "hey can you look at the login page bug" }
      }]
    }
  ]
}
```

**What the agent does with this:**
- Text message: reads inline.
- Image: reads `/tmp/lwchat/XYZ/msg2/photo.jpg` using its vision — no extra command, no "I need to download this first".
- Voice: reads `analysis.content` as plain text — never knew it was audio.

**The agent never had to decide** "this is audio, I should transcribe it" or "this is an image, I need to download it first." That branching happened inside lwchat. The agent just consumed one JSON blob and understood all three messages.

**API call count:** 1 (list) + 2 (downloads) + 1 (voice-coder spawn) = 4 total. A plain `lwchat read akshay --json` (no `--analyze`) costs only 1 API call — metadata only, no downloads.

---

## 8. Performance notes

- **Free metadata:** attachment surfacing adds 0 API calls (data already in `messages.list`).
- **Lazy enrichment:** `--analyze` and `--download` are both opt-in; plain read is always fast.
- **Path-as-cache:** deterministic `/tmp/lwchat` path skips re-download within a boot.
- **Warm caches reused:** member maps (`getMemberMap`) and the directory cache already back
  name resolution; `read` inherits the warm fast path with no new cache to maintain.
- **One page default:** space/DM read defaults to `--limit 30` (single page) — cheap; agent
  raises it (e.g. `--limit 50` for a dense DM) only when needed.

---

## 9. Compatibility stance — one reader, resolver-only Redmine

**Decision:** drop the `~/.lwr` storage path and the issue-bound read/fetch commands. A Redmine
issue thread is just a normal thread; the only thing special about an issue id is that it *resolves*
to thread name(s). So the Redmine bridge survives **only as a resolver** (the URL-pattern regex +
the thread-index cache — `extractIssueId`, `resolveLocations`), never as a separate command, output
shape, or storage location.

| old command | becomes | notes |
|---|---|---|
| `read <issue_id>` | `read <issue_id>` (digit-sniff → resolver branch §4 row 3) | same result, now the **uniform** shape (§5), not the bespoke `threads[]` shape |
| `thread show <name>` | **deleted** → `read <name>` (`--as thread` if needed) | now also shows attachments (see shape note below) |
| `attachments fetch <issue_id>` | **deleted** → recipe: `read <issue_id> --download --out <dir>` | removes the `~/.lwr` / `defaultIssueDir` / `fetchIssue` coupling entirely |
| `digest <issue_id>` | **kept, thinned** | the *only* Redmine-record consumer; chat half now goes through the unified reader |

- **`attachments fetch` → recipe.** With `/tmp/lwchat` the default and `--out <dir>` available,
  fetching an issue's files is just `lwchat read <issue_id> --download`. No issue tree to
  materialize, no `lwr` dependency in the read path. A skill that wants colocation with the lwr
  issue tree passes `--out ~/.lwr/issues/<id>/chat-attachments` itself.
- **`digest` stays** because it merges the actual Redmine *record* (subject/status/assignee via
  `lwr`) with the thread — value the generic `read` doesn't provide. Rip out its bespoke
  chat-reading; `digest` = unified `read` (chat half) **+** the Redmine-record fetch.
- **No persistence by default.** `/tmp/lwchat` clears on reboot — fine; re-read live (metadata is
  free, an audio re-download is one round trip). `--out` is the escape hatch when a file must persist.
- **Shape change to note (review fix 3):** the read JSON gains an `attachments[]` field on every
  message (empty array when none). Additive, not breaking — call it out in SKILL.md so anything
  parsing the old `thread show` output knows the field is now there.

Old read-side subcommands are not maintained as aliases. New work and the skill point at `read`.

---

## 10. Implementation checklist

1. `normalizeChatAttachment` — confirm it's safe to call from the read path (it is; pure).
2. Add `attachments[]` to `summarizeThread` message map.
3. Add `summarizeSpace(spaceId, { limit })` — mirror of `summarizeThread` over `listMessages`.
4. `resolveTarget(input, asHint)` — the §4 table; reuse `resolveUserRef` / `config.spaces` / issue resolver.
5. `/tmp/lwchat` download helper — wrap `downloadAttachmentMedia`, deterministic path, skip-if-exists.
6. `--analyze` dispatch — **lift the transcribe loop out of `cmdAttachmentsFetch`** into a
   standalone helper before deleting that command. Extract a generic `source` object
   (`{ space, thread, user?, message_name, sender, … }`, no `issue_id`). Then implement the
   content-type switch:
   - `audio/*` → `transcribeAudioFile()` + `transcriptionPathForAttachment()`; inline transcript in `analysis`.
   - `image/*`, `application/pdf`, `text/*` → `downloadAttachmentMedia()` to `/tmp/lwchat`; set `analysis.kind` to `"image_path"` / `"document_path"`, `content` to path.
   - other → `analysis: null` (metadata only, no download).
   Reuse `transcribeAudioFile()` and `transcriptionPathForAttachment()` as-is; sidecars land in `/tmp/lwchat` beside the audio.
7. **Fold into the existing `cmdRead`** (review fix 2 — no `cmdRead2`/`cmdReadTarget`): `cmdRead`
   calls `resolveTarget()` first; the `issue` branch reuses `resolveLocations` → thread name(s) but
   returns the **uniform §5 shape** (drop the old bespoke `threads[]` shape); `thread`/`space`/`dm`
   are new. One command, one entry point.
8. **Delete `attachments fetch`** and its `~/.lwr`-only helpers (`defaultIssueDir`, the `fetchIssue`
   materialization) once the recipe `read <issue_id> --download --out <dir>` is verified.
9. **Thin `digest`**: replace its inline chat-reading with a call to the unified reader; keep only
   the `lwr` Redmine-record merge.
10. Wire `read` in `bin/lwchat.js`; repoint old subcommands as doc-deprecated aliases.
11. Update `SKILL.md`: lead with `read <target>`; document `attachments fetch` as a `read` recipe;
    note the `attachments[]` field.
12. One test per resolution branch (thread/space/dm/issue) + one attachment-inline + one transcribe.

## 11. Decisions (locked in review)

- **Default `--limit`** for space/DM reads → **30**. One number, no space-vs-DM split; agent passes
  `--limit 50` for a dense DM when it wants more.
- **Auto-enrichment on plain `read`** → **no**. Costs extra round trips; require `--analyze`. Plain read is always fast — metadata only.
- **`/tmp/lwchat` TTL** → **rely on OS tmp cleanup**. No age sweep to maintain; deterministic path
  doubles as a within-boot cache.
- **No persistent storage / drop `~/.lwr` coupling** → **confirmed**. `/tmp` is enough; if a file
  is needed again, re-read live. The read path has zero dependency on the lwr issue tree; `--out`
  is the only way to persist, and the caller chooses where.
- **`read` name** → **overload `read`**. The digit-sniff (§4 row 3) routes `read <issue_id>`
  transparently, so the issue case needs **no** `--as issue` in practice. `--as issue` exists only as
  an explicit override.
