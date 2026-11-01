import { Alert, Badge, Button, Group, Paper, Select, Stack, Switch, Text, TextInput, Textarea, Title } from '@mantine/core'
import { modals } from '@mantine/modals'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, call, errorText } from '../api'
import { Copyable, confirm } from '../components/ui'
import { fmt, useAction, useSession } from '../hooks'

type FormRow = {
  id: number
  publicId: string
  name: string
  segmentId: number | null
  segmentName: string | null
  allowedOrigins: string[]
  turnstileSiteKey: string
  enabled: boolean
  lastError: string
  lastErrorAt: string | null
  pending: number
}

// Cloudflare's published test site keys start like this.
const isTestKey = (siteKey: string) => /^[123]x0{5}/.test(siteKey)

const embedCode = (action: string, siteKey: string) => `<form id="mailroom-subscribe" action="${action}" method="post">
  <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required>
  <div class="cf-turnstile" data-sitekey="${siteKey}" data-action="subscribe"></div>
  <button type="submit">Subscribe</button>
  <p role="status"></p>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
(() => {
  const form = document.getElementById('mailroom-subscribe')
  const status = form.querySelector('[role=status]')
  const button = form.querySelector('button')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    button.disabled = true
    let answer = null
    try {
      const response = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
      answer = await response.json()
    } catch {}
    if (answer?.ok) {
      form.reset()
      status.textContent = 'Almost there: check your inbox and click the link to confirm.'
    } else {
      status.textContent = answer?.error === 'invalid_email' ? 'That email address is not valid.' : 'That did not work. Please try again.'
    }
    // A token works once, whatever the outcome.
    window.turnstile?.reset(form.querySelector('.cf-turnstile'))
    button.disabled = false
  })
})()
</script>`

function Editor({ form, segments, onDone }: { form: FormRow | null; segments: { value: string; label: string }[]; onDone: () => void }) {
  const [values, setValues] = useState({
    name: form?.name ?? '',
    segmentId: form?.segmentId ? String(form.segmentId) : null as string | null,
    origins: form?.allowedOrigins.join('\n') ?? '',
    siteKey: form?.turnstileSiteKey ?? '',
    secret: '',
  })
  const json = () => ({
    name: values.name,
    segmentId: Number(values.segmentId),
    allowedOrigins: values.origins.split(/\s+/).filter(Boolean),
    turnstileSiteKey: values.siteKey,
  })
  const save = useAction(
    async () => {
      if (form) await call(api.forms[':id'].$patch({ param: { id: String(form.id) }, json: { ...json(), ...(values.secret.trim() && { turnstileSecret: values.secret }) } }))
      else await call(api.forms.$post({ json: { ...json(), turnstileSecret: values.secret } }))
      return true
    },
    { invalidate: [['forms']], success: 'Form saved' },
  )
  return (
    <Paper
      withBorder
      p="sm"
      component="form"
      onSubmit={async (e) => {
        e.preventDefault()
        if (await save.mutateAsync().catch(() => null)) onDone()
      }}
    >
      <Stack gap="xs">
        <TextInput label="Name" placeholder="Website footer" value={values.name} onChange={(e) => setValues({ ...values, name: e.currentTarget.value })} maxLength={100} required />
        <Select label="Segment" description="Who confirms joins this segment" data={segments} value={values.segmentId} onChange={(v) => setValues({ ...values, segmentId: v })} required allowDeselect={false} />
        <Textarea
          label="Websites"
          description="One per line, as in the address bar: https://example.com (www is a separate one). Add http://localhost:port only while testing, and remove it afterwards."
          placeholder="https://example.com"
          autosize
          minRows={2}
          value={values.origins}
          onChange={(e) => setValues({ ...values, origins: e.currentTarget.value })}
          required
        />
        <TextInput
          label="Turnstile site key"
          description="Add a widget under Turnstile in the Cloudflare dashboard, with the same websites' hostnames"
          value={values.siteKey}
          onChange={(e) => setValues({ ...values, siteKey: e.currentTarget.value })}
          required
        />
        <TextInput
          label="Turnstile secret key"
          description={form ? 'Leave empty to keep the current one' : 'Stored encrypted, and never shown again'}
          type="password"
          autoComplete="off"
          value={values.secret}
          onChange={(e) => setValues({ ...values, secret: e.currentTarget.value })}
          required={!form}
        />
        <Group gap="xs">
          <Button type="submit" loading={save.isPending} disabled={!values.segmentId}>
            Save form
          </Button>
          <Button variant="subtle" color="gray" onClick={onDone}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Paper>
  )
}

// Forms on other websites that people can subscribe through.
export function SignupForms() {
  const { data: session } = useSession()
  const forms = useQuery({ queryKey: ['forms'], queryFn: () => call(api.forms.$get()) })
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => call(api.segments.$get()) })
  const options = (segments.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const invalidate = { invalidate: [['forms']] }
  const toggle = useAction(({ id, enabled }: { id: number; enabled: boolean }) => call(api.forms[':id'].$patch({ param: { id: String(id) }, json: { enabled } })), invalidate)
  const remove = useAction((id: number) => call(api.forms[':id'].$delete({ param: { id: String(id) } })), { ...invalidate, success: 'Form deleted' })

  const showCode = (f: FormRow) =>
    modals.open({
      title: `Embed “${f.name}”`,
      size: 'xl',
      children: (
        <Stack>
          <Text size="sm">Paste this into your website. It needs no server and holds no secret; style it as you like. Fields firstName and lastName are also accepted.</Text>
          <Copyable value={embedCode(`${session?.publicUrl ?? ''}/subscribe/${f.publicId}`, f.turnstileSiteKey)} />
        </Stack>
      ),
    })

  return (
    <Paper withBorder p="lg">
      <Group justify="space-between" gap="xs">
        <Title order={4}>Sign-up forms</Title>
        {editing === null && (
          <Button size="xs" variant="default" onClick={() => setEditing('new')}>
            New form
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        Let people subscribe from another website. Turnstile keeps bots out, and nobody joins a segment until they click the link in a confirmation email.
      </Text>
      <Stack gap="xs">
        {editing === 'new' && <Editor form={null} segments={options} onDone={() => setEditing(null)} />}
        {(forms.data?.items ?? []).map((f) =>
          editing === f.id ? (
            <Editor key={f.id} form={f} segments={options} onDone={() => setEditing(null)} />
          ) : (
            <Paper key={f.id} withBorder p="sm">
              <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Group gap={6}>
                    <Text size="sm" fw={600}>
                      {f.name}
                    </Text>
                    {isTestKey(f.turnstileSiteKey) && (
                      <Badge size="xs" color="yellow" variant="light">
                        Test keys: local pages only
                      </Badge>
                    )}
                  </Group>
                  <Switch size="sm" checked={f.enabled} onChange={(e) => toggle.mutate({ id: f.id, enabled: e.currentTarget.checked })} aria-label="Taking submissions" />
                </Group>
                <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                  {f.segmentName ? `Joins “${f.segmentName}”` : 'No segment'} · {f.pending} waiting to confirm · {f.allowedOrigins.join(', ')}
                </Text>
                {!f.segmentId && <Alert color="red" p="xs">Its segment was deleted, so it is taking no submissions. Choose another one.</Alert>}
                {f.lastError && (
                  <Alert color="red" p="xs">
                    {f.lastError} ({fmt(f.lastErrorAt ?? '')})
                  </Alert>
                )}
                <Group gap="xs">
                  <Button size="compact-sm" variant="default" onClick={() => showCode(f)}>
                    Embed code
                  </Button>
                  <Button size="compact-sm" variant="subtle" onClick={() => setEditing(f.id)}>
                    Edit
                  </Button>
                  <Button
                    size="compact-sm"
                    variant="subtle"
                    color="red"
                    ml="auto"
                    onClick={async () => (await confirm(`Delete “${f.name}”?`, 'The form stops working on your website, and links not yet clicked stop working too. Contacts stay.', { danger: true, label: 'Delete' })) && remove.mutate(f.id)}
                  >
                    Delete
                  </Button>
                </Group>
              </Stack>
            </Paper>
          ),
        )}
      </Stack>
      {forms.error && <Text c="red" size="sm">{errorText(forms.error)}</Text>}
    </Paper>
  )
}
