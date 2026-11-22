import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { requestReasoningReveal } from '@/components/chat/search/reasoningReveal';
import type { ConversationResult } from '@/hooks/useConversationSearch';
import { useMessageSearch } from '@/hooks/useMessageSearch';
import { ConversationResultRow } from '@/components/search/ConversationResultRow';
import type { ConversationResultContext } from '@/components/search/conversationResultContext';
import type { OmniAuthor } from '@/lib/search/omniQuery';
import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { leadWithMatch, splitSnippet } from '@/lib/messageSearch';

const PAGE_SIZE = 100;

type SearchResultRowsProps = {
  result: ConversationResult;
  query: string;
  context: ConversationResultContext;
  mobile: boolean;
  onOpen: () => void;
  onOpenExcerpt: (messageId: string) => void;
  onRestore: () => void;
  restoreLabel: string;
  restorable: boolean;
  author: OmniAuthor;
  includeReasoning: boolean;
  contentAvailable: boolean;
};

export function ArchiveSearchResultRow({ result, query, context, mobile, onOpen, onOpenExcerpt, onRestore, restoreLabel, restorable, author, includeReasoning, contentAvailable }: SearchResultRowsProps): React.ReactNode {
  const { t } = useI18n();
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const expansionKey = `${query}\0${author}\0${includeReasoning}\0${contentAvailable}`;
  const showMatches = expandedKey === expansionKey;
  const matches = useMessageSearch({ query, enabled: showMatches && contentAvailable, limit: PAGE_SIZE, sessionId: result.sessionId, lifecycle: 'archived', role: author === 'any' ? null : author, includeReasoning });
  const openHit = (messageId: string, hitRole: string): void => {
    requestReasoningReveal(hitRole === 'reasoning' ? messageId : null);
    onOpenExcerpt(messageId);
  };
  return <div data-archive-search-result={result.sessionId}>
    <ConversationResultRow
      result={result}
      context={context}
      mobile={mobile}
      onOpen={onOpen}
      onOpenExcerpt={() => {
        if (result.excerpt) openHit(result.excerpt.messageId, result.excerpt.role);
      }}
      onShowMoreMatches={result.moreMatches > 0 && contentAvailable ? () => setExpandedKey(expansionKey) : undefined}
      trailing={restorable ? <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size={mobile ? 'lg' : 'xs'} className={mobile ? 'min-h-11 min-w-11' : undefined} onClick={onRestore} aria-label={restoreLabel}><Icon name="inbox-unarchive" className="size-3.5" /></Button></TooltipTrigger><TooltipContent>{restoreLabel}</TooltipContent></Tooltip> : null}
    />
    {showMatches ? <div className="ms-3 space-y-0.5" data-archive-other-matches={result.sessionId} aria-live="polite">
      {'hits' in matches.state ? matches.state.hits.filter((hit) => hit.id !== result.excerpt?.messageId).map((hit) => <button key={hit.id} type="button" className="block w-full truncate text-start typography-micro text-muted-foreground hover:text-foreground" onClick={() => openHit(hit.id, hit.role)}><MatchHighlight segments={leadWithMatch(splitSnippet(hit.snippet))} /></button>) : null}
      {matches.state.status === 'loading' ? <span className="typography-micro text-muted-foreground">{t('search.omni.status.searching')}</span> : null}
      {matches.state.status === 'error' || (matches.state.status === 'ready' && matches.state.pageError) ? <span className="typography-micro text-muted-foreground">{t('search.omni.status.error')}</span> : null}
      {matches.state.status === 'unavailable' ? <span className="typography-micro text-muted-foreground">{t('search.omni.status.unsupported')}</span> : null}
      {matches.state.status === 'too-short' ? <span className="typography-micro text-muted-foreground">{t('search.omni.status.tooShort')}</span> : null}
      {matches.state.status === 'ready' && matches.state.next ? <button type="button" className="typography-micro text-muted-foreground hover:text-foreground hover:underline" onClick={matches.loadMore} disabled={matches.state.loadingMore}>{t('search.omni.result.loadMore')}</button> : null}
    </div> : null}
  </div>;
}
