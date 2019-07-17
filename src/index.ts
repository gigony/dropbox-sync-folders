import { Dropbox } from 'dropbox';
import * as fg from 'fast-glob';
import { createReadStream, createWriteStream, existsSync, lstatSync, unlinkSync } from 'fs';
import { ensureDirSync, removeSync } from 'fs-extra';
import fetch from 'node-fetch';
import { dirname, join } from 'path';
import { DropboxContentHasher } from './dropbox-content-hasher';

interface IMappingItem {
  src: string;
  dst: string;
  cursor?: DropboxTypes.files.ListFolderCursor;
  updated?: boolean;
}

interface IAccountSyncConfiguration {
  name: string;
  accessToken: string;
  mappings: IMappingItem[];
  dbx?: Dropbox;
}

interface IAccountSyncConfigurationMap {
  [index: string]: IAccountSyncConfiguration;
}
interface IDropboxSyncConfiguration {
  waitInterval?: number;
  verbose?: boolean;
  accounts: IAccountSyncConfiguration[];
}

interface ICancelToken {
  cancel: boolean;
}

interface ISyncedFiles {
  fileSet: Set<string>;
  folderSet: Set<string>;
}

async function sleep(timeout: number) {
  return new Promise<undefined>(resolve => setTimeout(resolve, timeout * 1000));
}

// function difference(setA: Set<string>, setB: Set<string>) {
//   const diff = new Set(setA);
//   for (const elem of setB) {
//     diff.delete(elem);
//   }
//   return diff;
// }

class DropboxSyncFolder {
  public static async sync(config: IDropboxSyncConfiguration, cancelToken: ICancelToken = { cancel: false }) {
    const dropboxSync = new DropboxSyncFolder(config);

    while (!cancelToken.cancel) {
      try {
        await dropboxSync.downloadFiles('*');
        // const resultSet = await dropboxSync.downloadFiles('*');
        // const fileSet = new Set(dropboxSync.getFileList());
        // const fileDeleteSet = difference(fileSet, resultSet.fileSet);
        // for (const filePath of fileDeleteSet) {
        //   unlinkSync(filePath);
        // }

        // const folderSet = new Set(dropboxSync.getFileList('*', true));
        // console.log('folderSet:', folderSet, 'resultSet.folderSet:', resultSet.folderSet);
        // const folderDeleteSet = difference(folderSet, resultSet.folderSet);
        // for (const filePath of fileDeleteSet) {
        //   console.log('Remove file', filePath);
        //   unlinkSync(filePath);
        // }
        // for (const folderPath of folderDeleteSet) {
        //   const files: string[] = readdirSync(folderPath);
        //   if (files.length === 0) {
        //     console.log('Remove folder', folderPath);
        //     removeSync(folderPath);
        //   }
        // }
        const token = { cancel: cancelToken.cancel };
        await dropboxSync.waitChanges('*', token);
      } catch (err) {
        console.error(err);
      }
    }
  }

  private config: IAccountSyncConfigurationMap;
  private waitInterval: number;
  private verbose: boolean;

  constructor(config: IDropboxSyncConfiguration) {
    this.config = {};
    config.accounts.forEach(syncConfig => {
      syncConfig.dbx = new Dropbox({
        accessToken: syncConfig.accessToken,
        fetch,
      });
      this.config[syncConfig.name] = syncConfig;
    });
    this.waitInterval = config.waitInterval || 30;
    this.verbose = config.verbose || true;
  }

  public getFileList(account: string = '*', onlyDirectories: boolean = false): string[] {
    const result: string[] = [];
    if (account === '*') {
      const fileLists = Object.keys(this.config).map((key: string) => this.getFileList(key, onlyDirectories));
      return result.concat(...fileLists);
      // return results.reduce((prev, curr) => {prev.push(...curr); return prev; }, []);
    }

    const config = this.config[account];
    const fileList = config.mappings.map((mappingItem: IMappingItem) => {
      return fg.sync([mappingItem.dst + '/**/*'], { dot: true, onlyDirectories });
    });
    return result.concat(...fileList);
  }

  public getContentHash(path: string): Promise<string> {
    return new Promise((resolve, _) => {
      if (!existsSync(path)) {
        resolve('');
        return;
      }

      const hasher = new DropboxContentHasher();
      const f = createReadStream(path);
      f.on('data', buf => {
        hasher.update(buf);
      });
      f.on('end', () => {
        const hexDigest = hasher.digest('hex');
        resolve(hexDigest);
      });
      f.on('error', err => {
        console.error('Error reading from file: ' + err);
        resolve('');
      });
    });
  }

  public async waitChanges(account: string = '*', cancelToken: ICancelToken = { cancel: false }): Promise<boolean> {
    if (account === '*') {
      const promises = Object.keys(this.config).map((key: string) => this.waitChanges(key, cancelToken));
      const result = await Promise.race(promises);
      cancelToken.cancel = true;
      return result;
    }

    const config = this.config[account];
    const dbx = config.dbx as Dropbox;

    while (true) {
      try {
        const waiters = config.mappings.map(
          (mappingItem: IMappingItem): Promise<DropboxTypes.files.ListFolderLongpollResult | undefined> => {
            const cursor = mappingItem.cursor;

            if (cursor) {
              return dbx.filesListFolderLongpoll({
                cursor: cursor as DropboxTypes.files.ListFolderCursor,
                timeout: this.waitInterval,
              });
            } else {
              return sleep(this.waitInterval);
            }
          },
        );

        const result = await Promise.race(waiters);
        if (result) {
          if (result.changes) {
            return true;
          } else {
            if (cancelToken.cancel) {
              return false;
            }
            if (result.backoff) {
              await sleep(result.backoff as number);
            }
          }
        }
      } catch (err) {
        if (cancelToken.cancel) {
          return false;
        }
        console.error(err);
      }
    }
  }

  public async downloadFiles(account: string = '*'): Promise<ISyncedFiles> {
    const result: ISyncedFiles = {
      fileSet: new Set(),
      folderSet: new Set(),
    };

    if (account === '*') {
      const promises = Object.keys(this.config).map((key: string) => this.downloadFiles(key));
      const results = await Promise.all(promises);
      results.forEach(item => {
        for (const elem of item.fileSet) {
          result.fileSet.add(elem);
        }
        for (const elem of item.folderSet) {
          result.folderSet.add(elem);
        }
      });
      return result;
    }

    const config = this.config[account];
    const dbx = config.dbx as Dropbox;

    const waiters = config.mappings.map(async (mappingItem: IMappingItem) => {
      let hasMore = true;
      const writerPromises = [];

      result.folderSet.add(mappingItem.dst);

      try {
        while (hasMore) {
          let response;
          if (!mappingItem.cursor) {
            response = await dbx.filesListFolder({
              include_deleted: true,
              path: mappingItem.src,
              recursive: true,
            });
          } else {
            response = await dbx.filesListFolderContinue({ cursor: mappingItem.cursor });
          }
          mappingItem.cursor = response.cursor;
          hasMore = response.has_more;

          this.log('Received', response.entries.length, 'entries from', config.name);
          const writerPromisesList = response.entries
            // .filter(item => item['.tag'] === 'file')
            .map(async item => {
              const filePath = join(
                mappingItem.dst,
                (item.path_display as string).substring(mappingItem.src.length + 1),
              );

              if (item['.tag'] === 'file') {
                //   mkdirSync(dirname(filePath), { recursive: true });
                ensureDirSync(dirname(filePath));

                result.fileSet.add(filePath);

                const remoteContentHash = (item as DropboxTypes.files.FileMetadataReference).content_hash;
                const localContentHash = await this.getContentHash(filePath);
                if (remoteContentHash === localContentHash) {
                  this.log(`Skip downloading ${filePath}`);
                  return;
                }

                const tempLink = await dbx.filesGetTemporaryLink({ path: item.path_display as string });
                const res = await fetch(tempLink.link);
                const fileStream = createWriteStream(filePath);
                await new Promise((resolve, reject) => {
                  res.body.pipe(fileStream);
                  res.body.on('error', (err: any) => {
                    reject(err);
                  });
                  fileStream.on('finish', () => {
                    if (localContentHash === '') {
                      this.log(`Download ${filePath}`);
                    } else {
                      this.log(`Overwrite ${filePath}`);
                    }
                    resolve();
                  });
                });
              } else if (item['.tag'] === 'folder') {
                this.log('Create', filePath);
                ensureDirSync(filePath);
                result.folderSet.add(filePath);
              } else if (item['.tag'] === 'deleted') {
                if (existsSync(filePath)) {
                  this.log('Delete', item.path_display);
                  const fileStat = lstatSync(filePath);
                  if (fileStat.isDirectory()) {
                    removeSync(filePath);
                  } else {
                    unlinkSync(filePath);
                  }
                }
              }
            });
          writerPromises.push(...writerPromisesList);

          // response.entries
          //   .filter(item => item['.tag'] === 'folder')
          //   .map(item => {
          //     const filePath = join(
          //       mappingItem.dst,
          //       (item.path_display as string).substring(mappingItem.src.length + 1),
          //     );
          //     ensureDirSync(filePath);
          //     result.folderSet.add(filePath);
          //   });
        }
      } catch (err) {
        console.error(err);
      }
      await Promise.all(writerPromises);
      mappingItem.updated = true;
    });

    await Promise.all(waiters);

    return result;
  }

  private log(...messages: any[]) {
    if (this.verbose) {
      console.log(...messages);
    }
  }
}

export { DropboxSyncFolder };
