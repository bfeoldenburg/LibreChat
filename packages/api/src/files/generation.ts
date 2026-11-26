import sharp from 'sharp';
import type { TFileConfig } from 'librechat-data-provider';
import { resolveImageMimeType } from './mime';

type ImageGenerationConfig = NonNullable<TFileConfig['imageGeneration']>;
type ImageResolution = 'low' | 'high' | ImageGenerationConfig;

export interface GeneratedImage {
  buffer: Buffer;
  bytes: number;
  width: number;
  height: number;
  type?: string;
}

export interface GeneratedImageDependencies {
  resizeImageBuffer: (
    input: Buffer | string,
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
    return resizeImageBuffer(input, resolution ?? generatedImageResolution(config), endpoint);
  }

  try {
    return {
      buffer: input,
      bytes: input.length,
      ...(await inspectGeneratedImage(input)),
    };
  } catch {
    // Do not expose decoder diagnostics or submitted contents in storage errors.
    throw new Error('Generated image cannot be preserved: invalid or unsupported raster image');
  }
}

export function generatedImageResolution(config?: ImageGenerationConfig): ImageResolution {
  if (config?.preserveOriginal === false && config.percentage == null && config.px == null) {
    return 'high';
  }
  return config ?? 'high';
}

/** Decode the raster to validate it without rotating, resizing or encoding it. */
export async function inspectGeneratedImage(
  input: Buffer | string,
): Promise<{ type: string; width: number; height: number }> {
  const image = sharp(input, { animated: true, failOn: 'warning' });
  const metadata = await image.metadata();
  const type = resolveImageMimeType(metadata);
  if (!type || !metadata.width || !metadata.height) throw new Error('Unsupported original image');
  await image.stats();
  return { type, width: metadata.width, height: metadata.pageHeight ?? metadata.height };
}
