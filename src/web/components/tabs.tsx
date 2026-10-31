// What a page can ask of the tab it is shown in (see Shell).
import { createContext, useContext, useEffect } from 'react'

export type TabApi = {
  // A tab holding one item (an email, a broadcast…) rather than a section's list.
  solo: boolean
  // Open the item at `path` in a tab of its own; `background` leaves the current tab in front.
  openSolo: (path: string, background?: boolean) => void
  close: () => void
  setTitle: (title: string) => void
}

export const TabContext = createContext<TabApi | null>(null)
export const useTab = () => useContext(TabContext)

// Name an item's own tab after the item, once it has loaded.
export const useTabTitle = (title: string | null | undefined) => {
  const tab = useTab()
  const solo = tab?.solo
  const setTitle = tab?.setTitle
  useEffect(() => {
    if (solo && title) setTitle?.(title)
    // setTitle changes identity with every tab update; the title is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solo, title])
}
