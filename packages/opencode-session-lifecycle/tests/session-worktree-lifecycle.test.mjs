import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import {
  __testing,
  abandonWorkspace,
  acknowledgeSessionTurn,
  assertSessionWorkspaceReady,
  assertSessionWorktreeNotClosing,
  createWorkspaceResumeScheduler,
  createTurnBarrier,
  finishWorkspace,
  getWorkspaceResumeScheduler,
  reconcilePlannedWorktrees,
  restoreMissingWorktree,
  restoreSessionWorktreeIfMissing,
  resumeWorkspaceFromExternalWait,
  startWorkspace,
  submitWorkspace,
  waitForExternal,
} from "../lib/session-worktree-lifecycle.mjs"

const execFile = promisify(execFileCallback)
const temporaryDirectories = []
const sessionIDs = []
const sessionID = (prefix) => `ses_${prefix}_${randomUUID()}`
let originalHome
let testHome

test.before(async () => {
  originalHome = process.env.HOME
  testHome = await mkdtemp(path.join(os.tmpdir(), "session-worktree-home-"))
  process.env.HOME = testHome
})

test.after(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(testHome, { recursive: true, force: true })
})

const git = async (directory, ...args) => {
  const result = await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })
  return String(result.stdout || "").trim()
}

// The installed lifecycle (ported from the Heirloom agent bridge) verifies a dev
// deployment by its JSON health payload rather than by finding the commit in the
// response body, and additionally requires a successful "Deploy Platform
// Nonproduction" workflow run for the exact deployed commit. Tests supply both
// pieces of evidence explicitly; the 52K-era `deployed=<sha>` bodies no longer
// satisfy the contract.
const HEALTHY_DEV_BODY = JSON.stringify({ status: "ok" })
const successfulWorkflow = async (_primary, commit) => ({
  required: true,
  run: { databaseId: 1, headSha: commit, conclusion: "success", url: "https://example.invalid/run/1" },
})

const createRepository = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-worktree-test-"))
  temporaryDirectories.push(root)
  const remote = path.join(root, "remote.git")
  const primary = path.join(root, "primary")
  await execFile("git", ["init", "--bare", remote])
  await execFile("git", ["clone", remote, primary])
  await git(primary, "config", "user.name", "Test User")
  await git(primary, "config", "user.email", "test@example.invalid")
  await writeFile(path.join(primary, "README.md"), "initial\n")
  await git(primary, "add", "README.md")
  await git(primary, "commit", "-m", "Initial")
  await git(primary, "branch", "-M", "main")
  await git(primary, "push", "-u", "origin", "main")
  await execFile("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"])
  return { root, remote, primary }
}

const sessionApi = (sessionID, initialDirectory, options = {}) => {
  let directory = initialDirectory
  let moveCount = 0
  let metadata = structuredClone(options.metadata ?? {})
  let devBody = ""
  let statuses = structuredClone(options.initialStatuses ?? {
    [sessionID]: options.initialStatus ?? { type: "idle" },
  })
  let children = structuredClone(options.children ?? [])
  const otherSessions = structuredClone(options.otherSessions ?? [])
  const includeDefaultUserRequest = options.messages === undefined
  let messages = structuredClone(options.messages ?? [{
    info: {
      id: "msg_assistant",
      sessionID,
      role: "assistant",
      providerID: "provider",
      modelID: "model",
      agent: "build",
      time: { completed: Date.now() },
    },
    parts: [{ type: "text", text: "Ready to implement" }],
  }])
  const requests = []
  const fetchImpl = async (url, request = {}) => {
    const pathname = new URL(url).pathname
    const requestUrl = new URL(url)
    requests.push({ pathname, method: request.method ?? "GET", body: request.body })
    if (pathname.endsWith("/experimental/session")) {
      return new Response(JSON.stringify([{ id: sessionID, directory, metadata }, ...otherSessions]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (pathname.endsWith("/experimental/control-plane/move-session")) {
      moveCount += 1
      if (options.failMoveAt === moveCount) return new Response("move failed", { status: 500 })
      const input = JSON.parse(request.body)
      if (input.sessionID === sessionID) directory = input.destination.directory
      else {
        const session = otherSessions.find((candidate) => candidate.id === input.sessionID)
        if (!session) return new Response("session not found", { status: 404 })
        session.directory = input.destination.directory
      }
      return new Response(null, { status: 204 })
    }
    if (pathname.endsWith("/session") && request.method !== "POST") {
      const requestedDirectory = requestUrl.searchParams.get("directory")
      return new Response(JSON.stringify([
        { id: sessionID, directory, metadata },
        ...otherSessions,
      ].filter((session) => session.directory === requestedDirectory)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (pathname.endsWith(`/session/${sessionID}/message`) && request.method !== "POST") {
      const requestMessages = includeDefaultUserRequest ? [
        { info: { id: "msg_user", role: "user" }, parts: [{ type: "text", text: options.userRequest ?? "Implement the requested feature" }] },
        ...messages,
      ] : messages
      return new Response(JSON.stringify(requestMessages), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (pathname.endsWith("/session/status")) {
      return new Response(JSON.stringify(statuses), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (pathname.endsWith(`/session/${sessionID}/children`)) {
      return new Response(JSON.stringify(children), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (pathname.endsWith(`/session/${sessionID}/message`) && request.method === "POST") {
      if (options.failResumeDispatch) return new Response("dispatch failed", { status: 500 })
      const body = JSON.parse(request.body)
      statuses[sessionID] = { type: "busy" }
      messages.push({ info: { id: body.messageID, sessionID, role: "user" }, parts: body.parts })
      options.onResumePrompt?.(body)
      messages.push({
        info: {
          id: `msg_assistant_${messages.length}`,
          sessionID,
          role: "assistant",
          providerID: body.model.providerID,
          modelID: body.model.modelID,
          agent: body.agent,
          variant: body.variant,
          time: { completed: Date.now() },
        },
        parts: [{ type: "text", text: "Automatic continuation completed" }],
      })
      statuses[sessionID] = { type: "idle" }
      return new Response(JSON.stringify(messages.at(-1)), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (pathname.endsWith(`/session/${sessionID}`) && request.method === "PATCH") {
      if (options.failGoalPatch) return new Response("goal patch failed", { status: 500 })
      metadata = JSON.parse(request.body).metadata
      return new Response(JSON.stringify({ id: sessionID, directory, metadata }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (pathname.endsWith(`/session/${sessionID}`)) {
      return new Response(JSON.stringify({ id: sessionID, directory, metadata }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const otherSession = otherSessions.find((session) => pathname.endsWith(`/session/${session.id}`))
    if (otherSession) {
      return new Response(JSON.stringify(otherSession), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (pathname.endsWith("/dev-smoke")) return new Response(devBody, { status: 200 })
    return new Response("not found", { status: 404 })
  }
  return {
    fetchImpl,
    directory: () => directory,
    metadata: () => metadata,
    requests,
    setDevBody: (value) => { devBody = value },
    setStatus: (value) => { statuses[sessionID] = value },
    setSessionStatus: (targetSessionID, value) => { statuses[targetSessionID] = value },
    setChildStatus: (childID, value) => { statuses[childID] = value },
    setChildren: (value) => { children = structuredClone(value) },
    setMessages: (value) => { messages = structuredClone(value) },
    addSession: (session) => { otherSessions.push(structuredClone(session)) },
    sessionDirectory: (targetSessionID) => targetSessionID === sessionID
      ? directory
      : otherSessions.find((session) => session.id === targetSessionID)?.directory,
  }
}

test.afterEach(async () => {
  for (const sessionID of sessionIDs.splice(0)) {
    const state = await __testing.readState(sessionID)
    if (state?.primary && state?.worktree) {
      await git(state.primary, "worktree", "remove", "--force", state.worktree).catch(() => undefined)
      await git(state.primary, "branch", "-D", state.branch).catch(() => undefined)
    }
    await rm(__testing.statePath(sessionID), { force: true })
  }
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

test("starts and finishes after merge", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("test")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/roundtrip",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })

  assert.equal(api.directory(), state.worktree)
  assert.equal(await git(state.worktree, "branch", "--show-current"), "feat/roundtrip")
  assert.equal(await git(state.worktree, "rev-parse", "HEAD"), await git(primary, "rev-parse", "origin/main"))
  assert.equal(api.metadata().openchamber.goal.id, state.managedGoalID)
  assert.equal(api.metadata().openchamber.goal.managedWorktree, true)
  assert.match(api.metadata().openchamber.goal.objective, /Deploy the merged implementation.*dev environment/s)
  assert.match(api.metadata().openchamber.goal.objective, /Implement the requested feature/)
  assert.equal(api.metadata().openchamber.goal.statusReason, "worktree-moving")
  const goalPatchIndex = api.requests.findIndex((request) => request.pathname.endsWith(`/session/${currentSession}`) && request.method === "PATCH")
  const moveIndex = api.requests.findIndex((request) => request.pathname.endsWith("/experimental/control-plane/move-session"))
  assert.ok(goalPatchIndex >= 0 && goalPatchIndex < moveIndex)
  await assertSessionWorkspaceReady({ sessionID: currentSession })

  await writeFile(path.join(state.worktree, "feature.txt"), "feature\n")
  await git(state.worktree, "add", "feature.txt")
  await git(state.worktree, "commit", "-m", "Feature")
  await git(state.worktree, "push", "-u", "origin", "feat/roundtrip")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--ff-only", "origin/feat/roundtrip")
  await git(primary, "push", "origin", "main")
  const deployedCommit = await git(primary, "rev-parse", "origin/main")
  api.setDevBody(HEALTHY_DEV_BODY)

  const finished = await finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: deployedCommit },
    inspectNonproduction: successfulWorkflow,
  })
  assert.equal(finished.phase, "complete")
  assert.equal(await canonical(api.directory()), await canonical(primary))
  await assert.rejects(assertSessionWorkspaceReady({ sessionID: currentSession }), /Stop this turn/)
  await acknowledgeSessionTurn(currentSession)
  await assert.rejects(readFile(__testing.statePath(currentSession), "utf8"), /ENOENT/)
  assert.equal(await git(primary, "branch", "--list", "feat/roundtrip"), "")
  assert.match(api.metadata().openchamber.goal.note, /opencode\.test\/dev-smoke/)
  assert.equal(api.metadata().openchamber.goal.status, "complete")
  assert.equal(api.metadata().openchamber.goal.managedWorktree, false)
  assert.equal(api.metadata().openchamber.goal.statusReason, "worktree lifecycle complete")
})

test("moves every session out of a worktree before removing it", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("relocate_owner")
  const peerSession = sessionID("relocate_peer")
  const childSession = sessionID("relocate_child")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/relocate-sessions",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  api.addSession({ id: peerSession, directory: state.worktree, time: { archived: Date.now() } })
  api.addSession({ id: childSession, directory: state.worktree, parentID: currentSession })
  await writeFile(path.join(state.worktree, "fix.txt"), "fix\n")
  await git(state.worktree, "add", "fix.txt")
  await git(state.worktree, "commit", "-m", "Fix")
  await git(state.worktree, "push", "-u", "origin", "fix/relocate-sessions")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--ff-only", "origin/fix/relocate-sessions")
  await git(primary, "push", "origin", "main")
  const deployedCommit = await git(primary, "rev-parse", "origin/main")
  api.setDevBody(HEALTHY_DEV_BODY)

  await finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: deployedCommit },
    inspectNonproduction: successfulWorkflow,
  })

  assert.equal(await canonical(api.sessionDirectory(currentSession)), await canonical(primary))
  assert.equal(await canonical(api.sessionDirectory(peerSession)), await canonical(primary))
  assert.equal(await canonical(api.sessionDirectory(childSession)), await canonical(primary))
  const movedSessionIDs = api.requests
    .filter((request) => request.pathname.endsWith("/experimental/control-plane/move-session"))
    .map((request) => JSON.parse(request.body).sessionID)
  assert.deepEqual(movedSessionIDs.slice(-3), [peerSession, childSession, currentSession])
})

test("preserves a worktree while another attached session is active", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("active_owner")
  const peerSession = sessionID("active_peer")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/active-session",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  api.addSession({ id: peerSession, directory: state.worktree })
  api.setSessionStatus(peerSession, { type: "busy" })
  await writeFile(path.join(state.worktree, "fix.txt"), "fix\n")
  await git(state.worktree, "add", "fix.txt")
  await git(state.worktree, "commit", "-m", "Fix")
  await git(state.worktree, "push", "-u", "origin", "fix/active-session")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--ff-only", "origin/fix/active-session")
  await git(primary, "push", "origin", "main")
  const deployedCommit = await git(primary, "rev-parse", "origin/main")
  api.setDevBody(HEALTHY_DEV_BODY)

  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: deployedCommit },
    inspectNonproduction: successfulWorkflow,
  }), new RegExp(`other sessions are active: ${peerSession}`))
  assert.equal(api.sessionDirectory(currentSession), state.worktree)
  assert.equal(api.sessionDirectory(peerSession), state.worktree)
  assert.equal(await git(primary, "worktree", "list", "--porcelain").then((output) => output.includes(state.worktree)), true)
  await assert.rejects(assertSessionWorktreeNotClosing({
    sessionID: peerSession,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  }), new RegExp(`cleanup is in progress for session ${currentSession}`))
  await assert.doesNotReject(assertSessionWorktreeNotClosing({
    sessionID: currentSession,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  }))

  api.setSessionStatus(peerSession, { type: "idle" })
  // 69K: a retry from the worktree re-enters the deployment block and re-checks
  // the workflow gate with the persisted deployment, so the evidence stub is
  // still required even though devDeployment itself is no longer passed.
  await finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    inspectNonproduction: successfulWorkflow,
  })
  assert.equal(await canonical(api.sessionDirectory(peerSession)), await canonical(primary))
})

test("turn barrier blocks tools only until the next user message", () => {
  const barrier = createTurnBarrier()
  barrier.assert("ses_turn")
  barrier.block("ses_turn")
  assert.throws(() => barrier.assert("ses_turn"), /Stop this turn/)
  barrier.assert("ses_other")
  barrier.acknowledge("ses_turn")
  barrier.assert("ses_turn")
})

test("automatically resumes after the moved turn becomes idle", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("auto_resume")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, { initialStatus: { type: "busy" } })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/auto-resume",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  const scheduler = createWorkspaceResumeScheduler({
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    retryDelayMs: 5,
  })
  const result = scheduler.schedule(state)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(api.requests.filter((request) => request.pathname.endsWith("/message") && request.method === "POST").length, 0)
  api.setStatus({ type: "idle" })
  assert.deepEqual(await result, { status: "dispatched" })
  const prompts = api.requests.filter((request) => request.pathname.endsWith("/message") && request.method === "POST")
  assert.equal(prompts.length, 1)
  const prompt = JSON.parse(prompts[0].body)
  assert.deepEqual(prompt.model, { providerID: "provider", modelID: "model" })
  assert.equal(prompt.agent, "build")
  assert.match(prompt.parts[0].text, /finished moving into its implementation worktree/)
  assert.equal(prompt.parts[0].synthetic, true)
  assert.equal(api.metadata().openchamber.goal.statusReason, "resumed")
  assert.equal(api.metadata().openchamber.goal.turnsUsed, 1)
})

test("cancels automatic resume when a user message supersedes it", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("resume_cancel")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, { initialStatus: { type: "busy" } })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/resume-cancel",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  const scheduler = createWorkspaceResumeScheduler({
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    retryDelayMs: 5,
  })
  const result = scheduler.schedule(state)
  await scheduler.cancel(currentSession)
  assert.deepEqual(await result, { status: "cancelled" })
  api.setStatus({ type: "idle" })
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(api.requests.filter((request) => request.pathname.endsWith("/message") && request.method === "POST").length, 0)
  assert.equal(api.metadata().openchamber.goal.statusReason, "")
  assert.equal(api.metadata().openchamber.goal.turnsUsed, 0)
})

test("waits for busy child sessions before automatically resuming", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("resume_child")
  const childID = sessionID("resume_child_worker")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, {
    initialStatus: { type: "idle" },
    initialStatuses: {
      [currentSession]: { type: "idle" },
      [childID]: { type: "busy" },
    },
    children: [{ id: childID }],
  })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/resume-child",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  const scheduler = createWorkspaceResumeScheduler({
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    retryDelayMs: 5,
  })
  const result = scheduler.schedule(state)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(api.requests.filter((request) => request.pathname.endsWith("/message") && request.method === "POST").length, 0)
  api.setChildStatus(childID, { type: "idle" })
  assert.deepEqual(await result, { status: "dispatched" })
})

test("recovers a pending automatic resume from persisted attached state", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("resume_recover")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, { initialStatus: { type: "idle" } })
  await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/resume-recover",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  const scheduler = createWorkspaceResumeScheduler({
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    retryDelayMs: 5,
  })
  const recovered = await scheduler.recover()
  assert.equal(recovered.length, 1)
  assert.deepEqual(await recovered[0], { status: "dispatched" })
  assert.equal(api.requests.filter((request) => request.pathname.endsWith("/message") && request.method === "POST").length, 1)
})

test("shares one automatic resume scheduler across plugin instances", async () => {
  const first = getWorkspaceResumeScheduler({ serverUrl: new URL("http://opencode.test/") })
  const second = getWorkspaceResumeScheduler({ serverUrl: new URL("http://opencode.test/") })
  assert.equal(first, second)
  assert.equal(first.recover(), second.recover())
})

test("retries a failed automatic resume dispatch without double counting", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("resume_retry")
  sessionIDs.push(currentSession)
  let dispatches = 0
  const api = sessionApi(currentSession, primary, { initialStatus: { type: "idle" } })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/resume-retry",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  const fetchImpl = async (url, request = {}) => {
    if (new URL(url).pathname.endsWith("/message") && request.method === "POST") {
      dispatches += 1
      if (dispatches === 1) return new Response("transient", { status: 503 })
    }
    return api.fetchImpl(url, request)
  }
  const scheduler = createWorkspaceResumeScheduler({
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl,
    retryDelayMs: 5,
  })
  assert.deepEqual(await scheduler.schedule(state), { status: "dispatched" })
  assert.equal(dispatches, 2)
  assert.equal(api.metadata().openchamber.goal.turnsUsed, 1)
})

test("does not duplicate an accepted resume when its response is lost", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("resume_lost_response")
  sessionIDs.push(currentSession)
  let dispatches = 0
  const api = sessionApi(currentSession, primary, { initialStatus: { type: "idle" } })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/resume-lost-response",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  const fetchImpl = async (url, request = {}) => {
    if (new URL(url).pathname.endsWith("/message") && request.method === "POST") {
      dispatches += 1
      if (dispatches === 1) {
        await api.fetchImpl(url, request)
        throw new TypeError("response lost")
      }
    }
    return api.fetchImpl(url, request)
  }
  const scheduler = createWorkspaceResumeScheduler({
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl,
    retryDelayMs: 5,
  })
  assert.deepEqual(await scheduler.schedule(state), { status: "dispatched" })
  assert.equal(dispatches, 1)
  assert.equal(api.metadata().openchamber.goal.turnsUsed, 1)
  assert.equal(api.metadata().openchamber.goal.statusReason, "resumed")
})

test("reuses a legacy assistant mode and variant for automatic resume", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("resume_mode")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, {
    initialStatus: { type: "idle" },
    messages: [
      {
        info: { id: "msg_user", sessionID: currentSession, role: "user" },
        parts: [{ type: "text", text: "Implement the requested feature" }],
      },
      {
        info: {
          id: "msg_assistant",
          sessionID: currentSession,
          role: "assistant",
          providerID: "provider",
          modelID: "model",
          mode: "build",
          variant: "high",
          time: { completed: Date.now() },
        },
        parts: [{ type: "text", text: "Ready to implement" }],
      },
    ],
  })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/resume-mode",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  const scheduler = createWorkspaceResumeScheduler({
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    retryDelayMs: 5,
  })
  assert.deepEqual(await scheduler.schedule(state), { status: "dispatched" })
  const prompt = JSON.parse(api.requests.find((request) => request.pathname.endsWith("/message") && request.method === "POST").body)
  assert.equal(prompt.agent, "build")
  assert.equal(prompt.variant, "high")
})

test("serializes concurrent worktree creation in one repository", async () => {
  const { primary } = await createRepository()
  const firstSession = sessionID("concurrent_first")
  const secondSession = sessionID("concurrent_second")
  sessionIDs.push(firstSession, secondSession)
  const firstApi = sessionApi(firstSession, primary)
  const secondApi = sessionApi(secondSession, primary)

  const [first, second] = await Promise.all([
    startWorkspace({
      sessionID: firstSession,
      directory: primary,
      branch: "feat/concurrent-first",
      serverUrl: new URL("http://opencode.test/"),
      fetchImpl: firstApi.fetchImpl,
    }),
    startWorkspace({
      sessionID: secondSession,
      directory: primary,
      branch: "feat/concurrent-second",
      serverUrl: new URL("http://opencode.test/"),
      fetchImpl: secondApi.fetchImpl,
    }),
  ])

  assert.notEqual(first.worktree, second.worktree)
  assert.equal(await git(first.worktree, "branch", "--show-current"), "feat/concurrent-first")
  assert.equal(await git(second.worktree, "branch", "--show-current"), "feat/concurrent-second")
})

test("refuses dirty primary and unsafe cleanup", async () => {
  const { primary } = await createRepository()
  const dirtySession = sessionID("dirty")
  sessionIDs.push(dirtySession)
  await writeFile(path.join(primary, "dirty.txt"), "dirty\n")
  await assert.rejects(startWorkspace({
    sessionID: dirtySession,
    directory: primary,
    branch: "fix/dirty",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: sessionApi(dirtySession, primary).fetchImpl,
  }), /primary checkout must be clean/)
  await rm(path.join(primary, "dirty.txt"))

  const currentSession = sessionID("unmerged")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/unmerged",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  await writeFile(path.join(state.worktree, "fix.txt"), "fix\n")
  await git(state.worktree, "add", "fix.txt")
  await git(state.worktree, "commit", "-m", "Fix")
  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: await git(primary, "rev-parse", "origin/main") },
    inspectNonproduction: successfulWorkflow,
  }), /not present on origin/)
  assert.equal(api.directory(), state.worktree)
  assert.equal(await git(state.worktree, "status", "--porcelain"), "")
})

test("requires dev deployment evidence before finishing a managed goal", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("deployment")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, { userRequest: "Fix the deployment gate" })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/deployment-gate",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  await writeFile(path.join(state.worktree, "fix.txt"), "fix\n")
  await git(state.worktree, "add", "fix.txt")
  await git(state.worktree, "commit", "-m", "Fix")
  await git(state.worktree, "push", "-u", "origin", "fix/deployment-gate")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--ff-only", "origin/fix/deployment-gate")
  await git(primary, "push", "origin", "main")
  api.setDevBody(HEALTHY_DEV_BODY)

  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  }), /dev verification URL/)
  // 69K: the deployed commit must be a trusted origin/main descendant that
  // contains the integration commit; an unrelated SHA is refused by ancestry
  // rather than by exact equality with origin/main.
  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: "0".repeat(40) },
  }), /trusted origin\/main descendant containing integration commit/)
  // 69K: a defined deployment workflow without a successful exact-commit run
  // fails closed before the health endpoint is even consulted.
  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: await git(primary, "rev-parse", "origin/main") },
    inspectNonproduction: async () => ({ required: true, run: false }),
  }), /Deploy Platform Nonproduction did not complete successfully/)
  // 69K: the health payload must report status ok; the 52K contract of finding
  // the commit in the response body was replaced by the JSON health check.
  api.setDevBody(JSON.stringify({ status: "degraded" }))
  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: await git(primary, "rev-parse", "origin/main") },
    inspectNonproduction: successfulWorkflow,
  }), /status ok/)
  assert.equal(api.directory(), state.worktree)
  assert.equal(api.metadata().openchamber.goal.status, "active")
})

test("rejects oversized dev verification responses", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("large_dev_response")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/large-dev-response",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  await writeFile(path.join(state.worktree, "fix.txt"), "fix\n")
  await git(state.worktree, "add", "fix.txt")
  await git(state.worktree, "commit", "-m", "Fix")
  await git(state.worktree, "push", "-u", "origin", "fix/large-dev-response")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--ff-only", "origin/fix/large-dev-response")
  await git(primary, "push", "origin", "main")
  const deployedCommit = await git(primary, "rev-parse", "origin/main")
  api.setDevBody("x".repeat(1024 * 1024 + 1))
  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: deployedCommit },
    inspectNonproduction: successfulWorkflow,
  }), /exceeded the 1 MiB/)
  assert.equal(api.directory(), state.worktree)
})

test("removes a local branch after its exact head was squash-merged", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("squash")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/squash-roundtrip",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  await writeFile(path.join(state.worktree, "squashed.txt"), "squashed\n")
  await git(state.worktree, "add", "squashed.txt")
  await git(state.worktree, "commit", "-m", "Squashed feature")
  await git(state.worktree, "push", "-u", "origin", "feat/squash-roundtrip")
  const worktreeHead = await git(state.worktree, "rev-parse", "HEAD")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--squash", "origin/feat/squash-roundtrip")
  await git(primary, "commit", "-m", "Squash merged feature")
  await git(primary, "push", "origin", "main")
  api.setDevBody(HEALTHY_DEV_BODY)

  // 69K: isPullRequestMerged returns the merge commit OID (not a boolean) so
  // finish can require the deployed commit to contain that integration commit.
  const squashCommit = await git(primary, "rev-parse", "origin/main")
  const mergeChecks = []
  await finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: squashCommit },
    inspectNonproduction: successfulWorkflow,
    isPullRequestMerged: async (_primary, branch, head) => {
      mergeChecks.push({ branch, head })
      return branch === "feat/squash-roundtrip" && head === worktreeHead ? squashCommit : false
    },
  })

  assert.deepEqual(mergeChecks, [{ branch: "feat/squash-roundtrip", head: worktreeHead }])
  assert.equal(await git(primary, "branch", "--list", "feat/squash-roundtrip"), "")
})

test("rolls back and removes a worktree when the initial move fails", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("move_fail")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, { failMoveAt: 1 })
  await assert.rejects(startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/move-fail",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  }), /session move failed/)
  assert.equal(await canonical(api.directory()), await canonical(primary))
  assert.equal(await git(primary, "branch", "--list", "fix/move-fail"), "")
  assert.equal(api.metadata().openchamber, undefined)
  await assert.rejects(readFile(__testing.statePath(currentSession), "utf8"), /ENOENT/)
})

test("rolls back when automatic goal creation fails", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("goal_fail")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, { failGoalPatch: true })
  await assert.rejects(startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/goal-fail",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  }), /managed session goal/)
  assert.equal(await canonical(api.directory()), await canonical(primary))
  assert.equal(await git(primary, "branch", "--list", "fix/goal-fail"), "")
  await assert.rejects(readFile(__testing.statePath(currentSession), "utf8"), /ENOENT/)
})

test("does not overwrite a goal changed during the move", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("goal_race")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const fetchImpl = async (url, request = {}) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith("/experimental/control-plane/move-session")) {
      const response = await api.fetchImpl(url, request)
      const input = JSON.parse(request.body)
      if (input.destination.directory !== primary) {
        await api.fetchImpl(new URL(`/session/${currentSession}?directory=${encodeURIComponent(input.destination.directory)}`, "http://opencode.test/"), {
          method: "PATCH",
          body: JSON.stringify({ metadata: { openchamber: { goal: { id: "goal_user_changed", objective: "Changed", status: "active" } } } }),
        })
      }
      return response
    }
    return api.fetchImpl(url, request)
  }
  // 69K: start installs the goal with its worktree-moving hold before the move
  // and deliberately makes no destination-scoped metadata request afterwards
  // (that request deadlocked behind the active turn executing this tool). The
  // 52K version detected this race through that post-move patch and rolled back
  // to move-failed; the installed lifecycle instead completes the move and
  // leaves the user's replacement goal untouched. The gate in the OpenChamber
  // overlay still protects lifecycle completion later.
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/goal-race",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl,
  })
  assert.equal(state.phase, "attached")
  assert.equal((await __testing.readState(currentSession)).phase, "attached")
  assert.equal(api.metadata().openchamber.goal.id, "goal_user_changed")
})

test("refuses to replace an existing session goal", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("existing_goal")
  sessionIDs.push(currentSession)
  const existingGoal = { id: "goal_existing", objective: "Existing", status: "active" }
  const api = sessionApi(currentSession, primary, { metadata: { openchamber: { goal: existingGoal } } })
  await assert.rejects(startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/existing-goal",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  }), /already has a goal/)
  assert.deepEqual(api.metadata().openchamber.goal, existingGoal)
  assert.equal(await git(primary, "branch", "--list", "fix/existing-goal"), "")
})

test("preserves the beginning, end, and attachments from a large user request", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("large_request")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, {
    messages: [{
      info: { id: "msg_user", role: "user" },
      parts: [
        { type: "text", text: `START-${"x".repeat(4_000)}-MIDDLE-REQUIREMENT-${"y".repeat(4_000)}-END` },
        { type: "file", filename: "requirements.pdf", mime: "application/pdf" },
      ],
    }],
  })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/large-request",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  const objective = api.metadata().openchamber.goal.objective
  assert.match(objective, /START-/)
  assert.match(objective, /-END/)
  assert.match(objective, /requirements\.pdf \(application\/pdf\)/)
  assert.ok(objective.length <= 5_000)
  const persistedState = await __testing.readState(currentSession)
  assert.match(persistedState.managedGoalObjective, /START-/)
  assert.match(persistedState.managedGoalObjective, /MIDDLE-REQUIREMENT/)
  assert.match(persistedState.managedGoalObjective, /-END/)
  assert.match(persistedState.managedGoalObjective, /requirements\.pdf \(application\/pdf\)/)
  assert.match(persistedState.managedGoalObjective, /Completion criteria:/)
  assert.match(persistedState.managedGoalObjective, /session_workspace with action=finish/)
  assert.ok(persistedState.managedGoalObjective.length > 8_000)
  await git(primary, "worktree", "remove", "--force", state.worktree)
  await git(primary, "branch", "-D", state.branch)
  await rm(__testing.statePath(currentSession), { force: true })
})

test("uses only the latest user turn for the managed objective", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("latest_request")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, {
    messages: [
      { info: { id: "msg_old", role: "user" }, parts: [{ type: "text", text: "Old unrelated request" }] },
      { info: { id: "msg_assistant", role: "assistant" }, parts: [{ type: "text", text: "Old work done" }] },
      { info: { id: "msg_new", role: "user" }, parts: [{ type: "text", text: "Implement only the latest request" }] },
    ],
  })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/latest-request",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  assert.match(api.metadata().openchamber.goal.objective, /Implement only the latest request/)
  assert.doesNotMatch(api.metadata().openchamber.goal.objective, /Old unrelated request/)
  await git(primary, "worktree", "remove", "--force", state.worktree)
  await git(primary, "branch", "-D", state.branch)
  await rm(__testing.statePath(currentSession), { force: true })
})

test("retries managed goal completion after cleanup already succeeded", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("goal_retry")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/goal-retry",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  await writeFile(path.join(state.worktree, "fix.txt"), "fix\n")
  await git(state.worktree, "add", "fix.txt")
  await git(state.worktree, "commit", "-m", "Fix")
  await git(state.worktree, "push", "-u", "origin", "fix/goal-retry")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--ff-only", "origin/fix/goal-retry")
  await git(primary, "push", "origin", "main")
  api.setDevBody(HEALTHY_DEV_BODY)

  let failCompletion = true
  const fetchImpl = async (url, request = {}) => {
    const pathname = new URL(url).pathname
    if (
      failCompletion
      && pathname.endsWith(`/session/${currentSession}`)
      && request.method === "PATCH"
      && JSON.parse(request.body).metadata.openchamber.goal.status === "complete"
    ) return new Response("completion failed", { status: 500 })
    return api.fetchImpl(url, request)
  }
  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: await git(primary, "rev-parse", "origin/main") },
    inspectNonproduction: successfulWorkflow,
  }), /managed session goal/)
  assert.equal((await __testing.readState(currentSession)).phase, "goal-completion-pending")
  failCompletion = false
  const finished = await finishWorkspace({
    sessionID: currentSession,
    directory: primary,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl,
  })
  assert.equal(finished.phase, "complete")
  assert.equal(api.metadata().openchamber.goal.status, "complete")
})

test("accepts a retry after goal completion committed but its response was lost", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("goal_lost_response")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/goal-lost-response",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })
  await writeFile(path.join(state.worktree, "fix.txt"), "fix\n")
  await git(state.worktree, "add", "fix.txt")
  await git(state.worktree, "commit", "-m", "Fix")
  await git(state.worktree, "push", "-u", "origin", "fix/goal-lost-response")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--ff-only", "origin/fix/goal-lost-response")
  await git(primary, "push", "origin", "main")
  const deployedCommit = await git(primary, "rev-parse", "origin/main")
  api.setDevBody(HEALTHY_DEV_BODY)

  let loseResponse = true
  const fetchImpl = async (url, request = {}) => {
    const pathname = new URL(url).pathname
    if (
      loseResponse
      && pathname.endsWith(`/session/${currentSession}`)
      && request.method === "PATCH"
      && JSON.parse(request.body).metadata.openchamber.goal.status === "complete"
    ) {
      await api.fetchImpl(url, request)
      return new Response("lost response", { status: 503 })
    }
    return api.fetchImpl(url, request)
  }
  await assert.rejects(finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: deployedCommit },
    inspectNonproduction: successfulWorkflow,
  }), /managed session goal/)
  loseResponse = false
  const finished = await finishWorkspace({
    sessionID: currentSession,
    directory: primary,
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl,
  })
  assert.equal(finished.phase, "complete")
  assert.equal(api.metadata().openchamber.goal.managedWorktree, false)
})

test("validates branch names", () => {
  assert.equal(__testing.normalizeBranch("feat/useful-name"), "feat/useful-name")
  assert.throws(() => __testing.normalizeBranch("main"), /non-main/)
  assert.throws(() => __testing.normalizeBranch("HEAD"), /non-main/)
  assert.throws(() => __testing.normalizeBranch("bad branch"), /unsupported/)
  assert.throws(() => __testing.normalizeBranch("fix/../main"), /unsupported/)
  assert.throws(() => __testing.normalizeBranch("fix//empty"), /unsupported/)
  assert.throws(() => __testing.normalizeBranch("fix/.hidden"), /unsupported/)
  assert.throws(() => __testing.normalizeBranch("fix/name.lock"), /unsupported/)
  assert.deepEqual(__testing.normalizeDevDeployment({ target: "https://dev.example.test/health", commit: "a".repeat(40) }), {
    target: "https://dev.example.test/health",
    commit: "a".repeat(40),
  })
  assert.throws(() => __testing.normalizeDevDeployment({ target: "dev", commit: "a".repeat(40) }), /verification URL/)
})

const canonical = async (directory) => {
  const { realpath } = await import("node:fs/promises")
  return realpath(directory)
}

test("creates managed worktrees on persistent storage instead of the volatile temp root", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("test")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/persistent-root",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })

  const persistentRoot = await realpath(path.join(os.homedir(), ".local", "state", "opencode", "worktrees"))
  assert.ok(
    state.worktree.startsWith(persistentRoot + path.sep),
    `${state.worktree} is not inside the persistent managed worktree root ${persistentRoot}`,
  )

  const legacyRoot = path.join(os.tmpdir(), "opencode")
  assert.ok(
    !state.worktree.startsWith(legacyRoot + path.sep),
    `${state.worktree} is still inside the boot-purged temp root ${legacyRoot}`,
  )
})

test("restores a managed worktree directory that was erased from disk", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("test")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/erased-worktree",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })

  await writeFile(path.join(state.worktree, "work.txt"), "work\n")
  await git(state.worktree, "add", "work.txt")
  await git(state.worktree, "commit", "-m", "Work in progress")
  const head = await git(state.worktree, "rev-parse", "HEAD")

  assert.equal(await restoreMissingWorktree(state), false, "an intact worktree must not be recreated")

  await rm(state.worktree, { recursive: true, force: true })
  assert.equal(await restoreMissingWorktree(state), true, "a missing worktree must be restored")

  assert.equal(await git(state.worktree, "rev-parse", "HEAD"), head)
  assert.equal(await git(state.worktree, "branch", "--show-current"), "fix/erased-worktree")
  assert.equal(await readFile(path.join(state.worktree, "work.txt"), "utf8"), "work\n")
})

test("repairs a worktree erased mid-run when the next turn begins", async () => {
  const { primary } = await createRepository()
  const currentSession = sessionID("test")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "fix/midrun-erasure",
    serverUrl: new URL("http://opencode.test/"),
    fetchImpl: api.fetchImpl,
  })

  await rm(state.worktree, { recursive: true, force: true })
  assert.equal(await restoreSessionWorktreeIfMissing({ sessionID: currentSession }), true)
  assert.equal(await git(state.worktree, "branch", "--show-current"), "fix/midrun-erasure")

  assert.equal(
    await restoreSessionWorktreeIfMissing({ sessionID: currentSession }),
    false,
    "an intact worktree must not be recreated",
  )
})

test("does not try to repair a session that has no managed worktree", async () => {
  assert.equal(await restoreSessionWorktreeIfMissing({ sessionID: sessionID("absent") }), false)
})

// ---------------------------------------------------------------------------
// OPM handoff: submit, finish delegation, and start --issue claim-and-pair.
// The control server and `gh` are stubbed; Git operations run against real
// temporary repositories exactly like the finish tests above.
// ---------------------------------------------------------------------------

const OPM_URL = "http://opm.test/"
const GH_REPO = "https://github.com/owner/repo"
const OPM_SERVER = new URL("http://opencode.test/")

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
})

const managedProject = (primary, overrides = {}) => ({
  slug: "demo",
  rootPath: primary,
  enabled: true,
  readyLabel: "opm:ready",
  claimedLabel: "opm:claimed",
  defaultBranch: "main",
  titleAlias: "Demo",
  ...overrides,
})

const withOpm = (fetchImpl, options = {}) => {
  const opm = {
    requests: [],
    projects: options.projects ?? [],
    capabilities: options.capabilities ?? ["projects", "branch-adoption", "attended-claim", "kick"],
    activity: options.activity ?? { active: [], queued: [], blockers: [] },
    reachable: options.reachable ?? true,
    statusReachable: options.statusReachable ?? true,
  }
  opm.fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url)
    if (parsed.origin !== "http://opm.test") return fetchImpl(url, request)
    opm.requests.push({ pathname: parsed.pathname, method: request.method ?? "GET" })
    if (!opm.reachable) throw new TypeError("fetch failed")
    if (parsed.pathname === "/projects") return jsonResponse({ projects: opm.projects })
    if (parsed.pathname === "/status") {
      return opm.statusReachable
        ? jsonResponse({ ok: true, capabilities: opm.capabilities })
        : new Response("down", { status: 503 })
    }
    if (parsed.pathname === "/kick") return jsonResponse({ ok: true })
    if (parsed.pathname === "/activity") return jsonResponse(typeof opm.activity === "function" ? opm.activity() : opm.activity)
    return new Response("not found", { status: 404 })
  }
  opm.calls = (pathname) => opm.requests.filter((request) => request.pathname === pathname)
  return opm
}

const flagValue = (args, flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const ghStub = (options = {}) => {
  const calls = []
  const state = {
    openPullRequests: structuredClone(options.openPullRequests ?? []),
    issues: new Map(Object.entries(options.issues ?? {}).map(([number, issue]) => [Number(number), structuredClone(issue)])),
    labels: options.labels ?? ["opm:ready", "opm:docs", "opm:chore", "opm:fix", "opm:claimed", "opm:urgent"],
    nextIssue: options.nextIssue ?? 42,
    nextPull: options.nextPull ?? 7,
  }
  const ghImpl = async (args, context) => {
    calls.push({ args, cwd: context?.cwd })
    await options.onCall?.(args, context)
    const key = `${args[0]} ${args[1]}`
    if (options.fail?.[key]) throw new Error(`gh ${key} failed: stubbed`)
    switch (key) {
      case "pr list":
        return JSON.stringify(state.openPullRequests
          .filter((pull) => pull.head === flagValue(args, "--head"))
          .map(({ number, url }) => ({ number, url })))
      case "pr create": {
        const number = state.nextPull++
        const url = `${GH_REPO}/pull/${number}`
        state.openPullRequests.push({ number, url, head: flagValue(args, "--head"), title: flagValue(args, "--title"), body: flagValue(args, "--body") })
        return url
      }
      case "pr edit": {
        const pull = state.openPullRequests.find((candidate) => candidate.url === args[2])
        if (!pull) throw new Error("gh pr edit failed: not found")
        pull.body = flagValue(args, "--body")
        return ""
      }
      case "label list":
        return JSON.stringify(state.labels.map((name) => ({ name })))
      case "issue list": {
        const search = flagValue(args, "--search")
        return JSON.stringify([...state.issues.entries()]
          .filter(([, issue]) => issue.state === "OPEN" && issue.body.includes(search))
          .map(([number, issue]) => ({ number, body: issue.body, url: `${GH_REPO}/issues/${number}` })))
      }
      case "issue view": {
        const number = Number(args[2])
        const issue = state.issues.get(number)
        if (!issue) throw new Error("gh issue view failed: not found")
        return JSON.stringify({ number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((name) => ({ name })), url: `${GH_REPO}/issues/${number}` })
      }
      case "issue create": {
        const number = state.nextIssue++
        state.issues.set(number, {
          title: flagValue(args, "--title"),
          body: flagValue(args, "--body"),
          state: "OPEN",
          labels: String(flagValue(args, "--label") || "").split(",").filter(Boolean),
        })
        return `${GH_REPO}/issues/${number}`
      }
      case "issue edit": {
        const number = Number(args[2])
        const issue = state.issues.get(number)
        if (!issue) throw new Error("gh issue edit failed: not found")
        const body = flagValue(args, "--body")
        if (body !== undefined) issue.body = body
        const added = flagValue(args, "--add-label")
        if (added) for (const label of added.split(",")) if (!issue.labels.includes(label)) issue.labels.push(label)
        const removed = flagValue(args, "--remove-label")
        if (removed) issue.labels = issue.labels.filter((label) => !removed.split(",").includes(label))
        return ""
      }
      default:
        throw new Error(`unexpected gh call: ${args.join(" ")}`)
    }
  }
  return {
    ghImpl,
    calls,
    state,
    callsFor: (key) => calls.filter((call) => `${call.args[0]} ${call.args[1]}` === key),
  }
}

const startManaged = async ({ branch, issue, userRequest, opmOptions = {}, ghOptions = {}, unmanaged = false } = {}) => {
  const { primary, remote } = await createRepository()
  const currentSession = sessionID("opm")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, { userRequest })
  const opm = withOpm(api.fetchImpl, {
    projects: unmanaged ? [managedProject(path.join(primary, "elsewhere"))] : [managedProject(primary)],
    ...opmOptions,
  })
  const gh = ghStub(ghOptions)
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch,
    issue,
    serverUrl: OPM_SERVER,
    fetchImpl: opm.fetchImpl,
    opmControlUrl: OPM_URL,
    ghImpl: gh.ghImpl,
  })
  return { primary, remote, currentSession, api, opm, gh, state }
}

const submitOptions = (context, extra = {}) => ({
  sessionID: context.currentSession,
  directory: context.state.worktree,
  serverUrl: OPM_SERVER,
  fetchImpl: context.opm.fetchImpl,
  opmControlUrl: OPM_URL,
  ghImpl: context.gh.ghImpl,
  admissionTimeoutMs: 40,
  admissionPollMs: 5,
  ...extra,
})

const opmConfigFile = () => __testing.opmConfigPath()

test("detects OPM-managed repositories from the control server, the config fallback, or fails closed", async () => {
  const { primary } = await createRepository()
  const canonicalPrimary = await canonical(primary)
  const api = sessionApi(sessionID("detect"), primary)
  const opm = withOpm(api.fetchImpl, { projects: [managedProject(primary, { slug: "live" })] })

  const live = await __testing.resolveOpmProject({ primary: canonicalPrimary, fetchImpl: opm.fetchImpl, opmControlUrl: OPM_URL })
  assert.equal(live.source, "control-server")
  assert.equal(live.project.slug, "live")
  assert.equal(live.project.claimedLabel, "opm:claimed")

  opm.projects = [managedProject(primary, { slug: "off", enabled: false })]
  assert.equal((await __testing.resolveOpmProject({ primary: canonicalPrimary, fetchImpl: opm.fetchImpl, opmControlUrl: OPM_URL })).project, null)

  opm.reachable = false
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(opmConfigFile()), { recursive: true }))
  await writeFile(opmConfigFile(), JSON.stringify({
    projects: [
      { slug: "disabled", rootPath: primary, enabled: false },
      { slug: "from-config", rootPath: primary, providerConfig: { readyLabel: "ready:custom", defaultBranch: "trunk" } },
    ],
  }))
  try {
    const fallback = await __testing.resolveOpmProject({ primary: canonicalPrimary, fetchImpl: opm.fetchImpl, opmControlUrl: OPM_URL })
    assert.equal(fallback.source, "config")
    assert.equal(fallback.project.slug, "from-config")
    assert.equal(fallback.project.readyLabel, "ready:custom")
    assert.equal(fallback.project.defaultBranch, "trunk")
    assert.equal(fallback.project.claimedLabel, "opm:claimed")
  } finally {
    await rm(opmConfigFile(), { force: true })
  }

  await assert.rejects(
    __testing.resolveOpmProject({ primary: canonicalPrimary, fetchImpl: opm.fetchImpl, opmControlUrl: OPM_URL }),
    /cannot determine whether this repository is OPM-managed/,
  )
})

test("submit refuses unmanaged repositories and missing OPM capabilities", async () => {
  const unmanaged = await startManaged({ branch: "feat/unmanaged-submit", unmanaged: true })
  await assert.rejects(submitWorkspace(submitOptions(unmanaged)), /not OPM-managed; use finish/)
  assert.equal(unmanaged.api.directory(), unmanaged.state.worktree)

  const missing = await startManaged({ branch: "feat/no-capability", opmOptions: { capabilities: ["projects", "kick"] } })
  await assert.rejects(submitWorkspace(submitOptions(missing)), /required capability: branch-adoption/)
  assert.equal(missing.gh.calls.length, 0)
  assert.equal(missing.api.directory(), missing.state.worktree)

  const down = await startManaged({ branch: "feat/status-down", opmOptions: { statusReachable: false } })
  await assert.rejects(submitWorkspace(submitOptions(down)), /status is unavailable/)

  const claimOnly = await startManaged({ branch: "feat/attended-missing", opmOptions: { capabilities: ["branch-adoption"] } })
  await assert.rejects(submitWorkspace(submitOptions(claimOnly, { issue: 9 })), /required capability: attended-claim/)
})

test("submit commits dirty work, pushes, opens the PR, files the tracking issue, and hands off", async () => {
  const context = await startManaged({
    branch: "feat/handoff",
    userRequest: "Add the handoff feature\n\nMore detail about what the owner wants.",
    opmOptions: { activity: { active: [], queued: [{ project: "demo", ref: "42" }], blockers: [] } },
  })
  const { primary, currentSession, api, opm, gh, state } = context
  assert.match(api.metadata().openchamber.goal.objective, /action=submit/)
  assert.doesNotMatch(api.metadata().openchamber.goal.objective, /merge it into origin\/main/)
  await writeFile(path.join(state.worktree, "src.txt"), "feature\n")

  const finished = await submitWorkspace(submitOptions(context))

  assert.equal(finished.phase, "complete")
  assert.equal(finished.outcome, "submitted")
  assert.match(finished.summary, /^Submitted as demo#42 \(https:\/\/github\.com\/owner\/repo\/pull\/7\)\./)
  assert.match(finished.summary, /admission observed \(queued\)/)
  assert.deepEqual(
    { slug: finished.submission.slug, ref: finished.submission.ref, pr: finished.submission.pr, admissionVerified: finished.submission.admissionVerified, class: finished.submission.class },
    { slug: "demo", ref: 42, pr: `${GH_REPO}/pull/7`, admissionVerified: true, class: "feature" },
  )

  const remoteHead = await git(primary, "rev-parse", "origin/feat/handoff")
  assert.equal(remoteHead, finished.head)
  assert.equal(await git(primary, "log", "-1", "--format=%s", "origin/feat/handoff"), "Add the handoff feature")
  assert.equal(await git(primary, "branch", "--list", "feat/handoff"), "")
  assert.equal(await git(primary, "worktree", "list", "--porcelain").then((output) => output.includes(state.worktree)), false)
  assert.equal(await canonical(api.directory()), await canonical(primary))

  const [pullCreate] = gh.callsFor("pr create")
  assert.equal(flagValue(pullCreate.args, "--head"), "feat/handoff")
  assert.equal(flagValue(pullCreate.args, "--base"), "main")
  assert.equal(flagValue(pullCreate.args, "--title"), "Add the handoff feature")
  assert.doesNotMatch(flagValue(pullCreate.args, "--body"), /\b(closes|fixes|resolves)\b/i)
  const [pullEdit] = gh.callsFor("pr edit")
  assert.match(flagValue(pullEdit.args, "--body"), /^Refs #42\n/)

  const issueCreates = gh.callsFor("issue create")
  assert.equal(issueCreates.length, 1)
  assert.equal(flagValue(issueCreates[0].args, "--label"), "opm:ready")
  assert.equal(flagValue(issueCreates[0].args, "--title"), "Add the handoff feature")
  const body = flagValue(issueCreates[0].args, "--body")
  assert.ok(body.includes(`<!-- opm:branch feat/handoff@${remoteHead} -->`), body)
  assert.ok(body.includes(`Change: ${GH_REPO}/pull/7`), body)
  assert.match(body, /^Add the handoff feature\n\nMore detail/)
  assert.doesNotMatch(body, /Completion criteria/)
  const order = gh.calls.map((call) => `${call.args[0]} ${call.args[1]}`)
  assert.ok(order.indexOf("pr create") < order.indexOf("issue create"), "the pull request exists before the tracking issue links to it")
  assert.ok(order.indexOf("issue create") < order.indexOf("pr edit"), "the pull request body gains Refs #N only once the issue number is known")

  assert.equal(opm.calls("/kick").length, 1)
  assert.equal(opm.calls("/kick")[0].method, "POST")
  assert.ok(opm.calls("/activity").length >= 1)

  const goal = api.metadata().openchamber.goal
  assert.equal(goal.status, "complete")
  assert.equal(goal.managedWorktree, false)
  assert.equal(goal.statusReason, "submitted to OPM")
  assert.equal(goal.note, `submitted as demo#42 (${GH_REPO}/pull/7)`)
  assert.deepEqual(goal.opm, { slug: "demo", ref: 42, pr: `${GH_REPO}/pull/7`, admissionVerified: true })

  assert.ok(await __testing.readSubmitJournal(currentSession))
  await assert.rejects(assertSessionWorkspaceReady({ sessionID: currentSession }), /Stop this turn/)
  await acknowledgeSessionTurn(currentSession)
  assert.equal(await __testing.readSubmitJournal(currentSession), null)
  await assert.rejects(readFile(__testing.statePath(currentSession), "utf8"), /ENOENT/)
})

test("submit records unobserved admission without failing the handoff", async () => {
  const context = await startManaged({ branch: "feat/unobserved", userRequest: "Unobserved handoff" })
  await writeFile(path.join(context.state.worktree, "a.txt"), "a\n")
  const finished = await submitWorkspace(submitOptions(context))
  assert.equal(finished.submission.admissionVerified, false)
  assert.equal(finished.submission.admissionState, "unobserved")
  assert.match(finished.summary, /^Submitted as demo#42 /)
  assert.match(finished.summary, /not observed/)
  assert.equal(context.api.metadata().openchamber.goal.opm.admissionVerified, false)
})

test("submit reuses an open pull request and an issue that already carries the branch marker", async () => {
  const staleHead = "b".repeat(40)
  const context = await startManaged({
    branch: "feat/reuse",
    userRequest: "Reuse existing records",
    ghOptions: {
      openPullRequests: [{ number: 3, url: `${GH_REPO}/pull/3`, head: "feat/reuse" }],
      issues: { 17: { title: "Existing", body: `Owner text\n\n<!-- opm:branch feat/reuse@${staleHead} -->\n`, state: "OPEN", labels: ["opm:ready"] } },
    },
  })
  await writeFile(path.join(context.state.worktree, "b.txt"), "b\n")
  await git(context.state.worktree, "add", "b.txt")
  await git(context.state.worktree, "commit", "-m", "Reuse")

  const finished = await submitWorkspace(submitOptions(context))
  assert.equal(finished.submission.ref, 17)
  assert.equal(finished.submission.pr, `${GH_REPO}/pull/3`)
  assert.equal(context.gh.callsFor("pr create").length, 0)
  assert.equal(context.gh.callsFor("pr edit").length, 0)
  assert.equal(context.gh.callsFor("issue create").length, 0)
  const issue = context.gh.state.issues.get(17)
  const markers = __testing.parseBranchMarkers(issue.body)
  assert.deepEqual(markers.map((marker) => [marker.branch, marker.head]), [["feat/reuse", finished.head]])
  assert.ok(issue.body.includes(`Change: ${GH_REPO}/pull/3`))
  assert.deepEqual(issue.labels, ["opm:ready"])
})

test("submit resumes from its intent journal without filing a second issue", async () => {
  const context = await startManaged({ branch: "feat/journal", userRequest: "Journal resume" })
  const { primary, currentSession, api, gh, state } = context
  const peerSession = sessionID("journal_peer")
  api.addSession({ id: peerSession, directory: state.worktree })
  api.setSessionStatus(peerSession, { type: "busy" })
  await writeFile(path.join(state.worktree, "j.txt"), "j\n")

  await assert.rejects(submitWorkspace(submitOptions(context)), new RegExp(`other sessions are active: ${peerSession}`))
  assert.equal(gh.callsFor("issue create").length, 1)
  const journal = await __testing.readSubmitJournal(currentSession)
  assert.equal(journal.branch, "feat/journal")
  assert.equal(journal.issue, 42)
  assert.equal(journal.pr, `${GH_REPO}/pull/7`)
  assert.equal(journal.headSha, await git(state.worktree, "rev-parse", "HEAD"))
  assert.equal(api.directory(), state.worktree)
  const persisted = await __testing.readState(currentSession)
  assert.equal(persisted.submission.ref, 42)
  assert.equal(persisted.returnPrepared, true)
  assert.equal(persisted.submitting, true)
  await assert.rejects(assertSessionWorkspaceReady({ sessionID: currentSession }), /action=submit again/)

  api.setSessionStatus(peerSession, { type: "idle" })
  const finished = await submitWorkspace(submitOptions(context))
  assert.equal(finished.outcome, "submitted")
  assert.equal(finished.submission.ref, 42)
  assert.equal(gh.callsFor("issue create").length, 1)
  assert.equal(gh.callsFor("pr create").length, 1)
  assert.equal(await canonical(api.sessionDirectory(peerSession)), await canonical(primary))
})

test("submit reuses a pre-written journal issue instead of searching or creating", async () => {
  const context = await startManaged({
    branch: "feat/journal-known",
    userRequest: "Known journal issue",
    ghOptions: { issues: { 31: { title: "Known", body: "Body", state: "OPEN", labels: [] } } },
  })
  await writeFile(path.join(context.state.worktree, "k.txt"), "k\n")
  await __testing.writeSubmitJournal(context.currentSession, { branch: "feat/journal-known", headSha: "0".repeat(40), title: "Journaled title", issue: 31, createdAt: 1 })

  const finished = await submitWorkspace(submitOptions(context))
  assert.equal(finished.submission.ref, 31)
  assert.equal(finished.submission.title, "Journaled title")
  assert.equal(context.gh.callsFor("issue create").length, 0)
  assert.equal(context.gh.callsFor("issue list").length, 0)
  const issue = context.gh.state.issues.get(31)
  assert.ok(issue.body.includes(`<!-- opm:branch feat/journal-known@${finished.head} -->`))
  assert.deepEqual(issue.labels, ["opm:ready"])
  assert.equal(await git(context.primary, "log", "-1", "--format=%s", "origin/feat/journal-known"), "Journaled title")
})

test("submit refuses to reuse an issue that already names a different branch", async () => {
  const context = await startManaged({
    branch: "feat/mine",
    userRequest: "Conflicting issue",
    ghOptions: { issues: { 5: { title: "Taken", body: `<!-- opm:branch feat/other@${"c".repeat(40)} -->`, state: "OPEN", labels: ["opm:ready"] } } },
  })
  await writeFile(path.join(context.state.worktree, "m.txt"), "m\n")
  await assert.rejects(submitWorkspace(submitOptions(context, { issue: 5 })), /issue #5 already carries a branch marker for feat\/other/)
  assert.equal(context.gh.callsFor("issue create").length, 0)
  assert.equal(context.gh.callsFor("issue edit").length, 0)
  assert.equal(context.api.directory(), context.state.worktree)
  assert.equal((await __testing.readState(context.currentSession)).submission, undefined)
})

test("submit infers the docs class from Markdown-only changes and honors explicit class and urgent", async () => {
  const docs = await startManaged({ branch: "docs/only", userRequest: "Document the thing" })
  await writeFile(path.join(docs.state.worktree, "README.md"), "updated\n")
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(docs.state.worktree, "docs"), { recursive: true }))
  await writeFile(path.join(docs.state.worktree, "docs", "guide.md"), "guide\n")
  const docsResult = await submitWorkspace(submitOptions(docs))
  assert.equal(docsResult.submission.class, "docs")
  assert.equal(flagValue(docs.gh.callsFor("issue create")[0].args, "--label"), "opm:ready,opm:docs")

  const fix = await startManaged({ branch: "fix/explicit", userRequest: "Fix the thing", ghOptions: { labels: ["opm:ready", "opm:fix"] } })
  await writeFile(path.join(fix.state.worktree, "README.md"), "changed\n")
  const fixResult = await submitWorkspace(submitOptions(fix, { class: "fix", urgent: true }))
  assert.equal(fixResult.submission.class, "fix")
  assert.equal(flagValue(fix.gh.callsFor("issue create")[0].args, "--label"), "opm:ready,opm:fix", "opm:urgent is skipped when the repository lacks it")

  const urgent = await startManaged({ branch: "feat/urgent", userRequest: "Urgent thing" })
  await writeFile(path.join(urgent.state.worktree, "code.txt"), "code\n")
  const urgentResult = await submitWorkspace(submitOptions(urgent, { urgent: true }))
  assert.equal(urgentResult.submission.class, "feature")
  assert.equal(flagValue(urgent.gh.callsFor("issue create")[0].args, "--label"), "opm:ready,opm:urgent")
})

test("submit refuses when there is nothing to hand off", async () => {
  const context = await startManaged({ branch: "feat/empty", userRequest: "Nothing yet" })
  await assert.rejects(submitWorkspace(submitOptions(context)), /nothing to submit/)
  assert.equal(context.gh.callsFor("pr create").length, 0)
  assert.equal(context.api.directory(), context.state.worktree)
})

test("finish delegates to submit on OPM-managed repositories", async () => {
  const context = await startManaged({ branch: "feat/finish-delegates", userRequest: "Finish should submit" })
  await writeFile(path.join(context.state.worktree, "f.txt"), "f\n")
  await git(context.state.worktree, "add", "f.txt")
  await git(context.state.worktree, "commit", "-m", "Finish work")

  const finished = await finishWorkspace({
    sessionID: context.currentSession,
    directory: context.state.worktree,
    serverUrl: OPM_SERVER,
    fetchImpl: context.opm.fetchImpl,
    opmControlUrl: OPM_URL,
    ghImpl: context.gh.ghImpl,
    admissionTimeoutMs: 40,
    admissionPollMs: 5,
  })
  assert.equal(finished.outcome, "submitted")
  assert.match(finished.summary, /^Submitted as demo#42 /)
  assert.equal(context.gh.callsFor("issue create").length, 1)
  assert.equal(await git(context.primary, "rev-parse", "origin/feat/finish-delegates"), finished.head)
  assert.equal(context.api.metadata().openchamber.goal.statusReason, "submitted to OPM")
  assert.equal(await canonical(context.api.directory()), await canonical(context.primary))
})

test("finish keeps the local merge contract on unmanaged repositories and warns when detection fails", async () => {
  const unmanaged = await startManaged({ branch: "feat/unmanaged-finish", unmanaged: true })
  assert.match(unmanaged.api.metadata().openchamber.goal.objective, /action=finish/)
  await writeFile(path.join(unmanaged.state.worktree, "u.txt"), "u\n")
  await git(unmanaged.state.worktree, "add", "u.txt")
  await git(unmanaged.state.worktree, "commit", "-m", "Unmanaged")
  await assert.rejects(finishWorkspace({
    sessionID: unmanaged.currentSession,
    directory: unmanaged.state.worktree,
    serverUrl: OPM_SERVER,
    fetchImpl: unmanaged.opm.fetchImpl,
    opmControlUrl: OPM_URL,
    ghImpl: unmanaged.gh.ghImpl,
  }), /dev verification URL/)
  assert.equal(unmanaged.gh.calls.length, 0)

  const { primary } = await createRepository()
  const currentSession = sessionID("detect_fail")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const opm = withOpm(api.fetchImpl, { reachable: false })
  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/detect-fail",
    serverUrl: OPM_SERVER,
    fetchImpl: opm.fetchImpl,
    opmControlUrl: OPM_URL,
  })
  await writeFile(path.join(state.worktree, "d.txt"), "d\n")
  await git(state.worktree, "add", "d.txt")
  await git(state.worktree, "commit", "-m", "Detect fail")
  await git(state.worktree, "push", "-u", "origin", "feat/detect-fail")
  await git(primary, "fetch", "origin")
  await git(primary, "merge", "--ff-only", "origin/feat/detect-fail")
  await git(primary, "push", "origin", "main")
  const deployedCommit = await git(primary, "rev-parse", "origin/main")
  api.setDevBody(HEALTHY_DEV_BODY)
  const finished = await finishWorkspace({
    sessionID: currentSession,
    directory: state.worktree,
    serverUrl: OPM_SERVER,
    fetchImpl: opm.fetchImpl,
    opmControlUrl: OPM_URL,
    devDeployment: { target: "http://opencode.test/dev-smoke", commit: deployedCommit },
    inspectNonproduction: successfulWorkflow,
  })
  assert.equal(finished.phase, "complete")
  assert.equal(finished.outcome, undefined)
  assert.match(finished.finishWarning, /^Warning: cannot determine whether this repository is OPM-managed/)
  assert.equal(api.metadata().openchamber.goal.statusReason, "worktree lifecycle complete")
})

test("start --issue claims the OPM issue before creating the worktree and seeds the goal from it", async () => {
  let worktreesAtClaim = null
  let claimPrimary = null
  const context = await startManaged({
    issue: 12,
    ghOptions: {
      issues: { 12: { title: "Version the Mac mini headless service bundle", body: "Pin every launchd bundle.\n\nAcceptance: versions listed.", state: "OPEN", labels: ["opm:ready"] } },
      onCall: async (args, options) => {
        if (args[0] === "issue" && args[1] === "edit") {
          worktreesAtClaim = (await git(options.cwd, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length
          claimPrimary = options.cwd
        }
      },
    },
  })
  const { api, opm, gh, state, primary } = context
  assert.equal(state.branch, "claim/12-version-the-mac-mini-headless-s")
  assert.ok(state.branch.length <= 40)
  assert.equal(await git(state.worktree, "branch", "--show-current"), state.branch)
  assert.equal(await git(state.worktree, "rev-parse", "HEAD"), await git(primary, "rev-parse", "origin/main"))

  const claims = gh.callsFor("issue edit")
  assert.equal(claims.length, 1)
  assert.equal(claims[0].args[2], "12")
  assert.equal(flagValue(claims[0].args, "--add-label"), "opm:claimed")
  assert.equal(worktreesAtClaim, 1, "the claim label must be added before the managed worktree exists")
  assert.equal(await canonical(claimPrimary), await canonical(primary))
  assert.deepEqual(gh.state.issues.get(12).labels, ["opm:ready", "opm:claimed"])

  const goal = api.metadata().openchamber.goal
  assert.match(goal.objective, /Version the Mac mini headless service bundle/)
  assert.match(goal.objective, /Pin every launchd bundle/)
  assert.match(goal.objective, /\(GitHub issue #12\)/)
  assert.match(goal.objective, /action=submit/)
  assert.deepEqual(goal.opm, { slug: "demo", ref: 12, claimed: true })
  assert.deepEqual(state.opm, { slug: "demo", ref: 12, claimed: true })
  assert.deepEqual((await __testing.readState(context.currentSession)).opm, { slug: "demo", ref: 12, claimed: true })
  assert.equal(opm.calls("/kick").length, 1)
  assert.equal(__testing.extractGoalRequest((await __testing.readState(context.currentSession)).managedGoalObjective).split("\n")[0], "Version the Mac mini headless service bundle")

  await writeFile(path.join(state.worktree, "bundle.txt"), "versioned\n")
  const finished = await submitWorkspace(submitOptions(context))
  assert.equal(finished.submission.ref, 12, "a claimed session submits back to its paired issue")
  assert.equal(finished.submission.title, "Version the Mac mini headless service bundle")
  assert.equal(gh.callsFor("issue create").length, 0)
  const [pullCreate] = gh.callsFor("pr create")
  assert.match(flagValue(pullCreate.args, "--body"), /^Refs #12\n/)
  assert.ok(gh.state.issues.get(12).body.includes(`<!-- opm:branch ${state.branch}@${finished.head} -->`))
  const release = gh.callsFor("issue edit").at(-1)
  assert.equal(flagValue(release.args, "--remove-label"), "opm:claimed", "a submitted claim is released to the pipeline")
  assert.deepEqual(gh.state.issues.get(12).labels, ["opm:ready"])
})

test("start --issue adopts the branch an issue already names and rejects a conflicting branch", async () => {
  const { primary } = await createRepository()
  await git(primary, "branch", "feat/adopted", "origin/main")
  await git(primary, "switch", "feat/adopted")
  await writeFile(path.join(primary, "adopted.txt"), "adopted\n")
  await git(primary, "add", "adopted.txt")
  await git(primary, "commit", "-m", "Adopted work")
  await git(primary, "push", "-u", "origin", "feat/adopted")
  const adoptedHead = await git(primary, "rev-parse", "HEAD")
  await git(primary, "switch", "main")
  await git(primary, "branch", "-D", "feat/adopted")

  const currentSession = sessionID("adopt")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary)
  const opm = withOpm(api.fetchImpl, { projects: [managedProject(primary)] })
  const gh = ghStub({ issues: { 8: { title: "Adopt me", body: `Work in progress\n\n<!-- opm:branch feat/adopted@${adoptedHead} -->`, state: "OPEN", labels: [] } } })

  await assert.rejects(startWorkspace({
    sessionID: currentSession,
    directory: primary,
    branch: "feat/something-else",
    issue: 8,
    serverUrl: OPM_SERVER,
    fetchImpl: opm.fetchImpl,
    opmControlUrl: OPM_URL,
    ghImpl: gh.ghImpl,
  }), /already names branch feat\/adopted/)
  assert.equal(gh.callsFor("issue edit").length, 0)

  const state = await startWorkspace({
    sessionID: currentSession,
    directory: primary,
    issue: 8,
    serverUrl: OPM_SERVER,
    fetchImpl: opm.fetchImpl,
    opmControlUrl: OPM_URL,
    ghImpl: gh.ghImpl,
  })
  assert.equal(state.branch, "feat/adopted")
  assert.equal(await git(state.worktree, "branch", "--show-current"), "feat/adopted")
  assert.equal(await git(state.worktree, "rev-parse", "HEAD"), adoptedHead)
  assert.equal(await readFile(path.join(state.worktree, "adopted.txt"), "utf8"), "adopted\n")
  assert.deepEqual(gh.state.issues.get(8).labels, ["opm:claimed"])
})

test("start --issue fails closed on closed issues, missing capability, and releases a claim after a failed move", async () => {
  const closed = await createRepository()
  const closedSession = sessionID("closed_issue")
  sessionIDs.push(closedSession)
  const closedApi = sessionApi(closedSession, closed.primary)
  const closedOpm = withOpm(closedApi.fetchImpl, { projects: [managedProject(closed.primary)] })
  const closedGh = ghStub({ issues: { 3: { title: "Done", body: "", state: "CLOSED", labels: [] } } })
  await assert.rejects(startWorkspace({
    sessionID: closedSession, directory: closed.primary, issue: 3, serverUrl: OPM_SERVER, fetchImpl: closedOpm.fetchImpl, opmControlUrl: OPM_URL, ghImpl: closedGh.ghImpl,
  }), /issue #3 is not open/)

  const noClaimOpm = withOpm(closedApi.fetchImpl, { projects: [managedProject(closed.primary)], capabilities: ["branch-adoption"] })
  const noClaimGh = ghStub({ issues: { 4: { title: "Open", body: "", state: "OPEN", labels: [] } } })
  await assert.rejects(startWorkspace({
    sessionID: closedSession, directory: closed.primary, issue: 4, serverUrl: OPM_SERVER, fetchImpl: noClaimOpm.fetchImpl, opmControlUrl: OPM_URL, ghImpl: noClaimGh.ghImpl,
  }), /required capability: attended-claim/)
  assert.equal(noClaimGh.calls.length, 0)

  const { primary } = await createRepository()
  const currentSession = sessionID("claim_rollback")
  sessionIDs.push(currentSession)
  const api = sessionApi(currentSession, primary, { failMoveAt: 1 })
  const opm = withOpm(api.fetchImpl, { projects: [managedProject(primary)] })
  const gh = ghStub({ issues: { 6: { title: "Roll back", body: "", state: "OPEN", labels: ["opm:ready"] } } })
  await assert.rejects(startWorkspace({
    sessionID: currentSession, directory: primary, issue: 6, serverUrl: OPM_SERVER, fetchImpl: opm.fetchImpl, opmControlUrl: OPM_URL, ghImpl: gh.ghImpl,
  }), /session move failed/)
  const edits = gh.callsFor("issue edit")
  assert.equal(flagValue(edits[0].args, "--add-label"), "opm:claimed")
  assert.equal(flagValue(edits.at(-1).args, "--remove-label"), "opm:claimed")
  assert.deepEqual(gh.state.issues.get(6).labels, ["opm:ready"])
  assert.equal(await git(primary, "branch", "--list", "claim/6-roll-back"), "")
  await assert.rejects(readFile(__testing.statePath(currentSession), "utf8"), /ENOENT/)
})

test("submit helpers derive titles, classes, branches, and markers deterministically", () => {
  assert.equal(__testing.inferChangeClass(["README.md", "docs/guide.md", "notes/Other.MD"]), "docs")
  assert.equal(__testing.inferChangeClass(["README.md", "src/index.js"]), "feature")
  assert.equal(__testing.inferChangeClass([]), "feature")
  assert.equal(__testing.deriveIssueBranch(127, "Version the Mac mini headless service bundle"), "claim/127-version-the-mac-mini-headless")
  assert.equal(__testing.deriveIssueBranch(7, "  Fix: crash!!  "), "claim/7-fix-crash")
  assert.ok(!__testing.deriveIssueBranch(7, "anything").startsWith("opm/"), "claim branches must never look like OPM worker branches")
  assert.ok(__testing.deriveIssueBranch(99999, "x".repeat(200)).length <= 40)
  const marker = __testing.formatBranchMarker("feat/x", "a".repeat(40))
  assert.equal(marker, `<!-- opm:branch feat/x@${"a".repeat(40)} -->`)
  assert.deepEqual(__testing.parseBranchMarkers(`before\n${marker}\nafter`).map((entry) => [entry.branch, entry.head]), [["feat/x", "a".repeat(40)]])
  assert.deepEqual(__testing.parseBranchMarkers("<!-- opm:branch feat/x@short -->"), [])
  const objective = __testing.buildManagedGoalObjective("# Heading title\n\nBody line", 5_000, "submit")
  assert.equal(__testing.extractGoalRequest(objective), "# Heading title\n\nBody line")
  assert.equal(__testing.normalizeSubmitTitle(undefined, __testing.extractGoalRequest(objective)), "Heading title")
  assert.equal(__testing.normalizeSubmitTitle("  Explicit\ttitle  ", "ignored"), "Explicit title")
  assert.equal(__testing.normalizeSubmitTitle("x".repeat(200), "").length, 120)
  assert.throws(() => __testing.normalizeSubmitTitle("", "   "), /requires a title/)
})

test("wait and abandon keep working beside submit, which refuses to run during either", async () => {
  const context = await startManaged({ branch: "feat/wait-then-abandon", userRequest: "Wait, then abandon" })
  const { api, opm, state, currentSession, primary } = context

  await waitForExternal({ sessionID: currentSession, directory: state.worktree, reason: "waiting for CI", serverUrl: OPM_SERVER, fetchImpl: opm.fetchImpl })
  assert.equal(api.metadata().openchamber.goal.status, "blocked")
  assert.equal(api.metadata().openchamber.goal.statusReason, "waiting_external")
  assert.equal((await __testing.readState(currentSession)).waitingExternal, true)
  await assert.rejects(assertSessionWorkspaceReady({ sessionID: currentSession }), /external bridge wakeup/)
  await assert.rejects(submitWorkspace(submitOptions(context)), /waiting for an external wake/)
  assert.equal(context.gh.calls.length, 0)

  assert.equal(await resumeWorkspaceFromExternalWait({ sessionID: currentSession, serverUrl: OPM_SERVER, fetchImpl: opm.fetchImpl }), true)
  assert.equal(api.metadata().openchamber.goal.status, "active")
  assert.equal(api.metadata().openchamber.goal.statusReason, "external wake admitted")
  await assertSessionWorkspaceReady({ sessionID: currentSession })

  await writeFile(path.join(state.worktree, "unpublished.txt"), "local only\n")
  await git(state.worktree, "add", "unpublished.txt")
  await git(state.worktree, "commit", "-m", "Unpublished")
  await assert.rejects(abandonWorkspace({
    sessionID: currentSession, directory: state.worktree, serverUrl: OPM_SERVER, fetchImpl: opm.fetchImpl,
  }), /discard unpublished changes/)
  assert.equal(api.directory(), state.worktree)

  const abandoned = await abandonWorkspace({
    sessionID: currentSession, directory: state.worktree, serverUrl: OPM_SERVER, fetchImpl: opm.fetchImpl, confirmDiscardUnpublished: true,
  })
  assert.equal(abandoned.outcome, "cancelled")
  assert.equal(api.metadata().openchamber.goal.status, "cancelled")
  assert.equal(api.metadata().openchamber.goal.managedWorktree, false)
  assert.equal(await canonical(api.directory()), await canonical(primary))
  assert.equal(await git(primary, "branch", "--list", "feat/wait-then-abandon"), "")
  assert.equal(await git(primary, "worktree", "list", "--porcelain").then((output) => output.includes(state.worktree)), false)
  await assert.rejects(submitWorkspace(submitOptions(context)), /cannot submit a managed worktree in phase complete/)
})

test("submit journals are companion files, not session state, for every state-directory scan", async () => {
  const orphan = sessionID("journal_orphan")
  await __testing.writeSubmitJournal(orphan, { branch: "feat/orphan", headSha: "f".repeat(40), title: "Orphan", createdAt: 1 })
  try {
    // Each scanner used to treat every *.json entry except *.goal.json as a
    // session state file; an orphaned journal must be skipped, not parsed as a
    // session named "<id>.submit".
    assert.deepEqual(await reconcilePlannedWorktrees({ serverUrl: OPM_SERVER, fetchImpl: async () => new Response("unused", { status: 500 }) }), [])
    const scheduler = createWorkspaceResumeScheduler({ serverUrl: new URL("http://journal-orphan.test/"), fetchImpl: async () => new Response("unused", { status: 500 }), retryDelayMs: 5 })
    assert.deepEqual(await scheduler.recover(), [])
    await assert.doesNotReject(assertSessionWorktreeNotClosing({ sessionID: sessionID("journal_other"), serverUrl: OPM_SERVER, fetchImpl: async () => new Response("unused", { status: 500 }) }))
    assert.equal(await __testing.readState(`${orphan}.submit`), null)
  } finally {
    await rm(__testing.submitJournalPath(orphan), { force: true })
  }
})
