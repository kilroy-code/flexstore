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
  if (!kind) return console.error(`No collectionType "${collectionType}".`);
  let collection = kind[collectionName];
  if (!collection) {
    collection = kind[collectionName] = new Flex[collectionType]({name: collectionName, persistenceClass: Persist});
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

// Feels circular, but it isn't. The collections will validate PUT/DELETE request signatures, using
// the same collections that distributed-security clients expect in our Flex.Credentials.
// Here we override the usual definitions to make them match what clients get.
['EncryptionKey', 'KeyRecovery', 'Team'].forEach(name => {
  Flex.Credentials.collections[name].disconnect(); // Don't await.
  Flex.Credentials.collections[name] = ensureCollection('MutableCollection', name);
});

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
};
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

router.use(express.text({ // Define request.body.
  limit: '5mb'
}));

const dataChannels = {};

router.post('/requestDataChannel/test/echo/:tag', async (req, res, next) => {
  const {params, body} = req;
  const tag = params.tag;
  const signals = JSON.parse(body);
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
  res.send(JSON.stringify(await connection.signals)); // Send back our signalling answer+ice.
});

router.post('/requestDataChannel/:collectionType/:collectionName/:uuid', getCollection, async (req, res, next) => {
  const {collection, params, body} = req;
  const {uuid} = params;
  // If that uuid is already in use, send "conflict" rather than allowing a random to kick someone off.
  const existing = collection.synchronizers.get(uuid);
  if (existing) return res.sendStatus(409);
  const theirSignals = JSON.parse(body);

  // TODO: Build this into Collection.synchronize().
  // TODO: when the last synchronizer gets disconnect, remove the instance.
  const fixme = new Flex.Synchronizer({collection, uuid});
  collection.synchronizers.set(uuid, fixme);
  const ourSignals = await fixme.startConnection(theirSignals);
  fixme.closed.then(() => {
    collection.synchronizers.delete(uuid);
  });
  res.send(JSON.stringify(ourSignals));
});

export default router;
