/** A real calendar date in YYYY-MM-DD form. Rejects 2026-02-31, which Date.parse rolls over but Postgres refuses. */
export function isDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const parsed = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d
}
