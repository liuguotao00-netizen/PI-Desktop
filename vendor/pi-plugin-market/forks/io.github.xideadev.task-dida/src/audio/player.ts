import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SoundAlertSettings } from '../config/settings';

export type AlertType = 'complete' | 'error' | 'notify' | 'subagent';

const ALLOWED_AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.ogg',
  '.aiff',
  '.aif',
  '.flac',
  '.m4a'
]);

/**
 * Validates that a user-specified path is a real, accessible audio file
 * and not an executable or malicious script.
 * Auto-strips outer quotes (e.g., from Windows "Copy as path").
 */
export function cleanAndValidateAudioPath(filePath?: string): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  // Strip outer quotes if copied from file explorer
  let cleaned = filePath.trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!cleaned || /[\r\n\0]/.test(cleaned)) return null;

  const normalized = path.normalize(cleaned);
  const ext = path.extname(normalized).toLowerCase();
  if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) return null;

  try {
    const stat = fs.statSync(normalized);
    if (stat.isFile()) {
      return path.resolve(normalized);
    }
  } catch {
    return null;
  }
  return null;
}

export function isSafeAudioFile(filePath?: string): boolean {
  return cleanAndValidateAudioPath(filePath) !== null;
}

export class NativeAudioPlayer {
  private baseAssetsPath: string;

  constructor(pluginRootDir: string) {
    this.baseAssetsPath = path.join(pluginRootDir, 'assets', 'sounds');
  }

  /**
   * Resolve sound file path strictly prioritizing plugin bundled assets.
   * If custom audio fails or is missing, automatically falls back to bundled asset.
   */
  public resolveSoundPath(type: AlertType, settings: SoundAlertSettings): string {
    const defaultFileMap: Record<AlertType, string> = {
      complete: path.join(this.baseAssetsPath, 'complete.wav'),
      error: path.join(this.baseAssetsPath, 'error.wav'),
      notify: path.join(this.baseAssetsPath, 'notify.wav'),
      subagent: path.join(this.baseAssetsPath, 'subagent.wav')
    };

    if (settings.soundTheme === 'custom') {
      if (type === 'complete') {
        const p = cleanAndValidateAudioPath(settings.customSoundSuccess);
        if (p) return p;
      }
      if (type === 'error') {
        const p = cleanAndValidateAudioPath(settings.customSoundError);
        if (p) return p;
      }
      if (type === 'notify') {
        const p = cleanAndValidateAudioPath(settings.customSoundNotify);
        if (p) return p;
      }
    }

    return defaultFileMap[type] || defaultFileMap.complete;
  }

  /**
   * Play sound using OS native zero-dependency audio commands.
   * On Windows: Uses System.Media.SoundPlayer (.wav) or WMP COM with strict unquoted path escaping.
   * On macOS: Uses afplay with volume option.
   * On Linux: Uses paplay with fallback to aplay.
   */
  public async play(type: AlertType, settings: SoundAlertSettings, customPathOverride?: string): Promise<boolean> {
    if (!settings.enabled && !customPathOverride) return false;

    let soundPath: string;
    if (customPathOverride) {
      const validated = cleanAndValidateAudioPath(customPathOverride);
      if (!validated) {
        console.warn(`[SoundAlert] Rejected unsafe custom audio path: ${customPathOverride}`);
        return false;
      }
      soundPath = validated;
    } else {
      soundPath = this.resolveSoundPath(type, settings);
    }

    if (!fs.existsSync(soundPath)) {
      console.warn(`[SoundAlert] Sound file not found: ${soundPath}`);
      return false;
    }

    const platform = process.platform;
    const volumeFraction = Math.max(0, Math.min(100, settings.volume)) / 100;
    const volumePercent = Math.round(volumeFraction * 100);

    return new Promise((resolve) => {
      let settled = false;
      const safeResolve = (val: boolean) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };

      try {
        if (platform === 'darwin') {
          // macOS afplay supports volume option -v (0.0 to 1.0)
          const proc = spawn('afplay', ['-v', volumeFraction.toFixed(2), soundPath], {
            stdio: 'ignore',
            detached: true
          });
          proc.unref();
          proc.on('error', (err) => {
            console.error('[SoundAlert] macOS afplay error:', err);
            safeResolve(false);
          });
          proc.on('spawn', () => safeResolve(true));
        } else if (platform === 'win32') {
          // Windows: Robust playback via System.Media.SoundPlayer for .wav, or WMP COM object
          const ext = path.extname(soundPath).toLowerCase();
          const escapedPath = soundPath.replace(/'/g, "''");

          // For .wav files, use [System.Media.SoundPlayer] directly which is 100% reliable on all Windows editions
          let script: string;
          if (ext === '.wav') {
            script = `
              try {
                $sp = New-Object System.Media.SoundPlayer('${escapedPath}');
                $sp.PlaySync();
                exit 0;
              } catch {
                exit 1;
              }
            `;
          } else {
            // For mp3 or other formats, try WMP COM object
            script = `
              try {
                $p = New-Object -ComObject wmplayer.ocx -ErrorAction Stop;
                $p.URL = '${escapedPath}';
                $p.settings.volume = ${volumePercent};
                $p.controls.play();
                Start-Sleep -Milliseconds 1200;
                exit 0;
              } catch {
                exit 1;
              }
            `;
          }

          const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            stdio: 'ignore',
            detached: true
          });
          proc.unref();
          proc.on('error', (err) => {
            console.error('[SoundAlert] Windows Audio Player spawn error:', err);
            safeResolve(false);
          });
          proc.on('close', (code) => {
            safeResolve(code === 0);
          });
          // Fallback timer: resolve true after 300ms if process doesn't fail immediately
          setTimeout(() => safeResolve(true), 300);
        } else {
          // Linux fallback (paplay -> aplay)
          const proc = spawn('paplay', [soundPath], {
            stdio: 'ignore',
            detached: true
          });
          proc.unref();
          proc.on('error', () => {
            const fallback = spawn('aplay', [soundPath], { stdio: 'ignore', detached: true });
            fallback.unref();
            fallback.on('error', () => safeResolve(false));
            fallback.on('spawn', () => safeResolve(true));
          });
          proc.on('spawn', () => safeResolve(true));
        }
      } catch (err) {
        console.error('[SoundAlert] Failed to spawn audio process:', err);
        safeResolve(false);
      }
    });
  }
}
