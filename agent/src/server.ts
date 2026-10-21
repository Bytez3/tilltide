import { serve } from '@hono/node-server'
import { app } from './app'
import { config } from './config'
import { startWatcher } from './services/watcher'
import { checkProductionConfig } from './production'

const problems = checkProductionConfig()
for (const p of problems) console[p.level === 'fatal' ? 'error' : 'warn'](`[config ${p.level}] ${p.message}`)
if (problems.some((p) => p.level === 'fatal')) {
  console.error('Refusing to start on mainnet until the fatal problems above are fixed.')
  process.exit(1)
}

startWatcher()
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Tilltide agent API on http://localhost:${info.port} (${config.cluster})`)
})
