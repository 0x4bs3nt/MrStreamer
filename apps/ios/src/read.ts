import { useEffect, useState } from "react";
import { appError, describeError } from "./errors.ts";

// Reads a screen waits for, each answering only the request it was made for: a title's details
// for the version shown, a season's episodes for the season shown. While another request is
// pending, its screen shows loading rather than an earlier request's answer, so nothing on it
// plays or marks another version's or season's episode in the meantime. A read may show what it
// already knows before its answer, such as details saved on the phone while they are asked again.

export type Loaded<A> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: A }
  | { readonly kind: "failed"; readonly error: string };

const LOADING = { kind: "loading" } as const;

/**
 * What `read` answers for the request `key` names, null for none. A changed key shows loading at
 * once, in the same render, until that request answers. `read` may pass `show` what it knows
 * before it answers, which shows until the next. `again` reads the same request anew and keeps
 * showing its answer meanwhile. What arrives after its request was replaced is dropped.
 */
export function useRead<A>(
  key: string | null,
  read: (show: (value: A) => void) => Promise<A>,
  again?: unknown,
): Loaded<A> {
  const [held, setHeld] = useState<{ readonly key: string; readonly loaded: Loaded<A> } | null>(
    null,
  );
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const show = (value: A) => {
      if (current) setHeld({ key, loaded: { kind: "ready", value } });
    };
    read(show).then(
      show,
      (cause: unknown) =>
        current &&
        setHeld({ key, loaded: { kind: "failed", error: describeError(appError(cause)) } }),
    );
    return () => {
      current = false;
    };
  }, [key, read, again]);
  return key !== null && held?.key === key ? held.loaded : LOADING;
}
