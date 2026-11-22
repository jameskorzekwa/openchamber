export function deferredPoll<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve: (value: T) => resolve(value) };
}
