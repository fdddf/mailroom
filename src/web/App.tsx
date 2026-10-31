import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import { MantineProvider } from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router'
import { AuthGate } from './components/AuthGate'
import { Shell } from './components/Shell'
import { queryClient } from './hooks'
import { cssVariablesResolver, theme } from './theme'

export default function App() {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="auto">
      <ModalsProvider labels={{ confirm: 'Confirm', cancel: 'Cancel' }}>
        <Notifications position="top-right" />
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthGate>
              <Shell />
            </AuthGate>
          </BrowserRouter>
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>
  )
}
