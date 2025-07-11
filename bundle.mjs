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
var version$1 = "0.0.62";
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
var index = { Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection, VersionCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version,  storageName, storageVersion, StorageLocal: StorageCache, uuid4 };

export { Collection, ImmutableCollection, MutableCollection, PromiseWebRTC, SharedWebRTC, StorageCache as StorageLocal, Synchronizer, VersionCollection, VersionedCollection, WebRTC, index as default, name, storageName, storageVersion, uuid4, version };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsibm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vQGtpMXIweS9zdG9yYWdlL2J1bmRsZS5tanMiLCJsaWIvY29sbGVjdGlvbnMubWpzIiwiaW5kZXgubWpzIl0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHV1aWRQYXR0ZXJuID0gL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pO1xuZnVuY3Rpb24gdmFsaWQodXVpZCkge1xuICByZXR1cm4gdXVpZFBhdHRlcm4udGVzdCh1dWlkKTtcbn1cblxuLy8gQmFzZWQgb24gaHR0cHM6Ly9hYmhpc2hla2R1dHRhLm9yZy9ibG9nL3N0YW5kYWxvbmVfdXVpZF9nZW5lcmF0b3JfaW5famF2YXNjcmlwdC5odG1sXG4vLyBJRTExIGFuZCBNb2Rlcm4gQnJvd3NlcnMgT25seVxuZnVuY3Rpb24gdXVpZDQoKSB7XG4gIHZhciB0ZW1wX3VybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwobmV3IEJsb2IoKSk7XG4gIHZhciB1dWlkID0gdGVtcF91cmwudG9TdHJpbmcoKTtcbiAgVVJMLnJldm9rZU9iamVjdFVSTCh0ZW1wX3VybCk7XG4gIHJldHVybiB1dWlkLnNwbGl0KC9bOlxcL10vZykucG9wKCkudG9Mb3dlckNhc2UoKTsgLy8gcmVtb3ZlIHByZWZpeGVzXG59XG51dWlkNC52YWxpZCA9IHZhbGlkO1xuXG5leHBvcnQgZGVmYXVsdCB1dWlkNDtcbmV4cG9ydCB7IHV1aWQ0LCB2YWxpZCB9O1xuIiwiLy8gSW4gYSBicm93c2VyLCB3cnRjIHByb3BlcnRpZXMgc3VjaCBhcyBSVENQZWVyQ29ubmVjdGlvbiBhcmUgaW4gZ2xvYmFsVGhpcy5cbmV4cG9ydCBkZWZhdWx0IGdsb2JhbFRoaXM7XG4iLCJpbXBvcnQgdXVpZDQgZnJvbSAndXVpZDQnO1xuXG4vLyBTZWUgcm9sbHVwLmNvbmZpZy5tanNcbmltcG9ydCB3cnRjIGZyb20gJyN3cnRjJztcbi8vY29uc3Qge2RlZmF1bHQ6d3J0Y30gPSBhd2FpdCAoKHR5cGVvZihwcm9jZXNzKSAhPT0gJ3VuZGVmaW5lZCcpID8gaW1wb3J0KCdAcm9hbWhxL3dydGMnKSA6IHtkZWZhdWx0OiBnbG9iYWxUaGlzfSk7XG5cbmNvbnN0IGljZVNlcnZlcnMgPSBbXG4gIHsgdXJsczogJ3N0dW46c3R1bi5sLmdvb2dsZS5jb206MTkzMDInfSxcbiAgLy8gaHR0cHM6Ly9mcmVlc3R1bi5uZXQvICBDdXJyZW50bHkgNTAgS0JpdC9zLiAoMi41IE1CaXQvcyBmb3JzICQ5L21vbnRoKVxuICB7IHVybHM6ICdzdHVuOmZyZWVzdHVuLm5ldDozNDc4JyB9LFxuICAvL3sgdXJsczogJ3R1cm46ZnJlZXN0dW4ubmV0OjM0NzgnLCB1c2VybmFtZTogJ2ZyZWUnLCBjcmVkZW50aWFsOiAnZnJlZScgfSxcbiAgLy8gUHJlc3VtYWJseSB0cmFmZmljIGxpbWl0ZWQuIENhbiBnZW5lcmF0ZSBuZXcgY3JlZGVudGlhbHMgYXQgaHR0cHM6Ly9zcGVlZC5jbG91ZGZsYXJlLmNvbS90dXJuLWNyZWRzXG4gIC8vIEFsc28gaHR0cHM6Ly9kZXZlbG9wZXJzLmNsb3VkZmxhcmUuY29tL2NhbGxzLyAxIFRCL21vbnRoLCBhbmQgJDAuMDUgL0dCIGFmdGVyIHRoYXQuXG4gIHsgdXJsczogJ3R1cm46dHVybi5zcGVlZC5jbG91ZGZsYXJlLmNvbTo1MDAwMCcsIHVzZXJuYW1lOiAnODI2MjI2MjQ0Y2Q2ZTVlZGIzZjU1NzQ5Yjc5NjIzNWY0MjBmZTVlZTc4ODk1ZTBkZDdkMmJhYTQ1ZTFmN2E4ZjQ5ZTkyMzllNzg2OTFhYjM4YjcyY2UwMTY0NzFmNzc0NmY1Mjc3ZGNlZjg0YWQ3OWZjNjBmODAyMGIxMzJjNzMnLCBjcmVkZW50aWFsOiAnYWJhOWIxNjk1NDZlYjZkY2M3YmZiMWNkZjM0NTQ0Y2Y5NWI1MTYxZDYwMmUzYjVmYTdjODM0MmIyZTk4MDJmYicgfVxuICAvLyBodHRwczovL2Zhc3R0dXJuLm5ldC8gQ3VycmVudGx5IDUwME1CL21vbnRoPyAoMjUgR0IvbW9udGggZm9yICQ5L21vbnRoKVxuICAvLyBodHRwczovL3hpcnN5cy5jb20vcHJpY2luZy8gNTAwIE1CL21vbnRoICg1MCBHQi9tb250aCBmb3IgJDMzL21vbnRoKVxuICAvLyBBbHNvIGh0dHBzOi8vd3d3Lm5wbWpzLmNvbS9wYWNrYWdlL25vZGUtdHVybiBvciBodHRwczovL21lZXRyaXguaW8vYmxvZy93ZWJydGMvY290dXJuL2luc3RhbGxhdGlvbi5odG1sXG5dO1xuXG4vLyBVdGlsaXR5IHdyYXBwZXIgYXJvdW5kIFJUQ1BlZXJDb25uZWN0aW9uLlxuLy8gV2hlbiBzb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gKHN1Y2ggYXMgY3JlYXRlRGF0YUNoYW5uZWwpLCBpdCB3aWxsIGdlbmVyYXRlIGNhbGxzIHRvIHNpZ25hbCgpLCB3aGljaCBuZWVkcyB0byBiZSBkZWZpbmVkIGJ5IHN1YmNsYXNzZXMuXG5leHBvcnQgY2xhc3MgV2ViUlRDIHtcbiAgY29uc3RydWN0b3Ioe2xhYmVsID0gJycsIGNvbmZpZ3VyYXRpb24gPSBudWxsLCB1dWlkID0gdXVpZDQoKSwgZGVidWcgPSBmYWxzZSwgZXJyb3IgPSBjb25zb2xlLmVycm9yLCAuLi5yZXN0fSA9IHt9KSB7XG4gICAgY29uZmlndXJhdGlvbiA/Pz0ge2ljZVNlcnZlcnN9OyAvLyBJZiBjb25maWd1cmF0aW9uIGNhbiBiZSBvbW1pdHRlZCBvciBleHBsaWNpdGx5IGFzIG51bGwsIHVzZSBvdXIgZGVmYXVsdC4gQnV0IGlmIHt9LCBsZWF2ZSBpdCBiZS5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtsYWJlbCwgY29uZmlndXJhdGlvbiwgdXVpZCwgZGVidWcsIGVycm9yLCAuLi5yZXN0fSk7XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBzaWduYWwodHlwZSwgbWVzc2FnZSkgeyAvLyBTdWJjbGFzc2VzIG11c3Qgb3ZlcnJpZGUgb3IgZXh0ZW5kLiBEZWZhdWx0IGp1c3QgbG9ncy5cbiAgICB0aGlzLmxvZygnc2VuZGluZycsIHR5cGUsIHR5cGUubGVuZ3RoLCBKU09OLnN0cmluZ2lmeShtZXNzYWdlKS5sZW5ndGgpO1xuICB9XG5cbiAgcGVlclZlcnNpb24gPSAwO1xuICByZXNldFBlZXIoKSB7IC8vIFNldCB1cCBhIG5ldyBSVENQZWVyQ29ubmVjdGlvbi4gKENhbGxlciBtdXN0IGNsb3NlIG9sZCBpZiBuZWNlc3NhcnkuKVxuICAgIGNvbnN0IG9sZCA9IHRoaXMucGVlcjtcbiAgICBpZiAob2xkKSB7XG4gICAgICBvbGQub25uZWdvdGlhdGlvbm5lZWRlZCA9IG9sZC5vbmljZWNhbmRpZGF0ZSA9IG9sZC5vbmljZWNhbmRpZGF0ZWVycm9yID0gb2xkLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gbnVsbDtcbiAgICAgIC8vIERvbid0IGNsb3NlIHVubGVzcyBpdCdzIGJlZW4gb3BlbmVkLCBiZWNhdXNlIHRoZXJlIGFyZSBsaWtlbHkgaGFuZGxlcnMgdGhhdCB3ZSBkb24ndCB3YW50IHRvIGZpcmUuXG4gICAgICBpZiAob2xkLmNvbm5lY3Rpb25TdGF0ZSAhPT0gJ25ldycpIG9sZC5jbG9zZSgpO1xuICAgIH1cbiAgICBjb25zdCBwZWVyID0gdGhpcy5wZWVyID0gbmV3IHdydGMuUlRDUGVlckNvbm5lY3Rpb24odGhpcy5jb25maWd1cmF0aW9uKTtcbiAgICBwZWVyLnZlcnNpb25JZCA9IHRoaXMucGVlclZlcnNpb24rKztcbiAgICBwZWVyLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBldmVudCA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkKGV2ZW50KTtcbiAgICBwZWVyLm9uaWNlY2FuZGlkYXRlID0gZXZlbnQgPT4gdGhpcy5vbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KTtcbiAgICAvLyBJIGRvbid0IHRoaW5rIGFueW9uZSBhY3R1YWxseSBzaWduYWxzIHRoaXMuIEluc3RlYWQsIHRoZXkgcmVqZWN0IGZyb20gYWRkSWNlQ2FuZGlkYXRlLCB3aGljaCB3ZSBoYW5kbGUgdGhlIHNhbWUuXG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZWVycm9yID0gZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcik7XG4gICAgLy8gSSB0aGluayB0aGlzIGlzIHJlZHVuZG5hbnQgYmVjYXVzZSBubyBpbXBsZW1lbnRhdGlvbiBmaXJlcyB0aGlzIGV2ZW50IGFueSBzaWduaWZpY2FudCB0aW1lIGFoZWFkIG9mIGVtaXR0aW5nIGljZWNhbmRpZGF0ZSB3aXRoIGFuIGVtcHR5IGV2ZW50LmNhbmRpZGF0ZS5cbiAgICBwZWVyLm9uaWNlZ2F0aGVyaW5nc3RhdGVjaGFuZ2UgPSBldmVudCA9PiAocGVlci5pY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJykgJiYgdGhpcy5vbkxvY2FsRW5kSWNlO1xuICAgIHBlZXIub25jb25uZWN0aW9uc3RhdGVjaGFuZ2UgPSBldmVudCA9PiB0aGlzLmNvbm5lY3Rpb25TdGF0ZUNoYW5nZSh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlKTtcbiAgfVxuICBvbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KSB7XG4gICAgLy8gVGhlIHNwZWMgc2F5cyB0aGF0IGEgbnVsbCBjYW5kaWRhdGUgc2hvdWxkIG5vdCBiZSBzZW50LCBidXQgdGhhdCBhbiBlbXB0eSBzdHJpbmcgY2FuZGlkYXRlIHNob3VsZC4gU2FmYXJpICh1c2VkIHRvPykgZ2V0IGVycm9ycyBlaXRoZXIgd2F5LlxuICAgIGlmICghZXZlbnQuY2FuZGlkYXRlIHx8ICFldmVudC5jYW5kaWRhdGUuY2FuZGlkYXRlKSB0aGlzLm9uTG9jYWxFbmRJY2UoKTtcbiAgICBlbHNlIHRoaXMuc2lnbmFsKCdpY2VjYW5kaWRhdGUnLCBldmVudC5jYW5kaWRhdGUpO1xuICB9XG4gIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFRyaWdnZXJlZCBvbiBvdXIgc2lkZSBieSBhbnkvYWxsIG9mIG9uaWNlY2FuZGlkYXRlIHdpdGggbm8gZXZlbnQuY2FuZGlkYXRlLCBpY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJy5cbiAgICAvLyBJLmUuLCBjYW4gaGFwcGVuIG11bHRpcGxlIHRpbWVzLiBTdWJjbGFzc2VzIG1pZ2h0IGRvIHNvbWV0aGluZy5cbiAgfVxuICBjbG9zZSgpIHtcbiAgICBpZiAoKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICduZXcnKSAmJiAodGhpcy5wZWVyLnNpZ25hbGluZ1N0YXRlID09PSAnc3RhYmxlJykpIHJldHVybjtcbiAgICB0aGlzLnJlc2V0UGVlcigpO1xuICB9XG4gIGNvbm5lY3Rpb25TdGF0ZUNoYW5nZShzdGF0ZSkge1xuICAgIHRoaXMubG9nKCdzdGF0ZSBjaGFuZ2U6Jywgc3RhdGUpO1xuICAgIGlmIChbJ2Rpc2Nvbm5lY3RlZCcsICdmYWlsZWQnLCAnY2xvc2VkJ10uaW5jbHVkZXMoc3RhdGUpKSB0aGlzLmNsb3NlKCk7IC8vIE90aGVyIGJlaGF2aW9yIGFyZSByZWFzb25hYmxlLCB0b2xvLlxuICB9XG4gIG5lZ290aWF0aW9ubmVlZGVkKCkgeyAvLyBTb21ldGhpbmcgaGFzIGNoYW5nZWQgbG9jYWxseSAobmV3IHN0cmVhbSwgb3IgbmV0d29yayBjaGFuZ2UpLCBzdWNoIHRoYXQgd2UgaGF2ZSB0byBzdGFydCBuZWdvdGlhdGlvbi5cbiAgICB0aGlzLmxvZygnbmVnb3RpYXRpb25ubmVlZGVkJyk7XG4gICAgdGhpcy5wZWVyLmNyZWF0ZU9mZmVyKClcbiAgICAgIC50aGVuKG9mZmVyID0+IHtcbiAgICAgICAgdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24ob2ZmZXIpOyAvLyBwcm9taXNlIGRvZXMgbm90IHJlc29sdmUgdG8gb2ZmZXJcblx0cmV0dXJuIG9mZmVyO1xuICAgICAgfSlcbiAgICAgIC50aGVuKG9mZmVyID0+IHRoaXMuc2lnbmFsKCdvZmZlcicsIG9mZmVyKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkRXJyb3IoZXJyb3IpKTtcbiAgfVxuICBvZmZlcihvZmZlcikgeyAvLyBIYW5kbGVyIGZvciByZWNlaXZpbmcgYW4gb2ZmZXIgZnJvbSB0aGUgb3RoZXIgdXNlciAod2hvIHN0YXJ0ZWQgdGhlIHNpZ25hbGluZyBwcm9jZXNzKS5cbiAgICAvLyBOb3RlIHRoYXQgZHVyaW5nIHNpZ25hbGluZywgd2Ugd2lsbCByZWNlaXZlIG5lZ290aWF0aW9ubmVlZGVkL2Fuc3dlciwgb3Igb2ZmZXIsIGJ1dCBub3QgYm90aCwgZGVwZW5kaW5nXG4gICAgLy8gb24gd2hldGhlciB3ZSB3ZXJlIHRoZSBvbmUgdGhhdCBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2Vzcy5cbiAgICB0aGlzLnBlZXIuc2V0UmVtb3RlRGVzY3JpcHRpb24ob2ZmZXIpXG4gICAgICAudGhlbihfID0+IHRoaXMucGVlci5jcmVhdGVBbnN3ZXIoKSlcbiAgICAgIC50aGVuKGFuc3dlciA9PiB0aGlzLnBlZXIuc2V0TG9jYWxEZXNjcmlwdGlvbihhbnN3ZXIpKSAvLyBwcm9taXNlIGRvZXMgbm90IHJlc29sdmUgdG8gYW5zd2VyXG4gICAgICAudGhlbihfID0+IHRoaXMuc2lnbmFsKCdhbnN3ZXInLCB0aGlzLnBlZXIubG9jYWxEZXNjcmlwdGlvbikpO1xuICB9XG4gIGFuc3dlcihhbnN3ZXIpIHsgLy8gSGFuZGxlciBmb3IgZmluaXNoaW5nIHRoZSBzaWduYWxpbmcgcHJvY2VzcyB0aGF0IHdlIHN0YXJ0ZWQuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKGFuc3dlcik7XG4gIH1cbiAgaWNlY2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkgeyAvLyBIYW5kbGVyIGZvciBhIG5ldyBjYW5kaWRhdGUgcmVjZWl2ZWQgZnJvbSB0aGUgb3RoZXIgZW5kIHRocm91Z2ggc2lnbmFsaW5nLlxuICAgIHRoaXMucGVlci5hZGRJY2VDYW5kaWRhdGUoaWNlQ2FuZGlkYXRlKS5jYXRjaChlcnJvciA9PiB0aGlzLmljZWNhbmRpZGF0ZUVycm9yKGVycm9yKSk7XG4gIH1cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAodGhpcy5kZWJ1ZykgY29uc29sZS5sb2codGhpcy5sYWJlbCwgdGhpcy5wZWVyLnZlcnNpb25JZCwgLi4ucmVzdCk7XG4gIH1cbiAgbG9nRXJyb3IobGFiZWwsIGV2ZW50T3JFeGNlcHRpb24pIHtcbiAgICBjb25zdCBkYXRhID0gW3RoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnRoaXMuY29uc3RydWN0b3IuZ2F0aGVyRXJyb3JEYXRhKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKV07XG4gICAgdGhpcy5lcnJvcihkYXRhKTtcbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuICBzdGF0aWMgZXJyb3IoZXJyb3IpIHtcbiAgfVxuICBzdGF0aWMgZ2F0aGVyRXJyb3JEYXRhKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIGxhYmVsICsgXCIgZXJyb3I6XCIsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLmNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvckNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXMgfHwgXCJcIiwgLy8gRmlyc3QgaXMgZGVwcmVjYXRlZCwgYnV0IHN0aWxsIHVzZWZ1bC5cbiAgICAgIGV2ZW50T3JFeGNlcHRpb24udXJsIHx8IGV2ZW50T3JFeGNlcHRpb24ubmFtZSB8fCAnJyxcbiAgICAgIGV2ZW50T3JFeGNlcHRpb24ubWVzc2FnZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yVGV4dCB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1c1RleHQgfHwgZXZlbnRPckV4Y2VwdGlvblxuICAgIF07XG4gIH1cbiAgaWNlY2FuZGlkYXRlRXJyb3IoZXZlbnRPckV4Y2VwdGlvbikgeyAvLyBGb3IgZXJyb3JzIG9uIHRoaXMgcGVlciBkdXJpbmcgZ2F0aGVyaW5nLlxuICAgIC8vIENhbiBiZSBvdmVycmlkZGVuIG9yIGV4dGVuZGVkIGJ5IGFwcGxpY2F0aW9ucy5cblxuICAgIC8vIFNUVU4gZXJyb3JzIGFyZSBpbiB0aGUgcmFuZ2UgMzAwLTY5OS4gU2VlIFJGQyA1Mzg5LCBzZWN0aW9uIDE1LjZcbiAgICAvLyBmb3IgYSBsaXN0IG9mIGNvZGVzLiBUVVJOIGFkZHMgYSBmZXcgbW9yZSBlcnJvciBjb2Rlczsgc2VlXG4gICAgLy8gUkZDIDU3NjYsIHNlY3Rpb24gMTUgZm9yIGRldGFpbHMuXG4gICAgLy8gU2VydmVyIGNvdWxkIG5vdCBiZSByZWFjaGVkIGFyZSBpbiB0aGUgcmFuZ2UgNzAwLTc5OS5cbiAgICBjb25zdCBjb2RlID0gZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzO1xuICAgIC8vIENocm9tZSBnaXZlcyA3MDEgZXJyb3JzIGZvciBzb21lIHR1cm4gc2VydmVycyB0aGF0IGl0IGRvZXMgbm90IGdpdmUgZm9yIG90aGVyIHR1cm4gc2VydmVycy5cbiAgICAvLyBUaGlzIGlzbid0IGdvb2QsIGJ1dCBpdCdzIHdheSB0b28gbm9pc3kgdG8gc2xvZyB0aHJvdWdoIHN1Y2ggZXJyb3JzLCBhbmQgSSBkb24ndCBrbm93IGhvdyB0byBmaXggb3VyIHR1cm4gY29uZmlndXJhdGlvbi5cbiAgICBpZiAoY29kZSA9PT0gNzAxKSByZXR1cm47XG4gICAgdGhpcy5sb2dFcnJvcignaWNlJywgZXZlbnRPckV4Y2VwdGlvbik7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFByb21pc2VXZWJSVEMgZXh0ZW5kcyBXZWJSVEMge1xuICAvLyBFeHRlbmRzIFdlYlJUQy5zaWduYWwoKSBzdWNoIHRoYXQ6XG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyBhbnN3ZXJzIGEgcHJvbWlzZSB0aGF0IHdpbGwgcmVzb2x2ZSB3aXRoIGFuIGFycmF5IG9mIHNpZ25hbCBtZXNzYWdlcy5cbiAgLy8gLSBpbnN0YW5jZS5zaWduYWxzID0gWy4uLnNpZ25hbE1lc3NhZ2VzXSB3aWxsIGRpc3BhdGNoIHRob3NlIG1lc3NhZ2VzLlxuICAvL1xuICAvLyBGb3IgZXhhbXBsZSwgc3VwcG9zZSBwZWVyMSBhbmQgcGVlcjIgYXJlIGluc3RhbmNlcyBvZiB0aGlzLlxuICAvLyAwLiBTb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gb24gcGVlcjEgKHN1Y2ggYXMgY2FsbGluZyBwZWVyMS5jcmVhdGVEYXRhQ2hhbm5lbCgpKS4gXG4gIC8vIDEuIHBlZXIxLnNpZ25hbHMgcmVzb2x2ZXMgd2l0aCA8c2lnbmFsMT4sIGEgUE9KTyB0byBiZSBjb252ZXllZCB0byBwZWVyMi5cbiAgLy8gMi4gU2V0IHBlZXIyLnNpZ25hbHMgPSA8c2lnbmFsMT4uXG4gIC8vIDMuIHBlZXIyLnNpZ25hbHMgcmVzb2x2ZXMgd2l0aCA8c2lnbmFsMj4sIGEgUE9KTyB0byBiZSBjb252ZXllZCB0byBwZWVyMS5cbiAgLy8gNC4gU2V0IHBlZXIxLnNpZ25hbHMgPSA8c2lnbmFsMj4uXG4gIC8vIDUuIERhdGEgZmxvd3MsIGJ1dCBlYWNoIHNpZGUgd2hvdWxkIGdyYWIgYSBuZXcgc2lnbmFscyBwcm9taXNlIGFuZCBiZSBwcmVwYXJlZCB0byBhY3QgaWYgaXQgcmVzb2x2ZXMuXG4gIC8vXG4gIGNvbnN0cnVjdG9yKHtpY2VUaW1lb3V0ID0gMmUzLCAuLi5wcm9wZXJ0aWVzfSkge1xuICAgIHN1cGVyKHByb3BlcnRpZXMpO1xuICAgIHRoaXMuaWNlVGltZW91dCA9IGljZVRpbWVvdXQ7XG4gIH1cbiAgZ2V0IHNpZ25hbHMoKSB7IC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZSB0byB0aGUgc2lnbmFsIG1lc3NhZ2luZyB3aGVuIGljZSBjYW5kaWRhdGUgZ2F0aGVyaW5nIGlzIGNvbXBsZXRlLlxuICAgIHJldHVybiB0aGlzLl9zaWduYWxQcm9taXNlIHx8PSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB0aGlzLl9zaWduYWxSZWFkeSA9IHtyZXNvbHZlLCByZWplY3R9KTtcbiAgfVxuICBzZXQgc2lnbmFscyhkYXRhKSB7IC8vIFNldCB3aXRoIHRoZSBzaWduYWxzIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZC5cbiAgICBkYXRhLmZvckVhY2goKFt0eXBlLCBtZXNzYWdlXSkgPT4gdGhpc1t0eXBlXShtZXNzYWdlKSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIEVhY2ggd3J0YyBpbXBsZW1lbnRhdGlvbiBoYXMgaXRzIG93biBpZGVhcyBhcyB0byB3aGF0IGljZSBjYW5kaWRhdGVzIHRvIHRyeSBiZWZvcmUgZW1pdHRpbmcgdGhlbSBpbiBpY2VjYW5kZGlhdGUuXG4gICAgLy8gTW9zdCB3aWxsIHRyeSB0aGluZ3MgdGhhdCBjYW5ub3QgYmUgcmVhY2hlZCwgYW5kIGdpdmUgdXAgd2hlbiB0aGV5IGhpdCB0aGUgT1MgbmV0d29yayB0aW1lb3V0LiBGb3J0eSBzZWNvbmRzIGlzIGEgbG9uZyB0aW1lIHRvIHdhaXQuXG4gICAgLy8gSWYgdGhlIHdydGMgaXMgc3RpbGwgd2FpdGluZyBhZnRlciBvdXIgaWNlVGltZW91dCAoMiBzZWNvbmRzKSwgbGV0cyBqdXN0IGdvIHdpdGggd2hhdCB3ZSBoYXZlLlxuICAgIHRoaXMudGltZXIgfHw9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5vbkxvY2FsRW5kSWNlKCksIHRoaXMuaWNlVGltZW91dCk7XG4gICAgc3VwZXIub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gIH1cbiAgY2xlYXJJY2VUaW1lcigpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7XG4gICAgdGhpcy50aW1lciA9IG51bGw7XG4gIH1cbiAgYXN5bmMgb25Mb2NhbEVuZEljZSgpIHsgLy8gUmVzb2x2ZSB0aGUgcHJvbWlzZSB3aXRoIHdoYXQgd2UndmUgYmVlbiBnYXRoZXJpbmcuXG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgaWYgKCF0aGlzLl9zaWduYWxQcm9taXNlKSB7XG4gICAgICAvL3RoaXMubG9nRXJyb3IoJ2ljZScsIFwiRW5kIG9mIElDRSB3aXRob3V0IGFueXRoaW5nIHdhaXRpbmcgb24gc2lnbmFscy5cIik7IC8vIE5vdCBoZWxwZnVsIHdoZW4gdGhlcmUgYXJlIHRocmVlIHdheXMgdG8gcmVjZWl2ZSB0aGlzIG1lc3NhZ2UuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3NpZ25hbFJlYWR5LnJlc29sdmUodGhpcy5zZW5kaW5nKTtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgfVxuICBzZW5kaW5nID0gW107XG4gIHNpZ25hbCh0eXBlLCBtZXNzYWdlKSB7XG4gICAgc3VwZXIuc2lnbmFsKHR5cGUsIG1lc3NhZ2UpO1xuICAgIHRoaXMuc2VuZGluZy5wdXNoKFt0eXBlLCBtZXNzYWdlXSk7XG4gIH1cbiAgLy8gV2UgbmVlZCB0byBrbm93IGlmIHRoZXJlIGFyZSBvcGVuIGRhdGEgY2hhbm5lbHMuIFRoZXJlIGlzIGEgcHJvcG9zYWwgYW5kIGV2ZW4gYW4gYWNjZXB0ZWQgUFIgZm9yIFJUQ1BlZXJDb25uZWN0aW9uLmdldERhdGFDaGFubmVscygpLFxuICAvLyBodHRwczovL2dpdGh1Yi5jb20vdzNjL3dlYnJ0Yy1leHRlbnNpb25zL2lzc3Vlcy8xMTBcbiAgLy8gYnV0IGl0IGhhc24ndCBiZWVuIGRlcGxveWVkIGV2ZXJ5d2hlcmUgeWV0LiBTbyB3ZSdsbCBuZWVkIHRvIGtlZXAgb3VyIG93biBjb3VudC5cbiAgLy8gQWxhcywgYSBjb3VudCBpc24ndCBlbm91Z2gsIGJlY2F1c2Ugd2UgY2FuIG9wZW4gc3R1ZmYsIGFuZCB0aGUgb3RoZXIgc2lkZSBjYW4gb3BlbiBzdHVmZiwgYnV0IGlmIGl0IGhhcHBlbnMgdG8gYmVcbiAgLy8gdGhlIHNhbWUgXCJuZWdvdGlhdGVkXCIgaWQsIGl0IGlzbid0IHJlYWxseSBhIGRpZmZlcmVudCBjaGFubmVsLiAoaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL1JUQ1BlZXJDb25uZWN0aW9uL2RhdGFjaGFubmVsX2V2ZW50XG4gIGRhdGFDaGFubmVscyA9IG5ldyBNYXAoKTtcbiAgcmVwb3J0Q2hhbm5lbHMoKSB7IC8vIFJldHVybiBhIHJlcG9ydCBzdHJpbmcgdXNlZnVsIGZvciBkZWJ1Z2dpbmcuXG4gICAgY29uc3QgZW50cmllcyA9IEFycmF5LmZyb20odGhpcy5kYXRhQ2hhbm5lbHMuZW50cmllcygpKTtcbiAgICBjb25zdCBrdiA9IGVudHJpZXMubWFwKChbaywgdl0pID0+IGAke2t9OiR7di5pZH1gKTtcbiAgICByZXR1cm4gYCR7dGhpcy5kYXRhQ2hhbm5lbHMuc2l6ZX0vJHtrdi5qb2luKCcsICcpfWA7XG4gIH1cbiAgbm90ZUNoYW5uZWwoY2hhbm5lbCwgc291cmNlLCB3YWl0aW5nKSB7IC8vIEJvb2trZWVwIG9wZW4gY2hhbm5lbCBhbmQgcmV0dXJuIGl0LlxuICAgIC8vIEVtcGVyaWNhbGx5LCB3aXRoIG11bHRpcGxleCBmYWxzZTogLy8gICAxOCBvY2N1cnJlbmNlcywgd2l0aCBpZD1udWxsfDB8MSBhcyBmb3IgZXZlbnRjaGFubmVsIG9yIGNyZWF0ZURhdGFDaGFubmVsXG4gICAgLy8gICBBcHBhcmVudGx5LCB3aXRob3V0IG5lZ290aWF0aW9uLCBpZCBpcyBpbml0aWFsbHkgbnVsbCAocmVnYXJkbGVzcyBvZiBvcHRpb25zLmlkKSwgYW5kIHRoZW4gYXNzaWduZWQgdG8gYSBmcmVlIHZhbHVlIGR1cmluZyBvcGVuaW5nXG4gICAgY29uc3Qga2V5ID0gY2hhbm5lbC5sYWJlbDsgLy9maXhtZSBjaGFubmVsLmlkID09PSBudWxsID8gMSA6IGNoYW5uZWwuaWQ7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmRhdGFDaGFubmVscy5nZXQoa2V5KTtcbiAgICB0aGlzLmxvZygnZ290IGRhdGEtY2hhbm5lbCcsIHNvdXJjZSwga2V5LCBjaGFubmVsLnJlYWR5U3RhdGUsICdleGlzdGluZzonLCBleGlzdGluZywgJ3dhaXRpbmc6Jywgd2FpdGluZyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbHMuc2V0KGtleSwgY2hhbm5lbCk7XG4gICAgY2hhbm5lbC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsIGV2ZW50ID0+IHsgLy8gQ2xvc2Ugd2hvbGUgY29ubmVjdGlvbiB3aGVuIG5vIG1vcmUgZGF0YSBjaGFubmVscyBvciBzdHJlYW1zLlxuICAgICAgdGhpcy5kYXRhQ2hhbm5lbHMuZGVsZXRlKGtleSk7XG4gICAgICAvLyBJZiB0aGVyZSdzIG5vdGhpbmcgb3BlbiwgY2xvc2UgdGhlIGNvbm5lY3Rpb24uXG4gICAgICBpZiAodGhpcy5kYXRhQ2hhbm5lbHMuc2l6ZSkgcmV0dXJuO1xuICAgICAgaWYgKHRoaXMucGVlci5nZXRTZW5kZXJzKCkubGVuZ3RoKSByZXR1cm47XG4gICAgICB0aGlzLmNsb3NlKCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIGNoYW5uZWw7XG4gIH1cbiAgY3JlYXRlRGF0YUNoYW5uZWwobGFiZWwgPSBcImRhdGFcIiwgY2hhbm5lbE9wdGlvbnMgPSB7fSkgeyAvLyBQcm9taXNlIHJlc29sdmVzIHdoZW4gdGhlIGNoYW5uZWwgaXMgb3BlbiAod2hpY2ggd2lsbCBiZSBhZnRlciBhbnkgbmVlZGVkIG5lZ290aWF0aW9uKS5cbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICB0aGlzLmxvZygnY3JlYXRlIGRhdGEtY2hhbm5lbCcsIGxhYmVsLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgICBsZXQgY2hhbm5lbCA9IHRoaXMucGVlci5jcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY2hhbm5lbE9wdGlvbnMpO1xuICAgICAgdGhpcy5ub3RlQ2hhbm5lbChjaGFubmVsLCAnZXhwbGljaXQnKTsgLy8gTm90ZWQgZXZlbiBiZWZvcmUgb3BlbmVkLlxuICAgICAgLy8gVGhlIGNoYW5uZWwgbWF5IGhhdmUgYWxyZWFkeSBiZWVuIG9wZW5lZCBvbiB0aGUgb3RoZXIgc2lkZS4gSW4gdGhpcyBjYXNlLCBhbGwgYnJvd3NlcnMgZmlyZSB0aGUgb3BlbiBldmVudCBhbnl3YXksXG4gICAgICAvLyBidXQgd3J0YyAoaS5lLiwgb24gbm9kZUpTKSBkb2VzIG5vdC4gU28gd2UgaGF2ZSB0byBleHBsaWNpdGx5IGNoZWNrLlxuICAgICAgc3dpdGNoIChjaGFubmVsLnJlYWR5U3RhdGUpIHtcbiAgICAgIGNhc2UgJ29wZW4nOlxuXHRzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoY2hhbm5lbCksIDEwKTtcblx0YnJlYWs7XG4gICAgICBjYXNlICdjb25uZWN0aW5nJzpcblx0Y2hhbm5lbC5vbm9wZW4gPSBfID0+IHJlc29sdmUoY2hhbm5lbCk7XG5cdGJyZWFrO1xuICAgICAgZGVmYXVsdDpcblx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHJlYWR5U3RhdGUgJHtjaGFubmVsLnJlYWR5U3RhdGV9IGZvciBkYXRhIGNoYW5uZWwgJHtsYWJlbH0uYCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgd2FpdGluZ0NoYW5uZWxzID0ge307XG4gIGdldERhdGFDaGFubmVsUHJvbWlzZShsYWJlbCA9IFwiZGF0YVwiKSB7IC8vIFJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdwcm9taXNlIGRhdGEtY2hhbm5lbCcsIGxhYmVsKTtcbiAgICAgIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXSA9IHJlc29sdmU7XG4gICAgfSk7XG4gIH1cbiAgcmVzZXRQZWVyKCkgeyAvLyBSZXNldCBhICdjb25uZWN0ZWQnIHByb3BlcnR5IHRoYXQgcHJvbWlzZWQgdG8gcmVzb2x2ZSB3aGVuIG9wZW5lZCwgYW5kIHRyYWNrIGluY29taW5nIGRhdGFjaGFubmVscy5cbiAgICBzdXBlci5yZXNldFBlZXIoKTtcbiAgICB0aGlzLmNvbm5lY3RlZCA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyAvLyB0aGlzLmNvbm5lY3RlZCBpcyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGFyZS5cbiAgICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdjb25uZWN0aW9uc3RhdGVjaGFuZ2UnLCBldmVudCA9PiB7XG5cdGlmICh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnY29ubmVjdGVkJykge1xuXHQgIHJlc29sdmUodHJ1ZSk7XG5cdH1cbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdkYXRhY2hhbm5lbCcsIGV2ZW50ID0+IHsgLy8gUmVzb2x2ZSBwcm9taXNlIG1hZGUgd2l0aCBnZXREYXRhQ2hhbm5lbFByb21pc2UoKS5cbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBldmVudC5jaGFubmVsO1xuICAgICAgY29uc3QgbGFiZWwgPSBjaGFubmVsLmxhYmVsO1xuICAgICAgY29uc3Qgd2FpdGluZyA9IHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHRoaXMubm90ZUNoYW5uZWwoY2hhbm5lbCwgJ2RhdGFjaGFubmVsIGV2ZW50Jywgd2FpdGluZyk7IC8vIFJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB3ZSBhcmUgd2FpdGluZy5cbiAgICAgIGlmICghd2FpdGluZykgcmV0dXJuOyAvLyBNaWdodCBub3QgYmUgZXhwbGljaXRseSB3YWl0aW5nLiBFLmcuLCByb3V0ZXJzLlxuICAgICAgZGVsZXRlIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHdhaXRpbmcoY2hhbm5lbCk7XG4gICAgfSk7XG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICdmYWlsZWQnKSB0aGlzLl9zaWduYWxQcm9taXNlPy5yZWplY3Q/LigpO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgdGhpcy5fc2lnbmFsUHJvbWlzZSA9IHRoaXMuX3NpZ25hbFJlYWR5ID0gbnVsbDtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgICAvLyBJZiB0aGUgd2VicnRjIGltcGxlbWVudGF0aW9uIGNsb3NlcyB0aGUgZGF0YSBjaGFubmVscyBiZWZvcmUgdGhlIHBlZXIgaXRzZWxmLCB0aGVuIHRoaXMuZGF0YUNoYW5uZWxzIHdpbGwgYmUgZW1wdHkuXG4gICAgLy8gQnV0IGlmIG5vdCAoZS5nLiwgc3RhdHVzICdmYWlsZWQnIG9yICdkaXNjb25uZWN0ZWQnIG9uIFNhZmFyaSksIHRoZW4gbGV0IHVzIGV4cGxpY2l0bHkgY2xvc2UgdGhlbSBzbyB0aGF0IFN5bmNocm9uaXplcnMga25vdyB0byBjbGVhbiB1cC5cbiAgICBmb3IgKGNvbnN0IGNoYW5uZWwgb2YgdGhpcy5kYXRhQ2hhbm5lbHMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgIT09ICdvcGVuJykgY29udGludWU7IC8vIEtlZXAgZGVidWdnaW5nIHNhbml0eS5cbiAgICAgIC8vIEl0IGFwcGVhcnMgdGhhdCBpbiBTYWZhcmkgKDE4LjUpIGZvciBhIGNhbGwgdG8gY2hhbm5lbC5jbG9zZSgpIHdpdGggdGhlIGNvbm5lY3Rpb24gYWxyZWFkeSBpbnRlcm5hbGwgY2xvc2VkLCBTYWZhcmlcbiAgICAgIC8vIHdpbGwgc2V0IGNoYW5uZWwucmVhZHlTdGF0ZSB0byAnY2xvc2luZycsIGJ1dCBOT1QgZmlyZSB0aGUgY2xvc2VkIG9yIGNsb3NpbmcgZXZlbnQuIFNvIHdlIGhhdmUgdG8gZGlzcGF0Y2ggaXQgb3Vyc2VsdmVzLlxuICAgICAgLy9jaGFubmVsLmNsb3NlKCk7XG4gICAgICBjaGFubmVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjbG9zZScpKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gTmVnb3RpYXRlZCBjaGFubmVscyB1c2Ugc3BlY2lmaWMgaW50ZWdlcnMgb24gYm90aCBzaWRlcywgc3RhcnRpbmcgd2l0aCB0aGlzIG51bWJlci5cbi8vIFdlIGRvIG5vdCBzdGFydCBhdCB6ZXJvIGJlY2F1c2UgdGhlIG5vbi1uZWdvdGlhdGVkIGNoYW5uZWxzIChhcyB1c2VkIG9uIHNlcnZlciByZWxheXMpIGdlbmVyYXRlIHRoZWlyXG4vLyBvd24gaWRzIHN0YXJ0aW5nIHdpdGggMCwgYW5kIHdlIGRvbid0IHdhbnQgdG8gY29uZmxpY3QuXG4vLyBUaGUgc3BlYyBzYXlzIHRoZXNlIGNhbiBnbyB0byA2NSw1MzQsIGJ1dCBJIGZpbmQgdGhhdCBzdGFydGluZyBncmVhdGVyIHRoYW4gdGhlIHZhbHVlIGhlcmUgZ2l2ZXMgZXJyb3JzLlxuLy8gQXMgb2YgNy82LzI1LCBjdXJyZW50IGV2ZXJncmVlbiBicm93c2VycyB3b3JrIHdpdGggMTAwMCBiYXNlLCBidXQgRmlyZWZveCBmYWlscyBpbiBvdXIgY2FzZSAoMTAgbmVnb3RhdGlhdGVkIGNoYW5uZWxzKVxuLy8gaWYgYW55IGlkcyBhcmUgMjU2IG9yIGhpZ2hlci5cbmNvbnN0IEJBU0VfQ0hBTk5FTF9JRCA9IDEyNTtcbmV4cG9ydCBjbGFzcyBTaGFyZWRXZWJSVEMgZXh0ZW5kcyBQcm9taXNlV2ViUlRDIHtcbiAgc3RhdGljIGNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICBzdGF0aWMgZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIG11bHRpcGxleCA9IHRydWUsIC4uLnJlc3R9KSB7XG4gICAgbGV0IGNvbm5lY3Rpb24gPSB0aGlzLmNvbm5lY3Rpb25zLmdldChzZXJ2aWNlTGFiZWwpO1xuICAgIC8vIEl0IGlzIHBvc3NpYmxlIHRoYXQgd2Ugd2VyZSBiYWNrZ3JvdW5kZWQgYmVmb3JlIHdlIGhhZCBhIGNoYW5jZSB0byBhY3Qgb24gYSBjbG9zaW5nIGNvbm5lY3Rpb24gYW5kIHJlbW92ZSBpdC5cbiAgICBpZiAoY29ubmVjdGlvbikge1xuICAgICAgY29uc3Qge2Nvbm5lY3Rpb25TdGF0ZSwgc2lnbmFsaW5nU3RhdGV9ID0gY29ubmVjdGlvbi5wZWVyO1xuICAgICAgaWYgKChjb25uZWN0aW9uU3RhdGUgPT09ICdjbG9zZWQnKSB8fCAoc2lnbmFsaW5nU3RhdGUgPT09ICdjbG9zZWQnKSkgY29ubmVjdGlvbiA9IG51bGw7XG4gICAgfVxuICAgIGlmICghY29ubmVjdGlvbikge1xuICAgICAgY29ubmVjdGlvbiA9IG5ldyB0aGlzKHtsYWJlbDogc2VydmljZUxhYmVsLCB1dWlkOiB1dWlkNCgpLCBtdWx0aXBsZXgsIC4uLnJlc3R9KTtcbiAgICAgIGlmIChtdWx0aXBsZXgpIHRoaXMuY29ubmVjdGlvbnMuc2V0KHNlcnZpY2VMYWJlbCwgY29ubmVjdGlvbik7XG4gICAgfVxuICAgIHJldHVybiBjb25uZWN0aW9uO1xuICB9XG4gIGNoYW5uZWxJZCA9IEJBU0VfQ0hBTk5FTF9JRDtcbiAgZ2V0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nKCkge1xuICAgIHJldHVybiB0aGlzLmNoYW5uZWxJZCA+IEJBU0VfQ0hBTk5FTF9JRDtcbiAgfVxuICBjbG9zZShyZW1vdmVDb25uZWN0aW9uID0gdHJ1ZSkge1xuICAgIHRoaXMuY2hhbm5lbElkID0gQkFTRV9DSEFOTkVMX0lEO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgaWYgKHJlbW92ZUNvbm5lY3Rpb24pIHRoaXMuY29uc3RydWN0b3IuY29ubmVjdGlvbnMuZGVsZXRlKHRoaXMuc2VydmljZUxhYmVsKTtcbiAgfVxuICBhc3luYyBlbnN1cmVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgY2hhbm5lbE9wdGlvbnMgPSB7fSwgc2lnbmFscyA9IG51bGwpIHsgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgYW4gb3BlbiBkYXRhIGNoYW5uZWwgb24gdGhpcyBjb25uZWN0aW9uLlxuICAgIGNvbnN0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nID0gdGhpcy5oYXNTdGFydGVkQ29ubmVjdGluZzsgLy8gTXVzdCBhc2sgYmVmb3JlIGluY3JlbWVudGluZyBpZC5cbiAgICBjb25zdCBpZCA9IHRoaXMuY2hhbm5lbElkKys7IC8vIFRoaXMgYW5kIGV2ZXJ5dGhpbmcgbGVhZGluZyB1cCB0byBpdCBtdXN0IGJlIHN5bmNocm9ub3VzLCBzbyB0aGF0IGlkIGFzc2lnbm1lbnQgaXMgZGV0ZXJtaW5pc3RpYy5cbiAgICBjb25zdCBuZWdvdGlhdGVkID0gKHRoaXMubXVsdGlwbGV4ID09PSAnbmVnb3RpYXRlZCcpICYmIGhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGNvbnN0IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgPSAhaGFzU3RhcnRlZENvbm5lY3RpbmcgLyohbmVnb3RpYXRlZCovICYmICEhc2lnbmFsczsgLy8gT25seSB0aGUgMHRoIHdpdGggc2lnbmFscyB3YWl0cyBwYXNzaXZlbHkuXG4gICAgLy8gc2lnbmFscyBpcyBlaXRoZXIgbnVsbGlzaCBvciBhbiBhcnJheSBvZiBzaWduYWxzLCBidXQgdGhhdCBhcnJheSBjYW4gYmUgRU1QVFksXG4gICAgLy8gaW4gd2hpY2ggY2FzZSB0aGUgcmVhbCBzaWduYWxzIHdpbGwgaGF2ZSB0byBiZSBhc3NpZ25lZCBsYXRlci4gVGhpcyBhbGxvd3MgdGhlIGRhdGEgY2hhbm5lbCB0byBiZSBzdGFydGVkIChhbmQgdG8gY29uc3VtZVxuICAgIC8vIGEgY2hhbm5lbElkKSBzeW5jaHJvbm91c2x5LCBidXQgdGhlIHByb21pc2Ugd29uJ3QgcmVzb2x2ZSB1bnRpbCB0aGUgcmVhbCBzaWduYWxzIGFyZSBzdXBwbGllZCBsYXRlci4gVGhpcyBpc1xuICAgIC8vIHVzZWZ1bCBpbiBtdWx0aXBsZXhpbmcgYW4gb3JkZXJlZCBzZXJpZXMgb2YgZGF0YSBjaGFubmVscyBvbiBhbiBBTlNXRVIgY29ubmVjdGlvbiwgd2hlcmUgdGhlIGRhdGEgY2hhbm5lbHMgbXVzdFxuICAgIC8vIG1hdGNoIHVwIHdpdGggYW4gT0ZGRVIgY29ubmVjdGlvbiBvbiBhIHBlZXIuIFRoaXMgd29ya3MgYmVjYXVzZSBvZiB0aGUgd29uZGVyZnVsIGhhcHBlbnN0YW5jZSB0aGF0IGFuc3dlciBjb25uZWN0aW9uc1xuICAgIC8vIGdldERhdGFDaGFubmVsUHJvbWlzZSAod2hpY2ggZG9lc24ndCByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIHlldCBiZSBvcGVuKSByYXRoZXIgdGhhbiBjcmVhdGVEYXRhQ2hhbm5lbCAod2hpY2ggd291bGRcbiAgICAvLyByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIGFscmVhZHkgYmUgb3BlbikuXG4gICAgY29uc3QgdXNlU2lnbmFscyA9ICFoYXNTdGFydGVkQ29ubmVjdGluZyAmJiBzaWduYWxzPy5sZW5ndGg7XG4gICAgY29uc3Qgb3B0aW9ucyA9IG5lZ290aWF0ZWQgPyB7aWQsIG5lZ290aWF0ZWQsIC4uLmNoYW5uZWxPcHRpb25zfSA6IGNoYW5uZWxPcHRpb25zO1xuICAgIGlmIChoYXNTdGFydGVkQ29ubmVjdGluZykge1xuICAgICAgYXdhaXQgdGhpcy5jb25uZWN0ZWQ7IC8vIEJlZm9yZSBjcmVhdGluZyBwcm9taXNlLlxuICAgICAgLy8gSSBzb21ldGltZXMgZW5jb3VudGVyIGEgYnVnIGluIFNhZmFyaSBpbiB3aGljaCBPTkUgb2YgdGhlIGNoYW5uZWxzIGNyZWF0ZWQgc29vbiBhZnRlciBjb25uZWN0aW9uIGdldHMgc3R1Y2sgaW5cbiAgICAgIC8vIHRoZSBjb25uZWN0aW5nIHJlYWR5U3RhdGUgYW5kIG5ldmVyIG9wZW5zLiBFeHBlcmltZW50YWxseSwgdGhpcyBzZWVtcyB0byBiZSByb2J1c3QuXG4gICAgICAvL1xuICAgICAgLy8gTm90ZSB0byBzZWxmOiBJZiBpdCBzaG91bGQgdHVybiBvdXQgdGhhdCB3ZSBzdGlsbCBoYXZlIHByb2JsZW1zLCB0cnkgc2VyaWFsaXppbmcgdGhlIGNhbGxzIHRvIHBlZXIuY3JlYXRlRGF0YUNoYW5uZWxcbiAgICAgIC8vIHNvIHRoYXQgdGhlcmUgaXNuJ3QgbW9yZSB0aGFuIG9uZSBjaGFubmVsIG9wZW5pbmcgYXQgYSB0aW1lLlxuICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMCkpO1xuICAgIH0gZWxzZSBpZiAodXNlU2lnbmFscykge1xuICAgICAgdGhpcy5zaWduYWxzID0gc2lnbmFscztcbiAgICB9XG4gICAgY29uc3QgcHJvbWlzZSA9IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgP1xuXHQgIHRoaXMuZ2V0RGF0YUNoYW5uZWxQcm9taXNlKGNoYW5uZWxOYW1lKSA6XG5cdCAgdGhpcy5jcmVhdGVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIGF3YWl0IHByb21pc2U7XG4gIH1cbn1cbiIsIi8vIG5hbWUvdmVyc2lvbiBvZiBcImRhdGFiYXNlXCJcbmV4cG9ydCBjb25zdCBzdG9yYWdlTmFtZSA9ICdmbGV4c3RvcmUnO1xuZXhwb3J0IGNvbnN0IHN0b3JhZ2VWZXJzaW9uID0gMTE7XG5cbmltcG9ydCAqIGFzIHBrZyBmcm9tIFwiLi4vcGFja2FnZS5qc29uXCIgd2l0aCB7IHR5cGU6ICdqc29uJyB9O1xuZXhwb3J0IGNvbnN0IHtuYW1lLCB2ZXJzaW9ufSA9IHBrZy5kZWZhdWx0O1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHsgdGFnUGF0aCB9IGZyb20gJy4vdGFnUGF0aC5tanMnO1xuaW1wb3J0IHsgU2hhcmVkV2ViUlRDIH0gZnJvbSAnLi93ZWJydGMubWpzJztcbmltcG9ydCB7IHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5cbi8qXG4gIFJlc3BvbnNpYmxlIGZvciBrZWVwaW5nIGEgY29sbGVjdGlvbiBzeW5jaHJvbml6ZWQgd2l0aCBhbm90aGVyIHBlZXIuXG4gIChQZWVycyBtYXkgYmUgYSBjbGllbnQgb3IgYSBzZXJ2ZXIvcmVsYXkuIEluaXRpYWxseSB0aGlzIGlzIHRoZSBzYW1lIGNvZGUgZWl0aGVyIHdheSxcbiAgYnV0IGxhdGVyIG9uLCBvcHRpbWl6YXRpb25zIGNhbiBiZSBtYWRlIGZvciBzY2FsZS4pXG5cbiAgQXMgbG9uZyBhcyB0d28gcGVlcnMgYXJlIGNvbm5lY3RlZCB3aXRoIGEgU3luY2hyb25pemVyIG9uIGVhY2ggc2lkZSwgd3JpdGluZyBoYXBwZW5zXG4gIGluIGJvdGggcGVlcnMgaW4gcmVhbCB0aW1lLCBhbmQgcmVhZGluZyBwcm9kdWNlcyB0aGUgY29ycmVjdCBzeW5jaHJvbml6ZWQgcmVzdWx0IGZyb20gZWl0aGVyLlxuICBVbmRlciB0aGUgaG9vZCwgdGhlIHN5bmNocm9uaXplciBrZWVwcyB0cmFjayBvZiB3aGF0IGl0IGtub3dzIGFib3V0IHRoZSBvdGhlciBwZWVyIC0tXG4gIGEgcGFydGljdWxhciB0YWcgY2FuIGJlIHVua25vd24sIHVuc3luY2hyb25pemVkLCBvciBzeW5jaHJvbml6ZWQsIGFuZCByZWFkaW5nIHdpbGxcbiAgY29tbXVuaWNhdGUgYXMgbmVlZGVkIHRvIGdldCB0aGUgZGF0YSBzeW5jaHJvbml6ZWQgb24tZGVtYW5kLiBNZWFud2hpbGUsIHN5bmNocm9uaXphdGlvblxuICBjb250aW51ZXMgaW4gdGhlIGJhY2tncm91bmQgdW50aWwgdGhlIGNvbGxlY3Rpb24gaXMgZnVsbHkgcmVwbGljYXRlZC5cblxuICBBIGNvbGxlY3Rpb24gbWFpbnRhaW5zIGEgc2VwYXJhdGUgU3luY2hyb25pemVyIGZvciBlYWNoIG9mIHplcm8gb3IgbW9yZSBwZWVycywgYW5kIGNhbiBkeW5hbWljYWxseVxuICBhZGQgYW5kIHJlbW92ZSBtb3JlLlxuXG4gIE5hbWluZyBjb252ZW50aW9uczpcblxuICBtdW1ibGVOYW1lOiBhIHNlbWFudGljIG5hbWUgdXNlZCBleHRlcm5hbGx5IGFzIGEga2V5LiBFeGFtcGxlOiBzZXJ2aWNlTmFtZSwgY2hhbm5lbE5hbWUsIGV0Yy5cbiAgICBXaGVuIHRoaW5ncyBuZWVkIHRvIG1hdGNoIHVwIGFjcm9zcyBzeXN0ZW1zLCBpdCBpcyBieSBuYW1lLlxuICAgIElmIG9ubHkgb25lIG9mIG5hbWUvbGFiZWwgaXMgc3BlY2lmaWVkLCB0aGlzIGlzIHVzdWFsbHkgdGhlIHRoZSBvbmUuXG5cbiAgbXVtYmxlTGFiZWw6IGEgbGFiZWwgZm9yIGlkZW50aWZpY2F0aW9uIGFuZCBpbnRlcm5hbGx5IChlLmcuLCBkYXRhYmFzZSBuYW1lKS5cbiAgICBXaGVuIHR3byBpbnN0YW5jZXMgb2Ygc29tZXRoaW5nIGFyZSBcInRoZSBzYW1lXCIgYnV0IGFyZSBpbiB0aGUgc2FtZSBKYXZhc2NyaXB0IGltYWdlIGZvciB0ZXN0aW5nLCB0aGV5IGFyZSBkaXN0aW5ndWlzaGVkIGJ5IGxhYmVsLlxuICAgIFR5cGljYWxseSBkZWZhdWx0cyB0byBtdW1ibGVOYW1lLlxuXG4gIE5vdGUsIHRob3VnaCwgdGhhdCBzb21lIGV4dGVybmFsIG1hY2hpbmVyeSAoc3VjaCBhcyBhIFdlYlJUQyBEYXRhQ2hhbm5lbCkgaGFzIGEgXCJsYWJlbFwiIHByb3BlcnR5IHRoYXQgd2UgcG9wdWxhdGUgd2l0aCBhIFwibmFtZVwiIChjaGFubmVsTmFtZSkuXG4gKi9cbmV4cG9ydCBjbGFzcyBTeW5jaHJvbml6ZXIge1xuICBzdGF0aWMgdmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uO1xuICBjb25zdHJ1Y3Rvcih7c2VydmljZU5hbWUgPSAnZGlyZWN0JywgY29sbGVjdGlvbiwgZXJyb3IgPSBjb2xsZWN0aW9uPy5jb25zdHJ1Y3Rvci5lcnJvciB8fCBjb25zb2xlLmVycm9yLFxuXHQgICAgICAgc2VydmljZUxhYmVsID0gY29sbGVjdGlvbj8uc2VydmljZUxhYmVsIHx8IHNlcnZpY2VOYW1lLCAvLyBVc2VkIHRvIGlkZW50aWZ5IGFueSBleGlzdGluZyBjb25uZWN0aW9uLiBDYW4gYmUgZGlmZmVyZW50IGZyb20gc2VydmljZU5hbWUgZHVyaW5nIHRlc3RpbmcuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgdXVpZCA9IGNvbGxlY3Rpb24/LnV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sIGNvbm5lY3Rpb24sIC8vIENvbXBsZXggZGVmYXVsdCBiZWhhdmlvciBmb3IgdGhlc2UuIFNlZSBjb2RlLlxuXHQgICAgICAgbXVsdGlwbGV4ID0gY29sbGVjdGlvbj8ubXVsdGlwbGV4LCAvLyBJZiBzcGVjaWZlZCwgb3RoZXJ3aXNlIHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LiBTZWUgYmVsb3cuXG5cdCAgICAgICBkZWJ1ZyA9IGNvbGxlY3Rpb24/LmRlYnVnLCBtYXhWZXJzaW9uID0gU3luY2hyb25pemVyLnZlcnNpb24sIG1pblZlcnNpb24gPSBtYXhWZXJzaW9ufSkge1xuICAgIC8vIHNlcnZpY2VOYW1lIGlzIGEgc3RyaW5nIG9yIG9iamVjdCB0aGF0IGlkZW50aWZpZXMgd2hlcmUgdGhlIHN5bmNocm9uaXplciBzaG91bGQgY29ubmVjdC4gRS5nLiwgaXQgbWF5IGJlIGEgVVJMIGNhcnJ5aW5nXG4gICAgLy8gICBXZWJSVEMgc2lnbmFsaW5nLiBJdCBzaG91bGQgYmUgYXBwLXVuaXF1ZSBmb3IgdGhpcyBwYXJ0aWN1bGFyIHNlcnZpY2UgKGUuZy4sIHdoaWNoIG1pZ2h0IG11bHRpcGxleCBkYXRhIGZvciBtdWx0aXBsZSBjb2xsZWN0aW9uIGluc3RhbmNlcykuXG4gICAgLy8gdXVpZCBoZWxwIHVuaXF1ZWx5IGlkZW50aWZpZXMgdGhpcyBwYXJ0aWN1bGFyIHN5bmNocm9uaXplci5cbiAgICAvLyAgIEZvciBtb3N0IHB1cnBvc2VzLCB1dWlkIHNob3VsZCBnZXQgdGhlIGRlZmF1bHQsIGFuZCByZWZlcnMgdG8gT1VSIGVuZC5cbiAgICAvLyAgIEhvd2V2ZXIsIGEgc2VydmVyIHRoYXQgY29ubmVjdHMgdG8gYSBidW5jaCBvZiBwZWVycyBtaWdodCBiYXNoIGluIHRoZSB1dWlkIHdpdGggdGhhdCBvZiB0aGUgb3RoZXIgZW5kLCBzbyB0aGF0IGxvZ2dpbmcgaW5kaWNhdGVzIHRoZSBjbGllbnQuXG4gICAgLy8gSWYgY2hhbm5lbE5hbWUgaXMgc3BlY2lmaWVkLCBpdCBzaG91bGQgYmUgaW4gdGhlIGZvcm0gb2YgY29sbGVjdGlvblR5cGUvY29sbGVjdGlvbk5hbWUgKGUuZy4sIGlmIGNvbm5lY3RpbmcgdG8gcmVsYXkpLlxuICAgIGNvbnN0IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgPSBzZXJ2aWNlTmFtZS5zdGFydHNXaXRoPy4oJ2h0dHAnKTtcbiAgICBpZiAoIWNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgKHJ0Y0NvbmZpZ3VyYXRpb24gPT09IHVuZGVmaW5lZCkpIHJ0Y0NvbmZpZ3VyYXRpb24gPSB7fTsgLy8gRXhwaWNpdGx5IG5vIGljZS4gTEFOIG9ubHkuXG4gICAgLy8gbXVsdGlwbGV4IHNob3VsZCBlbmQgdXAgd2l0aCBvbmUgb2YgdGhyZWUgdmFsdWVzOlxuICAgIC8vIGZhbHN5IC0gYSBuZXcgY29ubmVjdGlvbiBzaG91bGQgYmUgdXNlZCBmb3IgZWFjaCBjaGFubmVsXG4gICAgLy8gXCJuZWdvdGlhdGVkXCIgLSBib3RoIHNpZGVzIGNyZWF0ZSB0aGUgc2FtZSBjaGFubmVsTmFtZXMgaW4gdGhlIHNhbWUgb3JkZXIgKG1vc3QgY2FzZXMpOlxuICAgIC8vICAgICBUaGUgaW5pdGlhbCBzaWduYWxsaW5nIHdpbGwgYmUgdHJpZ2dlcmVkIGJ5IG9uZSBzaWRlIGNyZWF0aW5nIGEgY2hhbm5lbCwgYW5kIHRoZXIgc2lkZSB3YWl0aW5nIGZvciBpdCB0byBiZSBjcmVhdGVkLlxuICAgIC8vICAgICBBZnRlciB0aGF0LCBib3RoIHNpZGVzIHdpbGwgZXhwbGljaXRseSBjcmVhdGUgYSBkYXRhIGNoYW5uZWwgYW5kIHdlYnJ0YyB3aWxsIG1hdGNoIHRoZW0gdXAgYnkgaWQuXG4gICAgLy8gYW55IG90aGVyIHRydXRoeSAtIFN0YXJ0cyBsaWtlIG5lZ290aWF0ZWQsIGFuZCB0aGVuIGNvbnRpbnVlcyB3aXRoIG9ubHkgd2lkZSBzaWRlIGNyZWF0aW5nIHRoZSBjaGFubmVscywgYW5kIHRoZXIgb3RoZXJcbiAgICAvLyAgICAgb2JzZXJ2ZXMgdGhlIGNoYW5uZWwgdGhhdCBoYXMgYmVlbiBtYWRlLiBUaGlzIGlzIHVzZWQgZm9yIHJlbGF5cy5cbiAgICBtdWx0aXBsZXggPz89IGNvbm5lY3Rpb24/Lm11bHRpcGxleDsgLy8gU3RpbGwgdHlwaWNhbGx5IHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LlxuICAgIG11bHRpcGxleCA/Pz0gKHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zeW5jJykgfHwgJ25lZ290aWF0ZWQnKTtcbiAgICBjb25uZWN0aW9uID8/PSBTaGFyZWRXZWJSVEMuZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIGNvbmZpZ3VyYXRpb246IHJ0Y0NvbmZpZ3VyYXRpb24sIG11bHRpcGxleCwgdXVpZCwgZGVidWcsIGVycm9yfSk7XG5cbiAgICB1dWlkID8/PSBjb25uZWN0aW9uLnV1aWQ7XG4gICAgLy8gQm90aCBwZWVycyBtdXN0IGFncmVlIG9uIGNoYW5uZWxOYW1lLiBVc3VhbGx5LCB0aGlzIGlzIGNvbGxlY3Rpb24uZnVsbE5hbWUuIEJ1dCBpbiB0ZXN0aW5nLCB3ZSBtYXkgc3luYyB0d28gY29sbGVjdGlvbnMgd2l0aCBkaWZmZXJlbnQgbmFtZXMuXG4gICAgY2hhbm5lbE5hbWUgPz89IGNvbGxlY3Rpb24/LmNoYW5uZWxOYW1lIHx8IGNvbGxlY3Rpb24uZnVsbE5hbWU7XG4gICAgY29uc3QgbGFiZWwgPSBgJHtjb2xsZWN0aW9uPy5mdWxsTGFiZWwgfHwgY2hhbm5lbE5hbWV9LyR7dXVpZH1gO1xuICAgIC8vIFdoZXJlIHdlIGNhbiByZXF1ZXN0IGEgZGF0YSBjaGFubmVsIHRoYXQgcHVzaGVzIHB1dC9kZWxldGUgcmVxdWVzdHMgZnJvbSBvdGhlcnMuXG4gICAgY29uc3QgY29ubmVjdGlvblVSTCA9IHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zaWduYWwvJykgPyBzZXJ2aWNlTmFtZSA6IGAke3NlcnZpY2VOYW1lfS8ke2xhYmVsfWA7XG5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzZXJ2aWNlTmFtZSwgbGFiZWwsIGNvbGxlY3Rpb24sIGRlYnVnLCBlcnJvciwgbWluVmVyc2lvbiwgbWF4VmVyc2lvbiwgdXVpZCwgcnRjQ29uZmlndXJhdGlvbixcblx0XHRcdCBjb25uZWN0aW9uLCB1dWlkLCBjaGFubmVsTmFtZSwgY29ubmVjdGlvblVSTCxcblx0XHRcdCBjb25uZWN0aW9uU3RhcnRUaW1lOiBEYXRlLm5vdygpLFxuXHRcdFx0IGNsb3NlZDogdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCksXG5cdFx0XHQgLy8gTm90IHVzZWQgeWV0LCBidXQgY291bGQgYmUgdXNlZCB0byBHRVQgcmVzb3VyY2VzIG92ZXIgaHR0cCBpbnN0ZWFkIG9mIHRocm91Z2ggdGhlIGRhdGEgY2hhbm5lbC5cblx0XHRcdCBob3N0UmVxdWVzdEJhc2U6IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgYCR7c2VydmljZU5hbWUucmVwbGFjZSgvXFwvKHN5bmN8c2lnbmFsKS8pfS8ke2NoYW5uZWxOYW1lfWB9KTtcbiAgICBjb2xsZWN0aW9uPy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgdGhpcyk7IC8vIE11c3QgYmUgc2V0IHN5bmNocm9ub3VzbHksIHNvIHRoYXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEga25vd3MgdG8gd2FpdC5cbiAgfVxuICBzdGF0aWMgYXN5bmMgY3JlYXRlKGNvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCBvcHRpb25zID0ge30pIHsgLy8gUmVjZWl2ZSBwdXNoZWQgbWVzc2FnZXMgZnJvbSB0aGUgZ2l2ZW4gc2VydmljZS4gZ2V0L3B1dC9kZWxldGUgd2hlbiB0aGV5IGNvbWUgKHdpdGggZW1wdHkgc2VydmljZXMgbGlzdCkuXG4gICAgY29uc3Qgc3luY2hyb25pemVyID0gbmV3IHRoaXMoe2NvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCAuLi5vcHRpb25zfSk7XG4gICAgY29uc3QgY29ubmVjdGVkUHJvbWlzZSA9IHN5bmNocm9uaXplci5jb25uZWN0Q2hhbm5lbCgpOyAvLyBFc3RhYmxpc2ggY2hhbm5lbCBjcmVhdGlvbiBvcmRlci5cbiAgICBjb25zdCBjb25uZWN0ZWQgPSBhd2FpdCBjb25uZWN0ZWRQcm9taXNlO1xuICAgIGlmICghY29ubmVjdGVkKSByZXR1cm4gc3luY2hyb25pemVyO1xuICAgIHJldHVybiBhd2FpdCBjb25uZWN0ZWQuc3luY2hyb25pemUoKTtcbiAgfVxuICBhc3luYyBjb25uZWN0Q2hhbm5lbCgpIHsgLy8gU3luY2hyb25vdXNseSBpbml0aWFsaXplIGFueSBwcm9taXNlcyB0byBjcmVhdGUgYSBkYXRhIGNoYW5uZWwsIGFuZCB0aGVuIGF3YWl0IGNvbm5lY3Rpb24uXG4gICAgY29uc3Qge2hvc3RSZXF1ZXN0QmFzZSwgdXVpZCwgY29ubmVjdGlvbiwgc2VydmljZU5hbWV9ID0gdGhpcztcbiAgICBsZXQgc3RhcnRlZCA9IGNvbm5lY3Rpb24uaGFzU3RhcnRlZENvbm5lY3Rpbmc7XG4gICAgaWYgKHN0YXJ0ZWQpIHtcbiAgICAgIC8vIFdlIGFscmVhZHkgaGF2ZSBhIGNvbm5lY3Rpb24uIEp1c3Qgb3BlbiBhbm90aGVyIGRhdGEgY2hhbm5lbCBmb3Igb3VyIHVzZS5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zeW5jJykpIHsgLy8gQ29ubmVjdCB3aXRoIGEgc2VydmVyIHJlbGF5LiAoU2lnbmFsIGFuZCBzdGF5IGNvbm5lY3RlZCB0aHJvdWdoIHN5bmMuKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc2lnbmFsL2Fuc3dlcicpKSB7IC8vIFNlZWtpbmcgYW4gYW5zd2VyIHRvIGFuIG9mZmVyIHdlIFBPU1QgKHRvIHJlbmRldm91cyB3aXRoIGEgcGVlcikuXG4gICAgICBzdGFydGVkID0gdGhpcy5jb25uZWN0U2VydmVyKCk7IC8vIEp1c3QgbGlrZSBhIHN5bmNcbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3NpZ25hbC9vZmZlcicpKSB7IC8vIEdFVCBhbiBvZmZlciBmcm9tIGEgcmVuZGV2b3VzIHBlZXIgYW5kIHRoZW4gUE9TVCBhbiBhbnN3ZXIuXG4gICAgICAvLyBXZSBtdXN0IHN5Y2hyb25vdXNseSBzdGFydENvbm5lY3Rpb24gbm93IHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gaGFzU3RhcnRlZENvbm5lY3RpbmcsIGFuZCBhbnkgc3Vic2VxdWVudCBkYXRhIGNoYW5uZWxcbiAgICAgIC8vIHJlcXVlc3RzIG9uIHRoZSBzYW1lIGNvbm5lY3Rpb24gd2lsbCB3YWl0ICh1c2luZyB0aGUgJ3N0YXJ0ZWQnIHBhdGgsIGFib3ZlKS5cbiAgICAgIC8vIENvbXBhcmUgY29ubmVjdFNlcnZlciwgd2hpY2ggaXMgYmFzaWNhbGx5OlxuICAgICAgLy8gICBzdGFydENvbm5lY3Rpb24oKSwgZmV0Y2ggd2l0aCB0aGF0IG9mZmVyLCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCBmZXRjaGVkIGFuc3dlci5cbiAgICAgIGNvbnN0IHByb21pc2VkU2lnbmFscyA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKFtdKTsgLy8gRXN0YWJsaXNoaW5nIG9yZGVyLlxuICAgICAgY29uc3QgdXJsID0gdGhpcy5jb25uZWN0aW9uVVJMO1xuICAgICAgY29uc3Qgb2ZmZXIgPSBhd2FpdCB0aGlzLmZldGNoKHVybCk7XG4gICAgICBjb25zdCBvayA9IHRoaXMuY29tcGxldGVDb25uZWN0aW9uKG9mZmVyKTsgLy8gTm93IHN1cHBseSB0aG9zZSBzaWduYWxzIHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gY2FuIHByb2R1Y2UgYW5zd2VyIHNpZ2Fscy5cbiAgICAgIGNvbnN0IGFuc3dlciA9IGF3YWl0IHByb21pc2VkU2lnbmFscztcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmZldGNoKHVybCwgYW5zd2VyKTsgLy8gUE9TVCBvdXIgYW5zd2VyIHRvIHBlZXIuXG4gICAgfSBlbHNlIGlmIChzZXJ2aWNlTmFtZSA9PT0gJ3NpZ25hbHMnKSB7IC8vIFN0YXJ0IGNvbm5lY3Rpb24gYW5kIHJldHVybiBudWxsLiBNdXN0IGJlIGNvbnRpbnVlZCB3aXRoIGNvbXBsZXRlU2lnbmFsc1N5bmNocm9uaXphdGlvbigpO1xuICAgICAgc3RhcnRlZCA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoc2VydmljZU5hbWUpKSB7IC8vIEEgbGlzdCBvZiBcInJlY2VpdmluZ1wiIHNpZ25hbHMuXG4gICAgICBzdGFydGVkID0gdGhpcy5zdGFydENvbm5lY3Rpb24oc2VydmljZU5hbWUpO1xuICAgIH0gZWxzZSBpZiAoc2VydmljZU5hbWUuc3luY2hyb25pemVycykgeyAvLyBEdWNrIHR5cGluZyBmb3IgcGFzc2luZyBhIGNvbGxlY3Rpb24gZGlyZWN0bHkgYXMgdGhlIHNlcnZpY2VJbmZvLiAoV2UgZG9uJ3QgaW1wb3J0IENvbGxlY3Rpb24uKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdERpcmVjdFRlc3Rpbmcoc2VydmljZU5hbWUpOyAvLyBVc2VkIGluIHRlc3RpbmcuXG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5yZWNvZ25pemVkIHNlcnZpY2UgZm9ybWF0OiAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgaWYgKCEoYXdhaXQgc3RhcnRlZCkpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnY29ubmVjdGlvbiBmYWlsZWQnKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIGdldCBkYXRhQ2hhbm5lbFByb21pc2UoKSB7IC8vIEEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLl9kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgaWYgKCFwcm9taXNlKSB0aHJvdyBuZXcgRXJyb3IoYCR7dGhpcy5sYWJlbH06IERhdGEgY2hhbm5lbCBpcyBub3QgeWV0IHByb21pc2VkLmApO1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGNoYW5uZWxDbG9zZWRDbGVhbnVwKCkgeyAvLyBCb29ra2VlcGluZyB3aGVuIGNoYW5uZWwgY2xvc2VkIG9yIGV4cGxpY2l0bHkgYWJhbmRvbmVkIGJlZm9yZSBvcGVuaW5nLlxuICAgIHRoaXMuY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5kZWxldGUodGhpcy5zZXJ2aWNlTmFtZSk7XG4gICAgdGhpcy5jbG9zZWQucmVzb2x2ZSh0aGlzKTsgLy8gUmVzb2x2ZSB0byBzeW5jaHJvbml6ZXIgaXMgbmljZSBpZiwgZS5nLCBzb21lb25lIGlzIFByb21pc2UucmFjaW5nLlxuICB9XG4gIHNldCBkYXRhQ2hhbm5lbFByb21pc2UocHJvbWlzZSkgeyAvLyBTZXQgdXAgbWVzc2FnZSBhbmQgY2xvc2UgaGFuZGxpbmcuXG4gICAgdGhpcy5fZGF0YUNoYW5uZWxQcm9taXNlID0gcHJvbWlzZS50aGVuKGRhdGFDaGFubmVsID0+IHtcbiAgICAgIGRhdGFDaGFubmVsLm9ubWVzc2FnZSA9IGV2ZW50ID0+IHRoaXMucmVjZWl2ZShldmVudC5kYXRhKTtcbiAgICAgIGRhdGFDaGFubmVsLm9uY2xvc2UgPSBhc3luYyBldmVudCA9PiB0aGlzLmNoYW5uZWxDbG9zZWRDbGVhbnVwKCk7XG4gICAgICByZXR1cm4gZGF0YUNoYW5uZWw7XG4gICAgfSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemUoKSB7XG4gICAgYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG4gIHN0YXRpYyBmcmFnbWVudElkID0gMDtcbiAgYXN5bmMgc2VuZChtZXRob2QsIC4uLnBhcmFtcykgeyAvLyBTZW5kcyB0byB0aGUgcGVlciwgb3ZlciB0aGUgZGF0YSBjaGFubmVsXG4gICAgLy8gVE9ETzogYnJlYWsgdXAgbG9uZyBtZXNzYWdlcy4gKEFzIGEgcHJhY3RpY2FsIG1hdHRlciwgMTYgS2lCIGlzIHRoZSBsb25nZXN0IHRoYXQgY2FuIHJlbGlhYmx5IGJlIHNlbnQgYWNyb3NzIGRpZmZlcmVudCB3cnRjIGltcGxlbWVudGF0aW9ucy4pXG4gICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9XZWJSVENfQVBJL1VzaW5nX2RhdGFfY2hhbm5lbHMjY29uY2VybnNfd2l0aF9sYXJnZV9tZXNzYWdlc1xuICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnN0cmluZ2lmeSh7bWV0aG9kLCBwYXJhbXN9KTtcbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGNvbnN0IHN0YXRlID0gZGF0YUNoYW5uZWw/LnJlYWR5U3RhdGUgfHwgJ2Nsb3NlZCc7XG4gICAgaWYgKHN0YXRlID09PSAnY2xvc2VkJyB8fCBzdGF0ZSA9PT0gJ2Nsb3NpbmcnKSByZXR1cm47XG4gICAgdGhpcy5sb2coJ3NlbmRzJywgbWV0aG9kLCAuLi5wYXJhbXMpO1xuICAgIGNvbnN0IHNpemUgPSAxNmUzOyAvLyBBIGJpdCBsZXNzIHRoYW4gMTYgKiAxMDI0LlxuICAgIGlmIChwYXlsb2FkLmxlbmd0aCA8IHNpemUpIHtcbiAgICAgIGRhdGFDaGFubmVsLnNlbmQocGF5bG9hZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IG51bUNodW5rcyA9IE1hdGguY2VpbChwYXlsb2FkLmxlbmd0aCAvIHNpemUpO1xuICAgIGNvbnN0IGlkID0gdGhpcy5jb25zdHJ1Y3Rvci5mcmFnbWVudElkKys7XG4gICAgY29uc3QgbWV0YSA9IHttZXRob2Q6ICdmcmFnbWVudHMnLCBwYXJhbXM6IFtpZCwgbnVtQ2h1bmtzXX07XG4gICAgLy9jb25zb2xlLmxvZyhgRnJhZ21lbnRpbmcgbWVzc2FnZSAke2lkfSBpbnRvICR7bnVtQ2h1bmtzfSBjaHVua3MuYCwgbWV0YSk7XG4gICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShtZXRhKSk7XG4gICAgLy8gT3B0aW1pemF0aW9uIG9wcG9ydHVuaXR5OiByZWx5IG9uIG1lc3NhZ2VzIGJlaW5nIG9yZGVyZWQgYW5kIHNraXAgcmVkdW5kYW50IGluZm8uIElzIGl0IHdvcnRoIGl0P1xuICAgIGZvciAobGV0IGkgPSAwLCBvID0gMDsgaSA8IG51bUNodW5rczsgKytpLCBvICs9IHNpemUpIHtcbiAgICAgIGNvbnN0IGZyYWcgPSB7bWV0aG9kOiAnZnJhZycsIHBhcmFtczogW2lkLCBpLCBwYXlsb2FkLnN1YnN0cihvLCBzaXplKV19O1xuICAgICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShmcmFnKSk7XG4gICAgfVxuICB9XG4gIHJlY2VpdmUodGV4dCkgeyAvLyBEaXNwYXRjaCBhIG1lc3NhZ2Ugc2VudCBvdmVyIHRoZSBkYXRhIGNoYW5uZWwgZnJvbSB0aGUgcGVlci5cbiAgICBjb25zdCB7bWV0aG9kLCBwYXJhbXN9ID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgICB0aGlzW21ldGhvZF0oLi4ucGFyYW1zKTtcbiAgfVxuICBwZW5kaW5nRnJhZ21lbnRzID0ge307XG4gIGZyYWdtZW50cyhpZCwgbnVtQ2h1bmtzKSB7XG4gICAgLy9jb25zb2xlLmxvZyhgUmVjZWl2aW5nIG1lc2FnZSAke2lkfSBpbiAke251bUNodW5rc30uYCk7XG4gICAgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXSA9IHtyZW1haW5pbmc6IG51bUNodW5rcywgbWVzc2FnZTogQXJyYXkobnVtQ2h1bmtzKX07XG4gIH1cbiAgZnJhZyhpZCwgaSwgZnJhZ21lbnQpIHtcbiAgICBsZXQgZnJhZyA9IHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF07IC8vIFdlIGFyZSByZWx5aW5nIG9uIGZyYWdtZW50IG1lc3NhZ2UgY29taW5nIGZpcnN0LlxuICAgIGZyYWcubWVzc2FnZVtpXSA9IGZyYWdtZW50O1xuICAgIGlmICgwICE9PSAtLWZyYWcucmVtYWluaW5nKSByZXR1cm47XG4gICAgLy9jb25zb2xlLmxvZyhgRGlzcGF0Y2hpbmcgbWVzc2FnZSAke2lkfS5gKTtcbiAgICB0aGlzLnJlY2VpdmUoZnJhZy5tZXNzYWdlLmpvaW4oJycpKTtcbiAgICBkZWxldGUgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXTtcbiAgfVxuXG4gIGFzeW5jIGRpc2Nvbm5lY3QoKSB7IC8vIFdhaXQgZm9yIGRhdGFDaGFubmVsIHRvIGRyYWluIGFuZCByZXR1cm4gYSBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBhY3R1YWxseSBjbG9zZWQsXG4gICAgLy8gYnV0IHJldHVybiBpbW1lZGlhdGVseSBpZiBjb25uZWN0aW9uIG5vdCBzdGFydGVkLlxuICAgIGlmICh0aGlzLmNvbm5lY3Rpb24ucGVlci5jb25uZWN0aW9uU3RhdGUgIT09ICdjb25uZWN0ZWQnKSByZXR1cm4gdGhpcy5jaGFubmVsQ2xvc2VkQ2xlYW51cCh0aGlzLmNvbm5lY3Rpb24uY2xvc2UoKSk7XG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBkYXRhQ2hhbm5lbC5jbG9zZSgpO1xuICAgIHJldHVybiB0aGlzLmNsb3NlZDtcbiAgfVxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGR1cmluZyBzeW5jLlxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGFmdGVyIHN5bmMuXG4gIHN0YXJ0Q29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBNYWNoaW5lcnkgZm9yIG1ha2luZyBhIFdlYlJUQyBjb25uZWN0aW9uIHRvIHRoZSBwZWVyOlxuICAgIC8vICAgSWYgc2lnbmFsTWVzc2FnZXMgaXMgYSBsaXN0IG9mIFtvcGVyYXRpb24sIG1lc3NhZ2VdIG1lc3NhZ2Ugb2JqZWN0cywgdGhlbiB0aGUgb3RoZXIgc2lkZSBpcyBpbml0aWF0aW5nXG4gICAgLy8gdGhlIGNvbm5lY3Rpb24gYW5kIGhhcyBzZW50IGFuIGluaXRpYWwgb2ZmZXIvaWNlLiBJbiB0aGlzIGNhc2UsIHN0YXJ0Q29ubmVjdCgpIHByb21pc2VzIGEgcmVzcG9uc2VcbiAgICAvLyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUuXG4gICAgLy8gICBPdGhlcndpc2UsIHN0YXJ0Q29ubmVjdCgpIHByb21pc2VzIGEgbGlzdCBvZiBpbml0aWFsIHNpZ25hbCBtZXNzYWdlcyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUsXG4gICAgLy8gYW5kIGl0IGlzIG5lY2Vzc2FyeSB0byB0aGVuIGNhbGwgY29tcGxldGVDb25uZWN0aW9uKCkgd2l0aCB0aGUgcmVzcG9uc2UgZnJvbSB0aGVtLlxuICAgIC8vIEluIGJvdGggY2FzZXMsIGFzIGEgc2lkZSBlZmZlY3QsIHRoZSBkYXRhQ2hhbm5lbFByb21pc2UgcHJvcGVydHkgd2lsbCBiZSBzZXQgdG8gYSBQcm9taXNlXG4gICAgLy8gdGhhdCByZXNvbHZlcyB0byB0aGUgZGF0YSBjaGFubmVsIHdoZW4gaXQgaXMgb3BlbnMuIFRoaXMgcHJvbWlzZSBpcyB1c2VkIGJ5IHNlbmQoKSBhbmQgcmVjZWl2ZSgpLlxuICAgIGNvbnN0IHtjb25uZWN0aW9ufSA9IHRoaXM7XG4gICAgdGhpcy5sb2coc2lnbmFsTWVzc2FnZXMgPyAnZ2VuZXJhdGluZyBhbnN3ZXInIDogJ2dlbmVyYXRpbmcgb2ZmZXInKTtcbiAgICB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSwge30sIHNpZ25hbE1lc3NhZ2VzKTtcbiAgICByZXR1cm4gY29ubmVjdGlvbi5zaWduYWxzO1xuICB9XG4gIGNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBGaW5pc2ggd2hhdCB3YXMgc3RhcnRlZCB3aXRoIHN0YXJ0Q29sbGVjdGlvbi5cbiAgICAvLyBEb2VzIG5vdCByZXR1cm4gYSBwcm9taXNlLiBDbGllbnQgY2FuIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlIHRvIHNlZSB3aGVuIHdlIGFyZSBhY3R1YWxseSBjb25uZWN0ZWQuXG4gICAgaWYgKCFzaWduYWxNZXNzYWdlcykgcmV0dXJuIGZhbHNlO1xuICAgIHRoaXMuY29ubmVjdGlvbi5zaWduYWxzID0gc2lnbmFsTWVzc2FnZXM7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBzdGF0aWMgZmV0Y2hKU09OKHVybCwgYm9keSA9IHVuZGVmaW5lZCwgbWV0aG9kID0gbnVsbCkge1xuICAgIGNvbnN0IGhhc0JvZHkgPSBib2R5ICE9PSB1bmRlZmluZWQ7XG4gICAgbWV0aG9kID8/PSBoYXNCb2R5ID8gJ1BPU1QnIDogJ0dFVCc7XG4gICAgcmV0dXJuIGZldGNoKHVybCwgaGFzQm9keSA/IHttZXRob2QsIGhlYWRlcnM6IHtcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIn0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpfSA6IHttZXRob2R9KVxuICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuXHRpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoYCR7cmVzcG9uc2Uuc3RhdHVzVGV4dCB8fCAnRmV0Y2ggZmFpbGVkJ30sIGNvZGUgJHtyZXNwb25zZS5zdGF0dXN9IGluICR7dXJsfS5gKTtcblx0cmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcbiAgICAgIH0pO1xuICB9XG4gIGFzeW5jIGZldGNoKHVybCwgYm9keSA9IHVuZGVmaW5lZCkgeyAvLyBBcyBKU09OXG5cbiAgICBjb25zdCBtZXRob2QgPSBib2R5ID8gJ1BPU1QnIDogJ0dFVCc7XG4gICAgdGhpcy5sb2coJ2ZldGNoJywgbWV0aG9kLCB1cmwsICdzZW5kaW5nOicsIGJvZHkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZmV0Y2hKU09OKHVybCwgYm9keSwgbWV0aG9kKVxuXHQgIC5jYXRjaChlcnJvciA9PiB7XG5cdCAgICB0aGlzLmNsb3NlZC5yZWplY3QoZXJyb3IpO1xuXHQgIH0pO1xuICAgIHRoaXMubG9nKCdmZXRjaCcsIG1ldGhvZCwgdXJsLCAncmVzdWx0OicsIHJlc3VsdCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICBhc3luYyBjb25uZWN0U2VydmVyKHVybCA9IHRoaXMuY29ubmVjdGlvblVSTCkgeyAvLyBDb25uZWN0IHRvIGEgcmVsYXkgb3ZlciBodHRwLiAoL3N5bmMgb3IgL3NpZ25hbC9hbnN3ZXIpXG4gICAgLy8gc3RhcnRDb25uZWN0aW9uLCBQT1NUIG91ciBzaWduYWxzLCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCB0aGUgcmVzcG9uc2UuXG4gICAgLy8gT3VyIHdlYnJ0YyBzeW5jaHJvbml6ZXIgaXMgdGhlbiBjb25uZWN0ZWQgdG8gdGhlIHJlbGF5J3Mgd2VicnQgc3luY2hyb25pemVyLlxuICAgIGNvbnN0IG91clNpZ25hbHNQcm9taXNlID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTsgLy8gbXVzdCBiZSBzeW5jaHJvbm91cyB0byBwcmVzZXJ2ZSBjaGFubmVsIGlkIG9yZGVyLlxuICAgIGNvbnN0IG91clNpZ25hbHMgPSBhd2FpdCBvdXJTaWduYWxzUHJvbWlzZTtcbiAgICBjb25zdCB0aGVpclNpZ25hbHMgPSBhd2FpdCB0aGlzLmZldGNoKHVybCwgb3VyU2lnbmFscyk7IC8vIFBPU1RcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuICBhc3luYyBjb21wbGV0ZVNpZ25hbHNTeW5jaHJvbml6YXRpb24oc2lnbmFscykgeyAvLyBHaXZlbiBhbnN3ZXIvaWNlIHNpZ25hbHMsIGNvbXBsZXRlIHRoZSBjb25uZWN0aW9uIGFuZCBzdGFydCBzeW5jaHJvbml6ZS5cbiAgICBhd2FpdCB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxzKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdERpcmVjdFRlc3RpbmcocGVlckNvbGxlY3Rpb24pIHsgLy8gVXNlZCBpbiB1bml0IHRlc3RpbmcsIHdoZXJlIHRoZSBcInJlbW90ZVwiIHNlcnZpY2UgaXMgc3BlY2lmaWVkIGRpcmVjdGx5IChub3QgYSBzdHJpbmcpLlxuICAgIC8vIEVhY2ggY29sbGVjdGlvbiBpcyBhc2tlZCB0byBzeWNocm9uaXplIHRvIGFub3RoZXIgY29sbGVjdGlvbi5cbiAgICBjb25zdCBwZWVyU3luY2hyb25pemVyID0gcGVlckNvbGxlY3Rpb24uc3luY2hyb25pemVycy5nZXQodGhpcy5jb2xsZWN0aW9uKTtcbiAgICBpZiAoIXBlZXJTeW5jaHJvbml6ZXIpIHsgLy8gVGhlIG90aGVyIHNpZGUgZG9lc24ndCBrbm93IGFib3V0IHVzIHlldC4gVGhlIG90aGVyIHNpZGUgd2lsbCBkbyB0aGUgd29yay5cbiAgICAgIHRoaXMuX2RlbGF5ID0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IG91clNpZ25hbHMgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbigpO1xuICAgIGNvbnN0IHRoZWlyU2lnbmFscyA9IGF3YWl0IHBlZXJTeW5jaHJvbml6ZXIuc3RhcnRDb25uZWN0aW9uKGF3YWl0IG91clNpZ25hbHMpO1xuICAgIHBlZXJTeW5jaHJvbml6ZXIuX2RlbGF5LnJlc29sdmUoKTtcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuXG4gIC8vIEEgY29tbW9uIHByYWN0aWNlIGhlcmUgaXMgdG8gaGF2ZSBhIHByb3BlcnR5IHRoYXQgaXMgYSBwcm9taXNlIGZvciBoYXZpbmcgc29tZXRoaW5nIGRvbmUuXG4gIC8vIEFzeW5jaHJvbm91cyBtYWNoaW5lcnkgY2FuIHRoZW4gcmVzb2x2ZSBpdC5cbiAgLy8gQW55dGhpbmcgdGhhdCBkZXBlbmRzIG9uIHRoYXQgY2FuIGF3YWl0IHRoZSByZXNvbHZlZCB2YWx1ZSwgd2l0aG91dCB3b3JyeWluZyBhYm91dCBob3cgaXQgZ2V0cyByZXNvbHZlZC5cbiAgLy8gV2UgY2FjaGUgdGhlIHByb21pc2Ugc28gdGhhdCB3ZSBkbyBub3QgcmVwZXRlZGx5IHRyaWdnZXIgdGhlIHVuZGVybHlpbmcgYWN0aW9uLlxuICBtYWtlUmVzb2x2ZWFibGVQcm9taXNlKGlnbm9yZWQpIHsgLy8gQW5zd2VyIGEgUHJvbWlzZSB0aGF0IGNhbiBiZSByZXNvbHZlIHdpdGggdGhlUHJvbWlzZS5yZXNvbHZlKHZhbHVlKS5cbiAgICAvLyBUaGUgaWdub3JlZCBhcmd1bWVudCBpcyBhIGNvbnZlbmllbnQgcGxhY2UgdG8gY2FsbCBzb21ldGhpbmcgZm9yIHNpZGUtZWZmZWN0LlxuICAgIGxldCByZXNvbHZlciwgcmVqZWN0ZXI7XG4gICAgY29uc3QgcHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsgcmVzb2x2ZXIgPSByZXNvbHZlOyByZWplY3RlciA9IHJlamVjdDsgfSk7XG4gICAgcHJvbWlzZS5yZXNvbHZlID0gcmVzb2x2ZXI7XG4gICAgcHJvbWlzZS5yZWplY3QgPSByZWplY3RlcjtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIHZlcnNpb25zKG1pbiwgbWF4KSB7IC8vIE9uIHJlY2VpdmluZyB0aGUgdmVyc2lvbnMgc3VwcG9ydGVkIGJ5IHRoZSB0aGUgcGVlciwgcmVzb2x2ZSB0aGUgdmVyc2lvbiBwcm9taXNlLlxuICAgIGxldCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbjtcbiAgICBjb25zdCBjb21iaW5lZE1heCA9IE1hdGgubWluKG1heCwgdGhpcy5tYXhWZXJzaW9uKTtcbiAgICBjb25zdCBjb21iaW5lZE1pbiA9IE1hdGgubWF4KG1pbiwgdGhpcy5taW5WZXJzaW9uKTtcbiAgICBpZiAoY29tYmluZWRNYXggPj0gY29tYmluZWRNaW4pIHJldHVybiB2ZXJzaW9uUHJvbWlzZS5yZXNvbHZlKGNvbWJpbmVkTWF4KTsgLy8gTm8gbmVlZCB0byByZXNwb25kLCBhcyB0aGV5IHdpbGwgcHJvZHVjZSB0aGUgc2FtZSBkZXRlcm1pbmlzdGljIGFuc3dlci5cbiAgICByZXR1cm4gdmVyc2lvblByb21pc2UucmVzb2x2ZSgwKTtcbiAgfVxuICBnZXQgdmVyc2lvbigpIHsgLy8gUHJvbWlzZSB0aGUgaGlnaGVzdCB2ZXJzaW9uIHN1cG9ydGVkIGJ5IGJvdGggc2lkZXMsIG9yIGRpc2Nvbm5lY3QgYW5kIGZhbHN5IGlmIG5vbmUuXG4gICAgLy8gVGVsbHMgdGhlIG90aGVyIHNpZGUgb3VyIHZlcnNpb25zIGlmIHdlIGhhdmVuJ3QgeWV0IGRvbmUgc28uXG4gICAgLy8gRklYTUU6IGNhbiB3ZSBhdm9pZCB0aGlzIHRpbWVvdXQ/XG4gICAgcmV0dXJuIHRoaXMuX3ZlcnNpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZShzZXRUaW1lb3V0KCgpID0+IHRoaXMuc2VuZCgndmVyc2lvbnMnLCB0aGlzLm1pblZlcnNpb24sIHRoaXMubWF4VmVyc2lvbiksIDIwMCkpO1xuICB9XG5cbiAgZ2V0IHN0YXJ0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGhhdmUgc3RhcnRlZCBzeW5jaHJvbml6YXRpb24uXG4gICAgcmV0dXJuIHRoaXMuX3N0YXJ0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMuc3RhcnRTeW5jaHJvbml6YXRpb24oKTtcbiAgfVxuICBnZXQgY29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG51bWJlciBvZiBpdGVtcyB0aGF0IHdlcmUgdHJhbnNmZXJyZWQgKG5vdCBuZWNlc3NhcmlsbHkgd3JpdHRlbikuXG4gICAgLy8gU3RhcnRzIHN5bmNocm9uaXphdGlvbiBpZiBpdCBoYXNuJ3QgYWxyZWFkeS4gRS5nLiwgd2FpdGluZyBvbiBjb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gd29uJ3QgcmVzb2x2ZSB1bnRpbCBhZnRlciBpdCBzdGFydHMuXG4gICAgcmV0dXJuIHRoaXMuX2NvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbik7XG4gIH1cbiAgZ2V0IHBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbnVtYmVyIG9mIGl0ZW1zIHRoYXQgdGhlIHBlZXIgc3luY2hyb25pemVkLlxuICAgIHJldHVybiB0aGlzLl9wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UoKTtcbiAgfVxuICBnZXQgYm90aFNpZGVzQ29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHJlc29sdmVzIHRydXRoeSB3aGVuIGJvdGggc2lkZXMgYXJlIGRvbmUuXG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVkU3luY2hyb25pemF0aW9uLnRoZW4oKCkgPT4gdGhpcy5wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uKTtcbiAgfVxuICBhc3luYyByZXBvcnRDb25uZWN0aW9uKCkgeyAvLyBMb2cgY29ubmVjdGlvbiB0aW1lIGFuZCB0eXBlLlxuICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgdGhpcy5jb25uZWN0aW9uLnBlZXIuZ2V0U3RhdHMoKTtcbiAgICBsZXQgdHJhbnNwb3J0O1xuICAgIGZvciAoY29uc3QgcmVwb3J0IG9mIHN0YXRzLnZhbHVlcygpKSB7XG4gICAgICBpZiAocmVwb3J0LnR5cGUgPT09ICd0cmFuc3BvcnQnKSB7XG5cdHRyYW5zcG9ydCA9IHJlcG9ydDtcblx0YnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGxldCBjYW5kaWRhdGVQYWlyID0gdHJhbnNwb3J0ICYmIHN0YXRzLmdldCh0cmFuc3BvcnQuc2VsZWN0ZWRDYW5kaWRhdGVQYWlySWQpO1xuICAgIGlmICghY2FuZGlkYXRlUGFpcikgeyAvLyBTYWZhcmkgZG9lc24ndCBmb2xsb3cgdGhlIHN0YW5kYXJkLlxuICAgICAgZm9yIChjb25zdCByZXBvcnQgb2Ygc3RhdHMudmFsdWVzKCkpIHtcblx0aWYgKChyZXBvcnQudHlwZSA9PT0gJ2NhbmRpZGF0ZS1wYWlyJykgJiYgcmVwb3J0LnNlbGVjdGVkKSB7XG5cdCAgY2FuZGlkYXRlUGFpciA9IHJlcG9ydDtcblx0ICBicmVhaztcblx0fVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIWNhbmRpZGF0ZVBhaXIpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnZ290IHN0YXRzIHdpdGhvdXQgY2FuZGlkYXRlUGFpcicsIEFycmF5LmZyb20oc3RhdHMudmFsdWVzKCkpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVtb3RlID0gc3RhdHMuZ2V0KGNhbmRpZGF0ZVBhaXIucmVtb3RlQ2FuZGlkYXRlSWQpO1xuICAgIGNvbnN0IHtwcm90b2NvbCwgY2FuZGlkYXRlVHlwZX0gPSByZW1vdGU7XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzdGF0cywgdHJhbnNwb3J0LCBjYW5kaWRhdGVQYWlyLCByZW1vdGUsIHByb3RvY29sLCBjYW5kaWRhdGVUeXBlLCBzeW5jaHJvbml6YXRpb25TdGFydFRpbWU6IG5vd30pO1xuICAgIGNvbnNvbGUuaW5mbyh0aGlzLmxhYmVsLCAnY29ubmVjdGVkJywgcHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGUsICgobm93IC0gdGhpcy5jb25uZWN0aW9uU3RhcnRUaW1lKS8xZTMpLnRvRml4ZWQoMSkpO1xuICB9XG4gIGFzeW5jIHN0YXJ0U3luY2hyb25pemF0aW9uKCkgeyAvLyBXYWl0IGZvciBhbGwgcHJlbGltaW5hcmllcywgYW5kIHN0YXJ0IHN0cmVhbWluZyBvdXIgdGFncy5cbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGlmICghZGF0YUNoYW5uZWwpIHRocm93IG5ldyBFcnJvcihgTm8gY29ubmVjdGlvbiBmb3IgJHt0aGlzLmxhYmVsfS5gKTtcbiAgICAvLyBOb3cgdGhhdCB3ZSBhcmUgY29ubmVjdGVkLCBhbnkgbmV3IHdyaXRlcyBvbiBvdXIgZW5kIHdpbGwgYmUgcHVzaGVkIHRvIHRoZSBwZWVyLiBTbyBjYXB0dXJlIHRoZSBpbml0aWFsIHRhZ3Mgbm93LlxuICAgIGNvbnN0IG91clRhZ3MgPSBuZXcgU2V0KGF3YWl0IHRoaXMuY29sbGVjdGlvbi50YWdzKTtcbiAgICBhd2FpdCB0aGlzLnJlcG9ydENvbm5lY3Rpb24oKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtcblxuICAgICAgLy8gQSBzbmFwc2hvdCBTZXQgb2YgZWFjaCB0YWcgd2UgaGF2ZSBsb2NhbGx5LCBjYXB0dXJlZCBhdCB0aGUgbW9tZW50IG9mIGNyZWF0aW9uLlxuICAgICAgb3VyVGFncywgLy8gKE5ldyBsb2NhbCB3cml0ZXMgYXJlIHB1c2hlZCB0byB0aGUgY29ubmVjdGVkIHBlZXIsIGV2ZW4gZHVyaW5nIHN5bmNocm9uaXphdGlvbi4pXG5cbiAgICAgIC8vIE1hcCBvZiB0YWcgdG8gcHJvbWlzZSBmb3IgdGFncyB0aGF0IGFyZSBiZWluZyBzeW5jaHJvbml6ZWQuXG4gICAgICAvLyBlbnN1cmVTeW5jaHJvbml6ZWRUYWcgZW5zdXJlcyB0aGF0IHRoZXJlIGlzIGFuIGVudHJ5IGhlcmUgZHVyaW5nIHRoZSB0aW1lIGEgdGFnIGlzIGluIGZsaWdodC5cbiAgICAgIHVuc3luY2hyb25pemVkOiBuZXcgTWFwKCksXG5cbiAgICAgIC8vIFNldCBvZiB3aGF0IHRhZ3MgaGF2ZSBiZWVuIGV4cGxpY2l0bHkgc3luY2hyb25pemVkLCBtZWFuaW5nIHRoYXQgdGhlcmUgaXMgYSBkaWZmZXJlbmNlIGJldHdlZW4gdGhlaXIgaGFzaFxuICAgICAgLy8gYW5kIG91cnMsIHN1Y2ggdGhhdCB3ZSBhc2sgZm9yIHRoZWlyIHNpZ25hdHVyZSB0byBjb21wYXJlIGluIGRldGFpbC4gVGh1cyB0aGlzIHNldCBtYXkgaW5jbHVkZSBpdGVtcyB0aGF0XG4gICAgICBjaGVja2VkVGFnczogbmV3IFNldCgpLCAvLyB3aWxsIG5vdCBlbmQgdXAgYmVpbmcgcmVwbGFjZWQgb24gb3VyIGVuZC5cblxuICAgICAgZW5kT2ZQZWVyVGFnczogZmFsc2UgLy8gSXMgdGhlIHBlZXIgZmluaXNoZWQgc3RyZWFtaW5nP1xuICAgIH0pO1xuICAgIC8vIE5vdyBuZWdvdGlhdGUgdmVyc2lvbiBhbmQgY29sbGVjdHMgdGhlIHRhZ3MuXG4gICAgY29uc3QgdmVyc2lvbiA9IGF3YWl0IHRoaXMudmVyc2lvbjtcbiAgICBpZiAoIXZlcnNpb24pIHsgIC8vIE1pc21hdGNoLlxuICAgICAgLy8gS2x1ZGdlIDE6IHdoeSBkb2Vzbid0IHRoaXMuZGlzY29ubmVjdCgpIGNsZWFuIHVwIHRoZSB2YXJpb3VzIHByb21pc2VzIHByb3Blcmx5P1xuICAgICAgYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UudGhlbihjaGFubmVsID0+IGNoYW5uZWwuY2xvc2UoKSk7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYCR7dGhpcy5zZXJ2aWNlTmFtZX0gZG9lcyBub3QgdXNlIGEgY29tcGF0aWJsZSB2ZXJzaW9uLmA7XG4gICAgICBjb25zb2xlLmVycm9yKG1lc3NhZ2UsIHRoaXMuY29ubmVjdGlvbi5ub3RpZmllZCk7XG4gICAgICBpZiAoKHR5cGVvZih3aW5kb3cpICE9PSAndW5kZWZpbmVkJykgJiYgIXRoaXMuY29ubmVjdGlvbi5ub3RpZmllZCkgeyAvLyBJZiB3ZSdyZSBpbiBhIGJyb3dzZXIsIHRlbGwgdGhlIHVzZXIgb25jZS5cblx0dGhpcy5jb25uZWN0aW9uLm5vdGlmaWVkID0gdHJ1ZTtcblx0d2luZG93LmFsZXJ0KG1lc3NhZ2UpO1xuXHRzZXRUaW1lb3V0KCgpID0+IGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb24ubm90aWZpZWQsIDEwKTsgLy8gS2x1ZGdlIDIuXG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuc3RyZWFtVGFncyhvdXJUYWdzKTsgLy8gQnV0IGRvIG5vdCB3YWl0IGZvciBpdC5cbiAgfVxuICBhc3luYyBjb21wdXRlSGFzaCh0ZXh0KSB7IC8vIE91ciBzdGFuZGFyZCBoYXNoLiAoU3RyaW5nIHNvIHRoYXQgaXQgaXMgc2VyaWFsaXphYmxlLilcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgQ3JlZGVudGlhbHMuaGFzaFRleHQodGV4dCk7XG4gICAgcmV0dXJuIENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChoYXNoKTtcbiAgfVxuICBhc3luYyBnZXRIYXNoKHRhZykgeyAvLyBXaG9sZSBzaWduYXR1cmUgKE5PVCBwcm90ZWN0ZWRIZWFkZXIuc3ViIG9mIGNvbnRlbnQpLlxuICAgIGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMuY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgICByZXR1cm4gdGhpcy5jb21wdXRlSGFzaChyYXcgfHwgJ21pc3NpbmcnKTtcbiAgfVxuICBhc3luYyBzdHJlYW1UYWdzKHRhZ3MpIHsgLy8gU2VuZCBlYWNoIG9mIG91ciBrbm93biB0YWcvaGFzaCBwYWlycyB0byBwZWVyLCBvbmUgYXQgYSB0aW1lLCBmb2xsb3dlZCBieSBlbmRPZlRhZ3MuXG4gICAgZm9yIChjb25zdCB0YWcgb2YgdGFncykge1xuICAgICAgdGhpcy5zZW5kKCdoYXNoJywgdGFnLCBhd2FpdCB0aGlzLmdldEhhc2godGFnKSk7XG4gICAgfVxuICAgIHRoaXMuc2VuZCgnZW5kVGFncycpO1xuICB9XG4gIGFzeW5jIGVuZFRhZ3MoKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBzdHJlYW1UYWdzKCkuXG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHRoaXMuZW5kT2ZQZWVyVGFncyA9IHRydWU7XG4gICAgdGhpcy5jbGVhblVwSWZGaW5pc2hlZCgpO1xuICB9XG4gIHN5bmNocm9uaXphdGlvbkNvbXBsZXRlKG5DaGVja2VkKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBnZXR0aW5nIGFsbCB0aGUgZGF0YSBpdCBuZWVkcyBmcm9tIHVzLlxuICAgIHRoaXMucGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBjbGVhblVwSWZGaW5pc2hlZCgpIHsgLy8gSWYgd2UgYXJlIG5vdCB3YWl0aW5nIGZvciBhbnl0aGluZywgd2UncmUgZG9uZS4gQ2xlYW4gdXAuXG4gICAgLy8gVGhpcyByZXF1aXJlcyB0aGF0IHRoZSBwZWVyIGhhcyBpbmRpY2F0ZWQgdGhhdCBpdCBpcyBmaW5pc2hlZCBzdHJlYW1pbmcgdGFncyxcbiAgICAvLyBhbmQgdGhhdCB3ZSBhcmUgbm90IHdhaXRpbmcgZm9yIGFueSBmdXJ0aGVyIHVuc3luY2hyb25pemVkIGl0ZW1zLlxuICAgIGlmICghdGhpcy5lbmRPZlBlZXJUYWdzIHx8IHRoaXMudW5zeW5jaHJvbml6ZWQuc2l6ZSkgcmV0dXJuO1xuICAgIGNvbnN0IG5DaGVja2VkID0gdGhpcy5jaGVja2VkVGFncy5zaXplOyAvLyBUaGUgbnVtYmVyIHRoYXQgd2UgY2hlY2tlZC5cbiAgICB0aGlzLnNlbmQoJ3N5bmNocm9uaXphdGlvbkNvbXBsZXRlJywgbkNoZWNrZWQpO1xuICAgIHRoaXMuY2hlY2tlZFRhZ3MuY2xlYXIoKTtcbiAgICB0aGlzLnVuc3luY2hyb25pemVkLmNsZWFyKCk7XG4gICAgdGhpcy5vdXJUYWdzID0gdGhpcy5zeW5jaHJvbml6ZWQgPSB0aGlzLnVuc3luY2hyb25pemVkID0gbnVsbDtcbiAgICBjb25zb2xlLmluZm8odGhpcy5sYWJlbCwgJ2NvbXBsZXRlZCBzeW5jaHJvbml6YXRpb24nLCBuQ2hlY2tlZCwgJ2l0ZW1zIGluJywgKChEYXRlLm5vdygpIC0gdGhpcy5zeW5jaHJvbml6YXRpb25TdGFydFRpbWUpLzFlMykudG9GaXhlZCgxKSwgJ3NlY29uZHMnKTtcbiAgICB0aGlzLmNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBzeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykgeyAvLyBSZXR1cm4gc29tZXRoaW5nIHRvIGF3YWl0IHRoYXQgcmVzb2x2ZXMgd2hlbiB0YWcgaXMgc3luY2hyb25pemVkLlxuICAgIC8vIFdoZW5ldmVyIGEgY29sbGVjdGlvbiBuZWVkcyB0byByZXRyaWV2ZSAoZ2V0VmVyaWZpZWQpIGEgdGFnIG9yIGZpbmQgdGFncyBtYXRjaGluZyBwcm9wZXJ0aWVzLCBpdCBlbnN1cmVzXG4gICAgLy8gdGhlIGxhdGVzdCBkYXRhIGJ5IGNhbGxpbmcgdGhpcyBhbmQgYXdhaXRpbmcgdGhlIGRhdGEuXG4gICAgaWYgKCF0aGlzLnVuc3luY2hyb25pemVkKSByZXR1cm4gdHJ1ZTsgLy8gV2UgYXJlIGZ1bGx5IHN5bmNocm9uaXplZCBhbGwgdGFncy4gSWYgdGhlcmUgaXMgbmV3IGRhdGEsIGl0IHdpbGwgYmUgc3BvbnRhbmVvdXNseSBwdXNoZWQgdG8gdXMuXG4gICAgaWYgKHRoaXMuY2hlY2tlZFRhZ3MuaGFzKHRhZykpIHJldHVybiB0cnVlOyAvLyBUaGlzIHBhcnRpY3VsYXIgdGFnIGhhcyBiZWVuIGNoZWNrZWQuXG4gICAgICAvLyAoSWYgY2hlY2tlZFRhZ3Mgd2FzIG9ubHkgdGhvc2UgZXhjaGFuZ2VkIG9yIHdyaXR0ZW4sIHdlIHdvdWxkIGhhdmUgZXh0cmEgZmxpZ2h0cyBjaGVja2luZy4pXG4gICAgLy8gSWYgYSByZXF1ZXN0IGlzIGluIGZsaWdodCwgcmV0dXJuIHRoYXQgcHJvbWlzZS4gT3RoZXJ3aXNlIGNyZWF0ZSBvbmUuXG4gICAgcmV0dXJuIHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZykgfHwgdGhpcy5lbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCAnJywgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG5cbiAgYXN5bmMgaGFzaCh0YWcsIGhhc2gpIHsgLy8gUmVjZWl2ZSBhIFt0YWcsIGhhc2hdIHRoYXQgdGhlIHBlZXIga25vd3MgYWJvdXQuIChQZWVyIHN0cmVhbXMgemVybyBvciBtb3JlIG9mIHRoZXNlIHRvIHVzLilcbiAgICAvLyBVbmxlc3MgYWxyZWFkeSBpbiBmbGlnaHQsIHdlIHdpbGwgZW5zdXJlU3luY2hyb25pemVkVGFnIHRvIHN5bmNocm9uaXplIGl0LlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICBjb25zdCB7b3VyVGFncywgdW5zeW5jaHJvbml6ZWR9ID0gdGhpcztcbiAgICB0aGlzLmxvZygncmVjZWl2ZWQgXCJoYXNoXCInLCB7dGFnLCBoYXNoLCBvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0pO1xuICAgIGlmICh1bnN5bmNocm9uaXplZC5oYXModGFnKSkgcmV0dXJuIG51bGw7IC8vIEFscmVhZHkgaGFzIGFuIGludmVzdGlnYXRpb24gaW4gcHJvZ3Jlc3MgKGUuZywgZHVlIHRvIGxvY2FsIGFwcCBzeW5jaHJvbml6YXRpb25Qcm9taXNlKS5cbiAgICBpZiAoIW91clRhZ3MuaGFzKHRhZykpIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gpOyAvLyBXZSBkb24ndCBoYXZlIHRoZSByZWNvcmQgYXQgYWxsLlxuICAgIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gsIHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgfVxuICBlbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCB0aGVpckhhc2ggPSAnJywgb3VySGFzaFByb21pc2UgPSBudWxsKSB7XG4gICAgLy8gU3luY2hyb25vdXNseSByZWNvcmQgKGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXApIGEgcHJvbWlzZSB0byAoY29uY2VwdHVhbGx5KSByZXF1ZXN0IHRoZSB0YWcgZnJvbSB0aGUgcGVlcixcbiAgICAvLyBwdXQgaXQgaW4gdGhlIGNvbGxlY3Rpb24sIGFuZCBjbGVhbnVwIHRoZSBib29ra2VlcGluZy4gUmV0dXJuIHRoYXQgcHJvbWlzZS5cbiAgICAvLyBIb3dldmVyLCBpZiB3ZSBhcmUgZ2l2ZW4gaGFzaGVzIHRvIGNvbXBhcmUgYW5kIHRoZXkgbWF0Y2gsIHdlIGNhbiBza2lwIHRoZSByZXF1ZXN0L3B1dCBhbmQgcmVtb3ZlIGZyb20gdW5zeWNocm9uaXplZCBvbiBuZXh0IHRpY2suXG4gICAgLy8gKFRoaXMgbXVzdCByZXR1cm4gYXRvbWljYWxseSBiZWNhdXNlIGNhbGxlciBoYXMgY2hlY2tlZCB2YXJpb3VzIGJvb2trZWVwaW5nIGF0IHRoYXQgbW9tZW50LiBDaGVja2luZyBtYXkgcmVxdWlyZSB0aGF0IHdlIGF3YWl0IG91ckhhc2hQcm9taXNlLilcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHsgLy8gTmV4dCB0aWNrLiBTZWUgcmVxdWVzdCgpLlxuXHRpZiAoIXRoZWlySGFzaCB8fCAhb3VySGFzaFByb21pc2UgfHwgKHRoZWlySGFzaCAhPT0gYXdhaXQgb3VySGFzaFByb21pc2UpKSB7XG5cdCAgY29uc3QgdGhlaXJEYXRhID0gYXdhaXQgdGhpcy5yZXF1ZXN0KHRhZyk7XG5cdCAgLy8gTWlnaHQgaGF2ZSBiZWVuIHRyaWdnZXJlZCBieSBvdXIgYXBwIHJlcXVlc3RpbmcgdGhpcyB0YWcgYmVmb3JlIHdlIHdlcmUgc3luYydkLiBTbyB0aGV5IG1pZ2h0IG5vdCBoYXZlIHRoZSBkYXRhLlxuXHQgIGlmICghdGhlaXJIYXNoIHx8IHRoZWlyRGF0YT8ubGVuZ3RoKSB7XG5cdCAgICBpZiAoYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnB1dCh0YWcsIHRoZWlyRGF0YSwgdGhpcykpIHtcblx0ICAgICAgdGhpcy5sb2coJ3JlY2VpdmVkL3B1dCcsIHRhZywgJ3RoZWlyL291ciBoYXNoOicsIHRoZWlySGFzaCB8fCAnbWlzc2luZ1RoZWlycycsIChhd2FpdCBvdXJIYXNoUHJvbWlzZSkgfHwgJ21pc3NpbmdPdXJzJywgdGhlaXJEYXRhPy5sZW5ndGgpO1xuXHQgICAgfSBlbHNlIHtcblx0ICAgICAgdGhpcy5sb2coJ3VuYWJsZSB0byBwdXQnLCB0YWcpO1xuXHQgICAgfVxuXHQgIH1cblx0fVxuXHR0aGlzLmNoZWNrZWRUYWdzLmFkZCh0YWcpOyAgICAgICAvLyBFdmVyeXRoaW5nIHdlJ3ZlIGV4YW1pbmVkLCByZWdhcmRsZXNzIG9mIHdoZXRoZXIgd2UgYXNrZWQgZm9yIG9yIHNhdmVkIGRhdGEgZnJvbSBwZWVyLiAoU2VlIHN5bmNocm9uaXphdGlvblByb21pc2UpXG5cdHRoaXMudW5zeW5jaHJvbml6ZWQuZGVsZXRlKHRhZyk7IC8vIFVuY29uZGl0aW9uYWxseSwgYmVjYXVzZSB3ZSBzZXQgaXQgdW5jb25kaXRpb25hbGx5LlxuXHR0aGlzLmNsZWFuVXBJZkZpbmlzaGVkKCk7XG5cdHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMudW5zeW5jaHJvbml6ZWQuc2V0KHRhZywgcHJvbWlzZSk7IC8vIFVuY29uZGl0aW9uYWxseSwgaW4gY2FzZSB3ZSBuZWVkIHRvIGtub3cgd2UncmUgbG9va2luZyBkdXJpbmcgdGhlIHRpbWUgd2UncmUgbG9va2luZy5cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXF1ZXN0KHRhZykgeyAvLyBNYWtlIGEgcmVxdWVzdCBmb3IgdGFnIGZyb20gdGhlIHBlZXIsIGFuZCBhbnN3ZXIgYSBwcm9taXNlIHRoZSByZXNvbHZlcyB3aXRoIHRoZSBkYXRhLlxuICAgIC8qY29uc3QgeyBob3N0UmVxdWVzdEJhc2UgfSA9IHRoaXM7XG4gICAgaWYgKGhvc3RSZXF1ZXN0QmFzZSkge1xuICAgICAgLy8gRS5nLiwgYSBsb2NhbGhvc3Qgcm91dGVyIG1pZ2h0IHN1cHBvcnQgYSBnZXQgb2YgaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyL190L3VML0JBY1dfTE5BSmEvY0pXbXVtYmxlXG4gICAgICAvLyBTbyBob3N0UmVxdWVzdEJhc2Ugc2hvdWxkIGJlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyXCIsXG4gICAgICAvLyBhbmQgc2VydmljZU5hbWUgc2hvdWxkIGJlIHNvbWV0aGluZyBsaWtlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9zeW5jXCJcbiAgICAgIHJldHVybiBmZXRjaCh0YWdQYXRoKGhvc3RSZXF1ZXN0QmFzZSwgdGFnKSkudGhlbihyZXNwb25zZSA9PiByZXNwb25zZS50ZXh0KCkpO1xuICAgIH0qL1xuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UodGhpcy5zZW5kKCdnZXQnLCB0YWcpKTtcbiAgICAvLyBTdWJ0bGU6IFdoZW4gdGhlICdwdXQnIGNvbWVzIGJhY2ssIHdlIHdpbGwgbmVlZCB0byByZXNvbHZlIHRoaXMgcHJvbWlzZS4gQnV0IGhvdyB3aWxsICdwdXQnIGZpbmQgdGhlIHByb21pc2UgdG8gcmVzb2x2ZSBpdD9cbiAgICAvLyBBcyBpdCB0dXJucyBvdXQsIHRvIGdldCBoZXJlLCB3ZSBoYXZlIG5lY2Vzc2FyaWxseSBzZXQgdGFnIGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXAuIFxuICAgIGNvbnN0IG5vdGVkID0gdGhpcy51bnN5bmNocm9uaXplZC5nZXQodGFnKTsgLy8gQSBwcm9taXNlIHRoYXQgZG9lcyBub3QgaGF2ZSBhbiBleHBvc2VkIC5yZXNvbHZlLCBhbmQgd2hpY2ggZG9lcyBub3QgZXhwZWN0IGFueSB2YWx1ZS5cbiAgICBub3RlZC5yZXNvbHZlID0gcHJvbWlzZS5yZXNvbHZlOyAvLyBUYWNrIG9uIGEgcmVzb2x2ZSBmb3IgT1VSIHByb21pc2Ugb250byB0aGUgbm90ZWQgb2JqZWN0ICh3aGljaCBjb25mdXNpbmdseSwgaGFwcGVucyB0byBiZSBhIHByb21pc2UpLlxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gUmVzcG9uZCB0byBhIHBlZXIncyBnZXQoKSByZXF1ZXN0IGJ5IHNlbmRpbmcgYSBwdXQgcmVwb25zZSB3aXRoIHRoZSBkYXRhLlxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gICAgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIGRhdGEpO1xuICB9XG4gIHB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSkgeyAvLyBUZWxsIHRoZSBvdGhlciBzaWRlIGFib3V0IGEgc2lnbmVkIHdyaXRlLlxuICAgIHRoaXMuc2VuZChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKTtcbiAgfVxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUpIHsgLy8gUmVjZWl2ZSBhIHB1dCBtZXNzYWdlIGZyb20gdGhlIHBlZXIuXG4gICAgLy8gSWYgaXQgaXMgYSByZXNwb25zZSB0byBhIGdldCgpIHJlcXVlc3QsIHJlc29sdmUgdGhlIGNvcnJlc3BvbmRpbmcgcHJvbWlzZS5cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy51bnN5bmNocm9uaXplZD8uZ2V0KHRhZyk7XG4gICAgLy8gUmVnYXJkbGVzcyBvZiB3aHkgdGhlIG90aGVyIHNpZGUgaXMgc2VuZGluZywgaWYgd2UgaGF2ZSBhbiBvdXRzdGFuZGluZyByZXF1ZXN0LCBjb21wbGV0ZSBpdC5cbiAgICBpZiAocHJvbWlzZSkgcHJvbWlzZS5yZXNvbHZlKHNpZ25hdHVyZSk7XG4gICAgZWxzZSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24ucHV0KHRhZywgc2lnbmF0dXJlLCB0aGlzKTsgLy8gT3RoZXJ3aXNlLCBqdXN0IHRyeSB0byB3cml0ZSBpdCBsb2NhbGx5LlxuICB9XG4gIGRlbGV0ZSh0YWcsIHNpZ25hdHVyZSkgeyAvLyBSZWNlaXZlIGEgZGVsZXRlIG1lc3NhZ2UgZnJvbSB0aGUgcGVlci5cbiAgICB0aGlzLmNvbGxlY3Rpb24uZGVsZXRlKHRhZywgc2lnbmF0dXJlLCB0aGlzKTtcbiAgfVxufVxuZXhwb3J0IGRlZmF1bHQgU3luY2hyb25pemVyO1xuIiwiY2xhc3MgQ2FjaGUgZXh0ZW5kcyBNYXB7Y29uc3RydWN0b3IoZSx0PTApe3N1cGVyKCksdGhpcy5tYXhTaXplPWUsdGhpcy5kZWZhdWx0VGltZVRvTGl2ZT10LHRoaXMuX25leHRXcml0ZUluZGV4PTAsdGhpcy5fa2V5TGlzdD1BcnJheShlKSx0aGlzLl90aW1lcnM9bmV3IE1hcH1zZXQoZSx0LHM9dGhpcy5kZWZhdWx0VGltZVRvTGl2ZSl7bGV0IGk9dGhpcy5fbmV4dFdyaXRlSW5kZXg7dGhpcy5kZWxldGUodGhpcy5fa2V5TGlzdFtpXSksdGhpcy5fa2V5TGlzdFtpXT1lLHRoaXMuX25leHRXcml0ZUluZGV4PShpKzEpJXRoaXMubWF4U2l6ZSx0aGlzLl90aW1lcnMuaGFzKGUpJiZjbGVhclRpbWVvdXQodGhpcy5fdGltZXJzLmdldChlKSksc3VwZXIuc2V0KGUsdCkscyYmdGhpcy5fdGltZXJzLnNldChlLHNldFRpbWVvdXQoKCgpPT50aGlzLmRlbGV0ZShlKSkscykpfWRlbGV0ZShlKXtyZXR1cm4gdGhpcy5fdGltZXJzLmhhcyhlKSYmY2xlYXJUaW1lb3V0KHRoaXMuX3RpbWVycy5nZXQoZSkpLHRoaXMuX3RpbWVycy5kZWxldGUoZSksc3VwZXIuZGVsZXRlKGUpfWNsZWFyKGU9dGhpcy5tYXhTaXplKXt0aGlzLm1heFNpemU9ZSx0aGlzLl9rZXlMaXN0PUFycmF5KGUpLHRoaXMuX25leHRXcml0ZUluZGV4PTAsc3VwZXIuY2xlYXIoKTtmb3IoY29uc3QgZSBvZiB0aGlzLl90aW1lcnMudmFsdWVzKCkpY2xlYXJUaW1lb3V0KGUpO3RoaXMuX3RpbWVycy5jbGVhcigpfX1jbGFzcyBTdG9yYWdlQmFzZXtjb25zdHJ1Y3Rvcih7bmFtZTplLGJhc2VOYW1lOnQ9XCJTdG9yYWdlXCIsbWF4U2VyaWFsaXplclNpemU6cz0xZTMsZGVidWc6aT0hMX0pe2NvbnN0IGE9YCR7dH0vJHtlfWAscj1uZXcgQ2FjaGUocyk7T2JqZWN0LmFzc2lnbih0aGlzLHtuYW1lOmUsYmFzZU5hbWU6dCxmdWxsTmFtZTphLGRlYnVnOmksc2VyaWFsaXplcjpyfSl9YXN5bmMgbGlzdCgpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShcIlwiLCgoZSx0KT0+dGhpcy5saXN0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGdldChlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZ2V0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGRlbGV0ZShlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZGVsZXRlSW50ZXJuYWwodCxlKSkpfWFzeW5jIHB1dChlLHQpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSxzKT0+dGhpcy5wdXRJbnRlcm5hbChzLHQsZSkpKX1sb2coLi4uZSl7dGhpcy5kZWJ1ZyYmY29uc29sZS5sb2codGhpcy5uYW1lLC4uLmUpfWFzeW5jIHNlcmlhbGl6ZShlLHQpe2NvbnN0e3NlcmlhbGl6ZXI6cyxyZWFkeTppfT10aGlzO2xldCBhPXMuZ2V0KGUpfHxpO3JldHVybiBhPWEudGhlbigoYXN5bmMoKT0+dChhd2FpdCB0aGlzLnJlYWR5LHRoaXMucGF0aChlKSkpKSxzLnNldChlLGEpLGF3YWl0IGF9fWNvbnN0e1Jlc3BvbnNlOmUsVVJMOnR9PWdsb2JhbFRoaXM7Y2xhc3MgU3RvcmFnZUNhY2hlIGV4dGVuZHMgU3RvcmFnZUJhc2V7Y29uc3RydWN0b3IoLi4uZSl7c3VwZXIoLi4uZSksdGhpcy5zdHJpcHBlcj1uZXcgUmVnRXhwKGBeLyR7dGhpcy5mdWxsTmFtZX0vYCksdGhpcy5yZWFkeT1jYWNoZXMub3Blbih0aGlzLmZ1bGxOYW1lKX1hc3luYyBsaXN0SW50ZXJuYWwoZSx0KXtyZXR1cm4oYXdhaXQgdC5rZXlzKCl8fFtdKS5tYXAoKGU9PnRoaXMudGFnKGUudXJsKSkpfWFzeW5jIGdldEludGVybmFsKGUsdCl7Y29uc3Qgcz1hd2FpdCB0Lm1hdGNoKGUpO3JldHVybiBzPy5qc29uKCl9ZGVsZXRlSW50ZXJuYWwoZSx0KXtyZXR1cm4gdC5kZWxldGUoZSl9cHV0SW50ZXJuYWwodCxzLGkpe3JldHVybiBpLnB1dCh0LGUuanNvbihzKSl9cGF0aChlKXtyZXR1cm5gLyR7dGhpcy5mdWxsTmFtZX0vJHtlfWB9dGFnKGUpe3JldHVybiBuZXcgdChlKS5wYXRobmFtZS5yZXBsYWNlKHRoaXMuc3RyaXBwZXIsXCJcIil9ZGVzdHJveSgpe3JldHVybiBjYWNoZXMuZGVsZXRlKHRoaXMuZnVsbE5hbWUpfX1leHBvcnR7U3RvcmFnZUNhY2hlIGFzIFN0b3JhZ2VMb2NhbCxTdG9yYWdlQ2FjaGUgYXMgZGVmYXVsdH07XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgeyBTdG9yYWdlTG9jYWwgfSBmcm9tICdAa2kxcjB5L3N0b3JhZ2UnO1xuaW1wb3J0IFN5bmNocm9uaXplciBmcm9tICcuL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5jb25zdCB7IEN1c3RvbUV2ZW50LCBFdmVudFRhcmdldCwgVGV4dERlY29kZXIgfSA9IGdsb2JhbFRoaXM7XG5cbmV4cG9ydCBjbGFzcyBDb2xsZWN0aW9uIGV4dGVuZHMgRXZlbnRUYXJnZXQge1xuXG4gIGNvbnN0cnVjdG9yKHtuYW1lLCBsYWJlbCA9IG5hbWUsIHNlcnZpY2VzID0gW10sIHByZXNlcnZlRGVsZXRpb25zID0gISFzZXJ2aWNlcy5sZW5ndGgsXG5cdCAgICAgICBwZXJzaXN0ZW5jZUNsYXNzID0gU3RvcmFnZUxvY2FsLCBkYlZlcnNpb24gPSBzdG9yYWdlVmVyc2lvbiwgcGVyc2lzdGVuY2VCYXNlID0gYCR7c3RvcmFnZU5hbWV9XyR7ZGJWZXJzaW9ufWAsXG5cdCAgICAgICBkZWJ1ZyA9IGZhbHNlLCBtdWx0aXBsZXgsIC8vIENhdXNlcyBzeW5jaHJvbml6YXRpb24gdG8gcmV1c2UgY29ubmVjdGlvbnMgZm9yIGRpZmZlcmVudCBDb2xsZWN0aW9ucyBvbiB0aGUgc2FtZSBzZXJ2aWNlLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHNlcnZpY2VMYWJlbH0pIHtcbiAgICBzdXBlcigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge25hbWUsIGxhYmVsLCBwcmVzZXJ2ZURlbGV0aW9ucywgcGVyc2lzdGVuY2VDbGFzcywgZGJWZXJzaW9uLCBtdWx0aXBsZXgsIGRlYnVnLCBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsLFxuXHRcdFx0IGZ1bGxOYW1lOiBgJHt0aGlzLmNvbnN0cnVjdG9yLm5hbWV9LyR7bmFtZX1gLCBmdWxsTGFiZWw6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtsYWJlbH1gfSk7XG4gICAgdGhpcy5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgcGVyc2lzdGVuY2VPcHRpb25zID0ge25hbWU6IHRoaXMuZnVsbExhYmVsLCBiYXNlTmFtZTogcGVyc2lzdGVuY2VCYXNlLCBkZWJ1ZzogZGVidWd9O1xuICAgIGlmIChwZXJzaXN0ZW5jZUNsYXNzLnRoZW4pIHRoaXMucGVyc2lzdGVuY2VTdG9yZSA9IHBlcnNpc3RlbmNlQ2xhc3MudGhlbihraW5kID0+IG5ldyBraW5kKHBlcnNpc3RlbmNlT3B0aW9ucykpO1xuICAgIGVsc2UgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gbmV3IHBlcnNpc3RlbmNlQ2xhc3MocGVyc2lzdGVuY2VPcHRpb25zKTtcbiAgfVxuXG4gIGFzeW5jIGNsb3NlKCkge1xuICAgIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmNsb3NlKCk7XG4gIH1cbiAgYXN5bmMgZGVzdHJveSgpIHtcbiAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3QoKTtcbiAgICBjb25zdCBzdG9yZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBkZWxldGUgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIGlmIChzdG9yZSkgYXdhaXQgc3RvcmUuZGVzdHJveSgpO1xuICB9XG5cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7IC8vIENhbiBiZSBvdmVycmlkZGVuIGJ5IHRoZSBjbGllbnRcbiAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgfVxuICAvLyBDcmVkZW50aWFscy5zaWduLy52ZXJpZnkgY2FuIHByb2R1Y2UvYWNjZXB0IEpTT04gT0JKRUNUUyBmb3IgdGhlIG5hbWVkIFwiSlNPTiBTZXJpYWxpemF0aW9uXCIgZm9ybS5cbiAgLy8gQXMgaXQgaGFwcGVucywgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgY2FuIGRpc3Rpbmd1aXNoIGJldHdlZW4gYSBjb21wYWN0IHNlcmlhbGl6YXRpb24gKGJhc2U2NCB0ZXh0KVxuICAvLyB2cyBhbiBvYmplY3QsIGJ1dCBpdCBkb2VzIG5vdCByZWNvZ25pemUgYSBTRVJJQUxJWkVEIG9iamVjdC4gSGVyZSB3ZSBib3R0bGVuZWNrIHRob3NlIG9wZXJhdGlvbnNcbiAgLy8gc3VjaCB0aGF0IHRoZSB0aGluZyB0aGF0IGlzIGFjdHVhbGx5IHBlcnNpc3RlZCBhbmQgc3luY2hyb25pemVkIGlzIGFsd2F5cyBhIHN0cmluZyAtLSBlaXRoZXIgYmFzZTY0XG4gIC8vIGNvbXBhY3Qgb3IgSlNPTiBiZWdpbm5pbmcgd2l0aCBhIFwie1wiICh3aGljaCBhcmUgZGlzdGluZ3Vpc2hhYmxlIGJlY2F1c2UgXCJ7XCIgaXMgbm90IGEgYmFzZTY0IGNoYXJhY3RlcikuXG4gIHN0YXRpYyBlbnN1cmVTdHJpbmcoc2lnbmF0dXJlKSB7IC8vIFJldHVybiBhIHNpZ25hdHVyZSB0aGF0IGlzIGRlZmluYXRlbHkgYSBzdHJpbmcuXG4gICAgaWYgKHR5cGVvZihzaWduYXR1cmUpICE9PSAnc3RyaW5nJykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBSZXR1cm4gYSBjb21wYWN0IG9yIFwiSlNPTlwiIChvYmplY3QpIGZvcm0gb2Ygc2lnbmF0dXJlIChpbmZsYXRpbmcgYSBzZXJpYWxpemF0aW9uIG9mIHRoZSBsYXR0ZXIgaWYgbmVlZGVkKSwgYnV0IG5vdCBhIEpTT04gc3RyaW5nLlxuICBzdGF0aWMgbWF5YmVJbmZsYXRlKHNpZ25hdHVyZSkge1xuICAgIGlmIChzaWduYXR1cmU/LnN0YXJ0c1dpdGg/LihcIntcIikpIHJldHVybiBKU09OLnBhcnNlKHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBUaGUgdHlwZSBvZiBKV0UgdGhhdCBnZXRzIHNpZ25lZCAobm90IHRoZSBjdHkgb2YgdGhlIEpXRSkuIFdlIGF1dG9tYXRpY2FsbHkgdHJ5IHRvIGRlY3J5cHQgYSBKV1MgcGF5bG9hZCBvZiB0aGlzIHR5cGUuXG4gIHN0YXRpYyBlbmNyeXB0ZWRNaW1lVHlwZSA9ICd0ZXh0L2VuY3J5cHRlZCc7XG4gIHN0YXRpYyBhc3luYyBlbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpIHsgLy8gUHJvbWlzZSB2ZXJmaWVkIGFmdGVyIGZpcnN0IGF1Z21lbnRpbmcgd2l0aCBkZWNyeXB0ZWQgZGF0YSBhcyBuZWVkZWQuXG4gICAgaWYgKHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5jdHkgIT09IHRoaXMuZW5jcnlwdGVkTWltZVR5cGUpIHJldHVybiB2ZXJpZmllZDtcbiAgICBpZiAodmVyaWZpZWQuZGVjcnlwdGVkKSByZXR1cm4gdmVyaWZpZWQ7IC8vIEFscmVhZHkgZGVjcnlwdGVkLlxuICAgIGNvbnN0IGRlY3J5cHRlZCA9IGF3YWl0IENyZWRlbnRpYWxzLmRlY3J5cHQodmVyaWZpZWQudGV4dCk7XG4gICAgdmVyaWZpZWQuanNvbiA9IGRlY3J5cHRlZC5qc29uO1xuICAgIHZlcmlmaWVkLnRleHQgPSBkZWNyeXB0ZWQudGV4dDtcbiAgICB2ZXJpZmllZC5wYXlsb2FkID0gZGVjcnlwdGVkLnBheWxvYWQ7XG4gICAgdmVyaWZpZWQuZGVjcnlwdGVkID0gZGVjcnlwdGVkO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBzdGF0aWMgYXN5bmMgc2lnbihkYXRhLCBvcHRpb25zKSB7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgQ3JlZGVudGlhbHMuc2lnbihkYXRhLCBvcHRpb25zKTtcbiAgICByZXR1cm4gdGhpcy5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgc2lnbmF0dXJlID0gdGhpcy5tYXliZUluZmxhdGUoc2lnbmF0dXJlKTtcbiAgICAvLyBXZSBkb24ndCBkbyBcImRlZXBcIiB2ZXJpZmljYXRpb24gaGVyZSAtIGUuZy4sIGNoZWNraW5nIHRoYXQgdGhlIGFjdCBpcyBhIG1lbWJlciBvZiBpc3MsIGFuZCB0aGUgaWF0IGlzIGFmdGVyIHRoZSBleGlzdGluZyBpYXQuXG4gICAgLy8gSW5zdGVhZCwgd2UgZG8gb3VyIG93biBkZWVwIGNoZWNrcyBpbiB2YWxpZGF0ZUZvcldyaXRpbmcuXG4gICAgLy8gVGhlIG1lbWJlci9ub3RCZWZvcmUgc2hvdWxkIGNoZWNrIG91dCBhbnl3YXkgLS0gaS5lLiwgd2UgY291bGQgbGVhdmUgaXQgaW4sIGV4Y2VwdCBpbiBzeW5jaHJvbml6aW5nXG4gICAgLy8gQ3JlZGVudGlhbC5jb2xsZWN0aW9ucy4gVGhlcmUgaXMgbm8gbWVjaGFuaXNtIChjdXJyZW50bHkpIGZvciB0aGVcbiAgICAvLyBzeW5jaHJvbml6YXRpb24gdG8gaGFwcGVuIGluIGFuIG9yZGVyIHRoYXQgd2lsbCByZXN1bHQgaW4gdGhlIGRlcGVuZGVuY2llcyBjb21pbmcgb3ZlciBiZWZvcmUgdGhlIGl0ZW1zIHRoYXQgY29uc3VtZSB0aGVtLlxuICAgIGNvbnN0IHZlcmlmaWVkID0gIGF3YWl0IENyZWRlbnRpYWxzLnZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMpO1xuICAgIGlmICh2ZXJpZmllZCkgdmVyaWZpZWQuc2lnbmF0dXJlID0gc2lnbmF0dXJlO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZpZWRTaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zLCB0YWcgPSBudWxsKSB7IC8vIFNpZ24sIGJ1dCByZXR1cm4gYSB2YWxpZGF0aW9uIChhcyB0aG91Z2ggYnkgaW1tZWRpYXRlbHkgdmFsaWRhdGluZykuXG4gICAgLy8gVE9ETzogYXNzZW1ibGUgdGhpcyBtb3JlIGNoZWFwbHk/XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5zaWduKGRhdGEsIHNpZ25pbmdPcHRpb25zKTtcbiAgICByZXR1cm4gdGhpcy52YWxpZGF0aW9uRm9ybWF0KHNpZ25hdHVyZSwgdGFnKTtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmFsaWRhdGlvbkZvcm1hdChzaWduYXR1cmUsIHRhZyA9IG51bGwpIHtcbiAgICAvL2NvbnNvbGUubG9nKHt0eXBlOiB0eXBlb2Yoc2lnbmF0dXJlKSwgc2lnbmF0dXJlLCB0YWd9KTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMudmVyaWZ5KHNpZ25hdHVyZSk7XG4gICAgLy9jb25zb2xlLmxvZyh7dmVyaWZpZWR9KTtcbiAgICBjb25zdCBzdWIgPSB2ZXJpZmllZC5zdWJqZWN0VGFnID0gdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgICB2ZXJpZmllZC50YWcgPSB0YWcgfHwgc3ViO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuXG4gIGFzeW5jIHVuZGVsZXRlZFRhZ3MoKSB7XG4gICAgLy8gT3VyIG93biBzZXBhcmF0ZSwgb24tZGVtYW5kIGFjY291bnRpbmcgb2YgcGVyc2lzdGVuY2VTdG9yZSBsaXN0KCk6XG4gICAgLy8gICAtIHBlcnNpc3RlbmNlU3RvcmUgbGlzdCgpIGNvdWxkIHBvdGVudGlhbGx5IGJlIGV4cGVuc2l2ZVxuICAgIC8vICAgLSBJdCB3aWxsIGNvbnRhaW4gc29mdC1kZWxldGVkIGl0ZW0gdG9tYnN0b25lcyAoc2lnbmVkIGVtcHR5IHBheWxvYWRzKS5cbiAgICAvLyBJdCBzdGFydHMgd2l0aCBhIGxpc3QoKSB0byBnZXQgYW55dGhpbmcgcGVyc2lzdGVkIGluIGEgcHJldmlvdXMgc2Vzc2lvbiwgYW5kIGFkZHMvcmVtb3ZlcyBhcyB3ZSBzdG9yZS9yZW1vdmUuXG4gICAgY29uc3QgYWxsVGFncyA9IGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmxpc3QoKTtcbiAgICBjb25zdCB0YWdzID0gbmV3IFNldCgpO1xuICAgIGF3YWl0IFByb21pc2UuYWxsKGFsbFRhZ3MubWFwKGFzeW5jIHRhZyA9PiB7XG4gICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZywgc3luY2hyb25pemU6IGZhbHNlfSk7XG4gICAgICBpZiAodmVyaWZpZWQpIHRhZ3MuYWRkKHRhZyk7XG4gICAgfSkpO1xuICAgIHJldHVybiB0YWdzO1xuICB9XG4gIGdldCB0YWdzKCkgeyAvLyBLZWVwcyB0cmFjayBvZiBvdXIgKHVuZGVsZXRlZCkga2V5cy5cbiAgICByZXR1cm4gdGhpcy5fdGFnc1Byb21pc2UgfHw9IHRoaXMudW5kZWxldGVkVGFncygpO1xuICB9XG4gIGFzeW5jIGFkZFRhZyh0YWcpIHtcbiAgICAoYXdhaXQgdGhpcy50YWdzKS5hZGQodGFnKTtcbiAgfVxuICBhc3luYyBkZWxldGVUYWcodGFnKSB7XG4gICAgKGF3YWl0IHRoaXMudGFncykuZGVsZXRlKHRhZyk7XG4gIH1cblxuICBsb2coLi4ucmVzdCkge1xuICAgIGlmICghdGhpcy5kZWJ1ZykgcmV0dXJuO1xuICAgIGNvbnNvbGUubG9nKHRoaXMuZnVsbExhYmVsLCAuLi5yZXN0KTtcbiAgfVxuICBfY2Fub25pY2FsaXplT3B0aW9ucyhvYmplY3RPclN0cmluZyA9IHt9KSB7XG4gICAgaWYgKHR5cGVvZihvYmplY3RPclN0cmluZykgPT09ICdzdHJpbmcnKSBvYmplY3RPclN0cmluZyA9IHt0YWc6IG9iamVjdE9yU3RyaW5nfTtcbiAgICBjb25zdCB7b3duZXI6dGVhbSA9IENyZWRlbnRpYWxzLm93bmVyLCBhdXRob3I6bWVtYmVyID0gQ3JlZGVudGlhbHMuYXV0aG9yLFxuXHQgICB0YWcsXG5cdCAgIGVuY3J5cHRpb24gPSBDcmVkZW50aWFscy5lbmNyeXB0aW9uLFxuXHQgICB0aW1lID0gRGF0ZS5ub3coKSxcblx0ICAgLi4ucmVzdH0gPSBvYmplY3RPclN0cmluZztcbiAgICAvLyBUT0RPOiBzdXBwb3J0IHNpbXBsaWZpZWQgc3ludGF4LCB0b28sIHBlciBSRUFETUVcbiAgICAvLyBUT0RPOiBzaG91bGQgd2Ugc3BlY2lmeSBzdWJqZWN0OiB0YWcgZm9yIGJvdGggbXV0YWJsZXM/IChnaXZlcyBoYXNoKVxuICAgIGNvbnN0IG9wdGlvbnMgPSAodGVhbSAmJiB0ZWFtICE9PSBtZW1iZXIpID9cblx0ICB7dGVhbSwgbWVtYmVyLCB0YWcsIGVuY3J5cHRpb24sIHRpbWUsIC4uLnJlc3R9IDpcblx0ICB7dGFnczogW21lbWJlcl0sIHRhZywgdGltZSwgZW5jcnlwdGlvbiwgLi4ucmVzdH07IC8vIE5vIGlhdCBpZiB0aW1lIG5vdCBleHBsaWNpdGx5IGdpdmVuLlxuICAgIGlmIChbdHJ1ZSwgJ3RlYW0nLCAnb3duZXInXS5pbmNsdWRlcyhvcHRpb25zLmVuY3J5cHRpb24pKSBvcHRpb25zLmVuY3J5cHRpb24gPSB0ZWFtO1xuICAgIHJldHVybiBvcHRpb25zO1xuICB9XG4gIGZhaWwob3BlcmF0aW9uLCBkYXRhLCBhdXRob3IpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7YXV0aG9yfSBkb2VzIG5vdCBoYXZlIHRoZSBhdXRob3JpdHkgdG8gJHtvcGVyYXRpb259ICR7dGhpcy5mdWxsTmFtZX0gJHtKU09OLnN0cmluZ2lmeShkYXRhKX0uYCk7XG4gIH1cbiAgYXN5bmMgc3RvcmUoZGF0YSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgLy8gZW5jcnlwdCBpZiBuZWVkZWRcbiAgICAvLyBzaWduXG4gICAgLy8gcHV0IDw9PSBBbHNvIHdoZXJlIHdlIGVudGVyIGlmIHB1c2hlZCBmcm9tIGEgY29ubmVjdGlvblxuICAgIC8vICAgIHZhbGlkYXRlRm9yV3JpdGluZ1xuICAgIC8vICAgICAgIGV4aXQgaWYgaW1wcm9wZXJcbiAgICAvLyAgICAgICBlbWl0IHVwZGF0ZSBldmVudFxuICAgIC8vICAgIG1lcmdlU2lnbmF0dXJlc1xuICAgIC8vICAgIHBlcnNpc3QgbG9jYWxseVxuICAgIC8vIHB1c2ggKGxpdmUgdG8gYW55IGNvbm5lY3Rpb25zIGV4Y2VwdCB0aGUgb25lIHdlIHJlY2VpdmVkIGZyb20pXG4gICAgbGV0IHtlbmNyeXB0aW9uLCB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7XG4gICAgaWYgKGVuY3J5cHRpb24pIHtcbiAgICAgIGRhdGEgPSBhd2FpdCBDcmVkZW50aWFscy5lbmNyeXB0KGRhdGEsIGVuY3J5cHRpb24pO1xuICAgICAgc2lnbmluZ09wdGlvbnMuY29udGVudFR5cGUgPSB0aGlzLmNvbnN0cnVjdG9yLmVuY3J5cHRlZE1pbWVUeXBlO1xuICAgIH1cbiAgICAvLyBObyBuZWVkIHRvIGF3YWl0IHN5bmNocm9uaXphdGlvbi5cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHRhZyA9IGF3YWl0IHRoaXMucHV0KHRhZywgc2lnbmF0dXJlKTtcbiAgICBpZiAoIXRhZykgcmV0dXJuIHRoaXMuZmFpbCgnc3RvcmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBwdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUsIGV4Y2x1ZGVTeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFB1c2ggdG8gYWxsIGNvbm5lY3RlZCBzeW5jaHJvbml6ZXJzLCBleGNsdWRpbmcgdGhlIHNwZWNpZmllZCBvbmUuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHRoaXMubWFwU3luY2hyb25pemVycyhzeW5jaHJvbml6ZXIgPT4gKGV4Y2x1ZGVTeW5jaHJvbml6ZXIgIT09IHN5bmNocm9uaXplcikgJiYgc3luY2hyb25pemVyLnB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSkpKTtcbiAgfVxuICBhc3luYyByZW1vdmUob3B0aW9ucyA9IHt9KSB7IC8vIE5vdGU6IFJlYWxseSBqdXN0IHJlcGxhY2luZyB3aXRoIGVtcHR5IGRhdGEgZm9yZXZlci4gT3RoZXJ3aXNlIG1lcmdpbmcgd2l0aCBlYXJsaWVyIGRhdGEgd2lsbCBicmluZyBpdCBiYWNrIVxuICAgIGxldCB7ZW5jcnlwdGlvbiwgdGFnLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpO1xuICAgIGNvbnN0IGRhdGEgPSAnJztcbiAgICAvLyBObyBuZWVkIHRvIGF3YWl0IHN5bmNocm9uaXphdGlvblxuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgdGFnID0gYXdhaXQgdGhpcy5kZWxldGUodGFnLCBzaWduYXR1cmUpO1xuICAgIGlmICghdGFnKSByZXR1cm4gdGhpcy5mYWlsKCdzdG9yZScsIGRhdGEsIHNpZ25pbmdPcHRpb25zLm1lbWJlciB8fCBzaWduaW5nT3B0aW9ucy50YWdzWzBdKTtcbiAgICBhd2FpdCB0aGlzLnB1c2goJ2RlbGV0ZScsIHRhZywgc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIHJldHJpZXZlKHRhZ09yT3B0aW9ucykgeyAvLyBnZXRWZXJpZmllZCBhbmQgbWF5YmUgZGVjcnlwdC4gSGFzIG1vcmUgY29tcGxleCBiZWhhdmlvciBpbiBzdWJjbGFzcyBWZXJzaW9uZWRDb2xsZWN0aW9uLlxuICAgIGNvbnN0IHt0YWcsIGRlY3J5cHQgPSB0cnVlLCAuLi5vcHRpb25zfSA9IHRhZ09yT3B0aW9ucy50YWcgPyB0YWdPck9wdGlvbnMgOiB7dGFnOiB0YWdPck9wdGlvbnN9O1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnLCAuLi5vcHRpb25zfSk7XG4gICAgaWYgKCF2ZXJpZmllZCkgcmV0dXJuICcnO1xuICAgIGlmIChkZWNyeXB0KSByZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBnZXRWZXJpZmllZCh0YWdPck9wdGlvbnMpIHsgLy8gc3luY2hyb25pemUsIGdldCwgYW5kIHZlcmlmeSAoYnV0IHdpdGhvdXQgZGVjcnlwdClcbiAgICBjb25zdCB7dGFnLCBzeW5jaHJvbml6ZSA9IHRydWUsIC4uLnZlcmlmeU9wdGlvbnN9ID0gdGFnT3JPcHRpb25zLnRhZyA/IHRhZ09yT3B0aW9uczoge3RhZzogdGFnT3JPcHRpb25zfTtcbiAgICBpZiAoc3luY2hyb25pemUpIGF3YWl0IHRoaXMuc3luY2hyb25pemUxKHRhZyk7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5nZXQodGFnKTtcbiAgICBpZiAoIXNpZ25hdHVyZSkgcmV0dXJuIHNpZ25hdHVyZTtcbiAgICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlLCB2ZXJpZnlPcHRpb25zKTtcbiAgfVxuICBhc3luYyBsaXN0KHNraXBTeW5jID0gZmFsc2UgKSB7IC8vIExpc3QgYWxsIHRhZ3Mgb2YgdGhpcyBjb2xsZWN0aW9uLlxuICAgIGlmICghc2tpcFN5bmMpIGF3YWl0IHRoaXMuc3luY2hyb25pemVUYWdzKCk7XG4gICAgLy8gV2UgY2Fubm90IGp1c3QgbGlzdCB0aGUga2V5cyBvZiB0aGUgY29sbGVjdGlvbiwgYmVjYXVzZSB0aGF0IGluY2x1ZGVzIGVtcHR5IHBheWxvYWRzIG9mIGl0ZW1zIHRoYXQgaGF2ZSBiZWVuIGRlbGV0ZWQuXG4gICAgcmV0dXJuIEFycmF5LmZyb20oKGF3YWl0IHRoaXMudGFncykua2V5cygpKTtcbiAgfVxuICBhc3luYyBtYXRjaCh0YWcsIHByb3BlcnRpZXMpIHsgLy8gSXMgdGhpcyBzaWduYXR1cmUgd2hhdCB3ZSBhcmUgbG9va2luZyBmb3I/XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLnJldHJpZXZlKHRhZyk7XG4gICAgY29uc3QgZGF0YSA9IHZlcmlmaWVkPy5qc29uO1xuICAgIGlmICghZGF0YSkgcmV0dXJuIGZhbHNlO1xuICAgIGZvciAoY29uc3Qga2V5IGluIHByb3BlcnRpZXMpIHtcbiAgICAgIGlmIChkYXRhW2tleV0gIT09IHByb3BlcnRpZXNba2V5XSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBhc3luYyBmaW5kTG9jYWwocHJvcGVydGllcykgeyAvLyBGaW5kIHRoZSB0YWcgaW4gb3VyIHN0b3JlIHRoYXQgbWF0Y2hlcywgZWxzZSBmYWxzZXlcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBhd2FpdCB0aGlzLmxpc3QoJ25vLXN5bmMnKSkgeyAvLyBEaXJlY3QgbGlzdCwgdy9vIHN5bmMuXG4gICAgICBpZiAoYXdhaXQgdGhpcy5tYXRjaCh0YWcsIHByb3BlcnRpZXMpKSByZXR1cm4gdGFnO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgYXN5bmMgZmluZChwcm9wZXJ0aWVzKSB7IC8vIEFuc3dlciB0aGUgdGFnIHRoYXQgaGFzIHZhbHVlcyBtYXRjaGluZyB0aGUgc3BlY2lmaWVkIHByb3BlcnRpZXMuIE9idmlvdXNseSwgY2FuJ3QgYmUgZW5jcnlwdGVkIGFzIGEgd2hvbGUuXG4gICAgbGV0IGZvdW5kID0gYXdhaXQgdGhpcy5maW5kTG9jYWwocHJvcGVydGllcyk7XG4gICAgaWYgKGZvdW5kKSB7XG4gICAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplMShmb3VuZCk7IC8vIE1ha2Ugc3VyZSB0aGUgZGF0YSBpcyB1cCB0byBkYXRlLiBUaGVuIGNoZWNrIGFnYWluLlxuICAgICAgaWYgKGF3YWl0IHRoaXMubWF0Y2goZm91bmQsIHByb3BlcnRpZXMpKSByZXR1cm4gZm91bmQ7XG4gICAgfVxuICAgIC8vIE5vIG1hdGNoLlxuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemVUYWdzKCk7XG4gICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZURhdGEoKTtcbiAgICBmb3VuZCA9IGF3YWl0IHRoaXMuZmluZExvY2FsKHByb3BlcnRpZXMpO1xuICAgIGlmIChmb3VuZCAmJiBhd2FpdCB0aGlzLm1hdGNoKGZvdW5kLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIGZvdW5kO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJlcXVpcmVUYWcodGFnKSB7XG4gICAgaWYgKHRhZykgcmV0dXJuO1xuICAgIHRocm93IG5ldyBFcnJvcignQSB0YWcgaXMgcmVxdWlyZWQuJyk7XG4gIH1cblxuICAvLyBUaGVzZSB0aHJlZSBpZ25vcmUgc3luY2hyb25pemF0aW9uIHN0YXRlLCB3aGljaCBpZiBuZWVlZCBpcyB0aGUgcmVzcG9uc2liaWxpdHkgb2YgdGhlIGNhbGxlci5cbiAgLy8gRklYTUUgVE9ETzogYWZ0ZXIgaW5pdGlhbCBkZXZlbG9wbWVudCwgdGhlc2UgdGhyZWUgc2hvdWxkIGJlIG1hZGUgaW50ZXJuYWwgc28gdGhhdCBhcHBsaWNhdGlvbiBjb2RlIGRvZXMgbm90IGNhbGwgdGhlbS5cbiAgYXN5bmMgZ2V0KHRhZykgeyAvLyBHZXQgdGhlIGxvY2FsIHJhdyBzaWduYXR1cmUgZGF0YS5cbiAgICB0aGlzLnJlcXVpcmVUYWcodGFnKTtcbiAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkuZ2V0KHRhZyk7XG4gIH1cbiAgLy8gVGhlc2UgdHdvIGNhbiBiZSB0cmlnZ2VyZWQgYnkgY2xpZW50IGNvZGUgb3IgYnkgYW55IHNlcnZpY2UuXG4gIGFzeW5jIHB1dCh0YWcsIHNpZ25hdHVyZSwgc3luY2hyb25pemVyID0gbnVsbCwgbWVyZ2VBdXRob3JPdmVycmlkZSA9IG51bGwpIHsgLy8gUHV0IHRoZSByYXcgc2lnbmF0dXJlIGxvY2FsbHkgYW5kIG9uIHRoZSBzcGVjaWZpZWQgc2VydmljZXMuXG4gICAgLy8gbWVyZ2VTaWduYXR1cmVzKCkgTUFZIGNyZWF0ZSBuZXcgbmV3IHJlc3VsdHMgdG8gc2F2ZSwgdGhhdCBzdGlsbCBoYXZlIHRvIGJlIHNpZ25lZC4gRm9yIHRlc3RpbmcsIHdlIHNvbWV0aW1lc1xuICAgIC8vIHdhbnQgdG8gYmVoYXZlIGFzIGlmIHNvbWUgb3duZXIgY3JlZGVudGlhbCBkb2VzIG5vdCBleGlzdCBvbiB0aGUgbWFjaGluZS4gVGhhdCdzIHdoYXQgbWVyZ2VBdXRob3JPdmVycmlkZSBpcyBmb3IuXG5cbiAgICAvLyBUT0RPOiBkbyB3ZSBuZWVkIHRvIHF1ZXVlIHRoZXNlPyBTdXBwb3NlIHdlIGFyZSB2YWxpZGF0aW5nIG9yIG1lcmdpbmcgd2hpbGUgb3RoZXIgcmVxdWVzdCBhcnJpdmU/XG4gICAgY29uc3QgdmFsaWRhdGlvbiA9IGF3YWl0IHRoaXMudmFsaWRhdGVGb3JXcml0aW5nKHRhZywgc2lnbmF0dXJlLCAnc3RvcmUnLCBzeW5jaHJvbml6ZXIpO1xuICAgIHRoaXMubG9nKCdwdXQnLCB7dGFnOiB2YWxpZGF0aW9uPy50YWcgfHwgdGFnLCBzeW5jaHJvbml6ZXI6IHN5bmNocm9uaXplcj8ubGFiZWwsIGpzb246IHZhbGlkYXRpb24/Lmpzb259KTtcbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgYXdhaXQgdGhpcy5hZGRUYWcodmFsaWRhdGlvbi50YWcpO1xuXG4gICAgLy8gZml4bWUgbmV4dFxuICAgIGNvbnN0IG1lcmdlZCA9IGF3YWl0IHRoaXMubWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlLCBtZXJnZUF1dGhvck92ZXJyaWRlKTtcbiAgICBhd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIG1lcmdlZCk7XG4gICAgLy9jb25zdCBtZXJnZWQyID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52YWxpZGF0aW9uRm9ybWF0KG1lcmdlZCwgdGFnKTtcbiAgICAvL2F3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgbWVyZ2VkKTtcbiAgICAvL2F3YWl0IHRoaXMucGVyc2lzdDIobWVyZ2VkMik7XG4gICAgLy8gY29uc3QgbWVyZ2VkID0gYXdhaXQgdGhpcy5tZXJnZVZhbGlkYXRpb24odmFsaWRhdGlvbiwgbWVyZ2VBdXRob3JPdmVycmlkZSk7XG4gICAgLy8gYXdhaXQgdGhpcy5wZXJzaXN0MihtZXJnZWQpO1xuXG4gICAgcmV0dXJuIHZhbGlkYXRpb24udGFnOyAvLyBEb24ndCByZWx5IG9uIHRoZSByZXR1cm5lZCB2YWx1ZSBvZiBwZXJzaXN0ZW5jZVN0b3JlLnB1dC5cbiAgfVxuICBhc3luYyBkZWxldGUodGFnLCBzaWduYXR1cmUsIHN5bmNocm9uaXplciA9IG51bGwpIHsgLy8gUmVtb3ZlIHRoZSByYXcgc2lnbmF0dXJlIGxvY2FsbHkgYW5kIG9uIHRoZSBzcGVjaWZpZWQgc2VydmljZXMuXG4gICAgY29uc3QgdmFsaWRhdGlvbiA9IGF3YWl0IHRoaXMudmFsaWRhdGVGb3JXcml0aW5nKHRhZywgc2lnbmF0dXJlLCAncmVtb3ZlJywgc3luY2hyb25pemVyLCAncmVxdWlyZVRhZycpO1xuICAgIHRoaXMubG9nKCdkZWxldGUnLCB0YWcsIHN5bmNocm9uaXplcj8ubGFiZWwsICd2YWxpZGF0ZWQgdGFnOicsIHZhbGlkYXRpb24/LnRhZywgJ3ByZXNlcnZlRGVsZXRpb25zOicsIHRoaXMucHJlc2VydmVEZWxldGlvbnMpO1xuICAgIGlmICghdmFsaWRhdGlvbikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBhd2FpdCB0aGlzLmRlbGV0ZVRhZyh0YWcpO1xuICAgIGlmICh0aGlzLnByZXNlcnZlRGVsZXRpb25zKSB7IC8vIFNpZ25hdHVyZSBwYXlsb2FkIGlzIGVtcHR5LlxuICAgICAgLy8gRklYTUUgbmV4dFxuICAgICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIHNpZ25hdHVyZSk7XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QyKHZhbGlkYXRpb24pO1xuICAgIH0gZWxzZSB7IC8vIFJlYWxseSBkZWxldGUuXG4gICAgICAvLyBmaXhtZSBuZXh0XG4gICAgICAvL2F3YWl0IHRoaXMucGVyc2lzdCh2YWxpZGF0aW9uLnRhZywgc2lnbmF0dXJlLCAnZGVsZXRlJyk7XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QyKHZhbGlkYXRpb24sICdkZWxldGUnKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbGlkYXRpb24udGFnOyAvLyBEb24ndCByZWx5IG9uIHRoZSByZXR1cm5lZCB2YWx1ZSBvZiBwZXJzaXN0ZW5jZVN0b3JlLmRlbGV0ZS5cbiAgfVxuXG4gIG5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSA9IHVuZGVmaW5lZCwgdmFsaWRhdGVkID0gJycsIHNpZ25hdHVyZSkge1xuICAgIC8vIExhdGVyIG9uLCB3ZSB3aWxsIG5vdCB3YW50IHRvIGdpdmUgb3V0IHNvIG11Y2ggaW5mby4uLlxuICAgIC8vaWYgKHRoaXMuZGVidWcpIHtcbiAgICBjb25zb2xlLndhcm4odGhpcy5mdWxsTGFiZWwsIG9wZXJhdGlvbkxhYmVsLCBtZXNzYWdlLCB0YWcpO1xuICAgIC8vfSBlbHNlIHtcbiAgICAvLyAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBgU2lnbmF0dXJlIGlzIG5vdCB2YWxpZCB0byAke29wZXJhdGlvbkxhYmVsfSAke3RhZyB8fCAnZGF0YSd9LmApO1xuICAgIC8vfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgYXN5bmMgZGlzYWxsb3dXcml0ZSh0YWcsIGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpIHsgLy8gUmV0dXJuIGEgcmVhc29uIHN0cmluZyB3aHkgdGhlIHByb3Bvc2VkIHZlcmlmaWVkIHByb3RlY3RlZEhlYWRlclxuICAgIC8vIHNob3VsZCBub3QgYmUgYWxsb3dlZCB0byBvdmVycndyaXRlIHRoZSAocG9zc2libHkgbnVsbGlzaCkgZXhpc3RpbmcgdmVyaWZpZWQgcHJvdGVjdGVkSGVhZGVyLFxuICAgIC8vIGVsc2UgZmFsc3kgaWYgYWxsb3dlZC5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSByZXR1cm4gbnVsbDtcbiAgICBpZiAocHJvcG9zZWQuaWF0IDwgZXhpc3RpbmcuaWF0KSByZXR1cm4gJ2JhY2tkYXRlZCc7XG4gICAgaWYgKCF0aGlzLm93bmVyTWF0Y2goZXhpc3RpbmcsIHByb3Bvc2VkKSkgcmV0dXJuICdub3Qgb3duZXInO1xuICAgIGlmICghYXdhaXQgdGhpcy5zdWJqZWN0TWF0Y2godmVyaWZpZWQpKSByZXR1cm4gJ3dyb25nIGhhc2gnO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGFzeW5jIHN1YmplY3RNYXRjaCh2ZXJpZmllZCkgeyAvLyBQcm9taXNlcyB0cnVlIElGRiBjbGFpbWVkICdzdWInIG1hdGNoZXMgaGFzaCBvZiB0aGUgY29udGVudHMuXG4gICAgcmV0dXJuIHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWIgPT09IGF3YWl0IENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChhd2FpdCBDcmVkZW50aWFscy5oYXNoQnVmZmVyKHZlcmlmaWVkLnBheWxvYWQpKTtcbiAgfVxuICBvd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkgey8vIERvZXMgcHJvcG9zZWQgb3duZXIgbWF0Y2ggdGhlIGV4aXN0aW5nP1xuICAgIGNvbnN0IGV4aXN0aW5nT3duZXIgPSBleGlzdGluZz8uaXNzIHx8IGV4aXN0aW5nPy5raWQ7XG4gICAgY29uc3QgcHJvcG9zZWRPd25lciA9IHByb3Bvc2VkLmlzcyB8fCBwcm9wb3NlZC5raWQ7XG4gICAgLy8gRXhhY3QgbWF0Y2guIERvIHdlIG5lZWQgdG8gYWxsb3cgZm9yIGFuIG93bmVyIHRvIHRyYW5zZmVyIG93bmVyc2hpcCB0byBhIHN1Yi9zdXBlci9kaXNqb2ludCB0ZWFtP1xuICAgIC8vIEN1cnJlbnRseSwgdGhhdCB3b3VsZCByZXF1aXJlIGEgbmV3IHJlY29yZC4gKEUuZy4sIHR3byBNdXRhYmxlL1ZlcnNpb25lZENvbGxlY3Rpb24gaXRlbXMgdGhhdFxuICAgIC8vIGhhdmUgdGhlIHNhbWUgR1VJRCBwYXlsb2FkIHByb3BlcnR5LCBidXQgZGlmZmVyZW50IHRhZ3MuIEkuZS4sIGEgZGlmZmVyZW50IG93bmVyIG1lYW5zIGEgZGlmZmVyZW50IHRhZy4pXG4gICAgaWYgKCFwcm9wb3NlZE93bmVyIHx8IChleGlzdGluZ093bmVyICYmIChwcm9wb3NlZE93bmVyICE9PSBleGlzdGluZ093bmVyKSkpIHJldHVybiBmYWxzZTtcblxuICAgICAgLy8gV2UgYXJlIG5vdCBjaGVja2luZyB0byBzZWUgaWYgYXV0aG9yIGlzIGN1cnJlbnRseSBhIG1lbWJlciBvZiB0aGUgb3duZXIgdGVhbSBoZXJlLCB3aGljaFxuICAgICAgLy8gaXMgY2FsbGVkIGJ5IHB1dCgpL2RlbGV0ZSgpIGluIHR3byBjaXJjdW1zdGFuY2VzOlxuXG4gICAgICAvLyB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZygpIGlzIGNhbGxlZCBieSBwdXQoKS9kZWxldGUoKSB3aGljaCBoYXBwZW5zIGluIHRoZSBhcHAgKHZpYSBzdG9yZSgpL3JlbW92ZSgpKVxuICAgICAgLy8gYW5kIGR1cmluZyBzeW5jIGZyb20gYW5vdGhlciBzZXJ2aWNlOlxuXG4gICAgICAvLyAxLiBGcm9tIHRoZSBhcHAgKHZhaWEgc3RvcmUoKS9yZW1vdmUoKSwgd2hlcmUgd2UgaGF2ZSBqdXN0IGNyZWF0ZWQgdGhlIHNpZ25hdHVyZS4gU2lnbmluZyBpdHNlbGZcbiAgICAgIC8vIHdpbGwgZmFpbCBpZiB0aGUgKDEtaG91ciBjYWNoZWQpIGtleSBpcyBubyBsb25nZXIgYSBtZW1iZXIgb2YgdGhlIHRlYW0uIFRoZXJlIGlzIG5vIGludGVyZmFjZVxuICAgICAgLy8gZm9yIHRoZSBhcHAgdG8gcHJvdmlkZSBhbiBvbGQgc2lnbmF0dXJlLiAoVE9ETzogYWZ0ZXIgd2UgbWFrZSBnZXQvcHV0L2RlbGV0ZSBpbnRlcm5hbC4pXG5cbiAgICAgIC8vIDIuIER1cmluZyBzeW5jIGZyb20gYW5vdGhlciBzZXJ2aWNlLCB3aGVyZSB3ZSBhcmUgcHVsbGluZyBpbiBvbGQgcmVjb3JkcyBmb3Igd2hpY2ggd2UgZG9uJ3QgaGF2ZVxuICAgICAgLy8gdGVhbSBtZW1iZXJzaGlwIGZyb20gdGhhdCB0aW1lLlxuXG4gICAgICAvLyBJZiB0aGUgYXBwIGNhcmVzIHdoZXRoZXIgdGhlIGF1dGhvciBoYXMgYmVlbiBraWNrZWQgZnJvbSB0aGUgdGVhbSwgdGhlIGFwcCBpdHNlbGYgd2lsbCBoYXZlIHRvIGNoZWNrLlxuICAgICAgLy8gVE9ETzogd2Ugc2hvdWxkIHByb3ZpZGUgYSB0b29sIGZvciB0aGF0LlxuXG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgYW50ZWNlZGVudCh2ZXJpZmllZCkgeyAvLyBXaGF0IHRhZyBzaG91bGQgdGhlIHZlcmlmaWVkIHNpZ25hdHVyZSBiZSBjb21wYXJlZCBhZ2FpbnN0IGZvciB3cml0aW5nP1xuICAgIHJldHVybiB2ZXJpZmllZC50YWc7XG4gIH1cbiAgc3luY2hyb25pemVBbnRlY2VkZW50KHRhZywgYW50ZWNlZGVudCkgeyAvLyBTaG91bGQgdGhlIGFudGVjZWRlbnQgdHJ5IHN5bmNocm9uaXppbmcgYmVmb3JlIGdldHRpbmcgaXQ/XG4gICAgcmV0dXJuIHRhZyAhPT0gYW50ZWNlZGVudDsgLy8gRmFsc2Ugd2hlbiB0aGV5IGFyZSB0aGUgc2FtZSB0YWcsIGFzIHRoYXQgd291bGQgYmUgY2lyY3VsYXIuIFZlcnNpb25zIGRvIHN5bmMuXG4gIH1cbiAgLy8gVE9ETzogaXMgdGhpcyBuZWVkZWQgYW55IG1vcmU/XG4gIGFzeW5jIHZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgb3BlcmF0aW9uTGFiZWwsIHN5bmNocm9uaXplciwgcmVxdWlyZVRhZyA9IGZhbHNlKSB7XG4gICAgLy8gQSBkZWVwIHZlcmlmeSB0aGF0IGNoZWNrcyBhZ2FpbnN0IHRoZSBleGlzdGluZyBpdGVtJ3MgKHJlLSl2ZXJpZmllZCBoZWFkZXJzLlxuICAgIC8vIElmIGl0IHN1Y2NlZWRzLCB0aGlzIGlzIGFsc28gdGhlIGNvbW1vbiBjb2RlIChiZXR3ZWVuIHB1dC9kZWxldGUpIHRoYXQgZW1pdHMgdGhlIHVwZGF0ZSBldmVudC5cbiAgICBjb25zdCB2YWxpZGF0aW9uT3B0aW9ucyA9IHN5bmNocm9uaXplciA/IHttZW1iZXI6IG51bGx9IDoge307IC8vIENvdWxkIGJlIG9sZCBkYXRhIHdyaXR0ZW4gYnkgc29tZW9uZSB3aG8gaXMgbm8gbG9uZ2VyIGEgbWVtYmVyLlxuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlLCB2YWxpZGF0aW9uT3B0aW9ucyk7XG4gICAgaWYgKCF2ZXJpZmllZCkgcmV0dXJuIHRoaXMubm90aWZ5SW52YWxpZCh0YWcsIG9wZXJhdGlvbkxhYmVsLCAnaW52YWxpZCcsIHZlcmlmaWVkLCBzaWduYXR1cmUpO1xuICAgIHZlcmlmaWVkLnN5bmNocm9uaXplciA9IHN5bmNocm9uaXplcjtcbiAgICB0YWcgPSB2ZXJpZmllZC50YWcgPSB2ZXJpZmllZC5zdWJqZWN0VGFnID0gcmVxdWlyZVRhZyA/IHRhZyA6IGF3YWl0IHRoaXMudGFnRm9yV3JpdGluZyh0YWcsIHZlcmlmaWVkKTtcbiAgICBjb25zdCBhbnRlY2VkZW50ID0gdGhpcy5hbnRlY2VkZW50KHZlcmlmaWVkKTtcbiAgICBjb25zdCBzeW5jaHJvbml6ZSA9IHRoaXMuc3luY2hyb25pemVBbnRlY2VkZW50KHRhZywgYW50ZWNlZGVudCk7XG4gICAgY29uc3QgZXhpc3RpbmdWZXJpZmllZCA9IHZlcmlmaWVkLmV4aXN0aW5nID0gYW50ZWNlZGVudCAmJiBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWc6IGFudGVjZWRlbnQsIHN5bmNocm9uaXplLCAuLi52YWxpZGF0aW9uT3B0aW9uc30pO1xuICAgIGNvbnN0IGRpc2FsbG93ZWQgPSBhd2FpdCB0aGlzLmRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZ1ZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkKTtcbiAgICBpZiAoZGlzYWxsb3dlZCkgcmV0dXJuIHRoaXMubm90aWZ5SW52YWxpZCh0YWcsIG9wZXJhdGlvbkxhYmVsLCBkaXNhbGxvd2VkLCB2ZXJpZmllZCk7XG4gICAgdGhpcy5sb2coJ2VtaXQnLCB0YWcsIHZlcmlmaWVkLmpzb24pO1xuICAgIHRoaXMuZW1pdCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIC8vIGZpeG1lIG5leHQgMlxuICBtZXJnZVNpZ25hdHVyZXModGFnLCB2YWxpZGF0aW9uLCBzaWduYXR1cmUpIHsgLy8gUmV0dXJuIGEgc3RyaW5nIHRvIGJlIHBlcnNpc3RlZC4gVXN1YWxseSBqdXN0IHRoZSBzaWduYXR1cmUuXG4gICAgcmV0dXJuIHNpZ25hdHVyZTsgIC8vIHZhbGlkYXRpb24uc3RyaW5nIG1pZ2h0IGJlIGFuIG9iamVjdC5cbiAgfVxuICBhc3luYyBwZXJzaXN0KHRhZywgc2lnbmF0dXJlU3RyaW5nLCBvcGVyYXRpb24gPSAncHV0JykgeyAvLyBDb25kdWN0IHRoZSBzcGVjaWZpZWQgdGFnL3NpZ25hdHVyZSBvcGVyYXRpb24gb24gdGhlIHBlcnNpc3RlbnQgc3RvcmUuXG4gICAgcmV0dXJuIChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpW29wZXJhdGlvbl0odGFnLCBzaWduYXR1cmVTdHJpbmcpO1xuICB9XG4gIG1lcmdlVmFsaWRhdGlvbih2YWxpZGF0aW9uKSB7IC8vIFJldHVybiBhIHN0cmluZyB0byBiZSBwZXJzaXN0ZWQuIFVzdWFsbHkganVzdCB0aGUgc2lnbmF0dXJlLlxuICAgIHJldHVybiB2YWxpZGF0aW9uO1xuICB9XG4gIGFzeW5jIHBlcnNpc3QyKHZhbGlkYXRpb24sIG9wZXJhdGlvbiA9ICdwdXQnKSB7IC8vIENvbmR1Y3QgdGhlIHNwZWNpZmllZCB0YWcvc2lnbmF0dXJlIG9wZXJhdGlvbiBvbiB0aGUgcGVyc2lzdGVudCBzdG9yZS4gUmV0dXJuIHRhZ1xuICAgIGNvbnN0IHt0YWcsIHNpZ25hdHVyZX0gPSB2YWxpZGF0aW9uO1xuICAgIGNvbnN0IHNpZ25hdHVyZVN0cmluZyA9IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gICAgY29uc3Qgc3RvcmFnZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBhd2FpdCBzdG9yYWdlW29wZXJhdGlvbl0odGFnLCBzaWduYXR1cmVTdHJpbmcpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBEaXNwYXRjaCB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHZlcmlmaWVkfSkpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gQW5zd2VycyB0aGUgQ29sbGVjdGlvbiB0aGF0IGVtaXRzIGluZGl2aWR1YWwgdXBkYXRlcy4gKFNlZSBvdmVycmlkZSBpbiBWZXJzaW9uZWRDb2xsZWN0aW9uLilcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHN5bmNocm9uaXplcnMgPSBuZXcgTWFwKCk7IC8vIHNlcnZpY2VJbmZvIG1pZ2h0IG5vdCBiZSBhIHN0cmluZy5cbiAgbWFwU3luY2hyb25pemVycyhmKSB7IC8vIE9uIFNhZmFyaSwgTWFwLnZhbHVlcygpLm1hcCBpcyBub3QgYSBmdW5jdGlvbiFcbiAgICBjb25zdCByZXN1bHRzID0gW107XG4gICAgZm9yIChjb25zdCBzeW5jaHJvbml6ZXIgb2YgdGhpcy5zeW5jaHJvbml6ZXJzLnZhbHVlcygpKSB7XG4gICAgICByZXN1bHRzLnB1c2goZihzeW5jaHJvbml6ZXIpKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cbiAgZ2V0IHNlcnZpY2VzKCkge1xuICAgIHJldHVybiBBcnJheS5mcm9tKHRoaXMuc3luY2hyb25pemVycy5rZXlzKCkpO1xuICB9XG4gIC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGNvbm5lY3QsIGFuZCBkZWZpbmUgc3luY2hyb25pemUgdG8gYXdhaXQgY29ubmVjdCwgc3luY2hyb25pemF0aW9uQ29tcGxldGUsIGRpc2Nvbm5uZWN0LlxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBTdGFydCBydW5uaW5nIHRoZSBzcGVjaWZpZWQgc2VydmljZXMgKGluIGFkZGl0aW9uIHRvIHdoYXRldmVyIGlzIGFscmVhZHkgcnVubmluZykuXG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBpZiAoc3luY2hyb25pemVycy5oYXMoc2VydmljZSkpIGNvbnRpbnVlO1xuICAgICAgYXdhaXQgU3luY2hyb25pemVyLmNyZWF0ZSh0aGlzLCBzZXJ2aWNlKTsgLy8gUmVhY2hlcyBpbnRvIG91ciBzeW5jaHJvbml6ZXJzIG1hcCBhbmQgc2V0cyBpdHNlbGYgaW1tZWRpYXRlbHkuXG4gICAgfVxuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHMgPT4gcy5ib3RoU2lkZXNDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24pKTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIFNodXQgZG93biB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgY29uc3Qge3N5bmNocm9uaXplcnN9ID0gdGhpcztcbiAgICBmb3IgKGxldCBzZXJ2aWNlIG9mIHNlcnZpY2VzKSB7XG4gICAgICBjb25zdCBzeW5jaHJvbml6ZXIgPSBzeW5jaHJvbml6ZXJzLmdldChzZXJ2aWNlKTtcbiAgICAgIGlmICghc3luY2hyb25pemVyKSB7XG5cdC8vY29uc29sZS53YXJuKGAke3RoaXMuZnVsbExhYmVsfSBkb2VzIG5vdCBoYXZlIGEgc2VydmljZSBuYW1lZCAnJHtzZXJ2aWNlfScgdG8gZGlzY29ubmVjdC5gKTtcblx0Y29udGludWU7XG4gICAgICB9XG4gICAgICBhd2FpdCBzeW5jaHJvbml6ZXIuZGlzY29ubmVjdCgpO1xuICAgIH1cbiAgfVxuICBhc3luYyBlbnN1cmVTeW5jaHJvbml6ZXIoc2VydmljZU5hbWUsIGNvbm5lY3Rpb24sIGRhdGFDaGFubmVsKSB7IC8vIE1ha2Ugc3VyZSBkYXRhQ2hhbm5lbCBtYXRjaGVzIHRoZSBzeW5jaHJvbml6ZXIsIGNyZWF0aW5nIFN5bmNocm9uaXplciBvbmx5IGlmIG1pc3NpbmcuXG4gICAgbGV0IHN5bmNocm9uaXplciA9IHRoaXMuc3luY2hyb25pemVycy5nZXQoc2VydmljZU5hbWUpO1xuICAgIGlmICghc3luY2hyb25pemVyKSB7XG4gICAgICBzeW5jaHJvbml6ZXIgPSBuZXcgU3luY2hyb25pemVyKHtzZXJ2aWNlTmFtZSwgY29sbGVjdGlvbjogdGhpcywgZGVidWc6IHRoaXMuZGVidWd9KTtcbiAgICAgIHN5bmNocm9uaXplci5jb25uZWN0aW9uID0gY29ubmVjdGlvbjtcbiAgICAgIHN5bmNocm9uaXplci5kYXRhQ2hhbm5lbFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZGF0YUNoYW5uZWwpO1xuICAgICAgdGhpcy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgc3luY2hyb25pemVyKTtcbiAgICAgIC8vIERvZXMgTk9UIHN0YXJ0IHN5bmNocm9uaXppbmcuIENhbGxlciBtdXN0IGRvIHRoYXQgaWYgZGVzaXJlZC4gKFJvdXRlciBkb2Vzbid0IG5lZWQgdG8uKVxuICAgIH0gZWxzZSBpZiAoKHN5bmNocm9uaXplci5jb25uZWN0aW9uICE9PSBjb25uZWN0aW9uKSB8fFxuXHQgICAgICAgKHN5bmNocm9uaXplci5jaGFubmVsTmFtZSAhPT0gZGF0YUNoYW5uZWwubGFiZWwpIHx8XG5cdCAgICAgICAoYXdhaXQgc3luY2hyb25pemVyLmRhdGFDaGFubmVsUHJvbWlzZSAhPT0gZGF0YUNoYW5uZWwpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVubWF0Y2hlZCBjb25uZWN0aW9uIGZvciAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHN5bmNocm9uaXplcjtcbiAgfVxuXG4gIHByb21pc2Uoa2V5LCB0aHVuaykgeyByZXR1cm4gdGh1bms7IH0gLy8gVE9ETzogaG93IHdpbGwgd2Uga2VlcCB0cmFjayBvZiBvdmVybGFwcGluZyBkaXN0aW5jdCBzeW5jcz9cbiAgc3luY2hyb25pemUxKHRhZykgeyAvLyBDb21wYXJlIGFnYWluc3QgYW55IHJlbWFpbmluZyB1bnN5bmNocm9uaXplZCBkYXRhLCBmZXRjaCB3aGF0J3MgbmVlZGVkLCBhbmQgcmVzb2x2ZSBsb2NhbGx5LlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IHN5bmNocm9uaXplci5zeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZVRhZ3MoKSB7IC8vIEVuc3VyZSB0aGF0IHdlIGhhdmUgdXAgdG8gZGF0ZSB0YWcgbWFwIGFtb25nIGFsbCBzZXJ2aWNlcy4gKFdlIGRvbid0IGNhcmUgeWV0IG9mIHRoZSB2YWx1ZXMgYXJlIHN5bmNocm9uaXplZC4pXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgndGFncycsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplRGF0YSgpIHsgLy8gTWFrZSB0aGUgZGF0YSB0byBtYXRjaCBvdXIgdGFnbWFwLCB1c2luZyBzeW5jaHJvbml6ZTEuXG4gICAgcmV0dXJuIHRoaXMucHJvbWlzZSgnZGF0YScsICgpID0+IFByb21pc2UucmVzb2x2ZSgpKTsgLy8gVE9ET1xuICB9XG4gIHNldCBvbnVwZGF0ZShoYW5kbGVyKSB7IC8vIEFsbG93IHNldHRpbmcgaW4gbGlldSBvZiBhZGRFdmVudExpc3RlbmVyLlxuICAgIGlmIChoYW5kbGVyKSB7XG4gICAgICB0aGlzLl91cGRhdGUgPSBoYW5kbGVyO1xuICAgICAgdGhpcy5hZGRFdmVudExpc3RlbmVyKCd1cGRhdGUnLCBoYW5kbGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5yZW1vdmVFdmVudExpc3RlbmVyKCd1cGRhdGUnLCB0aGlzLl91cGRhdGUpO1xuICAgICAgdGhpcy5fdXBkYXRlID0gaGFuZGxlcjtcbiAgICB9XG4gIH1cbiAgZ2V0IG9udXBkYXRlKCkgeyAvLyBBcyBzZXQgYnkgdGhpcy5vbnVwZGF0ZSA9IGhhbmRsZXIuIERvZXMgTk9UIGFuc3dlciB0aGF0IHdoaWNoIGlzIHNldCBieSBhZGRFdmVudExpc3RlbmVyLlxuICAgIHJldHVybiB0aGlzLl91cGRhdGU7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIEltbXV0YWJsZUNvbGxlY3Rpb24gZXh0ZW5kcyBDb2xsZWN0aW9uIHtcbiAgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gSWdub3JlcyB0YWcuIEp1c3QgdGhlIGhhc2guXG4gICAgcmV0dXJuIHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgfVxuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgeyAvLyBPdmVycmlkZXMgc3VwZXIgYnkgYWxsb3dpbmcgRUFSTElFUiByYXRoZXIgdGhhbiBsYXRlci5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICBpZiAodmVyaWZpZWQubGVuZ3RoICYmICh0YWcgIT09IHByb3Bvc2VkLnN1YikpIHJldHVybiAnd3JvbmcgdGFnJztcbiAgICAgIGlmICghYXdhaXQgdGhpcy5zdWJqZWN0TWF0Y2godmVyaWZpZWQpKSByZXR1cm4gJ3dyb25nIGhhc2gnO1xuICAgICAgcmV0dXJuIG51bGw7IC8vIEZpcnN0IHdyaXRlIG9rLlxuICAgIH1cbiAgICAvLyBObyBvd25lciBtYXRjaC4gTm90IHJlbGV2YW50IGZvciBpbW11dGFibGVzLlxuICAgIGlmICghdmVyaWZpZWQucGF5bG9hZC5sZW5ndGggJiYgKHByb3Bvc2VkLmlhdCA+IGV4aXN0aW5nLmlhdCkpIHJldHVybiBudWxsOyAvLyBMYXRlciBkZWxldGUgaXMgb2suXG4gICAgaWYgKHByb3Bvc2VkLmlhdCA+IGV4aXN0aW5nLmlhdCkgcmV0dXJuICdyZXdyaXRlJzsgLy8gT3RoZXJ3aXNlLCBsYXRlciB3cml0ZXMgYXJlIG5vdC5cbiAgICBpZiAocHJvcG9zZWQuc3ViICE9PSBleGlzdGluZy5zdWIpIHJldHVybiAnYWx0ZXJlZCBjb250ZW50cyc7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmV4cG9ydCBjbGFzcyBNdXRhYmxlQ29sbGVjdGlvbiBleHRlbmRzIENvbGxlY3Rpb24ge1xuICB0YWdGb3JXcml0aW5nKHRhZywgdmFsaWRhdGlvbikgeyAvLyBVc2UgdGFnIGlmIHNwZWNpZmllZCwgYnV0IGRlZmF1bHRzIHRvIGhhc2guXG4gICAgcmV0dXJuIHRhZyB8fCB2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5zdWI7XG4gIH1cbn1cblxuLy8gRWFjaCBWZXJzaW9uZWRDb2xsZWN0aW9uIGhhcyBhIHNldCBvZiBoYXNoLWlkZW50aWZpZWQgaW1tdXRhYmxlIGl0ZW1zIHRoYXQgZm9ybSB0aGUgaW5kaXZpZHVhbCB2ZXJzaW9ucywgYW5kIGEgbWFwIG9mIHRpbWVzdGFtcHMgdG8gdGhvc2UgaXRlbXMuXG4vLyBXZSBjdXJyZW50bHkgbW9kZWwgdGhpcyBieSBoYXZpbmcgdGhlIG1haW4gY29sbGVjdGlvbiBiZSB0aGUgbXV0YWJsZSBtYXAsIGFuZCB0aGUgdmVyc2lvbnMgaW5zdGFuY2UgdmFyaWFibGUgaXMgdGhlIGltbXV0YWJsZSBpdGVtcyBjb2xsZWN0aW9uLlxuLy8gQnV0IGFwcHMgc3RvcmUvcmV0cmlldmUgaW5kaXZpZHVhbCBpdGVtcyB0aHJvdWdoIHRoZSBtYWluIGNvbGxlY3Rpb24sIGFuZCB0aGUgY29ycmVzcG9uZGluZyB1cGRhdGVzIGFyZSB0aHJvdWdoIHRoZSB2ZXJzaW9ucywgd2hpY2ggaXMgYSBiaXQgYXdrd2FyZC5cblxuLy8gRWFjaCBpdGVtIGhhcyBhbiBhbnRlY2VkZW50IHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGFwcGxpY2F0aW9uLXN1cHBsaWVkIHBheWxvYWQgLS0gaXQgbGl2ZXMgaW4gdGhlIHNpZ25hdHVyZSdzIGhlYWRlci5cbi8vIEhvd2V2ZXI6XG4vLyAtIFRoZSB0YWcgRE9FUyBpbmNsdWRlIHRoZSBhbnRlY2VkZW50LCBldmVuIHRob3VnaCBpdCBpcyBub3QgcGFydCBvZiB0aGUgcGF5bG9hZC4gVGhpcyBtYWtlcyBpZGVudGljYWwgcGF5bG9hZHMgaGF2ZVxuLy8gICB1bmlxdWUgdGFncyAoYmVjYXVzZSB0aGV5IHdpbGwgYWx3YXlzIGhhdmUgZGlmZmVyZW50IGFudGVjZWRlbnRzKS5cbi8vIC0gVGhlIGFiaWxpdHkgdG8gd3JpdGUgZm9sbG93cyB0aGUgc2FtZSBydWxlcyBhcyBNdXRhYmxlQ29sbGVjdGlvbiAobGF0ZXN0IHdpbnMpLCBidXQgaXMgdGVzdGVkIGFnYWluc3QgdGhlXG4vLyAgIGFudGVjZWRlbnQgdGFnIGluc3RlYWQgb2YgdGhlIHRhZyBiZWluZyB3cml0dGVuLlxuZXhwb3J0IGNsYXNzIFZlcnNpb25Db2xsZWN0aW9uIGV4dGVuZHMgTXV0YWJsZUNvbGxlY3Rpb24geyAvLyBOZWVkcyB0byBiZSBleHBvcnRlZCBzbyB0aGF0IHRoYXQgcm91dGVyLm1qcyBjYW4gZmluZCBpdC5cbiAgYXN5bmMgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gVXNlIHRhZyBpZiBzcGVjaWZpZWQgKGUuZy4sIHB1dC9kZWxldGUgZHVyaW5nIHN5bmNocm9uaXphdGlvbiksIG90aHdlcndpc2UgcmVmbGVjdCBib3RoIHN1YiBhbmQgYW50ZWNlZGVudC5cbiAgICBpZiAodGFnKSByZXR1cm4gdGFnO1xuICAgIC8vIEVhY2ggdmVyc2lvbiBnZXRzIGEgdW5pcXVlIHRhZyAoZXZlbiBpZiB0aGVyZSBhcmUgdHdvIHZlcnNpb25zIHRoYXQgaGF2ZSB0aGUgc2FtZSBkYXRhIHBheWxvYWQpLlxuICAgIGNvbnN0IGFudCA9IHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLmFudDtcbiAgICBjb25zdCBwYXlsb2FkVGV4dCA9IHZhbGlkYXRpb24udGV4dCB8fCBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUodmFsaWRhdGlvbi5wYXlsb2FkKTtcbiAgICByZXR1cm4gQ3JlZGVudGlhbHMuZW5jb2RlQmFzZTY0dXJsKGF3YWl0IENyZWRlbnRpYWxzLmhhc2hUZXh0KGFudCArIHBheWxvYWRUZXh0KSk7XG4gIH1cbiAgYW50ZWNlZGVudCh2YWxpZGF0aW9uKSB7IC8vIFJldHVybnMgdGhlIHRhZyB0aGF0IHZhbGlkYXRpb24gY29tcGFyZXMgYWdhaW5zdC4gRS5nLiwgZG8gdGhlIG93bmVycyBtYXRjaD9cbiAgICAvLyBGb3Igbm9uLXZlcnNpb25lZCBjb2xsZWN0aW9ucywgd2UgY29tcGFyZSBhZ2FpbnN0IHRoZSBleGlzdGluZyBkYXRhIGF0IHRoZSBzYW1lIHRhZyBiZWluZyB3cml0dGVuLlxuICAgIC8vIEZvciB2ZXJzaW9uZWQgY29sbGVjdGlvbnMsIGl0IGlzIHdoYXQgZXhpc3RzIGFzIHRoZSBsYXRlc3QgdmVyc2lvbiB3aGVuIHRoZSBkYXRhIGlzIHNpZ25lZCwgYW5kIHdoaWNoIHRoZSBzaWduYXR1cmVcbiAgICAvLyByZWNvcmRzIGluIHRoZSBzaWduYXR1cmUuIChGb3IgdGhlIHZlcnkgZmlyc3QgdmVyc2lvbiwgdGhlIHNpZ25hdHVyZSB3aWxsIG5vdGUgdGhlIHRpbWVzdGFtcCBhcyB0aGUgYW50ZWNlY2RlbnQgdGFnLFxuICAgIC8vIChzZWUgdGFnRm9yV3JpdGluZyksIGJ1dCBmb3IgY29tcGFyaW5nIGFnYWluc3QsIHRoaXMgbWV0aG9kIGFuc3dlcnMgZmFsc3kgZm9yIHRoZSBmaXJzdCBpbiB0aGUgY2hhaW4uXG4gICAgY29uc3QgaGVhZGVyID0gdmFsaWRhdGlvbj8ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGlmICghaGVhZGVyKSByZXR1cm4gJyc7XG4gICAgY29uc3QgYW50ZWNlZGVudCA9IGhlYWRlci5hbnQ7XG4gICAgaWYgKHR5cGVvZihhbnRlY2VkZW50KSA9PT0gJ251bWJlcicpIHJldHVybiAnJzsgLy8gQSB0aW1lc3RhbXAgYXMgYW50ZWNlZGVudCBpcyB1c2VkIHRvIHRvIHN0YXJ0IHRoaW5ncyBvZmYuIE5vIHRydWUgYW50ZWNlZGVudC5cbiAgICByZXR1cm4gYW50ZWNlZGVudDtcbiAgfVxuICBhc3luYyBzdWJqZWN0TWF0Y2godmVyaWZpZWQpIHsgLy8gSGVyZSBzdWIgcmVmZXJzIHRvIHRoZSBvdmVyYWxsIGl0ZW0gdGFnIHRoYXQgZW5jb21wYXNzZXMgYWxsIHZlcnNpb25zLCBub3QgdGhlIHBheWxvYWQgaGFzaC5cbiAgICByZXR1cm4gdHJ1ZTsgLy8gVE9ETzogbWFrZSBzdXJlIGl0IG1hdGNoZXMgcHJldmlvdXM/XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBzdWJqZWN0VGFnIChpLmUuLCB0aGUgdGFnIHdpdGhpbiB0aGUgY29sbGVjdGlvbiBhcyBhIHdob2xlKSBpcyBub3QgdGhlIHRhZy9oYXNoLlxuICAgIHZlcmlmaWVkLnN1YmplY3RUYWcgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICAgIHN1cGVyLmVtaXQodmVyaWZpZWQpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBWZXJzaW9uZWRDb2xsZWN0aW9uIGV4dGVuZHMgTXV0YWJsZUNvbGxlY3Rpb24ge1xuICAvLyBUT0RPOiBUaGlzIHdvcmtzIGFuZCBkZW1vbnN0cmF0ZXMgaGF2aW5nIGEgY29sbGVjdGlvbiB1c2luZyBvdGhlciBjb2xsZWN0aW9ucy5cbiAgLy8gSG93ZXZlciwgaGF2aW5nIGEgYmlnIHRpbWVzdGFtcCA9PiBmaXhudW0gbWFwIGlzIGJhZCBmb3IgcGVyZm9ybWFuY2UgYXMgdGhlIGhpc3RvcnkgZ2V0cyBsb25nZXIuXG4gIC8vIFRoaXMgc2hvdWxkIGJlIHNwbGl0IHVwIGludG8gd2hhdCBpcyBkZXNjcmliZWQgaW4gdmVyc2lvbmVkLm1kLlxuICBjb25zdHJ1Y3Rvcih7c2VydmljZXMgPSBbXSwgLi4ucmVzdH0gPSB7fSkge1xuICAgIHN1cGVyKHJlc3QpOyAgLy8gV2l0aG91dCBwYXNzaW5nIHNlcnZpY2VzIHlldCwgYXMgd2UgZG9uJ3QgaGF2ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiBzZXQgdXAgeWV0LlxuICAgIHRoaXMudmVyc2lvbnMgPSBuZXcgVmVyc2lvbkNvbGxlY3Rpb24ocmVzdCk7IC8vIFNhbWUgY29sbGVjdGlvbiBuYW1lLCBidXQgZGlmZmVyZW50IHR5cGUuXG4gICAgLy9maXhtZSB0aGlzLnZlcnNpb25zLmFkZEV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIGV2ZW50ID0+IHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHRoaXMucmVjb3ZlclRhZyhldmVudC5kZXRhaWwpfSkpKTtcbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTsgLy8gTm93IHdlIGNhbiBzeW5jaHJvbml6ZS5cbiAgfVxuICBhc3luYyBjbG9zZSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmNsb3NlKCk7XG4gICAgYXdhaXQgc3VwZXIuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVzdHJveSgpO1xuICAgIGF3YWl0IHN1cGVyLmRlc3Ryb3koKTtcbiAgfVxuICByZWNvdmVyVGFnKHZlcmlmaWVkKSB7IC8vIHRoZSB2ZXJpZmllZC50YWcgaXMgZm9yIHRoZSB2ZXJzaW9uLiBXZSB3YW50IHRoZSBvdmVyYWxsIG9uZS5cbiAgICByZXR1cm4gT2JqZWN0LmFzc2lnbih7fSwgdmVyaWZpZWQsIHt0YWc6IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWJ9KTsgLy8gRG8gbm90IGJhc2ggdmVyaWZpZWQhXG4gIH1cbiAgc2VydmljZUZvclZlcnNpb24oc2VydmljZSkgeyAvLyBHZXQgdGhlIHNlcnZpY2UgXCJuYW1lXCIgZm9yIG91ciB2ZXJzaW9ucyBjb2xsZWN0aW9uLlxuICAgIHJldHVybiBzZXJ2aWNlPy52ZXJzaW9ucyB8fCBzZXJ2aWNlOyAgIC8vIEZvciB0aGUgd2VpcmQgY29ubmVjdERpcmVjdFRlc3RpbmcgY2FzZSB1c2VkIGluIHJlZ3Jlc3Npb24gdGVzdHMsIGVsc2UgdGhlIHNlcnZpY2UgKGUuZy4sIGFuIGFycmF5IG9mIHNpZ25hbHMpLlxuICB9XG4gIHNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykge1xuICAgIHJldHVybiBzZXJ2aWNlcy5tYXAoc2VydmljZSA9PiB0aGlzLnNlcnZpY2VGb3JWZXJzaW9uKHNlcnZpY2UpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBzeW5jaHJvbml6ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiwgdG9vLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSByZXR1cm47XG4gICAgLy8gS2VlcCBjaGFubmVsIGNyZWF0aW9uIHN5bmNocm9ub3VzLlxuICAgIGNvbnN0IHZlcnNpb25lZFByb21pc2UgPSBzdXBlci5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgdmVyc2lvblByb21pc2UgPSB0aGlzLnZlcnNpb25zLnN5bmNocm9uaXplKC4uLnRoaXMuc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSk7XG4gICAgYXdhaXQgdmVyc2lvbmVkUHJvbWlzZTtcbiAgICBhd2FpdCB2ZXJzaW9uUHJvbWlzZTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIGRpc2Nvbm5lY3QgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24sIHRvby5cbiAgICBpZiAoIXNlcnZpY2VzLmxlbmd0aCkgc2VydmljZXMgPSB0aGlzLnNlcnZpY2VzO1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGlzY29ubmVjdCguLi50aGlzLnNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykpO1xuICAgIGF3YWl0IHN1cGVyLmRpc2Nvbm5lY3QoLi4uc2VydmljZXMpO1xuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gc3VwZXIuc3luY2hyb25pemVkLnRoZW4oKCkgPT4gdGhpcy52ZXJzaW9ucy5zeW5jaHJvbml6ZWQpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gVGhlIHZlcnNpb25zIGNvbGxlY3Rpb24gZW1pdHMgYW4gdXBkYXRlIGNvcnJlc3BvbmRpbmcgdG8gdGhlIGluZGl2aWR1YWwgaXRlbSBzdG9yZWQuXG4gICAgLy8gKFRoZSB1cGRhdGVzIGVtaXR0ZWQgZnJvbSB0aGUgd2hvbGUgbXV0YWJsZSBWZXJzaW9uZWRDb2xsZWN0aW9uIGNvcnJlc3BvbmQgdG8gdGhlIG1hcC4pXG4gICAgcmV0dXJuIHRoaXMudmVyc2lvbnM7XG4gIH1cblxuICBhc3luYyBnZXRWZXJzaW9ucyh0YWcpIHsgLy8gUHJvbWlzZXMgdGhlIHBhcnNlZCB0aW1lc3RhbXAgPT4gdmVyc2lvbiBkaWN0aW9uYXJ5IElGIGl0IGV4aXN0cywgZWxzZSBmYWxzeS5cbiAgICB0aGlzLnJlcXVpcmVUYWcodGFnKTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZ30pO1xuICAgIGNvbnN0IGpzb24gPSB2ZXJpZmllZD8uanNvbjtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoanNvbikpIHJldHVybiBqc29uO1xuICAgIC8vIElmIHdlIGhhdmUgYW4gdW5tZXJnZWQgYXJyYXkgb2Ygc2lnbmF0dXJlcy4uLlxuICAgIC8vIEknbSBub3Qgc3VyZSB0aGF0IGl0J3MgdmVyeSB1c2VmdWwgdG8gYXBwbGljYXRpb25zIGZvciB1cyB0byBoYW5kbGUgdGhpcyBjYXNlLCBidXQgaXQgaXMgbmljZSB0byBleGVyY2lzZSB0aGlzIGluIHRlc3RpbmcuXG4gICAgY29uc3QgdmVyaWZpY2F0aW9uc0FycmF5ID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHRoaXMuY29tYmluZVRpbWVzdGFtcHModGFnLCBudWxsLCAuLi52ZXJpZmljYXRpb25zQXJyYXkubWFwKHYgPT4gdi5qc29uKSk7XG4gIH1cbiAgYXN5bmMgcmV0cmlldmVUaW1lc3RhbXBzKHRhZykgeyAvLyBQcm9taXNlcyBhIGxpc3Qgb2YgYWxsIHZlcnNpb24gdGltZXN0YW1wcy5cbiAgICBjb25zdCB2ZXJzaW9ucyA9IGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKTtcbiAgICBpZiAoIXZlcnNpb25zKSByZXR1cm4gdmVyc2lvbnM7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHZlcnNpb25zKS5zbGljZSgxKS5tYXAoc3RyaW5nID0+IHBhcnNlSW50KHN0cmluZykpOyAvLyBUT0RPPyBNYXAgdGhlc2UgdG8gaW50ZWdlcnM/XG4gIH1cbiAgZ2V0QWN0aXZlSGFzaCh0aW1lc3RhbXBzLCB0aW1lID0gdGltZXN0YW1wcy5sYXRlc3QpIHsgLy8gUHJvbWlzZXMgdGhlIHZlcnNpb24gdGFnIHRoYXQgd2FzIGluIGZvcmNlIGF0IHRoZSBzcGVjaWZpZWQgdGltZVxuICAgIC8vICh3aGljaCBtYXkgYmVmb3JlLCBpbiBiZXR3ZWVuLCBvciBhZnRlciB0aGUgcmVjb3JkZWQgZGlzY3JldGUgdGltZXN0YW1wcykuXG4gICAgaWYgKCF0aW1lc3RhbXBzKSByZXR1cm4gdGltZXN0YW1wcztcbiAgICBsZXQgaGFzaCA9IHRpbWVzdGFtcHNbdGltZV07XG4gICAgaWYgKGhhc2gpIHJldHVybiBoYXNoO1xuICAgIC8vIFdlIG5lZWQgdG8gZmluZCB0aGUgdGltZXN0YW1wIHRoYXQgd2FzIGluIGZvcmNlIGF0IHRoZSByZXF1ZXN0ZWQgdGltZS5cbiAgICBsZXQgYmVzdCA9IDAsIHRpbWVzID0gT2JqZWN0LmtleXModGltZXN0YW1wcyk7XG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPCB0aW1lcy5sZW5ndGg7IGkrKykgeyAvLyAwdGggaXMgdGhlIGtleSAnbGF0ZXN0Jy5cbiAgICAgIGlmICh0aW1lc1tpXSA8PSB0aW1lKSBiZXN0ID0gdGltZXNbaV07XG4gICAgICBlbHNlIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4gdGltZXN0YW1wc1tiZXN0XTtcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gQW5zd2VyIHRoZSB2YWxpZGF0ZWQgdmVyc2lvbiBpbiBmb3JjZSBhdCB0aGUgc3BlY2lmaWVkIHRpbWUgKG9yIGxhdGVzdCksIG9yIGF0IHRoZSBzcGVjaWZpYyBoYXNoLlxuICAgIGxldCB7dGFnLCB0aW1lLCBoYXNoLCAuLi5yZXN0fSA9ICghdGFnT3JPcHRpb25zIHx8IHRhZ09yT3B0aW9ucy5sZW5ndGgpID8ge3RhZzogdGFnT3JPcHRpb25zfSA6IHRhZ09yT3B0aW9ucztcbiAgICBpZiAoIWhhc2gpIHtcbiAgICAgIGNvbnN0IHRpbWVzdGFtcHMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgICBpZiAoIXRpbWVzdGFtcHMpIHJldHVybiB0aW1lc3RhbXBzO1xuICAgICAgaGFzaCA9IHRoaXMuZ2V0QWN0aXZlSGFzaCh0aW1lc3RhbXBzLCB0aW1lKTtcbiAgICAgIGlmICghaGFzaCkgcmV0dXJuICcnO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy52ZXJzaW9ucy5yZXRyaWV2ZSh7dGFnOiBoYXNoLCAuLi5yZXN0fSk7XG4gIH1cbiAgYXN5bmMgc3RvcmUoZGF0YSwgb3B0aW9ucyA9IHt9KSB7IC8vIERldGVybWluZSB0aGUgYW50ZWNlZGVudCwgcmVjb3JkIGl0IGluIHRoZSBzaWduYXR1cmUsIGFuZCBzdG9yZSB0aGF0XG4gICAgLy8gYXMgdGhlIGFwcHJvcHJpYXRlIHZlcnNpb24gaGFzaC4gVGhlbiByZWNvcmQgdGhlIG5ldyB0aW1lc3RhbXAvaGFzaCBpbiB0aGUgdGltZXN0YW1wcyBsaXN0LlxuICAgIGxldCB2ZXJzaW9ucyxcblx0Ly8gVE9ETzogQ29uc2lkZXIgZW5jcnlwdGluZyB0aGUgdGltZXN0YW1wcywgdG9vLlxuXHQvLyBDdXJyZW50bHksIHNpZ25pbmdPcHRpb25zIGZvciB0aGUgdGltZXN0YW1wcyBkb2VzIE5PVCBlbmNsdWRlIGVuY3J5cHRpb24sIGV2ZW4gaWYgc3BlY2lmaWVkIGZvciB0aGUgYWN0dWFsIHNwZWNpZmljIHZlcnNpb24gaW5mby5cblx0Ly8gVGhpcyBtZWFucyB0aGF0IGlmIHRoZSBhcHBsaWNhdGlvbiBzcGVjaWZpZXMgYW4gZW5jcnlwdGVkIHZlcnNpb25lZCBjb2xsZWN0aW9uLCB0aGUgZGF0YSBpdHNlbGYgd2lsbCBiZSBlbmNyeXB0ZWQsIGJ1dFxuXHQvLyBub3QgdGhlIG1hcCBvZiB0aW1lc3RhbXBzIHRvIGhhc2hlcywgYW5kIHNvIGEgbHVya2VyIGNhbiBzZWUgd2hlbiB0aGVyZSB3YXMgYWN0aXZpdGl0eSBhbmQgaGF2ZSBhbiBpZGVhIGFzIHRvIHRoZSBzaXplLlxuXHQvLyBPZiBjb3Vyc2UsIGV2ZW4gaWYgZW5jcnlwdGVkLCB0aGV5IGNvdWxkIGFsc28gZ2V0IHRoaXMgZnJvbSBsaXZlIHRyYWZmaWMgYW5hbHlzaXMsIHNvIG1heWJlIGVuY3J5cHRpbmcgaXQgd291bGQganVzdFxuXHQvLyBjb252ZXkgYSBmYWxzZSBzZW5zZSBvZiBzZWN1cml0eS4gRW5jcnlwdGluZyB0aGUgdGltZXN0YW1wcyBkb2VzIGNvbXBsaWNhdGUsIGUuZy4sIG1lcmdlU2lnbmF0dXJlcygpIGJlY2F1c2Vcblx0Ly8gc29tZSBvZiB0aGUgd29yayBjb3VsZCBvbmx5IGJlIGRvbmUgYnkgcmVsYXlzIHRoYXQgaGF2ZSBhY2Nlc3MuIEJ1dCBzaW5jZSB3ZSBoYXZlIHRvIGJlIGNhcmVmdWwgYWJvdXQgc2lnbmluZyBhbnl3YXksXG5cdC8vIHdlIHNob3VsZCB0aGVvcmV0aWNhbGx5IGJlIGFibGUgdG8gYmUgYWNjb21vZGF0ZSB0aGF0LlxuXHR7dGFnLCBlbmNyeXB0aW9uLCAuLi5zaWduaW5nT3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zKG9wdGlvbnMpLFxuXHR0aW1lID0gRGF0ZS5ub3coKSxcblx0dmVyc2lvbk9wdGlvbnMgPSBPYmplY3QuYXNzaWduKHt0aW1lLCBlbmNyeXB0aW9ufSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIGlmICh0YWcpIHtcbiAgICAgIHZlcnNpb25zID0gKGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKSkgfHwge307XG4gICAgICB2ZXJzaW9uT3B0aW9ucy5zdWIgPSB0YWc7XG4gICAgICBpZiAodmVyc2lvbnMpIHtcblx0dmVyc2lvbk9wdGlvbnMuYW50ID0gdmVyc2lvbnNbdmVyc2lvbnMubGF0ZXN0XTtcbiAgICAgIH1cbiAgICB9IC8vIEVsc2UgZG8gbm90IGFzc2lnbiBzdWIuIEl0IHdpbGwgYmUgc2V0IHRvIHRoZSBwYXlsb2FkIGhhc2ggZHVyaW5nIHNpZ25pbmcsIGFuZCBhbHNvIHVzZWQgZm9yIHRoZSBvdmVyYWxsIHRhZy5cbiAgICB2ZXJzaW9uT3B0aW9ucy5hbnQgfHw9IHRpbWU7XG4gICAgY29uc3QgaGFzaCA9IGF3YWl0IHRoaXMudmVyc2lvbnMuc3RvcmUoZGF0YSwgdmVyc2lvbk9wdGlvbnMpO1xuICAgIGlmICghdGFnKSB7IC8vIFdlJ2xsIHN0aWxsIG5lZWQgdGFnIGFuZCB2ZXJzaW9ucy5cbiAgICAgIGNvbnN0IHZlcnNpb25TaWduYXR1cmUgPSBhd2FpdCB0aGlzLnZlcnNpb25zLmdldChoYXNoKTtcbiAgICAgIGNvbnN0IGNsYWltcyA9IENyZWRlbnRpYWxzLmRlY29kZUNsYWltcyh0aGlzLmNvbnN0cnVjdG9yLm1heWJlSW5mbGF0ZSh2ZXJzaW9uU2lnbmF0dXJlKSk7XG4gICAgICB0YWcgPSBjbGFpbXMuc3ViO1xuICAgICAgdmVyc2lvbnMgPSB7fTtcbiAgICB9XG4gICAgdmVyc2lvbnMubGF0ZXN0ID0gdGltZTtcbiAgICB2ZXJzaW9uc1t0aW1lXSA9IGhhc2g7XG5cbiAgICAvLyBmaXhtZSBuZXh0XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKHZlcnNpb25zLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgLy8gSGVyZSB3ZSBhcmUgZG9pbmcgd2hhdCB0aGlzLnB1dCgpIHdvdWxkIG5vcm1hbGx5IGRvLCBidXQgd2UgaGF2ZSBhbHJlYWR5IG1lcmdlZCBzaWduYXR1cmVzLlxuICAgIGF3YWl0IHRoaXMuYWRkVGFnKHRhZyk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHRhZywgc2lnbmF0dXJlKTtcbiAgICB0aGlzLmVtaXQoe3RhZywgc3ViamVjdFRhZzogdGFnLCAuLi4oYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlKSl9KTtcbiAgICBhd2FpdCB0aGlzLnB1c2goJ3B1dCcsIHRhZywgc2lnbmF0dXJlKTtcbiAgICAvLyBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZpZWRTaWduKHZlcnNpb25zLCBzaWduaW5nT3B0aW9ucywgdGFnKTtcbiAgICAvLyB0aGlzLmxvZygncHV0KC1pc2gpJywgdmVyaWZpZWQpO1xuICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIodmVyaWZpZWQpO1xuICAgIC8vIGF3YWl0IHRoaXMuYWRkVGFnKHRhZyk7XG4gICAgLy8gdGhpcy5lbWl0KHsuLi52ZXJpZmllZCwgdGFnLCBzdWJqZWN0VGFnOiB0YWd9KTtcbiAgICAvLyBhd2FpdCB0aGlzLnB1c2goJ3B1dCcsIHRhZywgdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcodmVyaWZpZWQuc2lnbmF0dXJlKSk7XG5cbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIHJlbW92ZShvcHRpb25zID0ge30pIHsgLy8gQWRkIGFuIGVtcHR5IHZlcmlvbiBvciByZW1vdmUgYWxsIHZlcnNpb25zLCBkZXBlbmRpbmcgb24gdGhpcy5wcmVzZXJ2ZURlbGV0aW9ucy5cbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTsgLy8gSWdub3JlIGVuY3J5cHRpb25cbiAgICBjb25zdCB2ZXJzaW9ucyA9IGF3YWl0IHRoaXMuZ2V0VmVyc2lvbnModGFnKTtcbiAgICBpZiAoIXZlcnNpb25zKSByZXR1cm4gdmVyc2lvbnM7XG4gICAgaWYgKHRoaXMucHJlc2VydmVEZWxldGlvbnMpIHsgLy8gQ3JlYXRlIGEgdGltZXN0YW1wID0+IHZlcnNpb24gd2l0aCBhbiBlbXB0eSBwYXlsb2FkLiBPdGhlcndpc2UgbWVyZ2luZyB3aXRoIGVhcmxpZXIgZGF0YSB3aWxsIGJyaW5nIGl0IGJhY2shXG4gICAgICBhd2FpdCB0aGlzLnN0b3JlKCcnLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgfSBlbHNlIHsgLy8gQWN0dWFsbHkgZGVsZXRlIHRoZSB0aW1lc3RhbXBzIGFuZCBlYWNoIHZlcnNpb24uXG4gICAgICAvLyBmaXhtZSBuZXh0XG4gICAgICBjb25zdCB2ZXJzaW9uVGFncyA9IE9iamVjdC52YWx1ZXModmVyc2lvbnMpLnNsaWNlKDEpO1xuICAgICAgY29uc3QgdmVyc2lvblNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbignJywge3N1YjogdGFnLCAuLi5zaWduaW5nT3B0aW9uc30pO1xuICAgICAgLy8gVE9ETzogSXMgdGhpcyBzYWZlPyBTaG91bGQgd2UgbWFrZSBhIHNpZ25hdHVyZSB0aGF0IHNwZWNpZmllcyBlYWNoIGFudGVjZWRlbnQ/XG4gICAgICBhd2FpdCBQcm9taXNlLmFsbCh2ZXJzaW9uVGFncy5tYXAoYXN5bmMgdGFnID0+IHtcblx0YXdhaXQgdGhpcy52ZXJzaW9ucy5kZWxldGUodGFnLCB2ZXJzaW9uU2lnbmF0dXJlKTtcblx0YXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHZlcnNpb25TaWduYXR1cmUpO1xuICAgICAgfSkpO1xuICAgICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKCcnLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QodGFnLCBzaWduYXR1cmUsICdkZWxldGUnKTtcbiAgICAgIGF3YWl0IHRoaXMucHVzaCgnZGVsZXRlJywgdGFnLCBzaWduYXR1cmUpO1xuICAgICAgLy8gY29uc3QgdmVyc2lvbkhhc2hlcyA9IE9iamVjdC52YWx1ZXModmVyc2lvbnMpLnNsaWNlKDEpO1xuICAgICAgLy8gY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmaWVkU2lnbignJywge3N1YjogdGFnLCAuLi5zaWduaW5nT3B0aW9uc30sIHRhZyk7XG4gICAgICAvLyAvLyBUT0RPOiBJcyB0aGlzIHNhZmU/IFNob3VsZCB3ZSBtYWtlIGEgc2lnbmF0dXJlIHRoYXQgc3BlY2lmaWVzIGVhY2ggYW50ZWNlZGVudD9cbiAgICAgIC8vIGF3YWl0IFByb21pc2UuYWxsKHZlcnNpb25IYXNoZXMubWFwKGFzeW5jIGhhc2ggPT4ge1xuICAgICAgLy8gXHRsZXQgdlZlcmlmaWVkID0gey4uLnZlcmlmaWVkLCB0YWc6IGhhc2h9O1xuICAgICAgLy8gXHRsZXQgc1ZlcmlmaWVkID0gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcodlZlcmlmaWVkLnNpZ25hdHVyZSk7XG4gICAgICAvLyBcdC8vIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlVGFnKHRhZyk7XG4gICAgICAvLyBcdC8vIGF3YWl0IHRoaXMudmVyc2lvbnMucGVyc2lzdDIodlZlcmlmaWVkLCAnZGVsZXRlJyk7XG4gICAgICAvLyBcdC8vIHRoaXMudmVyc2lvbnMuZW1pdCh2VmVyaWZpZWQpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLnB1c2goJ2RlbGV0ZScsIHRhZywgc1ZlcmlmaWVkKTtcbiAgICAgIC8vIFx0YXdhaXQgdGhpcy52ZXJzaW9ucy5kZWxldGUodGFnLCBzVmVyaWZpZWQpO1xuICAgICAgLy8gXHRhd2FpdCB0aGlzLnZlcnNpb25zLnB1c2goJ2RlbGV0ZScsIHRhZywgc1ZlcmlmaWVkKVxuICAgICAgLy8gfSkpO1xuICAgICAgLy8gYXdhaXQgdGhpcy5wZXJzaXN0Mih2ZXJpZmllZCwgJ2RlbGV0ZScpO1xuICAgICAgLy8gYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZlcmlmaWVkLnNpZ25hdHVyZSkpO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLmRlbGV0ZVRhZyh0YWcpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgYXN5bmMgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlLCBhdXRob3JPdmVycmlkZSA9IG51bGwpIHsgLy8gTWVyZ2UgdGhlIG5ldyB0aW1lc3RhbXBzIHdpdGggdGhlIG9sZC5cbiAgICAvLyBJZiBwcmV2aW91cyBkb2Vzbid0IGV4aXN0IG9yIG1hdGNoZXMgdGhlIG5leHQsIG9yIGlzIGEgc3Vic2V0IG9mIHRoZSBuZXh0LCBqdXN0IHVzZSB0aGUgbmV4dC5cbiAgICAvLyBPdGhlcndpc2UsIHdlIGhhdmUgdG8gbWVyZ2U6XG4gICAgLy8gLSBNZXJnZWQgbXVzdCBjb250YWluIHRoZSB1bmlvbiBvZiB2YWx1ZXMgZm9yIGVpdGhlci5cbiAgICAvLyAgIChTaW5jZSB2YWx1ZXMgYXJlIGhhc2hlcyBvZiBzdHVmZiB3aXRoIGFuIGV4cGxpY2l0IGFudGVkZW50LCBuZXh0IHByZXZpb3VzIG5vciBuZXh0IHdpbGwgaGF2ZSBkdXBsaWNhdGVzIGJ5IHRoZW1zZWx2ZXMuLilcbiAgICAvLyAtIElmIHRoZXJlJ3MgYSBjb25mbGljdCBpbiBrZXlzLCBjcmVhdGUgYSBuZXcga2V5IHRoYXQgaXMgbWlkd2F5IGJldHdlZW4gdGhlIGNvbmZsaWN0IGFuZCB0aGUgbmV4dCBrZXkgaW4gb3JkZXIuXG5cbiAgICBsZXQgbmV4dCA9IHZhbGlkYXRpb247XG4gICAgbGV0IHByZXZpb3VzID0gdmFsaWRhdGlvbi5leGlzdGluZztcbiAgICAvL2ZpeG1lIG5leHRcbiAgICBpZiAoIXByZXZpb3VzKSByZXR1cm4gc2lnbmF0dXJlOyAgIC8vIE5vIHByZXZpb3VzLCBqdXN0IHVzZSBuZXcgc2lnbmF0dXJlLlxuICAgIC8vaWYgKCFwcmV2aW91cykgcmV0dXJuIG5leHQ7ICAgLy8gTm8gcHJldmlvdXMsIGp1c3QgbmV4dC5cblxuICAgIC8vIEF0IHRoaXMgcG9pbnQsIHByZXZpb3VzIGFuZCBuZXh0IGFyZSBib3RoIFwib3V0ZXJcIiB2YWxpZGF0aW9ucy5cbiAgICAvLyBUaGF0IGpzb24gY2FuIGJlIGVpdGhlciBhIHRpbWVzdGFtcCBvciBhbiBhcnJheSBvZiBzaWduYXR1cmVzLlxuICAgIGlmICh2YWxpZGF0aW9uLnByb3RlY3RlZEhlYWRlci5pYXQgPCB2YWxpZGF0aW9uLmV4aXN0aW5nLnByb3RlY3RlZEhlYWRlci5pYXQpIHsgLy8gQXJyYW5nZSBmb3IgbmV4dCBhbmQgc2lnbmF0dXJlIHRvIGJlIGxhdGVyIG9uZSBieSBzaWduZWQgdGltZXN0YW1wLlxuICAgICAgLy8gVE9ETzogaXMgaXQgcG9zc2libGUgdG8gY29uc3RydWN0IGEgc2NlbmFyaW8gaW4gd2hpY2ggdGhlcmUgaXMgYSBmaWN0aXRpb3VzIHRpbWUgc3RhbXAgY29uZmxpY3QuIEUuZywgaWYgYWxsIG9mIHRoZXNlIGFyZSB0cnVlOlxuICAgICAgLy8gMS4gcHJldmlvdXMgYW5kIG5leHQgaGF2ZSBpZGVudGljYWwgdGltZXN0YW1wcyBmb3IgZGlmZmVyZW50IHZhbHVlcywgYW5kIHNvIHdlIG5lZWQgdG8gY29uc3RydWN0IGFydGlmaWNpYWwgdGltZXMgZm9yIG9uZS4gTGV0J3MgY2FsbCB0aGVzZSBicmFuY2ggQSBhbmQgQi5cbiAgICAgIC8vIDIuIHRoaXMgaGFwcGVucyB3aXRoIHRoZSBzYW1lIHRpbWVzdGFtcCBpbiBhIHNlcGFyYXRlIHBhaXIsIHdoaWNoIHdlJ2xsIGNhbGwgQTIsIGFuZCBCMi5cbiAgICAgIC8vIDMuIEEgYW5kIEIgYXJlIG1lcmdlZCBpbiB0aGF0IG9yZGVyIChlLmcuIHRoZSBsYXN0IHRpbWUgaW4gQSBpcyBsZXNzIHRoYW4gQiksIGJ1dCBBMiBhbmQgQjIgYXJlIG1lcmdlZCBiYWNrd2FyZHMgKGUuZy4sIHRoZSBsYXN0IHRpbWUgaW4gQjIgaXMgbGVzcyB0aGFudCBBMiksXG4gICAgICAvLyAgICBzdWNoIHRoYXQgdGhlIG92ZXJhbGwgbWVyZ2UgY3JlYXRlcyBhIGNvbmZsaWN0P1xuICAgICAgW3ByZXZpb3VzLCBuZXh0XSA9IFtuZXh0LCBwcmV2aW91c107XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgdGltZXN0YW1wcyBvZiBwcmV2aW91cyB3aG9zZSBWQUxVRVMgdGhhdCBhcmUgbm90IGluIG5leHQuXG4gICAgbGV0IGtleXNPZk1pc3NpbmcgPSBudWxsO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShwcmV2aW91cy5qc29uKSAmJiAhQXJyYXkuaXNBcnJheShuZXh0Lmpzb24pKSB7IC8vIE5vIHBvaW50IGluIG9wdGltaXppbmcgdGhyb3VnaCBtaXNzaW5nS2V5cyBpZiB0aGF0IG1ha2VzIHVzIGNvbWJpbmVUaW1lc3RhbXBzIGFueXdheS5cbiAgICAgIGtleXNPZk1pc3NpbmcgPSB0aGlzLm1pc3NpbmdLZXlzKHByZXZpb3VzLmpzb24sIG5leHQuanNvbik7XG4gICAgICAvLyBmaXhtZSBuZXh0XG4gICAgICBpZiAoIWtleXNPZk1pc3NpbmcubGVuZ3RoKSByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcobmV4dC5zaWduYXR1cmUpOyAvLyBQcmV2aW91cyBpcyBhIHN1YnNldCBvZiBuZXcgc2lnbmF0dXJlLlxuICAgICAgLy9pZiAoIWtleXNPZk1pc3NpbmcubGVuZ3RoKSByZXR1cm4gbmV4dDsgLy8gUHJldmlvdXMgaXMgYSBzdWJzZXQgb2YgbmV3IHNpZ25hdHVyZS5cbiAgICB9XG4gICAgLy8gVE9ETzogcmV0dXJuIHByZXZpb3VzIGlmIG5leHQgaXMgYSBzdWJzZXQgb2YgaXQ/XG5cbiAgICAvLyBXZSBjYW5ub3QgcmUtdXNlIG9uZSBvciBvdGhlci4gU2lnbiBhIG5ldyBtZXJnZWQgcmVzdWx0LlxuICAgIGNvbnN0IHByZXZpb3VzVmFsaWRhdGlvbnMgPSBhd2FpdCB0aGlzLmVuc3VyZUV4cGFuZGVkKHByZXZpb3VzKTtcbiAgICBjb25zdCBuZXh0VmFsaWRhdGlvbnMgPSBhd2FpdCB0aGlzLmVuc3VyZUV4cGFuZGVkKG5leHQpO1xuICAgIGlmICghcHJldmlvdXNWYWxpZGF0aW9ucy5sZW5ndGgpIHJldHVybiBzaWduYXR1cmU7XG4gICAgLy8gV2UgY2FuIG9ubHkgdHJ1bHkgbWVyZ2UgaWYgd2UgYXJlIGFuIG93bmVyLlxuICAgIGNvbnN0IGhlYWRlciA9IHByZXZpb3VzVmFsaWRhdGlvbnNbMF0ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGxldCBvd25lciA9IGhlYWRlci5pc3MgfHwgaGVhZGVyLmtpZDtcbiAgICBsZXQgaXNPd25lciA9IFtDcmVkZW50aWFscy5vd25lciwgQ3JlZGVudGlhbHMuYXV0aG9yLCBhdXRob3JPdmVycmlkZV0uaW5jbHVkZXMob3duZXIpO1xuICAgIC8vIElmIHRoZXNlIGFyZSBub3QgdGhlIG93bmVyLCBhbmQgd2Ugd2VyZSBub3QgZ2l2ZW4gYSBzcGVjaWZpYyBvdmVycmlkZSwgdGhlbiBzZWUgaWYgdGhlIHVzZXIgaGFzIGFjY2VzcyB0byB0aGUgb3duZXIgaW4gdGhpcyBleGVjdXRpb24gY29udGV4dC5cbiAgICBsZXQgY2FuU2lnbiA9IGlzT3duZXIgfHwgKCFhdXRob3JPdmVycmlkZSAmJiBhd2FpdCBDcmVkZW50aWFscy5zaWduKCcnLCBvd25lcikuY2F0Y2goKCkgPT4gZmFsc2UpKTtcbiAgICBsZXQgbWVyZ2VkLCBvcHRpb25zLCB0aW1lID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBhdXRob3IgPSBhdXRob3JPdmVycmlkZSB8fCBDcmVkZW50aWFscy5hdXRob3I7XG4gICAgZnVuY3Rpb24gZmxhdHRlbihhLCBiKSB7IHJldHVybiBbXS5jb25jYXQoYSwgYik7IH1cbiAgICBpZiAoIWNhblNpZ24pIHsgLy8gV2UgZG9uJ3QgaGF2ZSBvd25lciBhbmQgY2Fubm90IGdldCBpdC5cbiAgICAgIC8vIENyZWF0ZSBhIHNwZWNpYWwgbm9uLXN0YW5kYXJkIFwic2lnbmF0dXJlXCIgdGhhdCBpcyByZWFsbHkgYW4gYXJyYXkgb2Ygc2lnbmF0dXJlc1xuICAgICAgZnVuY3Rpb24gZ2V0U2lnbmF0dXJlcyh2YWxpZGF0aW9ucykgeyByZXR1cm4gdmFsaWRhdGlvbnMubWFwKHZhbGlkYXRpb24gPT4gdmFsaWRhdGlvbi5zaWduYXR1cmUpOyB9XG4gICAgICBtZXJnZWQgPSBmbGF0dGVuKGdldFNpZ25hdHVyZXMocHJldmlvdXNWYWxpZGF0aW9ucyksIGdldFNpZ25hdHVyZXMobmV4dFZhbGlkYXRpb25zKSk7XG4gICAgICBvcHRpb25zID0ge3RhZ3M6IFthdXRob3JdLCB0aW1lfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZnVuY3Rpb24gZ2V0SlNPTnModmFsaWRhdGlvbnMpIHsgcmV0dXJuIHZhbGlkYXRpb25zLm1hcCh2YWxpZGF0aW9uID0+IHZhbGlkYXRpb24uanNvbik7IH1cbiAgICAgIGNvbnN0IGZsYXR0ZW5lZCA9IGZsYXR0ZW4oZ2V0SlNPTnMocHJldmlvdXNWYWxpZGF0aW9ucyksIGdldEpTT05zKG5leHRWYWxpZGF0aW9ucykpO1xuICAgICAgbWVyZ2VkID0gdGhpcy5jb21iaW5lVGltZXN0YW1wcyhuZXh0LnRhZywga2V5c09mTWlzc2luZywgLi4uZmxhdHRlbmVkKTtcbiAgICAgIG9wdGlvbnMgPSB7dGVhbTogb3duZXIsIG1lbWJlcjogYXV0aG9yLCB0aW1lfTtcbiAgICB9XG4gICAgLy8gZml4bWUgbmV4dFxuICAgIHJldHVybiBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24obWVyZ2VkLCBvcHRpb25zKTtcbiAgICAvL3JldHVybiBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmaWVkU2lnbihtZXJnZWQsIG9wdGlvbnMpO1xuICB9XG4gIGVuc3VyZUV4cGFuZGVkKHZhbGlkYXRpb24pIHsgLy8gUHJvbWlzZSBhbiBhcnJheSBvZiB2ZXJpZmljYXRpb25zICh2ZXJpZnlpbmcgZWxlbWVudHMgb2YgdmFsaWRhdGlvbi5qc29uIGlmIG5lZWRlZCkuXG4gICAgaWYgKCF2YWxpZGF0aW9uIHx8ICF2YWxpZGF0aW9uLmpzb24pIHJldHVybiBbXTtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsaWRhdGlvbi5qc29uKSkgcmV0dXJuIFt2YWxpZGF0aW9uXTtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodmFsaWRhdGlvbi5qc29uLm1hcChzaWduYXR1cmUgPT4gdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZnkoc2lnbmF0dXJlKSkpXG4gICAgICAudGhlbihzaWduYXR1cmVzID0+IHNpZ25hdHVyZXMuZmlsdGVyKHNpZyA9PiBzaWcpKTtcbiAgfVxuICBtaXNzaW5nS2V5cyhwcmV2aW91c01hcHBpbmcsIG5leHRNYXBwaW5ncykgeyAvLyBBbnN3ZXIgYSBsaXN0IG9mIHRob3NlIGtleXMgZnJvbSBwcmV2aW91cyB0aGF0IGRvIG5vdCBoYXZlIHZhbHVlcyBpbiBuZXh0LlxuICAgIGNvbnN0IG5leHRWYWx1ZXMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobmV4dE1hcHBpbmdzKSk7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHByZXZpb3VzTWFwcGluZykuZmlsdGVyKGtleSA9PiBrZXkgIT09ICdsYXRlc3QnICYmICFuZXh0VmFsdWVzLmhhcyhwcmV2aW91c01hcHBpbmdba2V5XSkpO1xuICB9XG4gIGNvbWJpbmVUaW1lc3RhbXBzKHRhZywga2V5c09mTWlzc2luZywgcHJldmlvdXNNYXBwaW5ncywgbmV4dE1hcHBpbmdzLCAuLi5yZXN0KSB7IC8vIFJldHVybiBhIG1lcmdlZCBkaWN0aW9uYXJ5IG9mIHRpbWVzdGFtcCA9PiBoYXNoLCBjb250YWluaW5nIGFsbCBvZiBwcmV2aW91cyBhbmQgbmV4dE1hcHBpbmdzLlxuICAgIC8vIFdlJ2xsIG5lZWQgYSBuZXcgb2JqZWN0IHRvIHN0b3JlIHRoZSB1bmlvbiwgYmVjYXVzZSB0aGUga2V5cyBtdXN0IGJlIGluIHRpbWUgb3JkZXIsIG5vdCB0aGUgb3JkZXIgdGhleSB3ZXJlIGFkZGVkLlxuICAgIGtleXNPZk1pc3NpbmcgfHw9IHRoaXMubWlzc2luZ0tleXMocHJldmlvdXNNYXBwaW5ncywgbmV4dE1hcHBpbmdzKTtcbiAgICBjb25zdCBtZXJnZWQgPSB7fTtcbiAgICBsZXQgbWlzc2luZ0luZGV4ID0gMCwgbWlzc2luZ1RpbWUsIG5leHRUaW1lcztcbiAgICBmb3IgKGNvbnN0IG5leHRUaW1lIGluIG5leHRNYXBwaW5ncykge1xuICAgICAgbWlzc2luZ1RpbWUgPSAwO1xuXG4gICAgICAvLyBNZXJnZSBhbnkgcmVtYWluaW5nIGtleXNPZk1pc3NpbmcgdGhhdCBjb21lIHN0cmljdGx5IGJlZm9yZSBuZXh0VGltZTpcbiAgICAgIGlmIChuZXh0VGltZSAhPT0gJ2xhdGVzdCcpIHtcblx0Zm9yICg7IChtaXNzaW5nSW5kZXggPCBrZXlzT2ZNaXNzaW5nLmxlbmd0aCkgJiYgKChtaXNzaW5nVGltZSA9IGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4XSkgPCBuZXh0VGltZSk7IG1pc3NpbmdJbmRleCsrKSB7XG5cdCAgbWVyZ2VkW21pc3NpbmdUaW1lXSA9IHByZXZpb3VzTWFwcGluZ3NbbWlzc2luZ1RpbWVdO1xuXHR9XG4gICAgICB9XG5cbiAgICAgIGlmIChtaXNzaW5nVGltZSA9PT0gbmV4dFRpbWUpIHsgLy8gVHdvIGRpZmZlcmVudCB2YWx1ZXMgYXQgdGhlIGV4YWN0IHNhbWUgdGltZS4gRXh0cmVtZWx5IHJhcmUuXG5cdGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgYFVudXN1YWwgbWF0Y2hpbmcgdGltZXN0YW1wIGNhc2UgYXQgdGltZSAke21pc3NpbmdUaW1lfSBmb3IgdGFnICR7dGFnfS5gKTtcblx0bmV4dFRpbWVzIHx8PSBPYmplY3Qua2V5cyhuZXh0TWFwcGluZ3MpOyAvLyBXZSBkaWRuJ3QgbmVlZCB0aGlzIGZvciBvdXIgbG9vcC4gR2VuZXJhdGUgbm93IGlmIG5lZWRlZC5cblx0Y29uc3QgbmV4dE5leHRUaW1lID0gTWF0aC5taW4oa2V5c09mTWlzc2luZ1ttaXNzaW5nSW5kZXggKyAxXSB8fCBJbmZpbml0eSxcblx0XHRcdFx0ICAgICAgbmV4dE1hcHBpbmdzW25leHRUaW1lcy5pbmRleE9mKG5leHRUaW1lKSArIDFdIHx8IEluZmluaXR5KTtcblx0Y29uc3QgaW5zZXJ0VGltZSA9IG5leHRUaW1lICsgKG5leHROZXh0VGltZSAtIG5leHRUaW1lKSAvIDI7XG5cdC8vIFdlIGFscmVhZHkgcHV0IHRoZXNlIGluIG9yZGVyIHdpdGggcHJldmlvdXNNYXBwaW5ncyBmaXJzdC5cblx0bWVyZ2VkW25leHRUaW1lXSA9IHByZXZpb3VzTWFwcGluZ3NbbmV4dFRpbWVdO1xuXHRtZXJnZWRbaW5zZXJ0VGltZV0gPSBuZXh0TWFwcGluZ3NbbmV4dFRpbWVdO1xuXG4gICAgICB9IGVsc2UgeyAvLyBObyBjb25mbGljdHMuIEp1c3QgYWRkIG5leHQuXG5cdG1lcmdlZFtuZXh0VGltZV0gPSBuZXh0TWFwcGluZ3NbbmV4dFRpbWVdO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRoZXJlIGNhbiBiZSBtaXNzaW5nIHN0dWZmIHRvIGFkZCBhdCB0aGUgZW5kO1xuICAgIGZvciAoOyBtaXNzaW5nSW5kZXggPCBrZXlzT2ZNaXNzaW5nLmxlbmd0aDsgbWlzc2luZ0luZGV4KyspIHtcbiAgICAgIG1pc3NpbmdUaW1lID0ga2V5c09mTWlzc2luZ1ttaXNzaW5nSW5kZXhdO1xuICAgICAgbWVyZ2VkW21pc3NpbmdUaW1lXSA9IHByZXZpb3VzTWFwcGluZ3NbbWlzc2luZ1RpbWVdO1xuICAgIH1cbiAgICBsZXQgbWVyZ2VkVGltZXMgPSBPYmplY3Qua2V5cyhtZXJnZWQpO1xuICAgIG1lcmdlZC5sYXRlc3QgPSBtZXJnZWRUaW1lc1ttZXJnZWRUaW1lcy5sZW5ndGggLSAxXTtcbiAgICByZXR1cm4gcmVzdC5sZW5ndGggPyB0aGlzLmNvbWJpbmVUaW1lc3RhbXBzKHRhZywgdW5kZWZpbmVkLCBtZXJnZWQsIC4uLnJlc3QpIDogbWVyZ2VkO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zID0ge30pIHsgLy8gQW4gYXJyYXkgb2YgdW5tZXJnZWQgc2lnbmF0dXJlcyBjYW4gYmUgdmVyaWZpZWQuXG4gICAgaWYgKHNpZ25hdHVyZS5zdGFydHNXaXRoPy4oJ1snKSkgc2lnbmF0dXJlID0gSlNPTi5wYXJzZShzaWduYXR1cmUpOyAvLyAobWF5YmVJbmZsYXRlIGxvb2tzIGZvciAneycsIG5vdCAnWycuKVxuICAgIGlmICghQXJyYXkuaXNBcnJheShzaWduYXR1cmUpKSByZXR1cm4gYXdhaXQgc3VwZXIudmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyk7XG4gICAgY29uc3QgY29tYmluZWQgPSBhd2FpdCBQcm9taXNlLmFsbChzaWduYXR1cmUubWFwKGVsZW1lbnQgPT4gdGhpcy52ZXJpZnkoZWxlbWVudCwgb3B0aW9ucykpKTtcbiAgICBjb25zdCBvayA9IGNvbWJpbmVkLmV2ZXJ5KGVsZW1lbnQgPT4gZWxlbWVudCk7XG4gICAgaWYgKCFvaykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBjb25zdCBwcm90ZWN0ZWRIZWFkZXIgPSBjb21iaW5lZFswXS5wcm90ZWN0ZWRIZWFkZXI7XG4gICAgZm9yIChjb25zdCBwcm9wZXJ0eSBvZiBbJ2lzcycsICdraWQnLCAnYWxnJywgJ2N0eSddKSB7IC8vIE91ciBvcGVyYXRpb25zIG1ha2UgdXNlIG9mIGlzcywga2lkLCBhbmQgaWF0LlxuICAgICAgY29uc3QgbWF0Y2hpbmcgPSBwcm90ZWN0ZWRIZWFkZXJbcHJvcGVydHldO1xuICAgICAgY29uc3QgbWF0Y2hlcyA9IGNvbWJpbmVkLmV2ZXJ5KGVsZW1lbnQgPT4gZWxlbWVudC5wcm90ZWN0ZWRIZWFkZXJbcHJvcGVydHldID09PSBtYXRjaGluZyk7XG4gICAgICBpZiAobWF0Y2hlcykgY29udGludWU7XG4gICAgICBpZiAoIW1hdGNoZXMpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGNvbnN0IHtpc3MsIGtpZCwgYWxnLCBjdHl9ID0gcHJvdGVjdGVkSGVhZGVyO1xuICAgIGNvbnN0IHZlcmlmaWVkID0ge1xuICAgICAgc2lnbmF0dXJlLCAvLyBhcnJheSBhdCB0aGlzIHBvaW50XG4gICAgICBqc29uOiBjb21iaW5lZC5tYXAoZWxlbWVudCA9PiBlbGVtZW50Lmpzb24pLFxuICAgICAgcHJvdGVjdGVkSGVhZGVyOiB7aXNzLCBraWQsIGFsZywgY3R5LCBpYXQ6IE1hdGgubWF4KC4uLmNvbWJpbmVkLm1hcChlbGVtZW50ID0+IGVsZW1lbnQucHJvdGVjdGVkSGVhZGVyLmlhdCkpfVxuICAgIH07XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIGJhY2tkYXRpbmcgaXMgYWxsb3dlZC4gKG1lcmdpbmcpLlxuICAgIGlmICghcHJvcG9zZWQpIHJldHVybiAnaW52YWxpZCBzaWduYXR1cmUnO1xuICAgIGlmICghZXhpc3RpbmcpIHJldHVybiBudWxsO1xuICAgIGlmICghdGhpcy5vd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkpIHJldHVybiAnbm90IG93bmVyJztcbiAgICBpZiAoIWF3YWl0IHRoaXMuc3ViamVjdE1hdGNoKHZlcmlmaWVkKSkgcmV0dXJuICd3cm9uZyBoYXNoJztcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBvd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkgeyAvLyBUT0RPOiBFaXRoZXIgdGhleSBtdXN0IG1hdGNoIChhcyBpbiBzdXBlcikgb3IgdGhlIG5ldyBwYXlsb2FkIG11c3QgaW5jbHVkZSB0aGUgcHJldmlvdXMuXG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuXG4vLyBXaGVuIHJ1bm5pbmcgaW4gTm9kZUpTLCB0aGUgU2VjdXJpdHkgb2JqZWN0IGlzIGF2YWlsYWJsZSBkaXJlY3RseS5cbi8vIEl0IGhhcyBhIFN0b3JhZ2UgcHJvcGVydHksIHdoaWNoIGRlZmluZXMgc3RvcmUvcmV0cmlldmUgKGluIGxpYi9zdG9yYWdlLm1qcykgdG8gR0VUL1BVVCBvblxuLy8gLi4uLzpmdWxsTGFiZWwvOnBhcnQxb2ZUYWcvOnBhcnQyb2ZUYWcvOnBhcnQzb2ZUYWcvOnJlc3RPZlRhZy5qc29uXG4vLyBUaGUgU2VjdXJpdHkuU3RvcmFnZSBjYW4gYmUgc2V0IGJ5IGNsaWVudHMgdG8gc29tZXRoaW5nIGVsc2UuXG4vL1xuLy8gV2hlbiBydW5uaW5nIGluIGEgYnJvd3Nlciwgd29ya2VyLmpzIG92ZXJyaWRlcyB0aGlzIHRvIHNlbmQgbWVzc2FnZXMgdGhyb3VnaCB0aGUgSlNPTiBSUENcbi8vIHRvIHRoZSBhcHAsIHdoaWNoIHRoZW4gYWxzbyBoYXMgYW4gb3ZlcnJpZGFibGUgU2VjdXJpdHkuU3RvcmFnZSB0aGF0IGlzIGltcGxlbWVudGVkIHdpdGggdGhlIHNhbWUgY29kZSBhcyBhYm92ZS5cblxuLy8gQmFzaCBpbiBzb21lIG5ldyBzdHVmZjpcbkNyZWRlbnRpYWxzLmF1dGhvciA9IG51bGw7XG5DcmVkZW50aWFscy5vd25lciA9IG51bGw7XG5DcmVkZW50aWFscy5lbmNyeXB0aW9uID0gbnVsbDsgLy8gVE9ETzogcmVuYW1lIHRoaXMgdG8gYXVkaWVuY2VcbkNyZWRlbnRpYWxzLnN5bmNocm9uaXplID0gYXN5bmMgKC4uLnNlcnZpY2VzKSA9PiB7IC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGNvbm5lY3QuXG4gIC8vIFdlIGNhbiBkbyBhbGwgdGhyZWUgaW4gcGFyYWxsZWwgLS0gd2l0aG91dCB3YWl0aW5nIGZvciBjb21wbGV0aW9uIC0tIGJlY2F1c2UgZGVwZW5kZW5jaWVzIHdpbGwgZ2V0IHNvcnRlZCBvdXQgYnkgc3luY2hyb25pemUxLlxuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykpKTtcbn07XG5DcmVkZW50aWFscy5zeW5jaHJvbml6ZWQgPSBhc3luYyAoKSA9PiB7XG4gIHJldHVybiBQcm9taXNlLmFsbChPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKS5tYXAoY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnN5bmNocm9uaXplZCkpO1xufVxuQ3JlZGVudGlhbHMuZGlzY29ubmVjdCA9IGFzeW5jICguLi5zZXJ2aWNlcykgPT4ge1xuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5kaXNjb25uZWN0KC4uLnNlcnZpY2VzKSkpO1xufVxuXG5DcmVkZW50aWFscy5jcmVhdGVBdXRob3IgPSBhc3luYyAocHJvbXB0KSA9PiB7IC8vIENyZWF0ZSBhIHVzZXI6XG4gIC8vIElmIHByb21wdCBpcyAnLScsIGNyZWF0ZXMgYW4gaW52aXRhdGlvbiBhY2NvdW50LCB3aXRoIGEgbm8tb3AgcmVjb3ZlcnkgYW5kIG5vIGRldmljZS5cbiAgLy8gT3RoZXJ3aXNlLCBwcm9tcHQgaW5kaWNhdGVzIHRoZSByZWNvdmVyeSBwcm9tcHRzLCBhbmQgdGhlIGFjY291bnQgaGFzIHRoYXQgYW5kIGEgZGV2aWNlLlxuICBpZiAocHJvbXB0ID09PSAnLScpIHJldHVybiBDcmVkZW50aWFscy5jcmVhdGUoYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHR9KSk7XG4gIGNvbnN0IFtsb2NhbCwgcmVjb3ZlcnldID0gYXdhaXQgUHJvbWlzZS5hbGwoW0NyZWRlbnRpYWxzLmNyZWF0ZSgpLCBDcmVkZW50aWFscy5jcmVhdGUoe3Byb21wdH0pXSk7XG4gIHJldHVybiBDcmVkZW50aWFscy5jcmVhdGUobG9jYWwsIHJlY292ZXJ5KTtcbn07XG5DcmVkZW50aWFscy5jbGFpbUludml0YXRpb24gPSBhc3luYyAodGFnLCBuZXdQcm9tcHQpID0+IHsgLy8gQ3JlYXRlcyBhIGxvY2FsIGRldmljZSB0YWcgYW5kIGFkZHMgaXQgdG8gdGhlIGdpdmVuIGludml0YXRpb24gdGFnLFxuICAvLyB1c2luZyB0aGUgc2VsZi12YWxpZGF0aW5nIHJlY292ZXJ5IG1lbWJlciB0aGF0IGlzIHRoZW4gcmVtb3ZlZCBhbmQgZGVzdHJveWVkLlxuICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zLlRlYW0ucmV0cmlldmUoe3RhZ30pO1xuICBpZiAoIXZlcmlmaWVkKSB0aHJvdyBuZXcgRXJyb3IoYFVuYWJsZSB0byB2ZXJpZnkgaW52aXRhdGlvbiAke3RhZ30uYCk7XG4gIGNvbnN0IG1lbWJlcnMgPSB2ZXJpZmllZC5qc29uLnJlY2lwaWVudHM7XG4gIGlmIChtZW1iZXJzLmxlbmd0aCAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKGBJbnZpdGF0aW9ucyBzaG91bGQgaGF2ZSBvbmUgbWVtYmVyOiAke3RhZ31gKTtcbiAgY29uc3Qgb2xkUmVjb3ZlcnlUYWcgPSBtZW1iZXJzWzBdLmhlYWRlci5raWQ7XG4gIGNvbnN0IG5ld1JlY292ZXJ5VGFnID0gYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHQ6IG5ld1Byb21wdH0pO1xuICBjb25zdCBkZXZpY2VUYWcgPSBhd2FpdCBDcmVkZW50aWFscy5jcmVhdGUoKTtcblxuICAvLyBXZSBuZWVkIHRvIGFkZCB0aGUgbmV3IG1lbWJlcnMgaW4gb25lIGNoYW5nZU1lbWJlcnNoaXAgc3RlcCwgYW5kIHRoZW4gcmVtb3ZlIHRoZSBvbGRSZWNvdmVyeVRhZyBpbiBhIHNlY29uZCBjYWxsIHRvIGNoYW5nZU1lbWJlcnNoaXA6XG4gIC8vIGNoYW5nZU1lbWJlcnNoaXAgd2lsbCBzaWduIGJ5IGFuIE9MRCBtZW1iZXIgLSBJZiBpdCBzaWduZWQgYnkgbmV3IG1lbWJlciB0aGFuIHBlb3BsZSBjb3VsZCBib290c3RyYXAgdGhlbXNlbHZlcyBvbnRvIGEgdGVhbS5cbiAgLy8gQnV0IGlmIHdlIHJlbW92ZSB0aGUgb2xkUmVjb3ZlcnkgdGFnIGluIHRoZSBzYW1lIHN0ZXAgYXMgYWRkaW5nIHRoZSBuZXcsIHRoZSB0ZWFtIHdvdWxkIGJlIHNpZ25lZCBieSBzb21lb25lICh0aGUgb2xkUmVjb3ZlcnlUYWcpIHRoYXRcbiAgLy8gaXMgbm8gbG9uZ2VyIGEgbWVtYmVyLCBhbmQgc28gdGhlIHRlYW0gd291bGQgbm90IHZlcmlmeSFcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2hhbmdlTWVtYmVyc2hpcCh7dGFnLCBhZGQ6IFtkZXZpY2VUYWcsIG5ld1JlY292ZXJ5VGFnXSwgcmVtb3ZlOiBbb2xkUmVjb3ZlcnlUYWddfSk7XG4gIGF3YWl0IENyZWRlbnRpYWxzLmNoYW5nZU1lbWJlcnNoaXAoe3RhZywgcmVtb3ZlOiBbb2xkUmVjb3ZlcnlUYWddfSk7XG4gIGF3YWl0IENyZWRlbnRpYWxzLmRlc3Ryb3kob2xkUmVjb3ZlcnlUYWcpO1xuICByZXR1cm4gdGFnO1xufTtcblxuLy8gc2V0QW5zd2VyIG11c3QgYmUgcmUtcHJvdmlkZWQgd2hlbmV2ZXIgd2UncmUgYWJvdXQgdG8gYWNjZXNzIHJlY292ZXJ5IGtleS5cbmNvbnN0IGFuc3dlcnMgPSB7fTtcbkNyZWRlbnRpYWxzLnNldEFuc3dlciA9IChwcm9tcHQsIGFuc3dlcikgPT4gYW5zd2Vyc1twcm9tcHRdID0gYW5zd2VyO1xuQ3JlZGVudGlhbHMuZ2V0VXNlckRldmljZVNlY3JldCA9IGZ1bmN0aW9uIGZsZXhzdG9yZVNlY3JldCh0YWcsIHByb21wdFN0cmluZykge1xuICBpZiAoIXByb21wdFN0cmluZykgcmV0dXJuIHRhZztcbiAgaWYgKHByb21wdFN0cmluZyA9PT0gJy0nKSByZXR1cm4gcHJvbXB0U3RyaW5nOyAvLyBTZWUgY3JlYXRlQXV0aG9yLlxuICBjb25zdCBhbnN3ZXIgPSBhbnN3ZXJzW3Byb21wdFN0cmluZ107XG4gIGlmIChhbnN3ZXIpIHJldHVybiBhbnN3ZXI7XG4gIC8vIERpc3RyaWJ1dGVkIFNlY3VyaXR5IHdpbGwgdHJ5IGV2ZXJ5dGhpbmcuIFVubGVzcyBnb2luZyB0aHJvdWdoIGEgcGF0aCBhYm92ZSwgd2Ugd291bGQgbGlrZSBvdGhlcnMgdG8gc2lsZW50bHkgZmFpbC5cbiAgY29uc29sZS5sb2coYEF0dGVtcHRpbmcgYWNjZXNzICR7dGFnfSB3aXRoIHByb21wdCAnJHtwcm9tcHRTdHJpbmd9Jy5gKTtcbiAgcmV0dXJuIFwibm90IGEgc2VjcmV0XCI7IC8vIHRvZG86IGNyeXB0byByYW5kb21cbn07XG5cblxuLy8gVGhlc2UgdHdvIGFyZSB1c2VkIGRpcmVjdGx5IGJ5IGRpc3RyaWJ1dGVkLXNlY3VyaXR5LlxuQ3JlZGVudGlhbHMuU3RvcmFnZS5yZXRyaWV2ZSA9IGFzeW5jIChjb2xsZWN0aW9uTmFtZSwgdGFnKSA9PiB7XG4gIGNvbnN0IGNvbGxlY3Rpb24gPSBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tjb2xsZWN0aW9uTmFtZV07XG4gIC8vIE5vIG5lZWQgdG8gdmVyaWZ5LCBhcyBkaXN0cmlidXRlZC1zZWN1cml0eSBkb2VzIHRoYXQgaXRzZWxmIHF1aXRlIGNhcmVmdWxseSBhbmQgdGVhbS1hd2FyZS5cbiAgaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnRW5jcnlwdGlvbktleScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7XG4gIGlmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ0tleVJlY292ZXJ5JykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTtcbiAgLy9pZiAoY29sbGVjdGlvbk5hbWUgPT09ICdUZWFtJykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTsgICAgLy8gVGhpcyB3b3VsZCBnbyBjaXJjdWxhci4gU2hvdWxkIGl0PyBEbyB3ZSBuZWVkIGl0P1xuICBjb25zdCBkYXRhID0gYXdhaXQgY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgLy8gSG93ZXZlciwgc2luY2Ugd2UgaGF2ZSBieXBhc3NlZCBDb2xsZWN0aW9uLnJldHJpZXZlLCB3ZSBtYXliZUluZmxhdGUgaGVyZS5cbiAgcmV0dXJuIENvbGxlY3Rpb24ubWF5YmVJbmZsYXRlKGRhdGEpO1xufVxuY29uc3QgRU1QVFlfU1RSSU5HX0hBU0ggPSBcIjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlVcIjsgLy8gSGFzaCBvZiBhbiBlbXB0eSBzdHJpbmcuXG5DcmVkZW50aWFscy5TdG9yYWdlLnN0b3JlID0gYXN5bmMgKGNvbGxlY3Rpb25OYW1lLCB0YWcsIHNpZ25hdHVyZSkgPT4ge1xuICAvLyBObyBuZWVkIHRvIGVuY3J5cHQvc2lnbiBhcyBieSBzdG9yZSwgc2luY2UgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgZG9lcyB0aGF0IGluIGEgY2lyY3VsYXJpdHktYXdhcmUgd2F5LlxuICAvLyBIb3dldmVyLCB3ZSBkbyBjdXJyZW50bHkgbmVlZCB0byBmaW5kIG91dCBvZiB0aGUgc2lnbmF0dXJlIGhhcyBhIHBheWxvYWQgYW5kIHB1c2hcbiAgLy8gVE9ETzogTW9kaWZ5IGRpc3Qtc2VjIHRvIGhhdmUgYSBzZXBhcmF0ZSBzdG9yZS9kZWxldGUsIHJhdGhlciB0aGFuIGhhdmluZyB0byBmaWd1cmUgdGhpcyBvdXQgaGVyZS5cbiAgY29uc3QgY2xhaW1zID0gQ3JlZGVudGlhbHMuZGVjb2RlQ2xhaW1zKHNpZ25hdHVyZSk7XG4gIGNvbnN0IGVtcHR5UGF5bG9hZCA9IGNsYWltcz8uc3ViID09PSBFTVBUWV9TVFJJTkdfSEFTSDtcblxuICBjb25zdCBjb2xsZWN0aW9uID0gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbY29sbGVjdGlvbk5hbWVdO1xuICBzaWduYXR1cmUgPSBDb2xsZWN0aW9uLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICBjb25zdCBzdG9yZWQgPSBhd2FpdCAoZW1wdHlQYXlsb2FkID8gY29sbGVjdGlvbi5kZWxldGUodGFnLCBzaWduYXR1cmUpIDogY29sbGVjdGlvbi5wdXQodGFnLCBzaWduYXR1cmUpKTtcbiAgaWYgKHN0b3JlZCAhPT0gdGFnKSB0aHJvdyBuZXcgRXJyb3IoYFVuYWJsZSB0byB3cml0ZSBjcmVkZW50aWFsICR7dGFnfS5gKTtcbiAgaWYgKHRhZykgYXdhaXQgY29sbGVjdGlvbi5wdXNoKGVtcHR5UGF5bG9hZCA/ICdkZWxldGUnOiAncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICByZXR1cm4gdGFnO1xufTtcbkNyZWRlbnRpYWxzLlN0b3JhZ2UuZGVzdHJveSA9IGFzeW5jICgpID0+IHtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2xlYXIoKTsgLy8gV2lwZSBmcm9tIGxpdmUgbWVtb3J5LlxuICBmb3IgKGxldCBjb2xsZWN0aW9uIG9mIE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpKSB7XG4gICAgYXdhaXQgY29sbGVjdGlvbi5kZXN0cm95KCk7XG4gIH1cbiAgYXdhaXQgQ3JlZGVudGlhbHMud2lwZURldmljZUtleXMoKTsgLy8gTm90IGluY2x1ZGVkIGluIHRoZSBhYm92ZS5cbn07XG5DcmVkZW50aWFscy5jb2xsZWN0aW9ucyA9IHt9O1xuZXhwb3J0IHsgQ3JlZGVudGlhbHMsIFN0b3JhZ2VMb2NhbCB9O1xuWydFbmNyeXB0aW9uS2V5JywgJ0tleVJlY292ZXJ5JywgJ1RlYW0nXS5mb3JFYWNoKG5hbWUgPT4gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbbmFtZV0gPSBuZXcgTXV0YWJsZUNvbGxlY3Rpb24oe25hbWV9KSk7XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgdXVpZDQgZnJvbSAndXVpZDQnO1xuaW1wb3J0IFN5bmNocm9uaXplciBmcm9tICcuL2xpYi9zeW5jaHJvbml6ZXIubWpzJztcbmltcG9ydCB7IENvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIE11dGFibGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBWZXJzaW9uQ29sbGVjdGlvbiwgU3RvcmFnZUxvY2FsIH0gZnJvbSAgJy4vbGliL2NvbGxlY3Rpb25zLm1qcyc7XG5pbXBvcnQgeyBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vbGliL3dlYnJ0Yy5tanMnO1xuaW1wb3J0IHsgdmVyc2lvbiwgbmFtZSwgc3RvcmFnZVZlcnNpb24sIHN0b3JhZ2VOYW1lIH0gZnJvbSAnLi9saWIvdmVyc2lvbi5tanMnO1xuXG5jb25zb2xlLmxvZyhgJHtuYW1lfSAke3ZlcnNpb259IGZyb20gJHtpbXBvcnQubWV0YS51cmx9LmApO1xuXG5leHBvcnQgeyBDcmVkZW50aWFscywgQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIFZlcnNpb25lZENvbGxlY3Rpb24sIFZlcnNpb25Db2xsZWN0aW9uLCBTeW5jaHJvbml6ZXIsIFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDLCBuYW1lLCB2ZXJzaW9uLCBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24sIFN0b3JhZ2VMb2NhbCwgdXVpZDQgfTtcbmV4cG9ydCBkZWZhdWx0IHsgQ3JlZGVudGlhbHMsIENvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIE11dGFibGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBWZXJzaW9uQ29sbGVjdGlvbiwgU3luY2hyb25pemVyLCBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQywgbmFtZSwgdmVyc2lvbiwgIHN0b3JhZ2VOYW1lLCBzdG9yYWdlVmVyc2lvbiwgU3RvcmFnZUxvY2FsLCB1dWlkNCB9O1xuIl0sIm5hbWVzIjpbInBrZy5kZWZhdWx0IiwiU3RvcmFnZUxvY2FsIl0sIm1hcHBpbmdzIjoiOzs7QUFBQSxNQUFNLFdBQVcsR0FBRyx3RUFBd0U7QUFDNUYsU0FBUyxLQUFLLENBQUMsSUFBSSxFQUFFO0FBQ3JCLEVBQUUsT0FBTyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztBQUMvQjs7QUFFQTtBQUNBO0FBQ0EsU0FBUyxLQUFLLEdBQUc7QUFDakIsRUFBRSxJQUFJLFFBQVEsR0FBRyxHQUFHLENBQUMsZUFBZSxDQUFDLElBQUksSUFBSSxFQUFFLENBQUM7QUFDaEQsRUFBRSxJQUFJLElBQUksR0FBRyxRQUFRLENBQUMsUUFBUSxFQUFFO0FBQ2hDLEVBQUUsR0FBRyxDQUFDLGVBQWUsQ0FBQyxRQUFR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TyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxZQUFZLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLFVBQVUsRUFBRSxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxZQUFZLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxHQUFFLENBQUMsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUMsQ0FBQyxNQUFNLElBQUksRUFBRSxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsU0FBUyxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxNQUFNLFlBQVksU0FBUyxXQUFXLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxDQUFDLEVBQUUsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUMsQ0FBQyxNQUFNLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLEVBQUUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxD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LFlBQVk7QUFDdkMsRUFBRSxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxDQUFDLFVBQVUsSUFBSSxVQUFVLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDdkc7QUFDQSxXQUFXLENBQUMsVUFBVSxHQUFHLE9BQU8sR0FBRyxRQUFRLEtBQUs7QUFDaEQsRUFBRSxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxDQUFDLFVBQVUsSUFBSSxVQUFVLENBQUMsVUFBVSxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQztBQUNsSDs7QUFFQSxXQUFXLENBQUMsWUFBWSxHQUFHLE9BQU8sTUFBTSxLQUFLO0FBQzdDO0FBQ0E7QUFDQSxFQUFFLElBQUksTUFBTSxLQUFLLEdBQUcsRUFBRSxPQUFPLFdBQVcsQ0FBQyxNQUFNLENBQUMsTUFBTSxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNuRixFQUFFLE1BQU0sQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDLEdBQUcsTUFBTSxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsV0FBVyxDQUFDLE1BQU0sRUFBRSxFQUFFLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbkcsRUFBRSxPQUFPLFdBQVcsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLFFBQVEsQ0FBQztBQUM1QyxDQUFDO0FBQ0QsV0FBVyxDQUFDLGVBQWUsR0FBRyxPQUFPLEdBQUcsRUFBRSxTQUFTLEtBQUs7QUFDeEQ7QUFDQSxFQUFFLE1BQU0sUUFBUSxHQUFHLE1BQU0sV0FBVyxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDckUsRUFBRSxJQUFJLENBQUMsUUFBUSxFQUFFLE1BQU0sSUFB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
