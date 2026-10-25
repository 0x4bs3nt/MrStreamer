interface ReviewLogin {
  readonly username: string;
  readonly passwordSha256: string;
  readonly retiring?: { readonly passwordSha256: string; readonly retireAfterUtc: string | null };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const verifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Configuration is a secret binding, never an API response or shipped client login. */
export function readLogin(secret: string | undefined): ReviewLogin | null {
  if (!secret || secret.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(secret);
    if (
      !object(value) ||
      typeof value.username !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.username) ||
      !verifier(value.passwordSha256)
    )
      return null;
    if (value.retiring === undefined)
      return { username: value.username, passwordSha256: value.passwordSha256 };
    const old = value.retiring;
    if (
      !object(old) ||
      !verifier(old.passwordSha256) ||
      (old.retireAfterUtc !== null &&
        (typeof old.retireAfterUtc !== "string" ||
          !Number.isFinite(Date.parse(old.retireAfterUtc))))
    )
      return null;
    return {
      username: value.username,
      passwordSha256: value.passwordSha256,
      retiring: { passwordSha256: old.passwordSha256, retireAfterUtc: old.retireAfterUtc },
    };
  } catch {
    return null;
  }
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** Always compare fixed-size buffers, including the username and both password positions. */
export async function validLogin(
  username: string,
  password: string,
  login: ReviewLogin,
  now: number,
): Promise<boolean> {
  const text = new TextEncoder();
  const [givenUser, expectedUser, givenPassword] = await Promise.all([
    crypto.subtle.digest("SHA-256", text.encode(username)),
    crypto.subtle.digest("SHA-256", text.encode(login.username)),
    crypto.subtle.digest("SHA-256", text.encode(password)),
  ]);
  const sameUser = crypto.subtle.timingSafeEqual(givenUser, expectedUser);
  const current = crypto.subtle.timingSafeEqual(givenPassword, bytes(login.passwordSha256));
  const old = crypto.subtle.timingSafeEqual(
    givenPassword,
    bytes(login.retiring?.passwordSha256 ?? login.passwordSha256),
  );
  const retiringActive =
    login.retiring !== undefined &&
    (login.retiring.retireAfterUtc === null || now < Date.parse(login.retiring.retireAfterUtc));
  return sameUser && (current || (old && retiringActive));
}
