import express from 'express';
import { Persist } from './persist-fs.mjs';

const router = express.Router();

router.use(express.text({ // Define req.body, but don't use broken express.json parser that does not handle toplevel non-objects.
  type: ['application/jose', 'application/jose+json'],
  limit: '5mb'
}));
const collections = {};
function getCollection(req, res, next) {
  const { collectionName } = req.params;
  req.collection = collections[collectionName] ||= new Persist({collectionName});
  next();
}

// TODO: Use mutable/immutable/versioned in path, and set nocache for immutable
const methodMap = {GET: 'get', PUT: 'put', DELETE: 'delete'};
async function invokeCollectionMethod(req, res, next) {
  const {collection, method, params, body} = req;
  const {tag} = params;
  const operation = methodMap[method];
  const data = await collection[operation](tag, body);
  //console.log({collection, tag, method, body, data});
  if (method !== 'GET') return res.send(tag); // oddly, body is not falsy, but an empty object ({}).
  if (!data) return res.sendStatus(404);
  res.set('Content-Type', data.startsWith("{") ? 'application/jose+json' : 'application/jose');
  return res.send(data);
}

router.get('/:collectionName/:tag', getCollection, invokeCollectionMethod);
// TODO: verify the writes -- but how to do this appropriately for Team/EncryptionKey/RecoveryKey?
router.put('/:collectionName/:tag', getCollection, invokeCollectionMethod);
router.delete('/:collectionName/:tag', getCollection, invokeCollectionMethod);

export default router;

