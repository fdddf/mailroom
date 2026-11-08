import { Badge, Button, Group, Skeleton, Stack, Switch, Text, TextInput, Title } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, call, errorText } from '../api'
import { useAction, useDomainName, useScope } from '../hooks'
import { BodyEditor, type BodyFormat } from '../components/editor'
import { useSignatures } from '../components/files'
import { useTab, useTabTitle } from '../components/tabs'
import { ListPanel, ListRow, MasterDetail, PageHeader, confirm } from '../components/ui'

// Signatures, added under emails written in Compose and replies. A mailbox
// can start with one (see Mailboxes).
export function SignaturesPage() {
  const { id } = useParams()
  const list = useSignatures()
  const domainName = useDomainName()

  const listView = (
    <Stack gap="sm">
      <ListPanel empty="No signatures yet" loading={list.isPending}>
        {(list.data?.items ?? []).map((s) => (
          <ListRow
            key={s.id}
            to={`/signatures/${s.id}`}
            active={String(s.id) === id}
            who={s.name}
            date={s.updatedAt}
            meta={
              <Group gap={6} component="span">
                <Badge size="xs" variant="light" color={s.format === 'html' ? 'brand' : 'gray'}>
                  {s.format === 'html' ? 'HTML' : 'Text'}
                </Badge>
                {s.domainId ? domainName(s.domainId) : 'all domains'}
              </Group>
            }
          />
        ))}
      </ListPanel>
      {list.error && <Text c="red" size="sm">{errorText(list.error)}</Text>}
      <Text size="xs" c="dimmed">
        Pick one each time you write, or give a mailbox one to start with under Mailboxes.
      </Text>
    </Stack>
  )

  return (
    <>
      <PageHeader title="Signatures">
        <Button component={Link} to="/signatures/new" leftSection={<IconPlus size={16} />}>
          New signature
        </Button>
      </PageHeader>
      <MasterDetail list={listView} backTo="/signatures" detail={id === 'new' ? <Editor key="new" id={null} /> : id ? <Loaded key={id} id={id} /> : null} />
    </>
  )
}

function Loaded({ id }: { id: string }) {
  const { data, isPending, error } = useQuery({ queryKey: ['signature', id], queryFn: () => call(api.signatures[':id'].$get({ param: { id } })) })
  useTabTitle(data?.name)
  if (isPending) return <Skeleton h={240} />
  if (error) return <Text c="red">{errorText(error)}</Text>
  return <Editor id={id} initial={data} />
}

function Editor({ id, initial }: { id: string | null; initial?: { name: string; format: BodyFormat; body: string; domainId: number | null } }) {
  const navigate = useNavigate()
  const tab = useTab()
  const { domain } = useScope()
  const domainName = useDomainName()
  const wasShared = initial ? initial.domainId === null : !domain
  const [form, setForm] = useState({ name: initial?.name ?? '', format: initial?.format ?? ('text' as BodyFormat), body: initial?.body ?? '', shared: wasShared })
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }))

  const { shared, ...fields } = form
  const save = useAction(
    () =>
      id
        ? call(api.signatures[':id'].$patch({ param: { id }, json: { ...fields, ...(shared !== wasShared && { shared }) } }))
        : call(api.signatures.$post({ json: form })),
    { invalidate: [['signatures'], ['signature', id]], success: 'Signature saved' },
  )
  const remove = useAction(() => call(api.signatures[':id'].$delete({ param: { id: id! } })), { invalidate: [['signatures'], ['mailboxes']], success: 'Signature deleted' })

  const submit = async () => {
    const result = await save.mutateAsync().catch(() => null)
    if (result && !id) navigate(`/signatures/${result.id}`, { replace: true })
  }

  return (
    <Stack>
      <Title order={3}>{id ? 'Edit signature' : 'New signature'}</Title>
      <TextInput label="Name" description="Only you see this" value={form.name} onChange={(e) => set('name', e.currentTarget.value)} maxLength={100} required />
      <Switch
        label="Shared by all domains"
        description={
          form.shared
            ? 'Offered when writing for any domain'
            : `Only offered for ${initial?.domainId && wasShared === form.shared ? domainName(initial.domainId) : (domain?.name ?? 'the picked domain')}`
        }
        checked={form.shared}
        disabled={!domain && !(initial && !wasShared)}
        onChange={(e) => set('shared', e.currentTarget.checked)}
      />
      <BodyEditor
        label="Signature"
        description="Goes under the message, after a “-- ” line in the plain-text version. An HTML signature makes the email HTML."
        format={form.format}
        onFormat={(f) => set('format', f)}
        value={form.body}
        onChange={(v) => set('body', v)}
        minRows={6}
        onSubmit={submit}
      />
      <Group gap="xs">
        <Button onClick={submit} loading={save.isPending} disabled={!form.name.trim()}>
          Save signature
        </Button>
        {id && (
          <Button
            variant="subtle"
            color="red"
            ml="auto"
            onClick={async () => {
              if (!(await confirm('Delete this signature?', 'Mailboxes that start with it will start with none. Emails already sent keep it.', { danger: true, label: 'Delete' }))) return
              await remove.mutateAsync()
              if (tab?.solo) tab.close()
              else navigate('/signatures')
            }}
          >
            Delete
          </Button>
        )}
      </Group>
    </Stack>
  )
}
