/**
 * Result type — explicit success / failure without exceptions.
 *
 * When new code is written, prefer returning `Result<T, E>` instead of
 * throwing. This makes error paths visible at the call site and avoids
 * the "what does this throw?" question that plagues async code paths.
 *
 * Existing code that already throws can continue to do so; new code at
 * boundaries (collector loops, handler dispatch, retry wrappers) should
 * return `Result` so callers can branch without try/catch noise.
 *
 * Usage:
 *
 *   const r = await tryFetch(url);
 *   if (!r.ok) return err(r.error);
 *   return ok(r.value);
 */

/** Discriminated union — either a success carrying `value`, or a failure carrying `error`. */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Construct a successful Result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Construct a failed Result. `E` defaults to `Error` for ergonomic call sites. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** True when `r` is a success branch. Use as a type guard. */
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok === true;
}

/** True when `r` is a failure branch. Use as a type guard. */
export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return r.ok === false;
}

/**
 * Unwrap a Result, throwing the error on failure. Use only when the
 * caller has already checked `.ok` or wants the throw-on-fail behavior.
 */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw r.error instanceof Error ? r.error : new Error(String(r.error));
}

/**
 * Wrap a throwing async function so it returns a Result. Useful when
 * adopting Result at the boundary while leaving inner code throw-based.
 */
export async function tryAsync<T, E = Error>(
  fn: () => Promise<T>,
  mapError?: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    const value = await fn();
    return ok(value);
  } catch (cause) {
    const mapped = mapError
      ? mapError(cause)
      : (cause instanceof Error ? cause : new Error(String(cause))) as unknown as E;
    return err(mapped);
  }
}
