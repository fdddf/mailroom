import { AppShell, createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core'

// Tech blue (#2563eb fill / #6097fa accent on dark), as an even ramp from
// light to dark so tints, hovers and outlines step smoothly.
const brand: MantineColorsTuple = [
  '#eff5ff', '#dbe8fe', '#bfd5fe', '#93b8fd', '#6097fa',
  '#3b7bf6', '#2563eb', '#1d4fd8', '#1e40af', '#1e3a8a',
]

// Cool slate neutrals, a touch bluer than Mantine's grays, so borders, hovers
// and muted text sit with the blue.
const gray: MantineColorsTuple = [
  '#f8fafc', '#f1f4f8', '#e5e9f0', '#d7dde6', '#c9d1dc',
  '#98a2b3', '#667085', '#475467', '#344054', '#1d2939',
]

// Blue-black for dark mode (Mantine's default is a neutral gray).
const dark: MantineColorsTuple = [
  '#d7dce5', '#b6bdc9', '#8b93a1', '#6b7280', '#3a404c',
  '#2f3540', '#262b34', '#1f232b', '#181b22', '#12151a',
]

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 6 },
  colors: { brand, gray, dark },
  black: '#101828',
  white: '#ffffff',
  fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif",
  headings: { fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif", fontWeight: '700' },
  defaultRadius: 'md',
  cursorType: 'pointer',
  shadows: {
    xs: '0 1px 2px rgba(16, 24, 40, 0.05)',
    sm: '0 1px 3px rgba(16, 24, 40, 0.07), 0 1px 2px rgba(16, 24, 40, 0.04)',
    md: '0 4px 12px rgba(16, 24, 40, 0.08), 0 1px 3px rgba(16, 24, 40, 0.05)',
    lg: '0 12px 28px rgba(16, 24, 40, 0.10), 0 2px 6px rgba(16, 24, 40, 0.05)',
    xl: '0 20px 44px rgba(16, 24, 40, 0.12), 0 4px 10px rgba(16, 24, 40, 0.06)',
  },
  components: {
    AppShell: AppShell.extend({
      styles: {
        header: { background: 'var(--app-frame)' },
        navbar: { background: 'var(--app-frame)' },
        main: { background: 'var(--app-canvas)' },
      },
    }),
  },
})

// Three surfaces: the frame (header and sidebar), the canvas behind the
// pages, and the body that cards, inputs and menus are drawn on.
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--app-frame': '#f3f5f9',
    '--app-canvas': '#f8fafc',
    '--mantine-color-default-hover': 'var(--mantine-color-gray-1)',
  },
  dark: {
    '--app-frame': 'var(--mantine-color-dark-9)',
    '--app-canvas': 'var(--mantine-color-dark-8)',
  },
})
