import { describe, expect, it } from 'vitest'

// csvCell has no database dependency, but export.ts imports db; stub the env it needs at import.
process.env.DATABASE_URL ??= 'postgres://unused@localhost/unused'
process.env.AUTH_DOMAIN ??= 'test'

describe('csvCell', async () => {
  const { csvCell } = await import('../src/services/export')

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
  })

  it('defuses spreadsheet formulas in shop-typed text', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`)
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })
})
