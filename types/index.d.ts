export type ActionCategory = { category: string; text: string }

export type ActionResult = {
  ok: boolean
  atMs: number
  summary: string
  categories: ActionCategory[]
  error?: string
}

export type ActionKey = 'check' | 'plan' | 'init' | 'gpu' | 'jobs' | 'logs'

export type LastOpened = { what: string; atMs: number }

export type SparkPanelState = {
  check?: ActionResult
  plan?: ActionResult
  init?: ActionResult
  gpu?: ActionResult
  jobs?: ActionResult
  logs?: ActionResult
  envStatus?: string
  lastOpened?: LastOpened
  busy: ActionKey[]
  expanded: ActionKey[]
  isCompact: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'spark-panel': { state: Shaped<SparkPanelState> }
  }
}
