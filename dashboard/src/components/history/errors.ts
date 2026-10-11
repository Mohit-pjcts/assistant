/** A rejected promise can carry anything; the panel always wants an Error. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
