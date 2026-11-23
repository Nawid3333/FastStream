import {spawnSync} from 'node:child_process';

/**
 * Vitest's global setup on Windows: starts Windows PowerShell once, with an Add-Type (the C# compiler the mpv
 * helper's focus script uses), before any test runs. Their first start on a fresh CI runner can take tens of seconds,
 * which no single test's time limit should pay for.
 */
export default function warmPowerShell() {
  if (process.platform !== 'win32') return;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition \'public static class FastStreamWarmUp { }\''], {windowsHide: true, timeout: 180000});
}
