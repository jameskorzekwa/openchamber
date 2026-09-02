import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// Ported from the retired Heirloom agent bridge (rotary_phone
// tools/agent-bridge/test/lifecycle.test.mjs) when agent-config became the
// canonical home of the installed lifecycle. These cover the capabilities the
// bridge added: planned-worktree reconciliation, timeout-verified session moves,
// symlink-safe checkout restoration, external wait/wake, abandon, and the
// nonproduction deployment gates. The state directory is redirected through the
// environment before the module loads because stateDirectory() is read lazily.
const directory = await mkdtemp(path.join(os.tmpdir(), "heirloom-lifecycle-test-"))
process.env.HEIRLOOM_AGENT_LIFECYCLE_STATE_DIR = directory
const {
  __testing,
  abandonWorkspace,
  reconcilePlannedWorktrees,
  restoreMissingWorktree,
  resumeWorkspaceFromExternalWait,
  waitForExternal,
} = await import("../lib/session-worktree-lifecycle.mjs")

test.after(async () => rm(directory, { recursive: true, force: true }))

test("roots managed worktrees on persistent storage the OS never reclaims", async () => {
  assert.equal(__testing.managedWorktreeRoot(), path.join(os.homedir(), ".local", "state", "opencode", "worktrees"))
  assert.equal(__testing.legacyManagedWorktreeRoot(), path.join(os.tmpdir(), "opencode"))

  // The invariant is where a new worktree actually lands, not what the constant says.
  // createTargetDirectory creates the root, so it must run before resolving it.
  const target = await __testing.createTargetDirectory("agent/38769771/issue-1")
  const root = await realpath(__testing.managedWorktreeRoot())
  const temporary = await realpath(os.tmpdir())
  assert.ok(target.startsWith(`${root}${path.sep}`), `new worktrees must be created under ${root}`)
  assert.ok(
    !target.startsWith(`${temporary}${path.sep}`),
    "new worktrees must never be created under the Darwin temp root that dirhelper purges at boot",
  )
})

test("recreates a purged managed checkout and refuses paths outside both roots", async () => {
  // The legacy root is still approved, so it is the only root a test may write to.
  // Nothing creates it any more, and mkdtemp does not create parents, so make it here.
  const legacyRoot = __testing.legacyManagedWorktreeRoot()
  await mkdir(legacyRoot, { recursive: true })
  const managed = await mkdtemp(path.join(legacyRoot, "heirloom-restore-"))
  const repositoryRoot = await mkdtemp(path.join(directory, "restore-repository-"))
  const origin = path.join(repositoryRoot, "origin.git")
  const primary = path.join(repositoryRoot, "primary")
  const worktree = path.join(managed, "issue-restore")
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
  try {
    execFileSync("git", ["init", "--bare", origin])
    execFileSync("git", ["clone", origin, primary])
    git(primary, "config", "user.name", "Bridge Test")
    git(primary, "config", "user.email", "bridge@example.invalid")
    await writeFile(path.join(primary, "README.md"), "fixture\n")
    git(primary, "add", "README.md")
    git(primary, "commit", "-m", "Fixture")
    git(primary, "branch", "-M", "main")
    git(primary, "push", "-u", "origin", "main")
    git(primary, "worktree", "add", "-b", "agent/38769771/issue-restore", worktree, "origin/main")
    await writeFile(path.join(worktree, "committed.txt"), "kept\n")
    git(worktree, "add", "committed.txt")
    git(worktree, "commit", "-m", "Work that must survive")
    const state = {
      primary: await realpath(primary),
      commonDirectory: await realpath(git(primary, "rev-parse", "--path-format=absolute", "--git-common-dir")),
      worktree: await realpath(worktree),
      branch: "agent/38769771/issue-restore",
    }
    const head = git(worktree, "rev-parse", "HEAD")

    assert.equal(await restoreMissingWorktree(state), false, "a present worktree must not be touched")

    await rm(worktree, { recursive: true, force: true })
    assert.equal(await restoreMissingWorktree(state), true)
    await access(path.join(worktree, "committed.txt"))
    assert.equal(git(worktree, "rev-parse", "HEAD"), head, "committed work must survive the purge")
    assert.equal(git(worktree, "branch", "--show-current"), state.branch)

    // A recorded path outside every approved root is not a managed worktree.
    const stray = path.join(repositoryRoot, "stray-worktree")
    assert.equal(await restoreMissingWorktree({ ...state, worktree: stray }), false)
    await assert.rejects(access(stray), "restore must not materialize a checkout outside the approved roots")

    // Lexically inside an approved root, but an intermediate symlink leaves it.
    const escape = path.join(managed, "escape")
    await symlink(repositoryRoot, escape, "dir")
    const smuggled = path.join(escape, "smuggled-worktree")
    assert.equal(await restoreMissingWorktree({ ...state, worktree: smuggled }), false)
    await assert.rejects(access(smuggled), "an intermediate symlink must not smuggle a checkout out of the roots")

    // `path.resolve` collapses `escape/..` lexically to a path inside the root,
    // while the kernel resolves the symlink first and lands outside it. Git uses
    // the raw path, so such a path is refused outright rather than walked.
    // Built by concatenation because path.join would collapse the segment itself.
    const traversed = [managed, "escape", "..", "traversed-worktree"].join(path.sep)
    const lexical = path.resolve(traversed)
    const actual = path.join(path.dirname(repositoryRoot), "traversed-worktree")
    assert.notEqual(traversed, lexical)
    assert.ok(lexical.startsWith(`${managed}${path.sep}`), "lexically this collapses to inside the approved root")
    assert.equal(await restoreMissingWorktree({ ...state, worktree: traversed }), false)
    await assert.rejects(access(actual), "a traversal segment after a symlink must not smuggle a checkout out of the roots")
    await assert.rejects(access(lexical))
  } finally {
    await rm(managed, { recursive: true, force: true })
  }
})

test("requires canonical AWS nonproduction health", async () => {
  const commit = "a".repeat(40)
  const result = await __testing.verifyDevDeployment(
    { target: "https://dev.example/health", commit },
    async () => Response.json({ status: "ok" }),
  )
  assert.equal(result.commit, commit)
  await assert.rejects(
    __testing.verifyDevDeployment(
      { target: "https://dev.example/health", commit },
      async () => Response.json({ status: "degraded" }),
    ),
    /status ok/,
  )
})

test("clears a planned state when worktree creation never happened", async () => {
  await __testing.writeState({
    version: 1,
    schemaRevision: 2,
    phase: "worktree-planned",
    sessionID: "ses_planned",
    primary: "/missing-primary",
    worktree: path.join(directory, "missing-worktree"),
    branch: "feat/planned",
    originMain: "b".repeat(40),
  })
  assert.deepEqual(
    await reconcilePlannedWorktrees({ serverUrl: "http://127.0.0.1:4097/" }),
    [{ sessionID: "ses_planned", action: "cleared-missing-plan" }],
  )
  assert.equal(await __testing.readState("ses_planned"), null)
})

test("normalizes finish deployment inputs", () => {
  const commit = "c".repeat(40)
  assert.deepEqual(__testing.normalizeDevDeployment({ target: "https://dev.example/health", commit }), {
    target: "https://dev.example/health",
    commit,
  })
  assert.throws(() => __testing.normalizeDevDeployment({ target: "file:///tmp/health", commit }), /HTTP/)
})

test("requires AWS nonproduction workflow evidence", async () => {
  const repository = await mkdtemp(path.join(directory, "workflow-capability-"))
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim()
  git("init")
  git("remote", "add", "origin", "https://example.invalid/repository.git")
  const commit = "d".repeat(40)
  const workflowResponse = (workflows) => JSON.stringify([{ total_count: workflows.length, workflows }])
  const withoutWorkflow = async (_command, args) => ({ stdout: args[0] === "repo"
    ? "owner/repository\n"
    : JSON.stringify([
        { total_count: 2, workflows: [{ name: "CI", path: ".github/workflows/ci.yml", state: "active" }] },
        { total_count: 2, workflows: [{ name: "Build", path: ".github/workflows/build.yml", state: "active" }] },
      ]) })
  assert.deepEqual(
    await __testing.inspectNonproductionWorkflow(repository, commit, withoutWorkflow),
    { required: true, run: false },
    "a missing canonical deployment workflow must fail closed",
  )

  const calls = []
  const withWorkflowButNoRun = async (_command, args) => {
    calls.push(args)
    if (args[0] === "repo") return { stdout: "owner/repository\n" }
    if (args[0] === "api") {
      return { stdout: workflowResponse([{ name: "Deploy Platform Nonproduction", path: ".github/workflows/platform-nonproduction.yml", state: "active" }]) }
    }
    return { stdout: "[]" }
  }
  assert.deepEqual(
    await __testing.inspectNonproductionWorkflow(repository, commit, withWorkflowButNoRun),
    { required: true, run: false },
    "a defined workflow fails closed when no successful exact-commit run can be read",
  )
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].slice(0, 3), ["repo", "view", "https://example.invalid/repository.git"])
  assert.equal(calls[0].includes("--repo"), false, "gh repo view accepts its repository positionally")
  assert.ok(calls[1].includes("repos/owner/repository/actions/workflows?per_page=100"), "the inventory must bind to origin rather than GH_REPO")
  assert.ok(calls[2].includes(commit), "the required workflow run must match the exact deployment commit")
  assert.ok(calls[2].includes("--all"), "disabled workflow runs must remain available as evidence")

  const successfulRun = { databaseId: 42, headSha: commit, conclusion: "success", url: "https://example.invalid/run/42" }
  const withSuccessfulRun = async (_command, args) => ({
    stdout: args[0] === "repo"
      ? "owner/repository\n"
      : JSON.stringify(args[0] === "api" ? [{ total_count: 1, workflows: [{ name: "Deploy Platform Nonproduction" }] }] : [successfulRun]),
  })
  assert.deepEqual(
    await __testing.inspectNonproductionWorkflow(repository, commit, withSuccessfulRun),
    { required: true, run: successfulRun },
  )

  const withWrongRuns = async (_command, args) => ({
    stdout: args[0] === "repo"
      ? "owner/repository\n"
      : JSON.stringify(args[0] === "api"
      ? [{ total_count: 1, workflows: [{ name: "Deploy Platform Nonproduction" }] }]
      : [
          { ...successfulRun, headSha: "e".repeat(40) },
          { ...successfulRun, conclusion: "failure" },
        ]),
  })
  assert.deepEqual(
    await __testing.inspectNonproductionWorkflow(repository, commit, withWrongRuns),
    { required: true, run: false },
    "wrong-commit and unsuccessful runs must not satisfy deployment evidence",
  )

  const malformedInventory = async (_command, args) => ({ stdout: args[0] === "repo" ? "owner/repository\n" : "{}" })
  assert.deepEqual(
    await __testing.inspectNonproductionWorkflow(repository, commit, malformedInventory),
    { required: true, run: false },
    "an unreadable workflow inventory must fail closed",
  )
})

test("installs the resume hold before moving the active session", () => {
  const goal = __testing.createManagedGoal("Verify the move")
  assert.equal(goal.status, "active")
  assert.equal(goal.statusReason, "worktree-moving")
  assert.equal(goal.managedWorktree, true)
})

test("recovers a move whose response times out after the session moved", async () => {
  const destination = await mkdtemp(path.join(directory, "move-destination-"))
  let currentDirectory = directory
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input)
    if (url.pathname === "/experimental/control-plane/move-session") {
      currentDirectory = JSON.parse(options.body).destination.directory
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 1_000)
        options.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive)
          reject(options.signal.reason)
        }, { once: true })
      })
    }
    if (url.pathname === "/experimental/session") return Response.json([{ id: "ses_move", directory: currentDirectory }])
    throw new Error(`unexpected move request ${url}`)
  }
  await __testing.moveSession({
    serverUrl: "http://127.0.0.1:4097/",
    sessionID: "ses_move",
    destination,
    fetchImpl,
    timeoutMs: 10,
  })
  assert.equal(currentDirectory, destination)
})

test("fails closed when a timed-out move did not reach its destination", async () => {
  const destination = await mkdtemp(path.join(directory, "move-not-completed-"))
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input)
    if (url.pathname === "/experimental/control-plane/move-session") {
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 1_000)
        options.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive)
          reject(options.signal.reason)
        }, { once: true })
      })
    }
    if (url.pathname === "/experimental/session") return Response.json([{ id: "ses_move_failed", directory }])
    throw new Error(`unexpected move request ${url}`)
  }
  await assert.rejects(__testing.moveSession({
    serverUrl: "http://127.0.0.1:4097/",
    sessionID: "ses_move_failed",
    destination,
    fetchImpl,
    timeoutMs: 10,
  }), /move outcome could not be verified/)
})

test("adopts an exact crash-partial worktree, waits externally, and abandons safely", async () => {
  const repositoryRoot = await mkdtemp(path.join(directory, "recovery-repository-"))
  const origin = path.join(repositoryRoot, "origin.git")
  const primary = path.join(repositoryRoot, "primary")
  const worktree = path.join(repositoryRoot, "worktree")
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
  execFileSync("git", ["init", "--bare", origin])
  execFileSync("git", ["clone", origin, primary])
  git(primary, "config", "user.name", "Bridge Test")
  git(primary, "config", "user.email", "bridge@example.invalid")
  await writeFile(path.join(primary, "README.md"), "fixture\n")
  git(primary, "add", "README.md")
  git(primary, "commit", "-m", "Fixture")
  git(primary, "branch", "-M", "main")
  git(primary, "push", "-u", "origin", "main")
  git(primary, "worktree", "add", "-b", "agent/38769771/issue-99", worktree, "origin/main")
  const originMain = git(primary, "rev-parse", "origin/main")
  const commonDirectory = await realpath(git(primary, "rev-parse", "--path-format=absolute", "--git-common-dir"))
  const managedGoal = { id: "goal_recover", status: "active", statusReason: "worktree-moving", managedWorktree: true }
  await __testing.writeState({
    version: 1,
    schemaRevision: 2,
    phase: "worktree-planned",
    sessionID: "ses_recover",
    primary: await realpath(primary),
    commonDirectory,
    worktree: await realpath(worktree),
    branch: "agent/38769771/issue-99",
    originMain,
    managedGoalID: managedGoal.id,
    managedGoal,
    managedGoalObjective: "Recover the task",
  })

  let currentDirectory = await realpath(primary)
  let goal = null
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input)
    if (url.pathname === "/experimental/session") return Response.json([{ id: "ses_recover", directory: currentDirectory }])
    if (url.pathname === "/experimental/control-plane/move-session") {
      currentDirectory = JSON.parse(options.body).destination.directory
      return Response.json({ ok: true })
    }
    if (url.pathname === "/session/status") return Response.json({})
    if (url.pathname === "/session") {
      return Response.json(url.searchParams.get("directory") === currentDirectory ? [{ id: "ses_recover", directory: currentDirectory }] : [])
    }
    if (url.pathname === "/session/ses_recover") {
      if (options.method === "PATCH") {
        goal = JSON.parse(options.body).metadata?.openchamber?.goal ?? null
        return Response.json({ ok: true })
      }
      return Response.json({ id: "ses_recover", directory: currentDirectory, metadata: goal ? { openchamber: { goal } } : {} })
    }
    throw new Error(`unexpected lifecycle request ${options.method || "GET"} ${url}`)
  }

  assert.deepEqual(await reconcilePlannedWorktrees({ serverUrl: "http://127.0.0.1:4097/", fetchImpl }), [
    { sessionID: "ses_recover", action: "adopted-exact-partial" },
  ])
  assert.equal(currentDirectory, await realpath(worktree))
  assert.equal((await __testing.readState("ses_recover")).phase, "attached")

  await waitForExternal({ sessionID: "ses_recover", directory: worktree, reason: "waiting for CI", serverUrl: "http://127.0.0.1:4097/", fetchImpl })
  assert.equal(goal.statusReason, "waiting_external")
  assert.equal(await resumeWorkspaceFromExternalWait({ sessionID: "ses_recover", serverUrl: "http://127.0.0.1:4097/", fetchImpl }), true)
  assert.equal(goal.status, "active")

  const abandoned = await abandonWorkspace({ sessionID: "ses_recover", directory: worktree, serverUrl: "http://127.0.0.1:4097/", fetchImpl })
  assert.equal(abandoned.outcome, "cancelled")
  assert.equal(currentDirectory, await realpath(primary))
  assert.equal(await access(worktree).then(() => true, () => false), false)
})
