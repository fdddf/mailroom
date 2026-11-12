import { ActionIcon, Alert, Badge, Button, Group, Paper, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core'
import { IconArrowForwardUp, IconInbox, IconPencil, IconStar, IconStarFilled, IconTrash } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api, call, errorText } from '../api'
import { useAction, useDomainName, useScope } from '../hooks'
import { useSignatures } from '../components/files'
import { PageHeader, confirm } from '../components/ui'

// Our own addresses: what mail can be sent from, and what the inbox groups by.
export function MailboxesPage() {
  const { session, domain, domainId } = useScope()
  const domainName = useDomainName()
  const list = useQuery({ queryKey: ['mailboxes'], queryFn: () => call(api.mailboxes.$get()) })
  const signatures = useSignatures().data?.items ?? []
  const [form, setForm] = useState({ address: '', name: '' })
  const invalidate = { invalidate: [['mailboxes'], ['domains']] }

  const add = useAction(() => call(api.mailboxes.$post({ json: form })), { ...invalidate, success: 'Mailbox added' })
  const patch = useAction(
    ({ id, ...json }: { id: number; name?: string; forwardTo?: string; signatureId?: number | null; isDefault?: true }) => call(api.mailboxes[':id'].$patch({ param: { id: String(id) }, json })),
    invalidate,
  )
  const remove = useAction((id: number) => call(api.mailboxes[':id'].$delete({ param: { id: String(id) } })), { ...invalidate, success: 'Mailbox removed' })

  const submit = async () => {
    if (await add.mutateAsync().catch(() => null)) setForm({ address: '', name: '' })
  }

  const rename = (id: number, current: string) => {
    const name = window.prompt('Display name in the From header', current)
    if (name !== null && name.trim() !== current) patch.mutate({ id, name: name.trim() })
  }
  const forward = (id: number, current: string) => {
    const to = window.prompt('Also forward its mail to (a verified Email Routing destination address; empty for none)', current)
    if (to !== null && to.trim() !== current) patch.mutate({ id, forwardTo: to.trim() })
  }

  return (
    <Stack>
      <PageHeader title="Mailboxes" />
      {session && !session.canEmail && <Alert color="yellow">Sending is not set up: add the send_email binding named EMAIL (wrangler.jsonc).</Alert>}
      {session && !session.domains.length && (
        <Alert color="blue">
          Add a domain first, under{' '}
          <Text component={Link} to="/domains" c="brand" size="sm">
            Domains
          </Text>
          .
        </Alert>
      )}
      <Text size="sm" c="dimmed">
        Addresses you send from and receive at, on your domains. Each domain has a default mailbox, its sender when none is picked. Mail to an address
        without a mailbox is still kept while the domain&apos;s catch-all is on (see Domains).
      </Text>

      <Paper withBorder style={{ overflowX: 'auto' }}>
        <Table verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Address</Table.Th>
              {!domainId && <Table.Th>Domain</Table.Th>}
              <Table.Th>Display name</Table.Th>
              <Table.Th>Forwards to</Table.Th>
              <Table.Th>Signature</Table.Th>
              <Table.Th ta="right">Received</Table.Th>
              <Table.Th ta="right">Sent</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(list.data?.items ?? []).map((m) => (
              <Table.Tr key={m.id}>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Text size="sm" fw={600}>
                      {m.address}
                    </Text>
                    {m.isDefault && (
                      <Badge size="sm" variant="light" style={{ flexShrink: 0 }}>
                        Default
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                {!domainId && (
                  <Table.Td>
                    <Text size="sm">{domainName(m.domainId)}</Text>
                  </Table.Td>
                )}
                <Table.Td>
                  <Text size="sm" c={m.name ? undefined : 'dimmed'}>
                    {m.name || '—'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c={m.forwardTo ? undefined : 'dimmed'}>
                    {m.forwardTo || '—'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Select
                    aria-label={`Signature of ${m.address}`}
                    size="xs"
                    w={170}
                    data={[
                      { value: '', label: 'None' },
                      ...signatures.filter((s) => !s.domainId || s.domainId === m.domainId).map((s) => ({ value: String(s.id), label: s.name })),
                    ]}
                    value={m.signatureId ? String(m.signatureId) : ''}
                    onChange={(v) => patch.mutate({ id: m.id, signatureId: v ? Number(v) : null })}
                    allowDeselect={false}
                  />
                </Table.Td>
                <Table.Td ta="right">{m.received}</Table.Td>
                <Table.Td ta="right">{m.sent}</Table.Td>
                <Table.Td>
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <Tooltip label="Open inbox">
                      <ActionIcon variant="subtle" component={Link} to={`/mail?mailbox=${encodeURIComponent(m.address)}`} aria-label="Open inbox">
                        <IconInbox size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Rename">
                      <ActionIcon variant="subtle" onClick={() => rename(m.id, m.name)} aria-label="Rename">
                        <IconPencil size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Forward to…">
                      <ActionIcon variant="subtle" onClick={() => forward(m.id, m.forwardTo)} aria-label="Forward">
                        <IconArrowForwardUp size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={m.isDefault ? 'Default sender of its domain' : 'Make default sender of its domain'}>
                      <ActionIcon variant="subtle" disabled={m.isDefault} onClick={() => patch.mutate({ id: m.id, isDefault: true })} aria-label="Make default">
                        {m.isDefault ? <IconStarFilled size={16} /> : <IconStar size={16} />}
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Remove">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label="Remove"
                        onClick={async () => {
                          if (await confirm(`Remove ${m.address}?`, 'Mail already sent or received stays. Its domain still accepts mail for it while catch-all is on.', { danger: true, label: 'Remove' })) {
                            remove.mutate(m.id)
                          }
                        }}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {list.data?.items.length === 0 && (
          <Text c="dimmed" size="sm" ta="center" p="xl">
            No mailboxes yet.
          </Text>
        )}
        {list.error && <Text c="red" size="sm" p="md">{errorText(list.error)}</Text>}
      </Paper>

      <Paper withBorder p="lg" component="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Address"
            placeholder={`hello@${domain?.name ?? session?.domains[0]?.name ?? 'example.com'}`}
            type="email"
            required
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.currentTarget.value })}
            style={{ flex: '1 1 220px' }}
          />
          <TextInput
            label="Display name"
            placeholder={domain?.brand || 'Example Studio'}
            maxLength={100}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
            style={{ flex: '1 1 220px' }}
          />
          <Button type="submit" loading={add.isPending}>
            Add mailbox
          </Button>
        </Group>
      </Paper>
    </Stack>
  )
}
