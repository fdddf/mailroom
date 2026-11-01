// Small shared pieces: layout, list rows, badges, confirm dialogs.
import { ActionIcon, Badge, Box, Button, Center, Code, CopyButton, Group, Loader, Paper, Select, Stack, Text, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { modals } from '@mantine/modals'
import { IconArrowLeft, IconArrowUpRight, IconCheck, IconCopy } from '@tabler/icons-react'
import type { MouseEvent, ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { setDomain } from '../domain'
import { fmt, useSession } from '../hooks'
import { useTab } from './tabs'
import classes from '../dashboard.module.css'

// Narrow a mail list to one of our addresses; hidden while there is only one.
export function MailboxFilter({ mailboxes, value, onChange }: { mailboxes: { address: string }[]; value: string; onChange: (address: string) => void }) {
  if (mailboxes.length < 2 && !value) return null
  return (
    <Select
      aria-label="Mailbox"
      w={240}
      data={[{ value: '', label: 'All mailboxes' }, ...mailboxes.map((m) => ({ value: m.address, label: m.address }))]}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      allowDeselect={false}
    />
  )
}

// For pages about one domain's things, while all domains are shown.
export function PickDomain({ what }: { what: string }) {
  const { data: session } = useSession()
  const domains = session?.domains ?? []
  return (
    <Paper withBorder p="lg">
      <Text size="sm" mb="sm">
        {what} belong to a domain. Pick one{domains.length ? '' : ' — after adding it under Domains'}:
      </Text>
      <Group gap="xs">
        {domains.map((d) => (
          <Button key={d.id} variant="default" size="xs" onClick={() => setDomain(d.id)}>
            {d.name}
          </Button>
        ))}
        {!domains.length && (
          <Button component={Link} to="/domains" size="xs">
            Add a domain
          </Button>
        )}
      </Group>
    </Paper>
  )
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  // An item in a tab of its own has its own heading; the section's would only be noise.
  if (useTab()?.solo) return null
  return (
    <Group justify="space-between" mb="md" wrap="wrap" gap="sm">
      <Title order={2}>{title}</Title>
      {children && <Group gap="xs">{children}</Group>}
    </Group>
  )
}

// List on the left, detail on the right; one at a time on narrow screens.
// In a tab of its own (see Shell) an item is shown without the list.
export function MasterDetail({ list, detail, backTo }: { list: ReactNode; detail: ReactNode | null; backTo: string }) {
  const narrow = useMediaQuery('(max-width: 62em)')
  const tab = useTab()
  const { pathname } = useLocation()
  const ownTab = detail && tab && !tab.solo && (
    <Tooltip label="Open in its own tab">
      <ActionIcon variant="subtle" color="gray" onClick={() => tab.openSolo(pathname)} aria-label="Open in its own tab" style={{ position: 'absolute', top: 8, right: 8 }}>
        <IconArrowUpRight size={18} />
      </ActionIcon>
    </Tooltip>
  )
  if (tab?.solo) {
    return (
      <Paper withBorder p="lg" maw={980}>
        {detail}
      </Paper>
    )
  }
  if (narrow) {
    return detail ? (
      <Stack gap="sm" pos="relative">
        <Button component={Link} to={backTo} variant="subtle" leftSection={<IconArrowLeft size={16} />} w="fit-content" px={0}>
          Back to list
        </Button>
        {ownTab}
        {detail}
      </Stack>
    ) : (
      <>{list}</>
    )
  }
  return (
    <Box style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 380px) 1fr', gap: 'var(--mantine-spacing-md)', alignItems: 'start' }}>
      {list}
      <Paper withBorder p="lg" miw={0} pos="relative">
        {ownTab}
        {detail ?? (
          <Text c="dimmed" size="sm">
            Select an item on the left.
          </Text>
        )}
      </Paper>
    </Box>
  )
}

export function ListPanel({ children, empty, loading }: { children: ReactNode[]; empty: string; loading?: boolean }) {
  return (
    <Paper withBorder style={{ overflow: 'hidden' }}>
      {loading ? (
        <Center p="xl">
          <Loader size="sm" />
        </Center>
      ) : children.length ? (
        children
      ) : (
        <Text c="dimmed" size="sm" ta="center" p="xl">
          {empty}
        </Text>
      )}
    </Paper>
  )
}

export function ListRow({
  to,
  active,
  unread,
  who,
  date,
  meta,
  snippet,
  dot,
}: {
  to: string
  active?: boolean
  unread?: boolean
  who: ReactNode
  date?: string
  meta?: ReactNode
  snippet?: string | null
  dot?: string
}) {
  const tab = useTab()
  return (
    <UnstyledButton
      component={Link}
      to={to}
      className={classes.row}
      data-active={active || undefined}
      data-unread={unread || undefined}
      // ⌘/Ctrl-click opens it in a tab of its own, behind this one.
      onClick={(e: MouseEvent) => {
        if (!(e.metaKey || e.ctrlKey) || !tab) return
        e.preventDefault()
        tab.openSolo(to.split('?')[0]!, true)
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={6} wrap="nowrap" miw={0}>
          {dot && <Box w={8} h={8} style={{ borderRadius: 8, flexShrink: 0, background: dot }} />}
          <span className={classes.who}>{who}</span>
        </Group>
        {date && (
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            {fmt(date)}
          </Text>
        )}
      </Group>
      {meta && (
        <Text size="xs" c="dimmed" mt={2}>
          {meta}
        </Text>
      )}
      {snippet && (
        <Text size="sm" c="dimmed" mt={4} className={classes.clamp}>
          {snippet}
        </Text>
      )}
    </UnstyledButton>
  )
}

const EVENTS: Record<string, [string, string]> = {
  queued: ['Queued', 'gray'],
  scheduled: ['Scheduled', 'blue'],
  sent: ['Sent', 'gray'],
  delivered: ['Delivered', 'teal'],
  opened: ['Opened', 'teal'],
  clicked: ['Clicked', 'teal'],
  delivery_delayed: ['Delayed', 'yellow'],
  bounced: ['Bounced', 'red'],
  complained: ['Marked as spam', 'red'],
  failed: ['Failed', 'red'],
  suppressed: ['Suppressed', 'red'],
  canceled: ['Canceled', 'gray'],
}
export function DeliveryBadge({ event }: { event: string | null | undefined }) {
  if (!event) return null
  const [label, color] = EVENTS[event] ?? [event, 'gray']
  return (
    <Badge size="sm" variant="light" color={color}>
      {label}
    </Badge>
  )
}

export const confirm = (title: string, body: ReactNode, { danger = false, label = 'Confirm' } = {}) =>
  new Promise<boolean>((resolve) =>
    modals.openConfirmModal({
      title,
      children: <Text size="sm">{body}</Text>,
      labels: { confirm: label, cancel: 'Cancel' },
      confirmProps: danger ? { color: 'red' } : undefined,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
      onClose: () => resolve(false),
    }),
  )

export function MetaList({ items }: { items: [string, ReactNode][] }) {
  return (
    <Box component="dl" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', margin: 0 }}>
      {items
        .filter(([, v]) => v)
        .map(([k, v]) => [
          <Text key={`${k}-k`} component="dt" size="sm" c="dimmed">
            {k}
          </Text>,
          <Text key={`${k}-v`} component="dd" size="sm" m={0} style={{ overflowWrap: 'anywhere' }}>
            {v}
          </Text>,
        ])}
    </Box>
  )
}

export function Copyable({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <Group gap={4} wrap="nowrap" align="flex-start">
      <Code block style={{ flex: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {children ?? value}
      </Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : 'Copy'}>
            <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy} aria-label="Copy">
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  )
}
