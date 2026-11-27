import { Schema } from 'mongoose';
import type { FileGenerationDetails } from 'librechat-data-provider';

export const fileGenerationDetailsSchema: Schema<FileGenerationDetails> = new Schema(
  { prompt: String, steps: Number, quality: String },
  { _id: false },
);
