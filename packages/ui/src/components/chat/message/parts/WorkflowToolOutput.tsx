import * as React from 'react';
import { z } from 'zod';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { JsonValue, ToolPart } from '@/lib/opencode/model';
import { workflowRunSchema, type WorkflowRun } from '@/lib/workflows/model';
import { openWorkflowRunInPanel } from '@/lib/workflows/panel';
import { useWorkflowRun } from '@/lib/workflows/store';
import { workflowRunLook } from '../../workflows/workflowRunPresentation';
import { workflowCheckedSchema, workflowListedSchema, workflowResultSchema, workflowSavedSchema, workflowStoppedSchema } from './openChamberToolEnvelope';
import { usePanelsAvailable } from './toolResultContext';
import { Actions, Field, List, ListRow, Section, type OpenActionInput } from './ToolResultParts';

const answerText = (value: JsonValue | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const plain = z.string().safeParse(value);
    return plain.success ? plain.data : JSON.stringify(value, null, 2);
};

const WorkflowRunState: React.FC<{ state: WorkflowRun['state'] }> = ({ state }) => {
    const { t } = useI18n();
    const look = workflowRunLook(state);
    return (
        <span className="inline-flex items-center gap-1" style={look.color ? { color: look.color } : undefined}>
            <Icon name={look.icon} className="size-3.5 shrink-0" />
            {t(look.labelKey)}
        </span>
    );
};

const useOpenWorkflowRun = (isMobile: boolean, sessionId: string, runId: string | undefined): OpenActionInput | null => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const directory = useWorkflowRun(sessionId, runId ?? '')?.directory;
    return panels && directory && runId
        ? { label: t('chat.toolPart.openchamber.open.workflow'), icon: 'flow-chart', onOpen: () => openWorkflowRunInPanel(directory, sessionId, runId) }
        : null;
};

export const WorkflowCheckedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = workflowCheckedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { name, description, phases } = parsed.data;
    return (
        <>
            <div className="typography-meta font-medium text-foreground break-words">{name}</div>
            {description ? <div className="typography-meta break-words text-muted-foreground">{description}</div> : null}
            {phases.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.field.phases')}>
                    <ol className="min-w-0 space-y-0.5">
                        {phases.map((phase, index) => <ListRow key={phase} primary={`${index + 1}. ${phase}`} />)}
                    </ol>
                </Section>
            ) : null}
            <Actions />
        </>
    );
};

export const WorkflowStatusBody: React.FC<{ data: unknown; isMobile: boolean }> = ({ data, isMobile }) => {
    const { t } = useI18n();
    const parsed = workflowRunSchema.safeParse(data);
    const run = parsed.success ? parsed.data : null;
    const open = useOpenWorkflowRun(isMobile, run?.parentSessionId ?? '', run?.id);
    if (!run) return null;
    const done = run.agents.filter((agent) => agent.state === 'completed').length;
    return (
        <>
            <div className="typography-meta font-medium text-foreground break-words">{run.name}</div>
            <Field label={t('chat.toolPart.openchamber.field.state')}><WorkflowRunState state={run.state} /></Field>
            {run.currentPhase ? <Field label={t('chat.toolPart.openchamber.field.phase')}>{run.currentPhase}</Field> : null}
            {run.agents.length > 0 ? (
                <Field label={t('chat.toolPart.openchamber.field.agents')}>{t('chat.toolPart.openchamber.workflow.agentsDone', { done, count: run.agents.length })}</Field>
            ) : null}
            {run.error ? <div className="typography-meta break-words" style={{ color: 'var(--status-error)' }}>{run.error}</div> : null}
            {run.resultPreview ? <div className="typography-meta line-clamp-6 whitespace-pre-wrap break-words text-foreground">{run.resultPreview}</div> : null}
            <Actions open={open} />
        </>
    );
};

export const WorkflowResultBody: React.FC<{ data: unknown; part: ToolPart; isMobile: boolean }> = ({ data, part, isMobile }) => {
    const { t } = useI18n();
    const parsed = workflowResultSchema.safeParse(data);
    const open = useOpenWorkflowRun(isMobile, part.sessionID, parsed.success ? parsed.data.runId : undefined);
    if (!parsed.success) return null;
    const answer = parsed.data;
    const text = answerText('agent' in answer ? answer.agent.result : answer.result);
    const error = 'agent' in answer ? answer.agent.error : answer.error;
    return (
        <>
            {'agent' in answer ? <Field label={t('chat.toolPart.openchamber.field.agent')}>{answer.agent.label}</Field> : null}
            {'state' in answer ? <Field label={t('chat.toolPart.openchamber.field.state')}><WorkflowRunState state={answer.state} /></Field> : null}
            {error ? <div className="typography-meta break-words" style={{ color: 'var(--status-error)' }}>{error}</div> : null}
            {text ? <div className="typography-meta whitespace-pre-wrap break-words text-foreground">{text}</div> : null}
            <Actions open={open} />
        </>
    );
};

export const WorkflowListedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = workflowListedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { workflows, runs } = parsed.data;
    return (
        <>
            {workflows.length + runs.length === 0 ? <List count={0}>{null}</List> : null}
            {workflows.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.workflow.saved')}>
                    <List count={workflows.length}>
                        {workflows.map((workflow) => <ListRow key={workflow.name} primary={workflow.name} secondary={workflow.error ?? workflow.description} />)}
                    </List>
                </Section>
            ) : null}
            {runs.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.workflow.runs')}>
                    <List count={runs.length}>
                        {runs.map((run) => <ListRow key={run.runId} primary={run.name} secondary={run.state ? <WorkflowRunState state={run.state} /> : undefined} />)}
                    </List>
                </Section>
            ) : null}
            <Actions />
        </>
    );
};

export const WorkflowChangedBody: React.FC<{ data: unknown; part: ToolPart; isMobile: boolean }> = ({ data, part, isMobile }) => {
    const { t } = useI18n();
    const parsed = workflowStoppedSchema.safeParse(data);
    const open = useOpenWorkflowRun(isMobile, part.sessionID, parsed.success ? parsed.data.runId : undefined);
    if (!parsed.success) return null;
    const { reused } = parsed.data;
    return (
        <>
            {reused ? <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.workflow.reused', { count: reused })}</div> : null}
            <Actions open={open} />
        </>
    );
};

export const WorkflowSavedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = workflowSavedSchema.safeParse(data);
    if (!parsed.success) return null;
    return (
        <>
            <div className="typography-meta font-medium text-foreground break-words">{parsed.data.name}</div>
            <Field label={t('chat.toolPart.openchamber.field.file')}>{parsed.data.path}</Field>
            <Actions />
        </>
    );
};
