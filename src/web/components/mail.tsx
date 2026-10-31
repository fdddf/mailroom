// Email rendering and the reply box. Anything from a customer or an email is
// rendered as text by React; HTML bodies only ever go into a sandboxed iframe
// (no allow-scripts, no allow-same-origin), with remote images blocked until
// asked for.
import { Anchor, Badge, Box, Button, Group, Paper, Select, Stack, Text, Textarea } from '@mantine/core'
import { getHotkeyHandler } from '@mantine/hooks'
import { IconPaperclip } from '@tabler/icons-react'
import { useState } from 'react'
import { fmtFull, type Session } from '../hooks'
import { AiAssist } from './editor'
import { DeliveryBadge } from './ui'
import classes from '../dashboard.module.css'

export type MailView = {
  id: number
  direction: 'in' | 'out'
  mailbox?: string
  createdAt: string
  fromAddr: string
  toAddrs: string[]
  ccAddrs: string[]
  subject: string
  text: string | null
  hasHtml: boolean
  attachments: { id: string; filename: string | null; size: number }[]
  status: string
}

// srcdoc for HTML we have in hand (sent mail, broadcasts) or a URL served
// with its own sandbox CSP (received mail).
export function HtmlFrame({ src, html, remoteImages = false }: { src?: string; html?: string | null; remoteImages?: boolean }) {
  const csp = `default-src 'none'; img-src data: ${remoteImages ? 'https:' : ''}; style-src 'unsafe-inline'; font-src data:`
  return (
    <iframe
      className={classes.frame}
      title="Email content"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      src={src}
      srcDoc={
        src
          ? undefined
          : `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">${html ?? ''}`
      }
    />
  )
}

function ReceivedHtml({ id, inline }: { id: number; inline: boolean }) {
  const [shown, setShown] = useState(inline)
  const [images, setImages] = useState(false)
  if (!shown) {
    return (
      <Button variant="subtle" size="compact-sm" onClick={() => setShown(true)} w="fit-content">
        Show HTML version
      </Button>
    )
  }
  return (
    <Stack gap={6}>
      <Group gap="sm">
        <Text size="xs" c="dimmed">
          HTML version{images ? ' (remote images loaded)' : ' (remote images blocked)'}
        </Text>
        {!images && (
          <Button variant="subtle" size="compact-xs" onClick={() => setImages(true)}>
            Load remote images
          </Button>
        )}
      </Group>
      <HtmlFrame src={`/api/admin/mail/${id}/html${images ? '?images=1' : ''}`} />
    </Stack>
  )
}

export function MailCard({ mail, collapse = false }: { mail: MailView; collapse?: boolean }) {
  const long = collapse && (mail.text?.length ?? 0) > 600
  const [collapsed, setCollapsed] = useState(long)
  const out = mail.direction === 'out'
  const who = out
    ? `${mail.mailbox || 'Me'} → ${mail.toAddrs.join(', ')}${mail.ccAddrs.length ? ` (cc ${mail.ccAddrs.join(', ')})` : ''}`
    : mail.fromAddr

  return (
    <Paper
      withBorder
      p="sm"
      style={{ borderLeft: `3px solid var(--mantine-color-${out ? 'brand-5' : 'teal-6'})` }}
      bg={out ? 'var(--mantine-primary-color-light)' : undefined}
    >
      <Group justify="space-between" gap="xs" mb={6} wrap="wrap">
        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
          <Text span fw={600} size="xs">
            {who}
          </Text>
          {mail.subject && <Text span c="dimmed" size="xs">{` · ${mail.subject}`}</Text>}
        </Text>
        <Group gap={6}>
          {out && <DeliveryBadge event={mail.status} />}
          <Text size="xs" c="dimmed">
            {fmtFull(mail.createdAt)}
          </Text>
        </Group>
      </Group>
      <Stack gap="xs">
        {mail.text && (
          <pre className={`${classes.body} ${collapsed ? classes.collapsed : ''}`} onClick={() => setCollapsed(false)} title={collapsed ? 'Click to expand' : undefined}>
            {mail.text}
          </pre>
        )}
        {!mail.text && !mail.hasHtml && (
          <Text size="sm" c="dimmed">
            (no body)
          </Text>
        )}
        {mail.hasHtml && <ReceivedHtml id={mail.id} inline={!mail.text} />}
        {mail.attachments.length > 0 && (
          <Group gap="xs">
            {mail.attachments.map((a) => (
              <Badge
                key={a.id}
                component="a"
                href={`/api/admin/mail/${mail.id}/attachments/${encodeURIComponent(a.id)}`}
                target="_blank"
                rel="noopener"
                variant="default"
                leftSection={<IconPaperclip size={12} />}
                style={{ cursor: 'pointer', textTransform: 'none' }}
              >
                {a.filename || 'attachment'} ({Math.max(1, Math.round(a.size / 1024))} KB)
              </Badge>
            ))}
          </Group>
        )}
      </Stack>
    </Paper>
  )
}

type Mailboxes = Session['mailboxes']
const senderLabel = (m: Mailboxes[number]) => (m.name ? `${m.name} <${m.address}>` : m.address)

// Which of our addresses to send from. `value` is a mailbox address.
export function FromSelect({
  mailboxes,
  value,
  onChange,
  label = 'From',
  ...rest
}: {
  mailboxes: Mailboxes
  value: string
  onChange: (address: string) => void
  label?: string | null
  size?: 'xs' | 'sm'
  w?: number | string
}) {
  return (
    <Select
      label={label ?? undefined}
      aria-label="From"
      data={mailboxes.map((m) => ({ value: m.address, label: senderLabel(m) }))}
      value={value || null}
      onChange={(v) => v && onChange(v)}
      allowDeselect={false}
      placeholder="Add a mailbox first"
      {...rest}
    />
  )
}

// The sender to start with: `preferred` if it is one of ours, else the default.
export const initialSender = (mailboxes: Mailboxes, preferred?: string | null) =>
  mailboxes.find((m) => m.address === preferred)?.address ?? mailboxes.find((m) => m.isDefault)?.address ?? mailboxes[0]?.address ?? ''

// Reply box: first action is the default (⌘/Ctrl+Enter). The sender can be
// changed when there is more than one mailbox.
export function Composer({
  heading,
  placeholder,
  actions,
  mailboxes,
  defaultFrom,
  aiContext,
}: {
  heading: string
  placeholder: string
  actions: { label: string; primary?: boolean; send: (text: string, from: string | undefined) => Promise<unknown> }[]
  mailboxes: Mailboxes
  defaultFrom?: string | null
  // The email being answered, for the AI assistant's draft.
  aiContext?: string
}) {
  const [text, setText] = useState('')
  const [from, setFrom] = useState(() => initialSender(mailboxes, defaultFrom))
  const [busy, setBusy] = useState(-1)
  const run = async (i: number) => {
    if (!text.trim() || busy >= 0) return
    setBusy(i)
    try {
      await actions[i].send(text, from || undefined)
      setText('')
    } catch {
      // Shown by the mutation's error toast.
    } finally {
      setBusy(-1)
    }
  }
  return (
    <Stack gap="xs">
      <Group justify="space-between" gap="xs">
        <Text fw={600} size="sm">
          {heading}
        </Text>
        {mailboxes.length > 1 ? (
          <Group gap={6}>
            <Text size="xs" c="dimmed">
              From
            </Text>
            <FromSelect mailboxes={mailboxes} value={from} onChange={setFrom} label={null} size="xs" w={260} />
          </Group>
        ) : (
          from && (
            <Text size="xs" c="dimmed">
              From {from}
            </Text>
          )
        )}
      </Group>
      <Textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        placeholder={placeholder}
        autosize
        minRows={5}
        maxRows={16}
        onKeyDown={getHotkeyHandler([['mod+Enter', () => run(0)]])}
      />
      <Group gap="xs">
        {actions.map((a, i) => (
          <Button key={a.label} variant={a.primary ? 'filled' : 'default'} loading={busy === i} disabled={!text.trim() || (busy >= 0 && busy !== i)} onClick={() => run(i)}>
            {a.label}
          </Button>
        ))}
        <Text size="xs" c="dimmed">
          ⌘/Ctrl + Enter to send
        </Text>
        <Box ml="auto">
          <AiAssist purpose="reply" format="text" size="sm" current={{ body: text }} context={aiContext} onApply={(d) => setText(d.body)} />
        </Box>
      </Group>
    </Stack>
  )
}

export function NoEmailHint({ mailto }: { mailto?: string }) {
  return (
    <Box>
      <Text size="sm" c="dimmed" mb="xs">
        Sending is not set up (no send_email binding named EMAIL). Reply from your mail app instead.
      </Text>
      {mailto && (
        <Anchor href={mailto} size="sm">
          Reply in your mail app →
        </Anchor>
      )}
    </Box>
  )
}
