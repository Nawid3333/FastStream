// @ts-check

// Whether an http(s) address is on the local network or this computer, by its host alone:
// IP addresses of the private, loopback, link-local and shared (100.64/10) ranges, localhost,
// .local names and one-word names (a name on the internet has a dot). The URL parser writes
// IPv4 addresses in their dotted form first (0x7f.1 is 127.0.0.1), and IPv6 ones in brackets.
// No DNS lookup (that needs the dns permission): a public name that resolves to a local
// address (192.168.1.1.nip.io) is not told apart.

/**
 * @param {string} url
 * @return {boolean} False for an address that cannot be read.
 */
export function isLocalAddress(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // A name may end in a dot (localhost., nas.local.), which the parser keeps.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host.startsWith('[')) {
    const ip = host.slice(1, -1);
    // Loopback, unspecified, unique local (fc00::/7), link-local (fe80::/10), and IPv4 written
    // as IPv6 (::ffff:a.b.c.d, which the parser writes as hex). The parser drops leading
    // zeros: a group in those ranges has all four digits.
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
 * @param {number[]} parts - The four numbers.
 * @return {boolean}
 */
function isLocalIPv4([a, b]) {
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Shared address space (carrier-grade NAT, and Tailscale's own network): on no public site.
    (a === 100 && b >= 64 && b <= 127);
}
