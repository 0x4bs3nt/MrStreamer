// Loaded into the verified app's main process with NODE_OPTIONS=--require, for the downloads
// scenarios only. It records every outbound TCP connection and UDP send main makes, so the proof
// can say what main asked of the network and when, and it answers artwork hosts from the run's
// loopback picture server: fixtures replace the external image CDN as they replace TMDB's API.
// It changes nothing else. Chromium's own requests are recorded over CDP by the scenario.
const dgram = require("node:dgram");
const fs = require("node:fs");
const net = require("node:net");

const log = process.env.VERIFY_NETWORK_LOG;
const images = process.env.VERIFY_IMAGES;
const IMAGE_HOSTS = new Set(["image.tmdb.org", "image.example"]);

function write(entry) {
  if (log) fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (first.path) write({ kind: "ipc", path: String(first.path) });
    else write({ kind: "tcp", host: first.host ?? "localhost", port: Number(first.port) });
  } else if (typeof first === "string" && Number.isNaN(Number(first))) {
    write({ kind: "ipc", path: first });
  } else {
    write({
      kind: "tcp",
      host: typeof args[1] === "string" ? args[1] : "localhost",
      port: Number(first),
    });
  }
  return connect.apply(this, args);
};

const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const address = args.find((arg, index) => index > 0 && typeof arg === "string");
  const port = args.find((arg, index) => index > 0 && typeof arg === "number" && arg > 0);
  write({ kind: "udp", host: address ?? "unknown", port: port ?? null });
  return send.apply(this, args);
};

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = URL.parse(href);
  if (images && url && IMAGE_HOSTS.has(url.hostname)) {
    write({ kind: "artwork", host: url.hostname, path: url.pathname });
    return fetchOriginal(`${images}${url.pathname}`, init);
  }
  return fetchOriginal(input, init);
};
