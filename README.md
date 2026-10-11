# dsh-schedule-viewer

A GUI sidebar button for DeepSeek Harness (DSH) that lists every current schedule with title, id, frequency, next trigger, status and prompt content. An optional section shows recent session delegations from the delegation ledger.

## Wiring

Bundle patch: `cordis.patch.yml`. Entry point `index.js` splits the halves: `./src/host` (host plane, reads schedules and the ledger) and `./src/client` (client plane, renders the sidebar view).

## Tests

```sh
npm test        # node --test test/*.test.js
```
