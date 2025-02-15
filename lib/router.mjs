import express from 'express';
import Persist from './persist-fs.mjs';
import Flex from './index.mjs';
import { pathTag } from './tagPath.mjs';
import { PromiseWebRTC } from './webrtc.mjs';
const router = express.Router();

const collections = { ImmutableCollection: {}, MutableCollection: {}, VersionedCollection: {}};
function ensureCollection(collectionType, collectionName) {
  // VersionedCollection uses the same name for the Versioned part and the Immutable part, so we must distinguish bey CollectionType.
  return collections[collectionType][collectionName] ||=
    new Flex[collectionType]({name: collectionName, persistenceClass: Persist});
}
function getCollection(collectionType) { // Midleware that leaves collection in req.collection.
  return (req, res, next) => {
    const { collectionName } = req.params;
    req.collection = ensureCollection(collectionType, collectionName);
    next();
  };
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
    return res.sendStatus(403);
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
router.use('/ImmutableCollection', express.static('asyncLocalStorage/ImmutableCollection', staticImmutableOptions));
router.use('/MutableCollection', express.static('asyncLocalStorage/MutableCollection', staticMutableOptions));
router.use('/VersionedCollection', express.static('asyncLocalStorage/VersionedCollection', staticMutableOptions));
// Here are some manual equivalents (although the following do not currently do appropriate Cache-Control).
// router.get('/ImmutableCollection/:collectionName/:tag', getCollection('ImmutableCollection'), invokeCollectionMethod);
// router.get('/MutableCollection/:collectionName/:tag', getCollection('MutableCollection'), invokeCollectionMethod);
// router.get('/VersionedCollection/:collectionName/:tag', getCollection('VersionedCollection'), invokeCollectionMethod);

router.use(express.text({ // Define request.body.
  type: ['application/jose', 'application/jose+json'],
  limit: '5mb'
}));

router.put('/ImmutableCollection/:collectionName/:b/:c/:a/:rest', pathTag, getCollection('ImmutableCollection'), invokeCollectionMethod);
router.put('/MutableCollection/:collectionName/:b/:c/:a/:rest', pathTag, getCollection('MutableCollection'), invokeCollectionMethod);
router.put('/VersionedCollection/:collectionName/:b/:c/:a/:rest', pathTag, getCollection('VersionedCollection'), invokeCollectionMethod);

router.delete('/ImmutableCollection/:collectionName/:b/:c/:a/:rest', pathTag, getCollection('ImmutableCollection'), invokeCollectionMethod);
router.delete('/MutableCollection/:collectionName/:b/:c/:a/:rest', pathTag, getCollection('MutableCollection'), invokeCollectionMethod);
router.delete('/VersionedCollection/:collectionName/:b/:c/:a/:rest', pathTag, getCollection('VersionedCollection'), invokeCollectionMethod);

router.use(express.text({ // Define request.body.
  limit: '5mb'
}));

const dataChannels = {};
router.post('/requestDataChannel/:tag', async (req, res, next) => {
  const {params, body} = req;
  const tag = params.tag;
  const signals = JSON.parse(body);
  const connection = dataChannels[tag] = new PromiseWebRTC({label: tag});
  const dataPromise = connection.getDataChannelPromise();
  dataPromise.then(dataChannel => {
    dataChannel.onclose = () => {
      connection.close();
      delete dataChannels[tag];
      console.log('Closed', tag);
    };
    dataChannel.onmessage = event => dataChannel.send(event.data); // Just echo what we are given.
  });
  connection.signals = signals; // Convey the posted offer+ice signals to our connection.
  res.send(JSON.stringify(await connection.signals)); // Send back our signalling answer+ice.
});

export default router;

