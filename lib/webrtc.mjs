const {default:wrtc} = await ((typeof(process) !== 'undefined') ? import('wrtc') : {default: globalThis});

// Utility wrapper around RTCPeerConnection.
// Currently supports data, via createDataChannel().
// When something triggers negotiation (such as the above method), it will generate calls to signal(), which needs to be defined by subclasses.
export class WebRTC {
  constructor({label = '', rtcConfiguration = {}, debug = false} = {}) {
    this.label = label;
    this.configuration = rtcConfiguration;
    this.debug = debug;
    this.resetPeer();
  }
  signal(type, message) { // Subclasses must override or extend. Default just logs.
    this.log('sending', type, type.length, JSON.stringify(message).length);
  }

  peerVersion = 0;
  resetPeer() {
    const peer = this.peer = new wrtc.RTCPeerConnection(this.rtcConfiguration);
    peer.versionId = this.peerVersion++;
    this.log('new peer', peer.versionId);
    peer.addEventListener('negotiationneeded', event => this.negotiationneeded(event));
    // The spec says that a null candidate should not be sent, but that an empty string candidate should.
    // But Safari gets errors either way.
    peer.addEventListener('icecandidate',
			  event => {
			    if (!event.candidate || !event.candidate.candidate) this.endIce?.();
			    // event.candidate && event.candidate.candidate &&
			    else this.signal('icecandidate', event.candidate);
			  });
    // I don't think anyone actually signals this. Instead, they reject from addIceCandidate, which we handle the same.
    peer.addEventListener('icecandidateerror', error => this.icecandidateerror(error));
    peer.addEventListener('connectionstatechange', event => this.connectionStateChange(this.peer.connectionState));
  }
  createDataChannel(label = "data", channelOptions = {}) { // Promise resolves when the channel is open (implying negotiation has happened).
    //this.log('createDataChannel');
    return new Promise(resolve => {
      const channel = this.peer.createDataChannel(label, channelOptions);
      channel.onopen = _ => resolve(channel);
    });
  }
  close() {
    this.peer.close(); // Will trigger a state change on the other side, but not this side...
    this.resetPeer();  // ...so reset this side now.
  }
  connectionStateChange(state) {
    this.log('state change:', state);
    if (state === 'disconnected') this.resetPeer(); // Other behavior are reasonable, tolo.
  }
  negotiationneeded() { // Something has changed locally (new stream, or network change), such that we have to start negotiation.
    
    //this.log('negotiationnneded');
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
    //this.log('received offer', offer);
    this.peer.setRemoteDescription(offer)
      .then(_ => this.peer.createAnswer())
      .then(answer => this.peer.setLocalDescription(answer)) // promise does not resolve to answer
      .then(_ => this.signal('answer', this.peer.localDescription));
  }
  answer(answer) { // Handler for finishing the signaling process that we started.
    //this.log('received answer', answer);
    this.peer.setRemoteDescription(answer);
  }
  icecandidate(iceCandidate) { // Handler for a new candidate received from the other end through signaling.
    //this.log('received iceCandidate', iceCandidate);
    this.peer.addIceCandidate(iceCandidate).catch(error => this.icecandidateError(error));
  }
  log(...rest) {
    if (this.debug) console.log(this.label, ...rest);
  }
  logError(label, eventOrException) {
    const data = [this.label, ...this.constructor.gatherErrorData(label, eventOrException)];
    console.error.apply(console, data);
    return data;
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

export class PromiseWebRTC extends WebRTC {
  // Extends WebRTC.signal() such that:
  // - instance.signals answers a promise that will resolve with an array of signal messages.
  // - istance.signals = [...signalMessages] will dispatch those messages.
  //
  // For example, suppose peer1 and peer2 are instances of this.
  // 0. Something triggers negotiation on peer1 (such as calling peer1.createDataChannel()). 
  // 1. peer1.signals resolves with <signal1>, a POJO to be conveyed to peer2.
  // 2. Set peer2.signals = <signal1>.
  // 3. peer2.signals resolves with <signal2>, a POJO to be conveyed to peer1.
  // 4. Set peer1.signals = <signal2>.
  // 5. Data flows, but each side whould grab a new signals promise and be prepared to act if it resolves.
  get signals() { // Returns a promise that resolve to the signal messaging when ice candidate gathering is complete.
    return this._signalPromise ||= new Promise(resolve => this._signalReady = resolve);
  }
  set signals(data) { // Set with the signals received from the other end.
    data.forEach(([type, message]) => this[type](message));
  }
  async endIce() {
    if (!this._signalPromise) {
      this.logError('ice', "End of ICE without anything waiting on signals.");
      return;
    }
    this._signalReady(this.sending);
    delete this._signalPromise;
    this.sending = [];
  }
  sending = [];
  signal(type, message) {
    super.signal(type, message);
    this.sending.push([type, message]);
  }
  getDataChannelPromise() {
    return new Promise(resolve => { // Resolves to an open data channel.
      this.peer.ondatachannel = event => resolve(event.channel);
    });
  }
}
