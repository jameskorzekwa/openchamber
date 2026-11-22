import fs from 'fs';
import path from 'path';
import { errorCodeSchema, parse, parseJson, storedFileSchema, waitSchema } from './wait-model.js';
import type { Wait } from './wait-model.js';

const FILE_NAME = 'extension-waits.json';
const FILE_VERSION = 1;

export function createWaitStore(dataDir: string, now: () => number, warn: (...args: unknown[]) => void) {
  const filePath = path.join(dataDir, FILE_NAME);
  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parse(errorCodeSchema, error)?.code === 'ENOENT') return { waits: [], revision: 0 };
      throw error;
    }
    const stored = parse(storedFileSchema, parseJson(raw));
    if (!stored) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      warn(`[extension-waits] file was unreadable and moved to ${backup}`);
      return { waits: [], revision: 0 };
    }
    const restored = stored.waits.map((value) => parse(waitSchema, value)).filter((wait) => wait !== null);
    return { waits: restored, revision: stored.revision ?? 0 };
  };

  const writeFile = async (revision: number, waits: Map<string, Wait>) => {
    const payload = JSON.stringify({ version: FILE_VERSION, revision, waits: Array.from(waits.values()) });
    await fs.promises.mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmpPath, filePath);
  };
  return { readFile, writeFile };
}
