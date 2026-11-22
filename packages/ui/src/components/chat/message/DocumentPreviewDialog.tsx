import React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { PdfArtifact } from '@/components/views/files/previews/PdfArtifact';
import { cn } from '@/lib/utils';
import type { ToolPopupContent } from './types';

const dataUrlBytes = (url: string): Uint8Array<ArrayBuffer> | null => {
    const match = /^data:[^,]*;base64,(.*)$/s.exec(url);
    if (!match) return null;
    try {
        return Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0));
    } catch {
        return null;
    }
};

export const DocumentPreviewDialog: React.FC<{
    popup: ToolPopupContent;
    onOpenChange: (open: boolean) => void;
    isMobile: boolean;
}> = ({ popup, onOpenChange, isMobile }) => {
    const pdf = popup.document;
    const [file, setFile] = React.useState<{ src: string; size: number } | null>(null);
    React.useEffect(() => {
        if (!popup.open || !pdf) return;
        const bytes = dataUrlBytes(pdf.url);
        if (!bytes) return;
        const src = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        setFile({ src, size: bytes.byteLength });
        return () => {
            URL.revokeObjectURL(src);
            setFile(null);
        };
    }, [pdf, popup.open]);
    if (!pdf) return null;

    return (
        <Dialog open={popup.open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    'overflow-hidden flex flex-col min-h-0 pt-3 pb-4 px-4 gap-2',
                    isMobile ? 'w-[95vw] max-w-[95vw] [&>button]:top-1.5 [&>button]:inset-e-1' : 'max-w-5xl [&>button]:top-2.5 [&>button]:inset-e-4',
                )}
                style={{ height: '90vh' }}
            >
                <div className="flex flex-shrink-0 items-center gap-2 pe-8">
                    <FileTypeIcon filePath={pdf.filename} className="h-4 w-4 flex-shrink-0" />
                    <DialogTitle className="min-w-0 flex-1 truncate typography-ui-header font-semibold text-foreground">{popup.title}</DialogTitle>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden rounded-xl oc-tile">
                    {file ? <PdfArtifact src={file.src} name={pdf.filename} sizeBytes={file.size} /> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
};
