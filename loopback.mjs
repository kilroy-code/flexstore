import Credentials from "@ki1r0y/distributed-security";
export { Credentials };
const { CustomEvent } = globalThis;

// todo: do not export
export const Persist = { // TODO: use indexeddb in browser, fs in NodeJS
  stores: {},
  lists: {},
  async put(collectionName, tag, payload) {
    this.stores[collectionName] ||= {};
    this.lists[collectionName]  ||= new Set();

    this.stores[collectionName][tag] = payload;
    this.lists[collectionName].add(tag);
    return tag;
  },
  async delete(collectionName, tag, payload) {
    // We cannot remove items because merging with an earlier write would restore the item!
    this.put(collectionName, tag, payload);
    this.lists[collectionName].delete(tag);
    return tag;
  },
  async get(collectionName, tag) {
    this.stores[collectionName] ||= {};
    return this.stores[collectionName][tag];
  },
  async list(collectionName) { // Maybe we should maintain the list in the Collection instead of here?
    // We cannot just list the keys of the collection, because that includes empty payloads of items that have been deleted.
    this.lists[collectionName] ||= {};
    return Array.from(this.lists[collectionName].keys());
  }
};

class Collection extends EventTarget {
  constructor({name, services = []}) {
    super();
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
			encryption = Credentials.encryption} = {}) {
    // TODO: support simplified syntax, too, per README
    // TODO: should we specify subject: tag for both mutables? (gives hash)
    const options = (team && team !== member) ?
	  {team, member, tag, encryption} :
	  {tags: [member], tag, time: Date.now(), encryption}; // No iat if time not explicitly given.
    if ([true, 'team', 'owner'].includes(options.encryption)) options.encryption = team;
    return options;
  }
  fail(operation, data, author) {
    throw new Error(`${author} does not have the authority to ${operation} ${JSON.stringify(data)}.`);
  }
  encryptedMimeType = 'text/encrypted';
  async store(data, options = {}) {
    const {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    if (encryption) {
      data = await Credentials.encrypt(data, encryption);
      signingOptions.contentType = this.encryptedMimeType;
    }
    // No need to await synchronization.
    // TODO: put on all services
    const signature = await Credentials.sign(data, signingOptions);
    return (await this.put(tag, signature)) ||
      this.fail('store', data, options.member || options.tags[0]);
  }
  async remove(options = {}) { // Note: Really just replacing with empty data forever. Otherwise merging with earlier data will bring it back!
    // TODO: Provide some mechanism to really destroy something, and use it in tests.
    // Maybe a 'temporary', 'unmergeable', or 'lifetime' option in store? (Persist would have to keep track of such like it does for List, and then remove would act?)
    const {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    // No need to await synchronization
    // TODO: delete on all services.
    return (await this.delete(tag, await Credentials.sign('', signingOptions))) ||
      this.fail('remove', tag, options.member || options.tags[0]);;
  }
  async retrieve(tag) {
    await this.synchronize1(tag);
    const signature = await this.get(tag);
    if (!signature) return signature;
    const verified = await Credentials.verify(signature);
    if (verified.protectedHeader.cty === this.encryptedMimeType) {
      const decrypted = await Credentials.decrypt(verified.text);
      verified.json = decrypted.json;
      verified.text = decrypted.text;
      verified.payload = decrypted.payload;
      verified.decrypted = decrypted;
    }
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
  // FIXME TODO: after initial development, these three should be made internal so that application codde
  // does not call them.
  get(tag) { // Get the local raw signature data.
    return Persist.get(this.name, tag);
  }
  // These two can be triggered by client code or by any service.
  async put(tag, signature) { // Put the raw signature locally and the specified services.
    const validation = await this.validate(tag, signature);
    if (!validation) return undefined;
    return Persist.put(this.name, validation.tag, signature);
  }
  async delete(tag, signature) { // Remove the raw signature locally and on the specified services.
    const validation = await this.validate(tag, signature, 'requireTag');
    if (!validation) return undefined;
    return Persist.delete(this.name, validation.tag, signature); // Signature payload is empty.
  }

  notifyInvalid(tag, message = undefined) {
    console.warn(this.name, message || // fixme remove after development
		 `Signature is not valid for ${tag || 'data'}.`);
    return undefined;
  }
  async validate(tag, signature, requireTag = false) {
    const verified = await Credentials.verify(signature);
    if (!verified) return this.notifyInvalid(tag);
    tag = verified.tag = requireTag ? tag : this.tag(tag, verified);
    const existingSignature = await this.get(tag);
    if (existingSignature) {
      const existingVerified = await Credentials.verify(existingSignature);
      const existing = existingVerified.protectedHeader;
      const proposed = verified.protectedHeader;
      if (proposed.iat < existing.iat) return this.notifyInvalid(tag, 'replay');
      const existingOwner = existing.iss || existing.kid;
      const proposedOwner = proposed.iss || proposed.kid;
      // Exact match. Do we need to allow for an owner to transfer ownership to a sub/super/disjoint team?
      // Currently, that would require a new record. (E.g., two Mutable/VersionedCollection items that
      // have the same GUID payload property, but different tags. I.e., a different owner means a different tag.)
      if (!proposedOwner || (proposedOwner !== existingOwner)) return this.notifyInvalid(tag, 'not owner');
      /*
	We are not checking to see if author is currently a member of the owner team here, which
	is called by put()/delete() in two circumstances:
	
	this.validate() is called by put()/delete() which happens in the app (via store()/remove())
	and during sync from another service:
	
	1. From the app (vaia store()/remove(), where we have just created the signature. Signing itself
	will fail if the (1-hour cached) key is no longer a member of the team. There is no interface
	for the app to provide an old signature. (TODO: after we make get/put/delete internal.)
	
	2. During sync from another service, where we are pulling in old records for which we don't have
	team membership from that time.

	If the app cares whether the author has been kicked from the team, the app itself will have to check.
	TODO: we should provide a tool for that.
       */
    }
    this.dispatchEvent(new CustomEvent('update', {detail: verified}));
    return verified;
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
// TODO: different rules for hash tag, synchronizeTags, synchronize1
export class ImmutableCollection extends Collection {
  tag(tag, validation) { // Ignores tag. Just the hash.
    return validation.protectedHeader.sub;
  }
}
export class MutableCollection extends Collection {
  tag(tag, validation) { // Use tag if specified, but defaults to hash.
    return tag || validation.protectedHeader.sub;
  }
}
export class VersionedCollection extends MutableCollection {
  constructor(...rest) {
    super(...rest);
    this.versionName = this.name + 'Versions';
  }
  async retrieveTimestamps(tag) {
    const json = await Persist.get(this.name, tag);
    if (!json) return undefined;
    const timestamps = JSON.parse(json);
    return Object.keys(timestamps).slice(1);
  }
  async get(tagOrOptions) { // Get the local raw signature data.
    const isTag = typeof(tagOrOptions) === 'string';
    const tag = isTag ? tagOrOptions : tagOrOptions.tag;
    const json = await Persist.get(this.name, tag);
    if (!json) return undefined;
    const timestamps = JSON.parse(json);
    const time = (!isTag && tagOrOptions.time) || timestamps.latest;
    let hash = timestamps[time];
    if (!hash) { // We need to find the timestamp that was in force at the requested time.
      let best = 0, times = Object.keys(timestamps);
      for (let i = 1; i < times.length; i++) { // 0th is the key 'latest'.
	if (times[i] <= time) best = times[i];
	else break;
      }
      hash = timestamps[best];
    }
    return Persist.get(this.versionName, hash); // Will be empty if relevant timestamp doesn't exist (deleted).
  }
  async put(tag, signature) { // The signature goes to a hash version, and the tag gets updated with a new time=>hash.
    const validation = await this.validate(tag, signature);
    if (!validation) return undefined;
    tag = this.tag(tag, validation);
    const json = await Persist.get(this.name, tag);
    const timestamps = json ? JSON.parse(json) : {};
    const time = validation.protectedHeader.iat;
    const hash = validation.protectedHeader.sub;
    timestamps.latest = time;
    timestamps[time] = hash;
    await Persist.put(this.versionName, hash, signature);
    Persist[validation.payload.length ? 'put' : 'delete'](this.name, tag, JSON.stringify(timestamps));
    return tag;
  }
  async delete(tag, signature) { // Remove the raw signature locally and on the specified services.
    return this.put(tag, signature);
  }
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

