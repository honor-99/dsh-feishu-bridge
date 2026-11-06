/**
 * lark-cli transport: one supervised long-connection consumer for inbound bot
 * events, plus one-shot CLI calls for outbound messages.
 *
 * The consumer is the only long-lived child; it is restarted with exponential
 * backoff so a dropped Feishu connection heals without restarting the Host.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { errorText } from './util.js'

const MESSAGE_KEY = 'im.message.receive_v1'
const CARD_KEY = 'card.action.trigger'
const RESTART_BASE_MS = 1000
const RESTART_MAX_MS = 30000

/** Inbound event keys this client supervises; card clicks are optional. */
function consumeKeys(config) {
  if (Array.isArray(config?.consumeKeys) && config.consumeKeys.length > 0) return [...new Set(config.consumeKeys)]
  const keys = [MESSAGE_KEY]
  if (config?.cardButtons !== false) keys.push(CARD_KEY)
  return keys
}

/**
 * Locate the CLI without machine-specific config:
 * 1. explicit nodePath + cliScript;
 * 2. cliScript alone, run with this process's node;
 * 3. cliCommand on PATH, preferring the packaged `@larksuite/cli` entry so the
 *    child never goes through cmd.exe quoting on Windows.
 */
let cachedLaunch

export function resolveLaunch(config) {
  if (cachedLaunch) return cachedLaunch
  if (config.nodePath && config.cliScript) {
    cachedLaunch = { nodePath: config.nodePath, script: config.cliScript }
    return cachedLaunch
  }
  if (config.cliScript) {
    cachedLaunch = { nodePath: process.execPath, script: config.cliScript }
    return cachedLaunch
  }
  const found = locateOnPath(config.cliCommand)
  if (found) {
    const script = packagedEntry(found)
    if (script) {
      cachedLaunch = { nodePath: process.execPath, script }
      return cachedLaunch
    }
    cachedLaunch = { command: found }
    return cachedLaunch
  }
  cachedLaunch = { command: config.cliCommand }
  return cachedLaunch
}

function locateOnPath(command) {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    const result = spawnSync(probe, [command], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) return undefined
    const first = String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return first || undefined
  } catch {
    return undefined
  }
}

function packagedEntry(executable) {
  try {
    const directory = path.dirname(executable)
    const entry = path.join(directory, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js')
    return fs.existsSync(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

export class LarkClient {
  constructor(config, log) {
    this.config = config
    this.log = log
    /** One supervised consumer per event key. */
    this.children = new Map()
    this.restartTimers = new Map()
    this.backoffs = new Map()
    this.lastStderr = new Map()
    /** Keys the console refuses to deliver; retrying cannot fix a missing subscription. */
    this.disabled = new Set()
    /** key -> 'starting' | 'ready' | 'restarting' | 'disabled'. */
    this.states = new Map()
    this.stopping = false
    this.onEvent = null
  }

  /** Per-key consumer health, for `/status` and the first-run welcome. */
  health() {
    return consumeKeys(this.config).map((key) => ({ key, state: this.states.get(key) ?? 'unknown' }))
  }

  /** What the CLI is actually bound to right now (application, workspace). */
  async describeIdentity() {
    try {
      const result = await this.call(['config', 'show'], 20000)
      if (!result || typeof result !== 'object') return undefined
      return {
        appId: typeof result.appId === 'string' ? result.appId : undefined,
        workspace: typeof result.workspace === 'string' ? result.workspace : undefined,
        profile: typeof result.profile === 'string' ? result.profile : undefined,
      }
    } catch (error) {
      this.log('lark.identity.failed', errorText(error), 'warn')
      return undefined
    }
  }

  /**
   * Spawn the CLI either through a resolved node+script pair or through PATH.
   * `stdin: 'pipe'` keeps a live stdin for the long-running consumer: the CLI
   * treats stdin EOF as a stop signal, so it must stay open for the session.
   */
  launch(args, options = {}) {
    const stdio = [options.stdin ?? 'ignore', 'pipe', 'pipe']
    const env = process.env
    const spawnOptions = { windowsHide: true, stdio, env, ...(options.cwd ? { cwd: options.cwd } : {}) }
    const target = resolveLaunch(this.config)
    if (target.script) {
      return spawn(target.nodePath ?? process.execPath, [target.script, ...args], spawnOptions)
    }
    return spawn(target.command, args, {
      ...spawnOptions,
      shell: process.platform === 'win32',
    })
  }

  startConsume(onEvent) {
    this.onEvent = onEvent
    this.stopping = false
    this.disabled.clear()
    for (const key of consumeKeys(this.config)) this.spawnConsume(key)
  }

  spawnConsume(key) {
    if (this.stopping || !this.onEvent) return
    if (this.disabled.has(key)) {
      this.states.set(key, 'disabled')
      return
    }
    this.states.set(key, 'starting')
    const args = ['event', 'consume', key, '--as', this.config.identity]
    this.log('lark.consume.start', args.join(' '))
    let child
    try {
      child = this.launch(args, { stdin: 'pipe' })
    } catch (error) {
      this.log('lark.consume.spawn-failed', `${key} ${errorText(error)}`, 'error')
      this.scheduleRestart(key)
      return
    }
    this.children.set(key, child)
    // Hold stdin open for the lifetime of the consumer; ignore EPIPE on shutdown.
    child.stdin?.on('error', () => {})

    child.stdout?.setEncoding('utf8')
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (raw) => this.onLine(key, raw))

    child.stderr?.setEncoding('utf8')
    child.stderr.on('data', (data) => {
      const text = String(data).trim()
      if (!text) return
      // Keep the whole hint when it carries a console-subscription URL.
      const detail = text.includes('requires callbacks') ? text.slice(0, 2000) : text.slice(0, 800)
      this.lastStderr.set(key, detail)
      if (text.includes('ready event_key=')) this.states.set(key, 'ready')
      else if (text.includes('listening for events')) this.states.set(key, 'ready')
      else if (text.includes('requires callbacks')) this.states.set(key, 'disabled')
      this.log('lark.consume.stderr', `[${key}] ${detail}`)
    })
    child.on('error', (error) => this.log('lark.consume.error', `${key} ${errorText(error)}`, 'error'))
    child.on('exit', (code, signal) => {
      if (this.children.get(key) === child) this.children.delete(key)
      this.log('lark.consume.exit', `${key} code=${code} signal=${signal ?? ''}`)
      if (this.stopping) return
      const stderr = this.lastStderr.get(key) ?? ''
      if (code === 2 && stderr.includes('requires callbacks')) {
        // A missing console subscription never heals by retrying; stop this key
        // and keep the rest of the bridge running.
        this.disabled.add(key)
        this.states.set(key, 'disabled')
        this.log('lark.consume.disabled', `${key} needs a console callback subscription; not retrying`)
        return
      }
      this.states.set(key, 'restarting')
      this.scheduleRestart(key)
    })
  }

  onLine(key, raw) {
    const line = raw.trim()
    if (!line) return
    if (!line.startsWith('{')) {
      this.log('lark.consume.notice', `${key} ${line.slice(0, 300)}`)
      return
    }
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      this.log('lark.consume.bad-json', `${key} ${line.slice(0, 300)}`, 'warn')
      return
    }
    this.backoffs.set(key, RESTART_BASE_MS)
    try {
      this.onEvent?.(payload, key)
    } catch (error) {
      this.log('lark.consume.handler-failed', `${key} ${errorText(error)}`, 'error')
    }
  }

  scheduleRestart(key) {
    if (this.stopping || this.restartTimers.has(key)) return
    const current = this.backoffs.get(key) ?? RESTART_BASE_MS
    const delay = current
    this.backoffs.set(key, Math.min(current * 2, RESTART_MAX_MS))
    this.log('lark.consume.restart', `${key} in ${delay}ms`)
    const timer = setTimeout(() => {
      this.restartTimers.delete(key)
      this.spawnConsume(key)
    }, delay)
    timer.unref?.()
    this.restartTimers.set(key, timer)
  }

  async stop() {
    this.stopping = true
    this.onEvent = null
    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    this.restartTimers.clear()
    const children = [...this.children.values()]
    this.children.clear()
    // Graceful first: the CLI documents stdin EOF as its stop signal, and a hard
    // kill skips cleanup, which can leak the server-side subscription.
    for (const child of children) {
      try {
        child.stdin?.end()
      } catch {}
    }
    if (children.length > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000)
        timer.unref?.()
      })
    }
    for (const child of children) {
      try {
        child.kill()
      } catch {}
    }
  }

  /** Run one CLI command to completion and parse its JSON stdout. */
  call(args, timeoutMs = 60000, options = {}) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = this.launch(args, options)
      } catch (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        reject(new Error(`lark-cli timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (data) => {
        stdout += data
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (data) => {
        stderr += data
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`lark-cli exit=${code} ${stderr.trim().slice(0, 300)}`))
          return
        }
        const text = stdout.trim()
        if (!text) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve({ ok: true, raw: text })
        }
      })
    })
  }

  /**
   * Fetch one message attachment into `directory`, which must already exist.
   * `--output` is cwd-relative, so the child runs inside that directory and the
   * result is discovered by listing it afterwards (the CLI's path field varies
   * by version).
   */
  async downloadResource(messageId, fileKey, type, directory) {
    const safeType = type === 'image' ? 'image' : 'file'
    const result = await this.call(
      [
        'im',
        '+messages-resources-download',
        '--as',
        this.config.identity,
        '--message-id',
        messageId,
        '--file-key',
        fileKey,
        '--type',
        safeType,
        '--output',
        `${safeType}-${String(fileKey).replace(/[^A-Za-z0-9_-]/g, '_')}`,
        '--format',
        'json',
      ],
      60000,
      { cwd: directory },
    )
    let files = []
    try {
      files = fs.readdirSync(directory).map((name) => path.join(directory, name))
    } catch {
      files = []
    }
    if (files.length === 0) {
      throw new Error(`download returned no file (${fileKey})`)
    }
    files.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
      } catch {
        return 0
      }
    })
    return { path: files[0], result }
  }
}
