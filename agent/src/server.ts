import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { app } from './app'
import { config } from './config'
import { requireOrigin } from './rate-limit'
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
  // The same origin lock and headers as the API (no framing of the owner's till, for one).
  web.use('/app/*', requireOrigin(config.originSecret), secureHeaders())
  web.get('/app', (c) => c.redirect('/app/'))
  web.use(
    '/app/*',
    serveStatic({
      root: webDir,
      rewriteRequestPath: strip,
      // Bundles have a hash in their name, so they can be kept; index.html must be fresh after a deploy.
      onFound: (path, c) => c.header('cache-control', path.includes('/_expo/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
    }),
  )
  // A missing file is a 404, not the app: an old bundle name mustn't come back as HTML.
  web.get('/app/*', (c, next) => (/\.[a-z0-9]+$/i.test(c.req.path) ? c.notFound() : next()))
  web.get('/app/*', serveStatic({ root: webDir, path: 'index.html', onFound: (_, c) => c.header('cache-control', 'no-cache') }))
  web.route('/', app)
  root = web
}

startWatcher()
serve({ fetch: root.fetch, port: config.port }, (info) => {
  console.log(`Tilltide agent API on http://localhost:${info.port} (${config.cluster})`)
})
