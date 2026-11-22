export interface TerminalHistory {
  chunks: { buffer: Buffer; length: number }[];
  head: number;
  offset: number;
  bytes: number;
  original: string[] | null;
  originalTail: string;
  originalLast: string | undefined;
}

const MAX_HISTORY_BYTES = 512 * 1024;
const HISTORY_SEGMENT_BYTES = 8 * 1024;

export const newHistory = (): TerminalHistory => ({ chunks: [], head: 0, offset: 0, bytes: 0, original: [], originalTail: '', originalLast: '' });
export const historyText = (history: TerminalHistory) => history.original
  ? history.original.join('') + history.originalTail
  : Buffer.concat(history.chunks.slice(history.head).map((chunk, index) => chunk.buffer.subarray(index === 0 ? history.offset : 0, chunk.length))).toString('utf8');
const appendHistoryBytes = (history: TerminalHistory, bytes: Buffer) => {
  let offset = 0;
  while (offset < bytes.length) {
    let tail = history.chunks.at(-1);
    if (!tail || tail.length === HISTORY_SEGMENT_BYTES) {
      tail = { buffer: Buffer.allocUnsafe(HISTORY_SEGMENT_BYTES), length: 0 };
      history.chunks.push(tail);
    }
    const length = Math.min(bytes.length - offset, HISTORY_SEGMENT_BYTES - tail.length);
    bytes.copy(tail.buffer, tail.length, offset, offset + length);
    tail.length += length;
    offset += length;
  }
  history.bytes += bytes.length;
};
const removeHistoryTail = (history: TerminalHistory, count: number) => {
  history.bytes -= count;
  while (count > 0) {
    const tail = history.chunks.at(-1);
    if (!tail) throw new TypeError("Cannot read properties of undefined (reading 'length')");
    const removed = Math.min(tail.length, count);
    tail.length -= removed;
    count -= removed;
    if (!tail.length) history.chunks.pop();
  }
};
const appendOriginal = (history: TerminalHistory, original: string[], text: string) => {
  let offset = 0;
  while (offset < text.length) {
    const length = Math.min(text.length - offset, HISTORY_SEGMENT_BYTES - history.originalTail.length);
    history.originalTail += text.slice(offset, offset + length);
    offset += length;
    if (history.originalTail.length === HISTORY_SEGMENT_BYTES) {
      original.push(history.originalTail);
      history.originalTail = '';
    }
  }
  history.originalLast = text.at(-1);
};
export const appendHistory = (history: TerminalHistory, text: string) => {
  if (!text) return;
  let encoded = text;
  if (history.original && /[\uD800-\uDBFF]/.test(String(history.originalLast)) && /^[\uDC00-\uDFFF]/.test(text)) {
    removeHistoryTail(history, 3);
    encoded = history.originalLast + text;
  }
  const bytes = Buffer.from(encoded);
  if (history.bytes + bytes.length <= MAX_HISTORY_BYTES) {
    appendHistoryBytes(history, bytes);
    if (history.original) appendOriginal(history, history.original, text);
    return;
  }

  if (bytes.length >= MAX_HISTORY_BYTES) {
    let start = bytes.length - MAX_HISTORY_BYTES;
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    history.chunks = []; history.head = 0; history.offset = 0; history.bytes = 0;
    appendHistoryBytes(history, bytes.subarray(start));
    history.original = null;
    history.originalTail = '';
    return;
  }

  appendHistoryBytes(history, bytes);

  let remove = history.bytes - MAX_HISTORY_BYTES;
  let removed = 0;
  while (remove > 0) {
    const chunk = history.chunks[history.head];
    if (!chunk) throw new TypeError("Cannot read properties of undefined (reading 'length')");
    const available = chunk.length - history.offset;
    if (remove < available) { history.offset += remove; removed += remove; break; }
    remove -= available;
    removed += available;
    history.head += 1;
    history.offset = 0;
  }
  while (history.head < history.chunks.length) {
    const chunk = history.chunks[history.head];
    if (!chunk) throw new TypeError("Cannot read properties of undefined (reading 'length')");
    if (history.offset === chunk.length) { history.head += 1; history.offset = 0; continue; }
    if (((chunk.buffer[history.offset] ?? 0) & 0xc0) !== 0x80) break;
    history.offset += 1;
    removed += 1;
  }
  history.bytes -= removed;
  history.original = null;
  history.originalTail = '';
  if (history.head > 128) { history.chunks = history.chunks.slice(history.head); history.head = 0; }
};
