// The Xtream adapter's Node part: telling an https port that drops connections from one that
// refuses them, which fetch can't. The adapter itself is shared with the iOS app, in core.
import { connect, isIP, type Socket } from "node:net";

export {
  bodySize,
  describeNetworkError,
  httpsUnavailable,
  parseLogin,
  xtreamProvider,
  type ParsedLogin,
} from "@mrstreamer/core/xtream";

/**
 * How long an https port gets to accept a connection once its name resolved. A lost first packet
 * is sent again after a second, so this allows for one. Chrome and Firefox wait as long before
 * they try http for an address typed without a scheme.
 */
const CONNECT_TIMEOUT_MS = 3_000;

/** Opens a TCP connection, as `net.connect` does. A test gives one that stays unanswered. */
export type TcpConnect = (options: { host: string; port: number }) => Socket;

/**
 * Whether the https address `server` leaves a connection unanswered. That is when its name
 * resolves and its port neither accepts nor refuses within `CONNECT_TIMEOUT_MS`, as when a
 * firewall drops the packets instead of refusing them. Fetch takes ten seconds or more to give up
 * there. The connection sends nothing and closes at once. A server that is slow to answer has
 * accepted it by then, and a name that doesn't resolve says nothing about https, so both get a
 * no. `signal` ends the attempt.
 */
export function connectionIgnored(
  server: string,
  signal: AbortSignal,
  open: TcpConnect = connect,
): Promise<boolean> {
  const url = new URL(server);
  // An IPv6 address comes in brackets.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const socket = open({ host, port: url.port === "" ? 443 : Number(url.port) });
    let deadline: NodeJS.Timeout | undefined;
    const finish = (ignored: boolean) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", answered);
      socket.destroy();
      resolve(ignored);
    };
    const answered = () => finish(false);
    // A name can still resolve after `signal` ended the attempt.
    const wait = () => {
      if (!socket.destroyed) deadline ??= setTimeout(finish, CONNECT_TIMEOUT_MS, true);
    };
    signal.addEventListener("abort", answered);
    // The time the name takes to resolve, or to fail to, doesn't count.
    if (isIP(host)) wait();
    else {
      socket.once("lookup", (error) => {
        if (!error) wait();
      });
    }
    socket.once("connect", answered);
    socket.on("error", answered);
  });
}
