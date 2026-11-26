import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Tiny durable JSON store. Writes are atomic (tmp file + rename) and
 * serialized so concurrent updates never interleave or corrupt the file.
 */
export class JsonStore<T extends object> implements Store<T> {
  private data!: T
  private chain: Promise<void> = Promise.resolve()
  private readonly file: string

  constructor(dir: string, name: string, private readonly defaults: T) {
    this.file = join(dir, `${name}.json`)
  }

  async load(): Promise<this> {
    await mkdir(dirname(this.file), { recursive: true })
    try {
      const raw = await readFile(this.file, 'utf8')
      this.data = { ...structuredClone(this.defaults), ...JSON.parse(raw) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.data = structuredClone(this.defaults)
    }
    return this
  }

  get(): Readonly<T> {
    return this.data
  }

  update(mutator: (draft: T) => void): Promise<void> {
    mutator(this.data)
    const snapshot = JSON.stringify(this.data, null, 2)
    this.chain = this.chain.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, this.file)
    })
    return this.chain
  }

  flush(): Promise<void> {
    return this.chain
  }
}

/** What every service needs from a store: read, mutate-and-persist, wait for writes. */
export interface Store<T extends object> {
  get(): Readonly<T>
  update(mutator: (draft: T) => void): Promise<void>
  flush(): Promise<void>
}

/** Non-persistent store (tests, the browser demo, a login that has not finished yet). */
export class MemoryStore<T extends object> implements Store<T> {
  private data: T
  constructor(defaults: T) {
    this.data = structuredClone(defaults)
  }
  get(): Readonly<T> {
    return this.data
  }
  async update(mutator: (draft: T) => void): Promise<void> {
    mutator(this.data)
  }
  async flush(): Promise<void> {}
}
