/**
 * The player page's window (chrome/player/main.mjs): it holds the client from setup() until
 * beforeunload deletes it, marked optionsApplied for the tests once loadOptions() gave it the
 * saved options. Optional: the client is missing before and after, and every other page's
 * window has none. Ambient, like messages.d.ts: no import or export.
 */

interface Window {
  fastStream?: import('../chrome/player/FastStreamClient.mjs').FastStreamClient & {optionsApplied?: boolean};
}
