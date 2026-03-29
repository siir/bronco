import { isIPv4, isIPv6 } from 'node:net';
import dns from 'node:dns';

/**
 * SSRF mitigation utilities.
 *
 * Blocks loopback, link-local, private (RFC-1918), cloud metadata,
 * IPv6 ULA (fc00::/7), IPv6 link-local (fe80::/10), and IPv4-mapped
 * IPv6 (::ffff:0:0/96) addresses.
 *
 * Also resolves hostnames to IPs and validates the resolved addresses
 * to defend against DNS rebinding and CNAME-chain attacks.
 */

/**
 * Check whether an IPv4 address string falls into a blocked range.
 * Expects a bare address (no brackets, no port).
 */
export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;

  const [a, b] = parts;

  // Loopback: 127.0.0.0/8
  if (a === 127) return true;
  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // Link-local / APIPA: 169.254.0.0/16 (includes AWS/Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // RFC-1918 private ranges
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Azure wireserver / DHCP: 168.63.129.16
  if (a === 168 && b === 63 && parts[2] === 129 && parts[3] === 16) return true;

  return false;
}

/**
 * Check whether an IPv6 address string falls into a blocked range.
 * Expects a bare address (no brackets, no port, no zone id).
 */
export function isBlockedIPv6(ip: string): boolean {
  // Normalize: lowercase, strip zone ids (%eth0 etc.)
  const clean = ip.toLowerCase().replace(/%.*$/, '');

  // Loopback ::1
  if (clean === '::1') return true;

  // Expand to full 8-group form for prefix checks
  const expanded = expandIPv6(clean);
  if (!expanded) return false;

  const groups = expanded.split(':').map((g) => parseInt(g, 16));

  // IPv4-mapped IPv6: ::ffff:0:0/96 → first 6 groups are 0,0,0,0,0,ffff
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  ) {
    // Extract the mapped IPv4 from groups[6] and groups[7]
    const ipv4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
    return isBlockedIPv4(ipv4);
  }

  // ULA: fc00::/7 → first byte is fc or fd
  const firstByte = groups[0] >> 8;
  if (firstByte === 0xfc || firstByte === 0xfd) return true;

  // Link-local: fe80::/10 → first 10 bits are 1111 1110 10
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // AWS EC2 metadata: fd00:ec2::254 (single address, not entire /32)
  if (
    groups[0] === 0xfd00 && groups[1] === 0x0ec2 &&
    groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0 &&
    groups[6] === 0 && groups[7] === 0x0254
  ) return true;

  // Unspecified address ::
  if (groups.every((g) => g === 0)) return true;

  return false;
}

/**
 * Expand a short-form IPv6 address to full 8-group hex notation.
 * Handles IPv4-embedded suffixes (e.g. `::ffff:127.0.0.1`).
 * Returns null for invalid input.
 */
function expandIPv6(ip: string): string | null {
  // Handle IPv4-embedded suffix (e.g. ::ffff:127.0.0.1)
  const lastColon = ip.lastIndexOf(':');
  if (lastColon !== -1) {
    const lastPart = ip.slice(lastColon + 1);
    if (lastPart.includes('.')) {
      const ipv4Parts = lastPart.split('.').map(Number);
      if (ipv4Parts.length !== 4 || ipv4Parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
      const hi = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16);
      const lo = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16);
      ip = ip.slice(0, lastColon + 1) + hi + ':' + lo;
    }
  }

  // Handle :: expansion
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  let groups: string[];

  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = ip.split(':');
  }

  if (groups.length !== 8) return null;

  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/**
 * Strip the zone ID suffix from an IPv6 address (e.g. `fe80::1%eth0` → `fe80::1`).
 * Zone IDs are encoded as `%25` in URLs; WHATWG URL parsing may leave either form.
 */
function stripIPv6ZoneId(ip: string): string {
  // Strip URL-encoded zone ID (%25...) first, then raw zone ID (%...)
  const idx = ip.indexOf('%');
  return idx === -1 ? ip : ip.slice(0, idx);
}

/**
 * Check if a raw hostname (as returned by WHATWG URL.hostname) points
 * to a blocked IP. Handles bracketed IPv6 from URL parsing.
 */
export function isBlockedHostname(hostname: string): boolean {
  // WHATWG URL wraps IPv6 in brackets: [::1]
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Known dangerous hostnames
  if (bare === 'localhost' || bare === '0.0.0.0') return true;

  if (isIPv4(bare)) return isBlockedIPv4(bare);

  // Strip zone ID before isIPv6() check — zone-scoped literals (e.g.
  // fe80::1%25eth0) fail isIPv6() but are still valid IPv6 addresses.
  const bareNoZone = stripIPv6ZoneId(bare);
  if (isIPv6(bareNoZone)) return isBlockedIPv6(bareNoZone);

  // Not an IP literal — can't determine without DNS resolution
  return false;
}

/**
 * Async DNS resolution check for HTTP/OLLAMA endpoints used at create/update time.
 * Resolves the hostname to IP addresses and validates them against blocked ranges.
 * This helper alone does NOT prevent DNS rebinding; callers MUST re-resolve and
 * validate the hostname/IP immediately before each outbound request (or pin/verify
 * the resolved IP) to properly mitigate DNS rebinding / CNAME chain attacks.
 *
 * Returns an object with `blocked` (boolean) and `reason` (string if blocked).
 *
 * For raw IP literals (no DNS needed), validates directly.
 * Uses hardcoded public DNS resolvers (8.8.8.8, 1.1.1.1) with a 5-second timeout.
 */
export async function resolveAndValidateHostname(
  hostname: string,
): Promise<{ blocked: boolean; reason?: string }> {
  // Strip WHATWG brackets
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Known dangerous hostnames
  if (bare === 'localhost' || bare === '0.0.0.0') {
    return { blocked: true, reason: `Hostname "${bare}" resolves to a blocked address` };
  }

  // If it's already an IP literal, just check it directly
  if (isIPv4(bare)) {
    if (isBlockedIPv4(bare)) {
      return { blocked: true, reason: `IP ${bare} is in a blocked range` };
    }
    return { blocked: false };
  }
  // Strip zone ID before isIPv6() check — zone-scoped literals bypass isIPv6()
  const bareNoZone = stripIPv6ZoneId(bare);
  if (isIPv6(bareNoZone)) {
    if (isBlockedIPv6(bareNoZone)) {
      return { blocked: true, reason: `IP ${bare} is in a blocked range` };
    }
    return { blocked: false };
  }

  // Resolve DNS and check all returned addresses.
  // Uses public DNS to avoid local resolver tricks (TOCTOU caveat noted in JSDoc).
  const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers(['8.8.8.8', '1.1.1.1']);

  const addresses: string[] = [];

  try {
    const ipv4Addrs = await resolver.resolve4(bare);
    addresses.push(...ipv4Addrs);
  } catch {
    // ENOTFOUND or ENODATA for A records — that's okay, try AAAA
  }

  try {
    const ipv6Addrs = await resolver.resolve6(bare);
    addresses.push(...ipv6Addrs);
  } catch {
    // ENOTFOUND or ENODATA for AAAA records
  }

  if (addresses.length === 0) {
    return { blocked: true, reason: `Hostname "${bare}" could not be resolved` };
  }

  for (const addr of addresses) {
    if (isIPv4(addr) && isBlockedIPv4(addr)) {
      return { blocked: true, reason: `Hostname "${bare}" resolves to blocked IP ${addr}` };
    }
    if (isIPv6(addr) && isBlockedIPv6(addr)) {
      return { blocked: true, reason: `Hostname "${bare}" resolves to blocked IP ${addr}` };
    }
  }

  return { blocked: false };
}
