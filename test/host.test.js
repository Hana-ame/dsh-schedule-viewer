/**
 * Tests for dsh-schedule-viewer host.js.
 *
 * Tests the core logic: schedule parsing, frequency formatting,
 * next trigger computation, delegation parsing, and RPC handlers.
 *
 * @module test/host.test.js
 */

import test, { beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Test helpers ──────────────────────────────────────────────────────────

const MOCK_SCHEDULE = {
  unit: { name: 'schedule', version: 1 },
  global: null,
  tables: {
    tasks: {
      'schedule-active-1': {
        sessionId: 'session-abc',
        record: {
          id: 'schedule-active-1',
          kind: 'every',
          title: 'Test Active Every',
          prompt: 'Line one\nLine two\nLine three',
          everySeconds: 300,
          scheduledAt: '2026-10-10T00:00:00.000Z',
        },
        status: 'active',
        deliveryHistory: { records: [{}, {}, {}] },
        lastDelivery: { deliveredAt: '2026-10-10T19:00:00.000Z' },
      },
      'schedule-active-2': {
        sessionId: 'session-def',
        record: {
          id: 'schedule-active-2',
          kind: 'every',
          title: 'Test Active Hourly',
          prompt: 'Hourly task prompt',
          everySeconds: 3600,
          scheduledAt: '2026-10-10T00:00:00.000Z',
        },
        status: 'active',
        deliveryHistory: { records: [] },
        lastDelivery: null,
      },
      'schedule-inactive-1': {
        sessionId: 'session-ghi',
        record: {
          id: 'schedule-inactive-1',
          kind: 'after',
          title: 'Test One-Shot',
          prompt: 'One shot prompt',
          afterSeconds: 60,
          scheduledAt: '2026-10-09T00:00:00.000Z',
        },
        status: 'inactive',
        deliveryHistory: { records: [{}, {}] },
        lastDelivery: { deliveredAt: '2026-10-09T00:01:00.000Z' },
      },
    },
  },
}

const MOCK_DELEGATIONS = {
  delegations: [
    {
      id: 'dlg-test-001',
      from: 'session-alpha',
      to: 'session-beta',
      status: 'pending',
      task: 'Do something important',
      reply: '',
      note: '',
      createdAt: 1000000,
      settledAt: null,
    },
    {
      id: 'dlg-test-002',
      from: 'session-alpha',
      to: 'session-gamma',
      status: 'done',
      task: 'Another task',
      reply: 'Done!',
      note: '',
      createdAt: 900000,
      settledAt: 950000,
    },
    {
      id: 'dlg-test-003',
      from: 'session-delta',
      to: 'session-beta',
      status: 'failed',
      task: 'Failed task',
      reply: '',
      note: 'timeout',
      createdAt: 800000,
      settledAt: 850000,
    },
  ],
}

const MOCK_HOME = join(homedir(), '.dsh-test-schedule-viewer')
const SCHEDULE_DIR = join(MOCK_HOME, 'storages')
const DELEGATION_DIR = join(MOCK_HOME, 'session-manager')

const setup = () => {
  mkdirSync(SCHEDULE_DIR, { recursive: true })
  mkdirSync(DELEGATION_DIR, { recursive: true })
  writeFileSync(join(SCHEDULE_DIR, 'schedule.json'), JSON.stringify(MOCK_SCHEDULE, null, 2))
  writeFileSync(join(DELEGATION_DIR, 'state.json'), JSON.stringify(MOCK_DELEGATIONS, null, 2))
  process.env.DSH_HOME = MOCK_HOME
}

const teardown = () => {
  delete process.env.DSH_HOME
  try { rmSync(MOCK_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ── Import host module ────────────────────────────────────────────────────

let hostPlugin
let readSchedules
let readDelegations

test('load host module', async () => {
  const mod = await import('../src/host.js')
  hostPlugin = mod.default
  assert.ok(hostPlugin, 'should export default object')
  assert.equal(typeof hostPlugin.apply, 'function')
  assert.equal(hostPlugin.name, 'schedule-viewer')
})

// ── Test helpers ──────────────────────────────────────────────────────────

function createMockCtx() {
  const handled = {}
  globalThis.harness = {
    handle(method, handler) {
      handled[method] = handler
    },
    call() {
      return Promise.resolve({ ok: true })
    },
  }
  const ctx = {
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {}, log() {} },
    effect() { return () => {} },
  }
  return { ctx, handled }
}

// ── RPC handlers ──────────────────────────────────────────────────────────

test('schedules-list returns parsed tasks', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['schedules-list']({})
    assert.equal(r.ok, true)
    assert.ok(Array.isArray(r.tasks))
    assert.equal(r.tasks.length, 3)
  } finally {
    teardown()
  }
})

test('schedules-list active tasks sorted first', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['schedules-list']({})
    assert.equal(r.ok, true)
    // Active tasks should come before inactive
    const firstInactive = r.tasks.findIndex(t => t.status === 'inactive')
    const lastActive = r.tasks.map(t => t.status).lastIndexOf('active')
    assert.ok(lastActive < firstInactive, `active tasks (last at ${lastActive}) should come before inactive (first at ${firstInactive})`)
  } finally {
    teardown()
  }
})

test('schedules-list includes all required fields', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['schedules-list']({})
    assert.equal(r.ok, true)
    for (const task of r.tasks) {
      assert.ok(task.id, 'should have id')
      assert.ok(task.title, 'should have title')
      assert.ok(task.kind, 'should have kind')
      assert.ok(task.status, 'should have status')
      assert.ok(task.frequency, 'should have frequency')
      assert.ok(task.promptSummary, 'should have promptSummary')
      assert.ok('deliveryCount' in task, 'should have deliveryCount')
      assert.ok('lastDeliveryRelative' in task, 'should have lastDeliveryRelative')
    }
  } finally {
    teardown()
  }
})

test('schedules-list formats frequency correctly', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['schedules-list']({})
    assert.equal(r.ok, true)
    const everyTask = r.tasks.find(t => t.id === 'schedule-active-1')
    assert.equal(everyTask.frequency, '5m')
    const hourlyTask = r.tasks.find(t => t.id === 'schedule-active-2')
    assert.equal(hourlyTask.frequency, '1h')
    const afterTask = r.tasks.find(t => t.id === 'schedule-inactive-1')
    assert.equal(afterTask.frequency, 'after 1m')
  } finally {
    teardown()
  }
})

test('delegations-list returns parsed delegations', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['delegations-list']({})
    assert.equal(r.ok, true)
    assert.ok(Array.isArray(r.delegations))
    assert.equal(r.delegations.length, 3)
    assert.ok(r.stats, 'should have stats')
    assert.equal(r.stats.total, 3)
    assert.equal(r.stats.pending, 1)
    assert.equal(r.stats.done, 1)
    assert.equal(r.stats.failed, 1)
  } finally {
    teardown()
  }
})

test('delegations-list includes taskSummary', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['delegations-list']({})
    assert.equal(r.ok, true)
    for (const d of r.delegations) {
      assert.ok(d.taskSummary, 'should have taskSummary')
      assert.ok(d.shortId, 'should have shortId')
    }
  } finally {
    teardown()
  }
})

test('schedules-list handles empty storage', async () => {
  setup()
  // Write empty tasks table
  const emptyData = { unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: {} } }
  writeFileSync(join(SCHEDULE_DIR, 'schedule.json'), JSON.stringify(emptyData))
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['schedules-list']({})
    assert.equal(r.ok, true)
    assert.equal(r.tasks.length, 0)
  } finally {
    teardown()
  }
})

test('schedules-list handles missing file gracefully', async () => {
  setup()
  // Remove the schedule file
  rmSync(join(SCHEDULE_DIR, 'schedule.json'))
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['schedules-list']({})
    assert.equal(r.ok, false)
    assert.ok(r.error, 'should have error message')
  } finally {
    teardown()
  }
})

test('delegations-list handles missing file gracefully', async () => {
  setup()
  // Remove the state file
  rmSync(join(DELEGATION_DIR, 'state.json'))
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['delegations-list']({})
    assert.equal(r.ok, false)
    assert.ok(r.error, 'should have error message')
  } finally {
    teardown()
  }
})

test('schedules-list computes nextTrigger for active every tasks', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['schedules-list']({})
    assert.equal(r.ok, true)
    const everyTask = r.tasks.find(t => t.id === 'schedule-active-1')
    // nextTrigger should be in the future (or at least a valid ISO string)
    assert.ok(everyTask.nextTrigger, 'should compute nextTrigger')
    assert.ok(!isNaN(new Date(everyTask.nextTrigger).getTime()), 'nextTrigger should be valid date')
  } finally {
    teardown()
  }
})

// ── Perpetual session dashboard tests ─────────────────────────────────────

const MOCK_MILESTONES = {
  milestones: [
    { id: 'ms-001', time: '2026-10-12T10:00:00.000Z', description: '部署新插件', status: 'done', session: 'session-x' },
    { id: 'ms-002', time: '2026-10-11T15:00:00.000Z', description: '修复 CI 红灯', status: 'done', session: 'session-y' },
    { id: 'ms-003', time: '2026-10-12T09:00:00.000Z', description: '补录 KB 节点', status: 'done', session: 'session-x' },
  ],
}

const MOCK_DECISIONS = {
  decisions: [
    { id: 'dec-001', prompt: '是否重启 dsh-web？', session: 'session-coord', status: 'pending', createdAt: '2026-10-12T10:30:00.000Z' },
    { id: 'dec-002', prompt: '合并 PR #42？', session: 'session-coord', status: 'pending', createdAt: '2026-10-12T09:00:00.000Z' },
    { id: 'dec-003', prompt: '上一个决策', session: 'session-x', status: 'resolved', createdAt: '2026-10-10T00:00:00.000Z', resolvedAt: '2026-10-10T01:00:00.000Z', resolution: '同意' },
  ],
}

const setupWithPerpetual = () => {
  setup()
  writeFileSync(join(SCHEDULE_DIR, 'perpetual-milestones.json'), JSON.stringify(MOCK_MILESTONES, null, 2))
  writeFileSync(join(SCHEDULE_DIR, 'perpetual-decisions.json'), JSON.stringify(MOCK_DECISIONS, null, 2))
}

test('perpetual-milestones-list returns milestones', async () => {
  setupWithPerpetual()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-milestones-list']({})
    assert.equal(r.ok, true)
    assert.ok(Array.isArray(r.milestones))
    assert.equal(r.milestones.length, 3)
    assert.ok(r.milestones[0].id)
    assert.ok(r.milestones[0].description)
  } finally {
    teardown()
  }
})

test('perpetual-milestones-list handles missing file gracefully', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-milestones-list']({})
    assert.equal(r.ok, false)
    assert.ok(r.error, 'should have error message')
  } finally {
    teardown()
  }
})

test('perpetual-decisions-list returns decisions sorted pending first', async () => {
  setupWithPerpetual()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-decisions-list']({})
    assert.equal(r.ok, true)
    assert.ok(Array.isArray(r.decisions))
    assert.equal(r.decisions.length, 3)
    // Pending decisions should be first
    assert.equal(r.decisions[0].status, 'pending')
    assert.equal(r.decisions[1].status, 'pending')
    assert.equal(r.decisions[2].status, 'resolved')
  } finally {
    teardown()
  }
})

test('perpetual-decisions-list handles missing file gracefully', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-decisions-list']({})
    assert.equal(r.ok, false)
    assert.ok(r.error, 'should have error message')
  } finally {
    teardown()
  }
})

test('perpetual-add-milestone writes and returns id', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-add-milestone']({ description: '新里程碑', session: 'session-z' })
    assert.equal(r.ok, true)
    assert.ok(r.id, 'should return an id')
    // Verify the file was written
    const written = JSON.parse(readFileSync(join(SCHEDULE_DIR, 'perpetual-milestones.json'), 'utf8'))
    assert.equal(written.milestones.length, 1)
    assert.equal(written.milestones[0].description, '新里程碑')
    assert.equal(written.milestones[0].session, 'session-z')
  } finally {
    teardown()
  }
})

test('perpetual-add-decision writes and returns id', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-add-decision']({ prompt: '是否继续？', session: 'session-a' })
    assert.equal(r.ok, true)
    assert.ok(r.id, 'should return an id')
    const written = JSON.parse(readFileSync(join(SCHEDULE_DIR, 'perpetual-decisions.json'), 'utf8'))
    assert.equal(written.decisions.length, 1)
    assert.equal(written.decisions[0].prompt, '是否继续？')
    assert.equal(written.decisions[0].status, 'pending')
  } finally {
    teardown()
  }
})

test('perpetual-resolve-decision marks decision as resolved', async () => {
  setupWithPerpetual()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-resolve-decision']({ id: 'dec-001', resolution: '同意重启' })
    assert.equal(r.ok, true)
    const written = JSON.parse(readFileSync(join(SCHEDULE_DIR, 'perpetual-decisions.json'), 'utf8'))
    const d = written.decisions.find(x => x.id === 'dec-001')
    assert.equal(d.status, 'resolved')
    assert.ok(d.resolvedAt)
    assert.equal(d.resolution, '同意重启')
  } finally {
    teardown()
  }
})

test('perpetual-resolve-decision returns error for missing id', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-resolve-decision']({ id: 'nonexistent' })
    assert.equal(r.ok, false)
    assert.ok(r.error)
  } finally {
    teardown()
  }
})

test('perpetual-resolve-decision requires id parameter', async () => {
  setup()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['perpetual-resolve-decision']({})
    assert.equal(r.ok, false)
    assert.ok(r.error)
  } finally {
    teardown()
  }
})

test('eternal-dashboard aggregates all sections', async () => {
  setupWithPerpetual()
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['eternal-dashboard']({})
    assert.equal(r.ok, true)
    // Layers (schedules)
    assert.ok(Array.isArray(r.layers))
    assert.ok(r.layers.length > 0)
    assert.ok(r.layerCounts)
    // Delegation
    assert.ok(r.delegation)
    assert.ok(r.delegation.stats)
    assert.equal(r.delegation.stats.total, 3)
    // Milestones (today only)
    assert.ok(Array.isArray(r.milestones))
    assert.ok(Array.isArray(r.allMilestones))
    assert.equal(r.allMilestones.length, 3)
    // Decisions
    assert.ok(Array.isArray(r.decisions))
    assert.equal(r.decisions.length, 3)
    // Check layer classification
    const heartbeat = r.layers.find(l => l.layer === 'heartbeat')
    assert.ok(heartbeat, 'should classify 5min task as heartbeat')
  } finally {
    teardown()
  }
})

test('eternal-dashboard handles empty data gracefully', async () => {
  setup()
  // Remove schedule and state files but keep the dirs
  rmSync(join(SCHEDULE_DIR, 'schedule.json'))
  rmSync(join(DELEGATION_DIR, 'state.json'))
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['eternal-dashboard']({})
    assert.equal(r.ok, false)
    assert.ok(r.error, 'should have error when schedules missing')
  } finally {
    teardown()
  }
})

test('eternal-dashboard classifies tasks by interval', async () => {
  setup()
  // Write a schedule with perpetual-style tasks
  const perpetualSchedule = {
    unit: { name: 'schedule', version: 1 },
    global: null,
    tables: {
      tasks: {
        'heartbeat': {
          sessionId: 'session-x',
          record: {
            id: 'heartbeat',
            kind: 'every',
            title: '永动心跳 5min',
            prompt: '心跳检查',
            everySeconds: 300,
            scheduledAt: '2026-10-12T00:00:00.000Z',
          },
          status: 'active',
          deliveryHistory: { records: [{}, {}, {}, {}, {}] },
          lastDelivery: { deliveredAt: '2026-10-12T10:05:00.000Z' },
        },
        'patrol': {
          sessionId: 'session-x',
          record: {
            id: 'patrol',
            kind: 'every',
            title: '无人值守巡检 20min',
            prompt: '巡检',
            everySeconds: 1200,
            scheduledAt: '2026-10-12T00:00:00.000Z',
          },
          status: 'active',
          deliveryHistory: { records: [{}, {}, {}] },
          lastDelivery: { deliveredAt: '2026-10-12T10:00:00.000Z' },
        },
        'tour': {
          sessionId: 'session-x',
          record: {
            id: 'tour',
            kind: 'every',
            title: '全仓巡游 6h',
            prompt: '全仓巡游',
            everySeconds: 21600,
            scheduledAt: '2026-10-12T00:00:00.000Z',
          },
          status: 'active',
          deliveryHistory: { records: [{}, {}] },
          lastDelivery: { deliveredAt: '2026-10-12T06:00:00.000Z' },
        },
      },
    },
  }
  writeFileSync(join(SCHEDULE_DIR, 'schedule.json'), JSON.stringify(perpetualSchedule, null, 2))
  writeFileSync(join(DELEGATION_DIR, 'state.json'), JSON.stringify({ delegations: [] }))
  try {
    const { ctx, handled } = createMockCtx()
    hostPlugin.apply(ctx)
    const r = await handled['eternal-dashboard']({})
    assert.equal(r.ok, true)
    assert.equal(r.layerCounts.heartbeat, 1)
    assert.equal(r.layerCounts.patrol, 1)
    assert.equal(r.layerCounts.tour, 1)
    assert.equal(r.layerCounts.other, 0)
    // Check each layer has correct metadata
    const hb = r.layers.find(l => l.layer === 'heartbeat')
    assert.equal(hb.title, '永动心跳 5min')
    assert.equal(hb.frequency, '5m')
    assert.equal(hb.deliveryCount, 5)
    const pt = r.layers.find(l => l.layer === 'patrol')
    assert.equal(pt.frequency, '20m')
    const tr = r.layers.find(l => l.layer === 'tour')
    assert.equal(tr.frequency, '6h')
  } finally {
    teardown()
  }
})