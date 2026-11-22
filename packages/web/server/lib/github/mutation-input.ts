import { digestMutationInput } from '../source-control/mutation-executor.js';
import { reviewCommentPosition } from '../source-control/review-position.js';
import { isProviderString } from './mappers.js';
import { isSourceControlInteger } from '../source-control/input-guards.js';
import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { AccountIdentity, ProviderDescriptor, ProviderMutationContext, ProviderSession } from '../source-control/provider-contract.js';
import type { MutationCompletion, MutationRecord } from '../source-control/mutation-storage.js';
import type { GitHubResourceOptions } from './resources.js';
import type { GitHubEnvelope, Octokit, RestEndpointMethodTypes } from './contracts.js';

export type MutationTarget = SourceControlMutationTarget;
export type Project = Pick<MutationTarget['project'], 'owner' | 'name'>;
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type ItemState = 'open' | 'closed';
type Credential = { accountId: string; credentialRevision: number };
export type Rest = RestEndpointMethodTypes;
export interface MutationPull {
  number: number;
  state: ItemState;
  merged?: unknown;
  merged_at?: unknown;
  draft?: unknown;
  node_id?: unknown;
  head: { ref: string; sha: string; repo?: { owner: { login: string }; name: string } | null };
  base: { ref: string; repo: { owner: { login: string }; name: string; default_branch?: unknown } };
}
type ReviewPosition = ReturnType<typeof reviewCommentPosition>;
export type Discussion = { id: string; closed: boolean; labels: { id: string; name: string }[]; title: string | undefined; body: string | undefined };
export interface GitHubMutationOptions {
  descriptor: ProviderDescriptor;
  octokitOf(session: ProviderSession): Octokit & { openChamberHost?: string };
  resolveRepo: GitHubResourceOptions['resolveRepo'];
  resolveNetwork: GitHubResourceOptions['resolveNetwork'];
  invalidatePulls(owner: string, repo: string, octokit: Octokit): Promise<void>;
  onSucceeded(input: { session: ProviderSession; target: MutationTarget }): void;
}
export interface GitHubMutationInput {
  title?: string | undefined; body?: string | undefined; draft?: boolean | undefined; remote?: string | undefined;
  headRemote?: string | undefined; head?: string | undefined; base?: string | undefined; method?: MergeMethod; cancel?: boolean;
  labels?: string[]; reviewers?: string[]; replyTo?: string | undefined; state?: ItemState; reason?: SourceControlJson | undefined;
  commentId?: number | string; answer?: boolean; threadId?: string; resolved?: boolean; verdict?: SourceControlJson | undefined;
  path?: string; side?: ReviewPosition['side']; line?: number; startLine?: number;
}
export interface GitHubMutationTarget {
  sourceProject?: Project | null;
  discussion?: Discussion;
  pendingReviewId?: unknown;
  pullRequestId?: unknown;
  already?: boolean;
  nodeId?: string | null;
}
export interface MutationStep {
  session: ProviderSession;
  route: string; kind: string;
  input: GitHubMutationInput;
  resolved: { providerTarget: GitHubMutationTarget; target: MutationTarget };
}
export interface MutationPreparation {
  route: string; input: SourceControlJsonObject | null | undefined; context: ProviderMutationContext; actor: AccountIdentity; credential: Credential;
}
export interface MutationResolution {
  session: ProviderSession; context: ProviderMutationContext; kind: string; input: GitHubMutationInput; replayOf?: MutationRecord;
}
export interface NormalizedGitHubMutation { input: GitHubMutationInput; digest(target: MutationTarget): string }
export interface GitHubMutationErrorBody { error: unknown; code: string; current?: unknown }
export interface LabelVariables { owner: string; name: string; [label: `l${number}`]: string }
interface MutationFailure {
  response?: unknown; status?: unknown; code?: unknown; message?: unknown; errors?: unknown; data?: unknown;
  current?: unknown; name?: unknown;
}
const hasFailureFields = (value: unknown): value is MutationFailure => value != null;
export const failureFields = (cause: unknown) => hasFailureFields(cause) ? cause : undefined;
export const statusOf = (cause: unknown) => {
  const error = failureFields(cause);
  return failureFields(error?.response)?.status ?? error?.status;
};
export const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const hasGraphQLField = <Key extends string>(value: unknown, _key: Key): value is { [Name in Key]?: unknown } =>
  value != null;
export const fieldAt = <Key extends string>(value: GitHubEnvelope['data'], key: Key) =>
  hasGraphQLField(value, key) ? value[key] : undefined;
export const gqlPath = (value: GitHubEnvelope['data'], ...keys: string[]) => keys.reduce<GitHubEnvelope['data']>(fieldAt, value);
export const requireField = <Value>(value: Value, name: string): NonNullable<Value> => {
  if (value == null) throw new TypeError(`GitHub mutation field ${name} is missing`);
  return value;
};
const isMergeMethod = (value: unknown): value is MergeMethod => value === 'merge' || value === 'squash' || value === 'rebase';
const isJsonBoolean = (value: SourceControlJson | undefined): value is boolean =>
  Object.prototype.toString.call(value) === '[object Boolean]';
export const restId = (value: GitHubMutationInput['commentId']) => {
  if (!isSourceControlInteger(value)) throw new TypeError('GitHub REST comment ID is missing');
  return value;
};
export const graphqlId = (value: GitHubMutationInput['commentId']) => {
  if (!isProviderString(value)) throw new TypeError('GitHub GraphQL comment ID is missing');
  return value;
};
const isNameList = (value: unknown): value is string[] => isArray(value)
  && !value.some((entry) => !isProviderString(entry) || !entry.trim() || entry.length > 256);
export const isDiscussionLabelList = (values: unknown): values is Discussion['labels'] => isArray(values)
  && !values.some((label) => !isProviderString(fieldAt(label, 'id')) || !isProviderString(fieldAt(label, 'name')));

export const ISSUE_KINDS = new Set([
  'issue-comment', 'issue-comment-update', 'issue-comment-delete', 'issue-state', 'issue-labels', 'issue-update',
  'change-request-comment-update', 'change-request-comment-delete',
]);
export const DISCUSSION_KINDS = new Set([
  'discussion-comment', 'discussion-comment-update', 'discussion-comment-delete',
  'discussion-state', 'discussion-answer', 'discussion-labels', 'discussion-update',
]);
export const CONVERSATION_COMMENT_KINDS = new Set([
  'change-request-comment-update', 'change-request-comment-delete', 'issue-comment-update', 'issue-comment-delete',
]);
const ownKind = (operation: string) => ISSUE_KINDS.has(operation) || DISCUSSION_KINDS.has(operation);
export const recordKind = (operation: string) => (ownKind(operation) ? operation : `change-request-${operation}`);
export const operationOf = (kind: string) => (ownKind(kind) ? kind : kind.replace(/^change-request-/, ''));
export const DISCUSSION_CLOSE_REASONS = Object.freeze({ resolved: 'RESOLVED', outdated: 'OUTDATED', duplicate: 'DUPLICATE' });

export const ROUTE_OPERATIONS = Object.freeze({
  '/pr/create': 'create',
  '/pr/update': 'update',
  '/pr/merge': 'merge',
  '/pr/ready': 'ready',
  '/pr/draft': 'draft',
  '/pr/comment': 'comment',
  '/pr/review': 'review',
  '/pr/review/comment': 'review-comment',
  '/pr/review/comment/update': 'review-comment-update',
  '/pr/review/comment/delete': 'review-comment-delete',
  '/pr/review/discard': 'review-discard',
  '/pr/thread/reply': 'thread-reply',
  '/pr/thread/resolve': 'thread-resolve',
  '/pr/comment/update': 'change-request-comment-update',
  '/pr/comment/delete': 'change-request-comment-delete',
  '/issues/comment': 'issue-comment',
  '/issues/update': 'issue-update',
  '/issues/comment/update': 'issue-comment-update',
  '/issues/comment/delete': 'issue-comment-delete',
  '/pr/state': 'state',
  '/issues/state': 'issue-state',
  '/pr/labels': 'labels',
  '/issues/labels': 'issue-labels',
  '/pr/reviewers': 'reviewers',
  '/discussions/comment': 'discussion-comment',
  '/discussions/comment/update': 'discussion-comment-update',
  '/discussions/comment/delete': 'discussion-comment-delete',
  '/discussions/state': 'discussion-state',
  '/discussions/answer': 'discussion-answer',
  '/discussions/labels': 'discussion-labels',
  '/discussions/update': 'discussion-update',
});

export const REVIEW_DRAFT_OPERATIONS = new Set(['review-comment', 'review-comment-update', 'review-comment-delete', 'review-discard']);
export const REVIEW_EVENTS = Object.freeze({
  approve: { event: 'APPROVE', state: 'APPROVED' },
  'request-changes': { event: 'REQUEST_CHANGES', state: 'CHANGES_REQUESTED' },
  comment: { event: 'COMMENT', state: 'COMMENTED' },
});

export const mutationError = (message: string, code = 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status = 400) => Object.assign(new Error(message), { code, status });
export const definiteFailure = (code: string): MutationCompletion => ({ state: 'failed', result: { failureStatus: 409, failureCode: code } });
export const unknownOutcome = (): MutationCompletion => ({ state: 'outcome-unknown' });

export const sameProject = (left: { owner?: string | undefined; name?: string | undefined } | null | undefined, right: Project | null | undefined) => left?.owner === right?.owner && left?.name === right?.name;
export const sameNames = (left: string[], right: string[]) => left.length === right.length && [...left].sort().every((entry, index) => entry === right[index]);
export const repoProject = (repo: { owner: string; repo: string }) => ({ owner: repo.owner, name: repo.repo });
export const pullTargetProject = (pr: MutationPull) => ({ owner: pr.base.repo.owner.login, name: pr.base.repo.name });
export const targetMatches = (expected: Pick<MutationTarget, 'number' | 'head' | 'base' | 'headSha'>, pr: MutationPull) => pr.number === expected.number
  && (expected.head === undefined || pr.head.ref === expected.head)
  && (expected.base === undefined || pr.base.ref === expected.base)
  && (expected.headSha === undefined || pr.head.sha === expected.headSha);

export const providerRejection = (cause: unknown) => {
  const status = statusOf(cause);
  if (status !== 403 && status !== 404 && status !== 405 && status !== 409 && status !== 422) return cause;
  const data = failureFields(failureFields(failureFields(cause)?.response)?.data);
  const first = isArray(data?.errors) ? data.errors[0] : undefined;
  const detail = [first, failureFields(first)?.message, data?.message].find((value): value is string => isProviderString(value) && Boolean(value.trim()));
  return mutationError(detail ?? 'GitHub refused the change', 'SOURCE_CONTROL_MUTATION_REJECTED', status);
};

// external: https://docs.github.com/en/graphql/overview/resource-limitations GraphQL can report a refused write in errors with HTTP 200.
export const graphqlRejection = (cause: unknown) => {
  const errors = failureFields(cause)?.errors;
  const matching = isArray(errors) ? errors.find((entry) => isProviderString(failureFields(entry)?.message)) : undefined;
  const message = failureFields(matching)?.message;
  return isProviderString(message) && message ? mutationError(message, 'SOURCE_CONTROL_MUTATION_REJECTED', 422) : providerRejection(cause);
};

export const rejected = async <Result>(operation: () => Promise<Result>) => {
  try {
    return await operation();
  } catch (error) {
    throw failureFields(error)?.response ? providerRejection(error) : error;
  }
};

function commentText(value: SourceControlJson | undefined, required: true, maxLength: number): string;
function commentText(value: SourceControlJson | undefined, required: boolean, maxLength: number): string | undefined;
function commentText(value: SourceControlJson | undefined, required: boolean, maxLength: number) {
  if (value === undefined && !required) return undefined;
  if (!isProviderString(value) || !value.trim()) throw mutationError('body is required');
  if (value.length > maxLength) throw mutationError('body is too long');
  return value;
}
const nodeId = (value: SourceControlJson | undefined, name: string) => {
  if (!isProviderString(value) || !/^[A-Za-z0-9_=-]{1,200}$/.test(value)) throw mutationError(`${name} is invalid`);
  return value;
};
const restCommentId = (value: SourceControlJson | undefined) => {
  const id = isProviderString(value) || Number.isSafeInteger(value) ? String(value).trim() : '';
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw mutationError('commentId is invalid');
  return Number(id);
};
const reviewThreadId = (value: SourceControlJson | undefined) => nodeId(value, 'threadId');
const nameList = (value: SourceControlJson | undefined, name: string, limit: number): string[] => {
  if (!isArray(value) || value.length > limit || !isNameList(value)) {
    throw mutationError(`${name} are invalid`);
  }
  return [...new Set(value)].sort();
};
const requiredText = (value: SourceControlJson | undefined, name: string) => {
  if (!isProviderString(value) || !value.trim()) throw mutationError(`${name} is required`);
  return value.trim();
};
export const optionalText = (value: GitHubEnvelope['data'], name: string, trim = false) => {
  if (value === undefined) return undefined;
  if (!isProviderString(value)) throw mutationError(`${name} is invalid`);
  const normalized = trim ? value.trim() : value;
  if (trim && !normalized) throw mutationError(`${name} is invalid`);
  return normalized;
};

export function normalizeOperation(operation: string, body: SourceControlJsonObject, context: ProviderMutationContext, actor: AccountIdentity, credential: Credential, limits: ProviderDescriptor['limits']): NormalizedGitHubMutation {
  const digestOf = <Fields extends { target: MutationTarget }>(fields: Fields) => digestMutationInput({ kind: operation, actor, credential, ...fields });
  if (operation === 'create') {
    const title = requiredText(body.title, 'title');
    const text = optionalText(body.body, 'body');
    if (body.draft !== undefined && !isJsonBoolean(body.draft)) {
      throw mutationError('draft is invalid');
    }
    const draft = body.draft;
    const remote = optionalText(body.remote, 'remote', true);
    const headRemote = optionalText(body.headRemote, 'headRemote', true) ?? context.primaryRemote;
    const head = requiredText(context.target.head, 'target head');
    const base = requiredText(context.target.base, 'target base');
    if (context.target.number !== undefined || context.target.headSha !== undefined) throw mutationError('Create target is invalid');
    return {
      input: { title, body: text, draft, remote, headRemote, head, base },
      digest: (target) => {
        const fields: { target: MutationTarget } & Pick<GitHubMutationInput, 'title' | 'headRemote' | 'body' | 'draft' | 'remote'> = { target, title, headRemote };
        if (text !== undefined) fields.body = text;
        if (draft !== undefined) fields.draft = draft;
        if (remote) fields.remote = remote;
        return digestOf(fields);
      },
    };
  }

  if (!isSourceControlInteger(context.target.number) || context.target.number < 1) throw mutationError('target number is required');
  if (operation === 'update' || operation === 'issue-update' || operation === 'discussion-update') {
    const title = requiredText(body.title, 'title');
    const text = optionalText(body.body, 'body');
    return {
      input: { title, body: text },
      digest: (target) => digestOf(text === undefined ? { target, title } : { target, title, body: text }),
    };
  }
  if (operation === 'merge') {
    const method = requiredText(body.method, 'method');
    if (!isMergeMethod(method)) throw mutationError('merge method is invalid');
    if (body.cancel !== undefined && body.cancel !== true && body.cancel !== false) throw mutationError('cancel is invalid');
    return body.cancel === true
      ? { input: { method, cancel: true }, digest: (target) => digestOf({ target, method, cancel: true }) }
      : { input: { method }, digest: (target) => digestOf({ target, method }) };
  }
  if (operation === 'ready' || operation === 'draft') return { input: {}, digest: (target) => digestOf({ target }) };
  if (operation === 'labels' || operation === 'issue-labels' || operation === 'discussion-labels') {
    const labels = nameList(body.labels, 'labels', limits.labelsMax);
    return { input: { labels }, digest: (target) => digestOf({ target, labels }) };
  }
  if (operation === 'discussion-comment') {
    const replyTo = body.replyTo === undefined ? undefined : nodeId(body.replyTo, 'replyTo');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return {
      input: { replyTo, body: text },
      digest: (target) => digestOf(replyTo === undefined ? { target, body: text } : { target, replyTo, body: text }),
    };
  }
  if (operation === 'discussion-state') {
    if (body.state === 'open') {
      if (body.reason !== undefined) throw mutationError('reason is invalid');
      return { input: { state: 'open' }, digest: (target) => digestOf({ target, state: 'open' }) };
    }
    if (body.state !== 'closed' || !Object.hasOwn(DISCUSSION_CLOSE_REASONS, String(body.reason))) throw mutationError('state is invalid');
    const { reason } = body;
    return { input: { state: 'closed', reason }, digest: (target) => digestOf({ target, state: 'closed', reason }) };
  }
  if (operation === 'discussion-answer') {
    const commentId = nodeId(body.commentId, 'commentId');
    if (body.answer !== true && body.answer !== false) throw mutationError('answer is invalid');
    const { answer } = body;
    return { input: { commentId, answer }, digest: (target) => digestOf({ target, commentId, answer }) };
  }
  if (operation === 'change-request-comment-update' || operation === 'issue-comment-update') {
    const commentId = restCommentId(body.commentId);
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'change-request-comment-delete' || operation === 'issue-comment-delete') {
    const commentId = restCommentId(body.commentId);
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'discussion-comment-update') {
    const commentId = nodeId(body.commentId, 'commentId');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'discussion-comment-delete') {
    const commentId = nodeId(body.commentId, 'commentId');
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'reviewers') {
    const reviewers = nameList(body.reviewers, 'reviewers', limits.reviewersMax);
    return { input: { reviewers }, digest: (target) => digestOf({ target, reviewers }) };
  }
  if (operation === 'state' || operation === 'issue-state') {
    if (body.state !== 'open' && body.state !== 'closed') throw mutationError('state is invalid');
    const { state } = body;
    return { input: { state }, digest: (target) => digestOf({ target, state }) };
  }
  if (operation === 'comment' || operation === 'issue-comment') {
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { body: text }, digest: (target) => digestOf({ target, body: text }) };
  }
  if (operation === 'thread-reply') {
    const threadId = reviewThreadId(body.threadId);
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { threadId, body: text }, digest: (target) => digestOf({ target, threadId, body: text }) };
  }
  if (operation === 'thread-resolve') {
    const threadId = reviewThreadId(body.threadId);
    if (body.resolved !== true && body.resolved !== false) throw mutationError('resolved is invalid');
    const { resolved } = body;
    return { input: { threadId, resolved }, digest: (target) => digestOf({ target, threadId, resolved }) };
  }
  if (operation === 'review') {
    const { verdict } = body;
    if (!Object.hasOwn(REVIEW_EVENTS, String(verdict))) throw mutationError('review verdict is invalid');
    requiredText(context.target.headSha, 'target headSha');
    const text = commentText(body.body, verdict === 'request-changes', limits.commentMaxLength);
    return {
      input: { verdict, body: text },
      digest: (target) => digestOf(text === undefined ? { target, verdict } : { target, verdict, body: text }),
    };
  }
  if (operation === 'review-comment') {
    requiredText(context.target.headSha, 'target headSha');
    const position = reviewCommentPosition(body, (message) => { throw mutationError(message); });
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { ...position, body: text }, digest: (target) => digestOf({ target, ...position, body: text }) };
  }
  if (operation === 'review-comment-update') {
    const commentId = nodeId(body.commentId, 'commentId');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'review-comment-delete') {
    const commentId = nodeId(body.commentId, 'commentId');
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'review-discard') return { input: {}, digest: (target) => digestOf({ target }) };
  throw mutationError('Mutation kind is invalid');
}
