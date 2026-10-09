import { ImageResponse } from 'next/og';
import { BrandMark } from './icon-art';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// Square with no transparent corners: iOS rounds it, and fills transparency with black.
export default function AppleIcon() {
  return new ImageResponse(<BrandMark size={size.width} variant="square" />, size);
}
