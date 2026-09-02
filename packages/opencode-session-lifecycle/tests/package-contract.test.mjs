import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  PtyWaitingStatus,
  SessionWorktreeLifecycle,
} from "../dist/index.js"

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"))

test("exports both lifecycle plugins from the built entrypoint", () => {
  assert.equal(typeof PtyWaitingStatus, "function")
  assert.equal(typeof SessionWorktreeLifecycle, "function")
})

test("matches the OpenChamber base version", async () => {
  const packageMetadata = await readJson(new URL("../package.json", import.meta.url))
  const repositoryMetadata = await readJson(new URL("../../../package.json", import.meta.url))

  assert.equal(packageMetadata.version, repositoryMetadata.version)
})
