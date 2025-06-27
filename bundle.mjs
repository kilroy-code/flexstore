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
      // I sometimes encounter a bug in Safari in which ONE of the channels created soon after connection gets stuck in
      // the connecting readyState and never opens. Experimentally, this seems to be robust.
      //
      // Note to self: If it should turn out that we still have problems, try serializing the calls to peer.createDataChannel
      // so that there isn't more than one channel opening at a time.
      await new Promise(resolve => setTimeout(resolve, 100));
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
var version$1 = "0.0.47";
var _package = {
	name: name$1,
	version: version$1};

// name/version of "database"
const storageName = 'flexstore';
const storageVersion = 8;
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
	       channelName, uuid = collection?.uuid, rtcConfiguration, connection, // Complex default behavior for these. See code.
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
    connection ??= SharedWebRTC.ensure({serviceLabel, configuration: rtcConfiguration, multiplex, uuid, debug, error});

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
    if (!signalMessages) return false;
    this.connection.signals = signalMessages;
    return true;
  }

  static fetchJSON(url, body = undefined, method = null) {
    const hasBody = body !== undefined;
    method ??= hasBody ? 'POST' : 'GET';
    return fetch(url, hasBody ? {method, headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : {method})
      .then(response => {
	if (!response.ok) throw new Error(`${response.statusText || 'Fetch failed'}, code ${response.status} in ${url}.`);
	return response.json();
      });
  }
  async fetch(url, body = undefined) { // As JSON

    if (this.debug) this.log('fetch signals', url, JSON.stringify(body, null, 2)); // TODO: stringify in log instead of needing to guard with this.debug.
    const result = this.constructor.fetchJSON(url, body)
	  .catch(error => {
	    this.closed.reject(error);
	  });
    if (!result) return null;
    if (this.debug) this.log('fetch responseSignals', url, JSON.stringify(result, null, 2));
    return result;
  }
  async connectServer(url = this.connectionURL) { // Connect to a relay over http. Compare connectRendevous
    // startConnection, post it, completeConnection with the response.
    // Our webrtc synchronizer is then connected to the relay's webrt synchronizer.
    const ourSignalsPromise = this.startConnection(); // must be synchronous to preserve channel id order.
    const ourSignals = await ourSignalsPromise;
    const theirSignals = await this.fetch(url, ourSignals);
    return this.completeConnection(theirSignals);
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
    let resolver, rejecter;
    const promise = new Promise((resolve, reject) => { resolver = resolve; rejecter = reject; });
    promise.resolve = resolver;
    promise.reject = rejecter;
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
      const message = `This software expects data versions from ${minVersion} to ${maxVersion}.`;
      if (typeof(window) === 'undefined') {
	console.error(message);
      } else if (this.constructor.reportedVersionFail) {
	console.log('repeat version fail');
      } else { // If we're in a browser, kill everything.
	this.constructor.reportedVersionFail = true;
	console.log({version, minVersion, maxVersion, caches: await window.caches.keys(), registrations: await navigator.serviceWorker.getRegistrations(), dbs: await window.indexedDB.databases(), local: window.localStorage.length});
	for (let name of await window.caches.keys()) { console.log(name); await window.caches.delete(name); }
	for (let registration of await navigator.serviceWorker.getRegistrations()) {console.log('kill', registration); await registration.unregister(); }
	// For now, get rid of stuff we used to use.
	for (let db of await window.indexedDB.databases()) { console.log('kill', db.name); await window.indexedDB.deleteDatabase(db.name); }
	window.localStorage.clear();
	console.log('now', {caches: await window.caches.keys(), registrations: await navigator.serviceWorker.getRegistrations(), dbs: await window.indexedDB.databases(), local: window.localStorage.length});
	window.alert(message + ' Try reloading twice.');
	window.location.reload();
      }
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
var index = { Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection, VersionCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version,  storageName, storageVersion, StorageLocal: StorageCache, uuid4 };

export { Collection, ImmutableCollection, MutableCollection, PromiseWebRTC, SharedWebRTC, StorageCache as StorageLocal, Synchronizer, VersionCollection, VersionedCollection, WebRTC, index as default, name, storageName, storageVersion, uuid4, version };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsibm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0BraTFyMHkvc3RvcmFnZS9idW5kbGUubWpzIiwibGliL2NvbGxlY3Rpb25zLm1qcyIsImluZGV4Lm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB1dWlkUGF0dGVybiA9IC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tNFswLTlhLWZdezN9LVs4OWFiXVswLTlhLWZdezN9LVswLTlhLWZdezEyfSQvaTtcbmZ1bmN0aW9uIHZhbGlkKHV1aWQpIHtcbiAgcmV0dXJuIHV1aWRQYXR0ZXJuLnRlc3QodXVpZCk7XG59XG5cbi8vIEJhc2VkIG9uIGh0dHBzOi8vYWJoaXNoZWtkdXR0YS5vcmcvYmxvZy9zdGFuZGFsb25lX3V1aWRfZ2VuZXJhdG9yX2luX2phdmFzY3JpcHQuaHRtbFxuLy8gSUUxMSBhbmQgTW9kZXJuIEJyb3dzZXJzIE9ubHlcbmZ1bmN0aW9uIHV1aWQ0KCkge1xuICB2YXIgdGVtcF91cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKCkpO1xuICB2YXIgdXVpZCA9IHRlbXBfdXJsLnRvU3RyaW5nKCk7XG4gIFVSTC5yZXZva2VPYmplY3RVUkwodGVtcF91cmwpO1xuICByZXR1cm4gdXVpZC5zcGxpdCgvWzpcXC9dL2cpLnBvcCgpLnRvTG93ZXJDYXNlKCk7IC8vIHJlbW92ZSBwcmVmaXhlc1xufVxudXVpZDQudmFsaWQgPSB2YWxpZDtcblxuZXhwb3J0IGRlZmF1bHQgdXVpZDQ7XG5leHBvcnQgeyB1dWlkNCwgdmFsaWQgfTtcbiIsIi8vIEluIGEgYnJvd3Nlciwgd3J0YyBwcm9wZXJ0aWVzIHN1Y2ggYXMgUlRDUGVlckNvbm5lY3Rpb24gYXJlIGluIGdsb2JhbFRoaXMuXG5leHBvcnQgZGVmYXVsdCBnbG9iYWxUaGlzO1xuIiwiaW1wb3J0IHV1aWQ0IGZyb20gJ3V1aWQ0JztcblxuLy8gU2VlIHJvbGx1cC5jb25maWcubWpzXG5pbXBvcnQgd3J0YyBmcm9tICcjd3J0Yyc7XG4vL2NvbnN0IHtkZWZhdWx0OndydGN9ID0gYXdhaXQgKCh0eXBlb2YocHJvY2VzcykgIT09ICd1bmRlZmluZWQnKSA/IGltcG9ydCgnQHJvYW1ocS93cnRjJykgOiB7ZGVmYXVsdDogZ2xvYmFsVGhpc30pO1xuXG5jb25zdCBpY2VTZXJ2ZXJzID0gW1xuICB7IHVybHM6ICdzdHVuOnN0dW4ubC5nb29nbGUuY29tOjE5MzAyJ30sXG4gIC8vIGh0dHBzOi8vZnJlZXN0dW4ubmV0LyAgQ3VycmVudGx5IDUwIEtCaXQvcy4gKDIuNSBNQml0L3MgZm9ycyAkOS9tb250aClcbiAgeyB1cmxzOiAnc3R1bjpmcmVlc3R1bi5uZXQ6MzQ3OCcgfSxcbiAgLy97IHVybHM6ICd0dXJuOmZyZWVzdHVuLm5ldDozNDc4JywgdXNlcm5hbWU6ICdmcmVlJywgY3JlZGVudGlhbDogJ2ZyZWUnIH0sXG4gIC8vIFByZXN1bWFibHkgdHJhZmZpYyBsaW1pdGVkLiBDYW4gZ2VuZXJhdGUgbmV3IGNyZWRlbnRpYWxzIGF0IGh0dHBzOi8vc3BlZWQuY2xvdWRmbGFyZS5jb20vdHVybi1jcmVkc1xuICAvLyBBbHNvIGh0dHBzOi8vZGV2ZWxvcGVycy5jbG91ZGZsYXJlLmNvbS9jYWxscy8gMSBUQi9tb250aCwgYW5kICQwLjA1IC9HQiBhZnRlciB0aGF0LlxuICB7IHVybHM6ICd0dXJuOnR1cm4uc3BlZWQuY2xvdWRmbGFyZS5jb206NTAwMDAnLCB1c2VybmFtZTogJzgyNjIyNjI0NGNkNmU1ZWRiM2Y1NTc0OWI3OTYyMzVmNDIwZmU1ZWU3ODg5NWUwZGQ3ZDJiYWE0NWUxZjdhOGY0OWU5MjM5ZTc4NjkxYWIzOGI3MmNlMDE2NDcxZjc3NDZmNTI3N2RjZWY4NGFkNzlmYzYwZjgwMjBiMTMyYzczJywgY3JlZGVudGlhbDogJ2FiYTliMTY5NTQ2ZWI2ZGNjN2JmYjFjZGYzNDU0NGNmOTViNTE2MWQ2MDJlM2I1ZmE3YzgzNDJiMmU5ODAyZmInIH1cbiAgLy8gaHR0cHM6Ly9mYXN0dHVybi5uZXQvIEN1cnJlbnRseSA1MDBNQi9tb250aD8gKDI1IEdCL21vbnRoIGZvciAkOS9tb250aClcbiAgLy8gaHR0cHM6Ly94aXJzeXMuY29tL3ByaWNpbmcvIDUwMCBNQi9tb250aCAoNTAgR0IvbW9udGggZm9yICQzMy9tb250aClcbiAgLy8gQWxzbyBodHRwczovL3d3dy5ucG1qcy5jb20vcGFja2FnZS9ub2RlLXR1cm4gb3IgaHR0cHM6Ly9tZWV0cml4LmlvL2Jsb2cvd2VicnRjL2NvdHVybi9pbnN0YWxsYXRpb24uaHRtbFxuXTtcblxuLy8gVXRpbGl0eSB3cmFwcGVyIGFyb3VuZCBSVENQZWVyQ29ubmVjdGlvbi5cbi8vIFdoZW4gc29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIChzdWNoIGFzIGNyZWF0ZURhdGFDaGFubmVsKSwgaXQgd2lsbCBnZW5lcmF0ZSBjYWxscyB0byBzaWduYWwoKSwgd2hpY2ggbmVlZHMgdG8gYmUgZGVmaW5lZCBieSBzdWJjbGFzc2VzLlxuZXhwb3J0IGNsYXNzIFdlYlJUQyB7XG4gIGNvbnN0cnVjdG9yKHtsYWJlbCA9ICcnLCBjb25maWd1cmF0aW9uID0gbnVsbCwgdXVpZCA9IHV1aWQ0KCksIGRlYnVnID0gZmFsc2UsIGVycm9yID0gY29uc29sZS5lcnJvciwgLi4ucmVzdH0gPSB7fSkge1xuICAgIGNvbmZpZ3VyYXRpb24gPz89IHtpY2VTZXJ2ZXJzfTsgLy8gSWYgY29uZmlndXJhdGlvbiBjYW4gYmUgb21taXR0ZWQgb3IgZXhwbGljaXRseSBhcyBudWxsLCB1c2Ugb3VyIGRlZmF1bHQuIEJ1dCBpZiB7fSwgbGVhdmUgaXQgYmUuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7bGFiZWwsIGNvbmZpZ3VyYXRpb24sIHV1aWQsIGRlYnVnLCBlcnJvciwgLi4ucmVzdH0pO1xuICAgIHRoaXMucmVzZXRQZWVyKCk7XG4gIH1cbiAgc2lnbmFsKHR5cGUsIG1lc3NhZ2UpIHsgLy8gU3ViY2xhc3NlcyBtdXN0IG92ZXJyaWRlIG9yIGV4dGVuZC4gRGVmYXVsdCBqdXN0IGxvZ3MuXG4gICAgdGhpcy5sb2coJ3NlbmRpbmcnLCB0eXBlLCB0eXBlLmxlbmd0aCwgSlNPTi5zdHJpbmdpZnkobWVzc2FnZSkubGVuZ3RoKTtcbiAgfVxuXG4gIHBlZXJWZXJzaW9uID0gMDtcbiAgcmVzZXRQZWVyKCkgeyAvLyBTZXQgdXAgYSBuZXcgUlRDUGVlckNvbm5lY3Rpb24uIChDYWxsZXIgbXVzdCBjbG9zZSBvbGQgaWYgbmVjZXNzYXJ5LilcbiAgICBjb25zdCBvbGQgPSB0aGlzLnBlZXI7XG4gICAgaWYgKG9sZCkge1xuICAgICAgb2xkLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBvbGQub25pY2VjYW5kaWRhdGUgPSBvbGQub25pY2VjYW5kaWRhdGVlcnJvciA9IG9sZC5vbmNvbm5lY3Rpb25zdGF0ZWNoYW5nZSA9IG51bGw7XG4gICAgICAvLyBEb24ndCBjbG9zZSB1bmxlc3MgaXQncyBiZWVuIG9wZW5lZCwgYmVjYXVzZSB0aGVyZSBhcmUgbGlrZWx5IGhhbmRsZXJzIHRoYXQgd2UgZG9uJ3Qgd2FudCB0byBmaXJlLlxuICAgICAgaWYgKG9sZC5jb25uZWN0aW9uU3RhdGUgIT09ICduZXcnKSBvbGQuY2xvc2UoKTtcbiAgICB9XG4gICAgY29uc3QgcGVlciA9IHRoaXMucGVlciA9IG5ldyB3cnRjLlJUQ1BlZXJDb25uZWN0aW9uKHRoaXMuY29uZmlndXJhdGlvbik7XG4gICAgcGVlci52ZXJzaW9uSWQgPSB0aGlzLnBlZXJWZXJzaW9uKys7XG4gICAgcGVlci5vbm5lZ290aWF0aW9ubmVlZGVkID0gZXZlbnQgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZChldmVudCk7XG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZSA9IGV2ZW50ID0+IHRoaXMub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gICAgLy8gSSBkb24ndCB0aGluayBhbnlvbmUgYWN0dWFsbHkgc2lnbmFscyB0aGlzLiBJbnN0ZWFkLCB0aGV5IHJlamVjdCBmcm9tIGFkZEljZUNhbmRpZGF0ZSwgd2hpY2ggd2UgaGFuZGxlIHRoZSBzYW1lLlxuICAgIHBlZXIub25pY2VjYW5kaWRhdGVlcnJvciA9IGVycm9yID0+IHRoaXMuaWNlY2FuZGlkYXRlRXJyb3IoZXJyb3IpO1xuICAgIC8vIEkgdGhpbmsgdGhpcyBpcyByZWR1bmRuYW50IGJlY2F1c2Ugbm8gaW1wbGVtZW50YXRpb24gZmlyZXMgdGhpcyBldmVudCBhbnkgc2lnbmlmaWNhbnQgdGltZSBhaGVhZCBvZiBlbWl0dGluZyBpY2VjYW5kaWRhdGUgd2l0aCBhbiBlbXB0eSBldmVudC5jYW5kaWRhdGUuXG4gICAgcGVlci5vbmljZWdhdGhlcmluZ3N0YXRlY2hhbmdlID0gZXZlbnQgPT4gKHBlZXIuaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScpICYmIHRoaXMub25Mb2NhbEVuZEljZTtcbiAgICBwZWVyLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gZXZlbnQgPT4gdGhpcy5jb25uZWN0aW9uU3RhdGVDaGFuZ2UodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIFRoZSBzcGVjIHNheXMgdGhhdCBhIG51bGwgY2FuZGlkYXRlIHNob3VsZCBub3QgYmUgc2VudCwgYnV0IHRoYXQgYW4gZW1wdHkgc3RyaW5nIGNhbmRpZGF0ZSBzaG91bGQuIFNhZmFyaSAodXNlZCB0bz8pIGdldCBlcnJvcnMgZWl0aGVyIHdheS5cbiAgICBpZiAoIWV2ZW50LmNhbmRpZGF0ZSB8fCAhZXZlbnQuY2FuZGlkYXRlLmNhbmRpZGF0ZSkgdGhpcy5vbkxvY2FsRW5kSWNlKCk7XG4gICAgZWxzZSB0aGlzLnNpZ25hbCgnaWNlY2FuZGlkYXRlJywgZXZlbnQuY2FuZGlkYXRlKTtcbiAgfVxuICBvbkxvY2FsRW5kSWNlKCkgeyAvLyBUcmlnZ2VyZWQgb24gb3VyIHNpZGUgYnkgYW55L2FsbCBvZiBvbmljZWNhbmRpZGF0ZSB3aXRoIG5vIGV2ZW50LmNhbmRpZGF0ZSwgaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScuXG4gICAgLy8gSS5lLiwgY2FuIGhhcHBlbiBtdWx0aXBsZSB0aW1lcy4gU3ViY2xhc3NlcyBtaWdodCBkbyBzb21ldGhpbmcuXG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKCh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnbmV3JykgJiYgKHRoaXMucGVlci5zaWduYWxpbmdTdGF0ZSA9PT0gJ3N0YWJsZScpKSByZXR1cm47XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBjb25uZWN0aW9uU3RhdGVDaGFuZ2Uoc3RhdGUpIHtcbiAgICB0aGlzLmxvZygnc3RhdGUgY2hhbmdlOicsIHN0YXRlKTtcbiAgICBpZiAoWydkaXNjb25uZWN0ZWQnLCAnZmFpbGVkJywgJ2Nsb3NlZCddLmluY2x1ZGVzKHN0YXRlKSkgdGhpcy5jbG9zZSgpOyAvLyBPdGhlciBiZWhhdmlvciBhcmUgcmVhc29uYWJsZSwgdG9sby5cbiAgfVxuICBuZWdvdGlhdGlvbm5lZWRlZCgpIHsgLy8gU29tZXRoaW5nIGhhcyBjaGFuZ2VkIGxvY2FsbHkgKG5ldyBzdHJlYW0sIG9yIG5ldHdvcmsgY2hhbmdlKSwgc3VjaCB0aGF0IHdlIGhhdmUgdG8gc3RhcnQgbmVnb3RpYXRpb24uXG4gICAgdGhpcy5sb2coJ25lZ290aWF0aW9ubm5lZWRlZCcpO1xuICAgIHRoaXMucGVlci5jcmVhdGVPZmZlcigpXG4gICAgICAudGhlbihvZmZlciA9PiB7XG4gICAgICAgIHRoaXMucGVlci5zZXRMb2NhbERlc2NyaXB0aW9uKG9mZmVyKTsgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIG9mZmVyXG5cdHJldHVybiBvZmZlcjtcbiAgICAgIH0pXG4gICAgICAudGhlbihvZmZlciA9PiB0aGlzLnNpZ25hbCgnb2ZmZXInLCBvZmZlcikpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZEVycm9yKGVycm9yKSk7XG4gIH1cbiAgb2ZmZXIob2ZmZXIpIHsgLy8gSGFuZGxlciBmb3IgcmVjZWl2aW5nIGFuIG9mZmVyIGZyb20gdGhlIG90aGVyIHVzZXIgKHdobyBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2VzcykuXG4gICAgLy8gTm90ZSB0aGF0IGR1cmluZyBzaWduYWxpbmcsIHdlIHdpbGwgcmVjZWl2ZSBuZWdvdGlhdGlvbm5lZWRlZC9hbnN3ZXIsIG9yIG9mZmVyLCBidXQgbm90IGJvdGgsIGRlcGVuZGluZ1xuICAgIC8vIG9uIHdoZXRoZXIgd2Ugd2VyZSB0aGUgb25lIHRoYXQgc3RhcnRlZCB0aGUgc2lnbmFsaW5nIHByb2Nlc3MuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKG9mZmVyKVxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnBlZXIuY3JlYXRlQW5zd2VyKCkpXG4gICAgICAudGhlbihhbnN3ZXIgPT4gdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyKSkgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIGFuc3dlclxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnNpZ25hbCgnYW5zd2VyJywgdGhpcy5wZWVyLmxvY2FsRGVzY3JpcHRpb24pKTtcbiAgfVxuICBhbnN3ZXIoYW5zd2VyKSB7IC8vIEhhbmRsZXIgZm9yIGZpbmlzaGluZyB0aGUgc2lnbmFsaW5nIHByb2Nlc3MgdGhhdCB3ZSBzdGFydGVkLlxuICAgIHRoaXMucGVlci5zZXRSZW1vdGVEZXNjcmlwdGlvbihhbnN3ZXIpO1xuICB9XG4gIGljZWNhbmRpZGF0ZShpY2VDYW5kaWRhdGUpIHsgLy8gSGFuZGxlciBmb3IgYSBuZXcgY2FuZGlkYXRlIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZCB0aHJvdWdoIHNpZ25hbGluZy5cbiAgICB0aGlzLnBlZXIuYWRkSWNlQ2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkuY2F0Y2goZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcikpO1xuICB9XG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnJlc3QpO1xuICB9XG4gIGxvZ0Vycm9yKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgY29uc3QgZGF0YSA9IFt0aGlzLmxhYmVsLCB0aGlzLnBlZXIudmVyc2lvbklkLCAuLi50aGlzLmNvbnN0cnVjdG9yLmdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbildO1xuICAgIHRoaXMuZXJyb3IoZGF0YSk7XG4gICAgcmV0dXJuIGRhdGE7XG4gIH1cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7XG4gIH1cbiAgc3RhdGljIGdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbikge1xuICAgIHJldHVybiBbXG4gICAgICBsYWJlbCArIFwiIGVycm9yOlwiLFxuICAgICAgZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzIHx8IFwiXCIsIC8vIEZpcnN0IGlzIGRlcHJlY2F0ZWQsIGJ1dCBzdGlsbCB1c2VmdWwuXG4gICAgICBldmVudE9yRXhjZXB0aW9uLnVybCB8fCBldmVudE9yRXhjZXB0aW9uLm5hbWUgfHwgJycsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLm1lc3NhZ2UgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvclRleHQgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXNUZXh0IHx8IGV2ZW50T3JFeGNlcHRpb25cbiAgICBdO1xuICB9XG4gIGljZWNhbmRpZGF0ZUVycm9yKGV2ZW50T3JFeGNlcHRpb24pIHsgLy8gRm9yIGVycm9ycyBvbiB0aGlzIHBlZXIgZHVyaW5nIGdhdGhlcmluZy5cbiAgICAvLyBDYW4gYmUgb3ZlcnJpZGRlbiBvciBleHRlbmRlZCBieSBhcHBsaWNhdGlvbnMuXG5cbiAgICAvLyBTVFVOIGVycm9ycyBhcmUgaW4gdGhlIHJhbmdlIDMwMC02OTkuIFNlZSBSRkMgNTM4OSwgc2VjdGlvbiAxNS42XG4gICAgLy8gZm9yIGEgbGlzdCBvZiBjb2Rlcy4gVFVSTiBhZGRzIGEgZmV3IG1vcmUgZXJyb3IgY29kZXM7IHNlZVxuICAgIC8vIFJGQyA1NzY2LCBzZWN0aW9uIDE1IGZvciBkZXRhaWxzLlxuICAgIC8vIFNlcnZlciBjb3VsZCBub3QgYmUgcmVhY2hlZCBhcmUgaW4gdGhlIHJhbmdlIDcwMC03OTkuXG4gICAgY29uc3QgY29kZSA9IGV2ZW50T3JFeGNlcHRpb24uY29kZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yQ29kZSB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1cztcbiAgICAvLyBDaHJvbWUgZ2l2ZXMgNzAxIGVycm9ycyBmb3Igc29tZSB0dXJuIHNlcnZlcnMgdGhhdCBpdCBkb2VzIG5vdCBnaXZlIGZvciBvdGhlciB0dXJuIHNlcnZlcnMuXG4gICAgLy8gVGhpcyBpc24ndCBnb29kLCBidXQgaXQncyB3YXkgdG9vIG5vaXN5IHRvIHNsb2cgdGhyb3VnaCBzdWNoIGVycm9ycywgYW5kIEkgZG9uJ3Qga25vdyBob3cgdG8gZml4IG91ciB0dXJuIGNvbmZpZ3VyYXRpb24uXG4gICAgaWYgKGNvZGUgPT09IDcwMSkgcmV0dXJuO1xuICAgIHRoaXMubG9nRXJyb3IoJ2ljZScsIGV2ZW50T3JFeGNlcHRpb24pO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBQcm9taXNlV2ViUlRDIGV4dGVuZHMgV2ViUlRDIHtcbiAgLy8gRXh0ZW5kcyBXZWJSVEMuc2lnbmFsKCkgc3VjaCB0aGF0OlxuICAvLyAtIGluc3RhbmNlLnNpZ25hbHMgYW5zd2VycyBhIHByb21pc2UgdGhhdCB3aWxsIHJlc29sdmUgd2l0aCBhbiBhcnJheSBvZiBzaWduYWwgbWVzc2FnZXMuXG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyA9IFsuLi5zaWduYWxNZXNzYWdlc10gd2lsbCBkaXNwYXRjaCB0aG9zZSBtZXNzYWdlcy5cbiAgLy9cbiAgLy8gRm9yIGV4YW1wbGUsIHN1cHBvc2UgcGVlcjEgYW5kIHBlZXIyIGFyZSBpbnN0YW5jZXMgb2YgdGhpcy5cbiAgLy8gMC4gU29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIG9uIHBlZXIxIChzdWNoIGFzIGNhbGxpbmcgcGVlcjEuY3JlYXRlRGF0YUNoYW5uZWwoKSkuIFxuICAvLyAxLiBwZWVyMS5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDE+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjIuXG4gIC8vIDIuIFNldCBwZWVyMi5zaWduYWxzID0gPHNpZ25hbDE+LlxuICAvLyAzLiBwZWVyMi5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDI+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjEuXG4gIC8vIDQuIFNldCBwZWVyMS5zaWduYWxzID0gPHNpZ25hbDI+LlxuICAvLyA1LiBEYXRhIGZsb3dzLCBidXQgZWFjaCBzaWRlIHdob3VsZCBncmFiIGEgbmV3IHNpZ25hbHMgcHJvbWlzZSBhbmQgYmUgcHJlcGFyZWQgdG8gYWN0IGlmIGl0IHJlc29sdmVzLlxuICAvL1xuICBjb25zdHJ1Y3Rvcih7aWNlVGltZW91dCA9IDJlMywgLi4ucHJvcGVydGllc30pIHtcbiAgICBzdXBlcihwcm9wZXJ0aWVzKTtcbiAgICB0aGlzLmljZVRpbWVvdXQgPSBpY2VUaW1lb3V0O1xuICB9XG4gIGdldCBzaWduYWxzKCkgeyAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmUgdG8gdGhlIHNpZ25hbCBtZXNzYWdpbmcgd2hlbiBpY2UgY2FuZGlkYXRlIGdhdGhlcmluZyBpcyBjb21wbGV0ZS5cbiAgICByZXR1cm4gdGhpcy5fc2lnbmFsUHJvbWlzZSB8fD0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gdGhpcy5fc2lnbmFsUmVhZHkgPSB7cmVzb2x2ZSwgcmVqZWN0fSk7XG4gIH1cbiAgc2V0IHNpZ25hbHMoZGF0YSkgeyAvLyBTZXQgd2l0aCB0aGUgc2lnbmFscyByZWNlaXZlZCBmcm9tIHRoZSBvdGhlciBlbmQuXG4gICAgZGF0YS5mb3JFYWNoKChbdHlwZSwgbWVzc2FnZV0pID0+IHRoaXNbdHlwZV0obWVzc2FnZSkpO1xuICB9XG4gIG9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpIHtcbiAgICAvLyBFYWNoIHdydGMgaW1wbGVtZW50YXRpb24gaGFzIGl0cyBvd24gaWRlYXMgYXMgdG8gd2hhdCBpY2UgY2FuZGlkYXRlcyB0byB0cnkgYmVmb3JlIGVtaXR0aW5nIHRoZW0gaW4gaWNlY2FuZGRpYXRlLlxuICAgIC8vIE1vc3Qgd2lsbCB0cnkgdGhpbmdzIHRoYXQgY2Fubm90IGJlIHJlYWNoZWQsIGFuZCBnaXZlIHVwIHdoZW4gdGhleSBoaXQgdGhlIE9TIG5ldHdvcmsgdGltZW91dC4gRm9ydHkgc2Vjb25kcyBpcyBhIGxvbmcgdGltZSB0byB3YWl0LlxuICAgIC8vIElmIHRoZSB3cnRjIGlzIHN0aWxsIHdhaXRpbmcgYWZ0ZXIgb3VyIGljZVRpbWVvdXQgKDIgc2Vjb25kcyksIGxldHMganVzdCBnbyB3aXRoIHdoYXQgd2UgaGF2ZS5cbiAgICB0aGlzLnRpbWVyIHx8PSBzZXRUaW1lb3V0KCgpID0+IHRoaXMub25Mb2NhbEVuZEljZSgpLCB0aGlzLmljZVRpbWVvdXQpO1xuICAgIHN1cGVyLm9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpO1xuICB9XG4gIGNsZWFySWNlVGltZXIoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpO1xuICAgIHRoaXMudGltZXIgPSBudWxsO1xuICB9XG4gIGFzeW5jIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFJlc29sdmUgdGhlIHByb21pc2Ugd2l0aCB3aGF0IHdlJ3ZlIGJlZW4gZ2F0aGVyaW5nLlxuICAgIHRoaXMuY2xlYXJJY2VUaW1lcigpO1xuICAgIGlmICghdGhpcy5fc2lnbmFsUHJvbWlzZSkge1xuICAgICAgLy90aGlzLmxvZ0Vycm9yKCdpY2UnLCBcIkVuZCBvZiBJQ0Ugd2l0aG91dCBhbnl0aGluZyB3YWl0aW5nIG9uIHNpZ25hbHMuXCIpOyAvLyBOb3QgaGVscGZ1bCB3aGVuIHRoZXJlIGFyZSB0aHJlZSB3YXlzIHRvIHJlY2VpdmUgdGhpcyBtZXNzYWdlLlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9zaWduYWxSZWFkeS5yZXNvbHZlKHRoaXMuc2VuZGluZyk7XG4gICAgdGhpcy5zZW5kaW5nID0gW107XG4gIH1cbiAgc2VuZGluZyA9IFtdO1xuICBzaWduYWwodHlwZSwgbWVzc2FnZSkge1xuICAgIHN1cGVyLnNpZ25hbCh0eXBlLCBtZXNzYWdlKTtcbiAgICB0aGlzLnNlbmRpbmcucHVzaChbdHlwZSwgbWVzc2FnZV0pO1xuICB9XG4gIC8vIFdlIG5lZWQgdG8ga25vdyBpZiB0aGVyZSBhcmUgb3BlbiBkYXRhIGNoYW5uZWxzLiBUaGVyZSBpcyBhIHByb3Bvc2FsIGFuZCBldmVuIGFuIGFjY2VwdGVkIFBSIGZvciBSVENQZWVyQ29ubmVjdGlvbi5nZXREYXRhQ2hhbm5lbHMoKSxcbiAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3czYy93ZWJydGMtZXh0ZW5zaW9ucy9pc3N1ZXMvMTEwXG4gIC8vIGJ1dCBpdCBoYXNuJ3QgYmVlbiBkZXBsb3llZCBldmVyeXdoZXJlIHlldC4gU28gd2UnbGwgbmVlZCB0byBrZWVwIG91ciBvd24gY291bnQuXG4gIC8vIEFsYXMsIGEgY291bnQgaXNuJ3QgZW5vdWdoLCBiZWNhdXNlIHdlIGNhbiBvcGVuIHN0dWZmLCBhbmQgdGhlIG90aGVyIHNpZGUgY2FuIG9wZW4gc3R1ZmYsIGJ1dCBpZiBpdCBoYXBwZW5zIHRvIGJlXG4gIC8vIHRoZSBzYW1lIFwibmVnb3RpYXRlZFwiIGlkLCBpdCBpc24ndCByZWFsbHkgYSBkaWZmZXJlbnQgY2hhbm5lbC4gKGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9SVENQZWVyQ29ubmVjdGlvbi9kYXRhY2hhbm5lbF9ldmVudFxuICBkYXRhQ2hhbm5lbHMgPSBuZXcgTWFwKCk7XG4gIHJlcG9ydENoYW5uZWxzKCkgeyAvLyBSZXR1cm4gYSByZXBvcnQgc3RyaW5nIHVzZWZ1bCBmb3IgZGVidWdnaW5nLlxuICAgIGNvbnN0IGVudHJpZXMgPSBBcnJheS5mcm9tKHRoaXMuZGF0YUNoYW5uZWxzLmVudHJpZXMoKSk7XG4gICAgY29uc3Qga3YgPSBlbnRyaWVzLm1hcCgoW2ssIHZdKSA9PiBgJHtrfToke3YuaWR9YCk7XG4gICAgcmV0dXJuIGAke3RoaXMuZGF0YUNoYW5uZWxzLnNpemV9LyR7a3Yuam9pbignLCAnKX1gO1xuICB9XG4gIG5vdGVDaGFubmVsKGNoYW5uZWwsIHNvdXJjZSwgd2FpdGluZykgeyAvLyBCb29ra2VlcCBvcGVuIGNoYW5uZWwgYW5kIHJldHVybiBpdC5cbiAgICAvLyBFbXBlcmljYWxseSwgd2l0aCBtdWx0aXBsZXggZmFsc2U6IC8vICAgMTggb2NjdXJyZW5jZXMsIHdpdGggaWQ9bnVsbHwwfDEgYXMgZm9yIGV2ZW50Y2hhbm5lbCBvciBjcmVhdGVEYXRhQ2hhbm5lbFxuICAgIC8vICAgQXBwYXJlbnRseSwgd2l0aG91dCBuZWdvdGlhdGlvbiwgaWQgaXMgaW5pdGlhbGx5IG51bGwgKHJlZ2FyZGxlc3Mgb2Ygb3B0aW9ucy5pZCksIGFuZCB0aGVuIGFzc2lnbmVkIHRvIGEgZnJlZSB2YWx1ZSBkdXJpbmcgb3BlbmluZ1xuICAgIGNvbnN0IGtleSA9IGNoYW5uZWwubGFiZWw7IC8vZml4bWUgY2hhbm5lbC5pZCA9PT0gbnVsbCA/IDEgOiBjaGFubmVsLmlkO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5kYXRhQ2hhbm5lbHMuZ2V0KGtleSk7XG4gICAgdGhpcy5sb2coJ2dvdCBkYXRhLWNoYW5uZWwnLCBzb3VyY2UsIGtleSwgJ2V4aXN0aW5nOicsIGV4aXN0aW5nLCAnd2FpdGluZzonLCB3YWl0aW5nKTtcbiAgICB0aGlzLmRhdGFDaGFubmVscy5zZXQoa2V5LCBjaGFubmVsKTtcbiAgICBjaGFubmVsLmFkZEV2ZW50TGlzdGVuZXIoJ2Nsb3NlJywgZXZlbnQgPT4geyAvLyBDbG9zZSB3aG9sZSBjb25uZWN0aW9uIHdoZW4gbm8gbW9yZSBkYXRhIGNoYW5uZWxzIG9yIHN0cmVhbXMuXG4gICAgICB0aGlzLmRhdGFDaGFubmVscy5kZWxldGUoa2V5KTtcbiAgICAgIC8vIElmIHRoZXJlJ3Mgbm90aGluZyBvcGVuLCBjbG9zZSB0aGUgY29ubmVjdGlvbi5cbiAgICAgIGlmICh0aGlzLmRhdGFDaGFubmVscy5zaXplKSByZXR1cm47XG4gICAgICBpZiAodGhpcy5wZWVyLmdldFNlbmRlcnMoKS5sZW5ndGgpIHJldHVybjtcbiAgICAgIHRoaXMuY2xvc2UoKTtcbiAgICB9KTtcbiAgICByZXR1cm4gY2hhbm5lbDtcbiAgfVxuICBjcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCA9IFwiZGF0YVwiLCBjaGFubmVsT3B0aW9ucyA9IHt9KSB7IC8vIFByb21pc2UgcmVzb2x2ZXMgd2hlbiB0aGUgY2hhbm5lbCBpcyBvcGVuICh3aGljaCB3aWxsIGJlIGFmdGVyIGFueSBuZWVkZWQgbmVnb3RpYXRpb24pLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdjcmVhdGUgZGF0YS1jaGFubmVsJywgbGFiZWwsIGNoYW5uZWxPcHRpb25zKTtcbiAgICAgIGxldCBjaGFubmVsID0gdGhpcy5wZWVyLmNyZWF0ZURhdGFDaGFubmVsKGxhYmVsLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgICB0aGlzLm5vdGVDaGFubmVsKGNoYW5uZWwsICdleHBsaWNpdCcpOyAvLyBOb3RlZCBldmVuIGJlZm9yZSBvcGVuZWQuXG4gICAgICAvLyBUaGUgY2hhbm5lbCBtYXkgaGF2ZSBhbHJlYWR5IGJlZW4gb3BlbmVkIG9uIHRoZSBvdGhlciBzaWRlLiBJbiB0aGlzIGNhc2UsIGFsbCBicm93c2VycyBmaXJlIHRoZSBvcGVuIGV2ZW50IGFueXdheSxcbiAgICAgIC8vIGJ1dCB3cnRjIChpLmUuLCBvbiBub2RlSlMpIGRvZXMgbm90LiBTbyB3ZSBoYXZlIHRvIGV4cGxpY2l0bHkgY2hlY2suXG4gICAgICBzd2l0Y2ggKGNoYW5uZWwucmVhZHlTdGF0ZSkge1xuICAgICAgY2FzZSAnb3Blbic6XG5cdHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShjaGFubmVsKSwgMTApO1xuXHRicmVhaztcbiAgICAgIGNhc2UgJ2Nvbm5lY3RpbmcnOlxuXHRjaGFubmVsLm9ub3BlbiA9IF8gPT4gcmVzb2x2ZShjaGFubmVsKTtcblx0YnJlYWs7XG4gICAgICBkZWZhdWx0OlxuXHR0aHJvdyBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgcmVhZHlTdGF0ZSAke2NoYW5uZWwucmVhZHlTdGF0ZX0gZm9yIGRhdGEgY2hhbm5lbCAke2xhYmVsfS5gKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICB3YWl0aW5nQ2hhbm5lbHMgPSB7fTtcbiAgZ2V0RGF0YUNoYW5uZWxQcm9taXNlKGxhYmVsID0gXCJkYXRhXCIpIHsgLy8gUmVzb2x2ZXMgdG8gYW4gb3BlbiBkYXRhIGNoYW5uZWwuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgdGhpcy5sb2coJ3Byb21pc2UgZGF0YS1jaGFubmVsJywgbGFiZWwpO1xuICAgICAgdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdID0gcmVzb2x2ZTtcbiAgICB9KTtcbiAgfVxuICByZXNldFBlZXIoKSB7IC8vIFJlc2V0IGEgJ2Nvbm5lY3RlZCcgcHJvcGVydHkgdGhhdCBwcm9taXNlZCB0byByZXNvbHZlIHdoZW4gb3BlbmVkLCBhbmQgdHJhY2sgaW5jb21pbmcgZGF0YWNoYW5uZWxzLlxuICAgIHN1cGVyLnJlc2V0UGVlcigpO1xuICAgIHRoaXMuY29ubmVjdGVkID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7IC8vIHRoaXMuY29ubmVjdGVkIGlzIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gd2UgYXJlLlxuICAgICAgdGhpcy5wZWVyLmFkZEV2ZW50TGlzdGVuZXIoJ2Nvbm5lY3Rpb25zdGF0ZWNoYW5nZScsIGV2ZW50ID0+IHtcblx0aWYgKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICdjb25uZWN0ZWQnKSB7XG5cdCAgcmVzb2x2ZSh0cnVlKTtcblx0fVxuICAgICAgfSk7XG4gICAgfSk7XG4gICAgdGhpcy5wZWVyLmFkZEV2ZW50TGlzdGVuZXIoJ2RhdGFjaGFubmVsJywgZXZlbnQgPT4geyAvLyBSZXNvbHZlIHByb21pc2UgbWFkZSB3aXRoIGdldERhdGFDaGFubmVsUHJvbWlzZSgpLlxuICAgICAgY29uc3QgY2hhbm5lbCA9IGV2ZW50LmNoYW5uZWw7XG4gICAgICBjb25zdCBsYWJlbCA9IGNoYW5uZWwubGFiZWw7XG4gICAgICBjb25zdCB3YWl0aW5nID0gdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdO1xuICAgICAgdGhpcy5ub3RlQ2hhbm5lbChjaGFubmVsLCAnZGF0YWNoYW5uZWwgZXZlbnQnLCB3YWl0aW5nKTsgLy8gUmVnYXJkbGVzcyBvZiB3aGV0aGVyIHdlIGFyZSB3YWl0aW5nLlxuICAgICAgaWYgKCF3YWl0aW5nKSByZXR1cm47IC8vIE1pZ2h0IG5vdCBiZSBleHBsaWNpdGx5IHdhaXRpbmcuIEUuZy4sIHJvdXRlcnMuXG4gICAgICBkZWxldGUgdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdO1xuICAgICAgd2FpdGluZyhjaGFubmVsKTtcbiAgICB9KTtcbiAgfVxuICBjbG9zZSgpIHtcbiAgICBpZiAodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2ZhaWxlZCcpIHRoaXMuX3NpZ25hbFByb21pc2U/LnJlamVjdD8uKCk7XG4gICAgc3VwZXIuY2xvc2UoKTtcbiAgICB0aGlzLmNsZWFySWNlVGltZXIoKTtcbiAgICB0aGlzLl9zaWduYWxQcm9taXNlID0gdGhpcy5fc2lnbmFsUmVhZHkgPSBudWxsO1xuICAgIHRoaXMuc2VuZGluZyA9IFtdO1xuICAgIC8vIElmIHRoZSB3ZWJydGMgaW1wbGVtZW50YXRpb24gY2xvc2VzIHRoZSBkYXRhIGNoYW5uZWxzIGJlZm9yZSB0aGUgcGVlciBpdHNlbGYsIHRoZW4gdGhpcy5kYXRhQ2hhbm5lbHMgd2lsbCBiZSBlbXB0eS5cbiAgICAvLyBCdXQgaWYgbm90IChlLmcuLCBzdGF0dXMgJ2ZhaWxlZCcgb3IgJ2Rpc2Nvbm5lY3RlZCcgb24gU2FmYXJpKSwgdGhlbiBsZXQgdXMgZXhwbGljaXRseSBjbG9zZSB0aGVtIHNvIHRoYXQgU3luY2hyb25pemVycyBrbm93IHRvIGNsZWFuIHVwLlxuICAgIGZvciAoY29uc3QgY2hhbm5lbCBvZiB0aGlzLmRhdGFDaGFubmVscy52YWx1ZXMoKSkge1xuICAgICAgaWYgKGNoYW5uZWwucmVhZHlTdGF0ZSAhPT0gJ29wZW4nKSBjb250aW51ZTsgLy8gS2VlcCBkZWJ1Z2dpbmcgc2FuaXR5LlxuICAgICAgLy8gSXQgYXBwZWFycyB0aGF0IGluIFNhZmFyaSAoMTguNSkgZm9yIGEgY2FsbCB0byBjaGFubmVsLmNsb3NlKCkgd2l0aCB0aGUgY29ubmVjdGlvbiBhbHJlYWR5IGludGVybmFsbCBjbG9zZWQsIFNhZmFyaVxuICAgICAgLy8gd2lsbCBzZXQgY2hhbm5lbC5yZWFkeVN0YXRlIHRvICdjbG9zaW5nJywgYnV0IE5PVCBmaXJlIHRoZSBjbG9zZWQgb3IgY2xvc2luZyBldmVudC4gU28gd2UgaGF2ZSB0byBkaXNwYXRjaCBpdCBvdXJzZWx2ZXMuXG4gICAgICAvL2NoYW5uZWwuY2xvc2UoKTtcbiAgICAgIGNoYW5uZWwuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2Nsb3NlJykpO1xuICAgIH1cbiAgfVxufVxuXG4vLyBOZWdvdGlhdGVkIGNoYW5uZWxzIHVzZSBzcGVjaWZpYyBpbnRlZ2VycyBvbiBib3RoIHNpZGVzLCBzdGFydGluZyB3aXRoIHRoaXMgbnVtYmVyLlxuLy8gV2UgZG8gbm90IHN0YXJ0IGF0IHplcm8gYmVjYXVzZSB0aGUgbm9uLW5lZ290aWF0ZWQgY2hhbm5lbHMgKGFzIHVzZWQgb24gc2VydmVyIHJlbGF5cykgZ2VuZXJhdGUgdGhlaXJcbi8vIG93biBpZHMgc3RhcnRpbmcgd2l0aCAwLCBhbmQgd2UgZG9uJ3Qgd2FudCB0byBjb25mbGljdC5cbi8vIFRoZSBzcGVjIHNheXMgdGhlc2UgY2FuIGdvIHRvIDY1LDUzNCwgYnV0IEkgZmluZCB0aGF0IHN0YXJ0aW5nIGdyZWF0ZXIgdGhhbiB0aGUgdmFsdWUgaGVyZSBnaXZlcyBlcnJvcnMuXG5jb25zdCBCQVNFX0NIQU5ORUxfSUQgPSAxMDAwO1xuZXhwb3J0IGNsYXNzIFNoYXJlZFdlYlJUQyBleHRlbmRzIFByb21pc2VXZWJSVEMge1xuICBzdGF0aWMgY29ubmVjdGlvbnMgPSBuZXcgTWFwKCk7XG4gIHN0YXRpYyBlbnN1cmUoe3NlcnZpY2VMYWJlbCwgbXVsdGlwbGV4ID0gdHJ1ZSwgLi4ucmVzdH0pIHtcbiAgICBsZXQgY29ubmVjdGlvbiA9IHRoaXMuY29ubmVjdGlvbnMuZ2V0KHNlcnZpY2VMYWJlbCk7XG4gICAgLy8gSXQgaXMgcG9zc2libGUgdGhhdCB3ZSB3ZXJlIGJhY2tncm91bmRlZCBiZWZvcmUgd2UgaGFkIGEgY2hhbmNlIHRvIGFjdCBvbiBhIGNsb3NpbmcgY29ubmVjdGlvbiBhbmQgcmVtb3ZlIGl0LlxuICAgIGlmIChjb25uZWN0aW9uKSB7XG4gICAgICBjb25zdCB7Y29ubmVjdGlvblN0YXRlLCBzaWduYWxpbmdTdGF0ZX0gPSBjb25uZWN0aW9uLnBlZXI7XG4gICAgICBpZiAoKGNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2Nsb3NlZCcpIHx8IChzaWduYWxpbmdTdGF0ZSA9PT0gJ2Nsb3NlZCcpKSBjb25uZWN0aW9uID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFjb25uZWN0aW9uKSB7XG4gICAgICBjb25uZWN0aW9uID0gbmV3IHRoaXMoe2xhYmVsOiBzZXJ2aWNlTGFiZWwsIHV1aWQ6IHV1aWQ0KCksIG11bHRpcGxleCwgLi4ucmVzdH0pO1xuICAgICAgaWYgKG11bHRpcGxleCkgdGhpcy5jb25uZWN0aW9ucy5zZXQoc2VydmljZUxhYmVsLCBjb25uZWN0aW9uKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvbm5lY3Rpb247XG4gIH1cbiAgY2hhbm5lbElkID0gQkFTRV9DSEFOTkVMX0lEO1xuICBnZXQgaGFzU3RhcnRlZENvbm5lY3RpbmcoKSB7XG4gICAgcmV0dXJuIHRoaXMuY2hhbm5lbElkID4gQkFTRV9DSEFOTkVMX0lEO1xuICB9XG4gIGNsb3NlKHJlbW92ZUNvbm5lY3Rpb24gPSB0cnVlKSB7XG4gICAgdGhpcy5jaGFubmVsSWQgPSBCQVNFX0NIQU5ORUxfSUQ7XG4gICAgc3VwZXIuY2xvc2UoKTtcbiAgICBpZiAocmVtb3ZlQ29ubmVjdGlvbikgdGhpcy5jb25zdHJ1Y3Rvci5jb25uZWN0aW9ucy5kZWxldGUodGhpcy5zZXJ2aWNlTGFiZWwpO1xuICB9XG4gIGFzeW5jIGVuc3VyZURhdGFDaGFubmVsKGNoYW5uZWxOYW1lLCBjaGFubmVsT3B0aW9ucyA9IHt9LCBzaWduYWxzID0gbnVsbCkgeyAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciBhbiBvcGVuIGRhdGEgY2hhbm5lbCBvbiB0aGlzIGNvbm5lY3Rpb24uXG4gICAgY29uc3QgaGFzU3RhcnRlZENvbm5lY3RpbmcgPSB0aGlzLmhhc1N0YXJ0ZWRDb25uZWN0aW5nOyAvLyBNdXN0IGFzayBiZWZvcmUgaW5jcmVtZW50aW5nIGlkLlxuICAgIGNvbnN0IGlkID0gdGhpcy5jaGFubmVsSWQrKzsgLy8gVGhpcyBhbmQgZXZlcnl0aGluZyBsZWFkaW5nIHVwIHRvIGl0IG11c3QgYmUgc3luY2hyb25vdXMsIHNvIHRoYXQgaWQgYXNzaWdubWVudCBpcyBkZXRlcm1pbmlzdGljLlxuICAgIGNvbnN0IG5lZ290aWF0ZWQgPSAodGhpcy5tdWx0aXBsZXggPT09ICduZWdvdGlhdGVkJykgJiYgaGFzU3RhcnRlZENvbm5lY3Rpbmc7XG4gICAgY29uc3QgYWxsb3dPdGhlclNpZGVUb0NyZWF0ZSA9ICFoYXNTdGFydGVkQ29ubmVjdGluZyAvKiFuZWdvdGlhdGVkKi8gJiYgISFzaWduYWxzOyAvLyBPbmx5IHRoZSAwdGggd2l0aCBzaWduYWxzIHdhaXRzIHBhc3NpdmVseS5cbiAgICAvLyBzaWduYWxzIGlzIGVpdGhlciBudWxsaXNoIG9yIGFuIGFycmF5IG9mIHNpZ25hbHMsIGJ1dCB0aGF0IGFycmF5IGNhbiBiZSBFTVBUWSxcbiAgICAvLyBpbiB3aGljaCBjYXNlIHRoZSByZWFsIHNpZ25hbHMgd2lsbCBoYXZlIHRvIGJlIGFzc2lnbmVkIGxhdGVyLiBUaGlzIGFsbG93cyB0aGUgZGF0YSBjaGFubmVsIHRvIGJlIHN0YXJ0ZWQgKGFuZCB0byBjb25zdW1lXG4gICAgLy8gYSBjaGFubmVsSWQpIHN5bmNocm9ub3VzbHksIGJ1dCB0aGUgcHJvbWlzZSB3b24ndCByZXNvbHZlIHVudGlsIHRoZSByZWFsIHNpZ25hbHMgYXJlIHN1cHBsaWVkIGxhdGVyLiBUaGlzIGlzXG4gICAgLy8gdXNlZnVsIGluIG11bHRpcGxleGluZyBhbiBvcmRlcmVkIHNlcmllcyBvZiBkYXRhIGNoYW5uZWxzIG9uIGFuIEFOU1dFUiBjb25uZWN0aW9uLCB3aGVyZSB0aGUgZGF0YSBjaGFubmVscyBtdXN0XG4gICAgLy8gbWF0Y2ggdXAgd2l0aCBhbiBPRkZFUiBjb25uZWN0aW9uIG9uIGEgcGVlci4gVGhpcyB3b3JrcyBiZWNhdXNlIG9mIHRoZSB3b25kZXJmdWwgaGFwcGVuc3RhbmNlIHRoYXQgYW5zd2VyIGNvbm5lY3Rpb25zXG4gICAgLy8gZ2V0RGF0YUNoYW5uZWxQcm9taXNlICh3aGljaCBkb2Vzbid0IHJlcXVpcmUgdGhlIGNvbm5lY3Rpb24gdG8geWV0IGJlIG9wZW4pIHJhdGhlciB0aGFuIGNyZWF0ZURhdGFDaGFubmVsICh3aGljaCB3b3VsZFxuICAgIC8vIHJlcXVpcmUgdGhlIGNvbm5lY3Rpb24gdG8gYWxyZWFkeSBiZSBvcGVuKS5cbiAgICBjb25zdCB1c2VTaWduYWxzID0gIWhhc1N0YXJ0ZWRDb25uZWN0aW5nICYmIHNpZ25hbHM/Lmxlbmd0aDtcbiAgICBjb25zdCBvcHRpb25zID0gbmVnb3RpYXRlZCA/IHtpZCwgbmVnb3RpYXRlZCwgLi4uY2hhbm5lbE9wdGlvbnN9IDogY2hhbm5lbE9wdGlvbnM7XG4gICAgaWYgKGhhc1N0YXJ0ZWRDb25uZWN0aW5nKSB7XG4gICAgICBhd2FpdCB0aGlzLmNvbm5lY3RlZDsgLy8gQmVmb3JlIGNyZWF0aW5nIHByb21pc2UuXG4gICAgICAvLyBJIHNvbWV0aW1lcyBlbmNvdW50ZXIgYSBidWcgaW4gU2FmYXJpIGluIHdoaWNoIE9ORSBvZiB0aGUgY2hhbm5lbHMgY3JlYXRlZCBzb29uIGFmdGVyIGNvbm5lY3Rpb24gZ2V0cyBzdHVjayBpblxuICAgICAgLy8gdGhlIGNvbm5lY3RpbmcgcmVhZHlTdGF0ZSBhbmQgbmV2ZXIgb3BlbnMuIEV4cGVyaW1lbnRhbGx5LCB0aGlzIHNlZW1zIHRvIGJlIHJvYnVzdC5cbiAgICAgIC8vXG4gICAgICAvLyBOb3RlIHRvIHNlbGY6IElmIGl0IHNob3VsZCB0dXJuIG91dCB0aGF0IHdlIHN0aWxsIGhhdmUgcHJvYmxlbXMsIHRyeSBzZXJpYWxpemluZyB0aGUgY2FsbHMgdG8gcGVlci5jcmVhdGVEYXRhQ2hhbm5lbFxuICAgICAgLy8gc28gdGhhdCB0aGVyZSBpc24ndCBtb3JlIHRoYW4gb25lIGNoYW5uZWwgb3BlbmluZyBhdCBhIHRpbWUuXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMTAwKSk7XG4gICAgfSBlbHNlIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICB0aGlzLnNpZ25hbHMgPSBzaWduYWxzO1xuICAgIH1cbiAgICBjb25zdCBwcm9taXNlID0gYWxsb3dPdGhlclNpZGVUb0NyZWF0ZSA/XG5cdCAgdGhpcy5nZXREYXRhQ2hhbm5lbFByb21pc2UoY2hhbm5lbE5hbWUpIDpcblx0ICB0aGlzLmNyZWF0ZURhdGFDaGFubmVsKGNoYW5uZWxOYW1lLCBvcHRpb25zKTtcbiAgICByZXR1cm4gYXdhaXQgcHJvbWlzZTtcbiAgfVxufVxuIiwiLy8gbmFtZS92ZXJzaW9uIG9mIFwiZGF0YWJhc2VcIlxuZXhwb3J0IGNvbnN0IHN0b3JhZ2VOYW1lID0gJ2ZsZXhzdG9yZSc7XG5leHBvcnQgY29uc3Qgc3RvcmFnZVZlcnNpb24gPSA4O1xuXG5pbXBvcnQgKiBhcyBwa2cgZnJvbSBcIi4uL3BhY2thZ2UuanNvblwiIHdpdGggeyB0eXBlOiAnanNvbicgfTtcbmV4cG9ydCBjb25zdCB7bmFtZSwgdmVyc2lvbn0gPSBwa2cuZGVmYXVsdDtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB7IHRhZ1BhdGggfSBmcm9tICcuL3RhZ1BhdGgubWpzJztcbmltcG9ydCB7IFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vd2VicnRjLm1qcyc7XG5pbXBvcnQgeyBzdG9yYWdlVmVyc2lvbiB9IGZyb20gJy4vdmVyc2lvbi5tanMnO1xuXG4vKlxuICBSZXNwb25zaWJsZSBmb3Iga2VlcGluZyBhIGNvbGxlY3Rpb24gc3luY2hyb25pemVkIHdpdGggYW5vdGhlciBwZWVyLlxuICAoUGVlcnMgbWF5IGJlIGEgY2xpZW50IG9yIGEgc2VydmVyL3JlbGF5LiBJbml0aWFsbHkgdGhpcyBpcyB0aGUgc2FtZSBjb2RlIGVpdGhlciB3YXksXG4gIGJ1dCBsYXRlciBvbiwgb3B0aW1pemF0aW9ucyBjYW4gYmUgbWFkZSBmb3Igc2NhbGUuKVxuXG4gIEFzIGxvbmcgYXMgdHdvIHBlZXJzIGFyZSBjb25uZWN0ZWQgd2l0aCBhIFN5bmNocm9uaXplciBvbiBlYWNoIHNpZGUsIHdyaXRpbmcgaGFwcGVuc1xuICBpbiBib3RoIHBlZXJzIGluIHJlYWwgdGltZSwgYW5kIHJlYWRpbmcgcHJvZHVjZXMgdGhlIGNvcnJlY3Qgc3luY2hyb25pemVkIHJlc3VsdCBmcm9tIGVpdGhlci5cbiAgVW5kZXIgdGhlIGhvb2QsIHRoZSBzeW5jaHJvbml6ZXIga2VlcHMgdHJhY2sgb2Ygd2hhdCBpdCBrbm93cyBhYm91dCB0aGUgb3RoZXIgcGVlciAtLVxuICBhIHBhcnRpY3VsYXIgdGFnIGNhbiBiZSB1bmtub3duLCB1bnN5bmNocm9uaXplZCwgb3Igc3luY2hyb25pemVkLCBhbmQgcmVhZGluZyB3aWxsXG4gIGNvbW11bmljYXRlIGFzIG5lZWRlZCB0byBnZXQgdGhlIGRhdGEgc3luY2hyb25pemVkIG9uLWRlbWFuZC4gTWVhbndoaWxlLCBzeW5jaHJvbml6YXRpb25cbiAgY29udGludWVzIGluIHRoZSBiYWNrZ3JvdW5kIHVudGlsIHRoZSBjb2xsZWN0aW9uIGlzIGZ1bGx5IHJlcGxpY2F0ZWQuXG5cbiAgQSBjb2xsZWN0aW9uIG1haW50YWlucyBhIHNlcGFyYXRlIFN5bmNocm9uaXplciBmb3IgZWFjaCBvZiB6ZXJvIG9yIG1vcmUgcGVlcnMsIGFuZCBjYW4gZHluYW1pY2FsbHlcbiAgYWRkIGFuZCByZW1vdmUgbW9yZS5cblxuICBOYW1pbmcgY29udmVudGlvbnM6XG5cbiAgbXVtYmxlTmFtZTogYSBzZW1hbnRpYyBuYW1lIHVzZWQgZXh0ZXJuYWxseSBhcyBhIGtleS4gRXhhbXBsZTogc2VydmljZU5hbWUsIGNoYW5uZWxOYW1lLCBldGMuXG4gICAgV2hlbiB0aGluZ3MgbmVlZCB0byBtYXRjaCB1cCBhY3Jvc3Mgc3lzdGVtcywgaXQgaXMgYnkgbmFtZS5cbiAgICBJZiBvbmx5IG9uZSBvZiBuYW1lL2xhYmVsIGlzIHNwZWNpZmllZCwgdGhpcyBpcyB1c3VhbGx5IHRoZSB0aGUgb25lLlxuXG4gIG11bWJsZUxhYmVsOiBhIGxhYmVsIGZvciBpZGVudGlmaWNhdGlvbiBhbmQgaW50ZXJuYWxseSAoZS5nLiwgZGF0YWJhc2UgbmFtZSkuXG4gICAgV2hlbiB0d28gaW5zdGFuY2VzIG9mIHNvbWV0aGluZyBhcmUgXCJ0aGUgc2FtZVwiIGJ1dCBhcmUgaW4gdGhlIHNhbWUgSmF2YXNjcmlwdCBpbWFnZSBmb3IgdGVzdGluZywgdGhleSBhcmUgZGlzdGluZ3Vpc2hlZCBieSBsYWJlbC5cbiAgICBUeXBpY2FsbHkgZGVmYXVsdHMgdG8gbXVtYmxlTmFtZS5cblxuICBOb3RlLCB0aG91Z2gsIHRoYXQgc29tZSBleHRlcm5hbCBtYWNoaW5lcnkgKHN1Y2ggYXMgYSBXZWJSVEMgRGF0YUNoYW5uZWwpIGhhcyBhIFwibGFiZWxcIiBwcm9wZXJ0eSB0aGF0IHdlIHBvcHVsYXRlIHdpdGggYSBcIm5hbWVcIiAoY2hhbm5lbE5hbWUpLlxuICovXG5leHBvcnQgY2xhc3MgU3luY2hyb25pemVyIHtcbiAgY29uc3RydWN0b3Ioe3NlcnZpY2VOYW1lID0gJ2RpcmVjdCcsIGNvbGxlY3Rpb24sIGVycm9yID0gY29sbGVjdGlvbj8uY29uc3RydWN0b3IuZXJyb3IgfHwgY29uc29sZS5lcnJvcixcblx0ICAgICAgIHNlcnZpY2VMYWJlbCA9IGNvbGxlY3Rpb24/LnNlcnZpY2VMYWJlbCB8fCBzZXJ2aWNlTmFtZSwgLy8gVXNlZCB0byBpZGVudGlmeSBhbnkgZXhpc3RpbmcgY29ubmVjdGlvbi4gQ2FuIGJlIGRpZmZlcmVudCBmcm9tIHNlcnZpY2VOYW1lIGR1cmluZyB0ZXN0aW5nLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHV1aWQgPSBjb2xsZWN0aW9uPy51dWlkLCBydGNDb25maWd1cmF0aW9uLCBjb25uZWN0aW9uLCAvLyBDb21wbGV4IGRlZmF1bHQgYmVoYXZpb3IgZm9yIHRoZXNlLiBTZWUgY29kZS5cblx0ICAgICAgIG11bHRpcGxleCA9IGNvbGxlY3Rpb24/Lm11bHRpcGxleCwgLy8gSWYgc3BlY2lmZWQsIG90aGVyd2lzZSB1bmRlZmluZWQgYXQgdGhpcyBwb2ludC4gU2VlIGJlbG93LlxuXHQgICAgICAgZGVidWcgPSBjb2xsZWN0aW9uPy5kZWJ1ZywgbWluVmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uLCBtYXhWZXJzaW9uID0gbWluVmVyc2lvbn0pIHtcbiAgICAvLyBzZXJ2aWNlTmFtZSBpcyBhIHN0cmluZyBvciBvYmplY3QgdGhhdCBpZGVudGlmaWVzIHdoZXJlIHRoZSBzeW5jaHJvbml6ZXIgc2hvdWxkIGNvbm5lY3QuIEUuZy4sIGl0IG1heSBiZSBhIFVSTCBjYXJyeWluZ1xuICAgIC8vICAgV2ViUlRDIHNpZ25hbGluZy4gSXQgc2hvdWxkIGJlIGFwcC11bmlxdWUgZm9yIHRoaXMgcGFydGljdWxhciBzZXJ2aWNlIChlLmcuLCB3aGljaCBtaWdodCBtdWx0aXBsZXggZGF0YSBmb3IgbXVsdGlwbGUgY29sbGVjdGlvbiBpbnN0YW5jZXMpLlxuICAgIC8vIHV1aWQgaGVscCB1bmlxdWVseSBpZGVudGlmaWVzIHRoaXMgcGFydGljdWxhciBzeW5jaHJvbml6ZXIuXG4gICAgLy8gICBGb3IgbW9zdCBwdXJwb3NlcywgdXVpZCBzaG91bGQgZ2V0IHRoZSBkZWZhdWx0LCBhbmQgcmVmZXJzIHRvIE9VUiBlbmQuXG4gICAgLy8gICBIb3dldmVyLCBhIHNlcnZlciB0aGF0IGNvbm5lY3RzIHRvIGEgYnVuY2ggb2YgcGVlcnMgbWlnaHQgYmFzaCBpbiB0aGUgdXVpZCB3aXRoIHRoYXQgb2YgdGhlIG90aGVyIGVuZCwgc28gdGhhdCBsb2dnaW5nIGluZGljYXRlcyB0aGUgY2xpZW50LlxuICAgIC8vIElmIGNoYW5uZWxOYW1lIGlzIHNwZWNpZmllZCwgaXQgc2hvdWxkIGJlIGluIHRoZSBmb3JtIG9mIGNvbGxlY3Rpb25UeXBlL2NvbGxlY3Rpb25OYW1lIChlLmcuLCBpZiBjb25uZWN0aW5nIHRvIHJlbGF5KS5cbiAgICBjb25zdCBjb25uZWN0VGhyb3VnaEludGVybmV0ID0gc2VydmljZU5hbWUuc3RhcnRzV2l0aD8uKCdodHRwJyk7XG4gICAgaWYgKCFjb25uZWN0VGhyb3VnaEludGVybmV0ICYmIChydGNDb25maWd1cmF0aW9uID09PSB1bmRlZmluZWQpKSBydGNDb25maWd1cmF0aW9uID0ge307IC8vIEV4cGljaXRseSBubyBpY2UuIExBTiBvbmx5LlxuICAgIC8vIG11bHRpcGxleCBzaG91bGQgZW5kIHVwIHdpdGggb25lIG9mIHRocmVlIHZhbHVlczpcbiAgICAvLyBmYWxzeSAtIGEgbmV3IGNvbm5lY3Rpb24gc2hvdWxkIGJlIHVzZWQgZm9yIGVhY2ggY2hhbm5lbFxuICAgIC8vIFwibmVnb3RpYXRlZFwiIC0gYm90aCBzaWRlcyBjcmVhdGUgdGhlIHNhbWUgY2hhbm5lbE5hbWVzIGluIHRoZSBzYW1lIG9yZGVyIChtb3N0IGNhc2VzKTpcbiAgICAvLyAgICAgVGhlIGluaXRpYWwgc2lnbmFsbGluZyB3aWxsIGJlIHRyaWdnZXJlZCBieSBvbmUgc2lkZSBjcmVhdGluZyBhIGNoYW5uZWwsIGFuZCB0aGVyIHNpZGUgd2FpdGluZyBmb3IgaXQgdG8gYmUgY3JlYXRlZC5cbiAgICAvLyAgICAgQWZ0ZXIgdGhhdCwgYm90aCBzaWRlcyB3aWxsIGV4cGxpY2l0bHkgY3JlYXRlIGEgZGF0YSBjaGFubmVsIGFuZCB3ZWJydGMgd2lsbCBtYXRjaCB0aGVtIHVwIGJ5IGlkLlxuICAgIC8vIGFueSBvdGhlciB0cnV0aHkgLSBTdGFydHMgbGlrZSBuZWdvdGlhdGVkLCBhbmQgdGhlbiBjb250aW51ZXMgd2l0aCBvbmx5IHdpZGUgc2lkZSBjcmVhdGluZyB0aGUgY2hhbm5lbHMsIGFuZCB0aGVyIG90aGVyXG4gICAgLy8gICAgIG9ic2VydmVzIHRoZSBjaGFubmVsIHRoYXQgaGFzIGJlZW4gbWFkZS4gVGhpcyBpcyB1c2VkIGZvciByZWxheXMuXG4gICAgbXVsdGlwbGV4ID8/PSBjb25uZWN0aW9uPy5tdWx0aXBsZXg7IC8vIFN0aWxsIHR5cGljYWxseSB1bmRlZmluZWQgYXQgdGhpcyBwb2ludC5cbiAgICBtdWx0aXBsZXggPz89IChzZXJ2aWNlTmFtZS5pbmNsdWRlcz8uKCcvc3luYycpIHx8ICduZWdvdGlhdGVkJyk7XG4gICAgY29ubmVjdGlvbiA/Pz0gU2hhcmVkV2ViUlRDLmVuc3VyZSh7c2VydmljZUxhYmVsLCBjb25maWd1cmF0aW9uOiBydGNDb25maWd1cmF0aW9uLCBtdWx0aXBsZXgsIHV1aWQsIGRlYnVnLCBlcnJvcn0pO1xuXG4gICAgdXVpZCA/Pz0gY29ubmVjdGlvbi51dWlkO1xuICAgIC8vIEJvdGggcGVlcnMgbXVzdCBhZ3JlZSBvbiBjaGFubmVsTmFtZS4gVXN1YWxseSwgdGhpcyBpcyBjb2xsZWN0aW9uLmZ1bGxOYW1lLiBCdXQgaW4gdGVzdGluZywgd2UgbWF5IHN5bmMgdHdvIGNvbGxlY3Rpb25zIHdpdGggZGlmZmVyZW50IG5hbWVzLlxuICAgIGNoYW5uZWxOYW1lID8/PSBjb2xsZWN0aW9uPy5jaGFubmVsTmFtZSB8fCBjb2xsZWN0aW9uLmZ1bGxOYW1lO1xuICAgIGNvbnN0IGxhYmVsID0gYCR7Y29sbGVjdGlvbj8uZnVsbExhYmVsIHx8IGNoYW5uZWxOYW1lfS8ke3V1aWR9YDtcbiAgICAvLyBXaGVyZSB3ZSBjYW4gcmVxdWVzdCBhIGRhdGEgY2hhbm5lbCB0aGF0IHB1c2hlcyBwdXQvZGVsZXRlIHJlcXVlc3RzIGZyb20gb3RoZXJzLlxuICAgIGNvbnN0IGNvbm5lY3Rpb25VUkwgPSBzZXJ2aWNlTmFtZS5pbmNsdWRlcz8uKCcvc2lnbmFsLycpID8gc2VydmljZU5hbWUgOiBgJHtzZXJ2aWNlTmFtZX0vJHtsYWJlbH1gO1xuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7c2VydmljZU5hbWUsIGxhYmVsLCBjb2xsZWN0aW9uLCBkZWJ1ZywgZXJyb3IsIG1pblZlcnNpb24sIG1heFZlcnNpb24sIHV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sXG5cdFx0XHQgY29ubmVjdGlvbiwgdXVpZCwgY2hhbm5lbE5hbWUsIGNvbm5lY3Rpb25VUkwsXG5cdFx0XHQgY29ubmVjdGlvblN0YXJ0VGltZTogRGF0ZS5ub3coKSxcblx0XHRcdCBjbG9zZWQ6IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpLFxuXHRcdFx0IC8vIE5vdCB1c2VkIHlldCwgYnV0IGNvdWxkIGJlIHVzZWQgdG8gR0VUIHJlc291cmNlcyBvdmVyIGh0dHAgaW5zdGVhZCBvZiB0aHJvdWdoIHRoZSBkYXRhIGNoYW5uZWwuXG5cdFx0XHQgaG9zdFJlcXVlc3RCYXNlOiBjb25uZWN0VGhyb3VnaEludGVybmV0ICYmIGAke3NlcnZpY2VOYW1lLnJlcGxhY2UoL1xcLyhzeW5jfHNpZ25hbCkvKX0vJHtjaGFubmVsTmFtZX1gfSk7XG4gICAgY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5zZXQoc2VydmljZU5hbWUsIHRoaXMpOyAvLyBNdXN0IGJlIHNldCBzeW5jaHJvbm91c2x5LCBzbyB0aGF0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxIGtub3dzIHRvIHdhaXQuXG4gIH1cbiAgc3RhdGljIGFzeW5jIGNyZWF0ZShjb2xsZWN0aW9uLCBzZXJ2aWNlTmFtZSwgb3B0aW9ucyA9IHt9KSB7IC8vIFJlY2VpdmUgcHVzaGVkIG1lc3NhZ2VzIGZyb20gdGhlIGdpdmVuIHNlcnZpY2UuIGdldC9wdXQvZGVsZXRlIHdoZW4gdGhleSBjb21lICh3aXRoIGVtcHR5IHNlcnZpY2VzIGxpc3QpLlxuICAgIGNvbnN0IHN5bmNocm9uaXplciA9IG5ldyB0aGlzKHtjb2xsZWN0aW9uLCBzZXJ2aWNlTmFtZSwgLi4ub3B0aW9uc30pO1xuICAgIGNvbnN0IGNvbm5lY3RlZFByb21pc2UgPSBzeW5jaHJvbml6ZXIuY29ubmVjdENoYW5uZWwoKTsgLy8gRXN0YWJsaXNoIGNoYW5uZWwgY3JlYXRpb24gb3JkZXIuXG4gICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgY29ubmVjdGVkUHJvbWlzZTtcbiAgICBpZiAoIWNvbm5lY3RlZCkgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgICByZXR1cm4gYXdhaXQgY29ubmVjdGVkLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdENoYW5uZWwoKSB7IC8vIFN5bmNocm9ub3VzbHkgaW5pdGlhbGl6ZSBhbnkgcHJvbWlzZXMgdG8gY3JlYXRlIGEgZGF0YSBjaGFubmVsLCBhbmQgdGhlbiBhd2FpdCBjb25uZWN0aW9uLlxuICAgIGNvbnN0IHtob3N0UmVxdWVzdEJhc2UsIHV1aWQsIGNvbm5lY3Rpb24sIHNlcnZpY2VOYW1lfSA9IHRoaXM7XG4gICAgbGV0IHN0YXJ0ZWQgPSBjb25uZWN0aW9uLmhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGlmIChzdGFydGVkKSB7XG4gICAgICAvLyBXZSBhbHJlYWR5IGhhdmUgYSBjb25uZWN0aW9uLiBKdXN0IG9wZW4gYW5vdGhlciBkYXRhIGNoYW5uZWwgZm9yIG91ciB1c2UuXG4gICAgICBzdGFydGVkID0gdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgPSBjb25uZWN0aW9uLmVuc3VyZURhdGFDaGFubmVsKHRoaXMuY2hhbm5lbE5hbWUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc2lnbmFsL2Fuc3dlcicpKSB7IC8vIFBvc3QgYW4gYW5zd2VyIHRvIGFuIG9mZmVyIHdlIGdlbmVyYXRlIGZvciBhIHJlbmRldm91cyBwZWVyLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpOyAvLyBKdXN0IGxpa2UgYSBzeW5jXG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zaWduYWwvb2ZmZXInKSkgeyAvLyBHZXQgYW4gb2ZmZXIgZnJvbSBhIHJlbmRldm91cyBwZWVyIGFuZCBwb3N0IGFuIGFuc3dlci5cbiAgICAgIC8vIFdlIG11c3Qgc3ljaHJvbm91c2x5IHN0YXJ0Q29ubmVjdGlvbiBub3cgc28gdGhhdCBvdXIgY29ubmVjdGlvbiBoYXNTdGFydGVkQ29ubmVjdGluZywgYW5kIGFueSBzdWJzZXF1ZW50IGRhdGEgY2hhbm5lbFxuICAgICAgLy8gcmVxdWVzdHMgb24gdGhlIHNhbWUgY29ubmVjdGlvbiB3aWxsIHdhaXQgKHVzaW5nIHRoZSAnc3RhcnRlZCcgcGF0aCwgYWJvdmUpLlxuICAgICAgY29uc3QgcHJvbWlzZWRTaWduYWxzID0gdGhpcy5zdGFydENvbm5lY3Rpb24oW10pOyAvLyBFc3RhYmxpc2hpbmcgb3JkZXIuXG4gICAgICBjb25zdCB1cmwgPSB0aGlzLmNvbm5lY3Rpb25VUkw7XG4gICAgICBjb25zdCBvZmZlciA9IGF3YWl0IHRoaXMuZmV0Y2godXJsKTtcbiAgICAgIHRoaXMuY29tcGxldGVDb25uZWN0aW9uKG9mZmVyKTsgLy8gTm93IHN1cHBseSB0aG9zZSBzaWduYWxzIHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gY2FuIHByb2R1Y2UgYW5zd2VyIHNpZ2Fscy5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmZldGNoKHVybCwgYXdhaXQgcHJvbWlzZWRTaWduYWxzKTsgLy8gVGVsbCB0aGUgcGVlciBhYm91dCBvdXIgYW5zd2VyLlxuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc3luYycpKSB7IC8vIENvbm5lY3Qgd2l0aCBhIHNlcnZlciByZWxheS4gKFNpZ25hbCBhbmQgc3RheSBjb25uZWN0ZWQgdGhyb3VnaCBzeW5jLilcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmNvbm5lY3RTZXJ2ZXIoKTtcbiAgICB9IGVsc2UgaWYgKHNlcnZpY2VOYW1lID09PSAnc2lnbmFscycpIHsgLy8gU3RhcnQgY29ubmVjdGlvbiBhbmQgcmV0dXJuIG51bGwuIE11c3QgYmUgY29udGludWVkIHdpdGggY29tcGxldGVTaWduYWxzU3luY2hyb25pemF0aW9uKCk7XG4gICAgICBzdGFydGVkID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShzZXJ2aWNlTmFtZSkpIHsgLy8gQSBsaXN0IG9mIFwicmVjZWl2aW5nXCIgc2lnbmFscy5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbihzZXJ2aWNlTmFtZSk7XG4gICAgfSBlbHNlIGlmIChzZXJ2aWNlTmFtZS5zeW5jaHJvbml6ZXJzKSB7IC8vIER1Y2sgdHlwaW5nIGZvciBwYXNzaW5nIGEgY29sbGVjdGlvbiBkaXJlY3RseSBhcyB0aGUgc2VydmljZUluZm8uIChXZSBkb24ndCBpbXBvcnQgQ29sbGVjdGlvbi4pXG4gICAgICBzdGFydGVkID0gdGhpcy5jb25uZWN0RGlyZWN0VGVzdGluZyhzZXJ2aWNlTmFtZSk7IC8vIFVzZWQgaW4gdGVzdGluZy5cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnJlY29nbml6ZWQgc2VydmljZSBmb3JtYXQ6ICR7c2VydmljZU5hbWV9LmApO1xuICAgIH1cbiAgICBpZiAoIShhd2FpdCBzdGFydGVkKSkge1xuICAgICAgY29uc29sZS53YXJuKHRoaXMubGFiZWwsICdjb25uZWN0aW9uIGZhaWxlZCcpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAodGhpcy5kZWJ1ZykgY29uc29sZS5sb2codGhpcy5sYWJlbCwgLi4ucmVzdCk7XG4gIH1cbiAgZ2V0IGRhdGFDaGFubmVsUHJvbWlzZSgpIHsgLy8gQSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gYW4gb3BlbiBkYXRhIGNoYW5uZWwuXG4gICAgY29uc3QgcHJvbWlzZSA9IHRoaXMuX2RhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBpZiAoIXByb21pc2UpIHRocm93IG5ldyBFcnJvcihgJHt0aGlzLmxhYmVsfTogRGF0YSBjaGFubmVsIGlzIG5vdCB5ZXQgcHJvbWlzZWQuYCk7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgY2hhbm5lbENsb3NlZENsZWFudXAoKSB7IC8vIEJvb2trZWVwaW5nIHdoZW4gY2hhbm5lbCBjbG9zZWQgb3IgZXhwbGljaXRseSBhYmFuZG9uZWQgYmVmb3JlIG9wZW5pbmcuXG4gICAgdGhpcy5jb2xsZWN0aW9uPy5zeW5jaHJvbml6ZXJzLmRlbGV0ZSh0aGlzLnNlcnZpY2VOYW1lKTtcbiAgICB0aGlzLmNsb3NlZC5yZXNvbHZlKHRoaXMpOyAvLyBSZXNvbHZlIHRvIHN5bmNocm9uaXplciBpcyBuaWNlIGlmLCBlLmcsIHNvbWVvbmUgaXMgUHJvbWlzZS5yYWNpbmcuXG4gIH1cbiAgc2V0IGRhdGFDaGFubmVsUHJvbWlzZShwcm9taXNlKSB7IC8vIFNldCB1cCBtZXNzYWdlIGFuZCBjbG9zZSBoYW5kbGluZy5cbiAgICB0aGlzLl9kYXRhQ2hhbm5lbFByb21pc2UgPSBwcm9taXNlLnRoZW4oZGF0YUNoYW5uZWwgPT4ge1xuICAgICAgZGF0YUNoYW5uZWwub25tZXNzYWdlID0gZXZlbnQgPT4gdGhpcy5yZWNlaXZlKGV2ZW50LmRhdGEpO1xuICAgICAgZGF0YUNoYW5uZWwub25jbG9zZSA9IGFzeW5jIGV2ZW50ID0+IHRoaXMuY2hhbm5lbENsb3NlZENsZWFudXAoKTtcbiAgICAgIHJldHVybiBkYXRhQ2hhbm5lbDtcbiAgICB9KTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZSgpIHtcbiAgICBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBhd2FpdCB0aGlzLnN0YXJ0ZWRTeW5jaHJvbml6YXRpb247XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cbiAgc3RhdGljIGZyYWdtZW50SWQgPSAwO1xuICBhc3luYyBzZW5kKG1ldGhvZCwgLi4ucGFyYW1zKSB7IC8vIFNlbmRzIHRvIHRoZSBwZWVyLCBvdmVyIHRoZSBkYXRhIGNoYW5uZWxcbiAgICAvLyBUT0RPOiBicmVhayB1cCBsb25nIG1lc3NhZ2VzLiAoQXMgYSBwcmFjdGljYWwgbWF0dGVyLCAxNiBLaUIgaXMgdGhlIGxvbmdlc3QgdGhhdCBjYW4gcmVsaWFibHkgYmUgc2VudCBhY3Jvc3MgZGlmZmVyZW50IHdydGMgaW1wbGVtZW50YXRpb25zLilcbiAgICAvLyBTZWUgaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL1dlYlJUQ19BUEkvVXNpbmdfZGF0YV9jaGFubmVscyNjb25jZXJuc193aXRoX2xhcmdlX21lc3NhZ2VzXG4gICAgY29uc3QgcGF5bG9hZCA9IEpTT04uc3RyaW5naWZ5KHttZXRob2QsIHBhcmFtc30pO1xuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgY29uc3Qgc3RhdGUgPSBkYXRhQ2hhbm5lbD8ucmVhZHlTdGF0ZSB8fCAnY2xvc2VkJztcbiAgICBpZiAoc3RhdGUgPT09ICdjbG9zZWQnIHx8IHN0YXRlID09PSAnY2xvc2luZycpIHJldHVybjtcbiAgICB0aGlzLmxvZygnc2VuZHMnLCBtZXRob2QsIC4uLnBhcmFtcyk7XG4gICAgY29uc3Qgc2l6ZSA9IDE2ZTM7IC8vIEEgYml0IGxlc3MgdGhhbiAxNiAqIDEwMjQuXG4gICAgaWYgKHBheWxvYWQubGVuZ3RoIDwgc2l6ZSkge1xuICAgICAgZGF0YUNoYW5uZWwuc2VuZChwYXlsb2FkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgbnVtQ2h1bmtzID0gTWF0aC5jZWlsKHBheWxvYWQubGVuZ3RoIC8gc2l6ZSk7XG4gICAgY29uc3QgaWQgPSB0aGlzLmNvbnN0cnVjdG9yLmZyYWdtZW50SWQrKztcbiAgICBjb25zdCBtZXRhID0ge21ldGhvZDogJ2ZyYWdtZW50cycsIHBhcmFtczogW2lkLCBudW1DaHVua3NdfTtcbiAgICAvL2NvbnNvbGUubG9nKGBGcmFnbWVudGluZyBtZXNzYWdlICR7aWR9IGludG8gJHtudW1DaHVua3N9IGNodW5rcy5gLCBtZXRhKTtcbiAgICBkYXRhQ2hhbm5lbC5zZW5kKEpTT04uc3RyaW5naWZ5KG1ldGEpKTtcbiAgICAvLyBPcHRpbWl6YXRpb24gb3Bwb3J0dW5pdHk6IHJlbHkgb24gbWVzc2FnZXMgYmVpbmcgb3JkZXJlZCBhbmQgc2tpcCByZWR1bmRhbnQgaW5mby4gSXMgaXQgd29ydGggaXQ/XG4gICAgZm9yIChsZXQgaSA9IDAsIG8gPSAwOyBpIDwgbnVtQ2h1bmtzOyArK2ksIG8gKz0gc2l6ZSkge1xuICAgICAgY29uc3QgZnJhZyA9IHttZXRob2Q6ICdmcmFnJywgcGFyYW1zOiBbaWQsIGksIHBheWxvYWQuc3Vic3RyKG8sIHNpemUpXX07XG4gICAgICBkYXRhQ2hhbm5lbC5zZW5kKEpTT04uc3RyaW5naWZ5KGZyYWcpKTtcbiAgICB9XG4gIH1cbiAgcmVjZWl2ZSh0ZXh0KSB7IC8vIERpc3BhdGNoIGEgbWVzc2FnZSBzZW50IG92ZXIgdGhlIGRhdGEgY2hhbm5lbCBmcm9tIHRoZSBwZWVyLlxuICAgIGNvbnN0IHttZXRob2QsIHBhcmFtc30gPSBKU09OLnBhcnNlKHRleHQpO1xuICAgIHRoaXNbbWV0aG9kXSguLi5wYXJhbXMpO1xuICB9XG4gIHBlbmRpbmdGcmFnbWVudHMgPSB7fTtcbiAgZnJhZ21lbnRzKGlkLCBudW1DaHVua3MpIHtcbiAgICAvL2NvbnNvbGUubG9nKGBSZWNlaXZpbmcgbWVzYWdlICR7aWR9IGluICR7bnVtQ2h1bmtzfS5gKTtcbiAgICB0aGlzLnBlbmRpbmdGcmFnbWVudHNbaWRdID0ge3JlbWFpbmluZzogbnVtQ2h1bmtzLCBtZXNzYWdlOiBBcnJheShudW1DaHVua3MpfTtcbiAgfVxuICBmcmFnKGlkLCBpLCBmcmFnbWVudCkge1xuICAgIGxldCBmcmFnID0gdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXTsgLy8gV2UgYXJlIHJlbHlpbmcgb24gZnJhZ21lbnQgbWVzc2FnZSBjb21pbmcgZmlyc3QuXG4gICAgZnJhZy5tZXNzYWdlW2ldID0gZnJhZ21lbnQ7XG4gICAgaWYgKDAgIT09IC0tZnJhZy5yZW1haW5pbmcpIHJldHVybjtcbiAgICAvL2NvbnNvbGUubG9nKGBEaXNwYXRjaGluZyBtZXNzYWdlICR7aWR9LmApO1xuICAgIHRoaXMucmVjZWl2ZShmcmFnLm1lc3NhZ2Uuam9pbignJykpO1xuICAgIGRlbGV0ZSB0aGlzLnBlbmRpbmdGcmFnbWVudHNbaWRdO1xuICB9XG5cbiAgYXN5bmMgZGlzY29ubmVjdCgpIHsgLy8gV2FpdCBmb3IgZGF0YUNoYW5uZWwgdG8gZHJhaW4gYW5kIHJldHVybiBhIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIGFjdHVhbGx5IGNsb3NlZCxcbiAgICAvLyBidXQgcmV0dXJuIGltbWVkaWF0ZWx5IGlmIGNvbm5lY3Rpb24gbm90IHN0YXJ0ZWQuXG4gICAgaWYgKHRoaXMuY29ubmVjdGlvbi5wZWVyLmNvbm5lY3Rpb25TdGF0ZSAhPT0gJ2Nvbm5lY3RlZCcpIHJldHVybiB0aGlzLmNoYW5uZWxDbG9zZWRDbGVhbnVwKHRoaXMuY29ubmVjdGlvbi5jbG9zZSgpKTtcbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGRhdGFDaGFubmVsLmNsb3NlKCk7XG4gICAgcmV0dXJuIHRoaXMuY2xvc2VkO1xuICB9XG4gIC8vIFRPRE86IHdlYnJ0YyBuZWdvdGlhdGlvbiBuZWVkZWQgZHVyaW5nIHN5bmMuXG4gIC8vIFRPRE86IHdlYnJ0YyBuZWdvdGlhdGlvbiBuZWVkZWQgYWZ0ZXIgc3luYy5cbiAgc3RhcnRDb25uZWN0aW9uKHNpZ25hbE1lc3NhZ2VzKSB7IC8vIE1hY2hpbmVyeSBmb3IgbWFraW5nIGEgV2ViUlRDIGNvbm5lY3Rpb24gdG8gdGhlIHBlZXI6XG4gICAgLy8gICBJZiBzaWduYWxNZXNzYWdlcyBpcyBhIGxpc3Qgb2YgW29wZXJhdGlvbiwgbWVzc2FnZV0gbWVzc2FnZSBvYmplY3RzLCB0aGVuIHRoZSBvdGhlciBzaWRlIGlzIGluaXRpYXRpbmdcbiAgICAvLyB0aGUgY29ubmVjdGlvbiBhbmQgaGFzIHNlbnQgYW4gaW5pdGlhbCBvZmZlci9pY2UuIEluIHRoaXMgY2FzZSwgY29ubmVjdCgpIHByb21pc2VzIGEgcmVzcG9uc2VcbiAgICAvLyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUuXG4gICAgLy8gICBPdGhlcndpc2UsIGNvbm5lY3QoKSBwcm9taXNlcyBhIGxpc3Qgb2YgaW5pdGlhbCBzaWduYWwgbWVzc2FnZXMgdG8gYmUgZGVsaXZlcmVkIHRvIHRoZSBvdGhlciBzaWRlLFxuICAgIC8vIGFuZCBpdCBpcyBuZWNlc3NhcnkgdG8gdGhlbiBjYWxsIGNvbXBsZXRlQ29ubmVjdGlvbigpIHdpdGggdGhlIHJlc3BvbnNlIGZyb20gdGhlbS5cbiAgICAvLyBJbiBib3RoIGNhc2VzLCBhcyBhIHNpZGUgZWZmZWN0LCB0aGUgZGF0YUNoYW5uZWxQcm9taXNlIHByb3BlcnR5IHdpbGwgYmUgc2V0IHRvIGEgUHJvbWlzZVxuICAgIC8vIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIGRhdGEgY2hhbm5lbCB3aGVuIGl0IGlzIG9wZW5zLiBUaGlzIHByb21pc2UgaXMgdXNlZCBieSBzZW5kKCkgYW5kIHJlY2VpdmUoKS5cbiAgICBjb25zdCB7Y29ubmVjdGlvbn0gPSB0aGlzO1xuICAgIHRoaXMubG9nKHNpZ25hbE1lc3NhZ2VzID8gJ2dlbmVyYXRpbmcgYW5zd2VyJyA6ICdnZW5lcmF0aW5nIG9mZmVyJyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgPSBjb25uZWN0aW9uLmVuc3VyZURhdGFDaGFubmVsKHRoaXMuY2hhbm5lbE5hbWUsIHt9LCBzaWduYWxNZXNzYWdlcyk7XG4gICAgcmV0dXJuIGNvbm5lY3Rpb24uc2lnbmFscztcbiAgfVxuICBjb21wbGV0ZUNvbm5lY3Rpb24oc2lnbmFsTWVzc2FnZXMpIHsgLy8gRmluaXNoIHdoYXQgd2FzIHN0YXJ0ZWQgd2l0aCBzdGFydENvbGxlY3Rpb24uXG4gICAgLy8gRG9lcyBub3QgcmV0dXJuIGEgcHJvbWlzZS4gQ2xpZW50IGNhbiBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSB0byBzZWUgd2hlbiB3ZSBhcmUgYWN0dWFsbHkgY29ubmVjdGVkLlxuICAgIGlmICghc2lnbmFsTWVzc2FnZXMpIHJldHVybiBmYWxzZTtcbiAgICB0aGlzLmNvbm5lY3Rpb24uc2lnbmFscyA9IHNpZ25hbE1lc3NhZ2VzO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgc3RhdGljIGZldGNoSlNPTih1cmwsIGJvZHkgPSB1bmRlZmluZWQsIG1ldGhvZCA9IG51bGwpIHtcbiAgICBjb25zdCBoYXNCb2R5ID0gYm9keSAhPT0gdW5kZWZpbmVkO1xuICAgIG1ldGhvZCA/Pz0gaGFzQm9keSA/ICdQT1NUJyA6ICdHRVQnO1xuICAgIHJldHVybiBmZXRjaCh1cmwsIGhhc0JvZHkgPyB7bWV0aG9kLCBoZWFkZXJzOiB7XCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCJ9LCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KX0gOiB7bWV0aG9kfSlcbiAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcblx0aWYgKCFyZXNwb25zZS5vaykgdGhyb3cgbmV3IEVycm9yKGAke3Jlc3BvbnNlLnN0YXR1c1RleHQgfHwgJ0ZldGNoIGZhaWxlZCd9LCBjb2RlICR7cmVzcG9uc2Uuc3RhdHVzfSBpbiAke3VybH0uYCk7XG5cdHJldHVybiByZXNwb25zZS5qc29uKCk7XG4gICAgICB9KTtcbiAgfVxuICBhc3luYyBmZXRjaCh1cmwsIGJvZHkgPSB1bmRlZmluZWQpIHsgLy8gQXMgSlNPTlxuXG4gICAgaWYgKHRoaXMuZGVidWcpIHRoaXMubG9nKCdmZXRjaCBzaWduYWxzJywgdXJsLCBKU09OLnN0cmluZ2lmeShib2R5LCBudWxsLCAyKSk7IC8vIFRPRE86IHN0cmluZ2lmeSBpbiBsb2cgaW5zdGVhZCBvZiBuZWVkaW5nIHRvIGd1YXJkIHdpdGggdGhpcy5kZWJ1Zy5cbiAgICBjb25zdCByZXN1bHQgPSB0aGlzLmNvbnN0cnVjdG9yLmZldGNoSlNPTih1cmwsIGJvZHkpXG5cdCAgLmNhdGNoKGVycm9yID0+IHtcblx0ICAgIHRoaXMuY2xvc2VkLnJlamVjdChlcnJvcik7XG5cdCAgfSk7XG4gICAgaWYgKCFyZXN1bHQpIHJldHVybiBudWxsO1xuICAgIGlmICh0aGlzLmRlYnVnKSB0aGlzLmxvZygnZmV0Y2ggcmVzcG9uc2VTaWduYWxzJywgdXJsLCBKU09OLnN0cmluZ2lmeShyZXN1bHQsIG51bGwsIDIpKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG4gIGFzeW5jIGNvbm5lY3RTZXJ2ZXIodXJsID0gdGhpcy5jb25uZWN0aW9uVVJMKSB7IC8vIENvbm5lY3QgdG8gYSByZWxheSBvdmVyIGh0dHAuIENvbXBhcmUgY29ubmVjdFJlbmRldm91c1xuICAgIC8vIHN0YXJ0Q29ubmVjdGlvbiwgcG9zdCBpdCwgY29tcGxldGVDb25uZWN0aW9uIHdpdGggdGhlIHJlc3BvbnNlLlxuICAgIC8vIE91ciB3ZWJydGMgc3luY2hyb25pemVyIGlzIHRoZW4gY29ubmVjdGVkIHRvIHRoZSByZWxheSdzIHdlYnJ0IHN5bmNocm9uaXplci5cbiAgICBjb25zdCBvdXJTaWduYWxzUHJvbWlzZSA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7IC8vIG11c3QgYmUgc3luY2hyb25vdXMgdG8gcHJlc2VydmUgY2hhbm5lbCBpZCBvcmRlci5cbiAgICBjb25zdCBvdXJTaWduYWxzID0gYXdhaXQgb3VyU2lnbmFsc1Byb21pc2U7XG4gICAgY29uc3QgdGhlaXJTaWduYWxzID0gYXdhaXQgdGhpcy5mZXRjaCh1cmwsIG91clNpZ25hbHMpO1xuICAgIHJldHVybiB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbih0aGVpclNpZ25hbHMpO1xuICB9XG4gIGFzeW5jIGNvbXBsZXRlU2lnbmFsc1N5bmNocm9uaXphdGlvbihzaWduYWxzKSB7IC8vIEdpdmVuIGFuc3dlci9pY2Ugc2lnbmFscywgY29tcGxldGUgdGhlIGNvbm5lY3Rpb24gYW5kIHN0YXJ0IHN5bmNocm9uaXplLlxuICAgIGF3YWl0IHRoaXMuY29tcGxldGVDb25uZWN0aW9uKHNpZ25hbHMpO1xuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemUoKTtcbiAgfVxuICBhc3luYyBjb25uZWN0RGlyZWN0VGVzdGluZyhwZWVyQ29sbGVjdGlvbikgeyAvLyBVc2VkIGluIHVuaXQgdGVzdGluZywgd2hlcmUgdGhlIFwicmVtb3RlXCIgc2VydmljZSBpcyBzcGVjaWZpZWQgZGlyZWN0bHkgKG5vdCBhIHN0cmluZykuXG4gICAgLy8gRWFjaCBjb2xsZWN0aW9uIGlzIGFza2VkIHRvIHN5Y2hyb25pemUgdG8gYW5vdGhlciBjb2xsZWN0aW9uLlxuICAgIGNvbnN0IHBlZXJTeW5jaHJvbml6ZXIgPSBwZWVyQ29sbGVjdGlvbi5zeW5jaHJvbml6ZXJzLmdldCh0aGlzLmNvbGxlY3Rpb24pO1xuICAgIGlmICghcGVlclN5bmNocm9uaXplcikgeyAvLyBUaGUgb3RoZXIgc2lkZSBkb2Vzbid0IGtub3cgYWJvdXQgdXMgeWV0LiBUaGUgb3RoZXIgc2lkZSB3aWxsIGRvIHRoZSB3b3JrLlxuICAgICAgdGhpcy5fZGVsYXkgPSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UoKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3Qgb3VyU2lnbmFscyA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7XG4gICAgY29uc3QgdGhlaXJTaWduYWxzID0gYXdhaXQgcGVlclN5bmNocm9uaXplci5zdGFydENvbm5lY3Rpb24oYXdhaXQgb3VyU2lnbmFscyk7XG4gICAgcGVlclN5bmNocm9uaXplci5fZGVsYXkucmVzb2x2ZSgpO1xuICAgIHJldHVybiB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbih0aGVpclNpZ25hbHMpO1xuICB9XG5cbiAgLy8gQSBjb21tb24gcHJhY3RpY2UgaGVyZSBpcyB0byBoYXZlIGEgcHJvcGVydHkgdGhhdCBpcyBhIHByb21pc2UgZm9yIGhhdmluZyBzb21ldGhpbmcgZG9uZS5cbiAgLy8gQXN5bmNocm9ub3VzIG1hY2hpbmVyeSBjYW4gdGhlbiByZXNvbHZlIGl0LlxuICAvLyBBbnl0aGluZyB0aGF0IGRlcGVuZHMgb24gdGhhdCBjYW4gYXdhaXQgdGhlIHJlc29sdmVkIHZhbHVlLCB3aXRob3V0IHdvcnJ5aW5nIGFib3V0IGhvdyBpdCBnZXRzIHJlc29sdmVkLlxuICAvLyBXZSBjYWNoZSB0aGUgcHJvbWlzZSBzbyB0aGF0IHdlIGRvIG5vdCByZXBldGVkbHkgdHJpZ2dlciB0aGUgdW5kZXJseWluZyBhY3Rpb24uXG4gIG1ha2VSZXNvbHZlYWJsZVByb21pc2UoaWdub3JlZCkgeyAvLyBBbnN3ZXIgYSBQcm9taXNlIHRoYXQgY2FuIGJlIHJlc29sdmUgd2l0aCB0aGVQcm9taXNlLnJlc29sdmUodmFsdWUpLlxuICAgIC8vIFRoZSBpZ25vcmVkIGFyZ3VtZW50IGlzIGEgY29udmVuaWVudCBwbGFjZSB0byBjYWxsIHNvbWV0aGluZyBmb3Igc2lkZS1lZmZlY3QuXG4gICAgbGV0IHJlc29sdmVyLCByZWplY3RlcjtcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4geyByZXNvbHZlciA9IHJlc29sdmU7IHJlamVjdGVyID0gcmVqZWN0OyB9KTtcbiAgICBwcm9taXNlLnJlc29sdmUgPSByZXNvbHZlcjtcbiAgICBwcm9taXNlLnJlamVjdCA9IHJlamVjdGVyO1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG5cbiAgYXN5bmMgdmVyc2lvbnMobWluLCBtYXgpIHsgLy8gT24gcmVjZWl2aW5nIHRoZSB2ZXJzaW9ucyBzdXBwb3J0ZWQgYnkgdGhlIHRoZSBwZWVyLCByZXNvbHZlIHRoZSB2ZXJzaW9uIHByb21pc2UuXG4gICAgbGV0IHZlcnNpb25Qcm9taXNlID0gdGhpcy52ZXJzaW9uO1xuICAgIGNvbnN0IGNvbWJpbmVkTWF4ID0gTWF0aC5taW4obWF4LCB0aGlzLm1heFZlcnNpb24pO1xuICAgIGNvbnN0IGNvbWJpbmVkTWluID0gTWF0aC5tYXgobWluLCB0aGlzLm1pblZlcnNpb24pO1xuICAgIGlmIChjb21iaW5lZE1heCA+PSBjb21iaW5lZE1pbikgcmV0dXJuIHZlcnNpb25Qcm9taXNlLnJlc29sdmUoY29tYmluZWRNYXgpOyAvLyBObyBuZWVkIHRvIHJlc3BvbmQsIGFzIHRoZXkgd2lsbCBwcm9kdWNlIHRoZSBzYW1lIGRldGVybWluaXN0aWMgYW5zd2VyLlxuICAgIHJldHVybiB2ZXJzaW9uUHJvbWlzZS5yZXNvbHZlKDApO1xuICB9XG4gIGdldCB2ZXJzaW9uKCkgeyAvLyBQcm9taXNlIHRoZSBoaWdoZXN0IHZlcnNpb24gc3Vwb3J0ZWQgYnkgYm90aCBzaWRlcywgb3IgZGlzY29ubmVjdCBhbmQgZmFsc3kgaWYgbm9uZS5cbiAgICAvLyBUZWxscyB0aGUgb3RoZXIgc2lkZSBvdXIgdmVyc2lvbnMgaWYgd2UgaGF2ZW4ndCB5ZXQgZG9uZSBzby5cbiAgICAvLyBGSVhNRTogY2FuIHdlIGF2b2lkIHRoaXMgdGltZW91dD9cbiAgICByZXR1cm4gdGhpcy5fdmVyc2lvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHNldFRpbWVvdXQoKCkgPT4gdGhpcy5zZW5kKCd2ZXJzaW9ucycsIHRoaXMubWluVmVyc2lvbiwgdGhpcy5tYXhWZXJzaW9uKSwgMjAwKSk7XG4gIH1cblxuICBnZXQgc3RhcnRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gd2UgaGF2ZSBzdGFydGVkIHN5bmNocm9uaXphdGlvbi5cbiAgICByZXR1cm4gdGhpcy5fc3RhcnRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5zdGFydFN5bmNocm9uaXphdGlvbigpO1xuICB9XG4gIGdldCBjb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbnVtYmVyIG9mIGl0ZW1zIHRoYXQgd2VyZSB0cmFuc2ZlcnJlZCAobm90IG5lY2Vzc2FyaWxseSB3cml0dGVuKS5cbiAgICAvLyBTdGFydHMgc3luY2hyb25pemF0aW9uIGlmIGl0IGhhc24ndCBhbHJlYWR5LiBFLmcuLCB3YWl0aW5nIG9uIGNvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB3b24ndCByZXNvbHZlIHVudGlsIGFmdGVyIGl0IHN0YXJ0cy5cbiAgICByZXR1cm4gdGhpcy5fY29tcGxldGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UodGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uKTtcbiAgfVxuICBnZXQgcGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBudW1iZXIgb2YgaXRlbXMgdGhhdCB0aGUgcGVlciBzeW5jaHJvbml6ZWQuXG4gICAgcmV0dXJuIHRoaXMuX3BlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpO1xuICB9XG4gIGdldCBib3RoU2lkZXNDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgcmVzb2x2ZXMgdHJ1dGh5IHdoZW4gYm90aCBzaWRlcyBhcmUgZG9uZS5cbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24udGhlbigoKSA9PiB0aGlzLnBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24pO1xuICB9XG4gIGFzeW5jIHJlcG9ydENvbm5lY3Rpb24oKSB7IC8vIExvZyBjb25uZWN0aW9uIHRpbWUgYW5kIHR5cGUuXG4gICAgY29uc3Qgc3RhdHMgPSBhd2FpdCB0aGlzLmNvbm5lY3Rpb24ucGVlci5nZXRTdGF0cygpO1xuICAgIGxldCB0cmFuc3BvcnQ7XG4gICAgZm9yIChjb25zdCByZXBvcnQgb2Ygc3RhdHMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChyZXBvcnQudHlwZSA9PT0gJ3RyYW5zcG9ydCcpIHtcblx0dHJhbnNwb3J0ID0gcmVwb3J0O1xuXHRicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgbGV0IGNhbmRpZGF0ZVBhaXIgPSB0cmFuc3BvcnQgJiYgc3RhdHMuZ2V0KHRyYW5zcG9ydC5zZWxlY3RlZENhbmRpZGF0ZVBhaXJJZCk7XG4gICAgaWYgKCFjYW5kaWRhdGVQYWlyKSB7IC8vIFNhZmFyaSBkb2Vzbid0IGZvbGxvdyB0aGUgc3RhbmRhcmQuXG4gICAgICBmb3IgKGNvbnN0IHJlcG9ydCBvZiBzdGF0cy52YWx1ZXMoKSkge1xuXHRpZiAoKHJlcG9ydC50eXBlID09PSAnY2FuZGlkYXRlLXBhaXInKSAmJiByZXBvcnQuc2VsZWN0ZWQpIHtcblx0ICBjYW5kaWRhdGVQYWlyID0gcmVwb3J0O1xuXHQgIGJyZWFrO1xuXHR9XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghY2FuZGlkYXRlUGFpcikge1xuICAgICAgY29uc29sZS53YXJuKHRoaXMubGFiZWwsICdnb3Qgc3RhdHMgd2l0aG91dCBjYW5kaWRhdGVQYWlyJywgQXJyYXkuZnJvbShzdGF0cy52YWx1ZXMoKSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZW1vdGUgPSBzdGF0cy5nZXQoY2FuZGlkYXRlUGFpci5yZW1vdGVDYW5kaWRhdGVJZCk7XG4gICAgY29uc3Qge3Byb3RvY29sLCBjYW5kaWRhdGVUeXBlfSA9IHJlbW90ZTtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge3N0YXRzLCB0cmFuc3BvcnQsIGNhbmRpZGF0ZVBhaXIsIHJlbW90ZSwgcHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGUsIHN5bmNocm9uaXphdGlvblN0YXJ0VGltZTogbm93fSk7XG4gICAgY29uc29sZS5pbmZvKHRoaXMubGFiZWwsICdjb25uZWN0ZWQnLCBwcm90b2NvbCwgY2FuZGlkYXRlVHlwZSwgKChub3cgLSB0aGlzLmNvbm5lY3Rpb25TdGFydFRpbWUpLzFlMykudG9GaXhlZCgxKSk7XG4gIH1cbiAgYXN5bmMgc3RhcnRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFdhaXQgZm9yIGFsbCBwcmVsaW1pbmFyaWVzLCBhbmQgc3RhcnQgc3RyZWFtaW5nIG91ciB0YWdzLlxuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgaWYgKCFkYXRhQ2hhbm5lbCkgdGhyb3cgbmV3IEVycm9yKGBObyBjb25uZWN0aW9uIGZvciAke3RoaXMubGFiZWx9LmApO1xuICAgIC8vIE5vdyB0aGF0IHdlIGFyZSBjb25uZWN0ZWQsIGFueSBuZXcgd3JpdGVzIG9uIG91ciBlbmQgd2lsbCBiZSBwdXNoZWQgdG8gdGhlIHBlZXIuIFNvIGNhcHR1cmUgdGhlIGluaXRpYWwgdGFncyBub3cuXG4gICAgY29uc3Qgb3VyVGFncyA9IG5ldyBTZXQoYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnRhZ3MpO1xuICAgIGF3YWl0IHRoaXMucmVwb3J0Q29ubmVjdGlvbigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge1xuXG4gICAgICAvLyBBIHNuYXBzaG90IFNldCBvZiBlYWNoIHRhZyB3ZSBoYXZlIGxvY2FsbHksIGNhcHR1cmVkIGF0IHRoZSBtb21lbnQgb2YgY3JlYXRpb24uXG4gICAgICBvdXJUYWdzLCAvLyAoTmV3IGxvY2FsIHdyaXRlcyBhcmUgcHVzaGVkIHRvIHRoZSBjb25uZWN0ZWQgcGVlciwgZXZlbiBkdXJpbmcgc3luY2hyb25pemF0aW9uLilcblxuICAgICAgLy8gTWFwIG9mIHRhZyB0byBwcm9taXNlIGZvciB0YWdzIHRoYXQgYXJlIGJlaW5nIHN5bmNocm9uaXplZC5cbiAgICAgIC8vIGVuc3VyZVN5bmNocm9uaXplZFRhZyBlbnN1cmVzIHRoYXQgdGhlcmUgaXMgYW4gZW50cnkgaGVyZSBkdXJpbmcgdGhlIHRpbWUgYSB0YWcgaXMgaW4gZmxpZ2h0LlxuICAgICAgdW5zeW5jaHJvbml6ZWQ6IG5ldyBNYXAoKSxcblxuICAgICAgLy8gU2V0IG9mIHdoYXQgdGFncyBoYXZlIGJlZW4gZXhwbGljaXRseSBzeW5jaHJvbml6ZWQsIG1lYW5pbmcgdGhhdCB0aGVyZSBpcyBhIGRpZmZlcmVuY2UgYmV0d2VlbiB0aGVpciBoYXNoXG4gICAgICAvLyBhbmQgb3Vycywgc3VjaCB0aGF0IHdlIGFzayBmb3IgdGhlaXIgc2lnbmF0dXJlIHRvIGNvbXBhcmUgaW4gZGV0YWlsLiBUaHVzIHRoaXMgc2V0IG1heSBpbmNsdWRlIGl0ZW1zIHRoYXRcbiAgICAgIGNoZWNrZWRUYWdzOiBuZXcgU2V0KCksIC8vIHdpbGwgbm90IGVuZCB1cCBiZWluZyByZXBsYWNlZCBvbiBvdXIgZW5kLlxuXG4gICAgICBlbmRPZlBlZXJUYWdzOiBmYWxzZSAvLyBJcyB0aGUgcGVlciBmaW5pc2hlZCBzdHJlYW1pbmc/XG4gICAgfSk7XG4gICAgLy8gTm93IG5lZ290aWF0ZSB2ZXJzaW9uIGFuZCBjb2xsZWN0cyB0aGUgdGFncy5cbiAgICBjb25zdCB2ZXJzaW9uID0gYXdhaXQgdGhpcy52ZXJzaW9uO1xuICAgIGNvbnN0IHttaW5WZXJzaW9uLCBtYXhWZXJzaW9ufSA9IHRoaXM7XG4gICAgaWYgKCF2ZXJzaW9uKSB7XG4gICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3QoKTtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBgVGhpcyBzb2Z0d2FyZSBleHBlY3RzIGRhdGEgdmVyc2lvbnMgZnJvbSAke21pblZlcnNpb259IHRvICR7bWF4VmVyc2lvbn0uYDtcbiAgICAgIGlmICh0eXBlb2Yod2luZG93KSA9PT0gJ3VuZGVmaW5lZCcpIHtcblx0Y29uc29sZS5lcnJvcihtZXNzYWdlKTtcbiAgICAgIH0gZWxzZSBpZiAodGhpcy5jb25zdHJ1Y3Rvci5yZXBvcnRlZFZlcnNpb25GYWlsKSB7XG5cdGNvbnNvbGUubG9nKCdyZXBlYXQgdmVyc2lvbiBmYWlsJyk7XG4gICAgICB9IGVsc2UgeyAvLyBJZiB3ZSdyZSBpbiBhIGJyb3dzZXIsIGtpbGwgZXZlcnl0aGluZy5cblx0dGhpcy5jb25zdHJ1Y3Rvci5yZXBvcnRlZFZlcnNpb25GYWlsID0gdHJ1ZTtcblx0Y29uc29sZS5sb2coe3ZlcnNpb24sIG1pblZlcnNpb24sIG1heFZlcnNpb24sIGNhY2hlczogYXdhaXQgd2luZG93LmNhY2hlcy5rZXlzKCksIHJlZ2lzdHJhdGlvbnM6IGF3YWl0IG5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLmdldFJlZ2lzdHJhdGlvbnMoKSwgZGJzOiBhd2FpdCB3aW5kb3cuaW5kZXhlZERCLmRhdGFiYXNlcygpLCBsb2NhbDogd2luZG93LmxvY2FsU3RvcmFnZS5sZW5ndGh9KTtcblx0Zm9yIChsZXQgbmFtZSBvZiBhd2FpdCB3aW5kb3cuY2FjaGVzLmtleXMoKSkgeyBjb25zb2xlLmxvZyhuYW1lKTsgYXdhaXQgd2luZG93LmNhY2hlcy5kZWxldGUobmFtZSk7IH1cblx0Zm9yIChsZXQgcmVnaXN0cmF0aW9uIG9mIGF3YWl0IG5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLmdldFJlZ2lzdHJhdGlvbnMoKSkge2NvbnNvbGUubG9nKCdraWxsJywgcmVnaXN0cmF0aW9uKTsgYXdhaXQgcmVnaXN0cmF0aW9uLnVucmVnaXN0ZXIoKTsgfVxuXHQvLyBGb3Igbm93LCBnZXQgcmlkIG9mIHN0dWZmIHdlIHVzZWQgdG8gdXNlLlxuXHRmb3IgKGxldCBkYiBvZiBhd2FpdCB3aW5kb3cuaW5kZXhlZERCLmRhdGFiYXNlcygpKSB7IGNvbnNvbGUubG9nKCdraWxsJywgZGIubmFtZSk7IGF3YWl0IHdpbmRvdy5pbmRleGVkREIuZGVsZXRlRGF0YWJhc2UoZGIubmFtZSk7IH1cblx0d2luZG93LmxvY2FsU3RvcmFnZS5jbGVhcigpO1xuXHRjb25zb2xlLmxvZygnbm93Jywge2NhY2hlczogYXdhaXQgd2luZG93LmNhY2hlcy5rZXlzKCksIHJlZ2lzdHJhdGlvbnM6IGF3YWl0IG5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLmdldFJlZ2lzdHJhdGlvbnMoKSwgZGJzOiBhd2FpdCB3aW5kb3cuaW5kZXhlZERCLmRhdGFiYXNlcygpLCBsb2NhbDogd2luZG93LmxvY2FsU3RvcmFnZS5sZW5ndGh9KTtcblx0d2luZG93LmFsZXJ0KG1lc3NhZ2UgKyAnIFRyeSByZWxvYWRpbmcgdHdpY2UuJyk7XG5cdHdpbmRvdy5sb2NhdGlvbi5yZWxvYWQoKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5zdHJlYW1UYWdzKG91clRhZ3MpOyAvLyBCdXQgZG8gbm90IHdhaXQgZm9yIGl0LlxuICB9XG4gIGFzeW5jIGNvbXB1dGVIYXNoKHRleHQpIHsgLy8gT3VyIHN0YW5kYXJkIGhhc2guIChTdHJpbmcgc28gdGhhdCBpdCBpcyBzZXJpYWxpemFibGUuKVxuICAgIGNvbnN0IGhhc2ggPSBhd2FpdCBDcmVkZW50aWFscy5oYXNoVGV4dCh0ZXh0KTtcbiAgICByZXR1cm4gQ3JlZGVudGlhbHMuZW5jb2RlQmFzZTY0dXJsKGhhc2gpO1xuICB9XG4gIGFzeW5jIGdldEhhc2godGFnKSB7IC8vIFdob2xlIHNpZ25hdHVyZSAoTk9UIHByb3RlY3RlZEhlYWRlci5zdWIgb2YgY29udGVudCkuXG4gICAgY29uc3QgcmF3ID0gYXdhaXQgdGhpcy5jb2xsZWN0aW9uLmdldCh0YWcpO1xuICAgIHJldHVybiB0aGlzLmNvbXB1dGVIYXNoKHJhdyB8fCAnbWlzc2luZycpO1xuICB9XG4gIGFzeW5jIHN0cmVhbVRhZ3ModGFncykgeyAvLyBTZW5kIGVhY2ggb2Ygb3VyIGtub3duIHRhZy9oYXNoIHBhaXJzIHRvIHBlZXIsIG9uZSBhdCBhIHRpbWUsIGZvbGxvd2VkIGJ5IGVuZE9mVGFncy5cbiAgICBmb3IgKGNvbnN0IHRhZyBvZiB0YWdzKSB7XG4gICAgICB0aGlzLnNlbmQoJ2hhc2gnLCB0YWcsIGF3YWl0IHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgICB9XG4gICAgdGhpcy5zZW5kKCdlbmRUYWdzJyk7XG4gIH1cbiAgYXN5bmMgZW5kVGFncygpIHsgLy8gVGhlIHBlZXIgaGFzIGZpbmlzaGVkIHN0cmVhbVRhZ3MoKS5cbiAgICBhd2FpdCB0aGlzLnN0YXJ0ZWRTeW5jaHJvbml6YXRpb247XG4gICAgdGhpcy5lbmRPZlBlZXJUYWdzID0gdHJ1ZTtcbiAgICB0aGlzLmNsZWFuVXBJZkZpbmlzaGVkKCk7XG4gIH1cbiAgc3luY2hyb25pemF0aW9uQ29tcGxldGUobkNoZWNrZWQpIHsgLy8gVGhlIHBlZXIgaGFzIGZpbmlzaGVkIGdldHRpbmcgYWxsIHRoZSBkYXRhIGl0IG5lZWRzIGZyb20gdXMuXG4gICAgdGhpcy5wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uLnJlc29sdmUobkNoZWNrZWQpO1xuICB9XG4gIGNsZWFuVXBJZkZpbmlzaGVkKCkgeyAvLyBJZiB3ZSBhcmUgbm90IHdhaXRpbmcgZm9yIGFueXRoaW5nLCB3ZSdyZSBkb25lLiBDbGVhbiB1cC5cbiAgICAvLyBUaGlzIHJlcXVpcmVzIHRoYXQgdGhlIHBlZXIgaGFzIGluZGljYXRlZCB0aGF0IGl0IGlzIGZpbmlzaGVkIHN0cmVhbWluZyB0YWdzLFxuICAgIC8vIGFuZCB0aGF0IHdlIGFyZSBub3Qgd2FpdGluZyBmb3IgYW55IGZ1cnRoZXIgdW5zeW5jaHJvbml6ZWQgaXRlbXMuXG4gICAgaWYgKCF0aGlzLmVuZE9mUGVlclRhZ3MgfHwgdGhpcy51bnN5bmNocm9uaXplZC5zaXplKSByZXR1cm47XG4gICAgY29uc3QgbkNoZWNrZWQgPSB0aGlzLmNoZWNrZWRUYWdzLnNpemU7IC8vIFRoZSBudW1iZXIgdGhhdCB3ZSBjaGVja2VkLlxuICAgIHRoaXMuc2VuZCgnc3luY2hyb25pemF0aW9uQ29tcGxldGUnLCBuQ2hlY2tlZCk7XG4gICAgdGhpcy5jaGVja2VkVGFncy5jbGVhcigpO1xuICAgIHRoaXMudW5zeW5jaHJvbml6ZWQuY2xlYXIoKTtcbiAgICB0aGlzLm91clRhZ3MgPSB0aGlzLnN5bmNocm9uaXplZCA9IHRoaXMudW5zeW5jaHJvbml6ZWQgPSBudWxsO1xuICAgIGNvbnNvbGUuaW5mbyh0aGlzLmxhYmVsLCAnY29tcGxldGVkIHN5bmNocm9uaXphdGlvbicsIG5DaGVja2VkLCAnaXRlbXMgaW4nLCAoKERhdGUubm93KCkgLSB0aGlzLnN5bmNocm9uaXphdGlvblN0YXJ0VGltZSkvMWUzKS50b0ZpeGVkKDEpLCAnc2Vjb25kcycpO1xuICAgIHRoaXMuY29tcGxldGVkU3luY2hyb25pemF0aW9uLnJlc29sdmUobkNoZWNrZWQpO1xuICB9XG4gIHN5bmNocm9uaXphdGlvblByb21pc2UodGFnKSB7IC8vIFJldHVybiBzb21ldGhpbmcgdG8gYXdhaXQgdGhhdCByZXNvbHZlcyB3aGVuIHRhZyBpcyBzeW5jaHJvbml6ZWQuXG4gICAgLy8gV2hlbmV2ZXIgYSBjb2xsZWN0aW9uIG5lZWRzIHRvIHJldHJpZXZlIChnZXRWZXJpZmllZCkgYSB0YWcgb3IgZmluZCB0YWdzIG1hdGNoaW5nIHByb3BlcnRpZXMsIGl0IGVuc3VyZXNcbiAgICAvLyB0aGUgbGF0ZXN0IGRhdGEgYnkgY2FsbGluZyB0aGlzIGFuZCBhd2FpdGluZyB0aGUgZGF0YS5cbiAgICBpZiAoIXRoaXMudW5zeW5jaHJvbml6ZWQpIHJldHVybiB0cnVlOyAvLyBXZSBhcmUgZnVsbHkgc3luY2hyb25pemVkIGFsbCB0YWdzLiBJZiB0aGVyZSBpcyBuZXcgZGF0YSwgaXQgd2lsbCBiZSBzcG9udGFuZW91c2x5IHB1c2hlZCB0byB1cy5cbiAgICBpZiAodGhpcy5jaGVja2VkVGFncy5oYXModGFnKSkgcmV0dXJuIHRydWU7IC8vIFRoaXMgcGFydGljdWxhciB0YWcgaGFzIGJlZW4gY2hlY2tlZC5cbiAgICAgIC8vIChJZiBjaGVja2VkVGFncyB3YXMgb25seSB0aG9zZSBleGNoYW5nZWQgb3Igd3JpdHRlbiwgd2Ugd291bGQgaGF2ZSBleHRyYSBmbGlnaHRzIGNoZWNraW5nLilcbiAgICAvLyBJZiBhIHJlcXVlc3QgaXMgaW4gZmxpZ2h0LCByZXR1cm4gdGhhdCBwcm9taXNlLiBPdGhlcndpc2UgY3JlYXRlIG9uZS5cbiAgICByZXR1cm4gdGhpcy51bnN5bmNocm9uaXplZC5nZXQodGFnKSB8fCB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsICcnLCB0aGlzLmdldEhhc2godGFnKSk7XG4gIH1cblxuICBhc3luYyBoYXNoKHRhZywgaGFzaCkgeyAvLyBSZWNlaXZlIGEgW3RhZywgaGFzaF0gdGhhdCB0aGUgcGVlciBrbm93cyBhYm91dC4gKFBlZXIgc3RyZWFtcyB6ZXJvIG9yIG1vcmUgb2YgdGhlc2UgdG8gdXMuKVxuICAgIC8vIFVubGVzcyBhbHJlYWR5IGluIGZsaWdodCwgd2Ugd2lsbCBlbnN1cmVTeW5jaHJvbml6ZWRUYWcgdG8gc3luY2hyb25pemUgaXQuXG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIGNvbnN0IHtvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0gPSB0aGlzO1xuICAgIHRoaXMubG9nKCdyZWNlaXZlZCBcImhhc2hcIicsIHt0YWcsIGhhc2gsIG91clRhZ3MsIHVuc3luY2hyb25pemVkfSk7XG4gICAgaWYgKHVuc3luY2hyb25pemVkLmhhcyh0YWcpKSByZXR1cm4gbnVsbDsgLy8gQWxyZWFkeSBoYXMgYW4gaW52ZXN0aWdhdGlvbiBpbiBwcm9ncmVzcyAoZS5nLCBkdWUgdG8gbG9jYWwgYXBwIHN5bmNocm9uaXphdGlvblByb21pc2UpLlxuICAgIGlmICghb3VyVGFncy5oYXModGFnKSkgcmV0dXJuIHRoaXMuZW5zdXJlU3luY2hyb25pemVkVGFnKHRhZywgaGFzaCk7IC8vIFdlIGRvbid0IGhhdmUgdGhlIHJlY29yZCBhdCBhbGwuXG4gICAgcmV0dXJuIHRoaXMuZW5zdXJlU3luY2hyb25pemVkVGFnKHRhZywgaGFzaCwgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG4gIGVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIHRoZWlySGFzaCA9ICcnLCBvdXJIYXNoUHJvbWlzZSA9IG51bGwpIHtcbiAgICAvLyBTeW5jaHJvbm91c2x5IHJlY29yZCAoaW4gdGhlIHVuc3luY2hyb25pemVkIG1hcCkgYSBwcm9taXNlIHRvIChjb25jZXB0dWFsbHkpIHJlcXVlc3QgdGhlIHRhZyBmcm9tIHRoZSBwZWVyLFxuICAgIC8vIHB1dCBpdCBpbiB0aGUgY29sbGVjdGlvbiwgYW5kIGNsZWFudXAgdGhlIGJvb2trZWVwaW5nLiBSZXR1cm4gdGhhdCBwcm9taXNlLlxuICAgIC8vIEhvd2V2ZXIsIGlmIHdlIGFyZSBnaXZlbiBoYXNoZXMgdG8gY29tcGFyZSBhbmQgdGhleSBtYXRjaCwgd2UgY2FuIHNraXAgdGhlIHJlcXVlc3QvcHV0IGFuZCByZW1vdmUgZnJvbSB1bnN5Y2hyb25pemVkIG9uIG5leHQgdGljay5cbiAgICAvLyAoVGhpcyBtdXN0IHJldHVybiBhdG9taWNhbGx5IGJlY2F1c2UgY2FsbGVyIGhhcyBjaGVja2VkIHZhcmlvdXMgYm9va2tlZXBpbmcgYXQgdGhhdCBtb21lbnQuIENoZWNraW5nIG1heSByZXF1aXJlIHRoYXQgd2UgYXdhaXQgb3VySGFzaFByb21pc2UuKVxuICAgIGNvbnN0IHByb21pc2UgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHNldFRpbWVvdXQoYXN5bmMgKCkgPT4geyAvLyBOZXh0IHRpY2suIFNlZSByZXF1ZXN0KCkuXG5cdGlmICghdGhlaXJIYXNoIHx8ICFvdXJIYXNoUHJvbWlzZSB8fCAodGhlaXJIYXNoICE9PSBhd2FpdCBvdXJIYXNoUHJvbWlzZSkpIHtcblx0ICBjb25zdCB0aGVpckRhdGEgPSBhd2FpdCB0aGlzLnJlcXVlc3QodGFnKTtcblx0ICAvLyBNaWdodCBoYXZlIGJlZW4gdHJpZ2dlcmVkIGJ5IG91ciBhcHAgcmVxdWVzdGluZyB0aGlzIHRhZyBiZWZvcmUgd2Ugd2VyZSBzeW5jJ2QuIFNvIHRoZXkgbWlnaHQgbm90IGhhdmUgdGhlIGRhdGEuXG5cdCAgaWYgKCF0aGVpckhhc2ggfHwgdGhlaXJEYXRhPy5sZW5ndGgpIHtcblx0ICAgIGlmIChhd2FpdCB0aGlzLmNvbGxlY3Rpb24ucHV0KHRhZywgdGhlaXJEYXRhLCB0aGlzKSkge1xuXHQgICAgICB0aGlzLmxvZygncmVjZWl2ZWQvcHV0JywgdGFnLCAndGhlaXIvb3VyIGhhc2g6JywgdGhlaXJIYXNoIHx8ICdtaXNzaW5nVGhlaXJzJywgKGF3YWl0IG91ckhhc2hQcm9taXNlKSB8fCAnbWlzc2luZ091cnMnLCB0aGVpckRhdGE/Lmxlbmd0aCk7XG5cdCAgICB9IGVsc2Uge1xuXHQgICAgICB0aGlzLmxvZygndW5hYmxlIHRvIHB1dCcsIHRhZyk7XG5cdCAgICB9XG5cdCAgfVxuXHR9XG5cdHRoaXMuY2hlY2tlZFRhZ3MuYWRkKHRhZyk7ICAgICAgIC8vIEV2ZXJ5dGhpbmcgd2UndmUgZXhhbWluZWQsIHJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB3ZSBhc2tlZCBmb3Igb3Igc2F2ZWQgZGF0YSBmcm9tIHBlZXIuIChTZWUgc3luY2hyb25pemF0aW9uUHJvbWlzZSlcblx0dGhpcy51bnN5bmNocm9uaXplZC5kZWxldGUodGFnKTsgLy8gVW5jb25kaXRpb25hbGx5LCBiZWNhdXNlIHdlIHNldCBpdCB1bmNvbmRpdGlvbmFsbHkuXG5cdHRoaXMuY2xlYW5VcElmRmluaXNoZWQoKTtcblx0cmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gICAgdGhpcy51bnN5bmNocm9uaXplZC5zZXQodGFnLCBwcm9taXNlKTsgLy8gVW5jb25kaXRpb25hbGx5LCBpbiBjYXNlIHdlIG5lZWQgdG8ga25vdyB3ZSdyZSBsb29raW5nIGR1cmluZyB0aGUgdGltZSB3ZSdyZSBsb29raW5nLlxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIHJlcXVlc3QodGFnKSB7IC8vIE1ha2UgYSByZXF1ZXN0IGZvciB0YWcgZnJvbSB0aGUgcGVlciwgYW5kIGFuc3dlciBhIHByb21pc2UgdGhlIHJlc29sdmVzIHdpdGggdGhlIGRhdGEuXG4gICAgLypjb25zdCB7IGhvc3RSZXF1ZXN0QmFzZSB9ID0gdGhpcztcbiAgICBpZiAoaG9zdFJlcXVlc3RCYXNlKSB7XG4gICAgICAvLyBFLmcuLCBhIGxvY2FsaG9zdCByb3V0ZXIgbWlnaHQgc3VwcG9ydCBhIGdldCBvZiBodHRwOi8vbG9jYWxob3N0OjMwMDAvZmxleHN0b3JlL011dGFibGVDb2xsZWN0aW9uL2NvbS5raTFyMHkud2hhdGV2ZXIvX3QvdUwvQkFjV19MTkFKYS9jSldtdW1ibGVcbiAgICAgIC8vIFNvIGhvc3RSZXF1ZXN0QmFzZSBzaG91bGQgYmUgXCJodHRwOi8vbG9jYWxob3N0OjMwMDAvZmxleHN0b3JlL011dGFibGVDb2xsZWN0aW9uL2NvbS5raTFyMHkud2hhdGV2ZXJcIixcbiAgICAgIC8vIGFuZCBzZXJ2aWNlTmFtZSBzaG91bGQgYmUgc29tZXRoaW5nIGxpa2UgXCJodHRwOi8vbG9jYWxob3N0OjMwMDAvZmxleHN0b3JlL3N5bmNcIlxuICAgICAgcmV0dXJuIGZldGNoKHRhZ1BhdGgoaG9zdFJlcXVlc3RCYXNlLCB0YWcpKS50aGVuKHJlc3BvbnNlID0+IHJlc3BvbnNlLnRleHQoKSk7XG4gICAgfSovXG4gICAgY29uc3QgcHJvbWlzZSA9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSh0aGlzLnNlbmQoJ2dldCcsIHRhZykpO1xuICAgIC8vIFN1YnRsZTogV2hlbiB0aGUgJ3B1dCcgY29tZXMgYmFjaywgd2Ugd2lsbCBuZWVkIHRvIHJlc29sdmUgdGhpcyBwcm9taXNlLiBCdXQgaG93IHdpbGwgJ3B1dCcgZmluZCB0aGUgcHJvbWlzZSB0byByZXNvbHZlIGl0P1xuICAgIC8vIEFzIGl0IHR1cm5zIG91dCwgdG8gZ2V0IGhlcmUsIHdlIGhhdmUgbmVjZXNzYXJpbGx5IHNldCB0YWcgaW4gdGhlIHVuc3luY2hyb25pemVkIG1hcC4gXG4gICAgY29uc3Qgbm90ZWQgPSB0aGlzLnVuc3luY2hyb25pemVkLmdldCh0YWcpOyAvLyBBIHByb21pc2UgdGhhdCBkb2VzIG5vdCBoYXZlIGFuIGV4cG9zZWQgLnJlc29sdmUsIGFuZCB3aGljaCBkb2VzIG5vdCBleHBlY3QgYW55IHZhbHVlLlxuICAgIG5vdGVkLnJlc29sdmUgPSBwcm9taXNlLnJlc29sdmU7IC8vIFRhY2sgb24gYSByZXNvbHZlIGZvciBPVVIgcHJvbWlzZSBvbnRvIHRoZSBub3RlZCBvYmplY3QgKHdoaWNoIGNvbmZ1c2luZ2x5LCBoYXBwZW5zIHRvIGJlIGEgcHJvbWlzZSkuXG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgYXN5bmMgZ2V0KHRhZykgeyAvLyBSZXNwb25kIHRvIGEgcGVlcidzIGdldCgpIHJlcXVlc3QgYnkgc2VuZGluZyBhIHB1dCByZXBvbnNlIHdpdGggdGhlIGRhdGEuXG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IHRoaXMuY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgICB0aGlzLnB1c2goJ3B1dCcsIHRhZywgZGF0YSk7XG4gIH1cbiAgcHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKSB7IC8vIFRlbGwgdGhlIG90aGVyIHNpZGUgYWJvdXQgYSBzaWduZWQgd3JpdGUuXG4gICAgdGhpcy5zZW5kKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpO1xuICB9XG4gIGFzeW5jIHB1dCh0YWcsIHNpZ25hdHVyZSkgeyAvLyBSZWNlaXZlIGEgcHV0IG1lc3NhZ2UgZnJvbSB0aGUgcGVlci5cbiAgICAvLyBJZiBpdCBpcyBhIHJlc3BvbnNlIHRvIGEgZ2V0KCkgcmVxdWVzdCwgcmVzb2x2ZSB0aGUgY29ycmVzcG9uZGluZyBwcm9taXNlLlxuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLnVuc3luY2hyb25pemVkPy5nZXQodGFnKTtcbiAgICAvLyBSZWdhcmRsZXNzIG9mIHdoeSB0aGUgb3RoZXIgc2lkZSBpcyBzZW5kaW5nLCBpZiB3ZSBoYXZlIGFuIG91dHN0YW5kaW5nIHJlcXVlc3QsIGNvbXBsZXRlIGl0LlxuICAgIGlmIChwcm9taXNlKSBwcm9taXNlLnJlc29sdmUoc2lnbmF0dXJlKTtcbiAgICBlbHNlIGF3YWl0IHRoaXMuY29sbGVjdGlvbi5wdXQodGFnLCBzaWduYXR1cmUsIHRoaXMpOyAvLyBPdGhlcndpc2UsIGp1c3QgdHJ5IHRvIHdyaXRlIGl0IGxvY2FsbHkuXG4gIH1cbiAgZGVsZXRlKHRhZywgc2lnbmF0dXJlKSB7IC8vIFJlY2VpdmUgYSBkZWxldGUgbWVzc2FnZSBmcm9tIHRoZSBwZWVyLlxuICAgIHRoaXMuY29sbGVjdGlvbi5kZWxldGUodGFnLCBzaWduYXR1cmUsIHRoaXMpO1xuICB9XG59XG5leHBvcnQgZGVmYXVsdCBTeW5jaHJvbml6ZXI7XG4iLCJjbGFzcyBDYWNoZSBleHRlbmRzIE1hcHtjb25zdHJ1Y3RvcihlLHQ9MCl7c3VwZXIoKSx0aGlzLm1heFNpemU9ZSx0aGlzLmRlZmF1bHRUaW1lVG9MaXZlPXQsdGhpcy5fbmV4dFdyaXRlSW5kZXg9MCx0aGlzLl9rZXlMaXN0PUFycmF5KGUpLHRoaXMuX3RpbWVycz1uZXcgTWFwfXNldChlLHQscz10aGlzLmRlZmF1bHRUaW1lVG9MaXZlKXtsZXQgaT10aGlzLl9uZXh0V3JpdGVJbmRleDt0aGlzLmRlbGV0ZSh0aGlzLl9rZXlMaXN0W2ldKSx0aGlzLl9rZXlMaXN0W2ldPWUsdGhpcy5fbmV4dFdyaXRlSW5kZXg9KGkrMSkldGhpcy5tYXhTaXplLHRoaXMuX3RpbWVycy5oYXMoZSkmJmNsZWFyVGltZW91dCh0aGlzLl90aW1lcnMuZ2V0KGUpKSxzdXBlci5zZXQoZSx0KSxzJiZ0aGlzLl90aW1lcnMuc2V0KGUsc2V0VGltZW91dCgoKCk9PnRoaXMuZGVsZXRlKGUpKSxzKSl9ZGVsZXRlKGUpe3JldHVybiB0aGlzLl90aW1lcnMuaGFzKGUpJiZjbGVhclRpbWVvdXQodGhpcy5fdGltZXJzLmdldChlKSksdGhpcy5fdGltZXJzLmRlbGV0ZShlKSxzdXBlci5kZWxldGUoZSl9Y2xlYXIoZT10aGlzLm1heFNpemUpe3RoaXMubWF4U2l6ZT1lLHRoaXMuX2tleUxpc3Q9QXJyYXkoZSksdGhpcy5fbmV4dFdyaXRlSW5kZXg9MCxzdXBlci5jbGVhcigpO2Zvcihjb25zdCBlIG9mIHRoaXMuX3RpbWVycy52YWx1ZXMoKSljbGVhclRpbWVvdXQoZSk7dGhpcy5fdGltZXJzLmNsZWFyKCl9fWNsYXNzIFN0b3JhZ2VCYXNle2NvbnN0cnVjdG9yKHtuYW1lOmUsYmFzZU5hbWU6dD1cIlN0b3JhZ2VcIixtYXhTZXJpYWxpemVyU2l6ZTpzPTFlMyxkZWJ1ZzppPSExfSl7Y29uc3QgYT1gJHt0fS8ke2V9YCxyPW5ldyBDYWNoZShzKTtPYmplY3QuYXNzaWduKHRoaXMse25hbWU6ZSxiYXNlTmFtZTp0LGZ1bGxOYW1lOmEsZGVidWc6aSxzZXJpYWxpemVyOnJ9KX1hc3luYyBsaXN0KCl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKFwiXCIsKChlLHQpPT50aGlzLmxpc3RJbnRlcm5hbCh0LGUpKSl9YXN5bmMgZ2V0KGUpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSx0KT0+dGhpcy5nZXRJbnRlcm5hbCh0LGUpKSl9YXN5bmMgZGVsZXRlKGUpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSx0KT0+dGhpcy5kZWxldGVJbnRlcm5hbCh0LGUpKSl9YXN5bmMgcHV0KGUsdCl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKGUsKChlLHMpPT50aGlzLnB1dEludGVybmFsKHMsdCxlKSkpfWxvZyguLi5lKXt0aGlzLmRlYnVnJiZjb25zb2xlLmxvZyh0aGlzLm5hbWUsLi4uZSl9YXN5bmMgc2VyaWFsaXplKGUsdCl7Y29uc3R7c2VyaWFsaXplcjpzLHJlYWR5Oml9PXRoaXM7bGV0IGE9cy5nZXQoZSl8fGk7cmV0dXJuIGE9YS50aGVuKChhc3luYygpPT50KGF3YWl0IHRoaXMucmVhZHksdGhpcy5wYXRoKGUpKSkpLHMuc2V0KGUsYSksYXdhaXQgYX19Y29uc3R7UmVzcG9uc2U6ZSxVUkw6dH09Z2xvYmFsVGhpcztjbGFzcyBTdG9yYWdlQ2FjaGUgZXh0ZW5kcyBTdG9yYWdlQmFzZXtjb25zdHJ1Y3RvciguLi5lKXtzdXBlciguLi5lKSx0aGlzLnN0cmlwcGVyPW5ldyBSZWdFeHAoYF4vJHt0aGlzLmZ1bGxOYW1lfS9gKSx0aGlzLnJlYWR5PWNhY2hlcy5vcGVuKHRoaXMuZnVsbE5hbWUpfWFzeW5jIGxpc3RJbnRlcm5hbChlLHQpe3JldHVybihhd2FpdCB0LmtleXMoKXx8W10pLm1hcCgoZT0+dGhpcy50YWcoZS51cmwpKSl9YXN5bmMgZ2V0SW50ZXJuYWwoZSx0KXtjb25zdCBzPWF3YWl0IHQubWF0Y2goZSk7cmV0dXJuIHM/Lmpzb24oKX1kZWxldGVJbnRlcm5hbChlLHQpe3JldHVybiB0LmRlbGV0ZShlKX1wdXRJbnRlcm5hbCh0LHMsaSl7cmV0dXJuIGkucHV0KHQsZS5qc29uKHMpKX1wYXRoKGUpe3JldHVybmAvJHt0aGlzLmZ1bGxOYW1lfS8ke2V9YH10YWcoZSl7cmV0dXJuIG5ldyB0KGUpLnBhdGhuYW1lLnJlcGxhY2UodGhpcy5zdHJpcHBlcixcIlwiKX1kZXN0cm95KCl7cmV0dXJuIGNhY2hlcy5kZWxldGUodGhpcy5mdWxsTmFtZSl9fWV4cG9ydHtTdG9yYWdlQ2FjaGUgYXMgU3RvcmFnZUxvY2FsLFN0b3JhZ2VDYWNoZSBhcyBkZWZhdWx0fTtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB7IFN0b3JhZ2VMb2NhbCB9IGZyb20gJ0BraTFyMHkvc3RvcmFnZSc7XG5pbXBvcnQgU3luY2hyb25pemVyIGZyb20gJy4vc3luY2hyb25pemVyLm1qcyc7XG5pbXBvcnQgeyBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24gfSBmcm9tICcuL3ZlcnNpb24ubWpzJztcbmNvbnN0IHsgQ3VzdG9tRXZlbnQsIEV2ZW50VGFyZ2V0LCBUZXh0RGVjb2RlciB9ID0gZ2xvYmFsVGhpcztcblxuZXhwb3J0IGNsYXNzIENvbGxlY3Rpb24gZXh0ZW5kcyBFdmVudFRhcmdldCB7XG5cbiAgY29uc3RydWN0b3Ioe25hbWUsIGxhYmVsID0gbmFtZSwgc2VydmljZXMgPSBbXSwgcHJlc2VydmVEZWxldGlvbnMgPSAhIXNlcnZpY2VzLmxlbmd0aCxcblx0ICAgICAgIHBlcnNpc3RlbmNlQ2xhc3MgPSBTdG9yYWdlTG9jYWwsIGRiVmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uLCBwZXJzaXN0ZW5jZUJhc2UgPSBgJHtzdG9yYWdlTmFtZX1fJHtkYlZlcnNpb259YCxcblx0ICAgICAgIGRlYnVnID0gZmFsc2UsIG11bHRpcGxleCwgLy8gQ2F1c2VzIHN5bmNocm9uaXphdGlvbiB0byByZXVzZSBjb25uZWN0aW9ucyBmb3IgZGlmZmVyZW50IENvbGxlY3Rpb25zIG9uIHRoZSBzYW1lIHNlcnZpY2UuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsfSkge1xuICAgIHN1cGVyKCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7bmFtZSwgbGFiZWwsIHByZXNlcnZlRGVsZXRpb25zLCBwZXJzaXN0ZW5jZUNsYXNzLCBkYlZlcnNpb24sIG11bHRpcGxleCwgZGVidWcsIGNoYW5uZWxOYW1lLCBzZXJ2aWNlTGFiZWwsXG5cdFx0XHQgZnVsbE5hbWU6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtuYW1lfWAsIGZ1bGxMYWJlbDogYCR7dGhpcy5jb25zdHJ1Y3Rvci5uYW1lfS8ke2xhYmVsfWB9KTtcbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTtcbiAgICBjb25zdCBwZXJzaXN0ZW5jZU9wdGlvbnMgPSB7bmFtZTogdGhpcy5mdWxsTGFiZWwsIGJhc2VOYW1lOiBwZXJzaXN0ZW5jZUJhc2UsIGRlYnVnOiBkZWJ1Z307XG4gICAgaWYgKHBlcnNpc3RlbmNlQ2xhc3MudGhlbikgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gcGVyc2lzdGVuY2VDbGFzcy50aGVuKGtpbmQgPT4gbmV3IGtpbmQocGVyc2lzdGVuY2VPcHRpb25zKSk7XG4gICAgZWxzZSB0aGlzLnBlcnNpc3RlbmNlU3RvcmUgPSBuZXcgcGVyc2lzdGVuY2VDbGFzcyhwZXJzaXN0ZW5jZU9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgY2xvc2UoKSB7XG4gICAgYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmRlc3Ryb3koKTtcbiAgfVxuXG4gIHN0YXRpYyBlcnJvcihlcnJvcikgeyAvLyBDYW4gYmUgb3ZlcnJpZGRlbiBieSB0aGUgY2xpZW50XG4gICAgY29uc29sZS5lcnJvcihlcnJvcik7XG4gIH1cbiAgLy8gQ3JlZGVudGlhbHMuc2lnbi8udmVyaWZ5IGNhbiBwcm9kdWNlL2FjY2VwdCBKU09OIE9CSkVDVFMgZm9yIHRoZSBuYW1lZCBcIkpTT04gU2VyaWFsaXphdGlvblwiIGZvcm0uXG4gIC8vIEFzIGl0IGhhcHBlbnMsIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGNhbiBkaXN0aW5ndWlzaCBiZXR3ZWVuIGEgY29tcGFjdCBzZXJpYWxpemF0aW9uIChiYXNlNjQgdGV4dClcbiAgLy8gdnMgYW4gb2JqZWN0LCBidXQgaXQgZG9lcyBub3QgcmVjb2duaXplIGEgU0VSSUFMSVpFRCBvYmplY3QuIEhlcmUgd2UgYm90dGxlbmVjayB0aG9zZSBvcGVyYXRpb25zXG4gIC8vIHN1Y2ggdGhhdCB0aGUgdGhpbmcgdGhhdCBpcyBhY3R1YWxseSBwZXJzaXN0ZWQgYW5kIHN5bmNocm9uaXplZCBpcyBhbHdheXMgYSBzdHJpbmcgLS0gZWl0aGVyIGJhc2U2NFxuICAvLyBjb21wYWN0IG9yIEpTT04gYmVnaW5uaW5nIHdpdGggYSBcIntcIiAod2hpY2ggYXJlIGRpc3Rpbmd1aXNoYWJsZSBiZWNhdXNlIFwie1wiIGlzIG5vdCBhIGJhc2U2NCBjaGFyYWN0ZXIpLlxuICBzdGF0aWMgZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSkgeyAvLyBSZXR1cm4gYSBzaWduYXR1cmUgdGhhdCBpcyBkZWZpbmF0ZWx5IGEgc3RyaW5nLlxuICAgIGlmICh0eXBlb2Yoc2lnbmF0dXJlKSAhPT0gJ3N0cmluZycpIHJldHVybiBKU09OLnN0cmluZ2lmeShzaWduYXR1cmUpO1xuICAgIHJldHVybiBzaWduYXR1cmU7XG4gIH1cbiAgLy8gUmV0dXJuIGEgY29tcGFjdCBvciBcIkpTT05cIiAob2JqZWN0KSBmb3JtIG9mIHNpZ25hdHVyZSAoaW5mbGF0aW5nIGEgc2VyaWFsaXphdGlvbiBvZiB0aGUgbGF0dGVyIGlmIG5lZWRlZCksIGJ1dCBub3QgYSBKU09OIHN0cmluZy5cbiAgc3RhdGljIG1heWJlSW5mbGF0ZShzaWduYXR1cmUpIHtcbiAgICBpZiAoc2lnbmF0dXJlPy5zdGFydHNXaXRoPy4oXCJ7XCIpKSByZXR1cm4gSlNPTi5wYXJzZShzaWduYXR1cmUpO1xuICAgIHJldHVybiBzaWduYXR1cmU7XG4gIH1cbiAgLy8gVGhlIHR5cGUgb2YgSldFIHRoYXQgZ2V0cyBzaWduZWQgKG5vdCB0aGUgY3R5IG9mIHRoZSBKV0UpLiBXZSBhdXRvbWF0aWNhbGx5IHRyeSB0byBkZWNyeXB0IGEgSldTIHBheWxvYWQgb2YgdGhpcyB0eXBlLlxuICBzdGF0aWMgZW5jcnlwdGVkTWltZVR5cGUgPSAndGV4dC9lbmNyeXB0ZWQnO1xuICBzdGF0aWMgYXN5bmMgZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKSB7IC8vIFByb21pc2UgdmVyZmllZCBhZnRlciBmaXJzdCBhdWdtZW50aW5nIHdpdGggZGVjcnlwdGVkIGRhdGEgYXMgbmVlZGVkLlxuICAgIGlmICh2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuY3R5ICE9PSB0aGlzLmVuY3J5cHRlZE1pbWVUeXBlKSByZXR1cm4gdmVyaWZpZWQ7XG4gICAgaWYgKHZlcmlmaWVkLmRlY3J5cHRlZCkgcmV0dXJuIHZlcmlmaWVkOyAvLyBBbHJlYWR5IGRlY3J5cHRlZC5cbiAgICBjb25zdCBkZWNyeXB0ZWQgPSBhd2FpdCBDcmVkZW50aWFscy5kZWNyeXB0KHZlcmlmaWVkLnRleHQpO1xuICAgIHZlcmlmaWVkLmpzb24gPSBkZWNyeXB0ZWQuanNvbjtcbiAgICB2ZXJpZmllZC50ZXh0ID0gZGVjcnlwdGVkLnRleHQ7XG4gICAgdmVyaWZpZWQucGF5bG9hZCA9IGRlY3J5cHRlZC5wYXlsb2FkO1xuICAgIHZlcmlmaWVkLmRlY3J5cHRlZCA9IGRlY3J5cHRlZDtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHNpZ24oZGF0YSwgb3B0aW9ucykge1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IENyZWRlbnRpYWxzLnNpZ24oZGF0YSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIHRoaXMuZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMgPSB7fSkge1xuICAgIHNpZ25hdHVyZSA9IHRoaXMubWF5YmVJbmZsYXRlKHNpZ25hdHVyZSk7XG4gICAgLy8gV2UgZG9uJ3QgZG8gXCJkZWVwXCIgdmVyaWZpY2F0aW9uIGhlcmUgLSBlLmcuLCBjaGVja2luZyB0aGF0IHRoZSBhY3QgaXMgYSBtZW1iZXIgb2YgaXNzLCBhbmQgdGhlIGlhdCBpcyBhZnRlciB0aGUgZXhpc3RpbmcgaWF0LlxuICAgIC8vIEluc3RlYWQsIHdlIGRvIG91ciBvd24gZGVlcCBjaGVja3MgaW4gdmFsaWRhdGVGb3JXcml0aW5nLlxuICAgIC8vIFRoZSBtZW1iZXIvbm90QmVmb3JlIHNob3VsZCBjaGVjayBvdXQgYW55d2F5IC0tIGkuZS4sIHdlIGNvdWxkIGxlYXZlIGl0IGluLCBleGNlcHQgaW4gc3luY2hyb25pemluZ1xuICAgIC8vIENyZWRlbnRpYWwuY29sbGVjdGlvbnMuIFRoZXJlIGlzIG5vIG1lY2hhbmlzbSAoY3VycmVudGx5KSBmb3IgdGhlXG4gICAgLy8gc3luY2hyb25pemF0aW9uIHRvIGhhcHBlbiBpbiBhbiBvcmRlciB0aGF0IHdpbGwgcmVzdWx0IGluIHRoZSBkZXBlbmRlbmNpZXMgY29taW5nIG92ZXIgYmVmb3JlIHRoZSBpdGVtcyB0aGF0IGNvbnN1bWUgdGhlbS5cbiAgICBjb25zdCB2ZXJpZmllZCA9ICBhd2FpdCBDcmVkZW50aWFscy52ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zKTtcbiAgICBpZiAodmVyaWZpZWQpIHZlcmlmaWVkLnNpZ25hdHVyZSA9IHNpZ25hdHVyZTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZlcmlmaWVkU2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucywgdGFnID0gbnVsbCkgeyAvLyBTaWduLCBidXQgcmV0dXJuIGEgdmFsaWRhdGlvbiAoYXMgdGhvdWdoIGJ5IGltbWVkaWF0ZWx5IHZhbGlkYXRpbmcpLlxuICAgIC8vIFRPRE86IGFzc2VtYmxlIHRoaXMgbW9yZSBjaGVhcGx5P1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuc2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgcmV0dXJuIHRoaXMudmFsaWRhdGlvbkZvcm1hdChzaWduYXR1cmUsIHRhZyk7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZhbGlkYXRpb25Gb3JtYXQoc2lnbmF0dXJlLCB0YWcgPSBudWxsKSB7XG4gICAgLy9jb25zb2xlLmxvZyh7dHlwZTogdHlwZW9mKHNpZ25hdHVyZSksIHNpZ25hdHVyZSwgdGFnfSk7XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLnZlcmlmeShzaWduYXR1cmUpO1xuICAgIC8vY29uc29sZS5sb2coe3ZlcmlmaWVkfSk7XG4gICAgY29uc3Qgc3ViID0gdmVyaWZpZWQuc3ViamVjdFRhZyA9IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gICAgdmVyaWZpZWQudGFnID0gdGFnIHx8IHN1YjtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cblxuICBhc3luYyB1bmRlbGV0ZWRUYWdzKCkge1xuICAgIC8vIE91ciBvd24gc2VwYXJhdGUsIG9uLWRlbWFuZCBhY2NvdW50aW5nIG9mIHBlcnNpc3RlbmNlU3RvcmUgbGlzdCgpOlxuICAgIC8vICAgLSBwZXJzaXN0ZW5jZVN0b3JlIGxpc3QoKSBjb3VsZCBwb3RlbnRpYWxseSBiZSBleHBlbnNpdmVcbiAgICAvLyAgIC0gSXQgd2lsbCBjb250YWluIHNvZnQtZGVsZXRlZCBpdGVtIHRvbWJzdG9uZXMgKHNpZ25lZCBlbXB0eSBwYXlsb2FkcykuXG4gICAgLy8gSXQgc3RhcnRzIHdpdGggYSBsaXN0KCkgdG8gZ2V0IGFueXRoaW5nIHBlcnNpc3RlZCBpbiBhIHByZXZpb3VzIHNlc3Npb24sIGFuZCBhZGRzL3JlbW92ZXMgYXMgd2Ugc3RvcmUvcmVtb3ZlLlxuICAgIGNvbnN0IGFsbFRhZ3MgPSBhd2FpdCAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKS5saXN0KCk7XG4gICAgY29uc3QgdGFncyA9IG5ldyBTZXQoKTtcbiAgICBhd2FpdCBQcm9taXNlLmFsbChhbGxUYWdzLm1hcChhc3luYyB0YWcgPT4ge1xuICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIHN5bmNocm9uaXplOiBmYWxzZX0pO1xuICAgICAgaWYgKHZlcmlmaWVkKSB0YWdzLmFkZCh0YWcpO1xuICAgIH0pKTtcbiAgICByZXR1cm4gdGFncztcbiAgfVxuICBnZXQgdGFncygpIHsgLy8gS2VlcHMgdHJhY2sgb2Ygb3VyICh1bmRlbGV0ZWQpIGtleXMuXG4gICAgcmV0dXJuIHRoaXMuX3RhZ3NQcm9taXNlIHx8PSB0aGlzLnVuZGVsZXRlZFRhZ3MoKTtcbiAgfVxuICBhc3luYyBhZGRUYWcodGFnKSB7XG4gICAgKGF3YWl0IHRoaXMudGFncykuYWRkKHRhZyk7XG4gIH1cbiAgYXN5bmMgZGVsZXRlVGFnKHRhZykge1xuICAgIChhd2FpdCB0aGlzLnRhZ3MpLmRlbGV0ZSh0YWcpO1xuICB9XG5cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAoIXRoaXMuZGVidWcpIHJldHVybjtcbiAgICBjb25zb2xlLmxvZyh0aGlzLmZ1bGxMYWJlbCwgLi4ucmVzdCk7XG4gIH1cbiAgX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob2JqZWN0T3JTdHJpbmcgPSB7fSkge1xuICAgIGlmICh0eXBlb2Yob2JqZWN0T3JTdHJpbmcpID09PSAnc3RyaW5nJykgb2JqZWN0T3JTdHJpbmcgPSB7dGFnOiBvYmplY3RPclN0cmluZ307XG4gICAgY29uc3Qge293bmVyOnRlYW0gPSBDcmVkZW50aWFscy5vd25lciwgYXV0aG9yOm1lbWJlciA9IENyZWRlbnRpYWxzLmF1dGhvcixcblx0ICAgdGFnLFxuXHQgICBlbmNyeXB0aW9uID0gQ3JlZGVudGlhbHMuZW5jcnlwdGlvbixcblx0ICAgdGltZSA9IERhdGUubm93KCksXG5cdCAgIC4uLnJlc3R9ID0gb2JqZWN0T3JTdHJpbmc7XG4gICAgLy8gVE9ETzogc3VwcG9ydCBzaW1wbGlmaWVkIHN5bnRheCwgdG9vLCBwZXIgUkVBRE1FXG4gICAgLy8gVE9ETzogc2hvdWxkIHdlIHNwZWNpZnkgc3ViamVjdDogdGFnIGZvciBib3RoIG11dGFibGVzPyAoZ2l2ZXMgaGFzaClcbiAgICBjb25zdCBvcHRpb25zID0gKHRlYW0gJiYgdGVhbSAhPT0gbWVtYmVyKSA/XG5cdCAge3RlYW0sIG1lbWJlciwgdGFnLCBlbmNyeXB0aW9uLCB0aW1lLCAuLi5yZXN0fSA6XG5cdCAge3RhZ3M6IFttZW1iZXJdLCB0YWcsIHRpbWUsIGVuY3J5cHRpb24sIC4uLnJlc3R9OyAvLyBObyBpYXQgaWYgdGltZSBub3QgZXhwbGljaXRseSBnaXZlbi5cbiAgICBpZiAoW3RydWUsICd0ZWFtJywgJ293bmVyJ10uaW5jbHVkZXMob3B0aW9ucy5lbmNyeXB0aW9uKSkgb3B0aW9ucy5lbmNyeXB0aW9uID0gdGVhbTtcbiAgICByZXR1cm4gb3B0aW9ucztcbiAgfVxuICBmYWlsKG9wZXJhdGlvbiwgZGF0YSwgYXV0aG9yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2F1dGhvcn0gZG9lcyBub3QgaGF2ZSB0aGUgYXV0aG9yaXR5IHRvICR7b3BlcmF0aW9ufSAke3RoaXMuZnVsbE5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9LmApO1xuICB9XG4gIGFzeW5jIHN0b3JlKGRhdGEsIG9wdGlvbnMgPSB7fSkge1xuICAgIC8vIGVuY3J5cHQgaWYgbmVlZGVkXG4gICAgLy8gc2lnblxuICAgIC8vIHB1dCA8PT0gQWxzbyB3aGVyZSB3ZSBlbnRlciBpZiBwdXNoZWQgZnJvbSBhIGNvbm5lY3Rpb25cbiAgICAvLyAgICB2YWxpZGF0ZUZvcldyaXRpbmdcbiAgICAvLyAgICAgICBleGl0IGlmIGltcHJvcGVyXG4gICAgLy8gICAgICAgZW1pdCB1cGRhdGUgZXZlbnRcbiAgICAvLyAgICBtZXJnZVNpZ25hdHVyZXNcbiAgICAvLyAgICBwZXJzaXN0IGxvY2FsbHlcbiAgICAvLyBwdXNoIChsaXZlIHRvIGFueSBjb25uZWN0aW9ucyBleGNlcHQgdGhlIG9uZSB3ZSByZWNlaXZlZCBmcm9tKVxuICAgIGxldCB7ZW5jcnlwdGlvbiwgdGFnLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpO1xuICAgIGlmIChlbmNyeXB0aW9uKSB7XG4gICAgICBkYXRhID0gYXdhaXQgQ3JlZGVudGlhbHMuZW5jcnlwdChkYXRhLCBlbmNyeXB0aW9uKTtcbiAgICAgIHNpZ25pbmdPcHRpb25zLmNvbnRlbnRUeXBlID0gdGhpcy5jb25zdHJ1Y3Rvci5lbmNyeXB0ZWRNaW1lVHlwZTtcbiAgICB9XG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb24uXG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zKTtcbiAgICB0YWcgPSBhd2FpdCB0aGlzLnB1dCh0YWcsIHNpZ25hdHVyZSk7XG4gICAgaWYgKCF0YWcpIHJldHVybiB0aGlzLmZhaWwoJ3N0b3JlJywgZGF0YSwgc2lnbmluZ09wdGlvbnMubWVtYmVyIHx8IHNpZ25pbmdPcHRpb25zLnRhZ3NbMF0pO1xuICAgIGF3YWl0IHRoaXMucHVzaCgncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgcHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlLCBleGNsdWRlU3luY2hyb25pemVyID0gbnVsbCkgeyAvLyBQdXNoIHRvIGFsbCBjb25uZWN0ZWQgc3luY2hyb25pemVycywgZXhjbHVkaW5nIHRoZSBzcGVjaWZpZWQgb25lLlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IChleGNsdWRlU3luY2hyb25pemVyICE9PSBzeW5jaHJvbml6ZXIpICYmIHN5bmNocm9uaXplci5wdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpKSk7XG4gIH1cbiAgYXN5bmMgcmVtb3ZlKG9wdGlvbnMgPSB7fSkgeyAvLyBOb3RlOiBSZWFsbHkganVzdCByZXBsYWNpbmcgd2l0aCBlbXB0eSBkYXRhIGZvcmV2ZXIuIE90aGVyd2lzZSBtZXJnaW5nIHdpdGggZWFybGllciBkYXRhIHdpbGwgYnJpbmcgaXQgYmFjayFcbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTtcbiAgICBjb25zdCBkYXRhID0gJyc7XG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb25cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHRhZyA9IGF3YWl0IHRoaXMuZGVsZXRlKHRhZywgc2lnbmF0dXJlKTtcbiAgICBpZiAoIXRhZykgcmV0dXJuIHRoaXMuZmFpbCgnc3RvcmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gZ2V0VmVyaWZpZWQgYW5kIG1heWJlIGRlY3J5cHQuIEhhcyBtb3JlIGNvbXBsZXggYmVoYXZpb3IgaW4gc3ViY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbi5cbiAgICBjb25zdCB7dGFnLCBkZWNyeXB0ID0gdHJ1ZSwgLi4ub3B0aW9uc30gPSB0YWdPck9wdGlvbnMudGFnID8gdGFnT3JPcHRpb25zIDoge3RhZzogdGFnT3JPcHRpb25zfTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZywgLi4ub3B0aW9uc30pO1xuICAgIGlmICghdmVyaWZpZWQpIHJldHVybiAnJztcbiAgICBpZiAoZGVjcnlwdCkgcmV0dXJuIGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgYXN5bmMgZ2V0VmVyaWZpZWQodGFnT3JPcHRpb25zKSB7IC8vIHN5bmNocm9uaXplLCBnZXQsIGFuZCB2ZXJpZnkgKGJ1dCB3aXRob3V0IGRlY3J5cHQpXG4gICAgY29uc3Qge3RhZywgc3luY2hyb25pemUgPSB0cnVlLCAuLi52ZXJpZnlPcHRpb25zfSA9IHRhZ09yT3B0aW9ucy50YWcgPyB0YWdPck9wdGlvbnM6IHt0YWc6IHRhZ09yT3B0aW9uc307XG4gICAgaWYgKHN5bmNocm9uaXplKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplMSh0YWcpO1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuZ2V0KHRhZyk7XG4gICAgaWYgKCFzaWduYXR1cmUpIHJldHVybiBzaWduYXR1cmU7XG4gICAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmVyaWZ5T3B0aW9ucyk7XG4gIH1cbiAgYXN5bmMgbGlzdChza2lwU3luYyA9IGZhbHNlICkgeyAvLyBMaXN0IGFsbCB0YWdzIG9mIHRoaXMgY29sbGVjdGlvbi5cbiAgICBpZiAoIXNraXBTeW5jKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIC8vIFdlIGNhbm5vdCBqdXN0IGxpc3QgdGhlIGtleXMgb2YgdGhlIGNvbGxlY3Rpb24sIGJlY2F1c2UgdGhhdCBpbmNsdWRlcyBlbXB0eSBwYXlsb2FkcyBvZiBpdGVtcyB0aGF0IGhhdmUgYmVlbiBkZWxldGVkLlxuICAgIHJldHVybiBBcnJheS5mcm9tKChhd2FpdCB0aGlzLnRhZ3MpLmtleXMoKSk7XG4gIH1cbiAgYXN5bmMgbWF0Y2godGFnLCBwcm9wZXJ0aWVzKSB7IC8vIElzIHRoaXMgc2lnbmF0dXJlIHdoYXQgd2UgYXJlIGxvb2tpbmcgZm9yP1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5yZXRyaWV2ZSh0YWcpO1xuICAgIGNvbnN0IGRhdGEgPSB2ZXJpZmllZD8uanNvbjtcbiAgICBpZiAoIWRhdGEpIHJldHVybiBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBwcm9wZXJ0aWVzKSB7XG4gICAgICBpZiAoZGF0YVtrZXldICE9PSBwcm9wZXJ0aWVzW2tleV0pIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgYXN5bmMgZmluZExvY2FsKHByb3BlcnRpZXMpIHsgLy8gRmluZCB0aGUgdGFnIGluIG91ciBzdG9yZSB0aGF0IG1hdGNoZXMsIGVsc2UgZmFsc2V5XG4gICAgZm9yIChjb25zdCB0YWcgb2YgYXdhaXQgdGhpcy5saXN0KCduby1zeW5jJykpIHsgLy8gRGlyZWN0IGxpc3QsIHcvbyBzeW5jLlxuICAgICAgaWYgKGF3YWl0IHRoaXMubWF0Y2godGFnLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIHRhZztcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGFzeW5jIGZpbmQocHJvcGVydGllcykgeyAvLyBBbnN3ZXIgdGhlIHRhZyB0aGF0IGhhcyB2YWx1ZXMgbWF0Y2hpbmcgdGhlIHNwZWNpZmllZCBwcm9wZXJ0aWVzLiBPYnZpb3VzbHksIGNhbid0IGJlIGVuY3J5cHRlZCBhcyBhIHdob2xlLlxuICAgIGxldCBmb3VuZCA9IGF3YWl0IHRoaXMuZmluZExvY2FsKHByb3BlcnRpZXMpO1xuICAgIGlmIChmb3VuZCkge1xuICAgICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZTEoZm91bmQpOyAvLyBNYWtlIHN1cmUgdGhlIGRhdGEgaXMgdXAgdG8gZGF0ZS4gVGhlbiBjaGVjayBhZ2Fpbi5cbiAgICAgIGlmIChhd2FpdCB0aGlzLm1hdGNoKGZvdW5kLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIGZvdW5kO1xuICAgIH1cbiAgICAvLyBObyBtYXRjaC5cbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemVEYXRhKCk7XG4gICAgZm91bmQgPSBhd2FpdCB0aGlzLmZpbmRMb2NhbChwcm9wZXJ0aWVzKTtcbiAgICBpZiAoZm91bmQgJiYgYXdhaXQgdGhpcy5tYXRjaChmb3VuZCwgcHJvcGVydGllcykpIHJldHVybiBmb3VuZDtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXF1aXJlVGFnKHRhZykge1xuICAgIGlmICh0YWcpIHJldHVybjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0EgdGFnIGlzIHJlcXVpcmVkLicpO1xuICB9XG5cbiAgLy8gVGhlc2UgdGhyZWUgaWdub3JlIHN5bmNocm9uaXphdGlvbiBzdGF0ZSwgd2hpY2ggaWYgbmVlZWQgaXMgdGhlIHJlc3BvbnNpYmlsaXR5IG9mIHRoZSBjYWxsZXIuXG4gIC8vIEZJWE1FIFRPRE86IGFmdGVyIGluaXRpYWwgZGV2ZWxvcG1lbnQsIHRoZXNlIHRocmVlIHNob3VsZCBiZSBtYWRlIGludGVybmFsIHNvIHRoYXQgYXBwbGljYXRpb24gY29kZSBkb2VzIG5vdCBjYWxsIHRoZW0uXG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gR2V0IHRoZSBsb2NhbCByYXcgc2lnbmF0dXJlIGRhdGEuXG4gICAgdGhpcy5yZXF1aXJlVGFnKHRhZyk7XG4gICAgcmV0dXJuIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmdldCh0YWcpO1xuICB9XG4gIC8vIFRoZXNlIHR3byBjYW4gYmUgdHJpZ2dlcmVkIGJ5IGNsaWVudCBjb2RlIG9yIGJ5IGFueSBzZXJ2aWNlLlxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUsIHN5bmNocm9uaXplciA9IG51bGwsIG1lcmdlQXV0aG9yT3ZlcnJpZGUgPSBudWxsKSB7IC8vIFB1dCB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIC8vIG1lcmdlU2lnbmF0dXJlcygpIE1BWSBjcmVhdGUgbmV3IG5ldyByZXN1bHRzIHRvIHNhdmUsIHRoYXQgc3RpbGwgaGF2ZSB0byBiZSBzaWduZWQuIEZvciB0ZXN0aW5nLCB3ZSBzb21ldGltZXNcbiAgICAvLyB3YW50IHRvIGJlaGF2ZSBhcyBpZiBzb21lIG93bmVyIGNyZWRlbnRpYWwgZG9lcyBub3QgZXhpc3Qgb24gdGhlIG1hY2hpbmUuIFRoYXQncyB3aGF0IG1lcmdlQXV0aG9yT3ZlcnJpZGUgaXMgZm9yLlxuXG4gICAgLy8gVE9ETzogZG8gd2UgbmVlZCB0byBxdWV1ZSB0aGVzZT8gU3VwcG9zZSB3ZSBhcmUgdmFsaWRhdGluZyBvciBtZXJnaW5nIHdoaWxlIG90aGVyIHJlcXVlc3QgYXJyaXZlP1xuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3N0b3JlJywgc3luY2hyb25pemVyKTtcbiAgICB0aGlzLmxvZygncHV0Jywge3RhZzogdmFsaWRhdGlvbj8udGFnIHx8IHRhZywgc3luY2hyb25pemVyOiBzeW5jaHJvbml6ZXI/LmxhYmVsLCBqc29uOiB2YWxpZGF0aW9uPy5qc29ufSk7XG4gICAgaWYgKCF2YWxpZGF0aW9uKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGF3YWl0IHRoaXMuYWRkVGFnKHZhbGlkYXRpb24udGFnKTtcblxuICAgIC8vIGZpeG1lIG5leHRcbiAgICBjb25zdCBtZXJnZWQgPSBhd2FpdCB0aGlzLm1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSwgbWVyZ2VBdXRob3JPdmVycmlkZSk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBtZXJnZWQpO1xuICAgIC8vY29uc3QgbWVyZ2VkMiA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmFsaWRhdGlvbkZvcm1hdChtZXJnZWQsIHRhZyk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIG1lcmdlZCk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QyKG1lcmdlZDIpO1xuICAgIC8vIGNvbnN0IG1lcmdlZCA9IGF3YWl0IHRoaXMubWVyZ2VWYWxpZGF0aW9uKHZhbGlkYXRpb24sIG1lcmdlQXV0aG9yT3ZlcnJpZGUpO1xuICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIobWVyZ2VkKTtcblxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5wdXQuXG4gIH1cbiAgYXN5bmMgZGVsZXRlKHRhZywgc2lnbmF0dXJlLCBzeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFJlbW92ZSB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3JlbW92ZScsIHN5bmNocm9uaXplciwgJ3JlcXVpcmVUYWcnKTtcbiAgICB0aGlzLmxvZygnZGVsZXRlJywgdGFnLCBzeW5jaHJvbml6ZXI/LmxhYmVsLCAndmFsaWRhdGVkIHRhZzonLCB2YWxpZGF0aW9uPy50YWcsICdwcmVzZXJ2ZURlbGV0aW9uczonLCB0aGlzLnByZXNlcnZlRGVsZXRpb25zKTtcbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICBpZiAodGhpcy5wcmVzZXJ2ZURlbGV0aW9ucykgeyAvLyBTaWduYXR1cmUgcGF5bG9hZCBpcyBlbXB0eS5cbiAgICAgIC8vIEZJWE1FIG5leHRcbiAgICAgIC8vYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBzaWduYXR1cmUpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uKTtcbiAgICB9IGVsc2UgeyAvLyBSZWFsbHkgZGVsZXRlLlxuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIHNpZ25hdHVyZSwgJ2RlbGV0ZScpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uLCAnZGVsZXRlJyk7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5kZWxldGUuXG4gIH1cblxuICBub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsIG1lc3NhZ2UgPSB1bmRlZmluZWQsIHZhbGlkYXRlZCA9ICcnLCBzaWduYXR1cmUpIHtcbiAgICAvLyBMYXRlciBvbiwgd2Ugd2lsbCBub3Qgd2FudCB0byBnaXZlIG91dCBzbyBtdWNoIGluZm8uLi5cbiAgICAvL2lmICh0aGlzLmRlYnVnKSB7XG4gICAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSwgdGFnKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy8gIGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgYFNpZ25hdHVyZSBpcyBub3QgdmFsaWQgdG8gJHtvcGVyYXRpb25MYWJlbH0gJHt0YWcgfHwgJ2RhdGEnfS5gKTtcbiAgICAvL31cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIFJldHVybiBhIHJlYXNvbiBzdHJpbmcgd2h5IHRoZSBwcm9wb3NlZCB2ZXJpZmllZCBwcm90ZWN0ZWRIZWFkZXJcbiAgICAvLyBzaG91bGQgbm90IGJlIGFsbG93ZWQgdG8gb3ZlcnJ3cml0ZSB0aGUgKHBvc3NpYmx5IG51bGxpc2gpIGV4aXN0aW5nIHZlcmlmaWVkIHByb3RlY3RlZEhlYWRlcixcbiAgICAvLyBlbHNlIGZhbHN5IGlmIGFsbG93ZWQuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuIG51bGw7XG4gICAgaWYgKHByb3Bvc2VkLmlhdCA8IGV4aXN0aW5nLmlhdCkgcmV0dXJuICdiYWNrZGF0ZWQnO1xuICAgIGlmICghdGhpcy5vd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkpIHJldHVybiAnbm90IG93bmVyJztcbiAgICBpZiAoIWF3YWl0IHRoaXMuc3ViamVjdE1hdGNoKHZlcmlmaWVkKSkgcmV0dXJuICd3cm9uZyBoYXNoJztcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBhc3luYyBzdWJqZWN0TWF0Y2godmVyaWZpZWQpIHsgLy8gUHJvbWlzZXMgdHJ1ZSBJRkYgY2xhaW1lZCAnc3ViJyBtYXRjaGVzIGhhc2ggb2YgdGhlIGNvbnRlbnRzLlxuICAgIHJldHVybiB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViID09PSBhd2FpdCBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoYXdhaXQgQ3JlZGVudGlhbHMuaGFzaEJ1ZmZlcih2ZXJpZmllZC5wYXlsb2FkKSk7XG4gIH1cbiAgb3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpIHsvLyBEb2VzIHByb3Bvc2VkIG93bmVyIG1hdGNoIHRoZSBleGlzdGluZz9cbiAgICBjb25zdCBleGlzdGluZ093bmVyID0gZXhpc3Rpbmc/LmlzcyB8fCBleGlzdGluZz8ua2lkO1xuICAgIGNvbnN0IHByb3Bvc2VkT3duZXIgPSBwcm9wb3NlZC5pc3MgfHwgcHJvcG9zZWQua2lkO1xuICAgIC8vIEV4YWN0IG1hdGNoLiBEbyB3ZSBuZWVkIHRvIGFsbG93IGZvciBhbiBvd25lciB0byB0cmFuc2ZlciBvd25lcnNoaXAgdG8gYSBzdWIvc3VwZXIvZGlzam9pbnQgdGVhbT9cbiAgICAvLyBDdXJyZW50bHksIHRoYXQgd291bGQgcmVxdWlyZSBhIG5ldyByZWNvcmQuIChFLmcuLCB0d28gTXV0YWJsZS9WZXJzaW9uZWRDb2xsZWN0aW9uIGl0ZW1zIHRoYXRcbiAgICAvLyBoYXZlIHRoZSBzYW1lIEdVSUQgcGF5bG9hZCBwcm9wZXJ0eSwgYnV0IGRpZmZlcmVudCB0YWdzLiBJLmUuLCBhIGRpZmZlcmVudCBvd25lciBtZWFucyBhIGRpZmZlcmVudCB0YWcuKVxuICAgIGlmICghcHJvcG9zZWRPd25lciB8fCAoZXhpc3RpbmdPd25lciAmJiAocHJvcG9zZWRPd25lciAhPT0gZXhpc3RpbmdPd25lcikpKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgIC8vIFdlIGFyZSBub3QgY2hlY2tpbmcgdG8gc2VlIGlmIGF1dGhvciBpcyBjdXJyZW50bHkgYSBtZW1iZXIgb2YgdGhlIG93bmVyIHRlYW0gaGVyZSwgd2hpY2hcbiAgICAgIC8vIGlzIGNhbGxlZCBieSBwdXQoKS9kZWxldGUoKSBpbiB0d28gY2lyY3Vtc3RhbmNlczpcblxuICAgICAgLy8gdGhpcy52YWxpZGF0ZUZvcldyaXRpbmcoKSBpcyBjYWxsZWQgYnkgcHV0KCkvZGVsZXRlKCkgd2hpY2ggaGFwcGVucyBpbiB0aGUgYXBwICh2aWEgc3RvcmUoKS9yZW1vdmUoKSlcbiAgICAgIC8vIGFuZCBkdXJpbmcgc3luYyBmcm9tIGFub3RoZXIgc2VydmljZTpcblxuICAgICAgLy8gMS4gRnJvbSB0aGUgYXBwICh2YWlhIHN0b3JlKCkvcmVtb3ZlKCksIHdoZXJlIHdlIGhhdmUganVzdCBjcmVhdGVkIHRoZSBzaWduYXR1cmUuIFNpZ25pbmcgaXRzZWxmXG4gICAgICAvLyB3aWxsIGZhaWwgaWYgdGhlICgxLWhvdXIgY2FjaGVkKSBrZXkgaXMgbm8gbG9uZ2VyIGEgbWVtYmVyIG9mIHRoZSB0ZWFtLiBUaGVyZSBpcyBubyBpbnRlcmZhY2VcbiAgICAgIC8vIGZvciB0aGUgYXBwIHRvIHByb3ZpZGUgYW4gb2xkIHNpZ25hdHVyZS4gKFRPRE86IGFmdGVyIHdlIG1ha2UgZ2V0L3B1dC9kZWxldGUgaW50ZXJuYWwuKVxuXG4gICAgICAvLyAyLiBEdXJpbmcgc3luYyBmcm9tIGFub3RoZXIgc2VydmljZSwgd2hlcmUgd2UgYXJlIHB1bGxpbmcgaW4gb2xkIHJlY29yZHMgZm9yIHdoaWNoIHdlIGRvbid0IGhhdmVcbiAgICAgIC8vIHRlYW0gbWVtYmVyc2hpcCBmcm9tIHRoYXQgdGltZS5cblxuICAgICAgLy8gSWYgdGhlIGFwcCBjYXJlcyB3aGV0aGVyIHRoZSBhdXRob3IgaGFzIGJlZW4ga2lja2VkIGZyb20gdGhlIHRlYW0sIHRoZSBhcHAgaXRzZWxmIHdpbGwgaGF2ZSB0byBjaGVjay5cbiAgICAgIC8vIFRPRE86IHdlIHNob3VsZCBwcm92aWRlIGEgdG9vbCBmb3IgdGhhdC5cblxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGFudGVjZWRlbnQodmVyaWZpZWQpIHsgLy8gV2hhdCB0YWcgc2hvdWxkIHRoZSB2ZXJpZmllZCBzaWduYXR1cmUgYmUgY29tcGFyZWQgYWdhaW5zdCBmb3Igd3JpdGluZz9cbiAgICByZXR1cm4gdmVyaWZpZWQudGFnO1xuICB9XG4gIHN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpIHsgLy8gU2hvdWxkIHRoZSBhbnRlY2VkZW50IHRyeSBzeW5jaHJvbml6aW5nIGJlZm9yZSBnZXR0aW5nIGl0P1xuICAgIHJldHVybiB0YWcgIT09IGFudGVjZWRlbnQ7IC8vIEZhbHNlIHdoZW4gdGhleSBhcmUgdGhlIHNhbWUgdGFnLCBhcyB0aGF0IHdvdWxkIGJlIGNpcmN1bGFyLiBWZXJzaW9ucyBkbyBzeW5jLlxuICB9XG4gIC8vIFRPRE86IGlzIHRoaXMgbmVlZGVkIGFueSBtb3JlP1xuICBhc3luYyB2YWxpZGF0ZUZvcldyaXRpbmcodGFnLCBzaWduYXR1cmUsIG9wZXJhdGlvbkxhYmVsLCBzeW5jaHJvbml6ZXIsIHJlcXVpcmVUYWcgPSBmYWxzZSkge1xuICAgIC8vIEEgZGVlcCB2ZXJpZnkgdGhhdCBjaGVja3MgYWdhaW5zdCB0aGUgZXhpc3RpbmcgaXRlbSdzIChyZS0pdmVyaWZpZWQgaGVhZGVycy5cbiAgICAvLyBJZiBpdCBzdWNjZWVkcywgdGhpcyBpcyBhbHNvIHRoZSBjb21tb24gY29kZSAoYmV0d2VlbiBwdXQvZGVsZXRlKSB0aGF0IGVtaXRzIHRoZSB1cGRhdGUgZXZlbnQuXG4gICAgY29uc3QgdmFsaWRhdGlvbk9wdGlvbnMgPSBzeW5jaHJvbml6ZXIgPyB7bWVtYmVyOiBudWxsfSA6IHt9OyAvLyBDb3VsZCBiZSBvbGQgZGF0YSB3cml0dGVuIGJ5IHNvbWVvbmUgd2hvIGlzIG5vIGxvbmdlciBhIG1lbWJlci5cbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmFsaWRhdGlvbk9wdGlvbnMpO1xuICAgIGlmICghdmVyaWZpZWQpIHJldHVybiB0aGlzLm5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgJ2ludmFsaWQnLCB2ZXJpZmllZCwgc2lnbmF0dXJlKTtcbiAgICB2ZXJpZmllZC5zeW5jaHJvbml6ZXIgPSBzeW5jaHJvbml6ZXI7XG4gICAgdGFnID0gdmVyaWZpZWQudGFnID0gdmVyaWZpZWQuc3ViamVjdFRhZyA9IHJlcXVpcmVUYWcgPyB0YWcgOiBhd2FpdCB0aGlzLnRhZ0ZvcldyaXRpbmcodGFnLCB2ZXJpZmllZCk7XG4gICAgY29uc3QgYW50ZWNlZGVudCA9IHRoaXMuYW50ZWNlZGVudCh2ZXJpZmllZCk7XG4gICAgY29uc3Qgc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpO1xuICAgIGNvbnN0IGV4aXN0aW5nVmVyaWZpZWQgPSB2ZXJpZmllZC5leGlzdGluZyA9IGFudGVjZWRlbnQgJiYgYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnOiBhbnRlY2VkZW50LCBzeW5jaHJvbml6ZX0pO1xuICAgIGNvbnN0IGRpc2FsbG93ZWQgPSBhd2FpdCB0aGlzLmRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZ1ZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkKTtcbiAgICBpZiAoZGlzYWxsb3dlZCkgcmV0dXJuIHRoaXMubm90aWZ5SW52YWxpZCh0YWcsIG9wZXJhdGlvbkxhYmVsLCBkaXNhbGxvd2VkLCB2ZXJpZmllZCk7XG4gICAgdGhpcy5sb2coJ2VtaXQnLCB0YWcsIHZlcmlmaWVkLmpzb24pO1xuICAgIHRoaXMuZW1pdCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIC8vIGZpeG1lIG5leHQgMlxuICBtZXJnZVNpZ25hdHVyZXModGFnLCB2YWxpZGF0aW9uLCBzaWduYXR1cmUpIHsgLy8gUmV0dXJuIGEgc3RyaW5nIHRvIGJlIHBlcnNpc3RlZC4gVXN1YWxseSBqdXN0IHRoZSBzaWduYXR1cmUuXG4gICAgcmV0dXJuIHNpZ25hdHVyZTsgIC8vIHZhbGlkYXRpb24uc3RyaW5nIG1pZ2h0IGJlIGFuIG9iamVjdC5cbiAgfVxuICBhc3luYyBwZXJzaXN0KHRhZywgc2lnbmF0dXJlU3RyaW5nLCBvcGVyYXRpb24gPSAncHV0JykgeyAvLyBDb25kdWN0IHRoZSBzcGVjaWZpZWQgdGFnL3NpZ25hdHVyZSBvcGVyYXRpb24gb24gdGhlIHBlcnNpc3RlbnQgc3RvcmUuXG4gICAgcmV0dXJuIChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpW29wZXJhdGlvbl0odGFnLCBzaWduYXR1cmVTdHJpbmcpO1xuICB9XG4gIG1lcmdlVmFsaWRhdGlvbih2YWxpZGF0aW9uKSB7IC8vIFJldHVybiBhIHN0cmluZyB0byBiZSBwZXJzaXN0ZWQuIFVzdWFsbHkganVzdCB0aGUgc2lnbmF0dXJlLlxuICAgIHJldHVybiB2YWxpZGF0aW9uO1xuICB9XG4gIGFzeW5jIHBlcnNpc3QyKHZhbGlkYXRpb24sIG9wZXJhdGlvbiA9ICdwdXQnKSB7IC8vIENvbmR1Y3QgdGhlIHNwZWNpZmllZCB0YWcvc2lnbmF0dXJlIG9wZXJhdGlvbiBvbiB0aGUgcGVyc2lzdGVudCBzdG9yZS4gUmV0dXJuIHRhZ1xuICAgIGNvbnN0IHt0YWcsIHNpZ25hdHVyZX0gPSB2YWxpZGF0aW9uO1xuICAgIGNvbnN0IHNpZ25hdHVyZVN0cmluZyA9IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gICAgY29uc3Qgc3RvcmFnZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBhd2FpdCBzdG9yYWdlW29wZXJhdGlvbl0odGFnLCBzaWduYXR1cmVTdHJpbmcpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBEaXNwYXRjaCB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHZlcmlmaWVkfSkpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gQW5zd2VycyB0aGUgQ29sbGVjdGlvbiB0aGF0IGVtaXRzIGluZGl2aWR1YWwgdXBkYXRlcy4gKFNlZSBvdmVycmlkZSBpbiBWZXJzaW9uZWRDb2xsZWN0aW9uLilcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHN5bmNocm9uaXplcnMgPSBuZXcgTWFwKCk7IC8vIHNlcnZpY2VJbmZvIG1pZ2h0IG5vdCBiZSBhIHN0cmluZy5cbiAgbWFwU3luY2hyb25pemVycyhmKSB7IC8vIE9uIFNhZmFyaSwgTWFwLnZhbHVlcygpLm1hcCBpcyBub3QgYSBmdW5jdGlvbiFcbiAgICBjb25zdCByZXN1bHRzID0gW107XG4gICAgZm9yIChjb25zdCBzeW5jaHJvbml6ZXIgb2YgdGhpcy5zeW5jaHJvbml6ZXJzLnZhbHVlcygpKSB7XG4gICAgICByZXN1bHRzLnB1c2goZihzeW5jaHJvbml6ZXIpKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cbiAgZ2V0IHNlcnZpY2VzKCkge1xuICAgIHJldHVybiBBcnJheS5mcm9tKHRoaXMuc3luY2hyb25pemVycy5rZXlzKCkpO1xuICB9XG4gIC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGNvbm5lY3QsIGFuZCBkZWZpbmUgc3luY2hyb25pemUgdG8gYXdhaXQgY29ubmVjdCwgc3luY2hyb25pemF0aW9uQ29tcGxldGUsIGRpc2Nvbm5uZWN0LlxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBTdGFydCBydW5uaW5nIHRoZSBzcGVjaWZpZWQgc2VydmljZXMgKGluIGFkZGl0aW9uIHRvIHdoYXRldmVyIGlzIGFscmVhZHkgcnVubmluZykuXG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBpZiAoc3luY2hyb25pemVycy5oYXMoc2VydmljZSkpIGNvbnRpbnVlO1xuICAgICAgYXdhaXQgU3luY2hyb25pemVyLmNyZWF0ZSh0aGlzLCBzZXJ2aWNlKTsgLy8gUmVhY2hlcyBpbnRvIG91ciBzeW5jaHJvbml6ZXJzIG1hcCBhbmQgc2V0cyBpdHNlbGYgaW1tZWRpYXRlbHkuXG4gICAgfVxuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHMgPT4gcy5ib3RoU2lkZXNDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24pKTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIFNodXQgZG93biB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBjb25zdCBzeW5jaHJvbml6ZXIgPSBzeW5jaHJvbml6ZXJzLmdldChzZXJ2aWNlKTtcbiAgICAgIGlmICghc3luY2hyb25pemVyKSB7XG5cdC8vY29uc29sZS53YXJuKGAke3RoaXMuZnVsbExhYmVsfSBkb2VzIG5vdCBoYXZlIGEgc2VydmljZSBuYW1lZCAnJHtzZXJ2aWNlfScgdG8gZGlzY29ubmVjdC5gKTtcblx0Y29udGludWU7XG4gICAgICB9XG4gICAgICBhd2FpdCBzeW5jaHJvbml6ZXIuZGlzY29ubmVjdCgpO1xuICAgIH1cbiAgfVxuICBhc3luYyBlbnN1cmVTeW5jaHJvbml6ZXIoc2VydmljZU5hbWUsIGNvbm5lY3Rpb24sIGRhdGFDaGFubmVsKSB7IC8vIE1ha2Ugc3VyZSBkYXRhQ2hhbm5lbCBtYXRjaGVzIHRoZSBzeW5jaHJvbml6ZXIsIGNyZWF0aW5nIFN5bmNocm9uaXplciBvbmx5IGlmIG1pc3NpbmcuXG4gICAgbGV0IHN5bmNocm9uaXplciA9IHRoaXMuc3luY2hyb25pemVycy5nZXQoc2VydmljZU5hbWUpO1xuICAgIGlmICghc3luY2hyb25pemVyKSB7XG4gICAgICBzeW5jaHJvbml6ZXIgPSBuZXcgU3luY2hyb25pemVyKHtzZXJ2aWNlTmFtZSwgY29sbGVjdGlvbjogdGhpcywgZGVidWc6IHRoaXMuZGVidWd9KTtcbiAgICAgIHN5bmNocm9uaXplci5jb25uZWN0aW9uID0gY29ubmVjdGlvbjtcbiAgICAgIHN5bmNocm9uaXplci5kYXRhQ2hhbm5lbFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZGF0YUNoYW5uZWwpO1xuICAgICAgdGhpcy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgc3luY2hyb25pemVyKTtcbiAgICAgIC8vIERvZXMgTk9UIHN0YXJ0IHN5bmNocm9uaXppbmcuIENhbGxlciBtdXN0IGRvIHRoYXQgaWYgZGVzaXJlZC4gKFJvdXRlciBkb2Vzbid0IG5lZWQgdG8uKVxuICAgIH0gZWxzZSBpZiAoKHN5bmNocm9uaXplci5jb25uZWN0aW9uICE9PSBjb25uZWN0aW9uKSB8fFxuXHQgICAgICAgKHN5bmNocm9uaXplci5jaGFubmVsTmFtZSAhPT0gZGF0YUNoYW5uZWwubGFiZWwpIHx8XG5cdCAgICAgICAoYXdhaXQgc3luY2hyb25pemVyLmRhdGFDaGFubmVsUHJvbWlzZSAhPT0gZGF0YUNoYW5uZWwpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVubWF0Y2hlZCBjb25uZWN0aW9uIGZvciAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgfVxuXG4gIHByb21pc2Uoa2V5LCB0aHVuaykgeyByZXR1cm4gdGh1bms7IH0gLy8gVE9ETzogaG93IHdpbGwgd2Uga2VlcCB0cmFjayBvZiBvdmVybGFwcGluZyBkaXN0aW5jdCBzeW5jcz9cbiAgc3luY2hyb25pemUxKHRhZykgeyAvLyBDb21wYXJlIGFnYWluc3QgYW55IHJlbWFpbmluZyB1bnN5bmNocm9uaXplZCBkYXRhLCBmZXRjaCB3aGF0J3MgbmVlZGVkLCBhbmQgcmVzb2x2ZSBsb2NhbGx5LlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IHN5bmNocm9uaXplci5zeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZVRhZ3MoKSB7IC8vIEVuc3VyZSB0aGF0IHdlIGhhdmUgdXAgdG8gZGF0ZSB0YWcgbWFwIGFtb25nIGFsbCBzZXJ2aWNlcy4gKFdlIGRvbid0IGNhcmUgeWV0IG9mIHRoZSB2YWx1ZXMgYXJlIHN5bmNocm9uaXplZC4pXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgndGFncycsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplRGF0YSgpIHsgLy8gTWFrZSB0aGUgZGF0YSB0byBtYXRjaCBvdXIgdGFnbWFwLCB1c2luZyBzeW5jaHJvbml6ZTEuXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgnZGF0YScsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIHNldCBvbnVwZGF0ZShoYW5kbGVyKSB7IC8vIEFsbG93IHNldHRpbmcgaW4gbGlldSBvZiBhZGRFdmVudExpc3RlbmVyLlxuICAgIGlmIChoYW5kbGVyKSB7XG4gICAgICB0aGlzLl91cGRhdGUgPSBoYW5kbGVyO1xuICAgICAgdGhpcy5hZGRFdmVudExpc3RlbmVyKCd1cGRhdGUnLCBoYW5kbGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5yZW1vdmVFdmVudExpc3RlbmVyKCd1cGRhdGUnLCB0aGlzLl91cGRhdGUpO1xuICAgICAgdGhpcy5fdXBkYXRlID0gaGFuZGxlcjtcbiAgICB9XG4gIH1cbiAgZ2V0IG9udXBkYXRlKCkgeyAvLyBBcyBzZXQgYnkgdGhpcy5vbnVwZGF0ZSA9IGhhbmRsZXIuIERvZXMgTk9UIGFuc3dlciB0aGF0IHdoaWNoIGlzIHNldCBieSBhZGRFdmVudExpc3RlbmVyLlxuICAgIHJldHVybiB0aGlzLl91cGRhdGU7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIEltbXV0YWJsZUNvbGxlY3Rpb24gZXh0ZW5kcyBDb2xsZWN0aW9uIHtcbiAgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gSWdub3JlcyB0YWcuIEp1c3QgdGhlIGhhc2guXG4gICAgcmV0dXJuIHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgfVxuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgeyAvLyBPdmVycmlkZXMgc3VwZXIgYnkgYWxsb3dpbmcgRUFSTElFUiByYXRoZXIgdGhhbiBsYXRlci5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICBpZiAodmVyaWZpZWQubGVuZ3RoICYmICh0YWcgIT09IHByb3Bvc2VkLnN1YikpIHJldHVybiAnd3JvbmcgdGFnJztcbiAgICAgIGlmICghYXdhaXQgdGhpcy5zdWJqZWN0TWF0Y2godmVyaWZpZWQpKSByZXR1cm4gJ3dyb25nIGhhc2gnO1xuICAgICAgcmV0dXJuIG51bGw7IC8vIEZpcnN0IHdyaXRlIG9rLlxuICAgIH1cbiAgICAvLyBObyBvd25lciBtYXRjaC4gTm90IHJlbGV2YW50IGZvciBpbW11dGFibGVzLlxuICAgIGlmICghdmVyaWZpZWQucGF5bG9hZC5sZW5ndGggJiYgKHByb3Bvc2VkLmlhdCA+IGV4aXN0aW5nLmlhdCkpIHJldHVybiBudWxsOyAvLyBMYXRlciBkZWxldGUgaXMgb2suXG4gICAgaWYgKHByb3Bvc2VkLmlhdCA+IGV4aXN0aW5nLmlhdCkgcmV0dXJuICdyZXdyaXRlJzsgLy8gT3RoZXJ3aXNlLCBsYXRlciB3cml0ZXMgYXJlIG5vdC5cbiAgICBpZiAocHJvcG9zZWQuc3ViICE9PSBleGlzdGluZy5zdWIpIHJldHVybiAnYWx0ZXJlZCBjb250ZW50cyc7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmV4cG9ydCBjbGFzcyBNdXRhYmxlQ29sbGVjdGlvbiBleHRlbmRzIENvbGxlY3Rpb24ge1xuICB0YWdGb3JXcml0aW5nKHRhZywgdmFsaWRhdGlvbikgeyAvLyBVc2UgdGFnIGlmIHNwZWNpZmllZCwgYnV0IGRlZmF1bHRzIHRvIGhhc2guXG4gICAgcmV0dXJuIHRhZyB8fCB2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gIH1cbn1cblxuLy8gRWFjaCBWZXJzaW9uZWRDb2xsZWN0aW9uIGhhcyBhIHNldCBvZiBoYXNoLWlkZW50aWZpZWQgaW1tdXRhYmxlIGl0ZW1zIHRoYXQgZm9ybSB0aGUgaW5kaXZpZHVhbCB2ZXJzaW9ucywgYW5kIGEgbWFwIG9mIHRpbWVzdGFtcHMgdG8gdGhvc2UgaXRlbXMuXG4vLyBXZSBjdXJyZW50bHkgbW9kZWwgdGhpcyBieSBoYXZpbmcgdGhlIG1haW4gY29sbGVjdGlvbiBiZSB0aGUgbXV0YWJsZSBtYXAsIGFuZCB0aGUgdmVyc2lvbnMgaW5zdGFuY2UgdmFyaWFibGUgaXMgdGhlIGltbXV0YWJsZSBpdGVtcyBjb2xsZWN0aW9uLlxuLy8gQnV0IGFwcHMgc3RvcmUvcmV0cmlldmUgaW5kaXZpZHVhbCBpdGVtcyB0aHJvdWdoIHRoZSBtYWluIGNvbGxlY3Rpb24sIGFuZCB0aGUgY29ycmVzcG9uZGluZyB1cGRhdGVzIGFyZSB0aHJvdWdoIHRoZSB2ZXJzaW9ucywgd2hpY2ggaXMgYSBiaXQgYXdrd2FyZC5cblxuLy8gRWFjaCBpdGVtIGhhcyBhbiBhbnRlY2VkZW50IHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGFwcGxpY2F0aW9uLXN1cHBsaWVkIHBheWxvYWQgLS0gaXQgbGl2ZXMgaW4gdGhlIHNpZ25hdHVyZSdzIGhlYWRlci5cbi8vIEhvd2V2ZXI6XG4vLyAtIFRoZSB0YWcgRE9FUyBpbmNsdWRlIHRoZSBhbnRlY2VkZW50LCBldmVuIHRob3VnaCBpdCBpcyBub3QgcGFydCBvZiB0aGUgcGF5bG9hZC4gVGhpcyBtYWtlcyBpZGVudGljYWwgcGF5bG9hZHMgaGF2ZVxuLy8gICB1bmlxdWUgdGFncyAoYmVjYXVzZSB0aGV5IHdpbGwgYWx3YXlzIGhhdmUgZGlmZmVyZW50IGFudGVjZWRlbnRzKS5cbi8vIC0gVGhlIGFiaWxpdHkgdG8gd3JpdGUgZm9sbG93cyB0aGUgc2FtZSBydWxlcyBhcyBNdXRhYmxlQ29sbGVjdGlvbiAobGF0ZXN0IHdpbnMpLCBidXQgaXMgdGVzdGVkIGFnYWluc3QgdGhlXG4vLyAgIGFudGVjZWRlbnQgdGFnIGluc3RlYWQgb2YgdGhlIHRhZyBiZWluZyB3cml0dGVuLlxuZXhwb3J0IGNsYXNzIFZlcnNpb25Db2xsZWN0aW9uIGV4dGVuZHMgTXV0YWJsZUNvbGxlY3Rpb24geyAvLyBOZWVkcyB0byBiZSBleHBvcnRlZCBzbyB0aGF0IHRoYXQgcm91dGVyLm1qcyBjYW4gZmluZCBpdC5cbiAgYXN5bmMgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gVXNlIHRhZyBpZiBzcGVjaWZpZWQgKGUuZy4sIHB1dC9kZWxldGUgZHVyaW5nIHN5bmNocm9uaXphdGlvbiksIG90aHdlcndpc2UgcmVmbGVjdCBib3RoIHN1YiBhbmQgYW50ZWNlZGVudC5cbiAgICBpZiAodGFnKSByZXR1cm4gdGFnO1xuICAgIC8vIEVhY2ggdmVyc2lvbiBnZXRzIGEgdW5pcXVlIHRhZyAoZXZlbiBpZiB0aGVyZSBhcmUgdHdvIHZlcnNpb25zIHRoYXQgaGF2ZSB0aGUgc2FtZSBkYXRhIHBheWxvYWQpLlxuICAgIGNvbnN0IGFudCA9IHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLmFudDtcbiAgICBjb25zdCBwYXlsb2FkVGV4dCA9IHZhbGlkYXRpb24udGV4dCB8fCBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUodmFsaWRhdGlvbi5wYXlsb2FkKTtcbiAgICByZXR1cm4gQ3JlZGVudGlhbHMuZW5jb2RlQmFzZTY0dXJsKGF3YWl0IENyZWRlbnRpYWxzLmhhc2hUZXh0KGFudCArIHBheWxvYWRUZXh0KSk7XG4gIH1cbiAgYW50ZWNlZGVudCh2YWxpZGF0aW9uKSB7IC8vIFJldHVybnMgdGhlIHRhZyB0aGF0IHZhbGlkYXRpb24gY29tcGFyZXMgYWdhaW5zdC4gRS5nLiwgZG8gdGhlIG93bmVycyBtYXRjaD9cbiAgICAvLyBGb3Igbm9uLXZlcnNpb25lZCBjb2xsZWN0aW9ucywgd2UgY29tcGFyZSBhZ2FpbnN0IHRoZSBleGlzdGluZyBkYXRhIGF0IHRoZSBzYW1lIHRhZyBiZWluZyB3cml0dGVuLlxuICAgIC8vIEZvciB2ZXJzaW9uZWQgY29sbGVjdGlvbnMsIGl0IGlzIHdoYXQgZXhpc3RzIGFzIHRoZSBsYXRlc3QgdmVyc2lvbiB3aGVuIHRoZSBkYXRhIGlzIHNpZ25lZCwgYW5kIHdoaWNoIHRoZSBzaWduYXR1cmVcbiAgICAvLyByZWNvcmRzIGluIHRoZSBzaWduYXR1cmUuIChGb3IgdGhlIHZlcnkgZmlyc3QgdmVyc2lvbiwgdGhlIHNpZ25hdHVyZSB3aWxsIG5vdGUgdGhlIHRpbWVzdGFtcCBhcyB0aGUgYW50ZWNlY2RlbnQgdGFnLFxuICAgIC8vIChzZWUgdGFnRm9yV3JpdGluZyksIGJ1dCBmb3IgY29tcGFyaW5nIGFnYWluc3QsIHRoaXMgbWV0aG9kIGFuc3dlcnMgZmFsc3kgZm9yIHRoZSBmaXJzdCBpbiB0aGUgY2hhaW4uXG4gICAgY29uc3QgaGVhZGVyID0gdmFsaWRhdGlvbj8ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGlmICghaGVhZGVyKSByZXR1cm4gJyc7XG4gICAgY29uc3QgYW50ZWNlZGVudCA9IGhlYWRlci5hbnQ7XG4gICAgaWYgKHR5cGVvZihhbnRlY2VkZW50KSA9PT0gJ251bWJlcicpIHJldHVybiAnJzsgLy8gQSB0aW1lc3RhbXAgYXMgYW50ZWNlZGVudCBpcyB1c2VkIHRvIHRvIHN0YXJ0IHRoaW5ncyBvZmYuIE5vIHRydWUgYW50ZWNlZGVudC5cbiAgICByZXR1cm4gYW50ZWNlZGVudDtcbiAgfVxuICBhc3luYyBzdWJqZWN0TWF0Y2godmVyaWZpZWQpIHsgLy8gSGVyZSBzdWIgcmVmZXJzIHRvIHRoZSBvdmVyYWxsIGl0ZW0gdGFnIHRoYXQgZW5jb21wYXNzZXMgYWxsIHZlcnNpb25zLCBub3QgdGhlIHBheWxvYWQgaGFzaC5cbiAgICByZXR1cm4gdHJ1ZTsgLy8gVE9ETzogbWFrZSBzdXJlIGl0IG1hdGNoZXMgcHJldmlvdXM/XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBzdWJqZWN0VGFnIChpLmUuLCB0aGUgdGFnIHdpdGhpbiB0aGUgY29sbGVjdGlvbiBhcyBhIHdob2xlKSBpcyBub3QgdGhlIHRhZy9oYXNoLlxuICAgIHZlcmlmaWVkLnN1YmplY3RUYWcgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICAgIHN1cGVyLmVtaXQodmVyaWZpZWQpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBWZXJzaW9uZWRDb2xsZWN0aW9uIGV4dGVuZHMgTXV0YWJsZUNvbGxlY3Rpb24ge1xuICAvLyBUT0RPOiBUaGlzIHdvcmtzIGFuZCBkZW1vbnN0cmF0ZXMgaGF2aW5nIGEgY29sbGVjdGlvbiB1c2luZyBvdGhlciBjb2xsZWN0aW9ucy5cbiAgLy8gSG93ZXZlciwgaGF2aW5nIGEgYmlnIHRpbWVzdGFtcCA9PiBmaXhudW0gbWFwIGlzIGJhZCBmb3IgcGVyZm9ybWFuY2UgYXMgdGhlIGhpc3RvcnkgZ2V0cyBsb25nZXIuXG4gIC8vIFRoaXMgc2hvdWxkIGJlIHNwbGl0IHVwIGludG8gd2hhdCBpcyBkZXNjcmliZWQgaW4gdmVyc2lvbmVkLm1kLlxuICBjb25zdHJ1Y3Rvcih7c2VydmljZXMgPSBbXSwgLi4ucmVzdH0gPSB7fSkge1xuICAgIHN1cGVyKHJlc3QpOyAgLy8gV2l0aG91dCBwYXNzaW5nIHNlcnZpY2VzIHlldCwgYXMgd2UgZG9uJ3QgaGF2ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiBzZXQgdXAgeWV0LlxuICAgIHRoaXMudmVyc2lvbnMgPSBuZXcgVmVyc2lvbkNvbGxlY3Rpb24ocmVzdCk7IC8vIFNhbWUgY29sbGVjdGlvbiBuYW1lLCBidXQgZGlmZmVyZW50IHR5cGUuXG4gICAgLy9maXhtZSB0aGlzLnZlcnNpb25zLmFkZEV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIGV2ZW50ID0+IHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHRoaXMucmVjb3ZlclRhZyhldmVudC5kZXRhaWwpfSkpKTtcbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTsgLy8gTm93IHdlIGNhbiBzeW5jaHJvbml6ZS5cbiAgfVxuICBhc3luYyBjbG9zZSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmNsb3NlKCk7XG4gICAgYXdhaXQgc3VwZXIuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVzdHJveSgpO1xuICAgIGF3YWl0IHN1cGVyLmRlc3Ryb3koKTtcbiAgfVxuICByZWNvdmVyVGFnKHZlcmlmaWVkKSB7IC8vIHRoZSB2ZXJpZmllZC50YWcgaXMgZm9yIHRoZSB2ZXJzaW9uLiBXZSB3YW50IHRoZSBvdmVyYWxsIG9uZS5cbiAgICByZXR1cm4gT2JqZWN0LmFzc2lnbih7fSwgdmVyaWZpZWQsIHt0YWc6IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWJ9KTsgLy8gRG8gbm90IGJhc2ggdmVyaWZpZWQhXG4gIH1cbiAgc2VydmljZUZvclZlcnNpb24oc2VydmljZSkgeyAvLyBHZXQgdGhlIHNlcnZpY2UgXCJuYW1lXCIgZm9yIG91ciB2ZXJzaW9ucyBjb2xsZWN0aW9uLlxuICAgIHJldHVybiBzZXJ2aWNlPy52ZXJzaW9ucyB8fCBzZXJ2aWNlOyAgIC8vIEZvciB0aGUgd2VpcmQgY29ubmVjdERpcmVjdFRlc3RpbmcgY2FzZSB1c2VkIGluIHJlZ3Jlc3Npb24gdGVzdHMsIGVsc2UgdGhlIHNlcnZpY2UgKGUuZy4sIGFuIGFycmF5IG9mIHNpZ25hbHMpLlxuICB9XG4gIHNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykge1xuICAgIHJldHVybiBzZXJ2aWNlcy5tYXAoc2VydmljZSA9PiB0aGlzLnNlcnZpY2VGb3JWZXJzaW9uKHNlcnZpY2UpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBzeW5jaHJvbml6ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiwgdG9vLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSByZXR1cm47XG4gICAgLy8gS2VlcCBjaGFubmVsIGNyZWF0aW9uIHN5bmNocm9ub3VzLlxuICAgIGNvbnN0IHZlcnNpb25lZFByb21pc2UgPSBzdXBlci5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgdmVyc2lvblByb21pc2UgPSB0aGlzLnZlcnNpb25zLnN5bmNocm9uaXplKC4uLnRoaXMuc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSk7XG4gICAgYXdhaXQgdmVyc2lvbmVkUHJvbWlzZTtcbiAgICBhd2FpdCB2ZXJzaW9uUHJvbWlzZTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIGRpc2Nvbm5lY3QgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24sIHRvby5cbiAgICBpZiAoIXNlcnZpY2VzLmxlbmd0aCkgc2VydmljZXMgPSB0aGlzLnNlcnZpY2VzO1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGlzY29ubmVjdCguLi50aGlzLnNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykpO1xuICAgIGF3YWl0IHN1cGVyLmRpc2Nvbm5lY3QoLi4uc2VydmljZXMpO1xuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gc3VwZXIuc3luY2hyb25pemVkLnRoZW4oKCkgPT4gdGhpcy52ZXJzaW9ucy5zeW5jaHJvbml6ZWQpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gVGhlIHZlcnNpb25zIGNvbGxlY3Rpb24gZW1pdHMgYW4gdXBkYXRlIGNvcnJlc3BvbmRpbmcgdG8gdGhlIGluZGl2aWR1YWwgaXRlbSBzdG9yZWQuXG4gICAgLy8gKFRoZSB1cGRhdGVzIGVtaXR0ZWQgZnJvbSB0aGUgd2hvbGUgbXV0YWJsZSBWZXJzaW9uZWRDb2xsZWN0aW9uIGNvcnJlc3BvbmQgdG8gdGhlIG1hcC4pXG4gICAgcmV0dXJuIHRoaXMudmVyc2lvbnM7XG4gIH1cblxuICBhc3luYyBnZXRWZXJzaW9ucyh0YWcpIHsgLy8gUHJvbWlzZXMgdGhlIHBhcnNlZCB0aW1lc3RhbXAgPT4gdmVyc2lvbiBkaWN0aW9uYXJ5IElGIGl0IGV4aXN0cywgZWxzZSBmYWxzeS5cbiAgICB0aGlzLnJlcXVpcmVUYWcodGFnKTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZ30pO1xuICAgIGNvbnN0IGpzb24gPSB2ZXJpZmllZD8uanNvbjtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoanNvbikpIHJldHVybiBqc29uO1xuICAgIC8vIElmIHdlIGhhdmUgYW4gdW5tZXJnZWQgYXJyYXkgb2Ygc2lnbmF0dXJlcy4uLlxuICAgIC8vIEknbSBub3Qgc3VyZSB0aGF0IGl0J3MgdmVyeSB1c2VmdWwgdG8gYXBwbGljYXRpb25zIGZvciB1cyB0byBoYW5kbGUgdGhpcyBjYXNlLCBidXQgaXQgaXMgbmljZSB0byBleGVyY2lzZSB0aGlzIGluIHRlc3RpbmcuXG4gICAgY29uc3QgdmVyaWZpY2F0aW9uc0FycmF5ID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHRoaXMuY29tYmluZVRpbWVzdGFtcHModGFnLCBudWxsLCAuLi52ZXJpZmljYXRpb25zQXJyYXkubWFwKHYgPT4gdi5qc29uKSk7XG4gIH1cbiAgYXN5bmMgcmV0cmlldmVUaW1lc3RhbXBzKHRhZykgeyAvLyBQcm9taXNlcyBhIGxpc3Qgb2YgYWxsIHZlcnNpb24gdGltZXN0YW1wcy5cbiAgICBjb25zdCB2ZXJzaW9ucyA9IGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKTtcbiAgICBpZiAoIXZlcnNpb25zKSByZXR1cm4gdmVyc2lvbnM7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHZlcnNpb25zKS5zbGljZSgxKS5tYXAoc3RyaW5nID0+IHBhcnNlSW50KHN0cmluZykpOyAvLyBUT0RPPyBNYXAgdGhlc2UgdG8gaW50ZWdlcnM/XG4gIH1cbiAgZ2V0QWN0aXZlSGFzaCh0aW1lc3RhbXBzLCB0aW1lID0gdGltZXN0YW1wcy5sYXRlc3QpIHsgLy8gUHJvbWlzZXMgdGhlIHZlcnNpb24gdGFnIHRoYXQgd2FzIGluIGZvcmNlIGF0IHRoZSBzcGVjaWZpZWQgdGltZVxuICAgIC8vICh3aGljaCBtYXkgYmVmb3JlLCBpbiBiZXR3ZWVuLCBvciBhZnRlciB0aGUgcmVjb3JkZWQgZGlzY3JldGUgdGltZXN0YW1wcykuXG4gICAgaWYgKCF0aW1lc3RhbXBzKSByZXR1cm4gdGltZXN0YW1wcztcbiAgICBsZXQgaGFzaCA9IHRpbWVzdGFtcHNbdGltZV07XG4gICAgaWYgKGhhc2gpIHJldHVybiBoYXNoO1xuICAgIC8vIFdlIG5lZWQgdG8gZmluZCB0aGUgdGltZXN0YW1wIHRoYXQgd2FzIGluIGZvcmNlIGF0IHRoZSByZXF1ZXN0ZWQgdGltZS5cbiAgICBsZXQgYmVzdCA9IDAsIHRpbWVzID0gT2JqZWN0LmtleXModGltZXN0YW1wcyk7XG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPCB0aW1lcy5sZW5ndGg7IGkrKykgeyAvLyAwdGggaXMgdGhlIGtleSAnbGF0ZXN0Jy5cbiAgICAgIGlmICh0aW1lc1tpXSA8PSB0aW1lKSBiZXN0ID0gdGltZXNbaV07XG4gICAgICBlbHNlIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4gdGltZXN0YW1wc1tiZXN0XTtcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gQW5zd2VyIHRoZSB2YWxpZGF0ZWQgdmVyc2lvbiBpbiBmb3JjZSBhdCB0aGUgc3BlY2lmaWVkIHRpbWUgKG9yIGxhdGVzdCksIG9yIGF0IHRoZSBzcGVjaWZpYyBoYXNoLlxuICAgIGxldCB7dGFnLCB0aW1lLCBoYXNoLCAuLi5yZXN0fSA9ICghdGFnT3JPcHRpb25zIHx8IHRhZ09yT3B0aW9ucy5sZW5ndGgpID8ge3RhZzogdGFnT3JPcHRpb25zfSA6IHRhZ09yT3B0aW9ucztcbiAgICBpZiAoIWhhc2gpIHtcbiAgICAgIGNvbnN0IHRpbWVzdGFtcHMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgICBpZiAoIXRpbWVzdGFtcHMpIHJldHVybiB0aW1lc3RhbXBzO1xuICAgICAgaGFzaCA9IHRoaXMuZ2V0QWN0aXZlSGFzaCh0aW1lc3RhbXBzLCB0aW1lKTtcbiAgICAgIGlmICghaGFzaCkgcmV0dXJuICcnO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy52ZXJzaW9ucy5yZXRyaWV2ZSh7dGFnOiBoYXNoLCAuLi5yZXN0fSk7XG4gIH1cbiAgYXN5bmMgc3RvcmUoZGF0YSwgb3B0aW9ucyA9IHt9KSB7IC8vIERldGVybWluZSB0aGUgYW50ZWNlZGVudCwgcmVjb3JkIGl0IGluIHRoZSBzaWduYXR1cmUsIGFuZCBzdG9yZSB0aGF0XG4gICAgLy8gYXMgdGhlIGFwcHJvcHJpYXRlIHZlcnNpb24gaGFzaC4gVGhlbiByZWNvcmQgdGhlIG5ldyB0aW1lc3RhbXAvaGFzaCBpbiB0aGUgdGltZXN0YW1wcyBsaXN0LlxuICAgIGxldCB2ZXJzaW9ucyxcblx0Ly8gVE9ETzogQ29uc2lkZXIgZW5jcnlwdGluZyB0aGUgdGltZXN0YW1wcywgdG9vLlxuXHQvLyBDdXJyZW50bHksIHNpZ25pbmdPcHRpb25zIGZvciB0aGUgdGltZXN0YW1wcyBkb2VzIE5PVCBlbmNsdWRlIGVuY3J5cHRpb24sIGV2ZW4gaWYgc3BlY2lmaWVkIGZvciB0aGUgYWN0dWFsIHNwZWNpZmljIHZlcnNpb24gaW5mby5cblx0Ly8gVGhpcyBtZWFucyB0aGF0IGlmIHRoZSBhcHBsaWNhdGlvbiBzcGVjaWZpZXMgYW4gZW5jcnlwdGVkIHZlcnNpb25lZCBjb2xsZWN0aW9uLCB0aGUgZGF0YSBpdHNlbGYgd2lsbCBiZSBlbmNyeXB0ZWQsIGJ1dFxuXHQvLyBub3QgdGhlIG1hcCBvZiB0aW1lc3RhbXBzIHRvIGhhc2hlcywgYW5kIHNvIGEgbHVya2VyIGNhbiBzZWUgd2hlbiB0aGVyZSB3YXMgYWN0aXZpdGl0eSBhbmQgaGF2ZSBhbiBpZGVhIGFzIHRvIHRoZSBzaXplLlxuXHQvLyBPZiBjb3Vyc2UsIGV2ZW4gaWYgZW5jcnlwdGVkLCB0aGV5IGNvdWxkIGFsc28gZ2V0IHRoaXMgZnJvbSBsaXZlIHRyYWZmaWMgYW5hbHlzaXMsIHNvIG1heWJlIGVuY3J5cHRpbmcgaXQgd291bGQganVzdFxuXHQvLyBjb252ZXkgYSBmYWxzZSBzZW5zZSBvZiBzZWN1cml0eS4gRW5jcnlwdGluZyB0aGUgdGltZXN0YW1wcyBkb2VzIGNvbXBsaWNhdGUsIGUuZy4sIG1lcmdlU2lnbmF0dXJlcygpIGJlY2F1c2Vcblx0Ly8gc29tZSBvZiB0aGUgd29yayBjb3VsZCBvbmx5IGJlIGRvbmUgYnkgcmVsYXlzIHRoYXQgaGF2ZSBhY2Nlc3MuIEJ1dCBzaW5jZSB3ZSBoYXZlIHRvIGJlIGNhcmVmdWwgYWJvdXQgc2lnbmluZyBhbnl3YXksXG5cdC8vIHdlIHNob3VsZCB0aGVvcmV0aWNhbGx5IGJlIGFibGUgdG8gYmUgYWNjb21vZGF0ZSB0aGF0LlxuXHR7dGFnLCBlbmNyeXB0aW9uLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpLFxuXHR0aW1lID0gRGF0ZS5ub3coKSxcblx0dmVyc2lvbk9wdGlvbnMgPSBPYmplY3QuYXNzaWduKHt0aW1lLCBlbmNyeXB0aW9ufSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIGlmICh0YWcpIHtcbiAgICAgIHZlcnNpb25zID0gKGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKSkgfHwge307XG4gICAgICB2ZXJzaW9uT3B0aW9ucy5zdWIgPSB0YWc7XG4gICAgICBpZiAodmVyc2lvbnMpIHtcblx0dmVyc2lvbk9wdGlvbnMuYW50ID0gdmVyc2lvbnNbdmVyc2lvbnMubGF0ZXN0XTtcbiAgICAgIH1cbiAgICB9IC8vIEVsc2UgZG8gbm90IGFzc2lnbiBzdWIuIEl0IHdpbGwgYmUgc2V0IHRvIHRoZSBwYXlsb2FkIGhhc2ggZHVyaW5nIHNpZ25pbmcsIGFuZCBhbHNvIHVzZWQgZm9yIHRoZSBvdmVyYWxsIHRhZy5cbiAgICB2ZXJzaW9uT3B0aW9ucy5hbnQgfHw9IHRpbWU7XG4gICAgY29uc3QgaGFzaCA9IGF3YWl0IHRoaXMudmVyc2lvbnMuc3RvcmUoZGF0YSwgdmVyc2lvbk9wdGlvbnMpO1xuICAgIGlmICghdGFnKSB7IC8vIFdlJ2xsIHN0aWxsIG5lZWQgdGFnIGFuZCB2ZXJzaW9ucy5cbiAgICAgIGNvbnN0IHZlcnNpb25TaWduYXR1cmUgPSBhd2FpdCB0aGlzLnZlcnNpb25zLmdldChoYXNoKTtcbiAgICAgIGNvbnN0IGNsYWltcyA9IENyZWRlbnRpYWxzLmRlY29kZUNsYWltcyh0aGlzLmNvbnN0cnVjdG9yLm1heWJlSW5mbGF0ZSh2ZXJzaW9uU2lnbmF0dXJlKSk7XG4gICAgICB0YWcgPSBjbGFpbXMuc3ViO1xuICAgICAgdmVyc2lvbnMgPSB7fTtcbiAgICB9XG4gICAgdmVyc2lvbnMubGF0ZXN0ID0gdGltZTtcbiAgICB2ZXJzaW9uc1t0aW1lXSA9IGhhc2g7XG5cbiAgICAvLyBmaXhtZSBuZXh0XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKHZlcnNpb25zLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgLy8gSGVyZSB3ZSBhcmUgZG9pbmcgd2hhdCB0aGlzLnB1dCgpIHdvdWxkIG5vcm1hbGx5IGRvLCBidXQgd2UgaGF2ZSBhbHJlYWR5IG1lcmdlZCBzaWduYXR1cmVzLlxuICAgIGF3YWl0IHRoaXMuYWRkVGFnKHRhZyk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHRhZywgc2lnbmF0dXJlKTtcbiAgICB0aGlzLmVtaXQoe3RhZywgc3ViamVjdFRhZzogdGFnLCAuLi4oYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlKSl9KTtcbiAgICBhd2FpdCB0aGlzLnB1c2goJ3B1dCcsIHRhZywgc2lnbmF0dXJlKTtcbiAgICAvLyBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZpZWRTaWduKHZlcnNpb25zLCBzaWduaW5nT3B0aW9ucywgdGFnKTtcbiAgICAvLyB0aGlzLmxvZygncHV0KC1pc2gpJywgdmVyaWZpZWQpO1xuICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIodmVyaWZpZWQpO1xuICAgIC8vIGF3YWl0IHRoaXMuYWRkVGFnKHRhZyk7XG4gICAgLy8gdGhpcy5lbWl0KHsuLi52ZXJpZmllZCwgdGFnLCBzdWJqZWN0VGFnOiB0YWd9KTtcbiAgICAvLyBhd2FpdCB0aGlzLnB1c2goJ3B1dCcsIHRhZywgdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcodmVyaWZpZWQuc2lnbmF0dXJlKSk7XG5cbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIHJlbW92ZShvcHRpb25zID0ge30pIHsgLy8gQWRkIGFuIGVtcHR5IHZlcmlvbiBvciByZW1vdmUgYWxsIHZlcnNpb25zLCBkZXBlbmRpbmcgb24gdGhpcy5wcmVzZXJ2ZURlbGV0aW9ucy5cbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTsgLy8gSWdub3JlIGVuY3J5cHRpb25cbiAgICBjb25zdCB2ZXJzaW9ucyA9IGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKTtcbiAgICBpZiAoIXZlcnNpb25zKSByZXR1cm4gdmVyc2lvbnM7XG4gICAgaWYgKHRoaXMucHJlc2VydmVEZWxldGlvbnMpIHsgLy8gQ3JlYXRlIGEgdGltZXN0YW1wID0+IHZlcnNpb24gd2l0aCBhbiBlbXB0eSBwYXlsb2FkLiBPdGhlcndpc2UgbWVyZ2luZyB3aXRoIGVhcmxpZXIgZGF0YSB3aWxsIGJyaW5nIGl0IGJhY2shXG4gICAgICBhd2FpdCB0aGlzLnN0b3JlKCcnLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgfSBlbHNlIHsgLy8gQWN0dWFsbHkgZGVsZXRlIHRoZSB0aW1lc3RhbXBzIGFuZCBlYWNoIHZlcnNpb24uXG4gICAgICAvLyBmaXhtZSBuZXh0XG4gICAgICBjb25zdCB2ZXJzaW9uVGFncyA9IE9iamVjdC52YWx1ZXModmVyc2lvbnMpLnNsaWNlKDEpO1xuICAgICAgY29uc3QgdmVyc2lvblNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbignJywge3N1YjogdGFnLCAuLi5zaWduaW5nT3B0aW9uc30pO1xuICAgICAgLy8gVE9ETzogSXMgdGhpcyBzYWZlPyBTaG91bGQgd2UgbWFrZSBhIHNpZ25hdHVyZSB0aGF0IHNwZWNpZmllcyBlYWNoIGFudGVjZWRlbnQ/XG4gICAgICBhd2FpdCBQcm9taXNlLmFsbCh2ZXJzaW9uVGFncy5tYXAoYXN5bmMgdGFnID0+IHtcblx0YXdhaXQgdGhpcy52ZXJzaW9ucy5kZWxldGUodGFnLCB2ZXJzaW9uU2lnbmF0dXJlKTtcblx0YXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHZlcnNpb25TaWduYXR1cmUpO1xuICAgICAgfSkpO1xuICAgICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKCcnLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QodGFnLCBzaWduYXR1cmUsICdkZWxldGUnKTtcbiAgICAgIGF3YWl0IHRoaXMucHVzaCgnZGVsZXRlJywgdGFnLCBzaWduYXR1cmUpO1xuICAgICAgLy8gY29uc3QgdmVyc2lvbkhhc2hlcyA9IE9iamVjdC52YWx1ZXModmVyc2lvbnMpLnNsaWNlKDEpO1xuICAgICAgLy8gY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmaWVkU2lnbignJywge3N1YjogdGFnLCAuLi5zaWduaW5nT3B0aW9uc30sIHRhZyk7XG4gICAgICAvLyAvLyBUT0RPOiBJcyB0aGlzIHNhZmU/IFNob3VsZCB3ZSBtYWtlIGEgc2lnbmF0dXJlIHRoYXQgc3BlY2lmaWVzIGVhY2ggYW50ZWNlZGVudD9cbiAgICAgIC8vIGF3YWl0IFByb21pc2UuYWxsKHZlcnNpb25IYXNoZXMubWFwKGFzeW5jIGhhc2ggPT4ge1xuICAgICAgLy8gXHRsZXQgdlZlcmlmaWVkID0gey4uLnZlcmlmaWVkLCB0YWc6IGhhc2h9O1xuICAgICAgLy8gXHRsZXQgc1ZlcmlmaWVkID0gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcodlZlcmlmaWVkLnNpZ25hdHVyZSk7XG4gICAgICAvLyBcdC8vIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlVGFnKHRhZyk7XG4gICAgICAvLyBcdC8vIGF3YWl0IHRoaXMudmVyc2lvbnMucGVyc2lzdDIodlZlcmlmaWVkLCAnZGVsZXRlJyk7XG4gICAgICAvLyBcdC8vIHRoaXMudmVyc2lvbnMuZW1pdCh2VmVyaWZpZWQpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLnB1c2goJ2RlbGV0ZScsIHRhZywgc1ZlcmlmaWVkKTtcbiAgICAgIC8vIFx0YXdhaXQgdGhpcy52ZXJzaW9ucy5kZWxldGUodGFnLCBzVmVyaWZpZWQpO1xuICAgICAgLy8gXHRhd2FpdCB0aGlzLnZlcnNpb25zLnB1c2goJ2RlbGV0ZScsIHRhZywgc1ZlcmlmaWVkKVxuICAgICAgLy8gfSkpO1xuICAgICAgLy8gYXdhaXQgdGhpcy5wZXJzaXN0Mih2ZXJpZmllZCwgJ2RlbGV0ZScpO1xuICAgICAgLy8gYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZlcmlmaWVkLnNpZ25hdHVyZSkpO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLmRlbGV0ZVRhZyh0YWcpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgYXN5bmMgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlLCBhdXRob3JPdmVycmlkZSA9IG51bGwpIHsgLy8gTWVyZ2UgdGhlIG5ldyB0aW1lc3RhbXBzIHdpdGggdGhlIG9sZC5cbiAgICAvLyBJZiBwcmV2aW91cyBkb2Vzbid0IGV4aXN0IG9yIG1hdGNoZXMgdGhlIG5leHQsIG9yIGlzIGEgc3Vic2V0IG9mIHRoZSBuZXh0LCBqdXN0IHVzZSB0aGUgbmV4dC5cbiAgICAvLyBPdGhlcndpc2UsIHdlIGhhdmUgdG8gbWVyZ2U6XG4gICAgLy8gLSBNZXJnZWQgbXVzdCBjb250YWluIHRoZSB1bmlvbiBvZiB2YWx1ZXMgZm9yIGVpdGhlci5cbiAgICAvLyAgIChTaW5jZSB2YWx1ZXMgYXJlIGhhc2hlcyBvZiBzdHVmZiB3aXRoIGFuIGV4cGxpY2l0IGFudGVkZW50LCBuZXh0IHByZXZpb3VzIG5vciBuZXh0IHdpbGwgaGF2ZSBkdXBsaWNhdGVzIGJ5IHRoZW1zZWx2ZXMuLilcbiAgICAvLyAtIElmIHRoZXJlJ3MgYSBjb25mbGljdCBpbiBrZXlzLCBjcmVhdGUgYSBuZXcga2V5IHRoYXQgaXMgbWlkd2F5IGJldHdlZW4gdGhlIGNvbmZsaWN0IGFuZCB0aGUgbmV4dCBrZXkgaW4gb3JkZXIuXG5cbiAgICBsZXQgbmV4dCA9IHZhbGlkYXRpb247XG4gICAgbGV0IHByZXZpb3VzID0gdmFsaWRhdGlvbi5leGlzdGluZztcbiAgICAvL2ZpeG1lIG5leHRcbiAgICBpZiAoIXByZXZpb3VzKSByZXR1cm4gc2lnbmF0dXJlOyAgIC8vIE5vIHByZXZpb3VzLCBqdXN0IHVzZSBuZXcgc2lnbmF0dXJlLlxuICAgIC8vaWYgKCFwcmV2aW91cykgcmV0dXJuIG5leHQ7ICAgLy8gTm8gcHJldmlvdXMsIGp1c3QgbmV4dC5cblxuICAgIC8vIEF0IHRoaXMgcG9pbnQsIHByZXZpb3VzIGFuZCBuZXh0IGFyZSBib3RoIFwib3V0ZXJcIiB2YWxpZGF0aW9ucy5cbiAgICAvLyBUaGF0IGpzb24gY2FuIGJlIGVpdGhlciBhIHRpbWVzdGFtcCBvciBhbiBhcnJheSBvZiBzaWduYXR1cmVzLlxuICAgIGlmICh2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5pYXQgPCB2YWxpZGF0aW9uLmV4aXN0aW5nLnByb3RlY3RlZEhlYWRlci5pYXQpIHsgLy8gQXJyYW5nZSBmb3IgbmV4dCBhbmQgc2lnbmF0dXJlIHRvIGJlIGxhdGVyIG9uZSBieSBzaWduZWQgdGltZXN0YW1wLlxuICAgICAgLy8gVE9ETzogaXMgaXQgcG9zc2libGUgdG8gY29uc3RydWN0IGEgc2NlbmFyaW8gaW4gd2hpY2ggdGhlcmUgaXMgYSBmaWN0aXRpb3VzIHRpbWUgc3RhbXAgY29uZmxpY3QuIEUuZywgaWYgYWxsIG9mIHRoZXNlIGFyZSB0cnVlOlxuICAgICAgLy8gMS4gcHJldmlvdXMgYW5kIG5leHQgaGF2ZSBpZGVudGljYWwgdGltZXN0YW1wcyBmb3IgZGlmZmVyZW50IHZhbHVlcywgYW5kIHNvIHdlIG5lZWQgdG8gY29uc3RydWN0IGFydGlmaWNpYWwgdGltZXMgZm9yIG9uZS4gTGV0J3MgY2FsbCB0aGVzZSBicmFuY2ggQSBhbmQgQi5cbiAgICAgIC8vIDIuIHRoaXMgaGFwcGVucyB3aXRoIHRoZSBzYW1lIHRpbWVzdGFtcCBpbiBhIHNlcGFyYXRlIHBhaXIsIHdoaWNoIHdlJ2xsIGNhbGwgQTIsIGFuZCBCMi5cbiAgICAgIC8vIDMuIEEgYW5kIEIgYXJlIG1lcmdlZCBpbiB0aGF0IG9yZGVyIChlLmcuIHRoZSBsYXN0IHRpbWUgaW4gQSBpcyBsZXNzIHRoYW4gQiksIGJ1dCBBMiBhbmQgQjIgYXJlIG1lcmdlZCBiYWNrd2FyZHMgKGUuZy4sIHRoZSBsYXN0IHRpbWUgaW4gQjIgaXMgbGVzcyB0aGFudCBBMiksXG4gICAgICAvLyAgICBzdWNoIHRoYXQgdGhlIG92ZXJhbGwgbWVyZ2UgY3JlYXRlcyBhIGNvbmZsaWN0P1xuICAgICAgW3ByZXZpb3VzLCBuZXh0XSA9IFtuZXh0LCBwcmV2aW91c107XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgdGltZXN0YW1wcyBvZiBwcmV2aW91cyB3aG9zZSBWQUxVRVMgdGhhdCBhcmUgbm90IGluIG5leHQuXG4gICAgbGV0IGtleXNPZk1pc3NpbmcgPSBudWxsO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShwcmV2aW91cy5qc29uKSAmJiAhQXJyYXkuaXNBcnJheShuZXh0Lmpzb24pKSB7IC8vIE5vIHBvaW50IGluIG9wdGltaXppbmcgdGhyb3VnaCBtaXNzaW5nS2V5cyBpZiB0aGF0IG1ha2VzIHVzIGNvbWJpbmVUaW1lc3RhbXBzIGFueXdheS5cbiAgICAgIGtleXNPZk1pc3NpbmcgPSB0aGlzLm1pc3NpbmdLZXlzKHByZXZpb3VzLmpzb24sIG5leHQuanNvbik7XG4gICAgICAvLyBmaXhtZSBuZXh0XG4gICAgICBpZiAoIWtleXNPZk1pc3NpbmcubGVuZ3RoKSByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcobmV4dC5zaWduYXR1cmUpOyAvLyBQcmV2aW91cyBpcyBhIHN1YnNldCBvZiBuZXcgc2lnbmF0dXJlLlxuICAgICAgLy9pZiAoIWtleXNPZk1pc3NpbmcubGVuZ3RoKSByZXR1cm4gbmV4dDsgLy8gUHJldmlvdXMgaXMgYSBzdWJzZXQgb2YgbmV3IHNpZ25hdHVyZS5cbiAgICB9XG4gICAgLy8gVE9ETzogcmV0dXJuIHByZXZpb3VzIGlmIG5leHQgaXMgYSBzdWJzZXQgb2YgaXQ/XG5cbiAgICAvLyBXZSBjYW5ub3QgcmUtdXNlIG9uZSBvciBvdGhlci4gU2lnbiBhIG5ldyBtZXJnZWQgcmVzdWx0LlxuICAgIGNvbnN0IHByZXZpb3VzVmFsaWRhdGlvbnMgPSBhd2FpdCB0aGlzLmVuc3VyZUV4cGFuZGVkKHByZXZpb3VzKTtcbiAgICBjb25zdCBuZXh0VmFsaWRhdGlvbnMgPSBhd2FpdCB0aGlzLmVuc3VyZUV4cGFuZGVkKG5leHQpO1xuICAgIC8vIFdlIGNhbiBvbmx5IHRydWx5IG1lcmdlIGlmIHdlIGFyZSBhbiBvd25lci5cbiAgICBjb25zdCBoZWFkZXIgPSBwcmV2aW91c1ZhbGlkYXRpb25zWzBdLnByb3RlY3RlZEhlYWRlcjtcbiAgICBsZXQgb3duZXIgPSBoZWFkZXIuaXNzIHx8IGhlYWRlci5raWQ7XG4gICAgbGV0IGlzT3duZXIgPSBbQ3JlZGVudGlhbHMub3duZXIsIENyZWRlbnRpYWxzLmF1dGhvciwgYXV0aG9yT3ZlcnJpZGVdLmluY2x1ZGVzKG93bmVyKTtcbiAgICAvLyBJZiB0aGVzZSBhcmUgbm90IHRoZSBvd25lciwgYW5kIHdlIHdlcmUgbm90IGdpdmVuIGEgc3BlY2lmaWMgb3ZlcnJpZGUsIHRoZW4gc2VlIGlmIHRoZSB1c2VyIGhhcyBhY2Nlc3MgdG8gdGhlIG93bmVyIGluIHRoaXMgZXhlY3V0aW9uIGNvbnRleHQuXG4gICAgbGV0IGNhblNpZ24gPSBpc093bmVyIHx8ICghYXV0aG9yT3ZlcnJpZGUgJiYgYXdhaXQgQ3JlZGVudGlhbHMuc2lnbignJywgb3duZXIpLmNhdGNoKCgpID0+IGZhbHNlKSk7XG4gICAgbGV0IG1lcmdlZCwgb3B0aW9ucywgdGltZSA9IERhdGUubm93KCk7XG4gICAgY29uc3QgYXV0aG9yID0gYXV0aG9yT3ZlcnJpZGUgfHwgQ3JlZGVudGlhbHMuYXV0aG9yO1xuICAgIGZ1bmN0aW9uIGZsYXR0ZW4oYSwgYikgeyByZXR1cm4gW10uY29uY2F0KGEsIGIpOyB9XG4gICAgaWYgKCFjYW5TaWduKSB7IC8vIFdlIGRvbid0IGhhdmUgb3duZXIgYW5kIGNhbm5vdCBnZXQgaXQuXG4gICAgICAvLyBDcmVhdGUgYSBzcGVjaWFsIG5vbi1zdGFuZGFyZCBcInNpZ25hdHVyZVwiIHRoYXQgaXMgcmVhbGx5IGFuIGFycmF5IG9mIHNpZ25hdHVyZXNcbiAgICAgIGZ1bmN0aW9uIGdldFNpZ25hdHVyZXModmFsaWRhdGlvbnMpIHsgcmV0dXJuIHZhbGlkYXRpb25zLm1hcCh2YWxpZGF0aW9uID0+IHZhbGlkYXRpb24uc2lnbmF0dXJlKTsgfVxuICAgICAgbWVyZ2VkID0gZmxhdHRlbihnZXRTaWduYXR1cmVzKHByZXZpb3VzVmFsaWRhdGlvbnMpLCBnZXRTaWduYXR1cmVzKG5leHRWYWxpZGF0aW9ucykpO1xuICAgICAgb3B0aW9ucyA9IHt0YWdzOiBbYXV0aG9yXSwgdGltZX07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZ1bmN0aW9uIGdldEpTT05zKHZhbGlkYXRpb25zKSB7IHJldHVybiB2YWxpZGF0aW9ucy5tYXAodmFsaWRhdGlvbiA9PiB2YWxpZGF0aW9uLmpzb24pOyB9XG4gICAgICBjb25zdCBmbGF0dGVuZWQgPSBmbGF0dGVuKGdldEpTT05zKHByZXZpb3VzVmFsaWRhdGlvbnMpLCBnZXRKU09OcyhuZXh0VmFsaWRhdGlvbnMpKTtcbiAgICAgIG1lcmdlZCA9IHRoaXMuY29tYmluZVRpbWVzdGFtcHMobmV4dC50YWcsIGtleXNPZk1pc3NpbmcsIC4uLmZsYXR0ZW5lZCk7XG4gICAgICBvcHRpb25zID0ge3RlYW06IG93bmVyLCBtZW1iZXI6IGF1dGhvciwgdGltZX07XG4gICAgfVxuICAgIC8vIGZpeG1lIG5leHRcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKG1lcmdlZCwgb3B0aW9ucyk7XG4gICAgLy9yZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZmllZFNpZ24obWVyZ2VkLCBvcHRpb25zKTtcbiAgfVxuICBlbnN1cmVFeHBhbmRlZCh2YWxpZGF0aW9uKSB7IC8vIFByb21pc2UgYW4gYXJyYXkgb2YgdmVyaWZpY2F0aW9ucyAodmVyaWZ5aW5nIGVsZW1lbnRzIG9mIHZhbGlkYXRpb24uanNvbiBpZiBuZWVkZWQpLlxuICAgIGlmICghQXJyYXkuaXNBcnJheSh2YWxpZGF0aW9uLmpzb24pKSByZXR1cm4gW3ZhbGlkYXRpb25dO1xuICAgIHJldHVybiBQcm9taXNlLmFsbCh2YWxpZGF0aW9uLmpzb24ubWFwKHNpZ25hdHVyZSA9PiB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeShzaWduYXR1cmUpKSk7XG4gIH1cbiAgbWlzc2luZ0tleXMocHJldmlvdXNNYXBwaW5nLCBuZXh0TWFwcGluZ3MpIHsgLy8gQW5zd2VyIGEgbGlzdCBvZiB0aG9zZSBrZXlzIGZyb20gcHJldmlvdXMgdGhhdCBkbyBub3QgaGF2ZSB2YWx1ZXMgaW4gbmV4dC5cbiAgICBjb25zdCBuZXh0VmFsdWVzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5leHRNYXBwaW5ncykpO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyhwcmV2aW91c01hcHBpbmcpLmZpbHRlcihrZXkgPT4ga2V5ICE9PSAnbGF0ZXN0JyAmJiAhbmV4dFZhbHVlcy5oYXMocHJldmlvdXNNYXBwaW5nW2tleV0pKTtcbiAgfVxuICBjb21iaW5lVGltZXN0YW1wcyh0YWcsIGtleXNPZk1pc3NpbmcsIHByZXZpb3VzTWFwcGluZ3MsIG5leHRNYXBwaW5ncywgLi4ucmVzdCkgeyAvLyBSZXR1cm4gYSBtZXJnZWQgZGljdGlvbmFyeSBvZiB0aW1lc3RhbXAgPT4gaGFzaCwgY29udGFpbmluZyBhbGwgb2YgcHJldmlvdXMgYW5kIG5leHRNYXBwaW5ncy5cbiAgICAvLyBXZSdsbCBuZWVkIGEgbmV3IG9iamVjdCB0byBzdG9yZSB0aGUgdW5pb24sIGJlY2F1c2UgdGhlIGtleXMgbXVzdCBiZSBpbiB0aW1lIG9yZGVyLCBub3QgdGhlIG9yZGVyIHRoZXkgd2VyZSBhZGRlZC5cbiAgICBrZXlzT2ZNaXNzaW5nIHx8PSB0aGlzLm1pc3NpbmdLZXlzKHByZXZpb3VzTWFwcGluZ3MsIG5leHRNYXBwaW5ncyk7XG4gICAgY29uc3QgbWVyZ2VkID0ge307XG4gICAgbGV0IG1pc3NpbmdJbmRleCA9IDAsIG1pc3NpbmdUaW1lLCBuZXh0VGltZXM7XG4gICAgZm9yIChjb25zdCBuZXh0VGltZSBpbiBuZXh0TWFwcGluZ3MpIHtcbiAgICAgIG1pc3NpbmdUaW1lID0gMDtcblxuICAgICAgLy8gTWVyZ2UgYW55IHJlbWFpbmluZyBrZXlzT2ZNaXNzaW5nIHRoYXQgY29tZSBzdHJpY3RseSBiZWZvcmUgbmV4dFRpbWU6XG4gICAgICBpZiAobmV4dFRpbWUgIT09ICdsYXRlc3QnKSB7XG5cdGZvciAoOyAobWlzc2luZ0luZGV4IDwga2V5c09mTWlzc2luZy5sZW5ndGgpICYmICgobWlzc2luZ1RpbWUgPSBrZXlzT2ZNaXNzaW5nW21pc3NpbmdJbmRleF0pIDwgbmV4dFRpbWUpOyBtaXNzaW5nSW5kZXgrKykge1xuXHQgIG1lcmdlZFttaXNzaW5nVGltZV0gPSBwcmV2aW91c01hcHBpbmdzW21pc3NpbmdUaW1lXTtcblx0fVxuICAgICAgfVxuXG4gICAgICBpZiAobWlzc2luZ1RpbWUgPT09IG5leHRUaW1lKSB7IC8vIFR3byBkaWZmZXJlbnQgdmFsdWVzIGF0IHRoZSBleGFjdCBzYW1lIHRpbWUuIEV4dHJlbWVseSByYXJlLlxuXHRjb25zb2xlLndhcm4odGhpcy5mdWxsTGFiZWwsIGBVbnVzdWFsIG1hdGNoaW5nIHRpbWVzdGFtcCBjYXNlIGF0IHRpbWUgJHttaXNzaW5nVGltZX0gZm9yIHRhZyAke3RhZ30uYCk7XG5cdG5leHRUaW1lcyB8fD0gT2JqZWN0LmtleXMobmV4dE1hcHBpbmdzKTsgLy8gV2UgZGlkbid0IG5lZWQgdGhpcyBmb3Igb3VyIGxvb3AuIEdlbmVyYXRlIG5vdyBpZiBuZWVkZWQuXG5cdGNvbnN0IG5leHROZXh0VGltZSA9IE1hdGgubWluKGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4ICsgMV0gfHwgSW5maW5pdHksXG5cdFx0XHRcdCAgICAgIG5leHRNYXBwaW5nc1tuZXh0VGltZXMuaW5kZXhPZihuZXh0VGltZSkgKyAxXSB8fCBJbmZpbml0eSk7XG5cdGNvbnN0IGluc2VydFRpbWUgPSBuZXh0VGltZSArIChuZXh0TmV4dFRpbWUgLSBuZXh0VGltZSkgLyAyO1xuXHQvLyBXZSBhbHJlYWR5IHB1dCB0aGVzZSBpbiBvcmRlciB3aXRoIHByZXZpb3VzTWFwcGluZ3MgZmlyc3QuXG5cdG1lcmdlZFtuZXh0VGltZV0gPSBwcmV2aW91c01hcHBpbmdzW25leHRUaW1lXTtcblx0bWVyZ2VkW2luc2VydFRpbWVdID0gbmV4dE1hcHBpbmdzW25leHRUaW1lXTtcblxuICAgICAgfSBlbHNlIHsgLy8gTm8gY29uZmxpY3RzLiBKdXN0IGFkZCBuZXh0LlxuXHRtZXJnZWRbbmV4dFRpbWVdID0gbmV4dE1hcHBpbmdzW25leHRUaW1lXTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUaGVyZSBjYW4gYmUgbWlzc2luZyBzdHVmZiB0byBhZGQgYXQgdGhlIGVuZDtcbiAgICBmb3IgKDsgbWlzc2luZ0luZGV4IDwga2V5c09mTWlzc2luZy5sZW5ndGg7IG1pc3NpbmdJbmRleCsrKSB7XG4gICAgICBtaXNzaW5nVGltZSA9IGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4XTtcbiAgICAgIG1lcmdlZFttaXNzaW5nVGltZV0gPSBwcmV2aW91c01hcHBpbmdzW21pc3NpbmdUaW1lXTtcbiAgICB9XG4gICAgbGV0IG1lcmdlZFRpbWVzID0gT2JqZWN0LmtleXMobWVyZ2VkKTtcbiAgICBtZXJnZWQubGF0ZXN0ID0gbWVyZ2VkVGltZXNbbWVyZ2VkVGltZXMubGVuZ3RoIC0gMV07XG4gICAgcmV0dXJuIHJlc3QubGVuZ3RoID8gdGhpcy5jb21iaW5lVGltZXN0YW1wcyh0YWcsIHVuZGVmaW5lZCwgbWVyZ2VkLCAuLi5yZXN0KSA6IG1lcmdlZDtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyA9IHt9KSB7IC8vIEFuIGFycmF5IG9mIHVubWVyZ2VkIHNpZ25hdHVyZXMgY2FuIGJlIHZlcmlmaWVkLlxuICAgIGlmIChzaWduYXR1cmUuc3RhcnRzV2l0aD8uKCdbJykpIHNpZ25hdHVyZSA9IEpTT04ucGFyc2Uoc2lnbmF0dXJlKTsgLy8gKG1heWJlSW5mbGF0ZSBsb29rcyBmb3IgJ3snLCBub3QgJ1snLilcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoc2lnbmF0dXJlKSkgcmV0dXJuIGF3YWl0IHN1cGVyLnZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMpO1xuICAgIGNvbnN0IGNvbWJpbmVkID0gYXdhaXQgUHJvbWlzZS5hbGwoc2lnbmF0dXJlLm1hcChlbGVtZW50ID0+IHRoaXMudmVyaWZ5KGVsZW1lbnQsIG9wdGlvbnMpKSk7XG4gICAgY29uc3Qgb2sgPSBjb21iaW5lZC5ldmVyeShlbGVtZW50ID0+IGVsZW1lbnQpO1xuICAgIGlmICghb2spIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgcHJvdGVjdGVkSGVhZGVyID0gY29tYmluZWRbMF0ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGZvciAoY29uc3QgcHJvcGVydHkgb2YgWydpc3MnLCAna2lkJywgJ2FsZycsICdjdHknXSkgeyAvLyBPdXIgb3BlcmF0aW9ucyBtYWtlIHVzZSBvZiBpc3MsIGtpZCwgYW5kIGlhdC5cbiAgICAgIGNvbnN0IG1hdGNoaW5nID0gcHJvdGVjdGVkSGVhZGVyW3Byb3BlcnR5XTtcbiAgICAgIGNvbnN0IG1hdGNoZXMgPSBjb21iaW5lZC5ldmVyeShlbGVtZW50ID0+IGVsZW1lbnQucHJvdGVjdGVkSGVhZGVyW3Byb3BlcnR5XSA9PT0gbWF0Y2hpbmcpO1xuICAgICAgaWYgKG1hdGNoZXMpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFtYXRjaGVzKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBjb25zdCB7aXNzLCBraWQsIGFsZywgY3R5fSA9IHByb3RlY3RlZEhlYWRlcjtcbiAgICBjb25zdCB2ZXJpZmllZCA9IHtcbiAgICAgIHNpZ25hdHVyZSwgLy8gYXJyYXkgYXQgdGhpcyBwb2ludFxuICAgICAganNvbjogY29tYmluZWQubWFwKGVsZW1lbnQgPT4gZWxlbWVudC5qc29uKSxcbiAgICAgIHByb3RlY3RlZEhlYWRlcjoge2lzcywga2lkLCBhbGcsIGN0eSwgaWF0OiBNYXRoLm1heCguLi5jb21iaW5lZC5tYXAoZWxlbWVudCA9PiBlbGVtZW50LnByb3RlY3RlZEhlYWRlci5pYXQpKX1cbiAgICB9O1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgeyAvLyBiYWNrZGF0aW5nIGlzIGFsbG93ZWQuIChtZXJnaW5nKS5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIXRoaXMub3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpKSByZXR1cm4gJ25vdCBvd25lcic7XG4gICAgaWYgKCFhd2FpdCB0aGlzLnN1YmplY3RNYXRjaCh2ZXJpZmllZCkpIHJldHVybiAnd3JvbmcgaGFzaCc7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgb3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gVE9ETzogRWl0aGVyIHRoZXkgbXVzdCBtYXRjaCAoYXMgaW4gc3VwZXIpIG9yIHRoZSBuZXcgcGF5bG9hZCBtdXN0IGluY2x1ZGUgdGhlIHByZXZpb3VzLlxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cblxuLy8gV2hlbiBydW5uaW5nIGluIE5vZGVKUywgdGhlIFNlY3VyaXR5IG9iamVjdCBpcyBhdmFpbGFibGUgZGlyZWN0bHkuXG4vLyBJdCBoYXMgYSBTdG9yYWdlIHByb3BlcnR5LCB3aGljaCBkZWZpbmVzIHN0b3JlL3JldHJpZXZlIChpbiBsaWIvc3RvcmFnZS5tanMpIHRvIEdFVC9QVVQgb25cbi8vIC4uLi86ZnVsbExhYmVsLzpwYXJ0MW9mVGFnLzpwYXJ0Mm9mVGFnLzpwYXJ0M29mVGFnLzpyZXN0T2ZUYWcuanNvblxuLy8gVGhlIFNlY3VyaXR5LlN0b3JhZ2UgY2FuIGJlIHNldCBieSBjbGllbnRzIHRvIHNvbWV0aGluZyBlbHNlLlxuLy9cbi8vIFdoZW4gcnVubmluZyBpbiBhIGJyb3dzZXIsIHdvcmtlci5qcyBvdmVycmlkZXMgdGhpcyB0byBzZW5kIG1lc3NhZ2VzIHRocm91Z2ggdGhlIEpTT04gUlBDXG4vLyB0byB0aGUgYXBwLCB3aGljaCB0aGVuIGFsc28gaGFzIGFuIG92ZXJyaWRhYmxlIFNlY3VyaXR5LlN0b3JhZ2UgdGhhdCBpcyBpbXBsZW1lbnRlZCB3aXRoIHRoZSBzYW1lIGNvZGUgYXMgYWJvdmUuXG5cbi8vIEJhc2ggaW4gc29tZSBuZXcgc3R1ZmY6XG5DcmVkZW50aWFscy5hdXRob3IgPSBudWxsO1xuQ3JlZGVudGlhbHMub3duZXIgPSBudWxsO1xuQ3JlZGVudGlhbHMuZW5jcnlwdGlvbiA9IG51bGw7IC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGF1ZGllbmNlXG5DcmVkZW50aWFscy5zeW5jaHJvbml6ZSA9IGFzeW5jICguLi5zZXJ2aWNlcykgPT4geyAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBjb25uZWN0LlxuICAvLyBXZSBjYW4gZG8gYWxsIHRocmVlIGluIHBhcmFsbGVsIC0tIHdpdGhvdXQgd2FpdGluZyBmb3IgY29tcGxldGlvbiAtLSBiZWNhdXNlIGRlcGVuZGVuY2llcyB3aWxsIGdldCBzb3J0ZWQgb3V0IGJ5IHN5bmNocm9uaXplMS5cbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uc3luY2hyb25pemUoLi4uc2VydmljZXMpKSk7XG59O1xuQ3JlZGVudGlhbHMuc3luY2hyb25pemVkID0gYXN5bmMgKCkgPT4ge1xuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5zeW5jaHJvbml6ZWQpKTtcbn1cbkNyZWRlbnRpYWxzLmRpc2Nvbm5lY3QgPSBhc3luYyAoLi4uc2VydmljZXMpID0+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZGlzY29ubmVjdCguLi5zZXJ2aWNlcykpKTtcbn1cblxuQ3JlZGVudGlhbHMuY3JlYXRlQXV0aG9yID0gYXN5bmMgKHByb21wdCkgPT4geyAvLyBDcmVhdGUgYSB1c2VyOlxuICAvLyBJZiBwcm9tcHQgaXMgJy0nLCBjcmVhdGVzIGFuIGludml0YXRpb24gYWNjb3VudCwgd2l0aCBhIG5vLW9wIHJlY292ZXJ5IGFuZCBubyBkZXZpY2UuXG4gIC8vIE90aGVyd2lzZSwgcHJvbXB0IGluZGljYXRlcyB0aGUgcmVjb3ZlcnkgcHJvbXB0cywgYW5kIHRoZSBhY2NvdW50IGhhcyB0aGF0IGFuZCBhIGRldmljZS5cbiAgaWYgKHByb21wdCA9PT0gJy0nKSByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0fSkpO1xuICBjb25zdCBbbG9jYWwsIHJlY292ZXJ5XSA9IGF3YWl0IFByb21pc2UuYWxsKFtDcmVkZW50aWFscy5jcmVhdGUoKSwgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHR9KV0pO1xuICByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGxvY2FsLCByZWNvdmVyeSk7XG59O1xuQ3JlZGVudGlhbHMuY2xhaW1JbnZpdGF0aW9uID0gYXN5bmMgKHRhZywgbmV3UHJvbXB0KSA9PiB7IC8vIENyZWF0ZXMgYSBsb2NhbCBkZXZpY2UgdGFnIGFuZCBhZGRzIGl0IHRvIHRoZSBnaXZlbiBpbnZpdGF0aW9uIHRhZyxcbiAgLy8gdXNpbmcgdGhlIHNlbGYtdmFsaWRhdGluZyByZWNvdmVyeSBtZW1iZXIgdGhhdCBpcyB0aGVuIHJlbW92ZWQgYW5kIGRlc3Ryb3llZC5cbiAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBDcmVkZW50aWFscy5jb2xsZWN0aW9ucy5UZWFtLnJldHJpZXZlKHt0YWd9KTtcbiAgaWYgKCF2ZXJpZmllZCkgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gdmVyaWZ5IGludml0YXRpb24gJHt0YWd9LmApO1xuICBjb25zdCBtZW1iZXJzID0gdmVyaWZpZWQuanNvbi5yZWNpcGllbnRzO1xuICBpZiAobWVtYmVycy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgSW52aXRhdGlvbnMgc2hvdWxkIGhhdmUgb25lIG1lbWJlcjogJHt0YWd9YCk7XG4gIGNvbnN0IG9sZFJlY292ZXJ5VGFnID0gbWVtYmVyc1swXS5oZWFkZXIua2lkO1xuICBjb25zdCBuZXdSZWNvdmVyeVRhZyA9IGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0OiBuZXdQcm9tcHR9KTtcbiAgY29uc3QgZGV2aWNlVGFnID0gYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKCk7XG5cbiAgLy8gV2UgbmVlZCB0byBhZGQgdGhlIG5ldyBtZW1iZXJzIGluIG9uZSBjaGFuZ2VNZW1iZXJzaGlwIHN0ZXAsIGFuZCB0aGVuIHJlbW92ZSB0aGUgb2xkUmVjb3ZlcnlUYWcgaW4gYSBzZWNvbmQgY2FsbCB0byBjaGFuZ2VNZW1iZXJzaGlwOlxuICAvLyBjaGFuZ2VNZW1iZXJzaGlwIHdpbGwgc2lnbiBieSBhbiBPTEQgbWVtYmVyIC0gSWYgaXQgc2lnbmVkIGJ5IG5ldyBtZW1iZXIgdGhhbiBwZW9wbGUgY291bGQgYm9vdHN0cmFwIHRoZW1zZWx2ZXMgb250byBhIHRlYW0uXG4gIC8vIEJ1dCBpZiB3ZSByZW1vdmUgdGhlIG9sZFJlY292ZXJ5IHRhZyBpbiB0aGUgc2FtZSBzdGVwIGFzIGFkZGluZyB0aGUgbmV3LCB0aGUgdGVhbSB3b3VsZCBiZSBzaWduZWQgYnkgc29tZW9uZSAodGhlIG9sZFJlY292ZXJ5VGFnKSB0aGF0XG4gIC8vIGlzIG5vIGxvbmdlciBhIG1lbWJlciwgYW5kIHNvIHRoZSB0ZWFtIHdvdWxkIG5vdCB2ZXJpZnkhXG4gIGF3YWl0IENyZWRlbnRpYWxzLmNoYW5nZU1lbWJlcnNoaXAoe3RhZywgYWRkOiBbZGV2aWNlVGFnLCBuZXdSZWNvdmVyeVRhZ10sIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5jaGFuZ2VNZW1iZXJzaGlwKHt0YWcsIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5kZXN0cm95KG9sZFJlY292ZXJ5VGFnKTtcbiAgcmV0dXJuIHRhZztcbn07XG5jb25zdCBhbnN3ZXJzID0ge307IC8vIFRPRE86IG1ha2Ugc2V0QW5zd2VyIGluY2x1ZGUgdGFnIGFzIHdlbGwgYXMgcHJvbXB0LlxuQ3JlZGVudGlhbHMuc2V0QW5zd2VyID0gKHByb21wdCwgYW5zd2VyKSA9PiBhbnN3ZXJzW3Byb21wdF0gPSBhbnN3ZXI7XG5DcmVkZW50aWFscy5nZXRVc2VyRGV2aWNlU2VjcmV0ID0gZnVuY3Rpb24gZmxleHN0b3JlU2VjcmV0KHRhZywgcHJvbXB0U3RyaW5nKSB7XG4gIGlmICghcHJvbXB0U3RyaW5nKSByZXR1cm4gdGFnO1xuICBpZiAocHJvbXB0U3RyaW5nID09PSAnLScpIHJldHVybiBwcm9tcHRTdHJpbmc7IC8vIFNlZSBjcmVhdGVBdXRob3IuXG4gIGlmIChhbnN3ZXJzW3Byb21wdFN0cmluZ10pIHJldHVybiBhbnN3ZXJzW3Byb21wdFN0cmluZ107XG4gIC8vIERpc3RyaWJ1dGVkIFNlY3VyaXR5IHdpbGwgdHJ5IGV2ZXJ5dGhpbmcuIFVubGVzcyBnb2luZyB0aHJvdWdoIGEgcGF0aCBhYm92ZSwgd2Ugd291bGQgbGlrZSBvdGhlcnMgdG8gc2lsZW50bHkgZmFpbC5cbiAgY29uc29sZS5sb2coYEF0dGVtcHRpbmcgYWNjZXNzICR7dGFnfSB3aXRoIHByb21wdCAnJHtwcm9tcHRTdHJpbmd9Jy5gKTtcbiAgcmV0dXJuIFwibm90IGEgc2VjcmV0XCI7IC8vIHRvZG86IGNyeXB0byByYW5kb21cbn07XG5cblxuLy8gVGhlc2UgdHdvIGFyZSB1c2VkIGRpcmVjdGx5IGJ5IGRpc3RyaWJ1dGVkLXNlY3VyaXR5LlxuQ3JlZGVudGlhbHMuU3RvcmFnZS5yZXRyaWV2ZSA9IGFzeW5jIChjb2xsZWN0aW9uTmFtZSwgdGFnKSA9PiB7XG4gIGNvbnN0IGNvbGxlY3Rpb24gPSBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tjb2xsZWN0aW9uTmFtZV07XG4gIC8vIE5vIG5lZWQgdG8gdmVyaWZ5LCBhcyBkaXN0cmlidXRlZC1zZWN1cml0eSBkb2VzIHRoYXQgaXRzZWxmIHF1aXRlIGNhcmVmdWxseSBhbmQgdGVhbS1hd2FyZS5cbiAgaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnRW5jcnlwdGlvbktleScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7XG4gIGlmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ0tleVJlY292ZXJ5JykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTtcbiAgLy9pZiAoY29sbGVjdGlvbk5hbWUgPT09ICdUZWFtJykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTsgICAgLy8gVGhpcyB3b3VsZCBnbyBjaXJjdWxhci4gU2hvdWxkIGl0PyBEbyB3ZSBuZWVkIGl0P1xuICBjb25zdCBkYXRhID0gYXdhaXQgY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgLy8gSG93ZXZlciwgc2luY2Ugd2UgaGF2ZSBieXBhc3NlZCBDb2xsZWN0aW9uLnJldHJpZXZlLCB3ZSBtYXliZUluZmxhdGUgaGVyZS5cbiAgcmV0dXJuIENvbGxlY3Rpb24ubWF5YmVJbmZsYXRlKGRhdGEpO1xufVxuY29uc3QgRU1QVFlfU1RSSU5HX0hBU0ggPSBcIjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlVcIjsgLy8gSGFzaCBvZiBhbiBlbXB0eSBzdHJpbmcuXG5DcmVkZW50aWFscy5TdG9yYWdlLnN0b3JlID0gYXN5bmMgKGNvbGxlY3Rpb25OYW1lLCB0YWcsIHNpZ25hdHVyZSkgPT4ge1xuICAvLyBObyBuZWVkIHRvIGVuY3J5cHQvc2lnbiBhcyBieSBzdG9yZSwgc2luY2UgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgZG9lcyB0aGF0IGluIGEgY2lyY3VsYXJpdHktYXdhcmUgd2F5LlxuICAvLyBIb3dldmVyLCB3ZSBkbyBjdXJyZW50bHkgbmVlZCB0byBmaW5kIG91dCBvZiB0aGUgc2lnbmF0dXJlIGhhcyBhIHBheWxvYWQgYW5kIHB1c2hcbiAgLy8gVE9ETzogTW9kaWZ5IGRpc3Qtc2VjIHRvIGhhdmUgYSBzZXBhcmF0ZSBzdG9yZS9kZWxldGUsIHJhdGhlciB0aGFuIGhhdmluZyB0byBmaWd1cmUgdGhpcyBvdXQgaGVyZS5cbiAgY29uc3QgY2xhaW1zID0gQ3JlZGVudGlhbHMuZGVjb2RlQ2xhaW1zKHNpZ25hdHVyZSk7XG4gIGNvbnN0IGVtcHR5UGF5bG9hZCA9IGNsYWltcz8uc3ViID09PSBFTVBUWV9TVFJJTkdfSEFTSDtcblxuICBjb25zdCBjb2xsZWN0aW9uID0gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbY29sbGVjdGlvbk5hbWVdO1xuICBzaWduYXR1cmUgPSBDb2xsZWN0aW9uLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICBjb25zdCBzdG9yZWQgPSBhd2FpdCAoZW1wdHlQYXlsb2FkID8gY29sbGVjdGlvbi5kZWxldGUodGFnLCBzaWduYXR1cmUpIDogY29sbGVjdGlvbi5wdXQodGFnLCBzaWduYXR1cmUpKTtcbiAgaWYgKHN0b3JlZCAhPT0gdGFnKSB0aHJvdyBuZXcgRXJyb3IoYFVuYWJsZSB0byB3cml0ZSBjcmVkZW50aWFsICR7dGFnfS5gKTtcbiAgaWYgKHRhZykgYXdhaXQgY29sbGVjdGlvbi5wdXNoKGVtcHR5UGF5bG9hZCA/ICdkZWxldGUnOiAncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICByZXR1cm4gdGFnO1xufTtcbkNyZWRlbnRpYWxzLlN0b3JhZ2UuZGVzdHJveSA9IGFzeW5jICgpID0+IHtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2xlYXIoKTsgLy8gV2lwZSBmcm9tIGxpdmUgbWVtb3J5LlxuICBhd2FpdCBQcm9taXNlLmFsbChPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKS5tYXAoYXN5bmMgY29sbGVjdGlvbiA9PiB7XG4gICAgYXdhaXQgY29sbGVjdGlvbi5kaXNjb25uZWN0KCk7XG4gICAgY29uc3Qgc3RvcmUgPSBhd2FpdCBjb2xsZWN0aW9uLnBlcnNpc3RlbmNlU3RvcmU7XG4gICAgc3RvcmUuZGVzdHJveSgpOyAvLyBEZXN0cm95IHRoZSBwZXJzaXN0ZW50IGNhY2hlLlxuICB9KSk7XG4gIGF3YWl0IENyZWRlbnRpYWxzLndpcGVEZXZpY2VLZXlzKCk7IC8vIE5vdCBpbmNsdWRlZCBpbiB0aGUgYWJvdmUuXG59O1xuQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMgPSB7fTtcbmV4cG9ydCB7IENyZWRlbnRpYWxzLCBTdG9yYWdlTG9jYWwgfTtcblsnRW5jcnlwdGlvbktleScsICdLZXlSZWNvdmVyeScsICdUZWFtJ10uZm9yRWFjaChuYW1lID0+IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW25hbWVdID0gbmV3IE11dGFibGVDb2xsZWN0aW9uKHtuYW1lfSkpO1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHV1aWQ0IGZyb20gJ3V1aWQ0JztcbmltcG9ydCBTeW5jaHJvbml6ZXIgZnJvbSAnLi9saWIvc3luY2hyb25pemVyLm1qcyc7XG5pbXBvcnQgeyBDb2xsZWN0aW9uLCBJbW11dGFibGVDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgVmVyc2lvbkNvbGxlY3Rpb24sIFN0b3JhZ2VMb2NhbCB9IGZyb20gICcuL2xpYi9jb2xsZWN0aW9ucy5tanMnO1xuaW1wb3J0IHsgV2ViUlRDLCBQcm9taXNlV2ViUlRDLCBTaGFyZWRXZWJSVEMgfSBmcm9tICcuL2xpYi93ZWJydGMubWpzJztcbmltcG9ydCB7IHZlcnNpb24sIG5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBzdG9yYWdlTmFtZSB9IGZyb20gJy4vbGliL3ZlcnNpb24ubWpzJztcblxuY29uc29sZS5sb2coYCR7bmFtZX0gJHt2ZXJzaW9ufSBmcm9tICR7aW1wb3J0Lm1ldGEudXJsfS5gKTtcblxuZXhwb3J0IHsgQ3JlZGVudGlhbHMsIENvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIE11dGFibGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBWZXJzaW9uQ29sbGVjdGlvbiwgU3luY2hyb25pemVyLCBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQywgbmFtZSwgdmVyc2lvbiwgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBTdG9yYWdlTG9jYWwsIHV1aWQ0IH07XG5leHBvcnQgZGVmYXVsdCB7IENyZWRlbnRpYWxzLCBDb2xsZWN0aW9uLCBJbW11dGFibGVDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgVmVyc2lvbkNvbGxlY3Rpb24sIFN5bmNocm9uaXplciwgV2ViUlRDLCBQcm9taXNlV2ViUlRDLCBTaGFyZWRXZWJSVEMsIG5hbWUsIHZlcnNpb24sICBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24sIFN0b3JhZ2VM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QUFLLFNBQVMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssRUFBRSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLElBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsVUFBVSxFQUFFLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDLElBQUksTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEdBQUUsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBQyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxTQUFTLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLE1BQU0sWUFBWSxTQUFTLFdBQVcsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksTUFBTSxDQUFDLENBQUMsRUFBRSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBQyxDQUFDLE1BQU0sWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFNLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLENBQUMs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
