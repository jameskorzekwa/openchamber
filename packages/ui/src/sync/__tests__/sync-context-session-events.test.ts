import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Window } from "happy-dom"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Session } from "@/lib/opencode/model"

const browser = new Window({ url: "http://localhost/" })
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, CustomEvent: browser.CustomEvent,
})
const fetchFixture = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), "http://localhost/").pathname
  if (path.endsWith("/location")) return Response.json({ directory: "/repo", project: { id: "project", directory: "/repo", canonical: "/repo" } })
  if (path.endsWith("/session")) return Response.json({ data: [] })
  return Response.json({})
})

const { useGlobalSessionsStore } = await import("@/stores/useGlobalSessionsStore")
const { useSessionUIStore } = await import("../session-ui-store")
const { useProjectsStore } = await import("@/stores/useProjectsStore")
const { getRuntimeKey, switchRuntimeEndpoint } = await import("@/lib/runtime-switch")
const {
  applySessionEventsToGlobalSessions,
  applySessionEventToGlobalSessions,
  readDeferredGlobalUpdates,
} = await import("../session-event-router")
const {
  registerBulkArchiveEchoes,
  releaseBulkArchiveEchoes,
  shouldConsumeBulkArchiveEcho,
} = await import("../bulk-archive-echo")

afterAll(async () => {
  await browser.happyDOM.close()
  fetchFixture.mockRestore()
})

const buildSession = (title: string, time: Session["time"]): Session => ({
  id: "ses_1", projectID: "project", directory: "/repo", title, time, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const buildEvent = (session: Session): SyncEvent => ({
  type: "session.patched",
  properties: {
    sessionID: session.id,
    patch: { title: session.title, time: session.time, directory: session.directory },
  },
})
const idle: SyncEvent = { type: "session.idle", properties: { sessionID: "ses_1" } }
const current = () => useGlobalSessionsStore.getState().entityById.get("ses_1")
const publish = (session: Session) => useGlobalSessionsStore.getState().upsertSession(session)
const patch = (value: Extract<SyncEvent, { type: "session.patched" }>["properties"]["patch"]) => (
  applySessionEventToGlobalSessions({ type: "session.patched", properties: { sessionID: "ses_1", patch: value } })
)
let runtimeSequence = 0

describe("applySessionEventToGlobalSessions", () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: "http://localhost/api", runtimeKey: `runtime-${++runtimeSequence}` })
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null })
  })

  test("skips stale global session.patched echoes after a newer rename", () => {
    publish(buildSession("New Title", { created: 1, updated: 20 }))
    const before = current()
    applySessionEventToGlobalSessions(buildEvent(buildSession("Old Title", { created: 1, updated: 10 })))
    expect(current()).toBe(before)
  })

  test("commits only the latest recency update when a session becomes idle", () => {
    publish(buildSession("Initial", { created: 1, updated: 10 }))
    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 20 })))
    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 30 })))
    expect(current()?.time.updated).toBe(10)
    applySessionEventToGlobalSessions(idle)
    expect(current()?.time.updated).toBe(30)
  })

  test("keeps every spend patch of a turn in the update committed at idle", () => {
    publish(buildSession("Initial", { created: 1, updated: 10 }))
    const tokens = { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }
    patch({ cost: 1, time: { updated: 20 } })
    patch({ tokens })
    expect(current()?.cost).toBe(0)
    expect(readDeferredGlobalUpdates().get("ses_1")).toMatchObject({ cost: 1, tokens })
    applySessionEventToGlobalSessions(idle)
    expect(current()).toMatchObject({ cost: 1, tokens, time: { updated: 20 } })
    expect(readDeferredGlobalUpdates().size).toBe(0)
  })

  test("a deferred update keeps what another owner published meanwhile", () => {
    const initial = buildSession("Initial", { created: 1, updated: 10 })
    publish(initial)
    const tokens = { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }
    patch({ cost: 1, time: { updated: 20 } })
    publish({ ...initial, time: { ...initial.time, viewed: 8 } })
    patch({ tokens })
    applySessionEventToGlobalSessions(idle)
    expect(current()).toMatchObject({ cost: 1, tokens, time: { updated: 20, viewed: 8 } })
  })

  test("spend a refresh published meanwhile wins over the deferred spend", () => {
    const initial = buildSession("Initial", { created: 1, updated: 10 })
    publish(initial)
    patch({ cost: 1, time: { updated: 20 } })
    publish({ ...initial, cost: 2 })
    applySessionEventToGlobalSessions(idle)
    expect(current()?.cost).toBe(2)
  })

  test("a structural patch publishes with the spend deferred before it", () => {
    publish(buildSession("Initial", { created: 1, updated: 10 }))
    patch({ cost: 2, time: { updated: 20 } })
    patch({ title: "Renamed" })
    expect(current()).toMatchObject({ title: "Renamed", cost: 2, time: { updated: 20 } })
    const before = current()
    applySessionEventToGlobalSessions(idle)
    expect(current()).toBe(before)
  })

  test("applies substantive session updates immediately", () => {
    publish(buildSession("Initial", { created: 1, updated: 10 }))
    applySessionEventToGlobalSessions(buildEvent(buildSession("Renamed", { created: 1, updated: 20 })))
    expect(current()?.title).toBe("Renamed")
  })

  test("applies a metadata broadcast to the global record at once", () => {
    publish(buildSession("Initial", { created: 1, updated: 10 }))
    patch({ metadata: { openchamber: { work: { state: "open" } } } })
    expect(current()?.metadata).toEqual({ openchamber: { work: { state: "open" } } })
    expect(current()?.title).toBe("Initial")
  })

  test("reconciles an externally moved selected session to its new directory", () => {
    useProjectsStore.setState({ projects: [{ id: "main", path: "/repo/main" }, { id: "worktree", path: "/repo/worktree" }] })
    publish({ ...buildSession("Initial", { created: 1, updated: 10 }), directory: "/repo/main" })
    useSessionUIStore.setState({ currentSessionId: "ses_1", currentSessionDirectory: "/repo/main" })
    applySessionEventToGlobalSessions(buildEvent({ ...buildSession("Initial", { created: 1, updated: 20 }), directory: "/repo/worktree" }))
    expect(current()?.directory).toBe("/repo/worktree")
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_1")
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe("/repo/worktree")
  })

  test("cancels a pending global update when the session is deleted", () => {
    publish(buildSession("Initial", { created: 1, updated: 10 }))
    patch({ time: { updated: 20 } })
    applySessionEventToGlobalSessions({ type: "session.deleted", properties: { sessionID: "ses_1" } })
    applySessionEventToGlobalSessions(idle)
    expect(current()).toBeUndefined()
    expect(readDeferredGlobalUpdates().size).toBe(0)
  })

  test("discards pending global updates when the runtime changes", () => {
    publish(buildSession("Initial", { created: 1, updated: 10 }))
    patch({ time: { updated: 20 } })
    expect(readDeferredGlobalUpdates().size).toBe(1)
    switchRuntimeEndpoint({ apiBaseUrl: "http://localhost/api", runtimeKey: "runtime-other" })
    publish(buildSession("Other runtime", { created: 1, updated: 5 }))
    applySessionEventToGlobalSessions(idle)
    expect(current()).toMatchObject({ title: "Other runtime", time: { updated: 5 } })
    expect(readDeferredGlobalUpdates().size).toBe(0)
  })

  test("commits an ordered event batch once", () => {
    let publications = 0
    const unsubscribe = useGlobalSessionsStore.subscribe((state, previous) => {
      if (state.entityById !== previous.entityById) publications += 1
    })
    try {
      const events: SyncEvent[] = Array.from({ length: 1_000 }, (_, index) => ({
        type: "session.created",
        properties: { info: { ...buildSession(`Session ${index}`, { created: index, updated: index }), id: `ses_${index}` } },
      }))
      applySessionEventsToGlobalSessions(events)
      expect(publications).toBe(1)
      expect(useGlobalSessionsStore.getState().entityById.size).toBe(1_000)
      expect(useGlobalSessionsStore.getState().entityById.get("ses_999")?.title).toBe("Session 999")
    } finally {
      unsubscribe()
    }
  })

  test("consumes only the matching bulk archive echo", () => {
    const runtime = getRuntimeKey()
    registerBulkArchiveEchoes(runtime, [{ id: "ses_1", archivedAt: 20 }], 100)
    expect(shouldConsumeBulkArchiveEcho(buildEvent(buildSession("Initial", { created: 1, updated: 20, archived: 20 })), runtime, 101)).toBe(true)
    expect(shouldConsumeBulkArchiveEcho(buildEvent(buildSession("Initial", { created: 1, updated: 21, archived: 21 })), runtime, 101)).toBe(false)
    expect(shouldConsumeBulkArchiveEcho(buildEvent(buildSession("Initial", { created: 1, updated: 20, archived: 20 })), "runtime-other", 101)).toBe(false)
  })

  test("does not consume an expired or released bulk archive echo", () => {
    const runtime = getRuntimeKey()
    registerBulkArchiveEchoes(runtime, [{ id: "ses_1", archivedAt: 20 }], 100)
    const event = buildEvent(buildSession("Initial", { created: 1, updated: 20, archived: 20 }))
    expect(shouldConsumeBulkArchiveEcho(event, runtime, 30_101)).toBe(false)
    registerBulkArchiveEchoes(runtime, [{ id: "ses_1", archivedAt: 20 }], 100)
    releaseBulkArchiveEchoes(runtime, ["ses_1"])
    expect(shouldConsumeBulkArchiveEcho(event, runtime, 101)).toBe(false)
  })
})
