import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { CISummary, ChangeRequestRevision, ChangeRequestRevisionKind, RepositoryReference } from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ChecksGlyph } from './ReferencePickerRow';
import { REFERENCE_META_TEXT } from './referencePickerItems';
import { useReferenceImagePreview } from './useReferenceImagePreview';

const ZOOMABLE_IMAGE_CLASS = '[&_[data-markdown-content]_img:not(a_img):not([aria-hidden=true])]:cursor-zoom-in';

export const PreviewFrame: React.FC<{ pinned: boolean; header: React.ReactNode; meta: React.ReactNode; footer: React.ReactNode; children: React.ReactNode }> = ({ pinned, header, meta, footer, children }) => {
    const imagePreview = useReferenceImagePreview();
    if (!pinned) {
        return (
            <article className={cn('flex flex-col gap-4', ZOOMABLE_IMAGE_CLASS)} onClick={imagePreview.onClick}>
                <header className="flex flex-col gap-2">{header}</header>
                <div className="border-b border-edge pb-4">{meta}</div>
                {children}
                <div className="rounded-lg border border-edge px-3 py-2.5">{footer}</div>
                {imagePreview.viewer}
            </article>
        );
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-edge px-6 pb-4 pt-5">
                <header className="flex flex-col gap-2">{header}</header>
            </div>
            <ScrollableOverlay outerClassName="min-h-0 flex-1" className="px-6 pb-5 pt-4" disableHorizontal>
                <article className={cn('flex flex-col gap-4', ZOOMABLE_IMAGE_CLASS)} onClick={imagePreview.onClick}>
                    <div className="border-b border-edge pb-4">{meta}</div>
                    {children}
                </article>
            </ScrollableOverlay>
            <div className="shrink-0 border-t border-edge px-6 py-3">{footer}</div>
            {imagePreview.viewer}
        </div>
    );
};

export const StatePill: React.FC<{
    icon: React.ComponentProps<typeof Icon>['name'];
    color: string;
    label: string;
    trailing?: React.ReactNode;
}> = ({ icon, color, label, trailing }) => (
    <span
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 typography-meta font-medium"
        style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
        <Icon name={icon} className="size-3.5" />
        {label}
        {trailing}
    </span>
);

const ChecksSummaryText: React.FC<{ checks: CISummary }> = ({ checks }) => {
    const { t } = useI18n();
    if (checks.state === 'failure') return <>{t('references.picker.preview.checksFailed', { failed: checks.failure, total: checks.total })}</>;
    if (checks.state === 'pending') return <>{t('references.picker.preview.checksPending', { pending: checks.pending, total: checks.total })}</>;
    if (checks.state === 'success') return <>{t('references.picker.preview.checksPassed')}</>;
    return null;
};

export const ChecksSummaryLine: React.FC<{ checks: CISummary }> = ({ checks }) => (
    <>
        <ChecksGlyph checks={checks} />
        <ChecksSummaryText checks={checks} />
    </>
);

const REVISION_KIND_KEYS = {
    rework: 'references.picker.preview.revision.kind.rework',
    'trivial-rebase': 'references.picker.preview.revision.kind.trivialRebase',
    'merge-first-parent-update': 'references.picker.preview.revision.kind.mergeUpdate',
    'no-code-change': 'references.picker.preview.revision.kind.noCodeChange',
    'no-change': 'references.picker.preview.revision.kind.noChange',
} as const satisfies Record<ChangeRequestRevisionKind, I18nKey>;

export type RevisionChoice = {
    revisions: ChangeRequestRevision[];
    selected: string | null;
    onSelect: (sha: string | null) => void;
};

export const RevisionPicker: React.FC<{ choice: RevisionChoice }> = ({ choice }) => {
    const { t } = useI18n();
    const latest = choice.revisions.at(-1);
    if (!latest || choice.revisions.length < 2) return null;
    const shown = choice.revisions.find((revision) => revision.sha === choice.selected) ?? latest;
    const labelOf = (revision: ChangeRequestRevision) => (revision === latest
        ? t('references.picker.preview.revision.latest', { number: revision.number })
        : t('references.picker.preview.revision.number', { number: revision.number }));
    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className={cn(dropdownTriggerVariants(), 'min-w-0 max-w-[14rem] font-normal')}
                            aria-label={t('references.picker.preview.revision.label')}
                        >
                            <span className="truncate">{labelOf(shown)}</span>
                            <Icon name="arrow-down-s" className="size-3.5" />
                        </button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('contextTooltips.tracker.choosePatchset')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuRadioGroup
                    value={shown.sha}
                    onValueChange={(value) => choice.onSelect(value === latest.sha ? null : String(value))}
                >
                    {[...choice.revisions].reverse().map((revision) => (
                        <DropdownMenuRadioItem key={revision.sha} value={revision.sha}>
                            <span className="min-w-0 flex-1 truncate">{labelOf(revision)}</span>
                            {revision.kind && revision.kind !== 'rework' ? (
                                <span className={cn('shrink-0 typography-meta', REFERENCE_META_TEXT)}>{t(REVISION_KIND_KEYS[revision.kind])}</span>
                            ) : null}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export const ChangeFlags: React.FC<{ reference: RepositoryReference }> = ({ reference }) => {
    const { t } = useI18n();
    if (reference.kind !== 'pull') return null;
    const flags = [
        reference.workInProgress && !reference.draft ? t('references.picker.preview.wip') : null,
        reference.private ? t('references.picker.preview.private') : null,
    ].filter((flag): flag is string => flag !== null);
    if (flags.length === 0 && !reference.topic) return null;
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {flags.map((flag) => (
                <span key={flag} className="inline-flex h-5 shrink-0 items-center rounded-full bg-surface-muted px-2 typography-micro text-muted-foreground">{flag}</span>
            ))}
            {reference.topic ? (
                <span className={cn('min-w-0 truncate typography-meta', REFERENCE_META_TEXT)} title={reference.topic}>
                    {t('references.picker.preview.topic', { topic: reference.topic })}
                </span>
            ) : null}
        </span>
    );
};
