// tailwind-variants merges classes itself; give it our type scale so `text-ui` isn't taken for a
// text color (which silently dropped `text-fg-on-accent` from primary buttons).
import { createTV } from 'tailwind-variants';
import { twMergeConfig } from './utils';

export const tv = createTV({ twMergeConfig });
export type { VariantProps } from 'tailwind-variants';
