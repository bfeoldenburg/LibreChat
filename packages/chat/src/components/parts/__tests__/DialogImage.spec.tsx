/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DialogImage from '../DialogImage';

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual<typeof import('@librechat/client')>('@librechat/client');
  return {
    ...actual,
    useLocalize: () => (key: string) => key,
    useRemScale: () => 1,
    useMediaQuery: () => false,
  };
});

/** The lightbox is a raw Radix dialog at z-250, not an OGDialog, so a tooltip left on the
 *  stylesheet default (150) would paint behind its overlay. */
const LIGHTBOX_Z_INDEX = 250;

it('shows original and preview metadata without requiring a tool-specific quality', () => {
  render(
    <DialogImage
      isOpen
      onOpenChange={jest.fn()}
      src="/media.png"
      downloadImage={jest.fn()}
      file={{
        filename: 'image-original.tiff',
        type: 'image/tiff',
        bytes: 4194304,
        width: 2048,
        height: 2048,
      }}
      preview={{ width: 768, height: 768 }}
      generation={{ prompt: 'Blaue Blume', steps: 7 }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_show_image_details' }));
  expect(screen.getByText('image-original.tiff')).toBeInTheDocument();
  expect(screen.getByText('image/tiff')).toBeInTheDocument();
  expect(screen.getByText('2048 × 2048')).toBeInTheDocument();
  expect(screen.getByText('768 × 768')).toBeInTheDocument();
  expect(screen.getByText('4 MB')).toBeInTheDocument();
  expect(screen.getByText('Blaue Blume')).toBeInTheDocument();
  expect(screen.getByText('7')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_quality')).toBeNull();
});

describe('DialogImage tooltips', () => {
  it('layers the close tooltip above the lightbox', async () => {
    render(
      <DialogImage isOpen onOpenChange={jest.fn()} src="/media.png" downloadImage={jest.fn()} />,
    );

    const close = screen.getByRole('button', { name: 'com_ui_close' });
    fireEvent.mouseEnter(close);
    fireEvent.mouseMove(close);

    const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 3000 });
    expect(Number(tooltip.style.zIndex)).toBeGreaterThan(LIGHTBOX_Z_INDEX);
  });

  it('layers the download tooltip above the lightbox', async () => {
    render(
      <DialogImage isOpen onOpenChange={jest.fn()} src="/media.png" downloadImage={jest.fn()} />,
    );

    const download = screen.getByRole('button', { name: 'com_ui_download' });
    fireEvent.mouseEnter(download);
    fireEvent.mouseMove(download);

    const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 3000 });
    expect(Number(tooltip.style.zIndex)).toBeGreaterThan(LIGHTBOX_Z_INDEX);
  });
});
