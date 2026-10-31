import { Badge, Button, Group, Skeleton, Stack, Switch, Text, TextInput, Title } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, call, errorText } from '../api'
import { useAction, useDomainName, useScope } from '../hooks'
import { AiAssist, BodyEditor, type BodyFormat } from '../components/editor'
import { useTab, useTabTitle } from '../components/tabs'
import { ListPanel, ListRow, MasterDetail, PageHeader, confirm } from '../components/ui'

// Reusable emails: write one once (or have the AI write it), then start
// Compose or a broadcast from it.
export function TemplatesPage() {
  const { id } = useParams()
  const list = useQuery({ queryKey: ['templates'], queryFn: () => call(api.templates.$get()) })
  const domainName = useDomainName()

  const listView = (
    <Stack gap="sm">
      <ListPanel empty="No templates yet" loading={list.isPending}>
        {(list.data?.items ?? []).map((t) => (
          <ListRow
            key={t.id}
            to={`/templates/${t.id}`}
            active={String(t.id) === id}
            who={t.name}
            date={t.updatedAt}
            meta={
              <Group gap={6} component="span">
                <Badge size="xs" variant="light" color={t.format === 'html' ? 'brand' : 'gray'}>
                  {t.format === 'html' ? 'HTML' : 'Text'}
                </Badge>
                {t.subject || '(no subject)'}
                {` · ${t.domainId ? domainName(t.domainId) : 'all domains'}`}
              </Group>
            }
          />
        ))}
      </ListPanel>
      {list.error && <Text c="red" size="sm">{errorText(list.error)}</Text>}
      <Text size="xs" c="dimmed">
        In a broadcast, {'{{first_name}}'}, {'{{last_name}}'} and {'{{email}}'} are filled in for each subscriber.
      </Text>
    </Stack>
  )

  return (
    <>
      <PageHeader title="Templates">
        <Button component={Link} to="/templates/new" leftSection={<IconPlus size={16} />}>
          New template
        </Button>
      </PageHeader>
      <MasterDetail list={listView} backTo="/templates" detail={id === 'new' ? <Editor key="new" id={null} /> : id ? <Loaded key={id} id={id} /> : null} />
    </>
  )
}

function Loaded({ id }: { id: string }) {
  const { data, isPending, error } = useQuery({ queryKey: ['template', id], queryFn: () => call(api.templates[':id'].$get({ param: { id } })) })
  useTabTitle(data?.name)
  if (isPending) return <Skeleton h={240} />
  if (error) return <Text c="red">{errorText(error)}</Text>
  return <Editor id={id} initial={data} />
}

function Editor({ id, initial }: { id: string | null; initial?: { name: string; subject: string; format: BodyFormat; body: string; domainId: number | null } }) {
  const navigate = useNavigate()
  const tab = useTab()
  const { domain } = useScope()
  const domainName = useDomainName()
  const wasShared = initial ? initial.domainId === null : !domain
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    subject: initial?.subject ?? '',
    format: initial?.format ?? ('html' as BodyFormat),
    body: initial?.body ?? '',
    shared: wasShared,
  })
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }))

  // Sharing is only sent when it changes: making it domain-only puts it in the picked domain.
  const { shared, ...fields } = form
  const save = useAction(
    () =>
      id
        ? call(api.templates[':id'].$patch({ param: { id }, json: { ...fields, ...(shared !== wasShared && { shared }) } }))
        : call(api.templates.$post({ json: form })),
    { invalidate: [['templates'], ['template', id]], success: 'Template saved' },
  )
  const remove = useAction(() => call(api.templates[':id'].$delete({ param: { id: id! } })), { invalidate: [['templates']], success: 'Template deleted' })

  const submit = async () => {
    const result = await save.mutateAsync().catch(() => null)
    if (result && !id) navigate(`/templates/${result.id}`, { replace: true })
  }

  return (
    <Stack>
      <Title order={3}>{id ? 'Edit template' : 'New template'}</Title>
      <TextInput label="Name" description="Only you see this" value={form.name} onChange={(e) => set('name', e.currentTarget.value)} maxLength={100} required />
      <TextInput label="Subject" value={form.subject} onChange={(e) => set('subject', e.currentTarget.value)} maxLength={300} />
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
        label="Body"
        format={form.format}
        onFormat={(f) => set('format', f)}
        value={form.body}
        onChange={(v) => set('body', v)}
        minRows={14}
        tools={
          <AiAssist
            purpose="template"
            format={form.format}
            current={{ subject: form.subject, body: form.body }}
            onApply={(d) => setForm((f) => ({ ...f, subject: d.subject || f.subject, body: d.body }))}
          />
        }
      />
      <Group gap="xs">
        <Button onClick={submit} loading={save.isPending} disabled={!form.name.trim()}>
          Save template
        </Button>
        {id && (
          <Button
            variant="subtle"
            color="red"
            ml="auto"
            onClick={async () => {
              if (!(await confirm('Delete this template?', 'Emails already written from it are not affected.', { danger: true, label: 'Delete' }))) return
              await remove.mutateAsync()
              if (tab?.solo) tab.close()
              else navigate('/templates')
            }}
          >
            Delete
          </Button>
        )}
      </Group>
    </Stack>
  )
}
