import { PromiseWebRTC } from '../lib/webrtc.mjs';
import Synchronizer from '../lib/synchronizer.mjs';
import { Credentials, ImmutableCollection, MutableCollection, VersionedCollection } from '../lib/collections.mjs';

import { testPrompt } from './support/testPrompt.mjs';
const { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect, expectAsync, URL } = globalThis;

const baseURL = globalThis.document?.baseURI || 'http://localhost:3000';
Credentials.getUserDeviceSecret = testPrompt;

describe('Synchronizer', function () {
  describe('basic data channel', function () {
    it('smokes', async function () {
      const tag = 'testing';
      const message = 'echo';

      const url = new URL(`/flexstore/requestDataChannel/test/echo/${tag}`, baseURL);
      const connection = new PromiseWebRTC({label: tag});
      const dataChannelPromise = connection.createDataChannel();
      // Send them our signals:
      const outboundSignals = await connection.signals;
      const body = JSON.stringify(outboundSignals);
      const request = await fetch(url, {method: 'POST', body});
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
    });
  });
  describe('peer', function () {
    const base = 'http://localhost:3000/flexstore';
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
      describe('basic', function () {
	it('changes state appropriately.', async function () {
	  await setup({}, {});
	  expect(await a.dataChannelPromise).toBeTruthy();
	  expect(await b.dataChannelPromise).toBeTruthy();
	  expect(a.connection.peer.connectionState).toBe('connected');
	  expect(b.connection.peer.connectionState).toBe('connected');
	});
	describe('version/send/receive', function () {
	  it('agrees on max.', async function () {
	    await setup({maxVersion: 2}, {maxVersion: 3});
	    expect(await a.version).toBe(2);
	    expect(await b.version).toBe(2);
	  });
	  it('agrees on failure.', async function () {
	    await setup({minVersion: 1, maxVersion: 2}, {minVersion: 3, maxVersion: 4});
	    expect(await a.version).toBe(0);
	    expect(await b.version).toBe(0);
	  });
	});
	it('synchronizes empty.', async function () {
	  await setup({}, {});
	  await a.startedSynchronization;
	  expect(await a.completedSynchronization).toBe(0);
	  expect(await b.completedSynchronization).toBe(0);
	});
      });
      describe('authorized', function () {
	async function clean(synchronizer) {
	  await synchronizer.collection.disconnect();
	  const list = await synchronizer.collection.list('skipSync');
	  await Promise.all(list.map(tag => synchronizer.collection.remove({tag})));
	  expect(await synchronizer.collection.list.length).toBe(0);
	}
	beforeAll(async function () {
	  Credentials.author = await Credentials.createAuthor('test pin:');
	}, 10e3);
	afterAll(async function () {
	  a && await clean(a);
	  b && await clean(b);
	  await Credentials.destroy({tag: Credentials.author, recursiveMembers: true});
	});
	function testCollection(kind, label = kind.name) {
	  describe(label, function () {
	    it('basic sync', async function () {
	      let aCol = new kind({name: 'a'}),
		  bCol = new kind({name: 'b'});

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
	      }, 20e3);
	      afterAll(async function () {
		a.collection.onupdate = null;
		b.collection.onupdate = null;
		// Both get updates for everything added to either side since connecting: foo, bar, red, white.
		// But in addition:
		//   a gets xyz (which it did not ahve).
		//   b gets 123 (which it didn't have) and a reconciled value for abc (of which it had the wrong sig).
		a.collection.updates.sort(); // The timing of those received during synchronization can be different.
		b.collection.updates.sort();
		let aUpdates = [              'bar', 'foo', 'red', 'white', 'xyz'];
		let bUpdates = ['123', 'abc', 'bar', 'foo', 'red', 'white'];
		// For VersionedCollection both sides have a unique 'abc' to tell the other about.
		if (label === 'VersionedCollection') aUpdates = ['abc', ...aUpdates];
		expect(a.collection.updates).toEqual(aUpdates);
		expect(b.collection.updates).toEqual(bUpdates);
		Credentials.owner = owner;
		await clean(a);
		await clean(b);
		Credentials.owner = null;
		await Credentials.destroy(owner);
		await Credentials.destroy({tag: author2, recursiveMembers: true});
	      });
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
	    it('hosted synchronizer can connect.', async function () {
	      const peerName = new URL('/flexstore', baseURL).href;
	      const collectionA = new kind({name: 'test'});
	      const collectionB = new kind({name: 'test'});
	      function recordUpdates(event) {
		const updates = event.target.updates ||= [];
		updates.push([event.detail.synchronizer ? 'sync' : 'no sync', event.detail.text]);
	      }
	      collectionA.onupdate = recordUpdates;
	      collectionB.onupdate = recordUpdates;
	      // A and B are not talking directly to each other. They are both connecting to a relay.
	      await collectionA.synchronize(peerName);
	      await collectionB.synchronize(peerName);
	      a = collectionA.synchronizers.get(peerName);
	      b = collectionB.synchronizers.get(peerName);
	      await a.synchronizationCompleted;
	      await b.synchronizationCompleted;

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
	      await b.disconnect(); // Because one of the afterEach awaits b.closed.
	    }, 10e3);
	    it('hosted rendevous can connect.', async function () {
	      const peerName = new URL('/flexstore/rendevous/42', baseURL).href;
	      const collectionA = new kind({name: 'test'});
	      const collectionB = new kind({name: 'test'});
	      function recordUpdates(event) {
		const updates = event.target.updates ||= [];
		event.target.log('*** got update', event.detail.synchronizer ? 'sync' : 'no sync', event.detail.text);
		updates.push([event.detail.synchronizer ? 'sync' : 'no sync', event.detail.text]);
	      }
	      collectionA.onupdate = recordUpdates;
	      collectionB.onupdate = recordUpdates;
	      // A and B are not talking directly to each other. They are both connecting to a relay.
	      const syncA = collectionA.synchronize(peerName);
	      await collectionB.synchronize(peerName);
	      await syncA;
	      a = collectionA.synchronizers.get(peerName);
	      b = collectionB.synchronizers.get(peerName);
	      await a.synchronizationCompleted;
	      await b.synchronizationCompleted;
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
	      await b.disconnect(); // Because one of the afterEach awaits b.closed.
	    }, 10e3);
	  });
	}
	testCollection(ImmutableCollection);
	testCollection(MutableCollection);
	testCollection(VersionedCollection);
      });
    // TODO: VersionedCollection synchronizations:
    // - non-owner
    // - impossible history: signed, but depending on something that comes later
    // - various deleted history cases
    });
  });
});
