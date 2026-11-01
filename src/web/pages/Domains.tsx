import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconCircleCheck, IconCircleDashed, IconCircleX, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, call, errorText } from '../api'
import { setDomain } from '../domain'
import { fmt, useAction, useSession } from '../hooks'
import { useTab, useTabTitle } from '../components/tabs'
import { Copyable, ListPanel, ListRow, MasterDetail, PageHeader, confirm } from '../components/ui'

// The Worker's name in wrangler.jsonc, for the Email Routing command.
const WORKER = 'mailroom'
const QUEUE = 'mailroom-events'
const SENDING_EVENTS = ['delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'].map((e) => `message.${e}`).join(',')

const SCOPES = { send: 'Send email', contacts: 'Manage contacts' } as const
const EVENTS = { 'mail.received': 'Mail received', 'mail.status': 'Delivery status' } as const

// Our domains: add one, then everything needed to bring it online and to let
// other systems use it.
export function DomainsPage() {
  const { id } = useParams()
  const list = useQuery({ queryKey: ['domains'], queryFn: () => call(api.domains.$get()) })

  const listView = (
    <Stack gap="sm">
      <ListPanel empty="No domains yet" loading={list.isPending}>
        {(list.data?.items ?? []).map((d) => (
          <ListRow
            key={d.id}
            to={`/domains/${d.id}`}
            active={String(d.id) === id}
            who={d.name}
            meta={[d.brand, `${d.mailboxes} mailbox${d.mailboxes === 1 ? '' : 'es'}`, `${d.contacts} subscribed`].filter(Boolean).join(' · ')}
          />
        ))}
      </ListPanel>
      {list.error && <Text c="red" size="sm">{errorText(list.error)}</Text>}
      <AddDomain />
    </Stack>
  )

  return (
    <>
      <PageHeader title="Domains" />
      <MasterDetail list={listView} backTo="/domains" detail={id ? <DomainDetail key={id} id={id} /> : null} />
    </>
  )
}

function AddDomain() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', brand: '', mailbox: 'hello' })
  const add = useAction(() => call(api.domains.$post({ json: form })), { invalidate: [['domains']], success: (d) => `Added ${d.name}` })
  return (
    <Paper
      withBorder
      p="md"
      component="form"
      onSubmit={async (e) => {
        e.preventDefault()
        const row = await add.mutateAsync().catch(() => null)
        if (!row) return
        setForm({ name: '', brand: '', mailbox: 'hello' })
        navigate(`/domains/${row.id}`)
      }}
    >
      <Stack gap="xs">
        <Text fw={600} size="sm">
          Add a domain
        </Text>
        <TextInput label="Domain" placeholder="example.com" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required />
        <TextInput label="Brand" description="How its mail signs off, e.g. on the unsubscribe page" placeholder="Example Studio" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.currentTarget.value })} maxLength={100} />
        <TextInput
          label="First mailbox"
          description="Its default sender; empty for none yet"
          value={form.mailbox}
          onChange={(e) => setForm({ ...form, mailbox: e.currentTarget.value })}
          rightSection={<Text size="xs" c="dimmed" pr="xs">{`@${form.name || 'domain'}`}</Text>}
          rightSectionWidth={Math.min(220, 24 + 7 * (form.name || 'domain').length)}
        />
        <Button type="submit" loading={add.isPending} leftSection={<IconPlus size={16} />}>
          Add domain
        </Button>
      </Stack>
    </Paper>
  )
}

function Section({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <Stack gap="xs">
      <Group justify="space-between" gap="xs">
        <Title order={4}>{title}</Title>
        {action}
      </Group>
      {description && (
        <Text size="sm" c="dimmed">
          {description}
        </Text>
      )}
      {children}
    </Stack>
  )
}

function DomainDetail({ id }: { id: string }) {
  const param = { id }
  const { data: d, isPending, error } = useQuery({ queryKey: ['domain', id], queryFn: () => call(api.domains[':id'].$get({ param })) })
  useTabTitle(d?.name)
  if (isPending) return <Skeleton h={300} />
  if (error) return <Text c="red">{errorText(error)}</Text>
  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={3}>{d.name}</Title>
          <Text size="sm" c="dimmed">
            Added {fmt(d.createdAt)}
          </Text>
        </div>
        <Button variant="light" onClick={() => setDomain(d.id)}>
          Work in this domain
        </Button>
      </Group>
      <Setup id={id} name={d.name} />
      <Settings key={`${d.id}-${d.brand}-${d.footer}-${d.about}-${d.catchAll}`} id={id} initial={d} />
      <ApiKeys id={id} name={d.name} />
      <Webhooks id={id} />
      <DeleteDomain id={id} name={d.name} />
    </Stack>
  )
}

const CHECKS = {
  receiving: { label: 'Mail is routed to Cloudflare (MX)', fix: 'Enable Email Routing' },
  spf: { label: 'SPF allows Cloudflare', fix: 'Enable Email Routing' },
  sending: { label: 'Onboarded to Email Sending (bounce domain)', fix: 'Enable Email Sending' },
  dmarc: { label: 'DMARC policy', fix: 'Optional, but mail providers trust it: add a TXT record at _dmarc' },
} as const

function Setup({ id, name }: { id: string; name: string }) {
  const { data: session } = useSession()
  const checks = useQuery({ queryKey: ['domain-checks', id], queryFn: () => call(api.domains[':id'].checks.$get({ param: { id } })), staleTime: 60_000 })
  const [to, setTo] = useState('')
  const test = useAction(() => call(api.domains[':id'].test.$post({ param: { id }, json: { to } })), { success: `Test email sent to ${to} — check its inbox and spam folder` })
  const base = session?.publicUrl ?? ''

  return (
    <Section
      title="Setup"
      description="Run these once per domain, with Wrangler logged in to the Cloudflare account that has the domain. The checks read public DNS, so changes can take a few minutes to show."
      action={
        <Button variant="subtle" size="xs" leftSection={<IconRefresh size={14} />} loading={checks.isFetching} onClick={() => checks.refetch()}>
          Check again
        </Button>
      }
    >
      <Paper withBorder p="sm">
        {checks.isPending ? (
          <Loader size="sm" />
        ) : (
          <Stack gap={6}>
            {(checks.data?.checks ?? []).map((c) => (
              <Group key={c.id} gap="xs" wrap="nowrap" align="flex-start">
                {c.ok === null ? (
                  <IconCircleDashed size={18} color="var(--mantine-color-gray-6)" />
                ) : c.ok ? (
                  <IconCircleCheck size={18} color="var(--mantine-color-teal-6)" />
                ) : (
                  <IconCircleX size={18} color={c.id === 'dmarc' ? 'var(--mantine-color-yellow-6)' : 'var(--mantine-color-red-6)'} />
                )}
                <div style={{ minWidth: 0 }}>
                  <Text size="sm">{CHECKS[c.id].label}</Text>
                  <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {c.detail}
                    {c.ok === false && ` — ${CHECKS[c.id].fix}`}
                  </Text>
                </div>
              </Group>
            ))}
          </Stack>
        )}
      </Paper>

      <Text size="sm" fw={600} mt="xs">
        1. Sending: onboard the domain to Email Sending (adds its SPF, DKIM and bounce records)
      </Text>
      <Copyable value={`npx wrangler email sending enable ${name}`} />
      <Text size="sm" fw={600}>
        2. Receiving: turn on Email Routing and send every address to Mailroom
      </Text>
      <Copyable value={`npx wrangler email routing enable ${name}\nnpx wrangler email routing rules update ${name} catch-all --action-type worker --action-value ${WORKER} --enabled true`} />
      <Text size="xs" c="dimmed">
        Rules for single addresses (e.g. forwarding one to a personal inbox) take precedence over the catch-all. Whether mail to an address without a mailbox is kept is
        decided under Settings below.
      </Text>
      <Text size="sm" fw={600}>
        3. Delivery status: subscribe the event queue to the domain (needs its zone id, shown in the dashboard&apos;s domain overview)
      </Text>
      <Copyable
        value={`npx wrangler queues subscription create ${QUEUE} --source email.sending --zone-id <ZONE_ID> --domain ${name} --events ${SENDING_EVENTS} --name ${name.replace(/\./g, '-')}-delivery`}
      />
      <Text size="sm" fw={600}>
        4. Send a test email
      </Text>
      <Group
        component="form"
        gap="xs"
        align="flex-end"
        onSubmit={(e) => {
          e.preventDefault()
          test.mutate()
        }}
      >
        <TextInput placeholder="you@gmail.com" type="email" required value={to} onChange={(e) => setTo(e.currentTarget.value)} style={{ flex: 1 }} aria-label="Test recipient" />
        <Button type="submit" variant="default" loading={test.isPending} disabled={!session?.canEmail}>
          Send test
        </Button>
      </Group>
      {base && (
        <Text size="xs" c="dimmed">
          Unsubscribe links and images in this domain&apos;s email point to {base}.
        </Text>
      )}
    </Section>
  )
}

type DomainRow = { brand: string; catchAll: boolean; footer: string; about: string; name: string }

function Settings({ id, initial }: { id: string; initial: DomainRow }) {
  const [form, setForm] = useState({ brand: initial.brand, catchAll: initial.catchAll, footer: initial.footer, about: initial.about })
  const save = useAction(() => call(api.domains[':id'].$patch({ param: { id }, json: form })), { invalidate: [['domain', id], ['domains'], ['session']], success: 'Saved' })
  const changed = JSON.stringify(form) !== JSON.stringify({ brand: initial.brand, catchAll: initial.catchAll, footer: initial.footer, about: initial.about })
  return (
    <Section title="Settings">
      <TextInput label="Brand" description="Shown on the unsubscribe page and in the default broadcast footer" placeholder={initial.name} value={form.brand} onChange={(e) => setForm({ ...form, brand: e.currentTarget.value })} maxLength={100} />
      <Switch
        label="Keep mail for addresses without a mailbox (catch-all)"
        description="Off: mail to any address that is not a mailbox is refused"
        checked={form.catchAll}
        onChange={(e) => setForm({ ...form, catchAll: e.currentTarget.checked })}
      />
      <TextInput
        label="Broadcast footer"
        description="The line before the unsubscribe link in every broadcast"
        placeholder={`You are receiving this because you subscribed to ${form.brand || initial.name} updates.`}
        value={form.footer}
        onChange={(e) => setForm({ ...form, footer: e.currentTarget.value })}
        maxLength={300}
      />
      <Textarea
        label="About, for the writing assistant"
        description="Who writes this domain's email and for whom; it is given to the AI with every draft"
        placeholder="An independent studio making apps for … Our customers are …"
        autosize
        minRows={2}
        maxRows={8}
        value={form.about}
        onChange={(e) => setForm({ ...form, about: e.currentTarget.value })}
        maxLength={2000}
      />
      <Button w="fit-content" onClick={() => save.mutate()} loading={save.isPending} disabled={!changed}>
        Save settings
      </Button>
    </Section>
  )
}

function ApiKeys({ id, name }: { id: string; name: string }) {
  const { data: session } = useSession()
  const keys = useQuery({ queryKey: ['domain-keys', id], queryFn: () => call(api.domains[':id'].keys.$get({ param: { id } })) })
  const [form, setForm] = useState({ name: '', scopes: ['send', 'contacts'] as (keyof typeof SCOPES)[] })
  const invalidate = { invalidate: [['domain-keys', id], ['domains']] }
  const create = useAction(() => call(api.domains[':id'].keys.$post({ param: { id }, json: form })), invalidate)
  const revoke = useAction((keyId: number) => call(api.domains[':id'].keys[':keyId'].$delete({ param: { id, keyId: String(keyId) } })), { ...invalidate, success: 'Key revoked' })
  const base = session?.publicUrl ?? 'https://mailroom.example.com'

  const showKey = (key: string) =>
    modals.open({
      title: 'Your new API key',
      size: 'lg',
      children: (
        <Stack>
          <Alert color="yellow">Copy it now: it is not stored and cannot be shown again. Keep it on your servers only, never in an app or a web page.</Alert>
          <Copyable value={key} />
          <Text size="sm">Try it:</Text>
          <Copyable value={`curl ${base}/v1/domain -H "Authorization: Bearer ${key}"`} />
        </Stack>
      ),
    })

  return (
    <Section
      title="API keys"
      description={
        <>
          For your own servers and apps, to send email from {name} and manage its contacts through the API ({base}/v1, see docs/api.md). A key works for this domain only.
        </>
      }
    >
      {(keys.data?.items.length ?? 0) > 0 && (
        <Paper withBorder style={{ overflowX: 'auto' }}>
          <Table verticalSpacing="xs">
            <Table.Tbody>
              {keys.data!.items.map((k) => (
                <Table.Tr key={k.id}>
                  <Table.Td>
                    <Group gap={6}>
                      <Text size="sm" fw={600}>
                        {k.name}
                      </Text>
                      <Code>{k.prefix}…</Code>
                      {k.scopes.map((s) => (
                        <Badge key={s} size="xs" variant="light">
                          {s}
                        </Badge>
                      ))}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {k.lastUsedAt ? `Last used ${fmt(k.lastUsedAt)}` : 'Never used'}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      color="red"
                      onClick={async () => (await confirm(`Revoke “${k.name}”?`, 'Anything using it stops working at once.', { danger: true, label: 'Revoke' })) && revoke.mutate(k.id)}
                    >
                      Revoke
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
      <Group
        component="form"
        gap="xs"
        align="flex-end"
        onSubmit={async (e) => {
          e.preventDefault()
          const row = await create.mutateAsync().catch(() => null)
          if (!row) return
          setForm({ ...form, name: '' })
          showKey(row.key)
        }}
      >
        <TextInput label="New key" placeholder="e.g. website, billing server" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} maxLength={60} required style={{ flex: '1 1 200px' }} />
        <Checkbox.Group value={form.scopes} onChange={(v) => setForm({ ...form, scopes: v as (keyof typeof SCOPES)[] })}>
          <Group gap="sm" pb={8}>
            {Object.entries(SCOPES).map(([value, label]) => (
              <Checkbox key={value} value={value} label={label} />
            ))}
          </Group>
        </Checkbox.Group>
        <Button type="submit" variant="default" loading={create.isPending} disabled={!form.scopes.length}>
          Create key
        </Button>
      </Group>
    </Section>
  )
}

function Webhooks({ id }: { id: string }) {
  const hooks = useQuery({ queryKey: ['domain-webhooks', id], queryFn: () => call(api.domains[':id'].webhooks.$get({ param: { id } })) })
  const [form, setForm] = useState({ url: '', events: ['mail.received'] as (keyof typeof EVENTS)[] })
  const invalidate = { invalidate: [['domain-webhooks', id], ['domains']] }
  const hookParam = (hookId: number) => ({ id, hookId: String(hookId) })
  const create = useAction(() => call(api.domains[':id'].webhooks.$post({ param: { id }, json: form })), { ...invalidate, success: 'Webhook added' })
  const patch = useAction(({ hookId, enabled }: { hookId: number; enabled: boolean }) => call(api.domains[':id'].webhooks[':hookId'].$patch({ param: hookParam(hookId), json: { enabled } })), invalidate)
  const remove = useAction((hookId: number) => call(api.domains[':id'].webhooks[':hookId'].$delete({ param: hookParam(hookId) })), { ...invalidate, success: 'Webhook deleted' })
  const test = useAction((hookId: number) => call(api.domains[':id'].webhooks[':hookId'].test.$post({ param: hookParam(hookId), json: {} })), {
    ...invalidate,
    success: (r) => (r.ok ? `Delivered (HTTP ${r.status})` : `Not delivered: ${r.status ? `HTTP ${r.status}` : r.error}`),
  })

  return (
    <Section
      title="Webhooks"
      description="Your URL gets a signed POST when mail arrives or a sent email's delivery status changes, so another system can act on it (docs/api.md#webhooks)."
    >
      {(hooks.data?.items ?? []).map((h) => (
        <Paper key={h.id} withBorder p="sm">
          <Stack gap={6}>
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
                {h.url}
              </Text>
              <Switch size="sm" checked={h.enabled} onChange={(e) => patch.mutate({ hookId: h.id, enabled: e.currentTarget.checked })} aria-label="Enabled" />
            </Group>
            <Group gap={4}>
              {h.events.map((e) => (
                <Badge key={e} size="xs" variant="light">
                  {e}
                </Badge>
              ))}
              <Text size="xs" c="dimmed" ml="xs">
                {h.lastAt ? `Last delivery ${fmt(h.lastAt)}: ${h.lastStatus ? `HTTP ${h.lastStatus}` : 'failed'}${h.lastError ? ` — ${h.lastError.slice(0, 120)}` : ''}` : 'Nothing delivered yet'}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              Signing secret
            </Text>
            <Copyable value={h.secret} />
            <Group gap="xs">
              <Button size="compact-sm" variant="default" loading={test.isPending && test.variables === h.id} onClick={() => test.mutate(h.id)}>
                Send a test event
              </Button>
              <ActionIcon
                ml="auto"
                variant="subtle"
                color="red"
                aria-label="Delete webhook"
                onClick={async () => (await confirm('Delete this webhook?', h.url, { danger: true, label: 'Delete' })) && remove.mutate(h.id)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          </Stack>
        </Paper>
      ))}
      <Group
        component="form"
        gap="xs"
        align="flex-end"
        onSubmit={async (e) => {
          e.preventDefault()
          if (await create.mutateAsync().catch(() => null)) setForm({ ...form, url: '' })
        }}
      >
        <TextInput label="New webhook" placeholder="https://example.com/hooks/mail" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.currentTarget.value })} required style={{ flex: '1 1 260px' }} />
        <Checkbox.Group value={form.events} onChange={(v) => setForm({ ...form, events: v as (keyof typeof EVENTS)[] })}>
          <Group gap="sm" pb={8}>
            {Object.entries(EVENTS).map(([value, label]) => (
              <Checkbox key={value} value={value} label={label} />
            ))}
          </Group>
        </Checkbox.Group>
        <Button type="submit" variant="default" loading={create.isPending} disabled={!form.events.length}>
          Add webhook
        </Button>
      </Group>
    </Section>
  )
}

function DeleteDomain({ id, name }: { id: string; name: string }) {
  const navigate = useNavigate()
  const tab = useTab()
  const remove = useAction(() => call(api.domains[':id'].$delete({ param: { id } })), { invalidate: [['domains'], ['session']], success: `Deleted ${name}` })
  return (
    <Section title="Delete domain" description="Removes the domain and everything of it here: mailboxes, all its mail and attachments, contacts, broadcasts, templates, API keys and webhooks. Its DNS and Cloudflare settings are left alone.">
      <Button
        w="fit-content"
        color="red"
        variant="light"
        loading={remove.isPending}
        onClick={async () => {
          const typed = window.prompt(`This cannot be undone. Type ${name} to delete it.`)
          if (typed?.trim().toLowerCase() !== name) return
          await remove.mutateAsync()
          setDomain(null)
          if (tab?.solo) tab.close()
          else navigate('/domains')
        }}
      >
        Delete {name}
      </Button>
    </Section>
  )
}
