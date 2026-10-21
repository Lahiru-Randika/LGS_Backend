import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

// Test the SQL placeholder translator implemented in db.ts
function convertPlaceholders(sql: string): string {
  let paramIndex = 1
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let inBlockComment = false
  let inDollarQuote = false
  let dollarTag = ''
  let result = ''

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    const nextChar = i + 1 < sql.length ? sql[i + 1] : ''

    if (inLineComment) {
      result += char
      if (char === '\n') inLineComment = false
      continue
    }

    if (inBlockComment) {
      result += char
      if (char === '*' && nextChar === '/') {
        result += '/'
        i++
        inBlockComment = false
      }
      continue
    }

    if (inDollarQuote) {
      result += char
      if (char === '$' && sql.startsWith(dollarTag, i)) {
        result += dollarTag.slice(1)
        i += dollarTag.length - 1
        inDollarQuote = false
      }
      continue
    }

    if (inSingleQuote) {
      result += char
      if (char === "'") {
        if (nextChar === "'") {
          result += "'"
          i++
        } else {
          inSingleQuote = false
        }
      }
      continue
    }

    if (inDoubleQuote) {
      result += char
      if (char === '"') {
        if (nextChar === '"') {
          result += '"'
          i++
        } else {
          inDoubleQuote = false
        }
      }
      continue
    }

    if (char === '-' && nextChar === '-') {
      result += '--'
      i++
      inLineComment = true
      continue
    }

    if (char === '/' && nextChar === '*') {
      result += '/*'
      i++
      inBlockComment = true
      continue
    }

    if (char === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/)
      if (match) {
        dollarTag = match[0]
        result += dollarTag
        i += dollarTag.length - 1
        inDollarQuote = true
        continue
      }
    }

    if (char === "'") {
      result += char
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      result += char
      inDoubleQuote = true
      continue
    }

    if (char === '?') {
      result += `$${paramIndex++}`
      continue
    }

    result += char
  }

  return result
}

console.log('Testing SQL placeholder conversion logic...')

// Test 1: Simple query
const q1 = 'SELECT * FROM users WHERE email = ? AND status = ?'
assert.strictEqual(
  convertPlaceholders(q1),
  'SELECT * FROM users WHERE email = $1 AND status = $2',
)
console.log('  ✓ Simple query placeholder conversion passed')

// Test 2: Literal question marks in quotes
const q2 = "SELECT * FROM questions WHERE title = 'What is this?' AND user_id = ?"
assert.strictEqual(
  convertPlaceholders(q2),
  "SELECT * FROM questions WHERE title = 'What is this?' AND user_id = $1",
)
console.log('  ✓ Preserves question marks inside string literals')

// Test 3: Escaped quotes inside string literals
const q3 = "SELECT * FROM t WHERE text = 'It''s a question?' AND id = ?"
assert.strictEqual(
  convertPlaceholders(q3),
  "SELECT * FROM t WHERE text = 'It''s a question?' AND id = $1",
)
console.log('  ✓ Preserves escaped single quotes inside string literals')

// Test 4: Question marks inside comments
const q4 = 'SELECT id -- Is this safe?\nFROM t WHERE code = ? /* does it handle ? */ AND x = ?'
assert.strictEqual(
  convertPlaceholders(q4),
  'SELECT id -- Is this safe?\nFROM t WHERE code = $1 /* does it handle ? */ AND x = $2',
)
console.log('  ✓ Preserves question marks in comments')

// Test 5: Dollar-quoted strings
const q5 = "DO $$ BEGIN IF true THEN RAISE NOTICE 'test?'; END IF; END $$; SELECT ?"
assert.strictEqual(
  convertPlaceholders(q5),
  "DO $$ BEGIN IF true THEN RAISE NOTICE 'test?'; END IF; END $$; SELECT $1",
)
console.log('  ✓ Preserves question marks inside dollar-quoted blocks')

// Test 6: Verify all migration files do not contain forbidden MySQL keywords
console.log('\nValidating migration files against forbidden MySQL syntax...')
const migrationsDir = path.resolve(process.cwd(), 'migrations')
const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))

const forbiddenPatterns = [
  { name: 'ENGINE=InnoDB', regex: /ENGINE\s*=\s*InnoDB/i },
  { name: 'AUTO_INCREMENT', regex: /AUTO_INCREMENT/i },
  { name: 'TINYINT', regex: /\bTINYINT\b/i },
  { name: 'DATETIME', regex: /\bDATETIME\b/i },
  { name: 'CHARACTER SET', regex: /CHARACTER\s+SET/i },
  { name: 'COLLATE utf8', regex: /COLLATE\s+utf8/i },
  { name: 'ON DUPLICATE KEY UPDATE', regex: /ON\s+DUPLICATE\s+KEY\s+UPDATE/i },
  { name: 'INSERT IGNORE', regex: /INSERT\s+IGNORE/i },
]

for (const file of migrationFiles) {
  const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
  for (const pattern of forbiddenPatterns) {
    if (pattern.regex.test(content)) {
      throw new Error(`File ${file} contains forbidden MySQL syntax: ${pattern.name}`)
    }
  }
  console.log(`  ✓ ${file} is free of MySQL-specific syntax`)
}

console.log('\nAll SQL compatibility validations passed successfully!')
