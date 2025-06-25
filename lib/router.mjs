import express from 'express';
import { StorageLocal } from '@ki1r0y/storage';
import Flex from '../index.mjs';
import { pathTag } from './tagPath.mjs';
import { PromiseWebRTC } from './webrtc.mjs';
import webpush from 'web-push';
const router = express.Router();

router.use(express.json({ limit: '5mb' }));

/*
  The storage directory for @ki1r0y/storage in NodeJS is specified by
  the baseName parameter to Storage, which defaults to 'Storage'.
  Here we use a use a different name, to avoid conflicts with client
  code running from the same working directory.

  Note however, that Device keysets are persisted directly by
  distributed-security, which will use the default 'Storage'
  directory. There is no conflict with clients in the same working
  directory, because Device keys are always unique.
*/
const storageBase = `ServerStorage_${Flex.storageVersion}`;
const localStorage = new StorageLocal({name: 'local', baseName: storageBase});
const tagKey = 'relayTag';
// Set Credentials.author from local persistence, creating it if needed.
// This is used if we have to sign merged VersionedCollections (as an array of owner-signed data to be resolved by an actual owner).
// TODO: We should set up a queue of startup stuff that endpoints will wait for.
localStorage.get(tagKey)
  .then(tag => tag || Flex.Credentials.create().then(tag => {localStorage.put(tagKey, tag); return tag;})) // TODO: should we have a recovery key?
  .then(async tag => {
    console.log(`Relay ${Flex.storageName} ${Flex.storageVersion} has tag ${tag}.`);
    Flex.Credentials.author = tag;
  });

// Provide a way to poke clients (such as mobile Safari) to wake up and sync.
let pokePath, vapidPublicKey;
router.configure = ({publicKey, privateKey, email, pokePath:p}) => {
  pokePath = p;
  vapidPublicKey = publicKey;
  webpush.setVapidDetails(email, publicKey, privateKey);
};
router.get('/publicVapidKey', (req, res, next) => res.json(vapidPublicKey)); // Client gets the key for use in subscribing.
// FIXME: right now I want to log the user tag. Later: hash this, and move it out of the url.
router.put('/subscribe/:key', (req, res, next) => { // Clients gives us the subscription.
  // TODO: decide whether body should include the groups that we are interested in. (Hopefully not!)
  localStorage.put(req.params.key, req.body) // TODO: should the body be a signature?
    .then(() => res.send({}), next);
});
// TODO: delete a subscription.
router.get('/poke/:key', (req, res, next) => { // For testing, invoke a push at the subscription that was saved as key
  const host = req.host;
  const scheme = host.includes(':') ? 'http://' : 'https://';
  const url = scheme + host + pokePath;
  localStorage.get(req.params.key).then(
    async subscription => {
      const promise = webpush.sendNotification(subscription, url, {
	// TODO: encryption? Does it have to be added here explicitly rather than just included in subscription?
	topic: 'poke'
      }).catch(e => e);
      res.send(await promise);
    },
    next);
});
// TODO: schedule poking for all subscriptions that are NOT connected.

// During the loading of index.mjs => collections.mjs, we initialized
// Flex.Credentials.collections with the default base directory for
// collections, which is `${Flex.storageName}_${Flex.storageVersion}`,
// e.g., Flexstore_4. The collections made in ensureCollection would
// also normally go there. But again, we don't want to conflict with
// any client code running from the same place.
// Re-initialize with new storageBase, now, before anything else.
['EncryptionKey', 'KeyRecovery', 'Team'].forEach(name => Flex.Credentials.collections[name] = new Flex.MutableCollection({name, persistenceBase: storageBase}));

const collections = { ImmutableCollection: {}, MutableCollection: {}, VersionedCollection: {}, VersionCollection: {}};
function ensureCollection(collectionType, collectionName) {
  // VersionedCollection uses the same name for the Versioned part and the Immutable part, so we must distinguish by CollectionType.
  const kind = collections[collectionType];
  if (!kind) return console.error(`No collectionType "${collectionType}" for "${collectionName}".`);
  let collection = kind[collectionName];
  if (!collection) {
    collection = kind[collectionName] =
      ((collectionType === 'MutableCollection') && Flex.Credentials.collections[collectionName]) ||
      new Flex[collectionType]({name: collectionName, persistenceBase: storageBase});
    // We are a relay. Anything that comes in will be broadcast to all the connected synchronizers except the one that sent it to us.
    collection.onupdate = event => {
      const verified = event.detail;
      collection.push(verified.payload.length ? 'put' : 'delete', verified.tag, Flex.Collection.ensureString(verified.signature), verified.synchronizer);
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
/*
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
};*/
// router.use('/ImmutableCollection', express.static('asyncLocalStorage/ImmutableCollection', staticImmutableOptions));
// router.use('/MutableCollection',   express.static('asyncLocalStorage/MutableCollection',   staticMutableOptions));
// router.use('/VersionedCollection', express.static('asyncLocalStorage/VersionedCollection', staticMutableOptions));
// router.use('/VersionCollection',   express.static('asyncLocalStorage/VersionCollection',   staticImmutableOptions));
// Here is the equivalent (although it does not currently do appropriate Cache-Control).
//router.get('/:collectionType/:collectionName/:b/:c/:a/:rest', pathTag, getCollection, invokeCollectionMethod);

// router.use(express.text({ // Define request.body.
//   type: ['application/jose', 'application/jose+json'],
//   limit: '5mb'
// }));

// router.put(   '/:collectionType/:collectionName/:b/:c/:a/:rest', pathTag, getCollection, invokeCollectionMethod);
// router.delete('/:collectionType/:collectionName/:b/:c/:a/:rest', pathTag, getCollection, invokeCollectionMethod);

const dataChannels = {};

router.post('/requestDataChannel/test/echo/:tag', async (req, res, next) => {
  const {params, body} = req;
  const tag = params.tag;
  const signals = body;
  const connection = dataChannels[tag] = new PromiseWebRTC({label: tag});
  const dataPromise = connection.getDataChannelPromise('echo');
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
  const synchronizer = new Flex.Synchronizer({collection, debug: collection.debug, serviceName: uuid, rtcConfiguration: null});
  synchronizer.log('incoming signals', theirSignals);
  const ourSignals = await synchronizer.startConnection(theirSignals).catch(() => null);
  if (!ourSignals) return res.sendStatus(500); // Arguably 502, but not 504 -- I don't want to spoof front-end errors between us and the client.
  synchronizer.log('outgoing signals', JSON.stringify(ourSignals, null, 2));
  const connection = synchronizer.connection;
  synchronizer.connection.peer.addEventListener('datachannel', async event => {
    // For the first data channel, the synchronizer is already set up above.  But if the client opens another
    // data channel for additional collections to be synchronized, this will will fire again and make new
    // synchronziers for that collection/channel.
    const {channel} = event;
    const [collectionType, collectionName] = channel.label.split('/');
    const collection = ensureCollection(collectionType, collectionName);
    const collectionSynchronizer = await collection.ensureSynchronizer(uuid, connection, channel); // Not the same as synchronizer after the first time.
    collectionSynchronizer.closed.then(() => {
      console.log(collectionSynchronizer.label, 'router sees synchronizer closed');
      // TODO: when the last synchronizer gets disconnect, remove the instance.
    });
  });
  // No need to startSynchronization, as the client will start and that will prod us.
  // Which is fortunate, because we would need to wait for ourSignals to find their way back
  // to the client and get used.
  res.send(ourSignals);
});

// Connect two peers to each other by signalling though us. We do not remain connected to either.
// The two peers need to each know:
// - the secret rendevous tag
// - which peer will make the "offer" and which will be the "answer"
// - what time they chouls connect at
const rendevous = {};
const rendevous_timeout = 60e3;
async function respondOrWait(req, rendevousTag, res, ourSignals) {
  // If the peer's signals are not ready for us, set up a promise with timeout that they can resolve with the their signals.
  // If we have signals to share, do so.
  // Wait if necessary for their signals and respond with them (or 408/timeout).
  let {resolve, signals, timeout} = rendevous[rendevousTag] || {};
  if (ourSignals && resolve) resolve(ourSignals);
  if (!signals) {
    timeout ??= setTimeout(() => { // Start a timeout if not already going.
      rendevous[rendevousTag]?.resolve(); // Get latest assigned resolve, which might not be ours.
      delete rendevous[rendevousTag];
    }, rendevous_timeout);
    signals = await new Promise(resolve => rendevous[rendevousTag] = {resolve, timeout, signals: ourSignals});
  }
  // If we get here with no signals, it is because the timer went off without resolution.
  signals ? res.send(signals) : res.sendStatus(408);
}

// In these urls:
// - The role declares what the client is seeking ("offer" or "answer").
// - The rendevousTag is a secret agreed upon by the peers.

// If request for answer arrives first (which has offer in body):
// post answer: (No resolve is set.) waiting with {resolve:here, timeout:new, signals:body}
// get offer: (ourSignals is falsy. No change to rendevous data.) responds with signals.
// post offer: clearTimeout. resolve(body) => post answer responds.

// If request for offer arrives first:
// get offer: (ourSignals is falsy.) waiting with {resolve:here, timeout:new}
// post answer: resolve(body) => get offer responds. waiting with {resolve:here, timeout:existing}
// post offer: clearTimeout. resolve(body) => post answer responds.

router.get('/signal/offer/:rendevousTag', async (req, res, next) => { // Get the pending offer.
  respondOrWait(req, req.params.rendevousTag, res);
});
router.post('/signal/:role/:rendevousTag', async (req, res, next) => {
  const {params, body} = req;
  const {rendevousTag, role} = params;
  switch (role) {
  case 'answer': // Stash our offer and await a promise for an answer.
    return respondOrWait(req, rendevousTag, res, body);
  case 'offer': // Previous GET got the offer. Now we resolve the promise with our answer.
    const {timeout, resolve} = rendevous[rendevousTag] || {};
    clearTimeout(timeout);
    delete rendevous[rendevousTag];
    if (!resolve) return res.sendStatus(404);;
    resolve(body);
    return res.send({});
  default:
    return res.sendStatus(400);
  }
});

export default router;
