// ArkType builds a schema when `type` is called. A schema defined at a module's top level is
// built as soon as anything imports the module, so the app's main process and its catalogue
// worker would build every schema they can reach while they start, used or not. Schemas are
// defined with `lazy` instead, and built on their first use.

/**
 * A value built on the first call and kept for the next ones:
 * `const Settings = lazy(() => type({ ... }))`, then `Settings()(data)`.
 *
 * A lazy schema left uncalled where a schema belongs fails loudly instead of working by chance.
 * The getter declares a parameter, so ArkType doesn't take it for a schema thunk and refuses the
 * definition when it is built; and called with an argument, as `.pipe(Settings)` would call it on
 * every value, it throws.
 */
export function lazy<A>(build: () => A): () => A {
  let built: { readonly value: A } | null = null;
  return function get(_unused?: never) {
    if (arguments.length > 0)
      throw new TypeError("A lazy schema was used as a value: call it, as `Schema()`.");
    return (built ??= { value: build() }).value;
  };
}

/** What a lazy schema gives: `type Settings = Infer<typeof Settings>`. */
export type Infer<S extends () => { readonly infer: unknown }> = ReturnType<S>["infer"];
