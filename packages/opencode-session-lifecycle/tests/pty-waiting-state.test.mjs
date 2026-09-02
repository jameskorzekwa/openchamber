import assert from "node:assert/strict"
import test from "node:test"

import {
  createPtyWaitingState,
  parsePtyExitIDs,
  parsePtySpawnID,
} from "../lib/pty-waiting-state.mjs"

const createApi = (initialSessions) => {
  const sessions = new Map(initialSessions.map((session) => [session.id, structuredClone(session)]))
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    if (url.pathname === "/session") return Response.json([...sessions.values()])
    const sessionID = decodeURIComponent(url.pathname.slice("/session/".length))
    const session = sessions.get(sessionID)
    if (!session) return new Response("missing", { status: 404 })
    if ((init.method ?? "GET") === "PATCH") {
      const body = JSON.parse(init.body)
      const next = { ...session, metadata: body.metadata }
      sessions.set(sessionID, next)
      return Response.json(next)
    }
    return Response.json(session)
  }
  return { fetchImpl, sessions }
}

test("parses PTY spawn and exit envelopes", () => {
  assert.equal(parsePtySpawnID("<pty_spawned>\nID: pty_a1b2c3d4\n</pty_spawned>"), "pty_a1b2c3d4")
  assert.equal(parsePtySpawnID("not a spawn"), null)
  assert.deepEqual(parsePtyExitIDs([
    { type: "text", text: "<pty_exited>\nID: pty_a1b2c3d4\n</pty_exited>" },
    { type: "text", text: "<pty_exited>\nID: pty_11223344\n</pty_exited>" },
  ]), ["pty_a1b2c3d4", "pty_11223344"])
})

test("publishes and clears session-owned waiting jobs without replacing other metadata", async () => {
  const { fetchImpl, sessions } = createApi([{
    id: "ses_owner",
    metadata: {
      openchamber: {
        goal: {
          id: "goal",
          objective: "Ship the change",
          status: "active",
          statusReason: "",
          blockedStreak: 0,
          auditFailStreak: 0,
        },
      },
      other: true,
    },
  }])
  let timestamp = 100
  const state = createPtyWaitingState({
    serverUrl: "http://127.0.0.1:4097/",
    directory: "/repo",
    fetchImpl,
    now: () => timestamp++,
  })

  assert.equal(await state.register({
    id: "pty_a1b2c3d4",
    sessionID: "ses_owner",
    description: "Wait for deployment",
    timeoutSeconds: 300,
  }), true)
  assert.equal(await state.register({
    id: "pty_11223344",
    sessionID: "ses_owner",
    description: "Watch device startup",
  }), true)

  const active = sessions.get("ses_owner").metadata
  assert.equal(active.openchamber.goal.status, "active")
  assert.equal(active.other, true)
  assert.equal(active.openchamber.backgroundJobs.resumeGoalID, "goal")
  assert.deepEqual(active.openchamber.backgroundJobs.jobs, [
    {
      id: "pty_a1b2c3d4",
      kind: "pty",
      description: "Wait for deployment",
      createdAt: 100,
      timeoutSeconds: 300,
    },
    {
      id: "pty_11223344",
      kind: "pty",
      description: "Watch device startup",
      createdAt: 102,
    },
  ])

  sessions.get("ses_owner").metadata.openchamber.goal = {
    ...sessions.get("ses_owner").metadata.openchamber.goal,
    status: "blocked",
    statusReason: "waiting for deployment",
    blockedStreak: 2,
    auditFailStreak: 1,
  }
  assert.equal(await state.complete("pty_a1b2c3d4"), true)
  assert.deepEqual(sessions.get("ses_owner").metadata.openchamber.backgroundJobs.jobs.map((job) => job.id), ["pty_11223344"])
  assert.equal(sessions.get("ses_owner").metadata.openchamber.goal.status, "blocked")
  await state.handleExitParts([{ type: "text", text: "<pty_exited>\nID: pty_11223344\n</pty_exited>" }])
  assert.equal(sessions.get("ses_owner").metadata.openchamber.backgroundJobs, undefined)
  assert.deepEqual(sessions.get("ses_owner").metadata.openchamber.goal, {
    id: "goal",
    objective: "Ship the change",
    status: "active",
    statusReason: "",
    blockedStreak: 0,
    auditFailStreak: 0,
    updatedAt: 105,
  })
})

test("does not reactivate a goal that was already blocked before waiting", async () => {
  const goal = { id: "goal", status: "blocked", statusReason: "missing credentials", blockedStreak: 2 }
  const { fetchImpl, sessions } = createApi([{
    id: "ses_owner",
    metadata: { openchamber: { goal } },
  }])
  const state = createPtyWaitingState({
    serverUrl: "http://127.0.0.1:4097/",
    directory: "/repo",
    fetchImpl,
  })

  await state.register({ id: "pty_blocked", sessionID: "ses_owner", description: "Wait" })
  assert.equal(sessions.get("ses_owner").metadata.openchamber.backgroundJobs.resumeGoalID, undefined)
  await state.complete("pty_blocked")
  assert.deepEqual(sessions.get("ses_owner").metadata.openchamber.goal, goal)
})

test("does not override a paused, settled, or replacement goal when waiting ends", async () => {
  for (const changedGoal of [
    { id: "goal", status: "paused", statusReason: "paused by user" },
    { id: "goal", status: "complete", statusReason: "verified" },
    { id: "goal", status: "budgetLimited", statusReason: "token budget reached" },
    { id: "replacement", status: "blocked", statusReason: "replacement blocked" },
  ]) {
    const { fetchImpl, sessions } = createApi([{
      id: "ses_owner",
      metadata: { openchamber: { goal: { id: "goal", status: "active" } } },
    }])
    const state = createPtyWaitingState({
      serverUrl: "http://127.0.0.1:4097/",
      directory: "/repo",
      fetchImpl,
    })

    await state.register({ id: "pty_changed", sessionID: "ses_owner", description: "Wait" })
    sessions.get("ses_owner").metadata.openchamber.goal = changedGoal
    await state.complete("pty_changed")
    assert.deepEqual(sessions.get("ses_owner").metadata.openchamber.goal, changedGoal)
  }
})

test("does not resurrect a PTY that exits before spawn registration finishes", async () => {
  const { fetchImpl, sessions } = createApi([{ id: "ses_owner", metadata: {} }])
  const state = createPtyWaitingState({
    serverUrl: "http://127.0.0.1:4097/",
    directory: "/repo",
    fetchImpl,
  })
  assert.equal(await state.complete("pty_fast"), false)
  assert.equal(await state.register({ id: "pty_fast", sessionID: "ses_owner", description: "Fast" }), false)
  assert.equal(sessions.get("ses_owner").metadata.openchamber, undefined)
})

test("startup recovery removes stale waiting metadata", async () => {
  const { fetchImpl, sessions } = createApi([{
    id: "ses_stale",
    metadata: {
      openchamber: {
        goal: { id: "goal" },
        backgroundJobs: { version: 1, jobs: [{ id: "pty_stale", kind: "pty" }] },
      },
    },
  }])
  const state = createPtyWaitingState({
    serverUrl: "http://127.0.0.1:4097/",
    directory: "/repo",
    fetchImpl,
  })
  await state.recover()
  assert.equal(sessions.get("ses_stale").metadata.openchamber.backgroundJobs, undefined)
  assert.deepEqual(sessions.get("ses_stale").metadata.openchamber.goal, { id: "goal" })
})

test("startup recovery reactivates a blocked goal that entered a persisted wait while active", async () => {
  const { fetchImpl, sessions } = createApi([{
    id: "ses_stale",
    metadata: {
      openchamber: {
        goal: {
          id: "goal",
          status: "blocked",
          statusReason: "waiting for background process",
          blockedStreak: 2,
          auditFailStreak: 1,
        },
        backgroundJobs: {
          version: 1,
          resumeGoalID: "goal",
          jobs: [{ id: "pty_stale", kind: "pty" }],
        },
      },
    },
  }])
  const state = createPtyWaitingState({
    serverUrl: "http://127.0.0.1:4097/",
    directory: "/repo",
    fetchImpl,
    now: () => 500,
  })

  await state.recover()
  assert.equal(sessions.get("ses_stale").metadata.openchamber.backgroundJobs, undefined)
  assert.deepEqual(sessions.get("ses_stale").metadata.openchamber.goal, {
    id: "goal",
    status: "active",
    statusReason: "",
    blockedStreak: 0,
    auditFailStreak: 0,
    updatedAt: 500,
  })
})
