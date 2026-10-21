import { serve } from '@hono/node-server'
import { app } from './app'
import { config } from './config'
import { startWatcher } from './services/watcher'

startWatcher()
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Tilltide agent API on http://localhost:${info.port} (${config.cluster})`)
})
