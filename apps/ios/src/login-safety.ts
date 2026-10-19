// Whether text the app keeps on disk could give a subscription's login away. The saved copies of
// lists use it to keep artwork addresses that may carry the login out of their files, and to leave
// out what holds the password anywhere else. Pure: nothing here reads or writes a file.

/** The longest artwork address kept. */
export const URL_LENGTH = 2048;

/** How many layers of encoding, or addresses within addresses, are looked through. */
const LAYERS = 4;

/** A subscription's login as `exposes` looks for it. */
export type Login = { readonly username: string; readonly password: string };

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/**
 * `url` when the disk may keep it: an http(s) address of at most 2048 characters that doesn't
 * give the login away (`exposes`). Otherwise null.
 */
export function safeUrl(url: string | null, username: string, password: string): string | null {
  if (url === null || url.length > URL_LENGTH) return null;
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  return exposes(url, { username, password }, LAYERS, parsed) ? null : url;
}

/**
 * Whether `text`, an address or a part of one, gives the login away: it is the username, or
 * holds the password, as written or decoded as percent or form encoding ("+" a space) spells it,
 * and so on for `layers` more decodings; an address within it, such as an image proxy's, counts
 * with its own login, path parts, fragment, and query names and values. Text that won't decode,
 * or still decodes or holds an address after the last layer, counts as giving it away.
 */
export function exposes(
  text: string,
  login: Login,
  layers = LAYERS,
  address = text.includes(":") ? URL.parse(text) : null,
): boolean {
  const { username, password } = login;
  if ((username !== "" && text === username) || (password !== "" && text.includes(password))) {
    return true;
  }
  const next = new Set([decoded(text), decoded(text.replaceAll("+", " "))]);
  next.delete(text);
  if (!address && next.size === 0) return false;
  if (layers === 0 || next.has(null)) return true;
  if (address && (address.username !== "" || address.password !== "")) return true;
  const parts = address
    ? [address.hash.slice(1), ...address.pathname.split("/"), ...[...address.searchParams].flat()]
    : [];
  return [...parts, ...next].some((part) => part !== null && exposes(part, login, layers - 1));
}

/** Whether a text within `value`, a copied row, holds `password`. Artwork kept has none. */
export function holds(value: unknown, password: string): boolean {
  if (typeof value === "string") return value.includes(password);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).some((each: unknown) => holds(each, password))
  );
}
