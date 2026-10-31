import { Badge, Button, Group, Paper, Progress, Select, SimpleGrid, Skeleton, Stack, Text, TextInput, Title } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, call, errorText } from '../api'
import { fmtFull, useAction, useDomainName, useScope } from '../hooks'
import { AiAssist, BodyEditor, TemplatePicker, type BodyFormat } from '../components/editor'
import { FromSelect, HtmlFrame, initialSender } from '../components/mail'
import { ListPanel, ListRow, MasterDetail, MetaList, PageHeader, confirm } from '../components/ui'

const STATUS = {
  draft: { label: 'Draft', color: 'gray' },
  queued: { label: 'Queued', color: 'blue' },
  sending: { label: 'Sending', color: 'yellow' },
  sent: { label: 'Sent', color: 'teal' },
  canceled: { label: 'Stopped', color: 'red' },
} as const

// Refresh while something is on its way out.
const LIVE = new Set(['queued', 'sending'])
const loadBroadcast = (id: string) => call(api.broadcasts[':id'].$get({ param: { id } }))
type BroadcastDetailData = Awaited<ReturnType<typeof loadBroadcast>>

const useSegments = () => useQuery({ queryKey: ['segments'], queryFn: () => call(api.segments.$get()) })

// "Customers (12)", with its domain when all domains are shown.
const useSegmentLabel = () => {
  const { domainId } = useScope()
  const domainName = useDomainName()
  return (s: { name: string; domain_id: number; subscribers?: number }) =>
    `${s.name}${s.subscribers === undefined ? '' : ` (${s.subscribers})`}${domainId ? '' : ` · ${domainName(s.domain_id)}`}`
}

export function BroadcastsPage() {
  const { id } = useParams()
  const list = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => call(api.broadcasts.$get()),
    refetchInterval: (q) => (q.state.data?.data.some((b) => LIVE.has(b.status)) ? 15_000 : false),
  })
  const segments = useSegments()
  const segmentName = (sid: string | null) => segments.data?.data.find((s) => s.id === sid)?.name ?? '(deleted segment)'

  const listView = (
    <Stack gap="sm">
      <ListPanel empty="No broadcasts yet" loading={list.isPending}>
        {(list.data?.data ?? []).map((b) => (
          <ListRow
            key={b.id}
            to={`/broadcasts/${b.id}`}
            active={b.id === id}
            who={b.name || '(untitled)'}
            date={b.sent_at || b.scheduled_at || b.created_at}
            meta={
              <Group gap={6} component="span">
                <Badge size="xs" variant="light" color={STATUS[b.status].color}>
                  {STATUS[b.status].label}
                </Badge>
                {segmentName(b.segment_id)}
                {b.total > 0 && ` · ${b.sent}/${b.total}`}
              </Group>
            }
          />
        ))}
      </ListPanel>
      {list.error && <Text c="red" size="sm">{errorText(list.error)}</Text>}
      <Text size="xs" c="dimmed">
        A broadcast goes to everyone subscribed in one segment of your contacts. Each email gets an unsubscribe link, and people who use it are skipped from then on.
      </Text>
    </Stack>
  )

  return (
    <>
      <PageHeader title="Broadcasts">
        <Button component={Link} to="/broadcasts/new" leftSection={<IconPlus size={16} />}>
          New broadcast
        </Button>
      </PageHeader>
      <MasterDetail
        list={listView}
        backTo="/broadcasts"
        detail={id === 'new' ? <Editor key="new" id={null} /> : id ? <BroadcastDetail key={id} id={id} segmentName={segmentName} /> : null}
      />
    </>
  )
}

function BroadcastDetail({ id, segmentName }: { id: string; segmentName: (id: string | null) => string }) {
  const { data, isPending, error } = useQuery({
    queryKey: ['broadcast', id],
    queryFn: () => loadBroadcast(id),
    refetchInterval: (q) => (q.state.data && LIVE.has(q.state.data.status) ? 15_000 : false),
  })
  if (isPending) return <Skeleton h={240} />
  if (error) return <Text c="red">{errorText(error)}</Text>
  return data.status === 'draft' ? <Editor id={id} initial={data} /> : <Viewer id={id} b={data} segment={segmentName(data.segment_id)} />
}

type Draft = { name: string; segmentId: string; subject: string; previewText: string; message: string; format: BodyFormat }

function Editor({ id, initial }: { id: string | null; initial?: { from?: string | null; format?: BodyFormat; name: string; segment_id: string | null; subject?: string | null; preview_text?: string | null; message: string } }) {
  const navigate = useNavigate()
  const { session, domainId } = useScope()
  const segments = useSegments()
  const segmentLabel = useSegmentLabel()
  const [draft, setDraft] = useState<Draft>({
    name: initial?.name ?? '',
    segmentId: initial?.segment_id ?? '',
    subject: initial?.subject ?? '',
    previewText: initial?.preview_text ?? '',
    message: initial?.message ?? '',
    format: initial?.format ?? 'text',
  })
  const [testTo, setTestTo] = useState('')
  const [when, setWhen] = useState('')
  // It goes out from a mailbox of its segment's domain.
  const sendingDomain = segments.data?.data.find((s) => s.id === draft.segmentId)?.domain_id ?? domainId
  const mailboxes = (session?.mailboxes ?? []).filter((m) => !sendingDomain || m.domainId === sendingDomain)
  const [from, setFrom] = useState('')
  useEffect(() => {
    if (mailboxes.length && !mailboxes.some((m) => m.address === from)) setFrom(initialSender(mailboxes, initial?.from?.match(/<([^>]+)>/)?.[1] ?? initial?.from))
  }, [from, mailboxes, initial])
  const payload = { ...draft, segmentId: Number(draft.segmentId), from: from || undefined }
  const set = (key: Exclude<keyof Draft, 'format'>) => (value: string | null) => setDraft((d) => ({ ...d, [key]: value ?? '' }))

  const invalidate = [['broadcasts'], ['broadcast', id]]
  const save = useAction(
    async () => (id ? call(api.broadcasts[':id'].$patch({ param: { id }, json: payload })) : call(api.broadcasts.$post({ json: payload }))),
    { invalidate },
  )
  const test = useAction(
    () =>
      call(
        api.broadcasts.test.$post({
          json: {
            subject: draft.subject,
            message: draft.message,
            format: draft.format,
            previewText: draft.previewText,
            from: from || undefined,
            segmentId: draft.segmentId ? Number(draft.segmentId) : undefined,
            to: testTo || undefined,
          },
        }),
      ),
    {
    success: 'Test email sent — check your inbox',
  })
  const send = useAction(
    ({ bid, at }: { bid: string; at: string | undefined }) =>
      call(api.broadcasts[':id'].send.$post({ param: { id: bid }, json: { scheduledAt: at } })),
    { invalidate: [['broadcasts'], ['broadcast']], success: (r) => `Queued for ${r.recipients} subscriber${r.recipients === 1 ? '' : 's'}; sending starts within a minute` },
  )
  const remove = useAction(() => call(api.broadcasts[':id'].$delete({ param: { id: id! } })), { invalidate: [['broadcasts']], success: 'Draft deleted' })

  const saveDraft = async () => {
    const result = await save.mutateAsync()
    if (!id) navigate(`/broadcasts/${result.id}`, { replace: true })
    return result.id
  }

  const sendNow = async () => {
    const segment = segments.data?.data.find((s) => s.id === draft.segmentId)
    if (!segment) return void (await confirm('Choose a segment', 'A broadcast needs a segment to send to.'))
    const target = `“${segment.name}” (${segment.subscribers} subscribed)`
    const at = when ? new Date(when) : null
    const ok = await confirm(
      at ? 'Schedule broadcast' : 'Send broadcast',
      at
        ? `Send “${draft.subject}” to ${target} on ${at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}?`
        : `Send “${draft.subject}” to ${target} now?`,
      { label: at ? 'Schedule' : 'Send now' },
    )
    if (!ok) return
    const bid = await saveDraft()
    await send.mutateAsync({ bid, at: at?.toISOString() })
  }

  return (
    <Stack>
      <Title order={3}>{id ? 'Edit draft' : 'New broadcast'}</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label="Segment"
          placeholder={segments.data?.data.length ? 'Choose a segment…' : 'No segments yet — create one under Contacts'}
          data={(segments.data?.data ?? []).map((s) => ({ value: s.id, label: segmentLabel(s) }))}
          value={draft.segmentId || null}
          onChange={set('segmentId')}
        />
        <TextInput label="Name" description="Only you see this; defaults to the subject" value={draft.name} onChange={(e) => set('name')(e.currentTarget.value)} />
      </SimpleGrid>
      <TextInput label="Subject" value={draft.subject} onChange={(e) => set('subject')(e.currentTarget.value)} maxLength={300} />
      <TextInput label="Preview text" description="The line inboxes show after the subject (optional)" value={draft.previewText} onChange={(e) => set('previewText')(e.currentTarget.value)} maxLength={200} />
      <BodyEditor
        description="{{first_name}}, {{last_name}} and {{email}} are filled in for each subscriber."
        format={draft.format}
        onFormat={(format) => setDraft((d) => ({ ...d, format }))}
        value={draft.message}
        onChange={set('message')}
        tools={
          <>
            <TemplatePicker onApply={(t) => setDraft((d) => ({ ...d, format: t.format, subject: t.subject || d.subject, message: t.body }))} />
            <AiAssist
              purpose="broadcast"
              format={draft.format}
              current={{ subject: draft.subject, body: draft.message }}
              onApply={(r) => setDraft((d) => ({ ...d, subject: r.subject || d.subject, message: r.body }))}
            />
          </>
        }
      />
      <FromSelect mailboxes={mailboxes} value={from} onChange={setFrom} />
      <Text size="xs" c="dimmed">
        Each subscriber gets their own email with an unsubscribe link at the end. Large lists go out in batches of 100 a minute, within your daily sending quota.
      </Text>
      <Group gap="xs">
        <Button variant="default" onClick={() => saveDraft()} loading={save.isPending && !send.isPending}>
          Save draft
        </Button>
        {id && (
          <Button
            variant="subtle"
            color="red"
            ml="auto"
            onClick={async () => {
              if (!(await confirm('Delete this draft?', 'This cannot be undone.', { danger: true, label: 'Delete' }))) return
              await remove.mutateAsync()
              navigate('/broadcasts')
            }}
          >
            Delete
          </Button>
        )}
      </Group>

      <Paper withBorder p="md">
        <Text fw={600} mb="xs">
          Send a test
        </Text>
        <Group align="flex-end" gap="xs">
          <TextInput style={{ flex: 1 }} label="Test recipient" placeholder="Defaults to the sender address" value={testTo} onChange={(e) => setTestTo(e.currentTarget.value)} />
          <Button variant="default" onClick={() => test.mutate()} loading={test.isPending} disabled={!draft.subject || !draft.message}>
            Send test email
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="md">
        <Text fw={600} mb="xs">
          Send to segment
        </Text>
        <Group align="flex-end" gap="xs">
          <TextInput style={{ flex: 1 }} type="datetime-local" label="Schedule" description="Leave empty to send now" value={when} onChange={(e) => setWhen(e.currentTarget.value)} />
          <Button onClick={sendNow} loading={send.isPending} disabled={!draft.segmentId || !draft.subject || !draft.message}>
            Send broadcast
          </Button>
        </Group>
      </Paper>
    </Stack>
  )
}

function Viewer({ id, b, segment }: { id: string; b: BroadcastDetailData; segment: string }) {
  const navigate = useNavigate()
  const cancel = useAction(() => call(api.broadcasts[':id'].cancel.$post({ param: { id }, json: {} })), {
    invalidate: [['broadcasts'], ['broadcast', id]],
    success: (r) => (r.status === 'draft' ? 'Back to draft' : 'Stopped'),
  })
  const remove = useAction(() => call(api.broadcasts[':id'].$delete({ param: { id } })), { invalidate: [['broadcasts']], success: 'Deleted' })
  const sending = b.status === 'sending'
  return (
    <Stack>
      <Group gap="sm">
        <Title order={3}>{b.name || '(untitled)'}</Title>
        <Badge variant="light" color={STATUS[b.status].color}>
          {STATUS[b.status].label}
        </Badge>
      </Group>
      {b.total > 0 && (
        <Stack gap={4}>
          <Progress.Root size="lg">
            <Progress.Section value={(b.sent / b.total) * 100} color="teal" />
            <Progress.Section value={(b.failed / b.total) * 100} color="red" />
          </Progress.Root>
          <Text size="sm" c="dimmed">
            {b.sent} of {b.total} sent{b.failed ? `, ${b.failed} failed` : ''}
            {sending && ' — the rest follow in batches; if the daily quota runs out it continues tomorrow'}
          </Text>
        </Stack>
      )}
      <MetaList
        items={[
          ['From', b.from],
          ['Segment', segment],
          ['Subject', b.subject ?? ''],
          ['Preview text', b.preview_text ?? ''],
          ['Created', fmtFull(b.created_at)],
          ['Scheduled for', b.scheduled_at ? fmtFull(b.scheduled_at) : ''],
          [b.status === 'canceled' ? 'Stopped' : 'Finished', b.sent_at ? fmtFull(b.sent_at) : ''],
        ]}
      />
      <HtmlFrame html={b.html} remoteImages />
      {b.failures.length > 0 && (
        <Stack gap={4}>
          <Text fw={600} size="sm">
            Failed
          </Text>
          {b.failures.map((f) => (
            <Text key={f.email} size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {f.email} — {f.error}
            </Text>
          ))}
        </Stack>
      )}
      <Group>
        {b.status === 'queued' && (
          <Button
            color="red"
            variant="light"
            loading={cancel.isPending}
            onClick={async () => (await confirm('Take this back?', 'It becomes a draft again that you can edit and send later.', { danger: true, label: 'Back to draft' })) && cancel.mutate()}
          >
            Cancel send
          </Button>
        )}
        {sending && (
          <Button
            color="red"
            variant="light"
            loading={cancel.isPending}
            onClick={async () =>
              (await confirm('Stop sending?', `${b.total - b.sent - b.failed} subscribers have not received it yet and will not. This cannot be resumed.`, { danger: true, label: 'Stop' })) && cancel.mutate()
            }
          >
            Stop sending
          </Button>
        )}
        {(b.status === 'sent' || b.status === 'canceled') && (
          <Button
            variant="subtle"
            color="red"
            ml="auto"
            onClick={async () => {
              if (!(await confirm('Delete this broadcast?', 'Only the record here is removed.', { danger: true, label: 'Delete' }))) return
              await remove.mutateAsync()
              navigate('/broadcasts')
            }}
          >
            Delete
          </Button>
        )}
      </Group>
    </Stack>
  )
}
