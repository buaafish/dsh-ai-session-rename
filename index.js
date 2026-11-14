/**
 * Host half of dsh-ai-session-rename.
 *
 * One operation, two entry points:
 *  - POST /api/ai-session-rename  -> returns a title generated from the session's own log
 *  - session_rename_ai tool       -> generates that title and applies it to the calling session
 *
 * Reading the log and generating the title are separate steps (`readSessionInput`
 * then `generateTitle`) so the Session is only touched inside the synchronous
 * inspect window, never after it.
 */

export const name = 'dsh-ai-session-rename'

export const inject = ['connection', 'llm', 'sessionQuery', 'tools']

const ROUTE_PATH = '/api/ai-session-rename'
const PURPOSE_LABEL = 'ai-session-rename'

/** Bounds keep the prompt cheap and the call predictable. */
const MAX_MESSAGES = 40
const MAX_MESSAGE_CHARS = 2000
const MAX_INPUT_BYTES = 24000
const MAX_OUTPUT_TOKENS = 96
const TIMEOUT_MS = 45000
const MAX_TITLE_CHARS = 24

const SYSTEM_PROMPT = [
  'You name a chat session from what it was about.',
  'Return only the title on one line, in plain text, in the language the user writes in.',
  'No quotes, no prefix, no explanation, no Markdown, no code, no emoji, no trailing punctuation.',
  'For Chinese, Japanese, or Korean aim for about 8 to 14 characters; otherwise aim for 3 to 6 words.',
  'Describe the concrete topic or task, never the act of chatting.',
].join('\n')

/** Text blocks of one message, as plain text. */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Human prompts only: `source.kind === 'user'` excludes injected context,
 * goal continuation rounds, and tool traffic.
 */
function userPrompts(messages) {
  const prompts = []
  for (const message of messages) {
    if (message?.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    const text = textOf(message)
    if (text.length === 0) continue
    prompts.push(text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text)
  }
  return prompts.slice(-MAX_MESSAGES)
}

/** Trim markdown/quote decoration models sometimes wrap a one-line answer in. */
function stripDecorations(input) {
  let text = String(input ?? '').trim()
  const LEADING = /^[#>*_\-`"'“”‘’「」『』【】[\]()（）。，．,.;；:：!！?？\s]+/u
  const TRAILING = /[#>*_\-`"'“”‘»』】[\]()（）。，．,.;；:：!！?？\s]+$/u
  for (let round = 0; round < 3; round += 1) {
    const before = text
    text = text.replace(LEADING, '').replace(TRAILING, '').trim()
    if (text === before) break
  }
  return text
}

/** First non-empty line, de-decorated, clamped to a readable length. */
function titleFromOutput(raw) {
  const line = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(part => part.trim())
    .find(part => part.length > 0)
  if (line === undefined) return undefined
  const title = stripDecorations(line)
  if (title.length === 0) return undefined
  const characters = [...title]
  return characters.length > MAX_TITLE_CHARS ? characters.slice(0, MAX_TITLE_CHARS).join('') : title
}

/** The route this session itself last used; the deployment default is the fallback. */
function routeOf(ctx, session) {
  const config = session.requestHeader()?.config
  if (config?.provider && config.model) {
    return { provider: config.provider, model: config.model }
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection?.provider && selection.model) {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/**
 * Read what generation needs from one live or prepared Session.
 * Synchronous on purpose: `sessionQuery.inspectSession` may only read inside
 * its getter's call, before the detached Session is released.
 * @returns `{ sessionId, prompts, route }`
 */
function readSessionInput(ctx, session) {
  return {
    sessionId: session.id,
    prompts: userPrompts(session.deriveMessages()),
    route: routeOf(ctx, session),
  }
}

/**
 * Generate one title from an already-read session input.
 * @returns `{ sessionId, title, provider, model }`
 */
async function generateTitle(ctx, input, signal) {
  if (input.prompts.length === 0) {
    throw new Error('this session has no user messages to name it from yet')
  }
  if (input.route === undefined) {
    throw new Error('no model route is recorded for this session and no default model is configured')
  }
  const framed = [
    'Generate the session title from this JSON array of human messages:',
    JSON.stringify(input.prompts, undefined, 2),
  ].join('\n')
  const inputBytes = Buffer.byteLength(framed, 'utf8')
  if (inputBytes > MAX_INPUT_BYTES) {
    throw new Error(`conversation excerpt is ${inputBytes} bytes, exceeding the ${MAX_INPUT_BYTES} byte limit`)
  }
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const call = await ctx.llm.prepareCall(
    { ...input.route, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 },
    combined,
    (controls, model) => {
      const effort = model.reasoning?.efforts?.[0]?.id
      return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
    },
  )
  const options = {
    ...call.config,
    messages: [{ role: 'user', content: [{ type: 'text', text: framed }] }],
    system: SYSTEM_PROMPT,
    sessionId: input.sessionId,
    signal: combined,
  }
  let text = ''
  let finish
  for await (const chunk of call.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  const kind = finish?.kind
  if (kind === 'aborted') throw new Error('title generation was cancelled')
  if (kind === 'error') throw new Error(finish?.failure?.message ?? 'title generation failed')
  if (kind === 'max-tokens') throw new Error('title generation hit the output token limit')
  if (kind === 'tool-calls') throw new Error('title generation must return text only')
  const title = titleFromOutput(text)
  if (title === undefined) throw new Error('the model returned an empty title')
  return { sessionId: input.sessionId, title, provider: call.config.provider, model: call.config.model }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function failure(error, status = 500) {
  const message = error instanceof Error ? error.message : String(error)
  return json({ error: { code: 'ai-session-rename/failed', message } }, status)
}

/** The one agent tool: rename the calling session from its own conversation. */
function renameTool(ctx) {
  return {
    name: 'session_rename_ai',
    description:
      'Rename the current session from its own conversation: reads your messages, asks the session model for a short title, and applies it. The new title is pinned as an explicit rename, so automatic titling stops for this session.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session id to rename. Omit to rename the calling session; any other id is rejected.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['sessionId', 'title'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: `Renamed the session to "${value.title}".` }]
      },
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('session_rename_ai needs a calling session')
      }
      const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
      if (requested.length > 0 && requested !== session.id) {
        throw new Error(`only the calling session can be renamed; refusing "${requested}"`)
      }
      const input = readSessionInput(ctx, session)
      const generated = await generateTitle(ctx, input, exec.signal)
      const titles = ctx.get('sessionTitle')
      if (titles === undefined) {
        throw new Error('this deployment mounts no session-title service')
      }
      const accepted = titles.rename(session, generated.title)
      return { sessionId: session.id, title: accepted.title }
    },
  }
}

/**
 * @param ctx - Host context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await request.json().catch(() => undefined)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId.length === 0) {
          return json({ error: { code: 'ai-session-rename/bad-request', message: 'sessionId is required' } }, 400)
        }
        const input = await ctx.sessionQuery.inspectSession(
          sessionId,
          session => readSessionInput(ctx, session),
          request.signal,
        )
        return json(await generateTitle(ctx, input, request.signal))
      } catch (error) {
        return failure(error)
      }
    },
  }), `${PURPOSE_LABEL}: POST ${ROUTE_PATH}`)

  ctx.effect(() => ctx.tools.register(renameTool(ctx)), `${PURPOSE_LABEL}: session_rename_ai tool`)
}
