import express from 'express';
import Persist from './persist-fs.mjs';
import Flex from '../index.mjs';
import { pathTag } from './tagPath.mjs';
import { PromiseWebRTC } from './webrtc.mjs';
const router = express.Router();

const collections = { ImmutableCollection: {}, MutableCollection: {}, VersionedCollection: {}, VersionCollection: {}};
function ensureCollection(collectionType, collectionName) {
  // VersionedCollection uses the same name for the Versioned part and the Immutable part, so we must distinguish by CollectionType.
  const kind = collections[collectionType];
  if (!kind) return console.error(`No collectionType "${collectionType}" for "${collectionName}".`);
  let collection = kind[collectionName];
  if (!collection) {
    collection = kind[collectionName] =
      ((collectionType === 'MutableCollection') && Flex.Credentials.collections[collectionName]) ||
      new Flex[collectionType]({name: collectionName, persistenceClass: Persist});
    // We are a relay. Anything that comes in will be broadcast to all the connected synchronizers except the one that sent it to us.
    collection.onupdate = event => {
      const verified = event.detail;
      collection.push(verified.payload.length ? 'put' : 'delete', verified.tag, verified.signature, verified.synchronizer);
    };
  }
  return collection;
}
function getCollection(req, res, next) { // Midleware that leaves collection in req.collection.
  let { collectionName, collectionType } = req.params;
  req.collection = ensureCollection(collectionType, collectionName);
  next();
}

// TODO: verify the writes -- but how to do this appropriately for Team/EncryptionKey/RecoveryKey?
// TODO: on client, use local db as a cache and host as a backstore.

const methodMap = {GET: 'get', PUT: 'put', DELETE: 'delete'};
async function invokeCollectionMethod(req, res, next) {
  const {collection, method, params, body} = req;
  const {tag} = params;
  const operation = methodMap[method];
  let data = '';
  try {
    data = await collection[operation](tag, body);
  } catch (error) {
    console.warn(error);
    return res.sendStatus(error.code === 'ENOENT' ? 404 : 403);
  }
  if (method !== 'GET') return res.send(tag); // oddly, body is not falsy, but an empty object ({}).
  if (!data) return res.sendStatus(404);
  res.set('Content-Type', data.startsWith("{") ? 'application/jose+json' : 'application/jose');
  return res.send(data);
}
/*
function setHeaders(res) {
  res.setHeader('Content-Type', 'application/jose');
}
const staticImmutableOptions = {
  cacheControl: true,
  immutable: true,
  maxAge: '1y',

  acceptRanges: false,
  setHeaders
};
const staticMutableOptions = {
  cacheControl: true,
  immutable: false,

  acceptRanges: false,
  setHeaders
};*/
// router.use('/ImmutableCollection', express.static('asyncLocalStorage/ImmutableCollection', staticImmutableOptions));
// router.use('/MutableCollection',   express.static('asyncLocalStorage/MutableCollection',   staticMutableOptions));
// router.use('/VersionedCollection', express.static('asyncLocalStorage/VersionedCollection', staticMutableOptions));
// router.use('/VersionCollection',   express.static('asyncLocalStorage/VersionCollection',   staticImmutableOptions));
// Here is the equivalent (although it does not currently do appropriate Cache-Control).
router.get('/:collectionType/:collectionName/:b/:c/:a/:rest', pathTag, getCollection, invokeCollectionMethod);

router.use(express.text({ // Define request.body.
  type: ['application/jose', 'application/jose+json'],
  limit: '5mb'
}));

router.put(   '/:collectionType/:collectionName/:b/:c/:a/:rest', pathTag, getCollection, invokeCollectionMethod);
router.delete('/:collectionType/:collectionName/:b/:c/:a/:rest', pathTag, getCollection, invokeCollectionMethod);

router.use(express.json({ // Define request.body.
  limit: '5mb'
}));

const dataChannels = {};

router.post('/requestDataChannel/test/echo/:tag', async (req, res, next) => {
  const {params, body} = req;
  const tag = params.tag;
  const signals = body;
  const connection = dataChannels[tag] = new PromiseWebRTC({label: tag});
  const dataPromise = connection.getDataChannelPromise();
  dataPromise.then(dataChannel => {
    dataChannel.onclose = () => {
      connection.close();
      delete dataChannels[tag];
    };
    dataChannel.onmessage = event => dataChannel.send(event.data); // Just echo what we are given.
  });
  connection.signals = signals; // Convey the posted offer+ice signals to our connection.
  res.send(await connection.signals); // Send back our signalling answer+ice.
});

// Allow the client to connect as a peer to a relay. The peer and our collection will synchronize, and additionally,
// anything written to our collection will be broadcast to all the connected peers except the one that wrote it.
router.post('/sync/:collectionType/:collectionName/:uuid', getCollection, async (req, res, next) => {
  const {collection, params, body} = req;
  const {uuid} = params;
  // If that uuid is already in use, send "conflict" rather than allowing a random to kick someone off.
  const existing = collection.synchronizers.get(uuid);
  if (existing) return res.sendStatus(409);
  const theirSignals = body;

  // Reach under the hood to do some of the work of collection.synchronize(). Specifically, res.send(await startConnection(theirSignals))
  // non-url serviceName would use a LAN-only configuration if we do not explicitly pass null.
  let {collectionType, collectionName} = params;
  console.log('** router receiving sync post', {collectionType, collectionName, uuid, theirSignals});
  const synchronizer = new Flex.Synchronizer({collection, debug: collection.debug, serviceName: uuid, rtcConfiguration: null});
  synchronizer.log('incoming signals', theirSignals);
  const ourSignals = await synchronizer.startConnection(theirSignals).catch(() => null);
  if (!ourSignals) return res.sendStatus(500); // Arguably 502, but not 504 -- I don't want to spoof front-end errors between us and the client.
  synchronizer.log('outgoing signals', JSON.stringify(ourSignals, null, 2));
  synchronizer.closed.then(() => {
    console.log(synchronizer.label, 'router sees synchronizer closed');
    // TODO: when the last synchronizer gets disconnect, remove the instance.
  });
  synchronizer.connection.peer.addEventListener('datachannel', event => {
    // This will be a no-op for the first data channel, which is already set up above.  But it ensures that we handle
    // any additional data channels that may be created by the client, without having to make a new connection.
    const {channel} = event;
    const [collectionType, collectionName] = channel.label.split('/');
    console.log('\n\n** router event "datachannel"', {collectionType, collectionName, uuid});
    const collection = ensureCollection(collectionType, collectionName);
    collection.ensureSynchronizer(uuid, synchronizer.connection, channel);
  });
  // No need to startSynchronization, as the client will start and that will prod us.
  // Which is fortunate, because we would need to wait for ourSignals to find their way back
  // to the client and get used.
  res.send(ourSignals);
});

// Connect two peers to each other by signalling though us. We do not remain connected to either.
// Neither client knows who will be the first to post to the separately agreed rendevousTag, so
// both create a data channel, collect the signals (offer and ice), and attempt to post here.
// We note the signals of the first to connect, but we do not respond yet.
// When the second client connects at the same rendevousTag, we give them a non-standard
// instruction to reset, and the first client's signals. That second client must then
// abandon it's offer, and consume the rest of the offer in a clean webrtc peer.
// The second client presents its response in a new request.
// That new response is what is finally returned to the first client.
const rendevous = {};
router.post('/signal/:rendevousTag/:collectionType/:collectionName/:uuid', async (req, res, next) => {
  // TODO: setup a timeout to clean up in case the handshake does not complete.
  const {params, body} = req;
  const {rendevousTag, collectionType, collectionName, uuid} = params;
  const key = collectionType + collectionName + rendevousTag;
  const responder = rendevous[key];
  if (responder) {
    const response = responder(body, uuid);
    return res.send(response);
  }
  const killer = setTimeout(() => delete rendevous[key], 60e3);
  const answer = await new Promise(resolve => { // First poster is waiting here for resolve.
    rendevous[key] = (ignoredSignals, posterId) => { // Second post. The given body is useless...
      const modifiedOffer = [ ['reset'], ...body];
      rendevous[key] = (signals, thirdId) => {
	resolve(signals);  // Set next responder to resolve with the next given body.
	return [["continue"]]; // Send back parseable "signals", even if non-standard.
      };
      return modifiedOffer;
    };
  });
  clearTimeout(killer);
  delete rendevous[key];
  return res.send(answer);
});


export default router;
