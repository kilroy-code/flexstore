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
var version$1 = "0.0.52";
var _package = {
	name: name$1,
	version: version$1};

// name/version of "database"
const storageName = 'flexstore';
const storageVersion = 9;
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
    if (!version) {  // Mismatch.
      await this.disconnect();
      const message = `${this.serviceName} does not use a compatible version.`;
      if (typeof(window) === 'undefined') {
	console.error(message);
      } else { // If we're in a browser, tell the user.
	console.log({version, minVersion, maxVersion, caches: await window.caches.keys(), registrations: await navigator.serviceWorker.getRegistrations(), dbs: await window.indexedDB.databases(), local: window.localStorage.length});
	window.alert(message);
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
  for (let collection of Object.values(Credentials.collections)) {
    await collection.destroy();
  }
  await Credentials.wipeDeviceKeys(); // Not included in the above.
};
Credentials.collections = {};
['EncryptionKey', 'KeyRecovery', 'Team'].forEach(name => Credentials.collections[name] = new MutableCollection({name}));

console.log(`${name} ${version} from ${import.meta.url}.`);
var index = { Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection, VersionCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version,  storageName, storageVersion, StorageLocal: StorageCache, uuid4 };

export { Collection, ImmutableCollection, MutableCollection, PromiseWebRTC, SharedWebRTC, StorageCache as StorageLocal, Synchronizer, VersionCollection, VersionedCollection, WebRTC, index as default, name, storageName, storageVersion, uuid4, version };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsibm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0BraTFyMHkvc3RvcmFnZS9idW5kbGUubWpzIiwibGliL2NvbGxlY3Rpb25zLm1qcyIsImluZGV4Lm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB1dWlkUGF0dGVybiA9IC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tNFswLTlhLWZdezN9LVs4OWFiXVswLTlhLWZdezN9LVswLTlhLWZdezEyfSQvaTtcbmZ1bmN0aW9uIHZhbGlkKHV1aWQpIHtcbiAgcmV0dXJuIHV1aWRQYXR0ZXJuLnRlc3QodXVpZCk7XG59XG5cbi8vIEJhc2VkIG9uIGh0dHBzOi8vYWJoaXNoZWtkdXR0YS5vcmcvYmxvZy9zdGFuZGFsb25lX3V1aWRfZ2VuZXJhdG9yX2luX2phdmFzY3JpcHQuaHRtbFxuLy8gSUUxMSBhbmQgTW9kZXJuIEJyb3dzZXJzIE9ubHlcbmZ1bmN0aW9uIHV1aWQ0KCkge1xuICB2YXIgdGVtcF91cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKCkpO1xuICB2YXIgdXVpZCA9IHRlbXBfdXJsLnRvU3RyaW5nKCk7XG4gIFVSTC5yZXZva2VPYmplY3RVUkwodGVtcF91cmwpO1xuICByZXR1cm4gdXVpZC5zcGxpdCgvWzpcXC9dL2cpLnBvcCgpLnRvTG93ZXJDYXNlKCk7IC8vIHJlbW92ZSBwcmVmaXhlc1xufVxudXVpZDQudmFsaWQgPSB2YWxpZDtcblxuZXhwb3J0IGRlZmF1bHQgdXVpZDQ7XG5leHBvcnQgeyB1dWlkNCwgdmFsaWQgfTtcbiIsIi8vIEluIGEgYnJvd3Nlciwgd3J0YyBwcm9wZXJ0aWVzIHN1Y2ggYXMgUlRDUGVlckNvbm5lY3Rpb24gYXJlIGluIGdsb2JhbFRoaXMuXG5leHBvcnQgZGVmYXVsdCBnbG9iYWxUaGlzO1xuIiwiaW1wb3J0IHV1aWQ0IGZyb20gJ3V1aWQ0JztcblxuLy8gU2VlIHJvbGx1cC5jb25maWcubWpzXG5pbXBvcnQgd3J0YyBmcm9tICcjd3J0Yyc7XG4vL2NvbnN0IHtkZWZhdWx0OndydGN9ID0gYXdhaXQgKCh0eXBlb2YocHJvY2VzcykgIT09ICd1bmRlZmluZWQnKSA/IGltcG9ydCgnQHJvYW1ocS93cnRjJykgOiB7ZGVmYXVsdDogZ2xvYmFsVGhpc30pO1xuXG5jb25zdCBpY2VTZXJ2ZXJzID0gW1xuICB7IHVybHM6ICdzdHVuOnN0dW4ubC5nb29nbGUuY29tOjE5MzAyJ30sXG4gIC8vIGh0dHBzOi8vZnJlZXN0dW4ubmV0LyAgQ3VycmVudGx5IDUwIEtCaXQvcy4gKDIuNSBNQml0L3MgZm9ycyAkOS9tb250aClcbiAgeyB1cmxzOiAnc3R1bjpmcmVlc3R1bi5uZXQ6MzQ3OCcgfSxcbiAgLy97IHVybHM6ICd0dXJuOmZyZWVzdHVuLm5ldDozNDc4JywgdXNlcm5hbWU6ICdmcmVlJywgY3JlZGVudGlhbDogJ2ZyZWUnIH0sXG4gIC8vIFByZXN1bWFibHkgdHJhZmZpYyBsaW1pdGVkLiBDYW4gZ2VuZXJhdGUgbmV3IGNyZWRlbnRpYWxzIGF0IGh0dHBzOi8vc3BlZWQuY2xvdWRmbGFyZS5jb20vdHVybi1jcmVkc1xuICAvLyBBbHNvIGh0dHBzOi8vZGV2ZWxvcGVycy5jbG91ZGZsYXJlLmNvbS9jYWxscy8gMSBUQi9tb250aCwgYW5kICQwLjA1IC9HQiBhZnRlciB0aGF0LlxuICB7IHVybHM6ICd0dXJuOnR1cm4uc3BlZWQuY2xvdWRmbGFyZS5jb206NTAwMDAnLCB1c2VybmFtZTogJzgyNjIyNjI0NGNkNmU1ZWRiM2Y1NTc0OWI3OTYyMzVmNDIwZmU1ZWU3ODg5NWUwZGQ3ZDJiYWE0NWUxZjdhOGY0OWU5MjM5ZTc4NjkxYWIzOGI3MmNlMDE2NDcxZjc3NDZmNTI3N2RjZWY4NGFkNzlmYzYwZjgwMjBiMTMyYzczJywgY3JlZGVudGlhbDogJ2FiYTliMTY5NTQ2ZWI2ZGNjN2JmYjFjZGYzNDU0NGNmOTViNTE2MWQ2MDJlM2I1ZmE3YzgzNDJiMmU5ODAyZmInIH1cbiAgLy8gaHR0cHM6Ly9mYXN0dHVybi5uZXQvIEN1cnJlbnRseSA1MDBNQi9tb250aD8gKDI1IEdCL21vbnRoIGZvciAkOS9tb250aClcbiAgLy8gaHR0cHM6Ly94aXJzeXMuY29tL3ByaWNpbmcvIDUwMCBNQi9tb250aCAoNTAgR0IvbW9udGggZm9yICQzMy9tb250aClcbiAgLy8gQWxzbyBodHRwczovL3d3dy5ucG1qcy5jb20vcGFja2FnZS9ub2RlLXR1cm4gb3IgaHR0cHM6Ly9tZWV0cml4LmlvL2Jsb2cvd2VicnRjL2NvdHVybi9pbnN0YWxsYXRpb24uaHRtbFxuXTtcblxuLy8gVXRpbGl0eSB3cmFwcGVyIGFyb3VuZCBSVENQZWVyQ29ubmVjdGlvbi5cbi8vIFdoZW4gc29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIChzdWNoIGFzIGNyZWF0ZURhdGFDaGFubmVsKSwgaXQgd2lsbCBnZW5lcmF0ZSBjYWxscyB0byBzaWduYWwoKSwgd2hpY2ggbmVlZHMgdG8gYmUgZGVmaW5lZCBieSBzdWJjbGFzc2VzLlxuZXhwb3J0IGNsYXNzIFdlYlJUQyB7XG4gIGNvbnN0cnVjdG9yKHtsYWJlbCA9ICcnLCBjb25maWd1cmF0aW9uID0gbnVsbCwgdXVpZCA9IHV1aWQ0KCksIGRlYnVnID0gZmFsc2UsIGVycm9yID0gY29uc29sZS5lcnJvciwgLi4ucmVzdH0gPSB7fSkge1xuICAgIGNvbmZpZ3VyYXRpb24gPz89IHtpY2VTZXJ2ZXJzfTsgLy8gSWYgY29uZmlndXJhdGlvbiBjYW4gYmUgb21taXR0ZWQgb3IgZXhwbGljaXRseSBhcyBudWxsLCB1c2Ugb3VyIGRlZmF1bHQuIEJ1dCBpZiB7fSwgbGVhdmUgaXQgYmUuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7bGFiZWwsIGNvbmZpZ3VyYXRpb24sIHV1aWQsIGRlYnVnLCBlcnJvciwgLi4ucmVzdH0pO1xuICAgIHRoaXMucmVzZXRQZWVyKCk7XG4gIH1cbiAgc2lnbmFsKHR5cGUsIG1lc3NhZ2UpIHsgLy8gU3ViY2xhc3NlcyBtdXN0IG92ZXJyaWRlIG9yIGV4dGVuZC4gRGVmYXVsdCBqdXN0IGxvZ3MuXG4gICAgdGhpcy5sb2coJ3NlbmRpbmcnLCB0eXBlLCB0eXBlLmxlbmd0aCwgSlNPTi5zdHJpbmdpZnkobWVzc2FnZSkubGVuZ3RoKTtcbiAgfVxuXG4gIHBlZXJWZXJzaW9uID0gMDtcbiAgcmVzZXRQZWVyKCkgeyAvLyBTZXQgdXAgYSBuZXcgUlRDUGVlckNvbm5lY3Rpb24uIChDYWxsZXIgbXVzdCBjbG9zZSBvbGQgaWYgbmVjZXNzYXJ5LilcbiAgICBjb25zdCBvbGQgPSB0aGlzLnBlZXI7XG4gICAgaWYgKG9sZCkge1xuICAgICAgb2xkLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBvbGQub25pY2VjYW5kaWRhdGUgPSBvbGQub25pY2VjYW5kaWRhdGVlcnJvciA9IG9sZC5vbmNvbm5lY3Rpb25zdGF0ZWNoYW5nZSA9IG51bGw7XG4gICAgICAvLyBEb24ndCBjbG9zZSB1bmxlc3MgaXQncyBiZWVuIG9wZW5lZCwgYmVjYXVzZSB0aGVyZSBhcmUgbGlrZWx5IGhhbmRsZXJzIHRoYXQgd2UgZG9uJ3Qgd2FudCB0byBmaXJlLlxuICAgICAgaWYgKG9sZC5jb25uZWN0aW9uU3RhdGUgIT09ICduZXcnKSBvbGQuY2xvc2UoKTtcbiAgICB9XG4gICAgY29uc3QgcGVlciA9IHRoaXMucGVlciA9IG5ldyB3cnRjLlJUQ1BlZXJDb25uZWN0aW9uKHRoaXMuY29uZmlndXJhdGlvbik7XG4gICAgcGVlci52ZXJzaW9uSWQgPSB0aGlzLnBlZXJWZXJzaW9uKys7XG4gICAgcGVlci5vbm5lZ290aWF0aW9ubmVlZGVkID0gZXZlbnQgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZChldmVudCk7XG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZSA9IGV2ZW50ID0+IHRoaXMub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gICAgLy8gSSBkb24ndCB0aGluayBhbnlvbmUgYWN0dWFsbHkgc2lnbmFscyB0aGlzLiBJbnN0ZWFkLCB0aGV5IHJlamVjdCBmcm9tIGFkZEljZUNhbmRpZGF0ZSwgd2hpY2ggd2UgaGFuZGxlIHRoZSBzYW1lLlxuICAgIHBlZXIub25pY2VjYW5kaWRhdGVlcnJvciA9IGVycm9yID0+IHRoaXMuaWNlY2FuZGlkYXRlRXJyb3IoZXJyb3IpO1xuICAgIC8vIEkgdGhpbmsgdGhpcyBpcyByZWR1bmRuYW50IGJlY2F1c2Ugbm8gaW1wbGVtZW50YXRpb24gZmlyZXMgdGhpcyBldmVudCBhbnkgc2lnbmlmaWNhbnQgdGltZSBhaGVhZCBvZiBlbWl0dGluZyBpY2VjYW5kaWRhdGUgd2l0aCBhbiBlbXB0eSBldmVudC5jYW5kaWRhdGUuXG4gICAgcGVlci5vbmljZWdhdGhlcmluZ3N0YXRlY2hhbmdlID0gZXZlbnQgPT4gKHBlZXIuaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScpICYmIHRoaXMub25Mb2NhbEVuZEljZTtcbiAgICBwZWVyLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gZXZlbnQgPT4gdGhpcy5jb25uZWN0aW9uU3RhdGVDaGFuZ2UodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIFRoZSBzcGVjIHNheXMgdGhhdCBhIG51bGwgY2FuZGlkYXRlIHNob3VsZCBub3QgYmUgc2VudCwgYnV0IHRoYXQgYW4gZW1wdHkgc3RyaW5nIGNhbmRpZGF0ZSBzaG91bGQuIFNhZmFyaSAodXNlZCB0bz8pIGdldCBlcnJvcnMgZWl0aGVyIHdheS5cbiAgICBpZiAoIWV2ZW50LmNhbmRpZGF0ZSB8fCAhZXZlbnQuY2FuZGlkYXRlLmNhbmRpZGF0ZSkgdGhpcy5vbkxvY2FsRW5kSWNlKCk7XG4gICAgZWxzZSB0aGlzLnNpZ25hbCgnaWNlY2FuZGlkYXRlJywgZXZlbnQuY2FuZGlkYXRlKTtcbiAgfVxuICBvbkxvY2FsRW5kSWNlKCkgeyAvLyBUcmlnZ2VyZWQgb24gb3VyIHNpZGUgYnkgYW55L2FsbCBvZiBvbmljZWNhbmRpZGF0ZSB3aXRoIG5vIGV2ZW50LmNhbmRpZGF0ZSwgaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScuXG4gICAgLy8gSS5lLiwgY2FuIGhhcHBlbiBtdWx0aXBsZSB0aW1lcy4gU3ViY2xhc3NlcyBtaWdodCBkbyBzb21ldGhpbmcuXG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKCh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnbmV3JykgJiYgKHRoaXMucGVlci5zaWduYWxpbmdTdGF0ZSA9PT0gJ3N0YWJsZScpKSByZXR1cm47XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBjb25uZWN0aW9uU3RhdGVDaGFuZ2Uoc3RhdGUpIHtcbiAgICB0aGlzLmxvZygnc3RhdGUgY2hhbmdlOicsIHN0YXRlKTtcbiAgICBpZiAoWydkaXNjb25uZWN0ZWQnLCAnZmFpbGVkJywgJ2Nsb3NlZCddLmluY2x1ZGVzKHN0YXRlKSkgdGhpcy5jbG9zZSgpOyAvLyBPdGhlciBiZWhhdmlvciBhcmUgcmVhc29uYWJsZSwgdG9sby5cbiAgfVxuICBuZWdvdGlhdGlvbm5lZWRlZCgpIHsgLy8gU29tZXRoaW5nIGhhcyBjaGFuZ2VkIGxvY2FsbHkgKG5ldyBzdHJlYW0sIG9yIG5ldHdvcmsgY2hhbmdlKSwgc3VjaCB0aGF0IHdlIGhhdmUgdG8gc3RhcnQgbmVnb3RpYXRpb24uXG4gICAgdGhpcy5sb2coJ25lZ290aWF0aW9ubm5lZWRlZCcpO1xuICAgIHRoaXMucGVlci5jcmVhdGVPZmZlcigpXG4gICAgICAudGhlbihvZmZlciA9PiB7XG4gICAgICAgIHRoaXMucGVlci5zZXRMb2NhbERlc2NyaXB0aW9uKG9mZmVyKTsgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIG9mZmVyXG5cdHJldHVybiBvZmZlcjtcbiAgICAgIH0pXG4gICAgICAudGhlbihvZmZlciA9PiB0aGlzLnNpZ25hbCgnb2ZmZXInLCBvZmZlcikpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZEVycm9yKGVycm9yKSk7XG4gIH1cbiAgb2ZmZXIob2ZmZXIpIHsgLy8gSGFuZGxlciBmb3IgcmVjZWl2aW5nIGFuIG9mZmVyIGZyb20gdGhlIG90aGVyIHVzZXIgKHdobyBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2VzcykuXG4gICAgLy8gTm90ZSB0aGF0IGR1cmluZyBzaWduYWxpbmcsIHdlIHdpbGwgcmVjZWl2ZSBuZWdvdGlhdGlvbm5lZWRlZC9hbnN3ZXIsIG9yIG9mZmVyLCBidXQgbm90IGJvdGgsIGRlcGVuZGluZ1xuICAgIC8vIG9uIHdoZXRoZXIgd2Ugd2VyZSB0aGUgb25lIHRoYXQgc3RhcnRlZCB0aGUgc2lnbmFsaW5nIHByb2Nlc3MuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKG9mZmVyKVxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnBlZXIuY3JlYXRlQW5zd2VyKCkpXG4gICAgICAudGhlbihhbnN3ZXIgPT4gdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyKSkgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIGFuc3dlclxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnNpZ25hbCgnYW5zd2VyJywgdGhpcy5wZWVyLmxvY2FsRGVzY3JpcHRpb24pKTtcbiAgfVxuICBhbnN3ZXIoYW5zd2VyKSB7IC8vIEhhbmRsZXIgZm9yIGZpbmlzaGluZyB0aGUgc2lnbmFsaW5nIHByb2Nlc3MgdGhhdCB3ZSBzdGFydGVkLlxuICAgIHRoaXMucGVlci5zZXRSZW1vdGVEZXNjcmlwdGlvbihhbnN3ZXIpO1xuICB9XG4gIGljZWNhbmRpZGF0ZShpY2VDYW5kaWRhdGUpIHsgLy8gSGFuZGxlciBmb3IgYSBuZXcgY2FuZGlkYXRlIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZCB0aHJvdWdoIHNpZ25hbGluZy5cbiAgICB0aGlzLnBlZXIuYWRkSWNlQ2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkuY2F0Y2goZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcikpO1xuICB9XG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnJlc3QpO1xuICB9XG4gIGxvZ0Vycm9yKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgY29uc3QgZGF0YSA9IFt0aGlzLmxhYmVsLCB0aGlzLnBlZXIudmVyc2lvbklkLCAuLi50aGlzLmNvbnN0cnVjdG9yLmdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbildO1xuICAgIHRoaXMuZXJyb3IoZGF0YSk7XG4gICAgcmV0dXJuIGRhdGE7XG4gIH1cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7XG4gIH1cbiAgc3RhdGljIGdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbikge1xuICAgIHJldHVybiBbXG4gICAgICBsYWJlbCArIFwiIGVycm9yOlwiLFxuICAgICAgZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzIHx8IFwiXCIsIC8vIEZpcnN0IGlzIGRlcHJlY2F0ZWQsIGJ1dCBzdGlsbCB1c2VmdWwuXG4gICAgICBldmVudE9yRXhjZXB0aW9uLnVybCB8fCBldmVudE9yRXhjZXB0aW9uLm5hbWUgfHwgJycsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLm1lc3NhZ2UgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvclRleHQgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXNUZXh0IHx8IGV2ZW50T3JFeGNlcHRpb25cbiAgICBdO1xuICB9XG4gIGljZWNhbmRpZGF0ZUVycm9yKGV2ZW50T3JFeGNlcHRpb24pIHsgLy8gRm9yIGVycm9ycyBvbiB0aGlzIHBlZXIgZHVyaW5nIGdhdGhlcmluZy5cbiAgICAvLyBDYW4gYmUgb3ZlcnJpZGRlbiBvciBleHRlbmRlZCBieSBhcHBsaWNhdGlvbnMuXG5cbiAgICAvLyBTVFVOIGVycm9ycyBhcmUgaW4gdGhlIHJhbmdlIDMwMC02OTkuIFNlZSBSRkMgNTM4OSwgc2VjdGlvbiAxNS42XG4gICAgLy8gZm9yIGEgbGlzdCBvZiBjb2Rlcy4gVFVSTiBhZGRzIGEgZmV3IG1vcmUgZXJyb3IgY29kZXM7IHNlZVxuICAgIC8vIFJGQyA1NzY2LCBzZWN0aW9uIDE1IGZvciBkZXRhaWxzLlxuICAgIC8vIFNlcnZlciBjb3VsZCBub3QgYmUgcmVhY2hlZCBhcmUgaW4gdGhlIHJhbmdlIDcwMC03OTkuXG4gICAgY29uc3QgY29kZSA9IGV2ZW50T3JFeGNlcHRpb24uY29kZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yQ29kZSB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1cztcbiAgICAvLyBDaHJvbWUgZ2l2ZXMgNzAxIGVycm9ycyBmb3Igc29tZSB0dXJuIHNlcnZlcnMgdGhhdCBpdCBkb2VzIG5vdCBnaXZlIGZvciBvdGhlciB0dXJuIHNlcnZlcnMuXG4gICAgLy8gVGhpcyBpc24ndCBnb29kLCBidXQgaXQncyB3YXkgdG9vIG5vaXN5IHRvIHNsb2cgdGhyb3VnaCBzdWNoIGVycm9ycywgYW5kIEkgZG9uJ3Qga25vdyBob3cgdG8gZml4IG91ciB0dXJuIGNvbmZpZ3VyYXRpb24uXG4gICAgaWYgKGNvZGUgPT09IDcwMSkgcmV0dXJuO1xuICAgIHRoaXMubG9nRXJyb3IoJ2ljZScsIGV2ZW50T3JFeGNlcHRpb24pO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBQcm9taXNlV2ViUlRDIGV4dGVuZHMgV2ViUlRDIHtcbiAgLy8gRXh0ZW5kcyBXZWJSVEMuc2lnbmFsKCkgc3VjaCB0aGF0OlxuICAvLyAtIGluc3RhbmNlLnNpZ25hbHMgYW5zd2VycyBhIHByb21pc2UgdGhhdCB3aWxsIHJlc29sdmUgd2l0aCBhbiBhcnJheSBvZiBzaWduYWwgbWVzc2FnZXMuXG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyA9IFsuLi5zaWduYWxNZXNzYWdlc10gd2lsbCBkaXNwYXRjaCB0aG9zZSBtZXNzYWdlcy5cbiAgLy9cbiAgLy8gRm9yIGV4YW1wbGUsIHN1cHBvc2UgcGVlcjEgYW5kIHBlZXIyIGFyZSBpbnN0YW5jZXMgb2YgdGhpcy5cbiAgLy8gMC4gU29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIG9uIHBlZXIxIChzdWNoIGFzIGNhbGxpbmcgcGVlcjEuY3JlYXRlRGF0YUNoYW5uZWwoKSkuIFxuICAvLyAxLiBwZWVyMS5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDE+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjIuXG4gIC8vIDIuIFNldCBwZWVyMi5zaWduYWxzID0gPHNpZ25hbDE+LlxuICAvLyAzLiBwZWVyMi5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDI+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjEuXG4gIC8vIDQuIFNldCBwZWVyMS5zaWduYWxzID0gPHNpZ25hbDI+LlxuICAvLyA1LiBEYXRhIGZsb3dzLCBidXQgZWFjaCBzaWRlIHdob3VsZCBncmFiIGEgbmV3IHNpZ25hbHMgcHJvbWlzZSBhbmQgYmUgcHJlcGFyZWQgdG8gYWN0IGlmIGl0IHJlc29sdmVzLlxuICAvL1xuICBjb25zdHJ1Y3Rvcih7aWNlVGltZW91dCA9IDJlMywgLi4ucHJvcGVydGllc30pIHtcbiAgICBzdXBlcihwcm9wZXJ0aWVzKTtcbiAgICB0aGlzLmljZVRpbWVvdXQgPSBpY2VUaW1lb3V0O1xuICB9XG4gIGdldCBzaWduYWxzKCkgeyAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmUgdG8gdGhlIHNpZ25hbCBtZXNzYWdpbmcgd2hlbiBpY2UgY2FuZGlkYXRlIGdhdGhlcmluZyBpcyBjb21wbGV0ZS5cbiAgICByZXR1cm4gdGhpcy5fc2lnbmFsUHJvbWlzZSB8fD0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gdGhpcy5fc2lnbmFsUmVhZHkgPSB7cmVzb2x2ZSwgcmVqZWN0fSk7XG4gIH1cbiAgc2V0IHNpZ25hbHMoZGF0YSkgeyAvLyBTZXQgd2l0aCB0aGUgc2lnbmFscyByZWNlaXZlZCBmcm9tIHRoZSBvdGhlciBlbmQuXG4gICAgZGF0YS5mb3JFYWNoKChbdHlwZSwgbWVzc2FnZV0pID0+IHRoaXNbdHlwZV0obWVzc2FnZSkpO1xuICB9XG4gIG9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpIHtcbiAgICAvLyBFYWNoIHdydGMgaW1wbGVtZW50YXRpb24gaGFzIGl0cyBvd24gaWRlYXMgYXMgdG8gd2hhdCBpY2UgY2FuZGlkYXRlcyB0byB0cnkgYmVmb3JlIGVtaXR0aW5nIHRoZW0gaW4gaWNlY2FuZGRpYXRlLlxuICAgIC8vIE1vc3Qgd2lsbCB0cnkgdGhpbmdzIHRoYXQgY2Fubm90IGJlIHJlYWNoZWQsIGFuZCBnaXZlIHVwIHdoZW4gdGhleSBoaXQgdGhlIE9TIG5ldHdvcmsgdGltZW91dC4gRm9ydHkgc2Vjb25kcyBpcyBhIGxvbmcgdGltZSB0byB3YWl0LlxuICAgIC8vIElmIHRoZSB3cnRjIGlzIHN0aWxsIHdhaXRpbmcgYWZ0ZXIgb3VyIGljZVRpbWVvdXQgKDIgc2Vjb25kcyksIGxldHMganVzdCBnbyB3aXRoIHdoYXQgd2UgaGF2ZS5cbiAgICB0aGlzLnRpbWVyIHx8PSBzZXRUaW1lb3V0KCgpID0+IHRoaXMub25Mb2NhbEVuZEljZSgpLCB0aGlzLmljZVRpbWVvdXQpO1xuICAgIHN1cGVyLm9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpO1xuICB9XG4gIGNsZWFySWNlVGltZXIoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpO1xuICAgIHRoaXMudGltZXIgPSBudWxsO1xuICB9XG4gIGFzeW5jIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFJlc29sdmUgdGhlIHByb21pc2Ugd2l0aCB3aGF0IHdlJ3ZlIGJlZW4gZ2F0aGVyaW5nLlxuICAgIHRoaXMuY2xlYXJJY2VUaW1lcigpO1xuICAgIGlmICghdGhpcy5fc2lnbmFsUHJvbWlzZSkge1xuICAgICAgLy90aGlzLmxvZ0Vycm9yKCdpY2UnLCBcIkVuZCBvZiBJQ0Ugd2l0aG91dCBhbnl0aGluZyB3YWl0aW5nIG9uIHNpZ25hbHMuXCIpOyAvLyBOb3QgaGVscGZ1bCB3aGVuIHRoZXJlIGFyZSB0aHJlZSB3YXlzIHRvIHJlY2VpdmUgdGhpcyBtZXNzYWdlLlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9zaWduYWxSZWFkeS5yZXNvbHZlKHRoaXMuc2VuZGluZyk7XG4gICAgdGhpcy5zZW5kaW5nID0gW107XG4gIH1cbiAgc2VuZGluZyA9IFtdO1xuICBzaWduYWwodHlwZSwgbWVzc2FnZSkge1xuICAgIHN1cGVyLnNpZ25hbCh0eXBlLCBtZXNzYWdlKTtcbiAgICB0aGlzLnNlbmRpbmcucHVzaChbdHlwZSwgbWVzc2FnZV0pO1xuICB9XG4gIC8vIFdlIG5lZWQgdG8ga25vdyBpZiB0aGVyZSBhcmUgb3BlbiBkYXRhIGNoYW5uZWxzLiBUaGVyZSBpcyBhIHByb3Bvc2FsIGFuZCBldmVuIGFuIGFjY2VwdGVkIFBSIGZvciBSVENQZWVyQ29ubmVjdGlvbi5nZXREYXRhQ2hhbm5lbHMoKSxcbiAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3czYy93ZWJydGMtZXh0ZW5zaW9ucy9pc3N1ZXMvMTEwXG4gIC8vIGJ1dCBpdCBoYXNuJ3QgYmVlbiBkZXBsb3llZCBldmVyeXdoZXJlIHlldC4gU28gd2UnbGwgbmVlZCB0byBrZWVwIG91ciBvd24gY291bnQuXG4gIC8vIEFsYXMsIGEgY291bnQgaXNuJ3QgZW5vdWdoLCBiZWNhdXNlIHdlIGNhbiBvcGVuIHN0dWZmLCBhbmQgdGhlIG90aGVyIHNpZGUgY2FuIG9wZW4gc3R1ZmYsIGJ1dCBpZiBpdCBoYXBwZW5zIHRvIGJlXG4gIC8vIHRoZSBzYW1lIFwibmVnb3RpYXRlZFwiIGlkLCBpdCBpc24ndCByZWFsbHkgYSBkaWZmZXJlbnQgY2hhbm5lbC4gKGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9SVENQZWVyQ29ubmVjdGlvbi9kYXRhY2hhbm5lbF9ldmVudFxuICBkYXRhQ2hhbm5lbHMgPSBuZXcgTWFwKCk7XG4gIHJlcG9ydENoYW5uZWxzKCkgeyAvLyBSZXR1cm4gYSByZXBvcnQgc3RyaW5nIHVzZWZ1bCBmb3IgZGVidWdnaW5nLlxuICAgIGNvbnN0IGVudHJpZXMgPSBBcnJheS5mcm9tKHRoaXMuZGF0YUNoYW5uZWxzLmVudHJpZXMoKSk7XG4gICAgY29uc3Qga3YgPSBlbnRyaWVzLm1hcCgoW2ssIHZdKSA9PiBgJHtrfToke3YuaWR9YCk7XG4gICAgcmV0dXJuIGAke3RoaXMuZGF0YUNoYW5uZWxzLnNpemV9LyR7a3Yuam9pbignLCAnKX1gO1xuICB9XG4gIG5vdGVDaGFubmVsKGNoYW5uZWwsIHNvdXJjZSwgd2FpdGluZykgeyAvLyBCb29ra2VlcCBvcGVuIGNoYW5uZWwgYW5kIHJldHVybiBpdC5cbiAgICAvLyBFbXBlcmljYWxseSwgd2l0aCBtdWx0aXBsZXggZmFsc2U6IC8vICAgMTggb2NjdXJyZW5jZXMsIHdpdGggaWQ9bnVsbHwwfDEgYXMgZm9yIGV2ZW50Y2hhbm5lbCBvciBjcmVhdGVEYXRhQ2hhbm5lbFxuICAgIC8vICAgQXBwYXJlbnRseSwgd2l0aG91dCBuZWdvdGlhdGlvbiwgaWQgaXMgaW5pdGlhbGx5IG51bGwgKHJlZ2FyZGxlc3Mgb2Ygb3B0aW9ucy5pZCksIGFuZCB0aGVuIGFzc2lnbmVkIHRvIGEgZnJlZSB2YWx1ZSBkdXJpbmcgb3BlbmluZ1xuICAgIGNvbnN0IGtleSA9IGNoYW5uZWwubGFiZWw7IC8vZml4bWUgY2hhbm5lbC5pZCA9PT0gbnVsbCA/IDEgOiBjaGFubmVsLmlkO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5kYXRhQ2hhbm5lbHMuZ2V0KGtleSk7XG4gICAgdGhpcy5sb2coJ2dvdCBkYXRhLWNoYW5uZWwnLCBzb3VyY2UsIGtleSwgJ2V4aXN0aW5nOicsIGV4aXN0aW5nLCAnd2FpdGluZzonLCB3YWl0aW5nKTtcbiAgICB0aGlzLmRhdGFDaGFubmVscy5zZXQoa2V5LCBjaGFubmVsKTtcbiAgICBjaGFubmVsLmFkZEV2ZW50TGlzdGVuZXIoJ2Nsb3NlJywgZXZlbnQgPT4geyAvLyBDbG9zZSB3aG9sZSBjb25uZWN0aW9uIHdoZW4gbm8gbW9yZSBkYXRhIGNoYW5uZWxzIG9yIHN0cmVhbXMuXG4gICAgICB0aGlzLmRhdGFDaGFubmVscy5kZWxldGUoa2V5KTtcbiAgICAgIC8vIElmIHRoZXJlJ3Mgbm90aGluZyBvcGVuLCBjbG9zZSB0aGUgY29ubmVjdGlvbi5cbiAgICAgIGlmICh0aGlzLmRhdGFDaGFubmVscy5zaXplKSByZXR1cm47XG4gICAgICBpZiAodGhpcy5wZWVyLmdldFNlbmRlcnMoKS5sZW5ndGgpIHJldHVybjtcbiAgICAgIHRoaXMuY2xvc2UoKTtcbiAgICB9KTtcbiAgICByZXR1cm4gY2hhbm5lbDtcbiAgfVxuICBjcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCA9IFwiZGF0YVwiLCBjaGFubmVsT3B0aW9ucyA9IHt9KSB7IC8vIFByb21pc2UgcmVzb2x2ZXMgd2hlbiB0aGUgY2hhbm5lbCBpcyBvcGVuICh3aGljaCB3aWxsIGJlIGFmdGVyIGFueSBuZWVkZWQgbmVnb3RpYXRpb24pLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdjcmVhdGUgZGF0YS1jaGFubmVsJywgbGFiZWwsIGNoYW5uZWxPcHRpb25zKTtcbiAgICAgIGxldCBjaGFubmVsID0gdGhpcy5wZWVyLmNyZWF0ZURhdGFDaGFubmVsKGxhYmVsLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgICB0aGlzLm5vdGVDaGFubmVsKGNoYW5uZWwsICdleHBsaWNpdCcpOyAvLyBOb3RlZCBldmVuIGJlZm9yZSBvcGVuZWQuXG4gICAgICAvLyBUaGUgY2hhbm5lbCBtYXkgaGF2ZSBhbHJlYWR5IGJlZW4gb3BlbmVkIG9uIHRoZSBvdGhlciBzaWRlLiBJbiB0aGlzIGNhc2UsIGFsbCBicm93c2VycyBmaXJlIHRoZSBvcGVuIGV2ZW50IGFueXdheSxcbiAgICAgIC8vIGJ1dCB3cnRjIChpLmUuLCBvbiBub2RlSlMpIGRvZXMgbm90LiBTbyB3ZSBoYXZlIHRvIGV4cGxpY2l0bHkgY2hlY2suXG4gICAgICBzd2l0Y2ggKGNoYW5uZWwucmVhZHlTdGF0ZSkge1xuICAgICAgY2FzZSAnb3Blbic6XG5cdHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShjaGFubmVsKSwgMTApO1xuXHRicmVhaztcbiAgICAgIGNhc2UgJ2Nvbm5lY3RpbmcnOlxuXHRjaGFubmVsLm9ub3BlbiA9IF8gPT4gcmVzb2x2ZShjaGFubmVsKTtcblx0YnJlYWs7XG4gICAgICBkZWZhdWx0OlxuXHR0aHJvdyBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgcmVhZHlTdGF0ZSAke2NoYW5uZWwucmVhZHlTdGF0ZX0gZm9yIGRhdGEgY2hhbm5lbCAke2xhYmVsfS5gKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICB3YWl0aW5nQ2hhbm5lbHMgPSB7fTtcbiAgZ2V0RGF0YUNoYW5uZWxQcm9taXNlKGxhYmVsID0gXCJkYXRhXCIpIHsgLy8gUmVzb2x2ZXMgdG8gYW4gb3BlbiBkYXRhIGNoYW5uZWwuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgdGhpcy5sb2coJ3Byb21pc2UgZGF0YS1jaGFubmVsJywgbGFiZWwpO1xuICAgICAgdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdID0gcmVzb2x2ZTtcbiAgICB9KTtcbiAgfVxuICByZXNldFBlZXIoKSB7IC8vIFJlc2V0IGEgJ2Nvbm5lY3RlZCcgcHJvcGVydHkgdGhhdCBwcm9taXNlZCB0byByZXNvbHZlIHdoZW4gb3BlbmVkLCBhbmQgdHJhY2sgaW5jb21pbmcgZGF0YWNoYW5uZWxzLlxuICAgIHN1cGVyLnJlc2V0UGVlcigpO1xuICAgIHRoaXMuY29ubmVjdGVkID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7IC8vIHRoaXMuY29ubmVjdGVkIGlzIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gd2UgYXJlLlxuICAgICAgdGhpcy5wZWVyLmFkZEV2ZW50TGlzdGVuZXIoJ2Nvbm5lY3Rpb25zdGF0ZWNoYW5nZScsIGV2ZW50ID0+IHtcblx0aWYgKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICdjb25uZWN0ZWQnKSB7XG5cdCAgcmVzb2x2ZSh0cnVlKTtcblx0fVxuICAgICAgfSk7XG4gICAgfSk7XG4gICAgdGhpcy5wZWVyLmFkZEV2ZW50TGlzdGVuZXIoJ2RhdGFjaGFubmVsJywgZXZlbnQgPT4geyAvLyBSZXNvbHZlIHByb21pc2UgbWFkZSB3aXRoIGdldERhdGFDaGFubmVsUHJvbWlzZSgpLlxuICAgICAgY29uc3QgY2hhbm5lbCA9IGV2ZW50LmNoYW5uZWw7XG4gICAgICBjb25zdCBsYWJlbCA9IGNoYW5uZWwubGFiZWw7XG4gICAgICBjb25zdCB3YWl0aW5nID0gdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdO1xuICAgICAgdGhpcy5ub3RlQ2hhbm5lbChjaGFubmVsLCAnZGF0YWNoYW5uZWwgZXZlbnQnLCB3YWl0aW5nKTsgLy8gUmVnYXJkbGVzcyBvZiB3aGV0aGVyIHdlIGFyZSB3YWl0aW5nLlxuICAgICAgaWYgKCF3YWl0aW5nKSByZXR1cm47IC8vIE1pZ2h0IG5vdCBiZSBleHBsaWNpdGx5IHdhaXRpbmcuIEUuZy4sIHJvdXRlcnMuXG4gICAgICBkZWxldGUgdGhpcy53YWl0aW5nQ2hhbm5lbHNbbGFiZWxdO1xuICAgICAgd2FpdGluZyhjaGFubmVsKTtcbiAgICB9KTtcbiAgfVxuICBjbG9zZSgpIHtcbiAgICBpZiAodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2ZhaWxlZCcpIHRoaXMuX3NpZ25hbFByb21pc2U/LnJlamVjdD8uKCk7XG4gICAgc3VwZXIuY2xvc2UoKTtcbiAgICB0aGlzLmNsZWFySWNlVGltZXIoKTtcbiAgICB0aGlzLl9zaWduYWxQcm9taXNlID0gdGhpcy5fc2lnbmFsUmVhZHkgPSBudWxsO1xuICAgIHRoaXMuc2VuZGluZyA9IFtdO1xuICAgIC8vIElmIHRoZSB3ZWJydGMgaW1wbGVtZW50YXRpb24gY2xvc2VzIHRoZSBkYXRhIGNoYW5uZWxzIGJlZm9yZSB0aGUgcGVlciBpdHNlbGYsIHRoZW4gdGhpcy5kYXRhQ2hhbm5lbHMgd2lsbCBiZSBlbXB0eS5cbiAgICAvLyBCdXQgaWYgbm90IChlLmcuLCBzdGF0dXMgJ2ZhaWxlZCcgb3IgJ2Rpc2Nvbm5lY3RlZCcgb24gU2FmYXJpKSwgdGhlbiBsZXQgdXMgZXhwbGljaXRseSBjbG9zZSB0aGVtIHNvIHRoYXQgU3luY2hyb25pemVycyBrbm93IHRvIGNsZWFuIHVwLlxuICAgIGZvciAoY29uc3QgY2hhbm5lbCBvZiB0aGlzLmRhdGFDaGFubmVscy52YWx1ZXMoKSkge1xuICAgICAgaWYgKGNoYW5uZWwucmVhZHlTdGF0ZSAhPT0gJ29wZW4nKSBjb250aW51ZTsgLy8gS2VlcCBkZWJ1Z2dpbmcgc2FuaXR5LlxuICAgICAgLy8gSXQgYXBwZWFycyB0aGF0IGluIFNhZmFyaSAoMTguNSkgZm9yIGEgY2FsbCB0byBjaGFubmVsLmNsb3NlKCkgd2l0aCB0aGUgY29ubmVjdGlvbiBhbHJlYWR5IGludGVybmFsbCBjbG9zZWQsIFNhZmFyaVxuICAgICAgLy8gd2lsbCBzZXQgY2hhbm5lbC5yZWFkeVN0YXRlIHRvICdjbG9zaW5nJywgYnV0IE5PVCBmaXJlIHRoZSBjbG9zZWQgb3IgY2xvc2luZyBldmVudC4gU28gd2UgaGF2ZSB0byBkaXNwYXRjaCBpdCBvdXJzZWx2ZXMuXG4gICAgICAvL2NoYW5uZWwuY2xvc2UoKTtcbiAgICAgIGNoYW5uZWwuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2Nsb3NlJykpO1xuICAgIH1cbiAgfVxufVxuXG4vLyBOZWdvdGlhdGVkIGNoYW5uZWxzIHVzZSBzcGVjaWZpYyBpbnRlZ2VycyBvbiBib3RoIHNpZGVzLCBzdGFydGluZyB3aXRoIHRoaXMgbnVtYmVyLlxuLy8gV2UgZG8gbm90IHN0YXJ0IGF0IHplcm8gYmVjYXVzZSB0aGUgbm9uLW5lZ290aWF0ZWQgY2hhbm5lbHMgKGFzIHVzZWQgb24gc2VydmVyIHJlbGF5cykgZ2VuZXJhdGUgdGhlaXJcbi8vIG93biBpZHMgc3RhcnRpbmcgd2l0aCAwLCBhbmQgd2UgZG9uJ3Qgd2FudCB0byBjb25mbGljdC5cbi8vIFRoZSBzcGVjIHNheXMgdGhlc2UgY2FuIGdvIHRvIDY1LDUzNCwgYnV0IEkgZmluZCB0aGF0IHN0YXJ0aW5nIGdyZWF0ZXIgdGhhbiB0aGUgdmFsdWUgaGVyZSBnaXZlcyBlcnJvcnMuXG5jb25zdCBCQVNFX0NIQU5ORUxfSUQgPSAxMDAwO1xuZXhwb3J0IGNsYXNzIFNoYXJlZFdlYlJUQyBleHRlbmRzIFByb21pc2VXZWJSVEMge1xuICBzdGF0aWMgY29ubmVjdGlvbnMgPSBuZXcgTWFwKCk7XG4gIHN0YXRpYyBlbnN1cmUoe3NlcnZpY2VMYWJlbCwgbXVsdGlwbGV4ID0gdHJ1ZSwgLi4ucmVzdH0pIHtcbiAgICBsZXQgY29ubmVjdGlvbiA9IHRoaXMuY29ubmVjdGlvbnMuZ2V0KHNlcnZpY2VMYWJlbCk7XG4gICAgLy8gSXQgaXMgcG9zc2libGUgdGhhdCB3ZSB3ZXJlIGJhY2tncm91bmRlZCBiZWZvcmUgd2UgaGFkIGEgY2hhbmNlIHRvIGFjdCBvbiBhIGNsb3NpbmcgY29ubmVjdGlvbiBhbmQgcmVtb3ZlIGl0LlxuICAgIGlmIChjb25uZWN0aW9uKSB7XG4gICAgICBjb25zdCB7Y29ubmVjdGlvblN0YXRlLCBzaWduYWxpbmdTdGF0ZX0gPSBjb25uZWN0aW9uLnBlZXI7XG4gICAgICBpZiAoKGNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2Nsb3NlZCcpIHx8IChzaWduYWxpbmdTdGF0ZSA9PT0gJ2Nsb3NlZCcpKSBjb25uZWN0aW9uID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFjb25uZWN0aW9uKSB7XG4gICAgICBjb25uZWN0aW9uID0gbmV3IHRoaXMoe2xhYmVsOiBzZXJ2aWNlTGFiZWwsIHV1aWQ6IHV1aWQ0KCksIG11bHRpcGxleCwgLi4ucmVzdH0pO1xuICAgICAgaWYgKG11bHRpcGxleCkgdGhpcy5jb25uZWN0aW9ucy5zZXQoc2VydmljZUxhYmVsLCBjb25uZWN0aW9uKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvbm5lY3Rpb247XG4gIH1cbiAgY2hhbm5lbElkID0gQkFTRV9DSEFOTkVMX0lEO1xuICBnZXQgaGFzU3RhcnRlZENvbm5lY3RpbmcoKSB7XG4gICAgcmV0dXJuIHRoaXMuY2hhbm5lbElkID4gQkFTRV9DSEFOTkVMX0lEO1xuICB9XG4gIGNsb3NlKHJlbW92ZUNvbm5lY3Rpb24gPSB0cnVlKSB7XG4gICAgdGhpcy5jaGFubmVsSWQgPSBCQVNFX0NIQU5ORUxfSUQ7XG4gICAgc3VwZXIuY2xvc2UoKTtcbiAgICBpZiAocmVtb3ZlQ29ubmVjdGlvbikgdGhpcy5jb25zdHJ1Y3Rvci5jb25uZWN0aW9ucy5kZWxldGUodGhpcy5zZXJ2aWNlTGFiZWwpO1xuICB9XG4gIGFzeW5jIGVuc3VyZURhdGFDaGFubmVsKGNoYW5uZWxOYW1lLCBjaGFubmVsT3B0aW9ucyA9IHt9LCBzaWduYWxzID0gbnVsbCkgeyAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciBhbiBvcGVuIGRhdGEgY2hhbm5lbCBvbiB0aGlzIGNvbm5lY3Rpb24uXG4gICAgY29uc3QgaGFzU3RhcnRlZENvbm5lY3RpbmcgPSB0aGlzLmhhc1N0YXJ0ZWRDb25uZWN0aW5nOyAvLyBNdXN0IGFzayBiZWZvcmUgaW5jcmVtZW50aW5nIGlkLlxuICAgIGNvbnN0IGlkID0gdGhpcy5jaGFubmVsSWQrKzsgLy8gVGhpcyBhbmQgZXZlcnl0aGluZyBsZWFkaW5nIHVwIHRvIGl0IG11c3QgYmUgc3luY2hyb25vdXMsIHNvIHRoYXQgaWQgYXNzaWdubWVudCBpcyBkZXRlcm1pbmlzdGljLlxuICAgIGNvbnN0IG5lZ290aWF0ZWQgPSAodGhpcy5tdWx0aXBsZXggPT09ICduZWdvdGlhdGVkJykgJiYgaGFzU3RhcnRlZENvbm5lY3Rpbmc7XG4gICAgY29uc3QgYWxsb3dPdGhlclNpZGVUb0NyZWF0ZSA9ICFoYXNTdGFydGVkQ29ubmVjdGluZyAvKiFuZWdvdGlhdGVkKi8gJiYgISFzaWduYWxzOyAvLyBPbmx5IHRoZSAwdGggd2l0aCBzaWduYWxzIHdhaXRzIHBhc3NpdmVseS5cbiAgICAvLyBzaWduYWxzIGlzIGVpdGhlciBudWxsaXNoIG9yIGFuIGFycmF5IG9mIHNpZ25hbHMsIGJ1dCB0aGF0IGFycmF5IGNhbiBiZSBFTVBUWSxcbiAgICAvLyBpbiB3aGljaCBjYXNlIHRoZSByZWFsIHNpZ25hbHMgd2lsbCBoYXZlIHRvIGJlIGFzc2lnbmVkIGxhdGVyLiBUaGlzIGFsbG93cyB0aGUgZGF0YSBjaGFubmVsIHRvIGJlIHN0YXJ0ZWQgKGFuZCB0byBjb25zdW1lXG4gICAgLy8gYSBjaGFubmVsSWQpIHN5bmNocm9ub3VzbHksIGJ1dCB0aGUgcHJvbWlzZSB3b24ndCByZXNvbHZlIHVudGlsIHRoZSByZWFsIHNpZ25hbHMgYXJlIHN1cHBsaWVkIGxhdGVyLiBUaGlzIGlzXG4gICAgLy8gdXNlZnVsIGluIG11bHRpcGxleGluZyBhbiBvcmRlcmVkIHNlcmllcyBvZiBkYXRhIGNoYW5uZWxzIG9uIGFuIEFOU1dFUiBjb25uZWN0aW9uLCB3aGVyZSB0aGUgZGF0YSBjaGFubmVscyBtdXN0XG4gICAgLy8gbWF0Y2ggdXAgd2l0aCBhbiBPRkZFUiBjb25uZWN0aW9uIG9uIGEgcGVlci4gVGhpcyB3b3JrcyBiZWNhdXNlIG9mIHRoZSB3b25kZXJmdWwgaGFwcGVuc3RhbmNlIHRoYXQgYW5zd2VyIGNvbm5lY3Rpb25zXG4gICAgLy8gZ2V0RGF0YUNoYW5uZWxQcm9taXNlICh3aGljaCBkb2Vzbid0IHJlcXVpcmUgdGhlIGNvbm5lY3Rpb24gdG8geWV0IGJlIG9wZW4pIHJhdGhlciB0aGFuIGNyZWF0ZURhdGFDaGFubmVsICh3aGljaCB3b3VsZFxuICAgIC8vIHJlcXVpcmUgdGhlIGNvbm5lY3Rpb24gdG8gYWxyZWFkeSBiZSBvcGVuKS5cbiAgICBjb25zdCB1c2VTaWduYWxzID0gIWhhc1N0YXJ0ZWRDb25uZWN0aW5nICYmIHNpZ25hbHM/Lmxlbmd0aDtcbiAgICBjb25zdCBvcHRpb25zID0gbmVnb3RpYXRlZCA/IHtpZCwgbmVnb3RpYXRlZCwgLi4uY2hhbm5lbE9wdGlvbnN9IDogY2hhbm5lbE9wdGlvbnM7XG4gICAgaWYgKGhhc1N0YXJ0ZWRDb25uZWN0aW5nKSB7XG4gICAgICBhd2FpdCB0aGlzLmNvbm5lY3RlZDsgLy8gQmVmb3JlIGNyZWF0aW5nIHByb21pc2UuXG4gICAgICAvLyBJIHNvbWV0aW1lcyBlbmNvdW50ZXIgYSBidWcgaW4gU2FmYXJpIGluIHdoaWNoIE9ORSBvZiB0aGUgY2hhbm5lbHMgY3JlYXRlZCBzb29uIGFmdGVyIGNvbm5lY3Rpb24gZ2V0cyBzdHVjayBpblxuICAgICAgLy8gdGhlIGNvbm5lY3RpbmcgcmVhZHlTdGF0ZSBhbmQgbmV2ZXIgb3BlbnMuIEV4cGVyaW1lbnRhbGx5LCB0aGlzIHNlZW1zIHRvIGJlIHJvYnVzdC5cbiAgICAgIC8vXG4gICAgICAvLyBOb3RlIHRvIHNlbGY6IElmIGl0IHNob3VsZCB0dXJuIG91dCB0aGF0IHdlIHN0aWxsIGhhdmUgcHJvYmxlbXMsIHRyeSBzZXJpYWxpemluZyB0aGUgY2FsbHMgdG8gcGVlci5jcmVhdGVEYXRhQ2hhbm5lbFxuICAgICAgLy8gc28gdGhhdCB0aGVyZSBpc24ndCBtb3JlIHRoYW4gb25lIGNoYW5uZWwgb3BlbmluZyBhdCBhIHRpbWUuXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMTAwKSk7XG4gICAgfSBlbHNlIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICB0aGlzLnNpZ25hbHMgPSBzaWduYWxzO1xuICAgIH1cbiAgICBjb25zdCBwcm9taXNlID0gYWxsb3dPdGhlclNpZGVUb0NyZWF0ZSA/XG5cdCAgdGhpcy5nZXREYXRhQ2hhbm5lbFByb21pc2UoY2hhbm5lbE5hbWUpIDpcblx0ICB0aGlzLmNyZWF0ZURhdGFDaGFubmVsKGNoYW5uZWxOYW1lLCBvcHRpb25zKTtcbiAgICByZXR1cm4gYXdhaXQgcHJvbWlzZTtcbiAgfVxufVxuIiwiLy8gbmFtZS92ZXJzaW9uIG9mIFwiZGF0YWJhc2VcIlxuZXhwb3J0IGNvbnN0IHN0b3JhZ2VOYW1lID0gJ2ZsZXhzdG9yZSc7XG5leHBvcnQgY29uc3Qgc3RvcmFnZVZlcnNpb24gPSA5O1xuXG5pbXBvcnQgKiBhcyBwa2cgZnJvbSBcIi4uL3BhY2thZ2UuanNvblwiIHdpdGggeyB0eXBlOiAnanNvbicgfTtcbmV4cG9ydCBjb25zdCB7bmFtZSwgdmVyc2lvbn0gPSBwa2cuZGVmYXVsdDtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB7IHRhZ1BhdGggfSBmcm9tICcuL3RhZ1BhdGgubWpzJztcbmltcG9ydCB7IFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vd2VicnRjLm1qcyc7XG5pbXBvcnQgeyBzdG9yYWdlVmVyc2lvbiB9IGZyb20gJy4vdmVyc2lvbi5tanMnO1xuXG4vKlxuICBSZXNwb25zaWJsZSBmb3Iga2VlcGluZyBhIGNvbGxlY3Rpb24gc3luY2hyb25pemVkIHdpdGggYW5vdGhlciBwZWVyLlxuICAoUGVlcnMgbWF5IGJlIGEgY2xpZW50IG9yIGEgc2VydmVyL3JlbGF5LiBJbml0aWFsbHkgdGhpcyBpcyB0aGUgc2FtZSBjb2RlIGVpdGhlciB3YXksXG4gIGJ1dCBsYXRlciBvbiwgb3B0aW1pemF0aW9ucyBjYW4gYmUgbWFkZSBmb3Igc2NhbGUuKVxuXG4gIEFzIGxvbmcgYXMgdHdvIHBlZXJzIGFyZSBjb25uZWN0ZWQgd2l0aCBhIFN5bmNocm9uaXplciBvbiBlYWNoIHNpZGUsIHdyaXRpbmcgaGFwcGVuc1xuICBpbiBib3RoIHBlZXJzIGluIHJlYWwgdGltZSwgYW5kIHJlYWRpbmcgcHJvZHVjZXMgdGhlIGNvcnJlY3Qgc3luY2hyb25pemVkIHJlc3VsdCBmcm9tIGVpdGhlci5cbiAgVW5kZXIgdGhlIGhvb2QsIHRoZSBzeW5jaHJvbml6ZXIga2VlcHMgdHJhY2sgb2Ygd2hhdCBpdCBrbm93cyBhYm91dCB0aGUgb3RoZXIgcGVlciAtLVxuICBhIHBhcnRpY3VsYXIgdGFnIGNhbiBiZSB1bmtub3duLCB1bnN5bmNocm9uaXplZCwgb3Igc3luY2hyb25pemVkLCBhbmQgcmVhZGluZyB3aWxsXG4gIGNvbW11bmljYXRlIGFzIG5lZWRlZCB0byBnZXQgdGhlIGRhdGEgc3luY2hyb25pemVkIG9uLWRlbWFuZC4gTWVhbndoaWxlLCBzeW5jaHJvbml6YXRpb25cbiAgY29udGludWVzIGluIHRoZSBiYWNrZ3JvdW5kIHVudGlsIHRoZSBjb2xsZWN0aW9uIGlzIGZ1bGx5IHJlcGxpY2F0ZWQuXG5cbiAgQSBjb2xsZWN0aW9uIG1haW50YWlucyBhIHNlcGFyYXRlIFN5bmNocm9uaXplciBmb3IgZWFjaCBvZiB6ZXJvIG9yIG1vcmUgcGVlcnMsIGFuZCBjYW4gZHluYW1pY2FsbHlcbiAgYWRkIGFuZCByZW1vdmUgbW9yZS5cblxuICBOYW1pbmcgY29udmVudGlvbnM6XG5cbiAgbXVtYmxlTmFtZTogYSBzZW1hbnRpYyBuYW1lIHVzZWQgZXh0ZXJuYWxseSBhcyBhIGtleS4gRXhhbXBsZTogc2VydmljZU5hbWUsIGNoYW5uZWxOYW1lLCBldGMuXG4gICAgV2hlbiB0aGluZ3MgbmVlZCB0byBtYXRjaCB1cCBhY3Jvc3Mgc3lzdGVtcywgaXQgaXMgYnkgbmFtZS5cbiAgICBJZiBvbmx5IG9uZSBvZiBuYW1lL2xhYmVsIGlzIHNwZWNpZmllZCwgdGhpcyBpcyB1c3VhbGx5IHRoZSB0aGUgb25lLlxuXG4gIG11bWJsZUxhYmVsOiBhIGxhYmVsIGZvciBpZGVudGlmaWNhdGlvbiBhbmQgaW50ZXJuYWxseSAoZS5nLiwgZGF0YWJhc2UgbmFtZSkuXG4gICAgV2hlbiB0d28gaW5zdGFuY2VzIG9mIHNvbWV0aGluZyBhcmUgXCJ0aGUgc2FtZVwiIGJ1dCBhcmUgaW4gdGhlIHNhbWUgSmF2YXNjcmlwdCBpbWFnZSBmb3IgdGVzdGluZywgdGhleSBhcmUgZGlzdGluZ3Vpc2hlZCBieSBsYWJlbC5cbiAgICBUeXBpY2FsbHkgZGVmYXVsdHMgdG8gbXVtYmxlTmFtZS5cblxuICBOb3RlLCB0aG91Z2gsIHRoYXQgc29tZSBleHRlcm5hbCBtYWNoaW5lcnkgKHN1Y2ggYXMgYSBXZWJSVEMgRGF0YUNoYW5uZWwpIGhhcyBhIFwibGFiZWxcIiBwcm9wZXJ0eSB0aGF0IHdlIHBvcHVsYXRlIHdpdGggYSBcIm5hbWVcIiAoY2hhbm5lbE5hbWUpLlxuICovXG5leHBvcnQgY2xhc3MgU3luY2hyb25pemVyIHtcbiAgY29uc3RydWN0b3Ioe3NlcnZpY2VOYW1lID0gJ2RpcmVjdCcsIGNvbGxlY3Rpb24sIGVycm9yID0gY29sbGVjdGlvbj8uY29uc3RydWN0b3IuZXJyb3IgfHwgY29uc29sZS5lcnJvcixcblx0ICAgICAgIHNlcnZpY2VMYWJlbCA9IGNvbGxlY3Rpb24/LnNlcnZpY2VMYWJlbCB8fCBzZXJ2aWNlTmFtZSwgLy8gVXNlZCB0byBpZGVudGlmeSBhbnkgZXhpc3RpbmcgY29ubmVjdGlvbi4gQ2FuIGJlIGRpZmZlcmVudCBmcm9tIHNlcnZpY2VOYW1lIGR1cmluZyB0ZXN0aW5nLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHV1aWQgPSBjb2xsZWN0aW9uPy51dWlkLCBydGNDb25maWd1cmF0aW9uLCBjb25uZWN0aW9uLCAvLyBDb21wbGV4IGRlZmF1bHQgYmVoYXZpb3IgZm9yIHRoZXNlLiBTZWUgY29kZS5cblx0ICAgICAgIG11bHRpcGxleCA9IGNvbGxlY3Rpb24/Lm11bHRpcGxleCwgLy8gSWYgc3BlY2lmZWQsIG90aGVyd2lzZSB1bmRlZmluZWQgYXQgdGhpcyBwb2ludC4gU2VlIGJlbG93LlxuXHQgICAgICAgZGVidWcgPSBjb2xsZWN0aW9uPy5kZWJ1ZywgbWluVmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uLCBtYXhWZXJzaW9uID0gbWluVmVyc2lvbn0pIHtcbiAgICAvLyBzZXJ2aWNlTmFtZSBpcyBhIHN0cmluZyBvciBvYmplY3QgdGhhdCBpZGVudGlmaWVzIHdoZXJlIHRoZSBzeW5jaHJvbml6ZXIgc2hvdWxkIGNvbm5lY3QuIEUuZy4sIGl0IG1heSBiZSBhIFVSTCBjYXJyeWluZ1xuICAgIC8vICAgV2ViUlRDIHNpZ25hbGluZy4gSXQgc2hvdWxkIGJlIGFwcC11bmlxdWUgZm9yIHRoaXMgcGFydGljdWxhciBzZXJ2aWNlIChlLmcuLCB3aGljaCBtaWdodCBtdWx0aXBsZXggZGF0YSBmb3IgbXVsdGlwbGUgY29sbGVjdGlvbiBpbnN0YW5jZXMpLlxuICAgIC8vIHV1aWQgaGVscCB1bmlxdWVseSBpZGVudGlmaWVzIHRoaXMgcGFydGljdWxhciBzeW5jaHJvbml6ZXIuXG4gICAgLy8gICBGb3IgbW9zdCBwdXJwb3NlcywgdXVpZCBzaG91bGQgZ2V0IHRoZSBkZWZhdWx0LCBhbmQgcmVmZXJzIHRvIE9VUiBlbmQuXG4gICAgLy8gICBIb3dldmVyLCBhIHNlcnZlciB0aGF0IGNvbm5lY3RzIHRvIGEgYnVuY2ggb2YgcGVlcnMgbWlnaHQgYmFzaCBpbiB0aGUgdXVpZCB3aXRoIHRoYXQgb2YgdGhlIG90aGVyIGVuZCwgc28gdGhhdCBsb2dnaW5nIGluZGljYXRlcyB0aGUgY2xpZW50LlxuICAgIC8vIElmIGNoYW5uZWxOYW1lIGlzIHNwZWNpZmllZCwgaXQgc2hvdWxkIGJlIGluIHRoZSBmb3JtIG9mIGNvbGxlY3Rpb25UeXBlL2NvbGxlY3Rpb25OYW1lIChlLmcuLCBpZiBjb25uZWN0aW5nIHRvIHJlbGF5KS5cbiAgICBjb25zdCBjb25uZWN0VGhyb3VnaEludGVybmV0ID0gc2VydmljZU5hbWUuc3RhcnRzV2l0aD8uKCdodHRwJyk7XG4gICAgaWYgKCFjb25uZWN0VGhyb3VnaEludGVybmV0ICYmIChydGNDb25maWd1cmF0aW9uID09PSB1bmRlZmluZWQpKSBydGNDb25maWd1cmF0aW9uID0ge307IC8vIEV4cGljaXRseSBubyBpY2UuIExBTiBvbmx5LlxuICAgIC8vIG11bHRpcGxleCBzaG91bGQgZW5kIHVwIHdpdGggb25lIG9mIHRocmVlIHZhbHVlczpcbiAgICAvLyBmYWxzeSAtIGEgbmV3IGNvbm5lY3Rpb24gc2hvdWxkIGJlIHVzZWQgZm9yIGVhY2ggY2hhbm5lbFxuICAgIC8vIFwibmVnb3RpYXRlZFwiIC0gYm90aCBzaWRlcyBjcmVhdGUgdGhlIHNhbWUgY2hhbm5lbE5hbWVzIGluIHRoZSBzYW1lIG9yZGVyIChtb3N0IGNhc2VzKTpcbiAgICAvLyAgICAgVGhlIGluaXRpYWwgc2lnbmFsbGluZyB3aWxsIGJlIHRyaWdnZXJlZCBieSBvbmUgc2lkZSBjcmVhdGluZyBhIGNoYW5uZWwsIGFuZCB0aGVyIHNpZGUgd2FpdGluZyBmb3IgaXQgdG8gYmUgY3JlYXRlZC5cbiAgICAvLyAgICAgQWZ0ZXIgdGhhdCwgYm90aCBzaWRlcyB3aWxsIGV4cGxpY2l0bHkgY3JlYXRlIGEgZGF0YSBjaGFubmVsIGFuZCB3ZWJydGMgd2lsbCBtYXRjaCB0aGVtIHVwIGJ5IGlkLlxuICAgIC8vIGFueSBvdGhlciB0cnV0aHkgLSBTdGFydHMgbGlrZSBuZWdvdGlhdGVkLCBhbmQgdGhlbiBjb250aW51ZXMgd2l0aCBvbmx5IHdpZGUgc2lkZSBjcmVhdGluZyB0aGUgY2hhbm5lbHMsIGFuZCB0aGVyIG90aGVyXG4gICAgLy8gICAgIG9ic2VydmVzIHRoZSBjaGFubmVsIHRoYXQgaGFzIGJlZW4gbWFkZS4gVGhpcyBpcyB1c2VkIGZvciByZWxheXMuXG4gICAgbXVsdGlwbGV4ID8/PSBjb25uZWN0aW9uPy5tdWx0aXBsZXg7IC8vIFN0aWxsIHR5cGljYWxseSB1bmRlZmluZWQgYXQgdGhpcyBwb2ludC5cbiAgICBtdWx0aXBsZXggPz89IChzZXJ2aWNlTmFtZS5pbmNsdWRlcz8uKCcvc3luYycpIHx8ICduZWdvdGlhdGVkJyk7XG4gICAgY29ubmVjdGlvbiA/Pz0gU2hhcmVkV2ViUlRDLmVuc3VyZSh7c2VydmljZUxhYmVsLCBjb25maWd1cmF0aW9uOiBydGNDb25maWd1cmF0aW9uLCBtdWx0aXBsZXgsIHV1aWQsIGRlYnVnLCBlcnJvcn0pO1xuXG4gICAgdXVpZCA/Pz0gY29ubmVjdGlvbi51dWlkO1xuICAgIC8vIEJvdGggcGVlcnMgbXVzdCBhZ3JlZSBvbiBjaGFubmVsTmFtZS4gVXN1YWxseSwgdGhpcyBpcyBjb2xsZWN0aW9uLmZ1bGxOYW1lLiBCdXQgaW4gdGVzdGluZywgd2UgbWF5IHN5bmMgdHdvIGNvbGxlY3Rpb25zIHdpdGggZGlmZmVyZW50IG5hbWVzLlxuICAgIGNoYW5uZWxOYW1lID8/PSBjb2xsZWN0aW9uPy5jaGFubmVsTmFtZSB8fCBjb2xsZWN0aW9uLmZ1bGxOYW1lO1xuICAgIGNvbnN0IGxhYmVsID0gYCR7Y29sbGVjdGlvbj8uZnVsbExhYmVsIHx8IGNoYW5uZWxOYW1lfS8ke3V1aWR9YDtcbiAgICAvLyBXaGVyZSB3ZSBjYW4gcmVxdWVzdCBhIGRhdGEgY2hhbm5lbCB0aGF0IHB1c2hlcyBwdXQvZGVsZXRlIHJlcXVlc3RzIGZyb20gb3RoZXJzLlxuICAgIGNvbnN0IGNvbm5lY3Rpb25VUkwgPSBzZXJ2aWNlTmFtZS5pbmNsdWRlcz8uKCcvc2lnbmFsLycpID8gc2VydmljZU5hbWUgOiBgJHtzZXJ2aWNlTmFtZX0vJHtsYWJlbH1gO1xuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7c2VydmljZU5hbWUsIGxhYmVsLCBjb2xsZWN0aW9uLCBkZWJ1ZywgZXJyb3IsIG1pblZlcnNpb24sIG1heFZlcnNpb24sIHV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sXG5cdFx0XHQgY29ubmVjdGlvbiwgdXVpZCwgY2hhbm5lbE5hbWUsIGNvbm5lY3Rpb25VUkwsXG5cdFx0XHQgY29ubmVjdGlvblN0YXJ0VGltZTogRGF0ZS5ub3coKSxcblx0XHRcdCBjbG9zZWQ6IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpLFxuXHRcdFx0IC8vIE5vdCB1c2VkIHlldCwgYnV0IGNvdWxkIGJlIHVzZWQgdG8gR0VUIHJlc291cmNlcyBvdmVyIGh0dHAgaW5zdGVhZCBvZiB0aHJvdWdoIHRoZSBkYXRhIGNoYW5uZWwuXG5cdFx0XHQgaG9zdFJlcXVlc3RCYXNlOiBjb25uZWN0VGhyb3VnaEludGVybmV0ICYmIGAke3NlcnZpY2VOYW1lLnJlcGxhY2UoL1xcLyhzeW5jfHNpZ25hbCkvKX0vJHtjaGFubmVsTmFtZX1gfSk7XG4gICAgY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5zZXQoc2VydmljZU5hbWUsIHRoaXMpOyAvLyBNdXN0IGJlIHNldCBzeW5jaHJvbm91c2x5LCBzbyB0aGF0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxIGtub3dzIHRvIHdhaXQuXG4gIH1cbiAgc3RhdGljIGFzeW5jIGNyZWF0ZShjb2xsZWN0aW9uLCBzZXJ2aWNlTmFtZSwgb3B0aW9ucyA9IHt9KSB7IC8vIFJlY2VpdmUgcHVzaGVkIG1lc3NhZ2VzIGZyb20gdGhlIGdpdmVuIHNlcnZpY2UuIGdldC9wdXQvZGVsZXRlIHdoZW4gdGhleSBjb21lICh3aXRoIGVtcHR5IHNlcnZpY2VzIGxpc3QpLlxuICAgIGNvbnN0IHN5bmNocm9uaXplciA9IG5ldyB0aGlzKHtjb2xsZWN0aW9uLCBzZXJ2aWNlTmFtZSwgLi4ub3B0aW9uc30pO1xuICAgIGNvbnN0IGNvbm5lY3RlZFByb21pc2UgPSBzeW5jaHJvbml6ZXIuY29ubmVjdENoYW5uZWwoKTsgLy8gRXN0YWJsaXNoIGNoYW5uZWwgY3JlYXRpb24gb3JkZXIuXG4gICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgY29ubmVjdGVkUHJvbWlzZTtcbiAgICBpZiAoIWNvbm5lY3RlZCkgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgICByZXR1cm4gYXdhaXQgY29ubmVjdGVkLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdENoYW5uZWwoKSB7IC8vIFN5bmNocm9ub3VzbHkgaW5pdGlhbGl6ZSBhbnkgcHJvbWlzZXMgdG8gY3JlYXRlIGEgZGF0YSBjaGFubmVsLCBhbmQgdGhlbiBhd2FpdCBjb25uZWN0aW9uLlxuICAgIGNvbnN0IHtob3N0UmVxdWVzdEJhc2UsIHV1aWQsIGNvbm5lY3Rpb24sIHNlcnZpY2VOYW1lfSA9IHRoaXM7XG4gICAgbGV0IHN0YXJ0ZWQgPSBjb25uZWN0aW9uLmhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGlmIChzdGFydGVkKSB7XG4gICAgICAvLyBXZSBhbHJlYWR5IGhhdmUgYSBjb25uZWN0aW9uLiBKdXN0IG9wZW4gYW5vdGhlciBkYXRhIGNoYW5uZWwgZm9yIG91ciB1c2UuXG4gICAgICBzdGFydGVkID0gdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgPSBjb25uZWN0aW9uLmVuc3VyZURhdGFDaGFubmVsKHRoaXMuY2hhbm5lbE5hbWUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc2lnbmFsL2Fuc3dlcicpKSB7IC8vIFBvc3QgYW4gYW5zd2VyIHRvIGFuIG9mZmVyIHdlIGdlbmVyYXRlIGZvciBhIHJlbmRldm91cyBwZWVyLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpOyAvLyBKdXN0IGxpa2UgYSBzeW5jXG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zaWduYWwvb2ZmZXInKSkgeyAvLyBHZXQgYW4gb2ZmZXIgZnJvbSBhIHJlbmRldm91cyBwZWVyIGFuZCBwb3N0IGFuIGFuc3dlci5cbiAgICAgIC8vIFdlIG11c3Qgc3ljaHJvbm91c2x5IHN0YXJ0Q29ubmVjdGlvbiBub3cgc28gdGhhdCBvdXIgY29ubmVjdGlvbiBoYXNTdGFydGVkQ29ubmVjdGluZywgYW5kIGFueSBzdWJzZXF1ZW50IGRhdGEgY2hhbm5lbFxuICAgICAgLy8gcmVxdWVzdHMgb24gdGhlIHNhbWUgY29ubmVjdGlvbiB3aWxsIHdhaXQgKHVzaW5nIHRoZSAnc3RhcnRlZCcgcGF0aCwgYWJvdmUpLlxuICAgICAgY29uc3QgcHJvbWlzZWRTaWduYWxzID0gdGhpcy5zdGFydENvbm5lY3Rpb24oW10pOyAvLyBFc3RhYmxpc2hpbmcgb3JkZXIuXG4gICAgICBjb25zdCB1cmwgPSB0aGlzLmNvbm5lY3Rpb25VUkw7XG4gICAgICBjb25zdCBvZmZlciA9IGF3YWl0IHRoaXMuZmV0Y2godXJsKTtcbiAgICAgIHRoaXMuY29tcGxldGVDb25uZWN0aW9uKG9mZmVyKTsgLy8gTm93IHN1cHBseSB0aG9zZSBzaWduYWxzIHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gY2FuIHByb2R1Y2UgYW5zd2VyIHNpZ2Fscy5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmZldGNoKHVybCwgYXdhaXQgcHJvbWlzZWRTaWduYWxzKTsgLy8gVGVsbCB0aGUgcGVlciBhYm91dCBvdXIgYW5zd2VyLlxuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc3luYycpKSB7IC8vIENvbm5lY3Qgd2l0aCBhIHNlcnZlciByZWxheS4gKFNpZ25hbCBhbmQgc3RheSBjb25uZWN0ZWQgdGhyb3VnaCBzeW5jLilcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmNvbm5lY3RTZXJ2ZXIoKTtcbiAgICB9IGVsc2UgaWYgKHNlcnZpY2VOYW1lID09PSAnc2lnbmFscycpIHsgLy8gU3RhcnQgY29ubmVjdGlvbiBhbmQgcmV0dXJuIG51bGwuIE11c3QgYmUgY29udGludWVkIHdpdGggY29tcGxldGVTaWduYWxzU3luY2hyb25pemF0aW9uKCk7XG4gICAgICBzdGFydGVkID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShzZXJ2aWNlTmFtZSkpIHsgLy8gQSBsaXN0IG9mIFwicmVjZWl2aW5nXCIgc2lnbmFscy5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbihzZXJ2aWNlTmFtZSk7XG4gICAgfSBlbHNlIGlmIChzZXJ2aWNlTmFtZS5zeW5jaHJvbml6ZXJzKSB7IC8vIER1Y2sgdHlwaW5nIGZvciBwYXNzaW5nIGEgY29sbGVjdGlvbiBkaXJlY3RseSBhcyB0aGUgc2VydmljZUluZm8uIChXZSBkb24ndCBpbXBvcnQgQ29sbGVjdGlvbi4pXG4gICAgICBzdGFydGVkID0gdGhpcy5jb25uZWN0RGlyZWN0VGVzdGluZyhzZXJ2aWNlTmFtZSk7IC8vIFVzZWQgaW4gdGVzdGluZy5cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnJlY29nbml6ZWQgc2VydmljZSBmb3JtYXQ6ICR7c2VydmljZU5hbWV9LmApO1xuICAgIH1cbiAgICBpZiAoIShhd2FpdCBzdGFydGVkKSkge1xuICAgICAgY29uc29sZS53YXJuKHRoaXMubGFiZWwsICdjb25uZWN0aW9uIGZhaWxlZCcpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAodGhpcy5kZWJ1ZykgY29uc29sZS5sb2codGhpcy5sYWJlbCwgLi4ucmVzdCk7XG4gIH1cbiAgZ2V0IGRhdGFDaGFubmVsUHJvbWlzZSgpIHsgLy8gQSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gYW4gb3BlbiBkYXRhIGNoYW5uZWwuXG4gICAgY29uc3QgcHJvbWlzZSA9IHRoaXMuX2RhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBpZiAoIXByb21pc2UpIHRocm93IG5ldyBFcnJvcihgJHt0aGlzLmxhYmVsfTogRGF0YSBjaGFubmVsIGlzIG5vdCB5ZXQgcHJvbWlzZWQuYCk7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgY2hhbm5lbENsb3NlZENsZWFudXAoKSB7IC8vIEJvb2trZWVwaW5nIHdoZW4gY2hhbm5lbCBjbG9zZWQgb3IgZXhwbGljaXRseSBhYmFuZG9uZWQgYmVmb3JlIG9wZW5pbmcuXG4gICAgdGhpcy5jb2xsZWN0aW9uPy5zeW5jaHJvbml6ZXJzLmRlbGV0ZSh0aGlzLnNlcnZpY2VOYW1lKTtcbiAgICB0aGlzLmNsb3NlZC5yZXNvbHZlKHRoaXMpOyAvLyBSZXNvbHZlIHRvIHN5bmNocm9uaXplciBpcyBuaWNlIGlmLCBlLmcsIHNvbWVvbmUgaXMgUHJvbWlzZS5yYWNpbmcuXG4gIH1cbiAgc2V0IGRhdGFDaGFubmVsUHJvbWlzZShwcm9taXNlKSB7IC8vIFNldCB1cCBtZXNzYWdlIGFuZCBjbG9zZSBoYW5kbGluZy5cbiAgICB0aGlzLl9kYXRhQ2hhbm5lbFByb21pc2UgPSBwcm9taXNlLnRoZW4oZGF0YUNoYW5uZWwgPT4ge1xuICAgICAgZGF0YUNoYW5uZWwub25tZXNzYWdlID0gZXZlbnQgPT4gdGhpcy5yZWNlaXZlKGV2ZW50LmRhdGEpO1xuICAgICAgZGF0YUNoYW5uZWwub25jbG9zZSA9IGFzeW5jIGV2ZW50ID0+IHRoaXMuY2hhbm5lbENsb3NlZENsZWFudXAoKTtcbiAgICAgIHJldHVybiBkYXRhQ2hhbm5lbDtcbiAgICB9KTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZSgpIHtcbiAgICBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBhd2FpdCB0aGlzLnN0YXJ0ZWRTeW5jaHJvbml6YXRpb247XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cbiAgc3RhdGljIGZyYWdtZW50SWQgPSAwO1xuICBhc3luYyBzZW5kKG1ldGhvZCwgLi4ucGFyYW1zKSB7IC8vIFNlbmRzIHRvIHRoZSBwZWVyLCBvdmVyIHRoZSBkYXRhIGNoYW5uZWxcbiAgICAvLyBUT0RPOiBicmVhayB1cCBsb25nIG1lc3NhZ2VzLiAoQXMgYSBwcmFjdGljYWwgbWF0dGVyLCAxNiBLaUIgaXMgdGhlIGxvbmdlc3QgdGhhdCBjYW4gcmVsaWFibHkgYmUgc2VudCBhY3Jvc3MgZGlmZmVyZW50IHdydGMgaW1wbGVtZW50YXRpb25zLilcbiAgICAvLyBTZWUgaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL1dlYlJUQ19BUEkvVXNpbmdfZGF0YV9jaGFubmVscyNjb25jZXJuc193aXRoX2xhcmdlX21lc3NhZ2VzXG4gICAgY29uc3QgcGF5bG9hZCA9IEpTT04uc3RyaW5naWZ5KHttZXRob2QsIHBhcmFtc30pO1xuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgY29uc3Qgc3RhdGUgPSBkYXRhQ2hhbm5lbD8ucmVhZHlTdGF0ZSB8fCAnY2xvc2VkJztcbiAgICBpZiAoc3RhdGUgPT09ICdjbG9zZWQnIHx8IHN0YXRlID09PSAnY2xvc2luZycpIHJldHVybjtcbiAgICB0aGlzLmxvZygnc2VuZHMnLCBtZXRob2QsIC4uLnBhcmFtcyk7XG4gICAgY29uc3Qgc2l6ZSA9IDE2ZTM7IC8vIEEgYml0IGxlc3MgdGhhbiAxNiAqIDEwMjQuXG4gICAgaWYgKHBheWxvYWQubGVuZ3RoIDwgc2l6ZSkge1xuICAgICAgZGF0YUNoYW5uZWwuc2VuZChwYXlsb2FkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgbnVtQ2h1bmtzID0gTWF0aC5jZWlsKHBheWxvYWQubGVuZ3RoIC8gc2l6ZSk7XG4gICAgY29uc3QgaWQgPSB0aGlzLmNvbnN0cnVjdG9yLmZyYWdtZW50SWQrKztcbiAgICBjb25zdCBtZXRhID0ge21ldGhvZDogJ2ZyYWdtZW50cycsIHBhcmFtczogW2lkLCBudW1DaHVua3NdfTtcbiAgICAvL2NvbnNvbGUubG9nKGBGcmFnbWVudGluZyBtZXNzYWdlICR7aWR9IGludG8gJHtudW1DaHVua3N9IGNodW5rcy5gLCBtZXRhKTtcbiAgICBkYXRhQ2hhbm5lbC5zZW5kKEpTT04uc3RyaW5naWZ5KG1ldGEpKTtcbiAgICAvLyBPcHRpbWl6YXRpb24gb3Bwb3J0dW5pdHk6IHJlbHkgb24gbWVzc2FnZXMgYmVpbmcgb3JkZXJlZCBhbmQgc2tpcCByZWR1bmRhbnQgaW5mby4gSXMgaXQgd29ydGggaXQ/XG4gICAgZm9yIChsZXQgaSA9IDAsIG8gPSAwOyBpIDwgbnVtQ2h1bmtzOyArK2ksIG8gKz0gc2l6ZSkge1xuICAgICAgY29uc3QgZnJhZyA9IHttZXRob2Q6ICdmcmFnJywgcGFyYW1zOiBbaWQsIGksIHBheWxvYWQuc3Vic3RyKG8sIHNpemUpXX07XG4gICAgICBkYXRhQ2hhbm5lbC5zZW5kKEpTT04uc3RyaW5naWZ5KGZyYWcpKTtcbiAgICB9XG4gIH1cbiAgcmVjZWl2ZSh0ZXh0KSB7IC8vIERpc3BhdGNoIGEgbWVzc2FnZSBzZW50IG92ZXIgdGhlIGRhdGEgY2hhbm5lbCBmcm9tIHRoZSBwZWVyLlxuICAgIGNvbnN0IHttZXRob2QsIHBhcmFtc30gPSBKU09OLnBhcnNlKHRleHQpO1xuICAgIHRoaXNbbWV0aG9kXSguLi5wYXJhbXMpO1xuICB9XG4gIHBlbmRpbmdGcmFnbWVudHMgPSB7fTtcbiAgZnJhZ21lbnRzKGlkLCBudW1DaHVua3MpIHtcbiAgICAvL2NvbnNvbGUubG9nKGBSZWNlaXZpbmcgbWVzYWdlICR7aWR9IGluICR7bnVtQ2h1bmtzfS5gKTtcbiAgICB0aGlzLnBlbmRpbmdGcmFnbWVudHNbaWRdID0ge3JlbWFpbmluZzogbnVtQ2h1bmtzLCBtZXNzYWdlOiBBcnJheShudW1DaHVua3MpfTtcbiAgfVxuICBmcmFnKGlkLCBpLCBmcmFnbWVudCkge1xuICAgIGxldCBmcmFnID0gdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXTsgLy8gV2UgYXJlIHJlbHlpbmcgb24gZnJhZ21lbnQgbWVzc2FnZSBjb21pbmcgZmlyc3QuXG4gICAgZnJhZy5tZXNzYWdlW2ldID0gZnJhZ21lbnQ7XG4gICAgaWYgKDAgIT09IC0tZnJhZy5yZW1haW5pbmcpIHJldHVybjtcbiAgICAvL2NvbnNvbGUubG9nKGBEaXNwYXRjaGluZyBtZXNzYWdlICR7aWR9LmApO1xuICAgIHRoaXMucmVjZWl2ZShmcmFnLm1lc3NhZ2Uuam9pbignJykpO1xuICAgIGRlbGV0ZSB0aGlzLnBlbmRpbmdGcmFnbWVudHNbaWRdO1xuICB9XG5cbiAgYXN5bmMgZGlzY29ubmVjdCgpIHsgLy8gV2FpdCBmb3IgZGF0YUNoYW5uZWwgdG8gZHJhaW4gYW5kIHJldHVybiBhIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIGFjdHVhbGx5IGNsb3NlZCxcbiAgICAvLyBidXQgcmV0dXJuIGltbWVkaWF0ZWx5IGlmIGNvbm5lY3Rpb24gbm90IHN0YXJ0ZWQuXG4gICAgaWYgKHRoaXMuY29ubmVjdGlvbi5wZWVyLmNvbm5lY3Rpb25TdGF0ZSAhPT0gJ2Nvbm5lY3RlZCcpIHJldHVybiB0aGlzLmNoYW5uZWxDbG9zZWRDbGVhbnVwKHRoaXMuY29ubmVjdGlvbi5jbG9zZSgpKTtcbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGRhdGFDaGFubmVsLmNsb3NlKCk7XG4gICAgcmV0dXJuIHRoaXMuY2xvc2VkO1xuICB9XG4gIC8vIFRPRE86IHdlYnJ0YyBuZWdvdGlhdGlvbiBuZWVkZWQgZHVyaW5nIHN5bmMuXG4gIC8vIFRPRE86IHdlYnJ0YyBuZWdvdGlhdGlvbiBuZWVkZWQgYWZ0ZXIgc3luYy5cbiAgc3RhcnRDb25uZWN0aW9uKHNpZ25hbE1lc3NhZ2VzKSB7IC8vIE1hY2hpbmVyeSBmb3IgbWFraW5nIGEgV2ViUlRDIGNvbm5lY3Rpb24gdG8gdGhlIHBlZXI6XG4gICAgLy8gICBJZiBzaWduYWxNZXNzYWdlcyBpcyBhIGxpc3Qgb2YgW29wZXJhdGlvbiwgbWVzc2FnZV0gbWVzc2FnZSBvYmplY3RzLCB0aGVuIHRoZSBvdGhlciBzaWRlIGlzIGluaXRpYXRpbmdcbiAgICAvLyB0aGUgY29ubmVjdGlvbiBhbmQgaGFzIHNlbnQgYW4gaW5pdGlhbCBvZmZlci9pY2UuIEluIHRoaXMgY2FzZSwgY29ubmVjdCgpIHByb21pc2VzIGEgcmVzcG9uc2VcbiAgICAvLyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUuXG4gICAgLy8gICBPdGhlcndpc2UsIGNvbm5lY3QoKSBwcm9taXNlcyBhIGxpc3Qgb2YgaW5pdGlhbCBzaWduYWwgbWVzc2FnZXMgdG8gYmUgZGVsaXZlcmVkIHRvIHRoZSBvdGhlciBzaWRlLFxuICAgIC8vIGFuZCBpdCBpcyBuZWNlc3NhcnkgdG8gdGhlbiBjYWxsIGNvbXBsZXRlQ29ubmVjdGlvbigpIHdpdGggdGhlIHJlc3BvbnNlIGZyb20gdGhlbS5cbiAgICAvLyBJbiBib3RoIGNhc2VzLCBhcyBhIHNpZGUgZWZmZWN0LCB0aGUgZGF0YUNoYW5uZWxQcm9taXNlIHByb3BlcnR5IHdpbGwgYmUgc2V0IHRvIGEgUHJvbWlzZVxuICAgIC8vIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIGRhdGEgY2hhbm5lbCB3aGVuIGl0IGlzIG9wZW5zLiBUaGlzIHByb21pc2UgaXMgdXNlZCBieSBzZW5kKCkgYW5kIHJlY2VpdmUoKS5cbiAgICBjb25zdCB7Y29ubmVjdGlvbn0gPSB0aGlzO1xuICAgIHRoaXMubG9nKHNpZ25hbE1lc3NhZ2VzID8gJ2dlbmVyYXRpbmcgYW5zd2VyJyA6ICdnZW5lcmF0aW5nIG9mZmVyJyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgPSBjb25uZWN0aW9uLmVuc3VyZURhdGFDaGFubmVsKHRoaXMuY2hhbm5lbE5hbWUsIHt9LCBzaWduYWxNZXNzYWdlcyk7XG4gICAgcmV0dXJuIGNvbm5lY3Rpb24uc2lnbmFscztcbiAgfVxuICBjb21wbGV0ZUNvbm5lY3Rpb24oc2lnbmFsTWVzc2FnZXMpIHsgLy8gRmluaXNoIHdoYXQgd2FzIHN0YXJ0ZWQgd2l0aCBzdGFydENvbGxlY3Rpb24uXG4gICAgLy8gRG9lcyBub3QgcmV0dXJuIGEgcHJvbWlzZS4gQ2xpZW50IGNhbiBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSB0byBzZWUgd2hlbiB3ZSBhcmUgYWN0dWFsbHkgY29ubmVjdGVkLlxuICAgIGlmICghc2lnbmFsTWVzc2FnZXMpIHJldHVybiBmYWxzZTtcbiAgICB0aGlzLmNvbm5lY3Rpb24uc2lnbmFscyA9IHNpZ25hbE1lc3NhZ2VzO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgc3RhdGljIGZldGNoSlNPTih1cmwsIGJvZHkgPSB1bmRlZmluZWQsIG1ldGhvZCA9IG51bGwpIHtcbiAgICBjb25zdCBoYXNCb2R5ID0gYm9keSAhPT0gdW5kZWZpbmVkO1xuICAgIG1ldGhvZCA/Pz0gaGFzQm9keSA/ICdQT1NUJyA6ICdHRVQnO1xuICAgIHJldHVybiBmZXRjaCh1cmwsIGhhc0JvZHkgPyB7bWV0aG9kLCBoZWFkZXJzOiB7XCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCJ9LCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KX0gOiB7bWV0aG9kfSlcbiAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcblx0aWYgKCFyZXNwb25zZS5vaykgdGhyb3cgbmV3IEVycm9yKGAke3Jlc3BvbnNlLnN0YXR1c1RleHQgfHwgJ0ZldGNoIGZhaWxlZCd9LCBjb2RlICR7cmVzcG9uc2Uuc3RhdHVzfSBpbiAke3VybH0uYCk7XG5cdHJldHVybiByZXNwb25zZS5qc29uKCk7XG4gICAgICB9KTtcbiAgfVxuICBhc3luYyBmZXRjaCh1cmwsIGJvZHkgPSB1bmRlZmluZWQpIHsgLy8gQXMgSlNPTlxuXG4gICAgaWYgKHRoaXMuZGVidWcpIHRoaXMubG9nKCdmZXRjaCBzaWduYWxzJywgdXJsLCBKU09OLnN0cmluZ2lmeShib2R5LCBudWxsLCAyKSk7IC8vIFRPRE86IHN0cmluZ2lmeSBpbiBsb2cgaW5zdGVhZCBvZiBuZWVkaW5nIHRvIGd1YXJkIHdpdGggdGhpcy5kZWJ1Zy5cbiAgICBjb25zdCByZXN1bHQgPSB0aGlzLmNvbnN0cnVjdG9yLmZldGNoSlNPTih1cmwsIGJvZHkpXG5cdCAgLmNhdGNoKGVycm9yID0+IHtcblx0ICAgIHRoaXMuY2xvc2VkLnJlamVjdChlcnJvcik7XG5cdCAgfSk7XG4gICAgaWYgKCFyZXN1bHQpIHJldHVybiBudWxsO1xuICAgIGlmICh0aGlzLmRlYnVnKSB0aGlzLmxvZygnZmV0Y2ggcmVzcG9uc2VTaWduYWxzJywgdXJsLCBKU09OLnN0cmluZ2lmeShyZXN1bHQsIG51bGwsIDIpKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG4gIGFzeW5jIGNvbm5lY3RTZXJ2ZXIodXJsID0gdGhpcy5jb25uZWN0aW9uVVJMKSB7IC8vIENvbm5lY3QgdG8gYSByZWxheSBvdmVyIGh0dHAuIENvbXBhcmUgY29ubmVjdFJlbmRldm91c1xuICAgIC8vIHN0YXJ0Q29ubmVjdGlvbiwgcG9zdCBpdCwgY29tcGxldGVDb25uZWN0aW9uIHdpdGggdGhlIHJlc3BvbnNlLlxuICAgIC8vIE91ciB3ZWJydGMgc3luY2hyb25pemVyIGlzIHRoZW4gY29ubmVjdGVkIHRvIHRoZSByZWxheSdzIHdlYnJ0IHN5bmNocm9uaXplci5cbiAgICBjb25zdCBvdXJTaWduYWxzUHJvbWlzZSA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7IC8vIG11c3QgYmUgc3luY2hyb25vdXMgdG8gcHJlc2VydmUgY2hhbm5lbCBpZCBvcmRlci5cbiAgICBjb25zdCBvdXJTaWduYWxzID0gYXdhaXQgb3VyU2lnbmFsc1Byb21pc2U7XG4gICAgY29uc3QgdGhlaXJTaWduYWxzID0gYXdhaXQgdGhpcy5mZXRjaCh1cmwsIG91clNpZ25hbHMpO1xuICAgIHJldHVybiB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbih0aGVpclNpZ25hbHMpO1xuICB9XG4gIGFzeW5jIGNvbXBsZXRlU2lnbmFsc1N5bmNocm9uaXphdGlvbihzaWduYWxzKSB7IC8vIEdpdmVuIGFuc3dlci9pY2Ugc2lnbmFscywgY29tcGxldGUgdGhlIGNvbm5lY3Rpb24gYW5kIHN0YXJ0IHN5bmNocm9uaXplLlxuICAgIGF3YWl0IHRoaXMuY29tcGxldGVDb25uZWN0aW9uKHNpZ25hbHMpO1xuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemUoKTtcbiAgfVxuICBhc3luYyBjb25uZWN0RGlyZWN0VGVzdGluZyhwZWVyQ29sbGVjdGlvbikgeyAvLyBVc2VkIGluIHVuaXQgdGVzdGluZywgd2hlcmUgdGhlIFwicmVtb3RlXCIgc2VydmljZSBpcyBzcGVjaWZpZWQgZGlyZWN0bHkgKG5vdCBhIHN0cmluZykuXG4gICAgLy8gRWFjaCBjb2xsZWN0aW9uIGlzIGFza2VkIHRvIHN5Y2hyb25pemUgdG8gYW5vdGhlciBjb2xsZWN0aW9uLlxuICAgIGNvbnN0IHBlZXJTeW5jaHJvbml6ZXIgPSBwZWVyQ29sbGVjdGlvbi5zeW5jaHJvbml6ZXJzLmdldCh0aGlzLmNvbGxlY3Rpb24pO1xuICAgIGlmICghcGVlclN5bmNocm9uaXplcikgeyAvLyBUaGUgb3RoZXIgc2lkZSBkb2Vzbid0IGtub3cgYWJvdXQgdXMgeWV0LiBUaGUgb3RoZXIgc2lkZSB3aWxsIGRvIHRoZSB3b3JrLlxuICAgICAgdGhpcy5fZGVsYXkgPSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UoKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3Qgb3VyU2lnbmFscyA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7XG4gICAgY29uc3QgdGhlaXJTaWduYWxzID0gYXdhaXQgcGVlclN5bmNocm9uaXplci5zdGFydENvbm5lY3Rpb24oYXdhaXQgb3VyU2lnbmFscyk7XG4gICAgcGVlclN5bmNocm9uaXplci5fZGVsYXkucmVzb2x2ZSgpO1xuICAgIHJldHVybiB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbih0aGVpclNpZ25hbHMpO1xuICB9XG5cbiAgLy8gQSBjb21tb24gcHJhY3RpY2UgaGVyZSBpcyB0byBoYXZlIGEgcHJvcGVydHkgdGhhdCBpcyBhIHByb21pc2UgZm9yIGhhdmluZyBzb21ldGhpbmcgZG9uZS5cbiAgLy8gQXN5bmNocm9ub3VzIG1hY2hpbmVyeSBjYW4gdGhlbiByZXNvbHZlIGl0LlxuICAvLyBBbnl0aGluZyB0aGF0IGRlcGVuZHMgb24gdGhhdCBjYW4gYXdhaXQgdGhlIHJlc29sdmVkIHZhbHVlLCB3aXRob3V0IHdvcnJ5aW5nIGFib3V0IGhvdyBpdCBnZXRzIHJlc29sdmVkLlxuICAvLyBXZSBjYWNoZSB0aGUgcHJvbWlzZSBzbyB0aGF0IHdlIGRvIG5vdCByZXBldGVkbHkgdHJpZ2dlciB0aGUgdW5kZXJseWluZyBhY3Rpb24uXG4gIG1ha2VSZXNvbHZlYWJsZVByb21pc2UoaWdub3JlZCkgeyAvLyBBbnN3ZXIgYSBQcm9taXNlIHRoYXQgY2FuIGJlIHJlc29sdmUgd2l0aCB0aGVQcm9taXNlLnJlc29sdmUodmFsdWUpLlxuICAgIC8vIFRoZSBpZ25vcmVkIGFyZ3VtZW50IGlzIGEgY29udmVuaWVudCBwbGFjZSB0byBjYWxsIHNvbWV0aGluZyBmb3Igc2lkZS1lZmZlY3QuXG4gICAgbGV0IHJlc29sdmVyLCByZWplY3RlcjtcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4geyByZXNvbHZlciA9IHJlc29sdmU7IHJlamVjdGVyID0gcmVqZWN0OyB9KTtcbiAgICBwcm9taXNlLnJlc29sdmUgPSByZXNvbHZlcjtcbiAgICBwcm9taXNlLnJlamVjdCA9IHJlamVjdGVyO1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG5cbiAgYXN5bmMgdmVyc2lvbnMobWluLCBtYXgpIHsgLy8gT24gcmVjZWl2aW5nIHRoZSB2ZXJzaW9ucyBzdXBwb3J0ZWQgYnkgdGhlIHRoZSBwZWVyLCByZXNvbHZlIHRoZSB2ZXJzaW9uIHByb21pc2UuXG4gICAgbGV0IHZlcnNpb25Qcm9taXNlID0gdGhpcy52ZXJzaW9uO1xuICAgIGNvbnN0IGNvbWJpbmVkTWF4ID0gTWF0aC5taW4obWF4LCB0aGlzLm1heFZlcnNpb24pO1xuICAgIGNvbnN0IGNvbWJpbmVkTWluID0gTWF0aC5tYXgobWluLCB0aGlzLm1pblZlcnNpb24pO1xuICAgIGlmIChjb21iaW5lZE1heCA+PSBjb21iaW5lZE1pbikgcmV0dXJuIHZlcnNpb25Qcm9taXNlLnJlc29sdmUoY29tYmluZWRNYXgpOyAvLyBObyBuZWVkIHRvIHJlc3BvbmQsIGFzIHRoZXkgd2lsbCBwcm9kdWNlIHRoZSBzYW1lIGRldGVybWluaXN0aWMgYW5zd2VyLlxuICAgIHJldHVybiB2ZXJzaW9uUHJvbWlzZS5yZXNvbHZlKDApO1xuICB9XG4gIGdldCB2ZXJzaW9uKCkgeyAvLyBQcm9taXNlIHRoZSBoaWdoZXN0IHZlcnNpb24gc3Vwb3J0ZWQgYnkgYm90aCBzaWRlcywgb3IgZGlzY29ubmVjdCBhbmQgZmFsc3kgaWYgbm9uZS5cbiAgICAvLyBUZWxscyB0aGUgb3RoZXIgc2lkZSBvdXIgdmVyc2lvbnMgaWYgd2UgaGF2ZW4ndCB5ZXQgZG9uZSBzby5cbiAgICAvLyBGSVhNRTogY2FuIHdlIGF2b2lkIHRoaXMgdGltZW91dD9cbiAgICByZXR1cm4gdGhpcy5fdmVyc2lvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHNldFRpbWVvdXQoKCkgPT4gdGhpcy5zZW5kKCd2ZXJzaW9ucycsIHRoaXMubWluVmVyc2lvbiwgdGhpcy5tYXhWZXJzaW9uKSwgMjAwKSk7XG4gIH1cblxuICBnZXQgc3RhcnRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gd2UgaGF2ZSBzdGFydGVkIHN5bmNocm9uaXphdGlvbi5cbiAgICByZXR1cm4gdGhpcy5fc3RhcnRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5zdGFydFN5bmNocm9uaXphdGlvbigpO1xuICB9XG4gIGdldCBjb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbnVtYmVyIG9mIGl0ZW1zIHRoYXQgd2VyZSB0cmFuc2ZlcnJlZCAobm90IG5lY2Vzc2FyaWxseSB3cml0dGVuKS5cbiAgICAvLyBTdGFydHMgc3luY2hyb25pemF0aW9uIGlmIGl0IGhhc24ndCBhbHJlYWR5LiBFLmcuLCB3YWl0aW5nIG9uIGNvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB3b24ndCByZXNvbHZlIHVudGlsIGFmdGVyIGl0IHN0YXJ0cy5cbiAgICByZXR1cm4gdGhpcy5fY29tcGxldGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UodGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uKTtcbiAgfVxuICBnZXQgcGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBudW1iZXIgb2YgaXRlbXMgdGhhdCB0aGUgcGVlciBzeW5jaHJvbml6ZWQuXG4gICAgcmV0dXJuIHRoaXMuX3BlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpO1xuICB9XG4gIGdldCBib3RoU2lkZXNDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgcmVzb2x2ZXMgdHJ1dGh5IHdoZW4gYm90aCBzaWRlcyBhcmUgZG9uZS5cbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24udGhlbigoKSA9PiB0aGlzLnBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24pO1xuICB9XG4gIGFzeW5jIHJlcG9ydENvbm5lY3Rpb24oKSB7IC8vIExvZyBjb25uZWN0aW9uIHRpbWUgYW5kIHR5cGUuXG4gICAgY29uc3Qgc3RhdHMgPSBhd2FpdCB0aGlzLmNvbm5lY3Rpb24ucGVlci5nZXRTdGF0cygpO1xuICAgIGxldCB0cmFuc3BvcnQ7XG4gICAgZm9yIChjb25zdCByZXBvcnQgb2Ygc3RhdHMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChyZXBvcnQudHlwZSA9PT0gJ3RyYW5zcG9ydCcpIHtcblx0dHJhbnNwb3J0ID0gcmVwb3J0O1xuXHRicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgbGV0IGNhbmRpZGF0ZVBhaXIgPSB0cmFuc3BvcnQgJiYgc3RhdHMuZ2V0KHRyYW5zcG9ydC5zZWxlY3RlZENhbmRpZGF0ZVBhaXJJZCk7XG4gICAgaWYgKCFjYW5kaWRhdGVQYWlyKSB7IC8vIFNhZmFyaSBkb2Vzbid0IGZvbGxvdyB0aGUgc3RhbmRhcmQuXG4gICAgICBmb3IgKGNvbnN0IHJlcG9ydCBvZiBzdGF0cy52YWx1ZXMoKSkge1xuXHRpZiAoKHJlcG9ydC50eXBlID09PSAnY2FuZGlkYXRlLXBhaXInKSAmJiByZXBvcnQuc2VsZWN0ZWQpIHtcblx0ICBjYW5kaWRhdGVQYWlyID0gcmVwb3J0O1xuXHQgIGJyZWFrO1xuXHR9XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghY2FuZGlkYXRlUGFpcikge1xuICAgICAgY29uc29sZS53YXJuKHRoaXMubGFiZWwsICdnb3Qgc3RhdHMgd2l0aG91dCBjYW5kaWRhdGVQYWlyJywgQXJyYXkuZnJvbShzdGF0cy52YWx1ZXMoKSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZW1vdGUgPSBzdGF0cy5nZXQoY2FuZGlkYXRlUGFpci5yZW1vdGVDYW5kaWRhdGVJZCk7XG4gICAgY29uc3Qge3Byb3RvY29sLCBjYW5kaWRhdGVUeXBlfSA9IHJlbW90ZTtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge3N0YXRzLCB0cmFuc3BvcnQsIGNhbmRpZGF0ZVBhaXIsIHJlbW90ZSwgcHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGUsIHN5bmNocm9uaXphdGlvblN0YXJ0VGltZTogbm93fSk7XG4gICAgY29uc29sZS5pbmZvKHRoaXMubGFiZWwsICdjb25uZWN0ZWQnLCBwcm90b2NvbCwgY2FuZGlkYXRlVHlwZSwgKChub3cgLSB0aGlzLmNvbm5lY3Rpb25TdGFydFRpbWUpLzFlMykudG9GaXhlZCgxKSk7XG4gIH1cbiAgYXN5bmMgc3RhcnRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFdhaXQgZm9yIGFsbCBwcmVsaW1pbmFyaWVzLCBhbmQgc3RhcnQgc3RyZWFtaW5nIG91ciB0YWdzLlxuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgaWYgKCFkYXRhQ2hhbm5lbCkgdGhyb3cgbmV3IEVycm9yKGBObyBjb25uZWN0aW9uIGZvciAke3RoaXMubGFiZWx9LmApO1xuICAgIC8vIE5vdyB0aGF0IHdlIGFyZSBjb25uZWN0ZWQsIGFueSBuZXcgd3JpdGVzIG9uIG91ciBlbmQgd2lsbCBiZSBwdXNoZWQgdG8gdGhlIHBlZXIuIFNvIGNhcHR1cmUgdGhlIGluaXRpYWwgdGFncyBub3cuXG4gICAgY29uc3Qgb3VyVGFncyA9IG5ldyBTZXQoYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnRhZ3MpO1xuICAgIGF3YWl0IHRoaXMucmVwb3J0Q29ubmVjdGlvbigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge1xuXG4gICAgICAvLyBBIHNuYXBzaG90IFNldCBvZiBlYWNoIHRhZyB3ZSBoYXZlIGxvY2FsbHksIGNhcHR1cmVkIGF0IHRoZSBtb21lbnQgb2YgY3JlYXRpb24uXG4gICAgICBvdXJUYWdzLCAvLyAoTmV3IGxvY2FsIHdyaXRlcyBhcmUgcHVzaGVkIHRvIHRoZSBjb25uZWN0ZWQgcGVlciwgZXZlbiBkdXJpbmcgc3luY2hyb25pemF0aW9uLilcblxuICAgICAgLy8gTWFwIG9mIHRhZyB0byBwcm9taXNlIGZvciB0YWdzIHRoYXQgYXJlIGJlaW5nIHN5bmNocm9uaXplZC5cbiAgICAgIC8vIGVuc3VyZVN5bmNocm9uaXplZFRhZyBlbnN1cmVzIHRoYXQgdGhlcmUgaXMgYW4gZW50cnkgaGVyZSBkdXJpbmcgdGhlIHRpbWUgYSB0YWcgaXMgaW4gZmxpZ2h0LlxuICAgICAgdW5zeW5jaHJvbml6ZWQ6IG5ldyBNYXAoKSxcblxuICAgICAgLy8gU2V0IG9mIHdoYXQgdGFncyBoYXZlIGJlZW4gZXhwbGljaXRseSBzeW5jaHJvbml6ZWQsIG1lYW5pbmcgdGhhdCB0aGVyZSBpcyBhIGRpZmZlcmVuY2UgYmV0d2VlbiB0aGVpciBoYXNoXG4gICAgICAvLyBhbmQgb3Vycywgc3VjaCB0aGF0IHdlIGFzayBmb3IgdGhlaXIgc2lnbmF0dXJlIHRvIGNvbXBhcmUgaW4gZGV0YWlsLiBUaHVzIHRoaXMgc2V0IG1heSBpbmNsdWRlIGl0ZW1zIHRoYXRcbiAgICAgIGNoZWNrZWRUYWdzOiBuZXcgU2V0KCksIC8vIHdpbGwgbm90IGVuZCB1cCBiZWluZyByZXBsYWNlZCBvbiBvdXIgZW5kLlxuXG4gICAgICBlbmRPZlBlZXJUYWdzOiBmYWxzZSAvLyBJcyB0aGUgcGVlciBmaW5pc2hlZCBzdHJlYW1pbmc/XG4gICAgfSk7XG4gICAgLy8gTm93IG5lZ290aWF0ZSB2ZXJzaW9uIGFuZCBjb2xsZWN0cyB0aGUgdGFncy5cbiAgICBjb25zdCB2ZXJzaW9uID0gYXdhaXQgdGhpcy52ZXJzaW9uO1xuICAgIGNvbnN0IHttaW5WZXJzaW9uLCBtYXhWZXJzaW9ufSA9IHRoaXM7XG4gICAgaWYgKCF2ZXJzaW9uKSB7ICAvLyBNaXNtYXRjaC5cbiAgICAgIGF3YWl0IHRoaXMuZGlzY29ubmVjdCgpO1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGAke3RoaXMuc2VydmljZU5hbWV9IGRvZXMgbm90IHVzZSBhIGNvbXBhdGlibGUgdmVyc2lvbi5gO1xuICAgICAgaWYgKHR5cGVvZih3aW5kb3cpID09PSAndW5kZWZpbmVkJykge1xuXHRjb25zb2xlLmVycm9yKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIHsgLy8gSWYgd2UncmUgaW4gYSBicm93c2VyLCB0ZWxsIHRoZSB1c2VyLlxuXHRjb25zb2xlLmxvZyh7dmVyc2lvbiwgbWluVmVyc2lvbiwgbWF4VmVyc2lvbiwgY2FjaGVzOiBhd2FpdCB3aW5kb3cuY2FjaGVzLmtleXMoKSwgcmVnaXN0cmF0aW9uczogYXdhaXQgbmF2aWdhdG9yLnNlcnZpY2VXb3JrZXIuZ2V0UmVnaXN0cmF0aW9ucygpLCBkYnM6IGF3YWl0IHdpbmRvdy5pbmRleGVkREIuZGF0YWJhc2VzKCksIGxvY2FsOiB3aW5kb3cubG9jYWxTdG9yYWdlLmxlbmd0aH0pO1xuXHR3aW5kb3cuYWxlcnQobWVzc2FnZSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuc3RyZWFtVGFncyhvdXJUYWdzKTsgLy8gQnV0IGRvIG5vdCB3YWl0IGZvciBpdC5cbiAgfVxuICBhc3luYyBjb21wdXRlSGFzaCh0ZXh0KSB7IC8vIE91ciBzdGFuZGFyZCBoYXNoLiAoU3RyaW5nIHNvIHRoYXQgaXQgaXMgc2VyaWFsaXphYmxlLilcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgQ3JlZGVudGlhbHMuaGFzaFRleHQodGV4dCk7XG4gICAgcmV0dXJuIENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChoYXNoKTtcbiAgfVxuICBhc3luYyBnZXRIYXNoKHRhZykgeyAvLyBXaG9sZSBzaWduYXR1cmUgKE5PVCBwcm90ZWN0ZWRIZWFkZXIuc3ViIG9mIGNvbnRlbnQpLlxuICAgIGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMuY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgICByZXR1cm4gdGhpcy5jb21wdXRlSGFzaChyYXcgfHwgJ21pc3NpbmcnKTtcbiAgfVxuICBhc3luYyBzdHJlYW1UYWdzKHRhZ3MpIHsgLy8gU2VuZCBlYWNoIG9mIG91ciBrbm93biB0YWcvaGFzaCBwYWlycyB0byBwZWVyLCBvbmUgYXQgYSB0aW1lLCBmb2xsb3dlZCBieSBlbmRPZlRhZ3MuXG4gICAgZm9yIChjb25zdCB0YWcgb2YgdGFncykge1xuICAgICAgdGhpcy5zZW5kKCdoYXNoJywgdGFnLCBhd2FpdCB0aGlzLmdldEhhc2godGFnKSk7XG4gICAgfVxuICAgIHRoaXMuc2VuZCgnZW5kVGFncycpO1xuICB9XG4gIGFzeW5jIGVuZFRhZ3MoKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBzdHJlYW1UYWdzKCkuXG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHRoaXMuZW5kT2ZQZWVyVGFncyA9IHRydWU7XG4gICAgdGhpcy5jbGVhblVwSWZGaW5pc2hlZCgpO1xuICB9XG4gIHN5bmNocm9uaXphdGlvbkNvbXBsZXRlKG5DaGVja2VkKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBnZXR0aW5nIGFsbCB0aGUgZGF0YSBpdCBuZWVkcyBmcm9tIHVzLlxuICAgIHRoaXMucGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBjbGVhblVwSWZGaW5pc2hlZCgpIHsgLy8gSWYgd2UgYXJlIG5vdCB3YWl0aW5nIGZvciBhbnl0aGluZywgd2UncmUgZG9uZS4gQ2xlYW4gdXAuXG4gICAgLy8gVGhpcyByZXF1aXJlcyB0aGF0IHRoZSBwZWVyIGhhcyBpbmRpY2F0ZWQgdGhhdCBpdCBpcyBmaW5pc2hlZCBzdHJlYW1pbmcgdGFncyxcbiAgICAvLyBhbmQgdGhhdCB3ZSBhcmUgbm90IHdhaXRpbmcgZm9yIGFueSBmdXJ0aGVyIHVuc3luY2hyb25pemVkIGl0ZW1zLlxuICAgIGlmICghdGhpcy5lbmRPZlBlZXJUYWdzIHx8IHRoaXMudW5zeW5jaHJvbml6ZWQuc2l6ZSkgcmV0dXJuO1xuICAgIGNvbnN0IG5DaGVja2VkID0gdGhpcy5jaGVja2VkVGFncy5zaXplOyAvLyBUaGUgbnVtYmVyIHRoYXQgd2UgY2hlY2tlZC5cbiAgICB0aGlzLnNlbmQoJ3N5bmNocm9uaXphdGlvbkNvbXBsZXRlJywgbkNoZWNrZWQpO1xuICAgIHRoaXMuY2hlY2tlZFRhZ3MuY2xlYXIoKTtcbiAgICB0aGlzLnVuc3luY2hyb25pemVkLmNsZWFyKCk7XG4gICAgdGhpcy5vdXJUYWdzID0gdGhpcy5zeW5jaHJvbml6ZWQgPSB0aGlzLnVuc3luY2hyb25pemVkID0gbnVsbDtcbiAgICBjb25zb2xlLmluZm8odGhpcy5sYWJlbCwgJ2NvbXBsZXRlZCBzeW5jaHJvbml6YXRpb24nLCBuQ2hlY2tlZCwgJ2l0ZW1zIGluJywgKChEYXRlLm5vdygpIC0gdGhpcy5zeW5jaHJvbml6YXRpb25TdGFydFRpbWUpLzFlMykudG9GaXhlZCgxKSwgJ3NlY29uZHMnKTtcbiAgICB0aGlzLmNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBzeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykgeyAvLyBSZXR1cm4gc29tZXRoaW5nIHRvIGF3YWl0IHRoYXQgcmVzb2x2ZXMgd2hlbiB0YWcgaXMgc3luY2hyb25pemVkLlxuICAgIC8vIFdoZW5ldmVyIGEgY29sbGVjdGlvbiBuZWVkcyB0byByZXRyaWV2ZSAoZ2V0VmVyaWZpZWQpIGEgdGFnIG9yIGZpbmQgdGFncyBtYXRjaGluZyBwcm9wZXJ0aWVzLCBpdCBlbnN1cmVzXG4gICAgLy8gdGhlIGxhdGVzdCBkYXRhIGJ5IGNhbGxpbmcgdGhpcyBhbmQgYXdhaXRpbmcgdGhlIGRhdGEuXG4gICAgaWYgKCF0aGlzLnVuc3luY2hyb25pemVkKSByZXR1cm4gdHJ1ZTsgLy8gV2UgYXJlIGZ1bGx5IHN5bmNocm9uaXplZCBhbGwgdGFncy4gSWYgdGhlcmUgaXMgbmV3IGRhdGEsIGl0IHdpbGwgYmUgc3BvbnRhbmVvdXNseSBwdXNoZWQgdG8gdXMuXG4gICAgaWYgKHRoaXMuY2hlY2tlZFRhZ3MuaGFzKHRhZykpIHJldHVybiB0cnVlOyAvLyBUaGlzIHBhcnRpY3VsYXIgdGFnIGhhcyBiZWVuIGNoZWNrZWQuXG4gICAgICAvLyAoSWYgY2hlY2tlZFRhZ3Mgd2FzIG9ubHkgdGhvc2UgZXhjaGFuZ2VkIG9yIHdyaXR0ZW4sIHdlIHdvdWxkIGhhdmUgZXh0cmEgZmxpZ2h0cyBjaGVja2luZy4pXG4gICAgLy8gSWYgYSByZXF1ZXN0IGlzIGluIGZsaWdodCwgcmV0dXJuIHRoYXQgcHJvbWlzZS4gT3RoZXJ3aXNlIGNyZWF0ZSBvbmUuXG4gICAgcmV0dXJuIHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZykgfHwgdGhpcy5lbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCAnJywgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG5cbiAgYXN5bmMgaGFzaCh0YWcsIGhhc2gpIHsgLy8gUmVjZWl2ZSBhIFt0YWcsIGhhc2hdIHRoYXQgdGhlIHBlZXIga25vd3MgYWJvdXQuIChQZWVyIHN0cmVhbXMgemVybyBvciBtb3JlIG9mIHRoZXNlIHRvIHVzLilcbiAgICAvLyBVbmxlc3MgYWxyZWFkeSBpbiBmbGlnaHQsIHdlIHdpbGwgZW5zdXJlU3luY2hyb25pemVkVGFnIHRvIHN5bmNocm9uaXplIGl0LlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICBjb25zdCB7b3VyVGFncywgdW5zeW5jaHJvbml6ZWR9ID0gdGhpcztcbiAgICB0aGlzLmxvZygncmVjZWl2ZWQgXCJoYXNoXCInLCB7dGFnLCBoYXNoLCBvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0pO1xuICAgIGlmICh1bnN5bmNocm9uaXplZC5oYXModGFnKSkgcmV0dXJuIG51bGw7IC8vIEFscmVhZHkgaGFzIGFuIGludmVzdGlnYXRpb24gaW4gcHJvZ3Jlc3MgKGUuZywgZHVlIHRvIGxvY2FsIGFwcCBzeW5jaHJvbml6YXRpb25Qcm9taXNlKS5cbiAgICBpZiAoIW91clRhZ3MuaGFzKHRhZykpIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gpOyAvLyBXZSBkb24ndCBoYXZlIHRoZSByZWNvcmQgYXQgYWxsLlxuICAgIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gsIHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgfVxuICBlbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCB0aGVpckhhc2ggPSAnJywgb3VySGFzaFByb21pc2UgPSBudWxsKSB7XG4gICAgLy8gU3luY2hyb25vdXNseSByZWNvcmQgKGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXApIGEgcHJvbWlzZSB0byAoY29uY2VwdHVhbGx5KSByZXF1ZXN0IHRoZSB0YWcgZnJvbSB0aGUgcGVlcixcbiAgICAvLyBwdXQgaXQgaW4gdGhlIGNvbGxlY3Rpb24sIGFuZCBjbGVhbnVwIHRoZSBib29ra2VlcGluZy4gUmV0dXJuIHRoYXQgcHJvbWlzZS5cbiAgICAvLyBIb3dldmVyLCBpZiB3ZSBhcmUgZ2l2ZW4gaGFzaGVzIHRvIGNvbXBhcmUgYW5kIHRoZXkgbWF0Y2gsIHdlIGNhbiBza2lwIHRoZSByZXF1ZXN0L3B1dCBhbmQgcmVtb3ZlIGZyb20gdW5zeWNocm9uaXplZCBvbiBuZXh0IHRpY2suXG4gICAgLy8gKFRoaXMgbXVzdCByZXR1cm4gYXRvbWljYWxseSBiZWNhdXNlIGNhbGxlciBoYXMgY2hlY2tlZCB2YXJpb3VzIGJvb2trZWVwaW5nIGF0IHRoYXQgbW9tZW50LiBDaGVja2luZyBtYXkgcmVxdWlyZSB0aGF0IHdlIGF3YWl0IG91ckhhc2hQcm9taXNlLilcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHsgLy8gTmV4dCB0aWNrLiBTZWUgcmVxdWVzdCgpLlxuXHRpZiAoIXRoZWlySGFzaCB8fCAhb3VySGFzaFByb21pc2UgfHwgKHRoZWlySGFzaCAhPT0gYXdhaXQgb3VySGFzaFByb21pc2UpKSB7XG5cdCAgY29uc3QgdGhlaXJEYXRhID0gYXdhaXQgdGhpcy5yZXF1ZXN0KHRhZyk7XG5cdCAgLy8gTWlnaHQgaGF2ZSBiZWVuIHRyaWdnZXJlZCBieSBvdXIgYXBwIHJlcXVlc3RpbmcgdGhpcyB0YWcgYmVmb3JlIHdlIHdlcmUgc3luYydkLiBTbyB0aGV5IG1pZ2h0IG5vdCBoYXZlIHRoZSBkYXRhLlxuXHQgIGlmICghdGhlaXJIYXNoIHx8IHRoZWlyRGF0YT8ubGVuZ3RoKSB7XG5cdCAgICBpZiAoYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnB1dCh0YWcsIHRoZWlyRGF0YSwgdGhpcykpIHtcblx0ICAgICAgdGhpcy5sb2coJ3JlY2VpdmVkL3B1dCcsIHRhZywgJ3RoZWlyL291ciBoYXNoOicsIHRoZWlySGFzaCB8fCAnbWlzc2luZ1RoZWlycycsIChhd2FpdCBvdXJIYXNoUHJvbWlzZSkgfHwgJ21pc3NpbmdPdXJzJywgdGhlaXJEYXRhPy5sZW5ndGgpO1xuXHQgICAgfSBlbHNlIHtcblx0ICAgICAgdGhpcy5sb2coJ3VuYWJsZSB0byBwdXQnLCB0YWcpO1xuXHQgICAgfVxuXHQgIH1cblx0fVxuXHR0aGlzLmNoZWNrZWRUYWdzLmFkZCh0YWcpOyAgICAgICAvLyBFdmVyeXRoaW5nIHdlJ3ZlIGV4YW1pbmVkLCByZWdhcmRsZXNzIG9mIHdoZXRoZXIgd2UgYXNrZWQgZm9yIG9yIHNhdmVkIGRhdGEgZnJvbSBwZWVyLiAoU2VlIHN5bmNocm9uaXphdGlvblByb21pc2UpXG5cdHRoaXMudW5zeW5jaHJvbml6ZWQuZGVsZXRlKHRhZyk7IC8vIFVuY29uZGl0aW9uYWxseSwgYmVjYXVzZSB3ZSBzZXQgaXQgdW5jb25kaXRpb25hbGx5LlxuXHR0aGlzLmNsZWFuVXBJZkZpbmlzaGVkKCk7XG5cdHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMudW5zeW5jaHJvbml6ZWQuc2V0KHRhZywgcHJvbWlzZSk7IC8vIFVuY29uZGl0aW9uYWxseSwgaW4gY2FzZSB3ZSBuZWVkIHRvIGtub3cgd2UncmUgbG9va2luZyBkdXJpbmcgdGhlIHRpbWUgd2UncmUgbG9va2luZy5cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXF1ZXN0KHRhZykgeyAvLyBNYWtlIGEgcmVxdWVzdCBmb3IgdGFnIGZyb20gdGhlIHBlZXIsIGFuZCBhbnN3ZXIgYSBwcm9taXNlIHRoZSByZXNvbHZlcyB3aXRoIHRoZSBkYXRhLlxuICAgIC8qY29uc3QgeyBob3N0UmVxdWVzdEJhc2UgfSA9IHRoaXM7XG4gICAgaWYgKGhvc3RSZXF1ZXN0QmFzZSkge1xuICAgICAgLy8gRS5nLiwgYSBsb2NhbGhvc3Qgcm91dGVyIG1pZ2h0IHN1cHBvcnQgYSBnZXQgb2YgaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyL190L3VML0JBY1dfTE5BSmEvY0pXbXVtYmxlXG4gICAgICAvLyBTbyBob3N0UmVxdWVzdEJhc2Ugc2hvdWxkIGJlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyXCIsXG4gICAgICAvLyBhbmQgc2VydmljZU5hbWUgc2hvdWxkIGJlIHNvbWV0aGluZyBsaWtlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9zeW5jXCJcbiAgICAgIHJldHVybiBmZXRjaCh0YWdQYXRoKGhvc3RSZXF1ZXN0QmFzZSwgdGFnKSkudGhlbihyZXNwb25zZSA9PiByZXNwb25zZS50ZXh0KCkpO1xuICAgIH0qL1xuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UodGhpcy5zZW5kKCdnZXQnLCB0YWcpKTtcbiAgICAvLyBTdWJ0bGU6IFdoZW4gdGhlICdwdXQnIGNvbWVzIGJhY2ssIHdlIHdpbGwgbmVlZCB0byByZXNvbHZlIHRoaXMgcHJvbWlzZS4gQnV0IGhvdyB3aWxsICdwdXQnIGZpbmQgdGhlIHByb21pc2UgdG8gcmVzb2x2ZSBpdD9cbiAgICAvLyBBcyBpdCB0dXJucyBvdXQsIHRvIGdldCBoZXJlLCB3ZSBoYXZlIG5lY2Vzc2FyaWxseSBzZXQgdGFnIGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXAuIFxuICAgIGNvbnN0IG5vdGVkID0gdGhpcy51bnN5bmNocm9uaXplZC5nZXQodGFnKTsgLy8gQSBwcm9taXNlIHRoYXQgZG9lcyBub3QgaGF2ZSBhbiBleHBvc2VkIC5yZXNvbHZlLCBhbmQgd2hpY2ggZG9lcyBub3QgZXhwZWN0IGFueSB2YWx1ZS5cbiAgICBub3RlZC5yZXNvbHZlID0gcHJvbWlzZS5yZXNvbHZlOyAvLyBUYWNrIG9uIGEgcmVzb2x2ZSBmb3IgT1VSIHByb21pc2Ugb250byB0aGUgbm90ZWQgb2JqZWN0ICh3aGljaCBjb25mdXNpbmdseSwgaGFwcGVucyB0byBiZSBhIHByb21pc2UpLlxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gUmVzcG9uZCB0byBhIHBlZXIncyBnZXQoKSByZXF1ZXN0IGJ5IHNlbmRpbmcgYSBwdXQgcmVwb25zZSB3aXRoIHRoZSBkYXRhLlxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gICAgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIGRhdGEpO1xuICB9XG4gIHB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSkgeyAvLyBUZWxsIHRoZSBvdGhlciBzaWRlIGFib3V0IGEgc2lnbmVkIHdyaXRlLlxuICAgIHRoaXMuc2VuZChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKTtcbiAgfVxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUpIHsgLy8gUmVjZWl2ZSBhIHB1dCBtZXNzYWdlIGZyb20gdGhlIHBlZXIuXG4gICAgLy8gSWYgaXQgaXMgYSByZXNwb25zZSB0byBhIGdldCgpIHJlcXVlc3QsIHJlc29sdmUgdGhlIGNvcnJlc3BvbmRpbmcgcHJvbWlzZS5cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy51bnN5bmNocm9uaXplZD8uZ2V0KHRhZyk7XG4gICAgLy8gUmVnYXJkbGVzcyBvZiB3aHkgdGhlIG90aGVyIHNpZGUgaXMgc2VuZGluZywgaWYgd2UgaGF2ZSBhbiBvdXRzdGFuZGluZyByZXF1ZXN0LCBjb21wbGV0ZSBpdC5cbiAgICBpZiAocHJvbWlzZSkgcHJvbWlzZS5yZXNvbHZlKHNpZ25hdHVyZSk7XG4gICAgZWxzZSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24ucHV0KHRhZywgc2lnbmF0dXJlLCB0aGlzKTsgLy8gT3RoZXJ3aXNlLCBqdXN0IHRyeSB0byB3cml0ZSBpdCBsb2NhbGx5LlxuICB9XG4gIGRlbGV0ZSh0YWcsIHNpZ25hdHVyZSkgeyAvLyBSZWNlaXZlIGEgZGVsZXRlIG1lc3NhZ2UgZnJvbSB0aGUgcGVlci5cbiAgICB0aGlzLmNvbGxlY3Rpb24uZGVsZXRlKHRhZywgc2lnbmF0dXJlLCB0aGlzKTtcbiAgfVxufVxuZXhwb3J0IGRlZmF1bHQgU3luY2hyb25pemVyO1xuIiwiY2xhc3MgQ2FjaGUgZXh0ZW5kcyBNYXB7Y29uc3RydWN0b3IoZSx0PTApe3N1cGVyKCksdGhpcy5tYXhTaXplPWUsdGhpcy5kZWZhdWx0VGltZVRvTGl2ZT10LHRoaXMuX25leHRXcml0ZUluZGV4PTAsdGhpcy5fa2V5TGlzdD1BcnJheShlKSx0aGlzLl90aW1lcnM9bmV3IE1hcH1zZXQoZSx0LHM9dGhpcy5kZWZhdWx0VGltZVRvTGl2ZSl7bGV0IGk9dGhpcy5fbmV4dFdyaXRlSW5kZXg7dGhpcy5kZWxldGUodGhpcy5fa2V5TGlzdFtpXSksdGhpcy5fa2V5TGlzdFtpXT1lLHRoaXMuX25leHRXcml0ZUluZGV4PShpKzEpJXRoaXMubWF4U2l6ZSx0aGlzLl90aW1lcnMuaGFzKGUpJiZjbGVhclRpbWVvdXQodGhpcy5fdGltZXJzLmdldChlKSksc3VwZXIuc2V0KGUsdCkscyYmdGhpcy5fdGltZXJzLnNldChlLHNldFRpbWVvdXQoKCgpPT50aGlzLmRlbGV0ZShlKSkscykpfWRlbGV0ZShlKXtyZXR1cm4gdGhpcy5fdGltZXJzLmhhcyhlKSYmY2xlYXJUaW1lb3V0KHRoaXMuX3RpbWVycy5nZXQoZSkpLHRoaXMuX3RpbWVycy5kZWxldGUoZSksc3VwZXIuZGVsZXRlKGUpfWNsZWFyKGU9dGhpcy5tYXhTaXplKXt0aGlzLm1heFNpemU9ZSx0aGlzLl9rZXlMaXN0PUFycmF5KGUpLHRoaXMuX25leHRXcml0ZUluZGV4PTAsc3VwZXIuY2xlYXIoKTtmb3IoY29uc3QgZSBvZiB0aGlzLl90aW1lcnMudmFsdWVzKCkpY2xlYXJUaW1lb3V0KGUpO3RoaXMuX3RpbWVycy5jbGVhcigpfX1jbGFzcyBTdG9yYWdlQmFzZXtjb25zdHJ1Y3Rvcih7bmFtZTplLGJhc2VOYW1lOnQ9XCJTdG9yYWdlXCIsbWF4U2VyaWFsaXplclNpemU6cz0xZTMsZGVidWc6aT0hMX0pe2NvbnN0IGE9YCR7dH0vJHtlfWAscj1uZXcgQ2FjaGUocyk7T2JqZWN0LmFzc2lnbih0aGlzLHtuYW1lOmUsYmFzZU5hbWU6dCxmdWxsTmFtZTphLGRlYnVnOmksc2VyaWFsaXplcjpyfSl9YXN5bmMgbGlzdCgpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShcIlwiLCgoZSx0KT0+dGhpcy5saXN0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGdldChlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZ2V0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGRlbGV0ZShlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZGVsZXRlSW50ZXJuYWwodCxlKSkpfWFzeW5jIHB1dChlLHQpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSxzKT0+dGhpcy5wdXRJbnRlcm5hbChzLHQsZSkpKX1sb2coLi4uZSl7dGhpcy5kZWJ1ZyYmY29uc29sZS5sb2codGhpcy5uYW1lLC4uLmUpfWFzeW5jIHNlcmlhbGl6ZShlLHQpe2NvbnN0e3NlcmlhbGl6ZXI6cyxyZWFkeTppfT10aGlzO2xldCBhPXMuZ2V0KGUpfHxpO3JldHVybiBhPWEudGhlbigoYXN5bmMoKT0+dChhd2FpdCB0aGlzLnJlYWR5LHRoaXMucGF0aChlKSkpKSxzLnNldChlLGEpLGF3YWl0IGF9fWNvbnN0e1Jlc3BvbnNlOmUsVVJMOnR9PWdsb2JhbFRoaXM7Y2xhc3MgU3RvcmFnZUNhY2hlIGV4dGVuZHMgU3RvcmFnZUJhc2V7Y29uc3RydWN0b3IoLi4uZSl7c3VwZXIoLi4uZSksdGhpcy5zdHJpcHBlcj1uZXcgUmVnRXhwKGBeLyR7dGhpcy5mdWxsTmFtZX0vYCksdGhpcy5yZWFkeT1jYWNoZXMub3Blbih0aGlzLmZ1bGxOYW1lKX1hc3luYyBsaXN0SW50ZXJuYWwoZSx0KXtyZXR1cm4oYXdhaXQgdC5rZXlzKCl8fFtdKS5tYXAoKGU9PnRoaXMudGFnKGUudXJsKSkpfWFzeW5jIGdldEludGVybmFsKGUsdCl7Y29uc3Qgcz1hd2FpdCB0Lm1hdGNoKGUpO3JldHVybiBzPy5qc29uKCl9ZGVsZXRlSW50ZXJuYWwoZSx0KXtyZXR1cm4gdC5kZWxldGUoZSl9cHV0SW50ZXJuYWwodCxzLGkpe3JldHVybiBpLnB1dCh0LGUuanNvbihzKSl9cGF0aChlKXtyZXR1cm5gLyR7dGhpcy5mdWxsTmFtZX0vJHtlfWB9dGFnKGUpe3JldHVybiBuZXcgdChlKS5wYXRobmFtZS5yZXBsYWNlKHRoaXMuc3RyaXBwZXIsXCJcIil9ZGVzdHJveSgpe3JldHVybiBjYWNoZXMuZGVsZXRlKHRoaXMuZnVsbE5hbWUpfX1leHBvcnR7U3RvcmFnZUNhY2hlIGFzIFN0b3JhZ2VMb2NhbCxTdG9yYWdlQ2FjaGUgYXMgZGVmYXVsdH07XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgeyBTdG9yYWdlTG9jYWwgfSBmcm9tICdAa2kxcjB5L3N0b3JhZ2UnO1xuaW1wb3J0IFN5bmNocm9uaXplciBmcm9tICcuL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5jb25zdCB7IEN1c3RvbUV2ZW50LCBFdmVudFRhcmdldCwgVGV4dERlY29kZXIgfSA9IGdsb2JhbFRoaXM7XG5cbmV4cG9ydCBjbGFzcyBDb2xsZWN0aW9uIGV4dGVuZHMgRXZlbnRUYXJnZXQge1xuXG4gIGNvbnN0cnVjdG9yKHtuYW1lLCBsYWJlbCA9IG5hbWUsIHNlcnZpY2VzID0gW10sIHByZXNlcnZlRGVsZXRpb25zID0gISFzZXJ2aWNlcy5sZW5ndGgsXG5cdCAgICAgICBwZXJzaXN0ZW5jZUNsYXNzID0gU3RvcmFnZUxvY2FsLCBkYlZlcnNpb24gPSBzdG9yYWdlVmVyc2lvbiwgcGVyc2lzdGVuY2VCYXNlID0gYCR7c3RvcmFnZU5hbWV9XyR7ZGJWZXJzaW9ufWAsXG5cdCAgICAgICBkZWJ1ZyA9IGZhbHNlLCBtdWx0aXBsZXgsIC8vIENhdXNlcyBzeW5jaHJvbml6YXRpb24gdG8gcmV1c2UgY29ubmVjdGlvbnMgZm9yIGRpZmZlcmVudCBDb2xsZWN0aW9ucyBvbiB0aGUgc2FtZSBzZXJ2aWNlLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHNlcnZpY2VMYWJlbH0pIHtcbiAgICBzdXBlcigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge25hbWUsIGxhYmVsLCBwcmVzZXJ2ZURlbGV0aW9ucywgcGVyc2lzdGVuY2VDbGFzcywgZGJWZXJzaW9uLCBtdWx0aXBsZXgsIGRlYnVnLCBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsLFxuXHRcdFx0IGZ1bGxOYW1lOiBgJHt0aGlzLmNvbnN0cnVjdG9yLm5hbWV9LyR7bmFtZX1gLCBmdWxsTGFiZWw6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtsYWJlbH1gfSk7XG4gICAgdGhpcy5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgcGVyc2lzdGVuY2VPcHRpb25zID0ge25hbWU6IHRoaXMuZnVsbExhYmVsLCBiYXNlTmFtZTogcGVyc2lzdGVuY2VCYXNlLCBkZWJ1ZzogZGVidWd9O1xuICAgIGlmIChwZXJzaXN0ZW5jZUNsYXNzLnRoZW4pIHRoaXMucGVyc2lzdGVuY2VTdG9yZSA9IHBlcnNpc3RlbmNlQ2xhc3MudGhlbihraW5kID0+IG5ldyBraW5kKHBlcnNpc3RlbmNlT3B0aW9ucykpO1xuICAgIGVsc2UgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gbmV3IHBlcnNpc3RlbmNlQ2xhc3MocGVyc2lzdGVuY2VPcHRpb25zKTtcbiAgfVxuXG4gIGFzeW5jIGNsb3NlKCkge1xuICAgIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmNsb3NlKCk7XG4gIH1cbiAgYXN5bmMgZGVzdHJveSgpIHtcbiAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3QoKTtcbiAgICBjb25zdCBzdG9yZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBkZWxldGUgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIGlmIChzdG9yZSkgYXdhaXQgc3RvcmUuZGVzdHJveSgpO1xuICB9XG5cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7IC8vIENhbiBiZSBvdmVycmlkZGVuIGJ5IHRoZSBjbGllbnRcbiAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgfVxuICAvLyBDcmVkZW50aWFscy5zaWduLy52ZXJpZnkgY2FuIHByb2R1Y2UvYWNjZXB0IEpTT04gT0JKRUNUUyBmb3IgdGhlIG5hbWVkIFwiSlNPTiBTZXJpYWxpemF0aW9uXCIgZm9ybS5cbiAgLy8gQXMgaXQgaGFwcGVucywgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgY2FuIGRpc3Rpbmd1aXNoIGJldHdlZW4gYSBjb21wYWN0IHNlcmlhbGl6YXRpb24gKGJhc2U2NCB0ZXh0KVxuICAvLyB2cyBhbiBvYmplY3QsIGJ1dCBpdCBkb2VzIG5vdCByZWNvZ25pemUgYSBTRVJJQUxJWkVEIG9iamVjdC4gSGVyZSB3ZSBib3R0bGVuZWNrIHRob3NlIG9wZXJhdGlvbnNcbiAgLy8gc3VjaCB0aGF0IHRoZSB0aGluZyB0aGF0IGlzIGFjdHVhbGx5IHBlcnNpc3RlZCBhbmQgc3luY2hyb25pemVkIGlzIGFsd2F5cyBhIHN0cmluZyAtLSBlaXRoZXIgYmFzZTY0XG4gIC8vIGNvbXBhY3Qgb3IgSlNPTiBiZWdpbm5pbmcgd2l0aCBhIFwie1wiICh3aGljaCBhcmUgZGlzdGluZ3Vpc2hhYmxlIGJlY2F1c2UgXCJ7XCIgaXMgbm90IGEgYmFzZTY0IGNoYXJhY3RlcikuXG4gIHN0YXRpYyBlbnN1cmVTdHJpbmcoc2lnbmF0dXJlKSB7IC8vIFJldHVybiBhIHNpZ25hdHVyZSB0aGF0IGlzIGRlZmluYXRlbHkgYSBzdHJpbmcuXG4gICAgaWYgKHR5cGVvZihzaWduYXR1cmUpICE9PSAnc3RyaW5nJykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBSZXR1cm4gYSBjb21wYWN0IG9yIFwiSlNPTlwiIChvYmplY3QpIGZvcm0gb2Ygc2lnbmF0dXJlIChpbmZsYXRpbmcgYSBzZXJpYWxpemF0aW9uIG9mIHRoZSBsYXR0ZXIgaWYgbmVlZGVkKSwgYnV0IG5vdCBhIEpTT04gc3RyaW5nLlxuICBzdGF0aWMgbWF5YmVJbmZsYXRlKHNpZ25hdHVyZSkge1xuICAgIGlmIChzaWduYXR1cmU/LnN0YXJ0c1dpdGg/LihcIntcIikpIHJldHVybiBKU09OLnBhcnNlKHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBUaGUgdHlwZSBvZiBKV0UgdGhhdCBnZXRzIHNpZ25lZCAobm90IHRoZSBjdHkgb2YgdGhlIEpXRSkuIFdlIGF1dG9tYXRpY2FsbHkgdHJ5IHRvIGRlY3J5cHQgYSBKV1MgcGF5bG9hZCBvZiB0aGlzIHR5cGUuXG4gIHN0YXRpYyBlbmNyeXB0ZWRNaW1lVHlwZSA9ICd0ZXh0L2VuY3J5cHRlZCc7XG4gIHN0YXRpYyBhc3luYyBlbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpIHsgLy8gUHJvbWlzZSB2ZXJmaWVkIGFmdGVyIGZpcnN0IGF1Z21lbnRpbmcgd2l0aCBkZWNyeXB0ZWQgZGF0YSBhcyBuZWVkZWQuXG4gICAgaWYgKHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5jdHkgIT09IHRoaXMuZW5jcnlwdGVkTWltZVR5cGUpIHJldHVybiB2ZXJpZmllZDtcbiAgICBpZiAodmVyaWZpZWQuZGVjcnlwdGVkKSByZXR1cm4gdmVyaWZpZWQ7IC8vIEFscmVhZHkgZGVjcnlwdGVkLlxuICAgIGNvbnN0IGRlY3J5cHRlZCA9IGF3YWl0IENyZWRlbnRpYWxzLmRlY3J5cHQodmVyaWZpZWQudGV4dCk7XG4gICAgdmVyaWZpZWQuanNvbiA9IGRlY3J5cHRlZC5qc29uO1xuICAgIHZlcmlmaWVkLnRleHQgPSBkZWNyeXB0ZWQudGV4dDtcbiAgICB2ZXJpZmllZC5wYXlsb2FkID0gZGVjcnlwdGVkLnBheWxvYWQ7XG4gICAgdmVyaWZpZWQuZGVjcnlwdGVkID0gZGVjcnlwdGVkO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBzdGF0aWMgYXN5bmMgc2lnbihkYXRhLCBvcHRpb25zKSB7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgQ3JlZGVudGlhbHMuc2lnbihkYXRhLCBvcHRpb25zKTtcbiAgICByZXR1cm4gdGhpcy5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgc2lnbmF0dXJlID0gdGhpcy5tYXliZUluZmxhdGUoc2lnbmF0dXJlKTtcbiAgICAvLyBXZSBkb24ndCBkbyBcImRlZXBcIiB2ZXJpZmljYXRpb24gaGVyZSAtIGUuZy4sIGNoZWNraW5nIHRoYXQgdGhlIGFjdCBpcyBhIG1lbWJlciBvZiBpc3MsIGFuZCB0aGUgaWF0IGlzIGFmdGVyIHRoZSBleGlzdGluZyBpYXQuXG4gICAgLy8gSW5zdGVhZCwgd2UgZG8gb3VyIG93biBkZWVwIGNoZWNrcyBpbiB2YWxpZGF0ZUZvcldyaXRpbmcuXG4gICAgLy8gVGhlIG1lbWJlci9ub3RCZWZvcmUgc2hvdWxkIGNoZWNrIG91dCBhbnl3YXkgLS0gaS5lLiwgd2UgY291bGQgbGVhdmUgaXQgaW4sIGV4Y2VwdCBpbiBzeW5jaHJvbml6aW5nXG4gICAgLy8gQ3JlZGVudGlhbC5jb2xsZWN0aW9ucy4gVGhlcmUgaXMgbm8gbWVjaGFuaXNtIChjdXJyZW50bHkpIGZvciB0aGVcbiAgICAvLyBzeW5jaHJvbml6YXRpb24gdG8gaGFwcGVuIGluIGFuIG9yZGVyIHRoYXQgd2lsbCByZXN1bHQgaW4gdGhlIGRlcGVuZGVuY2llcyBjb21pbmcgb3ZlciBiZWZvcmUgdGhlIGl0ZW1zIHRoYXQgY29uc3VtZSB0aGVtLlxuICAgIGNvbnN0IHZlcmlmaWVkID0gIGF3YWl0IENyZWRlbnRpYWxzLnZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMpO1xuICAgIGlmICh2ZXJpZmllZCkgdmVyaWZpZWQuc2lnbmF0dXJlID0gc2lnbmF0dXJlO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZpZWRTaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zLCB0YWcgPSBudWxsKSB7IC8vIFNpZ24sIGJ1dCByZXR1cm4gYSB2YWxpZGF0aW9uIChhcyB0aG91Z2ggYnkgaW1tZWRpYXRlbHkgdmFsaWRhdGluZykuXG4gICAgLy8gVE9ETzogYXNzZW1ibGUgdGhpcyBtb3JlIGNoZWFwbHk/XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5zaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zKTtcbiAgICByZXR1cm4gdGhpcy52YWxpZGF0aW9uRm9ybWF0KHNpZ25hdHVyZSwgdGFnKTtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmFsaWRhdGlvbkZvcm1hdChzaWduYXR1cmUsIHRhZyA9IG51bGwpIHtcbiAgICAvL2NvbnNvbGUubG9nKHt0eXBlOiB0eXBlb2Yoc2lnbmF0dXJlKSwgc2lnbmF0dXJlLCB0YWd9KTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMudmVyaWZ5KHNpZ25hdHVyZSk7XG4gICAgLy9jb25zb2xlLmxvZyh7dmVyaWZpZWR9KTtcbiAgICBjb25zdCBzdWIgPSB2ZXJpZmllZC5zdWJqZWN0VGFnID0gdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgICB2ZXJpZmllZC50YWcgPSB0YWcgfHwgc3ViO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuXG4gIGFzeW5jIHVuZGVsZXRlZFRhZ3MoKSB7XG4gICAgLy8gT3VyIG93biBzZXBhcmF0ZSwgb24tZGVtYW5kIGFjY291bnRpbmcgb2YgcGVyc2lzdGVuY2VTdG9yZSBsaXN0KCk6XG4gICAgLy8gICAtIHBlcnNpc3RlbmNlU3RvcmUgbGlzdCgpIGNvdWxkIHBvdGVudGlhbGx5IGJlIGV4cGVuc2l2ZVxuICAgIC8vICAgLSBJdCB3aWxsIGNvbnRhaW4gc29mdC1kZWxldGVkIGl0ZW0gdG9tYnN0b25lcyAoc2lnbmVkIGVtcHR5IHBheWxvYWRzKS5cbiAgICAvLyBJdCBzdGFydHMgd2l0aCBhIGxpc3QoKSB0byBnZXQgYW55dGhpbmcgcGVyc2lzdGVkIGluIGEgcHJldmlvdXMgc2Vzc2lvbiwgYW5kIGFkZHMvcmVtb3ZlcyBhcyB3ZSBzdG9yZS9yZW1vdmUuXG4gICAgY29uc3QgYWxsVGFncyA9IGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmxpc3QoKTtcbiAgICBjb25zdCB0YWdzID0gbmV3IFNldCgpO1xuICAgIGF3YWl0IFByb21pc2UuYWxsKGFsbFRhZ3MubWFwKGFzeW5jIHRhZyA9PiB7XG4gICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZywgc3luY2hyb25pemU6IGZhbHNlfSk7XG4gICAgICBpZiAodmVyaWZpZWQpIHRhZ3MuYWRkKHRhZyk7XG4gICAgfSkpO1xuICAgIHJldHVybiB0YWdzO1xuICB9XG4gIGdldCB0YWdzKCkgeyAvLyBLZWVwcyB0cmFjayBvZiBvdXIgKHVuZGVsZXRlZCkga2V5cy5cbiAgICByZXR1cm4gdGhpcy5fdGFnc1Byb21pc2UgfHw9IHRoaXMudW5kZWxldGVkVGFncygpO1xuICB9XG4gIGFzeW5jIGFkZFRhZyh0YWcpIHtcbiAgICAoYXdhaXQgdGhpcy50YWdzKS5hZGQodGFnKTtcbiAgfVxuICBhc3luYyBkZWxldGVUYWcodGFnKSB7XG4gICAgKGF3YWl0IHRoaXMudGFncykuZGVsZXRlKHRhZyk7XG4gIH1cblxuICBsb2coLi4ucmVzdCkge1xuICAgIGlmICghdGhpcy5kZWJ1ZykgcmV0dXJuO1xuICAgIGNvbnNvbGUubG9nKHRoaXMuZnVsbExhYmVsLCAuLi5yZXN0KTtcbiAgfVxuICBfY2Fub25pY2FsaXplT3B0aW9ucyhvYmplY3RPclN0cmluZyA9IHt9KSB7XG4gICAgaWYgKHR5cGVvZihvYmplY3RPclN0cmluZykgPT09ICdzdHJpbmcnKSBvYmplY3RPclN0cmluZyA9IHt0YWc6IG9iamVjdE9yU3RyaW5nfTtcbiAgICBjb25zdCB7b3duZXI6dGVhbSA9IENyZWRlbnRpYWxzLm93bmVyLCBhdXRob3I6bWVtYmVyID0gQ3JlZGVudGlhbHMuYXV0aG9yLFxuXHQgICB0YWcsXG5cdCAgIGVuY3J5cHRpb24gPSBDcmVkZW50aWFscy5lbmNyeXB0aW9uLFxuXHQgICB0aW1lID0gRGF0ZS5ub3coKSxcblx0ICAgLi4ucmVzdH0gPSBvYmplY3RPclN0cmluZztcbiAgICAvLyBUT0RPOiBzdXBwb3J0IHNpbXBsaWZpZWQgc3ludGF4LCB0b28sIHBlciBSRUFETUVcbiAgICAvLyBUT0RPOiBzaG91bGQgd2Ugc3BlY2lmeSBzdWJqZWN0OiB0YWcgZm9yIGJvdGggbXV0YWJsZXM/IChnaXZlcyBoYXNoKVxuICAgIGNvbnN0IG9wdGlvbnMgPSAodGVhbSAmJiB0ZWFtICE9PSBtZW1iZXIpID9cblx0ICB7dGVhbSwgbWVtYmVyLCB0YWcsIGVuY3J5cHRpb24sIHRpbWUsIC4uLnJlc3R9IDpcblx0ICB7dGFnczogW21lbWJlcl0sIHRhZywgdGltZSwgZW5jcnlwdGlvbiwgLi4ucmVzdH07IC8vIE5vIGlhdCBpZiB0aW1lIG5vdCBleHBsaWNpdGx5IGdpdmVuLlxuICAgIGlmIChbdHJ1ZSwgJ3RlYW0nLCAnb3duZXInXS5pbmNsdWRlcyhvcHRpb25zLmVuY3J5cHRpb24pKSBvcHRpb25zLmVuY3J5cHRpb24gPSB0ZWFtO1xuICAgIHJldHVybiBvcHRpb25zO1xuICB9XG4gIGZhaWwob3BlcmF0aW9uLCBkYXRhLCBhdXRob3IpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7YXV0aG9yfSBkb2VzIG5vdCBoYXZlIHRoZSBhdXRob3JpdHkgdG8gJHtvcGVyYXRpb259ICR7dGhpcy5mdWxsTmFtZX0gJHtKU09OLnN0cmluZ2lmeShkYXRhKX0uYCk7XG4gIH1cbiAgYXN5bmMgc3RvcmUoZGF0YSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgLy8gZW5jcnlwdCBpZiBuZWVkZWRcbiAgICAvLyBzaWduXG4gICAgLy8gcHV0IDw9PSBBbHNvIHdoZXJlIHdlIGVudGVyIGlmIHB1c2hlZCBmcm9tIGEgY29ubmVjdGlvblxuICAgIC8vICAgIHZhbGlkYXRlRm9yV3JpdGluZ1xuICAgIC8vICAgICAgIGV4aXQgaWYgaW1wcm9wZXJcbiAgICAvLyAgICAgICBlbWl0IHVwZGF0ZSBldmVudFxuICAgIC8vICAgIG1lcmdlU2lnbmF0dXJlc1xuICAgIC8vICAgIHBlcnNpc3QgbG9jYWxseVxuICAgIC8vIHB1c2ggKGxpdmUgdG8gYW55IGNvbm5lY3Rpb25zIGV4Y2VwdCB0aGUgb25lIHdlIHJlY2VpdmVkIGZyb20pXG4gICAgbGV0IHtlbmNyeXB0aW9uLCB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7XG4gICAgaWYgKGVuY3J5cHRpb24pIHtcbiAgICAgIGRhdGEgPSBhd2FpdCBDcmVkZW50aWFscy5lbmNyeXB0KGRhdGEsIGVuY3J5cHRpb24pO1xuICAgICAgc2lnbmluZ09wdGlvbnMuY29udGVudFR5cGUgPSB0aGlzLmNvbnN0cnVjdG9yLmVuY3J5cHRlZE1pbWVUeXBlO1xuICAgIH1cbiAgICAvLyBObyBuZWVkIHRvIGF3YWl0IHN5bmNocm9uaXphdGlvbi5cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHRhZyA9IGF3YWl0IHRoaXMucHV0KHRhZywgc2lnbmF0dXJlKTtcbiAgICBpZiAoIXRhZykgcmV0dXJuIHRoaXMuZmFpbCgnc3RvcmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBwdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUsIGV4Y2x1ZGVTeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFB1c2ggdG8gYWxsIGNvbm5lY3RlZCBzeW5jaHJvbml6ZXJzLCBleGNsdWRpbmcgdGhlIHNwZWNpZmllZCBvbmUuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHRoaXMubWFwU3luY2hyb25pemVycyhzeW5jaHJvbml6ZXIgPT4gKGV4Y2x1ZGVTeW5jaHJvbml6ZXIgIT09IHN5bmNocm9uaXplcikgJiYgc3luY2hyb25pemVyLnB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSkpKTtcbiAgfVxuICBhc3luYyByZW1vdmUob3B0aW9ucyA9IHt9KSB7IC8vIE5vdGU6IFJlYWxseSBqdXN0IHJlcGxhY2luZyB3aXRoIGVtcHR5IGRhdGEgZm9yZXZlci4gT3RoZXJ3aXNlIG1lcmdpbmcgd2l0aCBlYXJsaWVyIGRhdGEgd2lsbCBicmluZyBpdCBiYWNrIVxuICAgIGxldCB7ZW5jcnlwdGlvbiwgdGFnLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpO1xuICAgIGNvbnN0IGRhdGEgPSAnJztcbiAgICAvLyBObyBuZWVkIHRvIGF3YWl0IHN5bmNocm9uaXphdGlvblxuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgdGFnID0gYXdhaXQgdGhpcy5kZWxldGUodGFnLCBzaWduYXR1cmUpO1xuICAgIGlmICghdGFnKSByZXR1cm4gdGhpcy5mYWlsKCdzdG9yZScsIGRhdGEsIHNpZ25pbmdPcHRpb25zLm1lbWJlciB8fCBzaWduaW5nT3B0aW9ucy50YWdzWzBdKTtcbiAgICBhd2FpdCB0aGlzLnB1c2goJ2RlbGV0ZScsIHRhZywgc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIHJldHJpZXZlKHRhZ09yT3B0aW9ucykgeyAvLyBnZXRWZXJpZmllZCBhbmQgbWF5YmUgZGVjcnlwdC4gSGFzIG1vcmUgY29tcGxleCBiZWhhdmlvciBpbiBzdWJjbGFzcyBWZXJzaW9uZWRDb2xsZWN0aW9uLlxuICAgIGNvbnN0IHt0YWcsIGRlY3J5cHQgPSB0cnVlLCAuLi5vcHRpb25zfSA9IHRhZ09yT3B0aW9ucy50YWcgPyB0YWdPck9wdGlvbnMgOiB7dGFnOiB0YWdPck9wdGlvbnN9O1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnLCAuLi5vcHRpb25zfSk7XG4gICAgaWYgKCF2ZXJpZmllZCkgcmV0dXJuICcnO1xuICAgIGlmIChkZWNyeXB0KSByZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBnZXRWZXJpZmllZCh0YWdPck9wdGlvbnMpIHsgLy8gc3luY2hyb25pemUsIGdldCwgYW5kIHZlcmlmeSAoYnV0IHdpdGhvdXQgZGVjcnlwdClcbiAgICBjb25zdCB7dGFnLCBzeW5jaHJvbml6ZSA9IHRydWUsIC4uLnZlcmlmeU9wdGlvbnN9ID0gdGFnT3JPcHRpb25zLnRhZyA/IHRhZ09yT3B0aW9uczoge3RhZzogdGFnT3JPcHRpb25zfTtcbiAgICBpZiAoc3luY2hyb25pemUpIGF3YWl0IHRoaXMuc3luY2hyb25pemUxKHRhZyk7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5nZXQodGFnKTtcbiAgICBpZiAoIXNpZ25hdHVyZSkgcmV0dXJuIHNpZ25hdHVyZTtcbiAgICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlLCB2ZXJpZnlPcHRpb25zKTtcbiAgfVxuICBhc3luYyBsaXN0KHNraXBTeW5jID0gZmFsc2UgKSB7IC8vIExpc3QgYWxsIHRhZ3Mgb2YgdGhpcyBjb2xsZWN0aW9uLlxuICAgIGlmICghc2tpcFN5bmMpIGF3YWl0IHRoaXMuc3luY2hyb25pemVUYWdzKCk7XG4gICAgLy8gV2UgY2Fubm90IGp1c3QgbGlzdCB0aGUga2V5cyBvZiB0aGUgY29sbGVjdGlvbiwgYmVjYXVzZSB0aGF0IGluY2x1ZGVzIGVtcHR5IHBheWxvYWRzIG9mIGl0ZW1zIHRoYXQgaGF2ZSBiZWVuIGRlbGV0ZWQuXG4gICAgcmV0dXJuIEFycmF5LmZyb20oKGF3YWl0IHRoaXMudGFncykua2V5cygpKTtcbiAgfVxuICBhc3luYyBtYXRjaCh0YWcsIHByb3BlcnRpZXMpIHsgLy8gSXMgdGhpcyBzaWduYXR1cmUgd2hhdCB3ZSBhcmUgbG9va2luZyBmb3I/XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLnJldHJpZXZlKHRhZyk7XG4gICAgY29uc3QgZGF0YSA9IHZlcmlmaWVkPy5qc29uO1xuICAgIGlmICghZGF0YSkgcmV0dXJuIGZhbHNlO1xuICAgIGZvciAoY29uc3Qga2V5IGluIHByb3BlcnRpZXMpIHtcbiAgICAgIGlmIChkYXRhW2tleV0gIT09IHByb3BlcnRpZXNba2V5XSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBhc3luYyBmaW5kTG9jYWwocHJvcGVydGllcykgeyAvLyBGaW5kIHRoZSB0YWcgaW4gb3VyIHN0b3JlIHRoYXQgbWF0Y2hlcywgZWxzZSBmYWxzZXlcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBhd2FpdCB0aGlzLmxpc3QoJ25vLXN5bmMnKSkgeyAvLyBEaXJlY3QgbGlzdCwgdy9vIHN5bmMuXG4gICAgICBpZiAoYXdhaXQgdGhpcy5tYXRjaCh0YWcsIHByb3BlcnRpZXMpKSByZXR1cm4gdGFnO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgYXN5bmMgZmluZChwcm9wZXJ0aWVzKSB7IC8vIEFuc3dlciB0aGUgdGFnIHRoYXQgaGFzIHZhbHVlcyBtYXRjaGluZyB0aGUgc3BlY2lmaWVkIHByb3BlcnRpZXMuIE9idmlvdXNseSwgY2FuJ3QgYmUgZW5jcnlwdGVkIGFzIGEgd2hvbGUuXG4gICAgbGV0IGZvdW5kID0gYXdhaXQgdGhpcy5maW5kTG9jYWwocHJvcGVydGllcyk7XG4gICAgaWYgKGZvdW5kKSB7XG4gICAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplMShmb3VuZCk7IC8vIE1ha2Ugc3VyZSB0aGUgZGF0YSBpcyB1cCB0byBkYXRlLiBUaGVuIGNoZWNrIGFnYWluLlxuICAgICAgaWYgKGF3YWl0IHRoaXMubWF0Y2goZm91bmQsIHByb3BlcnRpZXMpKSByZXR1cm4gZm91bmQ7XG4gICAgfVxuICAgIC8vIE5vIG1hdGNoLlxuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemVUYWdzKCk7XG4gICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZURhdGEoKTtcbiAgICBmb3VuZCA9IGF3YWl0IHRoaXMuZmluZExvY2FsKHByb3BlcnRpZXMpO1xuICAgIGlmIChmb3VuZCAmJiBhd2FpdCB0aGlzLm1hdGNoKGZvdW5kLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIGZvdW5kO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJlcXVpcmVUYWcodGFnKSB7XG4gICAgaWYgKHRhZykgcmV0dXJuO1xuICAgIHRocm93IG5ldyBFcnJvcignQSB0YWcgaXMgcmVxdWlyZWQuJyk7XG4gIH1cblxuICAvLyBUaGVzZSB0aHJlZSBpZ25vcmUgc3luY2hyb25pemF0aW9uIHN0YXRlLCB3aGljaCBpZiBuZWVlZCBpcyB0aGUgcmVzcG9uc2liaWxpdHkgb2YgdGhlIGNhbGxlci5cbiAgLy8gRklYTUUgVE9ETzogYWZ0ZXIgaW5pdGlhbCBkZXZlbG9wbWVudCwgdGhlc2UgdGhyZWUgc2hvdWxkIGJlIG1hZGUgaW50ZXJuYWwgc28gdGhhdCBhcHBsaWNhdGlvbiBjb2RlIGRvZXMgbm90IGNhbGwgdGhlbS5cbiAgYXN5bmMgZ2V0KHRhZykgeyAvLyBHZXQgdGhlIGxvY2FsIHJhdyBzaWduYXR1cmUgZGF0YS5cbiAgICB0aGlzLnJlcXVpcmVUYWcodGFnKTtcbiAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkuZ2V0KHRhZyk7XG4gIH1cbiAgLy8gVGhlc2UgdHdvIGNhbiBiZSB0cmlnZ2VyZWQgYnkgY2xpZW50IGNvZGUgb3IgYnkgYW55IHNlcnZpY2UuXG4gIGFzeW5jIHB1dCh0YWcsIHNpZ25hdHVyZSwgc3luY2hyb25pemVyID0gbnVsbCwgbWVyZ2VBdXRob3JPdmVycmlkZSA9IG51bGwpIHsgLy8gUHV0IHRoZSByYXcgc2lnbmF0dXJlIGxvY2FsbHkgYW5kIG9uIHRoZSBzcGVjaWZpZWQgc2VydmljZXMuXG4gICAgLy8gbWVyZ2VTaWduYXR1cmVzKCkgTUFZIGNyZWF0ZSBuZXcgbmV3IHJlc3VsdHMgdG8gc2F2ZSwgdGhhdCBzdGlsbCBoYXZlIHRvIGJlIHNpZ25lZC4gRm9yIHRlc3RpbmcsIHdlIHNvbWV0aW1lc1xuICAgIC8vIHdhbnQgdG8gYmVoYXZlIGFzIGlmIHNvbWUgb3duZXIgY3JlZGVudGlhbCBkb2VzIG5vdCBleGlzdCBvbiB0aGUgbWFjaGluZS4gVGhhdCdzIHdoYXQgbWVyZ2VBdXRob3JPdmVycmlkZSBpcyBmb3IuXG5cbiAgICAvLyBUT0RPOiBkbyB3ZSBuZWVkIHRvIHF1ZXVlIHRoZXNlPyBTdXBwb3NlIHdlIGFyZSB2YWxpZGF0aW5nIG9yIG1lcmdpbmcgd2hpbGUgb3RoZXIgcmVxdWVzdCBhcnJpdmU/XG4gICAgY29uc3QgdmFsaWRhdGlvbiA9IGF3YWl0IHRoaXMudmFsaWRhdGVGb3JXcml0aW5nKHRhZywgc2lnbmF0dXJlLCAnc3RvcmUnLCBzeW5jaHJvbml6ZXIpO1xuICAgIHRoaXMubG9nKCdwdXQnLCB7dGFnOiB2YWxpZGF0aW9uPy50YWcgfHwgdGFnLCBzeW5jaHJvbml6ZXI6IHN5bmNocm9uaXplcj8ubGFiZWwsIGpzb246IHZhbGlkYXRpb24/Lmpzb259KTtcbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgYXdhaXQgdGhpcy5hZGRUYWcodmFsaWRhdGlvbi50YWcpO1xuXG4gICAgLy8gZml4bWUgbmV4dFxuICAgIGNvbnN0IG1lcmdlZCA9IGF3YWl0IHRoaXMubWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlLCBtZXJnZUF1dGhvck92ZXJyaWRlKTtcbiAgICBhd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIG1lcmdlZCk7XG4gICAgLy9jb25zdCBtZXJnZWQyID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52YWxpZGF0aW9uRm9ybWF0KG1lcmdlZCwgdGFnKTtcbiAgICAvL2F3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgbWVyZ2VkKTtcbiAgICAvL2F3YWl0IHRoaXMucGVyc2lzdDIobWVyZ2VkMik7XG4gICAgLy8gY29uc3QgbWVyZ2VkID0gYXdhaXQgdGhpcy5tZXJnZVZhbGlkYXRpb24odmFsaWRhdGlvbiwgbWVyZ2VBdXRob3JPdmVycmlkZSk7XG4gICAgLy8gYXdhaXQgdGhpcy5wZXJzaXN0MihtZXJnZWQpO1xuXG4gICAgcmV0dXJuIHZhbGlkYXRpb24udGFnOyAvLyBEb24ndCByZWx5IG9uIHRoZSByZXR1cm5lZCB2YWx1ZSBvZiBwZXJzaXN0ZW5jZVN0b3JlLnB1dC5cbiAgfVxuICBhc3luYyBkZWxldGUodGFnLCBzaWduYXR1cmUsIHN5bmNocm9uaXplciA9IG51bGwpIHsgLy8gUmVtb3ZlIHRoZSByYXcgc2lnbmF0dXJlIGxvY2FsbHkgYW5kIG9uIHRoZSBzcGVjaWZpZWQgc2VydmljZXMuXG4gICAgY29uc3QgdmFsaWRhdGlvbiA9IGF3YWl0IHRoaXMudmFsaWRhdGVGb3JXcml0aW5nKHRhZywgc2lnbmF0dXJlLCAncmVtb3ZlJywgc3luY2hyb25pemVyLCAncmVxdWlyZVRhZycpO1xuICAgIHRoaXMubG9nKCdkZWxldGUnLCB0YWcsIHN5bmNocm9uaXplcj8ubGFiZWwsICd2YWxpZGF0ZWQgdGFnOicsIHZhbGlkYXRpb24/LnRhZywgJ3ByZXNlcnZlRGVsZXRpb25zOicsIHRoaXMucHJlc2VydmVEZWxldGlvbnMpO1xuICAgIGlmICghdmFsaWRhdGlvbikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBhd2FpdCB0aGlzLmRlbGV0ZVRhZyh0YWcpO1xuICAgIGlmICh0aGlzLnByZXNlcnZlRGVsZXRpb25zKSB7IC8vIFNpZ25hdHVyZSBwYXlsb2FkIGlzIGVtcHR5LlxuICAgICAgLy8gRklYTUUgbmV4dFxuICAgICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIHNpZ25hdHVyZSk7XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QyKHZhbGlkYXRpb24pO1xuICAgIH0gZWxzZSB7IC8vIFJlYWxseSBkZWxldGUuXG4gICAgICAvLyBmaXhtZSBuZXh0XG4gICAgICAvL2F3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgc2lnbmF0dXJlLCAnZGVsZXRlJyk7XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QyKHZhbGlkYXRpb24sICdkZWxldGUnKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbGlkYXRpb24udGFnOyAvLyBEb24ndCByZWx5IG9uIHRoZSByZXR1cm5lZCB2YWx1ZSBvZiBwZXJzaXN0ZW5jZVN0b3JlLmRlbGV0ZS5cbiAgfVxuXG4gIG5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSA9IHVuZGVmaW5lZCwgdmFsaWRhdGVkID0gJycsIHNpZ25hdHVyZSkge1xuICAgIC8vIExhdGVyIG9uLCB3ZSB3aWxsIG5vdCB3YW50IHRvIGdpdmUgb3V0IHNvIG11Y2ggaW5mby4uLlxuICAgIC8vaWYgKHRoaXMuZGVidWcpIHtcbiAgICBjb25zb2xlLndhcm4odGhpcy5mdWxsTGFiZWwsIG9wZXJhdGlvbkxhYmVsLCBtZXNzYWdlLCB0YWcpO1xuICAgIC8vfSBlbHNlIHtcbiAgICAvLyAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBgU2lnbmF0dXJlIGlzIG5vdCB2YWxpZCB0byAke29wZXJhdGlvbkxhYmVsfSAke3RhZyB8fCAnZGF0YSd9LmApO1xuICAgIC8vfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgYXN5bmMgZGlzYWxsb3dXcml0ZSh0YWcsIGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpIHsgLy8gUmV0dXJuIGEgcmVhc29uIHN0cmluZyB3aHkgdGhlIHByb3Bvc2VkIHZlcmlmaWVkIHByb3RlY3RlZEhlYWRlclxuICAgIC8vIHNob3VsZCBub3QgYmUgYWxsb3dlZCB0byBvdmVycndyaXRlIHRoZSAocG9zc2libHkgbnVsbGlzaCkgZXhpc3RpbmcgdmVyaWZpZWQgcHJvdGVjdGVkSGVhZGVyLFxuICAgIC8vIGVsc2UgZmFsc3kgaWYgYWxsb3dlZC5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSByZXR1cm4gbnVsbDtcbiAgICBpZiAocHJvcG9zZWQuaWF0IDwgZXhpc3RpbmcuaWF0KSByZXR1cm4gJ2JhY2tkYXRlZCc7XG4gICAgaWYgKCF0aGlzLm93bmVyTWF0Y2goZXhpc3RpbmcsIHByb3Bvc2VkKSkgcmV0dXJuICdub3Qgb3duZXInO1xuICAgIGlmICghYXdhaXQgdGhpcy5zdWJqZWN0TWF0Y2godmVyaWZpZWQpKSByZXR1cm4gJ3dyb25nIGhhc2gnO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGFzeW5jIHN1YmplY3RNYXRjaCh2ZXJpZmllZCkgeyAvLyBQcm9taXNlcyB0cnVlIElGRiBjbGFpbWVkICdzdWInIG1hdGNoZXMgaGFzaCBvZiB0aGUgY29udGVudHMuXG4gICAgcmV0dXJuIHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWIgPT09IGF3YWl0IENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChhd2FpdCBDcmVkZW50aWFscy5oYXNoQnVmZmVyKHZlcmlmaWVkLnBheWxvYWQpKTtcbiAgfVxuICBvd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkgey8vIERvZXMgcHJvcG9zZWQgb3duZXIgbWF0Y2ggdGhlIGV4aXN0aW5nP1xuICAgIGNvbnN0IGV4aXN0aW5nT3duZXIgPSBleGlzdGluZz8uaXNzIHx8IGV4aXN0aW5nPy5raWQ7XG4gICAgY29uc3QgcHJvcG9zZWRPd25lciA9IHByb3Bvc2VkLmlzcyB8fCBwcm9wb3NlZC5raWQ7XG4gICAgLy8gRXhhY3QgbWF0Y2guIERvIHdlIG5lZWQgdG8gYWxsb3cgZm9yIGFuIG93bmVyIHRvIHRyYW5zZmVyIG93bmVyc2hpcCB0byBhIHN1Yi9zdXBlci9kaXNqb2ludCB0ZWFtP1xuICAgIC8vIEN1cnJlbnRseSwgdGhhdCB3b3VsZCByZXF1aXJlIGEgbmV3IHJlY29yZC4gKEUuZy4sIHR3byBNdXRhYmxlL1ZlcnNpb25lZENvbGxlY3Rpb24gaXRlbXMgdGhhdFxuICAgIC8vIGhhdmUgdGhlIHNhbWUgR1VJRCBwYXlsb2FkIHByb3BlcnR5LCBidXQgZGlmZmVyZW50IHRhZ3MuIEkuZS4sIGEgZGlmZmVyZW50IG93bmVyIG1lYW5zIGEgZGlmZmVyZW50IHRhZy4pXG4gICAgaWYgKCFwcm9wb3NlZE93bmVyIHx8IChleGlzdGluZ093bmVyICYmIChwcm9wb3NlZE93bmVyICE9PSBleGlzdGluZ093bmVyKSkpIHJldHVybiBmYWxzZTtcblxuICAgICAgLy8gV2UgYXJlIG5vdCBjaGVja2luZyB0byBzZWUgaWYgYXV0aG9yIGlzIGN1cnJlbnRseSBhIG1lbWJlciBvZiB0aGUgb3duZXIgdGVhbSBoZXJlLCB3aGljaFxuICAgICAgLy8gaXMgY2FsbGVkIGJ5IHB1dCgpL2RlbGV0ZSgpIGluIHR3byBjaXJjdW1zdGFuY2VzOlxuXG4gICAgICAvLyB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZygpIGlzIGNhbGxlZCBieSBwdXQoKS9kZWxldGUoKSB3aGljaCBoYXBwZW5zIGluIHRoZSBhcHAgKHZpYSBzdG9yZSgpL3JlbW92ZSgpKVxuICAgICAgLy8gYW5kIGR1cmluZyBzeW5jIGZyb20gYW5vdGhlciBzZXJ2aWNlOlxuXG4gICAgICAvLyAxLiBGcm9tIHRoZSBhcHAgKHZhaWEgc3RvcmUoKS9yZW1vdmUoKSwgd2hlcmUgd2UgaGF2ZSBqdXN0IGNyZWF0ZWQgdGhlIHNpZ25hdHVyZS4gU2lnbmluZyBpdHNlbGZcbiAgICAgIC8vIHdpbGwgZmFpbCBpZiB0aGUgKDEtaG91ciBjYWNoZWQpIGtleSBpcyBubyBsb25nZXIgYSBtZW1iZXIgb2YgdGhlIHRlYW0uIFRoZXJlIGlzIG5vIGludGVyZmFjZVxuICAgICAgLy8gZm9yIHRoZSBhcHAgdG8gcHJvdmlkZSBhbiBvbGQgc2lnbmF0dXJlLiAoVE9ETzogYWZ0ZXIgd2UgbWFrZSBnZXQvcHV0L2RlbGV0ZSBpbnRlcm5hbC4pXG5cbiAgICAgIC8vIDIuIER1cmluZyBzeW5jIGZyb20gYW5vdGhlciBzZXJ2aWNlLCB3aGVyZSB3ZSBhcmUgcHVsbGluZyBpbiBvbGQgcmVjb3JkcyBmb3Igd2hpY2ggd2UgZG9uJ3QgaGF2ZVxuICAgICAgLy8gdGVhbSBtZW1iZXJzaGlwIGZyb20gdGhhdCB0aW1lLlxuXG4gICAgICAvLyBJZiB0aGUgYXBwIGNhcmVzIHdoZXRoZXIgdGhlIGF1dGhvciBoYXMgYmVlbiBraWNrZWQgZnJvbSB0aGUgdGVhbSwgdGhlIGFwcCBpdHNlbGYgd2lsbCBoYXZlIHRvIGNoZWNrLlxuICAgICAgLy8gVE9ETzogd2Ugc2hvdWxkIHByb3ZpZGUgYSB0b29sIGZvciB0aGF0LlxuXG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgYW50ZWNlZGVudCh2ZXJpZmllZCkgeyAvLyBXaGF0IHRhZyBzaG91bGQgdGhlIHZlcmlmaWVkIHNpZ25hdHVyZSBiZSBjb21wYXJlZCBhZ2FpbnN0IGZvciB3cml0aW5nP1xuICAgIHJldHVybiB2ZXJpZmllZC50YWc7XG4gIH1cbiAgc3luY2hyb25pemVBbnRlY2VkZW50KHRhZywgYW50ZWNlZGVudCkgeyAvLyBTaG91bGQgdGhlIGFudGVjZWRlbnQgdHJ5IHN5bmNocm9uaXppbmcgYmVmb3JlIGdldHRpbmcgaXQ/XG4gICAgcmV0dXJuIHRhZyAhPT0gYW50ZWNlZGVudDsgLy8gRmFsc2Ugd2hlbiB0aGV5IGFyZSB0aGUgc2FtZSB0YWcsIGFzIHRoYXQgd291bGQgYmUgY2lyY3VsYXIuIFZlcnNpb25zIGRvIHN5bmMuXG4gIH1cbiAgLy8gVE9ETzogaXMgdGhpcyBuZWVkZWQgYW55IG1vcmU/XG4gIGFzeW5jIHZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgb3BlcmF0aW9uTGFiZWwsIHN5bmNocm9uaXplciwgcmVxdWlyZVRhZyA9IGZhbHNlKSB7XG4gICAgLy8gQSBkZWVwIHZlcmlmeSB0aGF0IGNoZWNrcyBhZ2FpbnN0IHRoZSBleGlzdGluZyBpdGVtJ3MgKHJlLSl2ZXJpZmllZCBoZWFkZXJzLlxuICAgIC8vIElmIGl0IHN1Y2NlZWRzLCB0aGlzIGlzIGFsc28gdGhlIGNvbW1vbiBjb2RlIChiZXR3ZWVuIHB1dC9kZWxldGUpIHRoYXQgZW1pdHMgdGhlIHVwZGF0ZSBldmVudC5cbiAgICBjb25zdCB2YWxpZGF0aW9uT3B0aW9ucyA9IHN5bmNocm9uaXplciA/IHttZW1iZXI6IG51bGx9IDoge307IC8vIENvdWxkIGJlIG9sZCBkYXRhIHdyaXR0ZW4gYnkgc29tZW9uZSB3aG8gaXMgbm8gbG9uZ2VyIGEgbWVtYmVyLlxuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlLCB2YWxpZGF0aW9uT3B0aW9ucyk7XG4gICAgaWYgKCF2ZXJpZmllZCkgcmV0dXJuIHRoaXMubm90aWZ5SW52YWxpZCh0YWcsIG9wZXJhdGlvbkxhYmVsLCAnaW52YWxpZCcsIHZlcmlmaWVkLCBzaWduYXR1cmUpO1xuICAgIHZlcmlmaWVkLnN5bmNocm9uaXplciA9IHN5bmNocm9uaXplcjtcbiAgICB0YWcgPSB2ZXJpZmllZC50YWcgPSB2ZXJpZmllZC5zdWJqZWN0VGFnID0gcmVxdWlyZVRhZyA/IHRhZyA6IGF3YWl0IHRoaXMudGFnRm9yV3JpdGluZyh0YWcsIHZlcmlmaWVkKTtcbiAgICBjb25zdCBhbnRlY2VkZW50ID0gdGhpcy5hbnRlY2VkZW50KHZlcmlmaWVkKTtcbiAgICBjb25zdCBzeW5jaHJvbml6ZSA9IHRoaXMuc3luY2hyb25pemVBbnRlY2VkZW50KHRhZywgYW50ZWNlZGVudCk7XG4gICAgY29uc3QgZXhpc3RpbmdWZXJpZmllZCA9IHZlcmlmaWVkLmV4aXN0aW5nID0gYW50ZWNlZGVudCAmJiBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWc6IGFudGVjZWRlbnQsIHN5bmNocm9uaXplfSk7XG4gICAgY29uc3QgZGlzYWxsb3dlZCA9IGF3YWl0IHRoaXMuZGlzYWxsb3dXcml0ZSh0YWcsIGV4aXN0aW5nVmVyaWZpZWQ/LnByb3RlY3RlZEhlYWRlciwgdmVyaWZpZWQ/LnByb3RlY3RlZEhlYWRlciwgdmVyaWZpZWQpO1xuICAgIGlmIChkaXNhbGxvd2VkKSByZXR1cm4gdGhpcy5ub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsIGRpc2FsbG93ZWQsIHZlcmlmaWVkKTtcbiAgICB0aGlzLmxvZygnZW1pdCcsIHRhZywgdmVyaWZpZWQuanNvbik7XG4gICAgdGhpcy5lbWl0KHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgLy8gZml4bWUgbmV4dCAyXG4gIG1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSkgeyAvLyBSZXR1cm4gYSBzdHJpbmcgdG8gYmUgcGVyc2lzdGVkLiBVc3VhbGx5IGp1c3QgdGhlIHNpZ25hdHVyZS5cbiAgICByZXR1cm4gc2lnbmF0dXJlOyAgLy8gdmFsaWRhdGlvbi5zdHJpbmcgbWlnaHQgYmUgYW4gb2JqZWN0LlxuICB9XG4gIGFzeW5jIHBlcnNpc3QodGFnLCBzaWduYXR1cmVTdHJpbmcsIG9wZXJhdGlvbiA9ICdwdXQnKSB7IC8vIENvbmR1Y3QgdGhlIHNwZWNpZmllZCB0YWcvc2lnbmF0dXJlIG9wZXJhdGlvbiBvbiB0aGUgcGVyc2lzdGVudCBzdG9yZS5cbiAgICByZXR1cm4gKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSlbb3BlcmF0aW9uXSh0YWcsIHNpZ25hdHVyZVN0cmluZyk7XG4gIH1cbiAgbWVyZ2VWYWxpZGF0aW9uKHZhbGlkYXRpb24pIHsgLy8gUmV0dXJuIGEgc3RyaW5nIHRvIGJlIHBlcnNpc3RlZC4gVXN1YWxseSBqdXN0IHRoZSBzaWduYXR1cmUuXG4gICAgcmV0dXJuIHZhbGlkYXRpb247XG4gIH1cbiAgYXN5bmMgcGVyc2lzdDIodmFsaWRhdGlvbiwgb3BlcmF0aW9uID0gJ3B1dCcpIHsgLy8gQ29uZHVjdCB0aGUgc3BlY2lmaWVkIHRhZy9zaWduYXR1cmUgb3BlcmF0aW9uIG9uIHRoZSBwZXJzaXN0ZW50IHN0b3JlLiBSZXR1cm4gdGFnXG4gICAgY29uc3Qge3RhZywgc2lnbmF0dXJlfSA9IHZhbGlkYXRpb247XG4gICAgY29uc3Qgc2lnbmF0dXJlU3RyaW5nID0gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgICBjb25zdCBzdG9yYWdlID0gYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIGF3YWl0IHN0b3JhZ2Vbb3BlcmF0aW9uXSh0YWcsIHNpZ25hdHVyZVN0cmluZyk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBlbWl0KHZlcmlmaWVkKSB7IC8vIERpc3BhdGNoIHRoZSB1cGRhdGUgZXZlbnQuXG4gICAgdGhpcy5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudCgndXBkYXRlJywge2RldGFpbDogdmVyaWZpZWR9KSk7XG4gIH1cbiAgZ2V0IGl0ZW1FbWl0dGVyKCkgeyAvLyBBbnN3ZXJzIHRoZSBDb2xsZWN0aW9uIHRoYXQgZW1pdHMgaW5kaXZpZHVhbCB1cGRhdGVzLiAoU2VlIG92ZXJyaWRlIGluIFZlcnNpb25lZENvbGxlY3Rpb24uKVxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgc3luY2hyb25pemVycyA9IG5ldyBNYXAoKTsgLy8gc2VydmljZUluZm8gbWlnaHQgbm90IGJlIGEgc3RyaW5nLlxuICBtYXBTeW5jaHJvbml6ZXJzKGYpIHsgLy8gT24gU2FmYXJpLCBNYXAudmFsdWVzKCkubWFwIGlzIG5vdCBhIGZ1bmN0aW9uIVxuICAgIGNvbnN0IHJlc3VsdHMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IHN5bmNocm9uaXplciBvZiB0aGlzLnN5bmNocm9uaXplcnMudmFsdWVzKCkpIHtcbiAgICAgIHJlc3VsdHMucHVzaChmKHN5bmNocm9uaXplcikpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfVxuICBnZXQgc2VydmljZXMoKSB7XG4gICAgcmV0dXJuIEFycmF5LmZyb20odGhpcy5zeW5jaHJvbml6ZXJzLmtleXMoKSk7XG4gIH1cbiAgLy8gVE9ETzogcmVuYW1lIHRoaXMgdG8gY29ubmVjdCwgYW5kIGRlZmluZSBzeW5jaHJvbml6ZSB0byBhd2FpdCBjb25uZWN0LCBzeW5jaHJvbml6YXRpb25Db21wbGV0ZSwgZGlzY29ubm5lY3QuXG4gIGFzeW5jIHN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSB7IC8vIFN0YXJ0IHJ1bm5pbmcgdGhlIHNwZWNpZmllZCBzZXJ2aWNlcyAoaW4gYWRkaXRpb24gdG8gd2hhdGV2ZXIgaXMgYWxyZWFkeSBydW5uaW5nKS5cbiAgICBjb25zdCB7c3luY2hyb25pemVyc30gPSB0aGlzO1xuICAgIGZvciAobGV0IHNlcnZpY2Ugb2Ygc2VydmljZXMpIHtcbiAgICAgIGlmIChzeW5jaHJvbml6ZXJzLmhhcyhzZXJ2aWNlKSkgY29udGludWU7XG4gICAgICBhd2FpdCBTeW5jaHJvbml6ZXIuY3JlYXRlKHRoaXMsIHNlcnZpY2UpOyAvLyBSZWFjaGVzIGludG8gb3VyIHN5bmNocm9uaXplcnMgbWFwIGFuZCBzZXRzIGl0c2VsZiBpbW1lZGlhdGVseS5cbiAgICB9XG4gIH1cbiAgZ2V0IHN5bmNocm9uaXplZCgpIHsgLy8gcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gc3luY2hyb25pemF0aW9uIGlzIGNvbXBsZXRlIGluIEJPVEggZGlyZWN0aW9ucy5cbiAgICAvLyBUT0RPPyBUaGlzIGRvZXMgbm90IHJlZmxlY3QgY2hhbmdlcyBhcyBTeW5jaHJvbml6ZXJzIGFyZSBhZGRlZCBvciByZW1vdmVkIHNpbmNlIGNhbGxlZC4gU2hvdWxkIGl0P1xuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMocyA9PiBzLmJvdGhTaWRlc0NvbXBsZXRlZFN5bmNocm9uaXphdGlvbikpO1xuICB9XG4gIGFzeW5jIGRpc2Nvbm5lY3QoLi4uc2VydmljZXMpIHsgLy8gU2h1dCBkb3duIHRoZSBzcGVjaWZpZWQgc2VydmljZXMuXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHNlcnZpY2VzID0gdGhpcy5zZXJ2aWNlcztcbiAgICBjb25zdCB7c3luY2hyb25pemVyc30gPSB0aGlzO1xuICAgIGZvciAobGV0IHNlcnZpY2Ugb2Ygc2VydmljZXMpIHtcbiAgICAgIGNvbnN0IHN5bmNocm9uaXplciA9IHN5bmNocm9uaXplcnMuZ2V0KHNlcnZpY2UpO1xuICAgICAgaWYgKCFzeW5jaHJvbml6ZXIpIHtcblx0Ly9jb25zb2xlLndhcm4oYCR7dGhpcy5mdWxsTGFiZWx9IGRvZXMgbm90IGhhdmUgYSBzZXJ2aWNlIG5hbWVkICcke3NlcnZpY2V9JyB0byBkaXNjb25uZWN0LmApO1xuXHRjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHN5bmNocm9uaXplci5kaXNjb25uZWN0KCk7XG4gICAgfVxuICB9XG4gIGFzeW5jIGVuc3VyZVN5bmNocm9uaXplcihzZXJ2aWNlTmFtZSwgY29ubmVjdGlvbiwgZGF0YUNoYW5uZWwpIHsgLy8gTWFrZSBzdXJlIGRhdGFDaGFubmVsIG1hdGNoZXMgdGhlIHN5bmNocm9uaXplciwgY3JlYXRpbmcgU3luY2hyb25pemVyIG9ubHkgaWYgbWlzc2luZy5cbiAgICBsZXQgc3luY2hyb25pemVyID0gdGhpcy5zeW5jaHJvbml6ZXJzLmdldChzZXJ2aWNlTmFtZSk7XG4gICAgaWYgKCFzeW5jaHJvbml6ZXIpIHtcbiAgICAgIHN5bmNocm9uaXplciA9IG5ldyBTeW5jaHJvbml6ZXIoe3NlcnZpY2VOYW1lLCBjb2xsZWN0aW9uOiB0aGlzLCBkZWJ1ZzogdGhpcy5kZWJ1Z30pO1xuICAgICAgc3luY2hyb25pemVyLmNvbm5lY3Rpb24gPSBjb25uZWN0aW9uO1xuICAgICAgc3luY2hyb25pemVyLmRhdGFDaGFubmVsUHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZShkYXRhQ2hhbm5lbCk7XG4gICAgICB0aGlzLnN5bmNocm9uaXplcnMuc2V0KHNlcnZpY2VOYW1lLCBzeW5jaHJvbml6ZXIpO1xuICAgICAgLy8gRG9lcyBOT1Qgc3RhcnQgc3luY2hyb25pemluZy4gQ2FsbGVyIG11c3QgZG8gdGhhdCBpZiBkZXNpcmVkLiAoUm91dGVyIGRvZXNuJ3QgbmVlZCB0by4pXG4gICAgfSBlbHNlIGlmICgoc3luY2hyb25pemVyLmNvbm5lY3Rpb24gIT09IGNvbm5lY3Rpb24pIHx8XG5cdCAgICAgICAoc3luY2hyb25pemVyLmNoYW5uZWxOYW1lICE9PSBkYXRhQ2hhbm5lbC5sYWJlbCkgfHxcblx0ICAgICAgIChhd2FpdCBzeW5jaHJvbml6ZXIuZGF0YUNoYW5uZWxQcm9taXNlICE9PSBkYXRhQ2hhbm5lbCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5tYXRjaGVkIGNvbm5lY3Rpb24gZm9yICR7c2VydmljZU5hbWV9LmApO1xuICAgIH1cbiAgICByZXR1cm4gc3luY2hyb25pemVyO1xuICB9XG5cbiAgcHJvbWlzZShrZXksIHRodW5rKSB7IHJldHVybiB0aHVuazsgfSAvLyBUT0RPOiBob3cgd2lsbCB3ZSBrZWVwIHRyYWNrIG9mIG92ZXJsYXBwaW5nIGRpc3RpbmN0IHN5bmNzP1xuICBzeW5jaHJvbml6ZTEodGFnKSB7IC8vIENvbXBhcmUgYWdhaW5zdCBhbnkgcmVtYWluaW5nIHVuc3luY2hyb25pemVkIGRhdGEsIGZldGNoIHdoYXQncyBuZWVkZWQsIGFuZCByZXNvbHZlIGxvY2FsbHkuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHRoaXMubWFwU3luY2hyb25pemVycyhzeW5jaHJvbml6ZXIgPT4gc3luY2hyb25pemVyLnN5bmNocm9uaXphdGlvblByb21pc2UodGFnKSkpO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplVGFncygpIHsgLy8gRW5zdXJlIHRoYXQgd2UgaGF2ZSB1cCB0byBkYXRlIHRhZyBtYXAgYW1vbmcgYWxsIHNlcnZpY2VzLiAoV2UgZG9uJ3QgY2FyZSB5ZXQgb2YgdGhlIHZhbHVlcyBhcmUgc3luY2hyb25pemVkLilcbiAgICByZXR1cm4gdGhpcy5wcm9taXNlKCd0YWdzJywgKCkgPT4gUHJvbWlzZS5yZXNvbHZlKCkpOyAvLyBUT0RPXG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemVEYXRhKCkgeyAvLyBNYWtlIHRoZSBkYXRhIHRvIG1hdGNoIG91ciB0YWdtYXAsIHVzaW5nIHN5bmNocm9uaXplMS5cbiAgICByZXR1cm4gdGhpcy5wcm9taXNlKCdkYXRhJywgKCkgPT4gUHJvbWlzZS5yZXNvbHZlKCkpOyAvLyBUT0RPXG4gIH1cbiAgc2V0IG9udXBkYXRlKGhhbmRsZXIpIHsgLy8gQWxsb3cgc2V0dGluZyBpbiBsaWV1IG9mIGFkZEV2ZW50TGlzdGVuZXIuXG4gICAgaWYgKGhhbmRsZXIpIHtcbiAgICAgIHRoaXMuX3VwZGF0ZSA9IGhhbmRsZXI7XG4gICAgICB0aGlzLmFkZEV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIGhhbmRsZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIHRoaXMuX3VwZGF0ZSk7XG4gICAgICB0aGlzLl91cGRhdGUgPSBoYW5kbGVyO1xuICAgIH1cbiAgfVxuICBnZXQgb251cGRhdGUoKSB7IC8vIEFzIHNldCBieSB0aGlzLm9udXBkYXRlID0gaGFuZGxlci4gRG9lcyBOT1QgYW5zd2VyIHRoYXQgd2hpY2ggaXMgc2V0IGJ5IGFkZEV2ZW50TGlzdGVuZXIuXG4gICAgcmV0dXJuIHRoaXMuX3VwZGF0ZTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgSW1tdXRhYmxlQ29sbGVjdGlvbiBleHRlbmRzIENvbGxlY3Rpb24ge1xuICB0YWdGb3JXcml0aW5nKHRhZywgdmFsaWRhdGlvbikgeyAvLyBJZ25vcmVzIHRhZy4gSnVzdCB0aGUgaGFzaC5cbiAgICByZXR1cm4gdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIE92ZXJyaWRlcyBzdXBlciBieSBhbGxvd2luZyBFQVJMSUVSIHJhdGhlciB0aGFuIGxhdGVyLlxuICAgIGlmICghcHJvcG9zZWQpIHJldHVybiAnaW52YWxpZCBzaWduYXR1cmUnO1xuICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgIGlmICh2ZXJpZmllZC5sZW5ndGggJiYgKHRhZyAhPT0gcHJvcG9zZWQuc3ViKSkgcmV0dXJuICd3cm9uZyB0YWcnO1xuICAgICAgaWYgKCFhd2FpdCB0aGlzLnN1YmplY3RNYXRjaCh2ZXJpZmllZCkpIHJldHVybiAnd3JvbmcgaGFzaCc7XG4gICAgICByZXR1cm4gbnVsbDsgLy8gRmlyc3Qgd3JpdGUgb2suXG4gICAgfVxuICAgIC8vIE5vIG93bmVyIG1hdGNoLiBOb3QgcmVsZXZhbnQgZm9yIGltbXV0YWJsZXMuXG4gICAgaWYgKCF2ZXJpZmllZC5wYXlsb2FkLmxlbmd0aCAmJiAocHJvcG9zZWQuaWF0ID4gZXhpc3RpbmcuaWF0KSkgcmV0dXJuIG51bGw7IC8vIExhdGVyIGRlbGV0ZSBpcyBvay5cbiAgICBpZiAocHJvcG9zZWQuaWF0ID4gZXhpc3RpbmcuaWF0KSByZXR1cm4gJ3Jld3JpdGUnOyAvLyBPdGhlcndpc2UsIGxhdGVyIHdyaXRlcyBhcmUgbm90LlxuICAgIGlmIChwcm9wb3NlZC5zdWIgIT09IGV4aXN0aW5nLnN1YikgcmV0dXJuICdhbHRlcmVkIGNvbnRlbnRzJztcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuZXhwb3J0IGNsYXNzIE11dGFibGVDb2xsZWN0aW9uIGV4dGVuZHMgQ29sbGVjdGlvbiB7XG4gIHRhZ0ZvcldyaXRpbmcodGFnLCB2YWxpZGF0aW9uKSB7IC8vIFVzZSB0YWcgaWYgc3BlY2lmaWVkLCBidXQgZGVmYXVsdHMgdG8gaGFzaC5cbiAgICByZXR1cm4gdGFnIHx8IHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgfVxufVxuXG4vLyBFYWNoIFZlcnNpb25lZENvbGxlY3Rpb24gaGFzIGEgc2V0IG9mIGhhc2gtaWRlbnRpZmllZCBpbW11dGFibGUgaXRlbXMgdGhhdCBmb3JtIHRoZSBpbmRpdmlkdWFsIHZlcnNpb25zLCBhbmQgYSBtYXAgb2YgdGltZXN0YW1wcyB0byB0aG9zZSBpdGVtcy5cbi8vIFdlIGN1cnJlbnRseSBtb2RlbCB0aGlzIGJ5IGhhdmluZyB0aGUgbWFpbiBjb2xsZWN0aW9uIGJlIHRoZSBtdXRhYmxlIG1hcCwgYW5kIHRoZSB2ZXJzaW9ucyBpbnN0YW5jZSB2YXJpYWJsZSBpcyB0aGUgaW1tdXRhYmxlIGl0ZW1zIGNvbGxlY3Rpb24uXG4vLyBCdXQgYXBwcyBzdG9yZS9yZXRyaWV2ZSBpbmRpdmlkdWFsIGl0ZW1zIHRocm91Z2ggdGhlIG1haW4gY29sbGVjdGlvbiwgYW5kIHRoZSBjb3JyZXNwb25kaW5nIHVwZGF0ZXMgYXJlIHRocm91Z2ggdGhlIHZlcnNpb25zLCB3aGljaCBpcyBhIGJpdCBhd2t3YXJkLlxuXG4vLyBFYWNoIGl0ZW0gaGFzIGFuIGFudGVjZWRlbnQgdGhhdCBpcyBub3QgcGFydCBvZiB0aGUgYXBwbGljYXRpb24tc3VwcGxpZWQgcGF5bG9hZCAtLSBpdCBsaXZlcyBpbiB0aGUgc2lnbmF0dXJlJ3MgaGVhZGVyLlxuLy8gSG93ZXZlcjpcbi8vIC0gVGhlIHRhZyBET0VTIGluY2x1ZGUgdGhlIGFudGVjZWRlbnQsIGV2ZW4gdGhvdWdoIGl0IGlzIG5vdCBwYXJ0IG9mIHRoZSBwYXlsb2FkLiBUaGlzIG1ha2VzIGlkZW50aWNhbCBwYXlsb2FkcyBoYXZlXG4vLyAgIHVuaXF1ZSB0YWdzIChiZWNhdXNlIHRoZXkgd2lsbCBhbHdheXMgaGF2ZSBkaWZmZXJlbnQgYW50ZWNlZGVudHMpLlxuLy8gLSBUaGUgYWJpbGl0eSB0byB3cml0ZSBmb2xsb3dzIHRoZSBzYW1lIHJ1bGVzIGFzIE11dGFibGVDb2xsZWN0aW9uIChsYXRlc3Qgd2lucyksIGJ1dCBpcyB0ZXN0ZWQgYWdhaW5zdCB0aGVcbi8vICAgYW50ZWNlZGVudCB0YWcgaW5zdGVhZCBvZiB0aGUgdGFnIGJlaW5nIHdyaXR0ZW4uXG5leHBvcnQgY2xhc3MgVmVyc2lvbkNvbGxlY3Rpb24gZXh0ZW5kcyBNdXRhYmxlQ29sbGVjdGlvbiB7IC8vIE5lZWRzIHRvIGJlIGV4cG9ydGVkIHNvIHRoYXQgdGhhdCByb3V0ZXIubWpzIGNhbiBmaW5kIGl0LlxuICBhc3luYyB0YWdGb3JXcml0aW5nKHRhZywgdmFsaWRhdGlvbikgeyAvLyBVc2UgdGFnIGlmIHNwZWNpZmllZCAoZS5nLiwgcHV0L2RlbGV0ZSBkdXJpbmcgc3luY2hyb25pemF0aW9uKSwgb3Rod2Vyd2lzZSByZWZsZWN0IGJvdGggc3ViIGFuZCBhbnRlY2VkZW50LlxuICAgIGlmICh0YWcpIHJldHVybiB0YWc7XG4gICAgLy8gRWFjaCB2ZXJzaW9uIGdldHMgYSB1bmlxdWUgdGFnIChldmVuIGlmIHRoZXJlIGFyZSB0d28gdmVyc2lvbnMgdGhhdCBoYXZlIHRoZSBzYW1lIGRhdGEgcGF5bG9hZCkuXG4gICAgY29uc3QgYW50ID0gdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIuYW50O1xuICAgIGNvbnN0IHBheWxvYWRUZXh0ID0gdmFsaWRhdGlvbi50ZXh0IHx8IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZSh2YWxpZGF0aW9uLnBheWxvYWQpO1xuICAgIHJldHVybiBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoYXdhaXQgQ3JlZGVudGlhbHMuaGFzaFRleHQoYW50ICsgcGF5bG9hZFRleHQpKTtcbiAgfVxuICBhbnRlY2VkZW50KHZhbGlkYXRpb24pIHsgLy8gUmV0dXJucyB0aGUgdGFnIHRoYXQgdmFsaWRhdGlvbiBjb21wYXJlcyBhZ2FpbnN0LiBFLmcuLCBkbyB0aGUgb3duZXJzIG1hdGNoP1xuICAgIC8vIEZvciBub24tdmVyc2lvbmVkIGNvbGxlY3Rpb25zLCB3ZSBjb21wYXJlIGFnYWluc3QgdGhlIGV4aXN0aW5nIGRhdGEgYXQgdGhlIHNhbWUgdGFnIGJlaW5nIHdyaXR0ZW4uXG4gICAgLy8gRm9yIHZlcnNpb25lZCBjb2xsZWN0aW9ucywgaXQgaXMgd2hhdCBleGlzdHMgYXMgdGhlIGxhdGVzdCB2ZXJzaW9uIHdoZW4gdGhlIGRhdGEgaXMgc2lnbmVkLCBhbmQgd2hpY2ggdGhlIHNpZ25hdHVyZVxuICAgIC8vIHJlY29yZHMgaW4gdGhlIHNpZ25hdHVyZS4gKEZvciB0aGUgdmVyeSBmaXJzdCB2ZXJzaW9uLCB0aGUgc2lnbmF0dXJlIHdpbGwgbm90ZSB0aGUgdGltZXN0YW1wIGFzIHRoZSBhbnRlY2VjZGVudCB0YWcsXG4gICAgLy8gKHNlZSB0YWdGb3JXcml0aW5nKSwgYnV0IGZvciBjb21wYXJpbmcgYWdhaW5zdCwgdGhpcyBtZXRob2QgYW5zd2VycyBmYWxzeSBmb3IgdGhlIGZpcnN0IGluIHRoZSBjaGFpbi5cbiAgICBjb25zdCBoZWFkZXIgPSB2YWxpZGF0aW9uPy5wcm90ZWN0ZWRIZWFkZXI7XG4gICAgaWYgKCFoZWFkZXIpIHJldHVybiAnJztcbiAgICBjb25zdCBhbnRlY2VkZW50ID0gaGVhZGVyLmFudDtcbiAgICBpZiAodHlwZW9mKGFudGVjZWRlbnQpID09PSAnbnVtYmVyJykgcmV0dXJuICcnOyAvLyBBIHRpbWVzdGFtcCBhcyBhbnRlY2VkZW50IGlzIHVzZWQgdG8gdG8gc3RhcnQgdGhpbmdzIG9mZi4gTm8gdHJ1ZSBhbnRlY2VkZW50LlxuICAgIHJldHVybiBhbnRlY2VkZW50O1xuICB9XG4gIGFzeW5jIHN1YmplY3RNYXRjaCh2ZXJpZmllZCkgeyAvLyBIZXJlIHN1YiByZWZlcnMgdG8gdGhlIG92ZXJhbGwgaXRlbSB0YWcgdGhhdCBlbmNvbXBhc3NlcyBhbGwgdmVyc2lvbnMsIG5vdCB0aGUgcGF5bG9hZCBoYXNoLlxuICAgIHJldHVybiB0cnVlOyAvLyBUT0RPOiBtYWtlIHN1cmUgaXQgbWF0Y2hlcyBwcmV2aW91cz9cbiAgfVxuICBlbWl0KHZlcmlmaWVkKSB7IC8vIHN1YmplY3RUYWcgKGkuZS4sIHRoZSB0YWcgd2l0aGluIHRoZSBjb2xsZWN0aW9uIGFzIGEgd2hvbGUpIGlzIG5vdCB0aGUgdGFnL2hhc2guXG4gICAgdmVyaWZpZWQuc3ViamVjdFRhZyA9IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gICAgc3VwZXIuZW1pdCh2ZXJpZmllZCk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFZlcnNpb25lZENvbGxlY3Rpb24gZXh0ZW5kcyBNdXRhYmxlQ29sbGVjdGlvbiB7XG4gIC8vIFRPRE86IFRoaXMgd29ya3MgYW5kIGRlbW9uc3RyYXRlcyBoYXZpbmcgYSBjb2xsZWN0aW9uIHVzaW5nIG90aGVyIGNvbGxlY3Rpb25zLlxuICAvLyBIb3dldmVyLCBoYXZpbmcgYSBiaWcgdGltZXN0YW1wID0+IGZpeG51bSBtYXAgaXMgYmFkIGZvciBwZXJmb3JtYW5jZSBhcyB0aGUgaGlzdG9yeSBnZXRzIGxvbmdlci5cbiAgLy8gVGhpcyBzaG91bGQgYmUgc3BsaXQgdXAgaW50byB3aGF0IGlzIGRlc2NyaWJlZCBpbiB2ZXJzaW9uZWQubWQuXG4gIGNvbnN0cnVjdG9yKHtzZXJ2aWNlcyA9IFtdLCAuLi5yZXN0fSA9IHt9KSB7XG4gICAgc3VwZXIocmVzdCk7ICAvLyBXaXRob3V0IHBhc3Npbmcgc2VydmljZXMgeWV0LCBhcyB3ZSBkb24ndCBoYXZlIHRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uIHNldCB1cCB5ZXQuXG4gICAgdGhpcy52ZXJzaW9ucyA9IG5ldyBWZXJzaW9uQ29sbGVjdGlvbihyZXN0KTsgLy8gU2FtZSBjb2xsZWN0aW9uIG5hbWUsIGJ1dCBkaWZmZXJlbnQgdHlwZS5cbiAgICAvL2ZpeG1lIHRoaXMudmVyc2lvbnMuYWRkRXZlbnRMaXN0ZW5lcigndXBkYXRlJywgZXZlbnQgPT4gdGhpcy5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudCgndXBkYXRlJywge2RldGFpbDogdGhpcy5yZWNvdmVyVGFnKGV2ZW50LmRldGFpbCl9KSkpO1xuICAgIHRoaXMuc3luY2hyb25pemUoLi4uc2VydmljZXMpOyAvLyBOb3cgd2UgY2FuIHN5bmNocm9uaXplLlxuICB9XG4gIGFzeW5jIGNsb3NlKCkge1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuY2xvc2UoKTtcbiAgICBhd2FpdCBzdXBlci5jbG9zZSgpO1xuICB9XG4gIGFzeW5jIGRlc3Ryb3koKSB7XG4gICAgYXdhaXQgdGhpcy52ZXJzaW9ucy5kZXN0cm95KCk7XG4gICAgYXdhaXQgc3VwZXIuZGVzdHJveSgpO1xuICB9XG4gIHJlY292ZXJUYWcodmVyaWZpZWQpIHsgLy8gdGhlIHZlcmlmaWVkLnRhZyBpcyBmb3IgdGhlIHZlcnNpb24uIFdlIHdhbnQgdGhlIG92ZXJhbGwgb25lLlxuICAgIHJldHVybiBPYmplY3QuYXNzaWduKHt9LCB2ZXJpZmllZCwge3RhZzogdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLnN1Yn0pOyAvLyBEbyBub3QgYmFzaCB2ZXJpZmllZCFcbiAgfVxuICBzZXJ2aWNlRm9yVmVyc2lvbihzZXJ2aWNlKSB7IC8vIEdldCB0aGUgc2VydmljZSBcIm5hbWVcIiBmb3Igb3VyIHZlcnNpb25zIGNvbGxlY3Rpb24uXG4gICAgcmV0dXJuIHNlcnZpY2U/LnZlcnNpb25zIHx8IHNlcnZpY2U7ICAgLy8gRm9yIHRoZSB3ZWlyZCBjb25uZWN0RGlyZWN0VGVzdGluZyBjYXNlIHVzZWQgaW4gcmVncmVzc2lvbiB0ZXN0cywgZWxzZSB0aGUgc2VydmljZSAoZS5nLiwgYW4gYXJyYXkgb2Ygc2lnbmFscykuXG4gIH1cbiAgc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSB7XG4gICAgcmV0dXJuIHNlcnZpY2VzLm1hcChzZXJ2aWNlID0+IHRoaXMuc2VydmljZUZvclZlcnNpb24oc2VydmljZSkpO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSB7IC8vIHN5bmNocm9uaXplIHRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uLCB0b28uXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHJldHVybjtcbiAgICAvLyBLZWVwIGNoYW5uZWwgY3JlYXRpb24gc3luY2hyb25vdXMuXG4gICAgY29uc3QgdmVyc2lvbmVkUHJvbWlzZSA9IHN1cGVyLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTtcbiAgICBjb25zdCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbnMuc3luY2hyb25pemUoLi4udGhpcy5zZXJ2aWNlc0ZvclZlcnNpb24oc2VydmljZXMpKTtcbiAgICBhd2FpdCB2ZXJzaW9uZWRQcm9taXNlO1xuICAgIGF3YWl0IHZlcnNpb25Qcm9taXNlO1xuICB9XG4gIGFzeW5jIGRpc2Nvbm5lY3QoLi4uc2VydmljZXMpIHsgLy8gZGlzY29ubmVjdCB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiwgdG9vLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgYXdhaXQgdGhpcy52ZXJzaW9ucy5kaXNjb25uZWN0KC4uLnRoaXMuc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSk7XG4gICAgYXdhaXQgc3VwZXIuZGlzY29ubmVjdCguLi5zZXJ2aWNlcyk7XG4gIH1cbiAgZ2V0IHN5bmNocm9uaXplZCgpIHsgLy8gcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gc3luY2hyb25pemF0aW9uIGlzIGNvbXBsZXRlIGluIEJPVEggZGlyZWN0aW9ucy5cbiAgICAvLyBUT0RPPyBUaGlzIGRvZXMgbm90IHJlZmxlY3QgY2hhbmdlcyBhcyBTeW5jaHJvbml6ZXJzIGFyZSBhZGRlZCBvciByZW1vdmVkIHNpbmNlIGNhbGxlZC4gU2hvdWxkIGl0P1xuICAgIHJldHVybiBzdXBlci5zeW5jaHJvbml6ZWQudGhlbigoKSA9PiB0aGlzLnZlcnNpb25zLnN5bmNocm9uaXplZCk7XG4gIH1cbiAgZ2V0IGl0ZW1FbWl0dGVyKCkgeyAvLyBUaGUgdmVyc2lvbnMgY29sbGVjdGlvbiBlbWl0cyBhbiB1cGRhdGUgY29ycmVzcG9uZGluZyB0byB0aGUgaW5kaXZpZHVhbCBpdGVtIHN0b3JlZC5cbiAgICAvLyAoVGhlIHVwZGF0ZXMgZW1pdHRlZCBmcm9tIHRoZSB3aG9sZSBtdXRhYmxlIFZlcnNpb25lZENvbGxlY3Rpb24gY29ycmVzcG9uZCB0byB0aGUgbWFwLilcbiAgICByZXR1cm4gdGhpcy52ZXJzaW9ucztcbiAgfVxuXG4gIGFzeW5jIGdldFZlcnNpb25zKHRhZykgeyAvLyBQcm9taXNlcyB0aGUgcGFyc2VkIHRpbWVzdGFtcCA9PiB2ZXJzaW9uIGRpY3Rpb25hcnkgSUYgaXQgZXhpc3RzLCBlbHNlIGZhbHN5LlxuICAgIHRoaXMucmVxdWlyZVRhZyh0YWcpO1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnfSk7XG4gICAgY29uc3QganNvbiA9IHZlcmlmaWVkPy5qc29uO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShqc29uKSkgcmV0dXJuIGpzb247XG4gICAgLy8gSWYgd2UgaGF2ZSBhbiB1bm1lcmdlZCBhcnJheSBvZiBzaWduYXR1cmVzLi4uXG4gICAgLy8gSSdtIG5vdCBzdXJlIHRoYXQgaXQncyB2ZXJ5IHVzZWZ1bCB0byBhcHBsaWNhdGlvbnMgZm9yIHVzIHRvIGhhbmRsZSB0aGlzIGNhc2UsIGJ1dCBpdCBpcyBuaWNlIHRvIGV4ZXJjaXNlIHRoaXMgaW4gdGVzdGluZy5cbiAgICBjb25zdCB2ZXJpZmljYXRpb25zQXJyYXkgPSBhd2FpdCB0aGlzLmVuc3VyZUV4cGFuZGVkKHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdGhpcy5jb21iaW5lVGltZXN0YW1wcyh0YWcsIG51bGwsIC4uLnZlcmlmaWNhdGlvbnNBcnJheS5tYXAodiA9PiB2Lmpzb24pKTtcbiAgfVxuICBhc3luYyByZXRyaWV2ZVRpbWVzdGFtcHModGFnKSB7IC8vIFByb21pc2VzIGEgbGlzdCBvZiBhbGwgdmVyc2lvbiB0aW1lc3RhbXBzLlxuICAgIGNvbnN0IHZlcnNpb25zID0gYXdhaXQgdGhpcy5nZXRWZXJzaW9ucyh0YWcpO1xuICAgIGlmICghdmVyc2lvbnMpIHJldHVybiB2ZXJzaW9ucztcbiAgICByZXR1cm4gT2JqZWN0LmtleXModmVyc2lvbnMpLnNsaWNlKDEpLm1hcChzdHJpbmcgPT4gcGFyc2VJbnQoc3RyaW5nKSk7IC8vIFRPRE8/IE1hcCB0aGVzZSB0byBpbnRlZ2Vycz9cbiAgfVxuICBnZXRBY3RpdmVIYXNoKHRpbWVzdGFtcHMsIHRpbWUgPSB0aW1lc3RhbXBzLmxhdGVzdCkgeyAvLyBQcm9taXNlcyB0aGUgdmVyc2lvbiB0YWcgdGhhdCB3YXMgaW4gZm9yY2UgYXQgdGhlIHNwZWNpZmllZCB0aW1lXG4gICAgLy8gKHdoaWNoIG1heSBiZWZvcmUsIGluIGJldHdlZW4sIG9yIGFmdGVyIHRoZSByZWNvcmRlZCBkaXNjcmV0ZSB0aW1lc3RhbXBzKS5cbiAgICBpZiAoIXRpbWVzdGFtcHMpIHJldHVybiB0aW1lc3RhbXBzO1xuICAgIGxldCBoYXNoID0gdGltZXN0YW1wc1t0aW1lXTtcbiAgICBpZiAoaGFzaCkgcmV0dXJuIGhhc2g7XG4gICAgLy8gV2UgbmVlZCB0byBmaW5kIHRoZSB0aW1lc3RhbXAgdGhhdCB3YXMgaW4gZm9yY2UgYXQgdGhlIHJlcXVlc3RlZCB0aW1lLlxuICAgIGxldCBiZXN0ID0gMCwgdGltZXMgPSBPYmplY3Qua2V5cyh0aW1lc3RhbXBzKTtcbiAgICBmb3IgKGxldCBpID0gMTsgaSA8IHRpbWVzLmxlbmd0aDsgaSsrKSB7IC8vIDB0aCBpcyB0aGUga2V5ICdsYXRlc3QnLlxuICAgICAgaWYgKHRpbWVzW2ldIDw9IHRpbWUpIGJlc3QgPSB0aW1lc1tpXTtcbiAgICAgIGVsc2UgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiB0aW1lc3RhbXBzW2Jlc3RdO1xuICB9XG4gIGFzeW5jIHJldHJpZXZlKHRhZ09yT3B0aW9ucykgeyAvLyBBbnN3ZXIgdGhlIHZhbGlkYXRlZCB2ZXJzaW9uIGluIGZvcmNlIGF0IHRoZSBzcGVjaWZpZWQgdGltZSAob3IgbGF0ZXN0KSwgb3IgYXQgdGhlIHNwZWNpZmljIGhhc2guXG4gICAgbGV0IHt0YWcsIHRpbWUsIGhhc2gsIC4uLnJlc3R9ID0gKCF0YWdPck9wdGlvbnMgfHwgdGFnT3JPcHRpb25zLmxlbmd0aCkgPyB7dGFnOiB0YWdPck9wdGlvbnN9IDogdGFnT3JPcHRpb25zO1xuICAgIGlmICghaGFzaCkge1xuICAgICAgY29uc3QgdGltZXN0YW1wcyA9IGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKTtcbiAgICAgIGlmICghdGltZXN0YW1wcykgcmV0dXJuIHRpbWVzdGFtcHM7XG4gICAgICBoYXNoID0gdGhpcy5nZXRBY3RpdmVIYXNoKHRpbWVzdGFtcHMsIHRpbWUpO1xuICAgICAgaWYgKCFoYXNoKSByZXR1cm4gJyc7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnZlcnNpb25zLnJldHJpZXZlKHt0YWc6IGhhc2gsIC4uLnJlc3R9KTtcbiAgfVxuICBhc3luYyBzdG9yZShkYXRhLCBvcHRpb25zID0ge30pIHsgLy8gRGV0ZXJtaW5lIHRoZSBhbnRlY2VkZW50LCByZWNvcmQgaXQgaW4gdGhlIHNpZ25hdHVyZSwgYW5kIHN0b3JlIHRoYXRcbiAgICAvLyBhcyB0aGUgYXBwcm9wcmlhdGUgdmVyc2lvbiBoYXNoLiBUaGVuIHJlY29yZCB0aGUgbmV3IHRpbWVzdGFtcC9oYXNoIGluIHRoZSB0aW1lc3RhbXBzIGxpc3QuXG4gICAgbGV0IHZlcnNpb25zLFxuXHQvLyBUT0RPOiBDb25zaWRlciBlbmNyeXB0aW5nIHRoZSB0aW1lc3RhbXBzLCB0b28uXG5cdC8vIEN1cnJlbnRseSwgc2lnbmluZ09wdGlvbnMgZm9yIHRoZSB0aW1lc3RhbXBzIGRvZXMgTk9UIGVuY2x1ZGUgZW5jcnlwdGlvbiwgZXZlbiBpZiBzcGVjaWZpZWQgZm9yIHRoZSBhY3R1YWwgc3BlY2lmaWMgdmVyc2lvbiBpbmZvLlxuXHQvLyBUaGlzIG1lYW5zIHRoYXQgaWYgdGhlIGFwcGxpY2F0aW9uIHNwZWNpZmllcyBhbiBlbmNyeXB0ZWQgdmVyc2lvbmVkIGNvbGxlY3Rpb24sIHRoZSBkYXRhIGl0c2VsZiB3aWxsIGJlIGVuY3J5cHRlZCwgYnV0XG5cdC8vIG5vdCB0aGUgbWFwIG9mIHRpbWVzdGFtcHMgdG8gaGFzaGVzLCBhbmQgc28gYSBsdXJrZXIgY2FuIHNlZSB3aGVuIHRoZXJlIHdhcyBhY3Rpdml0aXR5IGFuZCBoYXZlIGFuIGlkZWEgYXMgdG8gdGhlIHNpemUuXG5cdC8vIE9mIGNvdXJzZSwgZXZlbiBpZiBlbmNyeXB0ZWQsIHRoZXkgY291bGQgYWxzbyBnZXQgdGhpcyBmcm9tIGxpdmUgdHJhZmZpYyBhbmFseXNpcywgc28gbWF5YmUgZW5jcnlwdGluZyBpdCB3b3VsZCBqdXN0XG5cdC8vIGNvbnZleSBhIGZhbHNlIHNlbnNlIG9mIHNlY3VyaXR5LiBFbmNyeXB0aW5nIHRoZSB0aW1lc3RhbXBzIGRvZXMgY29tcGxpY2F0ZSwgZS5nLiwgbWVyZ2VTaWduYXR1cmVzKCkgYmVjYXVzZVxuXHQvLyBzb21lIG9mIHRoZSB3b3JrIGNvdWxkIG9ubHkgYmUgZG9uZSBieSByZWxheXMgdGhhdCBoYXZlIGFjY2Vzcy4gQnV0IHNpbmNlIHdlIGhhdmUgdG8gYmUgY2FyZWZ1bCBhYm91dCBzaWduaW5nIGFueXdheSxcblx0Ly8gd2Ugc2hvdWxkIHRoZW9yZXRpY2FsbHkgYmUgYWJsZSB0byBiZSBhY2NvbW9kYXRlIHRoYXQuXG5cdHt0YWcsIGVuY3J5cHRpb24sIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyksXG5cdHRpbWUgPSBEYXRlLm5vdygpLFxuXHR2ZXJzaW9uT3B0aW9ucyA9IE9iamVjdC5hc3NpZ24oe3RpbWUsIGVuY3J5cHRpb259LCBzaWduaW5nT3B0aW9ucyk7XG4gICAgaWYgKHRhZykge1xuICAgICAgdmVyc2lvbnMgPSAoYXdhaXQgdGhpcy5nZXRWZXJzaW9ucyh0YWcpKSB8fCB7fTtcbiAgICAgIHZlcnNpb25PcHRpb25zLnN1YiA9IHRhZztcbiAgICAgIGlmICh2ZXJzaW9ucykge1xuXHR2ZXJzaW9uT3B0aW9ucy5hbnQgPSB2ZXJzaW9uc1t2ZXJzaW9ucy5sYXRlc3RdO1xuICAgICAgfVxuICAgIH0gLy8gRWxzZSBkbyBub3QgYXNzaWduIHN1Yi4gSXQgd2lsbCBiZSBzZXQgdG8gdGhlIHBheWxvYWQgaGFzaCBkdXJpbmcgc2lnbmluZywgYW5kIGFsc28gdXNlZCBmb3IgdGhlIG92ZXJhbGwgdGFnLlxuICAgIHZlcnNpb25PcHRpb25zLmFudCB8fD0gdGltZTtcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5zdG9yZShkYXRhLCB2ZXJzaW9uT3B0aW9ucyk7XG4gICAgaWYgKCF0YWcpIHsgLy8gV2UnbGwgc3RpbGwgbmVlZCB0YWcgYW5kIHZlcnNpb25zLlxuICAgICAgY29uc3QgdmVyc2lvblNpZ25hdHVyZSA9IGF3YWl0IHRoaXMudmVyc2lvbnMuZ2V0KGhhc2gpO1xuICAgICAgY29uc3QgY2xhaW1zID0gQ3JlZGVudGlhbHMuZGVjb2RlQ2xhaW1zKHRoaXMuY29uc3RydWN0b3IubWF5YmVJbmZsYXRlKHZlcnNpb25TaWduYXR1cmUpKTtcbiAgICAgIHRhZyA9IGNsYWltcy5zdWI7XG4gICAgICB2ZXJzaW9ucyA9IHt9O1xuICAgIH1cbiAgICB2ZXJzaW9ucy5sYXRlc3QgPSB0aW1lO1xuICAgIHZlcnNpb25zW3RpbWVdID0gaGFzaDtcblxuICAgIC8vIGZpeG1lIG5leHRcbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24odmVyc2lvbnMsIHNpZ25pbmdPcHRpb25zKTtcbiAgICAvLyBIZXJlIHdlIGFyZSBkb2luZyB3aGF0IHRoaXMucHV0KCkgd291bGQgbm9ybWFsbHkgZG8sIGJ1dCB3ZSBoYXZlIGFscmVhZHkgbWVyZ2VkIHNpZ25hdHVyZXMuXG4gICAgYXdhaXQgdGhpcy5hZGRUYWcodGFnKTtcbiAgICBhd2FpdCB0aGlzLnBlcnNpc3QodGFnLCBzaWduYXR1cmUpO1xuICAgIHRoaXMuZW1pdCh7dGFnLCBzdWJqZWN0VGFnOiB0YWcsIC4uLihhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeShzaWduYXR1cmUpKX0pO1xuICAgIGF3YWl0IHRoaXMucHVzaCgncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICAgIC8vIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZmllZFNpZ24odmVyc2lvbnMsIHNpZ25pbmdPcHRpb25zLCB0YWcpO1xuICAgIC8vIHRoaXMubG9nKCdwdXQoLWlzaCknLCB2ZXJpZmllZCk7XG4gICAgLy8gYXdhaXQgdGhpcy5wZXJzaXN0Mih2ZXJpZmllZCk7XG4gICAgLy8gYXdhaXQgdGhpcy5hZGRUYWcodGFnKTtcbiAgICAvLyB0aGlzLmVtaXQoey4uLnZlcmlmaWVkLCB0YWcsIHN1YmplY3RUYWc6IHRhZ30pO1xuICAgIC8vIGF3YWl0IHRoaXMucHVzaCgncHV0JywgdGFnLCB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZVN0cmluZyh2ZXJpZmllZC5zaWduYXR1cmUpKTtcblxuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgYXN5bmMgcmVtb3ZlKG9wdGlvbnMgPSB7fSkgeyAvLyBBZGQgYW4gZW1wdHkgdmVyaW9uIG9yIHJlbW92ZSBhbGwgdmVyc2lvbnMsIGRlcGVuZGluZyBvbiB0aGlzLnByZXNlcnZlRGVsZXRpb25zLlxuICAgIGxldCB7ZW5jcnlwdGlvbiwgdGFnLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpOyAvLyBJZ25vcmUgZW5jcnlwdGlvblxuICAgIGNvbnN0IHZlcnNpb25zID0gYXdhaXQgdGhpcy5nZXRWZXJzaW9ucyh0YWcpO1xuICAgIGlmICghdmVyc2lvbnMpIHJldHVybiB2ZXJzaW9ucztcbiAgICBpZiAodGhpcy5wcmVzZXJ2ZURlbGV0aW9ucykgeyAvLyBDcmVhdGUgYSB0aW1lc3RhbXAgPT4gdmVyc2lvbiB3aXRoIGFuIGVtcHR5IHBheWxvYWQuIE90aGVyd2lzZSBtZXJnaW5nIHdpdGggZWFybGllciBkYXRhIHdpbGwgYnJpbmcgaXQgYmFjayFcbiAgICAgIGF3YWl0IHRoaXMuc3RvcmUoJycsIHNpZ25pbmdPcHRpb25zKTtcbiAgICB9IGVsc2UgeyAvLyBBY3R1YWxseSBkZWxldGUgdGhlIHRpbWVzdGFtcHMgYW5kIGVhY2ggdmVyc2lvbi5cbiAgICAgIC8vIGZpeG1lIG5leHRcbiAgICAgIGNvbnN0IHZlcnNpb25UYWdzID0gT2JqZWN0LnZhbHVlcyh2ZXJzaW9ucykuc2xpY2UoMSk7XG4gICAgICBjb25zdCB2ZXJzaW9uU2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKCcnLCB7c3ViOiB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSk7XG4gICAgICAvLyBUT0RPOiBJcyB0aGlzIHNhZmU/IFNob3VsZCB3ZSBtYWtlIGEgc2lnbmF0dXJlIHRoYXQgc3BlY2lmaWVzIGVhY2ggYW50ZWNlZGVudD9cbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKHZlcnNpb25UYWdzLm1hcChhc3luYyB0YWcgPT4ge1xuXHRhd2FpdCB0aGlzLnZlcnNpb25zLmRlbGV0ZSh0YWcsIHZlcnNpb25TaWduYXR1cmUpO1xuXHRhd2FpdCB0aGlzLnZlcnNpb25zLnB1c2goJ2RlbGV0ZScsIHRhZywgdmVyc2lvblNpZ25hdHVyZSk7XG4gICAgICB9KSk7XG4gICAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oJycsIHNpZ25pbmdPcHRpb25zKTtcbiAgICAgIGF3YWl0IHRoaXMucGVyc2lzdCh0YWcsIHNpZ25hdHVyZSwgJ2RlbGV0ZScpO1xuICAgICAgYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgICAvLyBjb25zdCB2ZXJzaW9uSGFzaGVzID0gT2JqZWN0LnZhbHVlcyh2ZXJzaW9ucykuc2xpY2UoMSk7XG4gICAgICAvLyBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZpZWRTaWduKCcnLCB7c3ViOiB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSwgdGFnKTtcbiAgICAgIC8vIC8vIFRPRE86IElzIHRoaXMgc2FmZT8gU2hvdWxkIHdlIG1ha2UgYSBzaWduYXR1cmUgdGhhdCBzcGVjaWZpZXMgZWFjaCBhbnRlY2VkZW50P1xuICAgICAgLy8gYXdhaXQgUHJvbWlzZS5hbGwodmVyc2lvbkhhc2hlcy5tYXAoYXN5bmMgaGFzaCA9PiB7XG4gICAgICAvLyBcdGxldCB2VmVyaWZpZWQgPSB7Li4udmVyaWZpZWQsIHRhZzogaGFzaH07XG4gICAgICAvLyBcdGxldCBzVmVyaWZpZWQgPSB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZVN0cmluZyh2VmVyaWZpZWQuc2lnbmF0dXJlKTtcbiAgICAgIC8vIFx0Ly8gYXdhaXQgdGhpcy52ZXJzaW9ucy5kZWxldGVUYWcodGFnKTtcbiAgICAgIC8vIFx0Ly8gYXdhaXQgdGhpcy52ZXJzaW9ucy5wZXJzaXN0Mih2VmVyaWZpZWQsICdkZWxldGUnKTtcbiAgICAgIC8vIFx0Ly8gdGhpcy52ZXJzaW9ucy5lbWl0KHZWZXJpZmllZCk7XG4gICAgICAvLyBcdC8vIGF3YWl0IHRoaXMudmVyc2lvbnMucHVzaCgnZGVsZXRlJywgdGFnLCBzVmVyaWZpZWQpO1xuICAgICAgLy8gXHRhd2FpdCB0aGlzLnZlcnNpb25zLmRlbGV0ZSh0YWcsIHNWZXJpZmllZCk7XG4gICAgICAvLyBcdGF3YWl0IHRoaXMudmVyc2lvbnMucHVzaCgnZGVsZXRlJywgdGFnLCBzVmVyaWZpZWQpXG4gICAgICAvLyB9KSk7XG4gICAgICAvLyBhd2FpdCB0aGlzLnBlcnNpc3QyKHZlcmlmaWVkLCAnZGVsZXRlJyk7XG4gICAgICAvLyBhd2FpdCB0aGlzLnB1c2goJ2RlbGV0ZScsIHRhZywgdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcodmVyaWZpZWQuc2lnbmF0dXJlKSk7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuZGVsZXRlVGFnKHRhZyk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyBtZXJnZVNpZ25hdHVyZXModGFnLCB2YWxpZGF0aW9uLCBzaWduYXR1cmUsIGF1dGhvck92ZXJyaWRlID0gbnVsbCkgeyAvLyBNZXJnZSB0aGUgbmV3IHRpbWVzdGFtcHMgd2l0aCB0aGUgb2xkLlxuICAgIC8vIElmIHByZXZpb3VzIGRvZXNuJ3QgZXhpc3Qgb3IgbWF0Y2hlcyB0aGUgbmV4dCwgb3IgaXMgYSBzdWJzZXQgb2YgdGhlIG5leHQsIGp1c3QgdXNlIHRoZSBuZXh0LlxuICAgIC8vIE90aGVyd2lzZSwgd2UgaGF2ZSB0byBtZXJnZTpcbiAgICAvLyAtIE1lcmdlZCBtdXN0IGNvbnRhaW4gdGhlIHVuaW9uIG9mIHZhbHVlcyBmb3IgZWl0aGVyLlxuICAgIC8vICAgKFNpbmNlIHZhbHVlcyBhcmUgaGFzaGVzIG9mIHN0dWZmIHdpdGggYW4gZXhwbGljaXQgYW50ZWRlbnQsIG5leHQgcHJldmlvdXMgbm9yIG5leHQgd2lsbCBoYXZlIGR1cGxpY2F0ZXMgYnkgdGhlbXNlbHZlcy4uKVxuICAgIC8vIC0gSWYgdGhlcmUncyBhIGNvbmZsaWN0IGluIGtleXMsIGNyZWF0ZSBhIG5ldyBrZXkgdGhhdCBpcyBtaWR3YXkgYmV0d2VlbiB0aGUgY29uZmxpY3QgYW5kIHRoZSBuZXh0IGtleSBpbiBvcmRlci5cblxuICAgIGxldCBuZXh0ID0gdmFsaWRhdGlvbjtcbiAgICBsZXQgcHJldmlvdXMgPSB2YWxpZGF0aW9uLmV4aXN0aW5nO1xuICAgIC8vZml4bWUgbmV4dFxuICAgIGlmICghcHJldmlvdXMpIHJldHVybiBzaWduYXR1cmU7ICAgLy8gTm8gcHJldmlvdXMsIGp1c3QgdXNlIG5ldyBzaWduYXR1cmUuXG4gICAgLy9pZiAoIXByZXZpb3VzKSByZXR1cm4gbmV4dDsgICAvLyBObyBwcmV2aW91cywganVzdCBuZXh0LlxuXG4gICAgLy8gQXQgdGhpcyBwb2ludCwgcHJldmlvdXMgYW5kIG5leHQgYXJlIGJvdGggXCJvdXRlclwiIHZhbGlkYXRpb25zLlxuICAgIC8vIFRoYXQganNvbiBjYW4gYmUgZWl0aGVyIGEgdGltZXN0YW1wIG9yIGFuIGFycmF5IG9mIHNpZ25hdHVyZXMuXG4gICAgaWYgKHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLmlhdCA8IHZhbGlkYXRpb24uZXhpc3RpbmcucHJvdGVjdGVkSGVhZGVyLmlhdCkgeyAvLyBBcnJhbmdlIGZvciBuZXh0IGFuZCBzaWduYXR1cmUgdG8gYmUgbGF0ZXIgb25lIGJ5IHNpZ25lZCB0aW1lc3RhbXAuXG4gICAgICAvLyBUT0RPOiBpcyBpdCBwb3NzaWJsZSB0byBjb25zdHJ1Y3QgYSBzY2VuYXJpbyBpbiB3aGljaCB0aGVyZSBpcyBhIGZpY3RpdGlvdXMgdGltZSBzdGFtcCBjb25mbGljdC4gRS5nLCBpZiBhbGwgb2YgdGhlc2UgYXJlIHRydWU6XG4gICAgICAvLyAxLiBwcmV2aW91cyBhbmQgbmV4dCBoYXZlIGlkZW50aWNhbCB0aW1lc3RhbXBzIGZvciBkaWZmZXJlbnQgdmFsdWVzLCBhbmQgc28gd2UgbmVlZCB0byBjb25zdHJ1Y3QgYXJ0aWZpY2lhbCB0aW1lcyBmb3Igb25lLiBMZXQncyBjYWxsIHRoZXNlIGJyYW5jaCBBIGFuZCBCLlxuICAgICAgLy8gMi4gdGhpcyBoYXBwZW5zIHdpdGggdGhlIHNhbWUgdGltZXN0YW1wIGluIGEgc2VwYXJhdGUgcGFpciwgd2hpY2ggd2UnbGwgY2FsbCBBMiwgYW5kIEIyLlxuICAgICAgLy8gMy4gQSBhbmQgQiBhcmUgbWVyZ2VkIGluIHRoYXQgb3JkZXIgKGUuZy4gdGhlIGxhc3QgdGltZSBpbiBBIGlzIGxlc3MgdGhhbiBCKSwgYnV0IEEyIGFuZCBCMiBhcmUgbWVyZ2VkIGJhY2t3YXJkcyAoZS5nLiwgdGhlIGxhc3QgdGltZSBpbiBCMiBpcyBsZXNzIHRoYW50IEEyKSxcbiAgICAgIC8vICAgIHN1Y2ggdGhhdCB0aGUgb3ZlcmFsbCBtZXJnZSBjcmVhdGVzIGEgY29uZmxpY3Q/XG4gICAgICBbcHJldmlvdXMsIG5leHRdID0gW25leHQsIHByZXZpb3VzXTtcbiAgICB9XG5cbiAgICAvLyBGaW5kIHRoZSB0aW1lc3RhbXBzIG9mIHByZXZpb3VzIHdob3NlIFZBTFVFUyB0aGF0IGFyZSBub3QgaW4gbmV4dC5cbiAgICBsZXQga2V5c09mTWlzc2luZyA9IG51bGw7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHByZXZpb3VzLmpzb24pICYmICFBcnJheS5pc0FycmF5KG5leHQuanNvbikpIHsgLy8gTm8gcG9pbnQgaW4gb3B0aW1pemluZyB0aHJvdWdoIG1pc3NpbmdLZXlzIGlmIHRoYXQgbWFrZXMgdXMgY29tYmluZVRpbWVzdGFtcHMgYW55d2F5LlxuICAgICAga2V5c09mTWlzc2luZyA9IHRoaXMubWlzc2luZ0tleXMocHJldmlvdXMuanNvbiwgbmV4dC5qc29uKTtcbiAgICAgIC8vIGZpeG1lIG5leHRcbiAgICAgIGlmICgha2V5c09mTWlzc2luZy5sZW5ndGgpIHJldHVybiB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZVN0cmluZyhuZXh0LnNpZ25hdHVyZSk7IC8vIFByZXZpb3VzIGlzIGEgc3Vic2V0IG9mIG5ldyBzaWduYXR1cmUuXG4gICAgICAvL2lmICgha2V5c09mTWlzc2luZy5sZW5ndGgpIHJldHVybiBuZXh0OyAvLyBQcmV2aW91cyBpcyBhIHN1YnNldCBvZiBuZXcgc2lnbmF0dXJlLlxuICAgIH1cbiAgICAvLyBUT0RPOiByZXR1cm4gcHJldmlvdXMgaWYgbmV4dCBpcyBhIHN1YnNldCBvZiBpdD9cblxuICAgIC8vIFdlIGNhbm5vdCByZS11c2Ugb25lIG9yIG90aGVyLiBTaWduIGEgbmV3IG1lcmdlZCByZXN1bHQuXG4gICAgY29uc3QgcHJldmlvdXNWYWxpZGF0aW9ucyA9IGF3YWl0IHRoaXMuZW5zdXJlRXhwYW5kZWQocHJldmlvdXMpO1xuICAgIGNvbnN0IG5leHRWYWxpZGF0aW9ucyA9IGF3YWl0IHRoaXMuZW5zdXJlRXhwYW5kZWQobmV4dCk7XG4gICAgLy8gV2UgY2FuIG9ubHkgdHJ1bHkgbWVyZ2UgaWYgd2UgYXJlIGFuIG93bmVyLlxuICAgIGNvbnN0IGhlYWRlciA9IHByZXZpb3VzVmFsaWRhdGlvbnNbMF0ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGxldCBvd25lciA9IGhlYWRlci5pc3MgfHwgaGVhZGVyLmtpZDtcbiAgICBsZXQgaXNPd25lciA9IFtDcmVkZW50aWFscy5vd25lciwgQ3JlZGVudGlhbHMuYXV0aG9yLCBhdXRob3JPdmVycmlkZV0uaW5jbHVkZXMob3duZXIpO1xuICAgIC8vIElmIHRoZXNlIGFyZSBub3QgdGhlIG93bmVyLCBhbmQgd2Ugd2VyZSBub3QgZ2l2ZW4gYSBzcGVjaWZpYyBvdmVycmlkZSwgdGhlbiBzZWUgaWYgdGhlIHVzZXIgaGFzIGFjY2VzcyB0byB0aGUgb3duZXIgaW4gdGhpcyBleGVjdXRpb24gY29udGV4dC5cbiAgICBsZXQgY2FuU2lnbiA9IGlzT3duZXIgfHwgKCFhdXRob3JPdmVycmlkZSAmJiBhd2FpdCBDcmVkZW50aWFscy5zaWduKCcnLCBvd25lcikuY2F0Y2goKCkgPT4gZmFsc2UpKTtcbiAgICBsZXQgbWVyZ2VkLCBvcHRpb25zLCB0aW1lID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBhdXRob3IgPSBhdXRob3JPdmVycmlkZSB8fCBDcmVkZW50aWFscy5hdXRob3I7XG4gICAgZnVuY3Rpb24gZmxhdHRlbihhLCBiKSB7IHJldHVybiBbXS5jb25jYXQoYSwgYik7IH1cbiAgICBpZiAoIWNhblNpZ24pIHsgLy8gV2UgZG9uJ3QgaGF2ZSBvd25lciBhbmQgY2Fubm90IGdldCBpdC5cbiAgICAgIC8vIENyZWF0ZSBhIHNwZWNpYWwgbm9uLXN0YW5kYXJkIFwic2lnbmF0dXJlXCIgdGhhdCBpcyByZWFsbHkgYW4gYXJyYXkgb2Ygc2lnbmF0dXJlc1xuICAgICAgZnVuY3Rpb24gZ2V0U2lnbmF0dXJlcyh2YWxpZGF0aW9ucykgeyByZXR1cm4gdmFsaWRhdGlvbnMubWFwKHZhbGlkYXRpb24gPT4gdmFsaWRhdGlvbi5zaWduYXR1cmUpOyB9XG4gICAgICBtZXJnZWQgPSBmbGF0dGVuKGdldFNpZ25hdHVyZXMocHJldmlvdXNWYWxpZGF0aW9ucyksIGdldFNpZ25hdHVyZXMobmV4dFZhbGlkYXRpb25zKSk7XG4gICAgICBvcHRpb25zID0ge3RhZ3M6IFthdXRob3JdLCB0aW1lfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZnVuY3Rpb24gZ2V0SlNPTnModmFsaWRhdGlvbnMpIHsgcmV0dXJuIHZhbGlkYXRpb25zLm1hcCh2YWxpZGF0aW9uID0+IHZhbGlkYXRpb24uanNvbik7IH1cbiAgICAgIGNvbnN0IGZsYXR0ZW5lZCA9IGZsYXR0ZW4oZ2V0SlNPTnMocHJldmlvdXNWYWxpZGF0aW9ucyksIGdldEpTT05zKG5leHRWYWxpZGF0aW9ucykpO1xuICAgICAgbWVyZ2VkID0gdGhpcy5jb21iaW5lVGltZXN0YW1wcyhuZXh0LnRhZywga2V5c09mTWlzc2luZywgLi4uZmxhdHRlbmVkKTtcbiAgICAgIG9wdGlvbnMgPSB7dGVhbTogb3duZXIsIG1lbWJlcjogYXV0aG9yLCB0aW1lfTtcbiAgICB9XG4gICAgLy8gZml4bWUgbmV4dFxuICAgIHJldHVybiBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24obWVyZ2VkLCBvcHRpb25zKTtcbiAgICAvL3JldHVybiBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmaWVkU2lnbihtZXJnZWQsIG9wdGlvbnMpO1xuICB9XG4gIGVuc3VyZUV4cGFuZGVkKHZhbGlkYXRpb24pIHsgLy8gUHJvbWlzZSBhbiBhcnJheSBvZiB2ZXJpZmljYXRpb25zICh2ZXJpZnlpbmcgZWxlbWVudHMgb2YgdmFsaWRhdGlvbi5qc29uIGlmIG5lZWRlZCkuXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbGlkYXRpb24uanNvbikpIHJldHVybiBbdmFsaWRhdGlvbl07XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHZhbGlkYXRpb24uanNvbi5tYXAoc2lnbmF0dXJlID0+IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSkpKTtcbiAgfVxuICBtaXNzaW5nS2V5cyhwcmV2aW91c01hcHBpbmcsIG5leHRNYXBwaW5ncykgeyAvLyBBbnN3ZXIgYSBsaXN0IG9mIHRob3NlIGtleXMgZnJvbSBwcmV2aW91cyB0aGF0IGRvIG5vdCBoYXZlIHZhbHVlcyBpbiBuZXh0LlxuICAgIGNvbnN0IG5leHRWYWx1ZXMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobmV4dE1hcHBpbmdzKSk7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHByZXZpb3VzTWFwcGluZykuZmlsdGVyKGtleSA9PiBrZXkgIT09ICdsYXRlc3QnICYmICFuZXh0VmFsdWVzLmhhcyhwcmV2aW91c01hcHBpbmdba2V5XSkpO1xuICB9XG4gIGNvbWJpbmVUaW1lc3RhbXBzKHRhZywga2V5c09mTWlzc2luZywgcHJldmlvdXNNYXBwaW5ncywgbmV4dE1hcHBpbmdzLCAuLi5yZXN0KSB7IC8vIFJldHVybiBhIG1lcmdlZCBkaWN0aW9uYXJ5IG9mIHRpbWVzdGFtcCA9PiBoYXNoLCBjb250YWluaW5nIGFsbCBvZiBwcmV2aW91cyBhbmQgbmV4dE1hcHBpbmdzLlxuICAgIC8vIFdlJ2xsIG5lZWQgYSBuZXcgb2JqZWN0IHRvIHN0b3JlIHRoZSB1bmlvbiwgYmVjYXVzZSB0aGUga2V5cyBtdXN0IGJlIGluIHRpbWUgb3JkZXIsIG5vdCB0aGUgb3JkZXIgdGhleSB3ZXJlIGFkZGVkLlxuICAgIGtleXNPZk1pc3NpbmcgfHw9IHRoaXMubWlzc2luZ0tleXMocHJldmlvdXNNYXBwaW5ncywgbmV4dE1hcHBpbmdzKTtcbiAgICBjb25zdCBtZXJnZWQgPSB7fTtcbiAgICBsZXQgbWlzc2luZ0luZGV4ID0gMCwgbWlzc2luZ1RpbWUsIG5leHRUaW1lcztcbiAgICBmb3IgKGNvbnN0IG5leHRUaW1lIGluIG5leHRNYXBwaW5ncykge1xuICAgICAgbWlzc2luZ1RpbWUgPSAwO1xuXG4gICAgICAvLyBNZXJnZSBhbnkgcmVtYWluaW5nIGtleXNPZk1pc3NpbmcgdGhhdCBjb21lIHN0cmljdGx5IGJlZm9yZSBuZXh0VGltZTpcbiAgICAgIGlmIChuZXh0VGltZSAhPT0gJ2xhdGVzdCcpIHtcblx0Zm9yICg7IChtaXNzaW5nSW5kZXggPCBrZXlzT2ZNaXNzaW5nLmxlbmd0aCkgJiYgKChtaXNzaW5nVGltZSA9IGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4XSkgPCBuZXh0VGltZSk7IG1pc3NpbmdJbmRleCsrKSB7XG5cdCAgbWVyZ2VkW21pc3NpbmdUaW1lXSA9IHByZXZpb3VzTWFwcGluZ3NbbWlzc2luZ1RpbWVdO1xuXHR9XG4gICAgICB9XG5cbiAgICAgIGlmIChtaXNzaW5nVGltZSA9PT0gbmV4dFRpbWUpIHsgLy8gVHdvIGRpZmZlcmVudCB2YWx1ZXMgYXQgdGhlIGV4YWN0IHNhbWUgdGltZS4gRXh0cmVtZWx5IHJhcmUuXG5cdGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgYFVudXN1YWwgbWF0Y2hpbmcgdGltZXN0YW1wIGNhc2UgYXQgdGltZSAke21pc3NpbmdUaW1lfSBmb3IgdGFnICR7dGFnfS5gKTtcblx0bmV4dFRpbWVzIHx8PSBPYmplY3Qua2V5cyhuZXh0TWFwcGluZ3MpOyAvLyBXZSBkaWRuJ3QgbmVlZCB0aGlzIGZvciBvdXIgbG9vcC4gR2VuZXJhdGUgbm93IGlmIG5lZWRlZC5cblx0Y29uc3QgbmV4dE5leHRUaW1lID0gTWF0aC5taW4oa2V5c09mTWlzc2luZ1ttaXNzaW5nSW5kZXggKyAxXSB8fCBJbmZpbml0eSxcblx0XHRcdFx0ICAgICAgbmV4dE1hcHBpbmdzW25leHRUaW1lcy5pbmRleE9mKG5leHRUaW1lKSArIDFdIHx8IEluZmluaXR5KTtcblx0Y29uc3QgaW5zZXJ0VGltZSA9IG5leHRUaW1lICsgKG5leHROZXh0VGltZSAtIG5leHRUaW1lKSAvIDI7XG5cdC8vIFdlIGFscmVhZHkgcHV0IHRoZXNlIGluIG9yZGVyIHdpdGggcHJldmlvdXNNYXBwaW5ncyBmaXJzdC5cblx0bWVyZ2VkW25leHRUaW1lXSA9IHByZXZpb3VzTWFwcGluZ3NbbmV4dFRpbWVdO1xuXHRtZXJnZWRbaW5zZXJ0VGltZV0gPSBuZXh0TWFwcGluZ3NbbmV4dFRpbWVdO1xuXG4gICAgICB9IGVsc2UgeyAvLyBObyBjb25mbGljdHMuIEp1c3QgYWRkIG5leHQuXG5cdG1lcmdlZFtuZXh0VGltZV0gPSBuZXh0TWFwcGluZ3NbbmV4dFRpbWVdO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRoZXJlIGNhbiBiZSBtaXNzaW5nIHN0dWZmIHRvIGFkZCBhdCB0aGUgZW5kO1xuICAgIGZvciAoOyBtaXNzaW5nSW5kZXggPCBrZXlzT2ZNaXNzaW5nLmxlbmd0aDsgbWlzc2luZ0luZGV4KyspIHtcbiAgICAgIG1pc3NpbmdUaW1lID0ga2V5c09mTWlzc2luZ1ttaXNzaW5nSW5kZXhdO1xuICAgICAgbWVyZ2VkW21pc3NpbmdUaW1lXSA9IHByZXZpb3VzTWFwcGluZ3NbbWlzc2luZ1RpbWVdO1xuICAgIH1cbiAgICBsZXQgbWVyZ2VkVGltZXMgPSBPYmplY3Qua2V5cyhtZXJnZWQpO1xuICAgIG1lcmdlZC5sYXRlc3QgPSBtZXJnZWRUaW1lc1ttZXJnZWRUaW1lcy5sZW5ndGggLSAxXTtcbiAgICByZXR1cm4gcmVzdC5sZW5ndGggPyB0aGlzLmNvbWJpbmVUaW1lc3RhbXBzKHRhZywgdW5kZWZpbmVkLCBtZXJnZWQsIC4uLnJlc3QpIDogbWVyZ2VkO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zID0ge30pIHsgLy8gQW4gYXJyYXkgb2YgdW5tZXJnZWQgc2lnbmF0dXJlcyBjYW4gYmUgdmVyaWZpZWQuXG4gICAgaWYgKHNpZ25hdHVyZS5zdGFydHNXaXRoPy4oJ1snKSkgc2lnbmF0dXJlID0gSlNPTi5wYXJzZShzaWduYXR1cmUpOyAvLyAobWF5YmVJbmZsYXRlIGxvb2tzIGZvciAneycsIG5vdCAnWycuKVxuICAgIGlmICghQXJyYXkuaXNBcnJheShzaWduYXR1cmUpKSByZXR1cm4gYXdhaXQgc3VwZXIudmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyk7XG4gICAgY29uc3QgY29tYmluZWQgPSBhd2FpdCBQcm9taXNlLmFsbChzaWduYXR1cmUubWFwKGVsZW1lbnQgPT4gdGhpcy52ZXJpZnkoZWxlbWVudCwgb3B0aW9ucykpKTtcbiAgICBjb25zdCBvayA9IGNvbWJpbmVkLmV2ZXJ5KGVsZW1lbnQgPT4gZWxlbWVudCk7XG4gICAgaWYgKCFvaykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBjb25zdCBwcm90ZWN0ZWRIZWFkZXIgPSBjb21iaW5lZFswXS5wcm90ZWN0ZWRIZWFkZXI7XG4gICAgZm9yIChjb25zdCBwcm9wZXJ0eSBvZiBbJ2lzcycsICdraWQnLCAnYWxnJywgJ2N0eSddKSB7IC8vIE91ciBvcGVyYXRpb25zIG1ha2UgdXNlIG9mIGlzcywga2lkLCBhbmQgaWF0LlxuICAgICAgY29uc3QgbWF0Y2hpbmcgPSBwcm90ZWN0ZWRIZWFkZXJbcHJvcGVydHldO1xuICAgICAgY29uc3QgbWF0Y2hlcyA9IGNvbWJpbmVkLmV2ZXJ5KGVsZW1lbnQgPT4gZWxlbWVudC5wcm90ZWN0ZWRIZWFkZXJbcHJvcGVydHldID09PSBtYXRjaGluZyk7XG4gICAgICBpZiAobWF0Y2hlcykgY29udGludWU7XG4gICAgICBpZiAoIW1hdGNoZXMpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGNvbnN0IHtpc3MsIGtpZCwgYWxnLCBjdHl9ID0gcHJvdGVjdGVkSGVhZGVyO1xuICAgIGNvbnN0IHZlcmlmaWVkID0ge1xuICAgICAgc2lnbmF0dXJlLCAvLyBhcnJheSBhdCB0aGlzIHBvaW50XG4gICAgICBqc29uOiBjb21iaW5lZC5tYXAoZWxlbWVudCA9PiBlbGVtZW50Lmpzb24pLFxuICAgICAgcHJvdGVjdGVkSGVhZGVyOiB7aXNzLCBraWQsIGFsZywgY3R5LCBpYXQ6IE1hdGgubWF4KC4uLmNvbWJpbmVkLm1hcChlbGVtZW50ID0+IGVsZW1lbnQucHJvdGVjdGVkSGVhZGVyLmlhdCkpfVxuICAgIH07XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIGJhY2tkYXRpbmcgaXMgYWxsb3dlZC4gKG1lcmdpbmcpLlxuICAgIGlmICghcHJvcG9zZWQpIHJldHVybiAnaW52YWxpZCBzaWduYXR1cmUnO1xuICAgIGlmICghZXhpc3RpbmcpIHJldHVybiBudWxsO1xuICAgIGlmICghdGhpcy5vd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkpIHJldHVybiAnbm90IG93bmVyJztcbiAgICBpZiAoIWF3YWl0IHRoaXMuc3ViamVjdE1hdGNoKHZlcmlmaWVkKSkgcmV0dXJuICd3cm9uZyBoYXNoJztcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBvd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkgeyAvLyBUT0RPOiBFaXRoZXIgdGhleSBtdXN0IG1hdGNoIChhcyBpbiBzdXBlcikgb3IgdGhlIG5ldyBwYXlsb2FkIG11c3QgaW5jbHVkZSB0aGUgcHJldmlvdXMuXG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuXG4vLyBXaGVuIHJ1bm5pbmcgaW4gTm9kZUpTLCB0aGUgU2VjdXJpdHkgb2JqZWN0IGlzIGF2YWlsYWJsZSBkaXJlY3RseS5cbi8vIEl0IGhhcyBhIFN0b3JhZ2UgcHJvcGVydHksIHdoaWNoIGRlZmluZXMgc3RvcmUvcmV0cmlldmUgKGluIGxpYi9zdG9yYWdlLm1qcykgdG8gR0VUL1BVVCBvblxuLy8gLi4uLzpmdWxsTGFiZWwvOnBhcnQxb2ZUYWcvOnBhcnQyb2ZUYWcvOnBhcnQzb2ZUYWcvOnJlc3RPZlRhZy5qc29uXG4vLyBUaGUgU2VjdXJpdHkuU3RvcmFnZSBjYW4gYmUgc2V0IGJ5IGNsaWVudHMgdG8gc29tZXRoaW5nIGVsc2UuXG4vL1xuLy8gV2hlbiBydW5uaW5nIGluIGEgYnJvd3Nlciwgd29ya2VyLmpzIG92ZXJyaWRlcyB0aGlzIHRvIHNlbmQgbWVzc2FnZXMgdGhyb3VnaCB0aGUgSlNPTiBSUENcbi8vIHRvIHRoZSBhcHAsIHdoaWNoIHRoZW4gYWxzbyBoYXMgYW4gb3ZlcnJpZGFibGUgU2VjdXJpdHkuU3RvcmFnZSB0aGF0IGlzIGltcGxlbWVudGVkIHdpdGggdGhlIHNhbWUgY29kZSBhcyBhYm92ZS5cblxuLy8gQmFzaCBpbiBzb21lIG5ldyBzdHVmZjpcbkNyZWRlbnRpYWxzLmF1dGhvciA9IG51bGw7XG5DcmVkZW50aWFscy5vd25lciA9IG51bGw7XG5DcmVkZW50aWFscy5lbmNyeXB0aW9uID0gbnVsbDsgLy8gVE9ETzogcmVuYW1lIHRoaXMgdG8gYXVkaWVuY2VcbkNyZWRlbnRpYWxzLnN5bmNocm9uaXplID0gYXN5bmMgKC4uLnNlcnZpY2VzKSA9PiB7IC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGNvbm5lY3QuXG4gIC8vIFdlIGNhbiBkbyBhbGwgdGhyZWUgaW4gcGFyYWxsZWwgLS0gd2l0aG91dCB3YWl0aW5nIGZvciBjb21wbGV0aW9uIC0tIGJlY2F1c2UgZGVwZW5kZW5jaWVzIHdpbGwgZ2V0IHNvcnRlZCBvdXQgYnkgc3luY2hyb25pemUxLlxuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykpKTtcbn07XG5DcmVkZW50aWFscy5zeW5jaHJvbml6ZWQgPSBhc3luYyAoKSA9PiB7XG4gIHJldHVybiBQcm9taXNlLmFsbChPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKS5tYXAoY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnN5bmNocm9uaXplZCkpO1xufVxuQ3JlZGVudGlhbHMuZGlzY29ubmVjdCA9IGFzeW5jICguLi5zZXJ2aWNlcykgPT4ge1xuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5kaXNjb25uZWN0KC4uLnNlcnZpY2VzKSkpO1xufVxuXG5DcmVkZW50aWFscy5jcmVhdGVBdXRob3IgPSBhc3luYyAocHJvbXB0KSA9PiB7IC8vIENyZWF0ZSBhIHVzZXI6XG4gIC8vIElmIHByb21wdCBpcyAnLScsIGNyZWF0ZXMgYW4gaW52aXRhdGlvbiBhY2NvdW50LCB3aXRoIGEgbm8tb3AgcmVjb3ZlcnkgYW5kIG5vIGRldmljZS5cbiAgLy8gT3RoZXJ3aXNlLCBwcm9tcHQgaW5kaWNhdGVzIHRoZSByZWNvdmVyeSBwcm9tcHRzLCBhbmQgdGhlIGFjY291bnQgaGFzIHRoYXQgYW5kIGEgZGV2aWNlLlxuICBpZiAocHJvbXB0ID09PSAnLScpIHJldHVybiBDcmVkZW50aWFscy5jcmVhdGUoYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHR9KSk7XG4gIGNvbnN0IFtsb2NhbCwgcmVjb3ZlcnldID0gYXdhaXQgUHJvbWlzZS5hbGwoW0NyZWRlbnRpYWxzLmNyZWF0ZSgpLCBDcmVkZW50aWFscy5jcmVhdGUoe3Byb21wdH0pXSk7XG4gIHJldHVybiBDcmVkZW50aWFscy5jcmVhdGUobG9jYWwsIHJlY292ZXJ5KTtcbn07XG5DcmVkZW50aWFscy5jbGFpbUludml0YXRpb24gPSBhc3luYyAodGFnLCBuZXdQcm9tcHQpID0+IHsgLy8gQ3JlYXRlcyBhIGxvY2FsIGRldmljZSB0YWcgYW5kIGFkZHMgaXQgdG8gdGhlIGdpdmVuIGludml0YXRpb24gdGFnLFxuICAvLyB1c2luZyB0aGUgc2VsZi12YWxpZGF0aW5nIHJlY292ZXJ5IG1lbWJlciB0aGF0IGlzIHRoZW4gcmVtb3ZlZCBhbmQgZGVzdHJveWVkLlxuICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zLlRlYW0ucmV0cmlldmUoe3RhZ30pO1xuICBpZiAoIXZlcmlmaWVkKSB0aHJvdyBuZXcgRXJyb3IoYFVuYWJsZSB0byB2ZXJpZnkgaW52aXRhdGlvbiAke3RhZ30uYCk7XG4gIGNvbnN0IG1lbWJlcnMgPSB2ZXJpZmllZC5qc29uLnJlY2lwaWVudHM7XG4gIGlmIChtZW1iZXJzLmxlbmd0aCAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKGBJbnZpdGF0aW9ucyBzaG91bGQgaGF2ZSBvbmUgbWVtYmVyOiAke3RhZ31gKTtcbiAgY29uc3Qgb2xkUmVjb3ZlcnlUYWcgPSBtZW1iZXJzWzBdLmhlYWRlci5raWQ7XG4gIGNvbnN0IG5ld1JlY292ZXJ5VGFnID0gYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHQ6IG5ld1Byb21wdH0pO1xuICBjb25zdCBkZXZpY2VUYWcgPSBhd2FpdCBDcmVkZW50aWFscy5jcmVhdGUoKTtcblxuICAvLyBXZSBuZWVkIHRvIGFkZCB0aGUgbmV3IG1lbWJlcnMgaW4gb25lIGNoYW5nZU1lbWJlcnNoaXAgc3RlcCwgYW5kIHRoZW4gcmVtb3ZlIHRoZSBvbGRSZWNvdmVyeVRhZyBpbiBhIHNlY29uZCBjYWxsIHRvIGNoYW5nZU1lbWJlcnNoaXA6XG4gIC8vIGNoYW5nZU1lbWJlcnNoaXAgd2lsbCBzaWduIGJ5IGFuIE9MRCBtZW1iZXIgLSBJZiBpdCBzaWduZWQgYnkgbmV3IG1lbWJlciB0aGFuIHBlb3BsZSBjb3VsZCBib290c3RyYXAgdGhlbXNlbHZlcyBvbnRvIGEgdGVhbS5cbiAgLy8gQnV0IGlmIHdlIHJlbW92ZSB0aGUgb2xkUmVjb3ZlcnkgdGFnIGluIHRoZSBzYW1lIHN0ZXAgYXMgYWRkaW5nIHRoZSBuZXcsIHRoZSB0ZWFtIHdvdWxkIGJlIHNpZ25lZCBieSBzb21lb25lICh0aGUgb2xkUmVjb3ZlcnlUYWcpIHRoYXRcbiAgLy8gaXMgbm8gbG9uZ2VyIGEgbWVtYmVyLCBhbmQgc28gdGhlIHRlYW0gd291bGQgbm90IHZlcmlmeSFcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2hhbmdlTWVtYmVyc2hpcCh7dGFnLCBhZGQ6IFtkZXZpY2VUYWcsIG5ld1JlY292ZXJ5VGFnXSwgcmVtb3ZlOiBbb2xkUmVjb3ZlcnlUYWddfSk7XG4gIGF3YWl0IENyZWRlbnRpYWxzLmNoYW5nZU1lbWJlcnNoaXAoe3RhZywgcmVtb3ZlOiBbb2xkUmVjb3ZlcnlUYWddfSk7XG4gIGF3YWl0IENyZWRlbnRpYWxzLmRlc3Ryb3kob2xkUmVjb3ZlcnlUYWcpO1xuICByZXR1cm4gdGFnO1xufTtcbmNvbnN0IGFuc3dlcnMgPSB7fTsgLy8gVE9ETzogbWFrZSBzZXRBbnN3ZXIgaW5jbHVkZSB0YWcgYXMgd2VsbCBhcyBwcm9tcHQuXG5DcmVkZW50aWFscy5zZXRBbnN3ZXIgPSAocHJvbXB0LCBhbnN3ZXIpID0+IGFuc3dlcnNbcHJvbXB0XSA9IGFuc3dlcjtcbkNyZWRlbnRpYWxzLmdldFVzZXJEZXZpY2VTZWNyZXQgPSBmdW5jdGlvbiBmbGV4c3RvcmVTZWNyZXQodGFnLCBwcm9tcHRTdHJpbmcpIHtcbiAgaWYgKCFwcm9tcHRTdHJpbmcpIHJldHVybiB0YWc7XG4gIGlmIChwcm9tcHRTdHJpbmcgPT09ICctJykgcmV0dXJuIHByb21wdFN0cmluZzsgLy8gU2VlIGNyZWF0ZUF1dGhvci5cbiAgaWYgKGFuc3dlcnNbcHJvbXB0U3RyaW5nXSkgcmV0dXJuIGFuc3dlcnNbcHJvbXB0U3RyaW5nXTtcbiAgLy8gRGlzdHJpYnV0ZWQgU2VjdXJpdHkgd2lsbCB0cnkgZXZlcnl0aGluZy4gVW5sZXNzIGdvaW5nIHRocm91Z2ggYSBwYXRoIGFib3ZlLCB3ZSB3b3VsZCBsaWtlIG90aGVycyB0byBzaWxlbnRseSBmYWlsLlxuICBjb25zb2xlLmxvZyhgQXR0ZW1wdGluZyBhY2Nlc3MgJHt0YWd9IHdpdGggcHJvbXB0ICcke3Byb21wdFN0cmluZ30nLmApO1xuICByZXR1cm4gXCJub3QgYSBzZWNyZXRcIjsgLy8gdG9kbzogY3J5cHRvIHJhbmRvbVxufTtcblxuXG4vLyBUaGVzZSB0d28gYXJlIHVzZWQgZGlyZWN0bHkgYnkgZGlzdHJpYnV0ZWQtc2VjdXJpdHkuXG5DcmVkZW50aWFscy5TdG9yYWdlLnJldHJpZXZlID0gYXN5bmMgKGNvbGxlY3Rpb25OYW1lLCB0YWcpID0+IHtcbiAgY29uc3QgY29sbGVjdGlvbiA9IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW2NvbGxlY3Rpb25OYW1lXTtcbiAgLy8gTm8gbmVlZCB0byB2ZXJpZnksIGFzIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGRvZXMgdGhhdCBpdHNlbGYgcXVpdGUgY2FyZWZ1bGx5IGFuZCB0ZWFtLWF3YXJlLlxuICBpZiAoY29sbGVjdGlvbk5hbWUgPT09ICdFbmNyeXB0aW9uS2V5JykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTtcbiAgaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnS2V5UmVjb3ZlcnknKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpO1xuICAvL2lmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ1RlYW0nKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpOyAgICAvLyBUaGlzIHdvdWxkIGdvIGNpcmN1bGFyLiBTaG91bGQgaXQ/IERvIHdlIG5lZWQgaXQ/XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBjb2xsZWN0aW9uLmdldCh0YWcpO1xuICAvLyBIb3dldmVyLCBzaW5jZSB3ZSBoYXZlIGJ5cGFzc2VkIENvbGxlY3Rpb24ucmV0cmlldmUsIHdlIG1heWJlSW5mbGF0ZSBoZXJlLlxuICByZXR1cm4gQ29sbGVjdGlvbi5tYXliZUluZmxhdGUoZGF0YSk7XG59XG5jb25zdCBFTVBUWV9TVFJJTkdfSEFTSCA9IFwiNDdERVFwajhIQlNhLV9USW1XLTVKQ2V1UWVSa201Tk1wSldaRzNoU3VGVVwiOyAvLyBIYXNoIG9mIGFuIGVtcHR5IHN0cmluZy5cbkNyZWRlbnRpYWxzLlN0b3JhZ2Uuc3RvcmUgPSBhc3luYyAoY29sbGVjdGlvbk5hbWUsIHRhZywgc2lnbmF0dXJlKSA9PiB7XG4gIC8vIE5vIG5lZWQgdG8gZW5jcnlwdC9zaWduIGFzIGJ5IHN0b3JlLCBzaW5jZSBkaXN0cmlidXRlZC1zZWN1cml0eSBkb2VzIHRoYXQgaW4gYSBjaXJjdWxhcml0eS1hd2FyZSB3YXkuXG4gIC8vIEhvd2V2ZXIsIHdlIGRvIGN1cnJlbnRseSBuZWVkIHRvIGZpbmQgb3V0IG9mIHRoZSBzaWduYXR1cmUgaGFzIGEgcGF5bG9hZCBhbmQgcHVzaFxuICAvLyBUT0RPOiBNb2RpZnkgZGlzdC1zZWMgdG8gaGF2ZSBhIHNlcGFyYXRlIHN0b3JlL2RlbGV0ZSwgcmF0aGVyIHRoYW4gaGF2aW5nIHRvIGZpZ3VyZSB0aGlzIG91dCBoZXJlLlxuICBjb25zdCBjbGFpbXMgPSBDcmVkZW50aWFscy5kZWNvZGVDbGFpbXMoc2lnbmF0dXJlKTtcbiAgY29uc3QgZW1wdHlQYXlsb2FkID0gY2xhaW1zPy5zdWIgPT09IEVNUFRZX1NUUklOR19IQVNIO1xuXG4gIGNvbnN0IGNvbGxlY3Rpb24gPSBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tjb2xsZWN0aW9uTmFtZV07XG4gIHNpZ25hdHVyZSA9IENvbGxlY3Rpb24uZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gIGNvbnN0IHN0b3JlZCA9IGF3YWl0IChlbXB0eVBheWxvYWQgPyBjb2xsZWN0aW9uLmRlbGV0ZSh0YWcsIHNpZ25hdHVyZSkgOiBjb2xsZWN0aW9uLnB1dCh0YWcsIHNpZ25hdHVyZSkpO1xuICBpZiAoc3RvcmVkICE9PSB0YWcpIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIHdyaXRlIGNyZWRlbnRpYWwgJHt0YWd9LmApO1xuICBpZiAodGFnKSBhd2FpdCBjb2xsZWN0aW9uLnB1c2goZW1wdHlQYXlsb2FkID8gJ2RlbGV0ZSc6ICdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gIHJldHVybiB0YWc7XG59O1xuQ3JlZGVudGlhbHMuU3RvcmFnZS5kZXN0cm95ID0gYXN5bmMgKCkgPT4ge1xuICBhd2FpdCBDcmVkZW50aWFscy5jbGVhcigpOyAvLyBXaXBlIGZyb20gbGl2ZSBtZW1vcnkuXG4gIGZvciAobGV0IGNvbGxlY3Rpb24gb2YgT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykpIHtcbiAgICBhd2FpdCBjb2xsZWN0aW9uLmRlc3Ryb3koKTtcbiAgfVxuICBhd2FpdCBDcmVkZW50aWFscy53aXBlRGV2aWNlS2V5cygpOyAvLyBOb3QgaW5jbHVkZWQgaW4gdGhlIGFib3ZlLlxufTtcbkNyZWRlbnRpYWxzLmNvbGxlY3Rpb25zID0ge307XG5leHBvcnQgeyBDcmVkZW50aWFscywgU3RvcmFnZUxvY2FsIH07XG5bJ0VuY3J5cHRpb25LZXknLCAnS2V5UmVjb3ZlcnknLCAnVGVhbSddLmZvckVhY2gobmFtZSA9PiBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tuYW1lXSA9IG5ldyBNdXRhYmxlQ29sbGVjdGlvbih7bmFtZX0pKTtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB1dWlkNCBmcm9tICd1dWlkNCc7XG5pbXBvcnQgU3luY2hyb25pemVyIGZyb20gJy4vbGliL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIFZlcnNpb25lZENvbGxlY3Rpb24sIFZlcnNpb25Db2xsZWN0aW9uLCBTdG9yYWdlTG9jYWwgfSBmcm9tICAnLi9saWIvY29sbGVjdGlvbnMubWpzJztcbmltcG9ydCB7IFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDIH0gZnJvbSAnLi9saWIvd2VicnRjLm1qcyc7XG5pbXBvcnQgeyB2ZXJzaW9uLCBuYW1lLCBzdG9yYWdlVmVyc2lvbiwgc3RvcmFnZU5hbWUgfSBmcm9tICcuL2xpYi92ZXJzaW9uLm1qcyc7XG5cbmNvbnNvbGUubG9nKGAke25hbWV9ICR7dmVyc2lvbn0gZnJvbSAke2ltcG9ydC5tZXRhLnVybH0uYCk7XG5cbmV4cG9ydCB7IENyZWRlbnRpYWxzLCBDb2xsZWN0aW9uLCBJbW11dGFibGVDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgVmVyc2lvbkNvbGxlY3Rpb24sIFN5bmNocm9uaXplciwgV2ViUlRDLCBQcm9taXNlV2ViUlRDLCBTaGFyZWRXZWJSVEMsIG5hbWUsIHZlcnNpb24sIHN0b3JhZ2VOYW1lLCBzdG9yYWdlVmVyc2lvbiwgU3RvcmFnZUxvY2FsLCB1dWlkNCB9O1xuZXhwb3J0IGRlZmF1bHQgeyBDcmVkZW50aWFscywgQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIFZlcnNpb25lZENvbGxlY3Rpb24sIFZlcnNpb25Db2xsZWN0aW9uLCBTeW5jaHJvbml6ZXIsIFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDLCBuYW1lLCB2ZXJzaW9uLCAgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBTdG9yYWdlTG9jYWwsIHV1aWQ0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QUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLElBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsVUFBVSxFQUFFLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDLElBQUksTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEdBQUUsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBQyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxTQUFTLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLE1BQU0sWUFBWSxTQUFTLFdBQVcsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksTUFBTSxDQUFDLENBQUMsRUFBRSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBQyxDQUFDLE1BQU0sWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFNLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9B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
