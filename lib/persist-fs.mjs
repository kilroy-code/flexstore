import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tagPath} from './tagPath.mjs';
import { storageVersion, storageName } from './version.mjs';

export async function mkdir(pathname) { // Make pathname exist, including any missing directories.
  if (!await fs.mkdir(pathname, {recursive: true}).catch(error => console.error(error))) return;
  // Subtle: On some machines (e.g., my mac with file system encryption), mkdir does not flush,
  // and a subsequent read gets an error for missing directory.
  // We can't control what happens in express.static, so let's ensure here that reading works the way we think.
  let dummy = path.join(pathname, 'dummy');
  await fs.writeFile(dummy, '', {flush: true});
  try {
    await fs.unlink(dummy);
  } catch (e) {
    console.log(e); // but otherwise ignore
  }
}

export class PersistFileSystem {
  // Asynchronous local storage using the Node file system.
  //
  // Each promises a string (including store, or read/remove of non-existent tag).
  //
  // Interleaved store/retrieve/remove are not deterministic between processes, but:
  // - They are still safe between processes - store/remove are atomic
  // - Within a process, the are deterministic because all operationss queued.

  constructor({collection, collectionLabel = collection?.fullLabel, dbName = storageName, dbVersion = storageVersion, temporarySubdirectory = 'temp'} = {}) {
    this.base = path.resolve(`${dbName}:${dbVersion}/${collectionLabel}`);
    // The temporary files are all in the same temporarySubdirectory which is
    // 1. Created just once when creating the collection.
    // 2. A subdirectory of the collection, so that it is on the same file system.
    this.temporaryPath = tag => path.join(this.base, temporarySubdirectory,
                                          tag + randomBytes(6).readUIntLE(0,6).toString(36));
    // Ensure path to collection and it's temporarySubdirectory. No errors if parts exist.
    // Also the first item in our queue. (constructors cannot be async, but we want to ensure the path exists before any ops).
    this.queue = mkdir(path.join(this.base, temporarySubdirectory));
  }
  close() { }
  async destroy() {
    await new Promise(resolve => setTimeout(resolve, 200)); // Because OSX file system...
    return fs.rm(this.base, {recursive: true, force: true});
  }
  path(tag) {
    try {
      return tagPath(this.base, tag, '');
    } catch (error) {
      console.error(`Cannot determine path for '${tag}': ${error.message}.`);
      return '';
    }
  }
  list() {
    return fs.readdir(this.base, {withFileTypes: true, recursive: true})
      .then(files => files
	    .filter(dirent => dirent.isFile() && !dirent.parentPath.includes('temp'))
	    .map(dirent => {
	      const relative = path.relative(this.base, dirent.parentPath);
	      const parts = relative.split(path.sep);
	      const [b, c, a] = parts;
	      const rest = dirent.name;
	      const tag = a + b + c + rest;
	      return tag;
	    }),
	    error => {console.log(error); return [];});
  }
  get(tag) { // Promise to retrieve tag from collection.
    return this.queue = this.queue.then(async () => {
      return fs.readFile(this.path(tag), {encoding: 'utf8'})
	.catch(() => "");
    });
  }
  put(tag, data) { // Promise to store data at tag in collection.
    async function rename(source, destination) {
      try {
	await fs.rename(source, destination);
	return true;
      } catch (e) {
	//console.warn(e);
	return false;
      }
    }
    return this.queue = this.queue.then(async () => {
      // Write to temp (as that is not atomic) and then rename (which is atomic).
      let temp = this.temporaryPath(tag),
          pathname = this.path(tag);
      await mkdir(path.dirname(pathname));
      await fs.writeFile(temp, data, {flush: true});
      for (let i = 0; i < 3; i++) {
	if (await rename(temp, pathname)) return '';
      }
      return "";
    });
  }
  delete(tag) { // Promise to remove tag from collection.
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
export default PersistFileSystem;
