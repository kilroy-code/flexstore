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
    this.log('got data-channel', source, key, channel.readyState, 'existing:', existing, 'waiting:', waiting);
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
// As of 7/6/25, current evergreen browsers work with 1000 base, but Firefox fails in our case (10 negotatiated channels)
// if any ids are 256 or higher.
const BASE_CHANNEL_ID = 125;
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
var version$1 = "0.0.71";
var _package = {
	name: name$1,
	version: version$1};

// name/version of "database"
const storageName = 'flexstore';
const storageVersion = 14;
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
  static version = storageVersion;
  constructor({serviceName = 'direct', collection, error = collection?.constructor.error || console.error,
	       serviceLabel = collection?.serviceLabel || serviceName, // Used to identify any existing connection. Can be different from serviceName during testing.
	       channelName, uuid = collection?.uuid, rtcConfiguration, connection, // Complex default behavior for these. See code.
	       multiplex = collection?.multiplex, // If specifed, otherwise undefined at this point. See below.
	       debug = collection?.debug, maxVersion = Synchronizer.version, minVersion = maxVersion}) {
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
    } else if (this.connectionURL.includes('/sync')) { // Connect with a server relay. (Signal and stay connected through sync.)
      started = this.connectServer();
    } else if (this.connectionURL.includes('/signal/answer')) { // Seeking an answer to an offer we POST (to rendevous with a peer).
      started = this.connectServer(); // Just like a sync
    } else if (this.connectionURL.includes('/signal/offer')) { // GET an offer from a rendevous peer and then POST an answer.
      // We must sychronously startConnection now so that our connection hasStartedConnecting, and any subsequent data channel
      // requests on the same connection will wait (using the 'started' path, above).
      // Compare connectServer, which is basically:
      //   startConnection(), fetch with that offer, completeConnection with fetched answer.
      const promisedSignals = this.startConnection([]); // Establishing order.
      const url = this.connectionURL;
      const offer = await this.fetch(url);
      this.completeConnection(offer); // Now supply those signals so that our connection can produce answer sigals.
      const answer = await promisedSignals;
      started = this.fetch(url, answer); // POST our answer to peer.
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
    // break up long messages. (As a practical matter, 16 KiB is the longest that can reliably be sent across different wrtc implementations.)
    // See https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels#concerns_with_large_messages
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
    // the connection and has sent an initial offer/ice. In this case, startConnect() promises a response
    // to be delivered to the other side.
    //   Otherwise, startConnect() promises a list of initial signal messages to be delivered to the other side,
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

    const method = body ? 'POST' : 'GET';
    this.log('fetch', method, url, 'sending:', body);
    const result = await this.constructor.fetchJSON(url, body, method)
	  .catch(error => {
	    this.closed.reject(error);
	  });
    this.log('fetch', method, url, 'result:', result);
    return result;
  }
  async connectServer(url = this.connectionURL) { // Connect to a relay over http. (/sync or /signal/answer)
    // startConnection, POST our signals, completeConnection with the response.
    // Our webrtc synchronizer is then connected to the relay's webrt synchronizer.
    const ourSignalsPromise = this.startConnection(); // must be synchronous to preserve channel id order.
    const ourSignals = await ourSignalsPromise;
    const theirSignals = await this.fetch(url, ourSignals); // POST
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
    const message = `${this.serviceName} requires a version between ${min} and ${max}, while we require ${this.minVersion} to ${this.maxVersion}.`;
    // TODO: Find promise that we can reject, that the app can catch and tell the user.
    console.log(message);
    setTimeout(() => this.disconnect(), 500); // Give the two sides time to agree. Yuck.
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
    await this.version;
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
    if (!this.unsynchronized) return true; // We have fully synchronized all tags. If there is new data, it will be spontaneously pushed to us.
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
	  if (theirData?.length) {
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

// TODO?: Should verfied/validated be its own object with methods?

class Collection extends EventTarget {

  constructor({name, label = name, services = [], preserveDeletions = !!services.length,
	       persistenceClass = StorageCache, dbVersion = storageVersion, persistenceBase = `${storageName}_${dbVersion}`,
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

  async maybeRestrict(callback) {
    // If this collection restricts usable tags for testing, then do so around execution of callback.
    if (this.restrictedTags) {
      let oldHook = Credentials.getUserDeviceSecret;
      try {
	Credentials.getUserDeviceSecret = (tag, promptString) => {
	  if (!this.restrictedTags.has(tag)) return 'bogus';
	  return oldHook(tag, promptString);
	};
	await Credentials.clear();
	return await callback();
      } finally {
	Credentials.getUserDeviceSecret = oldHook;
	await Credentials.clear();
      }
    }
    return await callback();
  }
  async withRestrictedTags(allowed, callback) {
    let restriction = this.restrictedTags;
    try {
      this.restrictedTags = allowed && new Set(allowed);
      return await callback();
    } finally {
      this.restrictedTags = restriction;
    }
  }
  ensureDecrypted(verified) {
    return this.maybeRestrict(() => this.constructor.ensureDecrypted(verified));
  }
  async preprocessForSigning(data, options) {
    // Promise [data, options] that have  been canonicalized and maybe revised for encryption.
    // Separated out from sign() so that subclasses can modify further.
    const {encryption, ...signingOptions} = this._canonicalizeOptions(options);
    if (encryption) {
      data = await Credentials.encrypt(data, encryption);
      signingOptions.contentType = this.constructor.encryptedMimeType;
    }
    return [data, {encryption, ...signingOptions}];
  }
  async sign(data, options = {}) {
    this.log('sign', data, options);
    [data, options] = await this.preprocessForSigning(data, options);
    this.log('sign after preprocessForSigning', data, options);
    return await this.maybeRestrict(() => this.constructor.sign(data, options));
  }
  verify(...rest) {
    return this.constructor.verify(...rest);
  }

  async undeletedTags() {
    // Our own separate, on-demand accounting of persistenceStore list():
    //   - persistenceStore list() could potentially be expensive
    //   - It will contain soft-deleted item tombstones (signed empty payloads).
    // It starts with a list() to get anything persisted in a previous session, and adds/removes as we store/remove.
    const tags = new Set();
    const store = await this.persistenceStore;
    if (!store) return tags;
    const allTags = await store.list();
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
  _canonicalizeOptions1(tagOrOptions = {}) { // Allow tagOrOptions to be just a tag string directly, or a named options object.
    return (typeof(tagOrOptions) === 'string') ? {tag:tagOrOptions} : tagOrOptions;
  }
  _canonicalizeOptions(objectOrString = {}) { // Extend _canonicalizeOptions1 to support:
    // - distribute-security style 'team' and 'member' can be called in flexstore style 'owner' and 'author', respectively
    // - encryption can be spefied as true, or the string 'team', or 'owner', resulting in the team tag being used for encryption
    // - owner and author default (if not specified in either style) to Credentials.owner and Credentials.author, respectively.
    // - encryption defaults to Credentails.encryption, else null (explicitly).
    // - time defaults to now.
    // Idempotent, so that it can be used by both collection.sign and collection.store (which uses sign).
    let {owner, team = owner ?? Credentials.owner,
	 tags = [],
	 author, member = author ?? tags[0] ?? Credentials.author,
	 encryption = Credentials.encryption ?? null,
	 time = Date.now(),
	 ...rest} = this._canonicalizeOptions1(objectOrString);
    if ([true, 'team', 'owner'].includes(encryption)) encryption = team || member;
    if (team === member || !team) { // Clean up tags for no separate team.
      if (!tags.includes(member)) tags.push(member);
      member = undefined;
      team = '';
    }
    return {time, team, member, encryption, tags, ...rest};
  }
  fail(operation, data, author) {
    throw new Error(`${author} does not have the authority to ${operation} ${this.fullName} ${JSON.stringify(data)}.`);
  }
  async store(data, options = {}, synchronizer = null) {
    // encrypt if needed
    // sign
    // put <== Also where we enter if pushed from a connection
    //    validateForWriting
    //       exit if improper
    //       emit update event
    //    mergeSignatures
    //    persist locally
    // push (live to any connections except the one we received from)
    // No need to await synchronization.
    let {tag, ...signingOptions} = this._canonicalizeOptions(options);
    const signature = await this.sign(data, signingOptions);
    tag = await this.put(tag, signature, synchronizer);
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
    const signature = await this.sign(data, {subject: tag, encryption: '', ...signingOptions});
    tag = await this.delete(tag, signature);
    if (!tag) return this.fail('remove', data, signingOptions.member || signingOptions.tags[0]);
    await this.push('delete', tag, signature);
    return tag;
  }
  async retrieve(tagOrOptions) { // getVerified and maybe decrypt. Has more complex behavior in subclass VersionedCollection.
    const {tag, decrypt = true, ...options} = this._canonicalizeOptions1(tagOrOptions);
    const verified = await this.getVerified({tag, ...options});
    if (!verified) return '';
    if (decrypt) return await this.ensureDecrypted(verified);
    return verified;
  }
  async getVerified(tagOrOptions) { // synchronize, get, and verify (but without decrypt)
    const {tag, synchronize = true, ...verifyOptions} = this._canonicalizeOptions1(tagOrOptions);
    if (synchronize) await this.synchronize1(tag);
    const signature = await this.get(tag);
    if (!signature) return signature;
    const verified = await this.constructor.verify(signature, verifyOptions);
    if (verified) verified.tag = tag; // Carry with it the tag by which it was found.
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

    const merged = await this.mergeSignatures(tag, validation, signature);
    await this.persist(validation.tag, merged);
    return validation.tag; // Don't rely on the returned value of persistenceStore.put.
  }
  async delete(tag, signature, synchronizer = null) { // Remove the raw signature locally and on the specified services.
    const validation = await this.validateForWriting(tag, signature, 'remove', synchronizer, 'requireTag');
    this.log('delete', tag, synchronizer?.label, 'validated tag:', validation?.tag, 'preserveDeletions:', this.preserveDeletions);
    if (!validation) return undefined;
    await this.deleteTag(tag);
    if (this.preserveDeletions) { // Signature payload is empty.
      await this.persist(validation.tag, signature);
    } else { // Really delete.
      await this.persist(validation.tag, signature, 'delete');
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
    if (boolean) this.log('wrong', label, reason);
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
  mergeSignatures(tag, validation, signature) { // Return a string to be persisted. Usually just the signature.
    return signature;  // validation.string might be an object.
  }
  async persist(tag, signatureString, operation = 'put') { // Conduct the specified tag/signature operation on the persistent store.
    this.log('persist', tag, operation, signatureString);
    return (await this.persistenceStore)[operation](tag, signatureString);
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

class MutableCollection extends Collection {
  async checkTag(verified) { // Mutable tag could be anything.
    return null;
  }
  checkDate(existing, proposed) { // fail if backdated.
    return this.checkSomething('backdated', !proposed.iat ||
			       ((proposed.iat === existing.iat) ? this.fairOrderedAuthor(existing, proposed) :  (proposed.iat < existing.iat)),
			       'date');
  }
}

class ImmutableCollection extends Collection {
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

class StateCollection extends ImmutableCollection {
  // A property named message may be included in the data, which tell the application how to rebuild states in a different order for merging.
  // A option named antecedent may be provided that identifies the preceding state (before the message was applied).

  async preprocessForSigning(data, {subject, ...options}) {
    // We are usually given an overall VersionedCollection subject, which we need in the signature header so that update events can see it.
    // If not specified (e.g., tag could be ommitted in first version), then generate it here, after super has maybe encrypted.
    [data, options] = await super.preprocessForSigning(data, options);
    if (!subject) {
      if (ArrayBuffer.isView(data)) subject = await this.hash({payload: data});
      else if (typeof(data) === 'string') subject = await this.hash({text: data});
      else subject = await this.hash({text: JSON.stringify(data)});
    }
    return [data, {subject, ...options}];
  }
  hashablePayload(validation) { // Include ant || iat.
    const payload = super.hashablePayload(validation);
    const {protectedHeader} = validation;
    if (!protectedHeader) return payload; // When used for subject hash() in preprocessForSigning().
    const {ant, iat} = validation.protectedHeader;
    this.log('hashing', {payload, ant, iat});
    return payload + (ant || iat || '');
  }
  async checkTag(verified) {
    const tag = verified.tag;
    const hash = await this.hash(verified);
    return this.checkSomething('wrong state tag', tag !== hash, 'state tag');
  }
  checkDate() { // always ok
    return null;
  }
  getOwner(protectedHeader) { // Return the tag of what shall be considered the owner.
    const {group, individual} = protectedHeader;
    return group || individual || super.getOwner(protectedHeader);
  }
  antecedent(validation) {
    if (validation.text === '') return validation.tag; // Delete compares with what's there
    return validation.protectedHeader.ant;
  }
  // fixme: remove() ?
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
      return verified.tag;
    };
    const isCandidateInEveryHistory = async () => { // True IFF the current candidateTag appear in all the others.
      for (const otherIndex in othersSeen) { // Subtle: the following has side-effects, so calls must be in series.
	if (!await isCandidateInHistory(othersSeen[otherIndex], otherIndex)) return false;
      }
      return true;
    };
    const isCandidateInHistory = async (otherSeen, otherIndex) => { // True IFF the current candidate is in the given State's history.
      // However, if candidate/other are in a linear chain, answer false and reset the loop with other spliced out.
      while (!otherSeen.has(candidateTag)) { // Fast check of what we've seen so far.
	const otherTag = otherStateTags[otherIndex]; // As we go, we record the data seen for this other State.
	if (!otherTag) return false;                         // If not at end... go one further level deeper in this state.
	const seenVerifiedStates = otherVerifiedStates[otherIndex];   // Note in our hash => message map, a copy of the verifiedStates seen.
	otherSeen.set(otherTag, seenVerifiedStates.slice());  // And add this state's message for our message accumulator.
	const verifiedState = await this.getVerified({tag: otherTag, member: null, synchronize: false});
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

    while (candidateTag) {
      if (await isCandidateInEveryHistory()) { // We found a match in each of the other States: prepare results.
	// Get the verifiedStates that we accumulated for that particular State within the others.
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

class VersionedCollection extends MutableCollection {
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
    const versionTag = await this.versions.store(data, {encryption, ant: root, subject: tag, ...options});
    this.log('store: root', {tag, encryption, options, root, versionTag});
    if (!versionTag) return '';
    const signingOptions = {
      tag: tag || (await this.versions.getVerified({tag: versionTag, member: null})).protectedHeader.sub,
      encryption: '',
      ...options
    };
    return super.store([versionTag], signingOptions);
  }
  async remove(tagOrOptions) {
    const {tag, encryption, ...options} = this._canonicalizeOptions1(tagOrOptions);
    await this.forEachState(tag, (_, hash) => { // Subtle: don't return early by returning truthy.
      // This may be overkill to be using high-level remove, instead of put or even persist. We DO want the update event to fire!
      // Subtle: the ant is needed so that we don't silently skip the actual put/event.
      // Subtle: subject is needed so that update events can learn the Versioned stag.
      this.versions.remove({tag: hash, ant: hash, subject: tag, encryption: '', ...options});
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
  // If a non-owner is given a state that is not a subset of the existing (or vice versa), then it creates a new
  // combined record that lists the given and existing states. In this case, we still need to preserve the
  // original owner so that later mergers can whether or not they are owners. (If they lie, the true group owners
  // will ignore the garbage data, so it's not security issue.) It doesn't help to get the owner by following
  // the tag through to the state's signature, because in some cases, non-members may be allowed to inject
  // a message into the group, in which case the state won't be signed by the group either. Our solution is
  // to introduce new tags to label the original owner. We need two tags because we also to know whether the
  // original owner was a group or an individual.
  getOwner(protectedHeader) { // Used in checkOwner.
    const {group, individual} = protectedHeader;
    return group || individual || super.getOwner(protectedHeader);
  }
  generateOwnerOptions(protectedHeader) { // Generate two sets of signing options: one for owner to use, and one for others
    // The special header claims 'group' and 'individual' are chosen to not interfere with _canonicalizeOptions.
    const {group, individual, iss, kid} = protectedHeader;
    const tags = [Credentials.author];
    if (group)      return [{team: group},                  {tags, group}];
    if (individual) return [{team: '', member: individual}, {tags, individual}];        // check before iss
    if (iss)        return [{team: iss},                    {tags, group: iss}];
    else            return [{team: '', member: kid},        {tags, individual: kid}];
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

    const [asOwner, asOther] = this.generateOwnerOptions(validation.protectedHeader);
    if (!await this.sign('anything', asOwner).catch(() => false)) { // We don't have access.
      return await this.sign(combined, {encryption: '', ...asOther}); // Just answer the combined list to be persisted.
    }
    // Get the state verifications to replay.
    if (!ancestor) versionsToReplay = await Promise.all(combined.map(async stateTag => this.versions.getVerified({tag: stateTag, synchronize: false})));
    versionsToReplay.sort((a, b) => a.protectedHeader.iat - b.protectedHeader.iat);

    await this.beginReplay(ancestor);
    for (let verified of versionsToReplay) {
      await this.ensureDecrypted(verified); // commonStates does not (cannot) decrypt.
      const replayResult = await this.replay(ancestor, verified);
      if (verified === replayResult) { // Already good.
	ancestor = verified.tag;
      } else { // Record replayResult into a new state against the antecedent, preserving group, iat, encryption.
	const {encryption = '', iat:time} = verified.protectedHeader;
	const signingOptions = {ant:ancestor, time, encryption, subject:tag, ...asOwner};
	// Passing synchronizer prevents us from recirculating to the peer that told us.
	// TODO: Is that what we want, and is it sufficient in a network of multiple relays?
	const next/*ancestor*/ = await this.versions.store(replayResult, signingOptions, verified.synchronizer);
	this.log({ancestor, verified, replayResult, signingOptions, next});
	ancestor = next;
      }
    }
    return await this.sign([ancestor], {tag, ...asOwner, encryption: ''});
  }

  // Two hooks for subclasses to override.
  beginReplay(antecedentTag) {
  }
  replay(antecedentTag, verified) {
    if (antecedentTag === verified.ant) return verified; // Returning the === verified indicates it can be reused directly.
    return verified.json || verified.text || verified.payload; // Highest form we've got.
  }

  async getRoot(tag, synchronize = true) { // Promise the tag of the most recent state
    const verifiedVersion = await this.getVerified({tag, member: null, synchronize});
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
// It has a Storage property, which defines store/retrieve (in lib/storage.mjs) to GET/PUT.
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

Credentials.teamMembers = async (tag, recursive = false) => { // List the member tags of this team.
  const team = await Credentials.collections.Team.retrieve({tag, member: null});
  const members = team.json?.recipients.map(m => m.header.kid) || [];
  if (!recursive) return members;
  return [tag].concat(...await Promise.all(members.map(tag => Credentials.teamMembers(tag, true))));
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
  const members = await Credentials.teamMembers(tag);
  if (members.length !== 1) throw new Error(`Invitations should have one member: ${tag}`);
  const oldRecoveryTag = members[0];
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
var index = { Credentials, Collection, MutableCollection, ImmutableCollection, StateCollection, VersionedCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version,  storageName, storageVersion, StorageLocal: StorageCache, uuid4 };

export { Collection, ImmutableCollection, MutableCollection, PromiseWebRTC, SharedWebRTC, StateCollection, StorageCache as StorageLocal, Synchronizer, VersionedCollection, WebRTC, index as default, name, storageName, storageVersion, uuid4, version };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vQGtpMXIweS9zdG9yYWdlL2J1bmRsZS5tanMiLCJsaWIvY29sbGVjdGlvbnMubWpzIiwiaW5kZXgubWpzIl0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHV1aWRQYXR0ZXJuID0gL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pO1xuZnVuY3Rpb24gdmFsaWQodXVpZCkge1xuICByZXR1cm4gdXVpZFBhdHRlcm4udGVzdCh1dWlkKTtcbn1cblxuLy8gQmFzZWQgb24gaHR0cHM6Ly9hYmhpc2hla2R1dHRhLm9yZy9ibG9nL3N0YW5kYWxvbmVfdXVpZF9nZW5lcmF0b3JfaW5famF2YXNjcmlwdC5odG1sXG4vLyBJRTExIGFuZCBNb2Rlcm4gQnJvd3NlcnMgT25seVxuZnVuY3Rpb24gdXVpZDQoKSB7XG4gIHZhciB0ZW1wX3VybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwobmV3IEJsb2IoKSk7XG4gIHZhciB1dWlkID0gdGVtcF91cmwudG9TdHJpbmcoKTtcbiAgVVJMLnJldm9rZU9iamVjdFVSTCh0ZW1wX3VybCk7XG4gIHJldHVybiB1dWlkLnNwbGl0KC9bOlxcL10vZykucG9wKCkudG9Mb3dlckNhc2UoKTsgLy8gcmVtb3ZlIHByZWZpeGVzXG59XG51dWlkNC52YWxpZCA9IHZhbGlkO1xuXG5leHBvcnQgZGVmYXVsdCB1dWlkNDtcbmV4cG9ydCB7IHV1aWQ0LCB2YWxpZCB9O1xuIiwiLy8gSW4gYSBicm93c2VyLCB3cnRjIHByb3BlcnRpZXMgc3VjaCBhcyBSVENQZWVyQ29ubmVjdGlvbiBhcmUgaW4gZ2xvYmFsVGhpcy5cbmV4cG9ydCBkZWZhdWx0IGdsb2JhbFRoaXM7XG4iLCJpbXBvcnQgdXVpZDQgZnJvbSAndXVpZDQnO1xuXG4vLyBTZWUgcm9sbHVwLmNvbmZpZy5tanNcbmltcG9ydCB3cnRjIGZyb20gJyN3cnRjJztcbi8vY29uc3Qge2RlZmF1bHQ6d3J0Y30gPSBhd2FpdCAoKHR5cGVvZihwcm9jZXNzKSAhPT0gJ3VuZGVmaW5lZCcpID8gaW1wb3J0KCdAcm9hbWhxL3dydGMnKSA6IHtkZWZhdWx0OiBnbG9iYWxUaGlzfSk7XG5cbmNvbnN0IGljZVNlcnZlcnMgPSBbXG4gIHsgdXJsczogJ3N0dW46c3R1bi5sLmdvb2dsZS5jb206MTkzMDInfSxcbiAgLy8gaHR0cHM6Ly9mcmVlc3R1bi5uZXQvICBDdXJyZW50bHkgNTAgS0JpdC9zLiAoMi41IE1CaXQvcyBmb3JzICQ5L21vbnRoKVxuICB7IHVybHM6ICdzdHVuOmZyZWVzdHVuLm5ldDozNDc4JyB9LFxuICAvL3sgdXJsczogJ3R1cm46ZnJlZXN0dW4ubmV0OjM0NzgnLCB1c2VybmFtZTogJ2ZyZWUnLCBjcmVkZW50aWFsOiAnZnJlZScgfSxcbiAgLy8gUHJlc3VtYWJseSB0cmFmZmljIGxpbWl0ZWQuIENhbiBnZW5lcmF0ZSBuZXcgY3JlZGVudGlhbHMgYXQgaHR0cHM6Ly9zcGVlZC5jbG91ZGZsYXJlLmNvbS90dXJuLWNyZWRzXG4gIC8vIEFsc28gaHR0cHM6Ly9kZXZlbG9wZXJzLmNsb3VkZmxhcmUuY29tL2NhbGxzLyAxIFRCL21vbnRoLCBhbmQgJDAuMDUgL0dCIGFmdGVyIHRoYXQuXG4gIHsgdXJsczogJ3R1cm46dHVybi5zcGVlZC5jbG91ZGZsYXJlLmNvbTo1MDAwMCcsIHVzZXJuYW1lOiAnODI2MjI2MjQ0Y2Q2ZTVlZGIzZjU1NzQ5Yjc5NjIzNWY0MjBmZTVlZTc4ODk1ZTBkZDdkMmJhYTQ1ZTFmN2E4ZjQ5ZTkyMzllNzg2OTFhYjM4YjcyY2UwMTY0NzFmNzc0NmY1Mjc3ZGNlZjg0YWQ3OWZjNjBmODAyMGIxMzJjNzMnLCBjcmVkZW50aWFsOiAnYWJhOWIxNjk1NDZlYjZkY2M3YmZiMWNkZjM0NTQ0Y2Y5NWI1MTYxZDYwMmUzYjVmYTdjODM0MmIyZTk4MDJmYicgfVxuICAvLyBodHRwczovL2Zhc3R0dXJuLm5ldC8gQ3VycmVudGx5IDUwME1CL21vbnRoPyAoMjUgR0IvbW9udGggZm9yICQ5L21vbnRoKVxuICAvLyBodHRwczovL3hpcnN5cy5jb20vcHJpY2luZy8gNTAwIE1CL21vbnRoICg1MCBHQi9tb250aCBmb3IgJDMzL21vbnRoKVxuICAvLyBBbHNvIGh0dHBzOi8vd3d3Lm5wbWpzLmNvbS9wYWNrYWdlL25vZGUtdHVybiBvciBodHRwczovL21lZXRyaXguaW8vYmxvZy93ZWJydGMvY290dXJuL2luc3RhbGxhdGlvbi5odG1sXG5dO1xuXG4vLyBVdGlsaXR5IHdyYXBwZXIgYXJvdW5kIFJUQ1BlZXJDb25uZWN0aW9uLlxuLy8gV2hlbiBzb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gKHN1Y2ggYXMgY3JlYXRlRGF0YUNoYW5uZWwpLCBpdCB3aWxsIGdlbmVyYXRlIGNhbGxzIHRvIHNpZ25hbCgpLCB3aGljaCBuZWVkcyB0byBiZSBkZWZpbmVkIGJ5IHN1YmNsYXNzZXMuXG5leHBvcnQgY2xhc3MgV2ViUlRDIHtcbiAgY29uc3RydWN0b3Ioe2xhYmVsID0gJycsIGNvbmZpZ3VyYXRpb24gPSBudWxsLCB1dWlkID0gdXVpZDQoKSwgZGVidWcgPSBmYWxzZSwgZXJyb3IgPSBjb25zb2xlLmVycm9yLCAuLi5yZXN0fSA9IHt9KSB7XG4gICAgY29uZmlndXJhdGlvbiA/Pz0ge2ljZVNlcnZlcnN9OyAvLyBJZiBjb25maWd1cmF0aW9uIGNhbiBiZSBvbW1pdHRlZCBvciBleHBsaWNpdGx5IGFzIG51bGwsIHVzZSBvdXIgZGVmYXVsdC4gQnV0IGlmIHt9LCBsZWF2ZSBpdCBiZS5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtsYWJlbCwgY29uZmlndXJhdGlvbiwgdXVpZCwgZGVidWcsIGVycm9yLCAuLi5yZXN0fSk7XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBzaWduYWwodHlwZSwgbWVzc2FnZSkgeyAvLyBTdWJjbGFzc2VzIG11c3Qgb3ZlcnJpZGUgb3IgZXh0ZW5kLiBEZWZhdWx0IGp1c3QgbG9ncy5cbiAgICB0aGlzLmxvZygnc2VuZGluZycsIHR5cGUsIHR5cGUubGVuZ3RoLCBKU09OLnN0cmluZ2lmeShtZXNzYWdlKS5sZW5ndGgpO1xuICB9XG5cbiAgcGVlclZlcnNpb24gPSAwO1xuICByZXNldFBlZXIoKSB7IC8vIFNldCB1cCBhIG5ldyBSVENQZWVyQ29ubmVjdGlvbi4gKENhbGxlciBtdXN0IGNsb3NlIG9sZCBpZiBuZWNlc3NhcnkuKVxuICAgIGNvbnN0IG9sZCA9IHRoaXMucGVlcjtcbiAgICBpZiAob2xkKSB7XG4gICAgICBvbGQub25uZWdvdGlhdGlvbm5lZWRlZCA9IG9sZC5vbmljZWNhbmRpZGF0ZSA9IG9sZC5vbmljZWNhbmRpZGF0ZWVycm9yID0gb2xkLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gbnVsbDtcbiAgICAgIC8vIERvbid0IGNsb3NlIHVubGVzcyBpdCdzIGJlZW4gb3BlbmVkLCBiZWNhdXNlIHRoZXJlIGFyZSBsaWtlbHkgaGFuZGxlcnMgdGhhdCB3ZSBkb24ndCB3YW50IHRvIGZpcmUuXG4gICAgICBpZiAob2xkLmNvbm5lY3Rpb25TdGF0ZSAhPT0gJ25ldycpIG9sZC5jbG9zZSgpO1xuICAgIH1cbiAgICBjb25zdCBwZWVyID0gdGhpcy5wZWVyID0gbmV3IHdydGMuUlRDUGVlckNvbm5lY3Rpb24odGhpcy5jb25maWd1cmF0aW9uKTtcbiAgICBwZWVyLnZlcnNpb25JZCA9IHRoaXMucGVlclZlcnNpb24rKztcbiAgICBwZWVyLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBldmVudCA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkKGV2ZW50KTtcbiAgICBwZWVyLm9uaWNlY2FuZGlkYXRlID0gZXZlbnQgPT4gdGhpcy5vbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KTtcbiAgICAvLyBJIGRvbid0IHRoaW5rIGFueW9uZSBhY3R1YWxseSBzaWduYWxzIHRoaXMuIEluc3RlYWQsIHRoZXkgcmVqZWN0IGZyb20gYWRkSWNlQ2FuZGlkYXRlLCB3aGljaCB3ZSBoYW5kbGUgdGhlIHNhbWUuXG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZWVycm9yID0gZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcik7XG4gICAgLy8gSSB0aGluayB0aGlzIGlzIHJlZHVuZG5hbnQgYmVjYXVzZSBubyBpbXBsZW1lbnRhdGlvbiBmaXJlcyB0aGlzIGV2ZW50IGFueSBzaWduaWZpY2FudCB0aW1lIGFoZWFkIG9mIGVtaXR0aW5nIGljZWNhbmRpZGF0ZSB3aXRoIGFuIGVtcHR5IGV2ZW50LmNhbmRpZGF0ZS5cbiAgICBwZWVyLm9uaWNlZ2F0aGVyaW5nc3RhdGVjaGFuZ2UgPSBldmVudCA9PiAocGVlci5pY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJykgJiYgdGhpcy5vbkxvY2FsRW5kSWNlO1xuICAgIHBlZXIub25jb25uZWN0aW9uc3RhdGVjaGFuZ2UgPSBldmVudCA9PiB0aGlzLmNvbm5lY3Rpb25TdGF0ZUNoYW5nZSh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlKTtcbiAgfVxuICBvbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KSB7XG4gICAgLy8gVGhlIHNwZWMgc2F5cyB0aGF0IGEgbnVsbCBjYW5kaWRhdGUgc2hvdWxkIG5vdCBiZSBzZW50LCBidXQgdGhhdCBhbiBlbXB0eSBzdHJpbmcgY2FuZGlkYXRlIHNob3VsZC4gU2FmYXJpICh1c2VkIHRvPykgZ2V0IGVycm9ycyBlaXRoZXIgd2F5LlxuICAgIGlmICghZXZlbnQuY2FuZGlkYXRlIHx8ICFldmVudC5jYW5kaWRhdGUuY2FuZGlkYXRlKSB0aGlzLm9uTG9jYWxFbmRJY2UoKTtcbiAgICBlbHNlIHRoaXMuc2lnbmFsKCdpY2VjYW5kaWRhdGUnLCBldmVudC5jYW5kaWRhdGUpO1xuICB9XG4gIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFRyaWdnZXJlZCBvbiBvdXIgc2lkZSBieSBhbnkvYWxsIG9mIG9uaWNlY2FuZGlkYXRlIHdpdGggbm8gZXZlbnQuY2FuZGlkYXRlLCBpY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJy5cbiAgICAvLyBJLmUuLCBjYW4gaGFwcGVuIG11bHRpcGxlIHRpbWVzLiBTdWJjbGFzc2VzIG1pZ2h0IGRvIHNvbWV0aGluZy5cbiAgfVxuICBjbG9zZSgpIHtcbiAgICBpZiAoKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICduZXcnKSAmJiAodGhpcy5wZWVyLnNpZ25hbGluZ1N0YXRlID09PSAnc3RhYmxlJykpIHJldHVybjtcbiAgICB0aGlzLnJlc2V0UGVlcigpO1xuICB9XG4gIGNvbm5lY3Rpb25TdGF0ZUNoYW5nZShzdGF0ZSkge1xuICAgIHRoaXMubG9nKCdzdGF0ZSBjaGFuZ2U6Jywgc3RhdGUpO1xuICAgIGlmIChbJ2Rpc2Nvbm5lY3RlZCcsICdmYWlsZWQnLCAnY2xvc2VkJ10uaW5jbHVkZXMoc3RhdGUpKSB0aGlzLmNsb3NlKCk7IC8vIE90aGVyIGJlaGF2aW9yIGFyZSByZWFzb25hYmxlLCB0b2xvLlxuICB9XG4gIG5lZ290aWF0aW9ubmVlZGVkKCkgeyAvLyBTb21ldGhpbmcgaGFzIGNoYW5nZWQgbG9jYWxseSAobmV3IHN0cmVhbSwgb3IgbmV0d29yayBjaGFuZ2UpLCBzdWNoIHRoYXQgd2UgaGF2ZSB0byBzdGFydCBuZWdvdGlhdGlvbi5cbiAgICB0aGlzLmxvZygnbmVnb3RpYXRpb25ubmVlZGVkJyk7XG4gICAgdGhpcy5wZWVyLmNyZWF0ZU9mZmVyKClcbiAgICAgIC50aGVuKG9mZmVyID0+IHtcbiAgICAgICAgdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24ob2ZmZXIpOyAvLyBwcm9taXNlIGRvZXMgbm90IHJlc29sdmUgdG8gb2ZmZXJcblx0cmV0dXJuIG9mZmVyO1xuICAgICAgfSlcbiAgICAgIC50aGVuKG9mZmVyID0+IHRoaXMuc2lnbmFsKCdvZmZlcicsIG9mZmVyKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkRXJyb3IoZXJyb3IpKTtcbiAgfVxuICBvZmZlcihvZmZlcikgeyAvLyBIYW5kbGVyIGZvciByZWNlaXZpbmcgYW4gb2ZmZXIgZnJvbSB0aGUgb3RoZXIgdXNlciAod2hvIHN0YXJ0ZWQgdGhlIHNpZ25hbGluZyBwcm9jZXNzKS5cbiAgICAvLyBOb3RlIHRoYXQgZHVyaW5nIHNpZ25hbGluZywgd2Ugd2lsbCByZWNlaXZlIG5lZ290aWF0aW9ubmVlZGVkL2Fuc3dlciwgb3Igb2ZmZXIsIGJ1dCBub3QgYm90aCwgZGVwZW5kaW5nXG4gICAgLy8gb24gd2hldGhlciB3ZSB3ZXJlIHRoZSBvbmUgdGhhdCBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2Vzcy5cbiAgICB0aGlzLnBlZXIuc2V0UmVtb3RlRGVzY3JpcHRpb24ob2ZmZXIpXG4gICAgICAudGhlbihfID0+IHRoaXMucGVlci5jcmVhdGVBbnN3ZXIoKSlcbiAgICAgIC50aGVuKGFuc3dlciA9PiB0aGlzLnBlZXIuc2V0TG9jYWxEZXNjcmlwdGlvbihhbnN3ZXIpKSAvLyBwcm9taXNlIGRvZXMgbm90IHJlc29sdmUgdG8gYW5zd2VyXG4gICAgICAudGhlbihfID0+IHRoaXMuc2lnbmFsKCdhbnN3ZXInLCB0aGlzLnBlZXIubG9jYWxEZXNjcmlwdGlvbikpO1xuICB9XG4gIGFuc3dlcihhbnN3ZXIpIHsgLy8gSGFuZGxlciBmb3IgZmluaXNoaW5nIHRoZSBzaWduYWxpbmcgcHJvY2VzcyB0aGF0IHdlIHN0YXJ0ZWQuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKGFuc3dlcik7XG4gIH1cbiAgaWNlY2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkgeyAvLyBIYW5kbGVyIGZvciBhIG5ldyBjYW5kaWRhdGUgcmVjZWl2ZWQgZnJvbSB0aGUgb3RoZXIgZW5kIHRocm91Z2ggc2lnbmFsaW5nLlxuICAgIHRoaXMucGVlci5hZGRJY2VDYW5kaWRhdGUoaWNlQ2FuZGlkYXRlKS5jYXRjaChlcnJvciA9PiB0aGlzLmljZWNhbmRpZGF0ZUVycm9yKGVycm9yKSk7XG4gIH1cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAodGhpcy5kZWJ1ZykgY29uc29sZS5sb2codGhpcy5sYWJlbCwgdGhpcy5wZWVyLnZlcnNpb25JZCwgLi4ucmVzdCk7XG4gIH1cbiAgbG9nRXJyb3IobGFiZWwsIGV2ZW50T3JFeGNlcHRpb24pIHtcbiAgICBjb25zdCBkYXRhID0gW3RoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnRoaXMuY29uc3RydWN0b3IuZ2F0aGVyRXJyb3JEYXRhKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKV07XG4gICAgdGhpcy5lcnJvcihkYXRhKTtcbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuICBzdGF0aWMgZXJyb3IoZXJyb3IpIHtcbiAgfVxuICBzdGF0aWMgZ2F0aGVyRXJyb3JEYXRhKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIGxhYmVsICsgXCIgZXJyb3I6XCIsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLmNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvckNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXMgfHwgXCJcIiwgLy8gRmlyc3QgaXMgZGVwcmVjYXRlZCwgYnV0IHN0aWxsIHVzZWZ1bC5cbiAgICAgIGV2ZW50T3JFeGNlcHRpb24udXJsIHx8IGV2ZW50T3JFeGNlcHRpb24ubmFtZSB8fCAnJyxcbiAgICAgIGV2ZW50T3JFeGNlcHRpb24ubWVzc2FnZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yVGV4dCB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1c1RleHQgfHwgZXZlbnRPckV4Y2VwdGlvblxuICAgIF07XG4gIH1cbiAgaWNlY2FuZGlkYXRlRXJyb3IoZXZlbnRPckV4Y2VwdGlvbikgeyAvLyBGb3IgZXJyb3JzIG9uIHRoaXMgcGVlciBkdXJpbmcgZ2F0aGVyaW5nLlxuICAgIC8vIENhbiBiZSBvdmVycmlkZGVuIG9yIGV4dGVuZGVkIGJ5IGFwcGxpY2F0aW9ucy5cblxuICAgIC8vIFNUVU4gZXJyb3JzIGFyZSBpbiB0aGUgcmFuZ2UgMzAwLTY5OS4gU2VlIFJGQyA1Mzg5LCBzZWN0aW9uIDE1LjZcbiAgICAvLyBmb3IgYSBsaXN0IG9mIGNvZGVzLiBUVVJOIGFkZHMgYSBmZXcgbW9yZSBlcnJvciBjb2Rlczsgc2VlXG4gICAgLy8gUkZDIDU3NjYsIHNlY3Rpb24gMTUgZm9yIGRldGFpbHMuXG4gICAgLy8gU2VydmVyIGNvdWxkIG5vdCBiZSByZWFjaGVkIGFyZSBpbiB0aGUgcmFuZ2UgNzAwLTc5OS5cbiAgICBjb25zdCBjb2RlID0gZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzO1xuICAgIC8vIENocm9tZSBnaXZlcyA3MDEgZXJyb3JzIGZvciBzb21lIHR1cm4gc2VydmVycyB0aGF0IGl0IGRvZXMgbm90IGdpdmUgZm9yIG90aGVyIHR1cm4gc2VydmVycy5cbiAgICAvLyBUaGlzIGlzbid0IGdvb2QsIGJ1dCBpdCdzIHdheSB0b28gbm9pc3kgdG8gc2xvZyB0aHJvdWdoIHN1Y2ggZXJyb3JzLCBhbmQgSSBkb24ndCBrbm93IGhvdyB0byBmaXggb3VyIHR1cm4gY29uZmlndXJhdGlvbi5cbiAgICBpZiAoY29kZSA9PT0gNzAxKSByZXR1cm47XG4gICAgdGhpcy5sb2dFcnJvcignaWNlJywgZXZlbnRPckV4Y2VwdGlvbik7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFByb21pc2VXZWJSVEMgZXh0ZW5kcyBXZWJSVEMge1xuICAvLyBFeHRlbmRzIFdlYlJUQy5zaWduYWwoKSBzdWNoIHRoYXQ6XG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyBhbnN3ZXJzIGEgcHJvbWlzZSB0aGF0IHdpbGwgcmVzb2x2ZSB3aXRoIGFuIGFycmF5IG9mIHNpZ25hbCBtZXNzYWdlcy5cbiAgLy8gLSBpbnN0YW5jZS5zaWduYWxzID0gWy4uLnNpZ25hbE1lc3NhZ2VzXSB3aWxsIGRpc3BhdGNoIHRob3NlIG1lc3NhZ2VzLlxuICAvL1xuICAvLyBGb3IgZXhhbXBsZSwgc3VwcG9zZSBwZWVyMSBhbmQgcGVlcjIgYXJlIGluc3RhbmNlcyBvZiB0aGlzLlxuICAvLyAwLiBTb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gb24gcGVlcjEgKHN1Y2ggYXMgY2FsbGluZyBwZWVyMS5jcmVhdGVEYXRhQ2hhbm5lbCgpKS4gXG4gIC8vIDEuIHBlZXIxLnNpZ25hbHMgcmVzb2x2ZXMgd2l0aCA8c2lnbmFsMT4sIGEgUE9KTyB0byBiZSBjb252ZXllZCB0byBwZWVyMi5cbiAgLy8gMi4gU2V0IHBlZXIyLnNpZ25hbHMgPSA8c2lnbmFsMT4uXG4gIC8vIDMuIHBlZXIyLnNpZ25hbHMgcmVzb2x2ZXMgd2l0aCA8c2lnbmFsMj4sIGEgUE9KTyB0byBiZSBjb252ZXllZCB0byBwZWVyMS5cbiAgLy8gNC4gU2V0IHBlZXIxLnNpZ25hbHMgPSA8c2lnbmFsMj4uXG4gIC8vIDUuIERhdGEgZmxvd3MsIGJ1dCBlYWNoIHNpZGUgd2hvdWxkIGdyYWIgYSBuZXcgc2lnbmFscyBwcm9taXNlIGFuZCBiZSBwcmVwYXJlZCB0byBhY3QgaWYgaXQgcmVzb2x2ZXMuXG4gIC8vXG4gIGNvbnN0cnVjdG9yKHtpY2VUaW1lb3V0ID0gMmUzLCAuLi5wcm9wZXJ0aWVzfSkge1xuICAgIHN1cGVyKHByb3BlcnRpZXMpO1xuICAgIHRoaXMuaWNlVGltZW91dCA9IGljZVRpbWVvdXQ7XG4gIH1cbiAgZ2V0IHNpZ25hbHMoKSB7IC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZSB0byB0aGUgc2lnbmFsIG1lc3NhZ2luZyB3aGVuIGljZSBjYW5kaWRhdGUgZ2F0aGVyaW5nIGlzIGNvbXBsZXRlLlxuICAgIHJldHVybiB0aGlzLl9zaWduYWxQcm9taXNlIHx8PSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB0aGlzLl9zaWduYWxSZWFkeSA9IHtyZXNvbHZlLCByZWplY3R9KTtcbiAgfVxuICBzZXQgc2lnbmFscyhkYXRhKSB7IC8vIFNldCB3aXRoIHRoZSBzaWduYWxzIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZC5cbiAgICBkYXRhLmZvckVhY2goKFt0eXBlLCBtZXNzYWdlXSkgPT4gdGhpc1t0eXBlXShtZXNzYWdlKSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIEVhY2ggd3J0YyBpbXBsZW1lbnRhdGlvbiBoYXMgaXRzIG93biBpZGVhcyBhcyB0byB3aGF0IGljZSBjYW5kaWRhdGVzIHRvIHRyeSBiZWZvcmUgZW1pdHRpbmcgdGhlbSBpbiBpY2VjYW5kZGlhdGUuXG4gICAgLy8gTW9zdCB3aWxsIHRyeSB0aGluZ3MgdGhhdCBjYW5ub3QgYmUgcmVhY2hlZCwgYW5kIGdpdmUgdXAgd2hlbiB0aGV5IGhpdCB0aGUgT1MgbmV0d29yayB0aW1lb3V0LiBGb3J0eSBzZWNvbmRzIGlzIGEgbG9uZyB0aW1lIHRvIHdhaXQuXG4gICAgLy8gSWYgdGhlIHdydGMgaXMgc3RpbGwgd2FpdGluZyBhZnRlciBvdXIgaWNlVGltZW91dCAoMiBzZWNvbmRzKSwgbGV0cyBqdXN0IGdvIHdpdGggd2hhdCB3ZSBoYXZlLlxuICAgIHRoaXMudGltZXIgfHw9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5vbkxvY2FsRW5kSWNlKCksIHRoaXMuaWNlVGltZW91dCk7XG4gICAgc3VwZXIub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gIH1cbiAgY2xlYXJJY2VUaW1lcigpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7XG4gICAgdGhpcy50aW1lciA9IG51bGw7XG4gIH1cbiAgYXN5bmMgb25Mb2NhbEVuZEljZSgpIHsgLy8gUmVzb2x2ZSB0aGUgcHJvbWlzZSB3aXRoIHdoYXQgd2UndmUgYmVlbiBnYXRoZXJpbmcuXG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgaWYgKCF0aGlzLl9zaWduYWxQcm9taXNlKSB7XG4gICAgICAvL3RoaXMubG9nRXJyb3IoJ2ljZScsIFwiRW5kIG9mIElDRSB3aXRob3V0IGFueXRoaW5nIHdhaXRpbmcgb24gc2lnbmFscy5cIik7IC8vIE5vdCBoZWxwZnVsIHdoZW4gdGhlcmUgYXJlIHRocmVlIHdheXMgdG8gcmVjZWl2ZSB0aGlzIG1lc3NhZ2UuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3NpZ25hbFJlYWR5LnJlc29sdmUodGhpcy5zZW5kaW5nKTtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgfVxuICBzZW5kaW5nID0gW107XG4gIHNpZ25hbCh0eXBlLCBtZXNzYWdlKSB7XG4gICAgc3VwZXIuc2lnbmFsKHR5cGUsIG1lc3NhZ2UpO1xuICAgIHRoaXMuc2VuZGluZy5wdXNoKFt0eXBlLCBtZXNzYWdlXSk7XG4gIH1cbiAgLy8gV2UgbmVlZCB0byBrbm93IGlmIHRoZXJlIGFyZSBvcGVuIGRhdGEgY2hhbm5lbHMuIFRoZXJlIGlzIGEgcHJvcG9zYWwgYW5kIGV2ZW4gYW4gYWNjZXB0ZWQgUFIgZm9yIFJUQ1BlZXJDb25uZWN0aW9uLmdldERhdGFDaGFubmVscygpLFxuICAvLyBodHRwczovL2dpdGh1Yi5jb20vdzNjL3dlYnJ0Yy1leHRlbnNpb25zL2lzc3Vlcy8xMTBcbiAgLy8gYnV0IGl0IGhhc24ndCBiZWVuIGRlcGxveWVkIGV2ZXJ5d2hlcmUgeWV0LiBTbyB3ZSdsbCBuZWVkIHRvIGtlZXAgb3VyIG93biBjb3VudC5cbiAgLy8gQWxhcywgYSBjb3VudCBpc24ndCBlbm91Z2gsIGJlY2F1c2Ugd2UgY2FuIG9wZW4gc3R1ZmYsIGFuZCB0aGUgb3RoZXIgc2lkZSBjYW4gb3BlbiBzdHVmZiwgYnV0IGlmIGl0IGhhcHBlbnMgdG8gYmVcbiAgLy8gdGhlIHNhbWUgXCJuZWdvdGlhdGVkXCIgaWQsIGl0IGlzbid0IHJlYWxseSBhIGRpZmZlcmVudCBjaGFubmVsLiAoaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL1JUQ1BlZXJDb25uZWN0aW9uL2RhdGFjaGFubmVsX2V2ZW50XG4gIGRhdGFDaGFubmVscyA9IG5ldyBNYXAoKTtcbiAgcmVwb3J0Q2hhbm5lbHMoKSB7IC8vIFJldHVybiBhIHJlcG9ydCBzdHJpbmcgdXNlZnVsIGZvciBkZWJ1Z2dpbmcuXG4gICAgY29uc3QgZW50cmllcyA9IEFycmF5LmZyb20odGhpcy5kYXRhQ2hhbm5lbHMuZW50cmllcygpKTtcbiAgICBjb25zdCBrdiA9IGVudHJpZXMubWFwKChbaywgdl0pID0+IGAke2t9OiR7di5pZH1gKTtcbiAgICByZXR1cm4gYCR7dGhpcy5kYXRhQ2hhbm5lbHMuc2l6ZX0vJHtrdi5qb2luKCcsICcpfWA7XG4gIH1cbiAgbm90ZUNoYW5uZWwoY2hhbm5lbCwgc291cmNlLCB3YWl0aW5nKSB7IC8vIEJvb2trZWVwIG9wZW4gY2hhbm5lbCBhbmQgcmV0dXJuIGl0LlxuICAgIC8vIEVtcGVyaWNhbGx5LCB3aXRoIG11bHRpcGxleCBmYWxzZTogLy8gICAxOCBvY2N1cnJlbmNlcywgd2l0aCBpZD1udWxsfDB8MSBhcyBmb3IgZXZlbnRjaGFubmVsIG9yIGNyZWF0ZURhdGFDaGFubmVsXG4gICAgLy8gICBBcHBhcmVudGx5LCB3aXRob3V0IG5lZ290aWF0aW9uLCBpZCBpcyBpbml0aWFsbHkgbnVsbCAocmVnYXJkbGVzcyBvZiBvcHRpb25zLmlkKSwgYW5kIHRoZW4gYXNzaWduZWQgdG8gYSBmcmVlIHZhbHVlIGR1cmluZyBvcGVuaW5nXG4gICAgY29uc3Qga2V5ID0gY2hhbm5lbC5sYWJlbDsgLy9maXhtZSBjaGFubmVsLmlkID09PSBudWxsID8gMSA6IGNoYW5uZWwuaWQ7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmRhdGFDaGFubmVscy5nZXQoa2V5KTtcbiAgICB0aGlzLmxvZygnZ290IGRhdGEtY2hhbm5lbCcsIHNvdXJjZSwga2V5LCBjaGFubmVsLnJlYWR5U3RhdGUsICdleGlzdGluZzonLCBleGlzdGluZywgJ3dhaXRpbmc6Jywgd2FpdGluZyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbHMuc2V0KGtleSwgY2hhbm5lbCk7XG4gICAgY2hhbm5lbC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsIGV2ZW50ID0+IHsgLy8gQ2xvc2Ugd2hvbGUgY29ubmVjdGlvbiB3aGVuIG5vIG1vcmUgZGF0YSBjaGFubmVscyBvciBzdHJlYW1zLlxuICAgICAgdGhpcy5kYXRhQ2hhbm5lbHMuZGVsZXRlKGtleSk7XG4gICAgICAvLyBJZiB0aGVyZSdzIG5vdGhpbmcgb3BlbiwgY2xvc2UgdGhlIGNvbm5lY3Rpb24uXG4gICAgICBpZiAodGhpcy5kYXRhQ2hhbm5lbHMuc2l6ZSkgcmV0dXJuO1xuICAgICAgaWYgKHRoaXMucGVlci5nZXRTZW5kZXJzKCkubGVuZ3RoKSByZXR1cm47XG4gICAgICB0aGlzLmNsb3NlKCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIGNoYW5uZWw7XG4gIH1cbiAgY3JlYXRlRGF0YUNoYW5uZWwobGFiZWwgPSBcImRhdGFcIiwgY2hhbm5lbE9wdGlvbnMgPSB7fSkgeyAvLyBQcm9taXNlIHJlc29sdmVzIHdoZW4gdGhlIGNoYW5uZWwgaXMgb3BlbiAod2hpY2ggd2lsbCBiZSBhZnRlciBhbnkgbmVlZGVkIG5lZ290aWF0aW9uKS5cbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICB0aGlzLmxvZygnY3JlYXRlIGRhdGEtY2hhbm5lbCcsIGxhYmVsLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgICBsZXQgY2hhbm5lbCA9IHRoaXMucGVlci5jcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY2hhbm5lbE9wdGlvbnMpO1xuICAgICAgdGhpcy5ub3RlQ2hhbm5lbChjaGFubmVsLCAnZXhwbGljaXQnKTsgLy8gTm90ZWQgZXZlbiBiZWZvcmUgb3BlbmVkLlxuICAgICAgLy8gVGhlIGNoYW5uZWwgbWF5IGhhdmUgYWxyZWFkeSBiZWVuIG9wZW5lZCBvbiB0aGUgb3RoZXIgc2lkZS4gSW4gdGhpcyBjYXNlLCBhbGwgYnJvd3NlcnMgZmlyZSB0aGUgb3BlbiBldmVudCBhbnl3YXksXG4gICAgICAvLyBidXQgd3J0YyAoaS5lLiwgb24gbm9kZUpTKSBkb2VzIG5vdC4gU28gd2UgaGF2ZSB0byBleHBsaWNpdGx5IGNoZWNrLlxuICAgICAgc3dpdGNoIChjaGFubmVsLnJlYWR5U3RhdGUpIHtcbiAgICAgIGNhc2UgJ29wZW4nOlxuXHRzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoY2hhbm5lbCksIDEwKTtcblx0YnJlYWs7XG4gICAgICBjYXNlICdjb25uZWN0aW5nJzpcblx0Y2hhbm5lbC5vbm9wZW4gPSBfID0+IHJlc29sdmUoY2hhbm5lbCk7XG5cdGJyZWFrO1xuICAgICAgZGVmYXVsdDpcblx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHJlYWR5U3RhdGUgJHtjaGFubmVsLnJlYWR5U3RhdGV9IGZvciBkYXRhIGNoYW5uZWwgJHtsYWJlbH0uYCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgd2FpdGluZ0NoYW5uZWxzID0ge307XG4gIGdldERhdGFDaGFubmVsUHJvbWlzZShsYWJlbCA9IFwiZGF0YVwiKSB7IC8vIFJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdwcm9taXNlIGRhdGEtY2hhbm5lbCcsIGxhYmVsKTtcbiAgICAgIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXSA9IHJlc29sdmU7XG4gICAgfSk7XG4gIH1cbiAgcmVzZXRQZWVyKCkgeyAvLyBSZXNldCBhICdjb25uZWN0ZWQnIHByb3BlcnR5IHRoYXQgcHJvbWlzZWQgdG8gcmVzb2x2ZSB3aGVuIG9wZW5lZCwgYW5kIHRyYWNrIGluY29taW5nIGRhdGFjaGFubmVscy5cbiAgICBzdXBlci5yZXNldFBlZXIoKTtcbiAgICB0aGlzLmNvbm5lY3RlZCA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyAvLyB0aGlzLmNvbm5lY3RlZCBpcyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGFyZS5cbiAgICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdjb25uZWN0aW9uc3RhdGVjaGFuZ2UnLCBldmVudCA9PiB7XG5cdGlmICh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnY29ubmVjdGVkJykge1xuXHQgIHJlc29sdmUodHJ1ZSk7XG5cdH1cbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdkYXRhY2hhbm5lbCcsIGV2ZW50ID0+IHsgLy8gUmVzb2x2ZSBwcm9taXNlIG1hZGUgd2l0aCBnZXREYXRhQ2hhbm5lbFByb21pc2UoKS5cbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBldmVudC5jaGFubmVsO1xuICAgICAgY29uc3QgbGFiZWwgPSBjaGFubmVsLmxhYmVsO1xuICAgICAgY29uc3Qgd2FpdGluZyA9IHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHRoaXMubm90ZUNoYW5uZWwoY2hhbm5lbCwgJ2RhdGFjaGFubmVsIGV2ZW50Jywgd2FpdGluZyk7IC8vIFJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB3ZSBhcmUgd2FpdGluZy5cbiAgICAgIGlmICghd2FpdGluZykgcmV0dXJuOyAvLyBNaWdodCBub3QgYmUgZXhwbGljaXRseSB3YWl0aW5nLiBFLmcuLCByb3V0ZXJzLlxuICAgICAgZGVsZXRlIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHdhaXRpbmcoY2hhbm5lbCk7XG4gICAgfSk7XG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICdmYWlsZWQnKSB0aGlzLl9zaWduYWxQcm9taXNlPy5yZWplY3Q/LigpO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgdGhpcy5fc2lnbmFsUHJvbWlzZSA9IHRoaXMuX3NpZ25hbFJlYWR5ID0gbnVsbDtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgICAvLyBJZiB0aGUgd2VicnRjIGltcGxlbWVudGF0aW9uIGNsb3NlcyB0aGUgZGF0YSBjaGFubmVscyBiZWZvcmUgdGhlIHBlZXIgaXRzZWxmLCB0aGVuIHRoaXMuZGF0YUNoYW5uZWxzIHdpbGwgYmUgZW1wdHkuXG4gICAgLy8gQnV0IGlmIG5vdCAoZS5nLiwgc3RhdHVzICdmYWlsZWQnIG9yICdkaXNjb25uZWN0ZWQnIG9uIFNhZmFyaSksIHRoZW4gbGV0IHVzIGV4cGxpY2l0bHkgY2xvc2UgdGhlbSBzbyB0aGF0IFN5bmNocm9uaXplcnMga25vdyB0byBjbGVhbiB1cC5cbiAgICBmb3IgKGNvbnN0IGNoYW5uZWwgb2YgdGhpcy5kYXRhQ2hhbm5lbHMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgIT09ICdvcGVuJykgY29udGludWU7IC8vIEtlZXAgZGVidWdnaW5nIHNhbml0eS5cbiAgICAgIC8vIEl0IGFwcGVhcnMgdGhhdCBpbiBTYWZhcmkgKDE4LjUpIGZvciBhIGNhbGwgdG8gY2hhbm5lbC5jbG9zZSgpIHdpdGggdGhlIGNvbm5lY3Rpb24gYWxyZWFkeSBpbnRlcm5hbGwgY2xvc2VkLCBTYWZhcmlcbiAgICAgIC8vIHdpbGwgc2V0IGNoYW5uZWwucmVhZHlTdGF0ZSB0byAnY2xvc2luZycsIGJ1dCBOT1QgZmlyZSB0aGUgY2xvc2VkIG9yIGNsb3NpbmcgZXZlbnQuIFNvIHdlIGhhdmUgdG8gZGlzcGF0Y2ggaXQgb3Vyc2VsdmVzLlxuICAgICAgLy9jaGFubmVsLmNsb3NlKCk7XG4gICAgICBjaGFubmVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjbG9zZScpKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gTmVnb3RpYXRlZCBjaGFubmVscyB1c2Ugc3BlY2lmaWMgaW50ZWdlcnMgb24gYm90aCBzaWRlcywgc3RhcnRpbmcgd2l0aCB0aGlzIG51bWJlci5cbi8vIFdlIGRvIG5vdCBzdGFydCBhdCB6ZXJvIGJlY2F1c2UgdGhlIG5vbi1uZWdvdGlhdGVkIGNoYW5uZWxzIChhcyB1c2VkIG9uIHNlcnZlciByZWxheXMpIGdlbmVyYXRlIHRoZWlyXG4vLyBvd24gaWRzIHN0YXJ0aW5nIHdpdGggMCwgYW5kIHdlIGRvbid0IHdhbnQgdG8gY29uZmxpY3QuXG4vLyBUaGUgc3BlYyBzYXlzIHRoZXNlIGNhbiBnbyB0byA2NSw1MzQsIGJ1dCBJIGZpbmQgdGhhdCBzdGFydGluZyBncmVhdGVyIHRoYW4gdGhlIHZhbHVlIGhlcmUgZ2l2ZXMgZXJyb3JzLlxuLy8gQXMgb2YgNy82LzI1LCBjdXJyZW50IGV2ZXJncmVlbiBicm93c2VycyB3b3JrIHdpdGggMTAwMCBiYXNlLCBidXQgRmlyZWZveCBmYWlscyBpbiBvdXIgY2FzZSAoMTAgbmVnb3RhdGlhdGVkIGNoYW5uZWxzKVxuLy8gaWYgYW55IGlkcyBhcmUgMjU2IG9yIGhpZ2hlci5cbmNvbnN0IEJBU0VfQ0hBTk5FTF9JRCA9IDEyNTtcbmV4cG9ydCBjbGFzcyBTaGFyZWRXZWJSVEMgZXh0ZW5kcyBQcm9taXNlV2ViUlRDIHtcbiAgc3RhdGljIGNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICBzdGF0aWMgZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIG11bHRpcGxleCA9IHRydWUsIC4uLnJlc3R9KSB7XG4gICAgbGV0IGNvbm5lY3Rpb24gPSB0aGlzLmNvbm5lY3Rpb25zLmdldChzZXJ2aWNlTGFiZWwpO1xuICAgIC8vIEl0IGlzIHBvc3NpYmxlIHRoYXQgd2Ugd2VyZSBiYWNrZ3JvdW5kZWQgYmVmb3JlIHdlIGhhZCBhIGNoYW5jZSB0byBhY3Qgb24gYSBjbG9zaW5nIGNvbm5lY3Rpb24gYW5kIHJlbW92ZSBpdC5cbiAgICBpZiAoY29ubmVjdGlvbikge1xuICAgICAgY29uc3Qge2Nvbm5lY3Rpb25TdGF0ZSwgc2lnbmFsaW5nU3RhdGV9ID0gY29ubmVjdGlvbi5wZWVyO1xuICAgICAgaWYgKChjb25uZWN0aW9uU3RhdGUgPT09ICdjbG9zZWQnKSB8fCAoc2lnbmFsaW5nU3RhdGUgPT09ICdjbG9zZWQnKSkgY29ubmVjdGlvbiA9IG51bGw7XG4gICAgfVxuICAgIGlmICghY29ubmVjdGlvbikge1xuICAgICAgY29ubmVjdGlvbiA9IG5ldyB0aGlzKHtsYWJlbDogc2VydmljZUxhYmVsLCB1dWlkOiB1dWlkNCgpLCBtdWx0aXBsZXgsIC4uLnJlc3R9KTtcbiAgICAgIGlmIChtdWx0aXBsZXgpIHRoaXMuY29ubmVjdGlvbnMuc2V0KHNlcnZpY2VMYWJlbCwgY29ubmVjdGlvbik7XG4gICAgfVxuICAgIHJldHVybiBjb25uZWN0aW9uO1xuICB9XG4gIGNoYW5uZWxJZCA9IEJBU0VfQ0hBTk5FTF9JRDtcbiAgZ2V0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nKCkge1xuICAgIHJldHVybiB0aGlzLmNoYW5uZWxJZCA+IEJBU0VfQ0hBTk5FTF9JRDtcbiAgfVxuICBjbG9zZShyZW1vdmVDb25uZWN0aW9uID0gdHJ1ZSkge1xuICAgIHRoaXMuY2hhbm5lbElkID0gQkFTRV9DSEFOTkVMX0lEO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgaWYgKHJlbW92ZUNvbm5lY3Rpb24pIHRoaXMuY29uc3RydWN0b3IuY29ubmVjdGlvbnMuZGVsZXRlKHRoaXMuc2VydmljZUxhYmVsKTtcbiAgfVxuICBhc3luYyBlbnN1cmVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgY2hhbm5lbE9wdGlvbnMgPSB7fSwgc2lnbmFscyA9IG51bGwpIHsgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgYW4gb3BlbiBkYXRhIGNoYW5uZWwgb24gdGhpcyBjb25uZWN0aW9uLlxuICAgIGNvbnN0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nID0gdGhpcy5oYXNTdGFydGVkQ29ubmVjdGluZzsgLy8gTXVzdCBhc2sgYmVmb3JlIGluY3JlbWVudGluZyBpZC5cbiAgICBjb25zdCBpZCA9IHRoaXMuY2hhbm5lbElkKys7IC8vIFRoaXMgYW5kIGV2ZXJ5dGhpbmcgbGVhZGluZyB1cCB0byBpdCBtdXN0IGJlIHN5bmNocm9ub3VzLCBzbyB0aGF0IGlkIGFzc2lnbm1lbnQgaXMgZGV0ZXJtaW5pc3RpYy5cbiAgICBjb25zdCBuZWdvdGlhdGVkID0gKHRoaXMubXVsdGlwbGV4ID09PSAnbmVnb3RpYXRlZCcpICYmIGhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGNvbnN0IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgPSAhaGFzU3RhcnRlZENvbm5lY3RpbmcgLyohbmVnb3RpYXRlZCovICYmICEhc2lnbmFsczsgLy8gT25seSB0aGUgMHRoIHdpdGggc2lnbmFscyB3YWl0cyBwYXNzaXZlbHkuXG4gICAgLy8gc2lnbmFscyBpcyBlaXRoZXIgbnVsbGlzaCBvciBhbiBhcnJheSBvZiBzaWduYWxzLCBidXQgdGhhdCBhcnJheSBjYW4gYmUgRU1QVFksXG4gICAgLy8gaW4gd2hpY2ggY2FzZSB0aGUgcmVhbCBzaWduYWxzIHdpbGwgaGF2ZSB0byBiZSBhc3NpZ25lZCBsYXRlci4gVGhpcyBhbGxvd3MgdGhlIGRhdGEgY2hhbm5lbCB0byBiZSBzdGFydGVkIChhbmQgdG8gY29uc3VtZVxuICAgIC8vIGEgY2hhbm5lbElkKSBzeW5jaHJvbm91c2x5LCBidXQgdGhlIHByb21pc2Ugd29uJ3QgcmVzb2x2ZSB1bnRpbCB0aGUgcmVhbCBzaWduYWxzIGFyZSBzdXBwbGllZCBsYXRlci4gVGhpcyBpc1xuICAgIC8vIHVzZWZ1bCBpbiBtdWx0aXBsZXhpbmcgYW4gb3JkZXJlZCBzZXJpZXMgb2YgZGF0YSBjaGFubmVscyBvbiBhbiBBTlNXRVIgY29ubmVjdGlvbiwgd2hlcmUgdGhlIGRhdGEgY2hhbm5lbHMgbXVzdFxuICAgIC8vIG1hdGNoIHVwIHdpdGggYW4gT0ZGRVIgY29ubmVjdGlvbiBvbiBhIHBlZXIuIFRoaXMgd29ya3MgYmVjYXVzZSBvZiB0aGUgd29uZGVyZnVsIGhhcHBlbnN0YW5jZSB0aGF0IGFuc3dlciBjb25uZWN0aW9uc1xuICAgIC8vIGdldERhdGFDaGFubmVsUHJvbWlzZSAod2hpY2ggZG9lc24ndCByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIHlldCBiZSBvcGVuKSByYXRoZXIgdGhhbiBjcmVhdGVEYXRhQ2hhbm5lbCAod2hpY2ggd291bGRcbiAgICAvLyByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIGFscmVhZHkgYmUgb3BlbikuXG4gICAgY29uc3QgdXNlU2lnbmFscyA9ICFoYXNTdGFydGVkQ29ubmVjdGluZyAmJiBzaWduYWxzPy5sZW5ndGg7XG4gICAgY29uc3Qgb3B0aW9ucyA9IG5lZ290aWF0ZWQgPyB7aWQsIG5lZ290aWF0ZWQsIC4uLmNoYW5uZWxPcHRpb25zfSA6IGNoYW5uZWxPcHRpb25zO1xuICAgIGlmIChoYXNTdGFydGVkQ29ubmVjdGluZykge1xuICAgICAgYXdhaXQgdGhpcy5jb25uZWN0ZWQ7IC8vIEJlZm9yZSBjcmVhdGluZyBwcm9taXNlLlxuICAgICAgLy8gSSBzb21ldGltZXMgZW5jb3VudGVyIGEgYnVnIGluIFNhZmFyaSBpbiB3aGljaCBPTkUgb2YgdGhlIGNoYW5uZWxzIGNyZWF0ZWQgc29vbiBhZnRlciBjb25uZWN0aW9uIGdldHMgc3R1Y2sgaW5cbiAgICAgIC8vIHRoZSBjb25uZWN0aW5nIHJlYWR5U3RhdGUgYW5kIG5ldmVyIG9wZW5zLiBFeHBlcmltZW50YWxseSwgdGhpcyBzZWVtcyB0byBiZSByb2J1c3QuXG4gICAgICAvL1xuICAgICAgLy8gTm90ZSB0byBzZWxmOiBJZiBpdCBzaG91bGQgdHVybiBvdXQgdGhhdCB3ZSBzdGlsbCBoYXZlIHByb2JsZW1zLCB0cnkgc2VyaWFsaXppbmcgdGhlIGNhbGxzIHRvIHBlZXIuY3JlYXRlRGF0YUNoYW5uZWxcbiAgICAgIC8vIHNvIHRoYXQgdGhlcmUgaXNuJ3QgbW9yZSB0aGFuIG9uZSBjaGFubmVsIG9wZW5pbmcgYXQgYSB0aW1lLlxuICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMCkpO1xuICAgIH0gZWxzZSBpZiAodXNlU2lnbmFscykge1xuICAgICAgdGhpcy5zaWduYWxzID0gc2lnbmFscztcbiAgICB9XG4gICAgY29uc3QgcHJvbWlzZSA9IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgP1xuXHQgIHRoaXMuZ2V0RGF0YUNoYW5uZWxQcm9taXNlKGNoYW5uZWxOYW1lKSA6XG5cdCAgdGhpcy5jcmVhdGVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIGF3YWl0IHByb21pc2U7XG4gIH1cbn1cbiIsIi8vIG5hbWUvdmVyc2lvbiBvZiBcImRhdGFiYXNlXCJcbmV4cG9ydCBjb25zdCBzdG9yYWdlTmFtZSA9ICdmbGV4c3RvcmUnO1xuZXhwb3J0IGNvbnN0IHN0b3JhZ2VWZXJzaW9uID0gMTQ7XG5cbmltcG9ydCAqIGFzIHBrZyBmcm9tIFwiLi4vcGFja2FnZS5qc29uXCIgd2l0aCB7IHR5cGU6ICdqc29uJyB9O1xuZXhwb3J0IGNvbnN0IHtuYW1lLCB2ZXJzaW9ufSA9IHBrZy5kZWZhdWx0O1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHsgdGFnUGF0aCB9IGZyb20gJy4vdGFnUGF0aC5tanMnO1xuaW1wb3J0IHsgU2hhcmVkV2ViUlRDIH0gZnJvbSAnLi93ZWJydGMubWpzJztcbmltcG9ydCB7IHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5cbi8qXG4gIFJlc3BvbnNpYmxlIGZvciBrZWVwaW5nIGEgY29sbGVjdGlvbiBzeW5jaHJvbml6ZWQgd2l0aCBhbm90aGVyIHBlZXIuXG4gIChQZWVycyBtYXkgYmUgYSBjbGllbnQgb3IgYSBzZXJ2ZXIvcmVsYXkuIEluaXRpYWxseSB0aGlzIGlzIHRoZSBzYW1lIGNvZGUgZWl0aGVyIHdheSxcbiAgYnV0IGxhdGVyIG9uLCBvcHRpbWl6YXRpb25zIGNhbiBiZSBtYWRlIGZvciBzY2FsZS4pXG5cbiAgQXMgbG9uZyBhcyB0d28gcGVlcnMgYXJlIGNvbm5lY3RlZCB3aXRoIGEgU3luY2hyb25pemVyIG9uIGVhY2ggc2lkZSwgd3JpdGluZyBoYXBwZW5zXG4gIGluIGJvdGggcGVlcnMgaW4gcmVhbCB0aW1lLCBhbmQgcmVhZGluZyBwcm9kdWNlcyB0aGUgY29ycmVjdCBzeW5jaHJvbml6ZWQgcmVzdWx0IGZyb20gZWl0aGVyLlxuICBVbmRlciB0aGUgaG9vZCwgdGhlIHN5bmNocm9uaXplciBrZWVwcyB0cmFjayBvZiB3aGF0IGl0IGtub3dzIGFib3V0IHRoZSBvdGhlciBwZWVyIC0tXG4gIGEgcGFydGljdWxhciB0YWcgY2FuIGJlIHVua25vd24sIHVuc3luY2hyb25pemVkLCBvciBzeW5jaHJvbml6ZWQsIGFuZCByZWFkaW5nIHdpbGxcbiAgY29tbXVuaWNhdGUgYXMgbmVlZGVkIHRvIGdldCB0aGUgZGF0YSBzeW5jaHJvbml6ZWQgb24tZGVtYW5kLiBNZWFud2hpbGUsIHN5bmNocm9uaXphdGlvblxuICBjb250aW51ZXMgaW4gdGhlIGJhY2tncm91bmQgdW50aWwgdGhlIGNvbGxlY3Rpb24gaXMgZnVsbHkgcmVwbGljYXRlZC5cblxuICBBIGNvbGxlY3Rpb24gbWFpbnRhaW5zIGEgc2VwYXJhdGUgU3luY2hyb25pemVyIGZvciBlYWNoIG9mIHplcm8gb3IgbW9yZSBwZWVycywgYW5kIGNhbiBkeW5hbWljYWxseVxuICBhZGQgYW5kIHJlbW92ZSBtb3JlLlxuXG4gIE5hbWluZyBjb252ZW50aW9uczpcblxuICBtdW1ibGVOYW1lOiBhIHNlbWFudGljIG5hbWUgdXNlZCBleHRlcm5hbGx5IGFzIGEga2V5LiBFeGFtcGxlOiBzZXJ2aWNlTmFtZSwgY2hhbm5lbE5hbWUsIGV0Yy5cbiAgICBXaGVuIHRoaW5ncyBuZWVkIHRvIG1hdGNoIHVwIGFjcm9zcyBzeXN0ZW1zLCBpdCBpcyBieSBuYW1lLlxuICAgIElmIG9ubHkgb25lIG9mIG5hbWUvbGFiZWwgaXMgc3BlY2lmaWVkLCB0aGlzIGlzIHVzdWFsbHkgdGhlIHRoZSBvbmUuXG5cbiAgbXVtYmxlTGFiZWw6IGEgbGFiZWwgZm9yIGlkZW50aWZpY2F0aW9uIGFuZCBpbnRlcm5hbGx5IChlLmcuLCBkYXRhYmFzZSBuYW1lKS5cbiAgICBXaGVuIHR3byBpbnN0YW5jZXMgb2Ygc29tZXRoaW5nIGFyZSBcInRoZSBzYW1lXCIgYnV0IGFyZSBpbiB0aGUgc2FtZSBKYXZhc2NyaXB0IGltYWdlIGZvciB0ZXN0aW5nLCB0aGV5IGFyZSBkaXN0aW5ndWlzaGVkIGJ5IGxhYmVsLlxuICAgIFR5cGljYWxseSBkZWZhdWx0cyB0byBtdW1ibGVOYW1lLlxuXG4gIE5vdGUsIHRob3VnaCwgdGhhdCBzb21lIGV4dGVybmFsIG1hY2hpbmVyeSAoc3VjaCBhcyBhIFdlYlJUQyBEYXRhQ2hhbm5lbCkgaGFzIGEgXCJsYWJlbFwiIHByb3BlcnR5IHRoYXQgd2UgcG9wdWxhdGUgd2l0aCBhIFwibmFtZVwiIChjaGFubmVsTmFtZSkuXG4gKi9cbmV4cG9ydCBjbGFzcyBTeW5jaHJvbml6ZXIge1xuICBzdGF0aWMgdmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uO1xuICBjb25zdHJ1Y3Rvcih7c2VydmljZU5hbWUgPSAnZGlyZWN0JywgY29sbGVjdGlvbiwgZXJyb3IgPSBjb2xsZWN0aW9uPy5jb25zdHJ1Y3Rvci5lcnJvciB8fCBjb25zb2xlLmVycm9yLFxuXHQgICAgICAgc2VydmljZUxhYmVsID0gY29sbGVjdGlvbj8uc2VydmljZUxhYmVsIHx8IHNlcnZpY2VOYW1lLCAvLyBVc2VkIHRvIGlkZW50aWZ5IGFueSBleGlzdGluZyBjb25uZWN0aW9uLiBDYW4gYmUgZGlmZmVyZW50IGZyb20gc2VydmljZU5hbWUgZHVyaW5nIHRlc3RpbmcuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgdXVpZCA9IGNvbGxlY3Rpb24/LnV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sIGNvbm5lY3Rpb24sIC8vIENvbXBsZXggZGVmYXVsdCBiZWhhdmlvciBmb3IgdGhlc2UuIFNlZSBjb2RlLlxuXHQgICAgICAgbXVsdGlwbGV4ID0gY29sbGVjdGlvbj8ubXVsdGlwbGV4LCAvLyBJZiBzcGVjaWZlZCwgb3RoZXJ3aXNlIHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LiBTZWUgYmVsb3cuXG5cdCAgICAgICBkZWJ1ZyA9IGNvbGxlY3Rpb24/LmRlYnVnLCBtYXhWZXJzaW9uID0gU3luY2hyb25pemVyLnZlcnNpb24sIG1pblZlcnNpb24gPSBtYXhWZXJzaW9ufSkge1xuICAgIC8vIHNlcnZpY2VOYW1lIGlzIGEgc3RyaW5nIG9yIG9iamVjdCB0aGF0IGlkZW50aWZpZXMgd2hlcmUgdGhlIHN5bmNocm9uaXplciBzaG91bGQgY29ubmVjdC4gRS5nLiwgaXQgbWF5IGJlIGEgVVJMIGNhcnJ5aW5nXG4gICAgLy8gICBXZWJSVEMgc2lnbmFsaW5nLiBJdCBzaG91bGQgYmUgYXBwLXVuaXF1ZSBmb3IgdGhpcyBwYXJ0aWN1bGFyIHNlcnZpY2UgKGUuZy4sIHdoaWNoIG1pZ2h0IG11bHRpcGxleCBkYXRhIGZvciBtdWx0aXBsZSBjb2xsZWN0aW9uIGluc3RhbmNlcykuXG4gICAgLy8gdXVpZCBoZWxwIHVuaXF1ZWx5IGlkZW50aWZpZXMgdGhpcyBwYXJ0aWN1bGFyIHN5bmNocm9uaXplci5cbiAgICAvLyAgIEZvciBtb3N0IHB1cnBvc2VzLCB1dWlkIHNob3VsZCBnZXQgdGhlIGRlZmF1bHQsIGFuZCByZWZlcnMgdG8gT1VSIGVuZC5cbiAgICAvLyAgIEhvd2V2ZXIsIGEgc2VydmVyIHRoYXQgY29ubmVjdHMgdG8gYSBidW5jaCBvZiBwZWVycyBtaWdodCBiYXNoIGluIHRoZSB1dWlkIHdpdGggdGhhdCBvZiB0aGUgb3RoZXIgZW5kLCBzbyB0aGF0IGxvZ2dpbmcgaW5kaWNhdGVzIHRoZSBjbGllbnQuXG4gICAgLy8gSWYgY2hhbm5lbE5hbWUgaXMgc3BlY2lmaWVkLCBpdCBzaG91bGQgYmUgaW4gdGhlIGZvcm0gb2YgY29sbGVjdGlvblR5cGUvY29sbGVjdGlvbk5hbWUgKGUuZy4sIGlmIGNvbm5lY3RpbmcgdG8gcmVsYXkpLlxuICAgIGNvbnN0IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgPSBzZXJ2aWNlTmFtZS5zdGFydHNXaXRoPy4oJ2h0dHAnKTtcbiAgICBpZiAoIWNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgKHJ0Y0NvbmZpZ3VyYXRpb24gPT09IHVuZGVmaW5lZCkpIHJ0Y0NvbmZpZ3VyYXRpb24gPSB7fTsgLy8gRXhwaWNpdGx5IG5vIGljZS4gTEFOIG9ubHkuXG4gICAgLy8gbXVsdGlwbGV4IHNob3VsZCBlbmQgdXAgd2l0aCBvbmUgb2YgdGhyZWUgdmFsdWVzOlxuICAgIC8vIGZhbHN5IC0gYSBuZXcgY29ubmVjdGlvbiBzaG91bGQgYmUgdXNlZCBmb3IgZWFjaCBjaGFubmVsXG4gICAgLy8gXCJuZWdvdGlhdGVkXCIgLSBib3RoIHNpZGVzIGNyZWF0ZSB0aGUgc2FtZSBjaGFubmVsTmFtZXMgaW4gdGhlIHNhbWUgb3JkZXIgKG1vc3QgY2FzZXMpOlxuICAgIC8vICAgICBUaGUgaW5pdGlhbCBzaWduYWxsaW5nIHdpbGwgYmUgdHJpZ2dlcmVkIGJ5IG9uZSBzaWRlIGNyZWF0aW5nIGEgY2hhbm5lbCwgYW5kIHRoZXIgc2lkZSB3YWl0aW5nIGZvciBpdCB0byBiZSBjcmVhdGVkLlxuICAgIC8vICAgICBBZnRlciB0aGF0LCBib3RoIHNpZGVzIHdpbGwgZXhwbGljaXRseSBjcmVhdGUgYSBkYXRhIGNoYW5uZWwgYW5kIHdlYnJ0YyB3aWxsIG1hdGNoIHRoZW0gdXAgYnkgaWQuXG4gICAgLy8gYW55IG90aGVyIHRydXRoeSAtIFN0YXJ0cyBsaWtlIG5lZ290aWF0ZWQsIGFuZCB0aGVuIGNvbnRpbnVlcyB3aXRoIG9ubHkgd2lkZSBzaWRlIGNyZWF0aW5nIHRoZSBjaGFubmVscywgYW5kIHRoZXIgb3RoZXJcbiAgICAvLyAgICAgb2JzZXJ2ZXMgdGhlIGNoYW5uZWwgdGhhdCBoYXMgYmVlbiBtYWRlLiBUaGlzIGlzIHVzZWQgZm9yIHJlbGF5cy5cbiAgICBtdWx0aXBsZXggPz89IGNvbm5lY3Rpb24/Lm11bHRpcGxleDsgLy8gU3RpbGwgdHlwaWNhbGx5IHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LlxuICAgIG11bHRpcGxleCA/Pz0gKHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zeW5jJykgfHwgJ25lZ290aWF0ZWQnKTtcbiAgICBjb25uZWN0aW9uID8/PSBTaGFyZWRXZWJSVEMuZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIGNvbmZpZ3VyYXRpb246IHJ0Y0NvbmZpZ3VyYXRpb24sIG11bHRpcGxleCwgdXVpZCwgZGVidWcsIGVycm9yfSk7XG5cbiAgICB1dWlkID8/PSBjb25uZWN0aW9uLnV1aWQ7XG4gICAgLy8gQm90aCBwZWVycyBtdXN0IGFncmVlIG9uIGNoYW5uZWxOYW1lLiBVc3VhbGx5LCB0aGlzIGlzIGNvbGxlY3Rpb24uZnVsbE5hbWUuIEJ1dCBpbiB0ZXN0aW5nLCB3ZSBtYXkgc3luYyB0d28gY29sbGVjdGlvbnMgd2l0aCBkaWZmZXJlbnQgbmFtZXMuXG4gICAgY2hhbm5lbE5hbWUgPz89IGNvbGxlY3Rpb24/LmNoYW5uZWxOYW1lIHx8IGNvbGxlY3Rpb24uZnVsbE5hbWU7XG4gICAgY29uc3QgbGFiZWwgPSBgJHtjb2xsZWN0aW9uPy5mdWxsTGFiZWwgfHwgY2hhbm5lbE5hbWV9LyR7dXVpZH1gO1xuICAgIC8vIFdoZXJlIHdlIGNhbiByZXF1ZXN0IGEgZGF0YSBjaGFubmVsIHRoYXQgcHVzaGVzIHB1dC9kZWxldGUgcmVxdWVzdHMgZnJvbSBvdGhlcnMuXG4gICAgY29uc3QgY29ubmVjdGlvblVSTCA9IHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zaWduYWwvJykgPyBzZXJ2aWNlTmFtZSA6IGAke3NlcnZpY2VOYW1lfS8ke2xhYmVsfWA7XG5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzZXJ2aWNlTmFtZSwgbGFiZWwsIGNvbGxlY3Rpb24sIGRlYnVnLCBlcnJvciwgbWluVmVyc2lvbiwgbWF4VmVyc2lvbiwgdXVpZCwgcnRjQ29uZmlndXJhdGlvbixcblx0XHRcdCBjb25uZWN0aW9uLCB1dWlkLCBjaGFubmVsTmFtZSwgY29ubmVjdGlvblVSTCxcblx0XHRcdCBjb25uZWN0aW9uU3RhcnRUaW1lOiBEYXRlLm5vdygpLFxuXHRcdFx0IGNsb3NlZDogdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCksXG5cdFx0XHQgLy8gTm90IHVzZWQgeWV0LCBidXQgY291bGQgYmUgdXNlZCB0byBHRVQgcmVzb3VyY2VzIG92ZXIgaHR0cCBpbnN0ZWFkIG9mIHRocm91Z2ggdGhlIGRhdGEgY2hhbm5lbC5cblx0XHRcdCBob3N0UmVxdWVzdEJhc2U6IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgYCR7c2VydmljZU5hbWUucmVwbGFjZSgvXFwvKHN5bmN8c2lnbmFsKS8pfS8ke2NoYW5uZWxOYW1lfWB9KTtcbiAgICBjb2xsZWN0aW9uPy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgdGhpcyk7IC8vIE11c3QgYmUgc2V0IHN5bmNocm9ub3VzbHksIHNvIHRoYXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEga25vd3MgdG8gd2FpdC5cbiAgfVxuICBzdGF0aWMgYXN5bmMgY3JlYXRlKGNvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCBvcHRpb25zID0ge30pIHsgLy8gUmVjZWl2ZSBwdXNoZWQgbWVzc2FnZXMgZnJvbSB0aGUgZ2l2ZW4gc2VydmljZS4gZ2V0L3B1dC9kZWxldGUgd2hlbiB0aGV5IGNvbWUgKHdpdGggZW1wdHkgc2VydmljZXMgbGlzdCkuXG4gICAgY29uc3Qgc3luY2hyb25pemVyID0gbmV3IHRoaXMoe2NvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCAuLi5vcHRpb25zfSk7XG4gICAgY29uc3QgY29ubmVjdGVkUHJvbWlzZSA9IHN5bmNocm9uaXplci5jb25uZWN0Q2hhbm5lbCgpOyAvLyBFc3RhYmxpc2ggY2hhbm5lbCBjcmVhdGlvbiBvcmRlci5cbiAgICBjb25zdCBjb25uZWN0ZWQgPSBhd2FpdCBjb25uZWN0ZWRQcm9taXNlO1xuICAgIGlmICghY29ubmVjdGVkKSByZXR1cm4gc3luY2hyb25pemVyO1xuICAgIHJldHVybiBhd2FpdCBjb25uZWN0ZWQuc3luY2hyb25pemUoKTtcbiAgfVxuICBhc3luYyBjb25uZWN0Q2hhbm5lbCgpIHsgLy8gU3luY2hyb25vdXNseSBpbml0aWFsaXplIGFueSBwcm9taXNlcyB0byBjcmVhdGUgYSBkYXRhIGNoYW5uZWwsIGFuZCB0aGVuIGF3YWl0IGNvbm5lY3Rpb24uXG4gICAgY29uc3Qge2hvc3RSZXF1ZXN0QmFzZSwgdXVpZCwgY29ubmVjdGlvbiwgc2VydmljZU5hbWV9ID0gdGhpcztcbiAgICBsZXQgc3RhcnRlZCA9IGNvbm5lY3Rpb24uaGFzU3RhcnRlZENvbm5lY3Rpbmc7XG4gICAgaWYgKHN0YXJ0ZWQpIHtcbiAgICAgIC8vIFdlIGFscmVhZHkgaGF2ZSBhIGNvbm5lY3Rpb24uIEp1c3Qgb3BlbiBhbm90aGVyIGRhdGEgY2hhbm5lbCBmb3Igb3VyIHVzZS5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zeW5jJykpIHsgLy8gQ29ubmVjdCB3aXRoIGEgc2VydmVyIHJlbGF5LiAoU2lnbmFsIGFuZCBzdGF5IGNvbm5lY3RlZCB0aHJvdWdoIHN5bmMuKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc2lnbmFsL2Fuc3dlcicpKSB7IC8vIFNlZWtpbmcgYW4gYW5zd2VyIHRvIGFuIG9mZmVyIHdlIFBPU1QgKHRvIHJlbmRldm91cyB3aXRoIGEgcGVlcikuXG4gICAgICBzdGFydGVkID0gdGhpcy5jb25uZWN0U2VydmVyKCk7IC8vIEp1c3QgbGlrZSBhIHN5bmNcbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3NpZ25hbC9vZmZlcicpKSB7IC8vIEdFVCBhbiBvZmZlciBmcm9tIGEgcmVuZGV2b3VzIHBlZXIgYW5kIHRoZW4gUE9TVCBhbiBhbnN3ZXIuXG4gICAgICAvLyBXZSBtdXN0IHN5Y2hyb25vdXNseSBzdGFydENvbm5lY3Rpb24gbm93IHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gaGFzU3RhcnRlZENvbm5lY3RpbmcsIGFuZCBhbnkgc3Vic2VxdWVudCBkYXRhIGNoYW5uZWxcbiAgICAgIC8vIHJlcXVlc3RzIG9uIHRoZSBzYW1lIGNvbm5lY3Rpb24gd2lsbCB3YWl0ICh1c2luZyB0aGUgJ3N0YXJ0ZWQnIHBhdGgsIGFib3ZlKS5cbiAgICAgIC8vIENvbXBhcmUgY29ubmVjdFNlcnZlciwgd2hpY2ggaXMgYmFzaWNhbGx5OlxuICAgICAgLy8gICBzdGFydENvbm5lY3Rpb24oKSwgZmV0Y2ggd2l0aCB0aGF0IG9mZmVyLCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCBmZXRjaGVkIGFuc3dlci5cbiAgICAgIGNvbnN0IHByb21pc2VkU2lnbmFscyA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKFtdKTsgLy8gRXN0YWJsaXNoaW5nIG9yZGVyLlxuICAgICAgY29uc3QgdXJsID0gdGhpcy5jb25uZWN0aW9uVVJMO1xuICAgICAgY29uc3Qgb2ZmZXIgPSBhd2FpdCB0aGlzLmZldGNoKHVybCk7XG4gICAgICBjb25zdCBvayA9IHRoaXMuY29tcGxldGVDb25uZWN0aW9uKG9mZmVyKTsgLy8gTm93IHN1cHBseSB0aG9zZSBzaWduYWxzIHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gY2FuIHByb2R1Y2UgYW5zd2VyIHNpZ2Fscy5cbiAgICAgIGNvbnN0IGFuc3dlciA9IGF3YWl0IHByb21pc2VkU2lnbmFscztcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmZldGNoKHVybCwgYW5zd2VyKTsgLy8gUE9TVCBvdXIgYW5zd2VyIHRvIHBlZXIuXG4gICAgfSBlbHNlIGlmIChzZXJ2aWNlTmFtZSA9PT0gJ3NpZ25hbHMnKSB7IC8vIFN0YXJ0IGNvbm5lY3Rpb24gYW5kIHJldHVybiBudWxsLiBNdXN0IGJlIGNvbnRpbnVlZCB3aXRoIGNvbXBsZXRlU2lnbmFsc1N5bmNocm9uaXphdGlvbigpO1xuICAgICAgc3RhcnRlZCA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoc2VydmljZU5hbWUpKSB7IC8vIEEgbGlzdCBvZiBcInJlY2VpdmluZ1wiIHNpZ25hbHMuXG4gICAgICBzdGFydGVkID0gdGhpcy5zdGFydENvbm5lY3Rpb24oc2VydmljZU5hbWUpO1xuICAgIH0gZWxzZSBpZiAoc2VydmljZU5hbWUuc3luY2hyb25pemVycykgeyAvLyBEdWNrIHR5cGluZyBmb3IgcGFzc2luZyBhIGNvbGxlY3Rpb24gZGlyZWN0bHkgYXMgdGhlIHNlcnZpY2VJbmZvLiAoV2UgZG9uJ3QgaW1wb3J0IENvbGxlY3Rpb24uKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdERpcmVjdFRlc3Rpbmcoc2VydmljZU5hbWUpOyAvLyBVc2VkIGluIHRlc3RpbmcuXG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5yZWNvZ25pemVkIHNlcnZpY2UgZm9ybWF0OiAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgaWYgKCEoYXdhaXQgc3RhcnRlZCkpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnY29ubmVjdGlvbiBmYWlsZWQnKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIGdldCBkYXRhQ2hhbm5lbFByb21pc2UoKSB7IC8vIEEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLl9kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgaWYgKCFwcm9taXNlKSB0aHJvdyBuZXcgRXJyb3IoYCR7dGhpcy5sYWJlbH06IERhdGEgY2hhbm5lbCBpcyBub3QgeWV0IHByb21pc2VkLmApO1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGNoYW5uZWxDbG9zZWRDbGVhbnVwKCkgeyAvLyBCb29ra2VlcGluZyB3aGVuIGNoYW5uZWwgY2xvc2VkIG9yIGV4cGxpY2l0bHkgYWJhbmRvbmVkIGJlZm9yZSBvcGVuaW5nLlxuICAgIHRoaXMuY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5kZWxldGUodGhpcy5zZXJ2aWNlTmFtZSk7XG4gICAgdGhpcy5jbG9zZWQucmVzb2x2ZSh0aGlzKTsgLy8gUmVzb2x2ZSB0byBzeW5jaHJvbml6ZXIgaXMgbmljZSBpZiwgZS5nLCBzb21lb25lIGlzIFByb21pc2UucmFjaW5nLlxuICB9XG4gIHNldCBkYXRhQ2hhbm5lbFByb21pc2UocHJvbWlzZSkgeyAvLyBTZXQgdXAgbWVzc2FnZSBhbmQgY2xvc2UgaGFuZGxpbmcuXG4gICAgdGhpcy5fZGF0YUNoYW5uZWxQcm9taXNlID0gcHJvbWlzZS50aGVuKGRhdGFDaGFubmVsID0+IHtcbiAgICAgIGRhdGFDaGFubmVsLm9ubWVzc2FnZSA9IGV2ZW50ID0+IHRoaXMucmVjZWl2ZShldmVudC5kYXRhKTtcbiAgICAgIGRhdGFDaGFubmVsLm9uY2xvc2UgPSBhc3luYyBldmVudCA9PiB0aGlzLmNoYW5uZWxDbG9zZWRDbGVhbnVwKCk7XG4gICAgICByZXR1cm4gZGF0YUNoYW5uZWw7XG4gICAgfSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemUoKSB7XG4gICAgYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG4gIHN0YXRpYyBmcmFnbWVudElkID0gMDtcbiAgYXN5bmMgc2VuZChtZXRob2QsIC4uLnBhcmFtcykgeyAvLyBTZW5kcyB0byB0aGUgcGVlciwgb3ZlciB0aGUgZGF0YSBjaGFubmVsXG4gICAgY29uc3QgcGF5bG9hZCA9IEpTT04uc3RyaW5naWZ5KHttZXRob2QsIHBhcmFtc30pO1xuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgY29uc3Qgc3RhdGUgPSBkYXRhQ2hhbm5lbD8ucmVhZHlTdGF0ZSB8fCAnY2xvc2VkJztcbiAgICBpZiAoc3RhdGUgPT09ICdjbG9zZWQnIHx8IHN0YXRlID09PSAnY2xvc2luZycpIHJldHVybjtcbiAgICB0aGlzLmxvZygnc2VuZHMnLCBtZXRob2QsIC4uLnBhcmFtcyk7XG4gICAgY29uc3Qgc2l6ZSA9IDE2ZTM7IC8vIEEgYml0IGxlc3MgdGhhbiAxNiAqIDEwMjQuXG4gICAgaWYgKHBheWxvYWQubGVuZ3RoIDwgc2l6ZSkge1xuICAgICAgZGF0YUNoYW5uZWwuc2VuZChwYXlsb2FkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgLy8gYnJlYWsgdXAgbG9uZyBtZXNzYWdlcy4gKEFzIGEgcHJhY3RpY2FsIG1hdHRlciwgMTYgS2lCIGlzIHRoZSBsb25nZXN0IHRoYXQgY2FuIHJlbGlhYmx5IGJlIHNlbnQgYWNyb3NzIGRpZmZlcmVudCB3cnRjIGltcGxlbWVudGF0aW9ucy4pXG4gICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9XZWJSVENfQVBJL1VzaW5nX2RhdGFfY2hhbm5lbHMjY29uY2VybnNfd2l0aF9sYXJnZV9tZXNzYWdlc1xuICAgIGNvbnN0IG51bUNodW5rcyA9IE1hdGguY2VpbChwYXlsb2FkLmxlbmd0aCAvIHNpemUpO1xuICAgIGNvbnN0IGlkID0gdGhpcy5jb25zdHJ1Y3Rvci5mcmFnbWVudElkKys7XG4gICAgY29uc3QgbWV0YSA9IHttZXRob2Q6ICdmcmFnbWVudHMnLCBwYXJhbXM6IFtpZCwgbnVtQ2h1bmtzXX07XG4gICAgLy9jb25zb2xlLmxvZyhgRnJhZ21lbnRpbmcgbWVzc2FnZSAke2lkfSBpbnRvICR7bnVtQ2h1bmtzfSBjaHVua3MuYCwgbWV0YSk7XG4gICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShtZXRhKSk7XG4gICAgLy8gT3B0aW1pemF0aW9uIG9wcG9ydHVuaXR5OiByZWx5IG9uIG1lc3NhZ2VzIGJlaW5nIG9yZGVyZWQgYW5kIHNraXAgcmVkdW5kYW50IGluZm8uIElzIGl0IHdvcnRoIGl0P1xuICAgIGZvciAobGV0IGkgPSAwLCBvID0gMDsgaSA8IG51bUNodW5rczsgKytpLCBvICs9IHNpemUpIHtcbiAgICAgIGNvbnN0IGZyYWcgPSB7bWV0aG9kOiAnZnJhZycsIHBhcmFtczogW2lkLCBpLCBwYXlsb2FkLnN1YnN0cihvLCBzaXplKV19O1xuICAgICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShmcmFnKSk7XG4gICAgfVxuICB9XG4gIHJlY2VpdmUodGV4dCkgeyAvLyBEaXNwYXRjaCBhIG1lc3NhZ2Ugc2VudCBvdmVyIHRoZSBkYXRhIGNoYW5uZWwgZnJvbSB0aGUgcGVlci5cbiAgICBjb25zdCB7bWV0aG9kLCBwYXJhbXN9ID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgICB0aGlzW21ldGhvZF0oLi4ucGFyYW1zKTtcbiAgfVxuICBwZW5kaW5nRnJhZ21lbnRzID0ge307XG4gIGZyYWdtZW50cyhpZCwgbnVtQ2h1bmtzKSB7XG4gICAgLy9jb25zb2xlLmxvZyhgUmVjZWl2aW5nIG1lc2FnZSAke2lkfSBpbiAke251bUNodW5rc30uYCk7XG4gICAgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXSA9IHtyZW1haW5pbmc6IG51bUNodW5rcywgbWVzc2FnZTogQXJyYXkobnVtQ2h1bmtzKX07XG4gIH1cbiAgZnJhZyhpZCwgaSwgZnJhZ21lbnQpIHtcbiAgICBsZXQgZnJhZyA9IHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF07IC8vIFdlIGFyZSByZWx5aW5nIG9uIGZyYWdtZW50IG1lc3NhZ2UgY29taW5nIGZpcnN0LlxuICAgIGZyYWcubWVzc2FnZVtpXSA9IGZyYWdtZW50O1xuICAgIGlmICgwICE9PSAtLWZyYWcucmVtYWluaW5nKSByZXR1cm47XG4gICAgLy9jb25zb2xlLmxvZyhgRGlzcGF0Y2hpbmcgbWVzc2FnZSAke2lkfS5gKTtcbiAgICB0aGlzLnJlY2VpdmUoZnJhZy5tZXNzYWdlLmpvaW4oJycpKTtcbiAgICBkZWxldGUgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXTtcbiAgfVxuXG4gIGFzeW5jIGRpc2Nvbm5lY3QoKSB7IC8vIFdhaXQgZm9yIGRhdGFDaGFubmVsIHRvIGRyYWluIGFuZCByZXR1cm4gYSBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBhY3R1YWxseSBjbG9zZWQsXG4gICAgLy8gYnV0IHJldHVybiBpbW1lZGlhdGVseSBpZiBjb25uZWN0aW9uIG5vdCBzdGFydGVkLlxuICAgIGlmICh0aGlzLmNvbm5lY3Rpb24ucGVlci5jb25uZWN0aW9uU3RhdGUgIT09ICdjb25uZWN0ZWQnKSByZXR1cm4gdGhpcy5jaGFubmVsQ2xvc2VkQ2xlYW51cCh0aGlzLmNvbm5lY3Rpb24uY2xvc2UoKSk7XG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBkYXRhQ2hhbm5lbC5jbG9zZSgpO1xuICAgIHJldHVybiB0aGlzLmNsb3NlZDtcbiAgfVxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGR1cmluZyBzeW5jLlxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGFmdGVyIHN5bmMuXG4gIHN0YXJ0Q29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBNYWNoaW5lcnkgZm9yIG1ha2luZyBhIFdlYlJUQyBjb25uZWN0aW9uIHRvIHRoZSBwZWVyOlxuICAgIC8vICAgSWYgc2lnbmFsTWVzc2FnZXMgaXMgYSBsaXN0IG9mIFtvcGVyYXRpb24sIG1lc3NhZ2VdIG1lc3NhZ2Ugb2JqZWN0cywgdGhlbiB0aGUgb3RoZXIgc2lkZSBpcyBpbml0aWF0aW5nXG4gICAgLy8gdGhlIGNvbm5lY3Rpb24gYW5kIGhhcyBzZW50IGFuIGluaXRpYWwgb2ZmZXIvaWNlLiBJbiB0aGlzIGNhc2UsIHN0YXJ0Q29ubmVjdCgpIHByb21pc2VzIGEgcmVzcG9uc2VcbiAgICAvLyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUuXG4gICAgLy8gICBPdGhlcndpc2UsIHN0YXJ0Q29ubmVjdCgpIHByb21pc2VzIGEgbGlzdCBvZiBpbml0aWFsIHNpZ25hbCBtZXNzYWdlcyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUsXG4gICAgLy8gYW5kIGl0IGlzIG5lY2Vzc2FyeSB0byB0aGVuIGNhbGwgY29tcGxldGVDb25uZWN0aW9uKCkgd2l0aCB0aGUgcmVzcG9uc2UgZnJvbSB0aGVtLlxuICAgIC8vIEluIGJvdGggY2FzZXMsIGFzIGEgc2lkZSBlZmZlY3QsIHRoZSBkYXRhQ2hhbm5lbFByb21pc2UgcHJvcGVydHkgd2lsbCBiZSBzZXQgdG8gYSBQcm9taXNlXG4gICAgLy8gdGhhdCByZXNvbHZlcyB0byB0aGUgZGF0YSBjaGFubmVsIHdoZW4gaXQgaXMgb3BlbnMuIFRoaXMgcHJvbWlzZSBpcyB1c2VkIGJ5IHNlbmQoKSBhbmQgcmVjZWl2ZSgpLlxuICAgIGNvbnN0IHtjb25uZWN0aW9ufSA9IHRoaXM7XG4gICAgdGhpcy5sb2coc2lnbmFsTWVzc2FnZXMgPyAnZ2VuZXJhdGluZyBhbnN3ZXInIDogJ2dlbmVyYXRpbmcgb2ZmZXInKTtcbiAgICB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSwge30sIHNpZ25hbE1lc3NhZ2VzKTtcbiAgICByZXR1cm4gY29ubmVjdGlvbi5zaWduYWxzO1xuICB9XG4gIGNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBGaW5pc2ggd2hhdCB3YXMgc3RhcnRlZCB3aXRoIHN0YXJ0Q29sbGVjdGlvbi5cbiAgICAvLyBEb2VzIG5vdCByZXR1cm4gYSBwcm9taXNlLiBDbGllbnQgY2FuIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlIHRvIHNlZSB3aGVuIHdlIGFyZSBhY3R1YWxseSBjb25uZWN0ZWQuXG4gICAgaWYgKCFzaWduYWxNZXNzYWdlcykgcmV0dXJuIGZhbHNlO1xuICAgIHRoaXMuY29ubmVjdGlvbi5zaWduYWxzID0gc2lnbmFsTWVzc2FnZXM7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBzdGF0aWMgZmV0Y2hKU09OKHVybCwgYm9keSA9IHVuZGVmaW5lZCwgbWV0aG9kID0gbnVsbCkge1xuICAgIGNvbnN0IGhhc0JvZHkgPSBib2R5ICE9PSB1bmRlZmluZWQ7XG4gICAgbWV0aG9kID8/PSBoYXNCb2R5ID8gJ1BPU1QnIDogJ0dFVCc7XG4gICAgcmV0dXJuIGZldGNoKHVybCwgaGFzQm9keSA/IHttZXRob2QsIGhlYWRlcnM6IHtcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIn0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpfSA6IHttZXRob2R9KVxuICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuXHRpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoYCR7cmVzcG9uc2Uuc3RhdHVzVGV4dCB8fCAnRmV0Y2ggZmFpbGVkJ30sIGNvZGUgJHtyZXNwb25zZS5zdGF0dXN9IGluICR7dXJsfS5gKTtcblx0cmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcbiAgICAgIH0pO1xuICB9XG4gIGFzeW5jIGZldGNoKHVybCwgYm9keSA9IHVuZGVmaW5lZCkgeyAvLyBBcyBKU09OXG5cbiAgICBjb25zdCBtZXRob2QgPSBib2R5ID8gJ1BPU1QnIDogJ0dFVCc7XG4gICAgdGhpcy5sb2coJ2ZldGNoJywgbWV0aG9kLCB1cmwsICdzZW5kaW5nOicsIGJvZHkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZmV0Y2hKU09OKHVybCwgYm9keSwgbWV0aG9kKVxuXHQgIC5jYXRjaChlcnJvciA9PiB7XG5cdCAgICB0aGlzLmNsb3NlZC5yZWplY3QoZXJyb3IpO1xuXHQgIH0pO1xuICAgIHRoaXMubG9nKCdmZXRjaCcsIG1ldGhvZCwgdXJsLCAncmVzdWx0OicsIHJlc3VsdCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICBhc3luYyBjb25uZWN0U2VydmVyKHVybCA9IHRoaXMuY29ubmVjdGlvblVSTCkgeyAvLyBDb25uZWN0IHRvIGEgcmVsYXkgb3ZlciBodHRwLiAoL3N5bmMgb3IgL3NpZ25hbC9hbnN3ZXIpXG4gICAgLy8gc3RhcnRDb25uZWN0aW9uLCBQT1NUIG91ciBzaWduYWxzLCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCB0aGUgcmVzcG9uc2UuXG4gICAgLy8gT3VyIHdlYnJ0YyBzeW5jaHJvbml6ZXIgaXMgdGhlbiBjb25uZWN0ZWQgdG8gdGhlIHJlbGF5J3Mgd2VicnQgc3luY2hyb25pemVyLlxuICAgIGNvbnN0IG91clNpZ25hbHNQcm9taXNlID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTsgLy8gbXVzdCBiZSBzeW5jaHJvbm91cyB0byBwcmVzZXJ2ZSBjaGFubmVsIGlkIG9yZGVyLlxuICAgIGNvbnN0IG91clNpZ25hbHMgPSBhd2FpdCBvdXJTaWduYWxzUHJvbWlzZTtcbiAgICBjb25zdCB0aGVpclNpZ25hbHMgPSBhd2FpdCB0aGlzLmZldGNoKHVybCwgb3VyU2lnbmFscyk7IC8vIFBPU1RcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuICBhc3luYyBjb21wbGV0ZVNpZ25hbHNTeW5jaHJvbml6YXRpb24oc2lnbmFscykgeyAvLyBHaXZlbiBhbnN3ZXIvaWNlIHNpZ25hbHMsIGNvbXBsZXRlIHRoZSBjb25uZWN0aW9uIGFuZCBzdGFydCBzeW5jaHJvbml6ZS5cbiAgICBhd2FpdCB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxzKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdERpcmVjdFRlc3RpbmcocGVlckNvbGxlY3Rpb24pIHsgLy8gVXNlZCBpbiB1bml0IHRlc3RpbmcsIHdoZXJlIHRoZSBcInJlbW90ZVwiIHNlcnZpY2UgaXMgc3BlY2lmaWVkIGRpcmVjdGx5IChub3QgYSBzdHJpbmcpLlxuICAgIC8vIEVhY2ggY29sbGVjdGlvbiBpcyBhc2tlZCB0byBzeWNocm9uaXplIHRvIGFub3RoZXIgY29sbGVjdGlvbi5cbiAgICBjb25zdCBwZWVyU3luY2hyb25pemVyID0gcGVlckNvbGxlY3Rpb24uc3luY2hyb25pemVycy5nZXQodGhpcy5jb2xsZWN0aW9uKTtcbiAgICBpZiAoIXBlZXJTeW5jaHJvbml6ZXIpIHsgLy8gVGhlIG90aGVyIHNpZGUgZG9lc24ndCBrbm93IGFib3V0IHVzIHlldC4gVGhlIG90aGVyIHNpZGUgd2lsbCBkbyB0aGUgd29yay5cbiAgICAgIHRoaXMuX2RlbGF5ID0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IG91clNpZ25hbHMgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbigpO1xuICAgIGNvbnN0IHRoZWlyU2lnbmFscyA9IGF3YWl0IHBlZXJTeW5jaHJvbml6ZXIuc3RhcnRDb25uZWN0aW9uKGF3YWl0IG91clNpZ25hbHMpO1xuICAgIHBlZXJTeW5jaHJvbml6ZXIuX2RlbGF5LnJlc29sdmUoKTtcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuXG4gIC8vIEEgY29tbW9uIHByYWN0aWNlIGhlcmUgaXMgdG8gaGF2ZSBhIHByb3BlcnR5IHRoYXQgaXMgYSBwcm9taXNlIGZvciBoYXZpbmcgc29tZXRoaW5nIGRvbmUuXG4gIC8vIEFzeW5jaHJvbm91cyBtYWNoaW5lcnkgY2FuIHRoZW4gcmVzb2x2ZSBpdC5cbiAgLy8gQW55dGhpbmcgdGhhdCBkZXBlbmRzIG9uIHRoYXQgY2FuIGF3YWl0IHRoZSByZXNvbHZlZCB2YWx1ZSwgd2l0aG91dCB3b3JyeWluZyBhYm91dCBob3cgaXQgZ2V0cyByZXNvbHZlZC5cbiAgLy8gV2UgY2FjaGUgdGhlIHByb21pc2Ugc28gdGhhdCB3ZSBkbyBub3QgcmVwZXRlZGx5IHRyaWdnZXIgdGhlIHVuZGVybHlpbmcgYWN0aW9uLlxuICBtYWtlUmVzb2x2ZWFibGVQcm9taXNlKGlnbm9yZWQpIHsgLy8gQW5zd2VyIGEgUHJvbWlzZSB0aGF0IGNhbiBiZSByZXNvbHZlIHdpdGggdGhlUHJvbWlzZS5yZXNvbHZlKHZhbHVlKS5cbiAgICAvLyBUaGUgaWdub3JlZCBhcmd1bWVudCBpcyBhIGNvbnZlbmllbnQgcGxhY2UgdG8gY2FsbCBzb21ldGhpbmcgZm9yIHNpZGUtZWZmZWN0LlxuICAgIGxldCByZXNvbHZlciwgcmVqZWN0ZXI7XG4gICAgY29uc3QgcHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsgcmVzb2x2ZXIgPSByZXNvbHZlOyByZWplY3RlciA9IHJlamVjdDsgfSk7XG4gICAgcHJvbWlzZS5yZXNvbHZlID0gcmVzb2x2ZXI7XG4gICAgcHJvbWlzZS5yZWplY3QgPSByZWplY3RlcjtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIHZlcnNpb25zKG1pbiwgbWF4KSB7IC8vIE9uIHJlY2VpdmluZyB0aGUgdmVyc2lvbnMgc3VwcG9ydGVkIGJ5IHRoZSB0aGUgcGVlciwgcmVzb2x2ZSB0aGUgdmVyc2lvbiBwcm9taXNlLlxuICAgIGxldCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbjtcbiAgICBjb25zdCBjb21iaW5lZE1heCA9IE1hdGgubWluKG1heCwgdGhpcy5tYXhWZXJzaW9uKTtcbiAgICBjb25zdCBjb21iaW5lZE1pbiA9IE1hdGgubWF4KG1pbiwgdGhpcy5taW5WZXJzaW9uKTtcbiAgICBpZiAoY29tYmluZWRNYXggPj0gY29tYmluZWRNaW4pIHJldHVybiB2ZXJzaW9uUHJvbWlzZS5yZXNvbHZlKGNvbWJpbmVkTWF4KTsgLy8gTm8gbmVlZCB0byByZXNwb25kLCBhcyB0aGV5IHdpbGwgcHJvZHVjZSB0aGUgc2FtZSBkZXRlcm1pbmlzdGljIGFuc3dlci5cbiAgICBjb25zdCBtZXNzYWdlID0gYCR7dGhpcy5zZXJ2aWNlTmFtZX0gcmVxdWlyZXMgYSB2ZXJzaW9uIGJldHdlZW4gJHttaW59IGFuZCAke21heH0sIHdoaWxlIHdlIHJlcXVpcmUgJHt0aGlzLm1pblZlcnNpb259IHRvICR7dGhpcy5tYXhWZXJzaW9ufS5gO1xuICAgIC8vIFRPRE86IEZpbmQgcHJvbWlzZSB0aGF0IHdlIGNhbiByZWplY3QsIHRoYXQgdGhlIGFwcCBjYW4gY2F0Y2ggYW5kIHRlbGwgdGhlIHVzZXIuXG4gICAgY29uc29sZS5sb2cobWVzc2FnZSk7XG4gICAgc2V0VGltZW91dCgoKSA9PiB0aGlzLmRpc2Nvbm5lY3QoKSwgNTAwKTsgLy8gR2l2ZSB0aGUgdHdvIHNpZGVzIHRpbWUgdG8gYWdyZWUuIFl1Y2suXG4gICAgcmV0dXJuIHZlcnNpb25Qcm9taXNlLnJlc29sdmUoMCk7XG4gIH1cbiAgZ2V0IHZlcnNpb24oKSB7IC8vIFByb21pc2UgdGhlIGhpZ2hlc3QgdmVyc2lvbiBzdXBvcnRlZCBieSBib3RoIHNpZGVzLCBvciBkaXNjb25uZWN0IGFuZCBmYWxzeSBpZiBub25lLlxuICAgIC8vIFRlbGxzIHRoZSBvdGhlciBzaWRlIG91ciB2ZXJzaW9ucyBpZiB3ZSBoYXZlbid0IHlldCBkb25lIHNvLlxuICAgIC8vIEZJWE1FOiBjYW4gd2UgYXZvaWQgdGhpcyB0aW1lb3V0P1xuICAgIHJldHVybiB0aGlzLl92ZXJzaW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2Uoc2V0VGltZW91dCgoKSA9PiB0aGlzLnNlbmQoJ3ZlcnNpb25zJywgdGhpcy5taW5WZXJzaW9uLCB0aGlzLm1heFZlcnNpb24pLCAyMDApKTtcbiAgfVxuXG4gIGdldCBzdGFydGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiB3ZSBoYXZlIHN0YXJ0ZWQgc3luY2hyb25pemF0aW9uLlxuICAgIHJldHVybiB0aGlzLl9zdGFydGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLnN0YXJ0U3luY2hyb25pemF0aW9uKCk7XG4gIH1cbiAgZ2V0IGNvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBudW1iZXIgb2YgaXRlbXMgdGhhdCB3ZXJlIHRyYW5zZmVycmVkIChub3QgbmVjZXNzYXJpbGx5IHdyaXR0ZW4pLlxuICAgIC8vIFN0YXJ0cyBzeW5jaHJvbml6YXRpb24gaWYgaXQgaGFzbid0IGFscmVhZHkuIEUuZy4sIHdhaXRpbmcgb24gY29tcGxldGVkU3luY2hyb25pemF0aW9uIHdvbid0IHJlc29sdmUgdW50aWwgYWZ0ZXIgaXQgc3RhcnRzLlxuICAgIHJldHVybiB0aGlzLl9jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSh0aGlzLnN0YXJ0ZWRTeW5jaHJvbml6YXRpb24pO1xuICB9XG4gIGdldCBwZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG51bWJlciBvZiBpdGVtcyB0aGF0IHRoZSBwZWVyIHN5bmNocm9uaXplZC5cbiAgICByZXR1cm4gdGhpcy5fcGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCk7XG4gIH1cbiAgZ2V0IGJvdGhTaWRlc0NvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSByZXNvbHZlcyB0cnV0aHkgd2hlbiBib3RoIHNpZGVzIGFyZSBkb25lLlxuICAgIHJldHVybiB0aGlzLmNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi50aGVuKCgpID0+IHRoaXMucGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbik7XG4gIH1cbiAgYXN5bmMgcmVwb3J0Q29ubmVjdGlvbigpIHsgLy8gTG9nIGNvbm5lY3Rpb24gdGltZSBhbmQgdHlwZS5cbiAgICBjb25zdCBzdGF0cyA9IGF3YWl0IHRoaXMuY29ubmVjdGlvbi5wZWVyLmdldFN0YXRzKCk7XG4gICAgbGV0IHRyYW5zcG9ydDtcbiAgICBmb3IgKGNvbnN0IHJlcG9ydCBvZiBzdGF0cy52YWx1ZXMoKSkge1xuICAgICAgaWYgKHJlcG9ydC50eXBlID09PSAndHJhbnNwb3J0Jykge1xuXHR0cmFuc3BvcnQgPSByZXBvcnQ7XG5cdGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBsZXQgY2FuZGlkYXRlUGFpciA9IHRyYW5zcG9ydCAmJiBzdGF0cy5nZXQodHJhbnNwb3J0LnNlbGVjdGVkQ2FuZGlkYXRlUGFpcklkKTtcbiAgICBpZiAoIWNhbmRpZGF0ZVBhaXIpIHsgLy8gU2FmYXJpIGRvZXNuJ3QgZm9sbG93IHRoZSBzdGFuZGFyZC5cbiAgICAgIGZvciAoY29uc3QgcmVwb3J0IG9mIHN0YXRzLnZhbHVlcygpKSB7XG5cdGlmICgocmVwb3J0LnR5cGUgPT09ICdjYW5kaWRhdGUtcGFpcicpICYmIHJlcG9ydC5zZWxlY3RlZCkge1xuXHQgIGNhbmRpZGF0ZVBhaXIgPSByZXBvcnQ7XG5cdCAgYnJlYWs7XG5cdH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFjYW5kaWRhdGVQYWlyKSB7XG4gICAgICBjb25zb2xlLndhcm4odGhpcy5sYWJlbCwgJ2dvdCBzdGF0cyB3aXRob3V0IGNhbmRpZGF0ZVBhaXInLCBBcnJheS5mcm9tKHN0YXRzLnZhbHVlcygpKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlbW90ZSA9IHN0YXRzLmdldChjYW5kaWRhdGVQYWlyLnJlbW90ZUNhbmRpZGF0ZUlkKTtcbiAgICBjb25zdCB7cHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGV9ID0gcmVtb3RlO1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7c3RhdHMsIHRyYW5zcG9ydCwgY2FuZGlkYXRlUGFpciwgcmVtb3RlLCBwcm90b2NvbCwgY2FuZGlkYXRlVHlwZSwgc3luY2hyb25pemF0aW9uU3RhcnRUaW1lOiBub3d9KTtcbiAgICBjb25zb2xlLmluZm8odGhpcy5sYWJlbCwgJ2Nvbm5lY3RlZCcsIHByb3RvY29sLCBjYW5kaWRhdGVUeXBlLCAoKG5vdyAtIHRoaXMuY29ubmVjdGlvblN0YXJ0VGltZSkvMWUzKS50b0ZpeGVkKDEpKTtcbiAgfVxuICBhc3luYyBzdGFydFN5bmNocm9uaXphdGlvbigpIHsgLy8gV2FpdCBmb3IgYWxsIHByZWxpbWluYXJpZXMsIGFuZCBzdGFydCBzdHJlYW1pbmcgb3VyIHRhZ3MuXG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBpZiAoIWRhdGFDaGFubmVsKSB0aHJvdyBuZXcgRXJyb3IoYE5vIGNvbm5lY3Rpb24gZm9yICR7dGhpcy5sYWJlbH0uYCk7XG4gICAgLy8gTm93IHRoYXQgd2UgYXJlIGNvbm5lY3RlZCwgYW55IG5ldyB3cml0ZXMgb24gb3VyIGVuZCB3aWxsIGJlIHB1c2hlZCB0byB0aGUgcGVlci4gU28gY2FwdHVyZSB0aGUgaW5pdGlhbCB0YWdzIG5vdy5cbiAgICBjb25zdCBvdXJUYWdzID0gbmV3IFNldChhd2FpdCB0aGlzLmNvbGxlY3Rpb24udGFncyk7XG4gICAgYXdhaXQgdGhpcy5yZXBvcnRDb25uZWN0aW9uKCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cbiAgICAgIC8vIEEgc25hcHNob3QgU2V0IG9mIGVhY2ggdGFnIHdlIGhhdmUgbG9jYWxseSwgY2FwdHVyZWQgYXQgdGhlIG1vbWVudCBvZiBjcmVhdGlvbi5cbiAgICAgIG91clRhZ3MsIC8vIChOZXcgbG9jYWwgd3JpdGVzIGFyZSBwdXNoZWQgdG8gdGhlIGNvbm5lY3RlZCBwZWVyLCBldmVuIGR1cmluZyBzeW5jaHJvbml6YXRpb24uKVxuXG4gICAgICAvLyBNYXAgb2YgdGFnIHRvIHByb21pc2UgZm9yIHRhZ3MgdGhhdCBhcmUgYmVpbmcgc3luY2hyb25pemVkLlxuICAgICAgLy8gZW5zdXJlU3luY2hyb25pemVkVGFnIGVuc3VyZXMgdGhhdCB0aGVyZSBpcyBhbiBlbnRyeSBoZXJlIGR1cmluZyB0aGUgdGltZSBhIHRhZyBpcyBpbiBmbGlnaHQuXG4gICAgICB1bnN5bmNocm9uaXplZDogbmV3IE1hcCgpLFxuXG4gICAgICAvLyBTZXQgb2Ygd2hhdCB0YWdzIGhhdmUgYmVlbiBleHBsaWNpdGx5IHN5bmNocm9uaXplZCwgbWVhbmluZyB0aGF0IHRoZXJlIGlzIGEgZGlmZmVyZW5jZSBiZXR3ZWVuIHRoZWlyIGhhc2hcbiAgICAgIC8vIGFuZCBvdXJzLCBzdWNoIHRoYXQgd2UgYXNrIGZvciB0aGVpciBzaWduYXR1cmUgdG8gY29tcGFyZSBpbiBkZXRhaWwuIFRodXMgdGhpcyBzZXQgbWF5IGluY2x1ZGUgaXRlbXMgdGhhdFxuICAgICAgY2hlY2tlZFRhZ3M6IG5ldyBTZXQoKSwgLy8gd2lsbCBub3QgZW5kIHVwIGJlaW5nIHJlcGxhY2VkIG9uIG91ciBlbmQuXG5cbiAgICAgIGVuZE9mUGVlclRhZ3M6IGZhbHNlIC8vIElzIHRoZSBwZWVyIGZpbmlzaGVkIHN0cmVhbWluZz9cbiAgICB9KTtcbiAgICAvLyBOb3cgbmVnb3RpYXRlIHZlcnNpb24gYW5kIGNvbGxlY3RzIHRoZSB0YWdzLlxuICAgIGF3YWl0IHRoaXMudmVyc2lvbjtcbiAgICB0aGlzLnN0cmVhbVRhZ3Mob3VyVGFncyk7IC8vIEJ1dCBkbyBub3Qgd2FpdCBmb3IgaXQuXG4gIH1cbiAgYXN5bmMgY29tcHV0ZUhhc2godGV4dCkgeyAvLyBPdXIgc3RhbmRhcmQgaGFzaC4gKFN0cmluZyBzbyB0aGF0IGl0IGlzIHNlcmlhbGl6YWJsZS4pXG4gICAgY29uc3QgaGFzaCA9IGF3YWl0IENyZWRlbnRpYWxzLmhhc2hUZXh0KHRleHQpO1xuICAgIHJldHVybiBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoaGFzaCk7XG4gIH1cbiAgYXN5bmMgZ2V0SGFzaCh0YWcpIHsgLy8gV2hvbGUgc2lnbmF0dXJlIChOT1QgcHJvdGVjdGVkSGVhZGVyLnN1YiBvZiBjb250ZW50KS5cbiAgICBjb25zdCByYXcgPSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gICAgcmV0dXJuIHRoaXMuY29tcHV0ZUhhc2gocmF3IHx8ICdtaXNzaW5nJyk7XG4gIH1cbiAgYXN5bmMgc3RyZWFtVGFncyh0YWdzKSB7IC8vIFNlbmQgZWFjaCBvZiBvdXIga25vd24gdGFnL2hhc2ggcGFpcnMgdG8gcGVlciwgb25lIGF0IGEgdGltZSwgZm9sbG93ZWQgYnkgZW5kT2ZUYWdzLlxuICAgIGZvciAoY29uc3QgdGFnIG9mIHRhZ3MpIHtcbiAgICAgIHRoaXMuc2VuZCgnaGFzaCcsIHRhZywgYXdhaXQgdGhpcy5nZXRIYXNoKHRhZykpO1xuICAgIH1cbiAgICB0aGlzLnNlbmQoJ2VuZFRhZ3MnKTtcbiAgfVxuICBhc3luYyBlbmRUYWdzKCkgeyAvLyBUaGUgcGVlciBoYXMgZmluaXNoZWQgc3RyZWFtVGFncygpLlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICB0aGlzLmVuZE9mUGVlclRhZ3MgPSB0cnVlO1xuICAgIHRoaXMuY2xlYW5VcElmRmluaXNoZWQoKTtcbiAgfVxuICBzeW5jaHJvbml6YXRpb25Db21wbGV0ZShuQ2hlY2tlZCkgeyAvLyBUaGUgcGVlciBoYXMgZmluaXNoZWQgZ2V0dGluZyBhbGwgdGhlIGRhdGEgaXQgbmVlZHMgZnJvbSB1cy5cbiAgICB0aGlzLnBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24ucmVzb2x2ZShuQ2hlY2tlZCk7XG4gIH1cbiAgY2xlYW5VcElmRmluaXNoZWQoKSB7IC8vIElmIHdlIGFyZSBub3Qgd2FpdGluZyBmb3IgYW55dGhpbmcsIHdlJ3JlIGRvbmUuIENsZWFuIHVwLlxuICAgIC8vIFRoaXMgcmVxdWlyZXMgdGhhdCB0aGUgcGVlciBoYXMgaW5kaWNhdGVkIHRoYXQgaXQgaXMgZmluaXNoZWQgc3RyZWFtaW5nIHRhZ3MsXG4gICAgLy8gYW5kIHRoYXQgd2UgYXJlIG5vdCB3YWl0aW5nIGZvciBhbnkgZnVydGhlciB1bnN5bmNocm9uaXplZCBpdGVtcy5cbiAgICBpZiAoIXRoaXMuZW5kT2ZQZWVyVGFncyB8fCB0aGlzLnVuc3luY2hyb25pemVkLnNpemUpIHJldHVybjtcbiAgICBjb25zdCBuQ2hlY2tlZCA9IHRoaXMuY2hlY2tlZFRhZ3Muc2l6ZTsgLy8gVGhlIG51bWJlciB0aGF0IHdlIGNoZWNrZWQuXG4gICAgdGhpcy5zZW5kKCdzeW5jaHJvbml6YXRpb25Db21wbGV0ZScsIG5DaGVja2VkKTtcbiAgICB0aGlzLmNoZWNrZWRUYWdzLmNsZWFyKCk7XG4gICAgdGhpcy51bnN5bmNocm9uaXplZC5jbGVhcigpO1xuICAgIHRoaXMub3VyVGFncyA9IHRoaXMuc3luY2hyb25pemVkID0gdGhpcy51bnN5bmNocm9uaXplZCA9IG51bGw7XG4gICAgY29uc29sZS5pbmZvKHRoaXMubGFiZWwsICdjb21wbGV0ZWQgc3luY2hyb25pemF0aW9uJywgbkNoZWNrZWQsICdpdGVtcyBpbicsICgoRGF0ZS5ub3coKSAtIHRoaXMuc3luY2hyb25pemF0aW9uU3RhcnRUaW1lKS8xZTMpLnRvRml4ZWQoMSksICdzZWNvbmRzJyk7XG4gICAgdGhpcy5jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24ucmVzb2x2ZShuQ2hlY2tlZCk7XG4gIH1cbiAgc3luY2hyb25pemF0aW9uUHJvbWlzZSh0YWcpIHsgLy8gUmV0dXJuIHNvbWV0aGluZyB0byBhd2FpdCB0aGF0IHJlc29sdmVzIHdoZW4gdGFnIGlzIHN5bmNocm9uaXplZC5cbiAgICAvLyBXaGVuZXZlciBhIGNvbGxlY3Rpb24gbmVlZHMgdG8gcmV0cmlldmUgKGdldFZlcmlmaWVkKSBhIHRhZyBvciBmaW5kIHRhZ3MgbWF0Y2hpbmcgcHJvcGVydGllcywgaXQgZW5zdXJlc1xuICAgIC8vIHRoZSBsYXRlc3QgZGF0YSBieSBjYWxsaW5nIHRoaXMgYW5kIGF3YWl0aW5nIHRoZSBkYXRhLlxuICAgIGlmICghdGhpcy51bnN5bmNocm9uaXplZCkgcmV0dXJuIHRydWU7IC8vIFdlIGhhdmUgZnVsbHkgc3luY2hyb25pemVkIGFsbCB0YWdzLiBJZiB0aGVyZSBpcyBuZXcgZGF0YSwgaXQgd2lsbCBiZSBzcG9udGFuZW91c2x5IHB1c2hlZCB0byB1cy5cbiAgICBpZiAodGhpcy5jaGVja2VkVGFncy5oYXModGFnKSkgcmV0dXJuIHRydWU7IC8vIFRoaXMgcGFydGljdWxhciB0YWcgaGFzIGJlZW4gY2hlY2tlZC5cbiAgICAvLyAoSWYgY2hlY2tlZFRhZ3Mgd2FzIG9ubHkgdGhvc2UgZXhjaGFuZ2VkIG9yIHdyaXR0ZW4sIHdlIHdvdWxkIGhhdmUgZXh0cmEgZmxpZ2h0cyBjaGVja2luZy4pXG4gICAgLy8gSWYgYSByZXF1ZXN0IGlzIGluIGZsaWdodCwgcmV0dXJuIHRoYXQgcHJvbWlzZS4gT3RoZXJ3aXNlIGNyZWF0ZSBvbmUuXG4gICAgcmV0dXJuIHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZykgfHwgdGhpcy5lbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCAnJywgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG5cbiAgYXN5bmMgaGFzaCh0YWcsIGhhc2gpIHsgLy8gUmVjZWl2ZSBhIFt0YWcsIGhhc2hdIHRoYXQgdGhlIHBlZXIga25vd3MgYWJvdXQuIChQZWVyIHN0cmVhbXMgemVybyBvciBtb3JlIG9mIHRoZXNlIHRvIHVzLilcbiAgICAvLyBVbmxlc3MgYWxyZWFkeSBpbiBmbGlnaHQsIHdlIHdpbGwgZW5zdXJlU3luY2hyb25pemVkVGFnIHRvIHN5bmNocm9uaXplIGl0LlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICBjb25zdCB7b3VyVGFncywgdW5zeW5jaHJvbml6ZWR9ID0gdGhpcztcbiAgICB0aGlzLmxvZygncmVjZWl2ZWQgXCJoYXNoXCInLCB7dGFnLCBoYXNoLCBvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0pO1xuICAgIGlmICh1bnN5bmNocm9uaXplZC5oYXModGFnKSkgcmV0dXJuIG51bGw7IC8vIEFscmVhZHkgaGFzIGFuIGludmVzdGlnYXRpb24gaW4gcHJvZ3Jlc3MgKGUuZywgZHVlIHRvIGxvY2FsIGFwcCBzeW5jaHJvbml6YXRpb25Qcm9taXNlKS5cbiAgICBpZiAoIW91clRhZ3MuaGFzKHRhZykpIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gpOyAvLyBXZSBkb24ndCBoYXZlIHRoZSByZWNvcmQgYXQgYWxsLlxuICAgIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gsIHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgfVxuICBlbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCB0aGVpckhhc2ggPSAnJywgb3VySGFzaFByb21pc2UgPSBudWxsKSB7XG4gICAgLy8gU3luY2hyb25vdXNseSByZWNvcmQgKGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXApIGEgcHJvbWlzZSB0byAoY29uY2VwdHVhbGx5KSByZXF1ZXN0IHRoZSB0YWcgZnJvbSB0aGUgcGVlcixcbiAgICAvLyBwdXQgaXQgaW4gdGhlIGNvbGxlY3Rpb24sIGFuZCBjbGVhbnVwIHRoZSBib29ra2VlcGluZy4gUmV0dXJuIHRoYXQgcHJvbWlzZS5cbiAgICAvLyBIb3dldmVyLCBpZiB3ZSBhcmUgZ2l2ZW4gaGFzaGVzIHRvIGNvbXBhcmUgYW5kIHRoZXkgbWF0Y2gsIHdlIGNhbiBza2lwIHRoZSByZXF1ZXN0L3B1dCBhbmQgcmVtb3ZlIGZyb20gdW5zeWNocm9uaXplZCBvbiBuZXh0IHRpY2suXG4gICAgLy8gKFRoaXMgbXVzdCByZXR1cm4gYXRvbWljYWxseSBiZWNhdXNlIGNhbGxlciBoYXMgY2hlY2tlZCB2YXJpb3VzIGJvb2trZWVwaW5nIGF0IHRoYXQgbW9tZW50LiBDaGVja2luZyBtYXkgcmVxdWlyZSB0aGF0IHdlIGF3YWl0IG91ckhhc2hQcm9taXNlLilcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHsgLy8gTmV4dCB0aWNrLiBTZWUgcmVxdWVzdCgpLlxuXHRpZiAoIXRoZWlySGFzaCB8fCAhb3VySGFzaFByb21pc2UgfHwgKHRoZWlySGFzaCAhPT0gYXdhaXQgb3VySGFzaFByb21pc2UpKSB7XG5cdCAgY29uc3QgdGhlaXJEYXRhID0gYXdhaXQgdGhpcy5yZXF1ZXN0KHRhZyk7XG5cdCAgLy8gTWlnaHQgaGF2ZSBiZWVuIHRyaWdnZXJlZCBieSBvdXIgYXBwIHJlcXVlc3RpbmcgdGhpcyB0YWcgYmVmb3JlIHdlIHdlcmUgc3luYydkLiBTbyB0aGV5IG1pZ2h0IG5vdCBoYXZlIHRoZSBkYXRhLlxuXHQgIGlmICh0aGVpckRhdGE/Lmxlbmd0aCkge1xuXHQgICAgaWYgKGF3YWl0IHRoaXMuY29sbGVjdGlvbi5wdXQodGFnLCB0aGVpckRhdGEsIHRoaXMpKSB7XG5cdCAgICAgIHRoaXMubG9nKCdyZWNlaXZlZC9wdXQnLCB0YWcsICd0aGVpci9vdXIgaGFzaDonLCB0aGVpckhhc2ggfHwgJ21pc3NpbmdUaGVpcnMnLCAoYXdhaXQgb3VySGFzaFByb21pc2UpIHx8ICdtaXNzaW5nT3VycycsIHRoZWlyRGF0YT8ubGVuZ3RoKTtcblx0ICAgIH0gZWxzZSB7XG5cdCAgICAgIHRoaXMubG9nKCd1bmFibGUgdG8gcHV0JywgdGFnKTtcblx0ICAgIH1cblx0ICB9XG5cdH1cblx0dGhpcy5jaGVja2VkVGFncy5hZGQodGFnKTsgICAgICAgLy8gRXZlcnl0aGluZyB3ZSd2ZSBleGFtaW5lZCwgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIHdlIGFza2VkIGZvciBvciBzYXZlZCBkYXRhIGZyb20gcGVlci4gKFNlZSBzeW5jaHJvbml6YXRpb25Qcm9taXNlKVxuXHR0aGlzLnVuc3luY2hyb25pemVkLmRlbGV0ZSh0YWcpOyAvLyBVbmNvbmRpdGlvbmFsbHksIGJlY2F1c2Ugd2Ugc2V0IGl0IHVuY29uZGl0aW9uYWxseS5cblx0dGhpcy5jbGVhblVwSWZGaW5pc2hlZCgpO1xuXHRyZXNvbHZlKCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICB0aGlzLnVuc3luY2hyb25pemVkLnNldCh0YWcsIHByb21pc2UpOyAvLyBVbmNvbmRpdGlvbmFsbHksIGluIGNhc2Ugd2UgbmVlZCB0byBrbm93IHdlJ3JlIGxvb2tpbmcgZHVyaW5nIHRoZSB0aW1lIHdlJ3JlIGxvb2tpbmcuXG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgcmVxdWVzdCh0YWcpIHsgLy8gTWFrZSBhIHJlcXVlc3QgZm9yIHRhZyBmcm9tIHRoZSBwZWVyLCBhbmQgYW5zd2VyIGEgcHJvbWlzZSB0aGUgcmVzb2x2ZXMgd2l0aCB0aGUgZGF0YS5cbiAgICAvKmNvbnN0IHsgaG9zdFJlcXVlc3RCYXNlIH0gPSB0aGlzO1xuICAgIGlmIChob3N0UmVxdWVzdEJhc2UpIHtcbiAgICAgIC8vIEUuZy4sIGEgbG9jYWxob3N0IHJvdXRlciBtaWdodCBzdXBwb3J0IGEgZ2V0IG9mIGh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvTXV0YWJsZUNvbGxlY3Rpb24vY29tLmtpMXIweS53aGF0ZXZlci9fdC91TC9CQWNXX0xOQUphL2NKV211bWJsZVxuICAgICAgLy8gU28gaG9zdFJlcXVlc3RCYXNlIHNob3VsZCBiZSBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvTXV0YWJsZUNvbGxlY3Rpb24vY29tLmtpMXIweS53aGF0ZXZlclwiLFxuICAgICAgLy8gYW5kIHNlcnZpY2VOYW1lIHNob3VsZCBiZSBzb21ldGhpbmcgbGlrZSBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvc3luY1wiXG4gICAgICByZXR1cm4gZmV0Y2godGFnUGF0aChob3N0UmVxdWVzdEJhc2UsIHRhZykpLnRoZW4ocmVzcG9uc2UgPT4gcmVzcG9uc2UudGV4dCgpKTtcbiAgICB9Ki9cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHRoaXMuc2VuZCgnZ2V0JywgdGFnKSk7XG4gICAgLy8gU3VidGxlOiBXaGVuIHRoZSAncHV0JyBjb21lcyBiYWNrLCB3ZSB3aWxsIG5lZWQgdG8gcmVzb2x2ZSB0aGlzIHByb21pc2UuIEJ1dCBob3cgd2lsbCAncHV0JyBmaW5kIHRoZSBwcm9taXNlIHRvIHJlc29sdmUgaXQ/XG4gICAgLy8gQXMgaXQgdHVybnMgb3V0LCB0byBnZXQgaGVyZSwgd2UgaGF2ZSBuZWNlc3NhcmlsbHkgc2V0IHRhZyBpbiB0aGUgdW5zeW5jaHJvbml6ZWQgbWFwLiBcbiAgICBjb25zdCBub3RlZCA9IHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZyk7IC8vIEEgcHJvbWlzZSB0aGF0IGRvZXMgbm90IGhhdmUgYW4gZXhwb3NlZCAucmVzb2x2ZSwgYW5kIHdoaWNoIGRvZXMgbm90IGV4cGVjdCBhbnkgdmFsdWUuXG4gICAgbm90ZWQucmVzb2x2ZSA9IHByb21pc2UucmVzb2x2ZTsgLy8gVGFjayBvbiBhIHJlc29sdmUgZm9yIE9VUiBwcm9taXNlIG9udG8gdGhlIG5vdGVkIG9iamVjdCAod2hpY2ggY29uZnVzaW5nbHksIGhhcHBlbnMgdG8gYmUgYSBwcm9taXNlKS5cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICBhc3luYyBnZXQodGFnKSB7IC8vIFJlc3BvbmQgdG8gYSBwZWVyJ3MgZ2V0KCkgcmVxdWVzdCBieSBzZW5kaW5nIGEgcHV0IHJlcG9uc2Ugd2l0aCB0aGUgZGF0YS5cbiAgICBjb25zdCBkYXRhID0gYXdhaXQgdGhpcy5jb2xsZWN0aW9uLmdldCh0YWcpO1xuICAgIHRoaXMucHVzaCgncHV0JywgdGFnLCBkYXRhKTtcbiAgfVxuICBwdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpIHsgLy8gVGVsbCB0aGUgb3RoZXIgc2lkZSBhYm91dCBhIHNpZ25lZCB3cml0ZS5cbiAgICB0aGlzLnNlbmQob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSk7XG4gIH1cbiAgYXN5bmMgcHV0KHRhZywgc2lnbmF0dXJlKSB7IC8vIFJlY2VpdmUgYSBwdXQgbWVzc2FnZSBmcm9tIHRoZSBwZWVyLlxuICAgIC8vIElmIGl0IGlzIGEgcmVzcG9uc2UgdG8gYSBnZXQoKSByZXF1ZXN0LCByZXNvbHZlIHRoZSBjb3JyZXNwb25kaW5nIHByb21pc2UuXG4gICAgY29uc3QgcHJvbWlzZSA9IHRoaXMudW5zeW5jaHJvbml6ZWQ/LmdldCh0YWcpO1xuICAgIC8vIFJlZ2FyZGxlc3Mgb2Ygd2h5IHRoZSBvdGhlciBzaWRlIGlzIHNlbmRpbmcsIGlmIHdlIGhhdmUgYW4gb3V0c3RhbmRpbmcgcmVxdWVzdCwgY29tcGxldGUgaXQuXG4gICAgaWYgKHByb21pc2UpIHByb21pc2UucmVzb2x2ZShzaWduYXR1cmUpO1xuICAgIGVsc2UgYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnB1dCh0YWcsIHNpZ25hdHVyZSwgdGhpcyk7IC8vIE90aGVyd2lzZSwganVzdCB0cnkgdG8gd3JpdGUgaXQgbG9jYWxseS5cbiAgfVxuICBkZWxldGUodGFnLCBzaWduYXR1cmUpIHsgLy8gUmVjZWl2ZSBhIGRlbGV0ZSBtZXNzYWdlIGZyb20gdGhlIHBlZXIuXG4gICAgdGhpcy5jb2xsZWN0aW9uLmRlbGV0ZSh0YWcsIHNpZ25hdHVyZSwgdGhpcyk7XG4gIH1cbn1cbmV4cG9ydCBkZWZhdWx0IFN5bmNocm9uaXplcjtcbiIsImNsYXNzIENhY2hlIGV4dGVuZHMgTWFwe2NvbnN0cnVjdG9yKGUsdD0wKXtzdXBlcigpLHRoaXMubWF4U2l6ZT1lLHRoaXMuZGVmYXVsdFRpbWVUb0xpdmU9dCx0aGlzLl9uZXh0V3JpdGVJbmRleD0wLHRoaXMuX2tleUxpc3Q9QXJyYXkoZSksdGhpcy5fdGltZXJzPW5ldyBNYXB9c2V0KGUsdCxzPXRoaXMuZGVmYXVsdFRpbWVUb0xpdmUpe2xldCBpPXRoaXMuX25leHRXcml0ZUluZGV4O3RoaXMuZGVsZXRlKHRoaXMuX2tleUxpc3RbaV0pLHRoaXMuX2tleUxpc3RbaV09ZSx0aGlzLl9uZXh0V3JpdGVJbmRleD0oaSsxKSV0aGlzLm1heFNpemUsdGhpcy5fdGltZXJzLmhhcyhlKSYmY2xlYXJUaW1lb3V0KHRoaXMuX3RpbWVycy5nZXQoZSkpLHN1cGVyLnNldChlLHQpLHMmJnRoaXMuX3RpbWVycy5zZXQoZSxzZXRUaW1lb3V0KCgoKT0+dGhpcy5kZWxldGUoZSkpLHMpKX1kZWxldGUoZSl7cmV0dXJuIHRoaXMuX3RpbWVycy5oYXMoZSkmJmNsZWFyVGltZW91dCh0aGlzLl90aW1lcnMuZ2V0KGUpKSx0aGlzLl90aW1lcnMuZGVsZXRlKGUpLHN1cGVyLmRlbGV0ZShlKX1jbGVhcihlPXRoaXMubWF4U2l6ZSl7dGhpcy5tYXhTaXplPWUsdGhpcy5fa2V5TGlzdD1BcnJheShlKSx0aGlzLl9uZXh0V3JpdGVJbmRleD0wLHN1cGVyLmNsZWFyKCk7Zm9yKGNvbnN0IGUgb2YgdGhpcy5fdGltZXJzLnZhbHVlcygpKWNsZWFyVGltZW91dChlKTt0aGlzLl90aW1lcnMuY2xlYXIoKX19Y2xhc3MgU3RvcmFnZUJhc2V7Y29uc3RydWN0b3Ioe25hbWU6ZSxiYXNlTmFtZTp0PVwiU3RvcmFnZVwiLG1heFNlcmlhbGl6ZXJTaXplOnM9MWUzLGRlYnVnOmk9ITF9KXtjb25zdCBhPWAke3R9LyR7ZX1gLHI9bmV3IENhY2hlKHMpO09iamVjdC5hc3NpZ24odGhpcyx7bmFtZTplLGJhc2VOYW1lOnQsZnVsbE5hbWU6YSxkZWJ1ZzppLHNlcmlhbGl6ZXI6cn0pfWFzeW5jIGxpc3QoKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoXCJcIiwoKGUsdCk9PnRoaXMubGlzdEludGVybmFsKHQsZSkpKX1hc3luYyBnZXQoZSl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKGUsKChlLHQpPT50aGlzLmdldEludGVybmFsKHQsZSkpKX1hc3luYyBkZWxldGUoZSl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKGUsKChlLHQpPT50aGlzLmRlbGV0ZUludGVybmFsKHQsZSkpKX1hc3luYyBwdXQoZSx0KXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUscyk9PnRoaXMucHV0SW50ZXJuYWwocyx0LGUpKSl9bG9nKC4uLmUpe3RoaXMuZGVidWcmJmNvbnNvbGUubG9nKHRoaXMubmFtZSwuLi5lKX1hc3luYyBzZXJpYWxpemUoZSx0KXtjb25zdHtzZXJpYWxpemVyOnMscmVhZHk6aX09dGhpcztsZXQgYT1zLmdldChlKXx8aTtyZXR1cm4gYT1hLnRoZW4oKGFzeW5jKCk9PnQoYXdhaXQgdGhpcy5yZWFkeSx0aGlzLnBhdGgoZSkpKSkscy5zZXQoZSxhKSxhd2FpdCBhfX1jb25zdHtSZXNwb25zZTplLFVSTDp0fT1nbG9iYWxUaGlzO2NsYXNzIFN0b3JhZ2VDYWNoZSBleHRlbmRzIFN0b3JhZ2VCYXNle2NvbnN0cnVjdG9yKC4uLmUpe3N1cGVyKC4uLmUpLHRoaXMuc3RyaXBwZXI9bmV3IFJlZ0V4cChgXi8ke3RoaXMuZnVsbE5hbWV9L2ApLHRoaXMucmVhZHk9Y2FjaGVzLm9wZW4odGhpcy5mdWxsTmFtZSl9YXN5bmMgbGlzdEludGVybmFsKGUsdCl7cmV0dXJuKGF3YWl0IHQua2V5cygpfHxbXSkubWFwKChlPT50aGlzLnRhZyhlLnVybCkpKX1hc3luYyBnZXRJbnRlcm5hbChlLHQpe2NvbnN0IHM9YXdhaXQgdC5tYXRjaChlKTtyZXR1cm4gcz8uanNvbigpfWRlbGV0ZUludGVybmFsKGUsdCl7cmV0dXJuIHQuZGVsZXRlKGUpfXB1dEludGVybmFsKHQscyxpKXtyZXR1cm4gaS5wdXQodCxlLmpzb24ocykpfXBhdGgoZSl7cmV0dXJuYC8ke3RoaXMuZnVsbE5hbWV9LyR7ZX1gfXRhZyhlKXtyZXR1cm4gbmV3IHQoZSkucGF0aG5hbWUucmVwbGFjZSh0aGlzLnN0cmlwcGVyLFwiXCIpfWRlc3Ryb3koKXtyZXR1cm4gY2FjaGVzLmRlbGV0ZSh0aGlzLmZ1bGxOYW1lKX19ZXhwb3J0e1N0b3JhZ2VDYWNoZSBhcyBTdG9yYWdlTG9jYWwsU3RvcmFnZUNhY2hlIGFzIGRlZmF1bHR9O1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHsgU3RvcmFnZUxvY2FsIH0gZnJvbSAnQGtpMXIweS9zdG9yYWdlJztcbmltcG9ydCBTeW5jaHJvbml6ZXIgZnJvbSAnLi9zeW5jaHJvbml6ZXIubWpzJztcbmltcG9ydCB7IHN0b3JhZ2VOYW1lLCBzdG9yYWdlVmVyc2lvbiB9IGZyb20gJy4vdmVyc2lvbi5tanMnO1xuY29uc3QgeyBDdXN0b21FdmVudCwgRXZlbnRUYXJnZXQsIFRleHREZWNvZGVyIH0gPSBnbG9iYWxUaGlzO1xuXG4vLyBUT0RPPzogU2hvdWxkIHZlcmZpZWQvdmFsaWRhdGVkIGJlIGl0cyBvd24gb2JqZWN0IHdpdGggbWV0aG9kcz9cblxuZXhwb3J0IGNsYXNzIENvbGxlY3Rpb24gZXh0ZW5kcyBFdmVudFRhcmdldCB7XG5cbiAgY29uc3RydWN0b3Ioe25hbWUsIGxhYmVsID0gbmFtZSwgc2VydmljZXMgPSBbXSwgcHJlc2VydmVEZWxldGlvbnMgPSAhIXNlcnZpY2VzLmxlbmd0aCxcblx0ICAgICAgIHBlcnNpc3RlbmNlQ2xhc3MgPSBTdG9yYWdlTG9jYWwsIGRiVmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uLCBwZXJzaXN0ZW5jZUJhc2UgPSBgJHtzdG9yYWdlTmFtZX1fJHtkYlZlcnNpb259YCxcblx0ICAgICAgIGRlYnVnID0gZmFsc2UsIG11bHRpcGxleCwgLy8gQ2F1c2VzIHN5bmNocm9uaXphdGlvbiB0byByZXVzZSBjb25uZWN0aW9ucyBmb3IgZGlmZmVyZW50IENvbGxlY3Rpb25zIG9uIHRoZSBzYW1lIHNlcnZpY2UuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsLCByZXN0cmljdGVkVGFnc30pIHtcbiAgICBzdXBlcigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge25hbWUsIGxhYmVsLCBwcmVzZXJ2ZURlbGV0aW9ucywgcGVyc2lzdGVuY2VDbGFzcywgZGJWZXJzaW9uLCBtdWx0aXBsZXgsIGRlYnVnLCBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsLFxuXHRcdFx0IGZ1bGxOYW1lOiBgJHt0aGlzLmNvbnN0cnVjdG9yLm5hbWV9LyR7bmFtZX1gLCBmdWxsTGFiZWw6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtsYWJlbH1gfSk7XG4gICAgaWYgKHJlc3RyaWN0ZWRUYWdzKSB0aGlzLnJlc3RyaWN0ZWRUYWdzID0gcmVzdHJpY3RlZFRhZ3M7XG4gICAgdGhpcy5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgcGVyc2lzdGVuY2VPcHRpb25zID0ge25hbWU6IHRoaXMuZnVsbExhYmVsLCBiYXNlTmFtZTogcGVyc2lzdGVuY2VCYXNlLCBkZWJ1ZzogZGVidWd9O1xuICAgIGlmIChwZXJzaXN0ZW5jZUNsYXNzLnRoZW4pIHRoaXMucGVyc2lzdGVuY2VTdG9yZSA9IHBlcnNpc3RlbmNlQ2xhc3MudGhlbihraW5kID0+IG5ldyBraW5kKHBlcnNpc3RlbmNlT3B0aW9ucykpO1xuICAgIGVsc2UgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gbmV3IHBlcnNpc3RlbmNlQ2xhc3MocGVyc2lzdGVuY2VPcHRpb25zKTtcbiAgfVxuXG4gIGFzeW5jIGNsb3NlKCkge1xuICAgIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmNsb3NlKCk7XG4gIH1cbiAgYXN5bmMgZGVzdHJveSgpIHtcbiAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3QoKTtcbiAgICBjb25zdCBzdG9yZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBkZWxldGUgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIGlmIChzdG9yZSkgYXdhaXQgc3RvcmUuZGVzdHJveSgpO1xuICB9XG5cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7IC8vIENhbiBiZSBvdmVycmlkZGVuIGJ5IHRoZSBjbGllbnRcbiAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgfVxuICAvLyBDcmVkZW50aWFscy5zaWduLy52ZXJpZnkgY2FuIHByb2R1Y2UvYWNjZXB0IEpTT04gT0JKRUNUUyBmb3IgdGhlIG5hbWVkIFwiSlNPTiBTZXJpYWxpemF0aW9uXCIgZm9ybS5cbiAgLy8gQXMgaXQgaGFwcGVucywgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgY2FuIGRpc3Rpbmd1aXNoIGJldHdlZW4gYSBjb21wYWN0IHNlcmlhbGl6YXRpb24gKGJhc2U2NCB0ZXh0KVxuICAvLyB2cyBhbiBvYmplY3QsIGJ1dCBpdCBkb2VzIG5vdCByZWNvZ25pemUgYSBTRVJJQUxJWkVEIG9iamVjdC4gSGVyZSB3ZSBib3R0bGVuZWNrIHRob3NlIG9wZXJhdGlvbnNcbiAgLy8gc3VjaCB0aGF0IHRoZSB0aGluZyB0aGF0IGlzIGFjdHVhbGx5IHBlcnNpc3RlZCBhbmQgc3luY2hyb25pemVkIGlzIGFsd2F5cyBhIHN0cmluZyAtLSBlaXRoZXIgYmFzZTY0XG4gIC8vIGNvbXBhY3Qgb3IgSlNPTiBiZWdpbm5pbmcgd2l0aCBhIFwie1wiICh3aGljaCBhcmUgZGlzdGluZ3Vpc2hhYmxlIGJlY2F1c2UgXCJ7XCIgaXMgbm90IGEgYmFzZTY0IGNoYXJhY3RlcikuXG4gIHN0YXRpYyBlbnN1cmVTdHJpbmcoc2lnbmF0dXJlKSB7IC8vIFJldHVybiBhIHNpZ25hdHVyZSB0aGF0IGlzIGRlZmluYXRlbHkgYSBzdHJpbmcuXG4gICAgaWYgKHR5cGVvZihzaWduYXR1cmUpICE9PSAnc3RyaW5nJykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBSZXR1cm4gYSBjb21wYWN0IG9yIFwiSlNPTlwiIChvYmplY3QpIGZvcm0gb2Ygc2lnbmF0dXJlIChpbmZsYXRpbmcgYSBzZXJpYWxpemF0aW9uIG9mIHRoZSBsYXR0ZXIgaWYgbmVlZGVkKSwgYnV0IG5vdCBhIEpTT04gc3RyaW5nLlxuICBzdGF0aWMgbWF5YmVJbmZsYXRlKHNpZ25hdHVyZSkge1xuICAgIGlmIChzaWduYXR1cmU/LnN0YXJ0c1dpdGg/LihcIntcIikpIHJldHVybiBKU09OLnBhcnNlKHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICBzdGF0aWMgYXN5bmMgc2lnbihkYXRhLCBvcHRpb25zKSB7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgQ3JlZGVudGlhbHMuc2lnbihkYXRhLCBvcHRpb25zKTtcbiAgICByZXR1cm4gdGhpcy5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgc2lnbmF0dXJlID0gdGhpcy5tYXliZUluZmxhdGUoc2lnbmF0dXJlKTtcbiAgICAvLyBXZSBkb24ndCBkbyBcImRlZXBcIiB2ZXJpZmljYXRpb24gaGVyZSAtIGUuZy4sIGNoZWNraW5nIHRoYXQgdGhlIGFjdCBpcyBhIG1lbWJlciBvZiBpc3MsIGFuZCB0aGUgaWF0IGlzIGFmdGVyIHRoZSBleGlzdGluZyBpYXQuXG4gICAgLy8gSW5zdGVhZCwgd2UgZG8gb3VyIG93biBkZWVwIGNoZWNrcyBpbiB2YWxpZGF0ZUZvcldyaXRpbmcuXG4gICAgLy8gVGhlIG1lbWJlci9ub3RCZWZvcmUgc2hvdWxkIGNoZWNrIG91dCBhbnl3YXkgLS0gaS5lLiwgd2UgY291bGQgbGVhdmUgaXQgaW4sIGV4Y2VwdCBpbiBzeW5jaHJvbml6aW5nXG4gICAgLy8gQ3JlZGVudGlhbC5jb2xsZWN0aW9ucy4gVGhlcmUgaXMgbm8gbWVjaGFuaXNtIChjdXJyZW50bHkpIGZvciB0aGVcbiAgICAvLyBzeW5jaHJvbml6YXRpb24gdG8gaGFwcGVuIGluIGFuIG9yZGVyIHRoYXQgd2lsbCByZXN1bHQgaW4gdGhlIGRlcGVuZGVuY2llcyBjb21pbmcgb3ZlciBiZWZvcmUgdGhlIGl0ZW1zIHRoYXQgY29uc3VtZSB0aGVtLlxuICAgIGNvbnN0IHZlcmlmaWVkID0gIGF3YWl0IENyZWRlbnRpYWxzLnZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMpO1xuICAgIGlmICh2ZXJpZmllZCkgdmVyaWZpZWQuc2lnbmF0dXJlID0gc2lnbmF0dXJlO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICAvLyBUaGUgdHlwZSBvZiBKV0UgdGhhdCBnZXRzIHNpZ25lZCAobm90IHRoZSBjdHkgb2YgdGhlIEpXRSkuIFdlIGF1dG9tYXRpY2FsbHkgdHJ5IHRvIGRlY3J5cHQgYSBKV1MgcGF5bG9hZCBvZiB0aGlzIHR5cGUuXG4gIHN0YXRpYyBlbmNyeXB0ZWRNaW1lVHlwZSA9ICd0ZXh0L2VuY3J5cHRlZCc7XG4gIHN0YXRpYyBhc3luYyBlbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpIHsgLy8gUHJvbWlzZSB2ZXJmaWVkIGFmdGVyIGZpcnN0IGF1Z21lbnRpbmcgd2l0aCBkZWNyeXB0ZWQgZGF0YSBhcyBuZWVkZWQuXG4gICAgaWYgKHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5jdHkgIT09IHRoaXMuZW5jcnlwdGVkTWltZVR5cGUpIHJldHVybiB2ZXJpZmllZDtcbiAgICBpZiAodmVyaWZpZWQuZGVjcnlwdGVkKSByZXR1cm4gdmVyaWZpZWQ7IC8vIEFscmVhZHkgZGVjcnlwdGVkLlxuICAgIGNvbnN0IGRlY3J5cHRlZCA9IGF3YWl0IENyZWRlbnRpYWxzLmRlY3J5cHQodmVyaWZpZWQudGV4dCk7XG4gICAgdmVyaWZpZWQuanNvbiA9IGRlY3J5cHRlZC5qc29uO1xuICAgIHZlcmlmaWVkLnRleHQgPSBkZWNyeXB0ZWQudGV4dDtcbiAgICB2ZXJpZmllZC5wYXlsb2FkID0gZGVjcnlwdGVkLnBheWxvYWQ7XG4gICAgdmVyaWZpZWQuZGVjcnlwdGVkID0gZGVjcnlwdGVkO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuXG4gIGFzeW5jIG1heWJlUmVzdHJpY3QoY2FsbGJhY2spIHtcbiAgICAvLyBJZiB0aGlzIGNvbGxlY3Rpb24gcmVzdHJpY3RzIHVzYWJsZSB0YWdzIGZvciB0ZXN0aW5nLCB0aGVuIGRvIHNvIGFyb3VuZCBleGVjdXRpb24gb2YgY2FsbGJhY2suXG4gICAgaWYgKHRoaXMucmVzdHJpY3RlZFRhZ3MpIHtcbiAgICAgIGxldCBvbGRIb29rID0gQ3JlZGVudGlhbHMuZ2V0VXNlckRldmljZVNlY3JldDtcbiAgICAgIHRyeSB7XG5cdENyZWRlbnRpYWxzLmdldFVzZXJEZXZpY2VTZWNyZXQgPSAodGFnLCBwcm9tcHRTdHJpbmcpID0+IHtcblx0ICBpZiAoIXRoaXMucmVzdHJpY3RlZFRhZ3MuaGFzKHRhZykpIHJldHVybiAnYm9ndXMnO1xuXHQgIHJldHVybiBvbGRIb29rKHRhZywgcHJvbXB0U3RyaW5nKTtcblx0fTtcblx0YXdhaXQgQ3JlZGVudGlhbHMuY2xlYXIoKTtcblx0cmV0dXJuIGF3YWl0IGNhbGxiYWNrKCk7XG4gICAgICB9IGZpbmFsbHkge1xuXHRDcmVkZW50aWFscy5nZXRVc2VyRGV2aWNlU2VjcmV0ID0gb2xkSG9vaztcblx0YXdhaXQgQ3JlZGVudGlhbHMuY2xlYXIoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGF3YWl0IGNhbGxiYWNrKCk7XG4gIH1cbiAgYXN5bmMgd2l0aFJlc3RyaWN0ZWRUYWdzKGFsbG93ZWQsIGNhbGxiYWNrKSB7XG4gICAgbGV0IHJlc3RyaWN0aW9uID0gdGhpcy5yZXN0cmljdGVkVGFncztcbiAgICB0cnkge1xuICAgICAgdGhpcy5yZXN0cmljdGVkVGFncyA9IGFsbG93ZWQgJiYgbmV3IFNldChhbGxvd2VkKTtcbiAgICAgIHJldHVybiBhd2FpdCBjYWxsYmFjaygpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLnJlc3RyaWN0ZWRUYWdzID0gcmVzdHJpY3Rpb247XG4gICAgfVxuICB9XG4gIGVuc3VyZURlY3J5cHRlZCh2ZXJpZmllZCkge1xuICAgIHJldHVybiB0aGlzLm1heWJlUmVzdHJpY3QoKCkgPT4gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpKTtcbiAgfVxuICBhc3luYyBwcmVwcm9jZXNzRm9yU2lnbmluZyhkYXRhLCBvcHRpb25zKSB7XG4gICAgLy8gUHJvbWlzZSBbZGF0YSwgb3B0aW9uc10gdGhhdCBoYXZlICBiZWVuIGNhbm9uaWNhbGl6ZWQgYW5kIG1heWJlIHJldmlzZWQgZm9yIGVuY3J5cHRpb24uXG4gICAgLy8gU2VwYXJhdGVkIG91dCBmcm9tIHNpZ24oKSBzbyB0aGF0IHN1YmNsYXNzZXMgY2FuIG1vZGlmeSBmdXJ0aGVyLlxuICAgIGNvbnN0IHtlbmNyeXB0aW9uLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpO1xuICAgIGlmIChlbmNyeXB0aW9uKSB7XG4gICAgICBkYXRhID0gYXdhaXQgQ3JlZGVudGlhbHMuZW5jcnlwdChkYXRhLCBlbmNyeXB0aW9uKTtcbiAgICAgIHNpZ25pbmdPcHRpb25zLmNvbnRlbnRUeXBlID0gdGhpcy5jb25zdHJ1Y3Rvci5lbmNyeXB0ZWRNaW1lVHlwZTtcbiAgICB9XG4gICAgcmV0dXJuIFtkYXRhLCB7ZW5jcnlwdGlvbiwgLi4uc2lnbmluZ09wdGlvbnN9XTtcbiAgfVxuICBhc3luYyBzaWduKGRhdGEsIG9wdGlvbnMgPSB7fSkge1xuICAgIHRoaXMubG9nKCdzaWduJywgZGF0YSwgb3B0aW9ucyk7XG4gICAgW2RhdGEsIG9wdGlvbnNdID0gYXdhaXQgdGhpcy5wcmVwcm9jZXNzRm9yU2lnbmluZyhkYXRhLCBvcHRpb25zKTtcbiAgICB0aGlzLmxvZygnc2lnbiBhZnRlciBwcmVwcm9jZXNzRm9yU2lnbmluZycsIGRhdGEsIG9wdGlvbnMpO1xuICAgIHJldHVybiBhd2FpdCB0aGlzLm1heWJlUmVzdHJpY3QoKCkgPT4gdGhpcy5jb25zdHJ1Y3Rvci5zaWduKGRhdGEsIG9wdGlvbnMpKTtcbiAgfVxuICB2ZXJpZnkoLi4ucmVzdCkge1xuICAgIHJldHVybiB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeSguLi5yZXN0KTtcbiAgfVxuXG4gIGFzeW5jIHVuZGVsZXRlZFRhZ3MoKSB7XG4gICAgLy8gT3VyIG93biBzZXBhcmF0ZSwgb24tZGVtYW5kIGFjY291bnRpbmcgb2YgcGVyc2lzdGVuY2VTdG9yZSBsaXN0KCk6XG4gICAgLy8gICAtIHBlcnNpc3RlbmNlU3RvcmUgbGlzdCgpIGNvdWxkIHBvdGVudGlhbGx5IGJlIGV4cGVuc2l2ZVxuICAgIC8vICAgLSBJdCB3aWxsIGNvbnRhaW4gc29mdC1kZWxldGVkIGl0ZW0gdG9tYnN0b25lcyAoc2lnbmVkIGVtcHR5IHBheWxvYWRzKS5cbiAgICAvLyBJdCBzdGFydHMgd2l0aCBhIGxpc3QoKSB0byBnZXQgYW55dGhpbmcgcGVyc2lzdGVkIGluIGEgcHJldmlvdXMgc2Vzc2lvbiwgYW5kIGFkZHMvcmVtb3ZlcyBhcyB3ZSBzdG9yZS9yZW1vdmUuXG4gICAgY29uc3QgdGFncyA9IG5ldyBTZXQoKTtcbiAgICBjb25zdCBzdG9yZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBpZiAoIXN0b3JlKSByZXR1cm4gdGFncztcbiAgICBjb25zdCBhbGxUYWdzID0gYXdhaXQgc3RvcmUubGlzdCgpO1xuICAgIGF3YWl0IFByb21pc2UuYWxsKGFsbFRhZ3MubWFwKGFzeW5jIHRhZyA9PiB7XG4gICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZywgc3luY2hyb25pemU6IGZhbHNlfSk7XG4gICAgICBpZiAodmVyaWZpZWQpIHRhZ3MuYWRkKHRhZyk7XG4gICAgfSkpO1xuICAgIHJldHVybiB0YWdzO1xuICB9XG4gIGdldCB0YWdzKCkgeyAvLyBLZWVwcyB0cmFjayBvZiBvdXIgKHVuZGVsZXRlZCkga2V5cy5cbiAgICByZXR1cm4gdGhpcy5fdGFnc1Byb21pc2UgfHw9IHRoaXMudW5kZWxldGVkVGFncygpO1xuICB9XG4gIGFzeW5jIGFkZFRhZyh0YWcpIHtcbiAgICAoYXdhaXQgdGhpcy50YWdzKS5hZGQodGFnKTtcbiAgfVxuICBhc3luYyBkZWxldGVUYWcodGFnKSB7XG4gICAgKGF3YWl0IHRoaXMudGFncykuZGVsZXRlKHRhZyk7XG4gIH1cblxuICBsb2coLi4ucmVzdCkge1xuICAgIGlmICghdGhpcy5kZWJ1ZykgcmV0dXJuO1xuICAgIGNvbnNvbGUubG9nKHRoaXMuZnVsbExhYmVsLCAuLi5yZXN0KTtcbiAgfVxuICBfY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zID0ge30pIHsgLy8gQWxsb3cgdGFnT3JPcHRpb25zIHRvIGJlIGp1c3QgYSB0YWcgc3RyaW5nIGRpcmVjdGx5LCBvciBhIG5hbWVkIG9wdGlvbnMgb2JqZWN0LlxuICAgIHJldHVybiAodHlwZW9mKHRhZ09yT3B0aW9ucykgPT09ICdzdHJpbmcnKSA/IHt0YWc6dGFnT3JPcHRpb25zfSA6IHRhZ09yT3B0aW9ucztcbiAgfVxuICBfY2Fub25pY2FsaXplT3B0aW9ucyhvYmplY3RPclN0cmluZyA9IHt9KSB7IC8vIEV4dGVuZCBfY2Fub25pY2FsaXplT3B0aW9uczEgdG8gc3VwcG9ydDpcbiAgICAvLyAtIGRpc3RyaWJ1dGUtc2VjdXJpdHkgc3R5bGUgJ3RlYW0nIGFuZCAnbWVtYmVyJyBjYW4gYmUgY2FsbGVkIGluIGZsZXhzdG9yZSBzdHlsZSAnb3duZXInIGFuZCAnYXV0aG9yJywgcmVzcGVjdGl2ZWx5XG4gICAgLy8gLSBlbmNyeXB0aW9uIGNhbiBiZSBzcGVmaWVkIGFzIHRydWUsIG9yIHRoZSBzdHJpbmcgJ3RlYW0nLCBvciAnb3duZXInLCByZXN1bHRpbmcgaW4gdGhlIHRlYW0gdGFnIGJlaW5nIHVzZWQgZm9yIGVuY3J5cHRpb25cbiAgICAvLyAtIG93bmVyIGFuZCBhdXRob3IgZGVmYXVsdCAoaWYgbm90IHNwZWNpZmllZCBpbiBlaXRoZXIgc3R5bGUpIHRvIENyZWRlbnRpYWxzLm93bmVyIGFuZCBDcmVkZW50aWFscy5hdXRob3IsIHJlc3BlY3RpdmVseS5cbiAgICAvLyAtIGVuY3J5cHRpb24gZGVmYXVsdHMgdG8gQ3JlZGVudGFpbHMuZW5jcnlwdGlvbiwgZWxzZSBudWxsIChleHBsaWNpdGx5KS5cbiAgICAvLyAtIHRpbWUgZGVmYXVsdHMgdG8gbm93LlxuICAgIC8vIElkZW1wb3RlbnQsIHNvIHRoYXQgaXQgY2FuIGJlIHVzZWQgYnkgYm90aCBjb2xsZWN0aW9uLnNpZ24gYW5kIGNvbGxlY3Rpb24uc3RvcmUgKHdoaWNoIHVzZXMgc2lnbikuXG4gICAgbGV0IHtvd25lciwgdGVhbSA9IG93bmVyID8/IENyZWRlbnRpYWxzLm93bmVyLFxuXHQgdGFncyA9IFtdLFxuXHQgYXV0aG9yLCBtZW1iZXIgPSBhdXRob3IgPz8gdGFnc1swXSA/PyBDcmVkZW50aWFscy5hdXRob3IsXG5cdCBlbmNyeXB0aW9uID0gQ3JlZGVudGlhbHMuZW5jcnlwdGlvbiA/PyBudWxsLFxuXHQgdGltZSA9IERhdGUubm93KCksXG5cdCAuLi5yZXN0fSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMxKG9iamVjdE9yU3RyaW5nKTtcbiAgICBpZiAoW3RydWUsICd0ZWFtJywgJ293bmVyJ10uaW5jbHVkZXMoZW5jcnlwdGlvbikpIGVuY3J5cHRpb24gPSB0ZWFtIHx8IG1lbWJlcjtcbiAgICBpZiAodGVhbSA9PT0gbWVtYmVyIHx8ICF0ZWFtKSB7IC8vIENsZWFuIHVwIHRhZ3MgZm9yIG5vIHNlcGFyYXRlIHRlYW0uXG4gICAgICBpZiAoIXRhZ3MuaW5jbHVkZXMobWVtYmVyKSkgdGFncy5wdXNoKG1lbWJlcik7XG4gICAgICBtZW1iZXIgPSB1bmRlZmluZWQ7XG4gICAgICB0ZWFtID0gJyc7XG4gICAgfVxuICAgIHJldHVybiB7dGltZSwgdGVhbSwgbWVtYmVyLCBlbmNyeXB0aW9uLCB0YWdzLCAuLi5yZXN0fTtcbiAgfVxuICBmYWlsKG9wZXJhdGlvbiwgZGF0YSwgYXV0aG9yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2F1dGhvcn0gZG9lcyBub3QgaGF2ZSB0aGUgYXV0aG9yaXR5IHRvICR7b3BlcmF0aW9ufSAke3RoaXMuZnVsbE5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9LmApO1xuICB9XG4gIGFzeW5jIHN0b3JlKGRhdGEsIG9wdGlvbnMgPSB7fSwgc3luY2hyb25pemVyID0gbnVsbCkge1xuICAgIC8vIGVuY3J5cHQgaWYgbmVlZGVkXG4gICAgLy8gc2lnblxuICAgIC8vIHB1dCA8PT0gQWxzbyB3aGVyZSB3ZSBlbnRlciBpZiBwdXNoZWQgZnJvbSBhIGNvbm5lY3Rpb25cbiAgICAvLyAgICB2YWxpZGF0ZUZvcldyaXRpbmdcbiAgICAvLyAgICAgICBleGl0IGlmIGltcHJvcGVyXG4gICAgLy8gICAgICAgZW1pdCB1cGRhdGUgZXZlbnRcbiAgICAvLyAgICBtZXJnZVNpZ25hdHVyZXNcbiAgICAvLyAgICBwZXJzaXN0IGxvY2FsbHlcbiAgICAvLyBwdXNoIChsaXZlIHRvIGFueSBjb25uZWN0aW9ucyBleGNlcHQgdGhlIG9uZSB3ZSByZWNlaXZlZCBmcm9tKVxuICAgIC8vIE5vIG5lZWQgdG8gYXdhaXQgc3luY2hyb25pemF0aW9uLlxuICAgIGxldCB7dGFnLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpO1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuc2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgdGFnID0gYXdhaXQgdGhpcy5wdXQodGFnLCBzaWduYXR1cmUsIHN5bmNocm9uaXplcik7XG4gICAgaWYgKCF0YWcpIHJldHVybiB0aGlzLmZhaWwoJ3N0b3JlJywgZGF0YSwgc2lnbmluZ09wdGlvbnMubWVtYmVyIHx8IHNpZ25pbmdPcHRpb25zLnRhZ3NbMF0pO1xuICAgIGF3YWl0IHRoaXMucHVzaCgncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgcHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlLCBleGNsdWRlU3luY2hyb25pemVyID0gbnVsbCkgeyAvLyBQdXNoIHRvIGFsbCBjb25uZWN0ZWQgc3luY2hyb25pemVycywgZXhjbHVkaW5nIHRoZSBzcGVjaWZpZWQgb25lLlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IChleGNsdWRlU3luY2hyb25pemVyICE9PSBzeW5jaHJvbml6ZXIpICYmIHN5bmNocm9uaXplci5wdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpKSk7XG4gIH1cbiAgYXN5bmMgcmVtb3ZlKG9wdGlvbnMgPSB7fSkgeyAvLyBOb3RlOiBSZWFsbHkganVzdCByZXBsYWNpbmcgd2l0aCBlbXB0eSBkYXRhIGZvcmV2ZXIuIE90aGVyd2lzZSBtZXJnaW5nIHdpdGggZWFybGllciBkYXRhIHdpbGwgYnJpbmcgaXQgYmFjayFcbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTtcbiAgICBjb25zdCBkYXRhID0gJyc7XG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb25cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLnNpZ24oZGF0YSwge3N1YmplY3Q6IHRhZywgZW5jcnlwdGlvbjogJycsIC4uLnNpZ25pbmdPcHRpb25zfSk7XG4gICAgdGFnID0gYXdhaXQgdGhpcy5kZWxldGUodGFnLCBzaWduYXR1cmUpO1xuICAgIGlmICghdGFnKSByZXR1cm4gdGhpcy5mYWlsKCdyZW1vdmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gZ2V0VmVyaWZpZWQgYW5kIG1heWJlIGRlY3J5cHQuIEhhcyBtb3JlIGNvbXBsZXggYmVoYXZpb3IgaW4gc3ViY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbi5cbiAgICBjb25zdCB7dGFnLCBkZWNyeXB0ID0gdHJ1ZSwgLi4ub3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zMSh0YWdPck9wdGlvbnMpO1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnLCAuLi5vcHRpb25zfSk7XG4gICAgaWYgKCF2ZXJpZmllZCkgcmV0dXJuICcnO1xuICAgIGlmIChkZWNyeXB0KSByZXR1cm4gYXdhaXQgdGhpcy5lbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBnZXRWZXJpZmllZCh0YWdPck9wdGlvbnMpIHsgLy8gc3luY2hyb25pemUsIGdldCwgYW5kIHZlcmlmeSAoYnV0IHdpdGhvdXQgZGVjcnlwdClcbiAgICBjb25zdCB7dGFnLCBzeW5jaHJvbml6ZSA9IHRydWUsIC4uLnZlcmlmeU9wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zKTtcbiAgICBpZiAoc3luY2hyb25pemUpIGF3YWl0IHRoaXMuc3luY2hyb25pemUxKHRhZyk7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5nZXQodGFnKTtcbiAgICBpZiAoIXNpZ25hdHVyZSkgcmV0dXJuIHNpZ25hdHVyZTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmVyaWZ5T3B0aW9ucyk7XG4gICAgaWYgKHZlcmlmaWVkKSB2ZXJpZmllZC50YWcgPSB0YWc7IC8vIENhcnJ5IHdpdGggaXQgdGhlIHRhZyBieSB3aGljaCBpdCB3YXMgZm91bmQuXG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIGFzeW5jIGxpc3Qoc2tpcFN5bmMgPSBmYWxzZSApIHsgLy8gTGlzdCBhbGwgdGFncyBvZiB0aGlzIGNvbGxlY3Rpb24uXG4gICAgaWYgKCFza2lwU3luYykgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZVRhZ3MoKTtcbiAgICAvLyBXZSBjYW5ub3QganVzdCBsaXN0IHRoZSBrZXlzIG9mIHRoZSBjb2xsZWN0aW9uLCBiZWNhdXNlIHRoYXQgaW5jbHVkZXMgZW1wdHkgcGF5bG9hZHMgb2YgaXRlbXMgdGhhdCBoYXZlIGJlZW4gZGVsZXRlZC5cbiAgICByZXR1cm4gQXJyYXkuZnJvbSgoYXdhaXQgdGhpcy50YWdzKS5rZXlzKCkpO1xuICB9XG4gIGFzeW5jIG1hdGNoKHRhZywgcHJvcGVydGllcykgeyAvLyBJcyB0aGlzIHNpZ25hdHVyZSB3aGF0IHdlIGFyZSBsb29raW5nIGZvcj9cbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMucmV0cmlldmUodGFnKTtcbiAgICBjb25zdCBkYXRhID0gdmVyaWZpZWQ/Lmpzb247XG4gICAgaWYgKCFkYXRhKSByZXR1cm4gZmFsc2U7XG4gICAgZm9yIChjb25zdCBrZXkgaW4gcHJvcGVydGllcykge1xuICAgICAgaWYgKGRhdGFba2V5XSAhPT0gcHJvcGVydGllc1trZXldKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGFzeW5jIGZpbmRMb2NhbChwcm9wZXJ0aWVzKSB7IC8vIEZpbmQgdGhlIHRhZyBpbiBvdXIgc3RvcmUgdGhhdCBtYXRjaGVzLCBlbHNlIGZhbHNleVxuICAgIGZvciAoY29uc3QgdGFnIG9mIGF3YWl0IHRoaXMubGlzdCgnbm8tc3luYycpKSB7IC8vIERpcmVjdCBsaXN0LCB3L28gc3luYy5cbiAgICAgIGlmIChhd2FpdCB0aGlzLm1hdGNoKHRhZywgcHJvcGVydGllcykpIHJldHVybiB0YWc7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBhc3luYyBmaW5kKHByb3BlcnRpZXMpIHsgLy8gQW5zd2VyIHRoZSB0YWcgdGhhdCBoYXMgdmFsdWVzIG1hdGNoaW5nIHRoZSBzcGVjaWZpZWQgcHJvcGVydGllcy4gT2J2aW91c2x5LCBjYW4ndCBiZSBlbmNyeXB0ZWQgYXMgYSB3aG9sZS5cbiAgICBsZXQgZm91bmQgPSBhd2FpdCB0aGlzLmZpbmRMb2NhbChwcm9wZXJ0aWVzKTtcbiAgICBpZiAoZm91bmQpIHtcbiAgICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemUxKGZvdW5kKTsgLy8gTWFrZSBzdXJlIHRoZSBkYXRhIGlzIHVwIHRvIGRhdGUuIFRoZW4gY2hlY2sgYWdhaW4uXG4gICAgICBpZiAoYXdhaXQgdGhpcy5tYXRjaChmb3VuZCwgcHJvcGVydGllcykpIHJldHVybiBmb3VuZDtcbiAgICB9XG4gICAgLy8gTm8gbWF0Y2guXG4gICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZVRhZ3MoKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplRGF0YSgpO1xuICAgIGZvdW5kID0gYXdhaXQgdGhpcy5maW5kTG9jYWwocHJvcGVydGllcyk7XG4gICAgaWYgKGZvdW5kICYmIGF3YWl0IHRoaXMubWF0Y2goZm91bmQsIHByb3BlcnRpZXMpKSByZXR1cm4gZm91bmQ7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmVxdWlyZVRhZyh0YWcpIHtcbiAgICBpZiAodGFnKSByZXR1cm47XG4gICAgdGhyb3cgbmV3IEVycm9yKCdBIHRhZyBpcyByZXF1aXJlZC4nKTtcbiAgfVxuXG4gIC8vIFRoZXNlIHRocmVlIGlnbm9yZSBzeW5jaHJvbml6YXRpb24gc3RhdGUsIHdoaWNoIGlmIG5lZWVkIGlzIHRoZSByZXNwb25zaWJpbGl0eSBvZiB0aGUgY2FsbGVyLlxuICAvLyBGSVhNRSBUT0RPOiBhZnRlciBpbml0aWFsIGRldmVsb3BtZW50LCB0aGVzZSB0aHJlZSBzaG91bGQgYmUgbWFkZSBpbnRlcm5hbCBzbyB0aGF0IGFwcGxpY2F0aW9uIGNvZGUgZG9lcyBub3QgY2FsbCB0aGVtLlxuICBhc3luYyBnZXQodGFnKSB7IC8vIEdldCB0aGUgbG9jYWwgcmF3IHNpZ25hdHVyZSBkYXRhLlxuICAgIHRoaXMucmVxdWlyZVRhZyh0YWcpO1xuICAgIHJldHVybiBhd2FpdCAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKS5nZXQodGFnKTtcbiAgfVxuICAvLyBUaGVzZSB0d28gY2FuIGJlIHRyaWdnZXJlZCBieSBjbGllbnQgY29kZSBvciBieSBhbnkgc2VydmljZS5cbiAgYXN5bmMgcHV0KHRhZywgc2lnbmF0dXJlLCBzeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFB1dCB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIC8vIDEuIHZhbGlkYXRlRm9yV3JpdGluZ1xuICAgIC8vIDIuIG1lcmdlU2lnbmF0dXJlcyBhZ2FpbnN0IGFueSBleGlzdGluZywgcGlja2luZyBzb21lIGNvbWJpbmF0aW9uIG9mIGV4aXN0aW5nIGFuZCBuZXh0LlxuICAgIC8vIDMuIHBlcnNpc3QgdGhlIHJlc3VsdFxuICAgIC8vIDQuIHJldHVybiB0YWdcblxuICAgIC8vIFRPRE86IGRvIHdlIG5lZWQgdG8gcXVldWUgdGhlc2U/IFN1cHBvc2Ugd2UgYXJlIHZhbGlkYXRpbmcgb3IgbWVyZ2luZyB3aGlsZSBvdGhlciByZXF1ZXN0IGFycml2ZT9cbiAgICBjb25zdCB2YWxpZGF0aW9uID0gYXdhaXQgdGhpcy52YWxpZGF0ZUZvcldyaXRpbmcodGFnLCBzaWduYXR1cmUsICdzdG9yZScsIHN5bmNocm9uaXplcik7XG4gICAgdGhpcy5sb2coJ3B1dCcsIHt0YWc6IHZhbGlkYXRpb24/LnRhZyB8fCB0YWcsIHN5bmNocm9uaXplcjogc3luY2hyb25pemVyPy5sYWJlbCwgdGV4dDogdmFsaWRhdGlvbj8udGV4dH0pO1xuXG4gICAgaWYgKCF2YWxpZGF0aW9uKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGlmICghdmFsaWRhdGlvbi5zaWduYXR1cmUpIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gTm8gZnVydGhlciBhY3Rpb24gYnV0IGFuc3dlciB0YWcuIEUuZy4sIHdoZW4gaWdub3JpbmcgbmV3IGRhdGEuXG4gICAgYXdhaXQgdGhpcy5hZGRUYWcodmFsaWRhdGlvbi50YWcpO1xuXG4gICAgY29uc3QgbWVyZ2VkID0gYXdhaXQgdGhpcy5tZXJnZVNpZ25hdHVyZXModGFnLCB2YWxpZGF0aW9uLCBzaWduYXR1cmUpO1xuICAgIGF3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgbWVyZ2VkKTtcbiAgICByZXR1cm4gdmFsaWRhdGlvbi50YWc7IC8vIERvbid0IHJlbHkgb24gdGhlIHJldHVybmVkIHZhbHVlIG9mIHBlcnNpc3RlbmNlU3RvcmUucHV0LlxuICB9XG4gIGFzeW5jIGRlbGV0ZSh0YWcsIHNpZ25hdHVyZSwgc3luY2hyb25pemVyID0gbnVsbCkgeyAvLyBSZW1vdmUgdGhlIHJhdyBzaWduYXR1cmUgbG9jYWxseSBhbmQgb24gdGhlIHNwZWNpZmllZCBzZXJ2aWNlcy5cbiAgICBjb25zdCB2YWxpZGF0aW9uID0gYXdhaXQgdGhpcy52YWxpZGF0ZUZvcldyaXRpbmcodGFnLCBzaWduYXR1cmUsICdyZW1vdmUnLCBzeW5jaHJvbml6ZXIsICdyZXF1aXJlVGFnJyk7XG4gICAgdGhpcy5sb2coJ2RlbGV0ZScsIHRhZywgc3luY2hyb25pemVyPy5sYWJlbCwgJ3ZhbGlkYXRlZCB0YWc6JywgdmFsaWRhdGlvbj8udGFnLCAncHJlc2VydmVEZWxldGlvbnM6JywgdGhpcy5wcmVzZXJ2ZURlbGV0aW9ucyk7XG4gICAgaWYgKCF2YWxpZGF0aW9uKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGF3YWl0IHRoaXMuZGVsZXRlVGFnKHRhZyk7XG4gICAgaWYgKHRoaXMucHJlc2VydmVEZWxldGlvbnMpIHsgLy8gU2lnbmF0dXJlIHBheWxvYWQgaXMgZW1wdHkuXG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIHNpZ25hdHVyZSk7XG4gICAgfSBlbHNlIHsgLy8gUmVhbGx5IGRlbGV0ZS5cbiAgICAgIGF3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgc2lnbmF0dXJlLCAnZGVsZXRlJyk7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5kZWxldGUuXG4gIH1cblxuICBub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsIG1lc3NhZ2UgPSB1bmRlZmluZWQsIHZhbGlkYXRlZCA9ICcnLCBzaWduYXR1cmUpIHtcbiAgICAvLyBMYXRlciBvbiwgd2Ugd2lsbCBub3Qgd2FudCB0byBnaXZlIG91dCBzbyBtdWNoIGluZm8uLi5cbiAgICAvL2lmICh0aGlzLmRlYnVnKSB7XG4gICAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSwgdGFnKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy8gIGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgYFNpZ25hdHVyZSBpcyBub3QgdmFsaWQgdG8gJHtvcGVyYXRpb25MYWJlbH0gJHt0YWcgfHwgJ2RhdGEnfS5gKTtcbiAgICAvL31cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIFByb21pc2UgYSByZWFzb24gc3RyaW5nIHRvIGRpc2FsbG93LCBvciBudWxsIGlmIHdyaXRlIGlzIGFsbG93ZWQuXG4gICAgLy8gVGhlIGVtcHR5IHN0cmluZyBtZWFucyB0aGF0IHdlIHNob3VsZCBub3QgYWN0dWFsbHkgd3JpdGUgYW55dGhpbmcsIGJ1dCB0aGUgb3BlcmF0aW9uIHNob3VsZCBxdWlldGx5IGFuc3dlciB0aGUgZ2l2ZW4gdGFnLlxuXG4gICAgaWYgKCF2ZXJpZmllZC50ZXh0Lmxlbmd0aCkgcmV0dXJuIHRoaXMuZGlzYWxsb3dEZWxldGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKTtcblxuICAgIGlmICghcHJvcG9zZWQpIHJldHVybiAnaW52YWxpZCBzaWduYXR1cmUnO1xuICAgIGNvbnN0IHRhZ2dlZCA9IGF3YWl0IHRoaXMuY2hlY2tUYWcodmVyaWZpZWQpOyAvLyBDaGVja2VkIHJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB0aGlzIGFuIGFudGVjZWRlbnQuXG4gICAgaWYgKHRhZ2dlZCkgcmV0dXJuIHRhZ2dlZDsgLy8gSGFyZCBmYWlsIGFuc3dlcnMsIHJlZ2FyZGxlc3Mgb2YgZXhpc3RpbmcuXG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuIHRhZ2dlZDsgLy8gUmV0dXJuaW5nICcnIG9yIG51bGwuXG5cbiAgICBsZXQgb3duZXIsIGRhdGU7XG4gICAgLy8gUmV0dXJuIGFueSBoYXJkIGZhaWwgZmlyc3QsIHRoZW4gYW55IGVtcHR5IHN0cmluZywgb3IgZmluYWxseSBudWxsXG4gICAgcmV0dXJuIChvd25lciA9IGF3YWl0IHRoaXMuY2hlY2tPd25lcihleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSkgfHxcbiAgICAgIChkYXRlID0gYXdhaXQgdGhpcy5jaGVja0RhdGUoZXhpc3RpbmcsIHByb3Bvc2VkKSkgfHxcbiAgICAgIChvd25lciA/PyBkYXRlID8/IHRhZ2dlZCk7XG4gIH1cbiAgYXN5bmMgZGlzYWxsb3dEZWxldGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIERlbGV0aW9uIHR5cGljYWxseSBsYXRjaGVzLlxuICAgIGlmICghcHJvcG9zZWQpIHJldHVybiAnaW52YWxpZCBzaWduYXR1cmUnO1xuXG4gICAgLy8gSWYgd2UgZXZlciBjaGFuZ2UgdGhpcyBuZXh0LCBiZSBzdXJlIHRoYXQgb25lIGNhbm5vdCBzcGVjdWxhdGl2ZWx5IGNhbXAgb3V0IG9uIGEgdGFnIGFuZCBwcmV2ZW50IHBlb3BsZSBmcm9tIHdyaXRpbmchXG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuICcnO1xuICAgIC8vIERlbGV0aW5nIHRydW1wcyBkYXRhLCByZWdhcmRsZXNzIG9mIHRpbWVzdGFtcC5cbiAgICByZXR1cm4gdGhpcy5jaGVja093bmVyKGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpO1xuICB9XG4gIGhhc2hhYmxlUGF5bG9hZCh2YWxpZGF0aW9uKSB7IC8vIFJldHVybiBhIHN0cmluZyB0aGF0IGNhbiBiZSBoYXNoZWQgdG8gbWF0Y2ggdGhlIHN1YiBoZWFkZXJcbiAgICAvLyAod2hpY2ggaXMgbm9ybWFsbHkgZ2VuZXJhdGVkIGluc2lkZSB0aGUgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgdmF1bHQpLlxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRleHQgfHwgbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHZhbGlkYXRpb24ucGF5bG9hZCk7XG4gIH1cbiAgYXN5bmMgaGFzaCh2YWxpZGF0aW9uKSB7IC8vIFByb21pc2UgdGhlIGhhc2ggb2YgaGFzaGFibGVQYXlsb2FkLlxuICAgIHJldHVybiBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoYXdhaXQgQ3JlZGVudGlhbHMuaGFzaFRleHQodGhpcy5oYXNoYWJsZVBheWxvYWQodmFsaWRhdGlvbikpKTtcbiAgfVxuICBmYWlyT3JkZXJlZEF1dGhvcihleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gVXNlZCB0byBicmVhayB0aWVzIGluIGV2ZW4gdGltZXN0YW1wcy5cbiAgICBjb25zdCB7c3ViLCBhY3R9ID0gZXhpc3Rpbmc7XG4gICAgY29uc3Qge2FjdDphY3QyfSA9IHByb3Bvc2VkO1xuICAgIGlmIChzdWI/Lmxlbmd0aCAmJiBzdWIuY2hhckNvZGVBdChzdWIubGVuZ3RoIC0gMSkgJSAyKSByZXR1cm4gYWN0IDwgYWN0MjtcbiAgICByZXR1cm4gYWN0ID4gYWN0MjsgLy8gSWYgYWN0ID09PSBhY3QyLCB0aGVuIHRoZSB0aW1lc3RhbXBzIHNob3VsZCBiZSB0aGUgc2FtZS5cbiAgfVxuICBnZXRPd25lcihwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gUmV0dXJuIHRoZSB0YWcgb2Ygd2hhdCBzaGFsbCBiZSBjb25zaWRlcmVkIHRoZSBvd25lci5cbiAgICBjb25zdCB7aXNzLCBraWR9ID0gcHJvdGVjdGVkSGVhZGVyO1xuICAgIHJldHVybiBpc3MgfHwga2lkO1xuICB9XG4gIC8vIFRoZXNlIHByZWRpY2F0ZXMgY2FuIHJldHVybiBhIGJvb2xlYW4gZm9yIGhhcmQgeWVzIG9yIG5vLCBvciBudWxsIHRvIGluZGljYXRlIHRoYXQgdGhlIG9wZXJhdGlvbiBzaG91bGQgc2lsZW50bHkgcmUtdXNlIHRoZSB0YWcuXG4gIGNoZWNrU29tZXRoaW5nKHJlYXNvbiwgYm9vbGVhbiwgbGFiZWwpIHtcbiAgICBpZiAoYm9vbGVhbikgdGhpcy5sb2coJ3dyb25nJywgbGFiZWwsIHJlYXNvbik7XG4gICAgcmV0dXJuIGJvb2xlYW4gPyByZWFzb24gOiBudWxsO1xuICB9XG4gIGNoZWNrT3duZXIoZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgey8vIERvZXMgcHJvcG9zZWQgb3duZXIgbWF0Y2ggdGhlIGV4aXN0aW5nP1xuICAgIHJldHVybiB0aGlzLmNoZWNrU29tZXRoaW5nKCdub3Qgb3duZXInLCB0aGlzLmdldE93bmVyKGV4aXN0aW5nLCB2ZXJpZmllZC5leGlzdGluZykgIT09IHRoaXMuZ2V0T3duZXIocHJvcG9zZWQsIHZlcmlmaWVkKSwgJ293bmVyJyk7XG4gIH1cblxuICBhbnRlY2VkZW50KHZlcmlmaWVkKSB7IC8vIFdoYXQgdGFnIHNob3VsZCB0aGUgdmVyaWZpZWQgc2lnbmF0dXJlIGJlIGNvbXBhcmVkIGFnYWluc3QgZm9yIHdyaXRpbmcsIGlmIGFueS5cbiAgICByZXR1cm4gdmVyaWZpZWQudGFnO1xuICB9XG4gIHN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpIHsgLy8gU2hvdWxkIHRoZSBhbnRlY2VkZW50IHRyeSBzeW5jaHJvbml6aW5nIGJlZm9yZSBnZXR0aW5nIGl0P1xuICAgIHJldHVybiB0YWcgIT09IGFudGVjZWRlbnQ7IC8vIEZhbHNlIHdoZW4gdGhleSBhcmUgdGhlIHNhbWUgdGFnLCBhcyB0aGF0IHdvdWxkIGJlIGNpcmN1bGFyLiBWZXJzaW9ucyBkbyBzeW5jLlxuICB9XG4gIHRhZ0ZvcldyaXRpbmcoc3BlY2lmaWVkVGFnLCB2YWxpZGF0aW9uKSB7IC8vIEdpdmVuIHRoZSBzcGVjaWZpZWQgdGFnIGFuZCB0aGUgYmFzaWMgdmVyaWZpY2F0aW9uIHNvIGZhciwgYW5zd2VyIHRoZSB0YWcgdGhhdCBzaG91bGQgYmUgdXNlZCBmb3Igd3JpdGluZy5cbiAgICByZXR1cm4gc3BlY2lmaWVkVGFnIHx8IHRoaXMuaGFzaCh2YWxpZGF0aW9uKTtcbiAgfVxuICBhc3luYyB2YWxpZGF0ZUZvcldyaXRpbmcodGFnLCBzaWduYXR1cmUsIG9wZXJhdGlvbkxhYmVsLCBzeW5jaHJvbml6ZXIsIHJlcXVpcmVUYWcgPSBmYWxzZSkgeyAvLyBUT0RPOiBPcHRpb25hbHMgc2hvdWxkIGJlIGtleXdvcmQuXG4gICAgLy8gQSBkZWVwIHZlcmlmeSB0aGF0IGNoZWNrcyBhZ2FpbnN0IHRoZSBleGlzdGluZyBpdGVtJ3MgKHJlLSl2ZXJpZmllZCBoZWFkZXJzLlxuICAgIC8vIElmIGl0IHN1Y2NlZWRzLCBwcm9taXNlIGEgdmFsaWRhdGlvbi5cbiAgICAvLyBJdCBjYW4gYWxzbyBhbnN3ZXIgYSBzdXBlci1hYmJyZXZhaXRlZCB2YWxpdGlvbiBvZiBqdXN0IHt0YWd9LCB3aGljaCBpbmRpY2F0ZXMgdGhhdCBub3RoaW5nIHNob3VsZCBiZSBwZXJzaXN0ZWQvZW1pdHRlZCwgYnV0IHRhZyByZXR1cm5lZC5cbiAgICAvLyBUaGlzIGlzIGFsc28gdGhlIGNvbW1vbiBjb2RlIChiZXR3ZWVuIHB1dC9kZWxldGUpIHRoYXQgZW1pdHMgdGhlIHVwZGF0ZSBldmVudC5cbiAgICAvL1xuICAgIC8vIEhvdywgaWYgYSBhbGwsIGRvIHdlIGNoZWNrIHRoYXQgYWN0IGlzIGEgbWVtYmVyIG9mIGlzcz9cbiAgICAvLyBDb25zaWRlciBhbiBpdGVtIG93bmVkIGJ5IGlzcy5cbiAgICAvLyBUaGUgaXRlbSBpcyBzdG9yZWQgYW5kIHN5bmNocm9uaXplZCBieSBhY3QgQSBhdCB0aW1lIHQxLlxuICAgIC8vIEhvd2V2ZXIsIGF0IGFuIGVhcmxpZXIgdGltZSB0MCwgYWN0IEIgd2FzIGN1dCBvZmYgZnJvbSB0aGUgcmVsYXkgYW5kIHN0b3JlZCB0aGUgaXRlbS5cbiAgICAvLyBXaGVuIG1lcmdpbmcsIHdlIHdhbnQgYWN0IEIncyB0MCB0byBiZSB0aGUgZWFybGllciByZWNvcmQsIHJlZ2FyZGxlc3Mgb2Ygd2hldGhlciBCIGlzIHN0aWxsIGEgbWVtYmVyIGF0IHRpbWUgb2Ygc3luY2hyb25pemF0aW9uLlxuICAgIC8vIFVubGVzcy91bnRpbCB3ZSBoYXZlIHZlcnNpb25lZCBrZXlzZXRzLCB3ZSBjYW5ub3QgZW5mb3JjZSBhIG1lbWJlcnNoaXAgY2hlY2sgLS0gdW5sZXNzIHRoZSBhcHBsaWNhdGlvbiBpdHNlbGYgd2FudHMgdG8gZG8gc28uXG4gICAgLy8gQSBjb25zZXF1ZW5jZSwgdGhvdWdoLCBpcyB0aGF0IGEgaHVtYW4gd2hvIGlzIGEgbWVtYmVyIG9mIGlzcyBjYW4gZ2V0IGF3YXkgd2l0aCBzdG9yaW5nIHRoZSBkYXRhIGFzIHNvbWVcbiAgICAvLyBvdGhlciB1bnJlbGF0ZWQgcGVyc29uYS4gVGhpcyBtYXkgbWFrZSBpdCBoYXJkIGZvciB0aGUgZ3JvdXAgdG8gaG9sZCB0aGF0IGh1bWFuIHJlc3BvbnNpYmxlLlxuICAgIC8vIE9mIGNvdXJzZSwgdGhhdCdzIGFsc28gdHJ1ZSBpZiB3ZSB2ZXJpZmllZCBtZW1iZXJzIGF0IGFsbCB0aW1lcywgYW5kIGhhZCBiYWQgY29udGVudCBsZWdpdGltYXRlbHkgY3JlYXRlZCBieSBzb21lb25lIHdobyBnb3Qga2lja2VkIGxhdGVyLlxuXG4gICAgY29uc3QgdmFsaWRhdGlvbk9wdGlvbnMgPSB7bWVtYmVyOiBudWxsfTsgLy8gQ291bGQgYmUgb2xkIGRhdGEgd3JpdHRlbiBieSBzb21lb25lIHdobyBpcyBubyBsb25nZXIgYSBtZW1iZXIuIFNlZSBvd25lck1hdGNoLlxuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlLCB2YWxpZGF0aW9uT3B0aW9ucyk7XG4gICAgaWYgKCF2ZXJpZmllZCkgcmV0dXJuIHRoaXMubm90aWZ5SW52YWxpZCh0YWcsIG9wZXJhdGlvbkxhYmVsLCAnaW52YWxpZCcsIHZlcmlmaWVkLCBzaWduYXR1cmUpO1xuICAgIHZlcmlmaWVkLnN5bmNocm9uaXplciA9IHN5bmNocm9uaXplcjtcbiAgICAvLyBTZXQgdGhlIGFjdHVhbCB0YWcgdG8gdXNlIGJlZm9yZSB3ZSBkbyB0aGUgZGlzYWxsb3cgY2hlY2tzLlxuICAgIHRhZyA9IHZlcmlmaWVkLnRhZyA9IHJlcXVpcmVUYWcgPyB0YWcgOiBhd2FpdCB0aGlzLnRhZ0ZvcldyaXRpbmcodGFnLCB2ZXJpZmllZCk7XG4gICAgY29uc3QgYW50ZWNlZGVudCA9IHRoaXMuYW50ZWNlZGVudCh2ZXJpZmllZCk7XG4gICAgY29uc3Qgc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpO1xuICAgIGNvbnN0IGV4aXN0aW5nVmVyaWZpZWQgPSB2ZXJpZmllZC5leGlzdGluZyA9IGFudGVjZWRlbnQgJiYgYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnOiBhbnRlY2VkZW50LCBzeW5jaHJvbml6ZSwgLi4udmFsaWRhdGlvbk9wdGlvbnN9KTtcbiAgICBjb25zdCBkaXNhbGxvd2VkID0gYXdhaXQgdGhpcy5kaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmdWZXJpZmllZD8ucHJvdGVjdGVkSGVhZGVyLCB2ZXJpZmllZD8ucHJvdGVjdGVkSGVhZGVyLCB2ZXJpZmllZCk7XG4gICAgdGhpcy5sb2coJ3ZhbGlkYXRlRm9yV3JpdGluZycsIHt0YWcsIG9wZXJhdGlvbkxhYmVsLCByZXF1aXJlVGFnLCBmcm9tU3luY2hyb25pemVyOiEhc3luY2hyb25pemVyLCBzaWduYXR1cmUsIHZlcmlmaWVkLCBhbnRlY2VkZW50LCBzeW5jaHJvbml6ZSwgZXhpc3RpbmdWZXJpZmllZCwgZGlzYWxsb3dlZH0pO1xuICAgIGlmIChkaXNhbGxvd2VkID09PSAnJykgcmV0dXJuIHt0YWd9OyAvLyBBbGxvdyBvcGVyYXRpb24gdG8gc2lsZW50bHkgYW5zd2VyIHRhZywgd2l0aG91dCBwZXJzaXN0aW5nIG9yIGVtaXR0aW5nIGFueXRoaW5nLlxuICAgIGlmIChkaXNhbGxvd2VkKSByZXR1cm4gdGhpcy5ub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsIGRpc2FsbG93ZWQsIHZlcmlmaWVkKTtcbiAgICB0aGlzLmVtaXQodmVyaWZpZWQpO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBtZXJnZVNpZ25hdHVyZXModGFnLCB2YWxpZGF0aW9uLCBzaWduYXR1cmUpIHsgLy8gUmV0dXJuIGEgc3RyaW5nIHRvIGJlIHBlcnNpc3RlZC4gVXN1YWxseSBqdXN0IHRoZSBzaWduYXR1cmUuXG4gICAgcmV0dXJuIHNpZ25hdHVyZTsgIC8vIHZhbGlkYXRpb24uc3RyaW5nIG1pZ2h0IGJlIGFuIG9iamVjdC5cbiAgfVxuICBhc3luYyBwZXJzaXN0KHRhZywgc2lnbmF0dXJlU3RyaW5nLCBvcGVyYXRpb24gPSAncHV0JykgeyAvLyBDb25kdWN0IHRoZSBzcGVjaWZpZWQgdGFnL3NpZ25hdHVyZSBvcGVyYXRpb24gb24gdGhlIHBlcnNpc3RlbnQgc3RvcmUuXG4gICAgdGhpcy5sb2coJ3BlcnNpc3QnLCB0YWcsIG9wZXJhdGlvbiwgc2lnbmF0dXJlU3RyaW5nKTtcbiAgICByZXR1cm4gKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSlbb3BlcmF0aW9uXSh0YWcsIHNpZ25hdHVyZVN0cmluZyk7XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBEaXNwYXRjaCB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHZlcmlmaWVkfSkpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gQW5zd2VycyB0aGUgQ29sbGVjdGlvbiB0aGF0IGVtaXRzIGluZGl2aWR1YWwgdXBkYXRlcy4gKFNlZSBvdmVycmlkZSBpbiBWZXJzaW9uZWRDb2xsZWN0aW9uLilcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHN5bmNocm9uaXplcnMgPSBuZXcgTWFwKCk7IC8vIHNlcnZpY2VJbmZvIG1pZ2h0IG5vdCBiZSBhIHN0cmluZy5cbiAgbWFwU3luY2hyb25pemVycyhmKSB7IC8vIE9uIFNhZmFyaSwgTWFwLnZhbHVlcygpLm1hcCBpcyBub3QgYSBmdW5jdGlvbiFcbiAgICBjb25zdCByZXN1bHRzID0gW107XG4gICAgZm9yIChjb25zdCBzeW5jaHJvbml6ZXIgb2YgdGhpcy5zeW5jaHJvbml6ZXJzLnZhbHVlcygpKSB7XG4gICAgICByZXN1bHRzLnB1c2goZihzeW5jaHJvbml6ZXIpKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cbiAgZ2V0IHNlcnZpY2VzKCkge1xuICAgIHJldHVybiBBcnJheS5mcm9tKHRoaXMuc3luY2hyb25pemVycy5rZXlzKCkpO1xuICB9XG4gIC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGNvbm5lY3QsIGFuZCBkZWZpbmUgc3luY2hyb25pemUgdG8gYXdhaXQgY29ubmVjdCwgc3luY2hyb25pemF0aW9uQ29tcGxldGUsIGRpc2Nvbm5uZWN0LlxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBTdGFydCBydW5uaW5nIHRoZSBzcGVjaWZpZWQgc2VydmljZXMgKGluIGFkZGl0aW9uIHRvIHdoYXRldmVyIGlzIGFscmVhZHkgcnVubmluZykuXG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBpZiAoc3luY2hyb25pemVycy5oYXMoc2VydmljZSkpIGNvbnRpbnVlO1xuICAgICAgYXdhaXQgU3luY2hyb25pemVyLmNyZWF0ZSh0aGlzLCBzZXJ2aWNlKTsgLy8gUmVhY2hlcyBpbnRvIG91ciBzeW5jaHJvbml6ZXJzIG1hcCBhbmQgc2V0cyBpdHNlbGYgaW1tZWRpYXRlbHkuXG4gICAgfVxuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHMgPT4gcy5ib3RoU2lkZXNDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24pKTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIFNodXQgZG93biB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBjb25zdCBzeW5jaHJvbml6ZXIgPSBzeW5jaHJvbml6ZXJzLmdldChzZXJ2aWNlKTtcbiAgICAgIGlmICghc3luY2hyb25pemVyKSB7XG5cdC8vY29uc29sZS53YXJuKGAke3RoaXMuZnVsbExhYmVsfSBkb2VzIG5vdCBoYXZlIGEgc2VydmljZSBuYW1lZCAnJHtzZXJ2aWNlfScgdG8gZGlzY29ubmVjdC5gKTtcblx0Y29udGludWU7XG4gICAgICB9XG4gICAgICBhd2FpdCBzeW5jaHJvbml6ZXIuZGlzY29ubmVjdCgpO1xuICAgIH1cbiAgfVxuICBhc3luYyBlbnN1cmVTeW5jaHJvbml6ZXIoc2VydmljZU5hbWUsIGNvbm5lY3Rpb24sIGRhdGFDaGFubmVsKSB7IC8vIE1ha2Ugc3VyZSBkYXRhQ2hhbm5lbCBtYXRjaGVzIHRoZSBzeW5jaHJvbml6ZXIsIGNyZWF0aW5nIFN5bmNocm9uaXplciBvbmx5IGlmIG1pc3NpbmcuXG4gICAgbGV0IHN5bmNocm9uaXplciA9IHRoaXMuc3luY2hyb25pemVycy5nZXQoc2VydmljZU5hbWUpO1xuICAgIGlmICghc3luY2hyb25pemVyKSB7XG4gICAgICBzeW5jaHJvbml6ZXIgPSBuZXcgU3luY2hyb25pemVyKHtzZXJ2aWNlTmFtZSwgY29sbGVjdGlvbjogdGhpcywgZGVidWc6IHRoaXMuZGVidWd9KTtcbiAgICAgIHN5bmNocm9uaXplci5jb25uZWN0aW9uID0gY29ubmVjdGlvbjtcbiAgICAgIHN5bmNocm9uaXplci5kYXRhQ2hhbm5lbFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZGF0YUNoYW5uZWwpO1xuICAgICAgdGhpcy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgc3luY2hyb25pemVyKTtcbiAgICAgIC8vIERvZXMgTk9UIHN0YXJ0IHN5bmNocm9uaXppbmcuIENhbGxlciBtdXN0IGRvIHRoYXQgaWYgZGVzaXJlZC4gKFJvdXRlciBkb2Vzbid0IG5lZWQgdG8uKVxuICAgIH0gZWxzZSBpZiAoKHN5bmNocm9uaXplci5jb25uZWN0aW9uICE9PSBjb25uZWN0aW9uKSB8fFxuXHQgICAgICAgKHN5bmNocm9uaXplci5jaGFubmVsTmFtZSAhPT0gZGF0YUNoYW5uZWwubGFiZWwpIHx8XG5cdCAgICAgICAoYXdhaXQgc3luY2hyb25pemVyLmRhdGFDaGFubmVsUHJvbWlzZSAhPT0gZGF0YUNoYW5uZWwpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVubWF0Y2hlZCBjb25uZWN0aW9uIGZvciAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgfVxuXG4gIHByb21pc2Uoa2V5LCB0aHVuaykgeyByZXR1cm4gdGh1bms7IH0gLy8gVE9ETzogaG93IHdpbGwgd2Uga2VlcCB0cmFjayBvZiBvdmVybGFwcGluZyBkaXN0aW5jdCBzeW5jcz9cbiAgc3luY2hyb25pemUxKHRhZykgeyAvLyBDb21wYXJlIGFnYWluc3QgYW55IHJlbWFpbmluZyB1bnN5bmNocm9uaXplZCBkYXRhLCBmZXRjaCB3aGF0J3MgbmVlZGVkLCBhbmQgcmVzb2x2ZSBsb2NhbGx5LlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IHN5bmNocm9uaXplci5zeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZVRhZ3MoKSB7IC8vIEVuc3VyZSB0aGF0IHdlIGhhdmUgdXAgdG8gZGF0ZSB0YWcgbWFwIGFtb25nIGFsbCBzZXJ2aWNlcy4gKFdlIGRvbid0IGNhcmUgeWV0IG9mIHRoZSB2YWx1ZXMgYXJlIHN5bmNocm9uaXplZC4pXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgndGFncycsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplRGF0YSgpIHsgLy8gTWFrZSB0aGUgZGF0YSB0byBtYXRjaCBvdXIgdGFnbWFwLCB1c2luZyBzeW5jaHJvbml6ZTEuXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgnZGF0YScsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIHNldCBvbnVwZGF0ZShoYW5kbGVyKSB7IC8vIEFsbG93IHNldHRpbmcgaW4gbGlldSBvZiBhZGRFdmVudExpc3RlbmVyLlxuICAgIGlmIChoYW5kbGVyKSB7XG4gICAgICB0aGlzLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIHRoaXMuX3VwZGF0ZSk7XG4gICAgICB0aGlzLl91cGRhdGUgPSBoYW5kbGVyO1xuICAgICAgdGhpcy5hZGRFdmVudExpc3RlbmVyKCd1cGRhdGUnLCBoYW5kbGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5yZW1vdmVFdmVudExpc3RlbmVyKCd1cGRhdGUnLCB0aGlzLl91cGRhdGUpO1xuICAgICAgdGhpcy5fdXBkYXRlID0gaGFuZGxlcjtcbiAgICB9XG4gIH1cbiAgZ2V0IG9udXBkYXRlKCkgeyAvLyBBcyBzZXQgYnkgdGhpcy5vbnVwZGF0ZSA9IGhhbmRsZXIuIERvZXMgTk9UIGFuc3dlciB0aGF0IHdoaWNoIGlzIHNldCBieSBhZGRFdmVudExpc3RlbmVyLlxuICAgIHJldHVybiB0aGlzLl91cGRhdGU7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIE11dGFibGVDb2xsZWN0aW9uIGV4dGVuZHMgQ29sbGVjdGlvbiB7XG4gIGFzeW5jIGNoZWNrVGFnKHZlcmlmaWVkKSB7IC8vIE11dGFibGUgdGFnIGNvdWxkIGJlIGFueXRoaW5nLlxuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNoZWNrRGF0ZShleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gZmFpbCBpZiBiYWNrZGF0ZWQuXG4gICAgcmV0dXJuIHRoaXMuY2hlY2tTb21ldGhpbmcoJ2JhY2tkYXRlZCcsICFwcm9wb3NlZC5pYXQgfHxcblx0XHRcdCAgICAgICAoKHByb3Bvc2VkLmlhdCA9PT0gZXhpc3RpbmcuaWF0KSA/IHRoaXMuZmFpck9yZGVyZWRBdXRob3IoZXhpc3RpbmcsIHByb3Bvc2VkKSA6ICAocHJvcG9zZWQuaWF0IDwgZXhpc3RpbmcuaWF0KSksXG5cdFx0XHQgICAgICAgJ2RhdGUnKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgSW1tdXRhYmxlQ29sbGVjdGlvbiBleHRlbmRzIENvbGxlY3Rpb24ge1xuICBjaGVja0RhdGUoZXhpc3RpbmcsIHByb3Bvc2VkKSB7IC8vIE9wIHdpbGwgcmV0dXJuIGV4aXN0aW5nIHRhZyBpZiBtb3JlIHJlY2VudCwgcmF0aGVyIHRoYW4gZmFpbGluZy5cbiAgICBpZiAoIXByb3Bvc2VkLmlhdCkgcmV0dXJuICdubyB0aW1lc3RhbXAnO1xuICAgIHJldHVybiB0aGlzLmNoZWNrU29tZXRoaW5nKCcnLFxuXHRcdFx0ICAgICAgICgocHJvcG9zZWQuaWF0ID09PSBleGlzdGluZy5pYXQpID8gdGhpcy5mYWlyT3JkZXJlZEF1dGhvcihleGlzdGluZywgcHJvcG9zZWQpIDogIChwcm9wb3NlZC5pYXQgPiBleGlzdGluZy5pYXQpKSxcblx0XHRcdCAgICAgICAnZGF0ZScpO1xuICB9XG4gIGFzeW5jIGNoZWNrVGFnKHZlcmlmaWVkKSB7IC8vIElmIHRoZSB0YWcgZG9lc24ndCBtYXRjaCB0aGUgZGF0YSwgc2lsZW50bHkgdXNlIHRoZSBleGlzdGluZyB0YWcsIGVsc2UgZmFpbCBoYXJkLlxuICAgIHJldHVybiB0aGlzLmNoZWNrU29tZXRoaW5nKHZlcmlmaWVkLmV4aXN0aW5nID8gJycgOiAnd3JvbmcgdGFnJywgdmVyaWZpZWQudGFnICE9PSBhd2FpdCB0aGlzLmhhc2godmVyaWZpZWQpLCAnaW1tdXRhYmxlIHRhZycpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBTdGF0ZUNvbGxlY3Rpb24gZXh0ZW5kcyBJbW11dGFibGVDb2xsZWN0aW9uIHtcbiAgLy8gQSBwcm9wZXJ0eSBuYW1lZCBtZXNzYWdlIG1heSBiZSBpbmNsdWRlZCBpbiB0aGUgZGF0YSwgd2hpY2ggdGVsbCB0aGUgYXBwbGljYXRpb24gaG93IHRvIHJlYnVpbGQgc3RhdGVzIGluIGEgZGlmZmVyZW50IG9yZGVyIGZvciBtZXJnaW5nLlxuICAvLyBBIG9wdGlvbiBuYW1lZCBhbnRlY2VkZW50IG1heSBiZSBwcm92aWRlZCB0aGF0IGlkZW50aWZpZXMgdGhlIHByZWNlZGluZyBzdGF0ZSAoYmVmb3JlIHRoZSBtZXNzYWdlIHdhcyBhcHBsaWVkKS5cblxuICBhc3luYyBwcmVwcm9jZXNzRm9yU2lnbmluZyhkYXRhLCB7c3ViamVjdCwgLi4ub3B0aW9uc30pIHtcbiAgICAvLyBXZSBhcmUgdXN1YWxseSBnaXZlbiBhbiBvdmVyYWxsIFZlcnNpb25lZENvbGxlY3Rpb24gc3ViamVjdCwgd2hpY2ggd2UgbmVlZCBpbiB0aGUgc2lnbmF0dXJlIGhlYWRlciBzbyB0aGF0IHVwZGF0ZSBldmVudHMgY2FuIHNlZSBpdC5cbiAgICAvLyBJZiBub3Qgc3BlY2lmaWVkIChlLmcuLCB0YWcgY291bGQgYmUgb21taXR0ZWQgaW4gZmlyc3QgdmVyc2lvbiksIHRoZW4gZ2VuZXJhdGUgaXQgaGVyZSwgYWZ0ZXIgc3VwZXIgaGFzIG1heWJlIGVuY3J5cHRlZC5cbiAgICBbZGF0YSwgb3B0aW9uc10gPSBhd2FpdCBzdXBlci5wcmVwcm9jZXNzRm9yU2lnbmluZyhkYXRhLCBvcHRpb25zKTtcbiAgICBpZiAoIXN1YmplY3QpIHtcbiAgICAgIGlmIChBcnJheUJ1ZmZlci5pc1ZpZXcoZGF0YSkpIHN1YmplY3QgPSBhd2FpdCB0aGlzLmhhc2goe3BheWxvYWQ6IGRhdGF9KTtcbiAgICAgIGVsc2UgaWYgKHR5cGVvZihkYXRhKSA9PT0gJ3N0cmluZycpIHN1YmplY3QgPSBhd2FpdCB0aGlzLmhhc2goe3RleHQ6IGRhdGF9KTtcbiAgICAgIGVsc2Ugc3ViamVjdCA9IGF3YWl0IHRoaXMuaGFzaCh7dGV4dDogSlNPTi5zdHJpbmdpZnkoZGF0YSl9KTtcbiAgICB9XG4gICAgcmV0dXJuIFtkYXRhLCB7c3ViamVjdCwgLi4ub3B0aW9uc31dO1xuICB9XG4gIGhhc2hhYmxlUGF5bG9hZCh2YWxpZGF0aW9uKSB7IC8vIEluY2x1ZGUgYW50IHx8IGlhdC5cbiAgICBjb25zdCBwYXlsb2FkID0gc3VwZXIuaGFzaGFibGVQYXlsb2FkKHZhbGlkYXRpb24pO1xuICAgIGNvbnN0IHtwcm90ZWN0ZWRIZWFkZXJ9ID0gdmFsaWRhdGlvbjtcbiAgICBpZiAoIXByb3RlY3RlZEhlYWRlcikgcmV0dXJuIHBheWxvYWQ7IC8vIFdoZW4gdXNlZCBmb3Igc3ViamVjdCBoYXNoKCkgaW4gcHJlcHJvY2Vzc0ZvclNpZ25pbmcoKS5cbiAgICBjb25zdCB7YW50LCBpYXR9ID0gdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXI7XG4gICAgdGhpcy5sb2coJ2hhc2hpbmcnLCB7cGF5bG9hZCwgYW50LCBpYXR9KTtcbiAgICByZXR1cm4gcGF5bG9hZCArIChhbnQgfHwgaWF0IHx8ICcnKTtcbiAgfVxuICBhc3luYyBjaGVja1RhZyh2ZXJpZmllZCkge1xuICAgIGNvbnN0IHRhZyA9IHZlcmlmaWVkLnRhZztcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgdGhpcy5oYXNoKHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdGhpcy5jaGVja1NvbWV0aGluZygnd3Jvbmcgc3RhdGUgdGFnJywgdGFnICE9PSBoYXNoLCAnc3RhdGUgdGFnJyk7XG4gIH1cbiAgY2hlY2tEYXRlKCkgeyAvLyBhbHdheXMgb2tcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBnZXRPd25lcihwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gUmV0dXJuIHRoZSB0YWcgb2Ygd2hhdCBzaGFsbCBiZSBjb25zaWRlcmVkIHRoZSBvd25lci5cbiAgICBjb25zdCB7Z3JvdXAsIGluZGl2aWR1YWx9ID0gcHJvdGVjdGVkSGVhZGVyO1xuICAgIHJldHVybiBncm91cCB8fCBpbmRpdmlkdWFsIHx8IHN1cGVyLmdldE93bmVyKHByb3RlY3RlZEhlYWRlcik7XG4gIH1cbiAgYW50ZWNlZGVudCh2YWxpZGF0aW9uKSB7XG4gICAgaWYgKHZhbGlkYXRpb24udGV4dCA9PT0gJycpIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRGVsZXRlIGNvbXBhcmVzIHdpdGggd2hhdCdzIHRoZXJlXG4gICAgcmV0dXJuIHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLmFudDtcbiAgfVxuICAvLyBmaXhtZTogcmVtb3ZlKCkgP1xuICBhc3luYyBmb3JFYWNoU3RhdGUodGFnLCBjYWxsYmFjaywgcmVzdWx0ID0gbnVsbCkgeyAvLyBhd2FpdCBjYWxsYmFjayh2ZXJpZmllZFN0YXRlLCB0YWcpIG9uIHRoZSBzdGF0ZSBjaGFpbiBzcGVjaWZpZWQgYnkgdGFnLlxuICAgIC8vIFN0b3BzIGl0ZXJhdGlvbiBhbmQgcmVzb2x2ZXMgd2l0aCB0aGUgZmlyc3QgdHJ1dGh5IHZhbHVlIGZyb20gY2FsbGJhY2suIE90aGVyd2lzZSwgcmVzb2x2ZXMgd2l0aCByZXN1bHQuXG4gICAgd2hpbGUgKHRhZykge1xuICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIG1lbWJlcjogbnVsbCwgc3luY2hyb25pemU6IGZhbHNlfSk7XG4gICAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhbGxiYWNrKHZlcmlmaWVkLCB0YWcpOyAvLyB2ZXJpZmllZCBpcyBub3QgZGVjcnlwdGVkXG4gICAgICBpZiAocmVzdWx0KSByZXR1cm4gcmVzdWx0O1xuICAgICAgdGFnID0gdGhpcy5hbnRlY2VkZW50KHZlcmlmaWVkKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICBhc3luYyBjb21tb25TdGF0ZShzdGF0ZVRhZ3MpIHtcbiAgICAvLyBSZXR1cm4gYSBsaXN0IGluIHdoaWNoOlxuICAgIC8vIC0gVGhlIGZpcnN0IGVsZW1lbnQgaXMgdGhlIG1vc3QgcmVjZW50IHN0YXRlIHRoYXQgaXMgY29tbW9uIGFtb25nIHRoZSBlbGVtZW50cyBvZiBzdGF0ZVRhZ3NcbiAgICAvLyAgIGRpc3JlZ2FyZGluZyBzdGF0ZXMgdGhhdCB3aG9seSBhIHN1YnNldCBvZiBhbm90aGVyIGluIHRoZSBsaXN0LlxuICAgIC8vICAgVGhpcyBtaWdodCBub3QgYmUgYXQgdGhlIHNhbWUgZGVwdGggZm9yIGVhY2ggb2YgdGhlIGxpc3RlZCBzdGF0ZXMhXG4gICAgLy8gLSBUaGUgcmVtYWluaW5nIGVsZW1lbnRzIGNvbnRhaW5zIGFsbCBhbmQgb25seSB0aG9zZSB2ZXJpZmllZFN0YXRlcyB0aGF0IGFyZSBpbmNsdWRlZCBpbiB0aGUgaGlzdG9yeSBvZiBzdGF0ZVRhZ3NcbiAgICAvLyAgIGFmdGVyIHRoZSBjb21tb24gc3RhdGUgb2YgdGhlIGZpcnN0IGVsZW1lbnQgcmV0dXJuZWQuIFRoZSBvcmRlciBvZiB0aGUgcmVtYWluaW5nIGVsZW1lbnRzIGRvZXMgbm90IG1hdHRlci5cbiAgICAvL1xuICAgIC8vIFRoaXMgaW1wbGVtZW50YXRpb24gbWluaW1pemVzIGFjY2VzcyB0aHJvdWdoIHRoZSBoaXN0b3J5LlxuICAgIC8vIChJdCB0cmFja3MgdGhlIHZlcmlmaWVkU3RhdGVzIGF0IGRpZmZlcmVudCBkZXB0aHMsIGluIG9yZGVyIHRvIGF2b2lkIGdvaW5nIHRocm91Z2ggdGhlIGhpc3RvcnkgbXVsdGlwbGUgdGltZXMuKVxuICAgIC8vIEhvd2V2ZXIsIGlmIHRoZSBmaXJzdCBzdGF0ZSBpbiB0aGUgbGlzdCBpcyBhIHJvb3Qgb2YgYWxsIHRoZSBvdGhlcnMsIGl0IHdpbGwgdHJhdmVyc2UgdGhhdCBmYXIgdGhyb3VnaCB0aGUgb3RoZXJzLlxuXG4gICAgaWYgKHN0YXRlVGFncy5sZW5ndGggPD0gMSkgcmV0dXJuIHN0YXRlVGFncztcblxuICAgIC8vIENoZWNrIGVhY2ggc3RhdGUgaW4gdGhlIGZpcnN0IHN0YXRlJ3MgYW5jZXN0cnksIGFnYWluc3QgYWxsIG90aGVyIHN0YXRlcywgYnV0IG9ubHkgZ28gYXMgZGVlcCBhcyBuZWVkZWQuXG4gICAgbGV0IFtvcmlnaW5hbENhbmRpZGF0ZVRhZywgLi4ub3JpZ2luYWxPdGhlclN0YXRlVGFnc10gPSBzdGF0ZVRhZ3M7XG4gICAgbGV0IGNhbmRpZGF0ZVRhZyA9IG9yaWdpbmFsQ2FuZGlkYXRlVGFnOyAvLyBXaWxsIHRha2Ugb24gc3VjY2Vzc2l2ZSB2YWx1ZXMgaW4gdGhlIG9yaWdpbmFsQ2FuZGlkYXRlVGFnIGhpc3RvcnkuXG5cbiAgICAvLyBBcyB3ZSBkZXNjZW5kIHRocm91Z2ggdGhlIGZpcnN0IHN0YXRlJ3MgY2FuZGlkYXRlcywga2VlcCB0cmFjayBvZiB3aGF0IHdlIGhhdmUgc2VlbiBhbmQgZ2F0aGVyZWQuXG4gICAgbGV0IGNhbmRpZGF0ZVZlcmlmaWVkU3RhdGVzID0gbmV3IE1hcCgpO1xuICAgIC8vIEZvciBlYWNoIG9mIHRoZSBvdGhlciBzdGF0ZXMgKGFzIGVsZW1lbnRzIGluIHRocmVlIGFycmF5cyk6XG4gICAgY29uc3Qgb3RoZXJTdGF0ZVRhZ3MgPSBbLi4ub3JpZ2luYWxPdGhlclN0YXRlVGFnc107IC8vIFdpbGwgYmUgYmFzaGVkIGFzIHdlIGRlc2NlbmQuXG4gICAgY29uc3Qgb3RoZXJWZXJpZmllZFN0YXRlcyA9IG90aGVyU3RhdGVUYWdzLm1hcCgoKSA9PiBbXSk7ICAgICAvLyBCdWlsZCB1cCBsaXN0IG9mIHRoZSB2ZXJpZmllZFN0YXRlcyBzZWVuIHNvIGZhci5cbiAgICBjb25zdCBvdGhlcnNTZWVuID0gb3RoZXJTdGF0ZVRhZ3MubWFwKCgpID0+IG5ldyBNYXAoKSk7IC8vIEtlZXAgYSBtYXAgb2YgZWFjaCBoYXNoID0+IHZlcmlmaWVkU3RhdGVzIHNlZW4gc28gZmFyLlxuICAgIC8vIFdlIHJlc2V0IHRoZXNlLCBzcGxpY2luZyBvdXQgdGhlIG90aGVyIGRhdGEuXG4gICAgZnVuY3Rpb24gcmVzZXQobmV3Q2FuZGlkYXRlLCBvdGhlckluZGV4KSB7IC8vIFJlc2V0IHRoZSBhYm92ZSBmb3IgYW5vdGhlciBpdGVyYXRpb24gdGhyb3VnaCB0aGUgZm9sbG93aW5nIGxvb3AsXG4gICAgICAvLyB3aXRoIG9uZSBvZiB0aGUgb3RoZXJEYXRhIHJlbW92ZWQgKGFuZCB0aGUgc2Vlbi92ZXJpZmllZFN0YXRlcyBmb3IgdGhlIHJlbWFpbmluZyBpbnRhY3QpLlxuICAgICAgLy8gVGhpcyBpcyB1c2VkIHdoZW4gb25lIG9mIHRoZSBvdGhlcnMgcHJvdmVzIHRvIGJlIGEgc3Vic2V0IG9yIHN1cGVyc2V0IG9mIHRoZSBjYW5kaWRhdGUuXG4gICAgICBjYW5kaWRhdGVUYWcgPSBuZXdDYW5kaWRhdGU7XG4gICAgICBjYW5kaWRhdGVWZXJpZmllZFN0YXRlcyA9IG51bGw7XG4gICAgICBbb3JpZ2luYWxPdGhlclN0YXRlVGFncywgb3RoZXJTdGF0ZVRhZ3MsIG90aGVyVmVyaWZpZWRTdGF0ZXMsIG90aGVyc1NlZW5dLmZvckVhY2goZGF0dW0gPT4gZGF0dW0uc3BsaWNlKG90aGVySW5kZXgsIDEpKTtcbiAgICB9XG4gICAgY29uc3Qga2V5ID0gdmVyaWZpZWQgPT4geyAvLyBCeSB3aGljaCB0byBkZWR1cGUgc3RhdGUgcmVjb3Jkcy5cbiAgICAgIHJldHVybiB2ZXJpZmllZC50YWc7XG4gICAgfTtcbiAgICBjb25zdCBpc0NhbmRpZGF0ZUluRXZlcnlIaXN0b3J5ID0gYXN5bmMgKCkgPT4geyAvLyBUcnVlIElGRiB0aGUgY3VycmVudCBjYW5kaWRhdGVUYWcgYXBwZWFyIGluIGFsbCB0aGUgb3RoZXJzLlxuICAgICAgZm9yIChjb25zdCBvdGhlckluZGV4IGluIG90aGVyc1NlZW4pIHsgLy8gU3VidGxlOiB0aGUgZm9sbG93aW5nIGhhcyBzaWRlLWVmZmVjdHMsIHNvIGNhbGxzIG11c3QgYmUgaW4gc2VyaWVzLlxuXHRpZiAoIWF3YWl0IGlzQ2FuZGlkYXRlSW5IaXN0b3J5KG90aGVyc1NlZW5bb3RoZXJJbmRleF0sIG90aGVySW5kZXgpKSByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9O1xuICAgIGNvbnN0IGlzQ2FuZGlkYXRlSW5IaXN0b3J5ID0gYXN5bmMgKG90aGVyU2Vlbiwgb3RoZXJJbmRleCkgPT4geyAvLyBUcnVlIElGRiB0aGUgY3VycmVudCBjYW5kaWRhdGUgaXMgaW4gdGhlIGdpdmVuIFN0YXRlJ3MgaGlzdG9yeS5cbiAgICAgIC8vIEhvd2V2ZXIsIGlmIGNhbmRpZGF0ZS9vdGhlciBhcmUgaW4gYSBsaW5lYXIgY2hhaW4sIGFuc3dlciBmYWxzZSBhbmQgcmVzZXQgdGhlIGxvb3Agd2l0aCBvdGhlciBzcGxpY2VkIG91dC5cbiAgICAgIHdoaWxlICghb3RoZXJTZWVuLmhhcyhjYW5kaWRhdGVUYWcpKSB7IC8vIEZhc3QgY2hlY2sgb2Ygd2hhdCB3ZSd2ZSBzZWVuIHNvIGZhci5cblx0Y29uc3Qgb3RoZXJUYWcgPSBvdGhlclN0YXRlVGFnc1tvdGhlckluZGV4XTsgLy8gQXMgd2UgZ28sIHdlIHJlY29yZCB0aGUgZGF0YSBzZWVuIGZvciB0aGlzIG90aGVyIFN0YXRlLlxuXHRpZiAoIW90aGVyVGFnKSByZXR1cm4gZmFsc2U7ICAgICAgICAgICAgICAgICAgICAgICAgIC8vIElmIG5vdCBhdCBlbmQuLi4gZ28gb25lIGZ1cnRoZXIgbGV2ZWwgZGVlcGVyIGluIHRoaXMgc3RhdGUuXG5cdGNvbnN0IHNlZW5WZXJpZmllZFN0YXRlcyA9IG90aGVyVmVyaWZpZWRTdGF0ZXNbb3RoZXJJbmRleF07ICAgLy8gTm90ZSBpbiBvdXIgaGFzaCA9PiBtZXNzYWdlIG1hcCwgYSBjb3B5IG9mIHRoZSB2ZXJpZmllZFN0YXRlcyBzZWVuLlxuXHRvdGhlclNlZW4uc2V0KG90aGVyVGFnLCBzZWVuVmVyaWZpZWRTdGF0ZXMuc2xpY2UoKSk7ICAvLyBBbmQgYWRkIHRoaXMgc3RhdGUncyBtZXNzYWdlIGZvciBvdXIgbWVzc2FnZSBhY2N1bXVsYXRvci5cblx0Y29uc3QgdmVyaWZpZWRTdGF0ZSA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZzogb3RoZXJUYWcsIG1lbWJlcjogbnVsbCwgc3luY2hyb25pemU6IGZhbHNlfSk7XG5cdGlmICh2ZXJpZmllZFN0YXRlKSBzZWVuVmVyaWZpZWRTdGF0ZXMucHVzaCh2ZXJpZmllZFN0YXRlKTtcblx0b3RoZXJTdGF0ZVRhZ3Nbb3RoZXJJbmRleF0gPSB0aGlzLmFudGVjZWRlbnQodmVyaWZpZWRTdGF0ZSk7XG4gICAgICB9XG4gICAgICAvLyBJZiBjYW5kaWRhdGUgb3IgdGhlIG90aGVyIGlzIHdob2x5IGEgc3Vic2V0IG9mIHRoZSBvdGhlciBpbiBhIGxpbmVhciBjaGFpbiwgZGlzcmVnYXJkIHRoZSBzdWJzZXQuXHQgIFxuICAgICAgLy8gSW4gb3RoZXIgd29yZHMsIHNlbGVjdCB0aGUgbG9uZ2VyIGNoYWluIHJhdGhlciB0aGFuIHNlZWtpbmcgdGhlIGNvbW1vbiBhbmNlc3RvciBvZiB0aGUgY2hhaW4uXG5cbiAgICAgIC8vIE9yaWdpbmFsIGNhbmRpZGF0ZSAoc2luY2UgcmVzZXQpIGlzIGEgc3Vic2V0IG9mIHRoaXMgb3RoZXI6IHRyeSBhZ2FpbiB3aXRoIHRoaXMgb3RoZXIgYXMgdGhlIGNhbmRpZGF0ZS5cbiAgICAgIGlmIChjYW5kaWRhdGVUYWcgPT09IG9yaWdpbmFsQ2FuZGlkYXRlVGFnKSByZXR1cm4gcmVzZXQob3JpZ2luYWxDYW5kaWRhdGVUYWcgPSBvcmlnaW5hbE90aGVyU3RhdGVUYWdzW290aGVySW5kZXhdKTtcbiAgICAgIC8vIE9yaWdpbmFsIGNhbmRpZGF0ZSAoc2luY2UgcmVzZXQpIGlzIHN1cGVyc2V0IG9mIHRoaXMgb3RoZXI6IHRyeSBhZ2FpbiB3aXRob3V0IHRoaXMgY2FuZGlkYXRlXG4gICAgICBpZiAoY2FuZGlkYXRlVGFnID09PSBvcmlnaW5hbE90aGVyU3RhdGVUYWdzW290aGVySW5kZXhdKSByZXR1cm4gcmVzZXQob3JpZ2luYWxDYW5kaWRhdGVUYWcpO1xuICAgICAgcmV0dXJuIHRydWU7ICAvLyBXZSBmb3VuZCBhIG1hdGNoIVxuICAgIH07XG5cbiAgICB3aGlsZSAoY2FuZGlkYXRlVGFnKSB7XG4gICAgICBpZiAoYXdhaXQgaXNDYW5kaWRhdGVJbkV2ZXJ5SGlzdG9yeSgpKSB7IC8vIFdlIGZvdW5kIGEgbWF0Y2ggaW4gZWFjaCBvZiB0aGUgb3RoZXIgU3RhdGVzOiBwcmVwYXJlIHJlc3VsdHMuXG5cdC8vIEdldCB0aGUgdmVyaWZpZWRTdGF0ZXMgdGhhdCB3ZSBhY2N1bXVsYXRlZCBmb3IgdGhhdCBwYXJ0aWN1bGFyIFN0YXRlIHdpdGhpbiB0aGUgb3RoZXJzLlxuXHRvdGhlcnNTZWVuLmZvckVhY2gobWVzc2FnZU1hcCA9PiBtZXNzYWdlTWFwLmdldChjYW5kaWRhdGVUYWcpLmZvckVhY2gobWVzc2FnZSA9PiBjYW5kaWRhdGVWZXJpZmllZFN0YXRlcy5zZXQoa2V5KG1lc3NhZ2UpLCBtZXNzYWdlKSkpO1xuXHRyZXR1cm4gW2NhbmRpZGF0ZVRhZywgLi4uY2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMudmFsdWVzKCldOyAvLyBXZSdyZSBkb25lIVxuICAgICAgfSBlbHNlIGlmIChjYW5kaWRhdGVWZXJpZmllZFN0YXRlcykge1xuXHQvLyBNb3ZlIHRvIHRoZSBuZXh0IGNhbmRpZGF0ZSAob25lIHN0ZXAgYmFjayBpbiB0aGUgZmlyc3Qgc3RhdGUncyBhbmNlc3RyeSkuXG5cdGNvbnN0IHZlcmlmaWVkU3RhdGUgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWc6IGNhbmRpZGF0ZVRhZywgbWVtYmVyOiBudWxsLCBzeW5jaHJvbml6ZTogZmFsc2V9KTtcblx0aWYgKCF2ZXJpZmllZFN0YXRlKSByZXR1cm4gW107IC8vIEZlbGwgb2ZmIHRoZSBlbmQuXG5cdFx0Y2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMuc2V0KGtleSh2ZXJpZmllZFN0YXRlKSwgdmVyaWZpZWRTdGF0ZSk7XG5cdGNhbmRpZGF0ZVRhZyA9IHRoaXMuYW50ZWNlZGVudCh2ZXJpZmllZFN0YXRlKTtcbiAgICAgIH0gZWxzZSB7IC8vIFdlJ3ZlIGJlZW4gcmVzZXQgdG8gc3RhcnQgb3Zlci5cblx0Y2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMgPSBuZXcgTWFwKCk7XG4gICAgICB9XG4gICAgfSAvLyBlbmQgd2hpbGVcblxuICAgIHJldHVybiBbXTsgICAvLyBObyBjb21tb24gYW5jZXN0b3IgZm91bmRcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbiBleHRlbmRzIE11dGFibGVDb2xsZWN0aW9uIHtcbiAgLy8gQSBWZXJzaW9uZWRDb2xsZWN0aW9uIGNhbiBiZSB1c2VkIGxpa2UgYW55IE11dGFibGVDb2xsZWN0aW9uLCByZXRyaWV2aW5nIHRoZSBtb3N0IHJlY2VudGx5IHN0b3JlZCBzdGF0ZS5cbiAgLy8gSXQgaGFzIHR3byBhZGRpdGlvbmFsIGZ1bmN0aW9uYWxpdGllczpcbiAgLy8gMS4gUHJldmlvdXMgc3RhdGVzIGNhbiBiZSByZXRyaWV2ZWQsIGVpdGhlciBieSB0YWcgb3IgYnkgdGltZXN0YW1wLlxuICAvLyAyLiBJRkYgdGhlIGRhdGEgcHJvdmlkZWQgYnkgdGhlIGFwcGxpY2F0aW9uIGluY2x1ZGVzIGEgc2luZ2xlIG1lc3NhZ2UsIGFjdGlvbiwgb3IgZGVsdGEgZm9yIGVhY2ggdmVyc2lvbixcbiAgLy8gICAgdGhlbiwgbWVyZ2luZyBvZiB0d28gYnJhbmNoZXMgb2YgdGhlIHNhbWUgaGlzdG9yeSBjYW4gYmUgYWNjb21wbGlzaGVkIGJ5IGFwcGx5aW5nIHRoZXNlIG1lc3NhZ2VzIHRvXG4gIC8vICAgIHJlY29uc3RydWN0IGEgY29tYmluZWQgaGlzdG9yeSAoc2ltaWxhcmx5IHRvIGNvbWJpbmluZyBicmFuY2hlcyBvZiBhIHRleHQgdmVyc2lvbmluZyBzeXN0ZW0pLlxuICAvLyAgICBJbiB0aGlzIGNhc2UsIHRoZSBhcHBsaWNhdGlvbiBtdXN0IHByb3ZpZGUgdGhlIG9wZXJhdGlvbiB0byBwcm9kdWNlIGEgbmV3IHN0YXRlIGZyb20gYW4gYW50ZWNlZGVudCBzdGF0ZVxuICAvLyAgICBhbmQgbWVzc3NhZ2UsIGFuZCB0aGUgVmVyc2lvbmVkQ29sbGVjdGlvbiB3aWxsIHByb3ZpZGUgdGhlIGNvcnJlY3QgY2FsbHMgdG8gbWFuYWdlIHRoaXMuXG4gIGFzeW5jIHN0b3JlKGRhdGEsIHRhZ09yT3B0aW9ucyA9IHt9KSB7XG4gICAgLy8gSGlkZGVuIHB1bjpcbiAgICAvLyBUaGUgZmlyc3Qgc3RvcmUgbWlnaHQgc3VjY2VlZCwgZW1pdCB0aGUgdXBkYXRlIGV2ZW50LCBwZXJzaXN0Li4uIGFuZCB0aGVuIGZhaWwgb24gdGhlIHNlY29uZCBzdG9yZS5cbiAgICAvLyBIb3dldmVyLCBpdCBqdXN0IHNvIGhhcHBlbnMgdGhhdCB0aGV5IGJvdGggZmFpbCB1bmRlciB0aGUgc2FtZSBjaXJjdW1zdGFuY2VzLiBDdXJyZW50bHkuXG4gICAgbGV0IHt0YWcsIGVuY3J5cHRpb24sIC4uLm9wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zKTtcbiAgICBjb25zdCByb290ID0gdGFnICYmIGF3YWl0IHRoaXMuZ2V0Um9vdCh0YWcsIGZhbHNlKTtcbiAgICBjb25zdCB2ZXJzaW9uVGFnID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5zdG9yZShkYXRhLCB7ZW5jcnlwdGlvbiwgYW50OiByb290LCBzdWJqZWN0OiB0YWcsIC4uLm9wdGlvbnN9KTtcbiAgICB0aGlzLmxvZygnc3RvcmU6IHJvb3QnLCB7dGFnLCBlbmNyeXB0aW9uLCBvcHRpb25zLCByb290LCB2ZXJzaW9uVGFnfSk7XG4gICAgaWYgKCF2ZXJzaW9uVGFnKSByZXR1cm4gJyc7XG4gICAgY29uc3Qgc2lnbmluZ09wdGlvbnMgPSB7XG4gICAgICB0YWc6IHRhZyB8fCAoYXdhaXQgdGhpcy52ZXJzaW9ucy5nZXRWZXJpZmllZCh7dGFnOiB2ZXJzaW9uVGFnLCBtZW1iZXI6IG51bGx9KSkucHJvdGVjdGVkSGVhZGVyLnN1YixcbiAgICAgIGVuY3J5cHRpb246ICcnLFxuICAgICAgLi4ub3B0aW9uc1xuICAgIH07XG4gICAgcmV0dXJuIHN1cGVyLnN0b3JlKFt2ZXJzaW9uVGFnXSwgc2lnbmluZ09wdGlvbnMpO1xuICB9XG4gIGFzeW5jIHJlbW92ZSh0YWdPck9wdGlvbnMpIHtcbiAgICBjb25zdCB7dGFnLCBlbmNyeXB0aW9uLCAuLi5vcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMxKHRhZ09yT3B0aW9ucyk7XG4gICAgYXdhaXQgdGhpcy5mb3JFYWNoU3RhdGUodGFnLCAoXywgaGFzaCkgPT4geyAvLyBTdWJ0bGU6IGRvbid0IHJldHVybiBlYXJseSBieSByZXR1cm5pbmcgdHJ1dGh5LlxuICAgICAgLy8gVGhpcyBtYXkgYmUgb3ZlcmtpbGwgdG8gYmUgdXNpbmcgaGlnaC1sZXZlbCByZW1vdmUsIGluc3RlYWQgb2YgcHV0IG9yIGV2ZW4gcGVyc2lzdC4gV2UgRE8gd2FudCB0aGUgdXBkYXRlIGV2ZW50IHRvIGZpcmUhXG4gICAgICAvLyBTdWJ0bGU6IHRoZSBhbnQgaXMgbmVlZGVkIHNvIHRoYXQgd2UgZG9uJ3Qgc2lsZW50bHkgc2tpcCB0aGUgYWN0dWFsIHB1dC9ldmVudC5cbiAgICAgIC8vIFN1YnRsZTogc3ViamVjdCBpcyBuZWVkZWQgc28gdGhhdCB1cGRhdGUgZXZlbnRzIGNhbiBsZWFybiB0aGUgVmVyc2lvbmVkIHN0YWcuXG4gICAgICB0aGlzLnZlcnNpb25zLnJlbW92ZSh7dGFnOiBoYXNoLCBhbnQ6IGhhc2gsIHN1YmplY3Q6IHRhZywgZW5jcnlwdGlvbjogJycsIC4uLm9wdGlvbnN9KTtcbiAgICB9KTtcbiAgICByZXR1cm4gc3VwZXIucmVtb3ZlKHRhZ09yT3B0aW9ucyk7XG4gIH1cbiAgYXN5bmMgcmV0cmlldmUodGFnT3JPcHRpb25zKSB7XG4gICAgbGV0IHt0YWcsIHRpbWUsIGhhc2gsIC4uLm9wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zKTtcbiAgICBpZiAoIWhhc2ggJiYgIXRpbWUpIGhhc2ggPSBhd2FpdCB0aGlzLmdldFJvb3QodGFnKTtcbiAgICB0aGlzLmxvZygncmV0cmlldmUnLCB7dGFnLCB0aW1lLCBoYXNoLCBvcHRpb25zfSk7XG4gICAgaWYgKGhhc2gpIHJldHVybiB0aGlzLnZlcnNpb25zLnJldHJpZXZlKHt0YWc6IGhhc2gsIC4uLm9wdGlvbnN9KTtcbiAgICB0aW1lID0gcGFyc2VGbG9hdCh0aW1lKTtcbiAgICByZXR1cm4gdGhpcy5mb3JFYWNoU3RhdGUodGFnLCB2ZXJpZmllZCA9PiAodmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmlhdCA8PSB0aW1lKSAmJiB2ZXJpZmllZCk7XG4gIH1cblxuICBjaGVja0RhdGUoZXhpc3RpbmcsIHByb3Bvc2VkKSB7IC8vIENhbiBhbHdheXMgbWVyZ2UgaW4gYW4gb2xkZXIgbWVzc2FnZS4gV2Uga2VlcCAnZW0gYWxsLlxuICAgIHJldHVybiBudWxsO1xuICB9XG4gIC8vIElmIGEgbm9uLW93bmVyIGlzIGdpdmVuIGEgc3RhdGUgdGhhdCBpcyBub3QgYSBzdWJzZXQgb2YgdGhlIGV4aXN0aW5nIChvciB2aWNlIHZlcnNhKSwgdGhlbiBpdCBjcmVhdGVzIGEgbmV3XG4gIC8vIGNvbWJpbmVkIHJlY29yZCB0aGF0IGxpc3RzIHRoZSBnaXZlbiBhbmQgZXhpc3Rpbmcgc3RhdGVzLiBJbiB0aGlzIGNhc2UsIHdlIHN0aWxsIG5lZWQgdG8gcHJlc2VydmUgdGhlXG4gIC8vIG9yaWdpbmFsIG93bmVyIHNvIHRoYXQgbGF0ZXIgbWVyZ2VycyBjYW4gd2hldGhlciBvciBub3QgdGhleSBhcmUgb3duZXJzLiAoSWYgdGhleSBsaWUsIHRoZSB0cnVlIGdyb3VwIG93bmVyc1xuICAvLyB3aWxsIGlnbm9yZSB0aGUgZ2FyYmFnZSBkYXRhLCBzbyBpdCdzIG5vdCBzZWN1cml0eSBpc3N1ZS4pIEl0IGRvZXNuJ3QgaGVscCB0byBnZXQgdGhlIG93bmVyIGJ5IGZvbGxvd2luZ1xuICAvLyB0aGUgdGFnIHRocm91Z2ggdG8gdGhlIHN0YXRlJ3Mgc2lnbmF0dXJlLCBiZWNhdXNlIGluIHNvbWUgY2FzZXMsIG5vbi1tZW1iZXJzIG1heSBiZSBhbGxvd2VkIHRvIGluamVjdFxuICAvLyBhIG1lc3NhZ2UgaW50byB0aGUgZ3JvdXAsIGluIHdoaWNoIGNhc2UgdGhlIHN0YXRlIHdvbid0IGJlIHNpZ25lZCBieSB0aGUgZ3JvdXAgZWl0aGVyLiBPdXIgc29sdXRpb24gaXNcbiAgLy8gdG8gaW50cm9kdWNlIG5ldyB0YWdzIHRvIGxhYmVsIHRoZSBvcmlnaW5hbCBvd25lci4gV2UgbmVlZCB0d28gdGFncyBiZWNhdXNlIHdlIGFsc28gdG8ga25vdyB3aGV0aGVyIHRoZVxuICAvLyBvcmlnaW5hbCBvd25lciB3YXMgYSBncm91cCBvciBhbiBpbmRpdmlkdWFsLlxuICBnZXRPd25lcihwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gVXNlZCBpbiBjaGVja093bmVyLlxuICAgIGNvbnN0IHtncm91cCwgaW5kaXZpZHVhbH0gPSBwcm90ZWN0ZWRIZWFkZXI7XG4gICAgcmV0dXJuIGdyb3VwIHx8IGluZGl2aWR1YWwgfHwgc3VwZXIuZ2V0T3duZXIocHJvdGVjdGVkSGVhZGVyKTtcbiAgfVxuICBnZW5lcmF0ZU93bmVyT3B0aW9ucyhwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gR2VuZXJhdGUgdHdvIHNldHMgb2Ygc2lnbmluZyBvcHRpb25zOiBvbmUgZm9yIG93bmVyIHRvIHVzZSwgYW5kIG9uZSBmb3Igb3RoZXJzXG4gICAgLy8gVGhlIHNwZWNpYWwgaGVhZGVyIGNsYWltcyAnZ3JvdXAnIGFuZCAnaW5kaXZpZHVhbCcgYXJlIGNob3NlbiB0byBub3QgaW50ZXJmZXJlIHdpdGggX2Nhbm9uaWNhbGl6ZU9wdGlvbnMuXG4gICAgY29uc3Qge2dyb3VwLCBpbmRpdmlkdWFsLCBpc3MsIGtpZH0gPSBwcm90ZWN0ZWRIZWFkZXI7XG4gICAgY29uc3QgdGFncyA9IFtDcmVkZW50aWFscy5hdXRob3JdO1xuICAgIGlmIChncm91cCkgICAgICByZXR1cm4gW3t0ZWFtOiBncm91cH0sICAgICAgICAgICAgICAgICAge3RhZ3MsIGdyb3VwfV07XG4gICAgaWYgKGluZGl2aWR1YWwpIHJldHVybiBbe3RlYW06ICcnLCBtZW1iZXI6IGluZGl2aWR1YWx9LCB7dGFncywgaW5kaXZpZHVhbH1dOyAgICAgICAgLy8gY2hlY2sgYmVmb3JlIGlzc1xuICAgIGlmIChpc3MpICAgICAgICByZXR1cm4gW3t0ZWFtOiBpc3N9LCAgICAgICAgICAgICAgICAgICAge3RhZ3MsIGdyb3VwOiBpc3N9XTtcbiAgICBlbHNlICAgICAgICAgICAgcmV0dXJuIFt7dGVhbTogJycsIG1lbWJlcjoga2lkfSwgICAgICAgIHt0YWdzLCBpbmRpdmlkdWFsOiBraWR9XTtcbiAgfVxuICBcbiAgYXN5bmMgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlKSB7XG4gICAgY29uc3Qgc3RhdGVzID0gdmFsaWRhdGlvbi5qc29uIHx8IFtdO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdmFsaWRhdGlvbi5leGlzdGluZz8uanNvbiB8fCBbXTtcbiAgICB0aGlzLmxvZygnbWVyZ2VTaWduYXR1cmVzJywge3RhZywgZXhpc3RpbmcsIHN0YXRlc30pO1xuICAgIGlmIChzdGF0ZXMubGVuZ3RoID09PSAxICYmICFleGlzdGluZy5sZW5ndGgpIHJldHVybiBzaWduYXR1cmU7IC8vIEluaXRpYWwgY2FzZS4gVHJpdmlhbC5cbiAgICBpZiAoZXhpc3RpbmcubGVuZ3RoID09PSAxICYmICFzdGF0ZXMubGVuZ3RoKSByZXR1cm4gdmFsaWRhdGlvbi5leGlzdGluZy5zaWduYXR1cmU7XG5cbiAgICAvLyBMZXQncyBzZWUgaWYgd2UgY2FuIHNpbXBsaWZ5XG4gICAgY29uc3QgY29tYmluZWQgPSBbLi4uc3RhdGVzLCAuLi5leGlzdGluZ107XG4gICAgbGV0IFthbmNlc3RvciwgLi4udmVyc2lvbnNUb1JlcGxheV0gPSBhd2FpdCB0aGlzLnZlcnNpb25zLmNvbW1vblN0YXRlKGNvbWJpbmVkKTtcbiAgICB0aGlzLmxvZygnbWVyZ2VTaWduYXR1cmVzJywge3RhZywgZXhpc3RpbmcsIHN0YXRlcywgYW5jZXN0b3IsIHZlcnNpb25zVG9SZXBsYXl9KTtcbiAgICBpZiAoY29tYmluZWQubGVuZ3RoID09PSAyKSB7IC8vIENvbW1vbiBjYXNlcyB0aGF0IGNhbiBiZSBoYW5kbGVkIHdpdGhvdXQgYmVpbmcgYSBtZW1iZXJcbiAgICAgIGlmIChhbmNlc3RvciA9PT0gc3RhdGVzWzBdKSByZXR1cm4gc2lnbmF0dXJlO1xuICAgICAgaWYgKGFuY2VzdG9yID09PSBleGlzdGluZ1swXSkgcmV0dXJuIHZhbGlkYXRpb24uZXhpc3Rpbmcuc2lnbmF0dXJlO1xuICAgIH1cblxuICAgIGNvbnN0IFthc093bmVyLCBhc090aGVyXSA9IHRoaXMuZ2VuZXJhdGVPd25lck9wdGlvbnModmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIpO1xuICAgIGlmICghYXdhaXQgdGhpcy5zaWduKCdhbnl0aGluZycsIGFzT3duZXIpLmNhdGNoKCgpID0+IGZhbHNlKSkgeyAvLyBXZSBkb24ndCBoYXZlIGFjY2Vzcy5cbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLnNpZ24oY29tYmluZWQsIHtlbmNyeXB0aW9uOiAnJywgLi4uYXNPdGhlcn0pOyAvLyBKdXN0IGFuc3dlciB0aGUgY29tYmluZWQgbGlzdCB0byBiZSBwZXJzaXN0ZWQuXG4gICAgfVxuICAgIC8vIEdldCB0aGUgc3RhdGUgdmVyaWZpY2F0aW9ucyB0byByZXBsYXkuXG4gICAgaWYgKCFhbmNlc3RvcikgdmVyc2lvbnNUb1JlcGxheSA9IGF3YWl0IFByb21pc2UuYWxsKGNvbWJpbmVkLm1hcChhc3luYyBzdGF0ZVRhZyA9PiB0aGlzLnZlcnNpb25zLmdldFZlcmlmaWVkKHt0YWc6IHN0YXRlVGFnLCBzeW5jaHJvbml6ZTogZmFsc2V9KSkpO1xuICAgIHZlcnNpb25zVG9SZXBsYXkuc29ydCgoYSwgYikgPT4gYS5wcm90ZWN0ZWRIZWFkZXIuaWF0IC0gYi5wcm90ZWN0ZWRIZWFkZXIuaWF0KTtcblxuICAgIGF3YWl0IHRoaXMuYmVnaW5SZXBsYXkoYW5jZXN0b3IpO1xuICAgIGZvciAobGV0IHZlcmlmaWVkIG9mIHZlcnNpb25zVG9SZXBsYXkpIHtcbiAgICAgIGF3YWl0IHRoaXMuZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKTsgLy8gY29tbW9uU3RhdGVzIGRvZXMgbm90IChjYW5ub3QpIGRlY3J5cHQuXG4gICAgICBjb25zdCByZXBsYXlSZXN1bHQgPSBhd2FpdCB0aGlzLnJlcGxheShhbmNlc3RvciwgdmVyaWZpZWQpO1xuICAgICAgaWYgKHZlcmlmaWVkID09PSByZXBsYXlSZXN1bHQpIHsgLy8gQWxyZWFkeSBnb29kLlxuXHRhbmNlc3RvciA9IHZlcmlmaWVkLnRhZztcbiAgICAgIH0gZWxzZSB7IC8vIFJlY29yZCByZXBsYXlSZXN1bHQgaW50byBhIG5ldyBzdGF0ZSBhZ2FpbnN0IHRoZSBhbnRlY2VkZW50LCBwcmVzZXJ2aW5nIGdyb3VwLCBpYXQsIGVuY3J5cHRpb24uXG5cdGNvbnN0IHtlbmNyeXB0aW9uID0gJycsIGlhdDp0aW1lfSA9IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlcjtcblx0Y29uc3Qgc2lnbmluZ09wdGlvbnMgPSB7YW50OmFuY2VzdG9yLCB0aW1lLCBlbmNyeXB0aW9uLCBzdWJqZWN0OnRhZywgLi4uYXNPd25lcn07XG5cdC8vIFBhc3Npbmcgc3luY2hyb25pemVyIHByZXZlbnRzIHVzIGZyb20gcmVjaXJjdWxhdGluZyB0byB0aGUgcGVlciB0aGF0IHRvbGQgdXMuXG5cdC8vIFRPRE86IElzIHRoYXQgd2hhdCB3ZSB3YW50LCBhbmQgaXMgaXQgc3VmZmljaWVudCBpbiBhIG5ldHdvcmsgb2YgbXVsdGlwbGUgcmVsYXlzP1xuXHRjb25zdCBuZXh0LyphbmNlc3RvciovID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5zdG9yZShyZXBsYXlSZXN1bHQsIHNpZ25pbmdPcHRpb25zLCB2ZXJpZmllZC5zeW5jaHJvbml6ZXIpO1xuXHR0aGlzLmxvZyh7YW5jZXN0b3IsIHZlcmlmaWVkLCByZXBsYXlSZXN1bHQsIHNpZ25pbmdPcHRpb25zLCBuZXh0fSk7XG5cdGFuY2VzdG9yID0gbmV4dDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc2lnbihbYW5jZXN0b3JdLCB7dGFnLCAuLi5hc093bmVyLCBlbmNyeXB0aW9uOiAnJ30pO1xuICB9XG5cbiAgLy8gVHdvIGhvb2tzIGZvciBzdWJjbGFzc2VzIHRvIG92ZXJyaWRlLlxuICBiZWdpblJlcGxheShhbnRlY2VkZW50VGFnKSB7XG4gIH1cbiAgcmVwbGF5KGFudGVjZWRlbnRUYWcsIHZlcmlmaWVkKSB7XG4gICAgaWYgKGFudGVjZWRlbnRUYWcgPT09IHZlcmlmaWVkLmFudCkgcmV0dXJuIHZlcmlmaWVkOyAvLyBSZXR1cm5pbmcgdGhlID09PSB2ZXJpZmllZCBpbmRpY2F0ZXMgaXQgY2FuIGJlIHJldXNlZCBkaXJlY3RseS5cbiAgICByZXR1cm4gdmVyaWZpZWQuanNvbiB8fCB2ZXJpZmllZC50ZXh0IHx8IHZlcmlmaWVkLnBheWxvYWQ7IC8vIEhpZ2hlc3QgZm9ybSB3ZSd2ZSBnb3QuXG4gIH1cblxuICBhc3luYyBnZXRSb290KHRhZywgc3luY2hyb25pemUgPSB0cnVlKSB7IC8vIFByb21pc2UgdGhlIHRhZyBvZiB0aGUgbW9zdCByZWNlbnQgc3RhdGVcbiAgICBjb25zdCB2ZXJpZmllZFZlcnNpb24gPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIG1lbWJlcjogbnVsbCwgc3luY2hyb25pemV9KTtcbiAgICB0aGlzLmxvZygnZ2V0Um9vdCcsIHt0YWcsIHZlcmlmaWVkVmVyc2lvbn0pO1xuICAgIGlmICghdmVyaWZpZWRWZXJzaW9uKSByZXR1cm4gJyc7XG4gICAgY29uc3Qgc3RhdGVzID0gdmVyaWZpZWRWZXJzaW9uLmpzb247XG4gICAgaWYgKHN0YXRlcy5sZW5ndGggIT09IDEpIHJldHVybiBQcm9taXNlLnJlamVjdChgVW5tZXJnZWQgc3RhdGVzIGluICR7dGFnfS5gKTtcbiAgICByZXR1cm4gc3RhdGVzWzBdO1xuICB9XG4gIGFzeW5jIGZvckVhY2hTdGF0ZSh0YWcsIGNhbGxiYWNrKSB7XG4gICAgLy8gR2V0IHRoZSByb290IG9mIHRoaXMgaXRlbSBhdCB0YWcsIGFuZCBjYWxsYmFjayh2ZXJpZmllZFN0YXRlLCBzdGF0ZVRhZykgb24gdGhlIGNoYWluLlxuICAgIC8vIFN0b3BzIGl0ZXJhdGlvbiBhbmQgcmV0dXJucyB0aGUgZmlyc3QgdHJ1dGh5IHZhbHVlIGZyb20gY2FsbGJhY2suXG4gICAgY29uc3Qgcm9vdCA9IGF3YWl0IHRoaXMuZ2V0Um9vdCh0YWcsIGZhbHNlKTtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy52ZXJzaW9ucy5mb3JFYWNoU3RhdGUocm9vdCwgY2FsbGJhY2spO1xuICB9XG5cbiAgLy8gVGhlc2UgYXJlIG1vc3RseSBmb3IgZGVidWdnaW5nIGFuZCBhdXRvbWF0ZWQgdGVzdGluZywgYXMgdGhleSBoYXZlIHRvIHRocm91Z2ggdGhlIHN0YXRlIGNoYWluLlxuICAvLyBCdXQgdGhleSBhbHNvIGlsbHVzdHJhdGUgaG93IHRoaW5ncyB3b3JrLlxuICBhc3luYyByZXRyaWV2ZVRpbWVzdGFtcHModGFnKSB7IC8vIFByb21pc2VzIGEgbGlzdCBvZiBhbGwgdmVyc2lvbiB0aW1lc3RhbXBzLlxuICAgIGxldCB0aW1lcyA9IFtdO1xuICAgIGF3YWl0IHRoaXMuZm9yRWFjaFN0YXRlKHRhZywgdmVyaWZpZWQgPT4geyAvLyBTdWJ0bGU6IHJldHVybiBub3RoaW5nLiAoRG9uJ3QgYmFpbCBlYXJseS4pXG4gICAgICB0aW1lcy5wdXNoKHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5pYXQpO1xuICAgIH0pO1xuICAgIHJldHVybiB0aW1lcy5yZXZlcnNlKCk7XG4gIH0gIFxuICBhc3luYyBnZXRWZXJzaW9ucyh0YWcpIHsgLy8gUHJvbWlzZXMgdGhlIHBhcnNlZCB0aW1lc3RhbXAgPT4gdmVyc2lvbiBkaWN0aW9uYXJ5IElGIGl0IGV4aXN0cywgZWxzZSBmYWxzeS5cbiAgICBsZXQgdGltZXMgPSB7fSwgbGF0ZXN0O1xuICAgIGF3YWl0IHRoaXMuZm9yRWFjaFN0YXRlKHRhZywgKHZlcmlmaWVkLCB0YWcpID0+IHtcbiAgICAgIGlmICghbGF0ZXN0KSBsYXRlc3QgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuaWF0O1xuICAgICAgdGltZXNbdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmlhdF0gPSB0YWc7XG4gICAgfSk7XG4gICAgbGV0IHJldmVyc2VkID0ge2xhdGVzdDogbGF0ZXN0fTtcbiAgICBPYmplY3QuZW50cmllcyh0aW1lcykucmV2ZXJzZSgpLmZvckVhY2goKFtrLCB2XSkgPT4gcmV2ZXJzZWRba10gPSB2KTtcbiAgICByZXR1cm4gcmV2ZXJzZWQ7XG4gIH1cblxuICAvLyBNYWludGFpbmluZyBhbiBhdXhpbGlhcnkgY29sbGVjdGlvbiBpbiB3aGljaCBzdG9yZSB0aGUgdmVyc2lvbnMgYXMgaW1tdXRhYmxlcy5cbiAgc3RhdGljIHN0YXRlQ29sbGVjdGlvbkNsYXNzID0gU3RhdGVDb2xsZWN0aW9uOyAvLyBTdWJjbGNhc3NlcyBtYXkgZXh0ZW5kLlxuICBjb25zdHJ1Y3Rvcih7c2VydmljZXMgPSBbXSwgLi4ucmVzdH0gPSB7fSkge1xuICAgIHN1cGVyKHJlc3QpOyAgLy8gV2l0aG91dCBwYXNzaW5nIHNlcnZpY2VzIHlldCwgYXMgd2UgZG9uJ3QgaGF2ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiBzZXQgdXAgeWV0LlxuICAgIHRoaXMudmVyc2lvbnMgPSBuZXcgdGhpcy5jb25zdHJ1Y3Rvci5zdGF0ZUNvbGxlY3Rpb25DbGFzcyhyZXN0KTsgLy8gU2FtZSBjb2xsZWN0aW9uIG5hbWUsIGJ1dCBkaWZmZXJlbnQgdHlwZS5cbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTsgLy8gTm93IHdlIGNhbiBzeW5jaHJvbml6ZS5cbiAgfVxuICBhc3luYyBjbG9zZSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmNsb3NlKCk7XG4gICAgYXdhaXQgc3VwZXIuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVzdHJveSgpO1xuICAgIGF3YWl0IHN1cGVyLmRlc3Ryb3koKTtcbiAgfVxuICAvLyBTeW5jaHJvbml6YXRpb24gb2YgdGhlIGF1eGlsaWFyeSBjb2xsZWN0aW9uLlxuICBzZXJ2aWNlRm9yVmVyc2lvbihzZXJ2aWNlKSB7IC8vIEdldCB0aGUgc2VydmljZSBcIm5hbWVcIiBmb3Igb3VyIHZlcnNpb25zIGNvbGxlY3Rpb24uXG4gICAgcmV0dXJuIHNlcnZpY2U/LnZlcnNpb25zIHx8IHNlcnZpY2U7ICAgLy8gRm9yIHRoZSB3ZWlyZCBjb25uZWN0RGlyZWN0VGVzdGluZyBjYXNlIHVzZWQgaW4gcmVncmVzc2lvbiB0ZXN0cywgZWxzZSB0aGUgc2VydmljZSAoZS5nLiwgYW4gYXJyYXkgb2Ygc2lnbmFscykuXG4gIH1cbiAgc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSB7XG4gICAgcmV0dXJuIHNlcnZpY2VzLm1hcChzZXJ2aWNlID0+IHRoaXMuc2VydmljZUZvclZlcnNpb24oc2VydmljZSkpO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSB7IC8vIHN5bmNocm9uaXplIHRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uLCB0b28uXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHJldHVybjtcbiAgICAvLyBLZWVwIGNoYW5uZWwgY3JlYXRpb24gc3luY2hyb25vdXMuXG4gICAgY29uc3QgdmVyc2lvbmVkUHJvbWlzZSA9IHN1cGVyLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTtcbiAgICBjb25zdCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbnMuc3luY2hyb25pemUoLi4udGhpcy5zZXJ2aWNlc0ZvclZlcnNpb24oc2VydmljZXMpKTtcbiAgICBhd2FpdCB2ZXJzaW9uZWRQcm9taXNlO1xuICAgIGF3YWl0IHZlcnNpb25Qcm9taXNlO1xuICB9XG4gIGFzeW5jIGRpc2Nvbm5lY3QoLi4uc2VydmljZXMpIHsgLy8gZGlzY29ubmVjdCB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiwgdG9vLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgYXdhaXQgdGhpcy52ZXJzaW9ucy5kaXNjb25uZWN0KC4uLnRoaXMuc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSk7XG4gICAgYXdhaXQgc3VwZXIuZGlzY29ubmVjdCguLi5zZXJ2aWNlcyk7XG4gIH1cbiAgZ2V0IHN5bmNocm9uaXplZCgpIHsgLy8gcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gc3luY2hyb25pemF0aW9uIGlzIGNvbXBsZXRlIGluIEJPVEggZGlyZWN0aW9ucy5cbiAgICAvLyBUT0RPPyBUaGlzIGRvZXMgbm90IHJlZmxlY3QgY2hhbmdlcyBhcyBTeW5jaHJvbml6ZXJzIGFyZSBhZGRlZCBvciByZW1vdmVkIHNpbmNlIGNhbGxlZC4gU2hvdWxkIGl0P1xuICAgIHJldHVybiB0aGlzLnZlcnNpb25zLnN5bmNocm9uaXplZC50aGVuKCgpID0+IHN1cGVyLnN5bmNocm9uaXplZCk7XG4gIH1cbiAgZ2V0IGl0ZW1FbWl0dGVyKCkgeyAvLyBUaGUgdmVyc2lvbnMgY29sbGVjdGlvbiBlbWl0cyBhbiB1cGRhdGUgY29ycmVzcG9uZGluZyB0byB0aGUgaW5kaXZpZHVhbCBpdGVtIHN0b3JlZC5cbiAgICAvLyAoVGhlIHVwZGF0ZXMgZW1pdHRlZCBmcm9tIHRoZSB3aG9sZSBtdXRhYmxlIFZlcnNpb25lZENvbGxlY3Rpb24gY29ycmVzcG9uZCB0byB0aGUgdmVyc2lvbiBzdGF0ZXMuKVxuICAgIHJldHVybiB0aGlzLnZlcnNpb25zO1xuICB9XG59XG5cbi8vIFdoZW4gcnVubmluZyBpbiBOb2RlSlMsIHRoZSBTZWN1cml0eSBvYmplY3QgaXMgYXZhaWxhYmxlIGRpcmVjdGx5LlxuLy8gSXQgaGFzIGEgU3RvcmFnZSBwcm9wZXJ0eSwgd2hpY2ggZGVmaW5lcyBzdG9yZS9yZXRyaWV2ZSAoaW4gbGliL3N0b3JhZ2UubWpzKSB0byBHRVQvUFVULlxuLy8gVGhlIFNlY3VyaXR5LlN0b3JhZ2UgY2FuIGJlIHNldCBieSBjbGllbnRzIHRvIHNvbWV0aGluZyBlbHNlLlxuLy9cbi8vIFdoZW4gcnVubmluZyBpbiBhIGJyb3dzZXIsIHdvcmtlci5qcyBvdmVycmlkZXMgdGhpcyB0byBzZW5kIG1lc3NhZ2VzIHRocm91Z2ggdGhlIEpTT04gUlBDXG4vLyB0byB0aGUgYXBwLCB3aGljaCB0aGVuIGFsc28gaGFzIGFuIG92ZXJyaWRhYmxlIFNlY3VyaXR5LlN0b3JhZ2UgdGhhdCBpcyBpbXBsZW1lbnRlZCB3aXRoIHRoZSBzYW1lIGNvZGUgYXMgYWJvdmUuXG5cbi8vIEJhc2ggaW4gc29tZSBuZXcgc3R1ZmY6XG5DcmVkZW50aWFscy5hdXRob3IgPSBudWxsO1xuQ3JlZGVudGlhbHMub3duZXIgPSBudWxsO1xuQ3JlZGVudGlhbHMuZW5jcnlwdGlvbiA9IG51bGw7IC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGF1ZGllbmNlXG5DcmVkZW50aWFscy5zeW5jaHJvbml6ZSA9IGFzeW5jICguLi5zZXJ2aWNlcykgPT4geyAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBjb25uZWN0LlxuICAvLyBXZSBjYW4gZG8gYWxsIHRocmVlIGluIHBhcmFsbGVsIC0tIHdpdGhvdXQgd2FpdGluZyBmb3IgY29tcGxldGlvbiAtLSBiZWNhdXNlIGRlcGVuZGVuY2llcyB3aWxsIGdldCBzb3J0ZWQgb3V0IGJ5IHN5bmNocm9uaXplMS5cbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uc3luY2hyb25pemUoLi4uc2VydmljZXMpKSk7XG59O1xuQ3JlZGVudGlhbHMuc3luY2hyb25pemVkID0gYXN5bmMgKCkgPT4ge1xuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5zeW5jaHJvbml6ZWQpKTtcbn1cbkNyZWRlbnRpYWxzLmRpc2Nvbm5lY3QgPSBhc3luYyAoLi4uc2VydmljZXMpID0+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZGlzY29ubmVjdCguLi5zZXJ2aWNlcykpKTtcbn1cblxuQ3JlZGVudGlhbHMudGVhbU1lbWJlcnMgPSBhc3luYyAodGFnLCByZWN1cnNpdmUgPSBmYWxzZSkgPT4geyAvLyBMaXN0IHRoZSBtZW1iZXIgdGFncyBvZiB0aGlzIHRlYW0uXG4gIGNvbnN0IHRlYW0gPSBhd2FpdCBDcmVkZW50aWFscy5jb2xsZWN0aW9ucy5UZWFtLnJldHJpZXZlKHt0YWcsIG1lbWJlcjogbnVsbH0pO1xuICBjb25zdCBtZW1iZXJzID0gdGVhbS5qc29uPy5yZWNpcGllbnRzLm1hcChtID0+IG0uaGVhZGVyLmtpZCkgfHwgW107XG4gIGlmICghcmVjdXJzaXZlKSByZXR1cm4gbWVtYmVycztcbiAgcmV0dXJuIFt0YWddLmNvbmNhdCguLi5hd2FpdCBQcm9taXNlLmFsbChtZW1iZXJzLm1hcCh0YWcgPT4gQ3JlZGVudGlhbHMudGVhbU1lbWJlcnModGFnLCB0cnVlKSkpKTtcbn1cbkNyZWRlbnRpYWxzLmNyZWF0ZUF1dGhvciA9IGFzeW5jIChwcm9tcHQpID0+IHsgLy8gQ3JlYXRlIGEgdXNlcjpcbiAgLy8gSWYgcHJvbXB0IGlzICctJywgY3JlYXRlcyBhbiBpbnZpdGF0aW9uIGFjY291bnQsIHdpdGggYSBuby1vcCByZWNvdmVyeSBhbmQgbm8gZGV2aWNlLlxuICAvLyBPdGhlcndpc2UsIHByb21wdCBpbmRpY2F0ZXMgdGhlIHJlY292ZXJ5IHByb21wdHMsIGFuZCB0aGUgYWNjb3VudCBoYXMgdGhhdCBhbmQgYSBkZXZpY2UuXG4gIGlmIChwcm9tcHQgPT09ICctJykgcmV0dXJuIENyZWRlbnRpYWxzLmNyZWF0ZShhd2FpdCBDcmVkZW50aWFscy5jcmVhdGUoe3Byb21wdH0pKTtcbiAgY29uc3QgW2xvY2FsLCByZWNvdmVyeV0gPSBhd2FpdCBQcm9taXNlLmFsbChbQ3JlZGVudGlhbHMuY3JlYXRlKCksIENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0fSldKTtcbiAgcmV0dXJuIENyZWRlbnRpYWxzLmNyZWF0ZShsb2NhbCwgcmVjb3ZlcnkpO1xufTtcbkNyZWRlbnRpYWxzLmNsYWltSW52aXRhdGlvbiA9IGFzeW5jICh0YWcsIG5ld1Byb21wdCkgPT4geyAvLyBDcmVhdGVzIGEgbG9jYWwgZGV2aWNlIHRhZyBhbmQgYWRkcyBpdCB0byB0aGUgZ2l2ZW4gaW52aXRhdGlvbiB0YWcsXG4gIC8vIHVzaW5nIHRoZSBzZWxmLXZhbGlkYXRpbmcgcmVjb3ZlcnkgbWVtYmVyIHRoYXQgaXMgdGhlbiByZW1vdmVkIGFuZCBkZXN0cm95ZWQuXG4gIGNvbnN0IG1lbWJlcnMgPSBhd2FpdCBDcmVkZW50aWFscy50ZWFtTWVtYmVycyh0YWcpO1xuICBpZiAobWVtYmVycy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgSW52aXRhdGlvbnMgc2hvdWxkIGhhdmUgb25lIG1lbWJlcjogJHt0YWd9YCk7XG4gIGNvbnN0IG9sZFJlY292ZXJ5VGFnID0gbWVtYmVyc1swXTtcbiAgY29uc3QgbmV3UmVjb3ZlcnlUYWcgPSBhd2FpdCBDcmVkZW50aWFscy5jcmVhdGUoe3Byb21wdDogbmV3UHJvbXB0fSk7XG4gIGNvbnN0IGRldmljZVRhZyA9IGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSgpO1xuXG4gIC8vIFdlIG5lZWQgdG8gYWRkIHRoZSBuZXcgbWVtYmVycyBpbiBvbmUgY2hhbmdlTWVtYmVyc2hpcCBzdGVwLCBhbmQgdGhlbiByZW1vdmUgdGhlIG9sZFJlY292ZXJ5VGFnIGluIGEgc2Vjb25kIGNhbGwgdG8gY2hhbmdlTWVtYmVyc2hpcDpcbiAgLy8gY2hhbmdlTWVtYmVyc2hpcCB3aWxsIHNpZ24gYnkgYW4gT0xEIG1lbWJlciAtIElmIGl0IHNpZ25lZCBieSBuZXcgbWVtYmVyIHRoYW4gcGVvcGxlIGNvdWxkIGJvb3RzdHJhcCB0aGVtc2VsdmVzIG9udG8gYSB0ZWFtLlxuICAvLyBCdXQgaWYgd2UgcmVtb3ZlIHRoZSBvbGRSZWNvdmVyeSB0YWcgaW4gdGhlIHNhbWUgc3RlcCBhcyBhZGRpbmcgdGhlIG5ldywgdGhlIHRlYW0gd291bGQgYmUgc2lnbmVkIGJ5IHNvbWVvbmUgKHRoZSBvbGRSZWNvdmVyeVRhZykgdGhhdFxuICAvLyBpcyBubyBsb25nZXIgYSBtZW1iZXIsIGFuZCBzbyB0aGUgdGVhbSB3b3VsZCBub3QgdmVyaWZ5IVxuICBhd2FpdCBDcmVkZW50aWFscy5jaGFuZ2VNZW1iZXJzaGlwKHt0YWcsIGFkZDogW2RldmljZVRhZywgbmV3UmVjb3ZlcnlUYWddLCByZW1vdmU6IFtvbGRSZWNvdmVyeVRhZ119KTtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2hhbmdlTWVtYmVyc2hpcCh7dGFnLCByZW1vdmU6IFtvbGRSZWNvdmVyeVRhZ119KTtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuZGVzdHJveShvbGRSZWNvdmVyeVRhZyk7XG4gIHJldHVybiB0YWc7XG59O1xuXG4vLyBzZXRBbnN3ZXIgbXVzdCBiZSByZS1wcm92aWRlZCB3aGVuZXZlciB3ZSdyZSBhYm91dCB0byBhY2Nlc3MgcmVjb3Zlcnkga2V5LlxuY29uc3QgYW5zd2VycyA9IHt9O1xuQ3JlZGVudGlhbHMuc2V0QW5zd2VyID0gKHByb21wdCwgYW5zd2VyKSA9PiBhbnN3ZXJzW3Byb21wdF0gPSBhbnN3ZXI7XG5DcmVkZW50aWFscy5nZXRVc2VyRGV2aWNlU2VjcmV0ID0gZnVuY3Rpb24gZmxleHN0b3JlU2VjcmV0KHRhZywgcHJvbXB0U3RyaW5nKSB7XG4gIGlmICghcHJvbXB0U3RyaW5nKSByZXR1cm4gdGFnO1xuICBpZiAocHJvbXB0U3RyaW5nID09PSAnLScpIHJldHVybiBwcm9tcHRTdHJpbmc7IC8vIFNlZSBjcmVhdGVBdXRob3IuXG4gIGNvbnN0IGFuc3dlciA9IGFuc3dlcnNbcHJvbXB0U3RyaW5nXTtcbiAgaWYgKGFuc3dlcikgcmV0dXJuIGFuc3dlcjtcbiAgLy8gRGlzdHJpYnV0ZWQgU2VjdXJpdHkgd2lsbCB0cnkgZXZlcnl0aGluZy4gVW5sZXNzIGdvaW5nIHRocm91Z2ggYSBwYXRoIGFib3ZlLCB3ZSB3b3VsZCBsaWtlIG90aGVycyB0byBzaWxlbnRseSBmYWlsLlxuICBjb25zb2xlLmxvZyhgQXR0ZW1wdGluZyBhY2Nlc3MgJHt0YWd9IHdpdGggcHJvbXB0ICcke3Byb21wdFN0cmluZ30nLmApO1xuICByZXR1cm4gXCJub3QgYSBzZWNyZXRcIjsgLy8gdG9kbzogY3J5cHRvIHJhbmRvbVxufTtcblxuXG4vLyBUaGVzZSB0d28gYXJlIHVzZWQgZGlyZWN0bHkgYnkgZGlzdHJpYnV0ZWQtc2VjdXJpdHkuXG5DcmVkZW50aWFscy5TdG9yYWdlLnJldHJpZXZlID0gYXN5bmMgKGNvbGxlY3Rpb25OYW1lLCB0YWcpID0+IHtcbiAgY29uc3QgY29sbGVjdGlvbiA9IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW2NvbGxlY3Rpb25OYW1lXTtcbiAgLy8gTm8gbmVlZCB0byB2ZXJpZnksIGFzIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGRvZXMgdGhhdCBpdHNlbGYgcXVpdGUgY2FyZWZ1bGx5IGFuZCB0ZWFtLWF3YXJlLlxuICBpZiAoY29sbGVjdGlvbk5hbWUgPT09ICdFbmNyeXB0aW9uS2V5JykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTtcbiAgaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnS2V5UmVjb3ZlcnknKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpO1xuICAvL2lmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ1RlYW0nKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpOyAgICAvLyBUaGlzIHdvdWxkIGdvIGNpcmN1bGFyLiBTaG91bGQgaXQ/IERvIHdlIG5lZWQgaXQ/XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBjb2xsZWN0aW9uLmdldCh0YWcpO1xuICAvLyBIb3dldmVyLCBzaW5jZSB3ZSBoYXZlIGJ5cGFzc2VkIENvbGxlY3Rpb24ucmV0cmlldmUsIHdlIG1heWJlSW5mbGF0ZSBoZXJlLlxuICByZXR1cm4gQ29sbGVjdGlvbi5tYXliZUluZmxhdGUoZGF0YSk7XG59XG5jb25zdCBFTVBUWV9TVFJJTkdfSEFTSCA9IFwiNDdERVFwajhIQlNhLV9USW1XLTVKQ2V1UWVSa201Tk1wSldaRzNoU3VGVVwiOyAvLyBIYXNoIG9mIGFuIGVtcHR5IHN0cmluZy5cbkNyZWRlbnRpYWxzLlN0b3JhZ2Uuc3RvcmUgPSBhc3luYyAoY29sbGVjdGlvbk5hbWUsIHRhZywgc2lnbmF0dXJlKSA9PiB7XG4gIC8vIE5vIG5lZWQgdG8gZW5jcnlwdC9zaWduIGFzIGJ5IHN0b3JlLCBzaW5jZSBkaXN0cmlidXRlZC1zZWN1cml0eSBkb2VzIHRoYXQgaW4gYSBjaXJjdWxhcml0eS1hd2FyZSB3YXkuXG4gIC8vIEhvd2V2ZXIsIHdlIGRvIGN1cnJlbnRseSBuZWVkIHRvIGZpbmQgb3V0IG9mIHRoZSBzaWduYXR1cmUgaGFzIGEgcGF5bG9hZCBhbmQgcHVzaFxuICAvLyBUT0RPOiBNb2RpZnkgZGlzdC1zZWMgdG8gaGF2ZSBhIHNlcGFyYXRlIHN0b3JlL2RlbGV0ZSwgcmF0aGVyIHRoYW4gaGF2aW5nIHRvIGZpZ3VyZSB0aGlzIG91dCBoZXJlLlxuICBjb25zdCBjbGFpbXMgPSBDcmVkZW50aWFscy5kZWNvZGVDbGFpbXMoc2lnbmF0dXJlKTtcbiAgY29uc3QgZW1wdHlQYXlsb2FkID0gY2xhaW1zPy5zdWIgPT09IEVNUFRZX1NUUklOR19IQVNIO1xuXG4gIGNvbnN0IGNvbGxlY3Rpb24gPSBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tjb2xsZWN0aW9uTmFtZV07XG4gIHNpZ25hdHVyZSA9IENvbGxlY3Rpb24uZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gIGNvbnN0IHN0b3JlZCA9IGF3YWl0IChlbXB0eVBheWxvYWQgPyBjb2xsZWN0aW9uLmRlbGV0ZSh0YWcsIHNpZ25hdHVyZSkgOiBjb2xsZWN0aW9uLnB1dCh0YWcsIHNpZ25hdHVyZSkpO1xuICBpZiAoc3RvcmVkICE9PSB0YWcpIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIHdyaXRlIGNyZWRlbnRpYWwgJHt0YWd9LmApO1xuICBpZiAodGFnKSBhd2FpdCBjb2xsZWN0aW9uLnB1c2goZW1wdHlQYXlsb2FkID8gJ2RlbGV0ZSc6ICdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gIHJldHVybiB0YWc7XG59O1xuQ3JlZGVudGlhbHMuU3RvcmFnZS5kZXN0cm95ID0gYXN5bmMgKCkgPT4ge1xuICBhd2FpdCBDcmVkZW50aWFscy5jbGVhcigpOyAvLyBXaXBlIGZyb20gbGl2ZSBtZW1vcnkuXG4gIGZvciAobGV0IGNvbGxlY3Rpb24gb2YgT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykpIHtcbiAgICBhd2FpdCBjb2xsZWN0aW9uLmRlc3Ryb3koKTtcbiAgfVxuICBhd2FpdCBDcmVkZW50aWFscy53aXBlRGV2aWNlS2V5cygpOyAvLyBOb3QgaW5jbHVkZWQgaW4gdGhlIGFib3ZlLlxufTtcbkNyZWRlbnRpYWxzLmNvbGxlY3Rpb25zID0ge307XG5leHBvcnQgeyBDcmVkZW50aWFscywgU3RvcmFnZUxvY2FsIH07XG5bJ0VuY3J5cHRpb25LZXknLCAnS2V5UmVjb3ZlcnknLCAnVGVhbSddLmZvckVhY2gobmFtZSA9PiBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tuYW1lXSA9IG5ldyBNdXRhYmxlQ29sbGVjdGlvbih7bmFtZX0pKTtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB1dWlkNCBmcm9tICd1dWlkNCc7XG5pbXBvcnQgU3luY2hyb25pemVyIGZyb20gJy4vbGliL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIFN0YXRlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgU3RvcmFnZUxvY2FsIH0gZnJvbSAgJy4vbGliL2NvbGxlY3Rpb25zLm1qcyc7XG5pbXBvcnQgeyBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vbGliL3dlYnJ0Yy5tanMnO1xuaW1wb3J0IHsgdmVyc2lvbiwgbmFtZSwgc3RvcmFnZVZlcnNpb24sIHN0b3JhZ2VOYW1lIH0gZnJvbSAnLi9saWIvdmVyc2lvbi5tanMnO1xuXG5jb25zb2xlLmxvZyhgJHtuYW1lfSAke3ZlcnNpb259IGZyb20gJHtpbXBvcnQubWV0YS51cmx9LmApO1xuXG5leHBvcnQgeyBDcmVkZW50aWFscywgQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIFN0YXRlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgU3luY2hyb25pemVyLCBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQywgbmFtZSwgdmVyc2lvbiwgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBTdG9yYWdlTG9jYWwsIHV1aWQ0IH07XG5leHBvcnQgZGVmYXVsdCB7IENyZWRlbnRpYWxzLCBDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgU3RhdGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBTeW5jaHJvbml6ZXIsIFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDLCBuYW1lLCB2ZXJzaW9uLCAgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBTdG9yYWdlTG9jYWwsIHV1aWQ0IH07XG4iXSwibmFtZXMiOlsicGtnLmRlZmF1bHQiLCJTdG9yYWdlTG9jYWwiXSwibWFwcGluZ3MiOiI7OztBQUFBLE1BQU0sV0FBVyxHQUFHLHdFQUF3RTtBQUM1RixTQUFTLEtBQUssQ0FBQyxJQUFJLEVBQUU7QUFDckIsRUFBRSxPQUFPLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0FBQy9COztBQUVBO0FBQ0E7QUFDQSxTQUFTLEtBQUssR0FBRztBQUNqQixFQUFFLElBQUksUUFBUSxHQUFHLEdBQUcsQ0FBQyxlQUFlLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQztBQUNoRCxFQUFFLElBQUksSUFBSSxHQUFHLFFBQVEsQ0FBQyxRQUFRLEVBQUU7QUFDaEMsRUFBRSxHQUFHLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQztBQUMvQixFQUFFLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztBQUNsRDtBQUNBLEtBQUssQ0FBQyxLQUFLLEdBQUcsS0FBSzs7QUNibkI7QUFDQSxXQUFlLFVBQVU7O0FDR3pCOztBQUVBLE1BQU0sVUFBVSxHQUFHO0FBQ25CLEVBQUUsRUFBRSxJQUFJLEVBQUUsOEJBQThCLENBQUM7QUFDekM7QUFDQSxFQUFFLEVBQUUsSUFBSSxFQUFFLHdCQUF3QixFQUFFO0FBQ3BDO0FBQ0E7QUFDQTtBQUNBLEVBQUUsRUFBRSxJQUFJLEVBQUUsc0NBQXNDLEVBQUUsUUFBUSxFQUFFLGtJQUFrSSxFQUFFLFVBQVUsRUFBRSxrRUFBa0U7QUFDOVE7QUFDQTtBQUNBO0FBQ0EsQ0FBQzs7QUFFRDtBQUNBO0FBQ08sTUFBTSxNQUFNLENBQUM7QUFDcEIsRUFBRSxXQUFXLENBQUMsQ0FBQyxLQUFLLEdBQUcsRUFBRSxFQUFFLGFBQWEsR0FBRyxJQUFJLEVBQUUsSUFBSSxHQUFHLEtBQUssRUFBRSxFQUFFLEtBQUssR0FBRyxLQUFLLEVBQUUsS0FBSyxHQUFHLE9BQU8sQ0FBQyxLQUFLLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLEVBQUU7QUFDdEgsSUFBSSxhQUFhLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUNuQyxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsS0FBSyxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0FBQzVFLElBQUksSUFBSSxDQUFDLFNBQVMsRUFBRTtBQUNwQjtBQUNBLEVBQUUsTUFBTSxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7QUFDeEIsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sQ0FBQztBQUMxRTs7QUFFQSxFQUFFLFdBQVcsR0FBRyxDQUFDO0FBQ2pCLEVBQUUsU0FBUyxHQUFHO0FBQ2QsSUFBSSxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsSUFBSTtBQUN6QixJQUFJLElBQUksR0FBRyxFQUFFO0FBQ2IsTUFBTSxHQUFHLENBQUMsbUJBQW1CLEdBQUcsR0FBRyxDQUFDLGNBQWMsR0FBRyxHQUFHLENBQUMsbUJBQW1CLEdBQUcsR0FBRyxDQUFDLHVCQUF1QixHQUFHLElBQUk7QUFDakg7QUFDQSxNQUFNLElBQUksR0FBRyxDQUFDLGVBQWUsS0FBSyxLQUFLLEVBQUUsR0FBRyxDQUFDLEtBQUssRUFBRTtBQUNwRDtBQUNBLElBQUksTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDO0FBQzNFLElBQUksSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsV0FBVyxFQUFFO0FBQ3ZDLElBQUksSUFBSSxDQUFDLG1CQUFtQixHQUFHLEtBQUssSUFBSSxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDO0FBQ3JFLElBQUksSUFBSSxDQUFDLGNBQWMsR0FBRyxLQUFLLElBQUksSUFBSSxDQUFDLG1CQUFtQixDQUFDLEtBQUssQ0FBQztBQUNsRTtBQUNBLElBQUksSUFBSSxDQUFDLG1CQUFtQixHQUFHLEtBQUssSUFBSSxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDO0FBQ3JFO0FBQ0EsSUFBSSxJQUFJLENBQUMseUJBQXlCLEdBQUcsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLGlCQUFpQixLQUFLLFVBQVUsS0FBSyxJQUFJLENBQUMsYUFBYTtBQUMzRyxJQUFJLElBQUksQ0FBQyx1QkFBdUIsR0FBRyxLQUFLLElBQUksSUFBSSxDQUFDLHFCQUFxQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDO0FBQ2pHO0FBQ0EsRUFBRSxtQkFBbUIsQ0FBQyxLQUFLLEVBQUU7QUFDN0I7QUFDQSxJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLGFBQWEsRUFBRTtBQUM1RSxTQUFTLElBQUksQ0FBQyxNQUFNLENBQUMsY0FBYyxFQUFFLEtBQUssQ0FBQyxTQUFTLENBQUM7QUFDckQ7QUFDQSxFQUFFLGFBQWEsR0FBRztBQUNsQjtBQUNBO0FBQ0EsRUFBRSxLQUFLLEdBQUc7QUFDVixJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsS0FBSyxLQUFLLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjLEtBQUssUUFBUSxDQUFDLEVBQUU7QUFDMUYsSUFBSSxJQUFJLENBQUMsU0FBUyxFQUFFO0FBQ3BCO0FBQ0EsRUFBRSxxQkFBcUIsQ0FBQyxLQUFLLEVBQUU7QUFDL0IsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLGVBQWUsRUFBRSxLQUFLLENBQUM7QUFDcEMsSUFBSSxJQUFJLENBQUMsY0FBYyxFQUFFLFFBQVEsRUFBRSxRQUFRLENBQUMsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQzNFO0FBQ0EsRUFBRSxpQkFBaUIsR0FBRztBQUN0QixJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsb0JBQW9CLENBQUM7QUFDbEMsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVc7QUFDekIsT0FBTyxJQUFJLENBQUMsS0FBSyxJQUFJO0FBQ3JCLFFBQVEsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUM3QyxDQUFDLE9BQU8sS0FBSztBQUNiLE9BQU87QUFDUCxPQUFPLElBQUksQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDO0FBQ2hELE9BQU8sS0FBSyxDQUFDLEtBQUssSUFBSSxJQUFJLENBQUMsc0JBQXNCLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDekQ7QUFDQSxFQUFFLEtBQUssQ0FBQyxLQUFLLEVBQUU7QUFDZjtBQUNBO0FBQ0EsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLG9CQUFvQixDQUFDLEtBQUs7QUFDeEMsT0FBTyxJQUFJLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxFQUFFO0FBQ3pDLE9BQU8sSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzVELE9BQU8sSUFBSSxDQUFDLENBQUMsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUM7QUFDbkU7QUFDQSxFQUFFLE1BQU0sQ0FBQyxNQUFNLEVBQUU7QUFDakIsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLG9CQUFvQixDQUFDLE1BQU0sQ0FBQztBQUMxQztBQUNBLEVBQUUsWUFBWSxDQUFDLFlBQVksRUFBRTtBQUM3QixJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFlBQVksQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLGlCQUFpQixDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3pGO0FBQ0EsRUFBRSxHQUFHLENBQUMsR0FBRyxJQUFJLEVBQUU7QUFDZixJQUFJLElBQUksSUFBSSxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFDekU7QUFDQSxFQUFFLFFBQVEsQ0FBQyxLQUFLLEVBQUUsZ0JBQWdCLEVBQUU7QUFDcEMsSUFBSSxNQUFNLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLGVBQWUsQ0FBQyxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztBQUNoSCxJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDO0FBQ3BCLElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQSxFQUFFLE9BQU8sS0FBSyxDQUFDLEtBQUssRUFBRTtBQUN0QjtBQUNBLEVBQUUsT0FBTyxlQUFlLENBQUMsS0FBSyxFQUFFLGdCQUFnQixFQUFFO0FBQ2xELElBQUksT0FBTztBQUNYLE1BQU0sS0FBSyxHQUFHLFNBQVM7QUFDdkIsTUFBTSxnQkFBZ0IsQ0FBQyxJQUFJLElBQUksZ0JBQWdCLENBQUMsU0FBUyxJQUFJLGdCQUFnQixDQUFDLE1BQU0sSUFBSSxFQUFFO0FBQzFGLE1BQU0sZ0JBQWdCLENBQUMsR0FBRyxJQUFJLGdCQUFnQixDQUFDLElBQUksSUFBSSxFQUFFO0FBQ3pELE1BQU0sZ0JBQWdCLENBQUMsT0FBTyxJQUFJLGdCQUFnQixDQUFDLFNBQVMsSUFBSSxnQkFBZ0IsQ0FBQyxVQUFVLElBQUk7QUFDL0YsS0FBSztBQUNMO0FBQ0EsRUFBRSxpQkFBaUIsQ0FBQyxnQkFBZ0IsRUFBRTtBQUN0Qzs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUksTUFBTSxJQUFJLEdBQUcsZ0JBQWdCLENBQUMsSUFBSSxJQUFJLGdCQUFnQixDQUFDLFNBQVMsSUFBSSxnQkFBZ0IsQ0FBQyxNQUFNO0FBQy9GO0FBQ0E7QUFDQSxJQUFJLElBQUksSUFBSSxLQUFLLEdBQUcsRUFBRTtBQUN0QixJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxFQUFFLGdCQUFnQixDQUFDO0FBQzFDO0FBQ0E7O0FBRU8sTUFBTSxhQUFhLFNBQVMsTUFBTSxDQUFDO0FBQzFDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEVBQUUsV0FBVyxDQUFDLENBQUMsVUFBVSxHQUFHLEdBQUcsRUFBRSxHQUFHLFVBQVUsQ0FBQyxFQUFFO0FBQ2pELElBQUksS0FBSyxDQUFDLFVBQVUsQ0FBQztBQUNyQixJQUFJLElBQUksQ0FBQyxVQUFVLEdBQUcsVUFBVTtBQUNoQztBQUNBLEVBQUUsSUFBSSxPQUFPLEdBQUc7QUFDaEIsSUFBSSxPQUFPLElBQUksQ0FBQyxjQUFjLEtBQUssSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxLQUFLLElBQUksQ0FBQyxZQUFZLEdBQUcsQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDLENBQUM7QUFDMUc7QUFDQSxFQUFFLElBQUksT0FBTyxDQUFDLElBQUksRUFBRTtBQUNwQixJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDMUQ7QUFDQSxFQUFFLG1CQUFtQixDQUFDLEtBQUssRUFBRTtBQUM3QjtBQUNBO0FBQ0E7QUFDQSxJQUFJLElBQUksQ0FBQyxLQUFLLEtBQUssVUFBVSxDQUFDLE1BQU0sSUFBSSxDQUFDLGFBQWEsRUFBRSxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUM7QUFDMUUsSUFBSSxLQUFLLENBQUMsbUJBQW1CLENBQUMsS0FBSyxDQUFDO0FBQ3BDO0FBQ0EsRUFBRSxhQUFhLEdBQUc7QUFDbEIsSUFBSSxZQUFZLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztBQUM1QixJQUFJLElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSTtBQUNyQjtBQUNBLEVBQUUsTUFBTSxhQUFhLEdBQUc7QUFDeEIsSUFBSSxJQUFJLENBQUMsYUFBYSxFQUFFO0FBQ3hCLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUU7QUFDOUI7QUFDQSxNQUFNO0FBQ047QUFDQSxJQUFJLElBQUksQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7QUFDM0MsSUFBSSxJQUFJLENBQUMsT0FBTyxHQUFHLEVBQUU7QUFDckI7QUFDQSxFQUFFLE9BQU8sR0FBRyxFQUFFO0FBQ2QsRUFBRSxNQUFNLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUN4QixJQUFJLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQztBQUMvQixJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQ3RDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEVBQUUsWUFBWSxHQUFHLElBQUksR0FBRyxFQUFFO0FBQzFCLEVBQUUsY0FBYyxHQUFHO0FBQ25CLElBQUksTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQzNELElBQUksTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ3RELElBQUksT0FBTyxDQUFDLEVBQUUsSUFBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUN2RDtBQUNBLEVBQUUsV0FBVyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFO0FBQ3hDO0FBQ0E7QUFDQSxJQUFJLE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUM7QUFDOUIsSUFBSSxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFDL0MsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLGtCQUFrQixFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsT0FBTyxDQUFDLFVBQVUsRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLFVBQVUsRUFBRSxPQUFPLENBQUM7QUFDN0csSUFBSSxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDO0FBQ3ZDLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxLQUFLLElBQUk7QUFDL0MsTUFBTSxJQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUM7QUFDbkM7QUFDQSxNQUFNLElBQUksSUFBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUU7QUFDbEMsTUFBTSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsTUFBTSxFQUFFO0FBQ3pDLE1BQU0sSUFBSSxDQUFDLEtBQUssRUFBRTtBQUNsQixLQUFLLENBQUM7QUFDTixJQUFJLE9BQU8sT0FBTztBQUNsQjtBQUNBLEVBQUUsaUJBQWlCLENBQUMsS0FBSyxHQUFHLE1BQU0sRUFBRSxjQUFjLEdBQUcsRUFBRSxFQUFFO0FBQ3pELElBQUksT0FBTyxJQUFJLE9BQU8sQ0FBQyxPQUFPLElBQUk7QUFDbEMsTUFBTSxJQUFJLENBQUMsR0FBRyxDQUFDLHFCQUFxQixFQUFFLEtBQUssRUFBRSxjQUFjLENBQUM7QUFDNUQsTUFBTSxJQUFJLE9BQU8sR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLEtBQUssRUFBRSxjQUFjLENBQUM7QUFDdEUsTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLE9BQU8sRUFBRSxVQUFVLENBQUMsQ0FBQztBQUM1QztBQUNBO0FBQ0EsTUFBTSxRQUFRLE9BQU8sQ0FBQyxVQUFVO0FBQ2hDLE1BQU0sS0FBSyxNQUFNO0FBQ2pCLENBQUMsVUFBVSxDQUFDLE1BQU0sT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLEVBQUUsQ0FBQztBQUN2QyxDQUFDO0FBQ0QsTUFBTSxLQUFLLFlBQVk7QUFDdkIsQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDO0FBQ3ZDLENBQUM7QUFDRCxNQUFNO0FBQ04sQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsc0JBQXNCLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxrQkFBa0IsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUY7QUFDQSxLQUFLLENBQUM7QUFDTjtBQUNBLEVBQUUsZUFBZSxHQUFHLEVBQUU7QUFDdEIsRUFBRSxxQkFBcUIsQ0FBQyxLQUFLLEdBQUcsTUFBTSxFQUFFO0FBQ3hDLElBQUksT0FBTyxJQUFJLE9BQU8sQ0FBQyxPQUFPLElBQUk7QUFDbEMsTUFBTSxJQUFJLENBQUMsR0FBRyxDQUFDLHNCQUFzQixFQUFFLEtBQUssQ0FBQztBQUM3QyxNQUFNLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxDQUFDLEdBQUcsT0FBTztBQUMzQyxLQUFLLENBQUM7QUFDTjtBQUNBLEVBQUUsU0FBUyxHQUFHO0FBQ2QsSUFBSSxLQUFLLENBQUMsU0FBUyxFQUFFO0FBQ3JCLElBQUksSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxPQUFPLElBQUk7QUFDNUMsTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLHVCQUF1QixFQUFFLEtBQUssSUFBSTtBQUNuRSxDQUFDLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxlQUFlLEtBQUssV0FBVyxFQUFFO0FBQ2hELEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQztBQUNoQjtBQUNBLE9BQU8sQ0FBQztBQUNSLEtBQUssQ0FBQztBQUNOLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxhQUFhLEVBQUUsS0FBSyxJQUFJO0FBQ3ZELE1BQU0sTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLE9BQU87QUFDbkMsTUFBTSxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSztBQUNqQyxNQUFNLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxDQUFDO0FBQ2pELE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDOUQsTUFBTSxJQUFJLENBQUMsT0FBTyxFQUFFLE9BQU87QUFDM0IsTUFBTSxPQUFPLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxDQUFDO0FBQ3hDLE1BQU0sT0FBTyxDQUFDLE9BQU8sQ0FBQztBQUN0QixLQUFLLENBQUM7QUFDTjtBQUNBLEVBQUUsS0FBSyxHQUFHO0FBQ1YsSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxLQUFLLFFBQVEsRUFBRSxJQUFJLENBQUMsY0FBYyxFQUFFLE1BQU0sSUFBSTtBQUMvRSxJQUFJLEtBQUssQ0FBQyxLQUFLLEVBQUU7QUFDakIsSUFBSSxJQUFJLENBQUMsYUFBYSxFQUFFO0FBQ3hCLElBQUksSUFBSSxDQUFDLGNBQWMsR0FBRyxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUk7QUFDbEQsSUFBSSxJQUFJLENBQUMsT0FBTyxHQUFHLEVBQUU7QUFDckI7QUFDQTtBQUNBLElBQUksS0FBSyxNQUFNLE9BQU8sSUFBSSxJQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sRUFBRSxFQUFFO0FBQ3RELE1BQU0sSUFBSSxPQUFPLENBQUMsVUFBVSxLQUFLLE1BQU0sRUFBRSxTQUFTO0FBQ2xEO0FBQ0E7QUFDQTtBQUNBLE1BQU0sT0FBTyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUMvQztBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBTSxlQUFlLEdBQUcsR0FBRztBQUNwQixNQUFNLFlBQVksU0FBUyxhQUFhLENBQUM7QUFDaEQsRUFBRSxPQUFPLFdBQVcsR0FBRyxJQUFJLEdBQUcsRUFBRTtBQUNoQyxFQUFFLE9BQU8sTUFBTSxDQUFDLENBQUMsWUFBWSxFQUFFLFNBQVMsR0FBRyxJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUMsRUFBRTtBQUMzRCxJQUFJLElBQUksVUFBVSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQztBQUN2RDtBQUNBLElBQUksSUFBSSxVQUFVLEVBQUU7QUFDcEIsTUFBTSxNQUFNLENBQUMsZUFBZSxFQUFFLGNBQWMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxJQUFJO0FBQy9ELE1BQU0sSUFBSSxDQUFDLGVBQWUsS0FBSyxRQUFRLE1BQU0sY0FBYyxLQUFLLFFBQVEsQ0FBQyxFQUFFLFVBQVUsR0FBRyxJQUFJO0FBQzVGO0FBQ0EsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFO0FBQ3JCLE1BQU0sVUFBVSxHQUFHLElBQUksSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLFlBQVksRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsU0FBUyxFQUFFLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDckYsTUFBTSxJQUFJLFNBQVMsRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxZQUFZLEVBQUUsVUFBVSxDQUFDO0FBQ25FO0FBQ0EsSUFBSSxPQUFPLFVBQVU7QUFDckI7QUFDQSxFQUFFLFNBQVMsR0FBRyxlQUFlO0FBQzdCLEVBQUUsSUFBSSxvQkFBb0IsR0FBRztBQUM3QixJQUFJLE9BQU8sSUFBSSxDQUFDLFNBQVMsR0FBRyxlQUFlO0FBQzNDO0FBQ0EsRUFBRSxLQUFLLENBQUMsZ0JBQWdCLEdBQUcsSUFBSSxFQUFFO0FBQ2pDLElBQUksSUFBSSxDQUFDLFNBQVMsR0FBRyxlQUFlO0FBQ3BDLElBQUksS0FBSyxDQUFDLEtBQUssRUFBRTtBQUNqQixJQUFJLElBQUksZ0JBQWdCLEVBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUM7QUFDaEY7QUFDQSxFQUFFLE1BQU0saUJBQWlCLENBQUMsV0FBVyxFQUFFLGNBQWMsR0FBRyxFQUFFLEVBQUUsT0FBTyxHQUFHLElBQUksRUFBRTtBQUM1RSxJQUFJLE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxDQUFDLG9CQUFvQixDQUFDO0FBQzNELElBQUksTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO0FBQ2hDLElBQUksTUFBTSxVQUFVLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxLQUFLLFlBQVksS0FBSyxvQkFBb0I7QUFDaEYsSUFBSSxNQUFNLHNCQUFzQixHQUFHLENBQUMsb0JBQW9CLG9CQUFvQixDQUFDLENBQUMsT0FBTyxDQUFDO0FBQ3RGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBSSxNQUFNLFVBQVUsR0FBRyxDQUFDLG9CQUFvQixJQUFJLE9BQU8sRUFBRSxNQUFNO0FBQy9ELElBQUksTUFBTSxPQUFPLEdBQUcsVUFBVSxHQUFHLENBQUMsRUFBRSxFQUFFLFVBQVUsRUFBRSxHQUFHLGNBQWMsQ0FBQyxHQUFHLGNBQWM7QUFDckYsSUFBSSxJQUFJLG9CQUFvQixFQUFFO0FBQzlCLE1BQU0sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDO0FBQzNCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFNLE1BQU0sSUFBSSxPQUFPLENBQUMsT0FBTyxJQUFJLFVBQVUsQ0FBQyxPQUFPLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDNUQsS0FBSyxNQUFNLElBQUksVUFBVSxFQUFFO0FBQzNCLE1BQU0sSUFBSSxDQUFDLE9BQU8sR0FBRyxPQUFPO0FBQzVCO0FBQ0EsSUFBSSxNQUFNLE9BQU8sR0FBRyxzQkFBc0I7QUFDMUMsR0FBRyxJQUFJLENBQUMscUJBQXFCLENBQUMsV0FBVyxDQUFDO0FBQzFDLEdBQUcsSUFBSSxDQUFDLGlCQUFpQixDQUFDLFdBQVcsRUFBRSxPQUFPLENBQUM7QUFDL0MsSUFBSSxPQUFPLE1BQU0sT0FBTztBQUN4QjtBQUNBOzs7Ozs7OztBQ2pVQTtBQUNZLE1BQUMsV0FBVyxHQUFHO0FBQ2YsTUFBQyxjQUFjLEdBQUc7QUFHbEIsTUFBQyxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsR0FBR0E7O0FDQS9CO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBOztBQUVBOztBQUVBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNPLE1BQU0sWUFBWSxDQUFDO0FBQzFCLEVBQUUsT0FBTyxPQUFPLEdBQUcsY0FBYztBQUNqQyxFQUFFLFdBQVcsQ0FBQyxDQUFDLFdBQVcsR0FBRyxRQUFRLEVBQUUsVUFBVSxFQUFFLEtBQUssR0FBRyxVQUFVLEVBQUUsV0FBVyxDQUFDLEtBQUssSUFBSSxPQUFPLENBQUMsS0FBSztBQUN6RyxRQUFRLFlBQVksR0FBRyxVQUFVLEVBQUUsWUFBWSxJQUFJLFdBQVc7QUFDOUQsUUFBUSxXQUFXLEVBQUUsSUFBSSxHQUFHLFVBQVUsRUFBRSxJQUFJLEVBQUUsZ0JBQWdCLEVBQUUsVUFBVTtBQUMxRSxRQUFRLFNBQVMsR0FBRyxVQUFVLEVBQUUsU0FBUztBQUN6QyxRQUFRLEtBQUssR0FBRyxVQUFVLEVBQUUsS0FBSyxFQUFFLFVBQVUsR0FBRyxZQUFZLENBQUMsT0FBTyxFQUFFLFVBQVUsR0FBRyxVQUFVLENBQUMsRUFBRTtBQUNoRztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJLE1BQU0sc0JBQXNCLEdBQUcsV0FBVyxDQUFDLFVBQVUsR0FBRyxNQUFNLENBQUM7QUFDbkUsSUFBSSxJQUFJLENBQUMsc0JBQXNCLEtBQUssZ0JBQWdCLEtBQUssU0FBUyxDQUFDLEVBQUUsZ0JBQWdCLEdBQUcsRUFBRSxDQUFDO0FBQzNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBSSxTQUFTLEtBQUssVUFBVSxFQUFFLFNBQVMsQ0FBQztBQUN4QyxJQUFJLFNBQVMsTUFBTSxXQUFXLENBQUMsUUFBUSxHQUFHLE9BQU8sQ0FBQyxJQUFJLFlBQVksQ0FBQztBQUNuRSxJQUFJLFVBQVUsS0FBSyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsWUFBWSxFQUFFLGFBQWEsRUFBRSxnQkFBZ0IsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQzs7QUFFdEgsSUFBSSxJQUFJLEtBQUssVUFBVSxDQUFDLElBQUk7QUFDNUI7QUFDQSxJQUFJLFdBQVcsS0FBSyxVQUFVLEVBQUUsV0FBVyxJQUFJLFVBQVUsQ0FBQyxRQUFRO0FBQ2xFLElBQUksTUFBTSxLQUFLLEdBQUcsQ0FBQyxFQUFFLFVBQVUsRUFBRSxTQUFTLElBQUksV0FBVyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztBQUNuRTtBQUNBLElBQUksTUFBTSxhQUFhLEdBQUcsV0FBVyxDQUFDLFFBQVEsR0FBRyxVQUFVLENBQUMsR0FBRyxXQUFXLEdBQUcsQ0FBQyxFQUFFLFdBQVcsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUM7O0FBRXRHLElBQUksTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLGdCQUFnQjtBQUNySCxJQUFJLFVBQVUsRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFLGFBQWE7QUFDaEQsSUFBSSxtQkFBbUIsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFO0FBQ25DLElBQUksTUFBTSxFQUFFLElBQUksQ0FBQyxzQkFBc0IsRUFBRTtBQUN6QztBQUNBLElBQUksZUFBZSxFQUFFLHNCQUFzQixJQUFJLENBQUMsRUFBRSxXQUFXLENBQUMsT0FBTyxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxFQUFFLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRyxJQUFJLFVBQVUsRUFBRSxhQUFhLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsQ0FBQztBQUNyRDtBQUNBLEVBQUUsYUFBYSxNQUFNLENBQUMsVUFBVSxFQUFFLFdBQVcsRUFBRSxPQUFPLEdBQUcsRUFBRSxFQUFFO0FBQzdELElBQUksTUFBTSxZQUFZLEdBQUcsSUFBSSxJQUFJLENBQUMsQ0FBQyxVQUFVLEVBQUUsV0FBVyxFQUFFLEdBQUcsT0FBTyxDQUFDLENBQUM7QUFDeEUsSUFBSSxNQUFNLGdCQUFnQixHQUFHLFlBQVksQ0FBQyxjQUFjLEVBQUUsQ0FBQztBQUMzRCxJQUFJLE1BQU0sU0FBUyxHQUFHLE1BQU0sZ0JBQWdCO0FBQzVDLElBQUksSUFBSSxDQUFDLFNBQVMsRUFBRSxPQUFPLFlBQVk7QUFDdkMsSUFBSSxPQUFPLE1BQU0sU0FBUyxDQUFDLFdBQVcsRUFBRTtBQUN4QztBQUNBLEVBQUUsTUFBTSxjQUFjLEdBQUc7QUFDekIsSUFBSSxNQUFNLENBQUMsZUFBZSxFQUFFLElBQUksRUFBRSxVQUFVLEVBQUUsV0FBVyxDQUFDLEdBQUcsSUFBSTtBQUNqRSxJQUFJLElBQUksT0FBTyxHQUFHLFVBQVUsQ0FBQyxvQkFBb0I7QUFDakQsSUFBSSxJQUFJLE9BQU8sRUFBRTtBQUNqQjtBQUNBLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxVQUFVLENBQUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQztBQUN4RixLQUFLLE1BQU0sSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRTtBQUNyRCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsYUFBYSxFQUFFO0FBQ3BDLEtBQUssTUFBTSxJQUFJLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLGdCQUFnQixDQUFDLEVBQUU7QUFDOUQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO0FBQ3JDLEtBQUssTUFBTSxJQUFJLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxFQUFFO0FBQzdEO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBTSxNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsZUFBZSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3ZELE1BQU0sTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLGFBQWE7QUFDcEMsTUFBTSxNQUFNLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDO0FBQ3pDLE1BQWlCLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLLEVBQUU7QUFDaEQsTUFBTSxNQUFNLE1BQU0sR0FBRyxNQUFNLGVBQWU7QUFDMUMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDLENBQUM7QUFDeEMsS0FBSyxNQUFNLElBQUksV0FBVyxLQUFLLFNBQVMsRUFBRTtBQUMxQyxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsZUFBZSxFQUFFO0FBQ3RDLE1BQU0sT0FBTyxJQUFJO0FBQ2pCLEtBQUssTUFBTSxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLEVBQUU7QUFDM0MsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxXQUFXLENBQUM7QUFDakQsS0FBSyxNQUFNLElBQUksV0FBVyxDQUFDLGFBQWEsRUFBRTtBQUMxQyxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsb0JBQW9CLENBQUMsV0FBVyxDQUFDLENBQUM7QUFDdkQsS0FBSyxNQUFNO0FBQ1gsTUFBTSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsNkJBQTZCLEVBQUUsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3JFO0FBQ0EsSUFBSSxJQUFJLEVBQUUsTUFBTSxPQUFPLENBQUMsRUFBRTtBQUMxQixNQUFNLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxtQkFBbUIsQ0FBQztBQUNuRCxNQUFNLE9BQU8sSUFBSTtBQUNqQjtBQUNBLElBQUksT0FBTyxJQUFJO0FBQ2Y7O0FBRUEsRUFBRSxHQUFHLENBQUMsR0FBRyxJQUFJLEVBQUU7QUFDZixJQUFJLElBQUksSUFBSSxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFDcEQ7QUFDQSxFQUFFLElBQUksa0JBQWtCLEdBQUc7QUFDM0IsSUFBSSxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsbUJBQW1CO0FBQzVDLElBQUksSUFBSSxDQUFDLE9BQU8sRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLG1DQUFtQyxDQUFDLENBQUM7QUFDckYsSUFBSSxPQUFPLE9BQU87QUFDbEI7QUFDQSxFQUFFLG9CQUFvQixHQUFHO0FBQ3pCLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxhQUFhLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUM7QUFDM0QsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUM5QjtBQUNBLEVBQUUsSUFBSSxrQkFBa0IsQ0FBQyxPQUFPLEVBQUU7QUFDbEMsSUFBSSxJQUFJLENBQUMsbUJBQW1CLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxXQUFXLElBQUk7QUFDM0QsTUFBTSxXQUFXLENBQUMsU0FBUyxHQUFHLEtBQUssSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUM7QUFDL0QsTUFBTSxXQUFXLENBQUMsT0FBTyxHQUFHLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxvQkFBb0IsRUFBRTtBQUN0RSxNQUFNLE9BQU8sV0FBVztBQUN4QixLQUFLLENBQUM7QUFDTjtBQUNBLEVBQUUsTUFBTSxXQUFXLEdBQUc7QUFDdEIsSUFBSSxNQUFNLElBQUksQ0FBQyxrQkFBa0I7QUFDakMsSUFBSSxNQUFNLElBQUksQ0FBQyxzQkFBc0I7QUFDckMsSUFBSSxPQUFPLElBQUk7QUFDZjtBQUNBLEVBQUUsT0FBTyxVQUFVLEdBQUcsQ0FBQztBQUN2QixFQUFFLE1BQU0sSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLE1BQU0sRUFBRTtBQUNoQyxJQUFJLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUM7QUFDcEQsSUFBSSxNQUFNLFdBQVcsR0FBRyxNQUFNLElBQUksQ0FBQyxrQkFBa0I7QUFDckQsSUFBSSxNQUFNLEtBQUssR0FBRyxXQUFXLEVBQUUsVUFBVSxJQUFJLFFBQVE7QUFDckQsSUFBSSxJQUFJLEtBQUssS0FBSyxRQUFRLElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRTtBQUNuRCxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxHQUFHLE1BQU0sQ0FBQztBQUN4QyxJQUFJLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQztBQUN0QixJQUFJLElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxJQUFJLEVBQUU7QUFDL0IsTUFBTSxXQUFXLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQztBQUMvQixNQUFNO0FBQ047QUFDQTtBQUNBO0FBQ0EsSUFBSSxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO0FBQ3RELElBQUksTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxVQUFVLEVBQUU7QUFDNUMsSUFBSSxNQUFNLElBQUksR0FBRyxDQUFDLE1BQU0sRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0FBQy9EO0FBQ0EsSUFBSSxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDMUM7QUFDQSxJQUFJLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLFNBQVMsRUFBRSxFQUFFLENBQUMsRUFBRSxDQUFDLElBQUksSUFBSSxFQUFFO0FBQzFELE1BQU0sTUFBTSxJQUFJLEdBQUcsQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUM3RSxNQUFNLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUM1QztBQUNBO0FBQ0EsRUFBRSxPQUFPLENBQUMsSUFBSSxFQUFFO0FBQ2hCLElBQUksTUFBTSxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQztBQUM3QyxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQztBQUMzQjtBQUNBLEVBQUUsZ0JBQWdCLEdBQUcsRUFBRTtBQUN2QixFQUFFLFNBQVMsQ0FBQyxFQUFFLEVBQUUsU0FBUyxFQUFFO0FBQzNCO0FBQ0EsSUFBSSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDakY7QUFDQSxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUsQ0FBQyxFQUFFLFFBQVEsRUFBRTtBQUN4QixJQUFJLElBQUksSUFBSSxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsUUFBUTtBQUM5QixJQUFJLElBQUksQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRTtBQUNoQztBQUNBLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN2QyxJQUFJLE9BQU8sSUFBSSxDQUFDLGdCQUFnQixDQUFDLEVBQUUsQ0FBQztBQUNwQzs7QUFFQSxFQUFFLE1BQU0sVUFBVSxHQUFHO0FBQ3JCO0FBQ0EsSUFBSSxJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLGVBQWUsS0FBSyxXQUFXLEVBQUUsT0FBTyxJQUFJLENBQUMsb0JBQW9CLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztBQUN2SCxJQUFJLE1BQU0sV0FBVyxHQUFHLE1BQU0sSUFBSSxDQUFDLGtCQUFrQjtBQUNyRCxJQUFJLFdBQVcsQ0FBQyxLQUFLLEVBQUU7QUFDdkIsSUFBSSxPQUFPLElBQUksQ0FBQyxNQUFNO0FBQ3RCO0FBQ0E7QUFDQTtBQUNBLEVBQUUsZUFBZSxDQUFDLGNBQWMsRUFBRTtBQUNsQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUksTUFBTSxDQUFDLFVBQVUsQ0FBQyxHQUFHLElBQUk7QUFDN0IsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLGNBQWMsR0FBRyxtQkFBbUIsR0FBRyxrQkFBa0IsQ0FBQztBQUN2RSxJQUFJLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxVQUFVLENBQUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxFQUFFLEVBQUUsY0FBYyxDQUFDO0FBQ2hHLElBQUksT0FBTyxVQUFVLENBQUMsT0FBTztBQUM3QjtBQUNBLEVBQUUsa0JBQWtCLENBQUMsY0FBYyxFQUFFO0FBQ3JDO0FBQ0EsSUFBSSxJQUFJLENBQUMsY0FBYyxFQUFFLE9BQU8sS0FBSztBQUNyQyxJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsT0FBTyxHQUFHLGNBQWM7QUFDNUMsSUFBSSxPQUFPLElBQUk7QUFDZjs7QUFFQSxFQUFFLE9BQU8sU0FBUyxDQUFDLEdBQUcsRUFBRSxJQUFJLEdBQUcsU0FBUyxFQUFFLE1BQU0sR0FBRyxJQUFJLEVBQUU7QUFDekQsSUFBSSxNQUFNLE9BQU8sR0FBRyxJQUFJLEtBQUssU0FBUztBQUN0QyxJQUFJLE1BQU0sS0FBSyxPQUFPLEdBQUcsTUFBTSxHQUFHLEtBQUs7QUFDdkMsSUFBSSxPQUFPLEtBQUssQ0FBQyxHQUFHLEVBQUUsT0FBTyxHQUFHLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxDQUFDLGNBQWMsRUFBRSxrQkFBa0IsQ0FBQyxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUM7QUFDOUgsT0FBTyxJQUFJLENBQUMsUUFBUSxJQUFJO0FBQ3hCLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxDQUFDLEVBQUUsUUFBUSxDQUFDLFVBQVUsSUFBSSxjQUFjLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNsSCxDQUFDLE9BQU8sUUFBUSxDQUFDLElBQUksRUFBRTtBQUN2QixPQUFPLENBQUM7QUFDUjtBQUNBLEVBQUUsTUFBTSxLQUFLLENBQUMsR0FBRyxFQUFFLElBQUksR0FBRyxTQUFTLEVBQUU7O0FBRXJDLElBQUksTUFBTSxNQUFNLEdBQUcsSUFBSSxHQUFHLE1BQU0sR0FBRyxLQUFLO0FBQ3hDLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxVQUFVLEVBQUUsSUFBSSxDQUFDO0FBQ3BELElBQUksTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLE1BQU07QUFDckUsSUFBSSxLQUFLLENBQUMsS0FBSyxJQUFJO0FBQ25CLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDO0FBQzlCLElBQUksQ0FBQztBQUNMLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxTQUFTLEVBQUUsTUFBTSxDQUFDO0FBQ3JELElBQUksT0FBTyxNQUFNO0FBQ2pCO0FBQ0EsRUFBRSxNQUFNLGFBQWEsQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLGFBQWEsRUFBRTtBQUNoRDtBQUNBO0FBQ0EsSUFBSSxNQUFNLGlCQUFpQixHQUFHLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztBQUNyRCxJQUFJLE1BQU0sVUFBVSxHQUFHLE1BQU0saUJBQWlCO0FBQzlDLElBQUksTUFBTSxZQUFZLEdBQUcsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxVQUFVLENBQUMsQ0FBQztBQUMzRCxJQUFJLE9BQU8sSUFBSSxDQUFDLGtCQUFrQixDQUFDLFlBQVksQ0FBQztBQUNoRDtBQUNBLEVBQUUsTUFBTSw4QkFBOEIsQ0FBQyxPQUFPLEVBQUU7QUFDaEQsSUFBSSxNQUFNLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxPQUFPLENBQUM7QUFDMUMsSUFBSSxNQUFNLElBQUksQ0FBQyxXQUFXLEVBQUU7QUFDNUI7QUFDQSxFQUFFLE1BQU0sb0JBQW9CLENBQUMsY0FBYyxFQUFFO0FBQzdDO0FBQ0EsSUFBSSxNQUFNLGdCQUFnQixHQUFHLGNBQWMsQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7QUFDOUUsSUFBSSxJQUFJLENBQUMsZ0JBQWdCLEVBQUU7QUFDM0IsTUFBTSxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxzQkFBc0IsRUFBRTtBQUNqRCxNQUFNLE9BQU8sS0FBSztBQUNsQjtBQUNBLElBQUksTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLGVBQWUsRUFBRTtBQUM3QyxJQUFJLE1BQU0sWUFBWSxHQUFHLE1BQU0sZ0JBQWdCLENBQUMsZUFBZSxDQUFDLE1BQU0sVUFBVSxDQUFDO0FBQ2pGLElBQUksZ0JBQWdCLENBQUMsTUFBTSxDQUFDLE9BQU8sRUFBRTtBQUNyQyxJQUFJLE9BQU8sSUFBSSxDQUFDLGtCQUFrQixDQUFDLFlBQVksQ0FBQztBQUNoRDs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEVBQUUsc0JBQXNCLENBQUMsT0FBTyxFQUFFO0FBQ2xDO0FBQ0EsSUFBSSxJQUFJLFFBQVEsRUFBRSxRQUFRO0FBQzFCLElBQUksTUFBTSxPQUFPLEdBQUcsSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxLQUFLLEVBQUUsUUFBUSxHQUFHLE9BQU8sQ0FBQyxDQUFDLFFBQVEsR0FBRyxNQUFNLENBQUMsRUFBRSxDQUFDO0FBQ2hHLElBQUksT0FBTyxDQUFDLE9BQU8sR0FBRyxRQUFRO0FBQzlCLElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxRQUFRO0FBQzdCLElBQUksT0FBTyxPQUFPO0FBQ2xCOztBQUVBLEVBQUUsTUFBTSxRQUFRLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRTtBQUMzQixJQUFJLElBQUksY0FBYyxHQUFHLElBQUksQ0FBQyxPQUFPO0FBQ3JDLElBQUksTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQztBQUN0RCxJQUFJLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUM7QUFDdEQsSUFBSSxJQUFJLFdBQVcsSUFBSSxXQUFXLEVBQUUsT0FBTyxjQUFjLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQy9FLElBQUksTUFBTSxPQUFPLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsNEJBQTRCLEVBQUUsR0FBRyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsbUJBQW1CLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7QUFDbEo7QUFDQSxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDO0FBQ3hCLElBQUksVUFBVSxDQUFDLE1BQU0sSUFBSSxDQUFDLFVBQVUsRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQzdDLElBQUksT0FBTyxjQUFjLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUNwQztBQUNBLEVBQUUsSUFBSSxPQUFPLEdBQUc7QUFDaEI7QUFDQTtBQUNBLElBQUksT0FBTyxJQUFJLENBQUMsUUFBUSxLQUFLLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxVQUFVLENBQUMsTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUN4STs7QUFFQSxFQUFFLElBQUksc0JBQXNCLEdBQUc7QUFDL0IsSUFBSSxPQUFPLElBQUksQ0FBQyx1QkFBdUIsS0FBSyxJQUFJLENBQUMsb0JBQW9CLEVBQUU7QUFDdkU7QUFDQSxFQUFFLElBQUksd0JBQXdCLEdBQUc7QUFDakM7QUFDQSxJQUFJLE9BQU8sSUFBSSxDQUFDLHlCQUF5QixLQUFLLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsc0JBQXNCLENBQUM7QUFDdEc7QUFDQSxFQUFFLElBQUksNEJBQTRCLEdBQUc7QUFDckMsSUFBSSxPQUFPLElBQUksQ0FBQyw2QkFBNkIsS0FBSyxJQUFJLENBQUMsc0JBQXNCLEVBQUU7QUFDL0U7QUFDQSxFQUFFLElBQUksaUNBQWlDLEdBQUc7QUFDMUMsSUFBSSxPQUFPLElBQUksQ0FBQyx3QkFBd0IsQ0FBQyxJQUFJLENBQUMsTUFBTSxJQUFJLENBQUMsNEJBQTRCLENBQUM7QUFDdEY7QUFDQSxFQUFFLE1BQU0sZ0JBQWdCLEdBQUc7QUFDM0IsSUFBSSxNQUFNLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRTtBQUN2RCxJQUFJLElBQUksU0FBUztBQUNqQixJQUFJLEtBQUssTUFBTSxNQUFNLElBQUksS0FBSyxDQUFDLE1BQU0sRUFBRSxFQUFFO0FBQ3pDLE1BQU0sSUFBSSxNQUFNLENBQUMsSUFBSSxLQUFLLFdBQVcsRUFBRTtBQUN2QyxDQUFDLFNBQVMsR0FBRyxNQUFNO0FBQ25CLENBQUM7QUFDRDtBQUNBO0FBQ0EsSUFBSSxJQUFJLGFBQWEsR0FBRyxTQUFTLElBQUksS0FBSyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsdUJBQXVCLENBQUM7QUFDakYsSUFBSSxJQUFJLENBQUMsYUFBYSxFQUFFO0FBQ3hCLE1BQU0sS0FBSyxNQUFNLE1BQU0sSUFBSSxLQUFLLENBQUMsTUFBTSxFQUFFLEVBQUU7QUFDM0MsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxnQkFBZ0IsS0FBSyxNQUFNLENBQUMsUUFBUSxFQUFFO0FBQzVELEdBQUcsYUFBYSxHQUFHLE1BQU07QUFDekIsR0FBRztBQUNIO0FBQ0E7QUFDQTtBQUNBLElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRTtBQUN4QixNQUFNLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxpQ0FBaUMsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0FBQzdGLE1BQU07QUFDTjtBQUNBLElBQUksTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsaUJBQWlCLENBQUM7QUFDN0QsSUFBSSxNQUFNLENBQUMsUUFBUSxFQUFFLGFBQWEsQ0FBQyxHQUFHLE1BQU07QUFDNUMsSUFBSSxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFO0FBQzFCLElBQUksTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFLLEVBQUUsU0FBUyxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLGFBQWEsRUFBRSx3QkFBd0IsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUMxSCxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxXQUFXLEVBQUUsUUFBUSxFQUFFLGFBQWEsRUFBRSxDQUFDLENBQUMsR0FBRyxHQUFHLElBQUksQ0FBQyxtQkFBbUIsRUFBRSxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3JIO0FBQ0EsRUFBRSxNQUFNLG9CQUFvQixHQUFHO0FBQy9CLElBQUksTUFBTSxXQUFXLEdBQUcsTUFBTSxJQUFJLENBQUMsa0JBQWtCO0FBQ3JELElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsa0JBQWtCLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN6RTtBQUNBLElBQUksTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQztBQUN2RCxJQUFJLE1BQU0sSUFBSSxDQUFDLGdCQUFnQixFQUFFO0FBQ2pDLElBQUksTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUU7O0FBRXhCO0FBQ0EsTUFBTSxPQUFPOztBQUViO0FBQ0E7QUFDQSxNQUFNLGNBQWMsRUFBRSxJQUFJLEdBQUcsRUFBRTs7QUFFL0I7QUFDQTtBQUNBLE1BQU0sV0FBVyxFQUFFLElBQUksR0FBRyxFQUFFOztBQUU1QixNQUFNLGFBQWEsRUFBRSxLQUFLO0FBQzFCLEtBQUssQ0FBQztBQUNOO0FBQ0EsSUFBSSxNQUFNLElBQUksQ0FBQyxPQUFPO0FBQ3RCLElBQUksSUFBSSxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUM3QjtBQUNBLEVBQUUsTUFBTSxXQUFXLENBQUMsSUFBSSxFQUFFO0FBQzFCLElBQUksTUFBTSxJQUFJLEdBQUcsTUFBTSxXQUFXLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQztBQUNqRCxJQUFJLE9BQU8sV0FBVyxDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUM7QUFDNUM7QUFDQSxFQUFFLE1BQU0sT0FBTyxDQUFDLEdBQUcsRUFBRTtBQUNyQixJQUFJLE1BQU0sR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQzlDLElBQUksT0FBTyxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsSUFBSSxTQUFTLENBQUM7QUFDN0M7QUFDQSxFQUFFLE1BQU0sVUFBVSxDQUFDLElBQUksRUFBRTtBQUN6QixJQUFJLEtBQUssTUFBTSxHQUFHLElBQUksSUFBSSxFQUFFO0FBQzVCLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsR0FBRyxFQUFFLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNyRDtBQUNBLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUM7QUFDeEI7QUFDQSxFQUFFLE1BQU0sT0FBTyxHQUFHO0FBQ2xCLElBQUksTUFBTSxJQUFJLENBQUMsc0JBQXNCO0FBQ3JDLElBQUksSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJO0FBQzdCLElBQUksSUFBSSxDQUFDLGlCQUFpQixFQUFFO0FBQzVCO0FBQ0EsRUFBRSx1QkFBdUIsQ0FBQyxRQUFRLEVBQUU7QUFDcEMsSUFBSSxJQUFJLENBQUMsNEJBQTRCLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQztBQUN2RDtBQUNBLEVBQUUsaUJBQWlCLEdBQUc7QUFDdEI7QUFDQTtBQUNBLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLElBQUksSUFBSSxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUU7QUFDekQsSUFBSSxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQztBQUMzQyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMseUJBQXlCLEVBQUUsUUFBUSxDQUFDO0FBQ2xELElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxLQUFLLEVBQUU7QUFDNUIsSUFBSSxJQUFJLENBQUMsY0FBYyxDQUFDLEtBQUssRUFBRTtBQUMvQixJQUFJLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUMsY0FBYyxHQUFHLElBQUk7QUFDakUsSUFBSSxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsMkJBQTJCLEVBQUUsUUFBUSxFQUFFLFVBQVUsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyx3QkFBd0IsRUFBRSxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQztBQUN6SixJQUFJLElBQUksQ0FBQyx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDO0FBQ25EO0FBQ0EsRUFBRSxzQkFBc0IsQ0FBQyxHQUFHLEVBQUU7QUFDOUI7QUFDQTtBQUNBLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsT0FBTyxJQUFJLENBQUM7QUFDMUMsSUFBSSxJQUFJLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLE9BQU8sSUFBSSxDQUFDO0FBQy9DO0FBQ0E7QUFDQSxJQUFJLE9BQU8sSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsRUFBRSxFQUFFLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNqRzs7QUFFQSxFQUFFLE1BQU0sSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUU7QUFDeEI7QUFDQSxJQUFJLE1BQU0sSUFBSSxDQUFDLHNCQUFzQjtBQUNyQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLEVBQUUsY0FBYyxDQUFDLEdBQUcsSUFBSTtBQUMxQyxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsaUJBQWlCLEVBQUUsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxjQUFjLENBQUMsQ0FBQztBQUNyRSxJQUFJLElBQUksY0FBYyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxPQUFPLElBQUksQ0FBQztBQUM3QyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLE9BQU8sSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQztBQUN4RSxJQUFJLE9BQU8sSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNuRTtBQUNBLEVBQUUscUJBQXFCLENBQUMsR0FBRyxFQUFFLFNBQVMsR0FBRyxFQUFFLEVBQUUsY0FBYyxHQUFHLElBQUksRUFBRTtBQUNwRTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUksTUFBTSxPQUFPLEdBQUcsSUFBSSxPQUFPLENBQUMsT0FBTyxJQUFJO0FBQzNDLE1BQU0sVUFBVSxDQUFDLFlBQVk7QUFDN0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxJQUFJLENBQUMsY0FBYyxLQUFLLFNBQVMsS0FBSyxNQUFNLGNBQWMsQ0FBQyxFQUFFO0FBQzVFLEdBQUcsTUFBTSxTQUFTLEdBQUcsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQztBQUM1QztBQUNBLEdBQUcsSUFBSSxTQUFTLEVBQUUsTUFBTSxFQUFFO0FBQzFCLEtBQUssSUFBSSxNQUFNLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsSUFBSSxDQUFDLEVBQUU7QUFDMUQsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLGNBQWMsRUFBRSxHQUFHLEVBQUUsaUJBQWlCLEVBQUUsU0FBUyxJQUFJLGVBQWUsRUFBRSxDQUFDLE1BQU0sY0FBYyxLQUFLLGFBQWEsRUFBRSxTQUFTLEVBQUUsTUFBTSxDQUFDO0FBQ2pKLE1BQU0sTUFBTTtBQUNaLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxlQUFlLEVBQUUsR0FBRyxDQUFDO0FBQ3JDO0FBQ0E7QUFDQTtBQUNBLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDM0IsQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNqQyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsRUFBRTtBQUN6QixDQUFDLE9BQU8sRUFBRTtBQUNWLE9BQU8sQ0FBQztBQUNSLEtBQUssQ0FBQztBQUNOLElBQUksSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQzFDLElBQUksT0FBTyxPQUFPO0FBQ2xCO0FBQ0EsRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFO0FBQ2Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztBQUN0RTtBQUNBO0FBQ0EsSUFBSSxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUMvQyxJQUFJLEtBQUssQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQztBQUNwQyxJQUFJLE9BQU8sT0FBTztBQUNsQjtBQUNBLEVBQUUsTUFBTSxHQUFHLENBQUMsR0FBRyxFQUFFO0FBQ2pCLElBQUksTUFBTSxJQUFJLEdBQUcsTUFBTSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFDL0MsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsSUFBSSxDQUFDO0FBQy9CO0FBQ0EsRUFBRSxJQUFJLENBQUMsU0FBUyxFQUFFLEdBQUcsRUFBRSxTQUFTLEVBQUU7QUFDbEMsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxHQUFHLEVBQUUsU0FBUyxDQUFDO0FBQ3hDO0FBQ0EsRUFBRSxNQUFNLEdBQUcsQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFO0FBQzVCO0FBQ0EsSUFBSSxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsY0FBYyxFQUFFLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFDakQ7QUFDQSxJQUFJLElBQUksT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDO0FBQzNDLFNBQVMsTUFBTSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQ3pEO0FBQ0EsRUFBRSxNQUFNLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRTtBQUN6QixJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsSUFBSSxDQUFDO0FBQ2hEO0FBQ0E7O0FDbmRBLE1BQU0sS0FBSyxTQUFTLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxJQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxZQUFZLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLFVBQVUsRUFBRSxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxZQUFZLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxHQUFFLENBQUMsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUMsQ0FBQyxNQUFNLElBQUksRUFBRSxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsU0FBUyxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxNQUFNLFlBQVksU0FBUyxXQUFXLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxDQUFDLEVBQUUsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUMsQ0FBQyxNQUFNLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLEVBQUUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTSxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENB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
