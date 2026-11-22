import { changeRequestNetworkTarget } from '../source-control/repository-network.js';
import { cancelWaitingMerge, readWaitingMerge } from './merge-when-ready.js';
import {
  invalidProviderPayload,
  isPlainObject,
  isProviderString,
  requireGitHubRepoNetwork,
  requireProviderArray,
} from './mappers.js';
import { readPendingReview } from './review-draft.js';
import { isSourceControlInteger } from '../source-control/input-guards.js';
import type { ProviderMutationContext, ProviderSession } from '../source-control/provider-contract.js';
import type { MutationCompletion, MutationResult } from '../source-control/mutation-storage.js';
import type { Octokit } from './contracts.js';
import {
  failureFields,
  statusOf,
  fieldAt,
  gqlPath,
  requireField,
  restId,
  graphqlId,
  ISSUE_KINDS,
  DISCUSSION_KINDS,
  CONVERSATION_COMMENT_KINDS,
  recordKind,
  operationOf,
  ROUTE_OPERATIONS,
  REVIEW_DRAFT_OPERATIONS,
  REVIEW_EVENTS,
  mutationError,
  definiteFailure,
  unknownOutcome,
  sameProject,
  sameNames,
  repoProject,
  pullTargetProject,
  targetMatches,
  providerRejection,
  graphqlRejection,
  rejected,
  optionalText,
  normalizeOperation,
} from './mutation-input.js';
import type {
  MutationTarget,
  Project,
  Rest,
  GitHubMutationOptions,
  GitHubMutationInput,
  MutationStep,
  MutationPreparation,
  MutationResolution,
  GitHubMutationErrorBody,
} from './mutation-input.js';
import {
  requireMutationPullRequest,
  stackOnParent,
  settleStack,
  mergePullRequest,
  postComment,
  requireConversationComment,
  readConversationCommentBody,
  conversationCommentGone,
  readReviewThread,
  replyToReviewThread,
  requirePendingComment,
  addReviewComment,
  updateReviewComment,
  deleteReviewComment,
  discardReview,
  submitReview,
  setReviewThreadResolved,
  graphqlWrite,
  readDiscussion,
  readDiscussionCommentNode,
  discussionCommentGone,
  readDiscussionComment,
  commentOnDiscussion,
  setDiscussionState,
  updateDiscussionText,
  setDiscussionAnswer,
  setDiscussionLabels,
  setLabels,
  requestedReviewers,
  setReviewers,
  setState,
} from './mutation-operations.js';
export type {
  GitHubMutationInput,
  GitHubMutationTarget,
  MutationStep,
  MutationPreparation,
  MutationResolution,
  NormalizedGitHubMutation,
  GitHubMutationErrorBody,
} from './mutation-input.js';

export function createGitHubMutations({ descriptor, octokitOf, resolveRepo, resolveNetwork, invalidatePulls, onSucceeded }: GitHubMutationOptions) {
  const reconcileCreate = async (octokit: ReturnType<GitHubMutationOptions['octokitOf']>, expectedProject: Project, sourceProject: Project, head: string | undefined, base: string | undefined): Promise<MutationCompletion> => {
    const params = {
      owner: expectedProject.owner, repo: expectedProject.name, state: 'all' as const, head: `${sourceProject.owner}:${head}`, base, per_page: 100,
    };
    const response = await octokit.rest.pulls.list(params);
    const candidates = requireProviderArray(response?.data, 'GitHub returned an invalid pull request list')
      .map((pr) => requireMutationPullRequest(pr, 'GitHub returned an invalid pull request', octokit))
      .filter((pr) => pr.head.ref === head && pr.base.ref === base)
      .filter((pr) => sameProject(pullTargetProject(pr), expectedProject))
      .filter((pr) => pr.head.repo && sameProject({ owner: pr.head.repo.owner.login, name: pr.head.repo.name }, sourceProject));
    if (candidates.length !== 1) return unknownOutcome();
    const found = requireField(candidates[0], 'candidate');
    const stacked = sameProject(sourceProject, expectedProject)
      ? await settleStack(octokit, expectedProject, found.number, base, found.base?.repo?.default_branch)
      : undefined;
    return { state: 'succeeded', result: stacked === undefined ? { number: found.number } : { number: found.number, stacked } };
  };

  const reconcileExisting = async (octokit: ReturnType<GitHubMutationOptions['octokitOf']>, operation: string, target: MutationTarget, input: GitHubMutationInput): Promise<MutationCompletion> => {
    if (['comment', 'review', 'issue-comment', 'thread-reply', 'discussion-comment'].includes(operation)) return unknownOutcome();
    if (REVIEW_DRAFT_OPERATIONS.has(operation)) return unknownOutcome();
    const project = target.project;
    if (operation === 'discussion-update') {
      const discussion = await readDiscussion(octokit, project, target.number);
      if (discussion.title === undefined || discussion.body === undefined) return unknownOutcome();
      const matches = discussion.title === input.title && (input.body === undefined || discussion.body === input.body);
      return matches ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'issue-update') {
      const current = await octokit.rest.issues.get({ owner: project.owner, repo: project.name, issue_number: target.number });
      const issue = current?.data;
      if (!isPlainObject(issue) || !isProviderString(issue.title)) return unknownOutcome();
      const issueBody = issue.body ?? '';
      const matches = issue.title === input.title && (input.body === undefined || issueBody === input.body);
      return matches ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (CONVERSATION_COMMENT_KINDS.has(operation)) {
      if (operation.endsWith('-update')) {
        const body = await readConversationCommentBody(octokit, project, restId(input.commentId));
        return body === input.body ? { state: 'succeeded', result: {} } : unknownOutcome();
      }
      return (await conversationCommentGone(octokit, project, restId(input.commentId)))
        ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'discussion-comment-update') {
      try {
        const read = await readDiscussionCommentNode(octokit, graphqlId(input.commentId));
        return read.status === 'found' && fieldAt(read.node, 'body') === input.body ? { state: 'succeeded', result: {} } : unknownOutcome();
      } catch {
        return unknownOutcome();
      }
    }
    if (operation === 'discussion-comment-delete') {
      return (await discussionCommentGone(octokit, graphqlId(input.commentId))) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'discussion-state') {
      const discussion = await readDiscussion(octokit, project, target.number);
      const state = discussion.closed ? 'closed' : 'open';
      return state === input.state ? { state: 'succeeded', result: { state } } : definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    }
    if (operation === 'discussion-answer') {
      const comment = await readDiscussionComment(octokit, graphqlId(input.commentId), project, target.number);
      return comment.isAnswer === input.answer ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'discussion-labels') {
      const names = (await readDiscussion(octokit, project, target.number)).labels.map((label) => label.name);
      return sameNames(names, requireField(input.labels, 'labels')) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'thread-resolve') {
      const thread = await readReviewThread(octokit, requireField(input.threadId, 'threadId'), project, requireField(target.number, 'number'));
      return thread.isResolved === input.resolved ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'labels' || operation === 'issue-labels') {
      const current = await octokit.rest.issues.listLabelsOnIssue({ owner: project.owner, repo: project.name, issue_number: requireField(target.number, 'number'), per_page: 100 });
      const names = requireProviderArray(current?.data, 'GitHub returned an invalid label list').map((label) => fieldAt(label, 'name'));
      return names.every(isProviderString) && sameNames(names, requireField(input.labels, 'labels')) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'reviewers') {
      return sameNames(await requestedReviewers(octokit, project, requireField(target.number, 'number')), requireField(input.reviewers, 'reviewers')) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'issue-state') {
      const current = await octokit.rest.issues.get({ owner: project.owner, repo: project.name, issue_number: target.number });
      const state = current?.data?.state;
      if (state !== 'open' && state !== 'closed') return unknownOutcome();
      return state === input.state ? { state: 'succeeded', result: { state } } : definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    }
    const current = await octokit.rest.pulls.get({ owner: project.owner, repo: project.name, pull_number: requireField(target.number, 'number') });
    const pr = requireMutationPullRequest(current?.data, 'GitHub returned an invalid pull request', octokit);
    if (operation === 'merge') {
      if (pr.merged === true || isProviderString(pr.merged_at)) return { state: 'succeeded', result: { merged: true } };
      const { pull } = await readWaitingMerge(octokit, project, target);
      if (input.cancel) return !pull.isInMergeQueue && !pull.autoMergeRequest
        ? { state: 'succeeded', result: { merged: false, outcome: 'cancelled' } } : unknownOutcome();
      if (pull.isInMergeQueue) return { state: 'succeeded', result: { merged: false, outcome: 'queued' } };
      if (pull.autoMergeRequest) return { state: 'succeeded', result: { merged: false, outcome: 'auto-merge' } };
    } else if (operation === 'state') {
      if (pr.state === input.state) return { state: 'succeeded', result: { state: pr.state } };
      if (pr.state === 'open' || pr.state === 'closed') return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    } else if (operation === 'ready') {
      if (pr.draft === false) return { state: 'succeeded', result: { ready: true } };
      if (pr.draft === true && pr.state === 'open') return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    } else if (operation === 'draft') {
      if (pr.draft === true) return { state: 'succeeded', result: { draft: true } };
      if (pr.draft === false && pr.state === 'open') return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    }
    return unknownOutcome();
  };

  const resolveNetworkProjects = async (octokit: Octokit, context: ProviderMutationContext) => {
    const primary = (await resolveRepo(context.directory, context.primaryRemote))?.repo;
    if (!primary) throw mutationError('Unable to resolve trusted GitHub primary remote', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    const network = requireGitHubRepoNetwork(
      await resolveNetwork(octokit, context.directory, context.primaryRemote, { strictErrors: true }),
      primary,
    );
    const projects = [repoProject(primary), ...(network ?? []).map(repoProject)];
    if (!changeRequestNetworkTarget(projects, context.target.project, sameProject)) {
      throw mutationError('GitHub mutation target is outside the bound repository network', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    }
    return projects;
  };

  const baseTarget = (context: ProviderMutationContext, project: Project) => ({
    repositoryId: context.repositoryId,
    bindingRevision: context.bindingRevision,
    primaryRemote: context.primaryRemote,
    project: { id: `${project.owner}/${project.name}`, owner: project.owner, name: project.name },
  });

  const resolveNew = async (octokit: ReturnType<GitHubMutationOptions['octokitOf']>, context: ProviderMutationContext, operation: string, input: GitHubMutationInput): Promise<MutationStep['resolved']> => {
    const projects = await resolveNetworkProjects(octokit, context);
    const expectedProject = context.target.project;
    if (operation === 'create') {
      if (input.remote) {
        const selected = (await resolveRepo(context.directory, input.remote))?.repo;
        if (!selected || !sameProject(repoProject(selected), expectedProject)) {
          throw mutationError('remote does not match the mutation target', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
        }
      }
      const sourceRepo = (await resolveRepo(context.directory, input.headRemote))?.repo;
      const sourceProject = sourceRepo ? repoProject(sourceRepo) : null;
      if (!sourceProject || !projects.some((project) => sameProject(project, sourceProject))) {
        throw mutationError('GitHub mutation source is outside the bound repository network', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      }
      return {
        providerTarget: { sourceProject },
        target: { ...baseTarget(context, expectedProject), head: requireField(input.head, 'head'), base: requireField(input.base, 'base') },
      };
    }
    const expected = context.target;
    const number = requireField(expected.number, 'number');
    if (DISCUSSION_KINDS.has(operation)) {
      if (expected.head !== undefined || expected.base !== undefined || expected.headSha !== undefined) {
        throw mutationError('Discussion target is invalid');
      }
      const discussion = await readDiscussion(octokit, expectedProject, number);
      const namesComment = operation === 'discussion-answer'
        || operation === 'discussion-comment-update' || operation === 'discussion-comment-delete';
      if (namesComment) {
        await readDiscussionComment(octokit, graphqlId(input.commentId), expectedProject, number);
      }
      if (operation === 'discussion-comment' && input.replyTo !== undefined) {
        const replyTo = await readDiscussionComment(octokit, input.replyTo, expectedProject, number);
        if (replyTo.reply) {
          throw mutationError('A reply answers a comment, not another reply', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
        }
      }
      return { providerTarget: { discussion }, target: { ...baseTarget(context, expectedProject), number } };
    }
    if (ISSUE_KINDS.has(operation) && !operation.startsWith('change-request-')) {
      if (expected.head !== undefined || expected.base !== undefined || expected.headSha !== undefined) {
        throw mutationError('Issue target is invalid');
      }
      const issue = (await octokit.rest.issues.get({ owner: expectedProject.owner, repo: expectedProject.name, issue_number: number }))?.data;
      if (!isPlainObject(issue) || issue.number !== expected.number) throw invalidProviderPayload('GitHub returned an invalid issue');
      if (issue.pull_request) throw mutationError('GitHub issue is a pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      if (CONVERSATION_COMMENT_KINDS.has(operation)) {
        await requireConversationComment(octokit, restId(input.commentId), expectedProject, issue.number);
      }
      return { providerTarget: {}, target: { ...baseTarget(context, expectedProject), number: issue.number } };
    }
    const response = await octokit.rest.pulls.get({ owner: expectedProject.owner, repo: expectedProject.name, pull_number: number });
    const pr = requireMutationPullRequest(response?.data, 'GitHub returned an invalid pull request', octokit);
    if (!sameProject(pullTargetProject(pr), expectedProject) || !targetMatches(expected, pr)) {
      throw mutationError('GitHub pull request no longer matches the mutation target', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', 409);
    }
    const target = { ...baseTarget(context, expectedProject), number: pr.number, head: pr.head.ref, base: pr.base.ref, headSha: pr.head.sha };
    if (operation === 'thread-reply' || operation === 'thread-resolve') {
      await readReviewThread(octokit, requireField(input.threadId, 'threadId'), expectedProject, target.number);
    }
    if (operation === 'review-comment-update' || operation === 'review-comment-delete') {
      await requirePendingComment(octokit, graphqlId(input.commentId), expectedProject, target.number);
    }
    if (CONVERSATION_COMMENT_KINDS.has(operation)) {
      await requireConversationComment(octokit, restId(input.commentId), expectedProject, target.number);
    }
    if (operation === 'review' || operation === 'review-comment' || operation === 'review-discard') {
      const pending = await readPendingReview({ octokit, owner: expectedProject.owner, repo: expectedProject.name, number: target.number });
      if (operation === 'review-discard' && !pending) {
        throw mutationError('There is no review draft on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      }
      if (operation === 'review' && input.verdict !== 'comment' && pending && pending.commit !== pr.head.sha) {
        throw mutationError('This review draft was started on an older commit. Send it as a comment, then give your verdict.', 'SOURCE_CONTROL_MUTATION_REJECTED', 409);
      }
      return { providerTarget: { pendingReviewId: pending?.id ?? null, pullRequestId: pr.node_id }, target };
    }
    if (operation === 'ready' || operation === 'draft') {
      const already = operation === 'ready' ? pr.draft === false : pr.draft === true;
      const nodeId = optionalText(pr.node_id, 'pull request node id', true);
      if (!already && !nodeId) throw invalidProviderPayload('GitHub returned an invalid pull request node id');
      return { providerTarget: { already, nodeId: nodeId ?? null }, target };
    }
    return { providerTarget: {}, target };
  };

  const performOperation = async (octokit: ReturnType<GitHubMutationOptions['octokitOf']>, operation: string, input: GitHubMutationInput, { providerTarget, target }: MutationStep['resolved']): Promise<MutationResult> => {
    const project = target.project;
    const number = () => requireField(target.number, 'number');
    const title = () => requireField(input.title, 'title');
    const body = () => requireField(input.body, 'body');
    const labels = () => requireField(input.labels, 'labels');
    const discussion = () => requireField(providerTarget.discussion, 'discussion');
    const threadId = () => requireField(input.threadId, 'threadId');
    const state = () => requireField(input.state, 'state');
    switch (operation) {
      case 'create': {
        const sourceProject = requireField(providerTarget.sourceProject, 'sourceProject');
        const head = requireField(input.head, 'head');
        const base = requireField(input.base, 'base');
        const createInput: Rest['pulls']['create']['parameters'] = {
          owner: project.owner,
          repo: project.name,
          title: title(),
          head: sameProject(sourceProject, project) ? head : `${sourceProject.owner}:${head}`,
          base,
        };
        if (input.body !== undefined) createInput.body = input.body;
        if (input.draft !== undefined) createInput.draft = input.draft;
        const response = await octokit.rest.pulls.create(createInput);
        const created = requireMutationPullRequest(response?.data, 'GitHub returned an invalid created pull request', octokit);
        const createdSource = created.head.repo ? { owner: created.head.repo.owner.login, name: created.head.repo.name } : null;
        if (!targetMatches({ number: created.number, head, base }, created)
          || !sameProject(pullTargetProject(created), project)
          || !sameProject(createdSource, sourceProject)) {
          throw invalidProviderPayload('GitHub returned a created pull request with an unexpected target');
        }
        const stacked = sameProject(sourceProject, project)
          ? await stackOnParent(octokit, project, created.number, base, created.base?.repo?.default_branch)
          : undefined;
        return stacked === undefined ? { number: created.number } : { number: created.number, stacked };
      }
      case 'update': {
        const updateInput: Rest['pulls']['update']['parameters'] = { owner: project.owner, repo: project.name, pull_number: number(), title: title() };
        if (input.body !== undefined) updateInput.body = input.body;
        const updated = requireMutationPullRequest((await octokit.rest.pulls.update(updateInput))?.data, 'GitHub returned an invalid updated pull request', octokit);
        if (!sameProject(pullTargetProject(updated), project) || !targetMatches(target, updated)) {
          throw invalidProviderPayload('GitHub returned an updated pull request with an unexpected target');
        }
        return {};
      }
      case 'merge':
        if (input.cancel) {
          try { return await cancelWaitingMerge(octokit, project, target); }
          catch (error) { throw graphqlRejection(error); }
        }
        return mergePullRequest(octokit, project, target, requireField(input.method, 'method'));
      case 'labels':
      case 'issue-labels':
        return setLabels(octokit, project, number(), labels());
      case 'reviewers':
        return setReviewers(octokit, project, number(), requireField(input.reviewers, 'reviewers'));
      case 'state':
        return setState(() => octokit.rest.pulls.update({ owner: project.owner, repo: project.name, pull_number: number(), state: state() }), state());
      case 'issue-state':
        return setState(() => octokit.rest.issues.update({ owner: project.owner, repo: project.name, issue_number: number(), state: state() }), state());
      case 'issue-update': {
        const updateInput: Rest['issues']['update']['parameters'] = { owner: project.owner, repo: project.name, issue_number: number(), title: title() };
        if (input.body !== undefined) updateInput.body = input.body;
        const updated = fieldAt(await rejected(() => octokit.rest.issues.update(updateInput)), 'data');
        const updatedBody = fieldAt(updated, 'body');
        if (!isPlainObject(updated) || fieldAt(updated, 'number') !== target.number || fieldAt(updated, 'title') !== input.title
          || (input.body !== undefined && (updatedBody === null ? '' : updatedBody) !== input.body)) {
          throw invalidProviderPayload('GitHub returned an invalid issue update');
        }
        return {};
      }
      case 'discussion-update':
        return updateDiscussionText(octokit, discussion().id, title(), input.body);
      case 'comment':
      case 'issue-comment':
        return postComment(octokit, project, number(), body());
      case 'change-request-comment-update':
      case 'issue-comment-update': {
        const updated = fieldAt(await rejected(() => octokit.rest.issues.updateComment({
          owner: project.owner, repo: project.name, comment_id: restId(input.commentId), body: body(),
        })), 'data');
        if (!isPlainObject(updated) || fieldAt(updated, 'body') !== input.body) throw invalidProviderPayload('GitHub returned an invalid comment');
        return {};
      }
      case 'change-request-comment-delete':
      case 'issue-comment-delete':
        await rejected(() => octokit.rest.issues.deleteComment({ owner: project.owner, repo: project.name, comment_id: restId(input.commentId) }));
        return {};
      case 'discussion-comment-update': {
        const data = await graphqlWrite(
          octokit,
          'mutation($commentId: ID!, $body: String!) { updateDiscussionComment(input: { commentId: $commentId, body: $body }) { comment { id body } } }',
          { commentId: input.commentId, body: input.body },
        );
        const updated = gqlPath(data, 'updateDiscussionComment', 'comment');
        if (!isPlainObject(updated) || fieldAt(updated, 'id') !== input.commentId || fieldAt(updated, 'body') !== input.body) {
          throw invalidProviderPayload('GitHub returned an invalid comment');
        }
        return {};
      }
      case 'discussion-comment-delete':
        await graphqlWrite(octokit, 'mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { clientMutationId } }', { id: input.commentId });
        return {};
      case 'thread-reply':
        return replyToReviewThread(octokit, threadId(), body());
      case 'thread-resolve':
        return setReviewThreadResolved(octokit, threadId(), requireField(input.resolved, 'resolved'));
      case 'discussion-comment':
        return commentOnDiscussion(octokit, discussion().id, input.body, input.replyTo);
      case 'discussion-state':
        return setDiscussionState(octokit, discussion().id, state(), input.reason);
      case 'discussion-answer':
        return setDiscussionAnswer(octokit, graphqlId(input.commentId), requireField(input.answer, 'answer'));
      case 'discussion-labels':
        return setDiscussionLabels(octokit, project, discussion(), labels());
      case 'review-comment':
        return addReviewComment(octokit, providerTarget, target.headSha, input);
      case 'review-comment-update':
        return updateReviewComment(octokit, graphqlId(input.commentId), input.body);
      case 'review-comment-delete':
        return deleteReviewComment(octokit, graphqlId(input.commentId));
      case 'review-discard':
        return discardReview(octokit, providerTarget.pendingReviewId);
      case 'review': {
        const isReviewEvent = (value: unknown): value is typeof REVIEW_EVENTS[keyof typeof REVIEW_EVENTS] =>
          value === REVIEW_EVENTS.approve || value === REVIEW_EVENTS['request-changes'] || value === REVIEW_EVENTS.comment;
        const entry = fieldAt(REVIEW_EVENTS, String(input.verdict));
        if (!isReviewEvent(entry)) throw new TypeError('GitHub review event is unavailable');
        const { event, state } = entry;
        if (providerTarget.pendingReviewId) {
          if (await submitReview(octokit, providerTarget.pendingReviewId, event, input.body) !== state) {
            throw invalidProviderPayload('GitHub returned an invalid review');
          }
          return { commented: input.body !== undefined };
        }
        if (input.verdict === 'comment' && input.body === undefined) {
          throw mutationError('A review with no comments needs text', 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
        }
        const reviewInput: Rest['pulls']['createReview']['parameters'] = {
          owner: project.owner,
          repo: project.name,
          pull_number: number(),
          commit_id: requireField(target.headSha, 'headSha'),
          event,
        };
        if (input.body !== undefined) reviewInput.body = input.body;
        const response = await rejected(() => octokit.rest.pulls.createReview(reviewInput));
        if (gqlPath(response, 'data', 'state') !== state) {
          throw invalidProviderPayload('GitHub returned an invalid review');
        }
        return { commented: input.body !== undefined };
      }
      case 'ready': {
        if (!providerTarget.already) {
          const ready = await octokit.graphql<unknown>(
            `mutation($pullRequestId: ID!) {\n  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {\n    pullRequest {\n      id\n      isDraft\n    }\n  }\n}`,
            { pullRequestId: providerTarget.nodeId },
          );
          const result = gqlPath(ready, 'markPullRequestReadyForReview', 'pullRequest');
          if (!isPlainObject(result) || fieldAt(result, 'id') !== providerTarget.nodeId || fieldAt(result, 'isDraft') !== false) {
            throw invalidProviderPayload('GitHub returned an invalid ready-for-review result');
          }
        }
        return { ready: true };
      }
      case 'draft': {
        if (!providerTarget.already) {
          const draft = await octokit.graphql<unknown>(
            `mutation($pullRequestId: ID!) {\n  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {\n    pullRequest {\n      id\n      isDraft\n    }\n  }\n}`,
            { pullRequestId: providerTarget.nodeId },
          );
          const result = gqlPath(draft, 'convertPullRequestToDraft', 'pullRequest');
          if (!isPlainObject(result) || fieldAt(result, 'id') !== providerTarget.nodeId || fieldAt(result, 'isDraft') !== true) {
            throw invalidProviderPayload('GitHub returned an invalid convert-to-draft result');
          }
        }
        return { draft: true };
      }
      default:
        throw mutationError('Mutation kind is invalid');
    }
  };

  return Object.freeze({
    routes: Object.freeze(Object.keys(ROUTE_OPERATIONS)),
    prepare: ({ route, input, context, actor, credential }: MutationPreparation) => {
      const operation = fieldAt(ROUTE_OPERATIONS, route);
      if (!operation) throw mutationError('Source control mutation is unsupported');
      if (!isProviderString(operation)) throw mutationError('Mutation kind is invalid');
      const normalized = normalizeOperation(operation, input ?? {}, context, actor, credential, descriptor.limits);
      return { kind: recordKind(operation), input: normalized.input, digest: normalized.digest };
    },
    resolveTarget: async ({ session, context, kind, input, replayOf }: MutationResolution): Promise<MutationStep['resolved']> => {
      const operation = operationOf(kind);
      const octokit = octokitOf(session);
      if (replayOf) {
        if (operation !== 'create') return { providerTarget: {}, target: replayOf.target };
        const sourceRepo = (await resolveRepo(context.directory, input.headRemote))?.repo;
        return { providerTarget: { sourceProject: sourceRepo ? repoProject(sourceRepo) : null }, target: replayOf.target };
      }
      return rejected(() => resolveNew(octokit, context, operation, input));
    },
    afterSuccess: async ({ session, target }: { session: ProviderSession; target: MutationTarget }) => {
      onSucceeded({ session, target });
      await invalidatePulls(target.project.owner, target.project.name, octokitOf(session));
    },
    perform: async ({ session, kind, input, resolved }: MutationStep) => {
      const operation = operationOf(kind);
      return performOperation(octokitOf(session), operation, input, resolved);
    },
    reconcile: async ({ session, kind, input, resolved }: MutationStep) => {
      const operation = operationOf(kind);
      const octokit = octokitOf(session);
      const { target, providerTarget } = resolved;
      return operation === 'create'
        ? providerTarget.sourceProject
          ? await reconcileCreate(octokit, target.project, providerTarget.sourceProject, target.head, target.base)
          : unknownOutcome()
        : await reconcileExisting(octokit, operation, target, input);
    },
    classifyError: (cause: unknown) => {
      const error = failureFields(cause);
      const status = statusOf(error);
      if (error && isSourceControlInteger(status) && status >= 400 && status <= 499) {
        if (!Number.isSafeInteger(error.status)) error.status = status;
        if (!isProviderString(error.code)) error.code = 'GITHUB_MUTATION_REJECTED';
        return 'failed';
      }
      return 'outcome-unknown';
    },
    presentError: (cause: unknown) => {
      const failure = failureFields(cause);
      const error = failureFields(failure?.response ? providerRejection(cause) : cause);
      const status = isSourceControlInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const code = isProviderString(error?.code) && error.code ? error.code : 'GITHUB_MUTATION_FAILED';
      const ownMessage = code.startsWith('SOURCE_CONTROL_') || code.startsWith('INVALID_SOURCE_CONTROL_');
      if (!ownMessage && status !== 401) console.warn(`GitHub mutation failed: ${status} ${code} ${error?.name ?? 'unknown'}`);
      const message = ownMessage ? error?.message : status === 401 ? 'GitHub account is unavailable' : 'GitHub mutation failed';
      const body: GitHubMutationErrorBody = { error: message, code };
      if (error?.current !== undefined) body.current = error.current;
      return { status, body };
    },
  });
}
