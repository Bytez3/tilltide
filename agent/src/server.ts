import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
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

/**
 * The owner web app (`expo export -p web` with EXPO_BASE_URL=/app), for phones without the Android app:
 * iPhones, and anyone who'd rather add it to their home screen. Same origin as the API, so sign-in shows
 * this domain and no CORS is needed. Unknown paths under /app are app screens, so they get index.html.
 */
let root: { fetch: typeof app.fetch } = app
const webDir = process.env.WEB_DIR
if (webDir && existsSync(join(webDir, 'index.html'))) {
  const web = new Hono()
  const strip = (path: string) => path.replace(/^\/app/, '') || '/'
  web.get('/app', (c) => c.redirect('/app/'))
  web.use('/app/*', serveStatic({ root: webDir, rewriteRequestPath: strip }))
  web.get('/app/*', serveStatic({ root: webDir, path: 'index.html' }))
  web.route('/', app)
  root = web
}

startWatcher()
serve({ fetch: root.fetch, port: config.port }, (info) => {
  console.log(`Tilltide agent API on http://localhost:${info.port} (${config.cluster})`)
})
