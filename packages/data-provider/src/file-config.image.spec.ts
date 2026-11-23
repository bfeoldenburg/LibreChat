import { fileConfigSchema } from './file-config';
import { configSchema } from './config';

describe('fileConfig.imageGeneration.preserveOriginal', () => {
  it.each([true, false])(
    'retains explicit boolean %j through file and application config parsing',
    (preserveOriginal) => {
      const imageGeneration = { preserveOriginal, percentage: 100 };
      expect(fileConfigSchema.parse({ imageGeneration }).imageGeneration).toEqual(imageGeneration);
      const full = configSchema.parse({ version: '1.3.16', fileConfig: { imageGeneration } });
      expect(full.fileConfig?.imageGeneration).toEqual(imageGeneration);
    },
  );
  it.each(['true', 'false', 1, 0, null, {}, []])('rejects non-boolean %j', (preserveOriginal) => {
    const parsed = fileConfigSchema.safeParse({ imageGeneration: { preserveOriginal } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(['imageGeneration', 'preserveOriginal']);
    }
  });
  it.each([{}, { imageGeneration: { percentage: 100 } }, { imageGeneration: { px: 1024 } }])(
    'keeps existing config %j unchanged',
    (config) => {
      expect(fileConfigSchema.parse(config)).toEqual(config);
    },
  );
  it('accepts preservation without redundant resize settings', () => {
    expect(
      fileConfigSchema.parse({ imageGeneration: { preserveOriginal: true } }).imageGeneration,
    ).toEqual({ preserveOriginal: true });
  });
});
