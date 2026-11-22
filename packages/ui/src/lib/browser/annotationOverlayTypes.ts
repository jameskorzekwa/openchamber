export type BrowserAnnotationOverlayTheme = {
  readonly colorScheme: 'light' | 'dark';
  readonly primary: string;
  readonly primarySoft: string;
  readonly primaryFaint: string;
  readonly primaryContrast: string;
  readonly surface: string;
  readonly surfaceElevated: string;
  readonly glassSurface: string;
  readonly glassFilter: string;
  readonly border: string;
  readonly text: string;
  readonly mutedText: string;
  readonly danger: string;
};

export type BrowserAnnotationOverlayLabels = {
  readonly select: string;
  readonly marquee: string;
  readonly draw: string;
  readonly commentPlaceholder: string;
  readonly submit: string;
};

export type BrowserAnnotationVoice = {
  readonly shortcut: { key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean } | null;
  readonly labels: {
    readonly start: string;
    readonly cancel: string;
    readonly insert: string;
    readonly listening: string;
    readonly processing: string;
  };
  readonly icons: { readonly mic: string; readonly close: string; readonly check: string; readonly loader: string };
};

export type AnnotationOverlayMessage = { type: 'voice'; action: 'start' | 'finish' | 'cancel' };

export type AnnotationAppMessage =
  | { type: 'voice'; phase: 'idle' | 'recording' | 'processing'; note?: string; failed?: boolean }
  | { type: 'insert'; text: string; ends?: boolean }
  | { type: 'level'; level: number };
