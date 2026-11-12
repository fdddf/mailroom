import { ActionIcon, Badge, Button, Group, Modal, Paper, PasswordInput, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconPencil, IconPlugConnected, IconStar, IconStarFilled, IconTrash } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, call, errorText } from '../api'
import { useAction } from '../hooks'
import { PageHeader, confirm } from '../components/ui'

type Kind = 'anthropic' | 'openai'
const KINDS: Record<Kind, { label: string; endpoint: string }> = {
  anthropic: { label: 'Claude (Anthropic API)', endpoint: 'https://api.anthropic.com' },
  openai: { label: 'OpenAI-compatible', endpoint: 'https://api.openai.com/v1' },
}
type Form = { id: number | null; name: string; kind: Kind; baseUrl: string; model: string; apiKey: string }
const blank: Form = { id: null, name: '', kind: 'anthropic', baseUrl: '', model: '', apiKey: '' }

// Providers for the writing assistant ("Write with AI" in the editors).
export function AiPage() {
  const list = useQuery({ queryKey: ['ai-providers'], queryFn: () => call(api.ai.providers.$get()) })
  const [form, setForm] = useState<Form | null>(null)
  const [testing, setTesting] = useState<number | null>(null)
  const invalidate = { invalidate: [['ai-providers']] }

  const save = useAction(
    async (f: Form) => {
      const json = { name: f.name, kind: f.kind, baseUrl: f.baseUrl, model: f.model }
      if (f.id) await call(api.ai.providers[':id'].$patch({ param: { id: String(f.id) }, json: { ...json, ...(f.apiKey && { apiKey: f.apiKey }) } }))
      else await call(api.ai.providers.$post({ json: { ...json, apiKey: f.apiKey } }))
      return true
    },
    { ...invalidate, success: 'Saved' },
  )
  const makeDefault = useAction((id: number) => call(api.ai.providers[':id'].$patch({ param: { id: String(id) }, json: { isDefault: true } })), invalidate)
  const remove = useAction((id: number) => call(api.ai.providers[':id'].$delete({ param: { id: String(id) } })), { ...invalidate, success: 'Removed' })

  const test = async (id: number) => {
    setTesting(id)
    try {
      const r = await call(api.ai.providers[':id'].test.$post({ param: { id: String(id) }, json: {} }))
      notifications.show({ color: 'teal', title: 'It works', message: `The model answered: ${r.reply}` })
    } catch (err) {
      notifications.show({ color: 'red', title: 'Test failed', message: errorText(err) })
    } finally {
      setTesting(null)
    }
  }

  const defaults = list.data?.defaults
  const editing = form?.id != null

  return (
    <Stack>
      <PageHeader title="AI">
        <Button onClick={() => setForm(blank)}>Add provider</Button>
      </PageHeader>
      <Text size="sm" c="dimmed">
        The writing assistant drafts and rewrites emails and templates with the provider you set up here: Claude through the Anthropic API, or any service
        with an OpenAI-compatible API. What you ask it, the draft in the editor and (for a reply) the email being answered are sent to that provider. API
        keys are stored encrypted and never shown again.
      </Text>

      <Paper withBorder style={{ overflowX: 'auto' }}>
        <Table verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Model</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(list.data?.items ?? []).map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Text size="sm" fw={600}>
                      {p.name}
                    </Text>
                    {p.isDefault && (
                      <Badge size="sm" variant="light">
                        Default
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{p.kind === 'anthropic' ? 'Claude' : 'OpenAI-compatible'}</Text>
                  {p.baseUrl && (
                    <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                      {p.baseUrl}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" ff="monospace">
                    {p.model}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <Tooltip label="Test the connection">
                      <ActionIcon variant="subtle" loading={testing === p.id} onClick={() => test(p.id)} aria-label="Test">
                        <IconPlugConnected size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Edit">
                      <ActionIcon variant="subtle" onClick={() => setForm({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model, apiKey: '' })} aria-label="Edit">
                        <IconPencil size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={p.isDefault ? 'Default provider' : 'Make default'}>
                      <ActionIcon variant="subtle" disabled={p.isDefault} onClick={() => makeDefault.mutate(p.id)} aria-label="Make default">
                        {p.isDefault ? <IconStarFilled size={16} /> : <IconStar size={16} />}
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Remove">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label="Remove"
                        onClick={async () => (await confirm(`Remove ${p.name}?`, 'Its API key is deleted from here.', { danger: true, label: 'Remove' })) && remove.mutate(p.id)}
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
            No provider yet. Add one to get “Write with AI” in the editors.
          </Text>
        )}
        {list.error && <Text c="red" size="sm" p="md">{errorText(list.error)}</Text>}
      </Paper>

      <Modal opened={form !== null} onClose={() => setForm(null)} title={editing ? 'Edit provider' : 'Add provider'}>
        {form && (
          <Stack
            component="form"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await save.mutateAsync(form).catch(() => null)) setForm(null)
            }}
          >
            <Select
              label="Type"
              data={Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label }))}
              value={form.kind}
              onChange={(v) => v && setForm({ ...form, kind: v as Kind })}
              allowDeselect={false}
            />
            <TextInput label="Name" placeholder={form.kind === 'anthropic' ? 'Claude' : 'e.g. OpenAI, DeepSeek, OpenRouter'} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} maxLength={60} required />
            <PasswordInput
              label="API key"
              description={editing ? 'Leave empty to keep the stored key' : undefined}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.currentTarget.value })}
              required={!editing}
              autoComplete="off"
            />
            <TextInput
              label="Model"
              description={defaults ? `Leave empty for ${defaults[form.kind]}` : undefined}
              placeholder={defaults?.[form.kind]}
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.currentTarget.value })}
              maxLength={100}
            />
            <TextInput
              label="API base URL"
              description={form.kind === 'openai' ? 'The address that /chat/completions is appended to' : 'Only for a proxy or gateway; leave empty for the Anthropic API'}
              placeholder={KINDS[form.kind].endpoint}
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.currentTarget.value })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                Save
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  )
}
