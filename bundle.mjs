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
var version$1 = "0.0.63";
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

  // TODO?: These take Security-style team/member, while everything else here takes owner/author.
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
    let {encryption, tag, ifExists, ...signingOptions} = this._canonicalizeOptions(options);
    if (encryption) {
      data = await Credentials.encrypt(data, encryption);
      signingOptions.contentType = this.constructor.encryptedMimeType;
    }
    // No need to await synchronization.
    const signature = await this.constructor.sign(data, signingOptions);
    tag = await this.put(tag, signature, null, null, ifExists);
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
  async put(tag, signature, synchronizer = null, mergeAuthorOverride = null, ifExists = 'tag') { // Put the raw signature locally and on the specified services.
    // 1. validateForWriting
    // 2. mergeSignatures against any existing, picking some combination of existing and next.
    // 3. persist the result
    // 4. return tag
    //
    // mergeSignatures() MAY create new new results to save, that still have to be signed. For testing, we sometimes
    // want to behave as if some owner credential does not exist on the machine. That's what mergeAuthorOverride is for.

    // TODO: do we need to queue these? Suppose we are validating or merging while other request arrive?
    const validation = await this.validateForWriting(tag, signature, 'store', synchronizer, false, ifExists);
    this.log('put', {tag: validation?.tag || tag, synchronizer: synchronizer?.label, json: validation?.json});

    if (!validation) return undefined;
    if (!validation.signature) return validation.tag; // No further action but answer tag. E.g., when ignoring new data.
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
  async disallowWrite(tag, existing, proposed, verified, ifExists = 'tag') { // Return a reason string why the proposed verified protectedHeader
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
    if (proposedOwner === existingOwner) return true;
    if (proposed.mt) return true; // FIXME: Defer to subclasses that examine more closely.
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

    return false;
  }
  antecedent(verified) { // What tag should the verified signature be compared against for writing?
    return verified.tag;
  }
  synchronizeAntecedent(tag, antecedent) { // Should the antecedent try synchronizing before getting it?
    return tag !== antecedent; // False when they are the same tag, as that would be circular. Versions do sync.
  }
  tagForWriting(tag, validation) { // Use tag if specified, but defaults to hash.
    // Subtle: For ImmutableCollection, we will verify that any specified tag matches. However, we cannot just
    // use .sub in a method for ImmutableCollection, because then it would not see existing under the tag being written to.
    return tag || validation.protectedHeader.sub;
  }

  async validateForWriting(tag, signature, operationLabel, synchronizer, requireTag = false, ifExists = 'tag') { // TODO: Optionals should be keyword.
    // A deep verify that checks against the existing item's (re-)verified headers.
    // If it succeeds, this is also the common code (between put/delete) that emits the update event.
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
    tag = verified.tag = verified.subjectTag = requireTag ? tag : await this.tagForWriting(tag, verified);
    const antecedent = this.antecedent(verified);
    const synchronize = this.synchronizeAntecedent(tag, antecedent);
    const existingVerified = verified.existing = antecedent && await this.getVerified({tag: antecedent, synchronize, ...validationOptions});
    const disallowed = await this.disallowWrite(tag, existingVerified?.protectedHeader, verified?.protectedHeader, verified, ifExists);
    if (disallowed) return this.notifyInvalid(tag, operationLabel, disallowed, verified);
    if (disallowed === '') {
      verified.signature = null;
    } else {
      this.log('emit', tag, verified.json);
      this.emit(verified);
    }
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
  async disallowWrite(tag, existing, proposed, verified, ifExists = 'tag') { // Overrides super with behavior controlled by ifExists.
    // Returning empty string rather than null means the overwrite should not go through, but no error either.
    if (!proposed) return 'invalid signature';
    if (!existing) {
      if (verified.text.length && (tag !== proposed.sub)) return 'wrong tag';
      if (!await this.subjectMatch(verified)) return 'wrong hash';
      return null; // First write ok.
    }
    // No owner match. Not relevant for immutables.
    if (ifExists === 'reject') return 'overwrite';
    if (verified.text.length && (ifExists === 'tag') && (tag === existing.sub) &&
	((existing.iat === proposed.iat) ? (existing.act < proposed.act) : (existing.iat < proposed.iat))) return '';
    if (verified.text.length && (tag !== proposed.sub)) return 'wrong tag';
    // Later iat is "allowed" (i.e., not an error) but mergeSignatures might use the old signatures.
    // Some examples:
    // - A delete is ok. !verified.payload.length
    // - If the content is encrypted, it will have a different sub (hash) because of the iv.
    //   If we were not told what tag to use, it will be saved under a different tag and there's no conflict.
    //   Otherwise, the sub won't match, but we won't be using it anyway.
    return null;
  }
  mergeSignatures(tag, validation, signature) { // Return a string to be persisted. Usually just the signature.
    // If we didn't fail hard in disallowWrite, we nonetheless want the earlier one.
    if (validation.existing && validation.existing.protectedHeader.iat < validation.protectedHeader.iat) {
      return this.constructor.ensureString(validation.existing.signature);
    }
    return signature;  // validation.string might be an object.
  }
}
class MutableCollection extends Collection {
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
    const verified = await this.getVerified({tag, member: null}); // Might no-longer be a member.
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
	{tag, encryption, team, member, ...rest} = this._canonicalizeOptions(options),
	time = Date.now(),
	// signing takes team/member, but store takes owner/author.
	signingOptions = {team, member, ...rest},
	versionOptions = {time, encryption, owner:team||rest.tags[0], author:member||rest.tags[0], ...rest};
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
  async mergeSignatures(tag, validation, signature, authorOverride = null) { // Merge the new timestamps with the old,
    // promising a string for storage: either a signature or a stringified array of signatures.
    //
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnVuZGxlLm1qcyIsInNvdXJjZXMiOlsibm9kZV9tb2R1bGVzL3V1aWQ0L2Jyb3dzZXIubWpzIiwibGliL2Jyb3dzZXItd3J0Yy5tanMiLCJsaWIvd2VicnRjLm1qcyIsImxpYi92ZXJzaW9uLm1qcyIsImxpYi9zeW5jaHJvbml6ZXIubWpzIiwiLi4vLi4vQGtpMXIweS9zdG9yYWdlL2J1bmRsZS5tanMiLCJsaWIvY29sbGVjdGlvbnMubWpzIiwiaW5kZXgubWpzIl0sInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHV1aWRQYXR0ZXJuID0gL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pO1xuZnVuY3Rpb24gdmFsaWQodXVpZCkge1xuICByZXR1cm4gdXVpZFBhdHRlcm4udGVzdCh1dWlkKTtcbn1cblxuLy8gQmFzZWQgb24gaHR0cHM6Ly9hYmhpc2hla2R1dHRhLm9yZy9ibG9nL3N0YW5kYWxvbmVfdXVpZF9nZW5lcmF0b3JfaW5famF2YXNjcmlwdC5odG1sXG4vLyBJRTExIGFuZCBNb2Rlcm4gQnJvd3NlcnMgT25seVxuZnVuY3Rpb24gdXVpZDQoKSB7XG4gIHZhciB0ZW1wX3VybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwobmV3IEJsb2IoKSk7XG4gIHZhciB1dWlkID0gdGVtcF91cmwudG9TdHJpbmcoKTtcbiAgVVJMLnJldm9rZU9iamVjdFVSTCh0ZW1wX3VybCk7XG4gIHJldHVybiB1dWlkLnNwbGl0KC9bOlxcL10vZykucG9wKCkudG9Mb3dlckNhc2UoKTsgLy8gcmVtb3ZlIHByZWZpeGVzXG59XG51dWlkNC52YWxpZCA9IHZhbGlkO1xuXG5leHBvcnQgZGVmYXVsdCB1dWlkNDtcbmV4cG9ydCB7IHV1aWQ0LCB2YWxpZCB9O1xuIiwiLy8gSW4gYSBicm93c2VyLCB3cnRjIHByb3BlcnRpZXMgc3VjaCBhcyBSVENQZWVyQ29ubmVjdGlvbiBhcmUgaW4gZ2xvYmFsVGhpcy5cbmV4cG9ydCBkZWZhdWx0IGdsb2JhbFRoaXM7XG4iLCJpbXBvcnQgdXVpZDQgZnJvbSAndXVpZDQnO1xuXG4vLyBTZWUgcm9sbHVwLmNvbmZpZy5tanNcbmltcG9ydCB3cnRjIGZyb20gJyN3cnRjJztcbi8vY29uc3Qge2RlZmF1bHQ6d3J0Y30gPSBhd2FpdCAoKHR5cGVvZihwcm9jZXNzKSAhPT0gJ3VuZGVmaW5lZCcpID8gaW1wb3J0KCdAcm9hbWhxL3dydGMnKSA6IHtkZWZhdWx0OiBnbG9iYWxUaGlzfSk7XG5cbmNvbnN0IGljZVNlcnZlcnMgPSBbXG4gIHsgdXJsczogJ3N0dW46c3R1bi5sLmdvb2dsZS5jb206MTkzMDInfSxcbiAgLy8gaHR0cHM6Ly9mcmVlc3R1bi5uZXQvICBDdXJyZW50bHkgNTAgS0JpdC9zLiAoMi41IE1CaXQvcyBmb3JzICQ5L21vbnRoKVxuICB7IHVybHM6ICdzdHVuOmZyZWVzdHVuLm5ldDozNDc4JyB9LFxuICAvL3sgdXJsczogJ3R1cm46ZnJlZXN0dW4ubmV0OjM0NzgnLCB1c2VybmFtZTogJ2ZyZWUnLCBjcmVkZW50aWFsOiAnZnJlZScgfSxcbiAgLy8gUHJlc3VtYWJseSB0cmFmZmljIGxpbWl0ZWQuIENhbiBnZW5lcmF0ZSBuZXcgY3JlZGVudGlhbHMgYXQgaHR0cHM6Ly9zcGVlZC5jbG91ZGZsYXJlLmNvbS90dXJuLWNyZWRzXG4gIC8vIEFsc28gaHR0cHM6Ly9kZXZlbG9wZXJzLmNsb3VkZmxhcmUuY29tL2NhbGxzLyAxIFRCL21vbnRoLCBhbmQgJDAuMDUgL0dCIGFmdGVyIHRoYXQuXG4gIHsgdXJsczogJ3R1cm46dHVybi5zcGVlZC5jbG91ZGZsYXJlLmNvbTo1MDAwMCcsIHVzZXJuYW1lOiAnODI2MjI2MjQ0Y2Q2ZTVlZGIzZjU1NzQ5Yjc5NjIzNWY0MjBmZTVlZTc4ODk1ZTBkZDdkMmJhYTQ1ZTFmN2E4ZjQ5ZTkyMzllNzg2OTFhYjM4YjcyY2UwMTY0NzFmNzc0NmY1Mjc3ZGNlZjg0YWQ3OWZjNjBmODAyMGIxMzJjNzMnLCBjcmVkZW50aWFsOiAnYWJhOWIxNjk1NDZlYjZkY2M3YmZiMWNkZjM0NTQ0Y2Y5NWI1MTYxZDYwMmUzYjVmYTdjODM0MmIyZTk4MDJmYicgfVxuICAvLyBodHRwczovL2Zhc3R0dXJuLm5ldC8gQ3VycmVudGx5IDUwME1CL21vbnRoPyAoMjUgR0IvbW9udGggZm9yICQ5L21vbnRoKVxuICAvLyBodHRwczovL3hpcnN5cy5jb20vcHJpY2luZy8gNTAwIE1CL21vbnRoICg1MCBHQi9tb250aCBmb3IgJDMzL21vbnRoKVxuICAvLyBBbHNvIGh0dHBzOi8vd3d3Lm5wbWpzLmNvbS9wYWNrYWdlL25vZGUtdHVybiBvciBodHRwczovL21lZXRyaXguaW8vYmxvZy93ZWJydGMvY290dXJuL2luc3RhbGxhdGlvbi5odG1sXG5dO1xuXG4vLyBVdGlsaXR5IHdyYXBwZXIgYXJvdW5kIFJUQ1BlZXJDb25uZWN0aW9uLlxuLy8gV2hlbiBzb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gKHN1Y2ggYXMgY3JlYXRlRGF0YUNoYW5uZWwpLCBpdCB3aWxsIGdlbmVyYXRlIGNhbGxzIHRvIHNpZ25hbCgpLCB3aGljaCBuZWVkcyB0byBiZSBkZWZpbmVkIGJ5IHN1YmNsYXNzZXMuXG5leHBvcnQgY2xhc3MgV2ViUlRDIHtcbiAgY29uc3RydWN0b3Ioe2xhYmVsID0gJycsIGNvbmZpZ3VyYXRpb24gPSBudWxsLCB1dWlkID0gdXVpZDQoKSwgZGVidWcgPSBmYWxzZSwgZXJyb3IgPSBjb25zb2xlLmVycm9yLCAuLi5yZXN0fSA9IHt9KSB7XG4gICAgY29uZmlndXJhdGlvbiA/Pz0ge2ljZVNlcnZlcnN9OyAvLyBJZiBjb25maWd1cmF0aW9uIGNhbiBiZSBvbW1pdHRlZCBvciBleHBsaWNpdGx5IGFzIG51bGwsIHVzZSBvdXIgZGVmYXVsdC4gQnV0IGlmIHt9LCBsZWF2ZSBpdCBiZS5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtsYWJlbCwgY29uZmlndXJhdGlvbiwgdXVpZCwgZGVidWcsIGVycm9yLCAuLi5yZXN0fSk7XG4gICAgdGhpcy5yZXNldFBlZXIoKTtcbiAgfVxuICBzaWduYWwodHlwZSwgbWVzc2FnZSkgeyAvLyBTdWJjbGFzc2VzIG11c3Qgb3ZlcnJpZGUgb3IgZXh0ZW5kLiBEZWZhdWx0IGp1c3QgbG9ncy5cbiAgICB0aGlzLmxvZygnc2VuZGluZycsIHR5cGUsIHR5cGUubGVuZ3RoLCBKU09OLnN0cmluZ2lmeShtZXNzYWdlKS5sZW5ndGgpO1xuICB9XG5cbiAgcGVlclZlcnNpb24gPSAwO1xuICByZXNldFBlZXIoKSB7IC8vIFNldCB1cCBhIG5ldyBSVENQZWVyQ29ubmVjdGlvbi4gKENhbGxlciBtdXN0IGNsb3NlIG9sZCBpZiBuZWNlc3NhcnkuKVxuICAgIGNvbnN0IG9sZCA9IHRoaXMucGVlcjtcbiAgICBpZiAob2xkKSB7XG4gICAgICBvbGQub25uZWdvdGlhdGlvbm5lZWRlZCA9IG9sZC5vbmljZWNhbmRpZGF0ZSA9IG9sZC5vbmljZWNhbmRpZGF0ZWVycm9yID0gb2xkLm9uY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gbnVsbDtcbiAgICAgIC8vIERvbid0IGNsb3NlIHVubGVzcyBpdCdzIGJlZW4gb3BlbmVkLCBiZWNhdXNlIHRoZXJlIGFyZSBsaWtlbHkgaGFuZGxlcnMgdGhhdCB3ZSBkb24ndCB3YW50IHRvIGZpcmUuXG4gICAgICBpZiAob2xkLmNvbm5lY3Rpb25TdGF0ZSAhPT0gJ25ldycpIG9sZC5jbG9zZSgpO1xuICAgIH1cbiAgICBjb25zdCBwZWVyID0gdGhpcy5wZWVyID0gbmV3IHdydGMuUlRDUGVlckNvbm5lY3Rpb24odGhpcy5jb25maWd1cmF0aW9uKTtcbiAgICBwZWVyLnZlcnNpb25JZCA9IHRoaXMucGVlclZlcnNpb24rKztcbiAgICBwZWVyLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBldmVudCA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkKGV2ZW50KTtcbiAgICBwZWVyLm9uaWNlY2FuZGlkYXRlID0gZXZlbnQgPT4gdGhpcy5vbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KTtcbiAgICAvLyBJIGRvbid0IHRoaW5rIGFueW9uZSBhY3R1YWxseSBzaWduYWxzIHRoaXMuIEluc3RlYWQsIHRoZXkgcmVqZWN0IGZyb20gYWRkSWNlQ2FuZGlkYXRlLCB3aGljaCB3ZSBoYW5kbGUgdGhlIHNhbWUuXG4gICAgcGVlci5vbmljZWNhbmRpZGF0ZWVycm9yID0gZXJyb3IgPT4gdGhpcy5pY2VjYW5kaWRhdGVFcnJvcihlcnJvcik7XG4gICAgLy8gSSB0aGluayB0aGlzIGlzIHJlZHVuZG5hbnQgYmVjYXVzZSBubyBpbXBsZW1lbnRhdGlvbiBmaXJlcyB0aGlzIGV2ZW50IGFueSBzaWduaWZpY2FudCB0aW1lIGFoZWFkIG9mIGVtaXR0aW5nIGljZWNhbmRpZGF0ZSB3aXRoIGFuIGVtcHR5IGV2ZW50LmNhbmRpZGF0ZS5cbiAgICBwZWVyLm9uaWNlZ2F0aGVyaW5nc3RhdGVjaGFuZ2UgPSBldmVudCA9PiAocGVlci5pY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJykgJiYgdGhpcy5vbkxvY2FsRW5kSWNlO1xuICAgIHBlZXIub25jb25uZWN0aW9uc3RhdGVjaGFuZ2UgPSBldmVudCA9PiB0aGlzLmNvbm5lY3Rpb25TdGF0ZUNoYW5nZSh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlKTtcbiAgfVxuICBvbkxvY2FsSWNlQ2FuZGlkYXRlKGV2ZW50KSB7XG4gICAgLy8gVGhlIHNwZWMgc2F5cyB0aGF0IGEgbnVsbCBjYW5kaWRhdGUgc2hvdWxkIG5vdCBiZSBzZW50LCBidXQgdGhhdCBhbiBlbXB0eSBzdHJpbmcgY2FuZGlkYXRlIHNob3VsZC4gU2FmYXJpICh1c2VkIHRvPykgZ2V0IGVycm9ycyBlaXRoZXIgd2F5LlxuICAgIGlmICghZXZlbnQuY2FuZGlkYXRlIHx8ICFldmVudC5jYW5kaWRhdGUuY2FuZGlkYXRlKSB0aGlzLm9uTG9jYWxFbmRJY2UoKTtcbiAgICBlbHNlIHRoaXMuc2lnbmFsKCdpY2VjYW5kaWRhdGUnLCBldmVudC5jYW5kaWRhdGUpO1xuICB9XG4gIG9uTG9jYWxFbmRJY2UoKSB7IC8vIFRyaWdnZXJlZCBvbiBvdXIgc2lkZSBieSBhbnkvYWxsIG9mIG9uaWNlY2FuZGlkYXRlIHdpdGggbm8gZXZlbnQuY2FuZGlkYXRlLCBpY2VHYXRoZXJpbmdTdGF0ZSA9PT0gJ2NvbXBsZXRlJy5cbiAgICAvLyBJLmUuLCBjYW4gaGFwcGVuIG11bHRpcGxlIHRpbWVzLiBTdWJjbGFzc2VzIG1pZ2h0IGRvIHNvbWV0aGluZy5cbiAgfVxuICBjbG9zZSgpIHtcbiAgICBpZiAoKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICduZXcnKSAmJiAodGhpcy5wZWVyLnNpZ25hbGluZ1N0YXRlID09PSAnc3RhYmxlJykpIHJldHVybjtcbiAgICB0aGlzLnJlc2V0UGVlcigpO1xuICB9XG4gIGNvbm5lY3Rpb25TdGF0ZUNoYW5nZShzdGF0ZSkge1xuICAgIHRoaXMubG9nKCdzdGF0ZSBjaGFuZ2U6Jywgc3RhdGUpO1xuICAgIGlmIChbJ2Rpc2Nvbm5lY3RlZCcsICdmYWlsZWQnLCAnY2xvc2VkJ10uaW5jbHVkZXMoc3RhdGUpKSB0aGlzLmNsb3NlKCk7IC8vIE90aGVyIGJlaGF2aW9yIGFyZSByZWFzb25hYmxlLCB0b2xvLlxuICB9XG4gIG5lZ290aWF0aW9ubmVlZGVkKCkgeyAvLyBTb21ldGhpbmcgaGFzIGNoYW5nZWQgbG9jYWxseSAobmV3IHN0cmVhbSwgb3IgbmV0d29yayBjaGFuZ2UpLCBzdWNoIHRoYXQgd2UgaGF2ZSB0byBzdGFydCBuZWdvdGlhdGlvbi5cbiAgICB0aGlzLmxvZygnbmVnb3RpYXRpb25ubmVlZGVkJyk7XG4gICAgdGhpcy5wZWVyLmNyZWF0ZU9mZmVyKClcbiAgICAgIC50aGVuKG9mZmVyID0+IHtcbiAgICAgICAgdGhpcy5wZWVyLnNldExvY2FsRGVzY3JpcHRpb24ob2ZmZXIpOyAvLyBwcm9taXNlIGRvZXMgbm90IHJlc29sdmUgdG8gb2ZmZXJcblx0cmV0dXJuIG9mZmVyO1xuICAgICAgfSlcbiAgICAgIC50aGVuKG9mZmVyID0+IHRoaXMuc2lnbmFsKCdvZmZlcicsIG9mZmVyKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB0aGlzLm5lZ290aWF0aW9ubmVlZGVkRXJyb3IoZXJyb3IpKTtcbiAgfVxuICBvZmZlcihvZmZlcikgeyAvLyBIYW5kbGVyIGZvciByZWNlaXZpbmcgYW4gb2ZmZXIgZnJvbSB0aGUgb3RoZXIgdXNlciAod2hvIHN0YXJ0ZWQgdGhlIHNpZ25hbGluZyBwcm9jZXNzKS5cbiAgICAvLyBOb3RlIHRoYXQgZHVyaW5nIHNpZ25hbGluZywgd2Ugd2lsbCByZWNlaXZlIG5lZ290aWF0aW9ubmVlZGVkL2Fuc3dlciwgb3Igb2ZmZXIsIGJ1dCBub3QgYm90aCwgZGVwZW5kaW5nXG4gICAgLy8gb24gd2hldGhlciB3ZSB3ZXJlIHRoZSBvbmUgdGhhdCBzdGFydGVkIHRoZSBzaWduYWxpbmcgcHJvY2Vzcy5cbiAgICB0aGlzLnBlZXIuc2V0UmVtb3RlRGVzY3JpcHRpb24ob2ZmZXIpXG4gICAgICAudGhlbihfID0+IHRoaXMucGVlci5jcmVhdGVBbnN3ZXIoKSlcbiAgICAgIC50aGVuKGFuc3dlciA9PiB0aGlzLnBlZXIuc2V0TG9jYWxEZXNjcmlwdGlvbihhbnN3ZXIpKSAvLyBwcm9taXNlIGRvZXMgbm90IHJlc29sdmUgdG8gYW5zd2VyXG4gICAgICAudGhlbihfID0+IHRoaXMuc2lnbmFsKCdhbnN3ZXInLCB0aGlzLnBlZXIubG9jYWxEZXNjcmlwdGlvbikpO1xuICB9XG4gIGFuc3dlcihhbnN3ZXIpIHsgLy8gSGFuZGxlciBmb3IgZmluaXNoaW5nIHRoZSBzaWduYWxpbmcgcHJvY2VzcyB0aGF0IHdlIHN0YXJ0ZWQuXG4gICAgdGhpcy5wZWVyLnNldFJlbW90ZURlc2NyaXB0aW9uKGFuc3dlcik7XG4gIH1cbiAgaWNlY2FuZGlkYXRlKGljZUNhbmRpZGF0ZSkgeyAvLyBIYW5kbGVyIGZvciBhIG5ldyBjYW5kaWRhdGUgcmVjZWl2ZWQgZnJvbSB0aGUgb3RoZXIgZW5kIHRocm91Z2ggc2lnbmFsaW5nLlxuICAgIHRoaXMucGVlci5hZGRJY2VDYW5kaWRhdGUoaWNlQ2FuZGlkYXRlKS5jYXRjaChlcnJvciA9PiB0aGlzLmljZWNhbmRpZGF0ZUVycm9yKGVycm9yKSk7XG4gIH1cbiAgbG9nKC4uLnJlc3QpIHtcbiAgICBpZiAodGhpcy5kZWJ1ZykgY29uc29sZS5sb2codGhpcy5sYWJlbCwgdGhpcy5wZWVyLnZlcnNpb25JZCwgLi4ucmVzdCk7XG4gIH1cbiAgbG9nRXJyb3IobGFiZWwsIGV2ZW50T3JFeGNlcHRpb24pIHtcbiAgICBjb25zdCBkYXRhID0gW3RoaXMubGFiZWwsIHRoaXMucGVlci52ZXJzaW9uSWQsIC4uLnRoaXMuY29uc3RydWN0b3IuZ2F0aGVyRXJyb3JEYXRhKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKV07XG4gICAgdGhpcy5lcnJvcihkYXRhKTtcbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuICBzdGF0aWMgZXJyb3IoZXJyb3IpIHtcbiAgfVxuICBzdGF0aWMgZ2F0aGVyRXJyb3JEYXRhKGxhYmVsLCBldmVudE9yRXhjZXB0aW9uKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIGxhYmVsICsgXCIgZXJyb3I6XCIsXG4gICAgICBldmVudE9yRXhjZXB0aW9uLmNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5lcnJvckNvZGUgfHwgZXZlbnRPckV4Y2VwdGlvbi5zdGF0dXMgfHwgXCJcIiwgLy8gRmlyc3QgaXMgZGVwcmVjYXRlZCwgYnV0IHN0aWxsIHVzZWZ1bC5cbiAgICAgIGV2ZW50T3JFeGNlcHRpb24udXJsIHx8IGV2ZW50T3JFeGNlcHRpb24ubmFtZSB8fCAnJyxcbiAgICAgIGV2ZW50T3JFeGNlcHRpb24ubWVzc2FnZSB8fCBldmVudE9yRXhjZXB0aW9uLmVycm9yVGV4dCB8fCBldmVudE9yRXhjZXB0aW9uLnN0YXR1c1RleHQgfHwgZXZlbnRPckV4Y2VwdGlvblxuICAgIF07XG4gIH1cbiAgaWNlY2FuZGlkYXRlRXJyb3IoZXZlbnRPckV4Y2VwdGlvbikgeyAvLyBGb3IgZXJyb3JzIG9uIHRoaXMgcGVlciBkdXJpbmcgZ2F0aGVyaW5nLlxuICAgIC8vIENhbiBiZSBvdmVycmlkZGVuIG9yIGV4dGVuZGVkIGJ5IGFwcGxpY2F0aW9ucy5cblxuICAgIC8vIFNUVU4gZXJyb3JzIGFyZSBpbiB0aGUgcmFuZ2UgMzAwLTY5OS4gU2VlIFJGQyA1Mzg5LCBzZWN0aW9uIDE1LjZcbiAgICAvLyBmb3IgYSBsaXN0IG9mIGNvZGVzLiBUVVJOIGFkZHMgYSBmZXcgbW9yZSBlcnJvciBjb2Rlczsgc2VlXG4gICAgLy8gUkZDIDU3NjYsIHNlY3Rpb24gMTUgZm9yIGRldGFpbHMuXG4gICAgLy8gU2VydmVyIGNvdWxkIG5vdCBiZSByZWFjaGVkIGFyZSBpbiB0aGUgcmFuZ2UgNzAwLTc5OS5cbiAgICBjb25zdCBjb2RlID0gZXZlbnRPckV4Y2VwdGlvbi5jb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uZXJyb3JDb2RlIHx8IGV2ZW50T3JFeGNlcHRpb24uc3RhdHVzO1xuICAgIC8vIENocm9tZSBnaXZlcyA3MDEgZXJyb3JzIGZvciBzb21lIHR1cm4gc2VydmVycyB0aGF0IGl0IGRvZXMgbm90IGdpdmUgZm9yIG90aGVyIHR1cm4gc2VydmVycy5cbiAgICAvLyBUaGlzIGlzbid0IGdvb2QsIGJ1dCBpdCdzIHdheSB0b28gbm9pc3kgdG8gc2xvZyB0aHJvdWdoIHN1Y2ggZXJyb3JzLCBhbmQgSSBkb24ndCBrbm93IGhvdyB0byBmaXggb3VyIHR1cm4gY29uZmlndXJhdGlvbi5cbiAgICBpZiAoY29kZSA9PT0gNzAxKSByZXR1cm47XG4gICAgdGhpcy5sb2dFcnJvcignaWNlJywgZXZlbnRPckV4Y2VwdGlvbik7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFByb21pc2VXZWJSVEMgZXh0ZW5kcyBXZWJSVEMge1xuICAvLyBFeHRlbmRzIFdlYlJUQy5zaWduYWwoKSBzdWNoIHRoYXQ6XG4gIC8vIC0gaW5zdGFuY2Uuc2lnbmFscyBhbnN3ZXJzIGEgcHJvbWlzZSB0aGF0IHdpbGwgcmVzb2x2ZSB3aXRoIGFuIGFycmF5IG9mIHNpZ25hbCBtZXNzYWdlcy5cbiAgLy8gLSBpbnN0YW5jZS5zaWduYWxzID0gWy4uLnNpZ25hbE1lc3NhZ2VzXSB3aWxsIGRpc3BhdGNoIHRob3NlIG1lc3NhZ2VzLlxuICAvL1xuICAvLyBGb3IgZXhhbXBsZSwgc3VwcG9zZSBwZWVyMSBhbmQgcGVlcjIgYXJlIGluc3RhbmNlcyBvZiB0aGlzLlxuICAvLyAwLiBTb21ldGhpbmcgdHJpZ2dlcnMgbmVnb3RpYXRpb24gb24gcGVlcjEgKHN1Y2ggYXMgY2FsbGluZyBwZWVyMS5jcmVhdGVEYXRhQ2hhbm5lbCgpKS4gXG4gIC8vIDEuIHBlZXIxLnNpZ25hbHMgcmVzb2x2ZXMgd2l0aCA8c2lnbmFsMT4sIGEgUE9KTyB0byBiZSBjb252ZXllZCB0byBwZWVyMi5cbiAgLy8gMi4gU2V0IHBlZXIyLnNpZ25hbHMgPSA8c2lnbmFsMT4uXG4gIC8vIDMuIHBlZXIyLnNpZ25hbHMgcmVzb2x2ZXMgd2l0aCA8c2lnbmFsMj4sIGEgUE9KTyB0byBiZSBjb252ZXllZCB0byBwZWVyMS5cbiAgLy8gNC4gU2V0IHBlZXIxLnNpZ25hbHMgPSA8c2lnbmFsMj4uXG4gIC8vIDUuIERhdGEgZmxvd3MsIGJ1dCBlYWNoIHNpZGUgd2hvdWxkIGdyYWIgYSBuZXcgc2lnbmFscyBwcm9taXNlIGFuZCBiZSBwcmVwYXJlZCB0byBhY3QgaWYgaXQgcmVzb2x2ZXMuXG4gIC8vXG4gIGNvbnN0cnVjdG9yKHtpY2VUaW1lb3V0ID0gMmUzLCAuLi5wcm9wZXJ0aWVzfSkge1xuICAgIHN1cGVyKHByb3BlcnRpZXMpO1xuICAgIHRoaXMuaWNlVGltZW91dCA9IGljZVRpbWVvdXQ7XG4gIH1cbiAgZ2V0IHNpZ25hbHMoKSB7IC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZSB0byB0aGUgc2lnbmFsIG1lc3NhZ2luZyB3aGVuIGljZSBjYW5kaWRhdGUgZ2F0aGVyaW5nIGlzIGNvbXBsZXRlLlxuICAgIHJldHVybiB0aGlzLl9zaWduYWxQcm9taXNlIHx8PSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB0aGlzLl9zaWduYWxSZWFkeSA9IHtyZXNvbHZlLCByZWplY3R9KTtcbiAgfVxuICBzZXQgc2lnbmFscyhkYXRhKSB7IC8vIFNldCB3aXRoIHRoZSBzaWduYWxzIHJlY2VpdmVkIGZyb20gdGhlIG90aGVyIGVuZC5cbiAgICBkYXRhLmZvckVhY2goKFt0eXBlLCBtZXNzYWdlXSkgPT4gdGhpc1t0eXBlXShtZXNzYWdlKSk7XG4gIH1cbiAgb25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCkge1xuICAgIC8vIEVhY2ggd3J0YyBpbXBsZW1lbnRhdGlvbiBoYXMgaXRzIG93biBpZGVhcyBhcyB0byB3aGF0IGljZSBjYW5kaWRhdGVzIHRvIHRyeSBiZWZvcmUgZW1pdHRpbmcgdGhlbSBpbiBpY2VjYW5kZGlhdGUuXG4gICAgLy8gTW9zdCB3aWxsIHRyeSB0aGluZ3MgdGhhdCBjYW5ub3QgYmUgcmVhY2hlZCwgYW5kIGdpdmUgdXAgd2hlbiB0aGV5IGhpdCB0aGUgT1MgbmV0d29yayB0aW1lb3V0LiBGb3J0eSBzZWNvbmRzIGlzIGEgbG9uZyB0aW1lIHRvIHdhaXQuXG4gICAgLy8gSWYgdGhlIHdydGMgaXMgc3RpbGwgd2FpdGluZyBhZnRlciBvdXIgaWNlVGltZW91dCAoMiBzZWNvbmRzKSwgbGV0cyBqdXN0IGdvIHdpdGggd2hhdCB3ZSBoYXZlLlxuICAgIHRoaXMudGltZXIgfHw9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5vbkxvY2FsRW5kSWNlKCksIHRoaXMuaWNlVGltZW91dCk7XG4gICAgc3VwZXIub25Mb2NhbEljZUNhbmRpZGF0ZShldmVudCk7XG4gIH1cbiAgY2xlYXJJY2VUaW1lcigpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcik7XG4gICAgdGhpcy50aW1lciA9IG51bGw7XG4gIH1cbiAgYXN5bmMgb25Mb2NhbEVuZEljZSgpIHsgLy8gUmVzb2x2ZSB0aGUgcHJvbWlzZSB3aXRoIHdoYXQgd2UndmUgYmVlbiBnYXRoZXJpbmcuXG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgaWYgKCF0aGlzLl9zaWduYWxQcm9taXNlKSB7XG4gICAgICAvL3RoaXMubG9nRXJyb3IoJ2ljZScsIFwiRW5kIG9mIElDRSB3aXRob3V0IGFueXRoaW5nIHdhaXRpbmcgb24gc2lnbmFscy5cIik7IC8vIE5vdCBoZWxwZnVsIHdoZW4gdGhlcmUgYXJlIHRocmVlIHdheXMgdG8gcmVjZWl2ZSB0aGlzIG1lc3NhZ2UuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3NpZ25hbFJlYWR5LnJlc29sdmUodGhpcy5zZW5kaW5nKTtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgfVxuICBzZW5kaW5nID0gW107XG4gIHNpZ25hbCh0eXBlLCBtZXNzYWdlKSB7XG4gICAgc3VwZXIuc2lnbmFsKHR5cGUsIG1lc3NhZ2UpO1xuICAgIHRoaXMuc2VuZGluZy5wdXNoKFt0eXBlLCBtZXNzYWdlXSk7XG4gIH1cbiAgLy8gV2UgbmVlZCB0byBrbm93IGlmIHRoZXJlIGFyZSBvcGVuIGRhdGEgY2hhbm5lbHMuIFRoZXJlIGlzIGEgcHJvcG9zYWwgYW5kIGV2ZW4gYW4gYWNjZXB0ZWQgUFIgZm9yIFJUQ1BlZXJDb25uZWN0aW9uLmdldERhdGFDaGFubmVscygpLFxuICAvLyBodHRwczovL2dpdGh1Yi5jb20vdzNjL3dlYnJ0Yy1leHRlbnNpb25zL2lzc3Vlcy8xMTBcbiAgLy8gYnV0IGl0IGhhc24ndCBiZWVuIGRlcGxveWVkIGV2ZXJ5d2hlcmUgeWV0LiBTbyB3ZSdsbCBuZWVkIHRvIGtlZXAgb3VyIG93biBjb3VudC5cbiAgLy8gQWxhcywgYSBjb3VudCBpc24ndCBlbm91Z2gsIGJlY2F1c2Ugd2UgY2FuIG9wZW4gc3R1ZmYsIGFuZCB0aGUgb3RoZXIgc2lkZSBjYW4gb3BlbiBzdHVmZiwgYnV0IGlmIGl0IGhhcHBlbnMgdG8gYmVcbiAgLy8gdGhlIHNhbWUgXCJuZWdvdGlhdGVkXCIgaWQsIGl0IGlzbid0IHJlYWxseSBhIGRpZmZlcmVudCBjaGFubmVsLiAoaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL1JUQ1BlZXJDb25uZWN0aW9uL2RhdGFjaGFubmVsX2V2ZW50XG4gIGRhdGFDaGFubmVscyA9IG5ldyBNYXAoKTtcbiAgcmVwb3J0Q2hhbm5lbHMoKSB7IC8vIFJldHVybiBhIHJlcG9ydCBzdHJpbmcgdXNlZnVsIGZvciBkZWJ1Z2dpbmcuXG4gICAgY29uc3QgZW50cmllcyA9IEFycmF5LmZyb20odGhpcy5kYXRhQ2hhbm5lbHMuZW50cmllcygpKTtcbiAgICBjb25zdCBrdiA9IGVudHJpZXMubWFwKChbaywgdl0pID0+IGAke2t9OiR7di5pZH1gKTtcbiAgICByZXR1cm4gYCR7dGhpcy5kYXRhQ2hhbm5lbHMuc2l6ZX0vJHtrdi5qb2luKCcsICcpfWA7XG4gIH1cbiAgbm90ZUNoYW5uZWwoY2hhbm5lbCwgc291cmNlLCB3YWl0aW5nKSB7IC8vIEJvb2trZWVwIG9wZW4gY2hhbm5lbCBhbmQgcmV0dXJuIGl0LlxuICAgIC8vIEVtcGVyaWNhbGx5LCB3aXRoIG11bHRpcGxleCBmYWxzZTogLy8gICAxOCBvY2N1cnJlbmNlcywgd2l0aCBpZD1udWxsfDB8MSBhcyBmb3IgZXZlbnRjaGFubmVsIG9yIGNyZWF0ZURhdGFDaGFubmVsXG4gICAgLy8gICBBcHBhcmVudGx5LCB3aXRob3V0IG5lZ290aWF0aW9uLCBpZCBpcyBpbml0aWFsbHkgbnVsbCAocmVnYXJkbGVzcyBvZiBvcHRpb25zLmlkKSwgYW5kIHRoZW4gYXNzaWduZWQgdG8gYSBmcmVlIHZhbHVlIGR1cmluZyBvcGVuaW5nXG4gICAgY29uc3Qga2V5ID0gY2hhbm5lbC5sYWJlbDsgLy9maXhtZSBjaGFubmVsLmlkID09PSBudWxsID8gMSA6IGNoYW5uZWwuaWQ7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmRhdGFDaGFubmVscy5nZXQoa2V5KTtcbiAgICB0aGlzLmxvZygnZ290IGRhdGEtY2hhbm5lbCcsIHNvdXJjZSwga2V5LCBjaGFubmVsLnJlYWR5U3RhdGUsICdleGlzdGluZzonLCBleGlzdGluZywgJ3dhaXRpbmc6Jywgd2FpdGluZyk7XG4gICAgdGhpcy5kYXRhQ2hhbm5lbHMuc2V0KGtleSwgY2hhbm5lbCk7XG4gICAgY2hhbm5lbC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsIGV2ZW50ID0+IHsgLy8gQ2xvc2Ugd2hvbGUgY29ubmVjdGlvbiB3aGVuIG5vIG1vcmUgZGF0YSBjaGFubmVscyBvciBzdHJlYW1zLlxuICAgICAgdGhpcy5kYXRhQ2hhbm5lbHMuZGVsZXRlKGtleSk7XG4gICAgICAvLyBJZiB0aGVyZSdzIG5vdGhpbmcgb3BlbiwgY2xvc2UgdGhlIGNvbm5lY3Rpb24uXG4gICAgICBpZiAodGhpcy5kYXRhQ2hhbm5lbHMuc2l6ZSkgcmV0dXJuO1xuICAgICAgaWYgKHRoaXMucGVlci5nZXRTZW5kZXJzKCkubGVuZ3RoKSByZXR1cm47XG4gICAgICB0aGlzLmNsb3NlKCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIGNoYW5uZWw7XG4gIH1cbiAgY3JlYXRlRGF0YUNoYW5uZWwobGFiZWwgPSBcImRhdGFcIiwgY2hhbm5lbE9wdGlvbnMgPSB7fSkgeyAvLyBQcm9taXNlIHJlc29sdmVzIHdoZW4gdGhlIGNoYW5uZWwgaXMgb3BlbiAod2hpY2ggd2lsbCBiZSBhZnRlciBhbnkgbmVlZGVkIG5lZ290aWF0aW9uKS5cbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICB0aGlzLmxvZygnY3JlYXRlIGRhdGEtY2hhbm5lbCcsIGxhYmVsLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgICBsZXQgY2hhbm5lbCA9IHRoaXMucGVlci5jcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY2hhbm5lbE9wdGlvbnMpO1xuICAgICAgdGhpcy5ub3RlQ2hhbm5lbChjaGFubmVsLCAnZXhwbGljaXQnKTsgLy8gTm90ZWQgZXZlbiBiZWZvcmUgb3BlbmVkLlxuICAgICAgLy8gVGhlIGNoYW5uZWwgbWF5IGhhdmUgYWxyZWFkeSBiZWVuIG9wZW5lZCBvbiB0aGUgb3RoZXIgc2lkZS4gSW4gdGhpcyBjYXNlLCBhbGwgYnJvd3NlcnMgZmlyZSB0aGUgb3BlbiBldmVudCBhbnl3YXksXG4gICAgICAvLyBidXQgd3J0YyAoaS5lLiwgb24gbm9kZUpTKSBkb2VzIG5vdC4gU28gd2UgaGF2ZSB0byBleHBsaWNpdGx5IGNoZWNrLlxuICAgICAgc3dpdGNoIChjaGFubmVsLnJlYWR5U3RhdGUpIHtcbiAgICAgIGNhc2UgJ29wZW4nOlxuXHRzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoY2hhbm5lbCksIDEwKTtcblx0YnJlYWs7XG4gICAgICBjYXNlICdjb25uZWN0aW5nJzpcblx0Y2hhbm5lbC5vbm9wZW4gPSBfID0+IHJlc29sdmUoY2hhbm5lbCk7XG5cdGJyZWFrO1xuICAgICAgZGVmYXVsdDpcblx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHJlYWR5U3RhdGUgJHtjaGFubmVsLnJlYWR5U3RhdGV9IGZvciBkYXRhIGNoYW5uZWwgJHtsYWJlbH0uYCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgd2FpdGluZ0NoYW5uZWxzID0ge307XG4gIGdldERhdGFDaGFubmVsUHJvbWlzZShsYWJlbCA9IFwiZGF0YVwiKSB7IC8vIFJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIHRoaXMubG9nKCdwcm9taXNlIGRhdGEtY2hhbm5lbCcsIGxhYmVsKTtcbiAgICAgIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXSA9IHJlc29sdmU7XG4gICAgfSk7XG4gIH1cbiAgcmVzZXRQZWVyKCkgeyAvLyBSZXNldCBhICdjb25uZWN0ZWQnIHByb3BlcnR5IHRoYXQgcHJvbWlzZWQgdG8gcmVzb2x2ZSB3aGVuIG9wZW5lZCwgYW5kIHRyYWNrIGluY29taW5nIGRhdGFjaGFubmVscy5cbiAgICBzdXBlci5yZXNldFBlZXIoKTtcbiAgICB0aGlzLmNvbm5lY3RlZCA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyAvLyB0aGlzLmNvbm5lY3RlZCBpcyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGFyZS5cbiAgICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdjb25uZWN0aW9uc3RhdGVjaGFuZ2UnLCBldmVudCA9PiB7XG5cdGlmICh0aGlzLnBlZXIuY29ubmVjdGlvblN0YXRlID09PSAnY29ubmVjdGVkJykge1xuXHQgIHJlc29sdmUodHJ1ZSk7XG5cdH1cbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMucGVlci5hZGRFdmVudExpc3RlbmVyKCdkYXRhY2hhbm5lbCcsIGV2ZW50ID0+IHsgLy8gUmVzb2x2ZSBwcm9taXNlIG1hZGUgd2l0aCBnZXREYXRhQ2hhbm5lbFByb21pc2UoKS5cbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBldmVudC5jaGFubmVsO1xuICAgICAgY29uc3QgbGFiZWwgPSBjaGFubmVsLmxhYmVsO1xuICAgICAgY29uc3Qgd2FpdGluZyA9IHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHRoaXMubm90ZUNoYW5uZWwoY2hhbm5lbCwgJ2RhdGFjaGFubmVsIGV2ZW50Jywgd2FpdGluZyk7IC8vIFJlZ2FyZGxlc3Mgb2Ygd2hldGhlciB3ZSBhcmUgd2FpdGluZy5cbiAgICAgIGlmICghd2FpdGluZykgcmV0dXJuOyAvLyBNaWdodCBub3QgYmUgZXhwbGljaXRseSB3YWl0aW5nLiBFLmcuLCByb3V0ZXJzLlxuICAgICAgZGVsZXRlIHRoaXMud2FpdGluZ0NoYW5uZWxzW2xhYmVsXTtcbiAgICAgIHdhaXRpbmcoY2hhbm5lbCk7XG4gICAgfSk7XG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgaWYgKHRoaXMucGVlci5jb25uZWN0aW9uU3RhdGUgPT09ICdmYWlsZWQnKSB0aGlzLl9zaWduYWxQcm9taXNlPy5yZWplY3Q/LigpO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgdGhpcy5jbGVhckljZVRpbWVyKCk7XG4gICAgdGhpcy5fc2lnbmFsUHJvbWlzZSA9IHRoaXMuX3NpZ25hbFJlYWR5ID0gbnVsbDtcbiAgICB0aGlzLnNlbmRpbmcgPSBbXTtcbiAgICAvLyBJZiB0aGUgd2VicnRjIGltcGxlbWVudGF0aW9uIGNsb3NlcyB0aGUgZGF0YSBjaGFubmVscyBiZWZvcmUgdGhlIHBlZXIgaXRzZWxmLCB0aGVuIHRoaXMuZGF0YUNoYW5uZWxzIHdpbGwgYmUgZW1wdHkuXG4gICAgLy8gQnV0IGlmIG5vdCAoZS5nLiwgc3RhdHVzICdmYWlsZWQnIG9yICdkaXNjb25uZWN0ZWQnIG9uIFNhZmFyaSksIHRoZW4gbGV0IHVzIGV4cGxpY2l0bHkgY2xvc2UgdGhlbSBzbyB0aGF0IFN5bmNocm9uaXplcnMga25vdyB0byBjbGVhbiB1cC5cbiAgICBmb3IgKGNvbnN0IGNoYW5uZWwgb2YgdGhpcy5kYXRhQ2hhbm5lbHMudmFsdWVzKCkpIHtcbiAgICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgIT09ICdvcGVuJykgY29udGludWU7IC8vIEtlZXAgZGVidWdnaW5nIHNhbml0eS5cbiAgICAgIC8vIEl0IGFwcGVhcnMgdGhhdCBpbiBTYWZhcmkgKDE4LjUpIGZvciBhIGNhbGwgdG8gY2hhbm5lbC5jbG9zZSgpIHdpdGggdGhlIGNvbm5lY3Rpb24gYWxyZWFkeSBpbnRlcm5hbGwgY2xvc2VkLCBTYWZhcmlcbiAgICAgIC8vIHdpbGwgc2V0IGNoYW5uZWwucmVhZHlTdGF0ZSB0byAnY2xvc2luZycsIGJ1dCBOT1QgZmlyZSB0aGUgY2xvc2VkIG9yIGNsb3NpbmcgZXZlbnQuIFNvIHdlIGhhdmUgdG8gZGlzcGF0Y2ggaXQgb3Vyc2VsdmVzLlxuICAgICAgLy9jaGFubmVsLmNsb3NlKCk7XG4gICAgICBjaGFubmVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjbG9zZScpKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gTmVnb3RpYXRlZCBjaGFubmVscyB1c2Ugc3BlY2lmaWMgaW50ZWdlcnMgb24gYm90aCBzaWRlcywgc3RhcnRpbmcgd2l0aCB0aGlzIG51bWJlci5cbi8vIFdlIGRvIG5vdCBzdGFydCBhdCB6ZXJvIGJlY2F1c2UgdGhlIG5vbi1uZWdvdGlhdGVkIGNoYW5uZWxzIChhcyB1c2VkIG9uIHNlcnZlciByZWxheXMpIGdlbmVyYXRlIHRoZWlyXG4vLyBvd24gaWRzIHN0YXJ0aW5nIHdpdGggMCwgYW5kIHdlIGRvbid0IHdhbnQgdG8gY29uZmxpY3QuXG4vLyBUaGUgc3BlYyBzYXlzIHRoZXNlIGNhbiBnbyB0byA2NSw1MzQsIGJ1dCBJIGZpbmQgdGhhdCBzdGFydGluZyBncmVhdGVyIHRoYW4gdGhlIHZhbHVlIGhlcmUgZ2l2ZXMgZXJyb3JzLlxuLy8gQXMgb2YgNy82LzI1LCBjdXJyZW50IGV2ZXJncmVlbiBicm93c2VycyB3b3JrIHdpdGggMTAwMCBiYXNlLCBidXQgRmlyZWZveCBmYWlscyBpbiBvdXIgY2FzZSAoMTAgbmVnb3RhdGlhdGVkIGNoYW5uZWxzKVxuLy8gaWYgYW55IGlkcyBhcmUgMjU2IG9yIGhpZ2hlci5cbmNvbnN0IEJBU0VfQ0hBTk5FTF9JRCA9IDEyNTtcbmV4cG9ydCBjbGFzcyBTaGFyZWRXZWJSVEMgZXh0ZW5kcyBQcm9taXNlV2ViUlRDIHtcbiAgc3RhdGljIGNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICBzdGF0aWMgZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIG11bHRpcGxleCA9IHRydWUsIC4uLnJlc3R9KSB7XG4gICAgbGV0IGNvbm5lY3Rpb24gPSB0aGlzLmNvbm5lY3Rpb25zLmdldChzZXJ2aWNlTGFiZWwpO1xuICAgIC8vIEl0IGlzIHBvc3NpYmxlIHRoYXQgd2Ugd2VyZSBiYWNrZ3JvdW5kZWQgYmVmb3JlIHdlIGhhZCBhIGNoYW5jZSB0byBhY3Qgb24gYSBjbG9zaW5nIGNvbm5lY3Rpb24gYW5kIHJlbW92ZSBpdC5cbiAgICBpZiAoY29ubmVjdGlvbikge1xuICAgICAgY29uc3Qge2Nvbm5lY3Rpb25TdGF0ZSwgc2lnbmFsaW5nU3RhdGV9ID0gY29ubmVjdGlvbi5wZWVyO1xuICAgICAgaWYgKChjb25uZWN0aW9uU3RhdGUgPT09ICdjbG9zZWQnKSB8fCAoc2lnbmFsaW5nU3RhdGUgPT09ICdjbG9zZWQnKSkgY29ubmVjdGlvbiA9IG51bGw7XG4gICAgfVxuICAgIGlmICghY29ubmVjdGlvbikge1xuICAgICAgY29ubmVjdGlvbiA9IG5ldyB0aGlzKHtsYWJlbDogc2VydmljZUxhYmVsLCB1dWlkOiB1dWlkNCgpLCBtdWx0aXBsZXgsIC4uLnJlc3R9KTtcbiAgICAgIGlmIChtdWx0aXBsZXgpIHRoaXMuY29ubmVjdGlvbnMuc2V0KHNlcnZpY2VMYWJlbCwgY29ubmVjdGlvbik7XG4gICAgfVxuICAgIHJldHVybiBjb25uZWN0aW9uO1xuICB9XG4gIGNoYW5uZWxJZCA9IEJBU0VfQ0hBTk5FTF9JRDtcbiAgZ2V0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nKCkge1xuICAgIHJldHVybiB0aGlzLmNoYW5uZWxJZCA+IEJBU0VfQ0hBTk5FTF9JRDtcbiAgfVxuICBjbG9zZShyZW1vdmVDb25uZWN0aW9uID0gdHJ1ZSkge1xuICAgIHRoaXMuY2hhbm5lbElkID0gQkFTRV9DSEFOTkVMX0lEO1xuICAgIHN1cGVyLmNsb3NlKCk7XG4gICAgaWYgKHJlbW92ZUNvbm5lY3Rpb24pIHRoaXMuY29uc3RydWN0b3IuY29ubmVjdGlvbnMuZGVsZXRlKHRoaXMuc2VydmljZUxhYmVsKTtcbiAgfVxuICBhc3luYyBlbnN1cmVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgY2hhbm5lbE9wdGlvbnMgPSB7fSwgc2lnbmFscyA9IG51bGwpIHsgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgYW4gb3BlbiBkYXRhIGNoYW5uZWwgb24gdGhpcyBjb25uZWN0aW9uLlxuICAgIGNvbnN0IGhhc1N0YXJ0ZWRDb25uZWN0aW5nID0gdGhpcy5oYXNTdGFydGVkQ29ubmVjdGluZzsgLy8gTXVzdCBhc2sgYmVmb3JlIGluY3JlbWVudGluZyBpZC5cbiAgICBjb25zdCBpZCA9IHRoaXMuY2hhbm5lbElkKys7IC8vIFRoaXMgYW5kIGV2ZXJ5dGhpbmcgbGVhZGluZyB1cCB0byBpdCBtdXN0IGJlIHN5bmNocm9ub3VzLCBzbyB0aGF0IGlkIGFzc2lnbm1lbnQgaXMgZGV0ZXJtaW5pc3RpYy5cbiAgICBjb25zdCBuZWdvdGlhdGVkID0gKHRoaXMubXVsdGlwbGV4ID09PSAnbmVnb3RpYXRlZCcpICYmIGhhc1N0YXJ0ZWRDb25uZWN0aW5nO1xuICAgIGNvbnN0IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgPSAhaGFzU3RhcnRlZENvbm5lY3RpbmcgLyohbmVnb3RpYXRlZCovICYmICEhc2lnbmFsczsgLy8gT25seSB0aGUgMHRoIHdpdGggc2lnbmFscyB3YWl0cyBwYXNzaXZlbHkuXG4gICAgLy8gc2lnbmFscyBpcyBlaXRoZXIgbnVsbGlzaCBvciBhbiBhcnJheSBvZiBzaWduYWxzLCBidXQgdGhhdCBhcnJheSBjYW4gYmUgRU1QVFksXG4gICAgLy8gaW4gd2hpY2ggY2FzZSB0aGUgcmVhbCBzaWduYWxzIHdpbGwgaGF2ZSB0byBiZSBhc3NpZ25lZCBsYXRlci4gVGhpcyBhbGxvd3MgdGhlIGRhdGEgY2hhbm5lbCB0byBiZSBzdGFydGVkIChhbmQgdG8gY29uc3VtZVxuICAgIC8vIGEgY2hhbm5lbElkKSBzeW5jaHJvbm91c2x5LCBidXQgdGhlIHByb21pc2Ugd29uJ3QgcmVzb2x2ZSB1bnRpbCB0aGUgcmVhbCBzaWduYWxzIGFyZSBzdXBwbGllZCBsYXRlci4gVGhpcyBpc1xuICAgIC8vIHVzZWZ1bCBpbiBtdWx0aXBsZXhpbmcgYW4gb3JkZXJlZCBzZXJpZXMgb2YgZGF0YSBjaGFubmVscyBvbiBhbiBBTlNXRVIgY29ubmVjdGlvbiwgd2hlcmUgdGhlIGRhdGEgY2hhbm5lbHMgbXVzdFxuICAgIC8vIG1hdGNoIHVwIHdpdGggYW4gT0ZGRVIgY29ubmVjdGlvbiBvbiBhIHBlZXIuIFRoaXMgd29ya3MgYmVjYXVzZSBvZiB0aGUgd29uZGVyZnVsIGhhcHBlbnN0YW5jZSB0aGF0IGFuc3dlciBjb25uZWN0aW9uc1xuICAgIC8vIGdldERhdGFDaGFubmVsUHJvbWlzZSAod2hpY2ggZG9lc24ndCByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIHlldCBiZSBvcGVuKSByYXRoZXIgdGhhbiBjcmVhdGVEYXRhQ2hhbm5lbCAod2hpY2ggd291bGRcbiAgICAvLyByZXF1aXJlIHRoZSBjb25uZWN0aW9uIHRvIGFscmVhZHkgYmUgb3BlbikuXG4gICAgY29uc3QgdXNlU2lnbmFscyA9ICFoYXNTdGFydGVkQ29ubmVjdGluZyAmJiBzaWduYWxzPy5sZW5ndGg7XG4gICAgY29uc3Qgb3B0aW9ucyA9IG5lZ290aWF0ZWQgPyB7aWQsIG5lZ290aWF0ZWQsIC4uLmNoYW5uZWxPcHRpb25zfSA6IGNoYW5uZWxPcHRpb25zO1xuICAgIGlmIChoYXNTdGFydGVkQ29ubmVjdGluZykge1xuICAgICAgYXdhaXQgdGhpcy5jb25uZWN0ZWQ7IC8vIEJlZm9yZSBjcmVhdGluZyBwcm9taXNlLlxuICAgICAgLy8gSSBzb21ldGltZXMgZW5jb3VudGVyIGEgYnVnIGluIFNhZmFyaSBpbiB3aGljaCBPTkUgb2YgdGhlIGNoYW5uZWxzIGNyZWF0ZWQgc29vbiBhZnRlciBjb25uZWN0aW9uIGdldHMgc3R1Y2sgaW5cbiAgICAgIC8vIHRoZSBjb25uZWN0aW5nIHJlYWR5U3RhdGUgYW5kIG5ldmVyIG9wZW5zLiBFeHBlcmltZW50YWxseSwgdGhpcyBzZWVtcyB0byBiZSByb2J1c3QuXG4gICAgICAvL1xuICAgICAgLy8gTm90ZSB0byBzZWxmOiBJZiBpdCBzaG91bGQgdHVybiBvdXQgdGhhdCB3ZSBzdGlsbCBoYXZlIHByb2JsZW1zLCB0cnkgc2VyaWFsaXppbmcgdGhlIGNhbGxzIHRvIHBlZXIuY3JlYXRlRGF0YUNoYW5uZWxcbiAgICAgIC8vIHNvIHRoYXQgdGhlcmUgaXNuJ3QgbW9yZSB0aGFuIG9uZSBjaGFubmVsIG9wZW5pbmcgYXQgYSB0aW1lLlxuICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMCkpO1xuICAgIH0gZWxzZSBpZiAodXNlU2lnbmFscykge1xuICAgICAgdGhpcy5zaWduYWxzID0gc2lnbmFscztcbiAgICB9XG4gICAgY29uc3QgcHJvbWlzZSA9IGFsbG93T3RoZXJTaWRlVG9DcmVhdGUgP1xuXHQgIHRoaXMuZ2V0RGF0YUNoYW5uZWxQcm9taXNlKGNoYW5uZWxOYW1lKSA6XG5cdCAgdGhpcy5jcmVhdGVEYXRhQ2hhbm5lbChjaGFubmVsTmFtZSwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIGF3YWl0IHByb21pc2U7XG4gIH1cbn1cbiIsIi8vIG5hbWUvdmVyc2lvbiBvZiBcImRhdGFiYXNlXCJcbmV4cG9ydCBjb25zdCBzdG9yYWdlTmFtZSA9ICdmbGV4c3RvcmUnO1xuZXhwb3J0IGNvbnN0IHN0b3JhZ2VWZXJzaW9uID0gMTE7XG5cbmltcG9ydCAqIGFzIHBrZyBmcm9tIFwiLi4vcGFja2FnZS5qc29uXCIgd2l0aCB7IHR5cGU6ICdqc29uJyB9O1xuZXhwb3J0IGNvbnN0IHtuYW1lLCB2ZXJzaW9ufSA9IHBrZy5kZWZhdWx0O1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHsgdGFnUGF0aCB9IGZyb20gJy4vdGFnUGF0aC5tanMnO1xuaW1wb3J0IHsgU2hhcmVkV2ViUlRDIH0gZnJvbSAnLi93ZWJydGMubWpzJztcbmltcG9ydCB7IHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5cbi8qXG4gIFJlc3BvbnNpYmxlIGZvciBrZWVwaW5nIGEgY29sbGVjdGlvbiBzeW5jaHJvbml6ZWQgd2l0aCBhbm90aGVyIHBlZXIuXG4gIChQZWVycyBtYXkgYmUgYSBjbGllbnQgb3IgYSBzZXJ2ZXIvcmVsYXkuIEluaXRpYWxseSB0aGlzIGlzIHRoZSBzYW1lIGNvZGUgZWl0aGVyIHdheSxcbiAgYnV0IGxhdGVyIG9uLCBvcHRpbWl6YXRpb25zIGNhbiBiZSBtYWRlIGZvciBzY2FsZS4pXG5cbiAgQXMgbG9uZyBhcyB0d28gcGVlcnMgYXJlIGNvbm5lY3RlZCB3aXRoIGEgU3luY2hyb25pemVyIG9uIGVhY2ggc2lkZSwgd3JpdGluZyBoYXBwZW5zXG4gIGluIGJvdGggcGVlcnMgaW4gcmVhbCB0aW1lLCBhbmQgcmVhZGluZyBwcm9kdWNlcyB0aGUgY29ycmVjdCBzeW5jaHJvbml6ZWQgcmVzdWx0IGZyb20gZWl0aGVyLlxuICBVbmRlciB0aGUgaG9vZCwgdGhlIHN5bmNocm9uaXplciBrZWVwcyB0cmFjayBvZiB3aGF0IGl0IGtub3dzIGFib3V0IHRoZSBvdGhlciBwZWVyIC0tXG4gIGEgcGFydGljdWxhciB0YWcgY2FuIGJlIHVua25vd24sIHVuc3luY2hyb25pemVkLCBvciBzeW5jaHJvbml6ZWQsIGFuZCByZWFkaW5nIHdpbGxcbiAgY29tbXVuaWNhdGUgYXMgbmVlZGVkIHRvIGdldCB0aGUgZGF0YSBzeW5jaHJvbml6ZWQgb24tZGVtYW5kLiBNZWFud2hpbGUsIHN5bmNocm9uaXphdGlvblxuICBjb250aW51ZXMgaW4gdGhlIGJhY2tncm91bmQgdW50aWwgdGhlIGNvbGxlY3Rpb24gaXMgZnVsbHkgcmVwbGljYXRlZC5cblxuICBBIGNvbGxlY3Rpb24gbWFpbnRhaW5zIGEgc2VwYXJhdGUgU3luY2hyb25pemVyIGZvciBlYWNoIG9mIHplcm8gb3IgbW9yZSBwZWVycywgYW5kIGNhbiBkeW5hbWljYWxseVxuICBhZGQgYW5kIHJlbW92ZSBtb3JlLlxuXG4gIE5hbWluZyBjb252ZW50aW9uczpcblxuICBtdW1ibGVOYW1lOiBhIHNlbWFudGljIG5hbWUgdXNlZCBleHRlcm5hbGx5IGFzIGEga2V5LiBFeGFtcGxlOiBzZXJ2aWNlTmFtZSwgY2hhbm5lbE5hbWUsIGV0Yy5cbiAgICBXaGVuIHRoaW5ncyBuZWVkIHRvIG1hdGNoIHVwIGFjcm9zcyBzeXN0ZW1zLCBpdCBpcyBieSBuYW1lLlxuICAgIElmIG9ubHkgb25lIG9mIG5hbWUvbGFiZWwgaXMgc3BlY2lmaWVkLCB0aGlzIGlzIHVzdWFsbHkgdGhlIHRoZSBvbmUuXG5cbiAgbXVtYmxlTGFiZWw6IGEgbGFiZWwgZm9yIGlkZW50aWZpY2F0aW9uIGFuZCBpbnRlcm5hbGx5IChlLmcuLCBkYXRhYmFzZSBuYW1lKS5cbiAgICBXaGVuIHR3byBpbnN0YW5jZXMgb2Ygc29tZXRoaW5nIGFyZSBcInRoZSBzYW1lXCIgYnV0IGFyZSBpbiB0aGUgc2FtZSBKYXZhc2NyaXB0IGltYWdlIGZvciB0ZXN0aW5nLCB0aGV5IGFyZSBkaXN0aW5ndWlzaGVkIGJ5IGxhYmVsLlxuICAgIFR5cGljYWxseSBkZWZhdWx0cyB0byBtdW1ibGVOYW1lLlxuXG4gIE5vdGUsIHRob3VnaCwgdGhhdCBzb21lIGV4dGVybmFsIG1hY2hpbmVyeSAoc3VjaCBhcyBhIFdlYlJUQyBEYXRhQ2hhbm5lbCkgaGFzIGEgXCJsYWJlbFwiIHByb3BlcnR5IHRoYXQgd2UgcG9wdWxhdGUgd2l0aCBhIFwibmFtZVwiIChjaGFubmVsTmFtZSkuXG4gKi9cbmV4cG9ydCBjbGFzcyBTeW5jaHJvbml6ZXIge1xuICBzdGF0aWMgdmVyc2lvbiA9IHN0b3JhZ2VWZXJzaW9uO1xuICBjb25zdHJ1Y3Rvcih7c2VydmljZU5hbWUgPSAnZGlyZWN0JywgY29sbGVjdGlvbiwgZXJyb3IgPSBjb2xsZWN0aW9uPy5jb25zdHJ1Y3Rvci5lcnJvciB8fCBjb25zb2xlLmVycm9yLFxuXHQgICAgICAgc2VydmljZUxhYmVsID0gY29sbGVjdGlvbj8uc2VydmljZUxhYmVsIHx8IHNlcnZpY2VOYW1lLCAvLyBVc2VkIHRvIGlkZW50aWZ5IGFueSBleGlzdGluZyBjb25uZWN0aW9uLiBDYW4gYmUgZGlmZmVyZW50IGZyb20gc2VydmljZU5hbWUgZHVyaW5nIHRlc3RpbmcuXG5cdCAgICAgICBjaGFubmVsTmFtZSwgdXVpZCA9IGNvbGxlY3Rpb24/LnV1aWQsIHJ0Y0NvbmZpZ3VyYXRpb24sIGNvbm5lY3Rpb24sIC8vIENvbXBsZXggZGVmYXVsdCBiZWhhdmlvciBmb3IgdGhlc2UuIFNlZSBjb2RlLlxuXHQgICAgICAgbXVsdGlwbGV4ID0gY29sbGVjdGlvbj8ubXVsdGlwbGV4LCAvLyBJZiBzcGVjaWZlZCwgb3RoZXJ3aXNlIHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LiBTZWUgYmVsb3cuXG5cdCAgICAgICBkZWJ1ZyA9IGNvbGxlY3Rpb24/LmRlYnVnLCBtYXhWZXJzaW9uID0gU3luY2hyb25pemVyLnZlcnNpb24sIG1pblZlcnNpb24gPSBtYXhWZXJzaW9ufSkge1xuICAgIC8vIHNlcnZpY2VOYW1lIGlzIGEgc3RyaW5nIG9yIG9iamVjdCB0aGF0IGlkZW50aWZpZXMgd2hlcmUgdGhlIHN5bmNocm9uaXplciBzaG91bGQgY29ubmVjdC4gRS5nLiwgaXQgbWF5IGJlIGEgVVJMIGNhcnJ5aW5nXG4gICAgLy8gICBXZWJSVEMgc2lnbmFsaW5nLiBJdCBzaG91bGQgYmUgYXBwLXVuaXF1ZSBmb3IgdGhpcyBwYXJ0aWN1bGFyIHNlcnZpY2UgKGUuZy4sIHdoaWNoIG1pZ2h0IG11bHRpcGxleCBkYXRhIGZvciBtdWx0aXBsZSBjb2xsZWN0aW9uIGluc3RhbmNlcykuXG4gICAgLy8gdXVpZCBoZWxwIHVuaXF1ZWx5IGlkZW50aWZpZXMgdGhpcyBwYXJ0aWN1bGFyIHN5bmNocm9uaXplci5cbiAgICAvLyAgIEZvciBtb3N0IHB1cnBvc2VzLCB1dWlkIHNob3VsZCBnZXQgdGhlIGRlZmF1bHQsIGFuZCByZWZlcnMgdG8gT1VSIGVuZC5cbiAgICAvLyAgIEhvd2V2ZXIsIGEgc2VydmVyIHRoYXQgY29ubmVjdHMgdG8gYSBidW5jaCBvZiBwZWVycyBtaWdodCBiYXNoIGluIHRoZSB1dWlkIHdpdGggdGhhdCBvZiB0aGUgb3RoZXIgZW5kLCBzbyB0aGF0IGxvZ2dpbmcgaW5kaWNhdGVzIHRoZSBjbGllbnQuXG4gICAgLy8gSWYgY2hhbm5lbE5hbWUgaXMgc3BlY2lmaWVkLCBpdCBzaG91bGQgYmUgaW4gdGhlIGZvcm0gb2YgY29sbGVjdGlvblR5cGUvY29sbGVjdGlvbk5hbWUgKGUuZy4sIGlmIGNvbm5lY3RpbmcgdG8gcmVsYXkpLlxuICAgIGNvbnN0IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgPSBzZXJ2aWNlTmFtZS5zdGFydHNXaXRoPy4oJ2h0dHAnKTtcbiAgICBpZiAoIWNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgKHJ0Y0NvbmZpZ3VyYXRpb24gPT09IHVuZGVmaW5lZCkpIHJ0Y0NvbmZpZ3VyYXRpb24gPSB7fTsgLy8gRXhwaWNpdGx5IG5vIGljZS4gTEFOIG9ubHkuXG4gICAgLy8gbXVsdGlwbGV4IHNob3VsZCBlbmQgdXAgd2l0aCBvbmUgb2YgdGhyZWUgdmFsdWVzOlxuICAgIC8vIGZhbHN5IC0gYSBuZXcgY29ubmVjdGlvbiBzaG91bGQgYmUgdXNlZCBmb3IgZWFjaCBjaGFubmVsXG4gICAgLy8gXCJuZWdvdGlhdGVkXCIgLSBib3RoIHNpZGVzIGNyZWF0ZSB0aGUgc2FtZSBjaGFubmVsTmFtZXMgaW4gdGhlIHNhbWUgb3JkZXIgKG1vc3QgY2FzZXMpOlxuICAgIC8vICAgICBUaGUgaW5pdGlhbCBzaWduYWxsaW5nIHdpbGwgYmUgdHJpZ2dlcmVkIGJ5IG9uZSBzaWRlIGNyZWF0aW5nIGEgY2hhbm5lbCwgYW5kIHRoZXIgc2lkZSB3YWl0aW5nIGZvciBpdCB0byBiZSBjcmVhdGVkLlxuICAgIC8vICAgICBBZnRlciB0aGF0LCBib3RoIHNpZGVzIHdpbGwgZXhwbGljaXRseSBjcmVhdGUgYSBkYXRhIGNoYW5uZWwgYW5kIHdlYnJ0YyB3aWxsIG1hdGNoIHRoZW0gdXAgYnkgaWQuXG4gICAgLy8gYW55IG90aGVyIHRydXRoeSAtIFN0YXJ0cyBsaWtlIG5lZ290aWF0ZWQsIGFuZCB0aGVuIGNvbnRpbnVlcyB3aXRoIG9ubHkgd2lkZSBzaWRlIGNyZWF0aW5nIHRoZSBjaGFubmVscywgYW5kIHRoZXIgb3RoZXJcbiAgICAvLyAgICAgb2JzZXJ2ZXMgdGhlIGNoYW5uZWwgdGhhdCBoYXMgYmVlbiBtYWRlLiBUaGlzIGlzIHVzZWQgZm9yIHJlbGF5cy5cbiAgICBtdWx0aXBsZXggPz89IGNvbm5lY3Rpb24/Lm11bHRpcGxleDsgLy8gU3RpbGwgdHlwaWNhbGx5IHVuZGVmaW5lZCBhdCB0aGlzIHBvaW50LlxuICAgIG11bHRpcGxleCA/Pz0gKHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zeW5jJykgfHwgJ25lZ290aWF0ZWQnKTtcbiAgICBjb25uZWN0aW9uID8/PSBTaGFyZWRXZWJSVEMuZW5zdXJlKHtzZXJ2aWNlTGFiZWwsIGNvbmZpZ3VyYXRpb246IHJ0Y0NvbmZpZ3VyYXRpb24sIG11bHRpcGxleCwgdXVpZCwgZGVidWcsIGVycm9yfSk7XG5cbiAgICB1dWlkID8/PSBjb25uZWN0aW9uLnV1aWQ7XG4gICAgLy8gQm90aCBwZWVycyBtdXN0IGFncmVlIG9uIGNoYW5uZWxOYW1lLiBVc3VhbGx5LCB0aGlzIGlzIGNvbGxlY3Rpb24uZnVsbE5hbWUuIEJ1dCBpbiB0ZXN0aW5nLCB3ZSBtYXkgc3luYyB0d28gY29sbGVjdGlvbnMgd2l0aCBkaWZmZXJlbnQgbmFtZXMuXG4gICAgY2hhbm5lbE5hbWUgPz89IGNvbGxlY3Rpb24/LmNoYW5uZWxOYW1lIHx8IGNvbGxlY3Rpb24uZnVsbE5hbWU7XG4gICAgY29uc3QgbGFiZWwgPSBgJHtjb2xsZWN0aW9uPy5mdWxsTGFiZWwgfHwgY2hhbm5lbE5hbWV9LyR7dXVpZH1gO1xuICAgIC8vIFdoZXJlIHdlIGNhbiByZXF1ZXN0IGEgZGF0YSBjaGFubmVsIHRoYXQgcHVzaGVzIHB1dC9kZWxldGUgcmVxdWVzdHMgZnJvbSBvdGhlcnMuXG4gICAgY29uc3QgY29ubmVjdGlvblVSTCA9IHNlcnZpY2VOYW1lLmluY2x1ZGVzPy4oJy9zaWduYWwvJykgPyBzZXJ2aWNlTmFtZSA6IGAke3NlcnZpY2VOYW1lfS8ke2xhYmVsfWA7XG5cbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzZXJ2aWNlTmFtZSwgbGFiZWwsIGNvbGxlY3Rpb24sIGRlYnVnLCBlcnJvciwgbWluVmVyc2lvbiwgbWF4VmVyc2lvbiwgdXVpZCwgcnRjQ29uZmlndXJhdGlvbixcblx0XHRcdCBjb25uZWN0aW9uLCB1dWlkLCBjaGFubmVsTmFtZSwgY29ubmVjdGlvblVSTCxcblx0XHRcdCBjb25uZWN0aW9uU3RhcnRUaW1lOiBEYXRlLm5vdygpLFxuXHRcdFx0IGNsb3NlZDogdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCksXG5cdFx0XHQgLy8gTm90IHVzZWQgeWV0LCBidXQgY291bGQgYmUgdXNlZCB0byBHRVQgcmVzb3VyY2VzIG92ZXIgaHR0cCBpbnN0ZWFkIG9mIHRocm91Z2ggdGhlIGRhdGEgY2hhbm5lbC5cblx0XHRcdCBob3N0UmVxdWVzdEJhc2U6IGNvbm5lY3RUaHJvdWdoSW50ZXJuZXQgJiYgYCR7c2VydmljZU5hbWUucmVwbGFjZSgvXFwvKHN5bmN8c2lnbmFsKS8pfS8ke2NoYW5uZWxOYW1lfWB9KTtcbiAgICBjb2xsZWN0aW9uPy5zeW5jaHJvbml6ZXJzLnNldChzZXJ2aWNlTmFtZSwgdGhpcyk7IC8vIE11c3QgYmUgc2V0IHN5bmNocm9ub3VzbHksIHNvIHRoYXQgY29sbGVjdGlvbi5zeW5jaHJvbml6ZTEga25vd3MgdG8gd2FpdC5cbiAgfVxuICBzdGF0aWMgYXN5bmMgY3JlYXRlKGNvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCBvcHRpb25zID0ge30pIHsgLy8gUmVjZWl2ZSBwdXNoZWQgbWVzc2FnZXMgZnJvbSB0aGUgZ2l2ZW4gc2VydmljZS4gZ2V0L3B1dC9kZWxldGUgd2hlbiB0aGV5IGNvbWUgKHdpdGggZW1wdHkgc2VydmljZXMgbGlzdCkuXG4gICAgY29uc3Qgc3luY2hyb25pemVyID0gbmV3IHRoaXMoe2NvbGxlY3Rpb24sIHNlcnZpY2VOYW1lLCAuLi5vcHRpb25zfSk7XG4gICAgY29uc3QgY29ubmVjdGVkUHJvbWlzZSA9IHN5bmNocm9uaXplci5jb25uZWN0Q2hhbm5lbCgpOyAvLyBFc3RhYmxpc2ggY2hhbm5lbCBjcmVhdGlvbiBvcmRlci5cbiAgICBjb25zdCBjb25uZWN0ZWQgPSBhd2FpdCBjb25uZWN0ZWRQcm9taXNlO1xuICAgIGlmICghY29ubmVjdGVkKSByZXR1cm4gc3luY2hyb25pemVyO1xuICAgIHJldHVybiBhd2FpdCBjb25uZWN0ZWQuc3luY2hyb25pemUoKTtcbiAgfVxuICBhc3luYyBjb25uZWN0Q2hhbm5lbCgpIHsgLy8gU3luY2hyb25vdXNseSBpbml0aWFsaXplIGFueSBwcm9taXNlcyB0byBjcmVhdGUgYSBkYXRhIGNoYW5uZWwsIGFuZCB0aGVuIGF3YWl0IGNvbm5lY3Rpb24uXG4gICAgY29uc3Qge2hvc3RSZXF1ZXN0QmFzZSwgdXVpZCwgY29ubmVjdGlvbiwgc2VydmljZU5hbWV9ID0gdGhpcztcbiAgICBsZXQgc3RhcnRlZCA9IGNvbm5lY3Rpb24uaGFzU3RhcnRlZENvbm5lY3Rpbmc7XG4gICAgaWYgKHN0YXJ0ZWQpIHtcbiAgICAgIC8vIFdlIGFscmVhZHkgaGF2ZSBhIGNvbm5lY3Rpb24uIEp1c3Qgb3BlbiBhbm90aGVyIGRhdGEgY2hhbm5lbCBmb3Igb3VyIHVzZS5cbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbm5lY3Rpb25VUkwuaW5jbHVkZXMoJy9zeW5jJykpIHsgLy8gQ29ubmVjdCB3aXRoIGEgc2VydmVyIHJlbGF5LiAoU2lnbmFsIGFuZCBzdGF5IGNvbm5lY3RlZCB0aHJvdWdoIHN5bmMuKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdFNlcnZlcigpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25uZWN0aW9uVVJMLmluY2x1ZGVzKCcvc2lnbmFsL2Fuc3dlcicpKSB7IC8vIFNlZWtpbmcgYW4gYW5zd2VyIHRvIGFuIG9mZmVyIHdlIFBPU1QgKHRvIHJlbmRldm91cyB3aXRoIGEgcGVlcikuXG4gICAgICBzdGFydGVkID0gdGhpcy5jb25uZWN0U2VydmVyKCk7IC8vIEp1c3QgbGlrZSBhIHN5bmNcbiAgICB9IGVsc2UgaWYgKHRoaXMuY29ubmVjdGlvblVSTC5pbmNsdWRlcygnL3NpZ25hbC9vZmZlcicpKSB7IC8vIEdFVCBhbiBvZmZlciBmcm9tIGEgcmVuZGV2b3VzIHBlZXIgYW5kIHRoZW4gUE9TVCBhbiBhbnN3ZXIuXG4gICAgICAvLyBXZSBtdXN0IHN5Y2hyb25vdXNseSBzdGFydENvbm5lY3Rpb24gbm93IHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gaGFzU3RhcnRlZENvbm5lY3RpbmcsIGFuZCBhbnkgc3Vic2VxdWVudCBkYXRhIGNoYW5uZWxcbiAgICAgIC8vIHJlcXVlc3RzIG9uIHRoZSBzYW1lIGNvbm5lY3Rpb24gd2lsbCB3YWl0ICh1c2luZyB0aGUgJ3N0YXJ0ZWQnIHBhdGgsIGFib3ZlKS5cbiAgICAgIC8vIENvbXBhcmUgY29ubmVjdFNlcnZlciwgd2hpY2ggaXMgYmFzaWNhbGx5OlxuICAgICAgLy8gICBzdGFydENvbm5lY3Rpb24oKSwgZmV0Y2ggd2l0aCB0aGF0IG9mZmVyLCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCBmZXRjaGVkIGFuc3dlci5cbiAgICAgIGNvbnN0IHByb21pc2VkU2lnbmFscyA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKFtdKTsgLy8gRXN0YWJsaXNoaW5nIG9yZGVyLlxuICAgICAgY29uc3QgdXJsID0gdGhpcy5jb25uZWN0aW9uVVJMO1xuICAgICAgY29uc3Qgb2ZmZXIgPSBhd2FpdCB0aGlzLmZldGNoKHVybCk7XG4gICAgICBjb25zdCBvayA9IHRoaXMuY29tcGxldGVDb25uZWN0aW9uKG9mZmVyKTsgLy8gTm93IHN1cHBseSB0aG9zZSBzaWduYWxzIHNvIHRoYXQgb3VyIGNvbm5lY3Rpb24gY2FuIHByb2R1Y2UgYW5zd2VyIHNpZ2Fscy5cbiAgICAgIGNvbnN0IGFuc3dlciA9IGF3YWl0IHByb21pc2VkU2lnbmFscztcbiAgICAgIHN0YXJ0ZWQgPSB0aGlzLmZldGNoKHVybCwgYW5zd2VyKTsgLy8gUE9TVCBvdXIgYW5zd2VyIHRvIHBlZXIuXG4gICAgfSBlbHNlIGlmIChzZXJ2aWNlTmFtZSA9PT0gJ3NpZ25hbHMnKSB7IC8vIFN0YXJ0IGNvbm5lY3Rpb24gYW5kIHJldHVybiBudWxsLiBNdXN0IGJlIGNvbnRpbnVlZCB3aXRoIGNvbXBsZXRlU2lnbmFsc1N5bmNocm9uaXphdGlvbigpO1xuICAgICAgc3RhcnRlZCA9IHRoaXMuc3RhcnRDb25uZWN0aW9uKCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoc2VydmljZU5hbWUpKSB7IC8vIEEgbGlzdCBvZiBcInJlY2VpdmluZ1wiIHNpZ25hbHMuXG4gICAgICBzdGFydGVkID0gdGhpcy5zdGFydENvbm5lY3Rpb24oc2VydmljZU5hbWUpO1xuICAgIH0gZWxzZSBpZiAoc2VydmljZU5hbWUuc3luY2hyb25pemVycykgeyAvLyBEdWNrIHR5cGluZyBmb3IgcGFzc2luZyBhIGNvbGxlY3Rpb24gZGlyZWN0bHkgYXMgdGhlIHNlcnZpY2VJbmZvLiAoV2UgZG9uJ3QgaW1wb3J0IENvbGxlY3Rpb24uKVxuICAgICAgc3RhcnRlZCA9IHRoaXMuY29ubmVjdERpcmVjdFRlc3Rpbmcoc2VydmljZU5hbWUpOyAvLyBVc2VkIGluIHRlc3RpbmcuXG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5yZWNvZ25pemVkIHNlcnZpY2UgZm9ybWF0OiAke3NlcnZpY2VOYW1lfS5gKTtcbiAgICB9XG4gICAgaWYgKCEoYXdhaXQgc3RhcnRlZCkpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnY29ubmVjdGlvbiBmYWlsZWQnKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKHRoaXMuZGVidWcpIGNvbnNvbGUubG9nKHRoaXMubGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIGdldCBkYXRhQ2hhbm5lbFByb21pc2UoKSB7IC8vIEEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGFuIG9wZW4gZGF0YSBjaGFubmVsLlxuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLl9kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgaWYgKCFwcm9taXNlKSB0aHJvdyBuZXcgRXJyb3IoYCR7dGhpcy5sYWJlbH06IERhdGEgY2hhbm5lbCBpcyBub3QgeWV0IHByb21pc2VkLmApO1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGNoYW5uZWxDbG9zZWRDbGVhbnVwKCkgeyAvLyBCb29ra2VlcGluZyB3aGVuIGNoYW5uZWwgY2xvc2VkIG9yIGV4cGxpY2l0bHkgYWJhbmRvbmVkIGJlZm9yZSBvcGVuaW5nLlxuICAgIHRoaXMuY29sbGVjdGlvbj8uc3luY2hyb25pemVycy5kZWxldGUodGhpcy5zZXJ2aWNlTmFtZSk7XG4gICAgdGhpcy5jbG9zZWQucmVzb2x2ZSh0aGlzKTsgLy8gUmVzb2x2ZSB0byBzeW5jaHJvbml6ZXIgaXMgbmljZSBpZiwgZS5nLCBzb21lb25lIGlzIFByb21pc2UucmFjaW5nLlxuICB9XG4gIHNldCBkYXRhQ2hhbm5lbFByb21pc2UocHJvbWlzZSkgeyAvLyBTZXQgdXAgbWVzc2FnZSBhbmQgY2xvc2UgaGFuZGxpbmcuXG4gICAgdGhpcy5fZGF0YUNoYW5uZWxQcm9taXNlID0gcHJvbWlzZS50aGVuKGRhdGFDaGFubmVsID0+IHtcbiAgICAgIGRhdGFDaGFubmVsLm9ubWVzc2FnZSA9IGV2ZW50ID0+IHRoaXMucmVjZWl2ZShldmVudC5kYXRhKTtcbiAgICAgIGRhdGFDaGFubmVsLm9uY2xvc2UgPSBhc3luYyBldmVudCA9PiB0aGlzLmNoYW5uZWxDbG9zZWRDbGVhbnVwKCk7XG4gICAgICByZXR1cm4gZGF0YUNoYW5uZWw7XG4gICAgfSk7XG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemUoKSB7XG4gICAgYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2U7XG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG4gIHN0YXRpYyBmcmFnbWVudElkID0gMDtcbiAgYXN5bmMgc2VuZChtZXRob2QsIC4uLnBhcmFtcykgeyAvLyBTZW5kcyB0byB0aGUgcGVlciwgb3ZlciB0aGUgZGF0YSBjaGFubmVsXG4gICAgLy8gVE9ETzogYnJlYWsgdXAgbG9uZyBtZXNzYWdlcy4gKEFzIGEgcHJhY3RpY2FsIG1hdHRlciwgMTYgS2lCIGlzIHRoZSBsb25nZXN0IHRoYXQgY2FuIHJlbGlhYmx5IGJlIHNlbnQgYWNyb3NzIGRpZmZlcmVudCB3cnRjIGltcGxlbWVudGF0aW9ucy4pXG4gICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0FQSS9XZWJSVENfQVBJL1VzaW5nX2RhdGFfY2hhbm5lbHMjY29uY2VybnNfd2l0aF9sYXJnZV9tZXNzYWdlc1xuICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnN0cmluZ2lmeSh7bWV0aG9kLCBwYXJhbXN9KTtcbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGNvbnN0IHN0YXRlID0gZGF0YUNoYW5uZWw/LnJlYWR5U3RhdGUgfHwgJ2Nsb3NlZCc7XG4gICAgaWYgKHN0YXRlID09PSAnY2xvc2VkJyB8fCBzdGF0ZSA9PT0gJ2Nsb3NpbmcnKSByZXR1cm47XG4gICAgdGhpcy5sb2coJ3NlbmRzJywgbWV0aG9kLCAuLi5wYXJhbXMpO1xuICAgIGNvbnN0IHNpemUgPSAxNmUzOyAvLyBBIGJpdCBsZXNzIHRoYW4gMTYgKiAxMDI0LlxuICAgIGlmIChwYXlsb2FkLmxlbmd0aCA8IHNpemUpIHtcbiAgICAgIGRhdGFDaGFubmVsLnNlbmQocGF5bG9hZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IG51bUNodW5rcyA9IE1hdGguY2VpbChwYXlsb2FkLmxlbmd0aCAvIHNpemUpO1xuICAgIGNvbnN0IGlkID0gdGhpcy5jb25zdHJ1Y3Rvci5mcmFnbWVudElkKys7XG4gICAgY29uc3QgbWV0YSA9IHttZXRob2Q6ICdmcmFnbWVudHMnLCBwYXJhbXM6IFtpZCwgbnVtQ2h1bmtzXX07XG4gICAgLy9jb25zb2xlLmxvZyhgRnJhZ21lbnRpbmcgbWVzc2FnZSAke2lkfSBpbnRvICR7bnVtQ2h1bmtzfSBjaHVua3MuYCwgbWV0YSk7XG4gICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShtZXRhKSk7XG4gICAgLy8gT3B0aW1pemF0aW9uIG9wcG9ydHVuaXR5OiByZWx5IG9uIG1lc3NhZ2VzIGJlaW5nIG9yZGVyZWQgYW5kIHNraXAgcmVkdW5kYW50IGluZm8uIElzIGl0IHdvcnRoIGl0P1xuICAgIGZvciAobGV0IGkgPSAwLCBvID0gMDsgaSA8IG51bUNodW5rczsgKytpLCBvICs9IHNpemUpIHtcbiAgICAgIGNvbnN0IGZyYWcgPSB7bWV0aG9kOiAnZnJhZycsIHBhcmFtczogW2lkLCBpLCBwYXlsb2FkLnN1YnN0cihvLCBzaXplKV19O1xuICAgICAgZGF0YUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeShmcmFnKSk7XG4gICAgfVxuICB9XG4gIHJlY2VpdmUodGV4dCkgeyAvLyBEaXNwYXRjaCBhIG1lc3NhZ2Ugc2VudCBvdmVyIHRoZSBkYXRhIGNoYW5uZWwgZnJvbSB0aGUgcGVlci5cbiAgICBjb25zdCB7bWV0aG9kLCBwYXJhbXN9ID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgICB0aGlzW21ldGhvZF0oLi4ucGFyYW1zKTtcbiAgfVxuICBwZW5kaW5nRnJhZ21lbnRzID0ge307XG4gIGZyYWdtZW50cyhpZCwgbnVtQ2h1bmtzKSB7XG4gICAgLy9jb25zb2xlLmxvZyhgUmVjZWl2aW5nIG1lc2FnZSAke2lkfSBpbiAke251bUNodW5rc30uYCk7XG4gICAgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXSA9IHtyZW1haW5pbmc6IG51bUNodW5rcywgbWVzc2FnZTogQXJyYXkobnVtQ2h1bmtzKX07XG4gIH1cbiAgZnJhZyhpZCwgaSwgZnJhZ21lbnQpIHtcbiAgICBsZXQgZnJhZyA9IHRoaXMucGVuZGluZ0ZyYWdtZW50c1tpZF07IC8vIFdlIGFyZSByZWx5aW5nIG9uIGZyYWdtZW50IG1lc3NhZ2UgY29taW5nIGZpcnN0LlxuICAgIGZyYWcubWVzc2FnZVtpXSA9IGZyYWdtZW50O1xuICAgIGlmICgwICE9PSAtLWZyYWcucmVtYWluaW5nKSByZXR1cm47XG4gICAgLy9jb25zb2xlLmxvZyhgRGlzcGF0Y2hpbmcgbWVzc2FnZSAke2lkfS5gKTtcbiAgICB0aGlzLnJlY2VpdmUoZnJhZy5tZXNzYWdlLmpvaW4oJycpKTtcbiAgICBkZWxldGUgdGhpcy5wZW5kaW5nRnJhZ21lbnRzW2lkXTtcbiAgfVxuXG4gIGFzeW5jIGRpc2Nvbm5lY3QoKSB7IC8vIFdhaXQgZm9yIGRhdGFDaGFubmVsIHRvIGRyYWluIGFuZCByZXR1cm4gYSBwcm9taXNlIHRvIHJlc29sdmUgd2hlbiBhY3R1YWxseSBjbG9zZWQsXG4gICAgLy8gYnV0IHJldHVybiBpbW1lZGlhdGVseSBpZiBjb25uZWN0aW9uIG5vdCBzdGFydGVkLlxuICAgIGlmICh0aGlzLmNvbm5lY3Rpb24ucGVlci5jb25uZWN0aW9uU3RhdGUgIT09ICdjb25uZWN0ZWQnKSByZXR1cm4gdGhpcy5jaGFubmVsQ2xvc2VkQ2xlYW51cCh0aGlzLmNvbm5lY3Rpb24uY2xvc2UoKSk7XG4gICAgY29uc3QgZGF0YUNoYW5uZWwgPSBhd2FpdCB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZTtcbiAgICBkYXRhQ2hhbm5lbC5jbG9zZSgpO1xuICAgIHJldHVybiB0aGlzLmNsb3NlZDtcbiAgfVxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGR1cmluZyBzeW5jLlxuICAvLyBUT0RPOiB3ZWJydGMgbmVnb3RpYXRpb24gbmVlZGVkIGFmdGVyIHN5bmMuXG4gIHN0YXJ0Q29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBNYWNoaW5lcnkgZm9yIG1ha2luZyBhIFdlYlJUQyBjb25uZWN0aW9uIHRvIHRoZSBwZWVyOlxuICAgIC8vICAgSWYgc2lnbmFsTWVzc2FnZXMgaXMgYSBsaXN0IG9mIFtvcGVyYXRpb24sIG1lc3NhZ2VdIG1lc3NhZ2Ugb2JqZWN0cywgdGhlbiB0aGUgb3RoZXIgc2lkZSBpcyBpbml0aWF0aW5nXG4gICAgLy8gdGhlIGNvbm5lY3Rpb24gYW5kIGhhcyBzZW50IGFuIGluaXRpYWwgb2ZmZXIvaWNlLiBJbiB0aGlzIGNhc2UsIHN0YXJ0Q29ubmVjdCgpIHByb21pc2VzIGEgcmVzcG9uc2VcbiAgICAvLyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUuXG4gICAgLy8gICBPdGhlcndpc2UsIHN0YXJ0Q29ubmVjdCgpIHByb21pc2VzIGEgbGlzdCBvZiBpbml0aWFsIHNpZ25hbCBtZXNzYWdlcyB0byBiZSBkZWxpdmVyZWQgdG8gdGhlIG90aGVyIHNpZGUsXG4gICAgLy8gYW5kIGl0IGlzIG5lY2Vzc2FyeSB0byB0aGVuIGNhbGwgY29tcGxldGVDb25uZWN0aW9uKCkgd2l0aCB0aGUgcmVzcG9uc2UgZnJvbSB0aGVtLlxuICAgIC8vIEluIGJvdGggY2FzZXMsIGFzIGEgc2lkZSBlZmZlY3QsIHRoZSBkYXRhQ2hhbm5lbFByb21pc2UgcHJvcGVydHkgd2lsbCBiZSBzZXQgdG8gYSBQcm9taXNlXG4gICAgLy8gdGhhdCByZXNvbHZlcyB0byB0aGUgZGF0YSBjaGFubmVsIHdoZW4gaXQgaXMgb3BlbnMuIFRoaXMgcHJvbWlzZSBpcyB1c2VkIGJ5IHNlbmQoKSBhbmQgcmVjZWl2ZSgpLlxuICAgIGNvbnN0IHtjb25uZWN0aW9ufSA9IHRoaXM7XG4gICAgdGhpcy5sb2coc2lnbmFsTWVzc2FnZXMgPyAnZ2VuZXJhdGluZyBhbnN3ZXInIDogJ2dlbmVyYXRpbmcgb2ZmZXInKTtcbiAgICB0aGlzLmRhdGFDaGFubmVsUHJvbWlzZSA9IGNvbm5lY3Rpb24uZW5zdXJlRGF0YUNoYW5uZWwodGhpcy5jaGFubmVsTmFtZSwge30sIHNpZ25hbE1lc3NhZ2VzKTtcbiAgICByZXR1cm4gY29ubmVjdGlvbi5zaWduYWxzO1xuICB9XG4gIGNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxNZXNzYWdlcykgeyAvLyBGaW5pc2ggd2hhdCB3YXMgc3RhcnRlZCB3aXRoIHN0YXJ0Q29sbGVjdGlvbi5cbiAgICAvLyBEb2VzIG5vdCByZXR1cm4gYSBwcm9taXNlLiBDbGllbnQgY2FuIGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlIHRvIHNlZSB3aGVuIHdlIGFyZSBhY3R1YWxseSBjb25uZWN0ZWQuXG4gICAgaWYgKCFzaWduYWxNZXNzYWdlcykgcmV0dXJuIGZhbHNlO1xuICAgIHRoaXMuY29ubmVjdGlvbi5zaWduYWxzID0gc2lnbmFsTWVzc2FnZXM7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBzdGF0aWMgZmV0Y2hKU09OKHVybCwgYm9keSA9IHVuZGVmaW5lZCwgbWV0aG9kID0gbnVsbCkge1xuICAgIGNvbnN0IGhhc0JvZHkgPSBib2R5ICE9PSB1bmRlZmluZWQ7XG4gICAgbWV0aG9kID8/PSBoYXNCb2R5ID8gJ1BPU1QnIDogJ0dFVCc7XG4gICAgcmV0dXJuIGZldGNoKHVybCwgaGFzQm9keSA/IHttZXRob2QsIGhlYWRlcnM6IHtcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIn0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpfSA6IHttZXRob2R9KVxuICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuXHRpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoYCR7cmVzcG9uc2Uuc3RhdHVzVGV4dCB8fCAnRmV0Y2ggZmFpbGVkJ30sIGNvZGUgJHtyZXNwb25zZS5zdGF0dXN9IGluICR7dXJsfS5gKTtcblx0cmV0dXJuIHJlc3BvbnNlLmpzb24oKTtcbiAgICAgIH0pO1xuICB9XG4gIGFzeW5jIGZldGNoKHVybCwgYm9keSA9IHVuZGVmaW5lZCkgeyAvLyBBcyBKU09OXG5cbiAgICBjb25zdCBtZXRob2QgPSBib2R5ID8gJ1BPU1QnIDogJ0dFVCc7XG4gICAgdGhpcy5sb2coJ2ZldGNoJywgbWV0aG9kLCB1cmwsICdzZW5kaW5nOicsIGJvZHkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZmV0Y2hKU09OKHVybCwgYm9keSwgbWV0aG9kKVxuXHQgIC5jYXRjaChlcnJvciA9PiB7XG5cdCAgICB0aGlzLmNsb3NlZC5yZWplY3QoZXJyb3IpO1xuXHQgIH0pO1xuICAgIHRoaXMubG9nKCdmZXRjaCcsIG1ldGhvZCwgdXJsLCAncmVzdWx0OicsIHJlc3VsdCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICBhc3luYyBjb25uZWN0U2VydmVyKHVybCA9IHRoaXMuY29ubmVjdGlvblVSTCkgeyAvLyBDb25uZWN0IHRvIGEgcmVsYXkgb3ZlciBodHRwLiAoL3N5bmMgb3IgL3NpZ25hbC9hbnN3ZXIpXG4gICAgLy8gc3RhcnRDb25uZWN0aW9uLCBQT1NUIG91ciBzaWduYWxzLCBjb21wbGV0ZUNvbm5lY3Rpb24gd2l0aCB0aGUgcmVzcG9uc2UuXG4gICAgLy8gT3VyIHdlYnJ0YyBzeW5jaHJvbml6ZXIgaXMgdGhlbiBjb25uZWN0ZWQgdG8gdGhlIHJlbGF5J3Mgd2VicnQgc3luY2hyb25pemVyLlxuICAgIGNvbnN0IG91clNpZ25hbHNQcm9taXNlID0gdGhpcy5zdGFydENvbm5lY3Rpb24oKTsgLy8gbXVzdCBiZSBzeW5jaHJvbm91cyB0byBwcmVzZXJ2ZSBjaGFubmVsIGlkIG9yZGVyLlxuICAgIGNvbnN0IG91clNpZ25hbHMgPSBhd2FpdCBvdXJTaWduYWxzUHJvbWlzZTtcbiAgICBjb25zdCB0aGVpclNpZ25hbHMgPSBhd2FpdCB0aGlzLmZldGNoKHVybCwgb3VyU2lnbmFscyk7IC8vIFBPU1RcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuICBhc3luYyBjb21wbGV0ZVNpZ25hbHNTeW5jaHJvbml6YXRpb24oc2lnbmFscykgeyAvLyBHaXZlbiBhbnN3ZXIvaWNlIHNpZ25hbHMsIGNvbXBsZXRlIHRoZSBjb25uZWN0aW9uIGFuZCBzdGFydCBzeW5jaHJvbml6ZS5cbiAgICBhd2FpdCB0aGlzLmNvbXBsZXRlQ29ubmVjdGlvbihzaWduYWxzKTtcbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplKCk7XG4gIH1cbiAgYXN5bmMgY29ubmVjdERpcmVjdFRlc3RpbmcocGVlckNvbGxlY3Rpb24pIHsgLy8gVXNlZCBpbiB1bml0IHRlc3RpbmcsIHdoZXJlIHRoZSBcInJlbW90ZVwiIHNlcnZpY2UgaXMgc3BlY2lmaWVkIGRpcmVjdGx5IChub3QgYSBzdHJpbmcpLlxuICAgIC8vIEVhY2ggY29sbGVjdGlvbiBpcyBhc2tlZCB0byBzeWNocm9uaXplIHRvIGFub3RoZXIgY29sbGVjdGlvbi5cbiAgICBjb25zdCBwZWVyU3luY2hyb25pemVyID0gcGVlckNvbGxlY3Rpb24uc3luY2hyb25pemVycy5nZXQodGhpcy5jb2xsZWN0aW9uKTtcbiAgICBpZiAoIXBlZXJTeW5jaHJvbml6ZXIpIHsgLy8gVGhlIG90aGVyIHNpZGUgZG9lc24ndCBrbm93IGFib3V0IHVzIHlldC4gVGhlIG90aGVyIHNpZGUgd2lsbCBkbyB0aGUgd29yay5cbiAgICAgIHRoaXMuX2RlbGF5ID0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IG91clNpZ25hbHMgPSB0aGlzLnN0YXJ0Q29ubmVjdGlvbigpO1xuICAgIGNvbnN0IHRoZWlyU2lnbmFscyA9IGF3YWl0IHBlZXJTeW5jaHJvbml6ZXIuc3RhcnRDb25uZWN0aW9uKGF3YWl0IG91clNpZ25hbHMpO1xuICAgIHBlZXJTeW5jaHJvbml6ZXIuX2RlbGF5LnJlc29sdmUoKTtcbiAgICByZXR1cm4gdGhpcy5jb21wbGV0ZUNvbm5lY3Rpb24odGhlaXJTaWduYWxzKTtcbiAgfVxuXG4gIC8vIEEgY29tbW9uIHByYWN0aWNlIGhlcmUgaXMgdG8gaGF2ZSBhIHByb3BlcnR5IHRoYXQgaXMgYSBwcm9taXNlIGZvciBoYXZpbmcgc29tZXRoaW5nIGRvbmUuXG4gIC8vIEFzeW5jaHJvbm91cyBtYWNoaW5lcnkgY2FuIHRoZW4gcmVzb2x2ZSBpdC5cbiAgLy8gQW55dGhpbmcgdGhhdCBkZXBlbmRzIG9uIHRoYXQgY2FuIGF3YWl0IHRoZSByZXNvbHZlZCB2YWx1ZSwgd2l0aG91dCB3b3JyeWluZyBhYm91dCBob3cgaXQgZ2V0cyByZXNvbHZlZC5cbiAgLy8gV2UgY2FjaGUgdGhlIHByb21pc2Ugc28gdGhhdCB3ZSBkbyBub3QgcmVwZXRlZGx5IHRyaWdnZXIgdGhlIHVuZGVybHlpbmcgYWN0aW9uLlxuICBtYWtlUmVzb2x2ZWFibGVQcm9taXNlKGlnbm9yZWQpIHsgLy8gQW5zd2VyIGEgUHJvbWlzZSB0aGF0IGNhbiBiZSByZXNvbHZlIHdpdGggdGhlUHJvbWlzZS5yZXNvbHZlKHZhbHVlKS5cbiAgICAvLyBUaGUgaWdub3JlZCBhcmd1bWVudCBpcyBhIGNvbnZlbmllbnQgcGxhY2UgdG8gY2FsbCBzb21ldGhpbmcgZm9yIHNpZGUtZWZmZWN0LlxuICAgIGxldCByZXNvbHZlciwgcmVqZWN0ZXI7XG4gICAgY29uc3QgcHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsgcmVzb2x2ZXIgPSByZXNvbHZlOyByZWplY3RlciA9IHJlamVjdDsgfSk7XG4gICAgcHJvbWlzZS5yZXNvbHZlID0gcmVzb2x2ZXI7XG4gICAgcHJvbWlzZS5yZWplY3QgPSByZWplY3RlcjtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIHZlcnNpb25zKG1pbiwgbWF4KSB7IC8vIE9uIHJlY2VpdmluZyB0aGUgdmVyc2lvbnMgc3VwcG9ydGVkIGJ5IHRoZSB0aGUgcGVlciwgcmVzb2x2ZSB0aGUgdmVyc2lvbiBwcm9taXNlLlxuICAgIGxldCB2ZXJzaW9uUHJvbWlzZSA9IHRoaXMudmVyc2lvbjtcbiAgICBjb25zdCBjb21iaW5lZE1heCA9IE1hdGgubWluKG1heCwgdGhpcy5tYXhWZXJzaW9uKTtcbiAgICBjb25zdCBjb21iaW5lZE1pbiA9IE1hdGgubWF4KG1pbiwgdGhpcy5taW5WZXJzaW9uKTtcbiAgICBpZiAoY29tYmluZWRNYXggPj0gY29tYmluZWRNaW4pIHJldHVybiB2ZXJzaW9uUHJvbWlzZS5yZXNvbHZlKGNvbWJpbmVkTWF4KTsgLy8gTm8gbmVlZCB0byByZXNwb25kLCBhcyB0aGV5IHdpbGwgcHJvZHVjZSB0aGUgc2FtZSBkZXRlcm1pbmlzdGljIGFuc3dlci5cbiAgICByZXR1cm4gdmVyc2lvblByb21pc2UucmVzb2x2ZSgwKTtcbiAgfVxuICBnZXQgdmVyc2lvbigpIHsgLy8gUHJvbWlzZSB0aGUgaGlnaGVzdCB2ZXJzaW9uIHN1cG9ydGVkIGJ5IGJvdGggc2lkZXMsIG9yIGRpc2Nvbm5lY3QgYW5kIGZhbHN5IGlmIG5vbmUuXG4gICAgLy8gVGVsbHMgdGhlIG90aGVyIHNpZGUgb3VyIHZlcnNpb25zIGlmIHdlIGhhdmVuJ3QgeWV0IGRvbmUgc28uXG4gICAgLy8gRklYTUU6IGNhbiB3ZSBhdm9pZCB0aGlzIHRpbWVvdXQ/XG4gICAgcmV0dXJuIHRoaXMuX3ZlcnNpb24gfHw9IHRoaXMubWFrZVJlc29sdmVhYmxlUHJvbWlzZShzZXRUaW1lb3V0KCgpID0+IHRoaXMuc2VuZCgndmVyc2lvbnMnLCB0aGlzLm1pblZlcnNpb24sIHRoaXMubWF4VmVyc2lvbiksIDIwMCkpO1xuICB9XG5cbiAgZ2V0IHN0YXJ0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHdlIGhhdmUgc3RhcnRlZCBzeW5jaHJvbml6YXRpb24uXG4gICAgcmV0dXJuIHRoaXMuX3N0YXJ0ZWRTeW5jaHJvbml6YXRpb24gfHw9IHRoaXMuc3RhcnRTeW5jaHJvbml6YXRpb24oKTtcbiAgfVxuICBnZXQgY29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG51bWJlciBvZiBpdGVtcyB0aGF0IHdlcmUgdHJhbnNmZXJyZWQgKG5vdCBuZWNlc3NhcmlsbHkgd3JpdHRlbikuXG4gICAgLy8gU3RhcnRzIHN5bmNocm9uaXphdGlvbiBpZiBpdCBoYXNuJ3QgYWxyZWFkeS4gRS5nLiwgd2FpdGluZyBvbiBjb21wbGV0ZWRTeW5jaHJvbml6YXRpb24gd29uJ3QgcmVzb2x2ZSB1bnRpbCBhZnRlciBpdCBzdGFydHMuXG4gICAgcmV0dXJuIHRoaXMuX2NvbXBsZXRlZFN5bmNocm9uaXphdGlvbiB8fD0gdGhpcy5tYWtlUmVzb2x2ZWFibGVQcm9taXNlKHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbik7XG4gIH1cbiAgZ2V0IHBlZXJDb21wbGV0ZWRTeW5jaHJvbml6YXRpb24oKSB7IC8vIFByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbnVtYmVyIG9mIGl0ZW1zIHRoYXQgdGhlIHBlZXIgc3luY2hyb25pemVkLlxuICAgIHJldHVybiB0aGlzLl9wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uIHx8PSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UoKTtcbiAgfVxuICBnZXQgYm90aFNpZGVzQ29tcGxldGVkU3luY2hyb25pemF0aW9uKCkgeyAvLyBQcm9taXNlIHJlc29sdmVzIHRydXRoeSB3aGVuIGJvdGggc2lkZXMgYXJlIGRvbmUuXG4gICAgcmV0dXJuIHRoaXMuY29tcGxldGVkU3luY2hyb25pemF0aW9uLnRoZW4oKCkgPT4gdGhpcy5wZWVyQ29tcGxldGVkU3luY2hyb25pemF0aW9uKTtcbiAgfVxuICBhc3luYyByZXBvcnRDb25uZWN0aW9uKCkgeyAvLyBMb2cgY29ubmVjdGlvbiB0aW1lIGFuZCB0eXBlLlxuICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgdGhpcy5jb25uZWN0aW9uLnBlZXIuZ2V0U3RhdHMoKTtcbiAgICBsZXQgdHJhbnNwb3J0O1xuICAgIGZvciAoY29uc3QgcmVwb3J0IG9mIHN0YXRzLnZhbHVlcygpKSB7XG4gICAgICBpZiAocmVwb3J0LnR5cGUgPT09ICd0cmFuc3BvcnQnKSB7XG5cdHRyYW5zcG9ydCA9IHJlcG9ydDtcblx0YnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGxldCBjYW5kaWRhdGVQYWlyID0gdHJhbnNwb3J0ICYmIHN0YXRzLmdldCh0cmFuc3BvcnQuc2VsZWN0ZWRDYW5kaWRhdGVQYWlySWQpO1xuICAgIGlmICghY2FuZGlkYXRlUGFpcikgeyAvLyBTYWZhcmkgZG9lc24ndCBmb2xsb3cgdGhlIHN0YW5kYXJkLlxuICAgICAgZm9yIChjb25zdCByZXBvcnQgb2Ygc3RhdHMudmFsdWVzKCkpIHtcblx0aWYgKChyZXBvcnQudHlwZSA9PT0gJ2NhbmRpZGF0ZS1wYWlyJykgJiYgcmVwb3J0LnNlbGVjdGVkKSB7XG5cdCAgY2FuZGlkYXRlUGFpciA9IHJlcG9ydDtcblx0ICBicmVhaztcblx0fVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIWNhbmRpZGF0ZVBhaXIpIHtcbiAgICAgIGNvbnNvbGUud2Fybih0aGlzLmxhYmVsLCAnZ290IHN0YXRzIHdpdGhvdXQgY2FuZGlkYXRlUGFpcicsIEFycmF5LmZyb20oc3RhdHMudmFsdWVzKCkpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVtb3RlID0gc3RhdHMuZ2V0KGNhbmRpZGF0ZVBhaXIucmVtb3RlQ2FuZGlkYXRlSWQpO1xuICAgIGNvbnN0IHtwcm90b2NvbCwgY2FuZGlkYXRlVHlwZX0gPSByZW1vdGU7XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtzdGF0cywgdHJhbnNwb3J0LCBjYW5kaWRhdGVQYWlyLCByZW1vdGUsIHByb3RvY29sLCBjYW5kaWRhdGVUeXBlLCBzeW5jaHJvbml6YXRpb25TdGFydFRpbWU6IG5vd30pO1xuICAgIGNvbnNvbGUuaW5mbyh0aGlzLmxhYmVsLCAnY29ubmVjdGVkJywgcHJvdG9jb2wsIGNhbmRpZGF0ZVR5cGUsICgobm93IC0gdGhpcy5jb25uZWN0aW9uU3RhcnRUaW1lKS8xZTMpLnRvRml4ZWQoMSkpO1xuICB9XG4gIGFzeW5jIHN0YXJ0U3luY2hyb25pemF0aW9uKCkgeyAvLyBXYWl0IGZvciBhbGwgcHJlbGltaW5hcmllcywgYW5kIHN0YXJ0IHN0cmVhbWluZyBvdXIgdGFncy5cbiAgICBjb25zdCBkYXRhQ2hhbm5lbCA9IGF3YWl0IHRoaXMuZGF0YUNoYW5uZWxQcm9taXNlO1xuICAgIGlmICghZGF0YUNoYW5uZWwpIHRocm93IG5ldyBFcnJvcihgTm8gY29ubmVjdGlvbiBmb3IgJHt0aGlzLmxhYmVsfS5gKTtcbiAgICAvLyBOb3cgdGhhdCB3ZSBhcmUgY29ubmVjdGVkLCBhbnkgbmV3IHdyaXRlcyBvbiBvdXIgZW5kIHdpbGwgYmUgcHVzaGVkIHRvIHRoZSBwZWVyLiBTbyBjYXB0dXJlIHRoZSBpbml0aWFsIHRhZ3Mgbm93LlxuICAgIGNvbnN0IG91clRhZ3MgPSBuZXcgU2V0KGF3YWl0IHRoaXMuY29sbGVjdGlvbi50YWdzKTtcbiAgICBhd2FpdCB0aGlzLnJlcG9ydENvbm5lY3Rpb24oKTtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMsIHtcblxuICAgICAgLy8gQSBzbmFwc2hvdCBTZXQgb2YgZWFjaCB0YWcgd2UgaGF2ZSBsb2NhbGx5LCBjYXB0dXJlZCBhdCB0aGUgbW9tZW50IG9mIGNyZWF0aW9uLlxuICAgICAgb3VyVGFncywgLy8gKE5ldyBsb2NhbCB3cml0ZXMgYXJlIHB1c2hlZCB0byB0aGUgY29ubmVjdGVkIHBlZXIsIGV2ZW4gZHVyaW5nIHN5bmNocm9uaXphdGlvbi4pXG5cbiAgICAgIC8vIE1hcCBvZiB0YWcgdG8gcHJvbWlzZSBmb3IgdGFncyB0aGF0IGFyZSBiZWluZyBzeW5jaHJvbml6ZWQuXG4gICAgICAvLyBlbnN1cmVTeW5jaHJvbml6ZWRUYWcgZW5zdXJlcyB0aGF0IHRoZXJlIGlzIGFuIGVudHJ5IGhlcmUgZHVyaW5nIHRoZSB0aW1lIGEgdGFnIGlzIGluIGZsaWdodC5cbiAgICAgIHVuc3luY2hyb25pemVkOiBuZXcgTWFwKCksXG5cbiAgICAgIC8vIFNldCBvZiB3aGF0IHRhZ3MgaGF2ZSBiZWVuIGV4cGxpY2l0bHkgc3luY2hyb25pemVkLCBtZWFuaW5nIHRoYXQgdGhlcmUgaXMgYSBkaWZmZXJlbmNlIGJldHdlZW4gdGhlaXIgaGFzaFxuICAgICAgLy8gYW5kIG91cnMsIHN1Y2ggdGhhdCB3ZSBhc2sgZm9yIHRoZWlyIHNpZ25hdHVyZSB0byBjb21wYXJlIGluIGRldGFpbC4gVGh1cyB0aGlzIHNldCBtYXkgaW5jbHVkZSBpdGVtcyB0aGF0XG4gICAgICBjaGVja2VkVGFnczogbmV3IFNldCgpLCAvLyB3aWxsIG5vdCBlbmQgdXAgYmVpbmcgcmVwbGFjZWQgb24gb3VyIGVuZC5cblxuICAgICAgZW5kT2ZQZWVyVGFnczogZmFsc2UgLy8gSXMgdGhlIHBlZXIgZmluaXNoZWQgc3RyZWFtaW5nP1xuICAgIH0pO1xuICAgIC8vIE5vdyBuZWdvdGlhdGUgdmVyc2lvbiBhbmQgY29sbGVjdHMgdGhlIHRhZ3MuXG4gICAgY29uc3QgdmVyc2lvbiA9IGF3YWl0IHRoaXMudmVyc2lvbjtcbiAgICBpZiAoIXZlcnNpb24pIHsgIC8vIE1pc21hdGNoLlxuICAgICAgLy8gS2x1ZGdlIDE6IHdoeSBkb2Vzbid0IHRoaXMuZGlzY29ubmVjdCgpIGNsZWFuIHVwIHRoZSB2YXJpb3VzIHByb21pc2VzIHByb3Blcmx5P1xuICAgICAgYXdhaXQgdGhpcy5kYXRhQ2hhbm5lbFByb21pc2UudGhlbihjaGFubmVsID0+IGNoYW5uZWwuY2xvc2UoKSk7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYCR7dGhpcy5zZXJ2aWNlTmFtZX0gZG9lcyBub3QgdXNlIGEgY29tcGF0aWJsZSB2ZXJzaW9uLmA7XG4gICAgICBjb25zb2xlLmVycm9yKG1lc3NhZ2UsIHRoaXMuY29ubmVjdGlvbi5ub3RpZmllZCk7XG4gICAgICBpZiAoKHR5cGVvZih3aW5kb3cpICE9PSAndW5kZWZpbmVkJykgJiYgIXRoaXMuY29ubmVjdGlvbi5ub3RpZmllZCkgeyAvLyBJZiB3ZSdyZSBpbiBhIGJyb3dzZXIsIHRlbGwgdGhlIHVzZXIgb25jZS5cblx0dGhpcy5jb25uZWN0aW9uLm5vdGlmaWVkID0gdHJ1ZTtcblx0d2luZG93LmFsZXJ0KG1lc3NhZ2UpO1xuXHRzZXRUaW1lb3V0KCgpID0+IGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb24ubm90aWZpZWQsIDEwKTsgLy8gS2x1ZGdlIDIuXG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuc3RyZWFtVGFncyhvdXJUYWdzKTsgLy8gQnV0IGRvIG5vdCB3YWl0IGZvciBpdC5cbiAgfVxuICBhc3luYyBjb21wdXRlSGFzaCh0ZXh0KSB7IC8vIE91ciBzdGFuZGFyZCBoYXNoLiAoU3RyaW5nIHNvIHRoYXQgaXQgaXMgc2VyaWFsaXphYmxlLilcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgQ3JlZGVudGlhbHMuaGFzaFRleHQodGV4dCk7XG4gICAgcmV0dXJuIENyZWRlbnRpYWxzLmVuY29kZUJhc2U2NHVybChoYXNoKTtcbiAgfVxuICBhc3luYyBnZXRIYXNoKHRhZykgeyAvLyBXaG9sZSBzaWduYXR1cmUgKE5PVCBwcm90ZWN0ZWRIZWFkZXIuc3ViIG9mIGNvbnRlbnQpLlxuICAgIGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMuY29sbGVjdGlvbi5nZXQodGFnKTtcbiAgICByZXR1cm4gdGhpcy5jb21wdXRlSGFzaChyYXcgfHwgJ21pc3NpbmcnKTtcbiAgfVxuICBhc3luYyBzdHJlYW1UYWdzKHRhZ3MpIHsgLy8gU2VuZCBlYWNoIG9mIG91ciBrbm93biB0YWcvaGFzaCBwYWlycyB0byBwZWVyLCBvbmUgYXQgYSB0aW1lLCBmb2xsb3dlZCBieSBlbmRPZlRhZ3MuXG4gICAgZm9yIChjb25zdCB0YWcgb2YgdGFncykge1xuICAgICAgdGhpcy5zZW5kKCdoYXNoJywgdGFnLCBhd2FpdCB0aGlzLmdldEhhc2godGFnKSk7XG4gICAgfVxuICAgIHRoaXMuc2VuZCgnZW5kVGFncycpO1xuICB9XG4gIGFzeW5jIGVuZFRhZ3MoKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBzdHJlYW1UYWdzKCkuXG4gICAgYXdhaXQgdGhpcy5zdGFydGVkU3luY2hyb25pemF0aW9uO1xuICAgIHRoaXMuZW5kT2ZQZWVyVGFncyA9IHRydWU7XG4gICAgdGhpcy5jbGVhblVwSWZGaW5pc2hlZCgpO1xuICB9XG4gIHN5bmNocm9uaXphdGlvbkNvbXBsZXRlKG5DaGVja2VkKSB7IC8vIFRoZSBwZWVyIGhhcyBmaW5pc2hlZCBnZXR0aW5nIGFsbCB0aGUgZGF0YSBpdCBuZWVkcyBmcm9tIHVzLlxuICAgIHRoaXMucGVlckNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBjbGVhblVwSWZGaW5pc2hlZCgpIHsgLy8gSWYgd2UgYXJlIG5vdCB3YWl0aW5nIGZvciBhbnl0aGluZywgd2UncmUgZG9uZS4gQ2xlYW4gdXAuXG4gICAgLy8gVGhpcyByZXF1aXJlcyB0aGF0IHRoZSBwZWVyIGhhcyBpbmRpY2F0ZWQgdGhhdCBpdCBpcyBmaW5pc2hlZCBzdHJlYW1pbmcgdGFncyxcbiAgICAvLyBhbmQgdGhhdCB3ZSBhcmUgbm90IHdhaXRpbmcgZm9yIGFueSBmdXJ0aGVyIHVuc3luY2hyb25pemVkIGl0ZW1zLlxuICAgIGlmICghdGhpcy5lbmRPZlBlZXJUYWdzIHx8IHRoaXMudW5zeW5jaHJvbml6ZWQuc2l6ZSkgcmV0dXJuO1xuICAgIGNvbnN0IG5DaGVja2VkID0gdGhpcy5jaGVja2VkVGFncy5zaXplOyAvLyBUaGUgbnVtYmVyIHRoYXQgd2UgY2hlY2tlZC5cbiAgICB0aGlzLnNlbmQoJ3N5bmNocm9uaXphdGlvbkNvbXBsZXRlJywgbkNoZWNrZWQpO1xuICAgIHRoaXMuY2hlY2tlZFRhZ3MuY2xlYXIoKTtcbiAgICB0aGlzLnVuc3luY2hyb25pemVkLmNsZWFyKCk7XG4gICAgdGhpcy5vdXJUYWdzID0gdGhpcy5zeW5jaHJvbml6ZWQgPSB0aGlzLnVuc3luY2hyb25pemVkID0gbnVsbDtcbiAgICBjb25zb2xlLmluZm8odGhpcy5sYWJlbCwgJ2NvbXBsZXRlZCBzeW5jaHJvbml6YXRpb24nLCBuQ2hlY2tlZCwgJ2l0ZW1zIGluJywgKChEYXRlLm5vdygpIC0gdGhpcy5zeW5jaHJvbml6YXRpb25TdGFydFRpbWUpLzFlMykudG9GaXhlZCgxKSwgJ3NlY29uZHMnKTtcbiAgICB0aGlzLmNvbXBsZXRlZFN5bmNocm9uaXphdGlvbi5yZXNvbHZlKG5DaGVja2VkKTtcbiAgfVxuICBzeW5jaHJvbml6YXRpb25Qcm9taXNlKHRhZykgeyAvLyBSZXR1cm4gc29tZXRoaW5nIHRvIGF3YWl0IHRoYXQgcmVzb2x2ZXMgd2hlbiB0YWcgaXMgc3luY2hyb25pemVkLlxuICAgIC8vIFdoZW5ldmVyIGEgY29sbGVjdGlvbiBuZWVkcyB0byByZXRyaWV2ZSAoZ2V0VmVyaWZpZWQpIGEgdGFnIG9yIGZpbmQgdGFncyBtYXRjaGluZyBwcm9wZXJ0aWVzLCBpdCBlbnN1cmVzXG4gICAgLy8gdGhlIGxhdGVzdCBkYXRhIGJ5IGNhbGxpbmcgdGhpcyBhbmQgYXdhaXRpbmcgdGhlIGRhdGEuXG4gICAgaWYgKCF0aGlzLnVuc3luY2hyb25pemVkKSByZXR1cm4gdHJ1ZTsgLy8gV2UgYXJlIGZ1bGx5IHN5bmNocm9uaXplZCBhbGwgdGFncy4gSWYgdGhlcmUgaXMgbmV3IGRhdGEsIGl0IHdpbGwgYmUgc3BvbnRhbmVvdXNseSBwdXNoZWQgdG8gdXMuXG4gICAgaWYgKHRoaXMuY2hlY2tlZFRhZ3MuaGFzKHRhZykpIHJldHVybiB0cnVlOyAvLyBUaGlzIHBhcnRpY3VsYXIgdGFnIGhhcyBiZWVuIGNoZWNrZWQuXG4gICAgICAvLyAoSWYgY2hlY2tlZFRhZ3Mgd2FzIG9ubHkgdGhvc2UgZXhjaGFuZ2VkIG9yIHdyaXR0ZW4sIHdlIHdvdWxkIGhhdmUgZXh0cmEgZmxpZ2h0cyBjaGVja2luZy4pXG4gICAgLy8gSWYgYSByZXF1ZXN0IGlzIGluIGZsaWdodCwgcmV0dXJuIHRoYXQgcHJvbWlzZS4gT3RoZXJ3aXNlIGNyZWF0ZSBvbmUuXG4gICAgcmV0dXJuIHRoaXMudW5zeW5jaHJvbml6ZWQuZ2V0KHRhZykgfHwgdGhpcy5lbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCAnJywgdGhpcy5nZXRIYXNoKHRhZykpO1xuICB9XG5cbiAgYXN5bmMgaGFzaCh0YWcsIGhhc2gpIHsgLy8gUmVjZWl2ZSBhIFt0YWcsIGhhc2hdIHRoYXQgdGhlIHBlZXIga25vd3MgYWJvdXQuIChQZWVyIHN0cmVhbXMgemVybyBvciBtb3JlIG9mIHRoZXNlIHRvIHVzLilcbiAgICAvLyBVbmxlc3MgYWxyZWFkeSBpbiBmbGlnaHQsIHdlIHdpbGwgZW5zdXJlU3luY2hyb25pemVkVGFnIHRvIHN5bmNocm9uaXplIGl0LlxuICAgIGF3YWl0IHRoaXMuc3RhcnRlZFN5bmNocm9uaXphdGlvbjtcbiAgICBjb25zdCB7b3VyVGFncywgdW5zeW5jaHJvbml6ZWR9ID0gdGhpcztcbiAgICB0aGlzLmxvZygncmVjZWl2ZWQgXCJoYXNoXCInLCB7dGFnLCBoYXNoLCBvdXJUYWdzLCB1bnN5bmNocm9uaXplZH0pO1xuICAgIGlmICh1bnN5bmNocm9uaXplZC5oYXModGFnKSkgcmV0dXJuIG51bGw7IC8vIEFscmVhZHkgaGFzIGFuIGludmVzdGlnYXRpb24gaW4gcHJvZ3Jlc3MgKGUuZywgZHVlIHRvIGxvY2FsIGFwcCBzeW5jaHJvbml6YXRpb25Qcm9taXNlKS5cbiAgICBpZiAoIW91clRhZ3MuaGFzKHRhZykpIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gpOyAvLyBXZSBkb24ndCBoYXZlIHRoZSByZWNvcmQgYXQgYWxsLlxuICAgIHJldHVybiB0aGlzLmVuc3VyZVN5bmNocm9uaXplZFRhZyh0YWcsIGhhc2gsIHRoaXMuZ2V0SGFzaCh0YWcpKTtcbiAgfVxuICBlbnN1cmVTeW5jaHJvbml6ZWRUYWcodGFnLCB0aGVpckhhc2ggPSAnJywgb3VySGFzaFByb21pc2UgPSBudWxsKSB7XG4gICAgLy8gU3luY2hyb25vdXNseSByZWNvcmQgKGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXApIGEgcHJvbWlzZSB0byAoY29uY2VwdHVhbGx5KSByZXF1ZXN0IHRoZSB0YWcgZnJvbSB0aGUgcGVlcixcbiAgICAvLyBwdXQgaXQgaW4gdGhlIGNvbGxlY3Rpb24sIGFuZCBjbGVhbnVwIHRoZSBib29ra2VlcGluZy4gUmV0dXJuIHRoYXQgcHJvbWlzZS5cbiAgICAvLyBIb3dldmVyLCBpZiB3ZSBhcmUgZ2l2ZW4gaGFzaGVzIHRvIGNvbXBhcmUgYW5kIHRoZXkgbWF0Y2gsIHdlIGNhbiBza2lwIHRoZSByZXF1ZXN0L3B1dCBhbmQgcmVtb3ZlIGZyb20gdW5zeWNocm9uaXplZCBvbiBuZXh0IHRpY2suXG4gICAgLy8gKFRoaXMgbXVzdCByZXR1cm4gYXRvbWljYWxseSBiZWNhdXNlIGNhbGxlciBoYXMgY2hlY2tlZCB2YXJpb3VzIGJvb2trZWVwaW5nIGF0IHRoYXQgbW9tZW50LiBDaGVja2luZyBtYXkgcmVxdWlyZSB0aGF0IHdlIGF3YWl0IG91ckhhc2hQcm9taXNlLilcbiAgICBjb25zdCBwcm9taXNlID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHsgLy8gTmV4dCB0aWNrLiBTZWUgcmVxdWVzdCgpLlxuXHRpZiAoIXRoZWlySGFzaCB8fCAhb3VySGFzaFByb21pc2UgfHwgKHRoZWlySGFzaCAhPT0gYXdhaXQgb3VySGFzaFByb21pc2UpKSB7XG5cdCAgY29uc3QgdGhlaXJEYXRhID0gYXdhaXQgdGhpcy5yZXF1ZXN0KHRhZyk7XG5cdCAgLy8gTWlnaHQgaGF2ZSBiZWVuIHRyaWdnZXJlZCBieSBvdXIgYXBwIHJlcXVlc3RpbmcgdGhpcyB0YWcgYmVmb3JlIHdlIHdlcmUgc3luYydkLiBTbyB0aGV5IG1pZ2h0IG5vdCBoYXZlIHRoZSBkYXRhLlxuXHQgIGlmICghdGhlaXJIYXNoIHx8IHRoZWlyRGF0YT8ubGVuZ3RoKSB7XG5cdCAgICBpZiAoYXdhaXQgdGhpcy5jb2xsZWN0aW9uLnB1dCh0YWcsIHRoZWlyRGF0YSwgdGhpcykpIHtcblx0ICAgICAgdGhpcy5sb2coJ3JlY2VpdmVkL3B1dCcsIHRhZywgJ3RoZWlyL291ciBoYXNoOicsIHRoZWlySGFzaCB8fCAnbWlzc2luZ1RoZWlycycsIChhd2FpdCBvdXJIYXNoUHJvbWlzZSkgfHwgJ21pc3NpbmdPdXJzJywgdGhlaXJEYXRhPy5sZW5ndGgpO1xuXHQgICAgfSBlbHNlIHtcblx0ICAgICAgdGhpcy5sb2coJ3VuYWJsZSB0byBwdXQnLCB0YWcpO1xuXHQgICAgfVxuXHQgIH1cblx0fVxuXHR0aGlzLmNoZWNrZWRUYWdzLmFkZCh0YWcpOyAgICAgICAvLyBFdmVyeXRoaW5nIHdlJ3ZlIGV4YW1pbmVkLCByZWdhcmRsZXNzIG9mIHdoZXRoZXIgd2UgYXNrZWQgZm9yIG9yIHNhdmVkIGRhdGEgZnJvbSBwZWVyLiAoU2VlIHN5bmNocm9uaXphdGlvblByb21pc2UpXG5cdHRoaXMudW5zeW5jaHJvbml6ZWQuZGVsZXRlKHRhZyk7IC8vIFVuY29uZGl0aW9uYWxseSwgYmVjYXVzZSB3ZSBzZXQgaXQgdW5jb25kaXRpb25hbGx5LlxuXHR0aGlzLmNsZWFuVXBJZkZpbmlzaGVkKCk7XG5cdHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIHRoaXMudW5zeW5jaHJvbml6ZWQuc2V0KHRhZywgcHJvbWlzZSk7IC8vIFVuY29uZGl0aW9uYWxseSwgaW4gY2FzZSB3ZSBuZWVkIHRvIGtub3cgd2UncmUgbG9va2luZyBkdXJpbmcgdGhlIHRpbWUgd2UncmUgbG9va2luZy5cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuICByZXF1ZXN0KHRhZykgeyAvLyBNYWtlIGEgcmVxdWVzdCBmb3IgdGFnIGZyb20gdGhlIHBlZXIsIGFuZCBhbnN3ZXIgYSBwcm9taXNlIHRoZSByZXNvbHZlcyB3aXRoIHRoZSBkYXRhLlxuICAgIC8qY29uc3QgeyBob3N0UmVxdWVzdEJhc2UgfSA9IHRoaXM7XG4gICAgaWYgKGhvc3RSZXF1ZXN0QmFzZSkge1xuICAgICAgLy8gRS5nLiwgYSBsb2NhbGhvc3Qgcm91dGVyIG1pZ2h0IHN1cHBvcnQgYSBnZXQgb2YgaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyL190L3VML0JBY1dfTE5BSmEvY0pXbXVtYmxlXG4gICAgICAvLyBTbyBob3N0UmVxdWVzdEJhc2Ugc2hvdWxkIGJlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9NdXRhYmxlQ29sbGVjdGlvbi9jb20ua2kxcjB5LndoYXRldmVyXCIsXG4gICAgICAvLyBhbmQgc2VydmljZU5hbWUgc2hvdWxkIGJlIHNvbWV0aGluZyBsaWtlIFwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZsZXhzdG9yZS9zeW5jXCJcbiAgICAgIHJldHVybiBmZXRjaCh0YWdQYXRoKGhvc3RSZXF1ZXN0QmFzZSwgdGFnKSkudGhlbihyZXNwb25zZSA9PiByZXNwb25zZS50ZXh0KCkpO1xuICAgIH0qL1xuICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLm1ha2VSZXNvbHZlYWJsZVByb21pc2UodGhpcy5zZW5kKCdnZXQnLCB0YWcpKTtcbiAgICAvLyBTdWJ0bGU6IFdoZW4gdGhlICdwdXQnIGNvbWVzIGJhY2ssIHdlIHdpbGwgbmVlZCB0byByZXNvbHZlIHRoaXMgcHJvbWlzZS4gQnV0IGhvdyB3aWxsICdwdXQnIGZpbmQgdGhlIHByb21pc2UgdG8gcmVzb2x2ZSBpdD9cbiAgICAvLyBBcyBpdCB0dXJucyBvdXQsIHRvIGdldCBoZXJlLCB3ZSBoYXZlIG5lY2Vzc2FyaWxseSBzZXQgdGFnIGluIHRoZSB1bnN5bmNocm9uaXplZCBtYXAuIFxuICAgIGNvbnN0IG5vdGVkID0gdGhpcy51bnN5bmNocm9uaXplZC5nZXQodGFnKTsgLy8gQSBwcm9taXNlIHRoYXQgZG9lcyBub3QgaGF2ZSBhbiBleHBvc2VkIC5yZXNvbHZlLCBhbmQgd2hpY2ggZG9lcyBub3QgZXhwZWN0IGFueSB2YWx1ZS5cbiAgICBub3RlZC5yZXNvbHZlID0gcHJvbWlzZS5yZXNvbHZlOyAvLyBUYWNrIG9uIGEgcmVzb2x2ZSBmb3IgT1VSIHByb21pc2Ugb250byB0aGUgbm90ZWQgb2JqZWN0ICh3aGljaCBjb25mdXNpbmdseSwgaGFwcGVucyB0byBiZSBhIHByb21pc2UpLlxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gUmVzcG9uZCB0byBhIHBlZXIncyBnZXQoKSByZXF1ZXN0IGJ5IHNlbmRpbmcgYSBwdXQgcmVwb25zZSB3aXRoIHRoZSBkYXRhLlxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gICAgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIGRhdGEpO1xuICB9XG4gIHB1c2gob3BlcmF0aW9uLCB0YWcsIHNpZ25hdHVyZSkgeyAvLyBUZWxsIHRoZSBvdGhlciBzaWRlIGFib3V0IGEgc2lnbmVkIHdyaXRlLlxuICAgIHRoaXMuc2VuZChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlKTtcbiAgfVxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUpIHsgLy8gUmVjZWl2ZSBhIHB1dCBtZXNzYWdlIGZyb20gdGhlIHBlZXIuXG4gICAgLy8gSWYgaXQgaXMgYSByZXNwb25zZSB0byBhIGdldCgpIHJlcXVlc3QsIHJlc29sdmUgdGhlIGNvcnJlc3BvbmRpbmcgcHJvbWlzZS5cbiAgICBjb25zdCBwcm9taXNlID0gdGhpcy51bnN5bmNocm9uaXplZD8uZ2V0KHRhZyk7XG4gICAgLy8gUmVnYXJkbGVzcyBvZiB3aHkgdGhlIG90aGVyIHNpZGUgaXMgc2VuZGluZywgaWYgd2UgaGF2ZSBhbiBvdXRzdGFuZGluZyByZXF1ZXN0LCBjb21wbGV0ZSBpdC5cbiAgICBpZiAocHJvbWlzZSkgcHJvbWlzZS5yZXNvbHZlKHNpZ25hdHVyZSk7XG4gICAgZWxzZSBhd2FpdCB0aGlzLmNvbGxlY3Rpb24ucHV0KHRhZywgc2lnbmF0dXJlLCB0aGlzKTsgLy8gT3RoZXJ3aXNlLCBqdXN0IHRyeSB0byB3cml0ZSBpdCBsb2NhbGx5LlxuICB9XG4gIGRlbGV0ZSh0YWcsIHNpZ25hdHVyZSkgeyAvLyBSZWNlaXZlIGEgZGVsZXRlIG1lc3NhZ2UgZnJvbSB0aGUgcGVlci5cbiAgICB0aGlzLmNvbGxlY3Rpb24uZGVsZXRlKHRhZywgc2lnbmF0dXJlLCB0aGlzKTtcbiAgfVxufVxuZXhwb3J0IGRlZmF1bHQgU3luY2hyb25pemVyO1xuIiwiY2xhc3MgQ2FjaGUgZXh0ZW5kcyBNYXB7Y29uc3RydWN0b3IoZSx0PTApe3N1cGVyKCksdGhpcy5tYXhTaXplPWUsdGhpcy5kZWZhdWx0VGltZVRvTGl2ZT10LHRoaXMuX25leHRXcml0ZUluZGV4PTAsdGhpcy5fa2V5TGlzdD1BcnJheShlKSx0aGlzLl90aW1lcnM9bmV3IE1hcH1zZXQoZSx0LHM9dGhpcy5kZWZhdWx0VGltZVRvTGl2ZSl7bGV0IGk9dGhpcy5fbmV4dFdyaXRlSW5kZXg7dGhpcy5kZWxldGUodGhpcy5fa2V5TGlzdFtpXSksdGhpcy5fa2V5TGlzdFtpXT1lLHRoaXMuX25leHRXcml0ZUluZGV4PShpKzEpJXRoaXMubWF4U2l6ZSx0aGlzLl90aW1lcnMuaGFzKGUpJiZjbGVhclRpbWVvdXQodGhpcy5fdGltZXJzLmdldChlKSksc3VwZXIuc2V0KGUsdCkscyYmdGhpcy5fdGltZXJzLnNldChlLHNldFRpbWVvdXQoKCgpPT50aGlzLmRlbGV0ZShlKSkscykpfWRlbGV0ZShlKXtyZXR1cm4gdGhpcy5fdGltZXJzLmhhcyhlKSYmY2xlYXJUaW1lb3V0KHRoaXMuX3RpbWVycy5nZXQoZSkpLHRoaXMuX3RpbWVycy5kZWxldGUoZSksc3VwZXIuZGVsZXRlKGUpfWNsZWFyKGU9dGhpcy5tYXhTaXplKXt0aGlzLm1heFNpemU9ZSx0aGlzLl9rZXlMaXN0PUFycmF5KGUpLHRoaXMuX25leHRXcml0ZUluZGV4PTAsc3VwZXIuY2xlYXIoKTtmb3IoY29uc3QgZSBvZiB0aGlzLl90aW1lcnMudmFsdWVzKCkpY2xlYXJUaW1lb3V0KGUpO3RoaXMuX3RpbWVycy5jbGVhcigpfX1jbGFzcyBTdG9yYWdlQmFzZXtjb25zdHJ1Y3Rvcih7bmFtZTplLGJhc2VOYW1lOnQ9XCJTdG9yYWdlXCIsbWF4U2VyaWFsaXplclNpemU6cz0xZTMsZGVidWc6aT0hMX0pe2NvbnN0IGE9YCR7dH0vJHtlfWAscj1uZXcgQ2FjaGUocyk7T2JqZWN0LmFzc2lnbih0aGlzLHtuYW1lOmUsYmFzZU5hbWU6dCxmdWxsTmFtZTphLGRlYnVnOmksc2VyaWFsaXplcjpyfSl9YXN5bmMgbGlzdCgpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShcIlwiLCgoZSx0KT0+dGhpcy5saXN0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGdldChlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZ2V0SW50ZXJuYWwodCxlKSkpfWFzeW5jIGRlbGV0ZShlKXtyZXR1cm4gdGhpcy5zZXJpYWxpemUoZSwoKGUsdCk9PnRoaXMuZGVsZXRlSW50ZXJuYWwodCxlKSkpfWFzeW5jIHB1dChlLHQpe3JldHVybiB0aGlzLnNlcmlhbGl6ZShlLCgoZSxzKT0+dGhpcy5wdXRJbnRlcm5hbChzLHQsZSkpKX1sb2coLi4uZSl7dGhpcy5kZWJ1ZyYmY29uc29sZS5sb2codGhpcy5uYW1lLC4uLmUpfWFzeW5jIHNlcmlhbGl6ZShlLHQpe2NvbnN0e3NlcmlhbGl6ZXI6cyxyZWFkeTppfT10aGlzO2xldCBhPXMuZ2V0KGUpfHxpO3JldHVybiBhPWEudGhlbigoYXN5bmMoKT0+dChhd2FpdCB0aGlzLnJlYWR5LHRoaXMucGF0aChlKSkpKSxzLnNldChlLGEpLGF3YWl0IGF9fWNvbnN0e1Jlc3BvbnNlOmUsVVJMOnR9PWdsb2JhbFRoaXM7Y2xhc3MgU3RvcmFnZUNhY2hlIGV4dGVuZHMgU3RvcmFnZUJhc2V7Y29uc3RydWN0b3IoLi4uZSl7c3VwZXIoLi4uZSksdGhpcy5zdHJpcHBlcj1uZXcgUmVnRXhwKGBeLyR7dGhpcy5mdWxsTmFtZX0vYCksdGhpcy5yZWFkeT1jYWNoZXMub3Blbih0aGlzLmZ1bGxOYW1lKX1hc3luYyBsaXN0SW50ZXJuYWwoZSx0KXtyZXR1cm4oYXdhaXQgdC5rZXlzKCl8fFtdKS5tYXAoKGU9PnRoaXMudGFnKGUudXJsKSkpfWFzeW5jIGdldEludGVybmFsKGUsdCl7Y29uc3Qgcz1hd2FpdCB0Lm1hdGNoKGUpO3JldHVybiBzPy5qc29uKCl9ZGVsZXRlSW50ZXJuYWwoZSx0KXtyZXR1cm4gdC5kZWxldGUoZSl9cHV0SW50ZXJuYWwodCxzLGkpe3JldHVybiBpLnB1dCh0LGUuanNvbihzKSl9cGF0aChlKXtyZXR1cm5gLyR7dGhpcy5mdWxsTmFtZX0vJHtlfWB9dGFnKGUpe3JldHVybiBuZXcgdChlKS5wYXRobmFtZS5yZXBsYWNlKHRoaXMuc3RyaXBwZXIsXCJcIil9ZGVzdHJveSgpe3JldHVybiBjYWNoZXMuZGVsZXRlKHRoaXMuZnVsbE5hbWUpfX1leHBvcnR7U3RvcmFnZUNhY2hlIGFzIFN0b3JhZ2VMb2NhbCxTdG9yYWdlQ2FjaGUgYXMgZGVmYXVsdH07XG4iLCJpbXBvcnQgQ3JlZGVudGlhbHMgZnJvbSAnQGtpMXIweS9kaXN0cmlidXRlZC1zZWN1cml0eSc7XG5pbXBvcnQgeyBTdG9yYWdlTG9jYWwgfSBmcm9tICdAa2kxcjB5L3N0b3JhZ2UnO1xuaW1wb3J0IFN5bmNocm9uaXplciBmcm9tICcuL3N5bmNocm9uaXplci5tanMnO1xuaW1wb3J0IHsgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uIH0gZnJvbSAnLi92ZXJzaW9uLm1qcyc7XG5jb25zdCB7IEN1c3RvbUV2ZW50LCBFdmVudFRhcmdldCwgVGV4dERlY29kZXIgfSA9IGdsb2JhbFRoaXM7XG5cbmV4cG9ydCBjbGFzcyBDb2xsZWN0aW9uIGV4dGVuZHMgRXZlbnRUYXJnZXQge1xuXG4gIGNvbnN0cnVjdG9yKHtuYW1lLCBsYWJlbCA9IG5hbWUsIHNlcnZpY2VzID0gW10sIHByZXNlcnZlRGVsZXRpb25zID0gISFzZXJ2aWNlcy5sZW5ndGgsXG5cdCAgICAgICBwZXJzaXN0ZW5jZUNsYXNzID0gU3RvcmFnZUxvY2FsLCBkYlZlcnNpb24gPSBzdG9yYWdlVmVyc2lvbiwgcGVyc2lzdGVuY2VCYXNlID0gYCR7c3RvcmFnZU5hbWV9XyR7ZGJWZXJzaW9ufWAsXG5cdCAgICAgICBkZWJ1ZyA9IGZhbHNlLCBtdWx0aXBsZXgsIC8vIENhdXNlcyBzeW5jaHJvbml6YXRpb24gdG8gcmV1c2UgY29ubmVjdGlvbnMgZm9yIGRpZmZlcmVudCBDb2xsZWN0aW9ucyBvbiB0aGUgc2FtZSBzZXJ2aWNlLlxuXHQgICAgICAgY2hhbm5lbE5hbWUsIHNlcnZpY2VMYWJlbH0pIHtcbiAgICBzdXBlcigpO1xuICAgIE9iamVjdC5hc3NpZ24odGhpcywge25hbWUsIGxhYmVsLCBwcmVzZXJ2ZURlbGV0aW9ucywgcGVyc2lzdGVuY2VDbGFzcywgZGJWZXJzaW9uLCBtdWx0aXBsZXgsIGRlYnVnLCBjaGFubmVsTmFtZSwgc2VydmljZUxhYmVsLFxuXHRcdFx0IGZ1bGxOYW1lOiBgJHt0aGlzLmNvbnN0cnVjdG9yLm5hbWV9LyR7bmFtZX1gLCBmdWxsTGFiZWw6IGAke3RoaXMuY29uc3RydWN0b3IubmFtZX0vJHtsYWJlbH1gfSk7XG4gICAgdGhpcy5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgcGVyc2lzdGVuY2VPcHRpb25zID0ge25hbWU6IHRoaXMuZnVsbExhYmVsLCBiYXNlTmFtZTogcGVyc2lzdGVuY2VCYXNlLCBkZWJ1ZzogZGVidWd9O1xuICAgIGlmIChwZXJzaXN0ZW5jZUNsYXNzLnRoZW4pIHRoaXMucGVyc2lzdGVuY2VTdG9yZSA9IHBlcnNpc3RlbmNlQ2xhc3MudGhlbihraW5kID0+IG5ldyBraW5kKHBlcnNpc3RlbmNlT3B0aW9ucykpO1xuICAgIGVsc2UgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlID0gbmV3IHBlcnNpc3RlbmNlQ2xhc3MocGVyc2lzdGVuY2VPcHRpb25zKTtcbiAgfVxuXG4gIGFzeW5jIGNsb3NlKCkge1xuICAgIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmNsb3NlKCk7XG4gIH1cbiAgYXN5bmMgZGVzdHJveSgpIHtcbiAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3QoKTtcbiAgICBjb25zdCBzdG9yZSA9IGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZTtcbiAgICBkZWxldGUgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIGlmIChzdG9yZSkgYXdhaXQgc3RvcmUuZGVzdHJveSgpO1xuICB9XG5cbiAgc3RhdGljIGVycm9yKGVycm9yKSB7IC8vIENhbiBiZSBvdmVycmlkZGVuIGJ5IHRoZSBjbGllbnRcbiAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgfVxuICAvLyBDcmVkZW50aWFscy5zaWduLy52ZXJpZnkgY2FuIHByb2R1Y2UvYWNjZXB0IEpTT04gT0JKRUNUUyBmb3IgdGhlIG5hbWVkIFwiSlNPTiBTZXJpYWxpemF0aW9uXCIgZm9ybS5cbiAgLy8gQXMgaXQgaGFwcGVucywgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgY2FuIGRpc3Rpbmd1aXNoIGJldHdlZW4gYSBjb21wYWN0IHNlcmlhbGl6YXRpb24gKGJhc2U2NCB0ZXh0KVxuICAvLyB2cyBhbiBvYmplY3QsIGJ1dCBpdCBkb2VzIG5vdCByZWNvZ25pemUgYSBTRVJJQUxJWkVEIG9iamVjdC4gSGVyZSB3ZSBib3R0bGVuZWNrIHRob3NlIG9wZXJhdGlvbnNcbiAgLy8gc3VjaCB0aGF0IHRoZSB0aGluZyB0aGF0IGlzIGFjdHVhbGx5IHBlcnNpc3RlZCBhbmQgc3luY2hyb25pemVkIGlzIGFsd2F5cyBhIHN0cmluZyAtLSBlaXRoZXIgYmFzZTY0XG4gIC8vIGNvbXBhY3Qgb3IgSlNPTiBiZWdpbm5pbmcgd2l0aCBhIFwie1wiICh3aGljaCBhcmUgZGlzdGluZ3Vpc2hhYmxlIGJlY2F1c2UgXCJ7XCIgaXMgbm90IGEgYmFzZTY0IGNoYXJhY3RlcikuXG4gIHN0YXRpYyBlbnN1cmVTdHJpbmcoc2lnbmF0dXJlKSB7IC8vIFJldHVybiBhIHNpZ25hdHVyZSB0aGF0IGlzIGRlZmluYXRlbHkgYSBzdHJpbmcuXG4gICAgaWYgKHR5cGVvZihzaWduYXR1cmUpICE9PSAnc3RyaW5nJykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBSZXR1cm4gYSBjb21wYWN0IG9yIFwiSlNPTlwiIChvYmplY3QpIGZvcm0gb2Ygc2lnbmF0dXJlIChpbmZsYXRpbmcgYSBzZXJpYWxpemF0aW9uIG9mIHRoZSBsYXR0ZXIgaWYgbmVlZGVkKSwgYnV0IG5vdCBhIEpTT04gc3RyaW5nLlxuICBzdGF0aWMgbWF5YmVJbmZsYXRlKHNpZ25hdHVyZSkge1xuICAgIGlmIChzaWduYXR1cmU/LnN0YXJ0c1dpdGg/LihcIntcIikpIHJldHVybiBKU09OLnBhcnNlKHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHNpZ25hdHVyZTtcbiAgfVxuICAvLyBUaGUgdHlwZSBvZiBKV0UgdGhhdCBnZXRzIHNpZ25lZCAobm90IHRoZSBjdHkgb2YgdGhlIEpXRSkuIFdlIGF1dG9tYXRpY2FsbHkgdHJ5IHRvIGRlY3J5cHQgYSBKV1MgcGF5bG9hZCBvZiB0aGlzIHR5cGUuXG4gIHN0YXRpYyBlbmNyeXB0ZWRNaW1lVHlwZSA9ICd0ZXh0L2VuY3J5cHRlZCc7XG4gIHN0YXRpYyBhc3luYyBlbnN1cmVEZWNyeXB0ZWQodmVyaWZpZWQpIHsgLy8gUHJvbWlzZSB2ZXJmaWVkIGFmdGVyIGZpcnN0IGF1Z21lbnRpbmcgd2l0aCBkZWNyeXB0ZWQgZGF0YSBhcyBuZWVkZWQuXG4gICAgaWYgKHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5jdHkgIT09IHRoaXMuZW5jcnlwdGVkTWltZVR5cGUpIHJldHVybiB2ZXJpZmllZDtcbiAgICBpZiAodmVyaWZpZWQuZGVjcnlwdGVkKSByZXR1cm4gdmVyaWZpZWQ7IC8vIEFscmVhZHkgZGVjcnlwdGVkLlxuICAgIGNvbnN0IGRlY3J5cHRlZCA9IGF3YWl0IENyZWRlbnRpYWxzLmRlY3J5cHQodmVyaWZpZWQudGV4dCk7XG4gICAgdmVyaWZpZWQuanNvbiA9IGRlY3J5cHRlZC5qc29uO1xuICAgIHZlcmlmaWVkLnRleHQgPSBkZWNyeXB0ZWQudGV4dDtcbiAgICB2ZXJpZmllZC5wYXlsb2FkID0gZGVjcnlwdGVkLnBheWxvYWQ7XG4gICAgdmVyaWZpZWQuZGVjcnlwdGVkID0gZGVjcnlwdGVkO1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuXG4gIC8vIFRPRE8/OiBUaGVzZSB0YWtlIFNlY3VyaXR5LXN0eWxlIHRlYW0vbWVtYmVyLCB3aGlsZSBldmVyeXRoaW5nIGVsc2UgaGVyZSB0YWtlcyBvd25lci9hdXRob3IuXG4gIHN0YXRpYyBhc3luYyBzaWduKGRhdGEsIG9wdGlvbnMpIHtcbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCBDcmVkZW50aWFscy5zaWduKGRhdGEsIG9wdGlvbnMpO1xuICAgIHJldHVybiB0aGlzLmVuc3VyZVN0cmluZyhzaWduYXR1cmUpO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2ZXJpZnkoc2lnbmF0dXJlLCBvcHRpb25zID0ge30pIHtcbiAgICBzaWduYXR1cmUgPSB0aGlzLm1heWJlSW5mbGF0ZShzaWduYXR1cmUpO1xuICAgIC8vIFdlIGRvbid0IGRvIFwiZGVlcFwiIHZlcmlmaWNhdGlvbiBoZXJlIC0gZS5nLiwgY2hlY2tpbmcgdGhhdCB0aGUgYWN0IGlzIGEgbWVtYmVyIG9mIGlzcywgYW5kIHRoZSBpYXQgaXMgYWZ0ZXIgdGhlIGV4aXN0aW5nIGlhdC5cbiAgICAvLyBJbnN0ZWFkLCB3ZSBkbyBvdXIgb3duIGRlZXAgY2hlY2tzIGluIHZhbGlkYXRlRm9yV3JpdGluZy5cbiAgICAvLyBUaGUgbWVtYmVyL25vdEJlZm9yZSBzaG91bGQgY2hlY2sgb3V0IGFueXdheSAtLSBpLmUuLCB3ZSBjb3VsZCBsZWF2ZSBpdCBpbiwgZXhjZXB0IGluIHN5bmNocm9uaXppbmdcbiAgICAvLyBDcmVkZW50aWFsLmNvbGxlY3Rpb25zLiBUaGVyZSBpcyBubyBtZWNoYW5pc20gKGN1cnJlbnRseSkgZm9yIHRoZVxuICAgIC8vIHN5bmNocm9uaXphdGlvbiB0byBoYXBwZW4gaW4gYW4gb3JkZXIgdGhhdCB3aWxsIHJlc3VsdCBpbiB0aGUgZGVwZW5kZW5jaWVzIGNvbWluZyBvdmVyIGJlZm9yZSB0aGUgaXRlbXMgdGhhdCBjb25zdW1lIHRoZW0uXG4gICAgY29uc3QgdmVyaWZpZWQgPSAgYXdhaXQgQ3JlZGVudGlhbHMudmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyk7XG4gICAgaWYgKHZlcmlmaWVkKSB2ZXJpZmllZC5zaWduYXR1cmUgPSBzaWduYXR1cmU7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2ZXJpZmllZFNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMsIHRhZyA9IG51bGwpIHsgLy8gU2lnbiwgYnV0IHJldHVybiBhIHZhbGlkYXRpb24gKGFzIHRob3VnaCBieSBpbW1lZGlhdGVseSB2YWxpZGF0aW5nKS5cbiAgICAvLyBUT0RPOiBhc3NlbWJsZSB0aGlzIG1vcmUgY2hlYXBseT9cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHJldHVybiB0aGlzLnZhbGlkYXRpb25Gb3JtYXQoc2lnbmF0dXJlLCB0YWcpO1xuICB9XG4gIHN0YXRpYyBhc3luYyB2YWxpZGF0aW9uRm9ybWF0KHNpZ25hdHVyZSwgdGFnID0gbnVsbCkge1xuICAgIC8vY29uc29sZS5sb2coe3R5cGU6IHR5cGVvZihzaWduYXR1cmUpLCBzaWduYXR1cmUsIHRhZ30pO1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy52ZXJpZnkoc2lnbmF0dXJlKTtcbiAgICAvL2NvbnNvbGUubG9nKHt2ZXJpZmllZH0pO1xuICAgIGNvbnN0IHN1YiA9IHZlcmlmaWVkLnN1YmplY3RUYWcgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICAgIHZlcmlmaWVkLnRhZyA9IHRhZyB8fCBzdWI7XG4gICAgcmV0dXJuIHZlcmlmaWVkO1xuICB9XG5cbiAgYXN5bmMgdW5kZWxldGVkVGFncygpIHtcbiAgICAvLyBPdXIgb3duIHNlcGFyYXRlLCBvbi1kZW1hbmQgYWNjb3VudGluZyBvZiBwZXJzaXN0ZW5jZVN0b3JlIGxpc3QoKTpcbiAgICAvLyAgIC0gcGVyc2lzdGVuY2VTdG9yZSBsaXN0KCkgY291bGQgcG90ZW50aWFsbHkgYmUgZXhwZW5zaXZlXG4gICAgLy8gICAtIEl0IHdpbGwgY29udGFpbiBzb2Z0LWRlbGV0ZWQgaXRlbSB0b21ic3RvbmVzIChzaWduZWQgZW1wdHkgcGF5bG9hZHMpLlxuICAgIC8vIEl0IHN0YXJ0cyB3aXRoIGEgbGlzdCgpIHRvIGdldCBhbnl0aGluZyBwZXJzaXN0ZWQgaW4gYSBwcmV2aW91cyBzZXNzaW9uLCBhbmQgYWRkcy9yZW1vdmVzIGFzIHdlIHN0b3JlL3JlbW92ZS5cbiAgICBjb25zdCBhbGxUYWdzID0gYXdhaXQgKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSkubGlzdCgpO1xuICAgIGNvbnN0IHRhZ3MgPSBuZXcgU2V0KCk7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoYWxsVGFncy5tYXAoYXN5bmMgdGFnID0+IHtcbiAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5nZXRWZXJpZmllZCh7dGFnLCBzeW5jaHJvbml6ZTogZmFsc2V9KTtcbiAgICAgIGlmICh2ZXJpZmllZCkgdGFncy5hZGQodGFnKTtcbiAgICB9KSk7XG4gICAgcmV0dXJuIHRhZ3M7XG4gIH1cbiAgZ2V0IHRhZ3MoKSB7IC8vIEtlZXBzIHRyYWNrIG9mIG91ciAodW5kZWxldGVkKSBrZXlzLlxuICAgIHJldHVybiB0aGlzLl90YWdzUHJvbWlzZSB8fD0gdGhpcy51bmRlbGV0ZWRUYWdzKCk7XG4gIH1cbiAgYXN5bmMgYWRkVGFnKHRhZykge1xuICAgIChhd2FpdCB0aGlzLnRhZ3MpLmFkZCh0YWcpO1xuICB9XG4gIGFzeW5jIGRlbGV0ZVRhZyh0YWcpIHtcbiAgICAoYXdhaXQgdGhpcy50YWdzKS5kZWxldGUodGFnKTtcbiAgfVxuXG4gIGxvZyguLi5yZXN0KSB7XG4gICAgaWYgKCF0aGlzLmRlYnVnKSByZXR1cm47XG4gICAgY29uc29sZS5sb2codGhpcy5mdWxsTGFiZWwsIC4uLnJlc3QpO1xuICB9XG4gIF9jYW5vbmljYWxpemVPcHRpb25zKG9iamVjdE9yU3RyaW5nID0ge30pIHtcbiAgICBpZiAodHlwZW9mKG9iamVjdE9yU3RyaW5nKSA9PT0gJ3N0cmluZycpIG9iamVjdE9yU3RyaW5nID0ge3RhZzogb2JqZWN0T3JTdHJpbmd9O1xuICAgIGNvbnN0IHtvd25lcjp0ZWFtID0gQ3JlZGVudGlhbHMub3duZXIsIGF1dGhvcjptZW1iZXIgPSBDcmVkZW50aWFscy5hdXRob3IsXG5cdCAgIHRhZyxcblx0ICAgZW5jcnlwdGlvbiA9IENyZWRlbnRpYWxzLmVuY3J5cHRpb24sXG5cdCAgIHRpbWUgPSBEYXRlLm5vdygpLFxuXHQgICAuLi5yZXN0fSA9IG9iamVjdE9yU3RyaW5nO1xuICAgIC8vIFRPRE86IHN1cHBvcnQgc2ltcGxpZmllZCBzeW50YXgsIHRvbywgcGVyIFJFQURNRVxuICAgIC8vIFRPRE86IHNob3VsZCB3ZSBzcGVjaWZ5IHN1YmplY3Q6IHRhZyBmb3IgYm90aCBtdXRhYmxlcz8gKGdpdmVzIGhhc2gpXG4gICAgY29uc3Qgb3B0aW9ucyA9ICh0ZWFtICYmIHRlYW0gIT09IG1lbWJlcikgP1xuXHQgIHt0ZWFtLCBtZW1iZXIsIHRhZywgZW5jcnlwdGlvbiwgdGltZSwgLi4ucmVzdH0gOlxuXHQgIHt0YWdzOiBbbWVtYmVyXSwgdGFnLCB0aW1lLCBlbmNyeXB0aW9uLCAuLi5yZXN0fTsgLy8gTm8gaWF0IGlmIHRpbWUgbm90IGV4cGxpY2l0bHkgZ2l2ZW4uXG4gICAgaWYgKFt0cnVlLCAndGVhbScsICdvd25lciddLmluY2x1ZGVzKG9wdGlvbnMuZW5jcnlwdGlvbikpIG9wdGlvbnMuZW5jcnlwdGlvbiA9IHRlYW07XG4gICAgcmV0dXJuIG9wdGlvbnM7XG4gIH1cbiAgZmFpbChvcGVyYXRpb24sIGRhdGEsIGF1dGhvcikge1xuICAgIHRocm93IG5ldyBFcnJvcihgJHthdXRob3J9IGRvZXMgbm90IGhhdmUgdGhlIGF1dGhvcml0eSB0byAke29wZXJhdGlvbn0gJHt0aGlzLmZ1bGxOYW1lfSAke0pTT04uc3RyaW5naWZ5KGRhdGEpfS5gKTtcbiAgfVxuICBhc3luYyBzdG9yZShkYXRhLCBvcHRpb25zID0ge30pIHtcbiAgICAvLyBlbmNyeXB0IGlmIG5lZWRlZFxuICAgIC8vIHNpZ25cbiAgICAvLyBwdXQgPD09IEFsc28gd2hlcmUgd2UgZW50ZXIgaWYgcHVzaGVkIGZyb20gYSBjb25uZWN0aW9uXG4gICAgLy8gICAgdmFsaWRhdGVGb3JXcml0aW5nXG4gICAgLy8gICAgICAgZXhpdCBpZiBpbXByb3BlclxuICAgIC8vICAgICAgIGVtaXQgdXBkYXRlIGV2ZW50XG4gICAgLy8gICAgbWVyZ2VTaWduYXR1cmVzXG4gICAgLy8gICAgcGVyc2lzdCBsb2NhbGx5XG4gICAgLy8gcHVzaCAobGl2ZSB0byBhbnkgY29ubmVjdGlvbnMgZXhjZXB0IHRoZSBvbmUgd2UgcmVjZWl2ZWQgZnJvbSlcbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgaWZFeGlzdHMsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7XG4gICAgaWYgKGVuY3J5cHRpb24pIHtcbiAgICAgIGRhdGEgPSBhd2FpdCBDcmVkZW50aWFscy5lbmNyeXB0KGRhdGEsIGVuY3J5cHRpb24pO1xuICAgICAgc2lnbmluZ09wdGlvbnMuY29udGVudFR5cGUgPSB0aGlzLmNvbnN0cnVjdG9yLmVuY3J5cHRlZE1pbWVUeXBlO1xuICAgIH1cbiAgICAvLyBObyBuZWVkIHRvIGF3YWl0IHN5bmNocm9uaXphdGlvbi5cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHRhZyA9IGF3YWl0IHRoaXMucHV0KHRhZywgc2lnbmF0dXJlLCBudWxsLCBudWxsLCBpZkV4aXN0cyk7XG4gICAgaWYgKCF0YWcpIHJldHVybiB0aGlzLmZhaWwoJ3N0b3JlJywgZGF0YSwgc2lnbmluZ09wdGlvbnMubWVtYmVyIHx8IHNpZ25pbmdPcHRpb25zLnRhZ3NbMF0pO1xuICAgIGF3YWl0IHRoaXMucHVzaCgncHV0JywgdGFnLCBzaWduYXR1cmUpO1xuICAgIHJldHVybiB0YWc7XG4gIH1cbiAgcHVzaChvcGVyYXRpb24sIHRhZywgc2lnbmF0dXJlLCBleGNsdWRlU3luY2hyb25pemVyID0gbnVsbCkgeyAvLyBQdXNoIHRvIGFsbCBjb25uZWN0ZWQgc3luY2hyb25pemVycywgZXhjbHVkaW5nIHRoZSBzcGVjaWZpZWQgb25lLlxuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMoc3luY2hyb25pemVyID0+IChleGNsdWRlU3luY2hyb25pemVyICE9PSBzeW5jaHJvbml6ZXIpICYmIHN5bmNocm9uaXplci5wdXNoKG9wZXJhdGlvbiwgdGFnLCBzaWduYXR1cmUpKSk7XG4gIH1cbiAgYXN5bmMgcmVtb3ZlKG9wdGlvbnMgPSB7fSkgeyAvLyBOb3RlOiBSZWFsbHkganVzdCByZXBsYWNpbmcgd2l0aCBlbXB0eSBkYXRhIGZvcmV2ZXIuIE90aGVyd2lzZSBtZXJnaW5nIHdpdGggZWFybGllciBkYXRhIHdpbGwgYnJpbmcgaXQgYmFjayFcbiAgICBsZXQge2VuY3J5cHRpb24sIHRhZywgLi4uc2lnbmluZ09wdGlvbnN9ID0gdGhpcy5fY2Fub25pY2FsaXplT3B0aW9ucyhvcHRpb25zKTtcbiAgICBjb25zdCBkYXRhID0gJyc7XG4gICAgLy8gTm8gbmVlZCB0byBhd2FpdCBzeW5jaHJvbml6YXRpb25cbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oZGF0YSwgc2lnbmluZ09wdGlvbnMpO1xuICAgIHRhZyA9IGF3YWl0IHRoaXMuZGVsZXRlKHRhZywgc2lnbmF0dXJlKTtcbiAgICBpZiAoIXRhZykgcmV0dXJuIHRoaXMuZmFpbCgnc3RvcmUnLCBkYXRhLCBzaWduaW5nT3B0aW9ucy5tZW1iZXIgfHwgc2lnbmluZ09wdGlvbnMudGFnc1swXSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdkZWxldGUnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZXRyaWV2ZSh0YWdPck9wdGlvbnMpIHsgLy8gZ2V0VmVyaWZpZWQgYW5kIG1heWJlIGRlY3J5cHQuIEhhcyBtb3JlIGNvbXBsZXggYmVoYXZpb3IgaW4gc3ViY2xhc3MgVmVyc2lvbmVkQ29sbGVjdGlvbi5cbiAgICBjb25zdCB7dGFnLCBkZWNyeXB0ID0gdHJ1ZSwgLi4ub3B0aW9uc30gPSB0YWdPck9wdGlvbnMudGFnID8gdGFnT3JPcHRpb25zIDoge3RhZzogdGFnT3JPcHRpb25zfTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZywgLi4ub3B0aW9uc30pO1xuICAgIGlmICghdmVyaWZpZWQpIHJldHVybiAnJztcbiAgICBpZiAoZGVjcnlwdCkgcmV0dXJuIGF3YWl0IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlRGVjcnlwdGVkKHZlcmlmaWVkKTtcbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgYXN5bmMgZ2V0VmVyaWZpZWQodGFnT3JPcHRpb25zKSB7IC8vIHN5bmNocm9uaXplLCBnZXQsIGFuZCB2ZXJpZnkgKGJ1dCB3aXRob3V0IGRlY3J5cHQpXG4gICAgY29uc3Qge3RhZywgc3luY2hyb25pemUgPSB0cnVlLCAuLi52ZXJpZnlPcHRpb25zfSA9IHRhZ09yT3B0aW9ucy50YWcgPyB0YWdPck9wdGlvbnM6IHt0YWc6IHRhZ09yT3B0aW9uc307XG4gICAgaWYgKHN5bmNocm9uaXplKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplMSh0YWcpO1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuZ2V0KHRhZyk7XG4gICAgaWYgKCFzaWduYXR1cmUpIHJldHVybiBzaWduYXR1cmU7XG4gICAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSwgdmVyaWZ5T3B0aW9ucyk7XG4gIH1cbiAgYXN5bmMgbGlzdChza2lwU3luYyA9IGZhbHNlICkgeyAvLyBMaXN0IGFsbCB0YWdzIG9mIHRoaXMgY29sbGVjdGlvbi5cbiAgICBpZiAoIXNraXBTeW5jKSBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIC8vIFdlIGNhbm5vdCBqdXN0IGxpc3QgdGhlIGtleXMgb2YgdGhlIGNvbGxlY3Rpb24sIGJlY2F1c2UgdGhhdCBpbmNsdWRlcyBlbXB0eSBwYXlsb2FkcyBvZiBpdGVtcyB0aGF0IGhhdmUgYmVlbiBkZWxldGVkLlxuICAgIHJldHVybiBBcnJheS5mcm9tKChhd2FpdCB0aGlzLnRhZ3MpLmtleXMoKSk7XG4gIH1cbiAgYXN5bmMgbWF0Y2godGFnLCBwcm9wZXJ0aWVzKSB7IC8vIElzIHRoaXMgc2lnbmF0dXJlIHdoYXQgd2UgYXJlIGxvb2tpbmcgZm9yP1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5yZXRyaWV2ZSh0YWcpO1xuICAgIGNvbnN0IGRhdGEgPSB2ZXJpZmllZD8uanNvbjtcbiAgICBpZiAoIWRhdGEpIHJldHVybiBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBwcm9wZXJ0aWVzKSB7XG4gICAgICBpZiAoZGF0YVtrZXldICE9PSBwcm9wZXJ0aWVzW2tleV0pIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgYXN5bmMgZmluZExvY2FsKHByb3BlcnRpZXMpIHsgLy8gRmluZCB0aGUgdGFnIGluIG91ciBzdG9yZSB0aGF0IG1hdGNoZXMsIGVsc2UgZmFsc2V5XG4gICAgZm9yIChjb25zdCB0YWcgb2YgYXdhaXQgdGhpcy5saXN0KCduby1zeW5jJykpIHsgLy8gRGlyZWN0IGxpc3QsIHcvbyBzeW5jLlxuICAgICAgaWYgKGF3YWl0IHRoaXMubWF0Y2godGFnLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIHRhZztcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGFzeW5jIGZpbmQocHJvcGVydGllcykgeyAvLyBBbnN3ZXIgdGhlIHRhZyB0aGF0IGhhcyB2YWx1ZXMgbWF0Y2hpbmcgdGhlIHNwZWNpZmllZCBwcm9wZXJ0aWVzLiBPYnZpb3VzbHksIGNhbid0IGJlIGVuY3J5cHRlZCBhcyBhIHdob2xlLlxuICAgIGxldCBmb3VuZCA9IGF3YWl0IHRoaXMuZmluZExvY2FsKHByb3BlcnRpZXMpO1xuICAgIGlmIChmb3VuZCkge1xuICAgICAgYXdhaXQgdGhpcy5zeW5jaHJvbml6ZTEoZm91bmQpOyAvLyBNYWtlIHN1cmUgdGhlIGRhdGEgaXMgdXAgdG8gZGF0ZS4gVGhlbiBjaGVjayBhZ2Fpbi5cbiAgICAgIGlmIChhd2FpdCB0aGlzLm1hdGNoKGZvdW5kLCBwcm9wZXJ0aWVzKSkgcmV0dXJuIGZvdW5kO1xuICAgIH1cbiAgICAvLyBObyBtYXRjaC5cbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplVGFncygpO1xuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemVEYXRhKCk7XG4gICAgZm91bmQgPSBhd2FpdCB0aGlzLmZpbmRMb2NhbChwcm9wZXJ0aWVzKTtcbiAgICBpZiAoZm91bmQgJiYgYXdhaXQgdGhpcy5tYXRjaChmb3VuZCwgcHJvcGVydGllcykpIHJldHVybiBmb3VuZDtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXF1aXJlVGFnKHRhZykge1xuICAgIGlmICh0YWcpIHJldHVybjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0EgdGFnIGlzIHJlcXVpcmVkLicpO1xuICB9XG5cbiAgLy8gVGhlc2UgdGhyZWUgaWdub3JlIHN5bmNocm9uaXphdGlvbiBzdGF0ZSwgd2hpY2ggaWYgbmVlZWQgaXMgdGhlIHJlc3BvbnNpYmlsaXR5IG9mIHRoZSBjYWxsZXIuXG4gIC8vIEZJWE1FIFRPRE86IGFmdGVyIGluaXRpYWwgZGV2ZWxvcG1lbnQsIHRoZXNlIHRocmVlIHNob3VsZCBiZSBtYWRlIGludGVybmFsIHNvIHRoYXQgYXBwbGljYXRpb24gY29kZSBkb2VzIG5vdCBjYWxsIHRoZW0uXG4gIGFzeW5jIGdldCh0YWcpIHsgLy8gR2V0IHRoZSBsb2NhbCByYXcgc2lnbmF0dXJlIGRhdGEuXG4gICAgdGhpcy5yZXF1aXJlVGFnKHRhZyk7XG4gICAgcmV0dXJuIGF3YWl0IChhd2FpdCB0aGlzLnBlcnNpc3RlbmNlU3RvcmUpLmdldCh0YWcpO1xuICB9XG4gIC8vIFRoZXNlIHR3byBjYW4gYmUgdHJpZ2dlcmVkIGJ5IGNsaWVudCBjb2RlIG9yIGJ5IGFueSBzZXJ2aWNlLlxuICBhc3luYyBwdXQodGFnLCBzaWduYXR1cmUsIHN5bmNocm9uaXplciA9IG51bGwsIG1lcmdlQXV0aG9yT3ZlcnJpZGUgPSBudWxsLCBpZkV4aXN0cyA9ICd0YWcnKSB7IC8vIFB1dCB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIC8vIDEuIHZhbGlkYXRlRm9yV3JpdGluZ1xuICAgIC8vIDIuIG1lcmdlU2lnbmF0dXJlcyBhZ2FpbnN0IGFueSBleGlzdGluZywgcGlja2luZyBzb21lIGNvbWJpbmF0aW9uIG9mIGV4aXN0aW5nIGFuZCBuZXh0LlxuICAgIC8vIDMuIHBlcnNpc3QgdGhlIHJlc3VsdFxuICAgIC8vIDQuIHJldHVybiB0YWdcbiAgICAvL1xuICAgIC8vIG1lcmdlU2lnbmF0dXJlcygpIE1BWSBjcmVhdGUgbmV3IG5ldyByZXN1bHRzIHRvIHNhdmUsIHRoYXQgc3RpbGwgaGF2ZSB0byBiZSBzaWduZWQuIEZvciB0ZXN0aW5nLCB3ZSBzb21ldGltZXNcbiAgICAvLyB3YW50IHRvIGJlaGF2ZSBhcyBpZiBzb21lIG93bmVyIGNyZWRlbnRpYWwgZG9lcyBub3QgZXhpc3Qgb24gdGhlIG1hY2hpbmUuIFRoYXQncyB3aGF0IG1lcmdlQXV0aG9yT3ZlcnJpZGUgaXMgZm9yLlxuXG4gICAgLy8gVE9ETzogZG8gd2UgbmVlZCB0byBxdWV1ZSB0aGVzZT8gU3VwcG9zZSB3ZSBhcmUgdmFsaWRhdGluZyBvciBtZXJnaW5nIHdoaWxlIG90aGVyIHJlcXVlc3QgYXJyaXZlP1xuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3N0b3JlJywgc3luY2hyb25pemVyLCBmYWxzZSwgaWZFeGlzdHMpO1xuICAgIHRoaXMubG9nKCdwdXQnLCB7dGFnOiB2YWxpZGF0aW9uPy50YWcgfHwgdGFnLCBzeW5jaHJvbml6ZXI6IHN5bmNocm9uaXplcj8ubGFiZWwsIGpzb246IHZhbGlkYXRpb24/Lmpzb259KTtcblxuICAgIGlmICghdmFsaWRhdGlvbikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBpZiAoIXZhbGlkYXRpb24uc2lnbmF0dXJlKSByZXR1cm4gdmFsaWRhdGlvbi50YWc7IC8vIE5vIGZ1cnRoZXIgYWN0aW9uIGJ1dCBhbnN3ZXIgdGFnLiBFLmcuLCB3aGVuIGlnbm9yaW5nIG5ldyBkYXRhLlxuICAgIGF3YWl0IHRoaXMuYWRkVGFnKHZhbGlkYXRpb24udGFnKTtcblxuICAgIC8vIGZpeG1lIG5leHRcbiAgICBjb25zdCBtZXJnZWQgPSBhd2FpdCB0aGlzLm1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSwgbWVyZ2VBdXRob3JPdmVycmlkZSk7XG4gICAgYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBtZXJnZWQpO1xuICAgIC8vY29uc3QgbWVyZ2VkMiA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmFsaWRhdGlvbkZvcm1hdChtZXJnZWQsIHRhZyk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIG1lcmdlZCk7XG4gICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QyKG1lcmdlZDIpO1xuICAgIC8vIGNvbnN0IG1lcmdlZCA9IGF3YWl0IHRoaXMubWVyZ2VWYWxpZGF0aW9uKHZhbGlkYXRpb24sIG1lcmdlQXV0aG9yT3ZlcnJpZGUpO1xuICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIobWVyZ2VkKTtcblxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5wdXQuXG4gIH1cbiAgYXN5bmMgZGVsZXRlKHRhZywgc2lnbmF0dXJlLCBzeW5jaHJvbml6ZXIgPSBudWxsKSB7IC8vIFJlbW92ZSB0aGUgcmF3IHNpZ25hdHVyZSBsb2NhbGx5IGFuZCBvbiB0aGUgc3BlY2lmaWVkIHNlcnZpY2VzLlxuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgJ3JlbW92ZScsIHN5bmNocm9uaXplciwgJ3JlcXVpcmVUYWcnKTtcbiAgICB0aGlzLmxvZygnZGVsZXRlJywgdGFnLCBzeW5jaHJvbml6ZXI/LmxhYmVsLCAndmFsaWRhdGVkIHRhZzonLCB2YWxpZGF0aW9uPy50YWcsICdwcmVzZXJ2ZURlbGV0aW9uczonLCB0aGlzLnByZXNlcnZlRGVsZXRpb25zKTtcbiAgICBpZiAoIXZhbGlkYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICBpZiAodGhpcy5wcmVzZXJ2ZURlbGV0aW9ucykgeyAvLyBTaWduYXR1cmUgcGF5bG9hZCBpcyBlbXB0eS5cbiAgICAgIC8vIEZJWE1FIG5leHRcbiAgICAgIC8vYXdhaXQgdGhpcy5wZXJzaXN0KHZhbGlkYXRpb24udGFnLCBzaWduYXR1cmUpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uKTtcbiAgICB9IGVsc2UgeyAvLyBSZWFsbHkgZGVsZXRlLlxuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgLy9hd2FpdCB0aGlzLnBlcnNpc3QodmFsaWRhdGlvbi50YWcsIHNpZ25hdHVyZSwgJ2RlbGV0ZScpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0Mih2YWxpZGF0aW9uLCAnZGVsZXRlJyk7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZGF0aW9uLnRhZzsgLy8gRG9uJ3QgcmVseSBvbiB0aGUgcmV0dXJuZWQgdmFsdWUgb2YgcGVyc2lzdGVuY2VTdG9yZS5kZWxldGUuXG4gIH1cblxuICBub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsIG1lc3NhZ2UgPSB1bmRlZmluZWQsIHZhbGlkYXRlZCA9ICcnLCBzaWduYXR1cmUpIHtcbiAgICAvLyBMYXRlciBvbiwgd2Ugd2lsbCBub3Qgd2FudCB0byBnaXZlIG91dCBzbyBtdWNoIGluZm8uLi5cbiAgICAvL2lmICh0aGlzLmRlYnVnKSB7XG4gICAgY29uc29sZS53YXJuKHRoaXMuZnVsbExhYmVsLCBvcGVyYXRpb25MYWJlbCwgbWVzc2FnZSwgdGFnKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy8gIGNvbnNvbGUud2Fybih0aGlzLmZ1bGxMYWJlbCwgYFNpZ25hdHVyZSBpcyBub3QgdmFsaWQgdG8gJHtvcGVyYXRpb25MYWJlbH0gJHt0YWcgfHwgJ2RhdGEnfS5gKTtcbiAgICAvL31cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGFzeW5jIGRpc2FsbG93V3JpdGUodGFnLCBleGlzdGluZywgcHJvcG9zZWQsIHZlcmlmaWVkLCBpZkV4aXN0cyA9ICd0YWcnKSB7IC8vIFJldHVybiBhIHJlYXNvbiBzdHJpbmcgd2h5IHRoZSBwcm9wb3NlZCB2ZXJpZmllZCBwcm90ZWN0ZWRIZWFkZXJcbiAgICAvLyBzaG91bGQgbm90IGJlIGFsbG93ZWQgdG8gb3ZlcnJ3cml0ZSB0aGUgKHBvc3NpYmx5IG51bGxpc2gpIGV4aXN0aW5nIHZlcmlmaWVkIHByb3RlY3RlZEhlYWRlcixcbiAgICAvLyBlbHNlIGZhbHN5IGlmIGFsbG93ZWQuXG4gICAgaWYgKCFwcm9wb3NlZCkgcmV0dXJuICdpbnZhbGlkIHNpZ25hdHVyZSc7XG4gICAgaWYgKCFleGlzdGluZykgcmV0dXJuIG51bGw7XG4gICAgaWYgKHByb3Bvc2VkLmlhdCA8IGV4aXN0aW5nLmlhdCkgcmV0dXJuICdiYWNrZGF0ZWQnO1xuICAgIGlmICghdGhpcy5vd25lck1hdGNoKGV4aXN0aW5nLCBwcm9wb3NlZCkpIHJldHVybiAnbm90IG93bmVyJztcbiAgICBpZiAoIWF3YWl0IHRoaXMuc3ViamVjdE1hdGNoKHZlcmlmaWVkKSkgcmV0dXJuICd3cm9uZyBoYXNoJztcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBhc3luYyBzdWJqZWN0TWF0Y2godmVyaWZpZWQpIHsgLy8gUHJvbWlzZXMgdHJ1ZSBJRkYgY2xhaW1lZCAnc3ViJyBtYXRjaGVzIGhhc2ggb2YgdGhlIGNvbnRlbnRzLlxuICAgIHJldHVybiB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViID09PSBhd2FpdCBDcmVkZW50aWFscy5lbmNvZGVCYXNlNjR1cmwoYXdhaXQgQ3JlZGVudGlhbHMuaGFzaEJ1ZmZlcih2ZXJpZmllZC5wYXlsb2FkKSk7XG4gIH1cbiAgb3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpIHsvLyBEb2VzIHByb3Bvc2VkIG93bmVyIG1hdGNoIHRoZSBleGlzdGluZz9cbiAgICBjb25zdCBleGlzdGluZ093bmVyID0gZXhpc3Rpbmc/LmlzcyB8fCBleGlzdGluZz8ua2lkO1xuICAgIGNvbnN0IHByb3Bvc2VkT3duZXIgPSBwcm9wb3NlZC5pc3MgfHwgcHJvcG9zZWQua2lkO1xuICAgIC8vIEV4YWN0IG1hdGNoLiBEbyB3ZSBuZWVkIHRvIGFsbG93IGZvciBhbiBvd25lciB0byB0cmFuc2ZlciBvd25lcnNoaXAgdG8gYSBzdWIvc3VwZXIvZGlzam9pbnQgdGVhbT9cbiAgICAvLyBDdXJyZW50bHksIHRoYXQgd291bGQgcmVxdWlyZSBhIG5ldyByZWNvcmQuIChFLmcuLCB0d28gTXV0YWJsZS9WZXJzaW9uZWRDb2xsZWN0aW9uIGl0ZW1zIHRoYXRcbiAgICAvLyBoYXZlIHRoZSBzYW1lIEdVSUQgcGF5bG9hZCBwcm9wZXJ0eSwgYnV0IGRpZmZlcmVudCB0YWdzLiBJLmUuLCBhIGRpZmZlcmVudCBvd25lciBtZWFucyBhIGRpZmZlcmVudCB0YWcuKVxuICAgIGlmIChwcm9wb3NlZE93bmVyID09PSBleGlzdGluZ093bmVyKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAocHJvcG9zZWQubXQpIHJldHVybiB0cnVlOyAvLyBGSVhNRTogRGVmZXIgdG8gc3ViY2xhc3NlcyB0aGF0IGV4YW1pbmUgbW9yZSBjbG9zZWx5LlxuICAgICAgLy8gV2UgYXJlIG5vdCBjaGVja2luZyB0byBzZWUgaWYgYXV0aG9yIGlzIGN1cnJlbnRseSBhIG1lbWJlciBvZiB0aGUgb3duZXIgdGVhbSBoZXJlLCB3aGljaFxuICAgICAgLy8gaXMgY2FsbGVkIGJ5IHB1dCgpL2RlbGV0ZSgpIGluIHR3byBjaXJjdW1zdGFuY2VzOlxuXG4gICAgICAvLyB0aGlzLnZhbGlkYXRlRm9yV3JpdGluZygpIGlzIGNhbGxlZCBieSBwdXQoKS9kZWxldGUoKSB3aGljaCBoYXBwZW5zIGluIHRoZSBhcHAgKHZpYSBzdG9yZSgpL3JlbW92ZSgpKVxuICAgICAgLy8gYW5kIGR1cmluZyBzeW5jIGZyb20gYW5vdGhlciBzZXJ2aWNlOlxuXG4gICAgICAvLyAxLiBGcm9tIHRoZSBhcHAgKHZhaWEgc3RvcmUoKS9yZW1vdmUoKSwgd2hlcmUgd2UgaGF2ZSBqdXN0IGNyZWF0ZWQgdGhlIHNpZ25hdHVyZS4gU2lnbmluZyBpdHNlbGZcbiAgICAgIC8vIHdpbGwgZmFpbCBpZiB0aGUgKDEtaG91ciBjYWNoZWQpIGtleSBpcyBubyBsb25nZXIgYSBtZW1iZXIgb2YgdGhlIHRlYW0uIFRoZXJlIGlzIG5vIGludGVyZmFjZVxuICAgICAgLy8gZm9yIHRoZSBhcHAgdG8gcHJvdmlkZSBhbiBvbGQgc2lnbmF0dXJlLiAoVE9ETzogYWZ0ZXIgd2UgbWFrZSBnZXQvcHV0L2RlbGV0ZSBpbnRlcm5hbC4pXG5cbiAgICAgIC8vIDIuIER1cmluZyBzeW5jIGZyb20gYW5vdGhlciBzZXJ2aWNlLCB3aGVyZSB3ZSBhcmUgcHVsbGluZyBpbiBvbGQgcmVjb3JkcyBmb3Igd2hpY2ggd2UgZG9uJ3QgaGF2ZVxuICAgICAgLy8gdGVhbSBtZW1iZXJzaGlwIGZyb20gdGhhdCB0aW1lLlxuXG4gICAgICAvLyBJZiB0aGUgYXBwIGNhcmVzIHdoZXRoZXIgdGhlIGF1dGhvciBoYXMgYmVlbiBraWNrZWQgZnJvbSB0aGUgdGVhbSwgdGhlIGFwcCBpdHNlbGYgd2lsbCBoYXZlIHRvIGNoZWNrLlxuICAgICAgLy8gVE9ETzogd2Ugc2hvdWxkIHByb3ZpZGUgYSB0b29sIGZvciB0aGF0LlxuXG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGFudGVjZWRlbnQodmVyaWZpZWQpIHsgLy8gV2hhdCB0YWcgc2hvdWxkIHRoZSB2ZXJpZmllZCBzaWduYXR1cmUgYmUgY29tcGFyZWQgYWdhaW5zdCBmb3Igd3JpdGluZz9cbiAgICByZXR1cm4gdmVyaWZpZWQudGFnO1xuICB9XG4gIHN5bmNocm9uaXplQW50ZWNlZGVudCh0YWcsIGFudGVjZWRlbnQpIHsgLy8gU2hvdWxkIHRoZSBhbnRlY2VkZW50IHRyeSBzeW5jaHJvbml6aW5nIGJlZm9yZSBnZXR0aW5nIGl0P1xuICAgIHJldHVybiB0YWcgIT09IGFudGVjZWRlbnQ7IC8vIEZhbHNlIHdoZW4gdGhleSBhcmUgdGhlIHNhbWUgdGFnLCBhcyB0aGF0IHdvdWxkIGJlIGNpcmN1bGFyLiBWZXJzaW9ucyBkbyBzeW5jLlxuICB9XG4gIHRhZ0ZvcldyaXRpbmcodGFnLCB2YWxpZGF0aW9uKSB7IC8vIFVzZSB0YWcgaWYgc3BlY2lmaWVkLCBidXQgZGVmYXVsdHMgdG8gaGFzaC5cbiAgICAvLyBTdWJ0bGU6IEZvciBJbW11dGFibGVDb2xsZWN0aW9uLCB3ZSB3aWxsIHZlcmlmeSB0aGF0IGFueSBzcGVjaWZpZWQgdGFnIG1hdGNoZXMuIEhvd2V2ZXIsIHdlIGNhbm5vdCBqdXN0XG4gICAgLy8gdXNlIC5zdWIgaW4gYSBtZXRob2QgZm9yIEltbXV0YWJsZUNvbGxlY3Rpb24sIGJlY2F1c2UgdGhlbiBpdCB3b3VsZCBub3Qgc2VlIGV4aXN0aW5nIHVuZGVyIHRoZSB0YWcgYmVpbmcgd3JpdHRlbiB0by5cbiAgICByZXR1cm4gdGFnIHx8IHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLnN1YjtcbiAgfVxuXG4gIGFzeW5jIHZhbGlkYXRlRm9yV3JpdGluZyh0YWcsIHNpZ25hdHVyZSwgb3BlcmF0aW9uTGFiZWwsIHN5bmNocm9uaXplciwgcmVxdWlyZVRhZyA9IGZhbHNlLCBpZkV4aXN0cyA9ICd0YWcnKSB7IC8vIFRPRE86IE9wdGlvbmFscyBzaG91bGQgYmUga2V5d29yZC5cbiAgICAvLyBBIGRlZXAgdmVyaWZ5IHRoYXQgY2hlY2tzIGFnYWluc3QgdGhlIGV4aXN0aW5nIGl0ZW0ncyAocmUtKXZlcmlmaWVkIGhlYWRlcnMuXG4gICAgLy8gSWYgaXQgc3VjY2VlZHMsIHRoaXMgaXMgYWxzbyB0aGUgY29tbW9uIGNvZGUgKGJldHdlZW4gcHV0L2RlbGV0ZSkgdGhhdCBlbWl0cyB0aGUgdXBkYXRlIGV2ZW50LlxuICAgIC8vXG4gICAgLy8gSG93LCBpZiBhIGFsbCwgZG8gd2UgY2hlY2sgdGhhdCBhY3QgaXMgYSBtZW1iZXIgb2YgaXNzP1xuICAgIC8vIENvbnNpZGVyIGFuIGl0ZW0gb3duZWQgYnkgaXNzLlxuICAgIC8vIFRoZSBpdGVtIGlzIHN0b3JlZCBhbmQgc3luY2hyb25pemVkIGJ5IGFjdCBBIGF0IHRpbWUgdDEuXG4gICAgLy8gSG93ZXZlciwgYXQgYW4gZWFybGllciB0aW1lIHQwLCBhY3QgQiB3YXMgY3V0IG9mZiBmcm9tIHRoZSByZWxheSBhbmQgc3RvcmVkIHRoZSBpdGVtLlxuICAgIC8vIFdoZW4gbWVyZ2luZywgd2Ugd2FudCBhY3QgQidzIHQwIHRvIGJlIHRoZSBlYXJsaWVyIHJlY29yZCwgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIEIgaXMgc3RpbGwgYSBtZW1iZXIgYXQgdGltZSBvZiBzeW5jaHJvbml6YXRpb24uXG4gICAgLy8gVW5sZXNzL3VudGlsIHdlIGhhdmUgdmVyc2lvbmVkIGtleXNldHMsIHdlIGNhbm5vdCBlbmZvcmNlIGEgbWVtYmVyc2hpcCBjaGVjayAtLSB1bmxlc3MgdGhlIGFwcGxpY2F0aW9uIGl0c2VsZiB3YW50cyB0byBkbyBzby5cbiAgICAvLyBBIGNvbnNlcXVlbmNlLCB0aG91Z2gsIGlzIHRoYXQgYSBodW1hbiB3aG8gaXMgYSBtZW1iZXIgb2YgaXNzIGNhbiBnZXQgYXdheSB3aXRoIHN0b3JpbmcgdGhlIGRhdGEgYXMgc29tZVxuICAgIC8vIG90aGVyIHVucmVsYXRlZCBwZXJzb25hLiBUaGlzIG1heSBtYWtlIGl0IGhhcmQgZm9yIHRoZSBncm91cCB0byBob2xkIHRoYXQgaHVtYW4gcmVzcG9uc2libGUuXG4gICAgLy8gT2YgY291cnNlLCB0aGF0J3MgYWxzbyB0cnVlIGlmIHdlIHZlcmlmaWVkIG1lbWJlcnMgYXQgYWxsIHRpbWVzLCBhbmQgaGFkIGJhZCBjb250ZW50IGxlZ2l0aW1hdGVseSBjcmVhdGVkIGJ5IHNvbWVvbmUgd2hvIGdvdCBraWNrZWQgbGF0ZXIuXG5cbiAgICBjb25zdCB2YWxpZGF0aW9uT3B0aW9ucyA9IHttZW1iZXI6IG51bGx9OyAvLyBDb3VsZCBiZSBvbGQgZGF0YSB3cml0dGVuIGJ5IHNvbWVvbmUgd2hvIGlzIG5vIGxvbmdlciBhIG1lbWJlci4gU2VlIG93bmVyTWF0Y2guXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmeShzaWduYXR1cmUsIHZhbGlkYXRpb25PcHRpb25zKTtcbiAgICBpZiAoIXZlcmlmaWVkKSByZXR1cm4gdGhpcy5ub3RpZnlJbnZhbGlkKHRhZywgb3BlcmF0aW9uTGFiZWwsICdpbnZhbGlkJywgdmVyaWZpZWQsIHNpZ25hdHVyZSk7XG4gICAgdmVyaWZpZWQuc3luY2hyb25pemVyID0gc3luY2hyb25pemVyO1xuICAgIHRhZyA9IHZlcmlmaWVkLnRhZyA9IHZlcmlmaWVkLnN1YmplY3RUYWcgPSByZXF1aXJlVGFnID8gdGFnIDogYXdhaXQgdGhpcy50YWdGb3JXcml0aW5nKHRhZywgdmVyaWZpZWQpO1xuICAgIGNvbnN0IGFudGVjZWRlbnQgPSB0aGlzLmFudGVjZWRlbnQodmVyaWZpZWQpO1xuICAgIGNvbnN0IHN5bmNocm9uaXplID0gdGhpcy5zeW5jaHJvbml6ZUFudGVjZWRlbnQodGFnLCBhbnRlY2VkZW50KTtcbiAgICBjb25zdCBleGlzdGluZ1ZlcmlmaWVkID0gdmVyaWZpZWQuZXhpc3RpbmcgPSBhbnRlY2VkZW50ICYmIGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZzogYW50ZWNlZGVudCwgc3luY2hyb25pemUsIC4uLnZhbGlkYXRpb25PcHRpb25zfSk7XG4gICAgY29uc3QgZGlzYWxsb3dlZCA9IGF3YWl0IHRoaXMuZGlzYWxsb3dXcml0ZSh0YWcsIGV4aXN0aW5nVmVyaWZpZWQ/LnByb3RlY3RlZEhlYWRlciwgdmVyaWZpZWQ/LnByb3RlY3RlZEhlYWRlciwgdmVyaWZpZWQsIGlmRXhpc3RzKTtcbiAgICBpZiAoZGlzYWxsb3dlZCkgcmV0dXJuIHRoaXMubm90aWZ5SW52YWxpZCh0YWcsIG9wZXJhdGlvbkxhYmVsLCBkaXNhbGxvd2VkLCB2ZXJpZmllZCk7XG4gICAgaWYgKGRpc2FsbG93ZWQgPT09ICcnKSB7XG4gICAgICB2ZXJpZmllZC5zaWduYXR1cmUgPSBudWxsO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZygnZW1pdCcsIHRhZywgdmVyaWZpZWQuanNvbik7XG4gICAgICB0aGlzLmVtaXQodmVyaWZpZWQpO1xuICAgIH1cbiAgICByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cbiAgLy8gZml4bWUgbmV4dCAyXG4gIG1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSkgeyAvLyBSZXR1cm4gYSBzdHJpbmcgdG8gYmUgcGVyc2lzdGVkLiBVc3VhbGx5IGp1c3QgdGhlIHNpZ25hdHVyZS5cbiAgICByZXR1cm4gc2lnbmF0dXJlOyAgLy8gdmFsaWRhdGlvbi5zdHJpbmcgbWlnaHQgYmUgYW4gb2JqZWN0LlxuICB9XG4gIGFzeW5jIHBlcnNpc3QodGFnLCBzaWduYXR1cmVTdHJpbmcsIG9wZXJhdGlvbiA9ICdwdXQnKSB7IC8vIENvbmR1Y3QgdGhlIHNwZWNpZmllZCB0YWcvc2lnbmF0dXJlIG9wZXJhdGlvbiBvbiB0aGUgcGVyc2lzdGVudCBzdG9yZS5cbiAgICByZXR1cm4gKGF3YWl0IHRoaXMucGVyc2lzdGVuY2VTdG9yZSlbb3BlcmF0aW9uXSh0YWcsIHNpZ25hdHVyZVN0cmluZyk7XG4gIH1cbiAgbWVyZ2VWYWxpZGF0aW9uKHZhbGlkYXRpb24pIHsgLy8gUmV0dXJuIGEgc3RyaW5nIHRvIGJlIHBlcnNpc3RlZC4gVXN1YWxseSBqdXN0IHRoZSBzaWduYXR1cmUuXG4gICAgcmV0dXJuIHZhbGlkYXRpb247XG4gIH1cbiAgYXN5bmMgcGVyc2lzdDIodmFsaWRhdGlvbiwgb3BlcmF0aW9uID0gJ3B1dCcpIHsgLy8gQ29uZHVjdCB0aGUgc3BlY2lmaWVkIHRhZy9zaWduYXR1cmUgb3BlcmF0aW9uIG9uIHRoZSBwZXJzaXN0ZW50IHN0b3JlLiBSZXR1cm4gdGFnXG4gICAgY29uc3Qge3RhZywgc2lnbmF0dXJlfSA9IHZhbGlkYXRpb247XG4gICAgY29uc3Qgc2lnbmF0dXJlU3RyaW5nID0gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgICBjb25zdCBzdG9yYWdlID0gYXdhaXQgdGhpcy5wZXJzaXN0ZW5jZVN0b3JlO1xuICAgIGF3YWl0IHN0b3JhZ2Vbb3BlcmF0aW9uXSh0YWcsIHNpZ25hdHVyZVN0cmluZyk7XG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBlbWl0KHZlcmlmaWVkKSB7IC8vIERpc3BhdGNoIHRoZSB1cGRhdGUgZXZlbnQuXG4gICAgdGhpcy5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudCgndXBkYXRlJywge2RldGFpbDogdmVyaWZpZWR9KSk7XG4gIH1cbiAgZ2V0IGl0ZW1FbWl0dGVyKCkgeyAvLyBBbnN3ZXJzIHRoZSBDb2xsZWN0aW9uIHRoYXQgZW1pdHMgaW5kaXZpZHVhbCB1cGRhdGVzLiAoU2VlIG92ZXJyaWRlIGluIFZlcnNpb25lZENvbGxlY3Rpb24uKVxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgc3luY2hyb25pemVycyA9IG5ldyBNYXAoKTsgLy8gc2VydmljZUluZm8gbWlnaHQgbm90IGJlIGEgc3RyaW5nLlxuICBtYXBTeW5jaHJvbml6ZXJzKGYpIHsgLy8gT24gU2FmYXJpLCBNYXAudmFsdWVzKCkubWFwIGlzIG5vdCBhIGZ1bmN0aW9uIVxuICAgIGNvbnN0IHJlc3VsdHMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IHN5bmNocm9uaXplciBvZiB0aGlzLnN5bmNocm9uaXplcnMudmFsdWVzKCkpIHtcbiAgICAgIHJlc3VsdHMucHVzaChmKHN5bmNocm9uaXplcikpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfVxuICBnZXQgc2VydmljZXMoKSB7XG4gICAgcmV0dXJuIEFycmF5LmZyb20odGhpcy5zeW5jaHJvbml6ZXJzLmtleXMoKSk7XG4gIH1cbiAgLy8gVE9ETzogcmVuYW1lIHRoaXMgdG8gY29ubmVjdCwgYW5kIGRlZmluZSBzeW5jaHJvbml6ZSB0byBhd2FpdCBjb25uZWN0LCBzeW5jaHJvbml6YXRpb25Db21wbGV0ZSwgZGlzY29ubm5lY3QuXG4gIGFzeW5jIHN5bmNocm9uaXplKC4uLnNlcnZpY2VzKSB7IC8vIFN0YXJ0IHJ1bm5pbmcgdGhlIHNwZWNpZmllZCBzZXJ2aWNlcyAoaW4gYWRkaXRpb24gdG8gd2hhdGV2ZXIgaXMgYWxyZWFkeSBydW5uaW5nKS5cbiAgICBjb25zdCB7c3luY2hyb25pemVyc30gPSB0aGlzO1xuICAgIGZvciAobGV0IHNlcnZpY2Ugb2Ygc2VydmljZXMpIHtcbiAgICAgIGlmIChzeW5jaHJvbml6ZXJzLmhhcyhzZXJ2aWNlKSkgY29udGludWU7XG4gICAgICBhd2FpdCBTeW5jaHJvbml6ZXIuY3JlYXRlKHRoaXMsIHNlcnZpY2UpOyAvLyBSZWFjaGVzIGludG8gb3VyIHN5bmNocm9uaXplcnMgbWFwIGFuZCBzZXRzIGl0c2VsZiBpbW1lZGlhdGVseS5cbiAgICB9XG4gIH1cbiAgZ2V0IHN5bmNocm9uaXplZCgpIHsgLy8gcHJvbWlzZSB0byByZXNvbHZlIHdoZW4gc3luY2hyb25pemF0aW9uIGlzIGNvbXBsZXRlIGluIEJPVEggZGlyZWN0aW9ucy5cbiAgICAvLyBUT0RPPyBUaGlzIGRvZXMgbm90IHJlZmxlY3QgY2hhbmdlcyBhcyBTeW5jaHJvbml6ZXJzIGFyZSBhZGRlZCBvciByZW1vdmVkIHNpbmNlIGNhbGxlZC4gU2hvdWxkIGl0P1xuICAgIHJldHVybiBQcm9taXNlLmFsbCh0aGlzLm1hcFN5bmNocm9uaXplcnMocyA9PiBzLmJvdGhTaWRlc0NvbXBsZXRlZFN5bmNocm9uaXphdGlvbikpO1xuICB9XG4gIGFzeW5jIGRpc2Nvbm5lY3QoLi4uc2VydmljZXMpIHsgLy8gU2h1dCBkb3duIHRoZSBzcGVjaWZpZWQgc2VydmljZXMuXG4gICAgaWYgKCFzZXJ2aWNlcy5sZW5ndGgpIHNlcnZpY2VzID0gdGhpcy5zZXJ2aWNlcztcbiAgICBjb25zdCB7c3luY2hyb25pemVyc30gPSB0aGlzO1xuICAgIGZvciAobGV0IHNlcnZpY2Ugb2Ygc2VydmljZXMpIHtcbiAgICAgIGNvbnN0IHN5bmNocm9uaXplciA9IHN5bmNocm9uaXplcnMuZ2V0KHNlcnZpY2UpO1xuICAgICAgaWYgKCFzeW5jaHJvbml6ZXIpIHtcblx0Ly9jb25zb2xlLndhcm4oYCR7dGhpcy5mdWxsTGFiZWx9IGRvZXMgbm90IGhhdmUgYSBzZXJ2aWNlIG5hbWVkICcke3NlcnZpY2V9JyB0byBkaXNjb25uZWN0LmApO1xuXHRjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHN5bmNocm9uaXplci5kaXNjb25uZWN0KCk7XG4gICAgfVxuICB9XG4gIGFzeW5jIGVuc3VyZVN5bmNocm9uaXplcihzZXJ2aWNlTmFtZSwgY29ubmVjdGlvbiwgZGF0YUNoYW5uZWwpIHsgLy8gTWFrZSBzdXJlIGRhdGFDaGFubmVsIG1hdGNoZXMgdGhlIHN5bmNocm9uaXplciwgY3JlYXRpbmcgU3luY2hyb25pemVyIG9ubHkgaWYgbWlzc2luZy5cbiAgICBsZXQgc3luY2hyb25pemVyID0gdGhpcy5zeW5jaHJvbml6ZXJzLmdldChzZXJ2aWNlTmFtZSk7XG4gICAgaWYgKCFzeW5jaHJvbml6ZXIpIHtcbiAgICAgIHN5bmNocm9uaXplciA9IG5ldyBTeW5jaHJvbml6ZXIoe3NlcnZpY2VOYW1lLCBjb2xsZWN0aW9uOiB0aGlzLCBkZWJ1ZzogdGhpcy5kZWJ1Z30pO1xuICAgICAgc3luY2hyb25pemVyLmNvbm5lY3Rpb24gPSBjb25uZWN0aW9uO1xuICAgICAgc3luY2hyb25pemVyLmRhdGFDaGFubmVsUHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZShkYXRhQ2hhbm5lbCk7XG4gICAgICB0aGlzLnN5bmNocm9uaXplcnMuc2V0KHNlcnZpY2VOYW1lLCBzeW5jaHJvbml6ZXIpO1xuICAgICAgLy8gRG9lcyBOT1Qgc3RhcnQgc3luY2hyb25pemluZy4gQ2FsbGVyIG11c3QgZG8gdGhhdCBpZiBkZXNpcmVkLiAoUm91dGVyIGRvZXNuJ3QgbmVlZCB0by4pXG4gICAgfSBlbHNlIGlmICgoc3luY2hyb25pemVyLmNvbm5lY3Rpb24gIT09IGNvbm5lY3Rpb24pIHx8XG5cdCAgICAgICAoc3luY2hyb25pemVyLmNoYW5uZWxOYW1lICE9PSBkYXRhQ2hhbm5lbC5sYWJlbCkgfHxcblx0ICAgICAgIChhd2FpdCBzeW5jaHJvbml6ZXIuZGF0YUNoYW5uZWxQcm9taXNlICE9PSBkYXRhQ2hhbm5lbCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5tYXRjaGVkIGNvbm5lY3Rpb24gZm9yICR7c2VydmljZU5hbWV9LmApO1xuICAgIH1cbiAgICByZXR1cm4gc3luY2hyb25pemVyO1xuICB9XG5cbiAgcHJvbWlzZShrZXksIHRodW5rKSB7IHJldHVybiB0aHVuazsgfSAvLyBUT0RPOiBob3cgd2lsbCB3ZSBrZWVwIHRyYWNrIG9mIG92ZXJsYXBwaW5nIGRpc3RpbmN0IHN5bmNzP1xuICBzeW5jaHJvbml6ZTEodGFnKSB7IC8vIENvbXBhcmUgYWdhaW5zdCBhbnkgcmVtYWluaW5nIHVuc3luY2hyb25pemVkIGRhdGEsIGZldGNoIHdoYXQncyBuZWVkZWQsIGFuZCByZXNvbHZlIGxvY2FsbHkuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHRoaXMubWFwU3luY2hyb25pemVycyhzeW5jaHJvbml6ZXIgPT4gc3luY2hyb25pemVyLnN5bmNocm9uaXphdGlvblByb21pc2UodGFnKSkpO1xuICB9XG4gIGFzeW5jIHN5bmNocm9uaXplVGFncygpIHsgLy8gRW5zdXJlIHRoYXQgd2UgaGF2ZSB1cCB0byBkYXRlIHRhZyBtYXAgYW1vbmcgYWxsIHNlcnZpY2VzLiAoV2UgZG9uJ3QgY2FyZSB5ZXQgb2YgdGhlIHZhbHVlcyBhcmUgc3luY2hyb25pemVkLilcbiAgICByZXR1cm4gdGhpcy5wcm9taXNlKCd0YWdzJywgKCkgPT4gUHJvbWlzZS5yZXNvbHZlKCkpOyAvLyBUT0RPXG4gIH1cbiAgYXN5bmMgc3luY2hyb25pemVEYXRhKCkgeyAvLyBNYWtlIHRoZSBkYXRhIHRvIG1hdGNoIG91ciB0YWdtYXAsIHVzaW5nIHN5bmNocm9uaXplMS5cbiAgICByZXR1cm4gdGhpcy5wcm9taXNlKCdkYXRhJywgKCkgPT4gUHJvbWlzZS5yZXNvbHZlKCkpOyAvLyBUT0RPXG4gIH1cbiAgc2V0IG9udXBkYXRlKGhhbmRsZXIpIHsgLy8gQWxsb3cgc2V0dGluZyBpbiBsaWV1IG9mIGFkZEV2ZW50TGlzdGVuZXIuXG4gICAgaWYgKGhhbmRsZXIpIHtcbiAgICAgIHRoaXMuX3VwZGF0ZSA9IGhhbmRsZXI7XG4gICAgICB0aGlzLmFkZEV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIGhhbmRsZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIHRoaXMuX3VwZGF0ZSk7XG4gICAgICB0aGlzLl91cGRhdGUgPSBoYW5kbGVyO1xuICAgIH1cbiAgfVxuICBnZXQgb251cGRhdGUoKSB7IC8vIEFzIHNldCBieSB0aGlzLm9udXBkYXRlID0gaGFuZGxlci4gRG9lcyBOT1QgYW5zd2VyIHRoYXQgd2hpY2ggaXMgc2V0IGJ5IGFkZEV2ZW50TGlzdGVuZXIuXG4gICAgcmV0dXJuIHRoaXMuX3VwZGF0ZTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgSW1tdXRhYmxlQ29sbGVjdGlvbiBleHRlbmRzIENvbGxlY3Rpb24ge1xuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCwgaWZFeGlzdHMgPSAndGFnJykgeyAvLyBPdmVycmlkZXMgc3VwZXIgd2l0aCBiZWhhdmlvciBjb250cm9sbGVkIGJ5IGlmRXhpc3RzLlxuICAgIC8vIFJldHVybmluZyBlbXB0eSBzdHJpbmcgcmF0aGVyIHRoYW4gbnVsbCBtZWFucyB0aGUgb3ZlcndyaXRlIHNob3VsZCBub3QgZ28gdGhyb3VnaCwgYnV0IG5vIGVycm9yIGVpdGhlci5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICBpZiAodmVyaWZpZWQudGV4dC5sZW5ndGggJiYgKHRhZyAhPT0gcHJvcG9zZWQuc3ViKSkgcmV0dXJuICd3cm9uZyB0YWcnO1xuICAgICAgaWYgKCFhd2FpdCB0aGlzLnN1YmplY3RNYXRjaCh2ZXJpZmllZCkpIHJldHVybiAnd3JvbmcgaGFzaCc7XG4gICAgICByZXR1cm4gbnVsbDsgLy8gRmlyc3Qgd3JpdGUgb2suXG4gICAgfVxuICAgIC8vIE5vIG93bmVyIG1hdGNoLiBOb3QgcmVsZXZhbnQgZm9yIGltbXV0YWJsZXMuXG4gICAgaWYgKGlmRXhpc3RzID09PSAncmVqZWN0JykgcmV0dXJuICdvdmVyd3JpdGUnO1xuICAgIGlmICh2ZXJpZmllZC50ZXh0Lmxlbmd0aCAmJiAoaWZFeGlzdHMgPT09ICd0YWcnKSAmJiAodGFnID09PSBleGlzdGluZy5zdWIpICYmXG5cdCgoZXhpc3RpbmcuaWF0ID09PSBwcm9wb3NlZC5pYXQpID8gKGV4aXN0aW5nLmFjdCA8IHByb3Bvc2VkLmFjdCkgOiAoZXhpc3RpbmcuaWF0IDwgcHJvcG9zZWQuaWF0KSkpIHJldHVybiAnJztcbiAgICBpZiAodmVyaWZpZWQudGV4dC5sZW5ndGggJiYgKHRhZyAhPT0gcHJvcG9zZWQuc3ViKSkgcmV0dXJuICd3cm9uZyB0YWcnO1xuICAgIC8vIExhdGVyIGlhdCBpcyBcImFsbG93ZWRcIiAoaS5lLiwgbm90IGFuIGVycm9yKSBidXQgbWVyZ2VTaWduYXR1cmVzIG1pZ2h0IHVzZSB0aGUgb2xkIHNpZ25hdHVyZXMuXG4gICAgLy8gU29tZSBleGFtcGxlczpcbiAgICAvLyAtIEEgZGVsZXRlIGlzIG9rLiAhdmVyaWZpZWQucGF5bG9hZC5sZW5ndGhcbiAgICAvLyAtIElmIHRoZSBjb250ZW50IGlzIGVuY3J5cHRlZCwgaXQgd2lsbCBoYXZlIGEgZGlmZmVyZW50IHN1YiAoaGFzaCkgYmVjYXVzZSBvZiB0aGUgaXYuXG4gICAgLy8gICBJZiB3ZSB3ZXJlIG5vdCB0b2xkIHdoYXQgdGFnIHRvIHVzZSwgaXQgd2lsbCBiZSBzYXZlZCB1bmRlciBhIGRpZmZlcmVudCB0YWcgYW5kIHRoZXJlJ3Mgbm8gY29uZmxpY3QuXG4gICAgLy8gICBPdGhlcndpc2UsIHRoZSBzdWIgd29uJ3QgbWF0Y2gsIGJ1dCB3ZSB3b24ndCBiZSB1c2luZyBpdCBhbnl3YXkuXG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgbWVyZ2VTaWduYXR1cmVzKHRhZywgdmFsaWRhdGlvbiwgc2lnbmF0dXJlKSB7IC8vIFJldHVybiBhIHN0cmluZyB0byBiZSBwZXJzaXN0ZWQuIFVzdWFsbHkganVzdCB0aGUgc2lnbmF0dXJlLlxuICAgIC8vIElmIHdlIGRpZG4ndCBmYWlsIGhhcmQgaW4gZGlzYWxsb3dXcml0ZSwgd2Ugbm9uZXRoZWxlc3Mgd2FudCB0aGUgZWFybGllciBvbmUuXG4gICAgaWYgKHZhbGlkYXRpb24uZXhpc3RpbmcgJiYgdmFsaWRhdGlvbi5leGlzdGluZy5wcm90ZWN0ZWRIZWFkZXIuaWF0IDwgdmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIuaWF0KSB7XG4gICAgICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5lbnN1cmVTdHJpbmcodmFsaWRhdGlvbi5leGlzdGluZy5zaWduYXR1cmUpO1xuICAgIH1cbiAgICByZXR1cm4gc2lnbmF0dXJlOyAgLy8gdmFsaWRhdGlvbi5zdHJpbmcgbWlnaHQgYmUgYW4gb2JqZWN0LlxuICB9XG59XG5leHBvcnQgY2xhc3MgTXV0YWJsZUNvbGxlY3Rpb24gZXh0ZW5kcyBDb2xsZWN0aW9uIHtcbn1cblxuLy8gRWFjaCBWZXJzaW9uZWRDb2xsZWN0aW9uIGhhcyBhIHNldCBvZiBoYXNoLWlkZW50aWZpZWQgaW1tdXRhYmxlIGl0ZW1zIHRoYXQgZm9ybSB0aGUgaW5kaXZpZHVhbCB2ZXJzaW9ucywgYW5kIGEgbWFwIG9mIHRpbWVzdGFtcHMgdG8gdGhvc2UgaXRlbXMuXG4vLyBXZSBjdXJyZW50bHkgbW9kZWwgdGhpcyBieSBoYXZpbmcgdGhlIG1haW4gY29sbGVjdGlvbiBiZSB0aGUgbXV0YWJsZSBtYXAsIGFuZCB0aGUgdmVyc2lvbnMgaW5zdGFuY2UgdmFyaWFibGUgaXMgdGhlIGltbXV0YWJsZSBpdGVtcyBjb2xsZWN0aW9uLlxuLy8gQnV0IGFwcHMgc3RvcmUvcmV0cmlldmUgaW5kaXZpZHVhbCBpdGVtcyB0aHJvdWdoIHRoZSBtYWluIGNvbGxlY3Rpb24sIGFuZCB0aGUgY29ycmVzcG9uZGluZyB1cGRhdGVzIGFyZSB0aHJvdWdoIHRoZSB2ZXJzaW9ucywgd2hpY2ggaXMgYSBiaXQgYXdrd2FyZC5cblxuLy8gRWFjaCBpdGVtIGhhcyBhbiBhbnRlY2VkZW50IHRoYXQgaXMgbm90IHBhcnQgb2YgdGhlIGFwcGxpY2F0aW9uLXN1cHBsaWVkIHBheWxvYWQgLS0gaXQgbGl2ZXMgaW4gdGhlIHNpZ25hdHVyZSdzIGhlYWRlci5cbi8vIEhvd2V2ZXI6XG4vLyAtIFRoZSB0YWcgRE9FUyBpbmNsdWRlIHRoZSBhbnRlY2VkZW50LCBldmVuIHRob3VnaCBpdCBpcyBub3QgcGFydCBvZiB0aGUgcGF5bG9hZC4gVGhpcyBtYWtlcyBpZGVudGljYWwgcGF5bG9hZHMgaGF2ZVxuLy8gICB1bmlxdWUgdGFncyAoYmVjYXVzZSB0aGV5IHdpbGwgYWx3YXlzIGhhdmUgZGlmZmVyZW50IGFudGVjZWRlbnRzKS5cbi8vIC0gVGhlIGFiaWxpdHkgdG8gd3JpdGUgZm9sbG93cyB0aGUgc2FtZSBydWxlcyBhcyBNdXRhYmxlQ29sbGVjdGlvbiAobGF0ZXN0IHdpbnMpLCBidXQgaXMgdGVzdGVkIGFnYWluc3QgdGhlXG4vLyAgIGFudGVjZWRlbnQgdGFnIGluc3RlYWQgb2YgdGhlIHRhZyBiZWluZyB3cml0dGVuLlxuZXhwb3J0IGNsYXNzIFZlcnNpb25Db2xsZWN0aW9uIGV4dGVuZHMgTXV0YWJsZUNvbGxlY3Rpb24geyAvLyBOZWVkcyB0byBiZSBleHBvcnRlZCBzbyB0aGF0IHRoYXQgcm91dGVyLm1qcyBjYW4gZmluZCBpdC5cbiAgYXN5bmMgdGFnRm9yV3JpdGluZyh0YWcsIHZhbGlkYXRpb24pIHsgLy8gVXNlIHRhZyBpZiBzcGVjaWZpZWQgKGUuZy4sIHB1dC9kZWxldGUgZHVyaW5nIHN5bmNocm9uaXphdGlvbiksIG90aHdlcndpc2UgcmVmbGVjdCBib3RoIHN1YiBhbmQgYW50ZWNlZGVudC5cbiAgICBpZiAodGFnKSByZXR1cm4gdGFnO1xuICAgIC8vIEVhY2ggdmVyc2lvbiBnZXRzIGEgdW5pcXVlIHRhZyAoZXZlbiBpZiB0aGVyZSBhcmUgdHdvIHZlcnNpb25zIHRoYXQgaGF2ZSB0aGUgc2FtZSBkYXRhIHBheWxvYWQpLlxuICAgIGNvbnN0IGFudCA9IHZhbGlkYXRpb24ucHJvdGVjdGVkSGVhZGVyLmFudDtcbiAgICBjb25zdCBwYXlsb2FkVGV4dCA9IHZhbGlkYXRpb24udGV4dCB8fCBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUodmFsaWRhdGlvbi5wYXlsb2FkKTtcbiAgICByZXR1cm4gQ3JlZGVudGlhbHMuZW5jb2RlQmFzZTY0dXJsKGF3YWl0IENyZWRlbnRpYWxzLmhhc2hUZXh0KGFudCArIHBheWxvYWRUZXh0KSk7XG4gIH1cbiAgYW50ZWNlZGVudCh2YWxpZGF0aW9uKSB7IC8vIFJldHVybnMgdGhlIHRhZyB0aGF0IHZhbGlkYXRpb24gY29tcGFyZXMgYWdhaW5zdC4gRS5nLiwgZG8gdGhlIG93bmVycyBtYXRjaD9cbiAgICAvLyBGb3Igbm9uLXZlcnNpb25lZCBjb2xsZWN0aW9ucywgd2UgY29tcGFyZSBhZ2FpbnN0IHRoZSBleGlzdGluZyBkYXRhIGF0IHRoZSBzYW1lIHRhZyBiZWluZyB3cml0dGVuLlxuICAgIC8vIEZvciB2ZXJzaW9uZWQgY29sbGVjdGlvbnMsIGl0IGlzIHdoYXQgZXhpc3RzIGFzIHRoZSBsYXRlc3QgdmVyc2lvbiB3aGVuIHRoZSBkYXRhIGlzIHNpZ25lZCwgYW5kIHdoaWNoIHRoZSBzaWduYXR1cmVcbiAgICAvLyByZWNvcmRzIGluIHRoZSBzaWduYXR1cmUuIChGb3IgdGhlIHZlcnkgZmlyc3QgdmVyc2lvbiwgdGhlIHNpZ25hdHVyZSB3aWxsIG5vdGUgdGhlIHRpbWVzdGFtcCBhcyB0aGUgYW50ZWNlY2RlbnQgdGFnLFxuICAgIC8vIChzZWUgdGFnRm9yV3JpdGluZyksIGJ1dCBmb3IgY29tcGFyaW5nIGFnYWluc3QsIHRoaXMgbWV0aG9kIGFuc3dlcnMgZmFsc3kgZm9yIHRoZSBmaXJzdCBpbiB0aGUgY2hhaW4uXG4gICAgY29uc3QgaGVhZGVyID0gdmFsaWRhdGlvbj8ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGlmICghaGVhZGVyKSByZXR1cm4gJyc7XG4gICAgY29uc3QgYW50ZWNlZGVudCA9IGhlYWRlci5hbnQ7XG4gICAgaWYgKHR5cGVvZihhbnRlY2VkZW50KSA9PT0gJ251bWJlcicpIHJldHVybiAnJzsgLy8gQSB0aW1lc3RhbXAgYXMgYW50ZWNlZGVudCBpcyB1c2VkIHRvIHRvIHN0YXJ0IHRoaW5ncyBvZmYuIE5vIHRydWUgYW50ZWNlZGVudC5cbiAgICByZXR1cm4gYW50ZWNlZGVudDtcbiAgfVxuICBhc3luYyBzdWJqZWN0TWF0Y2godmVyaWZpZWQpIHsgLy8gSGVyZSBzdWIgcmVmZXJzIHRvIHRoZSBvdmVyYWxsIGl0ZW0gdGFnIHRoYXQgZW5jb21wYXNzZXMgYWxsIHZlcnNpb25zLCBub3QgdGhlIHBheWxvYWQgaGFzaC5cbiAgICByZXR1cm4gdHJ1ZTsgLy8gVE9ETzogbWFrZSBzdXJlIGl0IG1hdGNoZXMgcHJldmlvdXM/XG4gIH1cbiAgZW1pdCh2ZXJpZmllZCkgeyAvLyBzdWJqZWN0VGFnIChpLmUuLCB0aGUgdGFnIHdpdGhpbiB0aGUgY29sbGVjdGlvbiBhcyBhIHdob2xlKSBpcyBub3QgdGhlIHRhZy9oYXNoLlxuICAgIHZlcmlmaWVkLnN1YmplY3RUYWcgPSB2ZXJpZmllZC5wcm90ZWN0ZWRIZWFkZXIuc3ViO1xuICAgIHN1cGVyLmVtaXQodmVyaWZpZWQpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBWZXJzaW9uZWRDb2xsZWN0aW9uIGV4dGVuZHMgTXV0YWJsZUNvbGxlY3Rpb24ge1xuICAvLyBUT0RPOiBUaGlzIHdvcmtzIGFuZCBkZW1vbnN0cmF0ZXMgaGF2aW5nIGEgY29sbGVjdGlvbiB1c2luZyBvdGhlciBjb2xsZWN0aW9ucy5cbiAgLy8gSG93ZXZlciwgaGF2aW5nIGEgYmlnIHRpbWVzdGFtcCA9PiBmaXhudW0gbWFwIGlzIGJhZCBmb3IgcGVyZm9ybWFuY2UgYXMgdGhlIGhpc3RvcnkgZ2V0cyBsb25nZXIuXG4gIC8vIFRoaXMgc2hvdWxkIGJlIHNwbGl0IHVwIGludG8gd2hhdCBpcyBkZXNjcmliZWQgaW4gdmVyc2lvbmVkLm1kLlxuICBjb25zdHJ1Y3Rvcih7c2VydmljZXMgPSBbXSwgLi4ucmVzdH0gPSB7fSkge1xuICAgIHN1cGVyKHJlc3QpOyAgLy8gV2l0aG91dCBwYXNzaW5nIHNlcnZpY2VzIHlldCwgYXMgd2UgZG9uJ3QgaGF2ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiBzZXQgdXAgeWV0LlxuICAgIHRoaXMudmVyc2lvbnMgPSBuZXcgVmVyc2lvbkNvbGxlY3Rpb24ocmVzdCk7IC8vIFNhbWUgY29sbGVjdGlvbiBuYW1lLCBidXQgZGlmZmVyZW50IHR5cGUuXG4gICAgLy9maXhtZSB0aGlzLnZlcnNpb25zLmFkZEV2ZW50TGlzdGVuZXIoJ3VwZGF0ZScsIGV2ZW50ID0+IHRoaXMuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ3VwZGF0ZScsIHtkZXRhaWw6IHRoaXMucmVjb3ZlclRhZyhldmVudC5kZXRhaWwpfSkpKTtcbiAgICB0aGlzLnN5bmNocm9uaXplKC4uLnNlcnZpY2VzKTsgLy8gTm93IHdlIGNhbiBzeW5jaHJvbml6ZS5cbiAgfVxuICBhc3luYyBjbG9zZSgpIHtcbiAgICBhd2FpdCB0aGlzLnZlcnNpb25zLmNsb3NlKCk7XG4gICAgYXdhaXQgc3VwZXIuY2xvc2UoKTtcbiAgfVxuICBhc3luYyBkZXN0cm95KCkge1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGVzdHJveSgpO1xuICAgIGF3YWl0IHN1cGVyLmRlc3Ryb3koKTtcbiAgfVxuICByZWNvdmVyVGFnKHZlcmlmaWVkKSB7IC8vIHRoZSB2ZXJpZmllZC50YWcgaXMgZm9yIHRoZSB2ZXJzaW9uLiBXZSB3YW50IHRoZSBvdmVyYWxsIG9uZS5cbiAgICByZXR1cm4gT2JqZWN0LmFzc2lnbih7fSwgdmVyaWZpZWQsIHt0YWc6IHZlcmlmaWVkLnByb3RlY3RlZEhlYWRlci5zdWJ9KTsgLy8gRG8gbm90IGJhc2ggdmVyaWZpZWQhXG4gIH1cbiAgc2VydmljZUZvclZlcnNpb24oc2VydmljZSkgeyAvLyBHZXQgdGhlIHNlcnZpY2UgXCJuYW1lXCIgZm9yIG91ciB2ZXJzaW9ucyBjb2xsZWN0aW9uLlxuICAgIHJldHVybiBzZXJ2aWNlPy52ZXJzaW9ucyB8fCBzZXJ2aWNlOyAgIC8vIEZvciB0aGUgd2VpcmQgY29ubmVjdERpcmVjdFRlc3RpbmcgY2FzZSB1c2VkIGluIHJlZ3Jlc3Npb24gdGVzdHMsIGVsc2UgdGhlIHNlcnZpY2UgKGUuZy4sIGFuIGFycmF5IG9mIHNpZ25hbHMpLlxuICB9XG4gIHNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykge1xuICAgIHJldHVybiBzZXJ2aWNlcy5tYXAoc2VydmljZSA9PiB0aGlzLnNlcnZpY2VGb3JWZXJzaW9uKHNlcnZpY2UpKTtcbiAgfVxuICBhc3luYyBzeW5jaHJvbml6ZSguLi5zZXJ2aWNlcykgeyAvLyBzeW5jaHJvbml6ZSB0aGUgdmVyc2lvbnMgY29sbGVjdGlvbiwgdG9vLlxuICAgIGlmICghc2VydmljZXMubGVuZ3RoKSByZXR1cm47XG4gICAgLy8gS2VlcCBjaGFubmVsIGNyZWF0aW9uIHN5bmNocm9ub3VzLlxuICAgIGNvbnN0IHZlcnNpb25lZFByb21pc2UgPSBzdXBlci5zeW5jaHJvbml6ZSguLi5zZXJ2aWNlcyk7XG4gICAgY29uc3QgdmVyc2lvblByb21pc2UgPSB0aGlzLnZlcnNpb25zLnN5bmNocm9uaXplKC4uLnRoaXMuc2VydmljZXNGb3JWZXJzaW9uKHNlcnZpY2VzKSk7XG4gICAgYXdhaXQgdmVyc2lvbmVkUHJvbWlzZTtcbiAgICBhd2FpdCB2ZXJzaW9uUHJvbWlzZTtcbiAgfVxuICBhc3luYyBkaXNjb25uZWN0KC4uLnNlcnZpY2VzKSB7IC8vIGRpc2Nvbm5lY3QgdGhlIHZlcnNpb25zIGNvbGxlY3Rpb24sIHRvby5cbiAgICBpZiAoIXNlcnZpY2VzLmxlbmd0aCkgc2VydmljZXMgPSB0aGlzLnNlcnZpY2VzO1xuICAgIGF3YWl0IHRoaXMudmVyc2lvbnMuZGlzY29ubmVjdCguLi50aGlzLnNlcnZpY2VzRm9yVmVyc2lvbihzZXJ2aWNlcykpO1xuICAgIGF3YWl0IHN1cGVyLmRpc2Nvbm5lY3QoLi4uc2VydmljZXMpO1xuICB9XG4gIGdldCBzeW5jaHJvbml6ZWQoKSB7IC8vIHByb21pc2UgdG8gcmVzb2x2ZSB3aGVuIHN5bmNocm9uaXphdGlvbiBpcyBjb21wbGV0ZSBpbiBCT1RIIGRpcmVjdGlvbnMuXG4gICAgLy8gVE9ETz8gVGhpcyBkb2VzIG5vdCByZWZsZWN0IGNoYW5nZXMgYXMgU3luY2hyb25pemVycyBhcmUgYWRkZWQgb3IgcmVtb3ZlZCBzaW5jZSBjYWxsZWQuIFNob3VsZCBpdD9cbiAgICByZXR1cm4gc3VwZXIuc3luY2hyb25pemVkLnRoZW4oKCkgPT4gdGhpcy52ZXJzaW9ucy5zeW5jaHJvbml6ZWQpO1xuICB9XG4gIGdldCBpdGVtRW1pdHRlcigpIHsgLy8gVGhlIHZlcnNpb25zIGNvbGxlY3Rpb24gZW1pdHMgYW4gdXBkYXRlIGNvcnJlc3BvbmRpbmcgdG8gdGhlIGluZGl2aWR1YWwgaXRlbSBzdG9yZWQuXG4gICAgLy8gKFRoZSB1cGRhdGVzIGVtaXR0ZWQgZnJvbSB0aGUgd2hvbGUgbXV0YWJsZSBWZXJzaW9uZWRDb2xsZWN0aW9uIGNvcnJlc3BvbmQgdG8gdGhlIG1hcC4pXG4gICAgcmV0dXJuIHRoaXMudmVyc2lvbnM7XG4gIH1cblxuICBhc3luYyBnZXRWZXJzaW9ucyh0YWcpIHsgLy8gUHJvbWlzZXMgdGhlIHBhcnNlZCB0aW1lc3RhbXAgPT4gdmVyc2lvbiBkaWN0aW9uYXJ5IElGIGl0IGV4aXN0cywgZWxzZSBmYWxzeS5cbiAgICB0aGlzLnJlcXVpcmVUYWcodGFnKTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHRoaXMuZ2V0VmVyaWZpZWQoe3RhZywgbWVtYmVyOiBudWxsfSk7IC8vIE1pZ2h0IG5vLWxvbmdlciBiZSBhIG1lbWJlci5cbiAgICBjb25zdCBqc29uID0gdmVyaWZpZWQ/Lmpzb247XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGpzb24pKSByZXR1cm4ganNvbjtcbiAgICAvLyBJZiB3ZSBoYXZlIGFuIHVubWVyZ2VkIGFycmF5IG9mIHNpZ25hdHVyZXMuLi5cbiAgICAvLyBJJ20gbm90IHN1cmUgdGhhdCBpdCdzIHZlcnkgdXNlZnVsIHRvIGFwcGxpY2F0aW9ucyBmb3IgdXMgdG8gaGFuZGxlIHRoaXMgY2FzZSwgYnV0IGl0IGlzIG5pY2UgdG8gZXhlcmNpc2UgdGhpcyBpbiB0ZXN0aW5nLlxuICAgIGNvbnN0IHZlcmlmaWNhdGlvbnNBcnJheSA9IGF3YWl0IHRoaXMuZW5zdXJlRXhwYW5kZWQodmVyaWZpZWQpO1xuICAgIHJldHVybiB0aGlzLmNvbWJpbmVUaW1lc3RhbXBzKHRhZywgbnVsbCwgLi4udmVyaWZpY2F0aW9uc0FycmF5Lm1hcCh2ID0+IHYuanNvbikpO1xuICB9XG4gIGFzeW5jIHJldHJpZXZlVGltZXN0YW1wcyh0YWcpIHsgLy8gUHJvbWlzZXMgYSBsaXN0IG9mIGFsbCB2ZXJzaW9uIHRpbWVzdGFtcHMuXG4gICAgY29uc3QgdmVyc2lvbnMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgaWYgKCF2ZXJzaW9ucykgcmV0dXJuIHZlcnNpb25zO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh2ZXJzaW9ucykuc2xpY2UoMSkubWFwKHN0cmluZyA9PiBwYXJzZUludChzdHJpbmcpKTsgLy8gVE9ETz8gTWFwIHRoZXNlIHRvIGludGVnZXJzP1xuICB9XG4gIGdldEFjdGl2ZUhhc2godGltZXN0YW1wcywgdGltZSA9IHRpbWVzdGFtcHMubGF0ZXN0KSB7IC8vIFByb21pc2VzIHRoZSB2ZXJzaW9uIHRhZyB0aGF0IHdhcyBpbiBmb3JjZSBhdCB0aGUgc3BlY2lmaWVkIHRpbWVcbiAgICAvLyAod2hpY2ggbWF5IGJlZm9yZSwgaW4gYmV0d2Vlbiwgb3IgYWZ0ZXIgdGhlIHJlY29yZGVkIGRpc2NyZXRlIHRpbWVzdGFtcHMpLlxuICAgIGlmICghdGltZXN0YW1wcykgcmV0dXJuIHRpbWVzdGFtcHM7XG4gICAgbGV0IGhhc2ggPSB0aW1lc3RhbXBzW3RpbWVdO1xuICAgIGlmIChoYXNoKSByZXR1cm4gaGFzaDtcbiAgICAvLyBXZSBuZWVkIHRvIGZpbmQgdGhlIHRpbWVzdGFtcCB0aGF0IHdhcyBpbiBmb3JjZSBhdCB0aGUgcmVxdWVzdGVkIHRpbWUuXG4gICAgbGV0IGJlc3QgPSAwLCB0aW1lcyA9IE9iamVjdC5rZXlzKHRpbWVzdGFtcHMpO1xuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgdGltZXMubGVuZ3RoOyBpKyspIHsgLy8gMHRoIGlzIHRoZSBrZXkgJ2xhdGVzdCcuXG4gICAgICBpZiAodGltZXNbaV0gPD0gdGltZSkgYmVzdCA9IHRpbWVzW2ldO1xuICAgICAgZWxzZSBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIHRpbWVzdGFtcHNbYmVzdF07XG4gIH1cbiAgYXN5bmMgcmV0cmlldmUodGFnT3JPcHRpb25zKSB7IC8vIEFuc3dlciB0aGUgdmFsaWRhdGVkIHZlcnNpb24gaW4gZm9yY2UgYXQgdGhlIHNwZWNpZmllZCB0aW1lIChvciBsYXRlc3QpLCBvciBhdCB0aGUgc3BlY2lmaWMgaGFzaC5cbiAgICBsZXQge3RhZywgdGltZSwgaGFzaCwgLi4ucmVzdH0gPSAoIXRhZ09yT3B0aW9ucyB8fCB0YWdPck9wdGlvbnMubGVuZ3RoKSA/IHt0YWc6IHRhZ09yT3B0aW9uc30gOiB0YWdPck9wdGlvbnM7XG4gICAgaWYgKCFoYXNoKSB7XG4gICAgICBjb25zdCB0aW1lc3RhbXBzID0gYXdhaXQgdGhpcy5nZXRWZXJzaW9ucyh0YWcpO1xuICAgICAgaWYgKCF0aW1lc3RhbXBzKSByZXR1cm4gdGltZXN0YW1wcztcbiAgICAgIGhhc2ggPSB0aGlzLmdldEFjdGl2ZUhhc2godGltZXN0YW1wcywgdGltZSk7XG4gICAgICBpZiAoIWhhc2gpIHJldHVybiAnJztcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMudmVyc2lvbnMucmV0cmlldmUoe3RhZzogaGFzaCwgLi4ucmVzdH0pO1xuICB9XG4gIGFzeW5jIHN0b3JlKGRhdGEsIG9wdGlvbnMgPSB7fSkgeyAvLyBEZXRlcm1pbmUgdGhlIGFudGVjZWRlbnQsIHJlY29yZCBpdCBpbiB0aGUgc2lnbmF0dXJlLCBhbmQgc3RvcmUgdGhhdFxuICAgIC8vIGFzIHRoZSBhcHByb3ByaWF0ZSB2ZXJzaW9uIGhhc2guIFRoZW4gcmVjb3JkIHRoZSBuZXcgdGltZXN0YW1wL2hhc2ggaW4gdGhlIHRpbWVzdGFtcHMgbGlzdC5cbiAgICBsZXQgdmVyc2lvbnMsXG5cdC8vIFRPRE86IENvbnNpZGVyIGVuY3J5cHRpbmcgdGhlIHRpbWVzdGFtcHMsIHRvby5cblx0Ly8gQ3VycmVudGx5LCBzaWduaW5nT3B0aW9ucyBmb3IgdGhlIHRpbWVzdGFtcHMgZG9lcyBOT1QgZW5jbHVkZSBlbmNyeXB0aW9uLCBldmVuIGlmIHNwZWNpZmllZCBmb3IgdGhlIGFjdHVhbCBzcGVjaWZpYyB2ZXJzaW9uIGluZm8uXG5cdC8vIFRoaXMgbWVhbnMgdGhhdCBpZiB0aGUgYXBwbGljYXRpb24gc3BlY2lmaWVzIGFuIGVuY3J5cHRlZCB2ZXJzaW9uZWQgY29sbGVjdGlvbiwgdGhlIGRhdGEgaXRzZWxmIHdpbGwgYmUgZW5jcnlwdGVkLCBidXRcblx0Ly8gbm90IHRoZSBtYXAgb2YgdGltZXN0YW1wcyB0byBoYXNoZXMsIGFuZCBzbyBhIGx1cmtlciBjYW4gc2VlIHdoZW4gdGhlcmUgd2FzIGFjdGl2aXRpdHkgYW5kIGhhdmUgYW4gaWRlYSBhcyB0byB0aGUgc2l6ZS5cblx0Ly8gT2YgY291cnNlLCBldmVuIGlmIGVuY3J5cHRlZCwgdGhleSBjb3VsZCBhbHNvIGdldCB0aGlzIGZyb20gbGl2ZSB0cmFmZmljIGFuYWx5c2lzLCBzbyBtYXliZSBlbmNyeXB0aW5nIGl0IHdvdWxkIGp1c3Rcblx0Ly8gY29udmV5IGEgZmFsc2Ugc2Vuc2Ugb2Ygc2VjdXJpdHkuIEVuY3J5cHRpbmcgdGhlIHRpbWVzdGFtcHMgZG9lcyBjb21wbGljYXRlLCBlLmcuLCBtZXJnZVNpZ25hdHVyZXMoKSBiZWNhdXNlXG5cdC8vIHNvbWUgb2YgdGhlIHdvcmsgY291bGQgb25seSBiZSBkb25lIGJ5IHJlbGF5cyB0aGF0IGhhdmUgYWNjZXNzLiBCdXQgc2luY2Ugd2UgaGF2ZSB0byBiZSBjYXJlZnVsIGFib3V0IHNpZ25pbmcgYW55d2F5LFxuXHQvLyB3ZSBzaG91bGQgdGhlb3JldGljYWxseSBiZSBhYmxlIHRvIGJlIGFjY29tb2RhdGUgdGhhdC5cblx0e3RhZywgZW5jcnlwdGlvbiwgdGVhbSwgbWVtYmVyLCAuLi5yZXN0fSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyksXG5cdHRpbWUgPSBEYXRlLm5vdygpLFxuXHQvLyBzaWduaW5nIHRha2VzIHRlYW0vbWVtYmVyLCBidXQgc3RvcmUgdGFrZXMgb3duZXIvYXV0aG9yLlxuXHRzaWduaW5nT3B0aW9ucyA9IHt0ZWFtLCBtZW1iZXIsIC4uLnJlc3R9LFxuXHR2ZXJzaW9uT3B0aW9ucyA9IHt0aW1lLCBlbmNyeXB0aW9uLCBvd25lcjp0ZWFtfHxyZXN0LnRhZ3NbMF0sIGF1dGhvcjptZW1iZXJ8fHJlc3QudGFnc1swXSwgLi4ucmVzdH07XG4gICAgaWYgKHRhZykge1xuICAgICAgdmVyc2lvbnMgPSAoYXdhaXQgdGhpcy5nZXRWZXJzaW9ucyh0YWcpKSB8fCB7fTtcbiAgICAgIHZlcnNpb25PcHRpb25zLnN1YiA9IHRhZztcbiAgICAgIGlmICh2ZXJzaW9ucykge1xuXHR2ZXJzaW9uT3B0aW9ucy5hbnQgPSB2ZXJzaW9uc1t2ZXJzaW9ucy5sYXRlc3RdO1xuICAgICAgfVxuICAgIH0gLy8gRWxzZSBkbyBub3QgYXNzaWduIHN1Yi4gSXQgd2lsbCBiZSBzZXQgdG8gdGhlIHBheWxvYWQgaGFzaCBkdXJpbmcgc2lnbmluZywgYW5kIGFsc28gdXNlZCBmb3IgdGhlIG92ZXJhbGwgdGFnLlxuICAgIHZlcnNpb25PcHRpb25zLmFudCB8fD0gdGltZTtcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5zdG9yZShkYXRhLCB2ZXJzaW9uT3B0aW9ucyk7XG5cbiAgICBpZiAoIXRhZykgeyAvLyBXZSdsbCBzdGlsbCBuZWVkIHRhZyBhbmQgdmVyc2lvbnMuXG4gICAgICBjb25zdCB2ZXJzaW9uU2lnbmF0dXJlID0gYXdhaXQgdGhpcy52ZXJzaW9ucy5nZXQoaGFzaCk7XG4gICAgICBjb25zdCBjbGFpbXMgPSBDcmVkZW50aWFscy5kZWNvZGVDbGFpbXModGhpcy5jb25zdHJ1Y3Rvci5tYXliZUluZmxhdGUodmVyc2lvblNpZ25hdHVyZSkpO1xuICAgICAgdGFnID0gY2xhaW1zLnN1YjtcbiAgICAgIHZlcnNpb25zID0ge307XG4gICAgfVxuICAgIHZlcnNpb25zLmxhdGVzdCA9IHRpbWU7XG4gICAgdmVyc2lvbnNbdGltZV0gPSBoYXNoO1xuXG4gICAgLy8gZml4bWUgbmV4dFxuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbih2ZXJzaW9ucywgc2lnbmluZ09wdGlvbnMpO1xuICAgIC8vIEhlcmUgd2UgYXJlIGRvaW5nIHdoYXQgdGhpcy5wdXQoKSB3b3VsZCBub3JtYWxseSBkbywgYnV0IHdlIGhhdmUgYWxyZWFkeSBtZXJnZWQgc2lnbmF0dXJlcy5cbiAgICBhd2FpdCB0aGlzLmFkZFRhZyh0YWcpO1xuICAgIGF3YWl0IHRoaXMucGVyc2lzdCh0YWcsIHNpZ25hdHVyZSk7XG4gICAgdGhpcy5lbWl0KHt0YWcsIHN1YmplY3RUYWc6IHRhZywgLi4uKGF3YWl0IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSkpfSk7XG4gICAgYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHNpZ25hdHVyZSk7XG4gICAgLy8gY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnZlcmlmaWVkU2lnbih2ZXJzaW9ucywgc2lnbmluZ09wdGlvbnMsIHRhZyk7XG4gICAgLy8gdGhpcy5sb2coJ3B1dCgtaXNoKScsIHZlcmlmaWVkKTtcbiAgICAvLyBhd2FpdCB0aGlzLnBlcnNpc3QyKHZlcmlmaWVkKTtcbiAgICAvLyBhd2FpdCB0aGlzLmFkZFRhZyh0YWcpO1xuICAgIC8vIHRoaXMuZW1pdCh7Li4udmVyaWZpZWQsIHRhZywgc3ViamVjdFRhZzogdGFnfSk7XG4gICAgLy8gYXdhaXQgdGhpcy5wdXNoKCdwdXQnLCB0YWcsIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZlcmlmaWVkLnNpZ25hdHVyZSkpO1xuXG4gICAgcmV0dXJuIHRhZztcbiAgfVxuICBhc3luYyByZW1vdmUob3B0aW9ucyA9IHt9KSB7IC8vIEFkZCBhbiBlbXB0eSB2ZXJpb24gb3IgcmVtb3ZlIGFsbCB2ZXJzaW9ucywgZGVwZW5kaW5nIG9uIHRoaXMucHJlc2VydmVEZWxldGlvbnMuXG4gICAgbGV0IHtlbmNyeXB0aW9uLCB0YWcsIC4uLnNpZ25pbmdPcHRpb25zfSA9IHRoaXMuX2Nhbm9uaWNhbGl6ZU9wdGlvbnMob3B0aW9ucyk7IC8vIElnbm9yZSBlbmNyeXB0aW9uXG4gICAgY29uc3QgdmVyc2lvbnMgPSBhd2FpdCB0aGlzLmdldFZlcnNpb25zKHRhZyk7XG4gICAgaWYgKCF2ZXJzaW9ucykgcmV0dXJuIHZlcnNpb25zO1xuICAgIGlmICh0aGlzLnByZXNlcnZlRGVsZXRpb25zKSB7IC8vIENyZWF0ZSBhIHRpbWVzdGFtcCA9PiB2ZXJzaW9uIHdpdGggYW4gZW1wdHkgcGF5bG9hZC4gT3RoZXJ3aXNlIG1lcmdpbmcgd2l0aCBlYXJsaWVyIGRhdGEgd2lsbCBicmluZyBpdCBiYWNrIVxuICAgICAgYXdhaXQgdGhpcy5zdG9yZSgnJywgc2lnbmluZ09wdGlvbnMpO1xuICAgIH0gZWxzZSB7IC8vIEFjdHVhbGx5IGRlbGV0ZSB0aGUgdGltZXN0YW1wcyBhbmQgZWFjaCB2ZXJzaW9uLlxuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgY29uc3QgdmVyc2lvblRhZ3MgPSBPYmplY3QudmFsdWVzKHZlcnNpb25zKS5zbGljZSgxKTtcbiAgICAgIGNvbnN0IHZlcnNpb25TaWduYXR1cmUgPSBhd2FpdCB0aGlzLmNvbnN0cnVjdG9yLnNpZ24oJycsIHtzdWI6IHRhZywgLi4uc2lnbmluZ09wdGlvbnN9KTtcbiAgICAgIC8vIFRPRE86IElzIHRoaXMgc2FmZT8gU2hvdWxkIHdlIG1ha2UgYSBzaWduYXR1cmUgdGhhdCBzcGVjaWZpZXMgZWFjaCBhbnRlY2VkZW50P1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwodmVyc2lvblRhZ3MubWFwKGFzeW5jIHRhZyA9PiB7XG5cdGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlKHRhZywgdmVyc2lvblNpZ25hdHVyZSk7XG5cdGF3YWl0IHRoaXMudmVyc2lvbnMucHVzaCgnZGVsZXRlJywgdGFnLCB2ZXJzaW9uU2lnbmF0dXJlKTtcbiAgICAgIH0pKTtcbiAgICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuY29uc3RydWN0b3Iuc2lnbignJywgc2lnbmluZ09wdGlvbnMpO1xuICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0KHRhZywgc2lnbmF0dXJlLCAnZGVsZXRlJyk7XG4gICAgICBhd2FpdCB0aGlzLnB1c2goJ2RlbGV0ZScsIHRhZywgc2lnbmF0dXJlKTtcbiAgICAgIC8vIGNvbnN0IHZlcnNpb25IYXNoZXMgPSBPYmplY3QudmFsdWVzKHZlcnNpb25zKS5zbGljZSgxKTtcbiAgICAgIC8vIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZmllZFNpZ24oJycsIHtzdWI6IHRhZywgLi4uc2lnbmluZ09wdGlvbnN9LCB0YWcpO1xuICAgICAgLy8gLy8gVE9ETzogSXMgdGhpcyBzYWZlPyBTaG91bGQgd2UgbWFrZSBhIHNpZ25hdHVyZSB0aGF0IHNwZWNpZmllcyBlYWNoIGFudGVjZWRlbnQ/XG4gICAgICAvLyBhd2FpdCBQcm9taXNlLmFsbCh2ZXJzaW9uSGFzaGVzLm1hcChhc3luYyBoYXNoID0+IHtcbiAgICAgIC8vIFx0bGV0IHZWZXJpZmllZCA9IHsuLi52ZXJpZmllZCwgdGFnOiBoYXNofTtcbiAgICAgIC8vIFx0bGV0IHNWZXJpZmllZCA9IHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKHZWZXJpZmllZC5zaWduYXR1cmUpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLmRlbGV0ZVRhZyh0YWcpO1xuICAgICAgLy8gXHQvLyBhd2FpdCB0aGlzLnZlcnNpb25zLnBlcnNpc3QyKHZWZXJpZmllZCwgJ2RlbGV0ZScpO1xuICAgICAgLy8gXHQvLyB0aGlzLnZlcnNpb25zLmVtaXQodlZlcmlmaWVkKTtcbiAgICAgIC8vIFx0Ly8gYXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHNWZXJpZmllZCk7XG4gICAgICAvLyBcdGF3YWl0IHRoaXMudmVyc2lvbnMuZGVsZXRlKHRhZywgc1ZlcmlmaWVkKTtcbiAgICAgIC8vIFx0YXdhaXQgdGhpcy52ZXJzaW9ucy5wdXNoKCdkZWxldGUnLCB0YWcsIHNWZXJpZmllZClcbiAgICAgIC8vIH0pKTtcbiAgICAgIC8vIGF3YWl0IHRoaXMucGVyc2lzdDIodmVyaWZpZWQsICdkZWxldGUnKTtcbiAgICAgIC8vIGF3YWl0IHRoaXMucHVzaCgnZGVsZXRlJywgdGFnLCB0aGlzLmNvbnN0cnVjdG9yLmVuc3VyZVN0cmluZyh2ZXJpZmllZC5zaWduYXR1cmUpKTtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5kZWxldGVUYWcodGFnKTtcbiAgICByZXR1cm4gdGFnO1xuICB9XG4gIGFzeW5jIG1lcmdlU2lnbmF0dXJlcyh0YWcsIHZhbGlkYXRpb24sIHNpZ25hdHVyZSwgYXV0aG9yT3ZlcnJpZGUgPSBudWxsKSB7IC8vIE1lcmdlIHRoZSBuZXcgdGltZXN0YW1wcyB3aXRoIHRoZSBvbGQsXG4gICAgLy8gcHJvbWlzaW5nIGEgc3RyaW5nIGZvciBzdG9yYWdlOiBlaXRoZXIgYSBzaWduYXR1cmUgb3IgYSBzdHJpbmdpZmllZCBhcnJheSBvZiBzaWduYXR1cmVzLlxuICAgIC8vXG4gICAgLy8gSWYgcHJldmlvdXMgZG9lc24ndCBleGlzdCBvciBtYXRjaGVzIHRoZSBuZXh0LCBvciBpcyBhIHN1YnNldCBvZiB0aGUgbmV4dCwganVzdCB1c2UgdGhlIG5leHQuXG4gICAgLy8gT3RoZXJ3aXNlLCB3ZSBoYXZlIHRvIG1lcmdlOlxuICAgIC8vIC0gTWVyZ2VkIG11c3QgY29udGFpbiB0aGUgdW5pb24gb2YgdmFsdWVzIGZvciBlaXRoZXIuXG4gICAgLy8gICAoU2luY2UgdmFsdWVzIGFyZSBoYXNoZXMgb2Ygc3R1ZmYgd2l0aCBhbiBleHBsaWNpdCBhbnRlZGVudCwgbmV4dCBwcmV2aW91cyBub3IgbmV4dCB3aWxsIGhhdmUgZHVwbGljYXRlcyBieSB0aGVtc2VsdmVzLi4pXG4gICAgLy8gLSBJZiB0aGVyZSdzIGEgY29uZmxpY3QgaW4ga2V5cywgY3JlYXRlIGEgbmV3IGtleSB0aGF0IGlzIG1pZHdheSBiZXR3ZWVuIHRoZSBjb25mbGljdCBhbmQgdGhlIG5leHQga2V5IGluIG9yZGVyLlxuXG4gICAgbGV0IG5leHQgPSB2YWxpZGF0aW9uO1xuICAgIGxldCBwcmV2aW91cyA9IHZhbGlkYXRpb24uZXhpc3Rpbmc7XG4gICAgLy9maXhtZSBuZXh0XG4gICAgaWYgKCFwcmV2aW91cykgcmV0dXJuIHNpZ25hdHVyZTsgICAvLyBObyBwcmV2aW91cywganVzdCB1c2UgbmV3IHNpZ25hdHVyZS5cbiAgICAvL2lmICghcHJldmlvdXMpIHJldHVybiBuZXh0OyAgIC8vIE5vIHByZXZpb3VzLCBqdXN0IG5leHQuXG5cbiAgICAvLyBBdCB0aGlzIHBvaW50LCBwcmV2aW91cyBhbmQgbmV4dCBhcmUgYm90aCBcIm91dGVyXCIgdmFsaWRhdGlvbnMuXG4gICAgLy8gVGhhdCBqc29uIGNhbiBiZSBlaXRoZXIgYSB0aW1lc3RhbXAgb3IgYW4gYXJyYXkgb2Ygc2lnbmF0dXJlcy5cbiAgICBpZiAodmFsaWRhdGlvbi5wcm90ZWN0ZWRIZWFkZXIuaWF0IDwgdmFsaWRhdGlvbi5leGlzdGluZy5wcm90ZWN0ZWRIZWFkZXIuaWF0KSB7IC8vIEFycmFuZ2UgZm9yIG5leHQgYW5kIHNpZ25hdHVyZSB0byBiZSBsYXRlciBvbmUgYnkgc2lnbmVkIHRpbWVzdGFtcC5cbiAgICAgIC8vIFRPRE86IGlzIGl0IHBvc3NpYmxlIHRvIGNvbnN0cnVjdCBhIHNjZW5hcmlvIGluIHdoaWNoIHRoZXJlIGlzIGEgZmljdGl0aW91cyB0aW1lIHN0YW1wIGNvbmZsaWN0LiBFLmcsIGlmIGFsbCBvZiB0aGVzZSBhcmUgdHJ1ZTpcbiAgICAgIC8vIDEuIHByZXZpb3VzIGFuZCBuZXh0IGhhdmUgaWRlbnRpY2FsIHRpbWVzdGFtcHMgZm9yIGRpZmZlcmVudCB2YWx1ZXMsIGFuZCBzbyB3ZSBuZWVkIHRvIGNvbnN0cnVjdCBhcnRpZmljaWFsIHRpbWVzIGZvciBvbmUuIExldCdzIGNhbGwgdGhlc2UgYnJhbmNoIEEgYW5kIEIuXG4gICAgICAvLyAyLiB0aGlzIGhhcHBlbnMgd2l0aCB0aGUgc2FtZSB0aW1lc3RhbXAgaW4gYSBzZXBhcmF0ZSBwYWlyLCB3aGljaCB3ZSdsbCBjYWxsIEEyLCBhbmQgQjIuXG4gICAgICAvLyAzLiBBIGFuZCBCIGFyZSBtZXJnZWQgaW4gdGhhdCBvcmRlciAoZS5nLiB0aGUgbGFzdCB0aW1lIGluIEEgaXMgbGVzcyB0aGFuIEIpLCBidXQgQTIgYW5kIEIyIGFyZSBtZXJnZWQgYmFja3dhcmRzIChlLmcuLCB0aGUgbGFzdCB0aW1lIGluIEIyIGlzIGxlc3MgdGhhbnQgQTIpLFxuICAgICAgLy8gICAgc3VjaCB0aGF0IHRoZSBvdmVyYWxsIG1lcmdlIGNyZWF0ZXMgYSBjb25mbGljdD9cbiAgICAgIFtwcmV2aW91cywgbmV4dF0gPSBbbmV4dCwgcHJldmlvdXNdO1xuICAgIH1cblxuICAgIC8vIEZpbmQgdGhlIHRpbWVzdGFtcHMgb2YgcHJldmlvdXMgd2hvc2UgVkFMVUVTIHRoYXQgYXJlIG5vdCBpbiBuZXh0LlxuICAgIGxldCBrZXlzT2ZNaXNzaW5nID0gbnVsbDtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocHJldmlvdXMuanNvbikgJiYgIUFycmF5LmlzQXJyYXkobmV4dC5qc29uKSkgeyAvLyBObyBwb2ludCBpbiBvcHRpbWl6aW5nIHRocm91Z2ggbWlzc2luZ0tleXMgaWYgdGhhdCBtYWtlcyB1cyBjb21iaW5lVGltZXN0YW1wcyBhbnl3YXkuXG4gICAgICBrZXlzT2ZNaXNzaW5nID0gdGhpcy5taXNzaW5nS2V5cyhwcmV2aW91cy5qc29uLCBuZXh0Lmpzb24pO1xuICAgICAgLy8gZml4bWUgbmV4dFxuICAgICAgaWYgKCFrZXlzT2ZNaXNzaW5nLmxlbmd0aCkgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IuZW5zdXJlU3RyaW5nKG5leHQuc2lnbmF0dXJlKTsgLy8gUHJldmlvdXMgaXMgYSBzdWJzZXQgb2YgbmV3IHNpZ25hdHVyZS5cbiAgICAgIC8vaWYgKCFrZXlzT2ZNaXNzaW5nLmxlbmd0aCkgcmV0dXJuIG5leHQ7IC8vIFByZXZpb3VzIGlzIGEgc3Vic2V0IG9mIG5ldyBzaWduYXR1cmUuXG4gICAgfVxuICAgIC8vIFRPRE86IHJldHVybiBwcmV2aW91cyBpZiBuZXh0IGlzIGEgc3Vic2V0IG9mIGl0P1xuXG4gICAgLy8gV2UgY2Fubm90IHJlLXVzZSBvbmUgb3Igb3RoZXIuIFNpZ24gYSBuZXcgbWVyZ2VkIHJlc3VsdC5cbiAgICBjb25zdCBwcmV2aW91c1ZhbGlkYXRpb25zID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZChwcmV2aW91cyk7XG4gICAgY29uc3QgbmV4dFZhbGlkYXRpb25zID0gYXdhaXQgdGhpcy5lbnN1cmVFeHBhbmRlZChuZXh0KTtcbiAgICBpZiAoIXByZXZpb3VzVmFsaWRhdGlvbnMubGVuZ3RoKSByZXR1cm4gc2lnbmF0dXJlO1xuICAgIC8vIFdlIGNhbiBvbmx5IHRydWx5IG1lcmdlIGlmIHdlIGFyZSBhbiBvd25lci5cbiAgICBjb25zdCBoZWFkZXIgPSBwcmV2aW91c1ZhbGlkYXRpb25zWzBdLnByb3RlY3RlZEhlYWRlcjtcbiAgICBsZXQgb3duZXIgPSBoZWFkZXIuaXNzIHx8IGhlYWRlci5raWQ7XG4gICAgbGV0IGlzT3duZXIgPSBbQ3JlZGVudGlhbHMub3duZXIsIENyZWRlbnRpYWxzLmF1dGhvciwgYXV0aG9yT3ZlcnJpZGVdLmluY2x1ZGVzKG93bmVyKTtcbiAgICAvLyBJZiB0aGVzZSBhcmUgbm90IHRoZSBvd25lciwgYW5kIHdlIHdlcmUgbm90IGdpdmVuIGEgc3BlY2lmaWMgb3ZlcnJpZGUsIHRoZW4gc2VlIGlmIHRoZSB1c2VyIGhhcyBhY2Nlc3MgdG8gdGhlIG93bmVyIGluIHRoaXMgZXhlY3V0aW9uIGNvbnRleHQuXG4gICAgbGV0IGNhblNpZ24gPSBpc093bmVyIHx8ICghYXV0aG9yT3ZlcnJpZGUgJiYgYXdhaXQgQ3JlZGVudGlhbHMuc2lnbignJywgb3duZXIpLmNhdGNoKCgpID0+IGZhbHNlKSk7XG4gICAgbGV0IG1lcmdlZCwgb3B0aW9ucywgdGltZSA9IERhdGUubm93KCk7XG4gICAgY29uc3QgYXV0aG9yID0gYXV0aG9yT3ZlcnJpZGUgfHwgQ3JlZGVudGlhbHMuYXV0aG9yO1xuICAgIGZ1bmN0aW9uIGZsYXR0ZW4oYSwgYikgeyByZXR1cm4gW10uY29uY2F0KGEsIGIpOyB9XG4gICAgaWYgKCFjYW5TaWduKSB7IC8vIFdlIGRvbid0IGhhdmUgb3duZXIgYW5kIGNhbm5vdCBnZXQgaXQuXG4gICAgICAvLyBDcmVhdGUgYSBzcGVjaWFsIG5vbi1zdGFuZGFyZCBcInNpZ25hdHVyZVwiIHRoYXQgaXMgcmVhbGx5IGFuIGFycmF5IG9mIHNpZ25hdHVyZXNcbiAgICAgIGZ1bmN0aW9uIGdldFNpZ25hdHVyZXModmFsaWRhdGlvbnMpIHsgcmV0dXJuIHZhbGlkYXRpb25zLm1hcCh2YWxpZGF0aW9uID0+IHZhbGlkYXRpb24uc2lnbmF0dXJlKTsgfVxuICAgICAgbWVyZ2VkID0gZmxhdHRlbihnZXRTaWduYXR1cmVzKHByZXZpb3VzVmFsaWRhdGlvbnMpLCBnZXRTaWduYXR1cmVzKG5leHRWYWxpZGF0aW9ucykpO1xuICAgICAgb3B0aW9ucyA9IHt0YWdzOiBbYXV0aG9yXSwgdGltZX07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZ1bmN0aW9uIGdldEpTT05zKHZhbGlkYXRpb25zKSB7IHJldHVybiB2YWxpZGF0aW9ucy5tYXAodmFsaWRhdGlvbiA9PiB2YWxpZGF0aW9uLmpzb24pOyB9XG4gICAgICBjb25zdCBmbGF0dGVuZWQgPSBmbGF0dGVuKGdldEpTT05zKHByZXZpb3VzVmFsaWRhdGlvbnMpLCBnZXRKU09OcyhuZXh0VmFsaWRhdGlvbnMpKTtcbiAgICAgIG1lcmdlZCA9IHRoaXMuY29tYmluZVRpbWVzdGFtcHMobmV4dC50YWcsIGtleXNPZk1pc3NpbmcsIC4uLmZsYXR0ZW5lZCk7XG4gICAgICBvcHRpb25zID0ge3RlYW06IG93bmVyLCBtZW1iZXI6IGF1dGhvciwgdGltZX07XG4gICAgfVxuICAgIC8vIGZpeG1lIG5leHRcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci5zaWduKG1lcmdlZCwgb3B0aW9ucyk7XG4gICAgLy9yZXR1cm4gYXdhaXQgdGhpcy5jb25zdHJ1Y3Rvci52ZXJpZmllZFNpZ24obWVyZ2VkLCBvcHRpb25zKTtcbiAgfVxuICBlbnN1cmVFeHBhbmRlZCh2YWxpZGF0aW9uKSB7IC8vIFByb21pc2UgYW4gYXJyYXkgb2YgdmVyaWZpY2F0aW9ucyAodmVyaWZ5aW5nIGVsZW1lbnRzIG9mIHZhbGlkYXRpb24uanNvbiBpZiBuZWVkZWQpLlxuICAgIGlmICghdmFsaWRhdGlvbiB8fCAhdmFsaWRhdGlvbi5qc29uKSByZXR1cm4gW107XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbGlkYXRpb24uanNvbikpIHJldHVybiBbdmFsaWRhdGlvbl07XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHZhbGlkYXRpb24uanNvbi5tYXAoc2lnbmF0dXJlID0+IHRoaXMuY29uc3RydWN0b3IudmVyaWZ5KHNpZ25hdHVyZSkpKVxuICAgICAgLnRoZW4oc2lnbmF0dXJlcyA9PiBzaWduYXR1cmVzLmZpbHRlcihzaWcgPT4gc2lnKSk7XG4gIH1cbiAgbWlzc2luZ0tleXMocHJldmlvdXNNYXBwaW5nLCBuZXh0TWFwcGluZ3MpIHsgLy8gQW5zd2VyIGEgbGlzdCBvZiB0aG9zZSBrZXlzIGZyb20gcHJldmlvdXMgdGhhdCBkbyBub3QgaGF2ZSB2YWx1ZXMgaW4gbmV4dC5cbiAgICBjb25zdCBuZXh0VmFsdWVzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5leHRNYXBwaW5ncykpO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyhwcmV2aW91c01hcHBpbmcpLmZpbHRlcihrZXkgPT4ga2V5ICE9PSAnbGF0ZXN0JyAmJiAhbmV4dFZhbHVlcy5oYXMocHJldmlvdXNNYXBwaW5nW2tleV0pKTtcbiAgfVxuICBjb21iaW5lVGltZXN0YW1wcyh0YWcsIGtleXNPZk1pc3NpbmcsIHByZXZpb3VzTWFwcGluZ3MsIG5leHRNYXBwaW5ncywgLi4ucmVzdCkgeyAvLyBSZXR1cm4gYSBtZXJnZWQgZGljdGlvbmFyeSBvZiB0aW1lc3RhbXAgPT4gaGFzaCwgY29udGFpbmluZyBhbGwgb2YgcHJldmlvdXMgYW5kIG5leHRNYXBwaW5ncy5cbiAgICAvLyBXZSdsbCBuZWVkIGEgbmV3IG9iamVjdCB0byBzdG9yZSB0aGUgdW5pb24sIGJlY2F1c2UgdGhlIGtleXMgbXVzdCBiZSBpbiB0aW1lIG9yZGVyLCBub3QgdGhlIG9yZGVyIHRoZXkgd2VyZSBhZGRlZC5cbiAgICBrZXlzT2ZNaXNzaW5nIHx8PSB0aGlzLm1pc3NpbmdLZXlzKHByZXZpb3VzTWFwcGluZ3MsIG5leHRNYXBwaW5ncyk7XG4gICAgY29uc3QgbWVyZ2VkID0ge307XG4gICAgbGV0IG1pc3NpbmdJbmRleCA9IDAsIG1pc3NpbmdUaW1lLCBuZXh0VGltZXM7XG4gICAgZm9yIChjb25zdCBuZXh0VGltZSBpbiBuZXh0TWFwcGluZ3MpIHtcbiAgICAgIG1pc3NpbmdUaW1lID0gMDtcblxuICAgICAgLy8gTWVyZ2UgYW55IHJlbWFpbmluZyBrZXlzT2ZNaXNzaW5nIHRoYXQgY29tZSBzdHJpY3RseSBiZWZvcmUgbmV4dFRpbWU6XG4gICAgICBpZiAobmV4dFRpbWUgIT09ICdsYXRlc3QnKSB7XG5cdGZvciAoOyAobWlzc2luZ0luZGV4IDwga2V5c09mTWlzc2luZy5sZW5ndGgpICYmICgobWlzc2luZ1RpbWUgPSBrZXlzT2ZNaXNzaW5nW21pc3NpbmdJbmRleF0pIDwgbmV4dFRpbWUpOyBtaXNzaW5nSW5kZXgrKykge1xuXHQgIG1lcmdlZFttaXNzaW5nVGltZV0gPSBwcmV2aW91c01hcHBpbmdzW21pc3NpbmdUaW1lXTtcblx0fVxuICAgICAgfVxuXG4gICAgICBpZiAobWlzc2luZ1RpbWUgPT09IG5leHRUaW1lKSB7IC8vIFR3byBkaWZmZXJlbnQgdmFsdWVzIGF0IHRoZSBleGFjdCBzYW1lIHRpbWUuIEV4dHJlbWVseSByYXJlLlxuXHRjb25zb2xlLndhcm4odGhpcy5mdWxsTGFiZWwsIGBVbnVzdWFsIG1hdGNoaW5nIHRpbWVzdGFtcCBjYXNlIGF0IHRpbWUgJHttaXNzaW5nVGltZX0gZm9yIHRhZyAke3RhZ30uYCk7XG5cdG5leHRUaW1lcyB8fD0gT2JqZWN0LmtleXMobmV4dE1hcHBpbmdzKTsgLy8gV2UgZGlkbid0IG5lZWQgdGhpcyBmb3Igb3VyIGxvb3AuIEdlbmVyYXRlIG5vdyBpZiBuZWVkZWQuXG5cdGNvbnN0IG5leHROZXh0VGltZSA9IE1hdGgubWluKGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4ICsgMV0gfHwgSW5maW5pdHksXG5cdFx0XHRcdCAgICAgIG5leHRNYXBwaW5nc1tuZXh0VGltZXMuaW5kZXhPZihuZXh0VGltZSkgKyAxXSB8fCBJbmZpbml0eSk7XG5cdGNvbnN0IGluc2VydFRpbWUgPSBuZXh0VGltZSArIChuZXh0TmV4dFRpbWUgLSBuZXh0VGltZSkgLyAyO1xuXHQvLyBXZSBhbHJlYWR5IHB1dCB0aGVzZSBpbiBvcmRlciB3aXRoIHByZXZpb3VzTWFwcGluZ3MgZmlyc3QuXG5cdG1lcmdlZFtuZXh0VGltZV0gPSBwcmV2aW91c01hcHBpbmdzW25leHRUaW1lXTtcblx0bWVyZ2VkW2luc2VydFRpbWVdID0gbmV4dE1hcHBpbmdzW25leHRUaW1lXTtcblxuICAgICAgfSBlbHNlIHsgLy8gTm8gY29uZmxpY3RzLiBKdXN0IGFkZCBuZXh0LlxuXHRtZXJnZWRbbmV4dFRpbWVdID0gbmV4dE1hcHBpbmdzW25leHRUaW1lXTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUaGVyZSBjYW4gYmUgbWlzc2luZyBzdHVmZiB0byBhZGQgYXQgdGhlIGVuZDtcbiAgICBmb3IgKDsgbWlzc2luZ0luZGV4IDwga2V5c09mTWlzc2luZy5sZW5ndGg7IG1pc3NpbmdJbmRleCsrKSB7XG4gICAgICBtaXNzaW5nVGltZSA9IGtleXNPZk1pc3NpbmdbbWlzc2luZ0luZGV4XTtcbiAgICAgIG1lcmdlZFttaXNzaW5nVGltZV0gPSBwcmV2aW91c01hcHBpbmdzW21pc3NpbmdUaW1lXTtcbiAgICB9XG4gICAgbGV0IG1lcmdlZFRpbWVzID0gT2JqZWN0LmtleXMobWVyZ2VkKTtcbiAgICBtZXJnZWQubGF0ZXN0ID0gbWVyZ2VkVGltZXNbbWVyZ2VkVGltZXMubGVuZ3RoIC0gMV07XG4gICAgcmV0dXJuIHJlc3QubGVuZ3RoID8gdGhpcy5jb21iaW5lVGltZXN0YW1wcyh0YWcsIHVuZGVmaW5lZCwgbWVyZ2VkLCAuLi5yZXN0KSA6IG1lcmdlZDtcbiAgfVxuICBzdGF0aWMgYXN5bmMgdmVyaWZ5KHNpZ25hdHVyZSwgb3B0aW9ucyA9IHt9KSB7IC8vIEFuIGFycmF5IG9mIHVubWVyZ2VkIHNpZ25hdHVyZXMgY2FuIGJlIHZlcmlmaWVkLlxuICAgIGlmIChzaWduYXR1cmUuc3RhcnRzV2l0aD8uKCdbJykpIHNpZ25hdHVyZSA9IEpTT04ucGFyc2Uoc2lnbmF0dXJlKTsgLy8gKG1heWJlSW5mbGF0ZSBsb29rcyBmb3IgJ3snLCBub3QgJ1snLilcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoc2lnbmF0dXJlKSkgcmV0dXJuIGF3YWl0IHN1cGVyLnZlcmlmeShzaWduYXR1cmUsIG9wdGlvbnMpO1xuICAgIGNvbnN0IGNvbWJpbmVkID0gYXdhaXQgUHJvbWlzZS5hbGwoc2lnbmF0dXJlLm1hcChlbGVtZW50ID0+IHRoaXMudmVyaWZ5KGVsZW1lbnQsIG9wdGlvbnMpKSk7XG4gICAgY29uc3Qgb2sgPSBjb21iaW5lZC5ldmVyeShlbGVtZW50ID0+IGVsZW1lbnQpO1xuICAgIGlmICghb2spIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgcHJvdGVjdGVkSGVhZGVyID0gY29tYmluZWRbMF0ucHJvdGVjdGVkSGVhZGVyO1xuICAgIGZvciAoY29uc3QgcHJvcGVydHkgb2YgWydpc3MnLCAna2lkJywgJ2FsZycsICdjdHknXSkgeyAvLyBPdXIgb3BlcmF0aW9ucyBtYWtlIHVzZSBvZiBpc3MsIGtpZCwgYW5kIGlhdC5cbiAgICAgIGNvbnN0IG1hdGNoaW5nID0gcHJvdGVjdGVkSGVhZGVyW3Byb3BlcnR5XTtcbiAgICAgIGNvbnN0IG1hdGNoZXMgPSBjb21iaW5lZC5ldmVyeShlbGVtZW50ID0+IGVsZW1lbnQucHJvdGVjdGVkSGVhZGVyW3Byb3BlcnR5XSA9PT0gbWF0Y2hpbmcpO1xuICAgICAgaWYgKG1hdGNoZXMpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFtYXRjaGVzKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBjb25zdCB7aXNzLCBraWQsIGFsZywgY3R5fSA9IHByb3RlY3RlZEhlYWRlcjtcbiAgICBjb25zdCB2ZXJpZmllZCA9IHtcbiAgICAgIHNpZ25hdHVyZSwgLy8gYXJyYXkgYXQgdGhpcyBwb2ludFxuICAgICAganNvbjogY29tYmluZWQubWFwKGVsZW1lbnQgPT4gZWxlbWVudC5qc29uKSxcbiAgICAgIHByb3RlY3RlZEhlYWRlcjoge2lzcywga2lkLCBhbGcsIGN0eSwgaWF0OiBNYXRoLm1heCguLi5jb21iaW5lZC5tYXAoZWxlbWVudCA9PiBlbGVtZW50LnByb3RlY3RlZEhlYWRlci5pYXQpKX1cbiAgICB9O1xuICAgIHJldHVybiB2ZXJpZmllZDtcbiAgfVxuICBhc3luYyBkaXNhbGxvd1dyaXRlKHRhZywgZXhpc3RpbmcsIHByb3Bvc2VkLCB2ZXJpZmllZCkgeyAvLyBiYWNrZGF0aW5nIGlzIGFsbG93ZWQuIChtZXJnaW5nKS5cbiAgICBpZiAoIXByb3Bvc2VkKSByZXR1cm4gJ2ludmFsaWQgc2lnbmF0dXJlJztcbiAgICBpZiAoIWV4aXN0aW5nKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIXRoaXMub3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpKSByZXR1cm4gJ25vdCBvd25lcic7XG4gICAgaWYgKCFhd2FpdCB0aGlzLnN1YmplY3RNYXRjaCh2ZXJpZmllZCkpIHJldHVybiAnd3JvbmcgaGFzaCc7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgb3duZXJNYXRjaChleGlzdGluZywgcHJvcG9zZWQpIHsgLy8gVE9ETzogRWl0aGVyIHRoZXkgbXVzdCBtYXRjaCAoYXMgaW4gc3VwZXIpIG9yIHRoZSBuZXcgcGF5bG9hZCBtdXN0IGluY2x1ZGUgdGhlIHByZXZpb3VzLlxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cblxuLy8gV2hlbiBydW5uaW5nIGluIE5vZGVKUywgdGhlIFNlY3VyaXR5IG9iamVjdCBpcyBhdmFpbGFibGUgZGlyZWN0bHkuXG4vLyBJdCBoYXMgYSBTdG9yYWdlIHByb3BlcnR5LCB3aGljaCBkZWZpbmVzIHN0b3JlL3JldHJpZXZlIChpbiBsaWIvc3RvcmFnZS5tanMpIHRvIEdFVC9QVVQgb25cbi8vIC4uLi86ZnVsbExhYmVsLzpwYXJ0MW9mVGFnLzpwYXJ0Mm9mVGFnLzpwYXJ0M29mVGFnLzpyZXN0T2ZUYWcuanNvblxuLy8gVGhlIFNlY3VyaXR5LlN0b3JhZ2UgY2FuIGJlIHNldCBieSBjbGllbnRzIHRvIHNvbWV0aGluZyBlbHNlLlxuLy9cbi8vIFdoZW4gcnVubmluZyBpbiBhIGJyb3dzZXIsIHdvcmtlci5qcyBvdmVycmlkZXMgdGhpcyB0byBzZW5kIG1lc3NhZ2VzIHRocm91Z2ggdGhlIEpTT04gUlBDXG4vLyB0byB0aGUgYXBwLCB3aGljaCB0aGVuIGFsc28gaGFzIGFuIG92ZXJyaWRhYmxlIFNlY3VyaXR5LlN0b3JhZ2UgdGhhdCBpcyBpbXBsZW1lbnRlZCB3aXRoIHRoZSBzYW1lIGNvZGUgYXMgYWJvdmUuXG5cbi8vIEJhc2ggaW4gc29tZSBuZXcgc3R1ZmY6XG5DcmVkZW50aWFscy5hdXRob3IgPSBudWxsO1xuQ3JlZGVudGlhbHMub3duZXIgPSBudWxsO1xuQ3JlZGVudGlhbHMuZW5jcnlwdGlvbiA9IG51bGw7IC8vIFRPRE86IHJlbmFtZSB0aGlzIHRvIGF1ZGllbmNlXG5DcmVkZW50aWFscy5zeW5jaHJvbml6ZSA9IGFzeW5jICguLi5zZXJ2aWNlcykgPT4geyAvLyBUT0RPOiByZW5hbWUgdGhpcyB0byBjb25uZWN0LlxuICAvLyBXZSBjYW4gZG8gYWxsIHRocmVlIGluIHBhcmFsbGVsIC0tIHdpdGhvdXQgd2FpdGluZyBmb3IgY29tcGxldGlvbiAtLSBiZWNhdXNlIGRlcGVuZGVuY2llcyB3aWxsIGdldCBzb3J0ZWQgb3V0IGJ5IHN5bmNocm9uaXplMS5cbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uc3luY2hyb25pemUoLi4uc2VydmljZXMpKSk7XG59O1xuQ3JlZGVudGlhbHMuc3luY2hyb25pemVkID0gYXN5bmMgKCkgPT4ge1xuICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhDcmVkZW50aWFscy5jb2xsZWN0aW9ucykubWFwKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5zeW5jaHJvbml6ZWQpKTtcbn1cbkNyZWRlbnRpYWxzLmRpc2Nvbm5lY3QgPSBhc3luYyAoLi4uc2VydmljZXMpID0+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMpLm1hcChjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZGlzY29ubmVjdCguLi5zZXJ2aWNlcykpKTtcbn1cblxuQ3JlZGVudGlhbHMuY3JlYXRlQXV0aG9yID0gYXN5bmMgKHByb21wdCkgPT4geyAvLyBDcmVhdGUgYSB1c2VyOlxuICAvLyBJZiBwcm9tcHQgaXMgJy0nLCBjcmVhdGVzIGFuIGludml0YXRpb24gYWNjb3VudCwgd2l0aCBhIG5vLW9wIHJlY292ZXJ5IGFuZCBubyBkZXZpY2UuXG4gIC8vIE90aGVyd2lzZSwgcHJvbXB0IGluZGljYXRlcyB0aGUgcmVjb3ZlcnkgcHJvbXB0cywgYW5kIHRoZSBhY2NvdW50IGhhcyB0aGF0IGFuZCBhIGRldmljZS5cbiAgaWYgKHByb21wdCA9PT0gJy0nKSByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0fSkpO1xuICBjb25zdCBbbG9jYWwsIHJlY292ZXJ5XSA9IGF3YWl0IFByb21pc2UuYWxsKFtDcmVkZW50aWFscy5jcmVhdGUoKSwgQ3JlZGVudGlhbHMuY3JlYXRlKHtwcm9tcHR9KV0pO1xuICByZXR1cm4gQ3JlZGVudGlhbHMuY3JlYXRlKGxvY2FsLCByZWNvdmVyeSk7XG59O1xuQ3JlZGVudGlhbHMuY2xhaW1JbnZpdGF0aW9uID0gYXN5bmMgKHRhZywgbmV3UHJvbXB0KSA9PiB7IC8vIENyZWF0ZXMgYSBsb2NhbCBkZXZpY2UgdGFnIGFuZCBhZGRzIGl0IHRvIHRoZSBnaXZlbiBpbnZpdGF0aW9uIHRhZyxcbiAgLy8gdXNpbmcgdGhlIHNlbGYtdmFsaWRhdGluZyByZWNvdmVyeSBtZW1iZXIgdGhhdCBpcyB0aGVuIHJlbW92ZWQgYW5kIGRlc3Ryb3llZC5cbiAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBDcmVkZW50aWFscy5jb2xsZWN0aW9ucy5UZWFtLnJldHJpZXZlKHt0YWd9KTtcbiAgaWYgKCF2ZXJpZmllZCkgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gdmVyaWZ5IGludml0YXRpb24gJHt0YWd9LmApO1xuICBjb25zdCBtZW1iZXJzID0gdmVyaWZpZWQuanNvbi5yZWNpcGllbnRzO1xuICBpZiAobWVtYmVycy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgSW52aXRhdGlvbnMgc2hvdWxkIGhhdmUgb25lIG1lbWJlcjogJHt0YWd9YCk7XG4gIGNvbnN0IG9sZFJlY292ZXJ5VGFnID0gbWVtYmVyc1swXS5oZWFkZXIua2lkO1xuICBjb25zdCBuZXdSZWNvdmVyeVRhZyA9IGF3YWl0IENyZWRlbnRpYWxzLmNyZWF0ZSh7cHJvbXB0OiBuZXdQcm9tcHR9KTtcbiAgY29uc3QgZGV2aWNlVGFnID0gYXdhaXQgQ3JlZGVudGlhbHMuY3JlYXRlKCk7XG5cbiAgLy8gV2UgbmVlZCB0byBhZGQgdGhlIG5ldyBtZW1iZXJzIGluIG9uZSBjaGFuZ2VNZW1iZXJzaGlwIHN0ZXAsIGFuZCB0aGVuIHJlbW92ZSB0aGUgb2xkUmVjb3ZlcnlUYWcgaW4gYSBzZWNvbmQgY2FsbCB0byBjaGFuZ2VNZW1iZXJzaGlwOlxuICAvLyBjaGFuZ2VNZW1iZXJzaGlwIHdpbGwgc2lnbiBieSBhbiBPTEQgbWVtYmVyIC0gSWYgaXQgc2lnbmVkIGJ5IG5ldyBtZW1iZXIgdGhhbiBwZW9wbGUgY291bGQgYm9vdHN0cmFwIHRoZW1zZWx2ZXMgb250byBhIHRlYW0uXG4gIC8vIEJ1dCBpZiB3ZSByZW1vdmUgdGhlIG9sZFJlY292ZXJ5IHRhZyBpbiB0aGUgc2FtZSBzdGVwIGFzIGFkZGluZyB0aGUgbmV3LCB0aGUgdGVhbSB3b3VsZCBiZSBzaWduZWQgYnkgc29tZW9uZSAodGhlIG9sZFJlY292ZXJ5VGFnKSB0aGF0XG4gIC8vIGlzIG5vIGxvbmdlciBhIG1lbWJlciwgYW5kIHNvIHRoZSB0ZWFtIHdvdWxkIG5vdCB2ZXJpZnkhXG4gIGF3YWl0IENyZWRlbnRpYWxzLmNoYW5nZU1lbWJlcnNoaXAoe3RhZywgYWRkOiBbZGV2aWNlVGFnLCBuZXdSZWNvdmVyeVRhZ10sIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5jaGFuZ2VNZW1iZXJzaGlwKHt0YWcsIHJlbW92ZTogW29sZFJlY292ZXJ5VGFnXX0pO1xuICBhd2FpdCBDcmVkZW50aWFscy5kZXN0cm95KG9sZFJlY292ZXJ5VGFnKTtcbiAgcmV0dXJuIHRhZztcbn07XG5cbi8vIHNldEFuc3dlciBtdXN0IGJlIHJlLXByb3ZpZGVkIHdoZW5ldmVyIHdlJ3JlIGFib3V0IHRvIGFjY2VzcyByZWNvdmVyeSBrZXkuXG5jb25zdCBhbnN3ZXJzID0ge307XG5DcmVkZW50aWFscy5zZXRBbnN3ZXIgPSAocHJvbXB0LCBhbnN3ZXIpID0+IGFuc3dlcnNbcHJvbXB0XSA9IGFuc3dlcjtcbkNyZWRlbnRpYWxzLmdldFVzZXJEZXZpY2VTZWNyZXQgPSBmdW5jdGlvbiBmbGV4c3RvcmVTZWNyZXQodGFnLCBwcm9tcHRTdHJpbmcpIHtcbiAgaWYgKCFwcm9tcHRTdHJpbmcpIHJldHVybiB0YWc7XG4gIGlmIChwcm9tcHRTdHJpbmcgPT09ICctJykgcmV0dXJuIHByb21wdFN0cmluZzsgLy8gU2VlIGNyZWF0ZUF1dGhvci5cbiAgY29uc3QgYW5zd2VyID0gYW5zd2Vyc1twcm9tcHRTdHJpbmddO1xuICBpZiAoYW5zd2VyKSByZXR1cm4gYW5zd2VyO1xuICAvLyBEaXN0cmlidXRlZCBTZWN1cml0eSB3aWxsIHRyeSBldmVyeXRoaW5nLiBVbmxlc3MgZ29pbmcgdGhyb3VnaCBhIHBhdGggYWJvdmUsIHdlIHdvdWxkIGxpa2Ugb3RoZXJzIHRvIHNpbGVudGx5IGZhaWwuXG4gIGNvbnNvbGUubG9nKGBBdHRlbXB0aW5nIGFjY2VzcyAke3RhZ30gd2l0aCBwcm9tcHQgJyR7cHJvbXB0U3RyaW5nfScuYCk7XG4gIHJldHVybiBcIm5vdCBhIHNlY3JldFwiOyAvLyB0b2RvOiBjcnlwdG8gcmFuZG9tXG59O1xuXG5cbi8vIFRoZXNlIHR3byBhcmUgdXNlZCBkaXJlY3RseSBieSBkaXN0cmlidXRlZC1zZWN1cml0eS5cbkNyZWRlbnRpYWxzLlN0b3JhZ2UucmV0cmlldmUgPSBhc3luYyAoY29sbGVjdGlvbk5hbWUsIHRhZykgPT4ge1xuICBjb25zdCBjb2xsZWN0aW9uID0gQ3JlZGVudGlhbHMuY29sbGVjdGlvbnNbY29sbGVjdGlvbk5hbWVdO1xuICAvLyBObyBuZWVkIHRvIHZlcmlmeSwgYXMgZGlzdHJpYnV0ZWQtc2VjdXJpdHkgZG9lcyB0aGF0IGl0c2VsZiBxdWl0ZSBjYXJlZnVsbHkgYW5kIHRlYW0tYXdhcmUuXG4gIGlmIChjb2xsZWN0aW9uTmFtZSA9PT0gJ0VuY3J5cHRpb25LZXknKSBhd2FpdCBjb2xsZWN0aW9uLnN5bmNocm9uaXplMSh0YWcpO1xuICBpZiAoY29sbGVjdGlvbk5hbWUgPT09ICdLZXlSZWNvdmVyeScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7XG4gIC8vaWYgKGNvbGxlY3Rpb25OYW1lID09PSAnVGVhbScpIGF3YWl0IGNvbGxlY3Rpb24uc3luY2hyb25pemUxKHRhZyk7ICAgIC8vIFRoaXMgd291bGQgZ28gY2lyY3VsYXIuIFNob3VsZCBpdD8gRG8gd2UgbmVlZCBpdD9cbiAgY29uc3QgZGF0YSA9IGF3YWl0IGNvbGxlY3Rpb24uZ2V0KHRhZyk7XG4gIC8vIEhvd2V2ZXIsIHNpbmNlIHdlIGhhdmUgYnlwYXNzZWQgQ29sbGVjdGlvbi5yZXRyaWV2ZSwgd2UgbWF5YmVJbmZsYXRlIGhlcmUuXG4gIHJldHVybiBDb2xsZWN0aW9uLm1heWJlSW5mbGF0ZShkYXRhKTtcbn1cbmNvbnN0IEVNUFRZX1NUUklOR19IQVNIID0gXCI0N0RFUXBqOEhCU2EtX1RJbVctNUpDZXVRZVJrbTVOTXBKV1pHM2hTdUZVXCI7IC8vIEhhc2ggb2YgYW4gZW1wdHkgc3RyaW5nLlxuQ3JlZGVudGlhbHMuU3RvcmFnZS5zdG9yZSA9IGFzeW5jIChjb2xsZWN0aW9uTmFtZSwgdGFnLCBzaWduYXR1cmUpID0+IHtcbiAgLy8gTm8gbmVlZCB0byBlbmNyeXB0L3NpZ24gYXMgYnkgc3RvcmUsIHNpbmNlIGRpc3RyaWJ1dGVkLXNlY3VyaXR5IGRvZXMgdGhhdCBpbiBhIGNpcmN1bGFyaXR5LWF3YXJlIHdheS5cbiAgLy8gSG93ZXZlciwgd2UgZG8gY3VycmVudGx5IG5lZWQgdG8gZmluZCBvdXQgb2YgdGhlIHNpZ25hdHVyZSBoYXMgYSBwYXlsb2FkIGFuZCBwdXNoXG4gIC8vIFRPRE86IE1vZGlmeSBkaXN0LXNlYyB0byBoYXZlIGEgc2VwYXJhdGUgc3RvcmUvZGVsZXRlLCByYXRoZXIgdGhhbiBoYXZpbmcgdG8gZmlndXJlIHRoaXMgb3V0IGhlcmUuXG4gIGNvbnN0IGNsYWltcyA9IENyZWRlbnRpYWxzLmRlY29kZUNsYWltcyhzaWduYXR1cmUpO1xuICBjb25zdCBlbXB0eVBheWxvYWQgPSBjbGFpbXM/LnN1YiA9PT0gRU1QVFlfU1RSSU5HX0hBU0g7XG5cbiAgY29uc3QgY29sbGVjdGlvbiA9IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW2NvbGxlY3Rpb25OYW1lXTtcbiAgc2lnbmF0dXJlID0gQ29sbGVjdGlvbi5lbnN1cmVTdHJpbmcoc2lnbmF0dXJlKTtcbiAgY29uc3Qgc3RvcmVkID0gYXdhaXQgKGVtcHR5UGF5bG9hZCA/IGNvbGxlY3Rpb24uZGVsZXRlKHRhZywgc2lnbmF0dXJlKSA6IGNvbGxlY3Rpb24ucHV0KHRhZywgc2lnbmF0dXJlKSk7XG4gIGlmIChzdG9yZWQgIT09IHRhZykgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gd3JpdGUgY3JlZGVudGlhbCAke3RhZ30uYCk7XG4gIGlmICh0YWcpIGF3YWl0IGNvbGxlY3Rpb24ucHVzaChlbXB0eVBheWxvYWQgPyAnZGVsZXRlJzogJ3B1dCcsIHRhZywgc2lnbmF0dXJlKTtcbiAgcmV0dXJuIHRhZztcbn07XG5DcmVkZW50aWFscy5TdG9yYWdlLmRlc3Ryb3kgPSBhc3luYyAoKSA9PiB7XG4gIGF3YWl0IENyZWRlbnRpYWxzLmNsZWFyKCk7IC8vIFdpcGUgZnJvbSBsaXZlIG1lbW9yeS5cbiAgZm9yIChsZXQgY29sbGVjdGlvbiBvZiBPYmplY3QudmFsdWVzKENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zKSkge1xuICAgIGF3YWl0IGNvbGxlY3Rpb24uZGVzdHJveSgpO1xuICB9XG4gIGF3YWl0IENyZWRlbnRpYWxzLndpcGVEZXZpY2VLZXlzKCk7IC8vIE5vdCBpbmNsdWRlZCBpbiB0aGUgYWJvdmUuXG59O1xuQ3JlZGVudGlhbHMuY29sbGVjdGlvbnMgPSB7fTtcbmV4cG9ydCB7IENyZWRlbnRpYWxzLCBTdG9yYWdlTG9jYWwgfTtcblsnRW5jcnlwdGlvbktleScsICdLZXlSZWNvdmVyeScsICdUZWFtJ10uZm9yRWFjaChuYW1lID0+IENyZWRlbnRpYWxzLmNvbGxlY3Rpb25zW25hbWVdID0gbmV3IE11dGFibGVDb2xsZWN0aW9uKHtuYW1lfSkpO1xuIiwiaW1wb3J0IENyZWRlbnRpYWxzIGZyb20gJ0BraTFyMHkvZGlzdHJpYnV0ZWQtc2VjdXJpdHknO1xuaW1wb3J0IHV1aWQ0IGZyb20gJ3V1aWQ0JztcbmltcG9ydCBTeW5jaHJvbml6ZXIgZnJvbSAnLi9saWIvc3luY2hyb25pemVyLm1qcyc7XG5pbXBvcnQgeyBDb2xsZWN0aW9uLCBJbW11dGFibGVDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgVmVyc2lvbkNvbGxlY3Rpb24sIFN0b3JhZ2VMb2NhbCB9IGZyb20gICcuL2xpYi9jb2xsZWN0aW9ucy5tanMnO1xuaW1wb3J0IHsgV2ViUlRDLCBQcm9taXNlV2ViUlRDLCBTaGFyZWRXZWJSVEMgfSBmcm9tICcuL2xpYi93ZWJydGMubWpzJztcbmltcG9ydCB7IHZlcnNpb24sIG5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBzdG9yYWdlTmFtZSB9IGZyb20gJy4vbGliL3ZlcnNpb24ubWpzJztcblxuY29uc29sZS5sb2coYCR7bmFtZX0gJHt2ZXJzaW9ufSBmcm9tICR7aW1wb3J0Lm1ldGEudXJsfS5gKTtcblxuZXhwb3J0IHsgQ3JlZGVudGlhbHMsIENvbGxlY3Rpb24sIEltbXV0YWJsZUNvbGxlY3Rpb24sIE11dGFibGVDb2xsZWN0aW9uLCBWZXJzaW9uZWRDb2xsZWN0aW9uLCBWZXJzaW9uQ29sbGVjdGlvbiwgU3luY2hyb25pemVyLCBXZWJSVEMsIFByb21pc2VXZWJSVEMsIFNoYXJlZFdlYlJUQywgbmFtZSwgdmVyc2lvbiwgc3RvcmFnZU5hbWUsIHN0b3JhZ2VWZXJzaW9uLCBTdG9yYWdlTG9jYWwsIHV1aWQ0IH07XG5leHBvcnQgZGVmYXVsdCB7IENyZWRlbnRpYWxzLCBDb2xsZWN0aW9uLCBJbW11dGFibGVDb2xsZWN0aW9uLCBNdXRhYmxlQ29sbGVjdGlvbiwgVmVyc2lvbmVkQ29sbGVjdGlvbiwgVmVyc2lvbkNvbGxlY3Rpb24sIFN5bmNocm9uaXplciwgV2ViUlRDLCBQcm9taXNlV2ViUlRDLCBTaGFyZWRXZWJSVEMsIG5hbWUsIHZlcnNpb24sICBzdG9yYWdlTmFtZSwgc3RvcmFnZVZlcnNpb24sIFN0b3JhZ2VMb2NhbCwgdXVpZDQgfTtcbiJdLCJuYW1lcyI6WyJwa2cuZGVmYXVsdCIsIlN0b3JhZ2VMb2NhbCJdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsTUFBTSxXQUFXLEdBQUcsd0VBQXdFO0FBQzVGLFNBQVMsS0FBSyxDQUFDLElBQUksRUFBRTtBQUNyQixFQUFFLE9BQU8sV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7QUFDL0I7O0FBRUE7QUFDQTtBQUNBLFNBQVMsS0FBSyxHQUFHO0FBQ2pCLEVBQUUsSUFBSSxRQUFRLEdBQUcsR0FBRyxDQUFDLGVBQWUsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDO0FBQ2hELEVBQUUsSUFBSSxJQUFJLEdBQUcsUUFBUSxDQUFDLFFBQVEsRUFBRTtBQUNoQyxFQUFFLEdBQUcsQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDO0FBQy9CLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0FBQ2xEO0FBQ0EsS0FBSyxDQUFDLEtBQUssR0FBRyxLQUFLOztBQ2JuQjtBQUNBLFdBQWUsVUFBVTs7QUNHekI7O0FBRUEsTUFBTSxVQUFVLEdBQUc7QUFDbkIsRUFBRSxFQUFFLElBQUksRUFBRSw4QkFBOEIsQ0FBQztBQUN6QztBQUNBLEVBQUUsRUFBRSxJQUFJLEVBQUUsd0JBQXdCLEVBQUU7QUFDcEM7QUFDQTtBQUNBO0FBQ0EsRUFBRSxFQUFFLElBQUksRUFBRSxzQ0FBc0MsRUFBRSxRQUFRLEVBQUUsa0lBQWtJLEVBQUUsVUFBVSxFQUFFLGtFQUFrRTtBQUM5UTtBQUNBO0FBQ0E7QUFDQSxDQUFDOztBQUVEO0FBQ0E7QUFDTyxNQUFNLE1BQU0sQ0FBQztBQUNwQixFQUFFLFdBQVcsQ0FBQyxDQUFDLEtBQUssR0FBRyxFQUFFLEVBQUUsYUFBYSxHQUFHLElBQUksRUFBRSxJQUFJLEdBQUcsS0FBSyxFQUFFLEVBQUUsS0FBSyxH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Q0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksSUFBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxVQUFVLEVBQUUsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUMsSUFBSSxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssR0FBRSxDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFDLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsTUFBTSxZQUFZLFNBQVMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxNQUFNLENBQUMsQ0FBQyxFQUFFLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFDLENBQUMsTUFBTSxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEVBQUUsSUFBSSxFQUFFLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU0sQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxF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
