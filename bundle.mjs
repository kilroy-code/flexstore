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
    console.log('WebRTC#close', this.label, 'connection:', this.peer.connectionState, 'signaling:', this.peer.signalingState);
    if ((this.peer.connectionState === 'new') && (this.peer.signalingState === 'stable')) return;
    this.resetPeer();
  }
  connectionStateChange(state) {
    this.log('state change:', state);
    console.log('WebRTC#connectionStateChange', this.label, state);
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
    channel.addEventListener('closing', event => console.log('closing event', key, channel.readState));
    channel.addEventListener('close', event => { // Close whole connection when no more data channels or streams.
      this.dataChannels.delete(key);
      console.log('PromiseWebRTC DataChannel onclose', key, channel.readyState, this.dataChannels.size, this.peer.getSenders().length);
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
	console.log('PromiseWebRTC#createDataChannel', label, channel.readyState);
	channel.onopen = _ => {
	  resolve(channel);
	};
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
      console.log('PromiseWebRTC#close explicitly closing channel', channel.label, channel.readyState);
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
    console.log('SharedWebRTC#ensureDataChannel', this.label, {channelName, hasStartedConnecting, id, negotiated, options, useSignals});
    if (hasStartedConnecting) {
      await this.connected; // Before creating promise.
    } else if (useSignals) {
      this.signals = signals;
    }
    await new Promise(resolve => setTimeout(resolve, 10)); // Should not be necessary. I'm trying to make Safari more reliable.
    const promise = allowOtherSideToCreate ?
	  this.getDataChannelPromise(channelName) :
	  this.createDataChannel(channelName, options);
    return await promise;
  }
}

var name$1 = "@kilroy-code/flexstore";
var version$1 = "0.0.42-debug.5";
var _package = {
	name: name$1,
	version: version$1};

// name/version of "database"
const storageName = 'flexstore';
const storageVersion = 6;
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
  constructor({serviceName = 'direct', collection, error = collection?.constructor.error,
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
	  .catch(error => this.error(error));
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
    const theirSignals = await this.fetch(url, await ourSignals);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vQGtpMXIweS9zdG9yYWdlL2J1bmRsZS5tanMiLCJsaWIvY29sbGVjdGlvbnMubWpzIiwiaW5kZXgubWpzIl0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHV1aWRQYXR0ZXJuID0gL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pO1xuZnVuY3Rpb24gdmFsaWQodXVpZCkge1xuICByZXR1cm4gdXVpZFBhdHRlcm4udGVzdCh1dWlkKTtcbn1cblxuLy8gQmFzZWQgb24gaHR0cHM6Ly9hYmhpc2hla2R1dHRhLm9yZy9ibG9nL3N0YW5kYWxvbmVfdXVpZF9nZW5lcmF0b3JfaW5famF2YXNjcmlwdC5odG1sXG4vLyBJRTExIGFuZCBNb2Rlcm4gQnJvd3NlcnMgT25seVxuZnVuY3Rpb24gdXVpZDQoKSB7XG4gIHZhciB0ZW1wX3VybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwobmV3IEJsb2IoKSk7XG4gIHZhciB1dWlkID0gdGVtcF91cmwudG9TdHJpbmcoKTtcbiAgVVJMLnJldm9rZU9iamVjdFVSTCh0ZW1wX3VybCk7XG4gIHJldHVybiB1dWlkLnNwbGl0KC9bOlxcL10vZykucG9wKCkudG9Mb3dlckNhc2UoKTsgLy8gcmVtb3ZlIHByZWZpeGVzXG59XG51dWlkNC52YWxpZCA9IHZhbGlkO1xuXG5leHBvcnQgZGVmYXVsdCB1dWlkNDtcbmV4cG9ydCB7IHV1aWQ0LCB2YWxpZCB9O1xuIiwiLy8gSW4gYSBicm93c2VyLCB3cnRjIHByb3BlcnRpZXMgc3VjaCBhcyBSVENQZWVyQ29ubmVjdGlvbiBhcmUgaW4gZ2xvYmFsVGhpcy5cbmV4cG9ydCBkZWZhdWx0IGdsb2JhbFRoaXM7XG4iLCJpbXBvcnQgdXVpZDQgZnJvbSAndXVpZDQnO1xuXG4vLyBTZWUgcm9sbHVwLmNvbmZpZy5tanNcbmltcG9ydCB3cnRjIGZyb20gJyN3cnRjJztcbi8vY29uc3Qge2RlZmF1bHQ6d3J0Y30gPSBhd2FpdCAoKHR5cGVvZihwcm9jZXNzKSAhPT0gJ3VuZGVmaW5lZCcpID8gaW1wb3J0KCdAcm9hbWhxL3dydGMnKSA6IHtkZWZhdWx0OiBnbG9iYWxUaGlzfSk7XG5cbmNvbnN0IGljZVNlcnZlcnMgPSBbXG4gIHsgdXJsczogJ3N0dW46c3R1bi5sLmdvb2dsZS5jb206MTkzMDInfSxcbiAgLy8gaHR0cHM6Ly9mcmVlc3R1bi5uZXQvICBDdXJyZW50bHkgNTAgS0JpdC9zLiAoMi41IE1CaXQvcyBmb3JzICQ5L21vbnRoKVxuICB7IHVybHM6ICdzdHVuOmZyZWVzdHVuLm5ldDozNDc4JyB9LFxuICAvL3sgdXJsczogJ3R1cm46ZnJlZXN0dW4ubmV0OjM0NzgnLCB1c2VybmFtZTogJ2ZyZWUnLCBjcmVkZW50aWFsOiAnZnJlZScgfSxcbiAgLy8gUHJlc3VtYWJseSB0cmFmZmljIGxpbWl0ZWQuIENhbiBnZW5lcmF0ZSBuZXcgY3JlZGVudGlhbHMgYXQgaHR0cHM6Ly9zcGVlZC5jbG91ZGZsYXJlLmNvbS90dXJuLWNyZWRzXG4gIC8vIEFsc28gaHR0cHM6Ly9kZXZlbG9wZXJzLmNsb3VkZmxhcmUuY29tL2NhbGxzLyAxIFRCL21vbnRoLCBhbmQgJDAuMDUgL0dCIGFmdGVyIHRoYXQuXG4gIHsgdXJsczogJ3R1cm46dHVybi5zcGVlZC5jbG91ZGZsYXJlLmNvbTo1MDAwMCcsIHVzZXJuYW1lOiAnODI2MjI2MjQ0Y2Q2ZTVlZGIzZjU1NzQ5Yjc5NjIzNWY0MjBmZTVlZTc4ODk1ZTBkZDdkMmJhYTQ1ZTFmN2E4ZjQ5ZTkyMzllNzg2OTFhYjM4YjcyY2UwMTY0NzFmNzc0NmY1Mjc3ZGNlZjg0YWQ3OWZjNjBmODAyMGIxMzJjNzMnLCBjcmVkZW50aWFsOiAnYWJhOWIxNjk1NDZlYjZkY2M3YmZiMWNkZjM0NTQ0Y2Y5NWI1MTYxZDYwMmUzYjVmYTdjODM0MmIyZTk4MDJmYicgfVxuICAvLyBodHRwczovL2Zhc3R0dXJuLm5ldC8gQ3VycmVudGx5IDUwME1CL21vbnRoPyAoMjUgR0IvbW9udGggZm9yICQ5L21vbnRoKVxuICAvLyBodHRwczovL3hpcnN5cy5jb20vcHJpY2luZy8gNTAwIE1CL21vbnRoICg1MCBHQi9tb250aCBmb3IgJDMzL21vbnRoKVxuICAvLyBBbHNvIGh0dHBzOi8vd3d3Lm5wbWpzLmNvbS9wYWNrYWdlL25vZGUtdHVybiBvciBodHRwczovL21lZXRyaXguaW8vYmxvZy93ZWJydGMvY290dXJuL2luc3RhbGxhdGlvbi5odG1sXG5dO1xuXG4vLyBVdGlsaXR5IHdyYXBwZXIgYXJvdW5kIFJUQ1BlZXJDb25uZWN0aW9uLlxuLy8gV2hlbiBzb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gKHN1Y2ggYXMgY3JlYXRlRGF0YUNoYW5uZWwpLCBpdCB3aWxsIGdlbmVyYXRlIGNhbGxzIHRvIHNpZ25hbCgpLCB3aGljaCBuZWVkcyB0byBiZSBkZWZpbmVkIGJ5IHN1YmNsYXNzZXMuXG5leHBvcnQgY2xhc3MgV2ViUlRDIHtcbiAgY29uc3RydWN0b3Ioe2xhYmVsID0gJycsIGNvbmZpZ3VyYXRpb24gPSBudWxsLCB1dWlkID0gdXVpZDQoKSwgZGVidWcgPSBmYWxzZSwgZXJyb3IgPSBjb25zb2xlLmVycm9yLCAuLi5yZXN0fSA9IHt9KSB7XG4gICAgY29uZmlndXJhdGlvbiA/Pz0ge2ljZVNlcnZlcnN9OyAvLyBJZiBjb25maWd1cmF0aW9uIGNhbiBiZSBvbW1pdHRlZCBvciBleHBsaWNpdGx5IGFzIG51bGwsIHVzZSBvdXIgZGVmYXVsdC4gQnV0IGlmIHt9LCBsZWF2ZSBpdCBiZS5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtsYWJlbCwgY29uZmlndXJhdGlvbiwgdXVpZCwgZGVidWcsIGVycm9yLCAuLi5yZXN0fSk7XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBzaWduYWwodHlwZSwgbWVzc2FnZSkgeyAvLyBTdWJjbGFzc2VzIG11c3Qgb3ZlcnJpZGUgb3IgZXh0ZW5kLiBEZWZhdWx0IGp1c3QgbG9ncy5cbiAgICB0aGlzLmxvZygnc2VuZGluZycsIHR5cGUsIHR5cGUubGVuZ3RoLCBKU09OLnN0cmluZ2lmeShtZXNzYWdlKS5sZW5ndGgpO1xuICB9XG5cbiAgcGVlclZlcnNpb24gPSAwO1xuICByZXNldFBlZXIoKSB7IC8vIFNldCB1cCBhIG5ldyBSVENQZWVyQ29ubmVjdGlvbi4gKENhbGxlciBtdXN0IGNsb3NlIG9sZCBpZiBuZWNlc3NhcnkuKVxuICAgIGNvbnN0IG9sZCA9IHRoaXMucGVlcjtcbiAgICBpZiAob2xkKSB7XG4gICAgICBvbGQub25uZWdvdGlhdGlvbm5lZWRlZCA9IG9sZC5vbmljZWNhbmRpZGF0ZSA9IG9sZC5vbmljZWNhbmRpZGF0ZWVycm9yID0gb2xkLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gbnVsbDtcbiAgICAgIC8vIERvbid0IGNsb3NlIHVubGVzcyBpdCdzIGJlZW4gb3BlbmVkLCBiZWNhdXNlIHRoZXJlIGFyZSBsaWtlbHkgaGFuZGxlcnMgdGhhdCB3ZSBkb24ndCB3YW50IHRvIGZpcmUuXG4gICAgICBpZiAob2xkLmNvbm5lY3Rpb25TdGF0ZSAhPT0gJ25ldycpIG9sZC5jbG9zZSgpO1xuICAgIH1cbiAgICBjb25zdCBwZWVyID0gdGhpcy5wZWVyID0gbmV3IHdydGMuUlRDUGVlckNvbm5lY3Rpb24odGhpcy5jb25maWd1cmF0aW9uKTtcbiAgICBwZWVyLnZlcnNpb25JZCA9IHRoaXMucGVlclZlcnNpb24rKztcbiAgICBwZWVyLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBldmVudCA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkKGV2ZW50KTtcbiAgICBwZWVyLm9uaWNlY2FuZGlkYXRlID0gZXZlbnQgPT4gdGhpcy5vbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KTtcbiAgICAvLyBJIGRvbid0IHRoaW5rIGFueW9uZSBhY3R1YWxseSBzaWduYWxzIHRoaXMuIEluc3RlYWQsIHRoZXkgcmVqZWN0IGZyb20gYWRkSWNlQ2FuZGlkYXRlLCB3aGljaCB3ZSBoYW5kbGUgdGhlIHNhbWUuXG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZWVycm9yID0gZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcik7XG4gICAgLy8gSSB0aGluayB0aGlzIGlzIHJlZHVuZG5hbnQgYmVjYXVzZSBubyBpbXBsZW1lbnRhdGlvbiBmaXJlcyB0aGlzIGV2ZW50IGFueSBzaWduaWZpY2FudCB0aW1lIGFoZWFkIG9mIGVtaXR0aW5nIGljZWNhbmRpZGF0ZSB3aXRoIGFuIGVtcHR5IGV2ZW50LmNhbmRpZGF0ZS5cbiAgICBwZWVyLm9uaWNlZ2F0aGVyaW5nc3RhdGVjaGFuZ2UgPSBldmVudCA9PiAocGVlci5pY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJykgJiYgdGhpcy5vbkxvY2FsRW5kSWNlO1xuICAgIHBlZXIub25jb25uZWN0aW9uc3RhdGVjaGFuZ2UgPSBldmVudCA9PiB0aGlzLmNvbm5lY3Rpb25TdGF0ZUNoYW5nZSh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlKTtcbiAgfVxuICBvbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KSB7XG4gICAgLy8gVGhlIHNwZWMgc2F5cyB0aGF0IGEgbnVsbCBjYW5kaWRhdGUgc2hvdWxkIG5vdCBiZSBzZW50LCBidXQgdGhhdCBhbiBlbXB0eSBzdHJpbmcgY2FuZGlkYXRlIHNob3VsZC4gU2FmYXJpICh1c2VkIHRvPykgZ2V0IGVycm9ycyBlaXRoZXIgd2F5LlxuICAgIGlmICghZXZlbnQuY2FuZGlkYXRlIHx8ICFldmVudC5jYW5kaWRhdGUuY2FuZGlkYXRlKSB0aGlzLm9uTG9jYWxFbmRJY2UoKTtcbiAgICBlbHNlIHRoaXMuc2lnbmFsKCdpY2VjYW5kaWRhdGUnLCBldmVudC5jYW5kaWRhdGUpO1xuICB9XG4gIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFRyaWdnZXJlZCBvbiBvdXIgc2lkZSBieSBhbnkvYWxsIG9mIG9uaWNlY2FuZGlkYXRlIHdpdGggbm8gZXZlbnQuY2FuZGlkYXRlLCBpY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJy5cbiAgICAvLyBJLmUuLCBjYW4gaGFwcGVuIG11bHRpcGxlIHRpbWVzLiBTdWJjbGFzc2VzIG1pZ2h0IGRvIHNvbWV0aGluZy5cbiAgfVxuICBjbG9zZSgpIHtcbiAgICBjb25zb2xlLmxvZygnV2ViUlRDI2Nsb3NlJywgdGhpcy5sYWJlbCwgJ2Nvbm5lY3Rpb246JywgdGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSwgJ3NpZ25hbGluZzonLCB0aGlzLnBlZXIuc2lnbmFsaW5nU3RhdGUpO1xuICAgIGlmICgodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ25ldycpICYmICh0aGlzLnBlZXIuc2lnbmFsaW5nU3RhdGUgPT09ICdzdGFibGUnKSkgcmV0dXJuO1xuICAgIHRoaXMucmVzZXRQZWVyKCk7XG4gIH1cbiAgY29ubmVjdGlvblN0YXRlQ2hhbmdlKHN0YXRlKSB7XG4gICAgdGhpcy5sb2coJ3N0YXRlIGNoYW5nZTonLCBzdGF0ZSk7XG4gICAgY29uc29sZS5sb2coJ1dlYlJUQyNjb25uZWN0aW9uU3RhdGVDaGFuZ2UnLCB0aGlzLmxhYmVsLCBzdGF0ZSk7XG4gICAgaWYgKFsnZGlzY29ubmVjdGVkJywgJ2ZhaWxlZCcsICdjbG9zZWQnXS5pbmNsdWRlcyhzdGF0ZSkpIHRoaXMuY2xvc2UoKTsgLy8gT3RoZXIgYmVoYXZpb3IgYXJlIHJlYXNvbmFibGUsIHRvbG8uXG4gIH1cbiAgbmVnb3RpYXRpb25uZWVkZWQoKSB7IC8vIFNvbWV0aGluZyBoYXMgY2hhbmdlZCBsb2NhbGx5IChuZXcgc3RyZWFtLCBvciBuZXR3b3JrIGNoYW5nZSksIHN1Y2ggdGhhdCB3ZSBoYXZlIHRvIHN0YXJ0IG5lZ290aWF0aW9uLlxuICAgIHRoaXMubG9nKCduZWdvdGlhdGlvbm5uZWVkZWQnKTtcbiAgICB0aGlzLnBlZXIuY3JlYXRlT2ZmZXIoKVxuICAgICAgLnRoZW4ob2ZmZXIgPT4ge1xuICAgICAgICB0aGlzLnBlZXIuc2V0TG9jYWxEZXNjcmlwdGlvbihvZmZlcik7IC8vIHByb21pc2UgZG9lcyBub3QgcmVzb2x2ZSB0byBvZmZlclxuXHRyZXR1cm4gb2ZmZXI7XG4gICAgICB9KVxuICAgICAgLnRoZW4ob2ZmZXIgPT4gdGhpcy5zaWduYWwoJ29mZmVyJywgb2ZmZXIpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHRoaXMubmVnb3RpYXRpb25uZWVkZWRFcnJvcihlcnJvcikpO1xuICB9XG4gIG9mZmVyKG9mZmVyKSB7IC8vIEhhbmRsZXIgZm9yIHJlY2VpdmluZyBhbiBvZmZlciBmcm9tIHRoZSBvdGhlciB1c2VyICh3aG8gc3RhcnRlZCB0aGUgc2lnbmFsaW5nIHByb2Nlc3MpLlxuICAgIC8vIE5vdGUgdGhhdCBkdXJpbmcgc2lnbmFsaW5nLCB3ZSB3aWxsIHJlY2VpdmUgbmVnb3RpYXRpb25uZWVkZWQvYW5zd2VyLCBvciBvZmZlciwgYnV0IG5vdCBib3RoLCBkZXBlbmRpbmdcbiAgICAvLyBvbiB3aGV0aGVyIHdlIHdlcmUgdGhlIG9uZSB0aGF0IHN0YXJ0ZWQgdGhlIHNpZ25hbGluZyBwcm9jZXNzLlxuICAgIHRoaXMucGVlci5zZXRSZW1vdGVEZXNjcmlwdGlvbihvZmZlcilcbiAgICAgIC50aGVuKF8gPT4gdGhpcy5wZWVyLmNyZWF0ZUFuc3dlcigpKVxuICAgICAgLnRoZW4oYW5zd2VyID0+IHRoaXMucGVlci5zZXRMb2NhbERlc2NyaXB0aW9uKGFuc3dlcikpIC8vIHByb21pc2UgZG9lcyBub3QgcmVzb2x2ZSB0byBhbnN3ZXJcbiAgICAgIC50aGVuKF8gPT4gdGhpcy5zaWduYWwoJ2Fuc3dlcicsIHRoaXMucGVlci5sb2NhbERlc2NyaXB0aW9uKSk7XG4gIH1cbiAgYW5zd2VyKGFuc3dlcikgeyAvLyBIYW5kbGVyIGZvciBmaW5pc2hpbmcgdGhlIHNpZ25hbGluZyBwcm9jZXNzIHRoYXQgd2Ugc3RhcnRlZC5cbiAgICB0aGlzLnBlZXIuc2V0UmVtb3RlRGVzY3JpcHRpb24oYW5zd2VyKTtcbiAgfVxuICBpY2VjYW5kaWRhdGUoaWNlQ2FuZGlkYXRlKSB7IC8vIEhhbmRsZXIgZm9yIGEgbmV3IGNhbmRpZGF0ZSByZWNlaXZlZCBmcm9tIHRoZSBvdGhlciBlbmQgdGhyb3VnaCBzaWduYWxpbmcuXG4gICAgdGhpcy5wZWVyLmFkZEljZUNhbmRpZGF0ZShpY2VDYW5kaWRhdGUpLmNhdGNoKGVycm9yID0+IHRoaXMuaWNlY2FuZGlkYXRlRXJyb3IoZXJyb3IpKTtcbiAgfVxuICBsb2coLi4ucmVzdCkge1xuICAgIGlmICh0aGlzLmRlYnVnKSBjb25zb2xlLmxvZyh0aGlzLmxhYmVsLCB0aGlzLnBlZXIudmVyc2lvbklkLCAuLi5yZXN0KTtcbiAgfVxuICBsb2dFcnJvcihsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbikge1xuICAgIGNvbnN0IGRhdGEgPSBbdGhpcy5sYWJlbCwgdGhpcy5wZWVyLnZlcnNpb25JZCwgLi4udGhpcy5jb25zdHJ1Y3Rvci5nYXRoZXJFcnJvckRhdGEobGFiZWwsIGV2ZW50T3JFeGNlcHRpb24pXTtcbiAgICB0aGlzLmVycm9yKGRhdGEpO1xuICAgIHJldHVybiBkYXRhO1xuICB9XG4gIHN0YXRpYyBlcnJvcihlcnJvcikge1xuICB9XG4gIHN0YXRpYyBnYXRoZXJFcnJvckRhdGEobGFiZWwsIGV2ZW50T3JFeGNlcHRpb24pIHtcbiAgICByZXR1cm4gW1xuICAgICAgbGFiZWwgKyBcIiBlcnJvcjpcIixcbiAgICAgIGV2ZW50T3JFeGNlcHRpb24uY29kZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yQ29kZSB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1cyB8fCBcIlwiLCAvLyBGaXJzdCBpcyBkZXByZWNhdGVkLCBidXQgc3RpbGwgdXNlZnVsLlxuICAgICAgZXZlbnRPckV4Y2VwdGlvbi51cmwgfHwgZXZlbnRPckV4Y2VwdGlvbi5uYW1lIHx8ICcnLFxuICAgICAgZXZlbnRPckV4Y2VwdGlvbi5tZXNzYWdlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JUZXh0IHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzVGV4dCB8fCBldmVudE9yRXhjZXB0aW9uXG4gICAgXTtcbiAgfVxuICBpY2VjYW5kaWRhdGVFcnJvcihldmVudE9yRXhjZXB0aW9uKSB7IC8vIEZvciBlcnJvcnMgb24gdGhpcyBwZWVyIGR1cmluZyBnYXRoZXJpbmcuXG4gICAgLy8gQ2FuIGJlIG92ZXJyaWRkZW4gb3IgZXh0ZW5kZWQgYnkgYXBwbGljYXRpb25zLlxuXG4gICAgLy8gU1RVTiBlcnJvcnMgYXJlIGluIHRoZSByYW5nZSAzMDAtNjk5LiBTZWUgUkZDIDUzODksIHNlY3Rpb24gMTUuNlxuICAgIC8vIGZvciBhIGxpc3Qgb2YgY29kZXMuIFRVUk4gYWRkcyBhIGZldyBtb3JlIGVycm9yIGNvZGVzOyBzZWVcbiAgICAvLyBSRkMgNTc2Niwgc2VjdGlvbiAxNSBmb3IgZGV0YWlscy5cbiAgICAvLyBTZXJ2ZXIgY291bGQgbm90IGJlIHJlYWNoZWQgYXJlIGluIHRoZSByYW5nZSA3MDAtNzk5LlxuICAgIGNvbnN0IGNvZGUgPSBldmVudE9yRXhjZXB0aW9uLmNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvckNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXM7XG4gICAgLy8gQ2hyb21lIGdpdmVzIDcwMSBlcnJvcnMgZm9yIHNvbWUgdHVybiBzZXJ2ZXJzIHRoYXQgaXQgZG9lcyBub3QgZ2l2ZSBmb3Igb3RoZXIgdHVybiBzZXJ2ZXJzLlxuICAgIC8vIFRoaXMgaXNuJ3QgZ29vZCwgYnV0IGl0J3Mgd2F5IHRvbyBub2lzeSB0byBzbG9nIHRocm91Z2ggc3VjaCBlcnJvcnMsIGFuZCBJIGRvbid0IGtub3cgaG93IHRvIGZpeCBvdXIgdHVybiBjb25maWd1cmF0aW9uLlxuICAgIGlmIChjb2RlID09PSA3MDEpIHJldHVybjtcbiAgICB0aGlzLmxvZ0Vycm9yKCdpY2UnLCBldmVudE9yRXhjZXB0aW9uKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgUHJvbWlzZVdlYlJUQyBleHRlbmRzIFdlYlJUQyB7XG4gIC8vIEV4dGVuZHMgV2ViUlRDLnNpZ25hbCgpIHN1Y2ggdGhhdDpcbiAgLy8gLSBpbnN0YW5jZS5zaWduYWxzIGFuc3dlcnMgYSBwcm9taXNlIHRoYXQgd2lsbCByZXNvbHZlIHdpdGggYW4gYXJyYXkgb2Ygc2lnbmFsIG1lc3NhZ2VzLlxuICAvLyAtIGluc3RhbmNlLnNpZ25hbHMgPSBbLi4uc2lnbmFsTWVzc2FnZXNdIHdpbGwgZGlzcGF0Y2ggdGhvc2UgbWVzc2FnZXMuXG4gIC8vXG4gIC8vIEZvciBleGFtcGxlLCBzdXBwb3NlIHBlZXIxIGFuZCBwZWVyMiBhcmUgaW5zdGFuY2VzIG9mIHRoaXMuXG4gIC8vIDAuIFNvbWV0aGluZyB0cmlnZ2VycyBuZWdvdGlhdGlvbiBvbiBwZWVyMSAoc3VjaCBhcyBjYWxsaW5nIHBlZXIxLmNyZWF0ZURhdGFDaGFubmVsKCkpLiBcbiAgLy8gMS4gcGVlcjEuc2lnbmFscyByZXNvbHZlcyB3aXRoIDxzaWduYWwxPiwgYSBQT0pPIHRvIGJlIGNvbnZleWVkIHRvIHBlZXIyLlxuICAvLyAyLiBTZXQgcGVlcjIuc2lnbmFscyA9IDxzaWduYWwxPi5cbiAgLy8gMy4gcGVlcjIuc2lnbmFscyByZXNvbHZlcyB3aXRoIDxzaWduYWwyPiwgYSBQT0pPIHRvIGJlIGNvbnZleWVkIHRvIHBlZXIxLlxuICAvLyA0LiBTZXQgcGVlcjEuc2lnbmFscyA9IDxzaWduYWwyPi5cbiAgLy8gNS4gRGF0YSBmbG93cywgYnV0IGVhY2ggc2lkZSB3aG91bGQgZ3JhYiBhIG5ldyBzaWduYWxzIHByb21pc2UgYW5kIGJlIHByZXBhcmVkIHRvIGFjdCBpZiBpdCByZXNvbHZlcy5cbiAgLy9cbiAgY29uc3RydWN0b3Ioe2ljZVRpbWVvdXQgPSAyZTMsIC4uLnByb3BlcnRpZXN9KSB7XG4gICAgc3VwZXIocHJvcGVydGllcyk7XG4gICAgdGhpcy5pY2VUaW1lb3V0ID0gaWNlVGltZW91dDtcbiAgfVxuICBnZXQgc2lnbmFscygpIHsgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlIHRvIHRoZSBzaWduYWwgbWVzc2FnaW5nIHdoZW4gaWNlIGNhbmRpZGF0ZSBnYXRoZXJpbmcgaXMgY29tcGxldGUuXG4gICAgcmV0dXJuIHRoaXMuX3NpZ25hbFByb21pc2UgfHw9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHRoaXMuX3NpZ25hbFJlYWR5ID0ge3Jlc29sdmUsIHJlamVjdH0pO1xuICB9XG4gIHNldCBzaWduYWxzKGRhdGEpIHsgLy8gU2V0IHdpdGggdGhlIHNpZ25hbHMgcmVjZWl2ZWQgZnJvbSB0aGUgb3RoZXIgZW5kLlxuICAgIGRhdGEuZm9yRWFjaCgoW3R5cGUsIG1lc3NhZ2VdKSA9PiB0aGlzW3R5cGVdKG1lc3NhZ2UpKTtcbiAgfVxuICBvbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KSB7XG4gICAgLy8gRWFjaCB3cnRjIGltcGxlbWVudGF0aW9uIGhhcyBpdHMgb3duIGlkZWFzIGFzIHRvIHdoYXQgaWNlIGNhbmRpZGF0ZXMgdG8gdHJ5IGJlZm9yZSBlbWl0dGluZyB0aGVtIGluIGljZWNhbmRkaWF0ZS5cbiAgICAvLyBNb3N0IHdpbGwgdHJ5IHRoaW5ncyB0aGF0IGNhbm5vdCBiZSByZWFjaGVkLCBhbmQgZ2l2ZSB1cCB3aGVuIHRoZXkgaGl0IHRoZSBPUyBuZXR3b3JrIHRpbWVvdXQuIEZvcnR5IHNlY29uZHMgaXMgYSBsb25nIHRpbWUgdG8gd2FpdC5cbiAgICAvLyBJZiB0aGUgd3J0YyBpcyBzdGlsbCB3YWl0aW5nIGFmdGVyIG91ciBpY2VUaW1lb3V0ICgyIHNlY29uZHMpLCBsZXRzIGp1c3QgZ28gd2l0aCB3aGF0IHdlIGhhdmUuXG4gICAgdGhpcy50aW1lciB8fD0gc2V0VGltZW91dCgoKSA9PiB0aGlzLm9uTG9jYWxFbmRJY2UoKSwgdGhpcy5pY2VUaW1lb3V0KTtcbiAgICBzdXBlci5vbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KTtcbiAgfVxuICBjbGVhckljZVRpbWVyKCkge1xuICAgIGNsZWFyVGltZW91dCh0aGlzLnRpbWVyKTtcbiAgICB0aGlzLnRpbWVyID0gbnVsbDtcbiAgfVxuICBhc3luYyBvbkxvY2FsRW5kSWNlKCkgeyAvLyBSZXNvbHZlIHRoZSBwcm9taXNlIHdpdGggd2hhdCB3ZSd2ZSBiZWVuIGdhdGhlcmluZy5cbiAgICB0aGlzLmNsZWFySWNlVGltZXIoKTtcbiAgICBpZiAoIXRoaXMuX3NpZ25hbFByb21pc2UpIHtcbiAgICAgIC8vdGhpcy5sb2dFcnJvcignaWNlJywgXCJFbmQgb2YgSUNFIHdpdGhvdXQgYW55dGhpbmcgd2FpdGluZyBvbiBzaWduYWxzLlwiKTsgLy8gTm90IGhlbHBmdWwgd2hlbiB0aGVyZSBhcmUgdGhyZWUgd2F5cyB0byByZWNlaXZlIHRoaXMgbWVzc2FnZS5cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fc2lnbmFsUmVhZHkucmVzb2x2ZSh0aGlzLnNlbmRpbmcpO1xuICAgIHRoaXMuc2VuZGluZyA9IFtdO1xuICB9XG4gIHNlbmRpbmcgPSBbXTtcbiAgc2lnbmFsKHR5cGUsIG1lc3NhZ2UpIHtcbiAgICBzdXBlci5zaWduYWwodHlwZSwgbWVzc2FnZSk7XG4gICAgdGhpcy5zZW5kaW5nLnB1c2goW3R5cGUsIG1lc3NhZ2VdKTtcbiAgfVxuICAvLyBXZSBuZWVkIHRvIGtub3cgaWYgdGhlcmUgYXJlIG9wZW4gZGF0YSBjaGFubmVscy4gVGhlcmUgaXMgYSBwcm9wb3NhbCBhbmQgZXZlbiBhbiBhY2NlcHRlZCBQUiBmb3IgUlRDUGVlckNvbm5lY3Rpb24uZ2V0RGF0YUNoYW5uZWxzKCksXG4gIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS93M2Mvd2VicnRjLWV4dGVuc2lvbnMvaXNzdWVzLzExMFxuICAvLyBidXQgaXQgaGFzbid0IGJlZW4gZGVwbG95ZWQgZXZlcnl3aGVyZSB5ZXQuIFNvIHdlJ2xsIG5lZWQgdG8ga2VlcCBvdXIgb3duIGNvdW50LlxuICAvLyBBbGFzLCBhIGNvdW50IGlzbid0IGVub3VnaCwgYmVjYXVzZSB3ZSBjYW4gb3BlbiBzdHVmZiwgYW5kIHRoZSBvdGhlciBzaWRlIGNhbiBvcGVuIHN0dWZmLCBidXQgaWYgaXQgaGFwcGVucyB0byBiZVxuICAvLyB0aGUgc2FtZSBcIm5lZ290aWF0ZWRcIiBpZCwgaXQgaXNuJ3QgcmVhbGx5IGEgZGlmZmVyZW50IGNoYW5uZWwuIChodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvUlRDUGVlckNvbm5lY3Rpb24vZGF0YWNoYW5uZWxfZXZlbnRcbiAgZGF0YUNoYW5uZWxzID0gbmV3IE1hcCgpO1xuICByZXBvcnRDaGFubmVscygpIHsgLy8gUmV0dXJuIGEgcmVwb3J0IHN0cmluZyB1c2VmdWwgZm9yIGRlYnVnZ2luZy5cbiAgICBjb25zdCBlbnRyaWVzID0gQXJyYXkuZnJvbSh0aGlzLmRhdGFDaGFubmVscy5lbnRyaWVzKCkpO1xuICAgIGNvbnN0IGt2ID0gZW50cmllcy5tYXAoKFtrLCB2XSkgPT4gYCR7a306JHt2LmlkfWApO1xuICAgIHJldHVybiBgJHt0aGlzLmRhdGFDaGFubmVscy5zaXplfS8ke2t2LmpvaW4oJywgJyl9YDtcbiAgfVxuICBub3RlQ2hhbm5lbChjaGFubmVsLCBzb3VyY2UsIHdhaXRpbmcpIHsgLy8gQm9va2tlZXAgb3BlbiBjaGFubmVsIGFuZCByZXR1cm4gaXQuXG4gICAgLy8gRW1wZXJpY2FsbHksIHdpdGggbXVsdGlwbGV4IGZhbHNlOiAvLyAgIDE4IG9jY3VycmVuY2VzLCB3aXRoIGlkPW51bGx8MHwxIGFzIGZvciBldmVudGNoYW5uZWwgb3IgY3JlYXRlRGF0YUNoYW5uZWxcbiAgICAvLyAgIEFwcGFyZW50bHksIHdpdGhvdXQgbmVnb3RpYXRpb24sIGlkIGlzIGluaXRpYWxseSBudWxsIChyZWdhcmRsZXNzIG9mIG9wdGlvbnMuaWQpLCBhbmQgdGhlbiBhc3NpZ25lZCB0byBhIGZyZWUgdmFsdWUgZHVyaW5nIG9wZW5pbmdcbiAgICBjb25zdCBrZXkgPSBjaGFubmVsLmxhYmVsOyAvL2ZpeG1lIGNoYW5uZWwuaWQgPT09IG51bGwgPyAxIDogY2hhbm5lbC5pZDtcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuZGF0YUNoYW5uZWxzLmdldChrZXkpO1xuICAgIHRoaXMubG9nKCdnb3QgZGF0YS1jaGFubmVsJywgc291cmNlLCBrZXksICdleGlzdGluZzonLCBleGlzdGluZywgJ3dhaXRpbmc6Jywgd2FpdGluZyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbHMuc2V0KGtleSwgY2hhbm5lbCk7XG4gICAgY2hhbm5lbC5hZGRFdmVudExpc3RlbmVyKCdjbG9zaW5nJywgZXZlbnQgPT4gY29uc29sZS5sb2coJ2Nsb3NpbmcgZXZlbnQnLCBrZXksIGNoYW5uZWwucmVhZFN0YXRlKSk7XG4gICAgY2hhbm5lbC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsIGV2ZW50ID0+IHsgLy8gQ2xvc2Ugd2hvbGUgY29ubmVjdGlvbiB3aGVuIG5vIG1vcmUgZGF0YSBjaGFubmVscyBvciBzdHJlYW1zLlxuICAgICAgdGhpcy5kYXRhQ2hhbm5lbHMuZGVsZXRlKGtleSk7XG4gICAgICBjb25zb2xlLmxvZygnUHJvbWlzZVdlYlJUQyBEYXRhQ2hhbm5lbCBvbmNsb3NlJywga2V5LCBjaGFubmVsLnJlYWR5U3RhdGUsIHRoaXMuZGF0YUNoYW5uZWxzLnNpemUsIHRoaXMucGVlci5nZXRTZW5kZXJzKCkubGVuZ3RoKTtcbiAgICAgIC8vIElmIHRoZXJlJ3Mgbm90aGluZyBvcGVuLCBjbG9zZSB0aGUgY29ubmVjdGlvbi5cbiAgICAgIGlmICh0aGlzLmRhdGFDaGFubmVscy5zaXplKSByZXR1cm47XG4gICAgICBpZiAodGhpcy5wZWVyLmdldFNlbmRlcnMoKS5sZW5ndGgpIHJldHVybjtcbiAgICAgIHRoaXMuY2xvc2UoKTtcbiAgICB9KTtcbiAgICByZXR1cm4gY2hhbm5lbDtcbiAgfVxuICBjcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCA9IFwiZGF0YVwiLCBjaGFubmVsT3B0aW9ucyA9IHt9KSB7IC8vIFByb21pc2UgcmVzb2x2ZXMgd2hlbiB0aGUgY2hhbm5lbCBpcyBvcGVuICh3aGljaCB3aWxsIGJlIGFmdGVyIGFueSBuZWVkZWQgbmVnb3RpYXRpb24pLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdjcmVhdGUgZGF0YS1jaGFubmVsJywgbGFiZWwsIGNoYW5uZWxPcHRpb25zKTtcbiAgICAgIGxldCBjaGFubmVsID0gdGhpcy5wZWVyLmNyZWF0ZURhdGFDaGFubmVsKGxhYmVsLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgICB0aGlzLm5vdGVDaGFubmVsKGNoYW5uZWwsICdleHBsaWNpdCcpOyAvLyBOb3RlZCBldmVuIGJlZm9yZSBvcGVuZWQuXG4gICAgICAvLyBUaGUgY2hhbm5lbCBtYXkgaGF2ZSBhbHJlYWR5IGJlZW4gb3BlbmVkIG9uIHRoZSBvdGhlciBzaWRlLiBJbiB0aGlzIGNhc2UsIGFsbCBicm93c2VycyBmaXJlIHRoZSBvcGVuIGV2ZW50IGFueXdheSxcbiAgICAgIC8vIGJ1dCB3cnRjIChpLmUuLCBvbiBub2RlSlMpIGRvZXMgbm90LiBTbyB3ZSBoYXZlIHRvIGV4cGxpY2l0bHkgY2hlY2suXG4gICAgICBzd2l0Y2ggKGNoYW5uZWwucmVhZHlTdGF0ZSkge1xuICAgICAgY2FzZSAnb3Blbic6XG5cdHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShjaGFubmVsKSwgMTApO1xuXHRicmVhaztcbiAgICAgIGNhc2UgJ2Nvbm5lY3RpbmcnOlxuXHRjb25zb2xlLmxvZygnUHJvbWlzZVdlYlJUQyNjcmVhdGVEYXRhQ2hhbm5lbCcsIGxhYmVsLCBjaGFubmVsLnJlYWR5U3RhdGUpO1xuXHRjaGFubmVsLm9ub3BlbiA9IF8gPT4ge1xuXHQgIHJlc29sdmUoY2hhbm5lbCk7XG5cdH07XG5cdGJyZWFrO1xuICAgICAgZGVmYXVsdDpcblx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHJlYWR5U3RhdGUgJHtjaGFubmVsLnJlYWR5U3RhdGV9IGZvciBkYXRhIGNoYW5uZWwgJHtsYWJlbH0uYCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgd2FpdGluZ0NoYW5uZWxzID0ge307XG4gIGdldERhdGFDaGFubmVsUHJvbWlzZShsYWJlbCA9IFwiZGF0YVwiKSB7IC8vIFJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdwcm9taXNlIGRhdGEtY2hhbm5lbCcsIGxhYmVsKTtcbiAgICAgIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXSA9IHJlc29sdmU7XG4gICAgfSk7XG4gIH1cbiAgcmVzZXRQZWVyKCkgeyAvLyBSZXNldCBhICdjb25uZWN0ZWQnIHByb3BlcnR5IHRoYXQgcHJvbWlzZWQgdG8gcmVzb2x2ZSB3aGVuIG9wZW5lZCwgYW5kIHRyYWNrIGluY29taW5nIGRhdGFjaGFubmVscy5cbiAgICBzdXBlci5yZXNldFBlZXIoKTtcbiAgICB0aGlzLmNvbm5lY3RlZCA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyAvLyB0aGlzLmNvbm5lY3RlZCBpcyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGFyZS5cbiAgICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdjb25uZWN0aW9uc3RhdGVjaGFuZ2UnLCBldmVudCA9PiB7XG5cdGlmICh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnY29ubmVjdGVkJykge1xuXHQgIHJlc29sdmUodHJ1ZSk7XG5cdH1cbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdkYXRhY2hhbm5lbCcsIGV2ZW50ID0+IHsgLy8gUmVzb2x2ZSBwcm9taXNlIG1hZGUgd2l0aCBnZXREYXRhQ2hhbm5lbFByb21pc2UoKS5cbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBldmVudC5jaGFubmVsO1xuICAgICAgY29uc3QgbGFiZWwgPSBjaGFubmVsLmxhYmVsO1xuICAgICAgY29uc3Qgd2FpdGluZyA9IHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHRoaXMubm90ZUNoYW5uZWwoY2hhbm5lbCwgJ2RhdGFjaGFubmVsIGV2ZW50Jywgd2FpdGluZyk7IC8vIFJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB3ZSBhcmUgd2FpdGluZy5cbiAgICAgIGlmICghd2FpdGluZykgcmV0dXJuOyAvLyBNaWdodCBub3QgYmUgZXhwbGljaXRseSB3YWl0aW5nLiBFLmcuLCByb3V0ZXJzLlxuICAgICAgZGVsZXRlIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHdhaXRpbmcoY2hhbm5lbCk7XG4gICAgfSk7XG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICdmYWlsZWQnKSB0aGlzLl9zaWduYWxQcm9taXNlPy5yZWplY3Q/LigpO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgdGhpcy5fc2lnbmFsUHJvbWlzZSA9IHRoaXMuX3NpZ25hbFJlYWR5ID0gbnVsbDtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgICAvLyBJZiB0aGUgd2VicnRjIGltcGxlbWVudGF0aW9uIGNsb3NlcyB0aGUgZGF0YSBjaGFubmVscyBiZWZvcmUgdGhlIHBlZXIgaXRzZWxmLCB0aGVuIHRoaXMuZGF0YUNoYW5uZWxzIHdpbGwgYmUgZW1wdHkuXG4gICAgLy8gQnV0IGlmIG5vdCAoZS5nLiwgc3RhdHVzICdmYWlsZWQnIG9yICdkaXNjb25uZWN0ZWQnIG9uIFNhZmFyaSksIHRoZW4gbGV0IHVzIGV4cGxpY2l0bHkgY2xvc2UgdGhlbSBzbyB0aGF0IFN5bmNocm9uaXplcnMga25vdyB0byBjbGVhbiB1cC5cbiAgICBmb3IgKGNvbnN0IGNoYW5uZWwgb2YgdGhpcy5kYXRhQ2hhbm5lbHMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgIT09ICdvcGVuJykgY29udGludWU7IC8vIEtlZXAgZGVidWdnaW5nIHNhbml0eS5cbiAgICAgIGNvbnNvbGUubG9nKCdQcm9taXNlV2ViUlRDI2Nsb3NlIGV4cGxpY2l0bHkgY2xvc2luZyBjaGFubmVsJywgY2hhbm5lbC5sYWJlbCwgY2hhbm5lbC5yZWFkeVN0YXRlKTtcbiAgICAgIC8vIEl0IGFwcGVhcnMgdGhhdCBpbiBTYWZhcmkgKDE4LjUpIGZvciBhIGNhbGwgdG8gY2hhbm5lbC5jbG9zZSgpIHdpdGggdGhlIGNvbm5lY3Rpb24gYWxyZWFkeSBpbnRlcm5hbGwgY2xvc2VkLCBTYWZhcmlcbiAgICAgIC8vIHdpbGwgc2V0IGNoYW5uZWwucmVhZHlTdGF0ZSB0byAnY2xvc2luZycsIGJ1dCBOT1QgZmlyZSB0aGUgY2xvc2VkIG9yIGNsb3NpbmcgZXZlbnQuIFNvIHdlIGhhdmUgdG8gZGlzcGF0Y2ggaXQgb3Vyc2VsdmVzLlxuICAgICAgLy9jaGFubmVsLmNsb3NlKCk7XG4gICAgICBjaGFubmVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjbG9zZScpKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gTmVnb3RpYXRlZCBjaGFubmVscyB1c2Ugc3BlY2lmaWMgaW50ZWdlcnMgb24gYm90aCBzaWRlcywgc3RhcnRpbmcgd2l0aCB0aGlzIG51bWJlci5cbi8vIFdlIGRvIG5vdCBzdGFydCBhdCB6ZXJvIGJlY2F1c2UgdGhlIG5vbi1uZWdvdGlhdGVkIGNoYW5uZWxzIChhcyB1c2VkIG9uIHNlcnZlciByZWxheXMpIGdlbmVyYXRlIHRoZWlyXG4vLyBvd24gaWRzIHN0YXJ0aW5nIHdpdGggMCwgYW5kIHdlIGRvbid0IHdhbnQgdG8gY29uZmxpY3QuXG4vLyBUaGUgc3BlYyBzYXlzIHRoZXNlIGNhbiBnbyB0byA2NSw1MzQsIGJ1dCBJIGZpbmQgdGhhdCBzdGFydGluZyBncmVhdGVyIHRoYW4gdGhlIHZhbHVlIGhlcmUgZ2l2ZXMgZXJyb3JzLlxuY29uc3QgQkFTRV9DSEFOTkVMX0lEID0gMTAwMDtcbmV4cG9ydCBjbGFzcyBTaGFyZWRXZWJSVEMgZXh0ZW5kcyBQcm9taXNlV2ViUlRDIHtcbiAgc3RhdGljIGNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICBzdGF0aWMgZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIG11bHRpcGxleCA9IHRydWUsIC4uLnJlc3R9KSB7XG4gICAgbGV0IGNvbm5lY3Rpb24gPSB0aGlzLmNvbm5lY3Rpb25zLmdldChzZXJ2aWNlTGFiZWwpO1xuICAgIGlmICghY29ubmVjdGlvbikge1xuICAgICAgY29ubmVjdGlvbiA9IG5ldyB0aGlzKHtsYWJlbDogc2VydmljZUxhYmVsLCB1dWlkOiB1dWlkNCgpLCBtdWx0aXBsZXgsIC4uLnJlc3R9KTtcbiAgICAgIGlmIChtdWx0aXBsZXgpIHRoaXMuY29ubmVjdGlvbnMuc2V0KHNlcnZpY2VMYWJlbCwgY29ubmVjdGlvbik7XG4gICAgfVxuICAgIHJldHVybiBjb25uZWN0aW9uO1xuICB9XG4gIGNoYW5uZWxJZCA9IEJBU0VfQ0hBTk5FTF9JRDtcbiAgZ2V0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nKCkge1xuICAgIHJldHVybiB0aGlzLmNoYW5uZWxJZCA+IEJBU0VfQ0hBTk5FTF9JRDtcbiAgfVxuICBjbG9zZShyZW1vdmVDb25uZWN0aW9uID0gdHJ1ZSkge1xuICAgIHRoaXMuY2hhbm5lbElkID0gQkFTRV9DSEFOTkVMX0lEO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgaWYgKHJlbW92ZUNvbm5lY3Rpb24pIHRoaXMuY29uc3RydWN0b3IuY29ubmVjdGlvbnMuZGVsZXRlKHRoaXMuc2VydmljZUxhYmVsKTtcbiAgfVxuICBhc3luYyBlbnN1cmVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgY2hhbm5lbE9wdGlvbnMgPSB7fSwgc2lnbmFscyA9IG51bGwpIHsgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgYW4gb3BlbiBkYXRhIGNoYW5uZWwgb24gdGhpcyBjb25uZWN0aW9uLlxuICAgIGNvbnN0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nID0gdGhpcy5oYXNTdGFydGVkQ29ubmVjdGluZzsgLy8gTXVzdCBhc2sgYmVmb3JlIGluY3JlbWVudGluZyBpZC5cbiAgICBjb25zdCBpZCA9IHRoaXMuY2hhbm5lbElkKys7IC8vIFRoaXMgYW5kIGV2ZXJ5dGhpbmcgbGVhZGluZyB1cCB0byBpdCBtdXN0IGJlIHN5bmNocm9ub3VzLCBzbyB0aGF0IGlkIGFzc2lnbm1lbnQgaXMgZGV0ZXJtaW5pc3RpYy5cbiAgICBjb25zdCBuZWdvdGlhdGVkID0gKHRoaXMubXVsdGlwbGV4ID09PSAnbmVnb3RpYXRlZCcpICYmIGhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGNvbnN0IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgPSAhaGFzU3RhcnRlZENvbm5lY3RpbmcgLyohbmVnb3RpYXRlZCovICYmICEhc2lnbmFsczsgLy8gT25seSB0aGUgMHRoIHdpdGggc2lnbmFscyB3YWl0cyBwYXNzaXZlbHkuXG4gICAgLy8gc2lnbmFscyBpcyBlaXRoZXIgbnVsbGlzaCBvciBhbiBhcnJheSBvZiBzaWduYWxzLCBidXQgdGhhdCBhcnJheSBjYW4gYmUgRU1QVFksXG4gICAgLy8gaW4gd2hpY2ggY2FzZSB0aGUgcmVhbCBzaWduYWxzIHdpbGwgaGF2ZSB0byBiZSBhc3NpZ25lZCBsYXRlci4gVGhpcyBhbGxvd3MgdGhlIGRhdGEgY2hhbm5lbCB0byBiZSBzdGFydGVkIChhbmQgdG8gY29uc3VtZVxuICAgIC8vIGEgY2hhbm5lbElkKSBzeW5jaHJvbm91c2x5LCBidXQgdGhlIHByb21pc2Ugd29uJ3QgcmVzb2x2ZSB1bnRpbCB0aGUgcmVhbCBzaWduYWxzIGFyZSBzdXBwbGllZCBsYXRlci4gVGhpcyBpc1xuICAgIC8vIHVzZWZ1bCBpbiBtdWx0aXBsZXhpbmcgYW4gb3JkZXJlZCBzZXJpZXMgb2YgZGF0YSBjaGFubmVscyBvbiBhbiBBTlNXRVIgY29ubmVjdGlvbiwgd2hlcmUgdGhlIGRhdGEgY2hhbm5lbHMgbXVzdFxuICAgIC8vIG1hdGNoIHVwIHdpdGggYW4gT0ZGRVIgY29ubmVjdGlvbiBvbiBhIHBlZXIuIFRoaXMgd29ya3MgYmVjYXVzZSBvZiB0aGUgd29uZGVyZnVsIGhhcHBlbnN0YW5jZSB0aGF0IGFuc3dlciBjb25uZWN0aW9uc1xuICAgIC8vIGdldERhdGFDaGFubmVsUHJvbWlzZSAod2hpY2ggZG9lc24ndCByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIHlldCBiZSBvcGVuKSByYXRoZXIgdGhhbiBjcmVhdGVEYXRhQ2hhbm5lbCAod2hpY2ggd291bGRcbiAgICAvLyByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIGFscmVhZHkgYmUgb3BlbikuXG4gICAgY29uc3QgdXNlU2lnbmFscyA9ICFoYXNTdGFydGVkQ29ubmVjdGluZyAmJiBzaWduYWxzPy5sZW5ndGg7XG4gICAgY29uc3Qgb3B0aW9ucyA9IG5lZ290aWF0ZWQgPyB7aWQsIG5lZ290aWF0ZWQsIC4uLmNoYW5uZWxPcHRpb25zfSA6IGNoYW5uZWxPcHRpb25zO1xuICAgIGNvbnNvbGUubG9nKCdTaGFyZWRXZWJSVEMjZW5zdXJlRGF0YUNoYW5uZWwnLCB0aGlzLmxhYmVsLCB7Y2hhbm5lbE5hbWUsIGhhc1N0YXJ0ZWRDb25uZWN0aW5nLCBpZCwgbmVnb3RpYXRlZCwgb3B0aW9ucywgdXNlU2lnbmFsc30pO1xuICAgIGlmIChoYXNTdGFydGVkQ29ubmVjdGluZykge1xuICAgICAgYXdhaXQgdGhpcy5jb25uZWN0ZWQ7IC8vIEJlZm9yZSBjcmVhdGluZyBwcm9taXNlLlxuICAgIH0gZWxzZSBpZiAodXNlU2lnbmFscykge1xuICAgICAgdGhpcy5zaWduYWxzID0gc2lnbmFscztcbiAgICB9XG4gICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwKSk7IC8vIFNob3VsZCBub3QgYmUgbmVjZXNzYXJ5LiBJJ20gdHJ5aW5nIHRvIG1ha2UgU2FmYXJpIG1vcmUgcmVsaWFibGUuXG4gICAgY29uc3QgcHJvbWlzZSA9IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgP1xuXHQgIHRoaXMuZ2V0RGF0YUNoYW5uZWxQcm9taXNlKGNoYW5uZWxOYW1lKSA6XG5cdCAgdGhpcy5jcmVhdGVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIGF3YWl0IHByb21pc2U7XG4gIH1cbn1cbiIsIi8vIG5hbWUvdmVyc2lvbiBvZiBcImRhdGFiYXNlXCJcbmV4cG9ydCBjb25zdCBzdG9yYWdlTmFtZSA9ICdmbGV4c3RvcmUnO1xuZXhwb3J0IGNvbnN0IHN0b3JhZ2VWZXJzaW9uID0gNjtcblxuaW1wb3J0ICogYXMgcGtnIGZyb20gXCIuLi9wYWNrYWdlLmpzb25cIiB3aXRoIHsgdHlwZTogJ2pzb24nIH07XG5leHBvcnQgY29uc3Qge25hbWUsIHZlcnNpb259ID0gcGtnLmRlZmF1bHQ7XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgeyB0YWdQYXRoIH0gZnJvbSAnLi90YWdQYXRoLm1qcyc7XG5pbXBvcnQgeyBTaGFyZWRXZWJSVEMgfSBmcm9tICcuL3dlYnJ0Yy5tanMnO1xuaW1wb3J0IHsgc3RvcmFnZVZlcnNpb24gfSBmcm9tICcuL3ZlcnNpb24ubWpzJztcblxuLypcbiAgUmVzcG9uc2libGUgZm9yIGtlZXBpbmcgYSBjb2xsZWN0aW9uIHN5bmNocm9uaXplZCB3aXRoIGFub3RoZXIgcGVlci5cbiAgKFBlZXJzIG1heSBiZSBhIGNsaWVudCBvciBhIHNlcnZlci9yZWxheS4gSW5pdGlhbGx5IHRoaXMgaXMgdGhlIHNhbWUgY29kZSBlaXRoZXIgd2F5LFxuICBidXQgbGF0ZXIgb24sIG9wdGltaXphdGlvbnMgY2FuIGJlIG1hZGUgZm9yIHNjYWxlLilcblxuICBBcyBsb25nIGFzIHR3byBwZWVycyBhcmUgY29ubmVjdGVkIHdpdGggYSBTeW5jaHJvbml6ZXIgb24gZWFjaCBzaWRlLCB3cml0aW5nIGhhcHBlbnNcbiAgaW4gYm90aCBwZWVycyBpbiByZWFsIHRpbWUsIGFuZCByZWFkaW5nIHByb2R1Y2VzIHRoZSBjb3JyZWN0IHN5bmNocm9uaXplZCByZXN1bHQgZnJvbSBlaXRoZXIuXG4gIFVuZGVyIHRoZSBob29kLCB0aGUgc3luY2hyb25pemVyIGtlZXBzIHRyYWNrIG9mIHdoYXQgaXQga25vd3MgYWJvdXQgdGhlIG90aGVyIHBlZXIgLS1cbiAgYSBwYXJ0aWN1bGFyIHRhZyBjYW4gYmUgdW5rbm93biwgdW5zeW5jaHJvbml6ZWQsIG9yIHN5bmNocm9uaXplZCwgYW5kIHJlYWRpbmcgd2lsbFxuICBjb21tdW5pY2F0ZSBhcyBuZWVkZWQgdG8gZ2V0IHRoZSBkYXRhIHN5bmNocm9uaXplZCBvbi1kZW1hbmQuIE1lYW53aGlsZSwgc3luY2hyb25pemF0aW9uXG4gIGNvbnRpbnVlcyBpbiB0aGUgYmFja2dyb3VuZCB1bnRpbCB0aGUgY29sbGVjdGlvbiBpcyBmdWxseSByZXBsaWNhdGVkLlxuXG4gIEEgY29sbGVjdGlvbiBtYWludGFpbnMgYSBzZXBhcmF0ZSBTeW5jaHJvbml6ZXIgZm9yIGVhY2ggb2YgemVybyBvciBtb3JlIHBlZXJzLCBhbmQgY2FuIGR5bmFtaWNhbGx5XG4gIGFkZCBhbmQgcmVtb3ZlIG1vcmUuXG5cbiAgTmFtaW5nIGNvbnZlbnRpb25zOlxuXG4gIG11bWJsZU5hbWU6IGEgc2VtYW50aWMgbmFtZSB1c2VkIGV4dGVybmFsbHkgYXMgYSBrZXkuIEV4YW1wbGU6IHNlcnZpY2VOYW1lLCBjaGFubmVsTmFtZSwgZXRjLlxuICAgIFdoZW4gdGhpbmdzIG5lZWQgdG8gbWF0Y2ggdXAgYWNyb3NzIHN5c3RlbXMsIGl0IGlzIGJ5IG5hbWUuXG4gICAgSWYgb25seSBvbmUgb2YgbmFtZS9sYWJlbCBpcyBzcGVjaWZpZWQsIHRoaXMgaXMgdXN1YWxseSB0aGUgdGhlIG9uZS5cblxuICBtdW1ibGVMYWJlbDogYSBsYWJlbCBmb3IgaWRlbnRpZmljYXRpb24gYW5kIGludGVybmFsbHkgKGUuZy4sIGRhdGFiYXNlIG5hbWUpLlxuICAgIFdoZW4gdHdvIGluc3RhbmNlcyBvZiBzb21ldGhpbmcgYXJlIFwidGhlIHNhbWVcIiBidXQgYXJlIGluIHRoZSBzYW1lIEphdmFzY3JpcHQgaW1hZ2UgZm9yIHRlc3RpbmcsIHRoZXkgYXJlIGRpc3Rpbmd1aXNoZWQgYnkgbGFiZWwuXG4gICAgVHlwaWNhbGx5IGRlZmF1bHRzIHRvIG11bWJsZU5hbWUuXG5cbiAgTm90ZSwgdGhvdWdoLCB0aGF0IHNvbWUgZXh0ZXJuYWwgbWFjaGluZXJ5IChzdWNoIGFzIGEgV2ViUlRDIERhdGFDaGFubmVsKSBoYXMgYSBcImxhYmVsXCIgcHJvcGVydHkgdGhhdCB3ZSBwb3B1bGF0ZSB3aXRoIGEgXCJuYW1lXCIgKGNoYW5uZWxOYW1lKS5cbiAqL1xuZXhwb3J0IGNsYXNzIFN5bmNocm9uaXplciB7XG4gIGNvbnN0cnVjdG9yKHtzZXJ2aWNlTmFtZSA9ICdkaXJlY3QnLCBjb2xsZWN0aW9uLCBlcnJvciA9IGNvbGxlY3Rpb24/LmNvbnN0cnVjdG9yLmVycm9yLFxuXHQgICAgICAgc2VydmljZUxhYmVsID0gY29sbGVjdGlvbj8uc2VydmljZUxhYmVsIHx8IHNlcnZpY2VOYW1lLCAvLyBVc2VkIHRvIGlkZW50aWZ5IGFueSBleGlzdGluZyBjb25uZWN0aW9uLiBDYW4gYmUgZGlmZmVyZW50IGZyb20gc2VydmljZU5hbWUgZHVyaW5nIHRlc3RpbmcuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgdXVpZCwgcnRjQ29uZmlndXJhdGlvbiwgY29ubmVjdGlvbiwgLy8gQ29tcGxleCBkZWZhdWx0IGJlaGF2aW9yIGZvciB0aGVzZS4gU2VlIGNvZGUuXG5cdCAgICAgICBtdWx0aXBsZXggPSBjb2xsZWN0aW9uPy5tdWx0aXBsZXgsIC8vIElmIHNwZWNpZmVkLCBvdGhlcndpc2UgdW5kZWZpbmVkIGF0IHRoaXMgcG9pbnQuIFNlZSBiZWxvdy5cblx0ICAgICAgIGRlYnVnID0gY29sbGVjdGlvbj8uZGVidWcsIG1pblZlcnNpb24gPSBzdG9yYWdlVmVyc2lvbiwgbWF4VmVyc2lvbiA9IG1pblZlcnNpb259KSB7XG4gICAgLy8gc2VydmljZU5hbWUgaXMgYSBzdHJpbmcgb3Igb2JqZWN0IHRoYXQgaWRlbnRpZmllcyB3aGVyZSB0aGUgc3luY2hyb25pemVyIHNob3VsZCBjb25uZWN0LiBFLmcuLCBpdCBtYXkgYmUgYSBVUkwgY2FycnlpbmdcbiAgICAvLyAgIFdlYlJUQyBzaWduYWxpbmcuIEl0IHNob3VsZCBiZSBhcHAtdW5pcXVlIGZvciB0aGlzIHBhcnRpY3VsYXIgc2VydmljZSAoZS5nLiwgd2hpY2ggbWlnaHQgbXVsdGlwbGV4IGRhdGEgZm9yIG11bHRpcGxlIGNvbGxlY3Rpb24gaW5zdGFuY2VzKS5cbiAgICAvLyB1dWlkIGhlbHAgdW5pcXVlbHkgaWRlbnRpZmllcyB0aGlzIHBhcnRpY3VsYXIgc3luY2hyb25pemVyLlxuICAgIC8vICAgRm9yIG1vc3QgcHVycG9zZXMsIHV1aWQgc2hvdWxkIGdldCB0aGUgZGVmYXVsdCwgYW5kIHJlZmVycyB0byBPVVIgZW5kLlxuICAgIC8vICAgSG93ZXZlciwgYSBzZXJ2ZXIgdGhhdCBjb25uZWN0cyB0byBhIGJ1bmNoIG9mIHBlZXJzIG1pZ2h0IGJhc2ggaW4gdGhlIHV1aWQgd2l0aCB0aGF0IG9mIHRoZSBvdGhlciBlbmQsIHNvIHRoYXQgbG9nZ2luZyBpbmRpY2F0ZXMgdGhlIGNsaWVudC5cbiAgICAvLyBJZiBjaGFubmVsTmFtZSBpcyBzcGVjaWZpZWQsIGl0IHNob3VsZCBiZSBpbiB0aGUgZm9ybSBvZiBjb2xsZWN0aW9uVHlwZS9jb2xsZWN0aW9uTmFtZSAoZS5nLiwgaWYgY29ubmVjdGluZyB0byByZWxheSkuXG4gICAgY29uc3QgY29ubmVjdFRocm91Z2hJbnRlcm5ldCA9IHNlcnZpY2VOYW1lLnN0YXJ0c1dpdGg/LignaHR0cCcpO1xuICAgIGlmICghY29ubmVjdFRocm91Z2hJbnRlcm5ldCAmJiAocnRjQ29uZmlndXJhdGlvbiA9PT0gdW5kZWZpbmVkKSkgcnRjQ29uZmlndXJhdGlvbiA9IHt9OyAvLyBFeHBpY2l0bHkgbm8gaWNlLiBMQU4gb25seS5cbiAgICAvLyBtdWx0aXBsZXggc2hvdWxkIGVuZCB1cCB3aXRoIG9uZSBvZiB0aHJlZSB2YWx1ZXM6XG4gICAgLy8gZmFsc3kgLSBhIG5ldyBjb25uZWN0aW9uIHNob3VsZCBiZSB1c2VkIGZvciBlYWNoIGNoYW5uZWxcbiAgICAvLyBcIm5lZ290aWF0ZWRcIiAtIGJvdGggc2lkZXMgY3JlYXRlIHRoZSBzYW1lIGNoYW5uZWxOYW1lcyBpbiB0aGUgc2FtZSBvcmRlciAobW9zdCBjYXNlcyk6XG4gICAgLy8gICAgIFRoZSBpbml0aWFsIHNpZ25hbGxpbmcgd2lsbCBiZSB0cmlnZ2VyZWQgYnkgb25lIHNpZGUgY3JlYXRpbmcgYSBjaGFubmVsLCBhbmQgdGhlciBzaWRlIHdhaXRpbmcgZm9yIGl0IHRvIGJlIGNyZWF0ZWQuXG4gICAgLy8gICAgIEFmdGVyIHRoYXQsIGJvdGggc2lkZXMgd2lsbCBleHBsaWNpdGx5IGNyZWF0ZSBhIGRhdGEgY2hhbm5lbCBhbmQgd2VicnRjIHdpbGwgbWF0Y2ggdGhlbSB1cCBieSBpZC5cbiAgICAvLyBhbnkgb3RoZXIgdHJ1dGh5IC0gU3RhcnRzIGxpa2UgbmVnb3RpYXRlZCwgYW5kIHRoZW4gY29udGludWVzIHdpdGggb25seSB3aWRlIHNpZGUgY3JlYXRpbmcgdGhlIGNoYW5uZWxzLCBhbmQgdGhlciBvdGhlclxuICAgIC8vICAgICBvYnNlcnZlcyB0aGUgY2hhbm5lbCB0aGF0IGhhcyBiZWVuIG1hZGUuIFRoaXMgaXMgdXNlZCBmb3IgcmVsYXlzLlxuICAgIG11bHRpcGxleCA/Pz0gY29ubmVjdGlvbj8ubXVsdGlwbGV4OyAvLyBTdGlsbCB0eXBpY2FsbHkgdW5kZWZpbmVkIGF0IHRoaXMgcG9pbnQuXG4gICAgbXVsdGlwbGV4ID8/PSAoc2VydmljZU5hbWUuaW5jbHVkZXM/LignL3N5bmMnKSB8fCAnbmVnb3RpYXRlZCcpO1xuICAgIGNvbm5lY3Rpb24gPz89IFNoYXJlZFdlYlJUQy5lbnN1cmUoe3NlcnZpY2VMYWJlbCwgY29uZmlndXJhdGlvbjogcnRjQ29uZmlndXJhdGlvbiwgbXVsdGlwbGV4LCBkZWJ1ZywgZXJyb3J9KTtcblxuICAgIHV1aWQgPz89IGNvbm5lY3Rpb24udXVpZDtcbiAgICAvLyBCb3RoIHBlZXJzIG11c3QgYWdyZWUgb24gY2hhbm5lbE5hbWUuIFVzdWFsbHksIHRoaXMgaXMgY29sbGVjdGlvbi5mdWxsTmFtZS4gQnV0IGluIHRlc3RpbmcsIHdlIG1heSBzeW5jIHR3byBjb2xsZWN0aW9ucyB3aXRoIGRpZmZlcmVudCBuYW1lcy5cbiAgICBjaGFubmVsTmFtZSA/Pz0gY29sbGVjdGlvbj8uY2hhbm5lbE5hbWUgfHwgY29sbGVjdGlvbi5mdWxsTmFtZTtcbiAgICBjb25zdCBsYWJlbCA9IGAke2NvbGxlY3Rpb24/LmZ1bGxMYWJlbCB8fCBjaGFubmVsTmFtZX0vJHt1dWlkfWA7XG4gICAgLy8gV2hlcmUgd2UgY2FuIHJlcXVlc3QgYSBkYXRhIGNoYW5uZWwgdGhhdCBwdXNoZXMgcHV0L2RlbGV0ZSByZXF1ZXN0cyBmcm9tIG90aGVycy5cbiAgICBjb25zdCBjb25uZWN0aW9uVVJMID0gc2VydmljZU5hbWUuaW5jbHVkZXM/LignL3NpZ25hbC8nKSA/IHNlcnZpY2VOYW1lIDogYCR7c2VydmljZU5hbWV9LyR7bGFiZWx9YDtcblxuICAgIE9iamVjdC5hc3NpZ24odGhpcywge3NlcnZpY2VOYW1lLCBsYWJlbCwgY29sbGVjdGlvbiwgZGVidWcsIGVycm9yLCBtaW5WZXJzaW9uLCBtYXhWZXJzaW9uLCB1dWlkLCBydGNDb25maWd1cmF0aW9uLFxuXHRcdFx0IGNvbm5lY3Rpb24sIHV1aWQsIGNoYW5uZWxOYW1lLCBjb25uZWN0aW9uVVJMLFxuXHRcdFx0IGNvbm5lY3Rpb25TdGFydFRpbWU6IERhdGUubm93KCksXG5cdFx0XHQgY2xvc2VkOiB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UoKSxcblx0XHRcdCAvLyBOb3QgdXNlZCB5ZXQsIGJ1dCBjb3VsZCBiZSB1c2VkIHRvIEdFVCByZXNvdXJjZXMgb3ZlciBodHRwIGluc3RlYWQgb2YgdGhyb3VnaCB0aGUgZGF0YSBjaGFubmVsLlxuXHRcdFx0IGhvc3RSZXF1ZXN0QmFzZTogY29ubmVjdFRocm91Z2hJbnRlcm5ldCAmJiBgJHtzZXJ2aWNlTmFtZS5yZXBsYWNlKC9cXC8oc3luY3xzaWduYWwpLyl9LyR7Y2hhbm5lbE5hbWV9YH0pO1xuICAgIGNvbGxlY3Rpb24/LnN5bmNocm9uaXplcnMuc2V0KHNlcnZpY2VOYW1lLCB0aGlzKTsgLy8gTXVzdCBiZSBzZXQgc3luY2hyb25vdXNseSwgc28gdGhhdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSBrbm93cyB0byB3YWl0LlxuICB9XG4gIHN0YXRpYyBhc3luYyBjcmVhdGUoY29sbGVjdGlvbiwgc2VydmljZU5hbWUsIG9wdGlvbnMgPSB7fSkgeyAvLyBSZWNlaXZlIHB1c2hlZCBtZXNzYWdlcyBmcm9tIHRoZSBnaXZlbiBzZXJ2aWNlLiBnZXQvcHV0L2RlbGV0ZSB3aGVuIHRoZXkgY29tZSAod2l0aCBlbXB0eSBzZXJ2aWNlcyBsaXN0KS5cbiAgICBjb25zdCBzeW5jaHJvbml6ZXIgPSBuZXcgdGhpcyh7Y29sbGVjdGlvbiwgc2VydmljZU5hbWUsIC4uLm9wdGlvbnN9KTtcbiAgICBjb25zdCBjb25uZWN0ZWRQcm9taXNlID0gc3luY2hyb25pemVyLmNvbm5lY3RDaGFubmVsKCk7IC8vIEVzdGFibGlzaCBjaGFubmVsIGNyZWF0aW9uIG9yZGVyLlxuICAgIGNvbnN0IGNvbm5lY3RlZCA9IGF3YWl0IGNvbm5lY3RlZFByb21pc2U7XG4gICAgaWYgKCFjb25uZWN0ZWQpIHJldHVybiBzeW5jaHJvbml6ZXI7XG4gICAgcmV0dXJuIGF3YWl0IGNvbm5lY3RlZC5zeW5jaHJvbml6ZSgpO1xuICB9XG4gIGFzeW5jIGNvbm5lY3RDaGFubmVsKCkgeyAvLyBTeW5jaHJvbm91c2x5IGluaXRpYWxpemUgYW55IHByb21pc2VzIHRvIGNyZWF0ZSBhIGRhdGEgY2hhbm5lbCwgYW5kIHRoZW4gYXdhaXQgY29ubmVjdGlvbi5cbiAgICBjb25zdCB7aG9zdFJlcXVlc3RCYXNlLCB1dWlkLCBjb25uZWN0aW9uLCBzZXJ2aWNlTmFtZX0gPSB0aGlzO1xuICAgIGxldCBzdGFydGVkID0gY29ubmVjdGlvbi5oYXNTdGFydGVkQ29ubmVjdGluZztcbiAgICBpZiAoc3RhcnRlZCkge1xuICAgICAgLy8gV2UgYWxyZWFkeSBoYXZlIGEgY29ubmVjdGlvbi4gSnVzdCBvcGVuIGFub3RoZXIgZGF0YSBjaGFubmVsIGZvciBvdXIgdXNlLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlID0gY29ubmVjdGlvbi5lbnN1cmVEYXRhQ2hhbm5lbCh0aGlzLmNoYW5uZWxOYW1lKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3NpZ25hbC9hbnN3ZXInKSkgeyAvLyBQb3N0IGFuIGFuc3dlciB0byBhbiBvZmZlciB3ZSBnZW5lcmF0ZSBmb3IgYSByZW5kZXZvdXMgcGVlci5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmNvbm5lY3RTZXJ2ZXIoKTsgLy8gSnVzdCBsaWtlIGEgc3luY1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc2lnbmFsL29mZmVyJykpIHsgLy8gR2V0IGFuIG9mZmVyIGZyb20gYSByZW5kZXZvdXMgcGVlciBhbmQgcG9zdCBhbiBhbnN3ZXIuXG4gICAgICAvLyBXZSBtdXN0IHN5Y2hyb25vdXNseSBzdGFydENvbm5lY3Rpb24gbm93IHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gaGFzU3RhcnRlZENvbm5lY3RpbmcsIGFuZCBhbnkgc3Vic2VxdWVudCBkYXRhIGNoYW5uZWxcbiAgICAgIC8vIHJlcXVlc3RzIG9uIHRoZSBzYW1lIGNvbm5lY3Rpb24gd2lsbCB3YWl0ICh1c2luZyB0aGUgJ3N0YXJ0ZWQnIHBhdGgsIGFib3ZlKS5cbiAgICAgIGNvbnN0IHByb21pc2VkU2lnbmFscyA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKFtdKTsgLy8gRXN0YWJsaXNoaW5nIG9yZGVyLlxuICAgICAgY29uc3QgdXJsID0gdGhpcy5jb25uZWN0aW9uVVJMO1xuICAgICAgY29uc3Qgb2ZmZXIgPSBhd2FpdCB0aGlzLmZldGNoKHVybCk7XG4gICAgICB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbihvZmZlcik7IC8vIE5vdyBzdXBwbHkgdGhvc2Ugc2lnbmFscyBzbyB0aGF0IG91ciBjb25uZWN0aW9uIGNhbiBwcm9kdWNlIGFuc3dlciBzaWdhbHMuXG4gICAgICBzdGFydGVkID0gdGhpcy5mZXRjaCh1cmwsIGF3YWl0IHByb21pc2VkU2lnbmFscyk7IC8vIFRlbGwgdGhlIHBlZXIgYWJvdXQgb3VyIGFuc3dlci5cbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3N5bmMnKSkgeyAvLyBDb25uZWN0IHdpdGggYSBzZXJ2ZXIgcmVsYXkuIChTaWduYWwgYW5kIHN0YXkgY29ubmVjdGVkIHRocm91Z2ggc3luYy4pXG4gICAgICBzdGFydGVkID0gdGhpcy5jb25uZWN0U2VydmVyKCk7XG4gICAgfSBlbHNlIGlmIChzZXJ2aWNlTmFtZSA9PT0gJ3NpZ25hbHMnKSB7IC8vIFN0YXJ0IGNvbm5lY3Rpb24gYW5kIHJldHVybiBudWxsLiBNdXN0IGJlIGNvbnRpbnVlZCB3aXRoIGNvbXBsZXRlU2lnbmFsc1N5bmNocm9uaXphdGlvbigpO1xuICAgICAgc3RhcnRlZCA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoc2VydmljZU5hbWUpKSB7IC8vIEEgbGlzdCBvZiBcInJlY2VpdmluZ1wiIHNpZ25hbHMuXG4gICAgICBzdGFydGVkID0gdGhpcy5zdGFydENvbm5lY3Rpb24oc2VydmljZU5hbWUpO1xuICAgIH0gZWxzZSBpZiAoc2VydmljZU5hbWUuc3luY2hyb25pemVycykgeyAvLyBEdWNrIHR5cGluZyBmb3IgcGFzc2luZyBhIGNvbGxlY3Rpb24gZGlyZWN0bHkgYXMgdGhlIHNlcnZpY2VJbmZvLiAoV2UgZG9uJ3QgaW1wb3J0IENvbGxlY3Rpb24uKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdERpcmVjdFRlc3Rpbmcoc2VydmljZU5hbWUpOyAvLyBVc2VkIGluIHRlc3RpbmcuXG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5yZWNvZ25pemVkIHNlcnZpY2UgZm9ybWF0OiAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgaWYgKCEoYXdhaXQgc3RhcnRlZCkpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnY29ubmVjdGlvbiBmYWlsZWQnKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIGdldCBkYXRhQ2hhbm5lbFByb21pc2UoKSB7IC8vIEEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLl9kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgaWYgKCFwcm9taXNlKSB0aHJvdyBuZXcgRXJyb3IoYCR7dGhpcy5sYWJlbH06IERhdGEgY2hhbm5lbCBpcyBub3QgeWV0IHByb21pc2VkLmApO1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGNoYW5uZWxDbG9zZWRDbGVhbnVwKCkgeyAvLyBCb29ra2VlcGluZyB3aGVuIGNoYW5uZWwgY2xvc2VkIG9yIGV4cGxpY2l0bHkgYWJhbmRvbmVkIGJlZm9yZSBvcGVuaW5nLlxuICAgIHRoaXMuY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5kZWxldGUodGhpcy5zZXJ2aWNlTmFtZSk7XG4gICAgdGhpcy5jbG9zZWQucmVzb2x2ZSh0aGlzKTsgLy8gUmVzb2x2ZSB0byBzeW5jaHJvbml6ZXIgaXMgbmljZSBpZiwgZS5nLCBzb21lb25lIGlzIFByb21pc2UucmFjaW5nLlxuICB9XG4gIHNldCBkYXRhQ2hhbm5lbFByb21pc2UocHJvbWlzZSkgeyAvLyBTZXQgdXAgbWVzc2FnZSBhbmQgY2xvc2UgaGFuZGxpbmcuXG4gICAgdGhpcy5fZGF0YUNoYW5uZWxQcm9taXNlID0gcHJvbWlzZS50aGVuKGRhdGFDaGFubmVsID0+IHtcbiAgICAgIGRhdGFDaGFubmVsLm9ubWVzc2FnZSA9IGV2ZW50ID0+IHRoaXMucmVjZWl2ZShldmVudC5kYXRhKTtcbiAgICAgIGRhdGFDaGFubmVsLm9uY2xvc2UgPSBhc3luYyBldmVudCA9PiB0aGlzLmNoYW5uZWxDbG9zZWRDbGVhbnVwKCk7XG4gICAgICByZXR1cm4gZGF0YUNoYW5uZWw7XG4gICAgfSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemUoKSB7XG4gICAgYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG4gIHN0YXRpYyBmcmFnbWVudElkID0gMDtcbiAgYXN5bmMgc2VuZChtZXRob2QsIC4uLnBhcmFtcykgeyAvLyBTZW5kcyB0byB0aGUgcGVlciwgb3ZlciB0aGUgZGF0YSBjaGFubmVsXG4gICAgLy8gVE9ETzogYnJlYWsgdXAgbG9uZyBtZXNzYWdlcy4gKEFzIGEgcHJhY3RpY2FsIG1hdHRlciwgMTYgS2lCIGlzIHRoZSBsb25nZXN0IHRoYXQgY2FuIHJlbGlhYmx5IGJlIHNlbnQgYWNyb3NzIGRpZmZlcmVudCB3cnRjIGltcGxlbWVudGF0aW9ucy4pXG4gICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9XZWJSVENfQVBJL1VzaW5nX2RhdGFfY2hhbm5lbHMjY29uY2VybnNfd2l0aF9sYXJnZV9tZXNzYWdlc1xuICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnN0cmluZ2lmeSh7bWV0aG9kLCBwYXJhbXN9KTtcbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGNvbnN0IHN0YXRlID0gZGF0YUNoYW5uZWw/LnJlYWR5U3RhdGUgfHwgJ2Nsb3NlZCc7XG4gICAgaWYgKHN0YXRlID09PSAnY2xvc2VkJyB8fCBzdGF0ZSA9PT0gJ2Nsb3NpbmcnKSByZXR1cm47XG4gICAgdGhpcy5sb2coJ3NlbmRzJywgbWV0aG9kLCAuLi5wYXJhbXMpO1xuICAgIGNvbnN0IHNpemUgPSAxNmUzOyAvLyBBIGJpdCBsZXNzIHRoYW4gMTYgKiAxMDI0LlxuICAgIGlmIChwYXlsb2FkLmxlbmd0aCA8IHNpemUpIHtcbiAgICAgIGRhdGFDaGFubmVsLnNlbmQocGF5bG9hZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IG51bUNodW5rcyA9IE1hdGguY2VpbChwYXlsb2FkLmxlbmd0aCAvIHNpemUpO1xuICAgIGNvbnN0IGlkID0gdGhpcy5jb25zdHJ1Y3Rvci5mcmFnbWVudElkKys7XG4gICAgY29uc3QgbWV0YSA9IHttZXRob2Q6ICdmcmFnbWVudHMnLCBwYXJhbXM6IFtpZCwgbnVtQ2h1bmtzXX07XG4gICAgLy9jb25zb2xlLmxvZyhgRnJhZ21lbnRpbmcgbWVzc2FnZSAke2lkfSBpbnRvICR7bnVtQ2h1bmtzfSBjaHVua3MuYCwgbWV0YSk7XG4gICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShtZXRhKSk7XG4gICAgLy8gT3B0aW1pemF0aW9uIG9wcG9ydHVuaXR5OiByZWx5IG9uIG1lc3NhZ2VzIGJlaW5nIG9yZGVyZWQgYW5kIHNraXAgcmVkdW5kYW50IGluZm8uIElzIGl0IHdvcnRoIGl0P1xuICAgIGZvciAobGV0IGkgPSAwLCBvID0gMDsgaSA8IG51bUNodW5rczsgKytpLCBvICs9IHNpemUpIHtcbiAgICAgIGNvbnN0IGZyYWcgPSB7bWV0aG9kOiAnZnJhZycsIHBhcmFtczogW2lkLCBpLCBwYXlsb2FkLnN1YnN0cihvLCBzaXplKV19O1xuICAgICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShmcmFnKSk7XG4gICAgfVxuICB9XG4gIHJlY2VpdmUodGV4dCkgeyAvLyBEaXNwYXRjaCBhIG1lc3NhZ2Ugc2VudCBvdmVyIHRoZSBkYXRhIGNoYW5uZWwgZnJvbSB0aGUgcGVlci5cbiAgICBjb25zdCB7bWV0aG9kLCBwYXJhbXN9ID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgICB0aGlzW21ldGhvZF0oLi4ucGFyYW1zKTtcbiAgfVxuICBwZW5kaW5nRnJhZ21lbnRzID0ge307XG4gIGZyYWdtZW50cyhpZCwgbnVtQ2h1bmtzKSB7XG4gICAgLy9jb25zb2xlLmxvZyhgUmVjZWl2aW5nIG1lc2FnZSAke2lkfSBpbiAke251bUNodW5rc30uYCk7XG4gICAgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXSA9IHtyZW1haW5pbmc6IG51bUNodW5rcywgbWVzc2FnZTogQXJyYXkobnVtQ2h1bmtzKX07XG4gIH1cbiAgZnJhZyhpZCwgaSwgZnJhZ21lbnQpIHtcbiAgICBsZXQgZnJhZyA9IHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF07IC8vIFdlIGFyZSByZWx5aW5nIG9uIGZyYWdtZW50IG1lc3NhZ2UgY29taW5nIGZpcnN0LlxuICAgIGZyYWcubWVzc2FnZVtpXSA9IGZyYWdtZW50O1xuICAgIGlmICgwICE9PSAtLWZyYWcucmVtYWluaW5nKSByZXR1cm47XG4gICAgLy9jb25zb2xlLmxvZyhgRGlzcGF0Y2hpbmcgbWVzc2FnZSAke2lkfS5gKTtcbiAgICB0aGlzLnJlY2VpdmUoZnJhZy5tZXNzYWdlLmpvaW4oJycpKTtcbiAgICBkZWxldGUgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXTtcbiAgfVxuXG4gIGFzeW5jIGRpc2Nvbm5lY3QoKSB7IC8vIFdhaXQgZm9yIGRhdGFDaGFubmVsIHRvIGRyYWluIGFuZCByZXR1cm4gYSBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBhY3R1YWxseSBjbG9zZWQsXG4gICAgLy8gYnV0IHJldHVybiBpbW1lZGlhdGVseSBpZiBjb25uZWN0aW9uIG5vdCBzdGFydGVkLlxuICAgIGlmICh0aGlzLmNvbm5lY3Rpb24ucGVlci5jb25uZWN0aW9uU3RhdGUgIT09ICdjb25uZWN0ZWQnKSByZXR1cm4gdGhpcy5jaGFubmVsQ2xvc2VkQ2xlYW51cCh0aGlzLmNvbm5lY3Rpb24uY2xvc2UoKSk7XG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBkYXRhQ2hhbm5lbC5jbG9zZSgpO1xuICAgIHJldHVybiB0aGlzLmNsb3NlZDtcbiAgfVxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGR1cmluZyBzeW5jLlxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGFmdGVyIHN5bmMuXG4gIHN0YXJ0Q29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBNYWNoaW5lcnkgZm9yIG1ha2luZyBhIFdlYlJUQyBjb25uZWN0aW9uIHRvIHRoZSBwZWVyOlxuICAgIC8vICAgSWYgc2lnbmFsTWVzc2FnZXMgaXMgYSBsaXN0IG9mIFtvcGVyYXRpb24sIG1lc3NhZ2VdIG1lc3NhZ2Ugb2JqZWN0cywgdGhlbiB0aGUgb3RoZXIgc2lkZSBpcyBpbml0aWF0aW5nXG4gICAgLy8gdGhlIGNvbm5lY3Rpb24gYW5kIGhhcyBzZW50IGFuIGluaXRpYWwgb2ZmZXIvaWNlLiBJbiB0aGlzIGNhc2UsIGNvbm5lY3QoKSBwcm9taXNlcyBhIHJlc3BvbnNlXG4gICAgLy8gdG8gYmUgZGVsaXZlcmVkIHRvIHRoZSBvdGhlciBzaWRlLlxuICAgIC8vICAgT3RoZXJ3aXNlLCBjb25uZWN0KCkgcHJvbWlzZXMgYSBsaXN0IG9mIGluaXRpYWwgc2lnbmFsIG1lc3NhZ2VzIHRvIGJlIGRlbGl2ZXJlZCB0byB0aGUgb3RoZXIgc2lkZSxcbiAgICAvLyBhbmQgaXQgaXMgbmVjZXNzYXJ5IHRvIHRoZW4gY2FsbCBjb21wbGV0ZUNvbm5lY3Rpb24oKSB3aXRoIHRoZSByZXNwb25zZSBmcm9tIHRoZW0uXG4gICAgLy8gSW4gYm90aCBjYXNlcywgYXMgYSBzaWRlIGVmZmVjdCwgdGhlIGRhdGFDaGFubmVsUHJvbWlzZSBwcm9wZXJ0eSB3aWxsIGJlIHNldCB0byBhIFByb21pc2VcbiAgICAvLyB0aGF0IHJlc29sdmVzIHRvIHRoZSBkYXRhIGNoYW5uZWwgd2hlbiBpdCBpcyBvcGVucy4gVGhpcyBwcm9taXNlIGlzIHVzZWQgYnkgc2VuZCgpIGFuZCByZWNlaXZlKCkuXG4gICAgY29uc3Qge2Nvbm5lY3Rpb259ID0gdGhpcztcbiAgICB0aGlzLmxvZyhzaWduYWxNZXNzYWdlcyA/ICdnZW5lcmF0aW5nIGFuc3dlcicgOiAnZ2VuZXJhdGluZyBvZmZlcicpO1xuICAgIHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlID0gY29ubmVjdGlvbi5lbnN1cmVEYXRhQ2hhbm5lbCh0aGlzLmNoYW5uZWxOYW1lLCB7fSwgc2lnbmFsTWVzc2FnZXMpO1xuICAgIHJldHVybiBjb25uZWN0aW9uLnNpZ25hbHM7XG4gIH1cbiAgY29tcGxldGVDb25uZWN0aW9uKHNpZ25hbE1lc3NhZ2VzKSB7IC8vIEZpbmlzaCB3aGF0IHdhcyBzdGFydGVkIHdpdGggc3RhcnRDb2xsZWN0aW9uLlxuICAgIC8vIERvZXMgbm90IHJldHVybiBhIHByb21pc2UuIENsaWVudCBjYW4gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgdG8gc2VlIHdoZW4gd2UgYXJlIGFjdHVhbGx5IGNvbm5lY3RlZC5cbiAgICB0aGlzLmNvbm5lY3Rpb24uc2lnbmFscyA9IHNpZ25hbE1lc3NhZ2VzO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgYXN5bmMgZmV0Y2godXJsLCBib2R5ID0gbnVsbCkgeyAvLyBBcyBKU09OXG4gICAgY29uc3QgbWV0aG9kID0gYm9keSA/ICdQT1NUJyA6ICdHRVQnO1xuICAgIGlmICh0aGlzLmRlYnVnKSB0aGlzLmxvZyhtZXRob2QsICdzaWduYWxzJywgdXJsLCBKU09OLnN0cmluZ2lmeShib2R5LCBudWxsLCAyKSk7IC8vIFRPRE86IHN0cmluZ2lmeSBpbiBsb2cgaW5zdGVhZCBvZiBuZWVkaW5nIHRvIGd1YXJkIHdpdGggdGhpcy5kZWJ1Zy5cbiAgICBjb25zdCByZXF1ZXN0ID0gYXdhaXQgZmV0Y2godXJsLCBib2R5ID8ge21ldGhvZCwgaGVhZGVyczoge1wiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwifSwgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSl9IDoge21ldGhvZH0pXG5cdCAgLmNhdGNoKGVycm9yID0+IHRoaXMuZXJyb3IoZXJyb3IpKTtcbiAgICBpZiAoIXJlcXVlc3QpIHJldHVybiBudWxsO1xuICAgIGlmICghcmVxdWVzdC5vaykge1xuICAgICAgdGhpcy5lcnJvcihgJHtyZXF1ZXN0Py5zdGF0dXNUZXh0IHx8ICdFcnJvcid9LCBjb2RlICR7cmVxdWVzdC5zdGF0dXMgfHwgJ3Vua25vd24nfSwgaW4gZmV0Y2ggJHt1cmx9LmApO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3QuanNvbigpO1xuICAgIGlmICh0aGlzLmRlYnVnKSB0aGlzLmxvZyhtZXRob2QsICdyZXNwb25zZVNpZ25hbHMnLCB1cmwsIEpTT04uc3RyaW5naWZ5KHJlc3VsdCwgbnVsbCwgMikpO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbiAgYXN5bmMgY29ubmVjdFNlcnZlcih1cmwgPSB0aGlzLmNvbm5lY3Rpb25VUkwpIHsgLy8gQ29ubmVjdCB0byBhIHJlbGF5IG92ZXIgaHR0cC4gQ29tcGFyZSBjb25uZWN0UmVuZGV2b3VzXG4gICAgLy8gc3RhcnRDb25uZWN0aW9uLCBwb3N0IGl0LCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCB0aGUgcmVzcG9uc2UuXG4gICAgLy8gT3VyIHdlYnJ0YyBzeW5jaHJvbml6ZXIgaXMgdGhlbiBjb25uZWN0ZWQgdG8gdGhlIHJlbGF5J3Mgd2VicnQgc3luY2hyb25pemVyLlxuICAgIGNvbnN0IG91clNpZ25hbHNQcm9taXNlID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTsgLy8gbXVzdCBiZSBzeW5jaHJvbm91cyB0byBwcmVzZXJ2ZSBjaGFubmVsIGlkIG9yZGVyLlxuICAgIGNvbnN0IG91clNpZ25hbHMgPSBhd2FpdCBvdXJTaWduYWxzUHJvbWlzZTtcbiAgICBjb25zdCB0aGVpclNpZ25hbHMgPSBhd2FpdCB0aGlzLmZldGNoKHVybCwgYXdhaXQgb3VyU2lnbmFscyk7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbih0aGVpclNpZ25hbHMpO1xuICAgIH0gY2F0Y2goZXJyb3IpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgV2hpbGUgY29ubmVjdGluZyAke3VybH0sIG91ciBzaWduYWxzOiAke0pTT04uc3RyaW5naWZ5KG91clNpZ25hbHMpfSwgdGhlaXIgc2lnbmFsczogJHtKU09OLnN0cmluZ2lmeSh0aGVpclNpZ25hbHMpfS5gLCBlcnJvcik7XG4gICAgfTtcbiAgfVxuICBhc3luYyBjb21wbGV0ZVNpZ25hbHNTeW5jaHJvbml6YXRpb24oc2lnbmFscykgeyAvLyBHaXZlbiBhbnN3ZXIvaWNlIHNpZ25hbHMsIGNvbXBsZXRlIHRoZSBjb25uZWN0aW9uIGFuZCBzdGFydCBzeW5jaHJvbml6ZS5cbiAgICBhd2FpdCB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxzKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdERpcmVjdFRlc3RpbmcocGVlckNvbGxlY3Rpb24pIHsgLy8gVXNlZCBpbiB1bml0IHRlc3RpbmcsIHdoZXJlIHRoZSBcInJlbW90ZVwiIHNlcnZpY2UgaXMgc3BlY2lmaWVkIGRpcmVjdGx5IChub3QgYSBzdHJpbmcpLlxuICAgIC8vIEVhY2ggY29sbGVjdGlvbiBpcyBhc2tlZCB0byBzeWNocm9uaXplIHRvIGFub3RoZXIgY29sbGVjdGlvbi5cbiAgICBjb25zdCBwZWVyU3luY2hyb25pemVyID0gcGVlckNvbGxlY3Rpb24uc3luY2hyb25pemVycy5nZXQodGhpcy5jb2xsZWN0aW9uKTtcbiAgICBpZiAoIXBlZXJTeW5jaHJvbml6ZXIpIHsgLy8gVGhlIG90aGVyIHNpZGUgZG9lc24ndCBrbm93IGFib3V0IHVzIHlldC4gVGhlIG90aGVyIHNpZGUgd2lsbCBkbyB0aGUgd29yay5cbiAgICAgIHRoaXMuX2RlbGF5ID0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IG91clNpZ25hbHMgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbigpO1xuICAgIGNvbnN0IHRoZWlyU2lnbmFscyA9IGF3YWl0IHBlZXJTeW5jaHJvbml6ZXIuc3RhcnRDb25uZWN0aW9uKGF3YWl0IG91clNpZ25hbHMpO1xuICAgIHBlZXJTeW5jaHJvbml6ZXIuX2RlbGF5LnJlc29sdmUoKTtcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuXG4gIC8vIEEgY29tbW9uIHByYWN0aWNlIGhlcmUgaXMgdG8gaGF2ZSBhIHByb3BlcnR5IHRoYXQgaXMgYSBwcm9taXNlIGZvciBoYXZpbmcgc29tZXRoaW5nIGRvbmUuXG4gIC8vIEFzeW5jaHJvbm91cyBtYWNoaW5lcnkgY2FuIHRoZW4gcmVzb2x2ZSBpdC5cbiAgLy8gQW55dGhpbmcgdGhhdCBkZXBlbmRzIG9uIHRoYXQgY2FuIGF3YWl0IHRoZSByZXNvbHZlZCB2YWx1ZSwgd2l0aG91dCB3b3JyeWluZyBhYm91dCBob3cgaXQgZ2V0cyByZXNvbHZlZC5cbiAgLy8gV2UgY2FjaGUgdGhlIHByb21pc2Ugc28gdGhhdCB3ZSBkbyBub3QgcmVwZXRlZGx5IHRyaWdnZXIgdGhlIHVuZGVybHlpbmcgYWN0aW9uLlxuICBtYWtlUmVzb2x2ZWFibGVQcm9taXNlKGlnbm9yZWQpIHsgLy8gQW5zd2VyIGEgUHJvbWlzZSB0aGF0IGNhbiBiZSByZXNvbHZlIHdpdGggdGhlUHJvbWlzZS5yZXNvbHZlKHZhbHVlKS5cbiAgICAvLyBUaGUgaWdub3JlZCBhcmd1bWVudCBpcyBhIGNvbnZlbmllbnQgcGxhY2UgdG8gY2FsbCBzb21ldGhpbmcgZm9yIHNpZGUtZWZmZWN0LlxuICAgIGxldCByZXNvbHZlcjtcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiByZXNvbHZlciA9IHJlc29sdmUpO1xuICAgIHByb21pc2UucmVzb2x2ZSA9IHJlc29sdmVyO1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG5cbiAgYXN5bmMgdmVyc2lvbnMobWluLCBtYXgpIHsgLy8gT24gcmVjZWl2aW5nIHRoZSB2ZXJzaW9ucyBzdXBwb3J0ZWQgYnkgdGhlIHRoZSBwZWVyLCByZXNvbHZlIHRoZSB2ZXJzaW9uIHByb21pc2UuXG4gICAgbGV0IHZlcnNpb25Qcm9taXNlID0gdGhpcy52ZXJzaW9uO1xuICAgIGNvbnN0IGNvbWJpbmVkTWF4ID0gTWF0aC5taW4obWF4LCB0aGlzLm1heFZlcnNpb24pO1xuICAgIGNvbnN0IGNvbWJpbmVkTWluID0gTWF0aC5tYXgobWluLCB0aGlzLm1pblZlcnNpb24pO1xuICAgIGlmIChjb21iaW5lZE1heCA+PSBjb21iaW5lZE1pbikgcmV0dXJuIHZlcnNpb25Qcm9taXNlLnJlc29sdmUoY29tYmluZWRNYXgpOyAvLyBObyBuZWVkIHRvIHJlc3BvbmQsIGFzIHRoZXkgd2lsbCBwcm9kdWNlIHRoZSBzYW1lIGRldGVybWluaXN0aWMgYW5zd2VyLlxuICAgIHJldHVybiB2ZXJzaW9uUHJvbWlzZS5yZXNvbHZlKDApO1xuICB9XG4gIGdldCB2ZXJzaW9uKCkgeyAvLyBQcm9taXNlIHRoZSBoaWdoZXN0IHZlcnNpb24gc3Vwb3J0ZWQgYnkgYm90aCBzaWRlcywgb3IgZGlzY29ubmVjdCBhbmQgZmFsc3kgaWYgbm9uZS5cbiAgICAvLyBUZWxscyB0aGUgb3RoZXIgc2lkZSBvdXIgdmVyc2lvbnMgaWYgd2UgaGF2ZW4ndCB5ZXQgZG9uZSBzby5cbiAgICAvLyBGSVhNRTogY2FuIHdlIGF2b2lkIHRoaXMgdGltZW91dD9cbiAgICByZXR1cm4gdGhpcy5fdmVyc2lvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHNldFRpbWVvdXQoKCkgPT4gdGhpcy5zZW5kKCd2ZXJzaW9ucycsIHRoaXMubWluVmVyc2lvbiwgdGhpcy5tYXhWZXJzaW9uKSwgMjAwKSk7XG4gIH1cblxuICBnZXQgc3RhcnRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gd2UgaGF2ZSBzdGFydGVkIHN5bmNocm9uaXphdGlvbi5cbiAgICByZXR1cm4gdGhpcy5fc3RhcnRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5zdGFydFN5bmNocm9uaXphdGlvbigpO1xuICB9XG4gIGdldCBjb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbnVtYmVyIG9mIGl0ZW1zIHRoYXQgd2VyZSB0cmFuc2ZlcnJlZCAobm90IG5lY2Vzc2FyaWxseSB3cml0dGVuKS5cbiAgICAvLyBTdGFydHMgc3luY2hyb25pemF0aW9uIGlmIGl0IGhhc24ndCBhbHJlYWR5LiBFLmcuLCB3YWl0aW5nIG9uIGNvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB3b24ndCByZXNvbHZlIHVudGlsIGFmdGVyIGl0IHN0YXJ0cy5cbiAgICByZXR1cm4gdGhpcy5fY29tcGxldGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UodGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uKTtcbiAgfVxuICBnZXQgcGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBudW1iZXIgb2YgaXRlbXMgdGhhdCB0aGUgcGVlciBzeW5jaHJvbml6ZWQuXG4gICAgcmV0dXJuIHRoaXMuX3BlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpO1xuICB9XG4gIGdldCBib3RoU2lkZXNDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgcmVzb2x2ZXMgdHJ1dGh5IHdoZW4gYm90aCBzaWRlcyBhcmUgZG9uZS5cbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24udGhlbigoKSA9PiB0aGlzLnBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24pO1xuICB9XG4gIGFzeW5jIHJlcG9ydENvbm5lY3Rpb24oKSB7IC8vIExvZyBjb25uZWN0aW9uIHRpbWUgYW5kIHR5cGUuXG4gICAgY29uc3Qgc3RhdHMgPSBhd2FpdCB0aGlzLmNvbm5lY3Rpb24ucGVlci5nZXRTdGF0cygpO1xuICAgIGxldCB0cmFuc3BvcnQ7XG4gICAgZm9yIChjb25zdCByZXBvcnQgb2Ygc3RhdHMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChyZXBvcnQudHlwZSA9PT0gJ3RyYW5zcG9ydCcpIHtcblx0dHJhbnNwb3J0ID0gcmVwb3J0O1xuXHRicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgbGV0IGNhbmRpZGF0ZVBhaXIgPSB0cmFuc3BvcnQgJiYgc3RhdHMuZ2V0KHRyYW5zcG9ydC5zZWxlY3RlZENhbmRpZGF0ZVBhaXJJZCk7XG4gICAgaWYgKCFjYW5kaWRhdGVQYWlyKSB7IC8vIFNhZmFyaSBkb2Vzbid0IGZvbGxvdyB0aGUgc3RhbmRhcmQuXG4gICAgICBmb3IgKGNvbnN0IHJlcG9ydCBvZiBzdGF0cy52YWx1ZXMoKSkge1xuXHRpZiAoKHJlcG9ydC50eXBlID09PSAnY2FuZGlkYXRlLXBhaXInKSAmJiByZXBvcnQuc2VsZWN0ZWQpIHtcblx0ICBjYW5kaWRhdGVQYWlyID0gcmVwb3J0O1xuXHQgIGJyZWFrO1xuXHR9XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghY2FuZGlkYXRlUGFpcikge1xuICAgICAgY29uc29sZS53YXJuKHRoaXMubGFiZWwsICdnb3Qgc3RhdHMgd2l0aG91dCBjYW5kaWRhdGVQYWlyJywgQXJyYXkuZnJvbShzdGF0cy52YWx1ZXMoKSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZW1vdGUgPSBzdGF0cy5nZXQoY2FuZGlkYXRlUGFpci5yZW1vdGVDYW5kaWRhdGVJZCk7XG4gICAgY29uc3Qge3Byb3RvY29sLCBjYW5kaWRhdGVUeXBlfSA9IHJlbW90ZTtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge3N0YXRzLCB0cmFuc3BvcnQsIGNhbmRpZGF0ZVBhaXIsIHJlbW90ZSwgcHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGUsIHN5bmNocm9uaXphdGlvblN0YXJ0VGltZTogbm93fSk7XG4gICAgY29uc29sZS5pbmZvKHRoaXMubGFiZWwsICdjb25uZWN0ZWQnLCBwcm90b2NvbCwgY2FuZGlkYXRlVHlwZSwgKChub3cgLSB0aGlzLmNvbm5lY3Rpb25TdGFydFRpbWUpLzFlMykudG9GaXhlZCgxKSk7XG4gIH1cbiAgYXN5bmMgc3RhcnRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFdhaXQgZm9yIGFsbCBwcmVsaW1pbmFyaWVzLCBhbmQgc3RhcnQgc3RyZWFtaW5nIG91ciB0YWdzLlxuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgaWYgKCFkYXRhQ2hhbm5lbCkgdGhyb3cgbmV3IEVycm9yKGBObyBjb25uZWN0aW9uIGZvciAke3RoaXMubGFiZWx9LmApO1xuICAgIC8vIE5vdyB0aGF0IHdlIGFyZSBjb25uZWN0ZWQsIGFueSBuZXcgd3JpdGVzIG9uIG91ciBlbmQgd2lsbCBiZSBwdXNoZWQgdG8gdGhlIHBlZXIuIFNvIGNhcHR1cmUgdGhlIGluaXRpYWwgdGFncyBub3cuXG4gICAgY29uc3Qgb3VyVGFncyA9IG5ldyBTZXQoYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnRhZ3MpO1xuICAgIGF3YWl0IHRoaXMucmVwb3J0Q29ubmVjdGlvbigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge1xuXG4gICAgICAvLyBBIHNuYXBzaG90IFNldCBvZiBlYWNoIHRhZyB3ZSBoYXZlIGxvY2FsbHksIGNhcHR1cmVkIGF0IHRoZSBtb21lbnQgb2YgY3JlYXRpb24uXG4gICAgICBvdXJUYWdzLCAvLyAoTmV3IGxvY2FsIHdyaXRlcyBhcmUgcHVzaGVkIHRvIHRoZSBjb25uZWN0ZWQgcGVlciwgZXZlbiBkdXJpbmcgc3luY2hyb25pemF0aW9uLilcblxuICAgICAgLy8gTWFwIG9mIHRhZyB0byBwcm9taXNlIGZvciB0YWdzIHRoYXQgYXJlIGJlaW5nIHN5bmNocm9uaXplZC5cbiAgICAgIC8vIGVuc3VyZVN5bmNocm9uaXplZFRhZyBlbnN1cmVzIHRoYXQgdGhlcmUgaXMgYW4gZW50cnkgaGVyZSBkdXJpbmcgdGhlIHRpbWUgYSB0YWcgaXMgaW4gZmxpZ2h0LlxuICAgICAgdW5zeW5jaHJvbml6ZWQ6IG5ldyBNYXAoKSxcblxuICAgICAgLy8gU2V0IG9mIHdoYXQgdGFncyBoYXZlIGJlZW4gZXhwbGljaXRseSBzeW5jaHJvbml6ZWQsIG1lYW5pbmcgdGhhdCB0aGVyZSBpcyBhIGRpZmZlcmVuY2UgYmV0d2VlbiB0aGVpciBoYXNoXG4gICAgICAvLyBhbmQgb3Vycywgc3VjaCB0aGF0IHdlIGFzayBmb3IgdGhlaXIgc2lnbmF0dXJlIHRvIGNvbXBhcmUgaW4gZGV0YWlsLiBUaHVzIHRoaXMgc2V0IG1heSBpbmNsdWRlIGl0ZW1zIHRoYXRcbiAgICAgIGNoZWNrZWRUYWdzOiBuZXcgU2V0KCksIC8vIHdpbGwgbm90IGVuZCB1cCBiZWluZyByZXBsYWNlZCBvbiBvdXIgZW5kLlxuXG4gICAgICBlbmRPZlBlZXJUYWdzOiBmYWxzZSAvLyBJcyB0aGUgcGVlciBmaW5pc2hlZCBzdHJlYW1pbmc/XG4gICAgfSk7XG4gICAgLy8gTm93IG5lZ290aWF0ZSB2ZXJzaW9uIGFuZCBjb2xsZWN0cyB0aGUgdGFncy5cbiAgICBjb25zdCB2ZXJzaW9uID0gYXdhaXQgdGhpcy52ZXJzaW9uO1xuICAgIGNvbnN0IHttaW5WZXJzaW9uLCBtYXhWZXJzaW9ufSA9IHRoaXM7XG4gICAgaWYgKCF2ZXJzaW9uKSB7XG4gICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3QoKTtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBgVGhpcyBzb2Z0d2FyZSBleHBlY3RzIGRhdGEgdmVyc2lvbnMgZnJvbSAke21pblZlcnNpb259IHRvICR7bWF4VmVyc2lvbn0uIFRyeSByZWxvYWRpbmcgdHdpY2UuYDtcbiAgICAgIGlmICh0eXBlb2Yod2luZG93KSAhPT0gJ3VuZGVmaW5lZCcpIHdpbmRvdy5hbGVydChtZXNzYWdlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5zdHJlYW1UYWdzKG91clRhZ3MpOyAvLyBCdXQgZG8gbm90IHdhaXQgZm9yIGl0LlxuICB9XG4gIGFzeW5jIGNvbXB1dGVIYXNoKHRleHQpIHsgLy8gT3VyIHN0YW5kYXJkIGhhc2guIChTdHJpbmcgc28gdGhhdCBpdCBpcyBzZXJpYWxpemFibGUuKVxuICAgIGNvbnN0IGhhc2ggPSBhd2FpdCBDcmVkZW50aWFscy5oYXNoVGV4dCh0ZXh0KTtcbiAgICByZXR1cm4gQ3JlZGVudGlhbHMuZW5jb2RlQmFzZTY0dXJsKGhhc2gpO1xuICB9XG4gIGFzeW5jIGdldEhhc2godGFnKSB7IC8vIFdob2xlIHNpZ25hdHVyZSAoTk9UIHByb3RlY3RlZEhlYWRlci5zdWIgb2YgY29udGVudCkuXG4gICAgY29uc3QgcmF3ID0gYXdhaXQgdGhpcy5jb2xsZWN0aW9uLmdldCh0YWcpO1xuICAgIHJldHVybiB0aGlzLmNvbXB1dGVIYXNoKHJhdyB8fCAnbWlzc2luZycpO1xuICB9XG4gIGFzeW5jIHN0cmVhbVRhZ3ModGFncykgeyAvLyBTZW5kIGVhY2ggb2Ygb3VyIGtub3duIHRhZy9oYXNoIHBhaXJzIHRvIHBlZXIsIG9uZSBhdCBhIHRpbWUsIGZvbGxvd2VkIGJ5IGVuZE9mVGFncy5cbiAgICBmb3IgKGNvbnN0IHRhZyBvZiB0YWdzKSB7XG4gICAgICB0aGlzLnNlbmQoJ2hhc2gnLCB0YWcsIGF3YWl0IHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgICB9XG4gICAgdGhpcy5zZW5kKCdlbmRUYWdzJyk7XG4gIH1cbiAgYXN5bmMgZW5kVGFncygpIHsgLy8gVGhlIHBlZXIgaGFzIGZpbmlzaGVkIHN0cmVhbVRhZ3MoKS5cbiAgICBhd2FpdCB0aGlzLnN0YXJ0ZWRTeW5jaHJvbml6YXRpb247XG4gICAgdGhpcy5lbmRPZlBlZXJUYWdzID0gdHJ1ZTtcbiAgICB0aGlzLmNsZWFuVXBJZkZpbmlzaGVkKCk7XG4gIH1cbiAgc3luY2hyb25pemF0aW9uQ29tcGxldGUobkNoZWNrZWQpIHsgLy8gVGhlIHBlZXIgaGFzIGZpbmlzaGVkIGdldHRpbmcgYWxsIHRoZSBkYXRhIGl0IG5lZWRzIGZyb20gdXMuXG4gICAgdGhpcy5wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uLnJlc29sdmUobkNoZWNrZWQpO1xuICB9XG4gIGNsZWFuVXBJZkZpbmlzaGVkKCkgeyAvLyBJZiB3ZSBhcmUgbm90IHdhaXRpbmcgZm9yIGFueXRoaW5nLCB3ZSdyZSBkb25lLiBDbGVhbiB1cC5cbiAgICAvLyBUaGlzIHJlcXVpcmVzIHRoYXQgdGhlIHBlZXIgaGFzIGluZGljYXRlZCB0aGF0IGl0IGlzIGZpbmlzaGVkIHN0cmVhbWluZyB0YWdzLFxuICAgIC8vIGFuZCB0aGF0IHdlIGFyZSBub3Qgd2FpdGluZyBmb3IgYW55IGZ1cnRoZXIgdW5zeW5jaHJvbml6ZWQgaXRlbXMuXG4gICAgaWYgKCF0aGlzLmVuZE9mUGVlclRhZ3MgfHwgdGhpcy51bnN5bmNocm9uaXplZC5zaXplKSByZXR1cm47XG4gICAgY29uc3QgbkNoZWNrZWQgPSB0aGlzLmNoZWNrZWRUYWdzLnNpemU7IC8vIFRoZSBudW1iZXIgdGhhdCB3ZSBjaGVja2VkLlxuICAgIHRoaXMuc2VuZCgnc3luY2hyb25pemF0aW9uQ29tcGxldGUnLCBuQ2hlY2tlZCk7XG4gICAgdGhpcy5jaGVja2VkVGFncy5jbGVhcigpO1xuICAgIHRoaXMudW5zeW5jaHJvbml6ZWQuY2xlYXIoKTtcbiAgICB0aGlzLm91clRhZ3MgPSB0aGlzLnN5bmNocm9uaXplZCA9IHRoaXMudW5zeW5jaHJvbml6ZWQgPSBudWxsO1xuICAgIGNvbnNvbGUuaW5mbyh0aGlzLmxhYmVsLCAnY29tcGxldGVkIHN5bmNocm9uaXphdGlvbicsIG5DaGVja2VkLCAnaXRlbXMgaW4nLCAoKERhdGUubm93KCkgLSB0aGlzLnN5bmNocm9uaXphdGlvblN0YXJ0VGltZSkvMWUzKS50b0ZpeGVkKDEpLCAnc2Vjb25kcycpO1xuICAgIHRoaXMuY29tcGxldGVkU3luY2hyb25pemF0aW9uLnJlc29sdmUobkNoZWNrZWQpO1xuICB9XG4gIHN5bmNocm9uaXphdGlvblByb21pc2UodGFnKSB7IC8vIFJldHVybiBzb21ldGhpbmcgdG8gYXdhaXQgdGhhdCByZXNvbHZlcyB3aGVuIHRhZyBpcyBzeW5jaHJvbml6ZWQuXG4gICAgLy8gV2hlbmV2ZXIgYSBjb2xsZWN0aW9uIG5lZWRzIHRvIHJldHJpZXZlIChnZXRWZXJpZmllZCkgYSB0YWcgb3IgZmluZCB0YWdzIG1hdGNoaW5nIHByb3BlcnRpZXMsIGl0IGVuc3VyZXNcbiAgICAvLyB0aGUgbGF0ZXN0IGRhdGEgYnkgY2FsbGluZyB0aGlzIGFuZCBhd2FpdGluZyB0aGUgZGF0YS5cbiAgICBpZiAoIXRoaXMudW5zeW5jaHJvbml6ZWQpIHJldHVybiB0cnVlOyAvLyBXZSBhcmUgZnVsbHkgc3luY2hyb25pemVkIGFsbCB0YWdzLiBJZiB0aGVyZSBpcyBuZXcgZGF0YSwgaXQgd2lsbCBiZSBzcG9udGFuZW91c2x5IHB1c2hlZCB0byB1cy5cbiAgICBpZiAodGhpcy5jaGVja2VkVGFncy5oYXModGFnKSkgcmV0dXJuIHRydWU7IC8vIFRoaXMgcGFydGljdWxhciB0YWcgaGFzIGJlZW4gY2hlY2tlZC5cbiAgICAgIC8vIChJZiBjaGVja2VkVGFncyB3YXMgb25seSB0aG9zZSBleGNoYW5nZWQgb3Igd3JpdHRlbiwgd2Ugd291bGQgaGF2ZSBleHRyYSBmbGlnaHRzIGNoZWNraW5nLilcbiAgICAvLyBJZiBhIHJlcXVlc3QgaXMgaW4gZmxpZ2h0LCByZXR1cm4gdGhhdCBwcm9taXNlLiBPdGhlcndpc2UgY3JlYXRlIG9uZS5cbiAgICByZXR1cm4gdGhpcy51bnN5bmNocm9uaXplZC5nZXQodGFnKSB8fCB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsICcnLCB0aGlzLmdldEhhc2godGFnKSk7XG4gIH1cblxuICBhc3luYyBoYXNoKHRhZywgaGFzaCkgeyAvLyBSZWNlaXZlIGEgW3RhZywgaGFzaF0gdGhhdCB0aGUgcGVlciBrbm93cyBhYm91dC4gKFBlZXIgc3RyZWFtcyB6ZXJvIG9yIG1vcmUgb2YgdGhlc2UgdG8gdXMuKVxuICAgIC8vIFVubGVzcyBhbHJlYWR5IGluIGZsaWdodCwgd2Ugd2lsbCBlbnN1cmVTeW5jaHJvbml6ZWRUYWcgdG8gc3luY2hyb25pemUgaXQuXG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIGNvbnN0IHtvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0gPSB0aGlzO1xuICAgIHRoaXMubG9nKCdyZWNlaXZlZCBcImhhc2hcIicsIHt0YWcsIGhhc2gsIG91clRhZ3MsIHVuc3luY2hyb25pemVkfSk7XG4gICAgaWYgKHVuc3luY2hyb25pemVkLmhhcyh0YWcpKSByZXR1cm4gbnVsbDsgLy8gQWxyZWFkeSBoYXMgYW4gaW52ZXN0aWdhdGlvbiBpbiBwcm9ncmVzcyAoZS5nLCBkdWUgdG8gbG9jYWwgYXBwIHN5bmNocm9uaXphdGlvblByb21pc2UpLlxuICAgIGlmICghb3VyVGFncy5oYXModGFnKSkgcmV0dXJuIHRoaXMuZW5zdXJlU3luY2hyb25pemVkVGFnKHRhZywgaGFzaCk7IC8vIFdlIGRvbid0IGhhdmUgdGhlIHJlY29yZCBhdCBhbGwuXG4gICAgcmV0dXJuIHRoaXMuZW5zdXJlU3luY2hyb25pemVkVGFnKHRhZywgaGFzaCwgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG4gIGVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIHRoZWlySGFzaCA9ICcnLCBvdXJIYXNoUHJvbWlzZSA9IG51bGwpIHtcbiAgICAvLyBTeW5jaHJvbm91c2x5IHJlY29yZCAoaW4gdGhlIHVuc3luY2hyb25pemVkIG1hcCkgYSBwcm9taXNlIHRvIChjb25jZXB0dWFsbHkpIHJlcXVlc3QgdGhlIHRhZyBmcm9tIHRoZSBwZWVyLFxuICAgIC8vIHB1dCBpdCBpbiB0aGUgY29sbGVjdGlvbiwgYW5kIGNsZWFudXAgdGhlIGJvb2trZWVwaW5nLiBSZXR1cm4gdGhhdCBwcm9taXNlLlxuICAgIC8vIEhvd2V2ZXIsIGlmIHdlIGFyZSBnaXZlbiBoYXNoZXMgdG8gY29tcGFyZSBhbmQgdGhleSBtYXRjaCwgd2UgY2FuIHNraXAgdGhlIHJlcXVlc3QvcHV0IGFuZCByZW1vdmUgZnJvbSB1bnN5Y2hyb25pemVkIG9uIG5leHQgdGljay5cbiAgICAvLyAoVGhpcyBtdXN0IHJldHVybiBhdG9taWNhbGx5IGJlY2F1c2UgY2FsbGVyIGhhcyBjaGVja2VkIHZhcmlvdXMgYm9va2tlZXBpbmcgYXQgdGhhdCBtb21lbnQuIENoZWNraW5nIG1heSByZXF1aXJlIHRoYXQgd2UgYXdhaXQgb3VySGFzaFByb21pc2UuKVxuICAgIGNvbnN0IHByb21pc2UgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHNldFRpbWVvdXQoYXN5bmMgKCkgPT4geyAvLyBOZXh0IHRpY2suIFNlZSByZXF1ZXN0KCkuXG5cdGlmICghdGhlaXJIYXNoIHx8ICFvdXJIYXNoUHJvbWlzZSB8fCAodGhlaXJIYXNoICE9PSBhd2FpdCBvdXJIYXNoUHJvbWlzZSkpIHtcblx0ICBjb25zdCB0aGVpckRhdGEgPSBhd2FpdCB0aGlzLnJlcXVlc3QodGFnKTtcblx0ICAvLyBNaWdodCBoYXZlIGJlZW4gdHJpZ2dlcmVkIGJ5IG91ciBhcHAgcmVxdWVzdGluZyB0aGlzIHRhZyBiZWZvcmUgd2Ugd2VyZSBzeW5jJ2QuIFNvIHRoZXkgbWlnaHQgbm90IGhhdmUgdGhlIGRhdGEuXG5cdCAgaWYgKCF0aGVpckhhc2ggfHwgdGhlaXJEYXRhPy5sZW5ndGgpIHtcblx0ICAgIGlmIChhd2FpdCB0aGlzLmNvbGxlY3Rpb24ucHV0KHRhZywgdGhlaXJEYXRhLCB0aGlzKSkge1xuXHQgICAgICB0aGlzLmxvZygncmVjZWl2ZWQvcHV0JywgdGFnLCAndGhlaXIvb3VyIGhhc2g6JywgdGhlaXJIYXNoIHx8ICdtaXNzaW5nVGhlaXJzJywgKGF3YWl0IG91ckhhc2hQcm9taXNlKSB8fCAnbWlzc2luZ091cnMnLCB0aGVpckRhdGE/Lmxlbmd0aCk7XG5cdCAgICB9IGVsc2Uge1xuXHQgICAgICB0aGlzLmxvZygndW5hYmxlIHRvIHB1dCcsIHRhZyk7XG5cdCAgICB9XG5cdCAgfVxuXHR9XG5cdHRoaXMuY2hlY2tlZFRhZ3MuYWRkKHRhZyk7ICAgICAgIC8vIEV2ZXJ5dGhpbmcgd2UndmUgZXhhbWluZWQsIHJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB3ZSBhc2tlZCBmb3Igb3Igc2F2ZWQgZGF0YSBmcm9tIHBlZXIuIChTZWUgc3luY2hyb25pemF0aW9uUHJvbWlzZSlcblx0dGhpcy51bnN5bmNocm9uaXplZC5kZWxldGUodGFnKTsgLy8gVW5jb25kaXRpb25hbGx5LCBiZWNhdXNlIHdlIHNldCBpdCB1bmNvbmRpdGlvbmFsbHkuXG5cdHRoaXMuY2xlYW5VcElmRmluaXNoZWQoKTtcblx0cmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gICAgdGhpcy51bnN5bmNocm9uaXplZC5zZXQodGFnLCBwcm9taXNlKTsgLy8gVW5jb25kaXRpb25hbGx5LCBpbiBjYXNlIHdlIG5lZWQgdG8ga25vdyB3ZSdyZSBsb29raW5nIGR1cmluZyB0aGUgdGltZSB3ZSdyZSBsb29raW5nLlxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIHJlcXVlc3QodGFnKSB7IC8vIE1ha2UgYSByZXF1ZXN0IGZvciB0YWcgZnJvbSB0aGUgcGVlciwgYW5kIGFuc3dlciBhIHByb21pc2UgdGhlIHJlc29sdmVzIHdpdGggdGhlIGRhdGEuXG4gICAgLypjb25zdCB7IGhvc3RSZXF1ZXN0QmFzZSB9ID0gdGhpcztcbiAgICBpZiAoaG9zdFJlcXVlc3RCYXNlKSB7XG4gICAgICAvLyBFLmcuLCBhIGxvY2FsaG9zdCByb3V0ZXIgbWlnaHQgc3VwcG9ydCBhIGdldCBvZiBodHRwOi8vbG9jYWxob3N0OjMwMDAvZmxleHN0b3JlL011dGFibGVDb2xsZWN0aW9uL2NvbS5raTFyMHkud2hhdGV2ZXIvX3QvdUwvQkFjV19MTkFKYS9jSldtdW1ibGVcbiAgICAgIC8vIFNvIGhvc3RSZXF1ZXN0QmFzZSBzaG91bGQgYmUgXCJodHRwOi8vbG9jYWxob3N0OjMwMDAvZmxleHN0b3JlL011dGFibGVDb2xsZWN0aW9uL2NvbS5raTFyMHkud2hhdGV2ZXJcIixcbiAgICAgIC8vIGFuZCBzZXJ2aWNlTmFtZSBzaG91bGQgYmUgc29tZXRoaW5nIGxpa2UgXCJodHRwOi8vbG9jYWxob3N0OjMwMDAvZmxleHN0b3JlL3N5bmNcIlxuICAgICAgcmV0dXJuIGZldGNoKHRhZ1BhdGgoaG9zdFJlcXVlc3RCYXNlLCB0YWcpKS50aGVuKHJlc3BvbnNlID0+IHJlc3BvbnNlLnRleHQoKSk7XG4gICAgfSovXG4gICAgY29uc3QgcHJvbWlzZSA9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSh0aGlzLnNlbmQoJ2dldCcsIHRhZykpO1xuICAgIC8vIFN1YnRsZTogV2hlbiB0aGUgJ3B1dCcgY29tZXMgYmFjaywgd2Ugd2lsbCBuZWVkIHRvIHJlc29sdmUgdGhpcyBwcm9taXNlLiBCdXQgaG93IHdpbGwgJ3B1dCcgZmluZCB0aGUgcHJvbWlzZSB0byByZXNvbHZlIGl0P1xuICAgIC8vIEFzIGl0IHR1cm5zIG91dCwgdG8gZ2V0IGhlcmUsIHdlIGhhdmUgbmVjZXNzYXJpbGx5IHNldCB0YWcgaW4gdGhlIHVuc3luY2hyb25pemVkIG1hcC4gXG4gICAgY29uc3Qgbm90ZWQgPSB0aGlzLnVuc3luY2hyb25pemVkLmdldCh0YWcpOyAvLyBBIHByb21pc2UgdGhhdCBkb2VzIG5vdCBoYXZlIGFuIGV4cG9zZWQgLnJlc29sdmUsIGFuZCB3aGljaCBkb2VzIG5vdCBleHBlY3QgYW55IHZhbHVlLlxuICAgIG5vdGVkLnJlc29sdmUgPSBwcm9taXNlLnJlc29sdmU7IC8vIFRhY2sgb24gYSByZXNvbHZlIGZvciBPVVIgcHJvbWlzZSBvbnRvIHRoZSBub3RlZCBvYmplY3QgKHdoaWNoIGNvbmZ1c2luZ2x5LCBoYXBwZW5zIHRvIGJlIGEgcHJvbWlzZSkuXG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgYXN5bmMgZ2V0KHRhZykgeyAvLyBSZXNwb25kIHRvIGEgcGVlcidzIGdldCgpIHJlcXVlc3QgYnkgc2VuZGluZyBhIHB1dCByZXBvbnNlIHdpdGggdGhlIGRhdGEuXG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IHRoaXMuY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgICB0aGlzLnB1c2goJ3B1dCcsIHRhZywgZGF0YSk7XG4gIH1cbiAgcHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKSB7IC8vIFRlbGwgdGhlIG90aGVyIHNpZGUgYWJvdXQgYSBzaWduZWQgd3JpdGUuXG4gICAgdGhpcy5zZW5kKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpO1xuICB9XG4gIGFzeW5jIHB1dCh0YWcsIHNpZ25hdHVyZSkgeyAvLyBSZWNlaXZlIGEgcHV0IG1lc3NhZ2UgZnJvbSB0aGUgcGVlci5cbiAgICAvLyBJZiBpdCBpcyBhIHJlc3BvbnNlIHRvIGEgZ2V0KCkgcmVxdWVzdCwgcmVzb2x2ZSB0aGUgY29ycmVzcG9uZGluZyBwcm9taXNlLlxuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLnVuc3luY2hyb25pemVkPy5nZXQodGFnKTtcbiAgICAvLyBSZWdhcmRsZXNzIG9mIHdoeSB0aGUgb3RoZXIgc2lkZSBpcyBzZW5kaW5nLCBpZiB3ZSBoYXZlIGFuIG91dHN0YW5kaW5nIHJlcXVlc3QsIGNvbXBsZXRlIGl0LlxuICAgIGlmIChwcm9taXNlKSBwcm9taXNlLnJlc29sdmUoc2lnbmF0dXJlKTtcbiAgICBlbHNlIGF3YWl0IHRoaXMuY29sbGVjdGlvbi5wdXQodGFnLCBzaWduYXR1cmUsIHRoaXMpOyAvLyBPdGhlcndpc2UsIGp1c3QgdHJ5IHRvIHdyaXRlIGl0IGxvY2FsbHkuXG4gIH1cbiAgZGVsZXRlKHRhZywgc2lnbmF0dXJlKSB7IC8vIFJlY2VpdmUgYSBkZWxldGUgbWVzc2FnZSBmcm9tIHRoZSBwZWVyLlxuICAgIHRoaXMuY29sbGVjdGlvbi5kZWxldGUodGFnLCBzaWduYXR1cmUsIHRoaXMpO1xuICB9XG59XG5leHBvcnQgZGVmYXVsdCBTeW5jaHJvbml6ZXI7XG4iLCJjbGFzcyBDYWNoZSBleHRlbmRzIE1hcHtjb25zdHJ1Y3RvcihlLHQ9MCl7c3VwZXIoKSx0aGlzLm1heFNpemU9ZSx0aGlzLmRlZmF1bHRUaW1lVG9MaXZlPXQsdGhpcy5fbmV4dFdyaXRlSW5kZXg9MCx0aGlzLl9rZXlMaXN0PUFycmF5KGUpLHRoaXMuX3RpbWVycz1uZXcgTWFwfXNldChlLHQscz10aGlzLmRlZmF1bHRUaW1lVG9MaXZlKXtsZXQgaT10aGlzLl9uZXh0V3JpdGVJbmRleDt0aGlzLmRlbGV0ZSh0aGlzLl9rZXlMaXN0W2ldKSx0aGlzLl9rZXlMaXN0W2ldPWUsdGhpcy5fbmV4dFdyaXRlSW5kZXg9KGkrMSkldGhpcy5tYXhTaXplLHRoaXMuX3RpbWVycy5oYXMoZSkmJmNsZWFyVGltZW91dCh0aGlzLl90aW1lcnMuZ2V0KGUpKSxzdXBlci5zZXQoZSx0KSxzJiZ0aGlzLl90aW1lcnMuc2V0KGUsc2V0VGltZW91dCgoKCk9PnRoaXMuZGVsZXRlKGUpKSxzKSl9ZGVsZXRlKGUpe3JldHVybiB0aGlzLl90aW1lcnMuaGFzKGUpJiZjbGVhclRpbWVvdXQodGhpcy5fdGltZXJzLmdldChlKSksdGhpcy5fdGltZXJzLmRlbGV0ZShlKSxzdXBlci5kZWxldGUoZSl9Y2xlYXIoZT10aGlzLm1heFNpemUpe3RoaXMubWF4U2l6ZT1lLHRoaXMuX2tleUxpc3Q9QXJyYXkoZSksdGhpcy5fbmV4dFdyaXRlSW5kZXg9MCxzdXBlci5jbGVhcigpO2Zvcihjb25zdCBlIG9mIHRoaXMuX3RpbWVycy52YWx1ZXMoKSljbGVhclRpbWVvdXQoZSk7dGhpcy5fdGltZXJzLmNsZWFyKCl9fWNsYXNzIFN0b3JhZ2VCYXNle2NvbnN0cnVjdG9yKHtuYW1lOmUsYmFzZU5hbWU6dD1cIlN0b3JhZ2VcIixtYXhTZXJpYWxpemVyU2l6ZTpzPTFlMyxkZWJ1ZzppPSExfSl7Y29uc3QgYT1gJHt0fS8ke2V9YCxyPW5ldyBDYWNoZShzKTtPYmplY3QuYXNzaWduKHRoaXMse25hbWU6ZSxiYXNlTmFtZTp0LGZ1bGxOYW1lOmEsZGVidWc6aSxzZXJpYWxpemVyOnJ9KX1hc3luYyBsaXN0KCl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKFwiXCIsKChlLHQpPT50aGlzLmxpc3RJbnRlcm5hbCh0LGUpKSl9YXN5bmMgZ2V0KGUpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSx0KT0+dGhpcy5nZXRJbnRlcm5hbCh0LGUpKSl9YXN5bmMgZGVsZXRlKGUpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSx0KT0+dGhpcy5kZWxldGVJbnRlcm5hbCh0LGUpKSl9YXN5bmMgcHV0KGUsdCl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKGUsKChlLHMpPT50aGlzLnB1dEludGVybmFsKHMsdCxlKSkpfWxvZyguLi5lKXt0aGlzLmRlYnVnJiZjb25zb2xlLmxvZyh0aGlzLm5hbWUsLi4uZSl9YXN5bmMgc2VyaWFsaXplKGUsdCl7Y29uc3R7c2VyaWFsaXplcjpzLHJlYWR5Oml9PXRoaXM7bGV0IGE9cy5nZXQoZSl8fGk7cmV0dXJuIGE9YS50aGVuKChhc3luYygpPT50KGF3YWl0IHRoaXMucmVhZHksdGhpcy5wYXRoKGUpKSkpLHMuc2V0KGUsYSksYXdhaXQgYX19Y29uc3R7UmVzcG9uc2U6ZSxVUkw6dH09Z2xvYmFsVGhpcztjbGFzcyBTdG9yYWdlQ2FjaGUgZXh0ZW5kcyBTdG9yYWdlQmFzZXtjb25zdHJ1Y3RvciguLi5lKXtzdXBlciguLi5lKSx0aGlzLnN0cmlwcGVyPW5ldyBSZWdFeHAoYF4vJHt0aGlzLmZ1bGxOYW1lfS9gKSx0aGlzLnJlYWR5PWNhY2hlcy5vcGVuKHRoaXMuZnVsbE5hbWUpfWFzeW5jIGxpc3RJbnRlcm5hbChlLHQpe3JldHVybihhd2FpdCB0LmtleXMoKXx8W10pLm1hcCgoZT0+dGhpcy50YWcoZS51cmwpKSl9YXN5bmMgZ2V0SW50ZXJuYWwoZSx0KXtjb25zdCBzPWF3YWl0IHQubWF0Y2goZSk7cmV0dXJuIHM/Lmpzb24oKX1kZWxldGVJbnRlcm5hbChlLHQpe3JldHVybiB0LmRlbGV0ZShlKX1wdXRJbnRlcm5hbCh0LHMsaSl7cmV0dXJuIGkucHV0KHQsZS5qc29uKHMpKX1wYXRoKGUpe3JldHVybmAvJHt0aGlzLmZ1bGxOYW1lfS8ke2V9YH10YWcoZSl7cmV0dXJuIG5ldyB0KGUpLnBhdGhuYW1lLnJlcGxhY2UodGhpcy5zdHJpcHBlcixcIlwiKX1kZXN0cm95KCl7cmV0dXJuIGNhY2hlcy5kZWxldGUodGhpcy5mdWxsTmFtZSl9fWV4cG9ydHtTdG9yYWdlQ2FjaGUgYXMgU3RvcmFnZUxvY2FsLFN0b3JhZ2VDYWNoZSBhcyBkZWZhdWx0fTtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB7IFN0b3JhZ2VMb2NhbCB9IGZyb20gJ0BraTFyMHkvc3RvcmFnZSc7XG5pbXBvcnQgU3luY2hyb25pemVyIGZyb20gJy4vc3luY2hyb25pemVyLm1qcyc7XG5pbXBvcnQgeyBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24gfSBmcm9tICcuL3ZlcnNpb24ubWpzJztcbmNvbnN0IHsgQ3VzdG9tRXZlbnQsIEV2ZW50VGFyZ2V0LCBUZXh0RGVjb2RlciB9ID0gZ2xvYmFsVGhpcztcblxuZXhwb3J0IGNsYXNzIENvbGxlY3Rpb24gZXh0ZW5kcyBFdmVudFRhcmdldCB7XG5cbiAgY29uc3RydWN0b3Ioe25hbWUsIGxhYmVsID0gbmFtZSwgc2VydmljZXMgPSBbXSwgcHJlc2VydmVEZWxldGlvbnMgPSAhIXNlcnZpY2VzLmxlbmd0aCxcblx0ICAgICAgIHBlcnNpc3RlbmNlQ2xhc3MgPSBTdG9yYWdlTG9jYWwsIGRiVmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uLCBwZXJzaXN0ZW5jZUJhc2UgPSBgJHtzdG9yYWdlTmFtZX1fJHtkYlZlcnNpb259YCxcblx0ICAgICAgIGRlYnVnID0gZmFsc2UsIG11bHRpcGxleCwgLy8gQ2F1c2VzIHN5bmNocm9uaXphdGlvbiB0byByZXVzZSBjb25uZWN0aW9ucyBmb3IgZGlmZmVyZW50IENvbGxlY3Rpb25zIG9uIHRoZSBzYW1lIHNlcnZpY2UuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsfSkge1xuICAgIHN1cGVyKCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7bmFtZSwgbGFiZWwsIHByZXNlcnZlRGVsZXRpb25zLCBwZXJzaXN0ZW5jZUNsYXNzLCBkYlZlcnNpb24sIG11bHRpcGxleCwgZGVidWcsIGNoYW5uZWxOYW1lLCBzZXJ2aWNlTGFiZWwsXG5cdFx0XHQgZnVsbE5hbWU6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtuYW1lfWAsIGZ1bGxMYWJlbDogYCR7dGhpcy5jb25zdHJ1Y3Rvci5uYW1lfS8ke2xhYmVsfWB9KTtcbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTtcbiAgICBjb25zdCBwZXJzaXN0ZW5jZU9wdGlvbnMgPSB7bmFtZTogdGhpcy5mdWxsTGFiZWwsIGJhc2VOYW1lOiBwZXJzaXN0ZW5jZUJhc2UsIGRlYnVnOiBkZWJ1Z307XG4gICAgaWYgKHBlcnNpc3RlbmNlQ2xhc3MudGhlbikgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gcGVyc2lzdGVuY2VDbGFzcy50aGVuKGtpbmQgPT4gbmV3IGtpbmQocGVyc2lzdGVuY2VPcHRpb25zKSk7XG4gICAgZWxzZSB0aGlzLnBlcnNpc3RlbmNlU3RvcmUgPSBuZXcgcGVyc2lzdGVuY2VDbGFzcyhwZXJzaXN0ZW5jZU9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgY2xvc2UoKSB7XG4gICAgYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmRlc3Ryb3koKTtcbiAgfVxuXG4gIHN0YXRpYyBlcnJvcihlcnJvcikgeyAvLyBDYW4gYmUgb3ZlcnJpZGRlbiBieSB0aGUgY2xpZW50XG4gICAgY29uc29sZS5lcnJvcihlcnJvcik7XG4gIH1cbiAgLy8gQ3JlZGVudGlhbHMuc2lnbi8udmVyaWZ5IGNhbiBwcm9kdWNlL2FjY2VwdCBKU09OIE9CSkVDVFMgZm9yIHRoZSBuYW1lZCBcIkpTT04gU2VyaWFsaXphdGlvblwiIGZvcm0uXG4gIC8vIEFzIGl0IGhhcHBlbnMsIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGNhbiBkaXN0aW5ndWlzaCBiZXR3ZWVuIGEgY29tcGFjdCBzZXJpYWxpemF0aW9uIChiYXNlNjQgdGV4dClcbiAgLy8gdnMgYW4gb2JqZWN0LCBidXQgaXQgZG9lcyBub3QgcmVjb2duaXplIGEgU0VSSUFMSVpFRCBvYmplY3QuIEhlcmUgd2UgYm90dGxlbmVjayB0aG9zZSBvcGVyYXRpb25zXG4gIC8vIHN1Y2ggdGhhdCB0aGUgdGhpbmcgdGhhdCBpcyBhY3R1YWxseSBwZXJzaXN0ZWQgYW5kIHN5bmNocm9uaXplZCBpcyBhbHdheXMgYSBzdHJpbmcgLS0gZWl0aGVyIGJhc2U2NFxuICAvLyBjb21wYWN0IG9yIEpTT04gYmVnaW5uaW5nIHdpdGggYSBcIntcIiAod2hpY2ggYXJlIGRpc3Rpbmd1aXNoYWJsZSBiZWNhdXNlIFwie1wiIGlzIG5vdCBhIGJhc2U2NCBjaGFyYWN0ZXIpLlxuICBzdGF0aWMgZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSkgeyAvLyBSZXR1cm4gYSBzaWduYXR1cmUgdGhhdCBpcyBkZWZpbmF0ZWx5IGEgc3RyaW5nLlxuICAgIGlmICh0eXBlb2Yoc2lnbmF0dXJlKSAhPT0gJ3N0cmluZycpIHJldHVybiBKU09OLnN0cmluZ2lmeShzaWduYXR1cmUpO1xuICAgIHJldHVybiBzaWduYXR1cmU7XG4gIH1cbiAgLy8gUmV0dXJuIGEgY29tcGFjdCBvciBcIkpTT05cIiAob2JqZWN0KSBmb3JtIG9mIHNpZ25hdHVyZSAoaW5mbGF0aW5nIGEgc2VyaWFsaXphdGlvbiBvZiB0aGUgbGF0dGVyIGlmIG5lZWRlZCksIGJ1dCBub3QgYSBKU09OIHN0cmluZy5cbiAgc3RhdGljIG1heWJlSW5mbGF0ZShzaWduYXR1cmUpIHtcbiAgICBpZiAoc2lnbmF0dXJlPy5zdGFydHNXaXRoPy4oXCJ7XCIpKSByZXR1cm4gSlNPTi5wYXJzZShzaWduYXR1cmUpO1xuICAgIHJldHVybiBzaWduYXR1cmU7XG4gIH1cbiAgLy8gVGhlIHR5cGUgb2YgSldFIHRoYXQgZ2V0cyBzaWduZWQgKG5vdCB0aGUgY3R5IG9mIHRoZSBKV0UpLiBXZSBhdXRvbWF0aWNhbGx5IHRyeSB0byBkZWNyeXB0IGEgSldTIHBheWxvYWQgb2YgdGhpcyB0eXBlLlxuICBzdGF0aWMgZW5jcnlwdGVkTWltZVR5cGUgPSAndGV4dC9lbmNyeXB0ZWQnO1xuICBzdGF0aWMgYXN5bmMgZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKSB7IC8vIFByb21pc2UgdmVyZmllZCBhZnRlciBmaXJzdCBhdWdtZW50aW5nIHdpdGggZGVjcnlwdGVkIGRhdGEgYXMgbmVlZGVkLlxuICAgIGlmICh2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuY3R5ICE9PSB0aGlzLmVuY3J5cHRlZE1pbWVUeXBlKSByZXR1cm4gdmVyaWZpZWQ7XG4gICAgaWYgKHZlcmlmaWVkLmRlY3J5cHRlZCkgcmV0dXJuIHZlcmlmaWVkOyAvLyBBbHJlYWR5IGRlY3J5cHRlZC5cbiAgICBjb25zdCBkZWNyeXB0ZWQgPSBhd2FpdCBDcmVkZW50aWFscy5kZWNyeXB0KHZlcmlmaWVkLnRleHQpO1xuICAgIHZlcmlmaWVkLmpzb24gPSBkZWNyeXB0ZWQuanNvbjtcbiAgICB2ZXJpZmllZC50ZXh0ID0gZGVjcnlwdGVkLnRleHQ7XG4gICAgdmVyaWZpZWQucGF5bG9hZCA9IGRlY3J5cHRlZC5wYXlsb2FkO1xuICAgIHZlcmlmaWVkLmRlY3J5cHRlZCA9IGRlY3J5cHRlZDtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHNpZ24oZGF0YSwgb3B0aW9ucykge1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IENyZWRlbnRpYWxzLnNpZ24oZGF0YSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIHRoaXMuZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMgPSB7fSkge1xuICAgIHNpZ25hdHVyZSA9IHRoaXMubWF5YmVJbmZsYXRlKHNpZ25hdHVyZSk7XG4gICAgLy8gV2UgZG9uJ3QgZG8gXCJkZWVwXCIgdmVyaWZpY2F0aW9uIGhlcmUgLSBlLmcuLCBjaGVja2luZyB0aGF0IHRoZSBhY3QgaXMgYSBtZW1iZXIgb2YgaXNzLCBhbmQgdGhlIGlhdCBpcyBhZnRlciB0aGUgZXhpc3RpbmcgaWF0LlxuICAgIC8vIEluc3RlYWQsIHdlIGRvIG91ciBvd24gZGVlcCBjaGVja3MgaW4gdmFsaWRhdGVGb3JXcml0aW5nLlxuICAgIC8vIFRoZSBtZW1iZXIvbm90QmVmb3JlIHNob3VsZCBjaGVjayBvdXQgYW55d2F5IC0tIGkuZS4sIHdlIGNvdWxkIGxlYXZlIGl0IGluLCBleGNlcHQgaW4gc3luY2hyb25pemluZ1xuICAgIC8vIENyZWRlbnRpYWwuY29sbGVjdGlvbnMuIFRoZXJlIGlzIG5vIG1lY2hhbmlzbSAoY3VycmVudGx5KSBmb3IgdGhlXG4gICAgLy8gc3luY2hyb25pemF0aW9uIHRvIGhhcHBlbiBpbiBhbiBvcmRlciB0aGF0IHdpbGwgcmVzdWx0IGluIHRoZSBkZXBlbmRlbmNpZXMgY29taW5nIG92ZXIgYmVmb3JlIHRoZSBpdGVtcyB0aGF0IGNvbnN1bWUgdGhlbS5cbiAgICBjb25zdCB2ZXJpZmllZCA9ICBhd2FpdCBDcmVkZW50aWFscy52ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zKTtcbiAgICBpZiAodmVyaWZpZWQpIHZlcmlmaWVkLnNpZ25hdHVyZSA9IHNpZ25hdHVyZTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZlcmlmaWVkU2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucywgdGFnID0gbnVsbCkgeyAvLyBTaWduLCBidXQgcmV0dXJuIGEgdmFsaWRhdGlvbiAoYXMgdGhvdWdoIGJ5IGltbWVkaWF0ZWx5IHZhbGlkYXRpbmcpLlxuICAgIC8vIFRPRE86IGFzc2VtYmxlIHRoaXMgbW9yZSBjaGVhcGx5P1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuc2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgcmV0dXJuIHRoaXMudmFsaWRhdGlvbkZvcm1hdChzaWduYXR1cmUsIHRhZyk7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZhbGlkYXRpb25Gb3JtYXQoc2lnbmF0dXJlLCB0YWcgPSBudWxsKSB7XG4gICAgLy9jb25zb2xlLmxvZyh7dHlwZTogdHlwZW9mKHNpZ25hdHVyZSksIHNpZ25hdHVyZSwgdGFnfSk7XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLnZlcmlmeShzaWduYXR1cmUpO1xuICAgIC8vY29uc29sZS5sb2coe3ZlcmlmaWVkfSk7XG4gICAgY29uc3Qgc3ViID0gdmVyaWZpZWQuc3ViamVjdFRhZyA9IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gICAgdmVyaWZpZWQudGFnID0gdGFnIHx8IHN1YjtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cblxuICBhc3luYyB1bmRlbGV0ZWRUYWdzKCkge1xuICAgIC8vIE91ciBvd24gc2VwYXJhdGUsIG9uLWRlbWFuZCBhY2NvdW50aW5nIG9mIHBlcnNpc3RlbmNlU3RvcmUgbGlzdCgpOlxuICAgIC8vICAgLSBwZXJzaXN0ZW5jZVN0b3JlIGxpc3QoKSBjb3VsZCBwb3RlbnRpYWxseSBiZSBleHBlbnNpdmVcbiAgICAvLyAgIC0gSXQgd2lsbCBjb250YWluIHNvZnQtZGVsZXRlZCBpdGVtIHRvbWJzdG9uZXMgKHNpZ25lZCBlbXB0eSBwYXlsb2FkcykuXG4gICAgLy8gSXQgc3RhcnRzIHdpdGggYSBsaXN0KCkgdG8gZ2V0IGFueXRoaW5nIHBlcnNpc3RlZCBpbiBhIHByZXZpb3VzIHNlc3Npb24sIGFuZCBhZGRzL3JlbW92ZXMgYXMgd2Ugc3RvcmUvcmVtb3ZlLlxuICAgIGNvbnN0IGFsbFRhZ3MgPSBhd2FpdCAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKS5saXN0KCk7XG4gICAgY29uc3QgdGFncyA9IG5ldyBTZXQoKTtcbiAgICBhd2FpdCBQcm9taXNlLmFsbChhbGxUYWdzLm1hcChhc3luYyB0YWcgPT4ge1xuICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIHN5bmNocm9uaXplOiBmYWxzZX0pO1xuICAgICAgaWYgKHZlcmlmaWVkKSB0YWdzLmFkZCh0YWcpO1xuICAgIH0pKTtcbiAgICByZXR1cm4gdGFncztcbiAgfVxuICBnZXQgdGFncygpIHsgLy8gS2VlcHMgdHJhY2sgb2Ygb3VyICh1bmRlbGV0ZWQpIGtleXMuXG4gICAgcmV0dXJuIHRoaXMuX3RhZ3NQcm9taXNlIHx8PSB0aGlzLnVuZGVsZXRlZFRhZ3MoKTtcbiAgfVxuICBhc3luYyBhZGRUYWcodGFnKSB7XG4gICAgKGF3YWl0IHRoaXMudGFncykuYWRkKHRhZyk7XG4gIH1cbiAgYXN5bmMgZGVsZXRlVGFnKHRhZykge1xuICAgIChhd2FpdCB0aGlzLnRhZ3MpLmRlbGV0ZSh0YWcpO1xuICB9XG5cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAoIXRoaXMuZGVidWcpIHJldHVybjtcbiAgICBjb25zb2xlLmxvZyh0aGlzLmZ1bGxMYWJlbCwgLi4ucmVzdCk7XG4gIH1cbiAgX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob2JqZWN0T3JTdHJpbmcgPSB7fSkge1xuICAgIGlmICh0eXBlb2Yob2JqZWN0T3JTdHJpbmcpID09PSAnc3RyaW5nJykgb2JqZWN0T3JTdHJpbmcgPSB7dGFnOiBvYmplY3RPclN0cmluZ307XG4gICAgY29uc3Qge293bmVyOnRlYW0gPSBDcmVkZW50aWFscy5vd25lciwgYXV0aG9yOm1lbWJlciA9IENyZWRlbnRpYWxzLmF1dGhvcixcblx0ICAgdGFnLFxuXHQgICBlbmNyeXB0aW9uID0gQ3JlZGVudGlhbHMuZW5jcnlwdGlvbixcblx0ICAgdGltZSA9IERhdGUubm93KCksXG5cdCAgIC4uLnJlc3R9ID0gb2JqZWN0T3JTdHJpbmc7XG4gICAgLy8gVE9ETzogc3VwcG9ydCBzaW1wbGlmaWVkIHN5bnRheCwgdG9vLCBwZXIgUkVBRE1FXG4gICAgLy8gVE9ETzogc2hvdWxkIHdlIHNwZWNpZnkgc3ViamVjdDogdGFnIGZvciBib3RoIG11dGFibGVzPyAoZ2l2ZXMgaGFzaClcbiAgICBjb25zdCBvcHRpb25zID0gKHRlYW0gJiYgdGVhbSAhPT0gbWVtYmVyKSA/XG5cdCAge3RlYW0sIG1lbWJlciwgdGFnLCBlbmNyeXB0aW9uLCB0aW1lLCAuLi5yZXN0fSA6XG5cdCAge3RhZ3M6IFttZW1iZXJdLCB0YWcsIHRpbWUsIGVuY3J5cHRpb24sIC4uLnJlc3R9OyAvLyBObyBpYXQgaWYgdGltZSBub3QgZXhwbGljaXRseSBnaXZlbi5cbiAgICBpZiAoW3RydWUsICd0ZWFtJywgJ293bmVyJ10uaW5jbHVkZXMob3B0aW9ucy5lbmNyeXB0aW9uKSkgb3B0aW9ucy5lbmNyeXB0aW9uID0gdGVhbTtcbiAgICByZXR1cm4gb3B0aW9ucztcbiAgfVxuICBmYWlsKG9wZXJhdGlvbiwgZGF0YSwgYXV0aG9yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2F1dGhvcn0gZG9lcyBub3QgaGF2ZSB0aGUgYXV0aG9yaXR5IHRvICR7b3BlcmF0aW9ufSAke3RoaXMuZnVsbE5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9LmApO1xuICB9XG4gIGFzeW5jIHN0b3JlKGRhdGEsIG9wdGlvbnMgPSB7fSkge1xuICAgIC8vIGVuY3J5cHQgaWYgbmVlZGVkXG4gICAgLy8gc2lnblxuICAgIC8vIHB1dCA8PT0gQWxzbyB3aGVyZSB3ZSBlbnRlciBpZiBwdXNoZWQgZnJvbSBhIGNvbm5lY3Rpb25cbiAgICAvLyAgICB2YWxpZGF0ZUZvcldyaXRpbmdcbiAgICAvLyAgICAgICBleGl0IGlmIGltcHJvcGVyXG4gICAgLy8gICAgICAgZW1pdCB1cGRhdGUgZXZlbnRcbiAgICAvLyAgICBtZXJnZVNpZ25hdHVyZXNcbiAgICAvLyAgICBwZXJzaXN0IGxvY2FsbHlcbiAgICAvLyBwdXNoIChsaXZlIHRvIGFueSBjb25uZWN0aW9ucyBleGNlcHQgdGhlIG9uZSB3ZSByZWNlaXZlZCBmcm9tKVxuICAgIGxldCB7ZW5jcnlwdGlvbiwgdGFnLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpO1xuICAgIGlmIChlbmNyeXB0aW9uKSB7XG4gICAgICBkYXRhID0gYXdhaXQgQ3JlZGVudGlhbHMuZW5jcnlwdChkYXRhLCBlbmNyeXB0aW9uKTtcbiAgICAgIHNpZ25pbmdPcHRpb25zLmNvbnRlbnRUeXBlID0gdGhpcy5jb25zdHJ1Y3Rvci5lbmNyeXB0ZWRNaW1lVHlwZTtcbiAgICB9XG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb24uXG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zKTtcbiAgICB0YWcgPSBhd2FpdCB0aGlzLnB1dCh0YWcsIHNpZ25hdHVyZSk7XG4gICAgaWYgKCF0YWcpIHJldHVybiB0aGlzLmZhaWwoJ3N0b3JlJywgZGF0YSwgc2lnbmluZ09wdGlvbnMubWVtYmVyIHx8IHNpZ25pbmdPcHRpb25zLnRhZ3NbMF0pO1xuICAgIGF3YWl0IHRoaXMucHVzaCgncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgcHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlLCBleGNsdWRlU3luY2hyb25pemVyID0gbnVsbCkgeyAvLyBQdXNoIHRvIGFsbCBjb25uZWN0ZWQgc3luY2hyb25pemVycywgZXhjbHVkaW5nIHRoZSBzcGVjaWZpZWQgb25lLlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IChleGNsdWRlU3luY2hyb25pemVyICE9PSBzeW5jaHJvbml6ZXIpICYmIHN5bmNocm9uaXplci5wdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpKSk7XG4gIH1cbiAgYXN5bmMgcmVtb3ZlKG9wdGlvbnMgPSB7fSkgeyAvLyBOb3RlOiBSZWFsbHkganVzdCByZXBsYWNpbmcgd2l0aCBlbXB0eSBkYXRhIGZvcmV2ZXIuIE90aGVyd2lzZSBtZXJnaW5nIHdpdGggZWFybGllciBkYXRhIHdpbGwgYnJpbmcgaXQgYmFjayFcbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTtcbiAgICBjb25zdCBkYXRhID0gJyc7XG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb25cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHRhZyA9IGF3YWl0IHRoaXMuZGVsZXRlKHRhZywgc2lnbmF0dXJlKTtcbiAgICBpZiAoIXRhZykgcmV0dXJuIHRoaXMuZmFpbCgnc3RvcmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gZ2V0VmVyaWZpZWQgYW5kIG1heWJlIGRlY3J5cHQuIEhhcyBtb3JlIGNvbXBsZXggYmVoYXZpb3IgaW4gc3ViY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbi5cbiAgICBjb25zdCB7dGFnLCBkZWNyeXB0ID0gdHJ1ZSwgLi4ub3B0aW9uc30gPSB0YWdPck9wdGlvbnMudGFnID8gdGFnT3JPcHRpb25zIDoge3RhZzogdGFnT3JPcHRpb25zfTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZywgLi4ub3B0aW9uc30pO1xuICAgIGlmICghdmVyaWZpZWQpIHJldHVybiAnJztcbiAgICBpZiAoZGVjcnlwdCkgcmV0dXJuIGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgYXN5bmMgZ2V0VmVyaWZpZWQodGFnT3JPcHRpb25zKSB7IC8vIHN5bmNocm9uaXplLCBnZXQsIGFuZCB2ZXJpZnkgKGJ1dCB3aXRob3V0IGRlY3J5cHQpXG4gICAgY29uc3Qge3RhZywgc3luY2hyb25pemUgPSB0cnVlLCAuLi52ZXJpZnlPcHRpb25zfSA9IHRhZ09yT3B0aW9ucy50YWcgPyB0YWdPck9wdGlvbnM6IHt0YWc6IHRhZ09yT3B0aW9uc307XG4gICAgaWYgKHN5bmNocm9uaXplKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplMSh0YWcpO1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuZ2V0KHRhZyk7XG4gICAgaWYgKCFzaWduYXR1cmUpIHJldHVybiBzaWduYXR1cmU7XG4gICAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmVyaWZ5T3B0aW9ucyk7XG4gIH1cbiAgYXN5bmMgbGlzdChza2lwU3luYyA9IGZhbHNlICkgeyAvLyBMaXN0IGFsbCB0YWdzIG9mIHRoaXMgY29sbGVjdGlvbi5cbiAgICBpZiAoIXNraXBTeW5jKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIC8vIFdlIGNhbm5vdCBqdXN0IGxpc3QgdGhlIGtleXMgb2YgdGhlIGNvbGxlY3Rpb24sIGJlY2F1c2UgdGhhdCBpbmNsdWRlcyBlbXB0eSBwYXlsb2FkcyBvZiBpdGVtcyB0aGF0IGhhdmUgYmVlbiBkZWxldGVkLlxuICAgIHJldHVybiBBcnJheS5mcm9tKChhd2FpdCB0aGlzLnRhZ3MpLmtleXMoKSk7XG4gIH1cbiAgYXN5bmMgbWF0Y2godGFnLCBwcm9wZXJ0aWVzKSB7IC8vIElzIHRoaXMgc2lnbmF0dXJlIHdoYXQgd2UgYXJlIGxvb2tpbmcgZm9yP1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5yZXRyaWV2ZSh0YWcpO1xuICAgIGNvbnN0IGRhdGEgPSB2ZXJpZmllZD8uanNvbjtcbiAgICBpZiAoIWRhdGEpIHJldHVybiBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBwcm9wZXJ0aWVzKSB7XG4gICAgICBpZiAoZGF0YVtrZXldICE9PSBwcm9wZXJ0aWVzW2tleV0pIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgYXN5bmMgZmluZExvY2FsKHByb3BlcnRpZXMpIHsgLy8gRmluZCB0aGUgdGFnIGluIG91ciBzdG9yZSB0aGF0IG1hdGNoZXMsIGVsc2UgZmFsc2V5XG4gICAgZm9yIChjb25zdCB0YWcgb2YgYXdhaXQgdGhpcy5saXN0KCduby1zeW5jJykpIHsgLy8gRGlyZWN0IGxpc3QsIHcvbyBzeW5jLlxuICAgICAgaWYgKGF3YWl0IHRoaXMubWF0Y2godGFnLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIHRhZztcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGFzeW5jIGZpbmQocHJvcGVydGllcykgeyAvLyBBbnN3ZXIgdGhlIHRhZyB0aGF0IGhhcyB2YWx1ZXMgbWF0Y2hpbmcgdGhlIHNwZWNpZmllZCBwcm9wZXJ0aWVzLiBPYnZpb3VzbHksIGNhbid0IGJlIGVuY3J5cHRlZCBhcyBhIHdob2xlLlxuICAgIGxldCBmb3VuZCA9IGF3YWl0IHRoaXMuZmluZExvY2FsKHByb3BlcnRpZXMpO1xuICAgIGlmIChmb3VuZCkge1xuICAgICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZTEoZm91bmQpOyAvLyBNYWtlIHN1cmUgdGhlIGRhdGEgaXMgdXAgdG8gZGF0ZS4gVGhlbiBjaGVjayBhZ2Fpbi5cbiAgICAgIGlmIChhd2FpdCB0aGlzLm1hdGNoKGZvdW5kLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIGZvdW5kO1xuICAgIH1cbiAgICAvLyBObyBtYXRjaC5cbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemVEYXRhKCk7XG4gICAgZm91bmQgPSBhd2FpdCB0aGlzLmZpbmRMb2NhbChwcm9wZXJ0aWVzKTtcbiAgICBpZiAoZm91bmQgJiYgYXdhaXQgdGhpcy5tYXRjaChmb3VuZCwgcHJvcGVydGllcykpIHJldHVybiBmb3VuZDtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXF1aXJlVGFnKHRhZykge1xuICAgIGlmICh0YWcpIHJldHVybjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0EgdGFnIGlzIHJlcXVpcmVkLicpO1xuICB9XG5cbiAgLy8gVGhlc2UgdGhyZWUgaWdub3JlIHN5bmNocm9uaXphdGlvbiBzdGF0ZSwgd2hpY2ggaWYgbmVlZWQgaXMgdGhlIHJlc3BvbnNpYmlsaXR5IG9mIHRoZSBjYWxsZXIuXG4gIC8vIEZJWE1FIFRPRE86IGFmdGVyIGluaXRpYWwgZGV2ZWxvcG1lbnQsIHRoZXNlIHRocmVlIHNob3VsZCBiZSBtYWRlIGludGVybmFsIHNvIHRoYXQgYXBwbGljYXRpb24gY29kZSBkb2VzIG5vdCBjYWxsIHRoZW0uXG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gR2V0IHRoZSBsb2NhbCByYXcgc2lnbmF0dXJlIGRhdGEuXG4gICAgdGhpcy5yZXF1aXJlVGFnKHRhZyk7XG4gICAgcmV0dXJuIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmdldCh0YWcpO1xuICB9XG4gIC8vIFRoZXNlIHR3byBjYW4gYmUgdHJpZ2dlcmVkIGJ5IGNsaWVudCBjb2RlIG9yIGJ5IGFueSBzZXJ2aWNlLlxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUsIHN5bmNocm9uaXplciA9IG51bGwsIG1lcmdlQXV0aG9yT3ZlcnJpZGUgPSBudWxsKSB7IC8vIFB1dCB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIC8vIG1lcmdlU2lnbmF0dXJlcygpIE1BWSBjcmVhdGUgbmV3IG5ldyByZXN1bHRzIHRvIHNhdmUsIHRoYXQgc3RpbGwgaGF2ZSB0byBiZSBzaWduZWQuIEZvciB0ZXN0aW5nLCB3ZSBzb21ldGltZXNcbiAgICAvLyB3YW50IHRvIGJlaGF2ZSBhcyBpZiBzb21lIG93bmVyIGNyZWRlbnRpYWwgZG9lcyBub3QgZXhpc3Qgb24gdGhlIG1hY2hpbmUuIFRoYXQncyB3aGF0IG1lcmdlQXV0aG9yT3ZlcnJpZGUgaXMgZm9yLlxuXG4gICAgLy8gVE9ETzogZG8gd2UgbmVlZCB0byBxdWV1ZSB0aGVzZT8gU3VwcG9zZSB3ZSBhcmUgdmFsaWRhdGluZyBvciBtZXJnaW5nIHdoaWxlIG90aGVyIHJlcXVlc3QgYXJyaXZlP1xuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3N0b3JlJywgc3luY2hyb25pemVyKTtcbiAgICB0aGlzLmxvZygncHV0Jywge3RhZzogdmFsaWRhdGlvbj8udGFnIHx8IHRhZywgc3luY2hyb25pemVyOiBzeW5jaHJvbml6ZXI/LmxhYmVsLCBqc29uOiB2YWxpZGF0aW9uPy5qc29ufSk7XG4gICAgaWYgKCF2YWxpZGF0aW9uKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGF3YWl0IHRoaXMuYWRkVGFnKHZhbGlkYXRpb24udGFnKTtcblxuICAgIC8vIGZpeG1lIG5leHRcbiAgICBjb25zdCBtZXJnZWQgPSBhd2FpdCB0aGlzLm1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSwgbWVyZ2VBdXRob3JPdmVycmlkZSk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBtZXJnZWQpO1xuICAgIC8vY29uc3QgbWVyZ2VkMiA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmFsaWRhdGlvbkZvcm1hdChtZXJnZWQsIHRhZyk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIG1lcmdlZCk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QyKG1lcmdlZDIpO1xuICAgIC8vIGNvbnN0IG1lcmdlZCA9IGF3YWl0IHRoaXMubWVyZ2VWYWxpZGF0aW9uKHZhbGlkYXRpb24sIG1lcmdlQXV0aG9yT3ZlcnJpZGUpO1xuICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIobWVyZ2VkKTtcblxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5wdXQuXG4gIH1cbiAgYXN5bmMgZGVsZXRlKHRhZywgc2lnbmF0dXJlLCBzeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFJlbW92ZSB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3JlbW92ZScsIHN5bmNocm9uaXplciwgJ3JlcXVpcmVUYWcnKTtcbiAgICB0aGlzLmxvZygnZGVsZXRlJywgdGFnLCBzeW5jaHJvbml6ZXI/LmxhYmVsLCAndmFsaWRhdGVkIHRhZzonLCB2YWxpZGF0aW9uPy50YWcsICdwcmVzZXJ2ZURlbGV0aW9uczonLCB0aGlzLnByZXNlcnZlRGVsZXRpb25zKTtcbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICBpZiAodGhpcy5wcmVzZXJ2ZURlbGV0aW9ucykgeyAvLyBTaWduYXR1cmUgcGF5bG9hZCBpcyBlbXB0eS5cbiAgICAgIC8vIEZJWE1FIG5leHRcbiAgICAgIC8vYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBzaWduYXR1cmUpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uKTtcbiAgICB9IGVsc2UgeyAvLyBSZWFsbHkgZGVsZXRlLlxuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIHNpZ25hdHVyZSwgJ2RlbGV0ZScpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uLCAnZGVsZXRlJyk7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5kZWxldGUuXG4gIH1cblxuICBub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsIG1lc3NhZ2UgPSB1bmRlZmluZWQsIHZhbGlkYXRlZCA9ICcnLCBzaWduYXR1cmUpIHtcbiAgICAvLyBMYXRlciBvbiwgd2Ugd2lsbCBub3Qgd2FudCB0byBnaXZlIG91dCBzbyBtdWNoIGluZm8uLi5cbiAgICAvL2lmICh0aGlzLmRlYnVnKSB7XG4gICAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSwgdGFnKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy8gIGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgYFNpZ25hdHVyZSBpcyBub3QgdmFsaWQgdG8gJHtvcGVyYXRpb25MYWJlbH0gJHt0YWcgfHwgJ2RhdGEnfS5gKTtcbiAgICAvL31cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIFJldHVybiBhIHJlYXNvbiBzdHJpbmcgd2h5IHRoZSBwcm9wb3NlZCB2ZXJpZmllZCBwcm90ZWN0ZWRIZWFkZXJcbiAgICAvLyBzaG91bGQgbm90IGJlIGFsbG93ZWQgdG8gb3ZlcnJ3cml0ZSB0aGUgKHBvc3NpYmx5IG51bGxpc2gpIGV4aXN0aW5nIHZlcmlmaWVkIHByb3RlY3RlZEhlYWRlcixcbiAgICAvLyBlbHNlIGZhbHN5IGlmIGFsbG93ZWQuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuIG51bGw7XG4gICAgaWYgKHByb3Bvc2VkLmlhdCA8IGV4aXN0aW5nLmlhdCkgcmV0dXJuICdiYWNrZGF0ZWQnO1xuICAgIGlmICghdGhpcy5vd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkpIHJldHVybiAnbm90IG93bmVyJztcbiAgICBpZiAoIWF3YWl0IHRoaXMuc3ViamVjdE1hdGNoKHZlcmlmaWVkKSkgcmV0dXJuICd3cm9uZyBoYXNoJztcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBhc3luYyBzdWJqZWN0TWF0Y2godmVyaWZpZWQpIHsgLy8gUHJvbWlzZXMgdHJ1ZSBJRkYgY2xhaW1lZCAnc3ViJyBtYXRjaGVzIGhhc2ggb2YgdGhlIGNvbnRlbnRzLlxuICAgIHJldHVybiB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViID09PSBhd2FpdCBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoYXdhaXQgQ3JlZGVudGlhbHMuaGFzaEJ1ZmZlcih2ZXJpZmllZC5wYXlsb2FkKSk7XG4gIH1cbiAgb3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpIHsvLyBEb2VzIHByb3Bvc2VkIG93bmVyIG1hdGNoIHRoZSBleGlzdGluZz9cbiAgICBjb25zdCBleGlzdGluZ093bmVyID0gZXhpc3Rpbmc/LmlzcyB8fCBleGlzdGluZz8ua2lkO1xuICAgIGNvbnN0IHByb3Bvc2VkT3duZXIgPSBwcm9wb3NlZC5pc3MgfHwgcHJvcG9zZWQua2lkO1xuICAgIC8vIEV4YWN0IG1hdGNoLiBEbyB3ZSBuZWVkIHRvIGFsbG93IGZvciBhbiBvd25lciB0byB0cmFuc2ZlciBvd25lcnNoaXAgdG8gYSBzdWIvc3VwZXIvZGlzam9pbnQgdGVhbT9cbiAgICAvLyBDdXJyZW50bHksIHRoYXQgd291bGQgcmVxdWlyZSBhIG5ldyByZWNvcmQuIChFLmcuLCB0d28gTXV0YWJsZS9WZXJzaW9uZWRDb2xsZWN0aW9uIGl0ZW1zIHRoYXRcbiAgICAvLyBoYXZlIHRoZSBzYW1lIEdVSUQgcGF5bG9hZCBwcm9wZXJ0eSwgYnV0IGRpZmZlcmVudCB0YWdzLiBJLmUuLCBhIGRpZmZlcmVudCBvd25lciBtZWFucyBhIGRpZmZlcmVudCB0YWcuKVxuICAgIGlmICghcHJvcG9zZWRPd25lciB8fCAoZXhpc3RpbmdPd25lciAmJiAocHJvcG9zZWRPd25lciAhPT0gZXhpc3RpbmdPd25lcikpKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgIC8vIFdlIGFyZSBub3QgY2hlY2tpbmcgdG8gc2VlIGlmIGF1dGhvciBpcyBjdXJyZW50bHkgYSBtZW1iZXIgb2YgdGhlIG93bmVyIHRlYW0gaGVyZSwgd2hpY2hcbiAgICAgIC8vIGlzIGNhbGxlZCBieSBwdXQoKS9kZWxldGUoKSBpbiB0d28gY2lyY3Vtc3RhbmNlczpcblxuICAgICAgLy8gdGhpcy52YWxpZGF0ZUZvcldyaXRpbmcoKSBpcyBjYWxsZWQgYnkgcHV0KCkvZGVsZXRlKCkgd2hpY2ggaGFwcGVucyBpbiB0aGUgYXBwICh2aWEgc3RvcmUoKS9yZW1vdmUoKSlcbiAgICAgIC8vIGFuZCBkdXJpbmcgc3luYyBmcm9tIGFub3RoZXIgc2VydmljZTpcblxuICAgICAgLy8gMS4gRnJvbSB0aGUgYXBwICh2YWlhIHN0b3JlKCkvcmVtb3ZlKCksIHdoZXJlIHdlIGhhdmUganVzdCBjcmVhdGVkIHRoZSBzaWduYXR1cmUuIFNpZ25pbmcgaXRzZWxmXG4gICAgICAvLyB3aWxsIGZhaWwgaWYgdGhlICgxLWhvdXIgY2FjaGVkKSBrZXkgaXMgbm8gbG9uZ2VyIGEgbWVtYmVyIG9mIHRoZSB0ZWFtLiBUaGVyZSBpcyBubyBpbnRlcmZhY2VcbiAgICAgIC8vIGZvciB0aGUgYXBwIHRvIHByb3ZpZGUgYW4gb2xkIHNpZ25hdHVyZS4gKFRPRE86IGFmdGVyIHdlIG1ha2UgZ2V0L3B1dC9kZWxldGUgaW50ZXJuYWwuKVxuXG4gICAgICAvLyAyLiBEdXJpbmcgc3luYyBmcm9tIGFub3RoZXIgc2VydmljZSwgd2hlcmUgd2UgYXJlIHB1bGxpbmcgaW4gb2xkIHJlY29yZHMgZm9yIHdoaWNoIHdlIGRvbid0IGhhdmVcbiAgICAgIC8vIHRlYW0gbWVtYmVyc2hpcCBmcm9tIHRoYXQgdGltZS5cblxuICAgICAgLy8gSWYgdGhlIGFwcCBjYXJlcyB3aGV0aGVyIHRoZSBhdXRob3IgaGFzIGJlZW4ga2lja2VkIGZyb20gdGhlIHRlYW0sIHRoZSBhcHAgaXRzZWxmIHdpbGwgaGF2ZSB0byBjaGVjay5cbiAgICAgIC8vIFRPRE86IHdlIHNob3VsZCBwcm92aWRlIGEgdG9vbCBmb3IgdGhhdC5cblxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGFudGVjZWRlbnQodmVyaWZpZWQpIHsgLy8gV2hhdCB0YWcgc2hvdWxkIHRoZSB2ZXJpZmllZCBzaWduYXR1cmUgYmUgY29tcGFyZWQgYWdhaW5zdCBmb3Igd3JpdGluZz9cbiAgICByZXR1cm4gdmVyaWZpZWQudGFnO1xuICB9XG4gIHN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpIHsgLy8gU2hvdWxkIHRoZSBhbnRlY2VkZW50IHRyeSBzeW5jaHJvbml6aW5nIGJlZm9yZSBnZXR0aW5nIGl0P1xuICAgIHJldHVybiB0YWcgIT09IGFudGVjZWRlbnQ7IC8vIEZhbHNlIHdoZW4gdGhleSBhcmUgdGhlIHNhbWUgdGFnLCBhcyB0aGF0IHdvdWxkIGJlIGNpcmN1bGFyLiBWZXJzaW9ucyBkbyBzeW5jLlxuICB9XG4gIC8vIFRPRE86IGlzIHRoaXMgbmVlZGVkIGFueSBtb3JlP1xuICBhc3luYyB2YWxpZGF0ZUZvcldyaXRpbmcodGFnLCBzaWduYXR1cmUsIG9wZXJhdGlvbkxhYmVsLCBzeW5jaHJvbml6ZXIsIHJlcXVpcmVUYWcgPSBmYWxzZSkge1xuICAgIC8vIEEgZGVlcCB2ZXJpZnkgdGhhdCBjaGVja3MgYWdhaW5zdCB0aGUgZXhpc3RpbmcgaXRlbSdzIChyZS0pdmVyaWZpZWQgaGVhZGVycy5cbiAgICAvLyBJZiBpdCBzdWNjZWVkcywgdGhpcyBpcyBhbHNvIHRoZSBjb21tb24gY29kZSAoYmV0d2VlbiBwdXQvZGVsZXRlKSB0aGF0IGVtaXRzIHRoZSB1cGRhdGUgZXZlbnQuXG4gICAgY29uc3QgdmFsaWRhdGlvbk9wdGlvbnMgPSBzeW5jaHJvbml6ZXIgPyB7bWVtYmVyOiBudWxsfSA6IHt9OyAvLyBDb3VsZCBiZSBvbGQgZGF0YSB3cml0dGVuIGJ5IHNvbWVvbmUgd2hvIGlzIG5vIGxvbmdlciBhIG1lbWJlci5cbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmFsaWRhdGlvbk9wdGlvbnMpO1xuICAgIGlmICghdmVyaWZpZWQpIHJldHVybiB0aGlzLm5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgJ2ludmFsaWQnLCB2ZXJpZmllZCwgc2lnbmF0dXJlKTtcbiAgICB2ZXJpZmllZC5zeW5jaHJvbml6ZXIgPSBzeW5jaHJvbml6ZXI7XG4gICAgdGFnID0gdmVyaWZpZWQudGFnID0gdmVyaWZpZWQuc3ViamVjdFRhZyA9IHJlcXVpcmVUYWcgPyB0YWcgOiBhd2FpdCB0aGlzLnRhZ0ZvcldyaXRpbmcodGFnLCB2ZXJpZmllZCk7XG4gICAgY29uc3QgYW50ZWNlZGVudCA9IHRoaXMuYW50ZWNlZGVudCh2ZXJpZmllZCk7XG4gICAgY29uc3Qgc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpO1xuICAgIGNvbnN0IGV4aXN0aW5nVmVyaWZpZWQgPSB2ZXJpZmllZC5leGlzdGluZyA9IGFudGVjZWRlbnQgJiYgYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnOiBhbnRlY2VkZW50LCBzeW5jaHJvbml6ZX0pO1xuICAgIGNvbnN0IGRpc2FsbG93ZWQgPSBhd2FpdCB0aGlzLmRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZ1ZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkKTtcbiAgICBpZiAoZGlzYWxsb3dlZCkgcmV0dXJuIHRoaXMubm90aWZ5SW52YWxpZCh0YWcsIG9wZXJhdGlvbkxhYmVsLCBkaXNhbGxvd2VkLCB2ZXJpZmllZCk7XG4gICAgdGhpcy5sb2coJ2VtaXQnLCB0YWcsIHZlcmlmaWVkLmpzb24pO1xuICAgIHRoaXMuZW1pdCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIC8vIGZpeG1lIG5leHQgMlxuICBtZXJnZVNpZ25hdHVyZXModGFnLCB2YWxpZGF0aW9uLCBzaWduYXR1cmUpIHsgLy8gUmV0dXJuIGEgc3RyaW5nIHRvIGJlIHBlcnNpc3RlZC4gVXN1YWxseSBqdXN0IHRoZSBzaWduYXR1cmUuXG4gICAgcmV0dXJuIHNpZ25hdHVyZTsgIC8vIHZhbGlkYXRpb24uc3RyaW5nIG1pZ2h0IGJlIGFuIG9iamVjdC5cbiAgfVxuICBhc3luYyBwZXJzaXN0KHRhZywgc2lnbmF0dXJlU3RyaW5nLCBvcGVyYXRpb24gPSAncHV0JykgeyAvLyBDb25kdWN0IHRoZSBzcGVjaWZpZWQgdGFnL3NpZ25hdHVyZSBvcGVyYXRpb24gb24gdGhlIHBlcnNpc3RlbnQgc3RvcmUuXG4gICAgcmV0dXJuIChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpW29wZXJhdGlvbl0odGFnLCBzaWduYXR1cmVTdHJpbmcpO1xuICB9XG4gIG1lcmdlVmFsaWRhdGlvbih2YWxpZGF0aW9uKSB7IC8vIFJldHVybiBhIHN0cmluZyB0byBiZSBwZXJzaXN0ZWQuIFVzdWFsbHkganVzdCB0aGUgc2lnbmF0dXJlLlxuICAgIHJldHVybiB2YWxpZGF0aW9uO1xuICB9XG4gIGFzeW5jIHBlcnNpc3QyKHZhbGlkYXRpb24sIG9wZXJhdGlvbiA9ICdwdXQnKSB7IC8vIENvbmR1Y3QgdGhlIHNwZWNpZmllZCB0YWcvc2lnbmF0dXJlIG9wZXJhdGlvbiBvbiB0aGUgcGVyc2lzdGVudCBzdG9yZS4gUmV0dXJuIHRhZ1xuICAgIGNvbnN0IHt0YWcsIHNpZ25hdHVyZX0gPSB2YWxpZGF0aW9uO1xuICAgIGNvbnN0IHNpZ25hdHVyZVN0cmluZyA9IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gICAgY29uc3Qgc3RvcmFnZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBhd2FpdCBzdG9yYWdlW29wZXJhdGlvbl0odGFnLCBzaWduYXR1cmVTdHJpbmcpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBEaXNwYXRjaCB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHZlcmlmaWVkfSkpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gQW5zd2VycyB0aGUgQ29sbGVjdGlvbiB0aGF0IGVtaXRzIGluZGl2aWR1YWwgdXBkYXRlcy4gKFNlZSBvdmVycmlkZSBpbiBWZXJzaW9uZWRDb2xsZWN0aW9uLilcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHN5bmNocm9uaXplcnMgPSBuZXcgTWFwKCk7IC8vIHNlcnZpY2VJbmZvIG1pZ2h0IG5vdCBiZSBhIHN0cmluZy5cbiAgbWFwU3luY2hyb25pemVycyhmKSB7IC8vIE9uIFNhZmFyaSwgTWFwLnZhbHVlcygpLm1hcCBpcyBub3QgYSBmdW5jdGlvbiFcbiAgICBjb25zdCByZXN1bHRzID0gW107XG4gICAgZm9yIChjb25zdCBzeW5jaHJvbml6ZXIgb2YgdGhpcy5zeW5jaHJvbml6ZXJzLnZhbHVlcygpKSB7XG4gICAgICByZXN1bHRzLnB1c2goZihzeW5jaHJvbml6ZXIpKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cbiAgZ2V0IHNlcnZpY2VzKCkge1xuICAgIHJldHVybiBBcnJheS5mcm9tKHRoaXMuc3luY2hyb25pemVycy5rZXlzKCkpO1xuICB9XG4gIC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGNvbm5lY3QsIGFuZCBkZWZpbmUgc3luY2hyb25pemUgdG8gYXdhaXQgY29ubmVjdCwgc3luY2hyb25pemF0aW9uQ29tcGxldGUsIGRpc2Nvbm5uZWN0LlxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBTdGFydCBydW5uaW5nIHRoZSBzcGVjaWZpZWQgc2VydmljZXMgKGluIGFkZGl0aW9uIHRvIHdoYXRldmVyIGlzIGFscmVhZHkgcnVubmluZykuXG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBpZiAoc3luY2hyb25pemVycy5oYXMoc2VydmljZSkpIGNvbnRpbnVlO1xuICAgICAgYXdhaXQgU3luY2hyb25pemVyLmNyZWF0ZSh0aGlzLCBzZXJ2aWNlKTsgLy8gUmVhY2hlcyBpbnRvIG91ciBzeW5jaHJvbml6ZXJzIG1hcCBhbmQgc2V0cyBpdHNlbGYgaW1tZWRpYXRlbHkuXG4gICAgfVxuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHMgPT4gcy5ib3RoU2lkZXNDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24pKTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIFNodXQgZG93biB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBjb25zdCBzeW5jaHJvbml6ZXIgPSBzeW5jaHJvbml6ZXJzLmdldChzZXJ2aWNlKTtcbiAgICAgIGlmICghc3luY2hyb25pemVyKSB7XG5cdC8vY29uc29sZS53YXJuKGAke3RoaXMuZnVsbExhYmVsfSBkb2VzIG5vdCBoYXZlIGEgc2VydmljZSBuYW1lZCAnJHtzZXJ2aWNlfScgdG8gZGlzY29ubmVjdC5gKTtcblx0Y29udGludWU7XG4gICAgICB9XG4gICAgICBhd2FpdCBzeW5jaHJvbml6ZXIuZGlzY29ubmVjdCgpO1xuICAgIH1cbiAgfVxuICBhc3luYyBlbnN1cmVTeW5jaHJvbml6ZXIoc2VydmljZU5hbWUsIGNvbm5lY3Rpb24sIGRhdGFDaGFubmVsKSB7IC8vIE1ha2Ugc3VyZSBkYXRhQ2hhbm5lbCBtYXRjaGVzIHRoZSBzeW5jaHJvbml6ZXIsIGNyZWF0aW5nIFN5bmNocm9uaXplciBvbmx5IGlmIG1pc3NpbmcuXG4gICAgbGV0IHN5bmNocm9uaXplciA9IHRoaXMuc3luY2hyb25pemVycy5nZXQoc2VydmljZU5hbWUpO1xuICAgIGlmICghc3luY2hyb25pemVyKSB7XG4gICAgICBzeW5jaHJvbml6ZXIgPSBuZXcgU3luY2hyb25pemVyKHtzZXJ2aWNlTmFtZSwgY29sbGVjdGlvbjogdGhpcywgZGVidWc6IHRoaXMuZGVidWd9KTtcbiAgICAgIHN5bmNocm9uaXplci5jb25uZWN0aW9uID0gY29ubmVjdGlvbjtcbiAgICAgIHN5bmNocm9uaXplci5kYXRhQ2hhbm5lbFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZGF0YUNoYW5uZWwpO1xuICAgICAgdGhpcy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgc3luY2hyb25pemVyKTtcbiAgICAgIC8vIERvZXMgTk9UIHN0YXJ0IHN5bmNocm9uaXppbmcuIENhbGxlciBtdXN0IGRvIHRoYXQgaWYgZGVzaXJlZC4gKFJvdXRlciBkb2Vzbid0IG5lZWQgdG8uKVxuICAgIH0gZWxzZSBpZiAoKHN5bmNocm9uaXplci5jb25uZWN0aW9uICE9PSBjb25uZWN0aW9uKSB8fFxuXHQgICAgICAgKHN5bmNocm9uaXplci5jaGFubmVsTmFtZSAhPT0gZGF0YUNoYW5uZWwubGFiZWwpIHx8XG5cdCAgICAgICAoYXdhaXQgc3luY2hyb25pemVyLmRhdGFDaGFubmVsUHJvbWlzZSAhPT0gZGF0YUNoYW5uZWwpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVubWF0Y2hlZCBjb25uZWN0aW9uIGZvciAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgfVxuXG4gIHByb21pc2Uoa2V5LCB0aHVuaykgeyByZXR1cm4gdGh1bms7IH0gLy8gVE9ETzogaG93IHdpbGwgd2Uga2VlcCB0cmFjayBvZiBvdmVybGFwcGluZyBkaXN0aW5jdCBzeW5jcz9cbiAgc3luY2hyb25pemUxKHRhZykgeyAvLyBDb21wYXJlIGFnYWluc3QgYW55IHJlbWFpbmluZyB1bnN5bmNocm9uaXplZCBkYXRhLCBmZXRjaCB3aGF0J3MgbmVlZGVkLCBhbmQgcmVzb2x2ZSBsb2NhbGx5LlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IHN5bmNocm9uaXplci5zeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZVRhZ3MoKSB7IC8vIEVuc3VyZSB0aGF0IHdlIGhhdmUgdXAgdG8gZGF0ZSB0YWcgbWFwIGFtb25nIGFsbCBzZXJ2aWNlcy4gKFdlIGRvbid0IGNhcmUgeWV0IG9mIHRoZSB2YWx1ZXMgYXJlIHN5bmNocm9uaXplZC4pXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgndGFncycsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplRGF0YSgpIHsgLy8gTWFrZSB0aGUgZGF0YSB0byBtYXRjaCBvdXIgdGFnbWFwLCB1c2luZyBzeW5jaHJvbml6ZTEuXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgnZGF0YScsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIHNldCBvbnVwZGF0ZShoYW5kbGVyKSB7IC8vIEFsbG93IHNldHRpbmcgaW4gbGlldSBvZiBhZGRFdmVudExpc3RlbmVyLlxuICAgIGlmIChoYW5kbGVyKSB7XG4gICAgICB0aGlzLl91cGRhdGUgPSBoYW5kbGVyO1xuICAgICAgdGhpcy5hZGRFdmVudExpc3RlbmVyKCd1cGRhdGUnLCBoYW5kbGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5yZW1vdmVFdmVudExpc3RlbmVyKCd1cGRhdGUnLCB0aGlzLl91cGRhdGUpO1xuICAgICAgdGhpcy5fdXBkYXRlID0gaGFuZGxlcjtcbiAgICB9XG4gIH1cbiAgZ2V0IG9udXBkYXRlKCkgeyAvLyBBcyBzZXQgYnkgdGhpcy5vbnVwZGF0ZSA9IGhhbmRsZXIuIERvZXMgTk9UIGFuc3dlciB0aGF0IHdoaWNoIGlzIHNldCBieSBhZGRFdmVudExpc3RlbmVyLlxuICAgIHJldHVybiB0aGlzLl91cGRhdGU7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIEltbXV0YWJsZUNvbGxlY3Rpb24gZXh0ZW5kcyBDb2xsZWN0aW9uIHtcbiAgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gSWdub3JlcyB0YWcuIEp1c3QgdGhlIGhhc2guXG4gICAgcmV0dXJuIHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgfVxuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgeyAvLyBPdmVycmlkZXMgc3VwZXIgYnkgYWxsb3dpbmcgRUFSTElFUiByYXRoZXIgdGhhbiBsYXRlci5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICBpZiAodmVyaWZpZWQubGVuZ3RoICYmICh0YWcgIT09IHByb3Bvc2VkLnN1YikpIHJldHVybiAnd3JvbmcgdGFnJztcbiAgICAgIGlmICghYXdhaXQgdGhpcy5zdWJqZWN0TWF0Y2godmVyaWZpZWQpKSByZXR1cm4gJ3dyb25nIGhhc2gnO1xuICAgICAgcmV0dXJuIG51bGw7IC8vIEZpcnN0IHdyaXRlIG9rLlxuICAgIH1cbiAgICAvLyBObyBvd25lciBtYXRjaC4gTm90IHJlbGV2YW50IGZvciBpbW11dGFibGVzLlxuICAgIGlmICghdmVyaWZpZWQucGF5bG9hZC5sZW5ndGggJiYgKHByb3Bvc2VkLmlhdCA+IGV4aXN0aW5nLmlhdCkpIHJldHVybiBudWxsOyAvLyBMYXRlciBkZWxldGUgaXMgb2suXG4gICAgaWYgKHByb3Bvc2VkLmlhdCA+IGV4aXN0aW5nLmlhdCkgcmV0dXJuICdyZXdyaXRlJzsgLy8gT3RoZXJ3aXNlLCBsYXRlciB3cml0ZXMgYXJlIG5vdC5cbiAgICBpZiAocHJvcG9zZWQuc3ViICE9PSBleGlzdGluZy5zdWIpIHJldHVybiAnYWx0ZXJlZCBjb250ZW50cyc7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmV4cG9ydCBjbGFzcyBNdXRhYmxlQ29sbGVjdGlvbiBleHRlbmRzIENvbGxlY3Rpb24ge1xuICB0YWdGb3JXcml0aW5nKHRhZywgdmFsaWRhdGlvbikgeyAvLyBVc2UgdGFnIGlmIHNwZWNpZmllZCwgYnV0IGRlZmF1bHRzIHRvIGhhc2guXG4gICAgcmV0dXJuIHRhZyB8fCB2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gIH1cbn1cblxuLy8gRWFjaCBWZXJzaW9uZWRDb2xsZWN0aW9uIGhhcyBhIHNldCBvZiBoYXNoLWlkZW50aWZpZWQgaW1tdXRhYmxlIGl0ZW1zIHRoYXQgZm9ybSB0aGUgaW5kaXZpZHVhbCB2ZXJzaW9ucywgYW5kIGEgbWFwIG9mIHRpbWVzdGFtcHMgdG8gdGhvc2UgaXRlbXMuXG4vLyBXZSBjdXJyZW50bHkgbW9kZWwgdGhpcyBieSBoYXZpbmcgdGhlIG1haW4gY29sbGVjdGlvbiBiZSB0aGUgbXV0YWJsZSBtYXAsIGFuZCB0aGUgdmVyc2lvbnMgaW5zdGFuY2UgdmFyaWFibGUgaXMgdGhlIGltbXV0YWJsZSBpdGVtcyBjb2xsZWN0aW9uLlxuLy8gQnV0IGFwcHMgc3RvcmUvcmV0cmlldmUgaW5kaXZpZHVhbCBpdGVtcyB0aHJvdWdoIHRoZSBtYWluIGNvbGxlY3Rpb24sIGFuZCB0aGUgY29ycmVzcG9uZGluZyB1cGRhdGVzIGFyZSB0aHJvdWdoIHRoZSB2ZXJzaW9ucywgd2hpY2ggaXMgYSBiaXQgYXdrd2FyZC5cblxuLy8gRWFjaCBpdGVtIGhhcyBhbiBhbnRlY2VkZW50IHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGFwcGxpY2F0aW9uLXN1cHBsaWVkIHBheWxvYWQgLS0gaXQgbGl2ZXMgaW4gdGhlIHNpZ25hdHVyZSdzIGhlYWRlci5cbi8vIEhvd2V2ZXI6XG4vLyAtIFRoZSB0YWcgRE9FUyBpbmNsdWRlIHRoZSBhbnRlY2VkZW50LCBldmVuIHRob3VnaCBpdCBpcyBub3QgcGFydCBvZiB0aGUgcGF5bG9hZC4gVGhpcyBtYWtlcyBpZGVudGljYWwgcGF5bG9hZHMgaGF2ZVxuLy8gICB1bmlxdWUgdGFncyAoYmVjYXVzZSB0aGV5IHdpbGwgYWx3YXlzIGhhdmUgZGlmZmVyZW50IGFudGVjZWRlbnRzKS5cbi8vIC0gVGhlIGFiaWxpdHkgdG8gd3JpdGUgZm9sbG93cyB0aGUgc2FtZSBydWxlcyBhcyBNdXRhYmxlQ29sbGVjdGlvbiAobGF0ZXN0IHdpbnMpLCBidXQgaXMgdGVzdGVkIGFnYWluc3QgdGhlXG4vLyAgIGFudGVjZWRlbnQgdGFnIGluc3RlYWQgb2YgdGhlIHRhZyBiZWluZyB3cml0dGVuLlxuZXhwb3J0IGNsYXNzIFZlcnNpb25Db2xsZWN0aW9uIGV4dGVuZHMgTXV0YWJsZUNvbGxlY3Rpb24geyAvLyBOZWVkcyB0byBiZSBleHBvcnRlZCBzbyB0aGF0IHRoYXQgcm91dGVyLm1qcyBjYW4gZmluZCBpdC5cbiAgYXN5bmMgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gVXNlIHRhZyBpZiBzcGVjaWZpZWQgKGUuZy4sIHB1dC9kZWxldGUgZHVyaW5nIHN5bmNocm9uaXphdGlvbiksIG90aHdlcndpc2UgcmVmbGVjdCBib3RoIHN1YiBhbmQgYW50ZWNlZGVudC5cbiAgICBpZiAodGFnKSByZXR1cm4gdGFnO1xuICAgIC8vIEVhY2ggdmVyc2lvbiBnZXRzIGEgdW5pcXVlIHRhZyAoZXZlbiBpZiB0aGVyZSBhcmUgdHdvIHZlcnNpb25zIHRoYXQgaGF2ZSB0aGUgc2FtZSBkYXRhIHBheWxvYWQpLlxuICAgIGNvbnN0IGFudCA9IHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLmFudDtcbiAgICBjb25zdCBwYXlsb2FkVGV4dCA9IHZhbGlkYXRpb24udGV4dCB8fCBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUodmFsaWRhdGlvbi5wYXlsb2FkKTtcbiAgICByZXR1cm4gQ3JlZGVudGlhbHMuZW5jb2RlQmFzZTY0dXJsKGF3YWl0IENyZWRlbnRpYWxzLmhhc2hUZXh0KGFudCArIHBheWxvYWRUZXh0KSk7XG4gIH1cbiAgYW50ZWNlZGVudCh2YWxpZGF0aW9uKSB7IC8vIFJldHVybnMgdGhlIHRhZyB0aGF0IHZhbGlkYXRpb24gY29tcGFyZXMgYWdhaW5zdC4gRS5nLiwgZG8gdGhlIG93bmVycyBtYXRjaD9cbiAgICAvLyBGb3Igbm9uLXZlcnNpb25lZCBjb2xsZWN0aW9ucywgd2UgY29tcGFyZSBhZ2FpbnN0IHRoZSBleGlzdGluZyBkYXRhIGF0IHRoZSBzYW1lIHRhZyBiZWluZyB3cml0dGVuLlxuICAgIC8vIEZvciB2ZXJzaW9uZWQgY29sbGVjdGlvbnMsIGl0IGlzIHdoYXQgZXhpc3RzIGFzIHRoZSBsYXRlc3QgdmVyc2lvbiB3aGVuIHRoZSBkYXRhIGlzIHNpZ25lZCwgYW5kIHdoaWNoIHRoZSBzaWduYXR1cmVcbiAgICAvLyByZWNvcmRzIGluIHRoZSBzaWduYXR1cmUuIChGb3IgdGhlIHZlcnkgZmlyc3QgdmVyc2lvbiwgdGhlIHNpZ25hdHVyZSB3aWxsIG5vdGUgdGhlIHRpbWVzdGFtcCBhcyB0aGUgYW50ZWNlY2RlbnQgdGFnLFxuICAgIC8vIChzZWUgdGFnRm9yV3JpdGluZyksIGJ1dCBmb3IgY29tcGFyaW5nIGFnYWluc3QsIHRoaXMgbWV0aG9kIGFuc3dlcnMgZmFsc3kgZm9yIHRoZSBmaXJzdCBpbiB0aGUgY2hhaW4uXG4gICAgY29uc3QgaGVhZGVyID0gdmFsaWRhdGlvbj8ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGlmICghaGVhZGVyKSByZXR1cm4gJyc7XG4gICAgY29uc3QgYW50ZWNlZGVudCA9IGhlYWRlci5hbnQ7XG4gICAgaWYgKHR5cGVvZihhbnRlY2VkZW50KSA9PT0gJ251bWJlcicpIHJldHVybiAnJzsgLy8gQSB0aW1lc3RhbXAgYXMgYW50ZWNlZGVudCBpcyB1c2VkIHRvIHRvIHN0YXJ0IHRoaW5ncyBvZmYuIE5vIHRydWUgYW50ZWNlZGVudC5cbiAgICByZXR1cm4gYW50ZWNlZGVudDtcbiAgfVxuICBhc3luYyBzdWJqZWN0TWF0Y2godmVyaWZpZWQpIHsgLy8gSGVyZSBzdWIgcmVmZXJzIHRvIHRoZSBvdmVyYWxsIGl0ZW0gdGFnIHRoYXQgZW5jb21wYXNzZXMgYWxsIHZlcnNpb25zLCBub3QgdGhlIHBheWxvYWQgaGFzaC5cbiAgICByZXR1cm4gdHJ1ZTsgLy8gVE9ETzogbWFrZSBzdXJlIGl0IG1hdGNoZXMgcHJldmlvdXM/XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBzdWJqZWN0VGFnIChpLmUuLCB0aGUgdGFnIHdpdGhpbiB0aGUgY29sbGVjdGlvbiBhcyBhIHdob2xlKSBpcyBub3QgdGhlIHRhZy9oYXNoLlxuICAgIHZlcmlmaWVkLnN1YmplY3RUYWcgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICAgIHN1cGVyLmVtaXQodmVyaWZpZWQpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBWZXJzaW9uZWRDb2xsZWN0aW9uIGV4dGVuZHMgTXV0YWJsZUNvbGxlY3Rpb24ge1xuICAvLyBUT0RPOiBUaGlzIHdvcmtzIGFuZCBkZW1vbnN0cmF0ZXMgaGF2aW5nIGEgY29sbGVjdGlvbiB1c2luZyBvdGhlciBjb2xsZWN0aW9ucy5cbiAgLy8gSG93ZXZlciwgaGF2aW5nIGEgYmlnIHRpbWVzdGFtcCA9PiBmaXhudW0gbWFwIGlzIGJhZCBmb3IgcGVyZm9ybWFuY2UgYXMgdGhlIGhpc3RvcnkgZ2V0cyBsb25nZXIuXG4gIC8vIFRoaXMgc2hvdWxkIGJlIHNwbGl0IHVwIGludG8gd2hhdCBpcyBkZXNjcmliZWQgaW4gdmVyc2lvbmVkLm1kLlxuICBjb25zdHJ1Y3Rvcih7c2VydmljZXMgPSBbXSwgLi4ucmVzdH0gPSB7fSkge1xuICAgIHN1cGVyKHJlc3QpOyAgLy8gV2l0aG91dCBwYXNzaW5nIHNlcnZpY2VzIHlldCwgYXMgd2UgZG9uJ3QgaGF2ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiBzZXQgdXAgeWV0LlxuICAgIHRoaXMudmVyc2lvbnMgPSBuZXcgVmVyc2lvbkNvbGxlY3Rpb24ocmVzdCk7IC8vIFNhbWUgY29sbGVjdGlvbiBuYW1lLCBidXQgZGlmZmVyZW50IHR5cGUuXG4gICAgLy9maXhtZSB0aGlzLnZlcnNpb25zLmFkZEV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIGV2ZW50ID0+IHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHRoaXMucmVjb3ZlclRhZyhldmVudC5kZXRhaWwpfSkpKTtcbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTsgLy8gTm93IHdlIGNhbiBzeW5jaHJvbml6ZS5cbiAgfVxuICBhc3luYyBjbG9zZSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmNsb3NlKCk7XG4gICAgYXdhaXQgc3VwZXIuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVzdHJveSgpO1xuICAgIGF3YWl0IHN1cGVyLmRlc3Ryb3koKTtcbiAgfVxuICByZWNvdmVyVGFnKHZlcmlmaWVkKSB7IC8vIHRoZSB2ZXJpZmllZC50YWcgaXMgZm9yIHRoZSB2ZXJzaW9uLiBXZSB3YW50IHRoZSBvdmVyYWxsIG9uZS5cbiAgICByZXR1cm4gT2JqZWN0LmFzc2lnbih7fSwgdmVyaWZpZWQsIHt0YWc6IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWJ9KTsgLy8gRG8gbm90IGJhc2ggdmVyaWZpZWQhXG4gIH1cbiAgc2VydmljZUZvclZlcnNpb24oc2VydmljZSkgeyAvLyBHZXQgdGhlIHNlcnZpY2UgXCJuYW1lXCIgZm9yIG91ciB2ZXJzaW9ucyBjb2xsZWN0aW9uLlxuICAgIHJldHVybiBzZXJ2aWNlPy52ZXJzaW9ucyB8fCBzZXJ2aWNlOyAgIC8vIEZvciB0aGUgd2VpcmQgY29ubmVjdERpcmVjdFRlc3RpbmcgY2FzZSB1c2VkIGluIHJlZ3Jlc3Npb24gdGVzdHMsIGVsc2UgdGhlIHNlcnZpY2UgKGUuZy4sIGFuIGFycmF5IG9mIHNpZ25hbHMpLlxuICB9XG4gIHNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykge1xuICAgIHJldHVybiBzZXJ2aWNlcy5tYXAoc2VydmljZSA9PiB0aGlzLnNlcnZpY2VGb3JWZXJzaW9uKHNlcnZpY2UpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBzeW5jaHJvbml6ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiwgdG9vLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSByZXR1cm47XG4gICAgLy8gS2VlcCBjaGFubmVsIGNyZWF0aW9uIHN5bmNocm9ub3VzLlxuICAgIGNvbnN0IHZlcnNpb25lZFByb21pc2UgPSBzdXBlci5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgdmVyc2lvblByb21pc2UgPSB0aGlzLnZlcnNpb25zLnN5bmNocm9uaXplKC4uLnRoaXMuc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSk7XG4gICAgYXdhaXQgdmVyc2lvbmVkUHJvbWlzZTtcbiAgICBhd2FpdCB2ZXJzaW9uUHJvbWlzZTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIGRpc2Nvbm5lY3QgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24sIHRvby5cbiAgICBpZiAoIXNlcnZpY2VzLmxlbmd0aCkgc2VydmljZXMgPSB0aGlzLnNlcnZpY2VzO1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGlzY29ubmVjdCguLi50aGlzLnNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykpO1xuICAgIGF3YWl0IHN1cGVyLmRpc2Nvbm5lY3QoLi4uc2VydmljZXMpO1xuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gc3VwZXIuc3luY2hyb25pemVkLnRoZW4oKCkgPT4gdGhpcy52ZXJzaW9ucy5zeW5jaHJvbml6ZWQpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gVGhlIHZlcnNpb25zIGNvbGxlY3Rpb24gZW1pdHMgYW4gdXBkYXRlIGNvcnJlc3BvbmRpbmcgdG8gdGhlIGluZGl2aWR1YWwgaXRlbSBzdG9yZWQuXG4gICAgLy8gKFRoZSB1cGRhdGVzIGVtaXR0ZWQgZnJvbSB0aGUgd2hvbGUgbXV0YWJsZSBWZXJzaW9uZWRDb2xsZWN0aW9uIGNvcnJlc3BvbmQgdG8gdGhlIG1hcC4pXG4gICAgcmV0dXJuIHRoaXMudmVyc2lvbnM7XG4gIH1cblxuICBhc3luYyBnZXRWZXJzaW9ucyh0YWcpIHsgLy8gUHJvbWlzZXMgdGhlIHBhcnNlZCB0aW1lc3RhbXAgPT4gdmVyc2lvbiBkaWN0aW9uYXJ5IElGIGl0IGV4aXN0cywgZWxzZSBmYWxzeS5cbiAgICB0aGlzLnJlcXVpcmVUYWcodGFnKTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZ30pO1xuICAgIGNvbnN0IGpzb24gPSB2ZXJpZmllZD8uanNvbjtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoanNvbikpIHJldHVybiBqc29uO1xuICAgIC8vIElmIHdlIGhhdmUgYW4gdW5tZXJnZWQgYXJyYXkgb2Ygc2lnbmF0dXJlcy4uLlxuICAgIC8vIEknbSBub3Qgc3VyZSB0aGF0IGl0J3MgdmVyeSB1c2VmdWwgdG8gYXBwbGljYXRpb25zIGZvciB1cyB0byBoYW5kbGUgdGhpcyBjYXNlLCBidXQgaXQgaXMgbmljZSB0byBleGVyY2lzZSB0aGlzIGluIHRlc3RpbmcuXG4gICAgY29uc3QgdmVyaWZpY2F0aW9uc0FycmF5ID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHRoaXMuY29tYmluZVRpbWVzdGFtcHModGFnLCBudWxsLCAuLi52ZXJpZmljYXRpb25zQXJyYXkubWFwKHYgPT4gdi5qc29uKSk7XG4gIH1cbiAgYXN5bmMgcmV0cmlldmVUaW1lc3RhbXBzKHRhZykgeyAvLyBQcm9taXNlcyBhIGxpc3Qgb2YgYWxsIHZlcnNpb24gdGltZXN0YW1wcy5cbiAgICBjb25zdCB2ZXJzaW9ucyA9IGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKTtcbiAgICBpZiAoIXZlcnNpb25zKSByZXR1cm4gdmVyc2lvbnM7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHZlcnNpb25zKS5zbGljZSgxKS5tYXAoc3RyaW5nID0+IHBhcnNlSW50KHN0cmluZykpOyAvLyBUT0RPPyBNYXAgdGhlc2UgdG8gaW50ZWdlcnM/XG4gIH1cbiAgZ2V0QWN0aXZlSGFzaCh0aW1lc3RhbXBzLCB0aW1lID0gdGltZXN0YW1wcy5sYXRlc3QpIHsgLy8gUHJvbWlzZXMgdGhlIHZlcnNpb24gdGFnIHRoYXQgd2FzIGluIGZvcmNlIGF0IHRoZSBzcGVjaWZpZWQgdGltZVxuICAgIC8vICh3aGljaCBtYXkgYmVmb3JlLCBpbiBiZXR3ZWVuLCBvciBhZnRlciB0aGUgcmVjb3JkZWQgZGlzY3JldGUgdGltZXN0YW1wcykuXG4gICAgaWYgKCF0aW1lc3RhbXBzKSByZXR1cm4gdGltZXN0YW1wcztcbiAgICBsZXQgaGFzaCA9IHRpbWVzdGFtcHNbdGltZV07XG4gICAgaWYgKGhhc2gpIHJldHVybiBoYXNoO1xuICAgIC8vIFdlIG5lZWQgdG8gZmluZCB0aGUgdGltZXN0YW1wIHRoYXQgd2FzIGluIGZvcmNlIGF0IHRoZSByZXF1ZXN0ZWQgdGltZS5cbiAgICBsZXQgYmVzdCA9IDAsIHRpbWVzID0gT2JqZWN0LmtleXModGltZXN0YW1wcyk7XG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPCB0aW1lcy5sZW5ndGg7IGkrKykgeyAvLyAwdGggaXMgdGhlIGtleSAnbGF0ZXN0Jy5cbiAgICAgIGlmICh0aW1lc1tpXSA8PSB0aW1lKSBiZXN0ID0gdGltZXNbaV07XG4gICAgICBlbHNlIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4gdGltZXN0YW1wc1tiZXN0XTtcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gQW5zd2VyIHRoZSB2YWxpZGF0ZWQgdmVyc2lvbiBpbiBmb3JjZSBhdCB0aGUgc3BlY2lmaWVkIHRpbWUgKG9yIGxhdGVzdCksIG9yIGF0IHRoZSBzcGVjaWZpYyBoYXNoLlxuICAgIGxldCB7dGFnLCB0aW1lLCBoYXNoLCAuLi5yZXN0fSA9ICghdGFnT3JPcHRpb25zIHx8IHRhZ09yT3B0aW9ucy5sZW5ndGgpID8ge3RhZzogdGFnT3JPcHRpb25zfSA6IHRhZ09yT3B0aW9ucztcbiAgICBpZiAoIWhhc2gpIHtcbiAgICAgIGNvbnN0IHRpbWVzdGFtcHMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgICBpZiAoIXRpbWVzdGFtcHMpIHJldHVybiB0aW1lc3RhbXBzO1xuICAgICAgaGFzaCA9IHRoaXMuZ2V0QWN0aXZlSGFzaCh0aW1lc3RhbXBzLCB0aW1lKTtcbiAgICAgIGlmICghaGFzaCkgcmV0dXJuICcnO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy52ZXJzaW9ucy5yZXRyaWV2ZSh7dGFnOiBoYXNoLCAuLi5yZXN0fSk7XG4gIH1cbiAgYXN5bmMgc3RvcmUoZGF0YSwgb3B0aW9ucyA9IHt9KSB7IC8vIERldGVybWluZSB0aGUgYW50ZWNlZGVudCwgcmVjb3JkIGl0IGluIHRoZSBzaWduYXR1cmUsIGFuZCBzdG9yZSB0aGF0XG4gICAgLy8gYXMgdGhlIGFwcHJvcHJpYXRlIHZlcnNpb24gaGFzaC4gVGhlbiByZWNvcmQgdGhlIG5ldyB0aW1lc3RhbXAvaGFzaCBpbiB0aGUgdGltZXN0YW1wcyBsaXN0LlxuICAgIGxldCB2ZXJzaW9ucyxcblx0Ly8gVE9ETzogQ29uc2lkZXIgZW5jcnlwdGluZyB0aGUgdGltZXN0YW1wcywgdG9vLlxuXHQvLyBDdXJyZW50bHksIHNpZ25pbmdPcHRpb25zIGZvciB0aGUgdGltZXN0YW1wcyBkb2VzIE5PVCBlbmNsdWRlIGVuY3J5cHRpb24sIGV2ZW4gaWYgc3BlY2lmaWVkIGZvciB0aGUgYWN0dWFsIHNwZWNpZmljIHZlcnNpb24gaW5mby5cblx0Ly8gVGhpcyBtZWFucyB0aGF0IGlmIHRoZSBhcHBsaWNhdGlvbiBzcGVjaWZpZXMgYW4gZW5jcnlwdGVkIHZlcnNpb25lZCBjb2xsZWN0aW9uLCB0aGUgZGF0YSBpdHNlbGYgd2lsbCBiZSBlbmNyeXB0ZWQsIGJ1dFxuXHQvLyBub3QgdGhlIG1hcCBvZiB0aW1lc3RhbXBzIHRvIGhhc2hlcywgYW5kIHNvIGEgbHVya2VyIGNhbiBzZWUgd2hlbiB0aGVyZSB3YXMgYWN0aXZpdGl0eSBhbmQgaGF2ZSBhbiBpZGVhIGFzIHRvIHRoZSBzaXplLlxuXHQvLyBPZiBjb3Vyc2UsIGV2ZW4gaWYgZW5jcnlwdGVkLCB0aGV5IGNvdWxkIGFsc28gZ2V0IHRoaXMgZnJvbSBsaXZlIHRyYWZmaWMgYW5hbHlzaXMsIHNvIG1heWJlIGVuY3J5cHRpbmcgaXQgd291bGQganVzdFxuXHQvLyBjb252ZXkgYSBmYWxzZSBzZW5zZSBvZiBzZWN1cml0eS4gRW5jcnlwdGluZyB0aGUgdGltZXN0YW1wcyBkb2VzIGNvbXBsaWNhdGUsIGUuZy4sIG1lcmdlU2lnbmF0dXJlcygpIGJlY2F1c2Vcblx0Ly8gc29tZSBvZiB0aGUgd29yayBjb3VsZCBvbmx5IGJlIGRvbmUgYnkgcmVsYXlzIHRoYXQgaGF2ZSBhY2Nlc3MuIEJ1dCBzaW5jZSB3ZSBoYXZlIHRvIGJlIGNhcmVmdWwgYWJvdXQgc2lnbmluZyBhbnl3YXksXG5cdC8vIHdlIHNob3VsZCB0aGVvcmV0aWNhbGx5IGJlIGFibGUgdG8gYmUgYWNjb21vZGF0ZSB0aGF0LlxuXHR7dGFnLCBlbmNyeXB0aW9uLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpLFxuXHR0aW1lID0gRGF0ZS5ub3coKSxcblx0dmVyc2lvbk9wdGlvbnMgPSBPYmplY3QuYXNzaWduKHt0aW1lLCBlbmNyeXB0aW9ufSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIGlmICh0YWcpIHtcbiAgICAgIHZlcnNpb25zID0gKGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKSkgfHwge307XG4gICAgICB2ZXJzaW9uT3B0aW9ucy5zdWIgPSB0YWc7XG4gICAgICBpZiAodmVyc2lvbnMpIHtcblx0dmVyc2lvbk9wdGlvbnMuYW50ID0gdmVyc2lvbnNbdmVyc2lvbnMubGF0ZXN0XTtcbiAgICAgIH1cbiAgICB9IC8vIEVsc2UgZG8gbm90IGFzc2lnbiBzdWIuIEl0IHdpbGwgYmUgc2V0IHRvIHRoZSBwYXlsb2FkIGhhc2ggZHVyaW5nIHNpZ25pbmcsIGFuZCBhbHNvIHVzZWQgZm9yIHRoZSBvdmVyYWxsIHRhZy5cbiAgICB2ZXJzaW9uT3B0aW9ucy5hbnQgfHw9IHRpbWU7XG4gICAgY29uc3QgaGFzaCA9IGF3YWl0IHRoaXMudmVyc2lvbnMuc3RvcmUoZGF0YSwgdmVyc2lvbk9wdGlvbnMpO1xuICAgIGlmICghdGFnKSB7IC8vIFdlJ2xsIHN0aWxsIG5lZWQgdGFnIGFuZCB2ZXJzaW9ucy5cbiAgICAgIGNvbnN0IHZlcnNpb25TaWduYXR1cmUgPSBhd2FpdCB0aGlzLnZlcnNpb25zLmdldChoYXNoKTtcbiAgICAgIGNvbnN0IGNsYWltcyA9IENyZWRlbnRpYWxzLmRlY29kZUNsYWltcyh0aGlzLmNvbnN0cnVjdG9yLm1heWJlSW5mbGF0ZSh2ZXJzaW9uU2lnbmF0dXJlKSk7XG4gICAgICB0YWcgPSBjbGFpbXMuc3ViO1xuICAgICAgdmVyc2lvbnMgPSB7fTtcbiAgICB9XG4gICAgdmVyc2lvbnMubGF0ZXN0ID0gdGltZTtcbiAgICB2ZXJzaW9uc1t0aW1lXSA9IGhhc2g7XG5cbiAgICAvLyBmaXhtZSBuZXh0XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKHZlcnNpb25zLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgLy8gSGVyZSB3ZSBhcmUgZG9pbmcgd2hhdCB0aGlzLnB1dCgpIHdvdWxkIG5vcm1hbGx5IGRvLCBidXQgd2UgaGF2ZSBhbHJlYWR5IG1lcmdlZCBzaWduYXR1cmVzLlxuICAgIGF3YWl0IHRoaXMuYWRkVGFnKHRhZyk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHRhZywgc2lnbmF0dXJlKTtcbiAgICB0aGlzLmVtaXQoe3RhZywgc3ViamVjdFRhZzogdGFnLCAuLi4oYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlKSl9KTtcbiAgICBhd2FpdCB0aGlzLnB1c2goJ3B1dCcsIHRhZywgc2lnbmF0dXJlKTtcbiAgICAvLyBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZpZWRTaWduKHZlcnNpb25zLCBzaWduaW5nT3B0aW9ucywgdGFnKTtcbiAgICAvLyB0aGlzLmxvZygncHV0KC1pc2gpJywgdmVyaWZpZWQpO1xuICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIodmVyaWZpZWQpO1xuICAgIC8vIGF3YWl0IHRoaXMuYWRkVGFnKHRhZyk7XG4gICAgLy8gdGhpcy5lbWl0KHsuLi52ZXJpZmllZCwgdGFnLCBzdWJqZWN0VGFnOiB0YWd9KTtcbiAgICAvLyBhd2FpdCB0aGlzLnB1c2goJ3B1dCcsIHRhZywgdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcodmVyaWZpZWQuc2lnbmF0dXJlKSk7XG5cbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIHJlbW92ZShvcHRpb25zID0ge30pIHsgLy8gQWRkIGFuIGVtcHR5IHZlcmlvbiBvciByZW1vdmUgYWxsIHZlcnNpb25zLCBkZXBlbmRpbmcgb24gdGhpcy5wcmVzZXJ2ZURlbGV0aW9ucy5cbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTsgLy8gSWdub3JlIGVuY3J5cHRpb25cbiAgICBjb25zdCB2ZXJzaW9ucyA9IGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKTtcbiAgICBpZiAoIXZlcnNpb25zKSByZXR1cm4gdmVyc2lvbnM7XG4gICAgaWYgKHRoaXMucHJlc2VydmVEZWxldGlvbnMpIHsgLy8gQ3JlYXRlIGEgdGltZXN0YW1wID0+IHZlcnNpb24gd2l0aCBhbiBlbXB0eSBwYXlsb2FkLiBPdGhlcndpc2UgbWVyZ2luZyB3aXRoIGVhcmxpZXIgZGF0YSB3aWxsIGJyaW5nIGl0IGJhY2shXG4gICAgICBhd2FpdCB0aGlzLnN0b3JlKCcnLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgfSBlbHNlIHsgLy8gQWN0dWFsbHkgZGVsZXRlIHRoZSB0aW1lc3RhbXBzIGFuZCBlYWNoIHZlcnNpb24uXG4gICAgICAvLyBmaXhtZSBuZXh0XG4gICAgICBjb25zdCB2ZXJzaW9uVGFncyA9IE9iamVjdC52YWx1ZXModmVyc2lvbnMpLnNsaWNlKDEpO1xuICAgICAgY29uc3QgdmVyc2lvblNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbignJywge3N1YjogdGFnLCAuLi5zaWduaW5nT3B0aW9uc30pO1xuICAgICAgLy8gVE9ETzogSXMgdGhpcyBzYWZlPyBTaG91bGQgd2UgbWFrZSBhIHNpZ25hdHVyZSB0aGF0IHNwZWNpZmllcyBlYWNoIGFudGVjZWRlbnQ/XG4gICAgICBhd2FpdCBQcm9taXNlLmFsbCh2ZXJzaW9uVGFncy5tYXAoYXN5bmMgdGFnID0+IHtcblx0YXdhaXQgdGhpcy52ZXJzaW9ucy5kZWxldGUodGFnLCB2ZXJzaW9uU2lnbmF0dXJlKTtcblx0YXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHZlcnNpb25TaWduYXR1cmUpO1xuICAgICAgfSkpO1xuICAgICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKCcnLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QodGFnLCBzaWduYXR1cmUsICdkZWxldGUnKTtcbiAgICAgIGF3YWl0IHRoaXMucHVzaCgnZGVsZXRlJywgdGFnLCBzaWduYXR1cmUpO1xuICAgICAgLy8gY29uc3QgdmVyc2lvbkhhc2hlcyA9IE9iamVjdC52YWx1ZXModmVyc2lvbnMpLnNsaWNlKDEpO1xuICAgICAgLy8gY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmaWVkU2lnbignJywge3N1YjogdGFnLCAuLi5zaWduaW5nT3B0aW9uc30sIHRhZyk7XG4gICAgICAvLyAvLyBUT0RPOiBJcyB0aGlzIHNhZmU/IFNob3VsZCB3ZSBtYWtlIGEgc2lnbmF0dXJlIHRoYXQgc3BlY2lmaWVzIGVhY2ggYW50ZWNlZGVudD9cbiAgICAgIC8vIGF3YWl0IFByb21pc2UuYWxsKHZlcnNpb25IYXNoZXMubWFwKGFzeW5jIGhhc2ggPT4ge1xuICAgICAgLy8gXHRsZXQgdlZlcmlmaWVkID0gey4uLnZlcmlmaWVkLCB0YWc6IGhhc2h9O1xuICAgICAgLy8gXHRsZXQgc1ZlcmlmaWVkID0gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcodlZlcmlmaWVkLnNpZ25hdHVyZSk7XG4gICAgICAvLyBcdC8vIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlVGFnKHRhZyk7XG4gICAgICAvLyBcdC8vIGF3YWl0IHRoaXMudmVyc2lvbnMucGVyc2lzdDIodlZlcmlmaWVkLCAnZGVsZXRlJyk7XG4gICAgICAvLyBcdC8vIHRoaXMudmVyc2lvbnMuZW1pdCh2VmVyaWZpZWQpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLnB1c2goJ2RlbGV0ZScsIHRhZywgc1ZlcmlmaWVkKTtcbiAgICAgIC8vIFx0YXdhaXQgdGhpcy52ZXJzaW9ucy5kZWxldGUodGFnLCBzVmVyaWZpZWQpO1xuICAgICAgLy8gXHRhd2FpdCB0aGlzLnZlcnNpb25zLnB1c2goJ2RlbGV0ZScsIHRhZywgc1ZlcmlmaWVkKVxuICAgICAgLy8gfSkpO1xuICAgICAgLy8gYXdhaXQgdGhpcy5wZXJzaXN0Mih2ZXJpZmllZCwgJ2RlbGV0ZScpO1xuICAgICAgLy8gYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZlcmlmaWVkLnNpZ25hdHVyZSkpO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLmRlbGV0ZVRhZyh0YWcpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgYXN5bmMgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlLCBhdXRob3JPdmVycmlkZSA9IG51bGwpIHsgLy8gTWVyZ2UgdGhlIG5ldyB0aW1lc3RhbXBzIHdpdGggdGhlIG9sZC5cbiAgICAvLyBJZiBwcmV2aW91cyBkb2Vzbid0IGV4aXN0IG9yIG1hdGNoZXMgdGhlIG5leHQsIG9yIGlzIGEgc3Vic2V0IG9mIHRoZSBuZXh0LCBqdXN0IHVzZSB0aGUgbmV4dC5cbiAgICAvLyBPdGhlcndpc2UsIHdlIGhhdmUgdG8gbWVyZ2U6XG4gICAgLy8gLSBNZXJnZWQgbXVzdCBjb250YWluIHRoZSB1bmlvbiBvZiB2YWx1ZXMgZm9yIGVpdGhlci5cbiAgICAvLyAgIChTaW5jZSB2YWx1ZXMgYXJlIGhhc2hlcyBvZiBzdHVmZiB3aXRoIGFuIGV4cGxpY2l0IGFudGVkZW50LCBuZXh0IHByZXZpb3VzIG5vciBuZXh0IHdpbGwgaGF2ZSBkdXBsaWNhdGVzIGJ5IHRoZW1zZWx2ZXMuLilcbiAgICAvLyAtIElmIHRoZXJlJ3MgYSBjb25mbGljdCBpbiBrZXlzLCBjcmVhdGUgYSBuZXcga2V5IHRoYXQgaXMgbWlkd2F5IGJldHdlZW4gdGhlIGNvbmZsaWN0IGFuZCB0aGUgbmV4dCBrZXkgaW4gb3JkZXIuXG5cbiAgICBsZXQgbmV4dCA9IHZhbGlkYXRpb247XG4gICAgbGV0IHByZXZpb3VzID0gdmFsaWRhdGlvbi5leGlzdGluZztcbiAgICAvL2ZpeG1lIG5leHRcbiAgICBpZiAoIXByZXZpb3VzKSByZXR1cm4gc2lnbmF0dXJlOyAgIC8vIE5vIHByZXZpb3VzLCBqdXN0IHVzZSBuZXcgc2lnbmF0dXJlLlxuICAgIC8vaWYgKCFwcmV2aW91cykgcmV0dXJuIG5leHQ7ICAgLy8gTm8gcHJldmlvdXMsIGp1c3QgbmV4dC5cblxuICAgIC8vIEF0IHRoaXMgcG9pbnQsIHByZXZpb3VzIGFuZCBuZXh0IGFyZSBib3RoIFwib3V0ZXJcIiB2YWxpZGF0aW9ucy5cbiAgICAvLyBUaGF0IGpzb24gY2FuIGJlIGVpdGhlciBhIHRpbWVzdGFtcCBvciBhbiBhcnJheSBvZiBzaWduYXR1cmVzLlxuICAgIGlmICh2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5pYXQgPCB2YWxpZGF0aW9uLmV4aXN0aW5nLnByb3RlY3RlZEhlYWRlci5pYXQpIHsgLy8gQXJyYW5nZSBmb3IgbmV4dCBhbmQgc2lnbmF0dXJlIHRvIGJlIGxhdGVyIG9uZSBieSBzaWduZWQgdGltZXN0YW1wLlxuICAgICAgLy8gVE9ETzogaXMgaXQgcG9zc2libGUgdG8gY29uc3RydWN0IGEgc2NlbmFyaW8gaW4gd2hpY2ggdGhlcmUgaXMgYSBmaWN0aXRpb3VzIHRpbWUgc3RhbXAgY29uZmxpY3QuIEUuZywgaWYgYWxsIG9mIHRoZXNlIGFyZSB0cnVlOlxuICAgICAgLy8gMS4gcHJldmlvdXMgYW5kIG5leHQgaGF2ZSBpZGVudGljYWwgdGltZXN0YW1wcyBmb3IgZGlmZmVyZW50IHZhbHVlcywgYW5kIHNvIHdlIG5lZWQgdG8gY29uc3RydWN0IGFydGlmaWNpYWwgdGltZXMgZm9yIG9uZS4gTGV0J3MgY2FsbCB0aGVzZSBicmFuY2ggQSBhbmQgQi5cbiAgICAgIC8vIDIuIHRoaXMgaGFwcGVucyB3aXRoIHRoZSBzYW1lIHRpbWVzdGFtcCBpbiBhIHNlcGFyYXRlIHBhaXIsIHdoaWNoIHdlJ2xsIGNhbGwgQTIsIGFuZCBCMi5cbiAgICAgIC8vIDMuIEEgYW5kIEIgYXJlIG1lcmdlZCBpbiB0aGF0IG9yZGVyIChlLmcuIHRoZSBsYXN0IHRpbWUgaW4gQSBpcyBsZXNzIHRoYW4gQiksIGJ1dCBBMiBhbmQgQjIgYXJlIG1lcmdlZCBiYWNrd2FyZHMgKGUuZy4sIHRoZSBsYXN0IHRpbWUgaW4gQjIgaXMgbGVzcyB0aGFudCBBMiksXG4gICAgICAvLyAgICBzdWNoIHRoYXQgdGhlIG92ZXJhbGwgbWVyZ2UgY3JlYXRlcyBhIGNvbmZsaWN0P1xuICAgICAgW3ByZXZpb3VzLCBuZXh0XSA9IFtuZXh0LCBwcmV2aW91c107XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgdGltZXN0YW1wcyBvZiBwcmV2aW91cyB3aG9zZSBWQUxVRVMgdGhhdCBhcmUgbm90IGluIG5leHQuXG4gICAgbGV0IGtleXNPZk1pc3NpbmcgPSBudWxsO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShwcmV2aW91cy5qc29uKSAmJiAhQXJyYXkuaXNBcnJheShuZXh0Lmpzb24pKSB7IC8vIE5vIHBvaW50IGluIG9wdGltaXppbmcgdGhyb3VnaCBtaXNzaW5nS2V5cyBpZiB0aGF0IG1ha2VzIHVzIGNvbWJpbmVUaW1lc3RhbXBzIGFueXdheS5cbiAgICAgIGtleXNPZk1pc3NpbmcgPSB0aGlzLm1pc3NpbmdLZXlzKHByZXZpb3VzLmpzb24sIG5leHQuanNvbik7XG4gICAgICAvLyBmaXhtZSBuZXh0XG4gICAgICBpZiAoIWtleXNPZk1pc3NpbmcubGVuZ3RoKSByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcobmV4dC5zaWduYXR1cmUpOyAvLyBQcmV2aW91cyBpcyBhIHN1YnNldCBvZiBuZXcgc2lnbmF0dXJlLlxuICAgICAgLy9pZiAoIWtleXNPZk1pc3NpbmcubGVuZ3RoKSByZXR1cm4gbmV4dDsgLy8gUHJldmlvdXMgaXMgYSBzdWJzZXQgb2YgbmV3IHNpZ25hdHVyZS5cbiAgICB9XG4gICAgLy8gVE9ETzogcmV0dXJuIHByZXZpb3VzIGlmIG5leHQgaXMgYSBzdWJzZXQgb2YgaXQ/XG5cbiAgICAvLyBXZSBjYW5ub3QgcmUtdXNlIG9uZSBvciBvdGhlci4gU2lnbiBhIG5ldyBtZXJnZWQgcmVzdWx0LlxuICAgIGNvbnN0IHByZXZpb3VzVmFsaWRhdGlvbnMgPSBhd2FpdCB0aGlzLmVuc3VyZUV4cGFuZGVkKHByZXZpb3VzKTtcbiAgICBjb25zdCBuZXh0VmFsaWRhdGlvbnMgPSBhd2FpdCB0aGlzLmVuc3VyZUV4cGFuZGVkKG5leHQpO1xuICAgIC8vIFdlIGNhbiBvbmx5IHRydWx5IG1lcmdlIGlmIHdlIGFyZSBhbiBvd25lci5cbiAgICBjb25zdCBoZWFkZXIgPSBwcmV2aW91c1ZhbGlkYXRpb25zWzBdLnByb3RlY3RlZEhlYWRlcjtcbiAgICBsZXQgb3duZXIgPSBoZWFkZXIuaXNzIHx8IGhlYWRlci5raWQ7XG4gICAgbGV0IGlzT3duZXIgPSBbQ3JlZGVudGlhbHMub3duZXIsIENyZWRlbnRpYWxzLmF1dGhvciwgYXV0aG9yT3ZlcnJpZGVdLmluY2x1ZGVzKG93bmVyKTtcbiAgICAvLyBJZiB0aGVzZSBhcmUgbm90IHRoZSBvd25lciwgYW5kIHdlIHdlcmUgbm90IGdpdmVuIGEgc3BlY2lmaWMgb3ZlcnJpZGUsIHRoZW4gc2VlIGlmIHRoZSB1c2VyIGhhcyBhY2Nlc3MgdG8gdGhlIG93bmVyIGluIHRoaXMgZXhlY3V0aW9uIGNvbnRleHQuXG4gICAgbGV0IGNhblNpZ24gPSBpc093bmVyIHx8ICghYXV0aG9yT3ZlcnJpZGUgJiYgYXdhaXQgQ3JlZGVudGlhbHMuc2lnbignJywgb3duZXIpLmNhdGNoKCgpID0+IGZhbHNlKSk7XG4gICAgbGV0IG1lcmdlZCwgb3B0aW9ucywgdGltZSA9IERhdGUubm93KCk7XG4gICAgY29uc3QgYXV0aG9yID0gYXV0aG9yT3ZlcnJpZGUgfHwgQ3JlZGVudGlhbHMuYXV0aG9yO1xuICAgIGZ1bmN0aW9uIGZsYXR0ZW4oYSwgYikgeyByZXR1cm4gW10uY29uY2F0KGEsIGIpOyB9XG4gICAgaWYgKCFjYW5TaWduKSB7IC8vIFdlIGRvbid0IGhhdmUgb3duZXIgYW5kIGNhbm5vdCBnZXQgaXQuXG4gICAgICAvLyBDcmVhdGUgYSBzcGVjaWFsIG5vbi1zdGFuZGFyZCBcInNpZ25hdHVyZVwiIHRoYXQgaXMgcmVhbGx5IGFuIGFycmF5IG9mIHNpZ25hdHVyZXNcbiAgICAgIGZ1bmN0aW9uIGdldFNpZ25hdHVyZXModmFsaWRhdGlvbnMpIHsgcmV0dXJuIHZhbGlkYXRpb25zLm1hcCh2YWxpZGF0aW9uID0+IHZhbGlkYXRpb24uc2lnbmF0dXJlKTsgfVxuICAgICAgbWVyZ2VkID0gZmxhdHRlbihnZXRTaWduYXR1cmVzKHByZXZpb3VzVmFsaWRhdGlvbnMpLCBnZXRTaWduYXR1cmVzKG5leHRWYWxpZGF0aW9ucykpO1xuICAgICAgb3B0aW9ucyA9IHt0YWdzOiBbYXV0aG9yXSwgdGltZX07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZ1bmN0aW9uIGdldEpTT05zKHZhbGlkYXRpb25zKSB7IHJldHVybiB2YWxpZGF0aW9ucy5tYXAodmFsaWRhdGlvbiA9PiB2YWxpZGF0aW9uLmpzb24pOyB9XG4gICAgICBjb25zdCBmbGF0dGVuZWQgPSBmbGF0dGVuKGdldEpTT05zKHByZXZpb3VzVmFsaWRhdGlvbnMpLCBnZXRKU09OcyhuZXh0VmFsaWRhdGlvbnMpKTtcbiAgICAgIG1lcmdlZCA9IHRoaXMuY29tYmluZVRpbWVzdGFtcHMobmV4dC50YWcsIGtleXNPZk1pc3NpbmcsIC4uLmZsYXR0ZW5lZCk7XG4gICAgICBvcHRpb25zID0ge3RlYW06IG93bmVyLCBtZW1iZXI6IGF1dGhvciwgdGltZX07XG4gICAgfVxuICAgIC8vIGZpeG1lIG5leHRcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKG1lcmdlZCwgb3B0aW9ucyk7XG4gICAgLy9yZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZmllZFNpZ24obWVyZ2VkLCBvcHRpb25zKTtcbiAgfVxuICBlbnN1cmVFeHBhbmRlZCh2YWxpZGF0aW9uKSB7IC8vIFByb21pc2UgYW4gYXJyYXkgb2YgdmVyaWZpY2F0aW9ucyAodmVyaWZ5aW5nIGVsZW1lbnRzIG9mIHZhbGlkYXRpb24uanNvbiBpZiBuZWVkZWQpLlxuICAgIGlmICghQXJyYXkuaXNBcnJheSh2YWxpZGF0aW9uLmpzb24pKSByZXR1cm4gW3ZhbGlkYXRpb25dO1xuICAgIHJldHVybiBQcm9taXNlLmFsbCh2YWxpZGF0aW9uLmpzb24ubWFwKHNpZ25hdHVyZSA9PiB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeShzaWduYXR1cmUpKSk7XG4gIH1cbiAgbWlzc2luZ0tleXMocHJldmlvdXNNYXBwaW5nLCBuZXh0TWFwcGluZ3MpIHsgLy8gQW5zd2VyIGEgbGlzdCBvZiB0aG9zZSBrZXlzIGZyb20gcHJldmlvdXMgdGhhdCBkbyBub3QgaGF2ZSB2YWx1ZXMgaW4gbmV4dC5cbiAgICBjb25zdCBuZXh0VmFsdWVzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5leHRNYXBwaW5ncykpO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyhwcmV2aW91c01hcHBpbmcpLmZpbHRlcihrZXkgPT4ga2V5ICE9PSAnbGF0ZXN0JyAmJiAhbmV4dFZhbHVlcy5oYXMocHJldmlvdXNNYXBwaW5nW2tleV0pKTtcbiAgfVxuICBjb21iaW5lVGltZXN0YW1wcyh0YWcsIGtleXNPZk1pc3NpbmcsIHByZXZpb3VzTWFwcGluZ3MsIG5leHRNYXBwaW5ncywgLi4ucmVzdCkgeyAvLyBSZXR1cm4gYSBtZXJnZWQgZGljdGlvbmFyeSBvZiB0aW1lc3RhbXAgPT4gaGFzaCwgY29udGFpbmluZyBhbGwgb2YgcHJldmlvdXMgYW5kIG5leHRNYXBwaW5ncy5cbiAgICAvLyBXZSdsbCBuZWVkIGEgbmV3IG9iamVjdCB0byBzdG9yZSB0aGUgdW5pb24sIGJlY2F1c2UgdGhlIGtleXMgbXVzdCBiZSBpbiB0aW1lIG9yZGVyLCBub3QgdGhlIG9yZGVyIHRoZXkgd2VyZSBhZGRlZC5cbiAgICBrZXlzT2ZNaXNzaW5nIHx8PSB0aGlzLm1pc3NpbmdLZXlzKHByZXZpb3VzTWFwcGluZ3MsIG5leHRNYXBwaW5ncyk7XG4gICAgY29uc3QgbWVyZ2VkID0ge307XG4gICAgbGV0IG1pc3NpbmdJbmRleCA9IDAsIG1pc3NpbmdUaW1lLCBuZXh0VGltZXM7XG4gICAgZm9yIChjb25zdCBuZXh0VGltZSBpbiBuZXh0TWFwcGluZ3MpIHtcbiAgICAgIG1pc3NpbmdUaW1lID0gMDtcblxuICAgICAgLy8gTWVyZ2UgYW55IHJlbWFpbmluZyBrZXlzT2ZNaXNzaW5nIHRoYXQgY29tZSBzdHJpY3RseSBiZWZvcmUgbmV4dFRpbWU6XG4gICAgICBpZiAobmV4dFRpbWUgIT09ICdsYXRlc3QnKSB7XG5cdGZvciAoOyAobWlzc2luZ0luZGV4IDwga2V5c09mTWlzc2luZy5sZW5ndGgpICYmICgobWlzc2luZ1RpbWUgPSBrZXlzT2ZNaXNzaW5nW21pc3NpbmdJbmRleF0pIDwgbmV4dFRpbWUpOyBtaXNzaW5nSW5kZXgrKykge1xuXHQgIG1lcmdlZFttaXNzaW5nVGltZV0gPSBwcmV2aW91c01hcHBpbmdzW21pc3NpbmdUaW1lXTtcblx0fVxuICAgICAgfVxuXG4gICAgICBpZiAobWlzc2luZ1RpbWUgPT09IG5leHRUaW1lKSB7IC8vIFR3byBkaWZmZXJlbnQgdmFsdWVzIGF0IHRoZSBleGFjdCBzYW1lIHRpbWUuIEV4dHJlbWVseSByYXJlLlxuXHRjb25zb2xlLndhcm4odGhpcy5mdWxsTGFiZWwsIGBVbnVzdWFsIG1hdGNoaW5nIHRpbWVzdGFtcCBjYXNlIGF0IHRpbWUgJHttaXNzaW5nVGltZX0gZm9yIHRhZyAke3RhZ30uYCk7XG5cdG5leHRUaW1lcyB8fD0gT2JqZWN0LmtleXMobmV4dE1hcHBpbmdzKTsgLy8gV2UgZGlkbid0IG5lZWQgdGhpcyBmb3Igb3VyIGxvb3AuIEdlbmVyYXRlIG5vdyBpZiBuZWVkZWQuXG5cdGNvbnN0IG5leHROZXh0VGltZSA9IE1hdGgubWluKGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4ICsgMV0gfHwgSW5maW5pdHksXG5cdFx0XHRcdCAgICAgIG5leHRNYXBwaW5nc1tuZXh0VGltZXMuaW5kZXhPZihuZXh0VGltZSkgKyAxXSB8fCBJbmZpbml0eSk7XG5cdGNvbnN0IGluc2VydFRpbWUgPSBuZXh0VGltZSArIChuZXh0TmV4dFRpbWUgLSBuZXh0VGltZSkgLyAyO1xuXHQvLyBXZSBhbHJlYWR5IHB1dCB0aGVzZSBpbiBvcmRlciB3aXRoIHByZXZpb3VzTWFwcGluZ3MgZmlyc3QuXG5cdG1lcmdlZFtuZXh0VGltZV0gPSBwcmV2aW91c01hcHBpbmdzW25leHRUaW1lXTtcblx0bWVyZ2VkW2luc2VydFRpbWVdID0gbmV4dE1hcHBpbmdzW25leHRUaW1lXTtcblxuICAgICAgfSBlbHNlIHsgLy8gTm8gY29uZmxpY3RzLiBKdXN0IGFkZCBuZXh0LlxuXHRtZXJnZWRbbmV4dFRpbWVdID0gbmV4dE1hcHBpbmdzW25leHRUaW1lXTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUaGVyZSBjYW4gYmUgbWlzc2luZyBzdHVmZiB0byBhZGQgYXQgdGhlIGVuZDtcbiAgICBmb3IgKDsgbWlzc2luZ0luZGV4IDwga2V5c09mTWlzc2luZy5sZW5ndGg7IG1pc3NpbmdJbmRleCsrKSB7XG4gICAgICBtaXNzaW5nVGltZSA9IGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4XTtcbiAgICAgIG1lcmdlZFttaXNzaW5nVGltZV0gPSBwcmV2aW91c01hcHBpbmdzW21pc3NpbmdUaW1lXTtcbiAgICB9XG4gICAgbGV0IG1lcmdlZFRpbWVzID0gT2JqZWN0LmtleXMobWVyZ2VkKTtcbiAgICBtZXJnZWQubGF0ZXN0ID0gbWVyZ2VkVGltZXNbbWVyZ2VkVGltZXMubGVuZ3RoIC0gMV07XG4gICAgcmV0dXJuIHJlc3QubGVuZ3RoID8gdGhpcy5jb21iaW5lVGltZXN0YW1wcyh0YWcsIHVuZGVmaW5lZCwgbWVyZ2VkLCAuLi5yZXN0KSA6IG1lcmdlZDtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyA9IHt9KSB7IC8vIEFuIGFycmF5IG9mIHVubWVyZ2VkIHNpZ25hdHVyZXMgY2FuIGJlIHZlcmlmaWVkLlxuICAgIGlmIChzaWduYXR1cmUuc3RhcnRzV2l0aD8uKCdbJykpIHNpZ25hdHVyZSA9IEpTT04ucGFyc2Uoc2lnbmF0dXJlKTsgLy8gKG1heWJlSW5mbGF0ZSBsb29rcyBmb3IgJ3snLCBub3QgJ1snLilcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoc2lnbmF0dXJlKSkgcmV0dXJuIGF3YWl0IHN1cGVyLnZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMpO1xuICAgIGNvbnN0IGNvbWJpbmVkID0gYXdhaXQgUHJvbWlzZS5hbGwoc2lnbmF0dXJlLm1hcChlbGVtZW50ID0+IHRoaXMudmVyaWZ5KGVsZW1lbnQsIG9wdGlvbnMpKSk7XG4gICAgY29uc3Qgb2sgPSBjb21iaW5lZC5ldmVyeShlbGVtZW50ID0+IGVsZW1lbnQpO1xuICAgIGlmICghb2spIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgcHJvdGVjdGVkSGVhZGVyID0gY29tYmluZWRbMF0ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGZvciAoY29uc3QgcHJvcGVydHkgb2YgWydpc3MnLCAna2lkJywgJ2FsZycsICdjdHknXSkgeyAvLyBPdXIgb3BlcmF0aW9ucyBtYWtlIHVzZSBvZiBpc3MsIGtpZCwgYW5kIGlhdC5cbiAgICAgIGNvbnN0IG1hdGNoaW5nID0gcHJvdGVjdGVkSGVhZGVyW3Byb3BlcnR5XTtcbiAgICAgIGNvbnN0IG1hdGNoZXMgPSBjb21iaW5lZC5ldmVyeShlbGVtZW50ID0+IGVsZW1lbnQucHJvdGVjdGVkSGVhZGVyW3Byb3BlcnR5XSA9PT0gbWF0Y2hpbmcpO1xuICAgICAgaWYgKG1hdGNoZXMpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFtYXRjaGVzKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBjb25zdCB7aXNzLCBraWQsIGFsZywgY3R5fSA9IHByb3RlY3RlZEhlYWRlcjtcbiAgICBjb25zdCB2ZXJpZmllZCA9IHtcbiAgICAgIHNpZ25hdHVyZSwgLy8gYXJyYXkgYXQgdGhpcyBwb2ludFxuICAgICAganNvbjogY29tYmluZWQubWFwKGVsZW1lbnQgPT4gZWxlbWVudC5qc29uKSxcbiAgICAgIHByb3RlY3RlZEhlYWRlcjoge2lzcywga2lkLCBhbGcsIGN0eSwgaWF0OiBNYXRoLm1heCguLi5jb21iaW5lZC5tYXAoZWxlbWVudCA9PiBlbGVtZW50LnByb3RlY3RlZEhlYWRlci5pYXQpKX1cbiAgICB9O1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgeyAvLyBiYWNrZGF0aW5nIGlzIGFsbG93ZWQuIChtZXJnaW5nKS5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIXRoaXMub3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpKSByZXR1cm4gJ25vdCBvd25lcic7XG4gICAgaWYgKCFhd2FpdCB0aGlzLnN1YmplY3RNYXRjaCh2ZXJpZmllZCkpIHJldHVybiAnd3JvbmcgaGFzaCc7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgb3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gVE9ETzogRWl0aGVyIHRoZXkgbXVzdCBtYXRjaCAoYXMgaW4gc3VwZXIpIG9yIHRoZSBuZXcgcGF5bG9hZCBtdXN0IGluY2x1ZGUgdGhlIHByZXZpb3VzLlxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cblxuLy8gV2hlbiBydW5uaW5nIGluIE5vZGVKUywgdGhlIFNlY3VyaXR5IG9iamVjdCBpcyBhdmFpbGFibGUgZGlyZWN0bHkuXG4vLyBJdCBoYXMgYSBTdG9yYWdlIHByb3BlcnR5LCB3aGljaCBkZWZpbmVzIHN0b3JlL3JldHJpZXZlIChpbiBsaWIvc3RvcmFnZS5tanMpIHRvIEdFVC9QVVQgb25cbi8vIC4uLi86ZnVsbExhYmVsLzpwYXJ0MW9mVGFnLzpwYXJ0Mm9mVGFnLzpwYXJ0M29mVGFnLzpyZXN0T2ZUYWcuanNvblxuLy8gVGhlIFNlY3VyaXR5LlN0b3JhZ2UgY2FuIGJlIHNldCBieSBjbGllbnRzIHRvIHNvbWV0aGluZyBlbHNlLlxuLy9cbi8vIFdoZW4gcnVubmluZyBpbiBhIGJyb3dzZXIsIHdvcmtlci5qcyBvdmVycmlkZXMgdGhpcyB0byBzZW5kIG1lc3NhZ2VzIHRocm91Z2ggdGhlIEpTT04gUlBDXG4vLyB0byB0aGUgYXBwLCB3aGljaCB0aGVuIGFsc28gaGFzIGFuIG92ZXJyaWRhYmxlIFNlY3VyaXR5LlN0b3JhZ2UgdGhhdCBpcyBpbXBsZW1lbnRlZCB3aXRoIHRoZSBzYW1lIGNvZGUgYXMgYWJvdmUuXG5cbi8vIEJhc2ggaW4gc29tZSBuZXcgc3R1ZmY6XG5DcmVkZW50aWFscy5hdXRob3IgPSBudWxsO1xuQ3JlZGVudGlhbHMub3duZXIgPSBudWxsO1xuQ3JlZGVudGlhbHMuZW5jcnlwdGlvbiA9IG51bGw7IC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGF1ZGllbmNlXG5DcmVkZW50aWFscy5zeW5jaHJvbml6ZSA9IGFzeW5jICguLi5zZXJ2aWNlcykgPT4geyAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBjb25uZWN0LlxuICAvLyBXZSBjYW4gZG8gYWxsIHRocmVlIGluIHBhcmFsbGVsIC0tIHdpdGhvdXQgd2FpdGluZyBmb3IgY29tcGxldGlvbiAtLSBiZWNhdXNlIGRlcGVuZGVuY2llcyB3aWxsIGdldCBzb3J0ZWQgb3V0IGJ5IHN5bmNocm9uaXplMS5cbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uc3luY2hyb25pemUoLi4uc2VydmljZXMpKSk7XG59O1xuQ3JlZGVudGlhbHMuc3luY2hyb25pemVkID0gYXN5bmMgKCkgPT4ge1xuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5zeW5jaHJvbml6ZWQpKTtcbn1cbkNyZWRlbnRpYWxzLmRpc2Nvbm5lY3QgPSBhc3luYyAoLi4uc2VydmljZXMpID0+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZGlzY29ubmVjdCguLi5zZXJ2aWNlcykpKTtcbn1cblxuQ3JlZGVudGlhbHMuY3JlYXRlQXV0aG9yID0gYXN5bmMgKHByb21wdCkgPT4geyAvLyBDcmVhdGUgYSB1c2VyOlxuICAvLyBJZiBwcm9tcHQgaXMgJy0nLCBjcmVhdGVzIGFuIGludml0YXRpb24gYWNjb3VudCwgd2l0aCBhIG5vLW9wIHJlY292ZXJ5IGFuZCBubyBkZXZpY2UuXG4gIC8vIE90aGVyd2lzZSwgcHJvbXB0IGluZGljYXRlcyB0aGUgcmVjb3ZlcnkgcHJvbXB0cywgYW5kIHRoZSBhY2NvdW50IGhhcyB0aGF0IGFuZCBhIGRldmljZS5cbiAgaWYgKHByb21wdCA9PT0gJy0nKSByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0fSkpO1xuICBjb25zdCBbbG9jYWwsIHJlY292ZXJ5XSA9IGF3YWl0IFByb21pc2UuYWxsKFtDcmVkZW50aWFscy5jcmVhdGUoKSwgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHR9KV0pO1xuICByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGxvY2FsLCByZWNvdmVyeSk7XG59O1xuQ3JlZGVudGlhbHMuY2xhaW1JbnZpdGF0aW9uID0gYXN5bmMgKHRhZywgbmV3UHJvbXB0KSA9PiB7IC8vIENyZWF0ZXMgYSBsb2NhbCBkZXZpY2UgdGFnIGFuZCBhZGRzIGl0IHRvIHRoZSBnaXZlbiBpbnZpdGF0aW9uIHRhZyxcbiAgLy8gdXNpbmcgdGhlIHNlbGYtdmFsaWRhdGluZyByZWNvdmVyeSBtZW1iZXIgdGhhdCBpcyB0aGVuIHJlbW92ZWQgYW5kIGRlc3Ryb3llZC5cbiAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBDcmVkZW50aWFscy5jb2xsZWN0aW9ucy5UZWFtLnJldHJpZXZlKHt0YWd9KTtcbiAgaWYgKCF2ZXJpZmllZCkgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gdmVyaWZ5IGludml0YXRpb24gJHt0YWd9LmApO1xuICBjb25zdCBtZW1iZXJzID0gdmVyaWZpZWQuanNvbi5yZWNpcGllbnRzO1xuICBpZiAobWVtYmVycy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgSW52aXRhdGlvbnMgc2hvdWxkIGhhdmUgb25lIG1lbWJlcjogJHt0YWd9YCk7XG4gIGNvbnN0IG9sZFJlY292ZXJ5VGFnID0gbWVtYmVyc1swXS5oZWFkZXIua2lkO1xuICBjb25zdCBuZXdSZWNvdmVyeVRhZyA9IGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0OiBuZXdQcm9tcHR9KTtcbiAgY29uc3QgZGV2aWNlVGFnID0gYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKCk7XG5cbiAgLy8gV2UgbmVlZCB0byBhZGQgdGhlIG5ldyBtZW1iZXJzIGluIG9uZSBjaGFuZ2VNZW1iZXJzaGlwIHN0ZXAsIGFuZCB0aGVuIHJlbW92ZSB0aGUgb2xkUmVjb3ZlcnlUYWcgaW4gYSBzZWNvbmQgY2FsbCB0byBjaGFuZ2VNZW1iZXJzaGlwOlxuICAvLyBjaGFuZ2VNZW1iZXJzaGlwIHdpbGwgc2lnbiBieSBhbiBPTEQgbWVtYmVyIC0gSWYgaXQgc2lnbmVkIGJ5IG5ldyBtZW1iZXIgdGhhbiBwZW9wbGUgY291bGQgYm9vdHN0cmFwIHRoZW1zZWx2ZXMgb250byBhIHRlYW0uXG4gIC8vIEJ1dCBpZiB3ZSByZW1vdmUgdGhlIG9sZFJlY292ZXJ5IHRhZyBpbiB0aGUgc2FtZSBzdGVwIGFzIGFkZGluZyB0aGUgbmV3LCB0aGUgdGVhbSB3b3VsZCBiZSBzaWduZWQgYnkgc29tZW9uZSAodGhlIG9sZFJlY292ZXJ5VGFnKSB0aGF0XG4gIC8vIGlzIG5vIGxvbmdlciBhIG1lbWJlciwgYW5kIHNvIHRoZSB0ZWFtIHdvdWxkIG5vdCB2ZXJpZnkhXG4gIGF3YWl0IENyZWRlbnRpYWxzLmNoYW5nZU1lbWJlcnNoaXAoe3RhZywgYWRkOiBbZGV2aWNlVGFnLCBuZXdSZWNvdmVyeVRhZ10sIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5jaGFuZ2VNZW1iZXJzaGlwKHt0YWcsIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5kZXN0cm95KG9sZFJlY292ZXJ5VGFnKTtcbiAgcmV0dXJuIHRhZztcbn07XG5jb25zdCBhbnN3ZXJzID0ge307IC8vIFRPRE86IG1ha2Ugc2V0QW5zd2VyIGluY2x1ZGUgdGFnIGFzIHdlbGwgYXMgcHJvbXB0LlxuQ3JlZGVudGlhbHMuc2V0QW5zd2VyID0gKHByb21wdCwgYW5zd2VyKSA9PiBhbnN3ZXJzW3Byb21wdF0gPSBhbnN3ZXI7XG5DcmVkZW50aWFscy5nZXRVc2VyRGV2aWNlU2VjcmV0ID0gZnVuY3Rpb24gZmxleHN0b3JlU2VjcmV0KHRhZywgcHJvbXB0U3RyaW5nKSB7XG4gIGlmICghcHJvbXB0U3RyaW5nKSByZXR1cm4gdGFnO1xuICBpZiAocHJvbXB0U3RyaW5nID09PSAnLScpIHJldHVybiBwcm9tcHRTdHJpbmc7IC8vIFNlZSBjcmVhdGVBdXRob3IuXG4gIGlmIChhbnN3ZXJzW3Byb21wdFN0cmluZ10pIHJldHVybiBhbnN3ZXJzW3Byb21wdFN0cmluZ107XG4gIC8vIERpc3RyaWJ1dGVkIFNlY3VyaXR5IHdpbGwgdHJ5IGV2ZXJ5dGhpbmcuIFVubGVzcyBnb2luZyB0aHJvdWdoIGEgcGF0aCBhYm92ZSwgd2Ugd291bGQgbGlrZSBvdGhlcnMgdG8gc2lsZW50bHkgZmFpbC5cbiAgY29uc29sZS5sb2coYEF0dGVtcHRpbmcgYWNjZXNzICR7dGFnfSB3aXRoIHByb21wdCAnJHtwcm9tcHRTdHJpbmd9Jy5gKTtcbiAgcmV0dXJuIFwibm90IGEgc2VjcmV0XCI7IC8vIHRvZG86IGNyeXB0byByYW5kb21cbn07XG5cblxuLy8gVGhlc2UgdHdvIGFyZSB1c2VkIGRpcmVjdGx5IGJ5IGRpc3RyaWJ1dGVkLXNlY3VyaXR5LlxuQ3JlZGVudGlhbHMuU3RvcmFnZS5yZXRyaWV2ZSA9IGFzeW5jIChjb2xsZWN0aW9uTmFtZSwgdGFnKSA9PiB7XG4gIGNvbnN0IGNvbGxlY3Rpb24gPSBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tjb2xsZWN0aW9uTmFtZV07XG4gIC8vIE5vIG5lZWQgdG8gdmVyaWZ5LCBhcyBkaXN0cmlidXRlZC1zZWN1cml0eSBkb2VzIHRoYXQgaXRzZWxmIHF1aXRlIGNhcmVmdWxseSBhbmQgdGVhbS1hd2FyZS5cbiAgaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnRW5jcnlwdGlvbktleScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7XG4gIGlmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ0tleVJlY292ZXJ5JykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTtcbiAgLy9pZiAoY29sbGVjdGlvbk5hbWUgPT09ICdUZWFtJykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTsgICAgLy8gVGhpcyB3b3VsZCBnbyBjaXJjdWxhci4gU2hvdWxkIGl0PyBEbyB3ZSBuZWVkIGl0P1xuICBjb25zdCBkYXRhID0gYXdhaXQgY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgLy8gSG93ZXZlciwgc2luY2Ugd2UgaGF2ZSBieXBhc3NlZCBDb2xsZWN0aW9uLnJldHJpZXZlLCB3ZSBtYXliZUluZmxhdGUgaGVyZS5cbiAgcmV0dXJuIENvbGxlY3Rpb24ubWF5YmVJbmZsYXRlKGRhdGEpO1xufVxuY29uc3QgRU1QVFlfU1RSSU5HX0hBU0ggPSBcIjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlVcIjsgLy8gSGFzaCBvZiBhbiBlbXB0eSBzdHJpbmcuXG5DcmVkZW50aWFscy5TdG9yYWdlLnN0b3JlID0gYXN5bmMgKGNvbGxlY3Rpb25OYW1lLCB0YWcsIHNpZ25hdHVyZSkgPT4ge1xuICAvLyBObyBuZWVkIHRvIGVuY3J5cHQvc2lnbiBhcyBieSBzdG9yZSwgc2luY2UgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgZG9lcyB0aGF0IGluIGEgY2lyY3VsYXJpdHktYXdhcmUgd2F5LlxuICAvLyBIb3dldmVyLCB3ZSBkbyBjdXJyZW50bHkgbmVlZCB0byBmaW5kIG91dCBvZiB0aGUgc2lnbmF0dXJlIGhhcyBhIHBheWxvYWQgYW5kIHB1c2hcbiAgLy8gVE9ETzogTW9kaWZ5IGRpc3Qtc2VjIHRvIGhhdmUgYSBzZXBhcmF0ZSBzdG9yZS9kZWxldGUsIHJhdGhlciB0aGFuIGhhdmluZyB0byBmaWd1cmUgdGhpcyBvdXQgaGVyZS5cbiAgY29uc3QgY2xhaW1zID0gQ3JlZGVudGlhbHMuZGVjb2RlQ2xhaW1zKHNpZ25hdHVyZSk7XG4gIGNvbnN0IGVtcHR5UGF5bG9hZCA9IGNsYWltcz8uc3ViID09PSBFTVBUWV9TVFJJTkdfSEFTSDtcblxuICBjb25zdCBjb2xsZWN0aW9uID0gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbY29sbGVjdGlvbk5hbWVdO1xuICBzaWduYXR1cmUgPSBDb2xsZWN0aW9uLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICBjb25zdCBzdG9yZWQgPSBhd2FpdCAoZW1wdHlQYXlsb2FkID8gY29sbGVjdGlvbi5kZWxldGUodGFnLCBzaWduYXR1cmUpIDogY29sbGVjdGlvbi5wdXQodGFnLCBzaWduYXR1cmUpKTtcbiAgaWYgKHN0b3JlZCAhPT0gdGFnKSB0aHJvdyBuZXcgRXJyb3IoYFVuYWJsZSB0byB3cml0ZSBjcmVkZW50aWFsICR7dGFnfS5gKTtcbiAgaWYgKHRhZykgYXdhaXQgY29sbGVjdGlvbi5wdXNoKGVtcHR5UGF5bG9hZCA/ICdkZWxldGUnOiAncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICByZXR1cm4gdGFnO1xufTtcbkNyZWRlbnRpYWxzLlN0b3JhZ2UuZGVzdHJveSA9IGFzeW5jICgpID0+IHtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2xlYXIoKTsgLy8gV2lwZSBmcm9tIGxpdmUgbWVtb3J5LlxuICBhd2FpdCBQcm9taXNlLmFsbChPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKS5tYXAoYXN5bmMgY29sbGVjdGlvbiA9PiB7XG4gICAgYXdhaXQgY29sbGVjdGlvbi5kaXNjb25uZWN0KCk7XG4gICAgY29uc3Qgc3RvcmUgPSBhd2FpdCBjb2xsZWN0aW9uLnBlcnNpc3RlbmNlU3RvcmU7XG4gICAgc3RvcmUuZGVzdHJveSgpOyAvLyBEZXN0cm95IHRoZSBwZXJzaXN0ZW50IGNhY2hlLlxuICB9KSk7XG4gIGF3YWl0IENyZWRlbnRpYWxzLndpcGVEZXZpY2VLZXlzKCk7IC8vIE5vdCBpbmNsdWRlZCBpbiB0aGUgYWJvdmUuXG59O1xuQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMgPSB7fTtcbmV4cG9ydCB7IENyZWRlbnRpYWxzIH07XG5bJ0VuY3J5cHRpb25LZXknLCAnS2V5UmVjb3ZlcnknLCAnVGVhbSddLmZvckVhY2gobmFtZSA9PiBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tuYW1lXSA9IG5ldyBNdXRhYmxlQ29sbGVjdGlvbih7bmFtZX0pKTtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCBTeW5jaHJvbml6ZXIgZnJvbSAnLi9saWIvc3luY2hyb25pemVyLm1qcyc7XG5pbXBvcnQgeyBDb2xsZWN0aW9uLCBJbW11dGFibGVDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgVmVyc2lvbkNvbGxlY3Rpb24gfSBmcm9tICAnLi9saWIvY29sbGVjdGlvbnMubWpzJztcbmltcG9ydCB7IFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDIH0gZnJvbSAnLi9saWIvd2VicnRjLm1qcyc7XG5pbXBvcnQgeyB2ZXJzaW9uLCBuYW1lLCBzdG9yYWdlVmVyc2lvbiwgc3RvcmFnZU5hbWUgfSBmcm9tICcuL2xpYi92ZXJzaW9uLm1qcyc7XG5cbmNvbnNvbGUubG9nKGAke25hbWV9ICR7dmVyc2lvbn0gZnJvbSAke2ltcG9ydC5tZXRhLnVybH0uYCk7XG5cbmV4cG9ydCB7IENyZWRlbnRpYWxzLCBDb2xsZWN0aW9uLCBJbW11dGFibGVDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgVmVyc2lvbkNvbGxlY3Rpb24sIFN5bmNocm9uaXplciwgV2ViUlRDLCBQcm9taXNlV2ViUlRDLCBTaGFyZWRXZWJSVEMsIG5hbWUsIHZlcnNpb24sIHN0b3JhZ2VOYW1lLCBzdG9yYWdlVmVyc2lvbiB9O1xuZXhwb3J0IGRlZmF1bHQgeyBDcmVkZW50aWFscywgQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIFZlcnNpb25lZENvbGxlY3Rpb24sIFZlcnNpb25Db2xsZWN0aW9uLCBTeW5jaHJvbml6ZXIsIFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDLCBuYW1lLCB2ZXJzaW9uLCAgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uIH07XG4iXSwibmFtZXMiOlsicGtnLmRlZmF1bHQiLCJTdG9yYWdlTG9jYWwiXSwibWFwcGluZ3MiOiI7OztBQUFBLE1BQU0sV0FBVyxHQUFHLHdFQUF3RTtBQUM1RixTQUFTLEtBQUssQ0FBQyxJQUFJLEVBQUU7QUFDckIsRUFBRSxPQUFPLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0FBQy9COztBQUVBO0FBQ0E7QUFDQSxTQUFTLEtBQUssR0FBRztBQUNqQixFQUFFLElBQUksUUFBUSxHQUFHLEdBQUcsQ0FBQyxlQUFlLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQztBQUNoRCxFQUFFLElBQUksSUFBSSxHQUFHLFFBQVEsQ0FBQyxRQUFRLEVBQUU7QUFDaEMsRUFBRSxHQUFHLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQztBQUMvQixFQUFFLE9BQU8sSUFBSSxDQUFD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LENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxVQUFVLEVBQUUsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUMsSUFBSSxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssR0FBRSxDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFDLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsTUFBTSxZQUFZLFNBQVMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxNQUFNLENBQUMsQ0FBQyxFQUFFLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFDLENBQUMsTUFBTSxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEVBQUUsSUFBSSxFQUFFLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU0sQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsT0FBTyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQzs7QUNJcDdELE1BQU0sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxHQUFHLFVBQVU7O0FBRXJELE1BQU0sVUFBVSxTQUFTLFdBQVcsQ0FBQzs7QUFFNUMsRUFBRSxXQUFXLENBQUMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxHQUFHLElBQUksRUFBRSxRQUFRLEdBQUcsRUFBRSxFQUFFLGlCQUFpQixHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTTtBQUN2RixRQUFRLGdCQUFnQixHQUFHQyxZQUFZLEVBQUUsU0FBUyxHQUFHLGNBQWMsRUFBRSxlQUFlLEdBQUcsQ0FBQyxFQUFFLFdBQVcsQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDLENBQUM7QUFDcEgsUUFBUSxLQUFLLEdBQUcsS0FBSyxFQUFFLFNBQVM7QUFDaEMsUUFBUSxXQUFXLEVBQUUsWUFBWSxDQUFDLEVBQUU7QUFDcEMsSUFBSSxLQUFLLEVBQUU7QUFDWCxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxpQkFBaUIsRUFBRSxnQkFBZ0IsRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLEtBQUssRUFBRSxXQUFXLEVBQUUsWUFBWTtBQUNqSSxJQUFJLFFBQVEsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xHLElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLFFBQVEsQ0FBQztBQUNqQyxJQUFJLE1BQU0sa0JBQWtCLEdBQUcsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRSxRQUFRLEVBQUUsZUFBZSxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUM7QUFDOUYsSUFBSSxJQUFJLGdCQUFnQixDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBQ2xILFNBQVMsSUFBSSxDQUFDLGdCQUFnQixHQUFHLElBQUksZ0JBQWdCLENBQUMsa0JBQWtCLENBQUM7QUFDekU7O0FBRUEsRUFBRSxNQUFNLEtBQUssR0FBRztBQUNoQixJQUFJLE1BQU0sQ0FBQyxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxLQUFLLEVBQUU7QUFDL0M7QUFDQSxFQUFFLE1BQU0sT0FBTyxHQUFHO0FBQ2xCLElBQUksTUFBTSxDQUFDLE1BQU0sSUFBSSxDQUFDLGdCQUFnQixFQUFFLE9BQU8sRUFBRTtBQUNqRDs7QUFFQSxFQUFFLE9BQU8sS0FBSyxDQUFDLEtBQUssRUFBRTtBQUN0QixJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDO0FBQ3hCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEVBQUUsT0FBTyxZQUFZLENBQUMsU0FBUyxFQUFFO0FBQ2pDLElBQUksSUFBSSxPQUFPLFNBQVMsQ0FBQyxLQUFLLFFBQVEsRUFBRSxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDO0FBQ3hFLElBQUksT0FBTyxTQUFTO0FBQ3BCO0FBQ0E7QUFDQSxFQUFFLE9BQU8sWUFBWSxDQUFDLFNBQVMsRUFBRTtBQUNqQyxJQUFJLElBQUksU0FBUyxFQUFFLFVBQVUsR0FBRyxHQUFHLENBQUMsRUFBRSxPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDO0FBQ2xFLElBQUksT0FBTyxTQUFTO0FBQ3BCO0FBQ0E7QUFDQSxFQUFFLE9BQU8saUJBQWlCLEdBQUcsZ0JBQWdCO0FBQzdDLEVBQUUsYUFBYSxlQUFlLENBQUMsUUFBUSxFQUFFO0FBQ3pDLElBQUksSUFBSSxRQUFRLENBQUMsZUFBZSxDQUFDLEdBQUcsS0FBSyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsT0FBTyxRQUFRO0FBQ2hGLElBQUksSUFBSSxRQUFRLENBQUMsU0FBUyxFQUFFLE9BQU8sUUFBUSxDQUFDO0FBQzVDLElBQUksTUFBTSxTQUFTLEdBQUcsTUFBTSxXQUFXLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUM7QUFDOUQsSUFBSSxRQUFRLENBQUMsSUFBSSxHQUFHLFNBQVMsQ0FBQyxJQUFJO0FBQ2xDLElBQUksUUFBUSxDQUFDLElBQUksR0FBRyxTQUFTLENBQUMsSUFBSTtBQUNsQyxJQUFJLFFBQVEsQ0FBQyxPQUFPLEdBQUcsU0FBUyxDQUFDLE9BQU87QUFDeEMsSUFBSSxRQUFRLENBQUMsU0FBUyxHQUFHLFNBQVM7QUFDbEMsSUFBSSxPQUFPLFFBQVE7QUFDbkI7QUFDQSxFQUFFLGFBQWEsSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7QUFDbkMsSUFBSSxNQUFNLFNBQVMsR0FBRyxNQUFNLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQztBQUMzRCxJQUFJLE9BQU8sSUFBSSxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUM7QUFDdkM7QUFDQSxFQUFFLGFBQWEsTUFBTSxDQUFDLFNBQVMsRUFBRSxPQUFPLEdBQUcsRUFBRSxFQUFFO0FBQy9DLElBQUksU0FBUyxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDO0FBQzVDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJLE1BQU0sUUFBUSxJQUFJLE1BQU0sV0FBVyxDQUFDLE1BQU0sQ0FBQyxTQUFTLEVBQUUsT0FBTyxDQUFDO0FBQ2xFLElBQUksSUFBSSxRQUFRLEVBQUUsUUFBUSxDQUFDLFNBQVMsR0FBRyxTQUFTO0FBQ2hELElBQUksT0FBTyxRQUFRO0FBQ25CO0FBQ0EsRUFBRSxhQUFhLFlBQVksQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFLEdBQUcsR0FBRyxJQUFJLEVBQUU7QUFDOUQ7QUFDQSxJQUFJLE1BQU0sU0FBUyxHQUFHLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDO0FBQzNELElBQUksT0FBTyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQztBQUNoRDtBQUNBLEVBQUUsYUFBYSxnQkFBZ0IsQ0FBQyxTQUFTLEVBQUUsR0FBRyxHQUFHLElBQUksRUFBRTtBQUN2RDtBQUNBLElBQUksTUFBTSxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQztBQUNqRDtBQUNBLElBQUksTUFBTSxHQUFHLEdBQUcsUUFBUSxDQUFDLFVBQVUsR0FBRyxRQUFRLENBQUMsZUFBZSxDQUFDLEdBQUc7QUFDbEUsSUFBSSxRQUFRLENBQUMsR0FBRyxHQUFHLEdBQUcsSUFBSSxHQUFHO0FBQzdCLElBQUksT0FBTyxRQUFRO0FBQ25COztBQUVBLEVBQUUsTUFBTSxhQUFhLEdBQUc7QUFDeEI7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJLE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxJQUFJLEVBQUU7QUFDOUQsSUFBSSxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBRTtBQUMxQixJQUFJLE1BQU0sT0FBTyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sR0FBRyxJQUFJO0FBQy9DLE1BQU0sTUFBTSxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxFQUFFLFdBQVcsRUFBRSxLQUFLLENBQUMsQ0FBQztBQUN4RSxNQUFNLElBQUksUUFBUSxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQ2pDLEtBQUssQ0FBQyxDQUFDO0FBQ1AsSUFBSSxPQUFPLElBQUk7QUFDZjtBQUNBLEVBQUUsSUFBSSxJQUFJLEdBQUc7QUFDYixJQUFJLE9BQU8sSUFBSSxDQUFDLFlBQVksS0FBSyxJQUFJLENBQUMsYUFBYSxFQUFFO0FBQ3JEO0FBQ0EsRUFBRSxNQUFNLE1BQU0sQ0FBQyxHQUFHLEVBQUU7QUFDcEIsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQzlCO0FBQ0EsRUFBRSxNQUFNLFNBQVMsQ0FBQyxHQUFHLEVBQUU7QUFDdkIsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDO0FBQ2pDOztBQUVBLEVBQUUsR0FBRyxDQUFDLEdBQUcsSUFBSSxFQUFFO0FBQ2YsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRTtBQUNyQixJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxHQUFHLElBQUksQ0FBQztBQUN4QztBQUNBLEVBQUUsb0JBQW9CLENBQUMsY0FBYyxHQUFHLEVBQUUsRUFBRTtBQUM1QyxJQUFJLElBQUksT0FBTyxjQUFjLENBQUMsS0FBSyxRQUFRLEVBQUUsY0FBYyxHQUFHLENBQUMsR0FBRyxFQUFFLGNBQWMsQ0FBQztBQUNuRixJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxHQUFHLFdBQVcsQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLE1BQU0sR0FBRyxXQUFXLENBQUMsTUFBTTtBQUM3RSxJQUFJLEdBQUc7QUFDUCxJQUFJLFVBQVUsR0FBRyxXQUFXLENBQUMsVUFBVTtBQUN2QyxJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFO0FBQ3JCLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxjQUFjO0FBQzdCO0FBQ0E7QUFDQSxJQUFJLE1BQU0sT0FBTyxHQUFHLENBQUMsSUFBSSxJQUFJLElBQUksS0FBSyxNQUFNO0FBQzVDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDO0FBQ2pELEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0FBQ3BELElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsRUFBRSxPQUFPLENBQUMsVUFBVSxHQUFHLElBQUk7QUFDdkYsSUFBSSxPQUFPLE9BQU87QUFDbEI7QUFDQSxFQUFFLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRTtBQUNoQyxJQUFJLE1BQU0sSUFBSSxLQUFLLENBQUMsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxnQ0FBZ0MsRUFBRSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdEg7QUFDQSxFQUFFLE1BQU0sS0FBSyxDQUFDLElBQUksRUFBRSxPQUFPLEdBQUcsRUFBRSxFQUFFO0FBQ2xDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxHQUFHLEVBQUUsR0FBRyxjQUFjLENBQUMsR0FBRyxJQUFJLENBQUMsb0JBQW9CLENBQUMsT0FBTyxDQUFDO0FBQ2pGLElBQUksSUFBSSxVQUFVLEVBQUU7QUFDcEIsTUFBTSxJQUFJLEdBQUcsTUFBTSxXQUFXLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxVQUFVLENBQUM7QUFDeEQsTUFBTSxjQUFjLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsaUJBQWlCO0FBQ3JFO0FBQ0E7QUFDQSxJQUFJLE1BQU0sU0FBUyxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLGNBQWMsQ0FBQztBQUN2RSxJQUFJLEdBQUcsR0FBRyxNQUFNLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLFNBQVMsQ0FBQztBQUN4QyxJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxJQUFJLEVBQUUsY0FBYyxDQUFDLE1BQU0sSUFBSSxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzlGLElBQUksTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsU0FBUyxDQUFDO0FBQzFDLElBQUksT0FBTyxHQUFHO0FBQ2Q7QUFDQSxFQUFFLElBQUksQ0FBQyxTQUFTLEVBQUUsR0FBRyxFQUFFLFNBQVMsRUFBRSxtQkFBbUIsR0FBRyxJQUFJLEVBQUU7QUFDOUQsSUFBSSxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFlBQVksSUFBSSxDQUFDLG1CQUFtQixLQUFLLFlBQVksS0FBSyxZQUFZLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxHQUFHLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUNySjtBQUNBLEVBQUUsTUFBTSxNQUFNLENBQUMsT0FBTyxHQUFHLEVBQUUsRUFBRTtBQUM3QixJQUFJLElBQUksQ0FBQyxVQUFVLEVBQUUsR0FBRyxFQUFFLEdBQUcsY0FBYyxDQUFDLEdBQUcsSUFBSSxDQUFDLG9CQUFvQixDQUFDLE9BQU8sQ0FBQztBQUNqRixJQUFJLE1BQU0sSUFBSSxHQUFHLEVBQUU7QUFDbkI7QUFDQSxJQUFJLE1BQU0sU0FBUyxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLGNBQWMsQ0FBQztBQUN2RSxJQUFJLEdBQUcsR0FBRyxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLFNBQVMsQ0FBQztBQUMzQyxJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxJQUFJLEVBQUUsY0FBYyxDQUFDLE1BQU0sSUFBSSxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzlGLElBQUksTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxHQUFHLEVBQUUsU0FBUyxDQUFDO0FBQzdDLElBQUksT0FBTyxHQUFHO0FBQ2Q7QUFDQSxFQUFFLE1BQU0sUUFBUSxDQUFDLFlBQVksRUFBRTtBQUMvQixJQUFJLE1BQU0sQ0FBQyxHQUFHLEVBQUUsT0FBTyxHQUFHLElBQUksRUFBRSxHQUFHLE9BQU8sQ0FBQyxHQUFHLFlBQVksQ0FBQyxHQUFHLEdBQUcsWUFBWSxHQUFHLENBQUMsR0FBRyxFQUFFLFlBQVksQ0FBQztBQUNuRyxJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxHQUFHLE9BQU8sQ0FBQyxDQUFDO0FBQzlELElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUU7QUFDNUIsSUFBSSxJQUFJLE9BQU8sRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDO0FBQ3hFLElBQUksT0FBTyxRQUFRO0FBQ25CO0FBQ0EsRUFBRSxNQUFNLFdBQVcsQ0FBQyxZQUFZLEVBQUU7QUFDbEMsSUFBSSxNQUFNLENBQUMsR0FBRyxFQUFFLFdBQVcsR0FBRyxJQUFJLEVBQUUsR0FBRyxhQUFhLENBQUMsR0FBRyxZQUFZLENBQUMsR0FBRyxHQUFHLFlBQVksRUFBRSxDQUFDLEdBQUcsRUFBRSxZQUFZLENBQUM7QUFDNUcsSUFBSSxJQUFJLFdBQVcsRUFBRSxNQUFNLElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDO0FBQ2pELElBQUksTUFBTSxTQUFTLEdBQUcsTUFBTSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUN6QyxJQUFJLElBQUksQ0FBQyxTQUFTLEVBQUUsT0FBTyxTQUFTO0FBQ3BDLElBQUksT0FBTyxJQUFJLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQyxTQUFTLEVBQUUsYUFBYSxDQUFDO0FBQzVEO0FBQ0EsRUFBRSxNQUFNLElBQUksQ0FBQyxRQUFRLEdBQUcsS0FBSyxHQUFHO0FBQ2hDLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxNQUFNLElBQUksQ0FBQyxlQUFlLEVBQUU7QUFDL0M7QUFDQSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQztBQUMvQztBQUNBLEVBQUUsTUFBTSxLQUFLLENBQUMsR0FBRyxFQUFFLFVBQVUsRUFBRTtBQUMvQixJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUM7QUFDN0MsSUFBSSxNQUFNLElBQUksR0FBRyxRQUFRLEVBQUUsSUFBSTtBQUMvQixJQUFJLElBQUksQ0FBQyxJQUFJLEVBQUUsT0FBTyxLQUFLO0FBQzNCLElBQUksS0FBSyxNQUFNLEdBQUcsSUFBSSxVQUFVLEVBQUU7QUFDbEMsTUFBTSxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxVQUFVLENBQUMsR0FBRyxDQUFDLEVBQUUsT0FBTyxLQUFLO0FBQ3JEO0FBQ0EsSUFBSSxPQUFPLElBQUk7QUFDZjtBQUNBLEVBQUUsTUFBTSxTQUFTLENBQUMsVUFBVSxFQUFFO0FBQzlCLElBQUksS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUU7QUFDbEQsTUFBTSxJQUFJLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsVUFBVSxDQUFDLEVBQUUsT0FBTyxHQUFHO0FBQ3ZEO0FBQ0EsSUFBSSxPQUFPLEtBQUs7QUFDaEI7QUFDQSxFQUFFLE1BQU0sSUFBSSxDQUFDLFVBQVUsRUFBRTtBQUN6QixJQUFJLElBQUksS0FBSyxHQUFHLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxVQUFVLENBQUM7QUFDaEQsSUFBSSxJQUFJLEtBQUssRUFBRTtBQUNmLE1BQU0sTUFBTSxJQUFJLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3JDLE1BQU0sSUFBSSxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLFVBQVUsQ0FBQyxFQUFFLE9BQU8sS0FBSztBQUMzRDtBQUNBO0FBQ0EsSUFBSSxNQUFNLElBQUksQ0FBQyxlQUFlLEVBQUU7QUFDaEMsSUFBSSxNQUFNLElBQUksQ0FBQyxlQUFlLEVBQUU7QUFDaEMsSUFBSSxLQUFLLEdBQUcsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQztBQUM1QyxJQUFJLElBQUksS0FBSyxJQUFJLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsVUFBVSxDQUFDLEVBQUUsT0FBTyxLQUFLO0FBQ2xFLElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQSxFQUFFLFVBQVUsQ0FBQyxHQUFHLEVBQUU7QUFDbEIsSUFBSSxJQUFJLEdBQUcsRUFBRTtBQUNiLElBQUksTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQztBQUN6Qzs7QUFFQTtBQUNBO0FBQ0EsRUFBRSxNQUFNLEdBQUcsQ0FBQyxHQUFHLEVBQUU7QUFDakIsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztBQUN4QixJQUFJLE9BQU8sTUFBTSxDQUFDLE1BQU0sSUFBSSxDQUFDLGdCQUFnQixFQUFFLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFDdkQ7QUFDQTtBQUNBLEVBQUUsTUFBTSxHQUFHLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRSxZQUFZLEdBQUcsSUFBSSxFQUFFLG1CQUFtQixHQUFHLElBQUksRUFBRTtBQUM3RTtBQUNBOztBQUVBO0FBQ0EsSUFBSSxNQUFNLFVBQVUsR0FBRyxNQUFNLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxZQUFZLENBQUM7QUFDM0YsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUUsR0FBRyxJQUFJLEdBQUcsRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQzdHLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxPQUFPLFNBQVM7QUFDckMsSUFBSSxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQzs7QUFFckM7QUFDQSxJQUFJLE1BQU0sTUFBTSxHQUFHLE1BQU0sSUFBSSxDQUFDLGVBQWUsQ0FBQyxHQUFHLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxtQkFBbUIsQ0FBQztBQUM5RixJQUFJLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLE1BQU0sQ0FBQztBQUM5QztBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBLElBQUksT0FBTyxVQUFVLENBQUMsR0FBRyxDQUFDO0FBQzFCO0FBQ0EsRUFBRSxNQUFNLE1BQU0sQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFLFlBQVksR0FBRyxJQUFJLEVBQUU7QUFDcEQsSUFBSSxNQUFNLFVBQVUsR0FBRyxNQUFNLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxZQUFZLEVBQUUsWUFBWSxDQUFDO0FBQzFHLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsR0FBRyxFQUFFLFlBQVksRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLEVBQUUsVUFBVSxFQUFFLEdBQUcsRUFBRSxvQkFBb0IsRUFBRSxJQUFJLENBQUMsaUJBQWlCLENBQUM7QUFDakksSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLE9BQU8sU0FBUztBQUNyQyxJQUFJLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUM7QUFDN0IsSUFBSSxJQUFJLElBQUksQ0FBQyxpQkFBaUIsRUFBRTtBQUNoQztBQUNBO0FBQ0EsTUFBTSxNQUFNLElBQUksQ0FBQyxRQUFRLENBQUMsVUFBVSxDQUFDO0FBQ3JDLEtBQUssTUFBTTtBQUNYO0FBQ0E7QUFDQSxNQUFNLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVLEVBQUUsUUFBUSxDQUFDO0FBQy9DO0FBQ0EsSUFBSSxPQUFPLFVBQVUsQ0FBQyxHQUFHLENBQUM7QUFDMUI7O0FBRUEsRUFBRSxhQUFhLENBQUMsR0FBRyxFQUFFLGNBQWMsRUFBRSxPQUFPLEdBQUcsU0FBUyxFQUFFLFNBQVMsR0FBRyxFQUFFLEVBQUUsU0FBUyxFQUFFO0FBQ3JGO0FBQ0E7QUFDQSxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxjQUFjLEVBQUUsT0FBTyxFQUFFLEdBQUcsQ0FBQztBQUM5RDtBQUNBO0FBQ0E7QUFDQSxJQUFJLE9BQU8sU0FBUztBQUNwQjtBQUNBLEVBQUUsTUFBTSxhQUFhLENBQUMsR0FBRyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFO0FBQ3pEO0FBQ0E7QUFDQSxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsT0FBTyxtQkFBbUI7QUFDN0MsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLE9BQU8sSUFBSTtBQUM5QixJQUFJLElBQUksUUFBUSxDQUFDLEdBQUcsR0FBRyxRQUFRLENBQUMsR0FBRyxFQUFFLE9BQU8sV0FBVztBQUN2RCxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLFFBQVEsRUFBRSxRQUFRLENBQUMsRUFBRSxPQUFPLFdBQVc7QUFDaEUsSUFBSSxJQUFJLENBQUMsTUFBTSxJQUFJLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQyxFQUFFLE9BQU8sWUFBWTtBQUMvRCxJQUFJLE9BQU8sSUFBSTtBQUNmO0FBQ0EsRUFBRSxNQUFNLFlBQVksQ0FBQyxRQUFRLEVBQUU7QUFDL0IsSUFBSSxPQUFPLFFBQVEsQ0FBQyxlQUFlLENBQUMsR0FBRyxLQUFLLE1BQU0sV0FBVyxDQUFDLGVBQWUsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQzdIO0FBQ0EsRUFBRSxVQUFVLENBQUMsUUFBUSxFQUFFLFFBQVEsRUFBRTtBQUNqQyxJQUFJLE1BQU0sYUFBYSxHQUFHLFFBQVEsRUFBRSxHQUFHLElBQUksUUFBUSxFQUFFLEdBQUc7QUFDeEQsSUFBSSxNQUFNLGFBQWEsR0FBRyxRQUFRLENBQUMsR0FBRyxJQUFJLFFBQVEsQ0FBQyxHQUFHO0FBQ3REO0FBQ0E7QUFDQTtBQUNBLElBQUksSUFBSSxDQUFDLGFBQWEsS0FBSyxhQUFhLEtBQUssYUFBYSxLQUFLLGFBQWEsQ0FBQyxDQUFDLEVBQUUsT0FBTyxLQUFLOztBQUU1RjtBQUNBOztBQUVBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBOztBQUVBO0FBQ0E7O0FBRUE7QUFDQTs7QUFFQSxJQUFJLE9BQU8sSUFBSTtBQUNmO0FBQ0EsRUFBRSxVQUFVLENBQUMsUUFBUSxFQUFFO0FBQ3ZCLElBQUksT0FBTyxRQUFRLENBQUMsR0FBRztBQUN2QjtBQUNBLEVBQUUscUJBQXFCLENBQUMsR0FBRyxFQUFFLFVBQVUsRUFBRTtBQUN6QyxJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsQ0FBQztBQUM5QjtBQUNBO0FBQ0EsRUFBRSxNQUFNLGtCQUFrQixDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsY0FBYyxFQUFFLFlBQVksRUFBRSxVQUFVLEdBQUcsS0FBSyxFQUFFO0FBQzdGO0FBQ0E7QUFDQSxJQUFJLE1BQU0saUJBQWlCLEdBQUcsWUFBWSxHQUFHLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUNqRSxJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsU0FBUyxFQUFFLGlCQUFpQixDQUFDO0FBQ2hGLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxPQUFPLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxFQUFFLGNBQWMsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLFNBQVMsQ0FBQztBQUNqRyxJQUFJLFFBQVEsQ0FBQyxZQUFZLEdBQUcsWUFBWTtBQUN4QyxJQUFJLEdBQUcsR0FBRyxRQUFRLENBQUMsR0FBRyxHQUFHLFFBQVEsQ0FBQyxVQUFVLEdBQUcsVUFBVSxHQUFHLEdBQUcsR0FBRyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxFQUFFLFFBQVEsQ0FBQztBQUN6RyxJQUFJLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDO0FBQ2hELElBQUksTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsRUFBRSxVQUFVLENBQUM7QUFDbkUsSUFBSSxNQUFNLGdCQUFnQixHQUFHLFFBQVEsQ0FBQyxRQUFRLEdBQUcsVUFBVSxJQUFJLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUUsV0FBVyxDQUFDLENBQUM7QUFDckgsSUFBSSxNQUFNLFVBQVUsR0FBRyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxFQUFFLGdCQUFnQixFQUFFLGVBQWUsRUFBRSxRQUFRLEVBQUUsZUFBZSxFQUFFLFFBQVEsQ0FBQztBQUM1SCxJQUFJLElBQUksVUFBVSxFQUFFLE9BQU8sSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLEVBQUUsY0FBYyxFQUFFLFVBQVUsRUFBRSxRQUFRLENBQUM7QUFDeEYsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxHQUFHLEVBQUUsUUFBUSxDQUFDLElBQUksQ0FBQztBQUN4QyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO0FBQ3ZCLElBQUksT0FBTyxRQUFRO0FBQ25CO0FBQ0E7QUFDQSxFQUFFLGVBQWUsQ0FBQyxHQUFHLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRTtBQUM5QyxJQUFJLE9BQU8sU0FBUyxDQUFDO0FBQ3JCO0FBQ0EsRUFBRSxNQUFNLE9BQU8sQ0FBQyxHQUFHLEVBQUUsZUFBZSxFQUFFLFNBQVMsR0FBRyxLQUFLLEVBQUU7QUFDekQsSUFBSSxPQUFPLENBQUMsTUFBTSxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsU0FBUyxDQUFDLENBQUMsR0FBRyxFQUFFLGVBQWUsQ0FBQztBQUN6RTtBQUNBLEVBQUUsZUFBZSxDQUFDLFVBQVUsRUFBRTtBQUM5QixJQUFJLE9BQU8sVUFBVTtBQUNyQjtBQUNBLEVBQUUsTUFBTSxRQUFRLENBQUMsVUFBVSxFQUFFLFNBQVMsR0FBRyxLQUFLLEVBQUU7QUFDaEQsSUFBSSxNQUFNLENBQUMsR0FBRyxFQUFFLFNBQVMsQ0FBQyxHQUFHLFVBQVU7QUFDdkMsSUFBSSxNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUM7QUFDcEUsSUFBSSxNQUFNLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQyxnQkFBZ0I7QUFDL0MsSUFBSSxNQUFNLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQyxHQUFHLEVBQUUsZUFBZSxDQUFDO0FBQ2xELElBQUksT0FBTyxHQUFHO0FBQ2Q7QUFDQSxFQUFFLElBQUksQ0FBQyxRQUFRLEVBQUU7QUFDakIsSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksV0FBVyxDQUFDLFFBQVEsRUFBRSxDQUFDLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO0FBQ3JFO0FBQ0EsRUFBRSxJQUFJLFdBQVcsR0FBRztBQUNwQixJQUFJLE9BQU8sSUFBSTtBQUNmOztBQUVBLEVBQUUsYUFBYSxHQUFHLElBQUksR0FBRyxFQUFFLENBQUM7QUFDNUIsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDLEVBQUU7QUFDdEIsSUFBSSxNQUFNLE9BQU8sR0FBRyxFQUFFO0FBQ3RCLElBQUksS0FBSyxNQUFNLFlBQVksSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRSxFQUFFO0FBQzVELE1BQU0sT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDbkM7QUFDQSxJQUFJLE9BQU8sT0FBTztBQUNsQjtBQUNBLEVBQUUsSUFBSSxRQUFRLEdBQUc7QUFDakIsSUFBSSxPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNoRDtBQUNBO0FBQ0EsRUFBRSxNQUFNLFdBQVcsQ0FBQyxHQUFHLFFBQVEsRUFBRTtBQUNqQyxJQUFJLE1BQU0sQ0FBQyxhQUFhLENBQUMsR0FBRyxJQUFJO0FBQ2hDLElBQUksS0FBSyxJQUFJLE9BQU8sSUFBSSxRQUFRLEVBQUU7QUFDbEMsTUFBTSxJQUFJLGFBQWEsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUU7QUFDdEMsTUFBTSxNQUFNLFlBQVksQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQy9DO0FBQ0E7QUFDQSxFQUFFLElBQUksWUFBWSxHQUFHO0FBQ3JCO0FBQ0EsSUFBSSxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsaUNBQWlDLENBQUMsQ0FBQztBQUN2RjtBQUNBLEVBQUUsTUFBTSxVQUFVLENBQUMsR0FBRyxRQUFRLEVBQUU7QUFDaEMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sRUFBRSxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQVE7QUFDbEQsSUFBSSxNQUFNLENBQUMsYUFBYSxDQUFDLEdBQUcsSUFBSTtBQUNoQyxJQUFJLEtBQUssSUFBSSxPQUFPLElBQUksUUFBUSxFQUFFO0FBQ2xDLE1BQU0sTUFBTSxZQUFZLEdBQUcsYUFBYSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUM7QUFDckQsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFO0FBQ3pCO0FBQ0EsQ0FBQztBQUNEO0FBQ0EsTUFBTSxNQUFNLFlBQVksQ0FBQyxVQUFVLEVBQUU7QUFDckM7QUFDQTtBQUNBLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQyxXQUFXLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRTtBQUNqRSxJQUFJLElBQUksWUFBWSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQztBQUMxRCxJQUFJLElBQUksQ0FBQyxZQUFZLEVBQUU7QUFDdkIsTUFBTSxZQUFZLEdBQUcsSUFBSSxZQUFZLENBQUMsQ0FBQyxXQUFXLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3pGLE1BQU0sWUFBWSxDQUFDLFVBQVUsR0FBRyxVQUFVO0FBQzFDLE1BQU0sWUFBWSxDQUFDLGtCQUFrQixHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDO0FBQ3BFLE1BQU0sSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLFlBQVksQ0FBQztBQUN2RDtBQUNBLEtBQUssTUFBTSxJQUFJLENBQUMsWUFBWSxDQUFDLFVBQVUsS0FBSyxVQUFVO0FBQ3RELFNBQVMsWUFBWSxDQUFDLFdBQVcsS0FBSyxXQUFXLENBQUMsS0FBSyxDQUFDO0FBQ3hELFNBQVMsTUFBTSxZQUFZLENBQUMsa0JBQWtCLEtBQUssV0FBVyxDQUFDLEVBQUU7QUFDakUsTUFBTSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMseUJBQXlCLEVBQUUsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2pFO0FBQ0EsSUFBSSxPQUFPLFlBQVk7QUFDdkI7O0FBRUEsRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxFQUFFLE9BQU8sS0FBSyxDQUFDLEVBQUU7QUFDdkMsRUFBRSxZQUFZLENBQUMsR0FBRyxFQUFFO0FBQ3BCLElBQUksT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZLElBQUksWUFBWSxDQUFDLHNCQUFzQixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDdkc7QUFDQSxFQUFFLE1BQU0sZUFBZSxHQUFHO0FBQzFCLElBQUksT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxNQUFNLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO0FBQ3pEO0FBQ0EsRUFBRSxNQUFNLGVBQWUsR0FBRztBQUMxQixJQUFJLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsTUFBTSxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUN6RDtBQUNBLEVBQUUsSUFBSSxRQUFRLENBQUMsT0FBTyxFQUFFO0FBQ3hCLElBQUksSUFBSSxPQUFPLEVBQUU7QUFDakIsTUFBTSxJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU87QUFDNUIsTUFBTSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsUUFBUSxFQUFFLE9BQU8sQ0FBQztBQUM5QyxLQUFLLE1BQU07QUFDWCxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQztBQUN0RCxNQUFNLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTztBQUM1QjtBQUNBO0FBQ0EsRUFBRSxJQUFJLFFBQVEsR0FBRztBQUNqQixJQUFJLE9BQU8sSUFBSSxDQUFDLE9BQU87QUFDdkI7QUFDQTs7QUFFTyxNQUFNLG1CQUFtQixTQUFTLFVBQVUsQ0FBQztBQUNwRCxFQUFFLGFBQWEsQ0FBQyxHQUFHLEVBQUUsVUFBVSxFQUFFO0FBQ2pDLElBQUksT0FBTyxVQUFVLENBQUMsZUFBZSxDQUFDLEdBQUc7QUFDekM7QUFDQSxFQUFFLE1BQU0sYUFBYSxDQUFDLEdBQUcsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRTtBQUN6RCxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsT0FBTyxtQkFBbUI7QUFDN0MsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFO0FBQ25CLE1BQU0sSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLEdBQUcsS0FBSyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsT0FBTyxXQUFXO0FBQ3ZFLE1BQU0sSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsRUFBRSxPQUFPLFlBQVk7QUFDakUsTUFBTSxPQUFPLElBQUksQ0FBQztBQUNsQjtBQUNBO0FBQ0EsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEtBQUssUUFBUSxDQUFDLEdBQUcsR0FBRyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsT0FBTyxJQUFJLENBQUM7QUFDL0UsSUFBSSxJQUFJLFFBQVEsQ0FBQyxHQUFHLEdBQUcsUUFBUSxDQUFDLEdBQUcsRUFBRSxPQUFPLFNBQVMsQ0FBQztBQUN0RCxJQUFJLElBQUksUUFBUSxDQUFDLEdBQUcsS0FBSyxRQUFRLENBQUMsR0FBRyxFQUFFLE9BQU8sa0JBQWtCO0FBQ2hFLElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQTtBQUNPLE1BQU0saUJBQWlCLFNBQVMsVUFBVSxDQUFDO0FBQ2xELEVBQUUsYUFBYSxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUU7QUFDakMsSUFBSSxPQUFPLEdBQUcsSUFBSSxVQUFVLENBQUMsZUFBZSxDQUFDLEdBQUc7QUFDaEQ7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ08sTUFBTSxpQkFBaUIsU0FBUyxpQkFBaUIsQ0FBQztBQUN6RCxFQUFFLE1BQU0sYUFBYSxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUU7QUFDdkMsSUFBSSxJQUFJLEdBQUcsRUFBRSxPQUFPLEdBQUc7QUFDdkI7QUFDQSxJQUFJLE1BQU0sR0FBRyxHQUFHLFVBQVUsQ0FBQyxlQUFlLENBQUMsR0FBRztBQUM5QyxJQUFJLE1BQU0sV0FBVyxHQUFHLFVBQVUsQ0FBQyxJQUFJLElBQUksSUFBSSxXQUFXLEVBQUUsQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQztBQUN2RixJQUFJLE9BQU8sV0FBVyxDQUFDLGVBQWUsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxRQUFRLENBQUMsR0FBRyxHQUFHLFdBQVcsQ0FBQyxDQUFDO0FBQ3JGO0FBQ0EsRUFBRSxVQUFVLENBQUMsVUFBVSxFQUFFO0FBQ3pCO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBSSxNQUFNLE1BQU0sR0FBRyxVQUFVLEVBQUUsZUFBZTtBQUM5QyxJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFO0FBQzFCLElBQUksTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLEdBQUc7QUFDakMsSUFBSSxJQUFJLE9BQU8sVUFBVSxDQUFDLEtBQUssUUFBUSxFQUFFLE9BQU8sRUFBRSxDQUFDO0FBQ25ELElBQUksT0FBTyxVQUFVO0FBQ3JCO0FBQ0EsRUFBRSxNQUFNLFlBQVksQ0FBQyxRQUFRLEVBQUU7QUFDL0IsSUFBSSxPQUFPLElBQUksQ0FBQztBQUNoQjtBQUNBLEVBQUUsSUFBSSxDQUFDLFFBQVEsRUFBRTtBQUNqQixJQUFJLFFBQVEsQ0FBQyxVQUFVLEdBQUcsUUFBUSxDQUFDLGVBQWUsQ0FBQyxHQUFHO0FBQ3RELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7QUFDeEI7QUFDQTs7QUFFTyxNQUFNLG1CQUFtQixTQUFTLGlCQUFpQixDQUFDO0FBQzNEO0FBQ0E7QUFDQTtBQUNBLEVBQUUsV0FBVyxDQUFDLENBQUMsUUFBUSxHQUFHLEVBQUUsRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsRUFBRTtBQUM3QyxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNoQixJQUFJLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNoRDtBQUNBLElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDO0FBQ2xDO0FBQ0EsRUFBRSxNQUFNLEtBQUssR0FBRztBQUNoQixJQUFJLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLEVBQUU7QUFDL0IsSUFBSSxNQUFNLEtBQUssQ0FBQyxLQUFLLEVBQUU7QUFDdkI7QUFDQSxFQUFFLE1BQU0sT0FBTyxHQUFHO0FBQ2xCLElBQUksTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sRUFBRTtBQUNqQyxJQUFJLE1BQU0sS0FBSyxDQUFDLE9BQU8sRUFBRTtBQUN6QjtBQUNBLEVBQUUsVUFBVSxDQUFDLFFBQVEsRUFBRTtBQUN2QixJQUFJLE9BQU8sTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLEVBQUUsUUFBUSxFQUFFLENBQUMsR0FBRyxFQUFFLFFBQVEsQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUM1RTtBQUNBLEVBQUUsaUJBQWlCLENBQUMsT0FBTyxFQUFFO0FBQzdCLElBQUksT0FBTyxPQUFPLEVBQUUsUUFBUSxJQUFJLE9BQU8sQ0FBQztBQUN4QztBQUNBLEVBQUUsa0JBQWtCLENBQUMsUUFBUSxFQUFFO0FBQy9CLElBQUksT0FBTyxRQUFRLENBQUMsR0FBRyxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDbkU7QUFDQSxFQUFFLE1BQU0sV0FBVyxDQUFDLEdBQUcsUUFBUSxFQUFFO0FBQ2pDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLEVBQUU7QUFDMUI7QUFDQSxJQUFJLE1BQU0sZ0JBQWdCLEdBQUcsS0FBSyxDQUFDLFdBQVcsQ0FBQyxHQUFHLFFBQVEsQ0FBQztBQUMzRCxJQUFJLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLEdBQUcsSUFBSSxDQUFDLGtCQUFrQixDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQzFGLElBQUksTUFBTSxnQkFBZ0I7QUFDMUIsSUFBSSxNQUFNLGNBQWM7QUFDeEI7QUFDQSxFQUFFLE1BQU0sVUFBVSxDQUFDLEdBQUcsUUFBUSxFQUFFO0FBQ2hDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLEVBQUUsUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRO0FBQ2xELElBQUksTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxHQUFHLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN4RSxJQUFJLE1BQU0sS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHLFFBQVEsQ0FBQztBQUN2QztBQUNBLEVBQUUsSUFBSSxZQUFZLEdBQUc7QUFDckI7QUFDQSxJQUFJLE9BQU8sS0FBSyxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQztBQUNwRTtBQUNBLEVBQUUsSUFBSSxXQUFXLEdBQUc7QUFDcEI7QUFDQSxJQUFJLE9BQU8sSUFBSSxDQUFDLFFBQVE7QUFDeEI7O0FBRUEsRUFBRSxNQUFNLFdBQVcsQ0FBQyxHQUFHLEVBQUU7QUFDekIsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztBQUN4QixJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2xELElBQUksTUFBTSxJQUFJLEdBQUcsUUFBUSxFQUFFLElBQUk7QUFDL0IsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxPQUFPLElBQUk7QUFDekM7QUFDQTtBQUNBLElBQUksTUFBTSxrQkFBa0IsR0FBRyxNQUFNLElBQUksQ0FBQyxjQUFjLENBQUMsUUFBUSxDQUFDO0FBQ2xFLElBQUksT0FBTyxJQUFJLENBQUMsaUJBQWlCLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxHQUFHLGtCQUFrQixDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3BGO0FBQ0EsRUFBRSxNQUFNLGtCQUFrQixDQUFDLEdBQUcsRUFBRTtBQUNoQyxJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUM7QUFDaEQsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLE9BQU8sUUFBUTtBQUNsQyxJQUFJLE9BQU8sTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sSUFBSSxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUMxRTtBQUNBLEVBQUUsYUFBYSxDQUFDLFVBQVUsRUFBRSxJQUFJLEdBQUcsVUFBVSxDQUFDLE1BQU0sRUFBRTtBQUN0RDtBQUNBLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxPQUFPLFVBQVU7QUFDdEMsSUFBSSxJQUFJLElBQUksR0FBRyxVQUFVLENBQUMsSUFBSSxDQUFDO0FBQy9CLElBQUksSUFBSSxJQUFJLEVBQUUsT0FBTyxJQUFJO0FBQ3pCO0FBQ0EsSUFBSSxJQUFJLElBQUksR0FBRyxDQUFDLEVBQUUsS0FBSyxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDO0FBQ2pELElBQUksS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7QUFDM0MsTUFBTSxJQUFJLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxJQUFJLEVBQUUsSUFBSSxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDM0MsV0FBVztBQUNYO0FBQ0EsSUFBSSxPQUFPLFVBQVUsQ0FBQyxJQUFJLENBQUM7QUFDM0I7QUFDQSxFQUFFLE1BQU0sUUFBUSxDQUFDLFlBQVksRUFBRTtBQUMvQixJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxZQUFZLElBQUksWUFBWSxDQUFDLE1BQU0sSUFBSSxDQUFDLEdBQUcsRUFBRSxZQUFZLENBQUMsR0FBRyxZQUFZO0FBQ2hILElBQUksSUFBSSxDQUFDLElBQUksRUFBRTtBQUNmLE1BQU0sTUFBTSxVQUFVLEdBQUcsTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQztBQUNwRCxNQUFNLElBQUksQ0FBQyxVQUFVLEVBQUUsT0FBTyxVQUFVO0FBQ3hDLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQztBQUNqRCxNQUFNLElBQUksQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO0FBQzFCO0FBQ0EsSUFBSSxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0FBQ3ZEO0FBQ0EsRUFBRSxNQUFNLEtBQUssQ0FBQyxJQUFJLEVBQUUsT0FBTyxHQUFHLEVBQUUsRUFBRTtBQUNsQztBQUNBLElBQUksSUFBSSxRQUFRO0FBQ2hCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxDQUFDLENBQUMsR0FBRyxFQUFFLFVBQVUsRUFBRSxHQUFHLGNBQWMsQ0FBQyxHQUFHLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxPQUFPLENBQUM7QUFDMUUsQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRTtBQUNsQixDQUFDLGNBQWMsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLFVBQVUsQ0FBQyxFQUFFLGNBQWMsQ0FBQztBQUNuRSxJQUFJLElBQUksR0FBRyxFQUFFO0FBQ2IsTUFBTSxRQUFRLEdBQUcsQ0FBQyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRTtBQUNwRCxNQUFNLGNBQWMsQ0FBQyxHQUFHLEdBQUcsR0FBRztBQUM5QixNQUFNLElBQUksUUFBUSxFQUFFO0FBQ3BCLENBQUMsY0FBYyxDQUFDLEdBQUcsR0FBRyxRQUFRLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQztBQUMvQztBQUNBLEtBQUs7QUFDTCxJQUFJLGNBQWMsQ0FBQyxHQUFHLEtBQUssSUFBSTtBQUMvQixJQUFJLE1BQU0sSUFBSSxHQUFHLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGNBQWMsQ0FBQztBQUNoRSxJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUU7QUFDZCxNQUFNLE1BQU0sZ0JBQWdCLEdBQUcsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUM7QUFDNUQsTUFBTSxNQUFNLE1BQU0sR0FBRyxXQUFXLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsWUFBWSxDQUFDLGdCQUFnQixDQUFDLENBQUM7QUFDOUYsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLEdBQUc7QUFDdEIsTUFBTSxRQUFRLEdBQUcsRUFBRTtBQUNuQjtBQUNBLElBQUksUUFBUSxDQUFDLE1BQU0sR0FBRyxJQUFJO0FBQzFCLElBQUksUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUk7O0FBRXpCO0FBQ0EsSUFBSSxNQUFNLFNBQVMsR0FBRyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxjQUFjLENBQUM7QUFDM0U7QUFDQSxJQUFJLE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUM7QUFDMUIsSUFBSSxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLFNBQVMsQ0FBQztBQUN0QyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLEVBQUUsVUFBVSxFQUFFLEdBQUcsRUFBRSxJQUFJLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3BGLElBQUksTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsU0FBUyxDQUFDO0FBQzFDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQSxJQUFJLE9BQU8sR0FBRztBQUNkO0FBQ0EsRUFBRSxNQUFNLE1BQU0sQ0FBQyxPQUFPLEdBQUcsRUFBRSxFQUFFO0FBQzdCLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxHQUFHLEVBQUUsR0FBRyxjQUFjLENBQUMsR0FBRyxJQUFJLENBQUMsb0JBQW9CLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDbEYsSUFBSSxNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDO0FBQ2hELElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxPQUFPLFFBQVE7QUFDbEMsSUFBSSxJQUFJLElBQUksQ0FBQyxpQkFBaUIsRUFBRTtBQUNoQyxNQUFNLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLEVBQUUsY0FBYyxDQUFDO0FBQzFDLEtBQUssTUFBTTtBQUNYO0FBQ0EsTUFBTSxNQUFNLFdBQVcsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDMUQsTUFBTSxNQUFNLGdCQUFnQixHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLGNBQWMsQ0FBQyxDQUFDO0FBQzdGO0FBQ0EsTUFBTSxNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEdBQUcsSUFBSTtBQUNyRCxDQUFDLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLGdCQUFnQixDQUFDO0FBQ2xELENBQUMsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsR0FBRyxFQUFFLGdCQUFnQixDQUFDO0FBQzFELE9BQU8sQ0FBQyxDQUFDO0FBQ1QsTUFBTSxNQUFNLFNBQVMsR0FBRyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxjQUFjLENBQUM7QUFDdkUsTUFBTSxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRSxRQUFRLENBQUM7QUFDbEQsTUFBTSxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUM7QUFDL0M7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUM7QUFDN0IsSUFBSSxPQUFPLEdBQUc7QUFDZDtBQUNBLEVBQUUsTUFBTSxlQUFlLENBQUMsR0FBRyxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsY0FBYyxHQUFHLElBQUksRUFBRTtBQUMzRTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBLElBQUksSUFBSSxJQUFJLEdBQUcsVUFBVTtBQUN6QixJQUFJLElBQUksUUFBUSxHQUFHLFVBQVUsQ0FBQyxRQUFRO0FBQ3RDO0FBQ0EsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLE9BQU8sU0FBUyxDQUFDO0FBQ3BDOztBQUVBO0FBQ0E7QUFDQSxJQUFJLElBQUksVUFBVSxDQUFDLGVBQWUsQ0FBQyxHQUFHLEdBQUcsVUFBVSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsR0FBRyxFQUFFO0FBQ2xGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFNLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQztBQUN6Qzs7QUFFQTtBQUNBLElBQUksSUFBSSxhQUFhLEdBQUcsSUFBSTtBQUM1QixJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFO0FBQ3BFLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDO0FBQ2hFO0FBQ0EsTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRSxPQUFPLElBQUksQ0FBQyxXQUFXLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUN0RjtBQUNBO0FBQ0E7O0FBRUE7QUFDQSxJQUFJLE1BQU0sbUJBQW1CLEdBQUcsTUFBTSxJQUFJLENBQUMsY0FBYyxDQUFDLFFBQVEsQ0FBQztBQUNuRSxJQUFJLE1BQU0sZUFBZSxHQUFHLE1BQU0sSUFBSSxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUM7QUFDM0Q7QUFDQSxJQUFJLE1BQU0sTUFBTSxHQUFHLG1CQUFtQixDQUFDLENBQUMsQ0FBQyxDQUFDLGVBQWU7QUFDekQsSUFBSSxJQUFJLEtBQUssR0FBRyxNQUFNLENBQUMsR0FBRyxJQUFJLE1BQU0sQ0FBQyxHQUFHO0FBQ3hDLElBQUksSUFBSSxPQUFPLEdBQUcsQ0FBQyxXQUFXLENBQUMsS0FBSyxFQUFFLFdBQVcsQ0FBQyxNQUFNLEVBQUUsY0FBYyxDQUFDLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztBQUN6RjtBQUNBLElBQUksSUFBSSxPQUFPLEdBQUcsT0FBTyxLQUFLLENBQUMsY0FBYyxJQUFJLE1BQU0sV0FBVyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUM7QUFDdEcsSUFBSSxJQUFJLE1BQU0sRUFBRSxPQUFPLEVBQUUsSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUU7QUFDMUMsSUFBSSxNQUFNLE1BQU0sR0FBRyxjQUFjLElBQUksV0FBVyxDQUFDLE1BQU07QUFDdkQsSUFBSSxTQUFTLE9BQU8sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsT0FBTyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNwRCxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUU7QUFDbEI7QUFDQSxNQUFNLFNBQVMsYUFBYSxDQUFDLFdBQVcsRUFBRSxFQUFFLE9BQU8sV0FBVyxDQUFDLEdBQUcsQ0FBQyxVQUFVLElBQUksVUFBVSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ3ZHLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxhQUFhLENBQUMsbUJBQW1CLENBQUMsRUFBRSxhQUFhLENBQUMsZUFBZSxDQUFDLENBQUM7QUFDMUYsTUFBTSxPQUFPLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsRUFBRSxJQUFJLENBQUM7QUFDdEMsS0FBSyxNQUFNO0FBQ1gsTUFBTSxTQUFTLFFBQVEsQ0FBQyxXQUFXLEVBQUUsRUFBRSxPQUFPLFdBQVcsQ0FBQyxHQUFHLENBQUMsVUFBVSxJQUFJLFVBQVUsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUM3RixNQUFNLE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLENBQUMsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLENBQUM7QUFDekYsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLGlCQUFpQixDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsYUFBYSxFQUFFLEdBQUcsU0FBUyxDQUFDO0FBQzVFLE1BQU0sT0FBTyxHQUFHLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLElBQUksQ0FBQztBQUNuRDtBQUNBO0FBQ0EsSUFBSSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLE9BQU8sQ0FBQztBQUN2RDtBQUNBO0FBQ0EsRUFBRSxjQUFjLENBQUMsVUFBVSxFQUFFO0FBQzdCLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUM7QUFDNUQsSUFBSSxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxJQUFJLElBQUksQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDNUY7QUFDQSxFQUFFLFdBQVcsQ0FBQyxlQUFlLEVBQUUsWUFBWSxFQUFFO0FBQzdDLElBQUksTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUMzRCxJQUFJLE9BQU8sTUFBTSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxJQUFJLEdBQUcsS0FBSyxRQUFRLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ2hIO0FBQ0EsRUFBRSxpQkFBaUIsQ0FBQyxHQUFHLEVBQUUsYUFBYSxFQUFFLGdCQUFnQixFQUFFLFlBQVksRUFBRSxHQUFHLElBQUksRUFBRTtBQUNqRjtBQUNBLElBQUksYUFBYSxLQUFLLElBQUksQ0FBQyxXQUFXLENBQUMsZ0JBQWdCLEVBQUUsWUFBWSxDQUFDO0FBQ3RFLElBQUksTUFBTSxNQUFNLEdBQUcsRUFBRTtBQUNyQixJQUFJLElBQUksWUFBWSxHQUFHLENBQUMsRUFBRSxXQUFXLEVBQUUsU0FBUztBQUNoRCxJQUFJLEtBQUssTUFBTSxRQUFRLElBQUksWUFBWSxFQUFFO0FBQ3pDLE1BQU0sV0FBVyxHQUFHLENBQUM7O0FBRXJCO0FBQ0EsTUFBTSxJQUFJLFFBQVEsS0FBSyxRQUFRLEVBQUU7QUFDakMsQ0FBQyxPQUFPLENBQUMsWUFBWSxHQUFHLGFBQWEsQ0FBQyxNQUFNLE1BQU0sQ0FBQyxXQUFXLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxJQUFJLFFBQVEsQ0FBQyxFQUFFLFlBQVksRUFBRSxFQUFFO0FBQzNILEdBQUcsTUFBTSxDQUFDLFdBQVcsQ0FBQyxHQUFHLGdCQUFnQixDQUFDLFdBQVcsQ0FBQztBQUN0RDtBQUNBOztBQUVBLE1BQU0sSUFBSSxXQUFXLEtBQUssUUFBUSxFQUFFO0FBQ3BDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUMsd0NBQXdDLEVBQUUsV0FBVyxDQUFDLFNBQVMsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdkcsQ0FBQyxTQUFTLEtBQUssTUFBTSxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUN6QyxDQUFDLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLFlBQVksR0FBRyxDQUFDLENBQUMsSUFBSSxRQUFRO0FBQzFFLFVBQVUsWUFBWSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksUUFBUSxDQUFDO0FBQ3BFLENBQUMsTUFBTSxVQUFVLEdBQUcsUUFBUSxHQUFHLENBQUMsWUFBWSxHQUFHLFFBQVEsSUFBSSxDQUFDO0FBQzVEO0FBQ0EsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEdBQUcsZ0JBQWdCLENBQUMsUUFBUSxDQUFDO0FBQzlDLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxHQUFHLFlBQVksQ0FBQyxRQUFRLENBQUM7O0FBRTVDLE9BQU8sTUFBTTtBQUNiLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxHQUFHLFlBQVksQ0FBQyxRQUFRLENBQUM7QUFDMUM7QUFDQTs7QUFFQTtBQUNBLElBQUksT0FBTyxZQUFZLEdBQUcsYUFBYSxDQUFDLE1BQU0sRUFBRSxZQUFZLEVBQUUsRUFBRTtBQUNoRSxNQUFNLFdBQVcsR0FBRyxhQUFhLENBQUMsWUFBWSxDQUFDO0FBQy9DLE1BQU0sTUFBTSxDQUFDLFdBQVcsQ0FBQyxHQUFHLGdCQUFnQixDQUFDLFdBQVcsQ0FBQztBQUN6RDtBQUNBLElBQUksSUFBSSxXQUFXLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7QUFDekMsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLFdBQVcsQ0FBQyxXQUFXLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztBQUN2RCxJQUFJLE9BQU8sSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsaUJBQWlCLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBRyxNQUFNO0FBQ3pGO0FBQ0EsRUFBRSxhQUFhLE1BQU0sQ0FBQyxTQUFTLEVBQUUsT0FBTyxHQUFHLEVBQUUsRUFBRTtBQUMvQyxJQUFJLElBQUksU0FBUyxDQUFDLFVBQVUsR0FBRyxHQUFHLENBQUMsRUFBRSxTQUFTLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUN2RSxJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxFQUFFLE9BQU8sTUFBTSxLQUFLLENBQUMsTUFBTSxDQUFDLFNBQVMsRUFBRSxPQUFPLENBQUM7QUFDaEYsSUFBSSxNQUFNLFFBQVEsR0FBRyxNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxPQUFPLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUMvRixJQUFJLE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsT0FBTyxJQUFJLE9BQU8sQ0FBQztBQUNqRCxJQUFJLElBQUksQ0FBQyxFQUFFLEVBQUUsT0FBTyxTQUFTO0FBQzdCLElBQUksTUFBTSxlQUFlLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLGVBQWU7QUFDdkQsSUFBSSxLQUFLLE1BQU0sUUFBUSxJQUFJLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDLEVBQUU7QUFDekQsTUFBTSxNQUFNLFFBQVEsR0FBRyxlQUFlLENBQUMsUUFBUSxDQUFDO0FBQ2hELE1BQU0sTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQyxPQUFPLElBQUksT0FBTyxDQUFDLGVBQWUsQ0FBQyxRQUFRLENBQUMsS0FBSyxRQUFRLENBQUM7QUFDL0YsTUFBTSxJQUFJLE9BQU8sRUFBRTtBQUNuQixNQUFNLElBQUksQ0FBQyxPQUFPLEVBQUUsT0FBTyxTQUFTO0FBQ3BDO0FBQ0EsSUFBSSxNQUFNLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxDQUFDLEdBQUcsZUFBZTtBQUNoRCxJQUFJLE1BQU0sUUFBUSxHQUFHO0FBQ3JCLE1BQU0sU0FBUztBQUNmLE1BQU0sSUFBSSxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsT0FBTyxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUM7QUFDakQsTUFBTSxlQUFlLEVBQUUsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxRQUFRLENBQUMsR0FBRyxDQUFDLE9BQU8sSUFBSSxPQUFPLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2xILEtBQUs7QUFDTCxJQUFJLE9BQU8sUUFBUTtBQUNuQjtBQUNBLEVBQUUsTUFBTSxhQUFhLENBQUMsR0FBRyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFO0FBQ3pELElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxPQUFPLG1CQUFtQjtBQUM3QyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsT0FBTyxJQUFJO0FBQzlCLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsUUFBUSxFQUFFLFFBQVEsQ0FBQyxFQUFFLE9BQU8sV0FBVztBQUNoRSxJQUFJLElBQUksQ0FBQyxNQUFNLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLEVBQUUsT0FBTyxZQUFZO0FBQy9ELElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQSxFQUFFLFVBQVUsQ0FBQyxRQUFRLEVBQUUsUUFBUSxFQUFFO0FBQ2pDLElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQTs7O0FBR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQSxXQUFXLENBQUMsTUFBTSxHQUFHLElBQUk7QUFDekIsV0FBVyxDQUFDLEtBQUssR0FBRyxJQUFJO0FBQ3hCLFdBQVcsQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDO0FBQzlCLFdBQVcsQ0FBQyxXQUFXLEdBQUcsT0FBTyxHQUFHLFFBQVEsS0FBSztBQUNqRDtBQUNBLEVBQUUsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxVQUFVLElBQUksVUFBVSxDQUFDLFdBQVcsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDbkgsQ0FBQztBQUNELFdBQVcsQ0FBQyxZQUFZLEdBQUcsWUFBWTtBQUN2QyxFQUFFLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFHLENBQUMsVUFBVSxJQUFJLFVBQVUsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUN2RztBQUNBLFdBQVcsQ0FBQyxVQUFVLEdBQUcsT0FBTyxHQUFHLFFBQVEsS0FBSztBQUNoRCxFQUFFLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFHLENBQUMsVUFBVSxJQUFJLFVBQVUsQ0FBQyxVQUFVLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDO0FBQ2xIOztBQUVBLFdBQVcsQ0FBQyxZQUFZLEdBQUcsT0FBTyxNQUFNLEtBQUs7QUFDN0M7QUFDQTtBQUNBLEVBQUUsSUFBSSxNQUFNLEtBQUssR0FBRyxFQUFFLE9BQU8sV0FBVyxDQUFDLE1BQU0sQ0FBQyxNQUFNLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQ25GLEVBQUUsTUFBTSxDQUFDLEtBQUssRUFBRSxRQUFRLENBQUMsR0FBRyxNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxXQUFXLENBQUMsTUFBTSxFQUFFLEVBQUUsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNuRyxFQUFFLE9BQU8sV0FBVyxDQUFDLE1BQU0sQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDO0FBQzVDLENBQUM7QUFDRCxXQUFXLENBQUMsZUFBZSxHQUFHLE9BQU8sR0FBRyxFQUFFLFNBQVMsS0FBSztBQUN4RDtBQUNBLEVBQUUsTUFBTSxRQUFRLEdBQUcsTUFBTSxXQUFXLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNyRSxFQUFFLElBQUksQ0FBQyxRQUFRLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxDQUFDLDRCQUE0QixFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN2RSxFQUFFLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsVUFBVTtBQUMxQyxFQUFFLElBQUksT0FBTyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxDQUFDLG9DQUFvQyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDekYsRUFBRSxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUc7QUFDOUMsRUFBRSxNQUFNLGNBQWMsR0FBRyxNQUFNLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDLENBQUM7QUFDdEUsRUFBRSxNQUFNLFNBQVMsR0FBRyxNQUFNLFdBQVcsQ0FBQyxNQUFNLEVBQUU7O0FBRTlDO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsRUFBRSxNQUFNLFdBQVcsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQyxTQUFTLEVBQUUsY0FBYyxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQztBQUN2RyxFQUFFLE1BQU0sV0FBVyxDQUFDLGdCQUFnQixDQUFDLENBQUMsR0FBRyxFQUFFLE1BQU0sRUFBRSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUM7QUFDckUsRUFBRSxNQUFNLFdBQVcsQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDO0FBQzNDLEVBQUUsT0FBTyxHQUFHO0FBQ1osQ0FBQztBQUNELE1BQU0sT0FBTyxHQUFHLEVBQUUsQ0FBQztBQUNuQixXQUFXLENBQUMsU0FBUyxHQUFHLENBQUMsTUFBTSxFQUFFLE1BQU0sS0FBSyxPQUFPLENBQUMsTUFBTSxDQUFDLEdBQUcsTUFBTTtBQUNwRSxXQUFXLENBQUMsbUJBQW1CLEdBQUcsU0FBUyxlQUFlLENBQUMsR0FBRyxFQUFFLFlBQVksRUFBRTtBQUM5RSxFQUFFLElBQUksQ0FBQyxZQUFZLEVBQUUsT0FBTyxHQUFHO0FBQy9CLEVBQUUsSUFBSSxZQUFZLEtBQUssR0FBRyxFQUFFLE9BQU8sWUFBWSxDQUFDO0FBQ2hELEVBQUUsSUFBSSxPQUFPLENBQUMsWUFBWSxDQUFDLEVBQUUsT0FBTyxPQUFPLENBQUMsWUFBWSxDQUFDO0FBQ3pEO0FBQ0EsRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsa0JBQWtCLEVBQUUsR0FBRyxDQUFDLGNBQWMsRUFBRSxZQUFZLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDeEUsRUFBRSxPQUFPLGNBQWMsQ0FBQztBQUN4QixDQUFDOzs7QUFHRDtBQUNBLFdBQVcsQ0FBQyxPQUFPLENBQUMsUUFBUSxHQUFHLE9BQU8sY0FBYyxFQUFFLEdBQUcsS0FBSztBQUM5RCxFQUFFLE1BQU0sVUFBVSxHQUFHLFdBQVcsQ0FBQyxXQUFXLENBQUMsY0FBYyxDQUFDO0FBQzVEO0FBQ0EsRUFBRSxJQUFJLGNBQWMsS0FBSyxlQUFlLEVBQUUsTUFBTSxVQUFVLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQztBQUM1RSxFQUFFLElBQUksY0FBYyxLQUFLLGFBQWEsRUFBRSxNQUFNLFVBQVUsQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDO0FBQzFFO0FBQ0EsRUFBRSxNQUFNLElBQUksR0FBRyxNQUFNLFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQ3hDO0FBQ0EsRUFBRSxPQUFPLFVBQVUsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDO0FBQ3RDO0FBQ0EsTUFBTSxpQkFBaUIsR0FBRyw2Q0FBNkMsQ0FBQztBQUN4RSxXQUFXLENBQUMsT0FBTyxDQUFDLEtBQUssR0FBRyxPQUFPLGNBQWMsRUFBRSxHQUFHLEVBQUUsU0FBUyxLQUFLO0FBQ3RFO0FBQ0E7QUFDQTtBQUNBLEVBQUUsTUFBTSxNQUFNLEdBQUcsV0FBVyxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUM7QUFDcEQsRUFBRSxNQUFNLFlBQVksR0FBRyxNQUFNLEVBQUUsR0FBRyxLQUFLLGlCQUFpQjs7QUFFeEQsRUFBRSxNQUFNLFVBQVUsR0FBRyxXQUFXLENBQUMsV0FBVyxDQUFDLGNBQWMsQ0FBQztBQUM1RCxFQUFFLFNBQVMsR0FBRyxVQUFVLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQztBQUNoRCxFQUFFLE1BQU0sTUFBTSxHQUFHLE9BQU8sWUFBWSxHQUFHLFVBQVUsQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLFNBQVMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLFNBQVMsQ0FBQyxDQUFDO0FBQzFHLEVBQUUsSUFBSSxNQUFNLEtBQUssR0FBRyxFQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsQ0FBQywyQkFBMkIsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0UsRUFBRSxJQUFJLEdBQUcsRUFBRSxNQUFNLFVBQVUsQ0FBQyxJQUFJLENBQUMsWUFBWSxHQUFHLFFBQVEsRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLFNBQVMsQ0FBQztBQUNoRixFQUFFLE9BQU8sR0FBRztBQUNaLENBQUM7QUFDRCxXQUFXLENBQUMsT0FBTyxDQUFDLE9BQU8sR0FBRyxZQUFZO0FBQzFDLEVBQUUsTUFBTSxXQUFXLENBQUMsS0FBSyxFQUFFLENBQUM7QUFDNUIsRUFBRSxNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sVUFBVSxJQUFJO0FBQ25GLElBQUksTUFBTSxVQUFVLENBQUMsVUFBVSxFQUFFO0FBQ2pDLElBQUksTUFBTSxLQUFLLEdBQUcsTUFBTSxVQUFVLENBQUMsZ0JBQWdCO0FBQ25ELElBQUksS0FBSyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQ3BCLEdBQUcsQ0FBQyxDQUFDO0FBQ0wsRUFBRSxNQUFNLFdBQVcsQ0FBQyxjQUFjLEVBQUUsQ0FBQztBQUNyQyxDQUFDO0FBQ0QsV0FBVyxDQUFDLFdBQVcsR0FBRyxFQUFFO0FBRTVCLENBQUMsZUFBZSxFQUFFLGFBQWEsRUFBRSxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxJQUFJLFdBQVcsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLEdBQUcsSUFBSSxpQkFBaUIsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7O0FDdDRCdkgsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBRzFELFlBQWUsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLG1CQUFtQixFQUFFLGlCQUFpQixFQUFFLG1CQUFtQixFQUFFLGlCQUFpQixFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRSxJQUFJLEVBQUUsT0FBTyxHQUFHLFdBQVcsRUFBRSxjQUFjLEVBQUU7Ozs7IiwieF9nb29nbGVfaWdub3JlTGlzdCI6WzBdfQ==
