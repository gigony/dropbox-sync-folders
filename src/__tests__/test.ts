import { config as envconfig } from 'dotenv-flow';
import { DropboxSyncFolder } from '../index';
envconfig();

jest.setTimeout(60000);

test('test', async () => {
  const config = {
    accounts: [
      {
        accessToken: process.env.DROPBOX_ACCESSTOKEN_PERSON as string,
        mappings: [
          {
            dst: 'dropbox',
            src: '',
          },
        ],
        name: 'PersonalDropbox',
      },
      {
        accessToken: process.env.DROPBOX_ACCESSTOKEN_NVIDIA as string,
        mappings: [
          {
            dst: 'dropbox/nvidia/plan',
            src: '/Work/Plan',
          },
        ],
        name: 'NvidiaDropbox',
      },
    ],
    verbose: true,
    waitInterval: 30,
  };

  const dropboxSync = new DropboxSyncFolder(config);
  await dropboxSync.downloadFiles();
  // await DropboxSyncFolder.sync(config);
});
