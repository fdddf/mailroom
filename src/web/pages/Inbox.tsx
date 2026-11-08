import { Alert, Button, Checkbox, Group, SegmentedControl, Skeleton, Stack, Text, TextInput, Title } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconPencil, IconSearch, IconTrash } from '@tabler/icons-react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, call, errorText } from '../api'
import { fmt, useAction, useDomainName, useScope, type Session } from '../hooks'
import { Composer, MailCard, NoEmailHint, type ReplyDraft } from '../components/mail'
import { useTab, useTabTitle } from '../components/tabs'
import { ListPanel, ListRow, MailboxFilter, MasterDetail, PageHeader, confirm } from '../components/ui'

type Box = 'inbox' | 'unread' | 'archived' | 'all'
const BOXES: [Box, string][] = [
  ['inbox', 'Inbox'],
  ['unread', 'Unread'],
  ['archived', 'Archived'],
  ['all', 'All'],
]

export function InboxPage() {
  const { id } = useParams()
  const selected = id ? Number(id) : null
  const [params, setParams] = useSearchParams()
  const box = (BOXES.some(([b]) => b === params.get('box')) ? params.get('box') : 'inbox') as Box
  const [q, setQ] = useState('')
  const [query] = useDebouncedValue(q.trim(), 250)
  const { session, domainId, mailboxes } = useScope()
  const domainName = useDomainName()
  const navigate = useNavigate()
  const mailbox = params.get('mailbox') ?? ''
  const setParam = (key: string, value: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })

  const list = useInfiniteQuery({
    queryKey: ['mail-list', box, mailbox, query],
    queryFn: ({ pageParam }) => call(api.mail.$get({ query: { box, mailbox, q: query, before: pageParam ? String(pageParam) : undefined } })),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.items.at(-1)?.id : undefined),
  })
  const counts = list.data?.pages[0]?.counts
  const items = list.data?.pages.flatMap((p) => p.items) ?? []
  const suffix = params.toString() ? `?${params}` : ''

  // Ticked emails, for deleting together. Only rows on screen count, so nothing
  // the list no longer shows can be deleted unseen.
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => setTicked(new Set()), [box, mailbox, query, domainId])
  const picked = items.filter((m) => ticked.has(m.id)).map((m) => m.id)
  const allPicked = items.length > 0 && picked.length === items.length
  const tick = (id: number, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const removeMany = useAction((ids: number[]) => call(api.mail['bulk-delete'].$post({ json: { ids } })), {
    invalidate: [['mail-list'], ['stats']],
    success: ({ deleted }) => `Deleted ${deleted} ${deleted === 1 ? 'email' : 'emails'}`,
  })
  const deletePicked = async () => {
    const title = `Delete ${picked.length} ${picked.length === 1 ? 'email' : 'emails'}?`
    if (!(await confirm(title, 'They and their attachments are removed for good.', { danger: true, label: 'Delete' }))) return
    removeMany.mutate(picked, {
      onSuccess: () => {
        setTicked(new Set())
        if (selected && picked.includes(selected)) navigate(`/mail${suffix}`)
      },
    })
  }

  const listView = (
    <Stack gap="sm">
      <SegmentedControl
        fullWidth
        value={box}
        onChange={(v) => setParam('box', v === 'inbox' ? '' : v)}
        data={BOXES.map(([value, label]) => ({ value, label: `${label} ${counts ? counts[value] : ''}` }))}
      />
      <TextInput leftSection={<IconSearch size={16} />} placeholder="Search sender, subject or body" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      {items.length > 0 && (
        <Group justify="space-between" wrap="nowrap" mih={26} px={14}>
          <Checkbox
            label={picked.length ? `${picked.length} selected` : list.hasNextPage ? `Select all ${items.length} loaded` : 'Select all'}
            checked={allPicked}
            indeterminate={picked.length > 0 && !allPicked}
            onChange={() => setTicked(new Set(allPicked ? [] : items.map((m) => m.id)))}
          />
          {picked.length > 0 && (
            <Button size="compact-sm" variant="light" color="red" leftSection={<IconTrash size={14} />} loading={removeMany.isPending} onClick={deletePicked}>
              Delete
            </Button>
          )}
        </Group>
      )}
      <ListPanel empty="No mail" loading={list.isPending}>
        {items.map((m) => (
          <ListRow
            key={m.id}
            to={`/mail/${m.id}${suffix}`}
            active={m.id === selected}
            unread={!m.readAt}
            dot={m.readAt ? undefined : 'var(--mantine-color-brand-5)'}
            who={m.fromAddr}
            date={m.createdAt}
            meta={[m.subject || '(no subject)', !mailbox && mailboxes.length > 1 ? `to ${m.mailbox}` : '', m.attachmentCount ? `📎${m.attachmentCount}` : '']
              .filter(Boolean)
              .join(' · ')}
            snippet={m.snippet}
            check={picked.length ? { checked: ticked.has(m.id), onChange: (on) => tick(m.id, on), label: `Select email from ${m.fromAddr}` } : undefined}
          />
        ))}
      </ListPanel>
      {list.hasNextPage && (
        <Button variant="default" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
          Load more
        </Button>
      )}
      {list.error && <Text c="red" size="sm">{errorText(list.error)}</Text>}
    </Stack>
  )

  return (
    <>
      <PageHeader title="Inbox">
        <MailboxFilter mailboxes={mailboxes} value={mailbox} onChange={(v) => setParam('mailbox', v)} />
        <Button component={Link} to={`/compose${mailbox ? `?from=${encodeURIComponent(mailbox)}` : ''}`} leftSection={<IconPencil size={16} />}>
          Compose
        </Button>
      </PageHeader>
      {session && !session.canEmail && (
        <Alert color="yellow" mb="md">
          <Text size="sm">Sending is not set up: add the send_email binding named EMAIL (wrangler.jsonc). Receiving works without it.</Text>
        </Alert>
      )}
      <MasterDetail
        list={listView}
        backTo={`/mail${suffix}`}
        detail={selected && session ? <MailDetail key={selected} id={selected} session={session} listSuffix={suffix} domainName={domainName} showDomain={!domainId} /> : null}
      />
    </>
  )
}

function MailDetail({
  id,
  session,
  listSuffix,
  domainName,
  showDomain,
}: {
  id: number
  session: Session
  listSuffix: string
  domainName: (id: number) => string
  showDomain: boolean
}) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const tab = useTab()
  const detail = useQuery({ queryKey: ['mail', id], queryFn: () => call(api.mail[':id'].$get({ param: { id: String(id) } })) })

  // Opening an unread email marks it read on the server; refresh the counts.
  const markedRead = detail.data?.markedRead
  useEffect(() => {
    if (markedRead) {
      client.invalidateQueries({ queryKey: ['mail-list'] })
      client.invalidateQueries({ queryKey: ['session'] })
    }
  }, [markedRead, client])

  const param = { id: String(id) }
  const refresh = { invalidate: [['mail', id], ['mail-list'], ['stats']] }
  const patch = useAction(
    (json: { read?: boolean; archived?: boolean }) => call(api.mail[':id'].$patch({ param, json })),
    refresh,
  )
  const reply = useAction(
    ({ archive, ...draft }: ReplyDraft & { archive: boolean }) => call(api.mail[':id'].reply.$post({ param, json: { ...draft, archive } })),
    { ...refresh, success: 'Reply sent' },
  )
  const remove = useAction(() => call(api.mail[':id'].$delete({ param })), { invalidate: [['mail-list'], ['stats']], success: 'Deleted' })

  useTabTitle(detail.data && (detail.data.mail.subject || '(no subject)'))

  if (detail.isPending) return <Skeleton h={240} />
  if (detail.error) return <Text c="red">{errorText(detail.error)}</Text>
  const { mail, related } = detail.data
  const incoming = mail.direction === 'in'
  const replyAddress = mail.replyTo || mail.fromAddr
  // Replies go out from the domain the email came to.
  const senders = session.mailboxes.filter((m) => m.domainId === mail.domainId)

  return (
    <Stack>
      <Title order={3} style={{ overflowWrap: 'anywhere' }}>
        {mail.subject || '(no subject)'}
      </Title>
      <MailCard mail={mail} />

      {incoming &&
        (session.canEmail ? (
          <Composer
            heading={`Reply to ${replyAddress}`}
            placeholder="Quotes their email and threads in their mail app."
            mailboxes={senders}
            defaultFrom={mail.mailbox}
            aiContext={`From: ${mail.fromAddr}\nSubject: ${mail.subject}\n\n${mail.text ?? ''}`}
            actions={[
              { label: 'Send reply', primary: true, send: (draft) => reply.mutateAsync({ ...draft, archive: false }) },
              { label: 'Send and archive', send: (draft) => reply.mutateAsync({ ...draft, archive: true }) },
            ]}
          />
        ) : (
          <NoEmailHint mailto={`mailto:${encodeURIComponent(replyAddress)}`} />
        ))}

      {incoming && (
        <Group gap="xs">
          <Button variant="default" onClick={() => patch.mutate({ read: false })}>
            Mark unread
          </Button>
          <Button variant="default" onClick={() => patch.mutate({ archived: !mail.archived })}>
            {mail.archived ? 'Move to inbox' : 'Archive'}
          </Button>
          <Button
            variant="subtle"
            color="red"
            ml="auto"
            onClick={async () => {
              if (!(await confirm('Delete this email?', 'It and its attachments are removed for good.', { danger: true, label: 'Delete' }))) return
              await remove.mutateAsync()
              if (tab?.solo) tab.close()
              else navigate(`/mail${listSuffix}`)
            }}
          >
            Delete
          </Button>
        </Group>
      )}

      {related.length > 0 && (
        <Stack gap={0}>
          <Text fw={600} size="sm" mb="xs">
            Other mail with this person
          </Text>
          <ListPanel empty="">
            {related.map((r) => (
              <ListRow
                key={r.id}
                to={`/mail/${r.id}`}
                who={`${r.direction === 'in' ? 'Received' : 'Sent'} · ${r.subject || '(no subject)'}`}
                date={r.createdAt}
                snippet={r.snippet}
              />
            ))}
          </ListPanel>
        </Stack>
      )}
      <Text size="xs" c="dimmed">
        {incoming ? `Received ${fmt(mail.createdAt)}` : `Sent ${fmt(mail.createdAt)}`}
        {mail.mailbox && ` · ${incoming ? 'at' : 'from'} ${mail.mailbox}`}
        {showDomain && ` · ${domainName(mail.domainId)}`}
        {mail.source && mail.source !== 'dashboard' && ` · via ${mail.source}`}
      </Text>
    </Stack>
  )
}
