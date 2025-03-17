import { PromiseWebRTC } from '../lib/webrtc.mjs';
import Synchronizer from '../lib/synchronizer.mjs';
import { Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection } from '../lib/collections.mjs';

import { testPrompt } from './support/testPrompt.mjs';
const { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect, expectAsync, URL } = globalThis;

Object.assign(globalThis, {Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection}); // for debugging
const baseURL = globalThis.document?.baseURI || 'http://localhost:3000';
Credentials.getUserDeviceSecret = testPrompt;

const CONNECT_TIME = 15e3; // normally
//const CONNECT_TIME = 7 * 45e3; // if throttled TURN in use

describe('Synchronizer', function () {
  afterAll(async function () {
    if (!window.confirm?.('Delete test databases? After this, some browsers (Safari) need to be restarted.')) return;
    await Promise.all([MutableCollection, ImmutableCollection, VersionedCollection].map(kind => {
      return Promise.all(['frogs', 'a', 'b', 'a-basic', 'b-basic', 'testRelay', 'testRendezvous'].map(name => new kind({name}).destroy()));
    }));
  });

  describe('server relay', function () {
    describe('basic data channel connection', function () {
      it('smokes', async function () {
	const tag = 'testing';
	const message = 'echo';

	const url = new URL(`/flexstore/requestDataChannel/test/echo/${tag}`, baseURL);
	const connection = new PromiseWebRTC({label: tag});
	const dataChannelPromise = connection.createDataChannel();
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
      let collection = new MutableCollection({name: 'frogs'}),
	  frog, author, owner,
	  question = "Airspeed?",
	  answer = "African or Eurpopean?",
	  service = new URL('/flexstore', baseURL).href;
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
	// 1. Create an invitation, and immediately claim it.
	await Credentials.ready;
	author = Credentials.author = await Credentials.createAuthor('-'); // Create invite.
	Credentials.setAnswer(question, answer); // Claiming is a two step process.
	await Credentials.claimInvitation(author, question);
	// 2. Create an owning group from the frog, that includes the author we just created.
	owner = Credentials.owner = await Credentials.create(Credentials.author); // Create owner team with that member.
	// 3. Store the frog with these credentials.
	frog = await collection.store({title: 'bull'}); // Store item with that author/owner
	// 4. Sychronize to service, disconnect, and REMOVE EVERYTHING LOCALLY.
	await syncAll();
	await Credentials.disconnect();
	await collection.disconnect();
	await killAll();
      }, CONNECT_TIME);
      afterAll(async function () {
	await killAll(); // Locally and on on-server, because we're still connected.
      });
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

  describe('peers', function () {
    const base = new URL('/flexstore', baseURL).href;
    function makeCollection({name = 'test', kind = ImmutableCollection, ...props}) { return new kind({name, ...props});}
    function makeSynchronizer({peerName = 'peer', ...props}) { return new Synchronizer({peerName, ...props, collection: makeCollection(props)}); }
    async function connect(a, b) { // Connect two synchronizer instances.
      const aSignals = await a.startConnection();
      const bSignals = await b.startConnection(aSignals);
      a.completeConnection(bSignals);
    }
    let a, b;
    function setup(aProps = {}, bProps = {}, doConnect = true) {
      a = makeSynchronizer({name: 'a', ...aProps});
      b = makeSynchronizer({name: 'b', ...bProps});
      return doConnect && connect(a, b);
    }
    async function teardown() {
    }

    describe('initializations', function () {
      beforeAll(function () {
	a = makeSynchronizer({name: 'a'});
      });
      it('has label.', async function() {
	expect(a.label.startsWith('ImmutableCollection/a')).toBeTruthy();
      });
      describe('hostRequestBase', function () {
	it('is built on url peerName', function () {
	  expect(makeSynchronizer({peerName: base, name: 'a'}).hostRequestBase).toBe(`${base}/ImmutableCollection/a`);
	});
	it('is empty if peerName is not a url', function () {
	  expect(makeSynchronizer({peerName: 'foo'}).hostRequestBase).toBeFalsy();
	  expect(makeSynchronizer({peerName: './foo'}).hostRequestBase).toBeFalsy();
	});
      });
      it('has connectionURL.', function () {
	expect(a.connectionURL.startsWith(`${a.peerName}/requestDataChannel/ImmutableCollection/a`)).toBeTruthy();
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
	  console.log('a:', a.protocol, a.candidateType, 'b:', b.protocol, b.candidateType);
	  expect(a.protocol).toBe(b.protocol);
	  expect(a.protocol).toBeTruthy();
	  expect(a.candidateType).toBeTruthy();
	  await teardown();
	}, CONNECT_TIME);
	describe('version/send/receive', function () {
	  it('agrees on max.', async function () {
	    await setup({maxVersion: 2}, {maxVersion: 3});
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
	      let aCol = new kind({name: 'a-basic'}),
		  bCol = new kind({name: 'b-basic'});

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

	    describe('hosted', function () {
	      function recordUpdates(event) {
		const updates = event.target.updates ||= [];
		updates.push([event.detail.synchronizer ? 'sync' : 'no sync', event.detail.text]);
	      }
	      it('relay can connect.', async function () {
		const peerName = new URL('/flexstore', baseURL).href;
		// A and B are not talking directly to each other. They are both connecting to a relay.
		const collectionA = new kind({name: 'testRelay'});
		const collectionB = new kind({name: 'testRelay'});
		collectionA.onupdate = recordUpdates;
		collectionB.onupdate = recordUpdates;
		a = b = null;

		await collectionA.synchronize(peerName);
		await collectionB.synchronize(peerName);
		await collectionA.synchronized;
		await collectionB.synchronized;

		const tag = await collectionA.store("foo");
		await collectionA.remove({tag});
		await new Promise(resolve => setTimeout(resolve, 1e3));
		expect(await collectionA.retrieve({tag})).toBeFalsy();
		expect(await collectionB.retrieve({tag})).toBeFalsy();
		// Both collections get two events: non-empty text, and then emptyy text.
		// Updates events on A have no synchronizer (they came from us).
		expect(collectionA.updates).toEqual([['no sync', 'foo'], ['no sync', '']]);
		// Update events on B have a synchronizer (they came from the relay);
		expect(collectionB.updates).toEqual([['sync', 'foo'], ['sync', '']]);

		await collectionA.disconnect();
		await collectionB.disconnect();
	      }, 2 * CONNECT_TIME);
	      it('rendevous can connect.', async function () {
		const peerName = new URL('/flexstore/rendevous/42', baseURL).href;
		// A and B are not talking directly to each other. They are both connecting to a relay.
		const collectionA = new kind({name: 'testRendezvous'});
		const collectionB = new kind({name: 'testRendezvous'});
		collectionA.onupdate = recordUpdates;
		collectionB.onupdate = recordUpdates;
		a = b = null;

		const syncA = collectionA.synchronize(peerName);
		await collectionB.synchronize(peerName);
		await syncA;
		await collectionA.synchronized;
		await collectionB.synchronized;
		const tag = await collectionA.store("bar");
		await new Promise(resolve => setTimeout(resolve, 1e3));

		await collectionA.remove({tag});
		await new Promise(resolve => setTimeout(resolve, 1e3));
		expect(await collectionA.retrieve({tag})).toBeFalsy();
		expect(await collectionB.retrieve({tag})).toBeFalsy();
		// Both collections get two events: non-empty text, and then empty text.
		// Updates events on A have no synchronizer (they came from us).
		expect(collectionA.updates).toEqual([['no sync', 'bar'], ['no sync', '']]);
		// Update events on B have a synchronizer (they came from the peer);
		expect(collectionB.updates).toEqual([['sync', 'bar'], ['sync', '']]);

		await collectionA.disconnect();
		await collectionB.disconnect();
	      }, CONNECT_TIME);
	    });

	    describe('complex sync', function () {
	      let author1, author2, owner, tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8, winningAuthor;
	      beforeAll(async function () {
		let aCol = new kind({name: 'a'}),
		    bCol = new kind({name: 'b'});

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
		await new Promise(resolve => setTimeout(resolve, 3e3)); // fixme time
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
