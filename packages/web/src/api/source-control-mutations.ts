import type {
  ReviewChangeRequestInput,
  SourceControlIdentity,
  SourceControlEmptyMutationResult,
  SourceControlCreateMutationTarget,
  SourceControlExistingMutationTarget,
  SourceControlExpectedMutationTarget,
  SourceControlCreateMutationResult,
  SourceControlMergeMutationResult,
  SourceControlMutationContext,
  SourceControlMutationReceipt,
  SourceControlReadyMutationResult,
  SourceControlDraftMutationResult,
  SourceControlReviewMutationResult,
  SourceControlStateMutationResult,
  SourceControlResolvedMutationTarget,
} from '@openchamber/ui/lib/api/types';
import { isProviderUserId } from '../../server/lib/source-control/provider-id.js';
import {
  isBooleanValue,
  isNonEmptyString,
  isNumberValue,
  isPositiveSafeInteger,
  isStringValue,
  type BoundaryScalar,
} from './boundary-guards';

export interface ErrorResponse {
  error?: string;
  code?: string;

  provider?: string;
}

export type MutationBody<TTarget extends SourceControlExpectedMutationTarget = SourceControlExpectedMutationTarget> = SourceControlMutationContext<TTarget>;

export interface CreateBody extends MutationBody<SourceControlCreateMutationTarget> {
  title: string;
  body?: string;
  draft?: boolean;
  remote?: string;
  headRemote?: string;
}

export interface UpdateBody extends MutationBody<SourceControlExistingMutationTarget> {
  title: string;
  body?: string;
}

export interface MutationReceiptDTO extends ErrorResponse {
  status: string;
  actor: { provider: string; instance: string; providerAccountId: string };
  target: {
    repositoryId: string;
    bindingRevision: number;
    primaryRemote: string;
    project: { id: string; owner: string; name: string };
    number?: number;
    head?: string;
    base?: string;
    headSha?: string;
  };
  replayed: boolean;
  result: MutationResultDTO;
}

interface MutationResultDTO {
  merged?: boolean;
  message?: string;
  outcome?: string;
  stacked?: boolean;
  ready?: boolean;
  draft?: boolean;
  commented?: boolean;
  state?: string;
}


export type ReviewBody = MutationBody<SourceControlExistingMutationTarget> & { body?: string } & (
  | { verdict: NonNullable<ReviewChangeRequestInput['verdict']> }
  | { votes: Record<string, number>; publishDrafts?: boolean }
);

const isNonNegativeSafeInteger = (value: BoundaryScalar): value is number => isNumberValue(value) && Number.isSafeInteger(value) && value >= 0;
export function createSourceControlMutationCodec(isProjectOwner: (identity: SourceControlIdentity, owner: BoundaryScalar) => owner is string) {
  type ExactKeyValue = MutationReceiptDTO
    | MutationReceiptDTO['actor']
    | MutationReceiptDTO['target']
    | MutationReceiptDTO['target']['project']
    | MutationResultDTO;

  const hasExactKeys = (value: ExactKeyValue, keys: readonly string[]): boolean => {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
  };

  function mutationBody(
    payload: SourceControlMutationContext<SourceControlCreateMutationTarget>,
    identity: SourceControlIdentity,
    operation: 'create',
  ): MutationBody<SourceControlCreateMutationTarget>;
  function mutationBody(
    payload: SourceControlMutationContext<SourceControlExistingMutationTarget>,
    identity: SourceControlIdentity,
    operation: 'existing',
  ): MutationBody<SourceControlExistingMutationTarget>;
  function mutationBody(
    payload: SourceControlMutationContext,
    identity: SourceControlIdentity,
    operation: 'create' | 'existing',
  ): MutationBody {
    const target = payload.target;
    if (!isNonEmptyString(payload.directory) || !isNonEmptyString(payload.repositoryId)
      || !isNonEmptyString(payload.accountId) || !isNonNegativeSafeInteger(payload.bindingRevision)
      || !isNonEmptyString(payload.primaryRemote) || !isNonEmptyString(payload.idempotencyKey)
      || !target || !isProjectOwner(identity, target.project?.owner) || !isNonEmptyString(target.project?.name)
      || (operation === 'create' && ('number' in target || 'headSha' in target))
      || (operation === 'create' && (!isNonEmptyString(target.head) || !isNonEmptyString(target.base)))
      || (operation === 'existing' && !isPositiveSafeInteger(target.number))
      || (target.number !== undefined && !isPositiveSafeInteger(target.number))
      || (target.head !== undefined && !isNonEmptyString(target.head))
      || (target.base !== undefined && !isNonEmptyString(target.base))
      || (target.headSha !== undefined && !isNonEmptyString(target.headSha))) {
      throw new Error('Source control mutation context is invalid');
    }
    const context = {
      ...identity,
      directory: payload.directory,
      repositoryId: payload.repositoryId,
      accountId: payload.accountId,
      bindingRevision: payload.bindingRevision,
      primaryRemote: payload.primaryRemote,
      idempotencyKey: payload.idempotencyKey,
    };
    if (operation === 'create') {
      if (!isNonEmptyString(target.head) || !isNonEmptyString(target.base)) {
        throw new Error('Source control mutation context is invalid');
      }
      return {
        ...context,
        target: {
          project: { owner: target.project.owner, name: target.project.name },
          head: target.head,
          base: target.base,
        },
      };
    }
    if (!isPositiveSafeInteger(target.number)) {
      throw new Error('Source control mutation context is invalid');
    }
    const expectedTarget: SourceControlExistingMutationTarget = {
      project: { owner: target.project.owner, name: target.project.name },
      number: target.number,
    };
    if (target.head !== undefined) expectedTarget.head = target.head;
    if (target.base !== undefined) expectedTarget.base = target.base;
    if (target.headSha !== undefined) expectedTarget.headSha = target.headSha;
    return { ...context, target: expectedTarget };
  }

  const mutationTargetMatches = (
    target: MutationReceiptDTO['target'],
    context: SourceControlMutationContext,
  ): boolean => target.repositoryId === context.repositoryId
    && target.bindingRevision === context.bindingRevision
    && target.primaryRemote === context.primaryRemote
    && target.project.owner === context.target.project.owner
    && target.project.name === context.target.project.name
    && (context.target.number === undefined || target.number === context.target.number)
    && (context.target.head === undefined || target.head === context.target.head)
    && (context.target.base === undefined || target.base === context.target.base)
    && (context.target.headSha === undefined || target.headSha === context.target.headSha);

  const parseMutationReceipt = <TResult>(
    payload: MutationReceiptDTO,
    context: SourceControlMutationContext,
    identity: SourceControlIdentity,
    parseResult: (result: MutationResultDTO) => TResult,
  ): SourceControlMutationReceipt<TResult> => {
    const actor = payload?.actor;
    const target = payload?.target;
    const project = target?.project;
    if (!payload || !hasExactKeys(payload, ['status', 'actor', 'target', 'replayed', 'result'])
      || payload.status !== 'succeeded' || !isBooleanValue(payload.replayed)
      || !actor || !hasExactKeys(actor, ['provider', 'instance', 'providerAccountId'])
      || actor.provider !== identity.provider || actor.instance !== identity.instance
      || !isNonEmptyString(actor.providerAccountId) || !isProviderUserId(identity.provider, identity.instance, actor.providerAccountId)
      || !target || !hasExactKeys(target, [
        'repositoryId', 'bindingRevision', 'primaryRemote', 'project',
        ...(['number', 'head', 'base', 'headSha'] as const).filter((key) => target[key] !== undefined),
      ])
      || !isNonEmptyString(target.repositoryId) || !isNonNegativeSafeInteger(target.bindingRevision)
      || !isNonEmptyString(target.primaryRemote) || !project || !hasExactKeys(project, ['id', 'owner', 'name'])
      || !isNonEmptyString(project.id) || !isProjectOwner(identity, project.owner) || !isNonEmptyString(project.name)
      || (target.number !== undefined && !isPositiveSafeInteger(target.number))
      || (target.head !== undefined && !isNonEmptyString(target.head))
      || (target.base !== undefined && !isNonEmptyString(target.base))
      || (target.headSha !== undefined && !isNonEmptyString(target.headSha))
      || !mutationTargetMatches(target, context)
      || !payload.result || Object.prototype.toString.call(payload.result) !== '[object Object]') {
      throw new Error('Source control response contained an invalid mutation receipt');
    }
    const resolvedTarget: SourceControlResolvedMutationTarget = {
      repositoryId: target.repositoryId,
      bindingRevision: target.bindingRevision,
      primaryRemote: target.primaryRemote,
      project: { id: project.id, owner: project.owner, name: project.name },
    };
    if (target.number !== undefined) resolvedTarget.number = target.number;
    if (target.head !== undefined) resolvedTarget.head = target.head;
    if (target.base !== undefined) resolvedTarget.base = target.base;
    if (target.headSha !== undefined) resolvedTarget.headSha = target.headSha;
    return {
      status: 'succeeded',
      actor: { ...identity, providerAccountId: actor.providerAccountId },
      target: resolvedTarget,
      replayed: payload.replayed,
      result: parseResult(payload.result),
    };
  };

  const parseEmptyMutationResult = (result: MutationResultDTO): SourceControlEmptyMutationResult => {
    if (!hasExactKeys(result, [])) throw new Error('Source control response contained an invalid mutation result');
    return {};
  };

  const MERGE_OUTCOMES = ['queued', 'merging', 'auto-merge', 'cancelled'] as const;
  const mergeOutcomeOf = (value: string): SourceControlMergeMutationResult['outcome'] | null => (
    MERGE_OUTCOMES.find((outcome) => outcome === value) ?? null
  );

  const parseCreateMutationResult = (result: MutationResultDTO): SourceControlCreateMutationResult => {
    if (!hasExactKeys(result, result.stacked === undefined ? [] : ['stacked'])
      || (result.stacked !== undefined && !isBooleanValue(result.stacked))) {
      throw new Error('Source control response contained an invalid create result');
    }
    return result.stacked === undefined ? {} : { stacked: result.stacked };
  };

  const parseMergeMutationResult = (result: MutationResultDTO): SourceControlMergeMutationResult => {
    const keys = ['merged', ...(result.message === undefined ? [] : ['message']), ...(result.outcome === undefined ? [] : ['outcome'])];
    const outcome = result.outcome === undefined ? undefined : mergeOutcomeOf(result.outcome);
    if (!hasExactKeys(result, keys) || !isBooleanValue(result.merged)
      || (result.message !== undefined && !isStringValue(result.message)) || outcome === null) {
      throw new Error('Source control response contained an invalid merge result');
    }
    const parsed: SourceControlMergeMutationResult = { merged: result.merged };
    if (result.message !== undefined) parsed.message = result.message;
    if (outcome !== undefined) parsed.outcome = outcome;
    return parsed;
  };

  const parseReviewMutationResult = (result: MutationResultDTO): SourceControlReviewMutationResult => {
    if (!hasExactKeys(result, ['commented']) || !isBooleanValue(result.commented)) {
      throw new Error('Source control response contained an invalid review result');
    }
    return { commented: result.commented };
  };

  const parseStateMutationResult = (result: MutationResultDTO): SourceControlStateMutationResult => {
    if (!hasExactKeys(result, ['state']) || (result.state !== 'open' && result.state !== 'closed')) {
      throw new Error('Source control response contained an invalid state result');
    }
    return { state: result.state };
  };

  const parseReadyMutationResult = (result: MutationResultDTO): SourceControlReadyMutationResult => {
    if (!hasExactKeys(result, ['ready']) || !isBooleanValue(result.ready)) {
      throw new Error('Source control response contained an invalid ready result');
    }
    return { ready: result.ready };
  };

  const parseDraftMutationResult = (result: MutationResultDTO): SourceControlDraftMutationResult => {
    if (!hasExactKeys(result, ['draft']) || !isBooleanValue(result.draft)) {
      throw new Error('Source control response contained an invalid draft result');
    }
    return { draft: result.draft };
  };

  return {
    mutationBody,
    parseMutationReceipt,
    parseEmptyMutationResult,
    parseCreateMutationResult,
    parseMergeMutationResult,
    parseReviewMutationResult,
    parseStateMutationResult,
    parseReadyMutationResult,
    parseDraftMutationResult,
  };
}
