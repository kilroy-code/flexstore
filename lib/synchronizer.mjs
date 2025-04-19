import Credentials from '@ki1r0y/distributed-security';
import { tagPath } from './tagPath.mjs';
import { SharedWebRTC } from './webrtc.mjs';
import { version } from './version.mjs';

/*
  Responsible for keeping a collection synchronized with another peer.
  (Peers may be a client or a server/relay. Initially this is the same code either way,
  but later on, optimizations can be made for scale.)

  As long as two peers are connected with a Synchronizer on each side, writing happens
  in both peers in real time, and reading produces the correct synchronized result from either.
  Under the hood, the synchronizer keeps track of what it knows about the other peer --
  a particular tag can be unknown, unsynchronized, or synchronized, and reading will
  communicate as needed to get the data synchronized on-demand. Meanwhile, synchronization
  continues in the background until the collection is fully replicated.

  A collection maintains a separate Synchronizer for each of zero or more peers, and can dynamically
  add and remove more.
*/
export class Synchronizer {
  constructor({serviceName = 'direct', collection,
	       serviceKey = collection?.serviceKey || serviceName, // Used to identify any existing connection. Can be different from serviceName during testing.
	       channelName, uuid, rtcConfiguration, connection, // Complex default behavior for these. See code.
	       multiplex = collection?.multiplex, // If specifed, otherwise undefined at this point. See below.
	       debug = collection?.debug, minVersion = version, maxVersion = minVersion}) {
    // serviceName is a string or object that identifies where the synchronizer should connect. E.g., it may be a URL carrying
    // WebRTC signaling. It should be app-unique for this particular service (e.g., which might multiplex data for multiple collection instances).
    // uuid help uniquely identifies this particular synchronizer.
    // For most purposes, uuid should get the default, and refers to OUR end.
    // However, a server that connects to a bunch of peers might bash in the uuid with that of the other end, so that logging indicates the client.
    // TODO: Use conflict-free naming of both classes and collection names.
    // If channelName is specified, it should be in the form of collectionType/collectionName (e.g., if connecting to relay).
    const collectionName = channelName || `${collection.constructor.name}/${collection?.name}`;
    const connectThroughInternet = serviceName.startsWith?.('http');
    if (!connectThroughInternet && (rtcConfiguration === undefined)) rtcConfiguration = {}; // Expicitly no ice. LAN only.
    // multiplex should end up with one of three values:
    // falsy - a new connection should be used for each channel
    // "negotiated" - both sides create the same channelNames in the same order (most cases):
    //     The initial signalling will be triggered by one side creating a channel, and ther side waiting for it to be created.
    //     After that, both sides will explicitly create a data channel and webrtc will match them up by id.
    // any other truthy - Starts like negotiated, and then continues with only wide side creating the channels, and ther other
    //     observes the channel that has been made. This is used for relays.
    multiplex ??= connection?.multiplex; // Still typically undefined at this point.
    multiplex ??= (serviceName.includes?.('/sync') || 'negotiated');
    console.log('multiplex report', serviceName, serviceKey, multiplex, collection?.multiplex, connection?.multiplex);
    connection ??= SharedWebRTC.ensure({service: serviceName, key: serviceKey, configuration: rtcConfiguration, multiplex, debug});
    //console.log('fixme construct', collectionName, 'key', serviceKey, 'got', connection);
    uuid ??= connection.uuid;
    // Both peers must agree on channelName. Usually, this is collectionName. But in testing, we may sync two collections with different names.
    channelName ??= collection.channelName || collectionName;
    const label = `${collectionName}/${uuid}`;
    console.log('fixme construct Synchronizer', {label, serviceName, serviceKey, channelName, connectThroughInternet, multiplex, debug, collection, connection});
    Object.assign(this, {serviceName, label, collectionName, collection, debug, minVersion, maxVersion, uuid, rtcConfiguration,
			 connection, uuid, channelName,
			 connectionStartTime: Date.now(),
			 closed: this.makeResolveablePromise(),
			 // Where we can request a data channel that pushes put/delete requests from others.
			 connectionURL: `${serviceName}/${label}`,
			 // Not used yet, but could be used to GET resources over http instead of through the data channel.
			 hostRequestBase: connectThroughInternet && `${serviceName.replace(/\/(sync|signal)/)}/${collectionName}`});
    collection?.synchronizers.set(serviceName, this); // Must be set synchronously, so that collection.synchronize1 knows to wait.
    this.log('fixme test construct');
  }
  static async create(collection, serviceName, options = {}) { // Receive pushed messages from the given service. get/put/delete when they come (with empty services list).
    const synchronizer = new this({collection, serviceName, ...options});
    const connected = await synchronizer.connectChannel();
    if (!connected) return synchronizer;
    return await connected.synchronize();
  }
  async connectChannel() {
    const {hostRequestBase, uuid, connection, serviceName} = this;
    let started = connection.hasStartedConnecting;
    console.info(this.label, this.connection.peer.connectionState, serviceName
		 ,connection.hasStartedConnecting ? 'started' : 'first'
		);
    if (started) {
      // We already have a connection. Just open another data channel for our use.
      //console.log('awaiting connection', this.label, this.connection.peer.connectionState, serviceName);
      //await connection.connected;
      //console.log('got connection', this.label, this.connection.peer.connectionState, serviceName);
      this.dataChannelPromise = connection.ensureDataChannel(this.channelName);
      await this.dataChannelPromise;
    } else if (this.connectionURL.includes('/signal')) { // Rendevous with another peer by exchanging signals.
	started = await this.connectRendevous();
    } else if (this.connectionURL.includes('/sync')) { // Connect with a server relay. (Signal and stay connected through sync.)
      started = await this.connectServer();
    } else if (serviceName === 'signals') { // Start connection and return null. Must be continued with completeSignalsSynchronization();
      await this.startConnection();
      return null;
    } else if (Array.isArray(serviceName)) { // A list of "receiving" signals.
      await this.startConnection(serviceName);
    } else if (serviceName.synchronizers) { // Duck typing for passing a collection directly as the serviceInfo. (We don't import Collection.)
      started = await this.connectDirectTesting(serviceName); // Used in testing.
    } else {
      throw new Error(`Unrecognized service format: ${serviceName}.`);
    }
    if (!started) {
      console.warn(this.label, 'connection failed');
      return null;
    }
    return this;
  }

  log(...rest) {
    if (this.debug) console.log(this.label, ...rest);
  }
  get dataChannelPromise() { // A promise that resolves to an open data channel.
    const promise = this._dataChannelPromise;
    if (!promise) throw new Error(`${this.label}: Data channel is not yet promised.`);
    return promise;
  }
  set dataChannelPromise(promise) { // Set up message and close handling.
    this._dataChannelPromise = promise.then(dataChannel => {
      this.log('fixme test set onmessage', dataChannel.readyState, dataChannel);
      dataChannel.onmessage = event => this.receive(event.data);
      dataChannel.onclose = async event => {
	this.log('Synchronizer onClose');
	this.collection?.synchronizers.delete(this.serviceName);
	this.closed.resolve();
      };
      return dataChannel;
    });
  }
  async synchronize() {
    console.log('synchronize:', this.label);
    await this.dataChannelPromise;
    console.log('synchronize: dataChannel', this.label, await this.dataChannelPromise);    
    await this.startedSynchronization;
    console.log('synchronize: started sync', this.label);    
    return this;
  }
  async send(method, ...params) { // Sends to the peer, over the data channel
    // TODO: break up long messages. (As a practical matter, 16 KiB is the longest that can reliably be sent across different wrtc implementations.)
    // See https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels#concerns_with_large_messages
    const payload = JSON.stringify({method, params});
    const dataChannel = await this.dataChannelPromise;
    const state = dataChannel?.readyState || 'closed';
    this.log('fixme test send', method, state);
    if (state === 'closed' || state === 'closing') return;
    this.log('sends', method, ...params);
    if (payload.length > 16e3) console.warn(this.label, 'Unsupportable payload size', payload.length); //16e3 is not a typo. Being conservative in our warning.
    dataChannel.send(payload);
  }
  receive(text) { // Dispatch a message sent over the data channel from the peer.
    this.log('fixme test receive', text);
    const {method, params} = JSON.parse(text);
    this[method](...params);
  }

  async disconnect() { // Wait for dataChannel to drain and return a promise to resolve when actually closed,
    // but return immediately if connection not started.
    this.log('Synchronizer.disconnect');
    if (this.connection.peer.connectionState !== 'connected') return this.connection.close();
    const dataChannel = await this.dataChannelPromise;
    dataChannel.close();
    return this.closed;
  }
  // TODO: webrtc negotiation needed during sync.
  // TODO: webrtc negotiation needed after sync.
  async startConnection(signalMessages) { // Machinery for making a WebRTC connection to the peer:
    //   If signalMessages is a list of [operation, message] message objects, then the other side is initiating
    // the connection and has sent an initial offer/ice. In this case, connect() promises a response
    // to be delivered to the other side.
    //   Otherwise, connect() promises a list of initial signal messages to be delivered to the other side,
    // and it is necessary to then call completeConnection() with the response from them.
    // In both cases, as a side effect, the dataChannelPromise property will be set to a Promise
    // that resolves to the data channel when it is opens. This promise is used by send() and receive().
    const {connection} = this;
    this.log(signalMessages ? 'generating answer' : 'generating offer');
    this.dataChannelPromise = connection.ensureDataChannel(this.channelName, {}, signalMessages);
    return connection.signals;
  }
  completeConnection(signalMessages) { // Finish what was started with startCollection.
    // Does not return a promise. Client can await this.dataChannelPromise to see when we are actually connected.
    this.connection.signals = signalMessages;
    return true;
  }

  async post(url, body) { // As JSON
    if (this.debug) this.log('posting signals', JSON.stringify(body, null, 2)); // TODO: stringify in log instead of needing to guard with this.debug.
    const request = await fetch(url, {method: 'POST', headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    const result = await request.json();
    if (this.debug) this.log('responseSignals', JSON.stringify(result, null, 2));
    return result;
  }
  async connectServer(url = this.connectionURL) { // Connect to a relay over http. Compare connectRendevous
    // startConnection, post it, completeConnection with the response.
    // Our webrtc synchronizer is then connected to the relay's webrt synchronizer.
    const signals = await this.startConnection();
    const response = await this.post(url, signals);
    return this.completeConnection(response);
  }
  async connectRendevous(url = this.connectionURL) { // Connect through a fixed-ip address rendevous to another peer doing the same.
    this.log('connectRendevous', url);
    // TODO: error handling from requests.
    const ourFirstSignals = await this.startConnection();
    //console.log('ourFirstSignals:', this.label, ourFirstSignals);
    const responseSignals = await this.post(url, ourFirstSignals);
    //console.log('responseSignals:', this.label, responseSignals);
    const [[operation], ...rest] = responseSignals;
    if (operation === 'reset') {
      console.log('fixme connectRendevous: before close', this.label, this.connection.label);
      this.connection.close(false); // Do not remove the SharedWebRTC connection instance.
      console.log('connectRendevous: restart after close', this.connection.channelId, this.connection.peer.versionId);
      const ourAnswer = await this.startConnection(rest); // (Re-)Start our connection with response from the other peer.
      console.log('connectRendevous ourAnswer:', this.label);
      const secondRequest = await this.post(url, ourAnswer); // Tell them about our answer.
      console.log('connectRendevous ignoring:', this.label);
      // There is nothing else for us to do. The response will not have any additional signals.
    } else { // We were first in. Complete with the response we received from the other peer through the rendevous.
      this.completeConnection(responseSignals);
    }
    console.log('connectRendevous ok', this.label, this.connection.key);
    return true;
  }
  async completeSignalsSynchronization(signals) { // Given answer/ice signals, complete the connection and start synchronize.
    await this.completeConnection(signals);
    await this.synchronize();
  }
  async connectDirectTesting(peerCollection) { // Used in unit testing, where the "remote" service is specified directly (not a string).
    // Each collection is asked to sychronize to another collection.
    const peerSynchronizer = peerCollection.synchronizers.get(this.collection);
    if (!peerSynchronizer) { // The other side doesn't know about us yet. The other side will do the work.
      this._delay = this.makeResolveablePromise();
      return false;
    }
    const ourSignals = await this.startConnection();
    const theirSignals = await peerSynchronizer.startConnection(ourSignals);
    peerSynchronizer._delay.resolve();
    return this.completeConnection(theirSignals);
  }

  // A common practice here is to have a property that is a promise for having something done.
  // Asynchronous machinery can then resolve it.
  // Anything that depends on that can await the resolved value, without worrying about how it gets resolved.
  // We cache the promise so that we do not repetedly trigger the underlying action.
  makeResolveablePromise(ignored) { // Answer a Promise that can be resolve with thePromise.resolve(value).
    // The ignored argument is a convenient place to call something for side-effect.
    let resolver;
    const promise = new Promise(resolve => resolver = resolve);
    promise.resolve = resolver;
    return promise;
  }

  async versions(min, max) { // On receiving the versions supported by the the peer, resolve the version promise.
    let versionPromise = this.version;
    const combinedMax = Math.min(max, this.maxVersion);
    const combinedMin = Math.max(min, this.minVersion);
    this.log('fixme resolve versions', {min, max, combinedMax, combinedMin});
    if (combinedMax >= combinedMin) return versionPromise.resolve(combinedMax); // No need to respond, as they will produce the same deterministic answer.
    return versionPromise.resolve(0);
  }
  get version() { // Promise the highest version suported by both sides, or disconnect and falsy if none.
    // Tells the other side our versions if we haven't yet done so.
    this.log('fixme test version', this.minVersion, this.maxVersion); // FIXME: can we avoid this timeout?
    return this._version ||= this.makeResolveablePromise(setTimeout(() => this.send('versions', this.minVersion, this.maxVersion), 200));
  }

  get startedSynchronization() { // Promise that resolves when we have started synchronization.
    return this._startedSynchronization ||= this.startSynchronization();
  }
  get completedSynchronization() { // Promise that resolves to the number of items that were synchronized.
    // Starts synchronization if it hasn't already. E.g., waiting on completedSynchronization won't resolve until after it starts.
    return this._completedSynchronization ||= this.makeResolveablePromise(this.startedSynchronization);
  }
  get peerCompletedSynchronization() { // Promise that resolves to the number of items that we peer synchronized.
    return this._peerCompletedSynchronization ||= this.makeResolveablePromise();
  }
  get bothSidesCompletedSynchronization() {
    return this.completedSynchronization.then(() => this.peerCompletedSynchronization);
  }
  async reportConnection() { // Log connection time and type.
    const stats = await this.connection.peer.getStats();
    let transport;
    for (const report of stats.values()) {
      if (report.type === 'transport') {
	transport = report;
	break;
      }
    }
    let candidatePair = transport && stats.get(transport.selectedCandidatePairId);
    if (!candidatePair) { // Safari doesn't follow the standard.
      for (const report of stats.values()) {
	if ((report.type === 'candidate-pair') && report.selected) {
	  candidatePair = report;
	  break;
	}
      }
    }
    if (!candidatePair) {
      console.warn(this.label, 'got stats without candidatePair', Array.from(stats.values()));
      return;
    }
    const remote = stats.get(candidatePair.remoteCandidateId);
    const {protocol, candidateType} = remote;
    const now = Date.now();
    Object.assign(this, {stats, transport, candidatePair, remote, protocol, candidateType, synchronizationStartTime: now});
    console.info(this.label, 'connected', protocol, candidateType, ((now - this.connectionStartTime)/1e3).toFixed(1));
  }
  async startSynchronization() { // Wait for all preliminaries, and start streaming our tags.
    const dataChannel = await this.dataChannelPromise;
    if (!dataChannel) throw new Error(`No connection for ${this.label}.`);
    console.log('startSynchronization', this.label);
    // First, report stats.
    await this.reportConnection();
    // Now negotiate version and collects the tags.
    this.log('fixme test startSynchronization');
    //const [version, ourTags] = await Promise.all([this.version, this.collection.tags]);
    const version = await this.version;
    console.log('startSynchronization: version', this.label, version);
    const ourTags = await this.collection.tags;
    this.log('startSynchronization', version, ourTags);
    Object.assign(this, {
      ourTags, // Set of each tag we have locally. Changes as things are added and deleted.
      synchronized: new Set(), // Set of what tags have been explicitly synchronized.
      unsynchronized: new Map(), // Map of tag to promise for tags that are being synchronized.
      endOfPeerTags: false // Is the peer finished streaming?
    });
    this.streamTags(ourTags); // But do not wait for it.
  }
  async computeHash(text) { // Our standard hash. (String so that it is serializable.)
    const hash = await Credentials.hashText(text);
    return Credentials.encodeBase64url(hash);
  }
  async getHash(tag) { // Whole signature (NOT protectedHeader.sub of content).
    const raw = await this.collection.get(tag);
    return this.computeHash(raw || 'missing');
  }
  async streamTags(tags) { // Send each of our known tag/hash pairs to peer, one at a time, followed by endOfTags.
    for (const tag of tags) {
      this.send('hash', tag, await this.getHash(tag));
    }
    this.send('endTags');
  }
  async endTags() { // The peer has finished streamTags().
    await this.startedSynchronization;
    this.endOfPeerTags = true;
    this.cleanUpIfFinished();
  }
  synchronizationComplete(nSynchronized) { // The peer has finished getting all the data it needs from us.
    this.log('received synchronizationComplete', nSynchronized);
    this.peerCompletedSynchronization.resolve(nSynchronized);
  }
  cleanUpIfFinished() { // If we are not waiting for anything, we're done. Clean up.
    if (!this.endOfPeerTags || this.unsynchronized.size) return;
    const nSynchronized = this.synchronized.size;
    this.send('synchronizationComplete', nSynchronized);
    this.synchronized.clear();
    this.unsynchronized.clear();
    this.ourTags = this.synchronized = this.unsynchronized = null;
    console.info(this.label, 'completed synchronization', nSynchronized, 'items in', ((Date.now() - this.synchronizationStartTime)/1e3).toFixed(1), 'seconds');
    this.completedSynchronization.resolve(nSynchronized);
  }
  synchronizationPromise(tag) { // Return something to await that resolves when tag is synchronized.
    if (!this.unsynchronized) return true; // We are fully synchronized.
    if (this.synchronized.has(tag)) return true; // This particular tag has synchronized.
    // If a request is in flight, return that promise. Otherwise create one.
    return this.unsynchronized.get(tag) || this.noteRequest(tag, '', this.getHash(tag));
  }

  async hash(tag, hash) { // Receive a [tag, hash] that the peer knows about.
    await this.startedSynchronization;
    const {ourTags, unsynchronized} = this;
    if (unsynchronized.has(tag)) return null; // Already has an investigation in progress (e.g, due to local app synchronizationPronise).
    if (!ourTags.has(tag)) return this.noteRequest(tag, hash); // We don't have the record at all.
    return this.noteRequest(tag, hash, this.getHash(tag));
  }
  noteRequest(tag, theirHash = '', ourHashPromise = null) {
    // Synchronously record (in the unsynchronized map) a promise to (conceptually) request the tag from the peer,
    // put it in the collection, and cleanup the bookkeeping. Return that promise. However, if we are
    // given hashes to compare and they match, we can skip the request/put.
    // (This must return atomically because caller has checked various bookkeeping at that moment.)
    const promise = new Promise(resolve => {
      setTimeout(async () => { // Next tick. See request().
	if (!theirHash || !ourHashPromise || (theirHash !== await ourHashPromise)) {
	  const theirData = await this.request(tag);
	  // Might have been triggered by our app requesting this tag before we were sync'd. So they migh not have the data.
	  if (!theirHash || theirData?.length) {
	    if (await this.collection.put(tag, theirData, this)) {
	      this.log('received/put', tag, 'their/our hash:', theirHash || 'missingTheirs', (await ourHashPromise) || 'missingOurs', theirData?.length);
	    } else {
	      this.log('unable to put', tag);
	    }
	  }
	  this.synchronized.add(tag); // Only if we actually stored.
	}
	this.unsynchronized.delete(tag); // Unconditionally, because we set it unconditionally.
	this.cleanUpIfFinished();
	resolve();
      });
    });
    this.unsynchronized.set(tag, promise); // Unconditionally, in case we need to know we're looking during the time we're looking.
    return promise;
  }
  request(tag) { // Answer a promise the resolves with the data.
    const { hostRequestBase } = this;/* fixme
    if (hostRequestBase) {
      // E.g., a localhost router might support a get of http://localhost:3000/flexstore/MutableCollection/com.ki1r0y.whatever/_t/uL/BAcW_LNAJa/cJWmumble
      // So hostRequestBase should be "http://localhost:3000/flexstore/MutableCollection/com.ki1r0y.whatever",
      // and serviceName should be something like "http://localhost:3000/flexstore/sync"
      return fetch(tagPath(hostRequestBase, tag)).then(response => response.text());
    }*/
    const promise = this.makeResolveablePromise(this.send('get', tag));
    // Subtle: When the 'put' comes back, we will need to resolve this promise. But how will 'put' find the promise to resolve it?
    // As it turns out, to get here, we have necessarilly set tag in the unsychronized map. Bash the resolve in there.
    this.unsynchronized.get(tag).resolve = promise.resolve;
    return promise;
  }
  async get(tag) { // Respond to a peer's get() request by sending a put reponse with the data.
    this.push('put', tag, await this.collection.get(tag));
  }
  push(operation, tag, signature) { // Tell the other side about a signed write.
    this.send(operation, tag, signature);
  }
  async put(tag, signature) { // Receive a put message from the peer.
    // If it is a response to a get() request, resolve the corresponding promise.
    const promise = this.unsynchronized?.get(tag);
    // Regardless of why the other side is sending, if we have an outstanding request, complete it.
    if (promise) promise.resolve(signature);
    else await this.collection.put(tag, signature, this); // Otherwise, just try to write it locally.
  }
  delete(tag, signature) { // Receive a delete message from the peer.
    this.collection.delete(tag, signature, this);
  }
}
export default Synchronizer;
