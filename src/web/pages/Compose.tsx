import { Alert, Button, Group, Paper, SimpleGrid, Stack, Text, TextInput } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, call } from '../api'
import { useAction, useScope } from '../hooks'
import { AiAssist, BodyEditor, TemplatePicker, type BodyFormat } from '../components/editor'
import { Attachments, SignatureSelect, attachmentsFit, mailboxSignature, toPicks, type PickedFile } from '../components/files'
import { FromSelect, initialSender } from '../components/mail'
import { PageHeader } from '../components/ui'

// A new email to anyone, from any mailbox of the picked domain (of any
// domain when all are shown). Prefill with ?from=&to=&subject=.
export function ComposePage() {
  const [params] = useSearchParams()
  const { session, mailboxes } = useScope()
  const blank = { to: params.get('to') ?? '', cc: '', subject: params.get('subject') ?? '', message: '' }
  const [form, setForm] = useState(blank)
  const [format, setFormat] = useState<BodyFormat>('text')
  const [sentId, setSentId] = useState<number | null>(null)
  const [from, setFrom] = useState('')
  const [files, setFiles] = useState<PickedFile[]>([])
  const [signatureId, setSignatureId] = useState<number | null>(null)
  // The session arrives after the first render, and the domain can change.
  useEffect(() => {
    if (mailboxes.length && !mailboxes.some((m) => m.address === from)) setFrom(initialSender(mailboxes, params.get('from')))
  }, [from, mailboxes, params])
  // Each mailbox starts with its own signature.
  const fromSignature = mailboxSignature(mailboxes, from)
  useEffect(() => setSignatureId(fromSignature), [from, fromSignature])
  const fits = attachmentsFit(files, session?.attachLimit ?? Infinity)
  const set = (key: keyof typeof form) => (value: string | number) => setForm((f) => ({ ...f, [key]: String(value) }))

  const send = useAction(
    () =>
      call(
        api.mail.send.$post({
          json: { from: from || undefined, to: form.to, cc: form.cc, subject: form.subject, message: form.message, format, signatureId, attachments: toPicks(files) },
        }),
      ),
    { invalidate: [['sent-list'], ['stats']], success: 'Sent' },
  )

  const submit = async () => {
    if (!fits) return
    const result = await send.mutateAsync().catch(() => null)
    if (result) {
      setSentId(result.mailId)
      setForm({ ...blank, to: '', subject: '' })
      setFiles([])
    }
  }

  return (
    <Stack maw={820}>
      <PageHeader title="Compose" />
      {session && !session.canEmail && (
        <Alert color="yellow">Sending is not set up: add the send_email binding named EMAIL (wrangler.jsonc).</Alert>
      )}
      {sentId && (
        <Alert color="teal" withCloseButton onClose={() => setSentId(null)}>
          Email sent.{' '}
          <Text component={Link} to={`/sent/${sentId}`} c="brand" size="sm">
            View in Sent →
          </Text>
        </Alert>
      )}
      <Paper withBorder p="lg" component="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <Stack>
          <FromSelect mailboxes={mailboxes} value={from} onChange={setFrom} />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="To" placeholder="Separate addresses with commas" value={form.to} onChange={(e) => set('to')(e.currentTarget.value)} required />
            <TextInput label="Cc" description="Optional" placeholder="Separate addresses with commas" value={form.cc} onChange={(e) => set('cc')(e.currentTarget.value)} />
          </SimpleGrid>
          <TextInput label="Subject" value={form.subject} onChange={(e) => set('subject')(e.currentTarget.value)} maxLength={300} required />
          <BodyEditor
            format={format}
            onFormat={setFormat}
            value={form.message}
            onChange={set('message')}
            onSubmit={submit}
            tools={
              <>
                <TemplatePicker
                  onApply={(t) => {
                    setFormat(t.format)
                    setForm((f) => ({ ...f, subject: t.subject || f.subject, message: t.body }))
                  }}
                />
                <AiAssist
                  purpose="email"
                  format={format}
                  current={{ subject: form.subject, body: form.message }}
                  onApply={(d) => setForm((f) => ({ ...f, subject: d.subject || f.subject, message: d.body }))}
                />
              </>
            }
          />
          <Attachments value={files} onChange={setFiles} />
          <SignatureSelect value={signatureId} onChange={setSignatureId} />
          <Group>
            <Button type="submit" loading={send.isPending} disabled={!session?.canEmail || !form.message.trim() || !fits}>
              Send
            </Button>
            <Text size="xs" c="dimmed">
              ⌘/Ctrl + Enter to send
            </Text>
          </Group>
        </Stack>
      </Paper>
    </Stack>
  )
}
