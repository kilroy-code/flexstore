import Credentials from '@ki1r0y/distributed-security';
import { tagPath } from './tagPath.mjs';
import { PromiseWebRTC } from './webrtc.mjs';

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
  constructor({peerName = 'test', collection, debug, minVersion = 1, maxVersion = 1}) {
    Object.assign(this, {peerName, collection, debug, minVersion, maxVersion});
    // TODO: Use conflict-free naming of both classes and collection names.
    this.label = `${this.collection.constructor.name}/${this.collection.name}`;
    this.hostRequestBase = this.peerName.startsWith?.('http') && `${this.peerName}/${this.label}`;
    this.connectionURL = `${this.peerName}/requestDataChannel/${this.label}`;
  }
  static async create(collection, serviceInfo, options = {}) { // Receive pushed messages from the given service. get/put/delete when they come (with empty services list).
    const peerName = (typeof(serviceInfo) === 'string') ? serviceInfo : collection.name;
    const synchronizer = new this({collection, peerName, ...options});
    let connected = false;
    if (synchronizer.hostRequestBase) {
      connected = await synchronizer.connectServer();
    } else if (serviceInfo.synchronizers) { // Duck typing for passing a collection directly as the serviceInfo.
      connected = await synchronizer.connectDirectTesting(serviceInfo);
    } else {
      throw new Error('TODO: p2p, via introducer or by qr code');
    }
    if (connected) await synchronizer.startedSynchronization;
    return synchronizer;
  }
  log(...rest) {
    if (this.debug) console.log(this.label, ...rest);
  }
  async send(method, ...params) { // Sends to the peer, over the data channel
    // TODO: break up long messages. (As a practical matter, 16 KiB is the longest that can reliably be sent across different wrtc implementations.)
    const payload = JSON.stringify({method, params});
    this.log('sends', method, ...params);
    if (payload.length > 16e3) console.error('Unsupportable payload size', payload.length); //16e3 is not a typo. Being conservative in our warning.
    (await this.dataChannelPromise).send(payload);
  }
  receive(text) { // Dispatch a message sent over the data channel from the peer.
    const {method, params} = JSON.parse(text);
    this[method](...params);
  }

  async disconnect() { // Wait for dataChannel to drain and then close.
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
    const connection = this.connection = new PromiseWebRTC({label: this.label, debug: this.debug});
    this.closed = this.makeResolveablePromise();
    const onMessage = event => this.receive(event.data);
    const onClose = async event => { this.connection.close(); this.closed.resolve(); };
    const setOnMessage = dataChannel => { dataChannel.onmessage = onMessage; return dataChannel; };
    const setOnClose = dataChannel => { dataChannel.onclose = onClose; return dataChannel; };
    const setPromise = promise => this.dataChannelPromise = promise.then(setOnClose).then(setOnMessage);
    if (signalMessages) {
      setPromise(connection.getDataChannelPromise());
      connection.signals = signalMessages;
      return await connection.signals;
    } else {
      setPromise(connection.createDataChannel());
      return connection.signals;
    }
  }
  completeConnection(signalMessages) { // Finish what was started with startCollection.
    // Does not return a promise. Client can await this.dataChannelPromise to see when we are actually connected.
    this.connection.signals = signalMessages;
    return true;
  }

  async connectServer(url = this.connectionURL) { // Connect to a relay over http.
    // TODO: Implement this for clients on a WAN (through an introducer) and a LAN (through QR codes).
    const signals = await this.startConnection();
    const body = JSON.stringify(signals);
    const request = await fetch(url, {method: 'POST', body});
    const response = await request.text();
    return this.completeConnection(JSON.parse(response));
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
    if (combinedMax >= combinedMin) return versionPromise.resolve(combinedMax); // No need to respond, as they will produce the same deterministic answer.
    await this.disconnect();
    return versionPromise.resolve(0);
  }
  get version() { // Promise the highest version suported by both sides, or disconnect and falsy if none.
    // Tells the other side our versions if we haven't yet done so.
    return this._version ||= this.makeResolveablePromise(this.send('versions', this.minVersion, this.maxVersion));
  }

  get startedSynchronization() { // Promise that resolves when we have started synchronization.
    return this._startedSynchronization ||= this.startSynchronization();
  }
  get completedSynchronization() { // Promise that resolves to the number of items that were synchronized.
    // Starts synchronization if it hasn't already. E.g., waiting on completedSynchronization won't resolve until after it starts.
    return this._completedSynchronization ||= this.makeResolveablePromise(this.startedSynchronization);
  }
  async startSynchronization() { // Wait for all preliminaries, and start streaming our tags.
    // First negotiates version and collects the tags.
    const [version, ourTags] = await Promise.all([this.version, this.collection.tags]);
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
  cleanUpIfFinished() { // If we are not waiting for anything, we're done. Clean up.
    if (!this.endOfPeerTags || this.unsynchronized.size) return;
    const nSynchronized = this.synchronized.size;
    this.log('completed synchronization of', nSynchronized);
    this.synchronized.clear();
    this.unsynchronized.clear();
    this.ourTags = this.synchronized = this.unsynchronized = null;
    this.completedSynchronization.resolve(nSynchronized);
  }
  synchronizationPromise(tag) { // Return something to await that resolves when tag is synchronized.
    if (!this.unsynchronized) return true; // We are fully synchronized.
    if (this.synchronized.has(tag)) return true; // This particular tag has synchronized.
    // If a request is in flight, return that promise. Otherwise create one.
    return this.unsynchronized.get(tag) || this.noteRequest(tag, this.getHash(tag));
  }

  async hash(tag, hash) { // Receive a [tag, hash] that the peer knows about.
    await this.startedSynchronization;
    const {ourTags, unsynchronized} = this;
    if (unsynchronized.has(tag)) return null; // Already awaiting their record because of a local get request.
    if (!ourTags.has(tag)) return this.noteRequest(tag); // We don't have the record at all.
    const ours = await this.getHash(tag);
    if (hash === ours) return null; // Ours and theirs match.
    return this.noteRequest(tag, ours);

  }
  noteRequest(tag, ours = null) {
    const promise = this.request(tag);
    promise.then(theirs => this.reconcile(tag, ours, theirs));
    this.unsynchronized.set(tag, promise);
  }
  async reconcile(tag, ourHashPromise, theirs) { // Bookeeping for a result from peer.
    if (await ourHashPromise === await this.computeHash(theirs)) return;
    await this.collection.put(tag, theirs);
    this.synchronized.add(tag);
    this.unsynchronized.delete(tag);
    this.cleanUpIfFinished();
  }
  request(tag) { // Answer a promise the resolves with the data.
    const { hostRequestBase } = this;
    if (hostRequestBase) {
      return fetch(tagPath(hostRequestBase, tag)).then(response => response.text());
    }
    return this.makeResolveablePromise(this.send('get', tag));
  }
  async get(tag) { // Respond to a peer's get() request by sending a put reponse with the data.
    this.push(tag, await this.collection.get(tag));
  }
  push(tag, signature) { // Tell the other side about a signed write.
    this.send('put', tag, signature);
  }
  async put(tag, signature) { // receive the response to a get() request by resolving the corresponding promise.
    const promise = this.unsynchronized?.get(tag);
    // Regardless of why the other side is sending, if we have an outstanding request, consume it.
    if (promise) promise.resolve(signature);
    else await this.collection.put(tag, signature); // Otherwise, just try to write it locally.
  }
  
}
export default Synchronizer;
