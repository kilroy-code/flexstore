import Credentials from '@ki1r0y/distributed-security';
import { StorageLocal } from '@ki1r0y/storage';
import Synchronizer from './synchronizer.mjs';
import { storageName, storageVersion } from './version.mjs';
const { CustomEvent, EventTarget, TextDecoder } = globalThis;

// TODO?: Should verfied/validated be its own object with methods?

export class Collection extends EventTarget {

  constructor({name, label = name, services = [], preserveDeletions = !!services.length,
	       persistenceClass = StorageLocal, dbVersion = storageVersion, persistenceBase = `${storageName}_${dbVersion}`,
	       debug = false, multiplex, // Causes synchronization to reuse connections for different Collections on the same service.
	       channelName, serviceLabel, restrictedTags}) {
    super();
    Object.assign(this, {name, label, preserveDeletions, persistenceClass, dbVersion, multiplex, debug, channelName, serviceLabel,
			 fullName: `${this.constructor.name}/${name}`, fullLabel: `${this.constructor.name}/${label}`});
    if (restrictedTags) this.restrictedTags = restrictedTags;
    this.synchronize(...services);
    const persistenceOptions = {name: this.fullLabel, baseName: persistenceBase, debug: debug};
    if (persistenceClass.then) this.persistenceStore = persistenceClass.then(kind => new kind(persistenceOptions));
    else this.persistenceStore = new persistenceClass(persistenceOptions);
  }

  async close() {
    await (await this.persistenceStore).close();
  }
  async destroy() {
    await this.disconnect();
    const store = await this.persistenceStore;
    delete this.persistenceStore;
    if (store) await store.destroy();
  }

  static error(error) { // Can be overridden by the client
    console.error(error);
  }
  // Credentials.sign/.verify can produce/accept JSON OBJECTS for the named "JSON Serialization" form.
  // As it happens, distributed-security can distinguish between a compact serialization (base64 text)
  // vs an object, but it does not recognize a SERIALIZED object. Here we bottleneck those operations
  // such that the thing that is actually persisted and synchronized is always a string -- either base64
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
  // The type of JWE that gets signed (not the cty of the JWE). We automatically try to decrypt a JWS payload of this type.
  static encryptedMimeType = 'text/encrypted';
  static async ensureDecrypted(verified) { // Promise verfied after first augmenting with decrypted data as needed.
    if (verified.protectedHeader.cty !== this.encryptedMimeType) return verified;
    if (verified.decrypted) return verified; // Already decrypted.
    const decrypted = await Credentials.decrypt(verified.text);
    verified.json = decrypted.json;
    verified.text = decrypted.text;
    verified.payload = decrypted.payload;
    verified.decrypted = decrypted;
    return verified;
  }

  // TODO?: These take Security-style team/member, while everything else here takes owner/author.
  async sign(data, options) {
    // If this collection restricts usable tags for testing, then do so.
    if ('restrictedTags' in this) {
      let oldHook = Credentials.getUserDeviceSecret;
      try {
	Credentials.getUserDeviceSecret = (tag, promptString) => {
	  if (!this.restrictedTags.has(tag)) return 'bogus';
	  return oldHook(tag, promptString);
	};
	await Credentials.clear();
	return await this.constructor.sign(data, options);
      } finally {
	Credentials.getUserDeviceSecret = oldHook;
      }
    }
    return this.constructor.sign(data, options);
  }
  static async sign(data, options) {
    const signature = await Credentials.sign(data, options);
    return this.ensureString(signature);
  }
  static async verify(signature, options = {}) {
    signature = this.maybeInflate(signature);
    // We don't do "deep" verification here - e.g., checking that the act is a member of iss, and the iat is after the existing iat.
    // Instead, we do our own deep checks in validateForWriting.
    // The member/notBefore should check out anyway -- i.e., we could leave it in, except in synchronizing
    // Credential.collections. There is no mechanism (currently) for the
    // synchronization to happen in an order that will result in the dependencies coming over before the items that consume them.
    const verified =  await Credentials.verify(signature, options);
    if (verified) verified.signature = signature;
    return verified;
  }
  // static async validationFormat(signature, tag = null) {
  //   //console.log({type: typeof(signature), signature, tag});
  //   const verified = await this.verify(signature);
  //   if (!verified.tag) console.error("\n\n\n*** missing tag ***\n\n");
  //   // Obsolete?
  //   // const sub = verified.subjectTag = verified.protectedHeader.sub;
  //   // verified.tag = tag || sub;
  //   return verified;
  // }

  async undeletedTags() {
    // Our own separate, on-demand accounting of persistenceStore list():
    //   - persistenceStore list() could potentially be expensive
    //   - It will contain soft-deleted item tombstones (signed empty payloads).
    // It starts with a list() to get anything persisted in a previous session, and adds/removes as we store/remove.
    const allTags = await (await this.persistenceStore).list();
    const tags = new Set();
    await Promise.all(allTags.map(async tag => {
      const verified = await this.getVerified({tag, synchronize: false});
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
    console.log(this.fullLabel, ...rest);
  }
  _canonicalizeOptions1(tagOrOptions = {}) {
    return (typeof(tagOrOptions) === 'string') ? {tag:tagOrOptions} : tagOrOptions;
  }
  _canonicalizeOptions(objectOrString = {}) {
    const {owner:team = Credentials.owner, author:member = Credentials.author,
	   tag,
	   encryption = Credentials.encryption,
	   time = Date.now(),
	   ...rest} = this._canonicalizeOptions1(objectOrString);
    // TODO: support simplified syntax, too, per README
    // TODO: should we specify subject: tag for both mutables? (gives hash)
    const options = (team && team !== member) ?
	  {team, member, tag, encryption, time, ...rest} :
	  {tags: [member], tag, time, encryption, ...rest}; // No iat if time not explicitly given.
    if ([true, 'team', 'owner'].includes(options.encryption)) options.encryption = team;
    return options;
  }
  fail(operation, data, author) {
    throw new Error(`${author} does not have the authority to ${operation} ${this.fullName} ${JSON.stringify(data)}.`);
  }
  async store(data, options = {}) {
    // encrypt if needed
    // sign
    // put <== Also where we enter if pushed from a connection
    //    validateForWriting
    //       exit if improper
    //       emit update event
    //    mergeSignatures
    //    persist locally
    // push (live to any connections except the one we received from)
    let {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options);
    if (encryption) {
      data = await Credentials.encrypt(data, encryption);
      signingOptions.contentType = this.constructor.encryptedMimeType;
    }
    // No need to await synchronization.
    const signature = await this.sign(data, signingOptions);
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
    const signature = await this.sign(data, {subject: tag, ...signingOptions});
    tag = await this.delete(tag, signature);
    if (!tag) return this.fail('remove', data, signingOptions.member || signingOptions.tags[0]);
    await this.push('delete', tag, signature);
    return tag;
  }
  async retrieve(tagOrOptions) { // getVerified and maybe decrypt. Has more complex behavior in subclass VersionedCollection.
    const {tag, decrypt = true, ...options} = this._canonicalizeOptions1(tagOrOptions);
    const verified = await this.getVerified({tag, ...options});
    if (!verified) return '';
    if (decrypt) return await this.constructor.ensureDecrypted(verified);
    return verified;
  }
  async getVerified(tagOrOptions) { // synchronize, get, and verify (but without decrypt)
    const {tag, synchronize = true, ...verifyOptions} = this._canonicalizeOptions1(tagOrOptions);
    if (synchronize) await this.synchronize1(tag);
    const signature = await this.get(tag);
    if (!signature) return signature;
    const verified = await this.constructor.verify(signature, verifyOptions);
    verified.tag = tag; // Carry with it the tag by which it was found.
    return verified;
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
    return await (await this.persistenceStore).get(tag);
  }
  // These two can be triggered by client code or by any service.
  async put(tag, signature, synchronizer = null) { // Put the raw signature locally and on the specified services.
    // 1. validateForWriting
    // 2. mergeSignatures against any existing, picking some combination of existing and next.
    // 3. persist the result
    // 4. return tag

    // TODO: do we need to queue these? Suppose we are validating or merging while other request arrive?
    const validation = await this.validateForWriting(tag, signature, 'store', synchronizer);
    this.log('put', {tag: validation?.tag || tag, synchronizer: synchronizer?.label, text: validation?.text});

    if (!validation) return undefined;
    if (!validation.signature) return validation.tag; // No further action but answer tag. E.g., when ignoring new data.
    await this.addTag(validation.tag);

    // fixme next
    const merged = await this.mergeSignatures(tag, validation, signature);
    await this.persist(validation.tag, merged);
    //const merged2 = await this.constructor.validationFormat(merged, tag);
    //await this.persist(validation.tag, merged);
    //await this.persist2(merged2);
    // const merged = await this.mergeValidation(validation, mergeAuthorOverride);
    // await this.persist2(merged);

    return validation.tag; // Don't rely on the returned value of persistenceStore.put.
  }
  async delete(tag, signature, synchronizer = null) { // Remove the raw signature locally and on the specified services.
    const validation = await this.validateForWriting(tag, signature, 'remove', synchronizer, 'requireTag');
    this.log('delete', tag, synchronizer?.label, 'validated tag:', validation?.tag, 'preserveDeletions:', this.preserveDeletions);
    if (!validation) return undefined;
    await this.deleteTag(tag);
    if (this.preserveDeletions) { // Signature payload is empty.
      // FIXME next
      //await this.persist(validation.tag, signature);
      await this.persist2(validation);
    } else { // Really delete.
      // fixme next
      //await this.persist(validation.tag, signature, 'delete');
      await this.persist2(validation, 'delete');
    }
    return validation.tag; // Don't rely on the returned value of persistenceStore.delete.
  }

  notifyInvalid(tag, operationLabel, message = undefined, validated = '', signature) {
    // Later on, we will not want to give out so much info...
    //if (this.debug) {
    console.warn(this.fullLabel, operationLabel, message, tag);
    //} else {
    //  console.warn(this.fullLabel, `Signature is not valid to ${operationLabel} ${tag || 'data'}.`);
    //}
    return undefined;
  }
  async disallowWrite(tag, existing, proposed, verified) { // Promise a reason string to disallow, or null if write is allowed.
    // The empty string means that we should not actually write anything, but the operation should quietly answer the given tag.

    if (!verified.text.length) return this.disallowDelete(tag, existing, proposed, verified);

    if (!proposed) return 'invalid signature';
    const tagged = await this.checkTag(verified); // Checked regardless of whether this an antecedent.
    if (tagged) return tagged; // Hard fail answers, regardless of existing.
    if (!existing) return tagged; // Returning '' or null.

    let owner, date;
    // Return any hard fail first, then any empty string, or finally null
    return (owner = await this.checkOwner(existing, proposed, verified)) ||
      (date = await this.checkDate(existing, proposed)) ||
      (owner ?? date ?? tagged);
  }
  async disallowDelete(tag, existing, proposed, verified) { // Deletion typically latches.
    if (!proposed) return 'invalid signature';

    // If we ever change this next, be sure that one cannot speculatively camp out on a tag and prevent people from writing!
    if (!existing) return '';
    // Deleting trumps data, regardless of timestamp.
    return this.checkOwner(existing, proposed, verified);
  }
  hashablePayload(validation) { // Return a string that can be hashed to match the sub header
    // (which is normally generated inside the distributed-security vault).
    return validation.text || new TextDecoder().decode(validation.payload);
  }
  async hash(validation) { // Promise the hash of hashablePayload.
    return Credentials.encodeBase64url(await Credentials.hashText(this.hashablePayload(validation)));
  }
  fairOrderedAuthor(existing, proposed) { // Used to break ties in even timestamps.
    const {sub, act} = existing;
    const {act:act2} = proposed;
    if (sub?.length && sub.charCodeAt(sub.length - 1) % 2) return act < act2;
    return act > act2; // If act === act2, then the timestamps should be the same.
  }
  getOwner(protectedHeader) { // Return the tag of what shall be considered the owner.
    const {iss, kid} = protectedHeader;
    return iss || kid;
  }
  // These predicates can return a boolean for hard yes or no, or null to indicate that the operation should silently re-use the tag.
  checkSomething(reason, boolean, label) {
    if (boolean) this.log('wrong', label, reason); //fixme
    return boolean ? reason : null;
  }
  checkOwner(existing, proposed, verified) {// Does proposed owner match the existing?
    return this.checkSomething('not owner', this.getOwner(existing, verified.existing) !== this.getOwner(proposed, verified), 'owner');
  }

  antecedent(verified) { // What tag should the verified signature be compared against for writing, if any.
    return verified.tag;
  }
  synchronizeAntecedent(tag, antecedent) { // Should the antecedent try synchronizing before getting it?
    return tag !== antecedent; // False when they are the same tag, as that would be circular. Versions do sync.
  }
  tagForWriting(specifiedTag, validation) { // Given the specified tag and the basic verification so far, answer the tag that should be used for writing.
    return specifiedTag || this.hash(validation);
  }
  async validateForWriting(tag, signature, operationLabel, synchronizer, requireTag = false) { // TODO: Optionals should be keyword.
    // A deep verify that checks against the existing item's (re-)verified headers.
    // If it succeeds, promise a validation.
    // It can also answer a super-abbrevaited valition of just {tag}, which indicates that nothing should be persisted/emitted, but tag returned.
    // This is also the common code (between put/delete) that emits the update event.
    //
    // How, if a all, do we check that act is a member of iss?
    // Consider an item owned by iss.
    // The item is stored and synchronized by act A at time t1.
    // However, at an earlier time t0, act B was cut off from the relay and stored the item.
    // When merging, we want act B's t0 to be the earlier record, regardless of whether B is still a member at time of synchronization.
    // Unless/until we have versioned keysets, we cannot enforce a membership check -- unless the application itself wants to do so.
    // A consequence, though, is that a human who is a member of iss can get away with storing the data as some
    // other unrelated persona. This may make it hard for the group to hold that human responsible.
    // Of course, that's also true if we verified members at all times, and had bad content legitimately created by someone who got kicked later.

    const validationOptions = {member: null}; // Could be old data written by someone who is no longer a member. See ownerMatch.
    const verified = await this.constructor.verify(signature, validationOptions);
    if (!verified) return this.notifyInvalid(tag, operationLabel, 'invalid', verified, signature);
    verified.synchronizer = synchronizer;
    // Set the actual tag to use before we do the disallow checks.
    tag = verified.tag = requireTag ? tag : await this.tagForWriting(tag, verified);
    const antecedent = this.antecedent(verified);
    const synchronize = this.synchronizeAntecedent(tag, antecedent);
    const existingVerified = verified.existing = antecedent && await this.getVerified({tag: antecedent, synchronize, ...validationOptions});
    const disallowed = await this.disallowWrite(tag, existingVerified?.protectedHeader, verified?.protectedHeader, verified);
    this.log('validateForWriting', {tag, operationLabel, requireTag, fromSynchronizer:!!synchronizer, signature, verified, antecedent, synchronize, existingVerified, disallowed});
    if (disallowed === '') return {tag}; // Allow operation to silently answer tag, without persisting or emitting anything.
    if (disallowed) return this.notifyInvalid(tag, operationLabel, disallowed, verified);
    this.emit(verified);
    return verified;
  }
  // fixme next 2
  mergeSignatures(tag, validation, signature) { // Return a string to be persisted. Usually just the signature.
    return signature;  // validation.string might be an object.
  }
  async persist(tag, signatureString, operation = 'put') { // Conduct the specified tag/signature operation on the persistent store.
    return (await this.persistenceStore)[operation](tag, signatureString);
  }
  mergeValidation(validation) { // Return a string to be persisted. Usually just the signature.
    return validation;
  }
  async persist2(validation, operation = 'put') { // Conduct the specified tag/signature operation on the persistent store. Return tag
    const {tag, signature} = validation;
    const signatureString = this.constructor.ensureString(signature);
    const storage = await this.persistenceStore;
    this.log('persist2', {tag, storage, operation, signatureString});
    await storage[operation](tag, signatureString);
    return tag;
  }
  emit(verified) { // Dispatch the update event.
    this.dispatchEvent(new CustomEvent('update', {detail: verified}));
  }
  get itemEmitter() { // Answers the Collection that emits individual updates. (See override in VersionedCollection.)
    return this;
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
      await Synchronizer.create(this, service); // Reaches into our synchronizers map and sets itself immediately.
    }
  }
  get synchronized() { // promise to resolve when synchronization is complete in BOTH directions.
    // TODO? This does not reflect changes as Synchronizers are added or removed since called. Should it?
    return Promise.all(this.mapSynchronizers(s => s.bothSidesCompletedSynchronization));
  }
  async disconnect(...services) { // Shut down the specified services.
    if (!services.length) services = this.services;
    const {synchronizers} = this;
    for (let service of services) {
      const synchronizer = synchronizers.get(service);
      if (!synchronizer) {
	//console.warn(`${this.fullLabel} does not have a service named '${service}' to disconnect.`);
	continue;
      }
      await synchronizer.disconnect();
    }
  }
  async ensureSynchronizer(serviceName, connection, dataChannel) { // Make sure dataChannel matches the synchronizer, creating Synchronizer only if missing.
    let synchronizer = this.synchronizers.get(serviceName);
    if (!synchronizer) {
      synchronizer = new Synchronizer({serviceName, collection: this, debug: this.debug});
      synchronizer.connection = connection;
      synchronizer.dataChannelPromise = Promise.resolve(dataChannel);
      this.synchronizers.set(serviceName, synchronizer);
      // Does NOT start synchronizing. Caller must do that if desired. (Router doesn't need to.)
    } else if ((synchronizer.connection !== connection) ||
	       (synchronizer.channelName !== dataChannel.label) ||
	       (await synchronizer.dataChannelPromise !== dataChannel)) {
      throw new Error(`Unmatched connection for ${serviceName}.`);
    }
    return synchronizer;
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
      this.removeEventListener('update', this._update);
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

export class MutableCollection extends Collection {
  async checkTag(verified) { // Mutable tag could be anything.
    return null;
  }
  checkDate(existing, proposed) { // fail if backdated.
    return this.checkSomething('backdated', !proposed.iat ||
			       ((proposed.iat === existing.iat) ? this.fairOrderedAuthor(existing, proposed) :  (proposed.iat < existing.iat)),
			       'date');
  }
}

export class ImmutableCollection extends Collection {
  checkDate(existing, proposed) { // Op will return existing tag if more recent, rather than failing.
    if (!proposed.iat) return 'no timestamp';
    return this.checkSomething('',
			       ((proposed.iat === existing.iat) ? this.fairOrderedAuthor(existing, proposed) :  (proposed.iat > existing.iat)),
			       'date');
  }
  async checkTag(verified) { // If the tag doesn't match the data, silently use the existing tag, else fail hard.
    return this.checkSomething(verified.existing ? '' : 'wrong tag', verified.tag !== await this.hash(verified), 'immutable tag');
  }
}

export class StateCollection extends ImmutableCollection {
  // A property named message may be included in the data, which tell the application how to rebuild states in a different order for merging.
  // A option named antecedent may be provided that identifies the preceding state (before the message was applied).

  hashablePayload(validation) { // Include ant || iat.
    const {ant, iat} = validation.protectedHeader;
    const payload = super.hashablePayload(validation);
    this.log('hashing', {payload, ant, iat});
    return payload + (ant || iat);
  }
  async checkTag(verified) {
    if (verified.protectedHeader.fixme) return '';
    const tag = verified.tag;
    const hash = await this.hash(verified);
    return this.checkSomething('wrong state tag', tag !== hash, 'state tag');
  }
  checkDate() { // always ok
    return null;
  }
  getOwner(protectedHeader) { // Return the tag of what shall be considered the owner.
    return protectedHeader.group || super.getOwner(protectedHeader);
  }
  antecedent(validation) {
    if (validation.text === '') return validation.tag; // Delete compares with what's there
    return validation.protectedHeader.ant;
  }
  // fixme: remove?
  async forEachState(tag, callback, result = null) { // await callback(verifiedState, tag) on the state chain specified by tag.
    // Stops iteration and resolves with the first truthy value from callback. Otherwise, resolves with result.
    while (tag) {
      const verified = await this.getVerified({tag, member: null, synchronize: false});
      if (!verified) return null;
      const result = await callback(verified, tag); // verified is not decrypted
      if (result) return result;
      tag = this.antecedent(verified);
    }
    return result;
  }
  async commonState(stateTags) {
    // Return a list in which:
    // - The first element is the most recent state that is common among the elements of stateTags
    //   disregarding states that wholy a subset of another in the list.
    //   This might not be at the same depth for each of the listed states!
    // - The remaining elements contains all and only those verifiedStates that are included in the history of stateTags
    //   after the common state of the first element returned. The order of the remaining elements does not matter.
    //
    // This implementation minimizes access through the history.
    // (It tracks the verifiedStates at different depths, in order to avoid going through the history multiple times.)
    // However, if the first state in the list is a root of all the others, it will traverse that far through the others.

    if (stateTags.length <= 1) return stateTags;

    // Check each state in the first state's ancestry, against all other states, but only go as deep as needed.
    let [originalCandidateTag, ...originalOtherStateTags] = stateTags;
    let candidateTag = originalCandidateTag; // Will take on successive values in the originalCandidateTag history.

    // As we descend through the first state's candidates, keep track of what we have seen and gathered.
    let candidateVerifiedStates = new Map();
    // For each of the other states (as elements in three arrays):
    const otherStateTags = [...originalOtherStateTags]; // Will be bashed as we descend.
    const otherVerifiedStates = otherStateTags.map(() => []);     // Build up list of the verifiedStates seen so far.
    const othersSeen = otherStateTags.map(() => new Map()); // Keep a map of each hash => verifiedStates seen so far.
    // We reset these, splicing out the other data.
    function reset(newCandidate, otherIndex) { // Reset the above for another iteration through the following loop,
      // with one of the otherData removed (and the seen/verifiedStates for the remaining intact).
      // This is used when one of the others proves to be a subset or superset of the candidate.
      candidateTag = newCandidate;
      candidateVerifiedStates = null;
      [originalOtherStateTags, otherStateTags, otherVerifiedStates, othersSeen].forEach(datum => datum.splice(otherIndex, 1));
    }
    const key = verified => { // By which to dedupe state records.
      // fixme cleanup
      // It would be nice if we cached this in the protected header, but then we'd have to check it anyway.
      //return this.hash(verified);
      //const {kid, act, iat} = verified.protectedHeader;

      //return verified.text; // + (act || kid) + iat;
      return verified.tag;

      // return ant + (act || kid) + iat;
    };
    const isCandidateInEveryHistory = async () => { // True IFF the current candidateTag appear in all the others.
      for (const otherIndex in othersSeen) { // Subtle: the following has side-effects, so calls must be in series.
	if (!await isCandidateInHistory(othersSeen[otherIndex], otherIndex)) return false;
      }
      return true;
    };
    const isCandidateInHistory = async (otherSeen, otherIndex) => { // True IFF the current candidate is in the given State's history.
      // However, if candidate/other are in a linear chain, answer false and reset the loop with other spliced out.
      //console.log('isCandidateHistory', {otherIndex, otherSeen});
      while (!otherSeen.has(candidateTag)) { // Fast check of what we've seen so far.
	const otherTag = otherStateTags[otherIndex]; // As we go, we record the data seen for this other State.
	//console.log({otherTag});
	if (!otherTag) return false;                         // If not at end... go one further level deeper in this state.
	const seenVerifiedStates = otherVerifiedStates[otherIndex];   // Note in our hash => message map, a copy of the verifiedStates seen.
	otherSeen.set(otherTag, seenVerifiedStates.slice());  // And add this state's message for our message accumulator.
	const verifiedState = await this.getVerified({tag: otherTag, member: null, synchronize: false});
	//console.log({seenVerifiedStates, verifiedState});
	if (verifiedState) seenVerifiedStates.push(verifiedState);
	otherStateTags[otherIndex] = this.antecedent(verifiedState);
      }
      // If candidate or the other is wholy a subset of the other in a linear chain, disregard the subset.	  
      // In other words, select the longer chain rather than seeking the common ancestor of the chain.

      // Original candidate (since reset) is a subset of this other: try again with this other as the candidate.
      if (candidateTag === originalCandidateTag) return reset(originalCandidateTag = originalOtherStateTags[otherIndex]);
      // Original candidate (since reset) is superset of this other: try again without this candidate
      if (candidateTag === originalOtherStateTags[otherIndex]) return reset(originalCandidateTag);
      return true;  // We found a match!
    };

    //console.log('start', {stateTags});
    while (candidateTag) {
      //console.log({candidateTag});
      if (await isCandidateInEveryHistory()) { // We found a match in each of the other States: prepare results.
	// Get the verifiedStates that we accumulated for that particular State within the others.
	//console.log('collecting verifiedStates for', candidateTag);
	othersSeen.forEach(messageMap => messageMap.get(candidateTag).forEach(message => candidateVerifiedStates.set(key(message), message)));
	return [candidateTag, ...candidateVerifiedStates.values()]; // We're done!
      } else if (candidateVerifiedStates) {
	// Move to the next candidate (one step back in the first state's ancestry).
	const verifiedState = await this.getVerified({tag: candidateTag, member: null, synchronize: false});
	if (!verifiedState) return []; // Fell off the end.
		candidateVerifiedStates.set(key(verifiedState), verifiedState);
	candidateTag = this.antecedent(verifiedState);
      } else { // We've been reset to start over.
	candidateVerifiedStates = new Map();
      }
    } // end while

    return [];   // No common ancestor found
  }
}

export class VersionedCollection extends MutableCollection {
  // A VersionedCollection can be used like any MutableCollection, retrieving the most recently stored state.
  // It has two additional functionalities:
  // 1. Previous states can be retrieved, either by tag or by timestamp.
  // 2. IFF the data provided by the application includes a single message, action, or delta for each version,
  //    then, merging of two branches of the same history can be accomplished by applying these messages to
  //    reconstruct a combined history (similarly to combining branches of a text versioning system).
  //    In this case, the application must provide the operation to produce a new state from an antecedent state
  //    and messsage, and the VersionedCollection will provide the correct calls to manage this.
  async store(data, tagOrOptions = {}) {
    // Hidden pun:
    // The first store might succeed, emit the update event, persist... and then fail on the second store.
    // However, it just so happens that they both fail under the same circumstances. Currently.
    let {tag, encryption, ...options} = this._canonicalizeOptions1(tagOrOptions);
    const root = tag && await this.getRoot(tag, false);
    // Tag is usually specified, but if it isn't generate a unique one now so that we always have a sub to
    // put in the state signature. That's needed so that update events can point back to the Versioned item tag.
    tag ||= await this.hash({text: JSON.stringify(data)}); // FIXME: binary, too.
    const versionTag = await this.versions.store(data, {encryption, ant: root, subject: tag, ...options});
    this.log('store: root', {tag, encryption, options, root, versionTag});
    if (!versionTag) return '';
    const signingOptions = {
      tag: tag || versionTag,
      encryption: '',
      ...options
    };
    return super.store([versionTag], signingOptions);
  }
  async remove(tagOrOptions) {
    const {tag, ...options} = this._canonicalizeOptions1(tagOrOptions);
    await this.forEachState(tag, (_, hash) => { // Subtle: don't return early by returning truthy.
      // This may be overkill to be using high-level remove, instead of put or even persist. We DO want the update event to fire!
      // Subtle: the ant is needed so that we don't silently skip the actual put/event.
      // Subtle: subject is needed so that update events can learn the Versioned stag.
      this.versions.remove({tag: hash, ant: hash, subject: tag, ...options});
    });
    return super.remove(tagOrOptions);
  }
  async retrieve(tagOrOptions) {
    let {tag, time, hash, ...options} = this._canonicalizeOptions1(tagOrOptions);
    if (!hash && !time) hash = await this.getRoot(tag);
    this.log('retrieve', {tag, time, hash, options});
    if (hash) return this.versions.retrieve({tag: hash, ...options});
    time = parseFloat(time);
    return this.forEachState(tag, verified => (verified.protectedHeader.iat <= time) && verified);
  }

  checkDate(existing, proposed) { // Can always merge in an older message. We keep 'em all.
    return null;
  }
  getOwner(protectedHeader) { // Return the tag of what shall be considered the owner.
    return protectedHeader.group || super.getOwner(protectedHeader);
  }
  
  async mergeSignatures(tag, validation, signature) {
    const states = validation.json || [];
    const existing = validation.existing?.json || [];
    this.log('mergeSignatures', {tag, existing, states});
    if (states.length === 1 && !existing.length) return signature; // Initial case. Trivial.
    if (existing.length === 1 && !states.length) return validation.existing.signature;

    // Let's see if we can simplify
    const combined = [...states, ...existing];
    let [ancestor, ...versionsToReplay] = await this.versions.commonState(combined);
    this.log('mergeSignatures', {tag, existing, states, ancestor, versionsToReplay});
    if (combined.length === 2) { // Common cases that can be handled without being a member
      if (ancestor === states[0]) return signature;
      if (ancestor === existing[0]) return validation.existing.signature;
    }

    const claims = validation.protectedHeader;
    const owner = this.getOwner(claims);
    //let signingAs = owner === claims.kid ? {tags: [owner], group: owner} : {team: owner, group: owner};
    let signingAs = {tags: [owner], group: owner};
    if (!await this.sign('anything', signingAs).catch(() => false)) { // We don't have access.
      //signingAs = {group: owner, tags: [mergeAuthorOverride || Credentials.author]};
      signingAs.tags = [Credentials.author];
      return this.sign(combined, signingAs);
    }
    // Get the state verifications to replay.
    if (!ancestor) versionsToReplay = await Promise.all(combined.map(async stateTag => this.versions.getVerified({tag: stateTag, synchronize: false})));
    versionsToReplay.sort((a, b) => a.protectedHeader.iat - b.protectedHeader.iat);

    await this.beginReplay(ancestor);
    for (let verified of versionsToReplay) {
      await this.constructor.ensureDecrypted(verified); // commonStates does not (cannot) decrypt.
      const replayResult = await this.replay(ancestor, verified);
      if (verified === replayResult) { // Already good.
	ancestor = verified.tag;
      } else { // Record replayResult into a new state against the antecedent, preserving group, iat, encryption. TODO: Hook for sublcassing here.
	const encryption = verified.protectedHeader.encryption || '';
	const signingOptions = {ant: ancestor, iat: verified.protectedHeader.iat, encryption, ...signingAs};
	const stateSignature = await this.versions.sign(replayResult, signingOptions);
	// Optimization opportunity among the following three lines.
	const reverified = await this.versions.constructor.verify(stateSignature);
	ancestor = await this.versions.hash(reverified);
	await this.versions.put(ancestor, stateSignature, verified.synchronizer);
      }
    }
    return this.sign([ancestor], signingAs);
  }
  // Two hooks for subclasses to override.
  beginReplay(antecedentTag) {
  }
  replay(antecedentTag, verified) {
    if (antecedentTag === verified.ant) return verified; // Returning the === verified indicates it can be reused directly.
    return verified.json || verified.text || verified.payload; // Highest form we've got.
  }

  async getRoot(tag, synchronize = true) { // Promise the tag of the most recent state
    const verifiedVersion = await this.getVerified({tag, members: null, synchronize});
    this.log('getRoot', {tag, verifiedVersion});
    if (!verifiedVersion) return '';
    const states = verifiedVersion.json;
    if (states.length !== 1) return Promise.reject(`Unmerged states in ${tag}.`);
    return states[0];
  }
  async forEachState(tag, callback) {
    // Get the root of this item at tag, and callback(verifiedState, stateTag) on the chain.
    // Stops iteration and returns the first truthy value from callback.
    const root = await this.getRoot(tag, false);
    return await this.versions.forEachState(root, callback);
  }

  // These are mostly for debugging and automated testing, as they have to through the state chain.
  // But they also illustrate how things work.
  async retrieveTimestamps(tag) { // Promises a list of all version timestamps.
    let times = [];
    await this.forEachState(tag, verified => { // Subtle: return nothing. (Don't bail early.)
      times.push(verified.protectedHeader.iat);
    });
    return times.reverse();
  }  
  async getVersions(tag) { // Promises the parsed timestamp => version dictionary IF it exists, else falsy.
    let times = {}, latest;
    await this.forEachState(tag, (verified, tag) => {
      if (!latest) latest = verified.protectedHeader.iat;
      times[verified.protectedHeader.iat] = tag;
    });
    let reversed = {latest: latest};
    Object.entries(times).reverse().forEach(([k, v]) => reversed[k] = v);
    return reversed;
  }

  // Maintaining an auxiliary collection in which store the versions as immutables.
  static stateCollectionClass = StateCollection; // Subclcasses may extend.
  constructor({services = [], ...rest} = {}) {
    super(rest);  // Without passing services yet, as we don't have the versions collection set up yet.
    this.versions = new this.constructor.stateCollectionClass(rest); // Same collection name, but different type.
    //fixme this.versions.addEventListener('update', event => this.dispatchEvent(new CustomEvent('update', {detail: this.recoverTag(event.detail)})));
    this.synchronize(...services); // Now we can synchronize.
  }
  async close() {
    await this.versions.close();
    await super.close();
  }
  async destroy() {
    await this.versions.destroy();
    await super.destroy();
  }
  // Synchronization of the auxiliary collection.
  serviceForVersion(service) { // Get the service "name" for our versions collection.
    return service?.versions || service;   // For the weird connectDirectTesting case used in regression tests, else the service (e.g., an array of signals).
  }
  servicesForVersion(services) {
    return services.map(service => this.serviceForVersion(service));
  }
  async synchronize(...services) { // synchronize the versions collection, too.
    if (!services.length) return;
    // Keep channel creation synchronous.
    const versionedPromise = super.synchronize(...services);
    const versionPromise = this.versions.synchronize(...this.servicesForVersion(services));
    await versionedPromise;
    await versionPromise;
  }
  async disconnect(...services) { // disconnect the versions collection, too.
    if (!services.length) services = this.services;
    await this.versions.disconnect(...this.servicesForVersion(services));
    await super.disconnect(...services);
  }
  get synchronized() { // promise to resolve when synchronization is complete in BOTH directions.
    // TODO? This does not reflect changes as Synchronizers are added or removed since called. Should it?
    return this.versions.synchronized.then(() => super.synchronized);
  }
  get itemEmitter() { // The versions collection emits an update corresponding to the individual item stored.
    // (The updates emitted from the whole mutable VersionedCollection correspond to the version states.)
    return this.versions;
  }
}

// When running in NodeJS, the Security object is available directly.
// It has a Storage property, which defines store/retrieve (in lib/storage.mjs) to GET/PUT on
// .../:fullLabel/:part1ofTag/:part2ofTag/:part3ofTag/:restOfTag.json
// The Security.Storage can be set by clients to something else.
//
// When running in a browser, worker.js overrides this to send messages through the JSON RPC
// to the app, which then also has an overridable Security.Storage that is implemented with the same code as above.

// Bash in some new stuff:
Credentials.author = null;
Credentials.owner = null;
Credentials.encryption = null; // TODO: rename this to audience
Credentials.synchronize = async (...services) => { // TODO: rename this to connect.
  // We can do all three in parallel -- without waiting for completion -- because dependencies will get sorted out by synchronize1.
  return Promise.all(Object.values(Credentials.collections).map(collection => collection.synchronize(...services)));
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
  if (!verified) throw new Error(`Unable to verify invitation ${tag}.`);
  const members = verified.json.recipients;
  if (members.length !== 1) throw new Error(`Invitations should have one member: ${tag}`);
  const oldRecoveryTag = members[0].header.kid;
  const newRecoveryTag = await Credentials.create({prompt: newPrompt});
  const deviceTag = await Credentials.create();

  // We need to add the new members in one changeMembership step, and then remove the oldRecoveryTag in a second call to changeMembership:
  // changeMembership will sign by an OLD member - If it signed by new member than people could bootstrap themselves onto a team.
  // But if we remove the oldRecovery tag in the same step as adding the new, the team would be signed by someone (the oldRecoveryTag) that
  // is no longer a member, and so the team would not verify!
  await Credentials.changeMembership({tag, add: [deviceTag, newRecoveryTag], remove: [oldRecoveryTag]});
  await Credentials.changeMembership({tag, remove: [oldRecoveryTag]});
  await Credentials.destroy(oldRecoveryTag);
  return tag;
};

// setAnswer must be re-provided whenever we're about to access recovery key.
const answers = {};
Credentials.setAnswer = (prompt, answer) => answers[prompt] = answer;
Credentials.getUserDeviceSecret = function flexstoreSecret(tag, promptString) {
  if (!promptString) return tag;
  if (promptString === '-') return promptString; // See createAuthor.
  const answer = answers[promptString];
  if (answer) return answer;
  // Distributed Security will try everything. Unless going through a path above, we would like others to silently fail.
  console.log(`Attempting access ${tag} with prompt '${promptString}'.`);
  return "not a secret"; // todo: crypto random
};


// These two are used directly by distributed-security.
Credentials.Storage.retrieve = async (collectionName, tag) => {
  const collection = Credentials.collections[collectionName];
  // No need to verify, as distributed-security does that itself quite carefully and team-aware.
  if (collectionName === 'EncryptionKey') await collection.synchronize1(tag);
  if (collectionName === 'KeyRecovery') await collection.synchronize1(tag);
  //if (collectionName === 'Team') await collection.synchronize1(tag);    // This would go circular. Should it? Do we need it?
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
Credentials.Storage.destroy = async () => {
  await Credentials.clear(); // Wipe from live memory.
  for (let collection of Object.values(Credentials.collections)) {
    await collection.destroy();
  }
  await Credentials.wipeDeviceKeys(); // Not included in the above.
};
Credentials.collections = {};
export { Credentials, StorageLocal };
['EncryptionKey', 'KeyRecovery', 'Team'].forEach(name => Credentials.collections[name] = new MutableCollection({name}));
