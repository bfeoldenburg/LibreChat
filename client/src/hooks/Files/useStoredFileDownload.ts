import { useToastContext } from '@librechat/client';
import { getOriginalFileId } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { getDownloadFilename, triggerDownload } from '~/utils/downloadFile';
import { useFileDownload } from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';

export default function useStoredFileDownload(
  userId?: string,
  file?: Partial<TFile> | null,
  originalName?: string,
) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const originalId = getOriginalFileId(file);
  const fileId = originalId ?? file?.file_id;
  const { refetch, isFetching } = useFileDownload(userId, fileId, { source: file?.source });
  const download = async () => {
    const { data, isError } = await refetch();
    if (isError || !data) {
      showToast({ status: 'error', message: localize('com_ui_download_error') });
      return;
    }
    const name = originalId
      ? (originalName ?? file?.metadata?.originalFile?.filename ?? '')
      : (file?.filename ?? '');
    triggerDownload(data, getDownloadFilename(name, fileId, file?.source));
  };
  return { download, isFetching };
}
