import { readFile } from 'node:fs/promises'
import { sql } from './index'

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8')
await sql.unsafe(schema)
console.log('Database schema is up to date')
await sql.end()
