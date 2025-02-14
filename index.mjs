import Credentials from '@ki1r0y/distributed-security';
export { Credentials };
const {default:Persist} = await import((typeof(process) !== 'undefined') ? './persist-fs.mjs' : './persist-indexeddb.mjs');
//import Persist from './persist-hosted.mjs';
const { CustomEvent, EventTarget } = globalThis;

class Collection extends EventTarget {
  constructor({name, services = [], preserveDeletions = !!services.length, persistenceClass = Persist}) {
    super();
    Object.assign(this, {name, preserveDeletions, persistenceClass});
    this.synchronize(services);
    this.persist = new persistenceClass({collection: this});
  }
  services =[]; // To keep different services in sync, we cannot depend on order.

  // Credentials.sign/.verify can produce/accept JSON OBJECTS for the named "JSON Serialization" form.
  // As it happens, distributed-security can distinguish between a compact serialization (base64 text)
  // vs an object, but it does not recognize a SERIALIZED object. Here we bottleneck those operations
  // such that the thing that is actuall persisted and synchronized is always a string -- either base64
  // compact or JSON beginning with a "{" (which are distinguishable because "{" is not a base64 character).
  static ensureString(signature) { // Return a signature that is definately a string.
    if (typeof(signature) !== 'string') return JSON.stringify(signature);
    return signature;
  }
  // Return a compact or "JSON" (object) form of signature (inflating a serialization of the latter if needed), but not a JSON string.
  static maybeInflate(signature) {
    if (signature?.startsWith?.("{")) return JSON.parse(signature);
    return signature;
  }
  static async sign(data, options) {
    const signature = await Credentials.sign(data, options);
    return this.ensureString(signature);
  }
  static async verify(signature) {
    signature = this.maybeInflate(signature);
    const verified =  await Credentials.verify(signature);
    return verified;
  }

  // TODO: persist this.
  tags = new Set(); // Keeps track of our (undeleted) keys. Deleted keys are still present for sync'ing, so a db listing won't do.
  async addTag(tag) {
    this.tags.add(tag);
  }
  async deleteTag(tag) {
    this.tags.delete(tag);
  }
  
  debug = false;
  log(...rest) {
    if (!this.debug) return;
    console.log(this.name, ...rest);
  }
  _canonicalizeOptions({owner:team = Credentials.owner, author:member = Credentials.author,
			tag,
			encryption = Credentials.encryption,
			...rest} = {}) {
    // TODO: support simplified syntax, too, per README
    // TODO: should we specify subject: tag for both mutables? (gives hash)
    const options = (team && team !== member) ?
	  {team, member, tag, encryption, ...rest} :
	  {tags: [member], tag, time: Date.now(), encryption, ...rest}; // No iat if time not explicitly given.
    if ([true, 'team', 'owner'].includes(options.encryption)) options.encryption = team;
    return options;
  }
  fail(operation, data, author) {
    throw new Error(`${author} does not have the authority to ${operation} ${JSON.stringify(data)}.`);
  }
  // The type of JWE that gets signed (not the cty of the JWE). We automatically try to decrypt a JWS payload of this type.
  encryptedMimeType = 'text/encrypted';
  async store(data, options = {}) {
    const {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    if (encryption) {
      data = await Credentials.encrypt(data, encryption);
      signingOptions.contentType = this.encryptedMimeType;
    }
    // No need to await synchronization.
    // TODO: put on all services
    const signature = await Collection.sign(data, signingOptions);
    return (await this.put(tag, signature)) ||
      this.fail('store', data, signingOptions.member || signingOptions.tags[0]);
  }
  async remove(options = {}) { // Note: Really just replacing with empty data forever. Otherwise merging with earlier data will bring it back!
    const {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    // No need to await synchronization
    // TODO: delete on all services.
    return (await this.delete(tag, await Collection.sign('', signingOptions))) ||
      this.fail('remove', tag, signingOptions.member || signingOptions.tags[0]);;
  }
  async retrieve(tagOrOptions) { // getVerified and maybe decrypt. Has more complex behavior in subclass VersionedCollection.
    const {tag, decrypt = true} = tagOrOptions.tag ? tagOrOptions : {tag: tagOrOptions};
    const verified = await this.getVerified(tag);
    if (!verified) return verified;
    if (decrypt && (verified.protectedHeader.cty === this.encryptedMimeType)) {
      const decrypted = await Credentials.decrypt(verified.text);
      verified.json = decrypted.json;
      verified.text = decrypted.text;
      verified.payload = decrypted.payload;
      verified.decrypted = decrypted;
    }
    return verified;
  }
  async getVerified(tag) { // synchronize, get, and verify (but without decrypt)
    await this.synchronize1(tag);
    const signature = await this.get(tag);
    if (!signature) return signature;
    return Collection.verify(signature);
  }
  async list(skipSync = false ) { // List all tags of this collection.
    if (!skipSync) await this.synchronizeTags();
    // We cannot just list the keys of the collection, because that includes empty payloads of items that have been deleted.
    return Array.from(this.tags.keys());
  }
  async match(tag, properties) { // Is this signature what we are looking for?
    const verified = await this.retrieve(tag);
    const data = verified?.json;
    if (!data) return false;
    for (const key in properties) {
      if (data[key] !== properties[key]) return false;
    }
    return true;
  }
  async findLocal(properties) { // Find the tag in our store that matches, else falsey
    for (const tag of await this.list('no-sync')) { // Direct list, w/o sync.
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
  requireTag(tag) {
    if (tag) return;
    throw new Error('A tag is required.');
  }

  // These three ignore synchronization state, which if neeed is the responsibility of the caller.
  // FIXME TODO: after initial development, these three should be made internal so that application code does not call them.
  get(tag) { // Get the local raw signature data.
    this.requireTag(tag);
    return this.persist.get(tag);
  }
  // These two can be triggered by client code or by any service.
  async put(tag, signature) { // Put the raw signature locally and on the specified services.
    const validation = await this.validateForWriting(tag, signature, 'store');
    if (!validation) return undefined;
    await this.addTag(validation.tag);
    await this.persist.put(validation.tag, signature);
    return validation.tag; // Don't rely on the returned value of persist.put.
  }
  async delete(tag, signature) { // Remove the raw signature locally and on the specified services.
    const validation = await this.validateForWriting(tag, signature, 'remove', 'requireTag');
    if (!validation) return undefined;
    await this.deleteTag(tag);
    if (this.preserveDeletions) { // Signature payload is empty.
      await this.persist.put(validation.tag, signature); 
    } else { // Really delete.
      await this.persist.delete(validation.tag, signature);
    }
    return validation.tag; // Don't rely on the returne value of persist.delete.
  }

  notifyInvalid(tag, operationLabel, message = undefined) {
    console.warn(this.name, (/*this.debug &&*/ message) ||
		 `Signature is not valid to ${operationLabel} ${tag || 'data'}.`);
    return undefined;
  }
  disallowWrite(existing, proposed) { // Return a reason string why the proposed verified protectedHeader
    // should not be allowed to overrwrite the (possibly nullish) existing verified protectedHeader,
    // else falsy if allowed.
    if (!proposed) return 'invalid signature';
    if (!existing) return null;
    if (proposed.iat < existing.iat) return 'replay'
    const existingOwner = existing.iss || existing.kid;
    const proposedOwner = proposed.iss || proposed.kid;
    // Exact match. Do we need to allow for an owner to transfer ownership to a sub/super/disjoint team?
    // Currently, that would require a new record. (E.g., two Mutable/VersionedCollection items that
    // have the same GUID payload property, but different tags. I.e., a different owner means a different tag.)
    if (!proposedOwner || (proposedOwner !== existingOwner)) return 'not owner';
    /*
      We are not checking to see if author is currently a member of the owner team here, which
      is called by put()/delete() in two circumstances:

      this.validateForWriting() is called by put()/delete() which happens in the app (via store()/remove())
      and during sync from another service:

      1. From the app (vaia store()/remove(), where we have just created the signature. Signing itself
      will fail if the (1-hour cached) key is no longer a member of the team. There is no interface
      for the app to provide an old signature. (TODO: after we make get/put/delete internal.)

      2. During sync from another service, where we are pulling in old records for which we don't have
      team membership from that time.

      If the app cares whether the author has been kicked from the team, the app itself will have to check.
      TODO: we should provide a tool for that.
    */
    return null;
  }
  async validateForWriting(tag, signature, operationLabel, requireTag = false) {
    // A deep verify that checks against the existing item's (re-)verified headers.
    // If it succeeds, this is also the common code (between put/delete) that emits the update event.
    const verified = await Collection.verify(signature);
    if (!verified) return this.notifyInvalid(tag, operationLabel);
    tag = verified.tag = requireTag ? tag : this.tag(tag, verified);
    const existingVerified = await this.getVerified(tag);
    const disallowed = this.disallowWrite(existingVerified?.protectedHeader, verified?.protectedHeader, verified);
    if (disallowed) return this.notifyInvalid(tag, operationLabel, disallowed);
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
    for (let service of services) {
      // TODO: shut it down, and remove any effected tagmap data/
      this.services.splice(this.services.indexOf(service), 1);
    }
  }
}
// TODO: different rules for hash tag, synchronizeTags, synchronize1
// FIXME: store for immutable shouldn't "take":
//        - Maybe unify this with reconcilation rules?
//        - Unit tests will now be wrong for immutable.
//        - What about store/delete from peer on VersionedCollection?
export class ImmutableCollection extends Collection {
  tag(tag, validation) { // Ignores tag. Just the hash.
    return validation.protectedHeader.sub;
  }
  disallowWrite(existing, proposed, verified) { // Overrides super by allowing EARLIER rather than later.
    if (!proposed) return 'invalid signature';
    if (!existing) return null;
    const existingOwner = existing.iss || existing.kid;
    const proposedOwner = proposed.iss || proposed.kid;
    if (!proposedOwner || (proposedOwner !== existingOwner)) return 'not owner';
    if (!verified.payload.length) return null; // Later delete is ok.
    if (proposed.iat > existing.iat) return 'rewrite'; // Otherwise, later writes are not.
    return null;
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
    // Same collection name, but different type.
    const {name, persistenceClass, preserveDeletions} = this;
    this.versions = new ImmutableCollection({name, persistenceClass, preserveDeletions});
    this.versions.addEventListener('update', event => this.dispatchEvent(new CustomEvent('update', {detail: event.detail})));
  }
  async getVersions(tag) { // Answers parsed timestamp => version dictionary IF it exists, else falsy.
    this.requireTag(tag);
    const verified = await this.getVerified(tag);
    return verified?.json;
  }
  async retrieveTimestamps(tag) {
    const versions = await this.getVersions(tag);
    if (!versions) return versions;
    return Object.keys(versions).slice(1);
  }
  getActiveHash(timestamps, time = timestamps.latest) {
    if (!timestamps) return timestamps;
    let hash = timestamps[time];
    if (hash) return hash;
    // We need to find the timestamp that was in force at the requested time.
    let best = 0, times = Object.keys(timestamps);
    for (let i = 1; i < times.length; i++) { // 0th is the key 'latest'.
      if (times[i] <= time) best = times[i];
      else break;
    }
    return timestamps[best];
  }
  async retrieve(tagOrOptions) {
    const {tag, time} = (!tagOrOptions || tagOrOptions.length) ? {tag: tagOrOptions} : tagOrOptions;
    const timestamps = await this.getVersions(tag);
    if (!timestamps) return timestamps;
    const hash = this.getActiveHash(timestamps, time);
    if (!hash) return '';
    return this.versions.retrieve(hash);
  }
  async store(data, options = {}) {
    let {tag, ...signingOptions} = this._canonicalizeOptions(options);;
    const hash = await this.versions.store(data, signingOptions);
    tag ||= hash;
    const versions = await this.getVersions(tag) || {};
    const time = Date.now();
    versions.latest = time;
    versions[time] = hash;
    await this.persist.put(tag, await Collection.sign(versions, signingOptions));
    await this.addTag(tag);
    return tag;
  }
  async remove(options = {}) { // Note: Really just replacing with empty data forever. Otherwise merging with earlier data will bring it back!
    let {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options); // Ignore encryption
    const versions = await this.getVersions(tag);
    if (!versions) return versions;
    if (this.preserveDeletions) { // Create a timestamp => version with an empty payload.
      await this.store('', signingOptions);
    } else {
      const versionTags = Object.values(versions).slice(1);
      await Promise.all(versionTags.map(tag => this.versions.remove({tag, ...signingOptions})));
      await this.persist.delete(tag, await Collection.sign('', signingOptions));
    }
    await this.deleteTag(tag);
    return tag;
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
// These two are used directly by distributed-security.
Credentials.Storage.retrieve = async (collectionName, tag) => {
  const collection = Credentials.collections[collectionName];
  // No need to verify, as distributed-security does that itself quite carefully and team-aware.
  await collection.synchronize1(tag); // But do make sure local storage is up to date.
  const data = await collection.get(tag);
  // However, since we have bypassed Collection.retrieve, we maybeInflate here.
  return Collection.maybeInflate(data);
}
const EMPTY_STRING_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"; // Hash of an empty string.
Credentials.Storage.store = async (collectionName, tag, signature) => {
  // No need to validateForWriting, as distributed-security does that in a circularity-aware way.
  // However, we do currently need to find out of the signature has a payload.
  // TODO: Modify dist-sec to have a separate store/delete, rather than having to figure this out here.
  const claims = Credentials.decodeClaims(signature);
  const emptyPayload = claims?.sub === EMPTY_STRING_HASH;

  const collection = Credentials.collections[collectionName];
  signature = Collection.ensureString(signature);
  if (emptyPayload) return collection.delete(tag, signature);
  return collection.put(tag, signature);
};
Credentials.collections = {};
['EncryptionKey', 'KeyRecovery', 'Team'].forEach(name => Credentials.collections[name] = new MutableCollection({name}));

export default {Credentials, ImmutableCollection, MutableCollection, VersionedCollection};
Object.assign(globalThis, {Persist, Credentials, ImmutableCollection, MutableCollection, VersionedCollection}); // fixme remove
