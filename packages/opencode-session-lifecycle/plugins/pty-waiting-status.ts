import type { Plugin } from "@opencode-ai/plugin"

import {
  createPtyWaitingState,
  parsePtySpawnID,
} from "../lib/pty-waiting-state.mjs"

export const PtyWaitingStatus: Plugin = async ({ serverUrl, directory }) => {
  const state = createPtyWaitingState({ serverUrl, directory })

  void state.recover().catch((error) => {
    console.warn("[pty-waiting] stale-state recovery failed:", error?.message || error)
  })

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool === "pty_kill") {
        await state.complete(input.args.id).catch((error) => {
          console.warn("[pty-waiting] kill sync failed:", error?.message || error)
        })
        return
      }
      if (input.tool !== "pty_spawn" || input.args?.notifyOnExit !== true) return
      const id = parsePtySpawnID(output.output)
      if (!id) return
      await state.register({
        id,
        sessionID: input.sessionID,
        description: input.args.description,
        title: input.args.title,
        timeoutSeconds: input.args.timeoutSeconds,
      }).catch((error) => {
        console.warn("[pty-waiting] spawn sync failed:", error?.message || error)
      })
    },
    "chat.message": async (_input, output) => {
      await state.handleExitParts(output.parts)
    },
  }
}
