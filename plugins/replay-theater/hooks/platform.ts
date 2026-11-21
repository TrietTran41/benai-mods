import type { EngineInterface } from 'claude-code'

// ---- One build for macOS, Windows and Linux (WSL too) ----
// Every mod in the pack carries this same file. It answers four questions the first
// build answered with Mac-only guesses:
//   where is the Claude config folder (CLAUDE_CONFIG_DIR, else <home>/.claude),
//   how to make a folder, delete a file, open a file or link, and copy text,
// on whichever system the chat runs on.

type System = 'mac' | 'windows' | 'linux'
let system: System | undefined
export async function systemOf($: EngineInterface): Promise<System> {
  if (system) return system
  if ((await $.env.get('OS').catch(() => undefined)) === 'Windows_NT') return (system = 'windows')
  const r = await $.process.run(['uname', '-s'], { timeoutMs: 5_000 }).catch(() => undefined)
  return (system = r?.stdout.trim() === 'Linux' ? 'linux' : 'mac')
}
export async function isWin($: EngineInterface) {
  return (await systemOf($)) === 'windows'
}

// ---- Config folder ----
// Read from the environment, not from the plugin's own path: a pack added from a local
// folder (say ~/Downloads/benai-mods) does not sit under ~/.claude, and on Windows the
// path has backslashes. The plugin path is only the last resort.
let home = ''
let claudeDir = ''
let finding: Promise<{ home: string; claudeDir: string }> | undefined
function fromRoot($: EngineInterface) {
  return $.plugin.root.replace(/\\/g, '/').split('/.claude/')[0] ?? ''
}
function fwd(p: string, windows: boolean) {
  let s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (windows) s = s.replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d.toUpperCase()}:/`).replace(/^([a-z]):\//, (_, d: string) => `${d.toUpperCase()}:/`)
  return s
}
async function find($: EngineInterface) {
  const windows = await isWin($)
  const clean = (v: string | undefined) => (v ?? '').trim()
  const profile = clean(await $.env.get('USERPROFILE').catch(() => undefined))
  const unix = clean(await $.env.get('HOME').catch(() => undefined))
  const pick = windows ? profile || unix : unix || profile
  home = pick ? fwd(pick, windows) : fromRoot($)
  const set = clean(await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))
  const full = set === '~' ? home : set.startsWith('~/') || set.startsWith('~\\') ? `${home}${set.slice(1)}` : set
  claudeDir = full ? fwd(full, windows) : `${home}/.claude`
  return { home, claudeDir }
}
// The home folder and the Claude config folder, found once per load.
export function findPaths($: EngineInterface): Promise<{ home: string; claudeDir: string }> {
  finding ??= find($).catch(err => {
    finding = undefined
    throw err
  })
  return finding
}
// For code that cannot wait: the found folder, or the old guess until it is found.
export function homeOf($: EngineInterface) {
  return home || fromRoot($)
}
export function claudeDirOf($: EngineInterface) {
  return claudeDir || `${fromRoot($)}/.claude`
}
export async function claudeDirNow($: EngineInterface) {
  return (await findPaths($)).claudeDir
}

// ---- Windows helpers ----
// Windows has no /bin/sh, mkdir -p, rm, open or pbcopy. The same jobs run as PowerShell:
// values go in through env (Windows argv quoting breaks on quotes), text as base64 on stdin.
export function b64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let raw = ''
  for (let i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i] ?? 0)
  return btoa(raw)
}
export function ps($: EngineInterface, script: string, env: Record<string, string> = {}, init: { stdin?: string; timeoutMs?: number } = {}) {
  const full = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`
  let utf16 = ''
  for (let i = 0; i < full.length; i += 1) utf16 += String.fromCharCode(full.charCodeAt(i) & 255, full.charCodeAt(i) >> 8)
  return $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', btoa(utf16)], { env, ...init })
}

// ---- Files and folders ----
// $.fs.write makes missing folders itself; mkdir -p only runs where it exists.
export async function mkdirs($: EngineInterface, dir: string) {
  if (!(await isWin($))) await $.process.run(['mkdir', '-p', dir])
}
export async function removeFile($: EngineInterface, path: string) {
  if (await isWin($)) await ps($, 'Remove-Item -LiteralPath $env:MODS_PATH -Force -ErrorAction SilentlyContinue', { MODS_PATH: path })
  else await $.process.run(['rm', '-f', path])
}

// ---- Open a file or a link with its default app ----
// Mac: open. Windows: Start-Process (Explorer wants backslashes in a file path).
// Linux: xdg-open, then wslview (WSL), then gio open. Resolves { exitCode, stderr }.
const LINUX_OPEN = `for c in xdg-open wslview "gio open"; do set -- $c; command -v "$1" >/dev/null 2>&1 || continue; "$@" "$MODS_TARGET" >/dev/null 2>&1 && exit 0; done; echo "no xdg-open, wslview or gio found" >&2; exit 3`
export async function openWith($: EngineInterface, target: string): Promise<{ exitCode: number; stderr: string }> {
  const sys = await systemOf($)
  if (sys === 'mac') return $.process.run(['open', target], { timeoutMs: 10_000 })
  if (sys === 'linux') return $.process.run(['sh', '-c', LINUX_OPEN], { env: { MODS_TARGET: target }, timeoutMs: 10_000 })
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
  return ps($, 'Start-Process -FilePath $env:MODS_PATH', { MODS_PATH: isUrl ? target : target.replace(/\//g, '\\') }, { timeoutMs: 10_000 })
}

// ---- Copy text to the clipboard ----
// Linux tools fork and keep running, so each one writes to /dev/null, not to our pipe.
const LINUX_COPY = `t=$(cat); for c in wl-copy "xclip -selection clipboard" "xsel --clipboard --input" clip.exe; do set -- $c; command -v "$1" >/dev/null 2>&1 || continue; printf '%s' "$t" | "$@" >/dev/null 2>&1 && exit 0; done; echo "no wl-copy, xclip, xsel or clip.exe found" >&2; exit 3`
export async function copyText($: EngineInterface, text: string): Promise<{ exitCode: number; stderr: string }> {
  const sys = await systemOf($)
  if (sys === 'mac') return $.process.run(['pbcopy'], { stdin: text })
  if (sys === 'linux') return $.process.run(['sh', '-c', LINUX_COPY], { stdin: text, timeoutMs: 10_000 })
  return ps($, 'Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())))', {}, { stdin: b64(text) })
}
// The paste keys people know on this system.
export async function pasteKeys($: EngineInterface) {
  return (await systemOf($)) === 'mac' ? '⌘V' : 'Ctrl+V'
}
