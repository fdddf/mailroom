import { ActionIcon, AppShell, Badge, Burger, CloseButton, Divider, Group, Indicator, NavLink, ScrollArea, Select, Tabs, Text, Tooltip, useComputedColorScheme, useMantineColorScheme, type NavLinkProps } from '@mantine/core'
import { useDisclosure, useLocalStorage, useMediaQuery } from '@mantine/hooks'
import {
  IconAddressBook,
  IconAt,
  IconInbox,
  IconLayoutDashboard,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMoon,
  IconWorld,
  IconPencil,
  IconPhoto,
  IconSend,
  IconSparkles,
  IconSpeakerphone,
  IconSun,
  IconTemplate,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, call } from '../api'
import { setDomain, useDomainId } from '../domain'
import { useSession } from '../hooks'
import { BroadcastsPage } from '../pages/Broadcasts'
import { ComposePage } from '../pages/Compose'
import { ContactsPage } from '../pages/Contacts'
import { DomainsPage } from '../pages/Domains'
import { InboxPage } from '../pages/Inbox'
import { MailboxesPage } from '../pages/Mailboxes'
import { MediaPage } from '../pages/Media'
import { OverviewPage } from '../pages/Overview'
import { SentPage } from '../pages/Sent'
import { AiPage } from '../pages/Ai'
import { TemplatesPage } from '../pages/Templates'
import { TabContext } from './tabs'
import classes from '../dashboard.module.css'

type Section = { to: string; label: string; icon: typeof IconInbox; badge?: 'mail'; route: string; page: ReactNode }

// The sidebar, in groups. Each section opens as a tab on the right.
const GROUPS: { label: string; sections: Section[] }[] = [
  {
    label: 'Mail',
    sections: [
      { to: '/', label: 'Overview', icon: IconLayoutDashboard, route: '/', page: <OverviewPage /> },
      { to: '/mail', label: 'Inbox', icon: IconInbox, badge: 'mail', route: '/mail/:id?', page: <InboxPage /> },
      { to: '/sent', label: 'Sent', icon: IconSend, route: '/sent/:id?', page: <SentPage /> },
      { to: '/compose', label: 'Compose', icon: IconPencil, route: '/compose', page: <ComposePage /> },
      { to: '/templates', label: 'Templates', icon: IconTemplate, route: '/templates/:id?', page: <TemplatesPage /> },
      { to: '/images', label: 'Images', icon: IconPhoto, route: '/images', page: <MediaPage /> },
    ],
  },
  {
    label: 'Marketing',
    sections: [
      { to: '/broadcasts', label: 'Broadcasts', icon: IconSpeakerphone, route: '/broadcasts/:id?', page: <BroadcastsPage /> },
      { to: '/contacts', label: 'Contacts', icon: IconAddressBook, route: '/contacts', page: <ContactsPage /> },
    ],
  },
  {
    label: 'Settings',
    sections: [
      { to: '/domains', label: 'Domains', icon: IconWorld, route: '/domains/:id?', page: <DomainsPage /> },
      { to: '/mailboxes', label: 'Mailboxes', icon: IconAt, route: '/mailboxes', page: <MailboxesPage /> },
      { to: '/ai', label: 'AI', icon: IconSparkles, route: '/ai', page: <AiPage /> },
    ],
  },
]
const SECTIONS = GROUPS.flatMap((g) => g.sections)
const sectionOf = (pathname: string) => SECTIONS.find(({ to }) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)))

// An open tab. A section tab (key = the section's path) follows you around
// that section, so `at` is wherever it was left, query included. A solo tab
// (key = the item's path, e.g. /mail/12) holds that one item.
type OpenTab = { key: string; at: string; solo?: boolean; title?: string }
const STORAGE_KEY = 'mailroom_tabs'
const storedTabs = (): OpenTab[] => {
  try {
    const tabs = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]') as OpenTab[]
    return tabs.filter((t) => (t.solo ? sectionOf(t.key) && t.at === t.key : sectionOf(t.at.split('?')[0]!)?.to === t.key))
  } catch {
    return []
  }
}
const save = (tabs: OpenTab[]) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs))
  } catch {
    // Private mode: tabs just do not survive a reload.
  }
}

// A sidebar entry. On the icon rail its name moves into a tooltip.
function NavItem({ rail, label, tooltip = label, ...props }: NavLinkProps & { rail: boolean; label: string; tooltip?: string; component?: 'button'; onClick: () => void; 'aria-expanded'?: boolean }) {
  return (
    <Tooltip label={tooltip} position="right" disabled={!rail}>
      <NavLink
        {...props}
        label={rail ? undefined : label}
        aria-label={rail ? tooltip : undefined}
        className={rail ? classes.railLink : undefined}
        variant="light"
        style={{ borderRadius: 'var(--mantine-radius-md)' }}
      />
    </Tooltip>
  )
}

export function Shell() {
  const [opened, { toggle, close }] = useDisclosure()
  const [collapsed, setCollapsed] = useLocalStorage({ key: 'mailroom_sidebar_collapsed', defaultValue: false, getInitialValueInEffect: false })
  // Only beside the page: the phone's menu covers the screen and has room for names.
  const wide = useMediaQuery('(min-width: 48em)', true, { getInitialValueInEffect: false })
  const rail = collapsed && wide
  const { data: session } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { setColorScheme } = useMantineColorScheme()
  const scheme = useComputedColorScheme('light')
  const [stored, setStored] = useState(storedTabs)
  // The tab being closed, until the URL has moved off it.
  const [closing, setClosing] = useState<string | null>(null)

  const section = sectionOf(location.pathname)
  const here = location.pathname + location.search
  // An item with a tab of its own shows there; anything else in its section's tab.
  const soloHere = stored.some((t) => t.solo && t.key === location.pathname)
  const activeKey = soloHere ? location.pathname : section?.to
  // The tabs, with the current URL folded into its tab (opening it if new).
  const tabs = useMemo((): OpenTab[] => {
    if (!section || soloHere || section.to === closing) return stored
    const current = { key: section.to, at: here }
    return stored.some((t) => t.key === section.to) ? stored.map((t) => (t.key === section.to ? current : t)) : [...stored, current]
  }, [stored, section, soloHere, here, closing])
  useEffect(() => {
    if (closing && activeKey !== closing) setClosing(null)
    if (JSON.stringify(tabs) === JSON.stringify(stored)) return
    setStored(tabs)
    save(tabs)
  }, [tabs, stored, closing, activeKey])

  // Another domain: everything on screen is refetched for it.
  const domainId = useDomainId()
  const firstDomain = useRef(domainId)
  useEffect(() => {
    if (firstDomain.current === domainId) return
    firstDomain.current = domainId
    client.resetQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    client.invalidateQueries({ queryKey: ['session'] })
  }, [domainId, client])
  // A stored domain that is gone: back to all of them.
  useEffect(() => {
    // By the list, not session.domainId: that still names the old domain until
    // the refetch for a domain just picked comes back.
    if (session && domainId && !session.domains.some((d) => d.id === domainId)) setDomain(null)
  }, [session, domainId])

  const logout = async () => {
    await call(api.logout.$post({ json: {} })).catch(() => {})
    await client.resetQueries()
  }

  const update = (next: OpenTab[]) => {
    setStored(next)
    save(next)
  }
  // The sidebar and the tab bar bring a tab to the front where it was left;
  // the sidebar entry of the section already in front goes to its start page.
  const show = (key: string) => {
    navigate(key === activeKey && key === section?.to ? key : (tabs.find((t) => t.key === key)?.at ?? key))
    close()
  }
  const closeTab = (key: string) => {
    const rest = tabs.filter((t) => t.key !== key)
    update(rest)
    if (key !== activeKey) return
    setClosing(key)
    navigate(rest[Math.max(0, tabs.findIndex((t) => t.key === key) - 1)]?.at ?? '/')
  }
  const openSolo = (path: string, background = false) => {
    const home = sectionOf(path)
    if (!home || path === home.to) return
    update([
      // Its section's tab lets go of the item, back to the list.
      ...tabs.map((t) => (t.key === home.to && t.at.split('?')[0] === path ? { ...t, at: home.to + (t.at.includes('?') ? `?${t.at.split('?')[1]}` : '') } : t)),
      ...(tabs.some((t) => t.key === path) ? [] : [{ key: path, at: path, solo: true }]),
    ])
    if (!background) navigate(path)
    else if (location.pathname === path) navigate(home.to + location.search)
  }
  const setTitle = (key: string, title: string) => {
    if (tabs.some((t) => t.key === key && t.title !== title)) update(tabs.map((t) => (t.key === key ? { ...t, title } : t)))
  }

  if (!section || !activeKey) return <Navigate to="/" replace />

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: collapsed ? 60 : 220, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ flexShrink: 0 }}>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <img src="/logo.svg" alt="" width={24} height={24} />
            <Text fw={700} visibleFrom="xs">
              Mailroom
            </Text>
          </Group>
          {/* On the narrowest phones the domain picker gives way, not the buttons. */}
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Select
              aria-label="Domain"
              leftSection={<IconWorld size={16} />}
              w={{ base: 170, sm: 240 }}
              style={{ minWidth: 0 }}
              data={[{ value: '', label: 'All domains' }, ...(session?.domains ?? []).map((d) => ({ value: String(d.id), label: d.name }))]}
              value={domainId ? String(domainId) : ''}
              onChange={(v) => setDomain(v ? Number(v) : null)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
            />
            <Tooltip label={scheme === 'dark' ? 'Light mode' : 'Dark mode'}>
              <ActionIcon variant="default" size="lg" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle color scheme">
                {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Sign out">
              <ActionIcon variant="default" size="lg" onClick={logout} aria-label="Sign out">
                <IconLogout size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar>
        {/* Scrolls on its own: the menu is taller than a short window. */}
        <AppShell.Section grow component={ScrollArea} p="xs">
          {GROUPS.map((group, i) => (
            <Fragment key={group.label}>
              {!rail ? <Text className={classes.navLabel}>{group.label}</Text> : i > 0 && <Divider my={6} />}
              {group.sections.map(({ to, label, icon: Icon, badge }) => {
                const n = badge ? session?.counts[badge] : 0
                return (
                  <NavItem
                    key={to}
                    rail={rail}
                    label={label}
                    tooltip={n ? `${label} (${n})` : label}
                    leftSection={
                      <Indicator disabled={!rail || !n} size={8} offset={1}>
                        <Icon size={18} stroke={1.6} style={{ display: 'block' }} />
                      </Indicator>
                    }
                    rightSection={!rail && n ? <Badge size="sm" circle={n < 10}>{n}</Badge> : null}
                    active={to === section.to}
                    onClick={() => show(to)}
                  />
                )
              })}
            </Fragment>
          ))}
        </AppShell.Section>
        <AppShell.Section p="xs" visibleFrom="sm" style={{ borderTop: '1px solid var(--app-shell-border-color)' }}>
          <NavItem
            component="button"
            rail={rail}
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            leftSection={collapsed ? <IconLayoutSidebarLeftExpand size={18} stroke={1.6} /> : <IconLayoutSidebarLeftCollapse size={18} stroke={1.6} />}
            onClick={() => setCollapsed((c) => !c)}
          />
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Tabs value={activeKey} onChange={(key) => key && show(key)} className={classes.tabBar}>
          <Tabs.List>
            {tabs.map((tab) => {
              const { label, icon: Icon } = sectionOf(tab.key)!
              const title = tab.solo ? tab.title || `${label} #${tab.key.split('/').pop()}` : label
              return (
                <Tabs.Tab
                  key={tab.key}
                  value={tab.key}
                  title={title}
                  leftSection={<Icon size={16} stroke={1.6} />}
                  rightSection={
                    tabs.length > 1 && (
                      <CloseButton
                        component="span"
                        size="xs"
                        aria-label={`Close ${title}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          closeTab(tab.key)
                        }}
                      />
                    )
                  }
                >
                  <span className={classes.tabTitle}>{title}</span>
                </Tabs.Tab>
              )
            })}
          </Tabs.List>
        </Tabs>

        {/* Every open tab stays mounted, each at its own URL, so a draft or a
            scroll position is still there when you come back to it. */}
        {tabs.map((tab) => {
          const home = sectionOf(tab.key)!
          return (
            <div key={tab.key} hidden={tab.key !== activeKey}>
              <TabContext.Provider value={{ solo: Boolean(tab.solo), openSolo, close: () => closeTab(tab.key), setTitle: (title) => setTitle(tab.key, title) }}>
                <Routes location={tab.at}>
                  <Route path={home.route} element={home.page} />
                </Routes>
              </TabContext.Provider>
            </div>
          )
        })}
      </AppShell.Main>
    </AppShell>
  )
}
