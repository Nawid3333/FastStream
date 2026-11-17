// @ts-check

// No DNS lookup (needs the dns permission): a public name resolving to a local address is not caught.

/**
 * @param {string} url
 * @return {boolean}
 */
export function isLocalAddress(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // The parser keeps a trailing dot (localhost.).
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host.startsWith('[')) {
    const ip = host.slice(1, -1);
    // The parser drops leading zeros: a group in these ranges has all four digits.
    if (ip === '::1' || ip === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)) return true;
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return isLocalIPv4([high >> 8, high & 255, low >> 8, low & 255]);
    }
    return false;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) return isLocalIPv4(ipv4.slice(1).map(Number));
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  return !host.includes('.');
}

/**
 * @param {number[]} parts
 * @return {boolean}
 */
function isLocalIPv4([a, b]) {
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // 100.64/10: carrier-grade NAT and Tailscale.
    (a === 100 && b >= 64 && b <= 127);
}
