import sharp from 'sharp';
import type { TFileConfig } from 'librechat-data-provider';
import { resolveImageMimeType } from './mime';

type ImageGenerationConfig = NonNullable<TFileConfig['imageGeneration']>;
type ImageResolution = 'low' | 'high' | ImageGenerationConfig;

interface GeneratedImage {
  buffer: Buffer;
  bytes: number;
  width: number;
  height: number;
  type?: string;
}

interface GeneratedImageDependencies {
  resizeImageBuffer: (
    input: Buffer,
    resolution: ImageResolution,
    endpoint: string,
  ) => Promise<GeneratedImage>;
}

/** Prepare generated/tool images for storage, independently of model-input resizing. */
export async function prepareGeneratedImage(
  input: Buffer,
  options: { config?: ImageGenerationConfig; resolution?: ImageResolution; endpoint: string },
  { resizeImageBuffer }: GeneratedImageDependencies,
): Promise<GeneratedImage> {
  const { config, resolution, endpoint } = options;
  if (config?.preserveOriginal !== true) {
    const configuredResolution =
      config?.preserveOriginal === false && config.percentage == null && config.px == null
        ? 'high'
        : config;
    return resizeImageBuffer(input, resolution ?? configuredResolution ?? 'high', endpoint);
  }

  try {
    // Decode all raster frames for validation without rotating, resizing or encoding.
    const image = sharp(input, { animated: true, failOn: 'warning' });
    const metadata = await image.metadata();
    const type = resolveImageMimeType(metadata);
    if (!type || !metadata.width || !metadata.height) {
      throw new Error('Unsupported original image');
    }
    await image.stats();
    return {
      buffer: input,
      bytes: input.length,
      width: metadata.width,
      height: metadata.pageHeight ?? metadata.height,
      type,
    };
  } catch {
    // Do not expose decoder diagnostics or submitted contents in storage errors.
    throw new Error('Generated image cannot be preserved: invalid or unsupported raster image');
  }
}
