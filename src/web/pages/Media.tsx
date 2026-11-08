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
        Images for HTML emails, templates and signatures: PNG, JPEG, GIF or WebP, up to 5 MB each. Emails written in Compose and replies carry
        them inside (counted with the attachments), so they show even where remote images are blocked; broadcasts load them from here. They are
        public, and their addresses cannot be guessed.
      </Text>
      <MediaGrid upload={upload} />
    </Stack>
  )
}
