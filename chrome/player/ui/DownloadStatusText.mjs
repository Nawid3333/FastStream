// @ts-check

// The download line under the player: "3C ↓9.6 Mbit/s 50%". Its own module, so a unit test can
// read it without the player's UI (InterfaceController touches the DOM when it is imported).

/**
 * The download line's text while a video downloads.
 * @param {number} connections - Downloads running at this moment, each on a connection of its
 *   own (DownloadManager.runningCount): what the speed comes from.
 * @param {number} bytesPerSecond - The download speed.
 * @param {number} percentDone - How much of the video is downloaded, in percent.
 * @return {string}
 */
export function downloadStatusText(connections, bytesPerSecond, percentDone) {
  // In Mbit/s, the unit of the speed setting and of speed tests: MB/s here beside a limit in
  // Mbit/s read 8 times too low.
  const mbits = Math.round(bytesPerSecond * 8 / 1000 / 1000 * 10) / 10;
  return `${connections}C ↓${mbits} Mbit/s ${percentDone}%`;
}
