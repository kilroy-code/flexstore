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
var version$1 = "0.0.66";
var _package = {
	name: name$1,
	version: version$1};

// name/version of "database"
const storageName = 'flexstore';
const storageVersion = 11;
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
    if (!version) {  // Mismatch.
      // Kludge 1: why doesn't this.disconnect() clean up the various promises properly?
      await this.dataChannelPromise.then(channel => channel.close());
      const message = `${this.serviceName} does not use a compatible version.`;
      console.error(message, this.connection.notified);
      if ((typeof(window) !== 'undefined') && !this.connection.notified) { // If we're in a browser, tell the user once.
	this.connection.notified = true;
	window.alert(message);
	setTimeout(() => delete this.connection.notified, 10); // Kludge 2.
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
    // If this collection restricts usable tags for testing, then do so.
    [data, options] = await this.preprocessForSigning(data, options);
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
  verify(...rest) {
    return this.constructor.verify(...rest);
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
    if (decrypt) return await this.constructor.ensureDecrypted(verified);
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
      await this.constructor.ensureDecrypted(verified); // commonStates does not (cannot) decrypt.
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0BraTFyMHkvc3RvcmFnZS9idW5kbGUubWpzIiwibGliL2NvbGxlY3Rpb25zLm1qcyIsImluZGV4Lm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB1dWlkUGF0dGVybiA9IC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tNFswLTlhLWZdezN9LVs4OWFiXVswLTlhLWZdezN9LVswLTlhLWZdezEyfSQvaTtcbmZ1bmN0aW9uIHZhbGlkKHV1aWQpIHtcbiAgcmV0dXJuIHV1aWRQYXR0ZXJuLnRlc3QodXVpZCk7XG59XG5cbi8vIEJhc2VkIG9uIGh0dHBzOi8vYWJoaXNoZWtkdXR0YS5vcmcvYmxvZy9zdGFuZGFsb25lX3V1aWRfZ2VuZXJhdG9yX2luX2phdmFzY3JpcHQuaHRtbFxuLy8gSUUxMSBhbmQgTW9kZXJuIEJyb3dzZXJzIE9ubHlcbmZ1bmN0aW9uIHV1aWQ0KCkge1xuICB2YXIgdGVtcF91cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKCkpO1xuICB2YXIgdXVpZCA9IHRlbXBfdXJsLnRvU3RyaW5nKCk7XG4gIFVSTC5yZXZva2VPYmplY3RVUkwodGVtcF91cmwpO1xuICByZXR1cm4gdXVpZC5zcGxpdCgvWzpcXC9dL2cpLnBvcCgpLnRvTG93ZXJDYXNlKCk7IC8vIHJlbW92ZSBwcmVmaXhlc1xufVxudXVpZDQudmFsaWQgPSB2YWxpZDtcblxuZXhwb3J0IGRlZmF1bHQgdXVpZDQ7XG5leHBvcnQgeyB1dWlkNCwgdmFsaWQgfTtcbiIsIi8vIEluIGEgYnJvd3Nlciwgd3J0YyBwcm9wZXJ0aWVzIHN1Y2ggYXMgUlRDUGVlckNvbm5lY3Rpb24gYXJlIGluIGdsb2JhbFRoaXMuXG5leHBvcnQgZGVmYXVsdCBnbG9iYWxUaGlzO1xuIiwiaW1wb3J0IHV1aWQ0IGZyb20gJ3V1aWQ0JztcblxuLy8gU2VlIHJvbGx1cC5jb25maWcubWpzXG5pbXBvcnQgd3J0YyBmcm9tICcjd3J0Yyc7XG4vL2NvbnN0IHtkZWZhdWx0OndydGN9ID0gYXdhaXQgKCh0eXBlb2YocHJvY2VzcykgIT09ICd1bmRlZmluZWQnKSA/IGltcG9ydCgnQHJvYW1ocS93cnRjJykgOiB7ZGVmYXVsdDogZ2xvYmFsVGhpc30pO1xuXG5jb25zdCBpY2VTZXJ2ZXJzID0gW1xuICB7IHVybHM6ICdzdHVuOnN0dW4ubC5nb29nbGUuY29tOjE5MzAyJ30sXG4gIC8vIGh0dHBzOi8vZnJlZXN0dW4ubmV0LyAgQ3VycmVudGx5IDUwIEtCaXQvcy4gKDIuNSBNQml0L3MgZm9ycyAkOS9tb250aClcbiAgeyB1cmxzOiAnc3R1bjpmcmVlc3R1bi5uZXQ6MzQ3OCcgfSxcbiAgLy97IHVybHM6ICd0dXJuOmZyZWVzdHVuLm5ldDozNDc4JywgdXNlcm5hbWU6ICdmcmVlJywgY3JlZGVudGlhbDogJ2ZyZWUnIH0sXG4gIC8vIFByZXN1bWFibHkgdHJhZmZpYyBsaW1pdGVkLiBDYW4gZ2VuZXJhdGUgbmV3IGNyZWRlbnRpYWxzIGF0IGh0dHBzOi8vc3BlZWQuY2xvdWRmbGFyZS5jb20vdHVybi1jcmVkc1xuICAvLyBBbHNvIGh0dHBzOi8vZGV2ZWxvcGVycy5jbG91ZGZsYXJlLmNvbS9jYWxscy8gMSBUQi9tb250aCwgYW5kICQwLjA1IC9HQiBhZnRlciB0aGF0LlxuICB7IHVybHM6ICd0dXJuOnR1cm4uc3BlZWQuY2xvdWRmbGFyZS5jb206NTAwMDAnLCB1c2VybmFtZTogJzgyNjIyNjI0NGNkNmU1ZWRiM2Y1NTc0OWI3OTYyMzVmNDIwZmU1ZWU3ODg5NWUwZGQ3ZDJiYWE0NWUxZjdhOGY0OWU5MjM5ZTc4NjkxYWIzOGI3MmNlMDE2NDcxZjc3NDZmNTI3N2RjZWY4NGFkNzlmYzYwZjgwMjBiMTMyYzczJywgY3JlZGVudGlhbDogJ2FiYTliMTY5NTQ2ZWI2ZGNjN2JmYjFjZGYzNDU0NGNmOTViNTE2MWQ2MDJlM2I1ZmE3YzgzNDJiMmU5ODAyZmInIH1cbiAgLy8gaHR0cHM6Ly9mYXN0dHVybi5uZXQvIEN1cnJlbnRseSA1MDBNQi9tb250aD8gKDI1IEdCL21vbnRoIGZvciAkOS9tb250aClcbiAgLy8gaHR0cHM6Ly94aXJzeXMuY29tL3ByaWNpbmcvIDUwMCBNQi9tb250aCAoNTAgR0IvbW9udGggZm9yICQzMy9tb250aClcbiAgLy8gQWxzbyBodHRwczovL3d3dy5ucG1qcy5jb20vcGFja2FnZS9ub2RlLXR1cm4gb3IgaHR0cHM6Ly9tZWV0cml4LmlvL2Jsb2cvd2VicnRjL2NvdHVybi9pbnN0YWxsYXRpb24uaHRtbFxuXTtcblxuLy8gVXRpbGl0eSB3cmFwcGVyIGFyb3VuZCBSVENQZWVyQ29ubmVjdGlvbi5cbi8vIFdoZW4gc29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIChzdWNoIGFzIGNyZWF0ZURhdGFDaGFubmVsKSwgaXQgd2lsbCBnZW5lcmF0ZSBjYWxscyB0byBzaWduYWwoKSwgd2hpY2ggbmVlZHMgdG8gYmUgZGVmaW5lZCBieSBzdWJjbGFzc2VzLlxuZXhwb3J0IGNsYXNzIFdlYlJUQyB7XG4gIGNvbnN0cnVjdG9yKHtsYWJlbCA9ICcnLCBjb25maWd1cmF0aW9uID0gbnVsbCwgdXVpZCA9IHV1aWQ0KCksIGRlYnVnID0gZmFsc2UsIGVycm9yID0gY29uc29sZS5lcnJvciwgLi4ucmVzdH0gPSB7fSkge1xuICAgIGNvbmZpZ3VyYXRpb24gPz89IHtpY2VTZXJ2ZXJzfTsgLy8gSWYgY29uZmlndXJhdGlvbiBjYW4gYmUgb21taXR0ZWQgb3IgZXhwbGljaXRseSBhcyBudWxsLCB1c2Ugb3VyIGRlZmF1bHQuIEJ1dCBpZiB7fSwgbGVhdmUgaXQgYmUuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7bGFiZWwsIGNvbmZpZ3VyYXRpb24sIHV1aWQsIGRlYnVnLCBlcnJvciwgLi4ucmVzdH0pO1xuICAgIHRoaXMucmVzZXRQZWVyKCk7XG4gIH1cbiAgc2lnbmFsKHR5cGUsIG1lc3NhZ2UpIHsgLy8gU3ViY2xhc3NlcyBtdXN0IG92ZXJyaWRlIG9yIGV4dGVuZC4gRGVmYXVsdCBqdXN0IGxvZ3MuXG4gICAgdGhpcy5sb2coJ3NlbmRpbmcnLCB0eXBlLCB0eXBlLmxlbmd0aCwgSlNPTi5zdHJpbmdpZnkobWVzc2FnZSkubGVuZ3RoKTtcbiAgfVxuXG4gIHBlZXJWZXJzaW9uID0gMDtcbiAgcmVzZXRQZWVyKCkgeyAvLyBTZXQgdXAgYSBuZXcgUlRDUGVlckNvbm5lY3Rpb24uIChDYWxsZXIgbXVzdCBjbG9zZSBvbGQgaWYgbmVjZXNzYXJ5LilcbiAgICBjb25zdCBvbGQgPSB0aGlzLnBlZXI7XG4gICAgaWYgKG9sZCkge1xuICAgICAgb2xkLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBvbGQub25pY2VjYW5kaWRhdGUgPSBvbGQub25pY2VjYW5kaWRhdGVlcnJvciA9IG9sZC5vbmNvbm5lY3Rpb25zdGF0ZWNoYW5nZSA9IG51bGw7XG4gICAgICAvLyBEb24ndCBjbG9zZSB1bmxlc3MgaXQncyBiZWVuIG9wZW5lZCwgYmVjYXVzZSB0aGVyZSBhcmUgbGlrZWx5IGhhbmRsZXJzIHRoYXQgd2UgZG9uJ3Qgd2FudCB0byBmaXJlLlxuICAgICAgaWYgKG9sZC5jb25uZWN0aW9uU3RhdGUgIT09ICduZXcnKSBvbGQuY2xvc2UoKTtcbiAgICB9XG4gICAgY29uc3QgcGVlciA9IHRoaXMucGVlciA9IG5ldyB3cnRjLlJUQ1BlZXJDb25uZWN0aW9uKHRoaXMuY29uZmlndXJhdGlvbik7XG4gICAgcGVlci52ZXJzaW9uSWQgPSB0aGlzLnBlZXJWZXJzaW9uKys7XG4gICAgcGVlci5vbm5lZ290aWF0aW9ubmVlZGVkID0gZXZlbnQgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZChldmVudCk7XG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZSA9IGV2ZW50ID0+IHRoaXMub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gICAgLy8gSSBkb24ndCB0aGluayBhbnlvbmUgYWN0dWFsbHkgc2lnbmFscyB0aGlzLiBJbnN0ZWFkLCB0aGV5IHJlamVjdCBmcm9tIGFkZEljZUNhbmRpZGF0ZSwgd2hpY2ggd2UgaGFuZGxlIHRoZSBzYW1lLlxuICAgIHBlZXIub25pY2VjYW5kaWRhdGVlcnJvciA9IGVycm9yID0+IHRoaXMuaWNlY2FuZGlkYXRlRXJyb3IoZXJyb3IpO1xuICAgIC8vIEkgdGhpbmsgdGhpcyBpcyByZWR1bmRuYW50IGJlY2F1c2Ugbm8gaW1wbGVtZW50YXRpb24gZmlyZXMgdGhpcyBldmVudCBhbnkgc2lnbmlmaWNhbnQgdGltZSBhaGVhZCBvZiBlbWl0dGluZyBpY2VjYW5kaWRhdGUgd2l0aCBhbiBlbXB0eSBldmVudC5jYW5kaWRhdGUuXG4gICAgcGVlci5vbmljZWdhdGhlcmluZ3N0YXRlY2hhbmdlID0gZXZlbnQgPT4gKHBlZXIuaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScpICYmIHRoaXMub25Mb2NhbEVuZEljZTtcbiAgICBwZWVyLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gZXZlbnQgPT4gdGhpcy5jb25uZWN0aW9uU3RhdGVDaGFuZ2UodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIFRoZSBzcGVjIHNheXMgdGhhdCBhIG51bGwgY2FuZGlkYXRlIHNob3VsZCBub3QgYmUgc2VudCwgYnV0IHRoYXQgYW4gZW1wdHkgc3RyaW5nIGNhbmRpZGF0ZSBzaG91bGQuIFNhZmFyaSAodXNlZCB0bz8pIGdldCBlcnJvcnMgZWl0aGVyIHdheS5cbiAgICBpZiAoIWV2ZW50LmNhbmRpZGF0ZSB8fCAhZXZlbnQuY2FuZGlkYXRlLmNhbmRpZGF0ZSkgdGhpcy5vbkxvY2FsRW5kSWNlKCk7XG4gICAgZWxzZSB0aGlzLnNpZ25hbCgnaWNlY2FuZGlkYXRlJywgZXZlbnQuY2FuZGlkYXRlKTtcbiAgfVxuICBvbkxvY2FsRW5kSWNlKCkgeyAvLyBUcmlnZ2VyZWQgb24gb3VyIHNpZGUgYnkgYW55L2FsbCBvZiBvbmljZWNhbmRpZGF0ZSB3aXRoIG5vIGV2ZW50LmNhbmRpZGF0ZSwgaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScuXG4gICAgLy8gSS5lLiwgY2FuIGhhcHBlbiBtdWx0aXBsZSB0aW1lcy4gU3ViY2xhc3NlcyBtaWdodCBkbyBzb21ldGhpbmcuXG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKCh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnbmV3JykgJiYgKHRoaXMucGVlci5zaWduYWxpbmdTdGF0ZSA9PT0gJ3N0YWJsZScpKSByZXR1cm47XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBjb25uZWN0aW9uU3RhdGVDaGFuZ2Uoc3RhdGUpIHtcbiAgICB0aGlzLmxvZygnc3RhdGUgY2hhbmdlOicsIHN0YXRlKTtcbiAgICBpZiAoWydkaXNjb25uZWN0ZWQnLCAnZmFpbGVkJywgJ2Nsb3NlZCddLmluY2x1ZGVzKHN0YXRlKSkgdGhpcy5jbG9zZSgpOyAvLyBPdGhlciBiZWhhdmlvciBhcmUgcmVhc29uYWJsZSwgdG9sby5cbiAgfVxuICBuZWdvdGlhdGlvbm5lZWRlZCgpIHsgLy8gU29tZXRoaW5nIGhhcyBjaGFuZ2VkIGxvY2FsbHkgKG5ldyBzdHJlYW0sIG9yIG5ldHdvcmsgY2hhbmdlKSwgc3VjaCB0aGF0IHdlIGhhdmUgdG8gc3RhcnQgbmVnb3RpYXRpb24uXG4gICAgdGhpcy5sb2coJ25lZ290aWF0aW9ubm5lZWRlZCcpO1xuICAgIHRoaXMucGVlci5jcmVhdGVPZmZlcigpXG4gICAgICAudGhlbihvZmZlciA9PiB7XG4gICAgICAgIHRoaXMucGVlci5zZXRMb2NhbERlc2NyaXB0aW9uKG9mZmVyKTsgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIG9mZmVyXG5cdHJldHVybiBvZmZlcjtcbiAgICAgIH0pXG4gICAgICAudGhlbihvZmZlciA9PiB0aGlzLnNpZ25hbCgnb2ZmZXInLCBvZmZlcikpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZEVycm9yKGVycm9yKSk7XG4gIH1cbiAgb2ZmZXIob2ZmZXIpIHsgLy8gSGFuZGxlciBmb3IgcmVjZWl2aW5nIGFuIG9mZmVyIGZyb20gdGhlIG90aGVyIHVzZXIgKHdobyBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2VzcykuXG4gICAgLy8gTm90ZSB0aGF0IGR1cmluZyBzaWduYWxpbmcsIHdlIHdpbGwgcmVjZWl2ZSBuZWdvdGlhdGlvbm5lZWRlZC9hbnN3ZXIsIG9yIG9mZmVyLCBidXQgbm90IGJvdGgsIGRlcGVuZGluZ1xuICAgIC8vIG9uIHdoZXRoZXIgd2Ugd2VyZSB0aGUgb25lIHRoYXQgc3RhcnRlZCB0aGUgc2lnbmFsaW5nIHByb2Nlc3MuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKG9mZmVyKVxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnBlZXIuY3JlYXRlQW5zd2VyKCkpXG4gICAgICAudGhlbihhbnN3ZXIgPT4gdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyKSkgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIGFuc3dlclxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnNpZ25hbCgnYW5zd2VyJywgdGhpcy5wZWVyLmxvY2FsRGVzY3JpcHRpb24pKTtcbiAgfVxuICBhbnN3ZXIoYW5zd2VyKSB7IC8vIEhhbmRsZXIgZm9yIGZpbmlzaGluZyB0aGUgc2lnbmFsaW5nIHByb2Nlc3MgdGhhdCB3ZSBzdGFydGVkLlxuICAgIHRoaXMucGVlci5zZXRSZW1vdGVEZXNjcmlwdGlvbihhbnN3ZXIpO1xuICB9XG4gIGljZWNhbmRpZGF0ZShpY2VDYW5kaWRhdGUpIHsgLy8gSGFuZGxlciBmb3IgYSBuZXcgY2FuZGlkYXRlIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZCB0aHJvdWdoIHNpZ25hbGluZy5cbiAgICB0aGlzLnBlZXIuYWRkSWNlQ2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkuY2F0Y2goZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcikpO1xuICB9XG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnJlc3QpO1xuICB9XG4gIGxvZ0Vycm9yKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgY29uc3QgZGF0YSA9IFt0aGlzLmxhYmVsLCB0aGlzLnBlZXIudmVyc2lvbklkLCAuLi50aGlzLmNvbnN0cnVjdG9yLmdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbildO1xuICAgIHRoaXMuZXJyb3IoZGF0YSk7XG4gICAgcmV0dXJuIGRhdGE7XG4gIH1cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7XG4gIH1cbiAgc3RhdGljIGdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbikge1xuICAgIHJldHVybiBbXG4gICAgICBsYWJlbCArIFwiIGVycm9yOlwiLFxuICAgICAgZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzIHx8IFwiXCIsIC8vIEZpcnN0IGlzIGRlcHJlY2F0ZWQsIGJ1dCBzdGlsbCB1c2VmdWwuXG4gICAgICBldmVudE9yRXhjZXB0aW9uLnVybCB8fCBldmVudE9yRXhjZXB0aW9uLm5hbWUgfHwgJycsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLm1lc3NhZ2UgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvclRleHQgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXNUZXh0IHx8IGV2ZW50T3JFeGNlcHRpb25cbiAgICBdO1xuICB9XG4gIGljZWNhbmRpZGF0ZUVycm9yKGV2ZW50T3JFeGNlcHRpb24pIHsgLy8gRm9yIGVycm9ycyBvbiB0aGlzIHBlZXIgZHVyaW5nIGdhdGhlcmluZy5cbiAgICAvLyBDYW4gYmUgb3ZlcnJpZGRlbiBvciBleHRlbmRlZCBieSBhcHBsaWNhdGlvbnMuXG5cbiAgICAvLyBTVFVOIGVycm9ycyBhcmUgaW4gdGhlIHJhbmdlIDMwMC02OTkuIFNlZSBSRkMgNTM4OSwgc2VjdGlvbiAxNS42XG4gICAgLy8gZm9yIGEgbGlzdCBvZiBjb2Rlcy4gVFVSTiBhZGRzIGEgZmV3IG1vcmUgZXJyb3IgY29kZXM7IHNlZVxuICAgIC8vIFJGQyA1NzY2LCBzZWN0aW9uIDE1IGZvciBkZXRhaWxzLlxuICAgIC8vIFNlcnZlciBjb3VsZCBub3QgYmUgcmVhY2hlZCBhcmUgaW4gdGhlIHJhbmdlIDcwMC03OTkuXG4gICAgY29uc3QgY29kZSA9IGV2ZW50T3JFeGNlcHRpb24uY29kZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yQ29kZSB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1cztcbiAgICAvLyBDaHJvbWUgZ2l2ZXMgNzAxIGVycm9ycyBmb3Igc29tZSB0dXJuIHNlcnZlcnMgdGhhdCBpdCBkb2VzIG5vdCBnaXZlIGZvciBvdGhlciB0dXJuIHNlcnZlcnMuXG4gICAgLy8gVGhpcyBpc24ndCBnb29kLCBidXQgaXQncyB3YXkgdG9vIG5vaXN5IHRvIHNsb2cgdGhyb3VnaCBzdWNoIGVycm9ycywgYW5kIEkgZG9uJ3Qga25vdyBob3cgdG8gZml4IG91ciB0dXJuIGNvbmZpZ3VyYXRpb24uXG4gICAgaWYgKGNvZGUgPT09IDcwMSkgcmV0dXJuO1xuICAgIHRoaXMubG9nRXJyb3IoJ2ljZScsIGV2ZW50T3JFeGNlcHRpb24pO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBQcm9taXNlV2ViUlRDIGV4dGVuZHMgV2ViUlRDIHtcbiAgLy8gRXh0ZW5kcyBXZWJSVEMuc2lnbmFsKCkgc3VjaCB0aGF0OlxuICAvLyAtIGluc3RhbmNlLnNpZ25hbHMgYW5zd2VycyBhIHByb21pc2UgdGhhdCB3aWxsIHJlc29sdmUgd2l0aCBhbiBhcnJheSBvZiBzaWduYWwgbWVzc2FnZXMuXG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyA9IFsuLi5zaWduYWxNZXNzYWdlc10gd2lsbCBkaXNwYXRjaCB0aG9zZSBtZXNzYWdlcy5cbiAgLy9cbiAgLy8gRm9yIGV4YW1wbGUsIHN1cHBvc2UgcGVlcjEgYW5kIHBlZXIyIGFyZSBpbnN0YW5jZXMgb2YgdGhpcy5cbiAgLy8gMC4gU29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIG9uIHBlZXIxIChzdWNoIGFzIGNhbGxpbmcgcGVlcjEuY3JlYXRlRGF0YUNoYW5uZWwoKSkuIFxuICAvLyAxLiBwZWVyMS5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDE+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjIuXG4gIC8vIDIuIFNldCBwZWVyMi5zaWduYWxzID0gPHNpZ25hbDE+LlxuICAvLyAzLiBwZWVyMi5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDI+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjEuXG4gIC8vIDQuIFNldCBwZWVyMS5zaWduYWxzID0gPHNpZ25hbDI+LlxuICAvLyA1LiBEYXRhIGZsb3dzLCBidXQgZWFjaCBzaWRlIHdob3VsZCBncmFiIGEgbmV3IHNpZ25hbHMgcHJvbWlzZSBhbmQgYmUgcHJlcGFyZWQgdG8gYWN0IGlmIGl0IHJlc29sdmVzLlxuICAvL1xuICBjb25zdHJ1Y3Rvcih7aWNlVGltZW91dCA9IDJlMywgLi4ucHJvcGVydGllc30pIHtcbiAgICBzdXBlcihwcm9wZXJ0aWVzKTtcbiAgICB0aGlzLmljZVRpbWVvdXQgPSBpY2VUaW1lb3V0O1xuICB9XG4gIGdldCBzaWduYWxzKCkgeyAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmUgdG8gdGhlIHNpZ25hbCBtZXNzYWdpbmcgd2hlbiBpY2UgY2FuZGlkYXRlIGdhdGhlcmluZyBpcyBjb21wbGV0ZS5cbiAgICByZXR1cm4gdGhpcy5fc2lnbmFsUHJvbWlzZSB8fD0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gdGhpcy5fc2lnbmFsUmVhZHkgPSB7cmVzb2x2ZSwgcmVqZWN0fSk7XG4gIH1cbiAgc2V0IHNpZ25hbHMoZGF0YSkgeyAvLyBTZXQgd2l0aCB0aGUgc2lnbmFscyByZWNlaXZlZCBmcm9tIHRoZSBvdGhlciBlbmQuXG4gICAgZGF0YS5mb3JFYWNoKChbdHlwZSwgbWVzc2FnZV0pID0+IHRoaXNbdHlwZV0obWVzc2FnZSkpO1xuICB9XG4gIG9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpIHtcbiAgICAvLyBFYWNoIHdydGMgaW1wbGVtZW50YXRpb24gaGFzIGl0cyBvd24gaWRlYXMgYXMgdG8gd2hhdCBpY2UgY2FuZGlkYXRlcyB0byB0cnkgYmVmb3JlIGVtaXR0aW5nIHRoZW0gaW4gaWNlY2FuZGRpYXRlLlxuICAgIC8vIE1vc3Qgd2lsbCB0cnkgdGhpbmdzIHRoYXQgY2Fubm90IGJlIHJlYWNoZWQsIGFuZCBnaXZlIHVwIHdoZW4gdGhleSBoaXQgdGhlIE9TIG5ldHdvcmsgdGltZW91dC4gRm9ydHkgc2Vjb25kcyBpcyBhIGxvbmcgdGltZSB0byB3YWl0LlxuICAgIC8vIElmIHRoZSB3cnRjIGlzIHN0aWxsIHdhaXRpbmcgYWZ0ZXIgb3VyIGljZVRpbWVvdXQgKDIgc2Vjb25kcyksIGxldHMganVzdCBnbyB3aXRoIHdoYXQgd2UgaGF2ZS5cbiAgICB0aGlzLnRpbWVyIHx8PSBzZXRUaW1lb3V0KCgpID0+IHRoaXMub25Mb2NhbEVuZEljZSgpLCB0aGlzLmljZVRpbWVvdXQpO1xuICAgIHN1cGVyLm9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpO1xuICB9XG4gIGNsZWFySWNlVGltZXIoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpO1xuICAgIHRoaXMudGltZXIgPSBudWxsO1xuICB9XG4gIGFzeW5jIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFJlc29sdmUgdGhlIHByb21pc2Ugd2l0aCB3aGF0IHdlJ3ZlIGJlZW4gZ2F0aGVyaW5nLlxuICAgIHRoaXMuY2xlYXJJY2VUaW1lcigpO1xuICAgIGlmICghdGhpcy5fc2lnbmFsUHJvbWlzZSkge1xuICAgICAgLy90aGlzLmxvZ0Vycm9yKCdpY2UnLCBcIkVuZCBvZiBJQ0Ugd2l0aG91dCBhbnl0aGluZyB3YWl0aW5nIG9uIHNpZ25hbHMuXCIpOyAvLyBOb3QgaGVscGZ1bCB3aGVuIHRoZXJlIGFyZSB0aHJlZSB3YXlzIHRvIHJlY2VpdmUgdGhpcyBtZXNzYWdlLlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9zaWduYWxSZWFkeS5yZXNvbHZlKHRoaXMuc2VuZGluZyk7XG4gICAgdGhpcy5zZW5kaW5nID0gW107XG4gIH1cbiAgc2VuZGluZyA9IFtdO1xuICBzaWduYWwodHlwZSwgbWVzc2FnZSkge1xuICAgIHN1cGVyLnNpZ25hbCh0eXBlLCBtZXNzYWdlKTtcbiAgICB0aGlzLnNlbmRpbmcucHVzaChbdHlwZSwgbWVzc2FnZV0pO1xuICB9XG4gIC8vIFdlIG5lZWQgdG8ga25vdyBpZiB0aGVyZSBhcmUgb3BlbiBkYXRhIGNoYW5uZWxzLiBUaGVyZSBpcyBhIHByb3Bvc2FsIGFuZCBldmVuIGFuIGFjY2VwdGVkIFBSIGZvciBSVENQZWVyQ29ubmVjdGlvbi5nZXREYXRhQ2hhbm5lbHMoKSxcbiAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3czYy93ZWJydGMtZXh0ZW5zaW9ucy9pc3N1ZXMvMTEwXG4gIC8vIGJ1dCBpdCBoYXNuJ3QgYmVlbiBkZXBsb3llZCBldmVyeXdoZXJlIHlldC4gU28gd2UnbGwgbmVlZCB0byBrZWVwIG91ciBvd24gY291bnQuXG4gIC8vIEFsYXMsIGEgY291bnQgaXNuJ3QgZW5vdWdoLCBiZWNhdXNlIHdlIGNhbiBvcGVuIHN0dWZmLCBhbmQgdGhlIG90aGVyIHNpZGUgY2FuIG9wZW4gc3R1ZmYsIGJ1dCBpZiBpdCBoYXBwZW5zIHRvIGJlXG4gIC8vIHRoZSBzYW1lIFwibmVnb3RpYXRlZFwiIGlkLCBpdCBpc24ndCByZWFsbHkgYSBkaWZmZXJlbnQgY2hhbm5lbC4gKGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9SVENQZWVyQ29ubmVjdGlvbi9kYXRhY2hhbm5lbF9ldmVudFxuICBkYXRhQ2hhbm5lbHMgPSBuZXcgTWFwKCk7XG4gIHJlcG9ydENoYW5uZWxzKCkgeyAvLyBSZXR1cm4gYSByZXBvcnQgc3RyaW5nIHVzZWZ1bCBmb3IgZGVidWdnaW5nLlxuICAgIGNvbnN0IGVudHJpZXMgPSBBcnJheS5mcm9tKHRoaXMuZGF0YUNoYW5uZWxzLmVudHJpZXMoKSk7XG4gICAgY29uc3Qga3YgPSBlbnRyaWVzLm1hcCgoW2ssIHZdKSA9PiBgJHtrfToke3YuaWR9YCk7XG4gICAgcmV0dXJuIGAke3RoaXMuZGF0YUNoYW5uZWxzLnNpemV9LyR7a3Yuam9pbignLCAnKX1gO1xuICB9XG4gIG5vdGVDaGFubmVsKGNoYW5uZWwsIHNvdXJjZSwgd2FpdGluZykgeyAvLyBCb29ra2VlcCBvcGVuIGNoYW5uZWwgYW5kIHJldHVybiBpdC5cbiAgICAvLyBFbXBlcmljYWxseSwgd2l0aCBtdWx0aXBsZXggZmFsc2U6IC8vICAgMTggb2NjdXJyZW5jZXMsIHdpdGggaWQ9bnVsbHwwfDEgYXMgZm9yIGV2ZW50Y2hhbm5lbCBvciBjcmVhdGVEYXRhQ2hhbm5lbFxuICAgIC8vICAgQXBwYXJlbnRseSwgd2l0aG91dCBuZWdvdGlhdGlvbiwgaWQgaXMgaW5pdGlhbGx5IG51bGwgKHJlZ2FyZGxlc3Mgb2Ygb3B0aW9ucy5pZCksIGFuZCB0aGVuIGFzc2lnbmVkIHRvIGEgZnJlZSB2YWx1ZSBkdXJpbmcgb3BlbmluZ1xuICAgIGNvbnN0IGtleSA9IGNoYW5uZWwubGFiZWw7IC8vZml4bWUgY2hhbm5lbC5pZCA9PT0gbnVsbCA/IDEgOiBjaGFubmVsLmlkO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5kYXRhQ2hhbm5lbHMuZ2V0KGtleSk7XG4gICAgdGhpcy5sb2coJ2dvdCBkYXRhLWNoYW5uZWwnLCBzb3VyY2UsIGtleSwgY2hhbm5lbC5yZWFkeVN0YXRlLCAnZXhpc3Rpbmc6JywgZXhpc3RpbmcsICd3YWl0aW5nOicsIHdhaXRpbmcpO1xuICAgIHRoaXMuZGF0YUNoYW5uZWxzLnNldChrZXksIGNoYW5uZWwpO1xuICAgIGNoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcignY2xvc2UnLCBldmVudCA9PiB7IC8vIENsb3NlIHdob2xlIGNvbm5lY3Rpb24gd2hlbiBubyBtb3JlIGRhdGEgY2hhbm5lbHMgb3Igc3RyZWFtcy5cbiAgICAgIHRoaXMuZGF0YUNoYW5uZWxzLmRlbGV0ZShrZXkpO1xuICAgICAgLy8gSWYgdGhlcmUncyBub3RoaW5nIG9wZW4sIGNsb3NlIHRoZSBjb25uZWN0aW9uLlxuICAgICAgaWYgKHRoaXMuZGF0YUNoYW5uZWxzLnNpemUpIHJldHVybjtcbiAgICAgIGlmICh0aGlzLnBlZXIuZ2V0U2VuZGVycygpLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgdGhpcy5jbG9zZSgpO1xuICAgIH0pO1xuICAgIHJldHVybiBjaGFubmVsO1xuICB9XG4gIGNyZWF0ZURhdGFDaGFubmVsKGxhYmVsID0gXCJkYXRhXCIsIGNoYW5uZWxPcHRpb25zID0ge30pIHsgLy8gUHJvbWlzZSByZXNvbHZlcyB3aGVuIHRoZSBjaGFubmVsIGlzIG9wZW4gKHdoaWNoIHdpbGwgYmUgYWZ0ZXIgYW55IG5lZWRlZCBuZWdvdGlhdGlvbikuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgdGhpcy5sb2coJ2NyZWF0ZSBkYXRhLWNoYW5uZWwnLCBsYWJlbCwgY2hhbm5lbE9wdGlvbnMpO1xuICAgICAgbGV0IGNoYW5uZWwgPSB0aGlzLnBlZXIuY3JlYXRlRGF0YUNoYW5uZWwobGFiZWwsIGNoYW5uZWxPcHRpb25zKTtcbiAgICAgIHRoaXMubm90ZUNoYW5uZWwoY2hhbm5lbCwgJ2V4cGxpY2l0Jyk7IC8vIE5vdGVkIGV2ZW4gYmVmb3JlIG9wZW5lZC5cbiAgICAgIC8vIFRoZSBjaGFubmVsIG1heSBoYXZlIGFscmVhZHkgYmVlbiBvcGVuZWQgb24gdGhlIG90aGVyIHNpZGUuIEluIHRoaXMgY2FzZSwgYWxsIGJyb3dzZXJzIGZpcmUgdGhlIG9wZW4gZXZlbnQgYW55d2F5LFxuICAgICAgLy8gYnV0IHdydGMgKGkuZS4sIG9uIG5vZGVKUykgZG9lcyBub3QuIFNvIHdlIGhhdmUgdG8gZXhwbGljaXRseSBjaGVjay5cbiAgICAgIHN3aXRjaCAoY2hhbm5lbC5yZWFkeVN0YXRlKSB7XG4gICAgICBjYXNlICdvcGVuJzpcblx0c2V0VGltZW91dCgoKSA9PiByZXNvbHZlKGNoYW5uZWwpLCAxMCk7XG5cdGJyZWFrO1xuICAgICAgY2FzZSAnY29ubmVjdGluZyc6XG5cdGNoYW5uZWwub25vcGVuID0gXyA9PiByZXNvbHZlKGNoYW5uZWwpO1xuXHRicmVhaztcbiAgICAgIGRlZmF1bHQ6XG5cdHRocm93IG5ldyBFcnJvcihgVW5leHBlY3RlZCByZWFkeVN0YXRlICR7Y2hhbm5lbC5yZWFkeVN0YXRlfSBmb3IgZGF0YSBjaGFubmVsICR7bGFiZWx9LmApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHdhaXRpbmdDaGFubmVscyA9IHt9O1xuICBnZXREYXRhQ2hhbm5lbFByb21pc2UobGFiZWwgPSBcImRhdGFcIikgeyAvLyBSZXNvbHZlcyB0byBhbiBvcGVuIGRhdGEgY2hhbm5lbC5cbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICB0aGlzLmxvZygncHJvbWlzZSBkYXRhLWNoYW5uZWwnLCBsYWJlbCk7XG4gICAgICB0aGlzLndhaXRpbmdDaGFubmVsc1tsYWJlbF0gPSByZXNvbHZlO1xuICAgIH0pO1xuICB9XG4gIHJlc2V0UGVlcigpIHsgLy8gUmVzZXQgYSAnY29ubmVjdGVkJyBwcm9wZXJ0eSB0aGF0IHByb21pc2VkIHRvIHJlc29sdmUgd2hlbiBvcGVuZWQsIGFuZCB0cmFjayBpbmNvbWluZyBkYXRhY2hhbm5lbHMuXG4gICAgc3VwZXIucmVzZXRQZWVyKCk7XG4gICAgdGhpcy5jb25uZWN0ZWQgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgLy8gdGhpcy5jb25uZWN0ZWQgaXMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiB3ZSBhcmUuXG4gICAgICB0aGlzLnBlZXIuYWRkRXZlbnRMaXN0ZW5lcignY29ubmVjdGlvbnN0YXRlY2hhbmdlJywgZXZlbnQgPT4ge1xuXHRpZiAodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2Nvbm5lY3RlZCcpIHtcblx0ICByZXNvbHZlKHRydWUpO1xuXHR9XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICB0aGlzLnBlZXIuYWRkRXZlbnRMaXN0ZW5lcignZGF0YWNoYW5uZWwnLCBldmVudCA9PiB7IC8vIFJlc29sdmUgcHJvbWlzZSBtYWRlIHdpdGggZ2V0RGF0YUNoYW5uZWxQcm9taXNlKCkuXG4gICAgICBjb25zdCBjaGFubmVsID0gZXZlbnQuY2hhbm5lbDtcbiAgICAgIGNvbnN0IGxhYmVsID0gY2hhbm5lbC5sYWJlbDtcbiAgICAgIGNvbnN0IHdhaXRpbmcgPSB0aGlzLndhaXRpbmdDaGFubmVsc1tsYWJlbF07XG4gICAgICB0aGlzLm5vdGVDaGFubmVsKGNoYW5uZWwsICdkYXRhY2hhbm5lbCBldmVudCcsIHdhaXRpbmcpOyAvLyBSZWdhcmRsZXNzIG9mIHdoZXRoZXIgd2UgYXJlIHdhaXRpbmcuXG4gICAgICBpZiAoIXdhaXRpbmcpIHJldHVybjsgLy8gTWlnaHQgbm90IGJlIGV4cGxpY2l0bHkgd2FpdGluZy4gRS5nLiwgcm91dGVycy5cbiAgICAgIGRlbGV0ZSB0aGlzLndhaXRpbmdDaGFubmVsc1tsYWJlbF07XG4gICAgICB3YWl0aW5nKGNoYW5uZWwpO1xuICAgIH0pO1xuICB9XG4gIGNsb3NlKCkge1xuICAgIGlmICh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnZmFpbGVkJykgdGhpcy5fc2lnbmFsUHJvbWlzZT8ucmVqZWN0Py4oKTtcbiAgICBzdXBlci5jbG9zZSgpO1xuICAgIHRoaXMuY2xlYXJJY2VUaW1lcigpO1xuICAgIHRoaXMuX3NpZ25hbFByb21pc2UgPSB0aGlzLl9zaWduYWxSZWFkeSA9IG51bGw7XG4gICAgdGhpcy5zZW5kaW5nID0gW107XG4gICAgLy8gSWYgdGhlIHdlYnJ0YyBpbXBsZW1lbnRhdGlvbiBjbG9zZXMgdGhlIGRhdGEgY2hhbm5lbHMgYmVmb3JlIHRoZSBwZWVyIGl0c2VsZiwgdGhlbiB0aGlzLmRhdGFDaGFubmVscyB3aWxsIGJlIGVtcHR5LlxuICAgIC8vIEJ1dCBpZiBub3QgKGUuZy4sIHN0YXR1cyAnZmFpbGVkJyBvciAnZGlzY29ubmVjdGVkJyBvbiBTYWZhcmkpLCB0aGVuIGxldCB1cyBleHBsaWNpdGx5IGNsb3NlIHRoZW0gc28gdGhhdCBTeW5jaHJvbml6ZXJzIGtub3cgdG8gY2xlYW4gdXAuXG4gICAgZm9yIChjb25zdCBjaGFubmVsIG9mIHRoaXMuZGF0YUNoYW5uZWxzLnZhbHVlcygpKSB7XG4gICAgICBpZiAoY2hhbm5lbC5yZWFkeVN0YXRlICE9PSAnb3BlbicpIGNvbnRpbnVlOyAvLyBLZWVwIGRlYnVnZ2luZyBzYW5pdHkuXG4gICAgICAvLyBJdCBhcHBlYXJzIHRoYXQgaW4gU2FmYXJpICgxOC41KSBmb3IgYSBjYWxsIHRvIGNoYW5uZWwuY2xvc2UoKSB3aXRoIHRoZSBjb25uZWN0aW9uIGFscmVhZHkgaW50ZXJuYWxsIGNsb3NlZCwgU2FmYXJpXG4gICAgICAvLyB3aWxsIHNldCBjaGFubmVsLnJlYWR5U3RhdGUgdG8gJ2Nsb3NpbmcnLCBidXQgTk9UIGZpcmUgdGhlIGNsb3NlZCBvciBjbG9zaW5nIGV2ZW50LiBTbyB3ZSBoYXZlIHRvIGRpc3BhdGNoIGl0IG91cnNlbHZlcy5cbiAgICAgIC8vY2hhbm5lbC5jbG9zZSgpO1xuICAgICAgY2hhbm5lbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2xvc2UnKSk7XG4gICAgfVxuICB9XG59XG5cbi8vIE5lZ290aWF0ZWQgY2hhbm5lbHMgdXNlIHNwZWNpZmljIGludGVnZXJzIG9uIGJvdGggc2lkZXMsIHN0YXJ0aW5nIHdpdGggdGhpcyBudW1iZXIuXG4vLyBXZSBkbyBub3Qgc3RhcnQgYXQgemVybyBiZWNhdXNlIHRoZSBub24tbmVnb3RpYXRlZCBjaGFubmVscyAoYXMgdXNlZCBvbiBzZXJ2ZXIgcmVsYXlzKSBnZW5lcmF0ZSB0aGVpclxuLy8gb3duIGlkcyBzdGFydGluZyB3aXRoIDAsIGFuZCB3ZSBkb24ndCB3YW50IHRvIGNvbmZsaWN0LlxuLy8gVGhlIHNwZWMgc2F5cyB0aGVzZSBjYW4gZ28gdG8gNjUsNTM0LCBidXQgSSBmaW5kIHRoYXQgc3RhcnRpbmcgZ3JlYXRlciB0aGFuIHRoZSB2YWx1ZSBoZXJlIGdpdmVzIGVycm9ycy5cbi8vIEFzIG9mIDcvNi8yNSwgY3VycmVudCBldmVyZ3JlZW4gYnJvd3NlcnMgd29yayB3aXRoIDEwMDAgYmFzZSwgYnV0IEZpcmVmb3ggZmFpbHMgaW4gb3VyIGNhc2UgKDEwIG5lZ290YXRpYXRlZCBjaGFubmVscylcbi8vIGlmIGFueSBpZHMgYXJlIDI1NiBvciBoaWdoZXIuXG5jb25zdCBCQVNFX0NIQU5ORUxfSUQgPSAxMjU7XG5leHBvcnQgY2xhc3MgU2hhcmVkV2ViUlRDIGV4dGVuZHMgUHJvbWlzZVdlYlJUQyB7XG4gIHN0YXRpYyBjb25uZWN0aW9ucyA9IG5ldyBNYXAoKTtcbiAgc3RhdGljIGVuc3VyZSh7c2VydmljZUxhYmVsLCBtdWx0aXBsZXggPSB0cnVlLCAuLi5yZXN0fSkge1xuICAgIGxldCBjb25uZWN0aW9uID0gdGhpcy5jb25uZWN0aW9ucy5nZXQoc2VydmljZUxhYmVsKTtcbiAgICAvLyBJdCBpcyBwb3NzaWJsZSB0aGF0IHdlIHdlcmUgYmFja2dyb3VuZGVkIGJlZm9yZSB3ZSBoYWQgYSBjaGFuY2UgdG8gYWN0IG9uIGEgY2xvc2luZyBjb25uZWN0aW9uIGFuZCByZW1vdmUgaXQuXG4gICAgaWYgKGNvbm5lY3Rpb24pIHtcbiAgICAgIGNvbnN0IHtjb25uZWN0aW9uU3RhdGUsIHNpZ25hbGluZ1N0YXRlfSA9IGNvbm5lY3Rpb24ucGVlcjtcbiAgICAgIGlmICgoY29ubmVjdGlvblN0YXRlID09PSAnY2xvc2VkJykgfHwgKHNpZ25hbGluZ1N0YXRlID09PSAnY2xvc2VkJykpIGNvbm5lY3Rpb24gPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIWNvbm5lY3Rpb24pIHtcbiAgICAgIGNvbm5lY3Rpb24gPSBuZXcgdGhpcyh7bGFiZWw6IHNlcnZpY2VMYWJlbCwgdXVpZDogdXVpZDQoKSwgbXVsdGlwbGV4LCAuLi5yZXN0fSk7XG4gICAgICBpZiAobXVsdGlwbGV4KSB0aGlzLmNvbm5lY3Rpb25zLnNldChzZXJ2aWNlTGFiZWwsIGNvbm5lY3Rpb24pO1xuICAgIH1cbiAgICByZXR1cm4gY29ubmVjdGlvbjtcbiAgfVxuICBjaGFubmVsSWQgPSBCQVNFX0NIQU5ORUxfSUQ7XG4gIGdldCBoYXNTdGFydGVkQ29ubmVjdGluZygpIHtcbiAgICByZXR1cm4gdGhpcy5jaGFubmVsSWQgPiBCQVNFX0NIQU5ORUxfSUQ7XG4gIH1cbiAgY2xvc2UocmVtb3ZlQ29ubmVjdGlvbiA9IHRydWUpIHtcbiAgICB0aGlzLmNoYW5uZWxJZCA9IEJBU0VfQ0hBTk5FTF9JRDtcbiAgICBzdXBlci5jbG9zZSgpO1xuICAgIGlmIChyZW1vdmVDb25uZWN0aW9uKSB0aGlzLmNvbnN0cnVjdG9yLmNvbm5lY3Rpb25zLmRlbGV0ZSh0aGlzLnNlcnZpY2VMYWJlbCk7XG4gIH1cbiAgYXN5bmMgZW5zdXJlRGF0YUNoYW5uZWwoY2hhbm5lbE5hbWUsIGNoYW5uZWxPcHRpb25zID0ge30sIHNpZ25hbHMgPSBudWxsKSB7IC8vIFJldHVybiBhIHByb21pc2UgZm9yIGFuIG9wZW4gZGF0YSBjaGFubmVsIG9uIHRoaXMgY29ubmVjdGlvbi5cbiAgICBjb25zdCBoYXNTdGFydGVkQ29ubmVjdGluZyA9IHRoaXMuaGFzU3RhcnRlZENvbm5lY3Rpbmc7IC8vIE11c3QgYXNrIGJlZm9yZSBpbmNyZW1lbnRpbmcgaWQuXG4gICAgY29uc3QgaWQgPSB0aGlzLmNoYW5uZWxJZCsrOyAvLyBUaGlzIGFuZCBldmVyeXRoaW5nIGxlYWRpbmcgdXAgdG8gaXQgbXVzdCBiZSBzeW5jaHJvbm91cywgc28gdGhhdCBpZCBhc3NpZ25tZW50IGlzIGRldGVybWluaXN0aWMuXG4gICAgY29uc3QgbmVnb3RpYXRlZCA9ICh0aGlzLm11bHRpcGxleCA9PT0gJ25lZ290aWF0ZWQnKSAmJiBoYXNTdGFydGVkQ29ubmVjdGluZztcbiAgICBjb25zdCBhbGxvd090aGVyU2lkZVRvQ3JlYXRlID0gIWhhc1N0YXJ0ZWRDb25uZWN0aW5nIC8qIW5lZ290aWF0ZWQqLyAmJiAhIXNpZ25hbHM7IC8vIE9ubHkgdGhlIDB0aCB3aXRoIHNpZ25hbHMgd2FpdHMgcGFzc2l2ZWx5LlxuICAgIC8vIHNpZ25hbHMgaXMgZWl0aGVyIG51bGxpc2ggb3IgYW4gYXJyYXkgb2Ygc2lnbmFscywgYnV0IHRoYXQgYXJyYXkgY2FuIGJlIEVNUFRZLFxuICAgIC8vIGluIHdoaWNoIGNhc2UgdGhlIHJlYWwgc2lnbmFscyB3aWxsIGhhdmUgdG8gYmUgYXNzaWduZWQgbGF0ZXIuIFRoaXMgYWxsb3dzIHRoZSBkYXRhIGNoYW5uZWwgdG8gYmUgc3RhcnRlZCAoYW5kIHRvIGNvbnN1bWVcbiAgICAvLyBhIGNoYW5uZWxJZCkgc3luY2hyb25vdXNseSwgYnV0IHRoZSBwcm9taXNlIHdvbid0IHJlc29sdmUgdW50aWwgdGhlIHJlYWwgc2lnbmFscyBhcmUgc3VwcGxpZWQgbGF0ZXIuIFRoaXMgaXNcbiAgICAvLyB1c2VmdWwgaW4gbXVsdGlwbGV4aW5nIGFuIG9yZGVyZWQgc2VyaWVzIG9mIGRhdGEgY2hhbm5lbHMgb24gYW4gQU5TV0VSIGNvbm5lY3Rpb24sIHdoZXJlIHRoZSBkYXRhIGNoYW5uZWxzIG11c3RcbiAgICAvLyBtYXRjaCB1cCB3aXRoIGFuIE9GRkVSIGNvbm5lY3Rpb24gb24gYSBwZWVyLiBUaGlzIHdvcmtzIGJlY2F1c2Ugb2YgdGhlIHdvbmRlcmZ1bCBoYXBwZW5zdGFuY2UgdGhhdCBhbnN3ZXIgY29ubmVjdGlvbnNcbiAgICAvLyBnZXREYXRhQ2hhbm5lbFByb21pc2UgKHdoaWNoIGRvZXNuJ3QgcmVxdWlyZSB0aGUgY29ubmVjdGlvbiB0byB5ZXQgYmUgb3BlbikgcmF0aGVyIHRoYW4gY3JlYXRlRGF0YUNoYW5uZWwgKHdoaWNoIHdvdWxkXG4gICAgLy8gcmVxdWlyZSB0aGUgY29ubmVjdGlvbiB0byBhbHJlYWR5IGJlIG9wZW4pLlxuICAgIGNvbnN0IHVzZVNpZ25hbHMgPSAhaGFzU3RhcnRlZENvbm5lY3RpbmcgJiYgc2lnbmFscz8ubGVuZ3RoO1xuICAgIGNvbnN0IG9wdGlvbnMgPSBuZWdvdGlhdGVkID8ge2lkLCBuZWdvdGlhdGVkLCAuLi5jaGFubmVsT3B0aW9uc30gOiBjaGFubmVsT3B0aW9ucztcbiAgICBpZiAoaGFzU3RhcnRlZENvbm5lY3RpbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMuY29ubmVjdGVkOyAvLyBCZWZvcmUgY3JlYXRpbmcgcHJvbWlzZS5cbiAgICAgIC8vIEkgc29tZXRpbWVzIGVuY291bnRlciBhIGJ1ZyBpbiBTYWZhcmkgaW4gd2hpY2ggT05FIG9mIHRoZSBjaGFubmVscyBjcmVhdGVkIHNvb24gYWZ0ZXIgY29ubmVjdGlvbiBnZXRzIHN0dWNrIGluXG4gICAgICAvLyB0aGUgY29ubmVjdGluZyByZWFkeVN0YXRlIGFuZCBuZXZlciBvcGVucy4gRXhwZXJpbWVudGFsbHksIHRoaXMgc2VlbXMgdG8gYmUgcm9idXN0LlxuICAgICAgLy9cbiAgICAgIC8vIE5vdGUgdG8gc2VsZjogSWYgaXQgc2hvdWxkIHR1cm4gb3V0IHRoYXQgd2Ugc3RpbGwgaGF2ZSBwcm9ibGVtcywgdHJ5IHNlcmlhbGl6aW5nIHRoZSBjYWxscyB0byBwZWVyLmNyZWF0ZURhdGFDaGFubmVsXG4gICAgICAvLyBzbyB0aGF0IHRoZXJlIGlzbid0IG1vcmUgdGhhbiBvbmUgY2hhbm5lbCBvcGVuaW5nIGF0IGEgdGltZS5cbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxMDApKTtcbiAgICB9IGVsc2UgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHRoaXMuc2lnbmFscyA9IHNpZ25hbHM7XG4gICAgfVxuICAgIGNvbnN0IHByb21pc2UgPSBhbGxvd090aGVyU2lkZVRvQ3JlYXRlID9cblx0ICB0aGlzLmdldERhdGFDaGFubmVsUHJvbWlzZShjaGFubmVsTmFtZSkgOlxuXHQgIHRoaXMuY3JlYXRlRGF0YUNoYW5uZWwoY2hhbm5lbE5hbWUsIG9wdGlvbnMpO1xuICAgIHJldHVybiBhd2FpdCBwcm9taXNlO1xuICB9XG59XG4iLCIvLyBuYW1lL3ZlcnNpb24gb2YgXCJkYXRhYmFzZVwiXG5leHBvcnQgY29uc3Qgc3RvcmFnZU5hbWUgPSAnZmxleHN0b3JlJztcbmV4cG9ydCBjb25zdCBzdG9yYWdlVmVyc2lvbiA9IDExO1xuXG5pbXBvcnQgKiBhcyBwa2cgZnJvbSBcIi4uL3BhY2thZ2UuanNvblwiIHdpdGggeyB0eXBlOiAnanNvbicgfTtcbmV4cG9ydCBjb25zdCB7bmFtZSwgdmVyc2lvbn0gPSBwa2cuZGVmYXVsdDtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB7IHRhZ1BhdGggfSBmcm9tICcuL3RhZ1BhdGgubWpzJztcbmltcG9ydCB7IFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vd2VicnRjLm1qcyc7XG5pbXBvcnQgeyBzdG9yYWdlVmVyc2lvbiB9IGZyb20gJy4vdmVyc2lvbi5tanMnO1xuXG4vKlxuICBSZXNwb25zaWJsZSBmb3Iga2VlcGluZyBhIGNvbGxlY3Rpb24gc3luY2hyb25pemVkIHdpdGggYW5vdGhlciBwZWVyLlxuICAoUGVlcnMgbWF5IGJlIGEgY2xpZW50IG9yIGEgc2VydmVyL3JlbGF5LiBJbml0aWFsbHkgdGhpcyBpcyB0aGUgc2FtZSBjb2RlIGVpdGhlciB3YXksXG4gIGJ1dCBsYXRlciBvbiwgb3B0aW1pemF0aW9ucyBjYW4gYmUgbWFkZSBmb3Igc2NhbGUuKVxuXG4gIEFzIGxvbmcgYXMgdHdvIHBlZXJzIGFyZSBjb25uZWN0ZWQgd2l0aCBhIFN5bmNocm9uaXplciBvbiBlYWNoIHNpZGUsIHdyaXRpbmcgaGFwcGVuc1xuICBpbiBib3RoIHBlZXJzIGluIHJlYWwgdGltZSwgYW5kIHJlYWRpbmcgcHJvZHVjZXMgdGhlIGNvcnJlY3Qgc3luY2hyb25pemVkIHJlc3VsdCBmcm9tIGVpdGhlci5cbiAgVW5kZXIgdGhlIGhvb2QsIHRoZSBzeW5jaHJvbml6ZXIga2VlcHMgdHJhY2sgb2Ygd2hhdCBpdCBrbm93cyBhYm91dCB0aGUgb3RoZXIgcGVlciAtLVxuICBhIHBhcnRpY3VsYXIgdGFnIGNhbiBiZSB1bmtub3duLCB1bnN5bmNocm9uaXplZCwgb3Igc3luY2hyb25pemVkLCBhbmQgcmVhZGluZyB3aWxsXG4gIGNvbW11bmljYXRlIGFzIG5lZWRlZCB0byBnZXQgdGhlIGRhdGEgc3luY2hyb25pemVkIG9uLWRlbWFuZC4gTWVhbndoaWxlLCBzeW5jaHJvbml6YXRpb25cbiAgY29udGludWVzIGluIHRoZSBiYWNrZ3JvdW5kIHVudGlsIHRoZSBjb2xsZWN0aW9uIGlzIGZ1bGx5IHJlcGxpY2F0ZWQuXG5cbiAgQSBjb2xsZWN0aW9uIG1haW50YWlucyBhIHNlcGFyYXRlIFN5bmNocm9uaXplciBmb3IgZWFjaCBvZiB6ZXJvIG9yIG1vcmUgcGVlcnMsIGFuZCBjYW4gZHluYW1pY2FsbHlcbiAgYWRkIGFuZCByZW1vdmUgbW9yZS5cblxuICBOYW1pbmcgY29udmVudGlvbnM6XG5cbiAgbXVtYmxlTmFtZTogYSBzZW1hbnRpYyBuYW1lIHVzZWQgZXh0ZXJuYWxseSBhcyBhIGtleS4gRXhhbXBsZTogc2VydmljZU5hbWUsIGNoYW5uZWxOYW1lLCBldGMuXG4gICAgV2hlbiB0aGluZ3MgbmVlZCB0byBtYXRjaCB1cCBhY3Jvc3Mgc3lzdGVtcywgaXQgaXMgYnkgbmFtZS5cbiAgICBJZiBvbmx5IG9uZSBvZiBuYW1lL2xhYmVsIGlzIHNwZWNpZmllZCwgdGhpcyBpcyB1c3VhbGx5IHRoZSB0aGUgb25lLlxuXG4gIG11bWJsZUxhYmVsOiBhIGxhYmVsIGZvciBpZGVudGlmaWNhdGlvbiBhbmQgaW50ZXJuYWxseSAoZS5nLiwgZGF0YWJhc2UgbmFtZSkuXG4gICAgV2hlbiB0d28gaW5zdGFuY2VzIG9mIHNvbWV0aGluZyBhcmUgXCJ0aGUgc2FtZVwiIGJ1dCBhcmUgaW4gdGhlIHNhbWUgSmF2YXNjcmlwdCBpbWFnZSBmb3IgdGVzdGluZywgdGhleSBhcmUgZGlzdGluZ3Vpc2hlZCBieSBsYWJlbC5cbiAgICBUeXBpY2FsbHkgZGVmYXVsdHMgdG8gbXVtYmxlTmFtZS5cblxuICBOb3RlLCB0aG91Z2gsIHRoYXQgc29tZSBleHRlcm5hbCBtYWNoaW5lcnkgKHN1Y2ggYXMgYSBXZWJSVEMgRGF0YUNoYW5uZWwpIGhhcyBhIFwibGFiZWxcIiBwcm9wZXJ0eSB0aGF0IHdlIHBvcHVsYXRlIHdpdGggYSBcIm5hbWVcIiAoY2hhbm5lbE5hbWUpLlxuICovXG5leHBvcnQgY2xhc3MgU3luY2hyb25pemVyIHtcbiAgc3RhdGljIHZlcnNpb24gPSBzdG9yYWdlVmVyc2lvbjtcbiAgY29uc3RydWN0b3Ioe3NlcnZpY2VOYW1lID0gJ2RpcmVjdCcsIGNvbGxlY3Rpb24sIGVycm9yID0gY29sbGVjdGlvbj8uY29uc3RydWN0b3IuZXJyb3IgfHwgY29uc29sZS5lcnJvcixcblx0ICAgICAgIHNlcnZpY2VMYWJlbCA9IGNvbGxlY3Rpb24/LnNlcnZpY2VMYWJlbCB8fCBzZXJ2aWNlTmFtZSwgLy8gVXNlZCB0byBpZGVudGlmeSBhbnkgZXhpc3RpbmcgY29ubmVjdGlvbi4gQ2FuIGJlIGRpZmZlcmVudCBmcm9tIHNlcnZpY2VOYW1lIGR1cmluZyB0ZXN0aW5nLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHV1aWQgPSBjb2xsZWN0aW9uPy51dWlkLCBydGNDb25maWd1cmF0aW9uLCBjb25uZWN0aW9uLCAvLyBDb21wbGV4IGRlZmF1bHQgYmVoYXZpb3IgZm9yIHRoZXNlLiBTZWUgY29kZS5cblx0ICAgICAgIG11bHRpcGxleCA9IGNvbGxlY3Rpb24/Lm11bHRpcGxleCwgLy8gSWYgc3BlY2lmZWQsIG90aGVyd2lzZSB1bmRlZmluZWQgYXQgdGhpcyBwb2ludC4gU2VlIGJlbG93LlxuXHQgICAgICAgZGVidWcgPSBjb2xsZWN0aW9uPy5kZWJ1ZywgbWF4VmVyc2lvbiA9IFN5bmNocm9uaXplci52ZXJzaW9uLCBtaW5WZXJzaW9uID0gbWF4VmVyc2lvbn0pIHtcbiAgICAvLyBzZXJ2aWNlTmFtZSBpcyBhIHN0cmluZyBvciBvYmplY3QgdGhhdCBpZGVudGlmaWVzIHdoZXJlIHRoZSBzeW5jaHJvbml6ZXIgc2hvdWxkIGNvbm5lY3QuIEUuZy4sIGl0IG1heSBiZSBhIFVSTCBjYXJyeWluZ1xuICAgIC8vICAgV2ViUlRDIHNpZ25hbGluZy4gSXQgc2hvdWxkIGJlIGFwcC11bmlxdWUgZm9yIHRoaXMgcGFydGljdWxhciBzZXJ2aWNlIChlLmcuLCB3aGljaCBtaWdodCBtdWx0aXBsZXggZGF0YSBmb3IgbXVsdGlwbGUgY29sbGVjdGlvbiBpbnN0YW5jZXMpLlxuICAgIC8vIHV1aWQgaGVscCB1bmlxdWVseSBpZGVudGlmaWVzIHRoaXMgcGFydGljdWxhciBzeW5jaHJvbml6ZXIuXG4gICAgLy8gICBGb3IgbW9zdCBwdXJwb3NlcywgdXVpZCBzaG91bGQgZ2V0IHRoZSBkZWZhdWx0LCBhbmQgcmVmZXJzIHRvIE9VUiBlbmQuXG4gICAgLy8gICBIb3dldmVyLCBhIHNlcnZlciB0aGF0IGNvbm5lY3RzIHRvIGEgYnVuY2ggb2YgcGVlcnMgbWlnaHQgYmFzaCBpbiB0aGUgdXVpZCB3aXRoIHRoYXQgb2YgdGhlIG90aGVyIGVuZCwgc28gdGhhdCBsb2dnaW5nIGluZGljYXRlcyB0aGUgY2xpZW50LlxuICAgIC8vIElmIGNoYW5uZWxOYW1lIGlzIHNwZWNpZmllZCwgaXQgc2hvdWxkIGJlIGluIHRoZSBmb3JtIG9mIGNvbGxlY3Rpb25UeXBlL2NvbGxlY3Rpb25OYW1lIChlLmcuLCBpZiBjb25uZWN0aW5nIHRvIHJlbGF5KS5cbiAgICBjb25zdCBjb25uZWN0VGhyb3VnaEludGVybmV0ID0gc2VydmljZU5hbWUuc3RhcnRzV2l0aD8uKCdodHRwJyk7XG4gICAgaWYgKCFjb25uZWN0VGhyb3VnaEludGVybmV0ICYmIChydGNDb25maWd1cmF0aW9uID09PSB1bmRlZmluZWQpKSBydGNDb25maWd1cmF0aW9uID0ge307IC8vIEV4cGljaXRseSBubyBpY2UuIExBTiBvbmx5LlxuICAgIC8vIG11bHRpcGxleCBzaG91bGQgZW5kIHVwIHdpdGggb25lIG9mIHRocmVlIHZhbHVlczpcbiAgICAvLyBmYWxzeSAtIGEgbmV3IGNvbm5lY3Rpb24gc2hvdWxkIGJlIHVzZWQgZm9yIGVhY2ggY2hhbm5lbFxuICAgIC8vIFwibmVnb3RpYXRlZFwiIC0gYm90aCBzaWRlcyBjcmVhdGUgdGhlIHNhbWUgY2hhbm5lbE5hbWVzIGluIHRoZSBzYW1lIG9yZGVyIChtb3N0IGNhc2VzKTpcbiAgICAvLyAgICAgVGhlIGluaXRpYWwgc2lnbmFsbGluZyB3aWxsIGJlIHRyaWdnZXJlZCBieSBvbmUgc2lkZSBjcmVhdGluZyBhIGNoYW5uZWwsIGFuZCB0aGVyIHNpZGUgd2FpdGluZyBmb3IgaXQgdG8gYmUgY3JlYXRlZC5cbiAgICAvLyAgICAgQWZ0ZXIgdGhhdCwgYm90aCBzaWRlcyB3aWxsIGV4cGxpY2l0bHkgY3JlYXRlIGEgZGF0YSBjaGFubmVsIGFuZCB3ZWJydGMgd2lsbCBtYXRjaCB0aGVtIHVwIGJ5IGlkLlxuICAgIC8vIGFueSBvdGhlciB0cnV0aHkgLSBTdGFydHMgbGlrZSBuZWdvdGlhdGVkLCBhbmQgdGhlbiBjb250aW51ZXMgd2l0aCBvbmx5IHdpZGUgc2lkZSBjcmVhdGluZyB0aGUgY2hhbm5lbHMsIGFuZCB0aGVyIG90aGVyXG4gICAgLy8gICAgIG9ic2VydmVzIHRoZSBjaGFubmVsIHRoYXQgaGFzIGJlZW4gbWFkZS4gVGhpcyBpcyB1c2VkIGZvciByZWxheXMuXG4gICAgbXVsdGlwbGV4ID8/PSBjb25uZWN0aW9uPy5tdWx0aXBsZXg7IC8vIFN0aWxsIHR5cGljYWxseSB1bmRlZmluZWQgYXQgdGhpcyBwb2ludC5cbiAgICBtdWx0aXBsZXggPz89IChzZXJ2aWNlTmFtZS5pbmNsdWRlcz8uKCcvc3luYycpIHx8ICduZWdvdGlhdGVkJyk7XG4gICAgY29ubmVjdGlvbiA/Pz0gU2hhcmVkV2ViUlRDLmVuc3VyZSh7c2VydmljZUxhYmVsLCBjb25maWd1cmF0aW9uOiBydGNDb25maWd1cmF0aW9uLCBtdWx0aXBsZXgsIHV1aWQsIGRlYnVnLCBlcnJvcn0pO1xuXG4gICAgdXVpZCA/Pz0gY29ubmVjdGlvbi51dWlkO1xuICAgIC8vIEJvdGggcGVlcnMgbXVzdCBhZ3JlZSBvbiBjaGFubmVsTmFtZS4gVXN1YWxseSwgdGhpcyBpcyBjb2xsZWN0aW9uLmZ1bGxOYW1lLiBCdXQgaW4gdGVzdGluZywgd2UgbWF5IHN5bmMgdHdvIGNvbGxlY3Rpb25zIHdpdGggZGlmZmVyZW50IG5hbWVzLlxuICAgIGNoYW5uZWxOYW1lID8/PSBjb2xsZWN0aW9uPy5jaGFubmVsTmFtZSB8fCBjb2xsZWN0aW9uLmZ1bGxOYW1lO1xuICAgIGNvbnN0IGxhYmVsID0gYCR7Y29sbGVjdGlvbj8uZnVsbExhYmVsIHx8IGNoYW5uZWxOYW1lfS8ke3V1aWR9YDtcbiAgICAvLyBXaGVyZSB3ZSBjYW4gcmVxdWVzdCBhIGRhdGEgY2hhbm5lbCB0aGF0IHB1c2hlcyBwdXQvZGVsZXRlIHJlcXVlc3RzIGZyb20gb3RoZXJzLlxuICAgIGNvbnN0IGNvbm5lY3Rpb25VUkwgPSBzZXJ2aWNlTmFtZS5pbmNsdWRlcz8uKCcvc2lnbmFsLycpID8gc2VydmljZU5hbWUgOiBgJHtzZXJ2aWNlTmFtZX0vJHtsYWJlbH1gO1xuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7c2VydmljZU5hbWUsIGxhYmVsLCBjb2xsZWN0aW9uLCBkZWJ1ZywgZXJyb3IsIG1pblZlcnNpb24sIG1heFZlcnNpb24sIHV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sXG5cdFx0XHQgY29ubmVjdGlvbiwgdXVpZCwgY2hhbm5lbE5hbWUsIGNvbm5lY3Rpb25VUkwsXG5cdFx0XHQgY29ubmVjdGlvblN0YXJ0VGltZTogRGF0ZS5ub3coKSxcblx0XHRcdCBjbG9zZWQ6IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpLFxuXHRcdFx0IC8vIE5vdCB1c2VkIHlldCwgYnV0IGNvdWxkIGJlIHVzZWQgdG8gR0VUIHJlc291cmNlcyBvdmVyIGh0dHAgaW5zdGVhZCBvZiB0aHJvdWdoIHRoZSBkYXRhIGNoYW5uZWwuXG5cdFx0XHQgaG9zdFJlcXVlc3RCYXNlOiBjb25uZWN0VGhyb3VnaEludGVybmV0ICYmIGAke3NlcnZpY2VOYW1lLnJlcGxhY2UoL1xcLyhzeW5jfHNpZ25hbCkvKX0vJHtjaGFubmVsTmFtZX1gfSk7XG4gICAgY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5zZXQoc2VydmljZU5hbWUsIHRoaXMpOyAvLyBNdXN0IGJlIHNldCBzeW5jaHJvbm91c2x5LCBzbyB0aGF0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxIGtub3dzIHRvIHdhaXQuXG4gIH1cbiAgc3RhdGljIGFzeW5jIGNyZWF0ZShjb2xsZWN0aW9uLCBzZXJ2aWNlTmFtZSwgb3B0aW9ucyA9IHt9KSB7IC8vIFJlY2VpdmUgcHVzaGVkIG1lc3NhZ2VzIGZyb20gdGhlIGdpdmVuIHNlcnZpY2UuIGdldC9wdXQvZGVsZXRlIHdoZW4gdGhleSBjb21lICh3aXRoIGVtcHR5IHNlcnZpY2VzIGxpc3QpLlxuICAgIGNvbnN0IHN5bmNocm9uaXplciA9IG5ldyB0aGlzKHtjb2xsZWN0aW9uLCBzZXJ2aWNlTmFtZSwgLi4ub3B0aW9uc30pO1xuICAgIGNvbnN0IGNvbm5lY3RlZFByb21pc2UgPSBzeW5jaHJvbml6ZXIuY29ubmVjdENoYW5uZWwoKTsgLy8gRXN0YWJsaXNoIGNoYW5uZWwgY3JlYXRpb24gb3JkZXIuXG4gICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgY29ubmVjdGVkUHJvbWlzZTtcbiAgICBpZiAoIWNvbm5lY3RlZCkgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgICByZXR1cm4gYXdhaXQgY29ubmVjdGVkLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdENoYW5uZWwoKSB7IC8vIFN5bmNocm9ub3VzbHkgaW5pdGlhbGl6ZSBhbnkgcHJvbWlzZXMgdG8gY3JlYXRlIGEgZGF0YSBjaGFubmVsLCBhbmQgdGhlbiBhd2FpdCBjb25uZWN0aW9uLlxuICAgIGNvbnN0IHtob3N0UmVxdWVzdEJhc2UsIHV1aWQsIGNvbm5lY3Rpb24sIHNlcnZpY2VOYW1lfSA9IHRoaXM7XG4gICAgbGV0IHN0YXJ0ZWQgPSBjb25uZWN0aW9uLmhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGlmIChzdGFydGVkKSB7XG4gICAgICAvLyBXZSBhbHJlYWR5IGhhdmUgYSBjb25uZWN0aW9uLiBKdXN0IG9wZW4gYW5vdGhlciBkYXRhIGNoYW5uZWwgZm9yIG91ciB1c2UuXG4gICAgICBzdGFydGVkID0gdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgPSBjb25uZWN0aW9uLmVuc3VyZURhdGFDaGFubmVsKHRoaXMuY2hhbm5lbE5hbWUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc3luYycpKSB7IC8vIENvbm5lY3Qgd2l0aCBhIHNlcnZlciByZWxheS4gKFNpZ25hbCBhbmQgc3RheSBjb25uZWN0ZWQgdGhyb3VnaCBzeW5jLilcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmNvbm5lY3RTZXJ2ZXIoKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3NpZ25hbC9hbnN3ZXInKSkgeyAvLyBTZWVraW5nIGFuIGFuc3dlciB0byBhbiBvZmZlciB3ZSBQT1NUICh0byByZW5kZXZvdXMgd2l0aCBhIHBlZXIpLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpOyAvLyBKdXN0IGxpa2UgYSBzeW5jXG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zaWduYWwvb2ZmZXInKSkgeyAvLyBHRVQgYW4gb2ZmZXIgZnJvbSBhIHJlbmRldm91cyBwZWVyIGFuZCB0aGVuIFBPU1QgYW4gYW5zd2VyLlxuICAgICAgLy8gV2UgbXVzdCBzeWNocm9ub3VzbHkgc3RhcnRDb25uZWN0aW9uIG5vdyBzbyB0aGF0IG91ciBjb25uZWN0aW9uIGhhc1N0YXJ0ZWRDb25uZWN0aW5nLCBhbmQgYW55IHN1YnNlcXVlbnQgZGF0YSBjaGFubmVsXG4gICAgICAvLyByZXF1ZXN0cyBvbiB0aGUgc2FtZSBjb25uZWN0aW9uIHdpbGwgd2FpdCAodXNpbmcgdGhlICdzdGFydGVkJyBwYXRoLCBhYm92ZSkuXG4gICAgICAvLyBDb21wYXJlIGNvbm5lY3RTZXJ2ZXIsIHdoaWNoIGlzIGJhc2ljYWxseTpcbiAgICAgIC8vICAgc3RhcnRDb25uZWN0aW9uKCksIGZldGNoIHdpdGggdGhhdCBvZmZlciwgY29tcGxldGVDb25uZWN0aW9uIHdpdGggZmV0Y2hlZCBhbnN3ZXIuXG4gICAgICBjb25zdCBwcm9taXNlZFNpZ25hbHMgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbihbXSk7IC8vIEVzdGFibGlzaGluZyBvcmRlci5cbiAgICAgIGNvbnN0IHVybCA9IHRoaXMuY29ubmVjdGlvblVSTDtcbiAgICAgIGNvbnN0IG9mZmVyID0gYXdhaXQgdGhpcy5mZXRjaCh1cmwpO1xuICAgICAgY29uc3Qgb2sgPSB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbihvZmZlcik7IC8vIE5vdyBzdXBwbHkgdGhvc2Ugc2lnbmFscyBzbyB0aGF0IG91ciBjb25uZWN0aW9uIGNhbiBwcm9kdWNlIGFuc3dlciBzaWdhbHMuXG4gICAgICBjb25zdCBhbnN3ZXIgPSBhd2FpdCBwcm9taXNlZFNpZ25hbHM7XG4gICAgICBzdGFydGVkID0gdGhpcy5mZXRjaCh1cmwsIGFuc3dlcik7IC8vIFBPU1Qgb3VyIGFuc3dlciB0byBwZWVyLlxuICAgIH0gZWxzZSBpZiAoc2VydmljZU5hbWUgPT09ICdzaWduYWxzJykgeyAvLyBTdGFydCBjb25uZWN0aW9uIGFuZCByZXR1cm4gbnVsbC4gTXVzdCBiZSBjb250aW51ZWQgd2l0aCBjb21wbGV0ZVNpZ25hbHNTeW5jaHJvbml6YXRpb24oKTtcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbigpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHNlcnZpY2VOYW1lKSkgeyAvLyBBIGxpc3Qgb2YgXCJyZWNlaXZpbmdcIiBzaWduYWxzLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKHNlcnZpY2VOYW1lKTtcbiAgICB9IGVsc2UgaWYgKHNlcnZpY2VOYW1lLnN5bmNocm9uaXplcnMpIHsgLy8gRHVjayB0eXBpbmcgZm9yIHBhc3NpbmcgYSBjb2xsZWN0aW9uIGRpcmVjdGx5IGFzIHRoZSBzZXJ2aWNlSW5mby4gKFdlIGRvbid0IGltcG9ydCBDb2xsZWN0aW9uLilcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmNvbm5lY3REaXJlY3RUZXN0aW5nKHNlcnZpY2VOYW1lKTsgLy8gVXNlZCBpbiB0ZXN0aW5nLlxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVucmVjb2duaXplZCBzZXJ2aWNlIGZvcm1hdDogJHtzZXJ2aWNlTmFtZX0uYCk7XG4gICAgfVxuICAgIGlmICghKGF3YWl0IHN0YXJ0ZWQpKSB7XG4gICAgICBjb25zb2xlLndhcm4odGhpcy5sYWJlbCwgJ2Nvbm5lY3Rpb24gZmFpbGVkJyk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBsb2coLi4ucmVzdCkge1xuICAgIGlmICh0aGlzLmRlYnVnKSBjb25zb2xlLmxvZyh0aGlzLmxhYmVsLCAuLi5yZXN0KTtcbiAgfVxuICBnZXQgZGF0YUNoYW5uZWxQcm9taXNlKCkgeyAvLyBBIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhbiBvcGVuIGRhdGEgY2hhbm5lbC5cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy5fZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGlmICghcHJvbWlzZSkgdGhyb3cgbmV3IEVycm9yKGAke3RoaXMubGFiZWx9OiBEYXRhIGNoYW5uZWwgaXMgbm90IHlldCBwcm9taXNlZC5gKTtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICBjaGFubmVsQ2xvc2VkQ2xlYW51cCgpIHsgLy8gQm9va2tlZXBpbmcgd2hlbiBjaGFubmVsIGNsb3NlZCBvciBleHBsaWNpdGx5IGFiYW5kb25lZCBiZWZvcmUgb3BlbmluZy5cbiAgICB0aGlzLmNvbGxlY3Rpb24/LnN5bmNocm9uaXplcnMuZGVsZXRlKHRoaXMuc2VydmljZU5hbWUpO1xuICAgIHRoaXMuY2xvc2VkLnJlc29sdmUodGhpcyk7IC8vIFJlc29sdmUgdG8gc3luY2hyb25pemVyIGlzIG5pY2UgaWYsIGUuZywgc29tZW9uZSBpcyBQcm9taXNlLnJhY2luZy5cbiAgfVxuICBzZXQgZGF0YUNoYW5uZWxQcm9taXNlKHByb21pc2UpIHsgLy8gU2V0IHVwIG1lc3NhZ2UgYW5kIGNsb3NlIGhhbmRsaW5nLlxuICAgIHRoaXMuX2RhdGFDaGFubmVsUHJvbWlzZSA9IHByb21pc2UudGhlbihkYXRhQ2hhbm5lbCA9PiB7XG4gICAgICBkYXRhQ2hhbm5lbC5vbm1lc3NhZ2UgPSBldmVudCA9PiB0aGlzLnJlY2VpdmUoZXZlbnQuZGF0YSk7XG4gICAgICBkYXRhQ2hhbm5lbC5vbmNsb3NlID0gYXN5bmMgZXZlbnQgPT4gdGhpcy5jaGFubmVsQ2xvc2VkQ2xlYW51cCgpO1xuICAgICAgcmV0dXJuIGRhdGFDaGFubmVsO1xuICAgIH0pO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplKCkge1xuICAgIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuICBzdGF0aWMgZnJhZ21lbnRJZCA9IDA7XG4gIGFzeW5jIHNlbmQobWV0aG9kLCAuLi5wYXJhbXMpIHsgLy8gU2VuZHMgdG8gdGhlIHBlZXIsIG92ZXIgdGhlIGRhdGEgY2hhbm5lbFxuICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnN0cmluZ2lmeSh7bWV0aG9kLCBwYXJhbXN9KTtcbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGNvbnN0IHN0YXRlID0gZGF0YUNoYW5uZWw/LnJlYWR5U3RhdGUgfHwgJ2Nsb3NlZCc7XG4gICAgaWYgKHN0YXRlID09PSAnY2xvc2VkJyB8fCBzdGF0ZSA9PT0gJ2Nsb3NpbmcnKSByZXR1cm47XG4gICAgdGhpcy5sb2coJ3NlbmRzJywgbWV0aG9kLCAuLi5wYXJhbXMpO1xuICAgIGNvbnN0IHNpemUgPSAxNmUzOyAvLyBBIGJpdCBsZXNzIHRoYW4gMTYgKiAxMDI0LlxuICAgIGlmIChwYXlsb2FkLmxlbmd0aCA8IHNpemUpIHtcbiAgICAgIGRhdGFDaGFubmVsLnNlbmQocGF5bG9hZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIGJyZWFrIHVwIGxvbmcgbWVzc2FnZXMuIChBcyBhIHByYWN0aWNhbCBtYXR0ZXIsIDE2IEtpQiBpcyB0aGUgbG9uZ2VzdCB0aGF0IGNhbiByZWxpYWJseSBiZSBzZW50IGFjcm9zcyBkaWZmZXJlbnQgd3J0YyBpbXBsZW1lbnRhdGlvbnMuKVxuICAgIC8vIFNlZSBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvV2ViUlRDX0FQSS9Vc2luZ19kYXRhX2NoYW5uZWxzI2NvbmNlcm5zX3dpdGhfbGFyZ2VfbWVzc2FnZXNcbiAgICBjb25zdCBudW1DaHVua3MgPSBNYXRoLmNlaWwocGF5bG9hZC5sZW5ndGggLyBzaXplKTtcbiAgICBjb25zdCBpZCA9IHRoaXMuY29uc3RydWN0b3IuZnJhZ21lbnRJZCsrO1xuICAgIGNvbnN0IG1ldGEgPSB7bWV0aG9kOiAnZnJhZ21lbnRzJywgcGFyYW1zOiBbaWQsIG51bUNodW5rc119O1xuICAgIC8vY29uc29sZS5sb2coYEZyYWdtZW50aW5nIG1lc3NhZ2UgJHtpZH0gaW50byAke251bUNodW5rc30gY2h1bmtzLmAsIG1ldGEpO1xuICAgIGRhdGFDaGFubmVsLnNlbmQoSlNPTi5zdHJpbmdpZnkobWV0YSkpO1xuICAgIC8vIE9wdGltaXphdGlvbiBvcHBvcnR1bml0eTogcmVseSBvbiBtZXNzYWdlcyBiZWluZyBvcmRlcmVkIGFuZCBza2lwIHJlZHVuZGFudCBpbmZvLiBJcyBpdCB3b3J0aCBpdD9cbiAgICBmb3IgKGxldCBpID0gMCwgbyA9IDA7IGkgPCBudW1DaHVua3M7ICsraSwgbyArPSBzaXplKSB7XG4gICAgICBjb25zdCBmcmFnID0ge21ldGhvZDogJ2ZyYWcnLCBwYXJhbXM6IFtpZCwgaSwgcGF5bG9hZC5zdWJzdHIobywgc2l6ZSldfTtcbiAgICAgIGRhdGFDaGFubmVsLnNlbmQoSlNPTi5zdHJpbmdpZnkoZnJhZykpO1xuICAgIH1cbiAgfVxuICByZWNlaXZlKHRleHQpIHsgLy8gRGlzcGF0Y2ggYSBtZXNzYWdlIHNlbnQgb3ZlciB0aGUgZGF0YSBjaGFubmVsIGZyb20gdGhlIHBlZXIuXG4gICAgY29uc3Qge21ldGhvZCwgcGFyYW1zfSA9IEpTT04ucGFyc2UodGV4dCk7XG4gICAgdGhpc1ttZXRob2RdKC4uLnBhcmFtcyk7XG4gIH1cbiAgcGVuZGluZ0ZyYWdtZW50cyA9IHt9O1xuICBmcmFnbWVudHMoaWQsIG51bUNodW5rcykge1xuICAgIC8vY29uc29sZS5sb2coYFJlY2VpdmluZyBtZXNhZ2UgJHtpZH0gaW4gJHtudW1DaHVua3N9LmApO1xuICAgIHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF0gPSB7cmVtYWluaW5nOiBudW1DaHVua3MsIG1lc3NhZ2U6IEFycmF5KG51bUNodW5rcyl9O1xuICB9XG4gIGZyYWcoaWQsIGksIGZyYWdtZW50KSB7XG4gICAgbGV0IGZyYWcgPSB0aGlzLnBlbmRpbmdGcmFnbWVudHNbaWRdOyAvLyBXZSBhcmUgcmVseWluZyBvbiBmcmFnbWVudCBtZXNzYWdlIGNvbWluZyBmaXJzdC5cbiAgICBmcmFnLm1lc3NhZ2VbaV0gPSBmcmFnbWVudDtcbiAgICBpZiAoMCAhPT0gLS1mcmFnLnJlbWFpbmluZykgcmV0dXJuO1xuICAgIC8vY29uc29sZS5sb2coYERpc3BhdGNoaW5nIG1lc3NhZ2UgJHtpZH0uYCk7XG4gICAgdGhpcy5yZWNlaXZlKGZyYWcubWVzc2FnZS5qb2luKCcnKSk7XG4gICAgZGVsZXRlIHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF07XG4gIH1cblxuICBhc3luYyBkaXNjb25uZWN0KCkgeyAvLyBXYWl0IGZvciBkYXRhQ2hhbm5lbCB0byBkcmFpbiBhbmQgcmV0dXJuIGEgcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gYWN0dWFsbHkgY2xvc2VkLFxuICAgIC8vIGJ1dCByZXR1cm4gaW1tZWRpYXRlbHkgaWYgY29ubmVjdGlvbiBub3Qgc3RhcnRlZC5cbiAgICBpZiAodGhpcy5jb25uZWN0aW9uLnBlZXIuY29ubmVjdGlvblN0YXRlICE9PSAnY29ubmVjdGVkJykgcmV0dXJuIHRoaXMuY2hhbm5lbENsb3NlZENsZWFudXAodGhpcy5jb25uZWN0aW9uLmNsb3NlKCkpO1xuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgZGF0YUNoYW5uZWwuY2xvc2UoKTtcbiAgICByZXR1cm4gdGhpcy5jbG9zZWQ7XG4gIH1cbiAgLy8gVE9ETzogd2VicnRjIG5lZ290aWF0aW9uIG5lZWRlZCBkdXJpbmcgc3luYy5cbiAgLy8gVE9ETzogd2VicnRjIG5lZ290aWF0aW9uIG5lZWRlZCBhZnRlciBzeW5jLlxuICBzdGFydENvbm5lY3Rpb24oc2lnbmFsTWVzc2FnZXMpIHsgLy8gTWFjaGluZXJ5IGZvciBtYWtpbmcgYSBXZWJSVEMgY29ubmVjdGlvbiB0byB0aGUgcGVlcjpcbiAgICAvLyAgIElmIHNpZ25hbE1lc3NhZ2VzIGlzIGEgbGlzdCBvZiBbb3BlcmF0aW9uLCBtZXNzYWdlXSBtZXNzYWdlIG9iamVjdHMsIHRoZW4gdGhlIG90aGVyIHNpZGUgaXMgaW5pdGlhdGluZ1xuICAgIC8vIHRoZSBjb25uZWN0aW9uIGFuZCBoYXMgc2VudCBhbiBpbml0aWFsIG9mZmVyL2ljZS4gSW4gdGhpcyBjYXNlLCBzdGFydENvbm5lY3QoKSBwcm9taXNlcyBhIHJlc3BvbnNlXG4gICAgLy8gdG8gYmUgZGVsaXZlcmVkIHRvIHRoZSBvdGhlciBzaWRlLlxuICAgIC8vICAgT3RoZXJ3aXNlLCBzdGFydENvbm5lY3QoKSBwcm9taXNlcyBhIGxpc3Qgb2YgaW5pdGlhbCBzaWduYWwgbWVzc2FnZXMgdG8gYmUgZGVsaXZlcmVkIHRvIHRoZSBvdGhlciBzaWRlLFxuICAgIC8vIGFuZCBpdCBpcyBuZWNlc3NhcnkgdG8gdGhlbiBjYWxsIGNvbXBsZXRlQ29ubmVjdGlvbigpIHdpdGggdGhlIHJlc3BvbnNlIGZyb20gdGhlbS5cbiAgICAvLyBJbiBib3RoIGNhc2VzLCBhcyBhIHNpZGUgZWZmZWN0LCB0aGUgZGF0YUNoYW5uZWxQcm9taXNlIHByb3BlcnR5IHdpbGwgYmUgc2V0IHRvIGEgUHJvbWlzZVxuICAgIC8vIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIGRhdGEgY2hhbm5lbCB3aGVuIGl0IGlzIG9wZW5zLiBUaGlzIHByb21pc2UgaXMgdXNlZCBieSBzZW5kKCkgYW5kIHJlY2VpdmUoKS5cbiAgICBjb25zdCB7Y29ubmVjdGlvbn0gPSB0aGlzO1xuICAgIHRoaXMubG9nKHNpZ25hbE1lc3NhZ2VzID8gJ2dlbmVyYXRpbmcgYW5zd2VyJyA6ICdnZW5lcmF0aW5nIG9mZmVyJyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgPSBjb25uZWN0aW9uLmVuc3VyZURhdGFDaGFubmVsKHRoaXMuY2hhbm5lbE5hbWUsIHt9LCBzaWduYWxNZXNzYWdlcyk7XG4gICAgcmV0dXJuIGNvbm5lY3Rpb24uc2lnbmFscztcbiAgfVxuICBjb21wbGV0ZUNvbm5lY3Rpb24oc2lnbmFsTWVzc2FnZXMpIHsgLy8gRmluaXNoIHdoYXQgd2FzIHN0YXJ0ZWQgd2l0aCBzdGFydENvbGxlY3Rpb24uXG4gICAgLy8gRG9lcyBub3QgcmV0dXJuIGEgcHJvbWlzZS4gQ2xpZW50IGNhbiBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSB0byBzZWUgd2hlbiB3ZSBhcmUgYWN0dWFsbHkgY29ubmVjdGVkLlxuICAgIGlmICghc2lnbmFsTWVzc2FnZXMpIHJldHVybiBmYWxzZTtcbiAgICB0aGlzLmNvbm5lY3Rpb24uc2lnbmFscyA9IHNpZ25hbE1lc3NhZ2VzO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgc3RhdGljIGZldGNoSlNPTih1cmwsIGJvZHkgPSB1bmRlZmluZWQsIG1ldGhvZCA9IG51bGwpIHtcbiAgICBjb25zdCBoYXNCb2R5ID0gYm9keSAhPT0gdW5kZWZpbmVkO1xuICAgIG1ldGhvZCA/Pz0gaGFzQm9keSA/ICdQT1NUJyA6ICdHRVQnO1xuICAgIHJldHVybiBmZXRjaCh1cmwsIGhhc0JvZHkgPyB7bWV0aG9kLCBoZWFkZXJzOiB7XCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCJ9LCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KX0gOiB7bWV0aG9kfSlcbiAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcblx0aWYgKCFyZXNwb25zZS5vaykgdGhyb3cgbmV3IEVycm9yKGAke3Jlc3BvbnNlLnN0YXR1c1RleHQgfHwgJ0ZldGNoIGZhaWxlZCd9LCBjb2RlICR7cmVzcG9uc2Uuc3RhdHVzfSBpbiAke3VybH0uYCk7XG5cdHJldHVybiByZXNwb25zZS5qc29uKCk7XG4gICAgICB9KTtcbiAgfVxuICBhc3luYyBmZXRjaCh1cmwsIGJvZHkgPSB1bmRlZmluZWQpIHsgLy8gQXMgSlNPTlxuXG4gICAgY29uc3QgbWV0aG9kID0gYm9keSA/ICdQT1NUJyA6ICdHRVQnO1xuICAgIHRoaXMubG9nKCdmZXRjaCcsIG1ldGhvZCwgdXJsLCAnc2VuZGluZzonLCBib2R5KTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLmZldGNoSlNPTih1cmwsIGJvZHksIG1ldGhvZClcblx0ICAuY2F0Y2goZXJyb3IgPT4ge1xuXHQgICAgdGhpcy5jbG9zZWQucmVqZWN0KGVycm9yKTtcblx0ICB9KTtcbiAgICB0aGlzLmxvZygnZmV0Y2gnLCBtZXRob2QsIHVybCwgJ3Jlc3VsdDonLCByZXN1bHQpO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbiAgYXN5bmMgY29ubmVjdFNlcnZlcih1cmwgPSB0aGlzLmNvbm5lY3Rpb25VUkwpIHsgLy8gQ29ubmVjdCB0byBhIHJlbGF5IG92ZXIgaHR0cC4gKC9zeW5jIG9yIC9zaWduYWwvYW5zd2VyKVxuICAgIC8vIHN0YXJ0Q29ubmVjdGlvbiwgUE9TVCBvdXIgc2lnbmFscywgY29tcGxldGVDb25uZWN0aW9uIHdpdGggdGhlIHJlc3BvbnNlLlxuICAgIC8vIE91ciB3ZWJydGMgc3luY2hyb25pemVyIGlzIHRoZW4gY29ubmVjdGVkIHRvIHRoZSByZWxheSdzIHdlYnJ0IHN5bmNocm9uaXplci5cbiAgICBjb25zdCBvdXJTaWduYWxzUHJvbWlzZSA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7IC8vIG11c3QgYmUgc3luY2hyb25vdXMgdG8gcHJlc2VydmUgY2hhbm5lbCBpZCBvcmRlci5cbiAgICBjb25zdCBvdXJTaWduYWxzID0gYXdhaXQgb3VyU2lnbmFsc1Byb21pc2U7XG4gICAgY29uc3QgdGhlaXJTaWduYWxzID0gYXdhaXQgdGhpcy5mZXRjaCh1cmwsIG91clNpZ25hbHMpOyAvLyBQT1NUXG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVDb25uZWN0aW9uKHRoZWlyU2lnbmFscyk7XG4gIH1cbiAgYXN5bmMgY29tcGxldGVTaWduYWxzU3luY2hyb25pemF0aW9uKHNpZ25hbHMpIHsgLy8gR2l2ZW4gYW5zd2VyL2ljZSBzaWduYWxzLCBjb21wbGV0ZSB0aGUgY29ubmVjdGlvbiBhbmQgc3RhcnQgc3luY2hyb25pemUuXG4gICAgYXdhaXQgdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24oc2lnbmFscyk7XG4gICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZSgpO1xuICB9XG4gIGFzeW5jIGNvbm5lY3REaXJlY3RUZXN0aW5nKHBlZXJDb2xsZWN0aW9uKSB7IC8vIFVzZWQgaW4gdW5pdCB0ZXN0aW5nLCB3aGVyZSB0aGUgXCJyZW1vdGVcIiBzZXJ2aWNlIGlzIHNwZWNpZmllZCBkaXJlY3RseSAobm90IGEgc3RyaW5nKS5cbiAgICAvLyBFYWNoIGNvbGxlY3Rpb24gaXMgYXNrZWQgdG8gc3ljaHJvbml6ZSB0byBhbm90aGVyIGNvbGxlY3Rpb24uXG4gICAgY29uc3QgcGVlclN5bmNocm9uaXplciA9IHBlZXJDb2xsZWN0aW9uLnN5bmNocm9uaXplcnMuZ2V0KHRoaXMuY29sbGVjdGlvbik7XG4gICAgaWYgKCFwZWVyU3luY2hyb25pemVyKSB7IC8vIFRoZSBvdGhlciBzaWRlIGRvZXNuJ3Qga25vdyBhYm91dCB1cyB5ZXQuIFRoZSBvdGhlciBzaWRlIHdpbGwgZG8gdGhlIHdvcmsuXG4gICAgICB0aGlzLl9kZWxheSA9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCBvdXJTaWduYWxzID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTtcbiAgICBjb25zdCB0aGVpclNpZ25hbHMgPSBhd2FpdCBwZWVyU3luY2hyb25pemVyLnN0YXJ0Q29ubmVjdGlvbihhd2FpdCBvdXJTaWduYWxzKTtcbiAgICBwZWVyU3luY2hyb25pemVyLl9kZWxheS5yZXNvbHZlKCk7XG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVDb25uZWN0aW9uKHRoZWlyU2lnbmFscyk7XG4gIH1cblxuICAvLyBBIGNvbW1vbiBwcmFjdGljZSBoZXJlIGlzIHRvIGhhdmUgYSBwcm9wZXJ0eSB0aGF0IGlzIGEgcHJvbWlzZSBmb3IgaGF2aW5nIHNvbWV0aGluZyBkb25lLlxuICAvLyBBc3luY2hyb25vdXMgbWFjaGluZXJ5IGNhbiB0aGVuIHJlc29sdmUgaXQuXG4gIC8vIEFueXRoaW5nIHRoYXQgZGVwZW5kcyBvbiB0aGF0IGNhbiBhd2FpdCB0aGUgcmVzb2x2ZWQgdmFsdWUsIHdpdGhvdXQgd29ycnlpbmcgYWJvdXQgaG93IGl0IGdldHMgcmVzb2x2ZWQuXG4gIC8vIFdlIGNhY2hlIHRoZSBwcm9taXNlIHNvIHRoYXQgd2UgZG8gbm90IHJlcGV0ZWRseSB0cmlnZ2VyIHRoZSB1bmRlcmx5aW5nIGFjdGlvbi5cbiAgbWFrZVJlc29sdmVhYmxlUHJvbWlzZShpZ25vcmVkKSB7IC8vIEFuc3dlciBhIFByb21pc2UgdGhhdCBjYW4gYmUgcmVzb2x2ZSB3aXRoIHRoZVByb21pc2UucmVzb2x2ZSh2YWx1ZSkuXG4gICAgLy8gVGhlIGlnbm9yZWQgYXJndW1lbnQgaXMgYSBjb252ZW5pZW50IHBsYWNlIHRvIGNhbGwgc29tZXRoaW5nIGZvciBzaWRlLWVmZmVjdC5cbiAgICBsZXQgcmVzb2x2ZXIsIHJlamVjdGVyO1xuICAgIGNvbnN0IHByb21pc2UgPSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7IHJlc29sdmVyID0gcmVzb2x2ZTsgcmVqZWN0ZXIgPSByZWplY3Q7IH0pO1xuICAgIHByb21pc2UucmVzb2x2ZSA9IHJlc29sdmVyO1xuICAgIHByb21pc2UucmVqZWN0ID0gcmVqZWN0ZXI7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cblxuICBhc3luYyB2ZXJzaW9ucyhtaW4sIG1heCkgeyAvLyBPbiByZWNlaXZpbmcgdGhlIHZlcnNpb25zIHN1cHBvcnRlZCBieSB0aGUgdGhlIHBlZXIsIHJlc29sdmUgdGhlIHZlcnNpb24gcHJvbWlzZS5cbiAgICBsZXQgdmVyc2lvblByb21pc2UgPSB0aGlzLnZlcnNpb247XG4gICAgY29uc3QgY29tYmluZWRNYXggPSBNYXRoLm1pbihtYXgsIHRoaXMubWF4VmVyc2lvbik7XG4gICAgY29uc3QgY29tYmluZWRNaW4gPSBNYXRoLm1heChtaW4sIHRoaXMubWluVmVyc2lvbik7XG4gICAgaWYgKGNvbWJpbmVkTWF4ID49IGNvbWJpbmVkTWluKSByZXR1cm4gdmVyc2lvblByb21pc2UucmVzb2x2ZShjb21iaW5lZE1heCk7IC8vIE5vIG5lZWQgdG8gcmVzcG9uZCwgYXMgdGhleSB3aWxsIHByb2R1Y2UgdGhlIHNhbWUgZGV0ZXJtaW5pc3RpYyBhbnN3ZXIuXG4gICAgcmV0dXJuIHZlcnNpb25Qcm9taXNlLnJlc29sdmUoMCk7XG4gIH1cbiAgZ2V0IHZlcnNpb24oKSB7IC8vIFByb21pc2UgdGhlIGhpZ2hlc3QgdmVyc2lvbiBzdXBvcnRlZCBieSBib3RoIHNpZGVzLCBvciBkaXNjb25uZWN0IGFuZCBmYWxzeSBpZiBub25lLlxuICAgIC8vIFRlbGxzIHRoZSBvdGhlciBzaWRlIG91ciB2ZXJzaW9ucyBpZiB3ZSBoYXZlbid0IHlldCBkb25lIHNvLlxuICAgIC8vIEZJWE1FOiBjYW4gd2UgYXZvaWQgdGhpcyB0aW1lb3V0P1xuICAgIHJldHVybiB0aGlzLl92ZXJzaW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2Uoc2V0VGltZW91dCgoKSA9PiB0aGlzLnNlbmQoJ3ZlcnNpb25zJywgdGhpcy5taW5WZXJzaW9uLCB0aGlzLm1heFZlcnNpb24pLCAyMDApKTtcbiAgfVxuXG4gIGdldCBzdGFydGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiB3ZSBoYXZlIHN0YXJ0ZWQgc3luY2hyb25pemF0aW9uLlxuICAgIHJldHVybiB0aGlzLl9zdGFydGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLnN0YXJ0U3luY2hyb25pemF0aW9uKCk7XG4gIH1cbiAgZ2V0IGNvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBudW1iZXIgb2YgaXRlbXMgdGhhdCB3ZXJlIHRyYW5zZmVycmVkIChub3QgbmVjZXNzYXJpbGx5IHdyaXR0ZW4pLlxuICAgIC8vIFN0YXJ0cyBzeW5jaHJvbml6YXRpb24gaWYgaXQgaGFzbid0IGFscmVhZHkuIEUuZy4sIHdhaXRpbmcgb24gY29tcGxldGVkU3luY2hyb25pemF0aW9uIHdvbid0IHJlc29sdmUgdW50aWwgYWZ0ZXIgaXQgc3RhcnRzLlxuICAgIHJldHVybiB0aGlzLl9jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSh0aGlzLnN0YXJ0ZWRTeW5jaHJvbml6YXRpb24pO1xuICB9XG4gIGdldCBwZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG51bWJlciBvZiBpdGVtcyB0aGF0IHRoZSBwZWVyIHN5bmNocm9uaXplZC5cbiAgICByZXR1cm4gdGhpcy5fcGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCk7XG4gIH1cbiAgZ2V0IGJvdGhTaWRlc0NvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSByZXNvbHZlcyB0cnV0aHkgd2hlbiBib3RoIHNpZGVzIGFyZSBkb25lLlxuICAgIHJldHVybiB0aGlzLmNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi50aGVuKCgpID0+IHRoaXMucGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbik7XG4gIH1cbiAgYXN5bmMgcmVwb3J0Q29ubmVjdGlvbigpIHsgLy8gTG9nIGNvbm5lY3Rpb24gdGltZSBhbmQgdHlwZS5cbiAgICBjb25zdCBzdGF0cyA9IGF3YWl0IHRoaXMuY29ubmVjdGlvbi5wZWVyLmdldFN0YXRzKCk7XG4gICAgbGV0IHRyYW5zcG9ydDtcbiAgICBmb3IgKGNvbnN0IHJlcG9ydCBvZiBzdGF0cy52YWx1ZXMoKSkge1xuICAgICAgaWYgKHJlcG9ydC50eXBlID09PSAndHJhbnNwb3J0Jykge1xuXHR0cmFuc3BvcnQgPSByZXBvcnQ7XG5cdGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBsZXQgY2FuZGlkYXRlUGFpciA9IHRyYW5zcG9ydCAmJiBzdGF0cy5nZXQodHJhbnNwb3J0LnNlbGVjdGVkQ2FuZGlkYXRlUGFpcklkKTtcbiAgICBpZiAoIWNhbmRpZGF0ZVBhaXIpIHsgLy8gU2FmYXJpIGRvZXNuJ3QgZm9sbG93IHRoZSBzdGFuZGFyZC5cbiAgICAgIGZvciAoY29uc3QgcmVwb3J0IG9mIHN0YXRzLnZhbHVlcygpKSB7XG5cdGlmICgocmVwb3J0LnR5cGUgPT09ICdjYW5kaWRhdGUtcGFpcicpICYmIHJlcG9ydC5zZWxlY3RlZCkge1xuXHQgIGNhbmRpZGF0ZVBhaXIgPSByZXBvcnQ7XG5cdCAgYnJlYWs7XG5cdH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFjYW5kaWRhdGVQYWlyKSB7XG4gICAgICBjb25zb2xlLndhcm4odGhpcy5sYWJlbCwgJ2dvdCBzdGF0cyB3aXRob3V0IGNhbmRpZGF0ZVBhaXInLCBBcnJheS5mcm9tKHN0YXRzLnZhbHVlcygpKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlbW90ZSA9IHN0YXRzLmdldChjYW5kaWRhdGVQYWlyLnJlbW90ZUNhbmRpZGF0ZUlkKTtcbiAgICBjb25zdCB7cHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGV9ID0gcmVtb3RlO1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7c3RhdHMsIHRyYW5zcG9ydCwgY2FuZGlkYXRlUGFpciwgcmVtb3RlLCBwcm90b2NvbCwgY2FuZGlkYXRlVHlwZSwgc3luY2hyb25pemF0aW9uU3RhcnRUaW1lOiBub3d9KTtcbiAgICBjb25zb2xlLmluZm8odGhpcy5sYWJlbCwgJ2Nvbm5lY3RlZCcsIHByb3RvY29sLCBjYW5kaWRhdGVUeXBlLCAoKG5vdyAtIHRoaXMuY29ubmVjdGlvblN0YXJ0VGltZSkvMWUzKS50b0ZpeGVkKDEpKTtcbiAgfVxuICBhc3luYyBzdGFydFN5bmNocm9uaXphdGlvbigpIHsgLy8gV2FpdCBmb3IgYWxsIHByZWxpbWluYXJpZXMsIGFuZCBzdGFydCBzdHJlYW1pbmcgb3VyIHRhZ3MuXG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBpZiAoIWRhdGFDaGFubmVsKSB0aHJvdyBuZXcgRXJyb3IoYE5vIGNvbm5lY3Rpb24gZm9yICR7dGhpcy5sYWJlbH0uYCk7XG4gICAgLy8gTm93IHRoYXQgd2UgYXJlIGNvbm5lY3RlZCwgYW55IG5ldyB3cml0ZXMgb24gb3VyIGVuZCB3aWxsIGJlIHB1c2hlZCB0byB0aGUgcGVlci4gU28gY2FwdHVyZSB0aGUgaW5pdGlhbCB0YWdzIG5vdy5cbiAgICBjb25zdCBvdXJUYWdzID0gbmV3IFNldChhd2FpdCB0aGlzLmNvbGxlY3Rpb24udGFncyk7XG4gICAgYXdhaXQgdGhpcy5yZXBvcnRDb25uZWN0aW9uKCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cbiAgICAgIC8vIEEgc25hcHNob3QgU2V0IG9mIGVhY2ggdGFnIHdlIGhhdmUgbG9jYWxseSwgY2FwdHVyZWQgYXQgdGhlIG1vbWVudCBvZiBjcmVhdGlvbi5cbiAgICAgIG91clRhZ3MsIC8vIChOZXcgbG9jYWwgd3JpdGVzIGFyZSBwdXNoZWQgdG8gdGhlIGNvbm5lY3RlZCBwZWVyLCBldmVuIGR1cmluZyBzeW5jaHJvbml6YXRpb24uKVxuXG4gICAgICAvLyBNYXAgb2YgdGFnIHRvIHByb21pc2UgZm9yIHRhZ3MgdGhhdCBhcmUgYmVpbmcgc3luY2hyb25pemVkLlxuICAgICAgLy8gZW5zdXJlU3luY2hyb25pemVkVGFnIGVuc3VyZXMgdGhhdCB0aGVyZSBpcyBhbiBlbnRyeSBoZXJlIGR1cmluZyB0aGUgdGltZSBhIHRhZyBpcyBpbiBmbGlnaHQuXG4gICAgICB1bnN5bmNocm9uaXplZDogbmV3IE1hcCgpLFxuXG4gICAgICAvLyBTZXQgb2Ygd2hhdCB0YWdzIGhhdmUgYmVlbiBleHBsaWNpdGx5IHN5bmNocm9uaXplZCwgbWVhbmluZyB0aGF0IHRoZXJlIGlzIGEgZGlmZmVyZW5jZSBiZXR3ZWVuIHRoZWlyIGhhc2hcbiAgICAgIC8vIGFuZCBvdXJzLCBzdWNoIHRoYXQgd2UgYXNrIGZvciB0aGVpciBzaWduYXR1cmUgdG8gY29tcGFyZSBpbiBkZXRhaWwuIFRodXMgdGhpcyBzZXQgbWF5IGluY2x1ZGUgaXRlbXMgdGhhdFxuICAgICAgY2hlY2tlZFRhZ3M6IG5ldyBTZXQoKSwgLy8gd2lsbCBub3QgZW5kIHVwIGJlaW5nIHJlcGxhY2VkIG9uIG91ciBlbmQuXG5cbiAgICAgIGVuZE9mUGVlclRhZ3M6IGZhbHNlIC8vIElzIHRoZSBwZWVyIGZpbmlzaGVkIHN0cmVhbWluZz9cbiAgICB9KTtcbiAgICAvLyBOb3cgbmVnb3RpYXRlIHZlcnNpb24gYW5kIGNvbGxlY3RzIHRoZSB0YWdzLlxuICAgIGNvbnN0IHZlcnNpb24gPSBhd2FpdCB0aGlzLnZlcnNpb247XG4gICAgaWYgKCF2ZXJzaW9uKSB7ICAvLyBNaXNtYXRjaC5cbiAgICAgIC8vIEtsdWRnZSAxOiB3aHkgZG9lc24ndCB0aGlzLmRpc2Nvbm5lY3QoKSBjbGVhbiB1cCB0aGUgdmFyaW91cyBwcm9taXNlcyBwcm9wZXJseT9cbiAgICAgIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlLnRoZW4oY2hhbm5lbCA9PiBjaGFubmVsLmNsb3NlKCkpO1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGAke3RoaXMuc2VydmljZU5hbWV9IGRvZXMgbm90IHVzZSBhIGNvbXBhdGlibGUgdmVyc2lvbi5gO1xuICAgICAgY29uc29sZS5lcnJvcihtZXNzYWdlLCB0aGlzLmNvbm5lY3Rpb24ubm90aWZpZWQpO1xuICAgICAgaWYgKCh0eXBlb2Yod2luZG93KSAhPT0gJ3VuZGVmaW5lZCcpICYmICF0aGlzLmNvbm5lY3Rpb24ubm90aWZpZWQpIHsgLy8gSWYgd2UncmUgaW4gYSBicm93c2VyLCB0ZWxsIHRoZSB1c2VyIG9uY2UuXG5cdHRoaXMuY29ubmVjdGlvbi5ub3RpZmllZCA9IHRydWU7XG5cdHdpbmRvdy5hbGVydChtZXNzYWdlKTtcblx0c2V0VGltZW91dCgoKSA9PiBkZWxldGUgdGhpcy5jb25uZWN0aW9uLm5vdGlmaWVkLCAxMCk7IC8vIEtsdWRnZSAyLlxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbVRhZ3Mob3VyVGFncyk7IC8vIEJ1dCBkbyBub3Qgd2FpdCBmb3IgaXQuXG4gIH1cbiAgYXN5bmMgY29tcHV0ZUhhc2godGV4dCkgeyAvLyBPdXIgc3RhbmRhcmQgaGFzaC4gKFN0cmluZyBzbyB0aGF0IGl0IGlzIHNlcmlhbGl6YWJsZS4pXG4gICAgY29uc3QgaGFzaCA9IGF3YWl0IENyZWRlbnRpYWxzLmhhc2hUZXh0KHRleHQpO1xuICAgIHJldHVybiBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoaGFzaCk7XG4gIH1cbiAgYXN5bmMgZ2V0SGFzaCh0YWcpIHsgLy8gV2hvbGUgc2lnbmF0dXJlIChOT1QgcHJvdGVjdGVkSGVhZGVyLnN1YiBvZiBjb250ZW50KS5cbiAgICBjb25zdCByYXcgPSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gICAgcmV0dXJuIHRoaXMuY29tcHV0ZUhhc2gocmF3IHx8ICdtaXNzaW5nJyk7XG4gIH1cbiAgYXN5bmMgc3RyZWFtVGFncyh0YWdzKSB7IC8vIFNlbmQgZWFjaCBvZiBvdXIga25vd24gdGFnL2hhc2ggcGFpcnMgdG8gcGVlciwgb25lIGF0IGEgdGltZSwgZm9sbG93ZWQgYnkgZW5kT2ZUYWdzLlxuICAgIGZvciAoY29uc3QgdGFnIG9mIHRhZ3MpIHtcbiAgICAgIHRoaXMuc2VuZCgnaGFzaCcsIHRhZywgYXdhaXQgdGhpcy5nZXRIYXNoKHRhZykpO1xuICAgIH1cbiAgICB0aGlzLnNlbmQoJ2VuZFRhZ3MnKTtcbiAgfVxuICBhc3luYyBlbmRUYWdzKCkgeyAvLyBUaGUgcGVlciBoYXMgZmluaXNoZWQgc3RyZWFtVGFncygpLlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICB0aGlzLmVuZE9mUGVlclRhZ3MgPSB0cnVlO1xuICAgIHRoaXMuY2xlYW5VcElmRmluaXNoZWQoKTtcbiAgfVxuICBzeW5jaHJvbml6YXRpb25Db21wbGV0ZShuQ2hlY2tlZCkgeyAvLyBUaGUgcGVlciBoYXMgZmluaXNoZWQgZ2V0dGluZyBhbGwgdGhlIGRhdGEgaXQgbmVlZHMgZnJvbSB1cy5cbiAgICB0aGlzLnBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24ucmVzb2x2ZShuQ2hlY2tlZCk7XG4gIH1cbiAgY2xlYW5VcElmRmluaXNoZWQoKSB7IC8vIElmIHdlIGFyZSBub3Qgd2FpdGluZyBmb3IgYW55dGhpbmcsIHdlJ3JlIGRvbmUuIENsZWFuIHVwLlxuICAgIC8vIFRoaXMgcmVxdWlyZXMgdGhhdCB0aGUgcGVlciBoYXMgaW5kaWNhdGVkIHRoYXQgaXQgaXMgZmluaXNoZWQgc3RyZWFtaW5nIHRhZ3MsXG4gICAgLy8gYW5kIHRoYXQgd2UgYXJlIG5vdCB3YWl0aW5nIGZvciBhbnkgZnVydGhlciB1bnN5bmNocm9uaXplZCBpdGVtcy5cbiAgICBpZiAoIXRoaXMuZW5kT2ZQZWVyVGFncyB8fCB0aGlzLnVuc3luY2hyb25pemVkLnNpemUpIHJldHVybjtcbiAgICBjb25zdCBuQ2hlY2tlZCA9IHRoaXMuY2hlY2tlZFRhZ3Muc2l6ZTsgLy8gVGhlIG51bWJlciB0aGF0IHdlIGNoZWNrZWQuXG4gICAgdGhpcy5zZW5kKCdzeW5jaHJvbml6YXRpb25Db21wbGV0ZScsIG5DaGVja2VkKTtcbiAgICB0aGlzLmNoZWNrZWRUYWdzLmNsZWFyKCk7XG4gICAgdGhpcy51bnN5bmNocm9uaXplZC5jbGVhcigpO1xuICAgIHRoaXMub3VyVGFncyA9IHRoaXMuc3luY2hyb25pemVkID0gdGhpcy51bnN5bmNocm9uaXplZCA9IG51bGw7XG4gICAgY29uc29sZS5pbmZvKHRoaXMubGFiZWwsICdjb21wbGV0ZWQgc3luY2hyb25pemF0aW9uJywgbkNoZWNrZWQsICdpdGVtcyBpbicsICgoRGF0ZS5ub3coKSAtIHRoaXMuc3luY2hyb25pemF0aW9uU3RhcnRUaW1lKS8xZTMpLnRvRml4ZWQoMSksICdzZWNvbmRzJyk7XG4gICAgdGhpcy5jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24ucmVzb2x2ZShuQ2hlY2tlZCk7XG4gIH1cbiAgc3luY2hyb25pemF0aW9uUHJvbWlzZSh0YWcpIHsgLy8gUmV0dXJuIHNvbWV0aGluZyB0byBhd2FpdCB0aGF0IHJlc29sdmVzIHdoZW4gdGFnIGlzIHN5bmNocm9uaXplZC5cbiAgICAvLyBXaGVuZXZlciBhIGNvbGxlY3Rpb24gbmVlZHMgdG8gcmV0cmlldmUgKGdldFZlcmlmaWVkKSBhIHRhZyBvciBmaW5kIHRhZ3MgbWF0Y2hpbmcgcHJvcGVydGllcywgaXQgZW5zdXJlc1xuICAgIC8vIHRoZSBsYXRlc3QgZGF0YSBieSBjYWxsaW5nIHRoaXMgYW5kIGF3YWl0aW5nIHRoZSBkYXRhLlxuICAgIGlmICghdGhpcy51bnN5bmNocm9uaXplZCkgcmV0dXJuIHRydWU7IC8vIFdlIGhhdmUgZnVsbHkgc3luY2hyb25pemVkIGFsbCB0YWdzLiBJZiB0aGVyZSBpcyBuZXcgZGF0YSwgaXQgd2lsbCBiZSBzcG9udGFuZW91c2x5IHB1c2hlZCB0byB1cy5cbiAgICBpZiAodGhpcy5jaGVja2VkVGFncy5oYXModGFnKSkgcmV0dXJuIHRydWU7IC8vIFRoaXMgcGFydGljdWxhciB0YWcgaGFzIGJlZW4gY2hlY2tlZC5cbiAgICAvLyAoSWYgY2hlY2tlZFRhZ3Mgd2FzIG9ubHkgdGhvc2UgZXhjaGFuZ2VkIG9yIHdyaXR0ZW4sIHdlIHdvdWxkIGhhdmUgZXh0cmEgZmxpZ2h0cyBjaGVja2luZy4pXG4gICAgLy8gSWYgYSByZXF1ZXN0IGlzIGluIGZsaWdodCwgcmV0dXJuIHRoYXQgcHJvbWlzZS4gT3RoZXJ3aXNlIGNyZWF0ZSBvbmUuXG4gICAgcmV0dXJuIHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZykgfHwgdGhpcy5lbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCAnJywgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG5cbiAgYXN5bmMgaGFzaCh0YWcsIGhhc2gpIHsgLy8gUmVjZWl2ZSBhIFt0YWcsIGhhc2hdIHRoYXQgdGhlIHBlZXIga25vd3MgYWJvdXQuIChQZWVyIHN0cmVhbXMgemVybyBvciBtb3JlIG9mIHRoZXNlIHRvIHVzLilcbiAgICAvLyBVbmxlc3MgYWxyZWFkeSBpbiBmbGlnaHQsIHdlIHdpbGwgZW5zdXJlU3luY2hyb25pemVkVGFnIHRvIHN5bmNocm9uaXplIGl0LlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICBjb25zdCB7b3VyVGFncywgdW5zeW5jaHJvbml6ZWR9ID0gdGhpcztcbiAgICB0aGlzLmxvZygncmVjZWl2ZWQgXCJoYXNoXCInLCB7dGFnLCBoYXNoLCBvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0pO1xuICAgIGlmICh1bnN5bmNocm9uaXplZC5oYXModGFnKSkgcmV0dXJuIG51bGw7IC8vIEFscmVhZHkgaGFzIGFuIGludmVzdGlnYXRpb24gaW4gcHJvZ3Jlc3MgKGUuZywgZHVlIHRvIGxvY2FsIGFwcCBzeW5jaHJvbml6YXRpb25Qcm9taXNlKS5cbiAgICBpZiAoIW91clRhZ3MuaGFzKHRhZykpIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gpOyAvLyBXZSBkb24ndCBoYXZlIHRoZSByZWNvcmQgYXQgYWxsLlxuICAgIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gsIHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgfVxuICBlbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCB0aGVpckhhc2ggPSAnJywgb3VySGFzaFByb21pc2UgPSBudWxsKSB7XG4gICAgLy8gU3luY2hyb25vdXNseSByZWNvcmQgKGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXApIGEgcHJvbWlzZSB0byAoY29uY2VwdHVhbGx5KSByZXF1ZXN0IHRoZSB0YWcgZnJvbSB0aGUgcGVlcixcbiAgICAvLyBwdXQgaXQgaW4gdGhlIGNvbGxlY3Rpb24sIGFuZCBjbGVhbnVwIHRoZSBib29ra2VlcGluZy4gUmV0dXJuIHRoYXQgcHJvbWlzZS5cbiAgICAvLyBIb3dldmVyLCBpZiB3ZSBhcmUgZ2l2ZW4gaGFzaGVzIHRvIGNvbXBhcmUgYW5kIHRoZXkgbWF0Y2gsIHdlIGNhbiBza2lwIHRoZSByZXF1ZXN0L3B1dCBhbmQgcmVtb3ZlIGZyb20gdW5zeWNocm9uaXplZCBvbiBuZXh0IHRpY2suXG4gICAgLy8gKFRoaXMgbXVzdCByZXR1cm4gYXRvbWljYWxseSBiZWNhdXNlIGNhbGxlciBoYXMgY2hlY2tlZCB2YXJpb3VzIGJvb2trZWVwaW5nIGF0IHRoYXQgbW9tZW50LiBDaGVja2luZyBtYXkgcmVxdWlyZSB0aGF0IHdlIGF3YWl0IG91ckhhc2hQcm9taXNlLilcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHsgLy8gTmV4dCB0aWNrLiBTZWUgcmVxdWVzdCgpLlxuXHRpZiAoIXRoZWlySGFzaCB8fCAhb3VySGFzaFByb21pc2UgfHwgKHRoZWlySGFzaCAhPT0gYXdhaXQgb3VySGFzaFByb21pc2UpKSB7XG5cdCAgY29uc3QgdGhlaXJEYXRhID0gYXdhaXQgdGhpcy5yZXF1ZXN0KHRhZyk7XG5cdCAgLy8gTWlnaHQgaGF2ZSBiZWVuIHRyaWdnZXJlZCBieSBvdXIgYXBwIHJlcXVlc3RpbmcgdGhpcyB0YWcgYmVmb3JlIHdlIHdlcmUgc3luYydkLiBTbyB0aGV5IG1pZ2h0IG5vdCBoYXZlIHRoZSBkYXRhLlxuXHQgIGlmICh0aGVpckRhdGE/Lmxlbmd0aCkge1xuXHQgICAgaWYgKGF3YWl0IHRoaXMuY29sbGVjdGlvbi5wdXQodGFnLCB0aGVpckRhdGEsIHRoaXMpKSB7XG5cdCAgICAgIHRoaXMubG9nKCdyZWNlaXZlZC9wdXQnLCB0YWcsICd0aGVpci9vdXIgaGFzaDonLCB0aGVpckhhc2ggfHwgJ21pc3NpbmdUaGVpcnMnLCAoYXdhaXQgb3VySGFzaFByb21pc2UpIHx8ICdtaXNzaW5nT3VycycsIHRoZWlyRGF0YT8ubGVuZ3RoKTtcblx0ICAgIH0gZWxzZSB7XG5cdCAgICAgIHRoaXMubG9nKCd1bmFibGUgdG8gcHV0JywgdGFnKTtcblx0ICAgIH1cblx0ICB9XG5cdH1cblx0dGhpcy5jaGVja2VkVGFncy5hZGQodGFnKTsgICAgICAgLy8gRXZlcnl0aGluZyB3ZSd2ZSBleGFtaW5lZCwgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIHdlIGFza2VkIGZvciBvciBzYXZlZCBkYXRhIGZyb20gcGVlci4gKFNlZSBzeW5jaHJvbml6YXRpb25Qcm9taXNlKVxuXHR0aGlzLnVuc3luY2hyb25pemVkLmRlbGV0ZSh0YWcpOyAvLyBVbmNvbmRpdGlvbmFsbHksIGJlY2F1c2Ugd2Ugc2V0IGl0IHVuY29uZGl0aW9uYWxseS5cblx0dGhpcy5jbGVhblVwSWZGaW5pc2hlZCgpO1xuXHRyZXNvbHZlKCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICB0aGlzLnVuc3luY2hyb25pemVkLnNldCh0YWcsIHByb21pc2UpOyAvLyBVbmNvbmRpdGlvbmFsbHksIGluIGNhc2Ugd2UgbmVlZCB0byBrbm93IHdlJ3JlIGxvb2tpbmcgZHVyaW5nIHRoZSB0aW1lIHdlJ3JlIGxvb2tpbmcuXG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgcmVxdWVzdCh0YWcpIHsgLy8gTWFrZSBhIHJlcXVlc3QgZm9yIHRhZyBmcm9tIHRoZSBwZWVyLCBhbmQgYW5zd2VyIGEgcHJvbWlzZSB0aGUgcmVzb2x2ZXMgd2l0aCB0aGUgZGF0YS5cbiAgICAvKmNvbnN0IHsgaG9zdFJlcXVlc3RCYXNlIH0gPSB0aGlzO1xuICAgIGlmIChob3N0UmVxdWVzdEJhc2UpIHtcbiAgICAgIC8vIEUuZy4sIGEgbG9jYWxob3N0IHJvdXRlciBtaWdodCBzdXBwb3J0IGEgZ2V0IG9mIGh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvTXV0YWJsZUNvbGxlY3Rpb24vY29tLmtpMXIweS53aGF0ZXZlci9fdC91TC9CQWNXX0xOQUphL2NKV211bWJsZVxuICAgICAgLy8gU28gaG9zdFJlcXVlc3RCYXNlIHNob3VsZCBiZSBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvTXV0YWJsZUNvbGxlY3Rpb24vY29tLmtpMXIweS53aGF0ZXZlclwiLFxuICAgICAgLy8gYW5kIHNlcnZpY2VOYW1lIHNob3VsZCBiZSBzb21ldGhpbmcgbGlrZSBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvc3luY1wiXG4gICAgICByZXR1cm4gZmV0Y2godGFnUGF0aChob3N0UmVxdWVzdEJhc2UsIHRhZykpLnRoZW4ocmVzcG9uc2UgPT4gcmVzcG9uc2UudGV4dCgpKTtcbiAgICB9Ki9cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHRoaXMuc2VuZCgnZ2V0JywgdGFnKSk7XG4gICAgLy8gU3VidGxlOiBXaGVuIHRoZSAncHV0JyBjb21lcyBiYWNrLCB3ZSB3aWxsIG5lZWQgdG8gcmVzb2x2ZSB0aGlzIHByb21pc2UuIEJ1dCBob3cgd2lsbCAncHV0JyBmaW5kIHRoZSBwcm9taXNlIHRvIHJlc29sdmUgaXQ/XG4gICAgLy8gQXMgaXQgdHVybnMgb3V0LCB0byBnZXQgaGVyZSwgd2UgaGF2ZSBuZWNlc3NhcmlsbHkgc2V0IHRhZyBpbiB0aGUgdW5zeW5jaHJvbml6ZWQgbWFwLiBcbiAgICBjb25zdCBub3RlZCA9IHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZyk7IC8vIEEgcHJvbWlzZSB0aGF0IGRvZXMgbm90IGhhdmUgYW4gZXhwb3NlZCAucmVzb2x2ZSwgYW5kIHdoaWNoIGRvZXMgbm90IGV4cGVjdCBhbnkgdmFsdWUuXG4gICAgbm90ZWQucmVzb2x2ZSA9IHByb21pc2UucmVzb2x2ZTsgLy8gVGFjayBvbiBhIHJlc29sdmUgZm9yIE9VUiBwcm9taXNlIG9udG8gdGhlIG5vdGVkIG9iamVjdCAod2hpY2ggY29uZnVzaW5nbHksIGhhcHBlbnMgdG8gYmUgYSBwcm9taXNlKS5cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICBhc3luYyBnZXQodGFnKSB7IC8vIFJlc3BvbmQgdG8gYSBwZWVyJ3MgZ2V0KCkgcmVxdWVzdCBieSBzZW5kaW5nIGEgcHV0IHJlcG9uc2Ugd2l0aCB0aGUgZGF0YS5cbiAgICBjb25zdCBkYXRhID0gYXdhaXQgdGhpcy5jb2xsZWN0aW9uLmdldCh0YWcpO1xuICAgIHRoaXMucHVzaCgncHV0JywgdGFnLCBkYXRhKTtcbiAgfVxuICBwdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpIHsgLy8gVGVsbCB0aGUgb3RoZXIgc2lkZSBhYm91dCBhIHNpZ25lZCB3cml0ZS5cbiAgICB0aGlzLnNlbmQob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSk7XG4gIH1cbiAgYXN5bmMgcHV0KHRhZywgc2lnbmF0dXJlKSB7IC8vIFJlY2VpdmUgYSBwdXQgbWVzc2FnZSBmcm9tIHRoZSBwZWVyLlxuICAgIC8vIElmIGl0IGlzIGEgcmVzcG9uc2UgdG8gYSBnZXQoKSByZXF1ZXN0LCByZXNvbHZlIHRoZSBjb3JyZXNwb25kaW5nIHByb21pc2UuXG4gICAgY29uc3QgcHJvbWlzZSA9IHRoaXMudW5zeW5jaHJvbml6ZWQ/LmdldCh0YWcpO1xuICAgIC8vIFJlZ2FyZGxlc3Mgb2Ygd2h5IHRoZSBvdGhlciBzaWRlIGlzIHNlbmRpbmcsIGlmIHdlIGhhdmUgYW4gb3V0c3RhbmRpbmcgcmVxdWVzdCwgY29tcGxldGUgaXQuXG4gICAgaWYgKHByb21pc2UpIHByb21pc2UucmVzb2x2ZShzaWduYXR1cmUpO1xuICAgIGVsc2UgYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnB1dCh0YWcsIHNpZ25hdHVyZSwgdGhpcyk7IC8vIE90aGVyd2lzZSwganVzdCB0cnkgdG8gd3JpdGUgaXQgbG9jYWxseS5cbiAgfVxuICBkZWxldGUodGFnLCBzaWduYXR1cmUpIHsgLy8gUmVjZWl2ZSBhIGRlbGV0ZSBtZXNzYWdlIGZyb20gdGhlIHBlZXIuXG4gICAgdGhpcy5jb2xsZWN0aW9uLmRlbGV0ZSh0YWcsIHNpZ25hdHVyZSwgdGhpcyk7XG4gIH1cbn1cbmV4cG9ydCBkZWZhdWx0IFN5bmNocm9uaXplcjtcbiIsImNsYXNzIENhY2hlIGV4dGVuZHMgTWFwe2NvbnN0cnVjdG9yKGUsdD0wKXtzdXBlcigpLHRoaXMubWF4U2l6ZT1lLHRoaXMuZGVmYXVsdFRpbWVUb0xpdmU9dCx0aGlzLl9uZXh0V3JpdGVJbmRleD0wLHRoaXMuX2tleUxpc3Q9QXJyYXkoZSksdGhpcy5fdGltZXJzPW5ldyBNYXB9c2V0KGUsdCxzPXRoaXMuZGVmYXVsdFRpbWVUb0xpdmUpe2xldCBpPXRoaXMuX25leHRXcml0ZUluZGV4O3RoaXMuZGVsZXRlKHRoaXMuX2tleUxpc3RbaV0pLHRoaXMuX2tleUxpc3RbaV09ZSx0aGlzLl9uZXh0V3JpdGVJbmRleD0oaSsxKSV0aGlzLm1heFNpemUsdGhpcy5fdGltZXJzLmhhcyhlKSYmY2xlYXJUaW1lb3V0KHRoaXMuX3RpbWVycy5nZXQoZSkpLHN1cGVyLnNldChlLHQpLHMmJnRoaXMuX3RpbWVycy5zZXQoZSxzZXRUaW1lb3V0KCgoKT0+dGhpcy5kZWxldGUoZSkpLHMpKX1kZWxldGUoZSl7cmV0dXJuIHRoaXMuX3RpbWVycy5oYXMoZSkmJmNsZWFyVGltZW91dCh0aGlzLl90aW1lcnMuZ2V0KGUpKSx0aGlzLl90aW1lcnMuZGVsZXRlKGUpLHN1cGVyLmRlbGV0ZShlKX1jbGVhcihlPXRoaXMubWF4U2l6ZSl7dGhpcy5tYXhTaXplPWUsdGhpcy5fa2V5TGlzdD1BcnJheShlKSx0aGlzLl9uZXh0V3JpdGVJbmRleD0wLHN1cGVyLmNsZWFyKCk7Zm9yKGNvbnN0IGUgb2YgdGhpcy5fdGltZXJzLnZhbHVlcygpKWNsZWFyVGltZW91dChlKTt0aGlzLl90aW1lcnMuY2xlYXIoKX19Y2xhc3MgU3RvcmFnZUJhc2V7Y29uc3RydWN0b3Ioe25hbWU6ZSxiYXNlTmFtZTp0PVwiU3RvcmFnZVwiLG1heFNlcmlhbGl6ZXJTaXplOnM9MWUzLGRlYnVnOmk9ITF9KXtjb25zdCBhPWAke3R9LyR7ZX1gLHI9bmV3IENhY2hlKHMpO09iamVjdC5hc3NpZ24odGhpcyx7bmFtZTplLGJhc2VOYW1lOnQsZnVsbE5hbWU6YSxkZWJ1ZzppLHNlcmlhbGl6ZXI6cn0pfWFzeW5jIGxpc3QoKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoXCJcIiwoKGUsdCk9PnRoaXMubGlzdEludGVybmFsKHQsZSkpKX1hc3luYyBnZXQoZSl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKGUsKChlLHQpPT50aGlzLmdldEludGVybmFsKHQsZSkpKX1hc3luYyBkZWxldGUoZSl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKGUsKChlLHQpPT50aGlzLmRlbGV0ZUludGVybmFsKHQsZSkpKX1hc3luYyBwdXQoZSx0KXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUscyk9PnRoaXMucHV0SW50ZXJuYWwocyx0LGUpKSl9bG9nKC4uLmUpe3RoaXMuZGVidWcmJmNvbnNvbGUubG9nKHRoaXMubmFtZSwuLi5lKX1hc3luYyBzZXJpYWxpemUoZSx0KXtjb25zdHtzZXJpYWxpemVyOnMscmVhZHk6aX09dGhpcztsZXQgYT1zLmdldChlKXx8aTtyZXR1cm4gYT1hLnRoZW4oKGFzeW5jKCk9PnQoYXdhaXQgdGhpcy5yZWFkeSx0aGlzLnBhdGgoZSkpKSkscy5zZXQoZSxhKSxhd2FpdCBhfX1jb25zdHtSZXNwb25zZTplLFVSTDp0fT1nbG9iYWxUaGlzO2NsYXNzIFN0b3JhZ2VDYWNoZSBleHRlbmRzIFN0b3JhZ2VCYXNle2NvbnN0cnVjdG9yKC4uLmUpe3N1cGVyKC4uLmUpLHRoaXMuc3RyaXBwZXI9bmV3IFJlZ0V4cChgXi8ke3RoaXMuZnVsbE5hbWV9L2ApLHRoaXMucmVhZHk9Y2FjaGVzLm9wZW4odGhpcy5mdWxsTmFtZSl9YXN5bmMgbGlzdEludGVybmFsKGUsdCl7cmV0dXJuKGF3YWl0IHQua2V5cygpfHxbXSkubWFwKChlPT50aGlzLnRhZyhlLnVybCkpKX1hc3luYyBnZXRJbnRlcm5hbChlLHQpe2NvbnN0IHM9YXdhaXQgdC5tYXRjaChlKTtyZXR1cm4gcz8uanNvbigpfWRlbGV0ZUludGVybmFsKGUsdCl7cmV0dXJuIHQuZGVsZXRlKGUpfXB1dEludGVybmFsKHQscyxpKXtyZXR1cm4gaS5wdXQodCxlLmpzb24ocykpfXBhdGgoZSl7cmV0dXJuYC8ke3RoaXMuZnVsbE5hbWV9LyR7ZX1gfXRhZyhlKXtyZXR1cm4gbmV3IHQoZSkucGF0aG5hbWUucmVwbGFjZSh0aGlzLnN0cmlwcGVyLFwiXCIpfWRlc3Ryb3koKXtyZXR1cm4gY2FjaGVzLmRlbGV0ZSh0aGlzLmZ1bGxOYW1lKX19ZXhwb3J0e1N0b3JhZ2VDYWNoZSBhcyBTdG9yYWdlTG9jYWwsU3RvcmFnZUNhY2hlIGFzIGRlZmF1bHR9O1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHsgU3RvcmFnZUxvY2FsIH0gZnJvbSAnQGtpMXIweS9zdG9yYWdlJztcbmltcG9ydCBTeW5jaHJvbml6ZXIgZnJvbSAnLi9zeW5jaHJvbml6ZXIubWpzJztcbmltcG9ydCB7IHN0b3JhZ2VOYW1lLCBzdG9yYWdlVmVyc2lvbiB9IGZyb20gJy4vdmVyc2lvbi5tanMnO1xuY29uc3QgeyBDdXN0b21FdmVudCwgRXZlbnRUYXJnZXQsIFRleHREZWNvZGVyIH0gPSBnbG9iYWxUaGlzO1xuXG4vLyBUT0RPPzogU2hvdWxkIHZlcmZpZWQvdmFsaWRhdGVkIGJlIGl0cyBvd24gb2JqZWN0IHdpdGggbWV0aG9kcz9cblxuZXhwb3J0IGNsYXNzIENvbGxlY3Rpb24gZXh0ZW5kcyBFdmVudFRhcmdldCB7XG5cbiAgY29uc3RydWN0b3Ioe25hbWUsIGxhYmVsID0gbmFtZSwgc2VydmljZXMgPSBbXSwgcHJlc2VydmVEZWxldGlvbnMgPSAhIXNlcnZpY2VzLmxlbmd0aCxcblx0ICAgICAgIHBlcnNpc3RlbmNlQ2xhc3MgPSBTdG9yYWdlTG9jYWwsIGRiVmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uLCBwZXJzaXN0ZW5jZUJhc2UgPSBgJHtzdG9yYWdlTmFtZX1fJHtkYlZlcnNpb259YCxcblx0ICAgICAgIGRlYnVnID0gZmFsc2UsIG11bHRpcGxleCwgLy8gQ2F1c2VzIHN5bmNocm9uaXphdGlvbiB0byByZXVzZSBjb25uZWN0aW9ucyBmb3IgZGlmZmVyZW50IENvbGxlY3Rpb25zIG9uIHRoZSBzYW1lIHNlcnZpY2UuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsLCByZXN0cmljdGVkVGFnc30pIHtcbiAgICBzdXBlcigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge25hbWUsIGxhYmVsLCBwcmVzZXJ2ZURlbGV0aW9ucywgcGVyc2lzdGVuY2VDbGFzcywgZGJWZXJzaW9uLCBtdWx0aXBsZXgsIGRlYnVnLCBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsLFxuXHRcdFx0IGZ1bGxOYW1lOiBgJHt0aGlzLmNvbnN0cnVjdG9yLm5hbWV9LyR7bmFtZX1gLCBmdWxsTGFiZWw6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtsYWJlbH1gfSk7XG4gICAgaWYgKHJlc3RyaWN0ZWRUYWdzKSB0aGlzLnJlc3RyaWN0ZWRUYWdzID0gcmVzdHJpY3RlZFRhZ3M7XG4gICAgdGhpcy5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgcGVyc2lzdGVuY2VPcHRpb25zID0ge25hbWU6IHRoaXMuZnVsbExhYmVsLCBiYXNlTmFtZTogcGVyc2lzdGVuY2VCYXNlLCBkZWJ1ZzogZGVidWd9O1xuICAgIGlmIChwZXJzaXN0ZW5jZUNsYXNzLnRoZW4pIHRoaXMucGVyc2lzdGVuY2VTdG9yZSA9IHBlcnNpc3RlbmNlQ2xhc3MudGhlbihraW5kID0+IG5ldyBraW5kKHBlcnNpc3RlbmNlT3B0aW9ucykpO1xuICAgIGVsc2UgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gbmV3IHBlcnNpc3RlbmNlQ2xhc3MocGVyc2lzdGVuY2VPcHRpb25zKTtcbiAgfVxuXG4gIGFzeW5jIGNsb3NlKCkge1xuICAgIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmNsb3NlKCk7XG4gIH1cbiAgYXN5bmMgZGVzdHJveSgpIHtcbiAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3QoKTtcbiAgICBjb25zdCBzdG9yZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBkZWxldGUgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIGlmIChzdG9yZSkgYXdhaXQgc3RvcmUuZGVzdHJveSgpO1xuICB9XG5cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7IC8vIENhbiBiZSBvdmVycmlkZGVuIGJ5IHRoZSBjbGllbnRcbiAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgfVxuICAvLyBDcmVkZW50aWFscy5zaWduLy52ZXJpZnkgY2FuIHByb2R1Y2UvYWNjZXB0IEpTT04gT0JKRUNUUyBmb3IgdGhlIG5hbWVkIFwiSlNPTiBTZXJpYWxpemF0aW9uXCIgZm9ybS5cbiAgLy8gQXMgaXQgaGFwcGVucywgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgY2FuIGRpc3Rpbmd1aXNoIGJldHdlZW4gYSBjb21wYWN0IHNlcmlhbGl6YXRpb24gKGJhc2U2NCB0ZXh0KVxuICAvLyB2cyBhbiBvYmplY3QsIGJ1dCBpdCBkb2VzIG5vdCByZWNvZ25pemUgYSBTRVJJQUxJWkVEIG9iamVjdC4gSGVyZSB3ZSBib3R0bGVuZWNrIHRob3NlIG9wZXJhdGlvbnNcbiAgLy8gc3VjaCB0aGF0IHRoZSB0aGluZyB0aGF0IGlzIGFjdHVhbGx5IHBlcnNpc3RlZCBhbmQgc3luY2hyb25pemVkIGlzIGFsd2F5cyBhIHN0cmluZyAtLSBlaXRoZXIgYmFzZTY0XG4gIC8vIGNvbXBhY3Qgb3IgSlNPTiBiZWdpbm5pbmcgd2l0aCBhIFwie1wiICh3aGljaCBhcmUgZGlzdGluZ3Vpc2hhYmxlIGJlY2F1c2UgXCJ7XCIgaXMgbm90IGEgYmFzZTY0IGNoYXJhY3RlcikuXG4gIHN0YXRpYyBlbnN1cmVTdHJpbmcoc2lnbmF0dXJlKSB7IC8vIFJldHVybiBhIHNpZ25hdHVyZSB0aGF0IGlzIGRlZmluYXRlbHkgYSBzdHJpbmcuXG4gICAgaWYgKHR5cGVvZihzaWduYXR1cmUpICE9PSAnc3RyaW5nJykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBSZXR1cm4gYSBjb21wYWN0IG9yIFwiSlNPTlwiIChvYmplY3QpIGZvcm0gb2Ygc2lnbmF0dXJlIChpbmZsYXRpbmcgYSBzZXJpYWxpemF0aW9uIG9mIHRoZSBsYXR0ZXIgaWYgbmVlZGVkKSwgYnV0IG5vdCBhIEpTT04gc3RyaW5nLlxuICBzdGF0aWMgbWF5YmVJbmZsYXRlKHNpZ25hdHVyZSkge1xuICAgIGlmIChzaWduYXR1cmU/LnN0YXJ0c1dpdGg/LihcIntcIikpIHJldHVybiBKU09OLnBhcnNlKHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBUaGUgdHlwZSBvZiBKV0UgdGhhdCBnZXRzIHNpZ25lZCAobm90IHRoZSBjdHkgb2YgdGhlIEpXRSkuIFdlIGF1dG9tYXRpY2FsbHkgdHJ5IHRvIGRlY3J5cHQgYSBKV1MgcGF5bG9hZCBvZiB0aGlzIHR5cGUuXG4gIHN0YXRpYyBlbmNyeXB0ZWRNaW1lVHlwZSA9ICd0ZXh0L2VuY3J5cHRlZCc7XG4gIHN0YXRpYyBhc3luYyBlbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpIHsgLy8gUHJvbWlzZSB2ZXJmaWVkIGFmdGVyIGZpcnN0IGF1Z21lbnRpbmcgd2l0aCBkZWNyeXB0ZWQgZGF0YSBhcyBuZWVkZWQuXG4gICAgaWYgKHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5jdHkgIT09IHRoaXMuZW5jcnlwdGVkTWltZVR5cGUpIHJldHVybiB2ZXJpZmllZDtcbiAgICBpZiAodmVyaWZpZWQuZGVjcnlwdGVkKSByZXR1cm4gdmVyaWZpZWQ7IC8vIEFscmVhZHkgZGVjcnlwdGVkLlxuICAgIGNvbnN0IGRlY3J5cHRlZCA9IGF3YWl0IENyZWRlbnRpYWxzLmRlY3J5cHQodmVyaWZpZWQudGV4dCk7XG4gICAgdmVyaWZpZWQuanNvbiA9IGRlY3J5cHRlZC5qc29uO1xuICAgIHZlcmlmaWVkLnRleHQgPSBkZWNyeXB0ZWQudGV4dDtcbiAgICB2ZXJpZmllZC5wYXlsb2FkID0gZGVjcnlwdGVkLnBheWxvYWQ7XG4gICAgdmVyaWZpZWQuZGVjcnlwdGVkID0gZGVjcnlwdGVkO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuXG4gIGFzeW5jIHByZXByb2Nlc3NGb3JTaWduaW5nKGRhdGEsIG9wdGlvbnMpIHtcbiAgICAvLyBQcm9taXNlIFtkYXRhLCBvcHRpb25zXSB0aGF0IGhhdmUgIGJlZW4gY2Fub25pY2FsaXplZCBhbmQgbWF5YmUgcmV2aXNlZCBmb3IgZW5jcnlwdGlvbi5cbiAgICAvLyBTZXBhcmF0ZWQgb3V0IGZyb20gc2lnbigpIHNvIHRoYXQgc3ViY2xhc3NlcyBjYW4gbW9kaWZ5IGZ1cnRoZXIuXG4gICAgY29uc3Qge2VuY3J5cHRpb24sIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7XG4gICAgaWYgKGVuY3J5cHRpb24pIHtcbiAgICAgIGRhdGEgPSBhd2FpdCBDcmVkZW50aWFscy5lbmNyeXB0KGRhdGEsIGVuY3J5cHRpb24pO1xuICAgICAgc2lnbmluZ09wdGlvbnMuY29udGVudFR5cGUgPSB0aGlzLmNvbnN0cnVjdG9yLmVuY3J5cHRlZE1pbWVUeXBlO1xuICAgIH1cbiAgICByZXR1cm4gW2RhdGEsIHtlbmNyeXB0aW9uLCAuLi5zaWduaW5nT3B0aW9uc31dO1xuICB9XG4gIGFzeW5jIHNpZ24oZGF0YSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgLy8gSWYgdGhpcyBjb2xsZWN0aW9uIHJlc3RyaWN0cyB1c2FibGUgdGFncyBmb3IgdGVzdGluZywgdGhlbiBkbyBzby5cbiAgICBbZGF0YSwgb3B0aW9uc10gPSBhd2FpdCB0aGlzLnByZXByb2Nlc3NGb3JTaWduaW5nKGRhdGEsIG9wdGlvbnMpO1xuICAgIGlmICgncmVzdHJpY3RlZFRhZ3MnIGluIHRoaXMpIHtcbiAgICAgIGxldCBvbGRIb29rID0gQ3JlZGVudGlhbHMuZ2V0VXNlckRldmljZVNlY3JldDtcbiAgICAgIHRyeSB7XG5cdENyZWRlbnRpYWxzLmdldFVzZXJEZXZpY2VTZWNyZXQgPSAodGFnLCBwcm9tcHRTdHJpbmcpID0+IHtcblx0ICBpZiAoIXRoaXMucmVzdHJpY3RlZFRhZ3MuaGFzKHRhZykpIHJldHVybiAnYm9ndXMnO1xuXHQgIHJldHVybiBvbGRIb29rKHRhZywgcHJvbXB0U3RyaW5nKTtcblx0fTtcblx0YXdhaXQgQ3JlZGVudGlhbHMuY2xlYXIoKTtcblx0cmV0dXJuIGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbihkYXRhLCBvcHRpb25zKTtcbiAgICAgIH0gZmluYWxseSB7XG5cdENyZWRlbnRpYWxzLmdldFVzZXJEZXZpY2VTZWNyZXQgPSBvbGRIb29rO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5zaWduKGRhdGEsIG9wdGlvbnMpO1xuICB9XG4gIHN0YXRpYyBhc3luYyBzaWduKGRhdGEsIG9wdGlvbnMpIHtcbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCBDcmVkZW50aWFscy5zaWduKGRhdGEsIG9wdGlvbnMpO1xuICAgIHJldHVybiB0aGlzLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zID0ge30pIHtcbiAgICBzaWduYXR1cmUgPSB0aGlzLm1heWJlSW5mbGF0ZShzaWduYXR1cmUpO1xuICAgIC8vIFdlIGRvbid0IGRvIFwiZGVlcFwiIHZlcmlmaWNhdGlvbiBoZXJlIC0gZS5nLiwgY2hlY2tpbmcgdGhhdCB0aGUgYWN0IGlzIGEgbWVtYmVyIG9mIGlzcywgYW5kIHRoZSBpYXQgaXMgYWZ0ZXIgdGhlIGV4aXN0aW5nIGlhdC5cbiAgICAvLyBJbnN0ZWFkLCB3ZSBkbyBvdXIgb3duIGRlZXAgY2hlY2tzIGluIHZhbGlkYXRlRm9yV3JpdGluZy5cbiAgICAvLyBUaGUgbWVtYmVyL25vdEJlZm9yZSBzaG91bGQgY2hlY2sgb3V0IGFueXdheSAtLSBpLmUuLCB3ZSBjb3VsZCBsZWF2ZSBpdCBpbiwgZXhjZXB0IGluIHN5bmNocm9uaXppbmdcbiAgICAvLyBDcmVkZW50aWFsLmNvbGxlY3Rpb25zLiBUaGVyZSBpcyBubyBtZWNoYW5pc20gKGN1cnJlbnRseSkgZm9yIHRoZVxuICAgIC8vIHN5bmNocm9uaXphdGlvbiB0byBoYXBwZW4gaW4gYW4gb3JkZXIgdGhhdCB3aWxsIHJlc3VsdCBpbiB0aGUgZGVwZW5kZW5jaWVzIGNvbWluZyBvdmVyIGJlZm9yZSB0aGUgaXRlbXMgdGhhdCBjb25zdW1lIHRoZW0uXG4gICAgY29uc3QgdmVyaWZpZWQgPSAgYXdhaXQgQ3JlZGVudGlhbHMudmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyk7XG4gICAgaWYgKHZlcmlmaWVkKSB2ZXJpZmllZC5zaWduYXR1cmUgPSBzaWduYXR1cmU7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIHZlcmlmeSguLi5yZXN0KSB7XG4gICAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KC4uLnJlc3QpO1xuICB9XG5cbiAgYXN5bmMgdW5kZWxldGVkVGFncygpIHtcbiAgICAvLyBPdXIgb3duIHNlcGFyYXRlLCBvbi1kZW1hbmQgYWNjb3VudGluZyBvZiBwZXJzaXN0ZW5jZVN0b3JlIGxpc3QoKTpcbiAgICAvLyAgIC0gcGVyc2lzdGVuY2VTdG9yZSBsaXN0KCkgY291bGQgcG90ZW50aWFsbHkgYmUgZXhwZW5zaXZlXG4gICAgLy8gICAtIEl0IHdpbGwgY29udGFpbiBzb2Z0LWRlbGV0ZWQgaXRlbSB0b21ic3RvbmVzIChzaWduZWQgZW1wdHkgcGF5bG9hZHMpLlxuICAgIC8vIEl0IHN0YXJ0cyB3aXRoIGEgbGlzdCgpIHRvIGdldCBhbnl0aGluZyBwZXJzaXN0ZWQgaW4gYSBwcmV2aW91cyBzZXNzaW9uLCBhbmQgYWRkcy9yZW1vdmVzIGFzIHdlIHN0b3JlL3JlbW92ZS5cbiAgICBjb25zdCBhbGxUYWdzID0gYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkubGlzdCgpO1xuICAgIGNvbnN0IHRhZ3MgPSBuZXcgU2V0KCk7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoYWxsVGFncy5tYXAoYXN5bmMgdGFnID0+IHtcbiAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnLCBzeW5jaHJvbml6ZTogZmFsc2V9KTtcbiAgICAgIGlmICh2ZXJpZmllZCkgdGFncy5hZGQodGFnKTtcbiAgICB9KSk7XG4gICAgcmV0dXJuIHRhZ3M7XG4gIH1cbiAgZ2V0IHRhZ3MoKSB7IC8vIEtlZXBzIHRyYWNrIG9mIG91ciAodW5kZWxldGVkKSBrZXlzLlxuICAgIHJldHVybiB0aGlzLl90YWdzUHJvbWlzZSB8fD0gdGhpcy51bmRlbGV0ZWRUYWdzKCk7XG4gIH1cbiAgYXN5bmMgYWRkVGFnKHRhZykge1xuICAgIChhd2FpdCB0aGlzLnRhZ3MpLmFkZCh0YWcpO1xuICB9XG4gIGFzeW5jIGRlbGV0ZVRhZyh0YWcpIHtcbiAgICAoYXdhaXQgdGhpcy50YWdzKS5kZWxldGUodGFnKTtcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKCF0aGlzLmRlYnVnKSByZXR1cm47XG4gICAgY29uc29sZS5sb2codGhpcy5mdWxsTGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIF9jYW5vbmljYWxpemVPcHRpb25zMSh0YWdPck9wdGlvbnMgPSB7fSkgeyAvLyBBbGxvdyB0YWdPck9wdGlvbnMgdG8gYmUganVzdCBhIHRhZyBzdHJpbmcgZGlyZWN0bHksIG9yIGEgbmFtZWQgb3B0aW9ucyBvYmplY3QuXG4gICAgcmV0dXJuICh0eXBlb2YodGFnT3JPcHRpb25zKSA9PT0gJ3N0cmluZycpID8ge3RhZzp0YWdPck9wdGlvbnN9IDogdGFnT3JPcHRpb25zO1xuICB9XG4gIF9jYW5vbmljYWxpemVPcHRpb25zKG9iamVjdE9yU3RyaW5nID0ge30pIHsgLy8gRXh0ZW5kIF9jYW5vbmljYWxpemVPcHRpb25zMSB0byBzdXBwb3J0OlxuICAgIC8vIC0gZGlzdHJpYnV0ZS1zZWN1cml0eSBzdHlsZSAndGVhbScgYW5kICdtZW1iZXInIGNhbiBiZSBjYWxsZWQgaW4gZmxleHN0b3JlIHN0eWxlICdvd25lcicgYW5kICdhdXRob3InLCByZXNwZWN0aXZlbHlcbiAgICAvLyAtIGVuY3J5cHRpb24gY2FuIGJlIHNwZWZpZWQgYXMgdHJ1ZSwgb3IgdGhlIHN0cmluZyAndGVhbScsIG9yICdvd25lcicsIHJlc3VsdGluZyBpbiB0aGUgdGVhbSB0YWcgYmVpbmcgdXNlZCBmb3IgZW5jcnlwdGlvblxuICAgIC8vIC0gb3duZXIgYW5kIGF1dGhvciBkZWZhdWx0IChpZiBub3Qgc3BlY2lmaWVkIGluIGVpdGhlciBzdHlsZSkgdG8gQ3JlZGVudGlhbHMub3duZXIgYW5kIENyZWRlbnRpYWxzLmF1dGhvciwgcmVzcGVjdGl2ZWx5LlxuICAgIC8vIC0gZW5jcnlwdGlvbiBkZWZhdWx0cyB0byBDcmVkZW50YWlscy5lbmNyeXB0aW9uLCBlbHNlIG51bGwgKGV4cGxpY2l0bHkpLlxuICAgIC8vIC0gdGltZSBkZWZhdWx0cyB0byBub3cuXG4gICAgLy8gSWRlbXBvdGVudCwgc28gdGhhdCBpdCBjYW4gYmUgdXNlZCBieSBib3RoIGNvbGxlY3Rpb24uc2lnbiBhbmQgY29sbGVjdGlvbi5zdG9yZSAod2hpY2ggdXNlcyBzaWduKS5cbiAgICBsZXQge293bmVyLCB0ZWFtID0gb3duZXIgPz8gQ3JlZGVudGlhbHMub3duZXIsXG5cdCB0YWdzID0gW10sXG5cdCBhdXRob3IsIG1lbWJlciA9IGF1dGhvciA/PyB0YWdzWzBdID8/IENyZWRlbnRpYWxzLmF1dGhvcixcblx0IGVuY3J5cHRpb24gPSBDcmVkZW50aWFscy5lbmNyeXB0aW9uID8/IG51bGwsXG5cdCB0aW1lID0gRGF0ZS5ub3coKSxcblx0IC4uLnJlc3R9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEob2JqZWN0T3JTdHJpbmcpO1xuICAgIGlmIChbdHJ1ZSwgJ3RlYW0nLCAnb3duZXInXS5pbmNsdWRlcyhlbmNyeXB0aW9uKSkgZW5jcnlwdGlvbiA9IHRlYW0gfHwgbWVtYmVyO1xuICAgIGlmICh0ZWFtID09PSBtZW1iZXIgfHwgIXRlYW0pIHsgLy8gQ2xlYW4gdXAgdGFncyBmb3Igbm8gc2VwYXJhdGUgdGVhbS5cbiAgICAgIGlmICghdGFncy5pbmNsdWRlcyhtZW1iZXIpKSB0YWdzLnB1c2gobWVtYmVyKTtcbiAgICAgIG1lbWJlciA9IHVuZGVmaW5lZDtcbiAgICAgIHRlYW0gPSAnJztcbiAgICB9XG4gICAgcmV0dXJuIHt0aW1lLCB0ZWFtLCBtZW1iZXIsIGVuY3J5cHRpb24sIHRhZ3MsIC4uLnJlc3R9O1xuICB9XG4gIGZhaWwob3BlcmF0aW9uLCBkYXRhLCBhdXRob3IpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7YXV0aG9yfSBkb2VzIG5vdCBoYXZlIHRoZSBhdXRob3JpdHkgdG8gJHtvcGVyYXRpb259ICR7dGhpcy5mdWxsTmFtZX0gJHtKU09OLnN0cmluZ2lmeShkYXRhKX0uYCk7XG4gIH1cbiAgYXN5bmMgc3RvcmUoZGF0YSwgb3B0aW9ucyA9IHt9LCBzeW5jaHJvbml6ZXIgPSBudWxsKSB7XG4gICAgLy8gZW5jcnlwdCBpZiBuZWVkZWRcbiAgICAvLyBzaWduXG4gICAgLy8gcHV0IDw9PSBBbHNvIHdoZXJlIHdlIGVudGVyIGlmIHB1c2hlZCBmcm9tIGEgY29ubmVjdGlvblxuICAgIC8vICAgIHZhbGlkYXRlRm9yV3JpdGluZ1xuICAgIC8vICAgICAgIGV4aXQgaWYgaW1wcm9wZXJcbiAgICAvLyAgICAgICBlbWl0IHVwZGF0ZSBldmVudFxuICAgIC8vICAgIG1lcmdlU2lnbmF0dXJlc1xuICAgIC8vICAgIHBlcnNpc3QgbG9jYWxseVxuICAgIC8vIHB1c2ggKGxpdmUgdG8gYW55IGNvbm5lY3Rpb25zIGV4Y2VwdCB0aGUgb25lIHdlIHJlY2VpdmVkIGZyb20pXG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb24uXG4gICAgbGV0IHt0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5zaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zKTtcbiAgICB0YWcgPSBhd2FpdCB0aGlzLnB1dCh0YWcsIHNpZ25hdHVyZSwgc3luY2hyb25pemVyKTtcbiAgICBpZiAoIXRhZykgcmV0dXJuIHRoaXMuZmFpbCgnc3RvcmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBwdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUsIGV4Y2x1ZGVTeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFB1c2ggdG8gYWxsIGNvbm5lY3RlZCBzeW5jaHJvbml6ZXJzLCBleGNsdWRpbmcgdGhlIHNwZWNpZmllZCBvbmUuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHRoaXMubWFwU3luY2hyb25pemVycyhzeW5jaHJvbml6ZXIgPT4gKGV4Y2x1ZGVTeW5jaHJvbml6ZXIgIT09IHN5bmNocm9uaXplcikgJiYgc3luY2hyb25pemVyLnB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSkpKTtcbiAgfVxuICBhc3luYyByZW1vdmUob3B0aW9ucyA9IHt9KSB7IC8vIE5vdGU6IFJlYWxseSBqdXN0IHJlcGxhY2luZyB3aXRoIGVtcHR5IGRhdGEgZm9yZXZlci4gT3RoZXJ3aXNlIG1lcmdpbmcgd2l0aCBlYXJsaWVyIGRhdGEgd2lsbCBicmluZyBpdCBiYWNrIVxuICAgIGxldCB7ZW5jcnlwdGlvbiwgdGFnLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpO1xuICAgIGNvbnN0IGRhdGEgPSAnJztcbiAgICAvLyBObyBuZWVkIHRvIGF3YWl0IHN5bmNocm9uaXphdGlvblxuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuc2lnbihkYXRhLCB7c3ViamVjdDogdGFnLCBlbmNyeXB0aW9uOiAnJywgLi4uc2lnbmluZ09wdGlvbnN9KTtcbiAgICB0YWcgPSBhd2FpdCB0aGlzLmRlbGV0ZSh0YWcsIHNpZ25hdHVyZSk7XG4gICAgaWYgKCF0YWcpIHJldHVybiB0aGlzLmZhaWwoJ3JlbW92ZScsIGRhdGEsIHNpZ25pbmdPcHRpb25zLm1lbWJlciB8fCBzaWduaW5nT3B0aW9ucy50YWdzWzBdKTtcbiAgICBhd2FpdCB0aGlzLnB1c2goJ2RlbGV0ZScsIHRhZywgc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIHJldHJpZXZlKHRhZ09yT3B0aW9ucykgeyAvLyBnZXRWZXJpZmllZCBhbmQgbWF5YmUgZGVjcnlwdC4gSGFzIG1vcmUgY29tcGxleCBiZWhhdmlvciBpbiBzdWJjbGFzcyBWZXJzaW9uZWRDb2xsZWN0aW9uLlxuICAgIGNvbnN0IHt0YWcsIGRlY3J5cHQgPSB0cnVlLCAuLi5vcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMxKHRhZ09yT3B0aW9ucyk7XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIC4uLm9wdGlvbnN9KTtcbiAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gJyc7XG4gICAgaWYgKGRlY3J5cHQpIHJldHVybiBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZURlY3J5cHRlZCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIGFzeW5jIGdldFZlcmlmaWVkKHRhZ09yT3B0aW9ucykgeyAvLyBzeW5jaHJvbml6ZSwgZ2V0LCBhbmQgdmVyaWZ5IChidXQgd2l0aG91dCBkZWNyeXB0KVxuICAgIGNvbnN0IHt0YWcsIHN5bmNocm9uaXplID0gdHJ1ZSwgLi4udmVyaWZ5T3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zMSh0YWdPck9wdGlvbnMpO1xuICAgIGlmIChzeW5jaHJvbml6ZSkgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZTEodGFnKTtcbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmdldCh0YWcpO1xuICAgIGlmICghc2lnbmF0dXJlKSByZXR1cm4gc2lnbmF0dXJlO1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlLCB2ZXJpZnlPcHRpb25zKTtcbiAgICBpZiAodmVyaWZpZWQpIHZlcmlmaWVkLnRhZyA9IHRhZzsgLy8gQ2Fycnkgd2l0aCBpdCB0aGUgdGFnIGJ5IHdoaWNoIGl0IHdhcyBmb3VuZC5cbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgYXN5bmMgbGlzdChza2lwU3luYyA9IGZhbHNlICkgeyAvLyBMaXN0IGFsbCB0YWdzIG9mIHRoaXMgY29sbGVjdGlvbi5cbiAgICBpZiAoIXNraXBTeW5jKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIC8vIFdlIGNhbm5vdCBqdXN0IGxpc3QgdGhlIGtleXMgb2YgdGhlIGNvbGxlY3Rpb24sIGJlY2F1c2UgdGhhdCBpbmNsdWRlcyBlbXB0eSBwYXlsb2FkcyBvZiBpdGVtcyB0aGF0IGhhdmUgYmVlbiBkZWxldGVkLlxuICAgIHJldHVybiBBcnJheS5mcm9tKChhd2FpdCB0aGlzLnRhZ3MpLmtleXMoKSk7XG4gIH1cbiAgYXN5bmMgbWF0Y2godGFnLCBwcm9wZXJ0aWVzKSB7IC8vIElzIHRoaXMgc2lnbmF0dXJlIHdoYXQgd2UgYXJlIGxvb2tpbmcgZm9yP1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5yZXRyaWV2ZSh0YWcpO1xuICAgIGNvbnN0IGRhdGEgPSB2ZXJpZmllZD8uanNvbjtcbiAgICBpZiAoIWRhdGEpIHJldHVybiBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBwcm9wZXJ0aWVzKSB7XG4gICAgICBpZiAoZGF0YVtrZXldICE9PSBwcm9wZXJ0aWVzW2tleV0pIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgYXN5bmMgZmluZExvY2FsKHByb3BlcnRpZXMpIHsgLy8gRmluZCB0aGUgdGFnIGluIG91ciBzdG9yZSB0aGF0IG1hdGNoZXMsIGVsc2UgZmFsc2V5XG4gICAgZm9yIChjb25zdCB0YWcgb2YgYXdhaXQgdGhpcy5saXN0KCduby1zeW5jJykpIHsgLy8gRGlyZWN0IGxpc3QsIHcvbyBzeW5jLlxuICAgICAgaWYgKGF3YWl0IHRoaXMubWF0Y2godGFnLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIHRhZztcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGFzeW5jIGZpbmQocHJvcGVydGllcykgeyAvLyBBbnN3ZXIgdGhlIHRhZyB0aGF0IGhhcyB2YWx1ZXMgbWF0Y2hpbmcgdGhlIHNwZWNpZmllZCBwcm9wZXJ0aWVzLiBPYnZpb3VzbHksIGNhbid0IGJlIGVuY3J5cHRlZCBhcyBhIHdob2xlLlxuICAgIGxldCBmb3VuZCA9IGF3YWl0IHRoaXMuZmluZExvY2FsKHByb3BlcnRpZXMpO1xuICAgIGlmIChmb3VuZCkge1xuICAgICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZTEoZm91bmQpOyAvLyBNYWtlIHN1cmUgdGhlIGRhdGEgaXMgdXAgdG8gZGF0ZS4gVGhlbiBjaGVjayBhZ2Fpbi5cbiAgICAgIGlmIChhd2FpdCB0aGlzLm1hdGNoKGZvdW5kLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIGZvdW5kO1xuICAgIH1cbiAgICAvLyBObyBtYXRjaC5cbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemVEYXRhKCk7XG4gICAgZm91bmQgPSBhd2FpdCB0aGlzLmZpbmRMb2NhbChwcm9wZXJ0aWVzKTtcbiAgICBpZiAoZm91bmQgJiYgYXdhaXQgdGhpcy5tYXRjaChmb3VuZCwgcHJvcGVydGllcykpIHJldHVybiBmb3VuZDtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXF1aXJlVGFnKHRhZykge1xuICAgIGlmICh0YWcpIHJldHVybjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0EgdGFnIGlzIHJlcXVpcmVkLicpO1xuICB9XG5cbiAgLy8gVGhlc2UgdGhyZWUgaWdub3JlIHN5bmNocm9uaXphdGlvbiBzdGF0ZSwgd2hpY2ggaWYgbmVlZWQgaXMgdGhlIHJlc3BvbnNpYmlsaXR5IG9mIHRoZSBjYWxsZXIuXG4gIC8vIEZJWE1FIFRPRE86IGFmdGVyIGluaXRpYWwgZGV2ZWxvcG1lbnQsIHRoZXNlIHRocmVlIHNob3VsZCBiZSBtYWRlIGludGVybmFsIHNvIHRoYXQgYXBwbGljYXRpb24gY29kZSBkb2VzIG5vdCBjYWxsIHRoZW0uXG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gR2V0IHRoZSBsb2NhbCByYXcgc2lnbmF0dXJlIGRhdGEuXG4gICAgdGhpcy5yZXF1aXJlVGFnKHRhZyk7XG4gICAgcmV0dXJuIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmdldCh0YWcpO1xuICB9XG4gIC8vIFRoZXNlIHR3byBjYW4gYmUgdHJpZ2dlcmVkIGJ5IGNsaWVudCBjb2RlIG9yIGJ5IGFueSBzZXJ2aWNlLlxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUsIHN5bmNocm9uaXplciA9IG51bGwpIHsgLy8gUHV0IHRoZSByYXcgc2lnbmF0dXJlIGxvY2FsbHkgYW5kIG9uIHRoZSBzcGVjaWZpZWQgc2VydmljZXMuXG4gICAgLy8gMS4gdmFsaWRhdGVGb3JXcml0aW5nXG4gICAgLy8gMi4gbWVyZ2VTaWduYXR1cmVzIGFnYWluc3QgYW55IGV4aXN0aW5nLCBwaWNraW5nIHNvbWUgY29tYmluYXRpb24gb2YgZXhpc3RpbmcgYW5kIG5leHQuXG4gICAgLy8gMy4gcGVyc2lzdCB0aGUgcmVzdWx0XG4gICAgLy8gNC4gcmV0dXJuIHRhZ1xuXG4gICAgLy8gVE9ETzogZG8gd2UgbmVlZCB0byBxdWV1ZSB0aGVzZT8gU3VwcG9zZSB3ZSBhcmUgdmFsaWRhdGluZyBvciBtZXJnaW5nIHdoaWxlIG90aGVyIHJlcXVlc3QgYXJyaXZlP1xuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3N0b3JlJywgc3luY2hyb25pemVyKTtcbiAgICB0aGlzLmxvZygncHV0Jywge3RhZzogdmFsaWRhdGlvbj8udGFnIHx8IHRhZywgc3luY2hyb25pemVyOiBzeW5jaHJvbml6ZXI/LmxhYmVsLCB0ZXh0OiB2YWxpZGF0aW9uPy50ZXh0fSk7XG5cbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgaWYgKCF2YWxpZGF0aW9uLnNpZ25hdHVyZSkgcmV0dXJuIHZhbGlkYXRpb24udGFnOyAvLyBObyBmdXJ0aGVyIGFjdGlvbiBidXQgYW5zd2VyIHRhZy4gRS5nLiwgd2hlbiBpZ25vcmluZyBuZXcgZGF0YS5cbiAgICBhd2FpdCB0aGlzLmFkZFRhZyh2YWxpZGF0aW9uLnRhZyk7XG5cbiAgICBjb25zdCBtZXJnZWQgPSBhd2FpdCB0aGlzLm1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBtZXJnZWQpO1xuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5wdXQuXG4gIH1cbiAgYXN5bmMgZGVsZXRlKHRhZywgc2lnbmF0dXJlLCBzeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFJlbW92ZSB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3JlbW92ZScsIHN5bmNocm9uaXplciwgJ3JlcXVpcmVUYWcnKTtcbiAgICB0aGlzLmxvZygnZGVsZXRlJywgdGFnLCBzeW5jaHJvbml6ZXI/LmxhYmVsLCAndmFsaWRhdGVkIHRhZzonLCB2YWxpZGF0aW9uPy50YWcsICdwcmVzZXJ2ZURlbGV0aW9uczonLCB0aGlzLnByZXNlcnZlRGVsZXRpb25zKTtcbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICBpZiAodGhpcy5wcmVzZXJ2ZURlbGV0aW9ucykgeyAvLyBTaWduYXR1cmUgcGF5bG9hZCBpcyBlbXB0eS5cbiAgICAgIGF3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgc2lnbmF0dXJlKTtcbiAgICB9IGVsc2UgeyAvLyBSZWFsbHkgZGVsZXRlLlxuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBzaWduYXR1cmUsICdkZWxldGUnKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbGlkYXRpb24udGFnOyAvLyBEb24ndCByZWx5IG9uIHRoZSByZXR1cm5lZCB2YWx1ZSBvZiBwZXJzaXN0ZW5jZVN0b3JlLmRlbGV0ZS5cbiAgfVxuXG4gIG5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSA9IHVuZGVmaW5lZCwgdmFsaWRhdGVkID0gJycsIHNpZ25hdHVyZSkge1xuICAgIC8vIExhdGVyIG9uLCB3ZSB3aWxsIG5vdCB3YW50IHRvIGdpdmUgb3V0IHNvIG11Y2ggaW5mby4uLlxuICAgIC8vaWYgKHRoaXMuZGVidWcpIHtcbiAgICBjb25zb2xlLndhcm4odGhpcy5mdWxsTGFiZWwsIG9wZXJhdGlvbkxhYmVsLCBtZXNzYWdlLCB0YWcpO1xuICAgIC8vfSBlbHNlIHtcbiAgICAvLyAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBgU2lnbmF0dXJlIGlzIG5vdCB2YWxpZCB0byAke29wZXJhdGlvbkxhYmVsfSAke3RhZyB8fCAnZGF0YSd9LmApO1xuICAgIC8vfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgYXN5bmMgZGlzYWxsb3dXcml0ZSh0YWcsIGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpIHsgLy8gUHJvbWlzZSBhIHJlYXNvbiBzdHJpbmcgdG8gZGlzYWxsb3csIG9yIG51bGwgaWYgd3JpdGUgaXMgYWxsb3dlZC5cbiAgICAvLyBUaGUgZW1wdHkgc3RyaW5nIG1lYW5zIHRoYXQgd2Ugc2hvdWxkIG5vdCBhY3R1YWxseSB3cml0ZSBhbnl0aGluZywgYnV0IHRoZSBvcGVyYXRpb24gc2hvdWxkIHF1aWV0bHkgYW5zd2VyIHRoZSBnaXZlbiB0YWcuXG5cbiAgICBpZiAoIXZlcmlmaWVkLnRleHQubGVuZ3RoKSByZXR1cm4gdGhpcy5kaXNhbGxvd0RlbGV0ZSh0YWcsIGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpO1xuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG4gICAgY29uc3QgdGFnZ2VkID0gYXdhaXQgdGhpcy5jaGVja1RhZyh2ZXJpZmllZCk7IC8vIENoZWNrZWQgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIHRoaXMgYW4gYW50ZWNlZGVudC5cbiAgICBpZiAodGFnZ2VkKSByZXR1cm4gdGFnZ2VkOyAvLyBIYXJkIGZhaWwgYW5zd2VycywgcmVnYXJkbGVzcyBvZiBleGlzdGluZy5cbiAgICBpZiAoIWV4aXN0aW5nKSByZXR1cm4gdGFnZ2VkOyAvLyBSZXR1cm5pbmcgJycgb3IgbnVsbC5cblxuICAgIGxldCBvd25lciwgZGF0ZTtcbiAgICAvLyBSZXR1cm4gYW55IGhhcmQgZmFpbCBmaXJzdCwgdGhlbiBhbnkgZW1wdHkgc3RyaW5nLCBvciBmaW5hbGx5IG51bGxcbiAgICByZXR1cm4gKG93bmVyID0gYXdhaXQgdGhpcy5jaGVja093bmVyKGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpKSB8fFxuICAgICAgKGRhdGUgPSBhd2FpdCB0aGlzLmNoZWNrRGF0ZShleGlzdGluZywgcHJvcG9zZWQpKSB8fFxuICAgICAgKG93bmVyID8/IGRhdGUgPz8gdGFnZ2VkKTtcbiAgfVxuICBhc3luYyBkaXNhbGxvd0RlbGV0ZSh0YWcsIGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpIHsgLy8gRGVsZXRpb24gdHlwaWNhbGx5IGxhdGNoZXMuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG5cbiAgICAvLyBJZiB3ZSBldmVyIGNoYW5nZSB0aGlzIG5leHQsIGJlIHN1cmUgdGhhdCBvbmUgY2Fubm90IHNwZWN1bGF0aXZlbHkgY2FtcCBvdXQgb24gYSB0YWcgYW5kIHByZXZlbnQgcGVvcGxlIGZyb20gd3JpdGluZyFcbiAgICBpZiAoIWV4aXN0aW5nKSByZXR1cm4gJyc7XG4gICAgLy8gRGVsZXRpbmcgdHJ1bXBzIGRhdGEsIHJlZ2FyZGxlc3Mgb2YgdGltZXN0YW1wLlxuICAgIHJldHVybiB0aGlzLmNoZWNrT3duZXIoZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCk7XG4gIH1cbiAgaGFzaGFibGVQYXlsb2FkKHZhbGlkYXRpb24pIHsgLy8gUmV0dXJuIGEgc3RyaW5nIHRoYXQgY2FuIGJlIGhhc2hlZCB0byBtYXRjaCB0aGUgc3ViIGhlYWRlclxuICAgIC8vICh3aGljaCBpcyBub3JtYWxseSBnZW5lcmF0ZWQgaW5zaWRlIHRoZSBkaXN0cmlidXRlZC1zZWN1cml0eSB2YXVsdCkuXG4gICAgcmV0dXJuIHZhbGlkYXRpb24udGV4dCB8fCBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUodmFsaWRhdGlvbi5wYXlsb2FkKTtcbiAgfVxuICBhc3luYyBoYXNoKHZhbGlkYXRpb24pIHsgLy8gUHJvbWlzZSB0aGUgaGFzaCBvZiBoYXNoYWJsZVBheWxvYWQuXG4gICAgcmV0dXJuIENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChhd2FpdCBDcmVkZW50aWFscy5oYXNoVGV4dCh0aGlzLmhhc2hhYmxlUGF5bG9hZCh2YWxpZGF0aW9uKSkpO1xuICB9XG4gIGZhaXJPcmRlcmVkQXV0aG9yKGV4aXN0aW5nLCBwcm9wb3NlZCkgeyAvLyBVc2VkIHRvIGJyZWFrIHRpZXMgaW4gZXZlbiB0aW1lc3RhbXBzLlxuICAgIGNvbnN0IHtzdWIsIGFjdH0gPSBleGlzdGluZztcbiAgICBjb25zdCB7YWN0OmFjdDJ9ID0gcHJvcG9zZWQ7XG4gICAgaWYgKHN1Yj8ubGVuZ3RoICYmIHN1Yi5jaGFyQ29kZUF0KHN1Yi5sZW5ndGggLSAxKSAlIDIpIHJldHVybiBhY3QgPCBhY3QyO1xuICAgIHJldHVybiBhY3QgPiBhY3QyOyAvLyBJZiBhY3QgPT09IGFjdDIsIHRoZW4gdGhlIHRpbWVzdGFtcHMgc2hvdWxkIGJlIHRoZSBzYW1lLlxuICB9XG4gIGdldE93bmVyKHByb3RlY3RlZEhlYWRlcikgeyAvLyBSZXR1cm4gdGhlIHRhZyBvZiB3aGF0IHNoYWxsIGJlIGNvbnNpZGVyZWQgdGhlIG93bmVyLlxuICAgIGNvbnN0IHtpc3MsIGtpZH0gPSBwcm90ZWN0ZWRIZWFkZXI7XG4gICAgcmV0dXJuIGlzcyB8fCBraWQ7XG4gIH1cbiAgLy8gVGhlc2UgcHJlZGljYXRlcyBjYW4gcmV0dXJuIGEgYm9vbGVhbiBmb3IgaGFyZCB5ZXMgb3Igbm8sIG9yIG51bGwgdG8gaW5kaWNhdGUgdGhhdCB0aGUgb3BlcmF0aW9uIHNob3VsZCBzaWxlbnRseSByZS11c2UgdGhlIHRhZy5cbiAgY2hlY2tTb21ldGhpbmcocmVhc29uLCBib29sZWFuLCBsYWJlbCkge1xuICAgIGlmIChib29sZWFuKSB0aGlzLmxvZygnd3JvbmcnLCBsYWJlbCwgcmVhc29uKTtcbiAgICByZXR1cm4gYm9vbGVhbiA/IHJlYXNvbiA6IG51bGw7XG4gIH1cbiAgY2hlY2tPd25lcihleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7Ly8gRG9lcyBwcm9wb3NlZCBvd25lciBtYXRjaCB0aGUgZXhpc3Rpbmc/XG4gICAgcmV0dXJuIHRoaXMuY2hlY2tTb21ldGhpbmcoJ25vdCBvd25lcicsIHRoaXMuZ2V0T3duZXIoZXhpc3RpbmcsIHZlcmlmaWVkLmV4aXN0aW5nKSAhPT0gdGhpcy5nZXRPd25lcihwcm9wb3NlZCwgdmVyaWZpZWQpLCAnb3duZXInKTtcbiAgfVxuXG4gIGFudGVjZWRlbnQodmVyaWZpZWQpIHsgLy8gV2hhdCB0YWcgc2hvdWxkIHRoZSB2ZXJpZmllZCBzaWduYXR1cmUgYmUgY29tcGFyZWQgYWdhaW5zdCBmb3Igd3JpdGluZywgaWYgYW55LlxuICAgIHJldHVybiB2ZXJpZmllZC50YWc7XG4gIH1cbiAgc3luY2hyb25pemVBbnRlY2VkZW50KHRhZywgYW50ZWNlZGVudCkgeyAvLyBTaG91bGQgdGhlIGFudGVjZWRlbnQgdHJ5IHN5bmNocm9uaXppbmcgYmVmb3JlIGdldHRpbmcgaXQ/XG4gICAgcmV0dXJuIHRhZyAhPT0gYW50ZWNlZGVudDsgLy8gRmFsc2Ugd2hlbiB0aGV5IGFyZSB0aGUgc2FtZSB0YWcsIGFzIHRoYXQgd291bGQgYmUgY2lyY3VsYXIuIFZlcnNpb25zIGRvIHN5bmMuXG4gIH1cbiAgdGFnRm9yV3JpdGluZyhzcGVjaWZpZWRUYWcsIHZhbGlkYXRpb24pIHsgLy8gR2l2ZW4gdGhlIHNwZWNpZmllZCB0YWcgYW5kIHRoZSBiYXNpYyB2ZXJpZmljYXRpb24gc28gZmFyLCBhbnN3ZXIgdGhlIHRhZyB0aGF0IHNob3VsZCBiZSB1c2VkIGZvciB3cml0aW5nLlxuICAgIHJldHVybiBzcGVjaWZpZWRUYWcgfHwgdGhpcy5oYXNoKHZhbGlkYXRpb24pO1xuICB9XG4gIGFzeW5jIHZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgb3BlcmF0aW9uTGFiZWwsIHN5bmNocm9uaXplciwgcmVxdWlyZVRhZyA9IGZhbHNlKSB7IC8vIFRPRE86IE9wdGlvbmFscyBzaG91bGQgYmUga2V5d29yZC5cbiAgICAvLyBBIGRlZXAgdmVyaWZ5IHRoYXQgY2hlY2tzIGFnYWluc3QgdGhlIGV4aXN0aW5nIGl0ZW0ncyAocmUtKXZlcmlmaWVkIGhlYWRlcnMuXG4gICAgLy8gSWYgaXQgc3VjY2VlZHMsIHByb21pc2UgYSB2YWxpZGF0aW9uLlxuICAgIC8vIEl0IGNhbiBhbHNvIGFuc3dlciBhIHN1cGVyLWFiYnJldmFpdGVkIHZhbGl0aW9uIG9mIGp1c3Qge3RhZ30sIHdoaWNoIGluZGljYXRlcyB0aGF0IG5vdGhpbmcgc2hvdWxkIGJlIHBlcnNpc3RlZC9lbWl0dGVkLCBidXQgdGFnIHJldHVybmVkLlxuICAgIC8vIFRoaXMgaXMgYWxzbyB0aGUgY29tbW9uIGNvZGUgKGJldHdlZW4gcHV0L2RlbGV0ZSkgdGhhdCBlbWl0cyB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIC8vXG4gICAgLy8gSG93LCBpZiBhIGFsbCwgZG8gd2UgY2hlY2sgdGhhdCBhY3QgaXMgYSBtZW1iZXIgb2YgaXNzP1xuICAgIC8vIENvbnNpZGVyIGFuIGl0ZW0gb3duZWQgYnkgaXNzLlxuICAgIC8vIFRoZSBpdGVtIGlzIHN0b3JlZCBhbmQgc3luY2hyb25pemVkIGJ5IGFjdCBBIGF0IHRpbWUgdDEuXG4gICAgLy8gSG93ZXZlciwgYXQgYW4gZWFybGllciB0aW1lIHQwLCBhY3QgQiB3YXMgY3V0IG9mZiBmcm9tIHRoZSByZWxheSBhbmQgc3RvcmVkIHRoZSBpdGVtLlxuICAgIC8vIFdoZW4gbWVyZ2luZywgd2Ugd2FudCBhY3QgQidzIHQwIHRvIGJlIHRoZSBlYXJsaWVyIHJlY29yZCwgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIEIgaXMgc3RpbGwgYSBtZW1iZXIgYXQgdGltZSBvZiBzeW5jaHJvbml6YXRpb24uXG4gICAgLy8gVW5sZXNzL3VudGlsIHdlIGhhdmUgdmVyc2lvbmVkIGtleXNldHMsIHdlIGNhbm5vdCBlbmZvcmNlIGEgbWVtYmVyc2hpcCBjaGVjayAtLSB1bmxlc3MgdGhlIGFwcGxpY2F0aW9uIGl0c2VsZiB3YW50cyB0byBkbyBzby5cbiAgICAvLyBBIGNvbnNlcXVlbmNlLCB0aG91Z2gsIGlzIHRoYXQgYSBodW1hbiB3aG8gaXMgYSBtZW1iZXIgb2YgaXNzIGNhbiBnZXQgYXdheSB3aXRoIHN0b3JpbmcgdGhlIGRhdGEgYXMgc29tZVxuICAgIC8vIG90aGVyIHVucmVsYXRlZCBwZXJzb25hLiBUaGlzIG1heSBtYWtlIGl0IGhhcmQgZm9yIHRoZSBncm91cCB0byBob2xkIHRoYXQgaHVtYW4gcmVzcG9uc2libGUuXG4gICAgLy8gT2YgY291cnNlLCB0aGF0J3MgYWxzbyB0cnVlIGlmIHdlIHZlcmlmaWVkIG1lbWJlcnMgYXQgYWxsIHRpbWVzLCBhbmQgaGFkIGJhZCBjb250ZW50IGxlZ2l0aW1hdGVseSBjcmVhdGVkIGJ5IHNvbWVvbmUgd2hvIGdvdCBraWNrZWQgbGF0ZXIuXG5cbiAgICBjb25zdCB2YWxpZGF0aW9uT3B0aW9ucyA9IHttZW1iZXI6IG51bGx9OyAvLyBDb3VsZCBiZSBvbGQgZGF0YSB3cml0dGVuIGJ5IHNvbWVvbmUgd2hvIGlzIG5vIGxvbmdlciBhIG1lbWJlci4gU2VlIG93bmVyTWF0Y2guXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeShzaWduYXR1cmUsIHZhbGlkYXRpb25PcHRpb25zKTtcbiAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gdGhpcy5ub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsICdpbnZhbGlkJywgdmVyaWZpZWQsIHNpZ25hdHVyZSk7XG4gICAgdmVyaWZpZWQuc3luY2hyb25pemVyID0gc3luY2hyb25pemVyO1xuICAgIC8vIFNldCB0aGUgYWN0dWFsIHRhZyB0byB1c2UgYmVmb3JlIHdlIGRvIHRoZSBkaXNhbGxvdyBjaGVja3MuXG4gICAgdGFnID0gdmVyaWZpZWQudGFnID0gcmVxdWlyZVRhZyA/IHRhZyA6IGF3YWl0IHRoaXMudGFnRm9yV3JpdGluZyh0YWcsIHZlcmlmaWVkKTtcbiAgICBjb25zdCBhbnRlY2VkZW50ID0gdGhpcy5hbnRlY2VkZW50KHZlcmlmaWVkKTtcbiAgICBjb25zdCBzeW5jaHJvbml6ZSA9IHRoaXMuc3luY2hyb25pemVBbnRlY2VkZW50KHRhZywgYW50ZWNlZGVudCk7XG4gICAgY29uc3QgZXhpc3RpbmdWZXJpZmllZCA9IHZlcmlmaWVkLmV4aXN0aW5nID0gYW50ZWNlZGVudCAmJiBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWc6IGFudGVjZWRlbnQsIHN5bmNocm9uaXplLCAuLi52YWxpZGF0aW9uT3B0aW9uc30pO1xuICAgIGNvbnN0IGRpc2FsbG93ZWQgPSBhd2FpdCB0aGlzLmRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZ1ZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkKTtcbiAgICB0aGlzLmxvZygndmFsaWRhdGVGb3JXcml0aW5nJywge3RhZywgb3BlcmF0aW9uTGFiZWwsIHJlcXVpcmVUYWcsIGZyb21TeW5jaHJvbml6ZXI6ISFzeW5jaHJvbml6ZXIsIHNpZ25hdHVyZSwgdmVyaWZpZWQsIGFudGVjZWRlbnQsIHN5bmNocm9uaXplLCBleGlzdGluZ1ZlcmlmaWVkLCBkaXNhbGxvd2VkfSk7XG4gICAgaWYgKGRpc2FsbG93ZWQgPT09ICcnKSByZXR1cm4ge3RhZ307IC8vIEFsbG93IG9wZXJhdGlvbiB0byBzaWxlbnRseSBhbnN3ZXIgdGFnLCB3aXRob3V0IHBlcnNpc3Rpbmcgb3IgZW1pdHRpbmcgYW55dGhpbmcuXG4gICAgaWYgKGRpc2FsbG93ZWQpIHJldHVybiB0aGlzLm5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgZGlzYWxsb3dlZCwgdmVyaWZpZWQpO1xuICAgIHRoaXMuZW1pdCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIG1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSkgeyAvLyBSZXR1cm4gYSBzdHJpbmcgdG8gYmUgcGVyc2lzdGVkLiBVc3VhbGx5IGp1c3QgdGhlIHNpZ25hdHVyZS5cbiAgICByZXR1cm4gc2lnbmF0dXJlOyAgLy8gdmFsaWRhdGlvbi5zdHJpbmcgbWlnaHQgYmUgYW4gb2JqZWN0LlxuICB9XG4gIGFzeW5jIHBlcnNpc3QodGFnLCBzaWduYXR1cmVTdHJpbmcsIG9wZXJhdGlvbiA9ICdwdXQnKSB7IC8vIENvbmR1Y3QgdGhlIHNwZWNpZmllZCB0YWcvc2lnbmF0dXJlIG9wZXJhdGlvbiBvbiB0aGUgcGVyc2lzdGVudCBzdG9yZS5cbiAgICByZXR1cm4gKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSlbb3BlcmF0aW9uXSh0YWcsIHNpZ25hdHVyZVN0cmluZyk7XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBEaXNwYXRjaCB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHZlcmlmaWVkfSkpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gQW5zd2VycyB0aGUgQ29sbGVjdGlvbiB0aGF0IGVtaXRzIGluZGl2aWR1YWwgdXBkYXRlcy4gKFNlZSBvdmVycmlkZSBpbiBWZXJzaW9uZWRDb2xsZWN0aW9uLilcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHN5bmNocm9uaXplcnMgPSBuZXcgTWFwKCk7IC8vIHNlcnZpY2VJbmZvIG1pZ2h0IG5vdCBiZSBhIHN0cmluZy5cbiAgbWFwU3luY2hyb25pemVycyhmKSB7IC8vIE9uIFNhZmFyaSwgTWFwLnZhbHVlcygpLm1hcCBpcyBub3QgYSBmdW5jdGlvbiFcbiAgICBjb25zdCByZXN1bHRzID0gW107XG4gICAgZm9yIChjb25zdCBzeW5jaHJvbml6ZXIgb2YgdGhpcy5zeW5jaHJvbml6ZXJzLnZhbHVlcygpKSB7XG4gICAgICByZXN1bHRzLnB1c2goZihzeW5jaHJvbml6ZXIpKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cbiAgZ2V0IHNlcnZpY2VzKCkge1xuICAgIHJldHVybiBBcnJheS5mcm9tKHRoaXMuc3luY2hyb25pemVycy5rZXlzKCkpO1xuICB9XG4gIC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGNvbm5lY3QsIGFuZCBkZWZpbmUgc3luY2hyb25pemUgdG8gYXdhaXQgY29ubmVjdCwgc3luY2hyb25pemF0aW9uQ29tcGxldGUsIGRpc2Nvbm5uZWN0LlxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBTdGFydCBydW5uaW5nIHRoZSBzcGVjaWZpZWQgc2VydmljZXMgKGluIGFkZGl0aW9uIHRvIHdoYXRldmVyIGlzIGFscmVhZHkgcnVubmluZykuXG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBpZiAoc3luY2hyb25pemVycy5oYXMoc2VydmljZSkpIGNvbnRpbnVlO1xuICAgICAgYXdhaXQgU3luY2hyb25pemVyLmNyZWF0ZSh0aGlzLCBzZXJ2aWNlKTsgLy8gUmVhY2hlcyBpbnRvIG91ciBzeW5jaHJvbml6ZXJzIG1hcCBhbmQgc2V0cyBpdHNlbGYgaW1tZWRpYXRlbHkuXG4gICAgfVxuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHMgPT4gcy5ib3RoU2lkZXNDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24pKTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIFNodXQgZG93biB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBjb25zdCBzeW5jaHJvbml6ZXIgPSBzeW5jaHJvbml6ZXJzLmdldChzZXJ2aWNlKTtcbiAgICAgIGlmICghc3luY2hyb25pemVyKSB7XG5cdC8vY29uc29sZS53YXJuKGAke3RoaXMuZnVsbExhYmVsfSBkb2VzIG5vdCBoYXZlIGEgc2VydmljZSBuYW1lZCAnJHtzZXJ2aWNlfScgdG8gZGlzY29ubmVjdC5gKTtcblx0Y29udGludWU7XG4gICAgICB9XG4gICAgICBhd2FpdCBzeW5jaHJvbml6ZXIuZGlzY29ubmVjdCgpO1xuICAgIH1cbiAgfVxuICBhc3luYyBlbnN1cmVTeW5jaHJvbml6ZXIoc2VydmljZU5hbWUsIGNvbm5lY3Rpb24sIGRhdGFDaGFubmVsKSB7IC8vIE1ha2Ugc3VyZSBkYXRhQ2hhbm5lbCBtYXRjaGVzIHRoZSBzeW5jaHJvbml6ZXIsIGNyZWF0aW5nIFN5bmNocm9uaXplciBvbmx5IGlmIG1pc3NpbmcuXG4gICAgbGV0IHN5bmNocm9uaXplciA9IHRoaXMuc3luY2hyb25pemVycy5nZXQoc2VydmljZU5hbWUpO1xuICAgIGlmICghc3luY2hyb25pemVyKSB7XG4gICAgICBzeW5jaHJvbml6ZXIgPSBuZXcgU3luY2hyb25pemVyKHtzZXJ2aWNlTmFtZSwgY29sbGVjdGlvbjogdGhpcywgZGVidWc6IHRoaXMuZGVidWd9KTtcbiAgICAgIHN5bmNocm9uaXplci5jb25uZWN0aW9uID0gY29ubmVjdGlvbjtcbiAgICAgIHN5bmNocm9uaXplci5kYXRhQ2hhbm5lbFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZGF0YUNoYW5uZWwpO1xuICAgICAgdGhpcy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgc3luY2hyb25pemVyKTtcbiAgICAgIC8vIERvZXMgTk9UIHN0YXJ0IHN5bmNocm9uaXppbmcuIENhbGxlciBtdXN0IGRvIHRoYXQgaWYgZGVzaXJlZC4gKFJvdXRlciBkb2Vzbid0IG5lZWQgdG8uKVxuICAgIH0gZWxzZSBpZiAoKHN5bmNocm9uaXplci5jb25uZWN0aW9uICE9PSBjb25uZWN0aW9uKSB8fFxuXHQgICAgICAgKHN5bmNocm9uaXplci5jaGFubmVsTmFtZSAhPT0gZGF0YUNoYW5uZWwubGFiZWwpIHx8XG5cdCAgICAgICAoYXdhaXQgc3luY2hyb25pemVyLmRhdGFDaGFubmVsUHJvbWlzZSAhPT0gZGF0YUNoYW5uZWwpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVubWF0Y2hlZCBjb25uZWN0aW9uIGZvciAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgfVxuXG4gIHByb21pc2Uoa2V5LCB0aHVuaykgeyByZXR1cm4gdGh1bms7IH0gLy8gVE9ETzogaG93IHdpbGwgd2Uga2VlcCB0cmFjayBvZiBvdmVybGFwcGluZyBkaXN0aW5jdCBzeW5jcz9cbiAgc3luY2hyb25pemUxKHRhZykgeyAvLyBDb21wYXJlIGFnYWluc3QgYW55IHJlbWFpbmluZyB1bnN5bmNocm9uaXplZCBkYXRhLCBmZXRjaCB3aGF0J3MgbmVlZGVkLCBhbmQgcmVzb2x2ZSBsb2NhbGx5LlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IHN5bmNocm9uaXplci5zeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZVRhZ3MoKSB7IC8vIEVuc3VyZSB0aGF0IHdlIGhhdmUgdXAgdG8gZGF0ZSB0YWcgbWFwIGFtb25nIGFsbCBzZXJ2aWNlcy4gKFdlIGRvbid0IGNhcmUgeWV0IG9mIHRoZSB2YWx1ZXMgYXJlIHN5bmNocm9uaXplZC4pXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgndGFncycsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplRGF0YSgpIHsgLy8gTWFrZSB0aGUgZGF0YSB0byBtYXRjaCBvdXIgdGFnbWFwLCB1c2luZyBzeW5jaHJvbml6ZTEuXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgnZGF0YScsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIHNldCBvbnVwZGF0ZShoYW5kbGVyKSB7IC8vIEFsbG93IHNldHRpbmcgaW4gbGlldSBvZiBhZGRFdmVudExpc3RlbmVyLlxuICAgIGlmIChoYW5kbGVyKSB7XG4gICAgICB0aGlzLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIHRoaXMuX3VwZGF0ZSk7XG4gICAgICB0aGlzLl91cGRhdGUgPSBoYW5kbGVyO1xuICAgICAgdGhpcy5hZGRFdmVudExpc3RlbmVyKCd1cGRhdGUnLCBoYW5kbGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5yZW1vdmVFdmVudExpc3RlbmVyKCd1cGRhdGUnLCB0aGlzLl91cGRhdGUpO1xuICAgICAgdGhpcy5fdXBkYXRlID0gaGFuZGxlcjtcbiAgICB9XG4gIH1cbiAgZ2V0IG9udXBkYXRlKCkgeyAvLyBBcyBzZXQgYnkgdGhpcy5vbnVwZGF0ZSA9IGhhbmRsZXIuIERvZXMgTk9UIGFuc3dlciB0aGF0IHdoaWNoIGlzIHNldCBieSBhZGRFdmVudExpc3RlbmVyLlxuICAgIHJldHVybiB0aGlzLl91cGRhdGU7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIE11dGFibGVDb2xsZWN0aW9uIGV4dGVuZHMgQ29sbGVjdGlvbiB7XG4gIGFzeW5jIGNoZWNrVGFnKHZlcmlmaWVkKSB7IC8vIE11dGFibGUgdGFnIGNvdWxkIGJlIGFueXRoaW5nLlxuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNoZWNrRGF0ZShleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gZmFpbCBpZiBiYWNrZGF0ZWQuXG4gICAgcmV0dXJuIHRoaXMuY2hlY2tTb21ldGhpbmcoJ2JhY2tkYXRlZCcsICFwcm9wb3NlZC5pYXQgfHxcblx0XHRcdCAgICAgICAoKHByb3Bvc2VkLmlhdCA9PT0gZXhpc3RpbmcuaWF0KSA/IHRoaXMuZmFpck9yZGVyZWRBdXRob3IoZXhpc3RpbmcsIHByb3Bvc2VkKSA6ICAocHJvcG9zZWQuaWF0IDwgZXhpc3RpbmcuaWF0KSksXG5cdFx0XHQgICAgICAgJ2RhdGUnKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgSW1tdXRhYmxlQ29sbGVjdGlvbiBleHRlbmRzIENvbGxlY3Rpb24ge1xuICBjaGVja0RhdGUoZXhpc3RpbmcsIHByb3Bvc2VkKSB7IC8vIE9wIHdpbGwgcmV0dXJuIGV4aXN0aW5nIHRhZyBpZiBtb3JlIHJlY2VudCwgcmF0aGVyIHRoYW4gZmFpbGluZy5cbiAgICBpZiAoIXByb3Bvc2VkLmlhdCkgcmV0dXJuICdubyB0aW1lc3RhbXAnO1xuICAgIHJldHVybiB0aGlzLmNoZWNrU29tZXRoaW5nKCcnLFxuXHRcdFx0ICAgICAgICgocHJvcG9zZWQuaWF0ID09PSBleGlzdGluZy5pYXQpID8gdGhpcy5mYWlyT3JkZXJlZEF1dGhvcihleGlzdGluZywgcHJvcG9zZWQpIDogIChwcm9wb3NlZC5pYXQgPiBleGlzdGluZy5pYXQpKSxcblx0XHRcdCAgICAgICAnZGF0ZScpO1xuICB9XG4gIGFzeW5jIGNoZWNrVGFnKHZlcmlmaWVkKSB7IC8vIElmIHRoZSB0YWcgZG9lc24ndCBtYXRjaCB0aGUgZGF0YSwgc2lsZW50bHkgdXNlIHRoZSBleGlzdGluZyB0YWcsIGVsc2UgZmFpbCBoYXJkLlxuICAgIHJldHVybiB0aGlzLmNoZWNrU29tZXRoaW5nKHZlcmlmaWVkLmV4aXN0aW5nID8gJycgOiAnd3JvbmcgdGFnJywgdmVyaWZpZWQudGFnICE9PSBhd2FpdCB0aGlzLmhhc2godmVyaWZpZWQpLCAnaW1tdXRhYmxlIHRhZycpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBTdGF0ZUNvbGxlY3Rpb24gZXh0ZW5kcyBJbW11dGFibGVDb2xsZWN0aW9uIHtcbiAgLy8gQSBwcm9wZXJ0eSBuYW1lZCBtZXNzYWdlIG1heSBiZSBpbmNsdWRlZCBpbiB0aGUgZGF0YSwgd2hpY2ggdGVsbCB0aGUgYXBwbGljYXRpb24gaG93IHRvIHJlYnVpbGQgc3RhdGVzIGluIGEgZGlmZmVyZW50IG9yZGVyIGZvciBtZXJnaW5nLlxuICAvLyBBIG9wdGlvbiBuYW1lZCBhbnRlY2VkZW50IG1heSBiZSBwcm92aWRlZCB0aGF0IGlkZW50aWZpZXMgdGhlIHByZWNlZGluZyBzdGF0ZSAoYmVmb3JlIHRoZSBtZXNzYWdlIHdhcyBhcHBsaWVkKS5cblxuICBhc3luYyBwcmVwcm9jZXNzRm9yU2lnbmluZyhkYXRhLCB7c3ViamVjdCwgLi4ub3B0aW9uc30pIHtcbiAgICAvLyBXZSBhcmUgdXN1YWxseSBnaXZlbiBhbiBvdmVyYWxsIFZlcnNpb25lZENvbGxlY3Rpb24gc3ViamVjdCwgd2hpY2ggd2UgbmVlZCBpbiB0aGUgc2lnbmF0dXJlIGhlYWRlciBzbyB0aGF0IHVwZGF0ZSBldmVudHMgY2FuIHNlZSBpdC5cbiAgICAvLyBJZiBub3Qgc3BlY2lmaWVkIChlLmcuLCB0YWcgY291bGQgYmUgb21taXR0ZWQgaW4gZmlyc3QgdmVyc2lvbiksIHRoZW4gZ2VuZXJhdGUgaXQgaGVyZSwgYWZ0ZXIgc3VwZXIgaGFzIG1heWJlIGVuY3J5cHRlZC5cbiAgICBbZGF0YSwgb3B0aW9uc10gPSBhd2FpdCBzdXBlci5wcmVwcm9jZXNzRm9yU2lnbmluZyhkYXRhLCBvcHRpb25zKTtcbiAgICBpZiAoIXN1YmplY3QpIHtcbiAgICAgIGlmIChBcnJheUJ1ZmZlci5pc1ZpZXcoZGF0YSkpIHN1YmplY3QgPSBhd2FpdCB0aGlzLmhhc2goe3BheWxvYWQ6IGRhdGF9KTtcbiAgICAgIGVsc2UgaWYgKHR5cGVvZihkYXRhKSA9PT0gJ3N0cmluZycpIHN1YmplY3QgPSBhd2FpdCB0aGlzLmhhc2goe3RleHQ6IGRhdGF9KTtcbiAgICAgIGVsc2Ugc3ViamVjdCA9IGF3YWl0IHRoaXMuaGFzaCh7dGV4dDogSlNPTi5zdHJpbmdpZnkoZGF0YSl9KTtcbiAgICB9XG4gICAgcmV0dXJuIFtkYXRhLCB7c3ViamVjdCwgLi4ub3B0aW9uc31dO1xuICB9XG4gIGhhc2hhYmxlUGF5bG9hZCh2YWxpZGF0aW9uKSB7IC8vIEluY2x1ZGUgYW50IHx8IGlhdC5cbiAgICBjb25zdCBwYXlsb2FkID0gc3VwZXIuaGFzaGFibGVQYXlsb2FkKHZhbGlkYXRpb24pO1xuICAgIGNvbnN0IHtwcm90ZWN0ZWRIZWFkZXJ9ID0gdmFsaWRhdGlvbjtcbiAgICBpZiAoIXByb3RlY3RlZEhlYWRlcikgcmV0dXJuIHBheWxvYWQ7IC8vIFdoZW4gdXNlZCBmb3Igc3ViamVjdCBoYXNoKCkgaW4gcHJlcHJvY2Vzc0ZvclNpZ25pbmcoKS5cbiAgICBjb25zdCB7YW50LCBpYXR9ID0gdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXI7XG4gICAgdGhpcy5sb2coJ2hhc2hpbmcnLCB7cGF5bG9hZCwgYW50LCBpYXR9KTtcbiAgICByZXR1cm4gcGF5bG9hZCArIChhbnQgfHwgaWF0IHx8ICcnKTtcbiAgfVxuICBhc3luYyBjaGVja1RhZyh2ZXJpZmllZCkge1xuICAgIGNvbnN0IHRhZyA9IHZlcmlmaWVkLnRhZztcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgdGhpcy5oYXNoKHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdGhpcy5jaGVja1NvbWV0aGluZygnd3Jvbmcgc3RhdGUgdGFnJywgdGFnICE9PSBoYXNoLCAnc3RhdGUgdGFnJyk7XG4gIH1cbiAgY2hlY2tEYXRlKCkgeyAvLyBhbHdheXMgb2tcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBnZXRPd25lcihwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gUmV0dXJuIHRoZSB0YWcgb2Ygd2hhdCBzaGFsbCBiZSBjb25zaWRlcmVkIHRoZSBvd25lci5cbiAgICBjb25zdCB7Z3JvdXAsIGluZGl2aWR1YWx9ID0gcHJvdGVjdGVkSGVhZGVyO1xuICAgIHJldHVybiBncm91cCB8fCBpbmRpdmlkdWFsIHx8IHN1cGVyLmdldE93bmVyKHByb3RlY3RlZEhlYWRlcik7XG4gIH1cbiAgYW50ZWNlZGVudCh2YWxpZGF0aW9uKSB7XG4gICAgaWYgKHZhbGlkYXRpb24udGV4dCA9PT0gJycpIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRGVsZXRlIGNvbXBhcmVzIHdpdGggd2hhdCdzIHRoZXJlXG4gICAgcmV0dXJuIHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLmFudDtcbiAgfVxuICAvLyBmaXhtZTogcmVtb3ZlKCkgP1xuICBhc3luYyBmb3JFYWNoU3RhdGUodGFnLCBjYWxsYmFjaywgcmVzdWx0ID0gbnVsbCkgeyAvLyBhd2FpdCBjYWxsYmFjayh2ZXJpZmllZFN0YXRlLCB0YWcpIG9uIHRoZSBzdGF0ZSBjaGFpbiBzcGVjaWZpZWQgYnkgdGFnLlxuICAgIC8vIFN0b3BzIGl0ZXJhdGlvbiBhbmQgcmVzb2x2ZXMgd2l0aCB0aGUgZmlyc3QgdHJ1dGh5IHZhbHVlIGZyb20gY2FsbGJhY2suIE90aGVyd2lzZSwgcmVzb2x2ZXMgd2l0aCByZXN1bHQuXG4gICAgd2hpbGUgKHRhZykge1xuICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIG1lbWJlcjogbnVsbCwgc3luY2hyb25pemU6IGZhbHNlfSk7XG4gICAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhbGxiYWNrKHZlcmlmaWVkLCB0YWcpOyAvLyB2ZXJpZmllZCBpcyBub3QgZGVjcnlwdGVkXG4gICAgICBpZiAocmVzdWx0KSByZXR1cm4gcmVzdWx0O1xuICAgICAgdGFnID0gdGhpcy5hbnRlY2VkZW50KHZlcmlmaWVkKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICBhc3luYyBjb21tb25TdGF0ZShzdGF0ZVRhZ3MpIHtcbiAgICAvLyBSZXR1cm4gYSBsaXN0IGluIHdoaWNoOlxuICAgIC8vIC0gVGhlIGZpcnN0IGVsZW1lbnQgaXMgdGhlIG1vc3QgcmVjZW50IHN0YXRlIHRoYXQgaXMgY29tbW9uIGFtb25nIHRoZSBlbGVtZW50cyBvZiBzdGF0ZVRhZ3NcbiAgICAvLyAgIGRpc3JlZ2FyZGluZyBzdGF0ZXMgdGhhdCB3aG9seSBhIHN1YnNldCBvZiBhbm90aGVyIGluIHRoZSBsaXN0LlxuICAgIC8vICAgVGhpcyBtaWdodCBub3QgYmUgYXQgdGhlIHNhbWUgZGVwdGggZm9yIGVhY2ggb2YgdGhlIGxpc3RlZCBzdGF0ZXMhXG4gICAgLy8gLSBUaGUgcmVtYWluaW5nIGVsZW1lbnRzIGNvbnRhaW5zIGFsbCBhbmQgb25seSB0aG9zZSB2ZXJpZmllZFN0YXRlcyB0aGF0IGFyZSBpbmNsdWRlZCBpbiB0aGUgaGlzdG9yeSBvZiBzdGF0ZVRhZ3NcbiAgICAvLyAgIGFmdGVyIHRoZSBjb21tb24gc3RhdGUgb2YgdGhlIGZpcnN0IGVsZW1lbnQgcmV0dXJuZWQuIFRoZSBvcmRlciBvZiB0aGUgcmVtYWluaW5nIGVsZW1lbnRzIGRvZXMgbm90IG1hdHRlci5cbiAgICAvL1xuICAgIC8vIFRoaXMgaW1wbGVtZW50YXRpb24gbWluaW1pemVzIGFjY2VzcyB0aHJvdWdoIHRoZSBoaXN0b3J5LlxuICAgIC8vIChJdCB0cmFja3MgdGhlIHZlcmlmaWVkU3RhdGVzIGF0IGRpZmZlcmVudCBkZXB0aHMsIGluIG9yZGVyIHRvIGF2b2lkIGdvaW5nIHRocm91Z2ggdGhlIGhpc3RvcnkgbXVsdGlwbGUgdGltZXMuKVxuICAgIC8vIEhvd2V2ZXIsIGlmIHRoZSBmaXJzdCBzdGF0ZSBpbiB0aGUgbGlzdCBpcyBhIHJvb3Qgb2YgYWxsIHRoZSBvdGhlcnMsIGl0IHdpbGwgdHJhdmVyc2UgdGhhdCBmYXIgdGhyb3VnaCB0aGUgb3RoZXJzLlxuXG4gICAgaWYgKHN0YXRlVGFncy5sZW5ndGggPD0gMSkgcmV0dXJuIHN0YXRlVGFncztcblxuICAgIC8vIENoZWNrIGVhY2ggc3RhdGUgaW4gdGhlIGZpcnN0IHN0YXRlJ3MgYW5jZXN0cnksIGFnYWluc3QgYWxsIG90aGVyIHN0YXRlcywgYnV0IG9ubHkgZ28gYXMgZGVlcCBhcyBuZWVkZWQuXG4gICAgbGV0IFtvcmlnaW5hbENhbmRpZGF0ZVRhZywgLi4ub3JpZ2luYWxPdGhlclN0YXRlVGFnc10gPSBzdGF0ZVRhZ3M7XG4gICAgbGV0IGNhbmRpZGF0ZVRhZyA9IG9yaWdpbmFsQ2FuZGlkYXRlVGFnOyAvLyBXaWxsIHRha2Ugb24gc3VjY2Vzc2l2ZSB2YWx1ZXMgaW4gdGhlIG9yaWdpbmFsQ2FuZGlkYXRlVGFnIGhpc3RvcnkuXG5cbiAgICAvLyBBcyB3ZSBkZXNjZW5kIHRocm91Z2ggdGhlIGZpcnN0IHN0YXRlJ3MgY2FuZGlkYXRlcywga2VlcCB0cmFjayBvZiB3aGF0IHdlIGhhdmUgc2VlbiBhbmQgZ2F0aGVyZWQuXG4gICAgbGV0IGNhbmRpZGF0ZVZlcmlmaWVkU3RhdGVzID0gbmV3IE1hcCgpO1xuICAgIC8vIEZvciBlYWNoIG9mIHRoZSBvdGhlciBzdGF0ZXMgKGFzIGVsZW1lbnRzIGluIHRocmVlIGFycmF5cyk6XG4gICAgY29uc3Qgb3RoZXJTdGF0ZVRhZ3MgPSBbLi4ub3JpZ2luYWxPdGhlclN0YXRlVGFnc107IC8vIFdpbGwgYmUgYmFzaGVkIGFzIHdlIGRlc2NlbmQuXG4gICAgY29uc3Qgb3RoZXJWZXJpZmllZFN0YXRlcyA9IG90aGVyU3RhdGVUYWdzLm1hcCgoKSA9PiBbXSk7ICAgICAvLyBCdWlsZCB1cCBsaXN0IG9mIHRoZSB2ZXJpZmllZFN0YXRlcyBzZWVuIHNvIGZhci5cbiAgICBjb25zdCBvdGhlcnNTZWVuID0gb3RoZXJTdGF0ZVRhZ3MubWFwKCgpID0+IG5ldyBNYXAoKSk7IC8vIEtlZXAgYSBtYXAgb2YgZWFjaCBoYXNoID0+IHZlcmlmaWVkU3RhdGVzIHNlZW4gc28gZmFyLlxuICAgIC8vIFdlIHJlc2V0IHRoZXNlLCBzcGxpY2luZyBvdXQgdGhlIG90aGVyIGRhdGEuXG4gICAgZnVuY3Rpb24gcmVzZXQobmV3Q2FuZGlkYXRlLCBvdGhlckluZGV4KSB7IC8vIFJlc2V0IHRoZSBhYm92ZSBmb3IgYW5vdGhlciBpdGVyYXRpb24gdGhyb3VnaCB0aGUgZm9sbG93aW5nIGxvb3AsXG4gICAgICAvLyB3aXRoIG9uZSBvZiB0aGUgb3RoZXJEYXRhIHJlbW92ZWQgKGFuZCB0aGUgc2Vlbi92ZXJpZmllZFN0YXRlcyBmb3IgdGhlIHJlbWFpbmluZyBpbnRhY3QpLlxuICAgICAgLy8gVGhpcyBpcyB1c2VkIHdoZW4gb25lIG9mIHRoZSBvdGhlcnMgcHJvdmVzIHRvIGJlIGEgc3Vic2V0IG9yIHN1cGVyc2V0IG9mIHRoZSBjYW5kaWRhdGUuXG4gICAgICBjYW5kaWRhdGVUYWcgPSBuZXdDYW5kaWRhdGU7XG4gICAgICBjYW5kaWRhdGVWZXJpZmllZFN0YXRlcyA9IG51bGw7XG4gICAgICBbb3JpZ2luYWxPdGhlclN0YXRlVGFncywgb3RoZXJTdGF0ZVRhZ3MsIG90aGVyVmVyaWZpZWRTdGF0ZXMsIG90aGVyc1NlZW5dLmZvckVhY2goZGF0dW0gPT4gZGF0dW0uc3BsaWNlKG90aGVySW5kZXgsIDEpKTtcbiAgICB9XG4gICAgY29uc3Qga2V5ID0gdmVyaWZpZWQgPT4geyAvLyBCeSB3aGljaCB0byBkZWR1cGUgc3RhdGUgcmVjb3Jkcy5cbiAgICAgIHJldHVybiB2ZXJpZmllZC50YWc7XG4gICAgfTtcbiAgICBjb25zdCBpc0NhbmRpZGF0ZUluRXZlcnlIaXN0b3J5ID0gYXN5bmMgKCkgPT4geyAvLyBUcnVlIElGRiB0aGUgY3VycmVudCBjYW5kaWRhdGVUYWcgYXBwZWFyIGluIGFsbCB0aGUgb3RoZXJzLlxuICAgICAgZm9yIChjb25zdCBvdGhlckluZGV4IGluIG90aGVyc1NlZW4pIHsgLy8gU3VidGxlOiB0aGUgZm9sbG93aW5nIGhhcyBzaWRlLWVmZmVjdHMsIHNvIGNhbGxzIG11c3QgYmUgaW4gc2VyaWVzLlxuXHRpZiAoIWF3YWl0IGlzQ2FuZGlkYXRlSW5IaXN0b3J5KG90aGVyc1NlZW5bb3RoZXJJbmRleF0sIG90aGVySW5kZXgpKSByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9O1xuICAgIGNvbnN0IGlzQ2FuZGlkYXRlSW5IaXN0b3J5ID0gYXN5bmMgKG90aGVyU2Vlbiwgb3RoZXJJbmRleCkgPT4geyAvLyBUcnVlIElGRiB0aGUgY3VycmVudCBjYW5kaWRhdGUgaXMgaW4gdGhlIGdpdmVuIFN0YXRlJ3MgaGlzdG9yeS5cbiAgICAgIC8vIEhvd2V2ZXIsIGlmIGNhbmRpZGF0ZS9vdGhlciBhcmUgaW4gYSBsaW5lYXIgY2hhaW4sIGFuc3dlciBmYWxzZSBhbmQgcmVzZXQgdGhlIGxvb3Agd2l0aCBvdGhlciBzcGxpY2VkIG91dC5cbiAgICAgIHdoaWxlICghb3RoZXJTZWVuLmhhcyhjYW5kaWRhdGVUYWcpKSB7IC8vIEZhc3QgY2hlY2sgb2Ygd2hhdCB3ZSd2ZSBzZWVuIHNvIGZhci5cblx0Y29uc3Qgb3RoZXJUYWcgPSBvdGhlclN0YXRlVGFnc1tvdGhlckluZGV4XTsgLy8gQXMgd2UgZ28sIHdlIHJlY29yZCB0aGUgZGF0YSBzZWVuIGZvciB0aGlzIG90aGVyIFN0YXRlLlxuXHRpZiAoIW90aGVyVGFnKSByZXR1cm4gZmFsc2U7ICAgICAgICAgICAgICAgICAgICAgICAgIC8vIElmIG5vdCBhdCBlbmQuLi4gZ28gb25lIGZ1cnRoZXIgbGV2ZWwgZGVlcGVyIGluIHRoaXMgc3RhdGUuXG5cdGNvbnN0IHNlZW5WZXJpZmllZFN0YXRlcyA9IG90aGVyVmVyaWZpZWRTdGF0ZXNbb3RoZXJJbmRleF07ICAgLy8gTm90ZSBpbiBvdXIgaGFzaCA9PiBtZXNzYWdlIG1hcCwgYSBjb3B5IG9mIHRoZSB2ZXJpZmllZFN0YXRlcyBzZWVuLlxuXHRvdGhlclNlZW4uc2V0KG90aGVyVGFnLCBzZWVuVmVyaWZpZWRTdGF0ZXMuc2xpY2UoKSk7ICAvLyBBbmQgYWRkIHRoaXMgc3RhdGUncyBtZXNzYWdlIGZvciBvdXIgbWVzc2FnZSBhY2N1bXVsYXRvci5cblx0Y29uc3QgdmVyaWZpZWRTdGF0ZSA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZzogb3RoZXJUYWcsIG1lbWJlcjogbnVsbCwgc3luY2hyb25pemU6IGZhbHNlfSk7XG5cdGlmICh2ZXJpZmllZFN0YXRlKSBzZWVuVmVyaWZpZWRTdGF0ZXMucHVzaCh2ZXJpZmllZFN0YXRlKTtcblx0b3RoZXJTdGF0ZVRhZ3Nbb3RoZXJJbmRleF0gPSB0aGlzLmFudGVjZWRlbnQodmVyaWZpZWRTdGF0ZSk7XG4gICAgICB9XG4gICAgICAvLyBJZiBjYW5kaWRhdGUgb3IgdGhlIG90aGVyIGlzIHdob2x5IGEgc3Vic2V0IG9mIHRoZSBvdGhlciBpbiBhIGxpbmVhciBjaGFpbiwgZGlzcmVnYXJkIHRoZSBzdWJzZXQuXHQgIFxuICAgICAgLy8gSW4gb3RoZXIgd29yZHMsIHNlbGVjdCB0aGUgbG9uZ2VyIGNoYWluIHJhdGhlciB0aGFuIHNlZWtpbmcgdGhlIGNvbW1vbiBhbmNlc3RvciBvZiB0aGUgY2hhaW4uXG5cbiAgICAgIC8vIE9yaWdpbmFsIGNhbmRpZGF0ZSAoc2luY2UgcmVzZXQpIGlzIGEgc3Vic2V0IG9mIHRoaXMgb3RoZXI6IHRyeSBhZ2FpbiB3aXRoIHRoaXMgb3RoZXIgYXMgdGhlIGNhbmRpZGF0ZS5cbiAgICAgIGlmIChjYW5kaWRhdGVUYWcgPT09IG9yaWdpbmFsQ2FuZGlkYXRlVGFnKSByZXR1cm4gcmVzZXQob3JpZ2luYWxDYW5kaWRhdGVUYWcgPSBvcmlnaW5hbE90aGVyU3RhdGVUYWdzW290aGVySW5kZXhdKTtcbiAgICAgIC8vIE9yaWdpbmFsIGNhbmRpZGF0ZSAoc2luY2UgcmVzZXQpIGlzIHN1cGVyc2V0IG9mIHRoaXMgb3RoZXI6IHRyeSBhZ2FpbiB3aXRob3V0IHRoaXMgY2FuZGlkYXRlXG4gICAgICBpZiAoY2FuZGlkYXRlVGFnID09PSBvcmlnaW5hbE90aGVyU3RhdGVUYWdzW290aGVySW5kZXhdKSByZXR1cm4gcmVzZXQob3JpZ2luYWxDYW5kaWRhdGVUYWcpO1xuICAgICAgcmV0dXJuIHRydWU7ICAvLyBXZSBmb3VuZCBhIG1hdGNoIVxuICAgIH07XG5cbiAgICB3aGlsZSAoY2FuZGlkYXRlVGFnKSB7XG4gICAgICBpZiAoYXdhaXQgaXNDYW5kaWRhdGVJbkV2ZXJ5SGlzdG9yeSgpKSB7IC8vIFdlIGZvdW5kIGEgbWF0Y2ggaW4gZWFjaCBvZiB0aGUgb3RoZXIgU3RhdGVzOiBwcmVwYXJlIHJlc3VsdHMuXG5cdC8vIEdldCB0aGUgdmVyaWZpZWRTdGF0ZXMgdGhhdCB3ZSBhY2N1bXVsYXRlZCBmb3IgdGhhdCBwYXJ0aWN1bGFyIFN0YXRlIHdpdGhpbiB0aGUgb3RoZXJzLlxuXHRvdGhlcnNTZWVuLmZvckVhY2gobWVzc2FnZU1hcCA9PiBtZXNzYWdlTWFwLmdldChjYW5kaWRhdGVUYWcpLmZvckVhY2gobWVzc2FnZSA9PiBjYW5kaWRhdGVWZXJpZmllZFN0YXRlcy5zZXQoa2V5KG1lc3NhZ2UpLCBtZXNzYWdlKSkpO1xuXHRyZXR1cm4gW2NhbmRpZGF0ZVRhZywgLi4uY2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMudmFsdWVzKCldOyAvLyBXZSdyZSBkb25lIVxuICAgICAgfSBlbHNlIGlmIChjYW5kaWRhdGVWZXJpZmllZFN0YXRlcykge1xuXHQvLyBNb3ZlIHRvIHRoZSBuZXh0IGNhbmRpZGF0ZSAob25lIHN0ZXAgYmFjayBpbiB0aGUgZmlyc3Qgc3RhdGUncyBhbmNlc3RyeSkuXG5cdGNvbnN0IHZlcmlmaWVkU3RhdGUgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWc6IGNhbmRpZGF0ZVRhZywgbWVtYmVyOiBudWxsLCBzeW5jaHJvbml6ZTogZmFsc2V9KTtcblx0aWYgKCF2ZXJpZmllZFN0YXRlKSByZXR1cm4gW107IC8vIEZlbGwgb2ZmIHRoZSBlbmQuXG5cdFx0Y2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMuc2V0KGtleSh2ZXJpZmllZFN0YXRlKSwgdmVyaWZpZWRTdGF0ZSk7XG5cdGNhbmRpZGF0ZVRhZyA9IHRoaXMuYW50ZWNlZGVudCh2ZXJpZmllZFN0YXRlKTtcbiAgICAgIH0gZWxzZSB7IC8vIFdlJ3ZlIGJlZW4gcmVzZXQgdG8gc3RhcnQgb3Zlci5cblx0Y2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMgPSBuZXcgTWFwKCk7XG4gICAgICB9XG4gICAgfSAvLyBlbmQgd2hpbGVcblxuICAgIHJldHVybiBbXTsgICAvLyBObyBjb21tb24gYW5jZXN0b3IgZm91bmRcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbiBleHRlbmRzIE11dGFibGVDb2xsZWN0aW9uIHtcbiAgLy8gQSBWZXJzaW9uZWRDb2xsZWN0aW9uIGNhbiBiZSB1c2VkIGxpa2UgYW55IE11dGFibGVDb2xsZWN0aW9uLCByZXRyaWV2aW5nIHRoZSBtb3N0IHJlY2VudGx5IHN0b3JlZCBzdGF0ZS5cbiAgLy8gSXQgaGFzIHR3byBhZGRpdGlvbmFsIGZ1bmN0aW9uYWxpdGllczpcbiAgLy8gMS4gUHJldmlvdXMgc3RhdGVzIGNhbiBiZSByZXRyaWV2ZWQsIGVpdGhlciBieSB0YWcgb3IgYnkgdGltZXN0YW1wLlxuICAvLyAyLiBJRkYgdGhlIGRhdGEgcHJvdmlkZWQgYnkgdGhlIGFwcGxpY2F0aW9uIGluY2x1ZGVzIGEgc2luZ2xlIG1lc3NhZ2UsIGFjdGlvbiwgb3IgZGVsdGEgZm9yIGVhY2ggdmVyc2lvbixcbiAgLy8gICAgdGhlbiwgbWVyZ2luZyBvZiB0d28gYnJhbmNoZXMgb2YgdGhlIHNhbWUgaGlzdG9yeSBjYW4gYmUgYWNjb21wbGlzaGVkIGJ5IGFwcGx5aW5nIHRoZXNlIG1lc3NhZ2VzIHRvXG4gIC8vICAgIHJlY29uc3RydWN0IGEgY29tYmluZWQgaGlzdG9yeSAoc2ltaWxhcmx5IHRvIGNvbWJpbmluZyBicmFuY2hlcyBvZiBhIHRleHQgdmVyc2lvbmluZyBzeXN0ZW0pLlxuICAvLyAgICBJbiB0aGlzIGNhc2UsIHRoZSBhcHBsaWNhdGlvbiBtdXN0IHByb3ZpZGUgdGhlIG9wZXJhdGlvbiB0byBwcm9kdWNlIGEgbmV3IHN0YXRlIGZyb20gYW4gYW50ZWNlZGVudCBzdGF0ZVxuICAvLyAgICBhbmQgbWVzc3NhZ2UsIGFuZCB0aGUgVmVyc2lvbmVkQ29sbGVjdGlvbiB3aWxsIHByb3ZpZGUgdGhlIGNvcnJlY3QgY2FsbHMgdG8gbWFuYWdlIHRoaXMuXG4gIGFzeW5jIHN0b3JlKGRhdGEsIHRhZ09yT3B0aW9ucyA9IHt9KSB7XG4gICAgLy8gSGlkZGVuIHB1bjpcbiAgICAvLyBUaGUgZmlyc3Qgc3RvcmUgbWlnaHQgc3VjY2VlZCwgZW1pdCB0aGUgdXBkYXRlIGV2ZW50LCBwZXJzaXN0Li4uIGFuZCB0aGVuIGZhaWwgb24gdGhlIHNlY29uZCBzdG9yZS5cbiAgICAvLyBIb3dldmVyLCBpdCBqdXN0IHNvIGhhcHBlbnMgdGhhdCB0aGV5IGJvdGggZmFpbCB1bmRlciB0aGUgc2FtZSBjaXJjdW1zdGFuY2VzLiBDdXJyZW50bHkuXG4gICAgbGV0IHt0YWcsIGVuY3J5cHRpb24sIC4uLm9wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zKTtcbiAgICBjb25zdCByb290ID0gdGFnICYmIGF3YWl0IHRoaXMuZ2V0Um9vdCh0YWcsIGZhbHNlKTtcbiAgICBjb25zdCB2ZXJzaW9uVGFnID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5zdG9yZShkYXRhLCB7ZW5jcnlwdGlvbiwgYW50OiByb290LCBzdWJqZWN0OiB0YWcsIC4uLm9wdGlvbnN9KTtcbiAgICB0aGlzLmxvZygnc3RvcmU6IHJvb3QnLCB7dGFnLCBlbmNyeXB0aW9uLCBvcHRpb25zLCByb290LCB2ZXJzaW9uVGFnfSk7XG4gICAgaWYgKCF2ZXJzaW9uVGFnKSByZXR1cm4gJyc7XG4gICAgY29uc3Qgc2lnbmluZ09wdGlvbnMgPSB7XG4gICAgICB0YWc6IHRhZyB8fCAoYXdhaXQgdGhpcy52ZXJzaW9ucy5nZXRWZXJpZmllZCh7dGFnOiB2ZXJzaW9uVGFnLCBtZW1iZXI6IG51bGx9KSkucHJvdGVjdGVkSGVhZGVyLnN1YixcbiAgICAgIGVuY3J5cHRpb246ICcnLFxuICAgICAgLi4ub3B0aW9uc1xuICAgIH07XG4gICAgcmV0dXJuIHN1cGVyLnN0b3JlKFt2ZXJzaW9uVGFnXSwgc2lnbmluZ09wdGlvbnMpO1xuICB9XG4gIGFzeW5jIHJlbW92ZSh0YWdPck9wdGlvbnMpIHtcbiAgICBjb25zdCB7dGFnLCBlbmNyeXB0aW9uLCAuLi5vcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMxKHRhZ09yT3B0aW9ucyk7XG4gICAgYXdhaXQgdGhpcy5mb3JFYWNoU3RhdGUodGFnLCAoXywgaGFzaCkgPT4geyAvLyBTdWJ0bGU6IGRvbid0IHJldHVybiBlYXJseSBieSByZXR1cm5pbmcgdHJ1dGh5LlxuICAgICAgLy8gVGhpcyBtYXkgYmUgb3ZlcmtpbGwgdG8gYmUgdXNpbmcgaGlnaC1sZXZlbCByZW1vdmUsIGluc3RlYWQgb2YgcHV0IG9yIGV2ZW4gcGVyc2lzdC4gV2UgRE8gd2FudCB0aGUgdXBkYXRlIGV2ZW50IHRvIGZpcmUhXG4gICAgICAvLyBTdWJ0bGU6IHRoZSBhbnQgaXMgbmVlZGVkIHNvIHRoYXQgd2UgZG9uJ3Qgc2lsZW50bHkgc2tpcCB0aGUgYWN0dWFsIHB1dC9ldmVudC5cbiAgICAgIC8vIFN1YnRsZTogc3ViamVjdCBpcyBuZWVkZWQgc28gdGhhdCB1cGRhdGUgZXZlbnRzIGNhbiBsZWFybiB0aGUgVmVyc2lvbmVkIHN0YWcuXG4gICAgICB0aGlzLnZlcnNpb25zLnJlbW92ZSh7dGFnOiBoYXNoLCBhbnQ6IGhhc2gsIHN1YmplY3Q6IHRhZywgZW5jcnlwdGlvbjogJycsIC4uLm9wdGlvbnN9KTtcbiAgICB9KTtcbiAgICByZXR1cm4gc3VwZXIucmVtb3ZlKHRhZ09yT3B0aW9ucyk7XG4gIH1cbiAgYXN5bmMgcmV0cmlldmUodGFnT3JPcHRpb25zKSB7XG4gICAgbGV0IHt0YWcsIHRpbWUsIGhhc2gsIC4uLm9wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zKTtcbiAgICBpZiAoIWhhc2ggJiYgIXRpbWUpIGhhc2ggPSBhd2FpdCB0aGlzLmdldFJvb3QodGFnKTtcbiAgICB0aGlzLmxvZygncmV0cmlldmUnLCB7dGFnLCB0aW1lLCBoYXNoLCBvcHRpb25zfSk7XG4gICAgaWYgKGhhc2gpIHJldHVybiB0aGlzLnZlcnNpb25zLnJldHJpZXZlKHt0YWc6IGhhc2gsIC4uLm9wdGlvbnN9KTtcbiAgICB0aW1lID0gcGFyc2VGbG9hdCh0aW1lKTtcbiAgICByZXR1cm4gdGhpcy5mb3JFYWNoU3RhdGUodGFnLCB2ZXJpZmllZCA9PiAodmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmlhdCA8PSB0aW1lKSAmJiB2ZXJpZmllZCk7XG4gIH1cblxuICBjaGVja0RhdGUoZXhpc3RpbmcsIHByb3Bvc2VkKSB7IC8vIENhbiBhbHdheXMgbWVyZ2UgaW4gYW4gb2xkZXIgbWVzc2FnZS4gV2Uga2VlcCAnZW0gYWxsLlxuICAgIHJldHVybiBudWxsO1xuICB9XG4gIC8vIElmIGEgbm9uLW93bmVyIGlzIGdpdmVuIGEgc3RhdGUgdGhhdCBpcyBub3QgYSBzdWJzZXQgb2YgdGhlIGV4aXN0aW5nIChvciB2aWNlIHZlcnNhKSwgdGhlbiBpdCBjcmVhdGVzIGEgbmV3XG4gIC8vIGNvbWJpbmVkIHJlY29yZCB0aGF0IGxpc3RzIHRoZSBnaXZlbiBhbmQgZXhpc3Rpbmcgc3RhdGVzLiBJbiB0aGlzIGNhc2UsIHdlIHN0aWxsIG5lZWQgdG8gcHJlc2VydmUgdGhlXG4gIC8vIG9yaWdpbmFsIG93bmVyIHNvIHRoYXQgbGF0ZXIgbWVyZ2VycyBjYW4gd2hldGhlciBvciBub3QgdGhleSBhcmUgb3duZXJzLiAoSWYgdGhleSBsaWUsIHRoZSB0cnVlIGdyb3VwIG93bmVyc1xuICAvLyB3aWxsIGlnbm9yZSB0aGUgZ2FyYmFnZSBkYXRhLCBzbyBpdCdzIG5vdCBzZWN1cml0eSBpc3N1ZS4pIEl0IGRvZXNuJ3QgaGVscCB0byBnZXQgdGhlIG93bmVyIGJ5IGZvbGxvd2luZ1xuICAvLyB0aGUgdGFnIHRocm91Z2ggdG8gdGhlIHN0YXRlJ3Mgc2lnbmF0dXJlLCBiZWNhdXNlIGluIHNvbWUgY2FzZXMsIG5vbi1tZW1iZXJzIG1heSBiZSBhbGxvd2VkIHRvIGluamVjdFxuICAvLyBhIG1lc3NhZ2UgaW50byB0aGUgZ3JvdXAsIGluIHdoaWNoIGNhc2UgdGhlIHN0YXRlIHdvbid0IGJlIHNpZ25lZCBieSB0aGUgZ3JvdXAgZWl0aGVyLiBPdXIgc29sdXRpb24gaXNcbiAgLy8gdG8gaW50cm9kdWNlIG5ldyB0YWdzIHRvIGxhYmVsIHRoZSBvcmlnaW5hbCBvd25lci4gV2UgbmVlZCB0d28gdGFncyBiZWNhdXNlIHdlIGFsc28gdG8ga25vdyB3aGV0aGVyIHRoZVxuICAvLyBvcmlnaW5hbCBvd25lciB3YXMgYSBncm91cCBvciBhbiBpbmRpdmlkdWFsLlxuICBnZXRPd25lcihwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gVXNlZCBpbiBjaGVja093bmVyLlxuICAgIGNvbnN0IHtncm91cCwgaW5kaXZpZHVhbH0gPSBwcm90ZWN0ZWRIZWFkZXI7XG4gICAgcmV0dXJuIGdyb3VwIHx8IGluZGl2aWR1YWwgfHwgc3VwZXIuZ2V0T3duZXIocHJvdGVjdGVkSGVhZGVyKTtcbiAgfVxuICBnZW5lcmF0ZU93bmVyT3B0aW9ucyhwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gR2VuZXJhdGUgdHdvIHNldHMgb2Ygc2lnbmluZyBvcHRpb25zOiBvbmUgZm9yIG93bmVyIHRvIHVzZSwgYW5kIG9uZSBmb3Igb3RoZXJzXG4gICAgLy8gVGhlIHNwZWNpYWwgaGVhZGVyIGNsYWltcyAnZ3JvdXAnIGFuZCAnaW5kaXZpZHVhbCcgYXJlIGNob3NlbiB0byBub3QgaW50ZXJmZXJlIHdpdGggX2Nhbm9uaWNhbGl6ZU9wdGlvbnMuXG4gICAgY29uc3Qge2dyb3VwLCBpbmRpdmlkdWFsLCBpc3MsIGtpZH0gPSBwcm90ZWN0ZWRIZWFkZXI7XG4gICAgY29uc3QgdGFncyA9IFtDcmVkZW50aWFscy5hdXRob3JdO1xuICAgIGlmIChncm91cCkgICAgICByZXR1cm4gW3t0ZWFtOiBncm91cH0sICAgICAgICAgICAgICAgICAge3RhZ3MsIGdyb3VwfV07XG4gICAgaWYgKGluZGl2aWR1YWwpIHJldHVybiBbe3RlYW06ICcnLCBtZW1iZXI6IGluZGl2aWR1YWx9LCB7dGFncywgaW5kaXZpZHVhbH1dOyAgICAgICAgLy8gY2hlY2sgYmVmb3JlIGlzc1xuICAgIGlmIChpc3MpICAgICAgICByZXR1cm4gW3t0ZWFtOiBpc3N9LCAgICAgICAgICAgICAgICAgICAge3RhZ3MsIGdyb3VwOiBpc3N9XTtcbiAgICBlbHNlICAgICAgICAgICAgcmV0dXJuIFt7dGVhbTogJycsIG1lbWJlcjoga2lkfSwgICAgICAgIHt0YWdzLCBpbmRpdmlkdWFsOiBraWR9XTtcbiAgfVxuICBcbiAgYXN5bmMgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlKSB7XG4gICAgY29uc3Qgc3RhdGVzID0gdmFsaWRhdGlvbi5qc29uIHx8IFtdO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdmFsaWRhdGlvbi5leGlzdGluZz8uanNvbiB8fCBbXTtcbiAgICB0aGlzLmxvZygnbWVyZ2VTaWduYXR1cmVzJywge3RhZywgZXhpc3RpbmcsIHN0YXRlc30pO1xuICAgIGlmIChzdGF0ZXMubGVuZ3RoID09PSAxICYmICFleGlzdGluZy5sZW5ndGgpIHJldHVybiBzaWduYXR1cmU7IC8vIEluaXRpYWwgY2FzZS4gVHJpdmlhbC5cbiAgICBpZiAoZXhpc3RpbmcubGVuZ3RoID09PSAxICYmICFzdGF0ZXMubGVuZ3RoKSByZXR1cm4gdmFsaWRhdGlvbi5leGlzdGluZy5zaWduYXR1cmU7XG5cbiAgICAvLyBMZXQncyBzZWUgaWYgd2UgY2FuIHNpbXBsaWZ5XG4gICAgY29uc3QgY29tYmluZWQgPSBbLi4uc3RhdGVzLCAuLi5leGlzdGluZ107XG4gICAgbGV0IFthbmNlc3RvciwgLi4udmVyc2lvbnNUb1JlcGxheV0gPSBhd2FpdCB0aGlzLnZlcnNpb25zLmNvbW1vblN0YXRlKGNvbWJpbmVkKTtcbiAgICB0aGlzLmxvZygnbWVyZ2VTaWduYXR1cmVzJywge3RhZywgZXhpc3RpbmcsIHN0YXRlcywgYW5jZXN0b3IsIHZlcnNpb25zVG9SZXBsYXl9KTtcbiAgICBpZiAoY29tYmluZWQubGVuZ3RoID09PSAyKSB7IC8vIENvbW1vbiBjYXNlcyB0aGF0IGNhbiBiZSBoYW5kbGVkIHdpdGhvdXQgYmVpbmcgYSBtZW1iZXJcbiAgICAgIGlmIChhbmNlc3RvciA9PT0gc3RhdGVzWzBdKSByZXR1cm4gc2lnbmF0dXJlO1xuICAgICAgaWYgKGFuY2VzdG9yID09PSBleGlzdGluZ1swXSkgcmV0dXJuIHZhbGlkYXRpb24uZXhpc3Rpbmcuc2lnbmF0dXJlO1xuICAgIH1cblxuICAgIGNvbnN0IFthc093bmVyLCBhc090aGVyXSA9IHRoaXMuZ2VuZXJhdGVPd25lck9wdGlvbnModmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIpO1xuICAgIGlmICghYXdhaXQgdGhpcy5zaWduKCdhbnl0aGluZycsIGFzT3duZXIpLmNhdGNoKCgpID0+IGZhbHNlKSkgeyAvLyBXZSBkb24ndCBoYXZlIGFjY2Vzcy5cbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLnNpZ24oY29tYmluZWQsIHtlbmNyeXB0aW9uOiAnJywgLi4uYXNPdGhlcn0pOyAvLyBKdXN0IGFuc3dlciB0aGUgY29tYmluZWQgbGlzdCB0byBiZSBwZXJzaXN0ZWQuXG4gICAgfVxuICAgIC8vIEdldCB0aGUgc3RhdGUgdmVyaWZpY2F0aW9ucyB0byByZXBsYXkuXG4gICAgaWYgKCFhbmNlc3RvcikgdmVyc2lvbnNUb1JlcGxheSA9IGF3YWl0IFByb21pc2UuYWxsKGNvbWJpbmVkLm1hcChhc3luYyBzdGF0ZVRhZyA9PiB0aGlzLnZlcnNpb25zLmdldFZlcmlmaWVkKHt0YWc6IHN0YXRlVGFnLCBzeW5jaHJvbml6ZTogZmFsc2V9KSkpO1xuICAgIHZlcnNpb25zVG9SZXBsYXkuc29ydCgoYSwgYikgPT4gYS5wcm90ZWN0ZWRIZWFkZXIuaWF0IC0gYi5wcm90ZWN0ZWRIZWFkZXIuaWF0KTtcblxuICAgIGF3YWl0IHRoaXMuYmVnaW5SZXBsYXkoYW5jZXN0b3IpO1xuICAgIGZvciAobGV0IHZlcmlmaWVkIG9mIHZlcnNpb25zVG9SZXBsYXkpIHtcbiAgICAgIGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKTsgLy8gY29tbW9uU3RhdGVzIGRvZXMgbm90IChjYW5ub3QpIGRlY3J5cHQuXG4gICAgICBjb25zdCByZXBsYXlSZXN1bHQgPSBhd2FpdCB0aGlzLnJlcGxheShhbmNlc3RvciwgdmVyaWZpZWQpO1xuICAgICAgaWYgKHZlcmlmaWVkID09PSByZXBsYXlSZXN1bHQpIHsgLy8gQWxyZWFkeSBnb29kLlxuXHRhbmNlc3RvciA9IHZlcmlmaWVkLnRhZztcbiAgICAgIH0gZWxzZSB7IC8vIFJlY29yZCByZXBsYXlSZXN1bHQgaW50byBhIG5ldyBzdGF0ZSBhZ2FpbnN0IHRoZSBhbnRlY2VkZW50LCBwcmVzZXJ2aW5nIGdyb3VwLCBpYXQsIGVuY3J5cHRpb24uXG5cdGNvbnN0IHtlbmNyeXB0aW9uID0gJycsIGlhdDp0aW1lfSA9IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlcjtcblx0Y29uc3Qgc2lnbmluZ09wdGlvbnMgPSB7YW50OmFuY2VzdG9yLCB0aW1lLCBlbmNyeXB0aW9uLCBzdWJqZWN0OnRhZywgLi4uYXNPd25lcn07XG5cdC8vIFBhc3Npbmcgc3luY2hyb25pemVyIHByZXZlbnRzIHVzIGZyb20gcmVjaXJjdWxhdGluZyB0byB0aGUgcGVlciB0aGF0IHRvbGQgdXMuXG5cdC8vIFRPRE86IElzIHRoYXQgd2hhdCB3ZSB3YW50LCBhbmQgaXMgaXQgc3VmZmljaWVudCBpbiBhIG5ldHdvcmsgb2YgbXVsdGlwbGUgcmVsYXlzP1xuXHRjb25zdCBuZXh0LyphbmNlc3RvciovID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5zdG9yZShyZXBsYXlSZXN1bHQsIHNpZ25pbmdPcHRpb25zLCB2ZXJpZmllZC5zeW5jaHJvbml6ZXIpO1xuXHR0aGlzLmxvZyh7YW5jZXN0b3IsIHZlcmlmaWVkLCByZXBsYXlSZXN1bHQsIHNpZ25pbmdPcHRpb25zLCBuZXh0fSk7XG5cdGFuY2VzdG9yID0gbmV4dDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc2lnbihbYW5jZXN0b3JdLCB7dGFnLCAuLi5hc093bmVyLCBlbmNyeXB0aW9uOiAnJ30pO1xuICB9XG5cbiAgLy8gVHdvIGhvb2tzIGZvciBzdWJjbGFzc2VzIHRvIG92ZXJyaWRlLlxuICBiZWdpblJlcGxheShhbnRlY2VkZW50VGFnKSB7XG4gIH1cbiAgcmVwbGF5KGFudGVjZWRlbnRUYWcsIHZlcmlmaWVkKSB7XG4gICAgaWYgKGFudGVjZWRlbnRUYWcgPT09IHZlcmlmaWVkLmFudCkgcmV0dXJuIHZlcmlmaWVkOyAvLyBSZXR1cm5pbmcgdGhlID09PSB2ZXJpZmllZCBpbmRpY2F0ZXMgaXQgY2FuIGJlIHJldXNlZCBkaXJlY3RseS5cbiAgICByZXR1cm4gdmVyaWZpZWQuanNvbiB8fCB2ZXJpZmllZC50ZXh0IHx8IHZlcmlmaWVkLnBheWxvYWQ7IC8vIEhpZ2hlc3QgZm9ybSB3ZSd2ZSBnb3QuXG4gIH1cblxuICBhc3luYyBnZXRSb290KHRhZywgc3luY2hyb25pemUgPSB0cnVlKSB7IC8vIFByb21pc2UgdGhlIHRhZyBvZiB0aGUgbW9zdCByZWNlbnQgc3RhdGVcbiAgICBjb25zdCB2ZXJpZmllZFZlcnNpb24gPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIG1lbWJlcjogbnVsbCwgc3luY2hyb25pemV9KTtcbiAgICB0aGlzLmxvZygnZ2V0Um9vdCcsIHt0YWcsIHZlcmlmaWVkVmVyc2lvbn0pO1xuICAgIGlmICghdmVyaWZpZWRWZXJzaW9uKSByZXR1cm4gJyc7XG4gICAgY29uc3Qgc3RhdGVzID0gdmVyaWZpZWRWZXJzaW9uLmpzb247XG4gICAgaWYgKHN0YXRlcy5sZW5ndGggIT09IDEpIHJldHVybiBQcm9taXNlLnJlamVjdChgVW5tZXJnZWQgc3RhdGVzIGluICR7dGFnfS5gKTtcbiAgICByZXR1cm4gc3RhdGVzWzBdO1xuICB9XG4gIGFzeW5jIGZvckVhY2hTdGF0ZSh0YWcsIGNhbGxiYWNrKSB7XG4gICAgLy8gR2V0IHRoZSByb290IG9mIHRoaXMgaXRlbSBhdCB0YWcsIGFuZCBjYWxsYmFjayh2ZXJpZmllZFN0YXRlLCBzdGF0ZVRhZykgb24gdGhlIGNoYWluLlxuICAgIC8vIFN0b3BzIGl0ZXJhdGlvbiBhbmQgcmV0dXJucyB0aGUgZmlyc3QgdHJ1dGh5IHZhbHVlIGZyb20gY2FsbGJhY2suXG4gICAgY29uc3Qgcm9vdCA9IGF3YWl0IHRoaXMuZ2V0Um9vdCh0YWcsIGZhbHNlKTtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy52ZXJzaW9ucy5mb3JFYWNoU3RhdGUocm9vdCwgY2FsbGJhY2spO1xuICB9XG5cbiAgLy8gVGhlc2UgYXJlIG1vc3RseSBmb3IgZGVidWdnaW5nIGFuZCBhdXRvbWF0ZWQgdGVzdGluZywgYXMgdGhleSBoYXZlIHRvIHRocm91Z2ggdGhlIHN0YXRlIGNoYWluLlxuICAvLyBCdXQgdGhleSBhbHNvIGlsbHVzdHJhdGUgaG93IHRoaW5ncyB3b3JrLlxuICBhc3luYyByZXRyaWV2ZVRpbWVzdGFtcHModGFnKSB7IC8vIFByb21pc2VzIGEgbGlzdCBvZiBhbGwgdmVyc2lvbiB0aW1lc3RhbXBzLlxuICAgIGxldCB0aW1lcyA9IFtdO1xuICAgIGF3YWl0IHRoaXMuZm9yRWFjaFN0YXRlKHRhZywgdmVyaWZpZWQgPT4geyAvLyBTdWJ0bGU6IHJldHVybiBub3RoaW5nLiAoRG9uJ3QgYmFpbCBlYXJseS4pXG4gICAgICB0aW1lcy5wdXNoKHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5pYXQpO1xuICAgIH0pO1xuICAgIHJldHVybiB0aW1lcy5yZXZlcnNlKCk7XG4gIH0gIFxuICBhc3luYyBnZXRWZXJzaW9ucyh0YWcpIHsgLy8gUHJvbWlzZXMgdGhlIHBhcnNlZCB0aW1lc3RhbXAgPT4gdmVyc2lvbiBkaWN0aW9uYXJ5IElGIGl0IGV4aXN0cywgZWxzZSBmYWxzeS5cbiAgICBsZXQgdGltZXMgPSB7fSwgbGF0ZXN0O1xuICAgIGF3YWl0IHRoaXMuZm9yRWFjaFN0YXRlKHRhZywgKHZlcmlmaWVkLCB0YWcpID0+IHtcbiAgICAgIGlmICghbGF0ZXN0KSBsYXRlc3QgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuaWF0O1xuICAgICAgdGltZXNbdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmlhdF0gPSB0YWc7XG4gICAgfSk7XG4gICAgbGV0IHJldmVyc2VkID0ge2xhdGVzdDogbGF0ZXN0fTtcbiAgICBPYmplY3QuZW50cmllcyh0aW1lcykucmV2ZXJzZSgpLmZvckVhY2goKFtrLCB2XSkgPT4gcmV2ZXJzZWRba10gPSB2KTtcbiAgICByZXR1cm4gcmV2ZXJzZWQ7XG4gIH1cblxuICAvLyBNYWludGFpbmluZyBhbiBhdXhpbGlhcnkgY29sbGVjdGlvbiBpbiB3aGljaCBzdG9yZSB0aGUgdmVyc2lvbnMgYXMgaW1tdXRhYmxlcy5cbiAgc3RhdGljIHN0YXRlQ29sbGVjdGlvbkNsYXNzID0gU3RhdGVDb2xsZWN0aW9uOyAvLyBTdWJjbGNhc3NlcyBtYXkgZXh0ZW5kLlxuICBjb25zdHJ1Y3Rvcih7c2VydmljZXMgPSBbXSwgLi4ucmVzdH0gPSB7fSkge1xuICAgIHN1cGVyKHJlc3QpOyAgLy8gV2l0aG91dCBwYXNzaW5nIHNlcnZpY2VzIHlldCwgYXMgd2UgZG9uJ3QgaGF2ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiBzZXQgdXAgeWV0LlxuICAgIHRoaXMudmVyc2lvbnMgPSBuZXcgdGhpcy5jb25zdHJ1Y3Rvci5zdGF0ZUNvbGxlY3Rpb25DbGFzcyhyZXN0KTsgLy8gU2FtZSBjb2xsZWN0aW9uIG5hbWUsIGJ1dCBkaWZmZXJlbnQgdHlwZS5cbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTsgLy8gTm93IHdlIGNhbiBzeW5jaHJvbml6ZS5cbiAgfVxuICBhc3luYyBjbG9zZSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmNsb3NlKCk7XG4gICAgYXdhaXQgc3VwZXIuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVzdHJveSgpO1xuICAgIGF3YWl0IHN1cGVyLmRlc3Ryb3koKTtcbiAgfVxuICAvLyBTeW5jaHJvbml6YXRpb24gb2YgdGhlIGF1eGlsaWFyeSBjb2xsZWN0aW9uLlxuICBzZXJ2aWNlRm9yVmVyc2lvbihzZXJ2aWNlKSB7IC8vIEdldCB0aGUgc2VydmljZSBcIm5hbWVcIiBmb3Igb3VyIHZlcnNpb25zIGNvbGxlY3Rpb24uXG4gICAgcmV0dXJuIHNlcnZpY2U/LnZlcnNpb25zIHx8IHNlcnZpY2U7ICAgLy8gRm9yIHRoZSB3ZWlyZCBjb25uZWN0RGlyZWN0VGVzdGluZyBjYXNlIHVzZWQgaW4gcmVncmVzc2lvbiB0ZXN0cywgZWxzZSB0aGUgc2VydmljZSAoZS5nLiwgYW4gYXJyYXkgb2Ygc2lnbmFscykuXG4gIH1cbiAgc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSB7XG4gICAgcmV0dXJuIHNlcnZpY2VzLm1hcChzZXJ2aWNlID0+IHRoaXMuc2VydmljZUZvclZlcnNpb24oc2VydmljZSkpO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSB7IC8vIHN5bmNocm9uaXplIHRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uLCB0b28uXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHJldHVybjtcbiAgICAvLyBLZWVwIGNoYW5uZWwgY3JlYXRpb24gc3luY2hyb25vdXMuXG4gICAgY29uc3QgdmVyc2lvbmVkUHJvbWlzZSA9IHN1cGVyLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTtcbiAgICBjb25zdCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbnMuc3luY2hyb25pemUoLi4udGhpcy5zZXJ2aWNlc0ZvclZlcnNpb24oc2VydmljZXMpKTtcbiAgICBhd2FpdCB2ZXJzaW9uZWRQcm9taXNlO1xuICAgIGF3YWl0IHZlcnNpb25Qcm9taXNlO1xuICB9XG4gIGFzeW5jIGRpc2Nvbm5lY3QoLi4uc2VydmljZXMpIHsgLy8gZGlzY29ubmVjdCB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiwgdG9vLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgYXdhaXQgdGhpcy52ZXJzaW9ucy5kaXNjb25uZWN0KC4uLnRoaXMuc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSk7XG4gICAgYXdhaXQgc3VwZXIuZGlzY29ubmVjdCguLi5zZXJ2aWNlcyk7XG4gIH1cbiAgZ2V0IHN5bmNocm9uaXplZCgpIHsgLy8gcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gc3luY2hyb25pemF0aW9uIGlzIGNvbXBsZXRlIGluIEJPVEggZGlyZWN0aW9ucy5cbiAgICAvLyBUT0RPPyBUaGlzIGRvZXMgbm90IHJlZmxlY3QgY2hhbmdlcyBhcyBTeW5jaHJvbml6ZXJzIGFyZSBhZGRlZCBvciByZW1vdmVkIHNpbmNlIGNhbGxlZC4gU2hvdWxkIGl0P1xuICAgIHJldHVybiB0aGlzLnZlcnNpb25zLnN5bmNocm9uaXplZC50aGVuKCgpID0+IHN1cGVyLnN5bmNocm9uaXplZCk7XG4gIH1cbiAgZ2V0IGl0ZW1FbWl0dGVyKCkgeyAvLyBUaGUgdmVyc2lvbnMgY29sbGVjdGlvbiBlbWl0cyBhbiB1cGRhdGUgY29ycmVzcG9uZGluZyB0byB0aGUgaW5kaXZpZHVhbCBpdGVtIHN0b3JlZC5cbiAgICAvLyAoVGhlIHVwZGF0ZXMgZW1pdHRlZCBmcm9tIHRoZSB3aG9sZSBtdXRhYmxlIFZlcnNpb25lZENvbGxlY3Rpb24gY29ycmVzcG9uZCB0byB0aGUgdmVyc2lvbiBzdGF0ZXMuKVxuICAgIHJldHVybiB0aGlzLnZlcnNpb25zO1xuICB9XG59XG5cbi8vIFdoZW4gcnVubmluZyBpbiBOb2RlSlMsIHRoZSBTZWN1cml0eSBvYmplY3QgaXMgYXZhaWxhYmxlIGRpcmVjdGx5LlxuLy8gSXQgaGFzIGEgU3RvcmFnZSBwcm9wZXJ0eSwgd2hpY2ggZGVmaW5lcyBzdG9yZS9yZXRyaWV2ZSAoaW4gbGliL3N0b3JhZ2UubWpzKSB0byBHRVQvUFVULlxuLy8gVGhlIFNlY3VyaXR5LlN0b3JhZ2UgY2FuIGJlIHNldCBieSBjbGllbnRzIHRvIHNvbWV0aGluZyBlbHNlLlxuLy9cbi8vIFdoZW4gcnVubmluZyBpbiBhIGJyb3dzZXIsIHdvcmtlci5qcyBvdmVycmlkZXMgdGhpcyB0byBzZW5kIG1lc3NhZ2VzIHRocm91Z2ggdGhlIEpTT04gUlBDXG4vLyB0byB0aGUgYXBwLCB3aGljaCB0aGVuIGFsc28gaGFzIGFuIG92ZXJyaWRhYmxlIFNlY3VyaXR5LlN0b3JhZ2UgdGhhdCBpcyBpbXBsZW1lbnRlZCB3aXRoIHRoZSBzYW1lIGNvZGUgYXMgYWJvdmUuXG5cbi8vIEJhc2ggaW4gc29tZSBuZXcgc3R1ZmY6XG5DcmVkZW50aWFscy5hdXRob3IgPSBudWxsO1xuQ3JlZGVudGlhbHMub3duZXIgPSBudWxsO1xuQ3JlZGVudGlhbHMuZW5jcnlwdGlvbiA9IG51bGw7IC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGF1ZGllbmNlXG5DcmVkZW50aWFscy5zeW5jaHJvbml6ZSA9IGFzeW5jICguLi5zZXJ2aWNlcykgPT4geyAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBjb25uZWN0LlxuICAvLyBXZSBjYW4gZG8gYWxsIHRocmVlIGluIHBhcmFsbGVsIC0tIHdpdGhvdXQgd2FpdGluZyBmb3IgY29tcGxldGlvbiAtLSBiZWNhdXNlIGRlcGVuZGVuY2llcyB3aWxsIGdldCBzb3J0ZWQgb3V0IGJ5IHN5bmNocm9uaXplMS5cbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uc3luY2hyb25pemUoLi4uc2VydmljZXMpKSk7XG59O1xuQ3JlZGVudGlhbHMuc3luY2hyb25pemVkID0gYXN5bmMgKCkgPT4ge1xuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5zeW5jaHJvbml6ZWQpKTtcbn1cbkNyZWRlbnRpYWxzLmRpc2Nvbm5lY3QgPSBhc3luYyAoLi4uc2VydmljZXMpID0+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZGlzY29ubmVjdCguLi5zZXJ2aWNlcykpKTtcbn1cblxuQ3JlZGVudGlhbHMuY3JlYXRlQXV0aG9yID0gYXN5bmMgKHByb21wdCkgPT4geyAvLyBDcmVhdGUgYSB1c2VyOlxuICAvLyBJZiBwcm9tcHQgaXMgJy0nLCBjcmVhdGVzIGFuIGludml0YXRpb24gYWNjb3VudCwgd2l0aCBhIG5vLW9wIHJlY292ZXJ5IGFuZCBubyBkZXZpY2UuXG4gIC8vIE90aGVyd2lzZSwgcHJvbXB0IGluZGljYXRlcyB0aGUgcmVjb3ZlcnkgcHJvbXB0cywgYW5kIHRoZSBhY2NvdW50IGhhcyB0aGF0IGFuZCBhIGRldmljZS5cbiAgaWYgKHByb21wdCA9PT0gJy0nKSByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0fSkpO1xuICBjb25zdCBbbG9jYWwsIHJlY292ZXJ5XSA9IGF3YWl0IFByb21pc2UuYWxsKFtDcmVkZW50aWFscy5jcmVhdGUoKSwgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHR9KV0pO1xuICByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGxvY2FsLCByZWNvdmVyeSk7XG59O1xuQ3JlZGVudGlhbHMuY2xhaW1JbnZpdGF0aW9uID0gYXN5bmMgKHRhZywgbmV3UHJvbXB0KSA9PiB7IC8vIENyZWF0ZXMgYSBsb2NhbCBkZXZpY2UgdGFnIGFuZCBhZGRzIGl0IHRvIHRoZSBnaXZlbiBpbnZpdGF0aW9uIHRhZyxcbiAgLy8gdXNpbmcgdGhlIHNlbGYtdmFsaWRhdGluZyByZWNvdmVyeSBtZW1iZXIgdGhhdCBpcyB0aGVuIHJlbW92ZWQgYW5kIGRlc3Ryb3llZC5cbiAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBDcmVkZW50aWFscy5jb2xsZWN0aW9ucy5UZWFtLnJldHJpZXZlKHt0YWd9KTtcbiAgaWYgKCF2ZXJpZmllZCkgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gdmVyaWZ5IGludml0YXRpb24gJHt0YWd9LmApO1xuICBjb25zdCBtZW1iZXJzID0gdmVyaWZpZWQuanNvbi5yZWNpcGllbnRzO1xuICBpZiAobWVtYmVycy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgSW52aXRhdGlvbnMgc2hvdWxkIGhhdmUgb25lIG1lbWJlcjogJHt0YWd9YCk7XG4gIGNvbnN0IG9sZFJlY292ZXJ5VGFnID0gbWVtYmVyc1swXS5oZWFkZXIua2lkO1xuICBjb25zdCBuZXdSZWNvdmVyeVRhZyA9IGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0OiBuZXdQcm9tcHR9KTtcbiAgY29uc3QgZGV2aWNlVGFnID0gYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKCk7XG5cbiAgLy8gV2UgbmVlZCB0byBhZGQgdGhlIG5ldyBtZW1iZXJzIGluIG9uZSBjaGFuZ2VNZW1iZXJzaGlwIHN0ZXAsIGFuZCB0aGVuIHJlbW92ZSB0aGUgb2xkUmVjb3ZlcnlUYWcgaW4gYSBzZWNvbmQgY2FsbCB0byBjaGFuZ2VNZW1iZXJzaGlwOlxuICAvLyBjaGFuZ2VNZW1iZXJzaGlwIHdpbGwgc2lnbiBieSBhbiBPTEQgbWVtYmVyIC0gSWYgaXQgc2lnbmVkIGJ5IG5ldyBtZW1iZXIgdGhhbiBwZW9wbGUgY291bGQgYm9vdHN0cmFwIHRoZW1zZWx2ZXMgb250byBhIHRlYW0uXG4gIC8vIEJ1dCBpZiB3ZSByZW1vdmUgdGhlIG9sZFJlY292ZXJ5IHRhZyBpbiB0aGUgc2FtZSBzdGVwIGFzIGFkZGluZyB0aGUgbmV3LCB0aGUgdGVhbSB3b3VsZCBiZSBzaWduZWQgYnkgc29tZW9uZSAodGhlIG9sZFJlY292ZXJ5VGFnKSB0aGF0XG4gIC8vIGlzIG5vIGxvbmdlciBhIG1lbWJlciwgYW5kIHNvIHRoZSB0ZWFtIHdvdWxkIG5vdCB2ZXJpZnkhXG4gIGF3YWl0IENyZWRlbnRpYWxzLmNoYW5nZU1lbWJlcnNoaXAoe3RhZywgYWRkOiBbZGV2aWNlVGFnLCBuZXdSZWNvdmVyeVRhZ10sIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5jaGFuZ2VNZW1iZXJzaGlwKHt0YWcsIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5kZXN0cm95KG9sZFJlY292ZXJ5VGFnKTtcbiAgcmV0dXJuIHRhZztcbn07XG5cbi8vIHNldEFuc3dlciBtdXN0IGJlIHJlLXByb3ZpZGVkIHdoZW5ldmVyIHdlJ3JlIGFib3V0IHRvIGFjY2VzcyByZWNvdmVyeSBrZXkuXG5jb25zdCBhbnN3ZXJzID0ge307XG5DcmVkZW50aWFscy5zZXRBbnN3ZXIgPSAocHJvbXB0LCBhbnN3ZXIpID0+IGFuc3dlcnNbcHJvbXB0XSA9IGFuc3dlcjtcbkNyZWRlbnRpYWxzLmdldFVzZXJEZXZpY2VTZWNyZXQgPSBmdW5jdGlvbiBmbGV4c3RvcmVTZWNyZXQodGFnLCBwcm9tcHRTdHJpbmcpIHtcbiAgaWYgKCFwcm9tcHRTdHJpbmcpIHJldHVybiB0YWc7XG4gIGlmIChwcm9tcHRTdHJpbmcgPT09ICctJykgcmV0dXJuIHByb21wdFN0cmluZzsgLy8gU2VlIGNyZWF0ZUF1dGhvci5cbiAgY29uc3QgYW5zd2VyID0gYW5zd2Vyc1twcm9tcHRTdHJpbmddO1xuICBpZiAoYW5zd2VyKSByZXR1cm4gYW5zd2VyO1xuICAvLyBEaXN0cmlidXRlZCBTZWN1cml0eSB3aWxsIHRyeSBldmVyeXRoaW5nLiBVbmxlc3MgZ29pbmcgdGhyb3VnaCBhIHBhdGggYWJvdmUsIHdlIHdvdWxkIGxpa2Ugb3RoZXJzIHRvIHNpbGVudGx5IGZhaWwuXG4gIGNvbnNvbGUubG9nKGBBdHRlbXB0aW5nIGFjY2VzcyAke3RhZ30gd2l0aCBwcm9tcHQgJyR7cHJvbXB0U3RyaW5nfScuYCk7XG4gIHJldHVybiBcIm5vdCBhIHNlY3JldFwiOyAvLyB0b2RvOiBjcnlwdG8gcmFuZG9tXG59O1xuXG5cbi8vIFRoZXNlIHR3byBhcmUgdXNlZCBkaXJlY3RseSBieSBkaXN0cmlidXRlZC1zZWN1cml0eS5cbkNyZWRlbnRpYWxzLlN0b3JhZ2UucmV0cmlldmUgPSBhc3luYyAoY29sbGVjdGlvbk5hbWUsIHRhZykgPT4ge1xuICBjb25zdCBjb2xsZWN0aW9uID0gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbY29sbGVjdGlvbk5hbWVdO1xuICAvLyBObyBuZWVkIHRvIHZlcmlmeSwgYXMgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgZG9lcyB0aGF0IGl0c2VsZiBxdWl0ZSBjYXJlZnVsbHkgYW5kIHRlYW0tYXdhcmUuXG4gIGlmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ0VuY3J5cHRpb25LZXknKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpO1xuICBpZiAoY29sbGVjdGlvbk5hbWUgPT09ICdLZXlSZWNvdmVyeScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7XG4gIC8vaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnVGVhbScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7ICAgIC8vIFRoaXMgd291bGQgZ28gY2lyY3VsYXIuIFNob3VsZCBpdD8gRG8gd2UgbmVlZCBpdD9cbiAgY29uc3QgZGF0YSA9IGF3YWl0IGNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gIC8vIEhvd2V2ZXIsIHNpbmNlIHdlIGhhdmUgYnlwYXNzZWQgQ29sbGVjdGlvbi5yZXRyaWV2ZSwgd2UgbWF5YmVJbmZsYXRlIGhlcmUuXG4gIHJldHVybiBDb2xsZWN0aW9uLm1heWJlSW5mbGF0ZShkYXRhKTtcbn1cbmNvbnN0IEVNUFRZX1NUUklOR19IQVNIID0gXCI0N0RFUXBqOEhCU2EtX1RJbVctNUpDZXVRZVJrbTVOTXBKV1pHM2hTdUZVXCI7IC8vIEhhc2ggb2YgYW4gZW1wdHkgc3RyaW5nLlxuQ3JlZGVudGlhbHMuU3RvcmFnZS5zdG9yZSA9IGFzeW5jIChjb2xsZWN0aW9uTmFtZSwgdGFnLCBzaWduYXR1cmUpID0+IHtcbiAgLy8gTm8gbmVlZCB0byBlbmNyeXB0L3NpZ24gYXMgYnkgc3RvcmUsIHNpbmNlIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGRvZXMgdGhhdCBpbiBhIGNpcmN1bGFyaXR5LWF3YXJlIHdheS5cbiAgLy8gSG93ZXZlciwgd2UgZG8gY3VycmVudGx5IG5lZWQgdG8gZmluZCBvdXQgb2YgdGhlIHNpZ25hdHVyZSBoYXMgYSBwYXlsb2FkIGFuZCBwdXNoXG4gIC8vIFRPRE86IE1vZGlmeSBkaXN0LXNlYyB0byBoYXZlIGEgc2VwYXJhdGUgc3RvcmUvZGVsZXRlLCByYXRoZXIgdGhhbiBoYXZpbmcgdG8gZmlndXJlIHRoaXMgb3V0IGhlcmUuXG4gIGNvbnN0IGNsYWltcyA9IENyZWRlbnRpYWxzLmRlY29kZUNsYWltcyhzaWduYXR1cmUpO1xuICBjb25zdCBlbXB0eVBheWxvYWQgPSBjbGFpbXM/LnN1YiA9PT0gRU1QVFlfU1RSSU5HX0hBU0g7XG5cbiAgY29uc3QgY29sbGVjdGlvbiA9IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW2NvbGxlY3Rpb25OYW1lXTtcbiAgc2lnbmF0dXJlID0gQ29sbGVjdGlvbi5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgY29uc3Qgc3RvcmVkID0gYXdhaXQgKGVtcHR5UGF5bG9hZCA/IGNvbGxlY3Rpb24uZGVsZXRlKHRhZywgc2lnbmF0dXJlKSA6IGNvbGxlY3Rpb24ucHV0KHRhZywgc2lnbmF0dXJlKSk7XG4gIGlmIChzdG9yZWQgIT09IHRhZykgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gd3JpdGUgY3JlZGVudGlhbCAke3RhZ30uYCk7XG4gIGlmICh0YWcpIGF3YWl0IGNvbGxlY3Rpb24ucHVzaChlbXB0eVBheWxvYWQgPyAnZGVsZXRlJzogJ3B1dCcsIHRhZywgc2lnbmF0dXJlKTtcbiAgcmV0dXJuIHRhZztcbn07XG5DcmVkZW50aWFscy5TdG9yYWdlLmRlc3Ryb3kgPSBhc3luYyAoKSA9PiB7XG4gIGF3YWl0IENyZWRlbnRpYWxzLmNsZWFyKCk7IC8vIFdpcGUgZnJvbSBsaXZlIG1lbW9yeS5cbiAgZm9yIChsZXQgY29sbGVjdGlvbiBvZiBPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKSkge1xuICAgIGF3YWl0IGNvbGxlY3Rpb24uZGVzdHJveSgpO1xuICB9XG4gIGF3YWl0IENyZWRlbnRpYWxzLndpcGVEZXZpY2VLZXlzKCk7IC8vIE5vdCBpbmNsdWRlZCBpbiB0aGUgYWJvdmUuXG59O1xuQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMgPSB7fTtcbmV4cG9ydCB7IENyZWRlbnRpYWxzLCBTdG9yYWdlTG9jYWwgfTtcblsnRW5jcnlwdGlvbktleScsICdLZXlSZWNvdmVyeScsICdUZWFtJ10uZm9yRWFjaChuYW1lID0+IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW25hbWVdID0gbmV3IE11dGFibGVDb2xsZWN0aW9uKHtuYW1lfSkpO1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHV1aWQ0IGZyb20gJ3V1aWQ0JztcbmltcG9ydCBTeW5jaHJvbml6ZXIgZnJvbSAnLi9saWIvc3luY2hyb25pemVyLm1qcyc7XG5pbXBvcnQgeyBDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgU3RhdGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBTdG9yYWdlTG9jYWwgfSBmcm9tICAnLi9saWIvY29sbGVjdGlvbnMubWpzJztcbmltcG9ydCB7IFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDIH0gZnJvbSAnLi9saWIvd2VicnRjLm1qcyc7XG5pbXBvcnQgeyB2ZXJzaW9uLCBuYW1lLCBzdG9yYWdlVmVyc2lvbiwgc3RvcmFnZU5hbWUgfSBmcm9tICcuL2xpYi92ZXJzaW9uLm1qcyc7XG5cbmNvbnNvbGUubG9nKGAke25hbWV9ICR7dmVyc2lvbn0gZnJvbSAke2ltcG9ydC5tZXRhLnVybH0uYCk7XG5cbmV4cG9ydCB7IENyZWRlbnRpYWxzLCBDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgU3RhdGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBTeW5jaHJvbml6ZXIsIFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDLCBuYW1lLCB2ZXJzaW9uLCBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24sIFN0b3JhZ2VMb2NhbCwgdXVpZDQgfTtcbmV4cG9ydCBkZWZhdWx0IHsgQ3JlZGVudGlhbHMsIENvbGxlY3Rpb24sIE11dGFibGVDb2xsZWN0aW9uLCBJbW11dGFibGVDb2xsZWN0aW9uLCBTdGF0ZUNvbGxlY3Rpb24sIFZlcnNpb25lZENvbGxlY3Rpb24sIFN5bmNocm9uaXplciwgV2ViUlRDLCBQcm9taXNlV2ViUlRDLCBTaGFyZWRXZWJSVEMsIG5hbWUsIHZlcnNpb24sICBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24sIFN0b3JhZ2VMb2NhbCwgdXVpZDQgfTtcbiJdLCJuYW1lcyI6WyJwa2cuZGVmYXVsdCIsIlN0b3JhZ2VMb2NhbCJdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsTUFBTSxXQUFXLEdBQUcsd0VBQXdFO0FBQzVGLFNBQVMsS0FBSyxDQUFDLElBQUksRUFBRTtBQUNyQixFQUFFLE9BQU8sV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7QUFDL0I7O0FBRUE7QUFDQTtBQUNBLFNBQVMsS0FBSyxHQUFHO0FBQ2pCLEVBQUUsSUFBSSxRQUFRLEdBQUcsR0FBRyxDQUFDLGVBQWUsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDO0FBQ2hELEVBQUUsSUFBSSxJQUFJLEdBQUcsUUFBUSxDQUFDLFFBQVEsRUFBRTtB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LENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxVQUFVLEVBQUUsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUMsSUFBSSxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssR0FBRSxDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFDLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsTUFBTSxZQUFZLFNBQVMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxNQUFNLENBQUMsQ0FBQyxFQUFFLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFDLENBQUMsTUFBTSxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sV0FBVyxDQUFDLENB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
