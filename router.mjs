import express from 'express';
import { Persist } from './persist-fs.mjs';
import { pathTag } from './tagPath.mjs';
const router = express.Router();

const collections = {ImmutableCollection: {}, MutableCollection: {}, VersionedCollection: {}};
function getCollection(collectionType) {
  return (req, res, next) => {
    const { collectionName } = req.params;
    // VersionedCollection uses the same name for the Versioned part and the Immutable part, so we must distinguish bey CollectionType.
    req.collection = collections[collectionType][collectionName] ||= new Persist({collectionName, collectionType});
    next();
  };
}

// TODO: verify the writes -- but how to do this appropriately for Team/EncryptionKey/RecoveryKey?
// TODO: on client, use local db as a cache and host as a backstore.

const methodMap = {GET: 'get', PUT: 'put', DELETE: 'delete'};
async function invokeCollectionMethod(req, res, next) {
  const {collection, method, params, body} = req;
  const {tag} = params;
  const operation = methodMap[method];
  const data = await collection[operation](tag, body);
  if (method !== 'GET') return res.send(tag); // oddly, body is not falsy, but an empty object ({}).
  if (!data) return res.sendStatus(404);
  res.set('Content-Type', data.startsWith("{") ? 'application/jose+json' : 'application/jose');
  return res.send(data);
}

const staticImmutableOptions = {
  cacheControl: true,
  immutable: true,
  maxAge: '1y',

  acceptRanges: false,
  setHeaders: (res) => res.setHeader('Content-Type', 'application/jose')
};
const staticMutableOptions = {
  cacheControl: true,
  immutable: false,

  acceptRanges: false,
  setHeaders: (res) => res.setHeader('Content-Type', 'application/jose')
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

export default router;

