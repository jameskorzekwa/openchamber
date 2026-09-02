const WAITING_KEY = "backgroundJobs"
const PTY_SPAWN_BLOCK = /<pty_spawned>[\s\S]*?\nID:\s*(pty_[A-Za-z0-9]+)[\s\S]*?<\/pty_spawned>/
const PTY_EXIT_BLOCK = /<pty_exited>[\s\S]*?\nID:\s*(pty_[A-Za-z0-9]+)[\s\S]*?<\/pty_exited>/g

const asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {}

const sessionUrl = (serverUrl, sessionID, directory) => {
  const url = new URL(`session/${encodeURIComponent(sessionID)}`, serverUrl)
  url.searchParams.set("directory", directory)
  return url
}

export const parsePtySpawnID = (output) => {
  if (typeof output !== "string") return null
  return PTY_SPAWN_BLOCK.exec(output)?.[1] ?? null
}

export const parsePtyExitIDs = (parts) => {
  const ids = new Set()
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue
    for (const match of part.text.matchAll(PTY_EXIT_BLOCK)) ids.add(match[1])
  }
  return [...ids]
}

export const createPtyWaitingState = ({
  serverUrl,
  directory,
  fetchImpl = fetch,
  now = Date.now,
  logger = console,
} = {}) => {
  if (!serverUrl) throw new Error("serverUrl is required")
  if (!directory) throw new Error("directory is required")

  const jobsByID = new Map()
  const jobsBySession = new Map()
  const completedBeforeRegistration = new Set()
  const sessionQueues = new Map()

  const enqueue = (sessionID, operation) => {
    const previous = sessionQueues.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    sessionQueues.set(sessionID, next)
    void next.finally(() => {
      if (sessionQueues.get(sessionID) === next) sessionQueues.delete(sessionID)
    }).catch(() => {})
    return next
  }

  const jobsForSession = (sessionID) => [...(jobsBySession.get(sessionID)?.values() ?? [])]
    .sort((left, right) => left.createdAt - right.createdAt)

  const writeSessionJobs = async (sessionID) => {
    const url = sessionUrl(serverUrl, sessionID, directory)
    const currentResponse = await fetchImpl(url)
    if (!currentResponse.ok) throw new Error(`unable to read PTY owner session (${currentResponse.status})`)
    const session = await currentResponse.json()
    const metadata = asObject(session?.metadata)
    const namespace = asObject(metadata.openchamber)
    const waiting = asObject(namespace[WAITING_KEY])
    const goal = asObject(namespace.goal)
    const jobs = jobsForSession(sessionID)
    const resumeGoalID = typeof waiting.resumeGoalID === "string" && waiting.resumeGoalID
      ? waiting.resumeGoalID
      : (goal.status === "active" && typeof goal.id === "string" && goal.id ? goal.id : null)
    const nextNamespace = { ...namespace }
    if (jobs.length > 0) {
      nextNamespace[WAITING_KEY] = {
        version: 1,
        updatedAt: now(),
        jobs,
        ...(resumeGoalID ? { resumeGoalID } : {}),
      }
    } else {
      delete nextNamespace[WAITING_KEY]
      if (resumeGoalID && goal.id === resumeGoalID && goal.status === "blocked") {
        nextNamespace.goal = {
          ...goal,
          status: "active",
          statusReason: "",
          blockedStreak: 0,
          auditFailStreak: 0,
          updatedAt: now(),
        }
      }
    }
    const nextMetadata = { ...metadata }
    if (Object.keys(nextNamespace).length > 0) nextMetadata.openchamber = nextNamespace
    else delete nextMetadata.openchamber
    const updateResponse = await fetchImpl(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ metadata: nextMetadata }),
    })
    if (!updateResponse.ok) throw new Error(`unable to update PTY waiting state (${updateResponse.status})`)
  }

  const syncSession = (sessionID) => enqueue(sessionID, () => writeSessionJobs(sessionID))

  const register = async ({ id, sessionID, description, title, timeoutSeconds }) => {
    if (!id || !sessionID) return false
    if (completedBeforeRegistration.delete(id)) return false
    const job = {
      id,
      kind: "pty",
      description: description || title || "Background process",
      createdAt: now(),
      ...(Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
    }
    jobsByID.set(id, { sessionID, job })
    const sessionJobs = jobsBySession.get(sessionID) ?? new Map()
    sessionJobs.set(id, job)
    jobsBySession.set(sessionID, sessionJobs)
    await syncSession(sessionID)
    return true
  }

  const complete = async (id) => {
    const registered = jobsByID.get(id)
    if (!registered) {
      completedBeforeRegistration.add(id)
      if (completedBeforeRegistration.size > 1_000) {
        completedBeforeRegistration.delete(completedBeforeRegistration.values().next().value)
      }
      return false
    }
    jobsByID.delete(id)
    const sessionJobs = jobsBySession.get(registered.sessionID)
    sessionJobs?.delete(id)
    if (sessionJobs?.size === 0) jobsBySession.delete(registered.sessionID)
    await syncSession(registered.sessionID)
    return true
  }

  const recover = async () => {
    const url = new URL("session", serverUrl)
    url.searchParams.set("directory", directory)
    url.searchParams.set("limit", "500")
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`unable to list sessions for PTY waiting recovery (${response.status})`)
    const payload = await response.json()
    const sessions = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : [])
    for (const session of sessions) {
      if (!asObject(session?.metadata?.openchamber)[WAITING_KEY]) continue
      await syncSession(session.id)
    }
  }

  const warn = (operation, error) => {
    logger.warn?.(`[pty-waiting] ${operation} failed:`, error?.message || error)
  }

  return {
    register,
    complete,
    recover,
    jobsForSession,
    async handleExitParts(parts) {
      await Promise.all(parsePtyExitIDs(parts).map((id) => (
        complete(id).catch((error) => warn("exit notification sync", error))
      )))
    },
  }
}
