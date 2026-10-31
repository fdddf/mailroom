// Writing an email body: plain text or HTML with a preview, a template to
// start from, and the AI writing assistant.
import { Alert, Anchor, Button, Checkbox, Drawer, Group, Loader, Paper, ScrollArea, SegmentedControl, Select, Stack, Text, Textarea, UnstyledButton } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { IconChevronRight, IconSparkles, IconTemplate } from '@tabler/icons-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ApiError, api, call, errorText, stream } from '../api'
import { useSession } from '../hooks'
import { HtmlFrame } from './mail'
import { VisualEditor } from './VisualEditor'
import classes from '../dashboard.module.css'

export type BodyFormat = 'text' | 'html'
export type Draft = { subject: string; body: string; format: BodyFormat }
type Purpose = 'email' | 'reply' | 'broadcast' | 'template'

// The message field: text, or HTML edited visually, as source, or previewed.
type HtmlView = 'visual' | 'source' | 'preview'
export function BodyEditor({
  label = 'Message',
  description,
  format,
  onFormat,
  value,
  onChange,
  minRows = 10,
  tools,
  onSubmit,
}: {
  label?: string
  description?: ReactNode
  format: BodyFormat
  onFormat: (format: BodyFormat) => void
  value: string
  onChange: (value: string) => void
  minRows?: number
  // Buttons shown beside the format switch (template picker, AI).
  tools?: ReactNode
  onSubmit?: () => void
}) {
  const [view, setView] = useState<HtmlView>('visual')
  const html = format === 'html'
  return (
    <Stack gap={6}>
      <Group justify="space-between" align="flex-end" gap="xs" wrap="wrap">
        <div>
          <Text size="sm" fw={500}>
            {label}
          </Text>
          {description && (
            <Text size="xs" c="dimmed">
              {description}
            </Text>
          )}
        </div>
        <Group gap="xs">
          {tools}
          {html && (
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(v) => setView(v as HtmlView)}
              data={[
                { value: 'visual', label: 'Visual' },
                { value: 'source', label: 'Source' },
                { value: 'preview', label: 'Preview' },
              ]}
            />
          )}
          <SegmentedControl
            size="xs"
            value={format}
            onChange={(v) => {
              onFormat(v as BodyFormat)
            }}
            data={[
              { value: 'text', label: 'Plain text' },
              { value: 'html', label: 'HTML' },
            ]}
          />
        </Group>
      </Group>
      {html && view === 'visual' ? (
        <VisualEditor value={value} onChange={onChange} />
      ) : html && view === 'preview' ? (
        <HtmlFrame html={value} remoteImages />
      ) : (
        <Textarea
          aria-label={label}
          autosize
          minRows={minRows}
          maxRows={32}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          classNames={html ? { input: classes.code } : undefined}
          spellCheck={!html}
          onKeyDown={(e) => {
            if (onSubmit && (e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit()
          }}
        />
      )}
    </Stack>
  )
}

// Fill the editor from a saved template.
export function TemplatePicker({ onApply }: { onApply: (draft: Draft) => void }) {
  const list = useQuery({ queryKey: ['templates'], queryFn: () => call(api.templates.$get()) })
  const load = useMutation({
    mutationFn: (id: string) => call(api.templates[':id'].$get({ param: { id } })),
    onSuccess: (t) => onApply({ subject: t.subject, body: t.body, format: t.format }),
  })
  const items = list.data?.items ?? []
  if (!items.length) return null
  return (
    <Select
      size="xs"
      w={200}
      aria-label="Start from a template"
      placeholder="Use a template…"
      leftSection={<IconTemplate size={14} />}
      data={items.map((t) => ({ value: String(t.id), label: t.name }))}
      // Always back to the placeholder: picking is an action, not a setting.
      value={null}
      onChange={(id) => id && load.mutate(id)}
      disabled={load.isPending}
      searchable={items.length > 8}
    />
  )
}

// One exchange with the assistant.
type Exchange = {
  ask: string
  thinking: string
  // Characters of the draft written so far, while it is still arriving.
  progress: number
  draft?: { subject: string; body: string }
  provider?: string
  error?: string
}

// The writing assistant, as a conversation in a drawer beside the editor: ask
// for an email, read the model's reasoning and its draft, ask for changes.
// Nothing reaches the editor until "Use this" is pressed, and nothing is sent
// or saved by it.
export function AiAssist({
  purpose,
  format,
  current,
  context,
  onApply,
  size = 'xs',
}: {
  purpose: Purpose
  format: BodyFormat
  current?: { subject?: string; body?: string }
  context?: string
  onApply: (draft: { subject: string; body: string }) => void
  size?: 'xs' | 'sm'
}) {
  const { data: session } = useSession()
  const providers = session?.aiProviders ?? []
  const [opened, { open, close }] = useDisclosure()
  const [input, setInput] = useState('')
  const [providerId, setProviderId] = useState<string | null>(null)
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  // The editor's content when the conversation began; later turns build on
  // the assistant's own drafts instead.
  const startedFrom = useRef<typeof current>(undefined)
  const hasDraft = Boolean(current?.body?.trim())
  const [revise, setRevise] = useState(true)
  const bottom = useRef<HTMLDivElement>(null)
  const scroll = () => requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }))

  const patchLast = (change: (last: Exchange) => Exchange) => setExchanges((all) => all.map((e, i) => (i === all.length - 1 ? change(e) : e)))

  const ask = async () => {
    const text = input.trim()
    if (!text || busy) return
    const earlier = exchanges.filter((e) => e.draft)
    if (!earlier.length) startedFrom.current = hasDraft && revise ? current : undefined
    setExchanges([...earlier, { ask: text, thinking: '', progress: 0 }])
    setInput('')
    setBusy(true)
    scroll()
    const controller = new AbortController()
    abort.current = controller
    try {
      await stream(
        '/api/admin/ai/draft',
        {
          providerId: providerId ? Number(providerId) : undefined,
          purpose,
          format,
          context,
          current: startedFrom.current,
          turns: [...earlier.flatMap((e) => [{ role: 'user', text: e.ask }, { role: 'assistant', draft: e.draft }]), { role: 'user', text }],
        },
        (event, data) => {
          if (event === 'thinking') patchLast((e) => ({ ...e, thinking: e.thinking + (data as string) }))
          else if (event === 'progress') patchLast((e) => ({ ...e, progress: data as number }))
          else if (event === 'done') {
            const { provider, ...draft } = data as { subject: string; body: string; provider: string }
            patchLast((e) => ({ ...e, draft, provider }))
          } else if (event === 'error') {
            const { error, message } = data as { error: string; message?: string }
            patchLast((e) => ({ ...e, error: errorText(new ApiError(error, 424, message)) }))
          }
          scroll()
        },
        controller.signal,
      )
      // A stream that ended without a verdict (a dropped connection).
      patchLast((e) => (e.draft || e.error ? e : { ...e, error: 'The answer was cut off. Try again.' }))
    } catch (err) {
      const stopped = (err as Error).name === 'AbortError'
      patchLast((e) => ({ ...e, error: stopped ? 'Stopped.' : errorText(err) }))
    } finally {
      setBusy(false)
      abort.current = null
      scroll()
    }
  }

  const last = exchanges.at(-1)
  const following = exchanges.some((e) => e.draft)

  return (
    <>
      <Button size={size} variant="light" leftSection={<IconSparkles size={14} />} onClick={open}>
        {purpose === 'reply' ? 'Draft with AI' : 'Write with AI'}
      </Button>
      {/* No overlay and no focus trap: the editor beside it stays usable. */}
      <Drawer
        opened={opened}
        onClose={close}
        position="left"
        size={520}
        title="Write with AI"
        withOverlay={false}
        closeOnClickOutside={false}
        lockScroll={false}
        trapFocus={false}
        shadow="xl"
        styles={{ body: { display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 60px)', paddingBottom: 12 }, content: { borderRight: '1px solid var(--mantine-color-default-border)' } }}
      >
        {providers.length === 0 ? (
          <Stack>
            <Text size="sm">No AI provider is set up yet. Add a Claude or OpenAI-compatible API key first.</Text>
            <Button component={Link} to="/ai" onClick={close} w="fit-content">
              Set up AI
            </Button>
          </Stack>
        ) : (
          <>
            <ScrollArea style={{ flex: 1 }} offsetScrollbars type="auto">
              <Stack gap="md" pb="sm">
                {exchanges.length === 0 && (
                  <Text size="sm" c="dimmed">
                    {purpose === 'reply'
                      ? 'Say what the reply should get across; the email you are answering is included. Then ask for changes until it reads right.'
                      : 'Describe the email: who it is for, what it announces or asks, the tone. Then ask for changes until it reads right.'}
                  </Text>
                )}
                {exchanges.map((e, i) => {
                  const pending = busy && i === exchanges.length - 1
                  return (
                    <Stack key={i} gap="xs">
                      <Paper p="xs" px="sm" radius="md" bg="var(--mantine-primary-color-light)" ml="xl" style={{ alignSelf: 'flex-end', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        <Text size="sm">{e.ask}</Text>
                      </Paper>
                      {(e.thinking || pending) && <Thinking text={e.thinking} live={pending && !e.progress} />}
                      {pending && e.progress > 0 && (
                        <Group gap="xs">
                          <Loader size="xs" />
                          <Text size="xs" c="dimmed">
                            Writing… {e.progress.toLocaleString()} characters
                          </Text>
                        </Group>
                      )}
                      {e.error && <Alert color={e.error === 'Stopped.' ? 'gray' : 'red'} p="xs">{e.error}</Alert>}
                      {e.draft && (
                        <Paper withBorder p="sm" radius="md">
                          <Stack gap="xs">
                            {purpose !== 'reply' && e.draft.subject && (
                              <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
                                {e.draft.subject}
                              </Text>
                            )}
                            {format === 'html' ? <HtmlFrame html={e.draft.body} remoteImages /> : <pre className={`${classes.body} ${classes.draft}`}>{e.draft.body}</pre>}
                            <Group justify="space-between" gap="xs">
                              <Text size="xs" c="dimmed">
                                {e.provider}
                              </Text>
                              <Button size="xs" onClick={() => onApply(e.draft!)}>
                                Use this
                              </Button>
                            </Group>
                          </Stack>
                        </Paper>
                      )}
                    </Stack>
                  )
                })}
                <div ref={bottom} />
              </Stack>
            </ScrollArea>

            <Stack gap={6} pt="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
              <Textarea
                aria-label="Your request"
                placeholder={
                  following
                    ? 'Ask for a change: shorter, warmer, add a discount code…'
                    : purpose === 'reply'
                      ? 'e.g. Thank them, say the fix ships in 2.3 next week, offer a refund meanwhile'
                      : 'e.g. Announce AppShots 2.0: batch export and new device frames, 30% off this week'
                }
                autosize
                minRows={2}
                maxRows={8}
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ask()
                }}
              />
              <Group justify="space-between" gap="xs">
                <Group gap="sm">
                  {!following && hasDraft && <Checkbox size="xs" label="Start from the current draft" checked={revise} onChange={(e) => setRevise(e.currentTarget.checked)} />}
                  {providers.length > 1 && (
                    <Select
                      size="xs"
                      w={170}
                      aria-label="AI provider"
                      data={providers.map((p) => ({ value: String(p.id), label: p.name }))}
                      value={providerId ?? String(providers.find((p) => p.isDefault)?.id ?? providers[0]!.id)}
                      onChange={setProviderId}
                      allowDeselect={false}
                    />
                  )}
                  {exchanges.length > 0 && !busy && (
                    <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setExchanges([])}>
                      New conversation
                    </Button>
                  )}
                </Group>
                {busy ? (
                  <Button variant="default" onClick={() => abort.current?.abort()}>
                    Stop
                  </Button>
                ) : (
                  <Button onClick={ask} disabled={!input.trim()} leftSection={<IconSparkles size={16} />}>
                    {following ? 'Revise' : last?.error ? 'Try again' : 'Write'}
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                Read a draft before sending: check names, dates, prices and links.
              </Text>
            </Stack>
          </>
        )}
      </Drawer>
    </>
  )
}

// The model's reasoning: open while it is thinking, folded away afterwards.
function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = live || open
  return (
    <div className={classes.thinking}>
      <UnstyledButton onClick={() => setOpen((v) => !v)} disabled={live} w="100%">
        <Group gap={6}>
          {live ? <Loader size={12} /> : <IconChevronRight size={12} style={{ transform: shown ? 'rotate(90deg)' : undefined }} />}
          <Text size="xs" c="dimmed" fw={600}>
            {live ? 'Thinking…' : text ? 'Thinking' : 'No reasoning was shared'}
          </Text>
        </Group>
      </UnstyledButton>
      {shown && text && <pre className={classes.thinkingText}>{text}</pre>}
    </div>
  )
}

export function NoProviderHint() {
  return (
    <Text size="xs" c="dimmed">
      Want help writing? <Anchor component={Link} to="/ai" size="xs">Set up an AI provider</Anchor>.
    </Text>
  )
}
