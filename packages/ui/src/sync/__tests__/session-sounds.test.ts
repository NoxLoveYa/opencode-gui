import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import type { RuntimeAPIs } from "@/lib/api/types"
import type { SyncEvent } from "@/lib/opencode/events"
import type { FormRequest, PermissionRequest, Session } from "@/lib/opencode/model"

// The sync layer announces what waits for the user and how a turn ended. These
// tests pin which events reach the sounds module: only live events do, and a
// request the server may answer by itself stays silent until it is left for the user.

// The mode the server answers the session's permission requests in: `auto` is answered without the user.
let sessionMode: "ask" | "auto" = "ask"

mock.module("@/components/ui", () => ({
  toast: {
    info: () => undefined,
    error: () => undefined,
    success: () => undefined,
    dismiss: () => undefined,
    getToasts: () => [],
  },
}))

import { opencodeClient } from "@/lib/opencode/client"
import { ChildStoreManager } from "../child-store"
import { resetGlobalBlockingRequests } from "../global-blocking-requests"
import {
  applyGlobalSessionStatusSnapshot,
  replaceGlobalSessionStatusById,
  useGlobalSessionStatusStore,
} from "../global-session-status"
import { useBackgroundShellsStore } from "../background-shells"
import { agentActivity } from "@/lib/sounds/agentActivity"
import { soundReminders } from "@/lib/sounds/reminders"
import { soundSignals } from "@/lib/sounds/signals"
import { turnEndTracker } from "@/lib/sounds/turnEnd"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { usePermissionStore } from "@/stores/permissionStore"

const setSessionMode = (mode: "ask" | "auto") => { sessionMode = mode }
const { applyControlStreamOnlyEvent, createEventRoutingIndex, handleDirectoryEvents, handleEvent, setExternallyViewedSession } = await import("../sync-context")
// After the sync layer: the two import each other, and the seed loaded first leaves the sync layer half-initialized.
const { seedGlobalSessionStatusFromHost } = await import("../host-session-status-seed")

const permission = (id: string, sessionID = "ses_a"): PermissionRequest => ({ id, sessionID, action: "bash", resources: [] })
const form = (id: string, sessionID = "ses_a"): FormRequest => (
  { id, sessionID, title: "Continue?", fields: [{ key: "answer", type: "boolean" }] }
)
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id,
  projectID: "project",
  directory: "/repo",
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...patch,
})

const asked = (id: string): SyncEvent => ({ type: "permission.asked", properties: permission(id) })
const leftForUser = (permissionId: string): SyncEvent => ({
  type: "openchamber.permission-left-for-user",
  properties: { permissionId, sessionId: "ses_a", directory: "/repo" },
})

describe("sounds announced by the sync layer", () => {
  const announced: Array<{ kind: string; requestId: string; sessionId: string; directory: string }> = []
  const outcomes: Array<{ sessionId: string; outcome: string; subagent: boolean }> = []
  let announce: ReturnType<typeof spyOn>
  let noteOutcome: ReturnType<typeof spyOn>
  // The real store, with only the lookup of the mode replaced: a module mock would outlive this file in the same bun run.
  const realGetSessionMode = usePermissionStore.getState().getSessionMode

  beforeEach(() => {
    announced.length = 0
    outcomes.length = 0
    usePermissionStore.setState({ getSessionMode: () => sessionMode })
    setSessionMode("ask")
    resetGlobalBlockingRequests()
    announce = spyOn(soundReminders, "announce").mockImplementation((request) => { announced.push(request) })
    noteOutcome = spyOn(turnEndTracker, "noteOutcome").mockImplementation((sessionId, outcome, details) => {
      outcomes.push({ sessionId, outcome, subagent: details.isSubagent() })
    })
  })

  afterEach(() => {
    usePermissionStore.setState({ getSessionMode: realGetSessionMode })
    announce.mockRestore()
    noteOutcome.mockRestore()
    resetGlobalBlockingRequests()
  })

  const withDirectory = (options: { store: boolean }, run: (send: (event: SyncEvent) => void) => void) => {
    const childStores = new ChildStoreManager()
    if (options.store) childStores.ensureChild("/repo", { bootstrap: false })
    const routingIndex = createEventRoutingIndex()
    try {
      run((event) => handleEvent("/repo", event, childStores, routingIndex, getRuntimeKey()))
    } finally {
      childStores.disposeAll()
    }
  }

  for (const store of [true, false]) {
    const where = store ? "an open directory" : "a directory without a store"

    test(`announces a permission asked in ${where}`, () => {
      withDirectory({ store }, (send) => {
        send(asked("per_1"))
        expect(announced).toEqual([{ kind: "permission", requestId: "per_1", sessionId: "ses_a", directory: "/repo" }])
      })
    })

    test(`announces a question asked in ${where}`, () => {
      withDirectory({ store }, (send) => {
        send({ type: "form.created", properties: { form: form("frm_1") } })
        expect(announced).toEqual([{ kind: "form", requestId: "frm_1", sessionId: "ses_a", directory: "/repo" }])
      })
    })

    // Request ids are module state in the sync layer, so each test names its own.
    test(`announces a request the server left for the user once, in ${where}`, () => {
      const id = `per_held_${store}`
      setSessionMode("auto")
      withDirectory({ store }, (send) => {
        send(asked(id))
        expect(announced).toEqual([])

        send(leftForUser(id))
        send(leftForUser(id))
        expect(announced.map((request) => request.requestId)).toEqual([id])
      })
    })

    test(`never announces a request that was answered automatically, in ${where}`, () => {
      const id = `per_auto_${store}`
      setSessionMode("auto")
      withDirectory({ store }, (send) => {
        send(asked(id))
        send({ type: "permission.replied", properties: { sessionID: "ses_a", requestID: id } })
        expect(announced).toEqual([])
      })
    })
  }

  test("announces a request whose left-for-user report arrived first", () => {
    setSessionMode("auto")
    withDirectory({ store: true }, (send) => {
      send(leftForUser("per_early"))
      send(asked("per_early"))
      expect(announced.map((request) => request.requestId)).toEqual(["per_early"])
    })
  })

  test("reports how a turn ended from the idle and error events", () => {
    withDirectory({ store: true }, (send) => {
      send({ type: "session.idle", properties: { sessionID: "ses_a" } })
      send({ type: "session.idle", properties: { sessionID: "ses_a", outcome: "succeeded" } })
      send({ type: "session.idle", properties: { sessionID: "ses_a", outcome: "interrupted" } })
      send({ type: "session.error", properties: { sessionID: "ses_a", error: { type: "unknown", message: "boom" } } })
      expect(outcomes.map((entry) => entry.outcome)).toEqual(["completed", "completed", "interrupted", "failed"])
    })
  })

  test("reports pressing Stop as an interrupted turn even when it is recorded as an error", () => {
    withDirectory({ store: true }, (send) => {
      send({ type: "session.error", properties: { sessionID: "ses_a", error: { type: "MessageAbortedError", message: "Step interrupted" } } })
      send({ type: "session.error", properties: { sessionID: "ses_a", error: { type: "unknown", message: "aborted" } } })
      send({ type: "session.error", properties: { sessionID: "ses_a", error: { type: "unknown", message: "Connection aborted" } } })
      expect(outcomes.map((entry) => entry.outcome)).toEqual(["interrupted", "interrupted", "failed"])
    })
  })

  test("announces a page that waits for the user's answer under its own kind, in the directory the server names", () => {
    applyControlStreamOnlyEvent({
      type: "openchamber.page-waiting",
      properties: { sessionID: "ses_a", directory: "/repo", page: { id: "call_1", title: "Pick" } },
    })
    applyControlStreamOnlyEvent({
      type: "openchamber.page-waiting",
      properties: { sessionID: "ses_b", directory: "/other", page: { id: "call_1", title: "Pick" } },
    })
    expect(announced).toEqual([
      { kind: "page", requestId: "call_1", sessionId: "ses_a", directory: "/repo" },
      { kind: "page", requestId: "call_1", sessionId: "ses_b", directory: "/other" },
    ])
  })

  test("announces nothing for a page whose directory nobody can name", () => {
    applyControlStreamOnlyEvent({
      type: "openchamber.page-waiting",
      properties: { sessionID: "ses_unplaced", directory: null, page: { id: "call_9", title: "Pick" } },
    })
    expect(announced).toEqual([])
  })

  describe("in VS Code, in a directory without a store", () => {
    beforeEach(() => {
      // SAFETY: the sync layer reads only the runtime flag here.
      registerRuntimeAPIs({ runtime: { platform: "vscode", isDesktop: false, isVSCode: true, label: "VS Code" } } as RuntimeAPIs)
    })
    afterEach(() => registerRuntimeAPIs(null))

    test("a request nobody answers by itself makes its sound", () => {
      withDirectory({ store: false }, (send) => {
        send(asked("per_vs"))
        send({ type: "form.created", properties: { form: form("frm_vs") } })
        expect(announced).toEqual([
          { kind: "permission", requestId: "per_vs", sessionId: "ses_a", directory: "/repo" },
          { kind: "form", requestId: "frm_vs", sessionId: "ses_a", directory: "/repo" },
        ])
      })
    })

    test("a permission the session's mode would have the extension host accept stays silent", () => {
      setSessionMode("auto")
      withDirectory({ store: false }, (send) => {
        send(asked("per_vs_auto"))
        expect(announced).toEqual([])
      })
    })
  })

  test("tells a subagent session from a main one", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/repo", { bootstrap: false })
    store.setState({
      session: [
        session("ses_main"),
        session("ses_child", { parentID: "ses_main" }),
        session("ses_btw", { parentID: "ses_main", metadata: { openchamber: { kind: "btw", originalSessionID: "ses_main" } } }),
      ],
    })
    const routingIndex = createEventRoutingIndex()
    try {
      for (const sessionID of ["ses_main", "ses_child", "ses_btw"]) {
        handleEvent("/repo", { type: "session.idle", properties: { sessionID } }, childStores, routingIndex, getRuntimeKey())
      }
      expect(outcomes).toEqual([
        { sessionId: "ses_main", outcome: "completed", subagent: false },
        { sessionId: "ses_child", outcome: "completed", subagent: true },
        { sessionId: "ses_btw", outcome: "completed", subagent: false },
      ])
    } finally {
      childStores.disposeAll()
    }
  })
})

// The sounds of a turn starting and of tool calls, from the events the stream hands over.
describe("agent start and tool sounds through the event stream", () => {
  const heard: string[] = []
  const startMessages: string[] = []
  type Switch = { mockReturnValue: (value: boolean) => void; mockRestore: () => void }
  let spies: Array<{ mockRestore: () => void }> = []
  let turnStartsWanted: Switch
  let toolSoundsWanted: Switch

  const busy = (sessionID: string, source: "live" | "host" = "live"): SyncEvent => (
    { type: "session.status", properties: { sessionID, status: { type: "busy" }, turnStart: { at: 1, source } } }
  )
  const delta = (sessionID: string): SyncEvent => (
    { type: "message.part.delta", properties: { sessionID, messageID: "msg_a", partID: "msg_a:text:0", field: "text", delta: "hi" } }
  )
  const toolPart = (tool: string, status: "pending"): SyncEvent => ({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_a",
      part: { id: "call_1", sessionID: "ses_a", messageID: "msg_a", type: "tool", callID: "call_1", tool, state: { status, input: {}, raw: "" } },
    },
  })
  const called: SyncEvent = {
    type: "message.tool.transition",
    properties: { sessionID: "ses_a", messageID: "msg_a", partID: "call_1", transition: { kind: "called", input: {}, executed: true, start: 11 } },
  }
  const succeeded: SyncEvent = {
    type: "message.tool.transition",
    properties: { sessionID: "ses_a", messageID: "msg_a", partID: "call_1", transition: { kind: "success", output: "ok", executed: true, end: 15 } },
  }

  const flush = (events: SyncEvent[], options: { store: boolean } = { store: true }) => {
    const childStores = new ChildStoreManager()
    if (options.store) childStores.ensureChild("/repo", { bootstrap: false })
    try {
      handleDirectoryEvents("/repo", events, childStores, createEventRoutingIndex(), getRuntimeKey(), undefined)
    } finally {
      childStores.disposeAll()
    }
  }

  // The tool events need one store that lives through all of them.
  const withStore = (run: (send: (events: SyncEvent[]) => void) => void) => {
    const childStores = new ChildStoreManager()
    childStores.ensureChild("/repo", { bootstrap: false })
    const routingIndex = createEventRoutingIndex()
    try {
      run((events) => handleDirectoryEvents("/repo", events, childStores, routingIndex, getRuntimeKey(), undefined))
    } finally {
      childStores.disposeAll()
    }
  }

  beforeEach(() => {
    heard.length = 0
    startMessages.length = 0
    agentActivity.reset()
    useGlobalSessionsStore.getState().applySnapshot([session("ses_a"), session("ses_child", { parentID: "ses_a" })], [], "ready")
    turnStartsWanted = spyOn(soundSignals, "turnStartsWanted")
    toolSoundsWanted = spyOn(soundSignals, "toolSoundsWanted")
    turnStartsWanted.mockReturnValue(true)
    toolSoundsWanted.mockReturnValue(true)
    spies = [
      turnStartsWanted,
      toolSoundsWanted,
      spyOn(soundSignals, "agentStarted").mockImplementation((id, messageId) => {
        heard.push(`agent:${id}`)
        startMessages.push(messageId)
      }),
      spyOn(soundSignals, "subagentStarted").mockImplementation((id) => { heard.push(`subagent:${id}`) }),
      spyOn(soundSignals, "toolStarted").mockImplementation(() => { heard.push("tick") }),
      spyOn(soundSignals, "fileEdited").mockImplementation(() => { heard.push("edit") }),
    ]
  })

  afterEach(() => {
    for (const spy of spies) spy.mockRestore()
    setExternallyViewedSession("/repo", "ses_a", false)
    agentActivity.reset()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  for (const store of [true, false]) {
    const where = store ? "an open directory" : "a directory without a store"

    test(`a main session announces itself with its first output, once, in ${where}`, () => {
      flush([busy("ses_a")], { store })
      expect(heard).toEqual([])
      flush([delta("ses_a"), delta("ses_a")], { store })
      expect(heard).toEqual(["agent:ses_a"])
    })
  }

  test("a turn and its first output in one flush announce once", () => {
    flush([busy("ses_a"), delta("ses_a"), delta("ses_a")])
    expect(heard).toEqual(["agent:ses_a"])
  })

  test("a subagent announces itself when its turn starts, and its output adds nothing", () => {
    flush([busy("ses_child")])
    flush([delta("ses_child")])
    expect(heard).toEqual(["subagent:ses_child"])
  })

  test("a turn is named by the message its first output belongs to", () => {
    flush([busy("ses_a"), delta("ses_a")])
    expect(startMessages).toEqual(["msg_a"])
  })

  const created = (id: string, patch: Partial<Session> = {}): SyncEvent => (
    { type: "session.created", properties: { info: session(id, patch) } }
  )

  // The session record reaches the global list only when the flush publishes, after these events ran.
  for (const store of [true, false]) {
    const where = store ? "an open directory" : "a directory without a store"

    test(`a subagent created and started in one flush counts as a subagent, in ${where}`, () => {
      flush([created("ses_new_child", { parentID: "ses_a" }), busy("ses_new_child")], { store })
      expect(heard).toEqual(["subagent:ses_new_child"])
    })

    test(`a main session created and started in one flush still waits for its first output, in ${where}`, () => {
      flush([created("ses_new_main"), busy("ses_new_main")], { store })
      expect(heard).toEqual([])
      flush([delta("ses_new_main")], { store })
      expect(heard).toEqual(["agent:ses_new_main"])
    })
  }

  test("a status the host reported, or one without a start, announces nothing", () => {
    flush([busy("ses_a", "host")])
    flush([{ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } }])
    flush([delta("ses_a")])
    expect(heard).toEqual([])
  })

  test("a turn that ends before it said anything announces nothing", () => {
    flush([busy("ses_a")])
    flush([{ type: "session.idle", properties: { sessionID: "ses_a" } }])
    flush([delta("ses_a")])
    expect(heard).toEqual([])
  })

  test("an event whose global effects already ran announces nothing", () => {
    const childStores = new ChildStoreManager()
    childStores.ensureChild("/repo", { bootstrap: false })
    try {
      handleEvent("/repo", busy("ses_a"), childStores, createEventRoutingIndex(), getRuntimeKey(), true, undefined, undefined, true)
      handleEvent("/repo", delta("ses_a"), childStores, createEventRoutingIndex(), getRuntimeKey(), true, undefined, undefined, true)
      expect(heard).toEqual([])
    } finally {
      childStores.disposeAll()
    }
  })

  test("nothing is kept for a start while no start sound is wanted", () => {
    turnStartsWanted.mockReturnValue(false)
    flush([busy("ses_a")])
    turnStartsWanted.mockReturnValue(true)
    flush([delta("ses_a")])
    expect(heard).toEqual([])
  })

  test("a tool call ticks when it starts running and a finished edit makes the edit sound, in the session on screen", () => {
    setExternallyViewedSession("/repo", "ses_a", true)
    withStore((send) => {
      send([toolPart("edit", "pending")])
      expect(heard).toEqual([])
      send([called])
      expect(heard).toEqual(["tick"])
      send([succeeded])
      expect(heard).toEqual(["tick", "edit"])
    })
  })

  test("a finished call that is not an edit makes no sound", () => {
    setExternallyViewedSession("/repo", "ses_a", true)
    withStore((send) => {
      send([toolPart("read", "pending"), called, succeeded])
      expect(heard).toEqual(["tick"])
    })
  })

  test("a session that is not on screen makes no tool sound", () => {
    withStore((send) => {
      send([toolPart("edit", "pending"), called, succeeded])
      expect(heard).toEqual([])
    })
  })

  test("a snapshot of a running tool part makes no sound, and neither does a call replayed after it finished", () => {
    setExternallyViewedSession("/repo", "ses_a", true)
    withStore((send) => {
      send([{
        type: "message.part.updated",
        properties: {
          sessionID: "ses_a",
          part: { id: "call_1", sessionID: "ses_a", messageID: "msg_a", type: "tool", callID: "call_1", tool: "edit", state: { status: "running", input: {}, time: { start: 1 } } },
        },
      }])
      expect(heard).toEqual([])
      send([succeeded])
      expect(heard).toEqual(["edit"])
      send([called, succeeded])
      expect(heard).toEqual(["edit"])
    })
  })

  test("tool events cost nothing while no tool sound is wanted", () => {
    toolSoundsWanted.mockReturnValue(false)
    setExternallyViewedSession("/repo", "ses_a", true)
    withStore((send) => {
      send([toolPart("edit", "pending"), called, succeeded])
      expect(heard).toEqual([])
    })
  })
})

// A whole turn, the way the event stream hands it over: `handleDirectoryEvents` batches the
// events of one flush, publishes the status index at the end, and the tracker reads the edges.
describe("turn end sounds through the event stream", () => {
  const heard: string[] = []
  const announcedRequests: string[] = []
  let sessionDone: ReturnType<typeof spyOn>
  let subagentDone: ReturnType<typeof spyOn>
  let turnFailed: ReturnType<typeof spyOn>
  let announce: ReturnType<typeof spyOn>
  let stopTracker: () => void
  const realShellSessionIds = useBackgroundShellsStore.getState().sessionIds

  // The tracker waits this long after a session goes idle before it decides what the end means.
  const afterTurnWait = () => new Promise((resolve) => setTimeout(resolve, 450))

  const busy = (sessionID: string): SyncEvent => (
    { type: "session.status", properties: { sessionID, status: { type: "busy" }, turnStart: { at: 1, source: "live" } } }
  )
  // `session.execution.succeeded` and `.failed` reach the client as a patch stamped with the server's time, then the idle or error.
  const succeeded = (sessionID: string, stamp: number): SyncEvent[] => [
    { type: "session.patched", properties: { sessionID, patch: { outcome: "succeeded", time: { idle: stamp, updated: stamp } } } },
    { type: "session.idle", properties: { sessionID, outcome: "succeeded" } },
  ]
  const failed = (sessionID: string, stamp: number, error = { type: "unknown", message: "boom" }): SyncEvent[] => [
    { type: "session.patched", properties: { sessionID, patch: { outcome: "failed", time: { idle: stamp, updated: stamp } } } },
    { type: "session.error", properties: { sessionID, error } },
  ]

  const flush = (events: SyncEvent[], options: { store: boolean } = { store: true }) => {
    const childStores = new ChildStoreManager()
    if (options.store) childStores.ensureChild("/repo", { bootstrap: false })
    try {
      handleDirectoryEvents("/repo", events, childStores, createEventRoutingIndex(), getRuntimeKey(), undefined)
    } finally {
      childStores.disposeAll()
    }
  }

  beforeEach(() => {
    heard.length = 0
    announcedRequests.length = 0
    resetGlobalBlockingRequests()
    replaceGlobalSessionStatusById(new Map())
    turnEndTracker.reset()
    useGlobalSessionsStore.getState().applySnapshot([
      session("ses_a"),
      session("ses_child", { parentID: "ses_a" }),
      session("ses_btw", { parentID: "ses_a", metadata: { openchamber: { kind: "btw", originalSessionID: "ses_a" } } }),
    ], [], "ready")
    sessionDone = spyOn(soundSignals, "sessionDone").mockImplementation((id, stamp) => { heard.push(`done:${id}:${stamp}`) })
    subagentDone = spyOn(soundSignals, "subagentDone").mockImplementation((id, stamp) => { heard.push(`subagent:${id}:${stamp}`) })
    turnFailed = spyOn(soundSignals, "turnFailed").mockImplementation((id, stamp) => { heard.push(`error:${id}:${stamp}`) })
    announce = spyOn(soundReminders, "announce").mockImplementation((request) => { announcedRequests.push(request.requestId) })
    stopTracker = turnEndTracker.start()
  })

  afterEach(() => {
    stopTracker()
    sessionDone.mockRestore()
    subagentDone.mockRestore()
    turnFailed.mockRestore()
    announce.mockRestore()
    turnEndTracker.reset()
    replaceGlobalSessionStatusById(new Map())
    resetGlobalBlockingRequests()
    useBackgroundShellsStore.setState({ sessionIds: realShellSessionIds })
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  for (const store of [true, false]) {
    const where = store ? "an open directory" : "a directory without a store"

    test(`a turn that goes busy and then idle plays one end sound, stamped with the server's time, in ${where}`, async () => {
      flush([busy("ses_a")], { store })
      flush(succeeded("ses_a", 1000), { store })
      await afterTurnWait()
      expect(heard).toEqual(["done:ses_a:1000"])
    })
  }

  test("a whole turn in one flush plays one end sound", async () => {
    flush([busy("ses_a"), ...succeeded("ses_a", 1000)])
    await afterTurnWait()
    expect(heard).toEqual(["done:ses_a:1000"])
  })

  test("two quick turns of one session play one end sound each, under their own stamps", async () => {
    flush([busy("ses_a")])
    flush(succeeded("ses_a", 1000))
    await afterTurnWait()
    flush([busy("ses_a")])
    flush(succeeded("ses_a", 1700))
    await afterTurnWait()
    expect(heard).toEqual(["done:ses_a:1000", "done:ses_a:1700"])
  })

  test("a failure plays the error sound once, and a failure reported before the busy edge of its flush too", async () => {
    flush([busy("ses_a"), ...failed("ses_a", 2000)])
    await afterTurnWait()
    expect(heard).toEqual(["error:ses_a:2000"])
  })

  test("pressing Stop plays no sound, even when OpenCode records it as an error", async () => {
    flush([busy("ses_a")])
    flush(failed("ses_a", 3000, { type: "MessageAbortedError", message: "Step interrupted" }))
    flush([busy("ses_a")])
    flush([
      { type: "session.patched", properties: { sessionID: "ses_a", patch: { outcome: "interrupted", time: { idle: 3100, updated: 3100 } } } },
      { type: "session.idle", properties: { sessionID: "ses_a", outcome: "interrupted" } },
    ])
    await afterTurnWait()
    expect(heard).toEqual([])
  })

  test("a command left running in the background does not hold the end sound back", async () => {
    useBackgroundShellsStore.setState({ sessionIds: new Set(["ses_a"]) })
    flush([busy("ses_a")])
    flush(succeeded("ses_a", 4000))
    await afterTurnWait()
    expect(heard).toEqual(["done:ses_a:4000"])
  })

  test("a running subagent holds the parent's sound back, and its own end plays the subagent sound", async () => {
    flush([busy("ses_child"), busy("ses_a")])
    flush(succeeded("ses_a", 5000))
    await afterTurnWait()
    expect(heard).toEqual([])
    flush(succeeded("ses_child", 5200))
    await afterTurnWait()
    expect(heard).toEqual(["subagent:ses_child:5200"])
  })

  test("a btw fork ends like a main session", async () => {
    flush([busy("ses_btw")])
    flush(succeeded("ses_btw", 6000))
    await afterTurnWait()
    expect(heard).toEqual(["done:ses_btw:6000"])
  })

  test("a status snapshot of any kind plays no sound and announces nothing", async () => {
    applyGlobalSessionStatusSnapshot("/repo", { ses_a: { type: "busy" } }, ["ses_a"])
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has("ses_a")).toBe(true)
    applyGlobalSessionStatusSnapshot("/repo", {}, ["ses_a"])
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has("ses_a")).toBe(false)
    await afterTurnWait()
    expect(heard).toEqual([])
    expect(announcedRequests).toEqual([])
    // The tracker saw no edge, so a stray idle for the session is no turn end either.
    flush(succeeded("ses_a", 7000))
    await afterTurnWait()
    expect(heard).toEqual([])
  })

  test("the host's status and pending requests announce nothing; the turns it seeded end with one sound", async () => {
    const getSnapshot = spyOn(opencodeClient, "getHostSessionStatusSnapshot").mockResolvedValue({
      serverTime: 10_000,
      sessions: { ses_a: { status: "busy", lastUpdateAt: 10_000 } },
      pending: {
        ses_a: {
          permissions: [{ id: "per_seed", sessionID: "ses_a", action: "bash", resources: [] }],
          forms: [{ id: "frm_seed", sessionID: "ses_a", title: "Continue?" }],
          pages: [{ id: "call_seed", sessionID: "ses_a", title: "Pick" }],
        },
      },
    })
    try {
      await seedGlobalSessionStatusFromHost()
      await afterTurnWait()
      expect(useGlobalSessionStatusStore.getState().activeSessionIds.has("ses_a")).toBe(true)
      expect(heard).toEqual([])
      expect(announcedRequests).toEqual([])
      // A turn that was running when the page loaded plays its one sound when it ends.
      flush(succeeded("ses_a", 8000))
      await afterTurnWait()
      expect(heard).toEqual(["done:ses_a:8000"])
    } finally {
      getSnapshot.mockRestore()
    }
  })
})
