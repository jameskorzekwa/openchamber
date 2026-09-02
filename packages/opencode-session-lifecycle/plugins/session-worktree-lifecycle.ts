import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import {
  acknowledgeSessionTurn,
  abandonWorkspace,
  assertSessionWorkspaceReady,
  assertSessionWorktreeNotClosing,
  createTurnBarrier,
  finishWorkspace,
  getWorkspaceResumeScheduler,
  reconcilePlannedWorktrees,
  restoreSessionWorktreeIfMissing,
  resumeWorkspaceFromExternalWait,
  startWorkspace,
  submitWorkspace,
  waitForExternal,
} from "../lib/session-worktree-lifecycle.mjs"

const turnBarrier = createTurnBarrier()

const describeSubmission = (state: any) => [
  state.summary,
  `State the handoff as ${state.submission.slug}#${state.submission.ref} in your reply.`,
  "Stop this turn. The next turn will run from the primary checkout.",
].join(" ")

export const SessionWorktreeLifecycle: Plugin = async ({ serverUrl }) => {
  const resumeScheduler = getWorkspaceResumeScheduler({ serverUrl })
  await reconcilePlannedWorktrees({ serverUrl })
  void resumeScheduler.recover()
  return {
    tool: {
      session_workspace: tool({
      description: [
        "Move the current session into a lifecycle-owned worktree, wait for an external bridge wake, safely abandon owner-cancelled work, hand finished work to OpenCode Project Manager (OPM), or finish after merge and verified dev deployment. A successful start, wait, abandon, submit, or finish ends the current turn.",
        "Use action=start only after the user asks to implement a feature/fix and supplies enough context to choose a descriptive branch. On OPM-managed repositories, start may instead take issue=N to claim an OPM issue: the issue gets the project's claimed label before the worktree exists, the goal is seeded from the issue, and a branch the issue already names is checked out instead of a new one.",
        "Use action=submit on OPM-managed repositories instead of finish. Submit is explicit and announced: a session may only submit its own completed work, it commits and pushes the branch, opens the pull request, files or reuses the opm:ready tracking issue with the branch marker OPM adopts, releases any claim, hands off to OPM's pipeline (CI, independent review, merge, deploy, verify), removes the worktree, and completes the goal. You must state the resulting {slug}#{ref} in your reply. Never use submit to end a turn early or to hand off unfinished work; never merge a pull request yourself on a managed repository.",
        "For action=finish on an unmanaged repository, devDeployment is required on the first finish attempt. On an OPM-managed repository, finish delegates to submit.",
      ].join(" "),
      args: {
        action: tool.schema.enum(["start", "wait", "abandon", "submit", "finish"]),
        branch: tool.schema.string().optional().describe("Descriptive branch name required for start unless issue is given, such as feat/unit-search or fix/device-timeout"),
        issue: tool.schema.number().int().positive().optional().describe("GitHub issue number. For start: claim this OPM issue and pair the worktree with it. For submit: reuse this open issue as the tracking issue instead of filing a new one"),
        title: tool.schema.string().optional().describe("For submit: pull request and tracking issue title (max 120 chars); defaults to the first line of the managed goal's user request"),
        class: tool.schema.enum(["docs", "chore", "fix", "feature"]).optional().describe("For submit: OPM work class label; defaults to docs when every changed path is *.md or under docs/, otherwise feature"),
        urgent: tool.schema.boolean().optional().describe("For submit: add the opm:urgent label when the repository defines it"),
        reason: tool.schema.string().optional().describe("Concise external wait reason required for wait"),
        confirmDiscardUnpublished: tool.schema.boolean().optional().describe("For abandon only: true only after explicit owner confirmation to discard unpublished changes"),
        deleteLocalBranch: tool.schema.boolean().optional().describe("Delete the local branch during finish, abandon, or submit once it is safe; defaults to true"),
        devDeployment: tool.schema.object({
          target: tool.schema.string().describe("HTTP(S) dev URL that can be fetched for a smoke check"),
          commit: tool.schema.string().describe("Exact 40-character origin/main commit deployed to dev"),
        }).optional().describe("Required for the first finish attempt on an unmanaged repository; the URL must return 2xx with the deployment health payload"),
      },
      async execute(args, context) {
        context.metadata({ title: `${args.action[0].toUpperCase()}${args.action.slice(1)} session worktree` })
        if (args.action === "start") {
          if (!args.branch && !args.issue) throw new Error("branch is required for workspace start unless issue is given")
          const state = await startWorkspace({
            sessionID: context.sessionID,
            directory: context.directory,
            branch: args.branch,
            issue: args.issue,
            serverUrl,
          })
          void resumeScheduler.schedule(state)
          turnBarrier.block(context.sessionID)
          const result = {
            ok: true,
            action: "start",
            sessionID: context.sessionID,
            directory: state.worktree,
            branch: state.branch,
            opm: state.opm,
            instruction: "Stop this turn. An automatic goal continuation will resume in the new worktree; no user message is required.",
          }
          if (!state.opm) delete result.opm
          return JSON.stringify(result)
        }
        if (args.action === "wait") {
          const state = await waitForExternal({
            sessionID: context.sessionID,
            directory: context.directory,
            reason: args.reason,
            serverUrl,
          })
          turnBarrier.block(context.sessionID)
          return JSON.stringify({ ok: true, action: "wait", reason: state.waitingReason, instruction: "Stop this turn. Only an external bridge message will resume this managed goal." })
        }
        if (args.action === "abandon") {
          const state = await abandonWorkspace({
            sessionID: context.sessionID,
            directory: context.directory,
            serverUrl,
            confirmDiscardUnpublished: args.confirmDiscardUnpublished === true,
            deleteLocalBranch: args.deleteLocalBranch !== false,
          })
          turnBarrier.block(context.sessionID)
          return JSON.stringify({ ok: true, action: "abandon", directory: state.primary, removedWorktree: state.worktree, instruction: "Stop this turn. The cancelled goal returned to the primary checkout." })
        }
        if (args.action === "submit") {
          const state = await submitWorkspace({
            sessionID: context.sessionID,
            directory: context.directory,
            serverUrl,
            title: args.title,
            class: args.class,
            issue: args.issue,
            urgent: args.urgent === true,
            deleteLocalBranch: args.deleteLocalBranch !== false,
          })
          turnBarrier.block(context.sessionID)
          return describeSubmission(state)
        }
        const state = await finishWorkspace({
          sessionID: context.sessionID,
          directory: context.directory,
          serverUrl,
          deleteLocalBranch: args.deleteLocalBranch !== false,
          devDeployment: args.devDeployment,
        })
        turnBarrier.block(context.sessionID)
        if (state.outcome === "submitted") return describeSubmission(state)
        const result = JSON.stringify({
          ok: true,
          action: "finish",
          sessionID: context.sessionID,
          directory: state.primary,
          removedWorktree: state.worktree,
          instruction: "Stop this turn. The next turn will run from the primary checkout.",
        })
        return result
      },
      }),
    },
    "chat.message": async (input) => {
      await restoreSessionWorktreeIfMissing({ sessionID: input.sessionID })
      await assertSessionWorktreeNotClosing({ sessionID: input.sessionID, serverUrl })
      if (!resumeScheduler.isAutomaticResume(input.messageID)) {
        await resumeScheduler.cancel(input.sessionID)
      }
      await resumeWorkspaceFromExternalWait({ sessionID: input.sessionID, serverUrl })
      turnBarrier.acknowledge(input.sessionID)
      await acknowledgeSessionTurn(input.sessionID)
    },
    "tool.execute.before": async (input) => {
      turnBarrier.assert(input.sessionID)
      if (input.tool === "session_workspace") return
      await assertSessionWorktreeNotClosing({ sessionID: input.sessionID, serverUrl })
      await assertSessionWorkspaceReady({ sessionID: input.sessionID })
    },
  }
}
