/**
 * Cookie plumbing for the session bridge.
 *
 * A framed site is cross-site to the extension page that holds it, so the
 * browser treats it as a third party where cookies are concerned. Script access
 * is the half that reliably goes: `document.cookie` reads back empty inside the
 * frame, so an app that keeps its session token there decides nobody is signed
 * in and redirects to its login page - and the token a sign-in performed inside
 * the frame writes goes nowhere either. Request cookies may or may not survive
 * depending on the browser and the reader's third-party cookie setting.
 *
 * The bridge carries the real cookie jar into the frame instead, in two halves:
 * a `Cookie` request header written by a declarativeNetRequest rule, which is
 * the only way to reach HttpOnly server sessions, and a `document.cookie` shim
 * for the tokens single-page apps read from script.
 *
 * Everything here is pure string work so it can be tested without a browser.
 * The frame does the least it possibly can - it relays the raw `Set-Cookie`
 * string it was given - and this module is what understands the attributes.
 */

/** Serialise a chrome.cookies list into a `Cookie` request header value. */
export function cookieHeader(cookies) {
  return (cookies ?? [])
    .filter((c) => c?.name)
    .map((c) => `${c.name}=${c.value ?? ''}`)
    .join('; ');
}

/** The subset a page can see from script; HttpOnly rides the header instead. */
export function scriptCookies(cookies) {
  return (cookies ?? [])
    .filter((c) => c?.name && !c.httpOnly)
    .map((c) => ({ name: c.name, value: c.value ?? '' }));
}

const attribute = (text, name) =>
  new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]*)`, 'i').exec(text)?.[1]?.trim() ?? null;

const hasFlag = (text, name) =>
  new RegExp(`(?:^|;)\\s*${name}\\s*(?:;|$)`, 'i').test(text);

/** Chrome wants the enum lower-cased; anything unrecognised is left to default. */
const SAME_SITE = {
  strict: 'strict',
  lax: 'lax',
  none: 'no_restriction',
};

/**
 * Parse one `document.cookie` assignment.
 *
 * Returns null when there is no name to speak of, and `removed: true` when the
 * assignment is a deletion - the way scripts delete a cookie is to re-set it
 * with `max-age=0` or a date in the past, so a bridge that only ever added
 * would resurrect the cookie a sign-out just cleared.
 */
export function parseCookieAssignment(text, now = Date.now()) {
  const raw = String(text ?? '');
  const [pair] = raw.split(';');
  const at = pair.indexOf('=');
  // A nameless `=value` is not a cookie, and neither is a bare flag.
  if (at < 1) return null;

  /*
   * Attributes only exist after the first semicolon. Searching the whole string
   * would read `path=/x` as an attribute of a cookie *named* path - unlikely, but
   * the kind of thing that silently writes a cookie to the wrong path forever.
   */
  const semi = raw.indexOf(';');
  const attrs = semi === -1 ? '' : raw.slice(semi);

  const maxAge = attribute(attrs, 'max-age');
  const expires = attribute(attrs, 'expires');
  const expiresAt = expires ? Date.parse(expires) : NaN;

  // Max-Age wins outright where both are given, as the spec says.
  const removed =
    maxAge !== null
      ? Number(maxAge) <= 0
      : !Number.isNaN(expiresAt) && expiresAt <= now;

  const cookie = {
    name: pair.slice(0, at).trim(),
    value: pair.slice(at + 1).trim(),
    path: attribute(attrs, 'path') || '/',
    secure: hasFlag(attrs, 'secure'),
    removed,
  };

  const sameSite = SAME_SITE[attribute(attrs, 'samesite')?.toLowerCase()];
  if (sameSite) cookie.sameSite = sameSite;

  // A session cookie has neither, and must stay one.
  if (!removed && maxAge !== null && Number(maxAge) > 0) {
    cookie.expirationDate = Math.floor((now + Number(maxAge) * 1000) / 1000);
  } else if (!removed && !Number.isNaN(expiresAt)) {
    cookie.expirationDate = Math.floor(expiresAt / 1000);
  }

  return cookie;
}
