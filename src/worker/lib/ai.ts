// The writing assistant: drafts and rewrites emails and templates with
// whichever AI provider is configured on the AI page. Claude goes through the
// Anthropic SDK; anything else through an OpenAI-compatible /chat/completions.

import Anthropic from '@anthropic-ai/sdk'
import type { AiProvider, BodyFormat } from '../db/schema'

export const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-4o' } as const

// What a draft is for; it decides which placeholders and footers apply.
export const DRAFT_PURPOSES = ['email', 'reply', 'broadcast', 'template'] as const
export type DraftPurpose = (typeof DRAFT_PURPOSES)[number]

// A conversation about one email: the admin asks, the assistant answers with
// a draft, the admin asks for changes, and so on.
export type Turn = { role: 'user'; text: string } | { role: 'assistant'; draft: Draft }

export type DraftRequest = {
  purpose: DraftPurpose
  format: BodyFormat
  // The conversation so far, ending with what the admin just asked.
  turns: Turn[]
  // What was in the editor when the conversation started, to revise rather
  // than start over.
  current?: { subject?: string; body?: string }
  // The email being answered, for a reply.
  context?: string
  // Who the email is from: the domain's brand and what it says about itself.
  writer?: { brand: string; about: string }
}
export type Draft = { subject: string; body: string }
export type AiResult<T> = { ok: true; value: T } | { ok: false; error: string; message: string }

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'The subject line, without a "Subject:" prefix.' },
    body: { type: 'string', description: 'The complete email body, in the requested format.' },
  },
  required: ['subject', 'body'],
  additionalProperties: false,
}

const system = (r: DraftRequest) =>
  [
    `You write emails for ${r.writer?.brand || 'a small business'}. The person asking runs it, and will read your draft, edit it and send it under their own name. The emails should read like a real person wrote them: direct, warm without being effusive, specific, and free of marketing filler.`,
    r.writer?.about ? `About the sender, in their own words:\n<about>\n${r.writer.about}\n</about>` : '',
    `Write in the language of the request (or, for a reply, the language of the email being answered) unless asked otherwise.`,
    r.format === 'html'
      ? `The body is HTML for email clients, which support far less than browsers. Give a fragment (no <html>, <head> or <body>), with all styling in inline style attributes, a single column at most 600px wide, system fonts, and nothing that needs scripts, external stylesheets, web fonts or media queries. Do not include images unless the request gives you their URLs. Aim for a clean, restrained design rather than a heavily decorated one: the content should carry the email.`
      : `The body is plain text: no Markdown, no HTML. Separate paragraphs with a blank line and write links as bare URLs.`,
    r.purpose === 'broadcast' || r.purpose === 'template'
      ? `This goes to a list of subscribers, one email each. You can address each person with the placeholders {{first_name}}, {{last_name}} and {{email}}, which are filled in per recipient; a first name is often missing, so phrase greetings to still read naturally when {{first_name}} is empty. An unsubscribe footer is added to every email automatically, so do not write one. If the design needs the unsubscribe link in a particular place, use {{unsubscribe_url}} as its address and the automatic footer is left off.`
      : `This is a one-to-one email, so there are no placeholders: write out anything specific, and where you lack a fact (a name, a date, a link) leave an obvious [bracketed note] for the owner to fill in rather than inventing it.`,
    r.purpose === 'reply'
      ? `You are drafting the owner's answer to the email given below. Write only the new text; the original is quoted underneath automatically, and the subject line is kept, so return the subject unchanged or empty.`
      : '',
    `The conversation may continue: when asked for a change, return the whole email again with the change made, not just the changed part.`,
    `Return the subject and the body as the two fields of the response, and nothing else.`,
  ]
    .filter(Boolean)
    .join('\n\n')

// The first request carries what the draft is about; later ones are just the
// admin's words. The assistant's earlier drafts go back as the JSON it gave.
const messages = (r: DraftRequest): { role: 'user' | 'assistant'; content: string }[] =>
  r.turns.map((turn, i) =>
    turn.role === 'assistant'
      ? { role: 'assistant', content: JSON.stringify(turn.draft) }
      : {
          role: 'user',
          content:
            i > 0
              ? turn.text
              : [
                  r.context && `The email being answered:\n<email>\n${r.context}\n</email>`,
                  (r.current?.subject || r.current?.body) &&
                    `The current draft, which the request below is about:\n<draft>\n${r.current.subject ? `Subject: ${r.current.subject}\n\n` : ''}${r.current.body ?? ''}\n</draft>`,
                  `The request:\n${turn.text}`,
                ]
                  .filter(Boolean)
                  .join('\n\n'),
        },
  )

// Models that take the server-side refusal fallback.
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1|sonnet-5-5)/
// Models with adaptive thinking, whose summary can be shown.
const THINKING_MODELS = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|haiku-5|fable|mythos)/

type Ask = { system: string; messages: { role: 'user' | 'assistant'; content: string }[]; schema?: Record<string, unknown> }
// Called as the answer arrives: the model's reasoning, and the answer itself.
type Progress = { onThinking?: (delta: string) => void; onText?: (delta: string) => void }

const viaAnthropic = async (provider: AiProvider, apiKey: string, r: Ask, progress: Progress = {}): Promise<AiResult<string>> => {
  const client = new Anthropic({ apiKey, baseURL: provider.baseUrl || undefined, maxRetries: 1 })
  const fallback = !provider.baseUrl && FALLBACK_MODELS.test(provider.model)
  try {
    // Streamed: the reasoning is shown as it comes, and a long draft cannot
    // run into an HTTP timeout.
    const stream = client.beta.messages.stream({
      model: provider.model,
      max_tokens: 32000,
      system: r.system,
      messages: r.messages,
      // A readable summary of the reasoning; by default it would come back empty.
      ...(THINKING_MODELS.test(provider.model) && { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }),
      ...(r.schema && { output_config: { format: { type: 'json_schema' as const, schema: r.schema } } }),
      // If the model declines, Anthropic re-runs the request on its recommended substitute.
      ...(fallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    })
    if (progress.onThinking) stream.on('thinking', progress.onThinking)
    if (progress.onText) stream.on('text', progress.onText)
    const message = await stream.finalMessage()
    if (message.stop_reason === 'refusal') return { ok: false, error: 'ai_refused', message: message.stop_details?.explanation || 'The model declined this request.' }
    if (message.stop_reason === 'max_tokens') return { ok: false, error: 'ai_too_long', message: 'The draft was cut off; ask for something shorter.' }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    return text ? { ok: true, value: text } : { ok: false, error: 'ai_empty', message: 'The model returned nothing.' }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'ai_auth', message: 'The API key was rejected.' }
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'ai_auth', message: err.message }
    if (err instanceof Anthropic.NotFoundError) return { ok: false, error: 'ai_model', message: `Model "${provider.model}" was not found.` }
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: 'ai_rate_limited', message: 'Rate limited; try again in a moment.' }
    if (err instanceof Anthropic.APIError) return { ok: false, error: 'ai_error', message: `${err.status ?? ''} ${err.message}`.trim() }
    return { ok: false, error: 'ai_unreachable', message: String(err) }
  }
}

type OpenAiDelta = { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }

const viaOpenAi = async (provider: AiProvider, apiKey: string, r: Ask, progress: Progress = {}): Promise<AiResult<string>> => {
  const base = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        stream: true,
        messages: [
          // Compatible services differ in what structured-output options they
          // accept, so the shape is asked for in words and parsed leniently.
          { role: 'system', content: r.schema ? `${r.system}\n\nRespond with a single JSON object with the string fields "subject" and "body", and no other text.` : r.system },
          ...r.messages,
        ],
      }),
    })
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null
      const detail = typeof data?.error === 'string' ? data.error : data?.error?.message
      const error = res.status === 401 || res.status === 403 ? 'ai_auth' : res.status === 404 ? 'ai_model' : res.status === 429 ? 'ai_rate_limited' : 'ai_error'
      return { ok: false, error, message: `${res.status} ${detail || res.statusText}`.trim() }
    }

    // Server-sent events: "data: {json}" lines, ending with "data: [DONE]".
    let text = ''
    let buffer = ''
    const decoder = new TextDecoder()
    const take = (line: string) => {
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') return
      try {
        const delta = (JSON.parse(payload) as { choices?: { delta?: OpenAiDelta }[] }).choices?.[0]?.delta
        // Reasoning models report their thinking under one of these names.
        const thinking = delta?.reasoning_content ?? delta?.reasoning
        if (thinking) progress.onThinking?.(thinking)
        if (delta?.content) {
          text += delta.content
          progress.onText?.(delta.content)
        }
      } catch {
        // A keep-alive or a partial line; nothing to read.
      }
    }
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(take)
    }
    take(buffer)
    return text ? { ok: true, value: text } : { ok: false, error: 'ai_empty', message: 'The model returned nothing.' }
  } catch (err) {
    return { ok: false, error: 'ai_unreachable', message: String(err) }
  }
}

const run = (provider: AiProvider, apiKey: string, r: Ask, progress?: Progress) =>
  provider.kind === 'anthropic' ? viaAnthropic(provider, apiKey, r, progress) : viaOpenAi(provider, apiKey, r, progress)

// The JSON object in a model's answer, tolerating a code fence or stray text around it.
const parseDraft = (text: string): Draft | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Partial<Draft>
    return typeof value.body === 'string' ? { subject: typeof value.subject === 'string' ? value.subject : '', body: value.body } : null
  } catch {
    return null
  }
}

export const draftEmail = async (provider: AiProvider, apiKey: string, request: DraftRequest, progress?: Progress): Promise<AiResult<Draft>> => {
  const result = await run(provider, apiKey, { system: system(request), messages: messages(request), schema: DRAFT_SCHEMA }, progress)
  if (!result.ok) return result
  const draft = parseDraft(result.value)
  return draft ? { ok: true, value: draft } : { ok: false, error: 'ai_bad_response', message: 'The model did not answer in the expected format; try again.' }
}

// A minimal request, to check a provider's key, endpoint and model.
export const testProvider = (provider: AiProvider, apiKey: string) =>
  run(provider, apiKey, { system: 'You are a connection test.', messages: [{ role: 'user', content: 'Reply with the single word OK.' }] })
