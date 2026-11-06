/** Small shared helpers: bounded file logging, text extraction, chunking. */
import fs from 'node:fs'
import path from 'node:path'

const LOG_LIMIT = 2 * 1024 * 1024

/** Append-only logger capped at LOG_LIMIT bytes, truncating the file when it grows past the cap. */
export function createLogger(file) {
  let ready = false
  const ensure = () => {
    if (ready) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    ready = true
  }
  const write = (level, scope, detail) => {
    const line = `${new Date().toISOString()} [${level}] ${scope}${detail ? ` ${detail}` : ''}\n`
    try {
      ensure()
      try {
        if (fs.statSync(file).size > LOG_LIMIT) fs.truncateSync(file, 0)
      } catch {}
      fs.appendFileSync(file, line)
    } catch {}
    if (level === 'error' || level === 'warn') console.warn(`[feishu-bridge] ${scope} ${detail ?? ''}`)
  }
  return (scope, detail, level = 'info') => write(level, scope, detail)
}

/** Visible answer text of one assistant/tool message. Reasoning blocks stay local. */
export function textOfMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/** Split long answers at line boundaries so each Feishu message stays readable. */
export function chunkText(text, limit = 3200) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!body) return []
  if (body.length <= limit) return [body]
  const chunks = []
  let rest = body
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks.filter(Boolean)
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}m${rest ? `${rest}s` : ''}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
}

export function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
