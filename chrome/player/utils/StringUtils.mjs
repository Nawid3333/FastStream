// @ts-check
export class StringUtils {
  /**
   * @param {string} s
   * @param {string} t
   * @return {number} The Levenshtein distance.
   */
  static levenshteinDistance(s, t) {
    if (s === t) {
      return 0;
    }
    const n = s.length; const m = t.length;
    if (n === 0 || m === 0) {
      return n + m;
    }
    let x = 0; let y; let a; let b; let c; let d; let g; let h;
    const p = new Uint16Array(n);
    const u = new Uint32Array(n);
    for (y = 0; y < n;) {
      u[y] = s.charCodeAt(y);
      p[y] = ++y;
    }

    for (; (x + 3) < m; x += 4) {
      const e1 = t.charCodeAt(x);
      const e2 = t.charCodeAt(x + 1);
      const e3 = t.charCodeAt(x + 2);
      const e4 = t.charCodeAt(x + 3);
      c = x;
      b = x + 1;
      d = x + 2;
      g = x + 3;
      h = x + 4;
      for (y = 0; y < n; y++) {
        a = p[y];
        if (a < c || b < c) {
          c = (a > b ? b + 1 : a + 1);
        } else {
          if (e1 !== u[y]) {
            c++;
          }
        }

        if (c < b || d < b) {
          b = (c > d ? d + 1 : c + 1);
        } else {
          if (e2 !== u[y]) {
            b++;
          }
        }

        if (b < d || g < d) {
          d = (b > g ? g + 1 : b + 1);
        } else {
          if (e3 !== u[y]) {
            d++;
          }
        }

        if (d < g || h < g) {
          g = (d > h ? h + 1 : d + 1);
        } else {
          if (e4 !== u[y]) {
            g++;
          }
        }
        p[y] = h = g;
        g = d;
        d = b;
        b = c;
        c = a;
      }
    }

    for (; x < m;) {
      const e = t.charCodeAt(x);
      c = x;
      d = ++x;
      for (y = 0; y < n; y++) {
        a = p[y];
        if (a < c || d < c) {
          d = (a > d ? d + 1 : a + 1);
        } else {
          if (e !== u[y]) {
            d = c + 1;
          } else {
            d = c;
          }
        }
        p[y] = d;
        c = a;
      }
      h = d;
    }

    return /** @type {number} */ (h);
  }

  /**
   * HH:MM:SS or MM:SS; --:-- for a non-finite time (a live stream's length).
   * @param {number} time - Seconds.
   * @return {string}
   */
  static formatTime(time) {
    if (!Number.isFinite(time)) {
      return '--:--';
    }
    const hours = Math.floor(time / 3600);
    time = time - hours * 3600;
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time - minutes * 60);

    /**
     * @param {number} string
     * @param {string} pad
     * @param {number} length
     */
    function strPadLeft(string, pad, length) {
      return (new Array(length + 1).join(pad) + string).slice(-length);
    }

    return (hours ? (hours + ':') : '') + strPadLeft(minutes, '0', 2) + ':' + strPadLeft(seconds, '0', 2);
  }

  /**
   * @param {number} duration - Seconds.
   * @return {string}
   */
  static formatDuration(duration) {
    const hours = Math.floor(duration / 3600);
    duration = duration - hours * 3600;
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration - minutes * 60);
    return (hours ? (hours + 'h ') : '') + (minutes ? (minutes + 'm ') : '') + seconds + 's';
  }

  /**
   * In the settings' units (1000-based MB and GB), in the browser's language.
   * @param {number} bytes
   * @return {string} E.g. "6.8 GB", "750 MB".
   */
  static formatSize(bytes) {
    const gb = bytes >= 1e9;
    return new Intl.NumberFormat(undefined, {
      style: 'unit', unit: gb ? 'gigabyte' : 'megabyte', unitDisplay: 'short', maximumFractionDigits: gb ? 1 : 0,
    }).format(gb ? bytes / 1e9 : bytes / 1e6);
  }

  /**
   * @param {string} range - An HTTP Range header.
   * @return {[number, number] | [undefined, undefined]} Its first and last byte (NaN for an
   *   open end); both undefined when it does not parse.
   */
  static parseHTTPRange(range) {
    const match = range.match(/(\d+)-(\d+)?/);
    if (!match) return [undefined, undefined];
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    return [start, end];
  }
}
