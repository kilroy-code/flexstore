import Credentials from '@ki1r0y/distributed-security';
import Synchronizer from './synchronizer.mjs';
const { CustomEvent, EventTarget } = globalThis;

export class Collection extends EventTarget {
  // Persist is a Promise for class that implements get/list/put/delete.
  static Persist = import((typeof window === "undefined") ? './persist-fs.mjs' : './persist-indexeddb.mjs').then(module => module.default);
  constructor({name, services = [], preserveDeletions = !!services.length, persistenceClass = Collection.Persist, debug}) {
    super();
    Object.assign(this, {name, preserveDeletions, persistenceClass, debug});
    this.synchronize(...services);
    if (persistenceClass.then) this.persist = persistenceClass.then(kind => new kind({collection: this}));
    else this.persist = new persistenceClass({collection: this});
  }

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
  static async verify(signature, options = {}) {
    signature = this.maybeInflate(signature);
    // We don't do "deep" verification here - e.g., checking that the act is a member of iss, and the iat is after the existing iat.
    // Instead, we do our own deep checks in validateForWriting.
    // The member/notBefore should check out anywyay -- i.e., we could leave it in, except in synchronizing
    // Credential.collections. These will deep-verify locally, but there is no mechanism (currently) for the
    // synchronization to happen in an order that will result in the dependencies coming over before the items that consume them.
    const verified =  await Credentials.verify(signature, options);
    return verified;
  }

  async undeletedTags() { // Deleted keys are still present for sync'ing, so a db listing won't do.
    const allTags = await (await this.persist).list();
    const tags = new Set();
    await Promise.all(allTags.map(async tag => {
      const verified = await this.getVerified(tag, 'skipSync');
      if (verified) tags.add(tag);
    }));
    return tags;
  }
  get tags() { // Keeps track of our (undeleted) keys.
    return this._tagsPromise ||= this.undeletedTags();
  }
  async addTag(tag) {
    (await this.tags).add(tag);
  }
  async deleteTag(tag) {
    (await this.tags).delete(tag);
  }

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
    let {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    if (encryption) {
      data = await Credentials.encrypt(data, encryption);
      signingOptions.contentType = this.encryptedMimeType;
    }
    // No need to await synchronization.
    const signature = await Collection.sign(data, signingOptions);
    tag = await this.put(tag, signature);
    if (!tag) return this.fail('store', data, signingOptions.member || signingOptions.tags[0]);
    await this.push('put', tag, signature);
    return tag;
  }
  push(operation, tag, signature, excludeSynchronizer = null) { // Push to all connected synchronizers, excluding the specified one.
    return Promise.all(this.mapSynchronizers(synchronizer => (excludeSynchronizer !== synchronizer) && synchronizer.push(operation, tag, signature)));
  }
  async remove(options = {}) { // Note: Really just replacing with empty data forever. Otherwise merging with earlier data will bring it back!
    let {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    const data = '';
    // No need to await synchronization
    const signature = await Collection.sign(data, signingOptions);
    tag = await this.delete(tag, signature);
    if (!tag) return this.fail('store', data, signingOptions.member || signingOptions.tags[0]);
    await this.push('delete', tag, signature);
    return tag;
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
  async getVerified(tag, skipSync = false, options = {}) { // synchronize, get, and verify (but without decrypt)
    if (!skipSync) await this.synchronize1(tag);
    const signature = await this.get(tag);
    if (!signature) return signature;
    return Collection.verify(signature, options);
  }
  async list(skipSync = false ) { // List all tags of this collection.
    if (!skipSync) await this.synchronizeTags();
    // We cannot just list the keys of the collection, because that includes empty payloads of items that have been deleted.
    return Array.from((await this.tags).keys());
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
  async get(tag) { // Get the local raw signature data.
    this.requireTag(tag);
    return await (await this.persist).get(tag);
  }
  // These two can be triggered by client code or by any service.
  async put(tag, signature, synchronizer = null) { // Put the raw signature locally and on the specified services.
    // TODO: do we need to queue these? Suppose we are validating or merging while other request arrive?
    const validation = await this.validateForWriting(tag, signature, 'store', synchronizer);
    this.log('put', tag, synchronizer?.label, 'validated:', !!validation);
    if (!validation) return undefined;
    await this.addTag(validation.tag);
    const merged = await this.mergeSignatures(validation, signature);
    await (await this.persist).put(validation.tag, merged);
    return validation.tag; // Don't rely on the returned value of persist.put.
  }
  mergeSignatures(validation, signature) { // What shall be persisted? Usually just the signature.
    return signature;
  }
  async delete(tag, signature, synchronizer = null) { // Remove the raw signature locally and on the specified services.
    const validation = await this.validateForWriting(tag, signature, 'remove', synchronizer, 'requireTag');
    this.log('put', tag, synchronizer?.label, 'validated:', !!validation);
    if (!validation) return undefined;
    await this.deleteTag(tag);
    if (this.preserveDeletions) { // Signature payload is empty.
      await (await this.persist).put(validation.tag, signature);
    } else { // Really delete.
      await (await this.persist).delete(validation.tag, signature);
    }
    return validation.tag; // Don't rely on the returned value of persist.delete.
  }

  notifyInvalid(tag, operationLabel, message = undefined, validated = '', signature) {
    // Later on, we will not want to give out so much info...
    //if (this.debug) {
    console.warn(this.name, operationLabel, message, tag);
    //} else {
    //  console.warn(this.name, `Signature is not valid to ${operationLabel} ${tag || 'data'}.`);
    //}
    return undefined;
  }
  async disallowWrite(tag, existing, proposed, verified) { // Return a reason string why the proposed verified protectedHeader
    // should not be allowed to overrwrite the (possibly nullish) existing verified protectedHeader,
    // else falsy if allowed.
    if (!proposed) return 'invalid signature';
    if (!existing) return null;
    if (proposed.iat < existing.iat) return 'backdated';
    if (!this.ownerMatch(existing, proposed)) return 'not owner';
    if (!await this.subjectMatch(verified)) return 'wrong hash';
    return null;
  }
  async subjectMatch(verified) { // Promises true IFF claimed 'sub' matches hash of the contents.
    return verified.protectedHeader.sub === await Credentials.encodeBase64url(await Credentials.hashBuffer(verified.payload));
  }
  ownerMatch(existing, proposed) {// Does proposed owner match the existing?
    const existingOwner = existing?.iss || existing?.kid;
    const proposedOwner = proposed.iss || proposed.kid;
    // Exact match. Do we need to allow for an owner to transfer ownership to a sub/super/disjoint team?
    // Currently, that would require a new record. (E.g., two Mutable/VersionedCollection items that
    // have the same GUID payload property, but different tags. I.e., a different owner means a different tag.)
    if (!proposedOwner || (existingOwner && (proposedOwner !== existingOwner))) return false;

      // We are not checking to see if author is currently a member of the owner team here, which
      // is called by put()/delete() in two circumstances:

      // this.validateForWriting() is called by put()/delete() which happens in the app (via store()/remove())
      // and during sync from another service:

      // 1. From the app (vaia store()/remove(), where we have just created the signature. Signing itself
      // will fail if the (1-hour cached) key is no longer a member of the team. There is no interface
      // for the app to provide an old signature. (TODO: after we make get/put/delete internal.)

      // 2. During sync from another service, where we are pulling in old records for which we don't have
      // team membership from that time.

      // If the app cares whether the author has been kicked from the team, the app itself will have to check.
      // TODO: we should provide a tool for that.

    return true;
  }
  antecedent(verified) { // What tag should the verified signature be compared against for writing?
    return verified.tag;
  }
  async validateForWriting(tag, signature, operationLabel, synchronizer, requireTag = false) {
    // A deep verify that checks against the existing item's (re-)verified headers.
    // If it succeeds, this is also the common code (between put/delete) that emits the update event.
    const validationOptions = synchronizer ? {member: null} : {}; // Could be old data written by someone who is no longer a member.
    const verified = await Collection.verify(signature, validationOptions);
    if (!verified) return this.notifyInvalid(tag, operationLabel, 'invalid', verified, signature);
    verified.synchronizer = synchronizer;
    verified.signature = signature;
    tag = verified.tag = requireTag ? tag : await this.tagForWriting(tag, verified);
    const antecedent = this.antecedent(verified);
    const existingVerified = verified.existing = antecedent && await this.getVerified(antecedent, 'skipSync');
    const disallowed = await this.disallowWrite(tag, existingVerified?.protectedHeader, verified?.protectedHeader, verified);
    if (disallowed) return this.notifyInvalid(tag, operationLabel, disallowed, verified);
    this.emit(verified);
    return verified;
  }
  emit(verified) { // Dispatch the update event. Subclasses may override.
    this.dispatchEvent(new CustomEvent('update', {detail: verified}));
  }

  synchronizers = new Map(); // serviceInfo might not be a string.
  mapSynchronizers(f) { // On Safari, Map.values().map is not a function!
    const results = [];
    for (const synchronizer of this.synchronizers.values()) {
      results.push(f(synchronizer));
    }
    return results;
  }
  get services() {
    return Array.from(this.synchronizers.keys());
  }
  // TODO: rename this to connect, and define synchronize to await connect, synchronizationComplete, disconnnect.
  async synchronize(...services) { // Start running the specified services (in addition to whatever is already running).
    const {synchronizers} = this;
    for (let service of services) {
      if (synchronizers.has(service)) continue;
      const synchronizer = await Synchronizer.create(this, service, {debug: this.debug});
      synchronizers.set(service, synchronizer);
    }
  }
  get synchronized() { // promise to resolve when synchronization is complete in BOTH directions.
    return Promise.all(this.mapSynchronizers(s => s.bothSidesCompletedSynchronization));
  }
  async disconnect(...services) { // Shut down the specified services.
    if (!services.length) services = this.services;
    const {synchronizers} = this;
    for (let service of services) {
      const synchronizer = synchronizers.get(service);
      if (!synchronizer) {
	console.warn(`${this.name} does not have a service named '${service} to disconnect.`);
	continue;
      }
      await synchronizer.disconnect();
      synchronizers.delete(service);
    }
  }
  promise(key, thunk) { return thunk; } // TODO: how will we keep track of overlapping distinct syncs?
  synchronize1(tag) { // Compare against any remaining unsynchronized data, fetch what's needed, and resolve locally.
    return Promise.all(this.mapSynchronizers(synchronizer => synchronizer.synchronizationPromise(tag)));
  }
  async synchronizeTags() { // Ensure that we have up to date tag map among all services. (We don't care yet of the values are synchronized.)
    return this.promise('tags', () => Promise.resolve()); // TODO
  }
  async synchronizeData() { // Make the data to match our tagmap, using synchronize1.
    return this.promise('data', () => Promise.resolve()); // TODO
  }
  set onupdate(handler) { // Allow setting in lieu of addEventListener.
    if (handler) {
      this._update = handler;
      this.addEventListener('update', handler);
    } else {
      this.removeEventListener('update', this._update);
      this._update = handler;
    }
  }
  get onupdate() { // As set by this.onupdate = handler. Does NOT answer that which is set by addEventListener.
    return this._update;
  }
}

export class ImmutableCollection extends Collection {
  tagForWriting(tag, validation) { // Ignores tag. Just the hash.
    return validation.protectedHeader.sub;
  }
  async disallowWrite(tag, existing, proposed, verified) { // Overrides super by allowing EARLIER rather than later.
    if (!proposed) return 'invalid signature';
    if (!existing) {
      if (verified.length && (tag !== proposed.sub)) return 'wrong tag';
      if (!await this.subjectMatch(verified)) return 'wrong hash';
      return null; // First write ok.
    }
    // No owner match. Not relevant for immutables.
    if (!verified.payload.length && (proposed.iat > existing.iat)) return null; // Later delete is ok.
    if (proposed.iat > existing.iat) return 'rewrite'; // Otherwise, later writes are not.
    if (proposed.sub !== existing.sub) return 'altered contents';
    return null;
  }
}
export class MutableCollection extends Collection {
  tagForWriting(tag, validation) { // Use tag if specified, but defaults to hash.
    return tag || validation.protectedHeader.sub;
  }
}

// Each VersionedCollection has an internal Collection of items that form the individual versions.
// Each item has an antecedent that is not part of the application-supplied payload -- it lives in the signature's header.
// However:
// - The tag DOES include the antecedent, even though it is not part of the payload. This makes identical payloads have
//   unique tags (because they will always have different antecedents).
// - The ability to write follows the same rules as MutableCollection (latest wins), but is tested against the
//   antecedent tag instead of the tag being written.
export class VersionCollection extends MutableCollection { // Needs to be exported so that that router.mjs can find it.
  async tagForWriting(tag, validation) { // Use tag if specified (e.g., put/delete during synchronization), othwerwise reflect both sub and antecedent.
    // Each version gets a unique tag (even if there are two versions that have the same data payload).
    const use = tag || Credentials.encodeBase64url(await Credentials.hashText(validation.protectedHeader.sub + validation.protectedHeader.antecedent));
    return use;
  }
  antecedent(validation) { // Returns the tag that validation compares against. E.g., do the owners match?
    // For non-versioned collections, we compare against the existing data at the same tag being written.
    // For versioned collections, it is what exists as the latest version when the data is signed, and which the signature
    // records in the signature. (For the very first version, the signature will note the timestamp as the antececdent tag,
    // (see tagForWriting), but for comparing against, this method answers falsy for the first in the chain.
    const header = validation?.protectedHeader;
    if (!header) return '';
    const antecedent = header.antecedent;
    if (typeof(antecedent) === 'number') return ''; // A timestamp as antecedent is used to to start things off. No true antecedent.
    return antecedent;
  }
  async subjectMatch(verified) { // Here sub refers to the overall item tag that encompasses all versions, not the payload hash.
    return true; // TODO: make sure it matches previous?
  }
}

export class VersionedCollection extends MutableCollection {
  // TODO: This works and demonstrates having a collection using other collections.
  // However, having a big timestamp => fixnum map is bad for performance as the history gets longer.
  // This should be split up into what is described in versioned.md.
  constructor({services = [], ...rest} = {}) {
    super(rest);  // Without passing services yet, as we don't have the versions collection set up yet.
    this.versions = new VersionCollection(rest); // Same collection name, but different type.
    this.versions.addEventListener('update', event => this.dispatchEvent(new CustomEvent('update', {detail: this.recoverTag(event.detail)})));
    this.synchronize(...services); // Now we can synchronize.
  }
  recoverTag(verified) { // the verified.tag is for the version. We want the overall one.
    return Object.assign({}, verified, {tag: verified.protectedHeader.sub}); // Do not bash verified!
  }
  emit(verified) { // No op. (No event for changes to the history. Instead, the individual version updates are forwarded. (See constructor.)
  }
  serviceForVersion(service) { // Get the service "name" for our versions collection.
    if (typeof(service) === 'string') return service; // Normally.
    return service.versions; // For the weird connectDirectTesting case used in unit tests
  }
  servicesForVersion(services) {
    return services.map(service => this.serviceForVersion(service));
  }
  async synchronize(...services) { // synchronize the versions collection, too.
    if (!services.length) return;
    await this.versions.synchronize(...this.servicesForVersion(services));
    await super.synchronize(...services);
  }
  async disconnect(...services) { // disconnect the versions collection, too.
    if (!services.length) services = this.services;
    await this.versions.disconnect(...this.servicesForVersion(services));
    await super.disconnect(...services);
  }

  async getVersions(tag) { // Promises the parsed timestamp => version dictionary IF it exists, else falsy.
    this.requireTag(tag);
    const verified = await this.getVerified(tag);
    return verified?.json;
  }
  async retrieveTimestamps(tag) { // Promises a list of all version timestamps.
    const versions = await this.getVersions(tag);
    if (!versions) return versions;
    return Object.keys(versions).slice(1); // TODO? Map these to integers?
  }
  getActiveHash(timestamps, time = timestamps.latest) { // Promises the version tag that was in force at the specified time
    // (which may before, in between, or after the recorded discrete timestamps).
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
  async retrieve(tagOrOptions) { // Answer the validated version in force at the specified time (or latest).
    const {tag, time} = (!tagOrOptions || tagOrOptions.length) ? {tag: tagOrOptions} : tagOrOptions;
    const timestamps = await this.getVersions(tag);
    if (!timestamps) return timestamps;
    const hash = this.getActiveHash(timestamps, time);
    if (!hash) return '';
    return this.versions.retrieve(hash);
  }
  async store(data, options = {}) { // Determine the antecedent, record it in the signature, and store that
    // as the appropriate version hash. Then record the new timestamp/hash in the timestamps list.
    let versions,
	{tag, encryption, ...signingOptions} = this._canonicalizeOptions(options),
	time = Date.now(),
	versionOptions = Object.assign({time, encryption}, signingOptions);
    if (tag) {
      versions = await this.getVersions(tag) || {};
      versionOptions.sub = tag;
      if (versions) {
	versionOptions.antecedent = versions[versions.latest];
      }
    } // Else do not assign sub. It will be set to the payload hash during signing, and also used for the overall tag.
    versionOptions.antecedent ||= time;
    const hash = await this.versions.store(data, versionOptions);
    if (!tag) { // We'll still need tag and versions.
      const versionSignature = await this.versions.get(hash);
      const claims = Credentials.decodeClaims(Collection.maybeInflate(versionSignature));
      tag = claims.sub;
      versions = {};
    }
    versions.latest = time;
    versions[time] = hash;
    const signature = await Collection.sign(versions, signingOptions);
    await (await this.persist).put(tag, signature);
    await this.push('put', tag, signature);
    await this.addTag(tag);
    return tag;
  }
  async remove(options = {}) { // Add an empty verion or remove all versions, depending on this.preserveDeletions.
    let {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options); // Ignore encryption
    const versions = await this.getVersions(tag);
    if (!versions) return versions;
    if (this.preserveDeletions) { // Create a timestamp => version with an empty payload. Otherwise merging with earlier data will bring it back!
      await this.store('', signingOptions);
    } else { // Actually delete the timestamps and each version.
      const versionTags = Object.values(versions).slice(1);
      const versionSignature = await Collection.sign('', {sub: tag, ...signingOptions});
      // TODO: Is this safe? Should we make a signature that specifies each antecedent?
      await Promise.all(versionTags.map(async tag => {
	await this.versions.delete(tag, versionSignature);
	await this.versions.push('delete', tag, versionSignature);
      }));
      const signature = await Collection.sign('', signingOptions);
      await (await this.persist).delete(tag, signature);
      await this.push('delete', tag, signature);
    }
    await this.deleteTag(tag);
    return tag;
  }
  async mergeSignatures(validation, signature) { // Merge the new timestamps with the old.
    const previousTimestamps = validation.existing?.json;
    if (!previousTimestamps) return signature;
    const nextTimestamps = validation.json;
    const nextCopy = Object.assign({}, nextTimestamps);
    let changed = false;
    for (let key in previousTimestamps) {
      if (key in nextTimestamps) continue;
      changed = true;
      nextTimestamps[key] = previousTimestamps[key];
    }
    if (!changed) return signature;
    const keys = Object.keys(nextTimestamps).filter(key => key !== 'latest');
    const revised = {latest: Math.max(nextTimestamps.latest, previousTimestamps.latest)};
    keys.sort();
    keys.forEach(key => revised[key] = nextTimestamps[key]);
    // TODO: If current user is not a member of validation.protectedHeader team, create two bodies.
    const options = {tags: [Credentials.author]};
    const sig = await Collection.sign(revised, options);
    const shown = Credentials.decodeClaims(Collection.maybeInflate(sig));
    return sig;
  }
  async disallowWrite(tag, existing, proposed, verified) { // backdating is allowed. (merging).
    if (!proposed) return 'invalid signature';
    if (!existing) return null;
    if (!this.ownerMatch(existing, proposed)) return 'not owner';
    if (!await this.subjectMatch(verified)) return 'wrong hash';
    return null;
  }
  ownerMatch(existing, proposed) { // TODO: Either they must match (as in super) or the new payload must include the previous.
    return true;
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
Credentials.encryption = null; // TODO: rename this to audience
Credentials.synchronize = async (...services) => { // TODO: rename this to connect, and definee disconnect, too.
  // Needs to resolve dependencies in order to validateForWriting.
  // Returns a promise that resolves when the Team collection is in.
  console.log(await Credentials.ready);
  await Credentials.collections.KeyRecovery.synchronize(...services);
  await Credentials.collections.KeyRecovery.synchronized;
  await Credentials.collections.Team.synchronize(...services);
  await Credentials.collections.Team.synchronized;
  Credentials.collections.EncryptionKey.synchronize(...services); // No need to wait for it
};
Credentials.synchronized = async () => {
  return Promise.all(Object.values(Credentials.collections).map(collection => collection.synchronized));
}
Credentials.disconnect = async (...services) => {
  return Promise.all(Object.values(Credentials.collections).map(collection => collection.disconnect(...services)));
}

Credentials.createAuthor = async (prompt) => { // Create a user:
  // If prompt is '-', creates an invitation account, with a no-op recovery and no device.
  // Otherwise, prompt indicates the recovery prompts, and the account has that and a device.
  if (prompt === '-') return Credentials.create(await Credentials.create({prompt}));
  const [local, recovery] = await Promise.all([Credentials.create(), Credentials.create({prompt})]);
  return Credentials.create(local, recovery);
};
Credentials.claimInvitation = async (tag, newPrompt) => { // Creates a local device tag and adds it to the given invitation tag,
  // using the self-validating recovery member that is then removed and destroyed.
  const verified = await Credentials.collections.Team.retrieve({tag});
  const members = verified.json.recipients;
  if (members.length !== 1) throw new Error(`Invitations should have one member: ${tag}/`);
  const oldRecoveryTag = members[0].header.kid;
  const newRecoveryTag = await Credentials.create({prompt: newPrompt});
  const deviceTag = await Credentials.create();
  await Credentials.changeMembership({tag, add: [deviceTag, newRecoveryTag], remove: [oldRecoveryTag]});
  await Credentials.destroy(oldRecoveryTag);
  return tag;
};
const answers = {};
Credentials.setAnswer = (prompt, answer) => answers[prompt] = answer;
Credentials.getUserDeviceSecret = (tag, promptString) => {
  if (!promptString) return tag;
  if (promptString === '-') return promptString; // See createAuthor.
  if (answers[promptString]) return answers[promptString];
  // Distributed Security will try everything. Unless going through a path above, we would like others to silently fail.
  console.log(`Attemptiong access ${tag} with prompt '${promptString}'.`);
  return "not a secret"; 
};


// These two are used directly by distributed-security.
Credentials.Storage.retrieve = async (collectionName, tag) => {
  const collection = Credentials.collections[collectionName];
  // No need to verify, as distributed-security does that itself quite carefully and team-aware.
  // Team and KeyRecovery are serialized such that they are already synchronized (see Credentials.synchronize),
  // but EncryptionKey is not.
  if (collectionName === 'EncryptionKey') await collection.synchronize1(tag);
  const data = await collection.get(tag);
  // However, since we have bypassed Collection.retrieve, we maybeInflate here.
  return Collection.maybeInflate(data);
}
const EMPTY_STRING_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"; // Hash of an empty string.
Credentials.Storage.store = async (collectionName, tag, signature) => {
  // No need to encrypt/sign as by store, since distributed-security does that in a circularity-aware way.
  // However, we do currently need to find out of the signature has a payload and push
  // TODO: Modify dist-sec to have a separate store/delete, rather than having to figure this out here.
  const claims = Credentials.decodeClaims(signature);
  const emptyPayload = claims?.sub === EMPTY_STRING_HASH;

  const collection = Credentials.collections[collectionName];
  signature = Collection.ensureString(signature);
  const stored = await (emptyPayload ? collection.delete(tag, signature) : collection.put(tag, signature));
  if (stored !== tag) throw new Error(`Unable to write credential ${tag}.`);
  if (tag) await collection.push(emptyPayload ? 'delete': 'put', tag, signature);
  return tag;
};
Credentials.collections = {};
export { Credentials };
['EncryptionKey', 'KeyRecovery', 'Team'].forEach(name => Credentials.collections[name] = new MutableCollection({name}));
