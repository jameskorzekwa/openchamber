import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const testFiles = [
  "tests/session-worktree-lifecycle.test.mjs",
  "tests/session-worktree-lifecycle-recovery.test.mjs",
  "tests/pty-waiting-state.test.mjs",
  "tests/package-contract.test.mjs",
]

for (const testFile of testFiles) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "openchamber-lifecycle-test-"))
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["test", testFile], {
        env: {
          ...process.env,
          HEIRLOOM_AGENT_LIFECYCLE_STATE_DIR: stateDirectory,
        },
        stdio: "inherit",
      })
      child.once("error", reject)
      child.once("exit", (code) => resolve(code))
    })
    if (exitCode !== 0) process.exit(exitCode ?? 1)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
}
