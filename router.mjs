import express from 'express';
import { Persist } from './persist-fs.mjs';

const router = express.Router();

router.use(express.text({ // Define req.body, but don't use broken express.json parser that does not handle toplevel non-objects.
  type: ['application/jose', 'application/jose+json'],
  limit: '5mb'
}));
const collections = {};
function getCollection(collectionType) {
  return (req, res, next) => {
    const { collectionName } = req.params;
    req.collection = collections[collectionName] ||= new Persist({collectionName, collectionType});
    next();
  };
}

// TODO: use express static for get (content-type!), and nocache approprirately
// TODO: split up tags in tagPath.mjs
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

router.get('/ImmutableCollection/:collectionName/:tag', getCollection('ImmutableCollection'), invokeCollectionMethod);
router.get('/MutableCollection/:collectionName/:tag', getCollection('MutableCollection'), invokeCollectionMethod);
router.get('/VersionedCollection/:collectionName/:tag', getCollection('VersionedCollection'), invokeCollectionMethod);

router.put('/ImmutableCollection/:collectionName/:tag', getCollection('ImmutableCollection'), invokeCollectionMethod);
router.put('/MutableCollection/:collectionName/:tag', getCollection('MutableCollection'), invokeCollectionMethod);
router.put('/VersionedCollection/:collectionName/:tag', getCollection('VersionedCollection'), invokeCollectionMethod);

router.delete('/ImmutableCollection/:collectionName/:tag', getCollection('ImmutableCollection'), invokeCollectionMethod);
router.delete('/MutableCollection/:collectionName/:tag', getCollection('MutableCollection'), invokeCollectionMethod);
router.delete('/VersionedCollection/:collectionName/:tag', getCollection('VersionedCollection'), invokeCollectionMethod);

export default router;

