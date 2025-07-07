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
var version$1 = "0.0.61";
var _package = {
	name: name$1,
	version: version$1};

// name/version of "database"
const storageName = 'flexstore';
const storageVersion = 10;
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
    const existingVerified = verified.existing = antecedent && await this.getVerified({tag: antecedent, synchronize, ...validationOptions});
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
    if (!previousValidations.length) return signature;
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
    if (!validation || !validation.json) return [];
    if (!Array.isArray(validation.json)) return [validation];
    return Promise.all(validation.json.map(signature => this.constructor.verify(signature)))
      .then(signatures => signatures.filter(sig => sig));
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsibm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0BraTFyMHkvc3RvcmFnZS9idW5kbGUubWpzIiwibGliL2NvbGxlY3Rpb25zLm1qcyIsImluZGV4Lm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB1dWlkUGF0dGVybiA9IC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tNFswLTlhLWZdezN9LVs4OWFiXVswLTlhLWZdezN9LVswLTlhLWZdezEyfSQvaTtcbmZ1bmN0aW9uIHZhbGlkKHV1aWQpIHtcbiAgcmV0dXJuIHV1aWRQYXR0ZXJuLnRlc3QodXVpZCk7XG59XG5cbi8vIEJhc2VkIG9uIGh0dHBzOi8vYWJoaXNoZWtkdXR0YS5vcmcvYmxvZy9zdGFuZGFsb25lX3V1aWRfZ2VuZXJhdG9yX2luX2phdmFzY3JpcHQuaHRtbFxuLy8gSUUxMSBhbmQgTW9kZXJuIEJyb3dzZXJzIE9ubHlcbmZ1bmN0aW9uIHV1aWQ0KCkge1xuICB2YXIgdGVtcF91cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKCkpO1xuICB2YXIgdXVpZCA9IHRlbXBfdXJsLnRvU3RyaW5nKCk7XG4gIFVSTC5yZXZva2VPYmplY3RVUkwodGVtcF91cmwpO1xuICByZXR1cm4gdXVpZC5zcGxpdCgvWzpcXC9dL2cpLnBvcCgpLnRvTG93ZXJDYXNlKCk7IC8vIHJlbW92ZSBwcmVmaXhlc1xufVxudXVpZDQudmFsaWQgPSB2YWxpZDtcblxuZXhwb3J0IGRlZmF1bHQgdXVpZDQ7XG5leHBvcnQgeyB1dWlkNCwgdmFsaWQgfTtcbiIsIi8vIEluIGEgYnJvd3Nlciwgd3J0YyBwcm9wZXJ0aWVzIHN1Y2ggYXMgUlRDUGVlckNvbm5lY3Rpb24gYXJlIGluIGdsb2JhbFRoaXMuXG5leHBvcnQgZGVmYXVsdCBnbG9iYWxUaGlzO1xuIiwiaW1wb3J0IHV1aWQ0IGZyb20gJ3V1aWQ0JztcblxuLy8gU2VlIHJvbGx1cC5jb25maWcubWpzXG5pbXBvcnQgd3J0YyBmcm9tICcjd3J0Yyc7XG4vL2NvbnN0IHtkZWZhdWx0OndydGN9ID0gYXdhaXQgKCh0eXBlb2YocHJvY2VzcykgIT09ICd1bmRlZmluZWQnKSA/IGltcG9ydCgnQHJvYW1ocS93cnRjJykgOiB7ZGVmYXVsdDogZ2xvYmFsVGhpc30pO1xuXG5jb25zdCBpY2VTZXJ2ZXJzID0gW1xuICB7IHVybHM6ICdzdHVuOnN0dW4ubC5nb29nbGUuY29tOjE5MzAyJ30sXG4gIC8vIGh0dHBzOi8vZnJlZXN0dW4ubmV0LyAgQ3VycmVudGx5IDUwIEtCaXQvcy4gKDIuNSBNQml0L3MgZm9ycyAkOS9tb250aClcbiAgeyB1cmxzOiAnc3R1bjpmcmVlc3R1bi5uZXQ6MzQ3OCcgfSxcbiAgLy97IHVybHM6ICd0dXJuOmZyZWVzdHVuLm5ldDozNDc4JywgdXNlcm5hbWU6ICdmcmVlJywgY3JlZGVudGlhbDogJ2ZyZWUnIH0sXG4gIC8vIFByZXN1bWFibHkgdHJhZmZpYyBsaW1pdGVkLiBDYW4gZ2VuZXJhdGUgbmV3IGNyZWRlbnRpYWxzIGF0IGh0dHBzOi8vc3BlZWQuY2xvdWRmbGFyZS5jb20vdHVybi1jcmVkc1xuICAvLyBBbHNvIGh0dHBzOi8vZGV2ZWxvcGVycy5jbG91ZGZsYXJlLmNvbS9jYWxscy8gMSBUQi9tb250aCwgYW5kICQwLjA1IC9HQiBhZnRlciB0aGF0LlxuICB7IHVybHM6ICd0dXJuOnR1cm4uc3BlZWQuY2xvdWRmbGFyZS5jb206NTAwMDAnLCB1c2VybmFtZTogJzgyNjIyNjI0NGNkNmU1ZWRiM2Y1NTc0OWI3OTYyMzVmNDIwZmU1ZWU3ODg5NWUwZGQ3ZDJiYWE0NWUxZjdhOGY0OWU5MjM5ZTc4NjkxYWIzOGI3MmNlMDE2NDcxZjc3NDZmNTI3N2RjZWY4NGFkNzlmYzYwZjgwMjBiMTMyYzczJywgY3JlZGVudGlhbDogJ2FiYTliMTY5NTQ2ZWI2ZGNjN2JmYjFjZGYzNDU0NGNmOTViNTE2MWQ2MDJlM2I1ZmE3YzgzNDJiMmU5ODAyZmInIH1cbiAgLy8gaHR0cHM6Ly9mYXN0dHVybi5uZXQvIEN1cnJlbnRseSA1MDBNQi9tb250aD8gKDI1IEdCL21vbnRoIGZvciAkOS9tb250aClcbiAgLy8gaHR0cHM6Ly94aXJzeXMuY29tL3ByaWNpbmcvIDUwMCBNQi9tb250aCAoNTAgR0IvbW9udGggZm9yICQzMy9tb250aClcbiAgLy8gQWxzbyBodHRwczovL3d3dy5ucG1qcy5jb20vcGFja2FnZS9ub2RlLXR1cm4gb3IgaHR0cHM6Ly9tZWV0cml4LmlvL2Jsb2cvd2VicnRjL2NvdHVybi9pbnN0YWxsYXRpb24uaHRtbFxuXTtcblxuLy8gVXRpbGl0eSB3cmFwcGVyIGFyb3VuZCBSVENQZWVyQ29ubmVjdGlvbi5cbi8vIFdoZW4gc29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIChzdWNoIGFzIGNyZWF0ZURhdGFDaGFubmVsKSwgaXQgd2lsbCBnZW5lcmF0ZSBjYWxscyB0byBzaWduYWwoKSwgd2hpY2ggbmVlZHMgdG8gYmUgZGVmaW5lZCBieSBzdWJjbGFzc2VzLlxuZXhwb3J0IGNsYXNzIFdlYlJUQyB7XG4gIGNvbnN0cnVjdG9yKHtsYWJlbCA9ICcnLCBjb25maWd1cmF0aW9uID0gbnVsbCwgdXVpZCA9IHV1aWQ0KCksIGRlYnVnID0gZmFsc2UsIGVycm9yID0gY29uc29sZS5lcnJvciwgLi4ucmVzdH0gPSB7fSkge1xuICAgIGNvbmZpZ3VyYXRpb24gPz89IHtpY2VTZXJ2ZXJzfTsgLy8gSWYgY29uZmlndXJhdGlvbiBjYW4gYmUgb21taXR0ZWQgb3IgZXhwbGljaXRseSBhcyBudWxsLCB1c2Ugb3VyIGRlZmF1bHQuIEJ1dCBpZiB7fSwgbGVhdmUgaXQgYmUuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7bGFiZWwsIGNvbmZpZ3VyYXRpb24sIHV1aWQsIGRlYnVnLCBlcnJvciwgLi4ucmVzdH0pO1xuICAgIHRoaXMucmVzZXRQZWVyKCk7XG4gIH1cbiAgc2lnbmFsKHR5cGUsIG1lc3NhZ2UpIHsgLy8gU3ViY2xhc3NlcyBtdXN0IG92ZXJyaWRlIG9yIGV4dGVuZC4gRGVmYXVsdCBqdXN0IGxvZ3MuXG4gICAgdGhpcy5sb2coJ3NlbmRpbmcnLCB0eXBlLCB0eXBlLmxlbmd0aCwgSlNPTi5zdHJpbmdpZnkobWVzc2FnZSkubGVuZ3RoKTtcbiAgfVxuXG4gIHBlZXJWZXJzaW9uID0gMDtcbiAgcmVzZXRQZWVyKCkgeyAvLyBTZXQgdXAgYSBuZXcgUlRDUGVlckNvbm5lY3Rpb24uIChDYWxsZXIgbXVzdCBjbG9zZSBvbGQgaWYgbmVjZXNzYXJ5LilcbiAgICBjb25zdCBvbGQgPSB0aGlzLnBlZXI7XG4gICAgaWYgKG9sZCkge1xuICAgICAgb2xkLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBvbGQub25pY2VjYW5kaWRhdGUgPSBvbGQub25pY2VjYW5kaWRhdGVlcnJvciA9IG9sZC5vbmNvbm5lY3Rpb25zdGF0ZWNoYW5nZSA9IG51bGw7XG4gICAgICAvLyBEb24ndCBjbG9zZSB1bmxlc3MgaXQncyBiZWVuIG9wZW5lZCwgYmVjYXVzZSB0aGVyZSBhcmUgbGlrZWx5IGhhbmRsZXJzIHRoYXQgd2UgZG9uJ3Qgd2FudCB0byBmaXJlLlxuICAgICAgaWYgKG9sZC5jb25uZWN0aW9uU3RhdGUgIT09ICduZXcnKSBvbGQuY2xvc2UoKTtcbiAgICB9XG4gICAgY29uc3QgcGVlciA9IHRoaXMucGVlciA9IG5ldyB3cnRjLlJUQ1BlZXJDb25uZWN0aW9uKHRoaXMuY29uZmlndXJhdGlvbik7XG4gICAgcGVlci52ZXJzaW9uSWQgPSB0aGlzLnBlZXJWZXJzaW9uKys7XG4gICAgcGVlci5vbm5lZ290aWF0aW9ubmVlZGVkID0gZXZlbnQgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZChldmVudCk7XG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZSA9IGV2ZW50ID0+IHRoaXMub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gICAgLy8gSSBkb24ndCB0aGluayBhbnlvbmUgYWN0dWFsbHkgc2lnbmFscyB0aGlzLiBJbnN0ZWFkLCB0aGV5IHJlamVjdCBmcm9tIGFkZEljZUNhbmRpZGF0ZSwgd2hpY2ggd2UgaGFuZGxlIHRoZSBzYW1lLlxuICAgIHBlZXIub25pY2VjYW5kaWRhdGVlcnJvciA9IGVycm9yID0+IHRoaXMuaWNlY2FuZGlkYXRlRXJyb3IoZXJyb3IpO1xuICAgIC8vIEkgdGhpbmsgdGhpcyBpcyByZWR1bmRuYW50IGJlY2F1c2Ugbm8gaW1wbGVtZW50YXRpb24gZmlyZXMgdGhpcyBldmVudCBhbnkgc2lnbmlmaWNhbnQgdGltZSBhaGVhZCBvZiBlbWl0dGluZyBpY2VjYW5kaWRhdGUgd2l0aCBhbiBlbXB0eSBldmVudC5jYW5kaWRhdGUuXG4gICAgcGVlci5vbmljZWdhdGhlcmluZ3N0YXRlY2hhbmdlID0gZXZlbnQgPT4gKHBlZXIuaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScpICYmIHRoaXMub25Mb2NhbEVuZEljZTtcbiAgICBwZWVyLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gZXZlbnQgPT4gdGhpcy5jb25uZWN0aW9uU3RhdGVDaGFuZ2UodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIFRoZSBzcGVjIHNheXMgdGhhdCBhIG51bGwgY2FuZGlkYXRlIHNob3VsZCBub3QgYmUgc2VudCwgYnV0IHRoYXQgYW4gZW1wdHkgc3RyaW5nIGNhbmRpZGF0ZSBzaG91bGQuIFNhZmFyaSAodXNlZCB0bz8pIGdldCBlcnJvcnMgZWl0aGVyIHdheS5cbiAgICBpZiAoIWV2ZW50LmNhbmRpZGF0ZSB8fCAhZXZlbnQuY2FuZGlkYXRlLmNhbmRpZGF0ZSkgdGhpcy5vbkxvY2FsRW5kSWNlKCk7XG4gICAgZWxzZSB0aGlzLnNpZ25hbCgnaWNlY2FuZGlkYXRlJywgZXZlbnQuY2FuZGlkYXRlKTtcbiAgfVxuICBvbkxvY2FsRW5kSWNlKCkgeyAvLyBUcmlnZ2VyZWQgb24gb3VyIHNpZGUgYnkgYW55L2FsbCBvZiBvbmljZWNhbmRpZGF0ZSB3aXRoIG5vIGV2ZW50LmNhbmRpZGF0ZSwgaWNlR2F0aGVyaW5nU3RhdGUgPT09ICdjb21wbGV0ZScuXG4gICAgLy8gSS5lLiwgY2FuIGhhcHBlbiBtdWx0aXBsZSB0aW1lcy4gU3ViY2xhc3NlcyBtaWdodCBkbyBzb21ldGhpbmcuXG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKCh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnbmV3JykgJiYgKHRoaXMucGVlci5zaWduYWxpbmdTdGF0ZSA9PT0gJ3N0YWJsZScpKSByZXR1cm47XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBjb25uZWN0aW9uU3RhdGVDaGFuZ2Uoc3RhdGUpIHtcbiAgICB0aGlzLmxvZygnc3RhdGUgY2hhbmdlOicsIHN0YXRlKTtcbiAgICBpZiAoWydkaXNjb25uZWN0ZWQnLCAnZmFpbGVkJywgJ2Nsb3NlZCddLmluY2x1ZGVzKHN0YXRlKSkgdGhpcy5jbG9zZSgpOyAvLyBPdGhlciBiZWhhdmlvciBhcmUgcmVhc29uYWJsZSwgdG9sby5cbiAgfVxuICBuZWdvdGlhdGlvbm5lZWRlZCgpIHsgLy8gU29tZXRoaW5nIGhhcyBjaGFuZ2VkIGxvY2FsbHkgKG5ldyBzdHJlYW0sIG9yIG5ldHdvcmsgY2hhbmdlKSwgc3VjaCB0aGF0IHdlIGhhdmUgdG8gc3RhcnQgbmVnb3RpYXRpb24uXG4gICAgdGhpcy5sb2coJ25lZ290aWF0aW9ubm5lZWRlZCcpO1xuICAgIHRoaXMucGVlci5jcmVhdGVPZmZlcigpXG4gICAgICAudGhlbihvZmZlciA9PiB7XG4gICAgICAgIHRoaXMucGVlci5zZXRMb2NhbERlc2NyaXB0aW9uKG9mZmVyKTsgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIG9mZmVyXG5cdHJldHVybiBvZmZlcjtcbiAgICAgIH0pXG4gICAgICAudGhlbihvZmZlciA9PiB0aGlzLnNpZ25hbCgnb2ZmZXInLCBvZmZlcikpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4gdGhpcy5uZWdvdGlhdGlvbm5lZWRlZEVycm9yKGVycm9yKSk7XG4gIH1cbiAgb2ZmZXIob2ZmZXIpIHsgLy8gSGFuZGxlciBmb3IgcmVjZWl2aW5nIGFuIG9mZmVyIGZyb20gdGhlIG90aGVyIHVzZXIgKHdobyBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2VzcykuXG4gICAgLy8gTm90ZSB0aGF0IGR1cmluZyBzaWduYWxpbmcsIHdlIHdpbGwgcmVjZWl2ZSBuZWdvdGlhdGlvbm5lZWRlZC9hbnN3ZXIsIG9yIG9mZmVyLCBidXQgbm90IGJvdGgsIGRlcGVuZGluZ1xuICAgIC8vIG9uIHdoZXRoZXIgd2Ugd2VyZSB0aGUgb25lIHRoYXQgc3RhcnRlZCB0aGUgc2lnbmFsaW5nIHByb2Nlc3MuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKG9mZmVyKVxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnBlZXIuY3JlYXRlQW5zd2VyKCkpXG4gICAgICAudGhlbihhbnN3ZXIgPT4gdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyKSkgLy8gcHJvbWlzZSBkb2VzIG5vdCByZXNvbHZlIHRvIGFuc3dlclxuICAgICAgLnRoZW4oXyA9PiB0aGlzLnNpZ25hbCgnYW5zd2VyJywgdGhpcy5wZWVyLmxvY2FsRGVzY3JpcHRpb24pKTtcbiAgfVxuICBhbnN3ZXIoYW5zd2VyKSB7IC8vIEhhbmRsZXIgZm9yIGZpbmlzaGluZyB0aGUgc2lnbmFsaW5nIHByb2Nlc3MgdGhhdCB3ZSBzdGFydGVkLlxuICAgIHRoaXMucGVlci5zZXRSZW1vdGVEZXNjcmlwdGlvbihhbnN3ZXIpO1xuICB9XG4gIGljZWNhbmRpZGF0ZShpY2VDYW5kaWRhdGUpIHsgLy8gSGFuZGxlciBmb3IgYSBuZXcgY2FuZGlkYXRlIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZCB0aHJvdWdoIHNpZ25hbGluZy5cbiAgICB0aGlzLnBlZXIuYWRkSWNlQ2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkuY2F0Y2goZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcikpO1xuICB9XG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnJlc3QpO1xuICB9XG4gIGxvZ0Vycm9yKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgY29uc3QgZGF0YSA9IFt0aGlzLmxhYmVsLCB0aGlzLnBlZXIudmVyc2lvbklkLCAuLi50aGlzLmNvbnN0cnVjdG9yLmdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbildO1xuICAgIHRoaXMuZXJyb3IoZGF0YSk7XG4gICAgcmV0dXJuIGRhdGE7XG4gIH1cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7XG4gIH1cbiAgc3RhdGljIGdhdGhlckVycm9yRGF0YShsYWJlbCwgZXZlbnRPckV4Y2VwdGlvbikge1xuICAgIHJldHVybiBbXG4gICAgICBsYWJlbCArIFwiIGVycm9yOlwiLFxuICAgICAgZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzIHx8IFwiXCIsIC8vIEZpcnN0IGlzIGRlcHJlY2F0ZWQsIGJ1dCBzdGlsbCB1c2VmdWwuXG4gICAgICBldmVudE9yRXhjZXB0aW9uLnVybCB8fCBldmVudE9yRXhjZXB0aW9uLm5hbWUgfHwgJycsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLm1lc3NhZ2UgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvclRleHQgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXNUZXh0IHx8IGV2ZW50T3JFeGNlcHRpb25cbiAgICBdO1xuICB9XG4gIGljZWNhbmRpZGF0ZUVycm9yKGV2ZW50T3JFeGNlcHRpb24pIHsgLy8gRm9yIGVycm9ycyBvbiB0aGlzIHBlZXIgZHVyaW5nIGdhdGhlcmluZy5cbiAgICAvLyBDYW4gYmUgb3ZlcnJpZGRlbiBvciBleHRlbmRlZCBieSBhcHBsaWNhdGlvbnMuXG5cbiAgICAvLyBTVFVOIGVycm9ycyBhcmUgaW4gdGhlIHJhbmdlIDMwMC02OTkuIFNlZSBSRkMgNTM4OSwgc2VjdGlvbiAxNS42XG4gICAgLy8gZm9yIGEgbGlzdCBvZiBjb2Rlcy4gVFVSTiBhZGRzIGEgZmV3IG1vcmUgZXJyb3IgY29kZXM7IHNlZVxuICAgIC8vIFJGQyA1NzY2LCBzZWN0aW9uIDE1IGZvciBkZXRhaWxzLlxuICAgIC8vIFNlcnZlciBjb3VsZCBub3QgYmUgcmVhY2hlZCBhcmUgaW4gdGhlIHJhbmdlIDcwMC03OTkuXG4gICAgY29uc3QgY29kZSA9IGV2ZW50T3JFeGNlcHRpb24uY29kZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yQ29kZSB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1cztcbiAgICAvLyBDaHJvbWUgZ2l2ZXMgNzAxIGVycm9ycyBmb3Igc29tZSB0dXJuIHNlcnZlcnMgdGhhdCBpdCBkb2VzIG5vdCBnaXZlIGZvciBvdGhlciB0dXJuIHNlcnZlcnMuXG4gICAgLy8gVGhpcyBpc24ndCBnb29kLCBidXQgaXQncyB3YXkgdG9vIG5vaXN5IHRvIHNsb2cgdGhyb3VnaCBzdWNoIGVycm9ycywgYW5kIEkgZG9uJ3Qga25vdyBob3cgdG8gZml4IG91ciB0dXJuIGNvbmZpZ3VyYXRpb24uXG4gICAgaWYgKGNvZGUgPT09IDcwMSkgcmV0dXJuO1xuICAgIHRoaXMubG9nRXJyb3IoJ2ljZScsIGV2ZW50T3JFeGNlcHRpb24pO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBQcm9taXNlV2ViUlRDIGV4dGVuZHMgV2ViUlRDIHtcbiAgLy8gRXh0ZW5kcyBXZWJSVEMuc2lnbmFsKCkgc3VjaCB0aGF0OlxuICAvLyAtIGluc3RhbmNlLnNpZ25hbHMgYW5zd2VycyBhIHByb21pc2UgdGhhdCB3aWxsIHJlc29sdmUgd2l0aCBhbiBhcnJheSBvZiBzaWduYWwgbWVzc2FnZXMuXG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyA9IFsuLi5zaWduYWxNZXNzYWdlc10gd2lsbCBkaXNwYXRjaCB0aG9zZSBtZXNzYWdlcy5cbiAgLy9cbiAgLy8gRm9yIGV4YW1wbGUsIHN1cHBvc2UgcGVlcjEgYW5kIHBlZXIyIGFyZSBpbnN0YW5jZXMgb2YgdGhpcy5cbiAgLy8gMC4gU29tZXRoaW5nIHRyaWdnZXJzIG5lZ290aWF0aW9uIG9uIHBlZXIxIChzdWNoIGFzIGNhbGxpbmcgcGVlcjEuY3JlYXRlRGF0YUNoYW5uZWwoKSkuIFxuICAvLyAxLiBwZWVyMS5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDE+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjIuXG4gIC8vIDIuIFNldCBwZWVyMi5zaWduYWxzID0gPHNpZ25hbDE+LlxuICAvLyAzLiBwZWVyMi5zaWduYWxzIHJlc29sdmVzIHdpdGggPHNpZ25hbDI+LCBhIFBPSk8gdG8gYmUgY29udmV5ZWQgdG8gcGVlcjEuXG4gIC8vIDQuIFNldCBwZWVyMS5zaWduYWxzID0gPHNpZ25hbDI+LlxuICAvLyA1LiBEYXRhIGZsb3dzLCBidXQgZWFjaCBzaWRlIHdob3VsZCBncmFiIGEgbmV3IHNpZ25hbHMgcHJvbWlzZSBhbmQgYmUgcHJlcGFyZWQgdG8gYWN0IGlmIGl0IHJlc29sdmVzLlxuICAvL1xuICBjb25zdHJ1Y3Rvcih7aWNlVGltZW91dCA9IDJlMywgLi4ucHJvcGVydGllc30pIHtcbiAgICBzdXBlcihwcm9wZXJ0aWVzKTtcbiAgICB0aGlzLmljZVRpbWVvdXQgPSBpY2VUaW1lb3V0O1xuICB9XG4gIGdldCBzaWduYWxzKCkgeyAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmUgdG8gdGhlIHNpZ25hbCBtZXNzYWdpbmcgd2hlbiBpY2UgY2FuZGlkYXRlIGdhdGhlcmluZyBpcyBjb21wbGV0ZS5cbiAgICByZXR1cm4gdGhpcy5fc2lnbmFsUHJvbWlzZSB8fD0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gdGhpcy5fc2lnbmFsUmVhZHkgPSB7cmVzb2x2ZSwgcmVqZWN0fSk7XG4gIH1cbiAgc2V0IHNpZ25hbHMoZGF0YSkgeyAvLyBTZXQgd2l0aCB0aGUgc2lnbmFscyByZWNlaXZlZCBmcm9tIHRoZSBvdGhlciBlbmQuXG4gICAgZGF0YS5mb3JFYWNoKChbdHlwZSwgbWVzc2FnZV0pID0+IHRoaXNbdHlwZV0obWVzc2FnZSkpO1xuICB9XG4gIG9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpIHtcbiAgICAvLyBFYWNoIHdydGMgaW1wbGVtZW50YXRpb24gaGFzIGl0cyBvd24gaWRlYXMgYXMgdG8gd2hhdCBpY2UgY2FuZGlkYXRlcyB0byB0cnkgYmVmb3JlIGVtaXR0aW5nIHRoZW0gaW4gaWNlY2FuZGRpYXRlLlxuICAgIC8vIE1vc3Qgd2lsbCB0cnkgdGhpbmdzIHRoYXQgY2Fubm90IGJlIHJlYWNoZWQsIGFuZCBnaXZlIHVwIHdoZW4gdGhleSBoaXQgdGhlIE9TIG5ldHdvcmsgdGltZW91dC4gRm9ydHkgc2Vjb25kcyBpcyBhIGxvbmcgdGltZSB0byB3YWl0LlxuICAgIC8vIElmIHRoZSB3cnRjIGlzIHN0aWxsIHdhaXRpbmcgYWZ0ZXIgb3VyIGljZVRpbWVvdXQgKDIgc2Vjb25kcyksIGxldHMganVzdCBnbyB3aXRoIHdoYXQgd2UgaGF2ZS5cbiAgICB0aGlzLnRpbWVyIHx8PSBzZXRUaW1lb3V0KCgpID0+IHRoaXMub25Mb2NhbEVuZEljZSgpLCB0aGlzLmljZVRpbWVvdXQpO1xuICAgIHN1cGVyLm9uTG9jYWxJY2VDYW5kaWRhdGUoZXZlbnQpO1xuICB9XG4gIGNsZWFySWNlVGltZXIoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpO1xuICAgIHRoaXMudGltZXIgPSBudWxsO1xuICB9XG4gIGFzeW5jIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFJlc29sdmUgdGhlIHByb21pc2Ugd2l0aCB3aGF0IHdlJ3ZlIGJlZW4gZ2F0aGVyaW5nLlxuICAgIHRoaXMuY2xlYXJJY2VUaW1lcigpO1xuICAgIGlmICghdGhpcy5fc2lnbmFsUHJvbWlzZSkge1xuICAgICAgLy90aGlzLmxvZ0Vycm9yKCdpY2UnLCBcIkVuZCBvZiBJQ0Ugd2l0aG91dCBhbnl0aGluZyB3YWl0aW5nIG9uIHNpZ25hbHMuXCIpOyAvLyBOb3QgaGVscGZ1bCB3aGVuIHRoZXJlIGFyZSB0aHJlZSB3YXlzIHRvIHJlY2VpdmUgdGhpcyBtZXNzYWdlLlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9zaWduYWxSZWFkeS5yZXNvbHZlKHRoaXMuc2VuZGluZyk7XG4gICAgdGhpcy5zZW5kaW5nID0gW107XG4gIH1cbiAgc2VuZGluZyA9IFtdO1xuICBzaWduYWwodHlwZSwgbWVzc2FnZSkge1xuICAgIHN1cGVyLnNpZ25hbCh0eXBlLCBtZXNzYWdlKTtcbiAgICB0aGlzLnNlbmRpbmcucHVzaChbdHlwZSwgbWVzc2FnZV0pO1xuICB9XG4gIC8vIFdlIG5lZWQgdG8ga25vdyBpZiB0aGVyZSBhcmUgb3BlbiBkYXRhIGNoYW5uZWxzLiBUaGVyZSBpcyBhIHByb3Bvc2FsIGFuZCBldmVuIGFuIGFjY2VwdGVkIFBSIGZvciBSVENQZWVyQ29ubmVjdGlvbi5nZXREYXRhQ2hhbm5lbHMoKSxcbiAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3czYy93ZWJydGMtZXh0ZW5zaW9ucy9pc3N1ZXMvMTEwXG4gIC8vIGJ1dCBpdCBoYXNuJ3QgYmVlbiBkZXBsb3llZCBldmVyeXdoZXJlIHlldC4gU28gd2UnbGwgbmVlZCB0byBrZWVwIG91ciBvd24gY291bnQuXG4gIC8vIEFsYXMsIGEgY291bnQgaXNuJ3QgZW5vdWdoLCBiZWNhdXNlIHdlIGNhbiBvcGVuIHN0dWZmLCBhbmQgdGhlIG90aGVyIHNpZGUgY2FuIG9wZW4gc3R1ZmYsIGJ1dCBpZiBpdCBoYXBwZW5zIHRvIGJlXG4gIC8vIHRoZSBzYW1lIFwibmVnb3RpYXRlZFwiIGlkLCBpdCBpc24ndCByZWFsbHkgYSBkaWZmZXJlbnQgY2hhbm5lbC4gKGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9SVENQZWVyQ29ubmVjdGlvbi9kYXRhY2hhbm5lbF9ldmVudFxuICBkYXRhQ2hhbm5lbHMgPSBuZXcgTWFwKCk7XG4gIHJlcG9ydENoYW5uZWxzKCkgeyAvLyBSZXR1cm4gYSByZXBvcnQgc3RyaW5nIHVzZWZ1bCBmb3IgZGVidWdnaW5nLlxuICAgIGNvbnN0IGVudHJpZXMgPSBBcnJheS5mcm9tKHRoaXMuZGF0YUNoYW5uZWxzLmVudHJpZXMoKSk7XG4gICAgY29uc3Qga3YgPSBlbnRyaWVzLm1hcCgoW2ssIHZdKSA9PiBgJHtrfToke3YuaWR9YCk7XG4gICAgcmV0dXJuIGAke3RoaXMuZGF0YUNoYW5uZWxzLnNpemV9LyR7a3Yuam9pbignLCAnKX1gO1xuICB9XG4gIG5vdGVDaGFubmVsKGNoYW5uZWwsIHNvdXJjZSwgd2FpdGluZykgeyAvLyBCb29ra2VlcCBvcGVuIGNoYW5uZWwgYW5kIHJldHVybiBpdC5cbiAgICAvLyBFbXBlcmljYWxseSwgd2l0aCBtdWx0aXBsZXggZmFsc2U6IC8vICAgMTggb2NjdXJyZW5jZXMsIHdpdGggaWQ9bnVsbHwwfDEgYXMgZm9yIGV2ZW50Y2hhbm5lbCBvciBjcmVhdGVEYXRhQ2hhbm5lbFxuICAgIC8vICAgQXBwYXJlbnRseSwgd2l0aG91dCBuZWdvdGlhdGlvbiwgaWQgaXMgaW5pdGlhbGx5IG51bGwgKHJlZ2FyZGxlc3Mgb2Ygb3B0aW9ucy5pZCksIGFuZCB0aGVuIGFzc2lnbmVkIHRvIGEgZnJlZSB2YWx1ZSBkdXJpbmcgb3BlbmluZ1xuICAgIGNvbnN0IGtleSA9IGNoYW5uZWwubGFiZWw7IC8vZml4bWUgY2hhbm5lbC5pZCA9PT0gbnVsbCA/IDEgOiBjaGFubmVsLmlkO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5kYXRhQ2hhbm5lbHMuZ2V0KGtleSk7XG4gICAgdGhpcy5sb2coJ2dvdCBkYXRhLWNoYW5uZWwnLCBzb3VyY2UsIGtleSwgY2hhbm5lbC5yZWFkeVN0YXRlLCAnZXhpc3Rpbmc6JywgZXhpc3RpbmcsICd3YWl0aW5nOicsIHdhaXRpbmcpO1xuICAgIHRoaXMuZGF0YUNoYW5uZWxzLnNldChrZXksIGNoYW5uZWwpO1xuICAgIGNoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcignY2xvc2UnLCBldmVudCA9PiB7IC8vIENsb3NlIHdob2xlIGNvbm5lY3Rpb24gd2hlbiBubyBtb3JlIGRhdGEgY2hhbm5lbHMgb3Igc3RyZWFtcy5cbiAgICAgIHRoaXMuZGF0YUNoYW5uZWxzLmRlbGV0ZShrZXkpO1xuICAgICAgLy8gSWYgdGhlcmUncyBub3RoaW5nIG9wZW4sIGNsb3NlIHRoZSBjb25uZWN0aW9uLlxuICAgICAgaWYgKHRoaXMuZGF0YUNoYW5uZWxzLnNpemUpIHJldHVybjtcbiAgICAgIGlmICh0aGlzLnBlZXIuZ2V0U2VuZGVycygpLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgdGhpcy5jbG9zZSgpO1xuICAgIH0pO1xuICAgIHJldHVybiBjaGFubmVsO1xuICB9XG4gIGNyZWF0ZURhdGFDaGFubmVsKGxhYmVsID0gXCJkYXRhXCIsIGNoYW5uZWxPcHRpb25zID0ge30pIHsgLy8gUHJvbWlzZSByZXNvbHZlcyB3aGVuIHRoZSBjaGFubmVsIGlzIG9wZW4gKHdoaWNoIHdpbGwgYmUgYWZ0ZXIgYW55IG5lZWRlZCBuZWdvdGlhdGlvbikuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgdGhpcy5sb2coJ2NyZWF0ZSBkYXRhLWNoYW5uZWwnLCBsYWJlbCwgY2hhbm5lbE9wdGlvbnMpO1xuICAgICAgbGV0IGNoYW5uZWwgPSB0aGlzLnBlZXIuY3JlYXRlRGF0YUNoYW5uZWwobGFiZWwsIGNoYW5uZWxPcHRpb25zKTtcbiAgICAgIHRoaXMubm90ZUNoYW5uZWwoY2hhbm5lbCwgJ2V4cGxpY2l0Jyk7IC8vIE5vdGVkIGV2ZW4gYmVmb3JlIG9wZW5lZC5cbiAgICAgIC8vIFRoZSBjaGFubmVsIG1heSBoYXZlIGFscmVhZHkgYmVlbiBvcGVuZWQgb24gdGhlIG90aGVyIHNpZGUuIEluIHRoaXMgY2FzZSwgYWxsIGJyb3dzZXJzIGZpcmUgdGhlIG9wZW4gZXZlbnQgYW55d2F5LFxuICAgICAgLy8gYnV0IHdydGMgKGkuZS4sIG9uIG5vZGVKUykgZG9lcyBub3QuIFNvIHdlIGhhdmUgdG8gZXhwbGljaXRseSBjaGVjay5cbiAgICAgIHN3aXRjaCAoY2hhbm5lbC5yZWFkeVN0YXRlKSB7XG4gICAgICBjYXNlICdvcGVuJzpcblx0c2V0VGltZW91dCgoKSA9PiByZXNvbHZlKGNoYW5uZWwpLCAxMCk7XG5cdGJyZWFrO1xuICAgICAgY2FzZSAnY29ubmVjdGluZyc6XG5cdGNoYW5uZWwub25vcGVuID0gXyA9PiByZXNvbHZlKGNoYW5uZWwpO1xuXHRicmVhaztcbiAgICAgIGRlZmF1bHQ6XG5cdHRocm93IG5ldyBFcnJvcihgVW5leHBlY3RlZCByZWFkeVN0YXRlICR7Y2hhbm5lbC5yZWFkeVN0YXRlfSBmb3IgZGF0YSBjaGFubmVsICR7bGFiZWx9LmApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHdhaXRpbmdDaGFubmVscyA9IHt9O1xuICBnZXREYXRhQ2hhbm5lbFByb21pc2UobGFiZWwgPSBcImRhdGFcIikgeyAvLyBSZXNvbHZlcyB0byBhbiBvcGVuIGRhdGEgY2hhbm5lbC5cbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICB0aGlzLmxvZygncHJvbWlzZSBkYXRhLWNoYW5uZWwnLCBsYWJlbCk7XG4gICAgICB0aGlzLndhaXRpbmdDaGFubmVsc1tsYWJlbF0gPSByZXNvbHZlO1xuICAgIH0pO1xuICB9XG4gIHJlc2V0UGVlcigpIHsgLy8gUmVzZXQgYSAnY29ubmVjdGVkJyBwcm9wZXJ0eSB0aGF0IHByb21pc2VkIHRvIHJlc29sdmUgd2hlbiBvcGVuZWQsIGFuZCB0cmFjayBpbmNvbWluZyBkYXRhY2hhbm5lbHMuXG4gICAgc3VwZXIucmVzZXRQZWVyKCk7XG4gICAgdGhpcy5jb25uZWN0ZWQgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgLy8gdGhpcy5jb25uZWN0ZWQgaXMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiB3ZSBhcmUuXG4gICAgICB0aGlzLnBlZXIuYWRkRXZlbnRMaXN0ZW5lcignY29ubmVjdGlvbnN0YXRlY2hhbmdlJywgZXZlbnQgPT4ge1xuXHRpZiAodGhpcy5wZWVyLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2Nvbm5lY3RlZCcpIHtcblx0ICByZXNvbHZlKHRydWUpO1xuXHR9XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICB0aGlzLnBlZXIuYWRkRXZlbnRMaXN0ZW5lcignZGF0YWNoYW5uZWwnLCBldmVudCA9PiB7IC8vIFJlc29sdmUgcHJvbWlzZSBtYWRlIHdpdGggZ2V0RGF0YUNoYW5uZWxQcm9taXNlKCkuXG4gICAgICBjb25zdCBjaGFubmVsID0gZXZlbnQuY2hhbm5lbDtcbiAgICAgIGNvbnN0IGxhYmVsID0gY2hhbm5lbC5sYWJlbDtcbiAgICAgIGNvbnN0IHdhaXRpbmcgPSB0aGlzLndhaXRpbmdDaGFubmVsc1tsYWJlbF07XG4gICAgICB0aGlzLm5vdGVDaGFubmVsKGNoYW5uZWwsICdkYXRhY2hhbm5lbCBldmVudCcsIHdhaXRpbmcpOyAvLyBSZWdhcmRsZXNzIG9mIHdoZXRoZXIgd2UgYXJlIHdhaXRpbmcuXG4gICAgICBpZiAoIXdhaXRpbmcpIHJldHVybjsgLy8gTWlnaHQgbm90IGJlIGV4cGxpY2l0bHkgd2FpdGluZy4gRS5nLiwgcm91dGVycy5cbiAgICAgIGRlbGV0ZSB0aGlzLndhaXRpbmdDaGFubmVsc1tsYWJlbF07XG4gICAgICB3YWl0aW5nKGNoYW5uZWwpO1xuICAgIH0pO1xuICB9XG4gIGNsb3NlKCkge1xuICAgIGlmICh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnZmFpbGVkJykgdGhpcy5fc2lnbmFsUHJvbWlzZT8ucmVqZWN0Py4oKTtcbiAgICBzdXBlci5jbG9zZSgpO1xuICAgIHRoaXMuY2xlYXJJY2VUaW1lcigpO1xuICAgIHRoaXMuX3NpZ25hbFByb21pc2UgPSB0aGlzLl9zaWduYWxSZWFkeSA9IG51bGw7XG4gICAgdGhpcy5zZW5kaW5nID0gW107XG4gICAgLy8gSWYgdGhlIHdlYnJ0YyBpbXBsZW1lbnRhdGlvbiBjbG9zZXMgdGhlIGRhdGEgY2hhbm5lbHMgYmVmb3JlIHRoZSBwZWVyIGl0c2VsZiwgdGhlbiB0aGlzLmRhdGFDaGFubmVscyB3aWxsIGJlIGVtcHR5LlxuICAgIC8vIEJ1dCBpZiBub3QgKGUuZy4sIHN0YXR1cyAnZmFpbGVkJyBvciAnZGlzY29ubmVjdGVkJyBvbiBTYWZhcmkpLCB0aGVuIGxldCB1cyBleHBsaWNpdGx5IGNsb3NlIHRoZW0gc28gdGhhdCBTeW5jaHJvbml6ZXJzIGtub3cgdG8gY2xlYW4gdXAuXG4gICAgZm9yIChjb25zdCBjaGFubmVsIG9mIHRoaXMuZGF0YUNoYW5uZWxzLnZhbHVlcygpKSB7XG4gICAgICBpZiAoY2hhbm5lbC5yZWFkeVN0YXRlICE9PSAnb3BlbicpIGNvbnRpbnVlOyAvLyBLZWVwIGRlYnVnZ2luZyBzYW5pdHkuXG4gICAgICAvLyBJdCBhcHBlYXJzIHRoYXQgaW4gU2FmYXJpICgxOC41KSBmb3IgYSBjYWxsIHRvIGNoYW5uZWwuY2xvc2UoKSB3aXRoIHRoZSBjb25uZWN0aW9uIGFscmVhZHkgaW50ZXJuYWxsIGNsb3NlZCwgU2FmYXJpXG4gICAgICAvLyB3aWxsIHNldCBjaGFubmVsLnJlYWR5U3RhdGUgdG8gJ2Nsb3NpbmcnLCBidXQgTk9UIGZpcmUgdGhlIGNsb3NlZCBvciBjbG9zaW5nIGV2ZW50LiBTbyB3ZSBoYXZlIHRvIGRpc3BhdGNoIGl0IG91cnNlbHZlcy5cbiAgICAgIC8vY2hhbm5lbC5jbG9zZSgpO1xuICAgICAgY2hhbm5lbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2xvc2UnKSk7XG4gICAgfVxuICB9XG59XG5cbi8vIE5lZ290aWF0ZWQgY2hhbm5lbHMgdXNlIHNwZWNpZmljIGludGVnZXJzIG9uIGJvdGggc2lkZXMsIHN0YXJ0aW5nIHdpdGggdGhpcyBudW1iZXIuXG4vLyBXZSBkbyBub3Qgc3RhcnQgYXQgemVybyBiZWNhdXNlIHRoZSBub24tbmVnb3RpYXRlZCBjaGFubmVscyAoYXMgdXNlZCBvbiBzZXJ2ZXIgcmVsYXlzKSBnZW5lcmF0ZSB0aGVpclxuLy8gb3duIGlkcyBzdGFydGluZyB3aXRoIDAsIGFuZCB3ZSBkb24ndCB3YW50IHRvIGNvbmZsaWN0LlxuLy8gVGhlIHNwZWMgc2F5cyB0aGVzZSBjYW4gZ28gdG8gNjUsNTM0LCBidXQgSSBmaW5kIHRoYXQgc3RhcnRpbmcgZ3JlYXRlciB0aGFuIHRoZSB2YWx1ZSBoZXJlIGdpdmVzIGVycm9ycy5cbi8vIEFzIG9mIDcvNi8yNSwgY3VycmVudCBldmVyZ3JlZW4gYnJvd3NlcnMgd29yayB3aXRoIDEwMDAgYmFzZSwgYnV0IEZpcmVmb3ggZmFpbHMgaW4gb3VyIGNhc2UgKDEwIG5lZ290YXRpYXRlZCBjaGFubmVscylcbi8vIGlmIGFueSBpZHMgYXJlIDI1NiBvciBoaWdoZXIuXG5jb25zdCBCQVNFX0NIQU5ORUxfSUQgPSAxMjU7XG5leHBvcnQgY2xhc3MgU2hhcmVkV2ViUlRDIGV4dGVuZHMgUHJvbWlzZVdlYlJUQyB7XG4gIHN0YXRpYyBjb25uZWN0aW9ucyA9IG5ldyBNYXAoKTtcbiAgc3RhdGljIGVuc3VyZSh7c2VydmljZUxhYmVsLCBtdWx0aXBsZXggPSB0cnVlLCAuLi5yZXN0fSkge1xuICAgIGxldCBjb25uZWN0aW9uID0gdGhpcy5jb25uZWN0aW9ucy5nZXQoc2VydmljZUxhYmVsKTtcbiAgICAvLyBJdCBpcyBwb3NzaWJsZSB0aGF0IHdlIHdlcmUgYmFja2dyb3VuZGVkIGJlZm9yZSB3ZSBoYWQgYSBjaGFuY2UgdG8gYWN0IG9uIGEgY2xvc2luZyBjb25uZWN0aW9uIGFuZCByZW1vdmUgaXQuXG4gICAgaWYgKGNvbm5lY3Rpb24pIHtcbiAgICAgIGNvbnN0IHtjb25uZWN0aW9uU3RhdGUsIHNpZ25hbGluZ1N0YXRlfSA9IGNvbm5lY3Rpb24ucGVlcjtcbiAgICAgIGlmICgoY29ubmVjdGlvblN0YXRlID09PSAnY2xvc2VkJykgfHwgKHNpZ25hbGluZ1N0YXRlID09PSAnY2xvc2VkJykpIGNvbm5lY3Rpb24gPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIWNvbm5lY3Rpb24pIHtcbiAgICAgIGNvbm5lY3Rpb24gPSBuZXcgdGhpcyh7bGFiZWw6IHNlcnZpY2VMYWJlbCwgdXVpZDogdXVpZDQoKSwgbXVsdGlwbGV4LCAuLi5yZXN0fSk7XG4gICAgICBpZiAobXVsdGlwbGV4KSB0aGlzLmNvbm5lY3Rpb25zLnNldChzZXJ2aWNlTGFiZWwsIGNvbm5lY3Rpb24pO1xuICAgIH1cbiAgICByZXR1cm4gY29ubmVjdGlvbjtcbiAgfVxuICBjaGFubmVsSWQgPSBCQVNFX0NIQU5ORUxfSUQ7XG4gIGdldCBoYXNTdGFydGVkQ29ubmVjdGluZygpIHtcbiAgICByZXR1cm4gdGhpcy5jaGFubmVsSWQgPiBCQVNFX0NIQU5ORUxfSUQ7XG4gIH1cbiAgY2xvc2UocmVtb3ZlQ29ubmVjdGlvbiA9IHRydWUpIHtcbiAgICB0aGlzLmNoYW5uZWxJZCA9IEJBU0VfQ0hBTk5FTF9JRDtcbiAgICBzdXBlci5jbG9zZSgpO1xuICAgIGlmIChyZW1vdmVDb25uZWN0aW9uKSB0aGlzLmNvbnN0cnVjdG9yLmNvbm5lY3Rpb25zLmRlbGV0ZSh0aGlzLnNlcnZpY2VMYWJlbCk7XG4gIH1cbiAgYXN5bmMgZW5zdXJlRGF0YUNoYW5uZWwoY2hhbm5lbE5hbWUsIGNoYW5uZWxPcHRpb25zID0ge30sIHNpZ25hbHMgPSBudWxsKSB7IC8vIFJldHVybiBhIHByb21pc2UgZm9yIGFuIG9wZW4gZGF0YSBjaGFubmVsIG9uIHRoaXMgY29ubmVjdGlvbi5cbiAgICBjb25zdCBoYXNTdGFydGVkQ29ubmVjdGluZyA9IHRoaXMuaGFzU3RhcnRlZENvbm5lY3Rpbmc7IC8vIE11c3QgYXNrIGJlZm9yZSBpbmNyZW1lbnRpbmcgaWQuXG4gICAgY29uc3QgaWQgPSB0aGlzLmNoYW5uZWxJZCsrOyAvLyBUaGlzIGFuZCBldmVyeXRoaW5nIGxlYWRpbmcgdXAgdG8gaXQgbXVzdCBiZSBzeW5jaHJvbm91cywgc28gdGhhdCBpZCBhc3NpZ25tZW50IGlzIGRldGVybWluaXN0aWMuXG4gICAgY29uc3QgbmVnb3RpYXRlZCA9ICh0aGlzLm11bHRpcGxleCA9PT0gJ25lZ290aWF0ZWQnKSAmJiBoYXNTdGFydGVkQ29ubmVjdGluZztcbiAgICBjb25zdCBhbGxvd090aGVyU2lkZVRvQ3JlYXRlID0gIWhhc1N0YXJ0ZWRDb25uZWN0aW5nIC8qIW5lZ290aWF0ZWQqLyAmJiAhIXNpZ25hbHM7IC8vIE9ubHkgdGhlIDB0aCB3aXRoIHNpZ25hbHMgd2FpdHMgcGFzc2l2ZWx5LlxuICAgIC8vIHNpZ25hbHMgaXMgZWl0aGVyIG51bGxpc2ggb3IgYW4gYXJyYXkgb2Ygc2lnbmFscywgYnV0IHRoYXQgYXJyYXkgY2FuIGJlIEVNUFRZLFxuICAgIC8vIGluIHdoaWNoIGNhc2UgdGhlIHJlYWwgc2lnbmFscyB3aWxsIGhhdmUgdG8gYmUgYXNzaWduZWQgbGF0ZXIuIFRoaXMgYWxsb3dzIHRoZSBkYXRhIGNoYW5uZWwgdG8gYmUgc3RhcnRlZCAoYW5kIHRvIGNvbnN1bWVcbiAgICAvLyBhIGNoYW5uZWxJZCkgc3luY2hyb25vdXNseSwgYnV0IHRoZSBwcm9taXNlIHdvbid0IHJlc29sdmUgdW50aWwgdGhlIHJlYWwgc2lnbmFscyBhcmUgc3VwcGxpZWQgbGF0ZXIuIFRoaXMgaXNcbiAgICAvLyB1c2VmdWwgaW4gbXVsdGlwbGV4aW5nIGFuIG9yZGVyZWQgc2VyaWVzIG9mIGRhdGEgY2hhbm5lbHMgb24gYW4gQU5TV0VSIGNvbm5lY3Rpb24sIHdoZXJlIHRoZSBkYXRhIGNoYW5uZWxzIG11c3RcbiAgICAvLyBtYXRjaCB1cCB3aXRoIGFuIE9GRkVSIGNvbm5lY3Rpb24gb24gYSBwZWVyLiBUaGlzIHdvcmtzIGJlY2F1c2Ugb2YgdGhlIHdvbmRlcmZ1bCBoYXBwZW5zdGFuY2UgdGhhdCBhbnN3ZXIgY29ubmVjdGlvbnNcbiAgICAvLyBnZXREYXRhQ2hhbm5lbFByb21pc2UgKHdoaWNoIGRvZXNuJ3QgcmVxdWlyZSB0aGUgY29ubmVjdGlvbiB0byB5ZXQgYmUgb3BlbikgcmF0aGVyIHRoYW4gY3JlYXRlRGF0YUNoYW5uZWwgKHdoaWNoIHdvdWxkXG4gICAgLy8gcmVxdWlyZSB0aGUgY29ubmVjdGlvbiB0byBhbHJlYWR5IGJlIG9wZW4pLlxuICAgIGNvbnN0IHVzZVNpZ25hbHMgPSAhaGFzU3RhcnRlZENvbm5lY3RpbmcgJiYgc2lnbmFscz8ubGVuZ3RoO1xuICAgIGNvbnN0IG9wdGlvbnMgPSBuZWdvdGlhdGVkID8ge2lkLCBuZWdvdGlhdGVkLCAuLi5jaGFubmVsT3B0aW9uc30gOiBjaGFubmVsT3B0aW9ucztcbiAgICBpZiAoaGFzU3RhcnRlZENvbm5lY3RpbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMuY29ubmVjdGVkOyAvLyBCZWZvcmUgY3JlYXRpbmcgcHJvbWlzZS5cbiAgICAgIC8vIEkgc29tZXRpbWVzIGVuY291bnRlciBhIGJ1ZyBpbiBTYWZhcmkgaW4gd2hpY2ggT05FIG9mIHRoZSBjaGFubmVscyBjcmVhdGVkIHNvb24gYWZ0ZXIgY29ubmVjdGlvbiBnZXRzIHN0dWNrIGluXG4gICAgICAvLyB0aGUgY29ubmVjdGluZyByZWFkeVN0YXRlIGFuZCBuZXZlciBvcGVucy4gRXhwZXJpbWVudGFsbHksIHRoaXMgc2VlbXMgdG8gYmUgcm9idXN0LlxuICAgICAgLy9cbiAgICAgIC8vIE5vdGUgdG8gc2VsZjogSWYgaXQgc2hvdWxkIHR1cm4gb3V0IHRoYXQgd2Ugc3RpbGwgaGF2ZSBwcm9ibGVtcywgdHJ5IHNlcmlhbGl6aW5nIHRoZSBjYWxscyB0byBwZWVyLmNyZWF0ZURhdGFDaGFubmVsXG4gICAgICAvLyBzbyB0aGF0IHRoZXJlIGlzbid0IG1vcmUgdGhhbiBvbmUgY2hhbm5lbCBvcGVuaW5nIGF0IGEgdGltZS5cbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxMDApKTtcbiAgICB9IGVsc2UgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHRoaXMuc2lnbmFscyA9IHNpZ25hbHM7XG4gICAgfVxuICAgIGNvbnN0IHByb21pc2UgPSBhbGxvd090aGVyU2lkZVRvQ3JlYXRlID9cblx0ICB0aGlzLmdldERhdGFDaGFubmVsUHJvbWlzZShjaGFubmVsTmFtZSkgOlxuXHQgIHRoaXMuY3JlYXRlRGF0YUNoYW5uZWwoY2hhbm5lbE5hbWUsIG9wdGlvbnMpO1xuICAgIHJldHVybiBhd2FpdCBwcm9taXNlO1xuICB9XG59XG4iLCIvLyBuYW1lL3ZlcnNpb24gb2YgXCJkYXRhYmFzZVwiXG5leHBvcnQgY29uc3Qgc3RvcmFnZU5hbWUgPSAnZmxleHN0b3JlJztcbmV4cG9ydCBjb25zdCBzdG9yYWdlVmVyc2lvbiA9IDEwO1xuXG5pbXBvcnQgKiBhcyBwa2cgZnJvbSBcIi4uL3BhY2thZ2UuanNvblwiIHdpdGggeyB0eXBlOiAnanNvbicgfTtcbmV4cG9ydCBjb25zdCB7bmFtZSwgdmVyc2lvbn0gPSBwa2cuZGVmYXVsdDtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB7IHRhZ1BhdGggfSBmcm9tICcuL3RhZ1BhdGgubWpzJztcbmltcG9ydCB7IFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vd2VicnRjLm1qcyc7XG5pbXBvcnQgeyBzdG9yYWdlVmVyc2lvbiB9IGZyb20gJy4vdmVyc2lvbi5tanMnO1xuXG4vKlxuICBSZXNwb25zaWJsZSBmb3Iga2VlcGluZyBhIGNvbGxlY3Rpb24gc3luY2hyb25pemVkIHdpdGggYW5vdGhlciBwZWVyLlxuICAoUGVlcnMgbWF5IGJlIGEgY2xpZW50IG9yIGEgc2VydmVyL3JlbGF5LiBJbml0aWFsbHkgdGhpcyBpcyB0aGUgc2FtZSBjb2RlIGVpdGhlciB3YXksXG4gIGJ1dCBsYXRlciBvbiwgb3B0aW1pemF0aW9ucyBjYW4gYmUgbWFkZSBmb3Igc2NhbGUuKVxuXG4gIEFzIGxvbmcgYXMgdHdvIHBlZXJzIGFyZSBjb25uZWN0ZWQgd2l0aCBhIFN5bmNocm9uaXplciBvbiBlYWNoIHNpZGUsIHdyaXRpbmcgaGFwcGVuc1xuICBpbiBib3RoIHBlZXJzIGluIHJlYWwgdGltZSwgYW5kIHJlYWRpbmcgcHJvZHVjZXMgdGhlIGNvcnJlY3Qgc3luY2hyb25pemVkIHJlc3VsdCBmcm9tIGVpdGhlci5cbiAgVW5kZXIgdGhlIGhvb2QsIHRoZSBzeW5jaHJvbml6ZXIga2VlcHMgdHJhY2sgb2Ygd2hhdCBpdCBrbm93cyBhYm91dCB0aGUgb3RoZXIgcGVlciAtLVxuICBhIHBhcnRpY3VsYXIgdGFnIGNhbiBiZSB1bmtub3duLCB1bnN5bmNocm9uaXplZCwgb3Igc3luY2hyb25pemVkLCBhbmQgcmVhZGluZyB3aWxsXG4gIGNvbW11bmljYXRlIGFzIG5lZWRlZCB0byBnZXQgdGhlIGRhdGEgc3luY2hyb25pemVkIG9uLWRlbWFuZC4gTWVhbndoaWxlLCBzeW5jaHJvbml6YXRpb25cbiAgY29udGludWVzIGluIHRoZSBiYWNrZ3JvdW5kIHVudGlsIHRoZSBjb2xsZWN0aW9uIGlzIGZ1bGx5IHJlcGxpY2F0ZWQuXG5cbiAgQSBjb2xsZWN0aW9uIG1haW50YWlucyBhIHNlcGFyYXRlIFN5bmNocm9uaXplciBmb3IgZWFjaCBvZiB6ZXJvIG9yIG1vcmUgcGVlcnMsIGFuZCBjYW4gZHluYW1pY2FsbHlcbiAgYWRkIGFuZCByZW1vdmUgbW9yZS5cblxuICBOYW1pbmcgY29udmVudGlvbnM6XG5cbiAgbXVtYmxlTmFtZTogYSBzZW1hbnRpYyBuYW1lIHVzZWQgZXh0ZXJuYWxseSBhcyBhIGtleS4gRXhhbXBsZTogc2VydmljZU5hbWUsIGNoYW5uZWxOYW1lLCBldGMuXG4gICAgV2hlbiB0aGluZ3MgbmVlZCB0byBtYXRjaCB1cCBhY3Jvc3Mgc3lzdGVtcywgaXQgaXMgYnkgbmFtZS5cbiAgICBJZiBvbmx5IG9uZSBvZiBuYW1lL2xhYmVsIGlzIHNwZWNpZmllZCwgdGhpcyBpcyB1c3VhbGx5IHRoZSB0aGUgb25lLlxuXG4gIG11bWJsZUxhYmVsOiBhIGxhYmVsIGZvciBpZGVudGlmaWNhdGlvbiBhbmQgaW50ZXJuYWxseSAoZS5nLiwgZGF0YWJhc2UgbmFtZSkuXG4gICAgV2hlbiB0d28gaW5zdGFuY2VzIG9mIHNvbWV0aGluZyBhcmUgXCJ0aGUgc2FtZVwiIGJ1dCBhcmUgaW4gdGhlIHNhbWUgSmF2YXNjcmlwdCBpbWFnZSBmb3IgdGVzdGluZywgdGhleSBhcmUgZGlzdGluZ3Vpc2hlZCBieSBsYWJlbC5cbiAgICBUeXBpY2FsbHkgZGVmYXVsdHMgdG8gbXVtYmxlTmFtZS5cblxuICBOb3RlLCB0aG91Z2gsIHRoYXQgc29tZSBleHRlcm5hbCBtYWNoaW5lcnkgKHN1Y2ggYXMgYSBXZWJSVEMgRGF0YUNoYW5uZWwpIGhhcyBhIFwibGFiZWxcIiBwcm9wZXJ0eSB0aGF0IHdlIHBvcHVsYXRlIHdpdGggYSBcIm5hbWVcIiAoY2hhbm5lbE5hbWUpLlxuICovXG5leHBvcnQgY2xhc3MgU3luY2hyb25pemVyIHtcbiAgc3RhdGljIHZlcnNpb24gPSBzdG9yYWdlVmVyc2lvbjtcbiAgY29uc3RydWN0b3Ioe3NlcnZpY2VOYW1lID0gJ2RpcmVjdCcsIGNvbGxlY3Rpb24sIGVycm9yID0gY29sbGVjdGlvbj8uY29uc3RydWN0b3IuZXJyb3IgfHwgY29uc29sZS5lcnJvcixcblx0ICAgICAgIHNlcnZpY2VMYWJlbCA9IGNvbGxlY3Rpb24/LnNlcnZpY2VMYWJlbCB8fCBzZXJ2aWNlTmFtZSwgLy8gVXNlZCB0byBpZGVudGlmeSBhbnkgZXhpc3RpbmcgY29ubmVjdGlvbi4gQ2FuIGJlIGRpZmZlcmVudCBmcm9tIHNlcnZpY2VOYW1lIGR1cmluZyB0ZXN0aW5nLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHV1aWQgPSBjb2xsZWN0aW9uPy51dWlkLCBydGNDb25maWd1cmF0aW9uLCBjb25uZWN0aW9uLCAvLyBDb21wbGV4IGRlZmF1bHQgYmVoYXZpb3IgZm9yIHRoZXNlLiBTZWUgY29kZS5cblx0ICAgICAgIG11bHRpcGxleCA9IGNvbGxlY3Rpb24/Lm11bHRpcGxleCwgLy8gSWYgc3BlY2lmZWQsIG90aGVyd2lzZSB1bmRlZmluZWQgYXQgdGhpcyBwb2ludC4gU2VlIGJlbG93LlxuXHQgICAgICAgZGVidWcgPSBjb2xsZWN0aW9uPy5kZWJ1ZywgbWF4VmVyc2lvbiA9IFN5bmNocm9uaXplci52ZXJzaW9uLCBtaW5WZXJzaW9uID0gbWF4VmVyc2lvbn0pIHtcbiAgICAvLyBzZXJ2aWNlTmFtZSBpcyBhIHN0cmluZyBvciBvYmplY3QgdGhhdCBpZGVudGlmaWVzIHdoZXJlIHRoZSBzeW5jaHJvbml6ZXIgc2hvdWxkIGNvbm5lY3QuIEUuZy4sIGl0IG1heSBiZSBhIFVSTCBjYXJyeWluZ1xuICAgIC8vICAgV2ViUlRDIHNpZ25hbGluZy4gSXQgc2hvdWxkIGJlIGFwcC11bmlxdWUgZm9yIHRoaXMgcGFydGljdWxhciBzZXJ2aWNlIChlLmcuLCB3aGljaCBtaWdodCBtdWx0aXBsZXggZGF0YSBmb3IgbXVsdGlwbGUgY29sbGVjdGlvbiBpbnN0YW5jZXMpLlxuICAgIC8vIHV1aWQgaGVscCB1bmlxdWVseSBpZGVudGlmaWVzIHRoaXMgcGFydGljdWxhciBzeW5jaHJvbml6ZXIuXG4gICAgLy8gICBGb3IgbW9zdCBwdXJwb3NlcywgdXVpZCBzaG91bGQgZ2V0IHRoZSBkZWZhdWx0LCBhbmQgcmVmZXJzIHRvIE9VUiBlbmQuXG4gICAgLy8gICBIb3dldmVyLCBhIHNlcnZlciB0aGF0IGNvbm5lY3RzIHRvIGEgYnVuY2ggb2YgcGVlcnMgbWlnaHQgYmFzaCBpbiB0aGUgdXVpZCB3aXRoIHRoYXQgb2YgdGhlIG90aGVyIGVuZCwgc28gdGhhdCBsb2dnaW5nIGluZGljYXRlcyB0aGUgY2xpZW50LlxuICAgIC8vIElmIGNoYW5uZWxOYW1lIGlzIHNwZWNpZmllZCwgaXQgc2hvdWxkIGJlIGluIHRoZSBmb3JtIG9mIGNvbGxlY3Rpb25UeXBlL2NvbGxlY3Rpb25OYW1lIChlLmcuLCBpZiBjb25uZWN0aW5nIHRvIHJlbGF5KS5cbiAgICBjb25zdCBjb25uZWN0VGhyb3VnaEludGVybmV0ID0gc2VydmljZU5hbWUuc3RhcnRzV2l0aD8uKCdodHRwJyk7XG4gICAgaWYgKCFjb25uZWN0VGhyb3VnaEludGVybmV0ICYmIChydGNDb25maWd1cmF0aW9uID09PSB1bmRlZmluZWQpKSBydGNDb25maWd1cmF0aW9uID0ge307IC8vIEV4cGljaXRseSBubyBpY2UuIExBTiBvbmx5LlxuICAgIC8vIG11bHRpcGxleCBzaG91bGQgZW5kIHVwIHdpdGggb25lIG9mIHRocmVlIHZhbHVlczpcbiAgICAvLyBmYWxzeSAtIGEgbmV3IGNvbm5lY3Rpb24gc2hvdWxkIGJlIHVzZWQgZm9yIGVhY2ggY2hhbm5lbFxuICAgIC8vIFwibmVnb3RpYXRlZFwiIC0gYm90aCBzaWRlcyBjcmVhdGUgdGhlIHNhbWUgY2hhbm5lbE5hbWVzIGluIHRoZSBzYW1lIG9yZGVyIChtb3N0IGNhc2VzKTpcbiAgICAvLyAgICAgVGhlIGluaXRpYWwgc2lnbmFsbGluZyB3aWxsIGJlIHRyaWdnZXJlZCBieSBvbmUgc2lkZSBjcmVhdGluZyBhIGNoYW5uZWwsIGFuZCB0aGVyIHNpZGUgd2FpdGluZyBmb3IgaXQgdG8gYmUgY3JlYXRlZC5cbiAgICAvLyAgICAgQWZ0ZXIgdGhhdCwgYm90aCBzaWRlcyB3aWxsIGV4cGxpY2l0bHkgY3JlYXRlIGEgZGF0YSBjaGFubmVsIGFuZCB3ZWJydGMgd2lsbCBtYXRjaCB0aGVtIHVwIGJ5IGlkLlxuICAgIC8vIGFueSBvdGhlciB0cnV0aHkgLSBTdGFydHMgbGlrZSBuZWdvdGlhdGVkLCBhbmQgdGhlbiBjb250aW51ZXMgd2l0aCBvbmx5IHdpZGUgc2lkZSBjcmVhdGluZyB0aGUgY2hhbm5lbHMsIGFuZCB0aGVyIG90aGVyXG4gICAgLy8gICAgIG9ic2VydmVzIHRoZSBjaGFubmVsIHRoYXQgaGFzIGJlZW4gbWFkZS4gVGhpcyBpcyB1c2VkIGZvciByZWxheXMuXG4gICAgbXVsdGlwbGV4ID8/PSBjb25uZWN0aW9uPy5tdWx0aXBsZXg7IC8vIFN0aWxsIHR5cGljYWxseSB1bmRlZmluZWQgYXQgdGhpcyBwb2ludC5cbiAgICBtdWx0aXBsZXggPz89IChzZXJ2aWNlTmFtZS5pbmNsdWRlcz8uKCcvc3luYycpIHx8ICduZWdvdGlhdGVkJyk7XG4gICAgY29ubmVjdGlvbiA/Pz0gU2hhcmVkV2ViUlRDLmVuc3VyZSh7c2VydmljZUxhYmVsLCBjb25maWd1cmF0aW9uOiBydGNDb25maWd1cmF0aW9uLCBtdWx0aXBsZXgsIHV1aWQsIGRlYnVnLCBlcnJvcn0pO1xuXG4gICAgdXVpZCA/Pz0gY29ubmVjdGlvbi51dWlkO1xuICAgIC8vIEJvdGggcGVlcnMgbXVzdCBhZ3JlZSBvbiBjaGFubmVsTmFtZS4gVXN1YWxseSwgdGhpcyBpcyBjb2xsZWN0aW9uLmZ1bGxOYW1lLiBCdXQgaW4gdGVzdGluZywgd2UgbWF5IHN5bmMgdHdvIGNvbGxlY3Rpb25zIHdpdGggZGlmZmVyZW50IG5hbWVzLlxuICAgIGNoYW5uZWxOYW1lID8/PSBjb2xsZWN0aW9uPy5jaGFubmVsTmFtZSB8fCBjb2xsZWN0aW9uLmZ1bGxOYW1lO1xuICAgIGNvbnN0IGxhYmVsID0gYCR7Y29sbGVjdGlvbj8uZnVsbExhYmVsIHx8IGNoYW5uZWxOYW1lfS8ke3V1aWR9YDtcbiAgICAvLyBXaGVyZSB3ZSBjYW4gcmVxdWVzdCBhIGRhdGEgY2hhbm5lbCB0aGF0IHB1c2hlcyBwdXQvZGVsZXRlIHJlcXVlc3RzIGZyb20gb3RoZXJzLlxuICAgIGNvbnN0IGNvbm5lY3Rpb25VUkwgPSBzZXJ2aWNlTmFtZS5pbmNsdWRlcz8uKCcvc2lnbmFsLycpID8gc2VydmljZU5hbWUgOiBgJHtzZXJ2aWNlTmFtZX0vJHtsYWJlbH1gO1xuXG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7c2VydmljZU5hbWUsIGxhYmVsLCBjb2xsZWN0aW9uLCBkZWJ1ZywgZXJyb3IsIG1pblZlcnNpb24sIG1heFZlcnNpb24sIHV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sXG5cdFx0XHQgY29ubmVjdGlvbiwgdXVpZCwgY2hhbm5lbE5hbWUsIGNvbm5lY3Rpb25VUkwsXG5cdFx0XHQgY29ubmVjdGlvblN0YXJ0VGltZTogRGF0ZS5ub3coKSxcblx0XHRcdCBjbG9zZWQ6IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpLFxuXHRcdFx0IC8vIE5vdCB1c2VkIHlldCwgYnV0IGNvdWxkIGJlIHVzZWQgdG8gR0VUIHJlc291cmNlcyBvdmVyIGh0dHAgaW5zdGVhZCBvZiB0aHJvdWdoIHRoZSBkYXRhIGNoYW5uZWwuXG5cdFx0XHQgaG9zdFJlcXVlc3RCYXNlOiBjb25uZWN0VGhyb3VnaEludGVybmV0ICYmIGAke3NlcnZpY2VOYW1lLnJlcGxhY2UoL1xcLyhzeW5jfHNpZ25hbCkvKX0vJHtjaGFubmVsTmFtZX1gfSk7XG4gICAgY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5zZXQoc2VydmljZU5hbWUsIHRoaXMpOyAvLyBNdXN0IGJlIHNldCBzeW5jaHJvbm91c2x5LCBzbyB0aGF0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxIGtub3dzIHRvIHdhaXQuXG4gIH1cbiAgc3RhdGljIGFzeW5jIGNyZWF0ZShjb2xsZWN0aW9uLCBzZXJ2aWNlTmFtZSwgb3B0aW9ucyA9IHt9KSB7IC8vIFJlY2VpdmUgcHVzaGVkIG1lc3NhZ2VzIGZyb20gdGhlIGdpdmVuIHNlcnZpY2UuIGdldC9wdXQvZGVsZXRlIHdoZW4gdGhleSBjb21lICh3aXRoIGVtcHR5IHNlcnZpY2VzIGxpc3QpLlxuICAgIGNvbnN0IHN5bmNocm9uaXplciA9IG5ldyB0aGlzKHtjb2xsZWN0aW9uLCBzZXJ2aWNlTmFtZSwgLi4ub3B0aW9uc30pO1xuICAgIGNvbnN0IGNvbm5lY3RlZFByb21pc2UgPSBzeW5jaHJvbml6ZXIuY29ubmVjdENoYW5uZWwoKTsgLy8gRXN0YWJsaXNoIGNoYW5uZWwgY3JlYXRpb24gb3JkZXIuXG4gICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgY29ubmVjdGVkUHJvbWlzZTtcbiAgICBpZiAoIWNvbm5lY3RlZCkgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgICByZXR1cm4gYXdhaXQgY29ubmVjdGVkLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdENoYW5uZWwoKSB7IC8vIFN5bmNocm9ub3VzbHkgaW5pdGlhbGl6ZSBhbnkgcHJvbWlzZXMgdG8gY3JlYXRlIGEgZGF0YSBjaGFubmVsLCBhbmQgdGhlbiBhd2FpdCBjb25uZWN0aW9uLlxuICAgIGNvbnN0IHtob3N0UmVxdWVzdEJhc2UsIHV1aWQsIGNvbm5lY3Rpb24sIHNlcnZpY2VOYW1lfSA9IHRoaXM7XG4gICAgbGV0IHN0YXJ0ZWQgPSBjb25uZWN0aW9uLmhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGlmIChzdGFydGVkKSB7XG4gICAgICAvLyBXZSBhbHJlYWR5IGhhdmUgYSBjb25uZWN0aW9uLiBKdXN0IG9wZW4gYW5vdGhlciBkYXRhIGNoYW5uZWwgZm9yIG91ciB1c2UuXG4gICAgICBzdGFydGVkID0gdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgPSBjb25uZWN0aW9uLmVuc3VyZURhdGFDaGFubmVsKHRoaXMuY2hhbm5lbE5hbWUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc3luYycpKSB7IC8vIENvbm5lY3Qgd2l0aCBhIHNlcnZlciByZWxheS4gKFNpZ25hbCBhbmQgc3RheSBjb25uZWN0ZWQgdGhyb3VnaCBzeW5jLilcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmNvbm5lY3RTZXJ2ZXIoKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3NpZ25hbC9hbnN3ZXInKSkgeyAvLyBTZWVraW5nIGFuIGFuc3dlciB0byBhbiBvZmZlciB3ZSBQT1NUICh0byByZW5kZXZvdXMgd2l0aCBhIHBlZXIpLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpOyAvLyBKdXN0IGxpa2UgYSBzeW5jXG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zaWduYWwvb2ZmZXInKSkgeyAvLyBHRVQgYW4gb2ZmZXIgZnJvbSBhIHJlbmRldm91cyBwZWVyIGFuZCB0aGVuIFBPU1QgYW4gYW5zd2VyLlxuICAgICAgLy8gV2UgbXVzdCBzeWNocm9ub3VzbHkgc3RhcnRDb25uZWN0aW9uIG5vdyBzbyB0aGF0IG91ciBjb25uZWN0aW9uIGhhc1N0YXJ0ZWRDb25uZWN0aW5nLCBhbmQgYW55IHN1YnNlcXVlbnQgZGF0YSBjaGFubmVsXG4gICAgICAvLyByZXF1ZXN0cyBvbiB0aGUgc2FtZSBjb25uZWN0aW9uIHdpbGwgd2FpdCAodXNpbmcgdGhlICdzdGFydGVkJyBwYXRoLCBhYm92ZSkuXG4gICAgICAvLyBDb21wYXJlIGNvbm5lY3RTZXJ2ZXIsIHdoaWNoIGlzIGJhc2ljYWxseTpcbiAgICAgIC8vICAgc3RhcnRDb25uZWN0aW9uKCksIGZldGNoIHdpdGggdGhhdCBvZmZlciwgY29tcGxldGVDb25uZWN0aW9uIHdpdGggZmV0Y2hlZCBhbnN3ZXIuXG4gICAgICBjb25zdCBwcm9taXNlZFNpZ25hbHMgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbihbXSk7IC8vIEVzdGFibGlzaGluZyBvcmRlci5cbiAgICAgIGNvbnN0IHVybCA9IHRoaXMuY29ubmVjdGlvblVSTDtcbiAgICAgIGNvbnN0IG9mZmVyID0gYXdhaXQgdGhpcy5mZXRjaCh1cmwpO1xuICAgICAgY29uc3Qgb2sgPSB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbihvZmZlcik7IC8vIE5vdyBzdXBwbHkgdGhvc2Ugc2lnbmFscyBzbyB0aGF0IG91ciBjb25uZWN0aW9uIGNhbiBwcm9kdWNlIGFuc3dlciBzaWdhbHMuXG4gICAgICBjb25zdCBhbnN3ZXIgPSBhd2FpdCBwcm9taXNlZFNpZ25hbHM7XG4gICAgICBzdGFydGVkID0gdGhpcy5mZXRjaCh1cmwsIGFuc3dlcik7IC8vIFBPU1Qgb3VyIGFuc3dlciB0byBwZWVyLlxuICAgIH0gZWxzZSBpZiAoc2VydmljZU5hbWUgPT09ICdzaWduYWxzJykgeyAvLyBTdGFydCBjb25uZWN0aW9uIGFuZCByZXR1cm4gbnVsbC4gTXVzdCBiZSBjb250aW51ZWQgd2l0aCBjb21wbGV0ZVNpZ25hbHNTeW5jaHJvbml6YXRpb24oKTtcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbigpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHNlcnZpY2VOYW1lKSkgeyAvLyBBIGxpc3Qgb2YgXCJyZWNlaXZpbmdcIiBzaWduYWxzLlxuICAgICAgc3RhcnRlZCA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKHNlcnZpY2VOYW1lKTtcbiAgICB9IGVsc2UgaWYgKHNlcnZpY2VOYW1lLnN5bmNocm9uaXplcnMpIHsgLy8gRHVjayB0eXBpbmcgZm9yIHBhc3NpbmcgYSBjb2xsZWN0aW9uIGRpcmVjdGx5IGFzIHRoZSBzZXJ2aWNlSW5mby4gKFdlIGRvbid0IGltcG9ydCBDb2xsZWN0aW9uLilcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmNvbm5lY3REaXJlY3RUZXN0aW5nKHNlcnZpY2VOYW1lKTsgLy8gVXNlZCBpbiB0ZXN0aW5nLlxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVucmVjb2duaXplZCBzZXJ2aWNlIGZvcm1hdDogJHtzZXJ2aWNlTmFtZX0uYCk7XG4gICAgfVxuICAgIGlmICghKGF3YWl0IHN0YXJ0ZWQpKSB7XG4gICAgICBjb25zb2xlLndhcm4odGhpcy5sYWJlbCwgJ2Nvbm5lY3Rpb24gZmFpbGVkJyk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBsb2coLi4ucmVzdCkge1xuICAgIGlmICh0aGlzLmRlYnVnKSBjb25zb2xlLmxvZyh0aGlzLmxhYmVsLCAuLi5yZXN0KTtcbiAgfVxuICBnZXQgZGF0YUNoYW5uZWxQcm9taXNlKCkgeyAvLyBBIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhbiBvcGVuIGRhdGEgY2hhbm5lbC5cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy5fZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGlmICghcHJvbWlzZSkgdGhyb3cgbmV3IEVycm9yKGAke3RoaXMubGFiZWx9OiBEYXRhIGNoYW5uZWwgaXMgbm90IHlldCBwcm9taXNlZC5gKTtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICBjaGFubmVsQ2xvc2VkQ2xlYW51cCgpIHsgLy8gQm9va2tlZXBpbmcgd2hlbiBjaGFubmVsIGNsb3NlZCBvciBleHBsaWNpdGx5IGFiYW5kb25lZCBiZWZvcmUgb3BlbmluZy5cbiAgICB0aGlzLmNvbGxlY3Rpb24/LnN5bmNocm9uaXplcnMuZGVsZXRlKHRoaXMuc2VydmljZU5hbWUpO1xuICAgIHRoaXMuY2xvc2VkLnJlc29sdmUodGhpcyk7IC8vIFJlc29sdmUgdG8gc3luY2hyb25pemVyIGlzIG5pY2UgaWYsIGUuZywgc29tZW9uZSBpcyBQcm9taXNlLnJhY2luZy5cbiAgfVxuICBzZXQgZGF0YUNoYW5uZWxQcm9taXNlKHByb21pc2UpIHsgLy8gU2V0IHVwIG1lc3NhZ2UgYW5kIGNsb3NlIGhhbmRsaW5nLlxuICAgIHRoaXMuX2RhdGFDaGFubmVsUHJvbWlzZSA9IHByb21pc2UudGhlbihkYXRhQ2hhbm5lbCA9PiB7XG4gICAgICBkYXRhQ2hhbm5lbC5vbm1lc3NhZ2UgPSBldmVudCA9PiB0aGlzLnJlY2VpdmUoZXZlbnQuZGF0YSk7XG4gICAgICBkYXRhQ2hhbm5lbC5vbmNsb3NlID0gYXN5bmMgZXZlbnQgPT4gdGhpcy5jaGFubmVsQ2xvc2VkQ2xlYW51cCgpO1xuICAgICAgcmV0dXJuIGRhdGFDaGFubmVsO1xuICAgIH0pO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplKCkge1xuICAgIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuICBzdGF0aWMgZnJhZ21lbnRJZCA9IDA7XG4gIGFzeW5jIHNlbmQobWV0aG9kLCAuLi5wYXJhbXMpIHsgLy8gU2VuZHMgdG8gdGhlIHBlZXIsIG92ZXIgdGhlIGRhdGEgY2hhbm5lbFxuICAgIC8vIFRPRE86IGJyZWFrIHVwIGxvbmcgbWVzc2FnZXMuIChBcyBhIHByYWN0aWNhbCBtYXR0ZXIsIDE2IEtpQiBpcyB0aGUgbG9uZ2VzdCB0aGF0IGNhbiByZWxpYWJseSBiZSBzZW50IGFjcm9zcyBkaWZmZXJlbnQgd3J0YyBpbXBsZW1lbnRhdGlvbnMuKVxuICAgIC8vIFNlZSBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvV2ViUlRDX0FQSS9Vc2luZ19kYXRhX2NoYW5uZWxzI2NvbmNlcm5zX3dpdGhfbGFyZ2VfbWVzc2FnZXNcbiAgICBjb25zdCBwYXlsb2FkID0gSlNPTi5zdHJpbmdpZnkoe21ldGhvZCwgcGFyYW1zfSk7XG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBjb25zdCBzdGF0ZSA9IGRhdGFDaGFubmVsPy5yZWFkeVN0YXRlIHx8ICdjbG9zZWQnO1xuICAgIGlmIChzdGF0ZSA9PT0gJ2Nsb3NlZCcgfHwgc3RhdGUgPT09ICdjbG9zaW5nJykgcmV0dXJuO1xuICAgIHRoaXMubG9nKCdzZW5kcycsIG1ldGhvZCwgLi4ucGFyYW1zKTtcbiAgICBjb25zdCBzaXplID0gMTZlMzsgLy8gQSBiaXQgbGVzcyB0aGFuIDE2ICogMTAyNC5cbiAgICBpZiAocGF5bG9hZC5sZW5ndGggPCBzaXplKSB7XG4gICAgICBkYXRhQ2hhbm5lbC5zZW5kKHBheWxvYWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBudW1DaHVua3MgPSBNYXRoLmNlaWwocGF5bG9hZC5sZW5ndGggLyBzaXplKTtcbiAgICBjb25zdCBpZCA9IHRoaXMuY29uc3RydWN0b3IuZnJhZ21lbnRJZCsrO1xuICAgIGNvbnN0IG1ldGEgPSB7bWV0aG9kOiAnZnJhZ21lbnRzJywgcGFyYW1zOiBbaWQsIG51bUNodW5rc119O1xuICAgIC8vY29uc29sZS5sb2coYEZyYWdtZW50aW5nIG1lc3NhZ2UgJHtpZH0gaW50byAke251bUNodW5rc30gY2h1bmtzLmAsIG1ldGEpO1xuICAgIGRhdGFDaGFubmVsLnNlbmQoSlNPTi5zdHJpbmdpZnkobWV0YSkpO1xuICAgIC8vIE9wdGltaXphdGlvbiBvcHBvcnR1bml0eTogcmVseSBvbiBtZXNzYWdlcyBiZWluZyBvcmRlcmVkIGFuZCBza2lwIHJlZHVuZGFudCBpbmZvLiBJcyBpdCB3b3J0aCBpdD9cbiAgICBmb3IgKGxldCBpID0gMCwgbyA9IDA7IGkgPCBudW1DaHVua3M7ICsraSwgbyArPSBzaXplKSB7XG4gICAgICBjb25zdCBmcmFnID0ge21ldGhvZDogJ2ZyYWcnLCBwYXJhbXM6IFtpZCwgaSwgcGF5bG9hZC5zdWJzdHIobywgc2l6ZSldfTtcbiAgICAgIGRhdGFDaGFubmVsLnNlbmQoSlNPTi5zdHJpbmdpZnkoZnJhZykpO1xuICAgIH1cbiAgfVxuICByZWNlaXZlKHRleHQpIHsgLy8gRGlzcGF0Y2ggYSBtZXNzYWdlIHNlbnQgb3ZlciB0aGUgZGF0YSBjaGFubmVsIGZyb20gdGhlIHBlZXIuXG4gICAgY29uc3Qge21ldGhvZCwgcGFyYW1zfSA9IEpTT04ucGFyc2UodGV4dCk7XG4gICAgdGhpc1ttZXRob2RdKC4uLnBhcmFtcyk7XG4gIH1cbiAgcGVuZGluZ0ZyYWdtZW50cyA9IHt9O1xuICBmcmFnbWVudHMoaWQsIG51bUNodW5rcykge1xuICAgIC8vY29uc29sZS5sb2coYFJlY2VpdmluZyBtZXNhZ2UgJHtpZH0gaW4gJHtudW1DaHVua3N9LmApO1xuICAgIHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF0gPSB7cmVtYWluaW5nOiBudW1DaHVua3MsIG1lc3NhZ2U6IEFycmF5KG51bUNodW5rcyl9O1xuICB9XG4gIGZyYWcoaWQsIGksIGZyYWdtZW50KSB7XG4gICAgbGV0IGZyYWcgPSB0aGlzLnBlbmRpbmdGcmFnbWVudHNbaWRdOyAvLyBXZSBhcmUgcmVseWluZyBvbiBmcmFnbWVudCBtZXNzYWdlIGNvbWluZyBmaXJzdC5cbiAgICBmcmFnLm1lc3NhZ2VbaV0gPSBmcmFnbWVudDtcbiAgICBpZiAoMCAhPT0gLS1mcmFnLnJlbWFpbmluZykgcmV0dXJuO1xuICAgIC8vY29uc29sZS5sb2coYERpc3BhdGNoaW5nIG1lc3NhZ2UgJHtpZH0uYCk7XG4gICAgdGhpcy5yZWNlaXZlKGZyYWcubWVzc2FnZS5qb2luKCcnKSk7XG4gICAgZGVsZXRlIHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF07XG4gIH1cblxuICBhc3luYyBkaXNjb25uZWN0KCkgeyAvLyBXYWl0IGZvciBkYXRhQ2hhbm5lbCB0byBkcmFpbiBhbmQgcmV0dXJuIGEgcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gYWN0dWFsbHkgY2xvc2VkLFxuICAgIC8vIGJ1dCByZXR1cm4gaW1tZWRpYXRlbHkgaWYgY29ubmVjdGlvbiBub3Qgc3RhcnRlZC5cbiAgICBpZiAodGhpcy5jb25uZWN0aW9uLnBlZXIuY29ubmVjdGlvblN0YXRlICE9PSAnY29ubmVjdGVkJykgcmV0dXJuIHRoaXMuY2hhbm5lbENsb3NlZENsZWFudXAodGhpcy5jb25uZWN0aW9uLmNsb3NlKCkpO1xuICAgIGNvbnN0IGRhdGFDaGFubmVsID0gYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgZGF0YUNoYW5uZWwuY2xvc2UoKTtcbiAgICByZXR1cm4gdGhpcy5jbG9zZWQ7XG4gIH1cbiAgLy8gVE9ETzogd2VicnRjIG5lZ290aWF0aW9uIG5lZWRlZCBkdXJpbmcgc3luYy5cbiAgLy8gVE9ETzogd2VicnRjIG5lZ290aWF0aW9uIG5lZWRlZCBhZnRlciBzeW5jLlxuICBzdGFydENvbm5lY3Rpb24oc2lnbmFsTWVzc2FnZXMpIHsgLy8gTWFjaGluZXJ5IGZvciBtYWtpbmcgYSBXZWJSVEMgY29ubmVjdGlvbiB0byB0aGUgcGVlcjpcbiAgICAvLyAgIElmIHNpZ25hbE1lc3NhZ2VzIGlzIGEgbGlzdCBvZiBbb3BlcmF0aW9uLCBtZXNzYWdlXSBtZXNzYWdlIG9iamVjdHMsIHRoZW4gdGhlIG90aGVyIHNpZGUgaXMgaW5pdGlhdGluZ1xuICAgIC8vIHRoZSBjb25uZWN0aW9uIGFuZCBoYXMgc2VudCBhbiBpbml0aWFsIG9mZmVyL2ljZS4gSW4gdGhpcyBjYXNlLCBzdGFydENvbm5lY3QoKSBwcm9taXNlcyBhIHJlc3BvbnNlXG4gICAgLy8gdG8gYmUgZGVsaXZlcmVkIHRvIHRoZSBvdGhlciBzaWRlLlxuICAgIC8vICAgT3RoZXJ3aXNlLCBzdGFydENvbm5lY3QoKSBwcm9taXNlcyBhIGxpc3Qgb2YgaW5pdGlhbCBzaWduYWwgbWVzc2FnZXMgdG8gYmUgZGVsaXZlcmVkIHRvIHRoZSBvdGhlciBzaWRlLFxuICAgIC8vIGFuZCBpdCBpcyBuZWNlc3NhcnkgdG8gdGhlbiBjYWxsIGNvbXBsZXRlQ29ubmVjdGlvbigpIHdpdGggdGhlIHJlc3BvbnNlIGZyb20gdGhlbS5cbiAgICAvLyBJbiBib3RoIGNhc2VzLCBhcyBhIHNpZGUgZWZmZWN0LCB0aGUgZGF0YUNoYW5uZWxQcm9taXNlIHByb3BlcnR5IHdpbGwgYmUgc2V0IHRvIGEgUHJvbWlzZVxuICAgIC8vIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIGRhdGEgY2hhbm5lbCB3aGVuIGl0IGlzIG9wZW5zLiBUaGlzIHByb21pc2UgaXMgdXNlZCBieSBzZW5kKCkgYW5kIHJlY2VpdmUoKS5cbiAgICBjb25zdCB7Y29ubmVjdGlvbn0gPSB0aGlzO1xuICAgIHRoaXMubG9nKHNpZ25hbE1lc3NhZ2VzID8gJ2dlbmVyYXRpbmcgYW5zd2VyJyA6ICdnZW5lcmF0aW5nIG9mZmVyJyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UgPSBjb25uZWN0aW9uLmVuc3VyZURhdGFDaGFubmVsKHRoaXMuY2hhbm5lbE5hbWUsIHt9LCBzaWduYWxNZXNzYWdlcyk7XG4gICAgcmV0dXJuIGNvbm5lY3Rpb24uc2lnbmFscztcbiAgfVxuICBjb21wbGV0ZUNvbm5lY3Rpb24oc2lnbmFsTWVzc2FnZXMpIHsgLy8gRmluaXNoIHdoYXQgd2FzIHN0YXJ0ZWQgd2l0aCBzdGFydENvbGxlY3Rpb24uXG4gICAgLy8gRG9lcyBub3QgcmV0dXJuIGEgcHJvbWlzZS4gQ2xpZW50IGNhbiBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSB0byBzZWUgd2hlbiB3ZSBhcmUgYWN0dWFsbHkgY29ubmVjdGVkLlxuICAgIGlmICghc2lnbmFsTWVzc2FnZXMpIHJldHVybiBmYWxzZTtcbiAgICB0aGlzLmNvbm5lY3Rpb24uc2lnbmFscyA9IHNpZ25hbE1lc3NhZ2VzO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgc3RhdGljIGZldGNoSlNPTih1cmwsIGJvZHkgPSB1bmRlZmluZWQsIG1ldGhvZCA9IG51bGwpIHtcbiAgICBjb25zdCBoYXNCb2R5ID0gYm9keSAhPT0gdW5kZWZpbmVkO1xuICAgIG1ldGhvZCA/Pz0gaGFzQm9keSA/ICdQT1NUJyA6ICdHRVQnO1xuICAgIHJldHVybiBmZXRjaCh1cmwsIGhhc0JvZHkgPyB7bWV0aG9kLCBoZWFkZXJzOiB7XCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCJ9LCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KX0gOiB7bWV0aG9kfSlcbiAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcblx0aWYgKCFyZXNwb25zZS5vaykgdGhyb3cgbmV3IEVycm9yKGAke3Jlc3BvbnNlLnN0YXR1c1RleHQgfHwgJ0ZldGNoIGZhaWxlZCd9LCBjb2RlICR7cmVzcG9uc2Uuc3RhdHVzfSBpbiAke3VybH0uYCk7XG5cdHJldHVybiByZXNwb25zZS5qc29uKCk7XG4gICAgICB9KTtcbiAgfVxuICBhc3luYyBmZXRjaCh1cmwsIGJvZHkgPSB1bmRlZmluZWQpIHsgLy8gQXMgSlNPTlxuXG4gICAgY29uc3QgbWV0aG9kID0gYm9keSA/ICdQT1NUJyA6ICdHRVQnO1xuICAgIHRoaXMubG9nKCdmZXRjaCcsIG1ldGhvZCwgdXJsLCAnc2VuZGluZzonLCBib2R5KTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLmZldGNoSlNPTih1cmwsIGJvZHksIG1ldGhvZClcblx0ICAuY2F0Y2goZXJyb3IgPT4ge1xuXHQgICAgdGhpcy5jbG9zZWQucmVqZWN0KGVycm9yKTtcblx0ICB9KTtcbiAgICB0aGlzLmxvZygnZmV0Y2gnLCBtZXRob2QsIHVybCwgJ3Jlc3VsdDonLCByZXN1bHQpO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbiAgYXN5bmMgY29ubmVjdFNlcnZlcih1cmwgPSB0aGlzLmNvbm5lY3Rpb25VUkwpIHsgLy8gQ29ubmVjdCB0byBhIHJlbGF5IG92ZXIgaHR0cC4gKC9zeW5jIG9yIC9zaWduYWwvYW5zd2VyKVxuICAgIC8vIHN0YXJ0Q29ubmVjdGlvbiwgUE9TVCBvdXIgc2lnbmFscywgY29tcGxldGVDb25uZWN0aW9uIHdpdGggdGhlIHJlc3BvbnNlLlxuICAgIC8vIE91ciB3ZWJydGMgc3luY2hyb25pemVyIGlzIHRoZW4gY29ubmVjdGVkIHRvIHRoZSByZWxheSdzIHdlYnJ0IHN5bmNocm9uaXplci5cbiAgICBjb25zdCBvdXJTaWduYWxzUHJvbWlzZSA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7IC8vIG11c3QgYmUgc3luY2hyb25vdXMgdG8gcHJlc2VydmUgY2hhbm5lbCBpZCBvcmRlci5cbiAgICBjb25zdCBvdXJTaWduYWxzID0gYXdhaXQgb3VyU2lnbmFsc1Byb21pc2U7XG4gICAgY29uc3QgdGhlaXJTaWduYWxzID0gYXdhaXQgdGhpcy5mZXRjaCh1cmwsIG91clNpZ25hbHMpOyAvLyBQT1NUXG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVDb25uZWN0aW9uKHRoZWlyU2lnbmFscyk7XG4gIH1cbiAgYXN5bmMgY29tcGxldGVTaWduYWxzU3luY2hyb25pemF0aW9uKHNpZ25hbHMpIHsgLy8gR2l2ZW4gYW5zd2VyL2ljZSBzaWduYWxzLCBjb21wbGV0ZSB0aGUgY29ubmVjdGlvbiBhbmQgc3RhcnQgc3luY2hyb25pemUuXG4gICAgYXdhaXQgdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24oc2lnbmFscyk7XG4gICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZSgpO1xuICB9XG4gIGFzeW5jIGNvbm5lY3REaXJlY3RUZXN0aW5nKHBlZXJDb2xsZWN0aW9uKSB7IC8vIFVzZWQgaW4gdW5pdCB0ZXN0aW5nLCB3aGVyZSB0aGUgXCJyZW1vdGVcIiBzZXJ2aWNlIGlzIHNwZWNpZmllZCBkaXJlY3RseSAobm90IGEgc3RyaW5nKS5cbiAgICAvLyBFYWNoIGNvbGxlY3Rpb24gaXMgYXNrZWQgdG8gc3ljaHJvbml6ZSB0byBhbm90aGVyIGNvbGxlY3Rpb24uXG4gICAgY29uc3QgcGVlclN5bmNocm9uaXplciA9IHBlZXJDb2xsZWN0aW9uLnN5bmNocm9uaXplcnMuZ2V0KHRoaXMuY29sbGVjdGlvbik7XG4gICAgaWYgKCFwZWVyU3luY2hyb25pemVyKSB7IC8vIFRoZSBvdGhlciBzaWRlIGRvZXNuJ3Qga25vdyBhYm91dCB1cyB5ZXQuIFRoZSBvdGhlciBzaWRlIHdpbGwgZG8gdGhlIHdvcmsuXG4gICAgICB0aGlzLl9kZWxheSA9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSgpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCBvdXJTaWduYWxzID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTtcbiAgICBjb25zdCB0aGVpclNpZ25hbHMgPSBhd2FpdCBwZWVyU3luY2hyb25pemVyLnN0YXJ0Q29ubmVjdGlvbihhd2FpdCBvdXJTaWduYWxzKTtcbiAgICBwZWVyU3luY2hyb25pemVyLl9kZWxheS5yZXNvbHZlKCk7XG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVDb25uZWN0aW9uKHRoZWlyU2lnbmFscyk7XG4gIH1cblxuICAvLyBBIGNvbW1vbiBwcmFjdGljZSBoZXJlIGlzIHRvIGhhdmUgYSBwcm9wZXJ0eSB0aGF0IGlzIGEgcHJvbWlzZSBmb3IgaGF2aW5nIHNvbWV0aGluZyBkb25lLlxuICAvLyBBc3luY2hyb25vdXMgbWFjaGluZXJ5IGNhbiB0aGVuIHJlc29sdmUgaXQuXG4gIC8vIEFueXRoaW5nIHRoYXQgZGVwZW5kcyBvbiB0aGF0IGNhbiBhd2FpdCB0aGUgcmVzb2x2ZWQgdmFsdWUsIHdpdGhvdXQgd29ycnlpbmcgYWJvdXQgaG93IGl0IGdldHMgcmVzb2x2ZWQuXG4gIC8vIFdlIGNhY2hlIHRoZSBwcm9taXNlIHNvIHRoYXQgd2UgZG8gbm90IHJlcGV0ZWRseSB0cmlnZ2VyIHRoZSB1bmRlcmx5aW5nIGFjdGlvbi5cbiAgbWFrZVJlc29sdmVhYmxlUHJvbWlzZShpZ25vcmVkKSB7IC8vIEFuc3dlciBhIFByb21pc2UgdGhhdCBjYW4gYmUgcmVzb2x2ZSB3aXRoIHRoZVByb21pc2UucmVzb2x2ZSh2YWx1ZSkuXG4gICAgLy8gVGhlIGlnbm9yZWQgYXJndW1lbnQgaXMgYSBjb252ZW5pZW50IHBsYWNlIHRvIGNhbGwgc29tZXRoaW5nIGZvciBzaWRlLWVmZmVjdC5cbiAgICBsZXQgcmVzb2x2ZXIsIHJlamVjdGVyO1xuICAgIGNvbnN0IHByb21pc2UgPSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7IHJlc29sdmVyID0gcmVzb2x2ZTsgcmVqZWN0ZXIgPSByZWplY3Q7IH0pO1xuICAgIHByb21pc2UucmVzb2x2ZSA9IHJlc29sdmVyO1xuICAgIHByb21pc2UucmVqZWN0ID0gcmVqZWN0ZXI7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cblxuICBhc3luYyB2ZXJzaW9ucyhtaW4sIG1heCkgeyAvLyBPbiByZWNlaXZpbmcgdGhlIHZlcnNpb25zIHN1cHBvcnRlZCBieSB0aGUgdGhlIHBlZXIsIHJlc29sdmUgdGhlIHZlcnNpb24gcHJvbWlzZS5cbiAgICBsZXQgdmVyc2lvblByb21pc2UgPSB0aGlzLnZlcnNpb247XG4gICAgY29uc3QgY29tYmluZWRNYXggPSBNYXRoLm1pbihtYXgsIHRoaXMubWF4VmVyc2lvbik7XG4gICAgY29uc3QgY29tYmluZWRNaW4gPSBNYXRoLm1heChtaW4sIHRoaXMubWluVmVyc2lvbik7XG4gICAgaWYgKGNvbWJpbmVkTWF4ID49IGNvbWJpbmVkTWluKSByZXR1cm4gdmVyc2lvblByb21pc2UucmVzb2x2ZShjb21iaW5lZE1heCk7IC8vIE5vIG5lZWQgdG8gcmVzcG9uZCwgYXMgdGhleSB3aWxsIHByb2R1Y2UgdGhlIHNhbWUgZGV0ZXJtaW5pc3RpYyBhbnN3ZXIuXG4gICAgcmV0dXJuIHZlcnNpb25Qcm9taXNlLnJlc29sdmUoMCk7XG4gIH1cbiAgZ2V0IHZlcnNpb24oKSB7IC8vIFByb21pc2UgdGhlIGhpZ2hlc3QgdmVyc2lvbiBzdXBvcnRlZCBieSBib3RoIHNpZGVzLCBvciBkaXNjb25uZWN0IGFuZCBmYWxzeSBpZiBub25lLlxuICAgIC8vIFRlbGxzIHRoZSBvdGhlciBzaWRlIG91ciB2ZXJzaW9ucyBpZiB3ZSBoYXZlbid0IHlldCBkb25lIHNvLlxuICAgIC8vIEZJWE1FOiBjYW4gd2UgYXZvaWQgdGhpcyB0aW1lb3V0P1xuICAgIHJldHVybiB0aGlzLl92ZXJzaW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2Uoc2V0VGltZW91dCgoKSA9PiB0aGlzLnNlbmQoJ3ZlcnNpb25zJywgdGhpcy5taW5WZXJzaW9uLCB0aGlzLm1heFZlcnNpb24pLCAyMDApKTtcbiAgfVxuXG4gIGdldCBzdGFydGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiB3ZSBoYXZlIHN0YXJ0ZWQgc3luY2hyb25pemF0aW9uLlxuICAgIHJldHVybiB0aGlzLl9zdGFydGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLnN0YXJ0U3luY2hyb25pemF0aW9uKCk7XG4gIH1cbiAgZ2V0IGNvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBudW1iZXIgb2YgaXRlbXMgdGhhdCB3ZXJlIHRyYW5zZmVycmVkIChub3QgbmVjZXNzYXJpbGx5IHdyaXR0ZW4pLlxuICAgIC8vIFN0YXJ0cyBzeW5jaHJvbml6YXRpb24gaWYgaXQgaGFzbid0IGFscmVhZHkuIEUuZy4sIHdhaXRpbmcgb24gY29tcGxldGVkU3luY2hyb25pemF0aW9uIHdvbid0IHJlc29sdmUgdW50aWwgYWZ0ZXIgaXQgc3RhcnRzLlxuICAgIHJldHVybiB0aGlzLl9jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZSh0aGlzLnN0YXJ0ZWRTeW5jaHJvbml6YXRpb24pO1xuICB9XG4gIGdldCBwZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG51bWJlciBvZiBpdGVtcyB0aGF0IHRoZSBwZWVyIHN5bmNocm9uaXplZC5cbiAgICByZXR1cm4gdGhpcy5fcGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCk7XG4gIH1cbiAgZ2V0IGJvdGhTaWRlc0NvbXBsZXRlZFN5bmNocm9uaXphdGlvbigpIHsgLy8gUHJvbWlzZSByZXNvbHZlcyB0cnV0aHkgd2hlbiBib3RoIHNpZGVzIGFyZSBkb25lLlxuICAgIHJldHVybiB0aGlzLmNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi50aGVuKCgpID0+IHRoaXMucGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbik7XG4gIH1cbiAgYXN5bmMgcmVwb3J0Q29ubmVjdGlvbigpIHsgLy8gTG9nIGNvbm5lY3Rpb24gdGltZSBhbmQgdHlwZS5cbiAgICBjb25zdCBzdGF0cyA9IGF3YWl0IHRoaXMuY29ubmVjdGlvbi5wZWVyLmdldFN0YXRzKCk7XG4gICAgbGV0IHRyYW5zcG9ydDtcbiAgICBmb3IgKGNvbnN0IHJlcG9ydCBvZiBzdGF0cy52YWx1ZXMoKSkge1xuICAgICAgaWYgKHJlcG9ydC50eXBlID09PSAndHJhbnNwb3J0Jykge1xuXHR0cmFuc3BvcnQgPSByZXBvcnQ7XG5cdGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBsZXQgY2FuZGlkYXRlUGFpciA9IHRyYW5zcG9ydCAmJiBzdGF0cy5nZXQodHJhbnNwb3J0LnNlbGVjdGVkQ2FuZGlkYXRlUGFpcklkKTtcbiAgICBpZiAoIWNhbmRpZGF0ZVBhaXIpIHsgLy8gU2FmYXJpIGRvZXNuJ3QgZm9sbG93IHRoZSBzdGFuZGFyZC5cbiAgICAgIGZvciAoY29uc3QgcmVwb3J0IG9mIHN0YXRzLnZhbHVlcygpKSB7XG5cdGlmICgocmVwb3J0LnR5cGUgPT09ICdjYW5kaWRhdGUtcGFpcicpICYmIHJlcG9ydC5zZWxlY3RlZCkge1xuXHQgIGNhbmRpZGF0ZVBhaXIgPSByZXBvcnQ7XG5cdCAgYnJlYWs7XG5cdH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFjYW5kaWRhdGVQYWlyKSB7XG4gICAgICBjb25zb2xlLndhcm4odGhpcy5sYWJlbCwgJ2dvdCBzdGF0cyB3aXRob3V0IGNhbmRpZGF0ZVBhaXInLCBBcnJheS5mcm9tKHN0YXRzLnZhbHVlcygpKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlbW90ZSA9IHN0YXRzLmdldChjYW5kaWRhdGVQYWlyLnJlbW90ZUNhbmRpZGF0ZUlkKTtcbiAgICBjb25zdCB7cHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGV9ID0gcmVtb3RlO1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7c3RhdHMsIHRyYW5zcG9ydCwgY2FuZGlkYXRlUGFpciwgcmVtb3RlLCBwcm90b2NvbCwgY2FuZGlkYXRlVHlwZSwgc3luY2hyb25pemF0aW9uU3RhcnRUaW1lOiBub3d9KTtcbiAgICBjb25zb2xlLmluZm8odGhpcy5sYWJlbCwgJ2Nvbm5lY3RlZCcsIHByb3RvY29sLCBjYW5kaWRhdGVUeXBlLCAoKG5vdyAtIHRoaXMuY29ubmVjdGlvblN0YXJ0VGltZSkvMWUzKS50b0ZpeGVkKDEpKTtcbiAgfVxuICBhc3luYyBzdGFydFN5bmNocm9uaXphdGlvbigpIHsgLy8gV2FpdCBmb3IgYWxsIHByZWxpbWluYXJpZXMsIGFuZCBzdGFydCBzdHJlYW1pbmcgb3VyIHRhZ3MuXG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBpZiAoIWRhdGFDaGFubmVsKSB0aHJvdyBuZXcgRXJyb3IoYE5vIGNvbm5lY3Rpb24gZm9yICR7dGhpcy5sYWJlbH0uYCk7XG4gICAgLy8gTm93IHRoYXQgd2UgYXJlIGNvbm5lY3RlZCwgYW55IG5ldyB3cml0ZXMgb24gb3VyIGVuZCB3aWxsIGJlIHB1c2hlZCB0byB0aGUgcGVlci4gU28gY2FwdHVyZSB0aGUgaW5pdGlhbCB0YWdzIG5vdy5cbiAgICBjb25zdCBvdXJUYWdzID0gbmV3IFNldChhd2FpdCB0aGlzLmNvbGxlY3Rpb24udGFncyk7XG4gICAgYXdhaXQgdGhpcy5yZXBvcnRDb25uZWN0aW9uKCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7XG5cbiAgICAgIC8vIEEgc25hcHNob3QgU2V0IG9mIGVhY2ggdGFnIHdlIGhhdmUgbG9jYWxseSwgY2FwdHVyZWQgYXQgdGhlIG1vbWVudCBvZiBjcmVhdGlvbi5cbiAgICAgIG91clRhZ3MsIC8vIChOZXcgbG9jYWwgd3JpdGVzIGFyZSBwdXNoZWQgdG8gdGhlIGNvbm5lY3RlZCBwZWVyLCBldmVuIGR1cmluZyBzeW5jaHJvbml6YXRpb24uKVxuXG4gICAgICAvLyBNYXAgb2YgdGFnIHRvIHByb21pc2UgZm9yIHRhZ3MgdGhhdCBhcmUgYmVpbmcgc3luY2hyb25pemVkLlxuICAgICAgLy8gZW5zdXJlU3luY2hyb25pemVkVGFnIGVuc3VyZXMgdGhhdCB0aGVyZSBpcyBhbiBlbnRyeSBoZXJlIGR1cmluZyB0aGUgdGltZSBhIHRhZyBpcyBpbiBmbGlnaHQuXG4gICAgICB1bnN5bmNocm9uaXplZDogbmV3IE1hcCgpLFxuXG4gICAgICAvLyBTZXQgb2Ygd2hhdCB0YWdzIGhhdmUgYmVlbiBleHBsaWNpdGx5IHN5bmNocm9uaXplZCwgbWVhbmluZyB0aGF0IHRoZXJlIGlzIGEgZGlmZmVyZW5jZSBiZXR3ZWVuIHRoZWlyIGhhc2hcbiAgICAgIC8vIGFuZCBvdXJzLCBzdWNoIHRoYXQgd2UgYXNrIGZvciB0aGVpciBzaWduYXR1cmUgdG8gY29tcGFyZSBpbiBkZXRhaWwuIFRodXMgdGhpcyBzZXQgbWF5IGluY2x1ZGUgaXRlbXMgdGhhdFxuICAgICAgY2hlY2tlZFRhZ3M6IG5ldyBTZXQoKSwgLy8gd2lsbCBub3QgZW5kIHVwIGJlaW5nIHJlcGxhY2VkIG9uIG91ciBlbmQuXG5cbiAgICAgIGVuZE9mUGVlclRhZ3M6IGZhbHNlIC8vIElzIHRoZSBwZWVyIGZpbmlzaGVkIHN0cmVhbWluZz9cbiAgICB9KTtcbiAgICAvLyBOb3cgbmVnb3RpYXRlIHZlcnNpb24gYW5kIGNvbGxlY3RzIHRoZSB0YWdzLlxuICAgIGNvbnN0IHZlcnNpb24gPSBhd2FpdCB0aGlzLnZlcnNpb247XG4gICAgaWYgKCF2ZXJzaW9uKSB7ICAvLyBNaXNtYXRjaC5cbiAgICAgIC8vIEtsdWRnZSAxOiB3aHkgZG9lc24ndCB0aGlzLmRpc2Nvbm5lY3QoKSBjbGVhbiB1cCB0aGUgdmFyaW91cyBwcm9taXNlcyBwcm9wZXJseT9cbiAgICAgIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlLnRoZW4oY2hhbm5lbCA9PiBjaGFubmVsLmNsb3NlKCkpO1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGAke3RoaXMuc2VydmljZU5hbWV9IGRvZXMgbm90IHVzZSBhIGNvbXBhdGlibGUgdmVyc2lvbi5gO1xuICAgICAgY29uc29sZS5lcnJvcihtZXNzYWdlLCB0aGlzLmNvbm5lY3Rpb24ubm90aWZpZWQpO1xuICAgICAgaWYgKCh0eXBlb2Yod2luZG93KSAhPT0gJ3VuZGVmaW5lZCcpICYmICF0aGlzLmNvbm5lY3Rpb24ubm90aWZpZWQpIHsgLy8gSWYgd2UncmUgaW4gYSBicm93c2VyLCB0ZWxsIHRoZSB1c2VyIG9uY2UuXG5cdHRoaXMuY29ubmVjdGlvbi5ub3RpZmllZCA9IHRydWU7XG5cdHdpbmRvdy5hbGVydChtZXNzYWdlKTtcblx0c2V0VGltZW91dCgoKSA9PiBkZWxldGUgdGhpcy5jb25uZWN0aW9uLm5vdGlmaWVkLCAxMCk7IC8vIEtsdWRnZSAyLlxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbVRhZ3Mob3VyVGFncyk7IC8vIEJ1dCBkbyBub3Qgd2FpdCBmb3IgaXQuXG4gIH1cbiAgYXN5bmMgY29tcHV0ZUhhc2godGV4dCkgeyAvLyBPdXIgc3RhbmRhcmQgaGFzaC4gKFN0cmluZyBzbyB0aGF0IGl0IGlzIHNlcmlhbGl6YWJsZS4pXG4gICAgY29uc3QgaGFzaCA9IGF3YWl0IENyZWRlbnRpYWxzLmhhc2hUZXh0KHRleHQpO1xuICAgIHJldHVybiBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoaGFzaCk7XG4gIH1cbiAgYXN5bmMgZ2V0SGFzaCh0YWcpIHsgLy8gV2hvbGUgc2lnbmF0dXJlIChOT1QgcHJvdGVjdGVkSGVhZGVyLnN1YiBvZiBjb250ZW50KS5cbiAgICBjb25zdCByYXcgPSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gICAgcmV0dXJuIHRoaXMuY29tcHV0ZUhhc2gocmF3IHx8ICdtaXNzaW5nJyk7XG4gIH1cbiAgYXN5bmMgc3RyZWFtVGFncyh0YWdzKSB7IC8vIFNlbmQgZWFjaCBvZiBvdXIga25vd24gdGFnL2hhc2ggcGFpcnMgdG8gcGVlciwgb25lIGF0IGEgdGltZSwgZm9sbG93ZWQgYnkgZW5kT2ZUYWdzLlxuICAgIGZvciAoY29uc3QgdGFnIG9mIHRhZ3MpIHtcbiAgICAgIHRoaXMuc2VuZCgnaGFzaCcsIHRhZywgYXdhaXQgdGhpcy5nZXRIYXNoKHRhZykpO1xuICAgIH1cbiAgICB0aGlzLnNlbmQoJ2VuZFRhZ3MnKTtcbiAgfVxuICBhc3luYyBlbmRUYWdzKCkgeyAvLyBUaGUgcGVlciBoYXMgZmluaXNoZWQgc3RyZWFtVGFncygpLlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICB0aGlzLmVuZE9mUGVlclRhZ3MgPSB0cnVlO1xuICAgIHRoaXMuY2xlYW5VcElmRmluaXNoZWQoKTtcbiAgfVxuICBzeW5jaHJvbml6YXRpb25Db21wbGV0ZShuQ2hlY2tlZCkgeyAvLyBUaGUgcGVlciBoYXMgZmluaXNoZWQgZ2V0dGluZyBhbGwgdGhlIGRhdGEgaXQgbmVlZHMgZnJvbSB1cy5cbiAgICB0aGlzLnBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24ucmVzb2x2ZShuQ2hlY2tlZCk7XG4gIH1cbiAgY2xlYW5VcElmRmluaXNoZWQoKSB7IC8vIElmIHdlIGFyZSBub3Qgd2FpdGluZyBmb3IgYW55dGhpbmcsIHdlJ3JlIGRvbmUuIENsZWFuIHVwLlxuICAgIC8vIFRoaXMgcmVxdWlyZXMgdGhhdCB0aGUgcGVlciBoYXMgaW5kaWNhdGVkIHRoYXQgaXQgaXMgZmluaXNoZWQgc3RyZWFtaW5nIHRhZ3MsXG4gICAgLy8gYW5kIHRoYXQgd2UgYXJlIG5vdCB3YWl0aW5nIGZvciBhbnkgZnVydGhlciB1bnN5bmNocm9uaXplZCBpdGVtcy5cbiAgICBpZiAoIXRoaXMuZW5kT2ZQZWVyVGFncyB8fCB0aGlzLnVuc3luY2hyb25pemVkLnNpemUpIHJldHVybjtcbiAgICBjb25zdCBuQ2hlY2tlZCA9IHRoaXMuY2hlY2tlZFRhZ3Muc2l6ZTsgLy8gVGhlIG51bWJlciB0aGF0IHdlIGNoZWNrZWQuXG4gICAgdGhpcy5zZW5kKCdzeW5jaHJvbml6YXRpb25Db21wbGV0ZScsIG5DaGVja2VkKTtcbiAgICB0aGlzLmNoZWNrZWRUYWdzLmNsZWFyKCk7XG4gICAgdGhpcy51bnN5bmNocm9uaXplZC5jbGVhcigpO1xuICAgIHRoaXMub3VyVGFncyA9IHRoaXMuc3luY2hyb25pemVkID0gdGhpcy51bnN5bmNocm9uaXplZCA9IG51bGw7XG4gICAgY29uc29sZS5pbmZvKHRoaXMubGFiZWwsICdjb21wbGV0ZWQgc3luY2hyb25pemF0aW9uJywgbkNoZWNrZWQsICdpdGVtcyBpbicsICgoRGF0ZS5ub3coKSAtIHRoaXMuc3luY2hyb25pemF0aW9uU3RhcnRUaW1lKS8xZTMpLnRvRml4ZWQoMSksICdzZWNvbmRzJyk7XG4gICAgdGhpcy5jb21wbGV0ZWRTeW5jaHJvbml6YXRpb24ucmVzb2x2ZShuQ2hlY2tlZCk7XG4gIH1cbiAgc3luY2hyb25pemF0aW9uUHJvbWlzZSh0YWcpIHsgLy8gUmV0dXJuIHNvbWV0aGluZyB0byBhd2FpdCB0aGF0IHJlc29sdmVzIHdoZW4gdGFnIGlzIHN5bmNocm9uaXplZC5cbiAgICAvLyBXaGVuZXZlciBhIGNvbGxlY3Rpb24gbmVlZHMgdG8gcmV0cmlldmUgKGdldFZlcmlmaWVkKSBhIHRhZyBvciBmaW5kIHRhZ3MgbWF0Y2hpbmcgcHJvcGVydGllcywgaXQgZW5zdXJlc1xuICAgIC8vIHRoZSBsYXRlc3QgZGF0YSBieSBjYWxsaW5nIHRoaXMgYW5kIGF3YWl0aW5nIHRoZSBkYXRhLlxuICAgIGlmICghdGhpcy51bnN5bmNocm9uaXplZCkgcmV0dXJuIHRydWU7IC8vIFdlIGFyZSBmdWxseSBzeW5jaHJvbml6ZWQgYWxsIHRhZ3MuIElmIHRoZXJlIGlzIG5ldyBkYXRhLCBpdCB3aWxsIGJlIHNwb250YW5lb3VzbHkgcHVzaGVkIHRvIHVzLlxuICAgIGlmICh0aGlzLmNoZWNrZWRUYWdzLmhhcyh0YWcpKSByZXR1cm4gdHJ1ZTsgLy8gVGhpcyBwYXJ0aWN1bGFyIHRhZyBoYXMgYmVlbiBjaGVja2VkLlxuICAgICAgLy8gKElmIGNoZWNrZWRUYWdzIHdhcyBvbmx5IHRob3NlIGV4Y2hhbmdlZCBvciB3cml0dGVuLCB3ZSB3b3VsZCBoYXZlIGV4dHJhIGZsaWdodHMgY2hlY2tpbmcuKVxuICAgIC8vIElmIGEgcmVxdWVzdCBpcyBpbiBmbGlnaHQsIHJldHVybiB0aGF0IHByb21pc2UuIE90aGVyd2lzZSBjcmVhdGUgb25lLlxuICAgIHJldHVybiB0aGlzLnVuc3luY2hyb25pemVkLmdldCh0YWcpIHx8IHRoaXMuZW5zdXJlU3luY2hyb25pemVkVGFnKHRhZywgJycsIHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgfVxuXG4gIGFzeW5jIGhhc2godGFnLCBoYXNoKSB7IC8vIFJlY2VpdmUgYSBbdGFnLCBoYXNoXSB0aGF0IHRoZSBwZWVyIGtub3dzIGFib3V0LiAoUGVlciBzdHJlYW1zIHplcm8gb3IgbW9yZSBvZiB0aGVzZSB0byB1cy4pXG4gICAgLy8gVW5sZXNzIGFscmVhZHkgaW4gZmxpZ2h0LCB3ZSB3aWxsIGVuc3VyZVN5bmNocm9uaXplZFRhZyB0byBzeW5jaHJvbml6ZSBpdC5cbiAgICBhd2FpdCB0aGlzLnN0YXJ0ZWRTeW5jaHJvbml6YXRpb247XG4gICAgY29uc3Qge291clRhZ3MsIHVuc3luY2hyb25pemVkfSA9IHRoaXM7XG4gICAgdGhpcy5sb2coJ3JlY2VpdmVkIFwiaGFzaFwiJywge3RhZywgaGFzaCwgb3VyVGFncywgdW5zeW5jaHJvbml6ZWR9KTtcbiAgICBpZiAodW5zeW5jaHJvbml6ZWQuaGFzKHRhZykpIHJldHVybiBudWxsOyAvLyBBbHJlYWR5IGhhcyBhbiBpbnZlc3RpZ2F0aW9uIGluIHByb2dyZXNzIChlLmcsIGR1ZSB0byBsb2NhbCBhcHAgc3luY2hyb25pemF0aW9uUHJvbWlzZSkuXG4gICAgaWYgKCFvdXJUYWdzLmhhcyh0YWcpKSByZXR1cm4gdGhpcy5lbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCBoYXNoKTsgLy8gV2UgZG9uJ3QgaGF2ZSB0aGUgcmVjb3JkIGF0IGFsbC5cbiAgICByZXR1cm4gdGhpcy5lbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCBoYXNoLCB0aGlzLmdldEhhc2godGFnKSk7XG4gIH1cbiAgZW5zdXJlU3luY2hyb25pemVkVGFnKHRhZywgdGhlaXJIYXNoID0gJycsIG91ckhhc2hQcm9taXNlID0gbnVsbCkge1xuICAgIC8vIFN5bmNocm9ub3VzbHkgcmVjb3JkIChpbiB0aGUgdW5zeW5jaHJvbml6ZWQgbWFwKSBhIHByb21pc2UgdG8gKGNvbmNlcHR1YWxseSkgcmVxdWVzdCB0aGUgdGFnIGZyb20gdGhlIHBlZXIsXG4gICAgLy8gcHV0IGl0IGluIHRoZSBjb2xsZWN0aW9uLCBhbmQgY2xlYW51cCB0aGUgYm9va2tlZXBpbmcuIFJldHVybiB0aGF0IHByb21pc2UuXG4gICAgLy8gSG93ZXZlciwgaWYgd2UgYXJlIGdpdmVuIGhhc2hlcyB0byBjb21wYXJlIGFuZCB0aGV5IG1hdGNoLCB3ZSBjYW4gc2tpcCB0aGUgcmVxdWVzdC9wdXQgYW5kIHJlbW92ZSBmcm9tIHVuc3ljaHJvbml6ZWQgb24gbmV4dCB0aWNrLlxuICAgIC8vIChUaGlzIG11c3QgcmV0dXJuIGF0b21pY2FsbHkgYmVjYXVzZSBjYWxsZXIgaGFzIGNoZWNrZWQgdmFyaW91cyBib29ra2VlcGluZyBhdCB0aGF0IG1vbWVudC4gQ2hlY2tpbmcgbWF5IHJlcXVpcmUgdGhhdCB3ZSBhd2FpdCBvdXJIYXNoUHJvbWlzZS4pXG4gICAgY29uc3QgcHJvbWlzZSA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgc2V0VGltZW91dChhc3luYyAoKSA9PiB7IC8vIE5leHQgdGljay4gU2VlIHJlcXVlc3QoKS5cblx0aWYgKCF0aGVpckhhc2ggfHwgIW91ckhhc2hQcm9taXNlIHx8ICh0aGVpckhhc2ggIT09IGF3YWl0IG91ckhhc2hQcm9taXNlKSkge1xuXHQgIGNvbnN0IHRoZWlyRGF0YSA9IGF3YWl0IHRoaXMucmVxdWVzdCh0YWcpO1xuXHQgIC8vIE1pZ2h0IGhhdmUgYmVlbiB0cmlnZ2VyZWQgYnkgb3VyIGFwcCByZXF1ZXN0aW5nIHRoaXMgdGFnIGJlZm9yZSB3ZSB3ZXJlIHN5bmMnZC4gU28gdGhleSBtaWdodCBub3QgaGF2ZSB0aGUgZGF0YS5cblx0ICBpZiAoIXRoZWlySGFzaCB8fCB0aGVpckRhdGE/Lmxlbmd0aCkge1xuXHQgICAgaWYgKGF3YWl0IHRoaXMuY29sbGVjdGlvbi5wdXQodGFnLCB0aGVpckRhdGEsIHRoaXMpKSB7XG5cdCAgICAgIHRoaXMubG9nKCdyZWNlaXZlZC9wdXQnLCB0YWcsICd0aGVpci9vdXIgaGFzaDonLCB0aGVpckhhc2ggfHwgJ21pc3NpbmdUaGVpcnMnLCAoYXdhaXQgb3VySGFzaFByb21pc2UpIHx8ICdtaXNzaW5nT3VycycsIHRoZWlyRGF0YT8ubGVuZ3RoKTtcblx0ICAgIH0gZWxzZSB7XG5cdCAgICAgIHRoaXMubG9nKCd1bmFibGUgdG8gcHV0JywgdGFnKTtcblx0ICAgIH1cblx0ICB9XG5cdH1cblx0dGhpcy5jaGVja2VkVGFncy5hZGQodGFnKTsgICAgICAgLy8gRXZlcnl0aGluZyB3ZSd2ZSBleGFtaW5lZCwgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIHdlIGFza2VkIGZvciBvciBzYXZlZCBkYXRhIGZyb20gcGVlci4gKFNlZSBzeW5jaHJvbml6YXRpb25Qcm9taXNlKVxuXHR0aGlzLnVuc3luY2hyb25pemVkLmRlbGV0ZSh0YWcpOyAvLyBVbmNvbmRpdGlvbmFsbHksIGJlY2F1c2Ugd2Ugc2V0IGl0IHVuY29uZGl0aW9uYWxseS5cblx0dGhpcy5jbGVhblVwSWZGaW5pc2hlZCgpO1xuXHRyZXNvbHZlKCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICB0aGlzLnVuc3luY2hyb25pemVkLnNldCh0YWcsIHByb21pc2UpOyAvLyBVbmNvbmRpdGlvbmFsbHksIGluIGNhc2Ugd2UgbmVlZCB0byBrbm93IHdlJ3JlIGxvb2tpbmcgZHVyaW5nIHRoZSB0aW1lIHdlJ3JlIGxvb2tpbmcuXG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cbiAgcmVxdWVzdCh0YWcpIHsgLy8gTWFrZSBhIHJlcXVlc3QgZm9yIHRhZyBmcm9tIHRoZSBwZWVyLCBhbmQgYW5zd2VyIGEgcHJvbWlzZSB0aGUgcmVzb2x2ZXMgd2l0aCB0aGUgZGF0YS5cbiAgICAvKmNvbnN0IHsgaG9zdFJlcXVlc3RCYXNlIH0gPSB0aGlzO1xuICAgIGlmIChob3N0UmVxdWVzdEJhc2UpIHtcbiAgICAgIC8vIEUuZy4sIGEgbG9jYWxob3N0IHJvdXRlciBtaWdodCBzdXBwb3J0IGEgZ2V0IG9mIGh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvTXV0YWJsZUNvbGxlY3Rpb24vY29tLmtpMXIweS53aGF0ZXZlci9fdC91TC9CQWNXX0xOQUphL2NKV211bWJsZVxuICAgICAgLy8gU28gaG9zdFJlcXVlc3RCYXNlIHNob3VsZCBiZSBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvTXV0YWJsZUNvbGxlY3Rpb24vY29tLmtpMXIweS53aGF0ZXZlclwiLFxuICAgICAgLy8gYW5kIHNlcnZpY2VOYW1lIHNob3VsZCBiZSBzb21ldGhpbmcgbGlrZSBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9mbGV4c3RvcmUvc3luY1wiXG4gICAgICByZXR1cm4gZmV0Y2godGFnUGF0aChob3N0UmVxdWVzdEJhc2UsIHRhZykpLnRoZW4ocmVzcG9uc2UgPT4gcmVzcG9uc2UudGV4dCgpKTtcbiAgICB9Ki9cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHRoaXMuc2VuZCgnZ2V0JywgdGFnKSk7XG4gICAgLy8gU3VidGxlOiBXaGVuIHRoZSAncHV0JyBjb21lcyBiYWNrLCB3ZSB3aWxsIG5lZWQgdG8gcmVzb2x2ZSB0aGlzIHByb21pc2UuIEJ1dCBob3cgd2lsbCAncHV0JyBmaW5kIHRoZSBwcm9taXNlIHRvIHJlc29sdmUgaXQ/XG4gICAgLy8gQXMgaXQgdHVybnMgb3V0LCB0byBnZXQgaGVyZSwgd2UgaGF2ZSBuZWNlc3NhcmlsbHkgc2V0IHRhZyBpbiB0aGUgdW5zeW5jaHJvbml6ZWQgbWFwLiBcbiAgICBjb25zdCBub3RlZCA9IHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZyk7IC8vIEEgcHJvbWlzZSB0aGF0IGRvZXMgbm90IGhhdmUgYW4gZXhwb3NlZCAucmVzb2x2ZSwgYW5kIHdoaWNoIGRvZXMgbm90IGV4cGVjdCBhbnkgdmFsdWUuXG4gICAgbm90ZWQucmVzb2x2ZSA9IHByb21pc2UucmVzb2x2ZTsgLy8gVGFjayBvbiBhIHJlc29sdmUgZm9yIE9VUiBwcm9taXNlIG9udG8gdGhlIG5vdGVkIG9iamVjdCAod2hpY2ggY29uZnVzaW5nbHksIGhhcHBlbnMgdG8gYmUgYSBwcm9taXNlKS5cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICBhc3luYyBnZXQodGFnKSB7IC8vIFJlc3BvbmQgdG8gYSBwZWVyJ3MgZ2V0KCkgcmVxdWVzdCBieSBzZW5kaW5nIGEgcHV0IHJlcG9uc2Ugd2l0aCB0aGUgZGF0YS5cbiAgICBjb25zdCBkYXRhID0gYXdhaXQgdGhpcy5jb2xsZWN0aW9uLmdldCh0YWcpO1xuICAgIHRoaXMucHVzaCgncHV0JywgdGFnLCBkYXRhKTtcbiAgfVxuICBwdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpIHsgLy8gVGVsbCB0aGUgb3RoZXIgc2lkZSBhYm91dCBhIHNpZ25lZCB3cml0ZS5cbiAgICB0aGlzLnNlbmQob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSk7XG4gIH1cbiAgYXN5bmMgcHV0KHRhZywgc2lnbmF0dXJlKSB7IC8vIFJlY2VpdmUgYSBwdXQgbWVzc2FnZSBmcm9tIHRoZSBwZWVyLlxuICAgIC8vIElmIGl0IGlzIGEgcmVzcG9uc2UgdG8gYSBnZXQoKSByZXF1ZXN0LCByZXNvbHZlIHRoZSBjb3JyZXNwb25kaW5nIHByb21pc2UuXG4gICAgY29uc3QgcHJvbWlzZSA9IHRoaXMudW5zeW5jaHJvbml6ZWQ/LmdldCh0YWcpO1xuICAgIC8vIFJlZ2FyZGxlc3Mgb2Ygd2h5IHRoZSBvdGhlciBzaWRlIGlzIHNlbmRpbmcsIGlmIHdlIGhhdmUgYW4gb3V0c3RhbmRpbmcgcmVxdWVzdCwgY29tcGxldGUgaXQuXG4gICAgaWYgKHByb21pc2UpIHByb21pc2UucmVzb2x2ZShzaWduYXR1cmUpO1xuICAgIGVsc2UgYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnB1dCh0YWcsIHNpZ25hdHVyZSwgdGhpcyk7IC8vIE90aGVyd2lzZSwganVzdCB0cnkgdG8gd3JpdGUgaXQgbG9jYWxseS5cbiAgfVxuICBkZWxldGUodGFnLCBzaWduYXR1cmUpIHsgLy8gUmVjZWl2ZSBhIGRlbGV0ZSBtZXNzYWdlIGZyb20gdGhlIHBlZXIuXG4gICAgdGhpcy5jb2xsZWN0aW9uLmRlbGV0ZSh0YWcsIHNpZ25hdHVyZSwgdGhpcyk7XG4gIH1cbn1cbmV4cG9ydCBkZWZhdWx0IFN5bmNocm9uaXplcjtcbiIsImNsYXNzIENhY2hlIGV4dGVuZHMgTWFwe2NvbnN0cnVjdG9yKGUsdD0wKXtzdXBlcigpLHRoaXMubWF4U2l6ZT1lLHRoaXMuZGVmYXVsdFRpbWVUb0xpdmU9dCx0aGlzLl9uZXh0V3JpdGVJbmRleD0wLHRoaXMuX2tleUxpc3Q9QXJyYXkoZSksdGhpcy5fdGltZXJzPW5ldyBNYXB9c2V0KGUsdCxzPXRoaXMuZGVmYXVsdFRpbWVUb0xpdmUpe2xldCBpPXRoaXMuX25leHRXcml0ZUluZGV4O3RoaXMuZGVsZXRlKHRoaXMuX2tleUxpc3RbaV0pLHRoaXMuX2tleUxpc3RbaV09ZSx0aGlzLl9uZXh0V3JpdGVJbmRleD0oaSsxKSV0aGlzLm1heFNpemUsdGhpcy5fdGltZXJzLmhhcyhlKSYmY2xlYXJUaW1lb3V0KHRoaXMuX3RpbWVycy5nZXQoZSkpLHN1cGVyLnNldChlLHQpLHMmJnRoaXMuX3RpbWVycy5zZXQoZSxzZXRUaW1lb3V0KCgoKT0+dGhpcy5kZWxldGUoZSkpLHMpKX1kZWxldGUoZSl7cmV0dXJuIHRoaXMuX3RpbWVycy5oYXMoZSkmJmNsZWFyVGltZW91dCh0aGlzLl90aW1lcnMuZ2V0KGUpKSx0aGlzLl90aW1lcnMuZGVsZXRlKGUpLHN1cGVyLmRlbGV0ZShlKX1jbGVhcihlPXRoaXMubWF4U2l6ZSl7dGhpcy5tYXhTaXplPWUsdGhpcy5fa2V5TGlzdD1BcnJheShlKSx0aGlzLl9uZXh0V3JpdGVJbmRleD0wLHN1cGVyLmNsZWFyKCk7Zm9yKGNvbnN0IGUgb2YgdGhpcy5fdGltZXJzLnZhbHVlcygpKWNsZWFyVGltZW91dChlKTt0aGlzLl90aW1lcnMuY2xlYXIoKX19Y2xhc3MgU3RvcmFnZUJhc2V7Y29uc3RydWN0b3Ioe25hbWU6ZSxiYXNlTmFtZTp0PVwiU3RvcmFnZVwiLG1heFNlcmlhbGl6ZXJTaXplOnM9MWUzLGRlYnVnOmk9ITF9KXtjb25zdCBhPWAke3R9LyR7ZX1gLHI9bmV3IENhY2hlKHMpO09iamVjdC5hc3NpZ24odGhpcyx7bmFtZTplLGJhc2VOYW1lOnQsZnVsbE5hbWU6YSxkZWJ1ZzppLHNlcmlhbGl6ZXI6cn0pfWFzeW5jIGxpc3QoKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoXCJcIiwoKGUsdCk9PnRoaXMubGlzdEludGVybmFsKHQsZSkpKX1hc3luYyBnZXQoZSl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKGUsKChlLHQpPT50aGlzLmdldEludGVybmFsKHQsZSkpKX1hc3luYyBkZWxldGUoZSl7cmV0dXJuIHRoaXMuc2VyaWFsaXplKGUsKChlLHQpPT50aGlzLmRlbGV0ZUludGVybmFsKHQsZSkpKX1hc3luYyBwdXQoZSx0KXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUscyk9PnRoaXMucHV0SW50ZXJuYWwocyx0LGUpKSl9bG9nKC4uLmUpe3RoaXMuZGVidWcmJmNvbnNvbGUubG9nKHRoaXMubmFtZSwuLi5lKX1hc3luYyBzZXJpYWxpemUoZSx0KXtjb25zdHtzZXJpYWxpemVyOnMscmVhZHk6aX09dGhpcztsZXQgYT1zLmdldChlKXx8aTtyZXR1cm4gYT1hLnRoZW4oKGFzeW5jKCk9PnQoYXdhaXQgdGhpcy5yZWFkeSx0aGlzLnBhdGgoZSkpKSkscy5zZXQoZSxhKSxhd2FpdCBhfX1jb25zdHtSZXNwb25zZTplLFVSTDp0fT1nbG9iYWxUaGlzO2NsYXNzIFN0b3JhZ2VDYWNoZSBleHRlbmRzIFN0b3JhZ2VCYXNle2NvbnN0cnVjdG9yKC4uLmUpe3N1cGVyKC4uLmUpLHRoaXMuc3RyaXBwZXI9bmV3IFJlZ0V4cChgXi8ke3RoaXMuZnVsbE5hbWV9L2ApLHRoaXMucmVhZHk9Y2FjaGVzLm9wZW4odGhpcy5mdWxsTmFtZSl9YXN5bmMgbGlzdEludGVybmFsKGUsdCl7cmV0dXJuKGF3YWl0IHQua2V5cygpfHxbXSkubWFwKChlPT50aGlzLnRhZyhlLnVybCkpKX1hc3luYyBnZXRJbnRlcm5hbChlLHQpe2NvbnN0IHM9YXdhaXQgdC5tYXRjaChlKTtyZXR1cm4gcz8uanNvbigpfWRlbGV0ZUludGVybmFsKGUsdCl7cmV0dXJuIHQuZGVsZXRlKGUpfXB1dEludGVybmFsKHQscyxpKXtyZXR1cm4gaS5wdXQodCxlLmpzb24ocykpfXBhdGgoZSl7cmV0dXJuYC8ke3RoaXMuZnVsbE5hbWV9LyR7ZX1gfXRhZyhlKXtyZXR1cm4gbmV3IHQoZSkucGF0aG5hbWUucmVwbGFjZSh0aGlzLnN0cmlwcGVyLFwiXCIpfWRlc3Ryb3koKXtyZXR1cm4gY2FjaGVzLmRlbGV0ZSh0aGlzLmZ1bGxOYW1lKX19ZXhwb3J0e1N0b3JhZ2VDYWNoZSBhcyBTdG9yYWdlTG9jYWwsU3RvcmFnZUNhY2hlIGFzIGRlZmF1bHR9O1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHsgU3RvcmFnZUxvY2FsIH0gZnJvbSAnQGtpMXIweS9zdG9yYWdlJztcbmltcG9ydCBTeW5jaHJvbml6ZXIgZnJvbSAnLi9zeW5jaHJvbml6ZXIubWpzJztcbmltcG9ydCB7IHN0b3JhZ2VOYW1lLCBzdG9yYWdlVmVyc2lvbiB9IGZyb20gJy4vdmVyc2lvbi5tanMnO1xuY29uc3QgeyBDdXN0b21FdmVudCwgRXZlbnRUYXJnZXQsIFRleHREZWNvZGVyIH0gPSBnbG9iYWxUaGlzO1xuXG5leHBvcnQgY2xhc3MgQ29sbGVjdGlvbiBleHRlbmRzIEV2ZW50VGFyZ2V0IHtcblxuICBjb25zdHJ1Y3Rvcih7bmFtZSwgbGFiZWwgPSBuYW1lLCBzZXJ2aWNlcyA9IFtdLCBwcmVzZXJ2ZURlbGV0aW9ucyA9ICEhc2VydmljZXMubGVuZ3RoLFxuXHQgICAgICAgcGVyc2lzdGVuY2VDbGFzcyA9IFN0b3JhZ2VMb2NhbCwgZGJWZXJzaW9uID0gc3RvcmFnZVZlcnNpb24sIHBlcnNpc3RlbmNlQmFzZSA9IGAke3N0b3JhZ2VOYW1lfV8ke2RiVmVyc2lvbn1gLFxuXHQgICAgICAgZGVidWcgPSBmYWxzZSwgbXVsdGlwbGV4LCAvLyBDYXVzZXMgc3luY2hyb25pemF0aW9uIHRvIHJldXNlIGNvbm5lY3Rpb25zIGZvciBkaWZmZXJlbnQgQ29sbGVjdGlvbnMgb24gdGhlIHNhbWUgc2VydmljZS5cblx0ICAgICAgIGNoYW5uZWxOYW1lLCBzZXJ2aWNlTGFiZWx9KSB7XG4gICAgc3VwZXIoKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtuYW1lLCBsYWJlbCwgcHJlc2VydmVEZWxldGlvbnMsIHBlcnNpc3RlbmNlQ2xhc3MsIGRiVmVyc2lvbiwgbXVsdGlwbGV4LCBkZWJ1ZywgY2hhbm5lbE5hbWUsIHNlcnZpY2VMYWJlbCxcblx0XHRcdCBmdWxsTmFtZTogYCR7dGhpcy5jb25zdHJ1Y3Rvci5uYW1lfS8ke25hbWV9YCwgZnVsbExhYmVsOiBgJHt0aGlzLmNvbnN0cnVjdG9yLm5hbWV9LyR7bGFiZWx9YH0pO1xuICAgIHRoaXMuc3luY2hyb25pemUoLi4uc2VydmljZXMpO1xuICAgIGNvbnN0IHBlcnNpc3RlbmNlT3B0aW9ucyA9IHtuYW1lOiB0aGlzLmZ1bGxMYWJlbCwgYmFzZU5hbWU6IHBlcnNpc3RlbmNlQmFzZSwgZGVidWc6IGRlYnVnfTtcbiAgICBpZiAocGVyc2lzdGVuY2VDbGFzcy50aGVuKSB0aGlzLnBlcnNpc3RlbmNlU3RvcmUgPSBwZXJzaXN0ZW5jZUNsYXNzLnRoZW4oa2luZCA9PiBuZXcga2luZChwZXJzaXN0ZW5jZU9wdGlvbnMpKTtcbiAgICBlbHNlIHRoaXMucGVyc2lzdGVuY2VTdG9yZSA9IG5ldyBwZXJzaXN0ZW5jZUNsYXNzKHBlcnNpc3RlbmNlT3B0aW9ucyk7XG4gIH1cblxuICBhc3luYyBjbG9zZSgpIHtcbiAgICBhd2FpdCAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKS5jbG9zZSgpO1xuICB9XG4gIGFzeW5jIGRlc3Ryb3koKSB7XG4gICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0KCk7XG4gICAgY29uc3Qgc3RvcmUgPSBhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmU7XG4gICAgZGVsZXRlIHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBpZiAoc3RvcmUpIGF3YWl0IHN0b3JlLmRlc3Ryb3koKTtcbiAgfVxuXG4gIHN0YXRpYyBlcnJvcihlcnJvcikgeyAvLyBDYW4gYmUgb3ZlcnJpZGRlbiBieSB0aGUgY2xpZW50XG4gICAgY29uc29sZS5lcnJvcihlcnJvcik7XG4gIH1cbiAgLy8gQ3JlZGVudGlhbHMuc2lnbi8udmVyaWZ5IGNhbiBwcm9kdWNlL2FjY2VwdCBKU09OIE9CSkVDVFMgZm9yIHRoZSBuYW1lZCBcIkpTT04gU2VyaWFsaXphdGlvblwiIGZvcm0uXG4gIC8vIEFzIGl0IGhhcHBlbnMsIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGNhbiBkaXN0aW5ndWlzaCBiZXR3ZWVuIGEgY29tcGFjdCBzZXJpYWxpemF0aW9uIChiYXNlNjQgdGV4dClcbiAgLy8gdnMgYW4gb2JqZWN0LCBidXQgaXQgZG9lcyBub3QgcmVjb2duaXplIGEgU0VSSUFMSVpFRCBvYmplY3QuIEhlcmUgd2UgYm90dGxlbmVjayB0aG9zZSBvcGVyYXRpb25zXG4gIC8vIHN1Y2ggdGhhdCB0aGUgdGhpbmcgdGhhdCBpcyBhY3R1YWxseSBwZXJzaXN0ZWQgYW5kIHN5bmNocm9uaXplZCBpcyBhbHdheXMgYSBzdHJpbmcgLS0gZWl0aGVyIGJhc2U2NFxuICAvLyBjb21wYWN0IG9yIEpTT04gYmVnaW5uaW5nIHdpdGggYSBcIntcIiAod2hpY2ggYXJlIGRpc3Rpbmd1aXNoYWJsZSBiZWNhdXNlIFwie1wiIGlzIG5vdCBhIGJhc2U2NCBjaGFyYWN0ZXIpLlxuICBzdGF0aWMgZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSkgeyAvLyBSZXR1cm4gYSBzaWduYXR1cmUgdGhhdCBpcyBkZWZpbmF0ZWx5IGEgc3RyaW5nLlxuICAgIGlmICh0eXBlb2Yoc2lnbmF0dXJlKSAhPT0gJ3N0cmluZycpIHJldHVybiBKU09OLnN0cmluZ2lmeShzaWduYXR1cmUpO1xuICAgIHJldHVybiBzaWduYXR1cmU7XG4gIH1cbiAgLy8gUmV0dXJuIGEgY29tcGFjdCBvciBcIkpTT05cIiAob2JqZWN0KSBmb3JtIG9mIHNpZ25hdHVyZSAoaW5mbGF0aW5nIGEgc2VyaWFsaXphdGlvbiBvZiB0aGUgbGF0dGVyIGlmIG5lZWRlZCksIGJ1dCBub3QgYSBKU09OIHN0cmluZy5cbiAgc3RhdGljIG1heWJlSW5mbGF0ZShzaWduYXR1cmUpIHtcbiAgICBpZiAoc2lnbmF0dXJlPy5zdGFydHNXaXRoPy4oXCJ7XCIpKSByZXR1cm4gSlNPTi5wYXJzZShzaWduYXR1cmUpO1xuICAgIHJldHVybiBzaWduYXR1cmU7XG4gIH1cbiAgLy8gVGhlIHR5cGUgb2YgSldFIHRoYXQgZ2V0cyBzaWduZWQgKG5vdCB0aGUgY3R5IG9mIHRoZSBKV0UpLiBXZSBhdXRvbWF0aWNhbGx5IHRyeSB0byBkZWNyeXB0IGEgSldTIHBheWxvYWQgb2YgdGhpcyB0eXBlLlxuICBzdGF0aWMgZW5jcnlwdGVkTWltZVR5cGUgPSAndGV4dC9lbmNyeXB0ZWQnO1xuICBzdGF0aWMgYXN5bmMgZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKSB7IC8vIFByb21pc2UgdmVyZmllZCBhZnRlciBmaXJzdCBhdWdtZW50aW5nIHdpdGggZGVjcnlwdGVkIGRhdGEgYXMgbmVlZGVkLlxuICAgIGlmICh2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuY3R5ICE9PSB0aGlzLmVuY3J5cHRlZE1pbWVUeXBlKSByZXR1cm4gdmVyaWZpZWQ7XG4gICAgaWYgKHZlcmlmaWVkLmRlY3J5cHRlZCkgcmV0dXJuIHZlcmlmaWVkOyAvLyBBbHJlYWR5IGRlY3J5cHRlZC5cbiAgICBjb25zdCBkZWNyeXB0ZWQgPSBhd2FpdCBDcmVkZW50aWFscy5kZWNyeXB0KHZlcmlmaWVkLnRleHQpO1xuICAgIHZlcmlmaWVkLmpzb24gPSBkZWNyeXB0ZWQuanNvbjtcbiAgICB2ZXJpZmllZC50ZXh0ID0gZGVjcnlwdGVkLnRleHQ7XG4gICAgdmVyaWZpZWQucGF5bG9hZCA9IGRlY3J5cHRlZC5wYXlsb2FkO1xuICAgIHZlcmlmaWVkLmRlY3J5cHRlZCA9IGRlY3J5cHRlZDtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHNpZ24oZGF0YSwgb3B0aW9ucykge1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IENyZWRlbnRpYWxzLnNpZ24oZGF0YSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIHRoaXMuZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMgPSB7fSkge1xuICAgIHNpZ25hdHVyZSA9IHRoaXMubWF5YmVJbmZsYXRlKHNpZ25hdHVyZSk7XG4gICAgLy8gV2UgZG9uJ3QgZG8gXCJkZWVwXCIgdmVyaWZpY2F0aW9uIGhlcmUgLSBlLmcuLCBjaGVja2luZyB0aGF0IHRoZSBhY3QgaXMgYSBtZW1iZXIgb2YgaXNzLCBhbmQgdGhlIGlhdCBpcyBhZnRlciB0aGUgZXhpc3RpbmcgaWF0LlxuICAgIC8vIEluc3RlYWQsIHdlIGRvIG91ciBvd24gZGVlcCBjaGVja3MgaW4gdmFsaWRhdGVGb3JXcml0aW5nLlxuICAgIC8vIFRoZSBtZW1iZXIvbm90QmVmb3JlIHNob3VsZCBjaGVjayBvdXQgYW55d2F5IC0tIGkuZS4sIHdlIGNvdWxkIGxlYXZlIGl0IGluLCBleGNlcHQgaW4gc3luY2hyb25pemluZ1xuICAgIC8vIENyZWRlbnRpYWwuY29sbGVjdGlvbnMuIFRoZXJlIGlzIG5vIG1lY2hhbmlzbSAoY3VycmVudGx5KSBmb3IgdGhlXG4gICAgLy8gc3luY2hyb25pemF0aW9uIHRvIGhhcHBlbiBpbiBhbiBvcmRlciB0aGF0IHdpbGwgcmVzdWx0IGluIHRoZSBkZXBlbmRlbmNpZXMgY29taW5nIG92ZXIgYmVmb3JlIHRoZSBpdGVtcyB0aGF0IGNvbnN1bWUgdGhlbS5cbiAgICBjb25zdCB2ZXJpZmllZCA9ICBhd2FpdCBDcmVkZW50aWFscy52ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zKTtcbiAgICBpZiAodmVyaWZpZWQpIHZlcmlmaWVkLnNpZ25hdHVyZSA9IHNpZ25hdHVyZTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZlcmlmaWVkU2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucywgdGFnID0gbnVsbCkgeyAvLyBTaWduLCBidXQgcmV0dXJuIGEgdmFsaWRhdGlvbiAoYXMgdGhvdWdoIGJ5IGltbWVkaWF0ZWx5IHZhbGlkYXRpbmcpLlxuICAgIC8vIFRPRE86IGFzc2VtYmxlIHRoaXMgbW9yZSBjaGVhcGx5P1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuc2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgcmV0dXJuIHRoaXMudmFsaWRhdGlvbkZvcm1hdChzaWduYXR1cmUsIHRhZyk7XG4gIH1cbiAgc3RhdGljIGFzeW5jIHZhbGlkYXRpb25Gb3JtYXQoc2lnbmF0dXJlLCB0YWcgPSBudWxsKSB7XG4gICAgLy9jb25zb2xlLmxvZyh7dHlwZTogdHlwZW9mKHNpZ25hdHVyZSksIHNpZ25hdHVyZSwgdGFnfSk7XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLnZlcmlmeShzaWduYXR1cmUpO1xuICAgIC8vY29uc29sZS5sb2coe3ZlcmlmaWVkfSk7XG4gICAgY29uc3Qgc3ViID0gdmVyaWZpZWQuc3ViamVjdFRhZyA9IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gICAgdmVyaWZpZWQudGFnID0gdGFnIHx8IHN1YjtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cblxuICBhc3luYyB1bmRlbGV0ZWRUYWdzKCkge1xuICAgIC8vIE91ciBvd24gc2VwYXJhdGUsIG9uLWRlbWFuZCBhY2NvdW50aW5nIG9mIHBlcnNpc3RlbmNlU3RvcmUgbGlzdCgpOlxuICAgIC8vICAgLSBwZXJzaXN0ZW5jZVN0b3JlIGxpc3QoKSBjb3VsZCBwb3RlbnRpYWxseSBiZSBleHBlbnNpdmVcbiAgICAvLyAgIC0gSXQgd2lsbCBjb250YWluIHNvZnQtZGVsZXRlZCBpdGVtIHRvbWJzdG9uZXMgKHNpZ25lZCBlbXB0eSBwYXlsb2FkcykuXG4gICAgLy8gSXQgc3RhcnRzIHdpdGggYSBsaXN0KCkgdG8gZ2V0IGFueXRoaW5nIHBlcnNpc3RlZCBpbiBhIHByZXZpb3VzIHNlc3Npb24sIGFuZCBhZGRzL3JlbW92ZXMgYXMgd2Ugc3RvcmUvcmVtb3ZlLlxuICAgIGNvbnN0IGFsbFRhZ3MgPSBhd2FpdCAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKS5saXN0KCk7XG4gICAgY29uc3QgdGFncyA9IG5ldyBTZXQoKTtcbiAgICBhd2FpdCBQcm9taXNlLmFsbChhbGxUYWdzLm1hcChhc3luYyB0YWcgPT4ge1xuICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIHN5bmNocm9uaXplOiBmYWxzZX0pO1xuICAgICAgaWYgKHZlcmlmaWVkKSB0YWdzLmFkZCh0YWcpO1xuICAgIH0pKTtcbiAgICByZXR1cm4gdGFncztcbiAgfVxuICBnZXQgdGFncygpIHsgLy8gS2VlcHMgdHJhY2sgb2Ygb3VyICh1bmRlbGV0ZWQpIGtleXMuXG4gICAgcmV0dXJuIHRoaXMuX3RhZ3NQcm9taXNlIHx8PSB0aGlzLnVuZGVsZXRlZFRhZ3MoKTtcbiAgfVxuICBhc3luYyBhZGRUYWcodGFnKSB7XG4gICAgKGF3YWl0IHRoaXMudGFncykuYWRkKHRhZyk7XG4gIH1cbiAgYXN5bmMgZGVsZXRlVGFnKHRhZykge1xuICAgIChhd2FpdCB0aGlzLnRhZ3MpLmRlbGV0ZSh0YWcpO1xuICB9XG5cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAoIXRoaXMuZGVidWcpIHJldHVybjtcbiAgICBjb25zb2xlLmxvZyh0aGlzLmZ1bGxMYWJlbCwgLi4ucmVzdCk7XG4gIH1cbiAgX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob2JqZWN0T3JTdHJpbmcgPSB7fSkge1xuICAgIGlmICh0eXBlb2Yob2JqZWN0T3JTdHJpbmcpID09PSAnc3RyaW5nJykgb2JqZWN0T3JTdHJpbmcgPSB7dGFnOiBvYmplY3RPclN0cmluZ307XG4gICAgY29uc3Qge293bmVyOnRlYW0gPSBDcmVkZW50aWFscy5vd25lciwgYXV0aG9yOm1lbWJlciA9IENyZWRlbnRpYWxzLmF1dGhvcixcblx0ICAgdGFnLFxuXHQgICBlbmNyeXB0aW9uID0gQ3JlZGVudGlhbHMuZW5jcnlwdGlvbixcblx0ICAgdGltZSA9IERhdGUubm93KCksXG5cdCAgIC4uLnJlc3R9ID0gb2JqZWN0T3JTdHJpbmc7XG4gICAgLy8gVE9ETzogc3VwcG9ydCBzaW1wbGlmaWVkIHN5bnRheCwgdG9vLCBwZXIgUkVBRE1FXG4gICAgLy8gVE9ETzogc2hvdWxkIHdlIHNwZWNpZnkgc3ViamVjdDogdGFnIGZvciBib3RoIG11dGFibGVzPyAoZ2l2ZXMgaGFzaClcbiAgICBjb25zdCBvcHRpb25zID0gKHRlYW0gJiYgdGVhbSAhPT0gbWVtYmVyKSA/XG5cdCAge3RlYW0sIG1lbWJlciwgdGFnLCBlbmNyeXB0aW9uLCB0aW1lLCAuLi5yZXN0fSA6XG5cdCAge3RhZ3M6IFttZW1iZXJdLCB0YWcsIHRpbWUsIGVuY3J5cHRpb24sIC4uLnJlc3R9OyAvLyBObyBpYXQgaWYgdGltZSBub3QgZXhwbGljaXRseSBnaXZlbi5cbiAgICBpZiAoW3RydWUsICd0ZWFtJywgJ293bmVyJ10uaW5jbHVkZXMob3B0aW9ucy5lbmNyeXB0aW9uKSkgb3B0aW9ucy5lbmNyeXB0aW9uID0gdGVhbTtcbiAgICByZXR1cm4gb3B0aW9ucztcbiAgfVxuICBmYWlsKG9wZXJhdGlvbiwgZGF0YSwgYXV0aG9yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2F1dGhvcn0gZG9lcyBub3QgaGF2ZSB0aGUgYXV0aG9yaXR5IHRvICR7b3BlcmF0aW9ufSAke3RoaXMuZnVsbE5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9LmApO1xuICB9XG4gIGFzeW5jIHN0b3JlKGRhdGEsIG9wdGlvbnMgPSB7fSkge1xuICAgIC8vIGVuY3J5cHQgaWYgbmVlZGVkXG4gICAgLy8gc2lnblxuICAgIC8vIHB1dCA8PT0gQWxzbyB3aGVyZSB3ZSBlbnRlciBpZiBwdXNoZWQgZnJvbSBhIGNvbm5lY3Rpb25cbiAgICAvLyAgICB2YWxpZGF0ZUZvcldyaXRpbmdcbiAgICAvLyAgICAgICBleGl0IGlmIGltcHJvcGVyXG4gICAgLy8gICAgICAgZW1pdCB1cGRhdGUgZXZlbnRcbiAgICAvLyAgICBtZXJnZVNpZ25hdHVyZXNcbiAgICAvLyAgICBwZXJzaXN0IGxvY2FsbHlcbiAgICAvLyBwdXNoIChsaXZlIHRvIGFueSBjb25uZWN0aW9ucyBleGNlcHQgdGhlIG9uZSB3ZSByZWNlaXZlZCBmcm9tKVxuICAgIGxldCB7ZW5jcnlwdGlvbiwgdGFnLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpO1xuICAgIGlmIChlbmNyeXB0aW9uKSB7XG4gICAgICBkYXRhID0gYXdhaXQgQ3JlZGVudGlhbHMuZW5jcnlwdChkYXRhLCBlbmNyeXB0aW9uKTtcbiAgICAgIHNpZ25pbmdPcHRpb25zLmNvbnRlbnRUeXBlID0gdGhpcy5jb25zdHJ1Y3Rvci5lbmNyeXB0ZWRNaW1lVHlwZTtcbiAgICB9XG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb24uXG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zKTtcbiAgICB0YWcgPSBhd2FpdCB0aGlzLnB1dCh0YWcsIHNpZ25hdHVyZSk7XG4gICAgaWYgKCF0YWcpIHJldHVybiB0aGlzLmZhaWwoJ3N0b3JlJywgZGF0YSwgc2lnbmluZ09wdGlvbnMubWVtYmVyIHx8IHNpZ25pbmdPcHRpb25zLnRhZ3NbMF0pO1xuICAgIGF3YWl0IHRoaXMucHVzaCgncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgcHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlLCBleGNsdWRlU3luY2hyb25pemVyID0gbnVsbCkgeyAvLyBQdXNoIHRvIGFsbCBjb25uZWN0ZWQgc3luY2hyb25pemVycywgZXhjbHVkaW5nIHRoZSBzcGVjaWZpZWQgb25lLlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IChleGNsdWRlU3luY2hyb25pemVyICE9PSBzeW5jaHJvbml6ZXIpICYmIHN5bmNocm9uaXplci5wdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpKSk7XG4gIH1cbiAgYXN5bmMgcmVtb3ZlKG9wdGlvbnMgPSB7fSkgeyAvLyBOb3RlOiBSZWFsbHkganVzdCByZXBsYWNpbmcgd2l0aCBlbXB0eSBkYXRhIGZvcmV2ZXIuIE90aGVyd2lzZSBtZXJnaW5nIHdpdGggZWFybGllciBkYXRhIHdpbGwgYnJpbmcgaXQgYmFjayFcbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTtcbiAgICBjb25zdCBkYXRhID0gJyc7XG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb25cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHRhZyA9IGF3YWl0IHRoaXMuZGVsZXRlKHRhZywgc2lnbmF0dXJlKTtcbiAgICBpZiAoIXRhZykgcmV0dXJuIHRoaXMuZmFpbCgnc3RvcmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gZ2V0VmVyaWZpZWQgYW5kIG1heWJlIGRlY3J5cHQuIEhhcyBtb3JlIGNvbXBsZXggYmVoYXZpb3IgaW4gc3ViY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbi5cbiAgICBjb25zdCB7dGFnLCBkZWNyeXB0ID0gdHJ1ZSwgLi4ub3B0aW9uc30gPSB0YWdPck9wdGlvbnMudGFnID8gdGFnT3JPcHRpb25zIDoge3RhZzogdGFnT3JPcHRpb25zfTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZywgLi4ub3B0aW9uc30pO1xuICAgIGlmICghdmVyaWZpZWQpIHJldHVybiAnJztcbiAgICBpZiAoZGVjcnlwdCkgcmV0dXJuIGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgYXN5bmMgZ2V0VmVyaWZpZWQodGFnT3JPcHRpb25zKSB7IC8vIHN5bmNocm9uaXplLCBnZXQsIGFuZCB2ZXJpZnkgKGJ1dCB3aXRob3V0IGRlY3J5cHQpXG4gICAgY29uc3Qge3RhZywgc3luY2hyb25pemUgPSB0cnVlLCAuLi52ZXJpZnlPcHRpb25zfSA9IHRhZ09yT3B0aW9ucy50YWcgPyB0YWdPck9wdGlvbnM6IHt0YWc6IHRhZ09yT3B0aW9uc307XG4gICAgaWYgKHN5bmNocm9uaXplKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplMSh0YWcpO1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuZ2V0KHRhZyk7XG4gICAgaWYgKCFzaWduYXR1cmUpIHJldHVybiBzaWduYXR1cmU7XG4gICAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmVyaWZ5T3B0aW9ucyk7XG4gIH1cbiAgYXN5bmMgbGlzdChza2lwU3luYyA9IGZhbHNlICkgeyAvLyBMaXN0IGFsbCB0YWdzIG9mIHRoaXMgY29sbGVjdGlvbi5cbiAgICBpZiAoIXNraXBTeW5jKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIC8vIFdlIGNhbm5vdCBqdXN0IGxpc3QgdGhlIGtleXMgb2YgdGhlIGNvbGxlY3Rpb24sIGJlY2F1c2UgdGhhdCBpbmNsdWRlcyBlbXB0eSBwYXlsb2FkcyBvZiBpdGVtcyB0aGF0IGhhdmUgYmVlbiBkZWxldGVkLlxuICAgIHJldHVybiBBcnJheS5mcm9tKChhd2FpdCB0aGlzLnRhZ3MpLmtleXMoKSk7XG4gIH1cbiAgYXN5bmMgbWF0Y2godGFnLCBwcm9wZXJ0aWVzKSB7IC8vIElzIHRoaXMgc2lnbmF0dXJlIHdoYXQgd2UgYXJlIGxvb2tpbmcgZm9yP1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5yZXRyaWV2ZSh0YWcpO1xuICAgIGNvbnN0IGRhdGEgPSB2ZXJpZmllZD8uanNvbjtcbiAgICBpZiAoIWRhdGEpIHJldHVybiBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBwcm9wZXJ0aWVzKSB7XG4gICAgICBpZiAoZGF0YVtrZXldICE9PSBwcm9wZXJ0aWVzW2tleV0pIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgYXN5bmMgZmluZExvY2FsKHByb3BlcnRpZXMpIHsgLy8gRmluZCB0aGUgdGFnIGluIG91ciBzdG9yZSB0aGF0IG1hdGNoZXMsIGVsc2UgZmFsc2V5XG4gICAgZm9yIChjb25zdCB0YWcgb2YgYXdhaXQgdGhpcy5saXN0KCduby1zeW5jJykpIHsgLy8gRGlyZWN0IGxpc3QsIHcvbyBzeW5jLlxuICAgICAgaWYgKGF3YWl0IHRoaXMubWF0Y2godGFnLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIHRhZztcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGFzeW5jIGZpbmQocHJvcGVydGllcykgeyAvLyBBbnN3ZXIgdGhlIHRhZyB0aGF0IGhhcyB2YWx1ZXMgbWF0Y2hpbmcgdGhlIHNwZWNpZmllZCBwcm9wZXJ0aWVzLiBPYnZpb3VzbHksIGNhbid0IGJlIGVuY3J5cHRlZCBhcyBhIHdob2xlLlxuICAgIGxldCBmb3VuZCA9IGF3YWl0IHRoaXMuZmluZExvY2FsKHByb3BlcnRpZXMpO1xuICAgIGlmIChmb3VuZCkge1xuICAgICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZTEoZm91bmQpOyAvLyBNYWtlIHN1cmUgdGhlIGRhdGEgaXMgdXAgdG8gZGF0ZS4gVGhlbiBjaGVjayBhZ2Fpbi5cbiAgICAgIGlmIChhd2FpdCB0aGlzLm1hdGNoKGZvdW5kLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIGZvdW5kO1xuICAgIH1cbiAgICAvLyBObyBtYXRjaC5cbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemVEYXRhKCk7XG4gICAgZm91bmQgPSBhd2FpdCB0aGlzLmZpbmRMb2NhbChwcm9wZXJ0aWVzKTtcbiAgICBpZiAoZm91bmQgJiYgYXdhaXQgdGhpcy5tYXRjaChmb3VuZCwgcHJvcGVydGllcykpIHJldHVybiBmb3VuZDtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXF1aXJlVGFnKHRhZykge1xuICAgIGlmICh0YWcpIHJldHVybjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0EgdGFnIGlzIHJlcXVpcmVkLicpO1xuICB9XG5cbiAgLy8gVGhlc2UgdGhyZWUgaWdub3JlIHN5bmNocm9uaXphdGlvbiBzdGF0ZSwgd2hpY2ggaWYgbmVlZWQgaXMgdGhlIHJlc3BvbnNpYmlsaXR5IG9mIHRoZSBjYWxsZXIuXG4gIC8vIEZJWE1FIFRPRE86IGFmdGVyIGluaXRpYWwgZGV2ZWxvcG1lbnQsIHRoZXNlIHRocmVlIHNob3VsZCBiZSBtYWRlIGludGVybmFsIHNvIHRoYXQgYXBwbGljYXRpb24gY29kZSBkb2VzIG5vdCBjYWxsIHRoZW0uXG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gR2V0IHRoZSBsb2NhbCByYXcgc2lnbmF0dXJlIGRhdGEuXG4gICAgdGhpcy5yZXF1aXJlVGFnKHRhZyk7XG4gICAgcmV0dXJuIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmdldCh0YWcpO1xuICB9XG4gIC8vIFRoZXNlIHR3byBjYW4gYmUgdHJpZ2dlcmVkIGJ5IGNsaWVudCBjb2RlIG9yIGJ5IGFueSBzZXJ2aWNlLlxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUsIHN5bmNocm9uaXplciA9IG51bGwsIG1lcmdlQXV0aG9yT3ZlcnJpZGUgPSBudWxsKSB7IC8vIFB1dCB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIC8vIG1lcmdlU2lnbmF0dXJlcygpIE1BWSBjcmVhdGUgbmV3IG5ldyByZXN1bHRzIHRvIHNhdmUsIHRoYXQgc3RpbGwgaGF2ZSB0byBiZSBzaWduZWQuIEZvciB0ZXN0aW5nLCB3ZSBzb21ldGltZXNcbiAgICAvLyB3YW50IHRvIGJlaGF2ZSBhcyBpZiBzb21lIG93bmVyIGNyZWRlbnRpYWwgZG9lcyBub3QgZXhpc3Qgb24gdGhlIG1hY2hpbmUuIFRoYXQncyB3aGF0IG1lcmdlQXV0aG9yT3ZlcnJpZGUgaXMgZm9yLlxuXG4gICAgLy8gVE9ETzogZG8gd2UgbmVlZCB0byBxdWV1ZSB0aGVzZT8gU3VwcG9zZSB3ZSBhcmUgdmFsaWRhdGluZyBvciBtZXJnaW5nIHdoaWxlIG90aGVyIHJlcXVlc3QgYXJyaXZlP1xuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3N0b3JlJywgc3luY2hyb25pemVyKTtcbiAgICB0aGlzLmxvZygncHV0Jywge3RhZzogdmFsaWRhdGlvbj8udGFnIHx8IHRhZywgc3luY2hyb25pemVyOiBzeW5jaHJvbml6ZXI/LmxhYmVsLCBqc29uOiB2YWxpZGF0aW9uPy5qc29ufSk7XG4gICAgaWYgKCF2YWxpZGF0aW9uKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGF3YWl0IHRoaXMuYWRkVGFnKHZhbGlkYXRpb24udGFnKTtcblxuICAgIC8vIGZpeG1lIG5leHRcbiAgICBjb25zdCBtZXJnZWQgPSBhd2FpdCB0aGlzLm1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSwgbWVyZ2VBdXRob3JPdmVycmlkZSk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBtZXJnZWQpO1xuICAgIC8vY29uc3QgbWVyZ2VkMiA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmFsaWRhdGlvbkZvcm1hdChtZXJnZWQsIHRhZyk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIG1lcmdlZCk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QyKG1lcmdlZDIpO1xuICAgIC8vIGNvbnN0IG1lcmdlZCA9IGF3YWl0IHRoaXMubWVyZ2VWYWxpZGF0aW9uKHZhbGlkYXRpb24sIG1lcmdlQXV0aG9yT3ZlcnJpZGUpO1xuICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIobWVyZ2VkKTtcblxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5wdXQuXG4gIH1cbiAgYXN5bmMgZGVsZXRlKHRhZywgc2lnbmF0dXJlLCBzeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFJlbW92ZSB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3JlbW92ZScsIHN5bmNocm9uaXplciwgJ3JlcXVpcmVUYWcnKTtcbiAgICB0aGlzLmxvZygnZGVsZXRlJywgdGFnLCBzeW5jaHJvbml6ZXI/LmxhYmVsLCAndmFsaWRhdGVkIHRhZzonLCB2YWxpZGF0aW9uPy50YWcsICdwcmVzZXJ2ZURlbGV0aW9uczonLCB0aGlzLnByZXNlcnZlRGVsZXRpb25zKTtcbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICBpZiAodGhpcy5wcmVzZXJ2ZURlbGV0aW9ucykgeyAvLyBTaWduYXR1cmUgcGF5bG9hZCBpcyBlbXB0eS5cbiAgICAgIC8vIEZJWE1FIG5leHRcbiAgICAgIC8vYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBzaWduYXR1cmUpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uKTtcbiAgICB9IGVsc2UgeyAvLyBSZWFsbHkgZGVsZXRlLlxuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIHNpZ25hdHVyZSwgJ2RlbGV0ZScpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uLCAnZGVsZXRlJyk7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5kZWxldGUuXG4gIH1cblxuICBub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsIG1lc3NhZ2UgPSB1bmRlZmluZWQsIHZhbGlkYXRlZCA9ICcnLCBzaWduYXR1cmUpIHtcbiAgICAvLyBMYXRlciBvbiwgd2Ugd2lsbCBub3Qgd2FudCB0byBnaXZlIG91dCBzbyBtdWNoIGluZm8uLi5cbiAgICAvL2lmICh0aGlzLmRlYnVnKSB7XG4gICAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSwgdGFnKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy8gIGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgYFNpZ25hdHVyZSBpcyBub3QgdmFsaWQgdG8gJHtvcGVyYXRpb25MYWJlbH0gJHt0YWcgfHwgJ2RhdGEnfS5gKTtcbiAgICAvL31cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIFJldHVybiBhIHJlYXNvbiBzdHJpbmcgd2h5IHRoZSBwcm9wb3NlZCB2ZXJpZmllZCBwcm90ZWN0ZWRIZWFkZXJcbiAgICAvLyBzaG91bGQgbm90IGJlIGFsbG93ZWQgdG8gb3ZlcnJ3cml0ZSB0aGUgKHBvc3NpYmx5IG51bGxpc2gpIGV4aXN0aW5nIHZlcmlmaWVkIHByb3RlY3RlZEhlYWRlcixcbiAgICAvLyBlbHNlIGZhbHN5IGlmIGFsbG93ZWQuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuIG51bGw7XG4gICAgaWYgKHByb3Bvc2VkLmlhdCA8IGV4aXN0aW5nLmlhdCkgcmV0dXJuICdiYWNrZGF0ZWQnO1xuICAgIGlmICghdGhpcy5vd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkpIHJldHVybiAnbm90IG93bmVyJztcbiAgICBpZiAoIWF3YWl0IHRoaXMuc3ViamVjdE1hdGNoKHZlcmlmaWVkKSkgcmV0dXJuICd3cm9uZyBoYXNoJztcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBhc3luYyBzdWJqZWN0TWF0Y2godmVyaWZpZWQpIHsgLy8gUHJvbWlzZXMgdHJ1ZSBJRkYgY2xhaW1lZCAnc3ViJyBtYXRjaGVzIGhhc2ggb2YgdGhlIGNvbnRlbnRzLlxuICAgIHJldHVybiB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViID09PSBhd2FpdCBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoYXdhaXQgQ3JlZGVudGlhbHMuaGFzaEJ1ZmZlcih2ZXJpZmllZC5wYXlsb2FkKSk7XG4gIH1cbiAgb3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpIHsvLyBEb2VzIHByb3Bvc2VkIG93bmVyIG1hdGNoIHRoZSBleGlzdGluZz9cbiAgICBjb25zdCBleGlzdGluZ093bmVyID0gZXhpc3Rpbmc/LmlzcyB8fCBleGlzdGluZz8ua2lkO1xuICAgIGNvbnN0IHByb3Bvc2VkT3duZXIgPSBwcm9wb3NlZC5pc3MgfHwgcHJvcG9zZWQua2lkO1xuICAgIC8vIEV4YWN0IG1hdGNoLiBEbyB3ZSBuZWVkIHRvIGFsbG93IGZvciBhbiBvd25lciB0byB0cmFuc2ZlciBvd25lcnNoaXAgdG8gYSBzdWIvc3VwZXIvZGlzam9pbnQgdGVhbT9cbiAgICAvLyBDdXJyZW50bHksIHRoYXQgd291bGQgcmVxdWlyZSBhIG5ldyByZWNvcmQuIChFLmcuLCB0d28gTXV0YWJsZS9WZXJzaW9uZWRDb2xsZWN0aW9uIGl0ZW1zIHRoYXRcbiAgICAvLyBoYXZlIHRoZSBzYW1lIEdVSUQgcGF5bG9hZCBwcm9wZXJ0eSwgYnV0IGRpZmZlcmVudCB0YWdzLiBJLmUuLCBhIGRpZmZlcmVudCBvd25lciBtZWFucyBhIGRpZmZlcmVudCB0YWcuKVxuICAgIGlmICghcHJvcG9zZWRPd25lciB8fCAoZXhpc3RpbmdPd25lciAmJiAocHJvcG9zZWRPd25lciAhPT0gZXhpc3RpbmdPd25lcikpKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgIC8vIFdlIGFyZSBub3QgY2hlY2tpbmcgdG8gc2VlIGlmIGF1dGhvciBpcyBjdXJyZW50bHkgYSBtZW1iZXIgb2YgdGhlIG93bmVyIHRlYW0gaGVyZSwgd2hpY2hcbiAgICAgIC8vIGlzIGNhbGxlZCBieSBwdXQoKS9kZWxldGUoKSBpbiB0d28gY2lyY3Vtc3RhbmNlczpcblxuICAgICAgLy8gdGhpcy52YWxpZGF0ZUZvcldyaXRpbmcoKSBpcyBjYWxsZWQgYnkgcHV0KCkvZGVsZXRlKCkgd2hpY2ggaGFwcGVucyBpbiB0aGUgYXBwICh2aWEgc3RvcmUoKS9yZW1vdmUoKSlcbiAgICAgIC8vIGFuZCBkdXJpbmcgc3luYyBmcm9tIGFub3RoZXIgc2VydmljZTpcblxuICAgICAgLy8gMS4gRnJvbSB0aGUgYXBwICh2YWlhIHN0b3JlKCkvcmVtb3ZlKCksIHdoZXJlIHdlIGhhdmUganVzdCBjcmVhdGVkIHRoZSBzaWduYXR1cmUuIFNpZ25pbmcgaXRzZWxmXG4gICAgICAvLyB3aWxsIGZhaWwgaWYgdGhlICgxLWhvdXIgY2FjaGVkKSBrZXkgaXMgbm8gbG9uZ2VyIGEgbWVtYmVyIG9mIHRoZSB0ZWFtLiBUaGVyZSBpcyBubyBpbnRlcmZhY2VcbiAgICAgIC8vIGZvciB0aGUgYXBwIHRvIHByb3ZpZGUgYW4gb2xkIHNpZ25hdHVyZS4gKFRPRE86IGFmdGVyIHdlIG1ha2UgZ2V0L3B1dC9kZWxldGUgaW50ZXJuYWwuKVxuXG4gICAgICAvLyAyLiBEdXJpbmcgc3luYyBmcm9tIGFub3RoZXIgc2VydmljZSwgd2hlcmUgd2UgYXJlIHB1bGxpbmcgaW4gb2xkIHJlY29yZHMgZm9yIHdoaWNoIHdlIGRvbid0IGhhdmVcbiAgICAgIC8vIHRlYW0gbWVtYmVyc2hpcCBmcm9tIHRoYXQgdGltZS5cblxuICAgICAgLy8gSWYgdGhlIGFwcCBjYXJlcyB3aGV0aGVyIHRoZSBhdXRob3IgaGFzIGJlZW4ga2lja2VkIGZyb20gdGhlIHRlYW0sIHRoZSBhcHAgaXRzZWxmIHdpbGwgaGF2ZSB0byBjaGVjay5cbiAgICAgIC8vIFRPRE86IHdlIHNob3VsZCBwcm92aWRlIGEgdG9vbCBmb3IgdGhhdC5cblxuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGFudGVjZWRlbnQodmVyaWZpZWQpIHsgLy8gV2hhdCB0YWcgc2hvdWxkIHRoZSB2ZXJpZmllZCBzaWduYXR1cmUgYmUgY29tcGFyZWQgYWdhaW5zdCBmb3Igd3JpdGluZz9cbiAgICByZXR1cm4gdmVyaWZpZWQudGFnO1xuICB9XG4gIHN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpIHsgLy8gU2hvdWxkIHRoZSBhbnRlY2VkZW50IHRyeSBzeW5jaHJvbml6aW5nIGJlZm9yZSBnZXR0aW5nIGl0P1xuICAgIHJldHVybiB0YWcgIT09IGFudGVjZWRlbnQ7IC8vIEZhbHNlIHdoZW4gdGhleSBhcmUgdGhlIHNhbWUgdGFnLCBhcyB0aGF0IHdvdWxkIGJlIGNpcmN1bGFyLiBWZXJzaW9ucyBkbyBzeW5jLlxuICB9XG4gIC8vIFRPRE86IGlzIHRoaXMgbmVlZGVkIGFueSBtb3JlP1xuICBhc3luYyB2YWxpZGF0ZUZvcldyaXRpbmcodGFnLCBzaWduYXR1cmUsIG9wZXJhdGlvbkxhYmVsLCBzeW5jaHJvbml6ZXIsIHJlcXVpcmVUYWcgPSBmYWxzZSkge1xuICAgIC8vIEEgZGVlcCB2ZXJpZnkgdGhhdCBjaGVja3MgYWdhaW5zdCB0aGUgZXhpc3RpbmcgaXRlbSdzIChyZS0pdmVyaWZpZWQgaGVhZGVycy5cbiAgICAvLyBJZiBpdCBzdWNjZWVkcywgdGhpcyBpcyBhbHNvIHRoZSBjb21tb24gY29kZSAoYmV0d2VlbiBwdXQvZGVsZXRlKSB0aGF0IGVtaXRzIHRoZSB1cGRhdGUgZXZlbnQuXG4gICAgY29uc3QgdmFsaWRhdGlvbk9wdGlvbnMgPSBzeW5jaHJvbml6ZXIgPyB7bWVtYmVyOiBudWxsfSA6IHt9OyAvLyBDb3VsZCBiZSBvbGQgZGF0YSB3cml0dGVuIGJ5IHNvbWVvbmUgd2hvIGlzIG5vIGxvbmdlciBhIG1lbWJlci5cbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmFsaWRhdGlvbk9wdGlvbnMpO1xuICAgIGlmICghdmVyaWZpZWQpIHJldHVybiB0aGlzLm5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgJ2ludmFsaWQnLCB2ZXJpZmllZCwgc2lnbmF0dXJlKTtcbiAgICB2ZXJpZmllZC5zeW5jaHJvbml6ZXIgPSBzeW5jaHJvbml6ZXI7XG4gICAgdGFnID0gdmVyaWZpZWQudGFnID0gdmVyaWZpZWQuc3ViamVjdFRhZyA9IHJlcXVpcmVUYWcgPyB0YWcgOiBhd2FpdCB0aGlzLnRhZ0ZvcldyaXRpbmcodGFnLCB2ZXJpZmllZCk7XG4gICAgY29uc3QgYW50ZWNlZGVudCA9IHRoaXMuYW50ZWNlZGVudCh2ZXJpZmllZCk7XG4gICAgY29uc3Qgc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpO1xuICAgIGNvbnN0IGV4aXN0aW5nVmVyaWZpZWQgPSB2ZXJpZmllZC5leGlzdGluZyA9IGFudGVjZWRlbnQgJiYgYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnOiBhbnRlY2VkZW50LCBzeW5jaHJvbml6ZSwgLi4udmFsaWRhdGlvbk9wdGlvbnN9KTtcbiAgICBjb25zdCBkaXNhbGxvd2VkID0gYXdhaXQgdGhpcy5kaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmdWZXJpZmllZD8ucHJvdGVjdGVkSGVhZGVyLCB2ZXJpZmllZD8ucHJvdGVjdGVkSGVhZGVyLCB2ZXJpZmllZCk7XG4gICAgaWYgKGRpc2FsbG93ZWQpIHJldHVybiB0aGlzLm5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgZGlzYWxsb3dlZCwgdmVyaWZpZWQpO1xuICAgIHRoaXMubG9nKCdlbWl0JywgdGFnLCB2ZXJpZmllZC5qc29uKTtcbiAgICB0aGlzLmVtaXQodmVyaWZpZWQpO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICAvLyBmaXhtZSBuZXh0IDJcbiAgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlKSB7IC8vIFJldHVybiBhIHN0cmluZyB0byBiZSBwZXJzaXN0ZWQuIFVzdWFsbHkganVzdCB0aGUgc2lnbmF0dXJlLlxuICAgIHJldHVybiBzaWduYXR1cmU7ICAvLyB2YWxpZGF0aW9uLnN0cmluZyBtaWdodCBiZSBhbiBvYmplY3QuXG4gIH1cbiAgYXN5bmMgcGVyc2lzdCh0YWcsIHNpZ25hdHVyZVN0cmluZywgb3BlcmF0aW9uID0gJ3B1dCcpIHsgLy8gQ29uZHVjdCB0aGUgc3BlY2lmaWVkIHRhZy9zaWduYXR1cmUgb3BlcmF0aW9uIG9uIHRoZSBwZXJzaXN0ZW50IHN0b3JlLlxuICAgIHJldHVybiAoYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlKVtvcGVyYXRpb25dKHRhZywgc2lnbmF0dXJlU3RyaW5nKTtcbiAgfVxuICBtZXJnZVZhbGlkYXRpb24odmFsaWRhdGlvbikgeyAvLyBSZXR1cm4gYSBzdHJpbmcgdG8gYmUgcGVyc2lzdGVkLiBVc3VhbGx5IGp1c3QgdGhlIHNpZ25hdHVyZS5cbiAgICByZXR1cm4gdmFsaWRhdGlvbjtcbiAgfVxuICBhc3luYyBwZXJzaXN0Mih2YWxpZGF0aW9uLCBvcGVyYXRpb24gPSAncHV0JykgeyAvLyBDb25kdWN0IHRoZSBzcGVjaWZpZWQgdGFnL3NpZ25hdHVyZSBvcGVyYXRpb24gb24gdGhlIHBlcnNpc3RlbnQgc3RvcmUuIFJldHVybiB0YWdcbiAgICBjb25zdCB7dGFnLCBzaWduYXR1cmV9ID0gdmFsaWRhdGlvbjtcbiAgICBjb25zdCBzaWduYXR1cmVTdHJpbmcgPSB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICAgIGNvbnN0IHN0b3JhZ2UgPSBhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmU7XG4gICAgYXdhaXQgc3RvcmFnZVtvcGVyYXRpb25dKHRhZywgc2lnbmF0dXJlU3RyaW5nKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGVtaXQodmVyaWZpZWQpIHsgLy8gRGlzcGF0Y2ggdGhlIHVwZGF0ZSBldmVudC5cbiAgICB0aGlzLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KCd1cGRhdGUnLCB7ZGV0YWlsOiB2ZXJpZmllZH0pKTtcbiAgfVxuICBnZXQgaXRlbUVtaXR0ZXIoKSB7IC8vIEFuc3dlcnMgdGhlIENvbGxlY3Rpb24gdGhhdCBlbWl0cyBpbmRpdmlkdWFsIHVwZGF0ZXMuIChTZWUgb3ZlcnJpZGUgaW4gVmVyc2lvbmVkQ29sbGVjdGlvbi4pXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBzeW5jaHJvbml6ZXJzID0gbmV3IE1hcCgpOyAvLyBzZXJ2aWNlSW5mbyBtaWdodCBub3QgYmUgYSBzdHJpbmcuXG4gIG1hcFN5bmNocm9uaXplcnMoZikgeyAvLyBPbiBTYWZhcmksIE1hcC52YWx1ZXMoKS5tYXAgaXMgbm90IGEgZnVuY3Rpb24hXG4gICAgY29uc3QgcmVzdWx0cyA9IFtdO1xuICAgIGZvciAoY29uc3Qgc3luY2hyb25pemVyIG9mIHRoaXMuc3luY2hyb25pemVycy52YWx1ZXMoKSkge1xuICAgICAgcmVzdWx0cy5wdXNoKGYoc3luY2hyb25pemVyKSk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHRzO1xuICB9XG4gIGdldCBzZXJ2aWNlcygpIHtcbiAgICByZXR1cm4gQXJyYXkuZnJvbSh0aGlzLnN5bmNocm9uaXplcnMua2V5cygpKTtcbiAgfVxuICAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBjb25uZWN0LCBhbmQgZGVmaW5lIHN5bmNocm9uaXplIHRvIGF3YWl0IGNvbm5lY3QsIHN5bmNocm9uaXphdGlvbkNvbXBsZXRlLCBkaXNjb25ubmVjdC5cbiAgYXN5bmMgc3luY2hyb25pemUoLi4uc2VydmljZXMpIHsgLy8gU3RhcnQgcnVubmluZyB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzIChpbiBhZGRpdGlvbiB0byB3aGF0ZXZlciBpcyBhbHJlYWR5IHJ1bm5pbmcpLlxuICAgIGNvbnN0IHtzeW5jaHJvbml6ZXJzfSA9IHRoaXM7XG4gICAgZm9yIChsZXQgc2VydmljZSBvZiBzZXJ2aWNlcykge1xuICAgICAgaWYgKHN5bmNocm9uaXplcnMuaGFzKHNlcnZpY2UpKSBjb250aW51ZTtcbiAgICAgIGF3YWl0IFN5bmNocm9uaXplci5jcmVhdGUodGhpcywgc2VydmljZSk7IC8vIFJlYWNoZXMgaW50byBvdXIgc3luY2hyb25pemVycyBtYXAgYW5kIHNldHMgaXRzZWxmIGltbWVkaWF0ZWx5LlxuICAgIH1cbiAgfVxuICBnZXQgc3luY2hyb25pemVkKCkgeyAvLyBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBzeW5jaHJvbml6YXRpb24gaXMgY29tcGxldGUgaW4gQk9USCBkaXJlY3Rpb25zLlxuICAgIC8vIFRPRE8/IFRoaXMgZG9lcyBub3QgcmVmbGVjdCBjaGFuZ2VzIGFzIFN5bmNocm9uaXplcnMgYXJlIGFkZGVkIG9yIHJlbW92ZWQgc2luY2UgY2FsbGVkLiBTaG91bGQgaXQ/XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHRoaXMubWFwU3luY2hyb25pemVycyhzID0+IHMuYm90aFNpZGVzQ29tcGxldGVkU3luY2hyb25pemF0aW9uKSk7XG4gIH1cbiAgYXN5bmMgZGlzY29ubmVjdCguLi5zZXJ2aWNlcykgeyAvLyBTaHV0IGRvd24gdGhlIHNwZWNpZmllZCBzZXJ2aWNlcy5cbiAgICBpZiAoIXNlcnZpY2VzLmxlbmd0aCkgc2VydmljZXMgPSB0aGlzLnNlcnZpY2VzO1xuICAgIGNvbnN0IHtzeW5jaHJvbml6ZXJzfSA9IHRoaXM7XG4gICAgZm9yIChsZXQgc2VydmljZSBvZiBzZXJ2aWNlcykge1xuICAgICAgY29uc3Qgc3luY2hyb25pemVyID0gc3luY2hyb25pemVycy5nZXQoc2VydmljZSk7XG4gICAgICBpZiAoIXN5bmNocm9uaXplcikge1xuXHQvL2NvbnNvbGUud2FybihgJHt0aGlzLmZ1bGxMYWJlbH0gZG9lcyBub3QgaGF2ZSBhIHNlcnZpY2UgbmFtZWQgJyR7c2VydmljZX0nIHRvIGRpc2Nvbm5lY3QuYCk7XG5cdGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYXdhaXQgc3luY2hyb25pemVyLmRpc2Nvbm5lY3QoKTtcbiAgICB9XG4gIH1cbiAgYXN5bmMgZW5zdXJlU3luY2hyb25pemVyKHNlcnZpY2VOYW1lLCBjb25uZWN0aW9uLCBkYXRhQ2hhbm5lbCkgeyAvLyBNYWtlIHN1cmUgZGF0YUNoYW5uZWwgbWF0Y2hlcyB0aGUgc3luY2hyb25pemVyLCBjcmVhdGluZyBTeW5jaHJvbml6ZXIgb25seSBpZiBtaXNzaW5nLlxuICAgIGxldCBzeW5jaHJvbml6ZXIgPSB0aGlzLnN5bmNocm9uaXplcnMuZ2V0KHNlcnZpY2VOYW1lKTtcbiAgICBpZiAoIXN5bmNocm9uaXplcikge1xuICAgICAgc3luY2hyb25pemVyID0gbmV3IFN5bmNocm9uaXplcih7c2VydmljZU5hbWUsIGNvbGxlY3Rpb246IHRoaXMsIGRlYnVnOiB0aGlzLmRlYnVnfSk7XG4gICAgICBzeW5jaHJvbml6ZXIuY29ubmVjdGlvbiA9IGNvbm5lY3Rpb247XG4gICAgICBzeW5jaHJvbml6ZXIuZGF0YUNoYW5uZWxQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGRhdGFDaGFubmVsKTtcbiAgICAgIHRoaXMuc3luY2hyb25pemVycy5zZXQoc2VydmljZU5hbWUsIHN5bmNocm9uaXplcik7XG4gICAgICAvLyBEb2VzIE5PVCBzdGFydCBzeW5jaHJvbml6aW5nLiBDYWxsZXIgbXVzdCBkbyB0aGF0IGlmIGRlc2lyZWQuIChSb3V0ZXIgZG9lc24ndCBuZWVkIHRvLilcbiAgICB9IGVsc2UgaWYgKChzeW5jaHJvbml6ZXIuY29ubmVjdGlvbiAhPT0gY29ubmVjdGlvbikgfHxcblx0ICAgICAgIChzeW5jaHJvbml6ZXIuY2hhbm5lbE5hbWUgIT09IGRhdGFDaGFubmVsLmxhYmVsKSB8fFxuXHQgICAgICAgKGF3YWl0IHN5bmNocm9uaXplci5kYXRhQ2hhbm5lbFByb21pc2UgIT09IGRhdGFDaGFubmVsKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbm1hdGNoZWQgY29ubmVjdGlvbiBmb3IgJHtzZXJ2aWNlTmFtZX0uYCk7XG4gICAgfVxuICAgIHJldHVybiBzeW5jaHJvbml6ZXI7XG4gIH1cblxuICBwcm9taXNlKGtleSwgdGh1bmspIHsgcmV0dXJuIHRodW5rOyB9IC8vIFRPRE86IGhvdyB3aWxsIHdlIGtlZXAgdHJhY2sgb2Ygb3ZlcmxhcHBpbmcgZGlzdGluY3Qgc3luY3M/XG4gIHN5bmNocm9uaXplMSh0YWcpIHsgLy8gQ29tcGFyZSBhZ2FpbnN0IGFueSByZW1haW5pbmcgdW5zeW5jaHJvbml6ZWQgZGF0YSwgZmV0Y2ggd2hhdCdzIG5lZWRlZCwgYW5kIHJlc29sdmUgbG9jYWxseS5cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHN5bmNocm9uaXplciA9PiBzeW5jaHJvbml6ZXIuc3luY2hyb25pemF0aW9uUHJvbWlzZSh0YWcpKSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemVUYWdzKCkgeyAvLyBFbnN1cmUgdGhhdCB3ZSBoYXZlIHVwIHRvIGRhdGUgdGFnIG1hcCBhbW9uZyBhbGwgc2VydmljZXMuIChXZSBkb24ndCBjYXJlIHlldCBvZiB0aGUgdmFsdWVzIGFyZSBzeW5jaHJvbml6ZWQuKVxuICAgIHJldHVybiB0aGlzLnByb21pc2UoJ3RhZ3MnLCAoKSA9PiBQcm9taXNlLnJlc29sdmUoKSk7IC8vIFRPRE9cbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZURhdGEoKSB7IC8vIE1ha2UgdGhlIGRhdGEgdG8gbWF0Y2ggb3VyIHRhZ21hcCwgdXNpbmcgc3luY2hyb25pemUxLlxuICAgIHJldHVybiB0aGlzLnByb21pc2UoJ2RhdGEnLCAoKSA9PiBQcm9taXNlLnJlc29sdmUoKSk7IC8vIFRPRE9cbiAgfVxuICBzZXQgb251cGRhdGUoaGFuZGxlcikgeyAvLyBBbGxvdyBzZXR0aW5nIGluIGxpZXUgb2YgYWRkRXZlbnRMaXN0ZW5lci5cbiAgICBpZiAoaGFuZGxlcikge1xuICAgICAgdGhpcy5fdXBkYXRlID0gaGFuZGxlcjtcbiAgICAgIHRoaXMuYWRkRXZlbnRMaXN0ZW5lcigndXBkYXRlJywgaGFuZGxlcik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMucmVtb3ZlRXZlbnRMaXN0ZW5lcigndXBkYXRlJywgdGhpcy5fdXBkYXRlKTtcbiAgICAgIHRoaXMuX3VwZGF0ZSA9IGhhbmRsZXI7XG4gICAgfVxuICB9XG4gIGdldCBvbnVwZGF0ZSgpIHsgLy8gQXMgc2V0IGJ5IHRoaXMub251cGRhdGUgPSBoYW5kbGVyLiBEb2VzIE5PVCBhbnN3ZXIgdGhhdCB3aGljaCBpcyBzZXQgYnkgYWRkRXZlbnRMaXN0ZW5lci5cbiAgICByZXR1cm4gdGhpcy5fdXBkYXRlO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBJbW11dGFibGVDb2xsZWN0aW9uIGV4dGVuZHMgQ29sbGVjdGlvbiB7XG4gIHRhZ0ZvcldyaXRpbmcodGFnLCB2YWxpZGF0aW9uKSB7IC8vIElnbm9yZXMgdGFnLiBKdXN0IHRoZSBoYXNoLlxuICAgIHJldHVybiB2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gIH1cbiAgYXN5bmMgZGlzYWxsb3dXcml0ZSh0YWcsIGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpIHsgLy8gT3ZlcnJpZGVzIHN1cGVyIGJ5IGFsbG93aW5nIEVBUkxJRVIgcmF0aGVyIHRoYW4gbGF0ZXIuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG4gICAgaWYgKCFleGlzdGluZykge1xuICAgICAgaWYgKHZlcmlmaWVkLmxlbmd0aCAmJiAodGFnICE9PSBwcm9wb3NlZC5zdWIpKSByZXR1cm4gJ3dyb25nIHRhZyc7XG4gICAgICBpZiAoIWF3YWl0IHRoaXMuc3ViamVjdE1hdGNoKHZlcmlmaWVkKSkgcmV0dXJuICd3cm9uZyBoYXNoJztcbiAgICAgIHJldHVybiBudWxsOyAvLyBGaXJzdCB3cml0ZSBvay5cbiAgICB9XG4gICAgLy8gTm8gb3duZXIgbWF0Y2guIE5vdCByZWxldmFudCBmb3IgaW1tdXRhYmxlcy5cbiAgICBpZiAoIXZlcmlmaWVkLnBheWxvYWQubGVuZ3RoICYmIChwcm9wb3NlZC5pYXQgPiBleGlzdGluZy5pYXQpKSByZXR1cm4gbnVsbDsgLy8gTGF0ZXIgZGVsZXRlIGlzIG9rLlxuICAgIGlmIChwcm9wb3NlZC5pYXQgPiBleGlzdGluZy5pYXQpIHJldHVybiAncmV3cml0ZSc7IC8vIE90aGVyd2lzZSwgbGF0ZXIgd3JpdGVzIGFyZSBub3QuXG4gICAgaWYgKHByb3Bvc2VkLnN1YiAhPT0gZXhpc3Rpbmcuc3ViKSByZXR1cm4gJ2FsdGVyZWQgY29udGVudHMnO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5leHBvcnQgY2xhc3MgTXV0YWJsZUNvbGxlY3Rpb24gZXh0ZW5kcyBDb2xsZWN0aW9uIHtcbiAgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gVXNlIHRhZyBpZiBzcGVjaWZpZWQsIGJ1dCBkZWZhdWx0cyB0byBoYXNoLlxuICAgIHJldHVybiB0YWcgfHwgdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICB9XG59XG5cbi8vIEVhY2ggVmVyc2lvbmVkQ29sbGVjdGlvbiBoYXMgYSBzZXQgb2YgaGFzaC1pZGVudGlmaWVkIGltbXV0YWJsZSBpdGVtcyB0aGF0IGZvcm0gdGhlIGluZGl2aWR1YWwgdmVyc2lvbnMsIGFuZCBhIG1hcCBvZiB0aW1lc3RhbXBzIHRvIHRob3NlIGl0ZW1zLlxuLy8gV2UgY3VycmVudGx5IG1vZGVsIHRoaXMgYnkgaGF2aW5nIHRoZSBtYWluIGNvbGxlY3Rpb24gYmUgdGhlIG11dGFibGUgbWFwLCBhbmQgdGhlIHZlcnNpb25zIGluc3RhbmNlIHZhcmlhYmxlIGlzIHRoZSBpbW11dGFibGUgaXRlbXMgY29sbGVjdGlvbi5cbi8vIEJ1dCBhcHBzIHN0b3JlL3JldHJpZXZlIGluZGl2aWR1YWwgaXRlbXMgdGhyb3VnaCB0aGUgbWFpbiBjb2xsZWN0aW9uLCBhbmQgdGhlIGNvcnJlc3BvbmRpbmcgdXBkYXRlcyBhcmUgdGhyb3VnaCB0aGUgdmVyc2lvbnMsIHdoaWNoIGlzIGEgYml0IGF3a3dhcmQuXG5cbi8vIEVhY2ggaXRlbSBoYXMgYW4gYW50ZWNlZGVudCB0aGF0IGlzIG5vdCBwYXJ0IG9mIHRoZSBhcHBsaWNhdGlvbi1zdXBwbGllZCBwYXlsb2FkIC0tIGl0IGxpdmVzIGluIHRoZSBzaWduYXR1cmUncyBoZWFkZXIuXG4vLyBIb3dldmVyOlxuLy8gLSBUaGUgdGFnIERPRVMgaW5jbHVkZSB0aGUgYW50ZWNlZGVudCwgZXZlbiB0aG91Z2ggaXQgaXMgbm90IHBhcnQgb2YgdGhlIHBheWxvYWQuIFRoaXMgbWFrZXMgaWRlbnRpY2FsIHBheWxvYWRzIGhhdmVcbi8vICAgdW5pcXVlIHRhZ3MgKGJlY2F1c2UgdGhleSB3aWxsIGFsd2F5cyBoYXZlIGRpZmZlcmVudCBhbnRlY2VkZW50cykuXG4vLyAtIFRoZSBhYmlsaXR5IHRvIHdyaXRlIGZvbGxvd3MgdGhlIHNhbWUgcnVsZXMgYXMgTXV0YWJsZUNvbGxlY3Rpb24gKGxhdGVzdCB3aW5zKSwgYnV0IGlzIHRlc3RlZCBhZ2FpbnN0IHRoZVxuLy8gICBhbnRlY2VkZW50IHRhZyBpbnN0ZWFkIG9mIHRoZSB0YWcgYmVpbmcgd3JpdHRlbi5cbmV4cG9ydCBjbGFzcyBWZXJzaW9uQ29sbGVjdGlvbiBleHRlbmRzIE11dGFibGVDb2xsZWN0aW9uIHsgLy8gTmVlZHMgdG8gYmUgZXhwb3J0ZWQgc28gdGhhdCB0aGF0IHJvdXRlci5tanMgY2FuIGZpbmQgaXQuXG4gIGFzeW5jIHRhZ0ZvcldyaXRpbmcodGFnLCB2YWxpZGF0aW9uKSB7IC8vIFVzZSB0YWcgaWYgc3BlY2lmaWVkIChlLmcuLCBwdXQvZGVsZXRlIGR1cmluZyBzeW5jaHJvbml6YXRpb24pLCBvdGh3ZXJ3aXNlIHJlZmxlY3QgYm90aCBzdWIgYW5kIGFudGVjZWRlbnQuXG4gICAgaWYgKHRhZykgcmV0dXJuIHRhZztcbiAgICAvLyBFYWNoIHZlcnNpb24gZ2V0cyBhIHVuaXF1ZSB0YWcgKGV2ZW4gaWYgdGhlcmUgYXJlIHR3byB2ZXJzaW9ucyB0aGF0IGhhdmUgdGhlIHNhbWUgZGF0YSBwYXlsb2FkKS5cbiAgICBjb25zdCBhbnQgPSB2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5hbnQ7XG4gICAgY29uc3QgcGF5bG9hZFRleHQgPSB2YWxpZGF0aW9uLnRleHQgfHwgbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHZhbGlkYXRpb24ucGF5bG9hZCk7XG4gICAgcmV0dXJuIENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChhd2FpdCBDcmVkZW50aWFscy5oYXNoVGV4dChhbnQgKyBwYXlsb2FkVGV4dCkpO1xuICB9XG4gIGFudGVjZWRlbnQodmFsaWRhdGlvbikgeyAvLyBSZXR1cm5zIHRoZSB0YWcgdGhhdCB2YWxpZGF0aW9uIGNvbXBhcmVzIGFnYWluc3QuIEUuZy4sIGRvIHRoZSBvd25lcnMgbWF0Y2g/XG4gICAgLy8gRm9yIG5vbi12ZXJzaW9uZWQgY29sbGVjdGlvbnMsIHdlIGNvbXBhcmUgYWdhaW5zdCB0aGUgZXhpc3RpbmcgZGF0YSBhdCB0aGUgc2FtZSB0YWcgYmVpbmcgd3JpdHRlbi5cbiAgICAvLyBGb3IgdmVyc2lvbmVkIGNvbGxlY3Rpb25zLCBpdCBpcyB3aGF0IGV4aXN0cyBhcyB0aGUgbGF0ZXN0IHZlcnNpb24gd2hlbiB0aGUgZGF0YSBpcyBzaWduZWQsIGFuZCB3aGljaCB0aGUgc2lnbmF0dXJlXG4gICAgLy8gcmVjb3JkcyBpbiB0aGUgc2lnbmF0dXJlLiAoRm9yIHRoZSB2ZXJ5IGZpcnN0IHZlcnNpb24sIHRoZSBzaWduYXR1cmUgd2lsbCBub3RlIHRoZSB0aW1lc3RhbXAgYXMgdGhlIGFudGVjZWNkZW50IHRhZyxcbiAgICAvLyAoc2VlIHRhZ0ZvcldyaXRpbmcpLCBidXQgZm9yIGNvbXBhcmluZyBhZ2FpbnN0LCB0aGlzIG1ldGhvZCBhbnN3ZXJzIGZhbHN5IGZvciB0aGUgZmlyc3QgaW4gdGhlIGNoYWluLlxuICAgIGNvbnN0IGhlYWRlciA9IHZhbGlkYXRpb24/LnByb3RlY3RlZEhlYWRlcjtcbiAgICBpZiAoIWhlYWRlcikgcmV0dXJuICcnO1xuICAgIGNvbnN0IGFudGVjZWRlbnQgPSBoZWFkZXIuYW50O1xuICAgIGlmICh0eXBlb2YoYW50ZWNlZGVudCkgPT09ICdudW1iZXInKSByZXR1cm4gJyc7IC8vIEEgdGltZXN0YW1wIGFzIGFudGVjZWRlbnQgaXMgdXNlZCB0byB0byBzdGFydCB0aGluZ3Mgb2ZmLiBObyB0cnVlIGFudGVjZWRlbnQuXG4gICAgcmV0dXJuIGFudGVjZWRlbnQ7XG4gIH1cbiAgYXN5bmMgc3ViamVjdE1hdGNoKHZlcmlmaWVkKSB7IC8vIEhlcmUgc3ViIHJlZmVycyB0byB0aGUgb3ZlcmFsbCBpdGVtIHRhZyB0aGF0IGVuY29tcGFzc2VzIGFsbCB2ZXJzaW9ucywgbm90IHRoZSBwYXlsb2FkIGhhc2guXG4gICAgcmV0dXJuIHRydWU7IC8vIFRPRE86IG1ha2Ugc3VyZSBpdCBtYXRjaGVzIHByZXZpb3VzP1xuICB9XG4gIGVtaXQodmVyaWZpZWQpIHsgLy8gc3ViamVjdFRhZyAoaS5lLiwgdGhlIHRhZyB3aXRoaW4gdGhlIGNvbGxlY3Rpb24gYXMgYSB3aG9sZSkgaXMgbm90IHRoZSB0YWcvaGFzaC5cbiAgICB2ZXJpZmllZC5zdWJqZWN0VGFnID0gdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgICBzdXBlci5lbWl0KHZlcmlmaWVkKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbiBleHRlbmRzIE11dGFibGVDb2xsZWN0aW9uIHtcbiAgLy8gVE9ETzogVGhpcyB3b3JrcyBhbmQgZGVtb25zdHJhdGVzIGhhdmluZyBhIGNvbGxlY3Rpb24gdXNpbmcgb3RoZXIgY29sbGVjdGlvbnMuXG4gIC8vIEhvd2V2ZXIsIGhhdmluZyBhIGJpZyB0aW1lc3RhbXAgPT4gZml4bnVtIG1hcCBpcyBiYWQgZm9yIHBlcmZvcm1hbmNlIGFzIHRoZSBoaXN0b3J5IGdldHMgbG9uZ2VyLlxuICAvLyBUaGlzIHNob3VsZCBiZSBzcGxpdCB1cCBpbnRvIHdoYXQgaXMgZGVzY3JpYmVkIGluIHZlcnNpb25lZC5tZC5cbiAgY29uc3RydWN0b3Ioe3NlcnZpY2VzID0gW10sIC4uLnJlc3R9ID0ge30pIHtcbiAgICBzdXBlcihyZXN0KTsgIC8vIFdpdGhvdXQgcGFzc2luZyBzZXJ2aWNlcyB5ZXQsIGFzIHdlIGRvbid0IGhhdmUgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24gc2V0IHVwIHlldC5cbiAgICB0aGlzLnZlcnNpb25zID0gbmV3IFZlcnNpb25Db2xsZWN0aW9uKHJlc3QpOyAvLyBTYW1lIGNvbGxlY3Rpb24gbmFtZSwgYnV0IGRpZmZlcmVudCB0eXBlLlxuICAgIC8vZml4bWUgdGhpcy52ZXJzaW9ucy5hZGRFdmVudExpc3RlbmVyKCd1cGRhdGUnLCBldmVudCA9PiB0aGlzLmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KCd1cGRhdGUnLCB7ZGV0YWlsOiB0aGlzLnJlY292ZXJUYWcoZXZlbnQuZGV0YWlsKX0pKSk7XG4gICAgdGhpcy5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7IC8vIE5vdyB3ZSBjYW4gc3luY2hyb25pemUuXG4gIH1cbiAgYXN5bmMgY2xvc2UoKSB7XG4gICAgYXdhaXQgdGhpcy52ZXJzaW9ucy5jbG9zZSgpO1xuICAgIGF3YWl0IHN1cGVyLmNsb3NlKCk7XG4gIH1cbiAgYXN5bmMgZGVzdHJveSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmRlc3Ryb3koKTtcbiAgICBhd2FpdCBzdXBlci5kZXN0cm95KCk7XG4gIH1cbiAgcmVjb3ZlclRhZyh2ZXJpZmllZCkgeyAvLyB0aGUgdmVyaWZpZWQudGFnIGlzIGZvciB0aGUgdmVyc2lvbi4gV2Ugd2FudCB0aGUgb3ZlcmFsbCBvbmUuXG4gICAgcmV0dXJuIE9iamVjdC5hc3NpZ24oe30sIHZlcmlmaWVkLCB7dGFnOiB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3VifSk7IC8vIERvIG5vdCBiYXNoIHZlcmlmaWVkIVxuICB9XG4gIHNlcnZpY2VGb3JWZXJzaW9uKHNlcnZpY2UpIHsgLy8gR2V0IHRoZSBzZXJ2aWNlIFwibmFtZVwiIGZvciBvdXIgdmVyc2lvbnMgY29sbGVjdGlvbi5cbiAgICByZXR1cm4gc2VydmljZT8udmVyc2lvbnMgfHwgc2VydmljZTsgICAvLyBGb3IgdGhlIHdlaXJkIGNvbm5lY3REaXJlY3RUZXN0aW5nIGNhc2UgdXNlZCBpbiByZWdyZXNzaW9uIHRlc3RzLCBlbHNlIHRoZSBzZXJ2aWNlIChlLmcuLCBhbiBhcnJheSBvZiBzaWduYWxzKS5cbiAgfVxuICBzZXJ2aWNlc0ZvclZlcnNpb24oc2VydmljZXMpIHtcbiAgICByZXR1cm4gc2VydmljZXMubWFwKHNlcnZpY2UgPT4gdGhpcy5zZXJ2aWNlRm9yVmVyc2lvbihzZXJ2aWNlKSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemUoLi4uc2VydmljZXMpIHsgLy8gc3luY2hyb25pemUgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24sIHRvby5cbiAgICBpZiAoIXNlcnZpY2VzLmxlbmd0aCkgcmV0dXJuO1xuICAgIC8vIEtlZXAgY2hhbm5lbCBjcmVhdGlvbiBzeW5jaHJvbm91cy5cbiAgICBjb25zdCB2ZXJzaW9uZWRQcm9taXNlID0gc3VwZXIuc3luY2hyb25pemUoLi4uc2VydmljZXMpO1xuICAgIGNvbnN0IHZlcnNpb25Qcm9taXNlID0gdGhpcy52ZXJzaW9ucy5zeW5jaHJvbml6ZSguLi50aGlzLnNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykpO1xuICAgIGF3YWl0IHZlcnNpb25lZFByb21pc2U7XG4gICAgYXdhaXQgdmVyc2lvblByb21pc2U7XG4gIH1cbiAgYXN5bmMgZGlzY29ubmVjdCguLi5zZXJ2aWNlcykgeyAvLyBkaXNjb25uZWN0IHRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uLCB0b28uXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHNlcnZpY2VzID0gdGhpcy5zZXJ2aWNlcztcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmRpc2Nvbm5lY3QoLi4udGhpcy5zZXJ2aWNlc0ZvclZlcnNpb24oc2VydmljZXMpKTtcbiAgICBhd2FpdCBzdXBlci5kaXNjb25uZWN0KC4uLnNlcnZpY2VzKTtcbiAgfVxuICBnZXQgc3luY2hyb25pemVkKCkgeyAvLyBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBzeW5jaHJvbml6YXRpb24gaXMgY29tcGxldGUgaW4gQk9USCBkaXJlY3Rpb25zLlxuICAgIC8vIFRPRE8/IFRoaXMgZG9lcyBub3QgcmVmbGVjdCBjaGFuZ2VzIGFzIFN5bmNocm9uaXplcnMgYXJlIGFkZGVkIG9yIHJlbW92ZWQgc2luY2UgY2FsbGVkLiBTaG91bGQgaXQ/XG4gICAgcmV0dXJuIHN1cGVyLnN5bmNocm9uaXplZC50aGVuKCgpID0+IHRoaXMudmVyc2lvbnMuc3luY2hyb25pemVkKTtcbiAgfVxuICBnZXQgaXRlbUVtaXR0ZXIoKSB7IC8vIFRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uIGVtaXRzIGFuIHVwZGF0ZSBjb3JyZXNwb25kaW5nIHRvIHRoZSBpbmRpdmlkdWFsIGl0ZW0gc3RvcmVkLlxuICAgIC8vIChUaGUgdXBkYXRlcyBlbWl0dGVkIGZyb20gdGhlIHdob2xlIG11dGFibGUgVmVyc2lvbmVkQ29sbGVjdGlvbiBjb3JyZXNwb25kIHRvIHRoZSBtYXAuKVxuICAgIHJldHVybiB0aGlzLnZlcnNpb25zO1xuICB9XG5cbiAgYXN5bmMgZ2V0VmVyc2lvbnModGFnKSB7IC8vIFByb21pc2VzIHRoZSBwYXJzZWQgdGltZXN0YW1wID0+IHZlcnNpb24gZGljdGlvbmFyeSBJRiBpdCBleGlzdHMsIGVsc2UgZmFsc3kuXG4gICAgdGhpcy5yZXF1aXJlVGFnKHRhZyk7XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWd9KTtcbiAgICBjb25zdCBqc29uID0gdmVyaWZpZWQ/Lmpzb247XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGpzb24pKSByZXR1cm4ganNvbjtcbiAgICAvLyBJZiB3ZSBoYXZlIGFuIHVubWVyZ2VkIGFycmF5IG9mIHNpZ25hdHVyZXMuLi5cbiAgICAvLyBJJ20gbm90IHN1cmUgdGhhdCBpdCdzIHZlcnkgdXNlZnVsIHRvIGFwcGxpY2F0aW9ucyBmb3IgdXMgdG8gaGFuZGxlIHRoaXMgY2FzZSwgYnV0IGl0IGlzIG5pY2UgdG8gZXhlcmNpc2UgdGhpcyBpbiB0ZXN0aW5nLlxuICAgIGNvbnN0IHZlcmlmaWNhdGlvbnNBcnJheSA9IGF3YWl0IHRoaXMuZW5zdXJlRXhwYW5kZWQodmVyaWZpZWQpO1xuICAgIHJldHVybiB0aGlzLmNvbWJpbmVUaW1lc3RhbXBzKHRhZywgbnVsbCwgLi4udmVyaWZpY2F0aW9uc0FycmF5Lm1hcCh2ID0+IHYuanNvbikpO1xuICB9XG4gIGFzeW5jIHJldHJpZXZlVGltZXN0YW1wcyh0YWcpIHsgLy8gUHJvbWlzZXMgYSBsaXN0IG9mIGFsbCB2ZXJzaW9uIHRpbWVzdGFtcHMuXG4gICAgY29uc3QgdmVyc2lvbnMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgaWYgKCF2ZXJzaW9ucykgcmV0dXJuIHZlcnNpb25zO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh2ZXJzaW9ucykuc2xpY2UoMSkubWFwKHN0cmluZyA9PiBwYXJzZUludChzdHJpbmcpKTsgLy8gVE9ETz8gTWFwIHRoZXNlIHRvIGludGVnZXJzP1xuICB9XG4gIGdldEFjdGl2ZUhhc2godGltZXN0YW1wcywgdGltZSA9IHRpbWVzdGFtcHMubGF0ZXN0KSB7IC8vIFByb21pc2VzIHRoZSB2ZXJzaW9uIHRhZyB0aGF0IHdhcyBpbiBmb3JjZSBhdCB0aGUgc3BlY2lmaWVkIHRpbWVcbiAgICAvLyAod2hpY2ggbWF5IGJlZm9yZSwgaW4gYmV0d2Vlbiwgb3IgYWZ0ZXIgdGhlIHJlY29yZGVkIGRpc2NyZXRlIHRpbWVzdGFtcHMpLlxuICAgIGlmICghdGltZXN0YW1wcykgcmV0dXJuIHRpbWVzdGFtcHM7XG4gICAgbGV0IGhhc2ggPSB0aW1lc3RhbXBzW3RpbWVdO1xuICAgIGlmIChoYXNoKSByZXR1cm4gaGFzaDtcbiAgICAvLyBXZSBuZWVkIHRvIGZpbmQgdGhlIHRpbWVzdGFtcCB0aGF0IHdhcyBpbiBmb3JjZSBhdCB0aGUgcmVxdWVzdGVkIHRpbWUuXG4gICAgbGV0IGJlc3QgPSAwLCB0aW1lcyA9IE9iamVjdC5rZXlzKHRpbWVzdGFtcHMpO1xuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgdGltZXMubGVuZ3RoOyBpKyspIHsgLy8gMHRoIGlzIHRoZSBrZXkgJ2xhdGVzdCcuXG4gICAgICBpZiAodGltZXNbaV0gPD0gdGltZSkgYmVzdCA9IHRpbWVzW2ldO1xuICAgICAgZWxzZSBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIHRpbWVzdGFtcHNbYmVzdF07XG4gIH1cbiAgYXN5bmMgcmV0cmlldmUodGFnT3JPcHRpb25zKSB7IC8vIEFuc3dlciB0aGUgdmFsaWRhdGVkIHZlcnNpb24gaW4gZm9yY2UgYXQgdGhlIHNwZWNpZmllZCB0aW1lIChvciBsYXRlc3QpLCBvciBhdCB0aGUgc3BlY2lmaWMgaGFzaC5cbiAgICBsZXQge3RhZywgdGltZSwgaGFzaCwgLi4ucmVzdH0gPSAoIXRhZ09yT3B0aW9ucyB8fCB0YWdPck9wdGlvbnMubGVuZ3RoKSA/IHt0YWc6IHRhZ09yT3B0aW9uc30gOiB0YWdPck9wdGlvbnM7XG4gICAgaWYgKCFoYXNoKSB7XG4gICAgICBjb25zdCB0aW1lc3RhbXBzID0gYXdhaXQgdGhpcy5nZXRWZXJzaW9ucyh0YWcpO1xuICAgICAgaWYgKCF0aW1lc3RhbXBzKSByZXR1cm4gdGltZXN0YW1wcztcbiAgICAgIGhhc2ggPSB0aGlzLmdldEFjdGl2ZUhhc2godGltZXN0YW1wcywgdGltZSk7XG4gICAgICBpZiAoIWhhc2gpIHJldHVybiAnJztcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMudmVyc2lvbnMucmV0cmlldmUoe3RhZzogaGFzaCwgLi4ucmVzdH0pO1xuICB9XG4gIGFzeW5jIHN0b3JlKGRhdGEsIG9wdGlvbnMgPSB7fSkgeyAvLyBEZXRlcm1pbmUgdGhlIGFudGVjZWRlbnQsIHJlY29yZCBpdCBpbiB0aGUgc2lnbmF0dXJlLCBhbmQgc3RvcmUgdGhhdFxuICAgIC8vIGFzIHRoZSBhcHByb3ByaWF0ZSB2ZXJzaW9uIGhhc2guIFRoZW4gcmVjb3JkIHRoZSBuZXcgdGltZXN0YW1wL2hhc2ggaW4gdGhlIHRpbWVzdGFtcHMgbGlzdC5cbiAgICBsZXQgdmVyc2lvbnMsXG5cdC8vIFRPRE86IENvbnNpZGVyIGVuY3J5cHRpbmcgdGhlIHRpbWVzdGFtcHMsIHRvby5cblx0Ly8gQ3VycmVudGx5LCBzaWduaW5nT3B0aW9ucyBmb3IgdGhlIHRpbWVzdGFtcHMgZG9lcyBOT1QgZW5jbHVkZSBlbmNyeXB0aW9uLCBldmVuIGlmIHNwZWNpZmllZCBmb3IgdGhlIGFjdHVhbCBzcGVjaWZpYyB2ZXJzaW9uIGluZm8uXG5cdC8vIFRoaXMgbWVhbnMgdGhhdCBpZiB0aGUgYXBwbGljYXRpb24gc3BlY2lmaWVzIGFuIGVuY3J5cHRlZCB2ZXJzaW9uZWQgY29sbGVjdGlvbiwgdGhlIGRhdGEgaXRzZWxmIHdpbGwgYmUgZW5jcnlwdGVkLCBidXRcblx0Ly8gbm90IHRoZSBtYXAgb2YgdGltZXN0YW1wcyB0byBoYXNoZXMsIGFuZCBzbyBhIGx1cmtlciBjYW4gc2VlIHdoZW4gdGhlcmUgd2FzIGFjdGl2aXRpdHkgYW5kIGhhdmUgYW4gaWRlYSBhcyB0byB0aGUgc2l6ZS5cblx0Ly8gT2YgY291cnNlLCBldmVuIGlmIGVuY3J5cHRlZCwgdGhleSBjb3VsZCBhbHNvIGdldCB0aGlzIGZyb20gbGl2ZSB0cmFmZmljIGFuYWx5c2lzLCBzbyBtYXliZSBlbmNyeXB0aW5nIGl0IHdvdWxkIGp1c3Rcblx0Ly8gY29udmV5IGEgZmFsc2Ugc2Vuc2Ugb2Ygc2VjdXJpdHkuIEVuY3J5cHRpbmcgdGhlIHRpbWVzdGFtcHMgZG9lcyBjb21wbGljYXRlLCBlLmcuLCBtZXJnZVNpZ25hdHVyZXMoKSBiZWNhdXNlXG5cdC8vIHNvbWUgb2YgdGhlIHdvcmsgY291bGQgb25seSBiZSBkb25lIGJ5IHJlbGF5cyB0aGF0IGhhdmUgYWNjZXNzLiBCdXQgc2luY2Ugd2UgaGF2ZSB0byBiZSBjYXJlZnVsIGFib3V0IHNpZ25pbmcgYW55d2F5LFxuXHQvLyB3ZSBzaG91bGQgdGhlb3JldGljYWxseSBiZSBhYmxlIHRvIGJlIGFjY29tb2RhdGUgdGhhdC5cblx0e3RhZywgZW5jcnlwdGlvbiwgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKSxcblx0dGltZSA9IERhdGUubm93KCksXG5cdHZlcnNpb25PcHRpb25zID0gT2JqZWN0LmFzc2lnbih7dGltZSwgZW5jcnlwdGlvbn0sIHNpZ25pbmdPcHRpb25zKTtcbiAgICBpZiAodGFnKSB7XG4gICAgICB2ZXJzaW9ucyA9IChhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZykpIHx8IHt9O1xuICAgICAgdmVyc2lvbk9wdGlvbnMuc3ViID0gdGFnO1xuICAgICAgaWYgKHZlcnNpb25zKSB7XG5cdHZlcnNpb25PcHRpb25zLmFudCA9IHZlcnNpb25zW3ZlcnNpb25zLmxhdGVzdF07XG4gICAgICB9XG4gICAgfSAvLyBFbHNlIGRvIG5vdCBhc3NpZ24gc3ViLiBJdCB3aWxsIGJlIHNldCB0byB0aGUgcGF5bG9hZCBoYXNoIGR1cmluZyBzaWduaW5nLCBhbmQgYWxzbyB1c2VkIGZvciB0aGUgb3ZlcmFsbCB0YWcuXG4gICAgdmVyc2lvbk9wdGlvbnMuYW50IHx8PSB0aW1lO1xuICAgIGNvbnN0IGhhc2ggPSBhd2FpdCB0aGlzLnZlcnNpb25zLnN0b3JlKGRhdGEsIHZlcnNpb25PcHRpb25zKTtcbiAgICBpZiAoIXRhZykgeyAvLyBXZSdsbCBzdGlsbCBuZWVkIHRhZyBhbmQgdmVyc2lvbnMuXG4gICAgICBjb25zdCB2ZXJzaW9uU2lnbmF0dXJlID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5nZXQoaGFzaCk7XG4gICAgICBjb25zdCBjbGFpbXMgPSBDcmVkZW50aWFscy5kZWNvZGVDbGFpbXModGhpcy5jb25zdHJ1Y3Rvci5tYXliZUluZmxhdGUodmVyc2lvblNpZ25hdHVyZSkpO1xuICAgICAgdGFnID0gY2xhaW1zLnN1YjtcbiAgICAgIHZlcnNpb25zID0ge307XG4gICAgfVxuICAgIHZlcnNpb25zLmxhdGVzdCA9IHRpbWU7XG4gICAgdmVyc2lvbnNbdGltZV0gPSBoYXNoO1xuXG4gICAgLy8gZml4bWUgbmV4dFxuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbih2ZXJzaW9ucywgc2lnbmluZ09wdGlvbnMpO1xuICAgIC8vIEhlcmUgd2UgYXJlIGRvaW5nIHdoYXQgdGhpcy5wdXQoKSB3b3VsZCBub3JtYWxseSBkbywgYnV0IHdlIGhhdmUgYWxyZWFkeSBtZXJnZWQgc2lnbmF0dXJlcy5cbiAgICBhd2FpdCB0aGlzLmFkZFRhZyh0YWcpO1xuICAgIGF3YWl0IHRoaXMucGVyc2lzdCh0YWcsIHNpZ25hdHVyZSk7XG4gICAgdGhpcy5lbWl0KHt0YWcsIHN1YmplY3RUYWc6IHRhZywgLi4uKGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSkpfSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgLy8gY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmaWVkU2lnbih2ZXJzaW9ucywgc2lnbmluZ09wdGlvbnMsIHRhZyk7XG4gICAgLy8gdGhpcy5sb2coJ3B1dCgtaXNoKScsIHZlcmlmaWVkKTtcbiAgICAvLyBhd2FpdCB0aGlzLnBlcnNpc3QyKHZlcmlmaWVkKTtcbiAgICAvLyBhd2FpdCB0aGlzLmFkZFRhZyh0YWcpO1xuICAgIC8vIHRoaXMuZW1pdCh7Li4udmVyaWZpZWQsIHRhZywgc3ViamVjdFRhZzogdGFnfSk7XG4gICAgLy8gYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZlcmlmaWVkLnNpZ25hdHVyZSkpO1xuXG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZW1vdmUob3B0aW9ucyA9IHt9KSB7IC8vIEFkZCBhbiBlbXB0eSB2ZXJpb24gb3IgcmVtb3ZlIGFsbCB2ZXJzaW9ucywgZGVwZW5kaW5nIG9uIHRoaXMucHJlc2VydmVEZWxldGlvbnMuXG4gICAgbGV0IHtlbmNyeXB0aW9uLCB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7IC8vIElnbm9yZSBlbmNyeXB0aW9uXG4gICAgY29uc3QgdmVyc2lvbnMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgaWYgKCF2ZXJzaW9ucykgcmV0dXJuIHZlcnNpb25zO1xuICAgIGlmICh0aGlzLnByZXNlcnZlRGVsZXRpb25zKSB7IC8vIENyZWF0ZSBhIHRpbWVzdGFtcCA9PiB2ZXJzaW9uIHdpdGggYW4gZW1wdHkgcGF5bG9hZC4gT3RoZXJ3aXNlIG1lcmdpbmcgd2l0aCBlYXJsaWVyIGRhdGEgd2lsbCBicmluZyBpdCBiYWNrIVxuICAgICAgYXdhaXQgdGhpcy5zdG9yZSgnJywgc2lnbmluZ09wdGlvbnMpO1xuICAgIH0gZWxzZSB7IC8vIEFjdHVhbGx5IGRlbGV0ZSB0aGUgdGltZXN0YW1wcyBhbmQgZWFjaCB2ZXJzaW9uLlxuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgY29uc3QgdmVyc2lvblRhZ3MgPSBPYmplY3QudmFsdWVzKHZlcnNpb25zKS5zbGljZSgxKTtcbiAgICAgIGNvbnN0IHZlcnNpb25TaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oJycsIHtzdWI6IHRhZywgLi4uc2lnbmluZ09wdGlvbnN9KTtcbiAgICAgIC8vIFRPRE86IElzIHRoaXMgc2FmZT8gU2hvdWxkIHdlIG1ha2UgYSBzaWduYXR1cmUgdGhhdCBzcGVjaWZpZXMgZWFjaCBhbnRlY2VkZW50P1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwodmVyc2lvblRhZ3MubWFwKGFzeW5jIHRhZyA9PiB7XG5cdGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlKHRhZywgdmVyc2lvblNpZ25hdHVyZSk7XG5cdGF3YWl0IHRoaXMudmVyc2lvbnMucHVzaCgnZGVsZXRlJywgdGFnLCB2ZXJzaW9uU2lnbmF0dXJlKTtcbiAgICAgIH0pKTtcbiAgICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbignJywgc2lnbmluZ09wdGlvbnMpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0KHRhZywgc2lnbmF0dXJlLCAnZGVsZXRlJyk7XG4gICAgICBhd2FpdCB0aGlzLnB1c2goJ2RlbGV0ZScsIHRhZywgc2lnbmF0dXJlKTtcbiAgICAgIC8vIGNvbnN0IHZlcnNpb25IYXNoZXMgPSBPYmplY3QudmFsdWVzKHZlcnNpb25zKS5zbGljZSgxKTtcbiAgICAgIC8vIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZmllZFNpZ24oJycsIHtzdWI6IHRhZywgLi4uc2lnbmluZ09wdGlvbnN9LCB0YWcpO1xuICAgICAgLy8gLy8gVE9ETzogSXMgdGhpcyBzYWZlPyBTaG91bGQgd2UgbWFrZSBhIHNpZ25hdHVyZSB0aGF0IHNwZWNpZmllcyBlYWNoIGFudGVjZWRlbnQ/XG4gICAgICAvLyBhd2FpdCBQcm9taXNlLmFsbCh2ZXJzaW9uSGFzaGVzLm1hcChhc3luYyBoYXNoID0+IHtcbiAgICAgIC8vIFx0bGV0IHZWZXJpZmllZCA9IHsuLi52ZXJpZmllZCwgdGFnOiBoYXNofTtcbiAgICAgIC8vIFx0bGV0IHNWZXJpZmllZCA9IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZWZXJpZmllZC5zaWduYXR1cmUpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLmRlbGV0ZVRhZyh0YWcpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLnBlcnNpc3QyKHZWZXJpZmllZCwgJ2RlbGV0ZScpO1xuICAgICAgLy8gXHQvLyB0aGlzLnZlcnNpb25zLmVtaXQodlZlcmlmaWVkKTtcbiAgICAgIC8vIFx0Ly8gYXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHNWZXJpZmllZCk7XG4gICAgICAvLyBcdGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlKHRhZywgc1ZlcmlmaWVkKTtcbiAgICAgIC8vIFx0YXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHNWZXJpZmllZClcbiAgICAgIC8vIH0pKTtcbiAgICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIodmVyaWZpZWQsICdkZWxldGUnKTtcbiAgICAgIC8vIGF3YWl0IHRoaXMucHVzaCgnZGVsZXRlJywgdGFnLCB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZVN0cmluZyh2ZXJpZmllZC5zaWduYXR1cmUpKTtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIG1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSwgYXV0aG9yT3ZlcnJpZGUgPSBudWxsKSB7IC8vIE1lcmdlIHRoZSBuZXcgdGltZXN0YW1wcyB3aXRoIHRoZSBvbGQuXG4gICAgLy8gSWYgcHJldmlvdXMgZG9lc24ndCBleGlzdCBvciBtYXRjaGVzIHRoZSBuZXh0LCBvciBpcyBhIHN1YnNldCBvZiB0aGUgbmV4dCwganVzdCB1c2UgdGhlIG5leHQuXG4gICAgLy8gT3RoZXJ3aXNlLCB3ZSBoYXZlIHRvIG1lcmdlOlxuICAgIC8vIC0gTWVyZ2VkIG11c3QgY29udGFpbiB0aGUgdW5pb24gb2YgdmFsdWVzIGZvciBlaXRoZXIuXG4gICAgLy8gICAoU2luY2UgdmFsdWVzIGFyZSBoYXNoZXMgb2Ygc3R1ZmYgd2l0aCBhbiBleHBsaWNpdCBhbnRlZGVudCwgbmV4dCBwcmV2aW91cyBub3IgbmV4dCB3aWxsIGhhdmUgZHVwbGljYXRlcyBieSB0aGVtc2VsdmVzLi4pXG4gICAgLy8gLSBJZiB0aGVyZSdzIGEgY29uZmxpY3QgaW4ga2V5cywgY3JlYXRlIGEgbmV3IGtleSB0aGF0IGlzIG1pZHdheSBiZXR3ZWVuIHRoZSBjb25mbGljdCBhbmQgdGhlIG5leHQga2V5IGluIG9yZGVyLlxuXG4gICAgbGV0IG5leHQgPSB2YWxpZGF0aW9uO1xuICAgIGxldCBwcmV2aW91cyA9IHZhbGlkYXRpb24uZXhpc3Rpbmc7XG4gICAgLy9maXhtZSBuZXh0XG4gICAgaWYgKCFwcmV2aW91cykgcmV0dXJuIHNpZ25hdHVyZTsgICAvLyBObyBwcmV2aW91cywganVzdCB1c2UgbmV3IHNpZ25hdHVyZS5cbiAgICAvL2lmICghcHJldmlvdXMpIHJldHVybiBuZXh0OyAgIC8vIE5vIHByZXZpb3VzLCBqdXN0IG5leHQuXG5cbiAgICAvLyBBdCB0aGlzIHBvaW50LCBwcmV2aW91cyBhbmQgbmV4dCBhcmUgYm90aCBcIm91dGVyXCIgdmFsaWRhdGlvbnMuXG4gICAgLy8gVGhhdCBqc29uIGNhbiBiZSBlaXRoZXIgYSB0aW1lc3RhbXAgb3IgYW4gYXJyYXkgb2Ygc2lnbmF0dXJlcy5cbiAgICBpZiAodmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIuaWF0IDwgdmFsaWRhdGlvbi5leGlzdGluZy5wcm90ZWN0ZWRIZWFkZXIuaWF0KSB7IC8vIEFycmFuZ2UgZm9yIG5leHQgYW5kIHNpZ25hdHVyZSB0byBiZSBsYXRlciBvbmUgYnkgc2lnbmVkIHRpbWVzdGFtcC5cbiAgICAgIC8vIFRPRE86IGlzIGl0IHBvc3NpYmxlIHRvIGNvbnN0cnVjdCBhIHNjZW5hcmlvIGluIHdoaWNoIHRoZXJlIGlzIGEgZmljdGl0aW91cyB0aW1lIHN0YW1wIGNvbmZsaWN0LiBFLmcsIGlmIGFsbCBvZiB0aGVzZSBhcmUgdHJ1ZTpcbiAgICAgIC8vIDEuIHByZXZpb3VzIGFuZCBuZXh0IGhhdmUgaWRlbnRpY2FsIHRpbWVzdGFtcHMgZm9yIGRpZmZlcmVudCB2YWx1ZXMsIGFuZCBzbyB3ZSBuZWVkIHRvIGNvbnN0cnVjdCBhcnRpZmljaWFsIHRpbWVzIGZvciBvbmUuIExldCdzIGNhbGwgdGhlc2UgYnJhbmNoIEEgYW5kIEIuXG4gICAgICAvLyAyLiB0aGlzIGhhcHBlbnMgd2l0aCB0aGUgc2FtZSB0aW1lc3RhbXAgaW4gYSBzZXBhcmF0ZSBwYWlyLCB3aGljaCB3ZSdsbCBjYWxsIEEyLCBhbmQgQjIuXG4gICAgICAvLyAzLiBBIGFuZCBCIGFyZSBtZXJnZWQgaW4gdGhhdCBvcmRlciAoZS5nLiB0aGUgbGFzdCB0aW1lIGluIEEgaXMgbGVzcyB0aGFuIEIpLCBidXQgQTIgYW5kIEIyIGFyZSBtZXJnZWQgYmFja3dhcmRzIChlLmcuLCB0aGUgbGFzdCB0aW1lIGluIEIyIGlzIGxlc3MgdGhhbnQgQTIpLFxuICAgICAgLy8gICAgc3VjaCB0aGF0IHRoZSBvdmVyYWxsIG1lcmdlIGNyZWF0ZXMgYSBjb25mbGljdD9cbiAgICAgIFtwcmV2aW91cywgbmV4dF0gPSBbbmV4dCwgcHJldmlvdXNdO1xuICAgIH1cblxuICAgIC8vIEZpbmQgdGhlIHRpbWVzdGFtcHMgb2YgcHJldmlvdXMgd2hvc2UgVkFMVUVTIHRoYXQgYXJlIG5vdCBpbiBuZXh0LlxuICAgIGxldCBrZXlzT2ZNaXNzaW5nID0gbnVsbDtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocHJldmlvdXMuanNvbikgJiYgIUFycmF5LmlzQXJyYXkobmV4dC5qc29uKSkgeyAvLyBObyBwb2ludCBpbiBvcHRpbWl6aW5nIHRocm91Z2ggbWlzc2luZ0tleXMgaWYgdGhhdCBtYWtlcyB1cyBjb21iaW5lVGltZXN0YW1wcyBhbnl3YXkuXG4gICAgICBrZXlzT2ZNaXNzaW5nID0gdGhpcy5taXNzaW5nS2V5cyhwcmV2aW91cy5qc29uLCBuZXh0Lmpzb24pO1xuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgaWYgKCFrZXlzT2ZNaXNzaW5nLmxlbmd0aCkgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKG5leHQuc2lnbmF0dXJlKTsgLy8gUHJldmlvdXMgaXMgYSBzdWJzZXQgb2YgbmV3IHNpZ25hdHVyZS5cbiAgICAgIC8vaWYgKCFrZXlzT2ZNaXNzaW5nLmxlbmd0aCkgcmV0dXJuIG5leHQ7IC8vIFByZXZpb3VzIGlzIGEgc3Vic2V0IG9mIG5ldyBzaWduYXR1cmUuXG4gICAgfVxuICAgIC8vIFRPRE86IHJldHVybiBwcmV2aW91cyBpZiBuZXh0IGlzIGEgc3Vic2V0IG9mIGl0P1xuXG4gICAgLy8gV2UgY2Fubm90IHJlLXVzZSBvbmUgb3Igb3RoZXIuIFNpZ24gYSBuZXcgbWVyZ2VkIHJlc3VsdC5cbiAgICBjb25zdCBwcmV2aW91c1ZhbGlkYXRpb25zID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZChwcmV2aW91cyk7XG4gICAgY29uc3QgbmV4dFZhbGlkYXRpb25zID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZChuZXh0KTtcbiAgICBpZiAoIXByZXZpb3VzVmFsaWRhdGlvbnMubGVuZ3RoKSByZXR1cm4gc2lnbmF0dXJlO1xuICAgIC8vIFdlIGNhbiBvbmx5IHRydWx5IG1lcmdlIGlmIHdlIGFyZSBhbiBvd25lci5cbiAgICBjb25zdCBoZWFkZXIgPSBwcmV2aW91c1ZhbGlkYXRpb25zWzBdLnByb3RlY3RlZEhlYWRlcjtcbiAgICBsZXQgb3duZXIgPSBoZWFkZXIuaXNzIHx8IGhlYWRlci5raWQ7XG4gICAgbGV0IGlzT3duZXIgPSBbQ3JlZGVudGlhbHMub3duZXIsIENyZWRlbnRpYWxzLmF1dGhvciwgYXV0aG9yT3ZlcnJpZGVdLmluY2x1ZGVzKG93bmVyKTtcbiAgICAvLyBJZiB0aGVzZSBhcmUgbm90IHRoZSBvd25lciwgYW5kIHdlIHdlcmUgbm90IGdpdmVuIGEgc3BlY2lmaWMgb3ZlcnJpZGUsIHRoZW4gc2VlIGlmIHRoZSB1c2VyIGhhcyBhY2Nlc3MgdG8gdGhlIG93bmVyIGluIHRoaXMgZXhlY3V0aW9uIGNvbnRleHQuXG4gICAgbGV0IGNhblNpZ24gPSBpc093bmVyIHx8ICghYXV0aG9yT3ZlcnJpZGUgJiYgYXdhaXQgQ3JlZGVudGlhbHMuc2lnbignJywgb3duZXIpLmNhdGNoKCgpID0+IGZhbHNlKSk7XG4gICAgbGV0IG1lcmdlZCwgb3B0aW9ucywgdGltZSA9IERhdGUubm93KCk7XG4gICAgY29uc3QgYXV0aG9yID0gYXV0aG9yT3ZlcnJpZGUgfHwgQ3JlZGVudGlhbHMuYXV0aG9yO1xuICAgIGZ1bmN0aW9uIGZsYXR0ZW4oYSwgYikgeyByZXR1cm4gW10uY29uY2F0KGEsIGIpOyB9XG4gICAgaWYgKCFjYW5TaWduKSB7IC8vIFdlIGRvbid0IGhhdmUgb3duZXIgYW5kIGNhbm5vdCBnZXQgaXQuXG4gICAgICAvLyBDcmVhdGUgYSBzcGVjaWFsIG5vbi1zdGFuZGFyZCBcInNpZ25hdHVyZVwiIHRoYXQgaXMgcmVhbGx5IGFuIGFycmF5IG9mIHNpZ25hdHVyZXNcbiAgICAgIGZ1bmN0aW9uIGdldFNpZ25hdHVyZXModmFsaWRhdGlvbnMpIHsgcmV0dXJuIHZhbGlkYXRpb25zLm1hcCh2YWxpZGF0aW9uID0+IHZhbGlkYXRpb24uc2lnbmF0dXJlKTsgfVxuICAgICAgbWVyZ2VkID0gZmxhdHRlbihnZXRTaWduYXR1cmVzKHByZXZpb3VzVmFsaWRhdGlvbnMpLCBnZXRTaWduYXR1cmVzKG5leHRWYWxpZGF0aW9ucykpO1xuICAgICAgb3B0aW9ucyA9IHt0YWdzOiBbYXV0aG9yXSwgdGltZX07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZ1bmN0aW9uIGdldEpTT05zKHZhbGlkYXRpb25zKSB7IHJldHVybiB2YWxpZGF0aW9ucy5tYXAodmFsaWRhdGlvbiA9PiB2YWxpZGF0aW9uLmpzb24pOyB9XG4gICAgICBjb25zdCBmbGF0dGVuZWQgPSBmbGF0dGVuKGdldEpTT05zKHByZXZpb3VzVmFsaWRhdGlvbnMpLCBnZXRKU09OcyhuZXh0VmFsaWRhdGlvbnMpKTtcbiAgICAgIG1lcmdlZCA9IHRoaXMuY29tYmluZVRpbWVzdGFtcHMobmV4dC50YWcsIGtleXNPZk1pc3NpbmcsIC4uLmZsYXR0ZW5lZCk7XG4gICAgICBvcHRpb25zID0ge3RlYW06IG93bmVyLCBtZW1iZXI6IGF1dGhvciwgdGltZX07XG4gICAgfVxuICAgIC8vIGZpeG1lIG5leHRcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKG1lcmdlZCwgb3B0aW9ucyk7XG4gICAgLy9yZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZmllZFNpZ24obWVyZ2VkLCBvcHRpb25zKTtcbiAgfVxuICBlbnN1cmVFeHBhbmRlZCh2YWxpZGF0aW9uKSB7IC8vIFByb21pc2UgYW4gYXJyYXkgb2YgdmVyaWZpY2F0aW9ucyAodmVyaWZ5aW5nIGVsZW1lbnRzIG9mIHZhbGlkYXRpb24uanNvbiBpZiBuZWVkZWQpLlxuICAgIGlmICghdmFsaWRhdGlvbiB8fCAhdmFsaWRhdGlvbi5qc29uKSByZXR1cm4gW107XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbGlkYXRpb24uanNvbikpIHJldHVybiBbdmFsaWRhdGlvbl07XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHZhbGlkYXRpb24uanNvbi5tYXAoc2lnbmF0dXJlID0+IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSkpKVxuICAgICAgLnRoZW4oc2lnbmF0dXJlcyA9PiBzaWduYXR1cmVzLmZpbHRlcihzaWcgPT4gc2lnKSk7XG4gIH1cbiAgbWlzc2luZ0tleXMocHJldmlvdXNNYXBwaW5nLCBuZXh0TWFwcGluZ3MpIHsgLy8gQW5zd2VyIGEgbGlzdCBvZiB0aG9zZSBrZXlzIGZyb20gcHJldmlvdXMgdGhhdCBkbyBub3QgaGF2ZSB2YWx1ZXMgaW4gbmV4dC5cbiAgICBjb25zdCBuZXh0VmFsdWVzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5leHRNYXBwaW5ncykpO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyhwcmV2aW91c01hcHBpbmcpLmZpbHRlcihrZXkgPT4ga2V5ICE9PSAnbGF0ZXN0JyAmJiAhbmV4dFZhbHVlcy5oYXMocHJldmlvdXNNYXBwaW5nW2tleV0pKTtcbiAgfVxuICBjb21iaW5lVGltZXN0YW1wcyh0YWcsIGtleXNPZk1pc3NpbmcsIHByZXZpb3VzTWFwcGluZ3MsIG5leHRNYXBwaW5ncywgLi4ucmVzdCkgeyAvLyBSZXR1cm4gYSBtZXJnZWQgZGljdGlvbmFyeSBvZiB0aW1lc3RhbXAgPT4gaGFzaCwgY29udGFpbmluZyBhbGwgb2YgcHJldmlvdXMgYW5kIG5leHRNYXBwaW5ncy5cbiAgICAvLyBXZSdsbCBuZWVkIGEgbmV3IG9iamVjdCB0byBzdG9yZSB0aGUgdW5pb24sIGJlY2F1c2UgdGhlIGtleXMgbXVzdCBiZSBpbiB0aW1lIG9yZGVyLCBub3QgdGhlIG9yZGVyIHRoZXkgd2VyZSBhZGRlZC5cbiAgICBrZXlzT2ZNaXNzaW5nIHx8PSB0aGlzLm1pc3NpbmdLZXlzKHByZXZpb3VzTWFwcGluZ3MsIG5leHRNYXBwaW5ncyk7XG4gICAgY29uc3QgbWVyZ2VkID0ge307XG4gICAgbGV0IG1pc3NpbmdJbmRleCA9IDAsIG1pc3NpbmdUaW1lLCBuZXh0VGltZXM7XG4gICAgZm9yIChjb25zdCBuZXh0VGltZSBpbiBuZXh0TWFwcGluZ3MpIHtcbiAgICAgIG1pc3NpbmdUaW1lID0gMDtcblxuICAgICAgLy8gTWVyZ2UgYW55IHJlbWFpbmluZyBrZXlzT2ZNaXNzaW5nIHRoYXQgY29tZSBzdHJpY3RseSBiZWZvcmUgbmV4dFRpbWU6XG4gICAgICBpZiAobmV4dFRpbWUgIT09ICdsYXRlc3QnKSB7XG5cdGZvciAoOyAobWlzc2luZ0luZGV4IDwga2V5c09mTWlzc2luZy5sZW5ndGgpICYmICgobWlzc2luZ1RpbWUgPSBrZXlzT2ZNaXNzaW5nW21pc3NpbmdJbmRleF0pIDwgbmV4dFRpbWUpOyBtaXNzaW5nSW5kZXgrKykge1xuXHQgIG1lcmdlZFttaXNzaW5nVGltZV0gPSBwcmV2aW91c01hcHBpbmdzW21pc3NpbmdUaW1lXTtcblx0fVxuICAgICAgfVxuXG4gICAgICBpZiAobWlzc2luZ1RpbWUgPT09IG5leHRUaW1lKSB7IC8vIFR3byBkaWZmZXJlbnQgdmFsdWVzIGF0IHRoZSBleGFjdCBzYW1lIHRpbWUuIEV4dHJlbWVseSByYXJlLlxuXHRjb25zb2xlLndhcm4odGhpcy5mdWxsTGFiZWwsIGBVbnVzdWFsIG1hdGNoaW5nIHRpbWVzdGFtcCBjYXNlIGF0IHRpbWUgJHttaXNzaW5nVGltZX0gZm9yIHRhZyAke3RhZ30uYCk7XG5cdG5leHRUaW1lcyB8fD0gT2JqZWN0LmtleXMobmV4dE1hcHBpbmdzKTsgLy8gV2UgZGlkbid0IG5lZWQgdGhpcyBmb3Igb3VyIGxvb3AuIEdlbmVyYXRlIG5vdyBpZiBuZWVkZWQuXG5cdGNvbnN0IG5leHROZXh0VGltZSA9IE1hdGgubWluKGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4ICsgMV0gfHwgSW5maW5pdHksXG5cdFx0XHRcdCAgICAgIG5leHRNYXBwaW5nc1tuZXh0VGltZXMuaW5kZXhPZihuZXh0VGltZSkgKyAxXSB8fCBJbmZpbml0eSk7XG5cdGNvbnN0IGluc2VydFRpbWUgPSBuZXh0VGltZSArIChuZXh0TmV4dFRpbWUgLSBuZXh0VGltZSkgLyAyO1xuXHQvLyBXZSBhbHJlYWR5IHB1dCB0aGVzZSBpbiBvcmRlciB3aXRoIHByZXZpb3VzTWFwcGluZ3MgZmlyc3QuXG5cdG1lcmdlZFtuZXh0VGltZV0gPSBwcmV2aW91c01hcHBpbmdzW25leHRUaW1lXTtcblx0bWVyZ2VkW2luc2VydFRpbWVdID0gbmV4dE1hcHBpbmdzW25leHRUaW1lXTtcblxuICAgICAgfSBlbHNlIHsgLy8gTm8gY29uZmxpY3RzLiBKdXN0IGFkZCBuZXh0LlxuXHRtZXJnZWRbbmV4dFRpbWVdID0gbmV4dE1hcHBpbmdzW25leHRUaW1lXTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUaGVyZSBjYW4gYmUgbWlzc2luZyBzdHVmZiB0byBhZGQgYXQgdGhlIGVuZDtcbiAgICBmb3IgKDsgbWlzc2luZ0luZGV4IDwga2V5c09mTWlzc2luZy5sZW5ndGg7IG1pc3NpbmdJbmRleCsrKSB7XG4gICAgICBtaXNzaW5nVGltZSA9IGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4XTtcbiAgICAgIG1lcmdlZFttaXNzaW5nVGltZV0gPSBwcmV2aW91c01hcHBpbmdzW21pc3NpbmdUaW1lXTtcbiAgICB9XG4gICAgbGV0IG1lcmdlZFRpbWVzID0gT2JqZWN0LmtleXMobWVyZ2VkKTtcbiAgICBtZXJnZWQubGF0ZXN0ID0gbWVyZ2VkVGltZXNbbWVyZ2VkVGltZXMubGVuZ3RoIC0gMV07XG4gICAgcmV0dXJuIHJlc3QubGVuZ3RoID8gdGhpcy5jb21iaW5lVGltZXN0YW1wcyh0YWcsIHVuZGVmaW5lZCwgbWVyZ2VkLCAuLi5yZXN0KSA6IG1lcmdlZDtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyA9IHt9KSB7IC8vIEFuIGFycmF5IG9mIHVubWVyZ2VkIHNpZ25hdHVyZXMgY2FuIGJlIHZlcmlmaWVkLlxuICAgIGlmIChzaWduYXR1cmUuc3RhcnRzV2l0aD8uKCdbJykpIHNpZ25hdHVyZSA9IEpTT04ucGFyc2Uoc2lnbmF0dXJlKTsgLy8gKG1heWJlSW5mbGF0ZSBsb29rcyBmb3IgJ3snLCBub3QgJ1snLilcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoc2lnbmF0dXJlKSkgcmV0dXJuIGF3YWl0IHN1cGVyLnZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMpO1xuICAgIGNvbnN0IGNvbWJpbmVkID0gYXdhaXQgUHJvbWlzZS5hbGwoc2lnbmF0dXJlLm1hcChlbGVtZW50ID0+IHRoaXMudmVyaWZ5KGVsZW1lbnQsIG9wdGlvbnMpKSk7XG4gICAgY29uc3Qgb2sgPSBjb21iaW5lZC5ldmVyeShlbGVtZW50ID0+IGVsZW1lbnQpO1xuICAgIGlmICghb2spIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgcHJvdGVjdGVkSGVhZGVyID0gY29tYmluZWRbMF0ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGZvciAoY29uc3QgcHJvcGVydHkgb2YgWydpc3MnLCAna2lkJywgJ2FsZycsICdjdHknXSkgeyAvLyBPdXIgb3BlcmF0aW9ucyBtYWtlIHVzZSBvZiBpc3MsIGtpZCwgYW5kIGlhdC5cbiAgICAgIGNvbnN0IG1hdGNoaW5nID0gcHJvdGVjdGVkSGVhZGVyW3Byb3BlcnR5XTtcbiAgICAgIGNvbnN0IG1hdGNoZXMgPSBjb21iaW5lZC5ldmVyeShlbGVtZW50ID0+IGVsZW1lbnQucHJvdGVjdGVkSGVhZGVyW3Byb3BlcnR5XSA9PT0gbWF0Y2hpbmcpO1xuICAgICAgaWYgKG1hdGNoZXMpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFtYXRjaGVzKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBjb25zdCB7aXNzLCBraWQsIGFsZywgY3R5fSA9IHByb3RlY3RlZEhlYWRlcjtcbiAgICBjb25zdCB2ZXJpZmllZCA9IHtcbiAgICAgIHNpZ25hdHVyZSwgLy8gYXJyYXkgYXQgdGhpcyBwb2ludFxuICAgICAganNvbjogY29tYmluZWQubWFwKGVsZW1lbnQgPT4gZWxlbWVudC5qc29uKSxcbiAgICAgIHByb3RlY3RlZEhlYWRlcjoge2lzcywga2lkLCBhbGcsIGN0eSwgaWF0OiBNYXRoLm1heCguLi5jb21iaW5lZC5tYXAoZWxlbWVudCA9PiBlbGVtZW50LnByb3RlY3RlZEhlYWRlci5pYXQpKX1cbiAgICB9O1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgeyAvLyBiYWNrZGF0aW5nIGlzIGFsbG93ZWQuIChtZXJnaW5nKS5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIXRoaXMub3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpKSByZXR1cm4gJ25vdCBvd25lcic7XG4gICAgaWYgKCFhd2FpdCB0aGlzLnN1YmplY3RNYXRjaCh2ZXJpZmllZCkpIHJldHVybiAnd3JvbmcgaGFzaCc7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgb3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gVE9ETzogRWl0aGVyIHRoZXkgbXVzdCBtYXRjaCAoYXMgaW4gc3VwZXIpIG9yIHRoZSBuZXcgcGF5bG9hZCBtdXN0IGluY2x1ZGUgdGhlIHByZXZpb3VzLlxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cblxuLy8gV2hlbiBydW5uaW5nIGluIE5vZGVKUywgdGhlIFNlY3VyaXR5IG9iamVjdCBpcyBhdmFpbGFibGUgZGlyZWN0bHkuXG4vLyBJdCBoYXMgYSBTdG9yYWdlIHByb3BlcnR5LCB3aGljaCBkZWZpbmVzIHN0b3JlL3JldHJpZXZlIChpbiBsaWIvc3RvcmFnZS5tanMpIHRvIEdFVC9QVVQgb25cbi8vIC4uLi86ZnVsbExhYmVsLzpwYXJ0MW9mVGFnLzpwYXJ0Mm9mVGFnLzpwYXJ0M29mVGFnLzpyZXN0T2ZUYWcuanNvblxuLy8gVGhlIFNlY3VyaXR5LlN0b3JhZ2UgY2FuIGJlIHNldCBieSBjbGllbnRzIHRvIHNvbWV0aGluZyBlbHNlLlxuLy9cbi8vIFdoZW4gcnVubmluZyBpbiBhIGJyb3dzZXIsIHdvcmtlci5qcyBvdmVycmlkZXMgdGhpcyB0byBzZW5kIG1lc3NhZ2VzIHRocm91Z2ggdGhlIEpTT04gUlBDXG4vLyB0byB0aGUgYXBwLCB3aGljaCB0aGVuIGFsc28gaGFzIGFuIG92ZXJyaWRhYmxlIFNlY3VyaXR5LlN0b3JhZ2UgdGhhdCBpcyBpbXBsZW1lbnRlZCB3aXRoIHRoZSBzYW1lIGNvZGUgYXMgYWJvdmUuXG5cbi8vIEJhc2ggaW4gc29tZSBuZXcgc3R1ZmY6XG5DcmVkZW50aWFscy5hdXRob3IgPSBudWxsO1xuQ3JlZGVudGlhbHMub3duZXIgPSBudWxsO1xuQ3JlZGVudGlhbHMuZW5jcnlwdGlvbiA9IG51bGw7IC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGF1ZGllbmNlXG5DcmVkZW50aWFscy5zeW5jaHJvbml6ZSA9IGFzeW5jICguLi5zZXJ2aWNlcykgPT4geyAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBjb25uZWN0LlxuICAvLyBXZSBjYW4gZG8gYWxsIHRocmVlIGluIHBhcmFsbGVsIC0tIHdpdGhvdXQgd2FpdGluZyBmb3IgY29tcGxldGlvbiAtLSBiZWNhdXNlIGRlcGVuZGVuY2llcyB3aWxsIGdldCBzb3J0ZWQgb3V0IGJ5IHN5bmNocm9uaXplMS5cbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uc3luY2hyb25pemUoLi4uc2VydmljZXMpKSk7XG59O1xuQ3JlZGVudGlhbHMuc3luY2hyb25pemVkID0gYXN5bmMgKCkgPT4ge1xuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5zeW5jaHJvbml6ZWQpKTtcbn1cbkNyZWRlbnRpYWxzLmRpc2Nvbm5lY3QgPSBhc3luYyAoLi4uc2VydmljZXMpID0+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZGlzY29ubmVjdCguLi5zZXJ2aWNlcykpKTtcbn1cblxuQ3JlZGVudGlhbHMuY3JlYXRlQXV0aG9yID0gYXN5bmMgKHByb21wdCkgPT4geyAvLyBDcmVhdGUgYSB1c2VyOlxuICAvLyBJZiBwcm9tcHQgaXMgJy0nLCBjcmVhdGVzIGFuIGludml0YXRpb24gYWNjb3VudCwgd2l0aCBhIG5vLW9wIHJlY292ZXJ5IGFuZCBubyBkZXZpY2UuXG4gIC8vIE90aGVyd2lzZSwgcHJvbXB0IGluZGljYXRlcyB0aGUgcmVjb3ZlcnkgcHJvbXB0cywgYW5kIHRoZSBhY2NvdW50IGhhcyB0aGF0IGFuZCBhIGRldmljZS5cbiAgaWYgKHByb21wdCA9PT0gJy0nKSByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0fSkpO1xuICBjb25zdCBbbG9jYWwsIHJlY292ZXJ5XSA9IGF3YWl0IFByb21pc2UuYWxsKFtDcmVkZW50aWFscy5jcmVhdGUoKSwgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHR9KV0pO1xuICByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGxvY2FsLCByZWNvdmVyeSk7XG59O1xuQ3JlZGVudGlhbHMuY2xhaW1JbnZpdGF0aW9uID0gYXN5bmMgKHRhZywgbmV3UHJvbXB0KSA9PiB7IC8vIENyZWF0ZXMgYSBsb2NhbCBkZXZpY2UgdGFnIGFuZCBhZGRzIGl0IHRvIHRoZSBnaXZlbiBpbnZpdGF0aW9uIHRhZyxcbiAgLy8gdXNpbmcgdGhlIHNlbGYtdmFsaWRhdGluZyByZWNvdmVyeSBtZW1iZXIgdGhhdCBpcyB0aGVuIHJlbW92ZWQgYW5kIGRlc3Ryb3llZC5cbiAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBDcmVkZW50aWFscy5jb2xsZWN0aW9ucy5UZWFtLnJldHJpZXZlKHt0YWd9KTtcbiAgaWYgKCF2ZXJpZmllZCkgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gdmVyaWZ5IGludml0YXRpb24gJHt0YWd9LmApO1xuICBjb25zdCBtZW1iZXJzID0gdmVyaWZpZWQuanNvbi5yZWNpcGllbnRzO1xuICBpZiAobWVtYmVycy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgSW52aXRhdGlvbnMgc2hvdWxkIGhhdmUgb25lIG1lbWJlcjogJHt0YWd9YCk7XG4gIGNvbnN0IG9sZFJlY292ZXJ5VGFnID0gbWVtYmVyc1swXS5oZWFkZXIua2lkO1xuICBjb25zdCBuZXdSZWNvdmVyeVRhZyA9IGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0OiBuZXdQcm9tcHR9KTtcbiAgY29uc3QgZGV2aWNlVGFnID0gYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKCk7XG5cbiAgLy8gV2UgbmVlZCB0byBhZGQgdGhlIG5ldyBtZW1iZXJzIGluIG9uZSBjaGFuZ2VNZW1iZXJzaGlwIHN0ZXAsIGFuZCB0aGVuIHJlbW92ZSB0aGUgb2xkUmVjb3ZlcnlUYWcgaW4gYSBzZWNvbmQgY2FsbCB0byBjaGFuZ2VNZW1iZXJzaGlwOlxuICAvLyBjaGFuZ2VNZW1iZXJzaGlwIHdpbGwgc2lnbiBieSBhbiBPTEQgbWVtYmVyIC0gSWYgaXQgc2lnbmVkIGJ5IG5ldyBtZW1iZXIgdGhhbiBwZW9wbGUgY291bGQgYm9vdHN0cmFwIHRoZW1zZWx2ZXMgb250byBhIHRlYW0uXG4gIC8vIEJ1dCBpZiB3ZSByZW1vdmUgdGhlIG9sZFJlY292ZXJ5IHRhZyBpbiB0aGUgc2FtZSBzdGVwIGFzIGFkZGluZyB0aGUgbmV3LCB0aGUgdGVhbSB3b3VsZCBiZSBzaWduZWQgYnkgc29tZW9uZSAodGhlIG9sZFJlY292ZXJ5VGFnKSB0aGF0XG4gIC8vIGlzIG5vIGxvbmdlciBhIG1lbWJlciwgYW5kIHNvIHRoZSB0ZWFtIHdvdWxkIG5vdCB2ZXJpZnkhXG4gIGF3YWl0IENyZWRlbnRpYWxzLmNoYW5nZU1lbWJlcnNoaXAoe3RhZywgYWRkOiBbZGV2aWNlVGFnLCBuZXdSZWNvdmVyeVRhZ10sIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5jaGFuZ2VNZW1iZXJzaGlwKHt0YWcsIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5kZXN0cm95KG9sZFJlY292ZXJ5VGFnKTtcbiAgcmV0dXJuIHRhZztcbn07XG5jb25zdCBhbnN3ZXJzID0ge307IC8vIFRPRE86IG1ha2Ugc2V0QW5zd2VyIGluY2x1ZGUgdGFnIGFzIHdlbGwgYXMgcHJvbXB0LlxuQ3JlZGVudGlhbHMuc2V0QW5zd2VyID0gKHByb21wdCwgYW5zd2VyKSA9PiBhbnN3ZXJzW3Byb21wdF0gPSBhbnN3ZXI7XG5DcmVkZW50aWFscy5nZXRVc2VyRGV2aWNlU2VjcmV0ID0gZnVuY3Rpb24gZmxleHN0b3JlU2VjcmV0KHRhZywgcHJvbXB0U3RyaW5nKSB7XG4gIGlmICghcHJvbXB0U3RyaW5nKSByZXR1cm4gdGFnO1xuICBpZiAocHJvbXB0U3RyaW5nID09PSAnLScpIHJldHVybiBwcm9tcHRTdHJpbmc7IC8vIFNlZSBjcmVhdGVBdXRob3IuXG4gIGlmIChhbnN3ZXJzW3Byb21wdFN0cmluZ10pIHJldHVybiBhbnN3ZXJzW3Byb21wdFN0cmluZ107XG4gIC8vIERpc3RyaWJ1dGVkIFNlY3VyaXR5IHdpbGwgdHJ5IGV2ZXJ5dGhpbmcuIFVubGVzcyBnb2luZyB0aHJvdWdoIGEgcGF0aCBhYm92ZSwgd2Ugd291bGQgbGlrZSBvdGhlcnMgdG8gc2lsZW50bHkgZmFpbC5cbiAgY29uc29sZS5sb2coYEF0dGVtcHRpbmcgYWNjZXNzICR7dGFnfSB3aXRoIHByb21wdCAnJHtwcm9tcHRTdHJpbmd9Jy5gKTtcbiAgcmV0dXJuIFwibm90IGEgc2VjcmV0XCI7IC8vIHRvZG86IGNyeXB0byByYW5kb21cbn07XG5cblxuLy8gVGhlc2UgdHdvIGFyZSB1c2VkIGRpcmVjdGx5IGJ5IGRpc3RyaWJ1dGVkLXNlY3VyaXR5LlxuQ3JlZGVudGlhbHMuU3RvcmFnZS5yZXRyaWV2ZSA9IGFzeW5jIChjb2xsZWN0aW9uTmFtZSwgdGFnKSA9PiB7XG4gIGNvbnN0IGNvbGxlY3Rpb24gPSBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tjb2xsZWN0aW9uTmFtZV07XG4gIC8vIE5vIG5lZWQgdG8gdmVyaWZ5LCBhcyBkaXN0cmlidXRlZC1zZWN1cml0eSBkb2VzIHRoYXQgaXRzZWxmIHF1aXRlIGNhcmVmdWxseSBhbmQgdGVhbS1hd2FyZS5cbiAgaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnRW5jcnlwdGlvbktleScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7XG4gIGlmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ0tleVJlY292ZXJ5JykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTtcbiAgLy9pZiAoY29sbGVjdGlvbk5hbWUgPT09ICdUZWFtJykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTsgICAgLy8gVGhpcyB3b3VsZCBnbyBjaXJjdWxhci4gU2hvdWxkIGl0PyBEbyB3ZSBuZWVkIGl0P1xuICBjb25zdCBkYXRhID0gYXdhaXQgY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgLy8gSG93ZXZlciwgc2luY2Ugd2UgaGF2ZSBieXBhc3NlZCBDb2xsZWN0aW9uLnJldHJpZXZlLCB3ZSBtYXliZUluZmxhdGUgaGVyZS5cbiAgcmV0dXJuIENvbGxlY3Rpb24ubWF5YmVJbmZsYXRlKGRhdGEpO1xufVxuY29uc3QgRU1QVFlfU1RSSU5HX0hBU0ggPSBcIjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlVcIjsgLy8gSGFzaCBvZiBhbiBlbXB0eSBzdHJpbmcuXG5DcmVkZW50aWFscy5TdG9yYWdlLnN0b3JlID0gYXN5bmMgKGNvbGxlY3Rpb25OYW1lLCB0YWcsIHNpZ25hdHVyZSkgPT4ge1xuICAvLyBObyBuZWVkIHRvIGVuY3J5cHQvc2lnbiBhcyBieSBzdG9yZSwgc2luY2UgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgZG9lcyB0aGF0IGluIGEgY2lyY3VsYXJpdHktYXdhcmUgd2F5LlxuICAvLyBIb3dldmVyLCB3ZSBkbyBjdXJyZW50bHkgbmVlZCB0byBmaW5kIG91dCBvZiB0aGUgc2lnbmF0dXJlIGhhcyBhIHBheWxvYWQgYW5kIHB1c2hcbiAgLy8gVE9ETzogTW9kaWZ5IGRpc3Qtc2VjIHRvIGhhdmUgYSBzZXBhcmF0ZSBzdG9yZS9kZWxldGUsIHJhdGhlciB0aGFuIGhhdmluZyB0byBmaWd1cmUgdGhpcyBvdXQgaGVyZS5cbiAgY29uc3QgY2xhaW1zID0gQ3JlZGVudGlhbHMuZGVjb2RlQ2xhaW1zKHNpZ25hdHVyZSk7XG4gIGNvbnN0IGVtcHR5UGF5bG9hZCA9IGNsYWltcz8uc3ViID09PSBFTVBUWV9TVFJJTkdfSEFTSDtcblxuICBjb25zdCBjb2xsZWN0aW9uID0gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbY29sbGVjdGlvbk5hbWVdO1xuICBzaWduYXR1cmUgPSBDb2xsZWN0aW9uLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICBjb25zdCBzdG9yZWQgPSBhd2FpdCAoZW1wdHlQYXlsb2FkID8gY29sbGVjdGlvbi5kZWxldGUodGFnLCBzaWduYXR1cmUpIDogY29sbGVjdGlvbi5wdXQodGFnLCBzaWduYXR1cmUpKTtcbiAgaWYgKHN0b3JlZCAhPT0gdGFnKSB0aHJvdyBuZXcgRXJyb3IoYFVuYWJsZSB0byB3cml0ZSBjcmVkZW50aWFsICR7dGFnfS5gKTtcbiAgaWYgKHRhZykgYXdhaXQgY29sbGVjdGlvbi5wdXNoKGVtcHR5UGF5bG9hZCA/ICdkZWxldGUnOiAncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICByZXR1cm4gdGFnO1xufTtcbkNyZWRlbnRpYWxzLlN0b3JhZ2UuZGVzdHJveSA9IGFzeW5jICgpID0+IHtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2xlYXIoKTsgLy8gV2lwZSBmcm9tIGxpdmUgbWVtb3J5LlxuICBmb3IgKGxldCBjb2xsZWN0aW9uIG9mIE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpKSB7XG4gICAgYXdhaXQgY29sbGVjdGlvbi5kZXN0cm95KCk7XG4gIH1cbiAgYXdhaXQgQ3JlZGVudGlhbHMud2lwZURldmljZUtleXMoKTsgLy8gTm90IGluY2x1ZGVkIGluIHRoZSBhYm92ZS5cbn07XG5DcmVkZW50aWFscy5jb2xsZWN0aW9ucyA9IHt9O1xuZXhwb3J0IHsgQ3JlZGVudGlhbHMsIFN0b3JhZ2VMb2NhbCB9O1xuWydFbmNyeXB0aW9uS2V5JywgJ0tleVJlY292ZXJ5JywgJ1RlYW0nXS5mb3JFYWNoKG5hbWUgPT4gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbbmFtZV0gPSBuZXcgTXV0YWJsZUNvbGxlY3Rpb24oe25hbWV9KSk7XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgdXVpZDQgZnJvbSAndXVpZDQnO1xuaW1wb3J0IFN5bmNocm9uaXplciBmcm9tICcuL2xpYi9zeW5jaHJvbml6ZXIubWpzJztcbmltcG9ydCB7IENvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIE11dGFibGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBWZXJzaW9uQ29sbGVjdGlvbiwgU3RvcmFnZUxvY2FsIH0gZnJvbSAgJy4vbGliL2NvbGxlY3Rpb25zLm1qcyc7XG5pbXBvcnQgeyBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vbGliL3dlYnJ0Yy5tanMnO1xuaW1wb3J0IHsgdmVyc2lvbiwgbmFtZSwgc3RvcmFnZVZlcnNpb24sIHN0b3JhZ2VOYW1lIH0gZnJvbSAnLi9saWIvdmVyc2lvbi5tanMnO1xuXG5jb25zb2xlLmxvZyhgJHtuYW1lfSAke3ZlcnNpb259IGZyb20gJHtpbXBvcnQubWV0YS51cmx9LmApO1xuXG5leHBvcnQgeyBDcmVkZW50aWFscywgQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIFZlcnNpb25lZENvbGxlY3Rpb24sIFZlcnNpb25Db2xsZWN0aW9uLCBTeW5jaHJvbml6ZXIsIFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDLCBuYW1lLCB2ZXJzaW9uLCBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24sIFN0b3JhZ2VMb2NhbCwgdXVpZDQgfTtcbmV4cG9ydCBkZWZhdWx0IHsgQ3JlZGVudGlhbHMsIENvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIE11dGFibGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBWZXJzaW9uQ29sbGVjdGlvbiwgU3luY2hyb25pemVyLCBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQywgbmFtZSwgdmVyc2lvbiwgIHN0b3JhZ2VOYW1lLCBzdG9yYWdlVmVyc2lvbiwgU3RvcmFnZUxvY2FsLCB1dWlkNCB9O1xuIl0sIm5hbWVzIjpbInBrZy5kZWZhdWx0IiwiU3RvcmFnZUxvY2FsIl0sIm1hcHBpbmdzIjoiOzs7QUFBQSxNQUFNLFdBQVcsR0FBRyx3RUFBd0U7QUFDNUYsU0FBUyxLQUFLLENBQUMsSUFBSSxFQUFFO0FBQ3JCLEVBQUUsT0FBTyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztBQUMvQjs7QUFFQTtBQUNBO0FBQ0EsU0FBUyxLQUFLLEdBQUc7QUFDakIsRUFBRSxJQUFJLFFBQVEsR0FBRyxHQUFHLENBQUMsZUFBZSxDQUFDLElBQUksSUFBSSxFQUFFLENBQUM7QUFDaEQsRUFBRSxJQUFJLElBQUksR0FBRyxRQUFRLENBQUMsUUFBUSxFQUFFO0FBQ2hDLEVBQUUsR0FBRyxDQUFDLGVBQWUsQ0FBQyxRQUFRLENBQUM7QUFDL0IsRUFBRSxPQUFP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LENBQUMsRUFBRSxZQUFZLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLFVBQVUsRUFBRSxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxZQUFZLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxHQUFFLENBQUMsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUMsQ0FBQyxNQUFNLElBQUksRUFBRSxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsU0FBUyxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxNQUFNLFlBQVksU0FBUyxXQUFXLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxDQUFDLEVBQUUsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUMsQ0FBQyxNQUFNLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLEVBQUUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1B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TUFBTSxVQUFVLEdBQUcsV0FBVyxDQUFDLFdBQVcsQ0FBQyxjQUFjLENBQUM7QUFDNUQsRUFBRSxTQUFTLEdBQUcsVUFBVSxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUM7QUFDaEQsRUFBRSxNQUFNLE1BQU0sR0FBRyxPQUFPLFlBQVksR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDLEdBQUcsRUFBRSxTQUFTLENBQUMsR0FBRyxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxTQUFTLENBQUMsQ0FBQztBQUMxRyxFQUFFLElBQUksTUFBTSxLQUFLLEdBQUcsRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsMkJBQTJCLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzNFLEVBQUUsSUFBSSxHQUFHLEVBQUUsTUFBTSxVQUFVLENBQUMsSUFBSSxDQUFDLFlBQVksR0FBRyxRQUFRLEVBQUUsS0FBSyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUM7QUFDaEYsRUFBRSxPQUFPLEdBQUc7QUFDWixDQUFDO0FBQ0QsV0FBVyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEdBQUcsWUFBWTtBQUMxQyxFQUFFLE1BQU0sV0FBVyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQzVCLEVBQUUsS0FBSyxJQUFJLFVBQVUsSUFBSSxNQUFNLENBQUMsTUFBTSxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsRUFBRTtBQUNqRSxJQUFJLE1BQU0sVUFBVSxDQUFDLE9BQU8sRUFBRTtBQUM5QjtBQUNBLEVBQUUsTUFBTSxXQUFXLENBQUMsY0FBYyxFQUFFLENBQUM7QUFDckMsQ0FBQztBQUNELFdBQVcsQ0FBQyxXQUFXLEdBQUcsRUFBRTtBQUU1QixDQUFDLGVBQWUsRUFBRSxhQUFhLEVBQUUsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksSUFBSSxXQUFXLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUksaUJBQWlCLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDOztBQ3o0QnZILE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUcxRCxZQUFlLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxtQkFBbUIsRUFBRSxpQkFBaUIsRUFBRSxtQkFBbUIsRUFBRSxpQkFBaUIsRUFBRSxZQUFZLEVBQUUsTUFBTSxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLE9BQU8sR0FBRyxXQUFXLEVBQUUsY0FBYyxnQkFBRUEsWUFBWSxFQUFFLEtBQUssRUFBRTs7OzsiLCJ4X2dvb2dsZV9pZ25vcmVMaXN0IjpbMCw1XX0=
