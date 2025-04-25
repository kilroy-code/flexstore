import uuid4 from 'uuid4';
import { SharedWebRTC, Synchronizer, Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection, storageVersion } from '../index.mjs';

const { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect, expectAsync, URL } = globalThis;

Object.assign(globalThis, {Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection, SharedWebRTC}); // for debugging
const baseURL = globalThis.document?.baseURI || 'http://localhost:3000';

const CONNECT_TIME = 50e3; // normally
const unique = uuid4();

describe('Synchronizer', function () {

  describe('server relay', function () {
    describe('basic data channel connection', function () {
      it('smokes', async function () {
	const tag = 'testing'+unique;
	const message = 'echo';

	const url = new URL(`/flexstore/requestDataChannel/test/echo/${tag}`, baseURL);
	const connection = SharedWebRTC.ensure({service: url.href});
	const dataChannelPromise = connection.createDataChannel('echo');
	// Send them our signals:
	const outboundSignals = await connection.signals;
	const body = JSON.stringify(outboundSignals);
	const request = await fetch(url, {method: 'POST', headers: {"Content-Type": "application/json"}, body});
	const response = await request.text();
	// And accept their response:
	connection.signals = JSON.parse(response);

	// When the channel opens, send a message and expect the echo.
	const dataChannel = await dataChannelPromise;
	dataChannel.send(message);
	const echo = await new Promise(resolve => {
	  dataChannel.onmessage = event => resolve(event.data);
	});
	expect(echo).toBe(message);
	dataChannel.close();
      }, CONNECT_TIME);
    });
    describe('Credentials synchronization and rebuilding', function () {
      // This is more of a system test than a unit test, as there is a lot going on here.
      let collection = new MutableCollection({name: 'frogs' + unique}),
	  frog, author, owner,
	  question = "Airspeed?",
	  answer = "African or Eurpopean?",
	  service = new URL('/flexstore/sync', baseURL).href;
      async function syncAll() { // Synchronize Credentials and frogs with the service.
	await Credentials.synchronize(service);
	await Credentials.synchronized();
	await collection.synchronize(service);
	await collection.synchronized;
      }
      async function killAll() { // Destroy the frog and all the keys under owner (including local device keys).
	expect(await collection.retrieve({tag: frog})).toBeTruthy(); // Now you see it...
	await collection.remove({tag: frog, author, owner});
	await Credentials.destroy({tag: owner, recursiveMembers: true});
	expect(await collection.retrieve({tag: frog})).toBe(''); // ... and now you don't.
      }
      beforeAll(async function () {
	// Setup:
	//Credentials.collections.EncryptionKey.debug = Credentials.collections.KeyRecovery.debug = true;	 // FIXME remove
	// 1. Create an invitation, and immediately claim it.
	await Credentials.ready;
	author = await Credentials.createAuthor('-'); // Create invite.
	Credentials.setAnswer(question, answer); // Claiming is a two step process.
	await Credentials.claimInvitation(author, question);
	// 2. Create an owning group from the frog, that includes the author we just created.
	owner = await Credentials.create(author); // Create owner team with that member.
	// 3. Store the frog with these credentials.
	frog = await collection.store({title: 'bull'}, {author, owner}); // Store item with that author/owner
	// 4. Sychronize to service, disconnect, and REMOVE EVERYTHING LOCALLY.
	await syncAll();
	await Credentials.disconnect();
	await collection.disconnect();
	await killAll();
	console.log('synchronization and rebuilding setup complete');
      }, 2 * CONNECT_TIME);
      afterAll(async function () {
	await killAll(); // Locally and on on-server, because we're still connected.
	await new Promise(resolve => setTimeout(resolve, 2e3));
	await Credentials.disconnect();
	await collection.disconnect();
	await new Promise(resolve => setTimeout(resolve, 2e3));
	console.log('synchronization and rebuilding teardown complete');
      }, 10e3);
      describe('recreation', function () {
	let firstVerified;
	beforeAll(async function () { // Pull into this empty local storage, as if on a new machine.
	  await syncAll();
	  Credentials.setAnswer(question, answer);
	  firstVerified = await collection.retrieve({tag: frog});
	}, CONNECT_TIME);
	it('has collection.', async function () {
	  expect(firstVerified.json).toEqual({title: 'bull'}); // We got the data.
	});
	it('can re-store because we have the credentials.', async function () {
	  await collection.store({title: 'leopard'}, {tag: frog, author, owner});
	  const verified = await collection.retrieve({tag: frog}); // So the credentials came over, too.
	  expect(verified.json).toEqual({title: 'leopard'});
	  expect(verified.protectedHeader.act).toEqual(author);
	  expect(verified.protectedHeader.iss).toEqual(owner);
	});
      });
    });
  });

  describe('Multiplexed', function () {
    describe('webrtc', function () {
      describe('relay', function () {
	// Here are two different synchronizers on the same computer, that each connect to the same relay server.
	// They will each get their own dataChannel to a mirroring pair of peers on the relay server,
	// but they will happen to use the same SharedWebRTC connection.
	let serviceName = new URL('/flexstore/sync', baseURL).href;
	let synchronizer1, synchronizer2;

	beforeAll(async function () {
	  synchronizer1 = new Synchronizer({serviceName, channelName: 'ImmutableCollection/relay-webrtc-1' + unique});
	  synchronizer2 = new Synchronizer({serviceName, channelName: 'ImmutableCollection/relay-webrtc-2' + unique});
	  synchronizer1.connectChannel();
	  synchronizer2.connectChannel();
	  await Promise.all([synchronizer1.dataChannelPromise, synchronizer2.dataChannelPromise]);
	});
	afterAll(async function () {
	  await Promise.all([synchronizer1.disconnect(), synchronizer2.disconnect()]);
	  await new Promise(resolve => setTimeout(resolve, 1e3)); // fixme: we should include change of state in disconnect promise
	  expect(synchronizer1.connection.peer.connectionState).toBe('new');
	  expect(synchronizer2.connection.peer.connectionState).toBe('new');
	});
	it('connects peer through each synchronizer.', function () {
	  expect(synchronizer1.connection.peer.connectionState).toBe('connected');
	  expect(synchronizer2.connection.peer.connectionState).toBe('connected');
	});
	it('connects one datachannel for each synchronizer.', async function () {
	  // Here we are reaching under the hood, and assuming multiplexed
	  const dataChannel1 = await synchronizer1.dataChannelPromise;
	  expect(synchronizer1.connection.dataChannels.get(synchronizer1.channelName)).toBe(dataChannel1);
	  expect(dataChannel1.label).toBe(synchronizer1.channelName);

	  const dataChannel2 = await synchronizer2.dataChannelPromise;
	  expect(synchronizer2.connection.dataChannels.get(synchronizer2.channelName)).toBe(dataChannel2);
	  expect(dataChannel2.label).toBe(synchronizer2.channelName);

	  expect(dataChannel1).not.toBe(dataChannel2);
	});
	it('can communicate over dataChannel.', async function () {
	  const v1 = await synchronizer1.version;
	  const v2 = await synchronizer2.version;
	  expect(v1).toBe(v2);
	  expect(typeof v1).toBe('number');
	});
      });

      describe('rendevous', function () {
	// Here are two different synchronizers on the same computer, that each CONNECT through
	// a rendevous server to a matching pair of synchronizers (that also happen to be running in this computer).
	// They will each get their own dataChannel to their peer, and they use different SharedWebRTC connection that we give them
	// directly, because the default behavior would try to use the same one.
	let serviceName = new URL('/flexstore/signal/rendevous-test' + unique, baseURL).href;
	// FIXME: let multiplex:'negotiated' come from serviceName
	let synchronizer1a, synchronizer2a, synchronizer1b, synchronizer2b;
	beforeAll(async function () {
	  synchronizer1a = new Synchronizer({serviceName, channelName: 'ImmutableCollection/rendevous-webrtc-1'});
	  synchronizer2a = new Synchronizer({serviceName, maxVersion: storageVersion+1, channelName: 'ImmutableCollection/rendevous-webrtc-2'});

	  // We want to test as if the next two synchronizers are running in another Javascript.
	  // So we will have to pass in a separate webrtc.
	  let connection = new SharedWebRTC({service: serviceName, label: 'secondservice', multiplex: synchronizer1a.connection.multiplex});
	  synchronizer1b = new Synchronizer({serviceName, connection, channelName: 'ImmutableCollection/rendevous-webrtc-1'});
	  synchronizer2b = new Synchronizer({serviceName, connection, maxVersion: storageVersion+1, channelName: 'ImmutableCollection/rendevous-webrtc-2'});

	  synchronizer1a.connectChannel();
	  synchronizer2a.connectChannel();
	  synchronizer1b.connectChannel();
	  synchronizer2b.connectChannel();
	  await Promise.all([
	    synchronizer1a.dataChannelPromise, synchronizer2a.dataChannelPromise,
	    synchronizer1b.dataChannelPromise, synchronizer2b.dataChannelPromise
	  ]);
	}, 15e3); // Firefox. 
	afterAll(async function () {
	  await Promise.all([
	    synchronizer1a.disconnect(),
	    synchronizer2a.disconnect(),
	    synchronizer1b.closed, // When the other end is dropped, this side's closed promise fulfills.
	    synchronizer2b.closed
	  ]);
	  expect(synchronizer1a.connection.peer.connectionState).toBe('new');
	  expect(synchronizer2a.connection.peer.connectionState).toBe('new');
	  // We don't have a promise indicating when the connection itself is closed, but it should be quickly after synchronizer.closed.
	  await new Promise(resolve => setTimeout(resolve, 100));
	  expect(synchronizer1b.connection.peer.connectionState).toBe('new');
	  expect(synchronizer2b.connection.peer.connectionState).toBe('new');
	});
	it('connects peer through each synchronizer.', function () {
	  expect(synchronizer1a.connection.peer.connectionState).toBe('connected');
	  expect(synchronizer2a.connection.peer.connectionState).toBe('connected');
	  expect(synchronizer1b.connection.peer.connectionState).toBe('connected');
	  expect(synchronizer2b.connection.peer.connectionState).toBe('connected');
	});
	it('connects one datachannel for each synchronizer.', async function () {
	  // Here we are reaching under the hood, and assuming multiplexed
	  const dataChannel1a = await synchronizer1a.dataChannelPromise;
	  expect(synchronizer1a.connection.dataChannels.get(synchronizer1a.channelName)).toBe(dataChannel1a);
	  expect(dataChannel1a.label).toBe(synchronizer1a.channelName);

	  const dataChannel1b = await synchronizer1b.dataChannelPromise;
	  expect(synchronizer1b.connection.dataChannels.get(synchronizer1b.channelName)).toBe(dataChannel1b);
	  expect(dataChannel1b.label).toBe(synchronizer1b.channelName);

	  const dataChannel2a = await synchronizer2a.dataChannelPromise;
	  expect(synchronizer2a.connection.dataChannels.get(synchronizer2a.channelName)).toBe(dataChannel2a);
	  expect(dataChannel2a.label).toBe(synchronizer2a.channelName);

	  const dataChannel2b = await synchronizer2b.dataChannelPromise;
	  expect(synchronizer2b.connection.dataChannels.get(synchronizer2b.channelName)).toBe(dataChannel2b);
	  expect(dataChannel2b.label).toBe(synchronizer2b.channelName);
	});
	it('can communicate over dataChannel.', async function () {
	  expect(await synchronizer1a.version).toBe(storageVersion);
	  expect(await synchronizer1b.version).toBe(storageVersion);

	  expect(await synchronizer2a.version).toBe(storageVersion+1);
	  expect(await synchronizer2b.version).toBe(storageVersion+1);
	});
      });
    });
  });

  describe('peers', function () {
    const base = new URL('/flexstore', baseURL).href;
    function makeCollection({name = 'test', kind = ImmutableCollection, ...props}) { return new kind({name, ...props});}
    function makeSynchronizer({serviceName = 'peer', channelName = 'peer', ...props}) {
      return new Synchronizer({serviceName, channelName, ...props, collection: makeCollection(props)});
    }
    async function connect(a, b) { // Connect two synchronizer instances.
      const aSignals = await a.startConnection();
      const bSignals = await b.startConnection(aSignals);
      a.completeConnection(bSignals);
    }
    let a, b;
    function setup(aProps = {}, bProps = {}, doConnect = true) {
      a = makeSynchronizer({name: 'a', serviceName: 'peerB', ...aProps});
      b = makeSynchronizer({name: 'b', serviceName: 'peerA', ...bProps});
      return doConnect && connect(a, b);
    }
    async function teardown() {
      await a.disconnect();
    }

    describe('initializations', function () {
      const collection = new ImmutableCollection({name: 'a'});
      describe('label and url', function () {
	let a;
	beforeAll(function () {
	  a = new Synchronizer({serviceName: 'a', collection});
	});
	it('has label.', async function() {
	  expect(a.label.startsWith('ImmutableCollection/a')).toBeTruthy();
	});
	it('has connectionURL.', function () {
	  expect(a.connectionURL.startsWith(`${a.serviceName}/ImmutableCollection/a`)).toBeTruthy();
	});
      });
      describe('hostRequestBase', function () {
	it('is built on url serviceName', function () {
	  const a = new Synchronizer({serviceName: base, collection});
	  expect(makeSynchronizer(a).hostRequestBase).toBe(`${base}/ImmutableCollection/a`);
	});
	it('is empty if serviceName is not a url', function () {
	  const a = new Synchronizer({serviceName: 'foo', collection});
	  const b = new Synchronizer({serviceName: './foo', collection});
	  expect(a.hostRequestBase).toBeFalsy();
	  expect(b.hostRequestBase).toBeFalsy();
	});
      });
    });

    describe('connected', function () {
      afterEach(async function () {
	if (a) {
	  await a.disconnect();
	  expect(a.connection.peer.connectionState).toBe('new');
	}
	if (b) {
	  await b.closed;
	  expect(b.connection.peer.connectionState).toBe('new');
	}
      });
      describe('basic connection between two peers on the same computer with direct signalling', function () {
	it('changes state appropriately.', async function () {
	  await setup({}, {});
	  expect(await a.dataChannelPromise).toBeTruthy();
	  expect(await b.dataChannelPromise).toBeTruthy();
	  expect(a.connection.peer.connectionState).toBe('connected');
	  expect(b.connection.peer.connectionState).toBe('connected');
	  await a.reportConnection();
	  await b.reportConnection();
	  expect(a.protocol).toBe(b.protocol);
	  expect(a.protocol).toBeTruthy();
	  expect(a.candidateType).toBeTruthy();
	  await teardown();
	}, CONNECT_TIME);
	describe('version/send/receive', function () {
	  it('agrees on max.', async function () {
	    await setup({minVersion: 1, maxVersion: 2}, {minVersion: 1, maxVersion: 3});
	    expect(await a.version).toBe(2);
	    expect(await b.version).toBe(2);
	    await teardown();
	  }, CONNECT_TIME);
	  it('agrees on failure.', async function () {
	    await setup({minVersion: 1, maxVersion: 2}, {minVersion: 3, maxVersion: 4});
	    expect(await a.version).toBe(0);
	    expect(await b.version).toBe(0);
	    await teardown();
	  }, CONNECT_TIME);
	});
	it('synchronizes empty.', async function () {
	  await setup({}, {});
	  await a.startedSynchronization;
	  expect(await a.completedSynchronization).toBe(0);
	  expect(await b.completedSynchronization).toBe(0);
	  await teardown();
	}, CONNECT_TIME);
      });

      describe('authorized', function () {
	async function clean(synchronizer) {
	  await synchronizer.collection.disconnect();
	  const list = await synchronizer.collection.list('skipSync');
	  await Promise.all(list.map(tag => synchronizer.collection.remove({tag})));
	  expect(await synchronizer.collection.list.length).toBe(0);
	}
	let author;
	beforeAll(async function () {
	  author = Credentials.author = await Credentials.createAuthor('test pin:');
	  Credentials.owner = '';
	}, 10e3);
	afterAll(async function () {
	  a && await clean(a);
	  b && await clean(b);
	  await Credentials.destroy({tag: Credentials.author, recursiveMembers: true});
	}, 15e3);
	function testCollection(kind, label = kind.name) {
	  describe(label, function () {
	    it('basic sync', async function () {
	      let aCol = new kind({name: 'a-basic', channelName: 'basic'}),
		  bCol = new kind({name: 'b-basic', channelName: 'basic'});

	      const tag1 = await aCol.store('abcd');
	      const tag2 = await aCol.store('1234');
	      await aCol.synchronize(bCol);
	      await bCol.synchronize(aCol);
	      a = aCol.synchronizers.get(bCol);
	      b = bCol.synchronizers.get(aCol);

	      expect(await b.completedSynchronization).toBe(2);
	      expect((await b.collection.retrieve({tag: tag1})).text).toBe('abcd');
	      expect((await b.collection.retrieve({tag: tag2})).text).toBe('1234');
	      await clean(a);
	      await clean(b);
	    }, CONNECT_TIME);

	    describe('hosted or lan', function () {
	      function recordUpdates(event) {
		const updates = event.target.updates ||= [];
		updates.push([event.detail.synchronizer ? 'sync' : 'no sync', event.detail.text]);
	      }
	      it('relay can connect.', async function () {
		let serviceName = new URL('/flexstore/sync', baseURL).href;
		let name = 'testRelay' + unique;

		// A and B are not talking directly to each other. They are both connecting to a relay.
		const collectionA = new kind({name});
		const collectionB = new kind({name, serviceKey: 'secondrelay'});
		collectionA.onupdate = recordUpdates;
		collectionB.onupdate = recordUpdates;
		a = b = null;

		collectionA.synchronize(serviceName);
		collectionB.synchronize(serviceName);
		await collectionA.synchronized;
		await collectionB.synchronized;

		const tag = await collectionA.store("foo");
		await new Promise(resolve => setTimeout(resolve, 1e3)); // give it a chance to propagate
		expect(await collectionB.retrieve(tag)).toBeTruthy(); // Now we know that B has seen the update.

		await collectionA.remove({tag});
		expect(await collectionA.retrieve({tag})).toBeFalsy();
		await new Promise(resolve => setTimeout(resolve, 2e3)); // give it a chance to propagate on slow server
		expect(await collectionB.retrieve({tag})).toBeFalsy();
		// Both collections get two events: non-empty text, and then emptyy text.
		// Updates events on A have no synchronizer (they came from us).
		expect(collectionA.updates).toEqual([['no sync', 'foo'], ['no sync', '']]);
		// Update events on B have a synchronizer (they came from the relay);
		expect(collectionB.updates).toEqual([['sync', 'foo'], ['sync', '']]);

		await collectionA.disconnect();
		await collectionB.disconnect();
	      }, CONNECT_TIME);
	      it('rendevous can connect.', async function () {
		const serviceName = new URL('/flexstore/signal/' + unique, baseURL).href;
		// A and B are talking directly to each other. They are merely connecting through a rendevous
		const collectionA = new kind({name: 'testRendezvous'});
		const collectionB = new kind({name: 'testRendezvous', serviceKey: 'secondrendevous'});
		collectionA.onupdate = recordUpdates;
		collectionB.onupdate = recordUpdates;
		a = b = null;

		collectionA.synchronize(serviceName);
		collectionB.synchronize(serviceName);

		await collectionA.synchronized;
		await collectionB.synchronized;

		const tag = await collectionA.store("bar");
		expect(await collectionB.retrieve(tag)).toBeTruthy(); // Now we know that B has seen the update.

		await collectionA.remove({tag});
		expect(await collectionA.retrieve({tag})).toBeFalsy();
		await new Promise(resolve => setTimeout(resolve, 1e3)); // give it a chance to propagate
		expect(await collectionB.retrieve({tag})).toBeFalsy();
		// Both collections get two events: non-empty text, and then empty text.
		// Updates events on A have no synchronizer (they came from us).
		expect(collectionA.updates).toEqual([['no sync', 'bar'], ['no sync', '']]);
		// Update events on B have a synchronizer (they came from the peer);
		expect(collectionB.updates).toEqual([['sync', 'bar'], ['sync', '']]);

		await collectionA.disconnect(); // Only need one of a directly connected pair
	      }, CONNECT_TIME);
	      it('peers can connect by direct transmission of signals (e.g., by qr code).', async function () {
		// A and B are not talking directly to each other. They are both connecting to a relay.
		// TODO:
		const collectionA = new kind({name: 'testSignals'});
		const collectionB = new kind({name: 'testSignals', serviceKey: 'seconddirect'});
		collectionA.onupdate = recordUpdates;
		collectionB.onupdate = recordUpdates;
		a = b = null;

		const aService = 'signals';
		collectionA.synchronize(aService); // await would block.
		const synchronizerA = collectionA.synchronizers.get(aService);
		const offerSignals = await synchronizerA.connection.signals;

		collectionB.synchronize(offerSignals); // await would block.
		const synchronizerB = collectionB.synchronizers.get(offerSignals);
		const answerSignals = await synchronizerB.connection.signals;
		await synchronizerA.completeSignalsSynchronization(answerSignals);

		await collectionA.synchronized;
		await collectionB.synchronized;
		const tag = await collectionA.store("bar");
		expect(await collectionB.retrieve(tag)).toBeTruthy(); // Now we know that B has seen the update.

		await collectionA.remove({tag});
		expect(await collectionA.retrieve({tag})).toBeFalsy();
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(await collectionB.retrieve({tag})).toBeFalsy();
		// Both collections get two events: non-empty text, and then empty text.
		// Updates events on A have no synchronizer (they came from us).
		expect(collectionA.updates).toEqual([['no sync', 'bar'], ['no sync', '']]);
		// Update events on B have a synchronizer (they came from the peer);
		expect(collectionB.updates).toEqual([['sync', 'bar'], ['sync', '']]);

		await collectionA.disconnect();
	      }, CONNECT_TIME);
	    });

	    describe('complex sync', function () {
	      let author1, author2, owner, tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8, winningAuthor;
	      beforeAll(async function () {
		let aCol = new kind({name: 'a', channelName: 'complex'}),
		    bCol = new kind({name: 'b', channelName: 'complex'});

		author1 = Credentials.author;
		author2 = await Credentials.createAuthor('foo');
		owner = await Credentials.create(author1, author2);

		const firstWins = label === 'ImmutableCollection';
		// Immutable: we first store author1 in collection 'a', and that takes precedent over what 'b' says.
		// Mutable: we last store author2 in collection 'a', and that takes precendent over what 'b' said.
		// Versioned: As with Mutable, but both versions 'abc' have unique antecedent hashes, so both are retained
		//   (at different timestamps), with the later one taking precedence.
		const firstCollection = firstWins ? aCol : bCol;
		const secondCollection = firstWins ? bCol : aCol;
		winningAuthor = firstWins ? author1 : author2;
		tag1 = await firstCollection.store('abc', {author: author1, owner});
		tag2 = await aCol.store('123', {author: author1, owner});
		tag3 = await secondCollection.store('abc', {author: author2, owner});
		tag4 = await bCol.store('xyz', {author: author2, owner});

		aCol.updates = []; bCol.updates = [];
		aCol.onupdate =  event => aCol.updates.push(event.detail.text);
		bCol.onupdate = event => bCol.updates.push(event.detail.text);
		await aCol.synchronize(bCol); // In this testing mode, first one gets some setup, but doesn't actually wait for sync.
		await bCol.synchronize(aCol);
		a = aCol.synchronizers.get(bCol);
		b = bCol.synchronizers.get(aCol);

		// Without waiting for synchronization to complete.
		tag5 = await aCol.store('foo', {author: author1, owner});
		tag6 = await bCol.store('bar', {author: author2, owner});  // As it happens, a will be pushed tag6 after a completes sync.

		expect(await a.completedSynchronization).toBe(2);
		expect(await b.completedSynchronization).toBe(2);

		// Now send some more, after sync.
		tag7 = await bCol.store('white', {author: author2, owner});
		tag8 = await aCol.store('red', {author: author1, owner});
		// After synchronization is complete, we no longer check with the other side when reading,
		// but instead rely on getting notice from the other side about any updates.
		// We do not provide any way to check. However, it is entirely reasonable to expect any such updates
		// to arrive within a second.
		await new Promise(resolve => setTimeout(resolve, 3e3));
	      }, CONNECT_TIME);
	      afterAll(async function () {
		// Both get updates for everything added to either side since connecting: foo, bar, red, white.
		// But in addition:
		//   a gets xyz (which it did not ahve).
		//   b gets 123 (which it didn't have) and a reconciled value for abc (of which it had the wrong sig).
		let aUpdates = [              'bar', 'foo', 'red', 'white', 'xyz'];
		let bUpdates = ['123', 'abc', 'bar', 'foo', 'red', 'white'];
		// For VersionedCollection both sides have a unique 'abc' to tell the other about.
		if (label === 'VersionedCollection') aUpdates = ['abc', ...aUpdates];
		Credentials.owner = owner;
		if (a) {
		  a.collection.onupdate = null;
		  a.collection.updates.sort(); // The timing of those received during synchronization can be different.
		  expect(a.collection.updates).toEqual(aUpdates);
		  await clean(a);
		}
		if (b) {
		  b.collection.onupdate = null;
		  b.collection.updates.sort();
		  expect(b.collection.updates).toEqual(bUpdates);
		  await clean(b);
		}
		Credentials.owner = null;
		await Credentials.destroy(owner);
		await Credentials.destroy({tag: author2, recursiveMembers: true});
	      }, CONNECT_TIME);
	      it('b gets from pre-sync a.', async function () {
		expect((await b.collection.retrieve({tag: tag2})).text).toBe('123');
	      });
	      it('a get from pre-sync b.', async function () {
		expect((await a.collection.retrieve({tag: tag4})).text).toBe('xyz');
	      });
	      it('a and b agree on result from pre-sync difference.', async function () {
		expect(tag1).toBe(tag3);
		const matchedA = await a.collection.retrieve({tag: tag1});
		const matchedB = await b.collection.retrieve({tag: tag1});
		expect(matchedA.text).toBe(matchedB.text);
		expect(matchedA.protectedHeader.iat).toBe(matchedB.protectedHeader.iat);
		expect(matchedA.protectedHeader.act).toBe(matchedB.protectedHeader.act);
		expect(matchedA.protectedHeader.iss).toBe(matchedB.protectedHeader.iss);
		expect(matchedA.protectedHeader.act).toBe(winningAuthor);
	      });
	      it('collections receive new data saved during sync.', async function () {
		expect((await a.collection.retrieve({tag: tag6})).text).toBe('bar');
		expect((await b.collection.retrieve({tag: tag5})).text).toBe('foo');
	      });
	      it('collections receive new data saved after sync.', async function () {
		expect((await a.collection.retrieve({tag: tag7})).text).toBe('white');
		expect((await b.collection.retrieve({tag: tag8})).text).toBe('red');
	      });
	    });
	  });
	}
	testCollection(ImmutableCollection);
	testCollection(MutableCollection);
	testCollection(VersionedCollection);
      });
    // TODO:
    // - non-owner
    // - impossible history: signed, but depending on something that comes later
    // - various deleted history cases
    });
  });
});
