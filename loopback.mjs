import Credentials from "@ki1r0y/distributed-security";
export { Credentials };

// todo: do not export
export const Persist = { // TODO: use indexeddb in browser, fs in NodeJS
  stores: {},
  lists: {},
  async put(collectionName, tag, signature) {
    this.stores[collectionName] ||= {};
    this.lists[collectionName]  ||= new Set();

    this.stores[collectionName][tag] = signature;
    this.lists[collectionName].add(tag);
    return tag;
  },
  async delete(collectionName, tag, signature) {
    // We cannot remove items because merging with an earlier write would restore the item!
    this.put(collectionName, tag, signature);
    this.lists[collectionName].delete(tag);
  },
  async get(collectionName, tag) {
    this.stores[collectionName] ||= {};
    return this.stores[collectionName][tag];
  },
  async list(collectionName) {
    // We cannot just list the keys of the collection, because that includes empty payloads of items that have been deleted.
    this.lists[collectionName] ||= {};
    return Array.from(this.lists[collectionName].keys());
  }
};

class Collection {
  constructor({name, services = []}) {
    Object.assign(this, {name});
    this.synchronize(services);
  }
  services =[]; // To keep different services in sync, we cannot depend on order.
  debug = false;
  log(...rest) {
    if (!this.debug) return;
    console.log(this.name, ...rest);
  }
  _canonicalizeOptions({owner:team = Credentials.owner, author:member = Credentials.author,
			tag,
			encryption = Credentials.encryption}) {
    // TODO: support simpflied syntax, too, per README
    // TODO: should we specify subject: tag for both mutables?
    const options = (team && team !== member) ?
	  {team, member, tag, encryption} :
	  {tags: [member], tag, time: Date.now(), encryption}; // No iat if time not explicitly given.
    if ([true, 'team', 'owner'].includes(options.encryption)) options.encryption = team;
    return options;
  }
  async store(data, options = {}) {
    const {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    // TODO: encrypt
    // TODO: default tag to hash AFTER any encryption. (It is in protectedHeader.sub by default.)
    // No need to await synchronization.
    // TODO: put on all services
    const signature = await Credentials.sign(data, signingOptions);
    return this.put(tag, signature);
  }
  async remove(options = {}) { // Note: Really just replacing with empty data forever. Otherwise merging with earlier data will bring it back!
    // TODO: Provide some mechanism to really destroy something, and use it in tests.
    // Maybe a 'temporary', 'unmergeable', or 'lifetime' option in store? (Persist would have to keep track of such like it does for List, and then remove would act?)
    const {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    // TODO: emit update
    // No need to await synchronization
    // TODO: delete on all services.
    return this.delete(tag, await Credentials.sign('', signingOptions));
  }
  async retrieve(tag) {
    await this.synchronize1(tag);
    const signature = await this.get(tag);
    const verified = await Credentials.verify(signature);
    // TODO decrypt
    return verified;
  }
  async list() { // List all tags of this collection.
    await this.synchronizeTags();
    return Persist.list(this.name);
  }
  async match(tag, properties) { // Is this signature what we are looking for?
    const signature = await this.get(tag);
    const verified = await Credentials.verify(signature);  // OOF!
    const data = verified?.json;
    if (!data) return false;
    for (const key in properties) {
      if (data[key] !== properties[key]) return false;
    }
    return true;
  }
  async findLocal(properties) { // Find the tag in our store that matches, else falsey
    for (const tag of await Persist.list(this.name)) { // Direct Persist.list, w/o sync.
      if (await this.match(tag, properties)) return tag;
    }
    return false;
  }
  async find(properties) { // Answer the tag that has values matching the specified properties. Obviously, can't be encrypted as a whole.
    let found = await this.findLocal(properties);
    if (found) {
      await this.synchronize1(found); // Make sure the data is up to date. Then check again.
      if (await this.match(found, properties)) return found;
    }
    // No match.
    await this.synchronizeTags();
    await this.synchronizeData();
    found = await this.findLocal(properties);
    if (found && await this.match(found, properties)) return found;
    return null;
  }

  // These three ignore synchronization state, which if neeed is the responsibility of the caller.
  async get(tag) { // Get the local raw signature data.
    return Persist.get(this.name, tag);
  }
  async validate(tag, signature) {
    let verified = await Credentials.verify(signature);
    if (!verified) throw new Error(`The signature is not valid.`);    
  }
  async put(tag, signature, services = this.services) { // Put the raw signature locally and the specified services. Can be triggered by us or any service.
    await this.validate(tag, signature);
    // TODO: emit update.
    // TODO: put on all services
    return Persist.put(this.name, tag, signature);
  }
  async delete(tag, signature, services = this.services) { // Remove the raw signature locally and on the specified services. Can be triggered by us or any service.
    await this.validate(tag, signature);
    // TODO: emit update.
    // TODO: put on all services    
    return Persist.delete(this.name, tag, signature); // Signature payload is empty.
  }

  promise(key, thunk) { return thunk; } // TODO: how will we keep track of overlapping distinct syncs?
  async synchronize1(tag) { // Compare against any remaining unsynchronized data, fetch what's needed, and resolve locally.
    return this.promise(tag, () => Promise.resolve()); // TODO
  }
  async synchronizeTags() { // Ensure that we have up to date tag map among all services. (We don't care yet of the values are synchronized.)
    return this.promise('tags', () => Promise.resolve()); // TODO
  }
  async synchronizeData() { // Make the data to match our tagmap, using synchronize1.
    return this.promise('data', () => Promise.resolve()); // TODO
  }
  async connect(service) { // Receive pushed messages from the given service. get/put/delete when they come (with empty services list).
    return null; // TODO
  }
  async synchronize(services = []) { // Start running the specified services (in addition to whatever is already running).
    let connections = [];
    for (let service of services) {
      if (this.services.includes(service)) await this.disconnect([service]); // Reset the service rather than error.
      connections.push(this.connect(service));
      this.services.push(service);
    }
    await Promise.all(connections);
    await this.synchronizeTags();
    await this.synchronizeData();
  }
  async disconnect(services = this.services.slice()) { // Shut down the specified services.
    for (let service of services()) {
      // TODO: shut it down, and remove any effected tagmap data/
      this.services.splice(this.services.indexOf(service), 1);
    }
  }
}
// TODO: different rules for synchronizeTags, synchronize1
export class ImmutableCollection extends Collection {
}
export class MutableCollection extends Collection {
}
export class VersionedCollection extends MutableCollection {
}


// When running in NodeJS, the Security object is available directly.
// It has a Storage property, which defines store/retrieve (in lib/storage.mjs) to GET/PUT on
// origin/db/:collectionName/:part1ofTag/:part2ofTag/:part3ofTag/:restOfTag.json
// The Security.Storage can be set by clients to something else.
//
// When running in a browser, worker.js overrides this to send messages through the JSON RPC
// to the app, which then also has an overridable Security.Storage that is implemented with the same code as above.

// Bash in some new stuff:
Credentials.author = null;
Credentials.owner = null;
Credentials.encryption = null;
Credentials.synchronize = (services) => {
  Object.values(Credentials.collections).forEach(collection => collection.synchronize(services));
};
Credentials.createAuthor = async (prompt) => {
  const [local, recovery] = await Promise.all([Credentials.create(), Credentials.create({prompt})]);
  return Credentials.create(local, recovery);
};
Credentials.Storage.retrieve = async (collectionName, tag) => {
  const collection = Credentials.collections[collectionName];
  await collection.synchronize1(tag);
  return collection.get(tag);
}
Credentials.Storage.store = async (collectionName, tag, signature) => {
  // TODO: Modify dist-sec to have a separate store/delete, rather than having to await verify.
  const verified = await Credentials.verify(signature);
  if (!verified) throw new Error(`Signature ${signature} does not verify.`);
  const collection = Credentials.collections[collectionName];
  if (verified.payload.length) return collection.put(tag, signature);
  return collection.delete(tag, signature);
};
Credentials.collections = {};
['EncryptionKey', 'KeyRecovery', 'Team'].forEach(name => Credentials.collections[name] = new MutableCollection({name}));

