import { PromiseWebRTC } from '../lib/webrtc.mjs';
import Synchronizer from '../lib/synchronizer.mjs';
import { Credentials, ImmutableCollection } from '../lib/collections.mjs';

import { testPrompt } from './support/testPrompt.mjs';
const { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect, expectAsync, URL } = globalThis;

const baseURL = globalThis.document?.baseURI || 'http://localhost:3000';
Credentials.getUserDeviceSecret = testPrompt;

describe('Synchronizer', function () {
  describe('basic data channel', function () {
    it('smokes', async function () {
      const tag = 'testing';
      const message = 'echo';

      const url = new URL(`/flexstore/requestDataChannel/${tag}`, baseURL);
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
    function makeCollection({name = 'test', ...props}) { return new ImmutableCollection({name, ...props});}
    function makeSynchronizer({peerName = 'peer', ...props}) { return new Synchronizer({peerName, ...props, collection: makeCollection(props)}); }
    async function connect(a, b) { // Connect two synchronizer instances.
      const aSignals = await a.connect();
      const bSignals = await b.connect(aSignals);
      await a.completeConnection(bSignals);
    }
    let a, b;
    function setup(aProps = {}, bProps = {}) {
      a = makeSynchronizer({name: 'a', ...aProps});
      b = makeSynchronizer({name: 'b', ...bProps});
      return connect(a, b);
    }
    describe('initializations', function () {
      beforeAll(function () {
	a = makeSynchronizer({name: 'a'});
      });
      it('has label.', async function() {
	expect(a.label).toBe('ImmutableCollection/a');
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
	expect(a.connectionURL).toBe(`${a.peerName}/requestDataChannel/ImmutableCollection/a`);
      });
    });
    describe('connected', function () {
      afterEach(async function () {
	await a.disconnect();
	expect(a.connection.peer.connectionState).toBe('new');
	await b.closed;
	expect(b.connection.peer.connectionState).toBe('new');
      });
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
      describe('authorized', function () {
	beforeAll(async function () {
	  Credentials.author = await Credentials.createAuthor('test pin:');
	});
	afterAll(async function () {
	  async function clean(synchronizer) {
	    await Promise.all((await synchronizer.collection.list('skipSync')).map(tag => synchronizer.collection.remove({tag})));
	    expect(await synchronizer.collection.list.length).toBe(0);
	  }
	  await clean(a);
	  await clean(b);	  
	  await Credentials.destroy({tag: Credentials.author, recursiveMembers: true});
	});
	it('basic sync', async function () {
	  await setup();
	  const tag1 = await a.collection.store('abcd');
	  const tag2 = await a.collection.store('1234');
	  await a.startedSynchronization;

	  expect(await b.completedSynchronization).toBe(2);
	  expect((await b.collection.retrieve({tag: tag1})).text).toBe('abcd');
	  expect((await b.collection.retrieve({tag: tag2})).text).toBe('1234');	  
	});
      });
    });
  });
});
