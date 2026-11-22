import { enableMergeWhenReady, readWaitingMerge } from './merge-when-ready.js';
import {
  invalidProviderPayload,
  isPlainObject,
  isProviderString,
  matchesGitHubRepositoryUrl,
  requireGitHubPullRequest,
  requireProviderArray,
} from './mappers.js';
import { isSourceControlInteger } from '../source-control/input-guards.js';
import type { MutationResult } from '../source-control/mutation-storage.js';
import type { GitHubEnvelope, Octokit } from './contracts.js';
import type { PullInput } from './mappers.js';
import {
  failureFields,
  statusOf,
  isArray,
  fieldAt,
  gqlPath,
  requireField,
  isDiscussionLabelList,
  DISCUSSION_CLOSE_REASONS,
  mutationError,
  providerRejection,
  graphqlRejection,
  rejected,
} from './mutation-input.js';
import type {
  Project,
  MergeMethod,
  ItemState,
  MutationPull,
  Discussion,
  GitHubMutationOptions,
  GitHubMutationInput,
  GitHubMutationTarget,
  LabelVariables,
} from './mutation-input.js';

export const requireMutationPullRequest = (value: GitHubEnvelope['data'], message: string, octokit: ReturnType<GitHubMutationOptions['octokitOf']>): MutationPull => {
  const hasPullFields = (raw: unknown): raw is PullInput => isPlainObject(raw);
  const valid = (raw: unknown): raw is MutationPull => {
    if (!hasPullFields(raw)) return false;
    const pr = requireGitHubPullRequest(raw, message);
    const repo = gqlPath(pr.base, 'repo');
    const owner = fieldAt(repo, 'owner');
    const login = fieldAt(owner, 'login');
    const name = fieldAt(repo, 'name');
    const headSha = fieldAt(pr.head, 'sha');
    return isProviderString(headSha) && Boolean(headSha.trim())
      && Object.prototype.toString.call(fieldAt(raw, 'draft')) === '[object Boolean]'
      && Object.prototype.toString.call(fieldAt(raw, 'merged')) === '[object Boolean]'
      && isPlainObject(repo) && isPlainObject(owner)
      && isProviderString(login) && Boolean(login.trim())
      && isProviderString(name) && Boolean(name.trim())
      && matchesGitHubRepositoryUrl(fieldAt(repo, 'html_url'), login, name, octokit?.openChamberHost || '');
  };
  if (!valid(value)) throw invalidProviderPayload(message);
  return value;
};

export const stackOnParent = async (octokit: Octokit, project: Project, number: number, base: string | undefined, defaultBranch: MutationPull['base']['repo']['default_branch']) => {
  if (!defaultBranch || base === defaultBranch) return undefined;
  const route = { owner: project.owner, repo: project.name };
  let parent;
  try {
    const listed = await octokit.rest.pulls.list({ ...route, state: 'open', head: `${project.owner}:${base}`, per_page: 5 });
    const pulls: GitHubEnvelope['data'] = listed?.data;
    parent = (isArray(pulls) ? pulls : []).find((pr) => {
      const repo = gqlPath(pr, 'head', 'repo');
      return isPlainObject(pr) && fieldAt(pr, 'number') !== number && gqlPath(pr, 'head', 'ref') === base
        && fieldAt(repo, 'name') === project.name && gqlPath(repo, 'owner', 'login') === project.owner;
    });
  } catch {
    return undefined;
  }
  if (!parent) return undefined;
  try {
    const parentNumber = fieldAt(parent, 'number');
    const listedStacks = await octokit.request('GET /repos/{owner}/{repo}/stacks', { ...route, pull_request: parentNumber });
    const stacks: GitHubEnvelope['data'] = listedStacks?.data;
    const stack = isArray(stacks) ? stacks[0] : null;
    if (isPlainObject(stack) && isSourceControlInteger(fieldAt(stack, 'number'))) {
      await octokit.request('POST /repos/{owner}/{repo}/stacks/{stack_number}/add', { ...route, stack_number: fieldAt(stack, 'number'), pull_requests: [number] });
    } else {
      await octokit.request('POST /repos/{owner}/{repo}/stacks', { ...route, pull_requests: [parentNumber, number] });
    }
    return true;
  } catch {
    return false;
  }
};

export const settleStack = async (octokit: Octokit, project: Project, number: number, base: string | undefined, defaultBranch: MutationPull['base']['repo']['default_branch']) => {
  let listed;
  try {
    listed = await octokit.request('GET /repos/{owner}/{repo}/stacks', { owner: project.owner, repo: project.name, pull_request: number });
  } catch {
    return undefined;
  }
  const stacks: GitHubEnvelope['data'] = listed?.data;
  if (!isArray(stacks)) return undefined;
  if (stacks.some((stack) => isPlainObject(stack) && Number.isSafeInteger(fieldAt(stack, 'number')))) return true;
  return stackOnParent(octokit, project, number, base, defaultBranch);
};

const MERGE_ASYNC_POLL_MS = 1000;
const MERGE_ASYNC_WAIT_MS = 20_000;
const isMergeAsyncStatus = (value: unknown): value is 'pending' | 'merged' | 'enqueued' | 'failed' =>
  value === 'pending' || value === 'merged' || value === 'enqueued' || value === 'failed';
const isMergeAsyncAnswer = (data: unknown): data is { status: 'pending' | 'merged' | 'enqueued' | 'failed'; details?: unknown } =>
  isPlainObject(data) && isMergeAsyncStatus(fieldAt(data, 'status'));
const mergeAsyncAnswer = (data: GitHubEnvelope['data']) => {
  if (!isMergeAsyncAnswer(data)) throw invalidProviderPayload('GitHub returned an invalid merge result');
  const details = isPlainObject(data.details) ? data.details : {};
  const uuid = fieldAt(details, 'uuid');
  const message = fieldAt(details, 'message');
  return {
    status: data.status,
    uuid: isProviderString(uuid) ? uuid : null,
    message: isProviderString(message) ? message : null,
  };
};
type MergeTarget = Parameters<typeof readWaitingMerge>[2];
const mergeClassic = async (octokit: Octokit, project: Project, target: MergeTarget, method: MergeMethod) => {
  const merged = await octokit.rest.pulls.merge({
    owner: project.owner, repo: project.name, pull_number: target.number, merge_method: method, sha: target.headSha,
  });
  const data = merged?.data;
  if (!isPlainObject(data) || Object.prototype.toString.call(data.merged) !== '[object Boolean]'
    || (data.message !== undefined && !isProviderString(data.message))) {
    throw invalidProviderPayload('GitHub returned an invalid merge result');
  }
  return { merged: data.merged };
};
export const mergePullRequest = async (octokit: Octokit, project: Project, target: MergeTarget, method: MergeMethod): Promise<MutationResult> => {
  const whenReady = async () => {
    try { return await enableMergeWhenReady(octokit, project, target, method); }
    catch (error) { throw graphqlRejection(error); }
  };
  const route = { owner: project.owner, repo: project.name, pull_number: target.number };
  let answer;
  try {
    const response = await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async', {
      ...route, merge_method: method, sha: target.headSha, bypass_rules: true,
    });
    answer = mergeAsyncAnswer(response?.data);
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) {
      try { return await mergeClassic(octokit, project, target, method); }
      catch (classicError) {
        const classicStatus = statusOf(classicError);
        if (classicStatus === 403 || classicStatus === 405 || classicStatus === 422) {
          const waiting = await whenReady();
          if (waiting) return waiting;
        }
        throw providerRejection(classicError);
      }
    }
    if (status === 400 || status === 403 || status === 405 || status === 422) {
      const waiting = await whenReady();
      if (waiting) return waiting;
    }
    const data = failureFields(failureFields(error)?.response)?.data;
    if (status !== 409 || !isMergeAsyncAnswer(data)) throw providerRejection(error);
    answer = mergeAsyncAnswer(data);
  }
  const deadline = Date.now() + MERGE_ASYNC_WAIT_MS;
  while (answer.status === 'pending' && answer.uuid && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, MERGE_ASYNC_POLL_MS));
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}', { ...route, uuid: answer.uuid });
      answer = mergeAsyncAnswer(response?.data);
    } catch {
      return { merged: false, outcome: 'merging' };
    }
  }
  if (answer.status === 'failed') {
    const waiting = await whenReady();
    if (waiting) return waiting;
    throw mutationError(answer.message ?? 'GitHub could not merge the pull request', 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
  }
  if (answer.status === 'merged') return { merged: true };
  return { merged: false, outcome: answer.status === 'enqueued' ? 'queued' : 'merging' };
};

export const postComment = async (octokit: Octokit, project: Project, number: number, body: string) => {
  const response = await rejected(() => octokit.rest.issues.createComment({ owner: project.owner, repo: project.name, issue_number: number, body }));
  const data = fieldAt(response, 'data');
  if (!isPlainObject(data) || !Number.isSafeInteger(fieldAt(data, 'id'))) throw invalidProviderPayload('GitHub returned an invalid comment');
  return {};
};

const commentUrlTarget = (value: GitHubEnvelope['data']) => {
  if (!isProviderString(value)) return null;
  let pathname;
  try { pathname = new URL(value.trim()).pathname; } catch { return null; }
  const match = /\/(?:repos\/([^/]+)\/([^/]+)\/issues|([^/]+)\/([^/]+)\/(?:issues|pull))\/([1-9]\d*)\/?$/.exec(pathname);
  if (!match) return null;
  const [, apiOwner, apiName, webOwner, webName, number] = match;
  try {
    return { owner: decodeURIComponent(apiOwner ?? requireField(webOwner, 'owner')), name: decodeURIComponent(apiName ?? requireField(webName, 'name')), number: Number(number) };
  } catch {
    return null;
  }
};
export const requireConversationComment = async (octokit: Octokit, commentId: number, project: Project, number: number) => {
  const comment = fieldAt(await rejected(() => octokit.rest.issues.getComment({ owner: project.owner, repo: project.name, comment_id: commentId })), 'data');
  if (!isPlainObject(comment) || !isProviderString(fieldAt(comment, 'body'))) throw invalidProviderPayload('GitHub returned an invalid comment');
  const onTarget = [fieldAt(comment, 'issue_url'), fieldAt(comment, 'html_url')].map(commentUrlTarget)
    .some((target) => target?.number === number
      && target.owner.toLowerCase() === project.owner.toLowerCase()
      && target.name.toLowerCase() === project.name.toLowerCase());
  if (!onTarget) throw mutationError('Comment is not on this issue or pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
};
export const readConversationCommentBody = async (octokit: Octokit, project: Project, commentId: number) => {
  try {
    const comment = (await octokit.rest.issues.getComment({ owner: project.owner, repo: project.name, comment_id: commentId }))?.data;
    return isPlainObject(comment) && isProviderString(comment.body) ? comment.body : undefined;
  } catch {
    return undefined;
  }
};
export const conversationCommentGone = async (octokit: Octokit, project: Project, commentId: number) => {
  try {
    await octokit.rest.issues.getComment({ owner: project.owner, repo: project.name, comment_id: commentId });
    return false;
  } catch (error) {
    return statusOf(error) === 404;
  }
};

const REVIEW_THREAD_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread { isResolved pullRequest { number repository { name owner { login } } } }
  }
}`;
export const readReviewThread = async (octokit: Octokit, threadId: string, project: Project, number: number) => {
  let data: unknown;
  try {
    data = await octokit.graphql(REVIEW_THREAD_QUERY, { id: threadId });
  } catch (error) {
    const fields = failureFields(error);
    if (!isArray(fields?.errors)) throw error;
    data = fields?.data;
  }
  const node = fieldAt(data, 'node');
  const pull = fieldAt(node, 'pullRequest');
  const repository = fieldAt(pull, 'repository');
  const login = gqlPath(repository, 'owner', 'login');
  const name = fieldAt(repository, 'name');
  if (fieldAt(node, '__typename') !== 'PullRequestReviewThread' || fieldAt(requireField(pull, 'pullRequest'), 'number') !== number
    || !isProviderString(login) || !isProviderString(name)
    || login.toLowerCase() !== project.owner.toLowerCase()
    || name.toLowerCase() !== project.name.toLowerCase()) {
    throw mutationError('Review thread is not on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  }
  return { isResolved: fieldAt(node, 'isResolved') };
};
export const replyToReviewThread = async (octokit: Octokit, threadId: string, body: string) => {
  let data: unknown;
  try {
    data = await octokit.graphql(
      'mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }',
      { threadId, body },
    );
  } catch (error) {
    throw graphqlRejection(error);
  }
  if (!isProviderString(gqlPath(data, 'addPullRequestReviewThreadReply', 'comment', 'id'))) throw invalidProviderPayload('GitHub returned an invalid reply');
  return {};
};
const PENDING_COMMENT_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewComment { state viewerDidAuthor pullRequest { number repository { name owner { login } } } }
  }
}`;
export const requirePendingComment = async (octokit: Octokit, commentId: string, project: Project, number: number) => {
  let data: unknown;
  try {
    data = await octokit.graphql(PENDING_COMMENT_QUERY, { id: commentId });
  } catch (error) {
    const fields = failureFields(error);
    if (!isArray(fields?.errors)) throw error;
    data = fields?.data;
  }
  const node = fieldAt(data, 'node');
  const pull = fieldAt(node, 'pullRequest');
  const repository = fieldAt(pull, 'repository');
  const login = gqlPath(repository, 'owner', 'login');
  const name = fieldAt(repository, 'name');
  if (fieldAt(node, '__typename') !== 'PullRequestReviewComment' || fieldAt(node, 'state') !== 'PENDING' || fieldAt(node, 'viewerDidAuthor') !== true
    || fieldAt(requireField(pull, 'pullRequest'), 'number') !== number
    || !isProviderString(login) || !isProviderString(name)
    || login.toLowerCase() !== project.owner.toLowerCase()
    || name.toLowerCase() !== project.name.toLowerCase()) {
    throw mutationError('Review comment is not a draft of yours on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  }
};
const pendingReview = async (octokit: Octokit, { pendingReviewId, pullRequestId }: GitHubMutationTarget, headSha: string | undefined) => {
  if (pendingReviewId) return pendingReviewId;
  const data = await graphqlWrite(
    octokit,
    'mutation($pullRequestId: ID!, $commitOID: GitObjectID!) { addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) { pullRequestReview { id } } }',
    { pullRequestId, commitOID: headSha },
  );
  const id = gqlPath(data, 'addPullRequestReview', 'pullRequestReview', 'id');
  if (!isProviderString(id) || !id) throw invalidProviderPayload('GitHub returned an invalid review');
  return id;
};
export const addReviewComment = async (octokit: Octokit, providerTarget: GitHubMutationTarget, headSha: string | undefined, { path, side, startLine, line, body }: Pick<GitHubMutationInput, 'path' | 'side' | 'startLine' | 'line' | 'body'>) => {
  const pullRequestReviewId = await pendingReview(octokit, providerTarget, headSha);
  const diffSide = side === 'old' ? 'LEFT' : 'RIGHT';
  const position = line === undefined
    ? { subjectType: 'FILE' }
    : { subjectType: 'LINE', line, side: diffSide, startLine, startSide: startLine === undefined ? undefined : diffSide };
  const data = await graphqlWrite(
    octokit,
    'mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }',
    { input: { pullRequestReviewId, path, body, ...position } },
  );
  if (!isProviderString(gqlPath(data, 'addPullRequestReviewThread', 'thread', 'id'))) throw invalidProviderPayload('GitHub returned an invalid review comment');
  return {};
};
export const updateReviewComment = async (octokit: Octokit, commentId: string, body: string | undefined) => {
  const data = await graphqlWrite(
    octokit,
    'mutation($commentId: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) { pullRequestReviewComment { id } } }',
    { commentId, body },
  );
  if (gqlPath(data, 'updatePullRequestReviewComment', 'pullRequestReviewComment', 'id') !== commentId) throw invalidProviderPayload('GitHub returned an invalid review comment');
  return {};
};
export const deleteReviewComment = async (octokit: Octokit, commentId: string) => {
  await graphqlWrite(
    octokit,
    'mutation($commentId: ID!) { deletePullRequestReviewComment(input: { id: $commentId }) { clientMutationId } }',
    { commentId },
  );
  return {};
};
export const discardReview = async (octokit: Octokit, pendingReviewId: GitHubMutationTarget['pendingReviewId']) => {
  await graphqlWrite(
    octokit,
    'mutation($id: ID!) { deletePullRequestReview(input: { pullRequestReviewId: $id }) { clientMutationId } }',
    { id: pendingReviewId },
  );
  return {};
};
export const submitReview = async (octokit: Octokit, pendingReviewId: GitHubMutationTarget['pendingReviewId'], event: string, body: string | undefined) => {
  const data = await graphqlWrite(
    octokit,
    'mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) { pullRequestReview { state } } }',
    { id: pendingReviewId, event, body: body ?? null },
  );
  return gqlPath(data, 'submitPullRequestReview', 'pullRequestReview', 'state');
};
export const setReviewThreadResolved = async (octokit: Octokit, threadId: string, resolved: boolean) => {
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  let data: unknown;
  try {
    data = await octokit.graphql(`mutation($threadId: ID!) { ${field}(input: { threadId: $threadId }) { thread { isResolved } } }`, { threadId });
  } catch (error) {
    throw graphqlRejection(error);
  }
  if (gqlPath(data, field, 'thread', 'isResolved') !== resolved) throw invalidProviderPayload('GitHub returned an invalid thread state');
  return {};
};
const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) { id number title body closed labels(first: 100) { nodes { id name } } }
  }
}`;
export const graphqlWrite = async <Variables extends NonNullable<unknown>>(octokit: Octokit, query: string, variables: Variables) => {
  try {
    return await octokit.graphql<unknown>(query, variables);
  } catch (error) {
    throw graphqlRejection(error);
  }
};
export const readDiscussion = async (octokit: Octokit, project: Project, number: number | undefined): Promise<Discussion> => {
  let data: unknown;
  try {
    data = await octokit.graphql(DISCUSSION_QUERY, { owner: project.owner, name: project.name, number });
  } catch (error) {
    const fields = failureFields(error);
    if (!isArray(fields?.errors)) throw error;
    data = fields?.data;
  }
  const discussion = gqlPath(data, 'repository', 'discussion');
  const id = fieldAt(discussion, 'id');
  if (!isPlainObject(discussion) || fieldAt(discussion, 'number') !== number || !isProviderString(id) || !id) {
    throw mutationError('GitHub discussion was not found', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  }
  const labels = requireProviderArray(gqlPath(discussion, 'labels', 'nodes'), 'GitHub returned an invalid label list');
  if (!isDiscussionLabelList(labels)) {
    throw invalidProviderPayload('GitHub returned an invalid label list');
  }
  const title = fieldAt(discussion, 'title');
  const body = fieldAt(discussion, 'body');
  return {
    id,
    closed: fieldAt(discussion, 'closed') === true,
    labels,
    title: isProviderString(title) ? title : undefined,
    body: isProviderString(body) ? body : undefined,
  };
};
const DISCUSSION_COMMENT_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on DiscussionComment { isAnswer body replyTo { id } discussion { number repository { name owner { login } } } }
  }
}`;
export const readDiscussionCommentNode = async (octokit: Octokit, commentId: string) => {
  let data: unknown;
  let errors: unknown[] | undefined;
  try {
    data = await octokit.graphql(DISCUSSION_COMMENT_QUERY, { id: commentId });
  } catch (error) {
    const fields = failureFields(error);
    if (!isArray(fields?.errors)) throw error;
    data = fields?.data;
    errors = fields.errors;
  }
  if (!isPlainObject(data) || !Object.hasOwn(data, 'node')) return { status: 'unknown' as const };
  const node = fieldAt(data, 'node');
  if (node !== null) return { status: 'found' as const, node };
  return errors?.length ? { status: 'unknown' as const } : { status: 'absent' as const };
};
export const discussionCommentGone = async (octokit: Octokit, commentId: string) => {
  try {
    return (await readDiscussionCommentNode(octokit, commentId)).status === 'absent';
  } catch {
    return false;
  }
};
export const readDiscussionComment = async (octokit: Octokit, commentId: string, project: Project, number: number | undefined) => {
  const read = await readDiscussionCommentNode(octokit, commentId);
  if (read.status === 'unknown') throw invalidProviderPayload('GitHub did not answer the comment read');
  const node = read.status === 'found' ? read.node : null;
  const discussion = fieldAt(node, 'discussion');
  const repository = fieldAt(discussion, 'repository');
  const login = gqlPath(repository, 'owner', 'login');
  const name = fieldAt(repository, 'name');
  if (fieldAt(node, '__typename') !== 'DiscussionComment' || fieldAt(requireField(discussion, 'discussion'), 'number') !== number
    || !isProviderString(login) || !isProviderString(name)
    || login.toLowerCase() !== project.owner.toLowerCase()
    || name.toLowerCase() !== project.name.toLowerCase()) {
    throw mutationError('Comment is not on this discussion', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  }
  return { isAnswer: fieldAt(node, 'isAnswer') === true, reply: isPlainObject(fieldAt(node, 'replyTo')) };
};
export const commentOnDiscussion = async (octokit: Octokit, discussionId: string, body: string | undefined, replyTo: string | undefined) => {
  const data = await graphqlWrite(
    octokit,
    'mutation($discussionId: ID!, $body: String!, $replyToId: ID) { addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) { comment { id } } }',
    { discussionId, body, replyToId: replyTo ?? null },
  );
  if (!isProviderString(gqlPath(data, 'addDiscussionComment', 'comment', 'id'))) throw invalidProviderPayload('GitHub returned an invalid comment');
  return {};
};
export const setDiscussionState = async (octokit: Octokit, discussionId: string, state: ItemState, reason: GitHubMutationInput['reason']) => {
  const data = state === 'closed'
    ? await graphqlWrite(
      octokit,
      'mutation($discussionId: ID!, $reason: DiscussionCloseReason!) { closeDiscussion(input: { discussionId: $discussionId, reason: $reason }) { discussion { closed } } }',
      { discussionId, reason: fieldAt(DISCUSSION_CLOSE_REASONS, String(reason)) },
    )
    : await graphqlWrite(octokit, 'mutation($discussionId: ID!) { reopenDiscussion(input: { discussionId: $discussionId }) { discussion { closed } } }', { discussionId });
  const closed = gqlPath(data, state === 'closed' ? 'closeDiscussion' : 'reopenDiscussion', 'discussion', 'closed');
  if (closed !== (state === 'closed')) throw invalidProviderPayload('GitHub returned an unexpected state');
  return { state };
};
export const updateDiscussionText = async (octokit: Octokit, discussionId: string, title: string, body: string | undefined) => {
  const data = body === undefined
    ? await graphqlWrite(
      octokit,
      'mutation($discussionId: ID!, $title: String!) { updateDiscussion(input: { discussionId: $discussionId, title: $title }) { discussion { id title } } }',
      { discussionId, title },
    )
    : await graphqlWrite(
      octokit,
      'mutation($discussionId: ID!, $title: String!, $body: String!) { updateDiscussion(input: { discussionId: $discussionId, title: $title, body: $body }) { discussion { id title body } } }',
      { discussionId, title, body },
    );
  const updated = gqlPath(data, 'updateDiscussion', 'discussion');
  const id = fieldAt(updated, 'id');
  if (!isProviderString(id) || id !== discussionId || fieldAt(updated, 'title') !== title
    || (body !== undefined && fieldAt(updated, 'body') !== body)) {
    throw invalidProviderPayload('GitHub returned an invalid discussion update');
  }
  return {};
};
export const setDiscussionAnswer = async (octokit: Octokit, commentId: string, answer: boolean) => {
  const field = answer ? 'markDiscussionCommentAsAnswer' : 'unmarkDiscussionCommentAsAnswer';
  const data = await graphqlWrite(octokit, `mutation($id: ID!) { ${field}(input: { id: $id }) { discussion { id } } }`, { id: commentId });
  if (!isProviderString(gqlPath(data, field, 'discussion', 'id'))) throw invalidProviderPayload('GitHub returned an invalid answer');
  return {};
};
export const setDiscussionLabels = async (octokit: Octokit, project: Project, discussion: Discussion, labels: string[]) => {
  let ids: string[] = [];
  if (labels.length > 0) {
    const variables: LabelVariables = { owner: project.owner, name: project.name };
    const selections = labels.map((label, index) => {
      variables[`l${index}`] = label;
      return `l${index}: label(name: $l${index}) { id name }`;
    });
    const declarations = labels.map((_label, index) => `$l${index}: String!`).join(', ');
    const data = await graphqlWrite(octokit, `query($owner: String!, $name: String!, ${declarations}) { repository(owner: $owner, name: $name) { ${selections.join(' ')} } }`, variables);
    ids = labels.map((label, index) => {
      const id = gqlPath(data, 'repository', `l${index}`, 'id');
      if (!isProviderString(id)) throw mutationError(`Label ${label} does not exist in this repository`, 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
      return id;
    });
  }
  const current = discussion.labels.map((label) => label.id);
  const add = ids.filter((id) => !current.includes(id));
  const remove = current.filter((id) => !ids.includes(id));
  if (add.length) {
    await graphqlWrite(octokit, 'mutation($id: ID!, $labelIds: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labelIds }) { clientMutationId } }', { id: discussion.id, labelIds: add });
  }
  if (remove.length) {
    try {
      await graphqlWrite(octokit, 'mutation($id: ID!, $labelIds: [ID!]!) { removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labelIds }) { clientMutationId } }', { id: discussion.id, labelIds: remove });
    } catch (error) {
      if (!add.length) throw error;
      throw new Error('GitHub changed only part of the labels', { cause: error });
    }
  }
  return {};
};
export const setLabels = async (octokit: Octokit, project: Project, number: number, labels: string[]) => {
  const response = await rejected(() => octokit.rest.issues.setLabels({ owner: project.owner, repo: project.name, issue_number: number, labels }));
  requireProviderArray(fieldAt(response, 'data'), 'GitHub returned an invalid label list');
  return {};
};
export const requestedReviewers = async (octokit: Octokit, project: Project, number: number) => {
  const response = await octokit.rest.pulls.listRequestedReviewers({ owner: project.owner, repo: project.name, pull_number: number });
  const users = response?.data?.users;
  if (!Array.isArray(users) || users.some((user) => !isProviderString(user?.login))) {
    throw invalidProviderPayload('GitHub returned an invalid reviewer list');
  }
  return users.map((user) => user.login);
};
export const setReviewers = async (octokit: Octokit, project: Project, number: number, reviewers: string[]) => {
  const current = await requestedReviewers(octokit, project, number);
  const add = reviewers.filter((login) => !current.includes(login));
  const remove = current.filter((login) => !reviewers.includes(login));
  const pull = { owner: project.owner, repo: project.name, pull_number: number };
  await rejected(async () => {
    if (add.length) await octokit.rest.pulls.requestReviewers({ ...pull, reviewers: add });
    if (remove.length) await octokit.rest.pulls.removeRequestedReviewers({ ...pull, reviewers: remove });
  });
  return {};
};
export const setState = async (update: () => Promise<{ data?: { state?: string } }>, state: ItemState) => {
  const response = await rejected(update);
  if (response?.data?.state !== state) throw invalidProviderPayload('GitHub returned an unexpected state');
  return { state };
};
