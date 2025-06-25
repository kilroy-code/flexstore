import Credentials from '@ki1r0y/distributed-security';
export { default as Credentials } from '@ki1r0y/distributed-security';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function valid(uuid) {
  return uuidPattern.test(uuid);
}

// Based on https://abhishekdutta.org/blog/standalone_uuid_generator_in_javascript.html
// IE11 and Modern Browsers Only
function uuid4() {
  var temp_url = URL.createObjectURL(new Blob());
  var uuid = temp_url.toString();
  URL.revokeObjectURL(temp_url);
  return uuid.split(/[:\/]/g).pop().toLowerCase(); // remove prefixes
}
uuid4.valid = valid;

// In a browser, wrtc properties such as RTCPeerConnection are in globalThis.
var wrtc = globalThis;

//const {default:wrtc} = await ((typeof(process) !== 'undefined') ? import('@roamhq/wrtc') : {default: globalThis});

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302'},
  // https://freestun.net/  Currently 50 KBit/s. (2.5 MBit/s fors $9/month)
  { urls: 'stun:freestun.net:3478' },
  //{ urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' },
  // Presumably traffic limited. Can generate new credentials at https://speed.cloudflare.com/turn-creds
  // Also https://developers.cloudflare.com/calls/ 1 TB/month, and $0.05 /GB after that.
  { urls: 'turn:turn.speed.cloudflare.com:50000', username: '826226244cd6e5edb3f55749b796235f420fe5ee78895e0dd7d2baa45e1f7a8f49e9239e78691ab38b72ce016471f7746f5277dcef84ad79fc60f8020b132c73', credential: 'aba9b169546eb6dcc7bfb1cdf34544cf95b5161d602e3b5fa7c8342b2e9802fb' }
  // https://fastturn.net/ Currently 500MB/month? (25 GB/month for $9/month)
  // https://xirsys.com/pricing/ 500 MB/month (50 GB/month for $33/month)
  // Also https://www.npmjs.com/package/node-turn or https://meetrix.io/blog/webrtc/coturn/installation.html
];

// Utility wrapper around RTCPeerConnection.
// When something triggers negotiation (such as createDataChannel), it will generate calls to signal(), which needs to be defined by subclasses.
class WebRTC {
  constructor({label = '', configuration = null, uuid = uuid4(), debug = false, error = console.error, ...rest} = {}) {
    configuration ??= {iceServers}; // If configuration can be ommitted or explicitly as null, use our default. But if {}, leave it be.
    Object.assign(this, {label, configuration, uuid, debug, error, ...rest});
    this.resetPeer();
  }
  signal(type, message) { // Subclasses must override or extend. Default just logs.
    this.log('sending', type, type.length, JSON.stringify(message).length);
  }

  peerVersion = 0;
  resetPeer() { // Set up a new RTCPeerConnection. (Caller must close old if necessary.)
    const old = this.peer;
    if (old) {
      old.onnegotiationneeded = old.onicecandidate = old.onicecandidateerror = old.onconnectionstatechange = null;
      // Don't close unless it's been opened, because there are likely handlers that we don't want to fire.
      if (old.connectionState !== 'new') old.close();
    }
    const peer = this.peer = new wrtc.RTCPeerConnection(this.configuration);
    peer.versionId = this.peerVersion++;
    peer.onnegotiationneeded = event => this.negotiationneeded(event);
    peer.onicecandidate = event => this.onLocalIceCandidate(event);
    // I don't think anyone actually signals this. Instead, they reject from addIceCandidate, which we handle the same.
    peer.onicecandidateerror = error => this.icecandidateError(error);
    // I think this is redundnant because no implementation fires this event any significant time ahead of emitting icecandidate with an empty event.candidate.
    peer.onicegatheringstatechange = event => (peer.iceGatheringState === 'complete') && this.onLocalEndIce;
    peer.onconnectionstatechange = event => this.connectionStateChange(this.peer.connectionState);
  }
  onLocalIceCandidate(event) {
    // The spec says that a null candidate should not be sent, but that an empty string candidate should. Safari (used to?) get errors either way.
    if (!event.candidate || !event.candidate.candidate) this.onLocalEndIce();
    else this.signal('icecandidate', event.candidate);
  }
  onLocalEndIce() { // Triggered on our side by any/all of onicecandidate with no event.candidate, iceGatheringState === 'complete'.
    // I.e., can happen multiple times. Subclasses might do something.
  }
  close() {
    if ((this.peer.connectionState === 'new') && (this.peer.signalingState === 'stable')) return;
    this.resetPeer();
  }
  connectionStateChange(state) {
    this.log('state change:', state);
    if (['disconnected', 'failed', 'closed'].includes(state)) this.close(); // Other behavior are reasonable, tolo.
  }
  negotiationneeded() { // Something has changed locally (new stream, or network change), such that we have to start negotiation.
    this.log('negotiationnneeded');
    this.peer.createOffer()
      .then(offer => {
        this.peer.setLocalDescription(offer); // promise does not resolve to offer
	return offer;
      })
      .then(offer => this.signal('offer', offer))
      .catch(error => this.negotiationneededError(error));
  }
  offer(offer) { // Handler for receiving an offer from the other user (who started the signaling process).
    // Note that during signaling, we will receive negotiationneeded/answer, or offer, but not both, depending
    // on whether we were the one that started the signaling process.
    this.peer.setRemoteDescription(offer)
      .then(_ => this.peer.createAnswer())
      .then(answer => this.peer.setLocalDescription(answer)) // promise does not resolve to answer
      .then(_ => this.signal('answer', this.peer.localDescription));
  }
  answer(answer) { // Handler for finishing the signaling process that we started.
    this.peer.setRemoteDescription(answer);
  }
  icecandidate(iceCandidate) { // Handler for a new candidate received from the other end through signaling.
    this.peer.addIceCandidate(iceCandidate).catch(error => this.icecandidateError(error));
  }
  log(...rest) {
    if (this.debug) console.log(this.label, this.peer.versionId, ...rest);
  }
  logError(label, eventOrException) {
    const data = [this.label, this.peer.versionId, ...this.constructor.gatherErrorData(label, eventOrException)];
    this.error(data);
    return data;
  }
  static error(error) {
  }
  static gatherErrorData(label, eventOrException) {
    return [
      label + " error:",
      eventOrException.code || eventOrException.errorCode || eventOrException.status || "", // First is deprecated, but still useful.
      eventOrException.url || eventOrException.name || '',
      eventOrException.message || eventOrException.errorText || eventOrException.statusText || eventOrException
    ];
  }
  icecandidateError(eventOrException) { // For errors on this peer during gathering.
    // Can be overridden or extended by applications.

    // STUN errors are in the range 300-699. See RFC 5389, section 15.6
    // for a list of codes. TURN adds a few more error codes; see
    // RFC 5766, section 15 for details.
    // Server could not be reached are in the range 700-799.
    const code = eventOrException.code || eventOrException.errorCode || eventOrException.status;
    // Chrome gives 701 errors for some turn servers that it does not give for other turn servers.
    // This isn't good, but it's way too noisy to slog through such errors, and I don't know how to fix our turn configuration.
    if (code === 701) return;
    this.logError('ice', eventOrException);
  }
}

class PromiseWebRTC extends WebRTC {
  // Extends WebRTC.signal() such that:
  // - instance.signals answers a promise that will resolve with an array of signal messages.
  // - instance.signals = [...signalMessages] will dispatch those messages.
  //
  // For example, suppose peer1 and peer2 are instances of this.
  // 0. Something triggers negotiation on peer1 (such as calling peer1.createDataChannel()). 
  // 1. peer1.signals resolves with <signal1>, a POJO to be conveyed to peer2.
  // 2. Set peer2.signals = <signal1>.
  // 3. peer2.signals resolves with <signal2>, a POJO to be conveyed to peer1.
  // 4. Set peer1.signals = <signal2>.
  // 5. Data flows, but each side whould grab a new signals promise and be prepared to act if it resolves.
  //
  constructor({iceTimeout = 2e3, ...properties}) {
    super(properties);
    this.iceTimeout = iceTimeout;
  }
  get signals() { // Returns a promise that resolve to the signal messaging when ice candidate gathering is complete.
    return this._signalPromise ||= new Promise((resolve, reject) => this._signalReady = {resolve, reject});
  }
  set signals(data) { // Set with the signals received from the other end.
    data.forEach(([type, message]) => this[type](message));
  }
  onLocalIceCandidate(event) {
    // Each wrtc implementation has its own ideas as to what ice candidates to try before emitting them in icecanddiate.
    // Most will try things that cannot be reached, and give up when they hit the OS network timeout. Forty seconds is a long time to wait.
    // If the wrtc is still waiting after our iceTimeout (2 seconds), lets just go with what we have.
    this.timer ||= setTimeout(() => this.onLocalEndIce(), this.iceTimeout);
    super.onLocalIceCandidate(event);
  }
  clearIceTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }
  async onLocalEndIce() { // Resolve the promise with what we've been gathering.
    this.clearIceTimer();
    if (!this._signalPromise) {
      //this.logError('ice', "End of ICE without anything waiting on signals."); // Not helpful when there are three ways to receive this message.
      return;
    }
    this._signalReady.resolve(this.sending);
    this.sending = [];
  }
  sending = [];
  signal(type, message) {
    super.signal(type, message);
    this.sending.push([type, message]);
  }
  // We need to know if there are open data channels. There is a proposal and even an accepted PR for RTCPeerConnection.getDataChannels(),
  // https://github.com/w3c/webrtc-extensions/issues/110
  // but it hasn't been deployed everywhere yet. So we'll need to keep our own count.
  // Alas, a count isn't enough, because we can open stuff, and the other side can open stuff, but if it happens to be
  // the same "negotiated" id, it isn't really a different channel. (https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/datachannel_event
  dataChannels = new Map();
  reportChannels() { // Return a report string useful for debugging.
    const entries = Array.from(this.dataChannels.entries());
    const kv = entries.map(([k, v]) => `${k}:${v.id}`);
    return `${this.dataChannels.size}/${kv.join(', ')}`;
  }
  noteChannel(channel, source, waiting) { // Bookkeep open channel and return it.
    // Emperically, with multiplex false: //   18 occurrences, with id=null|0|1 as for eventchannel or createDataChannel
    //   Apparently, without negotiation, id is initially null (regardless of options.id), and then assigned to a free value during opening
    const key = channel.label; //fixme channel.id === null ? 1 : channel.id;
    const existing = this.dataChannels.get(key);
    this.log('got data-channel', source, key, 'existing:', existing, 'waiting:', waiting);
    this.dataChannels.set(key, channel);
    channel.addEventListener('close', event => { // Close whole connection when no more data channels or streams.
      this.dataChannels.delete(key);
      // If there's nothing open, close the connection.
      if (this.dataChannels.size) return;
      if (this.peer.getSenders().length) return;
      this.close();
    });
    return channel;
  }
  createDataChannel(label = "data", channelOptions = {}) { // Promise resolves when the channel is open (which will be after any needed negotiation).
    return new Promise(resolve => {
      this.log('create data-channel', label, channelOptions);
      let channel = this.peer.createDataChannel(label, channelOptions);
      this.noteChannel(channel, 'explicit'); // Noted even before opened.
      // The channel may have already been opened on the other side. In this case, all browsers fire the open event anyway,
      // but wrtc (i.e., on nodeJS) does not. So we have to explicitly check.
      switch (channel.readyState) {
      case 'open':
	setTimeout(() => resolve(channel), 10);
	break;
      case 'connecting':
	channel.onopen = _ => resolve(channel);
	break;
      default:
	throw new Error(`Unexpected readyState ${channel.readyState} for data channel ${label}.`);
      }
    });
  }
  waitingChannels = {};
  getDataChannelPromise(label = "data") { // Resolves to an open data channel.
    return new Promise(resolve => {
      this.log('promise data-channel', label);
      this.waitingChannels[label] = resolve;
    });
  }
  resetPeer() { // Reset a 'connected' property that promised to resolve when opened, and track incoming datachannels.
    super.resetPeer();
    this.connected = new Promise(resolve => { // this.connected is a promise that resolves when we are.
      this.peer.addEventListener('connectionstatechange', event => {
	if (this.peer.connectionState === 'connected') {
	  resolve(true);
	}
      });
    });
    this.peer.addEventListener('datachannel', event => { // Resolve promise made with getDataChannelPromise().
      const channel = event.channel;
      const label = channel.label;
      const waiting = this.waitingChannels[label];
      this.noteChannel(channel, 'datachannel event', waiting); // Regardless of whether we are waiting.
      if (!waiting) return; // Might not be explicitly waiting. E.g., routers.
      delete this.waitingChannels[label];
      waiting(channel);
    });
  }
  close() {
    if (this.peer.connectionState === 'failed') this._signalPromise?.reject?.();
    super.close();
    this.clearIceTimer();
    this._signalPromise = this._signalReady = null;
    this.sending = [];
    // If the webrtc implementation closes the data channels before the peer itself, then this.dataChannels will be empty.
    // But if not (e.g., status 'failed' or 'disconnected' on Safari), then let us explicitly close them so that Synchronizers know to clean up.
    for (const channel of this.dataChannels.values()) {
      if (channel.readyState !== 'open') continue; // Keep debugging sanity.
      // It appears that in Safari (18.5) for a call to channel.close() with the connection already internall closed, Safari
      // will set channel.readyState to 'closing', but NOT fire the closed or closing event. So we have to dispatch it ourselves.
      //channel.close();
      channel.dispatchEvent(new Event('close'));
    }
  }
}

// Negotiated channels use specific integers on both sides, starting with this number.
// We do not start at zero because the non-negotiated channels (as used on server relays) generate their
// own ids starting with 0, and we don't want to conflict.
// The spec says these can go to 65,534, but I find that starting greater than the value here gives errors.
const BASE_CHANNEL_ID = 1000;
class SharedWebRTC extends PromiseWebRTC {
  static connections = new Map();
  static ensure({serviceLabel, multiplex = true, ...rest}) {
    let connection = this.connections.get(serviceLabel);
    // It is possible that we were backgrounded before we had a chance to act on a closing connection and remove it.
    if (connection) {
      const {connectionState, signalingState} = connection.peer;
      if ((connectionState === 'closed') || (signalingState === 'closed')) connection = null;
    }
    if (!connection) {
      connection = new this({label: serviceLabel, uuid: uuid4(), multiplex, ...rest});
      if (multiplex) this.connections.set(serviceLabel, connection);
    }
    return connection;
  }
  channelId = BASE_CHANNEL_ID;
  get hasStartedConnecting() {
    return this.channelId > BASE_CHANNEL_ID;
  }
  close(removeConnection = true) {
    this.channelId = BASE_CHANNEL_ID;
    super.close();
    if (removeConnection) this.constructor.connections.delete(this.serviceLabel);
  }
  async ensureDataChannel(channelName, channelOptions = {}, signals = null) { // Return a promise for an open data channel on this connection.
    const hasStartedConnecting = this.hasStartedConnecting; // Must ask before incrementing id.
    const id = this.channelId++; // This and everything leading up to it must be synchronous, so that id assignment is deterministic.
    const negotiated = (this.multiplex === 'negotiated') && hasStartedConnecting;
    const allowOtherSideToCreate = !hasStartedConnecting /*!negotiated*/ && !!signals; // Only the 0th with signals waits passively.
    // signals is either nullish or an array of signals, but that array can be EMPTY,
    // in which case the real signals will have to be assigned later. This allows the data channel to be started (and to consume
    // a channelId) synchronously, but the promise won't resolve until the real signals are supplied later. This is
    // useful in multiplexing an ordered series of data channels on an ANSWER connection, where the data channels must
    // match up with an OFFER connection on a peer. This works because of the wonderful happenstance that answer connections
    // getDataChannelPromise (which doesn't require the connection to yet be open) rather than createDataChannel (which would
    // require the connection to already be open).
    const useSignals = !hasStartedConnecting && signals?.length;
    const options = negotiated ? {id, negotiated, ...channelOptions} : channelOptions;
    if (hasStartedConnecting) {
      await this.connected; // Before creating promise.
    } else if (useSignals) {
      this.signals = signals;
    }
    const promise = allowOtherSideToCreate ?
	  this.getDataChannelPromise(channelName) :
	  this.createDataChannel(channelName, options);
    return await promise;
  }
}

var name$1 = "@kilroy-code/flexstore";
var version$1 = "0.0.46x";
var _package = {
	name: name$1,
	version: version$1};

// name/version of "database"
const storageName = 'flexstore';
const storageVersion = 7;
const {name, version} = _package;

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

  Naming conventions:

  mumbleName: a semantic name used externally as a key. Example: serviceName, channelName, etc.
    When things need to match up across systems, it is by name.
    If only one of name/label is specified, this is usually the the one.

  mumbleLabel: a label for identification and internally (e.g., database name).
    When two instances of something are "the same" but are in the same Javascript image for testing, they are distinguished by label.
    Typically defaults to mumbleName.

  Note, though, that some external machinery (such as a WebRTC DataChannel) has a "label" property that we populate with a "name" (channelName).
 */
class Synchronizer {
  constructor({serviceName = 'direct', collection, error = collection?.constructor.error || console.error,
	       serviceLabel = collection?.serviceLabel || serviceName, // Used to identify any existing connection. Can be different from serviceName during testing.
	       channelName, uuid, rtcConfiguration, connection, // Complex default behavior for these. See code.
	       multiplex = collection?.multiplex, // If specifed, otherwise undefined at this point. See below.
	       debug = collection?.debug, minVersion = storageVersion, maxVersion = minVersion}) {
    // serviceName is a string or object that identifies where the synchronizer should connect. E.g., it may be a URL carrying
    //   WebRTC signaling. It should be app-unique for this particular service (e.g., which might multiplex data for multiple collection instances).
    // uuid help uniquely identifies this particular synchronizer.
    //   For most purposes, uuid should get the default, and refers to OUR end.
    //   However, a server that connects to a bunch of peers might bash in the uuid with that of the other end, so that logging indicates the client.
    // If channelName is specified, it should be in the form of collectionType/collectionName (e.g., if connecting to relay).
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
    connection ??= SharedWebRTC.ensure({serviceLabel, configuration: rtcConfiguration, multiplex, debug, error});

    uuid ??= connection.uuid;
    // Both peers must agree on channelName. Usually, this is collection.fullName. But in testing, we may sync two collections with different names.
    channelName ??= collection?.channelName || collection.fullName;
    const label = `${collection?.fullLabel || channelName}/${uuid}`;
    // Where we can request a data channel that pushes put/delete requests from others.
    const connectionURL = serviceName.includes?.('/signal/') ? serviceName : `${serviceName}/${label}`;

    Object.assign(this, {serviceName, label, collection, debug, error, minVersion, maxVersion, uuid, rtcConfiguration,
			 connection, uuid, channelName, connectionURL,
			 connectionStartTime: Date.now(),
			 closed: this.makeResolveablePromise(),
			 // Not used yet, but could be used to GET resources over http instead of through the data channel.
			 hostRequestBase: connectThroughInternet && `${serviceName.replace(/\/(sync|signal)/)}/${channelName}`});
    collection?.synchronizers.set(serviceName, this); // Must be set synchronously, so that collection.synchronize1 knows to wait.
  }
  static async create(collection, serviceName, options = {}) { // Receive pushed messages from the given service. get/put/delete when they come (with empty services list).
    const synchronizer = new this({collection, serviceName, ...options});
    const connectedPromise = synchronizer.connectChannel(); // Establish channel creation order.
    const connected = await connectedPromise;
    if (!connected) return synchronizer;
    return await connected.synchronize();
  }
  async connectChannel() { // Synchronously initialize any promises to create a data channel, and then await connection.
    const {hostRequestBase, uuid, connection, serviceName} = this;
    let started = connection.hasStartedConnecting;
    if (started) {
      // We already have a connection. Just open another data channel for our use.
      started = this.dataChannelPromise = connection.ensureDataChannel(this.channelName);
    } else if (this.connectionURL.includes('/signal/answer')) { // Post an answer to an offer we generate for a rendevous peer.
      started = this.connectServer(); // Just like a sync
    } else if (this.connectionURL.includes('/signal/offer')) { // Get an offer from a rendevous peer and post an answer.
      // We must sychronously startConnection now so that our connection hasStartedConnecting, and any subsequent data channel
      // requests on the same connection will wait (using the 'started' path, above).
      const promisedSignals = this.startConnection([]); // Establishing order.
      const url = this.connectionURL;
      const offer = await this.fetch(url);
      this.completeConnection(offer); // Now supply those signals so that our connection can produce answer sigals.
      started = this.fetch(url, await promisedSignals); // Tell the peer about our answer.
    } else if (this.connectionURL.includes('/sync')) { // Connect with a server relay. (Signal and stay connected through sync.)
      started = this.connectServer();
    } else if (serviceName === 'signals') { // Start connection and return null. Must be continued with completeSignalsSynchronization();
      started = this.startConnection();
      return null;
    } else if (Array.isArray(serviceName)) { // A list of "receiving" signals.
      started = this.startConnection(serviceName);
    } else if (serviceName.synchronizers) { // Duck typing for passing a collection directly as the serviceInfo. (We don't import Collection.)
      started = this.connectDirectTesting(serviceName); // Used in testing.
    } else {
      throw new Error(`Unrecognized service format: ${serviceName}.`);
    }
    if (!(await started)) {
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
  channelClosedCleanup() { // Bookkeeping when channel closed or explicitly abandoned before opening.
    this.collection?.synchronizers.delete(this.serviceName);
    this.closed.resolve(this); // Resolve to synchronizer is nice if, e.g, someone is Promise.racing.
  }
  set dataChannelPromise(promise) { // Set up message and close handling.
    this._dataChannelPromise = promise.then(dataChannel => {
      dataChannel.onmessage = event => this.receive(event.data);
      dataChannel.onclose = async event => this.channelClosedCleanup();
      return dataChannel;
    });
  }
  async synchronize() {
    await this.dataChannelPromise;
    await this.startedSynchronization;
    return this;
  }
  static fragmentId = 0;
  async send(method, ...params) { // Sends to the peer, over the data channel
    // TODO: break up long messages. (As a practical matter, 16 KiB is the longest that can reliably be sent across different wrtc implementations.)
    // See https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels#concerns_with_large_messages
    const payload = JSON.stringify({method, params});
    const dataChannel = await this.dataChannelPromise;
    const state = dataChannel?.readyState || 'closed';
    if (state === 'closed' || state === 'closing') return;
    this.log('sends', method, ...params);
    const size = 16e3; // A bit less than 16 * 1024.
    if (payload.length < size) {
      dataChannel.send(payload);
      return;
    }
    const numChunks = Math.ceil(payload.length / size);
    const id = this.constructor.fragmentId++;
    const meta = {method: 'fragments', params: [id, numChunks]};
    //console.log(`Fragmenting message ${id} into ${numChunks} chunks.`, meta);
    dataChannel.send(JSON.stringify(meta));
    // Optimization opportunity: rely on messages being ordered and skip redundant info. Is it worth it?
    for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
      const frag = {method: 'frag', params: [id, i, payload.substr(o, size)]};
      dataChannel.send(JSON.stringify(frag));
    }
  }
  receive(text) { // Dispatch a message sent over the data channel from the peer.
    const {method, params} = JSON.parse(text);
    this[method](...params);
  }
  pendingFragments = {};
  fragments(id, numChunks) {
    //console.log(`Receiving mesage ${id} in ${numChunks}.`);
    this.pendingFragments[id] = {remaining: numChunks, message: Array(numChunks)};
  }
  frag(id, i, fragment) {
    let frag = this.pendingFragments[id]; // We are relying on fragment message coming first.
    frag.message[i] = fragment;
    if (0 !== --frag.remaining) return;
    //console.log(`Dispatching message ${id}.`);
    this.receive(frag.message.join(''));
    delete this.pendingFragments[id];
  }

  async disconnect() { // Wait for dataChannel to drain and return a promise to resolve when actually closed,
    // but return immediately if connection not started.
    if (this.connection.peer.connectionState !== 'connected') return this.channelClosedCleanup(this.connection.close());
    const dataChannel = await this.dataChannelPromise;
    dataChannel.close();
    return this.closed;
  }
  // TODO: webrtc negotiation needed during sync.
  // TODO: webrtc negotiation needed after sync.
  startConnection(signalMessages) { // Machinery for making a WebRTC connection to the peer:
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

  async fetch(url, body = null) { // As JSON
    const method = body ? 'POST' : 'GET';
    if (this.debug) this.log(method, 'signals', url, JSON.stringify(body, null, 2)); // TODO: stringify in log instead of needing to guard with this.debug.
    const request = await fetch(url, body ? {method, headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {method})
	  .catch(error => this.error(`${error.message} for ${url}`));
    if (!request) return null;
    if (!request.ok) {
      this.error(`${request?.statusText || 'Error'}, code ${request.status || 'unknown'}, in fetch ${url}.`);
      return null;
    }
    const result = await request.json();
    if (this.debug) this.log(method, 'responseSignals', url, JSON.stringify(result, null, 2));
    return result;
  }
  async connectServer(url = this.connectionURL) { // Connect to a relay over http. Compare connectRendevous
    // startConnection, post it, completeConnection with the response.
    // Our webrtc synchronizer is then connected to the relay's webrt synchronizer.
    const ourSignalsPromise = this.startConnection(); // must be synchronous to preserve channel id order.
    const ourSignals = await ourSignalsPromise;
    const theirSignals = await this.fetch(url, ourSignals);
    try {
      return this.completeConnection(theirSignals);
    } catch(error) {
      throw new Error(`While connecting ${url}, our signals: ${JSON.stringify(ourSignals)}, their signals: ${JSON.stringify(theirSignals)}.`, error);
    }  }
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
    const ourSignals = this.startConnection();
    const theirSignals = await peerSynchronizer.startConnection(await ourSignals);
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
    return versionPromise.resolve(0);
  }
  get version() { // Promise the highest version suported by both sides, or disconnect and falsy if none.
    // Tells the other side our versions if we haven't yet done so.
    // FIXME: can we avoid this timeout?
    return this._version ||= this.makeResolveablePromise(setTimeout(() => this.send('versions', this.minVersion, this.maxVersion), 200));
  }

  get startedSynchronization() { // Promise that resolves when we have started synchronization.
    return this._startedSynchronization ||= this.startSynchronization();
  }
  get completedSynchronization() { // Promise that resolves to the number of items that were transferred (not necessarilly written).
    // Starts synchronization if it hasn't already. E.g., waiting on completedSynchronization won't resolve until after it starts.
    return this._completedSynchronization ||= this.makeResolveablePromise(this.startedSynchronization);
  }
  get peerCompletedSynchronization() { // Promise that resolves to the number of items that the peer synchronized.
    return this._peerCompletedSynchronization ||= this.makeResolveablePromise();
  }
  get bothSidesCompletedSynchronization() { // Promise resolves truthy when both sides are done.
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
    // Now that we are connected, any new writes on our end will be pushed to the peer. So capture the initial tags now.
    const ourTags = new Set(await this.collection.tags);
    await this.reportConnection();
    Object.assign(this, {

      // A snapshot Set of each tag we have locally, captured at the moment of creation.
      ourTags, // (New local writes are pushed to the connected peer, even during synchronization.)

      // Map of tag to promise for tags that are being synchronized.
      // ensureSynchronizedTag ensures that there is an entry here during the time a tag is in flight.
      unsynchronized: new Map(),

      // Set of what tags have been explicitly synchronized, meaning that there is a difference between their hash
      // and ours, such that we ask for their signature to compare in detail. Thus this set may include items that
      checkedTags: new Set(), // will not end up being replaced on our end.

      endOfPeerTags: false // Is the peer finished streaming?
    });
    // Now negotiate version and collects the tags.
    const version = await this.version;
    const {minVersion, maxVersion} = this;
    if (!version) {
      await this.disconnect();
      const message = `This software expects data versions from ${minVersion} to ${maxVersion}. Try reloading twice.`;
      if (typeof(window) !== 'undefined') window.alert(message);
      return;
    }
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
  synchronizationComplete(nChecked) { // The peer has finished getting all the data it needs from us.
    this.peerCompletedSynchronization.resolve(nChecked);
  }
  cleanUpIfFinished() { // If we are not waiting for anything, we're done. Clean up.
    // This requires that the peer has indicated that it is finished streaming tags,
    // and that we are not waiting for any further unsynchronized items.
    if (!this.endOfPeerTags || this.unsynchronized.size) return;
    const nChecked = this.checkedTags.size; // The number that we checked.
    this.send('synchronizationComplete', nChecked);
    this.checkedTags.clear();
    this.unsynchronized.clear();
    this.ourTags = this.synchronized = this.unsynchronized = null;
    console.info(this.label, 'completed synchronization', nChecked, 'items in', ((Date.now() - this.synchronizationStartTime)/1e3).toFixed(1), 'seconds');
    this.completedSynchronization.resolve(nChecked);
  }
  synchronizationPromise(tag) { // Return something to await that resolves when tag is synchronized.
    // Whenever a collection needs to retrieve (getVerified) a tag or find tags matching properties, it ensures
    // the latest data by calling this and awaiting the data.
    if (!this.unsynchronized) return true; // We are fully synchronized all tags. If there is new data, it will be spontaneously pushed to us.
    if (this.checkedTags.has(tag)) return true; // This particular tag has been checked.
      // (If checkedTags was only those exchanged or written, we would have extra flights checking.)
    // If a request is in flight, return that promise. Otherwise create one.
    return this.unsynchronized.get(tag) || this.ensureSynchronizedTag(tag, '', this.getHash(tag));
  }

  async hash(tag, hash) { // Receive a [tag, hash] that the peer knows about. (Peer streams zero or more of these to us.)
    // Unless already in flight, we will ensureSynchronizedTag to synchronize it.
    await this.startedSynchronization;
    const {ourTags, unsynchronized} = this;
    this.log('received "hash"', {tag, hash, ourTags, unsynchronized});
    if (unsynchronized.has(tag)) return null; // Already has an investigation in progress (e.g, due to local app synchronizationPromise).
    if (!ourTags.has(tag)) return this.ensureSynchronizedTag(tag, hash); // We don't have the record at all.
    return this.ensureSynchronizedTag(tag, hash, this.getHash(tag));
  }
  ensureSynchronizedTag(tag, theirHash = '', ourHashPromise = null) {
    // Synchronously record (in the unsynchronized map) a promise to (conceptually) request the tag from the peer,
    // put it in the collection, and cleanup the bookkeeping. Return that promise.
    // However, if we are given hashes to compare and they match, we can skip the request/put and remove from unsychronized on next tick.
    // (This must return atomically because caller has checked various bookkeeping at that moment. Checking may require that we await ourHashPromise.)
    const promise = new Promise(resolve => {
      setTimeout(async () => { // Next tick. See request().
	if (!theirHash || !ourHashPromise || (theirHash !== await ourHashPromise)) {
	  const theirData = await this.request(tag);
	  // Might have been triggered by our app requesting this tag before we were sync'd. So they might not have the data.
	  if (!theirHash || theirData?.length) {
	    if (await this.collection.put(tag, theirData, this)) {
	      this.log('received/put', tag, 'their/our hash:', theirHash || 'missingTheirs', (await ourHashPromise) || 'missingOurs', theirData?.length);
	    } else {
	      this.log('unable to put', tag);
	    }
	  }
	}
	this.checkedTags.add(tag);       // Everything we've examined, regardless of whether we asked for or saved data from peer. (See synchronizationPromise)
	this.unsynchronized.delete(tag); // Unconditionally, because we set it unconditionally.
	this.cleanUpIfFinished();
	resolve();
      });
    });
    this.unsynchronized.set(tag, promise); // Unconditionally, in case we need to know we're looking during the time we're looking.
    return promise;
  }
  request(tag) { // Make a request for tag from the peer, and answer a promise the resolves with the data.
    /*const { hostRequestBase } = this;
    if (hostRequestBase) {
      // E.g., a localhost router might support a get of http://localhost:3000/flexstore/MutableCollection/com.ki1r0y.whatever/_t/uL/BAcW_LNAJa/cJWmumble
      // So hostRequestBase should be "http://localhost:3000/flexstore/MutableCollection/com.ki1r0y.whatever",
      // and serviceName should be something like "http://localhost:3000/flexstore/sync"
      return fetch(tagPath(hostRequestBase, tag)).then(response => response.text());
    }*/
    const promise = this.makeResolveablePromise(this.send('get', tag));
    // Subtle: When the 'put' comes back, we will need to resolve this promise. But how will 'put' find the promise to resolve it?
    // As it turns out, to get here, we have necessarilly set tag in the unsynchronized map. 
    const noted = this.unsynchronized.get(tag); // A promise that does not have an exposed .resolve, and which does not expect any value.
    noted.resolve = promise.resolve; // Tack on a resolve for OUR promise onto the noted object (which confusingly, happens to be a promise).
    return promise;
  }
  async get(tag) { // Respond to a peer's get() request by sending a put reponse with the data.
    const data = await this.collection.get(tag);
    this.push('put', tag, data);
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

class Cache extends Map{constructor(e,t=0){super(),this.maxSize=e,this.defaultTimeToLive=t,this._nextWriteIndex=0,this._keyList=Array(e),this._timers=new Map;}set(e,t,s=this.defaultTimeToLive){let i=this._nextWriteIndex;this.delete(this._keyList[i]),this._keyList[i]=e,this._nextWriteIndex=(i+1)%this.maxSize,this._timers.has(e)&&clearTimeout(this._timers.get(e)),super.set(e,t),s&&this._timers.set(e,setTimeout((()=>this.delete(e)),s));}delete(e){return this._timers.has(e)&&clearTimeout(this._timers.get(e)),this._timers.delete(e),super.delete(e)}clear(e=this.maxSize){this.maxSize=e,this._keyList=Array(e),this._nextWriteIndex=0,super.clear();for(const e of this._timers.values())clearTimeout(e);this._timers.clear();}}class StorageBase{constructor({name:e,baseName:t="Storage",maxSerializerSize:s=1e3,debug:i=false}){const a=`${t}/${e}`,r=new Cache(s);Object.assign(this,{name:e,baseName:t,fullName:a,debug:i,serializer:r});}async list(){return this.serialize("",((e,t)=>this.listInternal(t,e)))}async get(e){return this.serialize(e,((e,t)=>this.getInternal(t,e)))}async delete(e){return this.serialize(e,((e,t)=>this.deleteInternal(t,e)))}async put(e,t){return this.serialize(e,((e,s)=>this.putInternal(s,t,e)))}log(...e){this.debug&&console.log(this.name,...e);}async serialize(e,t){const{serializer:s,ready:i}=this;let a=s.get(e)||i;return a=a.then((async()=>t(await this.ready,this.path(e)))),s.set(e,a),await a}}const{Response:e,URL:t}=globalThis;class StorageCache extends StorageBase{constructor(...e){super(...e),this.stripper=new RegExp(`^/${this.fullName}/`),this.ready=caches.open(this.fullName);}async listInternal(e,t){return (await t.keys()||[]).map((e=>this.tag(e.url)))}async getInternal(e,t){const s=await t.match(e);return s?.json()}deleteInternal(e,t){return t.delete(e)}putInternal(t,s,i){return i.put(t,e.json(s))}path(e){return `/${this.fullName}/${e}`}tag(e){return new t(e).pathname.replace(this.stripper,"")}destroy(){return caches.delete(this.fullName)}}

const { CustomEvent, EventTarget, TextDecoder } = globalThis;

class Collection extends EventTarget {

  constructor({name, label = name, services = [], preserveDeletions = !!services.length,
	       persistenceClass = StorageCache, dbVersion = storageVersion, persistenceBase = `${storageName}_${dbVersion}`,
	       debug = false, multiplex, // Causes synchronization to reuse connections for different Collections on the same service.
	       channelName, serviceLabel}) {
    super();
    Object.assign(this, {name, label, preserveDeletions, persistenceClass, dbVersion, multiplex, debug, channelName, serviceLabel,
			 fullName: `${this.constructor.name}/${name}`, fullLabel: `${this.constructor.name}/${label}`});
    this.synchronize(...services);
    const persistenceOptions = {name: this.fullLabel, baseName: persistenceBase, debug: debug};
    if (persistenceClass.then) this.persistenceStore = persistenceClass.then(kind => new kind(persistenceOptions));
    else this.persistenceStore = new persistenceClass(persistenceOptions);
  }

  async close() {
    await (await this.persistenceStore).close();
  }
  async destroy() {
    await (await this.persistenceStore).destroy();
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
  static async verifiedSign(data, signingOptions, tag = null) { // Sign, but return a validation (as though by immediately validating).
    // TODO: assemble this more cheaply?
    const signature = await this.sign(data, signingOptions);
    return this.validationFormat(signature, tag);
  }
  static async validationFormat(signature, tag = null) {
    //console.log({type: typeof(signature), signature, tag});
    const verified = await this.verify(signature);
    //console.log({verified});
    const sub = verified.subjectTag = verified.protectedHeader.sub;
    verified.tag = tag || sub;
    return verified;
  }

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
  _canonicalizeOptions(objectOrString = {}) {
    if (typeof(objectOrString) === 'string') objectOrString = {tag: objectOrString};
    const {owner:team = Credentials.owner, author:member = Credentials.author,
	   tag,
	   encryption = Credentials.encryption,
	   time = Date.now(),
	   ...rest} = objectOrString;
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
    const signature = await this.constructor.sign(data, signingOptions);
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
    const signature = await this.constructor.sign(data, signingOptions);
    tag = await this.delete(tag, signature);
    if (!tag) return this.fail('store', data, signingOptions.member || signingOptions.tags[0]);
    await this.push('delete', tag, signature);
    return tag;
  }
  async retrieve(tagOrOptions) { // getVerified and maybe decrypt. Has more complex behavior in subclass VersionedCollection.
    const {tag, decrypt = true, ...options} = tagOrOptions.tag ? tagOrOptions : {tag: tagOrOptions};
    const verified = await this.getVerified({tag, ...options});
    if (!verified) return '';
    if (decrypt) return await this.constructor.ensureDecrypted(verified);
    return verified;
  }
  async getVerified(tagOrOptions) { // synchronize, get, and verify (but without decrypt)
    const {tag, synchronize = true, ...verifyOptions} = tagOrOptions.tag ? tagOrOptions: {tag: tagOrOptions};
    if (synchronize) await this.synchronize1(tag);
    const signature = await this.get(tag);
    if (!signature) return signature;
    return this.constructor.verify(signature, verifyOptions);
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
  async put(tag, signature, synchronizer = null, mergeAuthorOverride = null) { // Put the raw signature locally and on the specified services.
    // mergeSignatures() MAY create new new results to save, that still have to be signed. For testing, we sometimes
    // want to behave as if some owner credential does not exist on the machine. That's what mergeAuthorOverride is for.

    // TODO: do we need to queue these? Suppose we are validating or merging while other request arrive?
    const validation = await this.validateForWriting(tag, signature, 'store', synchronizer);
    this.log('put', {tag: validation?.tag || tag, synchronizer: synchronizer?.label, json: validation?.json});
    if (!validation) return undefined;
    await this.addTag(validation.tag);

    // fixme next
    const merged = await this.mergeSignatures(tag, validation, signature, mergeAuthorOverride);
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
  synchronizeAntecedent(tag, antecedent) { // Should the antecedent try synchronizing before getting it?
    return tag !== antecedent; // False when they are the same tag, as that would be circular. Versions do sync.
  }
  // TODO: is this needed any more?
  async validateForWriting(tag, signature, operationLabel, synchronizer, requireTag = false) {
    // A deep verify that checks against the existing item's (re-)verified headers.
    // If it succeeds, this is also the common code (between put/delete) that emits the update event.
    const validationOptions = synchronizer ? {member: null} : {}; // Could be old data written by someone who is no longer a member.
    const verified = await this.constructor.verify(signature, validationOptions);
    if (!verified) return this.notifyInvalid(tag, operationLabel, 'invalid', verified, signature);
    verified.synchronizer = synchronizer;
    tag = verified.tag = verified.subjectTag = requireTag ? tag : await this.tagForWriting(tag, verified);
    const antecedent = this.antecedent(verified);
    const synchronize = this.synchronizeAntecedent(tag, antecedent);
    const existingVerified = verified.existing = antecedent && await this.getVerified({tag: antecedent, synchronize});
    const disallowed = await this.disallowWrite(tag, existingVerified?.protectedHeader, verified?.protectedHeader, verified);
    if (disallowed) return this.notifyInvalid(tag, operationLabel, disallowed, verified);
    this.log('emit', tag, verified.json);
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

class ImmutableCollection extends Collection {
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
class MutableCollection extends Collection {
  tagForWriting(tag, validation) { // Use tag if specified, but defaults to hash.
    return tag || validation.protectedHeader.sub;
  }
}

// Each VersionedCollection has a set of hash-identified immutable items that form the individual versions, and a map of timestamps to those items.
// We currently model this by having the main collection be the mutable map, and the versions instance variable is the immutable items collection.
// But apps store/retrieve individual items through the main collection, and the corresponding updates are through the versions, which is a bit awkward.

// Each item has an antecedent that is not part of the application-supplied payload -- it lives in the signature's header.
// However:
// - The tag DOES include the antecedent, even though it is not part of the payload. This makes identical payloads have
//   unique tags (because they will always have different antecedents).
// - The ability to write follows the same rules as MutableCollection (latest wins), but is tested against the
//   antecedent tag instead of the tag being written.
class VersionCollection extends MutableCollection { // Needs to be exported so that that router.mjs can find it.
  async tagForWriting(tag, validation) { // Use tag if specified (e.g., put/delete during synchronization), othwerwise reflect both sub and antecedent.
    if (tag) return tag;
    // Each version gets a unique tag (even if there are two versions that have the same data payload).
    const ant = validation.protectedHeader.ant;
    const payloadText = validation.text || new TextDecoder().decode(validation.payload);
    return Credentials.encodeBase64url(await Credentials.hashText(ant + payloadText));
  }
  antecedent(validation) { // Returns the tag that validation compares against. E.g., do the owners match?
    // For non-versioned collections, we compare against the existing data at the same tag being written.
    // For versioned collections, it is what exists as the latest version when the data is signed, and which the signature
    // records in the signature. (For the very first version, the signature will note the timestamp as the antececdent tag,
    // (see tagForWriting), but for comparing against, this method answers falsy for the first in the chain.
    const header = validation?.protectedHeader;
    if (!header) return '';
    const antecedent = header.ant;
    if (typeof(antecedent) === 'number') return ''; // A timestamp as antecedent is used to to start things off. No true antecedent.
    return antecedent;
  }
  async subjectMatch(verified) { // Here sub refers to the overall item tag that encompasses all versions, not the payload hash.
    return true; // TODO: make sure it matches previous?
  }
  emit(verified) { // subjectTag (i.e., the tag within the collection as a whole) is not the tag/hash.
    verified.subjectTag = verified.protectedHeader.sub;
    super.emit(verified);
  }
}

class VersionedCollection extends MutableCollection {
  // TODO: This works and demonstrates having a collection using other collections.
  // However, having a big timestamp => fixnum map is bad for performance as the history gets longer.
  // This should be split up into what is described in versioned.md.
  constructor({services = [], ...rest} = {}) {
    super(rest);  // Without passing services yet, as we don't have the versions collection set up yet.
    this.versions = new VersionCollection(rest); // Same collection name, but different type.
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
  recoverTag(verified) { // the verified.tag is for the version. We want the overall one.
    return Object.assign({}, verified, {tag: verified.protectedHeader.sub}); // Do not bash verified!
  }
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
    return super.synchronized.then(() => this.versions.synchronized);
  }
  get itemEmitter() { // The versions collection emits an update corresponding to the individual item stored.
    // (The updates emitted from the whole mutable VersionedCollection correspond to the map.)
    return this.versions;
  }

  async getVersions(tag) { // Promises the parsed timestamp => version dictionary IF it exists, else falsy.
    this.requireTag(tag);
    const verified = await this.getVerified({tag});
    const json = verified?.json;
    if (!Array.isArray(json)) return json;
    // If we have an unmerged array of signatures...
    // I'm not sure that it's very useful to applications for us to handle this case, but it is nice to exercise this in testing.
    const verificationsArray = await this.ensureExpanded(verified);
    return this.combineTimestamps(tag, null, ...verificationsArray.map(v => v.json));
  }
  async retrieveTimestamps(tag) { // Promises a list of all version timestamps.
    const versions = await this.getVersions(tag);
    if (!versions) return versions;
    return Object.keys(versions).slice(1).map(string => parseInt(string)); // TODO? Map these to integers?
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
  async retrieve(tagOrOptions) { // Answer the validated version in force at the specified time (or latest), or at the specific hash.
    let {tag, time, hash, ...rest} = (!tagOrOptions || tagOrOptions.length) ? {tag: tagOrOptions} : tagOrOptions;
    if (!hash) {
      const timestamps = await this.getVersions(tag);
      if (!timestamps) return timestamps;
      hash = this.getActiveHash(timestamps, time);
      if (!hash) return '';
    }
    return this.versions.retrieve({tag: hash, ...rest});
  }
  async store(data, options = {}) { // Determine the antecedent, record it in the signature, and store that
    // as the appropriate version hash. Then record the new timestamp/hash in the timestamps list.
    let versions,
	// TODO: Consider encrypting the timestamps, too.
	// Currently, signingOptions for the timestamps does NOT enclude encryption, even if specified for the actual specific version info.
	// This means that if the application specifies an encrypted versioned collection, the data itself will be encrypted, but
	// not the map of timestamps to hashes, and so a lurker can see when there was activitity and have an idea as to the size.
	// Of course, even if encrypted, they could also get this from live traffic analysis, so maybe encrypting it would just
	// convey a false sense of security. Encrypting the timestamps does complicate, e.g., mergeSignatures() because
	// some of the work could only be done by relays that have access. But since we have to be careful about signing anyway,
	// we should theoretically be able to be accomodate that.
	{tag, encryption, ...signingOptions} = this._canonicalizeOptions(options),
	time = Date.now(),
	versionOptions = Object.assign({time, encryption}, signingOptions);
    if (tag) {
      versions = (await this.getVersions(tag)) || {};
      versionOptions.sub = tag;
      if (versions) {
	versionOptions.ant = versions[versions.latest];
      }
    } // Else do not assign sub. It will be set to the payload hash during signing, and also used for the overall tag.
    versionOptions.ant ||= time;
    const hash = await this.versions.store(data, versionOptions);
    if (!tag) { // We'll still need tag and versions.
      const versionSignature = await this.versions.get(hash);
      const claims = Credentials.decodeClaims(this.constructor.maybeInflate(versionSignature));
      tag = claims.sub;
      versions = {};
    }
    versions.latest = time;
    versions[time] = hash;

    // fixme next
    const signature = await this.constructor.sign(versions, signingOptions);
    // Here we are doing what this.put() would normally do, but we have already merged signatures.
    await this.addTag(tag);
    await this.persist(tag, signature);
    this.emit({tag, subjectTag: tag, ...(await this.constructor.verify(signature))});
    await this.push('put', tag, signature);
    // const verified = await this.constructor.verifiedSign(versions, signingOptions, tag);
    // this.log('put(-ish)', verified);
    // await this.persist2(verified);
    // await this.addTag(tag);
    // this.emit({...verified, tag, subjectTag: tag});
    // await this.push('put', tag, this.constructor.ensureString(verified.signature));

    return tag;
  }
  async remove(options = {}) { // Add an empty verion or remove all versions, depending on this.preserveDeletions.
    let {encryption, tag, ...signingOptions} = this._canonicalizeOptions(options); // Ignore encryption
    const versions = await this.getVersions(tag);
    if (!versions) return versions;
    if (this.preserveDeletions) { // Create a timestamp => version with an empty payload. Otherwise merging with earlier data will bring it back!
      await this.store('', signingOptions);
    } else { // Actually delete the timestamps and each version.
      // fixme next
      const versionTags = Object.values(versions).slice(1);
      const versionSignature = await this.constructor.sign('', {sub: tag, ...signingOptions});
      // TODO: Is this safe? Should we make a signature that specifies each antecedent?
      await Promise.all(versionTags.map(async tag => {
	await this.versions.delete(tag, versionSignature);
	await this.versions.push('delete', tag, versionSignature);
      }));
      const signature = await this.constructor.sign('', signingOptions);
      await this.persist(tag, signature, 'delete');
      await this.push('delete', tag, signature);
      // const versionHashes = Object.values(versions).slice(1);
      // const verified = await this.constructor.verifiedSign('', {sub: tag, ...signingOptions}, tag);
      // // TODO: Is this safe? Should we make a signature that specifies each antecedent?
      // await Promise.all(versionHashes.map(async hash => {
      // 	let vVerified = {...verified, tag: hash};
      // 	let sVerified = this.constructor.ensureString(vVerified.signature);
      // 	// await this.versions.deleteTag(tag);
      // 	// await this.versions.persist2(vVerified, 'delete');
      // 	// this.versions.emit(vVerified);
      // 	// await this.versions.push('delete', tag, sVerified);
      // 	await this.versions.delete(tag, sVerified);
      // 	await this.versions.push('delete', tag, sVerified)
      // }));
      // await this.persist2(verified, 'delete');
      // await this.push('delete', tag, this.constructor.ensureString(verified.signature));
    }
    await this.deleteTag(tag);
    return tag;
  }
  async mergeSignatures(tag, validation, signature, authorOverride = null) { // Merge the new timestamps with the old.
    // If previous doesn't exist or matches the next, or is a subset of the next, just use the next.
    // Otherwise, we have to merge:
    // - Merged must contain the union of values for either.
    //   (Since values are hashes of stuff with an explicit antedent, next previous nor next will have duplicates by themselves..)
    // - If there's a conflict in keys, create a new key that is midway between the conflict and the next key in order.

    let next = validation;
    let previous = validation.existing;
    //fixme next
    if (!previous) return signature;   // No previous, just use new signature.
    //if (!previous) return next;   // No previous, just next.

    // At this point, previous and next are both "outer" validations.
    // That json can be either a timestamp or an array of signatures.
    if (validation.protectedHeader.iat < validation.existing.protectedHeader.iat) { // Arrange for next and signature to be later one by signed timestamp.
      // TODO: is it possible to construct a scenario in which there is a fictitious time stamp conflict. E.g, if all of these are true:
      // 1. previous and next have identical timestamps for different values, and so we need to construct artificial times for one. Let's call these branch A and B.
      // 2. this happens with the same timestamp in a separate pair, which we'll call A2, and B2.
      // 3. A and B are merged in that order (e.g. the last time in A is less than B), but A2 and B2 are merged backwards (e.g., the last time in B2 is less thant A2),
      //    such that the overall merge creates a conflict?
      [previous, next] = [next, previous];
    }

    // Find the timestamps of previous whose VALUES that are not in next.
    let keysOfMissing = null;
    if (!Array.isArray(previous.json) && !Array.isArray(next.json)) { // No point in optimizing through missingKeys if that makes us combineTimestamps anyway.
      keysOfMissing = this.missingKeys(previous.json, next.json);
      // fixme next
      if (!keysOfMissing.length) return this.constructor.ensureString(next.signature); // Previous is a subset of new signature.
      //if (!keysOfMissing.length) return next; // Previous is a subset of new signature.
    }
    // TODO: return previous if next is a subset of it?

    // We cannot re-use one or other. Sign a new merged result.
    const previousValidations = await this.ensureExpanded(previous);
    const nextValidations = await this.ensureExpanded(next);
    // We can only truly merge if we are an owner.
    const header = previousValidations[0].protectedHeader;
    let owner = header.iss || header.kid;
    let isOwner = [Credentials.owner, Credentials.author, authorOverride].includes(owner);
    // If these are not the owner, and we were not given a specific override, then see if the user has access to the owner in this execution context.
    let canSign = isOwner || (!authorOverride && await Credentials.sign('', owner).catch(() => false));
    let merged, options, time = Date.now();
    const author = authorOverride || Credentials.author;
    function flatten(a, b) { return [].concat(a, b); }
    if (!canSign) { // We don't have owner and cannot get it.
      // Create a special non-standard "signature" that is really an array of signatures
      function getSignatures(validations) { return validations.map(validation => validation.signature); }
      merged = flatten(getSignatures(previousValidations), getSignatures(nextValidations));
      options = {tags: [author], time};
    } else {
      function getJSONs(validations) { return validations.map(validation => validation.json); }
      const flattened = flatten(getJSONs(previousValidations), getJSONs(nextValidations));
      merged = this.combineTimestamps(next.tag, keysOfMissing, ...flattened);
      options = {team: owner, member: author, time};
    }
    // fixme next
    return await this.constructor.sign(merged, options);
    //return await this.constructor.verifiedSign(merged, options);
  }
  ensureExpanded(validation) { // Promise an array of verifications (verifying elements of validation.json if needed).
    if (!Array.isArray(validation.json)) return [validation];
    return Promise.all(validation.json.map(signature => this.constructor.verify(signature)));
  }
  missingKeys(previousMapping, nextMappings) { // Answer a list of those keys from previous that do not have values in next.
    const nextValues = new Set(Object.values(nextMappings));
    return Object.keys(previousMapping).filter(key => key !== 'latest' && !nextValues.has(previousMapping[key]));
  }
  combineTimestamps(tag, keysOfMissing, previousMappings, nextMappings, ...rest) { // Return a merged dictionary of timestamp => hash, containing all of previous and nextMappings.
    // We'll need a new object to store the union, because the keys must be in time order, not the order they were added.
    keysOfMissing ||= this.missingKeys(previousMappings, nextMappings);
    const merged = {};
    let missingIndex = 0, missingTime, nextTimes;
    for (const nextTime in nextMappings) {
      missingTime = 0;

      // Merge any remaining keysOfMissing that come strictly before nextTime:
      if (nextTime !== 'latest') {
	for (; (missingIndex < keysOfMissing.length) && ((missingTime = keysOfMissing[missingIndex]) < nextTime); missingIndex++) {
	  merged[missingTime] = previousMappings[missingTime];
	}
      }

      if (missingTime === nextTime) { // Two different values at the exact same time. Extremely rare.
	console.warn(this.fullLabel, `Unusual matching timestamp case at time ${missingTime} for tag ${tag}.`);
	nextTimes ||= Object.keys(nextMappings); // We didn't need this for our loop. Generate now if needed.
	const nextNextTime = Math.min(keysOfMissing[missingIndex + 1] || Infinity,
				      nextMappings[nextTimes.indexOf(nextTime) + 1] || Infinity);
	const insertTime = nextTime + (nextNextTime - nextTime) / 2;
	// We already put these in order with previousMappings first.
	merged[nextTime] = previousMappings[nextTime];
	merged[insertTime] = nextMappings[nextTime];

      } else { // No conflicts. Just add next.
	merged[nextTime] = nextMappings[nextTime];
      }
    }

    // There can be missing stuff to add at the end;
    for (; missingIndex < keysOfMissing.length; missingIndex++) {
      missingTime = keysOfMissing[missingIndex];
      merged[missingTime] = previousMappings[missingTime];
    }
    let mergedTimes = Object.keys(merged);
    merged.latest = mergedTimes[mergedTimes.length - 1];
    return rest.length ? this.combineTimestamps(tag, undefined, merged, ...rest) : merged;
  }
  static async verify(signature, options = {}) { // An array of unmerged signatures can be verified.
    if (signature.startsWith?.('[')) signature = JSON.parse(signature); // (maybeInflate looks for '{', not '['.)
    if (!Array.isArray(signature)) return await super.verify(signature, options);
    const combined = await Promise.all(signature.map(element => this.verify(element, options)));
    const ok = combined.every(element => element);
    if (!ok) return undefined;
    const protectedHeader = combined[0].protectedHeader;
    for (const property of ['iss', 'kid', 'alg', 'cty']) { // Our operations make use of iss, kid, and iat.
      const matching = protectedHeader[property];
      const matches = combined.every(element => element.protectedHeader[property] === matching);
      if (matches) continue;
      if (!matches) return undefined;
    }
    const {iss, kid, alg, cty} = protectedHeader;
    const verified = {
      signature, // array at this point
      json: combined.map(element => element.json),
      protectedHeader: {iss, kid, alg, cty, iat: Math.max(...combined.map(element => element.protectedHeader.iat))}
    };
    return verified;
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
};
Credentials.disconnect = async (...services) => {
  return Promise.all(Object.values(Credentials.collections).map(collection => collection.disconnect(...services)));
};

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
const answers = {}; // TODO: make setAnswer include tag as well as prompt.
Credentials.setAnswer = (prompt, answer) => answers[prompt] = answer;
Credentials.getUserDeviceSecret = function flexstoreSecret(tag, promptString) {
  if (!promptString) return tag;
  if (promptString === '-') return promptString; // See createAuthor.
  if (answers[promptString]) return answers[promptString];
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
};
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
  await Promise.all(Object.values(Credentials.collections).map(async collection => {
    await collection.disconnect();
    const store = await collection.persistenceStore;
    store.destroy(); // Destroy the persistent cache.
  }));
  await Credentials.wipeDeviceKeys(); // Not included in the above.
};
Credentials.collections = {};
['EncryptionKey', 'KeyRecovery', 'Team'].forEach(name => Credentials.collections[name] = new MutableCollection({name}));

console.log(`${name} ${version} from ${import.meta.url}.`);
var index = { Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection, VersionCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version,  storageName, storageVersion };

export { Collection, ImmutableCollection, MutableCollection, PromiseWebRTC, SharedWebRTC, Synchronizer, VersionCollection, VersionedCollection, WebRTC, index as default, name, storageName, storageVersion, version };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsibm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwibm9kZV9tb2R1bGVzL0BraTFyMHkvc3RvcmFnZS9idW5kbGUubWpzIiwibGliL2NvbGxlY3Rpb25zLm1qcyIsImluZGV4Lm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB1dWlkUGF0dGVybiA9IC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tNFswLTlhLWZdezN9LVs4OWFiXVswLTlhLWZdezN9LVswLTlhLWZdezEyfSQvaTtcbmZ1bmN0aW9uIHZhbGlkKHV1aWQpIHtcbiAgcmV0dXJuIHV1aWRQYXR0ZXJuLnRlc3QodXVpZCk7XG59XG5cbi8vIEJhc2VkIG9uIGh0dHBzOi8vYWJoaXNoZWtkdXR0YS5vcmcvYmxvZy9zdGFuZGFsb25lX3V1aWRfZ2VuZXJhdG9yX2luX2phdmFzY3JpcHQuaHRtbFxuLy8gSUUxMSBhbmQgTW9kZXJuIEJyb3dzZXJzIE9ubHlcbmZ1bmN0aW9uIHV1aWQ0KCkge1xuICB2YXIgdGVtcF91cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKCkpO1xuICB2YXIgdXVpZCA9IHRlbXBfdXJsLnRvU3RyaW5nKCk7XG4gIFVSTC5yZXZva2VPYmplY3RVUkwodGVtcF91cmwpO1xuICByZXR1cm4gdXVpZC5zcGxpdCgvWzpcXC9dL2cpLnBvcCgpLnRvTG93ZXJDYXNlKCk7IC8vIHJlbW92ZSBwcmVmaXhlc1xufVxudXVpZDQudmFsaWQgPSB2YWxpZDtcblxuZXhwb3J0IGRlZmF1bHQgdXVpZDQ7XG5leHBvcnQgeyB1dWlkNCwgdmFsaWQgfTtcbiIsIi8vIEluIGEgYnJvd3Nlciwgd3J0YyBwcm9wZXJ0aWVzIHN1Y2ggYXMgUlRDUGVlckNvbm5lY3Rpb24gYXJlIGluIGdsb2JhbFRoaXMuXG5leHBvcnQgZGVmYXVsdCBnbG9iYWxUaGlzO1xuIiwiaW1wb3J0IHV1aWQ0IGZyb20gJ3V1aWQ0JztcblxuLy8gU2VlIHJvbGx1cC5jb25maWcubWpzXG5pbXBvcnQgd3J0YyBmcm9tICcjd3J0Yyc7XG4vL2NvbnN0IHtkZWZhdWx0OndydGN9ID0gYXdhaXQgKCh0eXBlb2YocHJvY2VzcykgIT09ICd1bmRlZmluZWQnKSA/IGltcG9ydCgnQHJvYW1ocS93cnRjJykgOiB7ZGVmYXVsdDogZ2xvYmFsVGhpc30pO1xuXG5jb25zdCBpY2VTZXJ2ZXJzID0gW1xuICB7IHVybHM6ICdzdHVuOnN0dW4ubC5nb29nbGUuY29tOjE5MzAyJ30sXG4gIC8vIGh0dHBzOi8vZnJlZXN0dW4ubmV0LyAgQ3VycmVudGx5IDUwIEtCaXQvcy4gKDIuNSBNQml0L3MgZm9ycyAkOS9tb250aClcbiAgeyB1cmxzOiAnc3R1bjpmcmVlc3R1bi5uZXQ6MzQ3OCcgfSxcbiAgLy97IHVybHM6ICd0dXJuOmZyZWVzdHVuLm5ldDozNDc4JywgdXNlcm5hbWU6ICdmcmVlJywgY3JlZGVudGlhbDogJ2ZyZWUnIH0sXG4gIC8vIFByZXN1bWFibHkgdHJhZmZpYyBsaW1pdGVkLiBDYW4gZ2VuZXJhdGUgbmV3IGNyZWRlbnRpYWxzIGF0IGh0dHBzOi8vc3BlZWQuY2xvdWRmbGFyZS5jb20vdHVybi1jcmVkc1xuICAvLyBBbHNvIGh0dHBzOi8vZGV2ZWxvcGVycy5jbG91ZGZsYXJlLmNvbS9jYWxscy8gMSBUQi9tb250aCwgYW5kICQwLjA1IC9HQiBhZnRlciB0aGF0LlxuICB7IHVybHM6ICd0dXJuOnR1cm4uc3BlZWQuY2xvdWRmbGFyZS5jb206NTAwMDAnLCB1c2VybmFtZTogJzgyNjIyNjI0NGNkNmU1ZWRiM2Y1NTc0OWI3OTYyMzVmNDIwZmU1ZWU3ODg5NWUwZGQ3ZDJiYWE0NWUxZjdhOGY0OWU5MjM5ZTc4NjkxYWIzOGI3MmNlMDE2NDcxZjc3NDZmNTI3N2RjZWY4NGFkNzlmYzYwZjgwMjBiMTMyYzczJywgY3JlZGVudGlhbDogJ2FiYTliMTY5NTQ2ZWI2ZGNjN2JmYjFjZGYzNDU0NGNmOTViNTE2MWQ2MDJlM2I1ZmE3YzgzNDJiMmU5ODAyZmInIH1cbiAgLy8gaHR0cHM6Ly9mYXN0dHVybi5uZXQvIEN1cnJlbnRseSA1MDBNQi9tb250aD8gKDI1IEdCL21vbnRoIGZvciAkOS9tb250aClcbiAgLy8gaHR0cHM6Ly94aXJzeXMuY29tL3ByaWNpbmcvIDUwMCBNQi9tb250aCAoNTAgR0IvbW9udGggZm9yICQzMy9tb250aClcbiAgLy8gQWxzbyBodHRwczovL3d3dy5ucG1qcy5jb20vcGFja2FnZS9ub2RlLXR1cm4gb3IgaHR0cHM6Ly9tZWV0cml4LmlvL2Jsb2cvd2VicnRjL2NvdHVybi9pbnN0YWxsYXRpb24uaHRtbFxuXTtcblxuLy8gVXRpbGl0eSB3cmFwcGVyIGFyb3VuZCBSVENQZWVyQ29ubmVjdGlvbi5cbi8vIFdoZW4gc29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIChzdWNoIGFzIGNyZWF0ZURhdGFDaGFubmVsKSwgaXQgd2lsbCBnZW5lcmF0ZSBjYWxscyB0byBzaWduYWwoKSwgd2hpY2ggbmVlZHMgdG8gYmUgZGVmaW5lZCBieSBzdWJjbGFzc2VzLlxuZXhwb3J0IGNsYXNzIFdlYlJUQyB7XG4gIGNvbnN0cnVjdG9yKHtsYWJlbCA9ICcnLCBjb25maWd1cmF0aW9uID0gbnVsbCwgdXVpZCA9IHV1aWQ0KCksIGRlYnVnID0gZmFsc2UsIGVycm9yID0gY29uc29sZS5lcnJvciwgLi4ucmVzdH0gPSB7fSkge1xuICAgIGNvbmZpZ3VyYXRpb24gPz89IHtpY2VTZXJ2ZXJzfTsgLy8gSWYgY29uZmlndXJhdGlvbiBjYW4gYmUgb21taXR0ZWQgb3IgZXhwbGljaXRseSBhcyBudWxsLCB1c2Ugb3VyIGRlZmF1bHQuIEJ1dCBpZiB7fSwgbGVhdmUgaXQgYmUuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7bGFiZWwsIGNvbmZpZ3VyYXRpb24sIHV1aWQsIGRlYnVnLCBlcnJvciwgLi4ucmVzdH0pO1xuICAgIHRoaXMucmVzZXRQZWVyKCk7XG4gIH1cbiAgc2lnbmFsKHR5cGUsIG1lc3NhZ2UpIHsgLy8gU3ViY2xhc3NlcyBtdXN0IG92ZXJyaWRlIG9yIGV4dGVuZC4gRGVmYXVsdCBqdXN0IGxvZ3MuXG4gICAgdGhpcy5sb2coJ3NlbmRpbmcnLCB0eXBlLCB0eXBlLmxlbmd0aCwgSlNPTi5zdHJpbmdpZnkobWVzc2FnZSkubGVuZ3RoKTtcbiAgfVxuXG4gIHBlZXJWZXJzaW9uID0gMDtcbiAgcmVzZXRQZWVyKCkgeyAvLyBTZXQgdXAgYSBuZXcgUlRDUGVlckNvbm5lY3Rpb24uIChDYWxsZXIgbXVzdCBjbG9zZSBvbGQgaWYgbmVjZXNzYXJ5LilcbiAgICBjb25zdCBvbGQgPSB0aGlzLnBlZXI7XG4gICAgaWYgKG9sZCkge1xuICAgICAgb2xkLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBvbGQub25pY2VjYW5kaWRhdGUgPSBvbGQub25pY2VjYW5kaWRhdGVlcnJvciA9IG9sZC5vbmNvbm5lY3Rpb25zdGF0ZWNoYW5nZSA9IG51bGw7XG4gICAgICAvLyBEb24ndCBjbG9zZSB1bmxlc3MgaXQncyBiZWVuIG9wZW5lZCwgYmVjYXVzZSB0aGVyZSBhcmUgbGlrZWx5IGhhbmRsZXJzIHRoYXQgd2UgZG9uJ3Qgd2FudCB0byBmaXJlLlxuICAgICAgaWYgKG9sZC5jb25uZWN0aW9uU3RhdGUgIT09ICduZXcnKSBvbGQuY2xvc2UoKTtcbiAgICB9XG4gICAgY29uc3QgcGVlciA9IHRoaXMucGVlciA9IG5ldyB3cnRjLlJUQ1BlZXJDb25uZWN0aW9uKHRoaXMuY29uZmlndXJhdGlvbik7XG4gICAgcGVlci52ZXJzaW9uSWQgPSB0aGlzLnBlZXJWZXJzaW9uKys7XG4gICAgcGVlci5vbm5lZ290aWF0aW9ubmVlZGVkID0gZXZlbnQgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZChldmVudCk7XG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZSA9IGV2ZW50ID0+IHRoaXMub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gICAgLy8gSSBkb24ndCB0aGluayBhbnlvbmUgYWN0dWFsbHkgc2lnbmFscyB0aGlzLiBJbnN0ZWFkLCB0aGV5IHJlamVjdCBmcm9tIGFkZEljZUNhbmRpZGF0ZSwgd2hpY2ggd2UgaGFuZGxlIHRoZSBzYW1lLlxuICAgIHBlZXIub25pY2VjYW5kaWRhdGVlcnJvciA9IGVycm9yID0+IHRoaXMuaWNlY2FuZGlkYXRlRXJyb3IoZXJyb3IpO1xuICAgIC8vIEkgdGhpbmsgdGhpcyBpcyByZWR1bmRuYW50IGJlY2F1c2Ugbm8gaW1wbGVtZW50YXRpb24gZmlyZXMgdGhpcyBldmVudCBhbnkgc2lnbmlmaWNhbnQgdGltZSBhaGVhZCBvZiBlbWl0dGluZyBpY2VjYW5kaWRhdGUgd2l0aCBhbiBlbXB0eSBldmVudC5jYW5kaWRhdGUuXG4gICAgcGVlci5vbmljZWdhdGhlcmluZ3N0YXRlY2hhbmdlID0gZXZlbnQgPT4gKHBlZXIuaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScpICYmIHRoaXMub25Mb2NhbEVuZEljZTtcbiAgICBwZWVyLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gZXZlbnQgPT4gdGhpcy5jb25uZWN0aW9uU3RhdGVDaGFuZ2UodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIFRoZSBzcGVjIHNheXMgdGhhdCBhIG51bGwgY2FuZGlkYXRlIHNob3VsZCBub3QgYmUgc2VudCwgYnV0IHRoYXQgYW4gZW1wdHkgc3RyaW5nIGNhbmRpZGF0ZSBzaG91bGQuIFNhZmFyaSAodXNlZCB0bz8pIGdldCBlcnJvcnMgZWl0aGVyIHdheS5cbiAgICBpZiAoIWV2ZW50LmNhbmRpZGF0ZSB8fCAhZXZlbnQuY2FuZGlkYXRlLmNhbmRpZGF0ZSkgdGhpcy5vbkxvY2FsRW5kSWNlKCk7XG4gICAgZWxzZSB0aGlzLnNpZ25hbCgnaWNlY2FuZGlkYXRlJywgZXZlbnQuY2FuZGlkYXRlKTtcbiAgfVxuICBvbkxvY2FsRW5kSWNlKCkgeyAvLyBUcmlnZ2VyZWQgb24gb3VyIHNpZGUgYnkgYW55L2FsbCBvZiBvbmljZWNhbmRpZGF0ZSB3aXRoIG5vIGV2ZW50LmNhbmRpZGF0ZSwgaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScuXG4gICAgLy8gSS5lLiwgY2FuIGhhcHBlbiBtdWx0aXBsZSB0aW1lcy4gU3ViY2xhc3NlcyBtaWdodCBkbyBzb21ldGhpbmcuXG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKCh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnbmV3JykgJiYgKHRoaXMucGVlci5zaWduYWxpbmdTdGF0ZSA9PT0gJ3N0YWJsZScpKSByZXR1cm47XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBjb25uZWN0aW9uU3RhdGVDaGFuZ2Uoc3RhdGUpIHtcbiAgICB0aGlzLmxvZygnc3RhdGUgY2hhbmdlOicsIHN0YXRlKTtcbiAgICBpZiAoWydkaXNjb25uZWN0ZWQnLCAnZmFpbGVkJywgJ2Nsb3NlZCddLmluY2x1ZGVzKHN0YXRlKSkgdGhpcy5jbG9zZSgpOyAvLyBPdGhlciBiZWhhdmlvciBhcmUgcmVhc29uYWJsZSwgdG9sby5cbiAgfVxuICBuZWdvdGlhdGlvbm5lZWRlZCgpIHsgLy8gU29tZXRoaW5nIGhhcyBjaGFuZ2VkIGxvY2FsbHkgKG5ldyBzdHJlYW0sIG9yIG5ldHdvcmsgY2hhbmdlKSwgc3VjaCB0aGF0IHdlIGhhdmUgdG8gc3RhcnQgbmVnb3RpYXRpb24uXG4gICAgdGhpcy5sb2coJ25lZ290aWF0aW9ubm5lZWRlZCcpO1xuICAgIHRoaXMucGVlci5jcmVhdGVPZmZlcigpXG4gICAgICAudGhlbihvZmZlciA9PiB7XG4gICAgICAgIHRoaXMucGVlci5zZXRMb2NhbERlc2NyaXB0aW9uKG9mZmVyKTsgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIG9mZmVyXG5cdHJldHVybiBvZmZlcjtcbiAgICAgIH0pXG4gICAgICAudGhlbihvZmZlciA9PiB0aGlzLnNpZ25hbCgnb2ZmZXInLCBvZmZlcikpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZEVycm9yKGVycm9yKSk7XG4gIH1cbiAgb2ZmZXIob2ZmZXIpIHsgLy8gSGFuZGxlciBmb3IgcmVjZWl2aW5nIGFuIG9mZmVyIGZyb20gdGhlIG90aGVyIHVzZXIgKHdobyBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2VzcykuXG4gICAgLy8gTm90ZSB0aGF0IGR1cmluZyBzaWduYWxpbmcsIHdlIHdpbGwgcmVjZWl2ZSBuZWdvdGlhdGlvbm5lZWRlZC9hbnN3ZXIsIG9yIG9mZmVyLCBidXQgbm90IGJvdGgsIGRlcGVuZGluZ1xuICAgIC8vIG9uIHdoZXRoZXIgd2Ugd2VyZSB0aGUgb25lIHRoYXQgc3RhcnRlZCB0aGUgc2lnbmFsaW5nIHByb2Nlc3MuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKG9mZmVyKVxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnBlZXIuY3JlYXRlQW5zd2VyKCkpXG4gICAgICAudGhlbihhbnN3ZXIgPT4gdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyKSkgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIGFuc3dlclxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnNpZ25hbCgnYW5zd2VyJywgdGhpcy5wZWVyLmxvY2FsRGVzY3JpcHRpb24pKTtcbiAgfVxuICBhbnN3ZXIoYW5zd2VyKSB7IC8vIEhhbmRsZXIgZm9yIGZpbmlzaGluZyB0aGUgc2lnbmFsaW5nIHByb2Nlc3MgdGhhdCB3ZSBzdGFydGVkLlxuICAgIHRoaXMucGVlci5zZXRSZW1vdGVEZXNjcmlwdGlvbihhbnN3ZXIpO1xuICB9XG4gIGljZWNhbmRpZGF0ZShpY2VDYW5kaWRhdGUpIHsgLy8gSGFuZGxlciBmb3IgYSBuZXcgY2FuZGlkYXRlIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZCB0aHJvdWdoIHNpZ25hbGluZy5cbiAgICB0aGlzLnBlZXIuYWRkSWNlQ2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkuY2F0Y2goZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcikpO1xuICB9XG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnJlc3QpO1xuICB9XG4gIGxvZ0Vycm9yKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgY29uc3QgZGF0YSA9IFt0aGlzLmxhYmVsLCB0aGlzLnBlZXIudmVyc2lvbklkLCAuLi50aGlzLmNvbnN0cnVjdG9yLmdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbildO1xuICAgIHRoaXMuZXJyb3IoZGF0YSk7XG4gICAgcmV0dXJuIGRhdGE7XG4gIH1cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7XG4gIH1cbiAgc3RhdGljIGdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbikge1xuICAgIHJldHVybiBbXG4gICAgICBsYWJlbCArIFwiIGVycm9yOlwiLFxuICAgICAgZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzIHx8IFwiXCIsIC8vIEZpcnN0IGlzIGRlcHJlY2F0ZWQsIGJ1dCBzdGlsbCB1c2VmdWwuXG4gICAgICBldmVudE9yRXhjZXB0aW9uLnVybCB8fCBldmVudE9yRXhjZXB0aW9uLm5hbWUgfHwgJycsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLm1lc3NhZ2UgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvclRleHQgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXNUZXh0IHx8IGV2ZW50T3JFeGNlcHRpb25cbiAgICBdO1xuICB9XG4gIGljZWNhbmRpZGF0ZUVycm9yKGV2ZW50T3JFeGNlcHRpb24pIHsgLy8gRm9yIGVycm9ycyBvbiB0aGlzIHBlZXIgZHVyaW5nIGdhdGhlcmluZy5cbiAgICAvLyBDYW4gYmUgb3ZlcnJpZGRlbiBvciBleHRlbmRlZCBieSBhcHBsaWNhdGlvbnMuXG5cbiAgICAvLyBTVFVOIGVycm9ycyBhcmUgaW4gdGhlIHJhbmdlIDMwMC02OTkuIFNlZSBSRkMgNTM4OSwgc2VjdGlvbiAxNS42XG4gICAgLy8gZm9yIGEgbGlzdCBvZiBjb2Rlcy4gVFVSTiBhZGRzIGEgZmV3IG1vcmUgZXJyb3IgY29kZXM7IHNlZVxuICAgIC8vIFJGQyA1NzY2LCBzZWN0aW9uIDE1IGZvciBkZXRhaWxzLlxuICAgIC8vIFNlcnZlciBjb3VsZCBub3QgYmUgcmVhY2hlZCBhcmUgaW4gdGhlIHJhbmdlIDcwMC03OTkuXG4gICAgY29uc3QgY29kZSA9IGV2ZW50T3JFeGNlcHRpb24uY29kZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yQ29kZSB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1cztcbiAgICAvLyBDaHJvbWUgZ2l2ZXMgNzAxIGVycm9ycyBmb3Igc29tZSB0dXJuIHNlcnZlcnMgdGhhdCBpdCBkb2VzIG5vdCBnaXZlIGZvciBvdGhlciB0dXJuIHNlcnZlcnMuXG4gICAgLy8gVGhpcyBpc24ndCBnb29kLCBidXQgaXQncyB3YXkgdG9vIG5vaXN5IHRvIHNsb2cgdGhyb3VnaCBzdWNoIGVycm9ycywgYW5kIEkgZG9uJ3Qga25vdyBob3cgdG8gZml4IG91ciB0dXJuIGNvbmZpZ3VyYXRpb24uXG4gICAgaWYgKGNvZGUgPT09IDcwMSkgcmV0dXJuO1xuICAgIHRoaXMubG9nRXJyb3IoJ2ljZScsIGV2ZW50T3JFeGNlcHRpb24pO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBQcm9taXNlV2ViUlRDIGV4dGVuZHMgV2ViUlRDIHtcbiAgLy8gRXh0ZW5kcyBXZWJSVEMuc2lnbmFsKCkgc3VjaCB0aGF0OlxuICAvLyAtIGluc3RhbmNlLnNpZ25hbHMgYW5zd2VycyBhIHByb21pc2UgdGhhdCB3aWxsIHJlc29sdmUgd2l0aCBhbiBhcnJheSBvZiBzaWduYWwgbWVzc2FnZXMuXG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyA9IFsuLi5zaWduYWxNZXNzYWdlc10gd2lsbCBkaXNwYXRjaCB0aG9zZSBtZXNzYWdlcy5cbiAgLy9cbiAgLy8gRm9yIGV4YW1wbGUsIHN1cHBvc2UgcGVlcjEgYW5kIHBlZXIyIGFyZSBpbnN0YW5jZXMgb2YgdGhpcy5cbiAgLy8gMC4gU29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIG9uIHBlZXIxIChzdWNoIGFzIGNhbGxpbmcgcGVlcjEuY3JlYXRlRGF0YUNoYW5uZWwoKSkuIFxuICAvLyAxLiBwZWVyMS5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDE+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjIuXG4gIC8vIDIuIFNldCBwZWVyMi5zaWduYWxzID0gPHNpZ25hbDE+LlxuICAvLyAzLiBwZWVyMi5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDI+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjEuXG4gIC8vIDQuIFNldCBwZWVyMS5zaWduYWxzID0gPHNpZ25hbDI+LlxuICAvLyA1LiBEYXRhIGZsb3dzLCBidXQgZWFjaCBzaWRlIHdob3VsZCBncmFiIGEgbmV3IHNpZ25hbHMgcHJvbWlzZSBhbmQgYmUgcHJlcGFyZWQgdG8gYWN0IGlmIGl0IHJlc29sdmVzLlxuICAvL1xuICBjb25zdHJ1Y3Rvcih7aWNlVGltZW91dCA9IDJlMywgLi4ucHJvcGVydGllc30pIHtcbiAgICBzdXBlcihwcm9wZXJ0aWVzKTtcbiAgICB0aGlzLmljZVRpbWVvdXQgPSBpY2VUaW1lb3V0O1xuICB9XG4gIGdldCBzaWduYWxzKCkgeyAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmUgdG8gdGhlIHNpZ25hbCBtZXNzYWdpbmcgd2hlbiBpY2UgY2FuZGlkYXRlIGdhdGhlcmluZyBpcyBjb21wbGV0ZS5cbiAgICByZXR1cm4gdGhpcy5fc2lnbmFsUHJvbWlzZSB8fD0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gdGhpcy5fc2lnbmFsUmVhZHkgPSB7cmVzb2x2ZSwgcmVqZWN0fSk7XG4gIH1cbiAgc2V0IHNpZ25hbHMoZGF0YSkgeyAvLyBTZXQgd2l0aCB0aGUgc2lnbmFscyByZWNlaXZlZCBmcm9tIHRoZSBvdGhlciBlbmQuXG4gICAgZGF0YS5mb3JFYWNoKChbdHlwZSwgbWVzc2FnZV0pID0+IHRoaXNbdHlwZV0obWVzc2FnZSkpO1xuICB9XG4gIG9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpIHtcbiAgICAvLyBFYWNoIHdydGMgaW1wbGVtZW50YXRpb24gaGFzIGl0cyBvd24gaWRlYXMgYXMgdG8gd2hhdCBpY2UgY2FuZGlkYXRlcyB0byB0cnkgYmVmb3JlIGVtaXR0aW5nIHRoZW0gaW4gaWNlY2FuZGRpYXRlLlxuICAgIC8vIE1vc3Qgd2lsbCB0cnkgdGhpbmdzIHRoYXQgY2Fubm90IGJlIHJlYWNoZWQsIGFuZCBnaXZlIHVwIHdoZW4gdGhleSBoaXQgdGhlIE9TIG5ldHdvcmsgdGltZW91dC4gRm9ydHkgc2Vjb25kcyBpcyBhIGxvbmcgdGltZSB0byB3YWl0LlxuICAgIC8vIElmIHRoZSB3cnRjIGlzIHN0aWxsIHdhaXRpbmcgYWZ0ZXIgb3VyIGljZVRpbWVvdXQgKDIgc2Vjb25kcyksIGxldHMganVzdCBnbyB3aXRoIHdoYXQgd2UgaGF2ZS5cbiAgICB0aGlzLnRpbWVyIHx8PSBzZXRUaW1lb3V0KCgpID0+IHRoaXMub25Mb2NhbEVuZEljZSgpLCB0aGlzLmljZVRpbWVvdXQpO1xuICAgIHN1cGVyLm9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpO1xuICB9XG4gIGNsZWFySWNlVGltZXIoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpO1xuICAgIHRoaXMudGltZXIgPSBudWxsO1xuICB9XG4gIGFzeW5jIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFJlc29sdmUgdGhlIHByb21pc2Ugd2l0aCB3aGF0IHdlJ3ZlIGJlZW4gZ2F0aGVyaW5nLlxuICAgIHRoaXMuY2xlYXJJY2VUaW1lcigpO1xuICAgIGlmICghdGhpcy5fc2lnbmFsUHJvbWlzZSkge1xuICAgICAgLy90aGlzLmxvZ0Vycm9yKCdpY2UnLCBcIkVuZCBvZiBJQ0Ugd2l0aG91dCBhbnl0aGluZyB3YWl0aW5nIG9uIHNpZ25hbHMuXCIpOyAvLyBOb3QgaGVscGZ1bCB3aGVuIHRoZXJlIGFyZSB0aHJlZSB3YXlzIHRvIHJlY2VpdmUgdGhpcyBtZXNzYWdlLlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9zaWduYWxSZWFkeS5yZXNvbHZlKHRoaXMuc2VuZGluZyk7XG4gICAgdGhpcy5zZW5kaW5nID0gW107XG4gIH1cbiAgc2VuZGluZyA9IFtdO1xuICBzaWduYWwodHlwZSwgbWVzc2FnZSkge1xuICAgIHN1cGVyLnNpZ25hbCh0eXBlLCBtZXNzYWdlKTtcbiAgICB0aGlzLnNlbmRpbmcucHVzaChbdHlwZSwgbWVzc2FnZV0pO1xuICB9XG4gIC8vIFdlIG5lZWQgdG8ga25vdyBpZiB0aGVyZSBhcmUgb3BlbiBkYXRhIGNoYW5uZWxzLiBUaGVyZSBpcyBhIHByb3Bvc2FsIGFuZCBldmVuIGFuIGFjY2VwdGVkIFBSIGZvciBSVENQZWVyQ29ubmVjdGlvbi5nZXREYXRhQ2hhbm5lbHMoKSxcbiAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3czYy93ZWJydGMtZXh0ZW5zaW9ucy9pc3N1ZXMvMTEwXG4gIC8vIGJ1dCBpdCBoYXNuJ3QgYmVlbiBkZXBsb3llZCBldmVyeXdoZXJlIHlldC4gU28gd2UnbGwgbmVlZCB0byBrZWVwIG91ciBvd24gY291bnQuXG4gIC8vIEFsYXMsIGEgY291bnQgaXNuJ3QgZW5vdWdoLCBiZWNhdXNlIHdlIGNhbiBvcGVuIHN0dWZmLCBhbmQgdGhlIG90aGVyIHNpZGUgY2FuIG9wZW4gc3R1ZmYsIGJ1dCBpZiBpdCBoYXBwZW5zIHRvIGJlXG4gIC8vIHRoZSBzYW1lIFwibmVnb3RpYXRlZFwiIGlkLCBpdCBpc24ndCByZWFsbHkgYSBkaWZmZXJlbnQgY2hhbm5lbC4gKGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9SVENQZWVyQ29ubmVjdGlvbi9kYXRhY2hhbm5lbF9ldmVudFxuICBkYXRhQ2hhbm5lbHMgPSBuZXcgTWFwKCk7XG4gIHJlcG9ydENoYW5uZWxzKCkgeyAvLyBSZXR1cm4gYSByZXBvcnQgc3RyaW5nIHVzZWZ1bCBmb3IgZGVidWdnaW5nLlxuICAgIGNvbnN0IGVudHJpZXMgPSBBcnJheS5mcm9tKHRoaXMuZGF0YUNoYW5uZWxzLmVudHJpZXMoKSk7XG4gICAgY29uc3Qga3YgPSBlbnRyaWVzLm1hcCgoW2ssIHZdKSA9PiBgJHtrfToke3YuaWR9YCk7XG4gICAgcmV0dXJuIGAke3RoaXMuZGF0YUNoYW5uZWxzLnNpemV9LyR7a3Yuam9pbignLCAnKX1gO1xuICB9XG4gIG5vdGVDaGFubmVsKGNoYW5uZWwsIHNvdXJjZSwgd2FpdGluZykgeyAvLyBCb29ra2VlcCBvcGVuIGNoYW5uZWwgYW5kIHJldHVybiBpdC5cbiAgICAvLyBFbXBlcmljYWxseSwgd2l0aCBtdWx0aXBsZXggZmFsc2U6IC8vICAgMTggb2NjdXJyZW5jZXMsIHdpdGggaWQ9bnVsbHwwfDEgYXMgZm9yIGV2ZW50Y2hhbm5lbCBvciBjcmVhdGVEYXRhQ2hhbm5lbFxuICAgIC8vICAgQXBwYXJlbnRseSwgd2l0aG91dCBuZWdvdGlhdGlvbiwgaWQgaXMgaW5pdGlhbGx5IG51bGwgKHJlZ2FyZGxlc3Mgb2Ygb3B0aW9ucy5pZCksIGFuZCB0aGVuIGFzc2lnbmVkIHRvIGEgZnJlZSB2YWx1ZSBkdXJpbmcgb3BlbmluZ1xuICAgIGNvbnN0IGtleSA9IGNoYW5uZWwubGFiZWw7IC8vZml4bWUgY2hhbm5lbC5pZCA9PT0gbnVsbCA/IDEgOiBjaGFubmVsLmlkO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5kYXRhQ2hhbm5lbHMuZ2V0KGtleSk7XG4gICAgdGhpcy5sb2coJ2dvdCBkYXRhLWNoYW5uZWwnLCBzb3VyY2UsIGtleSwgJ2V4aXN0aW5nOicsIGV4aXN0aW5nLCAnd2FpdGluZzonLCB3YWl0aW5nKTtcbiAgICB0aGlzLmRhdGFDaGFubmVscy5zZXQoa2V5LCBjaGFubmVsKTtcbiAgICBjaGFubmVsLmFkZEV2ZW50TGlzdGVuZXIoJ2Nsb3NlJywgZXZlbnQgPT4geyAvLyBDbG9zZSB3aG9sZSBjb25uZWN0aW9uIHdoZW4gbm8gbW9yZSBkYXRhIGNoYW5uZWxzIG9yIHN0cmVhbXMuXG4gICAgICB0aGlzLmRhdGFDaGFubmVscy5kZWxldGUoa2V5KTtcbiAgICAgIC8vIElmIHRoZXJlJ3Mgbm90aGluZyBvcGVuLCBjbG9zZSB0aGUgY29ubmVjdGlvbi5cbiAgICAgIGlmICh0aGlzLmRhdGFDaGFubmVscy5zaXplKSByZXR1cm47XG4gICAgICBpZiAodGhpcy5wZWVyLmdldFNlbmRlcnMoKS5sZW5ndGgpIHJldHVybjtcbiAgICAgIHRoaXMuY2xvc2UoKTtcbiAgICB9KTtcbiAgICByZXR1cm4gY2hhbm5lbDtcbiAgfVxuICBjcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCA9IFwiZGF0YVwiLCBjaGFubmVsT3B0aW9ucyA9IHt9KSB7IC8vIFByb21pc2UgcmVzb2x2ZXMgd2hlbiB0aGUgY2hhbm5lbCBpcyBvcGVuICh3aGljaCB3aWxsIGJlIGFmdGVyIGFueSBuZWVkZWQgbmVnb3RpYXRpb24pLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdjcmVhdGUgZGF0YS1jaGFubmVsJywgbGFiZWwsIGNoYW5uZWxPcHRpb25zKTtcbiAgICAgIGxldCBjaGFubmVsID0gdGhpcy5wZWVyLmNyZWF0ZURhdGFDaGFubmVsKGxhYmVsLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgICB0aGlzLm5vdGVDaGFubmVsKGNoYW5uZWwsICdleHBsaWNpdCcpOyAvLyBOb3RlZCBldmVuIGJlZm9yZSBvcGVuZWQuXG4gICAgICAvLyBUaGUgY2hhbm5lbCBtYXkgaGF2ZSBhbHJlYWR5IGJlZW4gb3BlbmVkIG9uIHRoZSBvdGhlciBzaWRlLiBJbiB0aGlzIGNhc2UsIGFsbCBicm93c2VycyBmaXJlIHRoZSBvcGVuIGV2ZW50IGFueXdheSxcbiAgICAgIC8vIGJ1dCB3cnRjIChpLmUuLCBvbiBub2RlSlMpIGRvZXMgbm90LiBTbyB3ZSBoYXZlIHRvIGV4cGxpY2l0bHkgY2hlY2suXG4gICAgICBzd2l0Y2ggKGNoYW5uZWwucmVhZHlTdGF0ZSkge1xuICAgICAgY2FzZSAnb3Blbic6XG5cdHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShjaGFubmVsKSwgMTApO1xuXHRicmVhaztcbiAgICAgIGNhc2UgJ2Nvbm5lY3RpbmcnOlxuXHRjaGFubmVsLm9ub3BlbiA9IF8gPT4gcmVzb2x2ZShjaGFubmVsKTtcblx0YnJlYWs7XG4gICAgICBkZWZhdWx0OlxuXHR0aHJvdyBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgcmVhZHlTdGF0ZSAke2NoYW5uZWwucmVhZHlTdGF0ZX0gZm9yIGRhdGEgY2hhbm5lbCAke2xhYmVsfS5gKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICB3YWl0aW5nQ2hhbm5lbHMgPSB7fTtcbiAgZ2V0RGF0YUNoYW5uZWxQcm9taXNlKGxhYmVsID0gXCJkYXRhXCIpIHsgLy8gUmVzb2x2ZXMgdG8gYW4gb3BlbiBkYXRhIGNoYW5uZWwuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgdGhpcy5sb2coJ3Byb21pc2UgZGF0YS1jaGFubmVsJywgbGFiZWwpO1xuICAgICAgdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdID0gcmVzb2x2ZTtcbiAgICB9KTtcbiAgfVxuICByZXNldFBlZXIoKSB7IC8vIFJlc2V0IGEgJ2Nvbm5lY3RlZCcgcHJvcGVydHkgdGhhdCBwcm9taXNlZCB0byByZXNvbHZlIHdoZW4gb3BlbmVkLCBhbmQgdHJhY2sgaW5jb21pbmcgZGF0YWNoYW5uZWxzLlxuICAgIHN1cGVyLnJlc2V0UGVlcigpO1xuICAgIHRoaXMuY29ubmVjdGVkID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7IC8vIHRoaXMuY29ubmVjdGVkIGlzIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gd2UgYXJlLlxuICAgICAgdGhpcy5wZWVyLmFkZEV2ZW50TGlzdGVuZXIoJ2Nvbm5lY3Rpb25zdGF0ZWNoYW5nZScsIGV2ZW50ID0+IHtcblx0aWYgKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICdjb25uZWN0ZWQnKSB7XG5cdCAgcmVzb2x2ZSh0cnVlKTtcblx0fVxuICAgICAgfSk7XG4gICAgfSk7XG4gICAgdGhpcy5wZWVyLmFkZEV2ZW50TGlzdGVuZXIoJ2RhdGFjaGFubmVsJywgZXZlbnQgPT4geyAvLyBSZXNvbHZlIHByb21pc2UgbWFkZSB3aXRoIGdldERhdGFDaGFubmVsUHJvbWlzZSgpLlxuICAgICAgY29uc3QgY2hhbm5lbCA9IGV2ZW50LmNoYW5uZWw7XG4gICAgICBjb25zdCBsYWJlbCA9IGNoYW5uZWwubGFiZWw7XG4gICAgICBjb25zdCB3YWl0aW5nID0gdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdO1xuICAgICAgdGhpcy5ub3RlQ2hhbm5lbChjaGFubmVsLCAnZGF0YWNoYW5uZWwgZXZlbnQnLCB3YWl0aW5nKTsgLy8gUmVnYXJkbGVzcyBvZiB3aGV0aGVyIHdlIGFyZSB3YWl0aW5nLlxuICAgICAgaWYgKCF3YWl0aW5nKSByZXR1cm47IC8vIE1pZ2h0IG5vdCBiZSBleHBsaWNpdGx5IHdhaXRpbmcuIEUuZy4sIHJvdXRlcnMuXG4gICAgICBkZWxldGUgdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdO1xuICAgICAgd2FpdGluZyhjaGFubmVsKTtcbiAgICB9KTtcbiAgfVxuICBjbG9zZSgpIHtcbiAgICBpZiAodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2ZhaWxlZCcpIHRoaXMuX3NpZ25hbFByb21pc2U/LnJlamVjdD8uKCk7XG4gICAgc3VwZXIuY2xvc2UoKTtcbiAgICB0aGlzLmNsZWFySWNlVGltZXIoKTtcbiAgICB0aGlzLl9zaWduYWxQcm9taXNlID0gdGhpcy5fc2lnbmFsUmVhZHkgPSBudWxsO1xuICAgIHRoaXMuc2VuZGluZyA9IFtdO1xuICAgIC8vIElmIHRoZSB3ZWJydGMgaW1wbGVtZW50YXRpb24gY2xvc2VzIHRoZSBkYXRhIGNoYW5uZWxzIGJlZm9yZSB0aGUgcGVlciBpdHNlbGYsIHRoZW4gdGhpcy5kYXRhQ2hhbm5lbHMgd2lsbCBiZSBlbXB0eS5cbiAgICAvLyBCdXQgaWYgbm90IChlLmcuLCBzdGF0dXMgJ2ZhaWxlZCcgb3IgJ2Rpc2Nvbm5lY3RlZCcgb24gU2FmYXJpKSwgdGhlbiBsZXQgdXMgZXhwbGljaXRseSBjbG9zZSB0aGVtIHNvIHRoYXQgU3luY2hyb25pemVycyBrbm93IHRvIGNsZWFuIHVwLlxuICAgIGZvciAoY29uc3QgY2hhbm5lbCBvZiB0aGlzLmRhdGFDaGFubmVscy52YWx1ZXMoKSkge1xuICAgICAgaWYgKGNoYW5uZWwucmVhZHlTdGF0ZSAhPT0gJ29wZW4nKSBjb250aW51ZTsgLy8gS2VlcCBkZWJ1Z2dpbmcgc2FuaXR5LlxuICAgICAgLy8gSXQgYXBwZWFycyB0aGF0IGluIFNhZmFyaSAoMTguNSkgZm9yIGEgY2FsbCB0byBjaGFubmVsLmNsb3NlKCkgd2l0aCB0aGUgY29ubmVjdGlvbiBhbHJlYWR5IGludGVybmFsbCBjbG9zZWQsIFNhZmFyaVxuICAgICAgLy8gd2lsbCBzZXQgY2hhbm5lbC5yZWFkeVN0YXRlIHRvICdjbG9zaW5nJywgYnV0IE5PVCBmaXJlIHRoZSBjbG9zZWQgb3IgY2xvc2luZyBldmVudC4gU28gd2UgaGF2ZSB0byBkaXNwYXRjaCBpdCBvdXJzZWx2ZXMuXG4gICAgICAvL2NoYW5uZWwuY2xvc2UoKTtcbiAgICAgIGNoYW5uZWwuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2Nsb3NlJykpO1xuICAgIH1cbiAgfVxufVxuXG4vLyBOZWdvdGlhdGVkIGNoYW5uZWxzIHVzZSBzcGVjaWZpYyBpbnRlZ2VycyBvbiBib3RoIHNpZGVzLCBzdGFydGluZyB3aXRoIHRoaXMgbnVtYmVyLlxuLy8gV2UgZG8gbm90IHN0YXJ0IGF0IHplcm8gYmVjYXVzZSB0aGUgbm9uLW5lZ290aWF0ZWQgY2hhbm5lbHMgKGFzIHVzZWQgb24gc2VydmVyIHJlbGF5cykgZ2VuZXJhdGUgdGhlaXJcbi8vIG93biBpZHMgc3RhcnRpbmcgd2l0aCAwLCBhbmQgd2UgZG9uJ3Qgd2FudCB0byBjb25mbGljdC5cbi8vIFRoZSBzcGVjIHNheXMgdGhlc2UgY2FuIGdvIHRvIDY1LDUzNCwgYnV0IEkgZmluZCB0aGF0IHN0YXJ0aW5nIGdyZWF0ZXIgdGhhbiB0aGUgdmFsdWUgaGVyZSBnaXZlcyBlcnJvcnMuXG5jb25zdCBCQVNFX0NIQU5ORUxfSUQgPSAxMDAwO1xuZXhwb3J0IGNsYXNzIFNoYXJlZFdlYlJUQyBleHRlbmRzIFByb21pc2VXZWJSVEMge1xuICBzdGF0aWMgY29ubmVjdGlvbnMgPSBuZXcgTWFwKCk7XG4gIHN0YXRpYyBlbnN1cmUoe3NlcnZpY2VMYWJlbCwgbXVsdGlwbGV4ID0gdHJ1ZSwgLi4ucmVzdH0pIHtcbiAgICBsZXQgY29ubmVjdGlvbiA9IHRoaXMuY29ubmVjdGlvbnMuZ2V0KHNlcnZpY2VMYWJlbCk7XG4gICAgLy8gSXQgaXMgcG9zc2libGUgdGhhdCB3ZSB3ZXJlIGJhY2tncm91bmRlZCBiZWZvcmUgd2UgaGFkIGEgY2hhbmNlIHRvIGFjdCBvbiBhIGNsb3NpbmcgY29ubmVjdGlvbiBhbmQgcmVtb3ZlIGl0LlxuICAgIGlmIChjb25uZWN0aW9uKSB7XG4gICAgICBjb25zdCB7Y29ubmVjdGlvblN0YXRlLCBzaWduYWxpbmdTdGF0ZX0gPSBjb25uZWN0aW9uLnBlZXI7XG4gICAgICBpZiAoKGNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2Nsb3NlZCcpIHx8IChzaWduYWxpbmdTdGF0ZSA9PT0gJ2Nsb3NlZCcpKSBjb25uZWN0aW9uID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFjb25uZWN0aW9uKSB7XG4gICAgICBjb25uZWN0aW9uID0gbmV3IHRoaXMoe2xhYmVsOiBzZXJ2aWNlTGFiZWwsIHV1aWQ6IHV1aWQ0KCksIG11bHRpcGxleCwgLi4ucmVzdH0pO1xuICAgICAgaWYgKG11bHRpcGxleCkgdGhpcy5jb25uZWN0aW9ucy5zZXQoc2VydmljZUxhYmVsLCBjb25uZWN0aW9uKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvbm5lY3Rpb247XG4gIH1cbiAgY2hhbm5lbElkID0gQkFTRV9DSEFOTkVMX0lEO1xuICBnZXQgaGFzU3RhcnRlZENvbm5lY3RpbmcoKSB7XG4gICAgcmV0dXJuIHRoaXMuY2hhbm5lbElkID4gQkFTRV9DSEFOTkVMX0lEO1xuICB9XG4gIGNsb3NlKHJlbW92ZUNvbm5lY3Rpb24gPSB0cnVlKSB7XG4gICAgdGhpcy5jaGFubmVsSWQgPSBCQVNFX0NIQU5ORUxfSUQ7XG4gICAgc3VwZXIuY2xvc2UoKTtcbiAgICBpZiAocmVtb3ZlQ29ubmVjdGlvbikgdGhpcy5jb25zdHJ1Y3Rvci5jb25uZWN0aW9ucy5kZWxldGUodGhpcy5zZXJ2aWNlTGFiZWwpO1xuICB9XG4gIGFzeW5jIGVuc3VyZURhdGFDaGFubmVsKGNoYW5uZWxOYW1lLCBjaGFubmVsT3B0aW9ucyA9IHt9LCBzaWduYWxzID0gbnVsbCkgeyAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciBhbiBvcGVuIGRhdGEgY2hhbm5lbCBvbiB0aGlzIGNvbm5lY3Rpb24uXG4gICAgY29uc3QgaGFzU3RhcnRlZENvbm5lY3RpbmcgPSB0aGlzLmhhc1N0YXJ0ZWRDb25uZWN0aW5nOyAvLyBNdXN0IGFzayBiZWZvcmUgaW5jcmVtZW50aW5nIGlkLlxuICAgIGNvbnN0IGlkID0gdGhpcy5jaGFubmVsSWQrKzsgLy8gVGhpcyBhbmQgZXZlcnl0aGluZyBsZWFkaW5nIHVwIHRvIGl0IG11c3QgYmUgc3luY2hyb25vdXMsIHNvIHRoYXQgaWQgYXNzaWdubWVudCBpcyBkZXRlcm1pbmlzdGljLlxuICAgIGNvbnN0IG5lZ290aWF0ZWQgPSAodGhpcy5tdWx0aXBsZXggPT09ICduZWdvdGlhdGVkJykgJiYgaGFzU3RhcnRlZENvbm5lY3Rpbmc7XG4gICAgY29uc3QgYWxsb3dPdGhlclNpZGVUb0NyZWF0ZSA9ICFoYXNTdGFydGVkQ29ubmVjdGluZyAvKiFuZWdvdGlhdGVkKi8gJiYgISFzaWduYWxzOyAvLyBPbmx5IHRoZSAwdGggd2l0aCBzaWduYWxzIHdhaXRzIHBhc3NpdmVseS5cbiAgICAvLyBzaWduYWxzIGlzIGVpdGhlciBudWxsaXNoIG9yIGFuIGFycmF5IG9mIHNpZ25hbHMsIGJ1dCB0aGF0IGFycmF5IGNhbiBiZSBFTVBUWSxcbiAgICAvLyBpbiB3aGljaCBjYXNlIHRoZSByZWFsIHNpZ25hbHMgd2lsbCBoYXZlIHRvIGJlIGFzc2lnbmVkIGxhdGVyLiBUaGlzIGFsbG93cyB0aGUgZGF0YSBjaGFubmVsIHRvIGJlIHN0YXJ0ZWQgKGFuZCB0byBjb25zdW1lXG4gICAgLy8gYSBjaGFubmVsSWQpIHN5bmNocm9ub3VzbHksIGJ1dCB0aGUgcHJvbWlzZSB3b24ndCByZXNvbHZlIHVudGlsIHRoZSByZWFsIHNpZ25hbHMgYXJlIHN1cHBsaWVkIGxhdGVyLiBUaGlzIGlzXG4gICAgLy8gdXNlZnVsIGluIG11bHRpcGxleGluZyBhbiBvcmRlcmVkIHNlcmllcyBvZiBkYXRhIGNoYW5uZWxzIG9uIGFuIEFOU1dFUiBjb25uZWN0aW9uLCB3aGVyZSB0aGUgZGF0YSBjaGFubmVscyBtdXN0XG4gICAgLy8gbWF0Y2ggdXAgd2l0aCBhbiBPRkZFUiBjb25uZWN0aW9uIG9uIGEgcGVlci4gVGhpcyB3b3JrcyBiZWNhdXNlIG9mIHRoZSB3b25kZXJmdWwgaGFwcGVuc3RhbmNlIHRoYXQgYW5zd2VyIGNvbm5lY3Rpb25zXG4gICAgLy8gZ2V0RGF0YUNoYW5uZWxQcm9taXNlICh3aGljaCBkb2Vzbid0IHJlcXVpcmUgdGhlIGNvbm5lY3Rpb24gdG8geWV0IGJlIG9wZW4pIHJhdGhlciB0aGFuIGNyZWF0ZURhdGFDaGFubmVsICh3aGljaCB3b3VsZFxuICAgIC8vIHJlcXVpcmUgdGhlIGNvbm5lY3Rpb24gdG8gYWxyZWFkeSBiZSBvcGVuKS5cbiAgICBjb25zdCB1c2VTaWduYWxzID0gIWhhc1N0YXJ0ZWRDb25uZWN0aW5nICYmIHNpZ25hbHM/Lmxlbmd0aDtcbiAgICBjb25zdCBvcHRpb25zID0gbmVnb3RpYXRlZCA/IHtpZCwgbmVnb3RpYXRlZCwgLi4uY2hhbm5lbE9wdGlvbnN9IDogY2hhbm5lbE9wdGlvbnM7XG4gICAgaWYgKGhhc1N0YXJ0ZWRDb25uZWN0aW5nKSB7XG4gICAgICBhd2FpdCB0aGlzLmNvbm5lY3RlZDsgLy8gQmVmb3JlIGNyZWF0aW5nIHByb21pc2UuXG4gICAgfSBlbHNlIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICB0aGlzLnNpZ25hbHMgPSBzaWduYWxzO1xuICAgIH1cbiAgICBjb25zdCBwcm9taXNlID0gYWxsb3dPdGhlclNpZGVUb0NyZWF0ZSA/XG5cdCAgdGhpcy5nZXREYXRhQ2hhbm5lbFByb21pc2UoY2hhbm5lbE5hbWUpIDpcblx0ICB0aGlzLmNyZWF0ZURhdGFDaGFubmVsKGNoYW5uZWxOYW1lLCBvcHRpb25zKTtcbiAgICByZXR1cm4gYXdhaXQgcHJvbWlzZTtcbiAgfVxufVxuIiwiLy8gbmFtZS92ZXJzaW9uIG9mIFwiZGF0YWJhc2VcIlxuZXhwb3J0IGNvbnN0IHN0b3JhZ2VOYW1lID0gJ2ZsZXhzdG9yZSc7XG5leHBvcnQgY29uc3Qgc3RvcmFnZVZlcnNpb24gPSA3O1xuXG5pbXBvcnQgKiBhcyBwa2cgZnJvbSBcIi4uL3BhY2thZ2UuanNvblwiIHdpdGggeyB0eXBlOiAnanNvbicgfTtcbmV4cG9ydCBjb25zdCB7bmFtZSwgdmVyc2lvbn0gPSBwa2cuZGVmYXVsdDtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB7IHRhZ1BhdGggfSBmcm9tICcuL3RhZ1BhdGgubWpzJztcbmltcG9ydCB7IFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vd2VicnRjLm1qcyc7XG5pbXBvcnQgeyBzdG9yYWdlVmVyc2lvbiB9IGZyb20gJy4vdmVyc2lvbi5tanMnO1xuXG4vKlxuICBSZXNwb25zaWJsZSBmb3Iga2VlcGluZyBhIGNvbGxlY3Rpb24gc3luY2hyb25pemVkIHdpdGggYW5vdGhlciBwZWVyLlxuICAoUGVlcnMgbWF5IGJlIGEgY2xpZW50IG9yIGEgc2VydmVyL3JlbGF5LiBJbml0aWFsbHkgdGhpcyBpcyB0aGUgc2FtZSBjb2RlIGVpdGhlciB3YXksXG4gIGJ1dCBsYXRlciBvbiwgb3B0aW1pemF0aW9ucyBjYW4gYmUgbWFkZSBmb3Igc2NhbGUuKVxuXG4gIEFzIGxvbmcgYXMgdHdvIHBlZXJzIGFyZSBjb25uZWN0ZWQgd2l0aCBhIFN5bmNocm9uaXplciBvbiBlYWNoIHNpZGUsIHdyaXRpbmcgaGFwcGVuc1xuICBpbiBib3RoIHBlZXJzIGluIHJlYWwgdGltZSwgYW5kIHJlYWRpbmcgcHJvZHVjZXMgdGhlIGNvcnJlY3Qgc3luY2hyb25pemVkIHJlc3VsdCBmcm9tIGVpdGhlci5cbiAgVW5kZXIgdGhlIGhvb2QsIHRoZSBzeW5jaHJvbml6ZXIga2VlcHMgdHJhY2sgb2Ygd2hhdCBpdCBrbm93cyBhYm91dCB0aGUgb3RoZXIgcGVlciAtLVxuICBhIHBhcnRpY3VsYXIgdGFnIGNhbiBiZSB1bmtub3duLCB1bnN5bmNocm9uaXplZCwgb3Igc3luY2hyb25pemVkLCBhbmQgcmVhZGluZyB3aWxsXG4gIGNvbW11bmljYXRlIGFzIG5lZWRlZCB0byBnZXQgdGhlIGRhdGEgc3luY2hyb25pemVkIG9uLWRlbWFuZC4gTWVhbndoaWxlLCBzeW5jaHJvbml6YXRpb25cbiAgY29udGludWVzIGluIHRoZSBiYWNrZ3JvdW5kIHVudGlsIHRoZSBjb2xsZWN0aW9uIGlzIGZ1bGx5IHJlcGxpY2F0ZWQuXG5cbiAgQSBjb2xsZWN0aW9uIG1haW50YWlucyBhIHNlcGFyYXRlIFN5bmNocm9uaXplciBmb3IgZWFjaCBvZiB6ZXJvIG9yIG1vcmUgcGVlcnMsIGFuZCBjYW4gZHluYW1pY2FsbHlcbiAgYWRkIGFuZCByZW1vdmUgbW9yZS5cblxuICBOYW1pbmcgY29udmVudGlvbnM6XG5cbiAgbXVtYmxlTmFtZTogYSBzZW1hbnRpYyBuYW1lIHVzZWQgZXh0ZXJuYWxseSBhcyBhIGtleS4gRXhhbXBsZTogc2VydmljZU5hbWUsIGNoYW5uZWxOYW1lLCBldGMuXG4gICAgV2hlbiB0aGluZ3MgbmVlZCB0byBtYXRjaCB1cCBhY3Jvc3Mgc3lzdGVtcywgaXQgaXMgYnkgbmFtZS5cbiAgICBJZiBvbmx5IG9uZSBvZiBuYW1lL2xhYmVsIGlzIHNwZWNpZmllZCwgdGhpcyBpcyB1c3VhbGx5IHRoZSB0aGUgb25lLlxuXG4gIG11bWJsZUxhYmVsOiBhIGxhYmVsIGZvciBpZGVudGlmaWNhdGlvbiBhbmQgaW50ZXJuYWxseSAoZS5nLiwgZGF0YWJhc2UgbmFtZSkuXG4gICAgV2hlbiB0d28gaW5zdGFuY2VzIG9mIHNvbWV0aGluZyBhcmUgXCJ0aGUgc2FtZVwiIGJ1dCBhcmUgaW4gdGhlIHNhbWUgSmF2YXNjcmlwdCBpbWFnZSBmb3IgdGVzdGluZywgdGhleSBhcmUgZGlzdGluZ3Vpc2hlZCBieSBsYWJlbC5cbiAgICBUeXBpY2FsbHkgZGVmYXVsdHMgdG8gbXVtYmxlTmFtZS5cblxuICBOb3RlLCB0aG91Z2gsIHRoYXQgc29tZSBleHRlcm5hbCBtYWNoaW5lcnkgKHN1Y2ggYXMgYSBXZWJSVEMgRGF0YUNoYW5uZWwpIGhhcyBhIFwibGFiZWxcIiBwcm9wZXJ0eSB0aGF0IHdlIHBvcHVsYXRlIHdpdGggYSBcIm5hbWVcIiAoY2hhbm5lbE5hbWUpLlxuICovXG5leHBvcnQgY2xhc3MgU3luY2hyb25pemVyIHtcbiAgY29uc3RydWN0b3Ioe3NlcnZpY2VOYW1lID0gJ2RpcmVjdCcsIGNvbGxlY3Rpb24sIGVycm9yID0gY29sbGVjdGlvbj8uY29uc3RydWN0b3IuZXJyb3IgfHwgY29uc29sZS5lcnJvcixcblx0ICAgICAgIHNlcnZpY2VMYWJlbCA9IGNvbGxlY3Rpb24/LnNlcnZpY2VMYWJlbCB8fCBzZXJ2aWNlTmFtZSwgLy8gVXNlZCB0byBpZGVudGlmeSBhbnkgZXhpc3RpbmcgY29ubmVjdGlvbi4gQ2FuIGJlIGRpZmZlcmVudCBmcm9tIHNlcnZpY2VOYW1lIGR1cmluZyB0ZXN0aW5nLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sIGNvbm5lY3Rpb24sIC8vIENvbXBsZXggZGVmYXVsdCBiZWhhdmlvciBmb3IgdGhlc2UuIFNlZSBjb2RlLlxuXHQgICAgICAgbXVsdGlwbGV4ID0gY29sbGVjdGlvbj8ubXVsdGlwbGV4LCAvLyBJZiBzcGVjaWZlZCwgb3RoZXJ3aXNlIHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LiBTZWUgYmVsb3cuXG5cdCAgICAgICBkZWJ1ZyA9IGNvbGxlY3Rpb24/LmRlYnVnLCBtaW5WZXJzaW9uID0gc3RvcmFnZVZlcnNpb24sIG1heFZlcnNpb24gPSBtaW5WZXJzaW9ufSkge1xuICAgIC8vIHNlcnZpY2VOYW1lIGlzIGEgc3RyaW5nIG9yIG9iamVjdCB0aGF0IGlkZW50aWZpZXMgd2hlcmUgdGhlIHN5bmNocm9uaXplciBzaG91bGQgY29ubmVjdC4gRS5nLiwgaXQgbWF5IGJlIGEgVVJMIGNhcnJ5aW5nXG4gICAgLy8gICBXZWJSVEMgc2lnbmFsaW5nLiBJdCBzaG91bGQgYmUgYXBwLXVuaXF1ZSBmb3IgdGhpcyBwYXJ0aWN1bGFyIHNlcnZpY2UgKGUuZy4sIHdoaWNoIG1pZ2h0IG11bHRpcGxleCBkYXRhIGZvciBtdWx0aXBsZSBjb2xsZWN0aW9uIGluc3RhbmNlcykuXG4gICAgLy8gdXVpZCBoZWxwIHVuaXF1ZWx5IGlkZW50aWZpZXMgdGhpcyBwYXJ0aWN1bGFyIHN5bmNocm9uaXplci5cbiAgICAvLyAgIEZvciBtb3N0IHB1cnBvc2VzLCB1dWlkIHNob3VsZCBnZXQgdGhlIGRlZmF1bHQsIGFuZCByZWZlcnMgdG8gT1VSIGVuZC5cbiAgICAvLyAgIEhvd2V2ZXIsIGEgc2VydmVyIHRoYXQgY29ubmVjdHMgdG8gYSBidW5jaCBvZiBwZWVycyBtaWdodCBiYXNoIGluIHRoZSB1dWlkIHdpdGggdGhhdCBvZiB0aGUgb3RoZXIgZW5kLCBzbyB0aGF0IGxvZ2dpbmcgaW5kaWNhdGVzIHRoZSBjbGllbnQuXG4gICAgLy8gSWYgY2hhbm5lbE5hbWUgaXMgc3BlY2lmaWVkLCBpdCBzaG91bGQgYmUgaW4gdGhlIGZvcm0gb2YgY29sbGVjdGlvblR5cGUvY29sbGVjdGlvbk5hbWUgKGUuZy4sIGlmIGNvbm5lY3RpbmcgdG8gcmVsYXkpLlxuICAgIGNvbnN0IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgPSBzZXJ2aWNlTmFtZS5zdGFydHNXaXRoPy4oJ2h0dHAnKTtcbiAgICBpZiAoIWNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgKHJ0Y0NvbmZpZ3VyYXRpb24gPT09IHVuZGVmaW5lZCkpIHJ0Y0NvbmZpZ3VyYXRpb24gPSB7fTsgLy8gRXhwaWNpdGx5IG5vIGljZS4gTEFOIG9ubHkuXG4gICAgLy8gbXVsdGlwbGV4IHNob3VsZCBlbmQgdXAgd2l0aCBvbmUgb2YgdGhyZWUgdmFsdWVzOlxuICAgIC8vIGZhbHN5IC0gYSBuZXcgY29ubmVjdGlvbiBzaG91bGQgYmUgdXNlZCBmb3IgZWFjaCBjaGFubmVsXG4gICAgLy8gXCJuZWdvdGlhdGVkXCIgLSBib3RoIHNpZGVzIGNyZWF0ZSB0aGUgc2FtZSBjaGFubmVsTmFtZXMgaW4gdGhlIHNhbWUgb3JkZXIgKG1vc3QgY2FzZXMpOlxuICAgIC8vICAgICBUaGUgaW5pdGlhbCBzaWduYWxsaW5nIHdpbGwgYmUgdHJpZ2dlcmVkIGJ5IG9uZSBzaWRlIGNyZWF0aW5nIGEgY2hhbm5lbCwgYW5kIHRoZXIgc2lkZSB3YWl0aW5nIGZvciBpdCB0byBiZSBjcmVhdGVkLlxuICAgIC8vICAgICBBZnRlciB0aGF0LCBib3RoIHNpZGVzIHdpbGwgZXhwbGljaXRseSBjcmVhdGUgYSBkYXRhIGNoYW5uZWwgYW5kIHdlYnJ0YyB3aWxsIG1hdGNoIHRoZW0gdXAgYnkgaWQuXG4gICAgLy8gYW55IG90aGVyIHRydXRoeSAtIFN0YXJ0cyBsaWtlIG5lZ290aWF0ZWQsIGFuZCB0aGVuIGNvbnRpbnVlcyB3aXRoIG9ubHkgd2lkZSBzaWRlIGNyZWF0aW5nIHRoZSBjaGFubmVscywgYW5kIHRoZXIgb3RoZXJcbiAgICAvLyAgICAgb2JzZXJ2ZXMgdGhlIGNoYW5uZWwgdGhhdCBoYXMgYmVlbiBtYWRlLiBUaGlzIGlzIHVzZWQgZm9yIHJlbGF5cy5cbiAgICBtdWx0aXBsZXggPz89IGNvbm5lY3Rpb24/Lm11bHRpcGxleDsgLy8gU3RpbGwgdHlwaWNhbGx5IHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LlxuICAgIG11bHRpcGxleCA/Pz0gKHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zeW5jJykgfHwgJ25lZ290aWF0ZWQnKTtcbiAgICBjb25uZWN0aW9uID8/PSBTaGFyZWRXZWJSVEMuZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIGNvbmZpZ3VyYXRpb246IHJ0Y0NvbmZpZ3VyYXRpb24sIG11bHRpcGxleCwgZGVidWcsIGVycm9yfSk7XG5cbiAgICB1dWlkID8/PSBjb25uZWN0aW9uLnV1aWQ7XG4gICAgLy8gQm90aCBwZWVycyBtdXN0IGFncmVlIG9uIGNoYW5uZWxOYW1lLiBVc3VhbGx5LCB0aGlzIGlzIGNvbGxlY3Rpb24uZnVsbE5hbWUuIEJ1dCBpbiB0ZXN0aW5nLCB3ZSBtYXkgc3luYyB0d28gY29sbGVjdGlvbnMgd2l0aCBkaWZmZXJlbnQgbmFtZXMuXG4gICAgY2hhbm5lbE5hbWUgPz89IGNvbGxlY3Rpb24/LmNoYW5uZWxOYW1lIHx8IGNvbGxlY3Rpb24uZnVsbE5hbWU7XG4gICAgY29uc3QgbGFiZWwgPSBgJHtjb2xsZWN0aW9uPy5mdWxsTGFiZWwgfHwgY2hhbm5lbE5hbWV9LyR7dXVpZH1gO1xuICAgIC8vIFdoZXJlIHdlIGNhbiByZXF1ZXN0IGEgZGF0YSBjaGFubmVsIHRoYXQgcHVzaGVzIHB1dC9kZWxldGUgcmVxdWVzdHMgZnJvbSBvdGhlcnMuXG4gICAgY29uc3QgY29ubmVjdGlvblVSTCA9IHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zaWduYWwvJykgPyBzZXJ2aWNlTmFtZSA6IGAke3NlcnZpY2VOYW1lfS8ke2xhYmVsfWA7XG5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzZXJ2aWNlTmFtZSwgbGFiZWwsIGNvbGxlY3Rpb24sIGRlYnVnLCBlcnJvciwgbWluVmVyc2lvbiwgbWF4VmVyc2lvbiwgdXVpZCwgcnRjQ29uZmlndXJhdGlvbixcblx0XHRcdCBjb25uZWN0aW9uLCB1dWlkLCBjaGFubmVsTmFtZSwgY29ubmVjdGlvblVSTCxcblx0XHRcdCBjb25uZWN0aW9uU3RhcnRUaW1lOiBEYXRlLm5vdygpLFxuXHRcdFx0IGNsb3NlZDogdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCksXG5cdFx0XHQgLy8gTm90IHVzZWQgeWV0LCBidXQgY291bGQgYmUgdXNlZCB0byBHRVQgcmVzb3VyY2VzIG92ZXIgaHR0cCBpbnN0ZWFkIG9mIHRocm91Z2ggdGhlIGRhdGEgY2hhbm5lbC5cblx0XHRcdCBob3N0UmVxdWVzdEJhc2U6IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgYCR7c2VydmljZU5hbWUucmVwbGFjZSgvXFwvKHN5bmN8c2lnbmFsKS8pfS8ke2NoYW5uZWxOYW1lfWB9KTtcbiAgICBjb2xsZWN0aW9uPy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgdGhpcyk7IC8vIE11c3QgYmUgc2V0IHN5bmNocm9ub3VzbHksIHNvIHRoYXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEga25vd3MgdG8gd2FpdC5cbiAgfVxuICBzdGF0aWMgYXN5bmMgY3JlYXRlKGNvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCBvcHRpb25zID0ge30pIHsgLy8gUmVjZWl2ZSBwdXNoZWQgbWVzc2FnZXMgZnJvbSB0aGUgZ2l2ZW4gc2VydmljZS4gZ2V0L3B1dC9kZWxldGUgd2hlbiB0aGV5IGNvbWUgKHdpdGggZW1wdHkgc2VydmljZXMgbGlzdCkuXG4gICAgY29uc3Qgc3luY2hyb25pemVyID0gbmV3IHRoaXMoe2NvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCAuLi5vcHRpb25zfSk7XG4gICAgY29uc3QgY29ubmVjdGVkUHJvbWlzZSA9IHN5bmNocm9uaXplci5jb25uZWN0Q2hhbm5lbCgpOyAvLyBFc3RhYmxpc2ggY2hhbm5lbCBjcmVhdGlvbiBvcmRlci5cbiAgICBjb25zdCBjb25uZWN0ZWQgPSBhd2FpdCBjb25uZWN0ZWRQcm9taXNlO1xuICAgIGlmICghY29ubmVjdGVkKSByZXR1cm4gc3luY2hyb25pemVyO1xuICAgIHJldHVybiBhd2FpdCBjb25uZWN0ZWQuc3luY2hyb25pemUoKTtcbiAgfVxuICBhc3luYyBjb25uZWN0Q2hhbm5lbCgpIHsgLy8gU3luY2hyb25vdXNseSBpbml0aWFsaXplIGFueSBwcm9taXNlcyB0byBjcmVhdGUgYSBkYXRhIGNoYW5uZWwsIGFuZCB0aGVuIGF3YWl0IGNvbm5lY3Rpb24uXG4gICAgY29uc3Qge2hvc3RSZXF1ZXN0QmFzZSwgdXVpZCwgY29ubmVjdGlvbiwgc2VydmljZU5hbWV9ID0gdGhpcztcbiAgICBsZXQgc3RhcnRlZCA9IGNvbm5lY3Rpb24uaGFzU3RhcnRlZENvbm5lY3Rpbmc7XG4gICAgaWYgKHN0YXJ0ZWQpIHtcbiAgICAgIC8vIFdlIGFscmVhZHkgaGF2ZSBhIGNvbm5lY3Rpb24uIEp1c3Qgb3BlbiBhbm90aGVyIGRhdGEgY2hhbm5lbCBmb3Igb3VyIHVzZS5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zaWduYWwvYW5zd2VyJykpIHsgLy8gUG9zdCBhbiBhbnN3ZXIgdG8gYW4gb2ZmZXIgd2UgZ2VuZXJhdGUgZm9yIGEgcmVuZGV2b3VzIHBlZXIuXG4gICAgICBzdGFydGVkID0gdGhpcy5jb25uZWN0U2VydmVyKCk7IC8vIEp1c3QgbGlrZSBhIHN5bmNcbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3NpZ25hbC9vZmZlcicpKSB7IC8vIEdldCBhbiBvZmZlciBmcm9tIGEgcmVuZGV2b3VzIHBlZXIgYW5kIHBvc3QgYW4gYW5zd2VyLlxuICAgICAgLy8gV2UgbXVzdCBzeWNocm9ub3VzbHkgc3RhcnRDb25uZWN0aW9uIG5vdyBzbyB0aGF0IG91ciBjb25uZWN0aW9uIGhhc1N0YXJ0ZWRDb25uZWN0aW5nLCBhbmQgYW55IHN1YnNlcXVlbnQgZGF0YSBjaGFubmVsXG4gICAgICAvLyByZXF1ZXN0cyBvbiB0aGUgc2FtZSBjb25uZWN0aW9uIHdpbGwgd2FpdCAodXNpbmcgdGhlICdzdGFydGVkJyBwYXRoLCBhYm92ZSkuXG4gICAgICBjb25zdCBwcm9taXNlZFNpZ25hbHMgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbihbXSk7IC8vIEVzdGFibGlzaGluZyBvcmRlci5cbiAgICAgIGNvbnN0IHVybCA9IHRoaXMuY29ubmVjdGlvblVSTDtcbiAgICAgIGNvbnN0IG9mZmVyID0gYXdhaXQgdGhpcy5mZXRjaCh1cmwpO1xuICAgICAgdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24ob2ZmZXIpOyAvLyBOb3cgc3VwcGx5IHRob3NlIHNpZ25hbHMgc28gdGhhdCBvdXIgY29ubmVjdGlvbiBjYW4gcHJvZHVjZSBhbnN3ZXIgc2lnYWxzLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuZmV0Y2godXJsLCBhd2FpdCBwcm9taXNlZFNpZ25hbHMpOyAvLyBUZWxsIHRoZSBwZWVyIGFib3V0IG91ciBhbnN3ZXIuXG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zeW5jJykpIHsgLy8gQ29ubmVjdCB3aXRoIGEgc2VydmVyIHJlbGF5LiAoU2lnbmFsIGFuZCBzdGF5IGNvbm5lY3RlZCB0aHJvdWdoIHN5bmMuKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpO1xuICAgIH0gZWxzZSBpZiAoc2VydmljZU5hbWUgPT09ICdzaWduYWxzJykgeyAvLyBTdGFydCBjb25uZWN0aW9uIGFuZCByZXR1cm4gbnVsbC4gTXVzdCBiZSBjb250aW51ZWQgd2l0aCBjb21wbGV0ZVNpZ25hbHNTeW5jaHJvbml6YXRpb24oKTtcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbigpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHNlcnZpY2VOYW1lKSkgeyAvLyBBIGxpc3Qgb2YgXCJyZWNlaXZpbmdcIiBzaWduYWxzLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKHNlcnZpY2VOYW1lKTtcbiAgICB9IGVsc2UgaWYgKHNlcnZpY2VOYW1lLnN5bmNocm9uaXplcnMpIHsgLy8gRHVjayB0eXBpbmcgZm9yIHBhc3NpbmcgYSBjb2xsZWN0aW9uIGRpcmVjdGx5IGFzIHRoZSBzZXJ2aWNlSW5mby4gKFdlIGRvbid0IGltcG9ydCBDb2xsZWN0aW9uLilcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmNvbm5lY3REaXJlY3RUZXN0aW5nKHNlcnZpY2VOYW1lKTsgLy8gVXNlZCBpbiB0ZXN0aW5nLlxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVucmVjb2duaXplZCBzZXJ2aWNlIGZvcm1hdDogJHtzZXJ2aWNlTmFtZX0uYCk7XG4gICAgfVxuICAgIGlmICghKGF3YWl0IHN0YXJ0ZWQpKSB7XG4gICAgICBjb25zb2xlLndhcm4odGhpcy5sYWJlbCwgJ2Nvbm5lY3Rpb24gZmFpbGVkJyk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBsb2coLi4ucmVzdCkge1xuICAgIGlmICh0aGlzLmRlYnVnKSBjb25zb2xlLmxvZyh0aGlzLmxhYmVsLCAuLi5yZXN0KTtcbiAgfVxuICBnZXQgZGF0YUNoYW5uZWxQcm9taXNlKCkgeyAvLyBBIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhbiBvcGVuIGRhdGEgY2hhbm5lbC5cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy5fZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGlmICghcHJvbWlzZSkgdGhyb3cgbmV3IEVycm9yKGAke3RoaXMubGFiZWx9OiBEYXRhIGNoYW5uZWwgaXMgbm90IHlldCBwcm9taXNlZC5gKTtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICBjaGFubmVsQ2xvc2VkQ2xlYW51cCgpIHsgLy8gQm9va2tlZXBpbmcgd2hlbiBjaGFubmVsIGNsb3NlZCBvciBleHBsaWNpdGx5IGFiYW5kb25lZCBiZWZvcmUgb3BlbmluZy5cbiAgICB0aGlzLmNvbGxlY3Rpb24/LnN5bmNocm9uaXplcnMuZGVsZXRlKHRoaXMuc2VydmljZU5hbWUpO1xuICAgIHRoaXMuY2xvc2VkLnJlc29sdmUodGhpcyk7IC8vIFJlc29sdmUgdG8gc3luY2hyb25pemVyIGlzIG5pY2UgaWYsIGUuZywgc29tZW9uZSBpcyBQcm9taXNlLnJhY2luZy5cbiAgfVxuICBzZXQgZGF0YUNoYW5uZWxQcm9taXNlKHByb21pc2UpIHsgLy8gU2V0IHVwIG1lc3NhZ2UgYW5kIGNsb3NlIGhhbmRsaW5nLlxuICAgIHRoaXMuX2RhdGFDaGFubmVsUHJvbWlzZSA9IHByb21pc2UudGhlbihkYXRhQ2hhbm5lbCA9PiB7XG4gICAgICBkYXRhQ2hhbm5lbC5vbm1lc3NhZ2UgPSBldmVudCA9PiB0aGlzLnJlY2VpdmUoZXZlbnQuZGF0YSk7XG4gICAgICBkYXRhQ2hhbm5lbC5vbmNsb3NlID0gYXN5bmMgZXZlbnQgPT4gdGhpcy5jaGFubmVsQ2xvc2VkQ2xlYW51cCgpO1xuICAgICAgcmV0dXJuIGRhdGFDaGFubmVsO1xuICAgIH0pO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplKCkge1xuICAgIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuICBzdGF0aWMgZnJhZ21lbnRJZCA9IDA7XG4gIGFzeW5jIHNlbmQobWV0aG9kLCAuLi5wYXJhbXMpIHsgLy8gU2VuZHMgdG8gdGhlIHBlZXIsIG92ZXIgdGhlIGRhdGEgY2hhbm5lbFxuICAgIC8vIFRPRE86IGJyZWFrIHVwIGxvbmcgbWVzc2FnZXMuIChBcyBhIHByYWN0aWNhbCBtYXR0ZXIsIDE2IEtpQiBpcyB0aGUgbG9uZ2VzdCB0aGF0IGNhbiByZWxpYWJseSBiZSBzZW50IGFjcm9zcyBkaWZmZXJlbnQgd3J0YyBpbXBsZW1lbnRhdGlvbnMuKVxuICAgIC8vIFNlZSBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvV2ViUlRDX0FQSS9Vc2luZ19kYXRhX2NoYW5uZWxzI2NvbmNlcm5zX3dpdGhfbGFyZ2VfbWVzc2FnZXNcbiAgICBjb25zdCBwYXlsb2FkID0gSlNPTi5zdHJpbmdpZnkoe21ldGhvZCwgcGFyYW1zfSk7XG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBjb25zdCBzdGF0ZSA9IGRhdGFDaGFubmVsPy5yZWFkeVN0YXRlIHx8ICdjbG9zZWQnO1xuICAgIGlmIChzdGF0ZSA9PT0gJ2Nsb3NlZCcgfHwgc3RhdGUgPT09ICdjbG9zaW5nJykgcmV0dXJuO1xuICAgIHRoaXMubG9nKCdzZW5kcycsIG1ldGhvZCwgLi4ucGFyYW1zKTtcbiAgICBjb25zdCBzaXplID0gMTZlMzsgLy8gQSBiaXQgbGVzcyB0aGFuIDE2ICogMTAyNC5cbiAgICBpZiAocGF5bG9hZC5sZW5ndGggPCBzaXplKSB7XG4gICAgICBkYXRhQ2hhbm5lbC5zZW5kKHBheWxvYWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBudW1DaHVua3MgPSBNYXRoLmNlaWwocGF5bG9hZC5sZW5ndGggLyBzaXplKTtcbiAgICBjb25zdCBpZCA9IHRoaXMuY29uc3RydWN0b3IuZnJhZ21lbnRJZCsrO1xuICAgIGNvbnN0IG1ldGEgPSB7bWV0aG9kOiAnZnJhZ21lbnRzJywgcGFyYW1zOiBbaWQsIG51bUNodW5rc119O1xuICAgIC8vY29uc29sZS5sb2coYEZyYWdtZW50aW5nIG1lc3NhZ2UgJHtpZH0gaW50byAke251bUNodW5rc30gY2h1bmtzLmAsIG1ldGEpO1xuICAgIGRhdGFDaGFubmVsLnNlbmQoSlNPTi5zdHJpbmdpZnkobWV0YSkpO1xuICAgIC8vIE9wdGltaXphdGlvbiBvcHBvcnR1bml0eTogcmVseSBvbiBtZXNzYWdlcyBiZWluZyBvcmRlcmVkIGFuZCBza2lwIHJlZHVuZGFudCBpbmZvLiBJcyBpdCB3b3J0aCBpdD9cbiAgICBmb3IgKGxldCBpID0gMCwgbyA9IDA7IGkgPCBudW1DaHVua3M7ICsraSwgbyArPSBzaXplKSB7XG4gICAgICBjb25zdCBmcmFnID0ge21ldGhvZDogJ2ZyYWcnLCBwYXJhbXM6IFtpZCwgaSwgcGF5bG9hZC5zdWJzdHIobywgc2l6ZSldfTtcbiAgICAgIGRhdGFDaGFubmVsLnNlbmQoSlNPTi5zdHJpbmdpZnkoZnJhZykpO1xuICAgIH1cbiAgfVxuICByZWNlaXZlKHRleHQpIHsgLy8gRGlzcGF0Y2ggYSBtZXNzYWdlIHNlbnQgb3ZlciB0aGUgZGF0YSBjaGFubmVsIGZyb20gdGhlIHBlZXIuXG4gICAgY29uc3Qge21ldGhvZCwgcGFyYW1zfSA9IEpTT04ucGFyc2UodGV4dCk7XG4gICAgdGhpc1ttZXRob2RdKC4uLnBhcmFtcyk7XG4gIH1cbiAgcGVuZGluZ0ZyYWdtZW50cyA9IHt9O1xuICBmcmFnbWVudHMoaWQsIG51bUNodW5rcykge1xuICAgIC8vY29uc29sZS5sb2coYFJlY2VpdmluZyBtZXNhZ2UgJHtpZH0gaW4gJHtudW1DaHVua3N9LmApO1xuICAgIHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF0gPSB7cmVtYWluaW5nOiBudW1DaHVua3MsIG1lc3NhZ2U6IEFycmF5KG51bUNodW5rcyl9O1xuICB9XG4gIGZyYWcoaWQsIGksIGZyYWdtZW50KSB7XG4gICAgbGV0IGZyYWcgPSB0aGlzLnBlbmRpbmdGcmFnbWVudHNbaWRdOyAvLyBXZSBhcmUgcmVseWluZyBvbiBmcmFnbWVudCBtZXNzYWdlIGNvbWluZyBmaXJzdC5cbiAgICBmcmFnLm1lc3NhZ2VbaV0gPSBmcmFnbWVudDtcbiAgICBpZiAoMCAhPT0gLS1mcmFnLnJlbWFpbmluZykgcmV0dXJuO1xuICAgIC8vY29uc29sZS5sb2coYERpc3BhdGNoaW5nIG1lc3NhZ2UgJHtpZH0uYCk7XG4gICAgdGhpcy5yZWNlaXZlKGZyYWcubWVzc2FnZS5qb2luKCcnKSk7XG4gICAgZGVsZXRlIHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF07XG4gIH1cblxuICBhc3luYyBkaXNjb25uZWN0KCkgeyAvLyBXYWl0IGZvciBkYXRhQ2hhbm5lbCB0byBkcmFpbiBhbmQgcmV0dXJuIGEgcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gYWN0dWFsbHkgY2xvc2VkLFxuICAgIC8vIGJ1dCByZXR1cm4gaW1tZWRpYXRlbHkgaWYgY29ubmVjdGlvbiBub3Qgc3RhcnRlZC5cbiAgICBpZiAodGhpcy5jb25uZWN0aW9uLnBlZXIuY29ubmVjdGlvblN0YXRlICE9PSAnY29ubmVjdGVkJykgcmV0dXJuIHRoaXMuY2hhbm5lbENsb3NlZENsZWFudXAodGhpcy5jb25uZWN0aW9uLmNsb3NlKCkpO1xuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgZGF0YUNoYW5uZWwuY2xvc2UoKTtcbiAgICByZXR1cm4gdGhpcy5jbG9zZWQ7XG4gIH1cbiAgLy8gVE9ETzogd2VicnRjIG5lZ290aWF0aW9uIG5lZWRlZCBkdXJpbmcgc3luYy5cbiAgLy8gVE9ETzogd2VicnRjIG5lZ290aWF0aW9uIG5lZWRlZCBhZnRlciBzeW5jLlxuICBzdGFydENvbm5lY3Rpb24oc2lnbmFsTWVzc2FnZXMpIHsgLy8gTWFjaGluZXJ5IGZvciBtYWtpbmcgYSBXZWJSVEMgY29ubmVjdGlvbiB0byB0aGUgcGVlcjpcbiAgICAvLyAgIElmIHNpZ25hbE1lc3NhZ2VzIGlzIGEgbGlzdCBvZiBbb3BlcmF0aW9uLCBtZXNzYWdlXSBtZXNzYWdlIG9iamVjdHMsIHRoZW4gdGhlIG90aGVyIHNpZGUgaXMgaW5pdGlhdGluZ1xuICAgIC8vIHRoZSBjb25uZWN0aW9uIGFuZCBoYXMgc2VudCBhbiBpbml0aWFsIG9mZmVyL2ljZS4gSW4gdGhpcyBjYXNlLCBjb25uZWN0KCkgcHJvbWlzZXMgYSByZXNwb25zZVxuICAgIC8vIHRvIGJlIGRlbGl2ZXJlZCB0byB0aGUgb3RoZXIgc2lkZS5cbiAgICAvLyAgIE90aGVyd2lzZSwgY29ubmVjdCgpIHByb21pc2VzIGEgbGlzdCBvZiBpbml0aWFsIHNpZ25hbCBtZXNzYWdlcyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUsXG4gICAgLy8gYW5kIGl0IGlzIG5lY2Vzc2FyeSB0byB0aGVuIGNhbGwgY29tcGxldGVDb25uZWN0aW9uKCkgd2l0aCB0aGUgcmVzcG9uc2UgZnJvbSB0aGVtLlxuICAgIC8vIEluIGJvdGggY2FzZXMsIGFzIGEgc2lkZSBlZmZlY3QsIHRoZSBkYXRhQ2hhbm5lbFByb21pc2UgcHJvcGVydHkgd2lsbCBiZSBzZXQgdG8gYSBQcm9taXNlXG4gICAgLy8gdGhhdCByZXNvbHZlcyB0byB0aGUgZGF0YSBjaGFubmVsIHdoZW4gaXQgaXMgb3BlbnMuIFRoaXMgcHJvbWlzZSBpcyB1c2VkIGJ5IHNlbmQoKSBhbmQgcmVjZWl2ZSgpLlxuICAgIGNvbnN0IHtjb25uZWN0aW9ufSA9IHRoaXM7XG4gICAgdGhpcy5sb2coc2lnbmFsTWVzc2FnZXMgPyAnZ2VuZXJhdGluZyBhbnN3ZXInIDogJ2dlbmVyYXRpbmcgb2ZmZXInKTtcbiAgICB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSwge30sIHNpZ25hbE1lc3NhZ2VzKTtcbiAgICByZXR1cm4gY29ubmVjdGlvbi5zaWduYWxzO1xuICB9XG4gIGNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBGaW5pc2ggd2hhdCB3YXMgc3RhcnRlZCB3aXRoIHN0YXJ0Q29sbGVjdGlvbi5cbiAgICAvLyBEb2VzIG5vdCByZXR1cm4gYSBwcm9taXNlLiBDbGllbnQgY2FuIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlIHRvIHNlZSB3aGVuIHdlIGFyZSBhY3R1YWxseSBjb25uZWN0ZWQuXG4gICAgdGhpcy5jb25uZWN0aW9uLnNpZ25hbHMgPSBzaWduYWxNZXNzYWdlcztcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGFzeW5jIGZldGNoKHVybCwgYm9keSA9IG51bGwpIHsgLy8gQXMgSlNPTlxuICAgIGNvbnN0IG1ldGhvZCA9IGJvZHkgPyAnUE9TVCcgOiAnR0VUJztcbiAgICBpZiAodGhpcy5kZWJ1ZykgdGhpcy5sb2cobWV0aG9kLCAnc2lnbmFscycsIHVybCwgSlNPTi5zdHJpbmdpZnkoYm9keSwgbnVsbCwgMikpOyAvLyBUT0RPOiBzdHJpbmdpZnkgaW4gbG9nIGluc3RlYWQgb2YgbmVlZGluZyB0byBndWFyZCB3aXRoIHRoaXMuZGVidWcuXG4gICAgY29uc3QgcmVxdWVzdCA9IGF3YWl0IGZldGNoKHVybCwgYm9keSA/IHttZXRob2QsIGhlYWRlcnM6IHtcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIn0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpfSA6IHttZXRob2R9KVxuXHQgIC5jYXRjaChlcnJvciA9PiB0aGlzLmVycm9yKGAke2Vycm9yLm1lc3NhZ2V9IGZvciAke3VybH1gKSk7XG4gICAgaWYgKCFyZXF1ZXN0KSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIXJlcXVlc3Qub2spIHtcbiAgICAgIHRoaXMuZXJyb3IoYCR7cmVxdWVzdD8uc3RhdHVzVGV4dCB8fCAnRXJyb3InfSwgY29kZSAke3JlcXVlc3Quc3RhdHVzIHx8ICd1bmtub3duJ30sIGluIGZldGNoICR7dXJsfS5gKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0Lmpzb24oKTtcbiAgICBpZiAodGhpcy5kZWJ1ZykgdGhpcy5sb2cobWV0aG9kLCAncmVzcG9uc2VTaWduYWxzJywgdXJsLCBKU09OLnN0cmluZ2lmeShyZXN1bHQsIG51bGwsIDIpKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG4gIGFzeW5jIGNvbm5lY3RTZXJ2ZXIodXJsID0gdGhpcy5jb25uZWN0aW9uVVJMKSB7IC8vIENvbm5lY3QgdG8gYSByZWxheSBvdmVyIGh0dHAuIENvbXBhcmUgY29ubmVjdFJlbmRldm91c1xuICAgIC8vIHN0YXJ0Q29ubmVjdGlvbiwgcG9zdCBpdCwgY29tcGxldGVDb25uZWN0aW9uIHdpdGggdGhlIHJlc3BvbnNlLlxuICAgIC8vIE91ciB3ZWJydGMgc3luY2hyb25pemVyIGlzIHRoZW4gY29ubmVjdGVkIHRvIHRoZSByZWxheSdzIHdlYnJ0IHN5bmNocm9uaXplci5cbiAgICBjb25zdCBvdXJTaWduYWxzUHJvbWlzZSA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7IC8vIG11c3QgYmUgc3luY2hyb25vdXMgdG8gcHJlc2VydmUgY2hhbm5lbCBpZCBvcmRlci5cbiAgICBjb25zdCBvdXJTaWduYWxzID0gYXdhaXQgb3VyU2lnbmFsc1Byb21pc2U7XG4gICAgY29uc3QgdGhlaXJTaWduYWxzID0gYXdhaXQgdGhpcy5mZXRjaCh1cmwsIG91clNpZ25hbHMpO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgICB9IGNhdGNoKGVycm9yKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFdoaWxlIGNvbm5lY3RpbmcgJHt1cmx9LCBvdXIgc2lnbmFsczogJHtKU09OLnN0cmluZ2lmeShvdXJTaWduYWxzKX0sIHRoZWlyIHNpZ25hbHM6ICR7SlNPTi5zdHJpbmdpZnkodGhlaXJTaWduYWxzKX0uYCwgZXJyb3IpO1xuICAgIH07XG4gIH1cbiAgYXN5bmMgY29tcGxldGVTaWduYWxzU3luY2hyb25pemF0aW9uKHNpZ25hbHMpIHsgLy8gR2l2ZW4gYW5zd2VyL2ljZSBzaWduYWxzLCBjb21wbGV0ZSB0aGUgY29ubmVjdGlvbiBhbmQgc3RhcnQgc3luY2hyb25pemUuXG4gICAgYXdhaXQgdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24oc2lnbmFscyk7XG4gICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZSgpO1xuICB9XG4gIGFzeW5jIGNvbm5lY3REaXJlY3RUZXN0aW5nKHBlZXJDb2xsZWN0aW9uKSB7IC8vIFVzZWQgaW4gdW5pdCB0ZXN0aW5nLCB3aGVyZSB0aGUgXCJyZW1vdGVcIiBzZXJ2aWNlIGlzIHNwZWNpZmllZCBkaXJlY3RseSAobm90IGEgc3RyaW5nKS5cbiAgICAvLyBFYWNoIGNvbGxlY3Rpb24gaXMgYXNrZWQgdG8gc3ljaHJvbml6ZSB0byBhbm90aGVyIGNvbGxlY3Rpb24uXG4gICAgY29uc3QgcGVlclN5bmNocm9uaXplciA9IHBlZXJDb2xsZWN0aW9uLnN5bmNocm9uaXplcnMuZ2V0KHRoaXMuY29sbGVjdGlvbik7XG4gICAgaWYgKCFwZWVyU3luY2hyb25pemVyKSB7IC8vIFRoZSBvdGhlciBzaWRlIGRvZXNuJ3Qga25vdyBhYm91dCB1cyB5ZXQuIFRoZSBvdGhlciBzaWRlIHdpbGwgZG8gdGhlIHdvcmsuXG4gICAgICB0aGlzLl9kZWxheSA9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCBvdXJTaWduYWxzID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTtcbiAgICBjb25zdCB0aGVpclNpZ25hbHMgPSBhd2FpdCBwZWVyU3luY2hyb25pemVyLnN0YXJ0Q29ubmVjdGlvbihhd2FpdCBvdXJTaWduYWxzKTtcbiAgICBwZWVyU3luY2hyb25pemVyLl9kZWxheS5yZXNvbHZlKCk7XG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVDb25uZWN0aW9uKHRoZWlyU2lnbmFscyk7XG4gIH1cblxuICAvLyBBIGNvbW1vbiBwcmFjdGljZSBoZXJlIGlzIHRvIGhhdmUgYSBwcm9wZXJ0eSB0aGF0IGlzIGEgcHJvbWlzZSBmb3IgaGF2aW5nIHNvbWV0aGluZyBkb25lLlxuICAvLyBBc3luY2hyb25vdXMgbWFjaGluZXJ5IGNhbiB0aGVuIHJlc29sdmUgaXQuXG4gIC8vIEFueXRoaW5nIHRoYXQgZGVwZW5kcyBvbiB0aGF0IGNhbiBhd2FpdCB0aGUgcmVzb2x2ZWQgdmFsdWUsIHdpdGhvdXQgd29ycnlpbmcgYWJvdXQgaG93IGl0IGdldHMgcmVzb2x2ZWQuXG4gIC8vIFdlIGNhY2hlIHRoZSBwcm9taXNlIHNvIHRoYXQgd2UgZG8gbm90IHJlcGV0ZWRseSB0cmlnZ2VyIHRoZSB1bmRlcmx5aW5nIGFjdGlvbi5cbiAgbWFrZVJlc29sdmVhYmxlUHJvbWlzZShpZ25vcmVkKSB7IC8vIEFuc3dlciBhIFByb21pc2UgdGhhdCBjYW4gYmUgcmVzb2x2ZSB3aXRoIHRoZVByb21pc2UucmVzb2x2ZSh2YWx1ZSkuXG4gICAgLy8gVGhlIGlnbm9yZWQgYXJndW1lbnQgaXMgYSBjb252ZW5pZW50IHBsYWNlIHRvIGNhbGwgc29tZXRoaW5nIGZvciBzaWRlLWVmZmVjdC5cbiAgICBsZXQgcmVzb2x2ZXI7XG4gICAgY29uc3QgcHJvbWlzZSA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gcmVzb2x2ZXIgPSByZXNvbHZlKTtcbiAgICBwcm9taXNlLnJlc29sdmUgPSByZXNvbHZlcjtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIHZlcnNpb25zKG1pbiwgbWF4KSB7IC8vIE9uIHJlY2VpdmluZyB0aGUgdmVyc2lvbnMgc3VwcG9ydGVkIGJ5IHRoZSB0aGUgcGVlciwgcmVzb2x2ZSB0aGUgdmVyc2lvbiBwcm9taXNlLlxuICAgIGxldCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbjtcbiAgICBjb25zdCBjb21iaW5lZE1heCA9IE1hdGgubWluKG1heCwgdGhpcy5tYXhWZXJzaW9uKTtcbiAgICBjb25zdCBjb21iaW5lZE1pbiA9IE1hdGgubWF4KG1pbiwgdGhpcy5taW5WZXJzaW9uKTtcbiAgICBpZiAoY29tYmluZWRNYXggPj0gY29tYmluZWRNaW4pIHJldHVybiB2ZXJzaW9uUHJvbWlzZS5yZXNvbHZlKGNvbWJpbmVkTWF4KTsgLy8gTm8gbmVlZCB0byByZXNwb25kLCBhcyB0aGV5IHdpbGwgcHJvZHVjZSB0aGUgc2FtZSBkZXRlcm1pbmlzdGljIGFuc3dlci5cbiAgICByZXR1cm4gdmVyc2lvblByb21pc2UucmVzb2x2ZSgwKTtcbiAgfVxuICBnZXQgdmVyc2lvbigpIHsgLy8gUHJvbWlzZSB0aGUgaGlnaGVzdCB2ZXJzaW9uIHN1cG9ydGVkIGJ5IGJvdGggc2lkZXMsIG9yIGRpc2Nvbm5lY3QgYW5kIGZhbHN5IGlmIG5vbmUuXG4gICAgLy8gVGVsbHMgdGhlIG90aGVyIHNpZGUgb3VyIHZlcnNpb25zIGlmIHdlIGhhdmVuJ3QgeWV0IGRvbmUgc28uXG4gICAgLy8gRklYTUU6IGNhbiB3ZSBhdm9pZCB0aGlzIHRpbWVvdXQ/XG4gICAgcmV0dXJuIHRoaXMuX3ZlcnNpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZShzZXRUaW1lb3V0KCgpID0+IHRoaXMuc2VuZCgndmVyc2lvbnMnLCB0aGlzLm1pblZlcnNpb24sIHRoaXMubWF4VmVyc2lvbiksIDIwMCkpO1xuICB9XG5cbiAgZ2V0IHN0YXJ0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGhhdmUgc3RhcnRlZCBzeW5jaHJvbml6YXRpb24uXG4gICAgcmV0dXJuIHRoaXMuX3N0YXJ0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMuc3RhcnRTeW5jaHJvbml6YXRpb24oKTtcbiAgfVxuICBnZXQgY29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG51bWJlciBvZiBpdGVtcyB0aGF0IHdlcmUgdHJhbnNmZXJyZWQgKG5vdCBuZWNlc3NhcmlsbHkgd3JpdHRlbikuXG4gICAgLy8gU3RhcnRzIHN5bmNocm9uaXphdGlvbiBpZiBpdCBoYXNuJ3QgYWxyZWFkeS4gRS5nLiwgd2FpdGluZyBvbiBjb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gd29uJ3QgcmVzb2x2ZSB1bnRpbCBhZnRlciBpdCBzdGFydHMuXG4gICAgcmV0dXJuIHRoaXMuX2NvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbik7XG4gIH1cbiAgZ2V0IHBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbnVtYmVyIG9mIGl0ZW1zIHRoYXQgdGhlIHBlZXIgc3luY2hyb25pemVkLlxuICAgIHJldHVybiB0aGlzLl9wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UoKTtcbiAgfVxuICBnZXQgYm90aFNpZGVzQ29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHJlc29sdmVzIHRydXRoeSB3aGVuIGJvdGggc2lkZXMgYXJlIGRvbmUuXG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVkU3luY2hyb25pemF0aW9uLnRoZW4oKCkgPT4gdGhpcy5wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uKTtcbiAgfVxuICBhc3luYyByZXBvcnRDb25uZWN0aW9uKCkgeyAvLyBMb2cgY29ubmVjdGlvbiB0aW1lIGFuZCB0eXBlLlxuICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgdGhpcy5jb25uZWN0aW9uLnBlZXIuZ2V0U3RhdHMoKTtcbiAgICBsZXQgdHJhbnNwb3J0O1xuICAgIGZvciAoY29uc3QgcmVwb3J0IG9mIHN0YXRzLnZhbHVlcygpKSB7XG4gICAgICBpZiAocmVwb3J0LnR5cGUgPT09ICd0cmFuc3BvcnQnKSB7XG5cdHRyYW5zcG9ydCA9IHJlcG9ydDtcblx0YnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGxldCBjYW5kaWRhdGVQYWlyID0gdHJhbnNwb3J0ICYmIHN0YXRzLmdldCh0cmFuc3BvcnQuc2VsZWN0ZWRDYW5kaWRhdGVQYWlySWQpO1xuICAgIGlmICghY2FuZGlkYXRlUGFpcikgeyAvLyBTYWZhcmkgZG9lc24ndCBmb2xsb3cgdGhlIHN0YW5kYXJkLlxuICAgICAgZm9yIChjb25zdCByZXBvcnQgb2Ygc3RhdHMudmFsdWVzKCkpIHtcblx0aWYgKChyZXBvcnQudHlwZSA9PT0gJ2NhbmRpZGF0ZS1wYWlyJykgJiYgcmVwb3J0LnNlbGVjdGVkKSB7XG5cdCAgY2FuZGlkYXRlUGFpciA9IHJlcG9ydDtcblx0ICBicmVhaztcblx0fVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIWNhbmRpZGF0ZVBhaXIpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnZ290IHN0YXRzIHdpdGhvdXQgY2FuZGlkYXRlUGFpcicsIEFycmF5LmZyb20oc3RhdHMudmFsdWVzKCkpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVtb3RlID0gc3RhdHMuZ2V0KGNhbmRpZGF0ZVBhaXIucmVtb3RlQ2FuZGlkYXRlSWQpO1xuICAgIGNvbnN0IHtwcm90b2NvbCwgY2FuZGlkYXRlVHlwZX0gPSByZW1vdGU7XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzdGF0cywgdHJhbnNwb3J0LCBjYW5kaWRhdGVQYWlyLCByZW1vdGUsIHByb3RvY29sLCBjYW5kaWRhdGVUeXBlLCBzeW5jaHJvbml6YXRpb25TdGFydFRpbWU6IG5vd30pO1xuICAgIGNvbnNvbGUuaW5mbyh0aGlzLmxhYmVsLCAnY29ubmVjdGVkJywgcHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGUsICgobm93IC0gdGhpcy5jb25uZWN0aW9uU3RhcnRUaW1lKS8xZTMpLnRvRml4ZWQoMSkpO1xuICB9XG4gIGFzeW5jIHN0YXJ0U3luY2hyb25pemF0aW9uKCkgeyAvLyBXYWl0IGZvciBhbGwgcHJlbGltaW5hcmllcywgYW5kIHN0YXJ0IHN0cmVhbWluZyBvdXIgdGFncy5cbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGlmICghZGF0YUNoYW5uZWwpIHRocm93IG5ldyBFcnJvcihgTm8gY29ubmVjdGlvbiBmb3IgJHt0aGlzLmxhYmVsfS5gKTtcbiAgICAvLyBOb3cgdGhhdCB3ZSBhcmUgY29ubmVjdGVkLCBhbnkgbmV3IHdyaXRlcyBvbiBvdXIgZW5kIHdpbGwgYmUgcHVzaGVkIHRvIHRoZSBwZWVyLiBTbyBjYXB0dXJlIHRoZSBpbml0aWFsIHRhZ3Mgbm93LlxuICAgIGNvbnN0IG91clRhZ3MgPSBuZXcgU2V0KGF3YWl0IHRoaXMuY29sbGVjdGlvbi50YWdzKTtcbiAgICBhd2FpdCB0aGlzLnJlcG9ydENvbm5lY3Rpb24oKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtcblxuICAgICAgLy8gQSBzbmFwc2hvdCBTZXQgb2YgZWFjaCB0YWcgd2UgaGF2ZSBsb2NhbGx5LCBjYXB0dXJlZCBhdCB0aGUgbW9tZW50IG9mIGNyZWF0aW9uLlxuICAgICAgb3VyVGFncywgLy8gKE5ldyBsb2NhbCB3cml0ZXMgYXJlIHB1c2hlZCB0byB0aGUgY29ubmVjdGVkIHBlZXIsIGV2ZW4gZHVyaW5nIHN5bmNocm9uaXphdGlvbi4pXG5cbiAgICAgIC8vIE1hcCBvZiB0YWcgdG8gcHJvbWlzZSBmb3IgdGFncyB0aGF0IGFyZSBiZWluZyBzeW5jaHJvbml6ZWQuXG4gICAgICAvLyBlbnN1cmVTeW5jaHJvbml6ZWRUYWcgZW5zdXJlcyB0aGF0IHRoZXJlIGlzIGFuIGVudHJ5IGhlcmUgZHVyaW5nIHRoZSB0aW1lIGEgdGFnIGlzIGluIGZsaWdodC5cbiAgICAgIHVuc3luY2hyb25pemVkOiBuZXcgTWFwKCksXG5cbiAgICAgIC8vIFNldCBvZiB3aGF0IHRhZ3MgaGF2ZSBiZWVuIGV4cGxpY2l0bHkgc3luY2hyb25pemVkLCBtZWFuaW5nIHRoYXQgdGhlcmUgaXMgYSBkaWZmZXJlbmNlIGJldHdlZW4gdGhlaXIgaGFzaFxuICAgICAgLy8gYW5kIG91cnMsIHN1Y2ggdGhhdCB3ZSBhc2sgZm9yIHRoZWlyIHNpZ25hdHVyZSB0byBjb21wYXJlIGluIGRldGFpbC4gVGh1cyB0aGlzIHNldCBtYXkgaW5jbHVkZSBpdGVtcyB0aGF0XG4gICAgICBjaGVja2VkVGFnczogbmV3IFNldCgpLCAvLyB3aWxsIG5vdCBlbmQgdXAgYmVpbmcgcmVwbGFjZWQgb24gb3VyIGVuZC5cblxuICAgICAgZW5kT2ZQZWVyVGFnczogZmFsc2UgLy8gSXMgdGhlIHBlZXIgZmluaXNoZWQgc3RyZWFtaW5nP1xuICAgIH0pO1xuICAgIC8vIE5vdyBuZWdvdGlhdGUgdmVyc2lvbiBhbmQgY29sbGVjdHMgdGhlIHRhZ3MuXG4gICAgY29uc3QgdmVyc2lvbiA9IGF3YWl0IHRoaXMudmVyc2lvbjtcbiAgICBjb25zdCB7bWluVmVyc2lvbiwgbWF4VmVyc2lvbn0gPSB0aGlzO1xuICAgIGlmICghdmVyc2lvbikge1xuICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0KCk7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYFRoaXMgc29mdHdhcmUgZXhwZWN0cyBkYXRhIHZlcnNpb25zIGZyb20gJHttaW5WZXJzaW9ufSB0byAke21heFZlcnNpb259LiBUcnkgcmVsb2FkaW5nIHR3aWNlLmA7XG4gICAgICBpZiAodHlwZW9mKHdpbmRvdykgIT09ICd1bmRlZmluZWQnKSB3aW5kb3cuYWxlcnQobWVzc2FnZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuc3RyZWFtVGFncyhvdXJUYWdzKTsgLy8gQnV0IGRvIG5vdCB3YWl0IGZvciBpdC5cbiAgfVxuICBhc3luYyBjb21wdXRlSGFzaCh0ZXh0KSB7IC8vIE91ciBzdGFuZGFyZCBoYXNoLiAoU3RyaW5nIHNvIHRoYXQgaXQgaXMgc2VyaWFsaXphYmxlLilcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgQ3JlZGVudGlhbHMuaGFzaFRleHQodGV4dCk7XG4gICAgcmV0dXJuIENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChoYXNoKTtcbiAgfVxuICBhc3luYyBnZXRIYXNoKHRhZykgeyAvLyBXaG9sZSBzaWduYXR1cmUgKE5PVCBwcm90ZWN0ZWRIZWFkZXIuc3ViIG9mIGNvbnRlbnQpLlxuICAgIGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMuY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgICByZXR1cm4gdGhpcy5jb21wdXRlSGFzaChyYXcgfHwgJ21pc3NpbmcnKTtcbiAgfVxuICBhc3luYyBzdHJlYW1UYWdzKHRhZ3MpIHsgLy8gU2VuZCBlYWNoIG9mIG91ciBrbm93biB0YWcvaGFzaCBwYWlycyB0byBwZWVyLCBvbmUgYXQgYSB0aW1lLCBmb2xsb3dlZCBieSBlbmRPZlRhZ3MuXG4gICAgZm9yIChjb25zdCB0YWcgb2YgdGFncykge1xuICAgICAgdGhpcy5zZW5kKCdoYXNoJywgdGFnLCBhd2FpdCB0aGlzLmdldEhhc2godGFnKSk7XG4gICAgfVxuICAgIHRoaXMuc2VuZCgnZW5kVGFncycpO1xuICB9XG4gIGFzeW5jIGVuZFRhZ3MoKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBzdHJlYW1UYWdzKCkuXG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHRoaXMuZW5kT2ZQZWVyVGFncyA9IHRydWU7XG4gICAgdGhpcy5jbGVhblVwSWZGaW5pc2hlZCgpO1xuICB9XG4gIHN5bmNocm9uaXphdGlvbkNvbXBsZXRlKG5DaGVja2VkKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBnZXR0aW5nIGFsbCB0aGUgZGF0YSBpdCBuZWVkcyBmcm9tIHVzLlxuICAgIHRoaXMucGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBjbGVhblVwSWZGaW5pc2hlZCgpIHsgLy8gSWYgd2UgYXJlIG5vdCB3YWl0aW5nIGZvciBhbnl0aGluZywgd2UncmUgZG9uZS4gQ2xlYW4gdXAuXG4gICAgLy8gVGhpcyByZXF1aXJlcyB0aGF0IHRoZSBwZWVyIGhhcyBpbmRpY2F0ZWQgdGhhdCBpdCBpcyBmaW5pc2hlZCBzdHJlYW1pbmcgdGFncyxcbiAgICAvLyBhbmQgdGhhdCB3ZSBhcmUgbm90IHdhaXRpbmcgZm9yIGFueSBmdXJ0aGVyIHVuc3luY2hyb25pemVkIGl0ZW1zLlxuICAgIGlmICghdGhpcy5lbmRPZlBlZXJUYWdzIHx8IHRoaXMudW5zeW5jaHJvbml6ZWQuc2l6ZSkgcmV0dXJuO1xuICAgIGNvbnN0IG5DaGVja2VkID0gdGhpcy5jaGVja2VkVGFncy5zaXplOyAvLyBUaGUgbnVtYmVyIHRoYXQgd2UgY2hlY2tlZC5cbiAgICB0aGlzLnNlbmQoJ3N5bmNocm9uaXphdGlvbkNvbXBsZXRlJywgbkNoZWNrZWQpO1xuICAgIHRoaXMuY2hlY2tlZFRhZ3MuY2xlYXIoKTtcbiAgICB0aGlzLnVuc3luY2hyb25pemVkLmNsZWFyKCk7XG4gICAgdGhpcy5vdXJUYWdzID0gdGhpcy5zeW5jaHJvbml6ZWQgPSB0aGlzLnVuc3luY2hyb25pemVkID0gbnVsbDtcbiAgICBjb25zb2xlLmluZm8odGhpcy5sYWJlbCwgJ2NvbXBsZXRlZCBzeW5jaHJvbml6YXRpb24nLCBuQ2hlY2tlZCwgJ2l0ZW1zIGluJywgKChEYXRlLm5vdygpIC0gdGhpcy5zeW5jaHJvbml6YXRpb25TdGFydFRpbWUpLzFlMykudG9GaXhlZCgxKSwgJ3NlY29uZHMnKTtcbiAgICB0aGlzLmNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBzeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykgeyAvLyBSZXR1cm4gc29tZXRoaW5nIHRvIGF3YWl0IHRoYXQgcmVzb2x2ZXMgd2hlbiB0YWcgaXMgc3luY2hyb25pemVkLlxuICAgIC8vIFdoZW5ldmVyIGEgY29sbGVjdGlvbiBuZWVkcyB0byByZXRyaWV2ZSAoZ2V0VmVyaWZpZWQpIGEgdGFnIG9yIGZpbmQgdGFncyBtYXRjaGluZyBwcm9wZXJ0aWVzLCBpdCBlbnN1cmVzXG4gICAgLy8gdGhlIGxhdGVzdCBkYXRhIGJ5IGNhbGxpbmcgdGhpcyBhbmQgYXdhaXRpbmcgdGhlIGRhdGEuXG4gICAgaWYgKCF0aGlzLnVuc3luY2hyb25pemVkKSByZXR1cm4gdHJ1ZTsgLy8gV2UgYXJlIGZ1bGx5IHN5bmNocm9uaXplZCBhbGwgdGFncy4gSWYgdGhlcmUgaXMgbmV3IGRhdGEsIGl0IHdpbGwgYmUgc3BvbnRhbmVvdXNseSBwdXNoZWQgdG8gdXMuXG4gICAgaWYgKHRoaXMuY2hlY2tlZFRhZ3MuaGFzKHRhZykpIHJldHVybiB0cnVlOyAvLyBUaGlzIHBhcnRpY3VsYXIgdGFnIGhhcyBiZWVuIGNoZWNrZWQuXG4gICAgICAvLyAoSWYgY2hlY2tlZFRhZ3Mgd2FzIG9ubHkgdGhvc2UgZXhjaGFuZ2VkIG9yIHdyaXR0ZW4sIHdlIHdvdWxkIGhhdmUgZXh0cmEgZmxpZ2h0cyBjaGVja2luZy4pXG4gICAgLy8gSWYgYSByZXF1ZXN0IGlzIGluIGZsaWdodCwgcmV0dXJuIHRoYXQgcHJvbWlzZS4gT3RoZXJ3aXNlIGNyZWF0ZSBvbmUuXG4gICAgcmV0dXJuIHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZykgfHwgdGhpcy5lbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCAnJywgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG5cbiAgYXN5bmMgaGFzaCh0YWcsIGhhc2gpIHsgLy8gUmVjZWl2ZSBhIFt0YWcsIGhhc2hdIHRoYXQgdGhlIHBlZXIga25vd3MgYWJvdXQuIChQZWVyIHN0cmVhbXMgemVybyBvciBtb3JlIG9mIHRoZXNlIHRvIHVzLilcbiAgICAvLyBVbmxlc3MgYWxyZWFkeSBpbiBmbGlnaHQsIHdlIHdpbGwgZW5zdXJlU3luY2hyb25pemVkVGFnIHRvIHN5bmNocm9uaXplIGl0LlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICBjb25zdCB7b3VyVGFncywgdW5zeW5jaHJvbml6ZWR9ID0gdGhpcztcbiAgICB0aGlzLmxvZygncmVjZWl2ZWQgXCJoYXNoXCInLCB7dGFnLCBoYXNoLCBvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0pO1xuICAgIGlmICh1bnN5bmNocm9uaXplZC5oYXModGFnKSkgcmV0dXJuIG51bGw7IC8vIEFscmVhZHkgaGFzIGFuIGludmVzdGlnYXRpb24gaW4gcHJvZ3Jlc3MgKGUuZywgZHVlIHRvIGxvY2FsIGFwcCBzeW5jaHJvbml6YXRpb25Qcm9taXNlKS5cbiAgICBpZiAoIW91clRhZ3MuaGFzKHRhZykpIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gpOyAvLyBXZSBkb24ndCBoYXZlIHRoZSByZWNvcmQgYXQgYWxsLlxuICAgIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gsIHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgfVxuICBlbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCB0aGVpckhhc2ggPSAnJywgb3VySGFzaFByb21pc2UgPSBudWxsKSB7XG4gICAgLy8gU3luY2hyb25vdXNseSByZWNvcmQgKGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXApIGEgcHJvbWlzZSB0byAoY29uY2VwdHVhbGx5KSByZXF1ZXN0IHRoZSB0YWcgZnJvbSB0aGUgcGVlcixcbiAgICAvLyBwdXQgaXQgaW4gdGhlIGNvbGxlY3Rpb24sIGFuZCBjbGVhbnVwIHRoZSBib29ra2VlcGluZy4gUmV0dXJuIHRoYXQgcHJvbWlzZS5cbiAgICAvLyBIb3dldmVyLCBpZiB3ZSBhcmUgZ2l2ZW4gaGFzaGVzIHRvIGNvbXBhcmUgYW5kIHRoZXkgbWF0Y2gsIHdlIGNhbiBza2lwIHRoZSByZXF1ZXN0L3B1dCBhbmQgcmVtb3ZlIGZyb20gdW5zeWNocm9uaXplZCBvbiBuZXh0IHRpY2suXG4gICAgLy8gKFRoaXMgbXVzdCByZXR1cm4gYXRvbWljYWxseSBiZWNhdXNlIGNhbGxlciBoYXMgY2hlY2tlZCB2YXJpb3VzIGJvb2trZWVwaW5nIGF0IHRoYXQgbW9tZW50LiBDaGVja2luZyBtYXkgcmVxdWlyZSB0aGF0IHdlIGF3YWl0IG91ckhhc2hQcm9taXNlLilcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHsgLy8gTmV4dCB0aWNrLiBTZWUgcmVxdWVzdCgpLlxuXHRpZiAoIXRoZWlySGFzaCB8fCAhb3VySGFzaFByb21pc2UgfHwgKHRoZWlySGFzaCAhPT0gYXdhaXQgb3VySGFzaFByb21pc2UpKSB7XG5cdCAgY29uc3QgdGhlaXJEYXRhID0gYXdhaXQgdGhpcy5yZXF1ZXN0KHRhZyk7XG5cdCAgLy8gTWlnaHQgaGF2ZSBiZWVuIHRyaWdnZXJlZCBieSBvdXIgYXBwIHJlcXVlc3RpbmcgdGhpcyB0YWcgYmVmb3JlIHdlIHdlcmUgc3luYydkLiBTbyB0aGV5IG1pZ2h0IG5vdCBoYXZlIHRoZSBkYXRhLlxuXHQgIGlmICghdGhlaXJIYXNoIHx8IHRoZWlyRGF0YT8ubGVuZ3RoKSB7XG5cdCAgICBpZiAoYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnB1dCh0YWcsIHRoZWlyRGF0YSwgdGhpcykpIHtcblx0ICAgICAgdGhpcy5sb2coJ3JlY2VpdmVkL3B1dCcsIHRhZywgJ3RoZWlyL291ciBoYXNoOicsIHRoZWlySGFzaCB8fCAnbWlzc2luZ1RoZWlycycsIChhd2FpdCBvdXJIYXNoUHJvbWlzZSkgfHwgJ21pc3NpbmdPdXJzJywgdGhlaXJEYXRhPy5sZW5ndGgpO1xuXHQgICAgfSBlbHNlIHtcblx0ICAgICAgdGhpcy5sb2coJ3VuYWJsZSB0byBwdXQnLCB0YWcpO1xuXHQgICAgfVxuXHQgIH1cblx0fVxuXHR0aGlzLmNoZWNrZWRUYWdzLmFkZCh0YWcpOyAgICAgICAvLyBFdmVyeXRoaW5nIHdlJ3ZlIGV4YW1pbmVkLCByZWdhcmRsZXNzIG9mIHdoZXRoZXIgd2UgYXNrZWQgZm9yIG9yIHNhdmVkIGRhdGEgZnJvbSBwZWVyLiAoU2VlIHN5bmNocm9uaXphdGlvblByb21pc2UpXG5cdHRoaXMudW5zeW5jaHJvbml6ZWQuZGVsZXRlKHRhZyk7IC8vIFVuY29uZGl0aW9uYWxseSwgYmVjYXVzZSB3ZSBzZXQgaXQgdW5jb25kaXRpb25hbGx5LlxuXHR0aGlzLmNsZWFuVXBJZkZpbmlzaGVkKCk7XG5cdHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMudW5zeW5jaHJvbml6ZWQuc2V0KHRhZywgcHJvbWlzZSk7IC8vIFVuY29uZGl0aW9uYWxseSwgaW4gY2FzZSB3ZSBuZWVkIHRvIGtub3cgd2UncmUgbG9va2luZyBkdXJpbmcgdGhlIHRpbWUgd2UncmUgbG9va2luZy5cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXF1ZXN0KHRhZykgeyAvLyBNYWtlIGEgcmVxdWVzdCBmb3IgdGFnIGZyb20gdGhlIHBlZXIsIGFuZCBhbnN3ZXIgYSBwcm9taXNlIHRoZSByZXNvbHZlcyB3aXRoIHRoZSBkYXRhLlxuICAgIC8qY29uc3QgeyBob3N0UmVxdWVzdEJhc2UgfSA9IHRoaXM7XG4gICAgaWYgKGhvc3RSZXF1ZXN0QmFzZSkge1xuICAgICAgLy8gRS5nLiwgYSBsb2NhbGhvc3Qgcm91dGVyIG1pZ2h0IHN1cHBvcnQgYSBnZXQgb2YgaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyL190L3VML0JBY1dfTE5BSmEvY0pXbXVtYmxlXG4gICAgICAvLyBTbyBob3N0UmVxdWVzdEJhc2Ugc2hvdWxkIGJlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyXCIsXG4gICAgICAvLyBhbmQgc2VydmljZU5hbWUgc2hvdWxkIGJlIHNvbWV0aGluZyBsaWtlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9zeW5jXCJcbiAgICAgIHJldHVybiBmZXRjaCh0YWdQYXRoKGhvc3RSZXF1ZXN0QmFzZSwgdGFnKSkudGhlbihyZXNwb25zZSA9PiByZXNwb25zZS50ZXh0KCkpO1xuICAgIH0qL1xuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UodGhpcy5zZW5kKCdnZXQnLCB0YWcpKTtcbiAgICAvLyBTdWJ0bGU6IFdoZW4gdGhlICdwdXQnIGNvbWVzIGJhY2ssIHdlIHdpbGwgbmVlZCB0byByZXNvbHZlIHRoaXMgcHJvbWlzZS4gQnV0IGhvdyB3aWxsICdwdXQnIGZpbmQgdGhlIHByb21pc2UgdG8gcmVzb2x2ZSBpdD9cbiAgICAvLyBBcyBpdCB0dXJucyBvdXQsIHRvIGdldCBoZXJlLCB3ZSBoYXZlIG5lY2Vzc2FyaWxseSBzZXQgdGFnIGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXAuIFxuICAgIGNvbnN0IG5vdGVkID0gdGhpcy51bnN5bmNocm9uaXplZC5nZXQodGFnKTsgLy8gQSBwcm9taXNlIHRoYXQgZG9lcyBub3QgaGF2ZSBhbiBleHBvc2VkIC5yZXNvbHZlLCBhbmQgd2hpY2ggZG9lcyBub3QgZXhwZWN0IGFueSB2YWx1ZS5cbiAgICBub3RlZC5yZXNvbHZlID0gcHJvbWlzZS5yZXNvbHZlOyAvLyBUYWNrIG9uIGEgcmVzb2x2ZSBmb3IgT1VSIHByb21pc2Ugb250byB0aGUgbm90ZWQgb2JqZWN0ICh3aGljaCBjb25mdXNpbmdseSwgaGFwcGVucyB0byBiZSBhIHByb21pc2UpLlxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gUmVzcG9uZCB0byBhIHBlZXIncyBnZXQoKSByZXF1ZXN0IGJ5IHNlbmRpbmcgYSBwdXQgcmVwb25zZSB3aXRoIHRoZSBkYXRhLlxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gICAgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIGRhdGEpO1xuICB9XG4gIHB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSkgeyAvLyBUZWxsIHRoZSBvdGhlciBzaWRlIGFib3V0IGEgc2lnbmVkIHdyaXRlLlxuICAgIHRoaXMuc2VuZChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKTtcbiAgfVxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUpIHsgLy8gUmVjZWl2ZSBhIHB1dCBtZXNzYWdlIGZyb20gdGhlIHBlZXIuXG4gICAgLy8gSWYgaXQgaXMgYSByZXNwb25zZSB0byBhIGdldCgpIHJlcXVlc3QsIHJlc29sdmUgdGhlIGNvcnJlc3BvbmRpbmcgcHJvbWlzZS5cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy51bnN5bmNocm9uaXplZD8uZ2V0KHRhZyk7XG4gICAgLy8gUmVnYXJkbGVzcyBvZiB3aHkgdGhlIG90aGVyIHNpZGUgaXMgc2VuZGluZywgaWYgd2UgaGF2ZSBhbiBvdXRzdGFuZGluZyByZXF1ZXN0LCBjb21wbGV0ZSBpdC5cbiAgICBpZiAocHJvbWlzZSkgcHJvbWlzZS5yZXNvbHZlKHNpZ25hdHVyZSk7XG4gICAgZWxzZSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24ucHV0KHRhZywgc2lnbmF0dXJlLCB0aGlzKTsgLy8gT3RoZXJ3aXNlLCBqdXN0IHRyeSB0byB3cml0ZSBpdCBsb2NhbGx5LlxuICB9XG4gIGRlbGV0ZSh0YWcsIHNpZ25hdHVyZSkgeyAvLyBSZWNlaXZlIGEgZGVsZXRlIG1lc3NhZ2UgZnJvbSB0aGUgcGVlci5cbiAgICB0aGlzLmNvbGxlY3Rpb24uZGVsZXRlKHRhZywgc2lnbmF0dXJlLCB0aGlzKTtcbiAgfVxufVxuZXhwb3J0IGRlZmF1bHQgU3luY2hyb25pemVyO1xuIiwiY2xhc3MgQ2FjaGUgZXh0ZW5kcyBNYXB7Y29uc3RydWN0b3IoZSx0PTApe3N1cGVyKCksdGhpcy5tYXhTaXplPWUsdGhpcy5kZWZhdWx0VGltZVRvTGl2ZT10LHRoaXMuX25leHRXcml0ZUluZGV4PTAsdGhpcy5fa2V5TGlzdD1BcnJheShlKSx0aGlzLl90aW1lcnM9bmV3IE1hcH1zZXQoZSx0LHM9dGhpcy5kZWZhdWx0VGltZVRvTGl2ZSl7bGV0IGk9dGhpcy5fbmV4dFdyaXRlSW5kZXg7dGhpcy5kZWxldGUodGhpcy5fa2V5TGlzdFtpXSksdGhpcy5fa2V5TGlzdFtpXT1lLHRoaXMuX25leHRXcml0ZUluZGV4PShpKzEpJXRoaXMubWF4U2l6ZSx0aGlzLl90aW1lcnMuaGFzKGUpJiZjbGVhclRpbWVvdXQodGhpcy5fdGltZXJzLmdldChlKSksc3VwZXIuc2V0KGUsdCkscyYmdGhpcy5fdGltZXJzLnNldChlLHNldFRpbWVvdXQoKCgpPT50aGlzLmRlbGV0ZShlKSkscykpfWRlbGV0ZShlKXtyZXR1cm4gdGhpcy5fdGltZXJzLmhhcyhlKSYmY2xlYXJUaW1lb3V0KHRoaXMuX3RpbWVycy5nZXQoZSkpLHRoaXMuX3RpbWVycy5kZWxldGUoZSksc3VwZXIuZGVsZXRlKGUpfWNsZWFyKGU9dGhpcy5tYXhTaXplKXt0aGlzLm1heFNpemU9ZSx0aGlzLl9rZXlMaXN0PUFycmF5KGUpLHRoaXMuX25leHRXcml0ZUluZGV4PTAsc3VwZXIuY2xlYXIoKTtmb3IoY29uc3QgZSBvZiB0aGlzLl90aW1lcnMudmFsdWVzKCkpY2xlYXJUaW1lb3V0KGUpO3RoaXMuX3RpbWVycy5jbGVhcigpfX1jbGFzcyBTdG9yYWdlQmFzZXtjb25zdHJ1Y3Rvcih7bmFtZTplLGJhc2VOYW1lOnQ9XCJTdG9yYWdlXCIsbWF4U2VyaWFsaXplclNpemU6cz0xZTMsZGVidWc6aT0hMX0pe2NvbnN0IGE9YCR7dH0vJHtlfWAscj1uZXcgQ2FjaGUocyk7T2JqZWN0LmFzc2lnbih0aGlzLHtuYW1lOmUsYmFzZU5hbWU6dCxmdWxsTmFtZTphLGRlYnVnOmksc2VyaWFsaXplcjpyfSl9YXN5bmMgbGlzdCgpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShcIlwiLCgoZSx0KT0+dGhpcy5saXN0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGdldChlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZ2V0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGRlbGV0ZShlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZGVsZXRlSW50ZXJuYWwodCxlKSkpfWFzeW5jIHB1dChlLHQpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSxzKT0+dGhpcy5wdXRJbnRlcm5hbChzLHQsZSkpKX1sb2coLi4uZSl7dGhpcy5kZWJ1ZyYmY29uc29sZS5sb2codGhpcy5uYW1lLC4uLmUpfWFzeW5jIHNlcmlhbGl6ZShlLHQpe2NvbnN0e3NlcmlhbGl6ZXI6cyxyZWFkeTppfT10aGlzO2xldCBhPXMuZ2V0KGUpfHxpO3JldHVybiBhPWEudGhlbigoYXN5bmMoKT0+dChhd2FpdCB0aGlzLnJlYWR5LHRoaXMucGF0aChlKSkpKSxzLnNldChlLGEpLGF3YWl0IGF9fWNvbnN0e1Jlc3BvbnNlOmUsVVJMOnR9PWdsb2JhbFRoaXM7Y2xhc3MgU3RvcmFnZUNhY2hlIGV4dGVuZHMgU3RvcmFnZUJhc2V7Y29uc3RydWN0b3IoLi4uZSl7c3VwZXIoLi4uZSksdGhpcy5zdHJpcHBlcj1uZXcgUmVnRXhwKGBeLyR7dGhpcy5mdWxsTmFtZX0vYCksdGhpcy5yZWFkeT1jYWNoZXMub3Blbih0aGlzLmZ1bGxOYW1lKX1hc3luYyBsaXN0SW50ZXJuYWwoZSx0KXtyZXR1cm4oYXdhaXQgdC5rZXlzKCl8fFtdKS5tYXAoKGU9PnRoaXMudGFnKGUudXJsKSkpfWFzeW5jIGdldEludGVybmFsKGUsdCl7Y29uc3Qgcz1hd2FpdCB0Lm1hdGNoKGUpO3JldHVybiBzPy5qc29uKCl9ZGVsZXRlSW50ZXJuYWwoZSx0KXtyZXR1cm4gdC5kZWxldGUoZSl9cHV0SW50ZXJuYWwodCxzLGkpe3JldHVybiBpLnB1dCh0LGUuanNvbihzKSl9cGF0aChlKXtyZXR1cm5gLyR7dGhpcy5mdWxsTmFtZX0vJHtlfWB9dGFnKGUpe3JldHVybiBuZXcgdChlKS5wYXRobmFtZS5yZXBsYWNlKHRoaXMuc3RyaXBwZXIsXCJcIil9ZGVzdHJveSgpe3JldHVybiBjYWNoZXMuZGVsZXRlKHRoaXMuZnVsbE5hbWUpfX1leHBvcnR7U3RvcmFnZUNhY2hlIGFzIFN0b3JhZ2VMb2NhbCxTdG9yYWdlQ2FjaGUgYXMgZGVmYXVsdH07XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgeyBTdG9yYWdlTG9jYWwgfSBmcm9tICdAa2kxcjB5L3N0b3JhZ2UnO1xuaW1wb3J0IFN5bmNocm9uaXplciBmcm9tICcuL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5jb25zdCB7IEN1c3RvbUV2ZW50LCBFdmVudFRhcmdldCwgVGV4dERlY29kZXIgfSA9IGdsb2JhbFRoaXM7XG5cbmV4cG9ydCBjbGFzcyBDb2xsZWN0aW9uIGV4dGVuZHMgRXZlbnRUYXJnZXQge1xuXG4gIGNvbnN0cnVjdG9yKHtuYW1lLCBsYWJlbCA9IG5hbWUsIHNlcnZpY2VzID0gW10sIHByZXNlcnZlRGVsZXRpb25zID0gISFzZXJ2aWNlcy5sZW5ndGgsXG5cdCAgICAgICBwZXJzaXN0ZW5jZUNsYXNzID0gU3RvcmFnZUxvY2FsLCBkYlZlcnNpb24gPSBzdG9yYWdlVmVyc2lvbiwgcGVyc2lzdGVuY2VCYXNlID0gYCR7c3RvcmFnZU5hbWV9XyR7ZGJWZXJzaW9ufWAsXG5cdCAgICAgICBkZWJ1ZyA9IGZhbHNlLCBtdWx0aXBsZXgsIC8vIENhdXNlcyBzeW5jaHJvbml6YXRpb24gdG8gcmV1c2UgY29ubmVjdGlvbnMgZm9yIGRpZmZlcmVudCBDb2xsZWN0aW9ucyBvbiB0aGUgc2FtZSBzZXJ2aWNlLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHNlcnZpY2VMYWJlbH0pIHtcbiAgICBzdXBlcigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge25hbWUsIGxhYmVsLCBwcmVzZXJ2ZURlbGV0aW9ucywgcGVyc2lzdGVuY2VDbGFzcywgZGJWZXJzaW9uLCBtdWx0aXBsZXgsIGRlYnVnLCBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsLFxuXHRcdFx0IGZ1bGxOYW1lOiBgJHt0aGlzLmNvbnN0cnVjdG9yLm5hbWV9LyR7bmFtZX1gLCBmdWxsTGFiZWw6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtsYWJlbH1gfSk7XG4gICAgdGhpcy5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgcGVyc2lzdGVuY2VPcHRpb25zID0ge25hbWU6IHRoaXMuZnVsbExhYmVsLCBiYXNlTmFtZTogcGVyc2lzdGVuY2VCYXNlLCBkZWJ1ZzogZGVidWd9O1xuICAgIGlmIChwZXJzaXN0ZW5jZUNsYXNzLnRoZW4pIHRoaXMucGVyc2lzdGVuY2VTdG9yZSA9IHBlcnNpc3RlbmNlQ2xhc3MudGhlbihraW5kID0+IG5ldyBraW5kKHBlcnNpc3RlbmNlT3B0aW9ucykpO1xuICAgIGVsc2UgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gbmV3IHBlcnNpc3RlbmNlQ2xhc3MocGVyc2lzdGVuY2VPcHRpb25zKTtcbiAgfVxuXG4gIGFzeW5jIGNsb3NlKCkge1xuICAgIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmNsb3NlKCk7XG4gIH1cbiAgYXN5bmMgZGVzdHJveSgpIHtcbiAgICBhd2FpdCAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKS5kZXN0cm95KCk7XG4gIH1cblxuICBzdGF0aWMgZXJyb3IoZXJyb3IpIHsgLy8gQ2FuIGJlIG92ZXJyaWRkZW4gYnkgdGhlIGNsaWVudFxuICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xuICB9XG4gIC8vIENyZWRlbnRpYWxzLnNpZ24vLnZlcmlmeSBjYW4gcHJvZHVjZS9hY2NlcHQgSlNPTiBPQkpFQ1RTIGZvciB0aGUgbmFtZWQgXCJKU09OIFNlcmlhbGl6YXRpb25cIiBmb3JtLlxuICAvLyBBcyBpdCBoYXBwZW5zLCBkaXN0cmlidXRlZC1zZWN1cml0eSBjYW4gZGlzdGluZ3Vpc2ggYmV0d2VlbiBhIGNvbXBhY3Qgc2VyaWFsaXphdGlvbiAoYmFzZTY0IHRleHQpXG4gIC8vIHZzIGFuIG9iamVjdCwgYnV0IGl0IGRvZXMgbm90IHJlY29nbml6ZSBhIFNFUklBTElaRUQgb2JqZWN0LiBIZXJlIHdlIGJvdHRsZW5lY2sgdGhvc2Ugb3BlcmF0aW9uc1xuICAvLyBzdWNoIHRoYXQgdGhlIHRoaW5nIHRoYXQgaXMgYWN0dWFsbHkgcGVyc2lzdGVkIGFuZCBzeW5jaHJvbml6ZWQgaXMgYWx3YXlzIGEgc3RyaW5nIC0tIGVpdGhlciBiYXNlNjRcbiAgLy8gY29tcGFjdCBvciBKU09OIGJlZ2lubmluZyB3aXRoIGEgXCJ7XCIgKHdoaWNoIGFyZSBkaXN0aW5ndWlzaGFibGUgYmVjYXVzZSBcIntcIiBpcyBub3QgYSBiYXNlNjQgY2hhcmFjdGVyKS5cbiAgc3RhdGljIGVuc3VyZVN0cmluZyhzaWduYXR1cmUpIHsgLy8gUmV0dXJuIGEgc2lnbmF0dXJlIHRoYXQgaXMgZGVmaW5hdGVseSBhIHN0cmluZy5cbiAgICBpZiAodHlwZW9mKHNpZ25hdHVyZSkgIT09ICdzdHJpbmcnKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkoc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gc2lnbmF0dXJlO1xuICB9XG4gIC8vIFJldHVybiBhIGNvbXBhY3Qgb3IgXCJKU09OXCIgKG9iamVjdCkgZm9ybSBvZiBzaWduYXR1cmUgKGluZmxhdGluZyBhIHNlcmlhbGl6YXRpb24gb2YgdGhlIGxhdHRlciBpZiBuZWVkZWQpLCBidXQgbm90IGEgSlNPTiBzdHJpbmcuXG4gIHN0YXRpYyBtYXliZUluZmxhdGUoc2lnbmF0dXJlKSB7XG4gICAgaWYgKHNpZ25hdHVyZT8uc3RhcnRzV2l0aD8uKFwie1wiKSkgcmV0dXJuIEpTT04ucGFyc2Uoc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gc2lnbmF0dXJlO1xuICB9XG4gIC8vIFRoZSB0eXBlIG9mIEpXRSB0aGF0IGdldHMgc2lnbmVkIChub3QgdGhlIGN0eSBvZiB0aGUgSldFKS4gV2UgYXV0b21hdGljYWxseSB0cnkgdG8gZGVjcnlwdCBhIEpXUyBwYXlsb2FkIG9mIHRoaXMgdHlwZS5cbiAgc3RhdGljIGVuY3J5cHRlZE1pbWVUeXBlID0gJ3RleHQvZW5jcnlwdGVkJztcbiAgc3RhdGljIGFzeW5jIGVuc3VyZURlY3J5cHRlZCh2ZXJpZmllZCkgeyAvLyBQcm9taXNlIHZlcmZpZWQgYWZ0ZXIgZmlyc3QgYXVnbWVudGluZyB3aXRoIGRlY3J5cHRlZCBkYXRhIGFzIG5lZWRlZC5cbiAgICBpZiAodmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmN0eSAhPT0gdGhpcy5lbmNyeXB0ZWRNaW1lVHlwZSkgcmV0dXJuIHZlcmlmaWVkO1xuICAgIGlmICh2ZXJpZmllZC5kZWNyeXB0ZWQpIHJldHVybiB2ZXJpZmllZDsgLy8gQWxyZWFkeSBkZWNyeXB0ZWQuXG4gICAgY29uc3QgZGVjcnlwdGVkID0gYXdhaXQgQ3JlZGVudGlhbHMuZGVjcnlwdCh2ZXJpZmllZC50ZXh0KTtcbiAgICB2ZXJpZmllZC5qc29uID0gZGVjcnlwdGVkLmpzb247XG4gICAgdmVyaWZpZWQudGV4dCA9IGRlY3J5cHRlZC50ZXh0O1xuICAgIHZlcmlmaWVkLnBheWxvYWQgPSBkZWNyeXB0ZWQucGF5bG9hZDtcbiAgICB2ZXJpZmllZC5kZWNyeXB0ZWQgPSBkZWNyeXB0ZWQ7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIHN0YXRpYyBhc3luYyBzaWduKGRhdGEsIG9wdGlvbnMpIHtcbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCBDcmVkZW50aWFscy5zaWduKGRhdGEsIG9wdGlvbnMpO1xuICAgIHJldHVybiB0aGlzLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zID0ge30pIHtcbiAgICBzaWduYXR1cmUgPSB0aGlzLm1heWJlSW5mbGF0ZShzaWduYXR1cmUpO1xuICAgIC8vIFdlIGRvbid0IGRvIFwiZGVlcFwiIHZlcmlmaWNhdGlvbiBoZXJlIC0gZS5nLiwgY2hlY2tpbmcgdGhhdCB0aGUgYWN0IGlzIGEgbWVtYmVyIG9mIGlzcywgYW5kIHRoZSBpYXQgaXMgYWZ0ZXIgdGhlIGV4aXN0aW5nIGlhdC5cbiAgICAvLyBJbnN0ZWFkLCB3ZSBkbyBvdXIgb3duIGRlZXAgY2hlY2tzIGluIHZhbGlkYXRlRm9yV3JpdGluZy5cbiAgICAvLyBUaGUgbWVtYmVyL25vdEJlZm9yZSBzaG91bGQgY2hlY2sgb3V0IGFueXdheSAtLSBpLmUuLCB3ZSBjb3VsZCBsZWF2ZSBpdCBpbiwgZXhjZXB0IGluIHN5bmNocm9uaXppbmdcbiAgICAvLyBDcmVkZW50aWFsLmNvbGxlY3Rpb25zLiBUaGVyZSBpcyBubyBtZWNoYW5pc20gKGN1cnJlbnRseSkgZm9yIHRoZVxuICAgIC8vIHN5bmNocm9uaXphdGlvbiB0byBoYXBwZW4gaW4gYW4gb3JkZXIgdGhhdCB3aWxsIHJlc3VsdCBpbiB0aGUgZGVwZW5kZW5jaWVzIGNvbWluZyBvdmVyIGJlZm9yZSB0aGUgaXRlbXMgdGhhdCBjb25zdW1lIHRoZW0uXG4gICAgY29uc3QgdmVyaWZpZWQgPSAgYXdhaXQgQ3JlZGVudGlhbHMudmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyk7XG4gICAgaWYgKHZlcmlmaWVkKSB2ZXJpZmllZC5zaWduYXR1cmUgPSBzaWduYXR1cmU7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2ZXJpZmllZFNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMsIHRhZyA9IG51bGwpIHsgLy8gU2lnbiwgYnV0IHJldHVybiBhIHZhbGlkYXRpb24gKGFzIHRob3VnaCBieSBpbW1lZGlhdGVseSB2YWxpZGF0aW5nKS5cbiAgICAvLyBUT0RPOiBhc3NlbWJsZSB0aGlzIG1vcmUgY2hlYXBseT9cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHJldHVybiB0aGlzLnZhbGlkYXRpb25Gb3JtYXQoc2lnbmF0dXJlLCB0YWcpO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2YWxpZGF0aW9uRm9ybWF0KHNpZ25hdHVyZSwgdGFnID0gbnVsbCkge1xuICAgIC8vY29uc29sZS5sb2coe3R5cGU6IHR5cGVvZihzaWduYXR1cmUpLCBzaWduYXR1cmUsIHRhZ30pO1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy52ZXJpZnkoc2lnbmF0dXJlKTtcbiAgICAvL2NvbnNvbGUubG9nKHt2ZXJpZmllZH0pO1xuICAgIGNvbnN0IHN1YiA9IHZlcmlmaWVkLnN1YmplY3RUYWcgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICAgIHZlcmlmaWVkLnRhZyA9IHRhZyB8fCBzdWI7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG5cbiAgYXN5bmMgdW5kZWxldGVkVGFncygpIHtcbiAgICAvLyBPdXIgb3duIHNlcGFyYXRlLCBvbi1kZW1hbmQgYWNjb3VudGluZyBvZiBwZXJzaXN0ZW5jZVN0b3JlIGxpc3QoKTpcbiAgICAvLyAgIC0gcGVyc2lzdGVuY2VTdG9yZSBsaXN0KCkgY291bGQgcG90ZW50aWFsbHkgYmUgZXhwZW5zaXZlXG4gICAgLy8gICAtIEl0IHdpbGwgY29udGFpbiBzb2Z0LWRlbGV0ZWQgaXRlbSB0b21ic3RvbmVzIChzaWduZWQgZW1wdHkgcGF5bG9hZHMpLlxuICAgIC8vIEl0IHN0YXJ0cyB3aXRoIGEgbGlzdCgpIHRvIGdldCBhbnl0aGluZyBwZXJzaXN0ZWQgaW4gYSBwcmV2aW91cyBzZXNzaW9uLCBhbmQgYWRkcy9yZW1vdmVzIGFzIHdlIHN0b3JlL3JlbW92ZS5cbiAgICBjb25zdCBhbGxUYWdzID0gYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkubGlzdCgpO1xuICAgIGNvbnN0IHRhZ3MgPSBuZXcgU2V0KCk7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoYWxsVGFncy5tYXAoYXN5bmMgdGFnID0+IHtcbiAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnLCBzeW5jaHJvbml6ZTogZmFsc2V9KTtcbiAgICAgIGlmICh2ZXJpZmllZCkgdGFncy5hZGQodGFnKTtcbiAgICB9KSk7XG4gICAgcmV0dXJuIHRhZ3M7XG4gIH1cbiAgZ2V0IHRhZ3MoKSB7IC8vIEtlZXBzIHRyYWNrIG9mIG91ciAodW5kZWxldGVkKSBrZXlzLlxuICAgIHJldHVybiB0aGlzLl90YWdzUHJvbWlzZSB8fD0gdGhpcy51bmRlbGV0ZWRUYWdzKCk7XG4gIH1cbiAgYXN5bmMgYWRkVGFnKHRhZykge1xuICAgIChhd2FpdCB0aGlzLnRhZ3MpLmFkZCh0YWcpO1xuICB9XG4gIGFzeW5jIGRlbGV0ZVRhZyh0YWcpIHtcbiAgICAoYXdhaXQgdGhpcy50YWdzKS5kZWxldGUodGFnKTtcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKCF0aGlzLmRlYnVnKSByZXR1cm47XG4gICAgY29uc29sZS5sb2codGhpcy5mdWxsTGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIF9jYW5vbmljYWxpemVPcHRpb25zKG9iamVjdE9yU3RyaW5nID0ge30pIHtcbiAgICBpZiAodHlwZW9mKG9iamVjdE9yU3RyaW5nKSA9PT0gJ3N0cmluZycpIG9iamVjdE9yU3RyaW5nID0ge3RhZzogb2JqZWN0T3JTdHJpbmd9O1xuICAgIGNvbnN0IHtvd25lcjp0ZWFtID0gQ3JlZGVudGlhbHMub3duZXIsIGF1dGhvcjptZW1iZXIgPSBDcmVkZW50aWFscy5hdXRob3IsXG5cdCAgIHRhZyxcblx0ICAgZW5jcnlwdGlvbiA9IENyZWRlbnRpYWxzLmVuY3J5cHRpb24sXG5cdCAgIHRpbWUgPSBEYXRlLm5vdygpLFxuXHQgICAuLi5yZXN0fSA9IG9iamVjdE9yU3RyaW5nO1xuICAgIC8vIFRPRE86IHN1cHBvcnQgc2ltcGxpZmllZCBzeW50YXgsIHRvbywgcGVyIFJFQURNRVxuICAgIC8vIFRPRE86IHNob3VsZCB3ZSBzcGVjaWZ5IHN1YmplY3Q6IHRhZyBmb3IgYm90aCBtdXRhYmxlcz8gKGdpdmVzIGhhc2gpXG4gICAgY29uc3Qgb3B0aW9ucyA9ICh0ZWFtICYmIHRlYW0gIT09IG1lbWJlcikgP1xuXHQgIHt0ZWFtLCBtZW1iZXIsIHRhZywgZW5jcnlwdGlvbiwgdGltZSwgLi4ucmVzdH0gOlxuXHQgIHt0YWdzOiBbbWVtYmVyXSwgdGFnLCB0aW1lLCBlbmNyeXB0aW9uLCAuLi5yZXN0fTsgLy8gTm8gaWF0IGlmIHRpbWUgbm90IGV4cGxpY2l0bHkgZ2l2ZW4uXG4gICAgaWYgKFt0cnVlLCAndGVhbScsICdvd25lciddLmluY2x1ZGVzKG9wdGlvbnMuZW5jcnlwdGlvbikpIG9wdGlvbnMuZW5jcnlwdGlvbiA9IHRlYW07XG4gICAgcmV0dXJuIG9wdGlvbnM7XG4gIH1cbiAgZmFpbChvcGVyYXRpb24sIGRhdGEsIGF1dGhvcikge1xuICAgIHRocm93IG5ldyBFcnJvcihgJHthdXRob3J9IGRvZXMgbm90IGhhdmUgdGhlIGF1dGhvcml0eSB0byAke29wZXJhdGlvbn0gJHt0aGlzLmZ1bGxOYW1lfSAke0pTT04uc3RyaW5naWZ5KGRhdGEpfS5gKTtcbiAgfVxuICBhc3luYyBzdG9yZShkYXRhLCBvcHRpb25zID0ge30pIHtcbiAgICAvLyBlbmNyeXB0IGlmIG5lZWRlZFxuICAgIC8vIHNpZ25cbiAgICAvLyBwdXQgPD09IEFsc28gd2hlcmUgd2UgZW50ZXIgaWYgcHVzaGVkIGZyb20gYSBjb25uZWN0aW9uXG4gICAgLy8gICAgdmFsaWRhdGVGb3JXcml0aW5nXG4gICAgLy8gICAgICAgZXhpdCBpZiBpbXByb3BlclxuICAgIC8vICAgICAgIGVtaXQgdXBkYXRlIGV2ZW50XG4gICAgLy8gICAgbWVyZ2VTaWduYXR1cmVzXG4gICAgLy8gICAgcGVyc2lzdCBsb2NhbGx5XG4gICAgLy8gcHVzaCAobGl2ZSB0byBhbnkgY29ubmVjdGlvbnMgZXhjZXB0IHRoZSBvbmUgd2UgcmVjZWl2ZWQgZnJvbSlcbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTtcbiAgICBpZiAoZW5jcnlwdGlvbikge1xuICAgICAgZGF0YSA9IGF3YWl0IENyZWRlbnRpYWxzLmVuY3J5cHQoZGF0YSwgZW5jcnlwdGlvbik7XG4gICAgICBzaWduaW5nT3B0aW9ucy5jb250ZW50VHlwZSA9IHRoaXMuY29uc3RydWN0b3IuZW5jcnlwdGVkTWltZVR5cGU7XG4gICAgfVxuICAgIC8vIE5vIG5lZWQgdG8gYXdhaXQgc3luY2hyb25pemF0aW9uLlxuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgdGFnID0gYXdhaXQgdGhpcy5wdXQodGFnLCBzaWduYXR1cmUpO1xuICAgIGlmICghdGFnKSByZXR1cm4gdGhpcy5mYWlsKCdzdG9yZScsIGRhdGEsIHNpZ25pbmdPcHRpb25zLm1lbWJlciB8fCBzaWduaW5nT3B0aW9ucy50YWdzWzBdKTtcbiAgICBhd2FpdCB0aGlzLnB1c2goJ3B1dCcsIHRhZywgc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIHB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSwgZXhjbHVkZVN5bmNocm9uaXplciA9IG51bGwpIHsgLy8gUHVzaCB0byBhbGwgY29ubmVjdGVkIHN5bmNocm9uaXplcnMsIGV4Y2x1ZGluZyB0aGUgc3BlY2lmaWVkIG9uZS5cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHN5bmNocm9uaXplciA9PiAoZXhjbHVkZVN5bmNocm9uaXplciAhPT0gc3luY2hyb25pemVyKSAmJiBzeW5jaHJvbml6ZXIucHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKSkpO1xuICB9XG4gIGFzeW5jIHJlbW92ZShvcHRpb25zID0ge30pIHsgLy8gTm90ZTogUmVhbGx5IGp1c3QgcmVwbGFjaW5nIHdpdGggZW1wdHkgZGF0YSBmb3JldmVyLiBPdGhlcndpc2UgbWVyZ2luZyB3aXRoIGVhcmxpZXIgZGF0YSB3aWxsIGJyaW5nIGl0IGJhY2shXG4gICAgbGV0IHtlbmNyeXB0aW9uLCB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7XG4gICAgY29uc3QgZGF0YSA9ICcnO1xuICAgIC8vIE5vIG5lZWQgdG8gYXdhaXQgc3luY2hyb25pemF0aW9uXG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zKTtcbiAgICB0YWcgPSBhd2FpdCB0aGlzLmRlbGV0ZSh0YWcsIHNpZ25hdHVyZSk7XG4gICAgaWYgKCF0YWcpIHJldHVybiB0aGlzLmZhaWwoJ3N0b3JlJywgZGF0YSwgc2lnbmluZ09wdGlvbnMubWVtYmVyIHx8IHNpZ25pbmdPcHRpb25zLnRhZ3NbMF0pO1xuICAgIGF3YWl0IHRoaXMucHVzaCgnZGVsZXRlJywgdGFnLCBzaWduYXR1cmUpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgYXN5bmMgcmV0cmlldmUodGFnT3JPcHRpb25zKSB7IC8vIGdldFZlcmlmaWVkIGFuZCBtYXliZSBkZWNyeXB0LiBIYXMgbW9yZSBjb21wbGV4IGJlaGF2aW9yIGluIHN1YmNsYXNzIFZlcnNpb25lZENvbGxlY3Rpb24uXG4gICAgY29uc3Qge3RhZywgZGVjcnlwdCA9IHRydWUsIC4uLm9wdGlvbnN9ID0gdGFnT3JPcHRpb25zLnRhZyA/IHRhZ09yT3B0aW9ucyA6IHt0YWc6IHRhZ09yT3B0aW9uc307XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIC4uLm9wdGlvbnN9KTtcbiAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gJyc7XG4gICAgaWYgKGRlY3J5cHQpIHJldHVybiBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZURlY3J5cHRlZCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIGFzeW5jIGdldFZlcmlmaWVkKHRhZ09yT3B0aW9ucykgeyAvLyBzeW5jaHJvbml6ZSwgZ2V0LCBhbmQgdmVyaWZ5IChidXQgd2l0aG91dCBkZWNyeXB0KVxuICAgIGNvbnN0IHt0YWcsIHN5bmNocm9uaXplID0gdHJ1ZSwgLi4udmVyaWZ5T3B0aW9uc30gPSB0YWdPck9wdGlvbnMudGFnID8gdGFnT3JPcHRpb25zOiB7dGFnOiB0YWdPck9wdGlvbnN9O1xuICAgIGlmIChzeW5jaHJvbml6ZSkgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZTEodGFnKTtcbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmdldCh0YWcpO1xuICAgIGlmICghc2lnbmF0dXJlKSByZXR1cm4gc2lnbmF0dXJlO1xuICAgIHJldHVybiB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeShzaWduYXR1cmUsIHZlcmlmeU9wdGlvbnMpO1xuICB9XG4gIGFzeW5jIGxpc3Qoc2tpcFN5bmMgPSBmYWxzZSApIHsgLy8gTGlzdCBhbGwgdGFncyBvZiB0aGlzIGNvbGxlY3Rpb24uXG4gICAgaWYgKCFza2lwU3luYykgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZVRhZ3MoKTtcbiAgICAvLyBXZSBjYW5ub3QganVzdCBsaXN0IHRoZSBrZXlzIG9mIHRoZSBjb2xsZWN0aW9uLCBiZWNhdXNlIHRoYXQgaW5jbHVkZXMgZW1wdHkgcGF5bG9hZHMgb2YgaXRlbXMgdGhhdCBoYXZlIGJlZW4gZGVsZXRlZC5cbiAgICByZXR1cm4gQXJyYXkuZnJvbSgoYXdhaXQgdGhpcy50YWdzKS5rZXlzKCkpO1xuICB9XG4gIGFzeW5jIG1hdGNoKHRhZywgcHJvcGVydGllcykgeyAvLyBJcyB0aGlzIHNpZ25hdHVyZSB3aGF0IHdlIGFyZSBsb29raW5nIGZvcj9cbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMucmV0cmlldmUodGFnKTtcbiAgICBjb25zdCBkYXRhID0gdmVyaWZpZWQ/Lmpzb247XG4gICAgaWYgKCFkYXRhKSByZXR1cm4gZmFsc2U7XG4gICAgZm9yIChjb25zdCBrZXkgaW4gcHJvcGVydGllcykge1xuICAgICAgaWYgKGRhdGFba2V5XSAhPT0gcHJvcGVydGllc1trZXldKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGFzeW5jIGZpbmRMb2NhbChwcm9wZXJ0aWVzKSB7IC8vIEZpbmQgdGhlIHRhZyBpbiBvdXIgc3RvcmUgdGhhdCBtYXRjaGVzLCBlbHNlIGZhbHNleVxuICAgIGZvciAoY29uc3QgdGFnIG9mIGF3YWl0IHRoaXMubGlzdCgnbm8tc3luYycpKSB7IC8vIERpcmVjdCBsaXN0LCB3L28gc3luYy5cbiAgICAgIGlmIChhd2FpdCB0aGlzLm1hdGNoKHRhZywgcHJvcGVydGllcykpIHJldHVybiB0YWc7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBhc3luYyBmaW5kKHByb3BlcnRpZXMpIHsgLy8gQW5zd2VyIHRoZSB0YWcgdGhhdCBoYXMgdmFsdWVzIG1hdGNoaW5nIHRoZSBzcGVjaWZpZWQgcHJvcGVydGllcy4gT2J2aW91c2x5LCBjYW4ndCBiZSBlbmNyeXB0ZWQgYXMgYSB3aG9sZS5cbiAgICBsZXQgZm91bmQgPSBhd2FpdCB0aGlzLmZpbmRMb2NhbChwcm9wZXJ0aWVzKTtcbiAgICBpZiAoZm91bmQpIHtcbiAgICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemUxKGZvdW5kKTsgLy8gTWFrZSBzdXJlIHRoZSBkYXRhIGlzIHVwIHRvIGRhdGUuIFRoZW4gY2hlY2sgYWdhaW4uXG4gICAgICBpZiAoYXdhaXQgdGhpcy5tYXRjaChmb3VuZCwgcHJvcGVydGllcykpIHJldHVybiBmb3VuZDtcbiAgICB9XG4gICAgLy8gTm8gbWF0Y2guXG4gICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZVRhZ3MoKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplRGF0YSgpO1xuICAgIGZvdW5kID0gYXdhaXQgdGhpcy5maW5kTG9jYWwocHJvcGVydGllcyk7XG4gICAgaWYgKGZvdW5kICYmIGF3YWl0IHRoaXMubWF0Y2goZm91bmQsIHByb3BlcnRpZXMpKSByZXR1cm4gZm91bmQ7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmVxdWlyZVRhZyh0YWcpIHtcbiAgICBpZiAodGFnKSByZXR1cm47XG4gICAgdGhyb3cgbmV3IEVycm9yKCdBIHRhZyBpcyByZXF1aXJlZC4nKTtcbiAgfVxuXG4gIC8vIFRoZXNlIHRocmVlIGlnbm9yZSBzeW5jaHJvbml6YXRpb24gc3RhdGUsIHdoaWNoIGlmIG5lZWVkIGlzIHRoZSByZXNwb25zaWJpbGl0eSBvZiB0aGUgY2FsbGVyLlxuICAvLyBGSVhNRSBUT0RPOiBhZnRlciBpbml0aWFsIGRldmVsb3BtZW50LCB0aGVzZSB0aHJlZSBzaG91bGQgYmUgbWFkZSBpbnRlcm5hbCBzbyB0aGF0IGFwcGxpY2F0aW9uIGNvZGUgZG9lcyBub3QgY2FsbCB0aGVtLlxuICBhc3luYyBnZXQodGFnKSB7IC8vIEdldCB0aGUgbG9jYWwgcmF3IHNpZ25hdHVyZSBkYXRhLlxuICAgIHRoaXMucmVxdWlyZVRhZyh0YWcpO1xuICAgIHJldHVybiBhd2FpdCAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKS5nZXQodGFnKTtcbiAgfVxuICAvLyBUaGVzZSB0d28gY2FuIGJlIHRyaWdnZXJlZCBieSBjbGllbnQgY29kZSBvciBieSBhbnkgc2VydmljZS5cbiAgYXN5bmMgcHV0KHRhZywgc2lnbmF0dXJlLCBzeW5jaHJvbml6ZXIgPSBudWxsLCBtZXJnZUF1dGhvck92ZXJyaWRlID0gbnVsbCkgeyAvLyBQdXQgdGhlIHJhdyBzaWduYXR1cmUgbG9jYWxseSBhbmQgb24gdGhlIHNwZWNpZmllZCBzZXJ2aWNlcy5cbiAgICAvLyBtZXJnZVNpZ25hdHVyZXMoKSBNQVkgY3JlYXRlIG5ldyBuZXcgcmVzdWx0cyB0byBzYXZlLCB0aGF0IHN0aWxsIGhhdmUgdG8gYmUgc2lnbmVkLiBGb3IgdGVzdGluZywgd2Ugc29tZXRpbWVzXG4gICAgLy8gd2FudCB0byBiZWhhdmUgYXMgaWYgc29tZSBvd25lciBjcmVkZW50aWFsIGRvZXMgbm90IGV4aXN0IG9uIHRoZSBtYWNoaW5lLiBUaGF0J3Mgd2hhdCBtZXJnZUF1dGhvck92ZXJyaWRlIGlzIGZvci5cblxuICAgIC8vIFRPRE86IGRvIHdlIG5lZWQgdG8gcXVldWUgdGhlc2U/IFN1cHBvc2Ugd2UgYXJlIHZhbGlkYXRpbmcgb3IgbWVyZ2luZyB3aGlsZSBvdGhlciByZXF1ZXN0IGFycml2ZT9cbiAgICBjb25zdCB2YWxpZGF0aW9uID0gYXdhaXQgdGhpcy52YWxpZGF0ZUZvcldyaXRpbmcodGFnLCBzaWduYXR1cmUsICdzdG9yZScsIHN5bmNocm9uaXplcik7XG4gICAgdGhpcy5sb2coJ3B1dCcsIHt0YWc6IHZhbGlkYXRpb24/LnRhZyB8fCB0YWcsIHN5bmNocm9uaXplcjogc3luY2hyb25pemVyPy5sYWJlbCwganNvbjogdmFsaWRhdGlvbj8uanNvbn0pO1xuICAgIGlmICghdmFsaWRhdGlvbikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBhd2FpdCB0aGlzLmFkZFRhZyh2YWxpZGF0aW9uLnRhZyk7XG5cbiAgICAvLyBmaXhtZSBuZXh0XG4gICAgY29uc3QgbWVyZ2VkID0gYXdhaXQgdGhpcy5tZXJnZVNpZ25hdHVyZXModGFnLCB2YWxpZGF0aW9uLCBzaWduYXR1cmUsIG1lcmdlQXV0aG9yT3ZlcnJpZGUpO1xuICAgIGF3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgbWVyZ2VkKTtcbiAgICAvL2NvbnN0IG1lcmdlZDIgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZhbGlkYXRpb25Gb3JtYXQobWVyZ2VkLCB0YWcpO1xuICAgIC8vYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBtZXJnZWQpO1xuICAgIC8vYXdhaXQgdGhpcy5wZXJzaXN0MihtZXJnZWQyKTtcbiAgICAvLyBjb25zdCBtZXJnZWQgPSBhd2FpdCB0aGlzLm1lcmdlVmFsaWRhdGlvbih2YWxpZGF0aW9uLCBtZXJnZUF1dGhvck92ZXJyaWRlKTtcbiAgICAvLyBhd2FpdCB0aGlzLnBlcnNpc3QyKG1lcmdlZCk7XG5cbiAgICByZXR1cm4gdmFsaWRhdGlvbi50YWc7IC8vIERvbid0IHJlbHkgb24gdGhlIHJldHVybmVkIHZhbHVlIG9mIHBlcnNpc3RlbmNlU3RvcmUucHV0LlxuICB9XG4gIGFzeW5jIGRlbGV0ZSh0YWcsIHNpZ25hdHVyZSwgc3luY2hyb25pemVyID0gbnVsbCkgeyAvLyBSZW1vdmUgdGhlIHJhdyBzaWduYXR1cmUgbG9jYWxseSBhbmQgb24gdGhlIHNwZWNpZmllZCBzZXJ2aWNlcy5cbiAgICBjb25zdCB2YWxpZGF0aW9uID0gYXdhaXQgdGhpcy52YWxpZGF0ZUZvcldyaXRpbmcodGFnLCBzaWduYXR1cmUsICdyZW1vdmUnLCBzeW5jaHJvbml6ZXIsICdyZXF1aXJlVGFnJyk7XG4gICAgdGhpcy5sb2coJ2RlbGV0ZScsIHRhZywgc3luY2hyb25pemVyPy5sYWJlbCwgJ3ZhbGlkYXRlZCB0YWc6JywgdmFsaWRhdGlvbj8udGFnLCAncHJlc2VydmVEZWxldGlvbnM6JywgdGhpcy5wcmVzZXJ2ZURlbGV0aW9ucyk7XG4gICAgaWYgKCF2YWxpZGF0aW9uKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGF3YWl0IHRoaXMuZGVsZXRlVGFnKHRhZyk7XG4gICAgaWYgKHRoaXMucHJlc2VydmVEZWxldGlvbnMpIHsgLy8gU2lnbmF0dXJlIHBheWxvYWQgaXMgZW1wdHkuXG4gICAgICAvLyBGSVhNRSBuZXh0XG4gICAgICAvL2F3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgc2lnbmF0dXJlKTtcbiAgICAgIGF3YWl0IHRoaXMucGVyc2lzdDIodmFsaWRhdGlvbik7XG4gICAgfSBlbHNlIHsgLy8gUmVhbGx5IGRlbGV0ZS5cbiAgICAgIC8vIGZpeG1lIG5leHRcbiAgICAgIC8vYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBzaWduYXR1cmUsICdkZWxldGUnKTtcbiAgICAgIGF3YWl0IHRoaXMucGVyc2lzdDIodmFsaWRhdGlvbiwgJ2RlbGV0ZScpO1xuICAgIH1cbiAgICByZXR1cm4gdmFsaWRhdGlvbi50YWc7IC8vIERvbid0IHJlbHkgb24gdGhlIHJldHVybmVkIHZhbHVlIG9mIHBlcnNpc3RlbmNlU3RvcmUuZGVsZXRlLlxuICB9XG5cbiAgbm90aWZ5SW52YWxpZCh0YWcsIG9wZXJhdGlvbkxhYmVsLCBtZXNzYWdlID0gdW5kZWZpbmVkLCB2YWxpZGF0ZWQgPSAnJywgc2lnbmF0dXJlKSB7XG4gICAgLy8gTGF0ZXIgb24sIHdlIHdpbGwgbm90IHdhbnQgdG8gZ2l2ZSBvdXQgc28gbXVjaCBpbmZvLi4uXG4gICAgLy9pZiAodGhpcy5kZWJ1Zykge1xuICAgIGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgb3BlcmF0aW9uTGFiZWwsIG1lc3NhZ2UsIHRhZyk7XG4gICAgLy99IGVsc2Uge1xuICAgIC8vICBjb25zb2xlLndhcm4odGhpcy5mdWxsTGFiZWwsIGBTaWduYXR1cmUgaXMgbm90IHZhbGlkIHRvICR7b3BlcmF0aW9uTGFiZWx9ICR7dGFnIHx8ICdkYXRhJ30uYCk7XG4gICAgLy99XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgeyAvLyBSZXR1cm4gYSByZWFzb24gc3RyaW5nIHdoeSB0aGUgcHJvcG9zZWQgdmVyaWZpZWQgcHJvdGVjdGVkSGVhZGVyXG4gICAgLy8gc2hvdWxkIG5vdCBiZSBhbGxvd2VkIHRvIG92ZXJyd3JpdGUgdGhlIChwb3NzaWJseSBudWxsaXNoKSBleGlzdGluZyB2ZXJpZmllZCBwcm90ZWN0ZWRIZWFkZXIsXG4gICAgLy8gZWxzZSBmYWxzeSBpZiBhbGxvd2VkLlxuICAgIGlmICghcHJvcG9zZWQpIHJldHVybiAnaW52YWxpZCBzaWduYXR1cmUnO1xuICAgIGlmICghZXhpc3RpbmcpIHJldHVybiBudWxsO1xuICAgIGlmIChwcm9wb3NlZC5pYXQgPCBleGlzdGluZy5pYXQpIHJldHVybiAnYmFja2RhdGVkJztcbiAgICBpZiAoIXRoaXMub3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpKSByZXR1cm4gJ25vdCBvd25lcic7XG4gICAgaWYgKCFhd2FpdCB0aGlzLnN1YmplY3RNYXRjaCh2ZXJpZmllZCkpIHJldHVybiAnd3JvbmcgaGFzaCc7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgYXN5bmMgc3ViamVjdE1hdGNoKHZlcmlmaWVkKSB7IC8vIFByb21pc2VzIHRydWUgSUZGIGNsYWltZWQgJ3N1YicgbWF0Y2hlcyBoYXNoIG9mIHRoZSBjb250ZW50cy5cbiAgICByZXR1cm4gdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLnN1YiA9PT0gYXdhaXQgQ3JlZGVudGlhbHMuZW5jb2RlQmFzZTY0dXJsKGF3YWl0IENyZWRlbnRpYWxzLmhhc2hCdWZmZXIodmVyaWZpZWQucGF5bG9hZCkpO1xuICB9XG4gIG93bmVyTWF0Y2goZXhpc3RpbmcsIHByb3Bvc2VkKSB7Ly8gRG9lcyBwcm9wb3NlZCBvd25lciBtYXRjaCB0aGUgZXhpc3Rpbmc/XG4gICAgY29uc3QgZXhpc3RpbmdPd25lciA9IGV4aXN0aW5nPy5pc3MgfHwgZXhpc3Rpbmc/LmtpZDtcbiAgICBjb25zdCBwcm9wb3NlZE93bmVyID0gcHJvcG9zZWQuaXNzIHx8IHByb3Bvc2VkLmtpZDtcbiAgICAvLyBFeGFjdCBtYXRjaC4gRG8gd2UgbmVlZCB0byBhbGxvdyBmb3IgYW4gb3duZXIgdG8gdHJhbnNmZXIgb3duZXJzaGlwIHRvIGEgc3ViL3N1cGVyL2Rpc2pvaW50IHRlYW0/XG4gICAgLy8gQ3VycmVudGx5LCB0aGF0IHdvdWxkIHJlcXVpcmUgYSBuZXcgcmVjb3JkLiAoRS5nLiwgdHdvIE11dGFibGUvVmVyc2lvbmVkQ29sbGVjdGlvbiBpdGVtcyB0aGF0XG4gICAgLy8gaGF2ZSB0aGUgc2FtZSBHVUlEIHBheWxvYWQgcHJvcGVydHksIGJ1dCBkaWZmZXJlbnQgdGFncy4gSS5lLiwgYSBkaWZmZXJlbnQgb3duZXIgbWVhbnMgYSBkaWZmZXJlbnQgdGFnLilcbiAgICBpZiAoIXByb3Bvc2VkT3duZXIgfHwgKGV4aXN0aW5nT3duZXIgJiYgKHByb3Bvc2VkT3duZXIgIT09IGV4aXN0aW5nT3duZXIpKSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAvLyBXZSBhcmUgbm90IGNoZWNraW5nIHRvIHNlZSBpZiBhdXRob3IgaXMgY3VycmVudGx5IGEgbWVtYmVyIG9mIHRoZSBvd25lciB0ZWFtIGhlcmUsIHdoaWNoXG4gICAgICAvLyBpcyBjYWxsZWQgYnkgcHV0KCkvZGVsZXRlKCkgaW4gdHdvIGNpcmN1bXN0YW5jZXM6XG5cbiAgICAgIC8vIHRoaXMudmFsaWRhdGVGb3JXcml0aW5nKCkgaXMgY2FsbGVkIGJ5IHB1dCgpL2RlbGV0ZSgpIHdoaWNoIGhhcHBlbnMgaW4gdGhlIGFwcCAodmlhIHN0b3JlKCkvcmVtb3ZlKCkpXG4gICAgICAvLyBhbmQgZHVyaW5nIHN5bmMgZnJvbSBhbm90aGVyIHNlcnZpY2U6XG5cbiAgICAgIC8vIDEuIEZyb20gdGhlIGFwcCAodmFpYSBzdG9yZSgpL3JlbW92ZSgpLCB3aGVyZSB3ZSBoYXZlIGp1c3QgY3JlYXRlZCB0aGUgc2lnbmF0dXJlLiBTaWduaW5nIGl0c2VsZlxuICAgICAgLy8gd2lsbCBmYWlsIGlmIHRoZSAoMS1ob3VyIGNhY2hlZCkga2V5IGlzIG5vIGxvbmdlciBhIG1lbWJlciBvZiB0aGUgdGVhbS4gVGhlcmUgaXMgbm8gaW50ZXJmYWNlXG4gICAgICAvLyBmb3IgdGhlIGFwcCB0byBwcm92aWRlIGFuIG9sZCBzaWduYXR1cmUuIChUT0RPOiBhZnRlciB3ZSBtYWtlIGdldC9wdXQvZGVsZXRlIGludGVybmFsLilcblxuICAgICAgLy8gMi4gRHVyaW5nIHN5bmMgZnJvbSBhbm90aGVyIHNlcnZpY2UsIHdoZXJlIHdlIGFyZSBwdWxsaW5nIGluIG9sZCByZWNvcmRzIGZvciB3aGljaCB3ZSBkb24ndCBoYXZlXG4gICAgICAvLyB0ZWFtIG1lbWJlcnNoaXAgZnJvbSB0aGF0IHRpbWUuXG5cbiAgICAgIC8vIElmIHRoZSBhcHAgY2FyZXMgd2hldGhlciB0aGUgYXV0aG9yIGhhcyBiZWVuIGtpY2tlZCBmcm9tIHRoZSB0ZWFtLCB0aGUgYXBwIGl0c2VsZiB3aWxsIGhhdmUgdG8gY2hlY2suXG4gICAgICAvLyBUT0RPOiB3ZSBzaG91bGQgcHJvdmlkZSBhIHRvb2wgZm9yIHRoYXQuXG5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBhbnRlY2VkZW50KHZlcmlmaWVkKSB7IC8vIFdoYXQgdGFnIHNob3VsZCB0aGUgdmVyaWZpZWQgc2lnbmF0dXJlIGJlIGNvbXBhcmVkIGFnYWluc3QgZm9yIHdyaXRpbmc/XG4gICAgcmV0dXJuIHZlcmlmaWVkLnRhZztcbiAgfVxuICBzeW5jaHJvbml6ZUFudGVjZWRlbnQodGFnLCBhbnRlY2VkZW50KSB7IC8vIFNob3VsZCB0aGUgYW50ZWNlZGVudCB0cnkgc3luY2hyb25pemluZyBiZWZvcmUgZ2V0dGluZyBpdD9cbiAgICByZXR1cm4gdGFnICE9PSBhbnRlY2VkZW50OyAvLyBGYWxzZSB3aGVuIHRoZXkgYXJlIHRoZSBzYW1lIHRhZywgYXMgdGhhdCB3b3VsZCBiZSBjaXJjdWxhci4gVmVyc2lvbnMgZG8gc3luYy5cbiAgfVxuICAvLyBUT0RPOiBpcyB0aGlzIG5lZWRlZCBhbnkgbW9yZT9cbiAgYXN5bmMgdmFsaWRhdGVGb3JXcml0aW5nKHRhZywgc2lnbmF0dXJlLCBvcGVyYXRpb25MYWJlbCwgc3luY2hyb25pemVyLCByZXF1aXJlVGFnID0gZmFsc2UpIHtcbiAgICAvLyBBIGRlZXAgdmVyaWZ5IHRoYXQgY2hlY2tzIGFnYWluc3QgdGhlIGV4aXN0aW5nIGl0ZW0ncyAocmUtKXZlcmlmaWVkIGhlYWRlcnMuXG4gICAgLy8gSWYgaXQgc3VjY2VlZHMsIHRoaXMgaXMgYWxzbyB0aGUgY29tbW9uIGNvZGUgKGJldHdlZW4gcHV0L2RlbGV0ZSkgdGhhdCBlbWl0cyB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIGNvbnN0IHZhbGlkYXRpb25PcHRpb25zID0gc3luY2hyb25pemVyID8ge21lbWJlcjogbnVsbH0gOiB7fTsgLy8gQ291bGQgYmUgb2xkIGRhdGEgd3JpdHRlbiBieSBzb21lb25lIHdobyBpcyBubyBsb25nZXIgYSBtZW1iZXIuXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeShzaWduYXR1cmUsIHZhbGlkYXRpb25PcHRpb25zKTtcbiAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gdGhpcy5ub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsICdpbnZhbGlkJywgdmVyaWZpZWQsIHNpZ25hdHVyZSk7XG4gICAgdmVyaWZpZWQuc3luY2hyb25pemVyID0gc3luY2hyb25pemVyO1xuICAgIHRhZyA9IHZlcmlmaWVkLnRhZyA9IHZlcmlmaWVkLnN1YmplY3RUYWcgPSByZXF1aXJlVGFnID8gdGFnIDogYXdhaXQgdGhpcy50YWdGb3JXcml0aW5nKHRhZywgdmVyaWZpZWQpO1xuICAgIGNvbnN0IGFudGVjZWRlbnQgPSB0aGlzLmFudGVjZWRlbnQodmVyaWZpZWQpO1xuICAgIGNvbnN0IHN5bmNocm9uaXplID0gdGhpcy5zeW5jaHJvbml6ZUFudGVjZWRlbnQodGFnLCBhbnRlY2VkZW50KTtcbiAgICBjb25zdCBleGlzdGluZ1ZlcmlmaWVkID0gdmVyaWZpZWQuZXhpc3RpbmcgPSBhbnRlY2VkZW50ICYmIGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZzogYW50ZWNlZGVudCwgc3luY2hyb25pemV9KTtcbiAgICBjb25zdCBkaXNhbGxvd2VkID0gYXdhaXQgdGhpcy5kaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmdWZXJpZmllZD8ucHJvdGVjdGVkSGVhZGVyLCB2ZXJpZmllZD8ucHJvdGVjdGVkSGVhZGVyLCB2ZXJpZmllZCk7XG4gICAgaWYgKGRpc2FsbG93ZWQpIHJldHVybiB0aGlzLm5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgZGlzYWxsb3dlZCwgdmVyaWZpZWQpO1xuICAgIHRoaXMubG9nKCdlbWl0JywgdGFnLCB2ZXJpZmllZC5qc29uKTtcbiAgICB0aGlzLmVtaXQodmVyaWZpZWQpO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICAvLyBmaXhtZSBuZXh0IDJcbiAgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlKSB7IC8vIFJldHVybiBhIHN0cmluZyB0byBiZSBwZXJzaXN0ZWQuIFVzdWFsbHkganVzdCB0aGUgc2lnbmF0dXJlLlxuICAgIHJldHVybiBzaWduYXR1cmU7ICAvLyB2YWxpZGF0aW9uLnN0cmluZyBtaWdodCBiZSBhbiBvYmplY3QuXG4gIH1cbiAgYXN5bmMgcGVyc2lzdCh0YWcsIHNpZ25hdHVyZVN0cmluZywgb3BlcmF0aW9uID0gJ3B1dCcpIHsgLy8gQ29uZHVjdCB0aGUgc3BlY2lmaWVkIHRhZy9zaWduYXR1cmUgb3BlcmF0aW9uIG9uIHRoZSBwZXJzaXN0ZW50IHN0b3JlLlxuICAgIHJldHVybiAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKVtvcGVyYXRpb25dKHRhZywgc2lnbmF0dXJlU3RyaW5nKTtcbiAgfVxuICBtZXJnZVZhbGlkYXRpb24odmFsaWRhdGlvbikgeyAvLyBSZXR1cm4gYSBzdHJpbmcgdG8gYmUgcGVyc2lzdGVkLiBVc3VhbGx5IGp1c3QgdGhlIHNpZ25hdHVyZS5cbiAgICByZXR1cm4gdmFsaWRhdGlvbjtcbiAgfVxuICBhc3luYyBwZXJzaXN0Mih2YWxpZGF0aW9uLCBvcGVyYXRpb24gPSAncHV0JykgeyAvLyBDb25kdWN0IHRoZSBzcGVjaWZpZWQgdGFnL3NpZ25hdHVyZSBvcGVyYXRpb24gb24gdGhlIHBlcnNpc3RlbnQgc3RvcmUuIFJldHVybiB0YWdcbiAgICBjb25zdCB7dGFnLCBzaWduYXR1cmV9ID0gdmFsaWRhdGlvbjtcbiAgICBjb25zdCBzaWduYXR1cmVTdHJpbmcgPSB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICAgIGNvbnN0IHN0b3JhZ2UgPSBhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmU7XG4gICAgYXdhaXQgc3RvcmFnZVtvcGVyYXRpb25dKHRhZywgc2lnbmF0dXJlU3RyaW5nKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGVtaXQodmVyaWZpZWQpIHsgLy8gRGlzcGF0Y2ggdGhlIHVwZGF0ZSBldmVudC5cbiAgICB0aGlzLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KCd1cGRhdGUnLCB7ZGV0YWlsOiB2ZXJpZmllZH0pKTtcbiAgfVxuICBnZXQgaXRlbUVtaXR0ZXIoKSB7IC8vIEFuc3dlcnMgdGhlIENvbGxlY3Rpb24gdGhhdCBlbWl0cyBpbmRpdmlkdWFsIHVwZGF0ZXMuIChTZWUgb3ZlcnJpZGUgaW4gVmVyc2lvbmVkQ29sbGVjdGlvbi4pXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBzeW5jaHJvbml6ZXJzID0gbmV3IE1hcCgpOyAvLyBzZXJ2aWNlSW5mbyBtaWdodCBub3QgYmUgYSBzdHJpbmcuXG4gIG1hcFN5bmNocm9uaXplcnMoZikgeyAvLyBPbiBTYWZhcmksIE1hcC52YWx1ZXMoKS5tYXAgaXMgbm90IGEgZnVuY3Rpb24hXG4gICAgY29uc3QgcmVzdWx0cyA9IFtdO1xuICAgIGZvciAoY29uc3Qgc3luY2hyb25pemVyIG9mIHRoaXMuc3luY2hyb25pemVycy52YWx1ZXMoKSkge1xuICAgICAgcmVzdWx0cy5wdXNoKGYoc3luY2hyb25pemVyKSk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHRzO1xuICB9XG4gIGdldCBzZXJ2aWNlcygpIHtcbiAgICByZXR1cm4gQXJyYXkuZnJvbSh0aGlzLnN5bmNocm9uaXplcnMua2V5cygpKTtcbiAgfVxuICAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBjb25uZWN0LCBhbmQgZGVmaW5lIHN5bmNocm9uaXplIHRvIGF3YWl0IGNvbm5lY3QsIHN5bmNocm9uaXphdGlvbkNvbXBsZXRlLCBkaXNjb25ubmVjdC5cbiAgYXN5bmMgc3luY2hyb25pemUoLi4uc2VydmljZXMpIHsgLy8gU3RhcnQgcnVubmluZyB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzIChpbiBhZGRpdGlvbiB0byB3aGF0ZXZlciBpcyBhbHJlYWR5IHJ1bm5pbmcpLlxuICAgIGNvbnN0IHtzeW5jaHJvbml6ZXJzfSA9IHRoaXM7XG4gICAgZm9yIChsZXQgc2VydmljZSBvZiBzZXJ2aWNlcykge1xuICAgICAgaWYgKHN5bmNocm9uaXplcnMuaGFzKHNlcnZpY2UpKSBjb250aW51ZTtcbiAgICAgIGF3YWl0IFN5bmNocm9uaXplci5jcmVhdGUodGhpcywgc2VydmljZSk7IC8vIFJlYWNoZXMgaW50byBvdXIgc3luY2hyb25pemVycyBtYXAgYW5kIHNldHMgaXRzZWxmIGltbWVkaWF0ZWx5LlxuICAgIH1cbiAgfVxuICBnZXQgc3luY2hyb25pemVkKCkgeyAvLyBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBzeW5jaHJvbml6YXRpb24gaXMgY29tcGxldGUgaW4gQk9USCBkaXJlY3Rpb25zLlxuICAgIC8vIFRPRE8/IFRoaXMgZG9lcyBub3QgcmVmbGVjdCBjaGFuZ2VzIGFzIFN5bmNocm9uaXplcnMgYXJlIGFkZGVkIG9yIHJlbW92ZWQgc2luY2UgY2FsbGVkLiBTaG91bGQgaXQ/XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHRoaXMubWFwU3luY2hyb25pemVycyhzID0+IHMuYm90aFNpZGVzQ29tcGxldGVkU3luY2hyb25pemF0aW9uKSk7XG4gIH1cbiAgYXN5bmMgZGlzY29ubmVjdCguLi5zZXJ2aWNlcykgeyAvLyBTaHV0IGRvd24gdGhlIHNwZWNpZmllZCBzZXJ2aWNlcy5cbiAgICBpZiAoIXNlcnZpY2VzLmxlbmd0aCkgc2VydmljZXMgPSB0aGlzLnNlcnZpY2VzO1xuICAgIGNvbnN0IHtzeW5jaHJvbml6ZXJzfSA9IHRoaXM7XG4gICAgZm9yIChsZXQgc2VydmljZSBvZiBzZXJ2aWNlcykge1xuICAgICAgY29uc3Qgc3luY2hyb25pemVyID0gc3luY2hyb25pemVycy5nZXQoc2VydmljZSk7XG4gICAgICBpZiAoIXN5bmNocm9uaXplcikge1xuXHQvL2NvbnNvbGUud2FybihgJHt0aGlzLmZ1bGxMYWJlbH0gZG9lcyBub3QgaGF2ZSBhIHNlcnZpY2UgbmFtZWQgJyR7c2VydmljZX0nIHRvIGRpc2Nvbm5lY3QuYCk7XG5cdGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYXdhaXQgc3luY2hyb25pemVyLmRpc2Nvbm5lY3QoKTtcbiAgICB9XG4gIH1cbiAgYXN5bmMgZW5zdXJlU3luY2hyb25pemVyKHNlcnZpY2VOYW1lLCBjb25uZWN0aW9uLCBkYXRhQ2hhbm5lbCkgeyAvLyBNYWtlIHN1cmUgZGF0YUNoYW5uZWwgbWF0Y2hlcyB0aGUgc3luY2hyb25pemVyLCBjcmVhdGluZyBTeW5jaHJvbml6ZXIgb25seSBpZiBtaXNzaW5nLlxuICAgIGxldCBzeW5jaHJvbml6ZXIgPSB0aGlzLnN5bmNocm9uaXplcnMuZ2V0KHNlcnZpY2VOYW1lKTtcbiAgICBpZiAoIXN5bmNocm9uaXplcikge1xuICAgICAgc3luY2hyb25pemVyID0gbmV3IFN5bmNocm9uaXplcih7c2VydmljZU5hbWUsIGNvbGxlY3Rpb246IHRoaXMsIGRlYnVnOiB0aGlzLmRlYnVnfSk7XG4gICAgICBzeW5jaHJvbml6ZXIuY29ubmVjdGlvbiA9IGNvbm5lY3Rpb247XG4gICAgICBzeW5jaHJvbml6ZXIuZGF0YUNoYW5uZWxQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGRhdGFDaGFubmVsKTtcbiAgICAgIHRoaXMuc3luY2hyb25pemVycy5zZXQoc2VydmljZU5hbWUsIHN5bmNocm9uaXplcik7XG4gICAgICAvLyBEb2VzIE5PVCBzdGFydCBzeW5jaHJvbml6aW5nLiBDYWxsZXIgbXVzdCBkbyB0aGF0IGlmIGRlc2lyZWQuIChSb3V0ZXIgZG9lc24ndCBuZWVkIHRvLilcbiAgICB9IGVsc2UgaWYgKChzeW5jaHJvbml6ZXIuY29ubmVjdGlvbiAhPT0gY29ubmVjdGlvbikgfHxcblx0ICAgICAgIChzeW5jaHJvbml6ZXIuY2hhbm5lbE5hbWUgIT09IGRhdGFDaGFubmVsLmxhYmVsKSB8fFxuXHQgICAgICAgKGF3YWl0IHN5bmNocm9uaXplci5kYXRhQ2hhbm5lbFByb21pc2UgIT09IGRhdGFDaGFubmVsKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbm1hdGNoZWQgY29ubmVjdGlvbiBmb3IgJHtzZXJ2aWNlTmFtZX0uYCk7XG4gICAgfVxuICAgIHJldHVybiBzeW5jaHJvbml6ZXI7XG4gIH1cblxuICBwcm9taXNlKGtleSwgdGh1bmspIHsgcmV0dXJuIHRodW5rOyB9IC8vIFRPRE86IGhvdyB3aWxsIHdlIGtlZXAgdHJhY2sgb2Ygb3ZlcmxhcHBpbmcgZGlzdGluY3Qgc3luY3M/XG4gIHN5bmNocm9uaXplMSh0YWcpIHsgLy8gQ29tcGFyZSBhZ2FpbnN0IGFueSByZW1haW5pbmcgdW5zeW5jaHJvbml6ZWQgZGF0YSwgZmV0Y2ggd2hhdCdzIG5lZWRlZCwgYW5kIHJlc29sdmUgbG9jYWxseS5cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHN5bmNocm9uaXplciA9PiBzeW5jaHJvbml6ZXIuc3luY2hyb25pemF0aW9uUHJvbWlzZSh0YWcpKSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemVUYWdzKCkgeyAvLyBFbnN1cmUgdGhhdCB3ZSBoYXZlIHVwIHRvIGRhdGUgdGFnIG1hcCBhbW9uZyBhbGwgc2VydmljZXMuIChXZSBkb24ndCBjYXJlIHlldCBvZiB0aGUgdmFsdWVzIGFyZSBzeW5jaHJvbml6ZWQuKVxuICAgIHJldHVybiB0aGlzLnByb21pc2UoJ3RhZ3MnLCAoKSA9PiBQcm9taXNlLnJlc29sdmUoKSk7IC8vIFRPRE9cbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZURhdGEoKSB7IC8vIE1ha2UgdGhlIGRhdGEgdG8gbWF0Y2ggb3VyIHRhZ21hcCwgdXNpbmcgc3luY2hyb25pemUxLlxuICAgIHJldHVybiB0aGlzLnByb21pc2UoJ2RhdGEnLCAoKSA9PiBQcm9taXNlLnJlc29sdmUoKSk7IC8vIFRPRE9cbiAgfVxuICBzZXQgb251cGRhdGUoaGFuZGxlcikgeyAvLyBBbGxvdyBzZXR0aW5nIGluIGxpZXUgb2YgYWRkRXZlbnRMaXN0ZW5lci5cbiAgICBpZiAoaGFuZGxlcikge1xuICAgICAgdGhpcy5fdXBkYXRlID0gaGFuZGxlcjtcbiAgICAgIHRoaXMuYWRkRXZlbnRMaXN0ZW5lcigndXBkYXRlJywgaGFuZGxlcik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMucmVtb3ZlRXZlbnRMaXN0ZW5lcigndXBkYXRlJywgdGhpcy5fdXBkYXRlKTtcbiAgICAgIHRoaXMuX3VwZGF0ZSA9IGhhbmRsZXI7XG4gICAgfVxuICB9XG4gIGdldCBvbnVwZGF0ZSgpIHsgLy8gQXMgc2V0IGJ5IHRoaXMub251cGRhdGUgPSBoYW5kbGVyLiBEb2VzIE5PVCBhbnN3ZXIgdGhhdCB3aGljaCBpcyBzZXQgYnkgYWRkRXZlbnRMaXN0ZW5lci5cbiAgICByZXR1cm4gdGhpcy5fdXBkYXRlO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBJbW11dGFibGVDb2xsZWN0aW9uIGV4dGVuZHMgQ29sbGVjdGlvbiB7XG4gIHRhZ0ZvcldyaXRpbmcodGFnLCB2YWxpZGF0aW9uKSB7IC8vIElnbm9yZXMgdGFnLiBKdXN0IHRoZSBoYXNoLlxuICAgIHJldHVybiB2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gIH1cbiAgYXN5bmMgZGlzYWxsb3dXcml0ZSh0YWcsIGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpIHsgLy8gT3ZlcnJpZGVzIHN1cGVyIGJ5IGFsbG93aW5nIEVBUkxJRVIgcmF0aGVyIHRoYW4gbGF0ZXIuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG4gICAgaWYgKCFleGlzdGluZykge1xuICAgICAgaWYgKHZlcmlmaWVkLmxlbmd0aCAmJiAodGFnICE9PSBwcm9wb3NlZC5zdWIpKSByZXR1cm4gJ3dyb25nIHRhZyc7XG4gICAgICBpZiAoIWF3YWl0IHRoaXMuc3ViamVjdE1hdGNoKHZlcmlmaWVkKSkgcmV0dXJuICd3cm9uZyBoYXNoJztcbiAgICAgIHJldHVybiBudWxsOyAvLyBGaXJzdCB3cml0ZSBvay5cbiAgICB9XG4gICAgLy8gTm8gb3duZXIgbWF0Y2guIE5vdCByZWxldmFudCBmb3IgaW1tdXRhYmxlcy5cbiAgICBpZiAoIXZlcmlmaWVkLnBheWxvYWQubGVuZ3RoICYmIChwcm9wb3NlZC5pYXQgPiBleGlzdGluZy5pYXQpKSByZXR1cm4gbnVsbDsgLy8gTGF0ZXIgZGVsZXRlIGlzIG9rLlxuICAgIGlmIChwcm9wb3NlZC5pYXQgPiBleGlzdGluZy5pYXQpIHJldHVybiAncmV3cml0ZSc7IC8vIE90aGVyd2lzZSwgbGF0ZXIgd3JpdGVzIGFyZSBub3QuXG4gICAgaWYgKHByb3Bvc2VkLnN1YiAhPT0gZXhpc3Rpbmcuc3ViKSByZXR1cm4gJ2FsdGVyZWQgY29udGVudHMnO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5leHBvcnQgY2xhc3MgTXV0YWJsZUNvbGxlY3Rpb24gZXh0ZW5kcyBDb2xsZWN0aW9uIHtcbiAgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gVXNlIHRhZyBpZiBzcGVjaWZpZWQsIGJ1dCBkZWZhdWx0cyB0byBoYXNoLlxuICAgIHJldHVybiB0YWcgfHwgdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICB9XG59XG5cbi8vIEVhY2ggVmVyc2lvbmVkQ29sbGVjdGlvbiBoYXMgYSBzZXQgb2YgaGFzaC1pZGVudGlmaWVkIGltbXV0YWJsZSBpdGVtcyB0aGF0IGZvcm0gdGhlIGluZGl2aWR1YWwgdmVyc2lvbnMsIGFuZCBhIG1hcCBvZiB0aW1lc3RhbXBzIHRvIHRob3NlIGl0ZW1zLlxuLy8gV2UgY3VycmVudGx5IG1vZGVsIHRoaXMgYnkgaGF2aW5nIHRoZSBtYWluIGNvbGxlY3Rpb24gYmUgdGhlIG11dGFibGUgbWFwLCBhbmQgdGhlIHZlcnNpb25zIGluc3RhbmNlIHZhcmlhYmxlIGlzIHRoZSBpbW11dGFibGUgaXRlbXMgY29sbGVjdGlvbi5cbi8vIEJ1dCBhcHBzIHN0b3JlL3JldHJpZXZlIGluZGl2aWR1YWwgaXRlbXMgdGhyb3VnaCB0aGUgbWFpbiBjb2xsZWN0aW9uLCBhbmQgdGhlIGNvcnJlc3BvbmRpbmcgdXBkYXRlcyBhcmUgdGhyb3VnaCB0aGUgdmVyc2lvbnMsIHdoaWNoIGlzIGEgYml0IGF3a3dhcmQuXG5cbi8vIEVhY2ggaXRlbSBoYXMgYW4gYW50ZWNlZGVudCB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBhcHBsaWNhdGlvbi1zdXBwbGllZCBwYXlsb2FkIC0tIGl0IGxpdmVzIGluIHRoZSBzaWduYXR1cmUncyBoZWFkZXIuXG4vLyBIb3dldmVyOlxuLy8gLSBUaGUgdGFnIERPRVMgaW5jbHVkZSB0aGUgYW50ZWNlZGVudCwgZXZlbiB0aG91Z2ggaXQgaXMgbm90IHBhcnQgb2YgdGhlIHBheWxvYWQuIFRoaXMgbWFrZXMgaWRlbnRpY2FsIHBheWxvYWRzIGhhdmVcbi8vICAgdW5pcXVlIHRhZ3MgKGJlY2F1c2UgdGhleSB3aWxsIGFsd2F5cyBoYXZlIGRpZmZlcmVudCBhbnRlY2VkZW50cykuXG4vLyAtIFRoZSBhYmlsaXR5IHRvIHdyaXRlIGZvbGxvd3MgdGhlIHNhbWUgcnVsZXMgYXMgTXV0YWJsZUNvbGxlY3Rpb24gKGxhdGVzdCB3aW5zKSwgYnV0IGlzIHRlc3RlZCBhZ2FpbnN0IHRoZVxuLy8gICBhbnRlY2VkZW50IHRhZyBpbnN0ZWFkIG9mIHRoZSB0YWcgYmVpbmcgd3JpdHRlbi5cbmV4cG9ydCBjbGFzcyBWZXJzaW9uQ29sbGVjdGlvbiBleHRlbmRzIE11dGFibGVDb2xsZWN0aW9uIHsgLy8gTmVlZHMgdG8gYmUgZXhwb3J0ZWQgc28gdGhhdCB0aGF0IHJvdXRlci5tanMgY2FuIGZpbmQgaXQuXG4gIGFzeW5jIHRhZ0ZvcldyaXRpbmcodGFnLCB2YWxpZGF0aW9uKSB7IC8vIFVzZSB0YWcgaWYgc3BlY2lmaWVkIChlLmcuLCBwdXQvZGVsZXRlIGR1cmluZyBzeW5jaHJvbml6YXRpb24pLCBvdGh3ZXJ3aXNlIHJlZmxlY3QgYm90aCBzdWIgYW5kIGFudGVjZWRlbnQuXG4gICAgaWYgKHRhZykgcmV0dXJuIHRhZztcbiAgICAvLyBFYWNoIHZlcnNpb24gZ2V0cyBhIHVuaXF1ZSB0YWcgKGV2ZW4gaWYgdGhlcmUgYXJlIHR3byB2ZXJzaW9ucyB0aGF0IGhhdmUgdGhlIHNhbWUgZGF0YSBwYXlsb2FkKS5cbiAgICBjb25zdCBhbnQgPSB2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5hbnQ7XG4gICAgY29uc3QgcGF5bG9hZFRleHQgPSB2YWxpZGF0aW9uLnRleHQgfHwgbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHZhbGlkYXRpb24ucGF5bG9hZCk7XG4gICAgcmV0dXJuIENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChhd2FpdCBDcmVkZW50aWFscy5oYXNoVGV4dChhbnQgKyBwYXlsb2FkVGV4dCkpO1xuICB9XG4gIGFudGVjZWRlbnQodmFsaWRhdGlvbikgeyAvLyBSZXR1cm5zIHRoZSB0YWcgdGhhdCB2YWxpZGF0aW9uIGNvbXBhcmVzIGFnYWluc3QuIEUuZy4sIGRvIHRoZSBvd25lcnMgbWF0Y2g/XG4gICAgLy8gRm9yIG5vbi12ZXJzaW9uZWQgY29sbGVjdGlvbnMsIHdlIGNvbXBhcmUgYWdhaW5zdCB0aGUgZXhpc3RpbmcgZGF0YSBhdCB0aGUgc2FtZSB0YWcgYmVpbmcgd3JpdHRlbi5cbiAgICAvLyBGb3IgdmVyc2lvbmVkIGNvbGxlY3Rpb25zLCBpdCBpcyB3aGF0IGV4aXN0cyBhcyB0aGUgbGF0ZXN0IHZlcnNpb24gd2hlbiB0aGUgZGF0YSBpcyBzaWduZWQsIGFuZCB3aGljaCB0aGUgc2lnbmF0dXJlXG4gICAgLy8gcmVjb3JkcyBpbiB0aGUgc2lnbmF0dXJlLiAoRm9yIHRoZSB2ZXJ5IGZpcnN0IHZlcnNpb24sIHRoZSBzaWduYXR1cmUgd2lsbCBub3RlIHRoZSB0aW1lc3RhbXAgYXMgdGhlIGFudGVjZWNkZW50IHRhZyxcbiAgICAvLyAoc2VlIHRhZ0ZvcldyaXRpbmcpLCBidXQgZm9yIGNvbXBhcmluZyBhZ2FpbnN0LCB0aGlzIG1ldGhvZCBhbnN3ZXJzIGZhbHN5IGZvciB0aGUgZmlyc3QgaW4gdGhlIGNoYWluLlxuICAgIGNvbnN0IGhlYWRlciA9IHZhbGlkYXRpb24/LnByb3RlY3RlZEhlYWRlcjtcbiAgICBpZiAoIWhlYWRlcikgcmV0dXJuICcnO1xuICAgIGNvbnN0IGFudGVjZWRlbnQgPSBoZWFkZXIuYW50O1xuICAgIGlmICh0eXBlb2YoYW50ZWNlZGVudCkgPT09ICdudW1iZXInKSByZXR1cm4gJyc7IC8vIEEgdGltZXN0YW1wIGFzIGFudGVjZWRlbnQgaXMgdXNlZCB0byB0byBzdGFydCB0aGluZ3Mgb2ZmLiBObyB0cnVlIGFudGVjZWRlbnQuXG4gICAgcmV0dXJuIGFudGVjZWRlbnQ7XG4gIH1cbiAgYXN5bmMgc3ViamVjdE1hdGNoKHZlcmlmaWVkKSB7IC8vIEhlcmUgc3ViIHJlZmVycyB0byB0aGUgb3ZlcmFsbCBpdGVtIHRhZyB0aGF0IGVuY29tcGFzc2VzIGFsbCB2ZXJzaW9ucywgbm90IHRoZSBwYXlsb2FkIGhhc2guXG4gICAgcmV0dXJuIHRydWU7IC8vIFRPRE86IG1ha2Ugc3VyZSBpdCBtYXRjaGVzIHByZXZpb3VzP1xuICB9XG4gIGVtaXQodmVyaWZpZWQpIHsgLy8gc3ViamVjdFRhZyAoaS5lLiwgdGhlIHRhZyB3aXRoaW4gdGhlIGNvbGxlY3Rpb24gYXMgYSB3aG9sZSkgaXMgbm90IHRoZSB0YWcvaGFzaC5cbiAgICB2ZXJpZmllZC5zdWJqZWN0VGFnID0gdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgICBzdXBlci5lbWl0KHZlcmlmaWVkKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbiBleHRlbmRzIE11dGFibGVDb2xsZWN0aW9uIHtcbiAgLy8gVE9ETzogVGhpcyB3b3JrcyBhbmQgZGVtb25zdHJhdGVzIGhhdmluZyBhIGNvbGxlY3Rpb24gdXNpbmcgb3RoZXIgY29sbGVjdGlvbnMuXG4gIC8vIEhvd2V2ZXIsIGhhdmluZyBhIGJpZyB0aW1lc3RhbXAgPT4gZml4bnVtIG1hcCBpcyBiYWQgZm9yIHBlcmZvcm1hbmNlIGFzIHRoZSBoaXN0b3J5IGdldHMgbG9uZ2VyLlxuICAvLyBUaGlzIHNob3VsZCBiZSBzcGxpdCB1cCBpbnRvIHdoYXQgaXMgZGVzY3JpYmVkIGluIHZlcnNpb25lZC5tZC5cbiAgY29uc3RydWN0b3Ioe3NlcnZpY2VzID0gW10sIC4uLnJlc3R9ID0ge30pIHtcbiAgICBzdXBlcihyZXN0KTsgIC8vIFdpdGhvdXQgcGFzc2luZyBzZXJ2aWNlcyB5ZXQsIGFzIHdlIGRvbid0IGhhdmUgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24gc2V0IHVwIHlldC5cbiAgICB0aGlzLnZlcnNpb25zID0gbmV3IFZlcnNpb25Db2xsZWN0aW9uKHJlc3QpOyAvLyBTYW1lIGNvbGxlY3Rpb24gbmFtZSwgYnV0IGRpZmZlcmVudCB0eXBlLlxuICAgIC8vZml4bWUgdGhpcy52ZXJzaW9ucy5hZGRFdmVudExpc3RlbmVyKCd1cGRhdGUnLCBldmVudCA9PiB0aGlzLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KCd1cGRhdGUnLCB7ZGV0YWlsOiB0aGlzLnJlY292ZXJUYWcoZXZlbnQuZGV0YWlsKX0pKSk7XG4gICAgdGhpcy5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7IC8vIE5vdyB3ZSBjYW4gc3luY2hyb25pemUuXG4gIH1cbiAgYXN5bmMgY2xvc2UoKSB7XG4gICAgYXdhaXQgdGhpcy52ZXJzaW9ucy5jbG9zZSgpO1xuICAgIGF3YWl0IHN1cGVyLmNsb3NlKCk7XG4gIH1cbiAgYXN5bmMgZGVzdHJveSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmRlc3Ryb3koKTtcbiAgICBhd2FpdCBzdXBlci5kZXN0cm95KCk7XG4gIH1cbiAgcmVjb3ZlclRhZyh2ZXJpZmllZCkgeyAvLyB0aGUgdmVyaWZpZWQudGFnIGlzIGZvciB0aGUgdmVyc2lvbi4gV2Ugd2FudCB0aGUgb3ZlcmFsbCBvbmUuXG4gICAgcmV0dXJuIE9iamVjdC5hc3NpZ24oe30sIHZlcmlmaWVkLCB7dGFnOiB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3VifSk7IC8vIERvIG5vdCBiYXNoIHZlcmlmaWVkIVxuICB9XG4gIHNlcnZpY2VGb3JWZXJzaW9uKHNlcnZpY2UpIHsgLy8gR2V0IHRoZSBzZXJ2aWNlIFwibmFtZVwiIGZvciBvdXIgdmVyc2lvbnMgY29sbGVjdGlvbi5cbiAgICByZXR1cm4gc2VydmljZT8udmVyc2lvbnMgfHwgc2VydmljZTsgICAvLyBGb3IgdGhlIHdlaXJkIGNvbm5lY3REaXJlY3RUZXN0aW5nIGNhc2UgdXNlZCBpbiByZWdyZXNzaW9uIHRlc3RzLCBlbHNlIHRoZSBzZXJ2aWNlIChlLmcuLCBhbiBhcnJheSBvZiBzaWduYWxzKS5cbiAgfVxuICBzZXJ2aWNlc0ZvclZlcnNpb24oc2VydmljZXMpIHtcbiAgICByZXR1cm4gc2VydmljZXMubWFwKHNlcnZpY2UgPT4gdGhpcy5zZXJ2aWNlRm9yVmVyc2lvbihzZXJ2aWNlKSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemUoLi4uc2VydmljZXMpIHsgLy8gc3luY2hyb25pemUgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24sIHRvby5cbiAgICBpZiAoIXNlcnZpY2VzLmxlbmd0aCkgcmV0dXJuO1xuICAgIC8vIEtlZXAgY2hhbm5lbCBjcmVhdGlvbiBzeW5jaHJvbm91cy5cbiAgICBjb25zdCB2ZXJzaW9uZWRQcm9taXNlID0gc3VwZXIuc3luY2hyb25pemUoLi4uc2VydmljZXMpO1xuICAgIGNvbnN0IHZlcnNpb25Qcm9taXNlID0gdGhpcy52ZXJzaW9ucy5zeW5jaHJvbml6ZSguLi50aGlzLnNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykpO1xuICAgIGF3YWl0IHZlcnNpb25lZFByb21pc2U7XG4gICAgYXdhaXQgdmVyc2lvblByb21pc2U7XG4gIH1cbiAgYXN5bmMgZGlzY29ubmVjdCguLi5zZXJ2aWNlcykgeyAvLyBkaXNjb25uZWN0IHRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uLCB0b28uXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHNlcnZpY2VzID0gdGhpcy5zZXJ2aWNlcztcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmRpc2Nvbm5lY3QoLi4udGhpcy5zZXJ2aWNlc0ZvclZlcnNpb24oc2VydmljZXMpKTtcbiAgICBhd2FpdCBzdXBlci5kaXNjb25uZWN0KC4uLnNlcnZpY2VzKTtcbiAgfVxuICBnZXQgc3luY2hyb25pemVkKCkgeyAvLyBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBzeW5jaHJvbml6YXRpb24gaXMgY29tcGxldGUgaW4gQk9USCBkaXJlY3Rpb25zLlxuICAgIC8vIFRPRE8/IFRoaXMgZG9lcyBub3QgcmVmbGVjdCBjaGFuZ2VzIGFzIFN5bmNocm9uaXplcnMgYXJlIGFkZGVkIG9yIHJlbW92ZWQgc2luY2UgY2FsbGVkLiBTaG91bGQgaXQ/XG4gICAgcmV0dXJuIHN1cGVyLnN5bmNocm9uaXplZC50aGVuKCgpID0+IHRoaXMudmVyc2lvbnMuc3luY2hyb25pemVkKTtcbiAgfVxuICBnZXQgaXRlbUVtaXR0ZXIoKSB7IC8vIFRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uIGVtaXRzIGFuIHVwZGF0ZSBjb3JyZXNwb25kaW5nIHRvIHRoZSBpbmRpdmlkdWFsIGl0ZW0gc3RvcmVkLlxuICAgIC8vIChUaGUgdXBkYXRlcyBlbWl0dGVkIGZyb20gdGhlIHdob2xlIG11dGFibGUgVmVyc2lvbmVkQ29sbGVjdGlvbiBjb3JyZXNwb25kIHRvIHRoZSBtYXAuKVxuICAgIHJldHVybiB0aGlzLnZlcnNpb25zO1xuICB9XG5cbiAgYXN5bmMgZ2V0VmVyc2lvbnModGFnKSB7IC8vIFByb21pc2VzIHRoZSBwYXJzZWQgdGltZXN0YW1wID0+IHZlcnNpb24gZGljdGlvbmFyeSBJRiBpdCBleGlzdHMsIGVsc2UgZmFsc3kuXG4gICAgdGhpcy5yZXF1aXJlVGFnKHRhZyk7XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWd9KTtcbiAgICBjb25zdCBqc29uID0gdmVyaWZpZWQ/Lmpzb247XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGpzb24pKSByZXR1cm4ganNvbjtcbiAgICAvLyBJZiB3ZSBoYXZlIGFuIHVubWVyZ2VkIGFycmF5IG9mIHNpZ25hdHVyZXMuLi5cbiAgICAvLyBJJ20gbm90IHN1cmUgdGhhdCBpdCdzIHZlcnkgdXNlZnVsIHRvIGFwcGxpY2F0aW9ucyBmb3IgdXMgdG8gaGFuZGxlIHRoaXMgY2FzZSwgYnV0IGl0IGlzIG5pY2UgdG8gZXhlcmNpc2UgdGhpcyBpbiB0ZXN0aW5nLlxuICAgIGNvbnN0IHZlcmlmaWNhdGlvbnNBcnJheSA9IGF3YWl0IHRoaXMuZW5zdXJlRXhwYW5kZWQodmVyaWZpZWQpO1xuICAgIHJldHVybiB0aGlzLmNvbWJpbmVUaW1lc3RhbXBzKHRhZywgbnVsbCwgLi4udmVyaWZpY2F0aW9uc0FycmF5Lm1hcCh2ID0+IHYuanNvbikpO1xuICB9XG4gIGFzeW5jIHJldHJpZXZlVGltZXN0YW1wcyh0YWcpIHsgLy8gUHJvbWlzZXMgYSBsaXN0IG9mIGFsbCB2ZXJzaW9uIHRpbWVzdGFtcHMuXG4gICAgY29uc3QgdmVyc2lvbnMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgaWYgKCF2ZXJzaW9ucykgcmV0dXJuIHZlcnNpb25zO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh2ZXJzaW9ucykuc2xpY2UoMSkubWFwKHN0cmluZyA9PiBwYXJzZUludChzdHJpbmcpKTsgLy8gVE9ETz8gTWFwIHRoZXNlIHRvIGludGVnZXJzP1xuICB9XG4gIGdldEFjdGl2ZUhhc2godGltZXN0YW1wcywgdGltZSA9IHRpbWVzdGFtcHMubGF0ZXN0KSB7IC8vIFByb21pc2VzIHRoZSB2ZXJzaW9uIHRhZyB0aGF0IHdhcyBpbiBmb3JjZSBhdCB0aGUgc3BlY2lmaWVkIHRpbWVcbiAgICAvLyAod2hpY2ggbWF5IGJlZm9yZSwgaW4gYmV0d2Vlbiwgb3IgYWZ0ZXIgdGhlIHJlY29yZGVkIGRpc2NyZXRlIHRpbWVzdGFtcHMpLlxuICAgIGlmICghdGltZXN0YW1wcykgcmV0dXJuIHRpbWVzdGFtcHM7XG4gICAgbGV0IGhhc2ggPSB0aW1lc3RhbXBzW3RpbWVdO1xuICAgIGlmIChoYXNoKSByZXR1cm4gaGFzaDtcbiAgICAvLyBXZSBuZWVkIHRvIGZpbmQgdGhlIHRpbWVzdGFtcCB0aGF0IHdhcyBpbiBmb3JjZSBhdCB0aGUgcmVxdWVzdGVkIHRpbWUuXG4gICAgbGV0IGJlc3QgPSAwLCB0aW1lcyA9IE9iamVjdC5rZXlzKHRpbWVzdGFtcHMpO1xuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgdGltZXMubGVuZ3RoOyBpKyspIHsgLy8gMHRoIGlzIHRoZSBrZXkgJ2xhdGVzdCcuXG4gICAgICBpZiAodGltZXNbaV0gPD0gdGltZSkgYmVzdCA9IHRpbWVzW2ldO1xuICAgICAgZWxzZSBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIHRpbWVzdGFtcHNbYmVzdF07XG4gIH1cbiAgYXN5bmMgcmV0cmlldmUodGFnT3JPcHRpb25zKSB7IC8vIEFuc3dlciB0aGUgdmFsaWRhdGVkIHZlcnNpb24gaW4gZm9yY2UgYXQgdGhlIHNwZWNpZmllZCB0aW1lIChvciBsYXRlc3QpLCBvciBhdCB0aGUgc3BlY2lmaWMgaGFzaC5cbiAgICBsZXQge3RhZywgdGltZSwgaGFzaCwgLi4ucmVzdH0gPSAoIXRhZ09yT3B0aW9ucyB8fCB0YWdPck9wdGlvbnMubGVuZ3RoKSA/IHt0YWc6IHRhZ09yT3B0aW9uc30gOiB0YWdPck9wdGlvbnM7XG4gICAgaWYgKCFoYXNoKSB7XG4gICAgICBjb25zdCB0aW1lc3RhbXBzID0gYXdhaXQgdGhpcy5nZXRWZXJzaW9ucyh0YWcpO1xuICAgICAgaWYgKCF0aW1lc3RhbXBzKSByZXR1cm4gdGltZXN0YW1wcztcbiAgICAgIGhhc2ggPSB0aGlzLmdldEFjdGl2ZUhhc2godGltZXN0YW1wcywgdGltZSk7XG4gICAgICBpZiAoIWhhc2gpIHJldHVybiAnJztcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMudmVyc2lvbnMucmV0cmlldmUoe3RhZzogaGFzaCwgLi4ucmVzdH0pO1xuICB9XG4gIGFzeW5jIHN0b3JlKGRhdGEsIG9wdGlvbnMgPSB7fSkgeyAvLyBEZXRlcm1pbmUgdGhlIGFudGVjZWRlbnQsIHJlY29yZCBpdCBpbiB0aGUgc2lnbmF0dXJlLCBhbmQgc3RvcmUgdGhhdFxuICAgIC8vIGFzIHRoZSBhcHByb3ByaWF0ZSB2ZXJzaW9uIGhhc2guIFRoZW4gcmVjb3JkIHRoZSBuZXcgdGltZXN0YW1wL2hhc2ggaW4gdGhlIHRpbWVzdGFtcHMgbGlzdC5cbiAgICBsZXQgdmVyc2lvbnMsXG5cdC8vIFRPRE86IENvbnNpZGVyIGVuY3J5cHRpbmcgdGhlIHRpbWVzdGFtcHMsIHRvby5cblx0Ly8gQ3VycmVudGx5LCBzaWduaW5nT3B0aW9ucyBmb3IgdGhlIHRpbWVzdGFtcHMgZG9lcyBOT1QgZW5jbHVkZSBlbmNyeXB0aW9uLCBldmVuIGlmIHNwZWNpZmllZCBmb3IgdGhlIGFjdHVhbCBzcGVjaWZpYyB2ZXJzaW9uIGluZm8uXG5cdC8vIFRoaXMgbWVhbnMgdGhhdCBpZiB0aGUgYXBwbGljYXRpb24gc3BlY2lmaWVzIGFuIGVuY3J5cHRlZCB2ZXJzaW9uZWQgY29sbGVjdGlvbiwgdGhlIGRhdGEgaXRzZWxmIHdpbGwgYmUgZW5jcnlwdGVkLCBidXRcblx0Ly8gbm90IHRoZSBtYXAgb2YgdGltZXN0YW1wcyB0byBoYXNoZXMsIGFuZCBzbyBhIGx1cmtlciBjYW4gc2VlIHdoZW4gdGhlcmUgd2FzIGFjdGl2aXRpdHkgYW5kIGhhdmUgYW4gaWRlYSBhcyB0byB0aGUgc2l6ZS5cblx0Ly8gT2YgY291cnNlLCBldmVuIGlmIGVuY3J5cHRlZCwgdGhleSBjb3VsZCBhbHNvIGdldCB0aGlzIGZyb20gbGl2ZSB0cmFmZmljIGFuYWx5c2lzLCBzbyBtYXliZSBlbmNyeXB0aW5nIGl0IHdvdWxkIGp1c3Rcblx0Ly8gY29udmV5IGEgZmFsc2Ugc2Vuc2Ugb2Ygc2VjdXJpdHkuIEVuY3J5cHRpbmcgdGhlIHRpbWVzdGFtcHMgZG9lcyBjb21wbGljYXRlLCBlLmcuLCBtZXJnZVNpZ25hdHVyZXMoKSBiZWNhdXNlXG5cdC8vIHNvbWUgb2YgdGhlIHdvcmsgY291bGQgb25seSBiZSBkb25lIGJ5IHJlbGF5cyB0aGF0IGhhdmUgYWNjZXNzLiBCdXQgc2luY2Ugd2UgaGF2ZSB0byBiZSBjYXJlZnVsIGFib3V0IHNpZ25pbmcgYW55d2F5LFxuXHQvLyB3ZSBzaG91bGQgdGhlb3JldGljYWxseSBiZSBhYmxlIHRvIGJlIGFjY29tb2RhdGUgdGhhdC5cblx0e3RhZywgZW5jcnlwdGlvbiwgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKSxcblx0dGltZSA9IERhdGUubm93KCksXG5cdHZlcnNpb25PcHRpb25zID0gT2JqZWN0LmFzc2lnbih7dGltZSwgZW5jcnlwdGlvbn0sIHNpZ25pbmdPcHRpb25zKTtcbiAgICBpZiAodGFnKSB7XG4gICAgICB2ZXJzaW9ucyA9IChhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZykpIHx8IHt9O1xuICAgICAgdmVyc2lvbk9wdGlvbnMuc3ViID0gdGFnO1xuICAgICAgaWYgKHZlcnNpb25zKSB7XG5cdHZlcnNpb25PcHRpb25zLmFudCA9IHZlcnNpb25zW3ZlcnNpb25zLmxhdGVzdF07XG4gICAgICB9XG4gICAgfSAvLyBFbHNlIGRvIG5vdCBhc3NpZ24gc3ViLiBJdCB3aWxsIGJlIHNldCB0byB0aGUgcGF5bG9hZCBoYXNoIGR1cmluZyBzaWduaW5nLCBhbmQgYWxzbyB1c2VkIGZvciB0aGUgb3ZlcmFsbCB0YWcuXG4gICAgdmVyc2lvbk9wdGlvbnMuYW50IHx8PSB0aW1lO1xuICAgIGNvbnN0IGhhc2ggPSBhd2FpdCB0aGlzLnZlcnNpb25zLnN0b3JlKGRhdGEsIHZlcnNpb25PcHRpb25zKTtcbiAgICBpZiAoIXRhZykgeyAvLyBXZSdsbCBzdGlsbCBuZWVkIHRhZyBhbmQgdmVyc2lvbnMuXG4gICAgICBjb25zdCB2ZXJzaW9uU2lnbmF0dXJlID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5nZXQoaGFzaCk7XG4gICAgICBjb25zdCBjbGFpbXMgPSBDcmVkZW50aWFscy5kZWNvZGVDbGFpbXModGhpcy5jb25zdHJ1Y3Rvci5tYXliZUluZmxhdGUodmVyc2lvblNpZ25hdHVyZSkpO1xuICAgICAgdGFnID0gY2xhaW1zLnN1YjtcbiAgICAgIHZlcnNpb25zID0ge307XG4gICAgfVxuICAgIHZlcnNpb25zLmxhdGVzdCA9IHRpbWU7XG4gICAgdmVyc2lvbnNbdGltZV0gPSBoYXNoO1xuXG4gICAgLy8gZml4bWUgbmV4dFxuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbih2ZXJzaW9ucywgc2lnbmluZ09wdGlvbnMpO1xuICAgIC8vIEhlcmUgd2UgYXJlIGRvaW5nIHdoYXQgdGhpcy5wdXQoKSB3b3VsZCBub3JtYWxseSBkbywgYnV0IHdlIGhhdmUgYWxyZWFkeSBtZXJnZWQgc2lnbmF0dXJlcy5cbiAgICBhd2FpdCB0aGlzLmFkZFRhZyh0YWcpO1xuICAgIGF3YWl0IHRoaXMucGVyc2lzdCh0YWcsIHNpZ25hdHVyZSk7XG4gICAgdGhpcy5lbWl0KHt0YWcsIHN1YmplY3RUYWc6IHRhZywgLi4uKGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSkpfSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgLy8gY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmaWVkU2lnbih2ZXJzaW9ucywgc2lnbmluZ09wdGlvbnMsIHRhZyk7XG4gICAgLy8gdGhpcy5sb2coJ3B1dCgtaXNoKScsIHZlcmlmaWVkKTtcbiAgICAvLyBhd2FpdCB0aGlzLnBlcnNpc3QyKHZlcmlmaWVkKTtcbiAgICAvLyBhd2FpdCB0aGlzLmFkZFRhZyh0YWcpO1xuICAgIC8vIHRoaXMuZW1pdCh7Li4udmVyaWZpZWQsIHRhZywgc3ViamVjdFRhZzogdGFnfSk7XG4gICAgLy8gYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZlcmlmaWVkLnNpZ25hdHVyZSkpO1xuXG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZW1vdmUob3B0aW9ucyA9IHt9KSB7IC8vIEFkZCBhbiBlbXB0eSB2ZXJpb24gb3IgcmVtb3ZlIGFsbCB2ZXJzaW9ucywgZGVwZW5kaW5nIG9uIHRoaXMucHJlc2VydmVEZWxldGlvbnMuXG4gICAgbGV0IHtlbmNyeXB0aW9uLCB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7IC8vIElnbm9yZSBlbmNyeXB0aW9uXG4gICAgY29uc3QgdmVyc2lvbnMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgaWYgKCF2ZXJzaW9ucykgcmV0dXJuIHZlcnNpb25zO1xuICAgIGlmICh0aGlzLnByZXNlcnZlRGVsZXRpb25zKSB7IC8vIENyZWF0ZSBhIHRpbWVzdGFtcCA9PiB2ZXJzaW9uIHdpdGggYW4gZW1wdHkgcGF5bG9hZC4gT3RoZXJ3aXNlIG1lcmdpbmcgd2l0aCBlYXJsaWVyIGRhdGEgd2lsbCBicmluZyBpdCBiYWNrIVxuICAgICAgYXdhaXQgdGhpcy5zdG9yZSgnJywgc2lnbmluZ09wdGlvbnMpO1xuICAgIH0gZWxzZSB7IC8vIEFjdHVhbGx5IGRlbGV0ZSB0aGUgdGltZXN0YW1wcyBhbmQgZWFjaCB2ZXJzaW9uLlxuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgY29uc3QgdmVyc2lvblRhZ3MgPSBPYmplY3QudmFsdWVzKHZlcnNpb25zKS5zbGljZSgxKTtcbiAgICAgIGNvbnN0IHZlcnNpb25TaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oJycsIHtzdWI6IHRhZywgLi4uc2lnbmluZ09wdGlvbnN9KTtcbiAgICAgIC8vIFRPRE86IElzIHRoaXMgc2FmZT8gU2hvdWxkIHdlIG1ha2UgYSBzaWduYXR1cmUgdGhhdCBzcGVjaWZpZXMgZWFjaCBhbnRlY2VkZW50P1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwodmVyc2lvblRhZ3MubWFwKGFzeW5jIHRhZyA9PiB7XG5cdGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlKHRhZywgdmVyc2lvblNpZ25hdHVyZSk7XG5cdGF3YWl0IHRoaXMudmVyc2lvbnMucHVzaCgnZGVsZXRlJywgdGFnLCB2ZXJzaW9uU2lnbmF0dXJlKTtcbiAgICAgIH0pKTtcbiAgICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbignJywgc2lnbmluZ09wdGlvbnMpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0KHRhZywgc2lnbmF0dXJlLCAnZGVsZXRlJyk7XG4gICAgICBhd2FpdCB0aGlzLnB1c2goJ2RlbGV0ZScsIHRhZywgc2lnbmF0dXJlKTtcbiAgICAgIC8vIGNvbnN0IHZlcnNpb25IYXNoZXMgPSBPYmplY3QudmFsdWVzKHZlcnNpb25zKS5zbGljZSgxKTtcbiAgICAgIC8vIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZmllZFNpZ24oJycsIHtzdWI6IHRhZywgLi4uc2lnbmluZ09wdGlvbnN9LCB0YWcpO1xuICAgICAgLy8gLy8gVE9ETzogSXMgdGhpcyBzYWZlPyBTaG91bGQgd2UgbWFrZSBhIHNpZ25hdHVyZSB0aGF0IHNwZWNpZmllcyBlYWNoIGFudGVjZWRlbnQ/XG4gICAgICAvLyBhd2FpdCBQcm9taXNlLmFsbCh2ZXJzaW9uSGFzaGVzLm1hcChhc3luYyBoYXNoID0+IHtcbiAgICAgIC8vIFx0bGV0IHZWZXJpZmllZCA9IHsuLi52ZXJpZmllZCwgdGFnOiBoYXNofTtcbiAgICAgIC8vIFx0bGV0IHNWZXJpZmllZCA9IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZWZXJpZmllZC5zaWduYXR1cmUpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLmRlbGV0ZVRhZyh0YWcpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLnBlcnNpc3QyKHZWZXJpZmllZCwgJ2RlbGV0ZScpO1xuICAgICAgLy8gXHQvLyB0aGlzLnZlcnNpb25zLmVtaXQodlZlcmlmaWVkKTtcbiAgICAgIC8vIFx0Ly8gYXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHNWZXJpZmllZCk7XG4gICAgICAvLyBcdGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlKHRhZywgc1ZlcmlmaWVkKTtcbiAgICAgIC8vIFx0YXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHNWZXJpZmllZClcbiAgICAgIC8vIH0pKTtcbiAgICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIodmVyaWZpZWQsICdkZWxldGUnKTtcbiAgICAgIC8vIGF3YWl0IHRoaXMucHVzaCgnZGVsZXRlJywgdGFnLCB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZVN0cmluZyh2ZXJpZmllZC5zaWduYXR1cmUpKTtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIG1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSwgYXV0aG9yT3ZlcnJpZGUgPSBudWxsKSB7IC8vIE1lcmdlIHRoZSBuZXcgdGltZXN0YW1wcyB3aXRoIHRoZSBvbGQuXG4gICAgLy8gSWYgcHJldmlvdXMgZG9lc24ndCBleGlzdCBvciBtYXRjaGVzIHRoZSBuZXh0LCBvciBpcyBhIHN1YnNldCBvZiB0aGUgbmV4dCwganVzdCB1c2UgdGhlIG5leHQuXG4gICAgLy8gT3RoZXJ3aXNlLCB3ZSBoYXZlIHRvIG1lcmdlOlxuICAgIC8vIC0gTWVyZ2VkIG11c3QgY29udGFpbiB0aGUgdW5pb24gb2YgdmFsdWVzIGZvciBlaXRoZXIuXG4gICAgLy8gICAoU2luY2UgdmFsdWVzIGFyZSBoYXNoZXMgb2Ygc3R1ZmYgd2l0aCBhbiBleHBsaWNpdCBhbnRlZGVudCwgbmV4dCBwcmV2aW91cyBub3IgbmV4dCB3aWxsIGhhdmUgZHVwbGljYXRlcyBieSB0aGVtc2VsdmVzLi4pXG4gICAgLy8gLSBJZiB0aGVyZSdzIGEgY29uZmxpY3QgaW4ga2V5cywgY3JlYXRlIGEgbmV3IGtleSB0aGF0IGlzIG1pZHdheSBiZXR3ZWVuIHRoZSBjb25mbGljdCBhbmQgdGhlIG5leHQga2V5IGluIG9yZGVyLlxuXG4gICAgbGV0IG5leHQgPSB2YWxpZGF0aW9uO1xuICAgIGxldCBwcmV2aW91cyA9IHZhbGlkYXRpb24uZXhpc3Rpbmc7XG4gICAgLy9maXhtZSBuZXh0XG4gICAgaWYgKCFwcmV2aW91cykgcmV0dXJuIHNpZ25hdHVyZTsgICAvLyBObyBwcmV2aW91cywganVzdCB1c2UgbmV3IHNpZ25hdHVyZS5cbiAgICAvL2lmICghcHJldmlvdXMpIHJldHVybiBuZXh0OyAgIC8vIE5vIHByZXZpb3VzLCBqdXN0IG5leHQuXG5cbiAgICAvLyBBdCB0aGlzIHBvaW50LCBwcmV2aW91cyBhbmQgbmV4dCBhcmUgYm90aCBcIm91dGVyXCIgdmFsaWRhdGlvbnMuXG4gICAgLy8gVGhhdCBqc29uIGNhbiBiZSBlaXRoZXIgYSB0aW1lc3RhbXAgb3IgYW4gYXJyYXkgb2Ygc2lnbmF0dXJlcy5cbiAgICBpZiAodmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIuaWF0IDwgdmFsaWRhdGlvbi5leGlzdGluZy5wcm90ZWN0ZWRIZWFkZXIuaWF0KSB7IC8vIEFycmFuZ2UgZm9yIG5leHQgYW5kIHNpZ25hdHVyZSB0byBiZSBsYXRlciBvbmUgYnkgc2lnbmVkIHRpbWVzdGFtcC5cbiAgICAgIC8vIFRPRE86IGlzIGl0IHBvc3NpYmxlIHRvIGNvbnN0cnVjdCBhIHNjZW5hcmlvIGluIHdoaWNoIHRoZXJlIGlzIGEgZmljdGl0aW91cyB0aW1lIHN0YW1wIGNvbmZsaWN0LiBFLmcsIGlmIGFsbCBvZiB0aGVzZSBhcmUgdHJ1ZTpcbiAgICAgIC8vIDEuIHByZXZpb3VzIGFuZCBuZXh0IGhhdmUgaWRlbnRpY2FsIHRpbWVzdGFtcHMgZm9yIGRpZmZlcmVudCB2YWx1ZXMsIGFuZCBzbyB3ZSBuZWVkIHRvIGNvbnN0cnVjdCBhcnRpZmljaWFsIHRpbWVzIGZvciBvbmUuIExldCdzIGNhbGwgdGhlc2UgYnJhbmNoIEEgYW5kIEIuXG4gICAgICAvLyAyLiB0aGlzIGhhcHBlbnMgd2l0aCB0aGUgc2FtZSB0aW1lc3RhbXAgaW4gYSBzZXBhcmF0ZSBwYWlyLCB3aGljaCB3ZSdsbCBjYWxsIEEyLCBhbmQgQjIuXG4gICAgICAvLyAzLiBBIGFuZCBCIGFyZSBtZXJnZWQgaW4gdGhhdCBvcmRlciAoZS5nLiB0aGUgbGFzdCB0aW1lIGluIEEgaXMgbGVzcyB0aGFuIEIpLCBidXQgQTIgYW5kIEIyIGFyZSBtZXJnZWQgYmFja3dhcmRzIChlLmcuLCB0aGUgbGFzdCB0aW1lIGluIEIyIGlzIGxlc3MgdGhhbnQgQTIpLFxuICAgICAgLy8gICAgc3VjaCB0aGF0IHRoZSBvdmVyYWxsIG1lcmdlIGNyZWF0ZXMgYSBjb25mbGljdD9cbiAgICAgIFtwcmV2aW91cywgbmV4dF0gPSBbbmV4dCwgcHJldmlvdXNdO1xuICAgIH1cblxuICAgIC8vIEZpbmQgdGhlIHRpbWVzdGFtcHMgb2YgcHJldmlvdXMgd2hvc2UgVkFMVUVTIHRoYXQgYXJlIG5vdCBpbiBuZXh0LlxuICAgIGxldCBrZXlzT2ZNaXNzaW5nID0gbnVsbDtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocHJldmlvdXMuanNvbikgJiYgIUFycmF5LmlzQXJyYXkobmV4dC5qc29uKSkgeyAvLyBObyBwb2ludCBpbiBvcHRpbWl6aW5nIHRocm91Z2ggbWlzc2luZ0tleXMgaWYgdGhhdCBtYWtlcyB1cyBjb21iaW5lVGltZXN0YW1wcyBhbnl3YXkuXG4gICAgICBrZXlzT2ZNaXNzaW5nID0gdGhpcy5taXNzaW5nS2V5cyhwcmV2aW91cy5qc29uLCBuZXh0Lmpzb24pO1xuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgaWYgKCFrZXlzT2ZNaXNzaW5nLmxlbmd0aCkgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKG5leHQuc2lnbmF0dXJlKTsgLy8gUHJldmlvdXMgaXMgYSBzdWJzZXQgb2YgbmV3IHNpZ25hdHVyZS5cbiAgICAgIC8vaWYgKCFrZXlzT2ZNaXNzaW5nLmxlbmd0aCkgcmV0dXJuIG5leHQ7IC8vIFByZXZpb3VzIGlzIGEgc3Vic2V0IG9mIG5ldyBzaWduYXR1cmUuXG4gICAgfVxuICAgIC8vIFRPRE86IHJldHVybiBwcmV2aW91cyBpZiBuZXh0IGlzIGEgc3Vic2V0IG9mIGl0P1xuXG4gICAgLy8gV2UgY2Fubm90IHJlLXVzZSBvbmUgb3Igb3RoZXIuIFNpZ24gYSBuZXcgbWVyZ2VkIHJlc3VsdC5cbiAgICBjb25zdCBwcmV2aW91c1ZhbGlkYXRpb25zID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZChwcmV2aW91cyk7XG4gICAgY29uc3QgbmV4dFZhbGlkYXRpb25zID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZChuZXh0KTtcbiAgICAvLyBXZSBjYW4gb25seSB0cnVseSBtZXJnZSBpZiB3ZSBhcmUgYW4gb3duZXIuXG4gICAgY29uc3QgaGVhZGVyID0gcHJldmlvdXNWYWxpZGF0aW9uc1swXS5wcm90ZWN0ZWRIZWFkZXI7XG4gICAgbGV0IG93bmVyID0gaGVhZGVyLmlzcyB8fCBoZWFkZXIua2lkO1xuICAgIGxldCBpc093bmVyID0gW0NyZWRlbnRpYWxzLm93bmVyLCBDcmVkZW50aWFscy5hdXRob3IsIGF1dGhvck92ZXJyaWRlXS5pbmNsdWRlcyhvd25lcik7XG4gICAgLy8gSWYgdGhlc2UgYXJlIG5vdCB0aGUgb3duZXIsIGFuZCB3ZSB3ZXJlIG5vdCBnaXZlbiBhIHNwZWNpZmljIG92ZXJyaWRlLCB0aGVuIHNlZSBpZiB0aGUgdXNlciBoYXMgYWNjZXNzIHRvIHRoZSBvd25lciBpbiB0aGlzIGV4ZWN1dGlvbiBjb250ZXh0LlxuICAgIGxldCBjYW5TaWduID0gaXNPd25lciB8fCAoIWF1dGhvck92ZXJyaWRlICYmIGF3YWl0IENyZWRlbnRpYWxzLnNpZ24oJycsIG93bmVyKS5jYXRjaCgoKSA9PiBmYWxzZSkpO1xuICAgIGxldCBtZXJnZWQsIG9wdGlvbnMsIHRpbWUgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IGF1dGhvciA9IGF1dGhvck92ZXJyaWRlIHx8IENyZWRlbnRpYWxzLmF1dGhvcjtcbiAgICBmdW5jdGlvbiBmbGF0dGVuKGEsIGIpIHsgcmV0dXJuIFtdLmNvbmNhdChhLCBiKTsgfVxuICAgIGlmICghY2FuU2lnbikgeyAvLyBXZSBkb24ndCBoYXZlIG93bmVyIGFuZCBjYW5ub3QgZ2V0IGl0LlxuICAgICAgLy8gQ3JlYXRlIGEgc3BlY2lhbCBub24tc3RhbmRhcmQgXCJzaWduYXR1cmVcIiB0aGF0IGlzIHJlYWxseSBhbiBhcnJheSBvZiBzaWduYXR1cmVzXG4gICAgICBmdW5jdGlvbiBnZXRTaWduYXR1cmVzKHZhbGlkYXRpb25zKSB7IHJldHVybiB2YWxpZGF0aW9ucy5tYXAodmFsaWRhdGlvbiA9PiB2YWxpZGF0aW9uLnNpZ25hdHVyZSk7IH1cbiAgICAgIG1lcmdlZCA9IGZsYXR0ZW4oZ2V0U2lnbmF0dXJlcyhwcmV2aW91c1ZhbGlkYXRpb25zKSwgZ2V0U2lnbmF0dXJlcyhuZXh0VmFsaWRhdGlvbnMpKTtcbiAgICAgIG9wdGlvbnMgPSB7dGFnczogW2F1dGhvcl0sIHRpbWV9O1xuICAgIH0gZWxzZSB7XG4gICAgICBmdW5jdGlvbiBnZXRKU09Ocyh2YWxpZGF0aW9ucykgeyByZXR1cm4gdmFsaWRhdGlvbnMubWFwKHZhbGlkYXRpb24gPT4gdmFsaWRhdGlvbi5qc29uKTsgfVxuICAgICAgY29uc3QgZmxhdHRlbmVkID0gZmxhdHRlbihnZXRKU09OcyhwcmV2aW91c1ZhbGlkYXRpb25zKSwgZ2V0SlNPTnMobmV4dFZhbGlkYXRpb25zKSk7XG4gICAgICBtZXJnZWQgPSB0aGlzLmNvbWJpbmVUaW1lc3RhbXBzKG5leHQudGFnLCBrZXlzT2ZNaXNzaW5nLCAuLi5mbGF0dGVuZWQpO1xuICAgICAgb3B0aW9ucyA9IHt0ZWFtOiBvd25lciwgbWVtYmVyOiBhdXRob3IsIHRpbWV9O1xuICAgIH1cbiAgICAvLyBmaXhtZSBuZXh0XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbihtZXJnZWQsIG9wdGlvbnMpO1xuICAgIC8vcmV0dXJuIGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZpZWRTaWduKG1lcmdlZCwgb3B0aW9ucyk7XG4gIH1cbiAgZW5zdXJlRXhwYW5kZWQodmFsaWRhdGlvbikgeyAvLyBQcm9taXNlIGFuIGFycmF5IG9mIHZlcmlmaWNhdGlvbnMgKHZlcmlmeWluZyBlbGVtZW50cyBvZiB2YWxpZGF0aW9uLmpzb24gaWYgbmVlZGVkKS5cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsaWRhdGlvbi5qc29uKSkgcmV0dXJuIFt2YWxpZGF0aW9uXTtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodmFsaWRhdGlvbi5qc29uLm1hcChzaWduYXR1cmUgPT4gdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlKSkpO1xuICB9XG4gIG1pc3NpbmdLZXlzKHByZXZpb3VzTWFwcGluZywgbmV4dE1hcHBpbmdzKSB7IC8vIEFuc3dlciBhIGxpc3Qgb2YgdGhvc2Uga2V5cyBmcm9tIHByZXZpb3VzIHRoYXQgZG8gbm90IGhhdmUgdmFsdWVzIGluIG5leHQuXG4gICAgY29uc3QgbmV4dFZhbHVlcyA9IG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhuZXh0TWFwcGluZ3MpKTtcbiAgICByZXR1cm4gT2JqZWN0LmtleXMocHJldmlvdXNNYXBwaW5nKS5maWx0ZXIoa2V5ID0+IGtleSAhPT0gJ2xhdGVzdCcgJiYgIW5leHRWYWx1ZXMuaGFzKHByZXZpb3VzTWFwcGluZ1trZXldKSk7XG4gIH1cbiAgY29tYmluZVRpbWVzdGFtcHModGFnLCBrZXlzT2ZNaXNzaW5nLCBwcmV2aW91c01hcHBpbmdzLCBuZXh0TWFwcGluZ3MsIC4uLnJlc3QpIHsgLy8gUmV0dXJuIGEgbWVyZ2VkIGRpY3Rpb25hcnkgb2YgdGltZXN0YW1wID0+IGhhc2gsIGNvbnRhaW5pbmcgYWxsIG9mIHByZXZpb3VzIGFuZCBuZXh0TWFwcGluZ3MuXG4gICAgLy8gV2UnbGwgbmVlZCBhIG5ldyBvYmplY3QgdG8gc3RvcmUgdGhlIHVuaW9uLCBiZWNhdXNlIHRoZSBrZXlzIG11c3QgYmUgaW4gdGltZSBvcmRlciwgbm90IHRoZSBvcmRlciB0aGV5IHdlcmUgYWRkZWQuXG4gICAga2V5c09mTWlzc2luZyB8fD0gdGhpcy5taXNzaW5nS2V5cyhwcmV2aW91c01hcHBpbmdzLCBuZXh0TWFwcGluZ3MpO1xuICAgIGNvbnN0IG1lcmdlZCA9IHt9O1xuICAgIGxldCBtaXNzaW5nSW5kZXggPSAwLCBtaXNzaW5nVGltZSwgbmV4dFRpbWVzO1xuICAgIGZvciAoY29uc3QgbmV4dFRpbWUgaW4gbmV4dE1hcHBpbmdzKSB7XG4gICAgICBtaXNzaW5nVGltZSA9IDA7XG5cbiAgICAgIC8vIE1lcmdlIGFueSByZW1haW5pbmcga2V5c09mTWlzc2luZyB0aGF0IGNvbWUgc3RyaWN0bHkgYmVmb3JlIG5leHRUaW1lOlxuICAgICAgaWYgKG5leHRUaW1lICE9PSAnbGF0ZXN0Jykge1xuXHRmb3IgKDsgKG1pc3NpbmdJbmRleCA8IGtleXNPZk1pc3NpbmcubGVuZ3RoKSAmJiAoKG1pc3NpbmdUaW1lID0ga2V5c09mTWlzc2luZ1ttaXNzaW5nSW5kZXhdKSA8IG5leHRUaW1lKTsgbWlzc2luZ0luZGV4KyspIHtcblx0ICBtZXJnZWRbbWlzc2luZ1RpbWVdID0gcHJldmlvdXNNYXBwaW5nc1ttaXNzaW5nVGltZV07XG5cdH1cbiAgICAgIH1cblxuICAgICAgaWYgKG1pc3NpbmdUaW1lID09PSBuZXh0VGltZSkgeyAvLyBUd28gZGlmZmVyZW50IHZhbHVlcyBhdCB0aGUgZXhhY3Qgc2FtZSB0aW1lLiBFeHRyZW1lbHkgcmFyZS5cblx0Y29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBgVW51c3VhbCBtYXRjaGluZyB0aW1lc3RhbXAgY2FzZSBhdCB0aW1lICR7bWlzc2luZ1RpbWV9IGZvciB0YWcgJHt0YWd9LmApO1xuXHRuZXh0VGltZXMgfHw9IE9iamVjdC5rZXlzKG5leHRNYXBwaW5ncyk7IC8vIFdlIGRpZG4ndCBuZWVkIHRoaXMgZm9yIG91ciBsb29wLiBHZW5lcmF0ZSBub3cgaWYgbmVlZGVkLlxuXHRjb25zdCBuZXh0TmV4dFRpbWUgPSBNYXRoLm1pbihrZXlzT2ZNaXNzaW5nW21pc3NpbmdJbmRleCArIDFdIHx8IEluZmluaXR5LFxuXHRcdFx0XHQgICAgICBuZXh0TWFwcGluZ3NbbmV4dFRpbWVzLmluZGV4T2YobmV4dFRpbWUpICsgMV0gfHwgSW5maW5pdHkpO1xuXHRjb25zdCBpbnNlcnRUaW1lID0gbmV4dFRpbWUgKyAobmV4dE5leHRUaW1lIC0gbmV4dFRpbWUpIC8gMjtcblx0Ly8gV2UgYWxyZWFkeSBwdXQgdGhlc2UgaW4gb3JkZXIgd2l0aCBwcmV2aW91c01hcHBpbmdzIGZpcnN0LlxuXHRtZXJnZWRbbmV4dFRpbWVdID0gcHJldmlvdXNNYXBwaW5nc1tuZXh0VGltZV07XG5cdG1lcmdlZFtpbnNlcnRUaW1lXSA9IG5leHRNYXBwaW5nc1tuZXh0VGltZV07XG5cbiAgICAgIH0gZWxzZSB7IC8vIE5vIGNvbmZsaWN0cy4gSnVzdCBhZGQgbmV4dC5cblx0bWVyZ2VkW25leHRUaW1lXSA9IG5leHRNYXBwaW5nc1tuZXh0VGltZV07XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gVGhlcmUgY2FuIGJlIG1pc3Npbmcgc3R1ZmYgdG8gYWRkIGF0IHRoZSBlbmQ7XG4gICAgZm9yICg7IG1pc3NpbmdJbmRleCA8IGtleXNPZk1pc3NpbmcubGVuZ3RoOyBtaXNzaW5nSW5kZXgrKykge1xuICAgICAgbWlzc2luZ1RpbWUgPSBrZXlzT2ZNaXNzaW5nW21pc3NpbmdJbmRleF07XG4gICAgICBtZXJnZWRbbWlzc2luZ1RpbWVdID0gcHJldmlvdXNNYXBwaW5nc1ttaXNzaW5nVGltZV07XG4gICAgfVxuICAgIGxldCBtZXJnZWRUaW1lcyA9IE9iamVjdC5rZXlzKG1lcmdlZCk7XG4gICAgbWVyZ2VkLmxhdGVzdCA9IG1lcmdlZFRpbWVzW21lcmdlZFRpbWVzLmxlbmd0aCAtIDFdO1xuICAgIHJldHVybiByZXN0Lmxlbmd0aCA/IHRoaXMuY29tYmluZVRpbWVzdGFtcHModGFnLCB1bmRlZmluZWQsIG1lcmdlZCwgLi4ucmVzdCkgOiBtZXJnZWQ7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMgPSB7fSkgeyAvLyBBbiBhcnJheSBvZiB1bm1lcmdlZCBzaWduYXR1cmVzIGNhbiBiZSB2ZXJpZmllZC5cbiAgICBpZiAoc2lnbmF0dXJlLnN0YXJ0c1dpdGg/LignWycpKSBzaWduYXR1cmUgPSBKU09OLnBhcnNlKHNpZ25hdHVyZSk7IC8vIChtYXliZUluZmxhdGUgbG9va3MgZm9yICd7Jywgbm90ICdbJy4pXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHNpZ25hdHVyZSkpIHJldHVybiBhd2FpdCBzdXBlci52ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zKTtcbiAgICBjb25zdCBjb21iaW5lZCA9IGF3YWl0IFByb21pc2UuYWxsKHNpZ25hdHVyZS5tYXAoZWxlbWVudCA9PiB0aGlzLnZlcmlmeShlbGVtZW50LCBvcHRpb25zKSkpO1xuICAgIGNvbnN0IG9rID0gY29tYmluZWQuZXZlcnkoZWxlbWVudCA9PiBlbGVtZW50KTtcbiAgICBpZiAoIW9rKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGNvbnN0IHByb3RlY3RlZEhlYWRlciA9IGNvbWJpbmVkWzBdLnByb3RlY3RlZEhlYWRlcjtcbiAgICBmb3IgKGNvbnN0IHByb3BlcnR5IG9mIFsnaXNzJywgJ2tpZCcsICdhbGcnLCAnY3R5J10pIHsgLy8gT3VyIG9wZXJhdGlvbnMgbWFrZSB1c2Ugb2YgaXNzLCBraWQsIGFuZCBpYXQuXG4gICAgICBjb25zdCBtYXRjaGluZyA9IHByb3RlY3RlZEhlYWRlcltwcm9wZXJ0eV07XG4gICAgICBjb25zdCBtYXRjaGVzID0gY29tYmluZWQuZXZlcnkoZWxlbWVudCA9PiBlbGVtZW50LnByb3RlY3RlZEhlYWRlcltwcm9wZXJ0eV0gPT09IG1hdGNoaW5nKTtcbiAgICAgIGlmIChtYXRjaGVzKSBjb250aW51ZTtcbiAgICAgIGlmICghbWF0Y2hlcykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG4gICAgY29uc3Qge2lzcywga2lkLCBhbGcsIGN0eX0gPSBwcm90ZWN0ZWRIZWFkZXI7XG4gICAgY29uc3QgdmVyaWZpZWQgPSB7XG4gICAgICBzaWduYXR1cmUsIC8vIGFycmF5IGF0IHRoaXMgcG9pbnRcbiAgICAgIGpzb246IGNvbWJpbmVkLm1hcChlbGVtZW50ID0+IGVsZW1lbnQuanNvbiksXG4gICAgICBwcm90ZWN0ZWRIZWFkZXI6IHtpc3MsIGtpZCwgYWxnLCBjdHksIGlhdDogTWF0aC5tYXgoLi4uY29tYmluZWQubWFwKGVsZW1lbnQgPT4gZWxlbWVudC5wcm90ZWN0ZWRIZWFkZXIuaWF0KSl9XG4gICAgfTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgYXN5bmMgZGlzYWxsb3dXcml0ZSh0YWcsIGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpIHsgLy8gYmFja2RhdGluZyBpcyBhbGxvd2VkLiAobWVyZ2luZykuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuIG51bGw7XG4gICAgaWYgKCF0aGlzLm93bmVyTWF0Y2goZXhpc3RpbmcsIHByb3Bvc2VkKSkgcmV0dXJuICdub3Qgb3duZXInO1xuICAgIGlmICghYXdhaXQgdGhpcy5zdWJqZWN0TWF0Y2godmVyaWZpZWQpKSByZXR1cm4gJ3dyb25nIGhhc2gnO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIG93bmVyTWF0Y2goZXhpc3RpbmcsIHByb3Bvc2VkKSB7IC8vIFRPRE86IEVpdGhlciB0aGV5IG11c3QgbWF0Y2ggKGFzIGluIHN1cGVyKSBvciB0aGUgbmV3IHBheWxvYWQgbXVzdCBpbmNsdWRlIHRoZSBwcmV2aW91cy5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxufVxuXG5cbi8vIFdoZW4gcnVubmluZyBpbiBOb2RlSlMsIHRoZSBTZWN1cml0eSBvYmplY3QgaXMgYXZhaWxhYmxlIGRpcmVjdGx5LlxuLy8gSXQgaGFzIGEgU3RvcmFnZSBwcm9wZXJ0eSwgd2hpY2ggZGVmaW5lcyBzdG9yZS9yZXRyaWV2ZSAoaW4gbGliL3N0b3JhZ2UubWpzKSB0byBHRVQvUFVUIG9uXG4vLyAuLi4vOmZ1bGxMYWJlbC86cGFydDFvZlRhZy86cGFydDJvZlRhZy86cGFydDNvZlRhZy86cmVzdE9mVGFnLmpzb25cbi8vIFRoZSBTZWN1cml0eS5TdG9yYWdlIGNhbiBiZSBzZXQgYnkgY2xpZW50cyB0byBzb21ldGhpbmcgZWxzZS5cbi8vXG4vLyBXaGVuIHJ1bm5pbmcgaW4gYSBicm93c2VyLCB3b3JrZXIuanMgb3ZlcnJpZGVzIHRoaXMgdG8gc2VuZCBtZXNzYWdlcyB0aHJvdWdoIHRoZSBKU09OIFJQQ1xuLy8gdG8gdGhlIGFwcCwgd2hpY2ggdGhlbiBhbHNvIGhhcyBhbiBvdmVycmlkYWJsZSBTZWN1cml0eS5TdG9yYWdlIHRoYXQgaXMgaW1wbGVtZW50ZWQgd2l0aCB0aGUgc2FtZSBjb2RlIGFzIGFib3ZlLlxuXG4vLyBCYXNoIGluIHNvbWUgbmV3IHN0dWZmOlxuQ3JlZGVudGlhbHMuYXV0aG9yID0gbnVsbDtcbkNyZWRlbnRpYWxzLm93bmVyID0gbnVsbDtcbkNyZWRlbnRpYWxzLmVuY3J5cHRpb24gPSBudWxsOyAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBhdWRpZW5jZVxuQ3JlZGVudGlhbHMuc3luY2hyb25pemUgPSBhc3luYyAoLi4uc2VydmljZXMpID0+IHsgLy8gVE9ETzogcmVuYW1lIHRoaXMgdG8gY29ubmVjdC5cbiAgLy8gV2UgY2FuIGRvIGFsbCB0aHJlZSBpbiBwYXJhbGxlbCAtLSB3aXRob3V0IHdhaXRpbmcgZm9yIGNvbXBsZXRpb24gLS0gYmVjYXVzZSBkZXBlbmRlbmNpZXMgd2lsbCBnZXQgc29ydGVkIG91dCBieSBzeW5jaHJvbml6ZTEuXG4gIHJldHVybiBQcm9taXNlLmFsbChPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKS5tYXAoY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSkpO1xufTtcbkNyZWRlbnRpYWxzLnN5bmNocm9uaXplZCA9IGFzeW5jICgpID0+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uc3luY2hyb25pemVkKSk7XG59XG5DcmVkZW50aWFscy5kaXNjb25uZWN0ID0gYXN5bmMgKC4uLnNlcnZpY2VzKSA9PiB7XG4gIHJldHVybiBQcm9taXNlLmFsbChPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKS5tYXAoY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmRpc2Nvbm5lY3QoLi4uc2VydmljZXMpKSk7XG59XG5cbkNyZWRlbnRpYWxzLmNyZWF0ZUF1dGhvciA9IGFzeW5jIChwcm9tcHQpID0+IHsgLy8gQ3JlYXRlIGEgdXNlcjpcbiAgLy8gSWYgcHJvbXB0IGlzICctJywgY3JlYXRlcyBhbiBpbnZpdGF0aW9uIGFjY291bnQsIHdpdGggYSBuby1vcCByZWNvdmVyeSBhbmQgbm8gZGV2aWNlLlxuICAvLyBPdGhlcndpc2UsIHByb21wdCBpbmRpY2F0ZXMgdGhlIHJlY292ZXJ5IHByb21wdHMsIGFuZCB0aGUgYWNjb3VudCBoYXMgdGhhdCBhbmQgYSBkZXZpY2UuXG4gIGlmIChwcm9tcHQgPT09ICctJykgcmV0dXJuIENyZWRlbnRpYWxzLmNyZWF0ZShhd2FpdCBDcmVkZW50aWFscy5jcmVhdGUoe3Byb21wdH0pKTtcbiAgY29uc3QgW2xvY2FsLCByZWNvdmVyeV0gPSBhd2FpdCBQcm9taXNlLmFsbChbQ3JlZGVudGlhbHMuY3JlYXRlKCksIENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0fSldKTtcbiAgcmV0dXJuIENyZWRlbnRpYWxzLmNyZWF0ZShsb2NhbCwgcmVjb3ZlcnkpO1xufTtcbkNyZWRlbnRpYWxzLmNsYWltSW52aXRhdGlvbiA9IGFzeW5jICh0YWcsIG5ld1Byb21wdCkgPT4geyAvLyBDcmVhdGVzIGEgbG9jYWwgZGV2aWNlIHRhZyBhbmQgYWRkcyBpdCB0byB0aGUgZ2l2ZW4gaW52aXRhdGlvbiB0YWcsXG4gIC8vIHVzaW5nIHRoZSBzZWxmLXZhbGlkYXRpbmcgcmVjb3ZlcnkgbWVtYmVyIHRoYXQgaXMgdGhlbiByZW1vdmVkIGFuZCBkZXN0cm95ZWQuXG4gIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMuVGVhbS5yZXRyaWV2ZSh7dGFnfSk7XG4gIGlmICghdmVyaWZpZWQpIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIHZlcmlmeSBpbnZpdGF0aW9uICR7dGFnfS5gKTtcbiAgY29uc3QgbWVtYmVycyA9IHZlcmlmaWVkLmpzb24ucmVjaXBpZW50cztcbiAgaWYgKG1lbWJlcnMubGVuZ3RoICE9PSAxKSB0aHJvdyBuZXcgRXJyb3IoYEludml0YXRpb25zIHNob3VsZCBoYXZlIG9uZSBtZW1iZXI6ICR7dGFnfWApO1xuICBjb25zdCBvbGRSZWNvdmVyeVRhZyA9IG1lbWJlcnNbMF0uaGVhZGVyLmtpZDtcbiAgY29uc3QgbmV3UmVjb3ZlcnlUYWcgPSBhd2FpdCBDcmVkZW50aWFscy5jcmVhdGUoe3Byb21wdDogbmV3UHJvbXB0fSk7XG4gIGNvbnN0IGRldmljZVRhZyA9IGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSgpO1xuXG4gIC8vIFdlIG5lZWQgdG8gYWRkIHRoZSBuZXcgbWVtYmVycyBpbiBvbmUgY2hhbmdlTWVtYmVyc2hpcCBzdGVwLCBhbmQgdGhlbiByZW1vdmUgdGhlIG9sZFJlY292ZXJ5VGFnIGluIGEgc2Vjb25kIGNhbGwgdG8gY2hhbmdlTWVtYmVyc2hpcDpcbiAgLy8gY2hhbmdlTWVtYmVyc2hpcCB3aWxsIHNpZ24gYnkgYW4gT0xEIG1lbWJlciAtIElmIGl0IHNpZ25lZCBieSBuZXcgbWVtYmVyIHRoYW4gcGVvcGxlIGNvdWxkIGJvb3RzdHJhcCB0aGVtc2VsdmVzIG9udG8gYSB0ZWFtLlxuICAvLyBCdXQgaWYgd2UgcmVtb3ZlIHRoZSBvbGRSZWNvdmVyeSB0YWcgaW4gdGhlIHNhbWUgc3RlcCBhcyBhZGRpbmcgdGhlIG5ldywgdGhlIHRlYW0gd291bGQgYmUgc2lnbmVkIGJ5IHNvbWVvbmUgKHRoZSBvbGRSZWNvdmVyeVRhZykgdGhhdFxuICAvLyBpcyBubyBsb25nZXIgYSBtZW1iZXIsIGFuZCBzbyB0aGUgdGVhbSB3b3VsZCBub3QgdmVyaWZ5IVxuICBhd2FpdCBDcmVkZW50aWFscy5jaGFuZ2VNZW1iZXJzaGlwKHt0YWcsIGFkZDogW2RldmljZVRhZywgbmV3UmVjb3ZlcnlUYWddLCByZW1vdmU6IFtvbGRSZWNvdmVyeVRhZ119KTtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2hhbmdlTWVtYmVyc2hpcCh7dGFnLCByZW1vdmU6IFtvbGRSZWNvdmVyeVRhZ119KTtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuZGVzdHJveShvbGRSZWNvdmVyeVRhZyk7XG4gIHJldHVybiB0YWc7XG59O1xuY29uc3QgYW5zd2VycyA9IHt9OyAvLyBUT0RPOiBtYWtlIHNldEFuc3dlciBpbmNsdWRlIHRhZyBhcyB3ZWxsIGFzIHByb21wdC5cbkNyZWRlbnRpYWxzLnNldEFuc3dlciA9IChwcm9tcHQsIGFuc3dlcikgPT4gYW5zd2Vyc1twcm9tcHRdID0gYW5zd2VyO1xuQ3JlZGVudGlhbHMuZ2V0VXNlckRldmljZVNlY3JldCA9IGZ1bmN0aW9uIGZsZXhzdG9yZVNlY3JldCh0YWcsIHByb21wdFN0cmluZykge1xuICBpZiAoIXByb21wdFN0cmluZykgcmV0dXJuIHRhZztcbiAgaWYgKHByb21wdFN0cmluZyA9PT0gJy0nKSByZXR1cm4gcHJvbXB0U3RyaW5nOyAvLyBTZWUgY3JlYXRlQXV0aG9yLlxuICBpZiAoYW5zd2Vyc1twcm9tcHRTdHJpbmddKSByZXR1cm4gYW5zd2Vyc1twcm9tcHRTdHJpbmddO1xuICAvLyBEaXN0cmlidXRlZCBTZWN1cml0eSB3aWxsIHRyeSBldmVyeXRoaW5nLiBVbmxlc3MgZ29pbmcgdGhyb3VnaCBhIHBhdGggYWJvdmUsIHdlIHdvdWxkIGxpa2Ugb3RoZXJzIHRvIHNpbGVudGx5IGZhaWwuXG4gIGNvbnNvbGUubG9nKGBBdHRlbXB0aW5nIGFjY2VzcyAke3RhZ30gd2l0aCBwcm9tcHQgJyR7cHJvbXB0U3RyaW5nfScuYCk7XG4gIHJldHVybiBcIm5vdCBhIHNlY3JldFwiOyAvLyB0b2RvOiBjcnlwdG8gcmFuZG9tXG59O1xuXG5cbi8vIFRoZXNlIHR3byBhcmUgdXNlZCBkaXJlY3RseSBieSBkaXN0cmlidXRlZC1zZWN1cml0eS5cbkNyZWRlbnRpYWxzLlN0b3JhZ2UucmV0cmlldmUgPSBhc3luYyAoY29sbGVjdGlvbk5hbWUsIHRhZykgPT4ge1xuICBjb25zdCBjb2xsZWN0aW9uID0gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbY29sbGVjdGlvbk5hbWVdO1xuICAvLyBObyBuZWVkIHRvIHZlcmlmeSwgYXMgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgZG9lcyB0aGF0IGl0c2VsZiBxdWl0ZSBjYXJlZnVsbHkgYW5kIHRlYW0tYXdhcmUuXG4gIGlmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ0VuY3J5cHRpb25LZXknKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpO1xuICBpZiAoY29sbGVjdGlvbk5hbWUgPT09ICdLZXlSZWNvdmVyeScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7XG4gIC8vaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnVGVhbScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7ICAgIC8vIFRoaXMgd291bGQgZ28gY2lyY3VsYXIuIFNob3VsZCBpdD8gRG8gd2UgbmVlZCBpdD9cbiAgY29uc3QgZGF0YSA9IGF3YWl0IGNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gIC8vIEhvd2V2ZXIsIHNpbmNlIHdlIGhhdmUgYnlwYXNzZWQgQ29sbGVjdGlvbi5yZXRyaWV2ZSwgd2UgbWF5YmVJbmZsYXRlIGhlcmUuXG4gIHJldHVybiBDb2xsZWN0aW9uLm1heWJlSW5mbGF0ZShkYXRhKTtcbn1cbmNvbnN0IEVNUFRZX1NUUklOR19IQVNIID0gXCI0N0RFUXBqOEhCU2EtX1RJbVctNUpDZXVRZVJrbTVOTXBKV1pHM2hTdUZVXCI7IC8vIEhhc2ggb2YgYW4gZW1wdHkgc3RyaW5nLlxuQ3JlZGVudGlhbHMuU3RvcmFnZS5zdG9yZSA9IGFzeW5jIChjb2xsZWN0aW9uTmFtZSwgdGFnLCBzaWduYXR1cmUpID0+IHtcbiAgLy8gTm8gbmVlZCB0byBlbmNyeXB0L3NpZ24gYXMgYnkgc3RvcmUsIHNpbmNlIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGRvZXMgdGhhdCBpbiBhIGNpcmN1bGFyaXR5LWF3YXJlIHdheS5cbiAgLy8gSG93ZXZlciwgd2UgZG8gY3VycmVudGx5IG5lZWQgdG8gZmluZCBvdXQgb2YgdGhlIHNpZ25hdHVyZSBoYXMgYSBwYXlsb2FkIGFuZCBwdXNoXG4gIC8vIFRPRE86IE1vZGlmeSBkaXN0LXNlYyB0byBoYXZlIGEgc2VwYXJhdGUgc3RvcmUvZGVsZXRlLCByYXRoZXIgdGhhbiBoYXZpbmcgdG8gZmlndXJlIHRoaXMgb3V0IGhlcmUuXG4gIGNvbnN0IGNsYWltcyA9IENyZWRlbnRpYWxzLmRlY29kZUNsYWltcyhzaWduYXR1cmUpO1xuICBjb25zdCBlbXB0eVBheWxvYWQgPSBjbGFpbXM/LnN1YiA9PT0gRU1QVFlfU1RSSU5HX0hBU0g7XG5cbiAgY29uc3QgY29sbGVjdGlvbiA9IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW2NvbGxlY3Rpb25OYW1lXTtcbiAgc2lnbmF0dXJlID0gQ29sbGVjdGlvbi5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgY29uc3Qgc3RvcmVkID0gYXdhaXQgKGVtcHR5UGF5bG9hZCA/IGNvbGxlY3Rpb24uZGVsZXRlKHRhZywgc2lnbmF0dXJlKSA6IGNvbGxlY3Rpb24ucHV0KHRhZywgc2lnbmF0dXJlKSk7XG4gIGlmIChzdG9yZWQgIT09IHRhZykgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gd3JpdGUgY3JlZGVudGlhbCAke3RhZ30uYCk7XG4gIGlmICh0YWcpIGF3YWl0IGNvbGxlY3Rpb24ucHVzaChlbXB0eVBheWxvYWQgPyAnZGVsZXRlJzogJ3B1dCcsIHRhZywgc2lnbmF0dXJlKTtcbiAgcmV0dXJuIHRhZztcbn07XG5DcmVkZW50aWFscy5TdG9yYWdlLmRlc3Ryb3kgPSBhc3luYyAoKSA9PiB7XG4gIGF3YWl0IENyZWRlbnRpYWxzLmNsZWFyKCk7IC8vIFdpcGUgZnJvbSBsaXZlIG1lbW9yeS5cbiAgYXdhaXQgUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGFzeW5jIGNvbGxlY3Rpb24gPT4ge1xuICAgIGF3YWl0IGNvbGxlY3Rpb24uZGlzY29ubmVjdCgpO1xuICAgIGNvbnN0IHN0b3JlID0gYXdhaXQgY29sbGVjdGlvbi5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIHN0b3JlLmRlc3Ryb3koKTsgLy8gRGVzdHJveSB0aGUgcGVyc2lzdGVudCBjYWNoZS5cbiAgfSkpO1xuICBhd2FpdCBDcmVkZW50aWFscy53aXBlRGV2aWNlS2V5cygpOyAvLyBOb3QgaW5jbHVkZWQgaW4gdGhlIGFib3ZlLlxufTtcbkNyZWRlbnRpYWxzLmNvbGxlY3Rpb25zID0ge307XG5leHBvcnQgeyBDcmVkZW50aWFscyB9O1xuWydFbmNyeXB0aW9uS2V5JywgJ0tleVJlY292ZXJ5JywgJ1RlYW0nXS5mb3JFYWNoKG5hbWUgPT4gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbbmFtZV0gPSBuZXcgTXV0YWJsZUNvbGxlY3Rpb24oe25hbWV9KSk7XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgU3luY2hyb25pemVyIGZyb20gJy4vbGliL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIFZlcnNpb25lZENvbGxlY3Rpb24sIFZlcnNpb25Db2xsZWN0aW9uIH0gZnJvbSAgJy4vbGliL2NvbGxlY3Rpb25zLm1qcyc7XG5pbXBvcnQgeyBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vbGliL3dlYnJ0Yy5tanMnO1xuaW1wb3J0IHsgdmVyc2lvbiwgbmFtZSwgc3RvcmFnZVZlcnNpb24sIHN0b3JhZ2VOYW1lIH0gZnJvbSAnLi9saWIvdmVyc2lvbi5tanMnO1xuXG5jb25zb2xlLmxvZyhgJHtuYW1lfSAke3ZlcnNpb259IGZyb20gJHtpbXBvcnQubWV0YS51cmx9LmApO1xuXG5leHBvcnQgeyBDcmVkZW50aWFscywgQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIFZlcnNpb25lZENvbGxlY3Rpb24sIFZlcnNpb25Db2xsZWN0aW9uLCBTeW5jaHJvbml6ZXIsIFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDLCBuYW1lLCB2ZXJzaW9uLCBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24gfTtcbmV4cG9ydCBkZWZhdWx0IHsgQ3JlZGVudGlhbHMsIENvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIE11dGFibGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBWZXJzaW9uQ29sbGVjdGlvbiwgU3luY2hyb25pemVyLCBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQywgbmFtZSwgdmVyc2lvbiwgIHN0b3JhZ2VOYW1lLCBzdG9yYWdlVmVyc2lvbiB9O1xuIl0sIm5hbWVzIjpbInBrZy5kZWZhdWx0IiwiU3RvcmFnZUxv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LENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsVUFBVSxFQUFFLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDLElBQUksTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEdBQUUsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBQyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxTQUFTLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLE1BQU0sWUFBWSxTQUFTLFdBQVcsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksTUFBTSxDQUFDLENBQUMsRUFBRSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBQyxDQUFDLE1BQU0sWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENB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
