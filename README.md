# dsh-schedule-viewer

GUI sidebar plugin for DSH that shows:
1. **定时任务** — all schedules with title, id, frequency, next trigger, status, prompt
2. **委派记录** — recent session delegations from the ledger
3. **永动看板** — perpetual session dashboard (三层定时器 / 委托账本 / 待决策 / 今日里程碑)

## 永动看板

The dashboard aggregates:
- **三层定时器**: active schedules classified by interval (5min=heartbeat, 20min=patrol, 6h=tour) or keyword
- **委托账本**: delegation stats + recent items
- **待用户决策**: pending items from `~/.dsh/storages/perpetual-decisions.json`
- **今日里程碑**: today's entries from `~/.dsh/storages/perpetual-milestones.json`

Both log files are optional (empty state shown if absent).

### Write RPCs

- `perpetual-add-milestone` — append a milestone `{ description, session, time? }`
- `perpetual-add-decision` — append a pending decision `{ prompt, session }`
- `perpetual-resolve-decision` — mark resolved `{ id, resolution }`

### Read RPCs

- `eternal-dashboard` — aggregated dashboard view
- `perpetual-milestones-list` — full milestones log
- `perpetual-decisions-list` — full decisions log

## Wiring

Bundle patch: `cordis.patch.yml`. Entry point `index.js` splits the halves:
`./src/host` (host plane, reads schedules + ledger + perpetual logs) and
`./src/client` (client plane, renders the sidebar panel with 3 tabs).

## Tests

```sh
npm test        # node --test test/*.test.js  (23 tests)
```
