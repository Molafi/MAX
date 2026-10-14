/**
 * MAX — SSRF guard for server-side fetches (web_fetch power).
 *
 *  • isPrivateAddress(ip)    → true for loopback / private / link-local / CGNAT /
 *                              multicast / reserved IPv4 + IPv6 (incl. IPv4-mapped,
 *                              NAT64 and 6to4 forms that embed a private IPv4).
 *  • assertPublicUrl(url)    → resolves the hostname with dns.lookup (all records)
 *                              and throws if ANY address is private.
 *  • createSafeLookup()      → a dns.lookup drop-in for http/https.request that
 *                              re-checks the address at connect time, so a DNS
 *                              rebinding answer can't slip a private IP in between
 *                              the check and the connection.
 *  • fetchPublic(url, opts)  → GET with manual, re-validated redirects, a byte cap,
 *                              a total deadline and gzip/deflate/br decoding.
 *
 * Zero dependencies.
 */
import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

export class BlockedUrlError extends Error {
  constructor(message, code = "EBLOCKED") {
    super(message);
    this.name = "BlockedUrlError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/*  Address classification                                             */
/* ------------------------------------------------------------------ */
function isPrivateV4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0) return true;                              // 0.0.0.0/8 "this network"
  if (a === 10) return true;                             // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 carrier-grade NAT
  if (a === 127) return true;                            // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true;   // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;    // TEST-NET-3
  if (a >= 224) return true;                             // multicast, reserved, broadcast
  return false;
}

// Expand a (valid) IPv6 string into eight 16-bit groups.
function expandV6(addr) {
  let s = addr;
  let tail = [];
  const m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) {
    const p = m[1].split(".").map(Number);
    if (p.some((x) => x > 255)) return null;
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = s.slice(0, -m[1].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const toNums = (arr) => arr.map((x) => (/^[0-9a-f]{1,4}$/i.test(x) ? parseInt(x, 16) : NaN));
  let groups;
  if (parts.length === 1) {
    groups = toNums(parts[0] ? parts[0].split(":") : []).concat(tail);
    if (groups.length !== 8) return null;
  } else {
    const head = toNums(parts[0] ? parts[0].split(":") : []);
    const rest = toNums(parts[1] ? parts[1].split(":") : []).concat(tail);
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = head.concat(new Array(fill).fill(0), rest);
  }
  return groups.some((g) => Number.isNaN(g)) ? null : groups;
}

const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateV6(ip) {
  const g = expandV6(ip);
  if (!g) return true; // unparsable → treat as unsafe
  if (g.every((x) => x === 0)) return true;                                      // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;            // ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {  // ::ffff:a.b.c.d / ::a.b.c.d
    return isPrivateV4(v4FromGroups(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) { // 64:ff9b::/96 NAT64
    return isPrivateV4(v4FromGroups(g[6], g[7]));
  }
  if (g[0] === 0x2002) return isPrivateV4(v4FromGroups(g[1], g[2]));           // 2002::/16 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;                                   // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                                   // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                                   // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                                   // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                           // 2001:db8::/32 documentation
  return false;
}

/** True if `ip` is an IP literal in a private/loopback/reserved range. Non-IPs → false. */
export function isPrivateAddress(ip) {
  const v = String(ip || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(v)) return isPrivateV4(v);
  if (net.isIPv6(v)) return isPrivateV6(v);
  return false;
}

const BLOCKED_NAME = /(^|\.)(localhost|localdomain|internal|local|home\.arpa|intranet|lan)$/i;

/**
 * Validate a URL for a server-side request. Resolves the hostname (all A/AAAA
 * records) and throws BlockedUrlError if it is local/private. Returns
 * { url, addresses }.
 */
export async function assertPublicUrl(input, { lookup = dns.promises.lookup } = {}) {
  let url;
  try { url = input instanceof URL ? input : new URL(String(input)); }
  catch { throw new BlockedUrlError("Provide a valid http(s) URL.", "EINVALID"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("Only http/https URLs are allowed.", "EPROTOCOL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new BlockedUrlError("The URL has no host.", "EINVALID");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedUrlError(`Blocked private address ${host}.`);
    return { url, addresses: [host] };
  }
  if (BLOCKED_NAME.test(host)) throw new BlockedUrlError(`Blocked local host name ${host}.`);
  let records;
  try { records = await lookup(host, { all: true, verbatim: true }); }
  catch (err) { throw new BlockedUrlError(`Could not resolve ${host} (${err?.code || err?.message || "DNS error"}).`, "EDNS"); }
  const addresses = (Array.isArray(records) ? records : [records])
    .map((r) => (typeof r === "string" ? r : r?.address))
    .filter(Boolean);
  if (!addresses.length) throw new BlockedUrlError(`Could not resolve ${host}.`, "EDNS");
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (bad) throw new BlockedUrlError(`${host} resolves to a private address (${bad}).`);
  return { url, addresses };
}

/**
 * dns.lookup-compatible function for http(s).request({ lookup }). The address is
 * checked at connect time, closing the DNS-rebinding gap.
 */
export function createSafeLookup(baseLookup = dns.lookup) {
  return function safeLookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    const opts = typeof options === "number" ? { family: options } : { ...(options || {}) };
    baseLookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (Array.isArray(addresses) ? addresses : []).filter((a) => a && a.address);
      if (!list.length) return callback(new BlockedUrlError(`Could not resolve ${hostname}.`, "EDNS"));
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad) return callback(new BlockedUrlError(`${hostname} resolves to a private address (${bad.address}).`));
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family || (net.isIPv6(list[0].address) ? 6 : 4));
    });
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function requestOnce(url, { headers, lookup, maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = mod.request(url, {
      method: "GET",
      headers: { "Accept-Encoding": "gzip, deflate, br", ...headers },
      lookup,
    }, (res) => {
      const status = res.statusCode || 0;
      if (REDIRECTS.has(status)) {
        res.resume();
        return done(resolve, { status, headers: res.headers, body: Buffer.alloc(0), truncated: false });
      }
      let stream = res;
      const enc = String(res.headers["content-encoding"] || "").toLowerCase().trim();
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      let truncated = false;
      const finish = () => done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated });
      stream.on("data", (c) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) {
          chunks.push(c.subarray(0, c.length - (size - maxBytes)));
          truncated = true;
          finish();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      stream.on("end", finish);
      stream.on("error", (e) => (truncated ? finish() : done(reject, e)));
    });
    const timer = setTimeout(() => {
      const e = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      e.code = "ETIMEDOUT";
      req.destroy(e);
      done(reject, e);
    }, timeoutMs);
    req.on("error", (e) => done(reject, e));
    req.end();
  });
}

/**
 * Fetch a PUBLIC http(s) URL. Every hop (including redirects) is validated with
 * assertPublicUrl, and the socket connects through the safe lookup.
 * Resolves { status, headers, body: Buffer, truncated, url }.
 */
export async function fetchPublic(input, opts = {}) {
  const {
    headers = {},
    maxBytes = 2 * 1024 * 1024,
    timeoutMs = 20_000,
    maxRedirects = 5,
    lookup = dns.lookup,
    resolve = dns.promises.lookup,
  } = opts;
  const safeLookup = createSafeLookup(lookup);
  const deadline = Date.now() + timeoutMs;
  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url } = await assertPublicUrl(current, { lookup: resolve });
    const remaining = deadline - Date.now();
    if (remaining <= 0) { const e = new Error("timed out"); e.code = "ETIMEDOUT"; throw e; }
    const res = await requestOnce(url, { headers, lookup: safeLookup, maxBytes, timeoutMs: remaining });
    if (REDIRECTS.has(res.status) && res.headers.location) {
      if (hop === maxRedirects) throw new BlockedUrlError("Too many redirects.", "EREDIRECTS");
      try { current = new URL(res.headers.location, url); }
      catch { throw new BlockedUrlError("Invalid redirect location.", "EINVALID"); }
      continue;
    }
    return { ...res, url: url.href };
  }
  throw new BlockedUrlError("Too many redirects.", "EREDIRECTS");
}
