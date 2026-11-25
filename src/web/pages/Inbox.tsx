import { ActionIcon, Alert, Box, Button, Center, Checkbox, CloseButton, Group, Loader, Menu, Skeleton, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import { useDebouncedValue, useHotkeys } from '@mantine/hooks'
import {
  IconArchive,
  IconArrowBackUp,
  IconArrowUpRight,
  IconBan,
  IconChecks,
  IconCode,
  IconDots,
  IconExternalLink,
  IconFilter,
  IconInbox,
  IconMail,
  IconMailOpened,
  IconPencil,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MouseEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, call, errorText } from '../api'
import { fmt, fmtFull, useAction, useDomainName, useScope, type Session } from '../hooks'
import { Composer, MailBody, type ReplyDraft } from '../components/mail'
import { useTab, useTabTitle } from '../components/tabs'
import { DeliveryBadge, ListPanel, ListRow, MailboxFilter, MasterDetail, PageHeader, confirm } from '../components/ui'
import classes from '../dashboard.module.css'

type Box = 'inbox' | 'unread' | 'archived' | 'all'
const bareAddress = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim().toLowerCase()

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
  const updateMany = useAction(
    (v: { ids: number[]; read?: boolean; archived?: boolean }) => call(api.mail['bulk-update'].$post({ json: v })),
    {
      invalidate: [['mail-list'], ['stats']],
      success: ({ updated }) => `Updated ${updated} ${updated === 1 ? 'email' : 'emails'}`,
    },
  )
  // Archiving or moving back hides the rows from this box, so clear the selection.
  const updatePicked = (patch: { read?: boolean; archived?: boolean }) =>
    updateMany.mutate({ ids: picked, ...patch }, { onSuccess: () => patch.archived !== undefined && setTicked(new Set()) })
  const pickWhere = (test: (m: (typeof items)[number]) => boolean) => setTicked(new Set(items.filter(test).map((m) => m.id)))
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

  // Keyboard, as in a mail app: ↑/↓ or k/j move through the list.
  const index = items.findIndex((m) => m.id === selected)
  const go = (i: number) => {
    const m = items[i]
    // Drop focus from a clicked row, or its focus ring stays behind.
    if (m && (document.activeElement as HTMLElement | null)?.dataset.mailRow) (document.activeElement as HTMLElement).blur()
    if (m) navigate(`/mail/${m.id}${suffix}`)
  }
  useHotkeys([
    ['ArrowDown', () => go(index < 0 ? 0 : index + 1)],
    ['j', () => go(index < 0 ? 0 : index + 1)],
    ['ArrowUp', () => go(Math.max(0, index - 1))],
    ['k', () => go(Math.max(0, index - 1))],
  ])
  // Keep the open row in view while stepping through.
  useEffect(() => {
    if (selected) document.querySelector(`[data-mail-row="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  // After archiving or deleting the open email, open the next one (or the one above).
  const neighbour = index < 0 ? undefined : (items[index + 1] ?? items[index - 1])
  const afterGone = () => navigate(neighbour ? `/mail/${neighbour.id}${suffix}` : `/mail${suffix}`)

  const boxLabel = BOXES.find(([b]) => b === box)![1]
  const total = counts?.[box]
  const listView = (
    <div className={classes.pane}>
      <div className={classes.paneHead}>
        <Group justify="space-between" wrap="nowrap" gap="xs" mb={8}>
          <div style={{ minWidth: 0 }}>
            <Text fw={700} className={classes.line}>
              {boxLabel}
              {mailbox ? ` — ${mailbox}` : ''}
            </Text>
            <Text size="xs" c="dimmed">
              {total === undefined ? ' ' : `${total} ${total === 1 ? 'message' : 'messages'}`}
            </Text>
          </div>
          <Group gap={2} wrap="nowrap">
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label="Choose a box" title="Choose a box">
                  <IconFilter size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {BOXES.map(([value, label]) => (
                  <Menu.Item key={value} onClick={() => setParam('box', value === 'inbox' ? '' : value)} rightSection={counts ? <Text size="xs" c="dimmed">{counts[value]}</Text> : null} fw={value === box ? 700 : undefined}>
                    {label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label="Select" title="Select">
                  <IconChecks size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => pickWhere(() => true)}>{list.hasNextPage ? `All ${items.length} loaded` : 'All'}</Menu.Item>
                <Menu.Item onClick={() => pickWhere((m) => !m.readAt)}>Unread</Menu.Item>
                <Menu.Item onClick={() => pickWhere((m) => !!m.readAt)}>Read</Menu.Item>
                <Menu.Item disabled={!picked.length} onClick={() => setTicked(new Set())}>
                  None
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        <TextInput size="xs" radius="xl" leftSection={<IconSearch size={14} />} placeholder="Search" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        {picked.length > 0 && (
          <Group justify="space-between" wrap="nowrap" mt={8}>
            <Group gap={6} wrap="nowrap">
              <Checkbox
                size="xs"
                aria-label="Select all"
                checked={allPicked}
                indeterminate={!allPicked}
                onChange={() => setTicked(new Set(allPicked ? [] : items.map((m) => m.id)))}
              />
              <Text size="xs">{picked.length} selected</Text>
            </Group>
            <Group gap={2} wrap="nowrap">
              <ActionIcon variant="subtle" color="gray" title="Mark as read" aria-label="Mark as read" loading={updateMany.isPending} onClick={() => updatePicked({ read: true })}>
                <IconMailOpened size={16} />
              </ActionIcon>
              <ActionIcon variant="subtle" color="gray" title="Mark as unread" aria-label="Mark as unread" loading={updateMany.isPending} onClick={() => updatePicked({ read: false })}>
                <IconMail size={16} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                color="gray"
                title={box === 'archived' ? 'Move to inbox' : 'Archive'}
                aria-label={box === 'archived' ? 'Move to inbox' : 'Archive'}
                loading={updateMany.isPending}
                onClick={() => updatePicked({ archived: box !== 'archived' })}
              >
                {box === 'archived' ? <IconInbox size={16} /> : <IconArchive size={16} />}
              </ActionIcon>
              <ActionIcon variant="subtle" color="red" title="Delete" aria-label="Delete" loading={removeMany.isPending} onClick={deletePicked}>
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          </Group>
        )}
      </div>
      <div className={classes.paneScroll} style={{ padding: 4 }}>
        {list.isPending ? (
          <Center p="xl">
            <Loader size="sm" />
          </Center>
        ) : items.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" p="xl">
            No mail
          </Text>
        ) : (
          items.map((m) => (
            <MailRow
              key={m.id}
              mail={m}
              to={`/mail/${m.id}${suffix}`}
              active={m.id === selected}
              showMailbox={!mailbox}
              check={picked.length ? { checked: ticked.has(m.id), onChange: (on) => tick(m.id, on) } : undefined}
            />
          ))
        )}
        {list.hasNextPage && (
          <Center p="sm">
            <Button variant="subtle" size="xs" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
              Load more
            </Button>
          </Center>
        )}
        {list.error && <Text c="red" size="sm" p="sm">{errorText(list.error)}</Text>}
      </div>
    </div>
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
        flush
        empty="No message selected"
        list={listView}
        backTo={`/mail${suffix}`}
        detail={
          selected && session ? (
            <MailDetail key={selected} id={selected} session={session} listSuffix={suffix} domainName={domainName} showDomain={!domainId} onGone={afterGone} />
          ) : null
        }
      />
    </>
  )
}

type Row = { id: number; fromAddr: string; subject: string; snippet: string | null; createdAt: string; readAt: string | null; mailbox?: string | null; attachmentCount?: number }

// Name and address out of `Name <addr>`.
const senderName = (from: string) => {
  const name = from.replace(/<[^>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '')
  return name || bareAddress(from)
}
const AVATAR = ['#34c759', '#007aff', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00', '#5856d6']
const avatarColor = (s: string) => AVATAR[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % AVATAR.length]

// Today: the time; this week: the weekday; earlier: the date.
const listDate = (iso: string) => {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = (now.getTime() - d.getTime()) / 86400000
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit', month: 'numeric', day: 'numeric' })
}

function MailRow({ mail: m, to, active, showMailbox, check }: { mail: Row; to: string; active: boolean; showMailbox: boolean; check?: { checked: boolean; onChange: (on: boolean) => void } }) {
  const tab = useTab()
  return (
    <UnstyledButton
      component={Link}
      to={to}
      data-mail-row={m.id}
      className={classes.mailRow}
      data-active={active || undefined}
      data-checkable={check ? true : undefined}
      onClick={(e: MouseEvent) => {
        if (!(e.metaKey || e.ctrlKey) || !tab) return
        e.preventDefault()
        tab.openSolo(to.split('?')[0]!, true)
      }}
    >
      {check && (
        <span className={classes.rowCheck} onClick={(e) => e.stopPropagation()}>
          <Checkbox
            size="xs"
            aria-label={`Select email from ${m.fromAddr}`}
            checked={check.checked}
            onClick={(e) => {
              e.preventDefault()
              check.onChange(!check.checked)
            }}
            readOnly
          />
        </span>
      )}
      {!m.readAt && <span className={classes.dot} aria-label="Unread" />}
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text fw={700} size="sm" className={classes.line}>
          {senderName(m.fromAddr)}
        </Text>
        <Text size="xs" className={classes.dim} style={{ flexShrink: 0 }}>
          {m.attachmentCount ? '📎 ' : ''}
          {listDate(m.createdAt)}
        </Text>
      </Group>
      <Text size="sm" fw={m.readAt ? 400 : 600} className={classes.line}>
        {m.subject || '(no subject)'}
      </Text>
      <Text size="sm" className={`${classes.dim} ${classes.clamp}`}>
        {showMailbox && m.mailbox ? `To ${m.mailbox} · ` : ''}
        {m.snippet}
      </Text>
    </UnstyledButton>
  )
}

function MailDetail({
  id,
  session,
  listSuffix,
  domainName,
  showDomain,
  onGone,
}: {
  id: number
  session: Session
  listSuffix: string
  domainName: (id: number) => string
  showDomain: boolean
  onGone: () => void
}) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const tab = useTab()
  const { pathname } = useLocation()
  const [replying, setReplying] = useState(false)
  const replyRef = useRef<HTMLDivElement>(null)
  const detail = useQuery({ queryKey: ['mail', id], queryFn: () => call(api.mail[':id'].$get({ param: { id: String(id) } })) })

  // Opening an unread email marks it read on the server; refresh the counts.
  const markedRead = detail.data?.markedRead
  useEffect(() => {
    if (markedRead) {
      client.invalidateQueries({ queryKey: ['mail-list'] })
      client.invalidateQueries({ queryKey: ['session'] })
    }
  }, [markedRead, client])
  useEffect(() => {
    if (replying) replyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [replying])

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
  const block = useAction(
    async (address: string) => {
      await call(api['block-rules'].$post({ json: { kind: 'address', value: address, shared: false } }))
      await call(api.mail[':id'].$patch({ param, json: { archived: true } }))
    },
    { ...refresh, invalidate: [...refresh.invalidate, ['block-rules']], success: 'Sender blocked: their mail now goes to Archived' },
  )
  const remove = useAction(() => call(api.mail[':id'].$delete({ param })), { invalidate: [['mail-list'], ['stats']], success: 'Deleted' })

  useTabTitle(detail.data && (detail.data.mail.subject || '(no subject)'))

  const mail = detail.data?.mail
  const incoming = mail?.direction === 'in'
  const leave = () => {
    if (tab?.solo) tab.close()
    else onGone()
  }
  const archive = () => {
    if (!mail) return
    patch.mutate({ archived: !mail.archived }, { onSuccess: () => !mail.archived && leave() })
  }
  const del = async () => {
    if (!(await confirm('Delete this email?', 'It and its attachments are removed for good.', { danger: true, label: 'Delete' }))) return
    await remove.mutateAsync()
    leave()
  }
  const canReply = incoming && session.canEmail
  useHotkeys(
    incoming
      ? [
          ['r', () => canReply && setReplying(true)],
          ['e', archive],
          ['u', () => patch.mutate({ read: false })],
          ['Delete', del],
          ['Backspace', del],
        ]
      : [],
  )

  if (detail.isPending) return <Skeleton h={240} m="md" />
  if (detail.error || !mail) return <Text c="red" p="md">{errorText(detail.error)}</Text>
  const { related } = detail.data
  const replyAddress = mail.replyTo || mail.fromAddr
  // Replies go out from the domain the email came to.
  const senders = session.mailboxes.filter((m) => m.domainId === mail.domainId)
  const sender = incoming ? mail.fromAddr : mail.mailbox || 'Me'
  const name = senderName(sender)

  return (
    <div className={classes.pane} style={{ border: 0, borderRadius: 0 }}>
      <div className={classes.readToolbar}>
        {incoming && (
          <div className={classes.toolGroup}>
            <Tool label="Reply (R)" disabled={!session.canEmail} onClick={() => setReplying(true)}>
              <IconArrowBackUp size={18} />
            </Tool>
            {!session.canEmail && (
              <Tool label="Reply in your mail app" component="a" href={`mailto:${encodeURIComponent(replyAddress)}`}>
                <IconExternalLink size={18} />
              </Tool>
            )}
          </div>
        )}
        {incoming && (
          <div className={classes.toolGroup}>
            <Tool label={mail.archived ? 'Move to inbox (E)' : 'Archive (E)'} loading={patch.isPending} onClick={archive}>
              {mail.archived ? <IconInbox size={18} /> : <IconArchive size={18} />}
            </Tool>
            <Tool label="Delete (⌫)" loading={remove.isPending} onClick={del}>
              <IconTrash size={18} />
            </Tool>
            <Tool
              label="Block sender"
              loading={block.isPending}
              onClick={async () => {
                if (!(await confirm(`Block ${bareAddress(mail.fromAddr)}?`, 'This email is archived, and what they send from now on goes straight to Archived, unread-free and silent. Manage rules under Spam filter.', { label: 'Block' }))) return
                block.mutate(bareAddress(mail.fromAddr), { onSuccess: leave })
              }}
            >
              <IconBan size={18} />
            </Tool>
          </div>
        )}
        {incoming && (
          <div className={classes.toolGroup}>
            <Tool label="Mark unread (U)" onClick={() => patch.mutate({ read: false })}>
              <IconMail size={18} />
            </Tool>
          </div>
        )}
        <Box style={{ flex: 1 }} />
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label="More">
              <IconDots size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {tab && !tab.solo && (
              <Menu.Item leftSection={<IconArrowUpRight size={14} />} onClick={() => tab.openSolo(pathname)}>
                Open in its own tab
              </Menu.Item>
            )}
            {mail.hasRaw && (
              <Menu.Item leftSection={<IconCode size={14} />} component="a" href={`/api/admin/mail/${mail.id}/raw`} target="_blank" rel="noopener">
                View source
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      </div>

      <div className={classes.paneScroll}>
        <div className={classes.mailHead}>
          <Group wrap="nowrap" align="flex-start" gap="md">
            <div className={classes.avatar} style={{ background: avatarColor(bareAddress(sender)) }}>
              {name.charAt(0).toUpperCase()}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
                <Text fw={700} size="lg" className={classes.line} title={sender}>
                  {name}
                </Text>
                <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
                  {!incoming && <DeliveryBadge event={mail.status} />}
                  {mail.archived && (
                    <Text size="xs" c="dimmed">
                      Archived
                    </Text>
                  )}
                  <Text size="sm" c="dimmed" title={fmtFull(mail.createdAt)}>
                    {fmt(mail.createdAt)}
                  </Text>
                </Group>
              </Group>
              <Text size="md" style={{ overflowWrap: 'anywhere' }}>
                {mail.subject || '(no subject)'}
              </Text>
              <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                {incoming ? `From: ${bareAddress(mail.fromAddr)} · To: ${mail.mailbox}` : `To: ${mail.toAddrs.join(', ')}`}
                {mail.ccAddrs.length ? ` · Cc: ${mail.ccAddrs.join(', ')}` : ''}
                {mail.replyTo && mail.replyTo !== mail.fromAddr ? ` · Reply-To: ${mail.replyTo}` : ''}
              </Text>
            </div>
          </Group>
        </div>

        <div className={classes.readBody}>
          <MailBody key={mail.id} mail={mail} />
        </div>

        {canReply && replying && (
          <div ref={replyRef} className={classes.readBody} style={{ borderTop: '1px solid var(--mantine-color-default-border)', paddingTop: 16 }}>
            <Group justify="flex-end" mb={4}>
              <CloseButton aria-label="Close reply" onClick={() => setReplying(false)} />
            </Group>
            <Composer
              heading={`Reply to ${replyAddress}`}
              placeholder="Quotes their email and threads in their mail app."
              mailboxes={senders}
              defaultFrom={mail.mailbox}
              aiContext={`From: ${mail.fromAddr}\nSubject: ${mail.subject}\n\n${mail.text ?? ''}`}
              actions={[
                { label: 'Send reply', primary: true, send: (draft) => reply.mutateAsync({ ...draft, archive: false }).then(() => setReplying(false)) },
                { label: 'Send and archive', send: (draft) => reply.mutateAsync({ ...draft, archive: true }).then(leave) },
              ]}
            />
          </div>
        )}

        {related.length > 0 && (
          <div className={classes.readBody} style={{ borderTop: '1px solid var(--mantine-color-default-border)', paddingTop: 16 }}>
            <Text fw={600} size="sm" mb="xs">
              Other mail with this person
            </Text>
            <ListPanel empty="">
              {related.map((r) => (
                <ListRow
                  key={r.id}
                  to={`/mail/${r.id}${listSuffix}`}
                  who={`${r.direction === 'in' ? 'Received' : 'Sent'} · ${r.subject || '(no subject)'}`}
                  date={r.createdAt}
                  snippet={r.snippet}
                />
              ))}
            </ListPanel>
          </div>
        )}
        <Text size="xs" c="dimmed" px={24} pb="md">
          {incoming ? `Received ${fmtFull(mail.createdAt)}` : `Sent ${fmtFull(mail.createdAt)}`}
          {mail.mailbox && ` · ${incoming ? 'at' : 'from'} ${mail.mailbox}`}
          {showDomain && ` · ${domainName(mail.domainId)}`}
          {mail.source && mail.source !== 'dashboard' && ` · via ${mail.source}`}
        </Text>
      </div>
    </div>
  )
}

// A round toolbar button with a tooltip, as in a mail app's toolbar.
function Tool({ label, children, ...rest }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; loading?: boolean; component?: 'a'; href?: string }) {
  return (
    <Tooltip label={label} openDelay={300}>
      <ActionIcon variant="subtle" color="gray" size="lg" radius="xl" aria-label={label} {...(rest as object)}>
        {children}
      </ActionIcon>
    </Tooltip>
  )
}
