import { useState } from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFile } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import { MyFilesModal } from './MyFilesModal';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getFiles: jest.fn() },
  };
});

jest.mock('~/data-provider', () => ({
  useGetFiles: jest.requireActual('~/data-provider/Files/queries').useGetFiles,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('./Table', () => ({
  columns: [],
  DataTable: ({ data }: { data: TFile[] }) => (
    <div data-testid="files-table">{data.map((file) => file.filename).join(', ')}</div>
  ),
}));

function renderModal(element: ReactElement, queryClient = new QueryClient()) {
  return render(
    <RecoilRoot>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </RecoilRoot>,
  );
}

function Harness({ trigger }: { trigger: HTMLElement }) {
  const [open, setOpen] = useState(true);
  return <MyFilesModal open={open} onOpenChange={setOpen} triggerRef={{ current: trigger }} />;
}

beforeEach(() => {
  jest.mocked(dataService.getFiles).mockResolvedValue([]);
});

it('refreshes a cached file list when opened after an image was saved', async () => {
  const original = { file_id: 'original', filename: 'image-original.png' } as TFile;
  jest.mocked(dataService.getFiles).mockResolvedValue([original]);
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.files], []);

  renderModal(<MyFilesModal open onOpenChange={jest.fn()} />, queryClient);

  expect(await screen.findByText(original.filename)).toBeInTheDocument();
  expect(dataService.getFiles).toHaveBeenCalledTimes(1);
});

describe('MyFilesModal focus restoration', () => {
  it('returns focus to the shortcut invoker instead of the account button', async () => {
    const user = userEvent.setup();
    const invoker = document.createElement('button');
    const inertSidebar = document.createElement('div');
    const accountButton = document.createElement('button');
    inertSidebar.setAttribute('inert', '');
    inertSidebar.append(accountButton);
    document.body.append(invoker, inertSidebar);
    invoker.focus();

    renderModal(<Harness trigger={accountButton} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(invoker).toHaveFocus());
  });

  it('falls back to the account button when the dialog opens from its menu', async () => {
    const user = userEvent.setup();
    const menu = document.createElement('div');
    const menuItem = document.createElement('button');
    const accountButton = document.createElement('button');
    menu.setAttribute('role', 'menu');
    menu.append(menuItem);
    document.body.append(menu, accountButton);
    menuItem.focus();

    renderModal(<Harness trigger={accountButton} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(accountButton).toHaveFocus());
  });
});
