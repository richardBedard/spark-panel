import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActionCategory, ActionKey, ActionResult, SparkPanelState } from '../types'

const PANE = 'spark-panel'
const TOOL_DIR = 'D:/dev/tools/Spark'
const LOG_DIR = `${TOOL_DIR}/logs`
const SPARK_PS1 = `${TOOL_DIR}/spark.ps1`
const HOST_ALIAS = 'spark2'
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30']
const SEP = '---SPARK_SEP---'

const ALL_KEYS: ActionKey[] = ['check', 'plan', 'init', 'gpu', 'jobs', 'logs']

const initial: SparkPanelState = { busy: [], expanded: [], isCompact: false }
const state = atom({ plugin: 'spark-panel', key: 'state' } as const, initial, {
  shape: 'spark-panel-2',
})

function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function summarizeCheck(raw: string, cats: ActionCategory[]): string {
  const gpuLine = cats.find(c => c.category === 'GPU' && c.text.startsWith('gpu:'))
  const gpu = gpuLine ? gpuLine.text.replace(/^gpu:\s*/, '').split(',')[0].trim() : undefined
  const disk = cats.find(c => c.text.startsWith('disk free'))?.text.replace(/^disk free in home:\s*/, '')
  const env = deriveEnvStatus(raw)
  return oneLine([gpu, disk ? `disk ${disk}` : undefined, env].filter(Boolean).join(' · ') || 'no data')
}

function summarizeGpu(stdout: string): string {
  const mem = stdout.match(/(\d+)MiB\s*\/\s*(\d+)MiB/)
  const util = stdout.match(/(\d+)%\s+Default/)
  const parts = [mem ? `mem ${mem[1]}/${mem[2]} MiB` : undefined, util ? `util ${util[1]}%` : undefined]
  return parts.filter(Boolean).join(', ') || 'nvidia-smi ok'
}

function summarizeJobs(cats: ActionCategory[]): string {
  const count = (name: string, none: string) => {
    const text = cats.find(c => c.category === name)?.text ?? none
    return text === none ? 0 : text.split('\n').length
  }
  return `${count('tmux sessions', 'no tmux sessions')} tmux, ${count('training processes', 'no training processes')} training`
}

function summarizeLogs(cats: ActionCategory[]): string {
  const lines = (name: string) => {
    const text = cats.find(c => c.category.startsWith(name))?.text ?? ''
    return text.startsWith('no ') ? 0 : text.split('\n').length
  }
  return `MSI ${lines('MSI')} lines, Spark ${lines('Spark')} lines`
}

function formatTime(atMs: number): string {
  const d = new Date(atMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /

function stripTimestamp(line: string): string {
  return line.replace(TIMESTAMP, '')
}

// Lines from spark-setup.sh's `do_check`: a timestamped log() line per fact,
// plus a few un-timestamped lines from the inline python block (two-space
// indented package versions, or the torch.cuda.is_available()/import line).
function categorizeCheckOutput(raw: string): ActionCategory[] {
  const cats: ActionCategory[] = []
  const envLines: string[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = stripTimestamp(rawLine.trimEnd()).trim()
    if (trimmed === '') continue
    if (
      /^(torch|transformers|peft|trl|datasets|accelerate|bitsandbytes)\b/.test(trimmed) ||
      trimmed.startsWith('torch.cuda.is_available') ||
      trimmed.startsWith('torch import:')
    ) {
      envLines.push(trimmed)
    } else if (trimmed.startsWith('host:')) {
      cats.push({ category: 'System', text: trimmed })
    } else if (
      trimmed.startsWith('gpu:') ||
      trimmed.startsWith('gpu compute') ||
      trimmed.startsWith('WARN: nvidia-smi')
    ) {
      cats.push({ category: 'GPU', text: trimmed })
    } else if (trimmed.startsWith('python:') || trimmed.startsWith('tmux:')) {
      cats.push({ category: 'Tools', text: trimmed })
    } else if (trimmed.startsWith('disk free') || trimmed.startsWith('memory available')) {
      cats.push({ category: 'Resources', text: trimmed })
    } else if (trimmed.startsWith('project folder:')) {
      cats.push({ category: 'Project', text: trimmed })
    } else if (trimmed.startsWith('venv:')) {
      cats.push({ category: 'Environment', text: trimmed })
    } else if (
      trimmed.startsWith('created ') ||
      trimmed.startsWith('project folders ready') ||
      trimmed.startsWith('venv already exists')
    ) {
      cats.push({ category: 'Setup', text: trimmed })
    } else if (trimmed.startsWith('ERROR:')) {
      cats.push({ category: 'Error', text: trimmed })
    }
  }
  if (envLines.length > 0) {
    cats.push({ category: 'Environment', text: envLines.join('; ') })
  }
  return cats
}

// `do_plan`'s one timestamped intro line, then the raw requirements file
// lines (name==version) straight from grep | tee, no timestamp.
function categorizePlanOutput(raw: string): ActionCategory[] {
  const packages: string[] = []
  let intro = ''
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = stripTimestamp(rawLine.trimEnd()).trim()
    if (trimmed === '') continue
    if (/^[\w.-]+==[\w.]+$/.test(trimmed)) {
      packages.push(trimmed)
    } else if (trimmed.startsWith('Packages --install')) {
      intro = trimmed
    } else if (trimmed.startsWith('ERROR:')) {
      return [{ category: 'Error', text: trimmed }]
    }
  }
  const cats: ActionCategory[] = []
  if (intro) cats.push({ category: 'Plan', text: intro })
  if (packages.length > 0) cats.push({ category: 'Packages to install', text: packages.join(', ') })
  return cats
}

// The persistent environment summary for the run-once Init button, e.g.
// "done, venv ready, CUDA True" — read off whatever Check/Init output last
// carried a venv/torch report (Connect and Init both end by running do_check).
function deriveEnvStatus(raw: string): string | undefined {
  if (!/venv:|created empty venv|venv already exists/.test(raw)) return undefined
  const venvReady = !/venv:\s*not created yet/.test(raw)
  const cudaMatch = raw.match(/torch\.cuda\.is_available\(\):\s*(\S+)/)
  const torchNotInstalled = /\btorch not installed\b/.test(raw)
  const parts = ['done', venvReady ? 'venv ready' : 'venv not created']
  if (cudaMatch) parts.push(`CUDA ${cudaMatch[1]}`)
  else if (torchNotInstalled) parts.push('torch not installed')
  return parts.join(', ')
}

function parseJobsOutput(raw: string): ActionCategory[] {
  const idx = raw.indexOf(SEP)
  const tmuxPart = idx >= 0 ? raw.slice(0, idx) : raw
  const psPart = idx >= 0 ? raw.slice(idx + SEP.length) : ''
  const tmuxLines = tmuxPart.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const psLines = psPart.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return [
    { category: 'tmux sessions', text: tmuxLines.length ? tmuxLines.join('\n') : 'no tmux sessions' },
    { category: 'training processes', text: psLines.length ? psLines.join('\n') : 'no training processes' },
  ]
}

function parseLogsOutput(localTail: string, remoteRaw: string): ActionCategory[] {
  const localLines = localTail.split(/\r?\n/).filter(Boolean)
  const idx = remoteRaw.indexOf(SEP)
  const remoteLines =
    idx >= 0
      ? remoteRaw
          .slice(idx + SEP.length)
          .split(/\r?\n/)
          .filter(Boolean)
      : []
  const noRemote = remoteRaw.includes('NO_REMOTE_LOG') || idx < 0
  return [
    {
      category: 'MSI log (last 30 lines)',
      text: localLines.length ? localLines.join('\n') : 'no local log file found',
    },
    {
      category: 'Spark log (last 30 lines)',
      text: noRemote ? 'no remote log file found' : remoteLines.join('\n'),
    },
  ]
}

async function runLocal(
  $: EngineInterface,
  argv: readonly string[],
  init?: { cwd?: string; timeoutMs?: number },
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, init)
    return { ok: exitCode === 0, stdout, stderr }
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: String(err) }
  }
}

async function runRemote(
  $: EngineInterface,
  remoteCmd: string,
  timeoutMs = 30000,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return runLocal($, ['ssh', '-n', ...SSH_OPTS, HOST_ALIAS, remoteCmd], { timeoutMs })
}

async function setBusy($: EngineInterface, key: ActionKey, isBusy: boolean) {
  await update($, state, s => ({
    ...s,
    busy: isBusy ? [...s.busy.filter(k => k !== key), key] : s.busy.filter(k => k !== key),
  }))
}

async function finish(
  $: EngineInterface,
  key: ActionKey,
  result: ActionResult,
  envRaw?: string,
) {
  await update($, state, s => {
    const next: SparkPanelState = {
      ...s,
      busy: s.busy.filter(k => k !== key),
      expanded: s.expanded.includes(key) ? s.expanded : [...s.expanded, key],
      envStatus: envRaw !== undefined ? deriveEnvStatus(envRaw) ?? s.envStatus : s.envStatus,
    }
    switch (key) {
      case 'check':
        next.check = result
        break
      case 'plan':
        next.plan = result
        break
      case 'init':
        next.init = result
        break
      case 'gpu':
        next.gpu = result
        break
      case 'jobs':
        next.jobs = result
        break
      case 'logs':
        next.logs = result
        break
    }
    return next
  })
}

async function doSparkCheck($: EngineInterface) {
  await setBusy($, 'check', true)
  const { ok, stdout, stderr, error } = await runLocal($, ['powershell.exe', '-NoProfile', '-File', SPARK_PS1, 'Check'], {
    cwd: TOOL_DIR,
    timeoutMs: 180000,
  })
  const categories = categorizeCheckOutput(stdout)
  const failure = error ?? (!ok ? stderr.slice(0, 500) || 'spark check failed' : undefined)
  const result: ActionResult = {
    ok,
    atMs: Date.now(),
    summary: failure ? oneLine(failure) : summarizeCheck(stdout, categories),
    categories,
    error: failure,
  }
  await finish($, 'check', result, stdout)
}

async function doSparkPlan($: EngineInterface) {
  await setBusy($, 'plan', true)
  const { ok, stdout, stderr, error } = await runLocal($, ['powershell.exe', '-NoProfile', '-File', SPARK_PS1, 'Plan'], {
    cwd: TOOL_DIR,
    timeoutMs: 180000,
  })
  const categories = categorizePlanOutput(stdout)
  const failure = error ?? (!ok ? stderr.slice(0, 500) || 'spark plan failed' : undefined)
  const packages = categories.find(c => c.category === 'Packages to install')?.text.split(', ').length ?? 0
  const result: ActionResult = {
    ok,
    atMs: Date.now(),
    summary: failure ? oneLine(failure) : `${packages} packages would be installed`,
    categories,
    error: failure,
  }
  await finish($, 'plan', result)
}

async function doSparkInit($: EngineInterface) {
  await setBusy($, 'init', true)
  const { ok, stdout, stderr, error } = await runLocal($, ['powershell.exe', '-NoProfile', '-File', SPARK_PS1, 'Init'], {
    cwd: TOOL_DIR,
    timeoutMs: 180000,
  })
  const categories = categorizeCheckOutput(stdout)
  const failure = error ?? (!ok ? stderr.slice(0, 500) || 'spark init failed' : undefined)
  const result: ActionResult = {
    ok,
    atMs: Date.now(),
    summary: failure ? oneLine(failure) : deriveEnvStatus(stdout) ?? summarizeCheck(stdout, categories),
    categories,
    error: failure,
  }
  await finish($, 'init', result, stdout)
}

async function doGpuUsage($: EngineInterface) {
  await setBusy($, 'gpu', true)
  const { ok, stdout, stderr, error } = await runRemote($, 'nvidia-smi', 20000)
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  const failure = error ?? (!ok ? stderr.slice(0, 500) || 'nvidia-smi failed' : undefined)
  const result: ActionResult = {
    ok,
    atMs: Date.now(),
    summary: failure ? oneLine(failure) : summarizeGpu(stdout),
    categories: ok ? [{ category: 'nvidia-smi', text: lines.join('\n') }] : [],
    error: failure,
  }
  await finish($, 'gpu', result)
}

async function doRunningJobs($: EngineInterface) {
  await setBusy($, 'jobs', true)
  const remoteCmd = `tmux ls 2>/dev/null; echo ${SEP}; ps -eo pid,etime,cmd 2>/dev/null | grep -iE "python.*(train|lora)|accelerate|torchrun" | grep -v grep; true`
  const { ok, stdout, error } = await runRemote($, remoteCmd, 20000)
  const categories = parseJobsOutput(stdout)
  const result: ActionResult = {
    ok,
    atMs: Date.now(),
    summary: error ? oneLine(error) : summarizeJobs(categories),
    categories,
    error,
  }
  await finish($, 'jobs', result)
}

async function doShowLogs($: EngineInterface) {
  await setBusy($, 'logs', true)
  let localTail = ''
  let localError: string | undefined
  try {
    const entries = await $.fs.list(LOG_DIR)
    const newest = entries
      .filter(e => e.kind === 'file' && /^spark-.*\.log$/.test(e.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (newest) {
      const text = await $.fs.read(`${LOG_DIR}/${newest.name}`)
      localTail = text.split(/\r?\n/).filter(Boolean).slice(-30).join('\n')
    }
  } catch (err) {
    localError = String(err)
  }

  const remoteCmd = `f=$(ls -t ~/spark-tools/logs/*.log 2>/dev/null | head -1); if [ -n "$f" ]; then echo "$f"; echo ${SEP}; tail -n 30 "$f"; else echo NO_REMOTE_LOG; fi`
  const { ok: remoteOk, stdout: remoteRaw, error: remoteError } = await runRemote($, remoteCmd, 20000)

  const categories = parseLogsOutput(localTail, remoteRaw)
  const failure = localError ?? remoteError
  const result: ActionResult = {
    ok: localError === undefined && remoteOk,
    atMs: Date.now(),
    summary: failure ? oneLine(failure) : summarizeLogs(categories),
    categories,
    error: failure,
  }
  await finish($, 'logs', result)
}

function openWithNotepad($: EngineInterface, path: string) {
  void $.process.run(['notepad.exe', path]).catch(() => {})
}

async function openMsiLog($: EngineInterface) {
  try {
    const entries = await $.fs.list(LOG_DIR)
    const newest = entries
      .filter(e => e.kind === 'file' && /^spark-.*\.log$/.test(e.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (!newest) return
    openWithNotepad($, `${LOG_DIR}/${newest.name}`)
    await update($, state, s => ({ ...s, lastOpened: { what: 'MSI log', atMs: Date.now() } }))
  } catch {
    // best effort; nothing to open
  }
}

async function openSparkLog($: EngineInterface) {
  const { ok, stdout } = await runRemote($, 'ls -t ~/spark-tools/logs/*.log 2>/dev/null | head -1', 15000)
  const remotePath = stdout.trim()
  if (!ok || !remotePath) return
  const baseName = remotePath.split('/').pop() ?? 'spark-remote.log'
  const localPath = `${LOG_DIR}/remote-${baseName}`
  const scp = await runLocal($, ['scp', ...SSH_OPTS, '-q', `${HOST_ALIAS}:${remotePath}`, localPath], {
    timeoutMs: 30000,
  })
  if (!scp.ok) return
  openWithNotepad($, localPath)
  await update($, state, s => ({ ...s, lastOpened: { what: 'Spark log', atMs: Date.now() } }))
}

async function openLogsFolder($: EngineInterface) {
  void $.process.run(['explorer.exe', LOG_DIR]).catch(() => {})
  await update($, state, s => ({ ...s, lastOpened: { what: 'logs folder', atMs: Date.now() } }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spark',
      description: 'Open the Spark panel (check, plan, init, GPU usage, logs, jobs)',
    })
    void $.ui.open({ id: PANE, title: 'Spark', placement: 'widget' })

    return next(e)
  })

  on('command.run', { command: 'spark' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Spark', placement: 'widget' })

    return { text: 'Spark panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, state)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 40

    const toggleCompact = () => update($, state, v => ({ ...v, isCompact: !v.isCompact }))
    const toggleSection = (key: ActionKey) =>
      update($, state, v => ({
        ...v,
        expanded: v.expanded.includes(key) ? v.expanded.filter(k => k !== key) : [...v.expanded, key],
      }))
    const isAllOpen = ALL_KEYS.every(k => s.expanded.includes(k))
    const toggleAll = () => update($, state, v => ({ ...v, expanded: isAllOpen ? [] : [...ALL_KEYS] }))

    const mark = (keyName: ActionKey, result: ActionResult | undefined) =>
      s.busy.includes(keyName) ? '…' : result === undefined ? '·' : result.ok ? '✓' : '✗'

    const statusText = (keyName: ActionKey, result: ActionResult | undefined) =>
      s.busy.includes(keyName)
        ? 'running…'
        : result
          ? `${result.ok ? 'ok' : 'FAILED'} ${formatTime(result.atMs)}`
          : 'never run'

    const details = (result: ActionResult | undefined, extra?: string) => (
      <Box flexDirection="column" paddingLeft={2}>
        {result?.error && <Text color="red">{result.error}</Text>}
        {result?.categories.map(c => (
          <Box flexDirection="column">
            <Text bold>{c.category}:</Text>
            <Box overflowX="scroll" flexDirection="column">
              {c.text.split('\n').map(line => <Text dimColor>{line}</Text>)}
            </Box>
          </Box>
        ))}
        {extra && <Text dimColor>{extra}</Text>}
      </Box>
    )

    // One section: [▸] [button] status, a one-line summary, and details when expanded.
    const section = (
      label: string,
      keyName: ActionKey,
      result: ActionResult | undefined,
      onPress: () => void,
      extra?: string,
    ) => {
      const isOpen = s.expanded.includes(keyName)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Button key={`toggle-${keyName}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggleSection(keyName)} />
            <Button key={keyName} label={label} onPress={onPress} />
            <Text dimColor={result?.ok !== false}>{statusText(keyName, result)}</Text>
          </Box>
          {result && (
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">{result.summary}</Text>
            </Box>
          )}
          {isOpen && details(result, extra)}
        </Box>
      )
    }

    const compactButton = (label: string, keyName: ActionKey, result: ActionResult | undefined, onPress: () => void) => (
      <Box flexDirection="row" gap={1}>
        <Text dimColor={result?.ok !== false}>{mark(keyName, result)}</Text>
        <Button key={keyName} label={label} onPress={onPress} />
      </Box>
    )

    const toolbar = (
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Button
          key="compact"
          plain
          label={s.isCompact ? '◂ Expand panel' : '▸ Buttons only'}
          onPress={toggleCompact}
        />
        {!s.isCompact && (
          <Button key="all" plain label={isAllOpen ? 'Collapse all' : 'Expand all'} onPress={toggleAll} />
        )}
      </Box>
    )

    const openButtons = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="open-msi-log" plain label="Open MSI log" onPress={() => void openMsiLog($)} />
          <Button key="open-spark-log" plain label="Open Spark log" onPress={() => void openSparkLog($)} />
        </Box>
        <Button key="open-logs-folder" plain label="Open logs folder" onPress={() => void openLogsFolder($)} />
        {s.lastOpened && !s.isCompact && (
          <Text dimColor>
            Opened {s.lastOpened.what} {formatTime(s.lastOpened.atMs)}
          </Text>
        )}
      </Box>
    )

    if (e.props.placement === 'widget') {
      const glance = (label: string, keyName: ActionKey, result: ActionResult | undefined) => (
        <Text dimColor={result?.ok !== false} wrap="truncate-end">
          {mark(keyName, result)} {label}
          {result ? ` · ${result.summary}` : ''}
        </Text>
      )
      return (
        <Box flexDirection="column">
          {glance('check', 'check', s.check)}
          {glance('plan', 'plan', s.plan)}
          {glance('init', 'init', s.init)}
          {glance('GPU', 'gpu', s.gpu)}
          {glance('logs', 'logs', s.logs)}
          {glance('jobs', 'jobs', s.jobs)}
        </Box>
      )
    }

    if (s.isCompact) {
      return (
        <Box flexDirection="column" width={width}>
          {toolbar}
          {compactButton('spark check', 'check', s.check, () => void doSparkCheck($))}
          {compactButton('spark plan', 'plan', s.plan, () => void doSparkPlan($))}
          {compactButton('spark init', 'init', s.init, () => void doSparkInit($))}
          {compactButton('GPU usage', 'gpu', s.gpu, () => void doGpuUsage($))}
          {compactButton('Show logs', 'logs', s.logs, () => void doShowLogs($))}
          {openButtons}
          {compactButton('Running jobs', 'jobs', s.jobs, () => void doRunningJobs($))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        {toolbar}
        {section('spark check', 'check', s.check, () => void doSparkCheck($))}
        {section('spark plan', 'plan', s.plan, () => void doSparkPlan($))}
        {section(
          'spark init',
          'init',
          s.init,
          () => void doSparkInit($),
          s.envStatus ? `Environment: ${s.envStatus}` : undefined,
        )}
        {section('GPU usage', 'gpu', s.gpu, () => void doGpuUsage($))}
        {section('Show logs', 'logs', s.logs, () => void doShowLogs($))}
        <Box marginBottom={1}>{openButtons}</Box>
        {section('Running jobs', 'jobs', s.jobs, () => void doRunningJobs($))}
      </Box>
    )
  })
}
