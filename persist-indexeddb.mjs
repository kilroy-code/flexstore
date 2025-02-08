export class Persist {
  // Asynchronous local storage, available in web workers.
  constructor({collectionName = 'collection', dbName = 'flexstore1'} = {}) {
    // Capture the data here, but don't open the db until we need to.
    // this.collectionName = collectionName;
    // this.dbName = dbName;
    this.collectionName = 'test';
    this.dbName = collectionName;

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

export default Persist;
