// The image library: what has been uploaded for HTML email. Shown as a page
// (pages/Media.tsx) and as a picker in the visual editor.
import { ActionIcon, Box, Button, Center, CopyButton, Group, Loader, Modal, Paper, SimpleGrid, Text, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconCheck, IconCopy, IconExternalLink, IconTrash, IconUpload } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type DragEvent } from 'react'
import { api, call, errorText, uploadImage } from '../api'
import { fmt, useAction } from '../hooks'
import { confirm } from './ui'
import classes from '../dashboard.module.css'

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

export const useMedia = () => useQuery({ queryKey: ['media'], queryFn: () => call(api.media.$get()) })

// Upload button plus the files' fate; also takes files dropped on the library.
export function useUpload() {
  const client = useQueryClient()
  const [uploading, setUploading] = useState(false)
  const upload = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return []
    setUploading(true)
    const urls: string[] = []
    try {
      for (const file of images) urls.push(await uploadImage(file))
    } catch (err) {
      notifications.show({ color: 'red', title: 'Upload failed', message: errorText(err) })
    } finally {
      setUploading(false)
      await client.invalidateQueries({ queryKey: ['media'] })
    }
    return urls
  }
  return { upload, uploading }
}

export function UploadButton({ upload, uploading, variant = 'filled' }: { upload: (files: File[]) => unknown; uploading: boolean; variant?: 'filled' | 'default' }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button variant={variant} leftSection={<IconUpload size={16} />} loading={uploading} onClick={() => input.current?.click()}>
        Upload images
      </Button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
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

// The thumbnails. With onPick, clicking one chooses it; without, each has
// its own actions (copy address, open, delete).
export function MediaGrid({ onPick, upload }: { onPick?: (url: string) => void; upload: (files: File[]) => unknown }) {
  const list = useMedia()
  const [over, setOver] = useState(false)
  const remove = useAction((name: string) => call(api.media[':name'].$delete({ param: { name } })), { invalidate: [['media']], success: 'Image deleted' })
  const items = list.data?.items ?? []

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void upload(Array.from(e.dataTransfer.files))
  }

  return (
    <Box
      className={classes.dropzone}
      data-over={over || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      {list.isPending ? (
        <Center p="xl">
          <Loader size="sm" />
        </Center>
      ) : list.error ? (
        <Text c="red" size="sm">
          {errorText(list.error)}
        </Text>
      ) : items.length === 0 ? (
        <Text c="dimmed" size="sm" ta="center" p="xl">
          No images yet. Upload some, or drop them here.
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }} spacing="sm">
          {items.map((m) => (
            <Paper key={m.name} withBorder style={{ overflow: 'hidden' }}>
              <Box
                component={onPick ? 'button' : 'div'}
                type={onPick ? 'button' : undefined}
                className={classes.thumb}
                data-pick={onPick ? true : undefined}
                onClick={onPick ? () => onPick(m.url) : undefined}
                aria-label={onPick ? 'Use this image' : undefined}
              >
                <img src={m.url} alt="" loading="lazy" />
              </Box>
              <Group justify="space-between" gap={4} px={8} py={6} wrap="nowrap">
                <Text size="xs" c="dimmed" truncate>
                  {size(m.size)} · {fmt(m.uploadedAt)}
                </Text>
                {!onPick && (
                  <Group gap={0} wrap="nowrap">
                    <CopyButton value={m.url}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy address'}>
                          <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} size="sm" onClick={copy} aria-label="Copy address">
                            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                    <Tooltip label="Open">
                      <ActionIcon variant="subtle" color="gray" size="sm" component="a" href={m.url} target="_blank" rel="noopener" aria-label="Open">
                        <IconExternalLink size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        aria-label="Delete"
                        onClick={async () =>
                          (await confirm('Delete this image?', 'Emails and templates that use it, including ones already sent, will show a broken image.', { danger: true, label: 'Delete' })) &&
                          remove.mutate(m.name)
                        }
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                )}
              </Group>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {list.data?.more && (
        <Text size="xs" c="dimmed" mt="sm">
          Showing the 500 most recent.
        </Text>
      )}
    </Box>
  )
}

// Choose an uploaded image (or upload one now) for the email being edited.
export function MediaPicker({ opened, onClose, onPick }: { opened: boolean; onClose: () => void; onPick: (url: string) => void }) {
  const { upload, uploading } = useUpload()
  const choose = (url: string) => {
    onPick(url)
    onClose()
  }
  return (
    <Modal opened={opened} onClose={onClose} title="Image library" size="xl">
      <Group justify="space-between" mb="sm">
        <Text size="sm" c="dimmed">
          Click an image to use it.
        </Text>
        <UploadButton
          variant="default"
          uploading={uploading}
          // One image: straight into the email. Several: into the library to pick from.
          upload={async (files) => {
            const urls = await upload(files)
            if (urls.length === 1) choose(urls[0]!)
          }}
        />
      </Group>
      {opened && <MediaGrid onPick={choose} upload={upload} />}
    </Modal>
  )
}
