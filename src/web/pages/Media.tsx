import { Stack, Text } from '@mantine/core'
import { MediaGrid, UploadButton, useUpload } from '../components/media'
import { PageHeader } from '../components/ui'

// Images uploaded for HTML email.
export function MediaPage() {
  const { upload, uploading } = useUpload()
  return (
    <Stack>
      <PageHeader title="Images">
        <UploadButton upload={upload} uploading={uploading} />
      </PageHeader>
      <Text size="sm" c="dimmed">
        Images for HTML emails and templates: PNG, JPEG, GIF or WebP, up to 5 MB each. They are public, since recipients' mail apps load them from
        here; their addresses cannot be guessed.
      </Text>
      <MediaGrid upload={upload} />
    </Stack>
  )
}
