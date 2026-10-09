import { ImageResponse } from 'next/og';
import { BrandMark } from './icon-art';

// The manifest points at these three by id (/icon/any-192 ...), so renaming one is a
// manifest change too.
export function generateImageMetadata() {
  return [
    { id: 'any-192', size: { width: 192, height: 192 }, contentType: 'image/png' },
    { id: 'any-512', size: { width: 512, height: 512 }, contentType: 'image/png' },
    { id: 'maskable-512', size: { width: 512, height: 512 }, contentType: 'image/png' },
  ];
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const [kind, px] = String(await id).split('-');
  const size = Number(px);
  return new ImageResponse(
    <BrandMark size={size} variant={kind === 'maskable' ? 'maskable' : 'rounded'} />,
    { width: size, height: size },
  );
}
