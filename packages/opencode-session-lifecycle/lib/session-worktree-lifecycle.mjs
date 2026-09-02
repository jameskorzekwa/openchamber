import { execFile as execFileCallback } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const STATE_VERSION = 1
const GOAL_OBJECTIVE_CHAR_LIMIT = 5_000
const workspaceResumeSchedulersKey = Symbol.for("opencode.session-worktree-lifecycle.resume-schedulers")
const workspaceResumeSchedulers = globalThis[workspaceResumeSchedulersKey] ?? new Map()
globalThis[workspaceResumeSchedulersKey] = workspaceResumeSchedulers
let lastResumeMessageTimestamp = 0
let resumeMessageCounter = 0

const normalizePath = (value) => path.resolve(String(value || "").trim())

const runGit = async (directory, args) => {
  const result = await execFile("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  return String(result.stdout || "").trim()
}

const runGitStatus = async (directory) => runGit(directory, ["status", "--porcelain=v1", "--untracked-files=all"])

const canonicalPath = async (value) => realpath(normalizePath(value))

const pathEquals = (left, right) => process.platform === "win32"
  ? left.toLowerCase() === right.toLowerCase()
  : left === right

const pathIsInside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const stateDirectory = () => process.env.HEIRLOOM_AGENT_LIFECYCLE_STATE_DIR
  ? normalizePath(process.env.HEIRLOOM_AGENT_LIFECYCLE_STATE_DIR)
  : path.join(os.homedir(), ".local", "state", "opencode", "session-worktrees")

const statePath = (sessionID) => path.join(stateDirectory(), `${sessionID}.json`)
const goalProgressPath = (sessionID) => path.join(stateDirectory(), `${sessionID}.goal.json`)
// Intent journal for `submit`. It is written before any GitHub issue is created so
// a crash between "issue created" and "state persisted" cannot file a second
// tracking issue for the same branch on retry.
const submitJournalPath = (sessionID) => path.join(stateDirectory(), `${sessionID}.submit.json`)

// A state directory entry is a lifecycle state file only when it is not one of the
// companion files that share the session ID prefix.
const isSessionStateEntry = (entry) => entry.endsWith(".json")
  && !entry.endsWith(".goal.json")
  && !entry.endsWith(".submit.json")

// OpenCode Project Manager (OPM) runs a loopback control server. A repository is
// OPM-managed when its primary checkout is one of OPM's enabled projects; those
// repositories hand finished work to OPM's pipeline instead of merging locally.
const OPM_CONTROL_URL = "http://127.0.0.1:47651/"
const OPM_REQUEST_TIMEOUT_MS = 5_000
const opmConfigPath = () => path.join(os.homedir(), ".local", "lib", "opencode-project-manager-config.json")
const OPM_DEFAULT_READY_LABEL = "opm:ready"
const OPM_DEFAULT_CLAIMED_LABEL = "opm:claimed"
const OPM_URGENT_LABEL = "opm:urgent"
const OPM_CLASS_LABELS = { docs: "opm:docs", chore: "opm:chore", fix: "opm:fix", feature: null }
const OPM_BRANCH_MARKER_PATTERN = /<!-- opm:branch (\S+)@([0-9a-f]{40}) -->/g
const SUBMIT_TITLE_LIMIT = 120
const SUBMIT_ADMISSION_TIMEOUT_MS = 90_000
const SUBMIT_ADMISSION_POLL_MS = 10_000

// Managed worktrees hold the only copy of uncommitted work, so they must live on
// persistent storage. macOS `dirhelper` (com.apple.bsd.dirhelper, RunAtLoad) purges
// the per-user Darwin temp directory unconditionally at every boot, and prunes it
// again daily at 03:35 with CLEAN_FILES_OLDER_THAN_DAYS=3. On 2026-08-19 a reboot
// erased eight active worktrees that had been rooted at os.tmpdir().
const managedWorktreeRoot = () => path.join(os.homedir(), ".local", "state", "opencode", "worktrees")

// Pre-existing state may still reference the volatile temp root. It stays approved
// so an in-flight lifecycle can still be finished, and so a session whose checkout
// was purged there is repaired rather than left crash-looping. No new worktree is
// ever placed there; such a session simply keeps its old location until it ends.
const legacyManagedWorktreeRoot = () => path.join(os.tmpdir(), "opencode")

// Locks are intentionally ephemeral: they must not survive a reboot.
const lockRoot = () => path.join(os.tmpdir(), "opencode-session-worktree-locks")

const processExists = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

const acquireRepositoryLock = async (commonDirectory) => {
  await mkdir(lockRoot(), { recursive: true })
  const key = createHash("sha256").update(commonDirectory).digest("hex")
  const lockDirectory = path.join(lockRoot(), key)
  const token = randomUUID()
  const ownerPath = path.join(lockDirectory, "owner.json")
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      await mkdir(lockDirectory)
      try {
        await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, { mode: 0o600 })
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true })
        throw error
      }
      return async () => {
        try {
          const owner = JSON.parse(await readFile(ownerPath, "utf8"))
          if (owner.token === token) await rm(lockDirectory, { recursive: true, force: true })
        } catch {}
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      let owner = null
      try { owner = JSON.parse(await readFile(ownerPath, "utf8")) } catch {}
      if (owner && !processExists(owner.pid)) {
        await rm(lockDirectory, { recursive: true, force: true })
        continue
      }
      if (!owner) {
        const lockStat = await stat(lockDirectory).catch(() => null)
        if (lockStat && Date.now() - lockStat.mtimeMs >= 30_000) {
          await rm(lockDirectory, { recursive: true, force: true })
          continue
        }
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for another session's Git worktree operation")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

const readState = async (sessionID) => {
  try {
    const parsed = JSON.parse(await readFile(statePath(sessionID), "utf8"))
    return parsed?.version === STATE_VERSION ? parsed : null
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

const writeState = async (state) => {
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 })
  const target = statePath(state.sessionID)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

const deleteState = async (sessionID) => Promise.all([
  rm(statePath(sessionID), { force: true }),
  rm(goalProgressPath(sessionID), { force: true }),
  rm(submitJournalPath(sessionID), { force: true }),
])

const readSubmitJournal = async (sessionID) => {
  try {
    const parsed = JSON.parse(await readFile(submitJournalPath(sessionID), "utf8"))
    return parsed && typeof parsed === "object" && typeof parsed.branch === "string" ? parsed : null
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

const writeSubmitJournal = async (sessionID, journal) => {
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 })
  const target = submitJournalPath(sessionID)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ ...journal, updatedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}


const writeGoalProgress = async (sessionID, goal) => {
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 })
  const target = goalProgressPath(sessionID)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(goal)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}

const normalizeBranch = (value) => {
  const branch = String(value || "").trim()
  if (!branch || branch === "main" || branch === "master" || branch === "HEAD") {
    throw new Error("branch must be a descriptive non-main branch name")
  }
  const invalidComponent = branch.split("/").some((component) => (
    !component || component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock")
  ))
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch) || branch.includes("..") || invalidComponent) {
    throw new Error("branch contains unsupported Git ref characters")
  }
  return branch
}

const slugify = (branch) => branch
  .replaceAll("/", "-")
  .replace(/[^A-Za-z0-9._-]+/g, "-")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 72)

const resolveRepository = async (directory) => {
  const checkout = await canonicalPath(directory)
  const root = await canonicalPath(await runGit(checkout, ["rev-parse", "--show-toplevel"]))
  const commonRaw = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const commonDirectory = await canonicalPath(commonRaw)
  const worktrees = await runGit(root, ["worktree", "list", "--porcelain"])
  const primaryRaw = worktrees.split(/\n\n+/)[0]?.split("\n").find((line) => line.startsWith("worktree "))?.slice(9)
  if (!primaryRaw) throw new Error("unable to resolve the primary Git worktree")
  const primary = await canonicalPath(primaryRaw)
  return { checkout, root, commonDirectory, primary }
}

const assertAuthoritativeSessionDirectory = async ({ serverUrl, sessionID, directory, fetchImpl }) => {
  const response = await fetchImpl(new URL("experimental/session?archived=true&limit=500", serverUrl))
  if (!response.ok) throw new Error(`unable to resolve session directory (${response.status})`)
  const payload = await response.json()
  const sessions = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : [])
  const session = sessions.find((candidate) => candidate?.id === sessionID)
  if (!session?.directory) throw new Error("current session was not found in the global session list")
  const authoritative = await canonicalPath(session.directory)
  const expected = await canonicalPath(directory)
  if (authoritative !== expected) {
    throw new Error(`session directory mismatch: expected ${expected}, found ${authoritative}`)
  }
}

const moveSession = async ({ serverUrl, sessionID, destination, fetchImpl, timeoutMs = 5_000 }) => {
  let failure = null
  try {
    const response = await fetchImpl(new URL("experimental/control-plane/move-session", serverUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID, destination: { directory: destination }, moveChanges: false }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) return
    failure = new Error(`session move failed (${response.status}): ${await response.text()}`)
  } catch (error) {
    failure = error
  }
  try {
    await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: destination, fetchImpl })
  } catch (verificationError) {
    throw new Error(
      `session move outcome could not be verified after ${failure instanceof Error ? failure.message : String(failure)}: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
    )
  }
}

const sessionUrl = (serverUrl, sessionID, suffix = "") => new URL(
  `session/${encodeURIComponent(sessionID)}${suffix}`,
  serverUrl,
)

const fetchSession = async ({ serverUrl, sessionID, directory, fetchImpl }) => {
  const url = sessionUrl(serverUrl, sessionID)
  url.searchParams.set("directory", directory)
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`unable to read session metadata (${response.status})`)
  const payload = await response.json()
  if (!payload || typeof payload !== "object") throw new Error("session metadata response was invalid")
  return payload
}

const listSessionsInDirectory = async ({ serverUrl, directory, fetchImpl }) => {
  const limit = 10_000
  const url = new URL("session", serverUrl)
  url.searchParams.set("directory", directory)
  url.searchParams.set("limit", String(limit))
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`unable to list worktree sessions (${response.status})`)
  const payload = await response.json()
  const sessions = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null)
  if (!sessions) throw new Error("worktree session list response was invalid")
  if (sessions.length >= limit) throw new Error(`worktree session list reached the ${limit}-session safety limit`)
  const expected = normalizePath(directory)
  return sessions.filter((session) => (
    typeof session?.id === "string"
    && typeof session?.directory === "string"
    && pathEquals(normalizePath(session.directory), expected)
  ))
}

const assertSessionDirectory = async ({ serverUrl, sessionID, directory, fetchImpl }) => {
  const session = await fetchSession({ serverUrl, sessionID, directory, fetchImpl })
  if (!session?.directory || !pathEquals(normalizePath(session.directory), normalizePath(directory))) {
    throw new Error(`session ${sessionID} did not move to ${directory}`)
  }
}

const relocateWorktreeSessions = async ({ serverUrl, currentSessionID, source, destination, fetchImpl }) => {
  const moved = new Set()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sessions = await listSessionsInDirectory({ serverUrl, directory: source, fetchImpl })
    if (sessions.length === 0) return [...moved]
    const statuses = await fetchSessionStatuses({ serverUrl, directory: source, fetchImpl })
    const active = sessions.filter((session) => (
      session.id !== currentSessionID
      && ["busy", "retry"].includes(statuses[session.id]?.type)
    ))
    if (active.length > 0) {
      throw new Error(`cannot remove worktree while other sessions are active: ${active.map((session) => session.id).join(", ")}`)
    }
    sessions.sort((left, right) => Number(left.id === currentSessionID) - Number(right.id === currentSessionID))
    for (const session of sessions) {
      await moveSession({ serverUrl, sessionID: session.id, destination, fetchImpl })
      await assertSessionDirectory({ serverUrl, sessionID: session.id, directory: destination, fetchImpl })
      moved.add(session.id)
    }
  }
  const remaining = await listSessionsInDirectory({ serverUrl, directory: source, fetchImpl })
  throw new Error(`worktree still has sessions after relocation: ${remaining.map((session) => session.id).join(", ")}`)
}

const fetchLatestUserRequest = async ({ serverUrl, sessionID, directory, fetchImpl }) => {
  const url = sessionUrl(serverUrl, sessionID, "/message")
  url.searchParams.set("directory", directory)
  url.searchParams.set("limit", "40")
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`unable to read the session request (${response.status})`)
  const payload = await response.json()
  const messages = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : [])
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info?.role !== "user") continue
    const text = (Array.isArray(messages[index].parts) ? messages[index].parts : [])
      .filter((part) => part?.synthetic !== true)
      .map((part) => {
        if (part?.type === "text" && typeof part.text === "string") return part.text.trim()
        if (part?.type === "file") {
          const name = String(part.filename || part.name || part.url || "unnamed attachment").trim()
          const mime = String(part.mime || part.mimeType || "unknown type").trim()
          return `[Attached file: ${name} (${mime})]`
        }
        return ""
      })
      .filter(Boolean)
      .join("\n")
    if (!text) continue
    return text
  }
  throw new Error("unable to create a worktree goal because the session has no user request")
}

const GOAL_OBJECTIVE_PREFIX = "Implement the feature or fix in the user request below completely.\n\nUser request:\n"
const GOAL_OBJECTIVE_CRITERIA_HEADING = "\n\nCompletion criteria:"

// OPM-managed repositories have one merge pipeline: nothing merges without the
// project's gates and OPM's independent review. Their completion criteria end at
// `submit` so the goal text never instructs the session to merge its own PR.
const buildGoalCompletionCriteria = (mode) => (mode === "submit"
  ? [
    "- Fully implement the requested behavior without reducing scope.",
    "- Run and pass all relevant verification for the affected repository.",
    "- Commit the finished work; do not merge it yourself. This repository is managed by OpenCode Project Manager (OPM), whose pipeline runs CI, independent review, merge, deploy, and verification.",
    "- Call session_workspace with action=submit so the branch is pushed, a pull request and tracking issue are filed, and the work is handed to OPM's pipeline. State the resulting {slug}#{ref} in your reply.",
    "The goal is not complete while the session remains in the worktree or while the work has not been submitted to OPM.",
  ]
  : [
    "- Fully implement the requested behavior without reducing scope.",
    "- Run and pass all relevant verification for the affected repository.",
    "- Commit and push the finished work, merge it into origin/main, and synchronize the clean primary checkout.",
    "- Deploy the merged implementation to the repository's dev environment and verify that deployment.",
    "- Call session_workspace with action=finish, including the dev deployment target and verification evidence, so the session returns to the primary workspace and the managed worktree is removed.",
    "The goal is not complete while the session remains in the worktree, while changes are unmerged, or while the dev deployment is unverified.",
  ])

const buildManagedGoalObjective = (request, charLimit = GOAL_OBJECTIVE_CHAR_LIMIT, mode = "finish") => {
  const prefix = GOAL_OBJECTIVE_PREFIX
  const suffix = `${GOAL_OBJECTIVE_CRITERIA_HEADING}\n${buildGoalCompletionCriteria(mode).join("\n")}`
  const requestLimit = Math.max(0, charLimit - prefix.length - suffix.length)
  const requestText = String(request || "").trim()
  const trimMarker = "\n\n[... middle of user request trimmed; conversation remains authoritative ...]\n\n"
  const fittedRequest = requestText.length <= requestLimit
    ? requestText
    : `${requestText.slice(0, Math.floor((requestLimit - trimMarker.length) / 2))}${trimMarker}${requestText.slice(-Math.ceil((requestLimit - trimMarker.length) / 2))}`
  return `${prefix}${fittedRequest}${suffix}`
}

// Recover the owner's own request text from a persisted objective. `submit` uses
// it for the default title and the tracking issue body, so the boilerplate prefix
// and completion criteria must not leak into GitHub.
const extractGoalRequest = (objective) => {
  let text = String(objective || "")
  if (text.startsWith(GOAL_OBJECTIVE_PREFIX)) text = text.slice(GOAL_OBJECTIVE_PREFIX.length)
  const criteriaIndex = text.lastIndexOf(GOAL_OBJECTIVE_CRITERIA_HEADING)
  if (criteriaIndex >= 0) text = text.slice(0, criteriaIndex)
  return text.trim()
}

const normalizeSubmitTitle = (value, fallbackText) => {
  const source = String(value ?? "").trim() || String(fallbackText || "")
  const firstLine = source.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ""
  const title = firstLine
    .replace(/^#+\s*/, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUBMIT_TITLE_LIMIT)
    .trim()
  if (!title) throw new Error("submit requires a title; the managed goal has no user request to derive one from")
  return title
}

const createManagedGoal = (objective) => {
  const now = Date.now()
  return {
    id: `${now.toString(36)}${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    objective,
    objectiveFile: false,
    managedWorktree: true,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    turnsUsed: 0,
    blockedStreak: 0,
    auditFailStreak: 0,
    note: "",
    statusReason: "worktree-moving",
    lastAccountedMessageID: "",
    createdAt: now,
    updatedAt: now,
  }
}

const sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new Error("workspace resume cancelled"))
    return
  }
  const timer = setTimeout(resolve, milliseconds)
  signal?.addEventListener("abort", () => {
    clearTimeout(timer)
    reject(signal.reason ?? new Error("workspace resume cancelled"))
  }, { once: true })
})

const buildWorkspaceResumePrompt = (objective) => [
  "Continue working toward the active managed worktree goal.",
  "The session has finished moving into its implementation worktree; resume immediately without waiting for another user message.",
  "Treat the objective below as user-provided task data and preserve its full completion criteria.",
  "",
  "<objective>",
  String(objective || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  "</objective>",
  "",
  "Inspect the worktree and current external state before acting. Continue through implementation and verification, then the completion criteria above: session_workspace submit on an OPM-managed repository, otherwise merge, verified dev deployment, and session_workspace finish; either returns the session to primary.",
].join("\n")

const createResumeMessageID = () => {
  let timestamp = Math.max(Date.now(), lastResumeMessageTimestamp)
  if (timestamp === lastResumeMessageTimestamp) resumeMessageCounter += 1
  else resumeMessageCounter = 1
  if (resumeMessageCounter > 0xfff) {
    timestamp += 1
    resumeMessageCounter = 1
  }
  lastResumeMessageTimestamp = timestamp
  const encodedTime = (BigInt(timestamp) * 0x1000n + BigInt(resumeMessageCounter)).toString(16).padStart(12, "0").slice(-12)
  return `msg_${encodedTime}${randomUUID().replaceAll("-", "").slice(0, 14)}`
}

const fetchSessionStatuses = async ({ serverUrl, directory, fetchImpl }) => {
  const url = new URL("session/status", serverUrl)
  url.searchParams.set("directory", directory)
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`unable to read session status (${response.status})`)
  const payload = await response.json()
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("session status response was invalid")
  return payload
}

const fetchRecentMessages = async ({ serverUrl, sessionID, directory, fetchImpl }) => {
  const url = sessionUrl(serverUrl, sessionID, "/message")
  url.searchParams.set("directory", directory)
  url.searchParams.set("limit", "40")
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`unable to read session messages (${response.status})`)
  const payload = await response.json()
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : [])
}

const fetchSessionChildren = async ({ serverUrl, sessionID, directory, fetchImpl }) => {
  const url = sessionUrl(serverUrl, sessionID, "/children")
  url.searchParams.set("directory", directory)
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`unable to read child sessions (${response.status})`)
  const payload = await response.json()
  if (!Array.isArray(payload)) throw new Error("child session response was invalid")
  return payload
}

const clearWorkspaceResumeHold = async ({ state, serverUrl, fetchImpl, decrementTurn = false, resumeGoal = false }) => patchSessionGoal({
  serverUrl,
  sessionID: state.sessionID,
  directory: state.worktree,
  expectedGoalID: state.managedGoalID,
  mutateGoal: (current) => {
    if (!["worktree-moving", "worktree-resume-dispatching"].includes(current?.statusReason)) return current
    const next = {
      ...current,
      statusReason: resumeGoal ? "resumed" : "",
      turnsUsed: decrementTurn
        ? Math.max(0, Number(current?.turnsUsed || 0) - 1)
        : current.turnsUsed,
      updatedAt: Date.now(),
    }
    delete next.worktreeResumeAnchorMessageID
    delete next.worktreeResumeMessageID
    return next
  },
  fetchImpl,
})

const retryWorkspaceResumeHoldClear = async (options) => {
  let delay = 100
  while (true) {
    try {
      return await clearWorkspaceResumeHold(options)
    } catch (error) {
      const state = await readState(options.state.sessionID).catch(() => null)
      if (state?.phase !== "attached" || state.managedGoalID !== options.state.managedGoalID) return null
      await sleep(delay)
      delay = Math.min(delay * 2, 5_000)
    }
  }
}

const dispatchWorkspaceResume = async ({ state, serverUrl, fetchImpl, signal, registerMessageID }) => {
  const session = await fetchSession({
    serverUrl,
    sessionID: state.sessionID,
    directory: state.worktree,
    fetchImpl,
  })
  const goal = session.metadata?.openchamber?.goal
  if (
    !goal
    || goal.id !== state.managedGoalID
    || goal.managedWorktree !== true
    || goal.status !== "active"
    || !["worktree-moving", "worktree-resume-dispatching"].includes(goal.statusReason)
  ) return { status: "skipped" }

  const messages = await fetchRecentMessages({
    serverUrl,
    sessionID: state.sessionID,
    directory: state.worktree,
    fetchImpl,
  })
  const resumeMessageID = String(goal.worktreeResumeMessageID || "")
  if (
    goal.statusReason === "worktree-resume-dispatching"
    && resumeMessageID
    && messages.some((message) => message?.info?.id === resumeMessageID && message.info.role === "user")
  ) {
    await clearWorkspaceResumeHold({ state, serverUrl, fetchImpl, resumeGoal: true })
    return { status: "dispatched" }
  }

  const statuses = await fetchSessionStatuses({ serverUrl, directory: state.worktree, fetchImpl })
  if (statuses[state.sessionID]?.type === "busy" || statuses[state.sessionID]?.type === "retry") {
    return { status: "waiting" }
  }
  const children = await fetchSessionChildren({
    serverUrl,
    sessionID: state.sessionID,
    directory: state.worktree,
    fetchImpl,
  })
  if (children.some((child) => (
    typeof child?.id === "string"
    && (statuses[child.id]?.type === "busy" || statuses[child.id]?.type === "retry")
  ))) return { status: "waiting" }

  const lastMessage = messages.at(-1)?.info
  if (lastMessage?.role !== "assistant" || (!(lastMessage.time?.completed > 0) && !lastMessage.error)) {
    return { status: "waiting" }
  }
  if (goal.statusReason === "worktree-resume-dispatching" && goal.worktreeResumeAnchorMessageID !== lastMessage.id) {
    await clearWorkspaceResumeHold({ state, serverUrl, fetchImpl, decrementTurn: true })
    return { status: "skipped" }
  }
  let executionInfo = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info
    if (info?.role === "assistant" && info.summary !== true && info.time?.completed > 0) {
      executionInfo = info
      break
    }
  }
  const providerID = String(executionInfo?.providerID || "")
  const modelID = String(executionInfo?.modelID || "")
  if (!providerID || !modelID) return { status: "waiting" }

  const newlyDispatching = goal.statusReason === "worktree-moving"
  const messageID = newlyDispatching ? createResumeMessageID() : resumeMessageID
  if (!messageID) {
    await clearWorkspaceResumeHold({ state, serverUrl, fetchImpl })
    return { status: "skipped" }
  }
  if (newlyDispatching) {
    await patchSessionGoal({
        serverUrl,
        sessionID: state.sessionID,
        directory: state.worktree,
        expectedGoalID: state.managedGoalID,
        mutateGoal: (current) => ({
           ...current,
           statusReason: "worktree-resume-dispatching",
           worktreeResumeAnchorMessageID: lastMessage.id,
           worktreeResumeMessageID: messageID,
           turnsUsed: Number.isFinite(current?.turnsUsed) ? current.turnsUsed + 1 : 1,
          updatedAt: Date.now(),
        }),
        fetchImpl,
      })
  }
  if (signal?.aborted) throw signal.reason ?? new Error("workspace resume cancelled")
  registerMessageID(messageID)
  const promptUrl = sessionUrl(serverUrl, state.sessionID, "/message")
  promptUrl.searchParams.set("directory", state.worktree)
  const response = await fetchImpl(promptUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      messageID,
      model: { providerID, modelID },
      ...(executionInfo.agent || executionInfo.mode ? { agent: executionInfo.agent || executionInfo.mode } : {}),
      ...(executionInfo.variant ? { variant: executionInfo.variant } : {}),
      parts: [{ type: "text", text: buildWorkspaceResumePrompt(state.managedGoalObjective), synthetic: true }],
    }),
    signal,
  })
  if (!response.ok) throw new Error(`workspace resume dispatch failed (${response.status})`)
  await clearWorkspaceResumeHold({ state, serverUrl, fetchImpl, resumeGoal: true })
  return { status: "dispatched" }
}

export const createWorkspaceResumeScheduler = ({
  serverUrl,
  fetchImpl = fetch,
  retryDelayMs = 500,
} = {}) => {
  const jobs = new Map()
  const automaticMessageIDs = new Set()
  let recoveryPromise = null
  const schedule = (state) => {
    if (!state?.managedGoalID || state.phase !== "attached") return Promise.resolve({ status: "skipped" })
    if (jobs.has(state.sessionID)) return jobs.get(state.sessionID).promise
    const controller = new AbortController()
    const messageIDs = new Set()
    const promise = (async () => {
      let delay = retryDelayMs
      while (!controller.signal.aborted) {
        try {
          const result = await dispatchWorkspaceResume({
            state,
            serverUrl,
            fetchImpl,
            signal: controller.signal,
            registerMessageID(messageID) {
              messageIDs.add(messageID)
              automaticMessageIDs.add(messageID)
            },
          })
          if (result.status !== "waiting") return result
          delay = retryDelayMs
        } catch (error) {
          if (controller.signal.aborted) return { status: "cancelled" }
          delay = Math.min(Math.max(retryDelayMs, delay * 2), 5_000)
        }
        try {
          await sleep(delay, controller.signal)
        } catch {
          if (controller.signal.aborted) return { status: "cancelled" }
          throw new Error("workspace resume delay failed")
        }
      }
      return { status: "cancelled" }
    })().finally(() => {
      jobs.delete(state.sessionID)
      for (const messageID of messageIDs) automaticMessageIDs.delete(messageID)
    })
    jobs.set(state.sessionID, { controller, promise })
    return promise
  }
  return {
    schedule,
    isAutomaticResume(messageID) {
      return typeof messageID === "string" && automaticMessageIDs.has(messageID)
    },
    async cancel(sessionID) {
      const job = jobs.get(sessionID)
      job?.controller.abort(new Error("workspace resume superseded by a user message"))
      await job?.promise.catch(() => undefined)
      const state = await readState(sessionID).catch(() => null)
      if (state?.phase !== "attached" || !state.managedGoalID) return
      const session = await fetchSession({
        serverUrl,
        sessionID,
        directory: state.worktree,
        fetchImpl,
      }).catch(() => null)
      const goal = session?.metadata?.openchamber?.goal
      if (!goal || goal.id !== state.managedGoalID) return
      if (!["worktree-moving", "worktree-resume-dispatching"].includes(goal.statusReason)) return
      const messageID = String(goal.worktreeResumeMessageID || "")
      const messages = messageID
        ? await fetchRecentMessages({ serverUrl, sessionID, directory: state.worktree, fetchImpl }).catch(() => [])
        : []
      const accepted = messages.some((message) => message?.info?.id === messageID && message.info.role === "user")
      void retryWorkspaceResumeHoldClear({
        state,
        serverUrl,
        fetchImpl,
        decrementTurn: goal.statusReason === "worktree-resume-dispatching" && !accepted,
      })
    },
    recover() {
      if (!recoveryPromise) {
        recoveryPromise = (async () => {
          let entries = []
          try { entries = await readdir(stateDirectory()) } catch { return [] }
          const recovered = []
          for (const entry of entries) {
            if (!isSessionStateEntry(entry)) continue
            const sessionID = entry.slice(0, -5)
            const state = await readState(sessionID).catch(() => null)
            if (state?.phase !== "attached" || !state.managedGoalID) continue
            await restoreMissingWorktree(state)
            recovered.push(schedule(state))
          }
          return recovered
        })()
      }
      return recoveryPromise
    },
  }
}

export const getWorkspaceResumeScheduler = (options = {}) => {
  const key = String(new URL(options.serverUrl))
  if (!workspaceResumeSchedulers.has(key)) {
    workspaceResumeSchedulers.set(key, createWorkspaceResumeScheduler(options))
  }
  return workspaceResumeSchedulers.get(key)
}

const patchSessionGoal = async ({ serverUrl, sessionID, directory, goal, mutateGoal, expectedGoalID, fetchImpl }) => {
  const session = await fetchSession({ serverUrl, sessionID, directory, fetchImpl })
  const metadata = session.metadata && typeof session.metadata === "object" ? session.metadata : {}
  const namespace = metadata.openchamber && typeof metadata.openchamber === "object" ? metadata.openchamber : {}
  const currentGoal = namespace.goal && typeof namespace.goal === "object" ? namespace.goal : null
  if (expectedGoalID !== undefined && (currentGoal?.id ?? null) !== expectedGoalID) {
    throw new Error("managed session goal was replaced while the worktree lifecycle was running")
  }
  const nextNamespace = { ...namespace }
  const nextGoal = mutateGoal ? mutateGoal(currentGoal) : goal
  if (nextGoal) nextNamespace.goal = nextGoal
  else delete nextNamespace.goal
  const nextMetadata = { ...metadata }
  if (Object.keys(nextNamespace).length > 0) nextMetadata.openchamber = nextNamespace
  else delete nextMetadata.openchamber
  const url = sessionUrl(serverUrl, sessionID)
  url.searchParams.set("directory", directory)
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ metadata: nextMetadata }),
  })
  if (!response.ok) throw new Error(`unable to update the managed session goal (${response.status})`)
  return nextGoal
}

const restoreManagedGoal = async ({ state, serverUrl, fetchImpl }) => {
  const session = await fetchSession({
    serverUrl,
    sessionID: state.sessionID,
    directory: state.primary,
    fetchImpl,
  })
  const currentGoal = session.metadata?.openchamber?.goal ?? null
  const previousGoalID = state.previousGoal?.id ?? null
  if ((currentGoal?.id ?? null) === previousGoalID) return
  if (currentGoal?.id !== state.managedGoalID) {
    throw new Error("session goal changed during worktree rollback")
  }
  await patchSessionGoal({
    serverUrl,
    sessionID: state.sessionID,
    directory: state.primary,
    expectedGoalID: state.managedGoalID,
    goal: state.previousGoal,
    fetchImpl,
  })
}

const normalizeDevDeployment = (value) => {
  const target = String(value?.target || "").trim()
  const commit = String(value?.commit || "").trim().toLowerCase()
  let targetUrl
  try { targetUrl = new URL(target) } catch {}
  if (!targetUrl || !["http:", "https:"].includes(targetUrl.protocol) || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("finish requires an HTTP(S) dev verification URL and exact 40-character deployed commit")
  }
  return { target: targetUrl.toString().slice(0, 500), commit }
}

const verifyDevDeployment = async (deployment, fetchImpl) => {
  let response
  try {
    response = await fetchImpl(deployment.target, {
      headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new Error(`dev deployment verification request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`dev deployment verification failed with HTTP ${response.status}`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("dev deployment response body was unavailable")
  const decoder = new TextDecoder()
  let body = ""
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > 1024 * 1024) {
      await reader.cancel().catch(() => undefined)
      throw new Error("dev deployment response exceeded the 1 MiB verification limit")
    }
    body += decoder.decode(value, { stream: true })
  }
  body += decoder.decode()
  let payload
  try { payload = JSON.parse(body) } catch {}
  if (payload?.status !== "ok") throw new Error("AWS nonproduction health did not report status ok")
  return {
    ...deployment,
    status: response.status,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    verifiedAt: Date.now(),
  }
}

const completeManagedGoal = async ({ state, serverUrl, fetchImpl }) => {
  const session = await fetchSession({ serverUrl, sessionID: state.sessionID, directory: state.primary, fetchImpl })
  const currentGoal = session.metadata?.openchamber?.goal
  if (
    currentGoal?.id === state.managedGoalID
    && currentGoal.managedWorktree !== true
    && currentGoal.status === "complete"
    && currentGoal.statusReason === "worktree lifecycle complete"
  ) return currentGoal
  const note = `Verified ${state.devDeployment.target} at ${state.devDeployment.commit.slice(0, 12)} returned ${state.devDeployment.status}.`.slice(0, 280)
  const completedGoal = await patchSessionGoal({
    serverUrl,
    sessionID: state.sessionID,
    directory: state.primary,
    expectedGoalID: state.managedGoalID,
    mutateGoal: (currentGoal) => {
      if (currentGoal?.managedWorktree !== true) {
        throw new Error("managed session goal is missing or was replaced before lifecycle completion")
      }
      return {
        ...currentGoal,
        managedWorktree: false,
        status: "complete",
        statusReason: "worktree lifecycle complete",
        note,
        blockedStreak: 0,
        auditFailStreak: 0,
        updatedAt: Date.now(),
      }
    },
    fetchImpl,
  })
  await writeGoalProgress(state.sessionID, completedGoal)
  return completedGoal
}

const createTargetDirectory = async (branch) => {
  const root = managedWorktreeRoot()
  await mkdir(root, { recursive: true })
  const parent = await canonicalPath(root)
  return path.join(parent, `${slugify(branch)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
}

// Both managed roots are process-computed constants, never taken from state. A
// path outside both is not a managed worktree, so nothing may be created there.
const approvedManagedRoots = async () => {
  const roots = []
  const add = (value) => {
    if (!roots.some((root) => pathEquals(root, value))) roots.push(value)
  }
  for (const candidate of [managedWorktreeRoot(), legacyManagedWorktreeRoot()]) {
    add(normalizePath(candidate))
    try { add(await canonicalPath(candidate)) } catch {}
  }
  return roots
}

const insideApprovedManagedRoot = async (target) => {
  const roots = await approvedManagedRoots()
  return roots.some((root) => pathIsInside(root, target))
}

// A path being restored does not exist yet, so it cannot be canonicalized directly.
// Resolve the deepest ancestor that does exist and re-attach the remainder, so a
// symlinked ancestor cannot smuggle the checkout outside an approved root. This
// resolves symlinks only below the deepest existing ancestor, so the caller must
// already have rejected a path containing traversal segments: `path.resolve`
// collapses `link/..` lexically, which would hide the symlink from this walk.
const canonicalizeThroughExistingAncestor = async (target) => {
  const normalized = normalizePath(target)
  const remainder = []
  let current = normalized
  for (;;) {
    try { return path.join(await canonicalPath(current), ...remainder) } catch {}
    const parent = path.dirname(current)
    if (parent === current) return normalized
    remainder.unshift(path.basename(current))
    current = parent
  }
}

// A managed worktree directory can disappear while its session still points at it:
// the legacy temp root is erased at boot, and a sweeper or a person can remove any
// directory. When that happens OpenCode fails inside prompt setup with an unhandled
// realPath ENOENT, so every later turn returns an empty assistant message and the
// goal watchdog re-dispatches into the same crash forever. Recreate the checkout
// from the branch that still exists in the primary repository. Commits are safe
// because a linked worktree keeps its objects, HEAD, and index in the primary
// repository; only the checked-out files are lost.
export const restoreMissingWorktree = async (state) => {
  if (!state?.worktree || !state?.branch || !state?.primary) return false
  try {
    await stat(state.worktree)
    return false
  } catch {}
  // Restoring repairs a recorded managed path; it must not materialize a checkout
  // somewhere this lifecycle would refuse to create or remove one. Every path this
  // lifecycle records is already resolved, so anything needing normalization is not
  // one of ours; refuse it before `..` can hide a symlink from the walk below.
  if (state.worktree !== normalizePath(state.worktree)) return false
  if (!await insideApprovedManagedRoot(await canonicalizeThroughExistingAncestor(state.worktree))) return false
  try {
    const repository = await resolveRepository(state.primary)
    if (!pathEquals(repository.primary, state.primary)) return false
    if (!pathEquals(repository.commonDirectory, state.commonDirectory)) return false
    await runGit(state.primary, ["rev-parse", "--verify", `refs/heads/${state.branch}`])
    await mkdir(path.dirname(state.worktree), { recursive: true })
    await runGit(state.primary, ["worktree", "add", "-f", state.worktree, state.branch])
    return pathEquals(await canonicalPath(state.worktree), normalizePath(state.worktree))
  } catch {
    return false
  }
}

const branchIsOnRemote = async (primary, head) => {
  const refs = await runGit(primary, ["branch", "-r", "--contains", head, "--list", "origin/*"])
  return refs.split("\n").map((entry) => entry.trim()).filter(Boolean)
}

const hasMergedPullRequest = async (primary, branch, head) => {
  try {
    const result = await execFile("gh", ["pr", "list", "--repo", await runGit(primary, ["remote", "get-url", "origin"]), "--head", branch, "--state", "merged", "--json", "headRefOid,mergeCommit", "--limit", "20"], {
      cwd: primary,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    })
    const records = JSON.parse(String(result.stdout || "[]"))
    const match = Array.isArray(records) ? records.find((record) => record?.headRefOid === head) : null
    return match?.mergeCommit?.oid || false
  } catch {
    return false
  }
}

const inspectNonproductionWorkflow = async (primary, commit, execImpl = execFile) => {
  try {
    const repository = await runGit(primary, ["remote", "get-url", "origin"])
    const repositoryResult = await execImpl("gh", [
      "repo", "view", repository,
      "--json", "nameWithOwner", "--jq", ".nameWithOwner",
    ], { cwd: primary, encoding: "utf8", maxBuffer: 1024 * 1024 })
    const repositorySlug = String(repositoryResult.stdout || "").trim()
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositorySlug)) {
      throw new Error("GitHub repository identity was malformed")
    }
    const workflowsResult = await execImpl("gh", [
      "api", "--paginate", "--slurp",
      `repos/${repositorySlug}/actions/workflows?per_page=100`,
    ], { cwd: primary, encoding: "utf8", maxBuffer: 1024 * 1024 })
    const pages = JSON.parse(String(workflowsResult.stdout || "[]"))
    if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page?.workflows))) {
      throw new Error("GitHub workflow inventory was malformed")
    }
    const workflows = pages.flatMap((page) => page.workflows)
    if (!Number.isInteger(pages[0].total_count) || workflows.length !== pages[0].total_count) {
      throw new Error("GitHub workflow inventory was incomplete")
    }
    if (!workflows.some((workflow) => workflow?.name === "Deploy Platform Nonproduction")) {
      return { required: true, run: false }
    }
    const result = await execImpl("gh", [
      "run", "list",
      "--repo", repository,
      "--workflow", "Deploy Platform Nonproduction",
      "--all",
      "--commit", commit,
      "--status", "success",
      "--json", "databaseId,headSha,conclusion,url",
      "--limit", "20",
    ], { cwd: primary, encoding: "utf8", maxBuffer: 1024 * 1024 })
    const records = JSON.parse(String(result.stdout || "[]"))
    const run = Array.isArray(records) ? records.find((record) => record?.headSha === commit && record?.conclusion === "success") ?? false : false
    return { required: true, run }
  } catch {
    // An unreadable repository or forge must not silently disable a deployment gate.
    return { required: true, run: false }
  }
}

const isAncestor = async (directory, ancestor, descendant) => {
  try {
    await runGit(directory, ["merge-base", "--is-ancestor", ancestor, descendant])
    return true
  } catch {
    return false
  }
}

// `gh` is the only GitHub write path for submit and claim. It is injectable so the
// tests exercise every argument list against real temporary repositories without
// touching GitHub, the same way `isPullRequestMerged` isolates hasMergedPullRequest.
const runGh = async (args, { cwd } = {}) => {
  try {
    const result = await execFile("gh", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    })
    return String(result.stdout || "").trim()
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim()
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${detail}`)
  }
}

const parseGhJson = (output, fallback) => {
  const text = String(output || "").trim()
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("gh returned invalid JSON")
  }
}

const formatBranchMarker = (branch, head) => `<!-- opm:branch ${branch}@${head} -->`

const parseBranchMarkers = (body) => [...String(body || "").matchAll(OPM_BRANCH_MARKER_PATTERN)]
  .map((match) => ({ branch: match[1], head: match[2], text: match[0] }))

const opmUrl = (base, suffix) => new URL(suffix, base)

const opmFetch = async (fetchImpl, base, suffix, init = {}) => fetchImpl(opmUrl(base, suffix), {
  ...init,
  headers: { accept: "application/json", ...(init.headers || {}) },
  signal: AbortSignal.timeout(OPM_REQUEST_TIMEOUT_MS),
})

const normalizeOpmProject = (project) => {
  if (!project || typeof project !== "object" || typeof project.rootPath !== "string") return null
  const provider = project.providerConfig && typeof project.providerConfig === "object" ? project.providerConfig : {}
  return {
    slug: String(project.slug || "").trim(),
    rootPath: project.rootPath,
    // The control server reports `enabled` explicitly; the on-disk config omits it
    // for enabled projects and writes `false` only when a project is switched off.
    enabled: project.enabled !== false,
    readyLabel: String(project.readyLabel || provider.readyLabel || OPM_DEFAULT_READY_LABEL),
    claimedLabel: String(project.claimedLabel || provider.claimedLabel || OPM_DEFAULT_CLAIMED_LABEL),
    defaultBranch: String(project.defaultBranch || provider.defaultBranch || "main"),
    titleAlias: typeof project.titleAlias === "string" ? project.titleAlias : "",
  }
}

const matchOpmProject = async (projects, primary) => {
  for (const candidate of projects) {
    const project = normalizeOpmProject(candidate)
    if (!project?.slug) continue
    let rootPath
    try { rootPath = await canonicalPath(project.rootPath) } catch { continue }
    if (pathEquals(rootPath, primary) && project.enabled) return project
  }
  return null
}

// Managed detection prefers the live control server and falls back to OPM's own
// configuration file, so a supervisor restart does not turn every submit into a
// local merge. When neither source is readable the caller must fail closed: a
// wrong "unmanaged" answer would route work around the project's review gates.
const resolveOpmProject = async ({ primary, fetchImpl = fetch, opmControlUrl = OPM_CONTROL_URL }) => {
  const failures = []
  try {
    const response = await opmFetch(fetchImpl, opmControlUrl, "projects")
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (!Array.isArray(payload?.projects)) throw new Error("projects response was invalid")
    return { project: await matchOpmProject(payload.projects, primary), source: "control-server" }
  } catch (error) {
    failures.push(`control server: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const payload = JSON.parse(await readFile(opmConfigPath(), "utf8"))
    if (!Array.isArray(payload?.projects)) throw new Error("config has no projects array")
    return { project: await matchOpmProject(payload.projects, primary), source: "config" }
  } catch (error) {
    failures.push(`config: ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`cannot determine whether this repository is OPM-managed (${failures.join("; ")})`)
}

const requireOpmCapabilities = async ({ fetchImpl = fetch, opmControlUrl = OPM_CONTROL_URL, required }) => {
  let capabilities
  try {
    const response = await opmFetch(fetchImpl, opmControlUrl, "status")
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities.map(String) : []
  } catch (error) {
    throw new Error(`OPM control server status is unavailable at ${opmControlUrl} (${error instanceof Error ? error.message : String(error)}); cannot verify capabilities ${required.join(", ")}`)
  }
  const missing = required.filter((capability) => !capabilities.includes(capability))
  if (missing.length > 0) {
    throw new Error(`OPM control server does not advertise the required capability: ${missing.join(", ")}`)
  }
  return capabilities
}

const kickOpm = async ({ fetchImpl = fetch, opmControlUrl = OPM_CONTROL_URL }) => {
  try {
    const response = await opmFetch(fetchImpl, opmControlUrl, "kick", { method: "POST" })
    return response.ok
  } catch {
    return false
  }
}

// Admission is observed, not assumed: the result records whether OPM listed the
// work item within the wait window so the owner can tell a real handoff from a
// supervisor that never picked the issue up.
const waitForOpmAdmission = async ({ fetchImpl = fetch, opmControlUrl = OPM_CONTROL_URL, slug, ref, timeoutMs, pollMs }) => {
  const deadline = Date.now() + timeoutMs
  const wanted = String(ref)
  while (true) {
    try {
      const response = await opmFetch(fetchImpl, opmControlUrl, "activity")
      if (response.ok) {
        const payload = await response.json()
        for (const bucket of ["active", "queued", "blockers"]) {
          const items = Array.isArray(payload?.[bucket]) ? payload[bucket] : []
          if (items.some((item) => item?.project === slug && String(item?.ref ?? "") === wanted)) {
            return { admissionVerified: true, admissionState: bucket === "blockers" ? "blocked" : bucket }
          }
        }
      }
    } catch {}
    if (Date.now() + pollMs > deadline) return { admissionVerified: false, admissionState: "unobserved" }
    await sleep(pollMs)
  }
}

const inferChangeClass = (changedPaths) => {
  const paths = changedPaths.map((entry) => String(entry).trim()).filter(Boolean)
  if (paths.length === 0) return "feature"
  const documentation = paths.every((entry) => /\.md$/i.test(entry) || entry.startsWith("docs/"))
  return documentation ? "docs" : "feature"
}

const normalizeChangeClass = (value) => {
  if (value === undefined || value === null || value === "") return null
  const changeClass = String(value).trim().toLowerCase()
  if (!Object.hasOwn(OPM_CLASS_LABELS, changeClass)) throw new Error("class must be one of docs, chore, fix, feature")
  return changeClass
}

const normalizeIssueNumber = (value) => {
  if (value === undefined || value === null || value === "") return null
  const issue = Number(value)
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error("issue must be a positive integer")
  return issue
}

const slugifyTitle = (title) => String(title || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")

// `opm/*` branches belong to OPM's own workers; an attended claim gets its own
// prefix so nothing that scans for worker branches mistakes it for one.
const deriveIssueBranch = (issue, title) => {
  const branch = `claim/${issue}-${slugifyTitle(title)}`.slice(0, 40).replace(/-+$/, "")
  return normalizeBranch(branch)
}

const parseCreatedIssue = (output) => {
  const url = String(output || "").split(/\s+/).find((token) => /^https?:\/\/.+\/issues\/\d+$/.test(token))
  if (!url) throw new Error("gh issue create did not return an issue URL")
  return { number: Number(url.match(/\/issues\/(\d+)$/)[1]), url }
}

export const expectedDirectoryForState = (state) => {
  if (!state) return null
  return state.phase === "attached" || state.phase === "moving-to-worktree"
    ? state.worktree
    : state.primary
}

export const createTurnBarrier = () => {
  const blockedSessions = new Set()
  return {
    acknowledge(sessionID) {
      blockedSessions.delete(sessionID)
    },
    assert(sessionID) {
      if (blockedSessions.has(sessionID)) {
        throw new Error("Session workspace changed. Stop this turn; the next message or automatic continuation will use the new workspace.")
      }
    },
    block(sessionID) {
      blockedSessions.add(sessionID)
    },
  }
}

export const acknowledgeSessionTurn = async (sessionID) => {
  const state = await readState(sessionID)
  if (state?.phase === "complete") await deleteState(sessionID)
}

export const resumeWorkspaceFromExternalWait = async ({ sessionID, serverUrl, fetchImpl = fetch }) => {
  const state = await readState(sessionID)
  if (state?.phase !== "attached" || state.waitingExternal !== true) return false
  await patchSessionGoal({
    serverUrl,
    sessionID,
    directory: state.worktree,
    expectedGoalID: state.managedGoalID,
    mutateGoal: (current) => ({
      ...current,
      status: "active",
      statusReason: "external wake admitted",
      note: "",
      updatedAt: Date.now(),
    }),
    fetchImpl,
  })
  delete state.waitingExternal
  delete state.waitingReason
  await writeState(state)
  return true
}

export const waitForExternal = async ({ sessionID, directory, reason, serverUrl, fetchImpl = fetch }) => {
  const state = await readState(sessionID)
  if (state?.phase !== "attached" || state.returnPrepared === true) throw new Error("external wait requires an attached managed worktree")
  const actual = await canonicalPath(directory)
  if (!pathEquals(actual, state.worktree)) throw new Error(`external wait must run from ${state.worktree}`)
  const waitingReason = String(reason || "").trim().slice(0, 280)
  if (!waitingReason) throw new Error("reason is required for external wait")
  await patchSessionGoal({
    serverUrl,
    sessionID,
    directory: state.worktree,
    expectedGoalID: state.managedGoalID,
    mutateGoal: (current) => ({
      ...current,
      status: "blocked",
      statusReason: "waiting_external",
      note: waitingReason,
      updatedAt: Date.now(),
    }),
    fetchImpl,
  })
  state.waitingExternal = true
  state.waitingReason = waitingReason
  await writeState(state)
  return state
}

export const assertSessionWorktreeNotClosing = async ({ sessionID, serverUrl, fetchImpl = fetch }) => {
  let entries = []
  try { entries = await readdir(stateDirectory()) } catch { return }
  const closing = []
  for (const entry of entries) {
    if (!isSessionStateEntry(entry)) continue
    const ownerSessionID = entry.slice(0, -5)
    if (ownerSessionID === sessionID) continue
    const state = await readState(ownerSessionID).catch(() => null)
    if (state?.worktree && (state.returnPrepared === true || state.phase === "cleanup-pending")) closing.push(state)
  }
  if (closing.length === 0) return
  const url = new URL("experimental/session", serverUrl)
  url.searchParams.set("archived", "true")
  url.searchParams.set("limit", "10000")
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`unable to verify closing worktrees (${response.status})`)
  const payload = await response.json()
  const sessions = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : [])
  const session = sessions.find((candidate) => candidate?.id === sessionID)
  if (!session?.directory) throw new Error("unable to verify the session directory while another worktree is closing")
  const state = closing.find((candidate) => pathEquals(normalizePath(candidate.worktree), normalizePath(session.directory)))
  if (state) {
    throw new Error(`Worktree cleanup is in progress for session ${state.sessionID}. Wait for that session to return this worktree to the primary checkout.`)
  }
}

// Startup recovery alone leaves a gap: a worktree removed while OpenCode keeps
// running — an external sweeper, a stray cleanup, or dirhelper's daily prune of a
// legacy-root worktree — is not noticed until the next restart. Re-check as each
// turn begins so the session repairs itself in place instead of failing for the
// rest of the day.
export const restoreSessionWorktreeIfMissing = async ({ sessionID }) => {
  const state = await readState(sessionID).catch(() => null)
  if (state?.phase !== "attached") return false
  return restoreMissingWorktree(state)
}

export const assertSessionWorkspaceReady = async ({ sessionID }) => {
  const state = await readState(sessionID)
  if (state?.phase === "move-failed") {
    throw new Error(`Session move state is uncertain. Preserve ${state.worktree} and recover the session before running more tools.`)
  }
  if (state?.phase === "moving-to-worktree") {
    throw new Error(`Session worktree attachment is incomplete. Preserve ${state.worktree} and recover the session before using other tools.`)
  }
  if (state?.phase === "attached" && state.waitingExternal === true) {
    throw new Error("Session is waiting for an external bridge wakeup before more tools may run.")
  }
  if (state?.phase === "attached" && state.abandoning === true) {
    throw new Error("Session abandonment is incomplete. Run session_workspace with action=abandon again.")
  }
  if (state?.phase === "attached" && state.submitting === true) {
    throw new Error("Session submit to OPM is incomplete. Run session_workspace with action=submit again.")
  }
  if (state?.phase === "cleanup-pending" || (state?.phase === "attached" && state.returnPrepared === true)) {
    throw new Error("Session worktree cleanup is incomplete. Run session_workspace with action=finish before using other tools.")
  }
  if (state?.phase === "goal-completion-pending") {
    throw new Error("Session returned to primary, but managed goal completion is pending. Run session_workspace with action=finish again.")
  }
  if (state?.phase === "complete") {
    throw new Error("Session returned to the primary checkout. Stop this turn; the next user message will use the primary checkout.")
  }
}

// Claim-and-pair: read the OPM issue the session is about to work on, derive the
// branch (or adopt the branch the issue already names), and confirm the supervisor
// supports attended claims before any label or worktree is touched.
const prepareIssueClaim = async ({ issue, branch, primary, fetchImpl, opmControlUrl, ghImpl }) => {
  const detection = await resolveOpmProject({ primary, fetchImpl, opmControlUrl })
  const project = detection.project
  if (!project) throw new Error("repository is not OPM-managed; start --issue requires an OPM project")
  await requireOpmCapabilities({ fetchImpl, opmControlUrl, required: ["attended-claim"] })
  const repo = await runGit(primary, ["remote", "get-url", "origin"])
  const record = parseGhJson(await ghImpl([
    "issue", "view", String(issue), "--repo", repo, "--json", "number,title,body,labels,state,url",
  ], { cwd: primary }), null)
  if (!record || typeof record !== "object") throw new Error(`issue #${issue} could not be read`)
  if (String(record.state || "").toUpperCase() !== "OPEN") throw new Error(`issue #${issue} is not open`)
  const markers = parseBranchMarkers(record.body)
  if (markers.length > 1) throw new Error(`issue #${issue} carries more than one branch marker`)
  const adopted = markers[0] ?? null
  const requested = branch ? normalizeBranch(branch) : null
  if (adopted && requested && adopted.branch !== requested) {
    throw new Error(`issue #${issue} already names branch ${adopted.branch}; omit branch to adopt it`)
  }
  const branchName = adopted ? normalizeBranch(adopted.branch) : (requested ?? deriveIssueBranch(issue, record.title))
  const title = String(record.title || "").trim()
  const body = String(record.body || "").trim()
  const request = [title, "", `(GitHub issue #${issue})`, "", body].join("\n").trim()
  return { project, repo, branchName, adoptedBranch: adopted?.branch ?? null, request, issue }
}

export const startWorkspace = async ({
  sessionID,
  directory,
  branch,
  issue,
  serverUrl,
  fetchImpl = fetch,
  opmControlUrl = OPM_CONTROL_URL,
  ghImpl = runGh,
}) => {
  const existingState = await readState(sessionID)
  if (existingState?.phase === "complete" && await canonicalPath(directory) === existingState.primary) {
    await deleteState(sessionID)
  } else if (existingState) {
    throw new Error("this session already has a managed worktree")
  }
  const issueNumber = normalizeIssueNumber(issue)
  if (!issueNumber && !branch) throw new Error("branch is required for workspace start")
  const repository = await resolveRepository(directory)
  const claim = issueNumber
    ? await prepareIssueClaim({ issue: issueNumber, branch, primary: repository.primary, fetchImpl, opmControlUrl, ghImpl })
    : null
  const branchName = claim ? claim.branchName : normalizeBranch(branch)
  // Plain starts still learn whether the repository is OPM-managed so the goal's
  // completion criteria say "submit" rather than "merge"; detection failure here
  // is not fatal because finish re-detects before it would merge anything.
  let objectiveMode = claim ? "submit" : "finish"
  if (!claim) {
    try {
      const detection = await resolveOpmProject({ primary: repository.primary, fetchImpl, opmControlUrl })
      if (detection.project) objectiveMode = "submit"
    } catch {}
  }
  const releaseLock = await acquireRepositoryLock(repository.commonDirectory)
  let claimed = false
  try {
    if (await readState(sessionID)) throw new Error("this session already has a managed worktree")
    if (repository.root !== repository.primary) {
      throw new Error("workspace start is only allowed from the primary checkout")
    }
    if (await runGitStatus(repository.primary)) throw new Error("primary checkout must be clean before creating a worktree")
    const currentBranch = await runGit(repository.primary, ["branch", "--show-current"])
    if (currentBranch !== "main") throw new Error(`primary checkout must be on main, found ${currentBranch || "detached HEAD"}`)
    await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: repository.primary, fetchImpl })
    await runGit(repository.primary, ["fetch", "origin"])
    await runGit(repository.primary, ["merge", "--ff-only", "origin/main"])
    const originMain = await runGit(repository.primary, ["rev-parse", "origin/main"])
    if (await runGit(repository.primary, ["rev-parse", "HEAD"]) !== originMain) throw new Error("primary checkout does not match exact origin/main")
    if (await runGitStatus(repository.primary)) throw new Error("primary checkout changed while fetching origin")
    const session = await fetchSession({ serverUrl, sessionID, directory: repository.primary, fetchImpl })
    if (session.metadata?.openchamber?.goal) {
      throw new Error("this session already has a goal; complete or clear it before starting a managed worktree goal")
    }
    const request = claim
      ? claim.request
      : await fetchLatestUserRequest({ serverUrl, sessionID, directory: repository.primary, fetchImpl })
    const objective = buildManagedGoalObjective(request, GOAL_OBJECTIVE_CHAR_LIMIT, objectiveMode)
    const fullObjective = buildManagedGoalObjective(request, Number.POSITIVE_INFINITY, objectiveMode)
    const managedGoal = createManagedGoal(objective)
    const opm = claim ? { slug: claim.project.slug, ref: claim.issue, claimed: true } : null
    if (opm) managedGoal.opm = opm
    const target = await createTargetDirectory(branchName)
    let worktree = null
    let branchCreated = false
    // An adopted branch is planned at its remote head, not origin/main, so the
    // planned-worktree reconciler compares against the head it will really find.
    const expectedHead = claim?.adoptedBranch
      ? await (async () => {
        await runGit(repository.primary, ["fetch", "origin", branchName])
        return runGit(repository.primary, ["rev-parse", `origin/${branchName}`])
      })()
      : originMain
    try {
      const state = {
        version: STATE_VERSION,
        schemaRevision: 2,
        phase: "worktree-planned",
        sessionID,
        primary: repository.primary,
        commonDirectory: repository.commonDirectory,
        worktree: normalizePath(target),
        branch: branchName,
        originMain: expectedHead,
        managedGoalID: managedGoal.id,
        managedGoal,
        managedGoalObjective: fullObjective,
        ...(opm ? { opm } : {}),
        createdAt: Date.now(),
      }
      await writeState(state)
      if (claim) {
        // Claim before the worktree exists so OPM never races an attended session
        // for the same issue; the label is the only signal the supervisor sees.
        await ghImpl(["issue", "edit", String(claim.issue), "--repo", claim.repo, "--add-label", claim.project.claimedLabel], { cwd: repository.primary })
        claimed = true
      }
      if (claim?.adoptedBranch) {
        const localBranch = await runGit(repository.primary, ["branch", "--list", branchName])
        if (localBranch) {
          await runGit(repository.primary, ["worktree", "add", target, branchName])
        } else {
          await runGit(repository.primary, ["worktree", "add", "--track", "-b", branchName, target, `origin/${branchName}`])
          branchCreated = true
        }
      } else {
        await runGit(repository.primary, ["worktree", "add", "-b", branchName, target, "origin/main"])
        branchCreated = true
      }
      worktree = await canonicalPath(target)
      const managedRoot = await canonicalPath(path.dirname(target))
      if (!pathIsInside(managedRoot, worktree)) throw new Error("new worktree escaped the managed worktree root")
      if (!claim?.adoptedBranch) await runGit(worktree, ["branch", "--unset-upstream"]).catch(() => undefined)
      const targetRepository = await resolveRepository(worktree)
      if (targetRepository.commonDirectory !== repository.commonDirectory) throw new Error("new worktree belongs to a different Git repository")
      if (await runGit(worktree, ["rev-parse", "HEAD"]) !== expectedHead) {
        throw new Error(claim?.adoptedBranch ? `new worktree is not at origin/${branchName}` : "new worktree is not based on exact origin/main")
      }
      if (await runGit(worktree, ["branch", "--show-current"]) !== branchName) throw new Error("new worktree checked out an unexpected branch")
      state.phase = "moving-to-worktree"
      state.worktree = worktree
      await writeState(state)
      try {
        state.goalInstallAttempted = true
        await writeState(state)
        await patchSessionGoal({
          serverUrl,
          sessionID,
          directory: repository.primary,
          expectedGoalID: null,
          goal: managedGoal,
          fetchImpl,
        })
        await moveSession({ serverUrl, sessionID, destination: worktree, fetchImpl })
        await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: worktree, fetchImpl })
        // The goal is installed with worktree-moving before relocation. A
        // destination-scoped metadata request here deadlocks behind the active
        // turn that is currently executing this tool.
        state.phase = "attached"
        await writeState(state)
        if (claim) await kickOpm({ fetchImpl, opmControlUrl })
        return state
      } catch (error) {
        let rollbackError = null
        try {
          await moveSession({ serverUrl, sessionID, destination: repository.primary, fetchImpl })
          await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: repository.primary, fetchImpl })
          if (state.goalInstallAttempted) await restoreManagedGoal({ state, serverUrl, fetchImpl })
        } catch (caught) {
          rollbackError = caught
        }
        if (rollbackError) {
          state.phase = "move-failed"
          state.error = `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          await writeState(state)
          throw new Error(`session move failed and rollback could not be verified; worktree preserved at ${worktree}: ${state.error}`)
        }
        await deleteState(sessionID)
        await runGit(repository.primary, ["worktree", "remove", worktree]).catch(() => undefined)
        if (branchCreated) await runGit(repository.primary, ["branch", "-D", branchName]).catch(() => undefined)
        throw error
      }
    } catch (error) {
      const state = await readState(sessionID)
      if (state?.phase === "move-failed") throw error
      await deleteState(sessionID)
      if (worktree) await runGit(repository.primary, ["worktree", "remove", worktree]).catch(() => undefined)
      if (branchCreated) await runGit(repository.primary, ["branch", "-D", branchName]).catch(() => undefined)
      throw error
    }
  } catch (error) {
    // A claim without a worktree would hide the issue from OPM forever; release it
    // when start fails after labeling. Best effort: the error being thrown wins.
    if (claimed && claim) {
      await ghImpl(["issue", "edit", String(claim.issue), "--repo", claim.repo, "--remove-label", claim.project.claimedLabel], { cwd: repository.primary }).catch(() => undefined)
    }
    throw error
  } finally {
    await releaseLock()
  }
}

// Shared entry validation for finish and submit: the persisted state must still
// describe this repository and a registered worktree under an approved root.
const loadTeardownState = async (sessionID) => {
  const state = await readState(sessionID)
  if (!state) throw new Error("this session has no managed worktree")
  if (state.phase === "moving-to-worktree" || state.phase === "move-failed") {
    throw new Error(`session move state is uncertain; preserve ${state.worktree} and recover it manually`)
  }
  const repository = await resolveRepository(state.primary)
  if (!pathEquals(repository.primary, state.primary) || !pathEquals(repository.commonDirectory, state.commonDirectory)) {
    throw new Error("managed worktree state does not match the current Git repository")
  }
  let canonicalWorktree = null
  try { canonicalWorktree = await canonicalPath(state.worktree) } catch {}
  if (canonicalWorktree) {
    const insideApprovedRoot = await insideApprovedManagedRoot(canonicalWorktree)
    if (!pathEquals(normalizePath(state.worktree), canonicalWorktree) || !insideApprovedRoot) {
      throw new Error("managed worktree is outside the approved managed worktree root")
    }
    const worktreeRepository = await resolveRepository(canonicalWorktree)
    if (!pathEquals(worktreeRepository.root, state.worktree) || !pathEquals(worktreeRepository.commonDirectory, state.commonDirectory)) {
      throw new Error("managed worktree state does not match the registered Git worktree")
    }
  } else if (state.phase !== "cleanup-pending" && state.phase !== "goal-completion-pending") {
    throw new Error(`managed worktree is missing; preserve state and recover ${state.worktree} manually`)
  }
  return { state, repository }
}

export const finishWorkspace = async ({
  sessionID,
  directory,
  serverUrl,
  fetchImpl = fetch,
  deleteLocalBranch = true,
  devDeployment,
  isPullRequestMerged = hasMergedPullRequest,
  inspectNonproduction = inspectNonproductionWorkflow,
  opmControlUrl = OPM_CONTROL_URL,
  ghImpl = runGh,
  admissionTimeoutMs = SUBMIT_ADMISSION_TIMEOUT_MS,
  admissionPollMs = SUBMIT_ADMISSION_POLL_MS,
}) => {
  const { state } = await loadTeardownState(sessionID)

  // OPM-managed repositories never merge locally: finish becomes submit so the
  // work reaches the project's pipeline. A submit that was interrupted after its
  // handoff also resumes here because the ready-check tells the owner to finish.
  const submitOptions = { sessionID, directory, serverUrl, fetchImpl, deleteLocalBranch, opmControlUrl, ghImpl, admissionTimeoutMs, admissionPollMs }
  if (state.submitting === true) return submitWorkspace(submitOptions)
  if (state.phase === "attached" && state.returnPrepared !== true && state.managedGoalID) {
    const detection = await resolveOpmProject({ primary: state.primary, fetchImpl, opmControlUrl })
    if (detection.project) return submitWorkspace(submitOptions)
  }

  const actual = await canonicalPath(directory)
  const releaseLock = await acquireRepositoryLock(state.commonDirectory)
  try {
    const expected = expectedDirectoryForState(state)
    const resumedAfterMove = state.phase === "attached" && state.returnPrepared === true && actual === state.primary
    if (actual !== expected && !resumedAfterMove) throw new Error(`workspace cleanup must run from ${expected}`)

    if (state.phase === "attached" && !resumedAfterMove) {
      const deployment = state.managedGoalID
        ? (state.devDeployment ?? normalizeDevDeployment(devDeployment))
        : null
      await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: state.worktree, fetchImpl })
      if (await runGitStatus(state.worktree)) throw new Error("worktree is dirty; commit or remove local changes before cleanup")
      await runGit(state.primary, ["fetch", "origin"])
      const head = await runGit(state.worktree, ["rev-parse", "HEAD"])
      const remoteRefs = await branchIsOnRemote(state.primary, head)
      const merged = await isAncestor(state.primary, head, "origin/main")
      const mergedPullRequest = merged ? false : await isPullRequestMerged(state.primary, state.branch, head)
      if (remoteRefs.length === 0 && !merged && !mergedPullRequest) throw new Error("worktree HEAD is not present on origin and no merged pull request preserves it")
      if (!merged && !mergedPullRequest) throw new Error("worktree HEAD is not merged into origin/main")
      const currentOriginMain = await runGit(state.primary, ["rev-parse", "origin/main"])
      const integrationCommit = merged ? head : mergedPullRequest
      if (deployment && (!await isAncestor(state.primary, integrationCommit, deployment.commit) || !await isAncestor(state.primary, deployment.commit, currentOriginMain))) {
        throw new Error(`dev deployment commit must be a trusted origin/main descendant containing integration commit ${integrationCommit}`)
      }
      const deploymentWorkflow = deployment ? await inspectNonproduction(state.primary, deployment.commit) : null
      if (deploymentWorkflow?.required && !deploymentWorkflow.run) {
        throw new Error(`Deploy Platform Nonproduction did not complete successfully for ${deployment.commit}`)
      }
      const verifiedDeployment = deployment ? await verifyDevDeployment(deployment, fetchImpl) : null
      if (await runGitStatus(state.primary)) throw new Error("primary checkout must be clean before returning the session")
      if (await runGit(state.primary, ["branch", "--show-current"]) !== "main") throw new Error("primary checkout must be on main before returning the session")
      await runGit(state.primary, ["merge", "--ff-only", "origin/main"])
      state.head = head
      state.returnPrepared = true
      state.mergedPullRequest = Boolean(mergedPullRequest)
      state.integrationCommit = integrationCommit
      if (verifiedDeployment) {
        state.devDeployment = verifiedDeployment
        state.devDeployment.featureHead = head
        state.devDeployment.workflow = deploymentWorkflow?.run || null
      }
      await writeState(state)
    } else if (resumedAfterMove) {
      await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: state.primary, fetchImpl })
    }

    if (state.phase === "attached" || state.phase === "cleanup-pending") {
      await relocateWorktreeSessions({
        serverUrl,
        currentSessionID: sessionID,
        source: state.worktree,
        destination: state.primary,
        fetchImpl,
      })
      await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: state.primary, fetchImpl })
      state.phase = "cleanup-pending"
      await writeState(state)
    }

    const registeredWorktrees = await runGit(state.primary, ["worktree", "list", "--porcelain"])
    if (registeredWorktrees.split("\n").includes(`worktree ${state.worktree}`)) {
      const remainingSessions = await listSessionsInDirectory({ serverUrl, directory: state.worktree, fetchImpl })
      if (remainingSessions.length > 0) {
        throw new Error(`refusing to remove worktree with attached sessions: ${remainingSessions.map((session) => session.id).join(", ")}`)
      }
      await runGit(state.primary, ["worktree", "remove", state.worktree])
    }
    const localBranch = await runGit(state.primary, ["branch", "--list", state.branch])
    if (deleteLocalBranch && localBranch) {
      const merged = await isAncestor(state.primary, state.head, "origin/main")
      const mergedPullRequest = state.mergedPullRequest === true || (!merged && await isPullRequestMerged(state.primary, state.branch, state.head))
      if (merged) await runGit(state.primary, ["branch", "-d", state.branch])
      else if (mergedPullRequest) await runGit(state.primary, ["branch", "-D", state.branch])
    }
    if (state.managedGoalID) {
      state.phase = "goal-completion-pending"
      await writeState(state)
      await completeManagedGoal({ state, serverUrl, fetchImpl })
    }
    state.phase = "complete"
    state.completedAt = Date.now()
    await writeState(state)
    return state
  } finally {
    await releaseLock()
  }
}

export const abandonWorkspace = async ({
  sessionID,
  directory,
  serverUrl,
  fetchImpl = fetch,
  confirmDiscardUnpublished = false,
  deleteLocalBranch = true,
}) => {
  const state = await readState(sessionID)
  if (!state) throw new Error("this session has no managed worktree")
  if (state.phase !== "attached") throw new Error(`cannot abandon a managed worktree in phase ${state.phase}`)
  const actual = await canonicalPath(directory)
  const resumed = state.abandoning === true && pathEquals(actual, state.primary)
  if (!resumed && !pathEquals(actual, state.worktree)) throw new Error(`workspace abandon must run from ${state.worktree}`)
  const repository = await resolveRepository(state.primary)
  if (!pathEquals(repository.commonDirectory, state.commonDirectory)) throw new Error("managed worktree state does not match the current Git repository")
  const releaseLock = await acquireRepositoryLock(state.commonDirectory)
  try {
    if (!resumed) {
      await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: state.worktree, fetchImpl })
      const dirty = await runGitStatus(state.worktree)
      await runGit(state.primary, ["fetch", "origin"])
      const head = await runGit(state.worktree, ["rev-parse", "HEAD"])
      const remoteRefs = await branchIsOnRemote(state.primary, head)
      const unpublishedCommit = head !== state.originMain && remoteRefs.length === 0
      if ((dirty || unpublishedCommit) && confirmDiscardUnpublished !== true) {
        throw new Error("abandon would discard unpublished changes; push them or obtain explicit owner confirmation")
      }
      state.abandonData = {
        dirty: Boolean(dirty),
        head,
        remoteRefs,
        unpublishedCommit,
        discardConfirmed: confirmDiscardUnpublished === true,
      }
      state.returnPrepared = true
      state.abandoning = true
      await writeState(state)
    }
    const { dirty, remoteRefs, unpublishedCommit, discardConfirmed } = state.abandonData
    await relocateWorktreeSessions({
      serverUrl,
      currentSessionID: sessionID,
      source: state.worktree,
      destination: state.primary,
      fetchImpl,
    })
    await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: state.primary, fetchImpl })
    const registered = await runGit(state.primary, ["worktree", "list", "--porcelain"])
    if (registered.split("\n").includes(`worktree ${state.worktree}`)) {
      const remaining = await listSessionsInDirectory({ serverUrl, directory: state.worktree, fetchImpl })
      if (remaining.length > 0) throw new Error(`refusing to remove worktree with attached sessions: ${remaining.map((session) => session.id).join(", ")}`)
      await runGit(state.primary, ["worktree", "remove", ...(dirty ? ["--force"] : []), state.worktree])
    }
    const localBranch = await runGit(state.primary, ["branch", "--list", state.branch])
    if (deleteLocalBranch && localBranch && (!unpublishedCommit || discardConfirmed)) {
      await runGit(state.primary, ["branch", "-D", state.branch])
    }
    const cancelledGoal = await patchSessionGoal({
      serverUrl,
      sessionID,
      directory: state.primary,
      expectedGoalID: state.managedGoalID,
      mutateGoal: (current) => ({
        ...current,
        managedWorktree: false,
        status: "cancelled",
        statusReason: "cancelled by owner",
        note: remoteRefs.length > 0
          ? `Preserved on ${remoteRefs.join(", ")}.`
          : discardConfirmed
            ? "Unpublished work was discarded with explicit owner confirmation."
            : "Cancelled before unpublished work was created.",
        updatedAt: Date.now(),
      }),
      fetchImpl,
    })
    await writeGoalProgress(sessionID, cancelledGoal)
    state.phase = "complete"
    state.outcome = "cancelled"
    state.cancelledAt = Date.now()
    await writeState(state)
    return state
  } finally {
    await releaseLock()
  }
}

const completeSubmittedGoal = async ({ state, serverUrl, fetchImpl }) => {
  const submission = state.submission
  const session = await fetchSession({ serverUrl, sessionID: state.sessionID, directory: state.primary, fetchImpl })
  const currentGoal = session.metadata?.openchamber?.goal
  if (
    currentGoal?.id === state.managedGoalID
    && currentGoal.managedWorktree !== true
    && currentGoal.status === "complete"
    && currentGoal.opm?.slug === submission.slug
    && String(currentGoal.opm?.ref) === String(submission.ref)
  ) return currentGoal
  const note = `submitted as ${submission.slug}#${submission.ref} (${submission.pr})`.slice(0, 280)
  const completedGoal = await patchSessionGoal({
    serverUrl,
    sessionID: state.sessionID,
    directory: state.primary,
    expectedGoalID: state.managedGoalID,
    mutateGoal: (goal) => {
      if (goal?.managedWorktree !== true) {
        throw new Error("managed session goal is missing or was replaced before lifecycle completion")
      }
      return {
        ...goal,
        managedWorktree: false,
        status: "complete",
        statusReason: "submitted to OPM",
        note,
        opm: {
          ...(goal.opm && typeof goal.opm === "object" ? goal.opm : {}),
          slug: submission.slug,
          ref: submission.ref,
          pr: submission.pr,
          admissionVerified: submission.admissionVerified === true,
        },
        blockedStreak: 0,
        auditFailStreak: 0,
        updatedAt: Date.now(),
      }
    },
    fetchImpl,
  })
  await writeGoalProgress(state.sessionID, completedGoal)
  return completedGoal
}

const submissionSummary = (submission) => [
  `Submitted as ${submission.slug}#${submission.ref} (${submission.pr}).`,
  submission.admissionVerified
    ? `OPM admission observed (${submission.admissionState}).`
    : "OPM admission was not observed within the wait window; the issue and pull request exist and OPM will pick them up on its next pass.",
].join(" ")

const ensureOpenPullRequest = async ({ gh, repo, primary, branch, defaultBranch, title, body }) => {
  const existing = parseGhJson(await gh([
    "pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url", "--limit", "20",
  ], { cwd: primary }), [])
  const open = Array.isArray(existing) ? existing.find((record) => typeof record?.url === "string") : null
  if (open) return { url: open.url, number: open.number, created: false }
  const output = await gh([
    "pr", "create", "--repo", repo, "--head", branch, "--base", defaultBranch, "--title", title, "--body", body,
  ], { cwd: primary })
  const url = String(output).split(/\s+/).find((token) => /^https?:\/\/.+\/pull\/\d+$/.test(token))
  if (!url) throw new Error("gh pr create did not return a pull request URL")
  return { url, number: Number(url.match(/\/pull\/(\d+)$/)[1]), created: true }
}

const submissionIssueBody = ({ requestText, marker, prUrl }) => [
  requestText.slice(0, 4_000),
  "",
  marker,
  `Change: ${prUrl}`,
  "",
  "Submitted from interactive session via session_workspace submit.",
].join("\n")

// Reuse an issue: append this branch's marker and PR link exactly once. A marker
// for a different branch means the issue is already paired with other work, so
// stacking a second marker would make OPM's adoption ambiguous.
const attachBranchToIssue = async ({ gh, repo, primary, issue, branch, head, prUrl, labels, claimedLabel }) => {
  const record = parseGhJson(await gh([
    "issue", "view", String(issue), "--repo", repo, "--json", "number,title,body,state,labels,url",
  ], { cwd: primary }), null)
  if (!record || typeof record !== "object") throw new Error(`issue #${issue} could not be read`)
  if (String(record.state || "").toUpperCase() !== "OPEN") throw new Error(`issue #${issue} is not open`)
  const markers = parseBranchMarkers(record.body)
  const foreign = markers.find((entry) => entry.branch !== branch)
  if (foreign) throw new Error(`issue #${issue} already carries a branch marker for ${foreign.branch}; submit cannot reuse it for ${branch}`)
  const marker = formatBranchMarker(branch, head)
  let body = String(record.body || "")
  const own = markers.find((entry) => entry.branch === branch)
  if (own) {
    if (own.head !== head) body = body.replace(own.text, marker)
    if (!body.includes(prUrl)) body = `${body.trimEnd()}\nChange: ${prUrl}\n`
  } else {
    body = `${body.trimEnd()}\n\n${marker}\nChange: ${prUrl}\n\nSubmitted from interactive session via session_workspace submit.\n`
  }
  const currentLabels = new Set((Array.isArray(record.labels) ? record.labels : []).map((label) => label?.name).filter(Boolean))
  const missingLabels = labels.filter((label) => !currentLabels.has(label))
  const args = ["issue", "edit", String(issue), "--repo", repo, "--body", body]
  if (missingLabels.length > 0) args.push("--add-label", missingLabels.join(","))
  // A submitted claim is released to the pipeline: the claimed label only ever
  // meant "an attended session is working on this", and that session is done.
  if (claimedLabel && currentLabels.has(claimedLabel)) args.push("--remove-label", claimedLabel)
  await gh(args, { cwd: primary })
  return { number: Number(record.number || issue), url: String(record.url || "") }
}

const findIssueForBranch = async ({ gh, repo, primary, branch }) => {
  const records = parseGhJson(await gh([
    "issue", "list", "--repo", repo, "--state", "open", "--search", `opm:branch ${branch}@`, "--json", "number,body,url", "--limit", "50",
  ], { cwd: primary }), [])
  if (!Array.isArray(records)) return null
  for (const record of records) {
    if (parseBranchMarkers(record?.body).some((entry) => entry.branch === branch)) {
      return { number: Number(record.number), url: String(record.url || "") }
    }
  }
  return null
}

const repositoryLabels = async ({ gh, repo, primary }) => {
  const records = parseGhJson(await gh([
    "label", "list", "--repo", repo, "--json", "name", "--limit", "500",
  ], { cwd: primary }), [])
  return new Set((Array.isArray(records) ? records : []).map((record) => record?.name).filter(Boolean))
}

// Door B: hand the session's completed work to OPM's pipeline. This is explicit and
// announced work transfer, never a way to end a turn early: the session may only
// submit its own pushed branch, and the caller must state the resulting slug#ref.
// Teardown mirrors abandonWorkspace: relocate every attached session, remove the
// worktree, delete the local branch only with remote proof, then settle the goal.
export const submitWorkspace = async ({
  sessionID,
  directory,
  serverUrl,
  fetchImpl = fetch,
  title,
  class: requestedClass,
  issue,
  urgent = false,
  deleteLocalBranch = true,
  opmControlUrl = OPM_CONTROL_URL,
  ghImpl = runGh,
  admissionTimeoutMs = SUBMIT_ADMISSION_TIMEOUT_MS,
  admissionPollMs = SUBMIT_ADMISSION_POLL_MS,
}) => {
  const preliminary = await readState(sessionID)
  if (!preliminary) throw new Error("this session has no managed worktree")
  if (preliminary.phase !== "attached") throw new Error(`cannot submit a managed worktree in phase ${preliminary.phase}`)
  const { state } = await loadTeardownState(sessionID)
  if (state.waitingExternal === true) throw new Error("cannot submit while the session is waiting for an external wake")
  if (state.abandoning === true) throw new Error("cannot submit a worktree whose abandonment is in progress")
  if (state.returnPrepared === true && state.submitting !== true) {
    throw new Error("this worktree already prepared a finish; run session_workspace with action=finish to complete it")
  }
  const actual = await canonicalPath(directory)
  const resumed = state.submitting === true && (pathEquals(actual, state.primary) || pathEquals(actual, state.worktree))
  if (!resumed && !pathEquals(actual, state.worktree)) throw new Error(`workspace submit must run from ${state.worktree}`)
  const requestedIssue = normalizeIssueNumber(issue)
  const explicitClass = normalizeChangeClass(requestedClass)
  const releaseLock = await acquireRepositoryLock(state.commonDirectory)
  try {
    // The handoff (push, PR, issue, kick) runs once. A retry after a teardown
    // failure finds `submitting` persisted and goes straight to relocation, so a
    // busy peer session cannot cause a second issue or a second admission wait.
    if (!resumed) {
      if (!state.managedGoalID) throw new Error("submit requires a managed goal; this worktree was created by an older overlay")
      await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: state.worktree, fetchImpl })
      const detection = await resolveOpmProject({ primary: state.primary, fetchImpl, opmControlUrl })
      const project = detection.project
      if (!project) throw new Error("repository is not OPM-managed; use finish")
      const pairedIssue = requestedIssue ?? normalizeIssueNumber(state.opm?.ref)
      await requireOpmCapabilities({
        fetchImpl,
        opmControlUrl,
        required: pairedIssue ? ["branch-adoption", "attended-claim"] : ["branch-adoption"],
      })

      const requestText = extractGoalRequest(state.managedGoalObjective || state.managedGoal?.objective)
      const existingJournal = await readSubmitJournal(sessionID)
      const journal = existingJournal?.branch === state.branch ? existingJournal : null
      const submitTitle = normalizeSubmitTitle(title ?? journal?.title, requestText)
      const repo = await runGit(state.primary, ["remote", "get-url", "origin"])
      // `gh` resolves the repository from --repo, so every call below is explicit
      // about the origin remote rather than trusting the cwd's remote set.
      const gh = ghImpl

      if (await runGitStatus(state.worktree)) {
        await runGit(state.worktree, ["add", "-A"])
        await runGit(state.worktree, ["commit", "-m", submitTitle])
      }
      await runGit(state.worktree, ["push", "-u", "origin", state.branch])
      await runGit(state.primary, ["fetch", "origin"])
      const head = await runGit(state.worktree, ["rev-parse", "HEAD"])
      if ((await branchIsOnRemote(state.primary, head)).length === 0) {
        throw new Error("worktree HEAD is not present on origin after push; refusing to submit unpublished work")
      }
      const defaultRef = `origin/${project.defaultBranch}`
      if (await isAncestor(state.primary, head, defaultRef)) {
        throw new Error(`nothing to submit: worktree HEAD is already contained in ${defaultRef}`)
      }
      const changedPaths = (await runGit(state.worktree, ["diff", "--name-only", `${defaultRef}...HEAD`])).split("\n").filter(Boolean)
      const changeClass = explicitClass ?? journal?.class ?? inferChangeClass(changedPaths)

      // The journal is the idempotency anchor: it exists before any issue does.
      const nextJournal = {
        ...(journal || {}),
        branch: state.branch,
        headSha: head,
        title: submitTitle,
        class: changeClass,
        ...(pairedIssue ? { issue: pairedIssue } : {}),
        createdAt: journal?.createdAt ?? Date.now(),
      }
      await writeSubmitJournal(sessionID, nextJournal)

      const knownIssue = pairedIssue ?? normalizeIssueNumber(journal?.issue)
      const pullRequest = await ensureOpenPullRequest({
        gh,
        repo,
        primary: state.primary,
        branch: state.branch,
        defaultBranch: project.defaultBranch,
        title: submitTitle,
        body: knownIssue
          ? `Refs #${knownIssue}\n\nSubmitted from an interactive session via session_workspace submit.`
          : "Submitted from an interactive session; tracking issue filed by OPM submit.",
      })
      nextJournal.pr = pullRequest.url
      await writeSubmitJournal(sessionID, nextJournal)

      const available = await repositoryLabels({ gh, repo, primary: state.primary })
      const classLabel = OPM_CLASS_LABELS[changeClass]
      const labels = [project.readyLabel]
      if (classLabel && available.has(classLabel)) labels.push(classLabel)
      if (urgent === true && available.has(OPM_URGENT_LABEL)) labels.push(OPM_URGENT_LABEL)

      const marker = formatBranchMarker(state.branch, head)
      const attach = (issueNumber) => attachBranchToIssue({
        gh,
        repo,
        primary: state.primary,
        issue: issueNumber,
        branch: state.branch,
        head,
        prUrl: pullRequest.url,
        labels,
        claimedLabel: project.claimedLabel,
      })
      let issueRecord
      if (knownIssue) {
        issueRecord = await attach(knownIssue)
      } else {
        issueRecord = await findIssueForBranch({ gh, repo, primary: state.primary, branch: state.branch })
        if (issueRecord) {
          issueRecord = await attach(issueRecord.number)
        } else {
          const output = await gh([
            "issue", "create", "--repo", repo, "--title", submitTitle, "--label", labels.join(","),
            "--body", submissionIssueBody({ requestText, marker, prUrl: pullRequest.url }),
          ], { cwd: state.primary })
          issueRecord = parseCreatedIssue(output)
        }
        if (pullRequest.created) {
          await gh([
            "pr", "edit", pullRequest.url, "--repo", repo, "--body",
            `Refs #${issueRecord.number}\n\nSubmitted from an interactive session via session_workspace submit.`,
          ], { cwd: state.primary })
        }
      }
      nextJournal.issue = issueRecord.number
      await writeSubmitJournal(sessionID, nextJournal)

      await kickOpm({ fetchImpl, opmControlUrl })
      const admission = await waitForOpmAdmission({
        fetchImpl,
        opmControlUrl,
        slug: project.slug,
        ref: issueRecord.number,
        timeoutMs: admissionTimeoutMs,
        pollMs: admissionPollMs,
      })

      state.head = head
      state.returnPrepared = true
      state.submitting = true
      state.submission = {
        title: submitTitle,
        class: changeClass,
        slug: project.slug,
        ref: issueRecord.number,
        issueUrl: issueRecord.url,
        pr: pullRequest.url,
        head,
        detectionSource: detection.source,
        admissionVerified: admission.admissionVerified,
        admissionState: admission.admissionState,
        submittedAt: Date.now(),
      }
      await writeState(state)
    }
    if (!state.submission) throw new Error("submit state is missing its submission record; recover the lifecycle manually")

    await relocateWorktreeSessions({
      serverUrl,
      currentSessionID: sessionID,
      source: state.worktree,
      destination: state.primary,
      fetchImpl,
    })
    await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: state.primary, fetchImpl })
    const registered = await runGit(state.primary, ["worktree", "list", "--porcelain"])
    if (registered.split("\n").includes(`worktree ${state.worktree}`)) {
      const remaining = await listSessionsInDirectory({ serverUrl, directory: state.worktree, fetchImpl })
      if (remaining.length > 0) throw new Error(`refusing to remove worktree with attached sessions: ${remaining.map((session) => session.id).join(", ")}`)
      await runGit(state.primary, ["worktree", "remove", state.worktree])
    }
    const localBranch = await runGit(state.primary, ["branch", "--list", state.branch])
    if (deleteLocalBranch && localBranch) {
      // Nothing is merged yet, so the only acceptable proof is that origin holds
      // the exact head; a branch that origin lost is preserved locally.
      const remoteRefs = await branchIsOnRemote(state.primary, state.head)
      if (remoteRefs.length > 0) await runGit(state.primary, ["branch", "-D", state.branch])
    }
    await completeSubmittedGoal({ state, serverUrl, fetchImpl })
    state.phase = "complete"
    state.outcome = "submitted"
    state.completedAt = Date.now()
    state.summary = submissionSummary(state.submission)
    await writeState(state)
    return state
  } finally {
    await releaseLock()
  }
}

export const __testing = {
  normalizeBranch,
  buildManagedGoalObjective,
  extractGoalRequest,
  normalizeSubmitTitle,
  submitJournalPath,
  readSubmitJournal,
  writeSubmitJournal,
  resolveOpmProject,
  requireOpmCapabilities,
  inferChangeClass,
  deriveIssueBranch,
  formatBranchMarker,
  parseBranchMarkers,
  opmConfigPath,
  createManagedGoal,
  managedWorktreeRoot,
  legacyManagedWorktreeRoot,
  createTargetDirectory,
  normalizeDevDeployment,
  readState,
  statePath,
  writeState,
  verifyDevDeployment,
  inspectNonproductionWorkflow,
  moveSession,
}

export const reconcilePlannedWorktrees = async ({ serverUrl, fetchImpl = fetch } = {}) => {
  let entries = []
  try { entries = await readdir(stateDirectory()) } catch { return [] }
  const reconciled = []
  for (const entry of entries) {
    if (!isSessionStateEntry(entry)) continue
    const sessionID = entry.slice(0, -5)
    const state = await readState(sessionID).catch(() => null)
    if (!state || !["worktree-planned", "moving-to-worktree"].includes(state.phase)) continue
    const exists = await access(state.worktree).then(() => true, () => false)
    if (!exists) {
      if (state.phase === "worktree-planned" && state.goalInstallAttempted !== true) {
        await deleteState(sessionID)
        reconciled.push({ sessionID, action: "cleared-missing-plan" })
      } else {
        state.phase = "move-failed"
        state.error = "planned worktree recovery could not find the worktree after enrollment began"
        await writeState(state)
        reconciled.push({ sessionID, action: "preserved-ambiguous" })
      }
      continue
    }
    let safe = false
    try {
      safe = await runGitStatus(state.worktree) === ""
        && await runGit(state.worktree, ["rev-parse", "HEAD"]) === state.originMain
        && await runGit(state.worktree, ["branch", "--show-current"]) === state.branch
    } catch {}
    if (!safe) {
      state.phase = "move-failed"
      state.error = "planned worktree recovery found local changes or mismatched Git state"
      await writeState(state)
      reconciled.push({ sessionID, action: "preserved-ambiguous" })
      continue
    }
    try {
      const response = await fetchImpl(new URL("experimental/session?archived=true&limit=10000", serverUrl))
      if (!response.ok) throw new Error(`unable to resolve planned session (${response.status})`)
      const payload = await response.json()
      const sessions = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : [])
      const session = sessions.find((candidate) => candidate?.id === sessionID)
      if (!session?.directory) throw new Error("planned session is missing")
      const authoritative = await canonicalPath(session.directory)
      if (![state.primary, state.worktree].some((candidate) => pathEquals(candidate, authoritative))) {
        throw new Error("planned session is attached to an unexpected directory")
      }
      const metadata = await fetchSession({ serverUrl, sessionID, directory: authoritative, fetchImpl })
      const goal = metadata.metadata?.openchamber?.goal ?? null
      if (goal && goal.id !== state.managedGoalID) throw new Error("planned session has a different managed goal")
      if (authoritative === state.worktree && !goal) throw new Error("planned session moved without its managed goal")
      const attached = await listSessionsInDirectory({ serverUrl, directory: state.worktree, fetchImpl })
      const unrelated = attached.filter((candidate) => candidate.id !== sessionID)
      if (unrelated.length > 0) throw new Error(`planned worktree has unrelated attached sessions: ${unrelated.map((candidate) => candidate.id).join(", ")}`)
      state.phase = "moving-to-worktree"
      state.goalInstallAttempted = true
      await writeState(state)
      if (!goal) {
        await patchSessionGoal({
          serverUrl,
          sessionID,
          directory: state.primary,
          expectedGoalID: null,
          goal: state.managedGoal,
          fetchImpl,
        })
      }
      if (authoritative === state.primary) {
        await moveSession({ serverUrl, sessionID, destination: state.worktree, fetchImpl })
        await assertAuthoritativeSessionDirectory({ serverUrl, sessionID, directory: state.worktree, fetchImpl })
      }
      await patchSessionGoal({
        serverUrl,
        sessionID,
        directory: state.worktree,
        expectedGoalID: state.managedGoalID,
        mutateGoal: (current) => ({ ...current, statusReason: "worktree-moving", updatedAt: Date.now() }),
        fetchImpl,
      })
      state.phase = "attached"
      delete state.error
      await writeState(state)
      reconciled.push({ sessionID, action: "adopted-exact-partial" })
    } catch (error) {
      state.phase = "move-failed"
      state.error = `planned worktree recovery preserved ambiguous state: ${error instanceof Error ? error.message : String(error)}`
      await writeState(state)
      reconciled.push({ sessionID, action: "preserved-ambiguous" })
    }
  }
  return reconciled
}
