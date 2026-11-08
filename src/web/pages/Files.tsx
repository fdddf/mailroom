import { Alert, Stack, Text } from '@mantine/core'
import { DropZone, FileTable, UploadFilesButton, UploadProgress, useUploads } from '../components/files'
import { useScope } from '../hooks'
import { PageHeader } from '../components/ui'

// Files to send: attached to an email while small enough, otherwise as a
// download link, at any size.
export function FilesPage() {
  const { session, domain } = useScope()
  const { upload, uploads } = useUploads()
  return (
    <Stack>
      <PageHeader title="Files">{session?.attachments && <UploadFilesButton upload={upload} />}</PageHeader>
      {session && !session.attachments && <Alert color="yellow">Storage is not set up: add the R2 binding named BUCKET (wrangler.jsonc).</Alert>}
      <Text size="sm" c="dimmed">
        Files of any size, to add to emails in Compose and replies. Up to {session ? `${Math.round(session.attachLimit / 1024 / 1024)} MB` : 'a limit'} in
        total goes attached; bigger files go as a download link, which anyone who has it can use and which stops working when the file is deleted here.
        {domain ? ` New uploads belong to ${domain.name}.` : ' New uploads are offered for every domain.'}
      </Text>
      <UploadProgress uploads={uploads} />
      <DropZone onFiles={upload}>
        <FileTable />
      </DropZone>
    </Stack>
  )
}
