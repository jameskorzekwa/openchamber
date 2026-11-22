declare module 'proper-lockfile' {
  interface LockOptions {
    realpath?: boolean;
    lockfilePath?: string;
    stale?: number;
    update?: number;
    retries?: number;
  }
  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  const lockfile: { lock: typeof lock };
  export default lockfile;
}
