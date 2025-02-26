export class PersistIndexedDB {
  // Asynchronous local storage, available in web workers.
  constructor({collection, collectionType = collection.constructor.name, collectionName = collection.name, dbName = 'flexstore1'} = {}) {
    // HACK. FIXME. We reverse collectionName and dbName so that each collection is its own db.
    // TODO: Arrange so that if an existing db is opened without the needed collectionName as an objectStore,
    // re-open with a new version and createObjectStore in upgradeneeded. Alas, I was not initially able
    // to do this without existing collections hanging.
    this.collectionName = dbName;
    this.dbName = `${collectionType}:${collectionName}`;

    this.version = 1;
  }
  get db() { // Answer a promise for the database, creating it if needed.
    return this._db ??= new Promise(resolve => {
      const request = indexedDB.open(this.dbName, this.version);
      // createObjectStore can only be called from upgradeneeded, which is only called for new versions.
      request.onupgradeneeded = event => event.target.result.createObjectStore(this.collectionName);
      this.result(resolve, request);
    });
  }
  transaction(mode = 'read') { // Answer a promise for the named object store on a new transaction.
    const collectionName = this.collectionName;
    return this.db.then(db => db.transaction(collectionName, mode).objectStore(collectionName));
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
}

export default PersistIndexedDB;
