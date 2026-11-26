import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Store } from './store.js'

/**
 * Hosted-mode database (SQLite, one file). Holds accounts, hashed access
 * tokens and each account's documents (desk settings, alerts, paper account,
 * exchange API keys). Secrets are sealed with AES-256-GCM under DATA_KEY,
 * so a copied database file alone does not expose anyone's exchange keys.
 *
 * Adapted from Glance (same author), server/src/lib/db.ts.
 */

const MIGRATIONS = [
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   );
   CREATE TABLE tokens (
     hash TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     label TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     last_used INTEGER NOT NULL
   );
   CREATE INDEX tokens_account ON tokens(account_id);
   CREATE TABLE docs (
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, name)
   );`,
]

export interface Account {
  id: string
  createdAt: number
  lastSeen: number
}

const now = () => Math.floor(Date.now() / 1000)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** AES-256-GCM with a key from DATA_KEY (64 hex chars or 44-char base64). */
export class Sealer {
  private readonly key: Buffer
  constructor(secret: string) {
    const key = /^[0-9a-f]{64}$/i.test(secret) ? Buffer.from(secret, 'hex') : Buffer.from(secret, 'base64')
    if (key.length !== 32) throw new Error('DATA_KEY must be 32 bytes (64 hex characters or base64). Generate one with: openssl rand -hex 32')
    this.key = key
  }
  seal(plain: string): string {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`
  }
  open(sealed: string): string {
    if (!sealed.startsWith('v1:')) throw new Error('Unknown sealed format')
    const raw = Buffer.from(sealed.slice(3), 'base64')
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  }
}

export class Database {
  readonly db: DatabaseSync

  constructor(file: string, readonly sealer: Sealer) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    // Owner-only, before WAL starts: SQLite gives the -wal/-shm files the main file's mode.
    if (file !== ':memory:') chmodSync(file, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
    this.migrate()
  }

  private migrate() {
    const { user_version: v } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[i]!)
        this.db.exec(`PRAGMA user_version = ${i + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  close() {
    this.db.close()
  }

  // ── Accounts ──────────────────────────────────────────────────────────
  createAccount(): Account {
    const id = randomBytes(12).toString('hex')
    const t = now()
    this.db.prepare('INSERT INTO accounts (id, created_at, last_seen) VALUES (?, ?, ?)').run(id, t, t)
    return this.account(id)!
  }

  account(id: string): Account | undefined {
    const r = this.db.prepare('SELECT id, created_at, last_seen FROM accounts WHERE id = ?').get(id) as
      | { id: string; created_at: number; last_seen: number }
      | undefined
    return r && { id: r.id, createdAt: r.created_at, lastSeen: r.last_seen }
  }

  countAccounts(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
  }

  /** Accounts nobody has used for this long (no token, no request). */
  staleAccountIds(maxIdleSec: number): string[] {
    return (this.db.prepare('SELECT id FROM accounts WHERE last_seen < ?').all(now() - maxIdleSec) as Array<{ id: string }>).map(r => r.id)
  }

  accountIds(): string[] {
    return (this.db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>).map(r => r.id)
  }

  /** Erase an account and everything stored for it (tokens and docs cascade). */
  deleteAccount(id: string) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }

  // ── Tokens (only SHA-256 hashes are stored) ───────────────────────────
  issueToken(accountId: string, label = ''): string {
    const token = `tp_${randomBytes(32).toString('base64url')}`
    const t = now()
    this.db.prepare('INSERT INTO tokens (hash, account_id, label, created_at, last_used) VALUES (?, ?, ?, ?, ?)').run(sha256(token), accountId, label.slice(0, 60), t, t)
    return token
  }

  /** Account id for a token, or undefined. Touches last_used at most once a minute. */
  verifyToken(token: string): string | undefined {
    if (!token.startsWith('tp_') || token.length > 100) return undefined
    const hash = sha256(token)
    const r = this.db.prepare('SELECT account_id, last_used FROM tokens WHERE hash = ?').get(hash) as { account_id: string; last_used: number } | undefined
    if (!r) return undefined
    const t = now()
    if (t - r.last_used > 60) {
      this.db.prepare('UPDATE tokens SET last_used = ? WHERE hash = ?').run(t, hash)
      this.db.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(t, r.account_id)
    }
    return r.account_id
  }

  revokeToken(token: string) {
    this.db.prepare('DELETE FROM tokens WHERE hash = ?').run(sha256(token))
  }

  revokeAllTokens(accountId: string) {
    this.db.prepare('DELETE FROM tokens WHERE account_id = ?').run(accountId)
  }

  /** Drop tokens unused for this long (default 90 days). */
  pruneTokens(maxIdleSec = 90 * 86400) {
    return Number(this.db.prepare('DELETE FROM tokens WHERE last_used < ?').run(now() - maxIdleSec).changes)
  }

  // ── Documents ─────────────────────────────────────────────────────────
  readDoc(accountId: string, name: string): string | undefined {
    const r = this.db.prepare('SELECT data FROM docs WHERE account_id = ? AND name = ?').get(accountId, name) as { data: string } | undefined
    return r?.data
  }

  docNames(accountId: string): string[] {
    return (this.db.prepare('SELECT name FROM docs WHERE account_id = ?').all(accountId) as Array<{ name: string }>).map(r => r.name)
  }

  deleteDoc(accountId: string, name: string) {
    this.db.prepare('DELETE FROM docs WHERE account_id = ? AND name = ?').run(accountId, name)
  }

  writeDoc(accountId: string, name: string, data: string) {
    this.db
      .prepare('INSERT INTO docs (account_id, name, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(accountId, name, data, now())
  }

  /** A store for one account's document; `secret` docs are encrypted at rest. */
  store<T extends object>(accountId: string, name: string, defaults: T, secret = false): DbStore<T> {
    return new DbStore(this, accountId, name, defaults, secret)
  }
}

export class DbStore<T extends object> implements Store<T> {
  private data: T

  constructor(
    private readonly db: Database,
    private readonly accountId: string,
    private readonly name: string,
    defaults: T,
    private readonly secret: boolean,
  ) {
    const raw = db.readDoc(accountId, name)
    let parsed: Partial<T> = {}
    if (raw) parsed = JSON.parse(secret ? db.sealer.open(raw) : raw) as Partial<T>
    this.data = { ...structuredClone(defaults), ...parsed }
  }

  get(): Readonly<T> {
    return this.data
  }

  async update(mutator: (draft: T) => void): Promise<void> {
    mutator(this.data)
    const json = JSON.stringify(this.data)
    // The account may have been deleted meanwhile (the FK then refuses); that write is moot.
    try {
      this.db.writeDoc(this.accountId, this.name, this.secret ? this.db.sealer.seal(json) : json)
    } catch (err) {
      if (!/FOREIGN KEY/i.test((err as Error).message)) throw err
    }
  }

  async flush(): Promise<void> {}
}
