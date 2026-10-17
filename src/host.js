/**
 * dsh-schedule-viewer — Host half (cordis mode).
 *
 * Reads the DSH schedule storage (~/.dsh/storages/schedule.json) and the
 * session-manager delegation ledger (~/.dsh/session-manager/state.json),
 * then serves parsed data to the client half via RPC.
 *
 * RPC methods:
 *   - schedules-list   → all scheduled tasks with metadata
 *   - delegations-list → recent session delegations (optional section)
 *
 * @module src/host.js
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'

const crypto = { randomUUID: cryptoRandomUUID }

// ── Storage paths ─────────────────────────────────────────────────────────

const DSH_HOME = () => {
  const configured = typeof process === 'object' && process !== null && typeof process.env === 'object' && process.env !== null ? process.env.DSH_HOME : undefined
  return typeof configured === 'string' && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

const SCHEDULE_PATH = () => join(DSH_HOME(), 'storages', 'schedule.json')
const DELEGATION_PATH = () => join(DSH_HOME(), 'session-manager', 'state.json')
const MILESTONES_PATH = () => join(DSH_HOME(), 'storages', 'perpetual-milestones.json')
const DECISIONS_PATH = () => join(DSH_HOME(), 'storages', 'perpetual-decisions.json')

// ── Helpers ───────────────────────────────────────────────────────────────

const messageOf = (error) =>
  error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error)

const shortId = (id) =>
  typeof id === 'string' && id.length > 24
    ? `…${id.slice(-12)}`
    : (id || '?')

/** Human-readable frequency label. */
const formatFrequency = (record) => {
  const kind = record?.kind
  if (kind === 'every') {
    const seconds = record.everySeconds
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${seconds % 3600 > 0 ? ` ${Math.floor((seconds % 3600) / 60)}m` : ''}`
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60 > 0 ? ` ${seconds % 60}s` : ''}`
    return `${seconds}s`
  }
  if (kind === 'after') {
    const seconds = record.afterSeconds
    if (seconds >= 3600) return `after ${Math.floor(seconds / 3600)}h`
    if (seconds >= 60) return `after ${Math.floor(seconds / 60)}m`
    return `after ${seconds}s`
  }
  if (kind === 'daily') return 'daily'
  if (kind === 'weekly') return 'weekly'
  if (kind === 'cron') return 'cron'
  return kind || 'unknown'
}

/** Compute next trigger time for an active schedule. */
const computeNextTrigger = (record) => {
  const scheduledAt = record?.scheduledAt
  if (!scheduledAt) return null
  const base = new Date(scheduledAt)
  if (isNaN(base.getTime())) return null

  const now = Date.now()
  if (record.kind === 'every') {
    const intervalMs = (record.everySeconds || 0) * 1000
    if (intervalMs <= 0) return null
    let next = base.getTime() + intervalMs
    while (next <= now) next += intervalMs
    return new Date(next).toISOString()
  }
  if (record.kind === 'after') {
    return new Date(base.getTime()).toISOString()
  }
  if (record.kind === 'daily') {
    const d = new Date()
    d.setUTCHours(...(record.time || [0, 0, 0, 0]))
    if (d.getTime() <= now) d.setUTCDate(d.utcDate() + 1)
    return d.toISOString()
  }
  return scheduledAt
}

/** Extract a short prompt summary (first line / first 120 chars). */
const summarizePrompt = (prompt) => {
  if (typeof prompt !== 'string' || prompt.length === 0) return ''
  const lines = prompt.split('\n')
  if (lines.length === 1) return prompt.length > 120 ? prompt.slice(0, 120) + '…' : prompt
  return lines[0].length > 120 ? lines[0].slice(0, 120) + '…' : lines[0]
}

/** Parse a relative time to a human-friendly label. */
const relativeTime = (isoString) => {
  if (!isoString) return '—'
  const diff = Date.now() - new Date(isoString).getTime()
  if (isNaN(diff)) return isoString
  const abs = Math.abs(diff)
  const sign = diff > 0 ? '前' : '后'
  const sec = Math.round(abs / 1000)
  if (sec < 60) return `${sec}秒${sign}`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}分钟${sign}`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}小时${sign}`
  const day = Math.round(hr / 24)
  return `${day}天${sign}`
}

// ── Data readers ──────────────────────────────────────────────────────────

/**
 * Read and parse the schedule storage file.
 * @returns {{ ok: boolean, tasks: Array, error?: string }}
 */
function readSchedules() {
  try {
    const raw = readFileSync(SCHEDULE_PATH(), 'utf8')
    const data = JSON.parse(raw)
    const tasksTable = data?.tables?.tasks
    if (tasksTable === null || tasksTable === undefined || typeof tasksTable !== 'object') {
      return { ok: true, tasks: [] }
    }

    const tasks = []
    for (const [id, entry] of Object.entries(tasksTable)) {
      const record = entry?.record
      if (record === null || record === undefined || typeof record !== 'object') continue

      const kind = record.kind || 'unknown'
      const status = entry.status || 'unknown'
      const frequency = formatFrequency(record)
      const nextTrigger = status === 'active' ? computeNextTrigger(record) : null
      const lastDelivery = entry?.lastDelivery?.deliveredAt || null
      const deliveryCount = entry?.deliveryHistory?.records?.length || 0

      tasks.push({
        id,
        title: record.title || '(no title)',
        kind,
        status,
        frequency,
        everySeconds: record.everySeconds || null,
        scheduledAt: record.scheduledAt || null,
        nextTrigger,
        lastDelivery,
        lastDeliveryRelative: lastDelivery ? relativeTime(lastDelivery) : null,
        deliveryCount,
        prompt: record.prompt || '',
        promptSummary: summarizePrompt(record.prompt || ''),
        sessionId: entry.sessionId || null,
      })
    }

    // Sort: active first, then by scheduledAt descending
    tasks.sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1
      if (a.status !== 'active' && b.status === 'active') return 1
      return (b.scheduledAt || '').localeCompare(a.scheduledAt || '')
    })

    return { ok: true, tasks }
  } catch (error) {
    return { ok: false, tasks: [], error: messageOf(error) }
  }
}

/**
 * Read and parse the delegation ledger.
 * @returns {{ ok: boolean, delegations: Array, error?: string }}
 */
function readDelegations() {
  try {
    const raw = readFileSync(DELEGATION_PATH(), 'utf8')
    const data = JSON.parse(raw)
    const delegations = data?.delegations
    if (!Array.isArray(delegations)) {
      return { ok: true, delegations: [] }
    }

    // Return newest 30, with a summary
    const recent = delegations.slice(0, 30).map((d) => ({
      id: d.id || '?',
      shortId: shortId(d.id),
      from: d.from || '?',
      fromShort: shortId(d.from),
      to: d.to || '?',
      toShort: shortId(d.to),
      status: d.status || 'unknown',
      task: d.task || '',
      taskSummary: summarizePrompt(d.task || ''),
      replySummary: summarizePrompt(d.reply || ''),
      createdAt: d.createdAt || null,
      settledAt: d.settledAt || null,
      note: d.note || '',
    }))

    const stats = {
      total: delegations.length,
      pending: delegations.filter(d => d.status === 'pending').length,
      done: delegations.filter(d => d.status === 'done').length,
      failed: delegations.filter(d => d.status === 'failed').length,
      unknown: delegations.filter(d => d.status === 'unknown').length,
    }

    return { ok: true, delegations: recent, stats }
  } catch (error) {
    return { ok: false, delegations: [], stats: null, error: messageOf(error) }
  }
}

// ── Perpetual session dashboard: milestones & decisions ────────────────────

/**
 * Read the perpetual milestones log.
 * @returns {{ ok: boolean, milestones: Array, error?: string }}
 */
function readMilestones() {
  try {
    const raw = readFileSync(MILESTONES_PATH(), 'utf8')
    const data = JSON.parse(raw)
    const milestones = Array.isArray(data?.milestones) ? data.milestones : []
    // Return newest first, limited to 50
    const recent = milestones.slice(0, 50).map((m) => ({
      id: m.id || crypto.randomUUID(),
      time: m.time || m.createdAt || null,
      description: m.description || m.title || '',
      status: m.status || 'done',
      session: m.session || null,
    }))
    return { ok: true, milestones: recent, total: milestones.length }
  } catch (error) {
    return { ok: false, milestones: [], error: messageOf(error) }
  }
}

/**
 * Read the perpetual decisions log.
 * @returns {{ ok: boolean, decisions: Array, error?: string }}
 */
function readDecisions() {
  try {
    const raw = readFileSync(DECISIONS_PATH(), 'utf8')
    const data = JSON.parse(raw)
    const decisions = Array.isArray(data?.decisions) ? data.decisions : []
    // Pending first, then newest first; limit 50
    const sorted = decisions
      .slice()
      .sort((a, b) => {
        const as = a.status === 'pending' ? 0 : 1
        const bs = b.status === 'pending' ? 0 : 1
        if (as !== bs) return as - bs
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
      .slice(0, 50)
      .map((d) => ({
        id: d.id || '?',
        prompt: d.prompt || d.task || '',
        promptSummary: summarizePrompt(d.prompt || d.task || ''),
        session: d.session || null,
        status: d.status || 'pending',
        createdAt: d.createdAt || null,
        resolvedAt: d.resolvedAt || null,
        resolution: d.resolution || null,
      }))
    return { ok: true, decisions: sorted, total: decisions.length }
  } catch (error) {
    return { ok: false, decisions: [], error: messageOf(error) }
  }
}

/**
 * Append a milestone to the log.
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
function writeMilestone(entry) {
  try {
    let data = { milestones: [] }
    try {
      data = JSON.parse(readFileSync(MILESTONES_PATH(), 'utf8'))
      if (!Array.isArray(data.milestones)) data.milestones = []
    } catch { /* file doesn't exist yet */ }
    const id = entry.id || crypto.randomUUID()
    data.milestones.unshift({
      id,
      time: entry.time || new Date().toISOString(),
      description: entry.description || entry.title || 'milestone',
      status: entry.status || 'done',
      session: entry.session || null,
    })
    writeFileSync(MILESTONES_PATH(), JSON.stringify(data, null, 2))
    return { ok: true, id }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * Append a decision to the log.
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
function writeDecision(entry) {
  try {
    let data = { decisions: [] }
    try {
      data = JSON.parse(readFileSync(DECISIONS_PATH(), 'utf8'))
      if (!Array.isArray(data.decisions)) data.decisions = []
    } catch { /* file doesn't exist yet */ }
    const id = entry.id || crypto.randomUUID()
    data.decisions.unshift({
      id,
      prompt: entry.prompt || entry.task || '',
      session: entry.session || null,
      status: 'pending',
      createdAt: entry.createdAt || new Date().toISOString(),
    })
    writeFileSync(DECISIONS_PATH(), JSON.stringify(data, null, 2))
    return { ok: true, id }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * Resolve a pending decision.
 * @returns {{ ok: boolean, error?: string }}
 */
function resolveDecision(id, resolution) {
  try {
    let data = { decisions: [] }
    try {
      data = JSON.parse(readFileSync(DECISIONS_PATH(), 'utf8'))
      if (!Array.isArray(data.decisions)) data.decisions = []
    } catch { /* file doesn't exist */ }
    let found = false
    for (const d of data.decisions) {
      if (d.id === id) {
        d.status = 'resolved'
        d.resolvedAt = new Date().toISOString()
        d.resolution = resolution || null
        found = true
        break
      }
    }
    if (!found) return { ok: false, error: `decision not found: ${id}` }
    writeFileSync(DECISIONS_PATH(), JSON.stringify(data, null, 2))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

// ── Perpetual session layer classification ─────────────────────────────────

/**
 * Classify a schedule task into a perpetual-session layer based on
 * its everySeconds interval and title keywords.
 * @returns {string} 'heartbeat' | 'patrol' | 'tour' | 'other'
 */
function classifyLayer(task) {
  if (!task || task.status !== 'active') return 'other'
  const prompt = `${task.title || ''} ${task.prompt || ''}`.toLowerCase()
  // Keyword-based classification (high confidence)
  if (/心跳|heartbeat/.test(prompt)) return 'heartbeat'
  if (/巡检|patrol|巡查/.test(prompt)) return 'patrol'
  if (/巡游|tour|全仓|全库/.test(prompt)) return 'tour'
  // Interval-based fallback (300s=5min heartbeat, 1200s=20min patrol, 21600s=6h tour)
  if (task.kind === 'every') {
    const s = task.everySeconds || 0
    if (s >= 300 && s <= 600) return 'heartbeat'
    if (s >= 600 && s <= 3600) return 'patrol'
    if (s > 3600) return 'tour'
  }
  return 'other'
}

/**
 * Build the perpetual dashboard aggregation.
 * @returns {{ ok: boolean, layers: Array, delegation: Object, milestones: Array, decisions: Array, error?: string }}
 */
function buildEternalDashboard() {
  const schedulesResult = readSchedules()
  const delegationsResult = readDelegations()
  const milestonesResult = readMilestones()
  const decisionsResult = readDecisions()

  if (!schedulesResult.ok) {
    return { ok: false, error: schedulesResult.error || 'failed to read schedules' }
  }

  // Classify each task
  const tasks = schedulesResult.tasks
  const layers = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    frequency: t.frequency,
    nextTrigger: t.nextTrigger,
    lastDelivery: t.lastDeliveryRelative || null,
    deliveryCount: t.deliveryCount,
    layer: classifyLayer(t),
    promptSummary: t.promptSummary,
  }))

  // Group by layer
  const layerCounts = { heartbeat: 0, patrol: 0, tour: 0, other: 0 }
  for (const l of layers) layerCounts[l.layer]++

  // Delegation stats (from existing readDelegations)
  const delegation = {
    stats: delegationsResult.stats || { total: 0, pending: 0, done: 0, failed: 0, unknown: 0 },
    recent: delegationsResult.ok ? delegationsResult.delegations.slice(0, 10) : [],
  }

  // Filter pending decisions
  const decisions = decisionsResult.ok ? decisionsResult.decisions : []

  // Filter today's milestones
  const milestones = milestonesResult.ok ? milestonesResult.milestones : []
  const today = new Date().toISOString().slice(0, 10)
  const todayMilestones = milestones.filter((m) => m.time && m.time.startsWith(today))

  return {
    ok: true,
    layers,
    layerCounts,
    delegation,
    decisions,
    milestones: todayMilestones,
    allMilestones: milestones,
  }
}

// ── Main export ───────────────────────────────────────────────────────────

export default {
  name: 'schedule-viewer',

  apply(ctx) {
    const logger = () => ctx.logger ?? { info: () => {}, warn: () => {}, error: () => {} }

    // ── RPC handlers ──────────────────────────────────────────────────────

    harness.handle('schedules-list', async (_args) => {
      try {
        const result = readSchedules()
        return result
      } catch (e) {
        return { ok: false, tasks: [], error: messageOf(e) }
      }
    })

    harness.handle('delegations-list', async (_args) => {
      try {
        const result = readDelegations()
        return result
      } catch (e) {
        return { ok: false, delegations: [], stats: null, error: messageOf(e) }
      }
    })

    harness.handle('eternal-dashboard', async (_args) => {
      try {
        const result = buildEternalDashboard()
        return result
      } catch (e) {
        return { ok: false, error: messageOf(e) }
      }
    })

    harness.handle('perpetual-milestones-list', async (_args) => {
      try {
        return readMilestones()
      } catch (e) {
        return { ok: false, milestones: [], error: messageOf(e) }
      }
    })

    harness.handle('perpetual-add-milestone', async (args) => {
      try {
        const entry = typeof args === 'object' && args !== null ? args : {}
        return writeMilestone(entry)
      } catch (e) {
        return { ok: false, error: messageOf(e) }
      }
    })

    harness.handle('perpetual-decisions-list', async (_args) => {
      try {
        return readDecisions()
      } catch (e) {
        return { ok: false, decisions: [], error: messageOf(e) }
      }
    })

    harness.handle('perpetual-add-decision', async (args) => {
      try {
        const entry = typeof args === 'object' && args !== null ? args : {}
        return writeDecision(entry)
      } catch (e) {
        return { ok: false, error: messageOf(e) }
      }
    })

    harness.handle('perpetual-resolve-decision', async (args) => {
      try {
        const { id, resolution } = typeof args === 'object' && args !== null ? args : {}
        if (!id || typeof id !== 'string') return { ok: false, error: 'missing id' }
        return resolveDecision(id, resolution)
      } catch (e) {
        return { ok: false, error: messageOf(e) }
      }
    })

    console.log('[schedule-viewer] host applied; RPC handlers registered')
  },
}