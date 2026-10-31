import { createTheme, type MantineColorsTuple } from '@mantine/core'

// The site's terracotta (#b0522f fill / #d97757 accent) as a Mantine scale.
const brand: MantineColorsTuple = [
  '#fdf1ec', '#f7e0d6', '#efbea9', '#e79a7a', '#e07c53',
  '#d97757', '#c9602f', '#b0522f', '#96401f', '#7a3318',
]

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 7, dark: 5 },
  colors: { brand },
  fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif",
  headings: { fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif", fontWeight: '700' },
  defaultRadius: 'md',
  cursorType: 'pointer',
})
