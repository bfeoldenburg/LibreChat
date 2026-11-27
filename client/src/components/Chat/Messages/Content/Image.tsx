import React, { useState, useRef, useMemo, useEffect, useContext } from 'react';
import { Skeleton } from '@librechat/client';
import { DialogImage } from '@librechat/chat/components';
import { apiBaseUrl, getOriginalFileId } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import useStoredFileDownload from '~/hooks/Files/useStoredFileDownload';
import { AuthContext } from '~/hooks/AuthContext';
import { cn, toAbsoluteFilePath } from '~/utils';

/** Max display height for chat images (Tailwind JIT class) */
export const IMAGE_MAX_H = 'max-h-[45vh]' as const;
/** Matches the `max-w-lg` Tailwind class on the wrapper button (32rem = 512px at 16px base) */
const IMAGE_MAX_W_PX = 512;

/** Caches image dimensions by src so remounts can reserve space */
const dimensionCache = new Map<string, { width: number; height: number }>();
/** Tracks URLs that have been fully painted — skip skeleton on remount */
const paintedUrls = new Set<string>();

/** Test-only: resets module-level caches */
export function _resetImageCaches(): void {
  dimensionCache.clear();
  paintedUrls.clear();
}

function computeHeightStyle(w: number, h: number): React.CSSProperties {
  return { height: `min(45vh, ${(h / w) * 100}vw, ${(h / w) * IMAGE_MAX_W_PX}px)` };
}

function StoredImageDialog({
  attachment,
  ...dialog
}: Omit<React.ComponentProps<typeof DialogImage>, 'file' | 'preview' | 'downloadImage'> & {
  attachment: Partial<TFile>;
}) {
  const userId = useContext(AuthContext)?.user?.id;
  const hasPreview = !!getOriginalFileId(attachment);
  const { download, isFetching } = useStoredFileDownload(userId, attachment);
  return (
    <DialogImage
      {...dialog}
      file={hasPreview ? attachment.metadata?.originalFile : attachment}
      preview={hasPreview ? attachment : undefined}
      downloadImage={download}
      isDownloading={isFetching}
    />
  );
}

const Image = ({
  imagePath,
  altText,
  className,
  alignRight = false,
  args,
  width,
  height,
  file,
}: {
  imagePath: string;
  altText: string;
  className?: string;
  alignRight?: boolean;
  args?: {
    prompt?: string;
    quality?: 'low' | 'medium' | 'high';
    size?: string;
    style?: string;
    [key: string]: unknown;
  };
  width?: number;
  height?: number;
  file?: Partial<TFile>;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /** Root-relative server paths (`/images/...` static, `/api/...` downloads and
   *  share routes) are resolved against the API base so they load under a
   *  subpath deployment. */
  const absoluteImageUrl = useMemo(() => toAbsoluteFilePath(imagePath, apiBaseUrl()), [imagePath]);

  const downloadImage = async () => {
    try {
      const response = await fetch(absoluteImageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
      const link = document.createElement('a');
      link.href = absoluteImageUrl;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  useEffect(() => {
    if (width && height && absoluteImageUrl) {
      dimensionCache.set(absoluteImageUrl, { width, height });
    }
  }, [absoluteImageUrl, width, height]);

  const dims = width && height ? { width, height } : dimensionCache.get(absoluteImageUrl);
  const hasDimensions = !!(dims?.width && dims?.height);
  const heightStyle = hasDimensions ? computeHeightStyle(dims.width, dims.height) : undefined;
  const showSkeleton = hasDimensions && !paintedUrls.has(absoluteImageUrl);
  const dialog = {
    isOpen,
    onOpenChange: setIsOpen,
    src: absoluteImageUrl,
    args,
    triggerRef,
    generation: file?.metadata?.generation,
  };
  const hasStoredDownload = file?.file_id && (getOriginalFileId(file) || file.metadata?.generation);

  return (
    <div className={alignRight ? 'ms-auto' : undefined}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`View ${altText} in dialog`}
        aria-haspopup="dialog"
        onClick={() => setIsOpen(true)}
        className={cn(
          'border-border-light text-text-secondary-alt relative mt-1 w-full max-w-lg cursor-pointer overflow-hidden rounded-lg border shadow-md transition-shadow',
          'focus-visible:ring-text-primary focus-visible:ring-offset-surface-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2',
          className,
        )}
        style={heightStyle}
      >
        {showSkeleton && <Skeleton className="absolute inset-0" aria-hidden="true" />}
        <img
          alt={altText}
          src={absoluteImageUrl}
          onLoad={() => paintedUrls.add(absoluteImageUrl)}
          className={cn(
            'relative block text-transparent',
            hasDimensions
              ? 'size-full object-contain'
              : cn('h-auto w-auto max-w-full', IMAGE_MAX_H),
          )}
        />
      </button>
      {hasStoredDownload && file ? (
        isOpen && <StoredImageDialog {...dialog} attachment={file} />
      ) : (
        <DialogImage
          {...dialog}
          file={file ?? { filename: altText }}
          downloadImage={downloadImage}
        />
      )}
    </div>
  );
};

export default Image;
