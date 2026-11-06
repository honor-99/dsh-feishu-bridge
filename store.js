/** Durable chat -> Session binding, stored as one JSON file next to the DSH home. */
import fs from 'node:fs'
import path from 'node:path'

const VERSION = 1

export class ChatStore {
  constructor(file) {
    this.file = file
    this.data = { version: VERSION, chats: {} }
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object') {
        this.data = { version: VERSION, chats: parsed.chats }
      }
    } catch {
      // A missing or unreadable state file simply starts empty.
    }
  }

  save() {
    const directory = path.dirname(this.file)
    fs.mkdirSync(directory, { recursive: true })
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }

  get(key) {
    return this.data.chats[key]
  }

  set(key, entry) {
    this.data.chats[key] = { ...entry, updatedAt: Date.now() }
    this.save()
  }

  touch(key) {
    const entry = this.data.chats[key]
    if (!entry) return
    entry.updatedAt = Date.now()
    this.save()
  }

  remove(key) {
    if (!this.data.chats[key]) return false
    delete this.data.chats[key]
    this.save()
    return true
  }

  list() {
    return Object.entries(this.data.chats).map(([key, entry]) => ({ key, ...entry }))
  }
}
