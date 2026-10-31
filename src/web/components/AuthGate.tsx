import { Alert, Button, Center, Loader, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { ApiError, api, call, errorText } from '../api'
import { useSession } from '../hooks'

// Shows the login form until /api/admin/session answers, then the app.
export function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession()
  if (session.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }
  if (session.error) {
    const err = session.error
    if (err instanceof ApiError && err.status === 401) return <Login />
    return (
      <Center h="100vh" p="md">
        <Alert color="red" title="Could not open Mailroom" maw={480}>
          {errorText(err)}
        </Alert>
      </Center>
    )
  }
  return <>{children}</>
}

function Login() {
  const client = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await call(api.login.$post({ json: { password } }))
      await client.resetQueries()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Center h="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w={360} component="form" onSubmit={submit}>
        <Stack>
          <div>
            <Title order={2}>Mailroom</Title>
            <Text c="dimmed" size="sm">
              Mail, contacts and broadcasts for your domains
            </Text>
          </div>
          {/* Lets password managers file the password under a name. */}
          <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
          <PasswordInput
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            error={error || undefined}
            required
            autoFocus
          />
          <Button type="submit" loading={busy}>
            Sign in
          </Button>
        </Stack>
      </Paper>
    </Center>
  )
}
