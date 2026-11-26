"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAppFocused = isAppFocused;
const node_child_process_1 = require("node:child_process");
/**
 * Checks whether the PI-Desktop window/process is currently in the foreground (focused).
 * Returns true if the window is currently focused, false if blurred/in background.
 * In case of permission errors or platform unsupported, returns false (fail-safe).
 */
async function isAppFocused() {
    const platform = process.platform;
    return new Promise((resolve) => {
        try {
            if (platform === 'darwin') {
                // macOS AppleScript check (runs in < 40ms)
                const script = 'tell application "System Events" to get frontmost of process "PI-Desktop"';
                (0, node_child_process_1.execFile)('osascript', ['-e', script], { timeout: 800 }, (err, stdout) => {
                    if (err || !stdout) {
                        resolve(false);
                        return;
                    }
                    resolve(stdout.trim().toLowerCase() === 'true');
                });
            }
            else if (platform === 'win32') {
                // Windows: match active foreground window process against PI-Desktop
                const script = `
          $fg = [System.IntPtr]::Zero
          Add-Type -TypeDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);' -Name Win32Focus -Namespace NativeFocus -ErrorAction SilentlyContinue
          $fg = [NativeFocus.Win32Focus]::GetForegroundWindow()
          $pidVal = 0
          [NativeFocus.Win32Focus]::GetWindowThreadProcessId($fg, [ref]$pidVal) | Out-Null
          $fgProc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
          if ($fgProc -and $fgProc.ProcessName -like "*PI-Desktop*") { Write-Output "true" } else { Write-Output "false" }
        `;
                (0, node_child_process_1.execFile)('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 1500 }, (err, stdout) => {
                    if (err || !stdout) {
                        resolve(false);
                        return;
                    }
                    resolve(stdout.trim().toLowerCase() === 'true');
                });
            }
            else {
                // Linux / other platforms: default to false
                resolve(false);
            }
        }
        catch {
            resolve(false);
        }
    });
}
