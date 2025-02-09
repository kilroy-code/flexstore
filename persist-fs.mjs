import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
//import {tagPath} from './tagPath.mjs';
function tagPath(collectionName, tag, extension = 'json') { // Pathname to tag resource.
  if (!tag) return collectionName;
  return `${collectionName}/${tag}.${extension}`;
}

export async function mkdir(pathname) { // Make pathname exist, including any missing directories.
  if (!await fs.mkdir(pathname, {recursive: true})) return;
  // Subtle: On some machines (e.g., my mac with file system encryption), mkdir does not flush,
  // and a subsequent read gets an error for missing directory.
  // We can't control what happens in express.static, so let's ensure here that reading works the way we think.
  let dummy = path.join(pathname, 'dummy');
  await fs.writeFile(dummy, '', {flush: true});
  await fs.unlink(dummy);
}

export class Persist {
  // Asynchronous local storage using the Node file system.
  //
  // Each promises a string (including store, or read/remove of non-existent tag).
  //
  // Interleaved store/retrieve/remove are not deterministic between processes, but:
  // - They are still safe between processes - store/remove are atomic
  // - Within a process, the are deterministic because all operationss queued.

  constructor({collectionName = 'collection', dbName = 'asyncLocalStorage', temporarySubdirectory = 'temp'} = {}) {
    this.collectionName = collectionName;
    this.base = dbName;
    this.path = tag => path.join(dbName, tagPath(collectionName, tag, 'text'));
    // The temporary files are all in the same temporarySubdirectory which is
    // 1. Created just once when creating the collection.
    // 2. A subdirectory of the collection, so that it is on the same file system.
    this.temporaryPath = tag => path.join(dbName, collectionName, temporarySubdirectory,
                                          tag + randomBytes(6).readUIntLE(0,6).toString(36));
    // Ensure path to collectionName and it's temporarySubdirectory. No errors if parts exist.
    // Also the first item in our queue. (constructors cannot be async, but we want to ensure the path exists before any ops).
    this.queue = mkdir(path.join(dbName, collectionName, temporarySubdirectory));
  }

  get(tag) { // Promise to retrieve tag from collectionName.
    return this.queue = this.queue.then(async () => {
      return fs.readFile(this.path(tag), {encoding: 'utf8'})
	.catch(() => "");
    });
  }
  put(tag, data) { // Promise to store data at tag in collectionName.
    return this.queue = this.queue.then(async () => {
      // Write to temp (as that is not atomic) and then rename (which is atomic).
      let temp = this.temporaryPath(tag),
          pathname = this.path(tag);
      await mkdir(path.dirname(pathname));
      await fs.writeFile(temp, data, {flush: true});
      await fs.rename(temp, pathname);
      return "";
    });
  }  
  delete(tag) { // Promise to remove tag from collectionName.
    return this.queue = this.queue.then(async () => {
      // Rename before rm, as rm will fail if there is contention.
      let temp = this.temporaryPath(tag),
          pathname = this.path(tag),
          error = await fs.rename(pathname, temp).catch(error => error);
      if (error?.code === 'ENOENT') return ""; // Not undefined
      if (error) return Promise.reject(error);
      await fs.rm(temp);
      let directory = path.dirname(pathname);
      while (directory != this.base && !(await fs.readdir(directory)).length) {
        await fs.rmdir(directory, {maxRetries: 3});
        directory = path.dirname(directory);
      }
      return "";
    });
  }  
};
export default Persist;
