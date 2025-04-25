import { storageVersion, storageName } from './version.mjs';

export class PersistIndexedDB {
  // Asynchronous local storage, available in web workers.
  constructor({collection, collectionType = collection.constructor.name, collectionName = collection.name, dbName = storageName, dbVersion = storageVersion} = {}) {
    // Conceptually, different programs can open their own connections to the
    // database that holds all this stuff (e.g., 'flexstore', via version.mjs)
    // that has as many collections as needed (dynamically added) (e.g., 'MutableCollection:com.acme.users')
    // with one current version at a time.
    //
    // But that's not the way indexedDB is set up. It really wants all the objectStores to be known at the time that the db is opened.
    // So internally to this class, here's what we do (currently):
    //   We open a different db for each combined collectionType:collectionName, on demand.
    //   Each has ONE objectStore that the combined dbName:dbVersion. If it doesn't exist, we close and reopen for upgrade
    //     but we don't have to worry about other connections to the db, because each collection is it's own db.
    this.db_name = `${collectionType}:${collectionName}`;
    this.objectStore_name = `${dbName}:${dbVersion}`;
  }
  get db() { // Answer a promise for the database, creating it if needed.
    return this._db ??= new Promise(resolve => {
       const request = indexedDB.open(this.db_name, this.db_version);
      // createObjectStore can only be called from upgradeneeded, which is only called for new indexedDB versions.
      request.onupgradeneeded = ({oldVersion, newVersion, target}) => this.upgrade(target.result, oldVersion, newVersion);
      this.result(resolve, request);
    });
  }
  upgrade(db, oldVersion, newVersion) {
    const {objectStore_name} = this;
    // Currently, we just leave previous generations on the floor.
    // We could also look for previous generations and do something with them (such as delete them!)
    if (db.objectStoreNames.contains(objectStore_name)) return;
    db.createObjectStore(objectStore_name);
  }
  transaction(mode = 'read') { // Answer a promise for the named object store on a new transaction.
    const {objectStore_name} = this;
    return this.db.then(db => {
      if (!db.objectStoreNames.contains(objectStore_name)) {
	this._db = null;
	this.db_version = db.version + 1;
	db.close();
	return this.transaction(mode);
      }
      return db.transaction(objectStore_name, mode).objectStore(objectStore_name);
    });
  }
  result(resolve, operation) {
    operation.onsuccess = event => resolve(event.target.result || ''); // Not undefined.
  }
  list() { // Promise a list of all the stored tags.
    return new Promise(resolve => {
      this.transaction('readonly').then(store => this.result(resolve, store.getAllKeys()));
    });
  }
  get(tag) { // Promise to retrieve tag from collectionName.
    return new Promise(resolve => {
      this.transaction('readonly').then(store => this.result(resolve, store.get(tag)));
    });
  }
  put(tag, data) { // Promise to store data at tag in collectionName.
    return new Promise(resolve => {
      this.transaction('readwrite').then(store => this.result(resolve, store.put(data, tag)));
    });
  }
  delete(tag) { // Promise to really remove tag from collectionName. (Not just writing empty JWS payload.)
    return new Promise(resolve => {
      this.transaction('readwrite').then(store => this.result(resolve, store.delete(tag)));
    });
  }
  async close() { // Ensures db is closed.
    if (!this._db) return null;
    (await this.db).close();
    return new Promise(resolve => setTimeout(resolve, 1e3)); // There doesn't seem to be a way to observe when it actually closed.
  }
  async destroy() { // Removes the db entirely.
    await this.close();
    const request = window.indexedDB.deleteDatabase(this.db_name);
    return new Promise((resolve, reject) => {
      request.onsuccess = setTimeout(resolve, 1e3); // In case of sloppy implementations interacting with test suite.
      request.onerror = reject;
    });
  }
}

export default PersistIndexedDB;
