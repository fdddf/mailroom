// The file library (pages/Files.tsx) and what Compose and replies use from
// it: picking files to send attached or as download links, and a signature.
import {
  ActionIcon,
  Box,
  Button,
  Checkbox,
  CloseButton,
  CopyButton,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconCheck, IconCopy, IconDownload, IconFile, IconPaperclip, IconPencil, IconSearch, IconTrash, IconUpload } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { ApiError, api, call, errorText, uploadFile, type LibraryFile } from '../api'
import { fmt, useAction, useDomainName, useScope } from '../hooks'
import { confirm } from './ui'
import classes from '../dashboard.module.css'

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

export const useFiles = () => useQuery({ queryKey: ['files'], queryFn: () => call(api.files.$get()) })
export const useSignatures = () => useQuery({ queryKey: ['signatures'], queryFn: () => call(api.signatures.$get()) })

type Upload = { key: string; name: string; size: number; sent: number; controller: AbortController }

// Uploads in progress, and a way to start more. Resolves to the files that
// made it into the library.
export function useUploads() {
  const client = useQueryClient()
  const [uploads, setUploads] = useState<Upload[]>([])
  const upload = async (files: File[]) => {
    const done: LibraryFile[] = []
    for (const file of files) {
      if (!file.size) {
        notifications.show({ color: 'red', title: file.name, message: errorText(new ApiError('empty_file', 400)) })
        continue
      }
      const item: Upload = { key: crypto.randomUUID(), name: file.name, size: file.size, sent: 0, controller: new AbortController() }
      setUploads((u) => [...u, item])
      try {
        done.push(await uploadFile(file, (sent) => setUploads((u) => u.map((x) => (x.key === item.key ? { ...x, sent } : x))), item.controller.signal))
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'upload_canceled')) notifications.show({ color: 'red', title: `Upload failed: ${file.name}`, message: errorText(err) })
      } finally {
        setUploads((u) => u.filter((x) => x.key !== item.key))
      }
    }
    if (done.length) await client.invalidateQueries({ queryKey: ['files'] })
    return done
  }
  return { upload, uploads }
}

export function UploadProgress({ uploads }: { uploads: Upload[] }) {
  if (!uploads.length) return null
  return (
    <Stack gap={6}>
      {uploads.map((u) => (
        <Group key={u.key} gap="xs" wrap="nowrap">
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Text size="xs" truncate>
                {u.name}
              </Text>
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                {formatBytes(u.sent)} / {formatBytes(u.size)}
              </Text>
            </Group>
            <Progress value={(u.sent / u.size) * 100} size="sm" mt={4} animated />
          </Box>
          <CloseButton size="sm" aria-label={`Cancel ${u.name}`} onClick={() => u.controller.abort()} />
        </Group>
      ))}
    </Stack>
  )
}

export function UploadFilesButton({ upload, children = 'Upload files', variant = 'filled', size }: { upload: (files: File[]) => unknown; children?: ReactNode; variant?: 'filled' | 'default' | 'subtle'; size?: 'xs' | 'sm' }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button variant={variant} size={size} leftSection={<IconUpload size={16} />} onClick={() => input.current?.click()}>
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          e.currentTarget.value = ''
          void upload(files)
        }}
      />
    </>
  )
}

// Takes files dropped on it.
export function DropZone({ onFiles, children }: { onFiles: (files: File[]) => unknown; children: ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <Box
      className={classes.dropzone}
      data-over={over || undefined}
      onDragOver={(e: DragEvent) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault()
        setOver(false)
        void onFiles(Array.from(e.dataTransfer.files))
      }}
    >
      {children}
    </Box>
  )
}

const matches = (f: LibraryFile, q: string) => !q || f.name.toLowerCase().includes(q.toLowerCase())

// The library, with each file's public link, downloads, and actions.
export function FileTable() {
  const list = useFiles()
  const { domainId } = useScope()
  const domainName = useDomainName()
  const [q, setQ] = useState('')
  const invalidate = { invalidate: [['files']] }
  const rename = useAction(({ id, name }: { id: number; name: string }) => call(api.files[':id'].$patch({ param: { id: String(id) }, json: { name } })), invalidate)
  const remove = useAction((id: number) => call(api.files[':id'].$delete({ param: { id: String(id) } })), { ...invalidate, success: 'File deleted' })
  const items = (list.data?.items ?? []).filter((f) => matches(f, q))

  return (
    <Stack gap="sm">
      <TextInput leftSection={<IconSearch size={16} />} placeholder="Search by name" value={q} onChange={(e) => setQ(e.currentTarget.value)} maw={320} />
      <Paper withBorder style={{ overflowX: 'auto' }}>
        <Table verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th ta="right">Size</Table.Th>
              {!domainId && <Table.Th>Domain</Table.Th>}
              <Table.Th>Uploaded</Table.Th>
              <Table.Th ta="right">Downloads</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td maw={360}>
                  <Group gap="xs" wrap="nowrap">
                    <IconFile size={16} style={{ flexShrink: 0 }} />
                    <Text size="sm" fw={600} truncate title={f.name}>
                      {f.name}
                    </Text>
                  </Group>
                </Table.Td>
                <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
                  {formatBytes(f.size)}
                </Table.Td>
                {!domainId && (
                  <Table.Td>
                    <Text size="sm" c={f.domainId ? undefined : 'dimmed'}>
                      {f.domainId ? domainName(f.domainId) : 'All domains'}
                    </Text>
                  </Table.Td>
                )}
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{fmt(f.createdAt)}</Table.Td>
                <Table.Td ta="right">
                  <Tooltip label={f.lastDownloadAt ? `Last ${fmt(f.lastDownloadAt)}` : 'Not downloaded yet'}>
                    <span>{f.downloads}</span>
                  </Tooltip>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <CopyButton value={f.url}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy download link'}>
                          <ActionIcon variant="subtle" color={copied ? 'teal' : undefined} onClick={copy} aria-label="Copy download link">
                            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                    <Tooltip label="Download">
                      <ActionIcon variant="subtle" component="a" href={f.url} aria-label="Download">
                        <IconDownload size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Rename">
                      <ActionIcon
                        variant="subtle"
                        aria-label="Rename"
                        onClick={() => {
                          const name = window.prompt('File name, as recipients see it', f.name)
                          if (name?.trim() && name.trim() !== f.name) rename.mutate({ id: f.id, name: name.trim() })
                        }}
                      >
                        <IconPencil size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label="Delete"
                        onClick={async () =>
                          (await confirm(`Delete ${f.name}?`, 'Download links to it in emails already sent stop working. Copies attached to sent emails are not affected.', {
                            danger: true,
                            label: 'Delete',
                          })) && remove.mutate(f.id)
                        }
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
        {list.data && items.length === 0 && (
          <Text c="dimmed" size="sm" ta="center" p="xl">
            {q ? 'No file by that name.' : 'No files yet. Upload some, or drop them here.'}
          </Text>
        )}
        {list.error && (
          <Text c="red" size="sm" p="md">
            {errorText(list.error)}
          </Text>
        )}
      </Paper>
    </Stack>
  )
}

// Choose files from the library (or upload new ones) for an email.
function FilePicker({ opened, onClose, onPick, exclude }: { opened: boolean; onClose: () => void; onPick: (files: LibraryFile[]) => void; exclude: number[] }) {
  const list = useFiles()
  const { upload, uploads } = useUploads()
  const [q, setQ] = useState('')
  const [checked, setChecked] = useState<number[]>([])
  const items = (list.data?.items ?? []).filter((f) => !exclude.includes(f.id) && matches(f, q))
  const close = () => {
    setChecked([])
    onClose()
  }
  const add = (files: LibraryFile[]) => {
    onPick(files)
    close()
  }
  return (
    <Modal opened={opened} onClose={close} title="Add files" size="lg">
      <Stack gap="sm">
        <Group justify="space-between" gap="xs">
          <TextInput leftSection={<IconSearch size={16} />} placeholder="Search the library" value={q} onChange={(e) => setQ(e.currentTarget.value)} style={{ flex: 1 }} />
          {/* New uploads go straight into the email. */}
          <UploadFilesButton variant="default" upload={async (files) => add(await upload(files))}>
            Upload new
          </UploadFilesButton>
        </Group>
        <UploadProgress uploads={uploads} />
        <ScrollArea.Autosize mah={360}>
          <Stack gap={0}>
            {items.map((f) => (
              <Checkbox
                key={f.id}
                py={8}
                px={4}
                checked={checked.includes(f.id)}
                onChange={(e) => {
                  const on = e.currentTarget.checked
                  setChecked((c) => (on ? [...c, f.id] : c.filter((id) => id !== f.id)))
                }}
                label={
                  <Group gap="xs" wrap="nowrap">
                    <Text size="sm" truncate maw={320}>
                      {f.name}
                    </Text>
                    <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {formatBytes(f.size)} · {fmt(f.createdAt)}
                    </Text>
                  </Group>
                }
              />
            ))}
            {list.data && !items.length && (
              <Text c="dimmed" size="sm" ta="center" p="lg">
                {q ? 'No file by that name.' : 'Nothing else in the library. Upload a file.'}
              </Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
        <Group justify="flex-end">
          <Button disabled={!checked.length} onClick={() => add((list.data?.items ?? []).filter((f) => checked.includes(f.id)))}>
            Add {checked.length || ''} {checked.length === 1 ? 'file' : 'files'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// A file chosen for an email, attached or sent as a link.
export type PickedFile = { file: LibraryFile; link: boolean }
export const toPicks = (files: PickedFile[]) => files.map((p) => ({ fileId: p.file.id, link: p.link }))
const attachedBytes = (files: PickedFile[]) => files.reduce((sum, p) => sum + (p.link ? 0 : p.file.size), 0)
// Whether these can be sent as they are.
export const attachmentsFit = (files: PickedFile[], limit: number) => attachedBytes(files) <= limit

// The files on an email being written. A new one is attached while that
// still fits, else sent as a link; each can be switched.
export function Attachments({ value, onChange, compact = false }: { value: PickedFile[]; onChange: (files: PickedFile[]) => void; compact?: boolean }) {
  const { session } = useScope()
  const limit = session?.attachLimit ?? 17 * 1024 * 1024
  const [picking, setPicking] = useState(false)
  const { upload, uploads } = useUploads()
  const attached = attachedBytes(value)

  const add = (files: LibraryFile[]) => {
    let total = attached
    const fresh = files
      .filter((f) => !value.some((p) => p.file.id === f.id))
      .map((file) => {
        const link = total + file.size > limit
        if (!link) total += file.size
        return { file, link }
      })
    if (fresh.length) onChange([...value, ...fresh])
  }
  const uploadAndAdd = async (files: File[]) => add(await upload(files))

  if (!session?.attachments) return null
  return (
    <DropZone onFiles={uploadAndAdd}>
      <Stack gap={6}>
        <Group gap="xs">
          <Button variant="default" size={compact ? 'xs' : 'sm'} leftSection={<IconPaperclip size={16} />} onClick={() => setPicking(true)}>
            Add files
          </Button>
          <Text size="xs" c="dimmed">
            {value.length
              ? `${formatBytes(attached)} of ${formatBytes(limit)} attached${value.some((p) => p.link) ? '; the rest go as download links' : ''}`
              : `Or drop files here. Up to ${formatBytes(limit)} in total can be attached; bigger files go as download links.`}
          </Text>
        </Group>
        <UploadProgress uploads={uploads} />
        {value.map((p) => (
          <Group key={p.file.id} gap="xs" wrap="nowrap">
            <IconFile size={16} style={{ flexShrink: 0 }} />
            <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }} title={p.file.name}>
              {p.file.name}{' '}
              <Text span size="xs" c="dimmed">
                {formatBytes(p.file.size)}
              </Text>
            </Text>
            <Tooltip
              label={p.link ? 'Anyone with the link can download it' : 'Sent inside the email'}
              disabled={!p.link && p.file.size <= limit}
            >
              <SegmentedControl
                size="xs"
                value={p.link ? 'link' : 'attach'}
                onChange={(v) => onChange(value.map((x) => (x.file.id === p.file.id ? { ...x, link: v === 'link' } : x)))}
                data={[
                  { value: 'attach', label: 'Attach', disabled: p.file.size > limit },
                  { value: 'link', label: 'Link' },
                ]}
              />
            </Tooltip>
            <CloseButton size="sm" aria-label={`Remove ${p.file.name}`} onClick={() => onChange(value.filter((x) => x.file.id !== p.file.id))} />
          </Group>
        ))}
        {attached > limit && (
          <Text size="xs" c="red">
            {formatBytes(attached)} is too much to attach to one email (at most {formatBytes(limit)}). Send some files as links instead.
          </Text>
        )}
        {value.some((p) => p.link) && (
          <Text size="xs" c="dimmed">
            Linked files are listed with their download addresses under the message. Deleting one under Files stops its link from working.
          </Text>
        )}
      </Stack>
      <FilePicker opened={picking} onClose={() => setPicking(false)} onPick={add} exclude={value.map((p) => p.file.id)} />
    </DropZone>
  )
}

// What a signature looks like as text, for its preview.
const signatureText = (s: { format: 'text' | 'html'; body: string }) =>
  s.format === 'html' ? s.body.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : s.body.trim()

// Which signature goes under the email; null for none.
export function SignatureSelect({ value, onChange, size, preview = true }: { value: number | null; onChange: (id: number | null) => void; size?: 'xs' | 'sm'; preview?: boolean }) {
  const list = useSignatures()
  const items = list.data?.items ?? []
  const picked = items.find((s) => s.id === value)
  if (!items.length && value === null) return null
  return (
    <Stack gap={4}>
      <Select
        label={size === 'xs' ? undefined : 'Signature'}
        aria-label="Signature"
        size={size}
        w={size === 'xs' ? 200 : undefined}
        data={[{ value: '', label: 'No signature' }, ...items.map((s) => ({ value: String(s.id), label: s.name }))]}
        value={value ? String(value) : ''}
        onChange={(v) => onChange(v ? Number(v) : null)}
        allowDeselect={false}
      />
      {preview && picked && (
        <Text component="pre" size="xs" c="dimmed" className={classes.signaturePreview}>
          {`-- \n${signatureText(picked)}`}
        </Text>
      )}
    </Stack>
  )
}

// The signature a mailbox starts with.
export const mailboxSignature = (mailboxes: { address: string; signatureId: number | null }[], address: string) =>
  mailboxes.find((m) => m.address === address)?.signatureId ?? null
