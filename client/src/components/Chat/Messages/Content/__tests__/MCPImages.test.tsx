import { act, render, screen } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import MCPImages from '../MCPImages';

jest.mock('@librechat/client', () => ({
  Spinner: () => <svg aria-hidden="true" />,
  useLocalize: () => () => 'Generating image',
}));
jest.mock('@librechat/chat/components', () => ({
  AttachmentGroup: ({ attachments }: { attachments: TAttachment[] }) => (
    <img alt="Generated image" src={attachments[0].filepath} />
  ),
}));

it('uses the same aspect ratio at different pixel sizes and replaces the placeholder with the image', () => {
  const pickup = { toolCallId: 'original-call', expiresAt: Date.now() + 6000 };
  const { rerender } = render(
    <MCPImages pickups={[{ ...pickup, resolution: { width: 384, height: 256 } }]} files={[]} />,
  );
  const style = screen.getByRole('status').getAttribute('style');
  expect(screen.getByRole('status')).toHaveStyle({ aspectRatio: '1.5' });
  rerender(
    <MCPImages pickups={[{ ...pickup, resolution: { width: 1536, height: 1024 } }]} files={[]} />,
  );
  expect(screen.getByRole('status')).toHaveAttribute('style', style);
  rerender(
    <MCPImages
      pickups={[pickup]}
      files={[{ toolCallId: pickup.toolCallId, messageId: 'reply', filepath: '/image.png' }]}
    />,
  );
  expect(screen.getByRole('img', { name: 'Generated image' })).toHaveAttribute('src', '/image.png');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('removes an expired placeholder while the chat stays open', () => {
  jest.useFakeTimers();
  try {
    render(
      <MCPImages pickups={[{ toolCallId: 'call', expiresAt: Date.now() + 1000 }]} files={[]} />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});
