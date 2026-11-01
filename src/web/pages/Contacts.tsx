import { ActionIcon, Badge, Button, Collapse, Group, Menu, Paper, Select, Stack, Table, Text, TextInput, Textarea, Title, Tooltip } from '@mantine/core'
import { IconDots, IconMail, IconTrash } from '@tabler/icons-react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api, call, errorText } from '../api'
import { fmt, useAction, useScope } from '../hooks'
import { PageHeader, PickDomain, confirm } from '../components/ui'
import { SignupForms } from './SignupForms'

// The picked domain's contacts and segments.
export function ContactsPage() {
  const { domain } = useScope()
  return (
    <Stack>
      <PageHeader title={domain ? `Contacts · ${domain.name}` : 'Contacts'} />
      {domain ? (
        <>
          <Segments />
          <SignupForms />
          <Contacts />
        </>
      ) : (
        <PickDomain what="Contacts and segments" />
      )}
    </Stack>
  )
}

const useSegments = () => useQuery({ queryKey: ['segments'], queryFn: () => call(api.segments.$get()) })

function Segments() {
  const segments = useSegments()
  const [name, setName] = useState('')
  const create = useAction((n: string) => call(api.segments.$post({ json: { name: n } })), { invalidate: [['segments']], success: (r) => `Created segment “${r.name}”` })
  const remove = useAction((id: string) => call(api.segments[':id'].$delete({ param: { id } })), { invalidate: [['segments'], ['contacts']], success: 'Segment deleted' })

  return (
    <Paper withBorder p="lg">
      <Title order={4}>Segments</Title>
      <Text size="sm" c="dimmed" mb="sm">
        Broadcasts go to a segment. A contact can be in several.
      </Text>
      <Table verticalSpacing="xs">
        <Table.Tbody>
          {(segments.data?.data ?? []).map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>{s.name}</Table.Td>
              <Table.Td c="dimmed">{s.subscribers} subscribed</Table.Td>
              <Table.Td c="dimmed" visibleFrom="sm">
                {fmt(s.created_at)}
              </Table.Td>
              <Table.Td ta="right">
                <Button
                  size="compact-sm"
                  variant="subtle"
                  color="red"
                  onClick={async () => (await confirm(`Delete segment “${s.name}”?`, 'The contacts in it are kept.', { danger: true, label: 'Delete' })) && remove.mutate(s.id)}
                >
                  Delete
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {segments.data?.data.length === 0 && (
        <Text size="sm" c="dimmed">
          No segments yet.
        </Text>
      )}
      {segments.error && <Text c="red" size="sm">{errorText(segments.error)}</Text>}
      <Group
        component="form"
        mt="md"
        align="flex-end"
        onSubmit={async (e) => {
          e.preventDefault()
          await create.mutateAsync(name).then(() => setName('')).catch(() => {})
        }}
      >
        <TextInput label="New segment" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={100} style={{ flex: 1 }} required />
        <Button type="submit" variant="default" loading={create.isPending}>
          Create segment
        </Button>
      </Group>
    </Paper>
  )
}

function Contacts() {
  const segments = useSegments()
  const segmentOptions = (segments.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))
  const [filter, setFilter] = useState<string | null>(null)
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', segmentId: null as string | null })

  const list = useInfiniteQuery({
    queryKey: ['contacts', filter],
    queryFn: ({ pageParam }) => call(api.contacts.$get({ query: { segment: filter ?? undefined, after: pageParam || undefined } })),
    initialPageParam: '',
    getNextPageParam: (last) => (last.has_more ? last.data.at(-1)?.id : undefined),
  })
  const contacts = list.data?.pages.flatMap((p) => p.data) ?? []

  const invalidate = [['contacts'], ['segments']]
  const add = useAction(
    () => call(api.contacts.$post({ json: { email: form.email, firstName: form.firstName, lastName: form.lastName, segmentId: form.segmentId ? Number(form.segmentId) : undefined } })),
    { invalidate, success: `Added ${form.email}` },
  )
  const [importing, setImporting] = useState(false)
  const [bulk, setBulk] = useState('')
  const importAll = useAction(() => call(api.contacts.import.$post({ json: { text: bulk, segmentId: form.segmentId ? Number(form.segmentId) : undefined } })), {
    invalidate,
    success: (r) => `Added ${r.added}${r.existing ? `, ${r.existing} already there` : ''}${r.invalid ? `, ${r.invalid} not valid addresses` : ''}`,
  })
  const patch = useAction(({ id, unsubscribed }: { id: string; unsubscribed: boolean }) => call(api.contacts[':id'].$patch({ param: { id }, json: { unsubscribed } })), { invalidate })
  const remove = useAction((id: string) => call(api.contacts[':id'].$delete({ param: { id } })), { invalidate, success: 'Contact deleted' })
  const joinSegment = useAction(
    ({ id, segmentId }: { id: string; segmentId: string }) => call(api.contacts[':id'].segments.$post({ param: { id }, json: { segmentId: Number(segmentId) } })),
    { invalidate, success: 'Added to segment' },
  )
  const leaveSegment = useAction(
    ({ id, segmentId }: { id: string; segmentId: string }) => call(api.contacts[':id'].segments[':segmentId'].$delete({ param: { id, segmentId } })),
    { invalidate, success: 'Removed from segment' },
  )

  return (
    <Paper withBorder p="lg">
      <Title order={4}>Contacts</Title>
      <Text size="sm" c="dimmed" mb="sm">
        Only add people who asked to hear from you. Unsubscribes are handled by the link in each email.
      </Text>
      <Group
        component="form"
        align="flex-end"
        gap="xs"
        onSubmit={async (e) => {
          e.preventDefault()
          await add.mutateAsync().then(() => setForm({ email: '', firstName: '', lastName: '', segmentId: form.segmentId })).catch(() => {})
        }}
      >
        <TextInput label="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} style={{ flex: '2 1 200px' }} />
        <TextInput label="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.currentTarget.value })} style={{ flex: '1 1 100px' }} />
        <TextInput label="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.currentTarget.value })} style={{ flex: '1 1 100px' }} />
        <Select label="Segment" placeholder="(none)" clearable data={segmentOptions} value={form.segmentId} onChange={(v) => setForm({ ...form, segmentId: v })} style={{ flex: '1 1 160px' }} />
        <Button type="submit" loading={add.isPending}>
          Add
        </Button>
        <Button variant="default" onClick={() => setImporting((v) => !v)}>
          Import…
        </Button>
      </Group>
      <Collapse expanded={importing}>
        <Stack gap="xs" mt="sm">
          <Textarea
            label="Import many"
            description="One per line: email, or email, first name, last name (a CSV export works). They join the segment chosen above. People already here are left as they are, including anyone who unsubscribed."
            placeholder={'ada@example.com, Ada, Lovelace\ngrace@example.com'}
            autosize
            minRows={5}
            maxRows={14}
            value={bulk}
            onChange={(e) => setBulk(e.currentTarget.value)}
          />
          <Group>
            <Button variant="default" loading={importAll.isPending} disabled={!bulk.trim()} onClick={() => importAll.mutateAsync().then(() => setBulk('')).catch(() => {})}>
              Import contacts
            </Button>
          </Group>
        </Stack>
      </Collapse>

      <Group mt="lg" mb="xs">
        <Select placeholder="All contacts" clearable data={segmentOptions} value={filter} onChange={setFilter} w={260} aria-label="Filter by segment" />
      </Group>

      <Table.ScrollContainer minWidth={560}>
        <Table verticalSpacing="xs" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Email</Table.Th>
              <Table.Th>Name</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Added</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {contacts.map((c) => (
              <Table.Tr key={c.id}>
                <Table.Td>{c.email}</Table.Td>
                <Table.Td>{[c.first_name, c.last_name].filter(Boolean).join(' ')}</Table.Td>
                <Table.Td>
                  <Tooltip label={`Confirmed by email ${fmt(c.confirmed_at ?? '')}`} disabled={!c.confirmed_at}>
                    <Badge variant="light" color={c.unsubscribed ? 'red' : 'teal'}>
                      {c.unsubscribed ? 'Unsubscribed' : 'Subscribed'}
                    </Badge>
                  </Tooltip>
                </Table.Td>
                <Table.Td c="dimmed">{fmt(c.created_at)}</Table.Td>
                <Table.Td>
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <Tooltip label="Write email">
                      <ActionIcon variant="subtle" component={Link} to={`/compose?to=${encodeURIComponent(c.email)}`} aria-label="Write email">
                        <IconMail size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon variant="subtle" aria-label="More actions">
                          <IconDots size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {segmentOptions.filter((s) => s.value !== filter).length > 0 && <Menu.Label>Add to segment</Menu.Label>}
                        {segmentOptions
                          .filter((s) => s.value !== filter)
                          .map((s) => (
                            <Menu.Item key={s.value} onClick={() => joinSegment.mutate({ id: c.id, segmentId: s.value })}>
                              {s.label}
                            </Menu.Item>
                          ))}
                        {filter && <Menu.Item onClick={() => leaveSegment.mutate({ id: c.id, segmentId: filter })}>Remove from this segment</Menu.Item>}
                        <Menu.Divider />
                        <Menu.Item
                          onClick={async () => {
                            if (c.unsubscribed && !(await confirm('Resubscribe?', `${c.email} unsubscribed before. Only resubscribe them if they asked.`))) return
                            patch.mutate({ id: c.id, unsubscribed: !c.unsubscribed })
                          }}
                        >
                          {c.unsubscribed ? 'Resubscribe' : 'Unsubscribe'}
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={async () => (await confirm(`Delete contact ${c.email}?`, 'This cannot be undone.', { danger: true, label: 'Delete' })) && remove.mutate(c.id)}
                        >
                          Delete
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {!list.isPending && contacts.length === 0 && (
        <Text size="sm" c="dimmed" ta="center" p="md">
          No contacts.
        </Text>
      )}
      {list.hasNextPage && (
        <Button variant="default" mt="sm" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
          Load more
        </Button>
      )}
      {list.error && <Text c="red" size="sm">{errorText(list.error)}</Text>}
    </Paper>
  )
}
