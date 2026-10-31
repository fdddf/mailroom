// Edit an HTML email as it looks. The email is rendered in an iframe made
// editable in place, so whatever markup it has (a template's tables and
// inline styles, an AI-written layout) is kept and only what you touch
// changes — unlike a rich-text editor, which would rebuild it in its own
// markup. The iframe is sandboxed without allow-scripts: nothing in the email
// can run, while this page can still read the edited document back.
import { ActionIcon, Button, ColorSwatch, Divider, Group, Loader, Menu, Paper, Text, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBlockquote,
  IconBold,
  IconClearFormatting,
  IconH1,
  IconH2,
  IconHighlight,
  IconLibraryPhoto,
  IconItalic,
  IconLink,
  IconLinkOff,
  IconList,
  IconListNumbers,
  IconPalette,
  IconPhoto,
  IconPilcrow,
  IconRectangle,
  IconSeparatorHorizontal,
  IconStrikethrough,
  IconTextSize,
  IconUnderline,
  IconUpload,
  IconWorldWww,
} from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorText, uploadImage } from '../api'
import { MediaPicker } from './media'
import classes from '../dashboard.module.css'

const isDocument = (html: string) => /<(html|body)[\s>]/i.test(html)

// A fragment gets the same base look the plain-text emails have, so an empty
// editor is not Times New Roman. It lives in <head> and is not part of the result.
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#141413}img{max-width:100%}</style></head><body>`

const TEXT_COLORS = ['#141413', '#68685f', '#b0522f', '#d97757', '#1c7ed6', '#2f9e44', '#e03131', '#ffffff']
const HIGHLIGHTS = ['transparent', '#fff3bf', '#ffe3e3', '#d3f9d8', '#d0ebff', '#f7e0d6']
const SIZES = [
  ['Small', '13px'],
  ['Normal', '15px'],
  ['Large', '18px'],
  ['Larger', '24px'],
  ['Huge', '32px'],
] as const
const BUTTON_STYLE = 'display:inline-block;padding:12px 24px;background:#b0522f;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600'

// What the toolbar lights up for at the cursor.
type State = {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  ul: boolean
  ol: boolean
  align: 'left' | 'center' | 'right' | ''
  block: string
  link: HTMLAnchorElement | null
}
const NOTHING: State = { bold: false, italic: false, underline: false, strike: false, ul: false, ol: false, align: '', block: '', link: null }
type Box = { top: number; left: number; width: number; height: number }

export function VisualEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  // What this editor last reported. A value that differs came from outside
  // (a template, the AI, the source view), and the document is loaded again.
  const emitted = useRef(value)
  const [loaded, setLoaded] = useState({ html: value, n: 0 })
  if (value !== emitted.current) {
    emitted.current = value
    setLoaded((l) => ({ html: value, n: l.n + 1 }))
  }
  const whole = isDocument(loaded.html)
  const [state, setState] = useState<State>(NOTHING)
  // The image that was clicked, and where to draw its outline over the iframe.
  const image = useRef<HTMLImageElement | null>(null)
  const [imageBox, setImageBox] = useState<Box | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  // What a picked file is for: a new image, or the selected one's replacement.
  const replacing = useRef(false)
  const [uploading, setUploading] = useState(false)
  // The library, open to insert an image or to replace the selected one.
  const [library, setLibrary] = useState<'insert' | 'replace' | null>(null)

  const fit = useCallback(() => {
    const el = frame.current
    const doc = el?.contentDocument
    if (el && doc?.documentElement) el.style.height = `${Math.max(380, doc.documentElement.scrollHeight + 24)}px`
  }, [])

  const outline = () => {
    const img = image.current
    if (!img?.isConnected) {
      image.current = null
      return setImageBox(null)
    }
    const r = img.getBoundingClientRect()
    setImageBox({ top: r.top, left: r.left, width: r.width, height: r.height })
  }

  const inspect = () => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    const on = (command: string) => {
      try {
        return doc.queryCommandState(command)
      } catch {
        return false
      }
    }
    const node = doc.getSelection()?.anchorNode
    // Not `instanceof Element`: the iframe's nodes belong to its own window's classes.
    const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement
    setState({
      bold: on('bold'),
      italic: on('italic'),
      underline: on('underline'),
      strike: on('strikeThrough'),
      ul: on('insertUnorderedList'),
      ol: on('insertOrderedList'),
      align: on('justifyCenter') ? 'center' : on('justifyRight') ? 'right' : on('justifyLeft') ? 'left' : '',
      block: (doc.queryCommandValue('formatBlock') || '').toLowerCase(),
      link: element?.closest('a') ?? null,
    })
  }

  const read = () => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const html = whole ? `<!doctype html>\n${doc.documentElement.outerHTML}` : doc.body.innerHTML
    emitted.current = html
    onChange(html)
    fit()
    outline()
    inspect()
  }
  // The document's listeners are attached once per load; they call whatever
  // is current, since onChange is a new function on every render.
  // Upload image files to R2 and put them in the email: over the selected
  // image when replacing, else at the cursor.
  const addImages = async (files: File[], replace = false) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    setUploading(true)
    try {
      for (const file of images) {
        const url = await uploadImage(file)
        if (replace && image.current) {
          image.current.setAttribute('src', url)
          read()
        } else run('insertImage', url)
      }
    } catch (err) {
      notifications.show({ color: 'red', title: 'Upload failed', message: errorText(err) })
    } finally {
      setUploading(false)
    }
  }

  const latest = useRef({ read, inspect, outline, addImages })
  useEffect(() => {
    latest.current = { read, inspect, outline, addImages }
  })

  const ready = () => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    doc.designMode = 'on'
    // Inline styles and <p>, which is what email clients understand.
    doc.execCommand('styleWithCSS', false, 'true')
    doc.execCommand('defaultParagraphSeparator', false, 'p')
    doc.addEventListener('input', () => latest.current.read())
    doc.addEventListener('selectionchange', () => latest.current.inspect())
    // mousedown: an editable document does not get click events for images.
    doc.addEventListener('mousedown', (e) => {
      const target = e.target as Element | null
      image.current = target?.tagName === 'IMG' ? (target as HTMLImageElement) : null
      // Selected as a whole, so alignment, links and Delete apply to it.
      if (image.current) {
        const range = doc.createRange()
        range.selectNode(image.current)
        doc.getSelection()?.removeAllRanges()
        doc.getSelection()?.addRange(range)
      }
      latest.current.outline()
    })
    // Pasted or dropped image files are uploaded, not embedded: a data: image
    // makes the email huge and most mail clients refuse to show it.
    const files = (list: FileList | undefined | null) => Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
    doc.addEventListener('paste', (e) => {
      const images = files(e.clipboardData?.files)
      if (!images.length) return
      e.preventDefault()
      void latest.current.addImages(images)
    })
    doc.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    })
    doc.addEventListener('drop', (e) => {
      const images = files(e.dataTransfer?.files)
      if (!images.length) return
      e.preventDefault()
      void latest.current.addImages(images)
    })
    for (const img of Array.from(doc.images)) img.addEventListener('load', fit)
    image.current = null
    setImageBox(null)
    setState(NOTHING)
    fit()
  }

  const run = (command: string, argument?: string) => {
    const el = frame.current
    if (!el?.contentDocument) return
    el.contentWindow?.focus()
    el.contentDocument.execCommand(command, false, argument)
    read()
  }
  // execCommand only knows seven keyword sizes; apply the largest as a marker
  // and rewrite it to the pixel size, which email clients render consistently.
  const size = (px: string) => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    frame.current?.contentWindow?.focus()
    doc.execCommand('fontSize', false, '7')
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>('span, font'))) {
      if (el.style.fontSize === 'xxx-large' || el.getAttribute('size') === '7') {
        el.removeAttribute('size')
        el.style.fontSize = px
      }
    }
    read()
  }
  const link = () => {
    const current = state.link ?? image.current?.closest('a') ?? null
    const answer = window.prompt(current ? 'Link address' : 'Link address (select the text or image first)', current?.getAttribute('href') || 'https://')?.trim()
    if (!answer || answer === 'https://') return
    if (current) {
      current.setAttribute('href', answer)
      read()
    } else run('createLink', answer)
  }
  const pick = (replace: boolean) => {
    replacing.current = replace
    picker.current?.click()
  }
  const insertImage = () => {
    const src = window.prompt('Image address (it must be public: recipients load it from there)', 'https://')?.trim()
    if (src && src !== 'https://') run('insertImage', src)
  }
  const insertButton = () => {
    const href = window.prompt('Where should the button go?', 'https://')?.trim()
    if (!href || href === 'https://') return
    const label = frame.current?.contentDocument?.getSelection()?.toString().trim() || 'Learn more'
    const a = document.createElement('a')
    a.href = href
    a.setAttribute('style', BUTTON_STYLE)
    a.textContent = label
    run('insertHTML', `${a.outerHTML}&nbsp;`)
  }
  const editImage = (change: (img: HTMLImageElement) => void) => {
    if (!image.current) return
    change(image.current)
    read()
  }

  const tool = (label: string, icon: ReactNode, action: () => void, active = false) => (
    <Tooltip label={label} openDelay={400}>
      {/* mousedown must not take the selection away from the email. */}
      <ActionIcon
        variant={active ? 'filled' : 'subtle'}
        color={active ? undefined : 'gray'}
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={action}
      >
        {icon}
      </ActionIcon>
    </Tooltip>
  )
  const swatches = (label: string, icon: ReactNode, colors: string[], command: string) => (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Tooltip label={label} openDelay={400}>
          <ActionIcon variant="subtle" color="gray" aria-label={label} onMouseDown={(e) => e.preventDefault()}>
            {icon}
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Group gap={6} p={6}>
          {colors.map((color) => (
            <ColorSwatch
              key={color}
              color={color}
              size={22}
              component="button"
              aria-label={color === 'transparent' ? 'None' : color}
              style={{ cursor: 'pointer' }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(command, color)}
            />
          ))}
        </Group>
      </Menu.Dropdown>
    </Menu>
  )
  const gap = <Divider orientation="vertical" mx={4} />

  return (
    <Paper withBorder style={{ overflow: 'hidden' }}>
      <Group gap={2} p={4} className={classes.toolbar}>
        {tool('Undo', <IconArrowBackUp size={16} />, () => run('undo'))}
        {tool('Redo', <IconArrowForwardUp size={16} />, () => run('redo'))}
        {gap}
        {tool('Bold', <IconBold size={16} />, () => run('bold'), state.bold)}
        {tool('Italic', <IconItalic size={16} />, () => run('italic'), state.italic)}
        {tool('Underline', <IconUnderline size={16} />, () => run('underline'), state.underline)}
        {tool('Strikethrough', <IconStrikethrough size={16} />, () => run('strikeThrough'), state.strike)}
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <Tooltip label="Text size" openDelay={400}>
              <ActionIcon variant="subtle" color="gray" aria-label="Text size" onMouseDown={(e) => e.preventDefault()}>
                <IconTextSize size={16} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            {SIZES.map(([label, px]) => (
              <Menu.Item key={px} onMouseDown={(e) => e.preventDefault()} onClick={() => size(px)}>
                <span style={{ fontSize: px, lineHeight: 1.2 }}>{label}</span>
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
        {swatches('Text colour', <IconPalette size={16} />, TEXT_COLORS, 'foreColor')}
        {swatches('Highlight', <IconHighlight size={16} />, HIGHLIGHTS, 'hiliteColor')}
        {gap}
        {tool('Heading', <IconH1 size={16} />, () => run('formatBlock', 'h1'), state.block === 'h1')}
        {tool('Subheading', <IconH2 size={16} />, () => run('formatBlock', 'h2'), state.block === 'h2')}
        {tool('Paragraph', <IconPilcrow size={16} />, () => run('formatBlock', 'p'), state.block === 'p')}
        {tool('Quote', <IconBlockquote size={16} />, () => run('formatBlock', 'blockquote'), state.block === 'blockquote')}
        {gap}
        {tool('Bulleted list', <IconList size={16} />, () => run('insertUnorderedList'), state.ul)}
        {tool('Numbered list', <IconListNumbers size={16} />, () => run('insertOrderedList'), state.ol)}
        {tool('Align left', <IconAlignLeft size={16} />, () => run('justifyLeft'), state.align === 'left')}
        {tool('Centre', <IconAlignCenter size={16} />, () => run('justifyCenter'), state.align === 'center')}
        {tool('Align right', <IconAlignRight size={16} />, () => run('justifyRight'), state.align === 'right')}
        {gap}
        {tool(state.link ? 'Edit link' : 'Link', <IconLink size={16} />, link, Boolean(state.link))}
        {tool('Remove link', <IconLinkOff size={16} />, () => run('unlink'))}
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <Tooltip label="Image" openDelay={400}>
              <ActionIcon variant="subtle" color="gray" aria-label="Image" onMouseDown={(e) => e.preventDefault()}>
                {uploading ? <Loader size={14} /> : <IconPhoto size={16} />}
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconUpload size={14} />} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(false)}>
              Upload an image…
            </Menu.Item>
            <Menu.Item leftSection={<IconLibraryPhoto size={14} />} onMouseDown={(e) => e.preventDefault()} onClick={() => setLibrary('insert')}>
              From the library…
            </Menu.Item>
            <Menu.Item leftSection={<IconWorldWww size={14} />} onMouseDown={(e) => e.preventDefault()} onClick={insertImage}>
              From an address…
            </Menu.Item>
            <Menu.Label>You can also paste or drop an image into the email.</Menu.Label>
          </Menu.Dropdown>
        </Menu>
        {tool('Button', <IconRectangle size={16} />, insertButton)}
        {tool('Divider line', <IconSeparatorHorizontal size={16} />, () => run('insertHorizontalRule'))}
        {gap}
        {tool('Clear formatting', <IconClearFormatting size={16} />, () => run('removeFormat'))}
      </Group>
      {imageBox && (
        <Group gap="xs" px="xs" py={4} className={classes.toolbar} onMouseDown={(e) => e.preventDefault()}>
          <Text size="xs" c="dimmed">
            Image
          </Text>
          {(['25%', '50%', '100%'] as const).map((width) => (
            <Button
              key={width}
              size="compact-xs"
              variant="default"
              onClick={() =>
                editImage((img) => {
                  // Attributes too: some clients (Outlook) go by them, not the style.
                  img.removeAttribute('height')
                  img.setAttribute('width', width)
                  img.style.height = 'auto'
                  img.style.width = width
                })
              }
            >
              {width}
            </Button>
          ))}
          <Button
            size="compact-xs"
            variant="default"
            onClick={() =>
              editImage((img) => {
                img.removeAttribute('width')
                img.removeAttribute('height')
                img.style.width = ''
                img.style.height = ''
              })
            }
          >
            Original size
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => {
              const src = window.prompt('Image address', image.current?.getAttribute('src') || '')?.trim()
              if (src) editImage((img) => img.setAttribute('src', src))
            }}
          >
            Change address
          </Button>
          <Button size="compact-xs" variant="default" loading={uploading} onClick={() => pick(true)}>
            Upload replacement
          </Button>
          <Button size="compact-xs" variant="default" onClick={() => setLibrary('replace')}>
            From library
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => {
              const alt = window.prompt('Description, shown when the image does not load', image.current?.getAttribute('alt') || '')
              if (alt !== null) editImage((img) => img.setAttribute('alt', alt))
            }}
          >
            Description
          </Button>
          <Button size="compact-xs" variant="default" onClick={link}>
            Link
          </Button>
          <Button size="compact-xs" variant="subtle" color="red" onClick={() => editImage((img) => img.remove())}>
            Remove
          </Button>
        </Group>
      )}
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          // So the same file can be picked again.
          e.currentTarget.value = ''
          void addImages(files, replacing.current)
        }}
      />
      <MediaPicker
        opened={library !== null}
        onClose={() => setLibrary(null)}
        onPick={(url) => {
          if (library === 'replace' && image.current) {
            image.current.setAttribute('src', url)
            read()
          } else run('insertImage', url)
        }}
      />
      <div style={{ position: 'relative' }}>
        <iframe
          key={loaded.n}
          ref={frame}
          title="Email, editable"
          className={classes.visual}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={whole ? loaded.html : SHELL + loaded.html}
          onLoad={ready}
        />
        {imageBox && <div className={classes.selected} style={imageBox} />}
      </div>
    </Paper>
  )
}
