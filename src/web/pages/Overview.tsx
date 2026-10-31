import { Alert, Badge, Button, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core'
import { IconAddressBook, IconInbox, IconMailForward, IconSend } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { api, call } from '../api'
import { setDomain } from '../domain'
import { fmt, useScope } from '../hooks'
import { ListPanel, ListRow, PageHeader } from '../components/ui'

function Stat({ label, value, icon, to }: { label: string; value: number | undefined; icon: ReactNode; to: string }) {
  return (
    <Paper withBorder p="md" component={Link} to={to} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            {label}
          </Text>
          <Text fz={32} fw={700} lh={1.2} mt={4}>
            {value ?? '–'}
          </Text>
        </div>
        <Text c="brand">{icon}</Text>
      </Group>
    </Paper>
  )
}

export function OverviewPage() {
  const { session, domain, domainId } = useScope()
  const { data } = useQuery({ queryKey: ['stats'], queryFn: () => call(api.stats.$get()) })

  const missing = session
    ? [
        !session.canEmail && 'EMAIL — the send_email binding, to send mail',
        !session.attachments && 'BUCKET — the R2 binding: attachments of received mail are listed but not kept, and images cannot be uploaded',
      ].filter(Boolean)
    : []

  return (
    <Stack>
      <PageHeader title={domain ? domain.name : 'Overview'} />
      {missing.length > 0 && (
        <Alert color="yellow" title="Setup still missing">
          {missing.map((m) => (
            <Text key={m as string} size="sm">
              · {m}
            </Text>
          ))}
        </Alert>
      )}
      {session && !session.domains.length && (
        <Alert color="blue" title="Welcome to Mailroom">
          <Text size="sm" mb="sm">
            Start by adding a domain. Mailroom then walks you through pointing its mail here and onboarding it for sending.
          </Text>
          <Button component={Link} to="/domains" size="xs">
            Add a domain
          </Button>
        </Alert>
      )}
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Unread mail" value={data?.mail.unread} icon={<IconInbox />} to="/mail?box=unread" />
        <Stat label="Received in 7 days" value={data?.mail.receivedLast7Days} icon={<IconMailForward />} to="/mail?box=all" />
        <Stat label="Sent in 30 days" value={data?.mail.sentLast30Days} icon={<IconSend />} to="/sent" />
        <Stat label="Subscribers" value={data?.subscribers} icon={<IconAddressBook />} to="/contacts" />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, md: domainId ? 1 : 2 }}>
        <Stack gap="xs">
          <Title order={4}>Unread mail</Title>
          <ListPanel empty="No unread mail" loading={!data}>
            {(data?.recentMail ?? []).map((m) => (
              <ListRow key={m.id} to={`/mail/${m.id}`} unread who={m.fromAddr} date={m.createdAt} meta={[m.subject || '(no subject)', `to ${m.mailbox}`].join(' · ')} />
            ))}
          </ListPanel>
        </Stack>
        {!domainId && (data?.domains.length ?? 0) > 0 && (
          <Stack gap="xs">
            <Title order={4}>Domains</Title>
            <Paper withBorder style={{ overflowX: 'auto' }}>
              <Table verticalSpacing="xs" highlightOnHover>
                <Table.Tbody>
                  {data!.domains.map((d) => (
                    <Table.Tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => setDomain(d.id)}>
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {d.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {d.mailboxes} mailbox{d.mailboxes === 1 ? '' : 'es'}
                          {d.lastReceived ? ` · last mail ${fmt(d.lastReceived)}` : ' · no mail yet'}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{d.unread > 0 && <Badge>{d.unread} unread</Badge>}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
          </Stack>
        )}
      </SimpleGrid>
    </Stack>
  )
}
