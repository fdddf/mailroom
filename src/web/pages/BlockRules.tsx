import { ActionIcon, Badge, Button, Group, Paper, Select, Stack, Switch, Text, TextInput } from '@mantine/core'
import { IconTrash } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, call, errorText } from '../api'
import { useAction, useDomainName, useScope } from '../hooks'
import { ListPanel, PageHeader } from '../components/ui'

type Kind = 'address' | 'domain' | 'keyword'
const KINDS: { value: Kind; label: string; hint: string; placeholder: string }[] = [
  { value: 'address', label: 'Sender address', hint: 'This exact address', placeholder: 'scammer@example.com' },
  { value: 'domain', label: 'Sender domain', hint: 'Anyone at this domain, and its subdomains', placeholder: 'example.com' },
  { value: 'keyword', label: 'Word or phrase', hint: 'In the subject or body, any case', placeholder: 'late husband' },
]

// What the inbox keeps out: mail that matches goes straight to Archived, read
// and without a notification, webhook or forward. Nothing is deleted.
export function BlockRulesPage() {
  const { domain } = useScope()
  const domainName = useDomainName()
  const list = useQuery({ queryKey: ['block-rules'], queryFn: () => call(api['block-rules'].$get()) })
  const [kind, setKind] = useState<Kind>('keyword')
  const [value, setValue] = useState('')
  const [shared, setShared] = useState(false)
  const current = KINDS.find((k) => k.value === kind)!

  const add = useAction(() => call(api['block-rules'].$post({ json: { kind, value, shared: shared || !domain } })), {
    invalidate: [['block-rules']],
    success: 'Rule added',
  })
  const remove = useAction((id: number) => call(api['block-rules'][':id'].$delete({ param: { id: String(id) } })), { invalidate: [['block-rules']] })
  const submit = () => add.mutate(undefined, { onSuccess: () => setValue('') })

  return (
    <>
      <PageHeader title="Spam filter" />
      <Stack>
        <Text size="sm" c="dimmed">
          Mail that matches a rule is filed under Archived, already read, with no push notification, webhook or forward. Nothing is deleted, so a wrong catch is one click away.
        </Text>
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Group align="flex-end" wrap="wrap">
              <Select label="Block" data={KINDS.map(({ value, label }) => ({ value, label }))} value={kind} onChange={(v) => v && setKind(v as Kind)} allowDeselect={false} w={180} />
              <TextInput
                label="Matching"
                description={current.hint}
                placeholder={current.placeholder}
                value={value}
                onChange={(e) => setValue(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && value.trim() && submit()}
                maxLength={200}
                style={{ flex: 1, minWidth: 200 }}
              />
              <Button onClick={submit} loading={add.isPending} disabled={!value.trim()}>
                Add rule
              </Button>
            </Group>
            {domain && <Switch label="For all domains" description={`Otherwise only mail to ${domain.name}`} checked={shared} onChange={(e) => setShared(e.currentTarget.checked)} />}
            {add.error && <Text c="red" size="sm">{errorText(add.error)}</Text>}
          </Stack>
        </Paper>
        <ListPanel empty="No rules yet" loading={list.isPending}>
          {(list.data?.items ?? []).map((r) => (
            <Group key={r.id} justify="space-between" wrap="nowrap" p="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
              <Stack gap={2} miw={0}>
                <Group gap={6} wrap="nowrap">
                  <Badge size="xs" variant="light" color="gray">
                    {KINDS.find((k) => k.value === r.kind)?.label}
                  </Badge>
                  <Text fw={500} truncate>{r.value}</Text>
                </Group>
                <Text size="xs" c="dimmed">
                  {r.domainId ? domainName(r.domainId) : 'all domains'} · caught {r.hits}
                </Text>
              </Stack>
              <ActionIcon variant="subtle" color="red" aria-label="Remove rule" onClick={() => remove.mutate(r.id)}>
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
        </ListPanel>
        {list.error && <Text c="red" size="sm">{errorText(list.error)}</Text>}
      </Stack>
    </>
  )
}
