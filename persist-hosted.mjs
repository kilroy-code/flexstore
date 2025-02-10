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
    // console.warn(this.collectionName, tag, response.statusText); // Browse reports this.
    return '';
  }
  async request(tag, method = 'GET', body = '') { // Promise a response from host (specifed by dbName).
    const options = body ?
	  {method, body, headers: {"Content-Type": body.startsWith("{") ? "application/jose+json" : "application/jose"}} :
	  {headers: {"Accept": "application/jose"}};
    const response = await fetch(this.path(tag), options);
    if (!response.ok) return this.fail(tag, response);
    return response;
  }
  async get(tag) { // Promise to retrieve tag from collectionName.
    const response = await  this.request(tag);
    return response && response.text();
  }
  async put(tag, data) { // Promise to store data at tag in collectionName.
    await this.request(tag, 'PUT', data);
    return tag;
  }
  async delete(tag, data) { // Promise to store data at tag in collectionName.
    await this.request(tag, 'DELETE', data);
    return tag;
  }
};
export default PersistHosted;
