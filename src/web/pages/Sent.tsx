import { Button, Group, Skeleton, Stack, Text, TextInput, Title } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconSearch } from '@tabler/icons-react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { api, call, errorText } from '../api'
import { fmt, useScope } from '../hooks'
import { MailCard } from '../components/mail'
import { useTabTitle } from '../components/tabs'
import { DeliveryBadge, ListPanel, ListRow, MailboxFilter, MasterDetail, PageHeader } from '../components/ui'

// One-to-one mail sent from here (replies, compose) and through the API.
// Broadcasts have their own page.
export function SentPage() {
  const { id } = useParams()
  const selected = id ? Number(id) : null
  const [params, setParams] = useSearchParams()
  const mailbox = params.get('mailbox') ?? ''
  const [q, setQ] = useState('')
  const [query] = useDebouncedValue(q.trim(), 250)
  const { mailboxes } = useScope()

  const list = useInfiniteQuery({
    queryKey: ['sent-list', mailbox, query],
    queryFn: ({ pageParam }) => call(api.sent.$get({ query: { mailbox, q: query, before: pageParam ? String(pageParam) : undefined } })),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.items.at(-1)?.id : undefined),
  })
  const items = list.data?.pages.flatMap((p) => p.items) ?? []
  const suffix = params.toString() ? `?${params}` : ''

  const listView = (
    <Stack gap="sm">
      <TextInput leftSection={<IconSearch size={16} />} placeholder="Search recipient, subject or body" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      <ListPanel empty="Nothing sent yet" loading={list.isPending}>
        {items.map((m) => (
          <ListRow
            key={m.id}
            to={`/sent/${m.id}${suffix}`}
            active={m.id === selected}
            who={m.toAddrs.join(', ')}
            date={m.createdAt}
            meta={
              <Group gap={6} component="span">
                <DeliveryBadge event={m.status} />
                {[m.subject || '(no subject)', !mailbox && mailboxes.length > 1 ? `from ${m.mailbox}` : '', m.source.startsWith('api:') ? 'API' : ''].filter(Boolean).join(' · ')}
              </Group>
            }
            snippet={m.snippet}
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
      <PageHeader title="Sent">
        <MailboxFilter mailboxes={mailboxes} value={mailbox} onChange={(v) => setParams(v ? { mailbox: v } : {})} />
      </PageHeader>
      <MasterDetail list={listView} backTo={`/sent${suffix}`} detail={selected ? <SentDetail key={selected} id={selected} /> : null} />
    </>
  )
}

function SentDetail({ id }: { id: number }) {
  const { data, isPending, error } = useQuery({ queryKey: ['mail', id], queryFn: () => call(api.mail[':id'].$get({ param: { id: String(id) } })) })
  useTabTitle(data && (data.mail.subject || '(no subject)'))
  if (isPending) return <Skeleton h={240} />
  if (error) return <Text c="red">{errorText(error)}</Text>
  const { mail } = data
  return (
    <Stack>
      <Title order={3} style={{ overflowWrap: 'anywhere' }}>
        {mail.subject || '(no subject)'}
      </Title>
      <MailCard mail={mail} />
      <Text size="xs" c="dimmed">
        Sent {fmt(mail.createdAt)} from {mail.mailbox}
        {mail.source && ` · ${mail.source === 'dashboard' ? 'from the dashboard' : `via ${mail.source}`}`}
      </Text>
    </Stack>
  )
}
