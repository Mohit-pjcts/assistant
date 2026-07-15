# dashboard

Tauri 2 + React + TypeScript desktop client for the assistant — see the [root README](../README.md#dashboard-app) for what this app does and how it fits into the overall project, and its [Setup](../README.md#dashboard-app) section for running it.

## Development

```sh
npm install
npm run tauri dev   # launches the Tauri window (spawns the Python backend + voice daemon)
npm run build        # production bundle
npm test              # vitest, component tests for each panel
```
