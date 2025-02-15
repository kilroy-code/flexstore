import {tagPath, basePath} from './tagPath.mjs';

export class PersistHosted {
  // Asynchronous local storage using the Node file system.
  constructor({collection, collectionType = collection.constructor.name, collectionName = collection.name, dbName = '/flexstore'} = {}) {
    this.collectionName = collectionName;
    this.base = basePath(dbName, collectionType, collectionName);
  }
  path(tag) {
    return tagPath(this.base, tag, '');
  }
  fail(tag, response) {
    //console.warn(this.collectionName, tag, response.statusText); // Browse reports this.
    return '';
  }
  async request(tag, method = 'GET', body = '') { // Promise a response from host (specifed by dbName).
    const path = this.path(tag);
    const options = body ?
	  {method, body, headers: {"Content-Type": body.startsWith("{") ? "application/jose+json" : "application/jose"}} :
	  {/*cache: 'reload',/*fixme*/ headers: {"Accept": "application/jose"}};
    const response = await fetch(path, options);
    if (!response.ok) return this.fail(tag, response);
    return response.text();
  }
  async get(tag) { // Promise to retrieve tag from collectionName.
    return this.request(tag);
  }
  async put(tag, data) { // Promise to store data at tag in collectionName.
    return this.request(tag, 'PUT', data);
  }
  async delete(tag, data) { // Promise to store data at tag in collectionName.
    return this.request(tag, 'DELETE', data);
  }
};
export default PersistHosted;
