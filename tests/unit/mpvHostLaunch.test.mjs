import {describe, expect, it} from 'vitest';
import {CommandLineEnv, focusOutcome, runPowerShell, wmiLaunchLines, wmiLaunchResult} from '../../native-host/faststream-mpv-host.mjs';

// What the WMI launch script reports about the mpv it started, and what the host makes
// of it.
//
// An mpv that quits at once (an option it refuses, a broken install) used to be reported
// as started. The script took it for a failed launch only when its first look found no
// process ("FOCUS=gone"), but that look comes right after Win32_Process.Create returns,
// when mpv is still starting: it saw mpv, saw it go, and said "FOCUS=nowindow", which
// counts as a launch that worked. Now a process that was seen and went before it had a
// window says "FOCUS=quit", a failure like "gone" (2026-10-04).

const QuitError = 'mpv quit right after it started: check the mpv path, and mpv.conf for an option mpv refuses';

describe('wmiLaunchResult', () => {
  it('reports an mpv that quit before it had a window, seen or not, as not started', () => {
    expect(wmiLaunchResult('RC=0 PID=42\r\nFOCUS=quit')).toEqual({ok: false, error: QuitError});
    expect(wmiLaunchResult('RC=0 PID=42\r\nFOCUS=gone')).toEqual({ok: false, error: QuitError});
  });

  it('reports one that is still starting, or was raised, as started, with how raising it went', () => {
    expect(wmiLaunchResult('RC=0 PID=42\r\nFOCUS=nowindow')).toStrictEqual(
        {ok: true, pid: 42, focus: 'nowindow', tries: undefined});
    expect(wmiLaunchResult('RC=0 PID=42\r\nFOCUS=True FGOK=False TRIES=3')).toStrictEqual(
        {ok: true, pid: 42, focus: 'True', foreground: 'False', tries: 3});
  });

  it('passes WMI\'s own failures on', () => {
    expect(wmiLaunchResult('RC=9 PID=0')).toEqual({ok: false, error: 'WMI Create returned 9'});
    expect(wmiLaunchResult('')).toEqual({ok: false, error: 'unexpected WMI output: '});
  });
});

describe('focusOutcome', () => {
  it('reads the FOCUS= and FGOK= values a focus script printed', () => {
    expect(focusOutcome('FOCUS=True FGOK=True')).toStrictEqual({focus: 'True', foreground: 'True'});
    expect(focusOutcome('FOCUS=nowindow')).toStrictEqual({focus: 'nowindow'});
    expect(focusOutcome('')).toStrictEqual({});
  });
});

// The real script, run by the real PowerShell, with Invoke-CimMethod and Get-Process
// stubbed (a function wins over the cmdlet): nothing is started, and no window is looked
// for on a real process. The stubbed process never has a window, so no window is raised.
describe.runIf(process.platform === 'win32')('the WMI launch script, about an mpv that quits at once', () => {
  const created = 'function Invoke-CimMethod { param($ClassName, $MethodName, $Arguments) ' +
    '[pscustomobject]@{ReturnValue = 0; ProcessId = 424242} }';

  /**
   * Runs the launch script with the stubs and reads its output as the host does.
   * @param {Array<string>} getProcess - A Get-Process stand-in.
   * @return {Promise<{out: string, result: Object}>}
   */
  const launch = async (getProcess) => {
    const out = await runPowerShell([created, ...getProcess, ...wmiLaunchLines()], 60000, {[CommandLineEnv]: '"x"'});
    return {out, result: wmiLaunchResult(out)};
  };

  it('says "quit" for an mpv seen once and then gone, and the host reports it not started', async () => {
    const {out, result} = await launch([
      '$global:looks = 0',
      'function Get-Process { param($Id, $ErrorAction) $global:looks++; ' +
        'if ($global:looks -le 1) { [pscustomobject]@{MainWindowHandle = [IntPtr]::Zero} } else { $null } }',
    ]);
    expect(out).toContain('FOCUS=quit');
    expect(result).toEqual({ok: false, error: QuitError});
  }, 60000);

  it('says "gone" for one never seen at all', async () => {
    const {out, result} = await launch(['function Get-Process { param($Id, $ErrorAction) $null }']);
    expect(out).toContain('FOCUS=gone');
    expect(result).toEqual({ok: false, error: QuitError});
  }, 60000);
});
