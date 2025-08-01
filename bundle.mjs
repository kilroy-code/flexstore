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
var version$1 = "0.0.64";
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

  // TODO?: These take Security-style team/member, while everything else here takes owner/author.
  async sign(data, options) {
    // If this collection restricts usable tags for testing, then do so.
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
  // static async validationFormat(signature, tag = null) {
  //   //console.log({type: typeof(signature), signature, tag});
  //   const verified = await this.verify(signature);
  //   if (!verified.tag) console.error("\n\n\n*** missing tag ***\n\n");
  //   // Obsolete?
  //   // const sub = verified.subjectTag = verified.protectedHeader.sub;
  //   // verified.tag = tag || sub;
  //   return verified;
  // }

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
  _canonicalizeOptions1(tagOrOptions = {}) {
    return (typeof(tagOrOptions) === 'string') ? {tag:tagOrOptions} : tagOrOptions;
  }
  _canonicalizeOptions(objectOrString = {}) {
    const {owner:team = Credentials.owner, author:member = Credentials.author,
	   tag,
	   encryption = Credentials.encryption,
	   time = Date.now(),
	   ...rest} = this._canonicalizeOptions1(objectOrString);
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
    const signature = await this.sign(data, signingOptions);
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
    const signature = await this.sign(data, {subject: tag, ...signingOptions});
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
    verified.tag = tag; // Carry with it the tag by which it was found.
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

    // fixme next
    const merged = await this.mergeSignatures(tag, validation, signature);
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
    if (boolean) this.log('wrong', label, reason); //fixme
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
    this.log('persist2', {tag, storage, operation, signatureString});
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

  hashablePayload(validation) { // Include ant || iat.
    const {ant, iat} = validation.protectedHeader;
    const payload = super.hashablePayload(validation);
    this.log('hashing', {payload, ant, iat});
    return payload + (ant || iat);
  }
  async checkTag(verified) {
    if (verified.protectedHeader.fixme) return '';
    const tag = verified.tag;
    const hash = await this.hash(verified);
    return this.checkSomething('wrong state tag', tag !== hash, 'state tag');
  }
  checkDate() { // always ok
    return null;
  }
  getOwner(protectedHeader) { // Return the tag of what shall be considered the owner.
    return protectedHeader.group || super.getOwner(protectedHeader);
  }
  antecedent(validation) {
    if (validation.text === '') return validation.tag; // Delete compares with what's there
    return validation.protectedHeader.ant;
  }
  // fixme: remove?
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
  async commonStateAndMessages(stateTags) {
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
      // fixme cleanup
      // It would be nice if we cached this in the protected header, but then we'd have to check it anyway.
      //return this.hash(verified);
      //const {kid, act, iat} = verified.protectedHeader;

      //return verified.text; // + (act || kid) + iat;
      return verified.tag;

      // return ant + (act || kid) + iat;
    };
    const isCandidateInEveryHistory = async () => { // True IFF the current candidateTag appear in all the others.
      for (const otherIndex in othersSeen) { // Subtle: the following has side-effects, so calls must be in series.
	if (!await isCandidateInHistory(othersSeen[otherIndex], otherIndex)) return false;
      }
      return true;
    };
    const isCandidateInHistory = async (otherSeen, otherIndex) => { // True IFF the current candidate is in the given State's history.
      // However, if candidate/other are in a linear chain, answer false and reset the loop with other spliced out.
      //console.log('isCandidateHistory', {otherIndex, otherSeen});
      while (!otherSeen.has(candidateTag)) { // Fast check of what we've seen so far.
	const otherTag = otherStateTags[otherIndex]; // As we go, we record the data seen for this other State.
	//console.log({otherTag});
	if (!otherTag) return false;                         // If not at end... go one further level deeper in this state.
	const seenVerifiedStates = otherVerifiedStates[otherIndex];   // Note in our hash => message map, a copy of the verifiedStates seen.
	otherSeen.set(otherTag, seenVerifiedStates.slice());  // And add this state's message for our message accumulator.
	const verifiedState = await this.getVerified({tag: otherTag, member: null, synchronize: false});
	//console.log({seenVerifiedStates, verifiedState});
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

    //console.log('start', {stateTags});
    while (candidateTag) {
      //console.log({candidateTag});
      if (await isCandidateInEveryHistory()) { // We found a match in each of the other States: prepare results.
	// Get the verifiedStates that we accumulated for that particular State within the others.
	//console.log('collecting verifiedStates for', candidateTag);
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
    // Tag is usually specified, but if it isn't generate a unique one now so that we always have a sub to
    // put in the state signature. That's needed so that update events can point back to the Versioned item tag.
    tag ||= await this.hash({text: JSON.stringify(data)}); // FIXME: binary, too.
    const versionTag = await this.versions.store(data, {encryption, ant: root, subject: tag, ...options});
    this.log('store: root', {tag, encryption, options, root, versionTag});
    if (!versionTag) return '';
    const signingOptions = {
      tag: tag || versionTag,
      encryption: '',
      ...options
    };
    return super.store([versionTag], signingOptions);
  }
  async remove(tagOrOptions) {
    const {tag, ...options} = this._canonicalizeOptions1(tagOrOptions);
    await this.forEachState(tag, (_, hash) => { // Subtle: don't return early by returning truthy.
      // This may be overkill to be using high-level remove, instead of put or even persist. We DO want the update event to fire!
      // Subtle: the ant is needed so that we don't silently skip the actual put/event.
      // Subtle: subject is needed so that update events can learn the Versioned stag.
      this.versions.remove({tag: hash, ant: hash, subject: tag, ...options});
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
  getOwner(protectedHeader) { // Return the tag of what shall be considered the owner.
    return protectedHeader.group || super.getOwner(protectedHeader);
  }
  
  async mergeSignatures(tag, validation, signature) {
    const states = validation.json || [];
    const existing = validation.existing?.json || [];
    this.log('mergeSignatures', {tag, existing, states});
    if (states.length === 1 && !existing.length) return signature; // Initial case. Trivial.
    if (existing.length === 1 && !states.length) return validation.existing.signature;

    // Let's see if we can simplify
    const combined = [...states, ...existing];
    let [commonAncestor, ...versionsToReplay] = await this.versions.commonStateAndMessages(combined);
    this.log('mergeSignatures', {tag, existing, states, commonAncestor, versionsToReplay});
    if (combined.length === 2) { // Common cases that can be handled without being a member
      if (commonAncestor === states[0]) return signature;
      if (commonAncestor === existing[0]) return validation.existing.signature;
    }

    const claims = validation.protectedHeader;
    const owner = this.getOwner(claims);
    //let signingAs = owner === claims.kid ? {tags: [owner], group: owner} : {team: owner, group: owner};
    let signingAs = {tags: [owner], group: owner};
    if (!await this.sign('anything', signingAs).catch(() => false)) { // We don't have access.
      //signingAs = {group: owner, tags: [mergeAuthorOverride || Credentials.author]};
      signingAs.tags = [Credentials.author];
      return this.sign(combined, signingAs);
    }
    //console.log(this.label.slice(0, 1), 'mergeSignatures', states.map(tag => this.trim(tag)), existing.map(tag => this.trim(tag)), versionsToReplay.map(v => this.succinct(v)));
    if (!commonAncestor) versionsToReplay = await Promise.all(combined.map(async stateTag => this.versions.getVerified({tag: stateTag, synchronize: false})));
    versionsToReplay.sort((a, b) => a.protectedHeader.iat - b.protectedHeader.iat);
    let state = commonAncestor;
    this.log('mergeSignatures replaying', {tag, state, versionsToReplay, times: versionsToReplay.map(v => v.protectedHeader.iat)});
    for (let verified of versionsToReplay) {
      // TODO: should go through the application as it might do something with the data.
      if (verified.ant === state) {
	state = verified.tag;
      } else {
	const data = verified.text || verified.payload; // fixme: json if possible, but don't double quote!
	const signingOptions = {ant: state, iat: verified.protectedHeader.iat, ...signingAs};
	//console.log({signingOptions});
	const stateSignature = await this.versions.sign(data, signingOptions); // FIXME: preserve encryption of verified
	const state0 = await this.versions.hash({text: data, protectedHeader: signingOptions}); // fixme re json
	state = await this.versions.put(state0, stateSignature, verified.synchronizer);
	//state = await this.versions.store(data, signingOptions); 
      }
    }
    const fixme = await this.sign([state], signingAs);
    //console.log('normal path signed as', signingAs);
    return fixme;
  }

  async getRoot(tag, synchronize = true) { // Promise the tag of the most recent state
    const verifiedVersion = await this.getVerified({tag, members: null, synchronize});
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
var index = { Credentials, Collection, MutableCollection, ImmutableCollection, StateCollection, VersionedCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version,  storageName, storageVersion, StorageLocal: StorageCache, uuid4 };

export { Collection, ImmutableCollection, MutableCollection, PromiseWebRTC, SharedWebRTC, StateCollection, StorageCache as StorageLocal, Synchronizer, VersionedCollection, WebRTC, index as default, name, storageName, storageVersion, uuid4, version };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsibm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vQGtpMXIweS9zdG9yYWdlL2J1bmRsZS5tanMiLCJsaWIvY29sbGVjdGlvbnMubWpzIiwiaW5kZXgubWpzIl0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHV1aWRQYXR0ZXJuID0gL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pO1xuZnVuY3Rpb24gdmFsaWQodXVpZCkge1xuICByZXR1cm4gdXVpZFBhdHRlcm4udGVzdCh1dWlkKTtcbn1cblxuLy8gQmFzZWQgb24gaHR0cHM6Ly9hYmhpc2hla2R1dHRhLm9yZy9ibG9nL3N0YW5kYWxvbmVfdXVpZF9nZW5lcmF0b3JfaW5famF2YXNjcmlwdC5odG1sXG4vLyBJRTExIGFuZCBNb2Rlcm4gQnJvd3NlcnMgT25seVxuZnVuY3Rpb24gdXVpZDQoKSB7XG4gIHZhciB0ZW1wX3VybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwobmV3IEJsb2IoKSk7XG4gIHZhciB1dWlkID0gdGVtcF91cmwudG9TdHJpbmcoKTtcbiAgVVJMLnJldm9rZU9iamVjdFVSTCh0ZW1wX3VybCk7XG4gIHJldHVybiB1dWlkLnNwbGl0KC9bOlxcL10vZykucG9wKCkudG9Mb3dlckNhc2UoKTsgLy8gcmVtb3ZlIHByZWZpeGVzXG59XG51dWlkNC52YWxpZCA9IHZhbGlkO1xuXG5leHBvcnQgZGVmYXVsdCB1dWlkNDtcbmV4cG9ydCB7IHV1aWQ0LCB2YWxpZCB9O1xuIiwiLy8gSW4gYSBicm93c2VyLCB3cnRjIHByb3BlcnRpZXMgc3VjaCBhcyBSVENQZWVyQ29ubmVjdGlvbiBhcmUgaW4gZ2xvYmFsVGhpcy5cbmV4cG9ydCBkZWZhdWx0IGdsb2JhbFRoaXM7XG4iLCJpbXBvcnQgdXVpZDQgZnJvbSAndXVpZDQnO1xuXG4vLyBTZWUgcm9sbHVwLmNvbmZpZy5tanNcbmltcG9ydCB3cnRjIGZyb20gJyN3cnRjJztcbi8vY29uc3Qge2RlZmF1bHQ6d3J0Y30gPSBhd2FpdCAoKHR5cGVvZihwcm9jZXNzKSAhPT0gJ3VuZGVmaW5lZCcpID8gaW1wb3J0KCdAcm9hbWhxL3dydGMnKSA6IHtkZWZhdWx0OiBnbG9iYWxUaGlzfSk7XG5cbmNvbnN0IGljZVNlcnZlcnMgPSBbXG4gIHsgdXJsczogJ3N0dW46c3R1bi5sLmdvb2dsZS5jb206MTkzMDInfSxcbiAgLy8gaHR0cHM6Ly9mcmVlc3R1bi5uZXQvICBDdXJyZW50bHkgNTAgS0JpdC9zLiAoMi41IE1CaXQvcyBmb3JzICQ5L21vbnRoKVxuICB7IHVybHM6ICdzdHVuOmZyZWVzdHVuLm5ldDozNDc4JyB9LFxuICAvL3sgdXJsczogJ3R1cm46ZnJlZXN0dW4ubmV0OjM0NzgnLCB1c2VybmFtZTogJ2ZyZWUnLCBjcmVkZW50aWFsOiAnZnJlZScgfSxcbiAgLy8gUHJlc3VtYWJseSB0cmFmZmljIGxpbWl0ZWQuIENhbiBnZW5lcmF0ZSBuZXcgY3JlZGVudGlhbHMgYXQgaHR0cHM6Ly9zcGVlZC5jbG91ZGZsYXJlLmNvbS90dXJuLWNyZWRzXG4gIC8vIEFsc28gaHR0cHM6Ly9kZXZlbG9wZXJzLmNsb3VkZmxhcmUuY29tL2NhbGxzLyAxIFRCL21vbnRoLCBhbmQgJDAuMDUgL0dCIGFmdGVyIHRoYXQuXG4gIHsgdXJsczogJ3R1cm46dHVybi5zcGVlZC5jbG91ZGZsYXJlLmNvbTo1MDAwMCcsIHVzZXJuYW1lOiAnODI2MjI2MjQ0Y2Q2ZTVlZGIzZjU1NzQ5Yjc5NjIzNWY0MjBmZTVlZTc4ODk1ZTBkZDdkMmJhYTQ1ZTFmN2E4ZjQ5ZTkyMzllNzg2OTFhYjM4YjcyY2UwMTY0NzFmNzc0NmY1Mjc3ZGNlZjg0YWQ3OWZjNjBmODAyMGIxMzJjNzMnLCBjcmVkZW50aWFsOiAnYWJhOWIxNjk1NDZlYjZkY2M3YmZiMWNkZjM0NTQ0Y2Y5NWI1MTYxZDYwMmUzYjVmYTdjODM0MmIyZTk4MDJmYicgfVxuICAvLyBodHRwczovL2Zhc3R0dXJuLm5ldC8gQ3VycmVudGx5IDUwME1CL21vbnRoPyAoMjUgR0IvbW9udGggZm9yICQ5L21vbnRoKVxuICAvLyBodHRwczovL3hpcnN5cy5jb20vcHJpY2luZy8gNTAwIE1CL21vbnRoICg1MCBHQi9tb250aCBmb3IgJDMzL21vbnRoKVxuICAvLyBBbHNvIGh0dHBzOi8vd3d3Lm5wbWpzLmNvbS9wYWNrYWdlL25vZGUtdHVybiBvciBodHRwczovL21lZXRyaXguaW8vYmxvZy93ZWJydGMvY290dXJuL2luc3RhbGxhdGlvbi5odG1sXG5dO1xuXG4vLyBVdGlsaXR5IHdyYXBwZXIgYXJvdW5kIFJUQ1BlZXJDb25uZWN0aW9uLlxuLy8gV2hlbiBzb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gKHN1Y2ggYXMgY3JlYXRlRGF0YUNoYW5uZWwpLCBpdCB3aWxsIGdlbmVyYXRlIGNhbGxzIHRvIHNpZ25hbCgpLCB3aGljaCBuZWVkcyB0byBiZSBkZWZpbmVkIGJ5IHN1YmNsYXNzZXMuXG5leHBvcnQgY2xhc3MgV2ViUlRDIHtcbiAgY29uc3RydWN0b3Ioe2xhYmVsID0gJycsIGNvbmZpZ3VyYXRpb24gPSBudWxsLCB1dWlkID0gdXVpZDQoKSwgZGVidWcgPSBmYWxzZSwgZXJyb3IgPSBjb25zb2xlLmVycm9yLCAuLi5yZXN0fSA9IHt9KSB7XG4gICAgY29uZmlndXJhdGlvbiA/Pz0ge2ljZVNlcnZlcnN9OyAvLyBJZiBjb25maWd1cmF0aW9uIGNhbiBiZSBvbW1pdHRlZCBvciBleHBsaWNpdGx5IGFzIG51bGwsIHVzZSBvdXIgZGVmYXVsdC4gQnV0IGlmIHt9LCBsZWF2ZSBpdCBiZS5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtsYWJlbCwgY29uZmlndXJhdGlvbiwgdXVpZCwgZGVidWcsIGVycm9yLCAuLi5yZXN0fSk7XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBzaWduYWwodHlwZSwgbWVzc2FnZSkgeyAvLyBTdWJjbGFzc2VzIG11c3Qgb3ZlcnJpZGUgb3IgZXh0ZW5kLiBEZWZhdWx0IGp1c3QgbG9ncy5cbiAgICB0aGlzLmxvZygnc2VuZGluZycsIHR5cGUsIHR5cGUubGVuZ3RoLCBKU09OLnN0cmluZ2lmeShtZXNzYWdlKS5sZW5ndGgpO1xuICB9XG5cbiAgcGVlclZlcnNpb24gPSAwO1xuICByZXNldFBlZXIoKSB7IC8vIFNldCB1cCBhIG5ldyBSVENQZWVyQ29ubmVjdGlvbi4gKENhbGxlciBtdXN0IGNsb3NlIG9sZCBpZiBuZWNlc3NhcnkuKVxuICAgIGNvbnN0IG9sZCA9IHRoaXMucGVlcjtcbiAgICBpZiAob2xkKSB7XG4gICAgICBvbGQub25uZWdvdGlhdGlvbm5lZWRlZCA9IG9sZC5vbmljZWNhbmRpZGF0ZSA9IG9sZC5vbmljZWNhbmRpZGF0ZWVycm9yID0gb2xkLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gbnVsbDtcbiAgICAgIC8vIERvbid0IGNsb3NlIHVubGVzcyBpdCdzIGJlZW4gb3BlbmVkLCBiZWNhdXNlIHRoZXJlIGFyZSBsaWtlbHkgaGFuZGxlcnMgdGhhdCB3ZSBkb24ndCB3YW50IHRvIGZpcmUuXG4gICAgICBpZiAob2xkLmNvbm5lY3Rpb25TdGF0ZSAhPT0gJ25ldycpIG9sZC5jbG9zZSgpO1xuICAgIH1cbiAgICBjb25zdCBwZWVyID0gdGhpcy5wZWVyID0gbmV3IHdydGMuUlRDUGVlckNvbm5lY3Rpb24odGhpcy5jb25maWd1cmF0aW9uKTtcbiAgICBwZWVyLnZlcnNpb25JZCA9IHRoaXMucGVlclZlcnNpb24rKztcbiAgICBwZWVyLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBldmVudCA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkKGV2ZW50KTtcbiAgICBwZWVyLm9uaWNlY2FuZGlkYXRlID0gZXZlbnQgPT4gdGhpcy5vbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KTtcbiAgICAvLyBJIGRvbid0IHRoaW5rIGFueW9uZSBhY3R1YWxseSBzaWduYWxzIHRoaXMuIEluc3RlYWQsIHRoZXkgcmVqZWN0IGZyb20gYWRkSWNlQ2FuZGlkYXRlLCB3aGljaCB3ZSBoYW5kbGUgdGhlIHNhbWUuXG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZWVycm9yID0gZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcik7XG4gICAgLy8gSSB0aGluayB0aGlzIGlzIHJlZHVuZG5hbnQgYmVjYXVzZSBubyBpbXBsZW1lbnRhdGlvbiBmaXJlcyB0aGlzIGV2ZW50IGFueSBzaWduaWZpY2FudCB0aW1lIGFoZWFkIG9mIGVtaXR0aW5nIGljZWNhbmRpZGF0ZSB3aXRoIGFuIGVtcHR5IGV2ZW50LmNhbmRpZGF0ZS5cbiAgICBwZWVyLm9uaWNlZ2F0aGVyaW5nc3RhdGVjaGFuZ2UgPSBldmVudCA9PiAocGVlci5pY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJykgJiYgdGhpcy5vbkxvY2FsRW5kSWNlO1xuICAgIHBlZXIub25jb25uZWN0aW9uc3RhdGVjaGFuZ2UgPSBldmVudCA9PiB0aGlzLmNvbm5lY3Rpb25TdGF0ZUNoYW5nZSh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlKTtcbiAgfVxuICBvbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KSB7XG4gICAgLy8gVGhlIHNwZWMgc2F5cyB0aGF0IGEgbnVsbCBjYW5kaWRhdGUgc2hvdWxkIG5vdCBiZSBzZW50LCBidXQgdGhhdCBhbiBlbXB0eSBzdHJpbmcgY2FuZGlkYXRlIHNob3VsZC4gU2FmYXJpICh1c2VkIHRvPykgZ2V0IGVycm9ycyBlaXRoZXIgd2F5LlxuICAgIGlmICghZXZlbnQuY2FuZGlkYXRlIHx8ICFldmVudC5jYW5kaWRhdGUuY2FuZGlkYXRlKSB0aGlzLm9uTG9jYWxFbmRJY2UoKTtcbiAgICBlbHNlIHRoaXMuc2lnbmFsKCdpY2VjYW5kaWRhdGUnLCBldmVudC5jYW5kaWRhdGUpO1xuICB9XG4gIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFRyaWdnZXJlZCBvbiBvdXIgc2lkZSBieSBhbnkvYWxsIG9mIG9uaWNlY2FuZGlkYXRlIHdpdGggbm8gZXZlbnQuY2FuZGlkYXRlLCBpY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJy5cbiAgICAvLyBJLmUuLCBjYW4gaGFwcGVuIG11bHRpcGxlIHRpbWVzLiBTdWJjbGFzc2VzIG1pZ2h0IGRvIHNvbWV0aGluZy5cbiAgfVxuICBjbG9zZSgpIHtcbiAgICBpZiAoKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICduZXcnKSAmJiAodGhpcy5wZWVyLnNpZ25hbGluZ1N0YXRlID09PSAnc3RhYmxlJykpIHJldHVybjtcbiAgICB0aGlzLnJlc2V0UGVlcigpO1xuICB9XG4gIGNvbm5lY3Rpb25TdGF0ZUNoYW5nZShzdGF0ZSkge1xuICAgIHRoaXMubG9nKCdzdGF0ZSBjaGFuZ2U6Jywgc3RhdGUpO1xuICAgIGlmIChbJ2Rpc2Nvbm5lY3RlZCcsICdmYWlsZWQnLCAnY2xvc2VkJ10uaW5jbHVkZXMoc3RhdGUpKSB0aGlzLmNsb3NlKCk7IC8vIE90aGVyIGJlaGF2aW9yIGFyZSByZWFzb25hYmxlLCB0b2xvLlxuICB9XG4gIG5lZ290aWF0aW9ubmVlZGVkKCkgeyAvLyBTb21ldGhpbmcgaGFzIGNoYW5nZWQgbG9jYWxseSAobmV3IHN0cmVhbSwgb3IgbmV0d29yayBjaGFuZ2UpLCBzdWNoIHRoYXQgd2UgaGF2ZSB0byBzdGFydCBuZWdvdGlhdGlvbi5cbiAgICB0aGlzLmxvZygnbmVnb3RpYXRpb25ubmVlZGVkJyk7XG4gICAgdGhpcy5wZWVyLmNyZWF0ZU9mZmVyKClcbiAgICAgIC50aGVuKG9mZmVyID0+IHtcbiAgICAgICAgdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24ob2ZmZXIpOyAvLyBwcm9taXNlIGRvZXMgbm90IHJlc29sdmUgdG8gb2ZmZXJcblx0cmV0dXJuIG9mZmVyO1xuICAgICAgfSlcbiAgICAgIC50aGVuKG9mZmVyID0+IHRoaXMuc2lnbmFsKCdvZmZlcicsIG9mZmVyKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkRXJyb3IoZXJyb3IpKTtcbiAgfVxuICBvZmZlcihvZmZlcikgeyAvLyBIYW5kbGVyIGZvciByZWNlaXZpbmcgYW4gb2ZmZXIgZnJvbSB0aGUgb3RoZXIgdXNlciAod2hvIHN0YXJ0ZWQgdGhlIHNpZ25hbGluZyBwcm9jZXNzKS5cbiAgICAvLyBOb3RlIHRoYXQgZHVyaW5nIHNpZ25hbGluZywgd2Ugd2lsbCByZWNlaXZlIG5lZ290aWF0aW9ubmVlZGVkL2Fuc3dlciwgb3Igb2ZmZXIsIGJ1dCBub3QgYm90aCwgZGVwZW5kaW5nXG4gICAgLy8gb24gd2hldGhlciB3ZSB3ZXJlIHRoZSBvbmUgdGhhdCBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2Vzcy5cbiAgICB0aGlzLnBlZXIuc2V0UmVtb3RlRGVzY3JpcHRpb24ob2ZmZXIpXG4gICAgICAudGhlbihfID0+IHRoaXMucGVlci5jcmVhdGVBbnN3ZXIoKSlcbiAgICAgIC50aGVuKGFuc3dlciA9PiB0aGlzLnBlZXIuc2V0TG9jYWxEZXNjcmlwdGlvbihhbnN3ZXIpKSAvLyBwcm9taXNlIGRvZXMgbm90IHJlc29sdmUgdG8gYW5zd2VyXG4gICAgICAudGhlbihfID0+IHRoaXMuc2lnbmFsKCdhbnN3ZXInLCB0aGlzLnBlZXIubG9jYWxEZXNjcmlwdGlvbikpO1xuICB9XG4gIGFuc3dlcihhbnN3ZXIpIHsgLy8gSGFuZGxlciBmb3IgZmluaXNoaW5nIHRoZSBzaWduYWxpbmcgcHJvY2VzcyB0aGF0IHdlIHN0YXJ0ZWQuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKGFuc3dlcik7XG4gIH1cbiAgaWNlY2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkgeyAvLyBIYW5kbGVyIGZvciBhIG5ldyBjYW5kaWRhdGUgcmVjZWl2ZWQgZnJvbSB0aGUgb3RoZXIgZW5kIHRocm91Z2ggc2lnbmFsaW5nLlxuICAgIHRoaXMucGVlci5hZGRJY2VDYW5kaWRhdGUoaWNlQ2FuZGlkYXRlKS5jYXRjaChlcnJvciA9PiB0aGlzLmljZWNhbmRpZGF0ZUVycm9yKGVycm9yKSk7XG4gIH1cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAodGhpcy5kZWJ1ZykgY29uc29sZS5sb2codGhpcy5sYWJlbCwgdGhpcy5wZWVyLnZlcnNpb25JZCwgLi4ucmVzdCk7XG4gIH1cbiAgbG9nRXJyb3IobGFiZWwsIGV2ZW50T3JFeGNlcHRpb24pIHtcbiAgICBjb25zdCBkYXRhID0gW3RoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnRoaXMuY29uc3RydWN0b3IuZ2F0aGVyRXJyb3JEYXRhKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKV07XG4gICAgdGhpcy5lcnJvcihkYXRhKTtcbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuICBzdGF0aWMgZXJyb3IoZXJyb3IpIHtcbiAgfVxuICBzdGF0aWMgZ2F0aGVyRXJyb3JEYXRhKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIGxhYmVsICsgXCIgZXJyb3I6XCIsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLmNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvckNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXMgfHwgXCJcIiwgLy8gRmlyc3QgaXMgZGVwcmVjYXRlZCwgYnV0IHN0aWxsIHVzZWZ1bC5cbiAgICAgIGV2ZW50T3JFeGNlcHRpb24udXJsIHx8IGV2ZW50T3JFeGNlcHRpb24ubmFtZSB8fCAnJyxcbiAgICAgIGV2ZW50T3JFeGNlcHRpb24ubWVzc2FnZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yVGV4dCB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1c1RleHQgfHwgZXZlbnRPckV4Y2VwdGlvblxuICAgIF07XG4gIH1cbiAgaWNlY2FuZGlkYXRlRXJyb3IoZXZlbnRPckV4Y2VwdGlvbikgeyAvLyBGb3IgZXJyb3JzIG9uIHRoaXMgcGVlciBkdXJpbmcgZ2F0aGVyaW5nLlxuICAgIC8vIENhbiBiZSBvdmVycmlkZGVuIG9yIGV4dGVuZGVkIGJ5IGFwcGxpY2F0aW9ucy5cblxuICAgIC8vIFNUVU4gZXJyb3JzIGFyZSBpbiB0aGUgcmFuZ2UgMzAwLTY5OS4gU2VlIFJGQyA1Mzg5LCBzZWN0aW9uIDE1LjZcbiAgICAvLyBmb3IgYSBsaXN0IG9mIGNvZGVzLiBUVVJOIGFkZHMgYSBmZXcgbW9yZSBlcnJvciBjb2Rlczsgc2VlXG4gICAgLy8gUkZDIDU3NjYsIHNlY3Rpb24gMTUgZm9yIGRldGFpbHMuXG4gICAgLy8gU2VydmVyIGNvdWxkIG5vdCBiZSByZWFjaGVkIGFyZSBpbiB0aGUgcmFuZ2UgNzAwLTc5OS5cbiAgICBjb25zdCBjb2RlID0gZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzO1xuICAgIC8vIENocm9tZSBnaXZlcyA3MDEgZXJyb3JzIGZvciBzb21lIHR1cm4gc2VydmVycyB0aGF0IGl0IGRvZXMgbm90IGdpdmUgZm9yIG90aGVyIHR1cm4gc2VydmVycy5cbiAgICAvLyBUaGlzIGlzbid0IGdvb2QsIGJ1dCBpdCdzIHdheSB0b28gbm9pc3kgdG8gc2xvZyB0aHJvdWdoIHN1Y2ggZXJyb3JzLCBhbmQgSSBkb24ndCBrbm93IGhvdyB0byBmaXggb3VyIHR1cm4gY29uZmlndXJhdGlvbi5cbiAgICBpZiAoY29kZSA9PT0gNzAxKSByZXR1cm47XG4gICAgdGhpcy5sb2dFcnJvcignaWNlJywgZXZlbnRPckV4Y2VwdGlvbik7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFByb21pc2VXZWJSVEMgZXh0ZW5kcyBXZWJSVEMge1xuICAvLyBFeHRlbmRzIFdlYlJUQy5zaWduYWwoKSBzdWNoIHRoYXQ6XG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyBhbnN3ZXJzIGEgcHJvbWlzZSB0aGF0IHdpbGwgcmVzb2x2ZSB3aXRoIGFuIGFycmF5IG9mIHNpZ25hbCBtZXNzYWdlcy5cbiAgLy8gLSBpbnN0YW5jZS5zaWduYWxzID0gWy4uLnNpZ25hbE1lc3NhZ2VzXSB3aWxsIGRpc3BhdGNoIHRob3NlIG1lc3NhZ2VzLlxuICAvL1xuICAvLyBGb3IgZXhhbXBsZSwgc3VwcG9zZSBwZWVyMSBhbmQgcGVlcjIgYXJlIGluc3RhbmNlcyBvZiB0aGlzLlxuICAvLyAwLiBTb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gb24gcGVlcjEgKHN1Y2ggYXMgY2FsbGluZyBwZWVyMS5jcmVhdGVEYXRhQ2hhbm5lbCgpKS4gXG4gIC8vIDEuIHBlZXIxLnNpZ25hbHMgcmVzb2x2ZXMgd2l0aCA8c2lnbmFsMT4sIGEgUE9KTyB0byBiZSBjb252ZXllZCB0byBwZWVyMi5cbiAgLy8gMi4gU2V0IHBlZXIyLnNpZ25hbHMgPSA8c2lnbmFsMT4uXG4gIC8vIDMuIHBlZXIyLnNpZ25hbHMgcmVzb2x2ZXMgd2l0aCA8c2lnbmFsMj4sIGEgUE9KTyB0byBiZSBjb252ZXllZCB0byBwZWVyMS5cbiAgLy8gNC4gU2V0IHBlZXIxLnNpZ25hbHMgPSA8c2lnbmFsMj4uXG4gIC8vIDUuIERhdGEgZmxvd3MsIGJ1dCBlYWNoIHNpZGUgd2hvdWxkIGdyYWIgYSBuZXcgc2lnbmFscyBwcm9taXNlIGFuZCBiZSBwcmVwYXJlZCB0byBhY3QgaWYgaXQgcmVzb2x2ZXMuXG4gIC8vXG4gIGNvbnN0cnVjdG9yKHtpY2VUaW1lb3V0ID0gMmUzLCAuLi5wcm9wZXJ0aWVzfSkge1xuICAgIHN1cGVyKHByb3BlcnRpZXMpO1xuICAgIHRoaXMuaWNlVGltZW91dCA9IGljZVRpbWVvdXQ7XG4gIH1cbiAgZ2V0IHNpZ25hbHMoKSB7IC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZSB0byB0aGUgc2lnbmFsIG1lc3NhZ2luZyB3aGVuIGljZSBjYW5kaWRhdGUgZ2F0aGVyaW5nIGlzIGNvbXBsZXRlLlxuICAgIHJldHVybiB0aGlzLl9zaWduYWxQcm9taXNlIHx8PSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB0aGlzLl9zaWduYWxSZWFkeSA9IHtyZXNvbHZlLCByZWplY3R9KTtcbiAgfVxuICBzZXQgc2lnbmFscyhkYXRhKSB7IC8vIFNldCB3aXRoIHRoZSBzaWduYWxzIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZC5cbiAgICBkYXRhLmZvckVhY2goKFt0eXBlLCBtZXNzYWdlXSkgPT4gdGhpc1t0eXBlXShtZXNzYWdlKSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIEVhY2ggd3J0YyBpbXBsZW1lbnRhdGlvbiBoYXMgaXRzIG93biBpZGVhcyBhcyB0byB3aGF0IGljZSBjYW5kaWRhdGVzIHRvIHRyeSBiZWZvcmUgZW1pdHRpbmcgdGhlbSBpbiBpY2VjYW5kZGlhdGUuXG4gICAgLy8gTW9zdCB3aWxsIHRyeSB0aGluZ3MgdGhhdCBjYW5ub3QgYmUgcmVhY2hlZCwgYW5kIGdpdmUgdXAgd2hlbiB0aGV5IGhpdCB0aGUgT1MgbmV0d29yayB0aW1lb3V0LiBGb3J0eSBzZWNvbmRzIGlzIGEgbG9uZyB0aW1lIHRvIHdhaXQuXG4gICAgLy8gSWYgdGhlIHdydGMgaXMgc3RpbGwgd2FpdGluZyBhZnRlciBvdXIgaWNlVGltZW91dCAoMiBzZWNvbmRzKSwgbGV0cyBqdXN0IGdvIHdpdGggd2hhdCB3ZSBoYXZlLlxuICAgIHRoaXMudGltZXIgfHw9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5vbkxvY2FsRW5kSWNlKCksIHRoaXMuaWNlVGltZW91dCk7XG4gICAgc3VwZXIub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gIH1cbiAgY2xlYXJJY2VUaW1lcigpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7XG4gICAgdGhpcy50aW1lciA9IG51bGw7XG4gIH1cbiAgYXN5bmMgb25Mb2NhbEVuZEljZSgpIHsgLy8gUmVzb2x2ZSB0aGUgcHJvbWlzZSB3aXRoIHdoYXQgd2UndmUgYmVlbiBnYXRoZXJpbmcuXG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgaWYgKCF0aGlzLl9zaWduYWxQcm9taXNlKSB7XG4gICAgICAvL3RoaXMubG9nRXJyb3IoJ2ljZScsIFwiRW5kIG9mIElDRSB3aXRob3V0IGFueXRoaW5nIHdhaXRpbmcgb24gc2lnbmFscy5cIik7IC8vIE5vdCBoZWxwZnVsIHdoZW4gdGhlcmUgYXJlIHRocmVlIHdheXMgdG8gcmVjZWl2ZSB0aGlzIG1lc3NhZ2UuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3NpZ25hbFJlYWR5LnJlc29sdmUodGhpcy5zZW5kaW5nKTtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgfVxuICBzZW5kaW5nID0gW107XG4gIHNpZ25hbCh0eXBlLCBtZXNzYWdlKSB7XG4gICAgc3VwZXIuc2lnbmFsKHR5cGUsIG1lc3NhZ2UpO1xuICAgIHRoaXMuc2VuZGluZy5wdXNoKFt0eXBlLCBtZXNzYWdlXSk7XG4gIH1cbiAgLy8gV2UgbmVlZCB0byBrbm93IGlmIHRoZXJlIGFyZSBvcGVuIGRhdGEgY2hhbm5lbHMuIFRoZXJlIGlzIGEgcHJvcG9zYWwgYW5kIGV2ZW4gYW4gYWNjZXB0ZWQgUFIgZm9yIFJUQ1BlZXJDb25uZWN0aW9uLmdldERhdGFDaGFubmVscygpLFxuICAvLyBodHRwczovL2dpdGh1Yi5jb20vdzNjL3dlYnJ0Yy1leHRlbnNpb25zL2lzc3Vlcy8xMTBcbiAgLy8gYnV0IGl0IGhhc24ndCBiZWVuIGRlcGxveWVkIGV2ZXJ5d2hlcmUgeWV0LiBTbyB3ZSdsbCBuZWVkIHRvIGtlZXAgb3VyIG93biBjb3VudC5cbiAgLy8gQWxhcywgYSBjb3VudCBpc24ndCBlbm91Z2gsIGJlY2F1c2Ugd2UgY2FuIG9wZW4gc3R1ZmYsIGFuZCB0aGUgb3RoZXIgc2lkZSBjYW4gb3BlbiBzdHVmZiwgYnV0IGlmIGl0IGhhcHBlbnMgdG8gYmVcbiAgLy8gdGhlIHNhbWUgXCJuZWdvdGlhdGVkXCIgaWQsIGl0IGlzbid0IHJlYWxseSBhIGRpZmZlcmVudCBjaGFubmVsLiAoaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL1JUQ1BlZXJDb25uZWN0aW9uL2RhdGFjaGFubmVsX2V2ZW50XG4gIGRhdGFDaGFubmVscyA9IG5ldyBNYXAoKTtcbiAgcmVwb3J0Q2hhbm5lbHMoKSB7IC8vIFJldHVybiBhIHJlcG9ydCBzdHJpbmcgdXNlZnVsIGZvciBkZWJ1Z2dpbmcuXG4gICAgY29uc3QgZW50cmllcyA9IEFycmF5LmZyb20odGhpcy5kYXRhQ2hhbm5lbHMuZW50cmllcygpKTtcbiAgICBjb25zdCBrdiA9IGVudHJpZXMubWFwKChbaywgdl0pID0+IGAke2t9OiR7di5pZH1gKTtcbiAgICByZXR1cm4gYCR7dGhpcy5kYXRhQ2hhbm5lbHMuc2l6ZX0vJHtrdi5qb2luKCcsICcpfWA7XG4gIH1cbiAgbm90ZUNoYW5uZWwoY2hhbm5lbCwgc291cmNlLCB3YWl0aW5nKSB7IC8vIEJvb2trZWVwIG9wZW4gY2hhbm5lbCBhbmQgcmV0dXJuIGl0LlxuICAgIC8vIEVtcGVyaWNhbGx5LCB3aXRoIG11bHRpcGxleCBmYWxzZTogLy8gICAxOCBvY2N1cnJlbmNlcywgd2l0aCBpZD1udWxsfDB8MSBhcyBmb3IgZXZlbnRjaGFubmVsIG9yIGNyZWF0ZURhdGFDaGFubmVsXG4gICAgLy8gICBBcHBhcmVudGx5LCB3aXRob3V0IG5lZ290aWF0aW9uLCBpZCBpcyBpbml0aWFsbHkgbnVsbCAocmVnYXJkbGVzcyBvZiBvcHRpb25zLmlkKSwgYW5kIHRoZW4gYXNzaWduZWQgdG8gYSBmcmVlIHZhbHVlIGR1cmluZyBvcGVuaW5nXG4gICAgY29uc3Qga2V5ID0gY2hhbm5lbC5sYWJlbDsgLy9maXhtZSBjaGFubmVsLmlkID09PSBudWxsID8gMSA6IGNoYW5uZWwuaWQ7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmRhdGFDaGFubmVscy5nZXQoa2V5KTtcbiAgICB0aGlzLmxvZygnZ290IGRhdGEtY2hhbm5lbCcsIHNvdXJjZSwga2V5LCBjaGFubmVsLnJlYWR5U3RhdGUsICdleGlzdGluZzonLCBleGlzdGluZywgJ3dhaXRpbmc6Jywgd2FpdGluZyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbHMuc2V0KGtleSwgY2hhbm5lbCk7XG4gICAgY2hhbm5lbC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsIGV2ZW50ID0+IHsgLy8gQ2xvc2Ugd2hvbGUgY29ubmVjdGlvbiB3aGVuIG5vIG1vcmUgZGF0YSBjaGFubmVscyBvciBzdHJlYW1zLlxuICAgICAgdGhpcy5kYXRhQ2hhbm5lbHMuZGVsZXRlKGtleSk7XG4gICAgICAvLyBJZiB0aGVyZSdzIG5vdGhpbmcgb3BlbiwgY2xvc2UgdGhlIGNvbm5lY3Rpb24uXG4gICAgICBpZiAodGhpcy5kYXRhQ2hhbm5lbHMuc2l6ZSkgcmV0dXJuO1xuICAgICAgaWYgKHRoaXMucGVlci5nZXRTZW5kZXJzKCkubGVuZ3RoKSByZXR1cm47XG4gICAgICB0aGlzLmNsb3NlKCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIGNoYW5uZWw7XG4gIH1cbiAgY3JlYXRlRGF0YUNoYW5uZWwobGFiZWwgPSBcImRhdGFcIiwgY2hhbm5lbE9wdGlvbnMgPSB7fSkgeyAvLyBQcm9taXNlIHJlc29sdmVzIHdoZW4gdGhlIGNoYW5uZWwgaXMgb3BlbiAod2hpY2ggd2lsbCBiZSBhZnRlciBhbnkgbmVlZGVkIG5lZ290aWF0aW9uKS5cbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICB0aGlzLmxvZygnY3JlYXRlIGRhdGEtY2hhbm5lbCcsIGxhYmVsLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgICBsZXQgY2hhbm5lbCA9IHRoaXMucGVlci5jcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY2hhbm5lbE9wdGlvbnMpO1xuICAgICAgdGhpcy5ub3RlQ2hhbm5lbChjaGFubmVsLCAnZXhwbGljaXQnKTsgLy8gTm90ZWQgZXZlbiBiZWZvcmUgb3BlbmVkLlxuICAgICAgLy8gVGhlIGNoYW5uZWwgbWF5IGhhdmUgYWxyZWFkeSBiZWVuIG9wZW5lZCBvbiB0aGUgb3RoZXIgc2lkZS4gSW4gdGhpcyBjYXNlLCBhbGwgYnJvd3NlcnMgZmlyZSB0aGUgb3BlbiBldmVudCBhbnl3YXksXG4gICAgICAvLyBidXQgd3J0YyAoaS5lLiwgb24gbm9kZUpTKSBkb2VzIG5vdC4gU28gd2UgaGF2ZSB0byBleHBsaWNpdGx5IGNoZWNrLlxuICAgICAgc3dpdGNoIChjaGFubmVsLnJlYWR5U3RhdGUpIHtcbiAgICAgIGNhc2UgJ29wZW4nOlxuXHRzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoY2hhbm5lbCksIDEwKTtcblx0YnJlYWs7XG4gICAgICBjYXNlICdjb25uZWN0aW5nJzpcblx0Y2hhbm5lbC5vbm9wZW4gPSBfID0+IHJlc29sdmUoY2hhbm5lbCk7XG5cdGJyZWFrO1xuICAgICAgZGVmYXVsdDpcblx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHJlYWR5U3RhdGUgJHtjaGFubmVsLnJlYWR5U3RhdGV9IGZvciBkYXRhIGNoYW5uZWwgJHtsYWJlbH0uYCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgd2FpdGluZ0NoYW5uZWxzID0ge307XG4gIGdldERhdGFDaGFubmVsUHJvbWlzZShsYWJlbCA9IFwiZGF0YVwiKSB7IC8vIFJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdwcm9taXNlIGRhdGEtY2hhbm5lbCcsIGxhYmVsKTtcbiAgICAgIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXSA9IHJlc29sdmU7XG4gICAgfSk7XG4gIH1cbiAgcmVzZXRQZWVyKCkgeyAvLyBSZXNldCBhICdjb25uZWN0ZWQnIHByb3BlcnR5IHRoYXQgcHJvbWlzZWQgdG8gcmVzb2x2ZSB3aGVuIG9wZW5lZCwgYW5kIHRyYWNrIGluY29taW5nIGRhdGFjaGFubmVscy5cbiAgICBzdXBlci5yZXNldFBlZXIoKTtcbiAgICB0aGlzLmNvbm5lY3RlZCA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyAvLyB0aGlzLmNvbm5lY3RlZCBpcyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGFyZS5cbiAgICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdjb25uZWN0aW9uc3RhdGVjaGFuZ2UnLCBldmVudCA9PiB7XG5cdGlmICh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnY29ubmVjdGVkJykge1xuXHQgIHJlc29sdmUodHJ1ZSk7XG5cdH1cbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdkYXRhY2hhbm5lbCcsIGV2ZW50ID0+IHsgLy8gUmVzb2x2ZSBwcm9taXNlIG1hZGUgd2l0aCBnZXREYXRhQ2hhbm5lbFByb21pc2UoKS5cbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBldmVudC5jaGFubmVsO1xuICAgICAgY29uc3QgbGFiZWwgPSBjaGFubmVsLmxhYmVsO1xuICAgICAgY29uc3Qgd2FpdGluZyA9IHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHRoaXMubm90ZUNoYW5uZWwoY2hhbm5lbCwgJ2RhdGFjaGFubmVsIGV2ZW50Jywgd2FpdGluZyk7IC8vIFJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB3ZSBhcmUgd2FpdGluZy5cbiAgICAgIGlmICghd2FpdGluZykgcmV0dXJuOyAvLyBNaWdodCBub3QgYmUgZXhwbGljaXRseSB3YWl0aW5nLiBFLmcuLCByb3V0ZXJzLlxuICAgICAgZGVsZXRlIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHdhaXRpbmcoY2hhbm5lbCk7XG4gICAgfSk7XG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICdmYWlsZWQnKSB0aGlzLl9zaWduYWxQcm9taXNlPy5yZWplY3Q/LigpO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgdGhpcy5fc2lnbmFsUHJvbWlzZSA9IHRoaXMuX3NpZ25hbFJlYWR5ID0gbnVsbDtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgICAvLyBJZiB0aGUgd2VicnRjIGltcGxlbWVudGF0aW9uIGNsb3NlcyB0aGUgZGF0YSBjaGFubmVscyBiZWZvcmUgdGhlIHBlZXIgaXRzZWxmLCB0aGVuIHRoaXMuZGF0YUNoYW5uZWxzIHdpbGwgYmUgZW1wdHkuXG4gICAgLy8gQnV0IGlmIG5vdCAoZS5nLiwgc3RhdHVzICdmYWlsZWQnIG9yICdkaXNjb25uZWN0ZWQnIG9uIFNhZmFyaSksIHRoZW4gbGV0IHVzIGV4cGxpY2l0bHkgY2xvc2UgdGhlbSBzbyB0aGF0IFN5bmNocm9uaXplcnMga25vdyB0byBjbGVhbiB1cC5cbiAgICBmb3IgKGNvbnN0IGNoYW5uZWwgb2YgdGhpcy5kYXRhQ2hhbm5lbHMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgIT09ICdvcGVuJykgY29udGludWU7IC8vIEtlZXAgZGVidWdnaW5nIHNhbml0eS5cbiAgICAgIC8vIEl0IGFwcGVhcnMgdGhhdCBpbiBTYWZhcmkgKDE4LjUpIGZvciBhIGNhbGwgdG8gY2hhbm5lbC5jbG9zZSgpIHdpdGggdGhlIGNvbm5lY3Rpb24gYWxyZWFkeSBpbnRlcm5hbGwgY2xvc2VkLCBTYWZhcmlcbiAgICAgIC8vIHdpbGwgc2V0IGNoYW5uZWwucmVhZHlTdGF0ZSB0byAnY2xvc2luZycsIGJ1dCBOT1QgZmlyZSB0aGUgY2xvc2VkIG9yIGNsb3NpbmcgZXZlbnQuIFNvIHdlIGhhdmUgdG8gZGlzcGF0Y2ggaXQgb3Vyc2VsdmVzLlxuICAgICAgLy9jaGFubmVsLmNsb3NlKCk7XG4gICAgICBjaGFubmVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjbG9zZScpKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gTmVnb3RpYXRlZCBjaGFubmVscyB1c2Ugc3BlY2lmaWMgaW50ZWdlcnMgb24gYm90aCBzaWRlcywgc3RhcnRpbmcgd2l0aCB0aGlzIG51bWJlci5cbi8vIFdlIGRvIG5vdCBzdGFydCBhdCB6ZXJvIGJlY2F1c2UgdGhlIG5vbi1uZWdvdGlhdGVkIGNoYW5uZWxzIChhcyB1c2VkIG9uIHNlcnZlciByZWxheXMpIGdlbmVyYXRlIHRoZWlyXG4vLyBvd24gaWRzIHN0YXJ0aW5nIHdpdGggMCwgYW5kIHdlIGRvbid0IHdhbnQgdG8gY29uZmxpY3QuXG4vLyBUaGUgc3BlYyBzYXlzIHRoZXNlIGNhbiBnbyB0byA2NSw1MzQsIGJ1dCBJIGZpbmQgdGhhdCBzdGFydGluZyBncmVhdGVyIHRoYW4gdGhlIHZhbHVlIGhlcmUgZ2l2ZXMgZXJyb3JzLlxuLy8gQXMgb2YgNy82LzI1LCBjdXJyZW50IGV2ZXJncmVlbiBicm93c2VycyB3b3JrIHdpdGggMTAwMCBiYXNlLCBidXQgRmlyZWZveCBmYWlscyBpbiBvdXIgY2FzZSAoMTAgbmVnb3RhdGlhdGVkIGNoYW5uZWxzKVxuLy8gaWYgYW55IGlkcyBhcmUgMjU2IG9yIGhpZ2hlci5cbmNvbnN0IEJBU0VfQ0hBTk5FTF9JRCA9IDEyNTtcbmV4cG9ydCBjbGFzcyBTaGFyZWRXZWJSVEMgZXh0ZW5kcyBQcm9taXNlV2ViUlRDIHtcbiAgc3RhdGljIGNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICBzdGF0aWMgZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIG11bHRpcGxleCA9IHRydWUsIC4uLnJlc3R9KSB7XG4gICAgbGV0IGNvbm5lY3Rpb24gPSB0aGlzLmNvbm5lY3Rpb25zLmdldChzZXJ2aWNlTGFiZWwpO1xuICAgIC8vIEl0IGlzIHBvc3NpYmxlIHRoYXQgd2Ugd2VyZSBiYWNrZ3JvdW5kZWQgYmVmb3JlIHdlIGhhZCBhIGNoYW5jZSB0byBhY3Qgb24gYSBjbG9zaW5nIGNvbm5lY3Rpb24gYW5kIHJlbW92ZSBpdC5cbiAgICBpZiAoY29ubmVjdGlvbikge1xuICAgICAgY29uc3Qge2Nvbm5lY3Rpb25TdGF0ZSwgc2lnbmFsaW5nU3RhdGV9ID0gY29ubmVjdGlvbi5wZWVyO1xuICAgICAgaWYgKChjb25uZWN0aW9uU3RhdGUgPT09ICdjbG9zZWQnKSB8fCAoc2lnbmFsaW5nU3RhdGUgPT09ICdjbG9zZWQnKSkgY29ubmVjdGlvbiA9IG51bGw7XG4gICAgfVxuICAgIGlmICghY29ubmVjdGlvbikge1xuICAgICAgY29ubmVjdGlvbiA9IG5ldyB0aGlzKHtsYWJlbDogc2VydmljZUxhYmVsLCB1dWlkOiB1dWlkNCgpLCBtdWx0aXBsZXgsIC4uLnJlc3R9KTtcbiAgICAgIGlmIChtdWx0aXBsZXgpIHRoaXMuY29ubmVjdGlvbnMuc2V0KHNlcnZpY2VMYWJlbCwgY29ubmVjdGlvbik7XG4gICAgfVxuICAgIHJldHVybiBjb25uZWN0aW9uO1xuICB9XG4gIGNoYW5uZWxJZCA9IEJBU0VfQ0hBTk5FTF9JRDtcbiAgZ2V0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nKCkge1xuICAgIHJldHVybiB0aGlzLmNoYW5uZWxJZCA+IEJBU0VfQ0hBTk5FTF9JRDtcbiAgfVxuICBjbG9zZShyZW1vdmVDb25uZWN0aW9uID0gdHJ1ZSkge1xuICAgIHRoaXMuY2hhbm5lbElkID0gQkFTRV9DSEFOTkVMX0lEO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgaWYgKHJlbW92ZUNvbm5lY3Rpb24pIHRoaXMuY29uc3RydWN0b3IuY29ubmVjdGlvbnMuZGVsZXRlKHRoaXMuc2VydmljZUxhYmVsKTtcbiAgfVxuICBhc3luYyBlbnN1cmVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgY2hhbm5lbE9wdGlvbnMgPSB7fSwgc2lnbmFscyA9IG51bGwpIHsgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgYW4gb3BlbiBkYXRhIGNoYW5uZWwgb24gdGhpcyBjb25uZWN0aW9uLlxuICAgIGNvbnN0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nID0gdGhpcy5oYXNTdGFydGVkQ29ubmVjdGluZzsgLy8gTXVzdCBhc2sgYmVmb3JlIGluY3JlbWVudGluZyBpZC5cbiAgICBjb25zdCBpZCA9IHRoaXMuY2hhbm5lbElkKys7IC8vIFRoaXMgYW5kIGV2ZXJ5dGhpbmcgbGVhZGluZyB1cCB0byBpdCBtdXN0IGJlIHN5bmNocm9ub3VzLCBzbyB0aGF0IGlkIGFzc2lnbm1lbnQgaXMgZGV0ZXJtaW5pc3RpYy5cbiAgICBjb25zdCBuZWdvdGlhdGVkID0gKHRoaXMubXVsdGlwbGV4ID09PSAnbmVnb3RpYXRlZCcpICYmIGhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGNvbnN0IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgPSAhaGFzU3RhcnRlZENvbm5lY3RpbmcgLyohbmVnb3RpYXRlZCovICYmICEhc2lnbmFsczsgLy8gT25seSB0aGUgMHRoIHdpdGggc2lnbmFscyB3YWl0cyBwYXNzaXZlbHkuXG4gICAgLy8gc2lnbmFscyBpcyBlaXRoZXIgbnVsbGlzaCBvciBhbiBhcnJheSBvZiBzaWduYWxzLCBidXQgdGhhdCBhcnJheSBjYW4gYmUgRU1QVFksXG4gICAgLy8gaW4gd2hpY2ggY2FzZSB0aGUgcmVhbCBzaWduYWxzIHdpbGwgaGF2ZSB0byBiZSBhc3NpZ25lZCBsYXRlci4gVGhpcyBhbGxvd3MgdGhlIGRhdGEgY2hhbm5lbCB0byBiZSBzdGFydGVkIChhbmQgdG8gY29uc3VtZVxuICAgIC8vIGEgY2hhbm5lbElkKSBzeW5jaHJvbm91c2x5LCBidXQgdGhlIHByb21pc2Ugd29uJ3QgcmVzb2x2ZSB1bnRpbCB0aGUgcmVhbCBzaWduYWxzIGFyZSBzdXBwbGllZCBsYXRlci4gVGhpcyBpc1xuICAgIC8vIHVzZWZ1bCBpbiBtdWx0aXBsZXhpbmcgYW4gb3JkZXJlZCBzZXJpZXMgb2YgZGF0YSBjaGFubmVscyBvbiBhbiBBTlNXRVIgY29ubmVjdGlvbiwgd2hlcmUgdGhlIGRhdGEgY2hhbm5lbHMgbXVzdFxuICAgIC8vIG1hdGNoIHVwIHdpdGggYW4gT0ZGRVIgY29ubmVjdGlvbiBvbiBhIHBlZXIuIFRoaXMgd29ya3MgYmVjYXVzZSBvZiB0aGUgd29uZGVyZnVsIGhhcHBlbnN0YW5jZSB0aGF0IGFuc3dlciBjb25uZWN0aW9uc1xuICAgIC8vIGdldERhdGFDaGFubmVsUHJvbWlzZSAod2hpY2ggZG9lc24ndCByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIHlldCBiZSBvcGVuKSByYXRoZXIgdGhhbiBjcmVhdGVEYXRhQ2hhbm5lbCAod2hpY2ggd291bGRcbiAgICAvLyByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIGFscmVhZHkgYmUgb3BlbikuXG4gICAgY29uc3QgdXNlU2lnbmFscyA9ICFoYXNTdGFydGVkQ29ubmVjdGluZyAmJiBzaWduYWxzPy5sZW5ndGg7XG4gICAgY29uc3Qgb3B0aW9ucyA9IG5lZ290aWF0ZWQgPyB7aWQsIG5lZ290aWF0ZWQsIC4uLmNoYW5uZWxPcHRpb25zfSA6IGNoYW5uZWxPcHRpb25zO1xuICAgIGlmIChoYXNTdGFydGVkQ29ubmVjdGluZykge1xuICAgICAgYXdhaXQgdGhpcy5jb25uZWN0ZWQ7IC8vIEJlZm9yZSBjcmVhdGluZyBwcm9taXNlLlxuICAgICAgLy8gSSBzb21ldGltZXMgZW5jb3VudGVyIGEgYnVnIGluIFNhZmFyaSBpbiB3aGljaCBPTkUgb2YgdGhlIGNoYW5uZWxzIGNyZWF0ZWQgc29vbiBhZnRlciBjb25uZWN0aW9uIGdldHMgc3R1Y2sgaW5cbiAgICAgIC8vIHRoZSBjb25uZWN0aW5nIHJlYWR5U3RhdGUgYW5kIG5ldmVyIG9wZW5zLiBFeHBlcmltZW50YWxseSwgdGhpcyBzZWVtcyB0byBiZSByb2J1c3QuXG4gICAgICAvL1xuICAgICAgLy8gTm90ZSB0byBzZWxmOiBJZiBpdCBzaG91bGQgdHVybiBvdXQgdGhhdCB3ZSBzdGlsbCBoYXZlIHByb2JsZW1zLCB0cnkgc2VyaWFsaXppbmcgdGhlIGNhbGxzIHRvIHBlZXIuY3JlYXRlRGF0YUNoYW5uZWxcbiAgICAgIC8vIHNvIHRoYXQgdGhlcmUgaXNuJ3QgbW9yZSB0aGFuIG9uZSBjaGFubmVsIG9wZW5pbmcgYXQgYSB0aW1lLlxuICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMCkpO1xuICAgIH0gZWxzZSBpZiAodXNlU2lnbmFscykge1xuICAgICAgdGhpcy5zaWduYWxzID0gc2lnbmFscztcbiAgICB9XG4gICAgY29uc3QgcHJvbWlzZSA9IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgP1xuXHQgIHRoaXMuZ2V0RGF0YUNoYW5uZWxQcm9taXNlKGNoYW5uZWxOYW1lKSA6XG5cdCAgdGhpcy5jcmVhdGVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIGF3YWl0IHByb21pc2U7XG4gIH1cbn1cbiIsIi8vIG5hbWUvdmVyc2lvbiBvZiBcImRhdGFiYXNlXCJcbmV4cG9ydCBjb25zdCBzdG9yYWdlTmFtZSA9ICdmbGV4c3RvcmUnO1xuZXhwb3J0IGNvbnN0IHN0b3JhZ2VWZXJzaW9uID0gMTE7XG5cbmltcG9ydCAqIGFzIHBrZyBmcm9tIFwiLi4vcGFja2FnZS5qc29uXCIgd2l0aCB7IHR5cGU6ICdqc29uJyB9O1xuZXhwb3J0IGNvbnN0IHtuYW1lLCB2ZXJzaW9ufSA9IHBrZy5kZWZhdWx0O1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHsgdGFnUGF0aCB9IGZyb20gJy4vdGFnUGF0aC5tanMnO1xuaW1wb3J0IHsgU2hhcmVkV2ViUlRDIH0gZnJvbSAnLi93ZWJydGMubWpzJztcbmltcG9ydCB7IHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5cbi8qXG4gIFJlc3BvbnNpYmxlIGZvciBrZWVwaW5nIGEgY29sbGVjdGlvbiBzeW5jaHJvbml6ZWQgd2l0aCBhbm90aGVyIHBlZXIuXG4gIChQZWVycyBtYXkgYmUgYSBjbGllbnQgb3IgYSBzZXJ2ZXIvcmVsYXkuIEluaXRpYWxseSB0aGlzIGlzIHRoZSBzYW1lIGNvZGUgZWl0aGVyIHdheSxcbiAgYnV0IGxhdGVyIG9uLCBvcHRpbWl6YXRpb25zIGNhbiBiZSBtYWRlIGZvciBzY2FsZS4pXG5cbiAgQXMgbG9uZyBhcyB0d28gcGVlcnMgYXJlIGNvbm5lY3RlZCB3aXRoIGEgU3luY2hyb25pemVyIG9uIGVhY2ggc2lkZSwgd3JpdGluZyBoYXBwZW5zXG4gIGluIGJvdGggcGVlcnMgaW4gcmVhbCB0aW1lLCBhbmQgcmVhZGluZyBwcm9kdWNlcyB0aGUgY29ycmVjdCBzeW5jaHJvbml6ZWQgcmVzdWx0IGZyb20gZWl0aGVyLlxuICBVbmRlciB0aGUgaG9vZCwgdGhlIHN5bmNocm9uaXplciBrZWVwcyB0cmFjayBvZiB3aGF0IGl0IGtub3dzIGFib3V0IHRoZSBvdGhlciBwZWVyIC0tXG4gIGEgcGFydGljdWxhciB0YWcgY2FuIGJlIHVua25vd24sIHVuc3luY2hyb25pemVkLCBvciBzeW5jaHJvbml6ZWQsIGFuZCByZWFkaW5nIHdpbGxcbiAgY29tbXVuaWNhdGUgYXMgbmVlZGVkIHRvIGdldCB0aGUgZGF0YSBzeW5jaHJvbml6ZWQgb24tZGVtYW5kLiBNZWFud2hpbGUsIHN5bmNocm9uaXphdGlvblxuICBjb250aW51ZXMgaW4gdGhlIGJhY2tncm91bmQgdW50aWwgdGhlIGNvbGxlY3Rpb24gaXMgZnVsbHkgcmVwbGljYXRlZC5cblxuICBBIGNvbGxlY3Rpb24gbWFpbnRhaW5zIGEgc2VwYXJhdGUgU3luY2hyb25pemVyIGZvciBlYWNoIG9mIHplcm8gb3IgbW9yZSBwZWVycywgYW5kIGNhbiBkeW5hbWljYWxseVxuICBhZGQgYW5kIHJlbW92ZSBtb3JlLlxuXG4gIE5hbWluZyBjb252ZW50aW9uczpcblxuICBtdW1ibGVOYW1lOiBhIHNlbWFudGljIG5hbWUgdXNlZCBleHRlcm5hbGx5IGFzIGEga2V5LiBFeGFtcGxlOiBzZXJ2aWNlTmFtZSwgY2hhbm5lbE5hbWUsIGV0Yy5cbiAgICBXaGVuIHRoaW5ncyBuZWVkIHRvIG1hdGNoIHVwIGFjcm9zcyBzeXN0ZW1zLCBpdCBpcyBieSBuYW1lLlxuICAgIElmIG9ubHkgb25lIG9mIG5hbWUvbGFiZWwgaXMgc3BlY2lmaWVkLCB0aGlzIGlzIHVzdWFsbHkgdGhlIHRoZSBvbmUuXG5cbiAgbXVtYmxlTGFiZWw6IGEgbGFiZWwgZm9yIGlkZW50aWZpY2F0aW9uIGFuZCBpbnRlcm5hbGx5IChlLmcuLCBkYXRhYmFzZSBuYW1lKS5cbiAgICBXaGVuIHR3byBpbnN0YW5jZXMgb2Ygc29tZXRoaW5nIGFyZSBcInRoZSBzYW1lXCIgYnV0IGFyZSBpbiB0aGUgc2FtZSBKYXZhc2NyaXB0IGltYWdlIGZvciB0ZXN0aW5nLCB0aGV5IGFyZSBkaXN0aW5ndWlzaGVkIGJ5IGxhYmVsLlxuICAgIFR5cGljYWxseSBkZWZhdWx0cyB0byBtdW1ibGVOYW1lLlxuXG4gIE5vdGUsIHRob3VnaCwgdGhhdCBzb21lIGV4dGVybmFsIG1hY2hpbmVyeSAoc3VjaCBhcyBhIFdlYlJUQyBEYXRhQ2hhbm5lbCkgaGFzIGEgXCJsYWJlbFwiIHByb3BlcnR5IHRoYXQgd2UgcG9wdWxhdGUgd2l0aCBhIFwibmFtZVwiIChjaGFubmVsTmFtZSkuXG4gKi9cbmV4cG9ydCBjbGFzcyBTeW5jaHJvbml6ZXIge1xuICBzdGF0aWMgdmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uO1xuICBjb25zdHJ1Y3Rvcih7c2VydmljZU5hbWUgPSAnZGlyZWN0JywgY29sbGVjdGlvbiwgZXJyb3IgPSBjb2xsZWN0aW9uPy5jb25zdHJ1Y3Rvci5lcnJvciB8fCBjb25zb2xlLmVycm9yLFxuXHQgICAgICAgc2VydmljZUxhYmVsID0gY29sbGVjdGlvbj8uc2VydmljZUxhYmVsIHx8IHNlcnZpY2VOYW1lLCAvLyBVc2VkIHRvIGlkZW50aWZ5IGFueSBleGlzdGluZyBjb25uZWN0aW9uLiBDYW4gYmUgZGlmZmVyZW50IGZyb20gc2VydmljZU5hbWUgZHVyaW5nIHRlc3RpbmcuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgdXVpZCA9IGNvbGxlY3Rpb24/LnV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sIGNvbm5lY3Rpb24sIC8vIENvbXBsZXggZGVmYXVsdCBiZWhhdmlvciBmb3IgdGhlc2UuIFNlZSBjb2RlLlxuXHQgICAgICAgbXVsdGlwbGV4ID0gY29sbGVjdGlvbj8ubXVsdGlwbGV4LCAvLyBJZiBzcGVjaWZlZCwgb3RoZXJ3aXNlIHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LiBTZWUgYmVsb3cuXG5cdCAgICAgICBkZWJ1ZyA9IGNvbGxlY3Rpb24/LmRlYnVnLCBtYXhWZXJzaW9uID0gU3luY2hyb25pemVyLnZlcnNpb24sIG1pblZlcnNpb24gPSBtYXhWZXJzaW9ufSkge1xuICAgIC8vIHNlcnZpY2VOYW1lIGlzIGEgc3RyaW5nIG9yIG9iamVjdCB0aGF0IGlkZW50aWZpZXMgd2hlcmUgdGhlIHN5bmNocm9uaXplciBzaG91bGQgY29ubmVjdC4gRS5nLiwgaXQgbWF5IGJlIGEgVVJMIGNhcnJ5aW5nXG4gICAgLy8gICBXZWJSVEMgc2lnbmFsaW5nLiBJdCBzaG91bGQgYmUgYXBwLXVuaXF1ZSBmb3IgdGhpcyBwYXJ0aWN1bGFyIHNlcnZpY2UgKGUuZy4sIHdoaWNoIG1pZ2h0IG11bHRpcGxleCBkYXRhIGZvciBtdWx0aXBsZSBjb2xsZWN0aW9uIGluc3RhbmNlcykuXG4gICAgLy8gdXVpZCBoZWxwIHVuaXF1ZWx5IGlkZW50aWZpZXMgdGhpcyBwYXJ0aWN1bGFyIHN5bmNocm9uaXplci5cbiAgICAvLyAgIEZvciBtb3N0IHB1cnBvc2VzLCB1dWlkIHNob3VsZCBnZXQgdGhlIGRlZmF1bHQsIGFuZCByZWZlcnMgdG8gT1VSIGVuZC5cbiAgICAvLyAgIEhvd2V2ZXIsIGEgc2VydmVyIHRoYXQgY29ubmVjdHMgdG8gYSBidW5jaCBvZiBwZWVycyBtaWdodCBiYXNoIGluIHRoZSB1dWlkIHdpdGggdGhhdCBvZiB0aGUgb3RoZXIgZW5kLCBzbyB0aGF0IGxvZ2dpbmcgaW5kaWNhdGVzIHRoZSBjbGllbnQuXG4gICAgLy8gSWYgY2hhbm5lbE5hbWUgaXMgc3BlY2lmaWVkLCBpdCBzaG91bGQgYmUgaW4gdGhlIGZvcm0gb2YgY29sbGVjdGlvblR5cGUvY29sbGVjdGlvbk5hbWUgKGUuZy4sIGlmIGNvbm5lY3RpbmcgdG8gcmVsYXkpLlxuICAgIGNvbnN0IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgPSBzZXJ2aWNlTmFtZS5zdGFydHNXaXRoPy4oJ2h0dHAnKTtcbiAgICBpZiAoIWNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgKHJ0Y0NvbmZpZ3VyYXRpb24gPT09IHVuZGVmaW5lZCkpIHJ0Y0NvbmZpZ3VyYXRpb24gPSB7fTsgLy8gRXhwaWNpdGx5IG5vIGljZS4gTEFOIG9ubHkuXG4gICAgLy8gbXVsdGlwbGV4IHNob3VsZCBlbmQgdXAgd2l0aCBvbmUgb2YgdGhyZWUgdmFsdWVzOlxuICAgIC8vIGZhbHN5IC0gYSBuZXcgY29ubmVjdGlvbiBzaG91bGQgYmUgdXNlZCBmb3IgZWFjaCBjaGFubmVsXG4gICAgLy8gXCJuZWdvdGlhdGVkXCIgLSBib3RoIHNpZGVzIGNyZWF0ZSB0aGUgc2FtZSBjaGFubmVsTmFtZXMgaW4gdGhlIHNhbWUgb3JkZXIgKG1vc3QgY2FzZXMpOlxuICAgIC8vICAgICBUaGUgaW5pdGlhbCBzaWduYWxsaW5nIHdpbGwgYmUgdHJpZ2dlcmVkIGJ5IG9uZSBzaWRlIGNyZWF0aW5nIGEgY2hhbm5lbCwgYW5kIHRoZXIgc2lkZSB3YWl0aW5nIGZvciBpdCB0byBiZSBjcmVhdGVkLlxuICAgIC8vICAgICBBZnRlciB0aGF0LCBib3RoIHNpZGVzIHdpbGwgZXhwbGljaXRseSBjcmVhdGUgYSBkYXRhIGNoYW5uZWwgYW5kIHdlYnJ0YyB3aWxsIG1hdGNoIHRoZW0gdXAgYnkgaWQuXG4gICAgLy8gYW55IG90aGVyIHRydXRoeSAtIFN0YXJ0cyBsaWtlIG5lZ290aWF0ZWQsIGFuZCB0aGVuIGNvbnRpbnVlcyB3aXRoIG9ubHkgd2lkZSBzaWRlIGNyZWF0aW5nIHRoZSBjaGFubmVscywgYW5kIHRoZXIgb3RoZXJcbiAgICAvLyAgICAgb2JzZXJ2ZXMgdGhlIGNoYW5uZWwgdGhhdCBoYXMgYmVlbiBtYWRlLiBUaGlzIGlzIHVzZWQgZm9yIHJlbGF5cy5cbiAgICBtdWx0aXBsZXggPz89IGNvbm5lY3Rpb24/Lm11bHRpcGxleDsgLy8gU3RpbGwgdHlwaWNhbGx5IHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LlxuICAgIG11bHRpcGxleCA/Pz0gKHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zeW5jJykgfHwgJ25lZ290aWF0ZWQnKTtcbiAgICBjb25uZWN0aW9uID8/PSBTaGFyZWRXZWJSVEMuZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIGNvbmZpZ3VyYXRpb246IHJ0Y0NvbmZpZ3VyYXRpb24sIG11bHRpcGxleCwgdXVpZCwgZGVidWcsIGVycm9yfSk7XG5cbiAgICB1dWlkID8/PSBjb25uZWN0aW9uLnV1aWQ7XG4gICAgLy8gQm90aCBwZWVycyBtdXN0IGFncmVlIG9uIGNoYW5uZWxOYW1lLiBVc3VhbGx5LCB0aGlzIGlzIGNvbGxlY3Rpb24uZnVsbE5hbWUuIEJ1dCBpbiB0ZXN0aW5nLCB3ZSBtYXkgc3luYyB0d28gY29sbGVjdGlvbnMgd2l0aCBkaWZmZXJlbnQgbmFtZXMuXG4gICAgY2hhbm5lbE5hbWUgPz89IGNvbGxlY3Rpb24/LmNoYW5uZWxOYW1lIHx8IGNvbGxlY3Rpb24uZnVsbE5hbWU7XG4gICAgY29uc3QgbGFiZWwgPSBgJHtjb2xsZWN0aW9uPy5mdWxsTGFiZWwgfHwgY2hhbm5lbE5hbWV9LyR7dXVpZH1gO1xuICAgIC8vIFdoZXJlIHdlIGNhbiByZXF1ZXN0IGEgZGF0YSBjaGFubmVsIHRoYXQgcHVzaGVzIHB1dC9kZWxldGUgcmVxdWVzdHMgZnJvbSBvdGhlcnMuXG4gICAgY29uc3QgY29ubmVjdGlvblVSTCA9IHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zaWduYWwvJykgPyBzZXJ2aWNlTmFtZSA6IGAke3NlcnZpY2VOYW1lfS8ke2xhYmVsfWA7XG5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzZXJ2aWNlTmFtZSwgbGFiZWwsIGNvbGxlY3Rpb24sIGRlYnVnLCBlcnJvciwgbWluVmVyc2lvbiwgbWF4VmVyc2lvbiwgdXVpZCwgcnRjQ29uZmlndXJhdGlvbixcblx0XHRcdCBjb25uZWN0aW9uLCB1dWlkLCBjaGFubmVsTmFtZSwgY29ubmVjdGlvblVSTCxcblx0XHRcdCBjb25uZWN0aW9uU3RhcnRUaW1lOiBEYXRlLm5vdygpLFxuXHRcdFx0IGNsb3NlZDogdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCksXG5cdFx0XHQgLy8gTm90IHVzZWQgeWV0LCBidXQgY291bGQgYmUgdXNlZCB0byBHRVQgcmVzb3VyY2VzIG92ZXIgaHR0cCBpbnN0ZWFkIG9mIHRocm91Z2ggdGhlIGRhdGEgY2hhbm5lbC5cblx0XHRcdCBob3N0UmVxdWVzdEJhc2U6IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgYCR7c2VydmljZU5hbWUucmVwbGFjZSgvXFwvKHN5bmN8c2lnbmFsKS8pfS8ke2NoYW5uZWxOYW1lfWB9KTtcbiAgICBjb2xsZWN0aW9uPy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgdGhpcyk7IC8vIE11c3QgYmUgc2V0IHN5bmNocm9ub3VzbHksIHNvIHRoYXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEga25vd3MgdG8gd2FpdC5cbiAgfVxuICBzdGF0aWMgYXN5bmMgY3JlYXRlKGNvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCBvcHRpb25zID0ge30pIHsgLy8gUmVjZWl2ZSBwdXNoZWQgbWVzc2FnZXMgZnJvbSB0aGUgZ2l2ZW4gc2VydmljZS4gZ2V0L3B1dC9kZWxldGUgd2hlbiB0aGV5IGNvbWUgKHdpdGggZW1wdHkgc2VydmljZXMgbGlzdCkuXG4gICAgY29uc3Qgc3luY2hyb25pemVyID0gbmV3IHRoaXMoe2NvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCAuLi5vcHRpb25zfSk7XG4gICAgY29uc3QgY29ubmVjdGVkUHJvbWlzZSA9IHN5bmNocm9uaXplci5jb25uZWN0Q2hhbm5lbCgpOyAvLyBFc3RhYmxpc2ggY2hhbm5lbCBjcmVhdGlvbiBvcmRlci5cbiAgICBjb25zdCBjb25uZWN0ZWQgPSBhd2FpdCBjb25uZWN0ZWRQcm9taXNlO1xuICAgIGlmICghY29ubmVjdGVkKSByZXR1cm4gc3luY2hyb25pemVyO1xuICAgIHJldHVybiBhd2FpdCBjb25uZWN0ZWQuc3luY2hyb25pemUoKTtcbiAgfVxuICBhc3luYyBjb25uZWN0Q2hhbm5lbCgpIHsgLy8gU3luY2hyb25vdXNseSBpbml0aWFsaXplIGFueSBwcm9taXNlcyB0byBjcmVhdGUgYSBkYXRhIGNoYW5uZWwsIGFuZCB0aGVuIGF3YWl0IGNvbm5lY3Rpb24uXG4gICAgY29uc3Qge2hvc3RSZXF1ZXN0QmFzZSwgdXVpZCwgY29ubmVjdGlvbiwgc2VydmljZU5hbWV9ID0gdGhpcztcbiAgICBsZXQgc3RhcnRlZCA9IGNvbm5lY3Rpb24uaGFzU3RhcnRlZENvbm5lY3Rpbmc7XG4gICAgaWYgKHN0YXJ0ZWQpIHtcbiAgICAgIC8vIFdlIGFscmVhZHkgaGF2ZSBhIGNvbm5lY3Rpb24uIEp1c3Qgb3BlbiBhbm90aGVyIGRhdGEgY2hhbm5lbCBmb3Igb3VyIHVzZS5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zeW5jJykpIHsgLy8gQ29ubmVjdCB3aXRoIGEgc2VydmVyIHJlbGF5LiAoU2lnbmFsIGFuZCBzdGF5IGNvbm5lY3RlZCB0aHJvdWdoIHN5bmMuKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc2lnbmFsL2Fuc3dlcicpKSB7IC8vIFNlZWtpbmcgYW4gYW5zd2VyIHRvIGFuIG9mZmVyIHdlIFBPU1QgKHRvIHJlbmRldm91cyB3aXRoIGEgcGVlcikuXG4gICAgICBzdGFydGVkID0gdGhpcy5jb25uZWN0U2VydmVyKCk7IC8vIEp1c3QgbGlrZSBhIHN5bmNcbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3NpZ25hbC9vZmZlcicpKSB7IC8vIEdFVCBhbiBvZmZlciBmcm9tIGEgcmVuZGV2b3VzIHBlZXIgYW5kIHRoZW4gUE9TVCBhbiBhbnN3ZXIuXG4gICAgICAvLyBXZSBtdXN0IHN5Y2hyb25vdXNseSBzdGFydENvbm5lY3Rpb24gbm93IHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gaGFzU3RhcnRlZENvbm5lY3RpbmcsIGFuZCBhbnkgc3Vic2VxdWVudCBkYXRhIGNoYW5uZWxcbiAgICAgIC8vIHJlcXVlc3RzIG9uIHRoZSBzYW1lIGNvbm5lY3Rpb24gd2lsbCB3YWl0ICh1c2luZyB0aGUgJ3N0YXJ0ZWQnIHBhdGgsIGFib3ZlKS5cbiAgICAgIC8vIENvbXBhcmUgY29ubmVjdFNlcnZlciwgd2hpY2ggaXMgYmFzaWNhbGx5OlxuICAgICAgLy8gICBzdGFydENvbm5lY3Rpb24oKSwgZmV0Y2ggd2l0aCB0aGF0IG9mZmVyLCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCBmZXRjaGVkIGFuc3dlci5cbiAgICAgIGNvbnN0IHByb21pc2VkU2lnbmFscyA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKFtdKTsgLy8gRXN0YWJsaXNoaW5nIG9yZGVyLlxuICAgICAgY29uc3QgdXJsID0gdGhpcy5jb25uZWN0aW9uVVJMO1xuICAgICAgY29uc3Qgb2ZmZXIgPSBhd2FpdCB0aGlzLmZldGNoKHVybCk7XG4gICAgICBjb25zdCBvayA9IHRoaXMuY29tcGxldGVDb25uZWN0aW9uKG9mZmVyKTsgLy8gTm93IHN1cHBseSB0aG9zZSBzaWduYWxzIHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gY2FuIHByb2R1Y2UgYW5zd2VyIHNpZ2Fscy5cbiAgICAgIGNvbnN0IGFuc3dlciA9IGF3YWl0IHByb21pc2VkU2lnbmFscztcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmZldGNoKHVybCwgYW5zd2VyKTsgLy8gUE9TVCBvdXIgYW5zd2VyIHRvIHBlZXIuXG4gICAgfSBlbHNlIGlmIChzZXJ2aWNlTmFtZSA9PT0gJ3NpZ25hbHMnKSB7IC8vIFN0YXJ0IGNvbm5lY3Rpb24gYW5kIHJldHVybiBudWxsLiBNdXN0IGJlIGNvbnRpbnVlZCB3aXRoIGNvbXBsZXRlU2lnbmFsc1N5bmNocm9uaXphdGlvbigpO1xuICAgICAgc3RhcnRlZCA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoc2VydmljZU5hbWUpKSB7IC8vIEEgbGlzdCBvZiBcInJlY2VpdmluZ1wiIHNpZ25hbHMuXG4gICAgICBzdGFydGVkID0gdGhpcy5zdGFydENvbm5lY3Rpb24oc2VydmljZU5hbWUpO1xuICAgIH0gZWxzZSBpZiAoc2VydmljZU5hbWUuc3luY2hyb25pemVycykgeyAvLyBEdWNrIHR5cGluZyBmb3IgcGFzc2luZyBhIGNvbGxlY3Rpb24gZGlyZWN0bHkgYXMgdGhlIHNlcnZpY2VJbmZvLiAoV2UgZG9uJ3QgaW1wb3J0IENvbGxlY3Rpb24uKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdERpcmVjdFRlc3Rpbmcoc2VydmljZU5hbWUpOyAvLyBVc2VkIGluIHRlc3RpbmcuXG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5yZWNvZ25pemVkIHNlcnZpY2UgZm9ybWF0OiAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgaWYgKCEoYXdhaXQgc3RhcnRlZCkpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnY29ubmVjdGlvbiBmYWlsZWQnKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIGdldCBkYXRhQ2hhbm5lbFByb21pc2UoKSB7IC8vIEEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLl9kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgaWYgKCFwcm9taXNlKSB0aHJvdyBuZXcgRXJyb3IoYCR7dGhpcy5sYWJlbH06IERhdGEgY2hhbm5lbCBpcyBub3QgeWV0IHByb21pc2VkLmApO1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGNoYW5uZWxDbG9zZWRDbGVhbnVwKCkgeyAvLyBCb29ra2VlcGluZyB3aGVuIGNoYW5uZWwgY2xvc2VkIG9yIGV4cGxpY2l0bHkgYWJhbmRvbmVkIGJlZm9yZSBvcGVuaW5nLlxuICAgIHRoaXMuY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5kZWxldGUodGhpcy5zZXJ2aWNlTmFtZSk7XG4gICAgdGhpcy5jbG9zZWQucmVzb2x2ZSh0aGlzKTsgLy8gUmVzb2x2ZSB0byBzeW5jaHJvbml6ZXIgaXMgbmljZSBpZiwgZS5nLCBzb21lb25lIGlzIFByb21pc2UucmFjaW5nLlxuICB9XG4gIHNldCBkYXRhQ2hhbm5lbFByb21pc2UocHJvbWlzZSkgeyAvLyBTZXQgdXAgbWVzc2FnZSBhbmQgY2xvc2UgaGFuZGxpbmcuXG4gICAgdGhpcy5fZGF0YUNoYW5uZWxQcm9taXNlID0gcHJvbWlzZS50aGVuKGRhdGFDaGFubmVsID0+IHtcbiAgICAgIGRhdGFDaGFubmVsLm9ubWVzc2FnZSA9IGV2ZW50ID0+IHRoaXMucmVjZWl2ZShldmVudC5kYXRhKTtcbiAgICAgIGRhdGFDaGFubmVsLm9uY2xvc2UgPSBhc3luYyBldmVudCA9PiB0aGlzLmNoYW5uZWxDbG9zZWRDbGVhbnVwKCk7XG4gICAgICByZXR1cm4gZGF0YUNoYW5uZWw7XG4gICAgfSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemUoKSB7XG4gICAgYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG4gIHN0YXRpYyBmcmFnbWVudElkID0gMDtcbiAgYXN5bmMgc2VuZChtZXRob2QsIC4uLnBhcmFtcykgeyAvLyBTZW5kcyB0byB0aGUgcGVlciwgb3ZlciB0aGUgZGF0YSBjaGFubmVsXG4gICAgLy8gVE9ETzogYnJlYWsgdXAgbG9uZyBtZXNzYWdlcy4gKEFzIGEgcHJhY3RpY2FsIG1hdHRlciwgMTYgS2lCIGlzIHRoZSBsb25nZXN0IHRoYXQgY2FuIHJlbGlhYmx5IGJlIHNlbnQgYWNyb3NzIGRpZmZlcmVudCB3cnRjIGltcGxlbWVudGF0aW9ucy4pXG4gICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9XZWJSVENfQVBJL1VzaW5nX2RhdGFfY2hhbm5lbHMjY29uY2VybnNfd2l0aF9sYXJnZV9tZXNzYWdlc1xuICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnN0cmluZ2lmeSh7bWV0aG9kLCBwYXJhbXN9KTtcbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGNvbnN0IHN0YXRlID0gZGF0YUNoYW5uZWw/LnJlYWR5U3RhdGUgfHwgJ2Nsb3NlZCc7XG4gICAgaWYgKHN0YXRlID09PSAnY2xvc2VkJyB8fCBzdGF0ZSA9PT0gJ2Nsb3NpbmcnKSByZXR1cm47XG4gICAgdGhpcy5sb2coJ3NlbmRzJywgbWV0aG9kLCAuLi5wYXJhbXMpO1xuICAgIGNvbnN0IHNpemUgPSAxNmUzOyAvLyBBIGJpdCBsZXNzIHRoYW4gMTYgKiAxMDI0LlxuICAgIGlmIChwYXlsb2FkLmxlbmd0aCA8IHNpemUpIHtcbiAgICAgIGRhdGFDaGFubmVsLnNlbmQocGF5bG9hZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IG51bUNodW5rcyA9IE1hdGguY2VpbChwYXlsb2FkLmxlbmd0aCAvIHNpemUpO1xuICAgIGNvbnN0IGlkID0gdGhpcy5jb25zdHJ1Y3Rvci5mcmFnbWVudElkKys7XG4gICAgY29uc3QgbWV0YSA9IHttZXRob2Q6ICdmcmFnbWVudHMnLCBwYXJhbXM6IFtpZCwgbnVtQ2h1bmtzXX07XG4gICAgLy9jb25zb2xlLmxvZyhgRnJhZ21lbnRpbmcgbWVzc2FnZSAke2lkfSBpbnRvICR7bnVtQ2h1bmtzfSBjaHVua3MuYCwgbWV0YSk7XG4gICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShtZXRhKSk7XG4gICAgLy8gT3B0aW1pemF0aW9uIG9wcG9ydHVuaXR5OiByZWx5IG9uIG1lc3NhZ2VzIGJlaW5nIG9yZGVyZWQgYW5kIHNraXAgcmVkdW5kYW50IGluZm8uIElzIGl0IHdvcnRoIGl0P1xuICAgIGZvciAobGV0IGkgPSAwLCBvID0gMDsgaSA8IG51bUNodW5rczsgKytpLCBvICs9IHNpemUpIHtcbiAgICAgIGNvbnN0IGZyYWcgPSB7bWV0aG9kOiAnZnJhZycsIHBhcmFtczogW2lkLCBpLCBwYXlsb2FkLnN1YnN0cihvLCBzaXplKV19O1xuICAgICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShmcmFnKSk7XG4gICAgfVxuICB9XG4gIHJlY2VpdmUodGV4dCkgeyAvLyBEaXNwYXRjaCBhIG1lc3NhZ2Ugc2VudCBvdmVyIHRoZSBkYXRhIGNoYW5uZWwgZnJvbSB0aGUgcGVlci5cbiAgICBjb25zdCB7bWV0aG9kLCBwYXJhbXN9ID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgICB0aGlzW21ldGhvZF0oLi4ucGFyYW1zKTtcbiAgfVxuICBwZW5kaW5nRnJhZ21lbnRzID0ge307XG4gIGZyYWdtZW50cyhpZCwgbnVtQ2h1bmtzKSB7XG4gICAgLy9jb25zb2xlLmxvZyhgUmVjZWl2aW5nIG1lc2FnZSAke2lkfSBpbiAke251bUNodW5rc30uYCk7XG4gICAgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXSA9IHtyZW1haW5pbmc6IG51bUNodW5rcywgbWVzc2FnZTogQXJyYXkobnVtQ2h1bmtzKX07XG4gIH1cbiAgZnJhZyhpZCwgaSwgZnJhZ21lbnQpIHtcbiAgICBsZXQgZnJhZyA9IHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF07IC8vIFdlIGFyZSByZWx5aW5nIG9uIGZyYWdtZW50IG1lc3NhZ2UgY29taW5nIGZpcnN0LlxuICAgIGZyYWcubWVzc2FnZVtpXSA9IGZyYWdtZW50O1xuICAgIGlmICgwICE9PSAtLWZyYWcucmVtYWluaW5nKSByZXR1cm47XG4gICAgLy9jb25zb2xlLmxvZyhgRGlzcGF0Y2hpbmcgbWVzc2FnZSAke2lkfS5gKTtcbiAgICB0aGlzLnJlY2VpdmUoZnJhZy5tZXNzYWdlLmpvaW4oJycpKTtcbiAgICBkZWxldGUgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXTtcbiAgfVxuXG4gIGFzeW5jIGRpc2Nvbm5lY3QoKSB7IC8vIFdhaXQgZm9yIGRhdGFDaGFubmVsIHRvIGRyYWluIGFuZCByZXR1cm4gYSBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBhY3R1YWxseSBjbG9zZWQsXG4gICAgLy8gYnV0IHJldHVybiBpbW1lZGlhdGVseSBpZiBjb25uZWN0aW9uIG5vdCBzdGFydGVkLlxuICAgIGlmICh0aGlzLmNvbm5lY3Rpb24ucGVlci5jb25uZWN0aW9uU3RhdGUgIT09ICdjb25uZWN0ZWQnKSByZXR1cm4gdGhpcy5jaGFubmVsQ2xvc2VkQ2xlYW51cCh0aGlzLmNvbm5lY3Rpb24uY2xvc2UoKSk7XG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBkYXRhQ2hhbm5lbC5jbG9zZSgpO1xuICAgIHJldHVybiB0aGlzLmNsb3NlZDtcbiAgfVxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGR1cmluZyBzeW5jLlxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGFmdGVyIHN5bmMuXG4gIHN0YXJ0Q29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBNYWNoaW5lcnkgZm9yIG1ha2luZyBhIFdlYlJUQyBjb25uZWN0aW9uIHRvIHRoZSBwZWVyOlxuICAgIC8vICAgSWYgc2lnbmFsTWVzc2FnZXMgaXMgYSBsaXN0IG9mIFtvcGVyYXRpb24sIG1lc3NhZ2VdIG1lc3NhZ2Ugb2JqZWN0cywgdGhlbiB0aGUgb3RoZXIgc2lkZSBpcyBpbml0aWF0aW5nXG4gICAgLy8gdGhlIGNvbm5lY3Rpb24gYW5kIGhhcyBzZW50IGFuIGluaXRpYWwgb2ZmZXIvaWNlLiBJbiB0aGlzIGNhc2UsIHN0YXJ0Q29ubmVjdCgpIHByb21pc2VzIGEgcmVzcG9uc2VcbiAgICAvLyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUuXG4gICAgLy8gICBPdGhlcndpc2UsIHN0YXJ0Q29ubmVjdCgpIHByb21pc2VzIGEgbGlzdCBvZiBpbml0aWFsIHNpZ25hbCBtZXNzYWdlcyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUsXG4gICAgLy8gYW5kIGl0IGlzIG5lY2Vzc2FyeSB0byB0aGVuIGNhbGwgY29tcGxldGVDb25uZWN0aW9uKCkgd2l0aCB0aGUgcmVzcG9uc2UgZnJvbSB0aGVtLlxuICAgIC8vIEluIGJvdGggY2FzZXMsIGFzIGEgc2lkZSBlZmZlY3QsIHRoZSBkYXRhQ2hhbm5lbFByb21pc2UgcHJvcGVydHkgd2lsbCBiZSBzZXQgdG8gYSBQcm9taXNlXG4gICAgLy8gdGhhdCByZXNvbHZlcyB0byB0aGUgZGF0YSBjaGFubmVsIHdoZW4gaXQgaXMgb3BlbnMuIFRoaXMgcHJvbWlzZSBpcyB1c2VkIGJ5IHNlbmQoKSBhbmQgcmVjZWl2ZSgpLlxuICAgIGNvbnN0IHtjb25uZWN0aW9ufSA9IHRoaXM7XG4gICAgdGhpcy5sb2coc2lnbmFsTWVzc2FnZXMgPyAnZ2VuZXJhdGluZyBhbnN3ZXInIDogJ2dlbmVyYXRpbmcgb2ZmZXInKTtcbiAgICB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSwge30sIHNpZ25hbE1lc3NhZ2VzKTtcbiAgICByZXR1cm4gY29ubmVjdGlvbi5zaWduYWxzO1xuICB9XG4gIGNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBGaW5pc2ggd2hhdCB3YXMgc3RhcnRlZCB3aXRoIHN0YXJ0Q29sbGVjdGlvbi5cbiAgICAvLyBEb2VzIG5vdCByZXR1cm4gYSBwcm9taXNlLiBDbGllbnQgY2FuIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlIHRvIHNlZSB3aGVuIHdlIGFyZSBhY3R1YWxseSBjb25uZWN0ZWQuXG4gICAgaWYgKCFzaWduYWxNZXNzYWdlcykgcmV0dXJuIGZhbHNlO1xuICAgIHRoaXMuY29ubmVjdGlvbi5zaWduYWxzID0gc2lnbmFsTWVzc2FnZXM7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBzdGF0aWMgZmV0Y2hKU09OKHVybCwgYm9keSA9IHVuZGVmaW5lZCwgbWV0aG9kID0gbnVsbCkge1xuICAgIGNvbnN0IGhhc0JvZHkgPSBib2R5ICE9PSB1bmRlZmluZWQ7XG4gICAgbWV0aG9kID8/PSBoYXNCb2R5ID8gJ1BPU1QnIDogJ0dFVCc7XG4gICAgcmV0dXJuIGZldGNoKHVybCwgaGFzQm9keSA/IHttZXRob2QsIGhlYWRlcnM6IHtcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIn0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpfSA6IHttZXRob2R9KVxuICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuXHRpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoYCR7cmVzcG9uc2Uuc3RhdHVzVGV4dCB8fCAnRmV0Y2ggZmFpbGVkJ30sIGNvZGUgJHtyZXNwb25zZS5zdGF0dXN9IGluICR7dXJsfS5gKTtcblx0cmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcbiAgICAgIH0pO1xuICB9XG4gIGFzeW5jIGZldGNoKHVybCwgYm9keSA9IHVuZGVmaW5lZCkgeyAvLyBBcyBKU09OXG5cbiAgICBjb25zdCBtZXRob2QgPSBib2R5ID8gJ1BPU1QnIDogJ0dFVCc7XG4gICAgdGhpcy5sb2coJ2ZldGNoJywgbWV0aG9kLCB1cmwsICdzZW5kaW5nOicsIGJvZHkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZmV0Y2hKU09OKHVybCwgYm9keSwgbWV0aG9kKVxuXHQgIC5jYXRjaChlcnJvciA9PiB7XG5cdCAgICB0aGlzLmNsb3NlZC5yZWplY3QoZXJyb3IpO1xuXHQgIH0pO1xuICAgIHRoaXMubG9nKCdmZXRjaCcsIG1ldGhvZCwgdXJsLCAncmVzdWx0OicsIHJlc3VsdCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICBhc3luYyBjb25uZWN0U2VydmVyKHVybCA9IHRoaXMuY29ubmVjdGlvblVSTCkgeyAvLyBDb25uZWN0IHRvIGEgcmVsYXkgb3ZlciBodHRwLiAoL3N5bmMgb3IgL3NpZ25hbC9hbnN3ZXIpXG4gICAgLy8gc3RhcnRDb25uZWN0aW9uLCBQT1NUIG91ciBzaWduYWxzLCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCB0aGUgcmVzcG9uc2UuXG4gICAgLy8gT3VyIHdlYnJ0YyBzeW5jaHJvbml6ZXIgaXMgdGhlbiBjb25uZWN0ZWQgdG8gdGhlIHJlbGF5J3Mgd2VicnQgc3luY2hyb25pemVyLlxuICAgIGNvbnN0IG91clNpZ25hbHNQcm9taXNlID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTsgLy8gbXVzdCBiZSBzeW5jaHJvbm91cyB0byBwcmVzZXJ2ZSBjaGFubmVsIGlkIG9yZGVyLlxuICAgIGNvbnN0IG91clNpZ25hbHMgPSBhd2FpdCBvdXJTaWduYWxzUHJvbWlzZTtcbiAgICBjb25zdCB0aGVpclNpZ25hbHMgPSBhd2FpdCB0aGlzLmZldGNoKHVybCwgb3VyU2lnbmFscyk7IC8vIFBPU1RcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuICBhc3luYyBjb21wbGV0ZVNpZ25hbHNTeW5jaHJvbml6YXRpb24oc2lnbmFscykgeyAvLyBHaXZlbiBhbnN3ZXIvaWNlIHNpZ25hbHMsIGNvbXBsZXRlIHRoZSBjb25uZWN0aW9uIGFuZCBzdGFydCBzeW5jaHJvbml6ZS5cbiAgICBhd2FpdCB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxzKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdERpcmVjdFRlc3RpbmcocGVlckNvbGxlY3Rpb24pIHsgLy8gVXNlZCBpbiB1bml0IHRlc3RpbmcsIHdoZXJlIHRoZSBcInJlbW90ZVwiIHNlcnZpY2UgaXMgc3BlY2lmaWVkIGRpcmVjdGx5IChub3QgYSBzdHJpbmcpLlxuICAgIC8vIEVhY2ggY29sbGVjdGlvbiBpcyBhc2tlZCB0byBzeWNocm9uaXplIHRvIGFub3RoZXIgY29sbGVjdGlvbi5cbiAgICBjb25zdCBwZWVyU3luY2hyb25pemVyID0gcGVlckNvbGxlY3Rpb24uc3luY2hyb25pemVycy5nZXQodGhpcy5jb2xsZWN0aW9uKTtcbiAgICBpZiAoIXBlZXJTeW5jaHJvbml6ZXIpIHsgLy8gVGhlIG90aGVyIHNpZGUgZG9lc24ndCBrbm93IGFib3V0IHVzIHlldC4gVGhlIG90aGVyIHNpZGUgd2lsbCBkbyB0aGUgd29yay5cbiAgICAgIHRoaXMuX2RlbGF5ID0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IG91clNpZ25hbHMgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbigpO1xuICAgIGNvbnN0IHRoZWlyU2lnbmFscyA9IGF3YWl0IHBlZXJTeW5jaHJvbml6ZXIuc3RhcnRDb25uZWN0aW9uKGF3YWl0IG91clNpZ25hbHMpO1xuICAgIHBlZXJTeW5jaHJvbml6ZXIuX2RlbGF5LnJlc29sdmUoKTtcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuXG4gIC8vIEEgY29tbW9uIHByYWN0aWNlIGhlcmUgaXMgdG8gaGF2ZSBhIHByb3BlcnR5IHRoYXQgaXMgYSBwcm9taXNlIGZvciBoYXZpbmcgc29tZXRoaW5nIGRvbmUuXG4gIC8vIEFzeW5jaHJvbm91cyBtYWNoaW5lcnkgY2FuIHRoZW4gcmVzb2x2ZSBpdC5cbiAgLy8gQW55dGhpbmcgdGhhdCBkZXBlbmRzIG9uIHRoYXQgY2FuIGF3YWl0IHRoZSByZXNvbHZlZCB2YWx1ZSwgd2l0aG91dCB3b3JyeWluZyBhYm91dCBob3cgaXQgZ2V0cyByZXNvbHZlZC5cbiAgLy8gV2UgY2FjaGUgdGhlIHByb21pc2Ugc28gdGhhdCB3ZSBkbyBub3QgcmVwZXRlZGx5IHRyaWdnZXIgdGhlIHVuZGVybHlpbmcgYWN0aW9uLlxuICBtYWtlUmVzb2x2ZWFibGVQcm9taXNlKGlnbm9yZWQpIHsgLy8gQW5zd2VyIGEgUHJvbWlzZSB0aGF0IGNhbiBiZSByZXNvbHZlIHdpdGggdGhlUHJvbWlzZS5yZXNvbHZlKHZhbHVlKS5cbiAgICAvLyBUaGUgaWdub3JlZCBhcmd1bWVudCBpcyBhIGNvbnZlbmllbnQgcGxhY2UgdG8gY2FsbCBzb21ldGhpbmcgZm9yIHNpZGUtZWZmZWN0LlxuICAgIGxldCByZXNvbHZlciwgcmVqZWN0ZXI7XG4gICAgY29uc3QgcHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsgcmVzb2x2ZXIgPSByZXNvbHZlOyByZWplY3RlciA9IHJlamVjdDsgfSk7XG4gICAgcHJvbWlzZS5yZXNvbHZlID0gcmVzb2x2ZXI7XG4gICAgcHJvbWlzZS5yZWplY3QgPSByZWplY3RlcjtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIHZlcnNpb25zKG1pbiwgbWF4KSB7IC8vIE9uIHJlY2VpdmluZyB0aGUgdmVyc2lvbnMgc3VwcG9ydGVkIGJ5IHRoZSB0aGUgcGVlciwgcmVzb2x2ZSB0aGUgdmVyc2lvbiBwcm9taXNlLlxuICAgIGxldCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbjtcbiAgICBjb25zdCBjb21iaW5lZE1heCA9IE1hdGgubWluKG1heCwgdGhpcy5tYXhWZXJzaW9uKTtcbiAgICBjb25zdCBjb21iaW5lZE1pbiA9IE1hdGgubWF4KG1pbiwgdGhpcy5taW5WZXJzaW9uKTtcbiAgICBpZiAoY29tYmluZWRNYXggPj0gY29tYmluZWRNaW4pIHJldHVybiB2ZXJzaW9uUHJvbWlzZS5yZXNvbHZlKGNvbWJpbmVkTWF4KTsgLy8gTm8gbmVlZCB0byByZXNwb25kLCBhcyB0aGV5IHdpbGwgcHJvZHVjZSB0aGUgc2FtZSBkZXRlcm1pbmlzdGljIGFuc3dlci5cbiAgICByZXR1cm4gdmVyc2lvblByb21pc2UucmVzb2x2ZSgwKTtcbiAgfVxuICBnZXQgdmVyc2lvbigpIHsgLy8gUHJvbWlzZSB0aGUgaGlnaGVzdCB2ZXJzaW9uIHN1cG9ydGVkIGJ5IGJvdGggc2lkZXMsIG9yIGRpc2Nvbm5lY3QgYW5kIGZhbHN5IGlmIG5vbmUuXG4gICAgLy8gVGVsbHMgdGhlIG90aGVyIHNpZGUgb3VyIHZlcnNpb25zIGlmIHdlIGhhdmVuJ3QgeWV0IGRvbmUgc28uXG4gICAgLy8gRklYTUU6IGNhbiB3ZSBhdm9pZCB0aGlzIHRpbWVvdXQ/XG4gICAgcmV0dXJuIHRoaXMuX3ZlcnNpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZShzZXRUaW1lb3V0KCgpID0+IHRoaXMuc2VuZCgndmVyc2lvbnMnLCB0aGlzLm1pblZlcnNpb24sIHRoaXMubWF4VmVyc2lvbiksIDIwMCkpO1xuICB9XG5cbiAgZ2V0IHN0YXJ0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGhhdmUgc3RhcnRlZCBzeW5jaHJvbml6YXRpb24uXG4gICAgcmV0dXJuIHRoaXMuX3N0YXJ0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMuc3RhcnRTeW5jaHJvbml6YXRpb24oKTtcbiAgfVxuICBnZXQgY29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG51bWJlciBvZiBpdGVtcyB0aGF0IHdlcmUgdHJhbnNmZXJyZWQgKG5vdCBuZWNlc3NhcmlsbHkgd3JpdHRlbikuXG4gICAgLy8gU3RhcnRzIHN5bmNocm9uaXphdGlvbiBpZiBpdCBoYXNuJ3QgYWxyZWFkeS4gRS5nLiwgd2FpdGluZyBvbiBjb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gd29uJ3QgcmVzb2x2ZSB1bnRpbCBhZnRlciBpdCBzdGFydHMuXG4gICAgcmV0dXJuIHRoaXMuX2NvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbik7XG4gIH1cbiAgZ2V0IHBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbnVtYmVyIG9mIGl0ZW1zIHRoYXQgdGhlIHBlZXIgc3luY2hyb25pemVkLlxuICAgIHJldHVybiB0aGlzLl9wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UoKTtcbiAgfVxuICBnZXQgYm90aFNpZGVzQ29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHJlc29sdmVzIHRydXRoeSB3aGVuIGJvdGggc2lkZXMgYXJlIGRvbmUuXG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVkU3luY2hyb25pemF0aW9uLnRoZW4oKCkgPT4gdGhpcy5wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uKTtcbiAgfVxuICBhc3luYyByZXBvcnRDb25uZWN0aW9uKCkgeyAvLyBMb2cgY29ubmVjdGlvbiB0aW1lIGFuZCB0eXBlLlxuICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgdGhpcy5jb25uZWN0aW9uLnBlZXIuZ2V0U3RhdHMoKTtcbiAgICBsZXQgdHJhbnNwb3J0O1xuICAgIGZvciAoY29uc3QgcmVwb3J0IG9mIHN0YXRzLnZhbHVlcygpKSB7XG4gICAgICBpZiAocmVwb3J0LnR5cGUgPT09ICd0cmFuc3BvcnQnKSB7XG5cdHRyYW5zcG9ydCA9IHJlcG9ydDtcblx0YnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGxldCBjYW5kaWRhdGVQYWlyID0gdHJhbnNwb3J0ICYmIHN0YXRzLmdldCh0cmFuc3BvcnQuc2VsZWN0ZWRDYW5kaWRhdGVQYWlySWQpO1xuICAgIGlmICghY2FuZGlkYXRlUGFpcikgeyAvLyBTYWZhcmkgZG9lc24ndCBmb2xsb3cgdGhlIHN0YW5kYXJkLlxuICAgICAgZm9yIChjb25zdCByZXBvcnQgb2Ygc3RhdHMudmFsdWVzKCkpIHtcblx0aWYgKChyZXBvcnQudHlwZSA9PT0gJ2NhbmRpZGF0ZS1wYWlyJykgJiYgcmVwb3J0LnNlbGVjdGVkKSB7XG5cdCAgY2FuZGlkYXRlUGFpciA9IHJlcG9ydDtcblx0ICBicmVhaztcblx0fVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIWNhbmRpZGF0ZVBhaXIpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnZ290IHN0YXRzIHdpdGhvdXQgY2FuZGlkYXRlUGFpcicsIEFycmF5LmZyb20oc3RhdHMudmFsdWVzKCkpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVtb3RlID0gc3RhdHMuZ2V0KGNhbmRpZGF0ZVBhaXIucmVtb3RlQ2FuZGlkYXRlSWQpO1xuICAgIGNvbnN0IHtwcm90b2NvbCwgY2FuZGlkYXRlVHlwZX0gPSByZW1vdGU7XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzdGF0cywgdHJhbnNwb3J0LCBjYW5kaWRhdGVQYWlyLCByZW1vdGUsIHByb3RvY29sLCBjYW5kaWRhdGVUeXBlLCBzeW5jaHJvbml6YXRpb25TdGFydFRpbWU6IG5vd30pO1xuICAgIGNvbnNvbGUuaW5mbyh0aGlzLmxhYmVsLCAnY29ubmVjdGVkJywgcHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGUsICgobm93IC0gdGhpcy5jb25uZWN0aW9uU3RhcnRUaW1lKS8xZTMpLnRvRml4ZWQoMSkpO1xuICB9XG4gIGFzeW5jIHN0YXJ0U3luY2hyb25pemF0aW9uKCkgeyAvLyBXYWl0IGZvciBhbGwgcHJlbGltaW5hcmllcywgYW5kIHN0YXJ0IHN0cmVhbWluZyBvdXIgdGFncy5cbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGlmICghZGF0YUNoYW5uZWwpIHRocm93IG5ldyBFcnJvcihgTm8gY29ubmVjdGlvbiBmb3IgJHt0aGlzLmxhYmVsfS5gKTtcbiAgICAvLyBOb3cgdGhhdCB3ZSBhcmUgY29ubmVjdGVkLCBhbnkgbmV3IHdyaXRlcyBvbiBvdXIgZW5kIHdpbGwgYmUgcHVzaGVkIHRvIHRoZSBwZWVyLiBTbyBjYXB0dXJlIHRoZSBpbml0aWFsIHRhZ3Mgbm93LlxuICAgIGNvbnN0IG91clRhZ3MgPSBuZXcgU2V0KGF3YWl0IHRoaXMuY29sbGVjdGlvbi50YWdzKTtcbiAgICBhd2FpdCB0aGlzLnJlcG9ydENvbm5lY3Rpb24oKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtcblxuICAgICAgLy8gQSBzbmFwc2hvdCBTZXQgb2YgZWFjaCB0YWcgd2UgaGF2ZSBsb2NhbGx5LCBjYXB0dXJlZCBhdCB0aGUgbW9tZW50IG9mIGNyZWF0aW9uLlxuICAgICAgb3VyVGFncywgLy8gKE5ldyBsb2NhbCB3cml0ZXMgYXJlIHB1c2hlZCB0byB0aGUgY29ubmVjdGVkIHBlZXIsIGV2ZW4gZHVyaW5nIHN5bmNocm9uaXphdGlvbi4pXG5cbiAgICAgIC8vIE1hcCBvZiB0YWcgdG8gcHJvbWlzZSBmb3IgdGFncyB0aGF0IGFyZSBiZWluZyBzeW5jaHJvbml6ZWQuXG4gICAgICAvLyBlbnN1cmVTeW5jaHJvbml6ZWRUYWcgZW5zdXJlcyB0aGF0IHRoZXJlIGlzIGFuIGVudHJ5IGhlcmUgZHVyaW5nIHRoZSB0aW1lIGEgdGFnIGlzIGluIGZsaWdodC5cbiAgICAgIHVuc3luY2hyb25pemVkOiBuZXcgTWFwKCksXG5cbiAgICAgIC8vIFNldCBvZiB3aGF0IHRhZ3MgaGF2ZSBiZWVuIGV4cGxpY2l0bHkgc3luY2hyb25pemVkLCBtZWFuaW5nIHRoYXQgdGhlcmUgaXMgYSBkaWZmZXJlbmNlIGJldHdlZW4gdGhlaXIgaGFzaFxuICAgICAgLy8gYW5kIG91cnMsIHN1Y2ggdGhhdCB3ZSBhc2sgZm9yIHRoZWlyIHNpZ25hdHVyZSB0byBjb21wYXJlIGluIGRldGFpbC4gVGh1cyB0aGlzIHNldCBtYXkgaW5jbHVkZSBpdGVtcyB0aGF0XG4gICAgICBjaGVja2VkVGFnczogbmV3IFNldCgpLCAvLyB3aWxsIG5vdCBlbmQgdXAgYmVpbmcgcmVwbGFjZWQgb24gb3VyIGVuZC5cblxuICAgICAgZW5kT2ZQZWVyVGFnczogZmFsc2UgLy8gSXMgdGhlIHBlZXIgZmluaXNoZWQgc3RyZWFtaW5nP1xuICAgIH0pO1xuICAgIC8vIE5vdyBuZWdvdGlhdGUgdmVyc2lvbiBhbmQgY29sbGVjdHMgdGhlIHRhZ3MuXG4gICAgY29uc3QgdmVyc2lvbiA9IGF3YWl0IHRoaXMudmVyc2lvbjtcbiAgICBpZiAoIXZlcnNpb24pIHsgIC8vIE1pc21hdGNoLlxuICAgICAgLy8gS2x1ZGdlIDE6IHdoeSBkb2Vzbid0IHRoaXMuZGlzY29ubmVjdCgpIGNsZWFuIHVwIHRoZSB2YXJpb3VzIHByb21pc2VzIHByb3Blcmx5P1xuICAgICAgYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UudGhlbihjaGFubmVsID0+IGNoYW5uZWwuY2xvc2UoKSk7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYCR7dGhpcy5zZXJ2aWNlTmFtZX0gZG9lcyBub3QgdXNlIGEgY29tcGF0aWJsZSB2ZXJzaW9uLmA7XG4gICAgICBjb25zb2xlLmVycm9yKG1lc3NhZ2UsIHRoaXMuY29ubmVjdGlvbi5ub3RpZmllZCk7XG4gICAgICBpZiAoKHR5cGVvZih3aW5kb3cpICE9PSAndW5kZWZpbmVkJykgJiYgIXRoaXMuY29ubmVjdGlvbi5ub3RpZmllZCkgeyAvLyBJZiB3ZSdyZSBpbiBhIGJyb3dzZXIsIHRlbGwgdGhlIHVzZXIgb25jZS5cblx0dGhpcy5jb25uZWN0aW9uLm5vdGlmaWVkID0gdHJ1ZTtcblx0d2luZG93LmFsZXJ0KG1lc3NhZ2UpO1xuXHRzZXRUaW1lb3V0KCgpID0+IGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb24ubm90aWZpZWQsIDEwKTsgLy8gS2x1ZGdlIDIuXG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuc3RyZWFtVGFncyhvdXJUYWdzKTsgLy8gQnV0IGRvIG5vdCB3YWl0IGZvciBpdC5cbiAgfVxuICBhc3luYyBjb21wdXRlSGFzaCh0ZXh0KSB7IC8vIE91ciBzdGFuZGFyZCBoYXNoLiAoU3RyaW5nIHNvIHRoYXQgaXQgaXMgc2VyaWFsaXphYmxlLilcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgQ3JlZGVudGlhbHMuaGFzaFRleHQodGV4dCk7XG4gICAgcmV0dXJuIENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChoYXNoKTtcbiAgfVxuICBhc3luYyBnZXRIYXNoKHRhZykgeyAvLyBXaG9sZSBzaWduYXR1cmUgKE5PVCBwcm90ZWN0ZWRIZWFkZXIuc3ViIG9mIGNvbnRlbnQpLlxuICAgIGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMuY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgICByZXR1cm4gdGhpcy5jb21wdXRlSGFzaChyYXcgfHwgJ21pc3NpbmcnKTtcbiAgfVxuICBhc3luYyBzdHJlYW1UYWdzKHRhZ3MpIHsgLy8gU2VuZCBlYWNoIG9mIG91ciBrbm93biB0YWcvaGFzaCBwYWlycyB0byBwZWVyLCBvbmUgYXQgYSB0aW1lLCBmb2xsb3dlZCBieSBlbmRPZlRhZ3MuXG4gICAgZm9yIChjb25zdCB0YWcgb2YgdGFncykge1xuICAgICAgdGhpcy5zZW5kKCdoYXNoJywgdGFnLCBhd2FpdCB0aGlzLmdldEhhc2godGFnKSk7XG4gICAgfVxuICAgIHRoaXMuc2VuZCgnZW5kVGFncycpO1xuICB9XG4gIGFzeW5jIGVuZFRhZ3MoKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBzdHJlYW1UYWdzKCkuXG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHRoaXMuZW5kT2ZQZWVyVGFncyA9IHRydWU7XG4gICAgdGhpcy5jbGVhblVwSWZGaW5pc2hlZCgpO1xuICB9XG4gIHN5bmNocm9uaXphdGlvbkNvbXBsZXRlKG5DaGVja2VkKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBnZXR0aW5nIGFsbCB0aGUgZGF0YSBpdCBuZWVkcyBmcm9tIHVzLlxuICAgIHRoaXMucGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBjbGVhblVwSWZGaW5pc2hlZCgpIHsgLy8gSWYgd2UgYXJlIG5vdCB3YWl0aW5nIGZvciBhbnl0aGluZywgd2UncmUgZG9uZS4gQ2xlYW4gdXAuXG4gICAgLy8gVGhpcyByZXF1aXJlcyB0aGF0IHRoZSBwZWVyIGhhcyBpbmRpY2F0ZWQgdGhhdCBpdCBpcyBmaW5pc2hlZCBzdHJlYW1pbmcgdGFncyxcbiAgICAvLyBhbmQgdGhhdCB3ZSBhcmUgbm90IHdhaXRpbmcgZm9yIGFueSBmdXJ0aGVyIHVuc3luY2hyb25pemVkIGl0ZW1zLlxuICAgIGlmICghdGhpcy5lbmRPZlBlZXJUYWdzIHx8IHRoaXMudW5zeW5jaHJvbml6ZWQuc2l6ZSkgcmV0dXJuO1xuICAgIGNvbnN0IG5DaGVja2VkID0gdGhpcy5jaGVja2VkVGFncy5zaXplOyAvLyBUaGUgbnVtYmVyIHRoYXQgd2UgY2hlY2tlZC5cbiAgICB0aGlzLnNlbmQoJ3N5bmNocm9uaXphdGlvbkNvbXBsZXRlJywgbkNoZWNrZWQpO1xuICAgIHRoaXMuY2hlY2tlZFRhZ3MuY2xlYXIoKTtcbiAgICB0aGlzLnVuc3luY2hyb25pemVkLmNsZWFyKCk7XG4gICAgdGhpcy5vdXJUYWdzID0gdGhpcy5zeW5jaHJvbml6ZWQgPSB0aGlzLnVuc3luY2hyb25pemVkID0gbnVsbDtcbiAgICBjb25zb2xlLmluZm8odGhpcy5sYWJlbCwgJ2NvbXBsZXRlZCBzeW5jaHJvbml6YXRpb24nLCBuQ2hlY2tlZCwgJ2l0ZW1zIGluJywgKChEYXRlLm5vdygpIC0gdGhpcy5zeW5jaHJvbml6YXRpb25TdGFydFRpbWUpLzFlMykudG9GaXhlZCgxKSwgJ3NlY29uZHMnKTtcbiAgICB0aGlzLmNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBzeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykgeyAvLyBSZXR1cm4gc29tZXRoaW5nIHRvIGF3YWl0IHRoYXQgcmVzb2x2ZXMgd2hlbiB0YWcgaXMgc3luY2hyb25pemVkLlxuICAgIC8vIFdoZW5ldmVyIGEgY29sbGVjdGlvbiBuZWVkcyB0byByZXRyaWV2ZSAoZ2V0VmVyaWZpZWQpIGEgdGFnIG9yIGZpbmQgdGFncyBtYXRjaGluZyBwcm9wZXJ0aWVzLCBpdCBlbnN1cmVzXG4gICAgLy8gdGhlIGxhdGVzdCBkYXRhIGJ5IGNhbGxpbmcgdGhpcyBhbmQgYXdhaXRpbmcgdGhlIGRhdGEuXG4gICAgaWYgKCF0aGlzLnVuc3luY2hyb25pemVkKSByZXR1cm4gdHJ1ZTsgLy8gV2UgaGF2ZSBmdWxseSBzeW5jaHJvbml6ZWQgYWxsIHRhZ3MuIElmIHRoZXJlIGlzIG5ldyBkYXRhLCBpdCB3aWxsIGJlIHNwb250YW5lb3VzbHkgcHVzaGVkIHRvIHVzLlxuICAgIGlmICh0aGlzLmNoZWNrZWRUYWdzLmhhcyh0YWcpKSByZXR1cm4gdHJ1ZTsgLy8gVGhpcyBwYXJ0aWN1bGFyIHRhZyBoYXMgYmVlbiBjaGVja2VkLlxuICAgIC8vIChJZiBjaGVja2VkVGFncyB3YXMgb25seSB0aG9zZSBleGNoYW5nZWQgb3Igd3JpdHRlbiwgd2Ugd291bGQgaGF2ZSBleHRyYSBmbGlnaHRzIGNoZWNraW5nLilcbiAgICAvLyBJZiBhIHJlcXVlc3QgaXMgaW4gZmxpZ2h0LCByZXR1cm4gdGhhdCBwcm9taXNlLiBPdGhlcndpc2UgY3JlYXRlIG9uZS5cbiAgICByZXR1cm4gdGhpcy51bnN5bmNocm9uaXplZC5nZXQodGFnKSB8fCB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsICcnLCB0aGlzLmdldEhhc2godGFnKSk7XG4gIH1cblxuICBhc3luYyBoYXNoKHRhZywgaGFzaCkgeyAvLyBSZWNlaXZlIGEgW3RhZywgaGFzaF0gdGhhdCB0aGUgcGVlciBrbm93cyBhYm91dC4gKFBlZXIgc3RyZWFtcyB6ZXJvIG9yIG1vcmUgb2YgdGhlc2UgdG8gdXMuKVxuICAgIC8vIFVubGVzcyBhbHJlYWR5IGluIGZsaWdodCwgd2Ugd2lsbCBlbnN1cmVTeW5jaHJvbml6ZWRUYWcgdG8gc3luY2hyb25pemUgaXQuXG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIGNvbnN0IHtvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0gPSB0aGlzO1xuICAgIHRoaXMubG9nKCdyZWNlaXZlZCBcImhhc2hcIicsIHt0YWcsIGhhc2gsIG91clRhZ3MsIHVuc3luY2hyb25pemVkfSk7XG4gICAgaWYgKHVuc3luY2hyb25pemVkLmhhcyh0YWcpKSByZXR1cm4gbnVsbDsgLy8gQWxyZWFkeSBoYXMgYW4gaW52ZXN0aWdhdGlvbiBpbiBwcm9ncmVzcyAoZS5nLCBkdWUgdG8gbG9jYWwgYXBwIHN5bmNocm9uaXphdGlvblByb21pc2UpLlxuICAgIGlmICghb3VyVGFncy5oYXModGFnKSkgcmV0dXJuIHRoaXMuZW5zdXJlU3luY2hyb25pemVkVGFnKHRhZywgaGFzaCk7IC8vIFdlIGRvbid0IGhhdmUgdGhlIHJlY29yZCBhdCBhbGwuXG4gICAgcmV0dXJuIHRoaXMuZW5zdXJlU3luY2hyb25pemVkVGFnKHRhZywgaGFzaCwgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG4gIGVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIHRoZWlySGFzaCA9ICcnLCBvdXJIYXNoUHJvbWlzZSA9IG51bGwpIHtcbiAgICAvLyBTeW5jaHJvbm91c2x5IHJlY29yZCAoaW4gdGhlIHVuc3luY2hyb25pemVkIG1hcCkgYSBwcm9taXNlIHRvIChjb25jZXB0dWFsbHkpIHJlcXVlc3QgdGhlIHRhZyBmcm9tIHRoZSBwZWVyLFxuICAgIC8vIHB1dCBpdCBpbiB0aGUgY29sbGVjdGlvbiwgYW5kIGNsZWFudXAgdGhlIGJvb2trZWVwaW5nLiBSZXR1cm4gdGhhdCBwcm9taXNlLlxuICAgIC8vIEhvd2V2ZXIsIGlmIHdlIGFyZSBnaXZlbiBoYXNoZXMgdG8gY29tcGFyZSBhbmQgdGhleSBtYXRjaCwgd2UgY2FuIHNraXAgdGhlIHJlcXVlc3QvcHV0IGFuZCByZW1vdmUgZnJvbSB1bnN5Y2hyb25pemVkIG9uIG5leHQgdGljay5cbiAgICAvLyAoVGhpcyBtdXN0IHJldHVybiBhdG9taWNhbGx5IGJlY2F1c2UgY2FsbGVyIGhhcyBjaGVja2VkIHZhcmlvdXMgYm9va2tlZXBpbmcgYXQgdGhhdCBtb21lbnQuIENoZWNraW5nIG1heSByZXF1aXJlIHRoYXQgd2UgYXdhaXQgb3VySGFzaFByb21pc2UuKVxuICAgIGNvbnN0IHByb21pc2UgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHNldFRpbWVvdXQoYXN5bmMgKCkgPT4geyAvLyBOZXh0IHRpY2suIFNlZSByZXF1ZXN0KCkuXG5cdGlmICghdGhlaXJIYXNoIHx8ICFvdXJIYXNoUHJvbWlzZSB8fCAodGhlaXJIYXNoICE9PSBhd2FpdCBvdXJIYXNoUHJvbWlzZSkpIHtcblx0ICBjb25zdCB0aGVpckRhdGEgPSBhd2FpdCB0aGlzLnJlcXVlc3QodGFnKTtcblx0ICAvLyBNaWdodCBoYXZlIGJlZW4gdHJpZ2dlcmVkIGJ5IG91ciBhcHAgcmVxdWVzdGluZyB0aGlzIHRhZyBiZWZvcmUgd2Ugd2VyZSBzeW5jJ2QuIFNvIHRoZXkgbWlnaHQgbm90IGhhdmUgdGhlIGRhdGEuXG5cdCAgaWYgKHRoZWlyRGF0YT8ubGVuZ3RoKSB7XG5cdCAgICBpZiAoYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnB1dCh0YWcsIHRoZWlyRGF0YSwgdGhpcykpIHtcblx0ICAgICAgdGhpcy5sb2coJ3JlY2VpdmVkL3B1dCcsIHRhZywgJ3RoZWlyL291ciBoYXNoOicsIHRoZWlySGFzaCB8fCAnbWlzc2luZ1RoZWlycycsIChhd2FpdCBvdXJIYXNoUHJvbWlzZSkgfHwgJ21pc3NpbmdPdXJzJywgdGhlaXJEYXRhPy5sZW5ndGgpO1xuXHQgICAgfSBlbHNlIHtcblx0ICAgICAgdGhpcy5sb2coJ3VuYWJsZSB0byBwdXQnLCB0YWcpO1xuXHQgICAgfVxuXHQgIH1cblx0fVxuXHR0aGlzLmNoZWNrZWRUYWdzLmFkZCh0YWcpOyAgICAgICAvLyBFdmVyeXRoaW5nIHdlJ3ZlIGV4YW1pbmVkLCByZWdhcmRsZXNzIG9mIHdoZXRoZXIgd2UgYXNrZWQgZm9yIG9yIHNhdmVkIGRhdGEgZnJvbSBwZWVyLiAoU2VlIHN5bmNocm9uaXphdGlvblByb21pc2UpXG5cdHRoaXMudW5zeW5jaHJvbml6ZWQuZGVsZXRlKHRhZyk7IC8vIFVuY29uZGl0aW9uYWxseSwgYmVjYXVzZSB3ZSBzZXQgaXQgdW5jb25kaXRpb25hbGx5LlxuXHR0aGlzLmNsZWFuVXBJZkZpbmlzaGVkKCk7XG5cdHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMudW5zeW5jaHJvbml6ZWQuc2V0KHRhZywgcHJvbWlzZSk7IC8vIFVuY29uZGl0aW9uYWxseSwgaW4gY2FzZSB3ZSBuZWVkIHRvIGtub3cgd2UncmUgbG9va2luZyBkdXJpbmcgdGhlIHRpbWUgd2UncmUgbG9va2luZy5cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXF1ZXN0KHRhZykgeyAvLyBNYWtlIGEgcmVxdWVzdCBmb3IgdGFnIGZyb20gdGhlIHBlZXIsIGFuZCBhbnN3ZXIgYSBwcm9taXNlIHRoZSByZXNvbHZlcyB3aXRoIHRoZSBkYXRhLlxuICAgIC8qY29uc3QgeyBob3N0UmVxdWVzdEJhc2UgfSA9IHRoaXM7XG4gICAgaWYgKGhvc3RSZXF1ZXN0QmFzZSkge1xuICAgICAgLy8gRS5nLiwgYSBsb2NhbGhvc3Qgcm91dGVyIG1pZ2h0IHN1cHBvcnQgYSBnZXQgb2YgaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyL190L3VML0JBY1dfTE5BSmEvY0pXbXVtYmxlXG4gICAgICAvLyBTbyBob3N0UmVxdWVzdEJhc2Ugc2hvdWxkIGJlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyXCIsXG4gICAgICAvLyBhbmQgc2VydmljZU5hbWUgc2hvdWxkIGJlIHNvbWV0aGluZyBsaWtlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9zeW5jXCJcbiAgICAgIHJldHVybiBmZXRjaCh0YWdQYXRoKGhvc3RSZXF1ZXN0QmFzZSwgdGFnKSkudGhlbihyZXNwb25zZSA9PiByZXNwb25zZS50ZXh0KCkpO1xuICAgIH0qL1xuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UodGhpcy5zZW5kKCdnZXQnLCB0YWcpKTtcbiAgICAvLyBTdWJ0bGU6IFdoZW4gdGhlICdwdXQnIGNvbWVzIGJhY2ssIHdlIHdpbGwgbmVlZCB0byByZXNvbHZlIHRoaXMgcHJvbWlzZS4gQnV0IGhvdyB3aWxsICdwdXQnIGZpbmQgdGhlIHByb21pc2UgdG8gcmVzb2x2ZSBpdD9cbiAgICAvLyBBcyBpdCB0dXJucyBvdXQsIHRvIGdldCBoZXJlLCB3ZSBoYXZlIG5lY2Vzc2FyaWxseSBzZXQgdGFnIGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXAuIFxuICAgIGNvbnN0IG5vdGVkID0gdGhpcy51bnN5bmNocm9uaXplZC5nZXQodGFnKTsgLy8gQSBwcm9taXNlIHRoYXQgZG9lcyBub3QgaGF2ZSBhbiBleHBvc2VkIC5yZXNvbHZlLCBhbmQgd2hpY2ggZG9lcyBub3QgZXhwZWN0IGFueSB2YWx1ZS5cbiAgICBub3RlZC5yZXNvbHZlID0gcHJvbWlzZS5yZXNvbHZlOyAvLyBUYWNrIG9uIGEgcmVzb2x2ZSBmb3IgT1VSIHByb21pc2Ugb250byB0aGUgbm90ZWQgb2JqZWN0ICh3aGljaCBjb25mdXNpbmdseSwgaGFwcGVucyB0byBiZSBhIHByb21pc2UpLlxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gUmVzcG9uZCB0byBhIHBlZXIncyBnZXQoKSByZXF1ZXN0IGJ5IHNlbmRpbmcgYSBwdXQgcmVwb25zZSB3aXRoIHRoZSBkYXRhLlxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gICAgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIGRhdGEpO1xuICB9XG4gIHB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSkgeyAvLyBUZWxsIHRoZSBvdGhlciBzaWRlIGFib3V0IGEgc2lnbmVkIHdyaXRlLlxuICAgIHRoaXMuc2VuZChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKTtcbiAgfVxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUpIHsgLy8gUmVjZWl2ZSBhIHB1dCBtZXNzYWdlIGZyb20gdGhlIHBlZXIuXG4gICAgLy8gSWYgaXQgaXMgYSByZXNwb25zZSB0byBhIGdldCgpIHJlcXVlc3QsIHJlc29sdmUgdGhlIGNvcnJlc3BvbmRpbmcgcHJvbWlzZS5cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy51bnN5bmNocm9uaXplZD8uZ2V0KHRhZyk7XG4gICAgLy8gUmVnYXJkbGVzcyBvZiB3aHkgdGhlIG90aGVyIHNpZGUgaXMgc2VuZGluZywgaWYgd2UgaGF2ZSBhbiBvdXRzdGFuZGluZyByZXF1ZXN0LCBjb21wbGV0ZSBpdC5cbiAgICBpZiAocHJvbWlzZSkgcHJvbWlzZS5yZXNvbHZlKHNpZ25hdHVyZSk7XG4gICAgZWxzZSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24ucHV0KHRhZywgc2lnbmF0dXJlLCB0aGlzKTsgLy8gT3RoZXJ3aXNlLCBqdXN0IHRyeSB0byB3cml0ZSBpdCBsb2NhbGx5LlxuICB9XG4gIGRlbGV0ZSh0YWcsIHNpZ25hdHVyZSkgeyAvLyBSZWNlaXZlIGEgZGVsZXRlIG1lc3NhZ2UgZnJvbSB0aGUgcGVlci5cbiAgICB0aGlzLmNvbGxlY3Rpb24uZGVsZXRlKHRhZywgc2lnbmF0dXJlLCB0aGlzKTtcbiAgfVxufVxuZXhwb3J0IGRlZmF1bHQgU3luY2hyb25pemVyO1xuIiwiY2xhc3MgQ2FjaGUgZXh0ZW5kcyBNYXB7Y29uc3RydWN0b3IoZSx0PTApe3N1cGVyKCksdGhpcy5tYXhTaXplPWUsdGhpcy5kZWZhdWx0VGltZVRvTGl2ZT10LHRoaXMuX25leHRXcml0ZUluZGV4PTAsdGhpcy5fa2V5TGlzdD1BcnJheShlKSx0aGlzLl90aW1lcnM9bmV3IE1hcH1zZXQoZSx0LHM9dGhpcy5kZWZhdWx0VGltZVRvTGl2ZSl7bGV0IGk9dGhpcy5fbmV4dFdyaXRlSW5kZXg7dGhpcy5kZWxldGUodGhpcy5fa2V5TGlzdFtpXSksdGhpcy5fa2V5TGlzdFtpXT1lLHRoaXMuX25leHRXcml0ZUluZGV4PShpKzEpJXRoaXMubWF4U2l6ZSx0aGlzLl90aW1lcnMuaGFzKGUpJiZjbGVhclRpbWVvdXQodGhpcy5fdGltZXJzLmdldChlKSksc3VwZXIuc2V0KGUsdCkscyYmdGhpcy5fdGltZXJzLnNldChlLHNldFRpbWVvdXQoKCgpPT50aGlzLmRlbGV0ZShlKSkscykpfWRlbGV0ZShlKXtyZXR1cm4gdGhpcy5fdGltZXJzLmhhcyhlKSYmY2xlYXJUaW1lb3V0KHRoaXMuX3RpbWVycy5nZXQoZSkpLHRoaXMuX3RpbWVycy5kZWxldGUoZSksc3VwZXIuZGVsZXRlKGUpfWNsZWFyKGU9dGhpcy5tYXhTaXplKXt0aGlzLm1heFNpemU9ZSx0aGlzLl9rZXlMaXN0PUFycmF5KGUpLHRoaXMuX25leHRXcml0ZUluZGV4PTAsc3VwZXIuY2xlYXIoKTtmb3IoY29uc3QgZSBvZiB0aGlzLl90aW1lcnMudmFsdWVzKCkpY2xlYXJUaW1lb3V0KGUpO3RoaXMuX3RpbWVycy5jbGVhcigpfX1jbGFzcyBTdG9yYWdlQmFzZXtjb25zdHJ1Y3Rvcih7bmFtZTplLGJhc2VOYW1lOnQ9XCJTdG9yYWdlXCIsbWF4U2VyaWFsaXplclNpemU6cz0xZTMsZGVidWc6aT0hMX0pe2NvbnN0IGE9YCR7dH0vJHtlfWAscj1uZXcgQ2FjaGUocyk7T2JqZWN0LmFzc2lnbih0aGlzLHtuYW1lOmUsYmFzZU5hbWU6dCxmdWxsTmFtZTphLGRlYnVnOmksc2VyaWFsaXplcjpyfSl9YXN5bmMgbGlzdCgpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShcIlwiLCgoZSx0KT0+dGhpcy5saXN0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGdldChlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZ2V0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGRlbGV0ZShlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZGVsZXRlSW50ZXJuYWwodCxlKSkpfWFzeW5jIHB1dChlLHQpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSxzKT0+dGhpcy5wdXRJbnRlcm5hbChzLHQsZSkpKX1sb2coLi4uZSl7dGhpcy5kZWJ1ZyYmY29uc29sZS5sb2codGhpcy5uYW1lLC4uLmUpfWFzeW5jIHNlcmlhbGl6ZShlLHQpe2NvbnN0e3NlcmlhbGl6ZXI6cyxyZWFkeTppfT10aGlzO2xldCBhPXMuZ2V0KGUpfHxpO3JldHVybiBhPWEudGhlbigoYXN5bmMoKT0+dChhd2FpdCB0aGlzLnJlYWR5LHRoaXMucGF0aChlKSkpKSxzLnNldChlLGEpLGF3YWl0IGF9fWNvbnN0e1Jlc3BvbnNlOmUsVVJMOnR9PWdsb2JhbFRoaXM7Y2xhc3MgU3RvcmFnZUNhY2hlIGV4dGVuZHMgU3RvcmFnZUJhc2V7Y29uc3RydWN0b3IoLi4uZSl7c3VwZXIoLi4uZSksdGhpcy5zdHJpcHBlcj1uZXcgUmVnRXhwKGBeLyR7dGhpcy5mdWxsTmFtZX0vYCksdGhpcy5yZWFkeT1jYWNoZXMub3Blbih0aGlzLmZ1bGxOYW1lKX1hc3luYyBsaXN0SW50ZXJuYWwoZSx0KXtyZXR1cm4oYXdhaXQgdC5rZXlzKCl8fFtdKS5tYXAoKGU9PnRoaXMudGFnKGUudXJsKSkpfWFzeW5jIGdldEludGVybmFsKGUsdCl7Y29uc3Qgcz1hd2FpdCB0Lm1hdGNoKGUpO3JldHVybiBzPy5qc29uKCl9ZGVsZXRlSW50ZXJuYWwoZSx0KXtyZXR1cm4gdC5kZWxldGUoZSl9cHV0SW50ZXJuYWwodCxzLGkpe3JldHVybiBpLnB1dCh0LGUuanNvbihzKSl9cGF0aChlKXtyZXR1cm5gLyR7dGhpcy5mdWxsTmFtZX0vJHtlfWB9dGFnKGUpe3JldHVybiBuZXcgdChlKS5wYXRobmFtZS5yZXBsYWNlKHRoaXMuc3RyaXBwZXIsXCJcIil9ZGVzdHJveSgpe3JldHVybiBjYWNoZXMuZGVsZXRlKHRoaXMuZnVsbE5hbWUpfX1leHBvcnR7U3RvcmFnZUNhY2hlIGFzIFN0b3JhZ2VMb2NhbCxTdG9yYWdlQ2FjaGUgYXMgZGVmYXVsdH07XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgeyBTdG9yYWdlTG9jYWwgfSBmcm9tICdAa2kxcjB5L3N0b3JhZ2UnO1xuaW1wb3J0IFN5bmNocm9uaXplciBmcm9tICcuL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5jb25zdCB7IEN1c3RvbUV2ZW50LCBFdmVudFRhcmdldCwgVGV4dERlY29kZXIgfSA9IGdsb2JhbFRoaXM7XG5cbi8vIFRPRE8/OiBTaG91bGQgdmVyZmllZC92YWxpZGF0ZWQgYmUgaXRzIG93biBvYmplY3Qgd2l0aCBtZXRob2RzP1xuXG5leHBvcnQgY2xhc3MgQ29sbGVjdGlvbiBleHRlbmRzIEV2ZW50VGFyZ2V0IHtcblxuICBjb25zdHJ1Y3Rvcih7bmFtZSwgbGFiZWwgPSBuYW1lLCBzZXJ2aWNlcyA9IFtdLCBwcmVzZXJ2ZURlbGV0aW9ucyA9ICEhc2VydmljZXMubGVuZ3RoLFxuXHQgICAgICAgcGVyc2lzdGVuY2VDbGFzcyA9IFN0b3JhZ2VMb2NhbCwgZGJWZXJzaW9uID0gc3RvcmFnZVZlcnNpb24sIHBlcnNpc3RlbmNlQmFzZSA9IGAke3N0b3JhZ2VOYW1lfV8ke2RiVmVyc2lvbn1gLFxuXHQgICAgICAgZGVidWcgPSBmYWxzZSwgbXVsdGlwbGV4LCAvLyBDYXVzZXMgc3luY2hyb25pemF0aW9uIHRvIHJldXNlIGNvbm5lY3Rpb25zIGZvciBkaWZmZXJlbnQgQ29sbGVjdGlvbnMgb24gdGhlIHNhbWUgc2VydmljZS5cblx0ICAgICAgIGNoYW5uZWxOYW1lLCBzZXJ2aWNlTGFiZWwsIHJlc3RyaWN0ZWRUYWdzfSkge1xuICAgIHN1cGVyKCk7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLCB7bmFtZSwgbGFiZWwsIHByZXNlcnZlRGVsZXRpb25zLCBwZXJzaXN0ZW5jZUNsYXNzLCBkYlZlcnNpb24sIG11bHRpcGxleCwgZGVidWcsIGNoYW5uZWxOYW1lLCBzZXJ2aWNlTGFiZWwsXG5cdFx0XHQgZnVsbE5hbWU6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtuYW1lfWAsIGZ1bGxMYWJlbDogYCR7dGhpcy5jb25zdHJ1Y3Rvci5uYW1lfS8ke2xhYmVsfWB9KTtcbiAgICBpZiAocmVzdHJpY3RlZFRhZ3MpIHRoaXMucmVzdHJpY3RlZFRhZ3MgPSByZXN0cmljdGVkVGFncztcbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTtcbiAgICBjb25zdCBwZXJzaXN0ZW5jZU9wdGlvbnMgPSB7bmFtZTogdGhpcy5mdWxsTGFiZWwsIGJhc2VOYW1lOiBwZXJzaXN0ZW5jZUJhc2UsIGRlYnVnOiBkZWJ1Z307XG4gICAgaWYgKHBlcnNpc3RlbmNlQ2xhc3MudGhlbikgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gcGVyc2lzdGVuY2VDbGFzcy50aGVuKGtpbmQgPT4gbmV3IGtpbmQocGVyc2lzdGVuY2VPcHRpb25zKSk7XG4gICAgZWxzZSB0aGlzLnBlcnNpc3RlbmNlU3RvcmUgPSBuZXcgcGVyc2lzdGVuY2VDbGFzcyhwZXJzaXN0ZW5jZU9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgY2xvc2UoKSB7XG4gICAgYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IHRoaXMuZGlzY29ubmVjdCgpO1xuICAgIGNvbnN0IHN0b3JlID0gYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIGRlbGV0ZSB0aGlzLnBlcnNpc3RlbmNlU3RvcmU7XG4gICAgaWYgKHN0b3JlKSBhd2FpdCBzdG9yZS5kZXN0cm95KCk7XG4gIH1cblxuICBzdGF0aWMgZXJyb3IoZXJyb3IpIHsgLy8gQ2FuIGJlIG92ZXJyaWRkZW4gYnkgdGhlIGNsaWVudFxuICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xuICB9XG4gIC8vIENyZWRlbnRpYWxzLnNpZ24vLnZlcmlmeSBjYW4gcHJvZHVjZS9hY2NlcHQgSlNPTiBPQkpFQ1RTIGZvciB0aGUgbmFtZWQgXCJKU09OIFNlcmlhbGl6YXRpb25cIiBmb3JtLlxuICAvLyBBcyBpdCBoYXBwZW5zLCBkaXN0cmlidXRlZC1zZWN1cml0eSBjYW4gZGlzdGluZ3Vpc2ggYmV0d2VlbiBhIGNvbXBhY3Qgc2VyaWFsaXphdGlvbiAoYmFzZTY0IHRleHQpXG4gIC8vIHZzIGFuIG9iamVjdCwgYnV0IGl0IGRvZXMgbm90IHJlY29nbml6ZSBhIFNFUklBTElaRUQgb2JqZWN0LiBIZXJlIHdlIGJvdHRsZW5lY2sgdGhvc2Ugb3BlcmF0aW9uc1xuICAvLyBzdWNoIHRoYXQgdGhlIHRoaW5nIHRoYXQgaXMgYWN0dWFsbHkgcGVyc2lzdGVkIGFuZCBzeW5jaHJvbml6ZWQgaXMgYWx3YXlzIGEgc3RyaW5nIC0tIGVpdGhlciBiYXNlNjRcbiAgLy8gY29tcGFjdCBvciBKU09OIGJlZ2lubmluZyB3aXRoIGEgXCJ7XCIgKHdoaWNoIGFyZSBkaXN0aW5ndWlzaGFibGUgYmVjYXVzZSBcIntcIiBpcyBub3QgYSBiYXNlNjQgY2hhcmFjdGVyKS5cbiAgc3RhdGljIGVuc3VyZVN0cmluZyhzaWduYXR1cmUpIHsgLy8gUmV0dXJuIGEgc2lnbmF0dXJlIHRoYXQgaXMgZGVmaW5hdGVseSBhIHN0cmluZy5cbiAgICBpZiAodHlwZW9mKHNpZ25hdHVyZSkgIT09ICdzdHJpbmcnKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkoc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gc2lnbmF0dXJlO1xuICB9XG4gIC8vIFJldHVybiBhIGNvbXBhY3Qgb3IgXCJKU09OXCIgKG9iamVjdCkgZm9ybSBvZiBzaWduYXR1cmUgKGluZmxhdGluZyBhIHNlcmlhbGl6YXRpb24gb2YgdGhlIGxhdHRlciBpZiBuZWVkZWQpLCBidXQgbm90IGEgSlNPTiBzdHJpbmcuXG4gIHN0YXRpYyBtYXliZUluZmxhdGUoc2lnbmF0dXJlKSB7XG4gICAgaWYgKHNpZ25hdHVyZT8uc3RhcnRzV2l0aD8uKFwie1wiKSkgcmV0dXJuIEpTT04ucGFyc2Uoc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gc2lnbmF0dXJlO1xuICB9XG4gIC8vIFRoZSB0eXBlIG9mIEpXRSB0aGF0IGdldHMgc2lnbmVkIChub3QgdGhlIGN0eSBvZiB0aGUgSldFKS4gV2UgYXV0b21hdGljYWxseSB0cnkgdG8gZGVjcnlwdCBhIEpXUyBwYXlsb2FkIG9mIHRoaXMgdHlwZS5cbiAgc3RhdGljIGVuY3J5cHRlZE1pbWVUeXBlID0gJ3RleHQvZW5jcnlwdGVkJztcbiAgc3RhdGljIGFzeW5jIGVuc3VyZURlY3J5cHRlZCh2ZXJpZmllZCkgeyAvLyBQcm9taXNlIHZlcmZpZWQgYWZ0ZXIgZmlyc3QgYXVnbWVudGluZyB3aXRoIGRlY3J5cHRlZCBkYXRhIGFzIG5lZWRlZC5cbiAgICBpZiAodmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmN0eSAhPT0gdGhpcy5lbmNyeXB0ZWRNaW1lVHlwZSkgcmV0dXJuIHZlcmlmaWVkO1xuICAgIGlmICh2ZXJpZmllZC5kZWNyeXB0ZWQpIHJldHVybiB2ZXJpZmllZDsgLy8gQWxyZWFkeSBkZWNyeXB0ZWQuXG4gICAgY29uc3QgZGVjcnlwdGVkID0gYXdhaXQgQ3JlZGVudGlhbHMuZGVjcnlwdCh2ZXJpZmllZC50ZXh0KTtcbiAgICB2ZXJpZmllZC5qc29uID0gZGVjcnlwdGVkLmpzb247XG4gICAgdmVyaWZpZWQudGV4dCA9IGRlY3J5cHRlZC50ZXh0O1xuICAgIHZlcmlmaWVkLnBheWxvYWQgPSBkZWNyeXB0ZWQucGF5bG9hZDtcbiAgICB2ZXJpZmllZC5kZWNyeXB0ZWQgPSBkZWNyeXB0ZWQ7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG5cbiAgLy8gVE9ETz86IFRoZXNlIHRha2UgU2VjdXJpdHktc3R5bGUgdGVhbS9tZW1iZXIsIHdoaWxlIGV2ZXJ5dGhpbmcgZWxzZSBoZXJlIHRha2VzIG93bmVyL2F1dGhvci5cbiAgYXN5bmMgc2lnbihkYXRhLCBvcHRpb25zKSB7XG4gICAgLy8gSWYgdGhpcyBjb2xsZWN0aW9uIHJlc3RyaWN0cyB1c2FibGUgdGFncyBmb3IgdGVzdGluZywgdGhlbiBkbyBzby5cbiAgICBpZiAoJ3Jlc3RyaWN0ZWRUYWdzJyBpbiB0aGlzKSB7XG4gICAgICBsZXQgb2xkSG9vayA9IENyZWRlbnRpYWxzLmdldFVzZXJEZXZpY2VTZWNyZXQ7XG4gICAgICB0cnkge1xuXHRDcmVkZW50aWFscy5nZXRVc2VyRGV2aWNlU2VjcmV0ID0gKHRhZywgcHJvbXB0U3RyaW5nKSA9PiB7XG5cdCAgaWYgKCF0aGlzLnJlc3RyaWN0ZWRUYWdzLmhhcyh0YWcpKSByZXR1cm4gJ2JvZ3VzJztcblx0ICByZXR1cm4gb2xkSG9vayh0YWcsIHByb21wdFN0cmluZyk7XG5cdH07XG5cdGF3YWl0IENyZWRlbnRpYWxzLmNsZWFyKCk7XG5cdHJldHVybiBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oZGF0YSwgb3B0aW9ucyk7XG4gICAgICB9IGZpbmFsbHkge1xuXHRDcmVkZW50aWFscy5nZXRVc2VyRGV2aWNlU2VjcmV0ID0gb2xkSG9vaztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3Iuc2lnbihkYXRhLCBvcHRpb25zKTtcbiAgfVxuICBzdGF0aWMgYXN5bmMgc2lnbihkYXRhLCBvcHRpb25zKSB7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgQ3JlZGVudGlhbHMuc2lnbihkYXRhLCBvcHRpb25zKTtcbiAgICByZXR1cm4gdGhpcy5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgc2lnbmF0dXJlID0gdGhpcy5tYXliZUluZmxhdGUoc2lnbmF0dXJlKTtcbiAgICAvLyBXZSBkb24ndCBkbyBcImRlZXBcIiB2ZXJpZmljYXRpb24gaGVyZSAtIGUuZy4sIGNoZWNraW5nIHRoYXQgdGhlIGFjdCBpcyBhIG1lbWJlciBvZiBpc3MsIGFuZCB0aGUgaWF0IGlzIGFmdGVyIHRoZSBleGlzdGluZyBpYXQuXG4gICAgLy8gSW5zdGVhZCwgd2UgZG8gb3VyIG93biBkZWVwIGNoZWNrcyBpbiB2YWxpZGF0ZUZvcldyaXRpbmcuXG4gICAgLy8gVGhlIG1lbWJlci9ub3RCZWZvcmUgc2hvdWxkIGNoZWNrIG91dCBhbnl3YXkgLS0gaS5lLiwgd2UgY291bGQgbGVhdmUgaXQgaW4sIGV4Y2VwdCBpbiBzeW5jaHJvbml6aW5nXG4gICAgLy8gQ3JlZGVudGlhbC5jb2xsZWN0aW9ucy4gVGhlcmUgaXMgbm8gbWVjaGFuaXNtIChjdXJyZW50bHkpIGZvciB0aGVcbiAgICAvLyBzeW5jaHJvbml6YXRpb24gdG8gaGFwcGVuIGluIGFuIG9yZGVyIHRoYXQgd2lsbCByZXN1bHQgaW4gdGhlIGRlcGVuZGVuY2llcyBjb21pbmcgb3ZlciBiZWZvcmUgdGhlIGl0ZW1zIHRoYXQgY29uc3VtZSB0aGVtLlxuICAgIGNvbnN0IHZlcmlmaWVkID0gIGF3YWl0IENyZWRlbnRpYWxzLnZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMpO1xuICAgIGlmICh2ZXJpZmllZCkgdmVyaWZpZWQuc2lnbmF0dXJlID0gc2lnbmF0dXJlO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICAvLyBzdGF0aWMgYXN5bmMgdmFsaWRhdGlvbkZvcm1hdChzaWduYXR1cmUsIHRhZyA9IG51bGwpIHtcbiAgLy8gICAvL2NvbnNvbGUubG9nKHt0eXBlOiB0eXBlb2Yoc2lnbmF0dXJlKSwgc2lnbmF0dXJlLCB0YWd9KTtcbiAgLy8gICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMudmVyaWZ5KHNpZ25hdHVyZSk7XG4gIC8vICAgaWYgKCF2ZXJpZmllZC50YWcpIGNvbnNvbGUuZXJyb3IoXCJcXG5cXG5cXG4qKiogbWlzc2luZyB0YWcgKioqXFxuXFxuXCIpO1xuICAvLyAgIC8vIE9ic29sZXRlP1xuICAvLyAgIC8vIGNvbnN0IHN1YiA9IHZlcmlmaWVkLnN1YmplY3RUYWcgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICAvLyAgIC8vIHZlcmlmaWVkLnRhZyA9IHRhZyB8fCBzdWI7XG4gIC8vICAgcmV0dXJuIHZlcmlmaWVkO1xuICAvLyB9XG5cbiAgYXN5bmMgdW5kZWxldGVkVGFncygpIHtcbiAgICAvLyBPdXIgb3duIHNlcGFyYXRlLCBvbi1kZW1hbmQgYWNjb3VudGluZyBvZiBwZXJzaXN0ZW5jZVN0b3JlIGxpc3QoKTpcbiAgICAvLyAgIC0gcGVyc2lzdGVuY2VTdG9yZSBsaXN0KCkgY291bGQgcG90ZW50aWFsbHkgYmUgZXhwZW5zaXZlXG4gICAgLy8gICAtIEl0IHdpbGwgY29udGFpbiBzb2Z0LWRlbGV0ZWQgaXRlbSB0b21ic3RvbmVzIChzaWduZWQgZW1wdHkgcGF5bG9hZHMpLlxuICAgIC8vIEl0IHN0YXJ0cyB3aXRoIGEgbGlzdCgpIHRvIGdldCBhbnl0aGluZyBwZXJzaXN0ZWQgaW4gYSBwcmV2aW91cyBzZXNzaW9uLCBhbmQgYWRkcy9yZW1vdmVzIGFzIHdlIHN0b3JlL3JlbW92ZS5cbiAgICBjb25zdCBhbGxUYWdzID0gYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkubGlzdCgpO1xuICAgIGNvbnN0IHRhZ3MgPSBuZXcgU2V0KCk7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoYWxsVGFncy5tYXAoYXN5bmMgdGFnID0+IHtcbiAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnLCBzeW5jaHJvbml6ZTogZmFsc2V9KTtcbiAgICAgIGlmICh2ZXJpZmllZCkgdGFncy5hZGQodGFnKTtcbiAgICB9KSk7XG4gICAgcmV0dXJuIHRhZ3M7XG4gIH1cbiAgZ2V0IHRhZ3MoKSB7IC8vIEtlZXBzIHRyYWNrIG9mIG91ciAodW5kZWxldGVkKSBrZXlzLlxuICAgIHJldHVybiB0aGlzLl90YWdzUHJvbWlzZSB8fD0gdGhpcy51bmRlbGV0ZWRUYWdzKCk7XG4gIH1cbiAgYXN5bmMgYWRkVGFnKHRhZykge1xuICAgIChhd2FpdCB0aGlzLnRhZ3MpLmFkZCh0YWcpO1xuICB9XG4gIGFzeW5jIGRlbGV0ZVRhZyh0YWcpIHtcbiAgICAoYXdhaXQgdGhpcy50YWdzKS5kZWxldGUodGFnKTtcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKCF0aGlzLmRlYnVnKSByZXR1cm47XG4gICAgY29uc29sZS5sb2codGhpcy5mdWxsTGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIF9jYW5vbmljYWxpemVPcHRpb25zMSh0YWdPck9wdGlvbnMgPSB7fSkge1xuICAgIHJldHVybiAodHlwZW9mKHRhZ09yT3B0aW9ucykgPT09ICdzdHJpbmcnKSA/IHt0YWc6dGFnT3JPcHRpb25zfSA6IHRhZ09yT3B0aW9ucztcbiAgfVxuICBfY2Fub25pY2FsaXplT3B0aW9ucyhvYmplY3RPclN0cmluZyA9IHt9KSB7XG4gICAgY29uc3Qge293bmVyOnRlYW0gPSBDcmVkZW50aWFscy5vd25lciwgYXV0aG9yOm1lbWJlciA9IENyZWRlbnRpYWxzLmF1dGhvcixcblx0ICAgdGFnLFxuXHQgICBlbmNyeXB0aW9uID0gQ3JlZGVudGlhbHMuZW5jcnlwdGlvbixcblx0ICAgdGltZSA9IERhdGUubm93KCksXG5cdCAgIC4uLnJlc3R9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEob2JqZWN0T3JTdHJpbmcpO1xuICAgIC8vIFRPRE86IHN1cHBvcnQgc2ltcGxpZmllZCBzeW50YXgsIHRvbywgcGVyIFJFQURNRVxuICAgIC8vIFRPRE86IHNob3VsZCB3ZSBzcGVjaWZ5IHN1YmplY3Q6IHRhZyBmb3IgYm90aCBtdXRhYmxlcz8gKGdpdmVzIGhhc2gpXG4gICAgY29uc3Qgb3B0aW9ucyA9ICh0ZWFtICYmIHRlYW0gIT09IG1lbWJlcikgP1xuXHQgIHt0ZWFtLCBtZW1iZXIsIHRhZywgZW5jcnlwdGlvbiwgdGltZSwgLi4ucmVzdH0gOlxuXHQgIHt0YWdzOiBbbWVtYmVyXSwgdGFnLCB0aW1lLCBlbmNyeXB0aW9uLCAuLi5yZXN0fTsgLy8gTm8gaWF0IGlmIHRpbWUgbm90IGV4cGxpY2l0bHkgZ2l2ZW4uXG4gICAgaWYgKFt0cnVlLCAndGVhbScsICdvd25lciddLmluY2x1ZGVzKG9wdGlvbnMuZW5jcnlwdGlvbikpIG9wdGlvbnMuZW5jcnlwdGlvbiA9IHRlYW07XG4gICAgcmV0dXJuIG9wdGlvbnM7XG4gIH1cbiAgZmFpbChvcGVyYXRpb24sIGRhdGEsIGF1dGhvcikge1xuICAgIHRocm93IG5ldyBFcnJvcihgJHthdXRob3J9IGRvZXMgbm90IGhhdmUgdGhlIGF1dGhvcml0eSB0byAke29wZXJhdGlvbn0gJHt0aGlzLmZ1bGxOYW1lfSAke0pTT04uc3RyaW5naWZ5KGRhdGEpfS5gKTtcbiAgfVxuICBhc3luYyBzdG9yZShkYXRhLCBvcHRpb25zID0ge30pIHtcbiAgICAvLyBlbmNyeXB0IGlmIG5lZWRlZFxuICAgIC8vIHNpZ25cbiAgICAvLyBwdXQgPD09IEFsc28gd2hlcmUgd2UgZW50ZXIgaWYgcHVzaGVkIGZyb20gYSBjb25uZWN0aW9uXG4gICAgLy8gICAgdmFsaWRhdGVGb3JXcml0aW5nXG4gICAgLy8gICAgICAgZXhpdCBpZiBpbXByb3BlclxuICAgIC8vICAgICAgIGVtaXQgdXBkYXRlIGV2ZW50XG4gICAgLy8gICAgbWVyZ2VTaWduYXR1cmVzXG4gICAgLy8gICAgcGVyc2lzdCBsb2NhbGx5XG4gICAgLy8gcHVzaCAobGl2ZSB0byBhbnkgY29ubmVjdGlvbnMgZXhjZXB0IHRoZSBvbmUgd2UgcmVjZWl2ZWQgZnJvbSlcbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTtcbiAgICBpZiAoZW5jcnlwdGlvbikge1xuICAgICAgZGF0YSA9IGF3YWl0IENyZWRlbnRpYWxzLmVuY3J5cHQoZGF0YSwgZW5jcnlwdGlvbik7XG4gICAgICBzaWduaW5nT3B0aW9ucy5jb250ZW50VHlwZSA9IHRoaXMuY29uc3RydWN0b3IuZW5jcnlwdGVkTWltZVR5cGU7XG4gICAgfVxuICAgIC8vIE5vIG5lZWQgdG8gYXdhaXQgc3luY2hyb25pemF0aW9uLlxuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuc2lnbihkYXRhLCBzaWduaW5nT3B0aW9ucyk7XG4gICAgdGFnID0gYXdhaXQgdGhpcy5wdXQodGFnLCBzaWduYXR1cmUpO1xuICAgIGlmICghdGFnKSByZXR1cm4gdGhpcy5mYWlsKCdzdG9yZScsIGRhdGEsIHNpZ25pbmdPcHRpb25zLm1lbWJlciB8fCBzaWduaW5nT3B0aW9ucy50YWdzWzBdKTtcbiAgICBhd2FpdCB0aGlzLnB1c2goJ3B1dCcsIHRhZywgc2lnbmF0dXJlKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIHB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSwgZXhjbHVkZVN5bmNocm9uaXplciA9IG51bGwpIHsgLy8gUHVzaCB0byBhbGwgY29ubmVjdGVkIHN5bmNocm9uaXplcnMsIGV4Y2x1ZGluZyB0aGUgc3BlY2lmaWVkIG9uZS5cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwodGhpcy5tYXBTeW5jaHJvbml6ZXJzKHN5bmNocm9uaXplciA9PiAoZXhjbHVkZVN5bmNocm9uaXplciAhPT0gc3luY2hyb25pemVyKSAmJiBzeW5jaHJvbml6ZXIucHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKSkpO1xuICB9XG4gIGFzeW5jIHJlbW92ZShvcHRpb25zID0ge30pIHsgLy8gTm90ZTogUmVhbGx5IGp1c3QgcmVwbGFjaW5nIHdpdGggZW1wdHkgZGF0YSBmb3JldmVyLiBPdGhlcndpc2UgbWVyZ2luZyB3aXRoIGVhcmxpZXIgZGF0YSB3aWxsIGJyaW5nIGl0IGJhY2shXG4gICAgbGV0IHtlbmNyeXB0aW9uLCB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7XG4gICAgY29uc3QgZGF0YSA9ICcnO1xuICAgIC8vIE5vIG5lZWQgdG8gYXdhaXQgc3luY2hyb25pemF0aW9uXG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5zaWduKGRhdGEsIHtzdWJqZWN0OiB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSk7XG4gICAgdGFnID0gYXdhaXQgdGhpcy5kZWxldGUodGFnLCBzaWduYXR1cmUpO1xuICAgIGlmICghdGFnKSByZXR1cm4gdGhpcy5mYWlsKCdyZW1vdmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gZ2V0VmVyaWZpZWQgYW5kIG1heWJlIGRlY3J5cHQuIEhhcyBtb3JlIGNvbXBsZXggYmVoYXZpb3IgaW4gc3ViY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbi5cbiAgICBjb25zdCB7dGFnLCBkZWNyeXB0ID0gdHJ1ZSwgLi4ub3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zMSh0YWdPck9wdGlvbnMpO1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnLCAuLi5vcHRpb25zfSk7XG4gICAgaWYgKCF2ZXJpZmllZCkgcmV0dXJuICcnO1xuICAgIGlmIChkZWNyeXB0KSByZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBnZXRWZXJpZmllZCh0YWdPck9wdGlvbnMpIHsgLy8gc3luY2hyb25pemUsIGdldCwgYW5kIHZlcmlmeSAoYnV0IHdpdGhvdXQgZGVjcnlwdClcbiAgICBjb25zdCB7dGFnLCBzeW5jaHJvbml6ZSA9IHRydWUsIC4uLnZlcmlmeU9wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zKTtcbiAgICBpZiAoc3luY2hyb25pemUpIGF3YWl0IHRoaXMuc3luY2hyb25pemUxKHRhZyk7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5nZXQodGFnKTtcbiAgICBpZiAoIXNpZ25hdHVyZSkgcmV0dXJuIHNpZ25hdHVyZTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmVyaWZ5T3B0aW9ucyk7XG4gICAgdmVyaWZpZWQudGFnID0gdGFnOyAvLyBDYXJyeSB3aXRoIGl0IHRoZSB0YWcgYnkgd2hpY2ggaXQgd2FzIGZvdW5kLlxuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBsaXN0KHNraXBTeW5jID0gZmFsc2UgKSB7IC8vIExpc3QgYWxsIHRhZ3Mgb2YgdGhpcyBjb2xsZWN0aW9uLlxuICAgIGlmICghc2tpcFN5bmMpIGF3YWl0IHRoaXMuc3luY2hyb25pemVUYWdzKCk7XG4gICAgLy8gV2UgY2Fubm90IGp1c3QgbGlzdCB0aGUga2V5cyBvZiB0aGUgY29sbGVjdGlvbiwgYmVjYXVzZSB0aGF0IGluY2x1ZGVzIGVtcHR5IHBheWxvYWRzIG9mIGl0ZW1zIHRoYXQgaGF2ZSBiZWVuIGRlbGV0ZWQuXG4gICAgcmV0dXJuIEFycmF5LmZyb20oKGF3YWl0IHRoaXMudGFncykua2V5cygpKTtcbiAgfVxuICBhc3luYyBtYXRjaCh0YWcsIHByb3BlcnRpZXMpIHsgLy8gSXMgdGhpcyBzaWduYXR1cmUgd2hhdCB3ZSBhcmUgbG9va2luZyBmb3I/XG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLnJldHJpZXZlKHRhZyk7XG4gICAgY29uc3QgZGF0YSA9IHZlcmlmaWVkPy5qc29uO1xuICAgIGlmICghZGF0YSkgcmV0dXJuIGZhbHNlO1xuICAgIGZvciAoY29uc3Qga2V5IGluIHByb3BlcnRpZXMpIHtcbiAgICAgIGlmIChkYXRhW2tleV0gIT09IHByb3BlcnRpZXNba2V5XSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBhc3luYyBmaW5kTG9jYWwocHJvcGVydGllcykgeyAvLyBGaW5kIHRoZSB0YWcgaW4gb3VyIHN0b3JlIHRoYXQgbWF0Y2hlcywgZWxzZSBmYWxzZXlcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBhd2FpdCB0aGlzLmxpc3QoJ25vLXN5bmMnKSkgeyAvLyBEaXJlY3QgbGlzdCwgdy9vIHN5bmMuXG4gICAgICBpZiAoYXdhaXQgdGhpcy5tYXRjaCh0YWcsIHByb3BlcnRpZXMpKSByZXR1cm4gdGFnO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgYXN5bmMgZmluZChwcm9wZXJ0aWVzKSB7IC8vIEFuc3dlciB0aGUgdGFnIHRoYXQgaGFzIHZhbHVlcyBtYXRjaGluZyB0aGUgc3BlY2lmaWVkIHByb3BlcnRpZXMuIE9idmlvdXNseSwgY2FuJ3QgYmUgZW5jcnlwdGVkIGFzIGEgd2hvbGUuXG4gICAgbGV0IGZvdW5kID0gYXdhaXQgdGhpcy5maW5kTG9jYWwocHJvcGVydGllcyk7XG4gICAgaWYgKGZvdW5kKSB7XG4gICAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplMShmb3VuZCk7IC8vIE1ha2Ugc3VyZSB0aGUgZGF0YSBpcyB1cCB0byBkYXRlLiBUaGVuIGNoZWNrIGFnYWluLlxuICAgICAgaWYgKGF3YWl0IHRoaXMubWF0Y2goZm91bmQsIHByb3BlcnRpZXMpKSByZXR1cm4gZm91bmQ7XG4gICAgfVxuICAgIC8vIE5vIG1hdGNoLlxuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemVUYWdzKCk7XG4gICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZURhdGEoKTtcbiAgICBmb3VuZCA9IGF3YWl0IHRoaXMuZmluZExvY2FsKHByb3BlcnRpZXMpO1xuICAgIGlmIChmb3VuZCAmJiBhd2FpdCB0aGlzLm1hdGNoKGZvdW5kLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIGZvdW5kO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJlcXVpcmVUYWcodGFnKSB7XG4gICAgaWYgKHRhZykgcmV0dXJuO1xuICAgIHRocm93IG5ldyBFcnJvcignQSB0YWcgaXMgcmVxdWlyZWQuJyk7XG4gIH1cblxuICAvLyBUaGVzZSB0aHJlZSBpZ25vcmUgc3luY2hyb25pemF0aW9uIHN0YXRlLCB3aGljaCBpZiBuZWVlZCBpcyB0aGUgcmVzcG9uc2liaWxpdHkgb2YgdGhlIGNhbGxlci5cbiAgLy8gRklYTUUgVE9ETzogYWZ0ZXIgaW5pdGlhbCBkZXZlbG9wbWVudCwgdGhlc2UgdGhyZWUgc2hvdWxkIGJlIG1hZGUgaW50ZXJuYWwgc28gdGhhdCBhcHBsaWNhdGlvbiBjb2RlIGRvZXMgbm90IGNhbGwgdGhlbS5cbiAgYXN5bmMgZ2V0KHRhZykgeyAvLyBHZXQgdGhlIGxvY2FsIHJhdyBzaWduYXR1cmUgZGF0YS5cbiAgICB0aGlzLnJlcXVpcmVUYWcodGFnKTtcbiAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkuZ2V0KHRhZyk7XG4gIH1cbiAgLy8gVGhlc2UgdHdvIGNhbiBiZSB0cmlnZ2VyZWQgYnkgY2xpZW50IGNvZGUgb3IgYnkgYW55IHNlcnZpY2UuXG4gIGFzeW5jIHB1dCh0YWcsIHNpZ25hdHVyZSwgc3luY2hyb25pemVyID0gbnVsbCkgeyAvLyBQdXQgdGhlIHJhdyBzaWduYXR1cmUgbG9jYWxseSBhbmQgb24gdGhlIHNwZWNpZmllZCBzZXJ2aWNlcy5cbiAgICAvLyAxLiB2YWxpZGF0ZUZvcldyaXRpbmdcbiAgICAvLyAyLiBtZXJnZVNpZ25hdHVyZXMgYWdhaW5zdCBhbnkgZXhpc3RpbmcsIHBpY2tpbmcgc29tZSBjb21iaW5hdGlvbiBvZiBleGlzdGluZyBhbmQgbmV4dC5cbiAgICAvLyAzLiBwZXJzaXN0IHRoZSByZXN1bHRcbiAgICAvLyA0LiByZXR1cm4gdGFnXG5cbiAgICAvLyBUT0RPOiBkbyB3ZSBuZWVkIHRvIHF1ZXVlIHRoZXNlPyBTdXBwb3NlIHdlIGFyZSB2YWxpZGF0aW5nIG9yIG1lcmdpbmcgd2hpbGUgb3RoZXIgcmVxdWVzdCBhcnJpdmU/XG4gICAgY29uc3QgdmFsaWRhdGlvbiA9IGF3YWl0IHRoaXMudmFsaWRhdGVGb3JXcml0aW5nKHRhZywgc2lnbmF0dXJlLCAnc3RvcmUnLCBzeW5jaHJvbml6ZXIpO1xuICAgIHRoaXMubG9nKCdwdXQnLCB7dGFnOiB2YWxpZGF0aW9uPy50YWcgfHwgdGFnLCBzeW5jaHJvbml6ZXI6IHN5bmNocm9uaXplcj8ubGFiZWwsIHRleHQ6IHZhbGlkYXRpb24/LnRleHR9KTtcblxuICAgIGlmICghdmFsaWRhdGlvbikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBpZiAoIXZhbGlkYXRpb24uc2lnbmF0dXJlKSByZXR1cm4gdmFsaWRhdGlvbi50YWc7IC8vIE5vIGZ1cnRoZXIgYWN0aW9uIGJ1dCBhbnN3ZXIgdGFnLiBFLmcuLCB3aGVuIGlnbm9yaW5nIG5ldyBkYXRhLlxuICAgIGF3YWl0IHRoaXMuYWRkVGFnKHZhbGlkYXRpb24udGFnKTtcblxuICAgIC8vIGZpeG1lIG5leHRcbiAgICBjb25zdCBtZXJnZWQgPSBhd2FpdCB0aGlzLm1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBtZXJnZWQpO1xuICAgIC8vY29uc3QgbWVyZ2VkMiA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmFsaWRhdGlvbkZvcm1hdChtZXJnZWQsIHRhZyk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIG1lcmdlZCk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QyKG1lcmdlZDIpO1xuICAgIC8vIGNvbnN0IG1lcmdlZCA9IGF3YWl0IHRoaXMubWVyZ2VWYWxpZGF0aW9uKHZhbGlkYXRpb24sIG1lcmdlQXV0aG9yT3ZlcnJpZGUpO1xuICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIobWVyZ2VkKTtcblxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5wdXQuXG4gIH1cbiAgYXN5bmMgZGVsZXRlKHRhZywgc2lnbmF0dXJlLCBzeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFJlbW92ZSB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3JlbW92ZScsIHN5bmNocm9uaXplciwgJ3JlcXVpcmVUYWcnKTtcbiAgICB0aGlzLmxvZygnZGVsZXRlJywgdGFnLCBzeW5jaHJvbml6ZXI/LmxhYmVsLCAndmFsaWRhdGVkIHRhZzonLCB2YWxpZGF0aW9uPy50YWcsICdwcmVzZXJ2ZURlbGV0aW9uczonLCB0aGlzLnByZXNlcnZlRGVsZXRpb25zKTtcbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICBpZiAodGhpcy5wcmVzZXJ2ZURlbGV0aW9ucykgeyAvLyBTaWduYXR1cmUgcGF5bG9hZCBpcyBlbXB0eS5cbiAgICAgIC8vIEZJWE1FIG5leHRcbiAgICAgIC8vYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBzaWduYXR1cmUpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uKTtcbiAgICB9IGVsc2UgeyAvLyBSZWFsbHkgZGVsZXRlLlxuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIHNpZ25hdHVyZSwgJ2RlbGV0ZScpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uLCAnZGVsZXRlJyk7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5kZWxldGUuXG4gIH1cblxuICBub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsIG1lc3NhZ2UgPSB1bmRlZmluZWQsIHZhbGlkYXRlZCA9ICcnLCBzaWduYXR1cmUpIHtcbiAgICAvLyBMYXRlciBvbiwgd2Ugd2lsbCBub3Qgd2FudCB0byBnaXZlIG91dCBzbyBtdWNoIGluZm8uLi5cbiAgICAvL2lmICh0aGlzLmRlYnVnKSB7XG4gICAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSwgdGFnKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy8gIGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgYFNpZ25hdHVyZSBpcyBub3QgdmFsaWQgdG8gJHtvcGVyYXRpb25MYWJlbH0gJHt0YWcgfHwgJ2RhdGEnfS5gKTtcbiAgICAvL31cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIFByb21pc2UgYSByZWFzb24gc3RyaW5nIHRvIGRpc2FsbG93LCBvciBudWxsIGlmIHdyaXRlIGlzIGFsbG93ZWQuXG4gICAgLy8gVGhlIGVtcHR5IHN0cmluZyBtZWFucyB0aGF0IHdlIHNob3VsZCBub3QgYWN0dWFsbHkgd3JpdGUgYW55dGhpbmcsIGJ1dCB0aGUgb3BlcmF0aW9uIHNob3VsZCBxdWlldGx5IGFuc3dlciB0aGUgZ2l2ZW4gdGFnLlxuXG4gICAgaWYgKCF2ZXJpZmllZC50ZXh0Lmxlbmd0aCkgcmV0dXJuIHRoaXMuZGlzYWxsb3dEZWxldGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKTtcblxuICAgIGlmICghcHJvcG9zZWQpIHJldHVybiAnaW52YWxpZCBzaWduYXR1cmUnO1xuICAgIGNvbnN0IHRhZ2dlZCA9IGF3YWl0IHRoaXMuY2hlY2tUYWcodmVyaWZpZWQpOyAvLyBDaGVja2VkIHJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB0aGlzIGFuIGFudGVjZWRlbnQuXG4gICAgaWYgKHRhZ2dlZCkgcmV0dXJuIHRhZ2dlZDsgLy8gSGFyZCBmYWlsIGFuc3dlcnMsIHJlZ2FyZGxlc3Mgb2YgZXhpc3RpbmcuXG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuIHRhZ2dlZDsgLy8gUmV0dXJuaW5nICcnIG9yIG51bGwuXG5cbiAgICBsZXQgb3duZXIsIGRhdGU7XG4gICAgLy8gUmV0dXJuIGFueSBoYXJkIGZhaWwgZmlyc3QsIHRoZW4gYW55IGVtcHR5IHN0cmluZywgb3IgZmluYWxseSBudWxsXG4gICAgcmV0dXJuIChvd25lciA9IGF3YWl0IHRoaXMuY2hlY2tPd25lcihleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSkgfHxcbiAgICAgIChkYXRlID0gYXdhaXQgdGhpcy5jaGVja0RhdGUoZXhpc3RpbmcsIHByb3Bvc2VkKSkgfHxcbiAgICAgIChvd25lciA/PyBkYXRlID8/IHRhZ2dlZCk7XG4gIH1cbiAgYXN5bmMgZGlzYWxsb3dEZWxldGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7IC8vIERlbGV0aW9uIHR5cGljYWxseSBsYXRjaGVzLlxuICAgIGlmICghcHJvcG9zZWQpIHJldHVybiAnaW52YWxpZCBzaWduYXR1cmUnO1xuXG4gICAgLy8gSWYgd2UgZXZlciBjaGFuZ2UgdGhpcyBuZXh0LCBiZSBzdXJlIHRoYXQgb25lIGNhbm5vdCBzcGVjdWxhdGl2ZWx5IGNhbXAgb3V0IG9uIGEgdGFnIGFuZCBwcmV2ZW50IHBlb3BsZSBmcm9tIHdyaXRpbmchXG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuICcnO1xuICAgIC8vIERlbGV0aW5nIHRydW1wcyBkYXRhLCByZWdhcmRsZXNzIG9mIHRpbWVzdGFtcC5cbiAgICByZXR1cm4gdGhpcy5jaGVja093bmVyKGV4aXN0aW5nLCBwcm9wb3NlZCwgdmVyaWZpZWQpO1xuICB9XG4gIGhhc2hhYmxlUGF5bG9hZCh2YWxpZGF0aW9uKSB7IC8vIFJldHVybiBhIHN0cmluZyB0aGF0IGNhbiBiZSBoYXNoZWQgdG8gbWF0Y2ggdGhlIHN1YiBoZWFkZXJcbiAgICAvLyAod2hpY2ggaXMgbm9ybWFsbHkgZ2VuZXJhdGVkIGluc2lkZSB0aGUgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgdmF1bHQpLlxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRleHQgfHwgbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHZhbGlkYXRpb24ucGF5bG9hZCk7XG4gIH1cbiAgYXN5bmMgaGFzaCh2YWxpZGF0aW9uKSB7IC8vIFByb21pc2UgdGhlIGhhc2ggb2YgaGFzaGFibGVQYXlsb2FkLlxuICAgIHJldHVybiBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoYXdhaXQgQ3JlZGVudGlhbHMuaGFzaFRleHQodGhpcy5oYXNoYWJsZVBheWxvYWQodmFsaWRhdGlvbikpKTtcbiAgfVxuICBmYWlyT3JkZXJlZEF1dGhvcihleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gVXNlZCB0byBicmVhayB0aWVzIGluIGV2ZW4gdGltZXN0YW1wcy5cbiAgICBjb25zdCB7c3ViLCBhY3R9ID0gZXhpc3Rpbmc7XG4gICAgY29uc3Qge2FjdDphY3QyfSA9IHByb3Bvc2VkO1xuICAgIGlmIChzdWI/Lmxlbmd0aCAmJiBzdWIuY2hhckNvZGVBdChzdWIubGVuZ3RoIC0gMSkgJSAyKSByZXR1cm4gYWN0IDwgYWN0MjtcbiAgICByZXR1cm4gYWN0ID4gYWN0MjsgLy8gSWYgYWN0ID09PSBhY3QyLCB0aGVuIHRoZSB0aW1lc3RhbXBzIHNob3VsZCBiZSB0aGUgc2FtZS5cbiAgfVxuICBnZXRPd25lcihwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gUmV0dXJuIHRoZSB0YWcgb2Ygd2hhdCBzaGFsbCBiZSBjb25zaWRlcmVkIHRoZSBvd25lci5cbiAgICBjb25zdCB7aXNzLCBraWR9ID0gcHJvdGVjdGVkSGVhZGVyO1xuICAgIHJldHVybiBpc3MgfHwga2lkO1xuICB9XG4gIC8vIFRoZXNlIHByZWRpY2F0ZXMgY2FuIHJldHVybiBhIGJvb2xlYW4gZm9yIGhhcmQgeWVzIG9yIG5vLCBvciBudWxsIHRvIGluZGljYXRlIHRoYXQgdGhlIG9wZXJhdGlvbiBzaG91bGQgc2lsZW50bHkgcmUtdXNlIHRoZSB0YWcuXG4gIGNoZWNrU29tZXRoaW5nKHJlYXNvbiwgYm9vbGVhbiwgbGFiZWwpIHtcbiAgICBpZiAoYm9vbGVhbikgdGhpcy5sb2coJ3dyb25nJywgbGFiZWwsIHJlYXNvbik7IC8vZml4bWVcbiAgICByZXR1cm4gYm9vbGVhbiA/IHJlYXNvbiA6IG51bGw7XG4gIH1cbiAgY2hlY2tPd25lcihleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkKSB7Ly8gRG9lcyBwcm9wb3NlZCBvd25lciBtYXRjaCB0aGUgZXhpc3Rpbmc/XG4gICAgcmV0dXJuIHRoaXMuY2hlY2tTb21ldGhpbmcoJ25vdCBvd25lcicsIHRoaXMuZ2V0T3duZXIoZXhpc3RpbmcsIHZlcmlmaWVkLmV4aXN0aW5nKSAhPT0gdGhpcy5nZXRPd25lcihwcm9wb3NlZCwgdmVyaWZpZWQpLCAnb3duZXInKTtcbiAgfVxuXG4gIGFudGVjZWRlbnQodmVyaWZpZWQpIHsgLy8gV2hhdCB0YWcgc2hvdWxkIHRoZSB2ZXJpZmllZCBzaWduYXR1cmUgYmUgY29tcGFyZWQgYWdhaW5zdCBmb3Igd3JpdGluZywgaWYgYW55LlxuICAgIHJldHVybiB2ZXJpZmllZC50YWc7XG4gIH1cbiAgc3luY2hyb25pemVBbnRlY2VkZW50KHRhZywgYW50ZWNlZGVudCkgeyAvLyBTaG91bGQgdGhlIGFudGVjZWRlbnQgdHJ5IHN5bmNocm9uaXppbmcgYmVmb3JlIGdldHRpbmcgaXQ/XG4gICAgcmV0dXJuIHRhZyAhPT0gYW50ZWNlZGVudDsgLy8gRmFsc2Ugd2hlbiB0aGV5IGFyZSB0aGUgc2FtZSB0YWcsIGFzIHRoYXQgd291bGQgYmUgY2lyY3VsYXIuIFZlcnNpb25zIGRvIHN5bmMuXG4gIH1cbiAgdGFnRm9yV3JpdGluZyhzcGVjaWZpZWRUYWcsIHZhbGlkYXRpb24pIHsgLy8gR2l2ZW4gdGhlIHNwZWNpZmllZCB0YWcgYW5kIHRoZSBiYXNpYyB2ZXJpZmljYXRpb24gc28gZmFyLCBhbnN3ZXIgdGhlIHRhZyB0aGF0IHNob3VsZCBiZSB1c2VkIGZvciB3cml0aW5nLlxuICAgIHJldHVybiBzcGVjaWZpZWRUYWcgfHwgdGhpcy5oYXNoKHZhbGlkYXRpb24pO1xuICB9XG4gIGFzeW5jIHZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgb3BlcmF0aW9uTGFiZWwsIHN5bmNocm9uaXplciwgcmVxdWlyZVRhZyA9IGZhbHNlKSB7IC8vIFRPRE86IE9wdGlvbmFscyBzaG91bGQgYmUga2V5d29yZC5cbiAgICAvLyBBIGRlZXAgdmVyaWZ5IHRoYXQgY2hlY2tzIGFnYWluc3QgdGhlIGV4aXN0aW5nIGl0ZW0ncyAocmUtKXZlcmlmaWVkIGhlYWRlcnMuXG4gICAgLy8gSWYgaXQgc3VjY2VlZHMsIHByb21pc2UgYSB2YWxpZGF0aW9uLlxuICAgIC8vIEl0IGNhbiBhbHNvIGFuc3dlciBhIHN1cGVyLWFiYnJldmFpdGVkIHZhbGl0aW9uIG9mIGp1c3Qge3RhZ30sIHdoaWNoIGluZGljYXRlcyB0aGF0IG5vdGhpbmcgc2hvdWxkIGJlIHBlcnNpc3RlZC9lbWl0dGVkLCBidXQgdGFnIHJldHVybmVkLlxuICAgIC8vIFRoaXMgaXMgYWxzbyB0aGUgY29tbW9uIGNvZGUgKGJldHdlZW4gcHV0L2RlbGV0ZSkgdGhhdCBlbWl0cyB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIC8vXG4gICAgLy8gSG93LCBpZiBhIGFsbCwgZG8gd2UgY2hlY2sgdGhhdCBhY3QgaXMgYSBtZW1iZXIgb2YgaXNzP1xuICAgIC8vIENvbnNpZGVyIGFuIGl0ZW0gb3duZWQgYnkgaXNzLlxuICAgIC8vIFRoZSBpdGVtIGlzIHN0b3JlZCBhbmQgc3luY2hyb25pemVkIGJ5IGFjdCBBIGF0IHRpbWUgdDEuXG4gICAgLy8gSG93ZXZlciwgYXQgYW4gZWFybGllciB0aW1lIHQwLCBhY3QgQiB3YXMgY3V0IG9mZiBmcm9tIHRoZSByZWxheSBhbmQgc3RvcmVkIHRoZSBpdGVtLlxuICAgIC8vIFdoZW4gbWVyZ2luZywgd2Ugd2FudCBhY3QgQidzIHQwIHRvIGJlIHRoZSBlYXJsaWVyIHJlY29yZCwgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIEIgaXMgc3RpbGwgYSBtZW1iZXIgYXQgdGltZSBvZiBzeW5jaHJvbml6YXRpb24uXG4gICAgLy8gVW5sZXNzL3VudGlsIHdlIGhhdmUgdmVyc2lvbmVkIGtleXNldHMsIHdlIGNhbm5vdCBlbmZvcmNlIGEgbWVtYmVyc2hpcCBjaGVjayAtLSB1bmxlc3MgdGhlIGFwcGxpY2F0aW9uIGl0c2VsZiB3YW50cyB0byBkbyBzby5cbiAgICAvLyBBIGNvbnNlcXVlbmNlLCB0aG91Z2gsIGlzIHRoYXQgYSBodW1hbiB3aG8gaXMgYSBtZW1iZXIgb2YgaXNzIGNhbiBnZXQgYXdheSB3aXRoIHN0b3JpbmcgdGhlIGRhdGEgYXMgc29tZVxuICAgIC8vIG90aGVyIHVucmVsYXRlZCBwZXJzb25hLiBUaGlzIG1heSBtYWtlIGl0IGhhcmQgZm9yIHRoZSBncm91cCB0byBob2xkIHRoYXQgaHVtYW4gcmVzcG9uc2libGUuXG4gICAgLy8gT2YgY291cnNlLCB0aGF0J3MgYWxzbyB0cnVlIGlmIHdlIHZlcmlmaWVkIG1lbWJlcnMgYXQgYWxsIHRpbWVzLCBhbmQgaGFkIGJhZCBjb250ZW50IGxlZ2l0aW1hdGVseSBjcmVhdGVkIGJ5IHNvbWVvbmUgd2hvIGdvdCBraWNrZWQgbGF0ZXIuXG5cbiAgICBjb25zdCB2YWxpZGF0aW9uT3B0aW9ucyA9IHttZW1iZXI6IG51bGx9OyAvLyBDb3VsZCBiZSBvbGQgZGF0YSB3cml0dGVuIGJ5IHNvbWVvbmUgd2hvIGlzIG5vIGxvbmdlciBhIG1lbWJlci4gU2VlIG93bmVyTWF0Y2guXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeShzaWduYXR1cmUsIHZhbGlkYXRpb25PcHRpb25zKTtcbiAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gdGhpcy5ub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsICdpbnZhbGlkJywgdmVyaWZpZWQsIHNpZ25hdHVyZSk7XG4gICAgdmVyaWZpZWQuc3luY2hyb25pemVyID0gc3luY2hyb25pemVyO1xuICAgIC8vIFNldCB0aGUgYWN0dWFsIHRhZyB0byB1c2UgYmVmb3JlIHdlIGRvIHRoZSBkaXNhbGxvdyBjaGVja3MuXG4gICAgdGFnID0gdmVyaWZpZWQudGFnID0gcmVxdWlyZVRhZyA/IHRhZyA6IGF3YWl0IHRoaXMudGFnRm9yV3JpdGluZyh0YWcsIHZlcmlmaWVkKTtcbiAgICBjb25zdCBhbnRlY2VkZW50ID0gdGhpcy5hbnRlY2VkZW50KHZlcmlmaWVkKTtcbiAgICBjb25zdCBzeW5jaHJvbml6ZSA9IHRoaXMuc3luY2hyb25pemVBbnRlY2VkZW50KHRhZywgYW50ZWNlZGVudCk7XG4gICAgY29uc3QgZXhpc3RpbmdWZXJpZmllZCA9IHZlcmlmaWVkLmV4aXN0aW5nID0gYW50ZWNlZGVudCAmJiBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWc6IGFudGVjZWRlbnQsIHN5bmNocm9uaXplLCAuLi52YWxpZGF0aW9uT3B0aW9uc30pO1xuICAgIGNvbnN0IGRpc2FsbG93ZWQgPSBhd2FpdCB0aGlzLmRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZ1ZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkPy5wcm90ZWN0ZWRIZWFkZXIsIHZlcmlmaWVkKTtcbiAgICB0aGlzLmxvZygndmFsaWRhdGVGb3JXcml0aW5nJywge3RhZywgb3BlcmF0aW9uTGFiZWwsIHJlcXVpcmVUYWcsIGZyb21TeW5jaHJvbml6ZXI6ISFzeW5jaHJvbml6ZXIsIHNpZ25hdHVyZSwgdmVyaWZpZWQsIGFudGVjZWRlbnQsIHN5bmNocm9uaXplLCBleGlzdGluZ1ZlcmlmaWVkLCBkaXNhbGxvd2VkfSk7XG4gICAgaWYgKGRpc2FsbG93ZWQgPT09ICcnKSByZXR1cm4ge3RhZ307IC8vIEFsbG93IG9wZXJhdGlvbiB0byBzaWxlbnRseSBhbnN3ZXIgdGFnLCB3aXRob3V0IHBlcnNpc3Rpbmcgb3IgZW1pdHRpbmcgYW55dGhpbmcuXG4gICAgaWYgKGRpc2FsbG93ZWQpIHJldHVybiB0aGlzLm5vdGlmeUludmFsaWQodGFnLCBvcGVyYXRpb25MYWJlbCwgZGlzYWxsb3dlZCwgdmVyaWZpZWQpO1xuICAgIHRoaXMuZW1pdCh2ZXJpZmllZCk7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIC8vIGZpeG1lIG5leHQgMlxuICBtZXJnZVNpZ25hdHVyZXModGFnLCB2YWxpZGF0aW9uLCBzaWduYXR1cmUpIHsgLy8gUmV0dXJuIGEgc3RyaW5nIHRvIGJlIHBlcnNpc3RlZC4gVXN1YWxseSBqdXN0IHRoZSBzaWduYXR1cmUuXG4gICAgcmV0dXJuIHNpZ25hdHVyZTsgIC8vIHZhbGlkYXRpb24uc3RyaW5nIG1pZ2h0IGJlIGFuIG9iamVjdC5cbiAgfVxuICBhc3luYyBwZXJzaXN0KHRhZywgc2lnbmF0dXJlU3RyaW5nLCBvcGVyYXRpb24gPSAncHV0JykgeyAvLyBDb25kdWN0IHRoZSBzcGVjaWZpZWQgdGFnL3NpZ25hdHVyZSBvcGVyYXRpb24gb24gdGhlIHBlcnNpc3RlbnQgc3RvcmUuXG4gICAgcmV0dXJuIChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpW29wZXJhdGlvbl0odGFnLCBzaWduYXR1cmVTdHJpbmcpO1xuICB9XG4gIG1lcmdlVmFsaWRhdGlvbih2YWxpZGF0aW9uKSB7IC8vIFJldHVybiBhIHN0cmluZyB0byBiZSBwZXJzaXN0ZWQuIFVzdWFsbHkganVzdCB0aGUgc2lnbmF0dXJlLlxuICAgIHJldHVybiB2YWxpZGF0aW9uO1xuICB9XG4gIGFzeW5jIHBlcnNpc3QyKHZhbGlkYXRpb24sIG9wZXJhdGlvbiA9ICdwdXQnKSB7IC8vIENvbmR1Y3QgdGhlIHNwZWNpZmllZCB0YWcvc2lnbmF0dXJlIG9wZXJhdGlvbiBvbiB0aGUgcGVyc2lzdGVudCBzdG9yZS4gUmV0dXJuIHRhZ1xuICAgIGNvbnN0IHt0YWcsIHNpZ25hdHVyZX0gPSB2YWxpZGF0aW9uO1xuICAgIGNvbnN0IHNpZ25hdHVyZVN0cmluZyA9IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gICAgY29uc3Qgc3RvcmFnZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICB0aGlzLmxvZygncGVyc2lzdDInLCB7dGFnLCBzdG9yYWdlLCBvcGVyYXRpb24sIHNpZ25hdHVyZVN0cmluZ30pO1xuICAgIGF3YWl0IHN0b3JhZ2Vbb3BlcmF0aW9uXSh0YWcsIHNpZ25hdHVyZVN0cmluZyk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBlbWl0KHZlcmlmaWVkKSB7IC8vIERpc3BhdGNoIHRoZSB1cGRhdGUgZXZlbnQuXG4gICAgdGhpcy5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudCgndXBkYXRlJywge2RldGFpbDogdmVyaWZpZWR9KSk7XG4gIH1cbiAgZ2V0IGl0ZW1FbWl0dGVyKCkgeyAvLyBBbnN3ZXJzIHRoZSBDb2xsZWN0aW9uIHRoYXQgZW1pdHMgaW5kaXZpZHVhbCB1cGRhdGVzLiAoU2VlIG92ZXJyaWRlIGluIFZlcnNpb25lZENvbGxlY3Rpb24uKVxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgc3luY2hyb25pemVycyA9IG5ldyBNYXAoKTsgLy8gc2VydmljZUluZm8gbWlnaHQgbm90IGJlIGEgc3RyaW5nLlxuICBtYXBTeW5jaHJvbml6ZXJzKGYpIHsgLy8gT24gU2FmYXJpLCBNYXAudmFsdWVzKCkubWFwIGlzIG5vdCBhIGZ1bmN0aW9uIVxuICAgIGNvbnN0IHJlc3VsdHMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IHN5bmNocm9uaXplciBvZiB0aGlzLnN5bmNocm9uaXplcnMudmFsdWVzKCkpIHtcbiAgICAgIHJlc3VsdHMucHVzaChmKHN5bmNocm9uaXplcikpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfVxuICBnZXQgc2VydmljZXMoKSB7XG4gICAgcmV0dXJuIEFycmF5LmZyb20odGhpcy5zeW5jaHJvbml6ZXJzLmtleXMoKSk7XG4gIH1cbiAgLy8gVE9ETzogcmVuYW1lIHRoaXMgdG8gY29ubmVjdCwgYW5kIGRlZmluZSBzeW5jaHJvbml6ZSB0byBhd2FpdCBjb25uZWN0LCBzeW5jaHJvbml6YXRpb25Db21wbGV0ZSwgZGlzY29ubm5lY3QuXG4gIGFzeW5jIHN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSB7IC8vIFN0YXJ0IHJ1bm5pbmcgdGhlIHNwZWNpZmllZCBzZXJ2aWNlcyAoaW4gYWRkaXRpb24gdG8gd2hhdGV2ZXIgaXMgYWxyZWFkeSBydW5uaW5nKS5cbiAgICBjb25zdCB7c3luY2hyb25pemVyc30gPSB0aGlzO1xuICAgIGZvciAobGV0IHNlcnZpY2Ugb2Ygc2VydmljZXMpIHtcbiAgICAgIGlmIChzeW5jaHJvbml6ZXJzLmhhcyhzZXJ2aWNlKSkgY29udGludWU7XG4gICAgICBhd2FpdCBTeW5jaHJvbml6ZXIuY3JlYXRlKHRoaXMsIHNlcnZpY2UpOyAvLyBSZWFjaGVzIGludG8gb3VyIHN5bmNocm9uaXplcnMgbWFwIGFuZCBzZXRzIGl0c2VsZiBpbW1lZGlhdGVseS5cbiAgICB9XG4gIH1cbiAgZ2V0IHN5bmNocm9uaXplZCgpIHsgLy8gcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gc3luY2hyb25pemF0aW9uIGlzIGNvbXBsZXRlIGluIEJPVEggZGlyZWN0aW9ucy5cbiAgICAvLyBUT0RPPyBUaGlzIGRvZXMgbm90IHJlZmxlY3QgY2hhbmdlcyBhcyBTeW5jaHJvbml6ZXJzIGFyZSBhZGRlZCBvciByZW1vdmVkIHNpbmNlIGNhbGxlZC4gU2hvdWxkIGl0P1xuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMocyA9PiBzLmJvdGhTaWRlc0NvbXBsZXRlZFN5bmNocm9uaXphdGlvbikpO1xuICB9XG4gIGFzeW5jIGRpc2Nvbm5lY3QoLi4uc2VydmljZXMpIHsgLy8gU2h1dCBkb3duIHRoZSBzcGVjaWZpZWQgc2VydmljZXMuXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHNlcnZpY2VzID0gdGhpcy5zZXJ2aWNlcztcbiAgICBjb25zdCB7c3luY2hyb25pemVyc30gPSB0aGlzO1xuICAgIGZvciAobGV0IHNlcnZpY2Ugb2Ygc2VydmljZXMpIHtcbiAgICAgIGNvbnN0IHN5bmNocm9uaXplciA9IHN5bmNocm9uaXplcnMuZ2V0KHNlcnZpY2UpO1xuICAgICAgaWYgKCFzeW5jaHJvbml6ZXIpIHtcblx0Ly9jb25zb2xlLndhcm4oYCR7dGhpcy5mdWxsTGFiZWx9IGRvZXMgbm90IGhhdmUgYSBzZXJ2aWNlIG5hbWVkICcke3NlcnZpY2V9JyB0byBkaXNjb25uZWN0LmApO1xuXHRjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHN5bmNocm9uaXplci5kaXNjb25uZWN0KCk7XG4gICAgfVxuICB9XG4gIGFzeW5jIGVuc3VyZVN5bmNocm9uaXplcihzZXJ2aWNlTmFtZSwgY29ubmVjdGlvbiwgZGF0YUNoYW5uZWwpIHsgLy8gTWFrZSBzdXJlIGRhdGFDaGFubmVsIG1hdGNoZXMgdGhlIHN5bmNocm9uaXplciwgY3JlYXRpbmcgU3luY2hyb25pemVyIG9ubHkgaWYgbWlzc2luZy5cbiAgICBsZXQgc3luY2hyb25pemVyID0gdGhpcy5zeW5jaHJvbml6ZXJzLmdldChzZXJ2aWNlTmFtZSk7XG4gICAgaWYgKCFzeW5jaHJvbml6ZXIpIHtcbiAgICAgIHN5bmNocm9uaXplciA9IG5ldyBTeW5jaHJvbml6ZXIoe3NlcnZpY2VOYW1lLCBjb2xsZWN0aW9uOiB0aGlzLCBkZWJ1ZzogdGhpcy5kZWJ1Z30pO1xuICAgICAgc3luY2hyb25pemVyLmNvbm5lY3Rpb24gPSBjb25uZWN0aW9uO1xuICAgICAgc3luY2hyb25pemVyLmRhdGFDaGFubmVsUHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZShkYXRhQ2hhbm5lbCk7XG4gICAgICB0aGlzLnN5bmNocm9uaXplcnMuc2V0KHNlcnZpY2VOYW1lLCBzeW5jaHJvbml6ZXIpO1xuICAgICAgLy8gRG9lcyBOT1Qgc3RhcnQgc3luY2hyb25pemluZy4gQ2FsbGVyIG11c3QgZG8gdGhhdCBpZiBkZXNpcmVkLiAoUm91dGVyIGRvZXNuJ3QgbmVlZCB0by4pXG4gICAgfSBlbHNlIGlmICgoc3luY2hyb25pemVyLmNvbm5lY3Rpb24gIT09IGNvbm5lY3Rpb24pIHx8XG5cdCAgICAgICAoc3luY2hyb25pemVyLmNoYW5uZWxOYW1lICE9PSBkYXRhQ2hhbm5lbC5sYWJlbCkgfHxcblx0ICAgICAgIChhd2FpdCBzeW5jaHJvbml6ZXIuZGF0YUNoYW5uZWxQcm9taXNlICE9PSBkYXRhQ2hhbm5lbCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5tYXRjaGVkIGNvbm5lY3Rpb24gZm9yICR7c2VydmljZU5hbWV9LmApO1xuICAgIH1cbiAgICByZXR1cm4gc3luY2hyb25pemVyO1xuICB9XG5cbiAgcHJvbWlzZShrZXksIHRodW5rKSB7IHJldHVybiB0aHVuazsgfSAvLyBUT0RPOiBob3cgd2lsbCB3ZSBrZWVwIHRyYWNrIG9mIG92ZXJsYXBwaW5nIGRpc3RpbmN0IHN5bmNzP1xuICBzeW5jaHJvbml6ZTEodGFnKSB7IC8vIENvbXBhcmUgYWdhaW5zdCBhbnkgcmVtYWluaW5nIHVuc3luY2hyb25pemVkIGRhdGEsIGZldGNoIHdoYXQncyBuZWVkZWQsIGFuZCByZXNvbHZlIGxvY2FsbHkuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHRoaXMubWFwU3luY2hyb25pemVycyhzeW5jaHJvbml6ZXIgPT4gc3luY2hyb25pemVyLnN5bmNocm9uaXphdGlvblByb21pc2UodGFnKSkpO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplVGFncygpIHsgLy8gRW5zdXJlIHRoYXQgd2UgaGF2ZSB1cCB0byBkYXRlIHRhZyBtYXAgYW1vbmcgYWxsIHNlcnZpY2VzLiAoV2UgZG9uJ3QgY2FyZSB5ZXQgb2YgdGhlIHZhbHVlcyBhcmUgc3luY2hyb25pemVkLilcbiAgICByZXR1cm4gdGhpcy5wcm9taXNlKCd0YWdzJywgKCkgPT4gUHJvbWlzZS5yZXNvbHZlKCkpOyAvLyBUT0RPXG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemVEYXRhKCkgeyAvLyBNYWtlIHRoZSBkYXRhIHRvIG1hdGNoIG91ciB0YWdtYXAsIHVzaW5nIHN5bmNocm9uaXplMS5cbiAgICByZXR1cm4gdGhpcy5wcm9taXNlKCdkYXRhJywgKCkgPT4gUHJvbWlzZS5yZXNvbHZlKCkpOyAvLyBUT0RPXG4gIH1cbiAgc2V0IG9udXBkYXRlKGhhbmRsZXIpIHsgLy8gQWxsb3cgc2V0dGluZyBpbiBsaWV1IG9mIGFkZEV2ZW50TGlzdGVuZXIuXG4gICAgaWYgKGhhbmRsZXIpIHtcbiAgICAgIHRoaXMucmVtb3ZlRXZlbnRMaXN0ZW5lcigndXBkYXRlJywgdGhpcy5fdXBkYXRlKTtcbiAgICAgIHRoaXMuX3VwZGF0ZSA9IGhhbmRsZXI7XG4gICAgICB0aGlzLmFkZEV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIGhhbmRsZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIHRoaXMuX3VwZGF0ZSk7XG4gICAgICB0aGlzLl91cGRhdGUgPSBoYW5kbGVyO1xuICAgIH1cbiAgfVxuICBnZXQgb251cGRhdGUoKSB7IC8vIEFzIHNldCBieSB0aGlzLm9udXBkYXRlID0gaGFuZGxlci4gRG9lcyBOT1QgYW5zd2VyIHRoYXQgd2hpY2ggaXMgc2V0IGJ5IGFkZEV2ZW50TGlzdGVuZXIuXG4gICAgcmV0dXJuIHRoaXMuX3VwZGF0ZTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgTXV0YWJsZUNvbGxlY3Rpb24gZXh0ZW5kcyBDb2xsZWN0aW9uIHtcbiAgYXN5bmMgY2hlY2tUYWcodmVyaWZpZWQpIHsgLy8gTXV0YWJsZSB0YWcgY291bGQgYmUgYW55dGhpbmcuXG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY2hlY2tEYXRlKGV4aXN0aW5nLCBwcm9wb3NlZCkgeyAvLyBmYWlsIGlmIGJhY2tkYXRlZC5cbiAgICByZXR1cm4gdGhpcy5jaGVja1NvbWV0aGluZygnYmFja2RhdGVkJywgIXByb3Bvc2VkLmlhdCB8fFxuXHRcdFx0ICAgICAgICgocHJvcG9zZWQuaWF0ID09PSBleGlzdGluZy5pYXQpID8gdGhpcy5mYWlyT3JkZXJlZEF1dGhvcihleGlzdGluZywgcHJvcG9zZWQpIDogIChwcm9wb3NlZC5pYXQgPCBleGlzdGluZy5pYXQpKSxcblx0XHRcdCAgICAgICAnZGF0ZScpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBJbW11dGFibGVDb2xsZWN0aW9uIGV4dGVuZHMgQ29sbGVjdGlvbiB7XG4gIGNoZWNrRGF0ZShleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gT3Agd2lsbCByZXR1cm4gZXhpc3RpbmcgdGFnIGlmIG1vcmUgcmVjZW50LCByYXRoZXIgdGhhbiBmYWlsaW5nLlxuICAgIGlmICghcHJvcG9zZWQuaWF0KSByZXR1cm4gJ25vIHRpbWVzdGFtcCc7XG4gICAgcmV0dXJuIHRoaXMuY2hlY2tTb21ldGhpbmcoJycsXG5cdFx0XHQgICAgICAgKChwcm9wb3NlZC5pYXQgPT09IGV4aXN0aW5nLmlhdCkgPyB0aGlzLmZhaXJPcmRlcmVkQXV0aG9yKGV4aXN0aW5nLCBwcm9wb3NlZCkgOiAgKHByb3Bvc2VkLmlhdCA+IGV4aXN0aW5nLmlhdCkpLFxuXHRcdFx0ICAgICAgICdkYXRlJyk7XG4gIH1cbiAgYXN5bmMgY2hlY2tUYWcodmVyaWZpZWQpIHsgLy8gSWYgdGhlIHRhZyBkb2Vzbid0IG1hdGNoIHRoZSBkYXRhLCBzaWxlbnRseSB1c2UgdGhlIGV4aXN0aW5nIHRhZywgZWxzZSBmYWlsIGhhcmQuXG4gICAgcmV0dXJuIHRoaXMuY2hlY2tTb21ldGhpbmcodmVyaWZpZWQuZXhpc3RpbmcgPyAnJyA6ICd3cm9uZyB0YWcnLCB2ZXJpZmllZC50YWcgIT09IGF3YWl0IHRoaXMuaGFzaCh2ZXJpZmllZCksICdpbW11dGFibGUgdGFnJyk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFN0YXRlQ29sbGVjdGlvbiBleHRlbmRzIEltbXV0YWJsZUNvbGxlY3Rpb24ge1xuICAvLyBBIHByb3BlcnR5IG5hbWVkIG1lc3NhZ2UgbWF5IGJlIGluY2x1ZGVkIGluIHRoZSBkYXRhLCB3aGljaCB0ZWxsIHRoZSBhcHBsaWNhdGlvbiBob3cgdG8gcmVidWlsZCBzdGF0ZXMgaW4gYSBkaWZmZXJlbnQgb3JkZXIgZm9yIG1lcmdpbmcuXG4gIC8vIEEgb3B0aW9uIG5hbWVkIGFudGVjZWRlbnQgbWF5IGJlIHByb3ZpZGVkIHRoYXQgaWRlbnRpZmllcyB0aGUgcHJlY2VkaW5nIHN0YXRlIChiZWZvcmUgdGhlIG1lc3NhZ2Ugd2FzIGFwcGxpZWQpLlxuXG4gIGhhc2hhYmxlUGF5bG9hZCh2YWxpZGF0aW9uKSB7IC8vIEluY2x1ZGUgYW50IHx8IGlhdC5cbiAgICBjb25zdCB7YW50LCBpYXR9ID0gdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXI7XG4gICAgY29uc3QgcGF5bG9hZCA9IHN1cGVyLmhhc2hhYmxlUGF5bG9hZCh2YWxpZGF0aW9uKTtcbiAgICB0aGlzLmxvZygnaGFzaGluZycsIHtwYXlsb2FkLCBhbnQsIGlhdH0pO1xuICAgIHJldHVybiBwYXlsb2FkICsgKGFudCB8fCBpYXQpO1xuICB9XG4gIGFzeW5jIGNoZWNrVGFnKHZlcmlmaWVkKSB7XG4gICAgaWYgKHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5maXhtZSkgcmV0dXJuICcnO1xuICAgIGNvbnN0IHRhZyA9IHZlcmlmaWVkLnRhZztcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgdGhpcy5oYXNoKHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdGhpcy5jaGVja1NvbWV0aGluZygnd3Jvbmcgc3RhdGUgdGFnJywgdGFnICE9PSBoYXNoLCAnc3RhdGUgdGFnJyk7XG4gIH1cbiAgY2hlY2tEYXRlKCkgeyAvLyBhbHdheXMgb2tcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBnZXRPd25lcihwcm90ZWN0ZWRIZWFkZXIpIHsgLy8gUmV0dXJuIHRoZSB0YWcgb2Ygd2hhdCBzaGFsbCBiZSBjb25zaWRlcmVkIHRoZSBvd25lci5cbiAgICByZXR1cm4gcHJvdGVjdGVkSGVhZGVyLmdyb3VwIHx8IHN1cGVyLmdldE93bmVyKHByb3RlY3RlZEhlYWRlcik7XG4gIH1cbiAgYW50ZWNlZGVudCh2YWxpZGF0aW9uKSB7XG4gICAgaWYgKHZhbGlkYXRpb24udGV4dCA9PT0gJycpIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRGVsZXRlIGNvbXBhcmVzIHdpdGggd2hhdCdzIHRoZXJlXG4gICAgcmV0dXJuIHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLmFudDtcbiAgfVxuICAvLyBmaXhtZTogcmVtb3ZlP1xuICBhc3luYyBmb3JFYWNoU3RhdGUodGFnLCBjYWxsYmFjaywgcmVzdWx0ID0gbnVsbCkgeyAvLyBhd2FpdCBjYWxsYmFjayh2ZXJpZmllZFN0YXRlLCB0YWcpIG9uIHRoZSBzdGF0ZSBjaGFpbiBzcGVjaWZpZWQgYnkgdGFnLlxuICAgIC8vIFN0b3BzIGl0ZXJhdGlvbiBhbmQgcmVzb2x2ZXMgd2l0aCB0aGUgZmlyc3QgdHJ1dGh5IHZhbHVlIGZyb20gY2FsbGJhY2suIE90aGVyd2lzZSwgcmVzb2x2ZXMgd2l0aCByZXN1bHQuXG4gICAgd2hpbGUgKHRhZykge1xuICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIG1lbWJlcjogbnVsbCwgc3luY2hyb25pemU6IGZhbHNlfSk7XG4gICAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhbGxiYWNrKHZlcmlmaWVkLCB0YWcpOyAvLyB2ZXJpZmllZCBpcyBub3QgZGVjcnlwdGVkXG4gICAgICBpZiAocmVzdWx0KSByZXR1cm4gcmVzdWx0O1xuICAgICAgdGFnID0gdGhpcy5hbnRlY2VkZW50KHZlcmlmaWVkKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICBhc3luYyBjb21tb25TdGF0ZUFuZE1lc3NhZ2VzKHN0YXRlVGFncykge1xuICAgIC8vIFJldHVybiBhIGxpc3QgaW4gd2hpY2g6XG4gICAgLy8gLSBUaGUgZmlyc3QgZWxlbWVudCBpcyB0aGUgbW9zdCByZWNlbnQgc3RhdGUgdGhhdCBpcyBjb21tb24gYW1vbmcgdGhlIGVsZW1lbnRzIG9mIHN0YXRlVGFnc1xuICAgIC8vICAgZGlzcmVnYXJkaW5nIHN0YXRlcyB0aGF0IHdob2x5IGEgc3Vic2V0IG9mIGFub3RoZXIgaW4gdGhlIGxpc3QuXG4gICAgLy8gICBUaGlzIG1pZ2h0IG5vdCBiZSBhdCB0aGUgc2FtZSBkZXB0aCBmb3IgZWFjaCBvZiB0aGUgbGlzdGVkIHN0YXRlcyFcbiAgICAvLyAtIFRoZSByZW1haW5pbmcgZWxlbWVudHMgY29udGFpbnMgYWxsIGFuZCBvbmx5IHRob3NlIHZlcmlmaWVkU3RhdGVzIHRoYXQgYXJlIGluY2x1ZGVkIGluIHRoZSBoaXN0b3J5IG9mIHN0YXRlVGFnc1xuICAgIC8vICAgYWZ0ZXIgdGhlIGNvbW1vbiBzdGF0ZSBvZiB0aGUgZmlyc3QgZWxlbWVudCByZXR1cm5lZC4gVGhlIG9yZGVyIG9mIHRoZSByZW1haW5pbmcgZWxlbWVudHMgZG9lcyBub3QgbWF0dGVyLlxuICAgIC8vXG4gICAgLy8gVGhpcyBpbXBsZW1lbnRhdGlvbiBtaW5pbWl6ZXMgYWNjZXNzIHRocm91Z2ggdGhlIGhpc3RvcnkuXG4gICAgLy8gKEl0IHRyYWNrcyB0aGUgdmVyaWZpZWRTdGF0ZXMgYXQgZGlmZmVyZW50IGRlcHRocywgaW4gb3JkZXIgdG8gYXZvaWQgZ29pbmcgdGhyb3VnaCB0aGUgaGlzdG9yeSBtdWx0aXBsZSB0aW1lcy4pXG4gICAgLy8gSG93ZXZlciwgaWYgdGhlIGZpcnN0IHN0YXRlIGluIHRoZSBsaXN0IGlzIGEgcm9vdCBvZiBhbGwgdGhlIG90aGVycywgaXQgd2lsbCB0cmF2ZXJzZSB0aGF0IGZhciB0aHJvdWdoIHRoZSBvdGhlcnMuXG5cbiAgICBpZiAoc3RhdGVUYWdzLmxlbmd0aCA8PSAxKSByZXR1cm4gc3RhdGVUYWdzO1xuXG4gICAgLy8gQ2hlY2sgZWFjaCBzdGF0ZSBpbiB0aGUgZmlyc3Qgc3RhdGUncyBhbmNlc3RyeSwgYWdhaW5zdCBhbGwgb3RoZXIgc3RhdGVzLCBidXQgb25seSBnbyBhcyBkZWVwIGFzIG5lZWRlZC5cbiAgICBsZXQgW29yaWdpbmFsQ2FuZGlkYXRlVGFnLCAuLi5vcmlnaW5hbE90aGVyU3RhdGVUYWdzXSA9IHN0YXRlVGFncztcbiAgICBsZXQgY2FuZGlkYXRlVGFnID0gb3JpZ2luYWxDYW5kaWRhdGVUYWc7IC8vIFdpbGwgdGFrZSBvbiBzdWNjZXNzaXZlIHZhbHVlcyBpbiB0aGUgb3JpZ2luYWxDYW5kaWRhdGVUYWcgaGlzdG9yeS5cblxuICAgIC8vIEFzIHdlIGRlc2NlbmQgdGhyb3VnaCB0aGUgZmlyc3Qgc3RhdGUncyBjYW5kaWRhdGVzLCBrZWVwIHRyYWNrIG9mIHdoYXQgd2UgaGF2ZSBzZWVuIGFuZCBnYXRoZXJlZC5cbiAgICBsZXQgY2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMgPSBuZXcgTWFwKCk7XG4gICAgLy8gRm9yIGVhY2ggb2YgdGhlIG90aGVyIHN0YXRlcyAoYXMgZWxlbWVudHMgaW4gdGhyZWUgYXJyYXlzKTpcbiAgICBjb25zdCBvdGhlclN0YXRlVGFncyA9IFsuLi5vcmlnaW5hbE90aGVyU3RhdGVUYWdzXTsgLy8gV2lsbCBiZSBiYXNoZWQgYXMgd2UgZGVzY2VuZC5cbiAgICBjb25zdCBvdGhlclZlcmlmaWVkU3RhdGVzID0gb3RoZXJTdGF0ZVRhZ3MubWFwKCgpID0+IFtdKTsgICAgIC8vIEJ1aWxkIHVwIGxpc3Qgb2YgdGhlIHZlcmlmaWVkU3RhdGVzIHNlZW4gc28gZmFyLlxuICAgIGNvbnN0IG90aGVyc1NlZW4gPSBvdGhlclN0YXRlVGFncy5tYXAoKCkgPT4gbmV3IE1hcCgpKTsgLy8gS2VlcCBhIG1hcCBvZiBlYWNoIGhhc2ggPT4gdmVyaWZpZWRTdGF0ZXMgc2VlbiBzbyBmYXIuXG4gICAgLy8gV2UgcmVzZXQgdGhlc2UsIHNwbGljaW5nIG91dCB0aGUgb3RoZXIgZGF0YS5cbiAgICBmdW5jdGlvbiByZXNldChuZXdDYW5kaWRhdGUsIG90aGVySW5kZXgpIHsgLy8gUmVzZXQgdGhlIGFib3ZlIGZvciBhbm90aGVyIGl0ZXJhdGlvbiB0aHJvdWdoIHRoZSBmb2xsb3dpbmcgbG9vcCxcbiAgICAgIC8vIHdpdGggb25lIG9mIHRoZSBvdGhlckRhdGEgcmVtb3ZlZCAoYW5kIHRoZSBzZWVuL3ZlcmlmaWVkU3RhdGVzIGZvciB0aGUgcmVtYWluaW5nIGludGFjdCkuXG4gICAgICAvLyBUaGlzIGlzIHVzZWQgd2hlbiBvbmUgb2YgdGhlIG90aGVycyBwcm92ZXMgdG8gYmUgYSBzdWJzZXQgb3Igc3VwZXJzZXQgb2YgdGhlIGNhbmRpZGF0ZS5cbiAgICAgIGNhbmRpZGF0ZVRhZyA9IG5ld0NhbmRpZGF0ZTtcbiAgICAgIGNhbmRpZGF0ZVZlcmlmaWVkU3RhdGVzID0gbnVsbDtcbiAgICAgIFtvcmlnaW5hbE90aGVyU3RhdGVUYWdzLCBvdGhlclN0YXRlVGFncywgb3RoZXJWZXJpZmllZFN0YXRlcywgb3RoZXJzU2Vlbl0uZm9yRWFjaChkYXR1bSA9PiBkYXR1bS5zcGxpY2Uob3RoZXJJbmRleCwgMSkpO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSB2ZXJpZmllZCA9PiB7IC8vIEJ5IHdoaWNoIHRvIGRlZHVwZSBzdGF0ZSByZWNvcmRzLlxuICAgICAgLy8gZml4bWUgY2xlYW51cFxuICAgICAgLy8gSXQgd291bGQgYmUgbmljZSBpZiB3ZSBjYWNoZWQgdGhpcyBpbiB0aGUgcHJvdGVjdGVkIGhlYWRlciwgYnV0IHRoZW4gd2UnZCBoYXZlIHRvIGNoZWNrIGl0IGFueXdheS5cbiAgICAgIC8vcmV0dXJuIHRoaXMuaGFzaCh2ZXJpZmllZCk7XG4gICAgICAvL2NvbnN0IHtraWQsIGFjdCwgaWF0fSA9IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlcjtcblxuICAgICAgLy9yZXR1cm4gdmVyaWZpZWQudGV4dDsgLy8gKyAoYWN0IHx8IGtpZCkgKyBpYXQ7XG4gICAgICByZXR1cm4gdmVyaWZpZWQudGFnO1xuXG4gICAgICAvLyByZXR1cm4gYW50ICsgKGFjdCB8fCBraWQpICsgaWF0O1xuICAgIH07XG4gICAgY29uc3QgaXNDYW5kaWRhdGVJbkV2ZXJ5SGlzdG9yeSA9IGFzeW5jICgpID0+IHsgLy8gVHJ1ZSBJRkYgdGhlIGN1cnJlbnQgY2FuZGlkYXRlVGFnIGFwcGVhciBpbiBhbGwgdGhlIG90aGVycy5cbiAgICAgIGZvciAoY29uc3Qgb3RoZXJJbmRleCBpbiBvdGhlcnNTZWVuKSB7IC8vIFN1YnRsZTogdGhlIGZvbGxvd2luZyBoYXMgc2lkZS1lZmZlY3RzLCBzbyBjYWxscyBtdXN0IGJlIGluIHNlcmllcy5cblx0aWYgKCFhd2FpdCBpc0NhbmRpZGF0ZUluSGlzdG9yeShvdGhlcnNTZWVuW290aGVySW5kZXhdLCBvdGhlckluZGV4KSkgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfTtcbiAgICBjb25zdCBpc0NhbmRpZGF0ZUluSGlzdG9yeSA9IGFzeW5jIChvdGhlclNlZW4sIG90aGVySW5kZXgpID0+IHsgLy8gVHJ1ZSBJRkYgdGhlIGN1cnJlbnQgY2FuZGlkYXRlIGlzIGluIHRoZSBnaXZlbiBTdGF0ZSdzIGhpc3RvcnkuXG4gICAgICAvLyBIb3dldmVyLCBpZiBjYW5kaWRhdGUvb3RoZXIgYXJlIGluIGEgbGluZWFyIGNoYWluLCBhbnN3ZXIgZmFsc2UgYW5kIHJlc2V0IHRoZSBsb29wIHdpdGggb3RoZXIgc3BsaWNlZCBvdXQuXG4gICAgICAvL2NvbnNvbGUubG9nKCdpc0NhbmRpZGF0ZUhpc3RvcnknLCB7b3RoZXJJbmRleCwgb3RoZXJTZWVufSk7XG4gICAgICB3aGlsZSAoIW90aGVyU2Vlbi5oYXMoY2FuZGlkYXRlVGFnKSkgeyAvLyBGYXN0IGNoZWNrIG9mIHdoYXQgd2UndmUgc2VlbiBzbyBmYXIuXG5cdGNvbnN0IG90aGVyVGFnID0gb3RoZXJTdGF0ZVRhZ3Nbb3RoZXJJbmRleF07IC8vIEFzIHdlIGdvLCB3ZSByZWNvcmQgdGhlIGRhdGEgc2VlbiBmb3IgdGhpcyBvdGhlciBTdGF0ZS5cblx0Ly9jb25zb2xlLmxvZyh7b3RoZXJUYWd9KTtcblx0aWYgKCFvdGhlclRhZykgcmV0dXJuIGZhbHNlOyAgICAgICAgICAgICAgICAgICAgICAgICAvLyBJZiBub3QgYXQgZW5kLi4uIGdvIG9uZSBmdXJ0aGVyIGxldmVsIGRlZXBlciBpbiB0aGlzIHN0YXRlLlxuXHRjb25zdCBzZWVuVmVyaWZpZWRTdGF0ZXMgPSBvdGhlclZlcmlmaWVkU3RhdGVzW290aGVySW5kZXhdOyAgIC8vIE5vdGUgaW4gb3VyIGhhc2ggPT4gbWVzc2FnZSBtYXAsIGEgY29weSBvZiB0aGUgdmVyaWZpZWRTdGF0ZXMgc2Vlbi5cblx0b3RoZXJTZWVuLnNldChvdGhlclRhZywgc2VlblZlcmlmaWVkU3RhdGVzLnNsaWNlKCkpOyAgLy8gQW5kIGFkZCB0aGlzIHN0YXRlJ3MgbWVzc2FnZSBmb3Igb3VyIG1lc3NhZ2UgYWNjdW11bGF0b3IuXG5cdGNvbnN0IHZlcmlmaWVkU3RhdGUgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWc6IG90aGVyVGFnLCBtZW1iZXI6IG51bGwsIHN5bmNocm9uaXplOiBmYWxzZX0pO1xuXHQvL2NvbnNvbGUubG9nKHtzZWVuVmVyaWZpZWRTdGF0ZXMsIHZlcmlmaWVkU3RhdGV9KTtcblx0aWYgKHZlcmlmaWVkU3RhdGUpIHNlZW5WZXJpZmllZFN0YXRlcy5wdXNoKHZlcmlmaWVkU3RhdGUpO1xuXHRvdGhlclN0YXRlVGFnc1tvdGhlckluZGV4XSA9IHRoaXMuYW50ZWNlZGVudCh2ZXJpZmllZFN0YXRlKTtcbiAgICAgIH1cbiAgICAgIC8vIElmIGNhbmRpZGF0ZSBvciB0aGUgb3RoZXIgaXMgd2hvbHkgYSBzdWJzZXQgb2YgdGhlIG90aGVyIGluIGEgbGluZWFyIGNoYWluLCBkaXNyZWdhcmQgdGhlIHN1YnNldC5cdCAgXG4gICAgICAvLyBJbiBvdGhlciB3b3Jkcywgc2VsZWN0IHRoZSBsb25nZXIgY2hhaW4gcmF0aGVyIHRoYW4gc2Vla2luZyB0aGUgY29tbW9uIGFuY2VzdG9yIG9mIHRoZSBjaGFpbi5cblxuICAgICAgLy8gT3JpZ2luYWwgY2FuZGlkYXRlIChzaW5jZSByZXNldCkgaXMgYSBzdWJzZXQgb2YgdGhpcyBvdGhlcjogdHJ5IGFnYWluIHdpdGggdGhpcyBvdGhlciBhcyB0aGUgY2FuZGlkYXRlLlxuICAgICAgaWYgKGNhbmRpZGF0ZVRhZyA9PT0gb3JpZ2luYWxDYW5kaWRhdGVUYWcpIHJldHVybiByZXNldChvcmlnaW5hbENhbmRpZGF0ZVRhZyA9IG9yaWdpbmFsT3RoZXJTdGF0ZVRhZ3Nbb3RoZXJJbmRleF0pO1xuICAgICAgLy8gT3JpZ2luYWwgY2FuZGlkYXRlIChzaW5jZSByZXNldCkgaXMgc3VwZXJzZXQgb2YgdGhpcyBvdGhlcjogdHJ5IGFnYWluIHdpdGhvdXQgdGhpcyBjYW5kaWRhdGVcbiAgICAgIGlmIChjYW5kaWRhdGVUYWcgPT09IG9yaWdpbmFsT3RoZXJTdGF0ZVRhZ3Nbb3RoZXJJbmRleF0pIHJldHVybiByZXNldChvcmlnaW5hbENhbmRpZGF0ZVRhZyk7XG4gICAgICByZXR1cm4gdHJ1ZTsgIC8vIFdlIGZvdW5kIGEgbWF0Y2ghXG4gICAgfTtcblxuICAgIC8vY29uc29sZS5sb2coJ3N0YXJ0Jywge3N0YXRlVGFnc30pO1xuICAgIHdoaWxlIChjYW5kaWRhdGVUYWcpIHtcbiAgICAgIC8vY29uc29sZS5sb2coe2NhbmRpZGF0ZVRhZ30pO1xuICAgICAgaWYgKGF3YWl0IGlzQ2FuZGlkYXRlSW5FdmVyeUhpc3RvcnkoKSkgeyAvLyBXZSBmb3VuZCBhIG1hdGNoIGluIGVhY2ggb2YgdGhlIG90aGVyIFN0YXRlczogcHJlcGFyZSByZXN1bHRzLlxuXHQvLyBHZXQgdGhlIHZlcmlmaWVkU3RhdGVzIHRoYXQgd2UgYWNjdW11bGF0ZWQgZm9yIHRoYXQgcGFydGljdWxhciBTdGF0ZSB3aXRoaW4gdGhlIG90aGVycy5cblx0Ly9jb25zb2xlLmxvZygnY29sbGVjdGluZyB2ZXJpZmllZFN0YXRlcyBmb3InLCBjYW5kaWRhdGVUYWcpO1xuXHRvdGhlcnNTZWVuLmZvckVhY2gobWVzc2FnZU1hcCA9PiBtZXNzYWdlTWFwLmdldChjYW5kaWRhdGVUYWcpLmZvckVhY2gobWVzc2FnZSA9PiBjYW5kaWRhdGVWZXJpZmllZFN0YXRlcy5zZXQoa2V5KG1lc3NhZ2UpLCBtZXNzYWdlKSkpO1xuXHRyZXR1cm4gW2NhbmRpZGF0ZVRhZywgLi4uY2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMudmFsdWVzKCldOyAvLyBXZSdyZSBkb25lIVxuICAgICAgfSBlbHNlIGlmIChjYW5kaWRhdGVWZXJpZmllZFN0YXRlcykge1xuXHQvLyBNb3ZlIHRvIHRoZSBuZXh0IGNhbmRpZGF0ZSAob25lIHN0ZXAgYmFjayBpbiB0aGUgZmlyc3Qgc3RhdGUncyBhbmNlc3RyeSkuXG5cdGNvbnN0IHZlcmlmaWVkU3RhdGUgPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWc6IGNhbmRpZGF0ZVRhZywgbWVtYmVyOiBudWxsLCBzeW5jaHJvbml6ZTogZmFsc2V9KTtcblx0aWYgKCF2ZXJpZmllZFN0YXRlKSByZXR1cm4gW107IC8vIEZlbGwgb2ZmIHRoZSBlbmQuXG5cdFx0Y2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMuc2V0KGtleSh2ZXJpZmllZFN0YXRlKSwgdmVyaWZpZWRTdGF0ZSk7XG5cdGNhbmRpZGF0ZVRhZyA9IHRoaXMuYW50ZWNlZGVudCh2ZXJpZmllZFN0YXRlKTtcbiAgICAgIH0gZWxzZSB7IC8vIFdlJ3ZlIGJlZW4gcmVzZXQgdG8gc3RhcnQgb3Zlci5cblx0Y2FuZGlkYXRlVmVyaWZpZWRTdGF0ZXMgPSBuZXcgTWFwKCk7XG4gICAgICB9XG4gICAgfSAvLyBlbmQgd2hpbGVcblxuICAgIHJldHVybiBbXTsgICAvLyBObyBjb21tb24gYW5jZXN0b3IgZm91bmRcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbiBleHRlbmRzIE11dGFibGVDb2xsZWN0aW9uIHtcbiAgLy8gQSBWZXJzaW9uZWRDb2xsZWN0aW9uIGNhbiBiZSB1c2VkIGxpa2UgYW55IE11dGFibGVDb2xsZWN0aW9uLCByZXRyaWV2aW5nIHRoZSBtb3N0IHJlY2VudGx5IHN0b3JlZCBzdGF0ZS5cbiAgLy8gSXQgaGFzIHR3byBhZGRpdGlvbmFsIGZ1bmN0aW9uYWxpdGllczpcbiAgLy8gMS4gUHJldmlvdXMgc3RhdGVzIGNhbiBiZSByZXRyaWV2ZWQsIGVpdGhlciBieSB0YWcgb3IgYnkgdGltZXN0YW1wLlxuICAvLyAyLiBJRkYgdGhlIGRhdGEgcHJvdmlkZWQgYnkgdGhlIGFwcGxpY2F0aW9uIGluY2x1ZGVzIGEgc2luZ2xlIG1lc3NhZ2UsIGFjdGlvbiwgb3IgZGVsdGEgZm9yIGVhY2ggdmVyc2lvbixcbiAgLy8gICAgdGhlbiwgbWVyZ2luZyBvZiB0d28gYnJhbmNoZXMgb2YgdGhlIHNhbWUgaGlzdG9yeSBjYW4gYmUgYWNjb21wbGlzaGVkIGJ5IGFwcGx5aW5nIHRoZXNlIG1lc3NhZ2VzIHRvXG4gIC8vICAgIHJlY29uc3RydWN0IGEgY29tYmluZWQgaGlzdG9yeSAoc2ltaWxhcmx5IHRvIGNvbWJpbmluZyBicmFuY2hlcyBvZiBhIHRleHQgdmVyc2lvbmluZyBzeXN0ZW0pLlxuICAvLyAgICBJbiB0aGlzIGNhc2UsIHRoZSBhcHBsaWNhdGlvbiBtdXN0IHByb3ZpZGUgdGhlIG9wZXJhdGlvbiB0byBwcm9kdWNlIGEgbmV3IHN0YXRlIGZyb20gYW4gYW50ZWNlZGVudCBzdGF0ZVxuICAvLyAgICBhbmQgbWVzc3NhZ2UsIGFuZCB0aGUgVmVyc2lvbmVkQ29sbGVjdGlvbiB3aWxsIHByb3ZpZGUgdGhlIGNvcnJlY3QgY2FsbHMgdG8gbWFuYWdlIHRoaXMuXG4gIGFzeW5jIHN0b3JlKGRhdGEsIHRhZ09yT3B0aW9ucyA9IHt9KSB7XG4gICAgLy8gSGlkZGVuIHB1bjpcbiAgICAvLyBUaGUgZmlyc3Qgc3RvcmUgbWlnaHQgc3VjY2VlZCwgZW1pdCB0aGUgdXBkYXRlIGV2ZW50LCBwZXJzaXN0Li4uIGFuZCB0aGVuIGZhaWwgb24gdGhlIHNlY29uZCBzdG9yZS5cbiAgICAvLyBIb3dldmVyLCBpdCBqdXN0IHNvIGhhcHBlbnMgdGhhdCB0aGV5IGJvdGggZmFpbCB1bmRlciB0aGUgc2FtZSBjaXJjdW1zdGFuY2VzLiBDdXJyZW50bHkuXG4gICAgbGV0IHt0YWcsIGVuY3J5cHRpb24sIC4uLm9wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zKTtcbiAgICBjb25zdCByb290ID0gdGFnICYmIGF3YWl0IHRoaXMuZ2V0Um9vdCh0YWcsIGZhbHNlKTtcbiAgICAvLyBUYWcgaXMgdXN1YWxseSBzcGVjaWZpZWQsIGJ1dCBpZiBpdCBpc24ndCBnZW5lcmF0ZSBhIHVuaXF1ZSBvbmUgbm93IHNvIHRoYXQgd2UgYWx3YXlzIGhhdmUgYSBzdWIgdG9cbiAgICAvLyBwdXQgaW4gdGhlIHN0YXRlIHNpZ25hdHVyZS4gVGhhdCdzIG5lZWRlZCBzbyB0aGF0IHVwZGF0ZSBldmVudHMgY2FuIHBvaW50IGJhY2sgdG8gdGhlIFZlcnNpb25lZCBpdGVtIHRhZy5cbiAgICB0YWcgfHw9IGF3YWl0IHRoaXMuaGFzaCh7dGV4dDogSlNPTi5zdHJpbmdpZnkoZGF0YSl9KTsgLy8gRklYTUU6IGJpbmFyeSwgdG9vLlxuICAgIGNvbnN0IHZlcnNpb25UYWcgPSBhd2FpdCB0aGlzLnZlcnNpb25zLnN0b3JlKGRhdGEsIHtlbmNyeXB0aW9uLCBhbnQ6IHJvb3QsIHN1YmplY3Q6IHRhZywgLi4ub3B0aW9uc30pO1xuICAgIHRoaXMubG9nKCdzdG9yZTogcm9vdCcsIHt0YWcsIGVuY3J5cHRpb24sIG9wdGlvbnMsIHJvb3QsIHZlcnNpb25UYWd9KTtcbiAgICBpZiAoIXZlcnNpb25UYWcpIHJldHVybiAnJztcbiAgICBjb25zdCBzaWduaW5nT3B0aW9ucyA9IHtcbiAgICAgIHRhZzogdGFnIHx8IHZlcnNpb25UYWcsXG4gICAgICBlbmNyeXB0aW9uOiAnJyxcbiAgICAgIC4uLm9wdGlvbnNcbiAgICB9O1xuICAgIHJldHVybiBzdXBlci5zdG9yZShbdmVyc2lvblRhZ10sIHNpZ25pbmdPcHRpb25zKTtcbiAgfVxuICBhc3luYyByZW1vdmUodGFnT3JPcHRpb25zKSB7XG4gICAgY29uc3Qge3RhZywgLi4ub3B0aW9uc30gPSB0aGlzLl9jYW5vbmljYWxpemVPcHRpb25zMSh0YWdPck9wdGlvbnMpO1xuICAgIGF3YWl0IHRoaXMuZm9yRWFjaFN0YXRlKHRhZywgKF8sIGhhc2gpID0+IHsgLy8gU3VidGxlOiBkb24ndCByZXR1cm4gZWFybHkgYnkgcmV0dXJuaW5nIHRydXRoeS5cbiAgICAgIC8vIFRoaXMgbWF5IGJlIG92ZXJraWxsIHRvIGJlIHVzaW5nIGhpZ2gtbGV2ZWwgcmVtb3ZlLCBpbnN0ZWFkIG9mIHB1dCBvciBldmVuIHBlcnNpc3QuIFdlIERPIHdhbnQgdGhlIHVwZGF0ZSBldmVudCB0byBmaXJlIVxuICAgICAgLy8gU3VidGxlOiB0aGUgYW50IGlzIG5lZWRlZCBzbyB0aGF0IHdlIGRvbid0IHNpbGVudGx5IHNraXAgdGhlIGFjdHVhbCBwdXQvZXZlbnQuXG4gICAgICAvLyBTdWJ0bGU6IHN1YmplY3QgaXMgbmVlZGVkIHNvIHRoYXQgdXBkYXRlIGV2ZW50cyBjYW4gbGVhcm4gdGhlIFZlcnNpb25lZCBzdGFnLlxuICAgICAgdGhpcy52ZXJzaW9ucy5yZW1vdmUoe3RhZzogaGFzaCwgYW50OiBoYXNoLCBzdWJqZWN0OiB0YWcsIC4uLm9wdGlvbnN9KTtcbiAgICB9KTtcbiAgICByZXR1cm4gc3VwZXIucmVtb3ZlKHRhZ09yT3B0aW9ucyk7XG4gIH1cbiAgYXN5bmMgcmV0cmlldmUodGFnT3JPcHRpb25zKSB7XG4gICAgbGV0IHt0YWcsIHRpbWUsIGhhc2gsIC4uLm9wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9uczEodGFnT3JPcHRpb25zKTtcbiAgICBpZiAoIWhhc2ggJiYgIXRpbWUpIGhhc2ggPSBhd2FpdCB0aGlzLmdldFJvb3QodGFnKTtcbiAgICB0aGlzLmxvZygncmV0cmlldmUnLCB7dGFnLCB0aW1lLCBoYXNoLCBvcHRpb25zfSk7XG4gICAgaWYgKGhhc2gpIHJldHVybiB0aGlzLnZlcnNpb25zLnJldHJpZXZlKHt0YWc6IGhhc2gsIC4uLm9wdGlvbnN9KTtcbiAgICB0aW1lID0gcGFyc2VGbG9hdCh0aW1lKTtcbiAgICByZXR1cm4gdGhpcy5mb3JFYWNoU3RhdGUodGFnLCB2ZXJpZmllZCA9PiAodmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmlhdCA8PSB0aW1lKSAmJiB2ZXJpZmllZCk7XG4gIH1cblxuICBjaGVja0RhdGUoZXhpc3RpbmcsIHByb3Bvc2VkKSB7IC8vIENhbiBhbHdheXMgbWVyZ2UgaW4gYW4gb2xkZXIgbWVzc2FnZS4gV2Uga2VlcCAnZW0gYWxsLlxuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGdldE93bmVyKHByb3RlY3RlZEhlYWRlcikgeyAvLyBSZXR1cm4gdGhlIHRhZyBvZiB3aGF0IHNoYWxsIGJlIGNvbnNpZGVyZWQgdGhlIG93bmVyLlxuICAgIHJldHVybiBwcm90ZWN0ZWRIZWFkZXIuZ3JvdXAgfHwgc3VwZXIuZ2V0T3duZXIocHJvdGVjdGVkSGVhZGVyKTtcbiAgfVxuICBcbiAgYXN5bmMgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlKSB7XG4gICAgY29uc3Qgc3RhdGVzID0gdmFsaWRhdGlvbi5qc29uIHx8IFtdO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdmFsaWRhdGlvbi5leGlzdGluZz8uanNvbiB8fCBbXTtcbiAgICB0aGlzLmxvZygnbWVyZ2VTaWduYXR1cmVzJywge3RhZywgZXhpc3RpbmcsIHN0YXRlc30pO1xuICAgIGlmIChzdGF0ZXMubGVuZ3RoID09PSAxICYmICFleGlzdGluZy5sZW5ndGgpIHJldHVybiBzaWduYXR1cmU7IC8vIEluaXRpYWwgY2FzZS4gVHJpdmlhbC5cbiAgICBpZiAoZXhpc3RpbmcubGVuZ3RoID09PSAxICYmICFzdGF0ZXMubGVuZ3RoKSByZXR1cm4gdmFsaWRhdGlvbi5leGlzdGluZy5zaWduYXR1cmU7XG5cbiAgICAvLyBMZXQncyBzZWUgaWYgd2UgY2FuIHNpbXBsaWZ5XG4gICAgY29uc3QgY29tYmluZWQgPSBbLi4uc3RhdGVzLCAuLi5leGlzdGluZ107XG4gICAgbGV0IFtjb21tb25BbmNlc3RvciwgLi4udmVyc2lvbnNUb1JlcGxheV0gPSBhd2FpdCB0aGlzLnZlcnNpb25zLmNvbW1vblN0YXRlQW5kTWVzc2FnZXMoY29tYmluZWQpO1xuICAgIHRoaXMubG9nKCdtZXJnZVNpZ25hdHVyZXMnLCB7dGFnLCBleGlzdGluZywgc3RhdGVzLCBjb21tb25BbmNlc3RvciwgdmVyc2lvbnNUb1JlcGxheX0pO1xuICAgIGlmIChjb21iaW5lZC5sZW5ndGggPT09IDIpIHsgLy8gQ29tbW9uIGNhc2VzIHRoYXQgY2FuIGJlIGhhbmRsZWQgd2l0aG91dCBiZWluZyBhIG1lbWJlclxuICAgICAgaWYgKGNvbW1vbkFuY2VzdG9yID09PSBzdGF0ZXNbMF0pIHJldHVybiBzaWduYXR1cmU7XG4gICAgICBpZiAoY29tbW9uQW5jZXN0b3IgPT09IGV4aXN0aW5nWzBdKSByZXR1cm4gdmFsaWRhdGlvbi5leGlzdGluZy5zaWduYXR1cmU7XG4gICAgfVxuXG4gICAgY29uc3QgY2xhaW1zID0gdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXI7XG4gICAgY29uc3Qgb3duZXIgPSB0aGlzLmdldE93bmVyKGNsYWltcyk7XG4gICAgLy9sZXQgc2lnbmluZ0FzID0gb3duZXIgPT09IGNsYWltcy5raWQgPyB7dGFnczogW293bmVyXSwgZ3JvdXA6IG93bmVyfSA6IHt0ZWFtOiBvd25lciwgZ3JvdXA6IG93bmVyfTtcbiAgICBsZXQgc2lnbmluZ0FzID0ge3RhZ3M6IFtvd25lcl0sIGdyb3VwOiBvd25lcn07XG4gICAgaWYgKCFhd2FpdCB0aGlzLnNpZ24oJ2FueXRoaW5nJywgc2lnbmluZ0FzKS5jYXRjaCgoKSA9PiBmYWxzZSkpIHsgLy8gV2UgZG9uJ3QgaGF2ZSBhY2Nlc3MuXG4gICAgICAvL3NpZ25pbmdBcyA9IHtncm91cDogb3duZXIsIHRhZ3M6IFttZXJnZUF1dGhvck92ZXJyaWRlIHx8IENyZWRlbnRpYWxzLmF1dGhvcl19O1xuICAgICAgc2lnbmluZ0FzLnRhZ3MgPSBbQ3JlZGVudGlhbHMuYXV0aG9yXTtcbiAgICAgIHJldHVybiB0aGlzLnNpZ24oY29tYmluZWQsIHNpZ25pbmdBcyk7XG4gICAgfVxuICAgIC8vY29uc29sZS5sb2codGhpcy5sYWJlbC5zbGljZSgwLCAxKSwgJ21lcmdlU2lnbmF0dXJlcycsIHN0YXRlcy5tYXAodGFnID0+IHRoaXMudHJpbSh0YWcpKSwgZXhpc3RpbmcubWFwKHRhZyA9PiB0aGlzLnRyaW0odGFnKSksIHZlcnNpb25zVG9SZXBsYXkubWFwKHYgPT4gdGhpcy5zdWNjaW5jdCh2KSkpO1xuICAgIGlmICghY29tbW9uQW5jZXN0b3IpIHZlcnNpb25zVG9SZXBsYXkgPSBhd2FpdCBQcm9taXNlLmFsbChjb21iaW5lZC5tYXAoYXN5bmMgc3RhdGVUYWcgPT4gdGhpcy52ZXJzaW9ucy5nZXRWZXJpZmllZCh7dGFnOiBzdGF0ZVRhZywgc3luY2hyb25pemU6IGZhbHNlfSkpKTtcbiAgICB2ZXJzaW9uc1RvUmVwbGF5LnNvcnQoKGEsIGIpID0+IGEucHJvdGVjdGVkSGVhZGVyLmlhdCAtIGIucHJvdGVjdGVkSGVhZGVyLmlhdCk7XG4gICAgbGV0IHN0YXRlID0gY29tbW9uQW5jZXN0b3I7XG4gICAgdGhpcy5sb2coJ21lcmdlU2lnbmF0dXJlcyByZXBsYXlpbmcnLCB7dGFnLCBzdGF0ZSwgdmVyc2lvbnNUb1JlcGxheSwgdGltZXM6IHZlcnNpb25zVG9SZXBsYXkubWFwKHYgPT4gdi5wcm90ZWN0ZWRIZWFkZXIuaWF0KX0pO1xuICAgIGZvciAobGV0IHZlcmlmaWVkIG9mIHZlcnNpb25zVG9SZXBsYXkpIHtcbiAgICAgIC8vIFRPRE86IHNob3VsZCBnbyB0aHJvdWdoIHRoZSBhcHBsaWNhdGlvbiBhcyBpdCBtaWdodCBkbyBzb21ldGhpbmcgd2l0aCB0aGUgZGF0YS5cbiAgICAgIGlmICh2ZXJpZmllZC5hbnQgPT09IHN0YXRlKSB7XG5cdHN0YXRlID0gdmVyaWZpZWQudGFnO1xuICAgICAgfSBlbHNlIHtcblx0Y29uc3QgZGF0YSA9IHZlcmlmaWVkLnRleHQgfHwgdmVyaWZpZWQucGF5bG9hZDsgLy8gZml4bWU6IGpzb24gaWYgcG9zc2libGUsIGJ1dCBkb24ndCBkb3VibGUgcXVvdGUhXG5cdGNvbnN0IHNpZ25pbmdPcHRpb25zID0ge2FudDogc3RhdGUsIGlhdDogdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmlhdCwgLi4uc2lnbmluZ0FzfTtcblx0Ly9jb25zb2xlLmxvZyh7c2lnbmluZ09wdGlvbnN9KTtcblx0Y29uc3Qgc3RhdGVTaWduYXR1cmUgPSBhd2FpdCB0aGlzLnZlcnNpb25zLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpOyAvLyBGSVhNRTogcHJlc2VydmUgZW5jcnlwdGlvbiBvZiB2ZXJpZmllZFxuXHRjb25zdCBzdGF0ZTAgPSBhd2FpdCB0aGlzLnZlcnNpb25zLmhhc2goe3RleHQ6IGRhdGEsIHByb3RlY3RlZEhlYWRlcjogc2lnbmluZ09wdGlvbnN9KTsgLy8gZml4bWUgcmUganNvblxuXHRzdGF0ZSA9IGF3YWl0IHRoaXMudmVyc2lvbnMucHV0KHN0YXRlMCwgc3RhdGVTaWduYXR1cmUsIHZlcmlmaWVkLnN5bmNocm9uaXplcik7XG5cdC8vc3RhdGUgPSBhd2FpdCB0aGlzLnZlcnNpb25zLnN0b3JlKGRhdGEsIHNpZ25pbmdPcHRpb25zKTsgXG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGZpeG1lID0gYXdhaXQgdGhpcy5zaWduKFtzdGF0ZV0sIHNpZ25pbmdBcyk7XG4gICAgLy9jb25zb2xlLmxvZygnbm9ybWFsIHBhdGggc2lnbmVkIGFzJywgc2lnbmluZ0FzKTtcbiAgICByZXR1cm4gZml4bWU7XG4gIH1cblxuICBhc3luYyBnZXRSb290KHRhZywgc3luY2hyb25pemUgPSB0cnVlKSB7IC8vIFByb21pc2UgdGhlIHRhZyBvZiB0aGUgbW9zdCByZWNlbnQgc3RhdGVcbiAgICBjb25zdCB2ZXJpZmllZFZlcnNpb24gPSBhd2FpdCB0aGlzLmdldFZlcmlmaWVkKHt0YWcsIG1lbWJlcnM6IG51bGwsIHN5bmNocm9uaXplfSk7XG4gICAgdGhpcy5sb2coJ2dldFJvb3QnLCB7dGFnLCB2ZXJpZmllZFZlcnNpb259KTtcbiAgICBpZiAoIXZlcmlmaWVkVmVyc2lvbikgcmV0dXJuICcnO1xuICAgIGNvbnN0IHN0YXRlcyA9IHZlcmlmaWVkVmVyc2lvbi5qc29uO1xuICAgIGlmIChzdGF0ZXMubGVuZ3RoICE9PSAxKSByZXR1cm4gUHJvbWlzZS5yZWplY3QoYFVubWVyZ2VkIHN0YXRlcyBpbiAke3RhZ30uYCk7XG4gICAgcmV0dXJuIHN0YXRlc1swXTtcbiAgfVxuICBhc3luYyBmb3JFYWNoU3RhdGUodGFnLCBjYWxsYmFjaykge1xuICAgIC8vIEdldCB0aGUgcm9vdCBvZiB0aGlzIGl0ZW0gYXQgdGFnLCBhbmQgY2FsbGJhY2sodmVyaWZpZWRTdGF0ZSwgc3RhdGVUYWcpIG9uIHRoZSBjaGFpbi5cbiAgICAvLyBTdG9wcyBpdGVyYXRpb24gYW5kIHJldHVybnMgdGhlIGZpcnN0IHRydXRoeSB2YWx1ZSBmcm9tIGNhbGxiYWNrLlxuICAgIGNvbnN0IHJvb3QgPSBhd2FpdCB0aGlzLmdldFJvb3QodGFnLCBmYWxzZSk7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMudmVyc2lvbnMuZm9yRWFjaFN0YXRlKHJvb3QsIGNhbGxiYWNrKTtcbiAgfVxuXG4gIC8vIFRoZXNlIGFyZSBtb3N0bHkgZm9yIGRlYnVnZ2luZyBhbmQgYXV0b21hdGVkIHRlc3RpbmcsIGFzIHRoZXkgaGF2ZSB0byB0aHJvdWdoIHRoZSBzdGF0ZSBjaGFpbi5cbiAgLy8gQnV0IHRoZXkgYWxzbyBpbGx1c3RyYXRlIGhvdyB0aGluZ3Mgd29yay5cbiAgYXN5bmMgcmV0cmlldmVUaW1lc3RhbXBzKHRhZykgeyAvLyBQcm9taXNlcyBhIGxpc3Qgb2YgYWxsIHZlcnNpb24gdGltZXN0YW1wcy5cbiAgICBsZXQgdGltZXMgPSBbXTtcbiAgICBhd2FpdCB0aGlzLmZvckVhY2hTdGF0ZSh0YWcsIHZlcmlmaWVkID0+IHsgLy8gU3VidGxlOiByZXR1cm4gbm90aGluZy4gKERvbid0IGJhaWwgZWFybHkuKVxuICAgICAgdGltZXMucHVzaCh2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuaWF0KTtcbiAgICB9KTtcbiAgICByZXR1cm4gdGltZXMucmV2ZXJzZSgpO1xuICB9ICBcbiAgYXN5bmMgZ2V0VmVyc2lvbnModGFnKSB7IC8vIFByb21pc2VzIHRoZSBwYXJzZWQgdGltZXN0YW1wID0+IHZlcnNpb24gZGljdGlvbmFyeSBJRiBpdCBleGlzdHMsIGVsc2UgZmFsc3kuXG4gICAgbGV0IHRpbWVzID0ge30sIGxhdGVzdDtcbiAgICBhd2FpdCB0aGlzLmZvckVhY2hTdGF0ZSh0YWcsICh2ZXJpZmllZCwgdGFnKSA9PiB7XG4gICAgICBpZiAoIWxhdGVzdCkgbGF0ZXN0ID0gdmVyaWZpZWQucHJvdGVjdGVkSGVhZGVyLmlhdDtcbiAgICAgIHRpbWVzW3ZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5pYXRdID0gdGFnO1xuICAgIH0pO1xuICAgIGxldCByZXZlcnNlZCA9IHtsYXRlc3Q6IGxhdGVzdH07XG4gICAgT2JqZWN0LmVudHJpZXModGltZXMpLnJldmVyc2UoKS5mb3JFYWNoKChbaywgdl0pID0+IHJldmVyc2VkW2tdID0gdik7XG4gICAgcmV0dXJuIHJldmVyc2VkO1xuICB9XG5cbiAgLy8gTWFpbnRhaW5pbmcgYW4gYXV4aWxpYXJ5IGNvbGxlY3Rpb24gaW4gd2hpY2ggc3RvcmUgdGhlIHZlcnNpb25zIGFzIGltbXV0YWJsZXMuXG4gIHN0YXRpYyBzdGF0ZUNvbGxlY3Rpb25DbGFzcyA9IFN0YXRlQ29sbGVjdGlvbjsgLy8gU3ViY2xjYXNzZXMgbWF5IGV4dGVuZC5cbiAgY29uc3RydWN0b3Ioe3NlcnZpY2VzID0gW10sIC4uLnJlc3R9ID0ge30pIHtcbiAgICBzdXBlcihyZXN0KTsgIC8vIFdpdGhvdXQgcGFzc2luZyBzZXJ2aWNlcyB5ZXQsIGFzIHdlIGRvbid0IGhhdmUgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24gc2V0IHVwIHlldC5cbiAgICB0aGlzLnZlcnNpb25zID0gbmV3IHRoaXMuY29uc3RydWN0b3Iuc3RhdGVDb2xsZWN0aW9uQ2xhc3MocmVzdCk7IC8vIFNhbWUgY29sbGVjdGlvbiBuYW1lLCBidXQgZGlmZmVyZW50IHR5cGUuXG4gICAgLy9maXhtZSB0aGlzLnZlcnNpb25zLmFkZEV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIGV2ZW50ID0+IHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHRoaXMucmVjb3ZlclRhZyhldmVudC5kZXRhaWwpfSkpKTtcbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTsgLy8gTm93IHdlIGNhbiBzeW5jaHJvbml6ZS5cbiAgfVxuICBhc3luYyBjbG9zZSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmNsb3NlKCk7XG4gICAgYXdhaXQgc3VwZXIuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVzdHJveSgpO1xuICAgIGF3YWl0IHN1cGVyLmRlc3Ryb3koKTtcbiAgfVxuICAvLyBTeW5jaHJvbml6YXRpb24gb2YgdGhlIGF1eGlsaWFyeSBjb2xsZWN0aW9uLlxuICBzZXJ2aWNlRm9yVmVyc2lvbihzZXJ2aWNlKSB7IC8vIEdldCB0aGUgc2VydmljZSBcIm5hbWVcIiBmb3Igb3VyIHZlcnNpb25zIGNvbGxlY3Rpb24uXG4gICAgcmV0dXJuIHNlcnZpY2U/LnZlcnNpb25zIHx8IHNlcnZpY2U7ICAgLy8gRm9yIHRoZSB3ZWlyZCBjb25uZWN0RGlyZWN0VGVzdGluZyBjYXNlIHVzZWQgaW4gcmVncmVzc2lvbiB0ZXN0cywgZWxzZSB0aGUgc2VydmljZSAoZS5nLiwgYW4gYXJyYXkgb2Ygc2lnbmFscykuXG4gIH1cbiAgc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSB7XG4gICAgcmV0dXJuIHNlcnZpY2VzLm1hcChzZXJ2aWNlID0+IHRoaXMuc2VydmljZUZvclZlcnNpb24oc2VydmljZSkpO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSB7IC8vIHN5bmNocm9uaXplIHRoZSB2ZXJzaW9ucyBjb2xsZWN0aW9uLCB0b28uXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHJldHVybjtcbiAgICAvLyBLZWVwIGNoYW5uZWwgY3JlYXRpb24gc3luY2hyb25vdXMuXG4gICAgY29uc3QgdmVyc2lvbmVkUHJvbWlzZSA9IHN1cGVyLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTtcbiAgICBjb25zdCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbnMuc3luY2hyb25pemUoLi4udGhpcy5zZXJ2aWNlc0ZvclZlcnNpb24oc2VydmljZXMpKTtcbiAgICBhd2FpdCB2ZXJzaW9uZWRQcm9taXNlO1xuICAgIGF3YWl0IHZlcnNpb25Qcm9taXNlO1xuICB9XG4gIGFzeW5jIGRpc2Nvbm5lY3QoLi4uc2VydmljZXMpIHsgLy8gZGlzY29ubmVjdCB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiwgdG9vLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSBzZXJ2aWNlcyA9IHRoaXMuc2VydmljZXM7XG4gICAgYXdhaXQgdGhpcy52ZXJzaW9ucy5kaXNjb25uZWN0KC4uLnRoaXMuc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSk7XG4gICAgYXdhaXQgc3VwZXIuZGlzY29ubmVjdCguLi5zZXJ2aWNlcyk7XG4gIH1cbiAgZ2V0IHN5bmNocm9uaXplZCgpIHsgLy8gcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gc3luY2hyb25pemF0aW9uIGlzIGNvbXBsZXRlIGluIEJPVEggZGlyZWN0aW9ucy5cbiAgICAvLyBUT0RPPyBUaGlzIGRvZXMgbm90IHJlZmxlY3QgY2hhbmdlcyBhcyBTeW5jaHJvbml6ZXJzIGFyZSBhZGRlZCBvciByZW1vdmVkIHNpbmNlIGNhbGxlZC4gU2hvdWxkIGl0P1xuICAgIHJldHVybiB0aGlzLnZlcnNpb25zLnN5bmNocm9uaXplZC50aGVuKCgpID0+IHN1cGVyLnN5bmNocm9uaXplZCk7XG4gIH1cbiAgZ2V0IGl0ZW1FbWl0dGVyKCkgeyAvLyBUaGUgdmVyc2lvbnMgY29sbGVjdGlvbiBlbWl0cyBhbiB1cGRhdGUgY29ycmVzcG9uZGluZyB0byB0aGUgaW5kaXZpZHVhbCBpdGVtIHN0b3JlZC5cbiAgICAvLyAoVGhlIHVwZGF0ZXMgZW1pdHRlZCBmcm9tIHRoZSB3aG9sZSBtdXRhYmxlIFZlcnNpb25lZENvbGxlY3Rpb24gY29ycmVzcG9uZCB0byB0aGUgdmVyc2lvbiBzdGF0ZXMuKVxuICAgIHJldHVybiB0aGlzLnZlcnNpb25zO1xuICB9XG59XG5cbi8vIFdoZW4gcnVubmluZyBpbiBOb2RlSlMsIHRoZSBTZWN1cml0eSBvYmplY3QgaXMgYXZhaWxhYmxlIGRpcmVjdGx5LlxuLy8gSXQgaGFzIGEgU3RvcmFnZSBwcm9wZXJ0eSwgd2hpY2ggZGVmaW5lcyBzdG9yZS9yZXRyaWV2ZSAoaW4gbGliL3N0b3JhZ2UubWpzKSB0byBHRVQvUFVUIG9uXG4vLyAuLi4vOmZ1bGxMYWJlbC86cGFydDFvZlRhZy86cGFydDJvZlRhZy86cGFydDNvZlRhZy86cmVzdE9mVGFnLmpzb25cbi8vIFRoZSBTZWN1cml0eS5TdG9yYWdlIGNhbiBiZSBzZXQgYnkgY2xpZW50cyB0byBzb21ldGhpbmcgZWxzZS5cbi8vXG4vLyBXaGVuIHJ1bm5pbmcgaW4gYSBicm93c2VyLCB3b3JrZXIuanMgb3ZlcnJpZGVzIHRoaXMgdG8gc2VuZCBtZXNzYWdlcyB0aHJvdWdoIHRoZSBKU09OIFJQQ1xuLy8gdG8gdGhlIGFwcCwgd2hpY2ggdGhlbiBhbHNvIGhhcyBhbiBvdmVycmlkYWJsZSBTZWN1cml0eS5TdG9yYWdlIHRoYXQgaXMgaW1wbGVtZW50ZWQgd2l0aCB0aGUgc2FtZSBjb2RlIGFzIGFib3ZlLlxuXG4vLyBCYXNoIGluIHNvbWUgbmV3IHN0dWZmOlxuQ3JlZGVudGlhbHMuYXV0aG9yID0gbnVsbDtcbkNyZWRlbnRpYWxzLm93bmVyID0gbnVsbDtcbkNyZWRlbnRpYWxzLmVuY3J5cHRpb24gPSBudWxsOyAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBhdWRpZW5jZVxuQ3JlZGVudGlhbHMuc3luY2hyb25pemUgPSBhc3luYyAoLi4uc2VydmljZXMpID0+IHsgLy8gVE9ETzogcmVuYW1lIHRoaXMgdG8gY29ubmVjdC5cbiAgLy8gV2UgY2FuIGRvIGFsbCB0aHJlZSBpbiBwYXJhbGxlbCAtLSB3aXRob3V0IHdhaXRpbmcgZm9yIGNvbXBsZXRpb24gLS0gYmVjYXVzZSBkZXBlbmRlbmNpZXMgd2lsbCBnZXQgc29ydGVkIG91dCBieSBzeW5jaHJvbml6ZTEuXG4gIHJldHVybiBQcm9taXNlLmFsbChPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKS5tYXAoY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSkpO1xufTtcbkNyZWRlbnRpYWxzLnN5bmNocm9uaXplZCA9IGFzeW5jICgpID0+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uc3luY2hyb25pemVkKSk7XG59XG5DcmVkZW50aWFscy5kaXNjb25uZWN0ID0gYXN5bmMgKC4uLnNlcnZpY2VzKSA9PiB7XG4gIHJldHVybiBQcm9taXNlLmFsbChPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKS5tYXAoY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmRpc2Nvbm5lY3QoLi4uc2VydmljZXMpKSk7XG59XG5cbkNyZWRlbnRpYWxzLmNyZWF0ZUF1dGhvciA9IGFzeW5jIChwcm9tcHQpID0+IHsgLy8gQ3JlYXRlIGEgdXNlcjpcbiAgLy8gSWYgcHJvbXB0IGlzICctJywgY3JlYXRlcyBhbiBpbnZpdGF0aW9uIGFjY291bnQsIHdpdGggYSBuby1vcCByZWNvdmVyeSBhbmQgbm8gZGV2aWNlLlxuICAvLyBPdGhlcndpc2UsIHByb21wdCBpbmRpY2F0ZXMgdGhlIHJlY292ZXJ5IHByb21wdHMsIGFuZCB0aGUgYWNjb3VudCBoYXMgdGhhdCBhbmQgYSBkZXZpY2UuXG4gIGlmIChwcm9tcHQgPT09ICctJykgcmV0dXJuIENyZWRlbnRpYWxzLmNyZWF0ZShhd2FpdCBDcmVkZW50aWFscy5jcmVhdGUoe3Byb21wdH0pKTtcbiAgY29uc3QgW2xvY2FsLCByZWNvdmVyeV0gPSBhd2FpdCBQcm9taXNlLmFsbChbQ3JlZGVudGlhbHMuY3JlYXRlKCksIENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0fSldKTtcbiAgcmV0dXJuIENyZWRlbnRpYWxzLmNyZWF0ZShsb2NhbCwgcmVjb3ZlcnkpO1xufTtcbkNyZWRlbnRpYWxzLmNsYWltSW52aXRhdGlvbiA9IGFzeW5jICh0YWcsIG5ld1Byb21wdCkgPT4geyAvLyBDcmVhdGVzIGEgbG9jYWwgZGV2aWNlIHRhZyBhbmQgYWRkcyBpdCB0byB0aGUgZ2l2ZW4gaW52aXRhdGlvbiB0YWcsXG4gIC8vIHVzaW5nIHRoZSBzZWxmLXZhbGlkYXRpbmcgcmVjb3ZlcnkgbWVtYmVyIHRoYXQgaXMgdGhlbiByZW1vdmVkIGFuZCBkZXN0cm95ZWQuXG4gIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMuVGVhbS5yZXRyaWV2ZSh7dGFnfSk7XG4gIGlmICghdmVyaWZpZWQpIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIHZlcmlmeSBpbnZpdGF0aW9uICR7dGFnfS5gKTtcbiAgY29uc3QgbWVtYmVycyA9IHZlcmlmaWVkLmpzb24ucmVjaXBpZW50cztcbiAgaWYgKG1lbWJlcnMubGVuZ3RoICE9PSAxKSB0aHJvdyBuZXcgRXJyb3IoYEludml0YXRpb25zIHNob3VsZCBoYXZlIG9uZSBtZW1iZXI6ICR7dGFnfWApO1xuICBjb25zdCBvbGRSZWNvdmVyeVRhZyA9IG1lbWJlcnNbMF0uaGVhZGVyLmtpZDtcbiAgY29uc3QgbmV3UmVjb3ZlcnlUYWcgPSBhd2FpdCBDcmVkZW50aWFscy5jcmVhdGUoe3Byb21wdDogbmV3UHJvbXB0fSk7XG4gIGNvbnN0IGRldmljZVRhZyA9IGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSgpO1xuXG4gIC8vIFdlIG5lZWQgdG8gYWRkIHRoZSBuZXcgbWVtYmVycyBpbiBvbmUgY2hhbmdlTWVtYmVyc2hpcCBzdGVwLCBhbmQgdGhlbiByZW1vdmUgdGhlIG9sZFJlY292ZXJ5VGFnIGluIGEgc2Vjb25kIGNhbGwgdG8gY2hhbmdlTWVtYmVyc2hpcDpcbiAgLy8gY2hhbmdlTWVtYmVyc2hpcCB3aWxsIHNpZ24gYnkgYW4gT0xEIG1lbWJlciAtIElmIGl0IHNpZ25lZCBieSBuZXcgbWVtYmVyIHRoYW4gcGVvcGxlIGNvdWxkIGJvb3RzdHJhcCB0aGVtc2VsdmVzIG9udG8gYSB0ZWFtLlxuICAvLyBCdXQgaWYgd2UgcmVtb3ZlIHRoZSBvbGRSZWNvdmVyeSB0YWcgaW4gdGhlIHNhbWUgc3RlcCBhcyBhZGRpbmcgdGhlIG5ldywgdGhlIHRlYW0gd291bGQgYmUgc2lnbmVkIGJ5IHNvbWVvbmUgKHRoZSBvbGRSZWNvdmVyeVRhZykgdGhhdFxuICAvLyBpcyBubyBsb25nZXIgYSBtZW1iZXIsIGFuZCBzbyB0aGUgdGVhbSB3b3VsZCBub3QgdmVyaWZ5IVxuICBhd2FpdCBDcmVkZW50aWFscy5jaGFuZ2VNZW1iZXJzaGlwKHt0YWcsIGFkZDogW2RldmljZVRhZywgbmV3UmVjb3ZlcnlUYWddLCByZW1vdmU6IFtvbGRSZWNvdmVyeVRhZ119KTtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuY2hhbmdlTWVtYmVyc2hpcCh7dGFnLCByZW1vdmU6IFtvbGRSZWNvdmVyeVRhZ119KTtcbiAgYXdhaXQgQ3JlZGVudGlhbHMuZGVzdHJveShvbGRSZWNvdmVyeVRhZyk7XG4gIHJldHVybiB0YWc7XG59O1xuXG4vLyBzZXRBbnN3ZXIgbXVzdCBiZSByZS1wcm92aWRlZCB3aGVuZXZlciB3ZSdyZSBhYm91dCB0byBhY2Nlc3MgcmVjb3Zlcnkga2V5LlxuY29uc3QgYW5zd2VycyA9IHt9O1xuQ3JlZGVudGlhbHMuc2V0QW5zd2VyID0gKHByb21wdCwgYW5zd2VyKSA9PiBhbnN3ZXJzW3Byb21wdF0gPSBhbnN3ZXI7XG5DcmVkZW50aWFscy5nZXRVc2VyRGV2aWNlU2VjcmV0ID0gZnVuY3Rpb24gZmxleHN0b3JlU2VjcmV0KHRhZywgcHJvbXB0U3RyaW5nKSB7XG4gIGlmICghcHJvbXB0U3RyaW5nKSByZXR1cm4gdGFnO1xuICBpZiAocHJvbXB0U3RyaW5nID09PSAnLScpIHJldHVybiBwcm9tcHRTdHJpbmc7IC8vIFNlZSBjcmVhdGVBdXRob3IuXG4gIGNvbnN0IGFuc3dlciA9IGFuc3dlcnNbcHJvbXB0U3RyaW5nXTtcbiAgaWYgKGFuc3dlcikgcmV0dXJuIGFuc3dlcjtcbiAgLy8gRGlzdHJpYnV0ZWQgU2VjdXJpdHkgd2lsbCB0cnkgZXZlcnl0aGluZy4gVW5sZXNzIGdvaW5nIHRocm91Z2ggYSBwYXRoIGFib3ZlLCB3ZSB3b3VsZCBsaWtlIG90aGVycyB0byBzaWxlbnRseSBmYWlsLlxuICBjb25zb2xlLmxvZyhgQXR0ZW1wdGluZyBhY2Nlc3MgJHt0YWd9IHdpdGggcHJvbXB0ICcke3Byb21wdFN0cmluZ30nLmApO1xuICByZXR1cm4gXCJub3QgYSBzZWNyZXRcIjsgLy8gdG9kbzogY3J5cHRvIHJhbmRvbVxufTtcblxuXG4vLyBUaGVzZSB0d28gYXJlIHVzZWQgZGlyZWN0bHkgYnkgZGlzdHJpYnV0ZWQtc2VjdXJpdHkuXG5DcmVkZW50aWFscy5TdG9yYWdlLnJldHJpZXZlID0gYXN5bmMgKGNvbGxlY3Rpb25OYW1lLCB0YWcpID0+IHtcbiAgY29uc3QgY29sbGVjdGlvbiA9IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW2NvbGxlY3Rpb25OYW1lXTtcbiAgLy8gTm8gbmVlZCB0byB2ZXJpZnksIGFzIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGRvZXMgdGhhdCBpdHNlbGYgcXVpdGUgY2FyZWZ1bGx5IGFuZCB0ZWFtLWF3YXJlLlxuICBpZiAoY29sbGVjdGlvbk5hbWUgPT09ICdFbmNyeXB0aW9uS2V5JykgYXdhaXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEodGFnKTtcbiAgaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnS2V5UmVjb3ZlcnknKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpO1xuICAvL2lmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ1RlYW0nKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpOyAgICAvLyBUaGlzIHdvdWxkIGdvIGNpcmN1bGFyLiBTaG91bGQgaXQ/IERvIHdlIG5lZWQgaXQ/XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBjb2xsZWN0aW9uLmdldCh0YWcpO1xuICAvLyBIb3dldmVyLCBzaW5jZSB3ZSBoYXZlIGJ5cGFzc2VkIENvbGxlY3Rpb24ucmV0cmlldmUsIHdlIG1heWJlSW5mbGF0ZSBoZXJlLlxuICByZXR1cm4gQ29sbGVjdGlvbi5tYXliZUluZmxhdGUoZGF0YSk7XG59XG5jb25zdCBFTVBUWV9TVFJJTkdfSEFTSCA9IFwiNDdERVFwajhIQlNhLV9USW1XLTVKQ2V1UWVSa201Tk1wSldaRzNoU3VGVVwiOyAvLyBIYXNoIG9mIGFuIGVtcHR5IHN0cmluZy5cbkNyZWRlbnRpYWxzLlN0b3JhZ2Uuc3RvcmUgPSBhc3luYyAoY29sbGVjdGlvbk5hbWUsIHRhZywgc2lnbmF0dXJlKSA9PiB7XG4gIC8vIE5vIG5lZWQgdG8gZW5jcnlwdC9zaWduIGFzIGJ5IHN0b3JlLCBzaW5jZSBkaXN0cmlidXRlZC1zZWN1cml0eSBkb2VzIHRoYXQgaW4gYSBjaXJjdWxhcml0eS1hd2FyZSB3YXkuXG4gIC8vIEhvd2V2ZXIsIHdlIGRvIGN1cnJlbnRseSBuZWVkIHRvIGZpbmQgb3V0IG9mIHRoZSBzaWduYXR1cmUgaGFzIGEgcGF5bG9hZCBhbmQgcHVzaFxuICAvLyBUT0RPOiBNb2RpZnkgZGlzdC1zZWMgdG8gaGF2ZSBhIHNlcGFyYXRlIHN0b3JlL2RlbGV0ZSwgcmF0aGVyIHRoYW4gaGF2aW5nIHRvIGZpZ3VyZSB0aGlzIG91dCBoZXJlLlxuICBjb25zdCBjbGFpbXMgPSBDcmVkZW50aWFscy5kZWNvZGVDbGFpbXMoc2lnbmF0dXJlKTtcbiAgY29uc3QgZW1wdHlQYXlsb2FkID0gY2xhaW1zPy5zdWIgPT09IEVNUFRZX1NUUklOR19IQVNIO1xuXG4gIGNvbnN0IGNvbGxlY3Rpb24gPSBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tjb2xsZWN0aW9uTmFtZV07XG4gIHNpZ25hdHVyZSA9IENvbGxlY3Rpb24uZW5zdXJlU3RyaW5nKHNpZ25hdHVyZSk7XG4gIGNvbnN0IHN0b3JlZCA9IGF3YWl0IChlbXB0eVBheWxvYWQgPyBjb2xsZWN0aW9uLmRlbGV0ZSh0YWcsIHNpZ25hdHVyZSkgOiBjb2xsZWN0aW9uLnB1dCh0YWcsIHNpZ25hdHVyZSkpO1xuICBpZiAoc3RvcmVkICE9PSB0YWcpIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIHdyaXRlIGNyZWRlbnRpYWwgJHt0YWd9LmApO1xuICBpZiAodGFnKSBhd2FpdCBjb2xsZWN0aW9uLnB1c2goZW1wdHlQYXlsb2FkID8gJ2RlbGV0ZSc6ICdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gIHJldHVybiB0YWc7XG59O1xuQ3JlZGVudGlhbHMuU3RvcmFnZS5kZXN0cm95ID0gYXN5bmMgKCkgPT4ge1xuICBhd2FpdCBDcmVkZW50aWFscy5jbGVhcigpOyAvLyBXaXBlIGZyb20gbGl2ZSBtZW1vcnkuXG4gIGZvciAobGV0IGNvbGxlY3Rpb24gb2YgT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykpIHtcbiAgICBhd2FpdCBjb2xsZWN0aW9uLmRlc3Ryb3koKTtcbiAgfVxuICBhd2FpdCBDcmVkZW50aWFscy53aXBlRGV2aWNlS2V5cygpOyAvLyBOb3QgaW5jbHVkZWQgaW4gdGhlIGFib3ZlLlxufTtcbkNyZWRlbnRpYWxzLmNvbGxlY3Rpb25zID0ge307XG5leHBvcnQgeyBDcmVkZW50aWFscywgU3RvcmFnZUxvY2FsIH07XG5bJ0VuY3J5cHRpb25LZXknLCAnS2V5UmVjb3ZlcnknLCAnVGVhbSddLmZvckVhY2gobmFtZSA9PiBDcmVkZW50aWFscy5jb2xsZWN0aW9uc1tuYW1lXSA9IG5ldyBNdXRhYmxlQ29sbGVjdGlvbih7bmFtZX0pKTtcbiIsImltcG9ydCBDcmVkZW50aWFscyBmcm9tICdAa2kxcjB5L2Rpc3RyaWJ1dGVkLXNlY3VyaXR5JztcbmltcG9ydCB1dWlkNCBmcm9tICd1dWlkNCc7XG5pbXBvcnQgU3luY2hyb25pemVyIGZyb20gJy4vbGliL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIFN0YXRlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgU3RvcmFnZUxvY2FsIH0gZnJvbSAgJy4vbGliL2NvbGxlY3Rpb25zLm1qcyc7XG5pbXBvcnQgeyBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQyB9IGZyb20gJy4vbGliL3dlYnJ0Yy5tanMnO1xuaW1wb3J0IHsgdmVyc2lvbiwgbmFtZSwgc3RvcmFnZVZlcnNpb24sIHN0b3JhZ2VOYW1lIH0gZnJvbSAnLi9saWIvdmVyc2lvbi5tanMnO1xuXG5jb25zb2xlLmxvZyhgJHtuYW1lfSAke3ZlcnNpb259IGZyb20gJHtpbXBvcnQubWV0YS51cmx9LmApO1xuXG5leHBvcnQgeyBDcmVkZW50aWFscywgQ29sbGVjdGlvbiwgTXV0YWJsZUNvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIFN0YXRlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgU3luY2hyb25pemVyLCBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQywgbmFtZSwgdmVyc2lvbiwgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBTdG9yYWdlTG9jYWwsIHV1aWQ0IH07XG5leHBvcnQgZGVmYXVsdCB7IENyZWRlbnRpYWxzLCBDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgSW1tdXRhYmxlQ29sbGVjdGlvbiwgU3RhdGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBTeW5jaHJvbml6ZXIsIFdlYlJUQywgUHJvbWlzZVdlYlJUQywgU2hhcmVkV2ViUlRDLCBuYW1lLCB2ZXJzaW9uLCAgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBTdG9yYWdlTG9jYWwsIHV1aWQ0IH07XG4iXSwibmFtZXMiOlsicGtnLmRlZmF1bHQiLCJTdG9yYWdlTG9jYWwiXSwibWFwcGluZ3MiOiI7OztBQUFBLE1BQU0sV0FBVyxHQUFHLHdFQUF3RTtBQUM1RixTQUFTLEtBQUssQ0FBQyxJQUFJLEVBQUU7QUFDckIsRUFBRSxPQUFPLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0FBQy9COztBQUVBO0FBQ0E7QUFDQSxTQUFTLEtBQUssR0FBRztBQUNqQixFQUFFLElBQUksUUFBUSxHQUFHLEdBQUcsQ0FBQyxlQUFlLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQztBQUNoRCxFQUFFLElBQUksSUFBSSxHQUFH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LE1BQU0sQ0FBQyxDQUFDO0FBQ3BELElBQUksTUFBTSxXQUFXLEdBQUcsTUFBTSxJQUFJLENBQUMsa0JBQWtCO0FBQ3JELElBQUksTUFBTSxLQUFLLEdBQUcsV0FBVyxFQUFFLFVBQVUsSUFBSSxRQUFRO0FBQ3JELElBQUksSUFBSSxLQUFLLEtBQUssUUFBUSxJQUFJLEtBQUssS0FBSyxTQUFTLEVBQUU7QUFDbkQsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsR0FBRyxNQUFNLENBQUM7QUFDeEMsSUFBSSxNQUFNLElBQUksR0FBRyxJQUFJLENBQUM7QUFDdEIsSUFBSSxJQUFJLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxFQUFFO0FBQy9CLE1BQU0sV0FBVyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7QUFDL0IsTUFBTTtBQUNOO0FBQ0EsSUFBSSxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO0FBQ3RELElBQUksTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxVQUFVLEVBQUU7QUFDNUMsSUFBSSxNQUFNLElBQUksR0FBRyxDQUFDLE1BQU0sRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0FBQy9EO0FBQ0EsSUFBSSxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDMUM7QUFDQSxJQUFJLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLFNBQVMsRUFBRSxFQUFFLENBQUMsRUFBRSxDQUFDLElBQUksSUFBSSxFQUFFO0FBQzFELE1BQU0sTUFBTSxJQUFJLEdBQUcsQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFD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QUMsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsVUFBVSxFQUFFLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDLElBQUksTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEdBQUUsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBQyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxTQUFTLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLE1BQU0sWUFBWSxTQUFTLFdBQVcsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksTUFBTSxDQUFDLENBQUMsRUFBRSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBQyxDQUFDLE1BQU0sWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFNLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLE9BQU8sTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7O0FDSXA3RCxNQUFNLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsR0FBRyxVQUFVOztBQUU1RDs7QUFFTyxNQUFNLFVBQVUsU0FBUyxXQUFXLENBQUM7O0FBRTVDLEVBQUUsV0FBVyxDQUFDLENBQUMsSUFBSSxFQUFFLEtBQUssR0FBRyxJQUFJLEVBQUUsUUFBUSxHQUFHLEVBQUUsRUFBRSxpQkFBaUIsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU07QUFDdkYsUUFBUSxnQkFBZ0IsR0FBR0MsWUFBWSxFQUFFLFNBQVMsR0FBRyxjQUFjLEVBQUUsZUFBZSxHQUFHLENBQUMsRUFBRSxXQUFXLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDO0FBQ3BILFFBQVEsS0FBSyxHQUFHLEtBQUssRUFBRSxTQUFTO0FBQ2hDLFFBQVEsV0FBVyxFQUFFLFlBQVksRUFBRSxjQUFjLENBQUMsRUFBRTtBQUNwRCxJQUFJLEtBQUssRUFBRTtBQUNYLElBQUksTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLGlCQUFpQixFQUFFLGdCQUFnQixFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLFdBQVcsRUFBRSxZQUFZO0FBQ2pJLElBQUksUUFBUSxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsRUFBRSxTQUFTLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEcsSUFBSSxJQUFJLGNBQWMsRUFBRSxJQUFJLENBQUMsY0FBYyxHQUFHLGNBQWM7QUFDNUQsSUFBSSxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsUUFBUSxDQUFDO0FBQ2pDLElBQUksTUFBTSxrQkFBa0IsR0FBRyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxFQUFFLFFBQVEsRUFBRSxlQUFlLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQztBQUM5RixJQUFJLElBQUksZ0JBQWdCLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxJQUFJLElBQUksSUFBSSxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDbEgsU0FBUyxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsSUFBSSxnQkFBZ0IsQ0FBQyxrQkFBa0IsQ0FBQztBQUN6RTs7QUFFQSxFQUFFLE1BQU0sS0FBSyxHQUFHO0FBQ2hCLElBQUksTUFBTSxDQUFDLE1BQU0sSUFBSSxDQUFDLGdCQUFnQixFQUFFLEtBQUssRUFBRTtBQUMvQztBQUNBLEVBQUUsTUFBTSxPQUFPLEdBQUc7QUFDbEIsSUFBSSxNQUFNLElBQUksQ0FBQyxVQUFVLEVBQUU7QUFDM0IsSUFBSSxNQUFNLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBQyxnQkFBZ0I7QUFDN0MsSUFBSSxPQUFPLElBQUksQ0FBQyxnQkFBZ0I7QUFDaEMsSUFBSSxJQUFJLEtBQUssRUFBRSxNQUFNLEtBQUssQ0FBQyxPQUFPLEVBQUU7QUFDcEM7O0FBRUEsRUFBRSxPQUFPLEtBQUssQ0FBQyxLQUFLLEVBQUU7QUFDdEIsSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQztBQUN4QjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxFQUFFLE9BQU8sWUFBWSxDQUFDLFNBQVMsRUFBRTtBQUNqQyxJQUFJLElBQUksT0FBTyxTQUFTLENBQUMsS0FBSyxRQUFRLEVBQUUsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLFNBQVMsQ0FBQztBQUN4RSxJQUFJLE9BQU8sU0FBUztBQUNwQjtBQUNBO0FBQ0EsRUFBRSxPQUFPLFlBQVksQ0FBQyxTQUFTLEVBQUU7QUFDakMsSUFBSSxJQUFJLFNBQVMsRUFBRSxVQUFVLEdBQUcsR0FBRyxDQUFDLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQztBQUNsRSxJQUFJLE9BQU8sU0FBUztBQUNwQjtBQUNBO0FBQ0EsRUFBRSxPQUFPLGlCQUFpQixHQUFHLGdCQUFnQjtBQUM3QyxFQUFFLGFBQWEsZUFBZSxDQUFDLFFBQVEsRUFBRTtBQUN6QyxJQUFJLElBQUksUUFBUSxDQUFDLGVBQWUsQ0FBQyxHQUFHLEtBQUssSUFBSSxDQUFDLGlCQUFpQixFQUFFLE9BQU8sUUFBUTtBQUNoRixJQUFJLElBQUksUUFBUSxDQUFDLFNBQVMsRUFBRSxPQUFPLFFBQVEsQ0FBQztBQUM1QyxJQUFJLE1BQU0sU0FBUyxHQUFHLE1BQU0sV0FBVyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO0FBQzlELElBQUksUUFBUSxDQUFDLElBQUksR0FBRyxTQUFTLENBQUMsSUFBSTtBQUNsQyxJQUFJLFFBQVEsQ0FBQyxJQUFJLEdBQUcsU0FBUyxDQUFDLElBQUk7QUFDbEMsSUFBSSxRQUFRLENBQUMsT0FBTyxHQUFHLFNBQVMsQ0FBQyxPQUFPO0FBQ3hDLElBQUksUUFBUSxDQUFDLFNBQVMsR0FBRyxTQUFTO0FBQ2xDLElBQUksT0FBTyxRQUFRO0FBQ25COztBQUVBO0FBQ0EsRUFBRSxNQUFNLElBQUksQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO0FBQzVCO0FBQ0EsSUFBSSxJQUFJLGdCQUFnQixJQUFJLElBQUksRUFBRTtBQUNsQyxNQUFNLElBQUksT0FBTyxHQUFHLFdBQVcsQ0FBQyxtQkFBbUI7QUFDbkQsTUFBTSxJQUFJO0FBQ1YsQ0FBQyxXQUFXLENBQUMsbUJBQW1CLEdBQUcsQ0FBQyxHQUFHLEVBQUUsWUFBWSxLQUFLO0FBQzFELEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLE9BQU8sT0FBTztBQUNwRCxHQUFHLE9BQU8sT0FBTyxDQUFDLEdBQUcsRUFBRSxZQUFZLENBQUM7QUFDcEMsRUFBRTtBQUNGLENBQUMsTUFBTSxXQUFXLENBQUMsS0FBSyxFQUFFO0FBQzFCLENBQUMsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUM7QUFDbEQsT0FBTyxTQUFTO0FBQ2hCLENBQUMsV0FBVyxDQUFDLG1CQUFtQixHQUFHLE9BQU87QUFDMUM7QUFDQTtBQUNBLElBQUksT0FBTyxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDO0FBQy9DO0FBQ0EsRUFBRSxhQUFhLElBQUksQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO0FBQ25DLElBQUksTUFBTSxTQUFTLEdBQUcsTUFBTSxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUM7QUFDM0QsSUFBSSxPQUFPLElBQUksQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDO0FBQ3ZDO0FBQ0EsRUFBRSxhQUFhLE1BQU0sQ0FBQyxTQUFTLEVBQUUsT0FBTyxHQUFHLEVBQUUsRUFBRTtBQUMvQyxJQUFJLFNBQVMsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQztBQUM1QztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBSSxNQUFNLFFBQVEsSUFBSSxNQUFNLFdBQVcsQ0FBQyxNQUFNLENBQUMsU0FBUyxFQUFFLE9BQU8sQ0FBQztBQUNsRSxJQUFJLElBQUksUUFBUSxFQUFFLFFBQVEsQ0FBQyxTQUFTLEdBQUcsU0FBUztBQUNoRCxJQUFJLE9BQU8sUUFBUTtBQUNuQjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQSxFQUFFLE1BQU0sYUFBYSxHQUFHO0FBQ3hCO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBSSxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsTUFBTSxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsSUFBSSxFQUFFO0FBQzlELElBQUksTUFBTSxJQUFJLEdBQUcsSUFBSSxHQUFHLEVBQUU7QUFDMUIsSUFBSSxNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEdBQUcsSUFBSTtBQUMvQyxNQUFNLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDeEUsTUFBTSxJQUFJLFFBQVEsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUNqQyxLQUFLLENBQUMsQ0FBQztBQUNQLElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQSxFQUFFLElBQUksSUFBSSxHQUFHO0FBQ2IsSUFBSSxPQUFPLElBQUksQ0FBQyxZQUFZLEtBQUssSUFBSSxDQUFDLGFBQWEsRUFBRTtBQUNyRDtBQUNBLEVBQUUsTUFBTSxNQUFNLENBQUMsR0FBRyxFQUFFO0FBQ3BCLElBQUksQ0FBQyxNQUFNLElBQUksQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUM5QjtBQUNBLEVBQUUsTUFBTSxTQUFTLENBQUMsR0FBRyxFQUFFO0FBQ3ZCLElBQUksQ0FBQyxNQUFNLElBQUksQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLEdBQUcsQ0FBQztBQUNqQzs7QUFFQSxFQUFFLEdBQUcsQ0FBQyxHQUFHLElBQUksRUFBRTtBQUNmLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUU7QUFDckIsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFDeEM7QUFDQSxFQUFFLHFCQUFxQixDQUFDLFlBQVksR0FBRyxFQUFFLEVBQUU7QUFDM0MsSUFBSSxPQUFPLENBQUMsT0FBTyxZQUFZLENBQUMsS0FBSyxRQUFRLElBQUksQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDLEdBQUcsWUFBWTtBQUNsRjtBQUNBLEVBQUUsb0JBQW9CLENBQUMsY0FBYyxHQUFHLEVBQUUsRUFBRTtBQUM1QyxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxHQUFHLFdBQVcsQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLE1BQU0sR0FBRyxXQUFXLENBQUMsTUFBTTtBQUM3RSxJQUFJLEdBQUc7QUFDUCxJQUFJLFVBQVUsR0FBRyxXQUFXLENBQUMsVUFBVTtBQUN2QyxJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFO0FBQ3JCLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMscUJBQXFCLENBQUMsY0FBYyxDQUFDO0FBQ3pEO0FBQ0E7QUFDQSxJQUFJLE1BQU0sT0FBTyxHQUFHLENBQUMsSUFBSSxJQUFJLElBQUksS0FBSyxNQUFNO0FBQzVDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDO0FBQ2pELEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0FBQ3BELElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsRUFBRSxPQUFPLENBQUMsVUFBVSxHQUFHLElBQUk7QUFDdkYsSUFBSSxPQUFPLE9BQU87QUFDbEI7QUFDQSxFQUFFLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRTtBQUNoQyxJQUFJLE1BQU0sSUFBSSxLQUFLLENBQUMsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxnQ0FBZ0MsRUFBRSxTQUFTLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdEg7QUFDQSxFQUFFLE1BQU0sS0FBSyxDQUFDLElBQUksRUFBRSxPQUFPLEdBQUcsRUFBRSxFQUFFO0FBQ2xDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxHQUFHLEVBQUUsR0FBRyxjQUFjLENBQUMsR0FBRyxJQUFJLENBQUMsb0JBQW9CLENBQUMsT0FBTyxDQUFDO0FBQ2pGLElBQUksSUFBSSxVQUFVLEVBQUU7QUFDcEIsTUFBTSxJQUFJLEdBQUcsTUFBTSxXQUFXLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxVQUFVLENBQUM7QUFDeEQsTUFBTSxjQUFjLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsaUJBQWlCO0FBQ3JFO0FBQ0E7QUFDQSxJQUFJLE1BQU0sU0FBUyxHQUFHLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDO0FBQzNELElBQUksR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsU0FBUyxDQUFDO0FBQ3hDLElBQUksSUFBSSxDQUFDLEdBQUcsRUFBRSxPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxjQUFjLENBQUMsTUFBTSxJQUFJLGNBQWMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDOUYsSUFBSSxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUM7QUFDMUMsSUFBSSxPQUFPLEdBQUc7QUFDZDtBQUNBLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRSxHQUFHLEVBQUUsU0FBUyxFQUFFLG1CQUFtQixHQUFHLElBQUksRUFBRTtBQUM5RCxJQUFJLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsWUFBWSxJQUFJLENBQUMsbUJBQW1CLEtBQUssWUFBWSxLQUFLLFlBQVksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUMsQ0FBQyxDQUFDO0FBQ3JKO0FBQ0EsRUFBRSxNQUFNLE1BQU0sQ0FBQyxPQUFPLEdBQUcsRUFBRSxFQUFFO0FBQzdCLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxHQUFHLEVBQUUsR0FBRyxjQUFjLENBQUMsR0FBRyxJQUFJLENBQUMsb0JBQW9CLENBQUMsT0FBTyxDQUFDO0FBQ2pGLElBQUksTUFBTSxJQUFJLEdBQUcsRUFBRTtBQUNuQjtBQUNBLElBQUksTUFBTSxTQUFTLEdBQUcsTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsR0FBRyxjQUFjLENBQUMsQ0FBQztBQUM5RSxJQUFJLEdBQUcsR0FBRyxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLFNBQVMsQ0FBQztBQUMzQyxJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsY0FBYyxDQUFDLE1BQU0sSUFBSSxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQy9GLElBQUksTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxHQUFHLEVBQUUsU0FBUyxDQUFDO0FBQzdDLElBQUksT0FBTyxHQUFHO0FBQ2Q7QUFDQSxFQUFFLE1BQU0sUUFBUSxDQUFDLFlBQVksRUFBRTtBQUMvQixJQUFJLE1BQU0sQ0FBQyxHQUFHLEVBQUUsT0FBTyxHQUFHLElBQUksRUFBRSxHQUFHLE9BQU8sQ0FBQyxHQUFHLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxZQUFZLENBQUM7QUFDdEYsSUFBSSxNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFHLEVBQUUsR0FBRyxPQUFPLENBQUMsQ0FBQztBQUM5RCxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsT0FBTyxFQUFFO0FBQzVCLElBQUksSUFBSSxPQUFPLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQztBQUN4RSxJQUFJLE9BQU8sUUFBUTtBQUNuQjtBQUNBLEVBQUUsTUFBTSxXQUFXLENBQUMsWUFBWSxFQUFFO0FBQ2xDLElBQUksTUFBTSxDQUFDLEdBQUcsRUFBRSxXQUFXLEdBQUcsSUFBSSxFQUFFLEdBQUcsYUFBYSxDQUFDLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLFlBQVksQ0FBQztBQUNoRyxJQUFJLElBQUksV0FBVyxFQUFFLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUM7QUFDakQsSUFBSSxNQUFNLFNBQVMsR0FBRyxNQUFNLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQ3pDLElBQUksSUFBSSxDQUFDLFNBQVMsRUFBRSxPQUFPLFNBQVM7QUFDcEMsSUFBSSxNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLFNBQVMsRUFBRSxhQUFhLENBQUM7QUFDNUUsSUFBSSxRQUFRLENBQUMsR0FBRyxHQUFHLEdBQUcsQ0FBQztBQUN2QixJQUFJLE9BQU8sUUFBUTtBQUNuQjtBQUNBLEVBQUUsTUFBTSxJQUFJLENBQUMsUUFBUSxHQUFHLEtBQUssR0FBRztBQUNoQyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsTUFBTSxJQUFJLENBQUMsZUFBZSxFQUFFO0FBQy9DO0FBQ0EsSUFBSSxPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7QUFDL0M7QUFDQSxFQUFFLE1BQU0sS0FBSyxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUU7QUFDL0IsSUFBSSxNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDO0FBQzdDLElBQUksTUFBTSxJQUFJLEdBQUcsUUFBUSxFQUFFLElBQUk7QUFDL0IsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sS0FBSztBQUMzQixJQUFJLEtBQUssTUFBTSxHQUFHLElBQUksVUFBVSxFQUFFO0FBQ2xDLE1BQU0sSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssVUFBVSxDQUFDLEdBQUcsQ0FBQyxFQUFFLE9BQU8sS0FBSztBQUNyRDtBQUNBLElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQSxFQUFFLE1BQU0sU0FBUyxDQUFDLFVBQVUsRUFBRTtBQUM5QixJQUFJLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFO0FBQ2xELE1BQU0sSUFBSSxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLFVBQVUsQ0FBQyxFQUFFLE9BQU8sR0FBRztBQUN2RDtBQUNBLElBQUksT0FBTyxLQUFLO0FBQ2hCO0FBQ0EsRUFBRSxNQUFNLElBQUksQ0FBQyxVQUFVLEVBQUU7QUFDekIsSUFBSSxJQUFJLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDO0FBQ2hELElBQUksSUFBSSxLQUFLLEVBQUU7QUFDZixNQUFNLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNyQyxNQUFNLElBQUksTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxVQUFVLENBQUMsRUFBRSxPQUFPLEtBQUs7QUFDM0Q7QUFDQTtBQUNBLElBQUksTUFBTSxJQUFJLENBQUMsZUFBZSxFQUFFO0FBQ2hDLElBQUksTUFBTSxJQUFJLENBQUMsZUFBZSxFQUFFO0FBQ2hDLElBQUksS0FBSyxHQUFHLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxVQUFVLENBQUM7QUFDNUMsSUFBSSxJQUFJLEtBQUssSUFBSSxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLFVBQVUsQ0FBQyxFQUFFLE9BQU8sS0FBSztBQUNsRSxJQUFJLE9BQU8sSUFBSTtBQUNmO0FBQ0EsRUFBRSxVQUFVLENBQUMsR0FBRyxFQUFFO0FBQ2xCLElBQUksSUFBSSxHQUFHLEVBQUU7QUFDYixJQUFJLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUM7QUFDekM7O0FBRUE7QUFDQTtBQUNBLEVBQUUsTUFBTSxHQUFHLENBQUMsR0FBRyxFQUFFO0FBQ2pCLElBQUksSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7QUFDeEIsSUFBSSxPQUFPLE1BQU0sQ0FBQyxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQ3ZEO0FBQ0E7QUFDQSxFQUFFLE1BQU0sR0FBRyxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsWUFBWSxHQUFHLElBQUksRUFBRTtBQUNqRDtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBLElBQUksTUFBTSxVQUFVLEdBQUcsTUFBTSxJQUFJLENBQUMsa0JBQWtCLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsWUFBWSxDQUFDO0FBQzNGLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxHQUFHLEVBQUUsVUFBVSxFQUFFLEdBQUcsSUFBSSxHQUFHLEVBQUUsWUFBWSxFQUFFLFlBQVksRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLFVBQVUsRUFBRSxJQUFJLENBQUMsQ0FBQzs7QUFFN0csSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLE9BQU8sU0FBUztBQUNyQyxJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsU0FBUyxFQUFFLE9BQU8sVUFBVSxDQUFDLEdBQUcsQ0FBQztBQUNyRCxJQUFJLE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDOztBQUVyQztBQUNBLElBQUksTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUUsU0FBUyxDQUFDO0FBQ3pFLElBQUksTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDO0FBQzlDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUEsSUFBSSxPQUFPLFVBQVUsQ0FBQyxHQUFHLENBQUM7QUFDMUI7QUFDQSxFQUFFLE1BQU0sTUFBTSxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsWUFBWSxHQUFHLElBQUksRUFBRTtBQUNwRCxJQUFJLE1BQU0sVUFBVSxHQUFHLE1BQU0sSUFBSSxDQUFDLGtCQUFrQixDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLFlBQVksRUFBRSxZQUFZLENBQUM7QUFDMUcsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsRUFBRSxHQUFHLEVBQUUsWUFBWSxFQUFFLEtBQUssRUFBRSxnQkFBZ0IsRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLG9CQUFvQixFQUFFLElBQUksQ0FBQyxpQkFBaUIsQ0FBQztBQUNqSSxJQUFJLElBQUksQ0FBQyxVQUFVLEVBQUUsT0FBTyxTQUFTO0FBQ3JDLElBQUksTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQztBQUM3QixJQUFJLElBQUksSUFBSSxDQUFDLGlCQUFpQixFQUFFO0FBQ2hDO0FBQ0E7QUFDQSxNQUFNLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUM7QUFDckMsS0FBSyxNQUFNO0FBQ1g7QUFDQTtBQUNBLE1BQU0sTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLFVBQVUsRUFBRSxRQUFRLENBQUM7QUFDL0M7QUFDQSxJQUFJLE9BQU8sVUFBVSxDQUFDLEdBQUcsQ0FBQztBQUMxQjs7QUFFQSxFQUFFLGFBQWEsQ0FBQyxHQUFHLEVBQUUsY0FBYyxFQUFFLE9BQU8sR0FBRyxTQUFTLEVBQUUsU0FBUyxHQUFHLEVBQUUsRUFBRSxTQUFTLEVBQUU7QUFDckY7QUFDQTtBQUNBLElBQUksT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLGNBQWMsRUFBRSxPQUFPLEVBQUUsR0FBRyxDQUFDO0FBQzlEO0FBQ0E7QUFDQTtBQUNBLElBQUksT0FBTyxTQUFTO0FBQ3BCO0FBQ0EsRUFBRSxNQUFNLGFBQWEsQ0FBQyxHQUFHLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUU7QUFDekQ7O0FBRUEsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLENBQUMsY0FBYyxDQUFDLEdBQUcsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLFFBQVEsQ0FBQzs7QUFFNUYsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLE9BQU8sbUJBQW1CO0FBQzdDLElBQUksTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ2pELElBQUksSUFBSSxNQUFNLEVBQUUsT0FBTyxNQUFNLENBQUM7QUFDOUIsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLE9BQU8sTUFBTSxDQUFDOztBQUVqQyxJQUFJLElBQUksS0FBSyxFQUFFLElBQUk7QUFDbkI7QUFDQSxJQUFJLE9BQU8sQ0FBQyxLQUFLLEdBQUcsTUFBTSxJQUFJLENBQUMsVUFBVSxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUUsUUFBUSxDQUFDO0FBQ3ZFLE9BQU8sSUFBSSxHQUFHLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFDdkQsT0FBTyxLQUFLLElBQUksSUFBSSxJQUFJLE1BQU0sQ0FBQztBQUMvQjtBQUNBLEVBQUUsTUFBTSxjQUFjLENBQUMsR0FBRyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFO0FBQzFELElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxPQUFPLG1CQUFtQjs7QUFFN0M7QUFDQSxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsT0FBTyxFQUFFO0FBQzVCO0FBQ0EsSUFBSSxPQUFPLElBQUksQ0FBQyxVQUFVLENBQUMsUUFBUSxFQUFFLFFBQVEsRUFBRSxRQUFRLENBQUM7QUFDeEQ7QUFDQSxFQUFFLGVBQWUsQ0FBQyxVQUFVLEVBQUU7QUFDOUI7QUFDQSxJQUFJLE9BQU8sVUFBVSxDQUFDLElBQUksSUFBSSxJQUFJLFdBQVcsRUFBRSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDO0FBQzFFO0FBQ0EsRUFBRSxNQUFNLElBQUksQ0FBQyxVQUFVLEVBQUU7QUFDekIsSUFBSSxPQUFPLFdBQVcsQ0FBQyxlQUFlLENBQUMsTUFBTSxXQUFXLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztBQUNwRztBQUNBLEVBQUUsaUJBQWlCLENBQUMsUUFBUSxFQUFFLFFBQVEsRUFBRTtBQUN4QyxJQUFJLE1BQU0sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLEdBQUcsUUFBUTtBQUMvQixJQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsUUFBUTtBQUMvQixJQUFJLElBQUksR0FBRyxFQUFFLE1BQU0sSUFBSSxHQUFHLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLE9BQU8sR0FBRyxHQUFHLElBQUk7QUFDNUUsSUFBSSxPQUFPLEdBQUcsR0FBRyxJQUFJLENBQUM7QUFDdEI7QUFDQSxFQUFFLFFBQVEsQ0FBQyxlQUFlLEVBQUU7QUFDNUIsSUFBSSxNQUFNLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxHQUFHLGVBQWU7QUFDdEMsSUFBSSxPQUFPLEdBQUcsSUFBSSxHQUFHO0FBQ3JCO0FBQ0E7QUFDQSxFQUFFLGNBQWMsQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRTtBQUN6QyxJQUFJLElBQUksT0FBTyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsQ0FBQztBQUNsRCxJQUFJLE9BQU8sT0FBTyxHQUFHLE1BQU0sR0FBRyxJQUFJO0FBQ2xDO0FBQ0EsRUFBRSxVQUFVLENBQUMsUUFBUSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUU7QUFDM0MsSUFBSSxPQUFPLElBQUksQ0FBQyxjQUFjLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLFFBQVEsQ0FBQyxRQUFRLENBQUMsS0FBSyxJQUFJLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxRQUFRLENBQUMsRUFBRSxPQUFPLENBQUM7QUFDdEk7O0FBRUEsRUFBRSxVQUFVLENBQUMsUUFBUSxFQUFFO0FBQ3ZCLElBQUksT0FBTyxRQUFRLENBQUMsR0FBRztBQUN2QjtBQUNBLEVBQUUscUJBQXFCLENBQUMsR0FBRyxFQUFFLFVBQVUsRUFBRTtBQUN6QyxJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsQ0FBQztBQUM5QjtBQUNBLEVBQUUsYUFBYSxDQUFDLFlBQVksRUFBRSxVQUFVLEVBQUU7QUFDMUMsSUFBSSxPQUFPLFlBQVksSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQztBQUNoRDtBQUNBLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFLGNBQWMsRUFBRSxZQUFZLEVBQUUsVUFBVSxHQUFHLEtBQUssRUFBRTtBQUM3RjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBLElBQUksTUFBTSxpQkFBaUIsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQztBQUM3QyxJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsU0FBUyxFQUFFLGlCQUFpQixDQUFDO0FBQ2hGLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxPQUFPLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxFQUFFLGNBQWMsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLFNBQVMsQ0FBQztBQUNqRyxJQUFJLFFBQVEsQ0FBQyxZQUFZLEdBQUcsWUFBWTtBQUN4QztBQUNBLElBQUksR0FBRyxHQUFHLFFBQVEsQ0FBQyxHQUFHLEdBQUcsVUFBVSxHQUFHLEdBQUcsR0FBRyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxFQUFFLFFBQVEsQ0FBQztBQUNuRixJQUFJLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDO0FBQ2hELElBQUksTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsRUFBRSxVQUFVLENBQUM7QUFDbkUsSUFBSSxNQUFNLGdCQUFnQixHQUFHLFFBQVEsQ0FBQyxRQUFRLEdBQUcsVUFBVSxJQUFJLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxVQUFVLEVBQUUsV0FBVyxFQUFFLEdBQUcsaUJBQWlCLENBQUMsQ0FBQztBQUMzSSxJQUFJLE1BQU0sVUFBVSxHQUFHLE1BQU0sSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLEVBQUUsZ0JBQWdCLEVBQUUsZUFBZSxFQUFFLFFBQVEsRUFBRSxlQUFlLEVBQUUsUUFBUSxDQUFDO0FBQzVILElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLEdBQUcsRUFBRSxjQUFjLEVBQUUsVUFBVSxFQUFFLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxZQUFZLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxVQUFVLEVBQUUsV0FBVyxFQUFFLGdCQUFnQixFQUFFLFVBQVUsQ0FBQyxDQUFDO0FBQ2xMLElBQUksSUFBSSxVQUFVLEtBQUssRUFBRSxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN4QyxJQUFJLElBQUksVUFBVSxFQUFFLE9BQU8sSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLEVBQUUsY0FBYyxFQUFFLFVBQVUsRUFBRSxRQUFRLENBQUM7QUFDeEYsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQztBQUN2QixJQUFJLE9BQU8sUUFBUTtBQUNuQjtBQUNBO0FBQ0EsRUFBRSxlQUFlLENBQUMsR0FBRyxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUU7QUFDOUMsSUFBSSxPQUFPLFNBQVMsQ0FBQztBQUNyQjtBQUNBLEVBQUUsTUFBTSxPQUFPLENBQUMsR0FBRyxFQUFFLGVBQWUsRUFBRSxTQUFTLEdBQUcsS0FBSyxFQUFFO0FBQ3pELElBQUksT0FBTyxDQUFDLE1BQU0sSUFBSSxDQUFDLGdCQUFnQixFQUFFLFNBQVMsQ0FBQyxDQUFDLEdBQUcsRUFBRSxlQUFlLENBQUM7QUFDekU7QUFDQSxFQUFFLGVBQWUsQ0FBQyxVQUFVLEVBQUU7QUFDOUIsSUFBSSxPQUFPLFVBQVU7QUFDckI7QUFDQSxFQUFFLE1BQU0sUUFBUSxDQUFDLFVBQVUsRUFBRSxTQUFTLEdBQUcsS0FBSyxFQUFFO0FBQ2hELElBQUksTUFBTSxDQUFDLEdBQUcsRUFBRSxTQUFTLENBQUMsR0FBRyxVQUFVO0FBQ3ZDLElBQUksTUFBTSxlQUFlLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDO0FBQ3BFLElBQUksTUFBTSxPQUFPLEdBQUcsTUFBTSxJQUFJLENBQUMsZ0JBQWdCO0FBQy9DLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxVQUFVLEVBQUUsQ0FBQyxHQUFHLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxlQUFlLENBQUMsQ0FBQztBQUNwRSxJQUFJLE1BQU0sT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEdBQUcsRUFBRSxlQUFlLENBQUM7QUFDbEQsSUFBSSxPQUFPLEdBQUc7QUFDZDtBQUNBLEVBQUUsSUFBSSxDQUFDLFFBQVEsRUFBRTtBQUNqQixJQUFJLElBQUksQ0FBQyxhQUFhLENBQUMsSUFBSSxXQUFXLENBQUMsUUFBUSxFQUFFLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDckU7QUFDQSxFQUFFLElBQUksV0FBVyxHQUFHO0FBQ3BCLElBQUksT0FBTyxJQUFJO0FBQ2Y7O0FBRUEsRUFBRSxhQUFhLEdBQUcsSUFBSSxHQUFHLEVBQUUsQ0FBQztBQUM1QixFQUFFLGdCQUFnQixDQUFDLENBQUMsRUFBRTtBQUN0QixJQUFJLE1BQU0sT0FBTyxHQUFHLEVBQUU7QUFDdEIsSUFBSSxLQUFLLE1BQU0sWUFBWSxJQUFJLElBQUksQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFLEVBQUU7QUFDNUQsTUFBTSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUNuQztBQUNBLElBQUksT0FBTyxPQUFPO0FBQ2xCO0FBQ0EsRUFBRSxJQUFJLFFBQVEsR0FBRztBQUNqQixJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxDQUFDO0FBQ2hEO0FBQ0E7QUFDQSxFQUFFLE1BQU0sV0FBVyxDQUFDLEdBQUcsUUFBUSxFQUFFO0FBQ2pDLElBQUksTUFBTSxDQUFDLGFBQWEsQ0FBQyxHQUFHLElBQUk7QUFDaEMsSUFBSSxLQUFLLElBQUksT0FBTyxJQUFJLFFBQVEsRUFBRTtBQUNsQyxNQUFNLElBQUksYUFBYSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsRUFBRTtBQUN0QyxNQUFNLE1BQU0sWUFBWSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDL0M7QUFDQTtBQUNBLEVBQUUsSUFBSSxZQUFZLEdBQUc7QUFDckI7QUFDQSxJQUFJLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxpQ0FBaUMsQ0FBQyxDQUFDO0FBQ3ZGO0FBQ0EsRUFBRSxNQUFNLFVBQVUsQ0FBQyxHQUFHLFFBQVEsRUFBRTtBQUNoQyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxFQUFFLFFBQVEsR0FBRyxJQUFJLENBQUMsUUFBUTtBQUNsRCxJQUFJLE1BQU0sQ0FBQyxhQUFhLENBQUMsR0FBRyxJQUFJO0FBQ2hDLElBQUksS0FBSyxJQUFJLE9BQU8sSUFBSSxRQUFRLEVBQUU7QUFDbEMsTUFBTSxNQUFNLFlBQVksR0FBRyxhQUFhLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQztBQUNyRCxNQUFNLElBQUksQ0FBQyxZQUFZLEVBQUU7QUFDekI7QUFDQSxDQUFDO0FBQ0Q7QUFDQSxNQUFNLE1BQU0sWUFBWSxDQUFDLFVBQVUsRUFBRTtBQUNyQztBQUNBO0FBQ0EsRUFBRSxNQUFNLGtCQUFrQixDQUFDLFdBQVcsRUFBRSxVQUFVLEVBQUUsV0FBVyxFQUFFO0FBQ2pFLElBQUksSUFBSSxZQUFZLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDO0FBQzFELElBQUksSUFBSSxDQUFDLFlBQVksRUFBRTtBQUN2QixNQUFNLFlBQVksR0FBRyxJQUFJLFlBQVksQ0FBQyxDQUFDLFdBQVcsRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDekYsTUFBTSxZQUFZLENBQUMsVUFBVSxHQUFHLFVBQVU7QUFDMUMsTUFBTSxZQUFZLENBQUMsa0JBQWtCLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUM7QUFDcEUsTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsWUFBWSxDQUFDO0FBQ3ZEO0FBQ0EsS0FBSyxNQUFNLElBQUksQ0FBQyxZQUFZLENBQUMsVUFBVSxLQUFLLFVBQVU7QUFDdEQsU0FBUyxZQUFZLENBQUMsV0FBVyxLQUFLLFdBQVcsQ0FBQyxLQUFLLENBQUM7QUFDeEQsU0FBUyxNQUFNLFlBQVksQ0FBQyxrQkFBa0IsS0FBSyxXQUFXLENBQUMsRUFBRTtBQUNqRSxNQUFNLE1BQU0sSUFBSSxLQUFLLENBQUMsQ0FBQyx5QkFBeUIsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakU7QUFDQSxJQUFJLE9BQU8sWUFBWTtBQUN2Qjs7QUFFQSxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsS0FBSyxFQUFFLEVBQUUsT0FBTyxLQUFLLENBQUMsRUFBRTtBQUN2QyxFQUFFLFlBQVksQ0FBQyxHQUFHLEVBQUU7QUFDcEIsSUFBSSxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFlBQVksSUFBSSxZQUFZLENBQUMsc0JBQXNCLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUN2RztBQUNBLEVBQUUsTUFBTSxlQUFlLEdBQUc7QUFDMUIsSUFBSSxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLE1BQU0sT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7QUFDekQ7QUFDQSxFQUFFLE1BQU0sZUFBZSxHQUFHO0FBQzFCLElBQUksT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxNQUFNLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO0FBQ3pEO0FBQ0EsRUFBRSxJQUFJLFFBQVEsQ0FBQyxPQUFPLEVBQUU7QUFDeEIsSUFBSSxJQUFJLE9BQU8sRUFBRTtBQUNqQixNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQztBQUN0RCxNQUFNLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTztBQUM1QixNQUFNLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDO0FBQzlDLEtBQUssTUFBTTtBQUNYLE1BQU0sSUFBSSxDQUFDLG1CQUFtQixDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDO0FBQ3RELE1BQU0sSUFBSSxDQUFDLE9BQU8sR0FBRyxPQUFPO0FBQzVCO0FBQ0E7QUFDQSxFQUFFLElBQUksUUFBUSxHQUFHO0FBQ2pCLElBQUksT0FBTyxJQUFJLENBQUMsT0FBTztBQUN2QjtBQUNBOztBQUVPLE1BQU0saUJBQWlCLFNBQVMsVUFBVSxDQUFDO0FBQ2xELEVBQUUsTUFBTSxRQUFRLENBQUMsUUFBUSxFQUFFO0FBQzNCLElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQSxFQUFFLFNBQVMsQ0FBQyxRQUFRLEVBQUUsUUFBUSxFQUFFO0FBQ2hDLElBQUksT0FBTyxJQUFJLENBQUMsY0FBYyxDQUFDLFdBQVcsRUFBRSxDQUFDLFFBQVEsQ0FBQyxHQUFHO0FBQ3pELFdBQVcsQ0FBQyxRQUFRLENBQUMsR0FBRyxLQUFLLFFBQVEsQ0FBQyxHQUFHLElBQUksSUFBSSxDQUFDLGlCQUFpQixDQUFDLFFBQVEsRUFBRSxRQUFRLENBQUMsS0FBSyxRQUFRLENBQUMsR0FBRyxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN6SCxVQUFVLE1BQU0sQ0FBQztBQUNqQjtBQUNBOztBQUVPLE1BQU0sbUJBQW1CLFNBQVMsVUFBVSxDQUFDO0FBQ3BELEVBQUUsU0FBUyxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUU7QUFDaEMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsRUFBRSxPQUFPLGNBQWM7QUFDNUMsSUFBSSxPQUFPLElBQUksQ0FBQyxjQUFjLENBQUMsRUFBRTtBQUNqQyxXQUFXLENBQUMsUUFBUSxDQUFDLEdBQUcsS0FBSyxRQUFRLENBQUMsR0FBRyxJQUFJLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxRQUFRLEVBQUUsUUFBUSxDQUFDLEtBQUssUUFBUSxDQUFDLEdBQUcsR0FBRyxRQUFRLENBQUMsR0FBRyxDQUFDO0FBQ3hILFVBQVUsTUFBTSxDQUFDO0FBQ2pCO0FBQ0EsRUFBRSxNQUFNLFFBQVEsQ0FBQyxRQUFRLEVBQUU7QUFDM0IsSUFBSSxPQUFPLElBQUksQ0FBQyxjQUFjLENBQUMsUUFBUSxDQUFDLFFBQVEsR0FBRyxFQUFFLEdBQUcsV0FBVyxFQUFFLFFBQVEsQ0FBQyxHQUFHLEtBQUssTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLGVBQWUsQ0FBQztBQUNqSTtBQUNBOztBQUVPLE1BQU0sZUFBZSxTQUFTLG1CQUFtQixDQUFDO0FBQ3pEO0FBQ0E7O0FBRUEsRUFBRSxlQUFlLENBQUMsVUFBVSxFQUFFO0FBQzlCLElBQUksTUFBTSxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsR0FBRyxVQUFVLENBQUMsZUFBZTtBQUNqRCxJQUFJLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxlQUFlLENBQUMsVUFBVSxDQUFDO0FBQ3JELElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQzVDLElBQUksT0FBTyxPQUFPLElBQUksR0FBRyxJQUFJLEdBQUcsQ0FBQztBQUNqQztBQUNBLEVBQUUsTUFBTSxRQUFRLENBQUMsUUFBUSxFQUFFO0FBQzNCLElBQUksSUFBSSxRQUFRLENBQUMsZUFBZSxDQUFDLEtBQUssRUFBRSxPQUFPLEVBQUU7QUFDakQsSUFBSSxNQUFNLEdBQUcsR0FBRyxRQUFRLENBQUMsR0FBRztBQUM1QixJQUFJLE1BQU0sSUFBSSxHQUFHLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7QUFDMUMsSUFBSSxPQUFPLElBQUksQ0FBQyxjQUFjLENBQUMsaUJBQWlCLEVBQUUsR0FBRyxLQUFLLElBQUksRUFBRSxXQUFXLENBQUM7QUFDNUU7QUFDQSxFQUFFLFNBQVMsR0FBRztBQUNkLElBQUksT0FBTyxJQUFJO0FBQ2Y7QUFDQSxFQUFFLFFBQVEsQ0FBQyxlQUFlLEVBQUU7QUFDNUIsSUFBSSxPQUFPLGVBQWUsQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUM7QUFDbkU7QUFDQSxFQUFFLFVBQVUsQ0FBQyxVQUFVLEVBQUU7QUFDekIsSUFBSSxJQUFJLFVBQVUsQ0FBQyxJQUFJLEtBQUssRUFBRSxFQUFFLE9BQU8sVUFBVSxDQUFDLEdBQUcsQ0FBQztBQUN0RCxJQUFJLE9BQU8sVUFBVSxDQUFDLGVBQWUsQ0FBQyxHQUFHO0FBQ3pDO0FBQ0E7QUFDQSxFQUFFLE1BQU0sWUFBWSxDQUFDLEdBQUcsRUFBRSxRQUFRLEVBQUUsTUFBTSxHQUFHLElBQUksRUFBRTtBQUNuRDtBQUNBLElBQUksT0FBTyxHQUFHLEVBQUU7QUFDaEIsTUFBTSxNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDdEYsTUFBTSxJQUFJLENBQUMsUUFBUSxFQUFFLE9BQU8sSUFBSTtBQUNoQyxNQUFNLE1BQU0sTUFBTSxHQUFHLE1BQU0sUUFBUSxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUNuRCxNQUFNLElBQUksTUFBTSxFQUFFLE9BQU8sTUFBTTtBQUMvQixNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQztBQUNyQztBQUNBLElBQUksT0FBTyxNQUFNO0FBQ2pCO0FBQ0EsRUFBRSxNQUFNLHNCQUFzQixDQUFDLFNBQVMsRUFBRTtBQUMxQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQSxJQUFJLElBQUksU0FBUyxDQUFDLE1BQU0sSUFBSSxDQUFDLEVBQUUsT0FBTyxTQUFTOztBQUUvQztBQUNBLElBQUksSUFBSSxDQUFDLG9CQUFvQixFQUFFLEdBQUcsc0JBQXNCLENBQUMsR0FBRyxTQUFTO0FBQ3JFLElBQUksSUFBSSxZQUFZLEdBQUcsb0JBQW9CLENBQUM7O0FBRTVDO0FBQ0EsSUFBSSxJQUFJLHVCQUF1QixHQUFHLElBQUksR0FBRyxFQUFFO0FBQzNDO0FBQ0EsSUFBSSxNQUFNLGNBQWMsR0FBRyxDQUFDLEdBQUcsc0JBQXNCLENBQUMsQ0FBQztBQUN2RCxJQUFJLE1BQU0sbUJBQW1CLEdBQUcsY0FBYyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0FBQzdELElBQUksTUFBTSxVQUFVLEdBQUcsY0FBYyxDQUFDLEdBQUcsQ0FBQyxNQUFNLElBQUksR0FBRyxFQUFFLENBQUMsQ0FBQztBQUMzRDtBQUNBLElBQUksU0FBUyxLQUFLLENBQUMsWUFBWSxFQUFFLFVBQVUsRUFBRTtBQUM3QztBQUNBO0FBQ0EsTUFBTSxZQUFZLEdBQUcsWUFBWTtBQUNqQyxNQUFNLHVCQUF1QixHQUFHLElBQUk7QUFDcEMsTUFBTSxDQUFDLHNCQUFzQixFQUFFLGNBQWMsRUFBRSxtQkFBbUIsRUFBRSxVQUFVLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxNQUFNLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQzdIO0FBQ0EsSUFBSSxNQUFNLEdBQUcsR0FBRyxRQUFRLElBQUk7QUFDNUI7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQSxNQUFNLE9BQU8sUUFBUSxDQUFDLEdBQUc7O0FBRXpCO0FBQ0EsS0FBSztBQUNMLElBQUksTUFBTSx5QkFBeUIsR0FBRyxZQUFZO0FBQ2xELE1BQU0sS0FBSyxNQUFNLFVBQVUsSUFBSSxVQUFVLEVBQUU7QUFDM0MsQ0FBQyxJQUFJLENBQUMsTUFBTSxvQkFBb0IsQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDLEVBQUUsVUFBVSxDQUFDLEVBQUUsT0FBTyxLQUFLO0FBQ2xGO0FBQ0EsTUFBTSxPQUFPLElBQUk7QUFDakIsS0FBSztBQUNMLElBQUksTUFBTSxvQkFBb0IsR0FBRyxPQUFPLFNBQVMsRUFBRSxVQUFVLEtBQUs7QUFDbEU7QUFDQTtBQUNBLE1BQU0sT0FBTyxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDLEVBQUU7QUFDM0MsQ0FBQyxNQUFNLFFBQVEsR0FBRyxjQUFjLENBQUMsVUFBVSxDQUFDLENBQUM7QUFDN0M7QUFDQSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsT0FBTyxLQUFLLENBQUM7QUFDN0IsQ0FBQyxNQUFNLGtCQUFrQixHQUFHLG1CQUFtQixDQUFDLFVBQVUsQ0FBQyxDQUFDO0FBQzVELENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsa0JBQWtCLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQztBQUNyRCxDQUFDLE1BQU0sYUFBYSxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDaEc7QUFDQSxDQUFDLElBQUksYUFBYSxFQUFFLGtCQUFrQixDQUFDLElBQUksQ0FBQyxhQUFhLENBQUM7QUFDMUQsQ0FBQyxjQUFjLENBQUMsVUFBVSxDQUFDLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUM7QUFDNUQ7QUFDQTtBQUNBOztBQUVBO0FBQ0EsTUFBTSxJQUFJLFlBQVksS0FBSyxvQkFBb0IsRUFBRSxPQUFPLEtBQUssQ0FBQyxvQkFBb0IsR0FBRyxzQkFBc0IsQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUN4SDtBQUNBLE1BQU0sSUFBSSxZQUFZLEtBQUssc0JBQXNCLENBQUMsVUFBVSxDQUFDLEVBQUUsT0FBTyxLQUFLLENBQUMsb0JBQW9CLENBQUM7QUFDakcsTUFBTSxPQUFPLElBQUksQ0FBQztBQUNsQixLQUFLOztBQUVMO0FBQ0EsSUFBSSxPQUFPLFlBQVksRUFBRTtBQUN6QjtBQUNBLE1BQU0sSUFBSSxNQUFNLHlCQUF5QixFQUFFLEVBQUU7QUFDN0M7QUFDQTtBQUNBLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxVQUFVLElBQUksVUFBVSxDQUFDLEdBQUcsQ0FBQyxZQUFZLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxJQUFJLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUN0SSxDQUFDLE9BQU8sQ0FBQyxZQUFZLEVBQUUsR0FBRyx1QkFBdUIsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0FBQzVELE9BQU8sTUFBTSxJQUFJLHVCQUF1QixFQUFFO0FBQzFDO0FBQ0EsQ0FBQyxNQUFNLGFBQWEsR0FBRyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFHLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFLEtBQUssQ0FBQyxDQUFDO0FBQ3BHLENBQUMsSUFBSSxDQUFDLGFBQWEsRUFBRSxPQUFPLEVBQUUsQ0FBQztBQUMvQixFQUFFLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLEVBQUUsYUFBYSxDQUFDO0FBQ2hFLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDO0FBQzlDLE9BQU8sTUFBTTtBQUNiLENBQUMsdUJBQXVCLEdBQUcsSUFBSSxHQUFHLEVBQUU7QUFDcEM7QUFDQSxLQUFLOztBQUVMLElBQUksT0FBTyxFQUFFLENBQUM7QUFDZDtBQUNBOztBQUVPLE1BQU0sbUJBQW1CLFNBQVMsaUJBQWlCLENBQUM7QUFDM0Q7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEVBQUUsTUFBTSxLQUFLLENBQUMsSUFBSSxFQUFFLFlBQVksR0FBRyxFQUFFLEVBQUU7QUFDdkM7QUFDQTtBQUNBO0FBQ0EsSUFBSSxJQUFJLENBQUMsR0FBRyxFQUFFLFVBQVUsRUFBRSxHQUFHLE9BQU8sQ0FBQyxHQUFHLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxZQUFZLENBQUM7QUFDaEYsSUFBSSxNQUFNLElBQUksR0FBRyxHQUFHLElBQUksTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUM7QUFDdEQ7QUFDQTtBQUNBLElBQUksR0FBRyxLQUFLLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMxRCxJQUFJLE1BQU0sVUFBVSxHQUFHLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsVUFBVSxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLEdBQUcsRUFBRSxHQUFHLE9BQU8sQ0FBQyxDQUFDO0FBQ3pHLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsQ0FBQyxHQUFHLEVBQUUsVUFBVSxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsVUFBVSxDQUFDLENBQUM7QUFDekUsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLE9BQU8sRUFBRTtBQUM5QixJQUFJLE1BQU0sY0FBYyxHQUFHO0FBQzNCLE1BQU0sR0FBRyxFQUFFLEdBQUcsSUFBSSxVQUFVO0FBQzVCLE1BQU0sVUFBVSxFQUFFLEVBQUU7QUFDcEIsTUFBTSxHQUFHO0FBQ1QsS0FBSztBQUNMLElBQUksT0FBTyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsVUFBVSxDQUFDLEVBQUUsY0FBYyxDQUFDO0FBQ3BEO0FBQ0EsRUFBRSxNQUFNLE1BQU0sQ0FBQyxZQUFZLEVBQUU7QUFDN0IsSUFBSSxNQUFNLENBQUMsR0FBRyxFQUFFLEdBQUcsT0FBTyxDQUFDLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLFlBQVksQ0FBQztBQUN0RSxJQUFJLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLEVBQUUsSUFBSSxLQUFLO0FBQzlDO0FBQ0E7QUFDQTtBQUNBLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLEdBQUcsRUFBRSxHQUFHLE9BQU8sQ0FBQyxDQUFDO0FBQzVFLEtBQUssQ0FBQztBQUNOLElBQUksT0FBTyxLQUFLLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQztBQUNyQztBQUNBLEVBQUUsTUFBTSxRQUFRLENBQUMsWUFBWSxFQUFFO0FBQy9CLElBQUksSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLEdBQUcsT0FBTyxDQUFDLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLFlBQVksQ0FBQztBQUNoRixJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxHQUFHLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7QUFDdEQsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQ3BELElBQUksSUFBSSxJQUFJLEVBQUUsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsR0FBRyxPQUFPLENBQUMsQ0FBQztBQUNwRSxJQUFJLElBQUksR0FBRyxVQUFVLENBQUMsSUFBSSxDQUFDO0FBQzNCLElBQUksT0FBTyxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxRQUFRLElBQUksQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLEdBQUcsSUFBSSxJQUFJLEtBQUssUUFBUSxDQUFDO0FBQ2pHOztBQUVBLEVBQUUsU0FBUyxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUU7QUFDaEMsSUFBSSxPQUFPLElBQUk7QUFDZjtBQUNBLEVBQUUsUUFBUSxDQUFDLGVBQWUsRUFBRTtBQUM1QixJQUFJLE9BQU8sZUFBZSxDQUFDLEtBQUssSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQztBQUNuRTtBQUNBO0FBQ0EsRUFBRSxNQUFNLGVBQWUsQ0FBQyxHQUFHLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRTtBQUNwRCxJQUFJLE1BQU0sTUFBTSxHQUFHLFVBQVUsQ0FBQyxJQUFJLElBQUksRUFBRTtBQUN4QyxJQUFJLE1BQU0sUUFBUSxHQUFHLFVBQVUsQ0FBQyxRQUFRLEVBQUUsSUFBSSxJQUFJLEVBQUU7QUFDcEQsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLENBQUMsR0FBRyxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQUMsQ0FBQztBQUN4RCxJQUFJLElBQUksTUFBTSxDQUFDLE1BQU0sS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxFQUFFLE9BQU8sU0FBUyxDQUFDO0FBQ2xFLElBQUksSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsT0FBTyxVQUFVLENBQUMsUUFBUSxDQUFDLFNBQVM7O0FBRXJGO0FBQ0EsSUFBSSxNQUFNLFFBQVEsR0FBRyxDQUFDLEdBQUcsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFDO0FBQzdDLElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRSxHQUFHLGdCQUFnQixDQUFDLEdBQUcsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLHNCQUFzQixDQUFDLFFBQVEsQ0FBQztBQUNwRyxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsaUJBQWlCLEVBQUUsQ0FBQyxHQUFHLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxjQUFjLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztBQUMxRixJQUFJLElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUU7QUFDL0IsTUFBTSxJQUFJLGNBQWMsS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxTQUFTO0FBQ3hELE1BQU0sSUFBSSxjQUFjLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sVUFBVSxDQUFDLFFBQVEsQ0FBQyxTQUFTO0FBQzlFOztBQUVBLElBQUksTUFBTSxNQUFNLEdBQUcsVUFBVSxDQUFDLGVBQWU7QUFDN0MsSUFBSSxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQztBQUN2QztBQUNBLElBQUksSUFBSSxTQUFTLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDO0FBQ2pELElBQUksSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsU0FBUyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUU7QUFDcEU7QUFDQSxNQUFNLFNBQVMsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDO0FBQzNDLE1BQU0sT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxTQUFTLENBQUM7QUFDM0M7QUFDQTtBQUNBLElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRSxnQkFBZ0IsR0FBRyxNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxNQUFNLFFBQVEsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM3SixJQUFJLGdCQUFnQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLGVBQWUsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUM7QUFDbEYsSUFBSSxJQUFJLEtBQUssR0FBRyxjQUFjO0FBQzlCLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQywyQkFBMkIsRUFBRSxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLEVBQUUsS0FBSyxFQUFFLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ2xJLElBQUksS0FBSyxJQUFJLFFBQVEsSUFBSSxnQkFBZ0IsRUFBRTtBQUMzQztBQUNBLE1BQU0sSUFBSSxRQUFRLENBQUMsR0FBRyxLQUFLLEtBQUssRUFBRTtBQUNsQyxDQUFDLEtBQUssR0FBRyxRQUFRLENBQUMsR0FBRztBQUNyQixPQUFPLE1BQU07QUFDYixDQUFDLE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxJQUFJLElBQUksUUFBUSxDQUFDLE9BQU8sQ0FBQztBQUNoRCxDQUFDLE1BQU0sY0FBYyxHQUFHLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxHQUFHLEVBQUUsUUFBUSxDQUFDLGVBQWUsQ0FBQyxHQUFHLEVBQUUsR0FBRyxTQUFTLENBQUM7QUFDckY7QUFDQSxDQUFDLE1BQU0sY0FBYyxHQUFHLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLGNBQWMsQ0FBQyxDQUFDO0FBQ3ZFLENBQUMsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsZUFBZSxFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUM7QUFDeEYsQ0FBQyxLQUFLLEdBQUcsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsY0FBYyxFQUFFLFFBQVEsQ0FBQyxZQUFZLENBQUM7QUFDL0U7QUFDQTtBQUNBO0FBQ0EsSUFBSSxNQUFNLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLENBQUMsRUFBRSxTQUFTLENBQUM7QUFDckQ7QUFDQSxJQUFJLE9BQU8sS0FBSztBQUNoQjs7QUFFQSxFQUFFLE1BQU0sT0FBTyxDQUFDLEdBQUcsRUFBRSxXQUFXLEdBQUcsSUFBSSxFQUFFO0FBQ3pDLElBQUksTUFBTSxlQUFlLEdBQUcsTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsV0FBVyxDQUFDLENBQUM7QUFDckYsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxDQUFDLEdBQUcsRUFBRSxlQUFlLENBQUMsQ0FBQztBQUMvQyxJQUFJLElBQUksQ0FBQyxlQUFlLEVBQUUsT0FBTyxFQUFFO0FBQ25DLElBQUksTUFBTSxNQUFNLEdBQUcsZUFBZSxDQUFDLElBQUk7QUFDdkMsSUFBSSxJQUFJLE1BQU0sQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLE9BQU8sT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLG1CQUFtQixFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNoRixJQUFJLE9BQU8sTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNwQjtBQUNBLEVBQUUsTUFBTSxZQUFZLENBQUMsR0FBRyxFQUFFLFFBQVEsRUFBRTtBQUNwQztBQUNBO0FBQ0EsSUFBSSxNQUFNLElBQUksR0FBRyxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQztBQUMvQyxJQUFJLE9BQU8sTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDO0FBQzNEOztBQUVBO0FBQ0E7QUFDQSxFQUFFLE1BQU0sa0JBQWtCLENBQUMsR0FBRyxFQUFFO0FBQ2hDLElBQUksSUFBSSxLQUFLLEdBQUcsRUFBRTtBQUNsQixJQUFJLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsUUFBUSxJQUFJO0FBQzdDLE1BQU0sS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQztBQUM5QyxLQUFLLENBQUM7QUFDTixJQUFJLE9BQU8sS0FBSyxDQUFDLE9BQU8sRUFBRTtBQUMxQixHQUFHO0FBQ0gsRUFBRSxNQUFNLFdBQVcsQ0FBQyxHQUFHLEVBQUU7QUFDekIsSUFBSSxJQUFJLEtBQUssR0FBRyxFQUFFLEVBQUUsTUFBTTtBQUMxQixJQUFJLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUUsR0FBRyxLQUFLO0FBQ3BELE1BQU0sSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLEdBQUcsUUFBUSxDQUFDLGVBQWUsQ0FBQyxHQUFHO0FBQ3hELE1BQU0sS0FBSyxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBRztBQUMvQyxLQUFLLENBQUM7QUFDTixJQUFJLElBQUksUUFBUSxHQUFHLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQztBQUNuQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN4RSxJQUFJLE9BQU8sUUFBUTtBQUNuQjs7QUFFQTtBQUNBLEVBQUUsT0FBTyxvQkFBb0IsR0FBRyxlQUFlLENBQUM7QUFDaEQsRUFBRSxXQUFXLENBQUMsQ0FBQyxRQUFRLEdBQUcsRUFBRSxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxFQUFFO0FBQzdDLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ2hCLElBQUksSUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLElBQUksQ0FBQyxXQUFXLENBQUMsb0JBQW9CLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDcEU7QUFDQSxJQUFJLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQztBQUNsQztBQUNBLEVBQUUsTUFBTSxLQUFLLEdBQUc7QUFDaEIsSUFBSSxNQUFNLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxFQUFFO0FBQy9CLElBQUksTUFBTSxLQUFLLENBQUMsS0FBSyxFQUFFO0FBQ3ZCO0FBQ0EsRUFBRSxNQUFNLE9BQU8sR0FBRztBQUNsQixJQUFJLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUU7QUFDakMsSUFBSSxNQUFNLEtBQUssQ0FBQyxPQUFPLEVBQUU7QUFDekI7QUFDQTtBQUNBLEVBQUUsaUJBQWlCLENBQUMsT0FBTyxFQUFFO0FBQzdCLElBQUksT0FBTyxPQUFPLEVBQUUsUUFBUSxJQUFJLE9BQU8sQ0FBQztBQUN4QztBQUNBLEVBQUUsa0JBQWtCLENBQUMsUUFBUSxFQUFFO0FBQy9CLElBQUksT0FBTyxRQUFRLENBQUMsR0FBRyxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDbkU7QUFDQSxFQUFFLE1BQU0sV0FBVyxDQUFDLEdBQUcsUUFBUSxFQUFFO0FBQ2pDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLEVBQUU7QUFDMUI7QUFDQSxJQUFJLE1BQU0sZ0JBQWdCLEdBQUcsS0FBSyxDQUFDLFdBQVcsQ0FBQyxHQUFHLFFBQVEsQ0FBQztBQUMzRCxJQUFJLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLEdBQUcsSUFBSSxDQUFDLGtCQUFrQixDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQzFGLElBQUksTUFBTSxnQkFBZ0I7QUFDMUIsSUFBSSxNQUFNLGNBQWM7QUFDeEI7QUFDQSxFQUFFLE1BQU0sVUFBVSxDQUFDLEdBQUcsUUFBUSxFQUFFO0FBQ2hDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLEVBQUUsUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRO0FBQ2xELElBQUksTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxHQUFHLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN4RSxJQUFJLE1BQU0sS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHLFFBQVEsQ0FBQztBQUN2QztBQUNBLEVBQUUsSUFBSSxZQUFZLEdBQUc7QUFDckI7QUFDQSxJQUFJLE9BQU8sSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLE1BQU0sS0FBSyxDQUFDLFlBQVksQ0FBQztBQUNwRTtBQUNBLEVBQUUsSUFBSSxXQUFXLEdBQUc7QUFDcEI7QUFDQSxJQUFJLE9BQU8sSUFBSSxDQUFDLFFBQVE7QUFDeEI7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBLFdBQVcsQ0FBQyxNQUFNLEdBQUcsSUFBSTtBQUN6QixXQUFXLENBQUMsS0FBSyxHQUFHLElBQUk7QUFDeEIsV0FBVyxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUM7QUFDOUIsV0FBVyxDQUFDLFdBQVcsR0FBRyxPQUFPLEdBQUcsUUFBUSxLQUFLO0FBQ2pEO0FBQ0EsRUFBRSxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxDQUFDLFVBQVUsSUFBSSxVQUFVLENBQUMsV0FBVyxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQztBQUNuSCxDQUFDO0FBQ0QsV0FBVyxDQUFDLFlBQVksR0FBRyxZQUFZO0FBQ3ZDLEVBQUUsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxVQUFVLElBQUksVUFBVSxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBQ3ZHO0FBQ0EsV0FBVyxDQUFDLFVBQVUsR0FBRyxPQUFPLEdBQUcsUUFBUSxLQUFLO0FBQ2hELEVBQUUsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxVQUFVLElBQUksVUFBVSxDQUFDLFVBQVUsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDbEg7O0FBRUEsV0FBVyxDQUFDLFlBQVksR0FBRyxPQUFPLE1BQU0sS0FBSztBQUM3QztBQUNBO0FBQ0EsRUFBRSxJQUFJLE1BQU0sS0FBSyxHQUFHLEVBQUUsT0FBTyxXQUFXLENBQUMsTUFBTSxDQUFDLE1BQU0sV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDbkYsRUFBRSxNQUFNLENBQUMsS0FBSyxFQUFFLFFBQVEsQ0FBQyxHQUFHLE1BQU0sT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxNQUFNLEVBQUUsRUFBRSxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25HLEVBQUUsT0FBTyxXQUFXLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxRQUFRLENBQUM7QUFDNUMsQ0FBQztBQUNELFdBQVcsQ0FBQyxlQUFlLEdBQUcsT0FBTyxHQUFHLEVBQUUsU0FBUyxLQUFLO0FBQ3hEO0FBQ0EsRUFBRSxNQUFNLFFBQVEsR0FBRyxNQUFNLFdBQVcsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3JFLEVBQUUsSUFBSSxDQUFDLFFBQVEsRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsNEJBQTRCLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZFLEVBQUUsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLElBQUksQ0FBQyxVQUFVO0FBQzFDLEVBQUUsSUFBSSxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsb0NBQW9DLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUN6RixFQUFFLE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRztBQUM5QyxFQUFFLE1BQU0sY0FBYyxHQUFHLE1BQU0sV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUMsQ0FBQztBQUN0RSxFQUFFLE1BQU0sU0FBUyxHQUFHLE1BQU0sV0FBVyxDQUFDLE1BQU0sRUFBRTs7QUFFOUM7QUFDQTtBQUNBO0FBQ0E7QUFDQSxFQUFFLE1BQU0sV0FBVyxDQUFDLGdCQUFnQixDQUFDLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDLFNBQVMsRUFBRSxjQUFjLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDO0FBQ3ZHLEVBQUUsTUFBTSxXQUFXLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQztBQUNyRSxFQUFFLE1BQU0sV0FBVyxDQUFDLE9BQU8sQ0FBQyxjQUFjLENBQUM7QUFDM0MsRUFBRSxPQUFPLEdBQUc7QUFDWixDQUFDOztBQUVEO0FBQ0EsTUFBTSxPQUFPLEdBQUcsRUFBRTtBQUNsQixXQUFXLENBQUMsU0FBUyxHQUFHLENBQUMsTUFBTSxFQUFFLE1BQU0sS0FBSyxPQUFPLENBQUMsTUFBTSxDQUFDLEdBQUcsTUFBTTtBQUNwRSxXQUFXLENBQUMsbUJBQW1CLEdBQUcsU0FBUyxlQUFlLENBQUMsR0FBRyxFQUFFLFlBQVksRUFBRTtBQUM5RSxFQUFFLElBQUksQ0FBQyxZQUFZLEVBQUUsT0FBTyxHQUFHO0FBQy9CLEVBQUUsSUFBSSxZQUFZLEtBQUssR0FBRyxFQUFFLE9BQU8sWUFBWSxDQUFDO0FBQ2hELEVBQUUsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLFlBQVksQ0FBQztBQUN0QyxFQUFFLElBQUksTUFBTSxFQUFFLE9BQU8sTUFBTTtBQUMzQjtBQUNBLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLGtCQUFrQixFQUFFLEdBQUcsQ0FBQyxjQUFjLEVBQUUsWUFBWSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3hFLEVBQUUsT0FBTyxjQUFjLENBQUM7QUFDeEIsQ0FBQzs7O0FBR0Q7QUFDQSxXQUFXLENBQUMsT0FBTyxDQUFDLFFBQVEsR0FBRyxPQUFPLGNBQWMsRUFBRSxHQUFHLEtBQUs7QUFDOUQsRUFBRSxNQUFNLFVBQVUsR0FBRyxXQUFXLENBQUMsV0FBVyxDQUFDLGNBQWMsQ0FBQztBQUM1RDtBQUNBLEVBQUUsSUFBSSxjQUFjLEtBQUssZUFBZSxFQUFFLE1BQU0sVUFBVSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUM7QUFDNUUsRUFBRSxJQUFJLGNBQWMsS0FBSyxhQUFhLEVBQUUsTUFBTSxVQUFVLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQztBQUMxRTtBQUNBLEVBQUUsTUFBTSxJQUFJLEdBQUcsTUFBTSxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUN4QztBQUNBLEVBQUUsT0FBTyxVQUFVLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQztBQUN0QztBQUNBLE1BQU0saUJBQWlCLEdBQUcsNkNBQTZDLENBQUM7QUFDeEUsV0FBVyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEdBQUcsT0FBTyxjQUFjLEVBQUUsR0FBRyxFQUFFLFNBQVMsS0FBSztBQUN0RTtBQUNBO0FBQ0E7QUFDQSxFQUFFLE1BQU0sTUFBTSxHQUFHLFdBQVcsQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDO0FBQ3BELEVBQUUsTUFBTSxZQUFZLEdBQUcsTUFBTSxFQUFFLEdBQUcsS0FBSyxpQkFBaUI7O0FBRXhELEVBQUUsTUFBTSxVQUFVLEdBQUcsV0FBVyxDQUFDLFdBQVcsQ0FBQyxjQUFjLENBQUM7QUFDNUQsRUFBRSxTQUFTLEdBQUcsVUFBVSxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUM7QUFDaEQsRUFBRSxNQUFNLE1BQU0sR0FBRyxPQUFPLFlBQVksR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDLEdBQUcsRUFBRSxTQUFTLENBQUMsR0FBRyxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxTQUFTLENBQUMsQ0FBQztBQUMxRyxFQUFFLElBQUksTUFBTSxLQUFLLEdBQUcsRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsMkJBQTJCLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzNFLEVBQUUsSUFBSSxHQUFHLEVBQUUsTUFBTSxVQUFVLENBQUMsSUFBSSxDQUFDLFlBQVksR0FBRyxRQUFRLEVBQUUsS0FBSyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUM7QUFDaEYsRUFBRSxPQUFPLEdBQUc7QUFDWixDQUFDO0FBQ0QsV0FBVyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEdBQUcsWUFBWTtBQUMxQyxFQUFFLE1BQU0sV0FBVyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQzVCLEVBQUUsS0FBSyxJQUFJLFVBQVUsSUFBSSxNQUFNLENBQUMsTUFBTSxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsRUFBRTtBQUNqRSxJQUFJLE1BQU0sVUFBVSxDQUFDLE9BQU8sRUFBRTtBQUM5QjtBQUNBLEVBQUUsTUFBTSxXQUFXLENBQUMsY0FBYyxFQUFFLENBQUM7QUFDckMsQ0FBQztBQUNELFdBQVcsQ0FBQyxXQUFXLEdBQUcsRUFBRTtBQUU1QixDQUFDLGVBQWUsRUFBRSxhQUFhLEVBQUUsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksSUFBSSxXQUFXLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUksaUJBQWlCLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDOztBQzk1QnZILE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUcxRCxZQUFlLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxpQkFBaUIsRUFBRSxtQkFBbUIsRUFBRSxlQUFlLEVBQUUsbUJBQW1CLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLElBQUksRUFBRSxPQUFPLEdBQUcsV0FBVyxFQUFFLGNBQWMsZ0JBQUVBLFlBQVksRUFBRSxLQUFLLEVBQUU7Ozs7IiwieF9nb29nbGVfaWdub3JlTGlzdCI6WzBdfQ==
